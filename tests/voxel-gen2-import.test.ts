// The Gen 2 (Gold) importer, phase 1 (voxelmon/import/gen2/): the lz3
// decompressor and the constants/palettes/tilesets/maps/sprites stages on
// synthetic ROM buffers laid out per pret/pokegold's formats, then -- only
// when a verified Gold ROM is on this machine -- the same stages against
// it, pinned to pokegold's maps/*.asm. No ROM bytes are ever committed.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GOLD_SHA1 } from "../voxelmon/import/env.ts";
import { GfxBin, TRANSPARENT } from "../voxelmon/import/gfx.ts";
import { Rom } from "../voxelmon/import/rom.ts";
import { extractConstants } from "../voxelmon/import/gen2/constants.ts";
import { Gen2Ctx, orderName, scriptKey } from "../voxelmon/import/gen2/ctx.ts";
import { decompressLz3, flipBits } from "../voxelmon/import/gen2/lz.ts";
import type { Gen2Manifest } from "../voxelmon/import/gen2/manifest.ts";
import { extractMaps, readConnections, readMapEvents } from "../voxelmon/import/gen2/maps.ts";
import { color, colors, extractPalettes, scale5 } from "../voxelmon/import/gen2/palettes.ts";
import { extractSprites } from "../voxelmon/import/gen2/sprites.ts";
import { decodePalMap, extractRoofs, extractTilesets, readPalMap } from "../voxelmon/import/gen2/tilesets.ts";

// ---------------------------------------------------------------- helpers

const BANK = 0x4000;

class FakeRom {
  readonly data = new Uint8Array(0x40 * BANK);
  put(bank: number, address: number, bytes: number[]): void {
    this.data.set(bytes, Rom.offset(bank, address));
  }
  word(bank: number, address: number, value: number): void {
    this.put(bank, address, [value & 0xff, value >> 8]);
  }
}

function manifest(over: Partial<Gen2Manifest> & { symbols: Gen2Manifest["symbols"] }, consts: Record<string, unknown> = {}): Gen2Manifest {
  return {
    format: 3,
    generation: 2,
    romSha1: GOLD_SHA1,
    charmap: {},
    fontCharmap: [],
    maps: {},
    tilesets: {},
    pokemonAssets: {},
    text: {},
    ...over,
    constants: {
      source: "test",
      mapOrder: [],
      mapGroups: [],
      tilesetOrder: [],
      environmentOrder: ["TOWN", "ROUTE", "INDOOR"],
      paletteOrder: ["PALETTE_AUTO", "PALETTE_DAY", "PALETTE_NITE", "PALETTE_MORN", "PALETTE_DARK"],
      fishGroupOrder: ["FISHGROUP_NONE", "FISHGROUP_SHORE", "FISHGROUP_OCEAN"],
      mapCallbackOrder: ["MAPCALLBACK_NONE", "MAPCALLBACK_TILES", "MAPCALLBACK_OBJECTS"],
      spriteOrder: ["SPRITE_CHRIS", "SPRITE_POKE_BALL", "SPRITE_TEACHER"],
      speciesOrder: [],
      trainerClassOrder: [],
      ...consts,
    },
  };
}

const ctxOf = (rom: FakeRom, m: Gen2Manifest) => new Gen2Ctx(new Rom(rom.data), m, new GfxBin());

// ---------------------------------------------------------------- lz3

