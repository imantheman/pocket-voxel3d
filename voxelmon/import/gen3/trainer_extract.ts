// Port of gen1recomp src/import/gba/trainer_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// Extract FRLG trainer tables + player back pics into data/generated/gba/trainers/.
// Extracts: gTrainers metadata, AI behavior flags, 4-tier TrainerMon parties (with flat IV math),
// and overworld trainer / boss dialogue strings.
// Lua differences: byte tables (tiles, palettes) are 0-based Uint8Arrays;
// lists the Lua builds as sequences (party, moves, items) are 0-based arrays;
// per-id tables (classNames, trainers, dialogs) are objects keyed by id.
// The scripts/text bundle may hold sequences as JS arrays or as 1-based
// integer-keyed objects; both are read the way Lua reads them.

import { Versions } from "./versions.ts";
import { TextIR, type Seg } from "../../game/gen3/core/scripting/text_ir.ts";
import { Lz77 } from "./lz77.ts";
import { Layouts, type StructLayout } from "./layouts.ts";
import { readLuaLiteral } from "./asset_pack.ts";
import { format, fromBytes, tonumber, tostring, truthy } from "./lua.ts";
import { luaGet } from "./luatable.ts";
import type { Cache } from "./cache.ts";
import type { Rom } from "./rom.ts";

export interface TrainerMon {
  species: number; level: number; rawIv: number; iv: number;
  ivs: Record<string, number>; evs: Record<string, number>;
  moves?: number[]; heldItem?: number;
}
export interface TrainerDialogs { intro?: string; defeat?: string; victory?: string; notEnough?: string }
export interface DialogRow extends TrainerDialogs {
  scriptKey: string; rematch: boolean; battleType: unknown;
  introKey?: any; defeatKey?: any; victoryKey?: any; notEnoughKey?: any;
}
export interface TrainerRow {
  class: number; className: string; pic: number; name: string; gender: number; encounterMusic: number;
  doubleBattle: boolean; partySize: number; partyFlags: number; lastLevel: number; aiFlags: number;
  ai: Record<string, boolean>; items: number[]; party: TrainerMon[]; dialogs: TrainerDialogs;
  scriptKey?: string; introTextKey?: any; defeatTextKey?: any; victoryTextKey?: any; notEnoughTextKey?: any;
}
export interface TrainerExtras {
  backPicCount: number; money: [number, number][]; moneyDefault?: number;
  facilityClassToPic?: number[]; facilityClassToTrainerClass?: number[]; unionRoomFacilityClasses?: number[];
  rematches?: { trainers: number[]; mapGroup: number; mapNum: number }[];
}
export interface TrainerPack {
  version: number; classCount: number; trainerCount: number;
  classNames: Record<number, string>; trainers: Record<number, TrainerRow>; extras?: TrainerExtras;
}
export interface TrainerOpts {
  cacheRoot?: string; layout?: StructLayout; scripts?: any; text?: any;
}

// Party mon strides (ARM EABI sizes used by FRLG gTrainers parties).
// Lua: trainer_extract.lua:18
const PARTY_STRIDE: Record<number, number> = {
  0: 8, // NoItemDefaultMoves
  1: 16, // NoItemCustomMoves
  2: 8, // ItemDefaultMoves
  3: 16, // ItemCustomMoves
};

/** Lua's ipairs over a sequence that is a JS array or a 1-based integer-keyed object. */
function ipairs(t: unknown): unknown[] {
  if (t === undefined || t === null || typeof t !== "object") return [];
  const out: unknown[] = [];
  for (let i = 1; ; i++) {
    const v = luaGet(t as object, i);
    if (v === undefined || v === null) break;
    out.push(v);
  }
  return out;
}

/** t[k] for a Lua table held as an object (string or number key). */
function field(t: any, k: unknown): any {
  if (t === undefined || t === null || (typeof k !== "string" && typeof k !== "number")) return undefined;
  return Object.prototype.hasOwnProperty.call(t, k as string) ? t[k as string] : undefined;
}

