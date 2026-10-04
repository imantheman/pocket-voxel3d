// The Gen 2 (Gold) importer, phase 1 (voxelmon/import/gen2/): the lz3
// decompressor and the constants/palettes/tilesets/maps/sprites stages on
// synthetic ROM buffers laid out per pret/pokegold's formats, then -- only
// when a verified Gold ROM is on this machine -- the same stages against
// it, pinned to pokegold's maps/*.asm. No ROM bytes are ever committed.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CRYSTAL_11_SHA1, CRYSTAL_SHA1, GOLD_SHA1, SILVER_SHA1, type VoxelEnv } from "../voxelmon/import/env.ts";
import { extractFont, inkFrom1bpp, inkFrom2bpp } from "../voxelmon/import/gen2/font.ts";
import { runImportGen2 } from "../voxelmon/import/gen2/index.ts";
import { extractItems, extractMarts, extractMoves } from "../voxelmon/import/gen2/items.ts";
import { extractOakSpeech } from "../voxelmon/import/gen2/oakspeech.ts";
import { extractScriptsAndText, extractStdScripts, extractText } from "../voxelmon/import/gen2/scripts.ts";
import { decodeGen2Text } from "../voxelmon/import/gen2/text.ts";
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

// ================================================================ later stages
// Font, scripts/text, items/marts/moves, oak speech (voxelmon/import/gen2/
// font.ts, text.ts, scripts.ts, items.ts, oakspeech.ts), then the whole
// runImportGen2 pipeline on the real ROM. The other late stages have their
// own files: voxel-gen2-{audio,pokemon,title,movies,menugfx,encounters}.test.ts.

describe("gen2 text decoder (decodeGen2Text)", () => {
  const charmap: Record<string, string> = { "128": "A", "129": "B", "127": " ", "74": "<PK>", "89": "<TARGET>", "117": "<……>" };
  const run = (bytes: number[], extra?: (rom: FakeRom) => void, buffers?: (string | number)[]) => {
    const rom = new FakeRom();
    rom.put(0x10, 0x4000, bytes);
    extra?.(rom);
    return decodeGen2Text(ctxOf(rom, manifest({ symbols: {} })), 0x10, 0x4000, charmap, buffers);
  };

  test("TX_START string, line/para/cont breaks, TX_END", () => {
    expect(run([0x00, 0x80, 0x4f, 0x81, 0x51, 0x80, 0x55, 0x81, 0x50, 0x50])).toBe("A\nB\fA\vB");
  });

  test("done/prompt markers, and none on an empty stream", () => {
    expect(run([0x00, 0x80, 0x57])).toBe("A{DONE}");
    expect(run([0x00, 0x80, 0x58])).toBe("A{PROMPT}");
    expect(run([0x00, 0x57])).toBe("");
  });

  test("player/rival/POKé, name slots, ellipsis, unknown bytes and skipped controls", () => {
    expect(run([0x00, 0x52, 0x53, 0x54, 0x59, 0x75, 0x56, 0x4a, 0x03, 0x50, 0x50])).toBe(
      "{PLAYER}{RIVAL}POKé{TARGET}…………{BYTE:03}",
    );
  });

  test("TX_RAM records the named buffer; TX_DECIMAL / TX_STRINGBUFFER / TX_DOTS consume operands", () => {
    const buffers: (string | number)[] = [];
    // text_ram wStringBuffer1, text_ram $1234, text_decimal (3 bytes),
    // text_buffer 1, text_dots 4, a sound jingle ($0b), then a string
    const out = run(
      [0x01, 0x6b, 0xcf, 0x01, 0x34, 0x12, 0x09, 0x00, 0xd0, 0x21, 0x14, 0x01, 0x0c, 0x04, 0x0b, 0x00, 0x80, 0x50, 0x50],
      undefined,
      buffers,
    );
    expect(out).toBe("{STRBUF}{STRBUF}{NUM}{STRBUF}A");
    expect(buffers).toEqual(["wStringBuffer1", 0x1234]);
  });

  test("TX_FAR continues the stream at the far address", () => {
    const out = run([0x16, 0x00, 0x50, 0x11], (rom) => rom.put(0x11, 0x5000, [0x00, 0x81, 0x80, 0x57]));
    expect(out).toBe("BA{DONE}");
  });
});

