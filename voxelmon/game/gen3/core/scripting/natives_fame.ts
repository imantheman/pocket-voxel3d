// Port of gen1recomp src/core/game3/scripting/natives_fame.lua (GPLv3 + additional terms; see LICENSE.md).
// Fame Checker specials (pokefirered/src/fame_checker.c).
//
// Port notes:
// - Handlers return Lua's multiple returns as a 0-based tuple (natives.ts):
//   `return false` is `return [false]`.
// - package.loaded / require of space, runtime, flags: static imports.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tonumber } from "../../../../import/gen3/lua.ts";
import Std from "./stdscripts.ts";
import FameChecker from "../fame_checker.ts";
import Flags from "./flags.ts";
import Space from "./space.ts";
import Runtime from "../runtime.ts";
import type { Handler } from "./natives.ts";

// pokefirered/include/constants/vars.h:319
const VAR_0x8004 = 0x8004;
const VAR_0x8005 = 0x8005;

// pokefirered/data/specials.inc:382
const SPECIAL_SetFlavorTextFlagFromSpecialVars = 0x173;
// pokefirered/data/specials.inc:383
const SPECIAL_UpdatePickStateFromSpecialVar8005 = 0x174;

// Lua: natives_fame.lua:20
function flagsMod(): typeof Flags {
  return Flags;
}

// Lua: natives_fame.lua:24
function scriptStore(): any {
  const S: any = Space;
  const rt: any = Runtime;
  const session = rt && rt.getSession && rt.getSession();
  return (S && S.store) || (session && session.store) || undefined;
}

// Lua: natives_fame.lua:31
function varGet(ctx: any, id: number): number {
  return tonumber(flagsMod().getVar(scriptStore(), ctx, id)) ?? 0;
}

// Lua: natives_fame.lua:35
function varSet(ctx: any, id: number, value: any): void {
  flagsMod().setVar(scriptStore(), ctx, id, tonumber(value) ?? 0);
}

const BY_NAME: Record<string, Handler> = {
  // Lua: natives_fame.lua:41
  // pokefirered/src/fame_checker.c:1222
  SetFlavorTextFlagFromSpecialVars: (ctx) => {
    const person = varGet(ctx, VAR_0x8004);
    const slot = varGet(ctx, VAR_0x8005);
    if (FameChecker.setFlavorText(person, slot)) {
      varSet(ctx, VAR_0x8005, FameChecker.PICKSTATE.SILHOUETTE);
    }
    return [false];
  },
  // Lua: natives_fame.lua:50
  // pokefirered/src/fame_checker.c:1232
  UpdatePickStateFromSpecialVar8005: (ctx) => {
    FameChecker.updatePickState(varGet(ctx, VAR_0x8004), varGet(ctx, VAR_0x8005));
    return [false];
  },
};

export const Fame = {
  SPECIAL: {
    SetFlavorTextFlagFromSpecialVars: SPECIAL_SetFlavorTextFlagFromSpecialVars,
    UpdatePickStateFromSpecialVar8005: SPECIAL_UpdatePickStateFromSpecialVar8005,
  },
  BY_NAME,
  /** Set by Std.legacyHandlers: special id -> handler. */
  HANDLERS: undefined as Record<number, Handler> | undefined,
};
// Lua: natives_fame.lua:55
Std.legacyHandlers(Fame);

export default Fame;
