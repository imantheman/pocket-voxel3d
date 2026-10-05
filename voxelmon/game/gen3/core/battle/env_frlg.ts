// Port of gen1recomp src/core/game3/battle/env_frlg.lua (GPLv3 + additional terms; see LICENSE.md).
// FRLG battle environment: terrain ids, map types / battle scenes, the
// terrain -> background sheet table and the terrain resolvers
// (pret battle_setup.c, battle_bg.c).
//
// Port notes:
// - gen1recomp loads this module dynamically (battle/bg.lua's ENV_MODULES); it
//   had no stub, so it is created here and imported statically by bg.ts.
// - SHEET_DEGRADE entries are lt.ts sequences; TERRAIN_SHEET / SHEET_DEGRADE /
//   SCENE_TERRAIN are keyed by terrain / scene id (plain objects).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tonumber, truthy } from "../../../../import/gen3/lua.ts";
import { seq, type LuaTable } from "../../platform/lt.ts";
import Collision from "../collision.ts";

export interface EnvModule {
  family: string;
  TERRAIN: Record<string, number>;
  MAP_TYPE: Record<string, number>;
  MAP_BATTLE_SCENE: Record<string, number>;
  TERRAIN_SHEET: Record<number, string>;
  SHEET_DEGRADE: Record<number, LuaTable>;
  sheetFor?: (id: number, manifest: any) => string | undefined;
  resolveFromMapKind(kind?: string | null): number;
  resolveFromBehavior(behavior: any, mapKind?: string | null, mapType?: any, ctx?: any): number;
  resolveOverride(terrainId: any, opts?: any): number;
}

export const EnvFrlg = {} as EnvModule;

EnvFrlg.family = "frlg";

// pret include/constants/battle.h
EnvFrlg.TERRAIN = {
  GRASS: 0,
  LONG_GRASS: 1,
  SAND: 2,
  UNDERWATER: 3,
  WATER: 4,
  POND: 5,
  MOUNTAIN: 6,
  CAVE: 7,
  BUILDING: 8,
  PLAIN: 9,
  LINK: 10,
  GYM: 11,
  LEADER: 12,
  INDOOR_2: 13,
  INDOOR_1: 14,
  LORELEI: 15,
  BRUNO: 16,
  AGATHA: 17,
  LANCE: 18,
  CHAMPION: 19,
};

// pret include/constants/map_types.h:4
EnvFrlg.MAP_TYPE = {
  NONE: 0,
  TOWN: 1,
  CITY: 2,
  ROUTE: 3,
  UNDERGROUND: 4,
  UNDERWATER: 5,
  OCEAN_ROUTE: 6,
  UNKNOWN: 7,
  INDOOR: 8,
  SECRET_BASE: 9,
};

// pret include/constants/map_types.h:15
EnvFrlg.MAP_BATTLE_SCENE = {
  NORMAL: 0,
  GYM: 1,
  INDOOR_1: 2,
  INDOOR_2: 3,
  LORELEI: 4,
  BRUNO: 5,
  AGATHA: 6,
  LANCE: 7,
  LINK: 8,
};

const T0 = EnvFrlg.TERRAIN;
const S0 = EnvFrlg.MAP_BATTLE_SCENE;

// pret src/battle_bg.c:602 sMapBattleSceneMapping
const SCENE_TERRAIN: Record<number, number> = {
  [S0.GYM!]: T0.GYM!,
  [S0.INDOOR_1!]: T0.INDOOR_1!,
  [S0.INDOOR_2!]: T0.INDOOR_2!,
  [S0.LORELEI!]: T0.LORELEI!,
  [S0.BRUNO!]: T0.BRUNO!,
  [S0.AGATHA!]: T0.AGATHA!,
  [S0.LANCE!]: T0.LANCE!,
  [S0.LINK!]: T0.LINK!,
};

// pret include/constants/trainers.h:267
const TRAINER_CLASS_LEADER = 84;
const TRAINER_CLASS_CHAMPION = 90;