describe("gen2 lz3 decompressor (home/decompress.asm)", () => {
  test("literal copies the next n+1 bytes", () => {
    expect(decompressLz3([0x02, 0xaa, 0xbb, 0xcc, 0xff])).toEqual([0xaa, 0xbb, 0xcc]);
  });

  test("iterate repeats one byte", () => {
    expect(decompressLz3([0x23, 0x7e, 0xff])).toEqual([0x7e, 0x7e, 0x7e, 0x7e]);
  });

  test("alternate interleaves two bytes, starting with the first", () => {
    expect(decompressLz3([0x44, 1, 2, 0xff])).toEqual([1, 2, 1, 2, 1]);
  });

  test("zero-fill writes zeros and reads nothing", () => {
    expect(decompressLz3([0x61, 0x00, 0x09, 0xff])).toEqual([0, 0, 9]);
  });

  test("repeat: negative (7-bit) lookback, $80 = the last byte written", () => {
    // 1,2,3 then repeat 3 from 2 back (-3 from the end) -> 1,2,3
    expect(decompressLz3([0x02, 1, 2, 3, 0x82, 0x82, 0xff])).toEqual([1, 2, 3, 1, 2, 3]);
    // an overlapping copy of the last byte is a run
    expect(decompressLz3([0x00, 5, 0x83, 0x80, 0xff])).toEqual([5, 5, 5, 5, 5]);
  });

  test("repeat: positive 15-bit big-endian offset from the start", () => {
    expect(decompressLz3([0x03, 1, 2, 3, 4, 0x81, 0x00, 0x01, 0xff])).toEqual([1, 2, 3, 4, 2, 3]);
  });

  test("flip copies with each byte's bits reversed", () => {
    expect(flipBits(0x01)).toBe(0x80);
    expect(flipBits(0x0f)).toBe(0xf0);
    expect(flipBits(0b10110000)).toBe(0b00001101);
    expect(decompressLz3([0x01, 0x01, 0x0f, 0xa1, 0x00, 0x00, 0xff])).toEqual([0x01, 0x0f, 0x80, 0xf0]);
  });

  test("reverse copies backwards from the source", () => {
    // from the last byte (offset $80) walking back
    expect(decompressLz3([0x02, 1, 2, 3, 0xc2, 0x80, 0xff])).toEqual([1, 2, 3, 3, 2, 1]);
    // positive offset 1 walking back to 0
    expect(decompressLz3([0x02, 7, 8, 9, 0xc1, 0x00, 0x01, 0xff])).toEqual([7, 8, 9, 8, 7]);
  });

  test("long form: 10-bit lengths for every command", () => {
    // long literal of 300 bytes: 111 000 01, $2b -> 0x12b + 1
    const body = Array.from({ length: 300 }, (_, i) => i & 0x7f);
    expect(decompressLz3([0xe1, 0x2b, ...body, 0xff])).toEqual(body);
    // long zero-fill of 1024: 111 011 11, $ff -- the $ff is a length byte,
    // not the terminator
    const zeros = decompressLz3([0xef, 0xff, 0xff]);
    expect(zeros.length).toBe(1024);
    expect(zeros.every((b) => b === 0)).toBe(true);
    // long iterate of 257: 111 001 01, $00
    expect(decompressLz3([0xe5, 0x00, 0x33, 0xff])).toEqual(new Array(257).fill(0x33));
    // long alternate of 258
    const alt = decompressLz3([0xe9, 0x01, 4, 5, 0xff]);
    expect(alt.length).toBe(258);
    expect(alt.slice(0, 4)).toEqual([4, 5, 4, 5]);
    // long repeat (111 100 00, len $101) of a 2-byte seed
    const rep = decompressLz3([0x01, 1, 2, 0xf1, 0x00, 0x81, 0xff]);
    expect(rep.length).toBe(2 + 257);
    expect(rep.slice(0, 6)).toEqual([1, 2, 1, 2, 1, 2]);
    // long flip (byte by byte: the second source byte is the first flip's
    // output) / long reverse
    expect(decompressLz3([0x00, 0x03, 0xf4, 0x01, 0x80, 0xff])).toEqual([0x03, 0xc0, 0x03]);
    expect(decompressLz3([0x02, 1, 2, 3, 0xf8, 0x02, 0x80, 0xff])).toEqual([1, 2, 3, 3, 2, 1]);
    // long id 7 falls through to repeat
    expect(decompressLz3([0x00, 9, 0xfc, 0x01, 0x80, 0xff])).toEqual([9, 9, 9]);
  });

  test("$ff ends the stream; trailing bytes are ignored; no $ff throws", () => {
    expect(decompressLz3([0xff, 0x02, 1, 2, 3])).toEqual([]);
    expect(decompressLz3([0x00, 0x42, 0xff, 0x00, 0x99])).toEqual([0x42]);
    expect(() => decompressLz3([0x00, 0x42])).toThrow(/terminator/);
    expect(() => decompressLz3([0x02, 0x42])).toThrow(/unexpectedly/);
  });
});

// ---------------------------------------------------------------- palettes

