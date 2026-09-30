// Gen 2 catch rate (engine/items/item_effects.asm PokeBallEffect): a port of
// gen1recomp src/battle/gen2/Catching.lua (bdfac727, MIT).
//
// The rate itself, transcribed from the ASM:
//
//   rate = ((3 * maxHP - 2 * curHP) * ballAdjustedCatchRate) / (3 * maxHP)
//   rate = max(1, rate) + statusBonus
//   rate = min(255, rate)
//
// Two documented cart bugs are reproduced deliberately, because a port that
// "fixes" them catches mons at rates the real game never would (both are in
// pokegold's docs/bugs_and_glitches.md):
//
//   * When 3 * maxHP >= 256 the routine shifts both HP terms right by two
//     before subtracting, which loses precision and makes the formula
//     misbehave for maxHP above 341.
//   * The status bonus was meant to be 10 for sleep/freeze and 5 for
//     burn/poison/paralysis, but the `and` that tests for sleep/freeze leaves
//     the accumulator zero on the fall-through, so burn, poison and paralysis
//     give no bonus at all.
//
// Pass `fixBugs = true` to get the intended behaviour instead; nothing in the
// game sets it, but it makes the difference testable and documents intent.
//
// The mod event/hook buses: `catch.rate` and `battle.ball_thrown` are the SAME
// names src/battle/BattleState.lua raises on Gen 1, with the same argument
// order and the same payload keys (docs/mod-api-gen2-compat.md).
//
// The Lua's two-value returns (`rate, guaranteed`, `caught, rate`) are pairs here.

import { Runtime } from "../shared/mods/Runtime.ts";
import { Mon } from "./Mon.ts";
import { truthy } from "../platform/lua.ts";
import { random as luaRandom } from "../platform/rng.ts";

/** `random(n)` returning 0..n-1, the way the cart compares a Random byte. */
export type ZeroRandom = (n: number) => number;

/** Catching.rate / attempt options (the Lua's open `opts` table). */
export interface CatchOpts {
  maxHp?: number;
  hp?: number;
  /** the species catch rate byte */
  catchRate?: number;
  ball?: string;
  status?: string;
  fixBugs?: boolean;
  // the specialty-ball conditions
  weight?: number;
  level?: number;
  playerLevel?: number;
  fishing?: boolean;
  fleeing?: boolean;
  species?: string;
  playerSpecies?: string;
  gender?: string;
  playerGender?: string;
  evolveItem?: string;
  // the registry seam
  data?: any;
  battle?: any;
  balls?: Record<string, any>;
  statuses?: Record<string, any>;
  // attempt
  mon?: any;
  def?: any;
  random?: ZeroRandom;
  [k: string]: any;
}

export type SpecialtyArm = (rate: number, opts: CatchOpts) => number;

export interface BallRecord {
  randMax: number;
  autoCatch?: boolean;
  flicker?: boolean;
  multiplier?: number;
  catchHappiness?: number;
  specialty?: SpecialtyArm;
  [k: string]: any;
}

// Lua: Catching.lua:37 -- ball multipliers applied to the species catch rate
// before the HP term.  MASTER_BALL never fails, so it short-circuits rather
// than multiplying.  The specialty balls (BallMultiplierFunctionTable) are
// conditional and live in Catching.specialtyRate below; FRIEND_BALL has no rate
// function at all -- its whole effect is the caught mon's happiness, which the
// catch site sets.
const BALL_MULTIPLIER: Record<string, number> = {
  MASTER_BALL: Infinity,
  ULTRA_BALL: 2,
  // SafariBallMultiplier, GreatBallMultiplier and ParkBallMultiplier are one
  // shared routine on the cart (x1.5); Safari is the RBY leftover.
  GREAT_BALL: 1.5,
  POKE_BALL: 1,
  SAFARI_BALL: 1.5,
  PARK_BALL: 1.5,
  FRIEND_BALL: 1,
};

