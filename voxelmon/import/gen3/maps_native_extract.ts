// Port of gen1recomp src/import/gba/maps_native_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// The RSE plan's world-map step (plans/rse/maps.lua); FRLG builds the same
// files through extract_island1. It needs modules this port does not have
// yet (src.core.game3.mb, object_interactions_extract, extract_island1's
// padEven) and the family's symbol table (F:syms(), RSE only), so those are
// bound late through `MapsNativeExtract.deps` by their own modules.
// NOT FAITHFUL: run() throws until the deps are bound (the Lua requires them).

import { format, tonumber, tostring } from "./lua.ts";
import { Versions } from "./versions.ts";
import { Family } from "./family.ts";
import { MapTree } from "./map_tree.ts";
import { MapCatalog } from "./map_catalog.ts";
import { Tileset, type BundleLike } from "./tileset.ts";
import { Maps, type Border, type Grid } from "./maps.ts";
import { NativePack } from "./native_pack.ts";
import { AltLayouts } from "./alt_layouts.ts";
import { AnimPack } from "./tileset_anim_pack.ts";
import { ExtractMapEvents, type Warp, type Connection } from "./extract_map_events.ts";
import { Collision } from "../../game/gen3/core/scripting/collision.ts";
import type { Cache } from "./cache.ts";
import type { Rom } from "./rom.ts";

interface Deps {
  /** src.core.game3.mb: { translator(game) → { tileBits(rom), canon(beh) } } */
  MB?: { translator(game: string): { tileBits(rom: Rom): unknown; canon(beh: number): number } };
  /** src.import.gba.object_interactions_extract */
  ObjectInteractions?: { writeExtract(rom: Rom, cache: Cache, root: string, version: any): unknown };
  /** src.import.gba.extract_island1 padEven */
  padEven?: (grid: Grid) => Grid;
}

const deps: Deps = {};

function need<K extends keyof Deps>(k: K): NonNullable<Deps[K]> {
  const v = deps[k];
  if (!v) throw new Error(`maps_native_extract: ${k} is not ported/bound yet`);
  return v as NonNullable<Deps[K]>;
}

// Lua: maps_native_extract.lua:29
function log(msg: string): void {
  console.log("[maps_native] " + msg);
}

// Lua: maps_native_extract.lua:33 -- the restricted Lua-literal reader is not
// part of the importer; the summary is checked by its native_version line.
// NOT FAITHFUL: the Lua load()s the whole chunk.
function load_summary_version(cache: Cache, rel: string): number | undefined {
  const src = cache.read(rel);
  if (src === undefined) return undefined;
  const m = /\["native_version"\] = (\d+),/.exec(src);
  return m ? tonumber(m[1]) : undefined;
}

// Lua: maps_native_extract.lua:50
function pad_even(grid: Grid): Grid {
  return need("padEven")(grid);
}

// Lua: maps_native_extract.lua:54 (keys sorted: numbers first, then strings)
function serialize(v: unknown, indent?: string): string {
  indent = indent ?? "";
  if (typeof v === "string") return format("%q", v);
  if (v === null || typeof v !== "object") return tostring(v);
  const keys: (string | number)[] = [];
  if (Array.isArray(v)) v.forEach((_, i) => keys.push(i + 1));
  else for (const k of Object.keys(v)) keys.push(/^-?\d+$/.test(k) ? Number(k) : k);
  keys.sort((a, b) => {
    if (typeof a === typeof b) return a < b ? -1 : a > b ? 1 : 0;
    return typeof a === "number" ? -1 : 1;
  });
  const inner = indent + "  ";
  const out: string[] = ["{\n"];
  for (const k of keys) {
    const key = typeof k === "number" ? "[" + tostring(k) + "]" : "[" + format("%q", k) + "]";
    const val = Array.isArray(v) ? v[(k as number) - 1] : (v as Record<string, unknown>)[String(k)];
    out.push(inner + key + " = " + serialize(val, inner) + ",\n");
  }
  out.push(indent + "}");
  return out.join("");
}

// Lua: maps_native_extract.lua:76 -- pokeemerald/include/global.fieldmap.h:64
function tileset_inits(rom: Rom, version: any): Record<string, unknown> {
  const F = Family.active() as any;
  const S = F.syms();
  const out: Record<string, unknown> = {};
  const base = (version && version.g_map_layouts) || Versions.G_MAP_LAYOUTS;
  const seen = new Set<number>();
  const n: number = Versions.NUM_MAP_LAYOUTS ?? 0;
  for (let id = 1; id <= n; id++) {
    const layout = MapTree.parseLayout(rom, rom.ptrOffset(rom.u32(base + (id - 1) * 4)));
    for (const ptr of layout ? [layout.primaryTilesetPtr, layout.secondaryTilesetPtr] : []) {
      if (ptr !== 0 && !seen.has(ptr)) {
        seen.add(ptr);
        const [name, ts] = MapCatalog.tilesetNameForPtr(rom, ptr);
        if (name && ts && ts.callbackPtr && ts.callbackPtr !== 0) {
          out[name] = S.funcAt(ts.callbackPtr);
        }
      }
    }
  }
  return out;
}

