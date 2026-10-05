// Port of gen1recomp src/core/game3/marts.lua (GPLv3 + additional terms; see LICENSE.md).
// Runtime lookup for extracted pokemart item lists (CacheFS scripts/marts.lua).
// Lua differences: _byKey is a Map so a number key (the GBA pointer) and a
// string key stay apart, as in a Lua table. NOT FAITHFUL: the Lua load()s
// marts.lua; readLuaLiteral reads it, which folds the file's ["123"] decimal
// string keys into the number keys (itemsFor resolves both the same way).
// NOT FAITHFUL: with no cache passed, the Lua asks src.core.game3.dataset (not
// ported) for its cache; here the CacheFs-bound cache is used.

import { tonumber, tostring } from "../../../import/gen3/lua.ts";
import { CacheFs, type Cache } from "../../../import/gen3/cache.ts";
import { readLuaLiteral } from "../../../import/gen3/asset_pack.ts";
import { luaGet, luaKeys } from "../../../import/gen3/luatable.ts";
import { Opcodes } from "./scripting/opcodes.ts";

export interface MartEntry { ptr?: number; key?: string; items: unknown; [k: string]: unknown }

// Lua: marts.lua:7 (extract_island1's CACHE_ROOT)
function default_root(): string {
  return "data/generated/gba";
}

// Lua: marts.lua:15
function love_cache(): Cache | undefined {
  try {
    return CacheFs.bound();
  } catch {
    return undefined;
  }
}

export const Marts = {
  _byKey: undefined as Map<unknown, MartEntry> | undefined,

  // Lua: marts.lua:23
  install(pack: unknown): number {
    Marts._byKey = new Map();
    if (pack === null || typeof pack !== "object") return 0;
    const p = pack as Record<string, unknown>;
    const src = (p.marts ?? pack) as object;
    let n = 0;
    const seen = new Set<unknown>();
    const entries: [unknown, unknown][] = src instanceof Map
      ? Array.from(src.entries())
      : luaKeys(src).map((k) => [k, luaGet(src, k)]);
    for (const [k, ev] of entries) {
      const e = ev as MartEntry;
      if (e !== null && typeof e === "object" && e.items !== null && typeof e.items === "object") {
        Marts._byKey.set(k, e);
        if (e.ptr !== undefined && e.ptr !== null) Marts._byKey.set(e.ptr, e);
        if (e.key !== undefined && e.key !== null) Marts._byKey.set(e.key, e);
        if (e.ptr !== undefined && e.ptr !== null && !seen.has(e.ptr)) {
          seen.add(e.ptr);
          n = n + 1;
        }
      }
    }
    return n;
  },

  // Lua: marts.lua:43
  load(cache?: Cache, root?: string): number {
    cache = cache ?? love_cache();
    root = root ?? default_root();
    if (!cache || !cache.read) {
      Marts._byKey = new Map();
      return 0;
    }
    const rel = root + "/scripts/marts.lua";
    const src = cache.read(rel);
    if (src === undefined) {
      Marts._byKey = new Map();
      return 0;
    }
    let pack: unknown;
    try {
      pack = readLuaLiteral(src);
    } catch {
      pack = undefined;
    }
    return Marts.install(pack);
  },

  // Lua: marts.lua:61
  ensure(cache?: Cache, root?: string): boolean {
    if (Marts._byKey) return true;
    Marts.load(cache, root);
    return Marts._byKey !== undefined;
  },

  /** Resolve mart list for a pokemart operand (number ptr, decimal string, or g3:key). */
  // Lua: marts.lua:68 -- [items, entry] or []
  itemsFor(key: unknown): [unknown, MartEntry] | [] {
    Marts.ensure();
    const by = Marts._byKey;
    if (!by) return [];
    let e = by.get(key);
    if (!e && typeof key === "string") {
      const n = tonumber(key);
      if (n !== undefined) e = by.get(n);
      if (!e) {
        const m = /^g3:([0-9A-Fa-f]+)$/.exec(key);
        if (m) e = by.get(tonumber(m[1], 16)) ?? by.get(key);
      }
    } else if (typeof key === "number") {
      e = by.get(key) ?? by.get(tostring(key));
      if (!e) {
        e = by.get(Opcodes.key(key));
      }
    }
    if (e && e.items) return [e.items, e];
    return [];
  },
};

export default Marts;
