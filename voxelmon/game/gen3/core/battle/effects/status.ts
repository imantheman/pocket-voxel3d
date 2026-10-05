// Port of gen1recomp src/core/game3/battle/effects/status.lua (GPLv3 + additional terms; see LICENSE.md).
// Primary status moves (burn / poison / toxic / sleep / paralyze), Taunt, Yawn.
//
// Port notes:
// - Types.typeCalc returns (dmg, flags, product): a tuple; only flags is used.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { truthy, tonumber } from "../../../../../import/gen3/lua.ts";
import type { EffectContext } from "../effect_ctx.ts";
import H from "./_helpers.ts";
import Secondary from "./secondary.ts";
import Types from "../types.ts";

function lor(a: any, b: any): any {
  return truthy(a) ? a : b;
}

// Lua: status.lua:8
function sub(ctx: EffectContext): boolean { return lor(ctx.target.substituteHP, 0) > 0; }

// Lua: status.lua:10
function safeguarded(ctx: EffectContext): boolean {
  const side = ctx.adapter.ownSide(ctx.target);
  if (truthy(side) && lor(side.expSafeguardTurns, 0) > 0) {
    ctx.adapter.sayText("STRINGID_PKMNUSEDSAFEGUARD", { def: ctx.target });
    return true;
  }
  return false;
}

// Lua: status.lua:20
function not_affected(ctx: EffectContext): void {
  const M = H.move(ctx);
  if (truthy(M)) M.noEffect = true;
  ctx.adapter.sayText("STRINGID_ITDOESNTAFFECT", { def: ctx.target });
}

// Lua: status.lua:26
function primary(ctx: EffectContext, eff: string): boolean {
  const M = H.move(ctx);
  if (truthy(M)) return Secondary.set(M, eff, true, false, false);
  const fake = { adapter: ctx.adapter, user: ctx.user, target: ctx.target, st: ctx.adapter._st };
  return Secondary.set(fake, eff, true, false, false);
}