type MidRow = { coll: number; behavior: number; category: string };

// Lua: maps_native_extract.lua:97
function write_mid_index(cache: Cache, root: string, pairNames: string[], midLists: Record<string, number[]>,
  midIndex: Record<string, Record<number, MidRow>>): void {
  const lines: string[] = ["return {\n"];
  for (const pairName of pairNames) {
    lines.push(format("  [%q] = {\n", pairName));
    for (const mid of midLists[pairName] ?? []) {
      const r = midIndex[pairName]![mid]!;
      lines.push(format("    [%d] = { tiles = {0,0,0,0}, coll = %d, behavior = %d, category = %q },\n",
        mid, r.coll, r.behavior, r.category));
    }
    lines.push("  },\n");
  }
  lines.push("}\n");
  cache.write(root + "/mid_index.lua", lines.join(""));
}

// Lua: maps_native_extract.lua:112
function write_warps(cache: Cache, root: string, mapOrder: string[], warps: Record<string, Warp[]>): void {
  const wl: string[] = ["return {\n"];
  for (const mapId of mapOrder) {
    wl.push(format("  %s = {\n", mapId));
    for (const w of warps[mapId] ?? []) {
      const dest = MapCatalog.mapIdFor(w.mapGroup, w.mapNum);
      if (dest) {
        wl.push(format("    { x = %d, y = %d, destMap = %q, destWarp = %d },\n",
          w.x, w.y, dest, w.destWarp ?? 1));
      } else {
        wl.push(format("    { x = %d, y = %d, destMap = nil, destWarp = %d, mapGroup = %d, mapNum = %d },\n",
          w.x, w.y, w.destWarp ?? 1, w.mapGroup ?? 0, w.mapNum ?? 0));
      }
    }
    wl.push("  },\n");
  }
  wl.push("}\n");
  cache.write(root + "/warps.lua", wl.join(""));
}

// Lua: maps_native_extract.lua:132
function write_connections(cache: Cache, root: string, mapOrder: string[], conns: Record<string, (Connection & { mapGroup?: number; mapNum?: number })[]>): void {
  const cl: string[] = ["return {\n"];
  for (const mapId of mapOrder) {
    cl.push(format("  %s = {\n", mapId));
    for (const c of conns[mapId] ?? []) {
      const dest = c.map || (c.mapGroup !== undefined ? MapCatalog.mapIdFor(c.mapGroup, c.mapNum) : undefined);
      if (dest) {
        cl.push(format("    { dir = %q, map = %q, offset = %d },\n", c.dir, dest, tonumber(c.offset) ?? 0));
      }
    }
    cl.push("  },\n");
  }
  cl.push("}\n");
  cache.write(root + "/connections.lua", cl.join(""));
}

