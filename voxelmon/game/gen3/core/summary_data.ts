// Port of gen1recomp src/core/game3/summary_data.lua (GPLv3 + additional terms; see LICENSE.md).
// Pokémon Summary Screen Data & Mechanics.
// Faithful replication of FRLG experience tables, natures, trainer memo logic, and move/ability descriptions.
//
// Load order: the Lua builds NATURE_KEYS and SummaryData.NATURES (RomText.key /
// RomText.lazy) when the module loads. Here NATURES is a getter that builds
// them on first read, so importing this module does not reach rom_text; the
// value is the same.
// NOT FAITHFUL (scope): package.loaded["src.core.game3.pokemon"] is always
// loaded here (rom_name reads Pokemon, which is imported).

import { tonumber, tostring, truthy, mod } from "../../../import/gen3/lua.ts";
import { MapSectionsExtract } from "../../../import/gen3/map_sections_extract.ts";
import { seq, len, type LuaTable } from "../platform/lt.ts";
import { find, gmatch, gsub } from "../platform/lpattern.ts";
import { luaLoad } from "../platform/luadata.ts";
import { Strings } from "../shared/core/Strings.ts";
import { RomText } from "./rom_text.ts";
import { Dataset } from "./dataset.ts";
import { Pokemon } from "./pokemon.ts";

const isTable = (v: unknown): v is LuaTable => v !== null && typeof v === "object";

// Lua: summary_data.lua:8 -- built on first use (see the header note)
let NATURE_KEYS: Record<number, string> | undefined;
let NATURES_LAZY: any;
function natures(): any {
  if (NATURES_LAZY === undefined) {
    NATURE_KEYS = {};
    for (let i = 0; i <= 24; i++) NATURE_KEYS[i] = RomText.key("gNatureNamePointers", i);
    // src/data/text/nature_names.h:27
    NATURES_LAZY = RomText.lazy(NATURE_KEYS);
  }
  return NATURES_LAZY;
}

// Stat multipliers per nature [natureId] = { stat = 1.1 / 0.9 / 1.0 }
// Stats: atk, def, spAtk, spDef, spd
// Lua: summary_data.lua:15
const STAT_UP: Record<number, string> = {
  1: "atk", 2: "atk", 3: "atk", 4: "atk",
  5: "def", 7: "def", 8: "def", 9: "def",
  10: "spd", 11: "spd", 13: "spd", 14: "spd",
  15: "spAtk", 16: "spAtk", 17: "spAtk", 19: "spAtk",
  20: "spDef", 21: "spDef", 22: "spDef", 23: "spDef",
};

// Lua: summary_data.lua:23
const STAT_DOWN: Record<number, string> = {
  1: "def", 2: "spd", 3: "spAtk", 4: "spDef",
  5: "atk", 7: "spd", 8: "spAtk", 9: "spDef",
  10: "atk", 11: "def", 13: "spAtk", 14: "spDef",
  15: "atk", 16: "def", 17: "spd", 19: "spDef",
  20: "atk", 21: "def", 22: "spd", 23: "spAtk",
};

/**
 * Growth Rates matching pokefirered/src/data/pokemon/experience_tables.h
 * Enum order = pret GROWTH_MEDIUM_FAST..GROWTH_SLOW (species meta.growthRate from ROM).
 * Tables hardcode [0]=0, [1]=1 for every rate; formulas apply from level 2 up
 * (Medium Slow at n=1 is negative — pret stores 1).
 */
// Lua: summary_data.lua:45
function calc_exp(growthRate: number, nIn: unknown): number {
  let n = tonumber(nIn) ?? 0;
  if (n <= 0) return 0;
  if (n === 1) return 1;
  if (n > 100) n = 100;
  const n3 = n * n * n;
  const n2 = n * n;

  if (growthRate === 0) {
    // Medium Fast (CUBE(n))
    return n3;
  } else if (growthRate === 1) {
    // Erratic
    if (n <= 50) {
      return Math.floor((100 - n) * n3 / 50);
    } else if (n <= 68) {
      return Math.floor((150 - n) * n3 / 100);
    } else if (n <= 98) {
      return Math.floor(Math.floor((1911 - 10 * n) / 3) * n3 / 500);
    } else {
      return Math.floor((160 - n) * n3 / 100);
    }
  } else if (growthRate === 2) {
    // Fluctuating
    if (n <= 15) {
      return Math.floor((Math.floor((n + 1) / 3) + 24) * n3 / 50);
    } else if (n <= 36) {
      return Math.floor((n + 14) * n3 / 50);
    } else {
      return Math.floor((Math.floor(n / 2) + 32) * n3 / 50);
    }
  } else if (growthRate === 3) {
    // Medium Slow: (6 * CUBE(n)) / 5 - 15 * SQUARE(n) + 100 * n - 140
    const val = Math.floor((6 * n3) / 5) - (15 * n2) + (100 * n) - 140;
    return Math.max(0, val);
  } else if (growthRate === 4) {
    // Fast: (4 * CUBE(n)) / 5
    return Math.floor((4 * n3) / 5);
  } else if (growthRate === 5) {
    // Slow: (5 * CUBE(n)) / 4
    return Math.floor((5 * n3) / 4);
  }
  return n3;
}

