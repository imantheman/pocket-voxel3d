// Port of gen1recomp src/core/game3/roamer.lua (GPLv3 + additional terms; see LICENSE.md).
// Roaming Legendary Beast system matching pokefirered (src/roamer.c)
// Raikou, Entei, and Suicune in Kanto.
//
// The *Rse functions run off the battle profile's `roamer` config, which only
// Emerald's profile has; FireRed takes the LOCATIONS / ADJACENCY path.

import { tonumber, tostring, truthy } from "../../../import/gen3/lua.ts";
import { find, gsub, match } from "../platform/lpattern.ts";
import { ipairs, len, seq, type LuaTable } from "../platform/lt.ts";
import { luaLoad } from "../platform/luadata.ts";
import { MapCatalog } from "../../../import/gen3/map_catalog.ts";
import { Rng } from "./rng.ts";
import { Pokemon } from "./pokemon.ts";
import { BattleProfile } from "./battle/profile.ts";
import { Dataset } from "./dataset.ts";
import { Constants } from "./constants.ts";
import { Party } from "./party.ts";
import { Space } from "./scripting/space.ts";
import { Flags } from "./scripting/flags.ts";
import Natives from "./scripting/natives.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface RoamerState {
  active: boolean;
  species: number;
  level: number;
  hp: number;
  maxHp?: number;
  status: any;
  statusNum?: any;
  pid?: number;
  personality?: number;
  ivs: any;
  moves?: LuaTable;
  pp?: LuaTable;
  map: any;
  history?: LuaTable;
}

export interface RoamerEncounter {
  species: number;
  level: number;
  roamer: true;
  foe: Record<string, any>;
}

// Lua: roamer.lua:9
function rse_cfg(session: any): any {
  let p: any;
  try { p = (BattleProfile as any).get(session); } catch { return null; }
  return p ? p.roamer ?? null : null;
}

// Lua: roamer.lua:32
function rse_state(session: any): any {
  const r = session ? session.roamer : null;
  if (r == null || typeof r !== "object") return null;
  r.history = r.history ?? seq(false, false, false);
  return r;
}

// Lua: roamer.lua:110 -- pokeemerald/src/roamer.c:216
function try_encounter_rse(session: any, cfg: any, mapId: any): RoamerEncounter | null {
  const r = session.roamer;
  if (!(truthy(r.active) && r.map === mapId)) return null;
  if ((Rng.Random() % cfg.encounterOdds) !== 0) return null;
  // pokeemerald/src/roamer.c:194
  const foe = {
    species: r.species, speciesId: r.species, level: r.level,
    ivs: r.ivs, personality: r.personality, hp: r.hp, status: r.status, roamer: true,
  };
  return { species: r.species, level: r.level, roamer: true, foe };
}

// Lua: roamer.lua:127 -- include/constants/vars.h:47
const VAR_REPEL_STEP_COUNT = 0x4020;
// const VAR_STARTER_MON = 0x4031 (declared, unused in roamer.lua)

// Lua: roamer.lua:187
function normalize_map_id(mapId: unknown): string | null {
  if (typeof mapId !== "string") return null;
  let s = tostring(mapId).toUpperCase();

  // Check MapCatalog if available
  if (MapCatalog && (MapCatalog as any).resolve) {
    const res = MapCatalog.resolve(s);
    if (truthy(res)) s = tostring(res).toUpperCase();
  }

  if (find(s, "ROUTE_?21_?NORTH") || find(s, "ROUTE_?21_?SOUTH")) {
    if (find(s, "SOUTH")) return "FR_ROUTE_21_SOUTH";
    return "FR_ROUTE_21_NORTH";
  }
  if (s === "FR_ROUTE21" || s === "ROUTE_21" || s === "FR_ROUTE_21" || s === "ROUTE21") {
    return "FR_ROUTE_21_NORTH";
  }

  const num = match(s, "ROUTE_?(%d+)");
  if (num != null) {
    const target = "FR_ROUTE_" + num;
    for (const [, loc] of ipairs<string>(Roamer.LOCATIONS)) {
      if (loc === target) return target;
    }
  }

  for (const [, loc] of ipairs<string>(Roamer.LOCATIONS)) {
    if (s === loc || s === gsub(loc, "^FR_", "")[0] || s === gsub(loc, "_", "")[0]
      || s === ("FR_" + gsub(s, "_", "")[0])) {
      return loc;
    }
  }
  return s;
}

