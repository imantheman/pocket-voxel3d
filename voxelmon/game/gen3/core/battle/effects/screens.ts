// Port of gen1recomp src/core/game3/battle/effects/screens.lua (GPLv3 + additional terms; see LICENSE.md).
// Screens (FRLG Reflect / Light Screen / Safeguard only).
//
// Port notes:
// - The lazy require of battle.state is a static import.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { truthy } from "../../../../../import/gen3/lua.ts";
import type { EffectContext } from "../effect_ctx.ts";
import Capabilities from "../capabilities.ts";
import H from "./_helpers.ts";
import State from "../state.ts";

function lor(a: any, b: any): any {
  return truthy(a) ? a : b;
}

// Lua: screens.lua:9
// pokefirered/src/battle_script_commands.c:6428
function both_alive(ctx: EffectContext): any {
  const st = ctx.adapter._st;
  return st != null && truthy(st.double)
    && State.countPresentOnSide(st, ctx.user.side) === 2;
}

export const Screens = {
  // Lua: screens.lua:16
  // pokefirered/src/battle_script_commands.c:8266
  safeguard(ctx: EffectContext): void {
    const side = H.ownSide(ctx);
    if (!truthy(side)) return H.sayFail(ctx);
    if (lor(side.expSafeguardTurns, 0) > 0) return H.sayFail(ctx);
    side.expSafeguardTurns = Capabilities.safeguardDefaultTurns;
    H.attackAnim(ctx);
    ctx.adapter.sayText("STRINGID_PKMNCOVEREDBYVEIL", { atk: ctx.user });
  },

  // Lua: screens.lua:26
  // pokefirered/src/battle_script_commands.c:6415
  reflect(ctx: EffectContext): void {
    const side = H.ownSide(ctx);
    if (!truthy(side)) return H.sayFail(ctx);
    if (lor(side.expReflectTurns, 0) > 0) return H.sayFail(ctx);
    side.expReflectTurns = Capabilities.screenDefaultTurns;
    H.attackAnim(ctx);
    ctx.adapter.sayText(truthy(both_alive(ctx)) ? "STRINGID_PKMNRAISEDDEFALITTLE" : "STRINGID_PKMNRAISEDDEF",
      { atk: ctx.user, currentMove: H.moveNum(lor(ctx.move, ctx.moveId)) });
  },

  // Lua: screens.lua:37
  // pokefirered/src/battle_script_commands.c:7082
  lightScreen(ctx: EffectContext): void {
    const side = H.ownSide(ctx);
    if (!truthy(side)) return H.sayFail(ctx);
    if (lor(side.expLightScreenTurns, 0) > 0) return H.sayFail(ctx);
    side.expLightScreenTurns = Capabilities.screenDefaultTurns;
    H.attackAnim(ctx);
    ctx.adapter.sayText(truthy(both_alive(ctx)) ? "STRINGID_PKMNRAISEDSPDEFALITTLE" : "STRINGID_PKMNRAISEDSPDEF",
      { atk: ctx.user, currentMove: H.moveNum(lor(ctx.move, ctx.moveId)) });
  },

  // Lua: screens.lua:48
  // pokefirered/data/battle_scripts_1.s:873
  mist(ctx: EffectContext): void {
    const side = H.ownSide(ctx);
    if (!truthy(side)) return H.sayFail(ctx);
    if (lor(side.expMistTurns, 0) > 0) return H.sayFail(ctx);
    side.expMistTurns = 5;
    H.attackAnim(ctx);
    ctx.adapter.sayText("STRINGID_PKMNSHROUDEDINMIST", { atk: ctx.user });
  },
};

export default Screens;
