// gen1recomp src/core/gen2/Pokerus.lua at bdfac727 (MIT): Pokerus, from
// engine/events/pokerus/pokerus.asm, check_pokerus.asm and
// apply_pokerus_tick.asm.
//
// One byte per party mon (`mon.pokerus`): high nybble the strain (0..8, never
// cleared once set), low nybble the days left (1..4). $00 never infected,
// $34 infected (spreads, doubles stat exp), $30 cured/immune (does not spread,
// cannot be reinfected, STILL doubles stat exp). Two cart quirks ported on
// purpose: .randomPokerusLoop can roll strain 0 ($01, which cures to $00 and
// is infectable again), and the spread walk stops at a neighbour whose low
// two bits are clear -- which includes a four-day infection. The de novo roll
// is gated on ENGINE_REACHED_GOLDENROD.
//
// Indices: party slots returned (give, applyTick) are 1-BASED as in the Lua.

import { BugContest } from "./BugContest.ts";
import { Runtime } from "../shared/mods/Runtime.ts";
import { mod, tonumber } from "../platform/lua.ts";
import { random as rngRandom } from "../platform/rng.ts";
import { engineFlagIdFor } from "./EngineFlagIds.ts";

/** A party record, as far as this module reads it. */
export interface PokerusMon {
  pokerus?: number;
  [k: string]: any;
}

/** A roller: no arguments, one byte 0..255 (`call Random`). */
export type ByteRoll = () => number;

// Lua: Pokerus.lua:52 -- pokerus.infected, raised from the two writes that
// turn a clean byte into an infected one.
function emitInfected(party: PokerusMon[] | undefined, slot: number, source: string): void {
  if (!Runtime.wants("pokerus.infected")) return;
  const mon = party && party[slot - 1];
  Runtime.emit("pokerus.infected", {
    party, slot, mon,
    strain: Pokerus.strain(mon), days: Pokerus.days(mon),
    source,
  });
}

// Lua: Pokerus.lua:81
function byte(roll?: ByteRoll): number {
  return (roll || Pokerus.random)();
}

// Lua: Pokerus.lua:182 -- .infectMon: the carrier's strain, and 1..4 days
// from its low two strain bits (`swap a / and $3 / inc a`). slot is 1-based.
function infect(party: PokerusMon[], slot: number, carrier: number): number | undefined {
  const mon = party[slot - 1];
  if (!mon) return undefined;
  const strainBits = carrier - mod(carrier, 16);
  const days = mod(Math.floor(carrier / 16), 4) + 1;
  mon.pokerus = strainBits + days;
  emitInfected(party, slot, "spread");
  return slot;
}

// Lua: Pokerus.lua:196 -- .TrySpreadPokerus from the first infected (1-based)
// slot. b is the number of slots from there to the end inclusive.
function spread(party: PokerusMon[], index: number, roll?: ByteRoll): number | undefined {
  const count = party.length;
  if (byte(roll) >= Pokerus.SPREAD_CHANCE) return undefined;
  if (count === 1) return undefined;
  let b = count - index + 1;
  let carrier = Pokerus.byteOf(party[index - 1]);
  let slot = index;
  // `cp 2 / jr c`: the last slot always walks backwards; otherwise a coin flip.
  const forward = b >= 2 && byte(roll) >= Pokerus.BACKWARD_CHANCE;
  if (forward) {
    for (;;) {
      slot = slot + 1;
      const value = Pokerus.byteOf(party[slot - 1]);
      if (value === 0) return infect(party, slot, carrier);
      carrier = value;
      if (mod(value, 4) === 0) return undefined;
      b = b - 1;
      if (b === 1) return undefined;
    }
  }
  for (;;) {
    // `ld a, [wPartyCount] / cp b / ret z`: at slot one, nothing before it.
    if (b === count) return undefined;
    slot = slot - 1;
    const value = Pokerus.byteOf(party[slot - 1]);
    if (value === 0) return infect(party, slot, carrier);
    carrier = value;
    if (mod(value, 4) === 0) return undefined;
    b = b + 1;
  }
}

