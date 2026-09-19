// The move-effect execution surface. Ports gen1recomp
// src/battle/EffectRegistry.lua (makeCtx :37, runDamaging :99) and
// src/battle/MoveEffects.lua's primary/secondary/full records. An effect id
// with no record degrades the way the reference degrades an UNREGISTERED
// effect: a damaging move falls through to plain damage with a one-shot
// warning (MoveEffects.warnUnknown, MoveEffects.lua:788-793) and a status
// move prints "But, it failed!" (BattleState.lua performMove :3599-3604).

import type { MoveDef, VoxelmonData } from "../data.ts";
import { randRange, type Rng } from "../rng.ts";
import type { DamageInfo, DamageMove, Ruleset } from "../rules/damage.ts";
import { recordFor } from "../rules/status.ts";
import type { TypeChart } from "../rules/typechart.ts";
import { displayName, type WildBattler } from "./battler.ts";
import { effectiveSpeed } from "../rules/turnorder.ts";
import { MOVE_STATUS_OR_MISS, CRIT_OHKO_TEXT } from "../rules/timing.ts";

/** Handler message list; `failed` marks a failure whose text is bespoke
 * (MoveEffects.lua SUBSTITUTE_EFFECT comment, #644). */
export type EffectMsgs = string[] & { failed?: boolean };

/** The stage callbacks of a merged move_effects record
 * (EffectRegistry.lua's record contract). */
export interface EffectRecord {
  kind: "primary" | "secondary" | "full";
  accuracyChecked?: boolean;
  run?: (ctx: EffectCtx) => EffectMsgs;
  neverMiss?: boolean;
  explode?: boolean;
  announceAnim?: boolean;
  gate?: (ctx: EffectCtx) => [boolean, string?];
  hitCount?: (ctx: EffectCtx) => number;
  beforeAccuracy?: (ctx: EffectCtx) => void;
  chooseDamage?: (ctx: EffectCtx) => [number | null, (DamageInfo & { ohko?: boolean }) | string | undefined];
  onMiss?: (ctx: EffectCtx, reason: "invulnerable" | "accuracy" | "immune" | "floored") => void;
  afterDamage?: (ctx: EffectCtx, totalDealt: number) => void;
  charge?: { invulnerable?: boolean; anim?: string; enemyAnim?: string };
  perform?: (ctx: EffectCtx) => void;
  callsMove?: (ctx: EffectCtx) => string | null;
}

/** What the pipeline needs from the battle (BattleState methods). */
export interface EffectBattle {
  data: VoxelmonData;
  rng: Rng;
  ruleset: Ruleset;
  chart: TypeChart;
  /** wDamage — shared by both sides, read by Counter (EffectRegistry.lua:203). */
  lastDamage: number;
  moveAnimRow: AnimRowRef | null;
  sayNext(text: string): void;
  waitNext(frames: number): void;
  drainNext(battler?: WildBattler, stopAt?: number): void;
  cancelMoveAnim(): void;
  /** Insert an anim/hit row after the current queue item; returns the row so
   * the pipeline can attach `hit` (EffectRegistry.lua:225-246). */
  insertHitRow(anim: string | null, isPlayer: boolean): AnimRowRef;
  applyDamage(target: WildBattler, dmg: number): number;
  onFaint(battler: WildBattler): void;
  accuracyRoll(move: DamageMove, user: WildBattler, target: WildBattler): boolean;
  computeDamage(
    user: WildBattler,
    target: WildBattler,
    move: DamageMove,
    opts: { rng: Rng; explode?: boolean },
  ): [number, DamageInfo];
  inflictStatus(
    target: WildBattler,
    status: string,
    opts: { toxic?: boolean; moveType?: string; secondary?: boolean; source?: string },
  ): string[];
  animNext(name: string, isPlayer: boolean): void;
  selfDestruct(user: WildBattler): void;
  /** Pay Day's scattered coins, picked up if the battle is won. */
  payDay: number;
  /** A trainer battle: Teleport and Roar/Whirlwind do nothing there. */
  readonly trainerBattle: boolean;
  /** Teleport / Roar / Whirlwind end a wild battle. */
  escape(): void;
}

export interface AnimRowRef {
  hit?: HitFx;
}

export interface HitFx {
  sfx: string;
  animType: number;
}

export interface EffectCtx {
  battle: EffectBattle;
  data: VoxelmonData;
  rng: Rng;
  ruleset: Ruleset;
  user: WildBattler;
  target: WildBattler;
  move: MoveDef;
  moveInst: { id: string; pp: number; struggle?: boolean };
  isCalled: boolean;
  rawDamage?: number;
  totalDealt?: number;
  brokeSub?: boolean;
  hits?: number;
  say(text: string): void;
  damage(who: WildBattler, amount: number): number;
  changeStage(who: WildBattler, stat: StageStat, delta: number, fromEnemy: boolean): EffectMsgs;
}

type StageStat = "attack" | "defense" | "speed" | "special" | "accuracy" | "evasion";

// data/battle/stat_mod_names.asm StatModTextStrings (MoveEffects.lua:33-37)
const STAT_LABEL: Record<StageStat, string> = {
  attack: "ATTACK",
  defense: "DEFENSE",
  speed: "SPEED",
  special: "SPECIAL",
  accuracy: "ACCURACY",
  evasion: "EVADE",
};

