// Port of gen1recomp src/core/game3/battle/effects/hit.lua (GPLv3 + additional terms; see LICENSE.md).
// The damaging-move hit sequencer: pre-checks, accuracy, multi-hit, fixed
// damage, Explosion, Magnitude, Rollout/Fury Cutter, Present, Spit Up,
// Triple Kick, Beat Up, drain, crash damage and the after-hit secondaries.
//
// Port notes:
// - Every gameplay RNG call (ad.roll, Damage.calc, M.accuracyCheck,
//   Rules.crit.roll, HeldItems.rollFocusBand) happens where and in the order
//   Brian's does.
// - Tuples (Lua multiple returns): Hit.adjustDamage -> [dmg, hung|null];
//   damage_calc -> [dmg, info]; hit_once -> [dmg|null, info, status].
//   Damage.calc -> [dmg, info] and Types.typeCalc -> [dmg, flags, product]
//   are destructured. ModRuntime.call returns the vanilla function's tuple.
// - The lazy requires (state, Gen3Compat, engine, pokemon) and the
//   pcall(require, "...effects.stats") are static imports; the pcall always
//   succeeds.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { truthy, tonumber, tostring, mod as lmod } from "../../../../../import/gen3/lua.ts";
import { ipairs, len, type LuaTable } from "../../../platform/lt.ts";
import Damage from "../damage.ts";
import Moves from "../moves.ts";
import EffectIds from "../effect_ids.ts";
import Types from "../types.ts";
import Rules from "../rules.ts";
import Secondary from "./secondary.ts";
import HeldItems from "../held_items.ts";
import Oak from "../oak_advice.ts";
import ModRuntime from "../../../shared/mods/Runtime.ts";
import H from "./_helpers.ts";
import State from "../state.ts";
import G3 from "../../../shared/mods/Gen3Compat.ts";
import Engine from "../engine.ts";
import Pokemon from "../../pokemon.ts";
import StatsMod from "./stats.ts";

/** Lua `a or b` (b already evaluated). */
function lor(a: any, b: any): any {
  return truthy(a) ? a : b;
}

const E = EffectIds;

const MOVE_SURF = 57, MOVE_WHIRLPOOL = 250, MOVE_SLEEP_TALK = 214;

/** hit_once options. */
interface HitOnceOpts {
  calc?: Record<string, any>;
  multihitLeft?: number;
  onBeforeAnim?: (() => void) | null;
  onAfterAnim?: (() => void) | null;
}

/** hit_once status. */
type HitStatus = "fail" | "immune" | "ok" | "endured" | "hung";

// Lua: hit.lua:17
function roll(ad: any, lo: number, hi: number): number { return ad.roll(lo, hi); }

// Lua: hit.lua:19
function move_is_sleep_talk(ref: any): boolean {
  const m = Moves.get(ref);
  return tonumber(truthy(m) ? m.effect : m) === E.SLEEP_TALK || tonumber(ref) === MOVE_SLEEP_TALK;
}

// Lua: hit.lua:24
function dealt_event(M: any, target: any, dealt: number, info: any, sub: boolean): void {
  if (!ModRuntime.wants("battle.damage_dealt")) return;
  const view = G3.moveView(M.move);
  const eff = tonumber(info.effectiveness);
  const mult = eff != null ? Math.floor(eff * 10 + 0.5) : 10;
  let physical = info.physical;
  if (physical == null) physical = Types.isPhysical(lor(M.moveType, M.move.type));
  ModRuntime.emit("battle.damage_dealt", {
    battle: M.st, user: M.user, target, move: view,
    moveId: truthy(view) ? view.id : view, moveNum: M.mnum, damage: dealt,
    crit: truthy(info.critical), typeMult: mult, effectiveness: mult,
    side: target.side, userId: State.idOf(M.user), targetId: State.idOf(target),
    kind: truthy(physical) ? "physical" : "special", substitute: sub ? sub : null,
  });
}

// Lua: hit.lua:142
// pokefirered/src/battle_script_commands.c:6857
function multi_hit_count(M: any): number {
  const ad = M.adapter;
  const r = roll(ad, 0, 3);
  if (r > 1) return lmod(roll(ad, 0, 3), 4) + 2;
  return r + 2;
}

// Lua: hit.lua:149
function field_sport(M: any, key: string): boolean {
  for (const [, b] of ipairs(M.adapter.activeBattlers())) {
    if (truthy(b[key]) && !truthy(M.adapter.isFainted(b))) return true;
  }
  return truthy(M.st) && truthy(M.st[key === "mudSport" ? "expMudSport" : "expWaterSport"]);
}

const MOVE_TARGET_BOTH = 8;

