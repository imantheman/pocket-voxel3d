// Port of gen1recomp src/core/game3/scripting/natives_fan_club.lua (GPLv3 + additional terms; see LICENSE.md).
// Script specials for Trainer Fan Club (pokefirered/src/trainer_fan_club.c).
// Covers specials 0xA3 through 0xAA (pokefirered/data/specials.inc:174-181).
//
// Port notes:
// - Handlers return Lua's multiple returns as a 0-based tuple (natives.ts).
// - package.loaded / require of space, runtime, flags: static imports.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tonumber } from "../../../../import/gen3/lua.ts";
import Std from "./stdscripts.ts";
import FC from "../trainer_fan_club.ts";
import Flags from "./flags.ts";
import Space from "./space.ts";
import Runtime from "../runtime.ts";
import type { Handler } from "./natives.ts";

const VAR_RESULT = 0x800D; // pokefirered/include/constants/vars.h:328
const VAR_0x8004 = 0x8004; // pokefirered/include/constants/vars.h:319

// Lua: natives_fan_club.lua:12
function flagsMod(): typeof Flags {
  return Flags;
}

// Lua: natives_fan_club.lua:16
function sessionOf(ctx: any): any {
  if (ctx && ctx.session) return ctx.session;
  const S: any = Space;
  if (S && S.store && S.store.flags) return S.store;
  const rt: any = Runtime;
  return (rt && rt.getSession && rt.getSession()) || undefined;
}

// Lua: natives_fan_club.lua:24
function scriptStore(ctx: any): any {
  const S: any = Space;
  const session = sessionOf(ctx);
  return (S && S.store) || (ctx && ctx.session) || (session && session.store) || session || undefined;
}

// Lua: natives_fan_club.lua:30
function varGet(ctx: any, id: number): number {
  return tonumber(flagsMod().getVar(scriptStore(ctx), ctx, id)) ?? 0;
}

// Lua: natives_fan_club.lua:34
function setResult(ctx: any, value: any): void {
  flagsMod().setVar(scriptStore(ctx), ctx, VAR_RESULT, tonumber(value) ?? 0);
}


const BY_NAME: Record<string, Handler> = {
  // Lua: natives_fan_club.lua:40
  // pokefirered/src/trainer_fan_club.c:223 Script_IsFanClubMemberFanOfPlayer
  Script_IsFanClubMemberFanOfPlayer: (ctx) => {
    const memberId = varGet(ctx, VAR_0x8004);
    const isFan = FC.isFanClubMemberFanOfPlayer(sessionOf(ctx), ctx, memberId);
    setResult(ctx, isFan ? 1 : 0);
    return [false];
  },

  // Lua: natives_fan_club.lua:48
  // pokefirered/src/trainer_fan_club.c:170 Script_GetNumFansOfPlayerInTrainerFanClub
  Script_GetNumFansOfPlayerInTrainerFanClub: (ctx) => {
    const count = FC.getNumFansOfPlayerInTrainerFanClub(sessionOf(ctx), ctx);
    setResult(ctx, count);
    return [false];
  },

  // Lua: natives_fan_club.lua:55
  // pokefirered/src/trainer_fan_club.c:240 Script_BufferFanClubTrainerName
  Script_BufferFanClubTrainerName: (ctx, adapters) => {
    const memberId = varGet(ctx, VAR_0x8004);
    FC.bufferFanClubTrainerName(sessionOf(ctx), ctx, adapters, memberId);
    return [false];
  },

  // Lua: natives_fan_club.lua:62
  // pokefirered/src/trainer_fan_club.c:40 Script_TryLoseFansFromPlayTimeAfterLinkBattle
  Script_TryLoseFansFromPlayTimeAfterLinkBattle: (ctx) => {
    FC.tryLoseFansFromPlayTimeAfterLinkBattle(sessionOf(ctx), ctx);
    return [false];
  },

  // Lua: natives_fan_club.lua:68
  // pokefirered/src/trainer_fan_club.c:189 Script_TryLoseFansFromPlayTime
  Script_TryLoseFansFromPlayTime: (ctx) => {
    FC.tryLoseFansFromPlayTime(sessionOf(ctx), ctx);
    return [false];
  },

  // Lua: natives_fan_club.lua:74
  // pokefirered/src/trainer_fan_club.c:334 Script_SetPlayerGotFirstFans
  Script_SetPlayerGotFirstFans: (ctx) => {
    FC.setPlayerGotFirstFans(sessionOf(ctx), ctx);
    return [false];
  },

  // Lua: natives_fan_club.lua:80
  // pokefirered/src/trainer_fan_club.c:54 Script_UpdateTrainerFanClubGameClear
  Script_UpdateTrainerFanClubGameClear: (ctx) => {
    FC.updateTrainerFanClubGameClear(sessionOf(ctx), ctx);
    return [false];
  },

  // Lua: natives_fan_club.lua:86
  // pokefirered/src/trainer_fan_club.c:344 Script_TryGainNewFanFromCounter
  Script_TryGainNewFanFromCounter: (ctx) => {
    const counterIdx = varGet(ctx, VAR_0x8004);
    const timer = FC.tryGainNewFanFromCounter(sessionOf(ctx), ctx, counterIdx);
    setResult(ctx, timer);
    return [false];
  },
};

export const FanClub = {
  BY_NAME,
  /** Set by Std.legacyHandlers: special id -> handler. */
  HANDLERS: undefined as Record<number, Handler> | undefined,
};
// Lua: natives_fan_club.lua:93
Std.legacyHandlers(FanClub);

export default FanClub;
