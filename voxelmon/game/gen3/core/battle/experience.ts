// Port of gen1recomp src/core/game3/battle/experience.lua (GPLv3 + additional terms; see LICENSE.md).
// FRLG experience award (pret Cmd_getexp + gExperienceTables).
// Yields / growth rates come from ROM species meta (pokemon/meta.lua).
// Level thresholds come from SummaryData (= pret experience_tables.h).
//
// Port notes:
// - The lazy requires of held_items, engine and src.mods.Gen3Compat are
//   static imports (every module is in the bundle).
// - HeldItems.effectOf returns (effect, param): a tuple here, so the call
//   sites take [0].
// - No RNG is drawn anywhere in this module.
// - Lists Brian builds (`levels`, `steps`, awardFoe's result) are lt.ts
//   sequences (slot 0 unused).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tonumber, truthy, mod as lmod } from "../../../../import/gen3/lua.ts";
import { seq, len, ipairs, pairs, isEmpty, type LuaTable } from "../../platform/lt.ts";
import Pokemon from "../pokemon.ts";
import SummaryData from "../summary_data.ts";
import ModRuntime from "../../shared/mods/Runtime.ts";
import G3 from "../../shared/mods/Gen3Compat.ts";
import HeldItems from "./held_items.ts";
import Engine from "./engine.ts";

/** Lua `a or b` (b already evaluated). */
function lor<A, B>(a: A, b: B): A | B {
  return truthy(a) ? a : b;
}

/** Lua `a and b` (b already evaluated). */
function land<A, B>(a: A, b: B): A | B {
  return truthy(a) ? b : a;
}

/** Lua `a == b` for values that may be nil (null and undefined are both nil). */
function eq(a: unknown, b: unknown): boolean {
  return a == null ? b == null : a === b;
}

export interface MonStatsView { maxHp: number; atk: number; def: number; spa: number; spd: number; spe: number }

export interface ExpStep {
  level: number;
  fromRatio: number;
  toRatio: number;
  grewTo?: number;
  hp?: number;
  maxHp?: number;
  oldStats?: MonStatsView;
  newStats?: MonStatsView;
}

export interface ExpResult {
  gained: number;
  rawGained?: number;
  fromLevel: number;
  toLevel: number;
  fromExp: number;
  toExp: number;
  levels: LuaTable; // seq of levels reached
  steps: LuaTable; // seq of ExpStep
}

export interface ExpAward {
  mon: any;
  partyIndex: number;
  battler: any;
  expGetterBattlerId: number;
  amount: number;
  boosted: boolean;
  result: ExpResult;
}

export interface ExperienceModule {
  MAX_LEVEL: number;
  expYield(species: any): number;
  growthRate(monOrSpecies: any): number;
  expForLevel(monOrGrowth: any, level: any): number;
  levelForExp(monOrGrowth: any, exp: any): number;
  progress(mon: any): ReturnType<typeof SummaryData.expProgress>;
  syncExpToLevel(mon: any): any;
  gainFor(foeSpecies: any, foeLevel: any, opts?: any): number;
  apply(mon: any, amount: any): ExpResult;
  recipientOpts(st: any, mon: any): { luckyEgg: boolean; traded: any };
  awardFoe(st: any, foeBattler: any, opts?: any): LuaTable;
}

export const Experience = {} as ExperienceModule;

Experience.MAX_LEVEL = 100;

// Lua: experience.lua:13
Experience.expYield = function (speciesIn: any): number {
  const species = lor(tonumber(speciesIn), lor(land(speciesIn, speciesIn?.species), 0));
  const meta = Pokemon.speciesMeta(species);
  return lor(land(meta, tonumber(meta?.expYield)), 0) as number;
};

// Lua: experience.lua:20
/** pret GROWTH_* index for this mon/species (ROM BaseStats.growthRate). */
Experience.growthRate = function (monOrSpecies: any): number {
  if (monOrSpecies !== null && typeof monOrSpecies === "object") {
    const gr = tonumber(monOrSpecies.growthRate);
    if (gr != null) return lmod(gr, 6);
    const sp = tonumber(lor(monOrSpecies.species, monOrSpecies.speciesId));
    const meta = land(sp, sp != null ? Pokemon.speciesMeta(sp) : undefined);
    return lmod(lor(land(meta, tonumber(meta?.growthRate)), 0) as number, 6);
  }
  const meta = Pokemon.speciesMeta(tonumber(monOrSpecies));
  return lmod(lor(land(meta, tonumber(meta?.growthRate)), 0) as number, 6);
};

