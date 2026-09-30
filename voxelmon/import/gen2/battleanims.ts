// Port of gen1recomp RomExtractorGen2.lua (bdfac727) :6870-7118 and
// :7368-7414: the battle animation scripts (data/moves/animations.asm) and
// the object/frameset/OAM/gfx tables they drive (data/battle_anims/*).
// extractMobileGfx and its MOBILE_* tables (:7120-7366) are not ported: it
// returns nil unless the edition is Crystal (:7275), and this is Gold only.

import type { Gen2Ctx } from "./ctx.ts";
import { lua, write2bpp } from "./helpers.ts";
import { decompressLz3 } from "./lz.ts";

/**
 * RomExtractorGen2.lua:6878 ANIM_CMDS (macros/scripts/battle_anims.asm):
 * command byte -> [name, argument byte count]. Bytes under $d0
 * (FIRST_BATTLE_ANIM_CMD) are `anim_wait <n>` with no arguments.
 */
export const ANIM_CMDS: Record<number, [string, number]> = {
  0xd0: ["obj", 4], 0xd1: ["1gfx", 1], 0xd2: ["2gfx", 2],
  0xd3: ["3gfx", 3], 0xd4: ["4gfx", 4], 0xd5: ["5gfx", 5],
  0xd6: ["incobj", 1], 0xd7: ["setobj", 2],
  0xd8: ["incbgeffect", 1],
  0xd9: ["battlergfx_2row", 0], 0xda: ["battlergfx_1row", 0],
  0xdb: ["checkpokeball", 0], 0xdc: ["transform", 0],
  0xdd: ["raisesub", 0], 0xde: ["dropsub", 0],
  0xdf: ["resetobp0", 0],
  0xe0: ["sound", 2], 0xe1: ["cry", 1],
  0xe2: ["minimizeopp", 0], 0xe3: ["oamon", 0],
  0xe4: ["oamoff", 0], 0xe5: ["clearobjs", 0],
  0xe6: ["beatup", 0], 0xe7: ["unknown_e7", 0],
  0xe8: ["updateactorpic", 0], 0xe9: ["minimize", 0],
  0xea: ["unknown_ea", 0], 0xeb: ["unknown_eb", 0],
  0xec: ["unknown_ec", 0], 0xed: ["unknown_ed", 0],
  0xee: ["if_param_and", 3], 0xef: ["jumpuntil", 2],
  0xf0: ["bgeffect", 4],
  0xf1: ["bgp", 1], 0xf2: ["obp0", 1], 0xf3: ["obp1", 1],
  0xf4: ["keepsprites", 0], 0xf5: ["unknown_f5", 0],
  0xf6: ["unknown_f6", 0], 0xf7: ["unknown_f7", 0],
  0xf8: ["if_param_equal", 3], 0xf9: ["setvar", 1],
  0xfa: ["incvar", 0], 0xfb: ["if_var_equal", 3],
  0xfc: ["jump", 2], 0xfd: ["loop", 3],
  0xfe: ["call", 2], 0xff: ["ret", 0],
};

/** :6906 ANIM_BRANCHES — command -> the 1-based argument position where its
 * trailing little-endian same-bank address starts. */
export const ANIM_BRANCHES: Record<string, number> = {
  jumpuntil: 1, if_param_and: 2, if_param_equal: 2, if_var_equal: 2,
  jump: 1, loop: 2, call: 1,
};

/** :6910 — data/moves/animations.asm's BattleAnimations rows. */
export const NUM_BATTLE_ANIMS = 278;

/** :6916 BATTLE_ANIM_IDS (constants/move_constants.asm): row id -> name of
 * the animations the engine plays by id rather than by move. */
