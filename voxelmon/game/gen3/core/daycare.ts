// Port of gen1recomp src/core/game3/daycare.lua (GPLv3 + additional terms; see LICENSE.md).
// pokefirered/src/daycare.c:370 -- the Day Care (two slots, steps, egg
// timer) and the Route 5 day care, kept in session.modData[<saveKey>] and
// serialized by save_schema_firered in Brian's shape: the day care table holds
// its mons at dc[1] / dc[2], plus `steps` (a sequence `[null, s1, s2]`),
// `stepCounter`, `mail` (a sequence), `offspringPersonality`, `eggPending`.
//
// package.loaded["src.core.game3.runtime" / ".breeding"]: every module is in
// the bundle, so they are imported directly. The RSE paths (saveKey,
// eggCyclesToSubtract) are ported as written; under the FRLG profiles isRse is
// always false.

import { tonumber, tostring } from "../../../import/gen3/lua.ts";
import { ipairs, len, pairs, remove, seq } from "../platform/lt.ts";
import { Profile } from "./profile.ts";
import { Constants } from "./constants.ts";
import RuntimeMod from "./runtime.ts";
import PokemonMod from "./pokemon.ts";
import ExperienceMod from "./battle/experience.ts";
import MailMod from "./mail.ts";
import BreedingMod from "./breeding.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

const SPECIES_NONE = 0; // pokefirered/include/constants/species.h:4
const PARTY_SIZE = 6; // pokefirered/include/constants/global.h:78
const MAX_LEVEL = 100; // pokefirered/include/constants/pokemon.h:187
const MAX_MON_MOVES = 4; // pokefirered/include/constants/global.h:77
const DAYCARE_MON_COUNT = 2; // pokefirered/include/constants/global.h:34

// Loose views of sibling modules (stubbed or being ported); read at call time.
const Experience = (): any => ExperienceMod;

function isTable(v: unknown): v is Record<string, any> {
  return v !== null && typeof v === "object";
}

// Lua: daycare.lua:16
function sessionOf(session: any): any {
  if (session) return session;
  const rt: any = RuntimeMod;
  return (rt && rt.getSession && rt.getSession()) || undefined;
}

// Lua: daycare.lua:23
function speciesOf(mon: any): number {
  return tonumber(mon ? (mon.species ?? mon.speciesId) : undefined) ?? 0;
}

// Lua: daycare.lua:28
function pokemonMod(): any {
  const Pokemon: any = PokemonMod;
  if (!Pokemon._names) { try { Pokemon.install(null); } catch { /* pcall */ } }
  return Pokemon;
}

// Lua: daycare.lua:42 -- [isRse, profileRow]
function isRse(session: any): [boolean, any] {
  let ok: boolean, row: any;
  try { row = Profile.forSession(session); ok = true; } catch (e) { ok = false; row = e; }
  return [ok && isTable(row) && row.family === "rse", row];
}

// Lua: daycare.lua:53
function persistentStore(session: any, field: string): any {
  if (!isTable(session.modData)) session.modData = {};
  const key = Daycare.saveKey(session);
  let root = session.modData[key];
  if (!isTable(root)) {
    root = {};
    session.modData[key] = root;
  }
  let store = root[field];
  if (!isTable(store)) {
    store = {};
    root[field] = store;
  }
  // rawget(session, field): own property only (the egg scratch session
  // inherits from the real one through __index)
  const loose = Object.prototype.hasOwnProperty.call(session, field) ? session[field] : undefined;
  if (isTable(loose) && loose !== store) {
    if (Array.isArray(store)) store.length = 0;
    else for (const k of Object.keys(store)) delete store[k];
    for (const [k, v] of pairs(loose)) store[k] = v;
  }
  session[field] = store;
  return store;
}

// Lua: daycare.lua:131
function growthOf(mon: any): any {
  return Experience().growthRate(mon);
}

// Lua: daycare.lua:136
function expOf(mon: any): number {
  const growth = growthOf(mon);
  return tonumber(mon ? mon.exp : undefined)
    ?? Experience().expForLevel(growth, tonumber(mon ? mon.level : undefined) ?? 1);
}