/**
 * MoveEffects.lua:43-72 changeStage — the MIST/substitute guard, the -6..6
 * clamp with "Nothing happened!" on saturation, the hazeStatReset drop
 * (effects.asm:505-506 re-bakes burn/para penalties after any stage change),
 * and the rose/fell text family.
 */
export function changeStage(
  battle: EffectBattle,
  who: WildBattler,
  stat: StageStat,
  delta: number,
  fromEnemy: boolean,
): EffectMsgs {
  if (fromEnemy && (who.substituteHP !== undefined || who.mist)) {
    if (who.mist) return [`${displayName(who)} is\nprotected by MIST!`];
    return ["But, it failed!"];
  }
  const cur = who.stages[stat] ?? 0;
  const next = Math.max(-6, Math.min(6, cur + delta));
  if (next === cur) return ["Nothing happened!"];
  who.stages[stat] = next;
  who.hazeStatReset = undefined;
  const label = STAT_LABEL[stat];
  if (delta >= 2) return [`${displayName(who)}'s\n${label}\ngreatly rose!`];
  if (delta === 1) return [`${displayName(who)}'s\n${label} rose!`];
  if (delta === -1) return [`${displayName(who)}'s\n${label} fell!`];
  return [`${displayName(who)}'s\n${label}\ngreatly fell!`];
}

/**
 * src/battle/StatusRegistry.lua:22-57 inflict — the shared immunity rules
 * (substitute blocks poison + every secondary; secondary same-type block)
 * then the record's canInflict/onInflict off rules/status RECORDS.
 */
export function inflictStatus(
  battle: EffectBattle,
  target: WildBattler,
  status: string,
  opts: { toxic?: boolean; moveType?: string; secondary?: boolean; source?: string },
): string[] {
  if (target.mon.status) return [];
  if (target.substituteHP !== undefined && (opts.secondary || status === "PSN")) {
    return [];
  }
  // FreezeBurnParalyzeEffect: a secondary status never lands when the move's
  // type matches either of the target's types (StatusRegistry.lua:31-37)
  if (opts.secondary && status !== "PSN") {
    for (const t of target.curTypes ?? []) {
      if (opts.moveType === t) return [];
    }
  }
  const record = recordFor(target.statuses, status) ?? recordFor(undefined, status);
  if (record?.canInflict && !record.canInflict(target, { moveType: opts.moveType })) {
    return [];
  }
  target.mon.status = status;
  const display = displayName(target);
  if (record?.onInflict) {
    return record.onInflict(target, { toxic: opts.toxic }, display, battle.rng);
  }
  return [`${display}\nwas afflicted\nby ${record?.label ?? status}!`];
}

// ---------------------------------------------------------------------------
// The handlers: every record in MoveEffects.lua except Mimic (see EFFECTS).
// ---------------------------------------------------------------------------

const FAILED = "But, it failed!";

function statusMove(status: string): EffectRecord["run"] {
  // MoveEffects.lua:96-114 statusMove — already statused, or poison into a
  // substitute, fails; otherwise the registry inflict, which may refuse
  return (ctx) => {
    if (ctx.target.mon.status) return [FAILED];
    if (status === "PSN" && ctx.target.substituteHP !== undefined) return [FAILED];
    const msgs = inflictStatus(ctx.battle, ctx.target, status, {
      toxic: ctx.move.id === "TOXIC",
      moveType: ctx.move.type,
      source: ctx.move.id,
    });
    return msgs.length === 0 ? [FAILED] : msgs;
  };
}

/** MoveEffects.lua:153-159 confuse — 2-5 turns. */
function confuse(battle: EffectBattle, target: WildBattler, pierceSub = false): EffectMsgs {
  if (target.confusedTurns !== undefined || (target.substituteHP !== undefined && !pierceSub)) {
    return [FAILED];
  }
  target.confusedTurns = randRange(battle.rng, 2, 5);
  return [`${displayName(target)}\nbecame confused!`];
}

/** MoveEffects.lua:444-458 drainHalf. */
function drainHalf(text: (target: string) => string): (ctx: EffectCtx) => void {
  return (ctx) => {
    const heal = Math.max(1, Math.floor((ctx.rawDamage ?? 0) / 2));
    ctx.battle.lastDamage = heal;
    const mon = ctx.user.mon;
    mon.hp = Math.min(mon.stats.hp, mon.hp + heal);
    ctx.battle.drainNext(ctx.user);
    ctx.say(text(displayName(ctx.target)));
  };
}

// MoveEffects.lua:413-416 FIXED_DAMAGE
const FIXED_DAMAGE: Record<string, number | "level" | "half_level_rand"> = {
  SONICBOOM: 20,
  DRAGON_RAGE: 40,
  SEISMIC_TOSS: "level",
  NIGHT_SHADE: "level",
  PSYWAVE: "half_level_rand",
};

function statUp(stat: StageStat, delta: number): EffectRecord["run"] {
  // MoveEffects.lua:74-78 statUp — the USER's stage, and no MIST guard
  return (ctx) => ctx.changeStage(ctx.user, stat, delta, false);
}

