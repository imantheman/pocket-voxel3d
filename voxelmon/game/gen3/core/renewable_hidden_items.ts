// Port of gen1recomp src/core/game3/renewable_hidden_items.lua (GPLv3 + additional terms; see LICENSE.md).
// Renewable hidden items engine (Treasure Beach, Berry Forest, etc.)
// pokefirered/src/renewable_hidden_items.c
//
// Return shapes: isRenewableMap -> [isRenewable, zone]. A flag Flags.IDS does
// not know is nil in Brian's tables and ends the sequence there; seq() keeps
// it as a hole, and ipairs stops at it the same way.

import { tonumber } from "../../../import/gen3/lua.ts";
import { ipairs, seq, type LuaTable } from "../platform/lt.ts";
import { random } from "../platform/rng.ts";
import { Flags } from "./scripting/flags.ts";
import { Space as SpaceMod } from "./scripting/space.ts";
import { Runtime } from "./runtime.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface RenewableZone {
  name: string;
  group: number;
  map: number;
  mapIds: LuaTable;
  rare: LuaTable;
  uncommon: LuaTable;
  common: LuaTable;
}

// Lua: renewable_hidden_items.lua:9
const VAR_RENEWABLE_ITEM_STEP_COUNTER = 0x4023; // pokefirered/include/constants/vars.h:40
const STEP_THRESHOLD = 1500;

