// Port of gen1recomp src/import/gba/map_tree_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// Serialize MapTree census → CacheFS:
//   data/generated/gba/map_tree/census.json
//   data/generated/gba/map_tree/maps/{group}_{num}/header.json|events.json|grid.bin|border.bin
//   data/generated/gba/map_tree/tilesets/{ts_id}/meta.json|tiles.4bpp|palettes.bin|metatiles.bin|attributes.bin

import { format, fromBytes } from "./lua.ts";
import { Lz77 } from "./lz77.ts";
import { CanonicalJson } from "./json.ts";
import { luaLen } from "./luatable.ts";
import { Family } from "./family.ts";
import { MapTree, type CensusEntry, type TilesetStruct } from "./map_tree.ts";
import type { MapEvents } from "./extract_map_events.ts";
import type { Cache } from "./cache.ts";
import type { Rom } from "./rom.ts";

// Lua: map_tree_extract.lua:17
function bytes_to_string(bytes: string | Uint8Array): string {
  if (typeof bytes === "string") return bytes;
  return fromBytes(bytes);
}

// Lua: map_tree_extract.lua:33
function rom_blob(rom: Rom, ptr: number, nbytes: number | undefined): string | undefined {
  const off = rom.ptrOffset(ptr);
  if (off === undefined || nbytes === undefined || nbytes === null || nbytes < 1) return undefined;
  return rom.readString(off, nbytes);
}

// Lua: map_tree_extract.lua:47
function write_json(cache: Cache, rel: string, obj: unknown): void {
  cache.write(rel, CanonicalJson.encode(obj) + "\n");
}

// Lua: map_tree_extract.lua:51
function simplify_events(ev: MapEvents | undefined): Record<string, unknown[]> {
  if (!ev) {
    return { objects: [], warps: [], bgEvents: [], coordEvents: [] };
  }
  const slim_obj = (o: Record<string, any>): Record<string, unknown> => {
    const t = o.cloneTarget;
    if (t) {
      return {
        localId: o.localId,
        graphicsId: o.graphicsId,
        kind: o.kind,
        x: o.x,
        y: o.y,
        targetLocalId: t.localId,
        targetMapNum: t.mapNum,
        targetMapGroup: t.mapGroup,
        flag: o.flag,
      };
    }
    return {
      localId: o.localId,
      graphicsId: o.graphicsId,
      x: o.x,
      y: o.y,
      elevation: o.elevation,
      movementType: o.movementType,
      movement: o.movement,
      range: o.range,
      scriptKey: o.scriptKey,
      flag: o.flag,
      berryTreeId: o.berryTreeId,
    };
  };
  const objects: unknown[] = [];
  for (const o of ev.objects ?? []) {
    objects.push(slim_obj(o));
  }
  const warps: unknown[] = [];
  for (const w of ev.warps ?? []) {
    warps.push({
      x: w.x,
      y: w.y,
      destMap: w.destMap,
      destWarp: w.destWarp,
      mapGroup: w.mapGroup,
      mapNum: w.mapNum,
    });
  }
  const bgs: unknown[] = [];
  for (const b of ev.bgEvents ?? []) {
    bgs.push({
      type: b.type,
      x: b.x,
      y: b.y,
      elevation: b.elevation,
      kind: b.kind,
      scriptKey: b.scriptKey,
      item: b.item,
      hiddenItemId: b.hiddenItemId,
      quantity: b.quantity,
      underfoot: b.underfoot,
      flag: b.flag,
      secretBaseId: b.secretBaseId,
    });
  }
  const coords: unknown[] = [];
  for (const c of ev.coordEvents ?? []) {
    coords.push({
      x: c.x,
      y: c.y,
      elevation: c.elevation,
      var: c.var,
      value: c.value,
      scriptKey: c.scriptKey,
    });
  }
  return {
    objects,
    warps,
    bgEvents: bgs,
    coordEvents: coords,
  };
}

// Lua: map_tree_extract.lua:135
function pack_tileset(rom: Rom, cache: Cache, root: string, ts: TilesetStruct): string {
  const dir = root + "/tilesets/" + ts.id;
  const tilesOff = rom.ptrOffset(ts.tilesPtr);
  let tilesBlob: string | undefined;
  if (ts.compressed && tilesOff !== undefined) {
    const [raw] = Lz77.decompress((i: number) => rom.get(i), tilesOff);
    tilesBlob = bytes_to_string(raw);
  } else if (tilesOff !== undefined) {
    const palsOff = rom.ptrOffset(ts.palettesPtr);
    const n = (Family.active().uncompressedTileBytes as (r: Rom, t: number, p: number | undefined, s: boolean) => number | undefined)(
      rom, tilesOff, palsOff, ts.secondary);
    if (n) {
      tilesBlob = rom_blob(rom, ts.tilesPtr, n);
    }
  } else {
    tilesBlob = undefined;
  }
  const pals = rom_blob(rom, ts.palettesPtr, ts.palette_count * 32);
  const mts = rom_blob(rom, ts.metatilesPtr, ts.metatile_bytes);
  const attrs = rom_blob(rom, ts.attributesPtr, ts.attr_bytes);

  write_json(cache, dir + "/meta.json", {
    id: ts.id,
    ptr: ts.ptr,
    compressed: ts.compressed,
    secondary: ts.secondary,
    mid_count: ts.mid_count,
    metatile_bytes: ts.metatile_bytes,
    attr_bytes: ts.attr_bytes,
    palette_count: ts.palette_count,
    tiles_bytes: tilesBlob !== undefined ? tilesBlob.length : 0,
  });
  if (tilesBlob !== undefined) cache.write(dir + "/tiles.4bpp", tilesBlob);
  if (pals !== undefined) cache.write(dir + "/palettes.bin", pals);
  if (mts !== undefined) cache.write(dir + "/metatiles.bin", mts);
  if (attrs !== undefined) cache.write(dir + "/attributes.bin", attrs);
  return dir;
}

