// The Gen 2 (Gold) menu graphics stage (voxelmon/import/gen2/menugfx*.ts,
// RomExtractorGen2.lua:5754-6867): the Unown puzzle nibble enlarge and
// border OR, the POKeGEAR RLE / flat tilemap readers and the Game Corner
// sheet rebuilds on synthetic data, then -- only when a verified Gold ROM
// is on this machine -- the whole stage against it, pinned to pokegold's
// sheet sizes and tables. No ROM bytes are ever committed.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GOLD_SHA1 } from "../voxelmon/import/env.ts";
import { GfxBin, TRANSPARENT, decode2bpp } from "../voxelmon/import/gfx.ts";
import { Rom } from "../voxelmon/import/rom.ts";
import { Gen2Ctx } from "../voxelmon/import/gen2/ctx.ts";
import type { Gen2Manifest } from "../voxelmon/import/gen2/manifest.ts";
import { composeSlotsActors, expandCardFlip2, extractMenuGfx } from "../voxelmon/import/gen2/menugfx.ts";
import {
  ENLARGED_NIBBLE,
  PUZZLE_BORDER_TILES,
  SCREEN_AREA,
  addPuzzlePieceBorders,
  enlargePuzzlePieces,
  orByte,
  readFlatTilemap,
  readTilemapRLE,
} from "../voxelmon/import/gen2/menugfx-screens.ts";

// ---------------------------------------------------------------- helpers

const BANK = 0x4000;

class FakeRom {
  readonly data = new Uint8Array(0x10 * BANK);
  put(bank: number, address: number, bytes: number[]): void {
    this.data.set(bytes, Rom.offset(bank, address));
  }
}

function ctxWith(rom: FakeRom, symbols: Gen2Manifest["symbols"]): Gen2Ctx {
  const manifest = {
    format: 3,
    generation: 2,
    romSha1: GOLD_SHA1,
    symbols,
    charmap: {},
    fontCharmap: [],
    maps: {},
    tilesets: {},
    pokemonAssets: {},
    text: {},
    constants: {} as Gen2Manifest["constants"],
  } as Gen2Manifest;
  return new Gen2Ctx(new Rom(rom.data), manifest, new GfxBin());
}

// A tiny deterministic PRNG so the scale test covers every nibble.
function bytes(n: number, seed = 1): number[] {
  const out: number[] = [];
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out.push((s >> 16) & 0xff);
  }
  return out;
}

// ---------------------------------------------------------------- Unown puzzle

describe("Unown puzzle enlarge (.EnlargePuzzlePieceTiles)", () => {
  test("ENLARGED_NIBBLE doubles every bit", () => {
    expect(ENLARGED_NIBBLE.length).toBe(16);
    expect(ENLARGED_NIBBLE[0x0]).toBe(0x00);
    expect(ENLARGED_NIBBLE[0x1]).toBe(0x03);
    expect(ENLARGED_NIBBLE[0x5]).toBe(0x33);
    expect(ENLARGED_NIBBLE[0x8]).toBe(0xc0);
    expect(ENLARGED_NIBBLE[0xa]).toBe(0xcc);
    expect(ENLARGED_NIBBLE[0xf]).toBe(0xff);
  });

  test("orByte is a bytewise OR", () => {
    expect(orByte(0xf0, 0x0f)).toBe(0xff);
    expect(orByte(0xa5, 0x81)).toBe(0xa5);
    expect(orByte(0, 0)).toBe(0);
  });

  test("36 tiles become a 12x12 sheet that is an exact 2x nearest-neighbour scale", () => {
    const small = bytes(36 * 16, 7);
    const big = enlargePuzzlePieces(small);
    expect(big.length).toBe(96 * 96 / 4);
    const a = decode2bpp(small, 48, 48);
    const b = decode2bpp(big, 96, 96);
    for (let y = 0; y < 96; y++) {
      for (let x = 0; x < 96; x++) expect(b.get(x, y)).toBe(a.get(x >> 1, y >> 1));
    }
  });

  test("a short stream reads missing bytes as 0", () => {
    const big = enlargePuzzlePieces([0xf0, 0x0f]);
    expect(big.length).toBe(2304);
    // tile 0 = left nibbles of small tile 0: low $f -> $ff, high $0 -> $00
    expect(big.slice(0, 4)).toEqual([0xff, 0x00, 0xff, 0x00]);
    // tile 1 = right nibbles: low $0, high $f
    expect(big.slice(16, 20)).toEqual([0x00, 0xff, 0x00, 0xff]);
    // everything past small tile 0's first line is zero
    expect(big.slice(4, 16).every((v) => v === 0)).toBe(true);
    expect(big.slice(20).every((v) => v === 0)).toBe(true);
  });

  test("borders OR onto the eight outer tiles of all 16 pieces, never the centre", () => {
    const out: number[] = new Array(2304).fill(0);
    const raw: number[] = [];
    for (let i = 0; i < 8; i++) for (let b = 0; b < 16; b++) raw.push(i + 1);
    addPuzzlePieceBorders(out, raw);
    for (let pieceRow = 0; pieceRow < 4; pieceRow++) {
      for (let pieceCol = 0; pieceCol < 4; pieceCol++) {
        const origin = pieceCol * 3 + pieceRow * 36;
        PUZZLE_BORDER_TILES.forEach((t, i) => expect(out[(origin + t) * 16 + 5]).toBe(i + 1));
        expect(out[(origin + 0x0d) * 16]).toBe(0); // centre untouched
      }
    }
    expect(out.filter((v) => v !== 0).length).toBe(16 * 8 * 16);
  });
});

