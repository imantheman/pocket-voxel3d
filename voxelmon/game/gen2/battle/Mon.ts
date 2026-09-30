// A Gen 2 party member: a port of gen1recomp src/battle/gen2/Mon.lua
// (bdfac727, MIT) -- stats, moves, level-up and experience.
//
// Separate from src/pokemon/Pokemon.lua because the struct itself changed:
// Gen 2 splits `special` into Special Attack and Special Defense, adds a held
// item, happiness and pokerus, and its level-up moves come from EvosAttacks
// rather than a Gen 1 learnset table.
//
// Stat formula is unchanged from Gen 1 (data/pokemon/base_stats + DVs):
//   stat = floor((base * 2 + DV * 2 + floor(sqrt(statExp) / 4)) * level / 100) + 5
//   HP is the same but + level + 10
// with the Gen 2 twist that a mon's SpA and SpD share one Special DV, which is
// why a high-Special DV raises both.
//
// Experience curves come from data/growth_rates.asm, whose `growth_rate` macro
// documents its own polynomial:
//   [1]/[2] * n^3 + [3] * n^2 + [4] * n - [5]
// with a sign bit on the n^2 term.  pokemon.lua carries those five numbers per
// GROWTH_* so this needs no hardcoded table.
//
// The mod event bus: pokemon.level_up and pokemon.move_learned are the SAME
// names src/battle/Experience.lua and src/battle/BattleState.lua raise on
// Gen 1, with the same payload keys (docs/mod-api-gen2-compat.md).

import { GameVersion } from "../shared/core/GameVersion.ts";
import { Unown } from "../core/Unown.ts";
import { Runtime } from "../shared/mods/Runtime.ts";
import { mod, sortedKeys, tonumber, tostring, truthy } from "../platform/lua.ts";
import { random } from "../platform/rng.ts";

/** A party / box mon record (open shape, as the Lua table is). */
export type MonRecord = Record<string, any>;

/** The four stored DVs, plus the derived HP DV once Mon.new has set it. */
export interface Dvs {
  hp?: number;
  attack?: number;
  defense?: number;
  speed?: number;
  special?: number;
  /** read as a fallback for `special` by Mon.stats */
  specialAttack?: number;
  specialDefense?: number;
  [k: string]: any;
}

export interface BaseStats {
  hp?: number;
  attack?: number;
  defense?: number;
  speed?: number;
  specialAttack?: number;
  specialDefense?: number;
  [k: string]: any;
}

export interface Stats {
  hp: number;
  attack: number;
  defense: number;
  speed: number;
  specialAttack: number;
  specialDefense: number;
}

/** The five stat exp words (Mon.STAT_EXP_ORDER); older records may carry specialAttack/specialDefense. */
export type StatExp = Record<string, number>;

/** A GROWTH_* coefficient row off data.pokemon.growthRates, or a registry record with expForLevel. */
export interface Growth {
  numerator?: number;
  denominator?: number;
  squared?: number;
  linear?: number;
  constant?: number;
  expForLevel?: (level: number) => number | undefined;
  [k: string]: any;
}

export interface MoveSlot {
  id: any;
  pp: number;
  maxPp: number;
}

export interface MonNewOpts {
  dvs?: Dvs;
  statExp?: StatExp;
  nickname?: string;
  pokerus?: number;
  hp?: number;
  moves?: MoveSlot[];
  item?: string;
  happiness?: number;
  caughtLevel?: number;
  caughtTime?: number;
  caughtLocation?: number;
  caughtByGender?: string;
  shiny?: boolean;
  [k: string]: any;
}

export interface ShinyGenderCtx {
  species?: string;
  def?: any;
  level?: number;
}

export interface GainResult {
  levels: number;
  learned: any[];
  from?: number;
  to?: number;
}

// Lua: Mon.lua:55 -- wTimeOfDay is only MORN / DAY / NITE (engine/rtc/rtc.asm:48-55),
// stored `inc a`'d so 0 stays free -- engine/pokemon/caught_data.asm:169-172.
const CAUGHT_TIME: Record<string, number> = { MORN: 1, DAY: 2, NITE: 3, DARK: 3 };

// Lua: Mon.lua:67 -- wPlayerGender's bit 0 is PLAYERGENDER_FEMALE_F (constants/ram_constants.asm:177).
const CAUGHT_GENDER: Record<string, string> = {
  girl: "girl",
  female: "girl",
  boy: "boy",
  male: "boy",
};

// Lua: Mon.lua:78
function landmarkByte(landmark: unknown): number {
  if (typeof landmark !== "number") return 0;
  return mod(Math.floor(landmark), 0x80);
}

