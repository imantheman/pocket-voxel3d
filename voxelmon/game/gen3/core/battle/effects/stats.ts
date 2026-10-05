// Port of gen1recomp src/core/game3/battle/effects/stats.lua (GPLv3 + additional terms; see LICENSE.md).
// Stat stage effects. ROM effect byte -> STAT_CHANGES drives generic path.
//
// Port notes:
// - fromRomEffect walks spec.stages with pairs(); every STAT_CHANGES entry
//   has a single stat, so the order cannot differ from Brian's.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { truthy, tonumber, tostring } from "../../../../../import/gen3/lua.ts";
import { ipairs, pairs, seq, type LuaTable } from "../../../platform/lt.ts";
import type { EffectContext } from "../effect_ctx.ts";
import H from "./_helpers.ts";
import EffectIds from "../effect_ids.ts";
import Secondary from "./secondary.ts";

function lor(a: any, b: any): any {
  return truthy(a) ? a : b;
}

const ORDER = seq("attack", "defense", "speed", "spAtk", "spDef", "accuracy", "evasion");

// Lua: stats.lua:22
// pokefirered/data/battle_scripts_1.s:491
function stat_up(ctx: EffectContext, stat: string, delta: number): void {
  const ad = ctx.adapter, user = ctx.user;
  if (lor(user.stages[stat], 0) >= 6) {
    ad.sayText("STRINGID_STATSWONTINCREASE", { atk: user, buff1: Secondary.statName(stat) });
    const M = H.move(ctx);
    if (truthy(M)) M.failed = true;
    return;
  }
  H.attackAnim(ctx);
  Secondary.changeStat(ad, user, stat, delta, { user: true, allowPtr: true });
}

// Lua: stats.lua:36
// pokefirered/data/battle_scripts_1.s:536
function stat_down(ctx: EffectContext, stat: string, delta: number): void {
  const ad = ctx.adapter, t = ctx.target;
  if (lor(t.substituteHP, 0) > 0) return H.sayFail(ctx);
  if (!truthy(H.accuracy(ctx, "normal"))) return;
  const cur = lor(t.stages[stat], 0);
  const side = ad.ownSide(t);
  const ab = ad.abilityOf(t);
  const blocked = (truthy(side) && lor(side.expMistTurns, 0) > 0)
    || ab === "CLEAR_BODY" || ab === "WHITE_SMOKE"
    || (ab === "KEEN_EYE" && stat === "accuracy")
    || (ab === "HYPER_CUTTER" && stat === "attack");
  if (!blocked && cur > -6) H.attackAnim(ctx);
  Secondary.changeStat(ad, t, stat, delta, { allowPtr: true });
}

// Lua: stats.lua:73
function multi_up(ctx: EffectContext, stats: LuaTable): any {
  const ad = ctx.adapter, user = ctx.user;
  let any = false;
  for (const [, s] of ipairs<string>(stats)) {
    if (lor(user.stages[s], 0) < 6) any = true;
  }
  if (!any) {
    const M = H.move(ctx);
    if (truthy(M)) M.failed = true;
    return ad.sayText("STRINGID_STATSWONTINCREASE2", { atk: user });
  }
  H.attackAnim(ctx);
  Secondary.multiStatAnim(ad, user, stats, 1);
  for (const [, s] of ipairs<string>(stats)) {
    if (lor(user.stages[s], 0) < 6) {
      Secondary.changeStat(ad, user, s, 1, { user: true, allowPtr: true, noAnim: true });
    }
  }
}

// Lua: stats.lua:126
function swagger_like(ctx: EffectContext, stat: string, delta: number): any {
  const ad = ctx.adapter, t = ctx.target;
  const M = H.move(ctx);
  if (lor(t.substituteHP, 0) > 0) {
    if (truthy(M)) M.anim.missed = true;
    return ad.sayText("STRINGID_ATTACKMISSED", { atk: ctx.user });
  }
  if (!truthy(H.accuracy(ctx, "normal"))) return;
  if (lor(t.confusionTurns, 0) > 0 && lor(t.stages[stat], 0) >= 6) return H.sayFail(ctx);
  H.attackAnim(ctx);
  if (lor(t.stages[stat], 0) < 6) {
    Secondary.changeStat(ad, t, stat, delta, { allowPtr: true });
  }
  if (ad.abilityOf(t) === "OWN_TEMPO") {
    return ad.sayText("STRINGID_PKMNPREVENTSCONFUSIONWITH", { def: t, defAbility: H.abilityId("OWN_TEMPO") });
  }
  const side = ad.ownSide(t);
  if (truthy(side) && lor(side.expSafeguardTurns, 0) > 0) {
    return ad.sayText("STRINGID_PKMNUSEDSAFEGUARD", { def: t });
  }
  const ctxM = truthy(M) ? M : { adapter: ad, user: ctx.user, target: t, st: ad._st };
  Secondary.set(ctxM, "CONFUSION", true, false, false);
}

