// Port of gen1recomp src/ui/game3/region_map_position.lua (GPLv3 + additional terms; see LICENSE.md).
// Where the player's head sits on the Town Map (pokefirered src/region_map.c
// GetPlayerPositionOnRegionMap and its overrides), and which of the four maps
// a section is on.
//
// The geometry and layouts tables come from the importer
// (region_map_extract.ts GEOMETRY / LAYOUTS, read with readLuaLiteral), so
// they keep the importer's shape: a section's `{w, h}` / `{x, y}` row is a
// 0-based JS array (Lua [1] is [0]), the mapsec-keyed tables are objects keyed
// by mapsec, and each seviiMapsecs row is a 0-based array.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { MapCatalog } from "../../../import/gen3/map_catalog.ts";
import { MapSectionsExtract } from "../../../import/gen3/map_sections_extract.ts";
import { mod, tonumber, tostring } from "../../../import/gen3/lua.ts";
import { match } from "../platform/lpattern.ts";

/** A warp as the session stores it. */
export interface Warp { map?: string; x?: number; y?: number; [k: string]: unknown }

/** What GetPlayerPositionOnRegionMap reads: the map, the player cell, the two warps, the map headers. */
export interface PositionCtx {
  map: string;
  x: number;
  y: number;
  escapeWarp?: unknown;
  dynamicWarp?: unknown;
  def: (mapId: string) => any;
}

// include/constants/map_types.h:8
const MAP_TYPE_UNDERGROUND = 4;
const MAP_TYPE_UNKNOWN = 7;
const MAP_TYPE_INDOOR = 8;
const MAP_TYPE_SECRET_BASE = 9;

// Lua: region_map_position.lua:12
function sec(id: string): number {
  const v = MapSectionsExtract.ID_TO_SECTION[id];
  if (v == null) throw new Error(id);
  return v;
}

// Lua: region_map_position.lua:16
function slotNum(mapId: string | undefined): number | undefined {
  const slot = MapCatalog.slotKeyFor(mapId);
  if (slot == null) throw new Error("no map slot for " + tostring(mapId));
  return tonumber(match(slot, "_(%d+)$"));
}

// Lua: region_map_position.lua:21
function mapNum(pretName: string): number | undefined {
  const id = MapCatalog.resolve(pretName);
  if (id == null) throw new Error(pretName);
  return slotNum(id);
}

// src/region_map.c:3174
const FIXED: Record<string, [number, number]> = {
  MAPSEC_KANTO_SAFARI_ZONE: [12, 12],
  MAPSEC_SILPH_CO: [14, 6],
  MAPSEC_POKEMON_MANSION: [4, 14],
  MAPSEC_POKEMON_TOWER: [18, 6],
  MAPSEC_POWER_PLANT: [18, 4],
  MAPSEC_S_S_ANNE: [14, 9],
  MAPSEC_POKEMON_LEAGUE: [2, 3],
  MAPSEC_ROCKET_HIDEOUT: [11, 6],
  MAPSEC_BIRTH_ISLAND: [18, 13],
  MAPSEC_NAVEL_ROCK: [10, 8],
  MAPSEC_TRAINER_TOWER_2: [5, 6],
  MAPSEC_MT_EMBER: [2, 3],
  MAPSEC_BERRY_FOREST: [14, 12],
  MAPSEC_PATTERN_BUSH: [17, 3],
  MAPSEC_ROCKET_WAREHOUSE: [17, 11],
  MAPSEC_DILFORD_CHAMBER: [9, 12],
  MAPSEC_LIPTOO_CHAMBER: [9, 12],
  MAPSEC_MONEAN_CHAMBER: [9, 12],
  MAPSEC_RIXY_CHAMBER: [9, 12],
  MAPSEC_SCUFIB_CHAMBER: [9, 12],
  MAPSEC_TANOBY_CHAMBERS: [9, 12],
  MAPSEC_VIAPOIS_CHAMBER: [9, 12],
  MAPSEC_WEEPTH_CHAMBER: [9, 12],
  MAPSEC_DOTTED_HOLE: [16, 8],
  MAPSEC_VIRIDIAN_FOREST: [4, 6],
};

// Lua: region_map_position.lua:54
function warpOrZero(warp: unknown): Warp {
  if (warp !== null && typeof warp === "object" && (warp as Warp).map != null) return warp as Warp;
  return { map: MapCatalog.mapIdFor(0, 0), x: 0, y: 0 };
}

