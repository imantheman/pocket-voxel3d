// pocket-voxel addition to the gen3 importer port (GPLv3 + additional terms;
// see LICENSE.md). The cooked form of a cache Lua-literal file, for the 3DS
// card (voxelmon/cook/gen3data.ts writes it).
//
// The importer's cache holds ~140 Lua-literal files (scripts.lua 2.9 MB,
// text.lua 2.5 MB, audio/index.lua 3.2 MB, ...). Parsing those under the 3DS's
// QuickJS took minutes and ran the heap dry. The card cook converts each one,
// once, into COOKED_TAG + JSON of the table in the runtime's luaLoad shape
// (game/gen3/platform/luadata.ts: a table whose keys are all non-negative
// integers is an array with slot 0 for key 0, nil holes null; any other
// table an object), which JSON.parse reads ~80x faster into ~4x less heap.
//
// Two readers meet these files: luaLoad (the runtime) takes the JSON as it
// is; the importer's readLuaLiteral (asset_pack.ts, a 0-based shape: a table
// keyed exactly 1..n is an array, every other table an object, {} an empty
// array) converts it here. The conversion is exact for the cache's files:
// tests/voxel-gen3-cooked.test.ts checks both readers give the same value from
// the cooked text as from the Lua source, for every file in the cache.
//
// This module has no imports: luadata.ts, asset_pack.ts and the cook all use it.

/** The prefix of a cooked (pre-converted) data chunk. */
export const COOKED_TAG = "\x00PVJ1\n";
/**
 * The same for a chunk readLuaLiteral refuses (one built in steps,
 * `local M = {...}; M.x[1] = 2; return M`): luaLoad reads it, readLuaLiteral
 * still throws, as on the Lua.
 */
export const COOKED_STEPS_TAG = "\x00PVJ2\n";
/**
 * The table in readLuaLiteral's shape instead, for the files the importer's
 * reader is the one that reads (the script bundle): readLuaLiteral takes the
 * JSON as it is, luaLoad converts it (luaShape). The cook writes it only
 * where that conversion gives exactly luaLoad's value of the Lua.
 */
export const COOKED_LIT_TAG = "\x00PVJ3\n";

/**
 * The prefix of a deflated card file (any kind): ZIP_TAG, the raw length as
 * u32 LE, then a raw deflate stream. Hosts inflate it in their file read
 * (crates/pocketvoxel-3ds/src/gen3/g3_render.c, platform/desktop.ts), so the
 * guest never sees it.
 */
export const ZIP_TAG = "\x00PVZ1";

export function isCooked(src: string): boolean {
  return src.startsWith(COOKED_TAG) || src.startsWith(COOKED_STEPS_TAG) || src.startsWith(COOKED_LIT_TAG);
}

/**
 * A readLuaLiteral-shape value in luaLoad's shape: a 0-based array of n is
 * keys 1..n ({} when empty); an object whose keys are all non-negative
 * integers (not too sparse, luadata.ts shape) an array with slot 0 for key 0.
 */
export function luaShape(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) {
    if (v.length === 0) return {};
    const out = new Array(v.length + 1);
    out[0] = null;
    for (let i = 0; i < v.length; i++) out[i + 1] = luaShape(v[i]);
    return out;
  }
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  let allInt = keys.length > 0, max = 0;
  for (const k of keys) {
    if (!/^(0|[1-9][0-9]*)$/.test(k)) { allInt = false; break; }
    const n = Number(k);
    if (n > max) max = n;
  }
  if (allInt && max > 4 * keys.length + 64) allInt = false;
  if (allInt) {
    const out: unknown[] = new Array(max + 1).fill(null);
    for (const k of keys) out[Number(k)] = luaShape(o[k]);
    return out;
  }
  for (const k of keys) {
    const x = o[k];
    if (x !== null && typeof x === "object") o[k] = luaShape(x);
  }
  return o;
}

/** A luaLoad-shape value as readLuaLiteral would have read the same Lua table. */
export function literalShape(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) {
    // keys = the non-null slots
    let seq = v[0] == null;
    for (let i = 1; seq && i < v.length; i++) if (v[i] == null) seq = false;
    if (seq) {
      const out = new Array(v.length - 1);
      for (let i = 1; i < v.length; i++) out[i - 1] = literalShape(v[i]);
      return out;
    }
    const o: Record<string, unknown> = {};
    for (let i = 0; i < v.length; i++) if (v[i] != null) o[String(i)] = literalShape(v[i]);
    return o;
  }
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  // keys exactly "1".."n" (string keys the luaLoad shape kept as an object)
  let seq = true;
  for (let i = 0; i < keys.length; i++) if (!(String(i + 1) in o)) { seq = false; break; }
  if (seq) {
    const out = new Array(keys.length);
    for (let i = 0; i < keys.length; i++) out[i] = literalShape(o[String(i + 1)]);
    return out;
  }
  for (const k of keys) {
    const x = o[k];
    if (x !== null && typeof x === "object") o[k] = literalShape(x);
  }
  return o;
}

/** A cooked chunk's table in the luaLoad shape. */
export function readCooked(src: string): unknown {
  const v = JSON.parse(src.slice(COOKED_TAG.length));
  return src.startsWith(COOKED_LIT_TAG) ? luaShape(v) : v;
}

/** A cooked chunk's table in readLuaLiteral's shape. */
export function readCookedLiteral(src: string): unknown {
  if (src.startsWith(COOKED_STEPS_TAG)) throw new Error("not a pure data chunk (cooked from statements)");
  if (src.startsWith(COOKED_LIT_TAG)) return JSON.parse(src.slice(COOKED_LIT_TAG.length));
  return literalShape(readCooked(src));
}

export const CookedData = { COOKED_TAG, COOKED_STEPS_TAG, COOKED_LIT_TAG, ZIP_TAG, isCooked, literalShape, luaShape, readCooked, readCookedLiteral };
export default CookedData;
