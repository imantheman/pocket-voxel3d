// Port of gen1recomp src/core/game3/breeding.lua (GPLv3 + additional terms; see LICENSE.md).
// pokefirered/src/daycare.c:1271 -- compatibility, egg species, egg creation,
// IV inheritance, egg movesets, hatching.
//
// package.loaded["src.core.game3.runtime" / ".daycare" / ".scripting.space"]:
// every module is in the bundle, so they are imported directly. The RSE
// (Emerald) paths -- parentToInheritNature, rsePersonality,
// giveVoltTackleIfLightBall and the isRse branches -- are ported as written;
// under the FRLG profiles isRse is always false, so they never run here.

import { mod, tonumber } from "../../../import/gen3/lua.ts";
import { ipairs, len, pairs, remove, seq, sort } from "../platform/lt.ts";
import { Profile } from "./profile.ts";
import { Constants } from "./constants.ts";
import { Rng } from "./rng.ts";
import RuntimeMod from "./runtime.ts";
import PokemonMod from "./pokemon.ts";
import DaycareMod from "./daycare.ts";
import ItemsDataMod from "./items_data.ts";
import SpaceMod from "./scripting/space.ts";
import FlagsMod from "./scripting/flags.ts";
import PartyMod from "./party.ts";
import DexMod from "./dex.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

const SPECIES_NONE = 0; // pokefirered/include/constants/species.h:4
const SPECIES_NIDORAN_F = 29; // pokefirered/include/constants/species.h:33
const SPECIES_NIDORAN_M = 32; // pokefirered/include/constants/species.h:36
const SPECIES_DITTO = 132; // pokefirered/include/constants/species.h:136
const SPECIES_MARILL = 183; // pokefirered/include/constants/species.h:190
const SPECIES_WOBBUFFET = 202; // pokefirered/include/constants/species.h:209
const SPECIES_AZURILL = 350; // pokefirered/include/constants/species.h:359
const SPECIES_WYNAUT = 360; // pokefirered/include/constants/species.h:369
const SPECIES_VOLBEAT = 386; // pokefirered/include/constants/species.h:395
const SPECIES_ILLUMISE = 387; // pokefirered/include/constants/species.h:396

const ITEM_POKE_BALL = 4; // pokefirered/include/constants/items.h:8
const ITEM_SEA_INCENSE = 220; // pokefirered/include/constants/items.h:231
const ITEM_LAX_INCENSE = 221; // pokefirered/include/constants/items.h:232
const ITEM_TM01 = 289; // pokefirered/include/constants/items.h:300
// pokefirered/include/constants/items.h:453 NUM_TECHNICAL_MACHINES + NUM_HIDDEN_MACHINES
const NUM_MACHINES = 58;

// pokefirered/include/constants/daycare.h:5
const PARENTS_INCOMPATIBLE = 0;
const PARENTS_LOW_COMPATIBILITY = 20;
const PARENTS_MED_COMPATIBILITY = 50;
const PARENTS_MAX_COMPATIBILITY = 70;

const INHERITED_IV_COUNT = 3; // pokefirered/include/constants/daycare.h:16
const EGG_HATCH_LEVEL = 5; // pokefirered/include/constants/daycare.h:17
const EGG_GENDER_MALE = 0x8000; // pokefirered/include/constants/daycare.h:18

const EGG_GROUP_DITTO = 13; // pokefirered/include/constants/pokemon.h:131
const EGG_GROUP_UNDISCOVERED = 15; // pokefirered/include/constants/pokemon.h:133
const EGG_GROUPS_PER_MON = 2; // pokefirered/include/constants/pokemon.h:135
const NUM_STATS = 6; // pokefirered/include/constants/pokemon.h:172
const EVOS_PER_MON = 5; // pokefirered/include/constants/pokemon.h:282