function statDown(stat: StageStat, delta: number): EffectRecord["run"] {
  // MoveEffects.lua:80-84 statDown
  return (ctx) => ctx.changeStage(ctx.target, stat, -delta, true);
}

function flinchSide(chance: number): EffectRecord["run"] {
  // MoveEffects.lua:140-149 flinchSide — substitute blocks it, then
  // rand(0..255) < chance; the flinch itself prints nothing
  return (ctx) => {
    if (ctx.target.substituteHP !== undefined) return [];
    if (ctx.battle.rng.byte() < chance) ctx.target.flinched = true;
    return [];
  };
}

function statDownSide(stat: StageStat): EffectRecord["run"] {
  // MoveEffects.lua:133-141 statDownSide — 33 percent + 1 (85/256); the
  // side-effect branch never runs MoveHitTest so it pierces MIST
  return (ctx) => {
    if (ctx.target.substituteHP !== undefined) return [];
    if (ctx.battle.rng.byte() >= 85) return [];
    return ctx.changeStage(ctx.target, stat, -1, false);
  };
}

function statusSide(status: string, chance: number): EffectRecord["run"] {
  // MoveEffects.lua:116-131 statusSide — CheckDefrost first, then the
  // rand(0..255) < chance gate, then the registry inflict
  return (ctx) => {
    if (ctx.move.type === "FIRE" && ctx.target.mon.status === "FRZ") {
      ctx.target.mon.status = null;
      return [`Fire defrosted\n${displayName(ctx.target)}!`];
    }
    if (ctx.battle.rng.byte() >= chance) return [];
    return inflictStatus(ctx.battle, ctx.target, status, {
      moveType: ctx.move.type,
      secondary: true,
      source: ctx.move.id,
    }) as EffectMsgs;
  };
}

// ---------------------------------------------------------------------------
// MoveEffects.lua:165-358 primary — status-only moves
// ---------------------------------------------------------------------------

type PrimaryRun = NonNullable<EffectRecord["run"]>;