describe("gen2 script disassembly (extractScriptsAndText)", () => {
  // One map whose object runs: opentext; writetext T; checkevent $0012;
  // iftrue S2; applymovement 3, M; callstd 0; end. S2: jumptext T.
  function scriptRom(): FakeRom {
    const rom = new FakeRom();
    const B = 0x20;
    rom.put(B, 0x4000, [
      0x47, // opentext
      0x4c, 0x00, 0x41, // writetext $4100
      0x31, 0x12, 0x00, // checkevent $0012
      0x09, 0x20, 0x40, // iftrue $4020
      0x68, 0x03, 0x00, 0x42, // applymovement 3, $4200
      0x0d, 0x00, 0x00, // callstd 0
      0x90, // end
    ]);
    rom.put(B, 0x4020, [0x52, 0x00, 0x41]); // jumptext $4100
    rom.put(B, 0x4100, [0x00, 0x80, 0x57]);
    rom.put(B, 0x4200, [0x01, 0x02, 0x47, 0x99]);
    rom.put(B, 0x4210, [0x12, 0x03]); // itemball
    rom.put(B, 0x4220, [0x34, 0x12, 0x07]); // hiddenitem (dwb flag, item)
    rom.put(B, 0x4300, [0xff]); // std script 0: an unknown opcode
    // InitializeEventsScript: setevent 5 twice, variablesprite 4, $52, setflag 7, end
    rom.put(B, 0x4400, [0x33, 0x05, 0x00, 0x33, 0x05, 0x00, 0x6c, 0x04, 0x52, 0x36, 0x07, 0x00, 0x90]);
    rom.put(0x21, 0x4000, [B, 0x00, 0x43]); // StdScripts: dba $20:$4300
    // readEventTables' side tables, all empty, in bank $30
    rom.put(0x30, 0x4000, [0xff]); // no posters
    for (let i = 0; i < 16; i++) rom.word(0x30, 0x4200 + i * 2, 0x4300); // TradeTexts -> TX_END
    rom.put(0x30, 0x4300, [0x50]);
    return rom;
  }
  const symbols: Record<string, [number, number]> = {
    StdScripts: [0x21, 0x4000],
    InitializeEventsScript: [0x20, 0x4400],
    PhoneContacts: [0x30, 0x4100],
    SpecialPhoneCallList: [0x30, 0x4100],
    NPCTrades: [0x30, 0x4100],
    TradeTexts: [0x30, 0x4200],
    ElevatorFloorNames: [0x30, 0x4100],
    DecorationDesc_PosterPointers: [0x30, 0x4000],
    DecorationDesc_NullPoster: [0, 0],
    "DecorationDesc_OrnamentOrConsole.OrnamentConsoleScript": [0, 0],
    "DecorationDesc_GiantOrnament.BigDollScript": [0, 0],
  };

  test("walks pointers, follows branches, decodes text and movements, resolves callstd", () => {
    const ctx = ctxOf(scriptRom(), manifest({ symbols, charmap: { "128": "A" } }, { stdScriptOrder: ["PokecenterNurseScript"] }));
    const std = extractStdScripts(ctx);
    expect(std.byId).toEqual({ "0": "PokecenterNurseScript" });
    expect(std.scripts.PokecenterNurseScript!.key).toBe("20:4300");
    const maps: Record<string, any> = {
      TEST_MAP: {
        scripts: { bank: 0x20, address: 0x4000 },
        objects: [
          { type: 0, script: 0x4000 },
          { type: 1, script: 0x4210 }, // OBJECTTYPE_ITEMBALL
          { type: 0, script: 0 }, // Lua truthiness: 0 still gets a key
        ],
        bgEvents: [{ kind: 7, script: 0x4220 }], // BGEVENT_ITEM
        coordEvents: [],
        sceneScripts: {},
        callbacks: [],
      },
    };
    const r = extractScriptsAndText(ctx, maps, std);
    const s = r.scripts as Record<string, any>;
    expect(s["20:4000"]).toEqual([
      { op: "opentext" },
      { op: "writetext", text: "20:4100" },
      { op: "checkevent", event: 0x12 },
      { op: "iftrue", script: "20:4020" },
      { op: "applymovement", object: 3, movement: "20:4200" },
      { op: "callstd", id: 0, std: "PokecenterNurseScript", script: "20:4300" },
      { op: "end" },
    ]);
    expect(s["20:4020"]).toEqual([{ op: "jumptext", text: "20:4100" }]);
    expect(s["20:4300"]).toEqual([{ op: "unknown", code: 0xff, source: "ROM:20:4300" }]);
    expect(s.movements["20:4200"]).toEqual([0x01, 0x02, 0x47]);
    expect((r.text as any)["20:4100"]).toBe("A{DONE}");
    const objects = maps.TEST_MAP.objects;
    expect(objects[0].scriptKey).toBe("20:4000");
    expect(objects[1].itemball).toEqual({ item: 0x12, quantity: 3 });
    expect(objects[2].scriptKey).toBe("20:0000");
    expect(maps.TEST_MAP.bgEvents[0].hiddenItem).toEqual({ event: 0x1234, item: 7 });
    expect(r.initialEvents).toEqual({
      generation: 2,
      source: "ROM:InitializeEventsScript",
      flags: [5],
      engineFlags: [7],
      sprites: [{ slot: 4, sprite: 0x52 }],
    });
  });
});

