// Gen 2 damage: a port of gen1recomp src/battle/gen2/Damage.lua (bdfac727, MIT).
//
// Ported from engine/battle/effect_commands.asm, in the order the cart's move
// sequence runs them: damagestats -> damagecalc -> stab -> damagevariation.
//
// What differs from Gen 1 (src/battle/Damage.lua), and why this is its own
// module rather than a flag on that one:
//   * Special is split into Special Attack and Special Defense, so a special
//     move reads the attacker's SpA against the defender's SpD instead of both
//     sides' single `special`.
//   * Critical hits are a *chance ladder* (data/battle/critical_hit_chances.asm
//     1/15, 1/8, 1/4, 1/3, 1/2) indexed by a "critical level" that Focus
//     Energy, a high-crit move, Scope Lens, and the Lucky Punch / Stick raise.
//     Gen 1 instead derived the chance from base Speed.
//   * A critical hit is a flat x2 and, unlike Gen 1, ignores the attacker's
//     *negative* stat stages rather than all stages.
//   * Type-boost held items (Charcoal, Mystic Water, ...) multiply before the
//     crit, and Steel and Dark exist in the matchup table.
//
// Whether a move is physical or special is still decided by its *type*, not
// per-move as in Gen 4: type ids below FIRE are physical.  type_chart.lua's
// records carry that as `category`.

import { GameVersion } from "../shared/core/GameVersion.ts";
import { random as luaRandom } from "../platform/rng.ts";

/** `random(n)` returning 0..n-1, the way the cart compares a BattleRandom byte. */
export type ZeroRandom = (n: number) => number;

export interface DamageSide {
  attack?: number;
  defense?: number;
  specialAttack?: number;
  specialDefense?: number;
  special?: number;
  types?: string[];
  stages?: Record<string, number | undefined>;
  [k: string]: any;
}

export interface MatchupRow {
  attacker: string;
  defender: string;
  multiplier: number;
  [k: string]: any;
}

export interface DamageOpts {
  level?: number;
  power?: number;
  moveType?: string;
  attacker?: DamageSide;
  defender?: DamageSide;
  /** type_chart.lua's `types` / `matchups` */
  types?: Record<string, any>;
  matchups?: MatchupRow[];
  /** roll it with rollCritical first */
  critical?: boolean;
  /** type-boost held item, e.g. 10 for Charcoal */
  itemBoostPercent?: number;
  /** DoWeatherModifiers in tenths (15 / 5 / nil) */
  weatherPercent?: number;
  /** DoBadgeTypeBoosts: +1/8 before STAB */
  badgeTypeBoost?: boolean;
  /** 85..100; omit to roll */
  variation?: number;
  /** 0..n-1, for the variation roll */
  random?: ZeroRandom;
  /** Reflect/Light Screen active on the defender */
  screen?: boolean;
  /** EFFECT_SELFDESTRUCT's srl c */
  defenseHalved?: boolean;
  /** override GameVersion.fixes()'s TruncateHL_BC answer */
  reflectOverflowFixed?: boolean;
  [k: string]: any;
}

export interface DamageInfo {
  effectiveness: number;
  critical: boolean;
  physical: boolean;
  stab?: boolean;
  variation?: number;
  /** Gen 1 names for the same facts */
  crit?: boolean;
  typeMult?: number;
}

// Stat stage multipliers (numerator, denominator), -6..+6.  Same table as
// Gen 1; a critical hit skips only the negative half for the attacker.
// Lua: Damage.lua:50
const STAGE: Record<number, [number, number]> = {
  [-6]: [25, 100], [-5]: [28, 100], [-4]: [33, 100],
  [-3]: [40, 100], [-2]: [50, 100], [-1]: [66, 100],
  [0]: [1, 1],
  [1]: [15, 10], [2]: [2, 1], [3]: [25, 10],
  [4]: [3, 1], [5]: [35, 10], [6]: [4, 1],
};

// Every `info` table Damage.calc returns carries BOTH generations' names for
// the same two facts: Gen 2 calls them `critical` and `effectiveness`, Gen 1
// (src/battle/Damage.lua) calls them `crit` and `typeMult`.  The battle.damage
// hook hands this table to whatever wrapped it, and a mod written against Red
// must be able to read what it wrapped.
// Lua: Damage.lua:172
function withGen1Names(info: DamageInfo): DamageInfo {
  info.crit = info.critical;
  info.typeMult = info.effectiveness;
  return info;
}

