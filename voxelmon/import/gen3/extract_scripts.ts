// Port of gen1recomp src/import/gba/extract_scripts.lua (GPLv3 + additional terms; see LICENSE.md).
// Write game3 script/event cache blobs from ROM MapEvents + BFS.
//
// Lua differences: byte tables are 0-based arrays (Uint8Array / number[]);
// script rows keep their positional operands under integer keys (see
// core/scripting/disasm.ts); the marts map is a Map so its number and string
// keys stay apart (see marts_extract.ts).
// NOT FAITHFUL: loadBundle reads the cache's chunks with readLuaLiteral (the
// Lua load()s them), so a chunked (serializeChunked) cache reads as missing.

import { format, tonumber, tostring, rep } from "./lua.ts";
import { luaGet, luaKeys, luaLen, type LuaKey } from "./luatable.ts";
import { Versions } from "./versions.ts";
import { GameVersion } from "./game_version.ts";
import type { Cache } from "./cache.ts";
import type { Rom } from "./rom.ts";
import { readLuaLiteral } from "./asset_pack.ts";
import { ExtractMapEvents } from "./extract_map_events.ts";
import { MapTree } from "./map_tree.ts";
import { MapCatalog } from "./map_catalog.ts";
import { MovementEmerald, type MovementTable } from "./movement_emerald.ts";
import { MartsExtract } from "./marts_extract.ts";
import { FlagsExtract } from "./flags_extract.ts";
import { TrainerExtract } from "./trainer_extract.ts";
import { Disasm, type Row } from "../../game/gen3/core/scripting/disasm.ts";
import { TextIR, type Seg } from "../../game/gen3/core/scripting/text_ir.ts";
import { Movement } from "../../game/gen3/core/scripting/movement.ts";
import { Opcodes } from "../../game/gen3/core/scripting/opcodes.ts";
import { InteractionScripts } from "../../game/gen3/core/scripting/interaction_scripts.ts";
import { Encounters } from "../../game/gen3/core/encounters.ts";
import { Marts } from "../../game/gen3/core/marts.ts";

type Tbl = Record<string, any>;

const SCRIPT_CHUNK = 8192;
const TEXT_MAX = 1024;
const MOVE_MAX = 256;
const BFS_MAX = 16000;

/** tostring(k) for a table key as Lua sees it. */
function keyString(k: LuaKey): string {
  return typeof k === "number" ? tostring(k) : k;
}

/** Lua's pairs() over a JS stand-in for a table: [key, value] pairs. */
function luaPairs(val: object): [LuaKey, unknown][] {
  if (val instanceof Map) return Array.from(val.entries()) as [LuaKey, unknown][];
  return luaKeys(val).map((k) => [k, luaGet(val, k)]);
}

// Lua: extract_scripts.lua:36
function serialize_lua(val: unknown, indent?: number): string {
  indent = indent ?? 0;
  const sp = rep("  ", indent);
  const sp1 = rep("  ", indent + 1);
  if (val === undefined || val === null) return "nil";
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "number") return tostring(val);
  if (typeof val === "string") return format("%q", val);
  if (typeof val !== "object") return "nil";
  const entries = luaPairs(val as object);
  const n = val instanceof Map ? 0 : luaLen(val as object);
  let isArr = n > 0;
  if (isArr) {
    for (const [k] of entries) {
      if (typeof k !== "number" || k < 1 || k > n || k % 1 !== 0) { isArr = false; break; }
    }
  }
  const parts = ["{\n"];
  if (isArr) {
    for (let i = 1; i <= n; i++) {
      parts.push(sp1 + serialize_lua(luaGet(val as object, i), indent + 1) + ",\n");
    }
  } else {
    entries.sort((a, b) => {
      const sa = keyString(a[0]), sb = keyString(b[0]);
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    });
    for (const [k, v] of entries) {
      let key: string;
      if (typeof k === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
        key = k;
      } else {
        key = "[" + serialize_lua(k) + "]";
      }
      parts.push(sp1 + key + " = " + serialize_lua(v, indent + 1) + ",\n");
    }
  }
  parts.push(sp + "}");
  return parts.join("");
}

// Lua: extract_scripts.lua:78
function is_rom_ptr(ptr: unknown): boolean {
  const p = tonumber(ptr) ?? 0;
  return p >= 0x08000000 && p < 0x0A000000;
}