describe("gen2 font ink", () => {
  test("1bpp ink is black on transparent; 2bpp ink keeps shades 2-3", () => {
    const one = inkFrom1bpp([0x80, 0, 0, 0, 0, 0, 0, 0x01], 8, 8);
    expect(one.get(0, 0)).toBe(3);
    expect(one.get(1, 0)).toBe(TRANSPARENT);
    expect(one.get(7, 7)).toBe(3);
    // row 0: pixel 0 shade 1 (low bit), pixel 1 shade 2 (high bit), pixel 2 shade 3
    const two = inkFrom2bpp([0b10100000, 0b01100000, ...new Array(14).fill(0)], 8, 8);
    expect([two.get(0, 0), two.get(1, 0), two.get(2, 0), two.get(3, 0)]).toEqual([TRANSPARENT, 3, 3, TRANSPARENT]);
  });
});

describe.skipIf(!gold)("gen2 later stages against the Gold ROM", () => {
  const ctx = gold ? new Gen2Ctx(new Rom(gold.rom), gold.manifest, new GfxBin(), GOLD_SHA1) : null!;

  test("font pages, frames and the Unown font", () => {
    const font = extractFont(ctx) as any;
    expect(font).toMatchObject({
      image: "fonts/font", imageExtra: "fonts/font_extra", imageFrames: "fonts/frames",
      mainBase: 0x80, extraBase: 0x60, frameBase: 0x79,
    });
    expect(ctx.gfx.directory["fonts/font"]).toMatchObject({ w: 128, h: 64 });
    expect(ctx.gfx.directory["fonts/frames"]).toMatchObject({ w: 48, h: 64 });
    expect(ctx.gfx.directory["fonts/unown_font"]).toMatchObject({ w: 24, h: 72 });
    expect(font.imageMapSign).toBeUndefined(); // MapEntryFrameGFX is Crystal's
  });

  test("scripts: every pointer decodes, NEW_BARK_TOWN's teacher talks", () => {
    const maps = extractMaps(ctx) as any;
    const std = extractStdScripts(ctx);
    expect(std.order.length).toBe(46);
    const r = extractScriptsAndText(ctx, maps, std);
    const scripts = r.scripts as any;
    const text = r.text as any;
    const keys = Object.keys(scripts).filter((k) => k.includes(":"));
    expect(keys.length).toBeGreaterThan(3000);
    const bad = keys.filter((k) => scripts[k].some((c: any) => c.op === "unknown" || c.op === "truncated"));
    expect(bad).toEqual([]);
    const nb = maps.NEW_BARK_TOWN;
    expect(nb.sceneScripts["0"].scriptKey).toBe("48:400d");
    expect(scripts["48:400d"]).toEqual([{ op: "end" }]);
    const teacher = scripts[nb.objects[0].scriptKey];
    expect(teacher[0]).toEqual({ op: "faceplayer" });
    const line = teacher.find((c: any) => c.op === "writetext");
    expect(text[line.text]).toBe("Wow, your POKéGEAR\nis impressive!\fDid your mom get\nit for you?{DONE}");
    for (const m of Object.values(maps) as any[]) {
      for (const o of m.objects) if (o.scriptKey && !o.scriptKey.endsWith(":0000")) expect(scripts[o.scriptKey]).toBeDefined();
    }
    const trainers = Object.values(maps).flatMap((m: any) => m.objects.filter((o: any) => o.trainer));
    expect(trainers.length).toBeGreaterThan(300);
    expect(typeof text[trainers[0].trainer.seenText]).toBe("string");
    expect(r.events.trades[0]).toMatchObject({ give: "DROWZEE", get: "MACHOP", nickname: "MUSCLE", otName: "MIKE", item: "GOLD_BERRY" });
    expect(r.events.phone["1"]).toMatchObject({ contact: "PHONE_MOM", map: "PLAYERS_HOUSE_1F" });
    expect(r.events.floorNames[0]).toBe("B4F");
    expect(r.initialEvents.sprites).toContainEqual({ slot: 4, sprite: 82 });
    expect(Object.keys(text.labels).length).toBeGreaterThan(80);
  });

  test("rom_text decodes the manifest's labels", () => {
    const t = extractText(ctx);
    expect(Object.keys(t).length).toBe(889);
    expect(t.AlreadyAsleepText).toBe("{TARGET}'s\nalready asleep!{PROMPT}");
  });

  test("moves, type chart, items and marts", () => {
    const { moves, type_chart } = extractMoves(ctx) as any;
    expect(moves.POUND).toMatchObject({ index: 1, name: "POUND", power: 40, type: "NORMAL", accuracy: 100, pp: 35, effect: "EFFECT_NORMAL_HIT" });
    expect(moves.BLIZZARD).toMatchObject({ power: 120, type: "ICE", accuracy: 70, pp: 5 });
    expect(Object.keys(moves).filter((k) => k !== "generation" && k !== "source").length).toBe(251);
    expect(type_chart.matchups).toContainEqual({ attacker: "FIRE", defender: "GRASS", multiplier: 20 });
    expect(type_chart.foresightMatchups.length).toBe(2);
    expect(type_chart.types.FIRE.category).toBe("special");
    const items = extractItems(ctx) as any;
    expect(items.POTION).toMatchObject({ name: "POTION", price: 300, pocket: "ITEM", canSelect: false, canToss: true });
    expect(items.HM_SURF).toMatchObject({ tmLabel: "HM03", teaches: "SURF", name: "HM03" });
    expect(items.TM_DYNAMICPUNCH).toMatchObject({ tmNumber: 1, tmLabel: "TM01", teaches: "DYNAMICPUNCH" });
    const marts = extractMarts(ctx) as any;
    expect(marts.lists.length).toBe(34);
    expect(marts.lists[0]).toEqual(["POTION", "ANTIDOTE", "PARLYZ_HEAL", "AWAKENING"]); // MART_CHERRYGROVE
    expect(marts.bargain[0]).toEqual({ item: "NUGGET", price: 4500 });
  });

  test("oak speech text, pics and the splash", () => {
    const oak = extractOakSpeech(ctx) as any;
    expect(oak.text._OakText1.startsWith("Hello! Sorry to\nkeep you waiting!")).toBe(true);
    expect(oak.playerPic).toBe("intro/cal");
    expect(ctx.gfx.directory["intro/oak"]).toMatchObject({ w: 56, h: 56 });
    expect(oak.splash).toMatchObject({ presents: "splash/presents", logo: "splash/logo", star: "splash/star" });
  });

  test("runImportGen2: every stage, every image reference resolves", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gen2-import-"));
    const env = {
      version: "gold", romPath: GOLD_ROM, g1rDir: "", voxelmodDir: "", refGeneratedDir: "",
      genDir: dir, manifestPath: GOLD_MANIFEST,
    } as VoxelEnv;
    const log = console.log;
    console.log = () => {};
    try {
      await runImportGen2(env, gold!.rom);
    } finally {
      console.log = log;
    }
    const want = [
      "audio", "battle_anims", "constants", "credits", "diploma", "encounters", "events", "field", "font", "gfx", "icons",
      "initial_events", "intro", "items", "landmarks", "maps", "marts", "menu_gfx", "moves", "oak_speech", "palettes",
      "pokedex", "pokemon", "rom_text", "roofs", "scripts", "sprites", "std_scripts", "text", "tilesets", "title", "trade",
      "trainers", "type_chart", "version",
    ];
    const files = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();
    expect(files).toEqual(want);
    expect(statSync(join(dir, "programs.bin")).size).toBe(6 * 0x4000);
    expect(statSync(join(dir, "slots/gold_slots.tilemap")).size).toBe(240);
    const gfxDir = JSON.parse(readFileSync(join(dir, "gfx.json"), "utf8"));
    const missing: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === "string") {
        if (/^[a-z0-9_]+\/[a-z0-9_/.]+$/.test(v) && !v.endsWith(".tilemap") && !v.endsWith(".bin") && !(v in gfxDir)) missing.push(v);
      } else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    for (const f of files) if (f !== "gfx") walk(JSON.parse(readFileSync(join(dir, `${f}.json`), "utf8")));
    expect(missing).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  }, 60000);
});

