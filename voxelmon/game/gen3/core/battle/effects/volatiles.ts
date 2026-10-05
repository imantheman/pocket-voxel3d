// Port of gen1recomp src/core/game3/battle/effects/volatiles.lua (GPLv3 + additional terms; see LICENSE.md).
// FRLG volatiles (ported from KR battle/core/effects/volatiles.lua; no KR require).
//
// Port notes:
// - The lazy requires (engine, pokemon) are static imports.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { truthy, tonumber, tostring } from "../../../../../import/gen3/lua.ts";
import { ipairs, len, type LuaTable } from "../../../platform/lt.ts";
import type { EffectContext } from "../effect_ctx.ts";
import H from "./_helpers.ts";
import Engine from "../engine.ts";
import Pokemon from "../../pokemon.ts";

function lor(a: any, b: any): any {
  return truthy(a) ? a : b;
}

// Lua: volatiles.lua:8
// pokefirered/src/battle_script_commands.c:6220
function protect_like(ctx: EffectContext, onSuccess: (user: any) => void): void {
  const user = ctx.user;
  const last = truthy(user.expLastResulting) ? H.moveNum(user.expLastResulting) : user.expLastResulting;
  if (last !== 182 && last !== 197 && last !== 203) user.expProtectStreak = 0;
  const streak = lor(user.expProtectStreak, 0);
  const st = ctx.adapter._st;
  let ok = user.expTurnOrder !== ((truthy(st) && truthy(st.double)) ? 4 : 2);
  if (ok && streak > 0) {
    const denom = Math.pow(2, Math.min(streak, 3));
    ok = ctx.adapter.roll(0, denom - 1) === 0;
  }
  if (!ok) {
    user.expProtectStreak = 0;
    return H.sayFail(ctx);
  }
  user.expProtectStreak = streak + 1;
  H.attackAnim(ctx);
  onSuccess(user);
}

export const Volatiles = {
  // Lua: volatiles.lua:28
  protect(ctx: EffectContext): void {
    protect_like(ctx, (user) => {
      user.expProtected = true;
      ctx.adapter.sayText("STRINGID_PKMNPROTECTEDITSELF2", { atk: user });
    });
  },

  // Lua: volatiles.lua:35
  endure(ctx: EffectContext): void {
    protect_like(ctx, (user) => {
      user.expEnduring = true;
      ctx.adapter.sayText("STRINGID_PKMNBRACEDITSELF", { atk: user });
    });
  },

  // Lua: volatiles.lua:43
  // pokefirered/src/battle_script_commands.c:7642
  encore(ctx: EffectContext): void {
    const target = ctx.target;
    if (!truthy(H.accuracy(ctx, "normal"))) return;
    const last = H.moveNum(H.lastMove(ctx, target));
    if (!truthy(last) || last === 0 || last === 165 || last === 227 || last === 119) return H.sayFail(ctx);
    if (lor(target.expEncoreTurns, 0) > 0) return H.sayFail(ctx);
    const slot = H.slotOf(target, last);
    const mon = target.mon;
    if (!truthy(slot) || !truthy(mon) || !truthy(mon.pp) || (tonumber(mon.pp[slot!]) ?? 0) <= 0) return H.sayFail(ctx);
    target.expEncoreMove = mon.moves[slot!];
    target.expEncoreSlot = slot;
    target.expEncoreTurns = ctx.adapter.roll(0, 3) % 4 + 3;
    H.attackAnim(ctx);
    ctx.adapter.sayText("STRINGID_PKMNGOTENCORE", { def: target });
  },

  // Lua: volatiles.lua:60
  // pokefirered/src/battle_script_commands.c:8133
  perishSong(ctx: EffectContext): void {
    const ad = ctx.adapter;
    let affected = 0;
    const blocked: LuaTable = [null];
    for (const [, b] of ipairs(ad.activeBattlers())) {
      if (truthy(b.expPerishTurns) || ad.abilityOf(b) === "SOUNDPROOF") {
        if (ad.abilityOf(b) === "SOUNDPROOF") blocked[len(blocked) + 1] = b;
      } else {
        b.expPerishTurns = 3;
        b.perishSong = true;
        affected = affected + 1;
      }
    }
    if (affected === 0) return H.sayFail(ctx);
    H.attackAnim(ctx);
    ad.sayText("STRINGID_FAINTINTHREE");
    // data/battle_scripts_1.s:1580
    for (const [, b] of ipairs(blocked)) {
      ad.sayText("STRINGID_PKMNSXBLOCKSY2", {
        scrActive: b, scrActiveAbility: H.abilityId("SOUNDPROOF"), currentMove: H.moveNum(lor(ctx.move, ctx.moveId)),
      });
    }
  },

  // Lua: volatiles.lua:85
  // pokefirered/src/battle_script_commands.c:7275
  attract(ctx: EffectContext): any {
    const ad = ctx.adapter, target = ctx.target;
    if (!truthy(H.accuracy(ctx, "normal"))) return;
    if (ad.abilityOf(target) === "OBLIVIOUS") {
      return ad.sayText("STRINGID_PKMNPREVENTSROMANCEWITH", { def: target, defAbility: H.abilityId("OBLIVIOUS") });
    }
    const userMon = ad.mon(ctx.user);
    const targetMon = ad.mon(target);
    const ug = truthy(userMon) ? userMon.gender : userMon;
    const tg = truthy(targetMon) ? targetMon.gender : targetMon;
    if (truthy(target.expInfatuated) || !truthy(ug) || !truthy(tg) || ug === "U" || tg === "U" || ug === tg) {
      return H.sayFail(ctx);
    }
    target.expInfatuated = true;
    target.expInfatuatedBy = ctx.user.side;
    target.expInfatuatedWith = ctx.user;
    H.attackAnim(ctx);
    ad.sayText("STRINGID_PKMNFELLINLOVE", { def: target });
  },

  // Lua: volatiles.lua:106
  // pokefirered/src/battle_script_commands.c:7943
  spite(ctx: EffectContext): void {
    const ad = ctx.adapter, target = ctx.target;
    if (!truthy(H.accuracy(ctx, "normal"))) return;
    const last = H.lastMove(ctx, target);
    const slot = truthy(last) ? H.slotOf(target, last) : last;
    const mon = target.mon;
    if (!truthy(slot) || !truthy(mon) || !truthy(mon.pp) || (tonumber(mon.pp[slot]) ?? 0) <= 1) return H.sayFail(ctx);
    let cut = ad.roll(0, 3) % 4 + 2;
    if (mon.pp[slot] < cut) cut = mon.pp[slot];
    mon.pp[slot] = mon.pp[slot] - cut;
    if (mon.pp[slot] === 0) {
      Engine.cancelMultiTurnMoves(target);
    }
    H.attackAnim(ctx);
    ad.sayText("STRINGID_PKMNREDUCEDPP", {
      def: target, buff1: Pokemon.moveName(H.moveNum(last)), buff2: tostring(cut),
    });
  },

  // Lua: volatiles.lua:127
  // pokefirered/src/battle_script_commands.c:8744
  torment(ctx: EffectContext): void {
    if (!truthy(H.accuracy(ctx, "normal"))) return;
    if (truthy(ctx.target.expTormented)) return H.sayFail(ctx);
    ctx.target.expTormented = true;
    ctx.target.torment = true;
    H.attackAnim(ctx);
    ctx.adapter.sayText("STRINGID_PKMNSUBJECTEDTOTORMENT", { def: ctx.target });
  },
};

export default Volatiles;