const PRIMARY: Record<string, PrimaryRun> = {
  ATTACK_UP1_EFFECT: statUp("attack", 1)!,
  ATTACK_UP2_EFFECT: statUp("attack", 2)!,
  DEFENSE_UP1_EFFECT: statUp("defense", 1)!,
  DEFENSE_UP2_EFFECT: statUp("defense", 2)!,
  SPEED_UP2_EFFECT: statUp("speed", 2)!,
  SPECIAL_UP1_EFFECT: statUp("special", 1)!,
  SPECIAL_UP2_EFFECT: statUp("special", 2)!,
  EVASION_UP1_EFFECT: statUp("evasion", 1)!,

  ATTACK_DOWN1_EFFECT: statDown("attack", 1)!,
  DEFENSE_DOWN1_EFFECT: statDown("defense", 1)!,
  DEFENSE_DOWN2_EFFECT: statDown("defense", 2)!,
  SPEED_DOWN1_EFFECT: statDown("speed", 1)!,
  ACCURACY_DOWN1_EFFECT: statDown("accuracy", 1)!,

  SLEEP_EFFECT: statusMove("SLP")!,
  POISON_EFFECT: statusMove("PSN")!,
  PARALYZE_EFFECT: statusMove("PAR")!,

  CONFUSION_EFFECT: (ctx) => confuse(ctx.battle, ctx.target),

  // leech_seed.asm has no substitute check: seeding lands through one
  LEECH_SEED_EFFECT: (ctx) => {
    if (ctx.target.leechSeeded) return [FAILED];
    for (const t of ctx.target.curTypes) {
      if (t === "GRASS") return [FAILED];
    }
    ctx.target.leechSeeded = true;
    return [`${displayName(ctx.target)}\nwas seeded!`];
  },

  HEAL_EFFECT: (ctx) => {
    const mon = ctx.user.mon;
    if (ctx.move.id === "REST") {
      if (mon.hp === mon.stats.hp) return [FAILED];
      mon.hp = mon.stats.hp;
      mon.status = "SLP";
      ctx.user.sleepTurns = 2;
      ctx.user.toxicCounter = undefined;
      return [`${displayName(ctx.user)}\nstarted sleeping!`];
    }
    if (mon.hp === mon.stats.hp) return [FAILED];
    mon.hp = Math.min(mon.stats.hp, mon.hp + Math.floor(mon.stats.hp / 2));
    return [`${displayName(ctx.user)}\nregained health!`];
  },

  LIGHT_SCREEN_EFFECT: (ctx) => {
    if (ctx.user.lightScreen) return [FAILED];
    ctx.user.lightScreen = true;
    return [`${displayName(ctx.user)}'s\nprotected against\nspecial attacks!`];
  },

  REFLECT_EFFECT: (ctx) => {
    if (ctx.user.reflect) return [FAILED];
    ctx.user.reflect = true;
    return [`${displayName(ctx.user)}\ngained armor!`];
  },

  MIST_EFFECT: (ctx) => {
    if (ctx.user.mist) return [FAILED];
    ctx.user.mist = true;
    return [`${displayName(ctx.user)}'s\nshrouded in mist!`];
  },

  FOCUS_ENERGY_EFFECT: (ctx) => {
    if (ctx.user.focusEnergy) return [FAILED];
    ctx.user.focusEnergy = true;
    return [`${displayName(ctx.user)}'s\ngetting pumped!`];
  },

  HAZE_EFFECT: (ctx) => {
    for (const b of [ctx.user, ctx.target]) {
      b.stages = {};
      b.confusedTurns = undefined;
      b.leechSeeded = undefined;
      b.toxicCounter = undefined;
      b.reflect = undefined;
      b.lightScreen = undefined;
      b.mist = undefined;
      b.focusEnergy = undefined;
      b.disabledSlot = undefined;
      b.disabledTurns = undefined;
      b.xAccuracy = undefined;
      // haze.asm ResetStats lifts the burn/para penalty until the next
      // stat recompute
      b.hazeStatReset = true;
    }
    // curing the enemy's sleep or freeze forfeits its move this turn
    const st = ctx.target.mon.status;
    if (st === "SLP" || st === "FRZ") ctx.target.skipMove = true;
    ctx.target.mon.status = null;
    return ["All STATUS changes\nare eliminated!"];
  },

  // substitute.asm: both failures print with no animation (msgs.failed)
  SUBSTITUTE_EFFECT: (ctx) => {
    const user = ctx.user;
    if (user.substituteHP !== undefined) {
      const m: EffectMsgs = [`${displayName(user)}\nhas a SUBSTITUTE!`];
      m.failed = true;
      return m;
    }
    const cost = Math.floor(user.mon.stats.hp / 4);
    if (user.mon.hp < cost) {
      const m: EffectMsgs = ["Too weak to make\na SUBSTITUTE!"];
      m.failed = true;
      return m;
    }
    user.mon.hp -= cost;
    user.substituteHP = cost + 1;
    return ["It created a\nSUBSTITUTE!"];
  },

  CONVERSION_EFFECT: (ctx) => {
    if (ctx.target.invulnerable) return [FAILED];
    ctx.user.curTypes = [...ctx.target.curTypes];
    return [`Converted type to\n${displayName(ctx.target)}'s!`];
  },

  TRANSFORM_EFFECT: (ctx) => {
    const { user, target } = ctx;
    user.curStats = {
      ...user.mon.stats,
      attack: target.curStats.attack,
      defense: target.curStats.defense,
      speed: target.curStats.speed,
      special: target.curStats.special,
    };
    user.curTypes = [...target.curTypes];
    user.stages = { ...target.stages };
    // a fresh list, so the party mon's own moves are never overwritten
    user.curMoves = target.curMoves.map((mv) => ({ id: mv.id, pp: 5 }));
    user.transformedInto = target.mon.species;
    return [`${displayName(user)}\ntransformed into\n${target.name}!`];
  },

  DISABLE_EFFECT: (ctx) => {
    const target = ctx.target;
    if (target.disabledSlot !== undefined) return [FAILED];
    const usable: number[] = [];
    target.curMoves.forEach((mv, i) => {
      if (mv.pp > 0) usable.push(i + 1);
    });
    if (usable.length === 0) return [FAILED];
    const slot = usable[randRange(ctx.rng, 1, usable.length) - 1]!;
    target.disabledSlot = slot;
    target.disabledTurns = randRange(ctx.rng, 1, 8);
    const id = target.curMoves[slot - 1]!.id;
    return [`${displayName(target)}'s\n${ctx.data.moves[id]?.name ?? id} was\ndisabled!`];
  },

  SPLASH_EFFECT: () => ["No effect!"],
};

// MoveEffects.lua:403-409 ACC_CHECKED — the handlers that call MoveHitTest
const ACC_CHECKED = new Set([
  "SLEEP_EFFECT",
  "POISON_EFFECT",
  "PARALYZE_EFFECT",
  "CONFUSION_EFFECT",
  "LEECH_SEED_EFFECT",
  "DISABLE_EFFECT",
  "ATTACK_DOWN1_EFFECT",
  "DEFENSE_DOWN1_EFFECT",
  "DEFENSE_DOWN2_EFFECT",
  "SPEED_DOWN1_EFFECT",
  "ACCURACY_DOWN1_EFFECT",
]);

// ---------------------------------------------------------------------------
// MoveEffects.lua:364-392 secondary — after-damage side effects
// ---------------------------------------------------------------------------

