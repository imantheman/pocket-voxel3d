// Gen 2 wild encounters (engine/overworld/wildmons.asm): a port of gen1recomp
// src/battle/gen2/Encounter.lua (bdfac727, MIT).
//
// The Gen 2 mechanic Gen 1 does not have: a grass table holds three separate
// seven-slot lists, one per time of day, plus a per-time encounter *rate*.  So
// the same patch of grass on Route 29 gives Pidgey in the morning and Hoothoot
// at night, and the clock that decides which is the same one that decides the
// palette -- see world/Palettes.ts.
//
// Slot probabilities are Gen 2's ProbabilityTable (data/wild/probabilities.asm):
// 30, 30, 20, 10, 5, 4, 1 percent across the seven slots, cumulative.
//
// `encounters` is the importer's encounters.json (voxelmon/import/gen2); its
// slot lists are 0-based arrays, so the Lua's `slots[index]` reads
// `slots[index - 1]`. The `slot` a result reports stays the Lua's 1-based index.

import { mod, truthy } from "../platform/lua.ts";
import { random as luaRandom } from "../platform/rng.ts";

/** `random(n)` returning 0..n-1, the way the cart compares a Random byte. */
export type ZeroRandom = (n: number) => number;

export interface WildPick {
  species: any;
  level: number;
  /** the 1-based slot (grass/water only) */
  slot?: number;
}

// Lua: Encounter.lua:19
function roll(random: ZeroRandom | undefined | null, n: number): number {
  if (truthy(random)) return random!(n);
  return luaRandom(n) - 1;
}

// Lua: Encounter.lua:28 -- which slot (1-based) a 0..99 roll lands in.
function slotFor(chances: number[], value: number): number {
  for (let i = 0; i < chances.length; i++) {
    if (value < chances[i]!) return i + 1;
  }
  return chances.length;
}

// ../pokegold/engine/events/treemons.asm:94 GetTreeMons
const GS_DEAD_SETS: Record<string, boolean> = {
  TREEMON_SET_NONE: true,
  TREEMON_SET_UNUSED: true,
  TREEMON_SET_CITY: true,
};

const ASLEEP_DAY: Record<string, boolean> = {
  VENONAT: true,
  HOOTHOOT: true,
  NOCTOWL: true,
  SPINARAK: true,
  HERACROSS: true,
};
const ASLEEP_NITE: Record<string, boolean> = {
  CATERPIE: true,
  METAPOD: true,
  BUTTERFREE: true,
  WEEDLE: true,
  KAKUNA: true,
  BEEDRILL: true,
  SPEAROW: true,
  EKANS: true,
  EXEGGCUTE: true,
  LEDYBA: true,
  AIPOM: true,
};