// Lua: hit.lua:158
function calc_opts(M: any, extra?: Record<string, any> | null): Record<string, any> {
  const ad = M.adapter, target = M.target;
  const defSide = ad.ownSide(target);
  const st = M.st;
  let twoDef = false;
  if (truthy(st) && truthy(st.double) && truthy(target)) {
    twoDef = State.countPresentOnSide(st, target.side) === 2;
  }
  const o: Record<string, any> = {
    doubleScreens: twoDef,
    spread: twoDef && tonumber(truthy(M.move) ? M.move.target : M.move) === MOVE_TARGET_BOTH,
    rng: ad.rng(),
    weather: Rules.weather.effective(M.st, ad),
    adapter: ad,
    dmgMultiplier: M.dmgMultiplier,
    reflect: truthy(defSide) ? lor(defSide.expReflectTurns, 0) > 0 : defSide,
    lightScreen: truthy(defSide) ? lor(defSide.expLightScreenTurns, 0) > 0 : defSide,
    mudSport: field_sport(M, "mudSport"),
    waterSport: field_sport(M, "waterSport"),
    pursuitSwitch: M.opts.pursuitSwitch,
  };
  for (const k of Object.keys(lor(extra, {}))) {
    const v = (extra as Record<string, any>)[k];
    if (v != null) o[k] = v;
  }
  return o;
}

// Lua: hit.lua:184
function dream_eater_blocked(M: any): boolean {
  const ad = M.adapter, target = M.target;
  return lor(target.substituteHP, 0) > 0 || ad.status(target) !== "SLP";
}

// Lua: hit.lua:189
function fail(M: any, id?: string, fill?: any): void {
  M.attackString();
  M.ppReduce();
  M.failed = true;
  M.anim.missed = true;
  if (truthy(id)) M.adapter.sayText(id, fill); else M.adapter.sayFail();
}

// Lua: hit.lua:197
function pre_checks(M: any): boolean {
  const ad = M.adapter, user = M.user, target = M.target, eff = M.effect;
  if (eff === E.FAKE_OUT && lor(user.isFirstTurn, 0) <= 0) {
    fail(M);
    return true;
  }
  if (eff === E.DREAM_EATER && dream_eater_blocked(M)) {
    // pokefirered/data/battle_scripts_1.s:427
    fail(M, "STRINGID_PKMNWASNTAFFECTED", { def: target });
    return true;
  }
  if (eff === E.COUNTER || eff === E.MIRROR_COAT) {
    // pokefirered/src/battle_script_commands.c:7568
    // (Lua `cond and a or b`: a nil `a` falls through to `b`.)
    const taken = (eff === E.COUNTER && truthy(user.lastPhysicalDamageTaken))
      ? user.lastPhysicalDamageTaken : user.lastSpecialDamageTaken;
    let foe = ad.foeOf(user);
    if (truthy(M.st) && truthy(M.st.double)) {
      const src = (eff === E.COUNTER && truthy(user.lastPhysicalById)) ? user.lastPhysicalById : user.lastSpecialById;
      foe = null;
      if (src != null) foe = State.battler(M.st, src);
      if (!truthy(foe)) foe = null;
      if (truthy(foe) && lmod(src as number, 2) === lmod(State.idOf(user) as number, 2)) foe = null;
      if (truthy(foe) && ad.hp(foe) > 0) {
        const fm = Engine.followMeId(M.st, ad, user);
        const fb = fm != null ? State.battler(M.st, fm) : null;
        if (truthy(fb) && ad.hp(fb) > 0) foe = fb;
      }
    }
    if (!truthy(taken) || taken <= 0 || !truthy(foe) || truthy(ad.isFainted(foe))
        || (truthy(user.expHurtBy) && user.expHurtBy === user.side)) {
      fail(M);
      return true;
    }
    M.target = foe;
    M.tname = ad.displayName(foe);
  }
  if (eff === E.SNORE) {
    if (ad.status(user) !== "SLP") {
      fail(M);
      return true;
    }
    if (!(truthy(M.opts.called) && truthy(M.opts.calledBy) && Moves.get(M.opts.calledBy).effect === E.SLEEP_TALK)) {
      ad.sayText("STRINGID_PKMNFASTASLEEP", { atk: user });
      ad.statusAnim(user, "SLP");
    }
  }
  if (eff === E.ENDEAVOR && ad.hp(target) <= ad.hp(user)) {
    fail(M);
    return true;
  }
  if (eff === E.SPIT_UP && truthy(M.isProtected())) {
    M.attackString();
    M.ppReduce();
    if (lor(user.expStockpile, 0) <= 0) {
      ad.sayText("STRINGID_FAILEDTOSPITUP");
    } else {
      user.expStockpile = 0;
      ad.sayText("STRINGID_PKMNPROTECTEDITSELF", { def: M.target });
    }
    M.anim.missed = true;
    return true;
  }
  if (eff === E.EXPLOSION && !truthy(M.explosionStarted)) {
    for (const [, b] of ipairs(ad.activeBattlers())) {
      if (ad.abilityOf(b) === "DAMP") {
        M.stopTargets = true;
        M.attackString();
        M.ppReduce();
        ad.sayText("STRINGID_PKMNPREVENTSUSAGE", {
          def: b, defAbility: H.abilityId("DAMP"), atk: user, currentMove: M.mnum,
        });
        M.failed = true;
        return true;
      }
    }
  }
  return false;
}

