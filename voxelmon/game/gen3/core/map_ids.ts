// Port of gen1recomp src/core/game3/map_ids.lua (GPLv3 + additional terms; see LICENSE.md).
// Shared Game3 map-id helpers (Fire Red FR_* and legacy Sevii SEVII_*).
//
// src.core.GameVersion is the importer's port (import/gen3/game_version.ts),
// as profile.ts and constants.ts use it.

import { Profile } from "./profile.ts";
import { Constants } from "./constants.ts";
import { MapCatalog } from "../../../import/gen3/map_catalog.ts";
import { GameVersion } from "../../../import/gen3/game_version.ts";
import { gsub } from "../platform/lpattern.ts";
import { ipairs } from "../platform/lt.ts";
import { sub, truthy } from "../../../import/gen3/lua.ts";

export interface NewGameStart {
  map: string; x: number; y: number; facing: string;
  healMap: string; healX: number; healY: number;
}

// Lua: map_ids.lua:7
function isGame3Map(mapId: unknown, gameId?: string): boolean {
  if (typeof mapId !== "string") return false;
  for (const [, prefix] of ipairs<string>(Profile.of(gameId).map.prefixes)) {
    if (sub(mapId, 1, prefix.length) === prefix) return true;
  }
  // pcall(require, "src.import.gba.map_catalog"): always there.
  if (MapCatalog && MapCatalog.isKnown) {
    return MapCatalog.isKnown(mapId);
  }
  return false;
}

// Lua: map_ids.lua:33
function newGameStart(gameId?: string): NewGameStart {
  const map = Profile.of(gameId).map;
  return truthy(map) && truthy(map.newGameStart) ? map.newGameStart : MapIds.NEW_GAME_START;
}

// Lua: map_ids.lua:38
function forConst(constName: unknown, gameId?: string): string | null {
  if (typeof constName !== "string") return null;
  gameId = gameId ?? GameVersion.get();
  let ok: boolean, C: any;
  try {
    C = Constants.of(gameId);
    ok = true;
  } catch {
    ok = false;
  }
  if (!ok) return null;
  const row = C.map_groups.byName[constName];
  if (!truthy(row)) return null;
  if (GameVersion.layout(gameId) === "rse") {
    return Profile.of(gameId).map.enginePrefix + gsub(constName, "^MAP_", "")[0];
  }
  // pcall(require, "src.import.gba.map_catalog"): always there.
  return MapCatalog.mapIdFor(row.group, row.num) ?? null;
}

// Lua: map_ids.lua:5, 19-31, then the functions in order.
export const MapIds = {
  isGame3Map,
  NEW_GAME_START: {
    map: "FR_PLAYERS_HOUSE_2F",
    x: 6,
    y: 6,
    facing: "down",
    // Whiteout / heal: pret HEAL_LOCATION_PALLET_TOWN -> PlayersHouse_1F (8,5) by Mom.
    healMap: "FR_PLAYERS_HOUSE_1F",
    healX: 8,
    healY: 5,
  } as NewGameStart,
  PALLET_TOWN: "FR_PALLET_TOWN",
  ROUTE_1: "FR_ROUTE_1",
  newGameStart,
  forConst,
};

export default MapIds;