// Lua: renewable_hidden_items.lua:13 -- matching pokefirered/src/renewable_hidden_items.c
// Built on first use (Brian builds it at require time from Flags.IDS; the
// gen3 modules form one import cycle, so nothing reads an import at load).
let zonesCache: (RenewableZone | null)[] | null = null;
function zones(): (RenewableZone | null)[] {
  if (zonesCache) return zonesCache;
  // Lua: renewable_hidden_items.lua:5
  const F: Record<string, number> = Flags.IDS;
  zonesCache = seq<RenewableZone>(
  {
    name: "ROUTE20",
    group: 3, map: 36,
    mapIds: seq("ROUTE_20", "FR_ROUTE_20", "LG_ROUTE_20"),
    rare: seq(),
    uncommon: seq(F.FLAG_HIDDEN_ITEM_ROUTE20_STARDUST),
    common: seq(),
  },
  {
    name: "ROUTE21_NORTH",
    group: 3, map: 37,
    mapIds: seq("ROUTE_21_NORTH", "FR_ROUTE_21_NORTH", "LG_ROUTE_21_NORTH", "ROUTE_21"),
    rare: seq(),
    uncommon: seq(F.FLAG_HIDDEN_ITEM_ROUTE21_NORTH_PEARL),
    common: seq(),
  },
  {
    name: "UNDERGROUND_PATH_NORTH_SOUTH_TUNNEL",
    group: 1, map: 31,
    mapIds: seq("UNDERGROUND_PATH_NORTH_SOUTH_TUNNEL", "FR_UNDERGROUND_PATH_NORTH_SOUTH_TUNNEL"),
    rare: seq(F.FLAG_HIDDEN_ITEM_UNDERGROUND_PATH_NORTH_SOUTH_TUNNEL_ETHER),
    uncommon: seq(
      F.FLAG_HIDDEN_ITEM_UNDERGROUND_PATH_NORTH_SOUTH_TUNNEL_POTION,
      F.FLAG_HIDDEN_ITEM_UNDERGROUND_PATH_NORTH_SOUTH_TUNNEL_ANTIDOTE,
      F.FLAG_HIDDEN_ITEM_UNDERGROUND_PATH_NORTH_SOUTH_TUNNEL_PARALYZE_HEAL,
      F.FLAG_HIDDEN_ITEM_UNDERGROUND_PATH_NORTH_SOUTH_TUNNEL_AWAKENING,
      F.FLAG_HIDDEN_ITEM_UNDERGROUND_PATH_NORTH_SOUTH_TUNNEL_BURN_HEAL,
      F.FLAG_HIDDEN_ITEM_UNDERGROUND_PATH_NORTH_SOUTH_TUNNEL_ICE_HEAL,
    ),
    common: seq(),
  },
  {
    name: "UNDERGROUND_PATH_EAST_WEST_TUNNEL",
    group: 1, map: 34,
    mapIds: seq("UNDERGROUND_PATH_EAST_WEST_TUNNEL", "FR_UNDERGROUND_PATH_EAST_WEST_TUNNEL"),
    rare: seq(F.FLAG_HIDDEN_ITEM_UNDERGROUND_PATH_EAST_WEST_TUNNEL_ETHER),
    uncommon: seq(
      F.FLAG_HIDDEN_ITEM_UNDERGROUND_PATH_EAST_WEST_TUNNEL_POTION,
      F.FLAG_HIDDEN_ITEM_UNDERGROUND_PATH_EAST_WEST_TUNNEL_ANTIDOTE,
      F.FLAG_HIDDEN_ITEM_UNDERGROUND_PATH_EAST_WEST_TUNNEL_PARALYZE_HEAL,
      F.FLAG_HIDDEN_ITEM_UNDERGROUND_PATH_EAST_WEST_TUNNEL_AWAKENING,
      F.FLAG_HIDDEN_ITEM_UNDERGROUND_PATH_EAST_WEST_TUNNEL_BURN_HEAL,
      F.FLAG_HIDDEN_ITEM_UNDERGROUND_PATH_EAST_WEST_TUNNEL_ICE_HEAL,
    ),
    common: seq(),
  },
  {
    name: "SEVEN_ISLAND_TANOBY_RUINS",
    group: 3, map: 45,
    mapIds: seq("SEVII_SEVEN_ISLAND_TANOBY_RUINS", "SEVEN_ISLAND_TANOBY_RUINS", "FR_SEVEN_ISLAND_TANOBY_RUINS"),
    rare: seq(
      F.FLAG_HIDDEN_ITEM_SEVEN_ISLAND_TANOBY_RUINS_HEART_SCALE_4,
      F.FLAG_HIDDEN_ITEM_SEVEN_ISLAND_TANOBY_RUINS_HEART_SCALE,
      F.FLAG_HIDDEN_ITEM_SEVEN_ISLAND_TANOBY_RUINS_HEART_SCALE_2,
      F.FLAG_HIDDEN_ITEM_SEVEN_ISLAND_TANOBY_RUINS_HEART_SCALE_3,
    ),
    uncommon: seq(),
    common: seq(),
  },
  {
    name: "MT_MOON_B1F",
    group: 1, map: 2,
    mapIds: seq("MT_MOON_B1F", "FR_MT_MOON_B1F"),
    rare: seq(
      F.FLAG_HIDDEN_ITEM_MT_MOON_B1F_TINY_MUSHROOM,
      F.FLAG_HIDDEN_ITEM_MT_MOON_B1F_TINY_MUSHROOM_2,
      F.FLAG_HIDDEN_ITEM_MT_MOON_B1F_TINY_MUSHROOM_3,
      F.FLAG_HIDDEN_ITEM_MT_MOON_B1F_BIG_MUSHROOM,
      F.FLAG_HIDDEN_ITEM_MT_MOON_B1F_BIG_MUSHROOM_2,
      F.FLAG_HIDDEN_ITEM_MT_MOON_B1F_BIG_MUSHROOM_3,
    ),
    uncommon: seq(
      F.FLAG_HIDDEN_ITEM_MT_MOON_B1F_TINY_MUSHROOM,
      F.FLAG_HIDDEN_ITEM_MT_MOON_B1F_TINY_MUSHROOM_2,
      F.FLAG_HIDDEN_ITEM_MT_MOON_B1F_TINY_MUSHROOM_3,
    ),
    common: seq(),
  },
  {
    name: "THREE_ISLAND_BERRY_FOREST",
    group: 1, map: 109,
    mapIds: seq("SEVII_THREE_ISLAND_BERRY_FOREST", "THREE_ISLAND_BERRY_FOREST", "FR_THREE_ISLAND_BERRY_FOREST"),
    rare: seq(
      F.FLAG_HIDDEN_ITEM_THREE_ISLAND_BERRY_FOREST_BLUK_BERRY,
      F.FLAG_HIDDEN_ITEM_THREE_ISLAND_BERRY_FOREST_WEPEAR_BERRY,
      F.FLAG_HIDDEN_ITEM_THREE_ISLAND_BERRY_FOREST_ORAN_BERRY,
      F.FLAG_HIDDEN_ITEM_THREE_ISLAND_BERRY_FOREST_CHERI_BERRY,
      F.FLAG_HIDDEN_ITEM_THREE_ISLAND_BERRY_FOREST_ASPEAR_BERRY,
      F.FLAG_HIDDEN_ITEM_THREE_ISLAND_BERRY_FOREST_PERSIM_BERRY,
      F.FLAG_HIDDEN_ITEM_THREE_ISLAND_BERRY_FOREST_PINAP_BERRY,
      F.FLAG_HIDDEN_ITEM_THREE_ISLAND_BERRY_FOREST_LUM_BERRY,
    ),
    uncommon: seq(
      F.FLAG_HIDDEN_ITEM_THREE_ISLAND_BERRY_FOREST_BLUK_BERRY,
      F.FLAG_HIDDEN_ITEM_THREE_ISLAND_BERRY_FOREST_WEPEAR_BERRY,
      F.FLAG_HIDDEN_ITEM_THREE_ISLAND_BERRY_FOREST_ORAN_BERRY,
      F.FLAG_HIDDEN_ITEM_THREE_ISLAND_BERRY_FOREST_CHERI_BERRY,
      F.FLAG_HIDDEN_ITEM_THREE_ISLAND_BERRY_FOREST_ASPEAR_BERRY,
      F.FLAG_HIDDEN_ITEM_THREE_ISLAND_BERRY_FOREST_PERSIM_BERRY,
      F.FLAG_HIDDEN_ITEM_THREE_ISLAND_BERRY_FOREST_PINAP_BERRY,
    ),
    common: seq(
      F.FLAG_HIDDEN_ITEM_THREE_ISLAND_BERRY_FOREST_RAZZ_BERRY,
      F.FLAG_HIDDEN_ITEM_THREE_ISLAND_BERRY_FOREST_NANAB_BERRY,
      F.FLAG_HIDDEN_ITEM_THREE_ISLAND_BERRY_FOREST_CHESTO_BERRY,
      F.FLAG_HIDDEN_ITEM_THREE_ISLAND_BERRY_FOREST_PECHA_BERRY,
      F.FLAG_HIDDEN_ITEM_THREE_ISLAND_BERRY_FOREST_RAWST_BERRY,
    ),
  },
  {
    name: "ONE_ISLAND_TREASURE_BEACH",
    group: 3, map: 46,
    mapIds: seq("SEVII_ONE_ISLAND_TREASURE_BEACH", "ONE_ISLAND_TREASURE_BEACH", "FR_ONE_ISLAND_TREASURE_BEACH"),
    rare: seq(
      F.FLAG_HIDDEN_ITEM_ONE_ISLAND_TREASURE_BEACH_ULTRA_BALL,
      F.FLAG_HIDDEN_ITEM_ONE_ISLAND_TREASURE_BEACH_ULTRA_BALL_2,
      F.FLAG_HIDDEN_ITEM_ONE_ISLAND_TREASURE_BEACH_STAR_PIECE,
      F.FLAG_HIDDEN_ITEM_ONE_ISLAND_TREASURE_BEACH_BIG_PEARL,
    ),
    uncommon: seq(
      F.FLAG_HIDDEN_ITEM_ONE_ISLAND_TREASURE_BEACH_STARDUST,
      F.FLAG_HIDDEN_ITEM_ONE_ISLAND_TREASURE_BEACH_STARDUST_2,
      F.FLAG_HIDDEN_ITEM_ONE_ISLAND_TREASURE_BEACH_PEARL,
      F.FLAG_HIDDEN_ITEM_ONE_ISLAND_TREASURE_BEACH_PEARL_2,
      F.FLAG_HIDDEN_ITEM_ONE_ISLAND_TREASURE_BEACH_ULTRA_BALL,
      F.FLAG_HIDDEN_ITEM_ONE_ISLAND_TREASURE_BEACH_ULTRA_BALL_2,
    ),
    common: seq(
      F.FLAG_HIDDEN_ITEM_ONE_ISLAND_TREASURE_BEACH_ULTRA_BALL,
      F.FLAG_HIDDEN_ITEM_ONE_ISLAND_TREASURE_BEACH_ULTRA_BALL_2,
    ),
  },
  {
    name: "THREE_ISLAND_BOND_BRIDGE",
    group: 3, map: 48,
    mapIds: seq("SEVII_THREE_ISLAND_BOND_BRIDGE", "THREE_ISLAND_BOND_BRIDGE", "FR_THREE_ISLAND_BOND_BRIDGE"),
    rare: seq(),
    uncommon: seq(
      F.FLAG_HIDDEN_ITEM_THREE_ISLAND_BOND_BRIDGE_PEARL,
      F.FLAG_HIDDEN_ITEM_THREE_ISLAND_BOND_BRIDGE_STARDUST,
    ),
    common: seq(),
  },
  {
    name: "FOUR_ISLAND",
    group: 3, map: 5,
    mapIds: seq("SEVII_FOUR_ISLAND", "FOUR_ISLAND", "FR_FOUR_ISLAND"),
    rare: seq(),
    uncommon: seq(F.FLAG_HIDDEN_ITEM_FOUR_ISLAND_PEARL),
    common: seq(F.FLAG_HIDDEN_ITEM_FOUR_ISLAND_ULTRA_BALL),
  },
  {
    name: "FIVE_ISLAND_MEMORIAL_PILLAR",
    group: 3, map: 51,
    mapIds: seq("SEVII_FIVE_ISLAND_MEMORIAL_PILLAR", "FIVE_ISLAND_MEMORIAL_PILLAR", "FR_FIVE_ISLAND_MEMORIAL_PILLAR"),
    rare: seq(F.FLAG_HIDDEN_ITEM_FIVE_ISLAND_MEMORIAL_PILLAR_BIG_PEARL),
    uncommon: seq(),
    common: seq(),
  },
  {
    name: "FIVE_ISLAND_RESORT_GORGEOUS",
    group: 3, map: 52,
    mapIds: seq("SEVII_FIVE_ISLAND_RESORT_GORGEOUS", "FIVE_ISLAND_RESORT_GORGEOUS", "FR_FIVE_ISLAND_RESORT_GORGEOUS"),
    rare: seq(
      F.FLAG_HIDDEN_ITEM_FIVE_ISLAND_RESORT_GORGEOUS_NEST_BALL,
      F.FLAG_HIDDEN_ITEM_FIVE_ISLAND_RESORT_GORGEOUS_STAR_PIECE,
    ),
    uncommon: seq(
      F.FLAG_HIDDEN_ITEM_FIVE_ISLAND_RESORT_GORGEOUS_STARDUST,
      F.FLAG_HIDDEN_ITEM_FIVE_ISLAND_RESORT_GORGEOUS_STARDUST_2,
    ),
    common: seq(),
  },
  {
    name: "SIX_ISLAND_OUTCAST_ISLAND",
    group: 3, map: 53,
    mapIds: seq("SEVII_SIX_ISLAND_OUTCAST_ISLAND", "SIX_ISLAND_OUTCAST_ISLAND", "FR_SIX_ISLAND_OUTCAST_ISLAND"),
    rare: seq(
      F.FLAG_HIDDEN_ITEM_SIX_ISLAND_OUTCAST_ISLAND_STAR_PIECE,
      F.FLAG_HIDDEN_ITEM_SIX_ISLAND_OUTCAST_ISLAND_NET_BALL,
    ),
    uncommon: seq(),
    common: seq(),
  },
  {
    name: "SIX_ISLAND_GREEN_PATH",
    group: 3, map: 54,
    mapIds: seq("SEVII_SIX_ISLAND_GREEN_PATH", "SIX_ISLAND_GREEN_PATH", "FR_SIX_ISLAND_GREEN_PATH"),
    rare: seq(),
    uncommon: seq(),
    common: seq(F.FLAG_HIDDEN_ITEM_SIX_ISLAND_GREEN_PATH_ULTRA_BALL),
  },
  {
    name: "SEVEN_ISLAND_TRAINER_TOWER",
    group: 3, map: 56,
    mapIds: seq("SEVII_SEVEN_ISLAND_TRAINER_TOWER", "SEVEN_ISLAND_TRAINER_TOWER", "FR_SEVEN_ISLAND_TRAINER_TOWER"),
    rare: seq(F.FLAG_HIDDEN_ITEM_SEVEN_ISLAND_TRAINER_TOWER_BIG_PEARL),
    uncommon: seq(F.FLAG_HIDDEN_ITEM_SEVEN_ISLAND_TRAINER_TOWER_PEARL),
    common: seq(),
  },
  );
  return zonesCache;
}