// Lua: experience.lua:32
Experience.expForLevel = function (monOrGrowth: any, level: any): number {
  const growth = (monOrGrowth !== null && typeof monOrGrowth === "object")
    ? Experience.growthRate(monOrGrowth)
    : lmod(tonumber(monOrGrowth) ?? 0, 6);
  return SummaryData.expForLevel(growth, level);
};

// Lua: experience.lua:38
/** Highest level whose threshold <= exp (pret GetLevelFromMonExp). */
Experience.levelForExp = function (monOrGrowth: any, expIn: any): number {
  const growth = (monOrGrowth !== null && typeof monOrGrowth === "object")
    ? Experience.growthRate(monOrGrowth)
    : lmod(tonumber(monOrGrowth) ?? 0, 6);
  const exp = Math.max(0, tonumber(expIn) ?? 0);
  let lv = 1;
  while (lv < Experience.MAX_LEVEL) {
    const nextThresh = SummaryData.expForLevel(growth, lv + 1);
    if (exp < nextThresh) break;
    lv = lv + 1;
  }
  return lv;
};

// Lua: experience.lua:50
Experience.progress = function (mon: any): ReturnType<typeof SummaryData.expProgress> {
  return SummaryData.expProgress(mon, Experience.growthRate(mon));
};

// Lua: experience.lua:55
/** Ensure mon.exp matches its growth curve at current level (new gifts / bad saves). */
Experience.syncExpToLevel = function (mon: any): any {
  if (mon === null || typeof mon !== "object") return mon;
  const growth = Experience.growthRate(mon);
  mon.growthRate = growth;
  const level = Math.max(1, Math.min(Experience.MAX_LEVEL, tonumber(mon.level) ?? 1));
  mon.level = level;
  const atLevel = SummaryData.expForLevel(growth, level);
  const nextLevel = level >= Experience.MAX_LEVEL ? atLevel : SummaryData.expForLevel(growth, level + 1);
  const exp = tonumber(mon.exp);
  if (exp == null || exp < atLevel || (level < Experience.MAX_LEVEL && exp >= nextLevel)) {
    mon.exp = atLevel;
  }
  return mon;
};

// Lua: experience.lua:73
/** pret: calculatedExp = expYield * foeLevel / 7
 * then SAFE_DIV by participants (halved when any Exp.Share holder — deferred).
 * Per-recipient boosts: Lucky Egg ×1.5, trainer ×1.5, traded ×1.5 (floored *150/100). */
Experience.gainFor = function (foeSpecies: any, foeLevelIn: any, optsIn?: any): number {
  const opts = optsIn ?? {};
  const yieldV = Experience.expYield(foeSpecies);
  const foeLevel = Math.max(1, tonumber(foeLevelIn) ?? 1);
  const participants = Math.max(1, tonumber(opts.participants) ?? 1);
  const calculated = Math.floor(yieldV * foeLevel / 7);
  let amount = Math.floor(calculated / participants);
  if (amount < 1) amount = 1;
  // Exp.Share party pass deferred: opts.expShareShare would add half-pool share
  if (truthy(opts.luckyEgg)) {
    amount = Math.floor(amount * 150 / 100);
  }
  if (truthy(opts.trainer)) {
    amount = Math.floor(amount * 150 / 100);
  }
  if (truthy(opts.traded)) {
    amount = Math.floor(amount * 150 / 100);
  }
  if (amount < 1) amount = 1;
  return amount;
};

// Lua: experience.lua:95
function get_mon_stats(mon: any): MonStatsView {
  return {
    maxHp: tonumber(land(mon, lor(mon?.maxHp, mon?.maxhp))) ?? 1,
    atk: tonumber(land(mon, lor(mon?.attack, mon?.atk))) ?? 1,
    def: tonumber(land(mon, lor(mon?.defense, mon?.def))) ?? 1,
    spa: tonumber(land(mon, lor(lor(mon?.spAtk, mon?.spa), mon?.spatk))) ?? 1,
    spd: tonumber(land(mon, lor(lor(mon?.spDef, mon?.spd), mon?.spdef))) ?? 1,
    spe: tonumber(land(mon, lor(mon?.speed, mon?.spe))) ?? 1,
  };
}

