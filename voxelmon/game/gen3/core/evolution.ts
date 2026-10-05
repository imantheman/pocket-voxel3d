// Port of gen1recomp src/core/game3/evolution.lua (GPLv3 + additional terms; see LICENSE.md).
// Post-battle evolution (pret TryEvolvePokemon / EVO_MODE_NORMAL).
//
// Lua multiple returns are tuples: targetSpecies and levelTarget return
// [target, param] (levelTarget gives [undefined, undefined] for Lua's nil).
// NOT FAITHFUL (module): src.mods.Schemas is not in the runtime's require
// closure (no shared/mods/Schemas.ts); evo_view takes Brian's own
// pcall(require) failure path, an empty method-name table.
// NOT FAITHFUL (scope): package.loaded["src.core.game3.runtime"] is always
// loaded here (core/runtime.ts is imported).

import { tonumber, truthy } from "../../../import/gen3/lua.ts";
import { ipairs, pairs, insert, len, seq, type LuaTable } from "../platform/lt.ts";
import { gsub, matchAll } from "../platform/lpattern.ts";
import { Pokemon } from "./pokemon.ts";
import { ItemsData } from "./items_data.ts";
import { PokedexData } from "./pokedex_data.ts";
import { Profile } from "./profile.ts";
import { Rtc } from "./rtc.ts";
import { Dex } from "./dex.ts";
import { Runtime as R } from "./runtime.ts";
import { Runtime as ModRuntime } from "../shared/mods/Runtime.ts";
import { Gen3Compat as G3 } from "../shared/mods/Gen3Compat.ts";

const isTable = (v: unknown): v is LuaTable => v !== null && typeof v === "object";
const lor = <T>(a: T, b: T): T => (truthy(a) ? a : b);

const HOLD_EFFECT_PREVENT_EVOLVE = 38; // pokefirered/include/constants/hold_effects.h:42
const ITEM_EVERSTONE = 195; // pokefirered/include/constants/items.h:206

// Lua: evolution.lua:36
function row_method(evo: any): number { return tonumber(lor(evo.method, evo[1])) ?? 0; }
// Lua: evolution.lua:37
function row_param(evo: any): number { return tonumber(lor(evo.param, evo[2])) ?? 0; }
// Lua: evolution.lua:38
function row_target(evo: any): number { return tonumber(lor(evo.target, evo[3])) ?? 0; }

// Lua: evolution.lua:40
function numeric_item(raw: unknown): number {
  if (raw == null) return 0;
  const num = tonumber(raw);
  if (num !== undefined) return num;
  // Lua: pcall(require, "src.core.game3.items_data") -- always loads here
  if (ItemsData && ItemsData.toNumericId) {
    try {
      const n = ItemsData.toNumericId(raw);
      if (tonumber(n) !== undefined) return tonumber(n) as number;
    } catch {
      // Lua: pcall failed
    }
  }
  return 0;
}

// Lua: evolution.lua:52
function held_item_id(mon: any): number {
  return numeric_item(truthy(mon) ? lor(mon.item, mon.heldItem) : undefined);
}

// Lua: evolution.lua:57 -- pokefirered/src/pokemon.c:5038
function hold_effect_of(item: number): number {
  if (item === 0) return 0;
  if (ItemsData && ItemsData.info) {
    try {
      const info = ItemsData.info(item);
      if (info != null && tonumber(info.holdEffect) !== undefined) return tonumber(info.holdEffect) as number;
    } catch {
      // Lua: pcall failed
    }
  }
  if (item === ITEM_EVERSTONE) return HOLD_EFFECT_PREVENT_EVOLVE;
  return 0;
}

// Lua: evolution.lua:68
function is_national_unlocked(session: any): boolean {
  return PokedexData.isNationalUnlocked(session);
}

// Lua: evolution.lua:83 -- pokeemerald/src/pokemon.c:5540
function local_hours(session: any): number | undefined {
  if (!truthy(Rtc.enabled(session))) return undefined;
  return tonumber(Rtc.calcLocalTime(session).hours);
}

interface NormalContext {
  level: number; friendship: number; beauty: number; upper: number; atk: number; def: number; session: any;
}