// Lua: trainer_extract.lua:25
function gba_off(ptr: unknown): number | undefined {
  if (typeof ptr !== "number") return undefined;
  if (ptr >= 0x08000000 && ptr < 0x0a000000) return ptr - 0x08000000;
  return undefined;
}

// Lua: trainer_extract.lua:33
function decompose_ai_flags(flagsIn: unknown): Record<string, boolean> {
  const flags = tonumber(flagsIn) ?? 0;
  return {
    checkBadMove: flags % 2 === 1,
    checkViability: Math.floor(flags / 2) % 2 === 1,
    tryToFaint: Math.floor(flags / 4) % 2 === 1,
    setupFirstTurn: Math.floor(flags / 8) % 2 === 1,
    risky: Math.floor(flags / 16) % 2 === 1,
    preferStrongestMove: Math.floor(flags / 32) % 2 === 1,
    preferBatonPass: Math.floor(flags / 64) % 2 === 1,
    doubleBattle: Math.floor(flags / 128) % 2 === 1,
    hpAware: Math.floor(flags / 256) % 2 === 1,
    roaming: Math.floor(flags / 0x20000000) % 2 === 1,
    safari: Math.floor(flags / 0x40000000) % 2 === 1,
    firstBattle: flags >= 0x80000000,
  };
}

// Lua: trainer_extract.lua:51 -- [party, highestLevel]
function read_party(rom: Rom, partyFlagsIn: unknown, partySizeIn: unknown, partyPtr: unknown): [TrainerMon[], number] {
  const partyFlags = (tonumber(partyFlagsIn) ?? 0) % 4;
  const partySize = tonumber(partySizeIn) ?? 0;
  const partyOff = gba_off(partyPtr);
  if (partySize < 1 || partyOff === undefined) return [[], 1];

  const party: TrainerMon[] = [];
  const pStride = PARTY_STRIDE[partyFlags] ?? 8;
  let highestLevel = 1;

  for (let p = 0; p <= partySize - 1; p++) {
    const mOff = partyOff + p * pStride;
    if (mOff + pStride > rom.size) break;

    const rawIvWord = rom.u16(mOff);
    const rawIv = rawIvWord % 256;
    // The Flat IV Math Trap: (rawIv * 31) / 255 uniform across all 6 stats
    const iv = Math.floor((rawIv * 31) / 255);
    const lvl = rom.get(mOff + 2);
    if (lvl > highestLevel) highestLevel = lvl;
    const species = rom.u16(mOff + 4);

    const mon: TrainerMon = {
      species,
      level: lvl,
      rawIv,
      iv,
      ivs: { hp: iv, atk: iv, def: iv, spa: iv, spd: iv, spe: iv },
      // Trainer EVs are Zero across all stats
      evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
    };

    if (partyFlags === 0) {
      // NoItemDefaultMoves
    } else if (partyFlags === 1) {
      // NoItemCustomMoves
      const moves: number[] = [];
      for (let mi = 0; mi <= 3; mi++) {
        const mv = rom.u16(mOff + 6 + mi * 2);
        if (mv > 0) moves.push(mv);
      }
      mon.moves = moves;
    } else if (partyFlags === 2) {
      // ItemDefaultMoves
      const held = rom.u16(mOff + 6);
      if (held > 0) mon.heldItem = held;
    } else if (partyFlags === 3) {
      // ItemCustomMoves
      const held = rom.u16(mOff + 6);
      if (held > 0) mon.heldItem = held;
      const moves: number[] = [];
      for (let mi = 0; mi <= 3; mi++) {
        const mv = rom.u16(mOff + 8 + mi * 2);
        if (mv > 0) moves.push(mv);
      }
      mon.moves = moves;
    }

    party.push(mon);
  }

  return [party, highestLevel];
}

// Lua: trainer_extract.lua:117 -- items[1..4] (0-based array here)
function read_items(rom: Rom, off: number): number[] {
  const items: number[] = [];
  for (let i = 0; i <= 3; i++) items[i] = rom.u16(off + 0x10 + i * 2);
  return items;
}

// Lua: trainer_extract.lua:126 (extract_island1's CACHE_ROOT; callers pass cacheRoot)
function default_cache_root(): string {
  return "data/generated/gba";
}