const SECONDARY: Record<string, PrimaryRun> = {
  BURN_SIDE_EFFECT1: statusSide("BRN", 26)!,
  BURN_SIDE_EFFECT2: statusSide("BRN", 77)!,
  FREEZE_SIDE_EFFECT1: statusSide("FRZ", 26)!,
  PARALYZE_SIDE_EFFECT1: statusSide("PAR", 26)!,
  PARALYZE_SIDE_EFFECT2: statusSide("PAR", 77)!,
  POISON_SIDE_EFFECT1: statusSide("PSN", 52)!,
  POISON_SIDE_EFFECT2: statusSide("PSN", 103)!,
  FLINCH_SIDE_EFFECT1: flinchSide(26)!,
  FLINCH_SIDE_EFFECT2: flinchSide(77)!,
  ATTACK_DOWN_SIDE_EFFECT: statDownSide("attack")!,
  DEFENSE_DOWN_SIDE_EFFECT: statDownSide("defense")!,
  SPEED_DOWN_SIDE_EFFECT: statDownSide("speed")!,
  SPECIAL_DOWN_SIDE_EFFECT: statDownSide("special")!,
  // cp 10 percent (25/256), and it pierces a substitute
  CONFUSION_SIDE_EFFECT: (ctx) => {
    if (ctx.target.confusedTurns !== undefined) return [];
    if (ctx.battle.rng.byte() >= 25) return [];
    return confuse(ctx.battle, ctx.target, true);
  },
  // the second hit reroutes to PoisonEffect, 52/256
  TWINEEDLE_EFFECT: (ctx) => {
    if (ctx.battle.rng.byte() >= 52) return [];
    return inflictStatus(ctx.battle, ctx.target, "PSN", {
      secondary: true,
      source: "TWINEEDLE",
    }) as EffectMsgs;
  },
};

// ---------------------------------------------------------------------------
// MoveEffects.lua:479-731 full — the damaging pipeline's stage callbacks
// ---------------------------------------------------------------------------

type FullSpec = Omit<EffectRecord, "kind">;

function hitsFrom(dist: number | number[], ctx: EffectCtx): number {
  if (typeof dist === "number") return dist;
  return dist[randRange(ctx.rng, 0, dist.length - 1)]!;
}

const plainInfo = (): DamageInfo => ({ crit: false, typeMult: 10 });

