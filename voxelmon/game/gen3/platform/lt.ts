// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). Lua tables in the runtime port.
//
// THE RULE: a Lua table keeps its Lua keys. A sequence is a JS array whose
// slot 0 is unused (`[null, a, b, c]`, or `seq(a, b, c)`), so Brian's
// `t[i]` stays `t[i]`, `t[#t + 1] = v` stays `t[len(t) + 1] = v`, and a table
// keyed by species / map / flag id reads the same whether FireRed happens to
// fill it densely or not. A table with string keys is a plain object (and may
// carry integer keys too: `obj[1]`). Absent is `null` OR `undefined`: test
// with `== null`, never `=== undefined`.
//
// Data loaded from the cache (luadata.ts) comes in this shape; tables the port
// builds itself are made in it. Lua multiple returns are NOT tables: they are
// ordinary 0-based JS tuples (`const [ok, err] = f()`).

/* eslint-disable @typescript-eslint/no-explicit-any */
export type LuaTable = any;

/** A new sequence: `{a, b, c}`. */
export function seq<T>(...xs: T[]): (T | null)[] {
  return [null, ...xs];
}

/** Lua's `#t`: the border, scanning up from 1 (arrays: trailing nils trimmed). */
export function len(t: LuaTable): number {
  if (t == null) throw new Error("attempt to get length of a nil value");
  if (typeof t === "string") return t.length;
  if (Array.isArray(t)) {
    let n = t.length - 1;
    while (n > 0 && t[n] == null) n--;
    return n > 0 ? n : 0;
  }
  let n = 0;
  while (t[n + 1] != null) n++;
  return n;
}

/** `for i, v in ipairs(t)` -> `for (const [i, v] of ipairs(t))`. */
export function* ipairs<T = any>(t: LuaTable): Generator<[number, T]> {
  if (t == null) return;
  for (let i = 1; t[i] != null; i++) yield [i, t[i] as T];
}

const INT_KEY = /^(0|-?[1-9]\d*)$/;

/**
 * `for k, v in pairs(t)`. Integer keys come back as numbers. Lua's order is
 * unspecified; this one is JS's (integer keys ascending, then insertion).
 * Where Brian's result depends on the order, sort the keys (sortedKeys).
 */
export function* pairs<T = any>(t: LuaTable): Generator<[number | string, T]> {
  if (t == null) return;
  if (Array.isArray(t)) {
    for (let i = 0; i < t.length; i++) if (t[i] != null) yield [i, t[i] as T];
    return;
  }
  if (t instanceof Map) {
    for (const [k, v] of t) if (v != null) yield [k, v as T];
    return;
  }
  for (const k of Object.keys(t)) {
    const v = t[k];
    if (v != null) yield [INT_KEY.test(k) ? Number(k) : k, v as T];
  }
}

/** `next(t) == nil`. */
export function isEmpty(t: LuaTable): boolean {
  for (const _ of pairs(t)) return false;
  return true;
}

/** table.insert(t, v) / table.insert(t, pos, v). */
export function insert(t: LuaTable, a: any, b?: any): void {
  const n = len(t);
  if (arguments.length < 3) { t[n + 1] = a; return; }
  const pos = a as number;
  for (let i = n; i >= pos; i--) t[i + 1] = t[i];
  t[pos] = b;
}

/** table.remove(t [, pos]) -> the removed value (or undefined). */
export function remove<T = any>(t: LuaTable, pos?: number): T | undefined {
  const n = len(t);
  if (n === 0 && pos == null) return undefined;
  const p = pos ?? n;
  const v = t[p];
  for (let i = p; i < n; i++) t[i] = t[i + 1];
  if (p <= n) {
    if (Array.isArray(t) && t.length === n + 1) t.length = n;
    else t[n] = null;
  }
  return v as T;
}

/**
 * table.sort(t [, lt]): sorts t[1..#t] in place. NOT FAITHFUL for comparators
 * that tie: LuaJIT's sort is not stable and JS's is, so equal elements may end
 * in another order. Where that shows, sort by a full key.
 */
export function sort<T = any>(t: LuaTable, lt?: (a: T, b: T) => boolean): void {
  const n = len(t);
  const items: T[] = [];
  for (let i = 1; i <= n; i++) items.push(t[i]);
  const cmp = lt ?? ((a: any, b: any) => a < b);
  items.sort((a, b) => (cmp(a, b) ? -1 : cmp(b, a) ? 1 : 0));
  for (let i = 0; i < n; i++) t[i + 1] = items[i];
}

/** table.concat(t [, sep [, i [, j]]]). Numbers format as Lua prints them. */
export function concat(t: LuaTable, sep = "", i = 1, j?: number): string {
  const last = j ?? len(t);
  const parts: string[] = [];
  for (let k = i; k <= last; k++) {
    const v = t[k];
    if (typeof v === "number") parts.push(numStr(v));
    else if (typeof v === "string") parts.push(v);
    else throw new Error(`invalid value (at index ${k}) in table for 'concat'`);
  }
  return parts.join(sep);
}

/** unpack(t [, i [, j]]) -> a JS tuple (spread it into the call). */
export function unpack<T = any>(t: LuaTable, i = 1, j?: number): T[] {
  const last = j ?? len(t);
  const out: T[] = [];
  for (let k = i; k <= last; k++) out.push(t[k]);
  return out;
}

/** A 1-based sequence from a JS array (seams with 0-based code). */
export function fromArray<T>(xs: readonly T[]): (T | null)[] {
  return [null, ...xs];
}

/** A JS array of t[1..#t] (seams with 0-based code). */
export function toArray<T = any>(t: LuaTable): T[] {
  return t == null ? [] : unpack<T>(t);
}

/** Lua's tostring for a number (integers without ".0", %.14g otherwise). */
function numStr(v: number): string {
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v);
  if (v !== v) return "nan";
  if (v === Infinity) return "inf";
  if (v === -Infinity) return "-inf";
  return Number(v.toPrecision(14)).toString();
}

export const LT = { seq, len, ipairs, pairs, isEmpty, insert, remove, sort, concat, unpack, fromArray, toArray };
export default LT;
