// Port of gen1recomp src/core/SaveSerializer.lua (GPLv3 + additional terms; see LICENSE.md).
// Save-file serialization: the deterministic Lua-source writer and the
// restricted-grammar reader that replaces load() on save bytes. The writer
// is the grammar's specification -- literals, %q strings and keyed tables
// only -- so a tampered save fails to parse instead of executing.
//
// KEY TYPES. A Lua table can hold 2048 and "2048" as two keys (the engine
// does: Flags.setFlag writes flags[id] AND flags[tostring(id)];
// Rules.newGameFlags writes hide[tostring(id)] only; vars may carry a legacy
// "16464" beside 16464), and the writer spells them differently ([2048] vs
// ["2048"]). A JS object has one property "2048", and lt.ts's pairs()
// reports it as the number 2048. To stay byte-identical with gen1recomp both
// ways, every decoded table carries a hidden key record (LUA_KEYS, a
// non-enumerable symbol):
//   strOnly  -- integer-looking keys whose only entry is a STRING key;
//   twins    -- integer-looking keys that ALSO have a string entry: the
//               property holds the number side, twins holds the string side;
//   numKeys  -- number keys whose property name is not integer-shaped
//               (floats, huge numbers), so pairs() would read them as strings.
// encode() reads the record; tables without one encode integer-looking keys
// as numbers (the lt.ts rule). Code that must write one side only uses the
// helpers below (setStrKey / setNumKey / getStrKey / getNumKey), which
// behave like Lua's t["k"] = v / t[k] = v on such a table. A plain JS write
// to the property edits whichever side the property holds; a plain delete
// removes both sides (as the engine's "clear both" writers do).

import { format, tostring, tonumber } from "../../../../import/gen3/lua.ts";
import { pairs } from "../../platform/lt.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The hidden per-table key record (see the header). */
export const LUA_KEYS: unique symbol = Symbol("luaKeys") as any;

export interface KeyRecord {
  strOnly: Set<string>;
  twins: Map<string, unknown>;
  numKeys: Set<string>;
}

const INT_KEY = /^(0|-?[1-9]\d*)$/;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function record(t: any, create: boolean): KeyRecord | undefined {
  let rec: KeyRecord | undefined = t[LUA_KEYS];
  if (!rec && create) {
    rec = { strOnly: new Set(), twins: new Map(), numKeys: new Set() };
    Object.defineProperty(t, LUA_KEYS, { value: rec, enumerable: false, configurable: true, writable: true });
  }
  return rec;
}

function propName(k: number | string): string {
  return typeof k === "number" ? String(k) : k;
}

/** Lua `t["k"] = v` (the string key) on a table that may also hold the number key k. */
export function setStrKey(t: any, key: number | string, v: unknown): void {
  const k = String(key);
  const rec = record(t, true)!;
  const present = Object.prototype.hasOwnProperty.call(t, k) && t[k] != null;
  if (v == null) {
    if (rec.twins.has(k)) rec.twins.delete(k);
    else if (rec.strOnly.has(k)) { delete t[k]; rec.strOnly.delete(k); }
    return;
  }
  if (rec.twins.has(k)) rec.twins.set(k, v);
  else if (rec.strOnly.has(k)) t[k] = v;
  else if (present) rec.twins.set(k, v);
  else { t[k] = v; rec.strOnly.add(k); }
}

/** Lua `t[k] = v` (the number key) on a table that may also hold the string key "k". */
export function setNumKey(t: any, key: number, v: unknown): void {
  const k = propName(key);
  const rec = record(t, true)!;
  if (v == null) {
    if (rec.twins.has(k)) { t[k] = rec.twins.get(k); rec.twins.delete(k); rec.strOnly.add(k); }
    else if (!rec.strOnly.has(k)) { delete t[k]; rec.numKeys.delete(k); }
    return;
  }
  const present = Object.prototype.hasOwnProperty.call(t, k) && t[k] != null;
  if (rec.strOnly.has(k) && present) { rec.twins.set(k, t[k]); rec.strOnly.delete(k); }
  else rec.strOnly.delete(k);
  if (!INT_KEY.test(k)) rec.numKeys.add(k);
  t[k] = v;
}

/** Lua `t["k"]`. */
export function getStrKey(t: any, key: number | string): unknown {
  const k = String(key);
  const rec = record(t, false);
  if (rec && rec.twins.has(k)) return t[k] != null ? rec.twins.get(k) : undefined;
  if (rec && rec.strOnly.has(k)) return t[k];
  if (!INT_KEY.test(k) && !(rec && rec.numKeys.has(k))) return t[k];
  return undefined;
}