type TextOpts = { battle?: unknown; dialect?: unknown } | undefined;

// Lua: extract_scripts.lua:83
function read_text_ir(rom: Rom, gbaPtr: number, opts: TextOpts): Seg[] | undefined {
  const off = rom.ptrOffset(gbaPtr);
  if (off === undefined) return undefined;
  const bytes: number[] = [];
  for (let i = 0; i <= TEXT_MAX - 1; i++) {
    const b = rom.get(off + i);
    bytes.push(b);
    if (b === 0xFF) break;
  }
  return TextIR.decode(bytes, opts);
}

// Lua: extract_scripts.lua:95
function text_opts(battle: boolean): TextOpts {
  const dialect = TextIR.dialectOf(Opcodes.active().game);
  if (dialect === TextIR.DEFAULT_DIALECT) {
    return battle ? { battle: true } : undefined;
  }
  return { battle: battle || undefined, dialect };
}

// Lua: extract_scripts.lua:103
function table_key(name: string, i: number, inner?: number): string {
  if (inner) {
    return format("%s[%d][%d]", name, Math.floor(i / inner), i % inner);
  }
  return format("%s[%d]", name, i);
}

// src/battle_message.c:517, include/constants/battle_string_ids.h:393
// Lua: extract_scripts.lua:111
function extract_text_tables(rom: Rom, text: Tbl): Tbl {
  const counts: Tbl = {};
  const battle = text_opts(true);
  const plain = text_opts(false);
  const tables = Versions.TEXT_TABLES;
  for (let ti = 1; ti <= luaLen(tables); ti++) {
    const t = luaGet(tables, ti) as Tbl;
    const slots = t.count * (t.inner ?? 1);
    for (let i = 0; i <= slots - 1; i++) {
      let key: string;
      if (t.ids !== undefined && t.ids !== null) {
        key = Versions.BATTLE_STRING_IDS[i + t.ids];
        if (!key) throw new Error(t.name + " has no string id for " + tostring(i));
      } else {
        key = table_key(t.name, i, t.inner);
      }
      let ir: Seg[] | undefined;
      if (t.inline) {
        ir = read_text_ir(rom, 0x08000000 + t.addr + i * t.stride, plain);
        if (!ir) throw new Error("ROM text " + key + " is not readable");
      } else {
        const ptr = rom.u32(t.addr + i * t.stride);
        if (ptr !== 0) {
          if (rom.ptrOffset(ptr) === undefined) throw new Error(format("%s entry is not a ROM pointer (0x%08X)", key, ptr));
          ir = read_text_ir(rom, ptr, t.battle ? battle : plain);
        }
      }
      text[key] = ir;
    }
    counts[t.name] = t.inner ? [t.count, t.inner] : t.count;
  }
  return counts;
}

// pokefirered/include/characters.h:285
const BRAILLE_CHARMAP: Record<number, string> = {
  [0x00]: " ",
  [0x01]: "A", [0x03]: "C", [0x04]: ",", [0x05]: "B", [0x06]: "I",
  [0x07]: "F", [0x09]: "E", [0x0B]: "D", [0x0C]: ":", [0x0D]: "H",
  [0x0E]: "J", [0x0F]: "G", [0x10]: "'", [0x11]: "K", [0x12]: "/",
  [0x13]: "M", [0x14]: ";", [0x15]: "L", [0x16]: "S", [0x17]: "P",
  [0x19]: "O", [0x1B]: "N", [0x1C]: "!", [0x1D]: "R", [0x1E]: "T",
  [0x1F]: "Q", [0x2C]: ".", [0x2E]: "W", [0x30]: "-", [0x31]: "U",
  [0x33]: "X", [0x34]: "?", [0x35]: "V", [0x38]: '"', [0x39]: "Z",
  [0x3A]: "#", [0x3B]: "Y", [0x3C]: "(",
};