// Lua: hit.lua:275
function set_multipliers(M: any): void {
  const target = M.target, eff = M.effect;
  const semi = truthy(target) ? target.semiInvulnerable : target;
  M.dmgMultiplier = 1;
  if (eff === E.GUST || eff === E.TWISTER) {
    if (semi === "ON_AIR") { M.ignoreOnAir = true; M.dmgMultiplier = 2; }
  } else if (eff === E.EARTHQUAKE || eff === E.MAGNITUDE) {
    if (semi === "UNDERGROUND") { M.ignoreUnderground = true; M.dmgMultiplier = 2; }
  } else if ((eff === E.HIT && M.mnum === MOVE_SURF) || (eff === E.TRAP && M.mnum === MOVE_WHIRLPOOL)) {
    if (semi === "UNDERWATER") { M.ignoreUnderwater = true; M.dmgMultiplier = 2; }
  } else if (eff === E.FLINCH_MINIMIZE_HIT) {
    if (truthy(target.minimized)) M.dmgMultiplier = 2;
  } else if (eff === E.THUNDER || eff === E.SKY_UPPERCUT) {
    M.ignoreOnAir = true;
  }
}

// Lua: hit.lua:292
function crash_damage(M: any): void {
  // pokefirered/data/battle_scripts_1.s:848
  const ad = M.adapter, user = M.user, target = M.target;
  const [, flags] = Types.typeCalc(M.move.type, target.type1, target.type2, null, target.expIdentified);
  if (truthy(flags.immune) && M.missReason !== "protected") return;
  ad.sayText("STRINGID_PKMNCRASHED", { atk: user });
  let dmg = Damage.calc(user, target, M.move, calc_opts(M, { forceCrit: false }))[0];
  dmg = Math.floor(dmg / 2);
  if (dmg === 0) dmg = 1;
  const cap = Math.floor(ad.maxHp(target) / 2);
  if (cap < dmg) dmg = cap;
  ad.applyHpLoss(user, dmg);
  M.tryFaintUser();
}

// Lua: hit.lua:307
function on_miss(M: any): void {
  const user = M.user, eff = M.effect;
  M.anim.missed = true;
  M.noEffect = true;
  if (eff === E.RECOIL_IF_MISS && M.missReason !== "absorbed") crash_damage(M);
  if (eff === E.RAGE) user.rage = null;
  if (eff === E.ROLLOUT) {
    Engine.cancelMultiTurnMoves(user);
  }
  if (eff === E.FURY_CUTTER) user.expFuryCutter = 0;
  if (eff === E.SEMI_INVULNERABLE) {
    user.semiInvulnerable = null;
    user.onAir = null; user.underground = null; user.underwater = null;
  }
}

// Lua: hit.lua:324
function flags_immune(M: any, info: any): boolean {
  const ad = M.adapter, target = M.target;
  const mt = tonumber(truthy(info) ? info.moveType : info) ?? tonumber(lor(M.moveType, M.move.type));
  if (ad.abilityOf(target) === "LEVITATE" && mt === Types.ID.GROUND) {
    ad.sayText("STRINGID_PKMNMAKESGROUNDMISS", { def: target, defAbility: H.abilityId("LEVITATE") });
    return true;
  }
  if (truthy(info) && info.effectiveness === 0) {
    ad.sayText("STRINGID_ITDOESNTAFFECT", { def: target });
    return true;
  }
  return false;
}

// Lua: hit.lua:338
function wonder_guard(M: any, info: any): boolean {
  const ad = M.adapter;
  if (ad.abilityOf(M.target) !== "WONDER_GUARD") return false;
  const f = truthy(info) && truthy(info.typeFlags) ? info.typeFlags : {};
  if (truthy(f.super) && !truthy(f.notVery)) return false;
  ad.sayText("STRINGID_AVOIDEDDAMAGE", { def: M.target, defAbility: H.abilityId("WONDER_GUARD") });
  return true;
}

// Lua: hit.lua:347
function secondary_after(M: any): void {
  const eff = M.effect;
  if (truthy(M.noEffect)) return;
  let spec: any = E.SECONDARY[eff];
  if (eff === E.SMELLINGSALT && truthy(M.hitSubstitute)) spec = null;
  if (eff === E.SECRET_POWER) {
    const name = lor(E.SECRET_POWER_BY_TERRAIN[Engine.terrainOf(M.st)], "PARALYSIS");
    spec = { eff: name };
  }
  if (truthy(M.extraEffect)) spec = M.extraEffect;
  if (truthy(spec)) {
    Secondary.withChance(M, spec.eff, spec.certain, spec.user);
  }
  if (eff === E.RAMPAGE && truthy(M.startRampage)) {
    Secondary.set(M, "THRASH", false, true, true);
  }
  if (truthy(M.move.afterHit) && !truthy(spec) && M.move.afterHit.kind === "recoil") {
    Secondary.set(M, "RECOIL_25", false, true, true);
  }
}