// Lua: trainer_extract.lua:134
function bgr555_to_rgb8(c: unknown): [number, number, number] {
  const n = (tonumber(c) ?? 0) % 32768;
  const r5 = n % 32, g5 = Math.floor(n / 32) % 32, b5 = Math.floor(n / 1024) % 32;
  return [Math.floor((r5 * 255) / 31 + 0.5), Math.floor((g5 * 255) / 31 + 0.5), Math.floor((b5 * 255) / 31 + 0.5)];
}

// Lua: trainer_extract.lua:144 (the Lua returns gsub's two values; callers take the first)
function decode_name(rom: Rom, off: number, length = 12): string {
  let out = "";
  let i = 0;
  while (i < length) {
    const b = rom.get(off + i);
    if (b === 0xff) break;
    if (b === 0x53 && i + 1 < length && rom.get(off + i + 1) === 0x54) {
      out += "POK\xc3\xa9MON";
      i += 2;
    } else {
      const ch = Object.prototype.hasOwnProperty.call(TextIR.CHARMAP, b) ? TextIR.CHARMAP[b] : undefined;
      if (ch !== undefined && ch !== "") out += ch;
      else if (b >= 0xbb && b <= 0xd4) out += String.fromCharCode(65 + (b - 0xbb));
      else if (b >= 0xd5 && b <= 0xee) out += String.fromCharCode(97 + (b - 0xd5));
      else if (b === 0x00) out += " ";
      i += 1;
    }
  }
  return out.replace(/[ \t\n\v\f\r]+$/, "");
}

// Lua: trainer_extract.lua:171
function lua_quote(s: unknown): string {
  return format("%q", tostring(s === undefined || s === null || s === false ? "" : s));
}

// Lua: trainer_extract.lua:175
function party_to_lua(party: TrainerMon[] | undefined): string {
  if (!party || party.length === 0) return "{}";
  const parts = ["{\n"];
  for (const m of party) {
    let movesStr = "nil";
    if (m.moves && m.moves.length > 0) movesStr = "{" + m.moves.join(",") + "}";
    parts.push(format(
      "        { species=%d, level=%d, rawIv=%d, iv=%d, heldItem=%s, moves=%s },\n",
      m.species ?? 1, m.level ?? 5, m.rawIv ?? 0, m.iv ?? 0,
      m.heldItem !== undefined ? tostring(m.heldItem) : "nil",
      movesStr));
  }
  parts.push("      }");
  return parts.join("");
}

// Lua: trainer_extract.lua:193
function dialogs_to_lua(d: TrainerDialogs | undefined): string {
  if (!d) return "{}";
  const parts = ["{\n"];
  if (d.intro !== undefined) parts.push(format("        intro = %s,\n", lua_quote(d.intro)));
  if (d.defeat !== undefined) parts.push(format("        defeat = %s,\n", lua_quote(d.defeat)));
  if (d.victory !== undefined) parts.push(format("        victory = %s,\n", lua_quote(d.victory)));
  if (d.notEnough !== undefined) parts.push(format("        notEnough = %s,\n", lua_quote(d.notEnough)));
  parts.push("      }");
  return parts.join("");
}