export const Encounter = {
  // data/wild/probabilities.asm, cumulative out of 100.
  GRASS_SLOT_CHANCES: [30, 60, 80, 90, 95, 99, 100],
  // Water has three slots: 60, 30, 10.
  WATER_SLOT_CHANCES: [60, 90, 100],

  // GetFishGroupIndex (engine/events/fish.asm), the fishing half of a swarm.
  // `fishSwarm` is the FISHSWARM_* byte (constants/script_constants.asm), which
  // the port keeps in save.dailyFlags.fishingSwarm and reads back through
  // Roamers.Swarm.fishing.
  FISHSWARM_NONE: 0,
  FISHSWARM_QWILFISH: 1,
  FISHSWARM_REMORAID: 2,

  // ../pokecrystal/engine/events/treemons.asm:199 GetTreeScore
  TREEMON_SCORE_BAD: 0,
  TREEMON_SCORE_GOOD: 1,
  TREEMON_SCORE_RARE: 2,

  // Lua: Encounter.lua:229 -- ../pokecrystal/data/wild/treemons_asleep.asm:3
  // AsleepTreeMonsNite / Day / Morn (MORN shares DAY's table, DARK NITE's).
  ASLEEP_TREEMONS: {
    NITE: ASLEEP_NITE,
    DAY: ASLEEP_DAY,
    MORN: ASLEEP_DAY,
    DARK: ASLEEP_NITE,
  } as Record<string, Record<string, boolean>>,

  // ../pokecrystal/constants/battle_constants.asm:15 TREEMON_SLEEP_TURNS
  TREEMON_SLEEP_TURNS: 7,

  // Lua: Encounter.lua:37 -- does a step in grass start a battle?  The map's
  // rate is out of 256 (`db 2 percent`), and the cart compares one random byte
  // against it.
  triggers(rate: number | undefined | null, random?: ZeroRandom): boolean {
    if (!truthy(rate) || rate! <= 0) return false;
    return roll(random, 256) < rate!;
  },

  // Lua: Encounter.lua:46 -- the grass encounter for a map at a time of day, or
  // nil when that map has none.  `daytime` is "MORN"/"DAY"/"NITE"/"DARK"; DARK
  // reuses the night list, since the cart only stores three (wildmons.asm
  // masks the palette daytime down to three when indexing).
  grassSlot(encounters: any, mapId: string, daytime?: string, random?: ZeroRandom | null): WildPick | undefined {
    const entry = truthy(encounters) && truthy(encounters.grass) ? encounters.grass[mapId] : undefined;
    if (!truthy(entry)) return undefined;
    const key = daytime === "DARK" ? "NITE" : (daytime ?? "DAY");
    const slots = truthy(entry.slots) ? (entry.slots[key] ?? entry.slots.DAY) : undefined;
    if (!truthy(slots)) return undefined;
    const index = slotFor(Encounter.GRASS_SLOT_CHANCES, roll(random, 100));
    const slot = slots[index - 1];
    if (!truthy(slot) || !truthy(slot.species)) return undefined;
    return { species: slot.species, level: slot.level, slot: index };
  },

  // Lua: Encounter.lua:58
  grassRate(encounters: any, mapId: string, daytime?: string): number {
    const entry = truthy(encounters) && truthy(encounters.grass) ? encounters.grass[mapId] : undefined;
    if (!truthy(entry)) return 0;
    const key = daytime === "DARK" ? "NITE" : (daytime ?? "DAY");
    return (truthy(entry.rates) ? (entry.rates[key] ?? entry.rates.DAY) : undefined) ?? 0;
  },

  // Lua: Encounter.lua:65
  waterSlot(encounters: any, mapId: string, random?: ZeroRandom | null): WildPick | undefined {
    const entry = truthy(encounters) && truthy(encounters.water) ? encounters.water[mapId] : undefined;
    if (!truthy(entry) || !truthy(entry.slots)) return undefined;
    const index = slotFor(Encounter.WATER_SLOT_CHANCES, roll(random, 100));
    const slot = entry.slots[index - 1];
    if (!truthy(slot) || !truthy(slot.species)) return undefined;
    return { species: slot.species, level: slot.level, slot: index };
  },

  // Lua: Encounter.lua:74
  waterRate(encounters: any, mapId: string): number {
    const entry = truthy(encounters) && truthy(encounters.water) ? encounters.water[mapId] : undefined;
    return (truthy(entry) ? entry.rate : undefined) ?? 0;
  },

  // Lua: Encounter.lua:83 -- fishing: a rod's list is (cumulative chance,
  // species, level) rows out of 256, ending at 100%.  Rows with `day` and
  // `nite` sub-slots (from TimeFishGroups) resolve based on `daytime`
  // ("MORN"/"DAY" vs "NITE"/"DARK").  `daytime` may be omitted with the
  // random function in its place, as in the Lua.
  fish(
    encounters: any,
    fishGroup: string,
    rod?: string,
    daytime?: string | ZeroRandom | null,
    random?: ZeroRandom | null,
  ): WildPick | undefined {
    if (typeof daytime === "function" && random == null) {
      random = daytime;
      daytime = undefined;
    }
    const group = truthy(encounters) && truthy(encounters.fishGroups) ? encounters.fishGroups[fishGroup] : undefined;
    if (!truthy(group)) return undefined;
    const list = group[rod ?? "old"];
    if (!truthy(list) || list.length === 0) return undefined;
    const value = roll(random, 256);
    const isNight = daytime === "DARK" || daytime === "NITE";
    const todKey = isNight ? "nite" : "day";
    for (const row of list) {
      if (row == null) break;
      if (value < (row.chance ?? 0)) {
        let slot = row[todKey];
        if (!truthy(slot) && truthy(row.timeGroup) && truthy(encounters) && truthy(encounters.timeFishGroups)) {
          const tg = encounters.timeFishGroups[row.timeGroup];
          slot = truthy(tg) ? tg[todKey] : undefined;
        }
        slot = truthy(slot) ? slot : row;
        if (!truthy(slot.species) || slot.species === 0 || slot.species === "NO_ITEM") return undefined;
        return { species: slot.species, level: slot.level };
      }
    }
    return undefined;
  },

  // Lua: Encounter.lua:135 -- a cache built before the extractor carried the
  // two swarm rows has no such group at all, and Fish on a missing group is a
  // bite of nothing; falling back to the map's own group keeps those rods
  // rolling their ordinary list.
  fishGroupFor(encounters: any, group: string, fishSwarm?: number): string {
    const swap = FISH_SWARM_GROUPS[fishSwarm ?? Encounter.FISHSWARM_NONE];
    const swarmed = truthy(swap) ? swap![group] : undefined;
    if (!truthy(swarmed)) return group;
    const groups = truthy(encounters) ? encounters.fishGroups : undefined;
    if (!(truthy(groups) && truthy(groups[swarmed!]))) return group;
    return swarmed!;
  },

  // Lua: Encounter.lua:146 -- which fish group a MAP belongs to lives on the
  // map record, so a caller with a map id and a rod does not have to know
  // about groups at all.
  fishSlot(
    encounters: any,
    mapId: string,
    rod?: string,
    random?: ZeroRandom | null,
    maps?: any,
    fishSwarm?: number,
    daytime?: string,
  ): WildPick | undefined {
    const map = truthy(maps) ? maps[mapId] : undefined;
    let group = truthy(map) ? map.fishGroup : undefined;
    if (!truthy(group)) {
      // Callers that already hold the map (the World does) pass it in; without
      // it, fall back to the pond, which is what an unlisted map fishes.
      group = "FISHGROUP_POND";
    }
    group = Encounter.fishGroupFor(encounters, group, fishSwarm);
    let key = rod;
    if (rod === "OLD_ROD") key = "old";
    else if (rod === "GOOD_ROD") key = "good";
    else if (rod === "SUPER_ROD") key = "super";
    return Encounter.fish(encounters, group, key ?? "old", daytime, random);
  },

  // Lua: Encounter.lua:165 -- headbutt trees: TreeMonMaps says which set a map
  // uses and TreeMons holds that set's two lists.
  treeSet(encounters: any, mapId: string): string | undefined {
    const set = truthy(encounters) && truthy(encounters.trees) ? encounters.trees[mapId] : undefined;
    return truthy(set) ? set : undefined;
  },

  // Lua: Encounter.lua:175 -- ../pokecrystal/engine/overworld/player_object.asm:102
  // RefreshPlayerCoords
  treeScore(cx?: number, cy?: number, otId?: number): number {
    const d = mod((cx ?? 0) + 4, 256);
    const e = mod((cy ?? 0) + 4, 256);
    const coord = mod(Math.floor(mod(e * (d + 1) + d, 65536) / 5), 10);
    const ot = mod(Math.floor(otId ?? 0), 10);
    const diff = mod(coord - ot, 10);
    if (diff === 0) return Encounter.TREEMON_SCORE_RARE;
    if (diff < 5) return Encounter.TREEMON_SCORE_GOOD;
    return Encounter.TREEMON_SCORE_BAD;
  },

  // Lua: Encounter.lua:194 -- ../pokecrystal/engine/events/treemons.asm:96 GetTreeMons
  treeSetUsable(setName: string | undefined | null, engine?: string): boolean {
    if (!truthy(setName) || setName === "TREEMON_SET_NONE") return false;
    if (engine === "gs" && GS_DEAD_SETS[setName!]) return false;
    return true;
  },

  // Lua: Encounter.lua:201 -- ../pokecrystal/engine/events/treemons.asm:126 GetTreeMon
  treeSlot(
    encounters: any,
    mapId: string,
    cx: number | undefined,
    cy: number | undefined,
    random?: ZeroRandom | null,
    opts?: { engine?: string; otId?: number; [k: string]: any },
  ): WildPick | undefined {
    const o = opts ?? {};
    const setName = Encounter.treeSet(encounters, mapId);
    if (!Encounter.treeSetUsable(setName, o.engine)) return undefined;
    const set = truthy(encounters) && truthy(encounters.treeSets) ? encounters.treeSets[setName!] : undefined;
    if (!truthy(set)) return undefined;
    const score = Encounter.treeScore(cx, cy, o.otId);
    let list = set.common;
    let gate = 1;
    if (score === Encounter.TREEMON_SCORE_GOOD) {
      gate = 5;
    } else if (score === Encounter.TREEMON_SCORE_RARE) {
      list = set.rare;
      gate = 8;
    }
    if (roll(random, 10) >= gate) return undefined;
    if (!truthy(list) || list.length === 0) return undefined;
    const value = roll(random, 100);
    let total = 0;
    for (const row of list) {
      if (row == null) break;
      total = total + (row.chance ?? 0);
      if (value < total) {
        if (!truthy(row.species)) return undefined;
        return { species: row.species, level: row.level };
      }
    }
    return undefined;
  },

  // Lua: Encounter.lua:243 -- ../pokecrystal/engine/battle/core.asm:6422 CheckSleepingTreeMon
  treeMonAsleep(species: string, daytime?: string, engine?: string, encounters?: any): boolean {
    if (engine !== "crystal") return false;
    const dt = daytime ?? "DAY";
    const extracted = truthy(encounters) ? encounters.treeMonsAsleep : undefined;
    if (typeof extracted === "object" && extracted !== null) {
      const key = dt === "MORN" ? "MORN" : dt === "DAY" ? "DAY" : "NITE";
      for (const name of extracted[key] ?? []) {
        if (name == null) break;
        if (name === species) return true;
      }
      return false;
    }
    const list = Encounter.ASLEEP_TREEMONS[dt];
    return (truthy(list) ? list![species] : undefined) === true;
  },
};

// Lua: Encounter.lua:123
const FISH_SWARM_GROUPS: Record<number, Record<string, string>> = {
  [Encounter.FISHSWARM_QWILFISH]: {
    FISHGROUP_QWILFISH: "FISHGROUP_QWILFISH_SWARM",
  },
  [Encounter.FISHSWARM_REMORAID]: {
    FISHGROUP_REMORAID: "FISHGROUP_REMORAID_SWARM",
  },
};

export default Encounter;