export const Status = {
  safeguarded,

  // Lua: status.lua:34
  // pokefirered/src/battle_script_commands.c:6546
  cantMakeAsleep(ctx: EffectContext, target: any): boolean {
    const ad = ctx.adapter;
    const ab = ad.abilityOf(target);
    const up = ad.uproarActive();
    if (truthy(up) && ab !== "SOUNDPROOF") {
      ad.sayText("STRINGID_PKMNCANTSLEEPINUPROAR", { def: target });
      return true;
    }
    if (ab === "INSOMNIA" || ab === "VITAL_SPIRIT") {
      ad.sayText("STRINGID_PKMNSTAYEDAWAKEUSING", { def: target, defAbility: H.abilityId(ab) });
      return true;
    }
    return false;
  },

  // Lua: status.lua:50
  // pokefirered/data/battle_scripts_1.s:2170
  burn(ctx: EffectContext): any {
    const ad = ctx.adapter, t = ctx.target;
    if (sub(ctx)) return H.sayFail(ctx);
    if (ad.status(t) === "BRN") {
      return ad.sayText("STRINGID_PKMNALREADYHASBURN", { def: t });
    }
    if (H.hasType(ctx, t, Types.ID.FIRE)) return not_affected(ctx);
    if (ad.abilityOf(t) === "WATER_VEIL") {
      return ad.sayText("STRINGID_PKMNSXPREVENTSBURNS", { eff: t, effAbility: H.abilityId("WATER_VEIL") });
    }
    if (truthy(ad.status(t))) return H.sayFail(ctx);
    if (!truthy(H.accuracy(ctx, "normal"))) return;
    if (safeguarded(ctx)) return;
    H.attackAnim(ctx);
    primary(ctx, "BURN");
  },

  // Lua: status.lua:68
  // pokefirered/data/battle_scripts_1.s:984
  poison(ctx: EffectContext): any {
    const ad = ctx.adapter, t = ctx.target;
    if (ad.abilityOf(t) === "IMMUNITY") {
      return ad.sayText("STRINGID_PKMNPREVENTSPOISONINGWITH", { eff: t, defAbility: H.abilityId("IMMUNITY") });
    }
    if (sub(ctx)) return H.sayFail(ctx);
    if (ad.status(t) === "PSN" || ad.status(t) === "TOX") {
      return ad.sayText("STRINGID_PKMNALREADYPOISONED", { def: t });
    }
    if (H.hasType(ctx, t, Types.ID.POISON) || H.hasType(ctx, t, Types.ID.STEEL)) {
      return not_affected(ctx);
    }
    if (truthy(ad.status(t))) return H.sayFail(ctx);
    if (!truthy(H.accuracy(ctx, "normal"))) return;
    if (safeguarded(ctx)) return;
    H.attackAnim(ctx);
    primary(ctx, "POISON");
  },

  // Lua: status.lua:88
  // pokefirered/data/battle_scripts_1.s:687
  toxic(ctx: EffectContext): any {
    const ad = ctx.adapter, t = ctx.target;
    if (ad.abilityOf(t) === "IMMUNITY") {
      return ad.sayText("STRINGID_PKMNPREVENTSPOISONINGWITH", { eff: t, defAbility: H.abilityId("IMMUNITY") });
    }
    if (sub(ctx)) return H.sayFail(ctx);
    if (ad.status(t) === "PSN" || ad.status(t) === "TOX") {
      return ad.sayText("STRINGID_PKMNALREADYPOISONED", { def: t });
    }
    if (truthy(ad.status(t))) return H.sayFail(ctx);
    if (H.hasType(ctx, t, Types.ID.POISON) || H.hasType(ctx, t, Types.ID.STEEL)) {
      return not_affected(ctx);
    }
    if (!truthy(H.accuracy(ctx, "normal"))) return;
    if (safeguarded(ctx)) return;
    H.attackAnim(ctx);
    primary(ctx, "TOXIC");
  },

  // Lua: status.lua:108
  // pokefirered/data/battle_scripts_1.s:287
  sleep(ctx: EffectContext): any {
    const ad = ctx.adapter, t = ctx.target;
    if (sub(ctx)) return H.sayFail(ctx);
    if (ad.status(t) === "SLP") {
      return ad.sayText("STRINGID_PKMNALREADYASLEEP", { def: t });
    }
    if (Status.cantMakeAsleep(ctx, t)) return;
    if (truthy(ad.status(t))) return H.sayFail(ctx);
    if (!truthy(H.accuracy(ctx, "normal"))) return;
    if (safeguarded(ctx)) return;
    H.attackAnim(ctx);
    primary(ctx, "SLEEP");
  },

  // Lua: status.lua:123
  // pokefirered/data/battle_scripts_1.s:1005
  paralyze(ctx: EffectContext): any {
    const ad = ctx.adapter, t = ctx.target;
    if (ad.abilityOf(t) === "LIMBER") {
      return ad.sayText("STRINGID_PKMNPREVENTSPARALYSISWITH", { eff: t, defAbility: H.abilityId("LIMBER") });
    }
    if (sub(ctx)) return H.sayFail(ctx);
    const mt = truthy(ctx.move) && truthy(ctx.move.type) ? ctx.move.type : 0;
    const [, flags] = Types.typeCalc(mt, t.type1, t.type2, null, t.expIdentified);
    if (truthy(flags.immune) || (ad.abilityOf(t) === "LEVITATE" && tonumber(mt) === Types.ID.GROUND)) {
      return not_affected(ctx);
    }
    if (ad.status(t) === "PAR") {
      return ad.sayText("STRINGID_PKMNISALREADYPARALYZED", { def: t });
    }
    if (truthy(ad.status(t))) return H.sayFail(ctx);
    if (!truthy(H.accuracy(ctx, "normal"))) return;
    if (safeguarded(ctx)) return;
    H.attackAnim(ctx);
    primary(ctx, "PARALYSIS");
  },

  // Lua: status.lua:145
  // pokefirered/data/battle_scripts_1.s:2303
  taunt(ctx: EffectContext): any {
    if (!truthy(H.accuracy(ctx, "normal"))) return;
    if (lor(ctx.target.expTauntedTurns, 0) > 0) return H.sayFail(ctx);
    // pokefirered/src/battle_script_commands.c:8765
    ctx.target.expTauntedTurns = 2;
    H.attackAnim(ctx);
    ctx.adapter.sayText("STRINGID_PKMNFELLFORTAUNT", { def: ctx.target });
  },

  // Lua: status.lua:155
  // pokefirered/data/battle_scripts_1.s:2446
  yawn(ctx: EffectContext): any {
    const ad = ctx.adapter, t = ctx.target;
    const ab = ad.abilityOf(t);
    if (ab === "VITAL_SPIRIT" || ab === "INSOMNIA") {
      return ad.sayText("STRINGID_PKMNSXMADEITINEFFECTIVE", { scrActive: t, scrActiveAbility: H.abilityId(ab) });
    }
    if (sub(ctx)) return H.sayFail(ctx);
    if (safeguarded(ctx)) return;
    if (!truthy(H.accuracy(ctx, "lockon"))) return;
    if (truthy(ad.uproarActive()) && ab !== "SOUNDPROOF") return H.sayFail(ctx);
    if (lor(t.expYawnTurns, 0) > 0 || truthy(ad.status(t))) return H.sayFail(ctx);
    t.expYawnTurns = 2;
    t.yawnTurns = 2;
    H.attackAnim(ctx);
    ad.sayText("STRINGID_PKMNWASMADEDROWSY", { atk: ctx.user, def: t });
  },
};

export default Status;