// Lua: Catching.lua:60 -- FRIEND_BALL_HAPPINESS (constants/pokemon_data_constants.asm).
const FRIEND_BALL_HAPPINESS = 200;

// Lua: Catching.lua:89 -- the conditional balls (engine/items/item_effects.asm
// BallMultiplierFunctionTable, HeavyBallMultiplier..FastBallMultiplier).
// `rate` is the species catch rate byte; every arm caps at 255 the way each
// `sla b / jr c` pins $ff.  Three cart bugs are reproduced deliberately (all
// in pokegold's own comments): Fast Ball only knows three species, Love Ball
// boosts SAME-sex pairs, and Moon Ball compares the evolution stone against
// Gen 1's Moon Stone constant -- Burn Heal in Gen 2 -- so it never boosts.
// `fixBugs` flips all three to the intended behaviour.
// One arm per row of BallMultiplierFunctionTable, each fn(rate, opts) -> rate.
const SPECIALTY: Record<string, SpecialtyArm> = {
  // Lua: Catching.lua:90
  HEAVY_BALL: (rate, opts) => {
    // Additive, not a multiplier; the light-mon subtraction floors at 1
    // (`ld b, $1` on underflow).
    if (!truthy(opts.weight)) return rate;
    return Math.max(1, rate + Catching.heavyBallBoost(opts.weight));
  },
  // Lua: Catching.lua:96
  LEVEL_BALL: (rate, opts) => {
    // x2 / x4 / x8 as the wild level falls below the player's level, its
    // half and its quarter (strictly below at each rung).
    const player = opts.playerLevel;
    const enemy = opts.level;
    if (!(truthy(player) && truthy(enemy)) || enemy! >= player!) return rate;
    rate = rate * 2;
    if (enemy! < Math.floor(player! / 2)) rate = rate * 2;
    if (enemy! < Math.floor(player! / 4)) rate = rate * 2;
    return Math.min(255, rate);
  },
  // Lua: Catching.lua:107
  LURE_BALL: (rate, opts) => {
    // x3, only in a BATTLETYPE_FISH battle.
    if (!truthy(opts.fishing)) return rate;
    return Math.min(255, rate * 3);
  },
  // Lua: Catching.lua:112
  FAST_BALL: (rate, opts) => {
    if (truthy(opts.fixBugs)) {
      if (!truthy(opts.fleeing)) return rate;
    } else if (!Catching.FAST_BALL_SPECIES[opts.species as string]) {
      return rate;
    }
    return Math.min(255, rate * 4);
  },
  // Lua: Catching.lua:120
  MOON_BALL: (rate, opts) => {
    // MOON_STONE_RED is BURN_HEAL's Gen 2 id and nothing evolves with a
    // Burn Heal, so the intended x4 never happens on the cart.
    const wanted = truthy(opts.fixBugs) ? "MOON_STONE" : "BURN_HEAL";
    if (opts.evolveItem !== wanted) return rate;
    return Math.min(255, rate * 4);
  },
  // Lua: Catching.lua:127
  LOVE_BALL: (rate, opts) => {
    // x8 for the same species; the sex test's `ret nz` should be `ret z`,
    // so the boost lands on SAME-sex pairs.  Genderless mons never boost.
    if (!truthy(opts.species) || opts.species !== opts.playerSpecies) {
      return rate;
    }
    const wild = opts.gender;
    const player = opts.playerGender;
    if (!truthy(wild) || !truthy(player) || wild === "unknown" || player === "unknown") {
      return rate;
    }
    let same = wild === player;
    if (truthy(opts.fixBugs)) same = !same;
    if (!same) return rate;
    return Math.min(255, rate * 8);
  },
};