// ---------------------------------------------------------------- Silver

const SILVER_ROM = process.env.VOXELMON_SILVER_ROM ?? "/mnt/c/Users/isaac/OneDrive/Desktop/mGBA/silver.gbc";
const SILVER_MANIFEST = join(
  process.env.VOXELMON_G1R_GEN2 ?? join(homedir(), "gen1recomp-mit-gen2"),
  "tools/rom_manifest_silver.json",
);
function silverInputs(): { rom: Uint8Array; manifest: Gen2Manifest } | null {
  if (!existsSync(SILVER_ROM) || !existsSync(SILVER_MANIFEST)) return null;
  const rom = new Uint8Array(readFileSync(SILVER_ROM));
  if (createHash("sha1").update(rom).digest("hex") !== SILVER_SHA1) return null;
  return { rom, manifest: JSON.parse(readFileSync(SILVER_MANIFEST, "utf8")) };
}
const silver = silverInputs();
if (!silver) console.log(`voxel-gen2-import: skipping the Silver ROM checks — no verified ROM at ${SILVER_ROM}`);

describe.skipIf(!silver)("gen2 against the Silver ROM", () => {
  test("the same importer, Silver's own: its encounters, Pokedex, title and version", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gen2-silver-"));
    const env = {
      version: "silver", romPath: SILVER_ROM, g1rDir: "", voxelmodDir: "", refGeneratedDir: "",
      genDir: dir, manifestPath: SILVER_MANIFEST,
    } as VoxelEnv;
    const log = console.log;
    console.log = () => {};
    try {
      await runImportGen2(env, silver!.rom);
    } finally {
      console.log = log;
    }
    const read = (f: string) => JSON.parse(readFileSync(join(dir, `${f}.json`), "utf8"));
    expect(read("version")).toEqual({ version: "silver" });
    // Ice Path: Silver's DELIBIRD where Gold has ZUBAT
    const enc = read("encounters");
    expect(enc.grass.ICE_PATH_1F.slots.DAY[2].species).toBe("DELIBIRD");
    // Silver's own Pokedex text
    expect(read("pokedex").entries.ABRA.text.startsWith("If it decides to")).toBe(true);
    // Lugia over the sea, on Silver's clock (RomExtractorGen2.lua's silver branch)
    const t = read("title");
    const title = t.title ?? t;
    expect(title.trailMode).toBe("silver");
    expect(title.hoohSequence).toEqual([[2, 3], [1, 7], [2, 7], [3, 7], [3, 7], [4, 7], [4, 7], [3, 7], [2, 3]]);
    expect(title.hoohX).toBe(40);
    expect(title.cloudScrollEvery).toBe(1);
    expect(title.below).toEqual([0, 0, 0]);
    expect(title.timeoutFrames).toBe(73 * 60 + 36);
    const gfx = JSON.parse(readFileSync(join(dir, "gfx.json"), "utf8"));
    expect(gfx["title/hooh_1"]).toMatchObject({ w: 80, h: 64 });
    expect(gfx["title/trail"]).toMatchObject({ w: 16, h: 16 });
    rmSync(dir, { recursive: true, force: true });
  }, 60000);
});