// ---------------------------------------------------------------- POKeGEAR tilemaps

describe("POKeGEAR tilemap readers", () => {
  test("readTilemapRLE: `tile, count` pairs, $ff ends, $4f fills the rest", () => {
    const rom = new FakeRom();
    rom.put(1, 0x4000, [0x30, 3, 0x7f, 2, 0x11, 0, 0x22, 1, 0xff]);
    const ctx = ctxWith(rom, { T: [1, 0x4000] });
    expect(readTilemapRLE(ctx, "T", 9)).toEqual([0x30, 0x30, 0x30, 0x7f, 0x7f, 0x22, 0x4f, 0x4f, 0x4f]);
  });

  test("readTilemapRLE stops at `cells` mid-run", () => {
    const rom = new FakeRom();
    rom.put(1, 0x4000, [0x05, 200, 0x06, 200, 0xff]);
    const out = readTilemapRLE(ctxWith(rom, { T: [1, 0x4000] }), "T", SCREEN_AREA);
    expect(out.length).toBe(360);
    expect(out.slice(0, 200).every((v) => v === 5)).toBe(true);
    expect(out.slice(200).every((v) => v === 6)).toBe(true);
  });

  test("readFlatTilemap: flat bytes to $ff, then $4f", () => {
    const rom = new FakeRom();
    rom.put(1, 0x4000, [1, 2, 3, 0xff, 9, 9]);
    expect(readFlatTilemap(ctxWith(rom, { M: [1, 0x4000] }), "M", 6)).toEqual([1, 2, 3, 0x4f, 0x4f, 0x4f]);
  });

  test("readFlatTilemap without a terminator reads exactly `cells`", () => {
    const rom = new FakeRom();
    rom.put(1, 0x4000, new Array(400).fill(7));
    const out = readFlatTilemap(ctxWith(rom, { M: [1, 0x4000] }), "M", SCREEN_AREA);
    expect(out.length).toBe(360);
    expect(out.every((v) => v === 7)).toBe(true);
  });
});

// ---------------------------------------------------------------- Game Corner