// Lua: hit.lua:369
function drain(M: any): void {
  // pokefirered/data/battle_scripts_1.s:325
  const ad = M.adapter, user = M.user, target = M.target;
  if (truthy(M.noEffect)) return;
  let heal = Math.floor(lor(M.hpDealt, 0) / 2);
  if (heal === 0) heal = 1;
  if (M.effect === E.ABSORB && ad.abilityOf(target) === "LIQUID_OOZE") {
    ad.applyHpLoss(user, heal);
    ad.sayText("STRINGID_ITSUCKEDLIQUIDOOZE");
    M.tryFaintUser();
    return;
  }
  ad.heal(user, heal);
  if (M.effect === E.DREAM_EATER) {
    ad.sayText("STRINGID_PKMNDREAMEATEN", { def: target });
  } else {
    ad.sayText("STRINGID_PKMNENERGYDRAINED", { def: target });
  }
}

// Lua: hit.lua:390
// pokefirered/src/battle_script_commands.c:8238
function present(M: any): number | null {
  const ad = M.adapter, target = M.target;
  const r = roll(ad, 0, 255);
  if (r < 102) return 40;
  if (r < 178) return 80;
  if (r < 204) return 120;
  if (ad.hp(target) >= ad.maxHp(target)) {
    ad.sayText("STRINGID_PKMNHPFULL", { def: target });
    return null;
  }
  M.attackAnimation();
  const heal = Math.max(1, Math.floor(ad.maxHp(target) / 4));
  ad.heal(target, heal);
  ad.sayText("STRINGID_PKMNREGAINEDHEALTH", { def: target });
  return null;
}

// Lua: hit.lua:408
// pokefirered/src/battle_script_commands.c:8161
function rollout_power(M: any): number {
  const user = M.user;
  if (lor(user.expRolloutTimer, 0) <= 0) {
    user.expRolloutTimer = 5;
    user.expLockedMove = M.moveId;
    user.expLockedSlot = M.slot;
  }
  user.expRolloutTimer = user.expRolloutTimer - 1;
  if (user.expRolloutTimer === 0) {
    user.expLockedMove = null;
    user.expLockedSlot = null;
  }
  let power = tonumber(M.move.power) ?? 30;
  for (let i = 1; i <= (5 - user.expRolloutTimer) - 1; i++) power = power * 2;
  if (truthy(user.defenseCurl)) power = power * 2;
  return power;
}

// Lua: hit.lua:427
// pokefirered/src/battle_script_commands.c:8205
function fury_cutter_power(M: any): number {
  const user = M.user;
  let c = lor(user.expFuryCutter, 0);
  if (c !== 5) c = c + 1;
  user.expFuryCutter = c;
  let power = tonumber(M.move.power) ?? 10;
  for (let i = 1; i <= c - 1; i++) power = power * 2;
  return power;
}

// Lua: hit.lua:438
// pokefirered/src/battle_script_commands.c:1209
function damage_calc(M: any, target: any, calcOpts: any): [number, any] {
  if (!ModRuntime.wantsHook("battle.damage")) {
    return Damage.calc(M.user, target, M.move, calcOpts);
  }
  const view = G3.moveView(M.move);
  let vanillaInfo: any;
  const r = ModRuntime.call("battle.damage", (c: any) => {
    const [d, i] = Damage.calc(c.user, c.target, M.move, c.opts);
    vanillaInfo = i;
    return [d, i];
  }, {
    battle: M.st, user: M.user, target, move: view,
    moveId: truthy(view) ? view.id : view, moveNum: M.mnum, opts: calcOpts,
    rng: truthy(calcOpts) ? calcOpts.rng : calcOpts,
  });
  const dmg = Array.isArray(r) ? r[0] : r;
  let info = Array.isArray(r) ? r[1] : undefined;
  if (info == null || typeof info !== "object") {
    info = lor(vanillaInfo, {
      move: M.move, effectiveness: 1, critical: false,
      moveType: tonumber(M.move.type), power: tonumber(M.move.power),
      typeFlags: { super: false, notVery: false, immune: false },
    });
  }
  return [Math.max(0, Math.floor(tonumber(dmg) ?? 0)), info];
}