// Precompute tables 0..5, levels 0..100
// Lua: summary_data.lua:91
const EXP_TABLES: Record<number, Record<number, number>> = {};
for (let g = 0; g <= 5; g++) {
  EXP_TABLES[g] = {};
  for (let lv = 0; lv <= 100; lv++) {
    EXP_TABLES[g]![lv] = calc_exp(g, lv);
  }
}

// Lua: summary_data.lua:203
function map_sections(): typeof MapSectionsExtract {
  return MapSectionsExtract;
}

const _sec_cache: Record<number, { id: string; name: string } | false> = {};
const _celadon_by_map: Record<string, string | false> = {};

// Lua: summary_data.lua:211 -- pokefirered/src/region_map.c:3801 GetMapName
function section_of(sec: number): { id: string; name: string } | undefined {
  const cached = _sec_cache[sec];
  if (cached !== undefined) return cached || undefined;
  let entry: { id: string; name: string } | false = false;
  const info = map_sections().getInfo(sec, undefined, 0);
  if (isTable(info) && info.resolved) {
    const name = info.rawName ?? info.name;
    if (typeof name === "string" && name !== "") entry = { id: info.id, name };
  }
  _sec_cache[sec] = entry;
  return entry || undefined;
}

// Lua: summary_data.lua:225 -- pokefirered/src/region_map.c:3782 IsCeladonDeptStoreMapsec
function celadon_name(sec: number, here: string): string | undefined {
  let cached = _celadon_by_map[here];
  if (cached === undefined) {
    cached = false;
    const info = map_sections().getInfo(sec, here, 0);
    if (isTable(info) && info.resolved) {
      const name = info.rawName ?? info.name;
      if (typeof name === "string" && name !== "") cached = name;
    }
    _celadon_by_map[here] = cached;
  }
  return cached || undefined;
}

// Lua: summary_data.lua:240 -- pokefirered/src/pokemon_summary_screen.c:2632 MapSecIsInKantoOrSevii / GetMapNameGeneric_
function met_location_name(mon: any, playerState: any): string | undefined {
  const stamped = mon.metLocationName;
  if (typeof stamped === "string" && stamped !== "") return stamped;
  const sec = tonumber(mon.metLocation);
  if (sec === undefined) return undefined;
  const entry = section_of(sec);
  if (!entry) return undefined;
  const here = truthy(playerState) ? playerState.map : undefined;
  if (entry.id === "MAPSEC_CELADON_CITY" && typeof here === "string") {
    return celadon_name(sec, here) ?? entry.name;
  }
  return entry.name;
}

const METLOC_SPECIAL_EGG = 0xFD;
const METLOC_FATEFUL_ENCOUNTER = 0xFF;

// Lua: summary_data.lua:257
function split_lines(text: string): LuaTable {
  const lines: LuaTable = seq();
  for (const caps of gmatch(text + "\n", "(.-)\n")) lines[len(lines) + 1] = caps[0];
  return lines;
}

// Lua: summary_data.lua:264 -- src/pokemon_summary_screen.c:3243
function held_by_ot(mon: any, playerState: any): boolean {
  if (!truthy(playerState)) return true;
  const pName = playerState.playerName ?? playerState.name;
  const pId = playerState.trainerId ?? playerState.otId ?? playerState.id;
  const pSecret = playerState.secretId ?? playerState.otSecretId;
  const monOtName = mon.otName ?? mon.originalTrainer;
  const monOtId = tonumber(mon.otId);
  const monSecret = tonumber(mon.otSecretId);
  if (truthy(pName) && truthy(monOtName) && pName !== monOtName) return false;
  if (truthy(pId) && monOtId !== undefined && ((pId & 0xFFFF) !== (monOtId & 0xFFFF))) return false;
  if (truthy(pSecret) && monSecret !== undefined && ((pSecret & 0xFFFF) !== (monSecret & 0xFFFF))) return false;
  return true;
}