// ---------------------------------------------------------------- Crystal

const CRYSTAL_ROM = process.env.VOXELMON_CRYSTAL_ROM ?? join(homedir(), "roms/crystal.gbc");
const CRYSTAL_MANIFEST = join(
  process.env.VOXELMON_G1R_GEN2 ?? join(homedir(), "gen1recomp-mit-gen2"),
  "tools/rom_manifest_crystal.json",
);
function crystalInputs(): { rom: Uint8Array; manifest: Gen2Manifest } | null {
  if (!existsSync(CRYSTAL_ROM) || !existsSync(CRYSTAL_MANIFEST)) return null;
  const rom = new Uint8Array(readFileSync(CRYSTAL_ROM));
  const sha = createHash("sha1").update(rom).digest("hex");
  // either US revision (1.0 or 1.1): one manifest serves both
  if (sha !== CRYSTAL_SHA1 && sha !== CRYSTAL_11_SHA1) return null;
  return { rom, manifest: JSON.parse(readFileSync(CRYSTAL_MANIFEST, "utf8")) };
}
const crystal = crystalInputs();
if (!crystal) console.log(`voxel-gen2-import: skipping the Crystal ROM checks — no verified ROM at ${CRYSTAL_ROM}`);

describe.skipIf(!crystal)("gen2 against the Crystal ROM", () => {
  test("the same importer, Crystal's own: its maps, intro, title, Battle Tower and Unown walls", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gen2-crystal-"));
    const env = {
      version: "crystal", romPath: CRYSTAL_ROM, g1rDir: "", voxelmodDir: "", refGeneratedDir: "",
      genDir: dir, manifestPath: CRYSTAL_MANIFEST,
    } as VoxelEnv;
    const log = console.log;
    console.log = () => {};
    try {
      await runImportGen2(env, crystal!.rom);
    } finally {
      console.log = log;
    }
    const read = (f: string) => JSON.parse(readFileSync(join(dir, `${f}.json`), "utf8"));
    expect(read("version")).toEqual({ version: "crystal" });
    // 20 more maps than Gold's 368 (the Battle Tower, the mobile rooms, the chambers)
    const maps = read("maps");
    expect(Object.keys(maps).length).toBe(388);
    expect(maps.BATTLE_TOWER_1F).toBeDefined();
    // every map's tileset is there, and Crystal's two-bank sheets with it
    const tilesets = read("tilesets");
    for (const m of Object.values(maps) as any[]) expect(tilesets[m.tileset]).toBeDefined();
    // the engine flags by name: Crystal's are one higher than pokegold's from 16 on
    const order = read("constants").engineFlagOrder;
    expect(order.length).toBe(162);
    expect(order.indexOf("ENGINE_REACHED_GOLDENROD")).toBe(22);
    expect(order.indexOf("ENGINE_TIME_CAPSULE")).toBe(83);
    // the professor shows WOOPER, and the girl has her own pic
    const oak = read("oak_speech");
    expect(oak.demoSpecies).toBe("WOOPER");
    expect([oak.playerPic, oak.playerPicFemale]).toEqual(["intro/chris", "intro/kris"]);
    expect(oak.splash.ditto).toBe("splash/ditto");
    // the opening movie and the Suicune title
    expect(read("intro").layout).toBe("crystal");
    expect(Object.keys(read("intro").acts)).toEqual(["unownA", "unownHI", "unowns", "background", "suicuneJump", "suicuneClose", "suicuneBack", "crystalUnowns"]);
    const title = read("title").title ?? read("title");
    expect(title.layout).toBe("crystal_title");
    // the Battle Tower roster: 70 trainers, ten level groups of 21 mons
    const tower = read("trainers").battleTower;
    expect([tower.trainers.length, tower.groups.length, tower.groups[0].length, tower.levelGroups]).toEqual([70, 10, 21, 10]);
    // the Ruins of Alph walls and Crystal's seven in-game trades
    const events = read("events");
    expect(events.unownWalls[0].word).toBe("ESCAPE");
    expect(events.trades.length).toBe(7);
    rmSync(dir, { recursive: true, force: true });
  }, 120000);
});