// Lua: experience.lua:106
function apply_level_stats(mon: any, newLevel: number): void {
  const oldMax = tonumber(mon.maxHp) ?? 1;
  const oldHp = tonumber(mon.hp) ?? oldMax;
  mon.level = newLevel;
  Pokemon.applyStats(mon);
  const newMax = tonumber(mon.maxHp) ?? oldMax;
  mon.hp = Math.min(newMax, oldHp + Math.max(0, newMax - oldMax));
}

// Lua: experience.lua:121
/** Add XP to mon using its ROM growth curve. Mutates mon.
 * Returns { gained, fromLevel, toLevel, fromExp, toExp,
 *   levels = {N,...} (each level reached),
 *   steps = {{level, fromRatio, toRatio, fillToOne}, ...} for bar anim } */
Experience.apply = function (mon: any, amountIn: any): ExpResult {
  const amount = Math.max(0, Math.floor(tonumber(amountIn) ?? 0));
  Experience.syncExpToLevel(mon);
  const growth = Experience.growthRate(mon);
  const fromLevel = tonumber(mon.level) ?? 1;
  const fromExp = tonumber(mon.exp) ?? Experience.expForLevel(growth, fromLevel);
  const cap = SummaryData.expForLevel(growth, Experience.MAX_LEVEL);

  if (fromLevel >= Experience.MAX_LEVEL || amount <= 0) {
    return {
      gained: 0,
      fromLevel: fromLevel,
      toLevel: fromLevel,
      fromExp: fromExp,
      toExp: fromExp,
      levels: seq(),
      steps: seq(),
    };
  }

  const rawGained = amount;
  const newExp = Math.min(cap, fromExp + amount);
  const applied = newExp - fromExp;
  mon.exp = newExp;

  const toLevel = Experience.levelForExp(growth, newExp);
  const levels: LuaTable = seq();
  const steps: LuaTable = seq();

  // Bar steps: from current ratio → (fill to 1 per level-up) → final ratio
  let curLevel = fromLevel;
  let curExp = fromExp;
  while (curLevel < toLevel) {
    const nextThresh = SummaryData.expForLevel(growth, curLevel + 1);
    const curThresh = SummaryData.expForLevel(growth, curLevel);
    const span = Math.max(1, nextThresh - curThresh);
    const fromRatio = Math.max(0, Math.min(1, (curExp - curThresh) / span));
    const oldStats = get_mon_stats(mon);
    steps[len(steps) + 1] = {
      level: curLevel,
      fromRatio: fromRatio,
      toRatio: 1,
      grewTo: curLevel + 1,
    } as ExpStep;
    curLevel = curLevel + 1;
    curExp = nextThresh;
    levels[len(levels) + 1] = curLevel;
    apply_level_stats(mon, curLevel);
    // pokefirered/src/battle_script_commands.c:3298
    if (ModRuntime.wants("pokemon.level_up")) {
      // require("src.mods.Gen3Compat")
      const learnable: LuaTable = seq();
      const learnableIds: LuaTable = seq();
      for (const [, mv] of ipairs(Pokemon.movesLearnedAt(tonumber(lor(mon.species, mon.speciesId)), curLevel))) {
        learnable[len(learnable) + 1] = G3.moveName(mv);
        learnableIds[len(learnableIds) + 1] = mv;
      }
      ModRuntime.emit("pokemon.level_up", {
        mon: mon, level: curLevel, prevLevel: curLevel - 1,
        learnable: learnable, learnableIds: learnableIds,
      });
    }
    const newStats = get_mon_stats(mon);
    steps[len(steps)].hp = tonumber(mon.hp);
    steps[len(steps)].maxHp = tonumber(mon.maxHp);
    steps[len(steps)].oldStats = oldStats;
    steps[len(steps)].newStats = newStats;
  }

  // Remainder into final level
  {
    const curThresh = SummaryData.expForLevel(growth, toLevel);
    const nextThresh = toLevel >= Experience.MAX_LEVEL ? curThresh
      : SummaryData.expForLevel(growth, toLevel + 1);
    const span = Math.max(1, nextThresh - curThresh);
    const fromRatio = (curLevel === fromLevel)
      ? Math.max(0, Math.min(1, (fromExp - curThresh) / span))
      : 0;
    const toRatio = toLevel >= Experience.MAX_LEVEL ? 1
      : Math.max(0, Math.min(1, (newExp - curThresh) / span));
    if (toRatio > fromRatio + 0.0001 || (len(steps) === 0 && applied > 0)) {
      steps[len(steps) + 1] = {
        level: toLevel,
        fromRatio: fromRatio,
        toRatio: toRatio,
        grewTo: undefined,
      } as ExpStep;
    }
  }

  if (toLevel > fromLevel) {
    // stats already applied per level; ensure final
    apply_level_stats(mon, toLevel);
  }

  return {
    gained: applied,
    rawGained: rawGained,
    fromLevel: fromLevel,
    toLevel: toLevel,
    fromExp: fromExp,
    toExp: newExp,
    levels: levels,
    steps: steps,
  };
};