// Lua: roamer.lua:238
function random_32bit(): number {
  const hi = Rng.Random() % 65536;
  const lo = Rng.Random() % 65536;
  return hi * 65536 + lo;
}

// Lua: roamer.lua:355
function getLeadMonLevel(session: any): number {
  const party = session ? session.party : null;
  if (party == null || typeof party !== "object") return 0;
  for (let i = 1; i <= len(party); i++) {
    const mon = party[i];
    // Eggs are ignored; fainted lead Pokemon in slot 1 IS evaluated by Repel!
    if (mon != null && typeof mon === "object" && !truthy(mon.isEgg) && !truthy(mon.egg)) {
      return tonumber(mon.level) ?? tonumber(mon.lvl) ?? 1;
    }
  }
  return 0;
}

export const Roamer = {
  // Lua: roamer.lua:15
  rseConfig: rse_cfg,

  // Lua: roamer.lua:17 (weak-keyed table)
  _locations: new WeakMap<object, LuaTable>(),

  // Lua: roamer.lua:19
  locationSets(cfg: any): LuaTable {
    const hit = Roamer._locations.get(cfg);
    if (hit) return hit;
    const src = Dataset.cache().read(cfg.locations);
    if (typeof src !== "string") throw new Error(tostring(cfg.locations) + " is missing from the cache");
    const [chunk, err] = luaLoad(src, "@" + cfg.locations);
    if (!truthy(chunk)) throw new Error(err ?? "assertion failed!");
    const data: any = chunk!();
    if (data == null || typeof data !== "object" || data.sets == null || typeof data.sets !== "object" || len(data.sets) === 0) {
      throw new Error(tostring(cfg.locations) + " has no roamer location sets");
    }
    Roamer._locations.set(cfg, data.sets);
    return data.sets;
  },

  // Lua: roamer.lua:40 -- pokeemerald/src/roamer.c:84
  initRse(session: any, createLatios?: boolean): boolean {
    const cfg = rse_cfg(session);
    if (!(session && cfg)) return false;
    const C = Constants.of(Constants.versionOf(session));
    const species = C.require("species", cfg.species[createLatios ? 1 : 0]);
    const tmp = {
      party: seq(), name: session.name, trainerId: session.trainerId, secretId: session.secretId,
      gender: session.gender,
    };
    const [, , mon] = Party.giveMon(tmp, species, cfg.level);
    session.roamer = {
      active: true,
      species,
      level: cfg.level,
      status: 0,
      ivs: mon.ivs,
      personality: mon.personality,
      hp: mon.maxHp,
      history: seq(false, false, false),
    };
    // pokeemerald/src/roamer.c:104
    const sets = Roamer.locationSets(cfg);
    session.roamer.map = sets[(Rng.Random() % len(sets)) + 1][1];
    return true;
  },

  // Lua: roamer.lua:66 -- pokeemerald/src/roamer.c:115
  updateHistory(session: any, mapId: any): void {
    const r = rse_state(session);
    if (!r) return;
    r.history[3] = r.history[2];
    r.history[2] = r.history[1];
    r.history[1] = mapId ?? false;
  },

  // Lua: roamer.lua:75 -- pokeemerald/src/roamer.c:127
  moveToOtherSet(session: any): void {
    const r = rse_state(session);
    if (!(r && truthy(r.active))) return;
    const sets = Roamer.locationSets(rse_cfg(session));
    while (true) {
      const mapId = sets[(Rng.Random() % len(sets)) + 1][1];
      if (r.map !== mapId) {
        r.map = mapId;
        return;
      }
    }
  },

  // Lua: roamer.lua:89 -- pokeemerald/src/roamer.c:149
  moveRse(session: any): void {
    const cfg = rse_cfg(session);
    if ((Rng.Random() % cfg.moveOdds) === 0) {
      return Roamer.moveToOtherSet(session);
    }
    const r = rse_state(session);
    if (!(r && truthy(r.active))) return;
    for (const [, set] of ipairs<any>(Roamer.locationSets(cfg))) {
      if (r.map === set[1]) {
        while (true) {
          const mapId = set[(Rng.Random() % (len(set) - 1)) + 2];
          if (r.history[3] !== mapId && truthy(mapId)) {
            r.map = mapId;
            return;
          }
        }
      }
    }
  },

  // Lua: roamer.lua:122
  SPECIES_RAIKOU: 243,
  SPECIES_ENTEI: 244,
  SPECIES_SUICUNE: 245,
  ROAMER_LEVEL: 50,

  // Lua: roamer.lua:132 -- pokefirered/src/roamer.c:19 sRoamerLocations (Kanto routes)
  LOCATIONS: seq(
    "FR_ROUTE_1",
    "FR_ROUTE_2",
    "FR_ROUTE_3",
    "FR_ROUTE_4",
    "FR_ROUTE_5",
    "FR_ROUTE_6",
    "FR_ROUTE_7",
    "FR_ROUTE_8",
    "FR_ROUTE_9",
    "FR_ROUTE_10",
    "FR_ROUTE_11",
    "FR_ROUTE_12",
    "FR_ROUTE_13",
    "FR_ROUTE_14",
    "FR_ROUTE_15",
    "FR_ROUTE_16",
    "FR_ROUTE_17",
    "FR_ROUTE_18",
    "FR_ROUTE_19",
    "FR_ROUTE_20",
    "FR_ROUTE_21_NORTH",
    "FR_ROUTE_21_SOUTH",
    "FR_ROUTE_24",
    "FR_ROUTE_25",
  ) as (string | null)[],

  // Lua: roamer.lua:160 -- pokefirered/src/roamer.c:30 sRoamerLocationHistory
  ADJACENCY: {
    FR_ROUTE_1: seq("FR_ROUTE_2", "FR_ROUTE_21_NORTH", "FR_ROUTE_21_SOUTH"),
    FR_ROUTE_2: seq("FR_ROUTE_1", "FR_ROUTE_3", "FR_ROUTE_22"),
    FR_ROUTE_3: seq("FR_ROUTE_2", "FR_ROUTE_4"),
    FR_ROUTE_4: seq("FR_ROUTE_3", "FR_ROUTE_9", "FR_ROUTE_24"),
    FR_ROUTE_5: seq("FR_ROUTE_6", "FR_ROUTE_7", "FR_ROUTE_8", "FR_ROUTE_24"),
    FR_ROUTE_6: seq("FR_ROUTE_5", "FR_ROUTE_7", "FR_ROUTE_8", "FR_ROUTE_11"),
    FR_ROUTE_7: seq("FR_ROUTE_5", "FR_ROUTE_6", "FR_ROUTE_8", "FR_ROUTE_16"),
    FR_ROUTE_8: seq("FR_ROUTE_5", "FR_ROUTE_6", "FR_ROUTE_7", "FR_ROUTE_10", "FR_ROUTE_12"),
    FR_ROUTE_9: seq("FR_ROUTE_4", "FR_ROUTE_10", "FR_ROUTE_24"),
    FR_ROUTE_10: seq("FR_ROUTE_8", "FR_ROUTE_9", "FR_ROUTE_12"),
    FR_ROUTE_11: seq("FR_ROUTE_6", "FR_ROUTE_12"),
    FR_ROUTE_12: seq("FR_ROUTE_8", "FR_ROUTE_10", "FR_ROUTE_11", "FR_ROUTE_13"),
    FR_ROUTE_13: seq("FR_ROUTE_12", "FR_ROUTE_14"),
    FR_ROUTE_14: seq("FR_ROUTE_13", "FR_ROUTE_15"),
    FR_ROUTE_15: seq("FR_ROUTE_14", "FR_ROUTE_18"),
    FR_ROUTE_16: seq("FR_ROUTE_7", "FR_ROUTE_17"),
    FR_ROUTE_17: seq("FR_ROUTE_16", "FR_ROUTE_18"),
    FR_ROUTE_18: seq("FR_ROUTE_15", "FR_ROUTE_17", "FR_ROUTE_19"),
    FR_ROUTE_19: seq("FR_ROUTE_18", "FR_ROUTE_20"),
    FR_ROUTE_20: seq("FR_ROUTE_19", "FR_ROUTE_21_SOUTH"),
    FR_ROUTE_21_NORTH: seq("FR_ROUTE_1", "FR_ROUTE_21_SOUTH"),
    FR_ROUTE_21_SOUTH: seq("FR_ROUTE_20", "FR_ROUTE_21_NORTH"),
    FR_ROUTE_24: seq("FR_ROUTE_4", "FR_ROUTE_5", "FR_ROUTE_9", "FR_ROUTE_25"),
    FR_ROUTE_25: seq("FR_ROUTE_24"),
  } as Record<string, (string | null)[]>,

  // Lua: roamer.lua:221
  normalizeMapId: normalize_map_id,

  // Lua: roamer.lua:227
  speciesForStarter(starterIn: unknown): number {
    const starter = tonumber(starterIn) ?? 0;
    if (starter === 1) {
      return Roamer.SPECIES_RAIKOU;
    } else if (starter === 2) {
      return Roamer.SPECIES_SUICUNE;
    } else {
      return Roamer.SPECIES_ENTEI;
    }
  },

  // Lua: roamer.lua:245
  generateMon(species: number, level?: number): any {
    level = level ?? Roamer.ROAMER_LEVEL;
    const pid = random_32bit();
    const ivs = {
      hp: Rng.Random() % 32,
      attack: Rng.Random() % 32,
      defense: Rng.Random() % 32,
      speed: Rng.Random() % 32,
      spAtk: Rng.Random() % 32,
      spDef: Rng.Random() % 32,
    };

    let moves: LuaTable = null;
    let pp: LuaTable = null;
    if (Pokemon && Pokemon.movesAtLevel) {
      [moves, pp] = Pokemon.movesAtLevel(species, level);
    }

    const hpBase = (species === Roamer.SPECIES_RAIKOU && 90)
      || (species === Roamer.SPECIES_ENTEI && 115)
      || (species === Roamer.SPECIES_SUICUNE && 100) || 100;
    const maxHp = Math.floor(((2 * hpBase + ivs.hp) * level) / 100) + level + 10;

    return {
      species,
      speciesId: species,
      level,
      hp: maxHp,
      maxHp,
      status: 0,
      statusNum: 0,
      pid,
      ivs,
      moves: moves ?? seq(),
      pp: pp ?? seq(),
    };
  },

  // Lua: roamer.lua:283
  init(session: any, starterChoice: unknown): boolean {
    if (!session) return false;
    const species = Roamer.speciesForStarter(starterChoice);
    const mon = Roamer.generateMon(species, Roamer.ROAMER_LEVEL);

    // Initial location: pick random Kanto route
    const locIndex = (Rng.Random() % len(Roamer.LOCATIONS)) + 1;
    const initialMap = Roamer.LOCATIONS[locIndex];

    session.roamer = {
      active: true,
      species,
      level: Roamer.ROAMER_LEVEL,
      hp: mon.hp ?? mon.maxHp,
      maxHp: mon.maxHp ?? mon.hp,
      status: mon.status ?? 0,
      statusNum: mon.statusNum ?? 0,
      pid: mon.pid,
      ivs: mon.ivs,
      moves: mon.moves,
      pp: mon.pp,
      map: initialMap,
    };

    return true;
  },

  // Lua: roamer.lua:311
  jump(session: any): void {
    if (!(session && session.roamer && truthy(session.roamer.active))) return;
    const cur = session.roamer.map;
    const locs = Roamer.LOCATIONS;
    let pick: string | null | undefined;
    for (let n = 1; n <= 10; n++) {
      pick = locs[(Rng.Random() % len(locs)) + 1];
      if (pick !== cur) break;
    }
    session.roamer.map = pick ?? locs[1];
  },

  // Lua: roamer.lua:324
  move(session: any, reason?: string, mapId?: any): void {
    if (rse_cfg(session)) {
      // pokeemerald/src/overworld.c:816
      Roamer.updateHistory(session, mapId);
      if (reason === "map_transition" || reason === "connection") return Roamer.moveRse(session);
      // pokeemerald/src/overworld.c:861
      return Roamer.moveToOtherSet(session);
    }
    if (!(session && session.roamer && truthy(session.roamer.active))) return;
    if (reason === "warp_random") {
      Roamer.jump(session);
      return;
    }

    const cur = session.roamer.map;
    const adj = Roamer.ADJACENCY[cur];
    if (!adj || len(adj) === 0) {
      Roamer.jump(session);
      return;
    }

    // ~16/256 chance to stay on same route, otherwise pick adjacent route
    if ((Rng.Random() % 16) === 0) {
      return;
    }

    const pick = adj[(Rng.Random() % len(adj)) + 1];
    session.roamer.map = pick ?? cur;
  },

  // Lua: roamer.lua:369
  tryEncounter(session: any, mapId: any, terrain?: string): RoamerEncounter | null {
    if (!(session && session.roamer && truthy(session.roamer.active))) return null;
    const cfg = rse_cfg(session);
    if (cfg) return try_encounter_rse(session, cfg, mapId);
    const roamer = session.roamer;
    if (roamer.hp <= 0) return null;

    const normMap = normalize_map_id(mapId);
    const roamerMap = normalize_map_id(roamer.map);
    if (normMap !== roamerMap) return null;

    // Only wild land/grass or surf water triggers
    if (terrain !== "land" && terrain !== "grass" && terrain !== "water") {
      return null;
    }

    // Repel check (respects fainted slot-1 Pokemon level)
    const store = (Space && Space.store) || session.store || session;
    const repelSteps = tonumber(Flags.getVar(store, null, VAR_REPEL_STEP_COUNT)) ?? 0;
    if (repelSteps > 0) {
      const leadLv = getLeadMonLevel(session);
      if (leadLv > roamer.level) {
        return null;
      }
    }

    // Construct wild foe encounter descriptor
    const foe = {
      species: roamer.species,
      speciesId: roamer.species,
      level: roamer.level,
      hp: roamer.hp,
      maxHp: roamer.maxHp,
      status: roamer.status,
      statusNum: roamer.statusNum,
      pid: roamer.pid,
      ivs: roamer.ivs,
      moves: roamer.moves,
      pp: roamer.pp,
      roamer: true,
    };

    return {
      species: roamer.species,
      level: roamer.level,
      roamer: true,
      foe,
    };
  },

  // Lua: roamer.lua:422
  onBattleEnd(session: any, foeState: any, battleResult: any, _endReason?: any): void {
    if (!(session && session.roamer && truthy(session.roamer.active))) return;
    const roamer = session.roamer;
    if (rse_cfg(session)) {
      // pokeemerald/src/battle_main.c:5234
      if (foeState) {
        roamer.hp = Math.max(0, tonumber(foeState.hp) ?? roamer.hp);
        roamer.status = foeState.status ?? 0;
      }
      Roamer.moveToOtherSet(session);
      // pokeemerald/src/battle_main.c:5239
      const code = (Natives as any).outcome_to_code(battleResult);
      if (code % 2 === 1) roamer.active = false;
      return;
    }

    if (foeState) {
      roamer.hp = Math.max(0, tonumber(foeState.hp) ?? roamer.hp);
      roamer.status = foeState.status ?? roamer.status;
      roamer.statusNum = foeState.statusNum ?? roamer.statusNum;
    }

    // Caught or defeated -> permanently deactivate
    if (battleResult === "caught" || (foeState && truthy(foeState.hp) && foeState.hp <= 0)) {
      roamer.active = false;
      return;
    }

    // If battle ended by fleeing, player running, or Roar/Whirlwind:
    // Prevent Gen 3 Roar despawn bug: keep roamer alive and migrate to new location
    Roamer.jump(session);
  },
};

export default Roamer;
