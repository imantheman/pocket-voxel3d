// The Gen 2 (Gold) importer's cutscene and battle-animation stages
// (voxelmon/import/gen2/movies.ts, battleanims.ts): the battle-anim script
// disassembler, frameset/OAM/object/gfx readers and the magnet-train read on
// synthetic ROM buffers laid out per pret/pokegold's formats, then -- only
// when a verified Gold ROM is on this machine -- every stage against it,
// pinned to pokegold facts. No ROM bytes are ever committed.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GOLD_SHA1 } from "../voxelmon/import/env.ts";
import { GfxBin, TRANSPARENT } from "../voxelmon/import/gfx.ts";
import { Rom } from "../voxelmon/import/rom.ts";
import {
  extractBattleAnims,
  readBattleAnimFramesets,
  readBattleAnimGfx,
  readBattleAnimOamsets,
  readBattleAnimObjects,
  readBattleAnimScript,
  type AnimRow,
} from "../voxelmon/import/gen2/battleanims.ts";
import { Gen2Ctx } from "../voxelmon/import/gen2/ctx.ts";
import type { Gen2Manifest } from "../voxelmon/import/gen2/manifest.ts";
import {
  extractCredits,
  extractDiploma,
  extractStubs,
  extractTrade,
  readMagnetTrain,
} from "../voxelmon/import/gen2/movies.ts";

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

function manifest(symbols: Gen2Manifest["symbols"], consts: Record<string, unknown> = {}): Gen2Manifest {
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
    symbols,
    constants: {
      source: "test",
      mapOrder: [],
      mapGroups: [],
      tilesetOrder: [],
      environmentOrder: [],
      paletteOrder: [],
      fishGroupOrder: [],
      mapCallbackOrder: [],
      spriteOrder: [],
      speciesOrder: [],
      trainerClassOrder: [],
      ...consts,
    },
  };
}

const ctxOf = (rom: FakeRom, m: Gen2Manifest) => new Gen2Ctx(new Rom(rom.data), m, new GfxBin());

// ---------------------------------------------------------------- battle anim scripts

describe("gen2 battle anim script reader (macros/scripts/battle_anims.asm)", () => {
  test("command lengths, branch folding and depth-first sub-script discovery", () => {
    const rom = new FakeRom();
    rom.put(0x32, 0x4000, [
      0xd1, 0x01, // anim_1gfx 1
      0x06, // anim_wait 6
      0xfd, 0x02, 0x10, 0x41, // anim_loop 2, $4110
      0xfe, 0x20, 0x41, // anim_call $4120
      0xee, 0x05, 0x30, 0x41, // anim_if_param_and 5, $4130
      0xd0, 0x08, 0x88, 0x38, 0x00, // anim_obj 8, 136, 56, 0
      0xe0, 0x01, 0x31, // anim_sound (0<<2)|1, SFX_POUND
      0xfc, 0x00, 0x40, // anim_jump $4000 (self: already claimed)
      0x99, // past the jump: never read
    ]);
    rom.put(0x32, 0x4110, [0xff]);
    rom.put(0x32, 0x4120, [0x02, 0xff]);
    rom.put(0x32, 0x4130, [0xfc, 0x10, 0x41]); // jump to an already-read script
    const ctx = ctxOf(rom, manifest({}));
    const pool: Record<string, AnimRow[]> = {};
    const order: string[] = [];
    expect(readBattleAnimScript(ctx, 0x32, 0x4000, pool, order)).toBe("4000");
    expect(order).toEqual(["4000", "4110", "4120", "4130"]);
    expect(pool["4000"]).toEqual([
      ["1gfx", 1],
      ["wait", 6],
      ["loop", 2, "4110"],
      ["call", "4120"],
      ["if_param_and", 5, "4130"],
      ["obj", 8, 136, 56, 0],
      ["sound", 1, 0x31],
      ["jump", "4000"],
    ]);
    expect(pool["4110"]).toEqual([["ret"]]);
    expect(pool["4120"]).toEqual([["wait", 2], ["ret"]]);
    expect(pool["4130"]).toEqual([["jump", "4110"]]);
    // A second read of a pooled key is a no-op.
    expect(readBattleAnimScript(ctx, 0x32, 0x4110, pool, order)).toBe("4110");
    expect(order.length).toBe(4);
  });

  test("the other branch commands: jumpuntil, if_param_equal, if_var_equal", () => {
    const rom = new FakeRom();
    rom.put(0x32, 0x5000, [0xef, 0x00, 0x51, 0xf8, 0x03, 0x10, 0x51, 0xfb, 0x07, 0x20, 0x51, 0xf9, 0x04, 0xfa, 0xff]);
    rom.put(0x32, 0x5100, [0xff]);
    rom.put(0x32, 0x5110, [0xff]);
    rom.put(0x32, 0x5120, [0xff]);
    const pool: Record<string, AnimRow[]> = {};
    const order: string[] = [];
    readBattleAnimScript(ctxOf(rom, manifest({})), 0x32, 0x5000, pool, order);
    expect(pool["5000"]).toEqual([
      ["jumpuntil", "5100"],
      ["if_param_equal", 3, "5110"],
      ["if_var_equal", 7, "5120"],
      ["setvar", 4],
      ["incvar"],
      ["ret"],
    ]);
    expect(order).toEqual(["5000", "5100", "5110", "5120"]);
  });
});