describe("gen2 palettes", () => {
  test("BGR555 channels scale 0..31 -> 0..255, rounded", () => {
    expect(scale5(0)).toBe(0);
    expect(scale5(31)).toBe(255);
    expect(scale5(16)).toBe(132);
    expect(scale5(1)).toBe(8);
    const rom = new FakeRom();
    // %0bbbbbgggggrrrrr little-endian: red, green, blue, white, a mix
    rom.word(2, 0x4000, 0x001f);
    rom.word(2, 0x4002, 0x03e0);
    rom.word(2, 0x4004, 0x7c00);
    rom.word(2, 0x4006, 0x7fff);
    rom.word(2, 0x4008, (16 << 10) | (8 << 5) | 1);
    const ctx = ctxOf(rom, manifest({ symbols: {} }));
    expect(color(ctx, 2, 0x4000)).toEqual([255, 0, 0]);
    expect(color(ctx, 2, 0x4002)).toEqual([0, 255, 0]);
    expect(color(ctx, 2, 0x4004)).toEqual([0, 0, 255]);
    expect(colors(ctx, 2, 0x4006, 2)).toEqual([[255, 255, 255], [8, 66, 132]]);
  });

  test("extractPalettes: pool, 1-based environment indices, roofs by group", () => {
    const rom = new FakeRom();
    const bg = 0x4000, env = 0x5000, obj = 0x5400, roof = 0x5800, mon = 0x6000, tr = 0x7000;
    // pool entry 3 colour 0 is pure blue
    rom.word(2, bg + 3 * 8, 0x7c00);
    // EnvironmentColorsPointers: slot 1 (TOWN) -> a row at $5100
    rom.word(2, env + 2, 0x5100);
    for (let s = 2; s < 8; s++) rom.word(2, env + s * 2, 0x5100);
    rom.put(2, 0x5100 + 8, [0, 1, 2, 0x28, 4, 5, 6, 7]); // DAY row
    rom.word(2, roof + 24 * 8, 0x001f); // group 24 morn/day colour 1 red
    rom.word(2, roof + 24 * 8 + 4, 0x03e0); // nite colour 1 green
    rom.word(2, mon + 1 * 8, 0x7fff); // species 1 normal colour 1
    rom.word(2, tr, 0x001f); // PLAYER
    const m = manifest(
      {
        symbols: {
          TilesetBGPalette: [2, bg], EnvironmentColorsPointers: [2, env], MapObjectPals: [2, obj],
          RoofPals: [2, roof], PokemonPalettes: [2, mon], TrainerPalettes: [2, tr],
          HPBarPals: [2, 0x7800], ExpBarPalette: [2, 0x7810], PartyMenuOBPals: [2, 0x7820],
        },
      },
      { speciesOrder: ["BULBASAUR", "UNUSED"], trainerClassOrder: ["TRAINER_NONE", "FALKNER"] },
    );
    const p = extractPalettes(ctxOf(rom, m)) as any;
    expect(p.bg.length).toBe(0x2a);
    expect(p.bg[3][0]).toEqual([0, 0, 255]);
    expect(p.roofSlot).toBe(7);
    // stored 1-based into bg
    expect(p.environments.TOWN.DAY).toEqual([1, 2, 3, 0x29, 5, 6, 7, 8]);
    expect(Object.keys(p.environments)).toEqual(["TOWN", "ROUTE", "INDOOR"]);
    expect(Object.keys(p.objects)).toEqual(["MORN", "DAY", "NITE", "DARK"]);
    expect(p.objects.DAY.length).toBe(8);
    expect(Object.keys(p.roofs).length).toBe(27);
    expect(p.roofs["24"].mornDay[0]).toEqual([255, 0, 0]);
    expect(p.roofs["24"].nite[0]).toEqual([0, 255, 0]);
    expect(p.pokemon.BULBASAUR.normal[0]).toEqual([255, 255, 255]);
    expect(p.pokemon.UNUSED).toBeUndefined();
    expect(p.pokemon.EGG).toBeDefined();
    expect(p.trainers.PLAYER[0]).toEqual([255, 0, 0]);
    expect(p.trainers.FALKNER).toBeDefined();
    expect(p.specialTilesets).toBeUndefined();
    expect(p.battleObjects).toBeUndefined(); // symbol absent -> omitted
  });

  test("extractConstants tags generation 2 without touching the manifest", () => {
    const m = manifest({ symbols: {} });
    const c = extractConstants(ctxOf(new FakeRom(), m));
    expect(c.generation).toBe(2);
    expect(c.spriteOrder).toEqual(m.constants.spriteOrder);
    expect((m.constants as any).generation).toBeUndefined();
  });
});

// ---------------------------------------------------------------- tilesets