// Lua: daycare.lua:341
// pokefirered/src/daycare.c:1168 MON_DATA_FRIENDSHIP
function eggCyclesOf(mon: any): number {
  return tonumber(mon.friendship ?? mon.eggCycles ?? mon.cycles) ?? 20;
}

// Lua: daycare.lua:345
function isEgg(mon: any): boolean {
  return (mon.isEgg === true) || (typeof mon.egg === "boolean" && mon.egg);
}

export const Daycare = {
  SAVE_KEY: "firered_daycare",
  DAYCARE_MON_COUNT,
  PARTY_SIZE,
  MAX_LEVEL,

  sessionOf,
  speciesOf,

  // Lua: daycare.lua:35
  // pokefirered/src/daycare.c:362 DayCare_GetBoxMonNickname
  nickname(mon: any): string {
    if (!mon) return "";
    if (mon.nickname != null && mon.nickname !== "") return tostring(mon.nickname);
    const Pokemon = pokemonMod();
    return (Pokemon.name && Pokemon.name(speciesOf(mon))) || "";
  },

  // Lua: daycare.lua:47
  saveKey(session: any): string {
    const [rse, row] = isRse(session);
    if (rse) return tostring(row.id) + "_daycare";
    return Daycare.SAVE_KEY;
  },

  // Lua: daycare.lua:76
  // pokefirered/include/global.h:549 struct DayCare
  stateOf(sessionIn?: any): any {
    const session = sessionOf(sessionIn);
    if (!session) return undefined;
    const dc = persistentStore(session, "daycare");
    if (!isTable(dc.steps)) dc.steps = seq(0, 0);
    dc.stepCounter = tonumber(dc.stepCounter) ?? 0;
    return dc;
  },

  // Lua: daycare.lua:86
  // pokefirered/src/daycare.c:1563 gSaveBlock1Ptr->route5DayCareMon
  route5Of(sessionIn?: any): any {
    const session = sessionOf(sessionIn);
    if (!session) return undefined;
    const r5 = persistentStore(session, "route5Daycare");
    r5.steps = tonumber(r5.steps) ?? 0;
    return r5;
  },

  // Lua: daycare.lua:94
  mon(dc: any, index: number): any {
    if (!dc) return undefined;
    return dc[index] || (dc.mons && dc.mons[index]) || undefined;
  },

  // Lua: daycare.lua:99
  setMon(dc: any, index: number, mon: any): void {
    if (mon == null) delete dc[index]; else dc[index] = mon;
    if (dc.mons) dc.mons[index] = mon ?? null;
  },

  // Lua: daycare.lua:108
  // pokefirered/src/daycare.c:370 CountPokemonInDaycare
  count(dc: any): number {
    let n = 0;
    for (let i = 1; i <= DAYCARE_MON_COUNT; i++) {
      if (speciesOf(Daycare.mon(dc, i)) !== SPECIES_NONE) n = n + 1;
    }
    return n;
  },

  // Lua: daycare.lua:117
  // pokefirered/src/daycare.c:412 Daycare_FindEmptySpot
  findEmptySpot(dc: any): number | undefined {
    for (let i = 1; i <= DAYCARE_MON_COUNT; i++) {
      if (speciesOf(Daycare.mon(dc, i)) === SPECIES_NONE) return i;
    }
    return undefined;
  },

  // Lua: daycare.lua:125
  // pokefirered/src/daycare.c:1192 IsEggPending
  isEggPending(dc: any): boolean {
    if (!dc) return false;
    if (dc.eggPending) return true;
    return (tonumber(dc.offspringPersonality) ?? 0) !== 0;
  },

  // Lua: daycare.lua:143
  // pokefirered/src/daycare.c:551 GetLevelAfterDaycareSteps
  levelAfterSteps(mon: any, steps: unknown): number {
    if (!mon) return 0;
    return Experience().levelForExp(growthOf(mon), expOf(mon) + (tonumber(steps) ?? 0));
  },

  // Lua: daycare.lua:150
  // pokefirered/src/daycare.c:560 GetNumLevelsGainedFromSteps
  levelsGained(mon: any, steps: unknown): number {
    if (!mon) return 0;
    const before = Experience().levelForExp(growthOf(mon), expOf(mon));
    return Daycare.levelAfterSteps(mon, steps) - before;
  },

  // Lua: daycare.lua:158
  // pokefirered/src/daycare.c:578 GetDaycareCostForSelectedMon
  cost(mon: any, steps: unknown): number {
    return 100 + 100 * Daycare.levelsGained(mon, steps);
  },

  // Lua: daycare.lua:163
  // pokefirered/src/pokemon.c:2288 MonTryLearningNewMove
  teachMove(mon: any, moveIdIn: unknown): boolean {
    const moveId = tonumber(moveIdIn) ?? 0;
    if (!(mon && moveId > 0)) return false;
    mon.moves = mon.moves ?? seq();
    mon.pp = mon.pp ?? seq();
    mon.maxPp = mon.maxPp ?? seq();
    const n = len(mon.moves);
    for (let i = 1; i <= n; i++) {
      if (mon.moves[i] === moveId) return false;
    }
    const Pokemon = pokemonMod();
    let maxPp = 0;
    if (Pokemon.movePp) maxPp = tonumber(Pokemon.movePp(moveId)) ?? 0;
    if (len(mon.moves) < MAX_MON_MOVES) {
      mon.moves[len(mon.moves) + 1] = moveId;
      mon.pp[len(mon.moves)] = maxPp;
      mon.maxPp[len(mon.moves)] = maxPp;
      return true;
    }
    // pokefirered/src/daycare.c:495 DeleteFirstMoveAndGiveMoveToMon
    remove(mon.moves, 1);
    remove(mon.pp, 1);
    remove(mon.maxPp, 1);
    mon.moves[MAX_MON_MOVES] = moveId;
    mon.pp[MAX_MON_MOVES] = maxPp;
    mon.maxPp[MAX_MON_MOVES] = maxPp;
    return true;
  },

  // Lua: daycare.lua:192
  // pokefirered/src/daycare.c:478 ApplyDaycareExperience
  applyExperience(mon: any, steps: unknown): number {
    if (!mon) return 0;
    const Pokemon = pokemonMod();
    const from = tonumber(mon.level) ?? 1;
    if (from >= MAX_LEVEL) return 0;
    const res = Experience().apply(mon, steps);
    const to = tonumber(res ? res.toLevel : undefined) ?? from;
    // pokefirered/src/daycare.c:491 MonTryLearningNewMove
    for (let level = from + 1; level <= to; level++) {
      for (const [, moveId] of ipairs(Pokemon.movesLearnedAt(speciesOf(mon), level) ?? seq())) {
        Daycare.teachMove(mon, moveId);
      }
    }
    // pokefirered/src/daycare.c:505 CalculateMonStats
    Pokemon.applyStats(mon);
    return to - from;
  },

  // Lua: daycare.lua:212
  // pokefirered/src/pokemon_storage_system_data.c:904 CompactPartySlots
  compactParty(session: any): void {
    const party = session ? session.party : undefined;
    if (!isTable(party)) return;
    const out: any = seq();
    for (let i = 1; i <= PARTY_SIZE; i++) {
      if (party[i] && speciesOf(party[i]) !== SPECIES_NONE) out[len(out) + 1] = party[i];
    }
    for (let i = 1; i <= PARTY_SIZE; i++) party[i] = out[i] ?? null;
  },

  // Lua: daycare.lua:223 -- [mon, storedMail]
  // pokefirered/src/daycare.c:425 StorePokemonInDaycare
  boxify(session: any, mon: any): [any, any] {
    if (!mon) return [mon, undefined];
    let stored: any = undefined;
    if (session) {
      // pokefirered/src/daycare.c:427
      stored = MailMod.takeMonMailForDaycare(session, mon,
        tostring(session.name ?? session.playerName ?? ""), Daycare.nickname(mon));
    }
    delete mon.status;
    // pokefirered/src/pokemon.c:5998 BoxMonRestorePP
    if (isTable(mon.pp) && isTable(mon.maxPp)) {
      const n = len(mon.pp);
      for (let i = 1; i <= n; i++) mon.pp[i] = mon.maxPp[i] ?? mon.pp[i];
    }
    return [mon, stored];
  },

  // Lua: daycare.lua:240
  // pokefirered/src/daycare.c:449 StorePokemonInEmptyDaycareSlot
  deposit(sessionIn: any, partySlot: number): number | undefined {
    const session = sessionOf(sessionIn);
    const dc = Daycare.stateOf(session);
    if (!(session && dc)) return undefined;
    const mon = session.party && session.party[partySlot];
    if (!mon || partySlot < 1 || partySlot > PARTY_SIZE) return undefined;
    const free = Daycare.findEmptySpot(dc);
    if (free == null) return undefined;
    const [stored, storedMail] = Daycare.boxify(session, mon);
    Daycare.setMon(dc, free, stored);
    dc.mail = dc.mail ?? seq();
    dc.mail[free] = storedMail ?? null;
    dc.steps[free] = 0;
    session.party[partySlot] = null;
    Daycare.compactParty(session);
    return free;
  },

  // Lua: daycare.lua:259
  // pokefirered/src/daycare.c:1563 PutMonInRoute5Daycare
  depositRoute5(sessionIn: any, partySlot: number): boolean {
    const session = sessionOf(sessionIn);
    const r5 = Daycare.route5Of(session);
    if (!(session && r5) || r5.mon) return false;
    const mon = session.party && session.party[partySlot];
    if (!mon || partySlot < 1 || partySlot > PARTY_SIZE) return false;
    const [stored, storedMail] = Daycare.boxify(session, mon);
    r5.mon = stored;
    if (storedMail == null) delete r5.mail; else r5.mail = storedMail;
    r5.steps = 0;
    session.party[partySlot] = null;
    Daycare.compactParty(session);
    return true;
  },

  // Lua: daycare.lua:275
  // pokefirered/src/daycare.c:508 TakeSelectedPokemonFromDaycare
  withdraw(sessionIn: any, mon: any, steps: unknown, stored: any): number {
    const session = sessionOf(sessionIn);
    if (!(session && mon)) return SPECIES_NONE;
    const Pokemon = pokemonMod();
    const species = speciesOf(mon);
    // pokefirered/src/pokemon.c:2172 BoxMonToMon
    delete mon.status;
    delete mon.hp;
    Pokemon.applyStats(mon);
    if ((tonumber(mon.level) ?? 1) !== MAX_LEVEL) {
      Daycare.applyExperience(mon, steps);
    }
    session.party = session.party ?? seq();
    // pokefirered/src/daycare.c:525 gPlayerParty[PARTY_SIZE - 1] = pokemon
    session.party[PARTY_SIZE] = mon;
    // pokefirered/src/daycare.c:526
    if (stored) {
      MailMod.giveDaycareMailToMon(session, mon, stored);
    }
    Daycare.compactParty(session);
    return species;
  },

  // Lua: daycare.lua:299
  // pokefirered/src/daycare.c:462 ShiftDaycareSlots
  shiftSlots(dc: any): void {
    if (Daycare.mon(dc, 2) && !Daycare.mon(dc, 1)) {
      Daycare.setMon(dc, 1, Daycare.mon(dc, 2));
      Daycare.setMon(dc, 2, undefined);
      dc.steps[1] = dc.steps[2] ?? 0;
      dc.steps[2] = 0;
      // pokefirered/src/daycare.c:471 daycare->mons[0].mail = daycare->mons[1].mail
      dc.mail = dc.mail ?? seq();
      dc.mail[1] = dc.mail[2] ?? null;
      dc.mail[2] = null;
    }
  },

  // Lua: daycare.lua:313
  // pokefirered/src/daycare.c:539 TakeSelectedPokemonMonFromDaycareShiftSlots
  take(sessionIn: any, index: number): number {
    const session = sessionOf(sessionIn);
    const dc = Daycare.stateOf(session);
    const mon = Daycare.mon(dc, index);
    if (!mon) return SPECIES_NONE;
    dc.mail = dc.mail ?? seq();
    const species = Daycare.withdraw(session, mon, dc.steps[index], dc.mail[index]);
    Daycare.setMon(dc, index, undefined);
    dc.mail[index] = null;
    dc.steps[index] = 0;
    Daycare.shiftSlots(dc);
    return species;
  },

  // Lua: daycare.lua:328
  // pokefirered/src/daycare.c:1588 TakePokemonFromRoute5Daycare
  takeRoute5(sessionIn?: any): number {
    const session = sessionOf(sessionIn);
    const r5 = Daycare.route5Of(session);
    const mon = r5 && r5.mon;
    if (!mon) return SPECIES_NONE;
    const species = Daycare.withdraw(session, mon, r5.steps, r5.mail);
    delete r5.mon;
    delete r5.mail;
    r5.steps = 0;
    return species;
  },

  // Lua: daycare.lua:351
  // pokefirered/src/daycare.c:1157
  // pokeemerald/src/egg_hatch.c:926 GetEggCyclesToSubtract
  eggCyclesToSubtract(session: any): number {
    const C = Constants.of(Constants.versionOf(session));
    const magma = C.require("abilities", "ABILITY_MAGMA_ARMOR");
    const flame = C.require("abilities", "ABILITY_FLAME_BODY");
    const Pokemon = pokemonMod();
    for (let i = 1; i <= PARTY_SIZE; i++) {
      const mon = session && session.party && session.party[i];
      if (mon && speciesOf(mon) !== SPECIES_NONE && !isEgg(mon)) {
        let ability = tonumber(mon.abilityId ?? mon.ability);
        if (ability == null && Pokemon.abilityId) ability = Pokemon.abilityId(speciesOf(mon), mon.personality);
        if (ability === magma || ability === flame) return 2;
      }
    }
    return 1;
  },

  // Lua: daycare.lua:368
  tickEggCycles(session: any): number | undefined {
    const party = session ? session.party : undefined;
    if (!isTable(party)) return undefined;
    const toSub = isRse(session)[0] ? Daycare.eggCyclesToSubtract(session) : undefined;
    for (let slotIdx = 1; slotIdx <= PARTY_SIZE; slotIdx++) {
      const mon = party[slotIdx];
      // pokefirered/src/daycare.c:1161
      if (mon && isEgg(mon) && !mon.isBadEgg) {
        let cycles = eggCyclesOf(mon);
        if (cycles !== 0) {
          // pokefirered/src/daycare.c:1171 steps -= 1
          if (toSub != null && cycles >= toSub) {
            // pokeemerald/src/daycare.c:913
            cycles = cycles - toSub;
          } else {
            cycles = cycles - 1;
          }
          mon.friendship = cycles;
          mon.eggCycles = cycles;
        } else {
          // pokefirered/src/daycare.c:1176 gSpecialVar_0x8004 = i
          return slotIdx;
        }
      }
    }
    return undefined;
  },

  // Lua: daycare.lua:397 -- [validEggs, hatchSlot]
  // pokefirered/src/daycare.c:1185 ShouldEggHatch
  step(sessionIn?: any): [number, number?] {
    const session = sessionOf(sessionIn);
    if (!session) return [0];
    const r5 = Daycare.route5Of(session);
    if (r5 && speciesOf(r5.mon) !== SPECIES_NONE) {
      r5.steps = r5.steps + 1;
    }
    const dc = Daycare.stateOf(session);
    if (!dc) return [0];
    // pokefirered/src/daycare.c:1142
    let validEggs = 0;
    for (let i = 1; i <= DAYCARE_MON_COUNT; i++) {
      if (speciesOf(Daycare.mon(dc, i)) !== SPECIES_NONE) {
        dc.steps[i] = (tonumber(dc.steps[i]) ?? 0) + 1;
        validEggs = validEggs + 1;
      }
    }
    // pokefirered/src/daycare.c:1148
    BreedingMod.tryProduceEgg(session, dc, validEggs);
    // pokefirered/src/daycare.c:1157 ++daycare->stepCounter == 255
    dc.stepCounter = (dc.stepCounter + 1) % 256;
    let hatchSlot: number | undefined = undefined;
    if (dc.stepCounter === 255) {
      hatchSlot = Daycare.tickEggCycles(session);
    }
    return [validEggs, hatchSlot];
  },
};

export default Daycare;