// ---------------------------------------------------------------- battle anim tables

describe("gen2 battle anim tables (data/battle_anims/*)", () => {
  test("objects: six-byte rows, ids named through their 0-based order lists", () => {
    const rom = new FakeRom();
    rom.put(0x33, 0x4000, [0x01, 0xff, 0x01, 0x00, 0x02, 0x01, 0x00, 0x00, 0x09, 0x01, 0x07, 0x02]);
    const ctx = ctxOf(
      rom,
      manifest({ BattleAnimObjects: [0x33, 0x4000] }, {
        battleAnimObjectOrder: ["OBJ_A", "OBJ_B"],
        battleAnimFramesetOrder: ["FS_0", "FS_1"],
        battleAnimFuncOrder: ["FUNC_NULL", "FUNC_1"],
        battleAnimObPaletteOrder: ["PAL_ENEMY", "PAL_PLAYER", "PAL_GRAY"],
        battleAnimGfxOrder: ["GFX_NONE", "GFX_HIT", "GFX_CUT"],
      }),
    );
    expect(readBattleAnimObjects(ctx)).toEqual({
      OBJ_A: { flags: 1, fixY: 0xff, frameset: "FS_1", func: "FUNC_NULL", palette: "PAL_GRAY", gfx: "GFX_HIT" },
      // A miss in a list falls back to the raw byte.
      OBJ_B: { flags: 0, fixY: 0, frameset: 9, func: "FUNC_1", palette: 7, gfx: "GFX_CUT" },
    });
  });

  test("framesets: set then duration, flips shifted down, stop at end/restart/delete", () => {
    const rom = new FakeRom();
    rom.word(0x33, 0x4000, 0x4100);
    rom.word(0x33, 0x4002, 0x4110);
    rom.put(0x33, 0x4100, [0x01, 0xc5, 0xfd, 0x03, 0x00, 0x42, 0xfe, 0x00, 0x00]);
    rom.put(0x33, 0x4110, [0x00, 0x06, 0xfc]);
    const ctx = ctxOf(
      rom,
      manifest({ BattleAnimFrameData: [0x33, 0x4000] }, {
        battleAnimFramesetOrder: ["FS_A", "FS_B"],
        battleAnimOamsetOrder: ["OAM_00", "OAM_01"],
      }),
    );
    expect(readBattleAnimFramesets(ctx)).toEqual({
      FS_A: [["frame", "OAM_01", 5, 0x60], ["wait", 3], ["frame", "OAM_00", 2, 0x20], ["restart"]],
      FS_B: [["frame", "OAM_00", 6, 0], ["delete"]],
    });
  });

  test("oamsets: vtile, count, pointer to y-first dbsprite rows", () => {
    const rom = new FakeRom();
    rom.put(0x33, 0x4000, [0x03, 0x02, 0x00, 0x42, 0x00, 0x00, 0x00, 0x42]);
    rom.put(0x33, 0x4200, [0xf0, 0xf8, 0x00, 0x00, 0xf0, 0x00, 0x01, 0x20]);
    const ctx = ctxOf(rom, manifest({ BattleAnimOAMData: [0x33, 0x4000] }, { battleAnimOamsetOrder: ["OAM_00", "OAM_01"] }));
    expect(readBattleAnimOamsets(ctx)).toEqual({
      OAM_00: { vtile: 3, sprites: [{ y: 0xf0, x: 0xf8, tile: 0, attr: 0 }, { y: 0xf0, x: 0, tile: 1, attr: 0x20 }] },
      OAM_01: { vtile: 0, sprites: [] },
    });
  });

  test("gfx: zero-tile rows and undecompressable sheets are skipped; sheets pad to min(tiles, 8) wide", () => {
    const rom = new FakeRom();
    rom.put(0x33, 0x4000, [0x00, 0x00, 0x00, 0x00, 0x03, 0x34, 0x00, 0x40, 0x02, 0x34, 0xfe, 0x7f]);
    rom.put(0x34, 0x4000, [0x2f, 0xff, 0xff]); // iterate 16 x $ff, end
    rom.put(0x34, 0x7ffe, [0x05, 0x00]); // a literal that runs off the bank
    const ctx = ctxOf(rom, manifest({ AnimObjGFX: [0x33, 0x4000] }, { battleAnimGfxOrder: ["GFX_NONE", "GFX_A", "GFX_BAD"] }));
    const gfx = readBattleAnimGfx(ctx);
    expect(gfx).toEqual({ GFX_A: { tiles: 3, wide: 3, image: "battle_anims/gfx_a" } });
    expect(ctx.gfx.directory["battle_anims/gfx_a"]).toMatchObject({ w: 24, h: 8 });
    const px = ctx.gfx.bytes();
    expect(px[0]).toBe(3); // first tile all colour 3
    expect(px[8]).toBe(TRANSPARENT); // padding tiles are colour 0 = transparent
  });

  test("extractBattleAnims: row 0 is the dummy, row n is move n, ids by row", () => {
    const rom = new FakeRom();
    rom.word(0x32, 0x4000, 0x4400);
    for (let row = 1; row < 278; row++) rom.word(0x32, 0x4000 + row * 2, 0x4410);
    rom.word(0x32, 0x4002, 0x4420);
    rom.put(0x32, 0x4400, [0xff]);
    rom.put(0x32, 0x4410, [0xff]);
    rom.put(0x32, 0x4420, [0x01, 0xff]);
    const ctx = ctxOf(
      rom,
      manifest(
        {
          BattleAnimations: [0x32, 0x4000],
          BattleAnimObjects: [0x33, 0x4000],
          BattleAnimFrameData: [0x33, 0x4000],
          BattleAnimOAMData: [0x33, 0x4000],
          AnimObjGFX: [0x33, 0x4000],
        },
        { moveOrder: ["POUND", "KARATE_CHOP"] },
      ),
    );
    const out = extractBattleAnims(ctx).battle_anims as any;
    expect(out.bank).toBe(0x32);
    expect(out.scriptOrder).toEqual(["4400", "4420", "4410"]);
    expect(out.moves).toEqual({ POUND: "4420", KARATE_CHOP: "4410" });
    expect(out.ids.ANIM_THROW_POKE_BALL).toBe("4410");
    expect(Object.keys(out.ids).length).toBe(23);
    expect(out.scripts["4420"]).toEqual([["wait", 1], ["ret"]]);
  });
});