// Lua: Catching.lua:228 -- the merged `balls` table for this boot, or nil.
function mergedBalls(opts: CatchOpts | undefined): Record<string, any> | undefined {
  if (!truthy(opts)) return undefined;
  if (truthy(opts!.balls)) return opts!.balls;
  const data = truthy(opts!.data) ? opts!.data : truthy(opts!.battle) ? opts!.battle.data : undefined;
  return truthy(data) && truthy(data.gen2Balls) ? data.gen2Balls : undefined;
}

// Lua: Catching.lua:245
function rand(random: ZeroRandom | undefined, n: number): number {
  if (truthy(random)) return random!(n);
  return luaRandom(n) - 1;
}

// Lua: Catching.lua:344
function landmarkIndex(opts: CatchOpts | undefined, id: string, fallback: number): number {
  const data = truthy(opts) ? (truthy(opts!.data) ? opts!.data : truthy(opts!.battle) ? opts!.battle.data : undefined) : undefined;
  const rows =
    (truthy(opts) ? opts!.landmarks : undefined) ??
    (truthy(data) && truthy(data.gen2Landmarks) ? data.gen2Landmarks.landmarks : undefined);
  const row = truthy(rows) ? rows[id] : undefined;
  return (truthy(row) ? row.index : undefined) ?? fallback;
}