const FULL: Record<string, FullSpec> = {
  NO_ADDITIONAL_EFFECT: {},

  TWO_TO_FIVE_ATTACKS_EFFECT: {
    hitCount: (ctx) =>
      hitsFrom(
        (ctx.move as MoveDef & { multiHit?: number | number[] }).multiHit ?? [
          2, 2, 2, 3, 3, 3, 4, 5,
        ],
        ctx,
      ),
  },
  ATTACK_TWICE_EFFECT: {
    hitCount: (ctx) =>
      hitsFrom((ctx.move as MoveDef & { multiHit?: number | number[] }).multiHit ?? 2, ctx),
  },
  TWINEEDLE_EFFECT: {
    hitCount: (ctx) =>
      hitsFrom((ctx.move as MoveDef & { multiHit?: number | number[] }).multiHit ?? 2, ctx),
  },

  // SetDamageEffects skip the type chart entirely (#616)
  SPECIAL_DAMAGE_EFFECT: {
    chooseDamage: (ctx) => {
      const spec = FIXED_DAMAGE[ctx.move.id];
      let dmg: number | undefined;
      if (spec === "level") dmg = ctx.user.mon.level;
      else if (spec === "half_level_rand") {
        const max = Math.max(1, Math.floor((ctx.user.mon.level * 3) / 2) - 1);
        dmg = randRange(ctx.rng, 1, max);
      } else dmg = spec;
      if (!dmg) return [null, FAILED];
      return [dmg, plainInfo()];
    },
  },
  SUPER_FANG_EFFECT: {
    chooseDamage: (ctx) => [Math.max(1, Math.floor(ctx.target.mon.hp / 2)), plainInfo()],
  },
  OHKO_EFFECT: {
    // fails against a faster foe and an immune type
    gate: (ctx) => {
      if (ctx.battle.chart.effectiveness(ctx.move.type, ctx.target.curTypes) === 0) {
        return [false, `It doesn't affect\n${displayName(ctx.target)}!`];
      }
      if (effectiveSpeed(ctx.user) < effectiveSpeed(ctx.target)) return [false, FAILED];
      return [true];
    },
    chooseDamage: () => [65535, { crit: false, typeMult: 10, ohko: true }],
  },

  // recoil.asm reads the RAW computed wDamage, div 2 for Struggle
  RECOIL_EFFECT: {
    afterDamage: (ctx) => {
      const recoil = Math.max(
        1,
        Math.floor((ctx.rawDamage ?? 0) / (ctx.moveInst.struggle ? 2 : 4)),
      );
      ctx.say(`${displayName(ctx.user)}'s\nhit with recoil!`);
      ctx.battle.applyDamage(ctx.user, recoil);
    },
  },
  DRAIN_HP_EFFECT: {
    afterDamage: drainHalf((t) => `Sucked health from\n${t}!`),
  },
  DREAM_EATER_EFFECT: {
    gate: (ctx) => (ctx.target.mon.status !== "SLP" ? [false, FAILED] : [true]),
    afterDamage: drainHalf((t) => `${t}'s\ndream was eaten!`),
  },

  // first turn charges; Fly AND Dig go semi-invulnerable
  CHARGE_EFFECT: { charge: { anim: "XSTATITEM_ANIM", enemyAnim: "XSTATITEM_DUPLICATE_ANIM" } },
  FLY_EFFECT: { charge: { invulnerable: true, anim: "TELEPORT" } },

  TRAPPING_EFFECT: {
    // TrappingEffect runs BEFORE the hit test and clears the target's
    // Hyper Beam recharge even if the move then misses
    beforeAccuracy: (ctx) => {
      if (ctx.user.trappingTurns === undefined) ctx.target.mustRecharge = undefined;
    },
    afterDamage: (ctx) => {
      const user = ctx.user;
      if (user.trappingTurns === undefined) {
        // 1-4 CONTINUATION attacks follow (weights 3/8 3/8 1/8 1/8)
        const r = randRange(ctx.rng, 0, 7);
        user.trappingTurns = [1, 1, 1, 2, 2, 2, 3, 4][r]!;
        user.trapDamage = ctx.rawDamage;
        user.trapMove = ctx.move.id;
      }
    },
  },
  THRASH_PETAL_DANCE_EFFECT: {
    afterDamage: (ctx) => {
      const user = ctx.user;
      if (user.thrashTurns === undefined) {
        user.thrashTurns = randRange(ctx.rng, 2, 3);
        user.thrashMove = ctx.moveInst;
        user.thrashAnnounced = true;
      } else {
        user.thrashTurns -= 1;
        if (user.thrashTurns <= 0) {
          user.thrashTurns = undefined;
          user.thrashMove = undefined;
          user.thrashAnnounced = undefined;
          if (user.confusedTurns === undefined) {
            user.confusedTurns = randRange(ctx.rng, 2, 5);
            ctx.say(`${displayName(user)}\nbecame confused!`);
          }
        }
      }
    },
  },
  JUMP_KICK_EFFECT: {
    onMiss: (ctx, reason) => {
      if (reason !== "accuracy") return;
      ctx.say(`${displayName(ctx.user)}\nkept going and\ncrashed!`);
      ctx.damage(ctx.user, 1);
    },
  },
  EXPLODE_EFFECT: {
    explode: true,
    onMiss: (ctx) => ctx.battle.selfDestruct(ctx.user),
    afterDamage: (ctx) => ctx.battle.selfDestruct(ctx.user),
  },
  HYPER_BEAM_EFFECT: {
    // Gen 1: no recharge when the target faints or its substitute breaks
    afterDamage: (ctx) => {
      const skipOnKO =
        (ctx.battle.ruleset as { hyperBeamSkipRechargeOnKO?: boolean })
          .hyperBeamSkipRechargeOnKO !== false;
      const targetDown = ctx.target.mon.hp <= 0 || ctx.brokeSub;
      if (!skipOnKO || !targetDown) ctx.user.mustRecharge = true;
    },
  },
  PAY_DAY_EFFECT: {
    afterDamage: (ctx) => {
      ctx.battle.payDay += 2 * ctx.user.mon.level;
      ctx.say("Coins scattered\neverywhere!");
    },
  },
  SWIFT_EFFECT: { neverMiss: true },
  RAGE_EFFECT: {
    afterDamage: (ctx) => {
      ctx.user.rageMove = ctx.moveInst;
    },
  },

  // the storing turn plays XSTATITEM_ANIM, never BIDE's own (#375)
  BIDE_EFFECT: {
    perform: (ctx) => {
      const user = ctx.user;
      user.bideTurns = randRange(ctx.rng, 2, 3);
      user.bideDamage = 0;
      ctx.battle.cancelMoveAnim();
      ctx.battle.animNext(
        user.isPlayer ? "XSTATITEM_ANIM" : "XSTATITEM_DUPLICATE_ANIM",
        user.isPlayer,
      );
      ctx.say(`${displayName(user)}\nis storing energy!`);
    },
  },
  SWITCH_AND_TELEPORT_EFFECT: {
    perform: (ctx) => {
      const { battle, user, target, move } = ctx;
      if (!battle.trainerBattle) {
        const uLvl = user.mon.level;
        const tLvl = target.mon.level;
        let ok = uLvl >= tLvl;
        if (!ok) ok = randRange(ctx.rng, 0, uLvl + tLvl) >= Math.floor(tLvl / 4);
        if (ok) {
          if (move.id === "ROAR") ctx.say(`${displayName(target)}\nran away scared!`);
          else if (move.id === "WHIRLWIND") ctx.say(`${displayName(target)}\nwas blown away!`);
          else ctx.say(`${displayName(user)}\nran from battle!`);
          battle.escape();
        } else if (move.id === "TELEPORT") {
          battle.cancelMoveAnim();
          ctx.say(FAILED);
        } else {
          battle.cancelMoveAnim();
          ctx.say(`It didn't affect\n${displayName(target)}!`);
        }
      } else if (move.id === "TELEPORT") {
        battle.cancelMoveAnim();
        ctx.say(FAILED);
      } else {
        battle.cancelMoveAnim();
        ctx.say(`${displayName(target)}\nis unaffected!`);
      }
    },
  },
  METRONOME_EFFECT: {
    callsMove: (ctx) => {
      const order =
        (ctx.data.constants as { moveOrder?: string[] } | undefined)?.moveOrder ??
        Object.keys(ctx.data.moves);
      for (let tries = 0; tries < 1000; tries++) {
        const pick = order[randRange(ctx.rng, 1, order.length) - 1]!;
        if (pick !== "METRONOME" && pick !== "STRUGGLE" && ctx.data.moves[pick]) return pick;
      }
      return null;
    },
  },
  MIRROR_MOVE_EFFECT: {
    callsMove: (ctx) => {
      const last = ctx.target.lastMove;
      if (!last) {
        ctx.say("The MIRROR MOVE\nfailed!");
        return null;
      }
      return last;
    },
  },
};

