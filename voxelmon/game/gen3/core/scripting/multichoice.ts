// Port of gen1recomp src/core/game3/scripting/multichoice.lua (GPLv3 + additional terms; see LICENSE.md).
// src/script_menu.c:505
// Keyed by listId (script operand). Each entry: { labels = {...}, left?, top? }.
//
// Port notes:
// - pcall(require, X) of dataset / CacheFs is a static import with Brian's
//   guards kept (each reader still runs under try/catch, as under pcall).
// - src.import.gba.extract_island1's CACHE_ROOT is CachePaths.CACHE_ROOT
//   (extract_island1 forwards that key to cache_paths), so cache_paths is
//   read directly.
// - The cache chunk goes through luaLoad (lt.ts shape: labels are sequences).
// - resolve returns its two values as a tuple: [labels, { left, top }].

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tonumber } from "../../../../import/gen3/lua.ts";
import { seq, len, ipairs, pairs, isEmpty, type LuaTable } from "../../platform/lt.ts";
import { luaLoad } from "../../platform/luadata.ts";
import { Fs } from "../../platform/fs.ts";
import { Strings } from "../../shared/core/Strings.ts";
import { Dataset } from "../dataset.ts";
import { CacheFs } from "../../shared/import/CacheFs.ts";
import { CachePaths } from "../cache_paths.ts";

export interface MultichoiceEntry { labels: LuaTable; left?: number; top?: number; count?: number }

// Lua: multichoice.lua:24
/** Override/merge from extract cache if present. */
function loadExtract(tbl: unknown): void {
  if (tbl == null || typeof tbl !== "object") return;
  for (const [id, entry] of pairs<any>(tbl)) {
    const n = tonumber(id) ?? id;
    if (entry != null && typeof entry === "object" && entry.labels != null && entry.labels !== false) {
      Multichoice.LISTS[n] = entry;
    } else if (entry != null && typeof entry === "object" && entry[1] != null && entry[1] !== false) {
      Multichoice.LISTS[n] = { labels: entry };
    }
  }
}

// Lua: multichoice.lua:36
function parse_lists(src: unknown): LuaTable | undefined {
  if (typeof src !== "string" || src.length === 0) return undefined;
  const [chunk] = luaLoad(src, "@" + Multichoice.CACHE_REL);
  if (!chunk) return undefined;
  let ok: boolean, data: unknown;
  try {
    data = chunk();
    ok = true;
  } catch {
    ok = false;
  }
  if (ok && data != null && typeof data === "object") return data;
  return undefined;
}

// Lua: multichoice.lua:45
function read_from_dataset(): string | undefined {
  // pcall(require, "src.core.game3.dataset") always succeeds here.
  if (!(Dataset && Dataset.cache)) return undefined;
  let cache: any;
  try { cache = Dataset.cache(); } catch { return undefined; }
  if (!(cache && cache.read)) return undefined;
  try {
    return cache.read(Multichoice.CACHE_REL);
  } catch {
    return undefined;
  }
}

// Lua: multichoice.lua:55
function read_from_cachefs(): string | undefined {
  // pcall(require, "src.import.CacheFs") always succeeds here.
  if (!(CacheFs && CacheFs.readActive)) return undefined;
  try {
    return CacheFs.readActive(Multichoice.CACHE_REL);
  } catch {
    return undefined;
  }
}

// Lua: multichoice.lua:63
function read_from_love(): string | undefined {
  try {
    return Fs.read(Multichoice.CACHE_REL);
  } catch {
    return undefined;
  }
}

// Lua: multichoice.lua:70
function read_from_disk(): string | undefined {
  const root = CachePaths.CACHE_ROOT || "data/generated/gba";
  // NOT FAITHFUL: io.open(path, "rb") -- there is no stdio on the 3DS; the
  // platform filesystem (Fs.read) reads the same relative path.
  let src: string | undefined;
  try { src = Fs.read(root + "/scripts/multichoice.lua"); } catch { src = undefined; }
  if (src == null) return undefined;
  return src;
}

// Lua: multichoice.lua:80
function tryLoadCache(): boolean {
  const customRoot = CachePaths.CACHE_ROOT && CachePaths.CACHE_ROOT !== "data/generated/gba";
  let readers: LuaTable;
  if (customRoot) {
    readers = seq(read_from_disk);
  } else {
    readers = seq(read_from_disk, read_from_dataset, read_from_cachefs, read_from_love);
  }
  for (const [, reader] of ipairs<() => string | undefined>(readers)) {
    const data = parse_lists(reader());
    if (data) {
      Multichoice.loadExtract(data);
      return true;
    }
  }
  return false;
}

// Lua: multichoice.lua:102
function resolve(listId: unknown, countHint?: unknown): [LuaTable, { left?: number; top?: number }] {
  if (isEmpty(Multichoice.LISTS)) {
    Multichoice.tryLoadCache();
  }
  const id = tonumber(listId) ?? 0;
  const entry = Multichoice.LISTS[id];
  if (entry && entry.labels && len(entry.labels) > 0) {
    return [entry.labels, { left: entry.left, top: entry.top }];
  }
  const n = Multichoice.COUNTS[id] ?? tonumber(countHint) ?? 3;
  const labels: LuaTable = [null];
  for (let i = 1; i <= Math.max(1, n); i++) {
    labels[i] = Strings("OPTION %s", (i - 1));
  }
  return [labels, { left: 20, top: 5 }];
}

export const Multichoice = {
  LISTS: {} as Record<number | string, MultichoiceEntry>,
  OVERRIDES: {} as Record<number | string, any>,
  CACHE_REL: "data/generated/gba/scripts/multichoice.lua",

  // Lua: multichoice.lua:11
  COUNTS: {
    [0]: 2, [1]: 5, [2]: 4, [3]: 2, [4]: 2, [5]: 2, [6]: 3, [7]: 3,
    [8]: 3, [9]: 4, [10]: 1, [11]: 1, [12]: 1, [13]: 2, [14]: 6, [15]: 6,
    [16]: 3, [17]: 5, [18]: 3, [19]: 3, [20]: 3, [21]: 2, [22]: 2, [23]: 2,
    [24]: 3, [25]: 3, [26]: 4, [27]: 3, [28]: 2, [29]: 2, [30]: 6, [31]: 6,
    [32]: 2, [33]: 2, [34]: 3, [35]: 2, [36]: 3, [37]: 3, [38]: 4, [39]: 3,
    [40]: 3, [41]: 6, [42]: 4, [43]: 4, [44]: 3, [45]: 3, [46]: 3, [47]: 4,
    [48]: 3, [49]: 3, [50]: 3, [51]: 2, [52]: 5, [53]: 4, [54]: 3, [55]: 3,
    [56]: 4, [57]: 4, [58]: 4, [59]: 4, [60]: 4, [61]: 2, [62]: 3, [63]: 3,
    [64]: 5,
  } as Record<number, number>,

  loadExtract,
  tryLoadCache,
  resolve,
};

// Lua: multichoice.lua:99
// Preload cache immediately. Every reader runs under try/catch, as under
// Brian's pcalls, so a host or cache that is not up yet (or a circular
// import still initialising) reads as "no cache"; resolve() retries.
try {
  Multichoice.tryLoadCache();
} catch {
  // (the Lua's readers cannot raise here)
}

export default Multichoice;