// Lua: trainer_extract.lua:204
function pack_to_lua(pack: TrainerPack): string {
  const lines = [
    "-- Auto-generated FRLG gTrainers with parties, AI flags, and dialogs.",
    "return {",
    format("  version = %d,", pack.version ?? 5),
    format("  trainerCount = %d,", pack.trainerCount ?? 0),
    format("  classCount = %d,", pack.classCount ?? 0),
    "  classNames = {",
  ];
  for (let id = 0; id <= (pack.classCount ?? 0) - 1; id++) {
    lines.push(format("    [%d] = %s,", id, lua_quote(pack.classNames[id] ?? "")));
  }
  lines.push("  },");
  lines.push("  trainers = {");
  for (let id = 0; id <= (pack.trainerCount ?? 0) - 1; id++) {
    const t = pack.trainers[id];
    if (t) {
      lines.push(format("    [%d] = {", id));
      lines.push(format("      class = %d,", t.class ?? 0));
      lines.push(format("      className = %s,", lua_quote(t.className ?? "")));
      lines.push(format("      pic = %d,", t.pic ?? 0));
      lines.push(format("      name = %s,", lua_quote(t.name ?? "")));
      lines.push(format("      gender = %d,", t.gender ?? 0));
      lines.push(format("      doubleBattle = %s,", t.doubleBattle ? "true" : "false"));
      lines.push(format("      partySize = %d,", t.partySize ?? 0));
      lines.push(format("      partyFlags = %d,", t.partyFlags ?? 0));
      lines.push(format("      lastLevel = %d,", t.lastLevel ?? 1));
      lines.push(format("      aiFlags = %d,", t.aiFlags ?? 0));
      lines.push(format("      items = {%d,%d,%d,%d},",
        (t.items && t.items[0]) ?? 0, (t.items && t.items[1]) ?? 0,
        (t.items && t.items[2]) ?? 0, (t.items && t.items[3]) ?? 0));
      if (truthy(t.scriptKey)) lines.push(format("      scriptKey = %s,", lua_quote(t.scriptKey)));
      if (truthy(t.introTextKey)) lines.push(format("      introTextKey = %s,", lua_quote(t.introTextKey)));
      if (truthy(t.defeatTextKey)) lines.push(format("      defeatTextKey = %s,", lua_quote(t.defeatTextKey)));
      if (pack.extras) lines.push(format("      encounterMusic = %d,", t.encounterMusic ?? 0));
      lines.push("      party = " + party_to_lua(t.party) + ",");
      lines.push("      dialogs = " + dialogs_to_lua(t.dialogs) + ",");
      lines.push("    },");
    }
  }
  lines.push("  },");
  const x = pack.extras;
  if (x) {
    lines.push(format("  backPicCount = %d,", x.backPicCount ?? 0));
    lines.push(format("  moneyDefault = %d,", x.moneyDefault ?? 0));
    lines.push("  money = {");
    for (const row of x.money) lines.push(format("    [%d] = %d,", row[0], row[1]));
    lines.push("  },");
    for (const key of ["facilityClassToPic", "facilityClassToTrainerClass", "unionRoomFacilityClasses"] as const) {
      const list = x[key];
      if (list) lines.push(format("  %s = { [0] = %s },", key, list.join(", ")));
    }
    lines.push("  rematches = {");
    (x.rematches ?? []).forEach((r, i) => {
      lines.push(format("    [%d] = { trainers = {%s}, mapGroup = %d, mapNum = %d },",
        i, r.trainers.join(","), r.mapGroup, r.mapNum));
    });
    lines.push("  },");
  }
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

// Lua: trainer_extract.lua:280 -- tiles / palBytes 0-based; returns [rgba, w, h]
function decode_sheet_rgba(tiles: ArrayLike<number>, palBytes: ArrayLike<number>, framesIn: unknown): [string, number, number] {
  const frames = Math.max(1, tonumber(framesIn) ?? 1);
  const pal: number[] = [];
  for (let c = 0; c <= 15; c++) pal[c] = (palBytes[c * 2] ?? 0) + (palBytes[c * 2 + 1] ?? 0) * 256;
  const rgb: [number, number, number][] = [];
  for (let c = 0; c <= 15; c++) rgb[c] = bgr555_to_rgb8(pal[c] ?? 0);
  const w = 64, h = 64 * frames;
  const out = new Uint8Array(w * h * 4);
  let ti = 0;
  const tilesH = 8 * frames;
  const put = (x: number, y: number, idx: number): void => {
    const i = (y * w + x) * 4;
    if (idx === 0) out.fill(0, i, i + 4);
    else {
      const c = rgb[idx] ?? rgb[0]!;
      out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2]; out[i + 3] = 255;
    }
  };
  for (let ty = 0; ty <= tilesH - 1; ty++) {
    for (let tx = 0; tx <= 7; tx++) {
      const tileOff = ti * 32;
      for (let row = 0; row <= 7; row++) {
        for (let bx = 0; bx <= 3; bx++) {
          const byte = tiles[tileOff + row * 4 + bx] ?? 0;
          const p0 = byte % 16, p1 = Math.floor(byte / 16) % 16;
          const x0 = tx * 8 + bx * 2, y0 = ty * 8 + row;
          put(x0, y0, p0);
          put(x0 + 1, y0, p1);
        }
      }
      ti++;
    }
  }
  return [fromBytes(out), w, h];
}