// Lua: map_tree_extract.lua:173
function pack_map(rom: Rom, cache: Cache, root: string, entry: CensusEntry): string {
  const dir = root + "/maps/" + entry.slot;
  const h = entry.header;
  const L = entry.layout;
  write_json(cache, dir + "/header.json", {
    id: entry.id,
    pretName: entry.pretName,
    group: entry.group,
    num: entry.num,
    groupName: entry.groupName,
    width: L.width,
    height: L.height,
    music: h.music,
    weather: h.weather,
    mapType: h.mapType,
    cave: h.cave,
    regionMapSectionId: h.regionMapSectionId,
    bikingAllowed: h.bikingAllowed,
    allowCycling: h.allowCycling,
    allowEscaping: h.allowEscaping,
    allowRunning: h.allowRunning,
    showMapName: h.showMapName,
    floorNum: h.floorNum,
    battleType: h.battleType,
    layoutId: h.layoutId,
    primaryTileset: entry.primaryTileset,
    secondaryTileset: entry.secondaryTileset,
    borderWidth: L.borderWidth,
    borderHeight: L.borderHeight,
    connections: entry.connections,
    headerOff: h.headerOff,
    layoutOff: L.layoutOff,
  });
  write_json(cache, dir + "/events.json", simplify_events(entry.events));
  const grid = MapTree.readGridBytes(rom, L);
  if (grid !== undefined) cache.write(dir + "/grid.bin", grid);
  const border = MapTree.readBorderBytes(rom, L);
  if (border !== undefined) cache.write(dir + "/border.bin", border);
  return dir;
}

export interface MapTreeExtractOpts {
  root?: string;
  cacheRoot?: string;
  version?: any;
  strict?: boolean;
  groups?: number[];
  progress?: (name: string, cur: number, total: number) => void;
}

export const MapTreeExtract = {
  ROOT: "data/generated/gba/map_tree",

  REQUIRED: ["map_tree/census.json"],

  // Lua: map_tree_extract.lua:216
  ready(cache: Cache, cacheRoot?: string): boolean {
    return cache.exists((cacheRoot ?? "data/generated/gba") + "/map_tree/census.json");
  },

  // Lua: map_tree_extract.lua:220 -- full procedural extract: [ok, detail]
  run(rom: Rom, cache: Cache, opts?: MapTreeExtractOpts): [boolean, any] {
    opts = opts ?? {};
    const root = opts.root ?? (opts.cacheRoot ? opts.cacheRoot + "/map_tree" : undefined) ?? MapTreeExtract.ROOT;
    const [census, err] = MapTree.walk(rom, opts.version, opts);
    if (!census) {
      if (opts.strict) throw new Error("map_tree: " + String(err));
      return [false, err];
    }
    if (opts.strict) {
      let want = 0;
      const groups = MapTree.loadGroups().groups ?? {};
      for (const k of Object.keys(groups)) {
        const g = groups[k];
        want = want + luaLen(g.maps ?? {});
      }
      if (census.map_count !== want) {
        throw new Error(format("map_tree: census has %d of %d maps", census.map_count, want));
      }
    }

    const tilesetIds: string[] = [];
    for (const ptr of Object.keys(census.tilesets)) {
      const ts = census.tilesets[Number(ptr)]!;
      pack_tileset(rom, cache, root, ts);
      tilesetIds.push(ts.id);
    }
    tilesetIds.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    const mapIndex: unknown[] = [];
    for (const entry of census.maps) {
      if (opts.progress) {
        opts.progress("map_tree", mapIndex.length, census.map_count);
      }
      pack_map(rom, cache, root, entry);
      mapIndex.push({
        slot: entry.slot,
        id: entry.id,
        group: entry.group,
        num: entry.num,
        width: entry.layout.width,
        height: entry.layout.height,
        primaryTileset: entry.primaryTileset,
        secondaryTileset: entry.secondaryTileset,
      });
    }

    write_json(cache, root + "/census.json", {
      version: "map_tree_v1",
      g_map_groups: census.g_map_groups,
      map_count: census.map_count,
      tileset_count: census.tileset_count,
      tilesets: tilesetIds,
      groups: census.groups,
      maps: mapIndex,
    });

    return [true, {
      root,
      map_count: census.map_count,
      tileset_count: census.tileset_count,
    }];
  },
};

export default MapTreeExtract;