export const Stats = {
  // Lua: stats.lua:11
  change(ctx: EffectContext, target: any, changes: Record<string, any>, isFoe: any): void {
    if (truthy(isFoe) && lor(target.substituteHP, 0) > 0) return H.sayFail(ctx);
    for (const [, k] of ipairs<string>(ORDER)) {
      const d = changes[k];
      if (truthy(d) && d !== 0) {
        Secondary.changeStat(ctx.adapter, target, k, d, { allowPtr: true, user: !truthy(isFoe) });
      }
    }
  },

  statUp: stat_up,
  statDown: stat_down,

  // Lua: stats.lua:52
  fromRomEffect(ctx: EffectContext): void {
    const effect = tonumber(truthy(ctx.move) ? ctx.move.effect : ctx.move);
    const spec = effect != null ? EffectIds.STAT_CHANGES[effect] : null;
    if (!truthy(spec)) return H.sayFail(ctx);
    for (const [stat, d] of pairs<number>(spec!.stages)) {
      if (truthy(spec!.self)) stat_up(ctx, stat as string, d); else stat_down(ctx, stat as string, d);
    }
  },

  // Lua: stats.lua:62
  // pokefirered/data/battle_scripts_1.s:1472
  minimize(ctx: EffectContext): void {
    ctx.user.minimized = true;
    stat_up(ctx, "evasion", 1);
  },

  // Lua: stats.lua:68
  // pokefirered/data/battle_scripts_1.s:2010
  defenseCurl(ctx: EffectContext): void {
    ctx.user.defenseCurl = true;
    stat_up(ctx, "defense", 1);
  },

  multiUp: multi_up,

  // Lua: stats.lua:95
  // pokefirered/data/battle_scripts_1.s:2733
  calmMind(ctx: EffectContext): void { multi_up(ctx, seq("spAtk", "spDef")); },
  // Lua: stats.lua:97
  // pokefirered/data/battle_scripts_1.s:2708
  bulkUp(ctx: EffectContext): void { multi_up(ctx, seq("attack", "defense")); },
  // Lua: stats.lua:99
  // pokefirered/data/battle_scripts_1.s:2765
  dragonDance(ctx: EffectContext): void { multi_up(ctx, seq("attack", "speed")); },
  // Lua: stats.lua:101
  // pokefirered/data/battle_scripts_1.s:2679
  cosmicPower(ctx: EffectContext): void { multi_up(ctx, seq("defense", "spDef")); },

  // Lua: stats.lua:103
  growl(ctx: EffectContext): void { stat_down(ctx, "attack", -1); },
  // Lua: stats.lua:104
  tailWhip(ctx: EffectContext): void { stat_down(ctx, "defense", -1); },
  // Lua: stats.lua:105
  leer(ctx: EffectContext): void { stat_down(ctx, "defense", -1); },
  // Lua: stats.lua:106
  harden(ctx: EffectContext): void { stat_up(ctx, "defense", 1); },
  // Lua: stats.lua:107
  swordsDance(ctx: EffectContext): void { stat_up(ctx, "attack", 2); },
  // Lua: stats.lua:108
  agility(ctx: EffectContext): void { stat_up(ctx, "speed", 2); },
  // Lua: stats.lua:109
  amnesia(ctx: EffectContext): void { stat_up(ctx, "spDef", 2); },

  // Lua: stats.lua:112
  // pokefirered/data/battle_scripts_1.s:2644
  tickle(ctx: EffectContext): any {
    const ad = ctx.adapter, t = ctx.target;
    if (lor(t.stages.attack, 0) <= -6 && lor(t.stages.defense, 0) <= -6) {
      const M = H.move(ctx);
      if (truthy(M)) M.failed = true;
      return ad.sayText("STRINGID_STATSWONTDECREASE2", { def: t });
    }
    if (!truthy(H.accuracy(ctx, "normal"))) return;
    H.attackAnim(ctx);
    Secondary.multiStatAnim(ad, t, seq("attack", "defense"), -1);
    Secondary.changeStat(ad, t, "attack", -1, { allowPtr: true, noAnim: true, noMsg: lor(t.stages.attack, 0) <= -6 });
    Secondary.changeStat(ad, t, "defense", -1, { allowPtr: true, noAnim: true, noMsg: lor(t.stages.defense, 0) <= -6 });
  },

  // Lua: stats.lua:151
  // pokefirered/data/battle_scripts_1.s:1604
  swagger(ctx: EffectContext): void { swagger_like(ctx, "attack", 2); },
  // Lua: stats.lua:153
  // pokefirered/data/battle_scripts_1.s:2147
  flatter(ctx: EffectContext): void { swagger_like(ctx, "spAtk", 1); },

  // Lua: stats.lua:156
  // pokefirered/src/battle_script_commands.c:8423
  psychUp(ctx: EffectContext): void {
    const target = ctx.target;
    if (!truthy(target) || !truthy(target.stages)) return H.sayFail(ctx);
    for (const [, s] of ipairs<string>(ORDER)) {
      ctx.user.stages[s] = lor(target.stages[s], 0);
    }
    H.attackAnim(ctx);
    ctx.adapter.sayText("STRINGID_PKMNCOPIEDSTATCHANGES", { atk: ctx.user, def: target });
  },

  // Lua: stats.lua:167
  // pokefirered/src/battle_script_commands.c:6568
  stockpile(ctx: EffectContext): any {
    const n = lor(ctx.user.expStockpile, 0);
    if (n >= 3) {
      const M = H.move(ctx);
      if (truthy(M)) M.failed = true;
      return ctx.adapter.sayText("STRINGID_PKMNCANTSTOCKPILE", { atk: ctx.user });
    }
    ctx.user.expStockpile = n + 1;
    ctx.user.stockpile = n + 1;
    H.attackAnim(ctx);
    ctx.adapter.sayText("STRINGID_PKMNSTOCKPILED", { atk: ctx.user, buff1: tostring(n + 1) });
  },

  // Lua: stats.lua:180
  clearStockpileBoost(user: any): void {
    if (truthy(user)) user.stockpile = 0;
  },

  // Lua: stats.lua:185
  // pokefirered/src/battle_script_commands.c:8709
  charge(ctx: EffectContext): void {
    ctx.user.expCharged = 2;
    ctx.user.chargedUp = true;
    H.attackAnim(ctx);
    ctx.adapter.sayText("STRINGID_PKMNCHARGINGPOWER", { atk: ctx.user });
  },

  // Lua: stats.lua:193
  // pokefirered/data/battle_scripts_1.s:2199
  memento(ctx: EffectContext): void {
    const ad = ctx.adapter, user = ctx.user, t = ctx.target;
    const M = H.move(ctx);
    const prot = truthy(M) ? M.isProtected() : M;
    if (!truthy(prot) && lor(t.stages.attack, 0) <= -6 && lor(t.stages.spAtk, 0) <= -6) {
      return H.sayFail(ctx);
    }
    ad.setHp(user, 0);
    if (truthy(prot)) {
      ad.sayText("STRINGID_PKMNPROTECTEDITSELF", { def: t });
    } else {
      H.attackAnim(ctx);
      if (lor(t.substituteHP, 0) > 0) {
        ad.sayText("STRINGID_BUTNOEFFECT");
      } else {
        Secondary.multiStatAnim(ad, t, seq("attack", "spAtk"), -2);
        Secondary.changeStat(ad, t, "attack", -2, { allowPtr: true, noAnim: true, noMsg: lor(t.stages.attack, 0) <= -6 });
        Secondary.changeStat(ad, t, "spAtk", -2, { allowPtr: true, noAnim: true, noMsg: lor(t.stages.spAtk, 0) <= -6 });
      }
    }
    if (truthy(M)) { M.checkUserFaint = true; M.tryFaintUser(); }
  },
};

export default Stats;
