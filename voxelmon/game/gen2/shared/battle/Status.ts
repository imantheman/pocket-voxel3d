// Status conditions: a port of gen1recomp src/battle/Status.lua (bdfac727, MIT).
//
// Per-turn status/volatile condition handling (Gen 1 semantics).
//
// The persistent conditions live in Status.RECORDS; a battle passes its
// merged Data.statuses so mod statuses join the same beforeMove gauntlet
// and residual sweep.  Callers without a battle (pure-module tests) fall
// back to the vanilla records, which is bit-identical behavior.
//
// Port notes: Lua's multiple returns are tuples here -- a record's
// beforeMove and Status.beforeMove return [canMove, messages, selfHit?].
// battler.disabledSlot keeps the Lua's 1-based move slot.

import { Strings } from "../core/Strings.ts";
import { RomText } from "../core/RomText.ts";
import { sortedKeys, tostring, truthy } from "../../platform/lua.ts";

/** `src.core.RomText` is a Lua `return function(...)`; call it as the Lua does. */
function romText(data: any, label: string, fallback: string, ...args: any[]): string {
  return (RomText as any)(data, label, fallback, ...args);
}

/** [canMove, messages, selfHit] */
export type BeforeMoveResult = [boolean, string[], boolean?];
/** `rng(lo, hi)`, inclusive (love.math.random's two-argument form). */
export type RangeRng = (lo: number, hi: number) => number;

export interface StatusRecord {
  id: string;
  label: string;
  hudLabel?: string;
  catchBonus?: number;
  shakeBonus?: number;
  beforeMovePriority?: number;
  statPenalty?: { stat: string; div?: number };
  beforeMove?: (battler: any, rng: RangeRng, battle: any) => BeforeMoveResult;
  residual?: (battler: any, opponent: any, battle: any) => string[];
  canInflict?: (target: any, opts?: any) => boolean;
  onInflict?: (battle: any, target: any, opts: any, display: string) => string[];
  [k: string]: any;
}

// pokered's <USER>/<TARGET> text macros print "Enemy " before the enemy
// mon's nickname; these records only know the raw name -- BattleState
// splices the prefix in (prefixEnemy), same as always
// Lua: Status.lua:16
function name(battler: any): string {
  return battler.name;
}

// statuses with beforeMovePriority above this run before the engine's
// held/disable/confusion volatiles; at or below, after (sleep 40 and
// freeze 30 come first, paralysis 10 comes last, like the original
// CheckPlayerStatusConditions order)
const VOLATILE_PRIORITY = 20;

// Lua: Status.lua:26
function hasType(battler: any, wanted: string): boolean {
  for (const t of battler.curTypes ?? []) {
    if (t === wanted) return true;
  }
  return false;
}

// shared PSN/BRN residual: 1/16 max HP, multiplied (and advanced) by the
// Toxic counter (HandlePoisonBurnLeechSeed).  The caller passes the whole
// sentence rather than the noun: "hurt by poison" and "hurt by the burn"
// decline differently once translated, so a shared fragment cannot be the
// translatable unit.
// Lua: Status.lua:38
function damageOverTime(label: string, template: string) {
  return (battler: any, _opponent: any, battle: any): string[] => {
    const mon = battler.mon;
    const base = Math.max(1, Math.floor(mon.stats.hp / 16));
    let dmg = base;
    if (battler.toxicCounter != null && battler.toxicCounter !== false) {
      dmg = base * battler.toxicCounter;
      battler.toxicCounter = battler.toxicCounter + 1;
    }
    mon.hp = Math.max(0, mon.hp - dmg);
    return [romText(battle?.data, label, template, name(battler))];
  };
}

// Lua: Status.lua:276
function battleStatuses(battle: any): Record<string, StatusRecord> | undefined {
  return battle?.data?.statuses;
}

// engine/battle/core.asm:6283
// Lua: Status.lua:171
function penaltyOf(battler: any): StatusRecord["statPenalty"] {
  const record = Status.recordFor(battler.statuses, battler.mon.status);
  return record ? record.statPenalty : undefined;
}

const MAX_PENALTY_STACKS = 32;

