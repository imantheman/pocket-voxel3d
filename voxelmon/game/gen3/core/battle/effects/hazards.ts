// Port of gen1recomp src/core/game3/battle/effects/hazards.lua (GPLv3 + additional terms; see LICENSE.md).
// Hazards (FRLG Spikes only; Gen4+ not registered).
//
// Port notes:
// - side.hazards is a Lua table that is both a sequence and carries a
//   `spikes` field: a sequence array (slot 0 unused) with a `spikes` property.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { truthy, tonumber } from "../../../../../import/gen3/lua.ts";
import { ipairs, len, type LuaTable } from "../../../platform/lt.ts";
import type { EffectContext } from "../effect_ctx.ts";
import H from "./_helpers.ts";

export const Hazards = {
  // Lua: hazards.lua:7
  layers(side: any): number {
    if (!truthy(side)) return 0;
    let n = tonumber(side.spikes) ?? 0;
    const hz = side.hazards;
    if (truthy(hz)) {
      n = Math.max(n, tonumber(hz.spikes) ?? 0);
      for (const [, h] of ipairs(hz)) {
        if (h.id === "SPIKES") n = Math.max(n, tonumber(h.layers) ?? 1);
      }
    }
    return n;
  },

  // Lua: hazards.lua:20
  set(side: any, n: number): void {
    if (!truthy(side)) return;
    side.hazards = truthy(side.hazards) ? side.hazards : [null];
    const keep: LuaTable = [null];
    for (const [, h] of ipairs(side.hazards)) {
      if (h.id !== "SPIKES") keep[len(keep) + 1] = h;
    }
    for (let i = len(side.hazards); i >= 1; i--) side.hazards[i] = null;
    for (const [i, h] of ipairs(keep)) side.hazards[i] = h;
    if (n > 0) {
      side.hazards[len(side.hazards) + 1] = { id: "SPIKES", layers: n };
      side.hazards.spikes = n;
      side.spikes = n;
    } else {
      side.hazards.spikes = null;
      side.spikes = 0;
    }
  },

  // Lua: hazards.lua:39
  clear(side: any): void {
    Hazards.set(side, 0);
  },

  // Lua: hazards.lua:44
  // pokefirered/src/battle_script_commands.c:8110
  spikes(ctx: EffectContext): void {
    const side = H.foeSide(ctx);
    if (!truthy(side)) return H.sayFail(ctx);
    const n = Hazards.layers(side);
    if (n >= 3) return H.sayFail(ctx);
    Hazards.set(side, n + 1);
    H.attackAnim(ctx);
    ctx.adapter.sayText("STRINGID_SPIKESSCATTERED");
  },
};

export default Hazards;
