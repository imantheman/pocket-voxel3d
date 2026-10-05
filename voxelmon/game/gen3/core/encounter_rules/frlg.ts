// Port of gen1recomp src/core/game3/encounter_rules/frlg.lua (GPLv3 + additional terms; see LICENSE.md).
// The FireRed/LeafGreen wild-encounter rules: the step cooldown, the rate
// test and its modifiers, and the land / water / rock / fishing / Sweet
// Scent rolls (pret wild_encounter.c).
//
// Port notes:
// - encounters.lua loads this module by a built name,
//   require("src.core.game3.encounter_rules." .. family).bind(Encounters, H).
//   The port has no dynamic require: this module registers itself with the
//   loader at import time (`Encounters.deps.rules.frlg`, below), and the
//   loader may also import EncounterRulesFrlg statically.
// - bind's `Encounters` proxy (setmetatable: reads try R then E; function
//   writes go to R, other writes to E) is resolved at each use: the rule
//   functions this file defines are R's (so `Encounters.rollWater` here is
//   R.rollWater, not the loader's delegating wrapper), and everything else
//   (ensureLoaded, _stepsSinceLastEncounter, _encounterRateBuff, _prevGrass)
//   is read from and written to E. R never holds those names, so this is
//   the proxy's exact behaviour.
// - pcall(require, X) is a static import with Brian's guards kept. Roamer
//   is still a stub: calling its stubbed tryEncounter reads as the failed
//   require (the brief's rule), see roamer_try.
// - Area slots come from the loader's H helpers (normalize_area). See
//   slot_len / slot_at for the table-shape seam.
// - cooldownMinSteps returns its two values as a tuple [minSteps, leak]
//   ([undefined, undefined] for the Lua's nil).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tonumber, truthy } from "../../../../import/gen3/lua.ts";
import { luaGet, luaLen } from "../../../../import/gen3/luatable.ts";
import { seq, len, type LuaTable } from "../../platform/lt.ts";
import { NotPortedError } from "../../notported.ts";
import { Rng } from "../rng.ts";
import { Runtime } from "../runtime.ts";
import { Space } from "../scripting/space.ts";
import { Flags } from "../scripting/flags.ts";
import { Roamer } from "../roamer.ts";
import { Encounters as EncountersModule } from "../encounters.ts";

type Tbl = Record<string, any>;

// SEAM (table shapes): the loader's areas may be in the lt.ts shape (a
// sequence is [null, a, b, ...]) or in the readLuaLiteral shape the current
// core/encounters.ts loads (a sequence is a 0-based array [a, b, ...]).
// A Lua sequence's key 1 is never nil, so slot 0 tells them apart; objects
// with integer keys read the same either way.
function slot_len(t: any): number {
  if (Array.isArray(t) && t.length > 0 && t[0] == null) return len(t);
  return luaLen(t);
}
function slot_at(t: any, i: number): any {
  if (Array.isArray(t) && t.length > 0 && t[0] == null) return t[i];
  return luaGet(t, i);
}

const MAX_ENCOUNTER_RATE = 1600; // pret wild_encounter.c (FireRed)

// Ids the encounter-rate modifiers below key off (pret constants/abilities.h,
// constants/items.h, constants/flags.h).
const ABILITY_STENCH = 1;
const ABILITY_ILLUMINATE = 35;
const ITEM_CLEANSE_TAG = 190;
const FLAG_SYS_WHITE_FLUTE_ACTIVE = 0x803;
const FLAG_SYS_BLACK_FLUTE_ACTIVE = 0x804;

// pret GetMapBaseEncounterCooldown returns 0xFF when the map has no encounter
// data for that tile type, which aborts the check instead of granting a grace
// period (the roll would fail anyway).
const COOLDOWN_NONE = 0xFF;
const COOLDOWN_BASE_LEAK = 5; // pret: encRate = 5 * 256
const COOLDOWN_SCALE = 256; // pret keeps minSteps/encRate scaled so the modifiers stay fractional

// pret AddToWildEncounterRateBuff banks into a u16 field, so it wraps there.
const RATE_BUFF_MOD = 65536;

// pokefirered/include/constants/items.h:457
const ROD_OLD = 0, ROD_GOOD = 1, ROD_SUPER = 2;