// Lua: summary_data.lua:279 -- src/pokemon_summary_screen.c:5213
function in_kanto_or_sevii(sec: number): boolean {
  return sec >= 88 && sec < 197;
}

// Lua: summary_data.lua:284 -- src/pokemon_summary_screen.c:5199
function from_gba(mon: any): boolean {
  const game = tonumber(mon.metGame);
  return game === undefined || (game >= 1 && game <= 5);
}

// Lua: summary_data.lua:290 -- src/pokemon_summary_screen.c:2789
function egg_origin_index(mon: any, heldByOt: boolean): number {
  if (truthy(mon.isBadEgg)) return 0;
  const metLocation = tonumber(mon.metLocation) ?? 0;
  if (metLocation === METLOC_FATEFUL_ENCOUNTER || mon.fatefulEncounter === true) return 4;
  let idx = 0;
  const game = tonumber(mon.metGame);
  if (game !== undefined && game !== 4 && game !== 5) {
    idx = 1;
  } else if (metLocation === METLOC_SPECIAL_EGG) {
    idx = 2;
  }
  if ((idx === 0 || idx === 2) && !heldByOt) idx = idx + 1;
  return idx;
}

// Lua: summary_data.lua:310 -- src/pokemon_summary_screen.c:2483
function egg_hatch_index(mon: any): number {
  if (truthy(mon.isBadEgg)) return 0;
  const cycles = SummaryData.eggCycles(mon);
  if (cycles <= 5) return 3;
  if (cycles <= 10) return 2;
  if (cycles <= 40) return 1;
  return 0;
}

// Lua: summary_data.lua:382
function load_descriptions(): any {
  const rel = "data/generated/gba/pokemon/descriptions.lua";
  const src = Dataset.cache().read(rel);
  if (!truthy(src)) throw new Error(rel + " is not in the cache");
  const [chunk, err] = luaLoad(src, "@" + rel);
  if (!chunk) throw new Error(err);
  return chunk();
}

let _descs: any;
// Lua: summary_data.lua:389
function get_descriptions(): any {
  if (!truthy(_descs)) {
    _descs = load_descriptions();
  }
  return _descs;
}

// Descriptions are keyed by the English name.  A translation mod renames
// moves and abilities, so the name the caller shows is looked past: the ROM's
// own name for that number is what the key was built from.
// Lua: summary_data.lua:399
function rom_name(field: string, id: unknown, shown: unknown): any {
  const P: any = Pokemon;
  const english = isTable(P) && truthy(P._cache) && truthy(P[field]) ? P[field](id) : undefined;
  return truthy(english) ? english : shown;
}

/** The Lua's `name:upper():gsub("%s+", "_"):gsub("[^%w_]", "")`. */
function const_part(name: string): string {
  return gsub(gsub(name.toUpperCase(), "%s+", "_")[0], "[^%w_]", "")[0];
}

