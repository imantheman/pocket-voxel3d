// Port of gen1recomp src/core/game3/profiles/firered_rules.lua (GPLv3 + additional terms; see LICENSE.md).
// FireRed / LeafGreen save rules: the per-game half of save_schema_firered
// (New Game defaults, continue warps, load-time repairs). The profile row
// names this module as `saveRules`.
//
// NOT FAITHFUL (plumbing): trainer_fan_club, pokemon_size_record and roamer
// have no stub yet (they are reached only through this module's dynamic
// require), so newGameInit and repairRoamer stop with notPorted where the Lua
// requires them.

import { ipairs, seq } from "../../platform/lt.ts";
import { format, tonumber, tostring, truthy } from "../../../../import/gen3/lua.ts";
import { find, match } from "../../platform/lpattern.ts";
import { notPorted } from "../../notported.ts";
import { Flags } from "../scripting/flags.ts";
import { Safari } from "../safari.ts";
import { Field } from "../field.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Session = Record<string, any>;

// pokefirered/include/constants/flags.h:1327
const FLAG_SYS_SAFARI_MODE = 0x800;
// pokefirered/include/constants/vars.h:162
const VAR_MAP_SCENE_FUCHSIA_CITY_SAFARI_ZONE_ENTRANCE = 0x406E;

// Lua: firered_rules.lua:12
// NOT FAITHFUL: a JS object holds `vars["16494"]` and `vars[16494]` as one
// key, where the Lua table holds two; the final value (0) is the same.
function clear_saved_var(session: Session, id: number): void {
  const vars = session.vars;
  if (vars == null || typeof vars !== "object") return;
  delete vars[tostring(id)];
  delete vars[format("0x%X", id)];
  const name = Flags.VAR_NAMES && Flags.VAR_NAMES[id];
  if (truthy(name)) delete vars[name];
  vars[id] = 0;
}

// pokefirered/include/save_location.h:5
const CONTINUE_GAME_WARP = 0x01;
// pokefirered/data/maps/PokemonLeague_HallOfFame/scripts.inc:40
const HALL_OF_FAME_MAP = "FR_POKEMON_LEAGUE_HALL_OF_FAME";

const UNION_ROOMS: Record<string, boolean> = { FR_UNION_ROOM: true, FR_UNION_ROOM_PLAZA: true };
// pokefirered/data/maps/ViridianCity_PokemonCenter_2F/map.json:84
const UNION_DOOR_X = 5, UNION_DOOR_Y = 1;
const FIRST_CENTER_2F = "FR_VIRIDIAN_CITY_POKEMON_CENTER_2F";

// Lua: firered_rules.lua:49
function union_room_door_map(session: Session): string {
  const heal: string = typeof session.healMap === "string" ? session.healMap : "";
  const city = match(heal, "^(.+_POKEMON_CENTER)_1F$");
  if (city != null) return city + "_2F";
  if (match(heal, "_POKECENTER$") != null) return heal + "_2F";
  return FIRST_CENTER_2F;
}

// pokefirered/include/constants/map_groups.h:9
const LINK_ROOMS: Record<string, boolean> = {
  FR_BATTLE_COLOSSEUM_2P: true,
  FR_TRADE_CENTER: true,
  FR_RECORD_CORNER: true,
  FR_BATTLE_COLOSSEUM_4P: true,
  FR_UNION_ROOM: true,
  FR_UNION_ROOM_PLAZA: true,
};