describe("Game Corner sheet rebuilds", () => {
  test("expandCardFlip2 re-inserts the 8 whitespace tiles of the header strip", () => {
    const compact: number[] = [];
    for (let t = 0; t < 52; t++) for (let b = 0; b < 16; b++) compact.push(t + 1);
    const out = expandCardFlip2(compact);
    expect(out.length).toBe(24 * 160 / 4);
    const tileByte = (t: number) => out[t * 16]!;
    for (const t of [2, 5, 8, 11, 14, 17, 20, 23]) expect(tileByte(t)).toBe(0);
    expect([0, 1, 3, 4, 24, 59].map(tileByte)).toEqual([1, 2, 3, 4, 17, 52]);
  });

  test("composeSlotsActors is 24x240 on a transparent backdrop", () => {
    const raw = new Array(0x3c * 16).fill(0xff); // every pixel shade 3
    const sheet = composeSlotsActors(raw);
    expect([sheet.w, sheet.h]).toEqual([24, 240]);
    expect(sheet.get(0, 0)).toBe(3); // golem pose 0
    expect(sheet.get(0, 232)).toBe(3); // the egg at (0, 224) 8x16
    expect(sheet.get(8, 232)).toBe(TRANSPARENT); // nothing beside the egg
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
if (!gold) console.log(`voxel-gen2-menugfx: skipping the Gold ROM checks — no verified ROM at ${GOLD_ROM} or no manifest at ${GOLD_MANIFEST}`);

describe.skipIf(!gold)("gen2 menu graphics against the Gold ROM", () => {
  const ctx = gold ? new Gen2Ctx(new Rom(gold.rom), gold.manifest, new GfxBin(), GOLD_SHA1) : null!;
  const files = gold ? extractMenuGfx(ctx) : ({} as Record<string, unknown>);
  const m = files.menu_gfx as any;
  const dims = (key: string) => {
    const e = ctx.gfx.directory[key];
    return e ? [e.w, e.h] : undefined;
  };

  test("menu_gfx plus the two raw tilemaps, JSON small enough to ship", () => {
    expect(Object.keys(files).sort()).toEqual(["card_flip/card_flip.tilemap", "menu_gfx", "slots/gold_slots.tilemap"]);
    expect((files["slots/gold_slots.tilemap"] as Uint8Array).length).toBe(20 * 12);
    expect((files["card_flip/card_flip.tilemap"] as Uint8Array).length).toBe(11 * 12);
    expect(m.slots.tilemap).toBe("slots/gold_slots.tilemap");
    expect(JSON.stringify(m).length).toBeLessThan(20000);
  });

  test("#DEX sheets: PokedexLZ from $31, footprints for all 251 species", () => {
    const dex = m.pokedex;
    expect(dex.firstTile).toBe(0x31);
    expect(dims(dex.tiles)).toEqual([128, Math.ceil(dex.tileCount / 16) * 8]);
    expect(dex.tileCount).toBeGreaterThanOrEqual(0x66 - 0x31); // up to the $62..$65 footprint cells
    expect(dims(dex.objs)![0]).toBe(128);
    expect(dims(dex.questionMark)).toEqual([56, 56]);
    expect(dex.footprintOrder.length).toBe(251);
    expect(dims(dex.footprints)).toEqual([16, 251 * 16]);
    expect(dex.palette.length).toBe(4);
  });

  test("Bill's PC: four tiles at $5c and the orange palette", () => {
    expect(dims(m.billsPc.icons)).toEqual([32, 8]);
    expect(m.billsPc.firstTile).toBe(0x5c);
    expect(m.billsPc.orangePalette.length).toBe(4);
  });

  test("POKeGEAR: one 96-tile sheet, 20x18 cards and maps, 96-entry PalMap", () => {
    const gear = m.pokegear;
    expect(dims(gear.tiles)).toEqual([128, 48]);
    expect(dims(gear.sprites)).toEqual([16, 40]);
    expect(dims(gear.nestIcon)).toEqual([8, 8]);
    for (const tm of [gear.cards.clock, gear.cards.phone, gear.cards.radio, gear.maps.johto, gear.maps.kanto]) {
      expect(tm.length).toBe(360);
      for (const t of tm) expect(t).toBeLessThan(0x80);
    }
    // Every card's top-left is the gear icon row filled by InitPokegearTilemap ($4f)
    // until Pokegear_FinishTilemap; the RLE cards start with that fill.
    expect(gear.cards.clock[0]).toBe(0x4f);
    expect(gear.palettes.length).toBe(6);
    expect(gear.palMap.length).toBe(96);
    for (const p of gear.palMap) expect(p >= 1 && p <= 8).toBe(true);
  });

  test("trainer card: 41-tile card sheet, leaders, badges and the OAM template", () => {
    const card = m.trainerCard;
    expect(dims(card.card)).toEqual([128, 24]);
    expect(dims(card.status)).toEqual([48, 8]);
    expect(dims(card.leaders)).toEqual([80, 72]);
    expect(dims(card.badges)).toEqual([16, 176]);
    expect(card.badgeOam.length).toBe(8);
    // Zephyrbadge: db $68, $18, 0 / $00, $20, $24, $20|$80 twice (trainer_card.asm).
    expect(card.badgeOam[0]).toEqual({ y: 0x68 - 16, x: 0x18 - 8, palette: 0, frames: [0, 0x20, 0x24, 0xa0, 0, 0x20, 0x24, 0xa0] });
    expect(card.badgeOam[1].x).toBe(0x38 - 8);
    expect(card.badgePalette.length).toBe(4);
  });

  test("Unown puzzle: four 96x96 pictures, 19-tile chrome, red cursor", () => {
    const p = m.unownPuzzle;
    expect(p.pictures.length).toBe(4);
    for (const key of p.pictures) expect(dims(key)).toEqual([96, 96]);
    expect(dims(p.chrome)).toEqual([152, 8]);
    expect(dims(p.cursor)).toEqual([32, 8]);
    expect(p.cursorPalette[0]).toEqual([255, 0, 0]);
    expect(p.cursorPalette[3]).toEqual([255, 0, 0]);
  });

  test("battle HUD, pack, emotes and the Game Corner sheets", () => {
    const hud = m.battleHud;
    expect(Object.keys(hud.trainerPics).length).toBe(gold!.manifest.constants.trainerClassOrder.length - 1);
    expect(dims(hud.trainerPics.FALKNER)).toEqual([56, 56]);
    expect(dims(hud.playerBack)).toEqual([48, 48]);
    expect(dims(hud.hpBar)).toEqual([96, 8]);
    expect(dims(m.pack.menu)).toEqual([128, 48]);
    expect(m.pack.pocketName.length).toBe(4);
    for (const block of m.pack.pocketName) expect(block.length).toBe(15);
    expect(m.emotes.order.length).toBe(8);
    for (const k of m.emotes.order) expect(dims(m.emotes[k])).toEqual([16, 16]);
    expect(dims(m.slots.sheet3)).toEqual([24, 240]);
    expect(dims("slots/gold_slots_actors")).toEqual([24, 240]);
    expect(dims(m.cardFlip.sheet2)).toEqual([24, 160]);
    expect(dims(m.stats.sheet)).toEqual([136, 8]);
  });
});
