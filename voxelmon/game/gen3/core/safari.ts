// Port of gen1recomp src/core/game3/safari.lua (GPLv3 + additional terms; see LICENSE.md).
// pokefirered/src/safari_zone.c:9 gNumSafariBalls / gSafariZoneStepCounter
//
// The battle profile's `safari` config exists only for Emerald; its branches
// call src.core.game3.rse.init, which is Emerald only (no port).
// `love` is always present here, so presenter()'s love.graphics guard is constant true.

import { tonumber, tostring, truthy } from "../../../import/gen3/lua.ts";
import { pairs } from "../platform/lt.ts";
import { RomText } from "./rom_text.ts";
import { Runtime } from "./runtime.ts";
import { Field as FieldMod } from "./field.ts";
import { Space as SpaceMod } from "./scripting/space.ts";
import { BattleProfile } from "./battle/profile.ts";
import { Flags } from "./scripting/flags.ts";
import { Audio } from "./audio.ts";
import { Warp } from "./warp.ts";
import { SE } from "./se_ids.ts";
import { Message } from "../ui/message.ts";
import { Choice } from "../ui/choice.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface SafariPresenter {
  message?: (text: string, onDone: () => void) => void;
  yesNo?: ((onPick: (yes: boolean) => void) => void) | null;
  close?: () => void;
}

// Lua: safari.lua:25
function runtime(): any {
  return Runtime;
}

// Lua: safari.lua:29
function session_of(session?: any): any {
  if (session) return session;
  const R = runtime();
  if (R && R.getSession) {
    const s = R.getSession();
    if (s) return s;
  }
  const Field: any = FieldMod;
  return Field && Field.getSession ? Field.getSession() ?? null : null;
}

// Lua: safari.lua:40
function game_of(game?: any): any {
  if (game) return game;
  const R = runtime();
  return (R && R._game) || null;
}

// Lua: safari.lua:46
function store(): any {
  const Space: any = SpaceMod;
  return Space && Space.store ? Space.store : null;
}

// Lua: safari.lua:51
function script_ctx(): any {
  const Space: any = SpaceMod;
  return (Space && Space.vm && Space.vm.ctx) || null;
}

// Lua: safari.lua:56
function rse_cfg(session: any): any {
  let p: any;
  try { p = (BattleProfile as any).get(session); } catch { return null; }
  return p ? p.safari ?? null : null;
}

// NOT FAITHFUL: Emerald only -- src.core.game3.rse.init is not ported; only
// reached when the battle profile has a safari config (Emerald's).
function rseInit(): never {
  throw new Error("NOT FAITHFUL: Emerald only: src.core.game3.rse.init");
}

// Lua: safari.lua:64
function flag_id(session: any): number {
  const cfg = rse_cfg(session);
  if (cfg) return rseInit();
  return Safari.FLAG_SYS_SAFARI_MODE;
}

// Lua: safari.lua:70
function set_flag(session: any, on: boolean): void {
  const st = store();
  const id = flag_id(session);
  if (st) Flags.setFlag(st, script_ctx(), id, on);
  if (session) {
    session.flags = session.flags ?? {};
    if (on) session.flags[id] = on; else delete session.flags[id];
  }
}

// Lua: safari.lua:81
function se(id: any): void {
  try {
    if (Audio && Audio.playSe) Audio.playSe(id);
  } catch { /* pcall */ }
}

// Lua: safari.lua:96
function flag_set(session: any): boolean {
  const st = store();
  const id = flag_id(session);
  if (st && Flags.getFlag(st, script_ctx(), id)) return true;
  if (session && session.flags && truthy(session.flags[id])) return true;
  return false;
}

// Lua: safari.lua:170
function run_script(label: any): any {
  const Space: any = SpaceMod;
  if (!(Space && Space.startScript && Space.scriptKey)) return false;
  const key = Space.scriptKey(label);
  if (!truthy(key)) throw new Error("safari: no script " + tostring(label));
  return Space.startScript(key);
}

// Lua: safari.lua:217
function set_entrance_scene(session: any, value: number): void {
  const st = store();
  if (st) Flags.setVar(st, script_ctx(), Safari.VAR_ENTRANCE_SCENE, value);
  if (session) {
    session.vars = session.vars ?? {};
    session.vars[Safari.VAR_ENTRANCE_SCENE] = value;
  }
}

// Lua: safari.lua:256
function presenter(): SafariPresenter | null {
  if (Safari.presenter) return Safari.presenter;
  if (!(Message && Message.show)) return null;
  return {
    message: (text: string, onDone: () => void) => { Message.show(text, onDone); },
    yesNo: (Choice && Choice.yesNo)
      ? (onPick: (yes: boolean) => void) => { Choice.yesNo(onPick); } : null,
    close: () => { Message.close(); },
  };
}