/** Lua `t[k]` for a number k. */
export function getNumKey(t: any, key: number): unknown {
  const k = propName(key);
  const rec = record(t, false);
  if (rec && rec.strOnly.has(k)) return undefined;
  return t[k];
}

// ------------------------------------------------------------ writer

function luaType(v: unknown): string {
  if (v == null) return "nil";
  if (typeof v === "object") return "table";
  return typeof v;
}

type Entry = { k: number | string; v: unknown };

// The table's Lua entries, with their Lua key types.
function entries(v: any): Entry[] {
  const out: Entry[] = [];
  if (v instanceof Map) {
    for (const [k, x] of v) if (x != null) out.push({ k, v: x });
    return out;
  }
  const rec: KeyRecord | undefined = v[LUA_KEYS];
  for (const [k, x] of pairs(v)) {
    const name = propName(k);
    if (rec && rec.strOnly.has(name)) { out.push({ k: name, v: x }); continue; }
    if (typeof k === "string" && rec && rec.numKeys.has(name)) {
      out.push({ k: Number(name), v: x });
    } else {
      out.push({ k, v: x });
    }
    if (rec && rec.twins.has(name)) {
      const tv = rec.twins.get(name);
      if (tv != null) out.push({ k: name, v: tv });
    }
  }
  return out;
}

// Lua: SaveSerializer.lua:12
function serialize(v: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  const t = luaType(v);
  if (t === "number" || t === "boolean") {
    return tostring(v);
  } else if (t === "string") {
    return format("%q", v);
  } else if (t === "table") {
    const list = entries(v);
    list.sort((a, b) => {
      const ta = typeof a.k, tb = typeof b.k;
      if (ta !== tb) return ta < tb ? -1 : 1;
      return a.k < b.k ? -1 : a.k > b.k ? 1 : 0;
    });
    if (list.length === 0) return "{}";
    const parts: string[] = [];
    for (const { k, v: x } of list) {
      let key: string;
      if (typeof k === "string" && IDENT.test(k)) {
        key = k;
      } else {
        key = "[" + serialize(k) + "]";
      }
      parts.push(pad + "  " + key + " = " + serialize(x, indent + 1));
    }
    return "{\n" + parts.join(",\n") + ",\n" + pad + "}";
  }
  throw new Error("cannot serialize " + t);
}

// ------------------------------------------------------------ reader

// Lua: SaveSerializer.lua:59
const ESCAPES: Record<string, string> = {
  '"': '"', "\\": "\\", n: "\n", r: "\r", t: "\t",
  a: "\x07", b: "\b", f: "\f", v: "\v",
  "\n": "\n", "\r": "\n",
};

// Lua: SaveSerializer.lua:67
const MAX_DEPTH = 128;

export interface DecodeLimits {
  maxBytes?: number; maxNodes?: number; maxDepth?: number; maxStringBytes?: number;
  maxTableEntries?: number; allowComments?: boolean; allowArray?: boolean; rootName?: string;
}
interface DecodeState { src: string; pos: number; depth: number; nodes: number; limits?: DecodeLimits }

class ParseError extends Error {}

// Lua: SaveSerializer.lua:69 (pos is 1-based, as the Lua reports it)
function fail(state: DecodeState, why: string): never {
  throw new ParseError(format("parse error at byte %d: %s", state.pos, why));
}

// Lua: SaveSerializer.lua:73
function limit(state: DecodeState, name: keyof DecodeLimits): any {
  return state.limits ? state.limits[name] : undefined;
}

// Lua: SaveSerializer.lua:77
function bumpNode(state: DecodeState): void {
  state.nodes = state.nodes + 1;
  const maximum = limit(state, "maxNodes");
  if (maximum && state.nodes > maximum) fail(state, "too many values");
}

function isWs(c: string): boolean { return c === " " || c === "\t" || c === "\r" || c === "\n"; }
function isAlpha(c: string): boolean { return /^[A-Za-z_]$/.test(c); }

// Lua: SaveSerializer.lua:83
function skip(state: DecodeState): void {
  const s = state.src;
  for (;;) {
    let p = state.pos - 1;
    while (p < s.length && isWs(s[p]!)) p++;
    state.pos = p + 1;
    if (!(state.limits && state.limits.allowComments && s.substr(state.pos - 1, 2) === "--")) return;
    const nl = s.indexOf("\n", state.pos + 1);
    state.pos = nl >= 0 ? nl + 2 : s.length + 1;
  }
}