// Lua: renewable_hidden_items.lua:218
function resolveStore(ctx: any): any {
  const Space: any = SpaceMod;
  if (Space && Space.store) return Space.store;
  const session = Runtime && Runtime.getSession ? Runtime.getSession() : undefined;
  if (session && session.store) return session.store;
  if (ctx != null && typeof ctx === "object") {
    if (ctx.vars || ctx.flags) return ctx;
    if (ctx.store) return ctx.store;
  }
  return null;
}

// Lua: renewable_hidden_items.lua:263 -- pokefirered/src/renewable_hidden_items.c:536
function setAllRenewableFlags(ctx: any): void {
  const store = resolveStore(ctx);
  for (const [, zone] of ipairs<RenewableZone>(zones())) {
    for (const [, flagId] of ipairs<number>(zone.rare)) {
      if (flagId) Flags.setFlag(store, ctx, flagId, true);
    }
    for (const [, flagId] of ipairs<number>(zone.uncommon)) {
      if (flagId) Flags.setFlag(store, ctx, flagId, true);
    }
    for (const [, flagId] of ipairs<number>(zone.common)) {
      if (flagId) Flags.setFlag(store, ctx, flagId, true);
    }
  }
}

// Lua: renewable_hidden_items.lua:279 -- pokefirered/src/renewable_hidden_items.c:587
function sampleRenewableFlags(ctx: any, rngFn?: () => number): void {
  const store = resolveStore(ctx);
  const rand = rngFn ?? (() => random(0, 99));

  for (const [, zone] of ipairs<RenewableZone>(zones())) {
    const rval = rand() % 100;
    let flags: LuaTable;
    if (rval >= 90) {
      flags = zone.rare;
    } else if (rval >= 60) {
      flags = zone.uncommon;
    } else {
      flags = zone.common;
    }

    for (const [, flagId] of ipairs<number>(flags)) {
      if (flagId) {
        // FlagClear makes the item exist/spawn on the map
        Flags.setFlag(store, ctx, flagId, false);
      }
    }
  }
}