/** pcall(Lz77.decompress, get, off) -> the bytes, or undefined on error. */
function tryLz(rom: Rom, off: number): Uint8Array | undefined {
  try {
    return Lz77.decompress((i) => rom.get(i), off)[0];
  } catch {
    return undefined;
  }
}

// Lua: trainer_extract.lua:327
function bake_back_pic(rom: Rom, genderIn: unknown): string | undefined {
  const gender = tonumber(genderIn) ?? 0;
  const picTable = Versions.TRAINER_BACK_PIC_TABLE;
  if (!truthy(picTable)) throw new Error("trainer_extract: no TRAINER_BACK_PIC_TABLE key");
  const palTable = Versions.TRAINER_BACK_PIC_PAL_TABLE;
  if (!truthy(palTable)) throw new Error("trainer_extract: no TRAINER_BACK_PIC_PAL_TABLE key");
  const sheetOff = picTable + gender * 8;
  const palOff = palTable + gender * 8;
  const tilePtr = rom.u32(sheetOff);
  const palPtr = rom.u32(palOff);
  const tileFile = Versions.gbaToFile(tilePtr);
  const palFile = Versions.gbaToFile(palPtr);
  if (tileFile === undefined || palFile === undefined) return undefined;
  const sizeLo = rom.get(sheetOff + 4);
  const sizeHi = rom.get(sheetOff + 5);
  let size = sizeLo + sizeHi * 256;
  if (size < 0x800) size = 0x2800;
  const frames = Math.max(1, Math.floor(size / 0x800));
  const tiles = new Uint8Array(size);
  for (let i = 0; i <= size - 1; i++) tiles[i] = rom.get(tileFile + i);
  const palBytes = tryLz(rom, palFile);
  if (!palBytes) return undefined;
  return decode_sheet_rgba(tiles, palBytes, frames)[0];
}

// Lua: trainer_extract.lua:360
function bake_front_pic(rom: Rom, picIdIn: unknown): string | undefined {
  const picId = tonumber(picIdIn);
  if (picId === undefined || picId < 0) return undefined;
  const picTable = Versions.TRAINER_FRONT_PIC_TABLE;
  if (!truthy(picTable)) throw new Error("trainer_extract: no TRAINER_FRONT_PIC_TABLE key");
  const palTable = Versions.TRAINER_FRONT_PIC_PAL_TABLE;
  if (!truthy(palTable)) throw new Error("trainer_extract: no TRAINER_FRONT_PIC_PAL_TABLE key");
  const sheetOff = picTable + picId * 8;
  const palOff = palTable + picId * 8;
  const tilePtr = rom.u32(sheetOff);
  const palPtr = rom.u32(palOff);
  const tileFile = Versions.gbaToFile(tilePtr);
  const palFile = Versions.gbaToFile(palPtr);
  if (tileFile === undefined || palFile === undefined) return undefined;
  const sizeLo = rom.get(sheetOff + 4);
  const sizeHi = rom.get(sheetOff + 5);
  const size = sizeLo + sizeHi * 256;
  let tiles = tryLz(rom, tileFile);
  if (!tiles) return undefined;
  if (size >= 0x1000 && tiles.length > 2048) tiles = tiles.slice(0, 2048);
  const palBytes = tryLz(rom, palFile);
  if (!palBytes) return undefined;
  return decode_sheet_rgba(tiles, palBytes, 1)[0];
}

// Lua: trainer_extract.lua:538
function byte_list(rom: Rom, off: number, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= count - 1; i++) out.push(rom.get(off + i));
  return out;
}

