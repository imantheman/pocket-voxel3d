// Port of gen1recomp src/core/game3/runtime.lua (GPLv3 + additional terms; see LICENSE.md).
// The Game3 field runtime: starts and stops the FRLG field session, pumps
// the playtime clock, and runs one field frame (fade, tasks, weather,
// battle, field, HUD) per fixed step.
//
// package.loaded probes: modules this runtime has (ported or stubbed) are
// imported and treated as loaded. A few of Brian's lazily required modules
// have no file here yet (tools/gen3/stubs.py follows `require` only); they
// are looked up in `G3Lazy` below, where a port registers itself, and read
// as absent until then -- see each use.
//
// Runtime.install is Brian's Kanto-Reforged mod mode (FireRed as a mod
// inside the Gen 2 engine: it hooks Gen 2's World:step / pollInput /
// interact, Game2:drawScene / openStartMenu and Screens.push). The 3DS runs
// Game3 standalone; NOT FAITHFUL: install only records the mod and listens
// for game.ready (there is no Gen 2 host to hook).

import { MapIds } from "./map_ids.ts";
import { Hud } from "../ui/hud.ts";
import { Stack } from "../ui/stack.ts";
import { Field } from "./field.ts";
import { Dataset } from "./dataset.ts";
import { Pokemon } from "./pokemon.ts";
import { PartyChrome } from "../ui/party_chrome.ts";
import { BattleChrome } from "../ui/battle_chrome.ts";
import { Map as G3Map } from "./map.ts";
import { Player } from "./player.ts";
import { Fade } from "../ui/fade.ts";
import { BattleTransition } from "./battle_transition.ts";
import { Task } from "./task.ts";
import { Audio } from "./audio.ts";
import { battle as Battle } from "./battle.ts";
import { Weather } from "./weather.ts";
import { Space } from "./scripting/space.ts";
import { Message } from "../ui/message.ts";
import { Seagallop } from "../ui/seagallop.ts";
import { Profile } from "./profile.ts";
import { Rtc } from "./rtc.ts";
import { TimeEvents } from "./time_events.ts";
import { Bridge } from "./bridge.ts";
import { Collision } from "./collision.ts";
import { Objects } from "./objects.ts";
import { format, tonumber, tostring } from "../../../import/gen3/lua.ts";
import { len } from "../platform/lt.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Brian's lazily required game3 modules with no file in this runtime yet,
 * by Lua module name: "src.core.game3.camera_object",
 * "src.core.game3.field_weather",
 * "src.core.game3.league_lighting", "src.core.game3.link" (link/init),
 * "src.core.game3.minigames.common", "src.ui.game3.link_menu",
 * "src.ui.game3.arena_state", "src.core.game3.truck_sequence". Their ports
 * register here (G3Lazy[name] = Module); until then they read as absent.
 */
import { G3Lazy } from "./lazy_registry.ts";
export { G3Lazy };

// Lua: runtime.lua:23
function log(msg: unknown): void {
  console.log("[game3] " + tostring(msg));
  const mod = Runtime._mod;
  if (mod && mod.log && mod.log.info) {
    mod.log.info("[game3] " + tostring(msg));
  }
}

// Lua: runtime.lua:151
function mark_host_game3(game: any, on: boolean): void {
  const world = game && (game.overworld || game.world);
  if (world) {
    world._game3FieldPause = on ? true : false;
  }
  if (game) {
    game._game3Active = on ? true : false;
  }
}

// Lua: runtime.lua:359
function current_map_id(game: any): any {
  const world = game && (game.overworld || game.world);
  if (world && world.map && world.map.id) return world.map.id;
  const pos = game && game.save && game.save.position;
  return pos ? pos.map : undefined;
}