export const RenewableHiddenItems = {
  // Lua: renewable_hidden_items.lua:216
  get ZONES(): (RenewableZone | null)[] { return zones(); },

  // Lua: renewable_hidden_items.lua:231
  isRenewableMap(mapGroupIn: unknown, mapNumIn: unknown, mapId?: any): [boolean, RenewableZone | null] {
    const mapGroup = tonumber(mapGroupIn);
    const mapNum = tonumber(mapNumIn);
    for (const [, zone] of ipairs<RenewableZone>(zones())) {
      if (mapGroup != null && mapNum != null && zone.group === mapGroup && zone.map === mapNum) {
        return [true, zone];
      }
      if (mapId) {
        for (const [, mid] of ipairs<string>(zone.mapIds)) {
          if (mid === mapId) return [true, zone];
        }
      }
    }
    return [false, null];
  },

  // Lua: renewable_hidden_items.lua:248 -- pokefirered/src/renewable_hidden_items.c:557
  onStep(ctx: any, mapGroup: unknown, mapNum: unknown, mapId?: any): boolean {
    // Requirement 1: If player is inside one of the renewable item maps, do NOT increment
    if (RenewableHiddenItems.isRenewableMap(mapGroup, mapNum, mapId)[0]) {
      return false;
    }

    const store = resolveStore(ctx);
    const v = tonumber(Flags.getVar(store, ctx, VAR_RENEWABLE_ITEM_STEP_COUNTER)) ?? 0;
    if (v < STEP_THRESHOLD) {
      Flags.setVar(store, ctx, VAR_RENEWABLE_ITEM_STEP_COUNTER, v + 1);
    }
    return true;
  },

  // Lua: renewable_hidden_items.lua:304 -- pokefirered/src/renewable_hidden_items.c:566
  tryRegenerate(ctx: any, mapGroup: unknown, mapNum: unknown, mapId?: any, rngFn?: () => number): boolean {
    const [isRenewable] = RenewableHiddenItems.isRenewableMap(mapGroup, mapNum, mapId);
    if (!isRenewable) return false;

    const store = resolveStore(ctx);
    const v = tonumber(Flags.getVar(store, ctx, VAR_RENEWABLE_ITEM_STEP_COUNTER)) ?? 0;
    if (v >= STEP_THRESHOLD) {
      Flags.setVar(store, ctx, VAR_RENEWABLE_ITEM_STEP_COUNTER, 0);
      setAllRenewableFlags(ctx);
      sampleRenewableFlags(ctx, rngFn);
      return true;
    }
    return false;
  },
};

export default RenewableHiddenItems;