// Lua: trainer_extract.lua:579
function dialogs_pack_to_lua(byTrainer: Record<number, DialogRow>): string {
  const ids = Object.keys(byTrainer).map(Number).sort((a, b) => a - b);
  const lines = ["return {"];
  const fieldLine = (k: string, v: unknown): void => {
    if (v !== undefined && v !== null) lines.push(format("    %s = %s,", k, lua_quote(v)));
  };
  for (const id of ids) {
    const d = byTrainer[id]!;
    lines.push(format("  [%d] = {", id));
    fieldLine("scriptKey", d.scriptKey);
    fieldLine("introTextKey", d.introKey);
    fieldLine("defeatTextKey", d.defeatKey);
    fieldLine("victoryTextKey", d.victoryKey);
    fieldLine("notEnoughTextKey", d.notEnoughKey);
    lines.push("    dialogs = " + dialogs_to_lua(d) + ",");
    lines.push("  },");
  }
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

export const TrainerExtract = {
  FORMAT_VERSION: 5,
  CACHE_SUB: "trainers",
  REQUIRED: ["trainers.lua", "trainers/manifest.lua"],
  DIALOGS_FILE: "dialogs.lua",

  /**
   * Lua: trainer_extract.lua:397 -- scan script bytecode to extract and
   * cross-index dialogue per trainerId, resolving The Boss Text Disconnect via
   * backwards message/loadword search.
   */
  extractDialogs(scripts: any, text: any): Record<number, DialogRow> {
    const dialogsByTrainer: Record<number, DialogRow> = {};
    if (!truthy(scripts) || !truthy(text)) return dialogsByTrainer;

    const scriptKeys = Object.keys(scripts).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));

    for (const scriptKey of scriptKeys) {
      const rows = scripts[scriptKey];
      if (typeof rows === "object" && rows !== null) {
        const list = ipairs(rows) as any[];
        list.forEach((row, i) => {
          const idx = i + 1;
          if (row.op === "trainerbattle" || row.op === "dotrainerbattle") {
            const tid = tonumber(truthy(row.trainer) ? row.trainer : luaGet(row, 1));
            // include/constants/battle_setup.h:9
            const rematch = row.type === 5 || row.type === 7;
            const prior = tid !== undefined ? dialogsByTrainer[tid] : undefined;
            if (tid !== undefined && (!prior || (prior.rematch && !rematch))) {
              let introKey = row.introText;
              // The Boss Text Disconnect fallback:
              if (!truthy(introKey)) {
                for (let b = idx - 1; b >= Math.max(1, idx - 15); b--) {
                  const prev = list[b - 1];
                  let tk: any = prev.ptr;
                  if (!truthy(tk)) tk = prev.dest === 0 ? prev.value : false;
                  if (!truthy(tk)) tk = prev.op === "loadword" ? prev.value : false;
                  if (truthy(tk) && truthy(field(text, tk))) {
                    introKey = tk;
                    break;
                  }
                }
              }

              const defeatKey = row.defeatText;
              const victoryKey = row.victoryText;
              const notEnoughKey = row.notEnoughText;

              const resolveText = (k: unknown): string | undefined => {
                if (!truthy(k) || !truthy(field(text, k))) return undefined;
                return TextIR.toPlain(field(text, k) as Seg[]);
              };

              dialogsByTrainer[tid] = {
                scriptKey,
                rematch,
                battleType: row.type,
                introKey: truthy(introKey) ? introKey : undefined,
                intro: resolveText(introKey),
                defeatKey,
                defeat: resolveText(defeatKey),
                victoryKey,
                victory: resolveText(victoryKey),
                notEnoughKey,
                notEnough: resolveText(notEnoughKey),
              };
            }
          }
        });
      }
    }

    return dialogsByTrainer;
  },

  // Lua: trainer_extract.lua:459
  extract(rom: Rom, opts: TrainerOpts = {}): TrainerPack {
    const layout = opts.layout ?? Layouts.active();
    const need = (key: string): number => {
      const v = Versions[key];
      if (!truthy(v)) throw new Error(`trainer_extract: no ${key} key`);
      return v;
    };
    const classBase = need("TRAINER_CLASS_NAMES");
    const classStride = need("TRAINER_CLASS_NAME_STRIDE");
    const classCount = need("TRAINER_CLASS_COUNT");
    const trainersBase = need("TRAINERS_TABLE");
    const stride = need("TRAINER_STRIDE");
    const trainerCount = need("TRAINERS_COUNT");
    const nameLen = layout.trainerNameLen;

    const classNames: Record<number, string> = {};
    for (let id = 0; id <= classCount - 1; id++) {
      classNames[id] = decode_name(rom, classBase + id * classStride, classStride);
    }

    let dialogsByTrainer: Record<number, DialogRow> = {};
    if (layout.inlineTrainerDialogs && truthy(opts.scripts) && truthy(opts.text)) {
      dialogsByTrainer = TrainerExtract.extractDialogs(opts.scripts, opts.text);
    }

    const trainers: Record<number, TrainerRow> = {};
    for (let id = 0; id <= trainerCount - 1; id++) {
      const off = trainersBase + id * stride;
      const partyFlags = rom.get(off);
      const klass = rom.get(off + 1);
      const encGender = rom.get(off + 2);
      const gender = encGender >= 128 ? 1 : 0;
      const encounterMusic = encGender % 128;
      const pic = rom.get(off + 3);
      const name = decode_name(rom, off + 4, nameLen);
      const items = read_items(rom, off);
      const doubleBattle = rom.get(off + 0x18) !== 0;
      const aiFlags = rom.u32(off + 0x1c);
      const partySize = rom.get(off + 0x20);
      const partyPtr = rom.u32(off + 0x24);

      const [party, lastLevel] = read_party(rom, partyFlags, partySize, partyPtr);
      const d = dialogsByTrainer[id];

      trainers[id] = {
        class: klass,
        className: classNames[klass] ?? "",
        pic,
        name,
        gender,
        encounterMusic,
        doubleBattle,
        partySize: party.length,
        partyFlags,
        lastLevel: lastLevel ?? 1,
        aiFlags,
        ai: decompose_ai_flags(aiFlags),
        items,
        party,
        dialogs: d ? { intro: d.intro, defeat: d.defeat, victory: d.victory, notEnough: d.notEnough } : {},
        scriptKey: d ? d.scriptKey : undefined,
        introTextKey: d ? d.introKey : undefined,
        defeatTextKey: d ? d.defeatKey : undefined,
        victoryTextKey: d ? d.victoryKey : undefined,
        notEnoughTextKey: d ? d.notEnoughKey : undefined,
      };
    }

    return {
      version: TrainerExtract.FORMAT_VERSION,
      classCount,
      trainerCount,
      classNames,
      trainers,
      extras: layout.trainerExtras ? TrainerExtract.extractExtras(rom) : undefined,
    };
  },

  // Lua: trainer_extract.lua:544
  backPicCount(): number {
    return Versions.TRAINER_BACK_PIC_COUNT ?? Layouts.active().trainerBackPicCount;
  },

  // Lua: trainer_extract.lua:549 (pokeemerald/src/battle_main.c:474, pokeemerald/src/battle_setup.c:260)
  extractExtras(rom: Rom): TrainerExtras {
    const x: TrainerExtras = { backPicCount: TrainerExtract.backPicCount(), money: [] };
    for (let i = 0; i <= Versions.TRAINER_MONEY_COUNT - 1; i++) {
      const off = Versions.TRAINER_MONEY_TABLE + i * Versions.TRAINER_MONEY_STRIDE;
      const classId = rom.get(off), value = rom.get(off + 1);
      if (classId === 0xff) {
        x.moneyDefault = value;
        break;
      }
      x.money.push([classId, value]);
    }
    x.facilityClassToPic = byte_list(rom, Versions.FACILITY_CLASS_TO_PIC, Versions.FACILITY_CLASS_COUNT);
    x.facilityClassToTrainerClass = byte_list(rom, Versions.FACILITY_CLASS_TO_TRAINER_CLASS,
      Versions.FACILITY_CLASS_COUNT);
    if (truthy(Versions.UNION_ROOM_FACILITY_CLASSES)) {
      x.unionRoomFacilityClasses = [];
      for (let i = 0; i <= Versions.UNION_ROOM_FACILITY_CLASS_COUNT - 1; i++) {
        x.unionRoomFacilityClasses[i] = rom.u16(Versions.UNION_ROOM_FACILITY_CLASSES + i * 2);
      }
    }
    x.rematches = [];
    for (let i = 0; i <= (Versions.REMATCH_COUNT ?? 0) - 1; i++) {
      const off = Versions.REMATCH_TABLE + i * Versions.REMATCH_STRIDE;
      const ids: number[] = [];
      for (let t = 0; t <= 4; t++) ids[t] = rom.u16(off + t * 2);
      x.rematches[i] = { trainers: ids, mapGroup: rom.u16(off + 10), mapNum: rom.u16(off + 12) };
    }
    return x;
  },

  // Lua: trainer_extract.lua:603 -- [rel, byTrainer]
  writeDialogs(cache: Cache, cacheRoot: string | undefined, scripts: any, text: any): [string, Record<number, DialogRow>] {
    cacheRoot = cacheRoot ?? default_cache_root();
    const byTrainer = TrainerExtract.extractDialogs(scripts, text);
    const rel = cacheRoot + "/" + TrainerExtract.CACHE_SUB + "/" + TrainerExtract.DIALOGS_FILE;
    cache.write(rel, dialogs_pack_to_lua(byTrainer));
    return [rel, byTrainer];
  },

  // Lua: trainer_extract.lua:611
  run(rom: Rom, cache: Cache, opts: TrainerOpts = {}): { pack: TrainerPack; root: string; frontPics: number } {
    const cacheRoot = opts.cacheRoot ?? default_cache_root();
    const root = cacheRoot + "/" + TrainerExtract.CACHE_SUB;

    const layout = Layouts.active();
    opts.layout = layout;

    // If script/text tables exist in cache or opts, load them for dialog cross-indexing
    if (layout.inlineTrainerDialogs && (!truthy(opts.scripts) || !truthy(opts.text))) {
      const scriptsSub = cacheRoot + "/scripts";
      // NOT FAITHFUL: the Lua load()s the chunk; readLuaLiteral reads the
      // same pure-data table (see asset_pack.ts).
      const loadLua = (rel: string): any => {
        const src = cache.read(rel);
        if (src === undefined) return undefined;
        try {
          return readLuaLiteral(src);
        } catch {
          return undefined;
        }
      };
      opts.scripts = truthy(opts.scripts) ? opts.scripts : loadLua(scriptsSub + "/scripts.lua");
      opts.text = truthy(opts.text) ? opts.text : loadLua(scriptsSub + "/text.lua");
    }

    const pack = TrainerExtract.extract(rom, opts);
    cache.write(cacheRoot + "/trainers.lua", pack_to_lua(pack));
    cache.write(root + "/manifest.lua", format(
      "return { version = %d, trainerCount = %d, classCount = %d }\n",
      pack.version, pack.trainerCount, pack.classCount));

    for (let gender = 0; gender <= TrainerExtract.backPicCount() - 1; gender++) {
      const rgba = bake_back_pic(rom, gender);
      if (rgba !== undefined) cache.write(root + "/back_" + gender + ".rgba", rgba);
    }

    const picCount = Versions.TRAINER_PIC_COUNT;
    if (!truthy(picCount)) throw new Error("trainer_extract: no TRAINER_PIC_COUNT key");
    let baked = 0;
    for (let picId = 0; picId <= picCount - 1; picId++) {
      const rgba = bake_front_pic(rom, picId);
      if (rgba !== undefined) {
        cache.write(root + "/front/" + picId + ".rgba", rgba);
        baked++;
      }
    }

    return { pack, root, frontPics: baked };
  },

  // Lua: trainer_extract.lua:660
  ready(cache: Cache | undefined, cacheRoot?: string): boolean {
    const root = cacheRoot ?? default_cache_root();
    if (cache && cache.exists && cache.exists(root + "/trainers.lua")) return true;
    if (cache && cache.read && cache.read(root + "/trainers.lua") !== undefined) return true;
    return false;
  },
};

export default TrainerExtract;