export const SummaryData = {
  // src/data/text/nature_names.h:27 (built on first read; see the header note)
  get NATURES(): any {
    return natures();
  },

  // Lua: summary_data.lua:31
  natureStatModifier(natureIdIn: unknown, statKey: string): number {
    const natureId = tonumber(natureIdIn) ?? 0;
    if (STAT_UP[natureId] === statKey) {
      return 1.1;
    } else if (STAT_DOWN[natureId] === statKey) {
      return 0.9;
    }
    return 1.0;
  },

  // Lua: summary_data.lua:99
  expForLevel(growthRateIn: unknown, levelIn: unknown): number {
    const growthRate = mod(tonumber(growthRateIn) ?? 0, 6);
    const level = Math.max(1, Math.min(100, tonumber(levelIn) ?? 1));
    const tbl = EXP_TABLES[growthRate];
    return tbl && tbl[level] != null ? tbl[level]! : 0;
  },

  /** Return experience progress struct for a Pokémon */
  // Lua: summary_data.lua:107
  expProgress(mon: any, growthRateIn?: unknown): {
    totalExp: number; level: number; curLevelExp: number; nextLevelExp: number;
    expNeeded: number; expProgress: number; levelTotalExp: number; progressPercent: number;
  } {
    const growthRate = mod(tonumber(growthRateIn) ?? tonumber(truthy(mon) ? mon.growthRate : mon) ?? 0, 6);
    const level = Math.max(1, Math.min(100, tonumber(truthy(mon) ? mon.level : mon) ?? 1));
    const totalExp = tonumber(truthy(mon) ? mon.exp : mon) ?? SummaryData.expForLevel(growthRate, level);

    const curLevelExp = SummaryData.expForLevel(growthRate, level);
    const nextLevelExp = (level >= 100) ? curLevelExp : SummaryData.expForLevel(growthRate, level + 1);
    const expNeeded = (level >= 100) ? 0 : Math.max(0, nextLevelExp - totalExp);

    const barTotal = Math.max(1, nextLevelExp - curLevelExp);
    const barProgress = Math.max(0, Math.min(barTotal, totalExp - curLevelExp));
    const pct = (level >= 100) ? 1.0 : (barProgress / barTotal);

    return {
      totalExp,
      level,
      curLevelExp,
      nextLevelExp,
      expNeeded,
      expProgress: barProgress,
      levelTotalExp: barTotal,
      progressPercent: pct,
    };
  },

  /** Get nature ID and name from personality */
  // Lua: summary_data.lua:133 -- returns natureId, name
  nature(mon: any): [number, string | undefined] {
    const p = tonumber(truthy(mon) ? mon.personality : mon) ?? 0;
    const natureId = mod(p, 25);
    return [natureId, SummaryData.NATURES[natureId]];
  },

  /** Check if shiny: ((otId ~ otSecretId) ~ (pHigh ~ pLow)) < 8 */
  // Lua: summary_data.lua:140
  isShiny(mon: any): boolean {
    if (!truthy(mon)) return false;
    if (mon.isShiny != null) return truthy(mon.isShiny);
    const p = tonumber(mon.personality) ?? 0;
    const otId = tonumber(mon.otId) ?? 0;
    const secretId = tonumber(mon.otSecretId) ?? 0;

    const pHigh = p >>> 16;
    const pLow = p & 0xFFFF;
    const trainerXor = otId ^ secretId;
    const pidXor = pHigh ^ pLow;
    return (trainerXor ^ pidXor) < 8;
  },

  /** Check gender: "M", "F", or "" */
  // Lua: summary_data.lua:155
  gender(mon: any): string {
    if (!truthy(mon)) return "";
    if (truthy(mon.gender)) return mon.gender;
    if (truthy(mon.isEgg)) return "";
    const ratio = tonumber(mon.genderRatio);
    if (ratio === undefined) {
      // src/pokemon_summary_screen.c:2114
      const g = Pokemon.gender(Pokemon.speciesOf(mon), mon.personality);
      return (g === "M" || g === "F") ? g : "";
    }
    if (ratio === 255) return "";
    if (ratio === 254) return "F";             // 100% female
    if (ratio === 0) return "M";               // 100% male
    const p = tonumber(mon.personality) ?? 0;
    const byte = p & 0xFF;
    return (byte >= ratio) ? "M" : "F";
  },

  /**
   * Status ailment code:
   * 0: None, 1: PSN, 2: PRZ, 3: SLP, 4: FRZ, 5: BRN, 6: PKRS, 7: FNT
   */
  // Lua: summary_data.lua:176
  statusAilment(mon: any): number {
    if (!truthy(mon)) return 0;
    const curHp = tonumber(truthy(mon.hp) ? mon.hp : mon.currentHp);
    if (curHp !== undefined && curHp <= 0) return 7; // FNT

    const st = truthy(mon.status) ? mon.status : mon.status1;
    if (typeof st === "string") {
      const s = st.toUpperCase();
      const has = (pat: string): boolean => find(s, pat) !== undefined;
      if (has("PSN") || has("POISON") || has("TOX")) return 1;
      if (has("PRZ") || has("PAR")) return 2;
      if (has("SLP") || has("SLEEP")) return 3;
      if (has("FRZ") || has("FREEZE") || has("FROZEN")) return 4;
      if (has("BRN") || has("BURN")) return 5;
      if (has("PKRS") || has("POKERUS")) return 6;
      if (has("FNT") || has("FAINT")) return 7;
    } else if (typeof st === "number") {
      if ((st & 0x08) !== 0 || (st & 0x80) !== 0) return 1; // PSN / TOXIC
      if ((st & 0x40) !== 0) return 2; // PRZ
      if ((st & 0x07) !== 0) return 3; // SLP
      if ((st & 0x20) !== 0) return 4; // FRZ
      if ((st & 0x10) !== 0) return 5; // BRN
    }
    // pokefirered/src/pokemon.c:5618 CheckPartyPokerus
    if (mod(tonumber(mon.pokerus) ?? 0, 16) !== 0) return 6;
    return 0;
  },

  // Lua: summary_data.lua:305
  eggCycles(mon: any): number {
    return tonumber(truthy(mon) ? (truthy(mon.eggCycles) ? mon.eggCycles : mon.friendship) : mon) ?? 40;
  },

  // Lua: summary_data.lua:320 -- src/pokemon_summary_screen.c:2495
  eggHatchText(mon: any): string {
    if (!truthy(mon)) return "";
    return RomText.at("sEggHatchTimeTexts", egg_hatch_index(mon));
  },

  /** Trainer Memo formatting (pokefirered/src/pokemon_summary_screen.c PokeSum_PrintTrainerMemo) */
  // Lua: summary_data.lua:326
  formatTrainerMemo(mon: any, playerState?: any, opts?: any): LuaTable {
    if (!truthy(mon)) return seq(RomText.plain("gText_PokeSum_NoData"));

    // src/pokemon_summary_screen.c:3243
    const owner = truthy(opts) && truthy(opts.owner) ? opts.owner : playerState;
    const heldByOt = held_by_ot(mon, owner);

    if (truthy(mon.isEgg)) {
      // src/pokemon_summary_screen.c:2839
      return seq(RomText.at("sEggOriginTexts", egg_origin_index(mon, heldByOt)));
    }

    const [, natureName] = SummaryData.nature(mon);
    const rawMetLevel = tonumber(mon.metLevel);
    const hatched = rawMetLevel === 0;
    let metLevel = rawMetLevel ?? 5;
    if (metLevel === 0) metLevel = 5;
    const metLocation = tonumber(mon.metLocation) ?? 0;
    const fatefulMet = metLocation === METLOC_FATEFUL_ENCOUNTER;
    const fatefulFlag = mon.fatefulEncounter === true;

    let key: string;
    let mapName: string | undefined;
    if (heldByOt) {
      // src/pokemon_summary_screen.c:2632
      if (in_kanto_or_sevii(metLocation) || truthy(mon.metLocationName)) {
        mapName = met_location_name(mon, playerState);
      } else if (truthy(opts) && truthy(opts.enemyParty)) {
        // src/pokemon_summary_screen.c:2636
        mapName = RomText.plain("gText_Somewhere");
      } else {
        mapName = RomText.plain("gText_PokeSum_ATrade");
      }
      if (hatched) {
        key = fatefulFlag ? "gText_PokeSum_FatefulEncounterHatched" : "gText_PokeSum_Hatched";
      } else {
        key = fatefulMet ? "gText_PokeSum_FatefulEncounterMet" : "gText_PokeSum_Met";
      }
    } else if (!in_kanto_or_sevii(metLocation) || !from_gba(mon)) {
      // src/pokemon_summary_screen.c:2707
      key = fatefulMet ? "gText_PokeSum_FatefulEncounterMet" : "gText_PokeSum_MetInATrade";
    } else {
      // src/pokemon_summary_screen.c:2735
      mapName = met_location_name(mon, playerState);
      if (hatched) {
        key = fatefulFlag ? "gText_PokeSum_ApparentlyFatefulEncounterHatched" : "gText_PokeSum_ApparentlyMet";
      } else {
        key = fatefulMet ? "gText_PokeSum_FatefulEncounterMet" : "gText_PokeSum_ApparentlyMet";
      }
    }

    // src/pokemon_summary_screen.c:2621 (dynamic: Lua keys 0..2)
    return split_lines(RomText.plain(key, {
      dynamic: [natureName, tostring(metLevel), mapName],
    }));
  },

  // Lua: summary_data.lua:406
  abilityDescription(abilityId: unknown, abilityNameIn: unknown): string {
    const d = get_descriptions();
    const abilityName = rom_name("romAbilityName", abilityId, abilityNameIn);
    if (truthy(d) && truthy(d.ABILITIES) && truthy(abilityName)) {
      const c = "ABILITY_" + const_part(abilityName);
      if (truthy(d.ABILITIES[c])) {
        return Strings(d.ABILITIES[c]);
      }
    }
    // src/data/text/abilities.h:1
    return Strings(d.ABILITIES["ABILITY_"]);
  },

  // Lua: summary_data.lua:419
  moveDescription(moveId: unknown, moveNameIn: unknown): string {
    const d = get_descriptions();
    const moveName = rom_name("romMoveName", moveId, moveNameIn);
    if (truthy(d) && truthy(d.MOVES) && truthy(moveName)) {
      const c = "MOVE_" + const_part(moveName);
      if (truthy(d.MOVES[c])) {
        return Strings(d.MOVES[c]);
      }
    }
    return "---";
  },
};

export default SummaryData;