// Lua: extract_scripts.lua:155 -- bytes 0-based
function decode_braille(bytes: ArrayLike<number>): Seg[] {
  const out: Seg[] = [];
  let buf: string[] = [];
  const flush = (): void => {
    if (buf.length > 0) {
      out.push({ t: "text", s: buf.join("") });
      buf = [];
    }
  };
  const n = bytes.length;
  for (let i = 0; i < n; i++) {
    const c = bytes[i]!;
    if (c === 0xFF) {
      flush();
      out.push({ t: "eos" });
      break;
    } else if (c === 0xFE) {
      flush();
      out.push({ t: "nl" });
    } else {
      buf.push(BRAILLE_CHARMAP[c] ?? "?");
    }
  }
  flush();
  return out;
}

// Lua: extract_scripts.lua:181
function read_braille_ir(rom: Rom, gbaPtr: number, skip?: number): Seg[] | undefined {
  let off = rom.ptrOffset(gbaPtr);
  if (off === undefined) return undefined;
  off = off + (skip ?? 0);
  const bytes: number[] = [];
  for (let i = 0; i <= TEXT_MAX - 1; i++) {
    const b = rom.get(off + i);
    bytes.push(b);
    if (b === 0xFF) break;
  }
  return decode_braille(bytes);
}

// Lua: extract_scripts.lua:198
function read_movement(rom: Rom, gbaPtr: number, mv: MovementTable | undefined, unknownMoves: Record<number, number>): number[] | undefined {
  const off = rom.ptrOffset(gbaPtr);
  if (off === undefined) return undefined;
  const bytes = rom.readBytes(off, MOVE_MAX);
  let out = Disasm.decodeMovement(bytes, 1);
  if (mv) {
    let unknown: number[] | undefined;
    [out, unknown] = mv.translate(out);
    for (const b of unknown ?? []) {
      unknownMoves[b] = (unknownMoves[b] ?? 0) + 1;
    }
  }
  return out;
}

// Lua: extract_scripts.lua:213
function movement_table(game: string): MovementTable | undefined {
  if (GameVersion.layout(game) === "rse") {
    return MovementEmerald.forGame(game);
  }
  return undefined;
}

// Lua: extract_scripts.lua:220
function data_label_stop(game: string): ((off: number) => boolean) | undefined {
  if (Versions.GAME !== game || !Versions.SYMS) return undefined;
  const S = Versions.SYMS;
  return (off: number): boolean => {
    const names: string[] = S.namesAt(off);
    if (names.length === 0) return false;
    let data = false;
    for (const n of names) {
      if (n.includes("Script")) return false;
      if (n.includes("Movement") || n.includes("Text")) data = true;
    }
    return data;
  };
}

export interface BfsResult {
  scripts: Record<string, Row[]>;
  text: Record<string, Seg[] | undefined>;
  movements: Record<string, number[] | undefined>;
  marts: Map<number | string, Tbl>;
  opInventory: Record<string, number>;
  specialInventory: Record<number, number>;
  scriptCount: number;
  unknownOps: number;
  unknownMoves: Record<number, number>;
  stoppedAtData: number;
}

export interface ScriptBundle {
  labels?: Record<string, string>;
  events: Record<string, any>;
  scripts: Record<string, Row[]>;
  text: Record<string, Seg[] | undefined>;
  textTables?: Tbl;
  movements: Record<string, number[] | undefined>;
  marts: Map<number | string, Tbl>;
  opInventory?: Record<string, number>;
  specialInventory?: Record<number, number>;
  seedCount?: number;
  scriptCount?: number;
  unknownOps: number;
  unknownMoves: Record<number, number>;
  stoppedAtData?: number;
  fromRom?: boolean;
  martListCount?: number;
  [k: string]: unknown;
}

const CHUNK_ENTRIES = 256;