// ---------------------------------------------------------------- movies

describe("gen2 cutscene stages tolerate a manifest without their labels", () => {
  test("every optional field is omitted, never null", () => {
    const ctx = ctxOf(new FakeRom(), manifest({}));
    expect(extractCredits(ctx)).toEqual({
      credits: {
        generation: 2,
        source: "ROM:CreditsBorderGFX + Credits<Mon>GFX + TheEndGFX + CreditsPalettes",
      },
    });
    expect(Object.keys(extractDiploma(ctx).diploma as object)).toEqual(["generation", "source"]);
    expect(Object.keys(extractTrade(ctx).trade as object)).toEqual(["generation", "source"]);
    expect(readMagnetTrain(ctx)).toBeUndefined();
    expect(Object.keys(extractStubs(ctx).field as object)).toEqual(["generation", "source"]);
    expect(ctx.gfx.bytes().length).toBe(0);
  });

  test("magnet train: 2x18 BG strip and the 20x4 train, flat row-major", () => {
    const rom = new FakeRom();
    const bg = Array.from({ length: 36 }, (_, i) => i + 1);
    const fg = Array.from({ length: 80 }, (_, i) => 0x80 + i);
    rom.put(0x23, 0x5000, bg);
    rom.put(0x23, 0x5100, fg);
    const ctx = ctxOf(rom, manifest({ MagnetTrainBGTiles: [0x23, 0x5000], MagnetTrainTilemap: [0x23, 0x5100] }));
    expect(extractStubs(ctx).field).toEqual({
      generation: 2,
      source: "Gold Phase 2 stub -- not yet extracted, see docs/gold-phase1.md",
      magnetTrain: { source: "ROM:MagnetTrainBGTiles + MagnetTrainTilemap", bgTiles: bg, tilemap: fg, width: 20, rows: 4 },
    });
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
if (!gold) console.log(`voxel-gen2-movies: skipping the Gold ROM checks — no verified ROM at ${GOLD_ROM} or no manifest at ${GOLD_MANIFEST}`);

describe.skipIf(!gold)("gen2 cutscenes and battle anims against the Gold ROM", () => {
  const ctx = gold ? new Gen2Ctx(new Rom(gold.rom), gold.manifest, new GfxBin(), GOLD_SHA1) : null!;
  const dims = (key: string) => {
    const e = ctx.gfx.directory[key];
    return e ? [e.w, e.h] : undefined;
  };

  test("battle_anims: 278 rows -> 251 moves + 23 ids, BattleAnim_Pound as pokegold writes it", () => {
    const b = extractBattleAnims(ctx).battle_anims as any;
    expect(Object.keys(b.moves).length).toBe(251);
    expect(Object.keys(b.ids).length).toBe(23);
    expect(b.scriptOrder.length).toBe(Object.keys(b.scripts).length);
    // data/moves/animations.asm BattleAnim_Pound.
    expect(b.scripts[b.moves.POUND]).toEqual([
      ["1gfx", 1], // BATTLE_ANIM_GFX_HIT
      ["sound", 1, 0x31], // anim_sound 0, 1, SFX_POUND
      ["obj", 8, 136, 56, 0], // BATTLE_ANIM_OBJ_PALM
      ["wait", 6],
      ["obj", 1, 136, 56, 0], // BATTLE_ANIM_OBJ_HIT_YFIX
      ["wait", 16],
      ["ret"],
    ]);
    // BattleAnim_Miss is a bare anim_ret.
    expect(b.scripts[b.ids.ANIM_MISS]).toEqual([["ret"]]);
    // Every branch target was walked into the pool.
    const branchy = new Set(["jumpuntil", "if_param_and", "if_param_equal", "if_var_equal", "jump", "loop", "call"]);
    for (const rows of Object.values(b.scripts) as AnimRow[][]) {
      for (const row of rows) if (branchy.has(row[0] as string)) expect(b.scripts[row[row.length - 1] as string]).toBeDefined();
    }
    expect(Object.keys(b.objects).length).toBe(188);
    expect(b.objects.BATTLE_ANIM_OBJ_HIT_BIG_YFIX).toEqual({
      flags: 1, fixY: 0xff, frameset: "BATTLE_ANIM_FRAMESET_HIT_BIG", func: "BATTLE_ANIM_FUNC_NULL",
      palette: "PAL_BATTLE_OB_GRAY", gfx: "BATTLE_ANIM_GFX_HIT",
    });
    expect(Object.keys(b.framesets).length).toBe(185);
    expect(Object.keys(b.oamsets).length).toBe(216);
    // 41 anim_obj_gfx rows with tiles; ENEMYFEET/PLAYERHEAD are 0-tile
    // runtime placeholders like NONE.
    expect(Object.keys(b.gfx).length).toBe(39);
    expect(b.gfx.BATTLE_ANIM_GFX_HIT).toEqual({ tiles: 21, wide: 8, image: "battle_anims/battle_anim_gfx_hit" });
    expect(dims("battle_anims/battle_anim_gfx_hit")).toEqual([64, 24]);
  });

  test("credits: border, THE END, Gold's four scenes, six palettes", () => {
    const c = extractCredits(ctx).credits as any;
    expect(c.scenes.map((s: any) => [s.species, s.frames])).toEqual([["BELLOSSOM", 3], ["TOGEPI", 3], ["ELEKID", 3], ["SENTRET", 4]]);
    expect(dims("credits/border")).toEqual([72, 8]);
    expect(dims("credits/theend")).toEqual([64, 16]);
    expect(dims("credits/bellossom")).toEqual([32, 96]);
    expect(dims("credits/sentret")).toEqual([32, 128]);
    expect(c.palettes.length).toBe(6);
    expect(c.palettes[0].length).toBe(4);
    expect(c.theEndY).toBe(8);
  });

  test("diploma: 16x7-tile sheet and a 20x18 page", () => {
    const d = extractDiploma(ctx).diploma as any;
    expect(dims("diploma/diploma")).toEqual([128, 56]);
    expect(d.page1.length).toBe(360);
    expect(Math.max(...d.page1)).toBeLessThan(112); // vTiles2 ids 0..111
    expect(d.palettes.length).toBe(8);
  });

  test("trade: scene sheet, both tilemaps inside it, OBJ sheets", () => {
    const t = extractTrade(ctx).trade as any;
    expect(dims("trade/scene")).toEqual([56, 56]);
    expect(t.gameBoy.tiles.length).toBe(48);
    expect(t.tube.tiles.length).toBe(36);
    for (const id of [...t.gameBoy.tiles, ...t.tube.tiles]) {
      expect(id - t.baseTile).toBeGreaterThanOrEqual(0);
      expect(id - t.baseTile).toBeLessThan(49);
    }
    expect(dims("trade/ball")).toEqual([8, 48]);
    expect(dims("trade/poof")).toEqual([16, 48]);
    expect(dims("trade/bulge")).toEqual([8, 16]);
    expect(dims("trade/bubble")).toEqual([16, 16]);
    expect(dims("trade/arrows")).toEqual([8, 16]);
  });

  test("field: the magnet train's 2x18 strip and 20x4 train", () => {
    const f = extractStubs(ctx).field as any;
    expect(f.magnetTrain.bgTiles.length).toBe(36);
    expect(f.magnetTrain.tilemap.length).toBe(80);
    expect([f.magnetTrain.width, f.magnetTrain.rows]).toEqual([20, 4]);
  });
});
