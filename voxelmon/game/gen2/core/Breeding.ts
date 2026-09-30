// gen1recomp src/core/gen2/Breeding.lua at bdfac727 (MIT): the Gen 2
// Day-Care, breeding and eggs -- the whole model, no drawing.
//
// Table math over the pokemon table's `eggGroups`, `eggSteps`, `genderRatio`,
// `evolutions`, `levelMoves`, `eggMoves` and `tmhm` rows. Ported by Brian from
// engine/events/daycare.asm, engine/pokemon/breeding.asm,
// engine/events/happiness_egg.asm (DayCareStep), engine/pokemon/move_mon.asm
// (DepositBreedmon / RetrieveBreedmon), breedmon_level_growth.asm and the
// step block of engine/overworld/events.asm. src/ui/gen2/DayCareMenu.lua is
// the only half that draws. A hatched mon is built by Mon.new and nothing else.
//
// Indices: party slots (`partyIndex`, hatch `index`, motherSlot) stay 1-BASED
// as the Lua passes them; only the storage read subtracts 1.
// Lua multiple returns are tuples where a caller reads more than the first:
// eggGroups, eggSpecies, canOpenDeposit, canDeposit, deposit, levelGrowth,
// canWithdraw, withdraw, collectEgg, hatch.

import { Mail } from "./Mail.ts";
import { Mon } from "../battle/Mon.ts";
import { Runtime } from "../shared/mods/Runtime.ts";
import { mod, removeAt, tonumber } from "../platform/lua.ts";
import { random } from "../platform/rng.ts";

export interface Dvs {
  attack?: number;
  defense?: number;
  speed?: number;
  special?: number;
  hp?: number;
  [k: string]: unknown;
}

export interface MoveEntry {
  id: string | number;
  pp?: number;
  maxPp?: number;
}

/** A party / day-care record, as far as this module reads it. */
export interface BreedMon {
  species?: string;
  level?: number;
  experience?: number;
  dvs?: Dvs;
  moves?: any[];
  hp?: number;
  maxHp?: number;
  isEgg?: boolean;
  eggSteps?: number;
  ot?: unknown;
  otId?: unknown;
  item?: string;
  [k: string]: any;
}

/** game.data as the breeding code reads it (pokemon / moves tables). */
export interface BreedData {
  pokemon?: Record<string, any>;
  moves?: Record<string, any>;
  [k: string]: any;
}

export interface DayCareSide {
  mon?: BreedMon;
  introSeen?: boolean;
}

export interface DayCare {
  man: DayCareSide;
  lady: DayCareSide;
  compatible: boolean;
  hasEgg: boolean;
  stepsToEgg: number;
  egg?: BreedMon;
  [k: string]: unknown;
}

export type Rng = () => number;

export interface BreedOpts {
  rng?: Rng;
  playerName?: unknown;
  playerId?: unknown;
}

// Lua: Breeding.lua:119 -- `call Random` yields one byte; a test can hand in
// a scripted sequence.
function randomByte(rng?: Rng): number {
  if (rng) return mod(Math.floor(rng()), 256);
  return random(0, 255);
}

// Lua: Breeding.lua:137 -- GetPreEvolution walks species in index order, so
// the walk needs dex ordering; cached against the table itself.
const orderCache = new WeakMap<object, string[]>();

// Lua: Breeding.lua:139
function speciesOrder(data: BreedData | undefined): string[] {
  const pokemon = data && data.pokemon;
  if (!pokemon) return [];
  const hit = orderCache.get(pokemon);
  if (hit) return hit;
  const rows: { id: string; index: number }[] = [];
  for (const id of Object.keys(pokemon)) {
    const def = pokemon[id];
    // growthRates / tmhmMoves ride the same table and carry no index.
    if (def !== null && typeof def === "object" && typeof def.index === "number") {
      rows.push({ id, index: def.index });
    }
  }
  rows.sort((a, b) => a.index - b.index);
  const out = rows.map((row) => row.id);
  orderCache.set(pokemon, out);
  return out;
}

// Lua: Breeding.lua:160
function defOf(data: BreedData | undefined, species: unknown): any {
  if (!(data && data.pokemon && species != null)) return undefined;
  const def = data.pokemon[species as string];
  return def !== null && typeof def === "object" ? def : undefined;
}

// Lua: Breeding.lua:169 -- Mon.growthFor, so a hatched egg's experience sits
// on the same curve battle EXP and a Rare Candy use.
function growthOf(data: BreedData | undefined, def: any): any {
  return Mon.growthFor(data, def && def.growthRate);
}

// Lua: Breeding.lua:456
function moveIdAt(moves: any[] | undefined, slot: number): string | number | undefined {
  const entry = moves && moves[slot - 1];
  if (entry == null) return undefined;
  if (typeof entry === "object") return entry.id;
  return entry;
}

// Lua: Breeding.lua:289 -- wBreedMon1ID / wBreedMon2ID; two home-caught mons
// both read nil and compare EQUAL, as the cart sees them.
function otId(mon: BreedMon | undefined): unknown {
  return mon ? mon.otId : undefined;
}

// Lua: Breeding.lua:971 -- DayCareStep's first half: +1 exp per step up to
// $50ffff, nothing once the STORED level is MAX_LEVEL.
function growDeposited(slot: DayCareSide | undefined): void {
  const mon = slot && slot.mon;
  if (!mon) return;
  if ((mon.level ?? 1) >= Breeding.MAX_LEVEL) return;
  mon.experience = Math.min((mon.experience ?? 0) + 1, Breeding.MAX_DAY_CARE_EXP);
}

