// gen1recomp src/core/gen2/Happiness.lua at bdfac727 (MIT): Gen 2
// friendship.
//
// Two mechanisms from the cart (engine/events/happiness_egg.asm):
//   ChangeHappiness applies one of the HAPPINESS_* events to one party mon;
//   the step comes from HappinessChanges (data/events/happiness_changes.asm),
//   whose three columns are "< 100", "< 200" and "otherwise", read off the
//   value BEFORE the change.
//   StepHappiness raises the party by one when wStepCount wraps, and only on
//   every OTHER call (its own toggle): one point per 512 footfalls.
// Both refuse to touch an EGG (its byte is the hatch counter; the port keeps
// that on `mon.eggSteps`, see Breeding.ts, but honours the gate).
//
// Indices: HAPPINESS_* event numbers and tiers are the cart's 1-based values;
// only the CHANGES table reads subtract 1. firstMon returns the mon only (the
// Lua's second value, the slot, is read by no caller).

import { Runtime } from "../shared/mods/Runtime.ts";
import { mod, tonumber } from "../platform/lua.ts";

/** A party record, as far as this module reads it. */
export interface HappyMon {
  happiness?: number;
  hp?: number;
  isEgg?: boolean;
  caughtLocation?: unknown;
  [k: string]: any;
}

export type HappinessEvent = string | number;

// Lua: Happiness.lua:50 -- happiness.changed, from the two routines that move
// the byte; delta is `to - from`, after the clamps.
function emitChanged(mon: HappyMon, event: HappinessEvent | undefined, reason: string, from: number, to: number): void {
  if (!Runtime.wants("happiness.changed")) return;
  Runtime.emit("happiness.changed", {
    mon, event, reason,
    delta: to - from, from, to,
  });
}

// Lua: Happiness.lua:156 -- ChangeHappiness's `cp EGG / ret z`; matches
// Breeding.isEgg without requiring it.
function isEgg(mon: unknown): boolean {
  return mon !== null && typeof mon === "object" && (mon as HappyMon).isEgg === true;
}