export const MapsNativeExtract = {
  deps,

  SUMMARY: "native/summary.lua",

  REQUIRED: [
    "native/manifest.lua",
    "native/summary.lua",
    "mid_index.lua",
    "warps.lua",
    "connections.lua",
    "objects/pack.lua",
    AnimPack.INDEX_FILE,
  ],

  // Lua: maps_native_extract.lua:41
  ready(cache: Cache, cacheRoot?: string): boolean {
    cacheRoot = cacheRoot ?? "data/generated/gba";
    for (const rel of MapsNativeExtract.REQUIRED) {
      if (!cache.exists(cacheRoot + "/" + rel)) return false;
    }
    const v = load_summary_version(cache, cacheRoot + "/" + MapsNativeExtract.SUMMARY);
    return v === (Versions.NATIVE_VERSION ?? 1);
  },

  // Lua: maps_native_extract.lua:148
  run(rom: Rom, cache: Cache, opts?: { cacheRoot?: string }): Record<string, unknown> {
    opts = opts ?? {};
    const root = opts.cacheRoot ?? "data/generated/gba";
    const [version, verr] = Versions.lookup(rom.md5 ?? (rom as any).sha1);
    if (!version) throw new Error(String(verr));
    const F = Family.active();
    const Mb = need("MB").translator(F.game);
    const t0 = Date.now();

    MapCatalog.rebuildIndex();
    const [census, cerr] = MapTree.walk(rom, version);
    if (!census) throw new Error(String(cerr));
    const [order, byEngine] = MapCatalog.allOrder(census);
    const registered = MapCatalog.registerOrder(rom, version, order, byEngine);
    const regSet = new Set<string>();
    const dropped: string[] = [];
    for (const id of registered) regSet.add(id);
    for (const id of order) {
      if (!regSet.has(id)) {
        dropped.push(id);
        log("drop map " + id + ": no tileset pair");
      }
    }

    const grids: Record<string, Grid> = {}, borders: Record<string, Border> = {};
    for (const mapId of registered) {
      const spec = Versions.MAPS[mapId];
      const layoutSpec = spec && version.layouts && version.layouts[spec.layout];
      if (layoutSpec) {
        let grid: Grid | undefined, err: unknown;
        try {
          grid = Maps.loadGrid(rom, layoutSpec);
        } catch (e) {
          err = e;
        }
        if (grid) {
          grid.map_id = mapId;
          grid.kind = spec.kind;
          grid.pair = spec.pair;
          grid.environment = spec.environment;
          grids[mapId] = pad_even(grid);
          borders[mapId] = Maps.loadBorder(rom, version, mapId);
        } else {
          dropped.push(mapId);
          log("drop map " + mapId + ": " + String(err));
        }
      } else {
        dropped.push(mapId);
        log("drop map " + mapId + ": missing layout spec");
      }
    }

    const [altAdded, altSkipped] = AltLayouts.buildUnreferenced(rom, version, grids, borders, pad_even, census);
    for (const key of altSkipped) log("skip layout " + key + ": no tileset pair");

    const needed = new Set<string>();
    for (const grid of Object.values(grids)) needed.add(grid.pair!);
    let pairNames = Array.from(needed);
    pairNames.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    const bundles: Record<string, BundleLike> = {};
    for (const pairName of pairNames) {
      let bundle, err: unknown;
      try {
        [bundle, err] = Tileset.loadPair(rom, version, pairName);
      } catch (e) {
        err = e;
      }
      if (bundle) {
        bundles[pairName] = bundle;
      } else {
        log("skip tileset pair " + pairName + ": " + String(err));
      }
    }
    const kept: string[] = [];
    for (const pairName of pairNames) {
      if (bundles[pairName]) kept.push(pairName);
    }
    pairNames = kept;
    for (const key of Object.keys(grids)) {
      const grid = grids[key]!;
      if (!bundles[grid.pair!]) {
        delete grids[key];
        delete borders[key];
        dropped.push(key);
        log("drop layout " + key + ": tileset pair " + String(grid.pair) + " failed");
      }
    }
    const mapOrder: string[] = [];
    for (const id of registered) {
      if (grids[id]) mapOrder.push(id);
    }

    const tileBits = Mb.tileBits(rom);
    const Impl = Collision.impl(F.name);
    if (Impl.setTileBits) Impl.setTileBits(tileBits);
    const behaviorOf = (bundle: BundleLike, mid: number): number => Mb.canon(Tileset.behaviorOf(bundle, mid));

    const policy = NativePack.atlasPolicy(F.game);
    const midLists: Record<string, number[]> = {};
    const midIndex: Record<string, Record<number, MidRow>> = {};
    let totalMids = 0;
    for (const pairName of pairNames) {
      const bundle = bundles[pairName]!;
      let list: number[];
      if (policy === "full") {
        list = NativePack.fullMidsForPair(bundle);
      } else {
        list = NativePack.collectMidsForPair(grids, borders, pairName, undefined);
      }
      midLists[pairName] = list;
      totalMids = totalMids + list.length;
      const rows: Record<number, MidRow> = {};
      for (const mid of list) {
        const beh = behaviorOf(bundle, mid);
        rows[mid] = { coll: Collision.fromCell(mid, 0, beh, "outdoor")[0], behavior: beh, category: "misc" };
      }
      midIndex[pairName] = rows;
    }
    write_mid_index(cache, root, pairNames, midLists, midIndex);

    const [romWarps, romConns] = ExtractMapEvents.extractWarpsAndConnections(rom, version);
    write_warps(cache, root, mapOrder, romWarps);
    write_connections(cache, root, mapOrder, romConns);
    const warpCells: Record<string, Set<number>> = {};
    for (const mapId of mapOrder) {
      const set = new Set<number>();
      for (const w of romWarps[mapId] ?? []) {
        const x = tonumber(w.x), y = tonumber(w.y);
        if (x !== undefined && y !== undefined) set.add(NativePack.warpKey(x, y));
      }
      warpCells[mapId] = set;
    }

    const manifest = NativePack.writeExtract(cache, root, bundles, grids, borders, pairNames, midIndex,
      behaviorOf, Collision.fromCell, undefined, warpCells, { midLists });

    need("ObjectInteractions").writeExtract(rom, cache, root, version);

    const inits = tileset_inits(rom, version);
    const animIndex = AnimPack.writeExtract(rom, cache, root, bundles, midLists, version, { tilesetInits: inits });

    const layoutCount = Object.keys(manifest.layouts ?? {}).length;
    const animPairs = Object.keys((animIndex && animIndex.pairs) || {}).length;
    dropped.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const summary = {
      native_version: Versions.NATIVE_VERSION ?? 1,
      game: F.game,
      policy,
      maps: mapOrder.length,
      layouts: layoutCount,
      altLayouts: altAdded,
      altSkipped,
      dropped,
      pairs: pairNames.length,
      mids: totalMids,
      animPairs,
      tilesetInits: inits,
    };
    cache.write(root + "/" + MapsNativeExtract.SUMMARY, "return " + serialize(summary) + "\n");
    log(format("%d maps, %d alt layouts, %d dropped, %d pairs, %d mids, %d anim pairs (%.1fs)",
      mapOrder.length, altAdded.length, dropped.length, pairNames.length, totalMids, animPairs, (Date.now() - t0) / 1000));
    return summary;
  },
};

export default MapsNativeExtract;