export const BATTLE_ANIM_IDS: Record<number, string> = {
  0xff: "ANIM_SWEET_SCENT_2", 0x100: "ANIM_THROW_POKE_BALL",
  0x101: "ANIM_SEND_OUT_MON", 0x102: "ANIM_RETURN_MON",
  0x103: "ANIM_CONFUSED", 0x104: "ANIM_SLP", 0x105: "ANIM_BRN",
  0x106: "ANIM_PSN", 0x107: "ANIM_SAP", 0x108: "ANIM_FRZ",
  0x109: "ANIM_PAR", 0x10a: "ANIM_IN_LOVE",
  0x10b: "ANIM_IN_SANDSTORM", 0x10c: "ANIM_IN_NIGHTMARE",
  0x10d: "ANIM_IN_WHIRLPOOL", 0x10e: "ANIM_MISS",
  0x10f: "ANIM_ENEMY_DAMAGE", 0x110: "ANIM_ENEMY_STAT_DOWN",
  0x111: "ANIM_PLAYER_STAT_DOWN", 0x112: "ANIM_PLAYER_DAMAGE",
  0x113: "ANIM_WOBBLE", 0x114: "ANIM_SHAKE",
  0x115: "ANIM_HIT_CONFUSION",
};

/** One disassembled command: [name, ...args]. `["wait", n]` for a byte
 * under $d0; a branch command's address args are folded into one lowercase
 * "%04x" string key (so `["loop", count, "4abc"]`, `["jump", "4abc"]`). */
export type AnimRow = (string | number)[];

const hex4 = (value: number): string => value.toString(16).padStart(4, "0");

/**
 * RomExtractorGen2.lua:6934 readBattleAnimScript — disassemble the script at
 * bank:address into `pool` (keyed by lowercase "%04x" address), appending
 * each new key to `order`, then follow every branch target (depth-first, in
 * the order met). Stops at ret or jump, or after 4096 commands. Returns the
 * key.
 */
export function readBattleAnimScript(
  ctx: Gen2Ctx,
  bank: number,
  address: number,
  pool: Record<string, AnimRow[]>,
  order: string[],
): string {
  const key = hex4(address);
  if (pool[key]) return key;
  const rows: AnimRow[] = [];
  pool[key] = rows; // claimed before the walk, so a self-jump terminates
  order.push(key);
  let at = address;
  const pending: number[] = [];
  for (let step = 0; step < 4096; step++) {
    const byte = ctx.rom.byte(bank, at);
    at++;
    const spec = ANIM_CMDS[byte];
    if (!spec) {
      rows.push(["wait", byte]);
      continue;
    }
    const [name, argc] = spec;
    const row: AnimRow = [name];
    for (let i = 0; i < argc; i++) row.push(ctx.rom.byte(bank, at++));
    const branch = ANIM_BRANCHES[name];
    if (branch !== undefined) {
      // :6957 — the last two argument bytes, little-endian.
      const target = (row[branch] as number) + (row[branch + 1] as number) * 256;
      row[branch] = hex4(target);
      row.length = branch + 1;
      pending.push(target);
    }
    rows.push(row);
    if (name === "ret" || name === "jump") break;
  }
  for (const target of pending) readBattleAnimScript(ctx, bank, target, pool, order);
  return key;
}

export interface BattleAnimObject {
  flags: number;
  fixY: number;
  frameset: string | number;
  func: string | number;
  palette: string | number;
  gfx: string | number;
  // Brian also sets `tileOffset = row[7]` (:7006), which on a six-byte read
  // is always nil, so the key never appears in his output and is omitted
  // here. The sixth byte (macro arg "tile offset") is the BATTLE_ANIM_GFX_*
  // id, which is what `gfx` names.
}

/**
 * RomExtractorGen2.lua:6979 readBattleAnimObjects — BattleAnimObjects rows
 * are SIX bytes (the struct's INDEX byte is runtime-only): flags, fixY,
 * frameset, func, palette (PAL_BATTLE_OB_*), gfx. Each id is
 * named through its 0-based order list (Lua `list[v + 1] or v`).
 */