// MoveEffects.lua:760-776 — the registry view: one record per effect
export const EFFECTS: Record<string, EffectRecord> = {};
for (const [id, run] of Object.entries(PRIMARY)) {
  EFFECTS[id] = { kind: "primary", run, accuracyChecked: ACC_CHECKED.has(id) || undefined };
}
for (const [id, run] of Object.entries(SECONDARY)) {
  EFFECTS[id] = { kind: "secondary", run };
}
for (const [id, spec] of Object.entries(FULL)) {
  const record: EffectRecord = { kind: "full", ...spec };
  // TWINEEDLE: a full record whose secondary run is honoured post-damage
  const secondary = SECONDARY[id];
  if (secondary) record.run = secondary;
  EFFECTS[id] = record;
}

// MIMIC_EFFECT is the one reference effect not registered: its copy menu
// pauses the message queue mid-move, which this port's queue has no row
// for yet. It takes the unknown-status fallback ("But, it failed!").

const warned = new Set<string>();

/** MoveEffects.lua:786-793 warnUnknown. */
export function warnUnknown(effect: string): void {
  if (!warned.has(effect)) {
    warned.add(effect);
    console.warn(`move effect ${effect} not implemented; treated as plain damage`);
  }
}

export function effectRecord(effect: string | undefined): EffectRecord | undefined {
  return effect === undefined ? undefined : EFFECTS[effect];
}

/** EffectRegistry.lua:37-80 makeCtx. */
export function makeCtx(
  battle: EffectBattle,
  user: WildBattler,
  target: WildBattler,
  move: MoveDef,
  moveInst: { id: string; pp: number; struggle?: boolean },
  isCalled: boolean,
): EffectCtx {
  return {
    battle,
    data: battle.data,
    rng: battle.rng,
    ruleset: battle.ruleset,
    user,
    target,
    move,
    moveInst,
    isCalled,
    say: (text) => battle.sayNext(text),
    damage: (who, amount) => {
      const dealt = battle.applyDamage(who, amount);
      if (who.mon.hp <= 0) battle.onFaint(who);
      return dealt;
    },
    changeStage: (who, stat, delta, fromEnemy) =>
      changeStage(battle, who, stat, delta, fromEnemy),
  };
}

/**
 * EffectRegistry.lua:24-27 missBeat — a registered miss (accuracy, type
 * immunity, floored 0.25x damage, invulnerable target) pays the
 * `ld c, 30 / call DelayFrames` hold (core.asm:3155-3158/:5588) unless the
 * effect explodes.
 */
function missBeat(battle: EffectBattle, record: EffectRecord | undefined): void {
  if (record?.explode) return;
  battle.waitNext(MOVE_STATUS_OR_MISS);
}

/** EffectRegistry.lua:84-93 hitCount. */
function hitCount(ctx: EffectCtx, record: EffectRecord | undefined): number {
  if (record?.hitCount) return record.hitCount(ctx) || 1;
  const dist = (ctx.move as MoveDef & { multiHit?: number | number[] }).multiHit;
  if (dist === undefined) return 1;
  if (typeof dist === "number") return dist;
  const r = randRange(ctx.rng, 0, dist.length - 1);
  return dist[r];
}

/**
 * EffectRegistry.lua:99-316 runDamaging — the staged damaging pipeline:
 * invulnerability -> gate -> hit count -> pre-accuracy -> accuracy ->
 * damage choice -> hits (crit/effectiveness text per strike) -> multi-hit
 * tally -> after-damage -> secondary run -> faint checks. Check order and
 * rng consumption are the original's.
 */