// Lua: runtime.lua:366 -- [x, y, facing]
function player_xy(game: any): [any, any, any] {
  const P: any = Player;
  if (P && Runtime.active) {
    return [P.cellX, P.cellY, P.facing || "down"];
  }
  const world = game && (game.overworld || game.world);
  const p = world && world.player;
  if (p) {
    return [p.cellX ?? p.x, p.cellY ?? p.y, p.facing || "down"];
  }
  const pos = game && game.save && game.save.position;
  if (pos) return [pos.x, pos.y, pos.facing || "down"];
  return [0, 0, "down"];
}

function reset_camera_object(): void {
  // Lua: lazyReq("src.core.game3.camera_object").reset() -- NOT FAITHFUL until
  // camera_object has a module here: a missing module is skipped, not an error.
  const CameraObject = G3Lazy["src.core.game3.camera_object"];
  if (CameraObject && CameraObject.reset) CameraObject.reset();
}

export const Runtime: Record<string, any> = {
  active: false,
  session: undefined as any,
  _mod: undefined as any,
  _game: undefined as any,
  _fieldLocked: false,
  _playTimeAcc: 0,
  _deferred: undefined as ((() => void) | null)[] | undefined,
  _menuFocus: false,
  _vblankCounter: undefined as number | undefined,
  _ui: undefined as any,
  _installed: false,
  log,

  // Lua: runtime.lua:32
  isActive(): boolean {
    return Runtime.active === true;
  },

  // Lua: runtime.lua:36
  getSession(): any {
    return Runtime.session;
  },

  // Lua: runtime.lua:40
  defer(fn: unknown): boolean {
    if (typeof fn !== "function" || !Runtime.active) return false;
    let q = Runtime._deferred;
    if (!q) {
      q = [null];
      Runtime._deferred = q;
    }
    q[len(q) + 1] = fn as () => void;
    return true;
  },

  // Lua: runtime.lua:51
  drainDeferred(): number {
    const q = Runtime._deferred;
    if (!q) return 0;
    Runtime._deferred = undefined;
    const n = len(q);
    for (let i = 1; i <= n; i++) {
      try {
        q[i]!();
      } catch (e) {
        log("deferred call failed: " + tostring((e as Error)?.message ?? e));
      }
    }
    return len(q);
  },

  // Lua: runtime.lua:63 -- pokefirered/src/start_menu.c:1003
  fieldScreenOpen(menuOpenIn?: boolean): boolean {
    let menuOpen = menuOpenIn;
    if (menuOpen == null) {
      const H: any = Hud;
      menuOpen = H.isMenuOpen ? H.isMenuOpen() || false : false;
    }
    if (!menuOpen) return false;
    const S: any = Stack;
    if (S && S.depth && S.has && S.has("start")) {
      const depth = S.depth();
      // pokefirered/src/start_menu.c:577
      if (depth === 1 || (depth === 2 && S.has("save"))) {
        return false;
      }
    }
    return true;
  },

  // Lua: runtime.lua:81 -- pokefirered/src/overworld.c:1936
  noteFieldFocus(screenOpen: boolean): boolean {
    const was = Runtime._menuFocus === true;
    Runtime._menuFocus = screenOpen ? true : false;
    if (screenOpen && !was) {
      // pokefirered/src/start_menu.c:453
      const Lighting = G3Lazy["src.core.game3.league_lighting"];
      if (Lighting) Lighting.stop();
    }
    if (screenOpen || !was) return false;
    const B: any = Battle;
    if (B && B.isActive && B.isActive()) return false;
    const S: any = Space;
    if (!(S && S.active && S.vm)) return false;
    if (S.vm.isRunning && S.vm.isRunning()) return false;
    const iv = S._immediateVm;
    if (iv && iv.isRunning && iv.isRunning()) return false;
    try {
      return S.returnToField() === true;
    } catch {
      return false;
    }
  },

  // Lua: runtime.lua:101
  pumpRtc(game: any, dtIn?: unknown): void {
    const session = Runtime.session || (game && game.session);
    const save = game && game.save;
    if (!session && !save) return;
    const dt = tonumber(dtIn) ?? (1 / 60);

    let pt = (session && (session.playtime || session.playTime))
      || (save && (save.playTime || save.playtime));
    if (pt == null || typeof pt !== "object") {
      pt = { hours: 0, minutes: 0, seconds: 0, vblanks: 0 };
    }
    pt.hours = tonumber(pt.hours) ?? 0;
    pt.minutes = tonumber(pt.minutes) ?? 0;
    pt.seconds = tonumber(pt.seconds) ?? 0;
    pt.vblanks = tonumber(pt.vblanks) ?? 0;

    Runtime._playTimeAcc = (Runtime._playTimeAcc ?? 0) + dt;
    while (Runtime._playTimeAcc >= 1) {
      Runtime._playTimeAcc = Runtime._playTimeAcc - 1;
      pt.seconds = pt.seconds + 1;
      if (pt.seconds >= 60) {
        pt.seconds = 0;
        pt.minutes = pt.minutes + 1;
        if (pt.minutes >= 60) {
          pt.minutes = 0;
          pt.hours = Math.min(999, pt.hours + 1);
        }
      }
    }

    if (session) {
      session.playtime = pt;
      session.playTime = pt;
      session.playTimeHours = pt.hours;
      session.playTimeMinutes = pt.minutes;
      session.playTimeSeconds = pt.seconds;
      session.hours = pt.hours;
      session.minutes = pt.minutes;
      session.seconds = pt.seconds;
    }
    if (save) {
      save.playTime = pt;
      save.playtime = pt;
      save.playTimeHours = pt.hours;
      save.playTimeMinutes = pt.minutes;
      save.playTimeSeconds = pt.seconds;
    }
  },

  // Lua: runtime.lua:162 -- opts.alreadyOnMap skips the Map.load warp (save load / adopt)
  start(mod: any, game: any, session: any, optsIn?: any): void {
    const opts = optsIn || {};
    Runtime._mod = mod;
    Runtime._game = game;
    Runtime.session = session;
    Runtime.active = true;
    Runtime._deferred = undefined;
    Runtime._menuFocus = false;
    reset_camera_object();
    mark_host_game3(game, true);

    log(format(
      "ACTIVE engine=game3 map=%s pos=%s,%s reason=%s",
      tostring(session ? session.map : undefined),
      tostring(session ? session.x : undefined),
      tostring(session ? session.y : undefined),
      tostring(opts.reason || (opts.alreadyOnMap ? "adopt" : "enter"))));

    const F: any = Field;
    F.start(mod, game, session);

    const D: any = Dataset;
    const cache = (mod && mod.cache) || (D.cache && D.cache());
    {
      const P: any = Pokemon;
      if (P && P.install) P.install(cache);
    }
    {
      const PC: any = PartyChrome;
      if (PC && PC.install) PC.install(cache);
    }
    {
      const BC: any = BattleChrome;
      if (BC && BC.install) BC.install(cache);
    }

    if (opts.alreadyOnMap) {
      const M: any = G3Map;
      const P: any = Player;
      const def = game && game.data && game.data.maps && game.data.maps[session.map];
      M.current = session.map;
      M.loadNeighborsDepth1(game, def);

      // pokefirered/src/overworld.c:878 GetAdjustedInitialTransitionFlags
      const onCyclingRoad = P.isOnCyclingRoad && P.isOnCyclingRoad(session, P.cellX, P.cellY, def);
      const wasBiking = (P.biking === true) || (session && session.biking === true) || (game && game.save && game.save.biking === true);
      let keepBike = false;
      if (wasBiking || onCyclingRoad) {
        const allowed = def ? def.bikingAllowed : undefined;
        if (allowed != null) {
          keepBike = (tonumber(allowed) ?? 0) !== 0;
        } else {
          const pair = def && (def.pair || (def.midLayout && def.midLayout.pair));
          keepBike = typeof pair === "string" && pair.includes("outdoor");
        }
      }
      P.biking = keepBike;
      if (session) session.biking = keepBike;
      if (game && game.save) {
        game.save.biking = keepBike;
        if (game.save.position) game.save.position.biking = keepBike;
      }
      P.syncSavePosition(game);
      log("adopted existing game3 map (no re-warp)");
    } else {
      const M: any = G3Map;
      M.load(mod, game, session.map, {
        x: session.x,
        y: session.y,
        facing: session.facing,
        depth1Connections: true,
      });
      log("warped via game3 map loader \xE2\x86\x92 " + tostring(session.map));
    }
  },

  // Lua: runtime.lua:242
  stop(mod?: any, game?: any): void {
    log("INACTIVE leaving game3 field");
    const F: any = Field;
    F.stop();
    mark_host_game3(game || Runtime._game, false);
    Runtime.active = false;
    Runtime.session = undefined;
    Runtime._deferred = undefined;
    Runtime._menuFocus = false;
    try { reset_camera_object(); } catch { /* pcall */ }
    const S: any = Space;
    if (S && S.deactivate) {
      S.deactivate(mod || Runtime._mod);
    }
    Runtime._mod = undefined;
    Runtime._game = undefined;
  },

  // Lua: runtime.lua:261
  update(dt: number): void {
    if (!Runtime.active) return;
    const game = Runtime._game;
    const H: any = Hud;
    const inputTop = (Stack as any).top() || false;
    const inMenu = H.isMenuOpen ? H.isMenuOpen() || false : false;
    Runtime.drainDeferred();
    Runtime.noteFieldFocus(Runtime.fieldScreenOpen(inMenu));

    // pokefirered/src/field_control_avatar.c:94 FieldGetPlayerInput
    if (inMenu) {
      H.clearFieldInput();
    } else {
      H.sampleFieldInput(game);
    }

    if (!inMenu) {
      Runtime.pumpRtc(game, dt);
    }
    Runtime.tickVblank(Runtime.session, inMenu);

    {
      const Fd: any = Fade;
      if (Fd.tick) Fd.tick(dt);
    }
    {
      const SeagallopUi: any = Seagallop;
      if (SeagallopUi && SeagallopUi.isActive && SeagallopUi.isActive()) {
        SeagallopUi.update(dt);
      }
    }
    {
      const BT: any = BattleTransition;
      if (BT.isActive && BT.isActive()) {
        BT.tick(dt);
      }
    }
    {
      const T: any = Task;
      if (T.update) T.update(dt);
    }
    {
      const A: any = Audio;
      if (A.update) {
        // Cry tick is folded into Audio.update (called from Game3:fixedUpdate).
      } else if (A.tickCry) {
        A.tickCry(dt);
      }
    }
    {
      const FieldWeather = G3Lazy["src.core.game3.field_weather"];
      if (FieldWeather && FieldWeather.update) {
        FieldWeather.update(dt);
      }
    }

    const B: any = Battle;
    if (B.isActive()) {
      const W: any = Weather;
      W.suspend();
      B.update(dt, game);
      // Keep script VM + message typewriter alive while battle runs.
      const S: any = Space;
      if (S && S.vm) {
        const ad = S.vm.adapters;
        if (ad && ad.pollMovement) ad.pollMovement(0);
        S.vm.tick();
      }
      const Msg: any = Message;
      if (Msg && Msg.tick) Msg.tick();
      H.update(game, dt, inputTop);
      return;
    } else {
      const W: any = Weather;
      W.resume();
    }

    if (!inMenu) {
      const F: any = Field;
      F.update(dt);
    }
    H.update(game, dt, inputTop);
  },

  // Lua: runtime.lua:335 -- pokeemerald/src/main.c:349
  tickVblank(session: any, inMenu: boolean): number {
    if (!session || Profile.family(session) !== "rse") {
      return Runtime._vblankCounter ?? 0;
    }
    Runtime._vblankCounter = (Runtime._vblankCounter ?? 0) + 1;
    const R: any = Rtc;
    if (R.enabled(session)) {
      // pokeemerald/src/field_tasks.c:168
      const F: any = Field;
      if (!(F && F.locked) && !inMenu) {
        (TimeEvents as any).tick(session, Runtime._vblankCounter);
      }
    }
    return Runtime._vblankCounter!;
  },

  // Lua: runtime.lua:350
  uiBusy(): boolean {
    return (Hud as any).busy();
  },

  // Lua: runtime.lua:355
  setUi(stackTop: unknown): void {
    Runtime._ui = stackTop;
  },

  // Lua: runtime.lua:383 -- if save/load or a warp lands on a game3 map, adopt the Game3 session
  ensureActiveForMap(mod: any, game: any, mapId: any): boolean {
    if (!MapIds.isGame3Map(mapId)) {
      if (Runtime.active) {
        log("left game3 map=" + tostring(mapId) + " \xE2\x80\x94 tearing down");
        (Bridge as any).persistSessionOnly(mod, game);
        Runtime.stop(mod, game);
      } else {
        log("map=" + tostring(mapId) + " (not a game3 map)");
      }
      return false;
    }
    if (Runtime.active) {
      const session = Runtime.session;
      const world = game && (game.overworld || game.world);
      const p = world && world.player;
      const pos = game && game.save && game.save.position;
      let x: any, y: any, facing: any;
      if (p && ((pos && pos.map === mapId) || pos == null)) {
        x = tonumber(p.cellX ?? p.x) ?? 0;
        y = tonumber(p.cellY ?? p.y) ?? 0;
        facing = p.facing || "down";
      } else if (pos && pos.map === mapId) {
        x = tonumber(pos.x) ?? 0;
        y = tonumber(pos.y) ?? 0;
        facing = pos.facing || "down";
      } else {
        [x, y, facing] = player_xy(game);
      }
      if (session) {
        session.map = mapId;
        session.x = x;
        session.y = y;
        session.facing = facing;
      }
      const data = game && game.data && game.data.maps;
      const def = data && data[mapId];
      const M: any = G3Map;
      M.current = mapId;
      if (def) {
        const S: any = Space;
        if (S.ensureBundle) S.ensureBundle(mod);
        if (S.attachEventsToMaps) {
          S.attachEventsToMaps({ [mapId]: def }, S.bundle);
        }
        {
          const C: any = Collision;
          if (C && C.bindMap) C.bindMap(game, mapId, def);
        }
        {
          const O: any = Objects;
          if (O && O.loadMap) O.loadMap(game, mapId, def);
        }
        M.loadNeighborsDepth1(game, def);
      }
      const P: any = Player;
      if (P) {
        P.reset(x, y, facing);
        P.syncSavePosition(game);
      }
      log("already ACTIVE on " + tostring(mapId) + " (rebound objects)");
      return true;
    }
    log("bootstrapping game3 on Sevii map load: " + tostring(mapId));
    const [x, y, facing] = player_xy(game);
    (Bridge as any).enterFromHost(mod, game, {
      map: mapId,
      x,
      y,
      facing,
      alreadyOnMap: true,
      reason: "map_enter_or_load",
    });
    return true;
  },

  // Lua: runtime.lua:463 -- NOT FAITHFUL: no Gen 2 host to hook (see the header)
  install(mod: any): void {
    if (Runtime._installed) return;
    Runtime._installed = true;
    Runtime._mod = mod;
    log("Runtime.install \xE2\x80\x94 display ownership + START intercept + game.ready");
    if (mod && mod.events) {
      mod.events.on("game.ready", (game: any) => {
        Runtime._game = game;
        const mapId = current_map_id(game);
        log("game.ready map=" + tostring(mapId)
          + (MapIds.isGame3Map(mapId) ? " \xE2\x86\x92 ensure game3" : " \xE2\x86\x92 host"));
        if (MapIds.isGame3Map(mapId)) {
          Runtime.ensureActiveForMap(mod, game, mapId);
        }
      });
    }
  },
};

export default Runtime;