// Lua: SaveSerializer.lua:96
function peek(state: DecodeState): string {
  return state.src.charAt(state.pos - 1);
}

// Lua: SaveSerializer.lua:100
function readString(state: DecodeState): string {
  const src = state.src;
  const out: string[] = [];
  let i = state.pos + 1;
  for (;;) {
    const c = src.charAt(i - 1);
    if (c === "") {
      state.pos = i;
      fail(state, "unterminated string");
    } else if (c === '"') {
      state.pos = i + 1;
      const value = out.join("");
      const maximum = limit(state, "maxStringBytes");
      if (maximum && value.length > maximum) fail(state, "string too long");
      return value;
    } else if (c === "\\") {
      const nxt = src.charAt(i);
      if (nxt !== "" && nxt >= "0" && nxt <= "9") {
        const digits = /^\d{1,3}/.exec(src.slice(i))![0];
        const code = Number(digits);
        if (code > 255) {
          state.pos = i;
          fail(state, "escape out of range");
        }
        out.push(String.fromCharCode(code));
        i = i + 1 + digits.length;
      } else if (nxt !== "" && ESCAPES[nxt] !== undefined) {
        out.push(ESCAPES[nxt]!);
        i = i + 2;
      } else {
        state.pos = i;
        fail(state, "bad string escape");
      }
    } else {
      out.push(c);
      i = i + 1;
    }
  }
}

// Lua: SaveSerializer.lua:142
function readNumber(state: DecodeState): number {
  const m = /^[^,\]}\s]+/.exec(state.src.slice(state.pos - 1));
  const token = m ? m[0] : undefined;
  const value = token !== undefined ? tonumber(token) : undefined;
  if (value === undefined) fail(state, "malformed number");
  state.pos = state.pos + token!.length;
  return value;
}

// Lua: SaveSerializer.lua:150
function readIdent(state: DecodeState): string {
  const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(state.src.slice(state.pos - 1));
  if (!m) fail(state, "expected name");
  state.pos = state.pos + m[0].length;
  return m[0];
}

/** A decoded table before it takes the runtime shape (typed keys, in order). */
class RawTable {
  keys: (number | string)[] = [];
  vals = new Map<number | string, unknown>();
}

// The lt.ts shape (as platform/luadata.ts gives cache data): every key a
// non-negative integer NUMBER -> a sequence array; otherwise a plain object,
// with the key record above when key types would otherwise be lost.
function shape(t: RawTable): any {
  let allInt = true, max = -1;
  for (const k of t.keys) {
    if (typeof k !== "number" || !Number.isInteger(k) || k < 0) { allInt = false; break; }
    if (k > max) max = k;
  }
  if (allInt && t.keys.length > 0 && max > 4 * t.keys.length + 64) allInt = false;
  if (allInt && t.keys.length > 0) {
    const arr: unknown[] = new Array(max + 1).fill(null);
    for (const [k, v] of t.vals) arr[k as number] = v;
    return arr;
  }
  const obj: Record<string, unknown> = {};
  let rec: KeyRecord | undefined;
  // number keys first, so a string twin finds its number side in place
  for (const k of t.keys) {
    if (typeof k !== "number") continue;
    const name = propName(k);
    obj[name] = t.vals.get(k);
    if (!INT_KEY.test(name)) (rec ??= record(obj, true)!).numKeys.add(name);
  }
  for (const k of t.keys) {
    if (typeof k !== "string") continue;
    const v = t.vals.get(k);
    const numberTwin = t.vals.has(INT_KEY.test(k) ? Number(k) : NaN) || (rec !== undefined && rec.numKeys.has(k));
    if (numberTwin) {
      (rec ??= record(obj, true)!).twins.set(k, v);
    } else {
      obj[k] = v;
      if (INT_KEY.test(k)) (rec ??= record(obj, true)!).strOnly.add(k);
    }
  }
  return obj;
}