// Lua: hit.lua:462
function hit_once(M: any, opts?: HitOnceOpts | null): [number | null, any, HitStatus] {
  const ad = M.adapter, target = M.target;
  opts = lor(opts, {}) as HitOnceOpts;
  let [dmg, info] = damage_calc(M, target, calc_opts(M, opts.calc));
  M.moveType = lor(info.moveType, M.moveType);
  if (truthy(info.failed)) {
    M.failed = true;
    ad.sayFail();
    return [null, info, "fail"];
  }
  if (flags_immune(M, info)) {
    M.noEffect = true;
    M.anim.missed = true;
    return [null, info, "immune"];
  }
  if (wonder_guard(M, info)) {
    M.noEffect = true;
    M.anim.missed = true;
    return [null, info, "immune"];
  }
  let hung: string | null;
  [dmg, hung] = Hit.adjustDamage(M, target, dmg);
  if (truthy(opts.onBeforeAnim)) opts.onBeforeAnim!();
  M._animDmg = dmg; M._animPower = info.power;
  M.attackAnimation(null, opts.multihitLeft);
  if (truthy(opts.onAfterAnim)) opts.onAfterAnim!();
  Hit.dealDamage(M, dmg, info);
  if (truthy(info.critical)) ad.sayText("STRINGID_CRITICALHIT");
  if (M.anim.effectiveness == null) M.anim.effectiveness = lor(info.effectiveness, 1);
  return [dmg, info, (truthy(hung) ? hung : "ok") as HitStatus];
}

// Lua: hit.lua:722
// pokefirered/src/battle_script_commands.c:8601
function speciesInfoStats(Pkmn: any, sp: number): any {
  const meta = truthy(Pkmn.speciesMeta) ? Pkmn.speciesMeta(sp) : Pkmn.speciesMeta;
  const row = truthy(meta) ? meta.linkStats : meta;
  if (row != null && typeof row === "object" && len(row) >= 6) return { atk: row[2], def: row[3] };
  return Pkmn.stats(sp);
}

