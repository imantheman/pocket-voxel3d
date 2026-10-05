// Port of gen1recomp src/core/game3/heal_locations.lua (GPLv3 + additional terms; see LICENSE.md).
// pret heal_locations.json whiteout destinations (SetWhiteoutRespawnWarpAndHealerNpc).
// Indices match HEAL_LOCATION_* (1-based). setrespawn stores lastHealLocation;
// whiteout warps to respawnMap at these coords (special-cased in heal_location.c).
//
// The Lua's pcall(require, "src.import.gba.extract_island1").CACHE_ROOT is
// CachePaths.CACHE_ROOT (extract_island1 forwards that key to cache_paths), so
// cache_paths is read directly. Dataset.cache() is kept (the dataset module's
// own call); the cache chunk goes through luaLoad.

import { tonumber } from "../../../import/gen3/lua.ts";
import { pairs } from "../platform/lt.ts";
import { luaLoad } from "../platform/luadata.ts";
import { CachePaths } from "./cache_paths.ts";
import { Dataset } from "./dataset.ts";
import { Profile } from "./profile.ts";
import { MapIds } from "./map_ids.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface HealLocation { map: string; x: number; y: number; healerLocalId?: number }
interface CacheLike { read(rel: string): string | undefined | null }

// Lua: heal_locations.lua:8
// MAP_* → FR_* for extracted Kanto maps; only One Island uses the SEVII_ prefix.
function fr_center(city: string): string {
  return "FR_" + city + "_POKEMON_CENTER_1F";
}

function isTable(v: unknown): v is Record<string, any> {
  return v !== null && typeof v === "object";
}

// Lua: heal_locations.lua:59
function default_root(): string {
  const root = CachePaths.CACHE_ROOT;
  if (root) return root;
  return "data/generated/gba";
}

// Lua: heal_locations.lua:67
function love_cache(): CacheLike | undefined {
  if (Dataset && Dataset.cache) {
    return Dataset.cache();
  }
  return undefined;
}

// Lua: heal_locations.lua:75
function normalize(row: any): HealLocation | undefined {
  if (!isTable(row)) return undefined;
  const map = row.map;
  if (typeof map !== "string" || map === "") return undefined;
  return {
    map,
    x: tonumber(row.x) ?? 0,
    y: tonumber(row.y) ?? 0,
    healerLocalId: tonumber(row.healerLocalId),
  };
}

// Lua: heal_locations.lua:135
function sourceFallback(): boolean {
  const heal = Profile.active().heal;
  return isTable(heal) && heal.table === "firered";
}