export const Happiness = {
  // Lua: Happiness.lua:59-65 -- "significant happiness values".
  BASE: 70,
  FRIEND_BALL: 200,
  TO_EVOLVE: 220,
  THRESHOLD_1: 100,
  THRESHOLD_2: 200,
  // The byte's own ceiling; the floor is 0.
  MAX: 255,

  // Lua: Happiness.lua:70 -- the HAPPINESS_* enum (`const_def 1`, 1-based).
  EVENT: {
    GAINLEVEL: 1, // 01
    USEDITEM: 2, // 02  a vitamin
    USEDXITEM: 3, // 03  X ATTACK / X DEFEND / X SPEED / X SPECIAL
    GYMBATTLE: 4, // 04
    LEARNMOVE: 5, // 05  a TM, not an HM
    FAINTED: 6, // 06
    POISONFAINT: 7, // 07
    BEATENBYSTRONGFOE: 8, // 08
    OLDERCUT1: 9, // 09
    OLDERCUT2: 10, // 0a
    OLDERCUT3: 11, // 0b
    YOUNGCUT1: 12, // 0c
    YOUNGCUT2: 13, // 0d
    YOUNGCUT3: 14, // 0e
    BITTERPOWDER: 15, // 0f  HEAL POWDER / ENERGYPOWDER
    ENERGYROOT: 16, // 10
    REVIVALHERB: 17, // 11
    GROOMING: 18, // 12
    // Crystal only; Gold's enum stops at GROOMING
    // (pokegold constants/pokemon_data_constants.asm:205).
    GAINLEVELATHOME: 19, // 13
  } as Record<string, number>,
  NUM_EVENTS: 19,

  // Lua: Happiness.lua:97 -- data/events/happiness_changes.asm, row for row
  // (row n-1 is event n; columns are the three tiers).
  CHANGES: [
    [5, 3, 2], // 01 Gained a level
    [5, 3, 2], // 02 Vitamin
    [1, 1, 0], // 03 X Item
    [3, 2, 1], // 04 Battled a Gym Leader
    [1, 1, 0], // 05 Learned a move
    [-1, -1, -1], // 06 Lost to an enemy
    [-5, -5, -10], // 07 Fainted due to poison
    [-5, -5, -10], // 08 Lost to a much stronger enemy
    [1, 1, 1], // 09 Haircut (older brother) 1
    [3, 3, 1], // 0a Haircut (older brother) 2
    [5, 5, 2], // 0b Haircut (older brother) 3
    [1, 1, 1], // 0c Haircut (younger brother) 1
    [3, 3, 1], // 0d Haircut (younger brother) 2
    [10, 10, 4], // 0e Haircut (younger brother) 3
    [-5, -5, -10], // 0f Used Heal Powder or Energypowder (bitter)
    [-10, -10, -15], // 10 Used Energy Root (bitter)
    [-15, -15, -20], // 11 Used Revival Herb (bitter)
    [3, 3, 1], // 12 Grooming
    [10, 6, 4], // 13 Gained a level where it was caught (Crystal)
  ] as number[][],

  // Lua: Happiness.lua:122 -- which column a CURRENT value reads, 1-based.
  tier(value?: number): number {
    value = value ?? 0;
    if (value < Happiness.THRESHOLD_1) return 1;
    if (value < Happiness.THRESHOLD_2) return 2;
    return 3;
  },

  // Lua: Happiness.lua:132 -- "GAINLEVEL", "HAPPINESS_GAINLEVEL" or the number.
  eventIndex(event: unknown): number | undefined {
    if (typeof event === "number") {
      if (event >= 1 && event <= Happiness.NUM_EVENTS) return event;
      return undefined;
    }
    if (typeof event !== "string") return undefined;
    const m = /^HAPPINESS_(.+)$/.exec(event);
    const name = m ? m[1]! : event;
    return Object.prototype.hasOwnProperty.call(Happiness.EVENT, name) ? Happiness.EVENT[name] : undefined;
  },

  // Lua: Happiness.lua:145 -- the signed step at a current value.
  delta(event: unknown, current?: number): number | undefined {
    const index = Happiness.eventIndex(event);
    if (!index) return undefined;
    const row = Happiness.CHANGES[index - 1];
    if (!row) return undefined;
    return row[Happiness.tier(current) - 1];
  },

  // Lua: Happiness.lua:168 -- ChangeHappiness. Returns the new value, or
  // undefined when nothing moved. The clamps are the cart's carry checks.
  change(mon: HappyMon | undefined, event: HappinessEvent): number | undefined {
    if (mon === null || typeof mon !== "object" || isEgg(mon)) return undefined;
    const current = mon.happiness ?? 0;
    const delta = Happiness.delta(event, current);
    if (delta == null) return undefined;
    let value = current + delta;
    if (value > Happiness.MAX) value = Happiness.MAX;
    if (value < 0) value = 0;
    mon.happiness = value;
    emitChanged(mon, event, "event", current, value);
    return value;
  },

  // Lua: Happiness.lua:183 -- LevelUpHappinessMod: caught location masked
  // with CAUGHT_LOCATION_MASK against the landmark
  // (engine/pokemon/level_up_happiness.asm:1-20).
  levelUpEvent(mon: HappyMon | undefined, landmark: unknown): string {
    const caught = mon !== null && typeof mon === "object" ? tonumber(mon.caughtLocation) : undefined;
    const mark = tonumber(landmark);
    if (!(caught != null && mark != null)) return "GAINLEVEL";
    if (mod(Math.floor(caught), 0x80) !== mod(Math.floor(mark), 0x80)) {
      return "GAINLEVEL";
    }
    return "GAINLEVELATHOME";
  },

  // Lua: Happiness.lua:194 -- level_up_happiness.asm:19.
  levelUp(mon: HappyMon | undefined, landmark: unknown): number | undefined {
    return Happiness.change(mon, Happiness.levelUpEvent(mon, landmark));
  },

  // Lua: Happiness.lua:211 -- the Gym Leader award: fainted mons skipped
  // unless opts.includeFainted. Returns how many moved.
  changeParty(party: HappyMon[] | undefined, event: HappinessEvent, opts?: { includeFainted?: boolean }): number {
    opts = opts || {};
    let touched = 0;
    for (const mon of party || []) {
      const alive = (mon.hp ?? 0) > 0 || opts.includeFainted;
      if (alive && Happiness.change(mon, event) != null) touched = touched + 1;
    }
    return touched;
  },

  // Lua: Happiness.lua:227 -- StepHappiness with its own 1/0 toggle; 255
  // sticks. True on the calls that raised the party.
  stepCycle(save: any): boolean {
    if (save === null || typeof save !== "object") return false;
    save.happinessStepCount = mod((save.happinessStepCount ?? 0) + 1, 2);
    if (save.happinessStepCount !== 0) return false;
    for (const mon of (save.party || []) as HappyMon[]) {
      if (!isEgg(mon)) {
        const from = mon.happiness ?? 0;
        mon.happiness = Math.min(Happiness.MAX, from + 1);
        if (mon.happiness !== from) {
          emitChanged(mon, undefined, "step", from, mon.happiness);
        }
      }
    }
    return true;
  },

  // Lua: Happiness.lua:255 -- one footfall: StepHappiness on the step that
  // wraps wStepCount to 0. Call AFTER Breeding.step (it owns save.stepCount).
  step(save: any): boolean {
    if (save === null || typeof save !== "object") return false;
    if ((save.stepCount ?? 0) !== 0) return false;
    return Happiness.stepCycle(save);
  },

  // Lua: Happiness.lua:264 -- footfalls owed before the next party point.
  stepsToGain(save: any): number | undefined {
    if (save === null || typeof save !== "object") return undefined;
    const cycle = 256;
    let toWrap = mod(cycle - (save.stepCount ?? 0), cycle);
    if (toWrap === 0) toWrap = cycle;
    // A toggle at 1 means the NEXT wrap pays out.
    if ((save.happinessStepCount ?? 0) === 1) return toWrap;
    return toWrap + cycle;
  },

  // Lua: Happiness.lua:277-278 -- HappinessCheckScript's `ifless 50/150`.
  RATER_UNHAPPY: 50,
  RATER_KINDA: 150,

  // Lua: Happiness.lua:280
  raterBand(value?: number): string {
    value = value ?? 0;
    if (value < Happiness.RATER_UNHAPPY) return "unhappy";
    if (value < Happiness.RATER_KINDA) return "kinda";
    return "happy"; // HappinessText3
  },

  // Lua: Happiness.lua:289 -- GetFirstPokemonHappiness: the first non-egg.
  firstMon(party: HappyMon[] | undefined): HappyMon | undefined {
    for (const mon of party || []) {
      if (!isEgg(mon)) return mon;
    }
    return undefined;
  },

  // Lua: Happiness.lua:303 -- BASE_HAPPINESS, or FRIEND_BALL for that ball.
  forNewMon(opts?: { ball?: string }): number {
    opts = opts || {};
    if (opts.ball === "FRIEND_BALL") return Happiness.FRIEND_BALL;
    return Happiness.BASE;
  },
};

export default Happiness;