const DAYCARE_MON_COUNT = 2; // pokefirered/include/constants/global.h:34
const MAX_MON_MOVES = 4; // pokefirered/include/constants/global.h:77
const PARTY_SIZE = 6; // pokefirered/include/constants/global.h:78
const USHRT_MAX = 65535;
const FLAG_PENDING_DAYCARE_EGG = 0x266; // pokefirered/include/constants/flags.h:639

// pokefirered/src/daycare.c:822 selectedIvs order
const IV_KEYS = seq("hp", "atk", "def", "spe", "spa", "spd");

function isTable(v: unknown): v is Record<string, any> {
  return v !== null && typeof v === "object";
}

// Lua: breeding.lua:58
function daycareMod(): any {
  return DaycareMod;
}

// Lua: breeding.lua:62
function pokemonMod(): any {
  const Pokemon: any = PokemonMod;
  if (!Pokemon._names) { try { Pokemon.install(null); } catch { /* pcall */ } }
  return Pokemon;
}

// Lua: breeding.lua:68
function rngMod(): typeof Rng {
  return Rng;
}

// Lua: breeding.lua:72
function liveSession(session: any): any {
  if (session) return session;
  const rt: any = RuntimeMod;
  return (rt && rt.getSession && rt.getSession()) || undefined;
}

// Lua: breeding.lua:85
function constantOf(session: any, kind: string, name: string): any {
  return Constants.of(Constants.versionOf(liveSession(session))).require(kind, name);
}

// Lua: breeding.lua:96
function speciesOf(mon: any): number {
  return tonumber(mon ? (mon.species ?? mon.speciesId) : undefined) ?? SPECIES_NONE;
}

// Lua: breeding.lua:100
function heldItemOf(mon: any): number {
  const raw = mon ? (mon.item ?? mon.heldItem) : undefined;
  if (raw == null) return 0;
  return tonumber(raw) ?? tonumber((ItemsDataMod as any).toNumericId(raw)) ?? 0;
}

// Lua: breeding.lua:107
function scriptStore(session: any): any {
  const Space: any = SpaceMod;
  if (Space && Space.store) return Space.store;
  return (session && session.store) || undefined;
}

// Lua: breeding.lua:113
function movesOf(mon: any): (number | null)[] {
  const out = seq<number>();
  for (let i = 1; i <= MAX_MON_MOVES; i++) {
    let raw = mon && mon.moves && mon.moves[i];
    if (isTable(raw)) raw = raw.id ?? raw.move;
    out[i] = tonumber(raw) ?? 0;
  }
  return out;
}

// Lua: breeding.lua:176 (both start nil: with no _evolutions table yet, the
// Lua indexes a nil preEvoOf and errors; so does this)
let preEvoOf: Record<number, number> | undefined = undefined;
let preEvoSource: any = undefined;
// Lua: breeding.lua:177
function preEvolution(species: number): number | undefined {
  const Pokemon = pokemonMod();
  const table_ = Pokemon._evolutions;
  if (!(preEvoSource == null && table_ == null) && preEvoSource !== table_) {
    preEvoOf = {};
    const keys: any = seq();
    for (const [key] of pairs(table_ ?? {})) {
      const num = tonumber(key);
      if (num != null) keys[len(keys) + 1] = num;
    }
    sort<number>(keys);
    for (const [, from] of ipairs<number>(keys)) {
      for (const [, row] of ipairs<any>(table_[from] ?? seq())) {
        const target = tonumber(row.target ?? row[3]) ?? 0;
        if (target > 0 && preEvoOf[target] == null) preEvoOf[target] = from;
      }
    }
    preEvoSource = table_;
  }
  return (preEvoOf as Record<number, number>)[species];
}