// Lua: SaveSerializer.lua:159
function readTable(state: DecodeState): any {
  bumpNode(state);
  state.depth = state.depth + 1;
  if (state.depth > (limit(state, "maxDepth") || MAX_DEPTH)) {
    fail(state, "table nesting too deep");
  }
  state.pos = state.pos + 1;
  const out = new RawTable();
  let entriesN = 0, nextArray = 1;
  skip(state);
  if (peek(state) === "}") {
    state.pos = state.pos + 1;
    state.depth = state.depth - 1;
    return shape(out);
  }
  for (;;) {
    skip(state);
    let key: unknown, value: unknown;
    const c = peek(state);
    if (c === "[") {
      state.pos = state.pos + 1;
      key = readValue(state);
      skip(state);
      if (peek(state) !== "]") fail(state, "expected ]");
      state.pos = state.pos + 1;
      skip(state);
      if (peek(state) !== "=") fail(state, "expected =");
      state.pos = state.pos + 1;
      value = readValue(state);
    } else if (c !== "" && isAlpha(c)) {
      const start = state.pos;
      const ident = readIdent(state);
      skip(state);
      if (peek(state) === "=") {
        key = ident;
        state.pos = state.pos + 1;
        value = readValue(state);
      } else if (state.limits && state.limits.allowArray) {
        state.pos = start;
        key = nextArray;
        value = readValue(state);
      } else {
        fail(state, "expected =");
      }
    } else if (state.limits && state.limits.allowArray) {
      key = nextArray;
      value = readValue(state);
    } else {
      fail(state, "expected key");
    }
    if (key == null) fail(state, "nil table key");
    // NOT FAITHFUL (by construction): a table or boolean key cannot be a JS property key
    if (typeof key !== "number" && typeof key !== "string") fail(state, "unsupported table key");
    if (out.vals.has(key)) fail(state, "duplicate table key");
    entriesN = entriesN + 1;
    const maximum = limit(state, "maxTableEntries");
    if (maximum && entriesN > maximum) fail(state, "too many table entries");
    out.keys.push(key);
    out.vals.set(key, value);
    if (typeof key === "number" && key === nextArray) nextArray = nextArray + 1;
    skip(state);
    const sep = peek(state);
    if (sep === ",") {
      state.pos = state.pos + 1;
      skip(state);
      if (peek(state) === "}") {
        state.pos = state.pos + 1;
        break;
      }
    } else if (sep === "}") {
      state.pos = state.pos + 1;
      break;
    } else {
      fail(state, "expected , or }");
    }
  }
  state.depth = state.depth - 1;
  return shape(out);
}

// Lua: SaveSerializer.lua:236
function readValue(state: DecodeState): unknown {
  skip(state);
  const c = peek(state);
  if (c === '"') {
    bumpNode(state);
    return readString(state);
  } else if (c === "{") {
    return readTable(state);
  } else if (c !== "" && isAlpha(c)) {
    const word = readIdent(state);
    if (word === "true") { bumpNode(state); return true; }
    if (word === "false") { bumpNode(state); return false; }
    state.pos = state.pos - word.length;
    fail(state, "unexpected name '" + word + "'");
  } else if (c !== "" && "-0123456789.".includes(c)) {
    bumpNode(state);
    return readNumber(state);
  }
  fail(state, c === "" ? "unexpected end of input" : "unexpected character");
}

export const SaveSerializer = {
  LUA_KEYS,
  setStrKey,
  setNumKey,
  getStrKey,
  getNumKey,

  // Lua: SaveSerializer.lua:51
  encode(data: unknown): string {
    return "return " + serialize(data) + "\n";
  },

  // Lua: SaveSerializer.lua:258 -- [table] or [undefined, err]
  decode(str: unknown, limits?: DecodeLimits): [any, string?] {
    if (typeof str !== "string") return [undefined, "save must be a string"];
    if (limits && limits.maxBytes && str.length > limits.maxBytes) {
      return [undefined, format("input is %d bytes (max %d)", str.length, limits.maxBytes)];
    }
    const state: DecodeState = { src: str, pos: 1, depth: 0, nodes: 0, limits };
    let result: unknown;
    try {
      skip(state);
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(state.src.slice(state.pos - 1));
      const word = m ? m[0] : undefined;
      if (word !== "return") fail(state, "expected return");
      state.pos = state.pos + word!.length;
      const value = readValue(state);
      skip(state);
      if (state.pos <= state.src.length) fail(state, "trailing content");
      result = value;
    } catch (e) {
      if (e instanceof ParseError) return [undefined, e.message];
      return [undefined, String((e as Error).message ?? e)];
    }
    if (result == null || typeof result !== "object") {
      return [undefined, ((limits && limits.rootName) || "save") + " root must be a table"];
    }
    return [result];
  },
};

export default SaveSerializer;
