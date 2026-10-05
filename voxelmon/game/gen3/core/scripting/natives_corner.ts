// Port of gen1recomp src/core/game3/scripting/natives_corner.lua (GPLv3 + additional terms; see LICENSE.md).
// Game Corner specials (coin case capacity).
//
// Port notes:
// - Handlers return Lua's multiple returns as a 0-based tuple (see natives.ts).
// - package.loaded probes are static imports used as Brian guards them.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { truthy, tonumber } from "../../../../import/gen3/lua.ts";
import Std from "./stdscripts.ts";
import Flags from "./flags.ts";
import Runtime from "../runtime.ts";
import Space from "./space.ts";
import type { Handler, HandlerRet } from "./natives.ts";

/** Lua's `a or b`. */
function lor<A, B>(a: A, b: B): A | B {
  return truthy(a) ? a : b;
}

// pokefirered/include/constants/vars.h:321
const VAR_0x8006 = 0x8006;
const VAR_RESULT = 0x800D;

// pokefirered/include/constants/coins.h:4
const MAX_COINS = 9999;

// pokefirered/data/specials.inc:361
const SPECIAL_CheckAddCoins = 0x15E;

// Lua: natives_corner.lua:20
function flagsMod(): typeof Flags {
  return Flags;
}

// Lua: natives_corner.lua:24
function scriptStore(): any {
  // package.loaded["src.core.game3.scripting.space"] / ["src.core.game3.runtime"]
  const rt = Runtime;
  const session = rt && rt.getSession && rt.getSession();
  return lor(lor(Space && Space.store, session && session.store), undefined);
}

// Lua: natives_corner.lua:31
function varGet(ctx: any, id: number): number {
  return tonumber(flagsMod().getVar(scriptStore(), ctx, id)) ?? 0;
}

export const Corner = {
  MAX_COINS,

  SPECIAL: {
    CheckAddCoins: SPECIAL_CheckAddCoins,
  },

  // Lua: natives_corner.lua:36
  // pokefirered/src/field_specials.c:719
  checkAddCoins(currentIn: any, toAddIn: any): number {
    const current = Math.floor(tonumber(currentIn) ?? 0);
    const toAdd = Math.floor(tonumber(toAddIn) ?? 0);
    if (current + toAdd > MAX_COINS) return 0;
    return 1;
  },

  BY_NAME: {
    // Lua: natives_corner.lua:45
    // pokefirered/src/field_specials.c:719
    CheckAddCoins: (ctx: any): HandlerRet => {
      return [false, Corner.checkAddCoins(varGet(ctx, VAR_RESULT), varGet(ctx, VAR_0x8006))];
    },
  } as Record<string, Handler>,
  /** Set by Std.legacyHandlers (stdscripts.lua:262): special id -> handler. */
  HANDLERS: undefined as Record<number, Handler> | undefined,
};
// Lua: natives_corner.lua:49
Std.legacyHandlers(Corner);

export default Corner;
