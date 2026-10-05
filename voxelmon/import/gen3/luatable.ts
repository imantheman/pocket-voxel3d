// Port support for gen1recomp's FireRed engine (GPLv3 + additional terms; see
// LICENSE.md). How the gen3 port's JS values stand in for Lua tables when a
// ported writer inspects them the way Lua does:
//
// - a Lua sequence is a JS array (0-based: Lua t[i] is JS t[i - 1]);
// - any other table is a plain object; an integer-looking key is the Lua
//   NUMBER key (the port never mixes number 1 and string "1" keys);
// - an empty table is either; Lua cannot tell them apart and neither do
//   these helpers.

export type LuaKey = number | string;

function intKey(k: string): number | undefined {
  if (!/^(0|-?[1-9][0-9]*)$/.test(k)) return undefined;
  const n = Number(k);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** The value's keys as Lua sees them (array indices 1-based). */
export function luaKeys(v: object): LuaKey[] {
  if (Array.isArray(v)) {
    const out: LuaKey[] = [];
    for (let i = 0; i < v.length; i++) if (v[i] !== undefined && v[i] !== null) out.push(i + 1);
    return out;
  }
  const out: LuaKey[] = [];
  for (const k of Object.keys(v)) {
    if ((v as Record<string, unknown>)[k] === undefined) continue;
    const n = intKey(k);
    out.push(n === undefined ? k : n);
  }
  return out;
}

/** t[k] with a Lua key. */
export function luaGet(v: object, k: LuaKey): unknown {
  if (Array.isArray(v)) return typeof k === "number" ? v[k - 1] : undefined;
  return (v as Record<string, unknown>)[String(k)];
}

/**
 * LuaWriter / lua-dump isArray: every key a positive integer and the count
 * equals the maximum. Returns [isArray, length].
 */
export function luaIsArray(v: object): [boolean, number] {
  let count = 0, maximum = 0;
  for (const k of luaKeys(v)) {
    if (typeof k !== "number" || k < 1) return [false, 0];
    count++;
    if (k > maximum) maximum = k;
  }
  return [count === maximum, maximum];
}

/** Lua's `#t` for a table: an array's length; for an object, the border from 1. */
export function luaLen(v: object): number {
  if (Array.isArray(v)) {
    let n = v.length;
    while (n > 0 && (v[n - 1] === undefined || v[n - 1] === null)) n--;
    return n;
  }
  const o = v as Record<string, unknown>;
  let n = 0;
  while (o[String(n + 1)] !== undefined && o[String(n + 1)] !== null) n++;
  return n;
}

/** next(t) == nil */
export function luaEmpty(v: object): boolean {
  return luaKeys(v).length === 0;
}

/** LuaWriter's key order: numbers ascending, then strings (byte order). */
export function luaWriterOrder(keys: LuaKey[]): LuaKey[] {
  return keys.slice().sort((a, b) => {
    if (typeof a === typeof b) return a < b ? -1 : a > b ? 1 : 0;
    return typeof a === "number" ? -1 : 1;
  });
}

/** Sorting by tostring(key), as canonical_json and many serializers do. */
export function byTostring(keys: LuaKey[], tostr: (k: LuaKey) => string): LuaKey[] {
  return keys.slice().sort((a, b) => {
    const sa = tostr(a), sb = tostr(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });
}