// Lua: Status.lua:225
function ensureStacks(battle: any, battler: any): boolean {
  if (truthy(battler.statusPenaltyStacks)) return true;
  if (!Status.rulesetBakes(battle?.ruleset)) return false;
  Status.bakePenalty(battler);
  if (truthy(battler.hazeStatReset)) battler.statusPenaltyStacks = {};
  return true;
}

export const Status = {
  // Labels stay plain literals on purpose: this table is built at require
  // time, before Strings.load has a catalog, so a Strings() here would
  // freeze the English.  They are already translatable through the
  // statuses registry (mod.content.statuses:patch(id, { label = ... })).
  //
  // Do not add a matching hudLabel = "..." below: Status.hudLabelFor reads
  // hudLabel before label, and Registry:patch only overrides the fields a
  // mod actually passes, so a label-only translation patch would be
  // shadowed by this hudLabel forever.
  //
  // The five persistent conditions as records: the beforeMove gauntlet, the
  // residual sweep, the inflict text/immunities (StatusRegistry.inflict),
  // the catch/wobble bonuses (Catching.attempt), the HUD label, and the
  // burn/paralysis stat cut (Damage.compute, TurnOrder.effectiveSpeed) all
  // read these fields, so a mod's sixth status plugs into every consumer.
  // Lua: Status.lua:69
  RECORDS: {
    SLP: {
      id: "SLP",
      label: "SLP",
      catchBonus: 25,
      shakeBonus: 10,
      beforeMovePriority: 40,
      // Lua: Status.lua:74
      beforeMove: (battler: any, _rng: RangeRng, battle: any): BeforeMoveResult => {
        battler.sleepTurns = (battler.sleepTurns ?? 1) - 1;
        if (battler.sleepTurns <= 0) {
          battler.mon.status = undefined;
          // wakes, loses the turn
          return [false, [romText(battle?.data, "_WokeUpText", "%s\nwoke up!", name(battler))]];
        }
        return [false, [romText(battle?.data, "_FastAsleepText", "%s\nis fast asleep!", name(battler))]];
      },
      // Lua: Status.lua:85
      onInflict: (battle: any, target: any, _opts: any, display: string): string[] => {
        target.sleepTurns = battle.rng(1, 7);
        return [romText(battle.data, "_FellAsleepText", "%s\nfell asleep!", display)];
      },
    },
    FRZ: {
      id: "FRZ",
      label: "FRZ",
      catchBonus: 25,
      shakeBonus: 10,
      beforeMovePriority: 30,
      // Lua: Status.lua:95
      beforeMove: (battler: any, _rng: RangeRng, battle: any): BeforeMoveResult => {
        return [false, [romText(battle?.data, "_IsFrozenText", "%s\nis frozen solid!", name(battler))]];
      },
      canInflict: (target: any): boolean => !hasType(target, "ICE"),
      // Lua: Status.lua:100
      onInflict: (battle: any, _target: any, _opts: any, display: string): string[] => {
        return [romText(battle?.data, "_FrozenText", "%s\nwas frozen solid!", display)];
      },
    },
    PSN: {
      id: "PSN",
      label: "PSN",
      catchBonus: 12,
      shakeBonus: 5,
      residual: damageOverTime("_HurtByPoisonText", Strings.source("%s's\nhurt by poison!")),
      canInflict: (target: any): boolean => !hasType(target, "POISON"),
      // Lua: Status.lua:111
      onInflict: (battle: any, target: any, opts: any, display: string): string[] => {
        if (truthy(opts.toxic)) {
          target.toxicCounter = 1;
          return [romText(battle?.data, "_BadlyPoisonedText", "%s's\nbadly poisoned!", display)];
        }
        return [romText(battle?.data, "_PoisonedText", "%s\nwas poisoned!", display)];
      },
    },
    BRN: {
      id: "BRN",
      label: "BRN",
      catchBonus: 12,
      shakeBonus: 5,
      statPenalty: { stat: "attack", div: 2 },
      residual: damageOverTime("_HurtByBurnText", Strings.source("%s's\nhurt by the burn!")),
      canInflict: (target: any): boolean => !hasType(target, "FIRE"),
      // Lua: Status.lua:128
      onInflict: (battle: any, _target: any, _opts: any, display: string): string[] => {
        return [romText(battle?.data, "_BurnedText", "%s\nwas burned!", display)];
      },
    },
    PAR: {
      id: "PAR",
      label: "PAR",
      catchBonus: 12,
      shakeBonus: 5,
      statPenalty: { stat: "speed", div: 4 },
      beforeMovePriority: 10,
      // Lua: Status.lua:138
      beforeMove: (battler: any, rng: RangeRng, battle: any): BeforeMoveResult => {
        // cp 25 percent / jr nc: fully paralyzed on rand < 63 (63/256)
        if (rng(0, 255) < 63) {
          return [false, [romText(battle?.data, "_FullyParalyzedText", "%s's\nfully paralyzed!", name(battler))]];
        }
        return [true, []];
      },
      // Lua: Status.lua:146
      canInflict: (target: any, opts: any): boolean => {
        // ParalyzeEffect_: Electric-type moves can't paralyze Ground-types
        return !(opts.moveType === "ELECTRIC" && hasType(target, "GROUND"));
      },
      // Lua: Status.lua:150
      onInflict: (battle: any, _target: any, _opts: any, display: string): string[] => {
        // primary and secondary paralysis share this line
        return [romText(battle?.data, "_ParalyzedMayNotAttackText", "%s's\nparalyzed! It may\nnot attack!", display)];
      },
    },
  } as Record<string, StatusRecord>,

  // Lua: Status.lua:158
  registerInto(registry: any, _data: any, owner?: any): void {
    for (const id of sortedKeys(Status.RECORDS)) {
      registry.register(id, Status.RECORDS[id], owner);
    }
  },

  // the merged view when a battle is on hand, the vanilla records otherwise
  // Lua: Status.lua:165
  recordFor(statuses: Record<string, StatusRecord> | null | undefined, id: string | null | undefined): StatusRecord | undefined {
    if (id == null) return undefined;
    return (statuses ?? Status.RECORDS)[id];
  },

  // Lua: Status.lua:178
  penaltyStacks(battler: any, stat: string): number {
    const p = penaltyOf(battler);
    if (!p || p.stat !== stat) return 0;
    const t = battler.statusPenaltyStacks;
    const n = truthy(t) ? (t[stat] ?? 0) : truthy(battler.hazeStatReset) ? 0 : 1;
    if (typeof n !== "number" || n !== n || n < 0) return 0;
    return Math.min(n, MAX_PENALTY_STACKS);
  },

  // Lua: Status.lua:187
  applyPenalty(battler: any, stat: string, value: number): number {
    const p = penaltyOf(battler);
    if (!p || p.stat !== stat) return value;
    const div = Math.max(1, p.div ?? 1);
    const stacks = Status.penaltyStacks(battler, stat);
    for (let i = 1; i <= stacks; i++) {
      value = Math.max(1, Math.floor(value / div));
    }
    return value;
  },

  // core.asm:1658
  // experience.asm:237
  // Lua: Status.lua:199
  bakePenalty(battler: any): void {
    const t: Record<string, number> = {};
    battler.statusPenaltyStacks = t;
    const p = penaltyOf(battler);
    if (p) t[p.stat] = 1;
  },

  // engine/battle/effects.asm:414-415
  // Lua: Status.lua:207
  clearPenalty(battler: any, stat: string): void {
    const t = battler.statusPenaltyStacks;
    if (truthy(t)) t[stat] = 0;
  },

  // engine/battle/effects.asm:505-506
  // Lua: Status.lua:213
  stackPenalty(battler: any): void {
    const t = battler.statusPenaltyStacks;
    if (!truthy(t)) return;
    const p = penaltyOf(battler);
    if (p) t[p.stat] = (t[p.stat] ?? 0) + 1;
  },

  // pokered engine/battle/core.asm:6283
  // Lua: Status.lua:221
  rulesetBakes(ruleset: any): boolean {
    return ruleset != null && ruleset.statusPenaltyIsBaked !== false;
  },

  // move_effects/paralyze.asm:35
  // Lua: Status.lua:234
  bakeOnInflict(battle: any, battler: any): void {
    if (!(truthy(battler.statusPenaltyStacks) || Status.rulesetBakes(battle?.ruleset))) {
      return;
    }
    Status.bakePenalty(battler);
  },

  // effects.asm:414-415
  // Lua: Status.lua:243
  afterStatChange(battle: any, who: any, stat: string, nonUser?: any): void {
    if (!ensureStacks(battle, who)) return;
    if (stat !== "accuracy" && stat !== "evasion") {
      Status.clearPenalty(who, stat);
    }
    if (truthy(nonUser) && ensureStacks(battle, nonUser)) {
      Status.stackPenalty(nonUser);
    }
  },

  // the HUD label for a status id: a mod's patched hudLabel/label if the
  // merged registry has one, the raw id otherwise (BattleState.statusLabel,
  // SummaryMenu.draw and PartyMenu.draw all read this the same way)
  // Lua: Status.lua:256
  hudLabelFor(statuses: Record<string, StatusRecord> | null | undefined, id: any): any {
    const record = Status.recordFor(statuses, id);
    const label = record ? (truthy(record.hudLabel) ? record.hudLabel : record.label) : undefined;
    return truthy(label) ? label : id;
  },

  // Gen 2's own statuses registry (src/battle/gen2/Battle.lua) uses the full
  // names (poison/burn/freeze/paralyze/sleep) as ids; PartyMenu and SummaryMenu
  // both read a mon's status byte as the three/four-letter cart abbreviation
  // first (psn/brn/frz/par/paralysis/slp) and need this to look the record up.
  // `paralysis` mirrors the same three-way spelling (par/paralysis/paralyze)
  // src/core/gen2/ItemEffects.lua's STATUS_CLASS already recognizes for status
  // cures; battle itself only ever sets mon.status to the full Gen 2 spelling
  // ("paralyze"), so no live path produces "paralysis" today, but nothing
  // guarantees a save-compat or Gen 1-side path never will, and the two
  // tables should stay in sync either way.
  // Lua: Status.lua:271
  GEN2_ID_ALIASES: {
    psn: "poison",
    brn: "burn",
    frz: "freeze",
    par: "paralyze",
    paralysis: "paralyze",
    slp: "sleep",
  } as Record<string, string>,

  // Returns canMove, messages, selfHit (true -> hurt itself in confusion).
  // The active status record's beforeMove runs at its priority slot: above
  // VOLATILE_PRIORITY before the held/disable/confusion block (sleep,
  // freeze), at or below after it (paralysis) -- the original's order.
  // Lua: Status.lua:284
  beforeMove(battler: any, rng: RangeRng, battle: any, selectedMoveId?: any): BeforeMoveResult {
    const mon = battler.mon;
    // Haze curing this mon's sleep/freeze forfeits its pending move for
    // the turn, silently (haze.asm writes $ff/CANNOT_MOVE to the selected
    // move; ExecuteMove returns immediately without a message)
    if (truthy(battler.skipMove)) {
      battler.skipMove = undefined;
      return [false, []];
    }
    if (truthy(battler.flinched)) {
      battler.flinched = false;
      return [false, [romText(battle?.data, "_FlinchedText", "%s\nflinched!", name(battler))]];
    }
    const record = Status.recordFor(battleStatuses(battle), mon.status);
    let handler = record ? record.beforeMove : undefined;
    const priority = handler ? (record!.beforeMovePriority ?? 0) : undefined;
    const msgs: string[] = [];
    const runStatus = (): [boolean, boolean | undefined] => {
      const [canMove, statusMsgs, selfHit] = handler!(battler, rng, battle);
      for (const m of statusMsgs ?? []) msgs.push(m);
      return [canMove, selfHit];
    };
    if (handler && priority! > VOLATILE_PRIORITY) {
      const [canMove, selfHit] = runStatus();
      if (!canMove || selfHit) return [canMove, msgs, selfHit];
      handler = undefined;
    }
    if (battler.boundTurns != null && battler.boundTurns > 0) {
      battler.boundTurns = battler.boundTurns - 1;
      msgs.push(romText(battle?.data, "_CantMoveText", "%s\ncan't move!", name(battler)));
      return [false, msgs];
    }
    if (battler.disabledTurns != null && battler.disabledTurns !== false) {
      battler.disabledTurns = battler.disabledTurns - 1;
      if (battler.disabledTurns <= 0) {
        battler.disabledTurns = undefined;
        battler.disabledSlot = undefined;
        msgs.push(romText(battle?.data, "_DisabledNoMoreText", "%s's\ndisabled no more!", name(battler)));
      }
    }
    if (battler.confusedTurns != null && battler.confusedTurns !== false) {
      battler.confusedTurns = battler.confusedTurns - 1;
      if (battler.confusedTurns <= 0) {
        battler.confusedTurns = undefined;
        msgs.push(romText(battle?.data, "_ConfusedNoMoreText", "%s\nsnapped out of\nconfusion!", name(battler)));
      } else {
        msgs.push(romText(battle?.data, "_IsConfusedText", "%s\nis confused!", name(battler)));
        // cp 50 percent + 1 / jr c: hurt itself on rand >= 128 (128/256)
        if (rng(0, 255) < 128) {
          return [false, msgs, true]; // hurt itself
        }
      }
    }
    // .TriedToUseDisabledMoveCheck (engine/battle/core.asm, and the enemy
    // copy .checkIfTriedToUseDisabledMove): the disabled-move test runs at
    // EXECUTION time, comparing wPlayerDisabledMoveNumber against the
    // already SELECTED move, so a Disable that lands earlier in the same
    // turn still blocks the slower mon's move (#860).  It sits after the
    // confusion block and before the paralysis roll, so a confusion self-hit
    // still pre-empts it and the paralysis roll is never spent on a turn the
    // disable eats.  PrintMoveIsDisabledText clears CHARGING_UP before
    // printing, so a disabled charge move drops its stored turn instead of
    // releasing later.
    if (truthy(selectedMoveId) && truthy(battler.disabledSlot)) {
      const disabled = (battler.curMoves ?? [])[battler.disabledSlot - 1];
      if (disabled != null && disabled.id === selectedMoveId) {
        battler.charging = undefined;
        battler.chargeReady = undefined;
        const moves = battle?.data?.moves;
        const moveName = moves && moves[selectedMoveId] ? moves[selectedMoveId].name : undefined;
        const shown = truthy(moveName) ? moveName : tostring(selectedMoveId);
        msgs.push(
          romText(battle?.data, "_MoveIsDisabledText", "%s's\n%s is\ndisabled!", {
            USER: name(battler),
            "RAM:wNameBuffer": shown,
          }),
        );
        return [false, msgs];
      }
    }
    if (handler) {
      const [canMove, selfHit] = runStatus();
      if (!canMove || selfHit) return [canMove, msgs, selfHit];
    }
    return [true, msgs];
  },

  // End-of-turn residual damage; opponent is needed for Leech Seed.
  // Returns messages.
  // Lua: Status.lua:374
  residual(battler: any, opponent: any, battle: any): string[] {
    const msgs: string[] = [];
    const mon = battler.mon;
    // the Haze move-forfeit only covers the turn Haze was used; if this
    // mon had already moved, drop the flag before it leaks into next turn
    battler.skipMove = undefined;
    if (mon.hp <= 0) return msgs;
    const record = Status.recordFor(battleStatuses(battle), mon.status);
    if (record && record.residual) {
      for (const m of record.residual(battler, opponent, battle) ?? []) {
        msgs.push(m);
      }
    }
    if (truthy(battler.leechSeeded) && mon.hp > 0 && opponent.mon.hp > 0) {
      // the shared Toxic counter multiplies (and advances on) the seed
      // drain too -- the Gen 1 Leech Seed glitch
      // (HandlePoisonBurnLeechSeed_DecreaseOwnHP)
      let dmg = Math.max(1, Math.floor(mon.stats.hp / 16));
      if (battler.toxicCounter != null && battler.toxicCounter !== false) {
        dmg = dmg * battler.toxicCounter;
        battler.toxicCounter = battler.toxicCounter + 1;
      }
      dmg = Math.min(dmg, mon.hp);
      mon.hp = mon.hp - dmg;
      opponent.mon.hp = Math.min(opponent.mon.stats.hp, opponent.mon.hp + dmg);
      msgs.push(romText(battle?.data, "_HurtByLeechSeedText", "LEECH SEED saps\n%s!", name(battler)));
    }
    return msgs;
  },
};

export default Status;