export function runDamaging(
  battle: EffectBattle,
  ctx: EffectCtx,
  record: EffectRecord | undefined,
): void {
  const { user, target, move, moveInst } = ctx;
  const neverMiss = record?.neverMiss;

  if (target.invulnerable && !neverMiss) {
    if (!record?.explode) battle.cancelMoveAnim();
    missBeat(battle, record);
    battle.sayNext(`${displayName(user)}'s\nattack missed!`);
    record?.onMiss?.(ctx, "invulnerable");
    return;
  }

  if (record?.gate) {
    const [ok, failMsg] = record.gate(ctx);
    if (!ok) {
      battle.cancelMoveAnim();
      if (failMsg) battle.sayNext(failMsg);
      return;
    }
  }

  const hitsWanted = hitCount(ctx, record);

  record?.beforeAccuracy?.(ctx);

  if (!neverMiss) {
    if (!battle.accuracyRoll(move, user, target)) {
      if (!record?.explode) battle.cancelMoveAnim();
      missBeat(battle, record);
      battle.sayNext(`${displayName(user)}'s\nattack missed!`);
      record?.onMiss?.(ctx, "accuracy");
      user.trappingTurns = undefined;
      return;
    }
  }

  // damage per hit (EffectRegistry.lua:148-203); COUNTER is unreachable in
  // v1's move set but the branch is self-contained, so it rides along
  let dmg: number;
  let info: DamageInfo & { ohko?: boolean };
  if (move.id === "COUNTER") {
    const lastId = target.lastMove;
    const lm = lastId && lastId !== "COUNTER" ? battle.data.moves[lastId] : undefined;
    let counterable = false;
    if (lm && (lm.power ?? 0) > 0) {
      counterable = lm.type === "NORMAL" || lm.type === "FIGHTING";
    }
    if (!counterable || battle.lastDamage === 0) {
      battle.cancelMoveAnim();
      missBeat(battle, record);
      battle.sayNext(`${displayName(user)}'s\nattack missed!`);
      return;
    }
    dmg = Math.min(65535, battle.lastDamage * 2);
    info = { crit: false, typeMult: 10 };
  } else if (record?.chooseDamage) {
    const [chosen, extra] = record.chooseDamage(ctx);
    if (chosen === null || chosen === undefined) {
      battle.cancelMoveAnim();
      if (typeof extra === "string") battle.sayNext(extra);
      return;
    }
    dmg = chosen;
    info = typeof extra === "object" && extra ? extra : { crit: false, typeMult: 10 };
  } else {
    [dmg, info] = battle.computeDamage(user, target, move, {
      rng: battle.rng,
      explode: record?.explode || undefined,
    });
  }

  if (info.typeMult === 0) {
    if (!record?.explode) battle.cancelMoveAnim();
    missBeat(battle, record);
    battle.sayNext(`It doesn't affect\n${displayName(target)}!`);
    record?.onMiss?.(ctx, "immune");
    return;
  }
  if (info.missed) {
    if (!record?.explode) battle.cancelMoveAnim();
    missBeat(battle, record);
    battle.sayNext(`${displayName(user)}'s\nattack missed!`);
    record?.onMiss?.(ctx, "floored");
    return;
  }
  battle.lastDamage = dmg;

  const hitSfx =
    info.typeMult > 10 ? "Super_Effective" : info.typeMult < 10 ? "Not_Very_Effective" : "Damage";
  // GetPlayerAnimationType / GetEnemyAnimationType (core.asm:3159/:5555):
  // 4/1 for a damaging move with no added effect, 5/2 once it has one
  const added = move.effect !== undefined && move.effect !== "NO_ADDITIONAL_EFFECT";
  const hitFx: HitFx = {
    sfx: hitSfx,
    animType: user.isPlayer ? (added ? 5 : 4) : added ? 2 : 1,
  };

  let totalDealt = 0;
  let landed = 0;
  let brokeSub = false;
  for (let h = 1; h <= hitsWanted; h++) {
    if (target.mon.hp <= 0) break;
    // hit 1 reuses the announcement-time moveAnimRow; later hits queue
    // fresh anim rows (EffectRegistry.lua:227-241)
    const hitRow =
      h === 1
        ? (battle.moveAnimRow ?? battle.insertHitRow(null, user.isPlayer))
        : battle.insertHitRow(move.id, user.isPlayer);
    const hadSub = target.substituteHP !== undefined;
    const dealt = battle.applyDamage(target, dmg);
    totalDealt += dealt;
    landed = h;
    if (dealt > 0) hitRow.hit = hitFx;
    if (info.crit) battle.sayNext("Critical hit!");
    if (info.ohko) battle.sayNext("One-hit KO!");
    // PrintCriticalOHKOText's closing `ld c, 20 / jp DelayFrames` is paid on
    // EVERY landed hit (core.asm:3812-3814; EffectRegistry.lua:253-259)
    battle.waitNext(CRIT_OHKO_TEXT);
    if (info.typeMult > 10) {
      battle.sayNext("It's super\neffective!");
    } else if (info.typeMult < 10) {
      battle.sayNext("It's not very\neffective...");
    }
    if (hadSub && target.substituteHP === undefined) {
      brokeSub = true;
      break;
    }
  }
  const hits = landed > 0 ? landed : hitsWanted;
  if (hits > 1) {
    battle.sayNext(
      user.isPlayer ? `Hit the enemy\n${hits} times!` : `Hit ${hits} times!`,
    );
  }

  ctx.rawDamage = dmg;
  ctx.totalDealt = totalDealt;
  ctx.brokeSub = brokeSub;
  ctx.hits = hits;
  if (record?.afterDamage) {
    record.afterDamage(ctx, totalDealt);
  } else if (moveInst.struggle) {
    // struggle recoils even when its effect id resolves to no record
    // (EffectRegistry.lua:292-297)
    const recoil = Math.max(1, Math.floor(dmg / 2));
    battle.sayNext(`${displayName(user)}'s\nhit with recoil!`);
    battle.applyDamage(user, recoil);
  }

  if (record?.run && record.kind !== "primary" && target.mon.hp > 0 && totalDealt > 0) {
    for (const m of record.run(ctx)) battle.sayNext(m);
  }
  if (record === undefined && move.effect) {
    warnUnknown(move.effect);
  }

  if (target.mon.hp <= 0) battle.onFaint(target);
  if (user.mon.hp <= 0) battle.onFaint(user);
}