// Lua: evolution.lua:89
function normal_context(mon: any, session: any): NormalContext {
  return {
    level: tonumber(mon.level) ?? 1,
    friendship: Pokemon.friendshipOf(mon),
    beauty: tonumber(isTable(mon.contest) ? mon.contest.beauty : false) ?? 0, // pokeemerald/src/pokemon.c:5512
    upper: Math.floor((tonumber(mon.personality) ?? 0) / 65536) % 65536,
    atk: tonumber(lor(mon.attack, mon.atk)) ?? 0,
    def: tonumber(lor(mon.defense, mon.def)) ?? 0,
    session,
  };
}

// pokeemerald/src/pokemon.c:51
const DAY_EVO_HOUR_BEGIN = 12, DAY_EVO_HOUR_END = 24;
const NIGHT_EVO_HOUR_BEGIN = 0, NIGHT_EVO_HOUR_END = 12;

// Lua: evolution.lua:106 -- pokefirered/src/pokemon.c:5053
function row_matches_normal(evo: any, c: NormalContext): boolean {
  const m = row_method(evo), param = row_param(evo);
  if (m === Evolution.EVO_FRIENDSHIP) {
    return c.friendship >= 220;
  } else if (m === Evolution.EVO_FRIENDSHIP_DAY || m === Evolution.EVO_FRIENDSHIP_NIGHT) {
    // pokeemerald/src/pokemon.c:5539
    const hours = local_hours(c.session);
    if (hours == null || c.friendship < 220) return false;
    if (m === Evolution.EVO_FRIENDSHIP_DAY) {
      return hours >= DAY_EVO_HOUR_BEGIN && hours < DAY_EVO_HOUR_END;
    }
    return hours >= NIGHT_EVO_HOUR_BEGIN && hours < NIGHT_EVO_HOUR_END;
  } else if (m === Evolution.EVO_LEVEL) {
    return param <= c.level;
  } else if (m === Evolution.EVO_LEVEL_ATK_GT_DEF) {
    return param <= c.level && c.atk > c.def;
  } else if (m === Evolution.EVO_LEVEL_ATK_EQ_DEF) {
    return param <= c.level && c.atk === c.def;
  } else if (m === Evolution.EVO_LEVEL_ATK_LT_DEF) {
    return param <= c.level && c.atk < c.def;
  } else if (m === Evolution.EVO_LEVEL_SILCOON) {
    return param <= c.level && (c.upper % 10) <= 4;
  } else if (m === Evolution.EVO_LEVEL_CASCOON) {
    return param <= c.level && (c.upper % 10) > 4;
  } else if (m === Evolution.EVO_LEVEL_NINJASK) {
    return param <= c.level;
  } else if (m === Evolution.EVO_BEAUTY) {
    return param <= c.beauty;
  }
  // pokefirered/src/pokemon.c:5061, :5107
  return false;
}

interface EvoView {
  method: any; methodId: number; param: number; level: number; species: any; speciesId: number;
}

// Lua: evolution.lua:139
function evo_view(evo: any): EvoView {
  // Lua: pcall(require, "src.mods.Schemas") fails here (see the header note)
  const methods: Record<number, any> = {};
  const method = tonumber(lor(evo.method, evo[1])) ?? 0;
  const param = tonumber(lor(evo.param, evo[2])) ?? 0;
  const target = tonumber(lor(evo.target, evo[3])) ?? 0;
  return {
    method: methods[method] ?? method, methodId: method, param,
    level: param, species: G3.speciesName(target), speciesId: target,
  };
}

// Lua: evolution.lua:152 -- returns target, param
function scan_normal(mon: any, species: number, hook: any, session: any): [number, number] {
  const c = normal_context(mon, lor(session, truthy(hook) ? hook.session : hook));
  let target = 0, param = 0;
  for (const [, evo] of ipairs(Pokemon.evolutions(species))) {
    const matched = row_matches_normal(evo, c);
    if (truthy(hook)) {
      const view = evo_view(evo);
      const ok = ModRuntime.call("evolution.check", () => {
        return matched;
      }, hook.game, mon, view, { kind: "levelup", session: hook.session });
      if (truthy(ok)) {
        if (matched) {
          target = row_target(evo); param = row_param(evo);
        } else if (view.speciesId > 0) {
          target = view.speciesId; param = view.param;
        }
      }
    } else if (matched) {
      target = row_target(evo); param = row_param(evo);
    }
  }
  return [target, param];
}