export function readBattleAnimObjects(ctx: Gen2Ctx): Record<string, BattleAnimObject> {
  const consts = ctx.manifest.constants;
  const names = (consts.battleAnimObjectOrder as string[] | undefined) ?? [];
  const framesets = consts.battleAnimFramesetOrder as string[] | undefined;
  const funcs = consts.battleAnimFuncOrder as string[] | undefined;
  const pals = consts.battleAnimObPaletteOrder;
  // battleAnimGfxOrder carries a placeholder for AnimObjGFX's row 0 (:7002).
  const gfx = consts.battleAnimGfxOrder as string[] | undefined;
  const symbol = ctx.symbol("BattleAnimObjects");
  const out: Record<string, BattleAnimObject> = {};
  names.forEach((name, index) => {
    const row = ctx.rom.bytes(symbol.bank, symbol.address + index * 6, 6);
    out[name] = {
      flags: row[0]!,
      fixY: row[1]!,
      frameset: lua(framesets, row[2]! + 1) ?? row[2]!,
      func: lua(funcs, row[3]! + 1) ?? row[3]!,
      palette: lua(pals, row[4]! + 1) ?? row[4]!,
      gfx: lua(gfx, row[5]! + 1) ?? row[5]!,
    };
  });
  return out;
}

/** A frameset command: ["frame", oamset, duration (low 6 bits), flip bits
 * (duration & 0xc0) >> 1], ["wait", n], ["end"], ["restart"], ["delete"]. */
export type FramesetRow = (string | number)[];

/**
 * RomExtractorGen2.lua:7016 readBattleAnimFramesets — BattleAnimFrameData
 * pointer table of oamframe lists (the same format as the overworld sprite
 * anims). Stops at end/restart/delete or after 64 commands.
 */
export function readBattleAnimFramesets(ctx: Gen2Ctx): Record<string, FramesetRow[]> {
  const consts = ctx.manifest.constants;
  const names = (consts.battleAnimFramesetOrder as string[] | undefined) ?? [];
  const oamsets = consts.battleAnimOamsetOrder as string[] | undefined;
  const symbol = ctx.symbol("BattleAnimFrameData");
  const out: Record<string, FramesetRow[]> = {};
  names.forEach((name, index) => {
    let at = ctx.rom.word(symbol.bank, symbol.address + index * 2);
    const frames: FramesetRow[] = [];
    for (let step = 0; step < 64; step++) {
      const byte = ctx.rom.byte(symbol.bank, at++);
      if (byte === 0xff) {
        frames.push(["end"]);
        break;
      } else if (byte === 0xfe) {
        frames.push(["restart"]);
        break;
      } else if (byte === 0xfd) {
        frames.push(["wait", ctx.rom.byte(symbol.bank, at++)]);
      } else if (byte === 0xfc) {
        frames.push(["delete"]);
        break;
      } else {
        // :7045 — oamframe is set THEN duration; duration's top two bits
        // are the flips, shifted down one to the OAM flag position.
        const duration = ctx.rom.byte(symbol.bank, at++);
        frames.push(["frame", lua(oamsets, byte + 1) ?? byte, duration & 0x3f, (duration & 0xc0) >> 1]);
      }
    }
    out[name] = frames;
  });
  return out;
}

export interface BattleAnimOamset {
  vtile: number;
  /** dbsprite rows: y first, then x, tile offset, attributes. */
  sprites: { y: number; x: number; tile: number; attr: number }[];
}

/** RomExtractorGen2.lua:7066 readBattleAnimOamsets — BattleAnimOAMData rows
 * `battleanimoam <vtile>, <count>, <pointer>`. */
export function readBattleAnimOamsets(ctx: Gen2Ctx): Record<string, BattleAnimOamset> {
  const names = (ctx.manifest.constants.battleAnimOamsetOrder as string[] | undefined) ?? [];
  const symbol = ctx.symbol("BattleAnimOAMData");
  const out: Record<string, BattleAnimOamset> = {};
  names.forEach((name, index) => {
    const row = ctx.rom.bytes(symbol.bank, symbol.address + index * 4, 4);
    const at = row[2]! + row[3]! * 256;
    const sprites: BattleAnimOamset["sprites"] = [];
    for (let i = 0; i < row[1]!; i++) {
      const entry = ctx.rom.bytes(symbol.bank, at + i * 4, 4);
      sprites.push({ y: entry[0]!, x: entry[1]!, tile: entry[2]!, attr: entry[3]! });
    }
    out[name] = { vtile: row[0]!, sprites };
  });
  return out;
}

export interface BattleAnimGfx {
  tiles: number;
  /** tiles per row of the sheet: min(tiles, 8). */
  wide: number;
  /** gfx key "battle_anims/<name>", colour 0 transparent. */
  image: string;
}

