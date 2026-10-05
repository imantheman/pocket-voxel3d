// Port of gen1recomp src/import/gba/extract_island1.lua (GPLv3 + additional terms; see LICENSE.md).
// Staged Island 1 extract: tilesets → maps → collide → quantize → pack → mod.cache.
// Outdoors (SeviiIslands123) + interiors (Network Center, Harbor, Houses) share
// one 2bpp sheet; metatile ids are namespaced by tileset pair.
//
// Port notes:
// - Extract.CACHE_ROOT / NATIVE_ROOT forward to CachePaths, as the Lua
//   metatable does (extract_island1.lua:19-31).
// - Grid cells, tile quads (tiles[q]), ramps (ramp[s][c]) are 0-based JS
//   arrays where the Lua's are 1-based tables; every index is shifted.
// - Lua's second Extract.runNativeOnly (line 1953) replaces the first
//   (line 598, `return Extract.run(...)`), so only the second is ported.
// - NOT FAITHFUL: berry_crush_extract, dodrio_extract and
//   pokemon_jump_extract (the minigame art) are not ported; the loops that
//   run them (lines 511-513, 1943-1945) skip those three.

import { format, tonumber, tostring } from "./lua.ts";
import { luaGet, luaKeys, luaLen } from "./luatable.ts";
import { readLuaLiteral } from "./asset_pack.ts";
import type { Cache } from "./cache.ts";
import { Versions } from "./versions.ts";
import { Rom } from "./rom.ts";
import { GameVersion } from "./game_version.ts";
import type { Imports, ImportInfo } from "./revision_view.ts";
import { Tileset, type TilesetBundle } from "./tileset.ts";
import { Metatile } from "./metatile.ts";
import { Quantize, type Sheet } from "./quantize.ts";
import { QuantizeLab, type CodebookEntry } from "./quantize_lab.ts";
import { QuantizeMrf } from "./quantize_mrf.ts";
import { PaletteRules } from "./palette_rules.ts";
import { Maps, type Grid, type Border, type Cell } from "./maps.ts";
import { MapTree } from "./map_tree.ts";
import { MapCatalog } from "./map_catalog.ts";
import { AltLayouts } from "./alt_layouts.ts";
import { NativePack } from "./native_pack.ts";
import { ExtractScripts, type ScriptBundle } from "./extract_scripts.ts";
import { ExtractMapEvents, type Warp } from "./extract_map_events.ts";
import { HelpExtract } from "./help_extract.ts";
import { QuestLogExtract } from "./quest_log_extract.ts";
import { ObjectInteractionsExtract } from "./object_interactions_extract.ts";
import { AnimPack } from "./tileset_anim_pack.ts";
import { OwExtract } from "./ow_extract.ts";
import { EncountersExtract } from "./encounters_extract.ts";
import { FieldEffectExtract } from "./field_effect_extract.ts";
import { MartsExtract } from "./marts_extract.ts";
import { OnlineUiExtract } from "./online_ui_extract.ts";
import { TrainerExtract } from "./trainer_extract.ts";
import { MapTreeExtract } from "./map_tree_extract.ts";
import { Collision } from "../../game/gen3/core/scripting/collision.ts";
import { CachePaths } from "../../game/gen3/core/cache_paths.ts";

type Tbl = Record<string, any>;
export type ProgressCb = (stage: number, n: number, name: string, cur: number, total: number) => void;
export interface MidInfo {
  tiles: number[];
  coll: number;
  behavior: number;
  category: string;
  voidQuads?: boolean[];
}
type MidIndex = Record<string, Record<number, MidInfo>>;

// Lua: extract_island1.lua:34
function progress(cb: ProgressCb | undefined, stage: number, name: string, cur?: number, total?: number): void {
  if (cb) cb(stage, Extract.STAGE_COUNT, name, cur ?? 0, total ?? 1);
}