describe("gen2 tilesets", () => {
  test("PalMap nibbles: low = even tile, high = odd, bank bit dropped, 1-based", () => {
    expect(decodePalMap([0x10, 0x8f, 0x76])).toEqual([1, 2, 8, 1, 7, 8]);
    const rom = new FakeRom();
    rom.put(2, 0x6000, Array.from({ length: 48 }, (_, i) => ((i % 8) << 4) | ((i + 1) % 8)));
    const pals = readPalMap(ctxOf(rom, manifest({ symbols: {} })), 0x6000);
    expect(pals.length).toBe(96);
    expect(pals.slice(0, 4)).toEqual([2, 1, 3, 2]);
  });

  test("a Tilesets row: lz3 sheet, metatiles, collision, anim program, palmap", () => {
    const rom = new FakeRom();
    const headers = 0x4000;
    // row 1 = TILESET_JOHTO (row 0 is the unused Tileset0)
    const row = headers + 15;
    rom.put(5, row, [0x10, 0x00, 0x40, 0x11, 0x00, 0x40, 0x12, 0x00, 0x40]);
    rom.word(5, row + 9, 0x4100); // anim (bank $3f)
    rom.word(5, row + 13, 0x6000); // palmap (bank 2)
    // gfx: tile 0 solid shade 3 (16 x $ff), tile 1 shade 1 (low bytes only),
    // then the stream ends -- the sheet pads with zeros
    rom.put(0x10, 0x4000, [0x2f, 0xff, 0x4f, 0xff, 0x00, 0xff]);
    // metatiles: block n = [n, n+1, ..., n+15] & $ff
    rom.put(0x11, 0x4000, Array.from({ length: 128 * 16 }, (_, i) => (Math.floor(i / 16) + (i % 16)) & 0xff));
    // collision: quad n = [n, 1, 2, 3]
    rom.put(0x12, 0x4000, Array.from({ length: 128 * 4 }, (_, i) => (i % 4 === 0 ? i / 4 : i % 4)));
    rom.put(2, 0x6000, new Array(48).fill(0x21));
    // anim program: water on vTiles2 tile $14, wait, whirlpool via a
    // pointer pair, done
    const fn = { water: 0x4400, wait: 0x4410, done: 0x4420, whirl: 0x4430 };
    rom.word(0x3f, 0x4100, 0x9140); rom.word(0x3f, 0x4102, fn.water);
    rom.word(0x3f, 0x4104, 0x0000); rom.word(0x3f, 0x4106, fn.wait);
    rom.word(0x3f, 0x4108, 0x4200); rom.word(0x3f, 0x410a, fn.whirl);
    rom.word(0x3f, 0x410c, 0x0000); rom.word(0x3f, 0x410e, fn.done);
    rom.word(0x3f, 0x4200, 0x9320); // dest tile $32
    rom.word(0x3f, 0x4202, 0x4300); // its 4 frames
    rom.put(0x3f, 0x4300, new Array(64).fill(0xff));
    const m = manifest(
      {
        symbols: {
          Tilesets: [5, headers],
          AnimateWaterTile: [0x3f, fn.water], WaitTileAnimation: [0x3f, fn.wait],
          DoneTileAnimation: [0x3f, fn.done], AnimateWhirlpoolTile: [0x3f, fn.whirl],
          "AnimateWaterTile.WaterTileFrames": [0x3f, 0x4500],
        },
      },
      { tilesetOrder: ["TILESET_JOHTO"] },
    );
    const ctx = ctxOf(rom, m);
    const out = extractTilesets(ctx) as any;
    const t = out.TILESET_JOHTO;
    expect(t.source).toBe("ROM:Tilesets[1]");
    expect(t.image).toBe("tilesets/johto");
    expect([t.imageWidth, t.imageHeight, t.tilesPerRow]).toEqual([128, 48, 16]);
    expect(t.header.length).toBe(15);
    expect(t.blocks.length).toBe(128);
    expect(t.blocks[2]).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(t.collision.length).toBe(128);
    expect(t.collision[127]).toEqual([127, 1, 2, 3]);
    expect(t.palMap).toEqual({ bank: 2, address: 0x6000 });
    expect(t.tilePalettes.slice(0, 2)).toEqual([2, 3]);
    expect(t.anim).toEqual({
      period: 4,
      frames: [
        { func: "AnimateWaterTile", tile: 0x14 },
        { func: "WaitTileAnimation" },
        { func: "AnimateWhirlpoolTile", tile: 0x32, sheet: "tilesets/anim/whirlpool_32", frames: 4 },
        { func: "DoneTileAnimation" },
      ],
    });
    expect(out.animFrames).toEqual({ whirlpool_32: { image: "tilesets/anim/whirlpool_32", frames: 4 } });
    expect(out.waterFrames).toBe("tilesets/water_frames");
    expect(out.flowerFrames).toBeUndefined();
    // the decoded sheet: tile 0 shade 3, tile 1 shade 1, then zero padding
    const dir = ctx.gfx.directory["tilesets/johto"]!;
    expect([dir.w, dir.h]).toEqual([128, 48]);
    const px = ctx.gfx.bytes().subarray(dir.off, dir.off + dir.w * dir.h);
    expect(px[0]).toBe(3);
    expect(px[7 * 128 + 7]).toBe(3);
    expect(px[8]).toBe(1);
    expect(px[16]).toBe(0);
    expect(ctx.gfx.directory["tilesets/anim/whirlpool_32"]).toMatchObject({ w: 8, h: 32 });
  });

  test("roofs: five 9-tile sets, MapGroupRoofs sparse by 1-based group", () => {
    const rom = new FakeRom();
    // groups 0..26: -1, NEW_BARK, -1, VIOLET, GOLDENROD, then -1s
    rom.put(7, 0x4000, [0xff, 0, 0xff, 1, 4, ...new Array(22).fill(0xff)]);
    const ctx = ctxOf(rom, manifest({ symbols: { Roofs: [7, 0x4100], MapGroupRoofs: [7, 0x4000] } }));
    const r = extractRoofs(ctx) as any;
    expect(r.roofs.GOLDENROD).toEqual({ id: "GOLDENROD", index: 4, image: "tilesets/roofs/goldenrod" });
    expect(r.mapGroupRoofs).toEqual({ "1": "NEW_BARK", "3": "VIOLET", "4": "GOLDENROD" });
    expect(ctx.gfx.directory["tilesets/roofs/new_bark"]).toMatchObject({ w: 72, h: 8 });
  });
});