export const FireredRules = {
  DEFAULT_NAME: "RED",
  DEFAULT_RIVAL: "BLUE",
  EASY_CHAT_PROFILE: seq(2601, 4128, 526, 2611),

  // Lua: firered_rules.lua:24
  // pokefirered/src/overworld.c:345 Overworld_ResetStateOnContinue
  resetStateOnContinue(session: Session): void {
    Flags.setFlag(session, null, FLAG_SYS_SAFARI_MODE, false);
    clear_saved_var(session, VAR_MAP_SCENE_FUCHSIA_CITY_SAFARI_ZONE_ENTRANCE);
    delete session.safari;
    if (typeof session.map === "string" && find(session.map, "^FR_SAFARI_ZONE_") != null
        && !truthy(Flags.getFlag(session, null, FLAG_SYS_SAFARI_MODE))) {
      // pokefirered/data/scripts/safari_zone.inc:7 SafariZone_EventScript_Exit
      Flags.setVar(session, null, VAR_MAP_SCENE_FUCHSIA_CITY_SAFARI_ZONE_ENTRANCE, 1);
      session.map = Safari.EXIT_MAP;
      session.x = Safari.EXIT_X;
      session.y = Safari.EXIT_Y;
      session.facing = "down";
    }
  },

  // Lua: firered_rules.lua:58
  // pokefirered/src/overworld.c:1706 CB2_ContinueSavedGame
  useContinueGameWarp(session: Session, mounted?: boolean): void {
    const f = tonumber(session.specialSaveWarpFlags) ?? 0;
    const w = session.continueGameWarp;
    if ((f & CONTINUE_GAME_WARP) !== 0 && w != null && typeof w === "object" && typeof w.map === "string") {
      session.specialSaveWarpFlags = f & ~CONTINUE_GAME_WARP;
      session.map = w.map;
      session.x = tonumber(w.x);
      session.y = tonumber(w.y);
      session.facing = "down";
      return;
    }
    delete session._continueWarpDeferred;
    if (UNION_ROOMS[session.map] === true) {
      session.map = union_room_door_map(session);
      session.x = UNION_DOOR_X;
      session.y = UNION_DOOR_Y;
      session.facing = "down";
      return;
    }
    if (session.map === HALL_OF_FAME_MAP) {
      if (!truthy(mounted) && !truthy(Field.flyDestinationsMounted())) {
        session._continueWarpDeferred = true;
        return;
      }
      // pokefirered/src/post_battle_event_funcs.c:33
      const dest = Field.flyDestination("MAPSEC_PALLET_TOWN");
      if (dest == null || !truthy(dest)) throw new Error("no heal location for MAPSEC_PALLET_TOWN");
      session.map = dest.map;
      session.x = dest.x;
      session.y = dest.y;
      session.facing = "down";
    }
  },

  // Lua: firered_rules.lua:97
  // pokefirered/src/load_save.c:149 SetContinueGameWarpStatusToDynamicWarp
  saveWarpFields(session: Session): [number, any] {
    const f = tonumber(session.specialSaveWarpFlags) ?? 0;
    const w = session.continueGameWarp;
    const dw = session.dynamicWarp;
    if (LINK_ROOMS[session.map] === true && dw != null && typeof dw === "object" && typeof dw.map === "string"
        && tonumber(dw.x) != null && tonumber(dw.y) != null) {
      // pokefirered/src/overworld.c:701 SetContinueGameWarpToDynamicWarp
      return [f | CONTINUE_GAME_WARP, { map: dw.map, warpId: tonumber(dw.warpId), x: tonumber(dw.x), y: tonumber(dw.y) }];
    }
    return [f, w];
  },

  // pokefirered/include/constants/region_map_sections.h:211 KANTO_MAPSEC_START
  OWN_MON_MET_LOCATION: 88,

  // Lua: firered_rules.lua:113
  // pokefirered/include/constants/flags.h:1083
  purgeNoneItemFlags(save: Session): void {
    for (let id = 0x3E8 + 51; id <= 0x3E8 + 62; id++) {
      delete save.flags[id];
      delete save.flags[tostring(id)];
    }
  },

  // Lua: firered_rules.lua:120
  newGameMoney(): number {
    return 3000;
  },

  // Lua: firered_rules.lua:124
  newGameFlags(): Record<string, boolean> {
    const hide: Record<string, boolean> = {};
    for (const [, id] of ipairs(Flags.NEW_GAME_HIDE_FLAGS ?? {})) {
      hide[tostring(id)] = true;
    }
    return hide;
  },

  // Lua: firered_rules.lua:133
  newVsSeeker(): Record<string, any> {
    return { steps: 0, charging: 0, rematches: {} };
  },

  // Lua: firered_rules.lua:137
  restoreVsSeeker(v: any): Record<string, any> {
    return v != null && typeof v === "object" ? v : { steps: 0, charging: 0, rematches: {} };
  },

  // Lua: firered_rules.lua:141
  newGamePcItems(storage: Session): void {
    storage.items[1] = { id: 13, qty: 1 }; // pokefirered/src/player_pc.c:100
  },

  // Lua: firered_rules.lua:145
  newGameInit(_session: Session, _opts?: unknown): void {
    // pokefirered/src/new_game.c:143 ResetTrainerFanClub
    // NOT FAITHFUL (plumbing): src.core.game3.trainer_fan_club has no stub.
    notPorted("trainer_fan_club.reset");
    // pokefirered/src/new_game.c:132 InitMagikarpSizeRecord
    // (pokemon_size_record.initMagikarpSizeRecord / initHeracrossSizeRecord)
  },

  // Lua: firered_rules.lua:154
  repairSaveState(session: Session): void {
    Flags.repairSaveState(session);
  },

  // Lua: firered_rules.lua:158
  repairRoamer(session: Session): void {
    const FLAG_SYS_CAN_LINK_WITH_RS = 0x844;
    const VAR_MAP_SCENE_ONE_ISLAND_POKEMON_CENTER_1F = 0x4076;
    const VAR_STARTER_MON = 0x4031;
    const flags = session.flags ?? {};
    const hasLink = (flags[FLAG_SYS_CAN_LINK_WITH_RS] === true) || (flags["FLAG_SYS_CAN_LINK_WITH_RS"] === true);
    const vars = session.vars ?? {};
    const sceneVal = tonumber(vars[VAR_MAP_SCENE_ONE_ISLAND_POKEMON_CENTER_1F] ?? vars["VAR_MAP_SCENE_ONE_ISLAND_POKEMON_CENTER_1F"]) ?? 0;
    if (hasLink || sceneVal >= 6) {
      // NOT FAITHFUL (plumbing): src.core.game3.roamer has no stub; the Lua
      // calls Roamer.init(session, tonumber(vars[VAR_STARTER_MON]) or 0).
      void VAR_STARTER_MON;
      notPorted("roamer.init");
    }
  },
};

export default FireredRules;