export const Breeding = {
  // Lua: Breeding.lua:55 -- constants/battle_constants.asm: hatches at level 5.
  EGG_LEVEL: 5,
  // Lua: Breeding.lua:60 -- HatchEggs' `ld [hl], $78`: 120, not BASE_HAPPINESS.
  HATCH_HAPPINESS: 0x78,
  // Lua: Breeding.lua:66 -- .String_EGG; the slot is flagged `isEgg`, the
  // species stays the hatchling's.
  EGG_NAME: "EGG",
  // Lua: Breeding.lua:69-71 -- PARTY_LENGTH / NUM_MOVES / MAX_LEVEL (read
  // live off Mon, as the Lua aliases them).
  get PARTY_SIZE(): number {
    return Mon.PARTY_SIZE as number;
  },
  NUM_MOVES: 4,
  get MAX_LEVEL(): number {
    return Mon.MAX_LEVEL as number;
  },
  // Lua: Breeding.lua:78 -- the first countdown is a rejection sample >= 150.
  MIN_STEPS_TO_EGG: 150,
  // Lua: Breeding.lua:83-84 -- wStepCount is a byte; DoEggStep fires at $80.
  STEP_CYCLE: 256,
  EGG_STEP_PHASE: 0x80,
  // Lua: Breeding.lua:89 -- DayCareStep only clamps the high byte: $50ffff.
  MAX_DAY_CARE_EXP: 0x50ffff,
  // Lua: Breeding.lua:92-93 -- GetPriceToRetrieveBreedmon.
  WITHDRAW_FEE: 100,
  WITHDRAW_FEE_PER_LEVEL: 100,
  // Lua: Breeding.lua:96-99 -- the species the routines name outright.
  DITTO: "DITTO",
  NIDORAN_F: "NIDORAN_F",
  NIDORAN_M: "NIDORAN_M",
  TOGEPI: "TOGEPI",
  // Lua: Breeding.lua:104-105 -- EGG_NONE in both nibbles ($ff) is "No Eggs".
  EGG_NONE: "EGG_NONE",
  NO_EGGS_RAW: 0xff,
  // Lua: Breeding.lua:111 -- wDayCareMan / wDayCareLady.
  SIDES: ["man", "lady"] as const,

  randomByte,
  speciesOrder,

  // ------------------------------------------------------ eggs as party members

  // Lua: Breeding.lua:180 -- wPartySpecies holds EGG; the port flags the slot.
  isEgg(mon: unknown): boolean {
    return mon !== null && typeof mon === "object" && (mon as BreedMon).isEgg === true;
  },

  // Lua: Breeding.lua:187 -- an egg is carried, not fought.
  canFight(mon: unknown): boolean {
    return mon !== null && typeof mon === "object" && !Breeding.isEgg(mon);
  },

  // Lua: Breeding.lua:194
  healthyCount(party: BreedMon[] | undefined): number {
    let n = 0;
    for (const mon of party ?? []) {
      if (Breeding.canFight(mon) && (mon.hp ?? 0) > 0) n = n + 1;
    }
    return n;
  },

  // ----------------------------------------------------------------- gender

  // Lua: Breeding.lua:216 -- GetGender, delegated to the port's ONE routine.
  gender(def: any, dvs: Dvs | undefined): string {
    return Mon.gender(def, dvs);
  },

  // Lua: Breeding.lua:220
  genderOf(data: BreedData | undefined, mon: BreedMon | undefined): string {
    if (!mon) return "unknown";
    return Breeding.gender(defOf(data, mon.species), mon.dvs);
  },

  // --------------------------------------------- egg groups and compatibility

  // Lua: Breeding.lua:232 -- BASE_EGG_GROUPS, high nibble first. Returns
  // [first, second].
  eggGroups(def: any): [string | undefined, string | undefined] {
    const groups = def && def.eggGroups;
    if (groups === null || typeof groups !== "object") return [undefined, undefined];
    // (a sequence with a hole arrives keyed "1"/"2")
    if (Array.isArray(groups)) return [groups[0], groups[1]];
    return [groups["1"], groups["2"]];
  },

  // Lua: Breeding.lua:241 -- `cp EGG_NONE * $11`: both nibbles EGG_NONE.
  isNoEggs(def: any): boolean {
    if (!def) return true;
    if (typeof def.eggGroupsRaw === "number") {
      return def.eggGroupsRaw === Breeding.NO_EGGS_RAW;
    }
    const [first, second] = Breeding.eggGroups(def);
    return first === Breeding.EGG_NONE && second === Breeding.EGG_NONE;
  },

  // Lua: Breeding.lua:255 -- .CheckBreedingGroupCompatibility in its own
  // order: No-Eggs (mon2, then mon1) BEFORE the Ditto shortcut.
  groupsCompatible(data: BreedData | undefined, species1: unknown, species2: unknown): boolean {
    const def1 = defOf(data, species1);
    const def2 = defOf(data, species2);
    if (!(def1 && def2)) return false;
    if (Breeding.isNoEggs(def2)) return false;
    if (Breeding.isNoEggs(def1)) return false;
    if (species2 === Breeding.DITTO) return true;
    if (species1 === Breeding.DITTO) return true;
    const [b, c] = Breeding.eggGroups(def2);
    const [d, e] = Breeding.eggGroups(def1);
    if (d != null && (d === b || d === c)) return true;
    if (e != null && (e === b || e === c)) return true;
    return false;
  },

  // Lua: Breeding.lua:278 -- .CheckDVs: Defense and the low three bits of
  // Special matching is the "too alike" sentinel.
  dvsMatch(mon1: BreedMon | undefined, mon2: BreedMon | undefined): boolean {
    const a: Dvs = (mon1 && mon1.dvs) || {};
    const b: Dvs = (mon2 && mon2.dvs) || {};
    if (mod(a.defense ?? 0, 16) !== mod(b.defense ?? 0, 16)) return false;
    return mod(a.special ?? 0, 8) === mod(b.special ?? 0, 8);
  },

  // Lua: Breeding.lua:315 -- CheckBreedmonCompatibility, behind the
  // breeding.compatibility hook: 0, 255 (DV sentinel), 254/177, 128/51.
  compatibility(data: BreedData | undefined, mon1: BreedMon | undefined, mon2: BreedMon | undefined, opts?: { dayCare?: boolean }): number {
    if (!Runtime.wantsHook("breeding.compatibility")) {
      return Breeding.vanillaCompatibility(data, mon1, mon2);
    }
    const value = Runtime.call("breeding.compatibility", (c: any) => {
      return Breeding.vanillaCompatibility(c.data, c.mon1, c.mon2);
    }, { data, mon1, mon2, dayCare: (opts && opts.dayCare) === true });
    return Math.max(0, Math.min(255, Math.floor(tonumber(value) ?? 0)));
  },

  // Lua: Breeding.lua:326
  vanillaCompatibility(data: BreedData | undefined, mon1: BreedMon | undefined, mon2: BreedMon | undefined): number {
    if (!(mon1 && mon2)) return 0;
    if (!Breeding.groupsCompatible(data, mon1.species, mon2.species)) return 0;

    // Two different genders reach .compute; anything else falls into
    // .genderless, where only a Ditto rescues the pair.
    const gender1 = Breeding.genderOf(data, mon1);
    const gender2 = Breeding.genderOf(data, mon2);
    const paired = gender1 !== "unknown" && gender2 !== "unknown" && gender1 !== gender2;
    if (!paired) {
      if (mon1.species === Breeding.DITTO) {
        // .ditto1: two Dittos fail here.
        if (mon2.species === Breeding.DITTO) return 0;
      } else if (mon2.species !== Breeding.DITTO) {
        return 0;
      }
    }

    // .compute
    if (Breeding.dvsMatch(mon1, mon2)) return 255;
    let value = mon1.species === mon2.species ? 254 : 128;
    // .compare_ids: `sub 77` on a shared OT id.
    if (otId(mon1) === otId(mon2)) value = value - 77;
    return value;
  },

  // Lua: Breeding.lua:359-363 -- DayCareMonCompatibilityText's answers.
  COMPATIBILITY_BRIMMING: "brimming",
  COMPATIBILITY_NONE: "none",
  COMPATIBILITY_CARES: "cares",
  COMPATIBILITY_FRIENDLY: "friendly",
  COMPATIBILITY_INTEREST: "interest",

  // Lua: Breeding.lua:365
  compatibilityText(value?: number): string {
    value = value ?? 0;
    if (value === 255) return Breeding.COMPATIBILITY_BRIMMING;
    if (value === 0) return Breeding.COMPATIBILITY_NONE;
    if (value >= 230) return Breeding.COMPATIBILITY_CARES;
    if (value >= 70) return Breeding.COMPATIBILITY_FRIENDLY;
    return Breeding.COMPATIBILITY_INTEREST;
  },

  // Lua: Breeding.lua:379 -- .check_egg's ladder (`percent` = *$ff/100); an
  // egg appears when the byte is strictly under this.
  eggChance(value?: number): number {
    value = value ?? 0;
    if (value >= 230) return 80;
    if (value >= 170) return 40;
    if (value >= 110) return 30;
    return 10;
  },

  // ------------------------------------------------------ which is the mother

  // Lua: Breeding.lua:397 -- wBreedMotherOrNonDitto as a 1-based slot. A
  // Ditto is never the mother; genderless breedmon 1 is.
  motherSlot(data: BreedData | undefined, mon1: BreedMon | undefined, mon2: BreedMon | undefined): number {
    if (!(mon1 && mon2)) return 1;
    if (mon1.species === Breeding.DITTO) return 2;
    if (mon2.species === Breeding.DITTO) return 1;
    return Breeding.genderOf(data, mon1) === "male" ? 2 : 1;
  },

  // --------------------------------------------------------- the egg species

  // Lua: Breeding.lua:412 -- GetPreEvolution: first species in dex order
  // with an evolution INTO `species`, whatever the method.
  preEvolution(data: BreedData | undefined, species: unknown): string | undefined {
    if (species == null) return undefined;
    for (const id of speciesOrder(data)) {
      const def = defOf(data, id);
      for (const evo of (def && def.evolutions) || []) {
        if (evo.into === species) return id;
      }
    }
    return undefined;
  },

  // Lua: Breeding.lua:427 -- `callfar GetPreEvolution` exactly TWICE.
  baseForm(data: BreedData | undefined, species: string | undefined): string | undefined {
    for (let n = 1; n <= 2; n++) {
      const previous = Breeding.preEvolution(data, species);
      if (!previous) break;
      species = previous;
    }
    return species;
  },

  // Lua: Breeding.lua:441 -- the mother's base form; NIDORAN_F rolls either
  // Nidoran (`cp 128 / jr c`). Returns [species, motherSlot].
  eggSpecies(data: BreedData | undefined, mon1: BreedMon | undefined, mon2: BreedMon | undefined, rng?: Rng): [string | undefined, number] {
    const slot = Breeding.motherSlot(data, mon1, mon2);
    const mother = slot === 1 ? mon1 : mon2;
    let species = Breeding.baseForm(data, mother && mother.species);
    if (species === Breeding.NIDORAN_F) {
      species = randomByte(rng) < 128 ? Breeding.NIDORAN_F : Breeding.NIDORAN_M;
    }
    return [species, slot];
  },

  // --------------------------------------------------------- inherited moves

  // Lua: Breeding.lua:474 -- GetHeritableMoves: the FATHER's four slots. With
  // a Ditto, a FEMALE partner makes the Ditto the father.
  heritableMoves(data: BreedData | undefined, mon1: BreedMon | undefined, mon2: BreedMon | undefined, motherSlot?: number): any[] {
    if (!(mon1 && mon2)) return [];
    if (mon1.species === Breeding.DITTO) {
      return Breeding.genderOf(data, mon2) === "female" ? (mon1.moves || []) : (mon2.moves || []);
    }
    if (mon2.species === Breeding.DITTO) {
      return Breeding.genderOf(data, mon1) === "female" ? (mon2.moves || []) : (mon1.moves || []);
    }
    motherSlot = motherSlot ?? Breeding.motherSlot(data, mon1, mon2);
    return motherSlot === 1 ? (mon2.moves || []) : (mon1.moves || []);
  },

  // Lua: Breeding.lua:492 -- GetBreedmonMovePointer: the MOTHER's slots, or
  // the Ditto's whichever side it sits on.
  breedmonMoves(data: BreedData | undefined, mon1: BreedMon | undefined, mon2: BreedMon | undefined, motherSlot?: number): any[] {
    if (!(mon1 && mon2)) return [];
    if (mon1.species === Breeding.DITTO) return mon1.moves || [];
    if (mon2.species === Breeding.DITTO) return mon2.moves || [];
    motherSlot = motherSlot ?? Breeding.motherSlot(data, mon1, mon2);
    return motherSlot === 1 ? (mon1.moves || []) : (mon2.moves || []);
  },

  // Lua: Breeding.lua:507 -- GetEggMove: 1. an egg move of the egg species;
  // 2. the OTHER parent knows it AND it is a level-up move of the egg
  // species; 3. a TM/HM it can learn. (The Lua's second return, the reason,
  // is read by no caller and is dropped.)
  canInheritMove(data: BreedData | undefined, eggSpecies: unknown, move: unknown, otherMoves: any[] | undefined): boolean {
    const def = defOf(data, eggSpecies);
    if (!(def && move != null)) return false;

    for (const id of def.eggMoves || []) {
      if (id === move) return true; // "eggMove"
    }

    // .loop2 walks all four of the other parent's slots.
    let shared = false;
    for (let slot = 1; slot <= Breeding.NUM_MOVES; slot++) {
      if (moveIdAt(otherMoves, slot) === move) {
        shared = true;
        break;
      }
    }
    if (shared) {
      for (const row of def.levelMoves || []) {
        if (row.move === move) return true; // "levelMove"
      }
    }

    // CanLearnTMHMMove against BASE_TMHM, already expanded to move ids.
    for (const id of def.tmhm || []) {
      if (id === move) return true; // "tmhm"
    }
    return false;
  },

  // Lua: Breeding.lua:539 -- LoadEggMove: first empty slot, or shift out the
  // OLDEST and write into slot 4.
  loadEggMove(moves: MoveEntry[], moveId: string | number, data?: BreedData): MoveEntry[] {
    const def = data && data.moves && data.moves[moveId as string];
    const pp = (def && def.pp) || 0;
    if (moves.length >= Breeding.NUM_MOVES) removeAt(moves, 1);
    moves.push({ id: moveId, pp, maxPp: pp });
    return moves;
  },

  // Lua: Breeding.lua:550 -- InitEggMoves: the father's slots in order,
  // stopping at the first empty one. Mutates and returns `moves`.
  initEggMoves(data: BreedData | undefined, eggSpecies: unknown, moves: MoveEntry[] | undefined, fatherMoves: any[] | undefined, motherMoves: any[] | undefined): MoveEntry[] {
    moves = moves || [];
    for (let slot = 1; slot <= Breeding.NUM_MOVES; slot++) {
      const move = moveIdAt(fatherMoves, slot);
      // `and a / jr z, .done`: an empty slot ends the walk.
      if (move == null) break;
      let known = false;
      for (const entry of moves) {
        if (entry.id === move) {
          known = true;
          break;
        }
      }
      if (!known && Breeding.canInheritMove(data, eggSpecies, move, motherMoves)) {
        Breeding.loadEggMove(moves, move, data);
      }
    }
    return moves;
  },

  // ---------------------------------------------------------- building the egg

  // Lua: Breeding.lua:580 -- DayCare_InitBreeding's .UselessJump block: the
  // egg is decided when the pair becomes compatible. opts: rng, playerName,
  // playerId.
  makeEgg(data: BreedData, mon1: BreedMon, mon2: BreedMon, opts?: BreedOpts): BreedMon | undefined {
    opts = opts || {};
    const rng = opts.rng;
    const [species, motherSlot] = Breeding.eggSpecies(data, mon1, mon2, rng);
    const def = defOf(data, species);
    if (!def) return undefined;
    const level = Breeding.EGG_LEVEL;

    // `predef FillMoves` at EGG_LEVEL, then `farcall InitEggMoves`.
    const moves = Mon.movesAtLevel(def, level, data.moves);
    Breeding.initEggMoves(data, species, moves,
      Breeding.heritableMoves(data, mon1, mon2, motherSlot),
      Breeding.breedmonMoves(data, mon1, mon2, motherSlot));

    // Two `call Random` bytes laid out as the DV word.
    const byte0 = randomByte(rng);
    const byte1 = randomByte(rng);
    const dvs: Dvs = {
      attack: Math.floor(byte0 / 16), defense: mod(byte0, 16),
      speed: Math.floor(byte1 / 16), special: mod(byte1, 16),
    };

    // Which parent's DVs bleed through. The Ditto tests come FIRST.
    let source: BreedMon | undefined;
    if (mon1.species === Breeding.DITTO) {
      source = mon1;
    } else if (mon2.species === Breeding.DITTO) {
      source = mon2;
    } else {
      // GetGender on the EGG's own rolled DVs against its species ratio.
      const gender = Breeding.gender(def, dvs);
      const mother = motherSlot === 1 ? mon1 : mon2;
      const father = motherSlot === 1 ? mon2 : mon1;
      if (gender === "male") {
        source = mother;
      } else if (gender === "female") {
        source = father;
      }
      // "unknown" is .SkipDVs.
    }

    if (source) {
      const parent: Dvs = source.dvs || {};
      // The whole Defense nibble; only the LOW THREE BITS of Special.
      dvs.defense = mod(parent.defense ?? 0, 16);
      dvs.special = dvs.special! - mod(dvs.special!, 8) + mod(parent.special ?? 0, 8);
    }
    dvs.hp = Mon.hpDV(dvs);

    // hp = 0: DayCare_GiveEgg zeroes MON_HP.
    const egg: BreedMon | undefined = Mon.new(data, species as string, level, {
      dvs,
      moves,
      hp: 0,
      nickname: Breeding.EGG_NAME,
      happiness: Breeding.HATCH_HAPPINESS,
    });
    if (!egg) return undefined;
    // `callfar CalcExpAtLevel` at wCurPartyLevel.
    egg.experience = Mon.experienceForLevel(growthOf(data, def), level);
    egg.isEgg = true;
    // The hatch counter, kept apart from `happiness`.
    egg.eggSteps = def.eggSteps ?? 0;
    // wEggMonOT / wEggMonID: the player.
    egg.ot = opts.playerName;
    egg.otId = opts.playerId;
    return egg;
  },

  // -------------------------------------------------------- the day-care record

  // Lua: Breeding.lua:676-678 -- engine flags backed by the day-care bytes.
  ENGINE_DAY_CARE_MAN_HAS_EGG: 5,
  ENGINE_DAY_CARE_MAN_HAS_MON: 6,
  ENGINE_DAY_CARE_LADY_HAS_MON: 7,

  // Lua: Breeding.lua:686 -- save.dayCare, created on demand.
  dayCare(save: any): DayCare | undefined {
    if (save === null || typeof save !== "object") return undefined;
    save.dayCare = save.dayCare || {};
    const dc = save.dayCare as DayCare;
    dc.man = dc.man || {};
    dc.lady = dc.lady || {};
    dc.compatible = dc.compatible || false;
    dc.hasEgg = dc.hasEgg || false;
    dc.stepsToEgg = dc.stepsToEgg ?? 0;
    return dc;
  },

  // Lua: Breeding.lua:698
  side(save: any, which: string | undefined): DayCareSide | undefined {
    const dc = Breeding.dayCare(save);
    if (!dc) return undefined;
    return dc[which === "lady" ? "lady" : "man"];
  },

  // Lua: Breeding.lua:708 -- DAYCARE_INTRO_SEEN_F: true the first time.
  takeIntro(save: any, which: string | undefined): boolean {
    const slot = Breeding.side(save, which);
    if (!slot) return false;
    if (slot.introSeen) return false;
    slot.introSeen = true;
    return true;
  },

  // ------------------------------------------------------------------ deposit

  // Lua: Breeding.lua:725 -- CheckCurPartyMonFainted: any OTHER slot with HP.
  // partyIndex is 1-based.
  hasAnotherHealthyMon(party: BreedMon[] | undefined, partyIndex: number): boolean {
    const list = party || [];
    for (let i = 0; i < list.length; i++) {
      const mon = list[i]!;
      if (i + 1 !== partyIndex && (mon.hp ?? 0) > 0) return true;
    }
    return false;
  },

  // Lua: Breeding.lua:735-742 -- DayCareAskDepositPokemon's refusals.
  REFUSE_LAST_MON: "lastMon",
  REFUSE_EGG: "cantAcceptEgg",
  REFUSE_LAST_ALIVE: "lastAliveMon",
  REFUSE_MAIL: "removeMail",
  REFUSE_PARTY_FULL: "partyFull",
  REFUSE_NO_MONEY: "notEnoughMoney",
  REFUSE_OCCUPIED: "occupied",
  REFUSE_NO_MON: "noMon",

  // Lua: Breeding.lua:746 -- `cp 2 / jr c, .OnlyOneMon`. Returns [ok, reason].
  canOpenDeposit(save: any): [boolean, string?] {
    const party = (save && save.party) || [];
    if (party.length < 2) return [false, Breeding.REFUSE_LAST_MON];
    return [true];
  },

  // Lua: Breeding.lua:757 -- ItemIsMail via Mail.monHoldsMail.
  holdsMail(_data: unknown, mon: BreedMon | undefined): boolean {
    return Mail.monHoldsMail(mon);
  },

  // Lua: Breeding.lua:761 -- Returns [ok, reason]. partyIndex is 1-based.
  canDeposit(data: BreedData | undefined, save: any, which: string | undefined, partyIndex: number): [boolean, string?] {
    const slot = Breeding.side(save, which);
    if (!slot) return [false, Breeding.REFUSE_NO_MON];
    if (slot.mon) return [false, Breeding.REFUSE_OCCUPIED];
    const [ok, reason] = Breeding.canOpenDeposit(save);
    if (!ok) return [false, reason];
    const mon = save.party[partyIndex - 1];
    if (!mon) return [false, Breeding.REFUSE_NO_MON];
    if (Breeding.isEgg(mon)) return [false, Breeding.REFUSE_EGG];
    if (!Breeding.hasAnotherHealthyMon(save.party, partyIndex)) {
      return [false, Breeding.REFUSE_LAST_ALIVE];
    }
    if (Breeding.holdsMail(data, mon)) return [false, Breeding.REFUSE_MAIL];
    return [true];
  },

  // Lua: Breeding.lua:783 -- DepositBreedmon + RemoveMonFromPartyOrBox, then
  // DayCare_InitBreeding. The level is frozen here. Returns [true, mon] or
  // [false, reason].
  deposit(data: BreedData, save: any, which: string | undefined, partyIndex: number, opts?: BreedOpts): [boolean, BreedMon | string | undefined] {
    const [ok, reason] = Breeding.canDeposit(data, save, which, partyIndex);
    if (!ok) return [false, reason];
    const slot = Breeding.side(save, which)!;
    const mon = removeAt(save.party as BreedMon[], partyIndex);
    // RemoveMonFromPartyOrBox's mail shift.
    Mail.removeSlot(save, partyIndex);
    slot.mon = mon;
    Breeding.initBreeding(data, save, opts);
    return [true, mon];
  },

  // ----------------------------------------------------------------- withdraw

  // Lua: Breeding.lua:802 -- GetBreedMon1LevelGrowth. Returns [storedLevel,
  // newLevel, grown].
  levelGrowth(data: BreedData | undefined, slot: DayCareSide | undefined): [number, number, number] {
    const mon = slot && slot.mon;
    if (!mon) return [0, 0, 0];
    const stored = mon.level ?? 1;
    const def = defOf(data, mon.species);
    let newLevel: number = Mon.levelForExperience(growthOf(data, def), mon.experience ?? 0);
    if (newLevel < stored) newLevel = stored;
    return [stored, newLevel, newLevel - stored];
  },

  // Lua: Breeding.lua:816 -- 100 per level grown plus a flat 100.
  retrievePrice(grown?: number): number {
    return Breeding.WITHDRAW_FEE_PER_LEVEL * Math.max(0, grown ?? 0) + Breeding.WITHDRAW_FEE;
  },

  // Lua: Breeding.lua:823 -- money first, then party space. Returns
  // [ok, reason, price].
  canWithdraw(data: BreedData | undefined, save: any, which: string | undefined): [boolean, string | undefined, number?] {
    const slot = Breeding.side(save, which);
    if (!(slot && slot.mon)) return [false, Breeding.REFUSE_NO_MON];
    const [, , grown] = Breeding.levelGrowth(data, slot);
    const price = Breeding.retrievePrice(grown);
    const money = (save.player && save.player.money) || 0;
    if (money < price) return [false, Breeding.REFUSE_NO_MONEY, price];
    if ((save.party || []).length >= Breeding.PARTY_SIZE) {
      return [false, Breeding.REFUSE_PARTY_FULL, price];
    }
    return [true, undefined, price];
  },

  // Lua: Breeding.lua:841 -- FillMoves with wSkipMovesBeforeLevelUp: moves in
  // (fromLevel, toLevel], each over the oldest once full.
  learnMovesFromDayCare(data: BreedData | undefined, mon: BreedMon, fromLevel: number, toLevel: number): MoveEntry[] {
    const def = defOf(data, mon && mon.species);
    mon.moves = mon.moves || [];
    for (const row of (def && def.levelMoves) || []) {
      if (row.level > fromLevel && row.level <= toLevel) {
        let known = false;
        for (const entry of mon.moves) {
          if (entry.id === row.move) {
            known = true;
            break;
          }
        }
        if (!known) Breeding.loadEggMove(mon.moves, row.move, data);
      }
    }
    return mon.moves;
  },

  // Lua: Breeding.lua:864 -- RetrieveBreedmon, including the CalcExpAtLevel
  // exp-loss bug. Returns [true, mon, price] or [false, reason, price].
  withdraw(data: BreedData, save: any, which: string | undefined): [boolean, BreedMon | string | undefined, number?] {
    const [ok, reason, price] = Breeding.canWithdraw(data, save, which);
    if (!ok) return [false, reason, price];
    const slot = Breeding.side(save, which)!;
    const [stored, newLevel] = Breeding.levelGrowth(data, slot);
    const mon = slot.mon!;
    const def = defOf(data, mon.species);

    const rebuilt: BreedMon | undefined = Mon.new(data, mon.species as string, newLevel, {
      dvs: mon.dvs,
      moves: mon.moves,
      item: mon.item,
      happiness: mon.happiness,
      nickname: mon.nickname,
    });
    if (!rebuilt) return [false, Breeding.REFUSE_NO_MON];
    Breeding.learnMovesFromDayCare(data, rebuilt, stored, newLevel);
    // HealPartyMon: full HP, full PP, no status.
    rebuilt.hp = rebuilt.maxHp;
    rebuilt.status = undefined;
    for (const move of rebuilt.moves!) move.pp = move.maxPp;
    rebuilt.caughtLevel = mon.caughtLevel ?? rebuilt.caughtLevel;
    // MON_CAUGHTDATA copied back whole -- engine/pokemon/move_mon.asm:805.
    rebuilt.caughtTime = mon.caughtTime;
    rebuilt.caughtLocation = mon.caughtLocation;
    rebuilt.caughtByGender = mon.caughtByGender;
    rebuilt.ot = mon.ot;
    rebuilt.otId = mon.otId;
    // CalcExpAtLevel, which is the experience loss.
    rebuilt.experience = Mon.experienceForLevel(growthOf(data, def), newLevel);

    save.player = save.player || {};
    save.player.money = Math.max(0, (save.player.money ?? 0) - price!);
    save.party = save.party || [];
    save.party.push(rebuilt);
    slot.mon = undefined;

    // Both paths clear MONS_COMPATIBLE_F; HAS_EGG survives.
    const dc = Breeding.dayCare(save)!;
    dc.compatible = false;
    return [true, rebuilt, price];
  },

  // ------------------------------------------------------- starting a clutch

  // Lua: Breeding.lua:920 -- DayCare_InitBreeding: both sides occupied,
  // compatibility not 0 and not 255, then the countdown and the egg.
  initBreeding(data: BreedData, save: any, opts?: BreedOpts): boolean {
    opts = opts || {};
    const dc = Breeding.dayCare(save);
    if (!(dc && dc.man.mon && dc.lady.mon)) return false;
    const value = Breeding.compatibility(data, dc.man.mon, dc.lady.mon, { dayCare: true });
    if (value === 0) return false;
    if (value === 255) return false;
    dc.compatible = true;
    let steps: number;
    do {
      steps = randomByte(opts.rng);
    } while (!(steps >= Breeding.MIN_STEPS_TO_EGG));
    dc.stepsToEgg = steps;
    dc.egg = Breeding.makeEgg(data, dc.man.mon, dc.lady.mon, {
      rng: opts.rng,
      playerName: opts.playerName ?? (save.player && save.player.name),
      playerId: opts.playerId ?? (save.player && save.player.id),
    });
    // breeding.egg_created fires here, where the record is decided.
    if (Runtime.wants("breeding.egg_created")) {
      const motherSlot = Breeding.motherSlot(data, dc.man.mon, dc.lady.mon);
      Runtime.emit("breeding.egg_created", {
        egg: dc.egg,
        mother: motherSlot === 1 ? dc.man.mon : dc.lady.mon,
        father: motherSlot === 1 ? dc.lady.mon : dc.man.mon,
        compatibility: value,
        stepsToEgg: dc.stepsToEgg,
      });
    }
    return true;
  },

  // ------------------------------------------------------------------ walking

  // Lua: Breeding.lua:980 -- DayCareStep, once per overworld step.
  dayCareStep(data: BreedData | undefined, save: any, rng?: Rng): boolean {
    const dc = Breeding.dayCare(save);
    if (!dc) return false;
    growDeposited(dc.man);
    growDeposited(dc.lady);

    // .check_egg only while flagged compatible.
    if (!dc.compatible) return false;
    // `dec [hl] / ret nz` on a byte: 0 wraps to 255.
    dc.stepsToEgg = mod((dc.stepsToEgg ?? 0) - 1, 256);
    if (dc.stepsToEgg !== 0) return false;

    // The NEXT countdown is a plain byte.
    dc.stepsToEgg = randomByte(rng);
    const value = Breeding.compatibility(data, dc.man.mon, dc.lady.mon, { dayCare: true });
    if (randomByte(rng) >= Breeding.eggChance(value)) return false;
    dc.compatible = false;
    dc.hasEgg = true;
    return true;
  },

  // Lua: Breeding.lua:1009 -- DoEggStep: one tick off eggs in party order,
  // stopping the moment one reaches zero.
  doEggStep(save: any): boolean {
    for (const mon of (save && save.party) || []) {
      if (Breeding.isEgg(mon)) {
        mon.eggSteps = mod((mon.eggSteps ?? 0) - 1, 256);
        if (mon.eggSteps === 0) return true;
      }
    }
    return false;
  },

  // Lua: Breeding.lua:1024 -- the step block: wStepCount++, DoEggStep at $80
  // (a hatch skips DayCareStep), then DayCareStep. "hatch" or undefined.
  step(data: BreedData | undefined, save: any, rng?: Rng): "hatch" | undefined {
    if (save === null || typeof save !== "object") return undefined;
    save.stepCount = mod((save.stepCount ?? 0) + 1, Breeding.STEP_CYCLE);
    if (save.stepCount === Breeding.EGG_STEP_PHASE) {
      if (Breeding.doEggStep(save)) return "hatch";
    }
    Breeding.dayCareStep(data, save, rng);
    return undefined;
  },

  // Lua: Breeding.lua:1036 -- footfalls still owed (counter is in 256-step
  // cycles).
  stepsToHatch(mon: BreedMon | undefined): number | undefined {
    if (!Breeding.isEgg(mon)) return undefined;
    return (mon!.eggSteps ?? 0) * Breeding.STEP_CYCLE;
  },

  // ------------------------------------------------------ collecting, hatching

  // Lua: Breeding.lua:1048 -- DayCare_GiveEgg, then the DayCare_InitBreeding
  // that rolls the next egg. Returns [true, egg] or [false, reason].
  collectEgg(data: BreedData, save: any, opts?: BreedOpts): [boolean, BreedMon | string] {
    const dc = Breeding.dayCare(save);
    if (!(dc && dc.hasEgg)) return [false, Breeding.REFUSE_NO_MON];
    save.party = save.party || [];
    // `.PartyFull` keeps the egg for later.
    if (save.party.length >= Breeding.PARTY_SIZE) {
      return [false, Breeding.REFUSE_PARTY_FULL];
    }
    const egg = dc.egg;
    if (!egg) return [false, Breeding.REFUSE_NO_MON];
    save.party.push(egg);
    dc.egg = undefined;
    dc.hasEgg = false;
    Breeding.initBreeding(data, save, opts);
    return [true, egg];
  },

  // Lua: Breeding.lua:1066 -- HatchEggs' loop condition. 1-based slots.
  readyToHatch(save: any): number[] {
    const out: number[] = [];
    const party: BreedMon[] = (save && save.party) || [];
    party.forEach((mon, i) => {
      if (Breeding.isEgg(mon) && (mon.eggSteps ?? 0) === 0) out.push(i + 1);
    });
    return out;
  },

  // Lua: Breeding.lua:1087 -- HatchEggs for one (1-based) slot. Returns
  // [hatchling, { species, togepi }] or [undefined, undefined]. `where` is
  // SetEggMonCaughtData's site: landmark, timeOfDay, playerGender
  // (engine/pokemon/breeding.asm:228).
  hatch(data: BreedData, save: any, index: number, nickname?: string, where?: { landmark?: unknown; timeOfDay?: unknown; playerGender?: unknown }): [BreedMon | undefined, { species: string | undefined; togepi: boolean } | undefined] {
    const party: BreedMon[] = (save && save.party) || [];
    const egg = party[index - 1];
    if (!Breeding.isEgg(egg)) return [undefined, undefined];
    const def = defOf(data, egg!.species);
    if (!def) return [undefined, undefined];

    const hatched: BreedMon | undefined = Mon.new(data, egg!.species as string, egg!.level ?? Breeding.EGG_LEVEL, {
      dvs: egg!.dvs,
      moves: egg!.moves,
      nickname,
      happiness: Breeding.HATCH_HAPPINESS,
    });
    if (!hatched) return [undefined, undefined];
    hatched.experience = egg!.experience;
    // HP := MaxHP.
    hatched.hp = hatched.maxHp;
    // HatchEggs overwrites OT unconditionally -- breeding.asm:299-309.
    hatched.ot = (save.player && save.player.name) ?? egg!.ot;
    hatched.otId = (save.player && save.player.id) ?? egg!.otId;
    hatched.caughtLevel = egg!.level ?? Breeding.EGG_LEVEL;
    // SetEggMonCaughtData -- engine/pokemon/caught_data.asm:235-246.
    if (Mon.hasCaughtData(save && save.version)) {
      where = where || {};
      Mon.setCaughtData(hatched, {
        level: Mon.CAUGHT_EGG_LEVEL,
        timeOfDay: where.timeOfDay,
        landmark: where.landmark,
        playerGender: where.playerGender ?? (save.player && save.player.gender),
      });
    }
    party[index - 1] = hatched;

    Breeding.markPokedex(save, egg!.species);
    // egg.hatched, raised after the slot is replaced and the #DEX marked.
    if (Runtime.wants("egg.hatched")) {
      Runtime.emit("egg.hatched", {
        mon: hatched, egg, slot: index,
        species: egg!.species, nickname,
      });
    }
    return [hatched, {
      species: egg!.species,
      togepi: egg!.species === Breeding.TOGEPI,
    }];
  },

  // Lua: Breeding.lua:1149 -- SetSeenAndCaughtMon.
  markPokedex(save: any, species: string | undefined): boolean {
    if (!(save && species != null)) return false;
    save.pokedex = save.pokedex || {};
    save.pokedex.seen = save.pokedex.seen || {};
    save.pokedex.caught = save.pokedex.caught || {};
    save.pokedex.seen[species] = true;
    save.pokedex.caught[species] = true;
    return true;
  },
};

export default Breeding;