// Lua: frlg.lua:311 -- ROD_KINDS, split by key type (a Lua table keeps 0 and
// "0" apart; a JS object would not).
const ROD_KINDS_BY_ID: Record<number, number> = {
  [0]: ROD_OLD, [1]: ROD_GOOD, [2]: ROD_SUPER,
  [262]: ROD_OLD, [263]: ROD_GOOD, [264]: ROD_SUPER,
};
const ROD_KINDS_BY_NAME: Record<string, number> = {
  old: ROD_OLD, good: ROD_GOOD, super: ROD_SUPER,
  OLD_ROD: ROD_OLD, GOOD_ROD: ROD_GOOD, SUPER_ROD: ROD_SUPER,
  ITEM_OLD_ROD: ROD_OLD, ITEM_GOOD_ROD: ROD_GOOD, ITEM_SUPER_ROD: ROD_SUPER,
};
function rod_kind(k: unknown): number | undefined {
  if (typeof k === "number") return ROD_KINDS_BY_ID[k];
  if (typeof k === "string") return Object.prototype.hasOwnProperty.call(ROD_KINDS_BY_NAME, k) ? ROD_KINDS_BY_NAME[k] : undefined;
  return undefined;
}

// pokefirered/src/data/wild_encounters.h:31
const FISHING_TOTAL = 100;
const FISHING_WINDOWS: Record<number, LuaTable> = {
  [ROD_OLD]: seq(seq(70, 1), seq(100, 2)),
  [ROD_GOOD]: seq(seq(60, 3), seq(80, 4), seq(100, 5)),
  [ROD_SUPER]: seq(seq(40, 6), seq(80, 7), seq(95, 8), seq(99, 9), seq(100, 10)),
};

// pcall(require, "src.core.game3.runtime") always succeeds here.
function get_session(): any {
  return Runtime && Runtime.getSession && Runtime.getSession();
}

// pcall(require, "src.core.game3.roamer") + Roamer.tryEncounter: a stubbed
// tryEncounter (roamer not ported yet) reads as the failed require.
function roamer_try(mapId: unknown, areaKey: string): any {
  if (!(Roamer && Roamer.tryEncounter)) return undefined;
  const session = get_session();
  try {
    return Roamer.tryEncounter(session, mapId, areaKey);
  } catch (e) {
    if (e instanceof NotPortedError && e.what === "Roamer.tryEncounter") return undefined;
    throw e;
  }
}