export const Pokerus = {
  // Lua: Pokerus.lua:64 -- constants/engine_flags.asm index 21.
  ENGINE_REACHED_GOLDENROD: 21,

  // Lua: Pokerus.lua:68-69 -- `percent` is `* $ff / 100`: 85 and 128 of 256.
  SPREAD_CHANCE: Math.floor((33 * 0xff) / 100) + 1,
  BACKWARD_CHANCE: Math.floor((50 * 0xff) / 100) + 1,

  // Lua: Pokerus.lua:74 -- `call Random`: one byte, 0..255.
  random(): number {
    return rngRandom(0, 255);
  },

  // ------------------------------------------------------------ reading a mon

  // Lua: Pokerus.lua:87
  byteOf(mon: PokerusMon | undefined): number {
    const value = tonumber(mon && mon.pokerus) ?? 0;
    if (value < 0) return 0;
    return mod(Math.floor(value), 256);
  },

  // Lua: Pokerus.lua:93
  strain(mon: PokerusMon | undefined): number {
    return Math.floor(Pokerus.byteOf(mon) / 16);
  },

  // Lua: Pokerus.lua:97
  days(mon: PokerusMon | undefined): number {
    return mod(Pokerus.byteOf(mon), 16);
  },

  // Lua: Pokerus.lua:103 -- an active infection: the low nybble.
  isInfected(mon: PokerusMon | undefined): boolean {
    return Pokerus.days(mon) !== 0;
  },

  // Lua: Pokerus.lua:109 -- cured, carrying the strain as the immune marker.
  isImmune(mon: PokerusMon | undefined): boolean {
    const value = Pokerus.byteOf(mon);
    return value !== 0 && mod(value, 16) === 0;
  },

  // Lua: Pokerus.lua:116 -- GiveExperiencePoints tests the WHOLE byte.
  doublesStatExp(mon: PokerusMon | undefined): boolean {
    return Pokerus.byteOf(mon) !== 0;
  },

  // Lua: Pokerus.lua:122 -- _CheckPokerus.
  inParty(party: PokerusMon[] | undefined): boolean {
    for (const mon of party || []) {
      if (Pokerus.isInfected(mon)) return true;
    }
    return false;
  },

  // ----------------------------------------------------------- the daily tick

  // Lua: Pokerus.lua:136 -- ApplyPokerusTick: subtract `days`, clamped at 0,
  // strain kept. Returns the 1-based slots that cured.
  applyTick(party: PokerusMon[] | undefined, days: unknown): number[] {
    const cured: number[] = [];
    const n = Math.max(0, Math.floor(tonumber(days) ?? 0));
    (party || []).forEach((mon, i) => {
      const value = Pokerus.byteOf(mon);
      let left = mod(value, 16);
      if (left !== 0) {
        left = left - n;
        if (left < 0) left = 0;
        mon.pokerus = value - mod(value, 16) + left;
        if (left === 0) cured.push(i + 1);
      }
    });
    return cured;
  },

  // Lua: Pokerus.lua:162 -- CheckPokerusTick: CalcDaysSince advances the
  // stamp as it reads it; the first poll on an unstamped save ticks nothing.
  // `now` is BugContest.now()'s shape ({ day, hour, minute, second }).
  checkTick(save: any, now?: { day?: number; [k: string]: unknown }): boolean {
    if (save === null || typeof save !== "object") return false;
    if (save.pokerusStartDay == null) {
      save.pokerusStartDay = (now || BugContest.now()).day;
      return false;
    }
    const stamp = { day: save.pokerusStartDay };
    const since = BugContest.elapsedSince(stamp, now, "day");
    save.pokerusStartDay = stamp.day;
    if (since.days === 0) return false;
    Pokerus.applyTick(save.party || [], since.days);
    return true;
  },

  // -------------------------------------------------------------- catching it

  // Lua: Pokerus.lua:240 -- GivePokerusAndConvertBerries' Pokerus half, on a
  // battle WIN. Any active infection makes it a spread roll; otherwise the
  // 3-in-65536 de novo roll behind reachedGoldenrod. Returns the 1-based slot
  // that changed, or undefined. opts.random pins the rolls.
  give(party: PokerusMon[] | undefined, opts?: { random?: ByteRoll; reachedGoldenrod?: boolean }): number | undefined {
    opts = opts || {};
    const roll = opts.random;
    const count = (party || []).length;
    if (count === 0) return undefined;
    for (let i = 0; i < count; i++) {
      if (Pokerus.isInfected(party![i])) {
        return spread(party!, i + 1, roll);
      }
    }
    if (!opts.reachedGoldenrod) return undefined;
    // hRandomAdd must be zero and hRandomSub under 3: two bytes.
    if (byte(roll) !== 0) return undefined;
    if (byte(roll) >= 3) return undefined;
    // `and $7 / cp b / jr nc`: reroll until inside the party.
    let slot: number;
    do {
      slot = mod(byte(roll), 8);
    } while (!(slot < count));
    const mon = party![slot]!;
    const value = Pokerus.byteOf(mon);
    // `and $f0 / ret nz`: infected or immune, done catching it.
    if (value - mod(value, 16) !== 0) return undefined;
    // .randomPokerusLoop: strain and duration from ONE non-zero byte.
    let r: number;
    do {
      r = byte(roll);
    } while (r === 0);
    let strain = 0;
    if (r >= 16) strain = mod(r, 8) + 1;
    mon.pokerus = strain * 16 + mod(strain, 4) + 1;
    emitInfected(party, slot + 1, "contracted");
    return slot + 1;
  },

  // Lua: Pokerus.lua:280 -- ExitBattle's call shape: the Goldenrod gate from
  // save.engineFlags (keyed by engine-flag number).
  giveAfterBattle(save: any, party?: PokerusMon[], opts?: { random?: ByteRoll }): number | undefined {
    if (save === null || typeof save !== "object") return undefined;
    opts = opts || {};
    const flags = save.engineFlags || {};
    return Pokerus.give(party || save.party || [], {
      random: opts.random,
      // 21 on pokegold, 22 on Crystal
      reachedGoldenrod: flags[engineFlagIdFor("ENGINE_REACHED_GOLDENROD", Pokerus.ENGINE_REACHED_GOLDENROD)] === true,
    });
  },
};

export default Pokerus;