// pret src/battle_bg.c:439 sBattleTerrainTable
EnvFrlg.TERRAIN_SHEET = {
  [T0.GRASS!]: "grass",
  [T0.LONG_GRASS!]: "long_grass",
  [T0.SAND!]: "sand",
  [T0.UNDERWATER!]: "underwater",
  [T0.WATER!]: "water",
  [T0.POND!]: "pond",
  [T0.MOUNTAIN!]: "mountain",
  [T0.CAVE!]: "cave",
  [T0.BUILDING!]: "building",
  [T0.PLAIN!]: "plain",
  [T0.LINK!]: "link",
  [T0.GYM!]: "gym",
  [T0.LEADER!]: "leader",
  [T0.INDOOR_2!]: "indoor_2",
  [T0.INDOOR_1!]: "indoor_1",
  [T0.LORELEI!]: "lorelei",
  [T0.BRUNO!]: "bruno",
  [T0.AGATHA!]: "agatha",
  [T0.LANCE!]: "lance",
  [T0.CHAMPION!]: "champion",
};

EnvFrlg.SHEET_DEGRADE = {
  [T0.GRASS!]: seq("plain"),
  [T0.LONG_GRASS!]: seq("grass", "plain"),
  [T0.SAND!]: seq("grass", "plain"),
  [T0.UNDERWATER!]: seq("water", "pond"),
  [T0.WATER!]: seq("pond", "grass"),
  [T0.POND!]: seq("water", "grass"),
  [T0.MOUNTAIN!]: seq("cave", "plain"),
  [T0.CAVE!]: seq("mountain", "plain"),
  [T0.BUILDING!]: seq("plain"),
  [T0.PLAIN!]: seq("building"),
  [T0.LINK!]: seq("building", "plain"),
  [T0.GYM!]: seq("building", "plain"),
  [T0.LEADER!]: seq("gym", "building"),
  [T0.INDOOR_2!]: seq("indoor_1", "building"),
  [T0.INDOOR_1!]: seq("indoor_2", "building"),
  [T0.LORELEI!]: seq("indoor_1", "indoor_2", "building"),
  [T0.BRUNO!]: seq("indoor_1", "indoor_2", "building"),
  [T0.AGATHA!]: seq("indoor_1", "indoor_2", "building"),
  [T0.LANCE!]: seq("indoor_1", "indoor_2", "building"),
  [T0.CHAMPION!]: seq("leader", "indoor_1", "building"),
};

/** pret BattleSetup_GetTerrainId (simplified): indoor → BUILDING, else grass default outdoors. */
// Lua: env_frlg.lua:122
EnvFrlg.resolveFromMapKind = function (kind?: string | null): number {
  kind = truthy(kind) ? kind : "town";
  if (kind === "indoor" || kind === "building" || kind === "secret_base") {
    return EnvFrlg.TERRAIN.BUILDING!;
  }
  if (kind === "cave" || kind === "underground") {
    return EnvFrlg.TERRAIN.CAVE!;
  }
  if (kind === "water" || kind === "ocean") {
    return EnvFrlg.TERRAIN.WATER!;
  }
  // Routes / towns / field: tall grass battles use GRASS; default PLAIN→building tiles in pret.
  if (kind === "route" || kind === "town" || kind === "city") {
    return EnvFrlg.TERRAIN.GRASS!;
  }
  return EnvFrlg.TERRAIN.BUILDING!;
};

// pokefirered/include/constants/metatile_behaviors.h:4
const MB_TALL_GRASS = 0x02;
const MB_INDOOR_ENCOUNTER = 0x0B;
const MB_MOUNTAIN_TOP = 0x0C;
const MB_FAST_WATER = 0x11;
const MB_DEEP_WATER = 0x12;
const MB_OCEAN_WATER = 0x15;
const MB_SHALLOW_WATER = 0x17;
const MB_SAND = 0x21;
const MB_CYCLING_ROAD_PULL_DOWN_GRASS = 0xD1;

// pokefirered/src/metatile_behavior.c:432
// Lua: env_frlg.lua:152
function is_tall_grass(beh: number): boolean {
  return beh === MB_TALL_GRASS || beh === MB_CYCLING_ROAD_PULL_DOWN_GRASS;
}

// pokefirered/src/metatile_behavior.c:80
// Lua: env_frlg.lua:157
function is_sand_or_shallow_flowing_water(beh: number): boolean {
  return beh === MB_SAND || beh === MB_SHALLOW_WATER;
}