// Lua: frlg.lua:5
function bind(E: any, H: any): Tbl {
  const R: Tbl = {};
  const normalize_area: (area: any, fallbackRate?: number) => { rate: any; slots: any } | undefined = H.normalize_area;
  const table_for: (mapId: unknown) => Tbl | undefined = H.table_for;
  const area_for: (mapId: unknown, terrain: unknown) => { rate: any; slots: any } | undefined = H.area_for;
  const pick_slot: (slots: any, weights: any) => any = H.pick_slot;
  const level_of: (entry: any) => number = H.level_of;
  const bike_active: () => boolean = H.bike_active;
  const repel_active: () => boolean = H.repel_active;
  const wild_level_allowed_by_repel: (level: unknown) => boolean = H.wild_level_allowed_by_repel;
  const LAND_WEIGHTS = H.LAND_WEIGHTS;
  const WATER_WEIGHTS = H.WATER_WEIGHTS;

  // Lua: frlg.lua:48
  /** pret DoWildEncounterRateDiceRoll: WildEncounterRandom() % 1600 < rate. */
  function rate_dice_roll(rate: number): boolean {
    return (Rng.WildEncounterRandom() % MAX_ENCOUNTER_RATE) < rate;
  }

  // ---------------------------------------------------------------------------
  // Wild encounter grace period (pret wild_encounter.c).
  //
  // FireRed is the only generation with a step cooldown between wild battles:
  // HandleWildEncounterCooldown refuses the roll for a map-dependent number of
  // steps after the last encounter, then lets a small percentage per step
  // through so the wait is soft rather than a hard floor.
  // ---------------------------------------------------------------------------

  // Lua: frlg.lua:64
  /**
   * pret GetMapBaseEncounterCooldown: how many steps after a battle are immune,
   * derived from the area's own encounter rate. Rates at 80+ get no grace period
   * at all; below that the wait grows as the rate drops.
   */
  R.mapBaseCooldown = function (terrainIn: unknown, rateIn: unknown): number {
    let terrain = terrainIn;
    if (terrain === "grass" || terrain === "cave" || terrain === "tall_grass") terrain = "land";
    if (terrain !== "land" && terrain !== "water") return COOLDOWN_NONE;
    if (rateIn == null) return COOLDOWN_NONE;
    const rate = tonumber(rateIn) ?? 0;
    if (rate >= 80) return 0;
    if (rate < 10) return 8;
    return 8 - Math.floor(rate / 10);
  };

  // Lua: frlg.lua:75
  /** pret GetLeadMonIndex: the lead party slot, eggs excluded. */
  function lead_mon(): any {
    const session = get_session();
    const party = session && session.party;
    if (party == null || typeof party !== "object") return undefined;
    for (let i = 1; i <= len(party); i++) {
      const mon = party[i];
      if (mon != null && typeof mon === "object" && !truthy(mon.isEgg) && !truthy(mon.egg)) return mon;
    }
    return undefined;
  }

  // Lua: frlg.lua:88
  /** pret GetFluteEncounterRateModType: 1 = White Flute, 2 = Black Flute. */
  function flute_mod_type(): number {
    // pcall(require, "src.core.game3.scripting.space") always succeeds here.
    if (!Space || !Space.store) return 0;
    // pcall(require, "src.core.game3.scripting.flags") always succeeds here.
    if (!Flags || !Flags.getFlag) return 0;
    if (truthy(Flags.getFlag(Space.store, null, FLAG_SYS_WHITE_FLUTE_ACTIVE))) return 1;
    if (truthy(Flags.getFlag(Space.store, null, FLAG_SYS_BLACK_FLUTE_ACTIVE))) return 2;
    return 0;
  }

  // Lua: frlg.lua:99
  /** pret IsLeadMonHoldingCleanseTag. */
  function lead_holds_cleanse_tag(): boolean {
    const mon = lead_mon();
    if (!mon) return false;
    return (tonumber(truthy(mon.item) ? mon.item : mon.heldItem) ?? 0) === ITEM_CLEANSE_TAG;
  }

  // Lua: frlg.lua:106
  /** pret GetAbilityEncounterRateModType: Stench 1 (rarer), Illuminate 2 (commoner). */
  function ability_mod_type(): number {
    const mon = lead_mon();
    if (!mon) return 0;
    const ability = tonumber(truthy(mon.abilityId) ? mon.abilityId : mon.ability) ?? 0;
    if (ability === ABILITY_STENCH) return 1;
    if (ability === ABILITY_ILLUMINATE) return 2;
    return 0;
  }

  // Lua: frlg.lua:117
  /**
   * The fully modified (minSteps, leak) pair pret computes inside
   * HandleWildEncounterCooldown. nil means "no encounter data here".
   */
  R.cooldownMinSteps = function (terrain: unknown, rate: unknown): [number, number] | [undefined, undefined] {
    let minSteps: number = R.mapBaseCooldown(terrain, rate);
    if (minSteps === COOLDOWN_NONE) return [undefined, undefined];

    minSteps = minSteps * COOLDOWN_SCALE;
    let leak = COOLDOWN_BASE_LEAK * COOLDOWN_SCALE;
    const flute = flute_mod_type();
    if (flute === 1) {
      minSteps = minSteps - Math.floor(minSteps / 2);
      leak = leak + Math.floor(leak / 2);
    } else if (flute === 2) {
      minSteps = minSteps * 2;
      leak = Math.floor(leak / 2);
    }
    if (lead_holds_cleanse_tag()) {
      minSteps = minSteps + Math.floor(minSteps / 3);
      leak = leak - Math.floor(leak / 3);
    }
    const ability = ability_mod_type();
    if (ability === 1) {
      minSteps = minSteps * 2;
      leak = Math.floor(leak / 2);
    } else if (ability === 2) {
      minSteps = Math.floor(minSteps / 2);
      leak = leak * 2;
    }
    return [Math.floor(minSteps / COOLDOWN_SCALE), Math.floor(leak / COOLDOWN_SCALE)];
  };

  // Lua: frlg.lua:149
  /**
   * pret HandleWildEncounterCooldown. TRUE means this step may roll for an
   * encounter. Runs on every step onto an encounter tile -- including the steps
   * the dice roll would have denied, which is what advances the counter.
   */
  R.handleCooldown = function (terrain: unknown, rate: unknown): boolean {
    const [minSteps, leak] = R.cooldownMinSteps(terrain, rate) as [number | undefined, number | undefined];
    if (minSteps == null) return false;

    if (E._stepsSinceLastEncounter >= minSteps) return true;
    E._stepsSinceLastEncounter = E._stepsSinceLastEncounter + 1;
    return (Rng.Random() % 100) < leak!;
  };

  // Lua: frlg.lua:162
  /**
   * pret ResetEncounterRateModifiers, reached from RestartWildEncounterImmunitySteps
   * on map load (overworld.c) and on battle start (battle_setup.c). Resetting when
   * the battle starts is what re-arms the grace period, including for wild battles
   * nothing stepped into (scripts, fishing).
   */
  R.resetRateModifiers = function (): void {
    E._stepsSinceLastEncounter = 0;
    E._encounterRateBuff = 0;
  };

  // Lua: frlg.lua:169
  /**
   * pret AddToWildEncounterRateBuff: bank a failed roll's rate so the next
   * attempt is likelier. A Repel zeroes the bank instead of growing it.
   */
  function add_to_rate_buff(rate: unknown): void {
    if (repel_active()) {
      E._encounterRateBuff = 0;
      return;
    }
    E._encounterRateBuff =
      (E._encounterRateBuff + (tonumber(rate) ?? 0)) % RATE_BUFF_MOD;
  }

  // Lua: frlg.lua:182
  /**
   * pret DoWildEncounterRateTest, without the roll: the threshold in 1/1600ths
   * that the dice roll compares against. Every encounter-rate modifier applies
   * here as well as in the cooldown -- bike, banked buff, flute, Cleanse Tag,
   * then ability, in pret's order.
   */
  R.encounterRate = function (rate: unknown, opts?: { ignoreAbility?: boolean }): number {
    let r = (tonumber(rate) ?? 0) * 16;
    if (bike_active()) r = Math.floor(r * 80 / 100);
    r = r + Math.floor(E._encounterRateBuff * 16 / 200);
    const flute = flute_mod_type();
    if (flute === 1) {
      r = r + Math.floor(r / 2);
    } else if (flute === 2) {
      r = Math.floor(r / 2);
    }
    if (lead_holds_cleanse_tag()) r = Math.floor(r * 2 / 3);
    if (!(opts && opts.ignoreAbility)) {
      const ability = ability_mod_type();
      if (ability === 1) {
        r = Math.floor(r / 2);
      } else if (ability === 2) {
        r = r * 2;
      }
    }
    if (r > MAX_ENCOUNTER_RATE) r = MAX_ENCOUNTER_RATE;
    return r;
  };

  // Lua: frlg.lua:205
  function rate_test(rate: unknown): boolean {
    return rate_dice_roll(R.encounterRate(rate));
  }

  // Lua: frlg.lua:209
  function roll_area(mapId: unknown, areaKey: string, weights: any, enterFromOther: unknown, fallbackRate?: number): any {
    const t = table_for(mapId);
    const area = normalize_area(t && t[areaKey], fallbackRate);
    if (!area || slot_len(area.slots) === 0) return undefined;

    // pret DoGlobalWildEncounterDiceRoll: (Random() % 100) >= 60 → deny.
    // This returns before the rate test, so it does not bank into the buff.
    if (truthy(enterFromOther) && (Rng.Random() % 100) >= 60) {
      return undefined;
    }
    if (!rate_test(area.rate)) {
      add_to_rate_buff(area.rate);
      return undefined;
    }

    // pokefirered/src/wild_encounter.c:645 TryStartRoamerEncounter
    const roamerEnc = roamer_try(mapId, areaKey);
    if (truthy(roamerEnc)) {
      return roamerEnc;
    }

    const entry = pick_slot(area.slots, weights);
    if (entry == null || typeof entry !== "object") {
      // pret banks here too: the rate test passed but TryGenerateWildMon found
      // no allowed mon (repel level check, empty slot).
      add_to_rate_buff(area.rate);
      return undefined;
    }
    // pokefirered/src/wild_encounter.c:286
    const level = level_of(entry);
    if (!wild_level_allowed_by_repel(level)) {
      add_to_rate_buff(area.rate);
      return undefined;
    }
    return {
      species: entry.species ?? slot_at(entry, 1),
      level,
      item: entry.item,
    };
  }

  // Lua: frlg.lua:255
  R.rollLand = function (mapId: unknown, rate?: number, enterFromOther?: unknown): any {
    E.ensureLoaded();
    return roll_area(mapId, "land", LAND_WEIGHTS, enterFromOther, rate)
      || roll_area(mapId, "grass", LAND_WEIGHTS, enterFromOther, rate);
  };

  // Lua: frlg.lua:261
  R.rollWater = function (mapId: unknown, enterFromOther?: unknown): any {
    E.ensureLoaded();
    return roll_area(mapId, "water", WATER_WEIGHTS, enterFromOther, 15);
  };

  // Lua: frlg.lua:267
  // pokefirered/src/wild_encounter.c:464
  R.rollSweetScent = function (mapId: unknown, terrain: unknown): any {
    E.ensureLoaded();
    const water = terrain === "water";
    const t = table_for(mapId);
    const area = (water ? normalize_area(t && t.water, 15) : undefined)
      || normalize_area(t && (t.land || t.grass), undefined);
    const roamerEnc = roamer_try(mapId, water ? "water" : "land");
    if (truthy(roamerEnc)) return roamerEnc;
    if (!area || slot_len(area.slots) === 0) return undefined;
    const entry = pick_slot(area.slots, water ? WATER_WEIGHTS : LAND_WEIGHTS);
    if (entry == null || typeof entry !== "object") return undefined;
    return { species: entry.species ?? slot_at(entry, 1), level: level_of(entry), item: entry.item };
  };

  // Lua: frlg.lua:287
  /** pokefirered/src/wild_encounter.c:446 */
  R.rollRocks = function (mapId: unknown): any {
    E.ensureLoaded();
    const t = table_for(mapId);
    const area = normalize_area(t && t.rocks, 20);
    if (!area || slot_len(area.slots) === 0) return undefined;
    if (!rate_dice_roll(R.encounterRate(area.rate, { ignoreAbility: true }))) {
      return undefined;
    }
    // pokefirered/src/wild_encounter.c:269
    const entry = pick_slot(area.slots, WATER_WEIGHTS);
    if (entry == null || typeof entry !== "object") return undefined;
    const level = level_of(entry);
    if (!wild_level_allowed_by_repel(level)) return undefined;
    R.resetRateModifiers();
    return {
      species: entry.species ?? slot_at(entry, 1),
      level,
      item: entry.item,
    };
  };

  // Lua: frlg.lua:328
  /** pokefirered/src/wild_encounter.c:117 */
  function choose_fishing_index(rod: number): number {
    const windows = FISHING_WINDOWS[rod] ?? FISHING_WINDOWS[ROD_OLD];
    const rand = Rng.Random() % FISHING_TOTAL;
    for (let i = 1; i <= len(windows); i++) {
      if (rand < windows[i][1]) return windows[i][2];
    }
    return 1;
  }

  // Lua: frlg.lua:338
  /** pokefirered/src/wild_encounter.c:509 */
  R.hasFishingMons = function (mapId: unknown): boolean {
    E.ensureLoaded();
    const t = table_for(mapId);
    const area = normalize_area(t && t.fishing, 0);
    return area != null && slot_len(area.slots) > 0;
  };

  // Lua: frlg.lua:346
  /** pokefirered/src/wild_encounter.c:519 */
  R.rollFishing = function (mapId: unknown, rodKind: unknown): any {
    E.ensureLoaded();
    const t = table_for(mapId);
    const area = normalize_area(t && t.fishing, 0);
    if (!area || slot_len(area.slots) === 0) return undefined;
    let rod = rod_kind(rodKind);
    if (rod == null) rod = ROD_OLD;
    let idx = choose_fishing_index(rod);
    if (idx > slot_len(area.slots)) idx = slot_len(area.slots);
    const entry = slot_at(area.slots, idx);
    if (entry == null || typeof entry !== "object") return undefined;
    R.resetRateModifiers();
    return {
      species: entry.species ?? slot_at(entry, 1),
      level: level_of(entry),
      item: entry.item,
    };
  };

  // Lua: frlg.lua:365
  function vanilla_step(mapId: unknown, terrain: unknown, optsIn?: Tbl): any {
    E.ensureLoaded();
    const opts = optsIn ?? {};
    let enterFromOther = opts.enterFromOther;
    if (enterFromOther == null) {
      enterFromOther = !truthy(E._prevGrass);
    }
    // pret TryStandardWildEncounter consults the cooldown before the rate test.
    const area = area_for(mapId, terrain);
    if (!R.handleCooldown(terrain, area && area.rate)) return undefined;
    let enc: any;
    if (terrain === "water") {
      enc = R.rollWater(mapId, enterFromOther);
    } else {
      enc = R.rollLand(mapId, undefined, enterFromOther);
    }
    // pret sets stepsSinceLastEncounter = 0 once an encounter actually starts.
    if (truthy(enc)) R.resetRateModifiers();
    return enc;
  }

  R.step = vanilla_step;
  return R;
}

export const EncounterRulesFrlg = { bind };

// encounters.lua's require("src.core.game3.encounter_rules." .. family):
// register with the loader's late-bind table so Encounters.rules() finds the
// "frlg" family (core/encounters.ts reads deps.rules[family].bind(E, H)).
// This is the only top-level use of another module here.
(EncountersModule.deps.rules ??= {}).frlg = EncounterRulesFrlg;

export default EncounterRulesFrlg;
