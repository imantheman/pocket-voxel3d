// Port of gen1recomp src/core/game3/battle/effects/healing.lua (GPLv3 + additional terms; see LICENSE.md).
// Healing / recover / wish / stockpile swallow (FRLG; KR-sourced; no KR require).
//
// Port notes:
// - The lazy requires (effects.status, battle.state) are static imports.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { truthy, tonumber } from "../../../../../import/gen3/lua.ts";
import { ipairs, len } from "../../../platform/lt.ts";
import type { EffectContext } from "../effect_ctx.ts";
import H from "./_helpers.ts";
import Rules from "../rules.ts";
import State from "../state.ts";
import Status from "./status.ts";

function lor(a: any, b: any): any {
  return truthy(a) ? a : b;
}

// Lua: healing.lua:8
function hp_full(ctx: EffectContext, b: any): void {
  ctx.adapter.sayText("STRINGID_PKMNHPFULL", { def: b });
}

export const Healing = {
  // Lua: healing.lua:13
  // pokefirered/data/battle_scripts_1.s:2515
  refresh(ctx: EffectContext): void {
    const st = ctx.adapter.status(ctx.user);
    const ok = st === "BRN" || st === "PSN" || st === "PAR" || st === "TOX";
    if (!ok) return H.sayFail(ctx);
    ctx.adapter.clearStatus(ctx.user);
    H.attackAnim(ctx);
    ctx.adapter.sayText("STRINGID_PKMNSTATUSNORMAL", { atk: ctx.user });
  },

  // Lua: healing.lua:23
  // pokefirered/data/battle_scripts_1.s:2372
  ingrain(ctx: EffectContext): void {
    if (truthy(ctx.user.expIngrain)) return H.sayFail(ctx);
    ctx.user.expIngrain = true;
    ctx.user.rooted = true;
    ctx.user.expTrapped = true;
    H.attackAnim(ctx);
    ctx.adapter.sayText("STRINGID_PKMNPLANTEDROOTS", { atk: ctx.user });
  },

  // Lua: healing.lua:33
  // pokefirered/src/battle_script_commands.c:6332
  recover(ctx: EffectContext): void {
    const maxHp = ctx.adapter.maxHp(ctx.user);
    const hp = ctx.adapter.hp(ctx.user);
    if (hp >= maxHp) return hp_full(ctx, ctx.user);
    let heal = Math.floor(maxHp / 2);
    if (heal === 0) heal = 1;
    H.attackAnim(ctx);
    ctx.adapter.heal(ctx.user, heal);
    ctx.adapter.sayText("STRINGID_PKMNREGAINEDHEALTH", { def: ctx.user });
  },

  // Lua: healing.lua:44
  softboiled(ctx: EffectContext): void {
    return Healing.recover(ctx);
  },

  // Lua: healing.lua:49
  // pokefirered/src/battle_script_commands.c:8478
  morningSun(ctx: EffectContext): void {
    const ad = ctx.adapter, user = ctx.user;
    const maxHp = ad.maxHp(user);
    if (ad.hp(user) >= maxHp) return hp_full(ctx, user);
    const weather = Rules.weather.effective(ad._st, ad);
    let heal: number;
    if (!truthy(weather)) {
      heal = Math.floor(maxHp / 2);
    } else if (weather === "SUN") {
      heal = Math.floor(20 * maxHp / 30);
    } else {
      heal = Math.floor(maxHp / 4);
    }
    if (heal === 0) heal = 1;
    H.attackAnim(ctx);
    ad.heal(user, heal);
    ad.sayText("STRINGID_PKMNREGAINEDHEALTH", { def: user });
  },

  // Lua: healing.lua:69
  // pokefirered/data/battle_scripts_1.s:735
  rest(ctx: EffectContext): any {
    const ad = ctx.adapter, user = ctx.user;
    if (ad.status(user) === "SLP") {
      return ad.sayText("STRINGID_PKMNALREADYASLEEP2", { atk: user });
    }
    if (Status.cantMakeAsleep(ctx, user)) return;
    const maxHp = ad.maxHp(user);
    const hp = ad.hp(user);
    if (hp >= maxHp) return hp_full(ctx, user);
    const hadStatus = ad.status(user) != null;
    ad.clearStatus(user);
    user.status = "SLP";
    if (truthy(user.mon)) user.mon.status = "SLP";
    // pokefirered/src/battle_script_commands.c:6480
    user.sleepTurns = 3;
    if (hadStatus) {
      ad.sayText("STRINGID_PKMNSLEPTHEALTHY", { atk: user });
    } else {
      ad.sayText("STRINGID_PKMNWENTTOSLEEP", { atk: user });
    }
    H.attackAnim(ctx);
    ad.heal(user, maxHp - hp);
    ad.sayText("STRINGID_PKMNREGAINEDHEALTH", { def: user });
  },

  // Lua: healing.lua:96
  // pokefirered/src/battle_script_commands.c:8399
  bellyDrum(ctx: EffectContext): void {
    const ad = ctx.adapter, user = ctx.user;
    const maxHp = ad.maxHp(user);
    let half = Math.floor(maxHp / 2);
    if (half === 0) half = 1;
    const stages = ad.stages(user);
    if (!truthy(stages) || lor(stages.attack, 0) >= 6 || ad.hp(user) <= half) return H.sayFail(ctx);
    stages.attack = 6;
    H.attackAnim(ctx);
    ad.applyHpLoss(user, half);
    ad.sayText("STRINGID_PKMNCUTHPMAXEDATTACK", { atk: user });
  },

  // Lua: healing.lua:110
  // pokefirered/src/battle_script_commands.c:8899
  wish(ctx: EffectContext): void {
    const side = ctx.adapter.ownSide(ctx.user);
    if (!truthy(side)) return H.sayFail(ctx);
    side.tokens = truthy(side.tokens) ? side.tokens : [null];
    const double = truthy(ctx.adapter._st) ? ctx.adapter._st.double : ctx.adapter._st;
    for (const [, tok] of ipairs(side.tokens)) {
      if (tok.id === "EXP_WISH" && (!truthy(double) || tok.battlerId === ctx.user.id)) return H.sayFail(ctx);
    }
    side.tokens[len(side.tokens) + 1] = {
      id: "EXP_WISH",
      turns: 2,
      wisher: ctx.adapter.displayName(ctx.user),
      battlerId: ctx.user.id,
    };
    H.attackAnim(ctx);
  },

  // Lua: healing.lua:128
  // pokefirered/src/battle_script_commands.c:7995
  healBell(ctx: EffectContext): void {
    const ad = ctx.adapter, user = ctx.user;
    const move = lor(ctx.move, {});
    const isBell = tonumber(move.numId) === 215 || move.id === "HEAL_BELL";
    const active = State.partyMon(user);
    const blocked = isBell && ad.abilityOf(user) === "SOUNDPROOF";
    // battle_script_commands.c:8015-8016
    if (!blocked) {
      ad.clearStatus(user);
      user.expNightmare = null;
    }
    let partner: any = null;
    if (truthy(ad._st) && truthy(ad._st.double)) partner = ad.partnerOf(user);
    if (!truthy(partner)) partner = null;
    const partnerBlocked = truthy(partner) && isBell && ad.abilityOf(partner) === "SOUNDPROOF";
    // pokefirered/src/battle_script_commands.c:8023
    if (truthy(partner) && !partnerBlocked) {
      ad.clearStatus(partner);
      partner.expNightmare = null;
    }
    const partnerMon = truthy(partner) ? State.partyMon(partner) : partner;
    for (const [, mon] of ipairs(ad.partyMons(user))) {
      if (truthy(mon) && mon !== active && mon !== partnerMon && truthy(mon.status)) {
        mon.status = null;
        mon.sleep = null;
        // battle_script_commands.c:8015
        mon.expNightmare = null;
      }
    }
    H.attackAnim(ctx);
    if (isBell) {
      ad.sayText("STRINGID_BELLCHIMED");
      const soundproof = H.abilityId("SOUNDPROOF");
      // data/battle_scripts_1.s:1368
      if (blocked) {
        ad.sayText("STRINGID_PKMNSXBLOCKSY", { def: user, defAbility: soundproof, currentMove: 215 });
      }
      if (partnerBlocked) {
        ad.sayText("STRINGID_PKMNSXBLOCKSY2", { scrActive: partner, scrActiveAbility: soundproof, currentMove: 215 });
      }
    } else {
      ad.sayText("STRINGID_SOOTHINGAROMA");
    }
  },

  // Lua: healing.lua:173
  // pokefirered/src/battle_script_commands.c:7674
  painSplit(ctx: EffectContext): void {
    const ad = ctx.adapter;
    if (!truthy(H.accuracy(ctx, "lockon"))) return;
    if (lor(ctx.target.substituteHP, 0) > 0) return H.sayFail(ctx);
    const uHp = ad.hp(ctx.user);
    const tHp = ad.hp(ctx.target);
    const avg = Math.floor((uHp + tHp) / 2);
    H.attackAnim(ctx);
    ad.setHp(ctx.user, Math.min(ad.maxHp(ctx.user), avg));
    ad.setHp(ctx.target, Math.min(ad.maxHp(ctx.target), avg));
    ad.sayText("STRINGID_SHAREDPAIN");
  },

  // Lua: healing.lua:187
  // pokefirered/src/battle_script_commands.c:6612
  swallow(ctx: EffectContext): any {
    const ad = ctx.adapter, user = ctx.user;
    const n = lor(user.expStockpile, 0);
    if (n <= 0) {
      return ad.sayText("STRINGID_FAILEDTOSWALLOW");
    }
    const maxHp = ad.maxHp(user);
    user.expStockpile = 0;
    user.stockpile = 0;
    if (ad.hp(user) >= maxHp) return hp_full(ctx, user);
    let heal = Math.floor(maxHp / Math.pow(2, 3 - n));
    if (heal === 0) heal = 1;
    H.attackAnim(ctx);
    ad.heal(user, heal);
    ad.sayText("STRINGID_PKMNREGAINEDHEALTH", { def: user });
  },
};

export default Healing;