// Lua: safari.lua:270
function announce(text: string, _session: any, _game: any, onDone: () => void): boolean {
  // pokefirered/include/constants/songs.h:70
  se(SE.SE_DING_DONG);
  const Field: any = FieldMod;
  if (Field) Field.locked = true;
  const P = presenter();
  if (P && P.message) {
    P.message(text, () => {
      if (Field) Field.locked = false;
      onDone();
    });
    return true;
  }
  if (Field) Field.locked = false;
  onDone();
  return true;
}

export const Safari = {
  // Lua: safari.lua:14 -- pokefirered/include/constants/flags.h:1327
  FLAG_SYS_SAFARI_MODE: 0x800,
  // pokefirered/include/constants/vars.h:162
  VAR_ENTRANCE_SCENE: 0x406E,
  // pokefirered/src/safari_zone.c:31
  BALLS: 30,
  STEPS: 600,
  // pokefirered/data/scripts/safari_zone.inc:6
  EXIT_MAP: "FR_FUCHSIA_CITY_SAFARI_ZONE_ENTRANCE",
  EXIT_X: 4,
  EXIT_Y: 1,

  // Lua: safari.lua:62
  rseConfig: rse_cfg,

  // Lua: safari.lua:89 -- pokefirered/src/safari_zone.c:9
  state(sessionIn?: any): any {
    const session = session_of(sessionIn);
    if (!session) return null;
    session.safari = session.safari ?? {};
    return session.safari;
  },

  // Lua: safari.lua:106 -- pokefirered/src/overworld.c:1381 ResetSafariZoneFlag_
  reset(sessionIn?: any): boolean {
    const session = session_of(sessionIn);
    set_flag(session, false);
    const state = session ? session.safari : null;
    if (state) {
      state.balls = 0;
      state.steps = 0;
    }
    return true;
  },

  // Lua: safari.lua:118 -- pokefirered/src/safari_zone.c:12 GetSafariZoneFlag
  isActive(sessionIn?: any): boolean {
    const session = session_of(sessionIn);
    if (!flag_set(session)) return false;
    // pokefirered/src/overworld.c:1695 CB2_ContinueSavedGame
    const state = session ? session.safari : null;
    if (!(state && tonumber(state.steps) != null)) {
      Safari.reset(session);
      return false;
    }
    return true;
  },

  // Lua: safari.lua:131 -- pokefirered/src/safari_zone.c:26 EnterSafariMode
  enter(sessionIn?: any): boolean {
    const session = session_of(sessionIn);
    if (!session) return false;
    set_flag(session, true);
    const state = Safari.state(session);
    const cfg = rse_cfg(session);
    if (cfg) {
      // pokeemerald/src/safari_zone.c:55
      state.balls = cfg.balls;
      state.steps = cfg.steps;
      state.caughtMons = 0;
      state.pkblkUses = 0;
      state.feeders = {};
      return true;
    }
    state.balls = Safari.BALLS;
    state.steps = Safari.STEPS;
    return true;
  },

  // Lua: safari.lua:152 -- pokefirered/src/safari_zone.c:34 ExitSafariMode
  exit(sessionIn?: any): boolean {
    const session = session_of(sessionIn);
    const state = Safari.state(session);
    if (state && rse_cfg(session)) {
      // pokeemerald/src/safari_zone.c:68
      rseInit();
    }
    set_flag(session, false);
    if (state) {
      state.balls = 0;
      state.steps = 0;
      // pokeemerald/src/safari_zone.c:70
      if (rse_cfg(session)) state.feeders = {};
    }
    return true;
  },

  // Lua: safari.lua:179 -- pokeemerald/src/safari_zone.c:97
  endBattleRse(sessionIn: any, st: any): any {
    const session = session_of(sessionIn);
    const cfg = rse_cfg(session);
    const state = Safari.state(session);
    if (!(cfg && state)) return false;
    const sf = st ? st.safariState ?? {} : {};
    state.pkblkUses = (tonumber(state.pkblkUses) ?? 0) + (tonumber(sf.pokeblockThrows) ?? 0);
    if (st && st.result === "catch") state.caughtMons = (tonumber(state.caughtMons) ?? 0) + 1;
    if ((tonumber(state.balls) ?? 0) !== 0) return false;
    if (st && st.endReason === "no_safari_balls") {
      // pokeemerald/src/safari_zone.c:108
      const Space: any = SpaceMod;
      if (Space && Space.runImmediately) Space.runImmediately(cfg.outOfBallsMidBattle);
      const dest = session.warpDestination;
      if (dest && dest.map) {
        const R = runtime();
        Warp.request(R ? R._mod : undefined, game_of(null), dest.map, dest.x, dest.y,
          "down", { fade: false, se: false } as any);
      }
      return true;
    }
    if (st && st.result === "catch") {
      // pokeemerald/src/safari_zone.c:115
      return run_script(cfg.outOfBalls);
    }
    return false;
  },

  // Lua: safari.lua:207
  balls(session?: any): number {
    const state = Safari.state(session);
    return (state ? tonumber(state.balls) : undefined) ?? 0;
  },

  // Lua: safari.lua:212
  steps(session?: any): number {
    const state = Safari.state(session);
    return (state ? tonumber(state.steps) : undefined) ?? 0;
  },

  // Lua: safari.lua:228 -- pokefirered/data/scripts/safari_zone.inc:7 SafariZone_EventScript_Exit
  exitToEntrance(sessionIn?: any, gameIn?: any): boolean {
    const session = session_of(sessionIn);
    const game = game_of(gameIn);
    set_entrance_scene(session, 1);
    Safari.exit(session);
    const R = runtime();
    Warp.request(R ? R._mod : undefined, game, Safari.EXIT_MAP,
      Safari.EXIT_X, Safari.EXIT_Y, "down", { fade: true } as any);
    return true;
  },

  // Lua: safari.lua:241 -- pokefirered/data/scripts/safari_zone.inc:1 SafariZone_EventScript_OutOfBallsMidBattle
  outOfBallsMidBattle(sessionIn?: any, gameIn?: any): boolean {
    const session = session_of(sessionIn);
    const game = game_of(gameIn);
    set_entrance_scene(session, 3);
    Safari.exit(session);
    const R = runtime();
    // pokefirered/src/safari_zone.c:68
    Warp.request(R ? R._mod : undefined, game, Safari.EXIT_MAP,
      Safari.EXIT_X, Safari.EXIT_Y, "down", { fade: false, se: false } as any);
    return true;
  },

  // Lua: safari.lua:254
  presenter: null as SafariPresenter | null,

  // Lua: safari.lua:289 -- pokefirered/data/scripts/safari_zone.inc:25 SafariZone_EventScript_TimesUp
  timesUp(session?: any, game?: any): boolean {
    return announce(
      RomText.ascii("SafariZone_Text_TimesUp"),
      session, game, () => { Safari.exitToEntrance(session, game); });
  },

  // Lua: safari.lua:296 -- pokefirered/data/scripts/safari_zone.inc:31 SafariZone_EventScript_OutOfBalls
  outOfBalls(session?: any, game?: any): any {
    const cfg = rse_cfg(session_of(session));
    // pokeemerald/src/safari_zone.c:115
    if (cfg) return run_script(cfg.outOfBalls);
    return announce(
      RomText.ascii("SafariZone_Text_OutOfBalls"),
      session, game, () => { Safari.exitToEntrance(session, game); });
  },

  // Lua: safari.lua:306 -- pokefirered/src/safari_zone.c:41 SafariZoneTakeStep
  takeStep(sessionIn?: any, game?: any): boolean {
    const session = session_of(sessionIn);
    if (!Safari.isActive(session)) return false;
    const state = Safari.state(session);
    if (!state) return false;
    const cfg = rse_cfg(session);
    if (cfg) {
      // pokeemerald/src/safari_zone.c:75
      for (const [, f] of pairs<any>(state.feeders ?? {})) {
        if ((tonumber(f.stepCounter) ?? 0) > 0) f.stepCounter = f.stepCounter - 1;
      }
      state.steps = Math.max(0, (tonumber(state.steps) ?? 0) - 1);
      if (state.steps !== 0) return false;
      run_script(cfg.timesUp);
      return true;
    }
    let steps = (tonumber(state.steps) ?? 0) - 1;
    if (steps < 0) steps = 0;
    state.steps = steps;
    if (steps !== 0) return false;
    Safari.timesUp(session, game);
    return true;
  },

  // Lua: safari.lua:331 -- pokefirered/src/safari_zone.c:54 SafariZoneRetirePrompt
  retirePrompt(sessionIn?: any, gameIn?: any): any {
    const session = session_of(sessionIn);
    const game = game_of(gameIn);
    if (!Safari.isActive(session)) return false;
    const cfg = rse_cfg(session);
    // pokeemerald/src/safari_zone.c:92
    if (cfg) return run_script(cfg.retire);
    const Field: any = FieldMod;
    // pokefirered/data/text/safari_zone.inc:3 SafariZone_Text_WouldYouLikeToExit
    const ask = RomText.ascii("SafariZone_Text_WouldYouLikeToExit");
    const P = presenter();
    if (!(P && P.message && P.yesNo)) {
      Safari.exitToEntrance(session, game);
      return true;
    }
    if (Field) Field.locked = true;
    P.message(ask, () => {
      P.yesNo!((yes: boolean) => {
        if (Field) Field.locked = false;
        if (yes) {
          Safari.exitToEntrance(session, game);
        } else if (P.close) {
          P.close();
        }
      });
    });
    return true;
  },
};

export default Safari;
