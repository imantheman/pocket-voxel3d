// Port of gen1recomp src/core/game3/battle/effects/weather.lua (GPLv3 + additional terms; see LICENSE.md).
// Weather-setting move effects (Sunny Day / Rain Dance / Sandstorm / Hail).

/* eslint-disable @typescript-eslint/no-explicit-any */
import type { EffectContext } from "../effect_ctx.ts";
import Capabilities from "../capabilities.ts";
import H from "./_helpers.ts";
import Rules from "../rules.ts";

// Lua: weather.lua:8
// pokefirered/src/battle_script_commands.c:6399
function set(ctx: EffectContext, kind: string, id: string): void {
  const cur = Rules.weather.kind(ctx.adapter._st.weather);
  const want = Rules.weather.kind(kind);
  if (cur === want || (cur == null && want == null)) return H.sayFail(ctx);
  ctx.adapter.setWeather(kind, Capabilities.weatherDefaultTurns);
  H.attackAnim(ctx);
  ctx.adapter.sayText(id);
}

export const Weather = {
  // Lua: weather.lua:17
  // src/battle_message.c:912
  sunny(ctx: EffectContext): void { set(ctx, "SUNNY", "STRINGID_SUNLIGHTGOTBRIGHT"); },
  // Lua: weather.lua:18
  rainy(ctx: EffectContext): void { set(ctx, "RAINY", "STRINGID_STARTEDTORAIN"); },
  // Lua: weather.lua:19
  sandstorm(ctx: EffectContext): void { set(ctx, "SANDSTORM", "STRINGID_SANDSTORMBREWED"); },
  // Lua: weather.lua:20
  hail(ctx: EffectContext): void { set(ctx, "HAIL", "STRINGID_STARTEDHAIL"); },
};

export default Weather;