// ---------------------------------------------------------------- maps

describe("gen2 maps", () => {
  // One map, TEST_TOWN (group 1 map 1), laid out per data/maps/maps.asm,
  // data/maps/attributes.asm and macros/scripts/maps.asm.
  function mapRom(): { rom: FakeRom; m: Gen2Manifest } {
    const rom = new FakeRom();
    rom.word(0x25, 0x4000, 0x4100); // MapGroupPointers[group 1]
    // map macro: db BANK(attr), tileset, env; dw attr; db landmark, music;
    // dn phone, palette; db fish
    rom.put(0x25, 0x4100, [0x26, 0x01, 0x02, 0x00, 0x50, 0x07, 0x3c, 0x12, 0x02]);
    // map_attributes at 26:5000
    rom.put(0x26, 0x5000, [0x05, 2, 3, 0x27]);
    rom.word(0x26, 0x5004, 0x4000); // blocks
    rom.put(0x26, 0x5006, [0x28]);
    rom.word(0x26, 0x5007, 0x4000); // MapScripts
    rom.word(0x26, 0x5009, 0x4100); // MapEvents
    rom.put(0x26, 0x500b, [0x08 | 0x01]); // NORTH | EAST
    // connection north, TestRoute, 3: map_id; dw; dw; len, width; y, x; dw
    rom.put(0x26, 0x500c, [1, 2, 0, 0, 0, 0, 8, 20, 17, 0xfa, 0, 0]);
    // connection east, TestRoute, -1
    rom.put(0x26, 0x5018, [1, 2, 0, 0, 0, 0, 4, 20, 2, 0, 0, 0]);
    rom.put(0x27, 0x4000, [1, 2, 3, 4, 5, 6]);
    // MapScripts: 1 scene {dw $4050, dw 0}; 1 callback {db TILES, dw $4060}
    rom.put(0x28, 0x4000, [1, 0x50, 0x40, 0, 0, 1, 1, 0x60, 0x40]);
    // MapEvents: filler; 1 warp; 1 coord; 2 bg; 2 objects
    rom.put(0x28, 0x4100, [
      0, 0,
      1, 5, 7, 2, 1, 2, // warp_event 7, 5, TEST_ROUTE, 2
      1, 3, 4, 6, 0, 0x70, 0x40, 0, 0, // coord_event 6, 4, scene 3, $4070
      2,
      1, 2, 0, 0x80, 0x40, // bg_event 2, 1, BGEVENT_READ, $4080
      0, 6, 5, 0x90, 0x40, // bg_event 6, 0, BGEVENT_IFSET, -> conditional_event
      2,
      // object_event 3, 2, SPRITE_TEACHER, 5, rx 1, ry 2, -1, -1, pal 3,
      // type 2, sight 4, $40a0, -1
      3, 2 + 4, 3 + 4, 5, 0x21, 0xff, 0xff, 0x32, 4, 0xa0, 0x40, 0xff, 0xff,
      // object_event 0, 0, sprite $f0 (a variable sprite), hours 6..18,
      // flag $0123
      0xf0, 4, 4, 1, 0x00, 6, 18, 0x00, 0, 0xb0, 0x40, 0x23, 0x01,
    ]);
    rom.put(0x28, 0x4090, [0xcc, 0x02, 0xc0, 0x40]); // conditional_event $02cc, $40c0
    const m = manifest(
      {
        symbols: { MapGroupPointers: [0x25, 0x4000] },
        maps: { TEST_TOWN: { group: 1, map: 1, name: "TEST_TOWN", width: 3, height: 2 } },
      },
      {
        mapOrder: ["TEST_TOWN"],
        tilesetOrder: ["TILESET_JOHTO"],
        mapGroups: [
          { group: 1, map: 1, name: "TEST_TOWN", width: 3, height: 2 },
          { group: 1, map: 2, name: "TEST_ROUTE", width: 20, height: 9 },
        ],
      },
    );
    return { rom, m };
  }

  test("header, attributes, blocks, connections, events, scripts", () => {
    const { rom, m } = mapRom();
    const out = extractMaps(ctxOf(rom, m)) as any;
    const t = out.TEST_TOWN;
    expect(t).toMatchObject({
      id: "TEST_TOWN", generation: 2, group: 1, map: 1, width: 3, height: 2, borderBlock: 5,
      tileset: "TILESET_JOHTO", tilesetId: 1, environment: "ROUTE", environmentId: 2,
      landmark: 7, music: 0x3c, phoneService: false, palette: "PALETTE_NITE", fishGroup: "FISHGROUP_OCEAN",
      blocks: [1, 2, 3, 4, 5, 6], blockdata: { bank: 0x27, address: 0x4000 },
      scripts: { bank: 0x28, address: 0x4000 }, events: { bank: 0x28, address: 0x4100 },
      source: "ROM:MapGroupPointers[1][1]",
    });
    expect(t.connections).toEqual({
      north: { group: 1, map: 2, mapId: "TEST_ROUTE", stripLength: 8, width: 20, yOffset: 17, xOffset: -6, offset: 3 },
      east: { group: 1, map: 2, mapId: "TEST_ROUTE", stripLength: 4, width: 20, yOffset: 2, xOffset: 0, offset: -1 },
    });
    expect(t.warps).toEqual([{ x: 7, y: 5, destWarp: 2, destGroup: 1, destMapNum: 2, destMap: "TEST_ROUTE" }]);
    expect(t.coordEvents).toEqual([{ sceneId: 3, y: 4, x: 6, script: 0x4070 }]);
    expect(t.bgEvents).toEqual([
      { y: 1, x: 2, kind: 0, script: 0x4080 },
      { y: 0, x: 6, kind: 5, script: 0x40c0, event: 0x02cc },
    ]);
    expect(t.objects[0]).toEqual({
      index: 1, spriteId: 3, sprite: "SPRITE_TEACHER", x: 3, y: 2, movement: 5,
      radius: { y: 2, x: 1 }, hours: [-1, -1], palette: 3, type: 2, sight: 4, script: 0x40a0,
      eventFlag: 0xffff,
    });
    expect(t.objects[1]).toMatchObject({ index: 2, spriteId: 0xf0, sprite: 0xf0, x: 0, y: 0, hours: [6, 18], eventFlag: 0x0123 });
    expect(t.objectEventsAddr).toBe(0x4100 + 2 + 1 + 5 + 1 + 8 + 1 + 10 + 1);
    expect(t.sceneScripts).toEqual({ "0": { sceneId: 0, script: 0x4050, scriptKey: "28:4050" } });
    expect(t.callbacks).toEqual([{ type: 1, callback: "MAPCALLBACK_TILES", script: 0x4060, scriptKey: "28:4060" }]);
  });

  test("a dimension mismatch against the manifest is a hard error", () => {
    const { rom, m } = mapRom();
    m.maps.TEST_TOWN!.width = 4;
    expect(() => extractMaps(ctxOf(rom, m))).toThrow(/dims mismatch/);
  });

  test("helpers: no connections, empty events, orderName/scriptKey", () => {
    const { rom, m } = mapRom();
    const ctx = ctxOf(rom, m);
    expect(readConnections(ctx, 0x26, 0x500c, 0)).toEqual({});
    rom.put(0x28, 0x7000, [0, 0, 0, 0, 0, 0]);
    expect(readMapEvents(ctx, 0x28, 0x7000, [])).toEqual({
      warps: [], coordEvents: [], bgEvents: [], objects: [], objectEventsAddr: 0x7000 + 6,
    });
    expect(orderName(["A", "B"], 2)).toBe("B");
    expect(orderName(["A", "B"], 3)).toBe(3);
    expect(orderName(undefined, 1, "x")).toBe("x");
    expect(scriptKey(0x2b, 0x4dcd)).toBe("2b:4dcd");
  });
});