export const Hit = {
  // Lua: hit.lua:43
  // pokefirered/src/battle_script_commands.c:1744
  dealDamage(M: any, dmg: any, info?: any): number {
    const ad = M.adapter, user = M.user, target = M.target;
    info = lor(info, {});
    dmg = Math.max(0, Math.floor(lor(dmg, 0)));
    if (lor(target.substituteHP, 0) > 0 && !truthy(info.ignoreSub)) {
      const subHp = target.substituteHP;
      const dealt = Math.min(dmg, subHp);
      target.substituteHP = subHp - dealt;
      ad.sayText("STRINGID_SUBSTITUTEDAMAGED", { def: target });
      if (target.substituteHP <= 0) {
        target.substituteHP = 0;
        ad.playAnim("general", "SUBSTITUTE_FADE", target, target);
        ad.sayText("STRINGID_PKMNSUBSTITUTEFADED", { def: target });
      }
      M.hitSubstitute = true;
      if (lor(M.firstDmg, 0) === 0) M.firstDmg = dmg;
      M.hpDealt = dealt;
      M.hitsLanded = lor(M.hitsLanded, 0) + 1;
      dealt_event(M, target, dealt, info, true);
      return dealt;
    }
    const before = ad.hp(target);
    ad.applyHpLoss(target, dmg, { hit: true });
    const after = ad.hp(target);
    const dealt = before - after;
    const hits: LuaTable = M.anim.hits;
    hits[len(hits) + 1] = {
      side: lor(target.side, "enemy"),
      battler: target.id,
      from: before,
      to: after,
      maxHp: ad.maxHp(target),
    };
    target.damageTakenThisTurn = lor(target.damageTakenThisTurn, 0) + dealt;
    if (lor(M.firstDmg, 0) === 0) M.firstDmg = dealt;
    if (dealt > 0) M.targetDamaged = true;
    target.expHurtBy = user.side;
    target.expHurtById = user.id;
    target.expLastHitById = user.id;
    let physical = info.physical;
    if (physical == null) physical = Types.isPhysical(lor(M.moveType, M.move.type));
    // pokefirered/src/battle_script_commands.c:1824
    if (truthy(physical)) {
      target.lastPhysicalDamageTaken = dealt;
      target.lastPhysicalById = user.id;
    } else {
      target.lastSpecialDamageTaken = dealt;
      target.lastSpecialById = user.id;
      M.specialHit = true;
    }
    if (lor(target.bideTurns, 0) > 0) {
      target.expBideDamage = lor(target.expBideDamage, 0) + dealt;
      target.expBideTarget = user;
    }
    M.hpDealt = dealt;
    M.hitsLanded = lor(M.hitsLanded, 0) + 1;
    dealt_event(M, target, dealt, info, false);
    // pokefirered/src/battle_controller_opponent.c:304
    if (truthy(Oak.active(M.st)) && dealt > 0 && (target.side === "enemy") && user.side === "player") {
      Oak.sayOnce(M.st, Oak.FLAG_INFLICT_DMG, "inflictingDamage", (t: any, key: any) => { M.say(t, key); });
    }
    return dealt;
  },

  // Lua: hit.lua:107
  // pokefirered/src/battle_script_commands.c:1577
  adjustDamage(M: any, target: any, dmg: number): [number, string | null] {
    const ad = M.adapter;
    const banded = HeldItems.rollFocusBand(ad, target);
    target.expFocusBanded = null;
    if (lor(target.substituteHP, 0) <= 0 && (truthy(target.expEnduring) || truthy(banded)) && dmg >= ad.hp(target)) {
      return [Math.max(0, ad.hp(target) - 1), truthy(target.expEnduring) ? "endured" : "hung"];
    }
    return [dmg, null];
  },

  // Lua: hit.lua:118
  // pokefirered/src/battle_script_commands.c:5602
  applySetDamage(M: any, dmg: number, flags?: any): void {
    const ad = M.adapter, target = M.target;
    let hung: string | null;
    [dmg, hung] = Hit.adjustDamage(M, target, dmg);
    M.attackAnimation();
    Hit.dealDamage(M, dmg);
    if (hung === "endured") {
      ad.sayText("STRINGID_PKMNENDUREDHIT", { def: target });
    } else if (hung === "hung") {
      HeldItems.focusBandMessage(ad, target);
    } else if (truthy(flags)) {
      const line = Hit.effectivenessLine(flags);
      if (truthy(line)) ad.sayText(line);
    }
  },

  // Lua: hit.lua:134
  effectivenessLine(flags: any): string | null {
    if (!truthy(flags)) return null;
    if (truthy(flags.super)) return "STRINGID_SUPEREFFECTIVE";
    if (truthy(flags.notVery)) return "STRINGID_NOTVERYEFFECTIVE";
    return null;
  },

  // Lua: hit.lua:494
  run(M: any): void {
    const ad = M.adapter, user = M.user, eff = M.effect;
    M.moveType = tonumber(M.move.type);

    if (pre_checks(M)) return;
    set_multipliers(M);

    if ((eff === E.RAMPAGE && lor(user.expRampageTurns, 0) > 0)
        || (eff === E.UPROAR && lor(user.expUproarTurns, 0) > 0)
        || (eff === E.ROLLOUT && lor(user.expRolloutTimer, 0) > 0)) {
      M.noPP = true;
    }
    if (eff === E.RAMPAGE && lor(user.expRampageTurns, 0) <= 0) M.startRampage = true;

    if (eff === E.EXPLOSION) {
      // pokefirered/data/battle_scripts_1.s:376
      M.attackString();
      M.ppReduce();
      M.explosionStarted = true;
      ad.setHp(user, 0);
      let [dmg, info] = damage_calc(M, M.target, calc_opts(M));
      if (!truthy(M.accuracyCheck("normal", true))) {
        M.anim.missed = true;
        M.noEffect = true;
        if (!truthy(M.deferUserFaint)) M.tryFaintUser();
        return;
      }
      if (flags_immune(M, info)) {
        M.noEffect = true;
        if (!truthy(M.deferUserFaint)) M.tryFaintUser();
        return;
      }
      const target = M.target;
      let hung: string | null;
      [dmg, hung] = Hit.adjustDamage(M, target, dmg);
      M.attackAnimation();
      Hit.dealDamage(M, dmg, info);
      if (truthy(info.critical)) ad.sayText("STRINGID_CRITICALHIT");
      M.anim.effectiveness = info.effectiveness;
      if (hung === "endured") ad.sayText("STRINGID_PKMNENDUREDHIT", { def: target });
      else if (hung === "hung") HeldItems.focusBandMessage(ad, target);
      else {
        const line = Hit.effectivenessLine(info.typeFlags);
        if (truthy(line)) ad.sayText(line);
      }
      M.tryFaintTarget();
      if (!truthy(M.deferUserFaint)) M.tryFaintUser();
      return;
    }

    M.attackString();
    M.ppReduce();

    let magnitude = M.magnitude;
    if (eff === E.MAGNITUDE && !truthy(magnitude)) {
      const r = roll(ad, 0, 99);
      const [, info] = Damage.calc(user, M.target, M.move, calc_opts(M, { magnitudeRoll: r, forceCrit: false, noRandom: true }));
      magnitude = { power: info.power, value: info.magnitude };
      M.magnitude = magnitude;
      ad.sayText("STRINGID_MAGNITUDESTRENGTH", { buff1: tostring(magnitude.value) });
    }

    if (eff === E.TRIPLE_KICK) return Hit.tripleKick(M);
    if (eff === E.BEAT_UP) return Hit.beatUp(M);

    if (!truthy(M.accuracyCheck("normal", true))) {
      on_miss(M);
      return;
    }

    if (eff === E.SEMI_INVULNERABLE) {
      user.semiInvulnerable = null;
      user.onAir = null; user.underground = null; user.underwater = null;
    }

    if (eff === E.RAGE) user.rage = true;

    const target = M.target;
    const calcExtra: Record<string, any> = {};
    if (truthy(magnitude)) calcExtra.power = magnitude.power;

    if (eff === E.ROLLOUT) {
      const [, f] = Types.typeCalc(M.move.type, target.type1, target.type2, null, target.expIdentified);
      if (truthy(f.immune)) {
        Engine.cancelMultiTurnMoves(user);
        ad.sayText("STRINGID_ITDOESNTAFFECT", { def: target });
        M.noEffect = true;
        return;
      }
      calcExtra.power = rollout_power(M);
    } else if (eff === E.FURY_CUTTER) {
      calcExtra.power = fury_cutter_power(M);
    } else if (eff === E.PRESENT) {
      const p = present(M);
      if (!truthy(p)) return;
      calcExtra.power = p;
    } else if (eff === E.SPIT_UP) {
      // pokefirered/src/battle_script_commands.c:6586
      const n = lor(user.expStockpile, 0);
      if (n <= 0) {
        ad.sayText("STRINGID_FAILEDTOSPITUP");
        M.failed = true;
        return;
      }
      user.expStockpile = 0;
      // pcall(require, "src.core.game3.battle.effects.stats"): always loads here.
      const ok = true, Stats: any = StatsMod;
      if (ok && truthy(Stats) && truthy(Stats.clearStockpileBoost)) Stats.clearStockpileBoost(user);
      let base = Damage.base(user, target, M.move, {
        adapter: ad, weatherKind: Rules.weather.effective(M.st, ad),
        reflect: calc_opts(M).reflect, lightScreen: calc_opts(M).lightScreen,
        doubleScreens: calc_opts(M).doubleScreens,
      }) * n;
      // pokefirered/src/battle_script_commands.c:6603
      if (truthy(user.expHelpingHand)) base = Math.floor(base * 15 / 10);
      const aT1 = user.type1, aT2 = user.type2;
      if (aT1 === tonumber(M.move.type) || aT2 === tonumber(M.move.type)) base = Math.floor(base * 15 / 10);
      const [dmg, flags] = Types.typeCalc(M.move.type, target.type1, target.type2, base, target.expIdentified);
      if (truthy(flags.immune)) {
        ad.sayText("STRINGID_ITDOESNTAFFECT", { def: target });
        M.noEffect = true;
        return;
      }
      Hit.applySetDamage(M, dmg as number, flags);
      M.tryFaintTarget();
      return;
    } else if (eff === E.BRICK_BREAK) {
      const side = ad.ownSide(target);
      if (truthy(side) && (lor(side.expReflectTurns, 0) > 0 || lor(side.expLightScreenTurns, 0) > 0)) {
        side.expReflectTurns = null;
        side.expLightScreenTurns = null;
        M.brokeWall = true;
      }
    }

    const fixed = eff === E.DRAGON_RAGE || eff === E.SONICBOOM || eff === E.LEVEL_DAMAGE
      || eff === E.SUPER_FANG || eff === E.PSYWAVE || eff === E.ENDEAVOR;
    const setDmg = fixed || eff === E.COUNTER || eff === E.MIRROR_COAT;

    let nHits = 1;
    let isMulti = false;
    if (eff === E.MULTI_HIT) { nHits = multi_hit_count(M); isMulti = true; }
    else if (eff === E.DOUBLE_HIT || eff === E.TWINEEDLE) { nHits = 2; isMulti = true; }
    else if (M.move.hits != null && typeof M.move.hits === "object") { nHits = multi_hit_count(M); isMulti = true; }
    else if (tonumber(M.move.hits) != null) { nHits = tonumber(M.move.hits)!; isMulti = nHits > 1; }

    let landed = 0;
    let lastInfo: any, lastStatus: HitStatus | undefined;
    for (let i = 1; i <= nHits; i++) {
      if (truthy(ad.isFainted(user)) || truthy(ad.isFainted(target))) break;
      if (isMulti && i > 1 && ad.status(user) === "SLP" && !(truthy(M.opts.calledBy) && move_is_sleep_talk(M.opts.calledBy))) break;
      const [, info, status] = hit_once(M, {
        calc: calcExtra,
        multihitLeft: isMulti ? (nHits - i + 1) : 0,
        onAfterAnim: (i === 1 && truthy(M.brokeWall)) ? () => { ad.sayText("STRINGID_THEWALLSHATTERED"); } : null,
      });
      lastInfo = info; lastStatus = status;
      if (status !== "ok" && status !== "endured" && status !== "hung") break;
      landed = landed + 1;
      if (status === "endured") {
        ad.sayText("STRINGID_PKMNENDUREDHIT", { def: target });
        break;
      }
      if (status === "hung") {
        HeldItems.focusBandMessage(ad, target);
      } else if (!isMulti) {
        let f = info.typeFlags;
        if (setDmg && !(eff === E.COUNTER || eff === E.MIRROR_COAT)) f = null;
        const line = Hit.effectivenessLine(f);
        if (truthy(line)) ad.sayText(line);
      }
    }
    if (isMulti && landed > 0) {
      if (lastStatus !== "endured" && lastStatus !== "hung") {
        const line = Hit.effectivenessLine(truthy(lastInfo) ? lastInfo.typeFlags : lastInfo);
        if (truthy(line)) ad.sayText(line);
      }
      ad.sayText("STRINGID_HITXTIMES", { buff1: tostring(landed) });
    }
    if (landed === 0) {
      M.noEffect = true;
      if (eff === E.ROLLOUT) {
        Engine.cancelMultiTurnMoves(user);
      }
      return;
    }

    if (eff === E.ABSORB || eff === E.DREAM_EATER) drain(M);
    secondary_after(M);
    M.tryFaintTarget();
    if (truthy(M.checkUserFaint)) M.tryFaintUser();
  },

  // Lua: hit.lua:689
  // pokefirered/data/battle_scripts_1.s:1380
  tripleKick(M: any): void {
    const ad = M.adapter, user = M.user, target = M.target;
    let power = 0;
    let landed = 0;
    let lastInfo: any;
    for (let i = 1; i <= 3; i++) {
      if (truthy(ad.isFainted(user))) break;
      if (truthy(ad.isFainted(target))) break;
      if (ad.status(user) === "SLP" && !(truthy(M.opts.calledBy) && move_is_sleep_talk(M.opts.calledBy))) break;
      if (!truthy(M.accuracyCheck("normal", landed === 0))) {
        if (landed === 0) on_miss(M);
        break;
      }
      power = power + 10;
      const [, info, status] = hit_once(M, { calc: { power }, multihitLeft: 4 - i });
      lastInfo = info;
      if (status !== "ok" && status !== "endured" && status !== "hung") break;
      landed = landed + 1;
      if (status === "endured") {
        ad.sayText("STRINGID_PKMNENDUREDHIT", { def: target });
        break;
      }
      if (status === "hung") HeldItems.focusBandMessage(ad, target);
    }
    if (landed > 0) {
      const line = Hit.effectivenessLine(truthy(lastInfo) ? lastInfo.typeFlags : lastInfo);
      if (truthy(line)) ad.sayText(line);
      ad.sayText("STRINGID_HITXTIMES", { buff1: tostring(landed) });
      M.tryFaintTarget();
    }
  },

  // Lua: hit.lua:730
  // pokefirered/src/battle_script_commands.c:8571
  beatUp(M: any): void {
    const ad = M.adapter, user = M.user, target = M.target;
    if (!truthy(M.accuracyCheck("normal", true))) {
      on_miss(M);
      return;
    }
    const party = ad.partyMons(user);
    let any = false;
    for (const [i, mon] of ipairs(party)) {
      if (truthy(ad.isFainted(target))) break;
      let hp = tonumber(truthy(mon) ? mon.hp : mon) ?? 0;
      let status = truthy(mon) ? mon.status : mon;
      if (i === user.partyIndex) {
        hp = ad.hp(user);
        status = ad.status(user);
      }
      if (truthy(mon) && hp > 0 && lor(mon.species, 0) !== 0 && !truthy(mon.isEgg) && (status == null || status === 0)) {
        any = true;
        const sp = tonumber(mon.species) ?? 0;
        const aBase = speciesInfoStats(Pokemon, sp);
        const dBase = speciesInfoStats(Pokemon, tonumber(target.species) ?? 0);
        const atk = truthy(aBase) && truthy(aBase.atk) ? aBase.atk : 50;
        const def = truthy(dBase) && truthy(dBase.def) ? dBase.def : 50;
        const lvl = tonumber(mon.level) ?? 1;
        let dmg = atk * (tonumber(M.move.power) ?? 10) * (Math.floor(lvl * 2 / 5) + 2);
        dmg = Math.floor(dmg / Math.max(1, def));
        dmg = Math.floor(dmg / 50) + 2;
        // pokefirered/src/battle_script_commands.c:8606
        if (truthy(user.expHelpingHand)) dmg = Math.floor(dmg * 15 / 10);
        const name = (truthy(mon.nickname) && mon.nickname !== "") ? mon.nickname : Pokemon.name(sp);
        // src/battle_script_commands.c:8597
        ad.sayText("STRINGID_PKMNATTACK", { buff1: State.prefixedName(M.st, user, name) });
        const crit = Rules.crit.roll(user, M.move, null, ad.rng(), M.st);
        if (truthy(crit)) dmg = dmg * 2;
        const r = roll(ad, 85, 100);
        dmg = Math.floor(dmg * r / 100);
        if (dmg === 0) dmg = 1;
        let hung: string | null;
        [dmg, hung] = Hit.adjustDamage(M, target, dmg);
        M.attackAnimation();
        Hit.dealDamage(M, dmg, { physical: false });
        if (truthy(crit)) ad.sayText("STRINGID_CRITICALHIT");
        if (hung === "endured") ad.sayText("STRINGID_PKMNENDUREDHIT", { def: target });
        else if (hung === "hung") HeldItems.focusBandMessage(ad, target);
        M.tryFaintTarget();
      }
    }
    if (!any) {
      M.failed = true;
      ad.sayFail();
    }
  },
};

export default Hit;