// Lua: Mon.lua:132
function rand(a: number, b: number): number {
  return random(a, b);
}

// Lua: Mon.lua:158
function statValue(base: number | undefined, dv: number | undefined, level: number, statExp: number | undefined): number {
  const exp = Math.floor(Math.sqrt(statExp ?? 0) / 4);
  return Math.floor((((base ?? 1) * 2 + (dv ?? 0) * 2 + exp) * level) / 100) + 5;
}

// Lua: Mon.lua:552
const GENDERS: Record<string, boolean> = { male: true, female: true, unknown: true };

/** ipairs: the 1..n run up to the first nil. */
function ipairs<T>(t: T[] | undefined | null): T[] {
  const out: T[] = [];
  if (!t) return out;
  for (const v of t) {
    if (v === undefined || v === null) break;
    out.push(v);
  }
  return out;
}

export const Mon = {
  MAX_LEVEL: 100,
  PARTY_SIZE: 6,

  // DVs are 0..15 each; Attack's low bit pair also decides gender and shininess.
  MAX_DV: 15,

  // MON_CAUGHTDATA's two packed bytes and their masks --
  // constants/pokemon_data_constants.asm:93-99, :120-130.
  CAUGHT_TIME_MASK: 0xc0,
  CAUGHT_LEVEL_MASK: 0x3f,
  CAUGHT_GENDER_MASK: 0x80,
  CAUGHT_LOCATION_MASK: 0x7f,
  CAUGHT_EGG_LEVEL: 1,
  // constants/landmark_constants.asm:111-113
  LANDMARK_EVENT: 0x7f,
  LANDMARK_GIFT: 0x7e,

  // CAUGHT_BY_UNKNOWN / GIRL / BOY, the code SetGiftMonCaughtData takes in `b`
  // (constants/pokemon_data_constants.asm:126-128).
  CAUGHT_BY: { unknown: 0, girl: 1, boy: 2 } as Record<string, number>,

  // The five stat exp words, in struct order.  There is no sixth: see Mon.stats.
  STAT_EXP_ORDER: ["hp", "attack", "defense", "speed", "special"],

  // Each word is 16 bit and GiveExperiencePoints stops it at $ffff rather than
  // letting it wrap (.stat_exp_maxed_out).
  MAX_STAT_EXP: 65535,

  // Lua: Mon.lua:49 -- Gold spends the same word on `rb_skip 2` and has no
  // SetCaughtData -- pokegold constants/pokemon_data_constants.asm:93.
  hasCaughtData(version?: string): boolean {
    return GameVersion.engine(version) === "crystal";
  },

  // Lua: Mon.lua:57
  caughtTimeOf(timeOfDay: unknown): number {
    if (typeof timeOfDay === "string") return CAUGHT_TIME[timeOfDay] ?? 0;
    if (typeof timeOfDay !== "number") return 0;
    let id = Math.floor(timeOfDay);
    if (id < 0 || id > 3) return 0;
    if (id > 2) id = 2;
    return id + 1;
  },

  // Lua: Mon.lua:71
  caughtGenderOf(gender: unknown): string | undefined {
    if (gender === true) return "girl";
    if (gender === false) return "boy";
    if (typeof gender !== "string") return undefined;
    return CAUGHT_GENDER[gender.toLowerCase()];
  },

  // Lua: Mon.lua:85 -- SetBoxmonOrEggmonCaughtData (engine/pokemon/caught_data.asm:168-199);
  // the egg path hands CAUGHT_EGG_LEVEL in as `level` (:239-242).
  setCaughtData(mon: any, opts?: Record<string, any>): any {
    if (typeof mon !== "object" || mon === null) return mon;
    opts = opts ?? {};
    mon.caughtTime = Mon.caughtTimeOf(opts.timeOfDay);
    mon.caughtLevel = Math.max(0, Math.floor(opts.level ?? mon.level ?? 0));
    mon.caughtLocation = landmarkByte(opts.landmark);
    mon.caughtByGender = Mon.caughtGenderOf(opts.playerGender) ?? "boy";
    return mon;
  },

  // Lua: Mon.lua:101 -- SetGiftMonCaughtData (engine/pokemon/caught_data.asm:226-233): `rrc b / or
  // LANDMARK_GIFT` puts CAUGHT_BY_BOY on $7f, LANDMARK_EVENT, not on a gender bit.
  setGiftCaughtData(mon: any, caughtBy?: unknown): any {
    if (typeof mon !== "object" || mon === null) return mon;
    const code = Mon.CAUGHT_BY[tostring(caughtBy).toLowerCase()] ?? 0;
    const rotated = Math.floor(code / 2) + mod(code, 2) * Mon.CAUGHT_GENDER_MASK;
    const unpacked = Mon.unpackCaughtData(0, Mon.LANDMARK_GIFT + rotated);
    mon.caughtTime = 0;
    mon.caughtLevel = 0;
    mon.caughtLocation = unpacked.caughtLocation;
    mon.caughtByGender = unpacked.caughtByGender;
    return mon;
  },

  // Lua: Mon.lua:113 -- the packed pair, as engine/pokemon/caught_data.asm:169-199 stores it.
  // (The Lua returns two values; here a [byte0, byte1] pair.)
  packCaughtData(mon: any): [number, number] {
    mon = typeof mon === "object" && mon !== null ? mon : {};
    const time = mod(Math.floor(tonumber(mon.caughtTime) ?? 0), 4);
    const level = mod(Math.floor(tonumber(mon.caughtLevel) ?? 0), 0x40);
    const location = landmarkByte(tonumber(mon.caughtLocation) ?? 0);
    const female = Mon.caughtGenderOf(mon.caughtByGender) === "girl";
    return [time * 0x40 + level, (female ? Mon.CAUGHT_GENDER_MASK : 0) + location];
  },

  // Lua: Mon.lua:122
  unpackCaughtData(
    byte0?: number,
    byte1?: number,
  ): { caughtTime: number; caughtLevel: number; caughtLocation: number; caughtByGender: string } {
    const b0 = mod(Math.floor(byte0 ?? 0), 256);
    const b1 = mod(Math.floor(byte1 ?? 0), 256);
    return {
      caughtTime: Math.floor(b0 / 0x40),
      caughtLevel: mod(b0, 0x40),
      caughtLocation: mod(b1, 0x80),
      caughtByGender: b1 >= Mon.CAUGHT_GENDER_MASK ? "girl" : "boy",
    };
  },

  // Lua: Mon.lua:139
  randomDVs(): Dvs {
    return {
      hp: undefined, // derived below
      attack: rand(0, Mon.MAX_DV),
      defense: rand(0, Mon.MAX_DV),
      speed: rand(0, Mon.MAX_DV),
      special: rand(0, Mon.MAX_DV),
    };
  },

  // Lua: Mon.lua:152 -- the HP DV is not stored: it is the low bit of each of
  // the other four (Gen 1 and 2 both build it this way), which is why a
  // perfect-HP mon needs all four others odd.
  hpDV(dvs: Dvs): number {
    const bit = (value: number | undefined): number => mod(value ?? 0, 2);
    return bit(dvs.attack) * 8 + bit(dvs.defense) * 4 + bit(dvs.speed) * 2 + bit(dvs.special);
  },

  // Lua: Mon.lua:164 -- all six stats at a level.  `statExp` is optional per-stat effort.
  stats(baseStats: BaseStats | undefined, dvs: Dvs | undefined, level: number, statExp?: StatExp): Stats {
    const base = baseStats ?? {};
    const d = dvs ?? {};
    const se = statExp ?? {};
    // engine/pokemon/move_mon.asm:1540
    let specialDv = d.special;
    if (specialDv == null) {
      specialDv = d.specialAttack ?? d.specialDefense;
    }
    // engine/pokemon/move_mon.asm:1496
    const hpDv = Mon.hpDV({
      attack: d.attack,
      defense: d.defense,
      speed: d.speed,
      special: specialDv,
    });
    const hp =
      Math.floor((((base.hp ?? 1) * 2 + hpDv * 2 + Math.floor(Math.sqrt(se.hp ?? 0) / 4)) * level) / 100) +
      level +
      10;
    return {
      hp,
      attack: statValue(base.attack, d.attack, level, se.attack),
      defense: statValue(base.defense, d.defense, level, se.defense),
      speed: statValue(base.speed, d.speed, level, se.speed),
      // One Special DV feeds both special stats, and so does one Special stat
      // exp: the Gen 2 party struct kept Gen 1's five exp words (macros/ram.asm
      // box_struct ends them at SpcExp), so SpA and SpD grow together.  The
      // per-stat keys are still read as a fallback for a record written before
      // the shared word existed.
      specialAttack: statValue(base.specialAttack, specialDv, level, se.special ?? se.specialAttack),
      specialDefense: statValue(base.specialDefense, specialDv, level, se.special ?? se.specialDefense),
    };
  },

  // Lua: Mon.lua:203 -- the species string is the source of truth.  `mon.name`
  // is a copy of that species' display name (GetPokemonName), kept so menus can
  // print without a Data lookup.  It is NOT the nickname: an un-nicknamed mon
  // has nickname nil and prints this copy.
  syncIdentity(mon: any, data: any): any {
    if (typeof mon !== "object" || mon === null) return mon;
    const def = data && data.pokemon && data.pokemon[mon.species];
    if (!truthy(def)) return mon;
    mon.name = def.name ?? mon.species;
    if (truthy(def.types)) mon.types = def.types;
    if (truthy(mon.dvs)) {
      mon.gender = Mon.gender(def, mon.dvs, { species: mon.species, level: mon.level });
      // shiny is monotonic once true, the same as opts.shiny winning over
      // shiny.roll at Mon.new: a forced shiny must not un-shiny the moment
      // this runs again (it runs on every SummaryMenu open via refreshStats).
      // A mon not already shiny still promotes normally if its DVs justify it.
      mon.shiny = truthy(mon.shiny)
        ? mon.shiny
        : Mon.isShiny(mon.dvs, { species: mon.species, def, level: mon.level });
      if (mon.species === Unown.SPECIES) {
        mon.unownLetter = Unown.letterFromDVs(mon.dvs);
      } else {
        mon.unownLetter = undefined;
      }
    }
    return mon;
  },

  // Lua: Mon.lua:233 -- every screen that prints a mon without a Data lookup
  // should go through here: nickname if the player set one, otherwise the
  // species display copy `name`.
  displayName(mon: any): string {
    if (typeof mon !== "object" || mon === null) return "?";
    return mon.nickname ?? mon.name ?? mon.species ?? "?";
  },

  // Lua: Mon.lua:241 -- party, boxes, both Day-Care sides, and a pending egg.
  eachSaveMon(save: any, fn: (mon: any) => void): void {
    if (typeof save !== "object" || save === null || typeof fn !== "function") return;
    for (const mon of ipairs(save.party ?? [])) fn(mon);
    const boxes = save.boxes ?? {};
    for (const key of sortedKeys(boxes)) {
      const box = boxes[key];
      if (typeof box === "object" && box !== null) {
        for (const mon of ipairs(box)) fn(mon);
      }
    }
    const dc = save.dayCare;
    if (typeof dc === "object" && dc !== null) {
      if (truthy(dc.man) && truthy(dc.man.mon)) fn(dc.man.mon);
      if (truthy(dc.lady) && truthy(dc.lady.mon)) fn(dc.lady.mon);
      if (truthy(dc.egg)) fn(dc.egg);
    }
    if (truthy(save.daycare) && truthy(save.daycare.mon)) fn(save.daycare.mon);
  },

  // Lua: Mon.lua:258
  syncSaveIdentity(save: any, data: any): void {
    Mon.eachSaveMon(save, (mon) => {
      Mon.syncIdentity(mon, data);
    });
  },

  // Lua: Mon.lua:262
  refreshStats(mon: any, data: any): any {
    if (typeof mon !== "object" || mon === null) return mon;
    const def = data && data.pokemon && data.pokemon[mon.species];
    if (!(truthy(def) && truthy(def.baseStats))) return mon;
    Mon.syncIdentity(mon, data);
    // engine/pokemon/move_mon.asm:1402
    const stats = Mon.stats(def.baseStats, mon.dvs, mon.level ?? 1, mon.statExp);
    mon.stats = stats;
    mon.maxHp = stats.hp;
    if (mon.hp == null || mon.hp > stats.hp) {
      mon.hp = stats.hp;
    }
    return mon;
  },

  // Lua: Mon.lua:284
  newStatExp(): StatExp {
    return { hp: 0, attack: 0, defense: 0, speed: 0, special: 0 };
  },

  // Lua: Mon.lua:306 -- GiveExperiencePoints' .stat_exp_loop (engine/battle/core.asm):
  // the defeated mon's base stats are added to every participant's stat exp,
  // and the loop runs NUM_EXP_STATS = 5 times over a six-entry base stat block,
  // so the Special word takes the loser's Special ATTACK and the Special
  // Defense base stat is never read at all.
  //
  // `.EvenlyDivideExpAmongParticipants` divides the base stats in place before
  // any of this, and only when two or more mons took part, which is why the
  // divisor is shared with Mon.experienceGain rather than computed here.
  //
  // Pokerus adds the same value a SECOND time -- doubled, not multiplied by a
  // rate, so it stacks with nothing.  `halved` is the EXP.SHARE tax: with any
  // holder in the party the whole wEnemyMon base stat block is `srl`'d in place
  // before EITHER pass runs, so participants and holders both draw stat exp
  // from the halved values.
  gainStatExp(
    mon: any,
    loserDef: any,
    participants?: number,
    doubled?: boolean,
    halved?: boolean,
  ): Record<string, number> | undefined {
    if (typeof mon !== "object" || mon === null) return undefined;
    const base = (truthy(loserDef) && loserDef.baseStats) || {};
    const share = Math.max(1, Math.floor(participants ?? 1));
    mon.statExp = mon.statExp ?? Mon.newStatExp();
    const gains: Record<string, number> = {};
    for (const key of Mon.STAT_EXP_ORDER) {
      let from = key === "special" && truthy(base.specialAttack) ? base.specialAttack : base[key];
      from = from ?? 0;
      if (truthy(halved)) from = Math.floor(from / 2);
      let gain = Math.floor(from / share);
      if (truthy(doubled)) gain = gain * 2;
      let value = (mon.statExp[key] ?? 0) + gain;
      if (value > Mon.MAX_STAT_EXP) value = Mon.MAX_STAT_EXP;
      mon.statExp[key] = value;
      gains[key] = gain;
    }
    return gains;
  },

  // Lua: Mon.lua:338 -- total experience needed to *be* `level`, from a GROWTH_*
  // record.  The merged growth_rates registry wins, then the extractor's own
  // coefficient rows on data.pokemon.growthRates.
  growthFor(data: any, curve: any): Growth | undefined {
    if (!truthy(curve)) return undefined;
    const registered = data && data.growth_rates && data.growth_rates[curve];
    if (truthy(registered)) return registered;
    return data && data.pokemon && data.pokemon.growthRates && data.pokemon.growthRates[curve];
  },

  // Lua: Mon.lua:350 -- seeds the growth_rates registry with Gold's own curves,
  // as records carrying expForLevel.  A dataset with no coefficient rows seeds
  // nothing rather than registering broken curves.
  registerInto(registry: any, data: any, owner?: any): void {
    const rows = data && data.pokemon && data.pokemon.growthRates;
    if (typeof rows !== "object" || rows === null) return;
    for (const curve of sortedKeys(rows)) {
      const row = rows[curve];
      // the closure holds the coefficient row, so the registered record computes
      // exactly what the arm below would have
      registry.register(
        curve,
        {
          expForLevel: (level: number) => Mon.experienceForLevel(row, level),
        },
        owner,
      );
    }
  },

  // Lua: Mon.lua:369 -- `growth` is either the extractor's coefficient row
  // (numerator / denominator / squared / linear / constant, straight off
  // GrowthRates in the ROM) or a growth_rates REGISTRY record, which carries
  // expForLevel(level) instead.  A registered curve wins outright.
  experienceForLevel(growth: Growth | undefined | null, level: number): number {
    if (truthy(growth) && truthy(growth!.expForLevel)) {
      return Math.max(0, Math.floor(growth!.expForLevel!(level) ?? 0));
    }
    if (!truthy(growth)) return level * level * level;
    const g = growth!;
    const n = level;
    const numerator = g.numerator ?? 1;
    const denominator = g.denominator ?? 1;
    let value = Math.floor((numerator * n * n * n) / denominator);
    value = value + (g.squared ?? 0) * n * n;
    value = value + (g.linear ?? 0) * n;
    value = value - (g.constant ?? 0);
    return Math.max(0, value);
  },

  // Lua: Mon.lua:387 -- the level a total experience buys.  Walks up rather
  // than inverting the polynomial, which the cart also does.
  levelForExperience(growth: Growth | undefined | null, experience: number): number {
    let level = 1;
    while (level < Mon.MAX_LEVEL) {
      if (experience < Mon.experienceForLevel(growth, level + 1)) break;
      level = level + 1;
    }
    return level;
  },

  // Lua: Mon.lua:399 -- the moves a species knows on arrival at `level`: its
  // last four level-up moves at or below it (EvosAttacks order, later moves
  // pushing earlier ones out).
  movesAtLevel(def: any, level: number, moves?: any): MoveSlot[] {
    const known: any[] = [];
    for (const entry of ipairs<any>((truthy(def) && def.levelMoves) || [])) {
      if (entry.level <= level) {
        // A move already known is not learned twice.
        let duplicate = false;
        for (const existing of known) {
          if (existing === entry.move) {
            duplicate = true;
            break;
          }
        }
        if (!duplicate) {
          known.push(entry.move);
          if (known.length > 4) known.shift();
        }
      }
    }
    const out: MoveSlot[] = [];
    for (const id of known) {
      const moveDef = moves && moves[id];
      out.push({
        id,
        pp: truthy(moveDef) && truthy(moveDef.pp) ? moveDef.pp : 0,
        maxPp: truthy(moveDef) && truthy(moveDef.pp) ? moveDef.pp : 0,
      });
    }
    return out;
  },

  // Lua: Mon.lua:428 -- build a party member.  `data` needs `pokemon` and
  // `moves`; growth records live on data.pokemon.growthRates.
  new(data: any, species: string, level?: number, opts?: MonNewOpts): MonRecord | undefined {
    opts = opts ?? {};
    const def = data && data.pokemon && data.pokemon[species];
    if (!truthy(def)) return undefined;
    const lvl = Math.max(1, Math.min(Mon.MAX_LEVEL, level ?? 5));
    const dvs = opts.dvs ?? Mon.randomDVs();
    dvs.hp = Mon.hpDV(dvs);
    const statExp = opts.statExp ?? Mon.newStatExp();
    const stats = Mon.stats(def.baseStats, dvs, lvl, statExp);
    const growth = Mon.growthFor(data, def.growthRate);
    let unownLetter: any = undefined;
    if (species === Unown.SPECIES) {
      const letter = Unown.letterFromDVs(dvs);
      unownLetter = truthy(letter) ? letter : undefined;
    }
    return {
      species,
      name: def.name ?? species,
      nickname: opts.nickname,
      level: lvl,
      experience: Mon.experienceForLevel(growth, lvl),
      dvs,
      // The five stat exp words.  A wild or gift mon starts at zero: nothing in
      // the cart seeds them, MON_STAT_EXP is zeroed by _MoveMon.
      statExp,
      // MON_PKRS.  Zero is "never infected"; src/core/gen2/Pokerus.lua owns every
      // read and write of it after this.
      pokerus: opts.pokerus ?? 0,
      stats,
      hp: opts.hp ?? stats.hp,
      maxHp: stats.hp,
      types: def.types,
      moves: opts.moves ?? Mon.movesAtLevel(def, lvl, data.moves),
      // Held item; wild mons roll one from BaseData's two item slots on the cart,
      // which is not modeled yet, so only scripted gifts carry one.
      item: opts.item,
      status: undefined,
      // 70 for a caught mon, 120 for a gift/hatched one.
      happiness: opts.happiness ?? 70,
      caughtLevel: opts.caughtLevel ?? lvl,
      // MON_CAUGHTDATA, absent on Gold -- constants/pokemon_data_constants.asm:93-99.
      caughtTime: opts.caughtTime,
      caughtLocation: opts.caughtLocation,
      caughtByGender: opts.caughtByGender,
      // shiny.roll / gender.roll get the species and level as context; opts.shiny
      // still wins, because a FORCED shiny battle (Red Gyarados) is the cart
      // overriding the roll rather than a roll to be hooked.
      shiny: truthy(opts.shiny) ? opts.shiny : Mon.isShiny(dvs, { species, def, level: lvl }),
      gender: Mon.gender(def, dvs, { species, level: lvl }),
      // Unown has no gender and no shininess worth looking at, but it does have
      // a FORM, and the form is the same DVs read a different way
      // (GetUnownLetter, engine/gfx/load_pics.asm).  Stamped at build time.
      unownLetter,
    };
  },

  // Lua: Mon.lua:485 -- AddPartyMon copies wPlayerName into wPartyMonOTs and
  // wPlayerID into MON_ID (move_mon.asm:44-56, :143-149); SendMonIntoBox does
  // the same (:970-994).
  stampOT(save: any, mon: any): any {
    const player = save && save.player;
    if (!(truthy(mon) && truthy(player))) return mon;
    if (player.id == null) player.id = rand(0, 65535);
    mon.ot = mon.ot ?? player.name;
    // NpcTrade.lua:150: `ot` is what Breeding reads, `otName` what the summary prints.
    mon.otName = mon.otName ?? mon.ot;
    // engine/battle/experience.asm:69: a traded mon keeps its own OT id
    if (!truthy(mon.traded)) mon.otId = mon.otId ?? player.id;
    return mon;
  },

  // Lua: Mon.lua:522 -- Gen 2 shininess: the classic DV pattern (Speed/Defense/
  // Special all 10, and Attack in {2,3,6,7,10,11,14,15}).
  vanillaShiny(dvs: Dvs | undefined | null): boolean {
    if (!truthy(dvs)) return false;
    const d = dvs!;
    if (d.speed !== 10 || d.defense !== 10 || d.special !== 10) {
      return false;
    }
    const attack = d.attack ?? 0;
    return mod(attack, 4) === 2 || mod(attack, 4) === 3;
  },

  // Lua: Mon.lua:531 -- shiny.roll wraps the DV-derived roll: on the cart
  // CheckShininess reads the same two DV bytes LoadEnemyMon just generated.
  isShiny(dvs: Dvs | undefined | null, ctx?: ShinyGenderCtx): boolean {
    if (!Runtime.wantsHook("shiny.roll")) return Mon.vanillaShiny(dvs);
    const shiny = Runtime.call(
      "shiny.roll",
      (c: { dvs: any }) => Mon.vanillaShiny(c.dvs),
      { dvs, species: ctx && ctx.species, def: ctx && ctx.def, level: ctx && ctx.level },
    );
    return truthy(shiny);
  },

  // Lua: Mon.lua:543 -- gender comes from the Attack DV against the species'
  // ratio threshold: an Attack DV *below* the threshold is female (BaseData's
  // `db GENDER_F12_5` is already scaled out of 256).
  vanillaGender(def: any, dvs: Dvs | undefined | null): string {
    const ratio = truthy(def) ? def.genderRatio : undefined;
    if (ratio == null || ratio === false) return "unknown";
    if (ratio === 0xff) return "unknown";
    // The DV is 0..15; the threshold is out of 256 in steps of 16.
    const threshold = Math.floor(ratio / 16);
    return ((truthy(dvs) ? dvs!.attack : undefined) ?? 0) < threshold ? "female" : "male";
  },

  // Lua: Mon.lua:554 -- gender.roll's ctx carries `ratio` as well; a chain that
  // returns something that is not one of "male" / "female" / "unknown" is ignored.
  gender(def: any, dvs: Dvs | undefined | null, ctx?: ShinyGenderCtx): string {
    if (!Runtime.wantsHook("gender.roll")) {
      return Mon.vanillaGender(def, dvs);
    }
    const gender: any = Runtime.call(
      "gender.roll",
      (c: { def: any; dvs: any }) => Mon.vanillaGender(c.def, c.dvs),
      {
        def,
        dvs,
        ratio: truthy(def) ? def.genderRatio : undefined,
        species: (ctx && ctx.species) ?? (truthy(def) ? def.id : undefined),
        level: ctx && ctx.level,
      },
    );
    if (!GENDERS[gender]) return Mon.vanillaGender(def, dvs);
    return gender;
  },

  // Lua: Mon.lua:577 -- experience for defeating `loser`, per recipient.  Gen 2:
  //   exp = baseExp * loserLevel / 7, split among the recipients of the pass,
  // then GiveExperiencePoints' three BoostExp arms in the cart's own order,
  // each a floored x1.5 on the running amount:
  //   traded    the mon's OT id differs from the player's (BoostedExpPointsText)
  //   trainer   a trainer battle (wBattleMode)
  //   luckyEgg  the mon HOLDS a LUCKY_EGG -- checked by item id, not held
  //             effect, exactly as the cart's `cp LUCKY_EGG` does
  // opts.halved is the EXP.SHARE tax.
  experienceGain(
    loserDef: any,
    loserLevel?: number,
    participants?: number,
    trainer?: boolean,
    opts?: { halved?: boolean; traded?: boolean; luckyEgg?: boolean; [k: string]: any },
  ): number {
    opts = opts ?? {};
    let baseExp = (truthy(loserDef) ? loserDef.baseExp : undefined) ?? 0;
    if (truthy(opts.halved)) baseExp = Math.floor(baseExp / 2);
    let value = Math.floor((baseExp * (loserLevel ?? 1)) / 7);
    value = Math.floor(value / Math.max(1, participants ?? 1));
    if (truthy(opts.traded)) value = Math.floor((value * 3) / 2);
    if (truthy(trainer)) value = Math.floor((value * 3) / 2);
    if (truthy(opts.luckyEgg)) value = Math.floor((value * 3) / 2);
    return Math.max(1, value);
  },

  // Lua: Mon.lua:590 -- pokecrystal/engine/battle/core.asm:7151
  partySpecies(mon: any): any {
    if (!truthy(mon)) return undefined;
    const state = truthy(mon.volatile) ? mon.volatile.preTransform : undefined;
    if (truthy(state) && truthy(state.species)) return state.species;
    if (truthy(mon.partySpecies)) return mon.partySpecies;
    return mon.species;
  },

  // Lua: Mon.lua:597 -- pokecrystal/engine/battle/core.asm:7251,7266
  writeStats(mon: any, stats: any): any {
    const state = truthy(mon.volatile) ? mon.volatile.preTransform : undefined;
    if (truthy(state) && truthy(state.stats)) {
      for (const key of Object.keys(state.stats)) state.stats[key] = stats[key];
      mon.stats = mon.stats ?? {};
      mon.stats.hp = stats.hp;
    } else {
      mon.stats = stats;
    }
    return stats;
  },

  // Lua: Mon.lua:611 -- award experience, level up as far as it reaches, and
  // report what happened so the battle can print "grew to level N!" and offer
  // new moves.
  gainExperience(mon: any, amount: number | undefined, data: any): GainResult {
    const def = data && data.pokemon && data.pokemon[Mon.partySpecies(mon)];
    const growth = Mon.growthFor(data, truthy(def) ? def.growthRate : undefined);
    mon.experience = (mon.experience ?? 0) + Math.max(0, amount ?? 0);
    const before: number = mon.level;
    const capped = Mon.experienceForLevel(growth, Mon.MAX_LEVEL);
    if (mon.experience > capped) mon.experience = capped;
    const after = Mon.levelForExperience(growth, mon.experience);
    if (after <= before) {
      return { levels: 0, learned: [] };
    }
    mon.level = after;
    // Recompute stats and carry the HP gain, the way the cart adds the delta
    // rather than refilling.
    const previousMax = mon.maxHp ?? (truthy(mon.stats) ? mon.stats.hp : undefined) ?? 1;
    const recalculated = Mon.writeStats(
      mon,
      Mon.stats(truthy(def) ? def.baseStats : undefined, mon.dvs, after, mon.statExp),
    );
    mon.maxHp = recalculated.hp;
    mon.hp = Math.min(mon.maxHp, (mon.hp ?? previousMax) + (mon.maxHp - previousMax));

    // pokemon.level_up, once per level crossed and after the stats were
    // recalculated, exactly as src/battle/Experience.lua raises it on Gen 1 --
    // a jump of three levels is three events, not one.
    const levelMoves: any[] = ipairs<any>((truthy(def) && def.levelMoves) || []);
    if (Runtime.wants("pokemon.level_up")) {
      for (let level = before + 1; level <= after; level++) {
        const learnable: any[] = [];
        for (const entry of levelMoves) {
          if (entry.level === level) learnable.push(entry.move);
        }
        Runtime.emit("pokemon.level_up", {
          mon,
          level,
          prevLevel: level - 1,
          learnable,
        });
      }
    }

    // Every level-up move between the old and new level is offered.
    const learned: any[] = [];
    for (const entry of levelMoves) {
      if (entry.level > before && entry.level <= after) {
        learned.push(entry.move);
      }
    }
    return { levels: after - before, learned, from: before, to: after };
  },

  // Lua: Mon.lua:660 -- teach a move, or report that all four slots are full so
  // the caller can ask which to forget.  The Lua returns `true`, `false, "known"`
  // or `false, "full", entry`; here the same as a tuple.
  learnMove(mon: any, moveId: any, data: any): [boolean, ("known" | "full")?, MoveSlot?] {
    mon.moves = mon.moves ?? [];
    for (const move of ipairs<any>(mon.moves)) {
      if (move.id === moveId) return [false, "known"];
    }
    const def = data && data.moves && data.moves[moveId];
    const entry: MoveSlot = {
      id: moveId,
      pp: truthy(def) && truthy(def.pp) ? def.pp : 0,
      maxPp: truthy(def) && truthy(def.pp) ? def.pp : 0,
    };
    if (mon.moves.length >= 4) return [false, "full", entry];
    mon.moves.push(entry);
    // pokemon.move_learned, the payload BattleState:learnMove emits on Gen 1.
    // This is Gen 2's single choke point for teaching a move -- the level-up
    // award, an evolution's new move and the TM path all arrive here.
    Runtime.emit("pokemon.move_learned", { mon, moveId });
    return [true];
  },

  // Lua: Mon.lua:682 -- which evolution (if any) fires at this level.
  evolutionAtLevel(def: any, level: number): any {
    for (const entry of ipairs<any>((truthy(def) && def.evolutions) || [])) {
      if (entry.method === "EVOLVE_LEVEL" && (entry.level ?? 0) <= level) {
        return entry;
      }
    }
    return undefined;
  },
};

export default Mon;