// Lua: breeding.lua:473
function buildEggMon(session: any, species: number, personality: number): any {
  const Pokemon = pokemonMod();
  const Party: any = PartyMod;
  // pokefirered/src/daycare.c:1657 GetSetPokedexFlag
  const scratch: any = Object.create(isTable(session) ? session : null);
  scratch.party = seq();
  scratch.dex = { seen: {}, owned: {} };
  const [ok, , egg] = Party.giveMon(scratch, species, EGG_HATCH_LEVEL, "EGG");
  if (!(ok && egg)) return undefined;
  egg.personality = personality;
  egg.nature = Pokemon.natureId(personality);
  egg.gender = Pokemon.gender(species, personality);
  egg.ability = Pokemon.abilityId(species, personality);
  egg.abilityId = egg.ability;
  Breeding.applyEggData(egg);
  Pokemon.applyStats(egg);
  return egg;
}

export const Breeding = {
  PARENTS_INCOMPATIBLE,
  PARENTS_LOW_COMPATIBILITY,
  PARENTS_MED_COMPATIBILITY,
  PARENTS_MAX_COMPATIBILITY,
  EGG_HATCH_LEVEL,
  EGG_GENDER_MALE,
  INHERITED_IV_COUNT,
  FLAG_PENDING_DAYCARE_EGG,
  IV_KEYS,

  constantOf,

  // Lua: breeding.lua:78
  isRse(session?: any): boolean {
    let ok: boolean, row: any;
    try { row = Profile.forSession(liveSession(session)); ok = true; } catch { ok = false; }
    return ok && isTable(row) && row.family === "rse";
  },

  // Lua: breeding.lua:91
  pendingEggFlag(session?: any): any {
    if (Breeding.isRse(session)) return constantOf(session, "flags", "FLAG_PENDING_DAYCARE_EGG");
    return FLAG_PENDING_DAYCARE_EGG;
  },

  // Lua: breeding.lua:124
  // pokefirered/src/daycare.c:1287 gSpeciesInfo[species].eggGroups
  eggGroups(species: unknown): (number | null)[] {
    const Pokemon = pokemonMod();
    const meta = (Pokemon.speciesMeta && Pokemon.speciesMeta(species)) || {};
    return seq(
      tonumber(meta.eggGroup1) ?? EGG_GROUP_UNDISCOVERED,
      tonumber(meta.eggGroup2) ?? EGG_GROUP_UNDISCOVERED,
    );
  },

  // Lua: breeding.lua:134
  // pokefirered/src/daycare.c:1255 EggGroupsOverlap
  eggGroupsOverlap(a: any, b: any): boolean {
    for (let i = 1; i <= EGG_GROUPS_PER_MON; i++) {
      for (let j = 1; j <= EGG_GROUPS_PER_MON; j++) {
        if (a[i] === b[j]) return true;
      }
    }
    return false;
  },

  // Lua: breeding.lua:144
  // pokefirered/src/daycare.c:1271 GetDaycareCompatibilityScore
  compatibility(dc: any): number {
    const Daycare = daycareMod();
    const Pokemon = pokemonMod();
    const groups: any = seq(), species: any = seq(), ids: any = seq(), genders: any = seq();
    for (let i = 1; i <= DAYCARE_MON_COUNT; i++) {
      const mon = Daycare.mon(dc, i);
      species[i] = speciesOf(mon);
      ids[i] = tonumber(mon ? (mon.otId ?? mon.ot_id) : undefined) ?? 0;
      genders[i] = (mon && Pokemon.gender && Pokemon.gender(species[i], mon.personality)) || "U";
      groups[i] = Breeding.eggGroups(species[i]);
    }
    if (groups[1][1] === EGG_GROUP_UNDISCOVERED || groups[2][1] === EGG_GROUP_UNDISCOVERED) {
      return PARENTS_INCOMPATIBLE;
    }
    if (groups[1][1] === EGG_GROUP_DITTO && groups[2][1] === EGG_GROUP_DITTO) {
      return PARENTS_INCOMPATIBLE;
    }
    if (groups[1][1] === EGG_GROUP_DITTO || groups[2][1] === EGG_GROUP_DITTO) {
      if (ids[1] === ids[2]) return PARENTS_LOW_COMPATIBILITY;
      return PARENTS_MED_COMPATIBILITY;
    }
    if (genders[1] === genders[2]) return PARENTS_INCOMPATIBLE;
    if (genders[1] === "U" || genders[2] === "U") return PARENTS_INCOMPATIBLE;
    if (!Breeding.eggGroupsOverlap(groups[1], groups[2])) return PARENTS_INCOMPATIBLE;
    if (species[1] === species[2]) {
      if (ids[1] === ids[2]) return PARENTS_MED_COMPATIBILITY;
      return PARENTS_MAX_COMPATIBILITY;
    }
    if (ids[1] !== ids[2]) return PARENTS_MED_COMPATIBILITY;
    return PARENTS_LOW_COMPATIBILITY;
  },

  // Lua: breeding.lua:200
  // pokefirered/src/daycare.c:647 GetEggSpecies
  eggSpecies(speciesIn: unknown): number {
    let species = tonumber(speciesIn) ?? SPECIES_NONE;
    for (let n = 1; n <= EVOS_PER_MON; n++) {
      const from = preEvolution(species);
      if (from == null) break;
      species = from;
    }
    return species;
  },

  // Lua: breeding.lua:211
  // pokefirered/src/daycare.c:721 _TriggerPendingDaycareEgg
  triggerPendingEgg(sessionIn: any, dcIn?: any): number {
    const Daycare = daycareMod();
    const session = Daycare.sessionOf(sessionIn);
    const dc = dcIn ?? Daycare.stateOf(session);
    if (!dc) return 0;
    const R = rngMod();
    if (Breeding.isRse(session)) {
      dc.offspringPersonality = Breeding.rsePersonality(session, dc);
    } else {
      dc.offspringPersonality = mod(R.Random(), 0xFFFE) + 1;
    }
    dc.eggPending = true;
    // pokefirered/src/daycare.c:751 FlagSet(FLAG_PENDING_DAYCARE_EGG)
    const store = scriptStore(session);
    if (store) {
      (FlagsMod as any).setFlag(store, null, Breeding.pendingEggFlag(session), true);
    }
    return dc.offspringPersonality;
  },

  // Lua: breeding.lua:232
  // pokeemerald/src/daycare.c:414 GetParentToInheritNature
  parentToInheritNature(session: any, dc: any): number | undefined {
    const Daycare = daycareMod();
    const Pokemon = pokemonMod();
    const R = rngMod();
    let parent: number | undefined;
    for (let i = 1; i <= DAYCARE_MON_COUNT; i++) {
      const mon = Daycare.mon(dc, i);
      if (mon && Pokemon.gender(speciesOf(mon), mon.personality) === "F") parent = i;
    }
    let dittos = 0;
    for (let i = 1; i <= DAYCARE_MON_COUNT; i++) {
      if (speciesOf(Daycare.mon(dc, i)) === SPECIES_DITTO) {
        dittos = dittos + 1;
        parent = i;
      }
    }
    if (dittos === DAYCARE_MON_COUNT) {
      parent = (R.Random() >= Math.floor(USHRT_MAX / 2)) ? 1 : 2;
    }
    if (parent == null) return undefined;
    // pokeemerald/src/daycare.c:446
    if (heldItemOf(Daycare.mon(dc, parent)) !== constantOf(session, "items", "ITEM_EVERSTONE")
      || R.Random() >= Math.floor(USHRT_MAX / 2)) {
      return undefined;
    }
    return parent;
  },

  // Lua: breeding.lua:261
  // pokeemerald/src/daycare.c:455 _TriggerPendingDaycareEgg
  rsePersonality(session: any, dc: any): number {
    const Daycare = daycareMod();
    const Pokemon = pokemonMod();
    const R = rngMod();
    const rt: any = RuntimeMod;
    R.SeedRng2(tonumber(rt ? rt._vblankCounter : undefined) ?? 0);
    const parent = Breeding.parentToInheritNature(session, dc);
    if (parent == null) {
      return mod(R.Random2() * 0x10000 + mod(R.Random(), 0xFFFE) + 1, 0x100000000);
    }
    const want = Pokemon.natureId(tonumber(Daycare.mon(dc, parent).personality) ?? 0);
    let personality = 0, tries = 0;
    do {
      personality = R.Random2() * 0x10000 + R.Random();
      if (want === Pokemon.natureId(personality) && personality !== 0) break;
      tries = tries + 1;
    } while (!(tries > 2400));
    return personality;
  },

  // Lua: breeding.lua:282
  // pokefirered/src/daycare.c:1148
  tryProduceEgg(session: any, dc: any, validEggs: unknown): boolean {
    const Daycare = daycareMod();
    if (!dc) return false;
    if (Daycare.isEggPending(dc)) return false;
    if ((tonumber(validEggs) ?? 0) !== DAYCARE_MON_COUNT) return false;
    // pokefirered/src/daycare.c:1149 (daycare->mons[1].steps & 0xFF) == 0xFF
    if (mod(tonumber(dc.steps ? dc.steps[2] : undefined) ?? 0, 256) !== 255) return false;
    const R = rngMod();
    // pokefirered/src/daycare.c:1152
    if (Breeding.compatibility(dc) > Math.floor(R.Random() * 100 / USHRT_MAX)) {
      Breeding.triggerPendingEgg(session, dc);
      return true;
    }
    return false;
  },

  // Lua: breeding.lua:299
  // pokefirered/src/daycare.c:976 RemoveEggFromDayCare
  removeEgg(dc: any): void {
    if (!dc) return;
    dc.offspringPersonality = 0;
    dc.stepCounter = 0;
    dc.eggPending = false;
  },

  // Lua: breeding.lua:307 -- [eggSpecies, mother, father]
  // pokefirered/src/daycare.c:1018 DetermineEggSpeciesAndParentSlots
  parentSlots(dc: any): [number, number, number] {
    const Daycare = daycareMod();
    const Pokemon = pokemonMod();
    const species: any = seq();
    let mother = 1, father = 2;
    for (let i = 1; i <= DAYCARE_MON_COUNT; i++) {
      const mon = Daycare.mon(dc, i);
      species[i] = speciesOf(mon);
      const other = (i === 1) ? 2 : 1;
      if (species[i] === SPECIES_DITTO) {
        [mother, father] = [other, i];
      } else if (mon && Pokemon.gender(species[i], mon.personality) === "F") {
        [mother, father] = [i, other];
      }
    }
    let eggSpecies = Breeding.eggSpecies(species[mother]);
    const male = mod(tonumber(dc ? dc.offspringPersonality : undefined) ?? 0, 0x10000) >= EGG_GENDER_MALE;
    if (eggSpecies === SPECIES_NIDORAN_F && male) eggSpecies = SPECIES_NIDORAN_M;
    if (eggSpecies === SPECIES_ILLUMISE && male) eggSpecies = SPECIES_VOLBEAT;
    // pokefirered/src/daycare.c:1053
    const motherMon = Daycare.mon(dc, mother);
    if (species[father] === SPECIES_DITTO
      && !(motherMon && Pokemon.gender(species[mother], motherMon.personality) === "F")) {
      [mother, father] = [father, mother];
    }
    return [eggSpecies, mother, father];
  },

  // Lua: breeding.lua:335
  // pokefirered/src/daycare.c:987 AlterEggSpeciesWithIncenseItem
  alterEggSpeciesWithIncenseItem(species: number, dc: any): number {
    const Daycare = daycareMod();
    if (species !== SPECIES_WYNAUT && species !== SPECIES_AZURILL) return species;
    const motherItem = heldItemOf(Daycare.mon(dc, 1));
    const fatherItem = heldItemOf(Daycare.mon(dc, 2));
    if (species === SPECIES_WYNAUT && motherItem !== ITEM_LAX_INCENSE && fatherItem !== ITEM_LAX_INCENSE) {
      species = SPECIES_WOBBUFFET;
    }
    if (species === SPECIES_AZURILL && motherItem !== ITEM_SEA_INCENSE && fatherItem !== ITEM_SEA_INCENSE) {
      species = SPECIES_MARILL;
    }
    return species;
  },

  // Lua: breeding.lua:350 -- [selected, whichParent] (sequences), or [] with no egg/daycare
  // pokefirered/src/daycare.c:791 InheritIVs
  inheritIVs(egg: any, dc: any, session?: any): [any, any] | [] {
    const Daycare = daycareMod();
    if (!(egg && dc)) return [];
    const R = rngMod();
    const rse = Breeding.isRse(session);
    const available: any = seq();
    for (let i = 1; i <= NUM_STATS; i++) available[i] = i;
    const selected: any = seq();
    for (let i = 1; i <= INHERITED_IV_COUNT; i++) {
      // pokefirered/src/daycare.c:809
      const pick = mod(R.Random(), NUM_STATS - (i - 1)) + 1;
      selected[i] = available[pick];
      if (rse) {
        // pokeemerald/src/daycare.c:552
        remove(available, i);
      } else {
        // pokefirered/src/daycare.c:772 RemoveIVIndexFromList
        remove(available, pick);
      }
    }
    const whichParent: any = seq();
    for (let i = 1; i <= INHERITED_IV_COUNT; i++) {
      whichParent[i] = mod(R.Random(), DAYCARE_MON_COUNT) + 1;
    }
    egg.ivs = egg.ivs ?? {};
    for (let i = 1; i <= INHERITED_IV_COUNT; i++) {
      const key = IV_KEYS[selected[i]];
      const parent = Daycare.mon(dc, whichParent[i]);
      const parentIvs = parent ? parent.ivs : undefined;
      const value = (key != null && parentIvs) ? tonumber(parentIvs[key]) : undefined;
      if (value != null) egg.ivs[key as string] = value;
    }
    return [selected, whichParent];
  },

  // Lua: breeding.lua:386
  // pokefirered/src/daycare.c:854 GetEggMoves
  eggMovesOf(species: unknown): any {
    const Pokemon = pokemonMod();
    return (Pokemon.eggMoves && Pokemon.eggMoves(species)) || seq();
  },

  // Lua: breeding.lua:392
  // pokefirered/src/daycare.c:888 BuildEggMoveset
  buildEggMoveset(egg: any, father: any, mother: any): void {
    const Daycare = daycareMod();
    const Pokemon = pokemonMod();
    if (!egg) return;
    const eggSpecies = speciesOf(egg);
    const fatherMoves = movesOf(father), motherMoves = movesOf(mother);
    const eggMoves = Breeding.eggMovesOf(eggSpecies);
    const levelUpMoves: any = seq();
    for (const [, entry] of ipairs<any>(Pokemon.learnset(eggSpecies) || seq())) {
      const move = tonumber(entry[2] ?? entry.move) ?? 0;
      if (move > 0) levelUpMoves[len(levelUpMoves) + 1] = move;
    }

    // pokefirered/src/daycare.c:916
    for (let i = 1; i <= MAX_MON_MOVES; i++) {
      const move = fatherMoves[i];
      if (move === 0) break;
      for (const [, eggMove] of ipairs(eggMoves)) {
        if (move === eggMove) {
          Daycare.teachMove(egg, move);
          break;
        }
      }
    }

    // pokefirered/src/daycare.c:935
    for (let i = 1; i <= MAX_MON_MOVES; i++) {
      const move = fatherMoves[i];
      if (move !== 0) {
        for (let machine = 0; machine <= NUM_MACHINES - 1; machine++) {
          if (move === Pokemon.moveFromTmItem(ITEM_TM01 + machine)
            && Pokemon.canLearnTmIndex(eggSpecies, machine)) {
            Daycare.teachMove(egg, move);
          }
        }
      }
    }

    // pokefirered/src/daycare.c:949
    const shared: any = seq();
    for (let i = 1; i <= MAX_MON_MOVES; i++) {
      const move = fatherMoves[i];
      if (move === 0) break;
      for (let j = 1; j <= MAX_MON_MOVES; j++) {
        if (move === motherMoves[j]) shared[len(shared) + 1] = move;
      }
    }

    // pokefirered/src/daycare.c:960
    for (const [, move] of ipairs(shared)) {
      for (const [, levelUp] of ipairs(levelUpMoves)) {
        if (move === levelUp) {
          Daycare.teachMove(egg, move);
          break;
        }
      }
    }
  },

  // Lua: breeding.lua:452
  // pokefirered/src/daycare.c:1096 CreateEgg SetMonData block
  applyEggData(egg: any, setHotSpringsLocation?: boolean): any {
    if (!egg) return undefined;
    const Pokemon = pokemonMod();
    const species = speciesOf(egg);
    // pokefirered/src/daycare.c:1101 gSpeciesInfo[species].eggCycles
    const meta = (Pokemon.speciesMeta && Pokemon.speciesMeta(species)) || {};
    const cycles = tonumber(meta.eggCycles) ?? 20;
    egg.friendship = cycles;
    egg.happiness = cycles;
    egg.eggCycles = cycles;
    egg.level = EGG_HATCH_LEVEL;
    egg.metLevel = 0;
    egg.pokeball = ITEM_POKE_BALL;
    egg.isEgg = true;
    if (setHotSpringsLocation) {
      // pokefirered/src/daycare.c:1106 METLOC_SPECIAL_EGG
      egg.metLocation = 253;
    }
    return egg;
  },

  // Lua: breeding.lua:492
  // pokefirered/src/daycare.c:1114 SetInitialEggData
  setInitialEggData(session: any, species: number, dc: any): any {
    const R = rngMod();
    if (Breeding.isRse(session)) {
      // pokeemerald/src/daycare.c:862
      return buildEggMon(session, species, mod(tonumber(dc ? dc.offspringPersonality : undefined) ?? 0, 0x100000000));
    }
    const personality = mod((tonumber(dc ? dc.offspringPersonality : undefined) ?? 0)
      + R.Random() * 0x10000, 0x100000000);
    return buildEggMon(session, species, personality);
  },

  // Lua: breeding.lua:504
  // pokeemerald/src/daycare.c:750 GiveVoltTackleIfLightBall
  giveVoltTackleIfLightBall(session: any, egg: any, dc: any): boolean {
    const Daycare = daycareMod();
    const ball = constantOf(session, "items", "ITEM_LIGHT_BALL");
    if (heldItemOf(Daycare.mon(dc, 1)) === ball || heldItemOf(Daycare.mon(dc, 2)) === ball) {
      Daycare.teachMove(egg, constantOf(session, "moves", "MOVE_VOLT_TACKLE"));
      return true;
    }
    return false;
  },

  // Lua: breeding.lua:515
  // pokefirered/src/daycare.c:1087 CreateEgg
  createEgg(session: any, species: number, setHotSpringsLocation?: boolean): any {
    const R = rngMod();
    const egg = buildEggMon(session, species, R.Random32());
    return Breeding.applyEggData(egg, setHotSpringsLocation);
  },

  // Lua: breeding.lua:522
  // pokefirered/src/daycare.c:1063 _GiveEggFromDaycare
  giveEggFromDaycare(sessionIn?: any): any {
    const Daycare = daycareMod();
    const session = Daycare.sessionOf(sessionIn);
    const dc = Daycare.stateOf(session);
    if (!(session && dc)) return undefined;
    let [species, mother, father] = Breeding.parentSlots(dc);
    if ((species ?? SPECIES_NONE) === SPECIES_NONE) return undefined;
    species = Breeding.alterEggSpeciesWithIncenseItem(species, dc);
    const egg = Breeding.setInitialEggData(session, species, dc);
    if (!egg) return undefined;
    Breeding.inheritIVs(egg, dc, session);
    Breeding.buildEggMoveset(egg, Daycare.mon(dc, father), Daycare.mon(dc, mother));
    if (Breeding.isRse(session) && species === constantOf(session, "species", "SPECIES_PICHU")) {
      // pokeemerald/src/daycare.c:817
      Breeding.giveVoltTackleIfLightBall(session, egg, dc);
    }
    egg.isEgg = true;
    session.party = session.party ?? seq();
    // pokefirered/src/daycare.c:1081 gPlayerParty[PARTY_SIZE - 1] = egg
    session.party[PARTY_SIZE] = egg;
    Daycare.compactParty(session);
    Breeding.removeEgg(dc);
    return egg;
  },

  // Lua: breeding.lua:548
  // pokefirered/src/daycare.c:1639 AddHatchedMonToParty
  hatchMon(sessionIn: any, mon: any): any {
    const Daycare = daycareMod();
    const Pokemon = pokemonMod();
    if (!mon) return undefined;
    const session = Daycare.sessionOf(sessionIn);
    const species = speciesOf(mon);
    mon.isEgg = false;
    mon.egg = false;
    mon.level = EGG_HATCH_LEVEL;
    // pokefirered/src/daycare.c:1654 SetMonData(mon, MON_DATA_NICKNAME, name)
    mon.nickname = "";
    mon.name = (Pokemon.name && Pokemon.name(species)) || mon.name;
    // pokefirered/src/daycare.c:1626
    mon.language = 2;
    // pokefirered/src/pokemon.c:1796
    const trainerId = session ? tonumber(session.trainerId ?? session.id ?? session.playerId) : undefined;
    if (trainerId != null) {
      mon.otId = mod(trainerId, 65536);
      mon.otSecretId = mod(tonumber(session.secretId) ?? Math.floor(trainerId / 65536), 65536);
      mon.otName = session.name ?? session.playerName ?? mon.otName ?? mon.ot;
      mon.ot = mon.otName;
      mon.otGender = (PartyMod as any).otGender(session);
      delete mon.isShiny;
    }
    if (isTable(mon.cartExtra)) {
      delete mon.cartExtra.nicknameBytes;
      delete mon.cartExtra.nicknameLanguage;
      delete mon.cartExtra.nicknameRaw;
      if (trainerId != null) delete mon.cartExtra.otNameRaw;
    }
    // pokefirered/src/daycare.c:1631 friendship = 120
    mon.friendship = 120;
    mon.happiness = 120;
    delete mon.eggCycles;
    mon.pokeball = ITEM_POKE_BALL;
    mon.metLevel = 0;
    mon.metLocation = (Pokemon.currentMapSec && Pokemon.currentMapSec(session)) ?? mon.metLocation;
    // pokefirered/src/daycare.c:1671 MonRestorePP
    if (isTable(mon.pp) && isTable(mon.maxPp)) {
      const n = len(mon.pp);
      for (let i = 1; i <= n; i++) mon.pp[i] = mon.maxPp[i] ?? mon.pp[i];
    }
    // pokefirered/src/daycare.c:1672 CalculateMonStats
    Pokemon.applyStats(mon);
    // pokefirered/src/daycare.c:1657 GetSetPokedexFlag
    if (session && session.dex && species !== SPECIES_NONE) {
      const Dex: any = DexMod;
      Dex.setSeen(session.dex, species);
      Dex.setCaught(session.dex, species);
    }
    return mon;
  },
};

export default Breeding;