// pokefirered/src/metatile_behavior.c:518
// Lua: env_frlg.lua:162
function is_deep_water_terrain(beh: number): boolean {
  return (beh >= MB_FAST_WATER && beh <= MB_DEEP_WATER) || beh === MB_OCEAN_WATER;
}

const KIND_MAP_TYPE: Record<string, number> = {
  town: EnvFrlg.MAP_TYPE.TOWN!,
  city: EnvFrlg.MAP_TYPE.CITY!,
  route: EnvFrlg.MAP_TYPE.ROUTE!,
  cave: EnvFrlg.MAP_TYPE.UNDERGROUND!,
  underground: EnvFrlg.MAP_TYPE.UNDERGROUND!,
  water: EnvFrlg.MAP_TYPE.OCEAN_ROUTE!,
  ocean: EnvFrlg.MAP_TYPE.OCEAN_ROUTE!,
  indoor: EnvFrlg.MAP_TYPE.INDOOR!,
  building: EnvFrlg.MAP_TYPE.INDOOR!,
  secret_base: EnvFrlg.MAP_TYPE.SECRET_BASE!,
};

/** pokefirered/src/battle_setup.c:466 BattleSetup_GetTerrainId */
// Lua: env_frlg.lua:180
EnvFrlg.resolveFromBehavior = function (behavior: any, mapKind?: string | null, mapType?: any): number {
  const beh = tonumber(behavior);
  if (beh == null) return EnvFrlg.resolveFromMapKind(mapKind);
  const T = EnvFrlg.TERRAIN as Record<string, number>;
  const M = EnvFrlg.MAP_TYPE as Record<string, number>;
  const mt = tonumber(mapType) ?? KIND_MAP_TYPE[truthy(mapKind) ? mapKind! : "town"] ?? M.TOWN!;
  if (is_tall_grass(beh)) return T.GRASS!;
  if (is_sand_or_shallow_flowing_water(beh)) return T.SAND!;
  if (mt === M.UNDERGROUND) {
    if (beh === MB_INDOOR_ENCOUNTER) return T.BUILDING!;
    if (Collision.isSurfable(beh)) return T.POND!;
    return T.CAVE!;
  } else if (mt === M.INDOOR || mt === M.SECRET_BASE) {
    return T.BUILDING!;
  } else if (mt === M.UNDERWATER) {
    return T.UNDERWATER!;
  } else if (mt === M.OCEAN_ROUTE) {
    if (Collision.isSurfable(beh)) return T.WATER!;
    return T.PLAIN!;
  }
  if (is_deep_water_terrain(beh)) return T.WATER!;
  if (Collision.isSurfable(beh)) return T.POND!;
  if (beh === MB_MOUNTAIN_TOP) return T.MOUNTAIN!;
  return T.PLAIN!;
};

/** pokefirered/src/battle_bg.c:1048 GetBattleTerrainOverride */
// Lua: env_frlg.lua:207
EnvFrlg.resolveOverride = function (terrainId: any, opts?: any): number {
  opts = opts ?? {};
  const T = EnvFrlg.TERRAIN as Record<string, number>;
  const base = tonumber(terrainId) ?? T.PLAIN!;
  if (truthy(opts.link) || truthy(opts.trainerTower) || truthy(opts.battleTower) || truthy(opts.eReader)) {
    return T.LINK!;
  }
  if (truthy(opts.pokedude)) return T.GRASS!;
  if (truthy(opts.trainer)) {
    const cls = tonumber(opts.trainerClass);
    if (cls === TRAINER_CLASS_LEADER) return T.LEADER!;
    if (cls === TRAINER_CLASS_CHAMPION) return T.CHAMPION!;
  }
  const scene = tonumber(opts.mapBattleScene) ?? EnvFrlg.MAP_BATTLE_SCENE.NORMAL!;
  if (scene === EnvFrlg.MAP_BATTLE_SCENE.NORMAL) return base;
  // pokefirered/src/battle_bg.c:633 GetBattleTerrainByMapScene
  return SCENE_TERRAIN[scene] ?? T.PLAIN!;
};

export default EnvFrlg;