// Lua: extract_scripts.lua:473
function serialize_chunked(val: object): string {
  const keys = luaKeys(val);
  keys.sort((a, b) => {
    const sa = keyString(a), sb = keyString(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });
  const parts = ["local T = {}\n"];
  for (let i = 1; i <= keys.length; i += CHUNK_ENTRIES) {
    parts.push("do (function(T)\n");
    for (let j = i; j <= Math.min(i + CHUNK_ENTRIES - 1, keys.length); j++) {
      const k = keys[j - 1]!;
      parts.push("T[" + serialize_lua(k) + "] = " + serialize_lua(luaGet(val, k), 1) + "\n");
    }
    parts.push("end)(T) end\n");
  }
  parts.push("return T\n");
  return parts.join("");
}

interface MetaExtra {
  source?: string;
  opInventory?: Record<string, number>;
  textTables?: Tbl;
  labels?: Record<string, string>;
  movement?: string;
  chunked?: boolean;
}

// Lua: extract_scripts.lua:492
function write_tables(cache: Cache, root: string | undefined, scripts: object, text: object, movements: object,
  events: object, metaExtra?: MetaExtra): boolean {
  root = root ?? "data/generated/gba";
  const base = root + "/" + ExtractScripts.CACHE_SUB;
  const put = (name: string, val: object): void => {
    if (metaExtra && metaExtra.chunked) {
      cache.write(base + "/" + name, serialize_chunked(val));
    } else {
      cache.write(base + "/" + name, "return " + serialize_lua(val) + "\n");
    }
  };
  put("scripts.lua", scripts);
  put("text.lua", text);
  if (metaExtra && metaExtra.textTables) {
    cache.write(base + "/text_tables.lua", "return " + serialize_lua(metaExtra.textTables) + "\n");
  }
  put("movements.lua", movements);
  put("events.lua", events);
  if (metaExtra && metaExtra.labels) {
    put("labels.lua", metaExtra.labels);
  }
  const meta: { cache_version: number; kind: string; source: string; maps: string[]; ops?: string[] } = {
    cache_version: Versions.CACHE_VERSION,
    kind: "game3",
    source: (metaExtra && metaExtra.source) || "rom",
    maps: [],
  };
  for (const mapId of luaKeys(events ?? {})) {
    meta.maps.push(mapId as string);
  }
  meta.maps.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (metaExtra && metaExtra.opInventory) {
    // Compact inventory for smoke / ISA growth tracking.
    const inv: string[] = [];
    for (const op of Object.keys(metaExtra.opInventory)) {
      inv.push(format("%s:%d", op, metaExtra.opInventory[op]));
    }
    inv.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    meta.ops = inv;
  }
  const parts = ["{"];
  parts.push(format('"cache_version":%d', meta.cache_version));
  parts.push(format(',"kind":%q', meta.kind));
  parts.push(format(',"source":%q', meta.source));
  parts.push(',"maps":[');
  meta.maps.forEach((m, i) => {
    if (i > 0) parts.push(",");
    parts.push(format("%q", m));
  });
  parts.push("]");
  if (meta.ops) {
    parts.push(',"ops":[');
    meta.ops.forEach((o, i) => {
      if (i > 0) parts.push(",");
      parts.push(format("%q", o));
    });
    parts.push("]");
  }
  if (metaExtra && metaExtra.movement) {
    parts.push(format(',"movement":%q', metaExtra.movement));
  }
  parts.push("}\n");
  cache.write(base + "/meta.json", parts.join(""));
  return true;
}

export const ExtractScripts = {
  CACHE_SUB: "scripts",

  REQUIRED: [
    "scripts/scripts.lua",
    "scripts/text.lua",
    "scripts/text_tables.lua",
    "scripts/movements.lua",
    "scripts/events.lua",
    "scripts/meta.json",
    "scripts/marts.lua",
    "scripts/labels.lua",
    "trainers/dialogs.lua",
  ],

  BRAILLE_CHARMAP,
  decodeBraille: decode_braille,
  movementTable: movement_table,
  serializeChunked: serialize_chunked,
  serialize_lua,
  Disasm,
  TextIR,
  Movement,

  /**
   * BFS disasm from seed GBA pointers → scripts / text / movements tables.
   * Annotates IR so goto/call/message/applymovement use stable keys.
   */
  // Lua: extract_scripts.lua:239
  bfsFromSeeds(rom: Rom, seedPtrs?: ArrayLike<number>): BfsResult {
    const scripts: Record<string, Row[]> = {}, text: Record<string, Seg[] | undefined> = {};
    const movements: Record<string, number[] | undefined> = {};
    const marts = new Map<number | string, Tbl>();
    const opInventory: Record<string, number> = {}, specialInventory: Record<number, number> = {};
    const unknownMoves: Record<number, number> = {};
    let stoppedAtData = 0;
    // NOT FAITHFUL (cost only): the Lua pops with table.remove(queue, 1);
    // here a head index walks the same FIFO.
    const queue: number[] = [];
    let head = 0;
    const queued = new Set<number>();
    const enqueue = (p: unknown): void => {
      const ptr = tonumber(p) ?? 0;
      if (!is_rom_ptr(ptr)) return;
      if (queued.has(ptr)) return;
      queued.add(ptr);
      queue.push(ptr);
    };
    if (seedPtrs) for (let s = 0; s < seedPtrs.length; s++) enqueue(seedPtrs[s]);
    const opset = Opcodes.active();
    const mv = movement_table(opset.game);
    const stopAt = data_label_stop(opset.game);
    const textOpts = text_opts(false);
    const read_text = (ptr: number): Seg[] | undefined => read_text_ir(rom, ptr, textOpts);
    const read_move = (ptr: number): number[] | undefined => read_movement(rom, ptr, mv, unknownMoves);

    let processed = 0;
    while (queue.length - head > 0 && processed < BFS_MAX) {
      const ptr = queue[head++]!;
      processed = processed + 1;
      const key = Opcodes.key(ptr);
      if (scripts[key]) continue;
      const off = rom.ptrOffset(ptr);
      if (off === undefined) continue;
      const bytes = rom.readBytes(off, SCRIPT_CHUNK);
      const rows: Row[] = [];
      let i = 1;
      let guard = 0;
      while (i <= bytes.length && guard < 4096) {
        guard = guard + 1;
        if (i > 1 && stopAt && stopAt(off + i - 1)) {
          stoppedAtData = stoppedAtData + 1;
          break;
        }
        let row: Row;
        [row, i] = Disasm.decodeOne(bytes, i, opset);
        opInventory[row.op] = (opInventory[row.op] ?? 0) + 1;
        if (row.op === "special" || row.op === "specialvar") {
          const id = row.id ?? row[1];
          if (id !== undefined && id !== null) specialInventory[id] = (specialInventory[id] ?? 0) + 1;
        }
        if (row.op === "unknown" || (row.op === "trainerbattle" && row.opaque)) {
          rows.push(row);
          break;
        }
        // Remap pointer operands to keys + enqueue.
        if (row.target !== undefined && row.target !== null && is_rom_ptr(row.target)) {
          enqueue(row.target);
          row.target = Opcodes.key(row.target);
        }
        if (row.op === "trainerbattle") {
          // Remap embedded text / continue-script pointers; keep scanning so
          // the post-battle ret addr (e.g. goto EndRivalBattle) is enqueued.
          for (const field of ["introText", "defeatText", "victoryText", "notEnoughText", "eventScript"]) {
            const tp = row[field];
            if (is_rom_ptr(tp)) {
              const tk = Opcodes.key(tp);
              if (field === "eventScript") {
                enqueue(tp);
              } else if (!text[tk]) {
                text[tk] = read_text(tp);
              }
              row[field] = tk;
            }
          }
        } else if (row.op === "goto" || row.op === "call" || row.op === "goto_if"
          || row.op === "call_if" || row.op === "vgoto" || row.op === "vcall"
          || row.op === "vgoto_if" || row.op === "vcall_if") {
          // target already remapped
        } else if (row.op === "braillemessage" || row.op === "getbraillestringwidth") {
          // pokefirered/asm/macros/event.inc:1845
          const tp = row.ptr ?? row[1];
          if (is_rom_ptr(tp)) {
            const tk = Opcodes.key(tp);
            // pokeemerald/src/scrcmd.c:1494
            const ir = read_braille_ir(rom, tp, row.op === "braillemessage" ? opset.brailleFormatSize : 0);
            if (ir) text[tk] = ir;
            row.ptr = tk;
            row[1] = tk;
          }
        } else if (row.op === "message" || row.op === "vmessage"
          || row.op === "messageautoscroll" || row.op === "messageinstant"
          || row.op === "pokenavcall") {
          const tp = row.ptr ?? row[1];
          if (is_rom_ptr(tp)) {
            const tk = Opcodes.key(tp);
            if (!text[tk]) text[tk] = read_text(tp);
            row.ptr = tk;
            row[1] = tk;
          }
        } else if (row.op === "loadword") {
          const val = row.value ?? row[2];
          if (is_rom_ptr(val)) {
            const tk = Opcodes.key(val);
            if (!text[tk]) text[tk] = read_text(val);
            row.value = tk;
            row[2] = tk;
          }
        } else if (row.op === "bufferstring") {
          const spv = row.src ?? row[2];
          if (is_rom_ptr(spv)) {
            const tk = Opcodes.key(spv);
            if (!text[tk]) text[tk] = read_text(spv);
            row.src = tk;
            row[2] = tk;
          }
        } else if (row.op === "applymovement" || row.op === "applymovementat") {
          const mp = row.movement ?? row[2];
          if (is_rom_ptr(mp)) {
            const mk = Opcodes.key(mp);
            if (!movements[mk]) movements[mk] = read_move(mp);
            row.movement = mk;
            row[2] = mk;
          }
        } else if (row.op === "pokemart" || row.op === "pokemartdecoration"
          || row.op === "pokemartdecoration2") {
          MartsExtract.remapRow(rom, row, marts);
        }
        rows.push(row);
        if (row.op === "end" || row.op === "return") {
          break;
        }
      }
      scripts[key] = rows;
    }
    const left = queue.length - head;
    if (left !== 0) throw new Error("script BFS stopped at BFS_MAX with " + tostring(left) + " scripts queued");

    let unknownOps = opInventory.unknown ?? 0;
    for (const k of Object.keys(scripts)) {
      const rows = scripts[k]!;
      const last = rows[rows.length - 1];
      if (last && last.op === "trainerbattle" && last.opaque) unknownOps = unknownOps + 1;
    }

    return {
      scripts,
      text,
      movements,
      marts,
      opInventory,
      specialInventory,
      scriptCount: processed,
      unknownOps,
      unknownMoves,
      stoppedAtData,
    };
  },

  // Lua: extract_scripts.lua:399
  extractFromRom(rom: Rom, version?: any): ScriptBundle {
    const [events, seeds] = ExtractMapEvents.extractIsland1(rom, version);
    const aliases: Record<string, string> = {};
    // data/event_scripts.s:77
    for (let i = 0; i <= Versions.STD_SCRIPTS_COUNT - 1; i++) {
      const ptr = rom.u32(Versions.STD_SCRIPTS + i * 4);
      if (rom.ptrOffset(ptr) === undefined) throw new Error("gStdScripts entry " + tostring(i) + " is not a ROM pointer");
      seeds.push(ptr);
      aliases["std:" + tostring(i)] = Opcodes.key(ptr);
    }
    // data/scripts/pc.inc:1
    // NOT FAITHFUL (order): pairs() order in the Lua; only the seed order
    // changes, which the BFS output does not depend on.
    const named = Versions.NAMED_SCRIPTS ?? {};
    for (const name of Object.keys(named)) {
      const ptr = 0x08000000 + named[name];
      seeds.push(ptr);
      aliases[name] = Opcodes.key(ptr);
    }
    let extraSeeds = Versions.SEED_SCRIPTS;
    if (typeof extraSeeds === "function") extraSeeds = extraSeeds();
    if (extraSeeds) {
      for (let i = 1; i <= luaLen(extraSeeds); i++) {
        seeds.push(0x08000000 + (luaGet(extraSeeds, i) as number));
      }
    }
    const bfs = ExtractScripts.bfsFromSeeds(rom, seeds);
    const scripts: Record<string, Row[]> = {};
    for (const k of Object.keys(bfs.scripts)) scripts[k] = bfs.scripts[k]!;
    for (const name of Object.keys(aliases)) {
      const s = scripts[aliases[name]!];
      if (!s) throw new Error("ROM script " + name + " was not extracted");
      scripts[name] = s;
    }
    const text: Record<string, Seg[] | undefined> = {};
    for (const k of Object.keys(bfs.text)) text[k] = bfs.text[k];
    const namedTexts = Versions.NAMED_TEXTS;
    for (const name of Object.keys(namedTexts)) {
      const ir = read_text_ir(rom, 0x08000000 + namedTexts[name], text_opts(false));
      if (!ir) throw new Error("ROM text " + name + " is not readable");
      text[name] = ir;
    }
    const namedBattle = Versions.NAMED_BATTLE_TEXTS;
    for (const name of Object.keys(namedBattle)) {
      const ir = read_text_ir(rom, 0x08000000 + namedBattle[name], text_opts(true));
      if (!ir) throw new Error("ROM text " + name + " is not readable");
      text[name] = ir;
    }
    const textTables = extract_text_tables(rom, text);
    // src/script_menu.c:574
    for (let i = 0; i <= Versions.STD_STRING_COUNT - 1; i++) {
      const ptr = rom.u32(Versions.STD_STRING_PTRS + i * 4);
      const ir = read_text_ir(rom, ptr, text_opts(false));
      if (!ir) throw new Error("gStdStringPtrs entry " + tostring(i) + " is not a ROM pointer");
      text["stdstring:" + tostring(i)] = ir;
    }
    const movements: Record<string, number[] | undefined> = {};
    for (const k of Object.keys(bfs.movements)) movements[k] = bfs.movements[k];
    let labels: Record<string, string> | undefined;
    if (typeof Versions.SCRIPT_LABELS === "function") {
      labels = {};
      const rows = Versions.SCRIPT_LABELS();
      for (let i = 1; i <= luaLen(rows); i++) {
        const row = luaGet(rows, i) as Tbl;
        const key = Opcodes.key(0x08000000 + row.off);
        if (scripts[key]) labels[row.name] = key;
      }
    }
    return {
      labels,
      events,
      scripts,
      text,
      textTables,
      movements,
      marts: bfs.marts ?? new Map(),
      opInventory: bfs.opInventory,
      specialInventory: bfs.specialInventory,
      seedCount: seeds.length,
      scriptCount: bfs.scriptCount,
      unknownOps: bfs.unknownOps,
      unknownMoves: bfs.unknownMoves,
      stoppedAtData: bfs.stoppedAtData,
      fromRom: true,
    };
  },

  /** Primary write path: ROM MapEvents + BFS. */
  // Lua: extract_scripts.lua:558
  writeBundleFromRom(rom: Rom, cache: Cache, root: string | undefined, version: any, extracted?: ScriptBundle,
    opts?: { movement?: string; chunked?: boolean; skipFlags?: boolean }): ScriptBundle {
    const bundle = extracted ?? ExtractScripts.extractFromRom(rom, version);
    if (!bundle.textTables) throw new Error("ROM text tables were not extracted");
    write_tables(cache, root, bundle.scripts, bundle.text, bundle.movements, bundle.events, {
      source: "rom",
      opInventory: bundle.opInventory,
      textTables: bundle.textTables,
      labels: bundle.labels,
      movement: opts && opts.movement,
      chunked: opts && opts.chunked,
    });
    {
      let marts: Map<number | string, Tbl> | undefined = bundle.marts;
      if (!marts || marts.size === 0) {
        marts = MartsExtract.build(rom, bundle.scripts)[0];
      }
      let n = 0;
      const seen = new Set<unknown>();
      for (const [k, e] of marts ?? new Map()) {
        if (typeof k === "number" && e && !seen.has(e.ptr)) {
          seen.add(e.ptr);
          n = n + 1;
        }
      }
      MartsExtract.write(cache, root, marts, { count: n });
      bundle.martListCount = n;
    }
    if (!(opts && opts.skipFlags)) {
      FlagsExtract.write(cache, root);
    }
    return bundle;
  },

  // Lua: extract_scripts.lua:592 -- [headers, n, map_count]
  headersFromCensus(rom: Rom, version: any): [Record<string, number>, number, number] {
    const [census, err] = MapTree.walk(rom, version);
    if (!census) throw new Error("scripts: map census failed: " + tostring(err));
    const headers: Record<string, number> = {};
    let n = 0;
    for (const entry of census.maps) {
      const id = MapCatalog.mapIdFor(entry.group, entry.num) ?? MapCatalog.pretToEngine(entry.pretName);
      const header = (entry as Tbl).header;
      if (id && header && header.headerOff !== undefined && header.headerOff !== null) {
        headers[id] = header.headerOff;
        n = n + 1;
      }
    }
    return [headers, n, census.map_count];
  },

  // Lua: extract_scripts.lua:608
  run(rom: Rom, cache: Cache, opts: { cacheRoot?: string; version?: any; strict?: boolean } = {}): Tbl {
    const root = opts.cacheRoot ?? "data/generated/gba";
    const [headers, n, total] = ExtractScripts.headersFromCensus(rom, opts.version);
    if (n !== total) {
      throw new Error(format("scripts: %d of %d map headers resolved", n, total));
    }
    const bundle = ExtractScripts.extractFromRom(rom, { map_headers: headers });
    let badMoves = 0;
    for (const k of Object.keys(bundle.unknownMoves ?? {})) badMoves = badMoves + bundle.unknownMoves[Number(k)]!;
    if (opts.strict !== false && (bundle.unknownOps > 0 || badMoves > 0)) {
      throw new Error(format("scripts: %d unknown opcodes, %d untranslated movement bytes",
        bundle.unknownOps, badMoves));
    }
    ExtractScripts.writeBundleFromRom(rom, cache, root, undefined, bundle, {
      skipFlags: true,
      movement: "canonical",
      chunked: true,
    });
    TrainerExtract.writeDialogs(cache, root, bundle.scripts, bundle.text);
    return {
      maps: n,
      seedCount: bundle.seedCount,
      scriptCount: bundle.scriptCount,
      unknownOps: bundle.unknownOps,
      unknownMoves: badMoves,
      stoppedAtData: bundle.stoppedAtData,
    };
  },

  // Lua: extract_scripts.lua:638
  ready(cache: Cache, cacheRoot?: string): boolean {
    const root = cacheRoot ?? "data/generated/gba";
    for (const rel of ExtractScripts.REQUIRED) {
      if (!cache.exists(root + "/" + rel)) return false;
    }
    const meta = cache.read(root + "/" + ExtractScripts.CACHE_SUB + "/meta.json");
    if (typeof meta !== "string") return false;
    const m = /"cache_version":(\d+)/.exec(meta);
    return (m ? tonumber(m[1]) : undefined) === Versions.CACHE_VERSION
      && meta.includes('"movement":"canonical"');
  },

  /** Cache contract: ready extract has events+scripts+text. [ok, why] */
  // Lua: extract_scripts.lua:650
  bundleReady(bundle: Tbl | undefined): [boolean, string?] {
    if (!bundle) return [false, "nil bundle"];
    if (!bundle.scripts || luaKeys(bundle.scripts).length === 0) {
      return [false, "missing scripts"];
    }
    if (!bundle.events || luaKeys(bundle.events).length === 0) {
      return [false, "missing events"];
    }
    if (!bundle.text) {
      return [false, "missing text"];
    }
    return [true];
  },

  // Lua: extract_scripts.lua:664 -- [bundle] or [undefined, why]
  loadBundle(cache: Cache, root?: string, opts: { allowIncomplete?: boolean; strict?: boolean } = {}): [Tbl | undefined, string?] {
    root = root ?? "data/generated/gba";
    const base = root + "/" + ExtractScripts.CACHE_SUB;
    const load_lua = (rel: string): any => {
      const src = cache.read(rel);
      if (src === undefined) return undefined;
      try {
        return readLuaLiteral(src);
      } catch {
        return undefined;
      }
    };
    const scripts = load_lua(base + "/scripts.lua");
    let text = load_lua(base + "/text.lua");
    let movements = load_lua(base + "/movements.lua");
    const events = load_lua(base + "/events.lua");
    const textTables = load_lua(base + "/text_tables.lua");
    if (scripts && events) {
      const objects = load_lua(root + "/objects/pack.lua");
      InteractionScripts.install(objects);
      Encounters.installEncounterTypes(objects && objects.encounterTypes);
      if (objects) {
        text = text ?? {}; movements = movements ?? {};
        for (const [k, v] of luaPairs(objects.scripts ?? {})) scripts[k] = v;
        for (const [k, v] of luaPairs(objects.text ?? {})) text[k] = v;
        for (const [k, v] of luaPairs(objects.movements ?? {})) movements[k] = v;
      }
      const bundle: Tbl = {
        scripts,
        text: text ?? {},
        textTables,
        movements: movements ?? {},
        events,
        fromCache: true,
      };
      {
        const n = Marts.load(cache, root);
        bundle.martListCount = n;
      }
      const [ok, why] = ExtractScripts.bundleReady(bundle);
      if (!ok && !opts.allowIncomplete) {
        if (opts.strict) {
          return [undefined, why];
        }
      }
      return [bundle];
    }
    return [undefined, "extract cache missing"];
  },
};

export { serialize_lua };
export default ExtractScripts;