export const Catching = {
  BALL_MULTIPLIER,

  // Lua: Catching.lua:54 -- FastBallMultiplier (engine/items/item_effects.asm):
  // meant to cover all three FleeMons tables, but the loop advances `d` on
  // every byte instead of every table (`jr nz, .next` where the intended jump
  // is `.loop`), so only the first three rows of SometimesFleeMons
  // (data/wild/flee_mons.asm) ever get the x4.  Reproduced deliberately.
  FAST_BALL_SPECIES: {
    MAGNEMITE: true,
    GRIMER: true,
    TANGELA: true,
  } as Record<string, boolean>,

  // FRIEND_BALL_HAPPINESS: the one thing a Friend Ball does.  The catch site
  // stamps it on the caught mon.
  FRIEND_BALL_HAPPINESS,

  STATUS_BONUS: { sleep: 10, freeze: 10 } as Record<string, number>,
  STATUS_BONUS_FIXED: {
    sleep: 10,
    freeze: 10,
    burn: 5,
    poison: 5,
    toxic: 5,
    paralyze: 5,
  } as Record<string, number>,

  // Lua: Catching.lua:186 -- Gold's own ball records, in the shape
  // src/mods/Schemas.lua's `balls` registry validates -- the SAME registry name
  // Gen 1 fills.  Fields:
  //   randMax    the ceiling of the catch roll.  PokeBallEffect rolls ONE byte
  //              against wFinalCatchRate, so every rolling ball is 255 here.
  //   autoCatch  MASTER_BALL, which returns before the rate is computed.
  //   flicker    DoBallTossSpecialEffects' OBJ-palette strobe, Master and Ultra.
  //   multiplier the flat factor BallMultiplierFunctionTable applies to the
  //              species catch rate.  Infinity (math.huge) is the Master Ball's
  //              "never fails" and pairs with autoCatch.
  //   specialty  the conditional arm, fn(rate, opts) -> rate, for the balls
  //              whose factor depends on the battle rather than the ball.
  // FRIEND_BALL keeps multiplier 1 and carries its one real effect as
  // catchHappiness; ui/BattleState stamps it on the caught mon.
  BALLS: {
    MASTER_BALL: { randMax: 0, autoCatch: true, flicker: true, multiplier: BALL_MULTIPLIER.MASTER_BALL },
    ULTRA_BALL: { randMax: 255, flicker: true, multiplier: BALL_MULTIPLIER.ULTRA_BALL },
    GREAT_BALL: { randMax: 255, multiplier: BALL_MULTIPLIER.GREAT_BALL },
    POKE_BALL: { randMax: 255, multiplier: BALL_MULTIPLIER.POKE_BALL },
    SAFARI_BALL: { randMax: 255, multiplier: BALL_MULTIPLIER.SAFARI_BALL },
    PARK_BALL: { randMax: 255, multiplier: BALL_MULTIPLIER.PARK_BALL },
    FRIEND_BALL: {
      randMax: 255,
      multiplier: BALL_MULTIPLIER.FRIEND_BALL,
      catchHappiness: FRIEND_BALL_HAPPINESS,
    },
    HEAVY_BALL: { randMax: 255 },
    LEVEL_BALL: { randMax: 255 },
    LURE_BALL: { randMax: 255 },
    FAST_BALL: { randMax: 255 },
    MOON_BALL: { randMax: 255 },
    LOVE_BALL: { randMax: 255 },
  } as Record<string, BallRecord>,

  // constants/landmark_constants.asm:24, the fallback when no cache is passed.
  LANDMARK_NATIONAL_PARK: 19,

  // Lua: Catching.lua:65 -- HeavyBallMultiplier's weight conversion: the dex
  // weight (tenths of a pound) is turned into tenths of a kilogram with three
  // shift-subtracts (w/2 - w/32 - w/64), and only the HIGH byte is compared.
  heavyBallBoost(weight?: number): number {
    const half = Math.floor((weight ?? 0) / 2);
    const sub1 = Math.floor(half / 16);
    const sub2 = Math.floor(sub1 / 2);
    const high = Math.floor((half - sub1 - sub2) / 256);
    if (high < 4) return -20; // under 102.4 kg
    if (high < 8) return 0; // under 204.8 kg
    if (high < 12) return 20; // under 307.2 kg
    if (high < 16) return 30; // under 409.6 kg
    return 40;
  },

  // Lua: Catching.lua:145
  specialtyRate(rate: number, ball: string, opts?: CatchOpts): number {
    const o = opts ?? {};
    const arm = SPECIALTY[ball];
    if (!truthy(arm)) return rate;
    return arm!(rate, o);
  },

  // Lua: Catching.lua:218 -- vanilla registrations, engine-owned
  // (Schemas.ENGINE), so a mod's register of one of these ids collides the way
  // it does on Red and has to say override.
  registerInto(registry: any, _data: any, owner?: any): void {
    for (const id of Object.keys(Catching.BALLS)) {
      registry.register(id, Catching.BALLS[id], owner);
    }
  },

  // Lua: Catching.lua:238 -- the merged record for a ball id, the module's own
  // when no loader ran.  An unknown id answers nil on both paths.
  recordFor(ball: string, opts?: CatchOpts): BallRecord | undefined {
    const merged = mergedBalls(opts);
    const record = truthy(merged) ? merged![ball] : undefined;
    if (truthy(record)) return record;
    return Catching.BALLS[ball];
  },

  // Lua: Catching.lua:263 -- the 0..255 rate, and whether it is certain.
  // `opts`: maxHp, hp, catchRate, ball, status, fixBugs; the specialty-ball
  // conditions ride the same table (weight, level, playerLevel, fishing,
  // species, playerSpecies, gender, playerGender, evolveItem).  One more
  // optional key and it is the registry seam: `data` (or `battle`, or the
  // merged `balls` / `statuses` subtables directly).
  rate(opts?: CatchOpts): [number, boolean] {
    const o = opts ?? {};
    const ball = o.ball ?? "POKE_BALL";
    // Through the merged `balls` registry, module records when no loader ran.
    // The three arms are exactly the three rows the record can carry: a flat
    // multiplier, a conditional arm, or neither -- and "neither" is also what
    // an unknown ball id gets.
    const record = Catching.recordFor(ball, o);
    const multiplier = truthy(record) ? record!.multiplier : undefined;
    if (truthy(record) && truthy(record!.autoCatch)) return [255, true];
    if (multiplier === Infinity) return [255, true];

    const maxHp = Math.max(1, o.maxHp ?? 1);
    const hp = Math.max(0, Math.min(o.hp ?? maxHp, maxHp));
    let catchRate: number;
    if (truthy(multiplier)) {
      catchRate = Math.floor((o.catchRate ?? 45) * multiplier!);
    } else if (truthy(record) && truthy(record!.specialty)) {
      catchRate = record!.specialty!(o.catchRate ?? 45, o);
    } else {
      catchRate = o.catchRate ?? 45;
    }
    catchRate = Math.max(1, Math.min(255, catchRate));

    let tripleMax = maxHp * 3;
    let doubleHp = hp * 2;
    if (tripleMax >= 256) {
      // The cart's precision loss: both terms shift right two bits.
      tripleMax = Math.floor(tripleMax / 4);
      doubleHp = Math.floor(doubleHp / 4);
      if (!truthy(o.fixBugs)) {
        // And it then compares only the low byte of the shifted max.
        tripleMax = tripleMax % 256;
      }
      doubleHp = Math.max(1, doubleHp);
    }
    tripleMax = Math.max(1, tripleMax);

    let rate = Math.floor(((tripleMax - doubleHp) * catchRate) / tripleMax);
    rate = Math.max(1, rate);

    rate = rate + Catching.statusBonus(o.status, o);
    return [Math.min(255, rate), false];
  },

  // Lua: Catching.lua:311 -- exact stock catch probability for read-only
  // previews.  A catch.rate hook may replace the roll entirely, so nil is
  // safer than presenting a guess.
  chance(opts?: CatchOpts): number | undefined {
    if (Runtime.wantsHook("catch.rate")) return undefined;
    const [rate, guaranteed] = Catching.rate(opts);
    if (guaranteed || rate >= 255) return 100;
    return (rate * 100) / 256;
  },

  // Lua: Catching.lua:325 -- the status half of the rate, off the merged
  // `statuses` record.  Gold's records live on battle/Battle.ts
  // (Battle.STATUSES) and carry BOTH numbers: `catchBonus` is what the cart
  // actually adds and `catchBonusIntended` is the 5 the table meant to give
  // burn/poison/paralysis, which is what `fixBugs` asks for.  The two module
  // tables answer when no loader ran.
  statusBonus(status: string | undefined, opts?: CatchOpts): number {
    if (!truthy(status)) return 0;
    const data = truthy(opts) ? (truthy(opts!.data) ? opts!.data : truthy(opts!.battle) ? opts!.battle.data : undefined) : undefined;
    const statuses =
      (truthy(opts) && truthy(opts!.statuses) ? opts!.statuses : undefined) ??
      (truthy(data) ? data.gen2Statuses : undefined);
    const record = truthy(statuses) ? statuses![status!] : undefined;
    if (truthy(record)) {
      if (truthy(opts) && truthy(opts!.fixBugs)) {
        return record.catchBonusIntended ?? record.catchBonus ?? 0;
      }
      return record.catchBonus ?? 0;
    }
    const bonuses = truthy(opts) && truthy(opts!.fixBugs) ? Catching.STATUS_BONUS_FIXED : Catching.STATUS_BONUS;
    return bonuses[status!] ?? 0;
  },

  // Lua: Catching.lua:354 -- GetWorldMapLocation with the POKECENTER_2F
  // backup-map swap (engine/pokemon/caught_data.asm:177-193) and the Bug
  // Contest override (:73-81).
  caughtLandmark(opts?: CatchOpts): number {
    const o = opts ?? {};
    if (truthy(o.bugContest)) {
      return landmarkIndex(o, "LANDMARK_NATIONAL_PARK", Catching.LANDMARK_NATIONAL_PARK);
    }
    if (truthy(o.landmark)) return o.landmark;
    let map = o.map;
    if (truthy(map) && map.id === "POKECENTER_2F" && truthy(o.backupMap)) {
      map = o.backupMap;
    }
    return (truthy(map) ? map.landmark : undefined) ?? 0;
  },

  // Lua: Catching.lua:369 -- SetCaughtData (engine/pokemon/caught_data.asm:163-199);
  // no-op off Crystal.
  stampCaughtData(mon: any, opts?: CatchOpts): any {
    const o = opts ?? {};
    if (!Mon.hasCaughtData(o.version)) return mon;
    const save = truthy(o.save) ? o.save : truthy(o.battle) ? o.battle.save : undefined;
    const monLevel = typeof mon === "object" && mon !== null && truthy(mon.level) ? mon.level : undefined;
    const saveGender = truthy(save) && truthy(save.player) ? save.player.gender : undefined;
    return Mon.setCaughtData(mon, {
      level: truthy(o.level) ? o.level : (monLevel ?? 0),
      timeOfDay: o.timeOfDay,
      landmark: Catching.caughtLandmark(o),
      playerGender: truthy(o.playerGender) ? o.playerGender : saveGender,
    });
  },

  // Lua: Catching.lua:391 -- does the ball catch?  Returns [caught, the final
  // rate (wFinalCatchRate)].  A rate of 255 or a Master Ball is certain.
  //
  // No wobble count comes out of here: unlike Gen 1, Gen 2 decides how many
  // times the ball rocks DURING the animation.  GetPokeBallWobble
  // (engine/battle_anims/pokeball_wobble.asm) is called once per wobble and
  // re-rolls Random against the WobbleProbabilities row that wFinalCatchRate
  // picks.  The caller runs that loop with the rate returned here.
  attempt(opts?: CatchOpts): [boolean, number] {
    const o = opts ?? {};
    let caught: boolean;
    let rate: number;
    if (Runtime.wantsHook("catch.rate")) {
      // catch.rate, the same hook BattleState:catchAttempt calls on Gen 1 and
      // with the same four arguments: the ball id, the target mon, its species
      // record, and the options table vanilla is actually run on.
      [caught, rate] = Runtime.call(
        "catch.rate",
        (_ball: string, _mon: any, _def: any, oo: CatchOpts) => Catching.vanillaAttempt(oo),
        o.ball ?? "POKE_BALL",
        o.mon,
        o.def,
        o,
      );
    } else {
      [caught, rate] = Catching.vanillaAttempt(o);
    }
    // PokeBallEffect's captured tail runs BEFORE the mon is added to anything
    // (item_effects.asm:514-566), so a caught mon is reloaded out of its base
    // data -- and the battle.catch_exp hook is asked -- here, while the record
    // the catch site is about to keep is still the battle's.  Both live on
    // Battle:caught; a caller with no battle gets the roll and nothing else.
    if (caught && truthy(o.battle) && truthy(o.battle.caught)) {
      o.battle.caught(o.mon);
    }
    // battle.ball_thrown, the payload BattleState:throwBall emits on Gen 1.
    // `shakes` is deliberately nil rather than 0: Gen 2 does not decide the
    // wobble count here at all.
    if (Runtime.wants("battle.ball_thrown")) {
      Runtime.emit("battle.ball_thrown", {
        battle: o.battle,
        ball: o.ball ?? "POKE_BALL",
        caught,
        shakes: undefined,
        rate,
        mon: o.mon,
        species: o.species,
      });
    }
    return [caught, rate];
  },

  // Lua: Catching.lua:441
  vanillaAttempt(opts?: CatchOpts): [boolean, number] {
    const [rate, guaranteed] = Catching.rate(opts);
    const random = truthy(opts) ? opts!.random : undefined;
    if (guaranteed || rate >= 255) return [true, rate];
    // The cart rolls one byte against the rate; a roll under it catches.
    const roll = rand(random, 256);
    if (roll < rate) return [true, rate];
    return [false, rate];
  },
};

// Lua: Catching.lua:212 -- the conditional arms, hung on the records they
// belong to by identity so a registry read and Catching.specialtyRate cannot
// answer differently.
for (const id of Object.keys(SPECIALTY)) {
  Catching.BALLS[id]!.specialty = SPECIALTY[id];
}

export default Catching;