// Lua: extract_island1.lua:38
function json_escape(s: unknown): string {
  return tostring(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// Lua: extract_island1.lua:42 -- its own JSON encoder (keys sorted by tostring)
function write_json(cache: Cache, rel: string, obj: unknown): boolean {
  const enc = (v: unknown): string => {
    if (v === undefined || v === null) return "null";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number") return tostring(v);
    if (typeof v === "string") return '"' + json_escape(v) + '"';
    if (typeof v === "object") {
      const n = luaLen(v as object);
      if (n > 0) {
        const parts: string[] = [];
        for (let i = 1; i <= n; i++) parts[i - 1] = enc(luaGet(v as object, i));
        return "[" + parts.join(",") + "]";
      }
      const keys = luaKeys(v as object);
      keys.sort((a, b) => {
        const sa = tostring(a), sb = tostring(b);
        return sa < sb ? -1 : sa > sb ? 1 : 0;
      });
      const parts: string[] = [];
      for (const k of keys) parts.push('"' + json_escape(k) + '":' + enc(luaGet(v as object, k)));
      return "{" + parts.join(",") + "}";
    }
    return "null";
  };
  return cache.write(rel, enc(obj) + "\n");
}

/**
 * Lua: extract_island1.lua:73 -- Pad odd FRLG grids so 2×2 pack does not clip
 * the last row/column. Outdoors: extend edge tiles (ocean/cliff continues).
 * Indoors: black void mid so the duplicated right/bottom column does not
 * stretch walls/stairs. (cells 0-based)
 */
function pad_even(grid: Grid): Grid {
  const w = grid.width, h = grid.height;
  const nw = w + (w % 2);
  const nh = h + (h % 2);
  if (nw === w && nh === h) return grid;
  const indoor = grid.environment === "INDOOR" || grid.kind === "indoor";
  const voidCell: Cell = { mid: 0, coll: 1, elev: 0 };
  const cells: Cell[] = [];
  const at = (x: number, y: number): Cell => {
    if (indoor && (x >= w || y >= h)) return voidCell;
    const sx = Math.min(x, w - 1);
    const sy = Math.min(y, h - 1);
    return grid.cells[sy * w + sx]!;
  };
  for (let y = 0; y <= nh - 1; y++) {
    for (let x = 0; x <= nw - 1; x++) {
      const c = at(x, y);
      cells.push({ mid: c.mid, coll: c.coll, elev: c.elev });
    }
  }
  return {
    width: nw,
    height: nh,
    cells,
    map_id: grid.map_id,
    kind: grid.kind,
    pair: grid.pair,
    environment: grid.environment,
    padded_from: { width: w, height: h },
  };
}

// Lua: extract_island1.lua:111 -- Exact-black 8×8 quads are FRLG void /
// silhouette (mid 0, mid 8, chamfer corners). They must not enter the
// material codebook or steal shade slots.
function is_exact_black_quad(buf: ArrayLike<number>): boolean {
  return Metatile.isExactBlackBuf(buf, 64);
}

// Lua: extract_island1.lua:115
const DYNAMIC_MIDS_BY_PAIR: Record<string, number[]> = {
  network: [
    0x2D0, 0x2D1, 0x2D8, 0x2D9, 0x2E3, 0x2E4, 0x2EB, 0x2EC,
    0x308, 0x309, 0x30A, 0x30B, 0x310, 0x311, 0x312, 0x313,
    0x314, 0x315, 0x316, 0x317, 0x31C, 0x31E,
  ],
  pokemon_center: [
    0x2D0, 0x2D1, 0x2D8, 0x2D9, 0x2E3, 0x2E4, 0x2EB, 0x2EC,
    0x308, 0x309, 0x30A, 0x30B, 0x310, 0x311, 0x312, 0x313,
    0x314, 0x315, 0x316, 0x317, 0x31C, 0x31E,
  ],
  dept_store: [
    0x28D, 0x2D0, 0x2D1, 0x2D8, 0x2D9, 0x2E3, 0x2E4, 0x2EB, 0x2EC,
    0x308, 0x309, 0x30A, 0x30B, 0x310, 0x311, 0x312, 0x313,
    0x314, 0x315, 0x316, 0x317, 0x31C, 0x31E,
  ],
};

// Lua: extract_island1.lua:133
function script_mids_by_pair(scriptBundle: ScriptBundle | undefined, grids: Record<string, Grid>): Record<string, Set<number>> {
  if (!scriptBundle) return {};
  return NativePack.scriptMidsByPair(scriptBundle.scripts, scriptBundle.events, (mapId) => {
    const grid = grids[mapId];
    return grid ? (grid.pair ?? "sevii_outdoor") : undefined;
  });
}

// Lua: extract_island1.lua:142
function unique_mids_by_pair(grids: Record<string, Grid>, scriptMids?: Record<string, Set<number>>): Record<string, number[]> {
  const byPair: Record<string, Set<number>> = {};
  for (const grid of Object.values(grids)) {
    const pair = grid.pair ?? "sevii_outdoor";
    let seen = byPair[pair];
    if (!seen) {
      seen = new Set();
      byPair[pair] = seen;
    }
    for (const cell of grid.cells) seen.add(cell.mid);
  }
  for (const pair of Object.keys(scriptMids ?? {})) {
    const seen = byPair[pair];
    if (seen) for (const mid of scriptMids![pair]!) seen.add(mid);
  }
  for (const pair of Object.keys(DYNAMIC_MIDS_BY_PAIR)) {
    const seen = byPair[pair];
    if (seen) for (const mid of DYNAMIC_MIDS_BY_PAIR[pair]!) seen.add(mid);
  }
  for (const pair of Object.keys(byPair)) NativePack.addDynamicMids(byPair[pair]!, pair);
  const out: Record<string, number[]> = {};
  for (const pair of Object.keys(byPair)) {
    const seen = byPair[pair]!;
    NativePack.addPcOnMids(seen);
    const list = Array.from(seen);
    list.sort((a, b) => a - b);
    out[pair] = list;
  }
  return out;
}

/** assert(x) on a [value, err] pair (Rom.open, MapTree.walk). */
function assertOk<T>(r: [T | undefined, string?]): T {
  if (r[0] === undefined || r[0] === null) throw new Error(r[1] ?? "assertion failed!");
  return r[0];
}

/** Lua's pcall(Tileset.loadPair, ...) loop (extract_island1.lua:322-331). */
function loadBundles(rom: Rom, version: any, pairNames: string[], progressCb: ProgressCb | undefined): Record<string, TilesetBundle> {
  const bundles: Record<string, TilesetBundle> = {};
  for (let i = 1; i <= pairNames.length; i++) {
    const pairName = pairNames[i - 1]!;
    progress(progressCb, 1, "tilesets", i - 1, pairNames.length);
    let bundleOrErr: unknown;
    let okLoad = true;
    try {
      [bundleOrErr] = Tileset.loadPair(rom, version, pairName);
    } catch (e) {
      okLoad = false;
      bundleOrErr = e instanceof Error ? e.message : e;
    }
    if (okLoad && bundleOrErr) {
      bundles[pairName] = bundleOrErr as TilesetBundle;
    } else {
      console.log("[extract] skip tileset pair " + tostring(pairName) + ": " + tostring(bundleOrErr));
    }
  }
  return bundles;
}

/** Lua: extract_island1.lua:312-319 -- the tileset pairs the registered maps need, sorted. */
function neededPairs(mapOrder: string[]): string[] {
  const needed = new Set<string>();
  for (const mapId of mapOrder) {
    const spec = Versions.MAPS[mapId];
    needed.add((spec && spec.pair) || "sevii_outdoor");
  }
  return Array.from(needed).sort();
}

/** Lua: extract_island1.lua:424-462 -- ROM warps + connections, resolved through the census. */
function warpsAndConnections(imports: Imports, importId: string, version: any, mapOrder: string[]):
  [Record<string, Warp[]>, Record<string, { dir: string; map: string; offset: number }[]>] {
  const romW = assertOk(Rom.open(imports, importId));
  const [romWarps, romConns] = ExtractMapEvents.extractWarpsAndConnections(romW, version);
  romW.clearCache();
  // Prefer ROM warps when present; fall back to hand table per-map.
  const warps: Record<string, Warp[]> = {};
  for (const mapId of mapOrder) {
    const list = romWarps[mapId];
    if (list && list.length > 0) {
      // Resolve any leftover nil destMap via census (group:num → FR_*).
      for (const w of list) {
        if (!w.destMap && w.mapGroup !== undefined) {
          w.destMap = MapCatalog.mapIdFor(w.mapGroup, w.mapNum);
        }
      }
      warps[mapId] = list;
    } else {
      const hand = Versions.WARPS[mapId];
      const out: Warp[] = [];
      if (hand) for (let i = 1; i <= luaLen(hand); i++) out.push(luaGet(hand, i) as Warp);
      warps[mapId] = out;
    }
  }
  const connections: Record<string, { dir: string; map: string; offset: number }[]> = {};
  for (const mapId of mapOrder) {
    const conns = (romConns[mapId] ?? []) as Tbl[];
    const fixed: { dir: string; map: string; offset: number }[] = [];
    for (const c of conns) {
      let dest: string | undefined = c.map;
      if ((!dest || /^g[0-9]+_m[0-9]+$/.test(dest)) && c.mapGroup !== undefined) {
        dest = MapCatalog.mapIdFor(c.mapGroup, c.mapNum) ?? dest;
      } else if (dest) {
        dest = MapCatalog.resolve(dest) ?? dest;
      }
      if (dest) {
        fixed.push({ dir: c.dir, map: dest, offset: tonumber(c.offset) ?? 0 });
      }
    }
    connections[mapId] = fixed;
  }
  return [warps, connections];
}

/** Lua: extract_island1.lua:518-550 -- warps.lua + connections.lua. */
function writeWarpsAndConnections(cache: Cache, mapOrder: string[], warps: Record<string, Warp[]>,
  connections: Record<string, { dir: string; map: string; offset: number }[]>): void {
  const wl = ["return {\n"];
  for (const mapId of mapOrder) {
    const list = warps[mapId] ?? [];
    wl.push(format("  %s = {\n", mapId));
    for (const w of list) {
      const dest = w.destMap ?? MapCatalog.mapIdFor(w.mapGroup, w.mapNum);
      if (dest) {
        wl.push(format("    { x = %d, y = %d, destMap = %q, destWarp = %d },\n",
          w.x, w.y, dest, w.destWarp ?? 1));
      } else {
        // Keep ROM index slot even if dest group is outside this extract.
        wl.push(format("    { x = %d, y = %d, destMap = nil, destWarp = %d, mapGroup = %d, mapNum = %d },\n",
          w.x, w.y, w.destWarp ?? 1, w.mapGroup ?? 0, w.mapNum ?? 0));
      }
    }
    wl.push("  },\n");
  }
  wl.push("}\n");
  cache.write(Extract.CACHE_ROOT + "/warps.lua", wl.join(""));

  const cl = ["return {\n"];
  for (const mapId of mapOrder) {
    const conns = connections[mapId] ?? [];
    cl.push(format("  %s = {\n", mapId));
    for (const c of conns) {
      cl.push(format("    { dir = %q, map = %q, offset = %d },\n", c.dir, c.map, tonumber(c.offset) ?? 0));
    }
    cl.push("  },\n");
  }
  cl.push("}\n");
  cache.write(Extract.CACHE_ROOT + "/connections.lua", cl.join(""));
}

/** Lua: extract_island1.lua:391-407 / 1705-1721 -- mid_index.lua. */
function writeMidIndex(cache: Cache, pairNames: string[], midsByPair: Record<string, number[]>, midIndex: MidIndex): void {
  const miL = ["return {\n"];
  for (const pairName of pairNames) {
    miL.push(format("  [%q] = {\n", pairName));
    for (const mid of midsByPair[pairName] ?? []) {
      const info2 = midIndex[pairName]![mid]!;
      miL.push(format("    [%d] = { tiles = {%s}, coll = %d, behavior = %d, category = %q },\n",
        mid,
        info2.tiles.map((t) => tostring(t)).join(","),
        info2.coll,
        info2.behavior,
        info2.category));
    }
    miL.push("  },\n");
  }
  miL.push("}\n");
  cache.write(Extract.CACHE_ROOT + "/mid_index.lua", miL.join(""));
}

/** The minigame art extractors Brian runs after marts (not ported). */
const ONLINE_EXTRACTORS: Record<string, ((rom: Rom, cache: Cache, opts: { cacheRoot: string }) => unknown) | undefined> = {
  online_ui_extract: (rom, cache, opts) => OnlineUiExtract.run(rom, cache, opts),
  berry_crush_extract: undefined, // NOT FAITHFUL: not ported
  dodrio_extract: undefined, // NOT FAITHFUL: not ported
  pokemon_jump_extract: undefined, // NOT FAITHFUL: not ported
};

function runOnlineExtractors(rom: Rom, cache: Cache): void {
  for (const name of ["online_ui_extract", "berry_crush_extract", "dodrio_extract", "pokemon_jump_extract"]) {
    const run = ONLINE_EXTRACTORS[name];
    if (run) run(rom, cache, { cacheRoot: Extract.CACHE_ROOT });
  }
}

/** pcall(MartsExtract.run, ...) and its log line. */
function runMarts(rom: Rom, cache: Cache): void {
  let detailM: Tbl | undefined;
  try {
    [detailM] = MartsExtract.run(rom, cache, { cacheRoot: Extract.CACHE_ROOT });
  } catch {
    detailM = undefined;
  }
  if (detailM) {
    console.log(format("[marts] %d lists → %s", detailM.listCount ?? 0, tostring(detailM.path)));
  }
}

// Lua: extract_island1.lua:242 -- Patch meta.json cache_version / native_version
// in place (native-only migration).
function bump_meta_version(cache: Cache): void {
  const raw = cache.read(Extract.CACHE_ROOT + "/meta.json");
  if (raw === undefined) return;
  const S = "[ \\t\\n\\v\\f\\r]*"; // Lua %s*
  let updated = raw.replace(new RegExp('"cache_version"' + S + ":" + S + "[0-9]+", "g"),
    '"cache_version":' + tostring(Versions.CACHE_VERSION));
  if (new RegExp('"native_version"' + S + ":").test(updated)) {
    updated = updated.replace(new RegExp('"native_version"' + S + ":" + S + "[0-9]+", "g"),
      '"native_version":' + tostring(Versions.NATIVE_VERSION ?? 1));
  } else {
    updated = updated.replace(new RegExp('"cache_version"' + S + ":" + S + "[0-9]+", "g"),
      (m) => m + ',"native_version":' + tostring(Versions.NATIVE_VERSION ?? 1));
  }
  cache.write(Extract.CACHE_ROOT + "/meta.json", updated);
}

/** raw:find('"md5"%s*:%s*"' .. want .. '"') */
function findMd5(raw: string, want: string): boolean {
  const esc = want.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp('"md5"[ \\t\\n\\v\\f\\r]*:[ \\t\\n\\v\\f\\r]*"' + esc + '"').test(raw);
}

/** raw:find('"cache_version"%s*:%s*' .. tostring(Versions.CACHE_VERSION)) */
function findCacheVersion(raw: string): boolean {
  const esc = tostring(Versions.CACHE_VERSION).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp('"cache_version"[ \\t\\n\\v\\f\\r]*:[ \\t\\n\\v\\f\\r]*' + esc).test(raw);
}

/** load(src, name, "t", {}) of a data chunk; undefined where the Lua's chunk would be nil or fail. */
function loadChunk(src: string): any {
  try {
    return readLuaLiteral(src);
  } catch {
    return undefined;
  }
}

// Lua: extract_island1.lua:262 -- Stable map pack order: outdoors first, then
// interiors. Include Kanto starter + Pewter (Running Shoes / Brock) with Island 1.
const MAP_ORDER = [
  "SEVII_ONE_ISLAND",
  "SEVII_ONE_ISLAND_KINDLE_ROAD",
  "SEVII_ONE_ISLAND_TREASURE_BEACH",
  "SEVII_ONE_ISLAND_POKECENTER",
  "SEVII_ONE_ISLAND_POKECENTER_2F",
  "SEVII_ONE_ISLAND_HARBOR",
  "SEVII_ONE_ISLAND_HOUSE1",
  "SEVII_ONE_ISLAND_HOUSE2",
  "FR_PALLET_TOWN",
  "FR_ROUTE_1",
  "FR_VIRIDIAN_CITY",
  "FR_ROUTE_2",
  "FR_PLAYERS_HOUSE_1F",
  "FR_PLAYERS_HOUSE_2F",
  "FR_RIVALS_HOUSE",
  "FR_OAKS_LAB",
  "FR_PEWTER_CITY",
  "FR_PEWTER_CITY_GYM",
];

/** Lua: extract_island1.lua:302-308 -- full gMapGroups census, registered with MAP_ORDER in front. */
function census(rom: Rom, version: any): string[] {
  MapCatalog.rebuildIndex();
  const c = assertOk(MapTree.walk(rom, version));
  const [mapOrder, byEngine] = MapCatalog.allOrder(c, MAP_ORDER);
  MapCatalog.registerOrder(rom, version, mapOrder, byEngine);
  rom.clearCache();
  return mapOrder;
}

export interface RunOpts { skipScriptsAndOw?: boolean }

export const Extract = {
  // Lua: extract_island1.lua:19-31 (a proxy onto CachePaths)
  get CACHE_ROOT(): string { return CachePaths.CACHE_ROOT; },
  set CACHE_ROOT(v: string) { CachePaths.CACHE_ROOT = v; },
  get NATIVE_ROOT(): string { return CachePaths.NATIVE_ROOT; },
  set NATIVE_ROOT(v: string) { CachePaths.NATIVE_ROOT = v; },

  STAGE_COUNT: 7,

  // Lua: extract_island1.lua:107
  padEven: pad_even,

  // Lua: extract_island1.lua:184
  findImport(imports: Imports): [string | undefined, ImportInfo | undefined] {
    for (const id of GameVersion.ORDER) {
      if (GameVersion.generation(id) === 3) {
        const info = imports.info(id);
        if (info) return [id, info];
      }
    }
    return [undefined, undefined];
  },

  // Lua: extract_island1.lua:195
  cacheReady(cache: Cache | undefined): boolean {
    return !!cache && cache.exists(Extract.CACHE_ROOT + "/meta.json") && Extract.nativeReady(cache);
  },

  // Lua: extract_island1.lua:200
  nativeReady(cache: Cache | undefined): boolean {
    if (!cache) return false;
    if (!cache.exists(Extract.NATIVE_ROOT + "/manifest.lua")) return false;
    if (!OwExtract.ready(cache, Extract.CACHE_ROOT)) return false;
    if (!AnimPack.ready(cache, Extract.CACHE_ROOT)) return false;
    // Dual-layer under/over atlases (NATIVE_VERSION >= 5).
    const src = cache.read(Extract.NATIVE_ROOT + "/manifest.lua");
    if (src === undefined) return false;
    const man = loadChunk(src);
    if (!man || (tonumber(man.native_version) ?? 0) < (Versions.NATIVE_VERSION ?? 5)) {
      return false;
    }
    let checked = 0;
    const pairsT = man.pairs ?? {};
    for (const pairName of luaKeys(pairsT)) {
      if (!cache.exists(Extract.NATIVE_ROOT + "/" + tostring(pairName) + "/mids_over.idx")) {
        return false;
      }
      checked = checked + 1;
    }
    return checked > 0;
  },

  // Lua: extract_island1.lua:225
  metaMd5Matches(cache: Cache, md5: string): boolean {
    const raw = cache.read(Extract.CACHE_ROOT + "/meta.json");
    if (raw === undefined) return false;
    const want = Versions.identitySha1(md5) ?? Versions.normalizeMd5(md5);
    return want !== undefined && findMd5(raw, want);
  },

  // Lua: extract_island1.lua:232
  metaMatches(cache: Cache, md5: string): boolean {
    const raw = cache.read(Extract.CACHE_ROOT + "/meta.json");
    if (raw === undefined) return false;
    const want = Versions.identitySha1(md5) ?? Versions.normalizeMd5(md5);
    return want !== undefined && findMd5(raw, want) && findCacheVersion(raw);
  },

  // Lua: extract_island1.lua:283
  run(imports: Imports, cache: Cache, progressCb?: ProgressCb, opts?: RunOpts): [boolean, any] {
    const [importId, info] = Extract.findImport(imports);
    if (!importId || !info) {
      return [false, "no FireRed/LeafGreen optional import installed"];
    }
    const [version, verr] = Versions.lookup(info.md5);
    if (!version) return [false, verr];

    if (Extract.cacheReady(cache) && Extract.metaMd5Matches(cache, info.md5)) {
      if (Extract.metaMatches(cache, info.md5) && Extract.nativeReady(cache)) {
        return [true, { skipped: true, md5: info.md5 }];
      }
    }

    progress(progressCb, 0, "open_rom", 0, 1);
    let [rom, rerr] = Rom.open(imports, importId);
    if (!rom) return [false, rerr];

    // Full gMapGroups census -> CacheFS. Seeds only affect pack order (front).
    const mapOrder = census(rom, version);
    progress(progressCb, 0, "census", mapOrder.length, mapOrder.length);

    // Collect which pairs registered maps need, load each once.
    const pairNames = neededPairs(mapOrder);

    progress(progressCb, 1, "tilesets", 0, pairNames.length);
    let bundles: Record<string, TilesetBundle> | undefined = loadBundles(rom, version, pairNames, progressCb);
    rom.clearCache();

    progress(progressCb, 2, "maps", 0, 1);
    const grids: Record<string, Grid> = {};
    const dropped: string[] = [];
    for (const mapId of mapOrder) {
      const spec = Versions.MAPS[mapId];
      const layoutName = spec && spec.layout;
      const layoutSpec = layoutName && version.layouts && version.layouts[layoutName];
      if (layoutSpec && bundles[spec.pair]) {
        const grid = Maps.loadGrid(rom, layoutSpec);
        grid.map_id = mapId;
        grid.kind = spec.kind;
        grid.pair = spec.pair;
        grid.environment = spec.environment;
        grids[mapId] = pad_even(grid);
      } else if (spec) {
        dropped.push(mapId);
        console.log("[extract] drop map " + tostring(mapId) + ": "
          + (!layoutSpec ? "missing layout spec" : "missing tileset pair " + tostring(spec.pair)));
      }
    }
    if (dropped.length > 0) {
      return [false, "dropped " + tostring(dropped.length) + " map(s): " + dropped.join(",")];
    }
    const borders: Record<string, Border> = {};
    for (const mapId of mapOrder) {
      if (grids[mapId]) {
        borders[mapId] = Maps.loadBorder(rom, version, mapId);
      }
    }
    AltLayouts.build(rom, version, grids, borders, pad_even);
    const extractedScripts = ExtractScripts.extractFromRom(rom, version);
    const scriptMids = script_mids_by_pair(extractedScripts, grids);
    rom.clearCache();

    const midsByPair = unique_mids_by_pair(grids, scriptMids);
    let totalMids = 0;
    for (const list of Object.values(midsByPair)) totalMids = totalMids + list.length;

    // Build midIndex dictionary without 2bpp quantize
    const midIndex: MidIndex = {};
    for (const pairName of pairNames) {
      midIndex[pairName] = {};
      const pairMids = midsByPair[pairName] ?? [];
      for (const mid of pairMids) {
        const behavior = Tileset.behaviorOf(bundles[pairName]!, mid) ?? 0;
        const coll = Collision.fromCell(mid, 0, behavior, "outdoor")[0] ?? 0;
        midIndex[pairName]![mid] = {
          tiles: [0, 0, 0, 0],
          coll,
          behavior,
          category: "misc",
        };
      }
    }
    writeMidIndex(cache, pairNames, midsByPair, midIndex);

    write_json(cache, Extract.CACHE_ROOT + "/meta.json", {
      cache_version: Versions.CACHE_VERSION,
      native_version: Versions.NATIVE_VERSION ?? 5,
      md5: Versions.normalizeMd5(info.md5),
      version_id: version.id,
      import_id: importId,
      mid_count: totalMids,
      tile_count: 0,
      block_count: 0,
      imageWidth: 0,
      imageHeight: 0,
      tilesPerRow: 16,
      maps: mapOrder,
    });

    const [warps, connections] = warpsAndConnections(imports, importId, version, mapOrder);

    // Native FRLG mid atlas + pret palettes (game3 live path).
    progress(progressCb, 6, "native_pack", 0, 1);
    const warpCells: Record<string, Set<number>> = {};
    for (const mapId of Object.keys(warps)) {
      const set = new Set<number>();
      for (const w of warps[mapId]!) {
        const x = tonumber(w.x), y = tonumber(w.y);
        if (x !== undefined && y !== undefined) set.add(NativePack.warpKey(x, y));
      }
      warpCells[mapId] = set;
    }
    NativePack.writeExtract(
      cache, Extract.CACHE_ROOT, bundles, grids, borders, pairNames, midIndex,
      Tileset.behaviorOf, Collision.fromCell, scriptMids, warpCells);

    // OW sprites + tileset anims + encounters + audio + chrome from ROM
    {
      const rom2 = assertOk(Rom.open(imports, importId));
      if (!(opts && opts.skipScriptsAndOw)) {
        HelpExtract.writeExtract(rom2, cache);
        QuestLogExtract.writeExtract(rom2, cache);
        ObjectInteractionsExtract.writeExtract(rom2, cache, Extract.CACHE_ROOT, version);
      }
      const midLists: Record<string, number[]> = {};
      for (const pairName of pairNames) {
        midLists[pairName] = NativePack.collectMidsForPair(grids, borders, pairName, scriptMids);
      }
      AnimPack.writeExtract(rom2, cache, Extract.CACHE_ROOT, bundles, midLists, version);
      if (!(opts && opts.skipScriptsAndOw)) {
        OwExtract.writeExtract(rom2, cache, Extract.CACHE_ROOT, version);
        EncountersExtract.writeExtract(rom2, cache, Extract.CACHE_ROOT, version);
        FieldEffectExtract.writeExtract(rom2, cache, Extract.CACHE_ROOT, version);
        runMarts(rom2, cache);
        runOnlineExtractors(rom2, cache);
      }
      rom2.clearCache();
    }

    writeWarpsAndConnections(cache, mapOrder, warps, connections);

    let scriptBundle: ScriptBundle | undefined;
    if (!(opts && opts.skipScriptsAndOw)) {
      // game3 scripts/events/text/movements from ROM MapEvents + BFS
      rom = assertOk(Rom.open(imports, importId));
      scriptBundle = ExtractScripts.writeBundleFromRom(
        rom, cache, Extract.CACHE_ROOT, version, extractedScripts);

      // Extract full trainer parties, AI flags, dialogs, and sprites
      TrainerExtract.run(rom, cache, {
        cacheRoot: Extract.CACHE_ROOT,
        scripts: scriptBundle && scriptBundle.scripts,
        text: scriptBundle && scriptBundle.text,
      });

      // Normalized map_tree mirror
      {
        const [okTree, treeDetail] = MapTreeExtract.run(rom, cache, {
          version,
          root: Extract.CACHE_ROOT + "/map_tree",
        });
        if (!okTree) {
          console.log("[extract] map_tree warn: " + tostring(treeDetail));
        }
      }
      rom.clearCache();
    }

    progress(progressCb, 7, "done", 1, 1);
    bundles = undefined;
    return [true, {
      md5: info.md5,
      tile_count: 0,
      block_count: 0,
      mid_count: totalMids,
      map_count: mapOrder.length,
      script_count: scriptBundle && scriptBundle.scriptCount,
      script_seeds: scriptBundle && scriptBundle.seedCount,
    }];
  },

  // Lua: extract_island1.lua:1888
  runScriptsAndOw(imports: Imports, cache: Cache,
    progressCb?: (cur: number, total: number, stageName: string, a?: number, b?: number) => void): [boolean, any?] {
    const [importId, info] = Extract.findImport(imports);
    if (!importId || !info) {
      return [false, "no FireRed/LeafGreen optional import installed"];
    }
    const [version, verr] = Versions.lookup(info.md5);
    if (!version) return [false, verr];

    const rom = assertOk(Rom.open(imports, importId));

    if (progressCb) progressCb(1, 4, "help_quest_log", 0, 1);
    HelpExtract.writeExtract(rom, cache);
    QuestLogExtract.writeExtract(rom, cache);
    ObjectInteractionsExtract.writeExtract(rom, cache, Extract.CACHE_ROOT, version);

    if (progressCb) progressCb(2, 4, "ow_sprites", 0, 1);
    OwExtract.writeExtract(rom, cache, Extract.CACHE_ROOT, version);
    EncountersExtract.writeExtract(rom, cache, Extract.CACHE_ROOT, version);
    FieldEffectExtract.writeExtract(rom, cache, Extract.CACHE_ROOT, version);

    if (progressCb) progressCb(3, 4, "scripts_events", 0, 1);
    const scriptBundle = ExtractScripts.writeBundleFromRom(rom, cache, Extract.CACHE_ROOT, version);

    if (progressCb) progressCb(4, 4, "trainers_map_tree", 0, 1);
    TrainerExtract.run(rom, cache, {
      cacheRoot: Extract.CACHE_ROOT,
      scripts: scriptBundle && scriptBundle.scripts,
      text: scriptBundle && scriptBundle.text,
    });

    const [okTree, treeDetail] = MapTreeExtract.run(rom, cache, {
      version,
      root: Extract.CACHE_ROOT + "/map_tree",
    });
    if (!okTree) {
      console.log("[extract] map_tree warn: " + tostring(treeDetail));
    }

    runMarts(rom, cache);
    runOnlineExtractors(rom, cache);

    rom.clearCache();
    return [true];
  },

  /**
   * Lua: extract_island1.lua:1953 -- Rebuild native blobs only (demake cache
   * already valid). Seconds, not minutes. Uses full gMapGroups census →
   * CacheFS (same pair set as Extract.run).
   */
  runNativeOnly(imports: Imports, cache: Cache, progressCb?: ProgressCb): [boolean, any] {
    const [importId, info] = Extract.findImport(imports);
    if (!importId || !info) {
      return [false, "no FireRed/LeafGreen optional import installed"];
    }
    const [version, verr] = Versions.lookup(info.md5);
    if (!version) return [false, verr];
    if (!Extract.cacheReady(cache) || !Extract.metaMd5Matches(cache, info.md5)) {
      return [false, "demake cache missing — run full extract first"];
    }

    progress(progressCb, 0, "open_rom", 0, 1);
    const [rom, rerr] = Rom.open(imports, importId);
    if (!rom) return [false, rerr];

    const mapOrder = census(rom, version);
    const pairNames = neededPairs(mapOrder);

    progress(progressCb, 1, "tilesets", 0, pairNames.length);
    let bundles: Record<string, TilesetBundle> | undefined = loadBundles(rom, version, pairNames, progressCb);
    rom.clearCache();

    progress(progressCb, 2, "maps", 0, 1);
    const grids: Record<string, Grid> = {};
    for (const mapId of mapOrder) {
      const spec = Versions.MAPS[mapId];
      const layoutName = spec && spec.layout;
      const layoutSpec = layoutName && version.layouts && version.layouts[layoutName];
      if (layoutSpec && bundles[spec.pair]) {
        const grid = Maps.loadGrid(rom, layoutSpec);
        grid.map_id = mapId;
        grid.kind = spec.kind;
        grid.pair = spec.pair;
        grid.environment = spec.environment;
        grids[mapId] = pad_even(grid);
      }
    }
    const borders: Record<string, Border> = {};
    for (const mapId of mapOrder) {
      if (grids[mapId]) {
        borders[mapId] = Maps.loadBorder(rom, version, mapId);
      }
    }
    AltLayouts.build(rom, version, grids, borders, pad_even);
    const scriptMids = script_mids_by_pair(ExtractScripts.extractFromRom(rom, version), grids);
    rom.clearCache();

    // load(mid_index.lua): [pair][mid] = { tiles, coll, behavior, category }.
    // readLuaLiteral makes a table keyed exactly 1..n an array; mids are keys
    // here, so such a table is turned back into one keyed by mid.
    let midIndex: MidIndex = {};
    {
      const src = cache.read(Extract.CACHE_ROOT + "/mid_index.lua");
      if (src !== undefined) {
        const chunk = loadChunk(src);
        if (chunk && typeof chunk === "object") {
          const out: MidIndex = {};
          for (const pair of luaKeys(chunk)) {
            const t = luaGet(chunk, pair) as object;
            const keyed: Record<number, MidInfo> = {};
            if (t && typeof t === "object") {
              for (const k of luaKeys(t)) keyed[k as number] = luaGet(t, k) as MidInfo;
            }
            out[tostring(pair)] = keyed;
          }
          midIndex = out;
        }
      }
    }

    progress(progressCb, 6, "native_pack", 0, 1);
    NativePack.writeExtract(
      cache, Extract.CACHE_ROOT, bundles, grids, borders, pairNames, midIndex,
      Tileset.behaviorOf, Collision.fromCell, scriptMids);

    {
      const rom2 = assertOk(Rom.open(imports, importId));
      HelpExtract.writeExtract(rom2, cache);
      QuestLogExtract.writeExtract(rom2, cache);
      ObjectInteractionsExtract.writeExtract(rom2, cache, Extract.CACHE_ROOT, version);
      const midLists: Record<string, number[]> = {};
      for (const pairName of pairNames) {
        midLists[pairName] = NativePack.collectMidsForPair(grids, borders, pairName, scriptMids);
      }
      AnimPack.writeExtract(rom2, cache, Extract.CACHE_ROOT, bundles, midLists, version);
      OwExtract.writeExtract(rom2, cache, Extract.CACHE_ROOT, version);
      EncountersExtract.writeExtract(rom2, cache, Extract.CACHE_ROOT, version);
      FieldEffectExtract.writeExtract(rom2, cache, Extract.CACHE_ROOT, version);
      rom2.clearCache();
    }
    bump_meta_version(cache);

    progress(progressCb, 7, "done", 1, 1);
    bundles = undefined;
    return [true, { native_only: true, md5: info.md5, pairs: pairNames.length, maps: mapOrder.length }];
  },

  /** Lua: extract_island1.lua:603 (local, never called) -- see _dormant_quantize_run. */
  _dormantQuantizeRun(imports: Imports, cache: Cache, progressCb?: ProgressCb): [boolean, any] {
    return _dormant_quantize_run(imports, cache, progressCb);
  },
};

// ---------------------------------------------------------------- dormant

type Ramp = number[][];

/**
 * Lua: extract_island1.lua:603 -- Legacy 2bpp quantize extract preserved as
 * dormant code (a local nothing calls). Ported for completeness; it has no
 * reference output to compare against.
 * NOT FAITHFUL (order): where the Lua walks pairs(grids) / pairs(assigns) /
 * pairs(bank), this walks insertion order (map order) / ascending slot keys;
 * the Lua's hash order is unspecified.
 */
function _dormant_quantize_run(imports: Imports, cache: Cache, progressCb?: ProgressCb): [boolean, any] {
  const [importId, info] = Extract.findImport(imports);
  if (!importId || !info) {
    return [false, "no FireRed/LeafGreen optional import installed"];
  }
  const [version, verr] = Versions.lookup(info.md5);
  if (!version) return [false, verr];

  if (Extract.cacheReady(cache) && Extract.metaMd5Matches(cache, info.md5)) {
    if (Extract.metaMatches(cache, info.md5) && Extract.nativeReady(cache)) {
      return [true, { skipped: true, md5: info.md5 }];
    }
    // Same ROM + same cache_version, but native pack incomplete → rebuild native
    // only. cache_version bumps (map catalog / warp closure) always full-extract.
    const raw = cache.read(Extract.CACHE_ROOT + "/meta.json") ?? "";
    const sameVer = findCacheVersion(raw);
    if (sameVer) {
      return Extract.runNativeOnly(imports, cache, progressCb);
    }
  }

  progress(progressCb, 0, "open_rom", 0, 1);
  let [rom, rerr] = Rom.open(imports, importId);
  if (!rom) return [false, rerr];

  // Full gMapGroups census → CacheFS. Seeds only affect pack order (front).
  const mapOrder = census(rom, version);
  progress(progressCb, 0, "census", mapOrder.length, mapOrder.length);

  // Collect which pairs registered maps need, load each once.
  const pairNames = neededPairs(mapOrder);

  progress(progressCb, 1, "tilesets", 0, pairNames.length);
  let bundles: Record<string, TilesetBundle> | undefined = loadBundles(rom, version, pairNames, progressCb);
  rom.clearCache();

  progress(progressCb, 2, "maps", 0, 1);
  // Load every registered map grid from ROM MapLayout pointers.
  const grids: Record<string, Grid> = {};
  for (const mapId of mapOrder) {
    const spec = Versions.MAPS[mapId];
    const layoutName = spec && spec.layout;
    const layoutSpec = layoutName && version.layouts && version.layouts[layoutName];
    if (layoutSpec && bundles[spec.pair]) {
      const grid = Maps.loadGrid(rom, layoutSpec);
      grid.map_id = mapId;
      grid.kind = spec.kind;
      grid.pair = spec.pair;
      grid.environment = spec.environment;
      grids[mapId] = grid;
    }
  }
  const borders: Record<string, Border> = {};
  for (const mapId of mapOrder) {
    if (grids[mapId]) {
      borders[mapId] = Maps.loadBorder(rom, version, mapId);
    }
  }
  rom.clearCache();
  for (const mapId of Object.keys(grids)) {
    const grid = grids[mapId]!;
    const spec = Versions.MAPS[mapId];
    grid.pair = (spec && spec.pair) || "sevii_outdoor";
    grid.environment = spec && spec.environment;
    grids[mapId] = pad_even(grid);
  }

  const midsByPair = unique_mids_by_pair(grids);
  let totalMids = 0;
  for (const list of Object.values(midsByPair)) totalMids = totalMids + list.length;

  progress(progressCb, 3, "quantize", 0, totalMids);
  const sheet: Sheet = Quantize.Sheet();
  let voidTidForBorder: number | undefined;
  const PAIR_TILESET: Record<string, string> = Versions.PAIR_TILESET ?? {
    sevii_outdoor: "SEVII_OUTDOOR",
    network: "SEVII_NETWORK",
    house: "SEVII_HOUSE",
    harbor: "SEVII_HARBOR",
  };
  // Per-pair palette banks (swap on warp via mapDef.tileset → specialTilesets).
  const banks: Record<string, Record<number, Ramp>> = {}; // [tilesetId] = { [slot] = ramp }
  const tilePalettesByTileset: Record<string, Record<number, number>> = {}; // [tilesetId] = { [tileId+1] = localSlot }
  const tilesetIdList: string[] = [];
  {
    const seen = new Set<string>();
    for (const k of Object.keys(PAIR_TILESET)) {
      const tid = PAIR_TILESET[k]!;
      if (!seen.has(tid)) {
        seen.add(tid);
        tilesetIdList.push(tid);
        banks[tid] = {};
        tilePalettesByTileset[tid] = {};
      }
    }
    tilesetIdList.sort();
  }
  const specialPals = PaletteRules.specialPalettes();
  const outdoorTs = PAIR_TILESET.sevii_outdoor ?? "SEVII_OUTDOOR";
  // Outdoor LAB trial (codebook + shared-Y + MRF) kept behind this flag, but left
  // off: it oscillates between flat trees / sand checkers and cliff+water banding.
  // Indoor pairs stay on LAB; outdoor uses fixed special pals + Y thresholds.
  const USE_LAB_FOR_OUTDOOR = false;
  // Outdoor-only spatial MRF after unary assign (only when USE_LAB_FOR_OUTDOOR).
  const USE_OUTDOOR_MRF = true;
  if (!USE_LAB_FOR_OUTDOOR) {
    const nSeed = Math.max(8, PaletteRules.TREE_CLIFF_SLOT ?? 8);
    for (let i = 1; i <= nSeed; i++) {
      if (specialPals[i]) {
        banks[outdoorTs]![i] = specialPals[i]!;
      }
    }
  }

  // [tilesetId][slot] = outdoor terrain family string (or nil)
  const bankSlotFamily: Record<string, Record<number, string>> = {};

  const slotsOf = (bank: Record<number, Ramp>): number[] => Object.keys(bank).map(Number);

  const place_in_bank = (tilesetId: string, ramp: Ramp): number => {
    const bank = banks[tilesetId]!;
    let bestS: number | undefined, bestD = 1e18;
    for (const s of slotsOf(bank)) {
      const d = QuantizeLab.rampDistance(ramp, bank[s]!);
      if (d < bestD) { bestS = s; bestD = d; }
    }
    if (bestS !== undefined && bestD < QuantizeLab.NEAR_DUPE_EPS) {
      return bestS;
    }
    let nextSlot = 1;
    while (bank[nextSlot]) nextSlot = nextSlot + 1;
    if (nextSlot > Quantize.MAX_PALETTE_SLOTS) {
      return bestS ?? 1;
    }
    bank[nextSlot] = ramp;
    return nextSlot;
  };

  // Outdoor: tighter near-dupe + never reuse a slot owned by another terrain family.
  const place_in_bank_outdoor = (tilesetId: string, ramp: Ramp, primaryFam: string | undefined): number => {
    const bank = banks[tilesetId]!;
    let famBySlot = bankSlotFamily[tilesetId];
    if (!famBySlot) {
      famBySlot = {};
      bankSlotFamily[tilesetId] = famBySlot;
    }
    const eps = QuantizeLab.OUTDOOR_NEAR_DUPE_EPS;
    let bestS: number | undefined, bestD = 1e18;
    for (const s of slotsOf(bank)) {
      const existingFam = famBySlot[s];
      if (!primaryFam || !existingFam || existingFam === primaryFam) {
        const d = QuantizeLab.rampDistance(ramp, bank[s]!);
        if (d < bestD) { bestS = s; bestD = d; }
      }
    }
    if (bestS !== undefined && bestD < eps) {
      if (primaryFam && !famBySlot[bestS]) {
        famBySlot[bestS] = primaryFam;
      }
      return bestS;
    }
    let nextSlot = 1;
    while (bank[nextSlot]) nextSlot = nextSlot + 1;
    if (nextSlot > Quantize.MAX_PALETTE_SLOTS) {
      return bestS ?? 1;
    }
    bank[nextSlot] = ramp;
    if (primaryFam) famBySlot[nextSlot] = primaryFam;
    return nextSlot;
  };

  // Like place_in_bank, but only merges with ramps whose shade 3 is already
  // true black (door-mat chamfer tiles). Never absorb into gray/coral darks.
  const place_black_locked = (tilesetId: string, ramp: Ramp): number => {
    const bank = banks[tilesetId]!;
    let bestS: number | undefined, bestD = 1e18;
    for (const s of slotsOf(bank)) {
      const existing = bank[s]!;
      const d4 = existing[3];
      if (d4 && d4[0] === 0 && d4[1] === 0 && d4[2] === 0) {
        const d = QuantizeLab.rampDistance(ramp, existing);
        if (d < bestD) { bestS = s; bestD = d; }
      }
    }
    if (bestS !== undefined && bestD < QuantizeLab.NEAR_DUPE_EPS) {
      return bestS;
    }
    let nextSlot = 1;
    while (bank[nextSlot]) nextSlot = nextSlot + 1;
    if (nextSlot > Quantize.MAX_PALETTE_SLOTS) {
      return bestS ?? place_in_bank(tilesetId, ramp);
    }
    bank[nextSlot] = [
      [ramp[0]![0]!, ramp[0]![1]!, ramp[0]![2]!],
      [ramp[1]![0]!, ramp[1]![1]!, ramp[1]![2]!],
      [ramp[2]![0]!, ramp[2]![1]!, ramp[2]![2]!],
      [0, 0, 0],
    ];
    return nextSlot;
  };

  const ensure_black_slot = (tilesetId: string): number => {
    const bank = banks[tilesetId]!;
    for (const s of slotsOf(bank)) {
      const existing = bank[s]!;
      let ok = true;
      for (let i = 1; i <= 4; i++) {
        const c = existing[i - 1];
        if (!c || c[0] !== 0 || c[1] !== 0 || c[2] !== 0) {
          ok = false;
          break;
        }
      }
      if (ok) return s;
    }
    return place_in_bank(tilesetId, [
      [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0],
    ]);
  };

  const record_tile_pal = (tilesetId: string, tileId: number, slot: number): void => {
    tilePalettesByTileset[tilesetId]![tileId + 1] = slot;
  };

  // Outdoor bpp dedupe must not share one tile id across incompatible ramps
  // (e.g. cliff brown + roof magenta → purple cliffs when the last writer wins).
  const OUTDOOR_SLOT_FAMILY: Record<number, string> = {
    1: "water", 2: "grass", 3: "sand", 4: "cliff",
    5: "front", 6: "roof", 7: "metal", 8: "tree",
    9: "tree_cliff",
  };
  const outdoor_intern = (sh: Sheet, bpp: number[], tilesetId: string, slot: number): number => {
    let tid = Quantize.intern(sh, bpp);
    const existing = tilePalettesByTileset[tilesetId]![tid + 1];
    if (existing !== undefined && existing !== slot) {
      const fa = OUTDOOR_SLOT_FAMILY[existing];
      const fb = OUTDOOR_SLOT_FAMILY[slot];
      if (fa && fb && fa !== fb) {
        tid = Quantize.internUnique(sh, bpp);
      }
    }
    record_tile_pal(tilesetId, tid, slot);
    return tid;
  };

  const midIndex: MidIndex = {};
  let done = 0;

  // ── Tier 1: MAP ──────────────────────────────────────────────────────────
  // Classify every cell; remember per-mid base category and per-quad neighbour
  // votes from the maps where that mid appears. Context only — not a force.
  const midBase: Record<string, Record<number, Tbl>> = {}; // [pair][mid] = { cat, env, kind, coll, beh }
  const quadVotes: Record<string, Record<number, Record<string, number>[]>> = {}; // [pair][mid][q] = { [category]=n }
  // Which side of a mid faces which map neighbour (cell is the mid's origin).
  const QUAD_NEIGH: [number, number][][] = [
    [[-1, 0], [0, -1]], // TL → W, N
    [[1, 0], [0, -1]], // TR → E, N
    [[-1, 0], [0, 1]], // BL → W, S
    [[1, 0], [0, 1]], // BR → E, S
  ];

  const cellCat: Record<string, string[]> = {}; // [mapId] = flat array of categories (0-based)
  for (const mapId of Object.keys(grids)) {
    const grid = grids[mapId]!;
    const pairName = grid.pair ?? "sevii_outdoor";
    const bundle = bundles[pairName]!;
    const cats: string[] = [];
    midBase[pairName] = midBase[pairName] ?? {};
    grid.cells.forEach((cell, i) => {
      const beh = Tileset.behaviorOf(bundle, cell.mid);
      const [cByte, cCat] = Collision.fromCell(cell.mid, cell.coll, beh, grid.kind);
      cats[i] = cCat;
      if (!midBase[pairName]![cell.mid]) {
        midBase[pairName]![cell.mid] = {
          cat: cCat,
          env: grid.environment,
          kind: grid.kind,
          coll: cByte,
          behavior: beh,
        };
      }
    });
    cellCat[mapId] = cats;
  }

  for (const mapId of Object.keys(grids)) {
    const grid = grids[mapId]!;
    const pairName = grid.pair ?? "sevii_outdoor";
    const cats = cellCat[mapId]!;
    quadVotes[pairName] = quadVotes[pairName] ?? {};
    const w = grid.width, h = grid.height;
    for (let cy = 0; cy <= h - 1; cy++) {
      for (let cx = 0; cx <= w - 1; cx++) {
        const idx = cy * w + cx;
        const mid = grid.cells[idx]!.mid;
        quadVotes[pairName]![mid] = quadVotes[pairName]![mid] ?? [{}, {}, {}, {}];
        for (let q = 0; q <= 3; q++) {
          for (const d of QUAD_NEIGH[q]!) {
            const nx = cx + d[0], ny = cy + d[1];
            if (nx >= 0 && ny >= 0 && nx < w && ny < h) {
              const ncat = cats[ny * w + nx]!;
              const votes = quadVotes[pairName]![mid]![q]!;
              votes[ncat] = (votes[ncat] ?? 0) + 1;
            }
          }
        }
      }
    }
  }

  // ── Tier 2 + 3: METATILE then TILE ───────────────────────────────────────
  // Indoor: top-down material codebook → quad assign → 2bpp bake.
  interface Quad { buf: number[]; pal?: number[]; slot?: number; role?: string }
  interface Item { pair: string; mid: number; coll: number; behavior: number; category: string; quads: Quad[]; profileId?: string }
  let pending: Item[] | undefined = []; // outdoor items for Y-threshold pass
  let indoorPending: Item[] | undefined = []; // { pair, mid, coll, beh, category, quads = {buf,pal}×4 }
  let slotYsByPair: Record<string, Record<number, number[]>> | undefined = {};

  for (const pairName of pairNames) {
    const bundle = bundles[pairName]!;
    const list = midsByPair[pairName] ?? [];
    slotYsByPair[pairName] = slotYsByPair[pairName] ?? {};
    const slotYs = slotYsByPair[pairName]!;
    for (const mid of list) {
      done = done + 1;
      if (done % 16 === 0) progress(progressCb, 3, "quantize", done, totalMids);
      const base = midBase[pairName] && midBase[pairName]![mid];
      let category: string = (base && base.cat) || "TOWN_PATH";
      const env = base && base.env;
      let collByte: number = (base && base.coll) || 0;
      // Lua: base and base.behavior or Tileset.behaviorOf(...) (0 is truthy in Lua)
      const beh: number = (base && base.behavior !== undefined && base.behavior !== null)
        ? base.behavior : Tileset.behaviorOf(bundle, mid);
      if (!base) {
        [collByte, category] = Collision.fromCell(mid, 0, beh, "town");
      }

      const [buf, palBuf] = Metatile.compositeBgr555(bundle, mid);
      const qVotes = (quadVotes[pairName] && quadVotes[pairName]![mid]) || [{}, {}, {}, {}];
      const profile = PaletteRules.resolveProfile(pairName, env, {
        indoor: (env === "INDOOR") || (pairName !== undefined && pairName !== "sevii_outdoor"),
      });

      if (profile.indoor || USE_LAB_FOR_OUTDOOR) {
        const quads: Quad[] = [];
        for (let q = 0; q <= 3; q++) {
          quads[q] = {
            buf: Metatile.quadrant(buf, q),
            pal: Metatile.quadrant(palBuf, q),
          };
        }
        indoorPending.push({
          pair: pairName,
          mid,
          coll: collByte,
          behavior: beh,
          category,
          quads,
        });
      } else {
        // Legacy outdoor Y-threshold / PaletteRules path (kept for rollback).
        let bottomIsRoof = false;
        if (PaletteRules.isBuildingCategory(category)) {
          for (let q = 2; q <= 3; q++) {
            const [qr, qg, qb] = Quantize.meanRgb(Metatile.quadrant(buf, q));
            if (profile.isRoofColor(qr, qg, qb)) {
              bottomIsRoof = true;
              break;
            }
          }
        }
        const bOpts: Tbl = {
          bottomIsRoof,
          indoor: false,
          pairName,
          environment: env,
          profileId: profile.id,
          _profile: profile,
        };
        const quads: Quad[] = [];
        for (let q = 0; q <= 3; q++) {
          const quad = Metatile.quadrant(buf, q);
          let cat = category;
          if (!PaletteRules.isLocked(category)
            && Quantize.tileHueSpread(quad) >= Quantize.MIXED_HUE_SPREAD) {
            cat = PaletteRules.ownCategory(category, qVotes[q]);
          }
          const [mr, mg, mb] = Quantize.meanRgb(quad);
          let slot = PaletteRules.slotForContext(cat, env, pairName, mr, mg, mb, q, bOpts);
          slot = PaletteRules.refineSlot(slot, cat, mr, mg, mb, q, bOpts);
          // Tree tip/stump mixed with cliff: green+brown in one 8×8 → hybrid
          // ramp (slot 9) + nearest-colour bake. Applies to TREE stumps and to
          // CLIFF/BLOCKED mids that paint the tip onto the rock face.
          if ((category === "TREE" || category === "CLIFF" || category === "COAST_CLIFF"
            || category === "BLOCKED")
            && PaletteRules.quadIsTreeCliffMix(quad, category)) {
            slot = PaletteRules.TREE_CLIFF_SLOT;
          }
          quads[q] = { buf: quad, slot, role: "slot_" + tostring(slot) };
          if (!PaletteRules.usesNearestRampBake(slot)) {
            slotYs[slot] = slotYs[slot] ?? [];
            const pool = slotYs[slot]!;
            for (let i = 1; i <= 64; i++) {
              pool.push(Quantize.bgr555_to_y(quad[i - 1] ?? 0));
            }
          }
        }
        pending.push({
          pair: pairName,
          mid,
          coll: collByte,
          behavior: beh,
          category,
          quads,
          profileId: profile.id,
        });
      }
    }
  }

  let slotThreshByPair: Record<string, Record<number, [number, number, number]>> | undefined = {};
  for (const pairName of Object.keys(slotYsByPair)) {
    const slotYs = slotYsByPair[pairName]!;
    const slotThresh: Record<number, [number, number, number]> = {};
    for (let slot = 1; slot <= 8; slot++) {
      const [t1, t2, t3] = Quantize.thresholdsFromYs(slotYs[slot]);
      slotThresh[slot] = [t1, t2, t3];
    }
    slotThreshByPair[pairName] = slotThresh;
  }

  for (const pairName of pairNames) {
    midIndex[pairName] = midIndex[pairName] ?? {};
  }
  for (const item of pending) {
    const tiles4: number[] = [];
    const slotThresh = slotThreshByPair[item.pair] ?? {};
    const tsId = PAIR_TILESET[item.pair] ?? outdoorTs;
    for (let q = 0; q <= 3; q++) {
      const slot = item.quads[q]!.slot!;
      let bpp: number[];
      if (PaletteRules.usesNearestRampBake(slot)) {
        const ramp = banks[tsId]![slot] ?? PaletteRules.RAMP[slot];
        [bpp] = Quantize.tileTo2bppAgainstRamp(item.quads[q]!.buf, ramp);
      } else {
        const th = slotThresh[slot] ?? [0.25, 0.5, 0.75];
        [bpp] = Quantize.tileTo2bpp(item.quads[q]!.buf, th[0], th[1], th[2]);
      }
      tiles4[q] = outdoor_intern(sheet, bpp, tsId, slot);
    }
    midIndex[item.pair]![item.mid] = {
      tiles: tiles4,
      coll: item.coll,
      behavior: item.behavior,
      category: item.category,
    };
  }
  pending = undefined;
  slotYsByPair = undefined;
  slotThreshByPair = undefined;

  // Indoor top-down demake (per tileset pair, isolated palette bank):
  //   1) discover material ramps from that pair's FRLG palSlots
  //   2) merge ≤22 within the pair → place into that pair's bank only
  //   3) assign each quad to that pair's codebook → bake 2bpp against its ramp
  {
    const byPair: Record<string, { items: Item[]; quads: Tbl[] }> = {};
    const pairOrder: string[] = [];
    let indoorQuadTotal = 0;
    for (const item of indoorPending) {
      const p = item.pair;
      if (!byPair[p]) {
        byPair[p] = { items: [], quads: [] };
        pairOrder.push(p);
      }
      byPair[p]!.items.push(item);
      for (let q = 0; q <= 3; q++) {
        if (is_exact_black_quad(item.quads[q]!.buf)) {
          indoorQuadTotal = indoorQuadTotal + 1; // counted as void stamp work
        } else {
          byPair[p]!.quads.push({
            buf: item.quads[q]!.buf,
            pal: item.quads[q]!.pal,
            pair: p,
            category: item.category,
          });
          indoorQuadTotal = indoorQuadTotal + 1;
        }
      }
    }
    pairOrder.sort();

    if (indoorQuadTotal > 0) {
      progress(progressCb, 3, "quantize_indoor", 0, indoorQuadTotal);
    }

    const codebooks: Record<string, CodebookEntry[]> = {}; // [pair] = { { ramp, slot, pair, frlgSlot }, ... }
    if (pairOrder.length > 0) {
      progress(progressCb, 3, "quantize_merge", 0, pairOrder.length);
    }
    for (let pi = 1; pi <= pairOrder.length; pi++) {
      const pairName = pairOrder[pi - 1]!;
      const tsId = PAIR_TILESET[pairName] ?? pairName;
      const group = byPair[pairName]!;
      const isOutdoor = pairName === "sevii_outdoor";
      const entries = QuantizeLab.discoverMaterialEntries(group.quads, {
        // Hue-split skip is decided per-bucket for TREE; do not blanket outdoor.
        forbidHueSplit: false,
      });
      let mergeOpts: { nearDupeEps?: number; guardTerrainFamilies?: boolean } | undefined;
      if (isOutdoor) {
        mergeOpts = {
          nearDupeEps: QuantizeLab.OUTDOOR_NEAR_DUPE_EPS,
          guardTerrainFamilies: true,
        };
      }
      // merged is 0-based (Lua merged[mi] is merged[mi - 1]); oldToMerged[ei - 1] = mi
      const [merged, oldToMerged] = QuantizeLab.mergeRampsToBudget(
        entries, QuantizeLab.MAX_SLOTS, mergeOpts);

      const mergedMeta: Record<number, Tbl> = {};
      for (let mi = 1; mi <= merged.length; mi++) {
        mergedMeta[mi] = { frlgVotes: {} as Record<number, number>, frlgSlot: 0, categories: {} as Record<string, number> };
      }
      oldToMerged.forEach((mi, idx) => {
        const e = entries[idx];
        const meta = mergedMeta[mi];
        if (e && meta) {
          const fk = e.frlgSlot ?? 0;
          meta.frlgVotes[fk] = (meta.frlgVotes[fk] ?? 0) + (e.count ?? 1);
          if (e.categories) {
            for (const c of Object.keys(e.categories)) {
              meta.categories[c] = (meta.categories[c] ?? 0) + e.categories[c]!;
            }
          }
        }
      });
      for (let mi = 1; mi <= merged.length; mi++) {
        const meta = mergedMeta[mi]!;
        let bestF = 0, bestFN = -1;
        for (const k of Object.keys(meta.frlgVotes)) {
          const fk = Number(k), n = meta.frlgVotes[k] as number;
          if (n > bestFN || (n === bestFN && fk < bestF)) {
            bestF = fk; bestFN = n;
          }
        }
        meta.frlgSlot = bestF;
        meta.primaryCategory = QuantizeLab.primaryCategory(meta.categories);
      }

      const codebook: CodebookEntry[] = [];
      for (let mi = 1; mi <= merged.length; mi++) {
        const meta = mergedMeta[mi];
        const fam = meta && meta.primaryCategory
          ? QuantizeLab.terrainFamily(meta.primaryCategory) : undefined;
        let slot: number;
        if (isOutdoor) {
          slot = place_in_bank_outdoor(tsId, merged[mi - 1]!, fam);
        } else {
          slot = place_in_bank(tsId, merged[mi - 1]!);
        }
        codebook.push({
          ramp: banks[tsId]![slot] ?? merged[mi - 1]!,
          slot,
          pair: pairName,
          frlgSlot: (meta && meta.frlgSlot) || 0,
          categories: meta ? meta.categories : undefined,
          primaryCategory: meta ? meta.primaryCategory : undefined,
          mergedId: mi,
        });
      }
      codebooks[pairName] = codebook;
      progress(progressCb, 3, "quantize_merge", pi, pairOrder.length);
    }

    const indoorMids = new Map<string, { pair: string; mid: number; coll: number; behavior: number; category: string; tiles: number[]; voidQuads?: boolean[] }>();
    let indoorQuadDone = 0;

    // q is 0-based here (the Lua's q - 1)
    const outdoor_assign_opts = (item: Item, q: number): Tbl => {
      const buf = item.quads[q]!.buf;
      const pal = item.quads[q]!.pal;
      const cat = item.category ?? "TOWN_PATH";
      const opts: Tbl = {
        preferFrlgSlot: QuantizeLab.majorityPalSlot(pal)[0],
        frlgBias: QuantizeLab.OUTDOOR_FRLG_BIAS,
        itemCategory: cat,
        crossCatPenalty: QuantizeLab.OUTDOOR_CROSS_CAT_PENALTY,
      };
      // Hard scope only for locked terrain families (still allows many water/sand
      // materials tagged with that family — does not force a single ramp).
      if (QuantizeLab.terrainFamily(cat)) {
        opts.requireCategory = cat;
      }
      if (Quantize.tileHueSpread(buf) >= Quantize.MIXED_HUE_SPREAD) {
        const qVotes = (quadVotes[item.pair] && quadVotes[item.pair]![item.mid]
          && quadVotes[item.pair]![item.mid]![q]) || {};
        const own = PaletteRules.ownCategory(cat, qVotes);
        const semSlot = PaletteRules.SLOT[own];
        const seed = semSlot !== undefined ? PaletteRules.RAMP[semSlot] : undefined;
        if (seed) {
          opts.preferRamp = seed;
          opts.rampBias = QuantizeLab.OUTDOOR_RAMP_BIAS;
        }
      }
      return opts;
    };

    // ── Indoor pairs: unary LAB bake (unchanged) ───────────────────────────
    for (const pairName of pairOrder) {
      if (pairName !== "sevii_outdoor") {
        const tsId = PAIR_TILESET[pairName] ?? pairName;
        const codebook = codebooks[pairName] ?? [];
        for (const item of byPair[pairName]!.items) {
          const key = item.pair + ":" + tostring(item.mid);
          let bucket = indoorMids.get(key);
          if (!bucket) {
            bucket = {
              pair: item.pair,
              mid: item.mid,
              coll: item.coll,
              behavior: item.behavior,
              category: item.category,
              tiles: [],
            };
            indoorMids.set(key, bucket);
          }
          const voidQuads: boolean[] = [];
          for (let q = 0; q <= 3; q++) {
            if (is_exact_black_quad(item.quads[q]!.buf)) {
              voidQuads[q] = true;
              bucket.tiles[q] = 0;
              indoorQuadDone = indoorQuadDone + 1;
            } else {
              const buf = item.quads[q]!.buf;
              const pal = item.quads[q]!.pal;
              let [ramp, sheetSlot] = QuantizeLab.resolveQuadRamp(buf, pal, codebook, pairName);
              if (sheetSlot === undefined) {
                ramp = banks[tsId]![place_in_bank(tsId, ramp)] ?? ramp;
              } else {
                ramp = banks[tsId]![sheetSlot] ?? ramp;
              }
              const [bpp, usedRamp, lockedBlack] = QuantizeLab.bakeQuad(buf, ramp);
              let slot: number;
              if (lockedBlack) {
                slot = place_black_locked(tsId, usedRamp);
              } else if (sheetSlot !== undefined) {
                slot = sheetSlot;
              } else {
                slot = place_in_bank(tsId, usedRamp);
              }
              const tid = Quantize.intern(sheet, bpp);
              record_tile_pal(tsId, tid, slot);
              bucket.tiles[q] = tid;
              indoorQuadDone = indoorQuadDone + 1;
            }
            if (indoorQuadTotal > 0
              && (indoorQuadDone % 8 === 0 || indoorQuadDone === indoorQuadTotal)) {
              progress(progressCb, 3, "quantize_indoor", indoorQuadDone, indoorQuadTotal);
            }
          }
          if (voidQuads.some(Boolean)) bucket.voidQuads = voidQuads;
        }
      }
    }

    // ── Outdoor LAB continuity: assign → cohere → optional MRF → shared Y bake
    if (byPair.sevii_outdoor) {
      const pairName = "sevii_outdoor";
      const tsId = PAIR_TILESET[pairName] ?? pairName;
      const codebook = codebooks[pairName] ?? [];
      // [mid] = { [q]=codebookIndex (1-based) | false void } (q 0-based)
      const assigns = new Map<number, (number | false | undefined)[]>();
      const voidByMid = new Map<number, boolean[]>();

      for (const item of byPair[pairName]!.items) {
        const mid = item.mid;
        if (!assigns.has(mid)) assigns.set(mid, []);
        if (!voidByMid.has(mid)) voidByMid.set(mid, []);
        const a = assigns.get(mid)!;
        for (let q = 0; q <= 3; q++) {
          if (is_exact_black_quad(item.quads[q]!.buf)) {
            a[q] = false;
            voidByMid.get(mid)![q] = true;
          } else {
            const opts = outdoor_assign_opts(item, q);
            const ci = QuantizeLab.bestCodebookIndex(
              item.quads[q]!.buf, item.quads[q]!.pal, codebook, pairName, opts);
            a[q] = ci;
          }
          indoorQuadDone = indoorQuadDone + 1;
          if (indoorQuadTotal > 0
            && (indoorQuadDone % 8 === 0 || indoorQuadDone === indoorQuadTotal)) {
            progress(progressCb, 3, "quantize_indoor", indoorQuadDone, indoorQuadTotal);
          }
        }
        // Mid 3–1 codebook snap (void quads stay nil-equivalent via false)
        let idx: (number | undefined)[] = [
          a[0] !== false ? a[0] : undefined,
          a[1] !== false ? a[1] : undefined,
          a[2] !== false ? a[2] : undefined,
          a[3] !== false ? a[3] : undefined,
        ];
        idx = Quantize.cohereCodebookIndices(idx);
        for (let q = 0; q <= 3; q++) {
          if (a[q] !== false && idx[q]) {
            a[q] = idx[q];
          }
        }
      }

      if (USE_OUTDOOR_MRF && codebook.length > 0) {
        const midItem = new Map<number, Item>();
        for (const item of byPair[pairName]!.items) {
          midItem.set(item.mid, item);
        }
        const placements: Tbl[] = [];
        let ord = 0;
        for (const mapId of Object.keys(grids)) {
          const grid = grids[mapId]!;
          if (grid.pair === pairName) {
            for (let cy = 0; cy <= grid.height - 1; cy++) {
              for (let cx = 0; cx <= grid.width - 1; cx++) {
                const cell = grid.cells[cy * grid.width + cx]!;
                const mid = cell.mid;
                const a = assigns.get(mid);
                const item = midItem.get(mid);
                if (a && item) {
                  // q1 is the Lua's 1-based quad number (MRF keys by it)
                  for (let q1 = 1; q1 <= 4; q1++) {
                    if (a[q1 - 1] !== false) {
                      ord = ord + 1;
                      const ox = (q1 === 2 || q1 === 4) ? 1 : 0;
                      const oy = (q1 >= 3) ? 1 : 0;
                      placements.push({
                        buf: item.quads[q1 - 1]!.buf,
                        pal: item.quads[q1 - 1]!.pal,
                        mid, q: q1,
                        mapId,
                        gx: cx * 2 + ox, gy: cy * 2 + oy,
                        ord,
                        category: item.category,
                      });
                    }
                  }
                }
              }
            }
          }
        }
        if (placements.length > 0) {
          const [labels] = QuantizeMrf.assignPlacements(placements as any, codebook, {
            pair: pairName,
            enabled: true,
          });
          const maj = QuantizeMrf.majorityPerMid(placements as any, labels);
          for (const midKey of Object.keys(maj)) {
            const mid = Number(midKey);
            const qs = maj[midKey]!;
            if (!assigns.has(mid)) assigns.set(mid, []);
            const a = assigns.get(mid)!;
            for (const qKey of Object.keys(qs)) {
              const q = Number(qKey) - 1;
              if (a[q] !== false) {
                a[q] = qs[qKey];
              }
            }
          }
        }
      }

      // TREE only: force one foliage material so tip/base mids share a ramp.
      // Water/sand/cliff keep multiple materials (foam, rocks, highlights).
      {
        const midItem = new Map<number, Item>();
        for (const item of byPair[pairName]!.items) {
          midItem.set(item.mid, item);
        }
        const treeCi = QuantizeLab.primaryCodebookForCategory(codebook, "TREE");
        if (treeCi !== undefined) {
          for (const [mid, a] of assigns) {
            const item = midItem.get(mid);
            if (item && item.category === "TREE") {
              for (let q = 0; q <= 3; q++) {
                if (a[q] !== false) a[q] = treeCi;
              }
            }
          }
        }
      }

      // Pool BT.709 Y per assigned codebook index → shared shade cuts
      const matYs: Record<number, number[]> = {};
      for (const item of byPair[pairName]!.items) {
        const a = assigns.get(item.mid);
        for (let q = 0; q <= 3; q++) {
          const ci = a && a[q];
          if (ci) { // Lua: ci and ci ~= false
            matYs[ci] = matYs[ci] ?? [];
            const pool = matYs[ci]!;
            const buf = item.quads[q]!.buf;
            for (let i = 1; i <= 64; i++) {
              pool.push(Quantize.bgr555_to_y(buf[i - 1] ?? 0));
            }
          }
        }
      }
      const matThresh: Record<number, [number, number, number]> = {};
      for (const k of Object.keys(matYs)) {
        const [t1, t2, t3] = Quantize.thresholdsFromYs(matYs[Number(k)]);
        matThresh[Number(k)] = [t1, t2, t3];
      }

      for (const item of byPair[pairName]!.items) {
        const key = item.pair + ":" + tostring(item.mid);
        let bucket = indoorMids.get(key);
        if (!bucket) {
          bucket = {
            pair: item.pair,
            mid: item.mid,
            coll: item.coll,
            behavior: item.behavior,
            category: item.category,
            tiles: [],
          };
          indoorMids.set(key, bucket);
        }
        const voidQuads = voidByMid.get(item.mid) ?? [];
        const a = assigns.get(item.mid) ?? [];
        for (let q = 0; q <= 3; q++) {
          if (voidQuads[q] || a[q] === false) {
            voidQuads[q] = true;
            bucket.tiles[q] = 0;
          } else {
            const ci = a[q] || 1;
            const entry = codebook[ci - 1] ?? codebook[0];
            const slot = (entry && entry.slot) || 1;
            const th = matThresh[ci] ?? [0.25, 0.5, 0.75];
            const [bpp] = Quantize.tileTo2bpp(item.quads[q]!.buf, th[0], th[1], th[2]);
            const tid = Quantize.intern(sheet, bpp);
            record_tile_pal(tsId, tid, slot);
            bucket.tiles[q] = tid;
          }
        }
        if (voidQuads.some(Boolean)) bucket.voidQuads = voidQuads;
      }
    }

    for (const bucket of indoorMids.values()) {
      midIndex[bucket.pair] = midIndex[bucket.pair] ?? {};
      midIndex[bucket.pair]![bucket.mid] = {
        tiles: bucket.tiles,
        coll: bucket.coll,
        behavior: bucket.behavior,
        category: bucket.category,
        voidQuads: bucket.voidQuads,
      };
    }

    // Stamp unique void tile onto every exact-black quad (and ensure mid 0).
    {
      const voidTid = Quantize.internUnique(sheet, QuantizeLab.solidBlackBpp());
      for (const tsId of tilesetIdList) {
        record_tile_pal(tsId, voidTid, ensure_black_slot(tsId));
      }
      for (const pairName of Object.keys(midIndex)) {
        const indexForPair = midIndex[pairName]!;
        const tsId = PAIR_TILESET[pairName] ?? pairName;
        if (banks[tsId]) {
          for (const midKey of Object.keys(indexForPair)) {
            const mid = Number(midKey);
            const info2 = indexForPair[mid]!;
            let tiles = [info2.tiles[0]!, info2.tiles[1]!, info2.tiles[2]!, info2.tiles[3]!];
            const vq = info2.voidQuads;
            if (mid === 0) {
              tiles = [voidTid, voidTid, voidTid, voidTid];
            } else if (vq) {
              for (let q = 0; q <= 3; q++) {
                if (vq[q]) tiles[q] = voidTid;
              }
            }
            indexForPair[mid] = {
              tiles,
              coll: info2.coll ?? 1,
              behavior: info2.behavior ?? 0,
              category: info2.category ?? "BLOCKED",
            };
          }
          if (!indexForPair[0]) {
            indexForPair[0] = {
              tiles: [voidTid, voidTid, voidTid, voidTid],
              coll: 1,
              behavior: 0,
              category: "BLOCKED",
            };
          }
        }
      }
      voidTidForBorder = voidTid;
    }
  }
  indoorPending = undefined;

  progress(progressCb, 4, "pack_layouts", 0, mapOrder.length);
  const blocks: Record<number, { tiles: number[]; collision: number[] }> = {};
  const blockByKey: Record<string, number> = {};
  let nextBlock = 0;
  const layouts: Record<string, Tbl> = {};

  const intern_block = (tiles16: number[], coll4: number[]): number => {
    const key = tiles16.map((t) => tostring(t)).join(",") + ";" + coll4.map((c) => tostring(c)).join(",");
    const hit = blockByKey[key];
    if (hit !== undefined) return hit;
    const id = nextBlock;
    nextBlock = nextBlock + 1;
    blockByKey[key] = id;
    blocks[id] = { tiles: tiles16, collision: coll4 };
    return id;
  };

  for (let mi = 1; mi <= mapOrder.length; mi++) {
    const mapId = mapOrder[mi - 1]!;
    progress(progressCb, 4, "pack_layouts", mi - 1, mapOrder.length);
    const grid = grids[mapId];
    if (grid) {
      const pairName = grid.pair ?? "sevii_outdoor";
      const indexForPair = midIndex[pairName] ?? {};
      const bundle = bundles[pairName]!;
      const bw = Math.floor(grid.width / 2);
      const bh = Math.floor(grid.height / 2);
      const packed: number[] = [];
      for (let by = 0; by <= bh - 1; by++) {
        for (let bx = 0; bx <= bw - 1; bx++) {
          const cell = (cx: number, cy: number): Cell => grid.cells[cy * grid.width + cx]!;
          const c00 = cell(bx * 2, by * 2);
          const c10 = cell(bx * 2 + 1, by * 2);
          const c01 = cell(bx * 2, by * 2 + 1);
          const c11 = cell(bx * 2 + 1, by * 2 + 1);
          const infoFor = (c: Cell): { tiles: number[]; coll: number; category?: string } => {
            const beh = Tileset.behaviorOf(bundle, c.mid);
            const [collByte, cat] = Collision.fromCell(c.mid, c.coll, beh, grid.kind);
            const mi2 = indexForPair[c.mid];
            if (mi2) {
              return { tiles: mi2.tiles, coll: collByte, category: cat };
            }
            return { tiles: [0, 0, 0, 0], coll: collByte };
          };
          const i00 = infoFor(c00), i10 = infoFor(c10), i01 = infoFor(c01), i11 = infoFor(c11);
          // Lua tiles16[1..16] (1-based) -> 0-based
          const tiles16: number[] = [];
          tiles16[0] = i00.tiles[0]!; tiles16[1] = i00.tiles[1]!;
          tiles16[4] = i00.tiles[2]!; tiles16[5] = i00.tiles[3]!;
          tiles16[2] = i10.tiles[0]!; tiles16[3] = i10.tiles[1]!;
          tiles16[6] = i10.tiles[2]!; tiles16[7] = i10.tiles[3]!;
          tiles16[8] = i01.tiles[0]!; tiles16[9] = i01.tiles[1]!;
          tiles16[12] = i01.tiles[2]!; tiles16[13] = i01.tiles[3]!;
          tiles16[10] = i11.tiles[0]!; tiles16[11] = i11.tiles[1]!;
          tiles16[14] = i11.tiles[2]!; tiles16[15] = i11.tiles[3]!;
          const coll4 = [i00.coll, i10.coll, i01.coll, i11.coll];
          packed.push(intern_block(tiles16, coll4));
        }
      }
      const spec = Versions.MAPS[mapId];
      const env = spec && spec.environment;
      layouts[mapId] = {
        width: bw,
        height: bh,
        blocks: packed,
        environment: env,
        pair: pairName,
        borderBlock: 0, // indoor overridden after void block is interned
      };
    }
  }

  // Beyond-edge border uses the same unique void tile as pad mid 0.
  if (voidTidForBorder !== undefined) {
    const tiles16: number[] = [];
    for (let i = 0; i < 16; i++) tiles16[i] = voidTidForBorder;
    const voidId = intern_block(tiles16, [1, 1, 1, 1]);
    for (const layout of Object.values(layouts)) {
      if (layout.environment === "INDOOR") {
        layout.borderBlock = voidId;
      }
    }
  }

  progress(progressCb, 5, "write_cache", 0, 1);
  const [raw, width, height] = Quantize.sheetToRaw(sheet, 16);
  cache.write(Extract.CACHE_ROOT + "/tileset.2bpp", raw);

  // Fill each tileset's tilePalettes to full atlas length. Unused tile ids get
  // slot 1 as a don't-care placeholder (this tileset never draws those tiles).
  const filled_tile_pals = (tsId: string): number[] => {
    const src = tilePalettesByTileset[tsId] ?? {};
    const out: number[] = [];
    for (let i = 1; i <= sheet.count; i++) {
      out[i - 1] = src[i] ?? 1;
    }
    return out;
  };
  const bank_to_list = (bank: Record<number, Ramp> | undefined): Ramp[] => {
    let n = 0;
    for (const s of Object.keys(bank ?? {}).map(Number)) {
      if (s > n) n = s;
    }
    if (n < 1) n = 1;
    const list: Ramp[] = [];
    for (let i = 1; i <= n; i++) {
      list[i - 1] = (bank && bank[i]) || [
        [255, 255, 255], [170, 170, 170], [85, 85, 85], [0, 0, 0],
      ];
    }
    return list;
  };

  const specialByTs: Record<string, Ramp[]> = {};
  const tilePalByTs: Record<string, number[]> = {};
  for (const tsId of tilesetIdList) {
    specialByTs[tsId] = bank_to_list(banks[tsId]);
    tilePalByTs[tsId] = filled_tile_pals(tsId);
  }
  // Legacy aliases for older readers: outdoor bank.
  const specialPalsOut = specialByTs[outdoorTs] ?? bank_to_list(banks[outdoorTs]);
  const tilePalettes = tilePalByTs[outdoorTs] ?? filled_tile_pals(outdoorTs);

  write_json(cache, Extract.CACHE_ROOT + "/meta.json", {
    cache_version: Versions.CACHE_VERSION,
    native_version: Versions.NATIVE_VERSION ?? 1,
    md5: Versions.normalizeMd5(info.md5),
    version_id: version.id,
    import_id: importId,
    mid_count: totalMids,
    tile_count: sheet.count,
    block_count: nextBlock,
    imageWidth: width,
    imageHeight: height,
    tilesPerRow: 16,
    maps: mapOrder,
  });

  const rgb_lua = (c: number[]): string => format("{%d,%d,%d}", c[0] ?? 0, c[1] ?? 0, c[2] ?? 0);
  const ramp_lua = (ramp: Ramp): string => format("{%s,%s,%s,%s}",
    rgb_lua(ramp[0]!), rgb_lua(ramp[1]!), rgb_lua(ramp[2]!), rgb_lua(ramp[3]!));
  const write_ramp_table = (lines: string[], list: Ramp[]): void => {
    for (let i = 1; i <= list.length; i++) {
      lines.push(format("    [%d] = %s,\n", i, ramp_lua(list[i - 1]!)));
    }
  };
  const write_int_array = (lines: string[], list: number[]): void => {
    for (let i = 1; i <= list.length; i++) {
      lines.push(format("    %d,\n", list[i - 1]));
    }
  };

  const metaLines = [
    "return {\n",
    format("  imageWidth = %d,\n", width),
    format("  imageHeight = %d,\n", height),
    "  tilesPerRow = 16,\n",
    format("  tileCount = %d,\n", sheet.count),
    "  tilePalettes = {\n",
  ];
  write_int_array(metaLines, tilePalettes);
  metaLines.push("  },\n");
  metaLines.push("  specialPalettes = {\n");
  write_ramp_table(metaLines, specialPalsOut);
  metaLines.push("  },\n");
  metaLines.push("  tilePalettesByTileset = {\n");
  for (const tsId of tilesetIdList) {
    metaLines.push(format("    [%q] = {\n", tsId));
    write_int_array(metaLines, tilePalByTs[tsId]!);
    metaLines.push("    },\n");
  }
  metaLines.push("  },\n");
  metaLines.push("  specialPalettesByTileset = {\n");
  for (const tsId of tilesetIdList) {
    metaLines.push(format("    [%q] = {\n", tsId));
    write_ramp_table(metaLines, specialByTs[tsId]!);
    metaLines.push("    },\n");
  }
  metaLines.push("  },\n");
  metaLines.push("}\n");
  cache.write(Extract.CACHE_ROOT + "/tileset_meta.lua", metaLines.join(""));

  const bl = ["return {\n"];
  for (let id = 0; id <= nextBlock - 1; id++) {
    const b = blocks[id]!;
    bl.push(format("  [%d] = { tiles = {%s}, collision = {%s} },\n",
      id,
      b.tiles.map((t) => tostring(t)).join(","),
      b.collision.map((c) => tostring(c)).join(",")));
  }
  bl.push("}\n");
  cache.write(Extract.CACHE_ROOT + "/blocks.lua", bl.join(""));

  writeMidIndex(cache, pairNames, midsByPair, midIndex);

  // Native FRLG mid atlas + pret palettes (game3 live path). Bundles still live.
  progress(progressCb, 6, "native_pack", 0, 1);
  NativePack.writeExtract(
    cache, Extract.CACHE_ROOT, bundles, grids, borders, pairNames, midIndex,
    Tileset.behaviorOf, Collision.fromCell);

  // OW sprites + tileset anims from ROM (re-open; pages were cleared after tileset load).
  {
    const rom2 = assertOk(Rom.open(imports, importId));
    HelpExtract.writeExtract(rom2, cache);
    QuestLogExtract.writeExtract(rom2, cache);
    ObjectInteractionsExtract.writeExtract(rom2, cache, Extract.CACHE_ROOT, version);
    const midLists: Record<string, number[]> = {};
    for (const pairName of pairNames) {
      midLists[pairName] = NativePack.collectMidsForPair(grids, borders, pairName);
    }
    AnimPack.writeExtract(rom2, cache, Extract.CACHE_ROOT, bundles, midLists, version);
    OwExtract.writeExtract(rom2, cache, Extract.CACHE_ROOT, version);
    EncountersExtract.writeExtract(rom2, cache, Extract.CACHE_ROOT, version);
    FieldEffectExtract.writeExtract(rom2, cache, Extract.CACHE_ROOT, version);
    rom2.clearCache();
  }

  for (const mapId of Object.keys(layouts)) {
    const layout = layouts[mapId]!;
    const lines = [
      "return {\n",
      format("  width = %d,\n", layout.width),
      format("  height = %d,\n", layout.height),
      format("  environment = %q,\n", layout.environment ?? "INDOOR"),
      format("  pair = %q,\n", layout.pair ?? "sevii_outdoor"),
      format("  borderBlock = %d,\n", layout.borderBlock ?? 0),
      "  blocks = {\n",
    ];
    for (const bid of layout.blocks as number[]) {
      lines.push(format("    %d,\n", bid));
    }
    lines.push("  },\n}\n");
    cache.write(Extract.CACHE_ROOT + "/layouts/" + mapId + ".lua", lines.join(""));
  }

  const [warps, connections] = warpsAndConnections(imports, importId, version, mapOrder);
  writeWarpsAndConnections(cache, mapOrder, warps, connections);

  // game3 scripts/events/text/movements from ROM MapEvents + BFS (primary).
  rom = assertOk(Rom.open(imports, importId));
  const scriptBundle = ExtractScripts.writeBundleFromRom(rom, cache, Extract.CACHE_ROOT, version);

  // Extract full trainer parties, AI flags, dialogs, and sprites
  TrainerExtract.run(rom, cache, {
    cacheRoot: Extract.CACHE_ROOT,
    scripts: scriptBundle && scriptBundle.scripts,
    text: scriptBundle && scriptBundle.text,
  });

  // Normalized map_tree mirror (header/events/grid per slot + shared tilesets).
  {
    const [okTree, treeDetail] = MapTreeExtract.run(rom, cache, {
      version,
      root: Extract.CACHE_ROOT + "/map_tree",
    });
    if (!okTree) {
      console.log("[extract] map_tree warn: " + tostring(treeDetail));
    }
  }
  rom.clearCache();

  progress(progressCb, 7, "done", 1, 1);
  bundles = undefined;
  return [true, {
    md5: info.md5,
    tile_count: sheet.count,
    block_count: nextBlock,
    mid_count: totalMids,
    map_count: mapOrder.length,
    script_count: scriptBundle && scriptBundle.scriptCount,
    script_seeds: scriptBundle && scriptBundle.seedCount,
  }];
}

export default Extract;