// src/region_map.c:3096
// Lua: region_map_position.lua:60
function scaled(ctx: PositionCtx, geometry: any): [number, number] {
  const def = ctx.def(ctx.map);
  const mapType = tonumber(def.mapType);
  let mapsec: any, header: any, x: any, y: any;
  if (mapType === MAP_TYPE_UNDERGROUND || mapType === MAP_TYPE_UNKNOWN) {
    const warp = warpOrZero(ctx.escapeWarp);
    header = ctx.def(warp.map!);
    [mapsec, x, y] = [header.regionMapSectionId, warp.x, warp.y];
  } else if (mapType === MAP_TYPE_SECRET_BASE) {
    const warp = warpOrZero(ctx.dynamicWarp);
    header = ctx.def(warp.map!);
    [mapsec, x, y] = [header.regionMapSectionId, warp.x, warp.y];
  } else if (mapType === MAP_TYPE_INDOOR) {
    mapsec = def.regionMapSectionId;
    let warp: Warp;
    if (mapsec !== sec("MAPSEC_SPECIAL_AREA")) {
      warp = warpOrZero(ctx.escapeWarp);
      header = ctx.def(warp.map!);
    } else {
      warp = warpOrZero(ctx.dynamicWarp);
      header = ctx.def(warp.map!);
      mapsec = header.regionMapSectionId;
    }
    [x, y] = [warp.x, warp.y];
  } else {
    [mapsec, header, x, y] = [def.regionMapSectionId, def, ctx.x, ctx.y];
  }
  // importer shape: objects keyed by mapsec, rows 0-based ({w, h} -> [0], [1])
  const dims = geometry.dimensions[mapsec];
  if (dims == null) throw new Error("no sMapSectionDimensions row for mapsec " + tostring(mapsec));
  const corner = geometry.topLeft[mapsec];
  if (corner == null) throw new Error("no sMapSectionTopLeftCorners row for mapsec " + tostring(mapsec));
  let px = mod(Math.floor(tonumber(x) ?? 0), 65536);
  let py = mod(Math.floor(tonumber(y) ?? 0), 65536);
  let divisor = Math.floor(header.width / dims[0]);
  if (divisor === 0) divisor = 1;
  px = Math.floor(px / divisor);
  if (px >= dims[0]) px = dims[0] - 1;
  divisor = Math.floor(header.height / dims[1]);
  if (divisor === 0) divisor = 1;
  py = Math.floor(py / divisor);
  if (py >= dims[1]) py = dims[1] - 1;
  return [px + corner[0], py + corner[1]];
}

export const Position = {
  // src/region_map.c:3174 GetPlayerPositionOnRegionMap_HandleOverrides
  // Lua: region_map_position.lua:103
  playerCell(ctx: PositionCtx, geometry: any): [number, number] {
    const current = ctx.def(ctx.map).regionMapSectionId;
    const num = slotNum(ctx.map);
    for (const id of Object.keys(FIXED)) {
      const cell = FIXED[id]!;
      if (current === sec(id)) return [cell[0], cell[1]];
    }
    if (current === sec("MAPSEC_UNDERGROUND_PATH")) {
      if (num === mapNum("UndergroundPath_NorthEntrance")) return [14, 5];
      return [14, 7];
    } else if (current === sec("MAPSEC_UNDERGROUND_PATH_2")) {
      if (num === mapNum("UndergroundPath_EastEntrance")) return [15, 6];
      return [12, 6];
    } else if (current === sec("MAPSEC_ROUTE_2")) {
      if (num === mapNum("PalletTown")) return [4, 7];
      if (num === mapNum("CeruleanCity")) return [4, 5];
    } else if (current === sec("MAPSEC_ROUTE_21")) {
      if (num === mapNum("Route21_North")) return [4, 12];
      if (num === mapNum("Route21_South")) return [4, 13];
      return [0, 0];
    } else if (current === sec("MAPSEC_ROUTE_5")) {
      if (num === mapNum("ViridianCity")) return [14, 5];
    } else if (current === sec("MAPSEC_ROUTE_6")) {
      if (num === mapNum("PalletTown")) return [14, 7];
    } else if (current === sec("MAPSEC_ROUTE_7")) {
      if (num === mapNum("PalletTown")) return [13, 6];
    } else if (current === sec("MAPSEC_ROUTE_8")) {
      if (num === mapNum("PalletTown")) return [15, 6];
    }
    return scaled(ctx, geometry);
  },

  // src/region_map.c:1030-1049
  // Lua: region_map_position.lua:135
  regionFor(mapsec: number, layouts: any): number {
    if (mapsec < sec("MAPSEC_ONE_ISLAND")) return 0;
    for (let j = 0; j <= 2; j++) {
      // importer shape: seviiMapsecs keyed 0..2, each row a 0-based array
      for (const m of layouts.seviiMapsecs[j] as number[]) {
        if (m === mapsec) return j + 1;
      }
    }
    throw new Error("mapsec " + tostring(mapsec) + " is in no sSeviiMapsecs row");
  },
};

export default Position;