/**
 * RomExtractorGen2.lua:7089 readBattleAnimGfx — AnimObjGFX rows
 * `anim_obj_gfx <tiles>, <label>` (count + dba far pointer to an lz3
 * sheet). Zero-tile rows and sheets that fail to decompress (Brian's pcall)
 * are skipped. Sheets are min(tiles, 8) tiles wide, padded to whole rows.
 */
export function readBattleAnimGfx(ctx: Gen2Ctx): Record<string, BattleAnimGfx> {
  const names = (ctx.manifest.constants.battleAnimGfxOrder as string[] | undefined) ?? [];
  const symbol = ctx.symbol("AnimObjGFX");
  const out: Record<string, BattleAnimGfx> = {};
  names.forEach((name, index) => {
    const row = ctx.rom.bytes(symbol.bank, symbol.address + index * 4, 4);
    const tiles = row[0]!;
    if (tiles <= 0) return;
    const bank = row[1]!;
    const address = row[2]! + row[3]! * 256;
    let pixels: number[];
    try {
      pixels = decompressLz3(ctx.rom.bytes(bank, address, 0x8000 - address));
    } catch {
      return;
    }
    const wide = Math.min(tiles, 8);
    const high = Math.ceil(tiles / wide);
    const need = wide * high * 16;
    pixels = pixels.slice(0, need);
    while (pixels.length < need) pixels.push(0);
    const image = write2bpp(ctx, pixels, wide * 8, high * 8, `battle_anims/${name.toLowerCase()}.png`, true);
    out[name] = { tiles, wide, image };
  });
  return out;
}

/**
 * RomExtractorGen2.lua:7368 extractBattleAnims. battle_anims.json:
 * - generation 2, source, bank (BattleAnimations' bank; every script
 *   address is in it);
 * - scripts: {"%04x": AnimRow[]} — every script, sub-scripts included;
 * - scriptOrder: the keys in discovery order;
 * - moves: {POUND: key, ...} — BattleAnimations row n (n >= 1) is move n
 *   (row 0 is BattleAnim_Dummy);
 * - ids: {ANIM_THROW_POKE_BALL: key, ...} (BATTLE_ANIM_IDS);
 * - objects: {BATTLE_ANIM_OBJ_*: BattleAnimObject};
 * - framesets: {BATTLE_ANIM_FRAMESET_*: FramesetRow[]};
 * - oamsets: {BATTLE_ANIM_OAMSET_*: BattleAnimOamset};
 * - gfx: {BATTLE_ANIM_GFX_*: BattleAnimGfx}.
 */
export function extractBattleAnims(ctx: Gen2Ctx): Record<string, unknown> {
  const moveOrder = (ctx.manifest.constants.moveOrder as string[] | undefined) ?? [];
  const table = ctx.symbol("BattleAnimations");
  const pool: Record<string, AnimRow[]> = {};
  const order: string[] = [];
  const moves: Record<string, string> = {};
  const ids: Record<string, string> = {};
  for (let row = 0; row < NUM_BATTLE_ANIMS; row++) {
    const address = ctx.rom.word(table.bank, table.address + row * 2);
    const key = readBattleAnimScript(ctx, table.bank, address, pool, order);
    // :7383 moveOrder[index - 1] with Lua index = row + 1: move `row`.
    const name = row >= 1 ? lua(moveOrder, row) : undefined;
    if (name) moves[name] = key;
    const idName = BATTLE_ANIM_IDS[row];
    if (idName) ids[idName] = key;
  }
  const scripts: Record<string, AnimRow[]> = {};
  for (const key of order) scripts[key] = pool[key]!;
  return {
    battle_anims: {
      generation: 2,
      source: "ROM:BattleAnimations + data/battle_anims/*",
      bank: table.bank,
      scripts,
      scriptOrder: order,
      moves,
      ids,
      objects: readBattleAnimObjects(ctx),
      framesets: readBattleAnimFramesets(ctx),
      oamsets: readBattleAnimOamsets(ctx),
      gfx: readBattleAnimGfx(ctx),
    },
  };
}