// Lua: evolution.lua:177 -- pokefirered/src/pokemon.c:5114
function scan_trade(mon: any, species: number): [number, number] {
  const heldItem = held_item_id(mon);
  let target = 0, param = 0;
  for (const [, evo] of ipairs(Pokemon.evolutions(species))) {
    const m = row_method(evo);
    if (m === Evolution.EVO_TRADE) {
      target = row_target(evo); param = row_param(evo);
    } else if (m === Evolution.EVO_TRADE_ITEM && row_param(evo) === heldItem) {
      target = row_target(evo); param = row_param(evo);
    }
  }
  return [target, param];
}

// Lua: evolution.lua:192 -- pokefirered/src/pokemon.c:5139
function scan_item(mon: any, species: number, evolutionItem: unknown): [number, number] {
  const num = numeric_item(evolutionItem);
  if (num === 0) return [0, 0];
  for (const [, evo] of ipairs(Pokemon.evolutions(species))) {
    if (row_method(evo) === Evolution.EVO_ITEM && row_param(evo) === num) {
      return [row_target(evo), row_param(evo)];
    }
  }
  return [0, 0];
}

// Lua: evolution.lua:277 (renameMon's local function trim)
function trim(s: unknown): string {
  if (typeof s !== "string") return "";
  const m = matchAll(gsub(s, "%z+", "")[0], "^%s*(.-)%s*$");
  return m ? String(m[0]) : "";
}