// ---------------------------------------------------------------- sprites

describe("gen2 overworld sprites", () => {
  test("walking sheets read size*2, still sheets size; colour 0 transparent", () => {
    const rom = new FakeRom();
    // row 0: CHRIS, 12 tiles at 30:4000, WALKING, PAL_OW_RED
    rom.word(5, 0x4000, 0x4000);
    rom.put(5, 0x4002, [12 * 16, 0x30, 1, 0]);
    // row 1: POKE_BALL, 4 tiles at 30:6000, STILL, PAL_OW_ROCK
    rom.word(5, 0x4006, 0x6000);
    rom.put(5, 0x4008, [4 * 16, 0x30, 3, 7]);
    // CHRIS pixel (0,0) shade 3; everything else 0 (transparent)
    rom.put(0x30, 0x4000, [0x80, 0x80]);
    rom.put(0x30, 0x6000, new Array(64).fill(0xff));
    const m = manifest({ symbols: { OverworldSprites: [5, 0x4000] } }, { numOverworldSprites: 2 });
    const ctx = ctxOf(rom, m);
    const out = extractSprites(ctx);
    expect(Object.keys(out)).toEqual(["SPRITE_CHRIS", "SPRITE_POKE_BALL"]);
    expect(out.SPRITE_CHRIS).toEqual({
      id: "SPRITE_CHRIS", source: "ROM:OverworldSprites[0]", image: "sprites/chris", frames: 6,
      walker: true, spriteType: "WALKING_SPRITE", palette: "PAL_OW_RED", paletteId: 0,
    });
    expect(out.SPRITE_POKE_BALL).toMatchObject({ frames: 1, walker: false, spriteType: "STILL_SPRITE", palette: "PAL_OW_ROCK", paletteId: 7 });
    const chris = ctx.gfx.directory["sprites/chris"]!;
    expect(chris).toEqual({ off: 0, w: 16, h: 96, walker: true });
    const px = ctx.gfx.bytes();
    expect(px[0]).toBe(3);
    expect(px[1]).toBe(TRANSPARENT);
    expect(ctx.gfx.directory["sprites/poke_ball"]).toEqual({ off: 16 * 96, w: 16, h: 16 });
    expect(px[16 * 96]).toBe(3);
  });
});