// pokefirered/src/battle_script_commands.c:3232
// Lua: experience.lua:227
Experience.recipientOpts = function (st: any, mon: any): { luckyEgg: boolean; traded: any } {
  // require("src.core.game3.battle.held_items"), require("src.core.game3.battle.engine")
  let traded = Engine.isTradedMon(st, mon);
  if (truthy(traded) && truthy(st) && truthy(st.playerHalf)) {
    // pokeemerald/src/battle_script_commands.c:3384
    for (const [i, m] of ipairs(lor(st.playerParty, seq()))) {
      if (m === mon && i > st.playerHalf) traded = false;
    }
  }
  return {
    luckyEgg: eq(HeldItems.effectOf(land(mon, lor(mon?.item, mon?.heldItem)))[0], HeldItems.HOLD.LUCKY_EGG),
    traded: traded,
  };
};

// Lua: experience.lua:247
/** Award XP for a defeated foe to participant party mons.
 * opts: trainer, participants (count), getOpts(mon, partyIndex) → luckyEgg/traded
 * Returns list of { mon, partyIndex, battler?, result }
 * pokefirered/src/battle_script_commands.c:3113 */
Experience.awardFoe = function (st: any, foeBattler: any, optsIn?: any): LuaTable {
  const opts = optsIn ?? {};
  if (!truthy(st) || !truthy(foeBattler)) return seq();
  // require("src.core.game3.battle.held_items")
  const foeMon = foeBattler.mon;
  const foeSpecies = lor(foeBattler.species, land(foeMon, lor(foeMon?.species, foeMon?.speciesId)));
  const foeLevel = lor(lor(land(foeMon, foeMon?.level), foeBattler.level), 1);
  let isTrainer = opts.trainer;
  if (isTrainer == null) isTrainer = !truthy(st.wild);

  const sentIn: Record<number | string, boolean> = {};
  if (truthy(opts.partyIndices)) {
    for (const [, pi] of ipairs(opts.partyIndices)) sentIn[pi as number] = true;
  } else if (truthy(foeBattler.participants) && !isEmpty(foeBattler.participants)) {
    // pokefirered/src/battle_script_commands.c:3123
    for (const [pi] of pairs(foeBattler.participants)) sentIn[pi] = true;
  } else if (truthy(st.player) && truthy(st.player.mon) && (tonumber(st.player.mon.hp) ?? 0) > 0) {
    sentIn[lor(st.player.partyIndex, 1)] = true;
  }
  const b0 = st.player;
  const b2 = (truthy(st.double) && truthy(st.battlers) && truthy(st.battlers[2])) ? st.battlers[2] : undefined;
  const absent = lor(st.absent, {});
  const on_field = (pi: number): any => {
    if (truthy(b0) && b0.partyIndex === pi && !truthy(absent[0])) return b0;
    if (truthy(b2) && b2.partyIndex === pi && !truthy(absent[2])) return b2;
    return undefined;
  };
  // pokefirered/src/battle_script_commands.c:3248
  const getter_id = (pi: number): number => {
    if (!truthy(st.double)) return 0;
    if (truthy(b2) && b2.partyIndex === pi && !truthy(absent[2])) return 2;
    if (!truthy(absent[0])) return 0;
    return 2;
  };
  const party = lor(st.playerParty, seq());
  const alive = (mon: any): boolean => {
    return truthy(mon) && (tonumber(lor(mon.species, mon.speciesId)) ?? 0) !== 0 && (tonumber(mon.hp) ?? 0) > 0;
  };
  const has_share = (mon: any): boolean => {
    return eq(HeldItems.effectOf(land(mon, lor(mon?.item, mon?.heldItem)))[0], HeldItems.HOLD.EXP_SHARE);
  };
  let viaSentIn = 0;
  let viaExpShare = 0;
  for (let i = 1; i <= 6; i++) {
    const mon = party[i];
    if (alive(mon)) {
      if (truthy(sentIn[i])) viaSentIn = viaSentIn + 1;
      if (has_share(mon)) viaExpShare = viaExpShare + 1;
    }
  }
  const calculated = Math.floor(Experience.expYield(foeSpecies) * Math.max(1, tonumber(foeLevel) ?? 1) / 7);
  let exp: number;
  let shareExp: number;
  if (viaExpShare > 0) {
    exp = (viaSentIn > 0) ? Math.floor(Math.floor(calculated / 2) / viaSentIn) : 0;
    if (exp === 0) exp = 1;
    shareExp = Math.floor(Math.floor(calculated / 2) / viaExpShare);
    if (shareExp === 0) shareExp = 1;
  } else {
    exp = (viaSentIn > 0) ? Math.floor(calculated / viaSentIn) : 0;
    if (exp === 0) exp = 1;
    shareExp = 0;
  }

  const friendshipCtx = { mapSec: Pokemon.currentMapSec(st.session) };

  const out: LuaTable = seq();
  for (let pi = 1; pi <= 6; pi++) {
    const mon = party[pi];
    const share = land(mon, truthy(mon) ? has_share(mon) : undefined);
    if (truthy(mon) && (truthy(sentIn[pi]) || truthy(share)) && (tonumber(mon.level) ?? 1) < Experience.MAX_LEVEL && alive(mon)) {
      const got = truthy(opts.getOpts) ? opts.getOpts(mon, pi) : undefined;
      const per = truthy(got) ? got : Experience.recipientOpts(st, mon);
      const vanilla_amount = (): number => {
        let amount = truthy(sentIn[pi]) ? exp : 0;
        if (truthy(share)) amount = amount + shareExp;
        if (truthy(per.luckyEgg)) amount = Math.floor(amount * 150 / 100);
        if (truthy(isTrainer)) amount = Math.floor(amount * 150 / 100);
        if (truthy(per.traded)) amount = Math.floor(amount * 150 / 100);
        return amount;
      };
      let amount: number;
      // pokefirered/src/battle_script_commands.c:3230
      if (ModRuntime.wantsHook("exp.gain")) {
        // require("src.mods.Gen3Compat")
        const a = ModRuntime.call("exp.gain", () => vanilla_amount(), {
          defeatedDef: G3.speciesView(foeSpecies), level: foeLevel, isTrainer: isTrainer,
          participants: viaSentIn, traded: per.traded, luckyEgg: per.luckyEgg,
          expShare: truthy(share) ? true : false, mon: mon, index: pi,
          battle: st, loser: foeBattler,
        });
        amount = Math.max(0, Math.floor(tonumber(a) ?? 0));
      } else {
        amount = vanilla_amount();
      }
      // pokefirered/src/battle_script_commands.c:3271
      Pokemon.gainEVs(mon, foeSpecies);
      const result = Experience.apply(mon, amount);
      // pokefirered/src/battle_script_commands.c:3314
      for (let n = 1; n <= len(result.levels); n++) {
        Pokemon.adjustFriendship(mon, Pokemon.FRIENDSHIP_EVENT_GROW_LEVEL, friendshipCtx);
      }
      let fieldB: any;
      if (truthy(st.double)) {
        fieldB = on_field(pi);
        if (truthy(fieldB)) {
          fieldB.mon = mon;
          fieldB.fainted = (tonumber(mon.hp) ?? 0) <= 0;
        }
      } else if (truthy(st.player) && st.player.partyIndex === pi) {
        st.player.mon = mon;
        st.player.fainted = (tonumber(mon.hp) ?? 0) <= 0;
        fieldB = st.player;
      }
      // pokefirered/src/battle_script_commands.c:3278
      if (ModRuntime.wants("battle.exp_gained")) {
        ModRuntime.emit("battle.exp_gained", {
          battle: st, mon: mon, gained: result.gained, levels: result.levels,
          index: pi, battler: fieldB, battlerId: getter_id(pi),
        });
      }
      out[len(out) + 1] = {
        mon: mon,
        partyIndex: pi,
        battler: fieldB,
        expGetterBattlerId: getter_id(pi),
        amount: amount,
        boosted: truthy(per.traded) ? true : false,
        result: result,
      } as ExpAward;
    }
  }
  return out;
};

export default Experience;