export const HealLocations = {
  // Whiteout standing tile in front of healer (pret heal_location.c).
  // Pallet Mom house: (8,5). Indigo/One Island specials. Else poke-center (7,4).
  BY_ID: {
    1: { // HEAL_LOCATION_PALLET_TOWN
      map: "FR_PLAYERS_HOUSE_1F",
      x: 8,
      y: 5,
      healerLocalId: 1, // LOCALID_MOM
    },
    2: { map: fr_center("VIRIDIAN_CITY"), x: 7, y: 4, healerLocalId: 1 },
    // pokefirered/include/constants/map_event_ids.h:170
    3: { map: fr_center("PEWTER_CITY"), x: 7, y: 4, healerLocalId: 3 },
    4: { map: fr_center("CERULEAN_CITY"), x: 7, y: 4, healerLocalId: 1 },
    5: { map: fr_center("LAVENDER_TOWN"), x: 7, y: 4, healerLocalId: 1 },
    6: { map: fr_center("VERMILION_CITY"), x: 7, y: 4, healerLocalId: 1 },
    7: { map: fr_center("CELADON_CITY"), x: 7, y: 4, healerLocalId: 1 },
    8: { map: fr_center("FUCHSIA_CITY"), x: 7, y: 4, healerLocalId: 1 },
    9: { map: fr_center("CINNABAR_ISLAND"), x: 7, y: 4, healerLocalId: 1 },
    10: { // HEAL_LOCATION_INDIGO_PLATEAU
      map: "FR_INDIGO_PLATEAU_POKEMON_CENTER_1F",
      x: 13,
      y: 12,
      healerLocalId: 2, // pokefirered/include/constants/map_event_ids.h:109
    },
    11: { map: fr_center("SAFFRON_CITY"), x: 7, y: 4, healerLocalId: 1 },
    12: { map: "FR_ROUTE_4_POKEMON_CENTER_1F", x: 7, y: 4, healerLocalId: 1 },
    13: { map: "FR_ROUTE_10_POKEMON_CENTER_1F", x: 7, y: 4, healerLocalId: 1 },
    14: { // HEAL_LOCATION_ONE_ISLAND
      map: "SEVII_ONE_ISLAND_POKECENTER",
      x: 5,
      y: 4,
      healerLocalId: 1,
    },
    15: { map: "FR_TWO_ISLAND_POKEMON_CENTER_1F", x: 7, y: 4, healerLocalId: 1 },
    16: { map: "FR_THREE_ISLAND_POKEMON_CENTER_1F", x: 7, y: 4, healerLocalId: 1 },
    17: { map: "FR_FOUR_ISLAND_POKEMON_CENTER_1F", x: 7, y: 4, healerLocalId: 1 },
    18: { map: "FR_FIVE_ISLAND_POKEMON_CENTER_1F", x: 7, y: 4, healerLocalId: 1 },
    19: { map: "FR_SEVEN_ISLAND_POKEMON_CENTER_1F", x: 7, y: 4, healerLocalId: 1 },
    20: { map: "FR_SIX_ISLAND_POKEMON_CENTER_1F", x: 7, y: 4, healerLocalId: 1 },
  } as Record<number, HealLocation>,

  // pokefirered/src/heal_location.c:52 GetHealLocation
  BAKED_REL: "region_map/heal_locations.lua",

  _baked: undefined as Record<number, HealLocation> | undefined,
  _bakedRoot: undefined as string | undefined,
  _model: undefined as any,

  // Lua: heal_locations.lua:88
  // pokefirered/src/data/heal_locations.h:129 sWhiteoutRespawnHealCenterMapIdxs
  install(pack: any): number {
    HealLocations._baked = {};
    HealLocations._model = isTable(pack) ? pack.model : undefined;
    if (!isTable(pack)) return 0;
    const rows = pack.whiteout;
    if (!isTable(rows)) return 0;
    let n = 0;
    for (const [key, row] of pairs(rows)) {
      const id = (isTable(row) ? tonumber(row.id) : undefined) ?? tonumber(key);
      const loc = normalize(row);
      if (id != null && loc) {
        HealLocations._baked[id] = loc;
        n = n + 1;
      }
    }
    return n;
  },

  // Lua: heal_locations.lua:106
  load(cache?: CacheLike | null, root?: string | null): number {
    cache = cache ?? love_cache();
    root = root ?? default_root();
    if (!(cache && cache.read)) return 0;
    const rel = root + "/" + HealLocations.BAKED_REL;
    const src = cache.read(rel);
    if (typeof src !== "string" || src === "") return 0;
    const [chunk] = luaLoad(src, "@" + rel);
    if (!chunk) return 0;
    let pack: any;
    try {
      pack = chunk();
    } catch {
      return 0;
    }
    HealLocations._bakedRoot = root;
    return HealLocations.install(pack);
  },

  // Lua: heal_locations.lua:121
  invalidate(): void {
    HealLocations._baked = undefined;
    HealLocations._bakedRoot = undefined;
    HealLocations._model = undefined;
  },

  // Lua: heal_locations.lua:128
  // pokeemerald/src/overworld.c:364 SetWarpDestinationToLastHealLocation
  model(): any {
    if (HealLocations._baked == null) {
      HealLocations.load();
    }
    return HealLocations._model;
  },

  // Lua: heal_locations.lua:140
  get(idIn: unknown): HealLocation | undefined {
    const id = tonumber(idIn) ?? 0;
    if (HealLocations._baked == null) {
      HealLocations.load();
    }
    const baked = HealLocations._baked && HealLocations._baked[id];
    if (baked) return baked;
    if (!sourceFallback()) return undefined;
    return HealLocations.BY_ID[id];
  },

  /** Apply setrespawn / default heal onto a session (whiteout destination). */
  // Lua: heal_locations.lua:152
  applyToSession(session: any, id: unknown): boolean {
    const loc = HealLocations.get(id);
    if (!(session && loc)) return false;
    session.healMap = loc.map;
    session.healX = loc.x;
    session.healY = loc.y;
    session.healHealerLocalId = loc.healerLocalId;
    return true;
  },

  /** Migrate bad early defaults (bedroom 2F has no Mom). */
  // Lua: heal_locations.lua:163
  normalizeSession(session: any): void {
    if (!session) return;
    const start = MapIds.newGameStart(session.version);
    if (start.healMap && session.healMap === start.map) {
      HealLocations.applyToSession(session, 1);
    }
  },
};

export default HealLocations;