// ---------------------------------------------------------------- the real ROM

const GOLD_ROM = process.env.VOXELMON_GOLD_ROM ?? "/mnt/c/Users/isaac/OneDrive/Desktop/mGBA/Pokemon-Gold.gbc";
const GOLD_MANIFEST = join(
  process.env.VOXELMON_G1R_GEN2 ?? join(homedir(), "gen1recomp-mit-gen2"),
  "tools/rom_manifest_gold.json",
);
function goldInputs(): { rom: Uint8Array; manifest: Gen2Manifest } | null {
  if (!existsSync(GOLD_ROM) || !existsSync(GOLD_MANIFEST)) return null;
  const rom = new Uint8Array(readFileSync(GOLD_ROM));
  if (createHash("sha1").update(rom).digest("hex") !== GOLD_SHA1) return null;
  return { rom, manifest: JSON.parse(readFileSync(GOLD_MANIFEST, "utf8")) };
}
const gold = goldInputs();
if (!gold) console.log(`voxel-gen2-import: skipping the Gold ROM checks — no verified ROM at ${GOLD_ROM} or no manifest at ${GOLD_MANIFEST}`);

describe.skipIf(!gold)("gen2 phase 1 against the Gold ROM", () => {
  const ctx = gold ? new Gen2Ctx(new Rom(gold.rom), gold.manifest, new GfxBin(), GOLD_SHA1) : null!;
  const palettes = gold ? (extractPalettes(ctx) as any) : null;
  const tilesets = gold ? (extractTilesets(ctx) as any) : null;
  const maps = gold ? (extractMaps(ctx) as any) : null;
  const roofs = gold ? (extractRoofs(ctx) as any) : null;
  const sprites = gold ? (extractSprites(ctx) as any) : null;

  test("368 maps, every size the manifest's, blocks in range", () => {
    const names = Object.keys(maps);
    expect(names.length).toBe(368);
    for (const name of names) {
      const m = maps[name];
      const spec = gold!.manifest.maps[name]!;
      expect([m.width, m.height]).toEqual([spec.width, spec.height]);
      expect(m.blocks.length).toBe(m.width * m.height);
      expect(Math.max(...m.blocks)).toBeLessThan(128);
      expect(tilesets[m.tileset]).toBeDefined();
    }
  });

  test("NEW_BARK_TOWN matches maps/NewBarkTown.asm + data/maps", () => {
    const m = maps.NEW_BARK_TOWN;
    expect(m).toMatchObject({
      group: 24, map: 4, width: 10, height: 9, borderBlock: 5, tileset: "TILESET_JOHTO",
      environment: "TOWN", palette: "PALETTE_AUTO", fishGroup: "FISHGROUP_OCEAN", phoneService: true,
    });
    expect(Object.keys(m.connections)).toEqual(["west", "east"]);
    expect(m.connections.west).toMatchObject({ mapId: "ROUTE_29", offset: 0 });
    expect(m.connections.east).toMatchObject({ mapId: "ROUTE_27", offset: 0 });
    expect(m.warps.map((w: any) => [w.x, w.y, w.destMap, w.destWarp])).toEqual([
      [6, 3, "ELMS_LAB", 1],
      [13, 5, "PLAYERS_HOUSE_1F", 1],
      [3, 11, "PLAYERS_NEIGHBORS_HOUSE", 1],
      [11, 13, "ELMS_HOUSE", 1],
    ]);
    expect(m.coordEvents.map((c: any) => [c.x, c.y])).toEqual([[1, 8], [1, 9]]);
    expect(m.bgEvents.map((b: any) => [b.x, b.y, b.kind])).toEqual([[8, 8, 0], [11, 5, 0], [3, 3, 0], [9, 13, 0]]);
    expect(m.objects.map((o: any) => [o.x, o.y, o.sprite, o.radius.x, o.radius.y])).toEqual([
      [6, 8, "SPRITE_TEACHER", 1, 0],
      [12, 9, "SPRITE_FISHER", 0, 1],
      [3, 2, "SPRITE_RIVAL", 0, 0],
    ]);
    expect(m.objects[2].eventFlag).not.toBe(0xffff); // EVENT_RIVAL_NEW_BARK_TOWN
    expect(m.objects[0].eventFlag).toBe(0xffff); // -1
  });

  test("PLAYERS_HOUSE_2F matches maps/PlayersHouse2F.asm", () => {
    const m = maps.PLAYERS_HOUSE_2F;
    expect(m).toMatchObject({ width: 4, height: 3, tileset: "TILESET_PLAYERS_ROOM", environment: "INDOOR", palette: "PALETTE_DAY" });
    expect(m.connections).toEqual({});
    expect(m.warps.map((w: any) => [w.x, w.y, w.destMap, w.destWarp])).toEqual([[7, 0, "PLAYERS_HOUSE_1F", 3]]);
    expect(m.coordEvents).toEqual([]);
    // BGEVENT_UP, READ, READ, IFSET (the poster's conditional_event)
    expect(m.bgEvents.map((b: any) => [b.x, b.y, b.kind])).toEqual([[2, 1, 1], [3, 1, 0], [5, 1, 0], [6, 0, 5]]);
    expect(m.bgEvents[3].event).toBeGreaterThan(0);
    expect(m.objects.map((o: any) => [o.x, o.y])).toEqual([[4, 2], [4, 4], [5, 4], [0, 1]]);
    expect(m.callbacks.map((c: any) => c.callback)).toEqual(["MAPCALLBACK_NEWMAP", "MAPCALLBACK_TILES"]);
  });

  test("28 tilesets with full metatile/collision/palmap tables and drawn sheets", () => {
    const names = Object.keys(tilesets).filter((k) => k.startsWith("TILESET_"));
    expect(names.length).toBe(28);
    const bin = ctx.gfx.bytes();
    for (const name of names) {
      const t = tilesets[name];
      expect(t.blocks.length).toBe(128);
      expect(t.collision.length).toBe(128);
      expect(t.tilePalettes.length).toBe(96);
      expect(t.tilePalettes.every((p: number) => p >= 1 && p <= 8)).toBe(true);
      const dir = ctx.gfx.directory[t.image]!;
      const px = bin.subarray(dir.off, dir.off + dir.w * dir.h);
      expect(px.some((v) => v !== 0)).toBe(true);
    }
    expect(tilesets.TILESET_JOHTO.anim.frames[0]).toEqual({ func: "AnimateWaterTile", tile: 0x14 });
    expect(tilesets.waterFrames).toBe("tilesets/water_frames");
    expect(tilesets.flowerFrames).toBe("tilesets/flower_frames");
  });

  test("palettes, roofs and sprites are present", () => {
    expect(palettes.bg.length).toBe(42);
    expect(Object.keys(palettes.environments)).toEqual(gold!.manifest.constants.environmentOrder);
    expect(Object.keys(palettes.pokemon).length).toBe(252);
    expect(roofs.mapGroupRoofs["24"]).toBe("NEW_BARK");
    expect(Object.keys(sprites).length).toBe(gold!.manifest.constants.numOverworldSprites!);
    expect(sprites.SPRITE_CHRIS).toMatchObject({ frames: 6, walker: true, spriteType: "WALKING_SPRITE" });
    for (const s of Object.values(sprites) as any[]) expect(ctx.gfx.has(s.image)).toBe(true);
  });
});