export const Evolution = {
  // pokefirered/include/constants/pokemon.h:266
  EVO_FRIENDSHIP: 1,
  EVO_FRIENDSHIP_DAY: 2,
  EVO_FRIENDSHIP_NIGHT: 3,
  EVO_LEVEL: 4,
  EVO_TRADE: 5,
  EVO_TRADE_ITEM: 6,
  EVO_ITEM: 7,
  EVO_LEVEL_ATK_GT_DEF: 8,
  EVO_LEVEL_ATK_EQ_DEF: 9,
  EVO_LEVEL_ATK_LT_DEF: 10,
  EVO_LEVEL_SILCOON: 11,
  EVO_LEVEL_CASCOON: 12,
  EVO_LEVEL_NINJASK: 13,
  EVO_LEVEL_SHEDINJA: 14,
  EVO_BEAUTY: 15,

  // pokefirered/include/constants/pokemon.h:284
  EVO_MODE_NORMAL: 0,
  EVO_MODE_TRADE: 1,
  EVO_MODE_ITEM_USE: 2,
  EVO_MODE_ITEM_CHECK: 3,

  KANTO_SPECIES_END: 151, // pokefirered/include/constants/species.h:157

  /** pokefirered/src/party_menu.c:5320 */
  // Lua: evolution.lua:74
  nationalAllows(targetIn: unknown, session?: any): boolean {
    if (!truthy(Profile.forSession(session).dex.evolutionGate)) return true;
    const target = tonumber(targetIn) ?? 0;
    if (target <= Evolution.KANTO_SPECIES_END) return true;
    return is_national_unlocked(session) ? true : false;
  },

  // Lua: evolution.lua:204 -- pokefirered/src/pokemon.c:5025 GetEvolutionTargetSpecies
  targetSpecies(mon: any, modeIn?: unknown, evolutionItem?: unknown, hook?: any, session?: any): [number, number] {
    if (!truthy(mon)) return [0, 0];
    const species = Pokemon.speciesOf(mon) ?? tonumber(lor(mon.species, mon.speciesId));
    if (species == null) return [0, 0];
    const mode = tonumber(modeIn) ?? Evolution.EVO_MODE_NORMAL;
    if (hold_effect_of(held_item_id(mon)) === HOLD_EFFECT_PREVENT_EVOLVE
      && mode !== Evolution.EVO_MODE_ITEM_CHECK) {
      return [0, 0];
    }
    if (mode === Evolution.EVO_MODE_NORMAL) {
      return scan_normal(mon, species, hook, session);
    } else if (mode === Evolution.EVO_MODE_TRADE) {
      return scan_trade(mon, species);
    }
    return scan_item(mon, species, evolutionItem);
  },

  // Lua: evolution.lua:222 -- pokefirered/src/pokemon.c:5049, src/evolution_scene.c:641
  levelTarget(mon: any, session?: any): [number | undefined, number | undefined] {
    if (!truthy(mon)) return [undefined, undefined];
    let hook: any;
    if (truthy(ModRuntime.wantsHook("evolution.check"))) {
      hook = { game: R ? R._game : undefined, session };
    }
    const [target, param] = Evolution.targetSpecies(mon, Evolution.EVO_MODE_NORMAL, undefined, hook, session);
    if (target === 0) return [undefined, undefined];
    if (!Evolution.nationalAllows(target, session)) return [undefined, undefined];
    return [target, param];
  },

  // Lua: evolution.lua:236 -- pokefirered/src/pokemon.c:5139, src/party_menu.c:5318 MonCanEvolve
  itemTarget(mon: any, itemId: unknown, session?: any): number | undefined {
    if (!truthy(mon)) return undefined;
    const [target] = Evolution.targetSpecies(mon, Evolution.EVO_MODE_ITEM_USE, itemId);
    if (target === 0) return undefined;
    if (!Evolution.nationalAllows(target, session)) return undefined;
    return target;
  },

  // Lua: evolution.lua:245 -- pokefirered/src/party_menu.c:872
  itemCheck(mon: any, itemId: unknown): number | undefined {
    if (!truthy(mon)) return undefined;
    const [target] = Evolution.targetSpecies(mon, Evolution.EVO_MODE_ITEM_CHECK, itemId);
    if (target === 0) return undefined;
    return target;
  },

  // Lua: evolution.lua:253 -- pokefirered/src/pokemon.c:5114
  tradeTarget(mon: any, session?: any): number | undefined {
    if (!truthy(mon)) return undefined;
    const [target] = Evolution.targetSpecies(mon, Evolution.EVO_MODE_TRADE);
    if (target === 0) return undefined;
    if (Evolution.nationalAllows(target, session)) {
      const species = Pokemon.speciesOf(mon) ?? tonumber(lor(mon.species, mon.speciesId));
      const heldItem = held_item_id(mon);
      for (const [, evo] of ipairs(Pokemon.evolutions(species ?? 0))) {
        if (row_method(evo) === Evolution.EVO_TRADE_ITEM && row_param(evo) === heldItem
          && row_target(evo) === target) {
          mon.item = 0;
          mon.heldItem = 0;
        }
      }
      return target;
    }
    return undefined;
  },

  /** Rename mon on evolution matching retail FRLG EvolutionRenameMon rules. */
  // Lua: evolution.lua:273
  renameMon(mon: any, preSpecies: unknown, postSpecies: unknown): void {
    if (!truthy(mon)) return;
    const preName = Pokemon.name(preSpecies) ?? "";
    const newName = Pokemon.name(postSpecies);
    const nick = trim(mon.nickname);
    const pName = trim(preName);
    if (nick === "" || nick.toUpperCase() === pName.toUpperCase()) {
      mon.nickname = newName;
      mon.name = newName;
    } else {
      mon.name = nick;
    }
  },

  /** Apply species change + stats. Point of no return. */
  // Lua: evolution.lua:292
  apply(mon: any, newSpeciesIn: unknown, session?: any, _bag?: any, via?: string): boolean {
    const newSpecies = tonumber(newSpeciesIn);
    if (!truthy(mon) || newSpecies === undefined) return false;
    const preSpecies: number = Pokemon.speciesOf(mon) ?? tonumber(lor(mon.species, mon.speciesId)) ?? 1;
    const oldMax = tonumber(mon.maxHp) ?? 1;
    const oldHp = tonumber(mon.hp) ?? oldMax;

    // 1. Mutate species
    mon.species = newSpecies;
    mon.speciesId = newSpecies;
    Pokemon.tagNumbering(mon, Pokemon.NUMBERING_INTERNAL);

    // 2. Nickname update
    Evolution.renameMon(mon, preSpecies, newSpecies);

    // pokeemerald/src/pokemon.c:4556 GetMonAbility
    const pair = Pokemon.abilities(newSpecies);
    const slot = tonumber(mon.abilityNum);
    let ability = slot !== undefined ? pair[slot + 1] : undefined;
    if (!truthy(ability) || ability === 0) ability = Pokemon.abilityId(newSpecies, mon.personality);
    mon.ability = ability; mon.abilityId = ability;

    // 3. Recalculate stats & handle HP delta
    Pokemon.applyStats(mon);
    const newMax = tonumber(mon.maxHp) ?? oldMax;
    if (oldHp > 0) {
      mon.hp = Math.min(newMax, oldHp + Math.max(0, newMax - oldMax));
    } else {
      mon.hp = 0; // preserve fainted status
    }

    // 4. Pokedex registration
    if (truthy(session) && truthy(session.dex)) {
      Dex.setSeen(session.dex, newSpecies);
      Dex.setCaught(session.dex, newSpecies);
    }

    // 5. pokefirered/src/evolution_scene.c:550 CreateShedinja
    const preRows = Pokemon.evolutions(preSpecies);
    let shedId = 0;
    if (truthy(preRows[1]) && row_method(preRows[1]) === Evolution.EVO_LEVEL_NINJASK && truthy(preRows[2])) {
      shedId = row_target(preRows[2]);
    }
    if (shedId > 0 && truthy(session)) {
      session.party = session.party ?? (truthy(session.save) ? session.save.party : undefined) ?? seq();
      const party = session.party;
      if (len(party) < 6) {
        const shedinja: any = {};
        for (const [k, v] of pairs(mon)) {
          if (isTable(v)) {
            // one level deep, as the Lua's pairs copy
            shedinja[k] = Array.isArray(v) ? v.slice() : { ...v };
          } else {
            shedinja[k] = v;
          }
        }
        shedinja.species = shedId;
        shedinja.speciesId = shedId;
        Pokemon.tagNumbering(shedinja, Pokemon.NUMBERING_INTERNAL);
        shedinja.name = Pokemon.name(shedId);
        shedinja.nickname = Pokemon.name(shedId);
        shedinja.heldItem = 0;
        shedinja.item = 0;
        shedinja.status = 0;
        delete shedinja.markings;
        delete shedinja.mail;
        if (Pokemon.abilityId) {
          shedinja.ability = Pokemon.abilityId(shedId, shedinja.personality);
          shedinja.abilityId = shedinja.ability;
        }
        delete shedinja.hp;
        Pokemon.applyStats(shedinja);
        shedinja.hp = 1;
        insert(party, shedinja);
        if (truthy(session.dex)) {
          Dex.setSeen(session.dex, shedId);
          Dex.setCaught(session.dex, shedId);
        }
      }
    }

    if (truthy(ModRuntime.wants("pokemon.evolved"))) {
      ModRuntime.emit("pokemon.evolved", {
        mon,
        fromSpecies: Pokemon.keyName(preSpecies) ?? preSpecies,
        toSpecies: Pokemon.keyName(newSpecies) ?? newSpecies,
        fromSpeciesId: preSpecies,
        toSpeciesId: newSpecies,
        via: via ?? "level",
      });
    }

    return true;
  },

  /**
   * Scan party (or indices) for pending level evolutions.
   * leveledSet: optional {[partyIndex]=true} from battle.
   * Returns { {mon, partyIndex, fromSpecies, toSpecies}, ... }
   */
  // Lua: evolution.lua:391
  pending(party: any, leveledSet?: any, session?: any): LuaTable {
    const out: LuaTable = seq();
    if (!isTable(party)) return out;
    for (const [i, mon] of ipairs<any>(party)) {
      if (truthy(mon) && (!truthy(leveledSet) || truthy(leveledSet[i]))) {
        const [target] = Evolution.levelTarget(mon, session);
        if (truthy(target)) {
          insert(out, {
            mon,
            partyIndex: i,
            fromSpecies: tonumber(lor(mon.species, mon.speciesId)),
            toSpecies: target,
          });
        }
      }
    }
    return out;
  },
};

export default Evolution;