export const Damage = {
  // ../pokecrystal/constants/battle_constants.asm:78
  MAX_STAT_VALUE: 999,

  // data/battle/critical_hit_chances.asm, as "1 in N" (index = level 0..6).
  CRITICAL_CHANCES: [15, 8, 4, 3, 2, 2, 2] as number[],

  // Gen 2's damage spread: 85% to 100% inclusive.
  MIN_VARIATION: 85,
  MAX_VARIATION: 100,

  // The cart caps a single hit at 999 (DAMAGE_CAP + MIN_DAMAGE in
  // BattleCommand_DamageCalc).
  MAX_DAMAGE: 999,

  // BattleCommand_DamageCalc's tail (engine/battle/effect_commands.asm) caps the
  // computed damage at DAMAGE_CAP (997) and then adds MIN_DAMAGE (2) back, so
  // every damaging hit leaves DamageCalc worth at least 2 -- which is what keeps
  // a resisted hit from flooring to zero once the type matchup halves it.
  MIN_DAMAGE: 2,

  // Lua: Damage.lua:58
  stageMultiplier(stage?: number): [number, number] {
    const entry = STAGE[Math.max(-6, Math.min(6, stage ?? 0))]!;
    return [entry[0], entry[1]];
  },

  // Apply a stat stage, flooring like the cart's Multiply/Divide pair, and never
  // letting a stat reach 0 (a 0 defence would divide by zero).
  // Lua: Damage.lua:65
  applyStage(value: number, stage?: number): number {
    const [numerator, denominator] = Damage.stageMultiplier(stage);
    const out = Math.floor((value * numerator) / denominator);
    // ../pokecrystal/engine/battle/core.asm:6739
    return Math.max(1, Math.min(Damage.MAX_STAT_VALUE, out));
  },

  // TruncateHL_BC: ../pokegold/engine/battle/effect_commands.asm:2625 runs one
  // pass, ../pokecrystal/engine/battle/effect_commands.asm:2644 loops it.
  // Lua: Damage.lua:74
  truncateStats(attack?: number, defense?: number, fixed?: boolean): [number, number] {
    let a = Math.max(0, Math.floor(attack ?? 0));
    let d = Math.max(0, Math.floor(defense ?? 0));
    while (a > 255 || d > 255) {
      d = Math.floor(d / 4);
      if (d === 0) d = 1;
      a = Math.floor(a / 4);
      if (a === 0) a = 1;
      if (!fixed) break;
    }
    return [a % 256, d % 256];
  },

  // Is this move physical?  `types` is type_chart.lua's `types` table.
  // Lua: Damage.lua:88
  isPhysical(moveType: string | undefined, types?: Record<string, any>): boolean {
    const record = types && moveType != null ? types[moveType] : undefined;
    if (record != null && record !== false && record.category != null) return record.category === "physical";
    // Without the table, fall back to the Gen 1/2 boundary: the physical block
    // runs NORMAL..GROUND, and the special block starts at FIRE.
    const PHYSICAL: Record<string, boolean> = {
      NORMAL: true, FIGHTING: true, FLYING: true, POISON: true,
      GROUND: true, ROCK: true, BUG: true, GHOST: true, STEEL: true,
    };
    return moveType != null && PHYSICAL[moveType] === true;
  },

  // The 1-in-N chance for a critical level.
  // Lua: Damage.lua:101
  criticalChance(level?: number): number {
    const capped = Math.max(0, Math.min(6, level ?? 0));
    return Damage.CRITICAL_CHANCES[capped]!;
  },

  // BattleCommand_Critical, as a level rather than a roll:
  //   +1 Focus Energy, +2 a high-crit move, +1 Scope Lens,
  //   +2 Lucky Punch on Chansey / Stick on Farfetch'd.
  // Lua: Damage.lua:109
  criticalLevel(opts: { focusEnergy?: any; highCritMove?: any; scopeLens?: any; speciesItemBonus?: any }): number {
    let level = 0;
    if (opts.focusEnergy != null && opts.focusEnergy !== false) level += 1;
    if (opts.highCritMove != null && opts.highCritMove !== false) level += 2;
    if (opts.scopeLens != null && opts.scopeLens !== false) level += 1;
    if (opts.speciesItemBonus != null && opts.speciesItemBonus !== false) level += 2;
    return Math.min(6, level);
  },

  // Roll a critical hit.  `random(n)` must return 0..n-1 (the cart compares a
  // BattleRandom byte against the chance), and defaults to love/math random.
  // Lua: Damage.lua:120
  rollCritical(criticalLevel?: number, random?: ZeroRandom): boolean {
    const chance = Damage.criticalChance(criticalLevel);
    let roll: number;
    if (random) roll = random(chance);
    else roll = luaRandom(chance) - 1;
    return roll === 0;
  },

  // The x10 type multiplier of a move against a defender, applying each matchup
  // row separately and flooring in between -- the same rule Gen 1 follows, which
  // is why a dual type can land on 4x or 0.25x.
  // Lua: Damage.lua:136
  typeMultiplier(moveType: string | undefined, defenderTypes?: string[], matchups?: MatchupRow[]): number {
    let multiplier = 10;
    for (const row of matchups ?? []) {
      if (row.attacker === moveType) {
        for (const defenderType of defenderTypes ?? []) {
          if (row.defender === defenderType) {
            multiplier = Math.floor((multiplier * row.multiplier) / 10);
            break;
          }
        }
      }
    }
    return multiplier;
  },

  // The core formula (BattleCommand_DamageCalc):
  //
  //   (((2 * Level / 5 + 2) * Power * Attack / Defense) / 50)
  //
  // every step floored, defence clamped to at least 1.
  // Lua: Damage.lua:156
  base(level: number, power: number | undefined, attack: number, defense?: number): number {
    if ((power ?? 0) <= 0) return 0;
    defense = Math.max(1, defense ?? 1);
    let value = Math.floor((level * 2) / 5) + 2;
    value = value * power!;
    value = value * attack;
    value = Math.floor(value / defense);
    value = Math.floor(value / 50);
    return value;
  },

  // opts: see DamageOpts.  Returns [damage, info] where info carries the pieces
  // a battle message needs: effectiveness (x10), critical, physical, variation.
  // Lua: Damage.lua:198
  calc(opts: DamageOpts): [number, DamageInfo] {
    const physical = Damage.isPhysical(opts.moveType, opts.types);
    const attacker = opts.attacker ?? {};
    const defender = opts.defender ?? {};
    const stagesA = attacker.stages ?? {};
    const stagesD = defender.stages ?? {};

    const rawAttack = physical ? (attacker.attack ?? 1) : (attacker.specialAttack ?? attacker.special ?? 1);
    const rawDefense = physical ? (defender.defense ?? 1) : (defender.specialDefense ?? defender.special ?? 1);
    let stageA = physical ? (stagesA.attack ?? 0) : (stagesA.specialAttack ?? 0);
    let stageD = physical ? (stagesD.defense ?? 0) : (stagesD.specialDefense ?? 0);

    // A critical hit ignores stat changes that would *lower* the damage: the
    // attacker's negative stages and the defender's positive ones.
    if (opts.critical) {
      if (stageA < 0) stageA = 0;
      if (stageD > 0) stageD = 0;
    }

    let attack = Damage.applyStage(rawAttack, stageA);
    let defense = Damage.applyStage(rawDefense, stageD);

    // Reflect and Light Screen double the matching defence, and are the one
    // multiplier a critical hit also ignores.
    if (opts.screen && !opts.critical) {
      defense = defense * 2;
    }

    // PlayerAttackDamage hands DamageCalc one-byte stats
    // (../pokecrystal/engine/battle/effect_commands.asm:2604).
    let fixed = opts.reflectOverflowFixed;
    if (fixed == null) fixed = GameVersion.fixes().reflectOverflow === true;
    [attack, defense] = Damage.truncateStats(attack, defense, fixed);

    // BattleCommand_DamageCalc (effect_commands.asm:2905-2913): Selfdestruct and
    // Explosion halve the defence, never below 1.
    if (opts.defenseHalved) defense = Math.max(1, Math.floor(defense / 2));

    if ((opts.power ?? 0) <= 0) {
      return [0, withGen1Names({ effectiveness: 10, critical: false, physical })];
    }
    let damage = Damage.base(opts.level ?? 1, opts.power ?? 0, attack, defense);

    // Type-boost held items multiply before the crit (.NextItem / .DoneItem).
    if (opts.itemBoostPercent != null && opts.itemBoostPercent > 0) {
      damage = Math.floor((damage * (100 + opts.itemBoostPercent)) / 100);
    }

    if (opts.critical) damage = damage * 2;

    // BattleCommand_DamageCalc's tail: cap at DAMAGE_CAP, then add MIN_DAMAGE
    // back, so even a hit whose stat math floored to nothing leaves with 2.
    damage = Math.min(damage, Damage.MAX_DAMAGE - Damage.MIN_DAMAGE) + Damage.MIN_DAMAGE;

    // DoWeatherModifiers (engine/battle/misc.asm:102-140), farcalled by
    // BattleCommand_Stab as its very FIRST act (effect_commands.asm:1254): it
    // sits ahead of the badge boost, the STAB x1.5, the type rows and
    // DamageVariation, so every later step floors on top of it.  The table's
    // values are tenths (weather_modifiers.asm: MORE_EFFECTIVE 15,
    // NOT_VERY_EFFECTIVE 05), and .ApplyModifier's zero-quotient arm forces the
    // result back to 1, so a weather-halved hit never falls to nothing.
    if (opts.weatherPercent != null && opts.weatherPercent !== 10) {
      damage = Math.max(1, Math.floor((damage * opts.weatherPercent) / 10));
    }

    // DoBadgeTypeBoosts (engine/battle/misc.asm:146), farcalled from
    // BattleCommand_Stab ahead of the STAB multiply: a matching owned badge
    // adds an eighth of the running damage, at least 1, on the player's turn.
    if (opts.badgeTypeBoost) {
      damage = damage + Math.max(1, Math.floor(damage / 8));
    }

    // STAB, then each type row.  BattleCommand_Stab does STAB first, so a
    // resisted same-type move floors after the x1.5.
    let stab = false;
    for (const attackerType of attacker.types ?? []) {
      if (attackerType === opts.moveType) {
        stab = true;
        break;
      }
    }
    if (stab) damage = Math.floor((damage * 15) / 10);

    // Each matchup row multiplies the running damage separately, the way
    // BattleCommand_Stab's .TypesLoop does -- and its zero-quotient check forces
    // the damage back to 1 whenever a non-immune row floors it to nothing, so a
    // resisted hit that lands always deals at least 1 HP.
    const effectiveness = Damage.typeMultiplier(opts.moveType, defender.types, opts.matchups);
    for (const row of opts.matchups ?? []) {
      if (row.attacker === opts.moveType) {
        for (const defenderType of defender.types ?? []) {
          if (row.defender === defenderType) {
            damage = Math.floor((damage * row.multiplier) / 10);
            if (damage === 0 && row.multiplier > 0) damage = 1;
            break;
          }
        }
      }
    }

    if (effectiveness <= 0 || damage <= 0) {
      return [0, withGen1Names({ effectiveness, critical: opts.critical ?? false, physical, stab })];
    }

    // Damage variation last, and only when the running damage is 2 or more
    // (BattleCommand_DamageVariation returns early below that).
    let variation = opts.variation;
    if (variation == null) {
      if (opts.random) {
        variation = Damage.MIN_VARIATION + opts.random(Damage.MAX_VARIATION - Damage.MIN_VARIATION + 1);
      } else {
        variation = luaRandom(Damage.MIN_VARIATION, Damage.MAX_VARIATION);
      }
    }
    if (damage >= 2) {
      damage = Math.floor((damage * variation) / 100);
    }

    damage = Math.max(1, Math.min(Damage.MAX_DAMAGE, damage));
    return [damage, withGen1Names({ effectiveness, critical: opts.critical ?? false, physical, stab, variation })];
  },

  // Accuracy check.  Gen 2 rolls one byte against accuracy scaled by the
  // attacker's accuracy stage and the defender's evasion stage; accuracy of 0 in
  // the data means "never misses" (Swift and friends).
  // Lua: Damage.lua:339
  rollHit(accuracy?: number, accuracyStage?: number, evasionStage?: number, random?: ZeroRandom): boolean {
    if (accuracy == null || accuracy <= 0) return true;
    let [numerator, denominator] = Damage.stageMultiplier(accuracyStage ?? 0);
    let value = Math.floor((accuracy * numerator) / denominator);
    [numerator, denominator] = Damage.stageMultiplier(-(evasionStage ?? 0));
    value = Math.floor((value * numerator) / denominator);
    value = Math.max(1, Math.min(100, value));
    let roll: number;
    if (random) roll = random(100);
    else roll = luaRandom(100) - 1;
    return roll < value;
  },
};

export default Damage;
