// Port of gen1recomp src/core/game3/warp.lua (GPLv3 + additional terms; see LICENSE.md).
// Warp / door / fade sequencing helpers for game3 field.
//
// Lua's `package.loaded["src.X"]` / `pcall(require, "src.X")` / lazy
// `require("src.X")` all become the static imports below (every module is in
// the bundle); Brian's `X and X.f` guards are kept.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Runtime as ModRuntime } from "../shared/mods/Runtime.ts";
import { FieldModules } from "./field_modules.ts";
import { Dataset } from "./dataset.ts";
import { Runtime } from "./runtime.ts";
import { FieldMoves } from "./field_moves.ts";
import { Profile } from "./profile.ts";
import { MapCatalog } from "../../../import/gen3/map_catalog.ts";
import { MapPreviewExtract } from "../../../import/gen3/map_preview_extract.ts";
import { Player } from "./player.ts";
import { Map } from "./map.ts";
import { Collision } from "./collision.ts";
import { Fade } from "../ui/fade.ts";
import { MapPreviewScreen } from "../ui/map_preview_screen.ts";
import { CaveTransition } from "../ui/cave_transition.ts";
import { Field } from "./field.ts";
import { Space } from "./scripting/space.ts";
import { Flags } from "./scripting/flags.ts";
import { Doors } from "./doors.ts";
import { Audio } from "./audio.ts";
import { SE } from "./se_ids.ts";
import { Task } from "./task.ts";
import { SpecialFieldAnim as SpecialAnim } from "./special_field_anim.ts";
import { FieldEffects } from "./field_effects.ts";
import { MB } from "./mb.ts";
import { FieldView } from "./field_view.ts";
import { Weather } from "./weather.ts";
import { Dive } from "./dive.ts";
import { mod as lmod, tonumber, tostring, truthy } from "../../../import/gen3/lua.ts";
import { find } from "../platform/lpattern.ts";

type MapId = any;
type Done = () => void;

export interface PendingWarp {
  mapId: MapId;
  x: number;
  y: number;
  facing: string;
  fade: boolean;
}

export interface WarpRequestOpts {
  door?: any;
  exitDoor?: any;
  escalator?: any;
  teleport?: any;
  fall?: any;
  doorX?: number;
  doorY?: number;
  escalatorDir?: string;
  approachDir?: string;
  escX?: number;
  escY?: number;
  fade?: boolean;
  se?: any;
}

export interface FallOpts {
  prologue?: boolean;
}

export interface ScriptedSpec {
  se?: string;
  music?: boolean;
  fadeOut?: boolean;
  door?: boolean;
  spinOut?: boolean;
  spinIn?: boolean;
  arriveSe?: string;
  hidePlayer?: boolean;
  white?: boolean;
}

// Lua: warp.lua:11
function isBusy(): boolean {
  return Warp._busy === true;
}

// Lua: warp.lua:15
function sameDestination(map: MapId, x: any, y: any): [MapId, any, any] {
  return [map, x, y];
}

// Lua: warp.lua:17
function mapTypeOf(game: any, mapId: MapId): any {
  let def = game && game.data && game.data.maps && game.data.maps[mapId];
  if (!def) {
    // pcall(require, "src.core.game3.dataset"): static import
    def = Dataset && Dataset.map && Dataset.map(mapId);
  }
  return def && def.mapType;
}

// pokefirered/src/overworld.c:639 UpdateEscapeWarp
// Lua: warp.lua:27
function updateEscapeWarp(game: any, fromMap: MapId, destMap: MapId, srcX: any, srcY: any): boolean {
  // package.loaded["src.core.game3.runtime"]
  const session = Runtime && Runtime.getSession && Runtime.getSession();
  if (!truthy(session)) return false;
  const curMap = truthy(fromMap) ? fromMap : session.map;
  if (typeof curMap !== "string") return false;
  if (!FieldMoves.isOutdoors(mapTypeOf(game, curMap))) return false;
  if (FieldMoves.isOutdoors(mapTypeOf(game, destMap))) return false;
  let esc = Profile.forSession(session).map;
  esc = esc && esc.escapeWarp;
  if (!esc) {
    // pcall(require, "src.import.gba.map_catalog"): static import
    const forest = MapCatalog && MapCatalog.pretToEngine
      && MapCatalog.pretToEngine("ViridianForest");
    if (curMap === (truthy(forest) ? forest : "FR_VIRIDIAN_FOREST")) return false;
  }
  const x = tonumber(srcX), y = tonumber(srcY);
  if (x == null || y == null) return false;
  // package.loaded["src.core.game3.player"]
  let delta = (Player && Player.facing !== "down") ? 1 : 0;
  // pokeemerald/src/overworld.c:682
  if (esc) delta = esc.delta;
  // pokefirered/src/overworld.c:651 SetEscapeWarp
  session.escapeWarp = { map: curMap, warpId: 255, x, y: y + delta };
  return true;
}

// Lua: warp.lua:55
function announce(game: any, destMap: MapId, destX: number, destY: number, kind: string,
    srcX?: any, srcY?: any): [MapId, number, number] {
  // package.loaded["src.core.game3.map"]
  const fromMap = Map && Map.current;
  const warp = { kind, map: destMap, x: destX, y: destY };
  if (ModRuntime.wantsHook("warp.destination")) {
    // ModRuntime.call returns the hook's (or sameDestination's) values as a tuple.
    const [m, nx, ny] = ModRuntime.call("warp.destination", sameDestination, destMap, destX, destY,
      { warp, lastMap: fromMap, data: game && game.data });
    if (truthy(m)) {
      destMap = m;
      destX = tonumber(nx) ?? destX;
      destY = tonumber(ny) ?? destY;
    }
  }
  if (ModRuntime.wants("player.warped")) {
    ModRuntime.emit("player.warped", { fromMap, toMap: destMap,
      x: destX, y: destY, warp });
  }
  // pokefirered/src/field_control_avatar.c:982 SetupWarp
  updateEscapeWarp(game, fromMap, destMap, srcX, srcY);
  // package.loaded["src.core.game3.collision"]
  if (Collision && Collision.noteDynamicWarpEntry) {
    Collision.noteDynamicWarpEntry(game, destMap, destX, destY, srcX, srcY);
  }
  return [destMap, destX, destY];
}

/// WarpFadeOutScreen / WarpFadeInScreen (pokefirered/src/field_fadetransition.c:95
/// and :54). Every warp-out in pret routes through WarpFadeOutScreen, so the
/// colour rule is shared: a changed map section whose destination owns a cave
/// preview screen forces black, otherwise MapTransitionIsEnter decides, which is
/// true only when a warp drops the player into a MAP_TYPE_UNDERGROUND map from
/// somewhere above ground (fldeff_flash.c sTransitionTypes). The fade-in mirrors
/// it with MapTransitionIsExit, true only when leaving MAP_TYPE_UNDERGROUND.
/// Fade is passed in because warp.lua loads src.ui.game3.fade lazily per sequence.
// Lua: warp.lua:87
const MAP_TYPE_UNDERGROUND = 4;

// Lua: warp.lua:89
function sectionAndType(game: any, mapId: MapId): [number | undefined, number] {
  const def = game && game.data && game.data.maps && game.data.maps[mapId];
  if (!def) return [undefined, 0];
  return [tonumber(def.regionMapSectionId), tonumber(def.mapType) ?? 0];
}

// Lua: warp.lua:95
function warpFadeModes(Fade: any, game: any, destMap: MapId): [number, number] {
  const MODE = (Fade && Fade.MODE) || {};
  const toBlack = MODE.TO_BLACK ?? 1, toWhite = MODE.TO_WHITE ?? 3;
  const fromBlack = MODE.FROM_BLACK ?? 0, fromWhite = MODE.FROM_WHITE ?? 2;
  // package.loaded["src.core.game3.map"]
  const [fromSec, fromType] = sectionAndType(game, Map && Map.current);
  const [toSec, toType] = sectionAndType(game, destMap);
  if (fromSec != null && toSec != null && fromSec !== toSec && FieldModules.enabled("mapPreview")) {
    // pcall(require, "src.ui.game3.map_preview_screen"): static import
    if (MapPreviewScreen && MapPreviewScreen.has) {
      // pcall(require, "src.import.gba.map_preview_extract"): static import
      if (MapPreviewExtract && truthy(MapPreviewScreen.has(toSec, MapPreviewExtract.TYPE_CAVE))) {
        return [toBlack, fromBlack];
      }
    }
  }
  const enter = fromType !== toType && toType === MAP_TYPE_UNDERGROUND;
  const exit = fromType !== toType && fromType === MAP_TYPE_UNDERGROUND;
  return [(enter ? toWhite : toBlack), (exit ? fromWhite : fromBlack)];
}

// src/fldeff_flash.c:237
// Lua: warp.lua:118
function mapTransition(game: any, destMap: MapId, load: Done): void {
  const cont = (): void => {
    load();
    // src/map_preview_screen.c:439
    // package.loaded["src.ui.game3.map_preview_screen"], package.loaded["src.core.game3.field"]
    if (MapPreviewScreen && truthy(MapPreviewScreen.isForestActive()) && Field && Field.lock) {
      Field.lock();
    }
  };
  // package.loaded["src.core.game3.map"]
  const [fromSec, fromType] = sectionAndType(game, Map && Map.current);
  const [toSec, toType] = sectionAndType(game, destMap);
  const preview = FieldModules.enabled("mapPreview");
  // Lua requires map_preview_screen / map_preview_extract only when preview is
  // on; the static imports are gated by `preview` the same way.
  if (preview && fromSec != null && toSec != null && fromSec !== toSec
      && truthy(MapPreviewScreen.has(toSec, MapPreviewExtract.TYPE_CAVE))
      && truthy(MapPreviewScreen.runCave(toSec, cont))) {
    Fade.clear();
    return;
  }
  // src/fldeff_flash.c:41
  if (fromType !== toType && fromType !== 0 && toType !== 0
      && (toType === MAP_TYPE_UNDERGROUND || fromType === MAP_TYPE_UNDERGROUND)) {
    Fade.clear();
    CaveTransition.start(
      toType === MAP_TYPE_UNDERGROUND ? "enter" : "exit", cont);
    return;
  }
  cont();
}

// src/field_fadetransition.c:451
// Lua: warp.lua:153
function releaseField(Field: any): void {
  // package.loaded["src.core.game3.scripting.space"]
  if (Space && Space.vm && Space.vm.isRunning && truthy(Space.vm.isRunning())) return;
  // package.loaded["src.ui.game3.map_preview_screen"]
  if (MapPreviewScreen && MapPreviewScreen.isForestActive && truthy(MapPreviewScreen.isForestActive())) {
    return;
  }
  if (Field && Field.unlock) Field.unlock();
}

/// Complete door entrance sequence (walking UP into a building)
// Lua: warp.lua:165
function startDoorEntrance(mod: any, game: any, destMap: MapId, destX: number, destY: number,
    doorX: number, doorY: number): boolean {
  if (Warp._busy) return false;
  [destMap, destX, destY] = announce(game, destMap, destX, destY, "door", doorX, doorY);
  Warp._busy = true;

  if (Field && Field.lock) Field.lock();

  const curMap = (game ? game.currentMap : undefined) ?? destMap;
  // Lua `local sound = Doors.getSoundForWarp(...)` keeps the first of [sound, kind].
  const sound = Doors.getSoundForWarp(curMap, doorX, doorY, destMap, true)[0];
  const [toMode, fromMode] = warpFadeModes(Fade, game, destMap);

  // Step 1: Animate door open (Frame 0 -> 1 -> 2)
  Doors.open(curMap, doorX, doorY, { sound, destMap }, () => {
    // Step 2: Door is fully open. Walk player 1 step UP into the doorway.
    Player.forceStep("up", () => {
      // Step 3: Player arrived at (doorX, doorY). Immediately hide player sprite!
      Player.setVisible(false);

      // Step 4: Short beat, then door animates closed (Frame 2 -> 1 -> 0)
      Doors.closeAfterDelay(curMap, doorX, doorY, 8, { sound, playSound: false }, () => {
        // Step 5: Screen fades to black
        Fade.begin(toMode, 1, () => {
          Warp.mapTransition(game, destMap, () => {
            // Step 6: Inside black, load the indoor map
            Map.load(mod, game, destMap, {
              x: destX,
              y: destY,
              facing: "up",
              depth1Connections: true,
            });
            Player.setVisible(true);
            Doors.reset();

            // Step 7: Fade screen back in from black inside the building
            Fade.begin(fromMode, 1, () => {
              Warp._busy = false;
              releaseField(Field);
            });
          });
        });
      });
    });
  });
  return true;
}

// Lua: warp.lua:214 (`local warpExitArrival`: the function is defined at :873)

/// Complete door exit sequence (walking DOWN off exit mat out to town)
// Lua: warp.lua:217
function startDoorExit(mod: any, game: any, destMap: MapId, destX: number, destY: number,
    exitX: number, exitY: number): boolean {
  if (Warp._busy) return false;
  [destMap, destX, destY] = announce(game, destMap, destX, destY, "exit_door", exitX, exitY);
  Warp._busy = true;

  if (Field && Field.lock) Field.lock();

  const [toMode, fromMode] = warpFadeModes(Fade, game, destMap);

  // Step 1: Play exit sound (SE_EXIT)
  if (Audio && Audio.playSe) {
    try { Audio.playSe(Doors.SOUND_EXIT); } catch { /* pcall */ }
  }

  // Step 2: Screen fades to black
  Fade.begin(toMode, 1, () => {
    Warp.mapTransition(game, destMap, () => {
      Map.load(mod, game, destMap, {
        x: destX,
        y: destY,
        facing: "down",
        depth1Connections: true,
      });
      Player.setVisible(true);
      Doors.reset();
      // pokefirered/src/field_fadetransition.c:242
      warpExitArrival(game, destMap, destX, destY, fromMode, () => {
        Warp._busy = false;
        releaseField(Field);
      });
    });
  });
  return true;
}

/// Complete escalator warp sequence (PokéCenter 2F, Celadon Dept Store)
// Lua: warp.lua:257
function isEscalatorActive(): boolean {
  return Warp._isEscalatorActive ? true : false;
}

// Lua: warp.lua:261
function startEscalator(mod: any, game: any, destMap: MapId, destX: number, destY: number,
    dir: string | undefined, approachDir: string | undefined, escX?: number, escY?: number): boolean {
  if (Warp._busy) return false;
  [destMap, destX, destY] = announce(game, destMap, destX, destY, "escalator", escX, escY);
  Warp._busy = true;
  Warp._isEscalatorActive = true;

  if (Field && Field.lock) Field.lock();

  const goingUp = (dir !== "down");
  const [toMode, fromMode] = warpFadeModes(Fade, game, destMap);

  // GBA pret trig offsets for escalator (field_effect.c)
  const getOffsets = (amp: number, isGoingUp: boolean, isLanding: boolean): [number, number] => {
    const x = -amp;
    let y = 0;
    if (isGoingUp) {
      if (!isLanding) {
        // Going UP departing (1F): moves left & UP into ceiling (0 -> -8)
        y = -Math.floor(amp * 8 / 16);
      } else {
        // Going UP arriving (2F): starts below floor (+8) and glides right & UP into floor (+8 -> 0)
        y = Math.floor(amp * 8 / 16);
      }
    } else {
      if (!isLanding) {
        // Going DOWN departing (2F): moves left & DOWN into lower floor (0 -> +8)
        y = Math.floor(amp * 8 / 16);
      } else {
        // Going DOWN arriving (1F): starts above floor (-8) and glides right & DOWN into floor (-8 -> 0)
        y = -Math.floor(amp * 8 / 16);
      }
    }
    return [x, y];
  };

  const doWarpIn = (): void => {
    // Destination map loaded at (destX, destY)
    Player.facing = "right";
    Player.setVisible(true);

    // Initial position: 16px to the left on destination escalator
    const [initX, initY] = getOffsets(16, goingUp, true);
    Player.spriteXOffset = initX;
    Player.spriteYOffset = initY;

    const destLayout = Map._def && Map._def.midLayout;
    SpecialAnim.startEscalator(destLayout, destX, destY, goingUp);

    Fade.begin(fromMode, 1, () => {});

    Task.spawn((t: any): boolean => {
      // 16 amp steps over 32 frames (every 2 frames advances 1 amp)
      const amp = Math.max(0, 16 - Math.floor(t.frames / 2));
      const [xOff, yOff] = getOffsets(amp, goingUp, true);
      Player.spriteXOffset = xOff;
      Player.spriteYOffset = yOff;

      if (amp <= 0) {
        Player.spriteXOffset = 0;
        Player.spriteYOffset = 0;
        SpecialAnim.stopEscalator();

        // In FRLG: Player takes 1 normal walk step EAST (DIR_EAST) off the escalator
        Player.forceStep("right", () => {
          Warp._busy = false;
          Warp._isEscalatorActive = false;
          releaseField(Field);
        });
        return true;
      }
      return false;
    });
  };

  const doRideAndTransition = (): void => {
    if (Audio && Audio.playSe) {
      try { Audio.playSe(SE.SE_ESCALATOR ?? 73); } catch { /* pcall */ }
    }

    // Keep current facing while riding out
    Player.facing = approachDir ?? "left";

    const curLayout = Map._def && Map._def.midLayout;
    SpecialAnim.startEscalator(curLayout, Player.cellX, Player.cellY, goingUp);

    let fadeStarted = false;
    let fadeDone = false;

    Task.spawn((t: any): boolean => {
      // 16 amp steps over 32 frames (every 2 frames advances 1 amp)
      const amp = Math.min(16, Math.floor(t.frames / 2));
      const [xOff, yOff] = getOffsets(amp, goingUp, false);
      Player.spriteXOffset = xOff;
      Player.spriteYOffset = yOff;

      // In FRLG: when task->data[2] > 3 (after ~8 frames), begin fade out
      if (t.frames >= 8 && !fadeStarted) {
        fadeStarted = true;
        Fade.begin(toMode, 1, () => {
          fadeDone = true;
        });
      }

      if (amp >= 16 && fadeDone) {
        SpecialAnim.stopEscalator();
        Player.spriteXOffset = 0;
        Player.spriteYOffset = 0;

        Warp.mapTransition(game, destMap, () => {
          Map.load(mod, game, destMap, {
            x: destX,
            y: destY,
            facing: "right",
            depth1Connections: true,
          });

          doWarpIn();
        });
        return true;
      }
      return false;
    });
  };

  // If player is standing adjacent to the escalator, step onto it first
  if (approachDir != null && (Player.cellX !== escX || Player.cellY !== escY)) {
    Player.forceStep(approachDir, () => {
      doRideAndTransition();
    });
  } else {
    doRideAndTransition();
  }

  return true;
}

// pokefirered/src/field_fadetransition.c:922
// Lua: warp.lua:407
function exitStairsArrival(game: any, destX: number, destY: number, fromMode: number, finish: Done): void {
  const destBeh = Collision.behavior(destX, destY);
  const facing = Collision.stairArrivalFacing(destBeh);
  if (facing != null) {
    Player.facing = facing;
    Player.syncSavePosition(game);
  }
  let [speedX, speedY] = Collision.stairSpeeds(destBeh) as [number, number];
  let offX = speedX * 16, offY = speedY * 16;
  let timer = 16;
  speedX = -speedX;
  speedY = -speedY;
  Player.walkInPlace = true;
  Player.walkInPlaceFast = true;
  Player.spriteXOffset = Math.floor(offX / 32);
  Player.spriteYOffset = Math.floor(offY / 32);

  Fade.begin(fromMode, 1, () => {});

  Task.spawn((): boolean => {
    if (timer > 0) {
      offX = offX + speedX;
      offY = offY + speedY;
      Player.spriteXOffset = Math.floor(offX / 32);
      Player.spriteYOffset = Math.floor(offY / 32);
      timer = timer - 1;
      return false;
    }
    Player.spriteXOffset = 0;
    Player.spriteYOffset = 0;
    Player.walkInPlace = false;
    Player.walkInPlaceFast = false;
    finish();
    return true;
  });
}

// pokefirered/src/field_fadetransition.c:794
// Lua: warp.lua:448
function startStairWarp(mod: any, game: any, destMap: MapId, destX: number, destY: number,
    behavior: any): boolean {
  if (Warp._busy) return false;
  [destMap, destX, destY] = announce(game, destMap, destX, destY, "stairs");
  Warp._busy = true;

  if (Field && Field.lock) Field.lock();

  const [toMode, fromMode] = warpFadeModes(Fade, game, destMap);

  const finish = (): void => {
    Warp._busy = false;
    releaseField(Field);
  };

  const exitStairs = (): void => {
    exitStairsArrival(game, destX, destY, fromMode, finish);
  };

  const [speedX, speedY] = Collision.stairSpeeds(behavior) as [number, number];
  let offX = 0, offY = 0, timer = 0;
  let fadeStarted = false, fadeDone = false;

  if (Audio && Audio.playSe) {
    try { Audio.playSe(SE.SE_EXIT ?? 9); } catch { /* pcall */ }
  }
  Player.walkInPlace = true;
  Player.walkInPlaceFast = false;

  // pokefirered/src/field_fadetransition.c:846
  Task.spawn((): boolean => {
    if (speedY > 0 || timer > 6) offY = offY + speedY;
    offX = offX + speedX;
    timer = timer + 1;
    Player.spriteXOffset = Math.floor(offX / 32);
    Player.spriteYOffset = Math.floor(offY / 32);

    if (timer >= 12 && !fadeStarted) {
      fadeStarted = true;
      Fade.begin(toMode, 1, () => { fadeDone = true; });
    }

    if (fadeDone) {
      Player.spriteXOffset = 0;
      Player.spriteYOffset = 0;
      Player.walkInPlace = false;
      Warp.mapTransition(game, destMap, () => {
        Map.load(mod, game, destMap, {
          x: destX,
          y: destY,
          facing: Player.facing,
          depth1Connections: true,
        });
        Player.setVisible(true);
        exitStairs();
      });
      return true;
    }
    return false;
  });

  return true;
}

/// Complete teleport spin sequence (Silph Co, Sabrina's Gym warp pads)
// Lua: warp.lua:520
function startTeleport(mod: any, game: any, destMap: MapId, destX: number, destY: number,
    srcX?: any, srcY?: any): boolean {
  if (Warp._busy) return false;
  if (Warp.rseStepWarp) {
    const special = Warp.rseStepWarp(mod, game, destMap, destX, destY, srcX, srcY);
    if (special != null) return special;
  }
  [destMap, destX, destY] = announce(game, destMap, destX, destY, "teleport", srcX, srcY);
  Warp._busy = true;

  if (Field && Field.lock) Field.lock();

  if (Audio && Audio.playSe) {
    try { Audio.playSe(SE.SE_WARP_IN ?? 39); } catch { /* pcall */ }
  }

  const [toMode, fromMode] = warpFadeModes(Fade, game, destMap);

  Fade.begin(toMode, 1, () => {
    Warp.mapTransition(game, destMap, () => {
      Map.load(mod, game, destMap, {
        x: destX,
        y: destY,
        facing: "down",
        depth1Connections: true,
      });
      Player.setVisible(true);

      if (Audio && Audio.playSe) {
        try { Audio.playSe(SE.SE_WARP_OUT ?? 40); } catch { /* pcall */ }
      }

      Fade.begin(fromMode, 1, () => {
        Warp._busy = false;
        releaseField(Field);
      });
    });
  });
  return true;
}

// pokefirered/src/field_effect.c:2134 sSpinDirections
// Lua: warp.lua:566
const SPIN_NEXT: Record<string, string> = { down: "left", up: "right", left: "up", right: "down" };

interface SpinState { delay: number; turns: number }

// pokefirered/src/field_effect.c:2143 SpinObjectEvent
// Lua: warp.lua:569
function spinStep(Player: any, s: SpinState): string {
  if (s.delay !== 0) {
    s.delay = s.delay - 1;
    if (s.delay !== 0) return Player.facing;
  }
  Player.facing = SPIN_NEXT[Player.facing] ?? "down";
  if (s.turns < 12) s.turns = s.turns + 1;
  s.delay = 12 >>> s.turns;
  return Player.facing;
}

// pokefirered/src/field_effect.c:2086 StartEscapeRopeFieldEffect
// Lua: warp.lua:581
function startEscapeRope(game: any, destMap: MapId, destX: number, destY: number,
    load: (m: MapId, x: number, y: number) => void): boolean {
  if (Warp._busy) return false;
  [destMap, destX, destY] = announce(game, destMap, destX, destY, "escape_rope");
  Warp._busy = true;

  if (Field && Field.lock) Field.lock();

  const [toMode, fromMode] = warpFadeModes(Fade, game, destMap);

  const warpIn = (): void => {
    const spin: SpinState = { delay: 0, turns: 0 };
    let timer = 0, offY = -88, moving = true, spinEnded = false;
    const originalDir = Player.facing;
    let dir = originalDir;
    Player.spriteYOffset = offY;
    // pokefirered/src/field_effect.c:2290 EscapeRopeWarpInEffect_Init
    Audio.playSe(SE.SE_WARP_OUT);
    Task.spawn((): boolean => {
      // pokefirered/src/field_effect.c:2223 WarpInObjectEventDownwards
      if (moving) {
        offY = offY + 4;
        if (offY >= 0) {
          offY = 0;
          moving = false;
          Audio.playSe(SE.SE_CLICK);
        }
        Player.spriteYOffset = offY;
      }
      Player.setVisible(true);
      if (timer < 8) {
        timer = timer + 1;
      } else if (!spinEnded) {
        timer = timer + 1;
        dir = spinStep(Player, spin);
        if (timer >= 50 && dir === originalDir) spinEnded = true;
      }
      if (!moving && dir === originalDir) {
        Player.spriteYOffset = 0;
        Warp._busy = false;
        releaseField(Field);
        return true;
      }
      return false;
    });
  };

  // pokefirered/src/field_effect.c:2106 EscapeRopeWarpOutEffect_Spin
  const spin: SpinState = { delay: 0, turns: 0 };
  let timer = 0, offY = 0, offscreen = false, faded = false;
  Task.spawn((): boolean => {
    spinStep(Player, spin);
    if (timer < 60) {
      timer = timer + 1;
      if (timer === 20) Audio.playSe(SE.SE_WARP_IN);
    } else if (!offscreen) {
      // pokefirered/src/field_effect.c:2158 WarpOutObjectEventUpwards
      offY = offY - 8;
      Player.spriteYOffset = offY;
      if (offY <= -88) {
        offscreen = true;
        Fade.begin(toMode, 1, () => { faded = true; });
      }
    }
    if (!faded) return false;
    Player.spriteYOffset = 0;
    Warp.mapTransition(game, destMap, () => {
      load(destMap, destX, destY);
      // pokefirered/src/field_effect.c:2269 FieldCallback_EscapeRopeExit
      Player.setVisible(false);
      Fade.begin(fromMode, 1, warpIn);
    });
    return true;
  });
  return true;
}

// pokefirered/src/overworld.c:898 MetatileBehavior_IsSurfableInSeafoamIslands
// Lua: warp.lua:664
function seafoamSurfLanding(destMap: MapId, x: number, y: number): boolean {
  const up = tostring(truthy(destMap) ? destMap : "").toUpperCase();
  if (!(find(up, "SEAFOAM_ISLANDS_B3F") != null || find(up, "SEAFOAM_ISLANDS_B4F") != null)) {
    return false;
  }
  return Collision.isSurfable != null
    && Collision.isSurfable(Collision.behavior(x, y)) === true;
}

// pokefirered/src/field_effect.c:1285
// Lua: warp.lua:675
function seafoamSurfArrival(Player: any): void {
  Flags.setVar(Space.store, undefined, "VAR_TEMP_1", 1);
  Player.surfing = true;
}

// pokefirered/src/field_effect.c:1200
// Lua: warp.lua:683
const FALL_START_Y = -112;

/// Complete fall hole sequence (Mt. Moon, Seafoam drop holes)
// pokefirered/data/scripts/hole.inc:23 EventScript_DoFallWarp
// Lua: warp.lua:687
function startFall(mod: any, game: any, destMap: MapId, destX: number, destY: number,
    srcX?: any, srcY?: any, opts?: FallOpts): boolean {
  if (Warp._busy) return false;
  opts = opts ?? {};
  [destMap, destX, destY] = announce(game, destMap, destX, destY, "fall", srcX, srcY);
  Warp._busy = true;

  if (Field && Field.lock) Field.lock();
  // pokefirered/src/field_effect.c:1155 FieldCB_FallWarpExit
  if (Field) Field._fallWarp = true;

  const [toMode, fromMode] = warpFadeModes(Fade, game, destMap);

  const playSe = (id: any): void => {
    if (Audio && Audio.playSe) {
      try { Audio.playSe(id); } catch { /* pcall */ }
    }
  };

  const finish = (): void => {
    Warp._busy = false;
    // pokefirered/src/field_effect.c:1274 FallWarpEffect_7
    if (Field) Field._fallWarp = false;
    releaseField(Field);
  };

  // pokefirered/src/field_effect.c:1215 FallWarpEffect_4
  const dropIn = (): void => {
    let y2 = FALL_START_Y;
    let speed = 1, travelled = 0;
    Player.facing = "down";
    Player.spriteYOffset = y2;
    Player.setVisible(true);
    playSe(SE.SE_FALL ?? 37);
    Task.spawn((): boolean => {
      y2 = y2 + speed;
      if (speed < 8) {
        travelled = travelled + speed;
        if (lmod(travelled, 16) !== 0) speed = speed * 2;
      }
      if (y2 >= 0) {
        Player.spriteYOffset = 0;
        playSe(SE.SE_M_STRENGTH ?? 207);
        // pokefirered/src/field_effect.c:1249 FallWarpEffect_5
        FieldEffects.startLandingShake(finish);
        if (seafoamSurfLanding(destMap, destX, destY)) {
          seafoamSurfArrival(Player);
        }
        Player.syncSavePosition(game);
        return true;
      }
      Player.spriteYOffset = y2;
      return false;
    });
  };

  // pokefirered/data/scripts/hole.inc:24
  // pokefirered/src/scrcmd.c:773
  const prologue = opts.prologue !== false;
  Task.spawn((t: any): boolean => {
    if (prologue && t.frames === 20) {
      Player.setVisible(false);
      playSe(SE.SE_FALL ?? 37);
    }
    if (prologue && t.frames < 80) return false;
    Fade.begin(toMode, 1, () => {
      Warp.mapTransition(game, destMap, () => {
        Map.load(mod, game, destMap, {
          x: destX,
          y: destY,
          facing: "down",
          depth1Connections: true,
        });
        Player.setVisible(false);
        Player.spriteYOffset = FALL_START_Y;
        Fade.begin(fromMode, 1, () => {
          dropIn();
        });
      });
    });
    return true;
  });
  return true;
}

// Lua: warp.lua:777
const PLAYER_SCREEN_Y = 72;

interface RotState { rot: number }

// pokefirered/src/field_player_avatar.c:2143
// Lua: warp.lua:780
function teleportRotate(Player: any, s: RotState): string {
  if (s.rot < 8) {
    s.rot = s.rot + 1;
    if (s.rot < 8) return Player.facing;
  }
  Player.facing = SPIN_NEXT[Player.facing] ?? "down";
  s.rot = 0;
  return Player.facing;
}

// pokefirered/src/field_player_avatar.c:2030
// Lua: warp.lua:791
function teleportWarpOutAnim(Player: any, onDone: Done): void {
  const s: RotState = { rot: 0 };
  let deltaY = 1, ydef = PLAYER_SCREEN_Y * 16;
  Task.spawn((): boolean => {
    teleportRotate(Player, s);
    ydef = ydef - deltaY;
    deltaY = deltaY + 3;
    const y = Math.floor(ydef / 16);
    Player.spriteYOffset = y - PLAYER_SCREEN_Y;
    if (y < -32) {
      onDone();
      return true;
    }
    return false;
  });
}

// pokefirered/src/field_player_avatar.c:2082
// Lua: warp.lua:810
function teleportWarpInAnim(Player: any, finalFacing: string, onDone: Done): void {
  const s: RotState = { rot: 0 };
  let state = 1, landing = 0;
  let deltaY = 116, ydef = -32 * 16;
  Player.facing = SPIN_NEXT[finalFacing] ?? "left";
  Player.spriteYOffset = Math.floor(ydef / 16) - PLAYER_SCREEN_Y;
  Player.setVisible(true);
  Task.spawn((): boolean => {
    if (state === 1) {
      teleportRotate(Player, s);
      ydef = ydef + deltaY;
      deltaY = Math.max(4, deltaY - 3);
      const y = Math.floor(ydef / 16);
      if (y >= PLAYER_SCREEN_Y) {
        Player.spriteYOffset = 0;
        state = 2;
      } else {
        Player.spriteYOffset = y - PLAYER_SCREEN_Y;
      }
    } else if (state === 2) {
      teleportRotate(Player, s);
      landing = landing + 1;
      if (landing > 8) state = 3;
    } else if (teleportRotate(Player, s) === finalFacing) {
      onDone();
      return true;
    }
    return false;
  });
}

// Lua: warp.lua:842
function mapMusicOf(game: any, mapId: MapId): number | undefined {
  const def = game && game.data && game.data.maps && game.data.maps[mapId];
  let music = def ? def.music : undefined;
  if (!truthy(music)) {
    // package.loaded["src.core.game3.audio"]
    const idx = Audio && Audio._pack && Audio._pack.index && Audio._pack.index.mapSongs;
    music = idx ? idx[mapId] : undefined;
  }
  return tonumber(music);
}

// pokefirered/src/overworld.c:1112
// Lua: warp.lua:854
function tryFadeOutOldMapMusic(game: any, destMap: MapId, destX: number, destY: number): number {
  // package.loaded["src.core.game3.scripting.space"]
  if (Space && truthy(Flags.getFlag(Space.store, undefined, "FLAG_DONT_TRANSITION_MUSIC"))) return 0;
  const rseFrames = Audio.tryFadeOutOldMapMusic && Audio.tryFadeOutOldMapMusic(destMap, destX, destY);
  if (truthy(rseFrames)) return rseFrames;
  // pokefirered/src/sound.c:124
  let cur = 0;
  if (!truthy(Audio._fadeOut) && truthy(Audio._currentSong)) cur = tonumber(Audio._currentSong.id) ?? 0;
  if (mapMusicOf(game, destMap) === cur) return 0;
  // pokefirered/src/overworld.c:1103
  const mt = tonumber(mapTypeOf(game, destMap)) ?? 0;
  const speed = (mt === 8 || mt === 9) ? 2 : 4;
  if (!(Audio && Audio.fadeOutBgm)) return 0;
  Audio.fadeOutBgm(speed);
  return 16 * speed;
}

// pokefirered/src/field_fadetransition.c:242
// Lua: warp.lua:873
function warpExitArrival(game: any, destMap: MapId, x: number, y: number, fromMode: number,
    finish: Done): void {
  const beh = Collision.behavior(x, y);
  if (truthy(Collision.isWarpDoor(beh))) {
    // pokefirered/src/field_fadetransition.c:335
    Player.facing = "down";
    Player.setVisible(false);
    Fade.begin(fromMode, 4, () => {});
    let t = 0, stepT: number | undefined = undefined, stepDone = false, closed = false;
    Task.spawn((): boolean => {
      t = t + 1;
      if (t === 25) {
        Doors.open(destMap, x, y, {}, () => {
          Player.setVisible(true);
          stepT = 0;
          if (!Player.forceStep("down", () => { stepDone = true; })) stepDone = true;
        });
      }
      if (stepT != null) {
        stepT = stepT + 1;
        // pokefirered/src/field_fadetransition.c:363
        if (stepT === 14) {
          Doors.close(destMap, x, y, { playSound: false }, () => { closed = true; });
        }
      }
      if (closed && stepDone && !Fade.isActive()) {
        finish();
        return true;
      }
      return false;
    });
    return;
  }
  if (truthy(Collision.isNonAnimDoor(beh))) {
    // pokefirered/src/field_fadetransition.c:405
    Player.setVisible(false);
    Fade.begin(fromMode, 1, () => {
      Player.setVisible(true);
      if (!Player.forceStep(Player.facing, finish)) finish();
    });
    return;
  }
  if (truthy(Collision.stairArrivalFacing(beh))) {
    exitStairsArrival(game, x, y, fromMode, finish);
    return;
  }
  // pokefirered/src/field_fadetransition.c:441
  Fade.begin(fromMode, 1, finish);
}

// pokefirered/src/scrcmd.c:719
// Lua: warp.lua:928
const SCRIPTED_KINDS: Record<string, ScriptedSpec> = {
  // pokefirered/src/field_fadetransition.c:535
  warp: { se: "SE_EXIT", music: true, fadeOut: true },
  // pokefirered/src/field_fadetransition.c:546
  warpsilent: { music: true, fadeOut: true },
  // pokefirered/src/field_fadetransition.c:564
  warpdoor: { door: true, music: true, fadeOut: true },
  // pokefirered/src/field_fadetransition.c:609
  warpteleport: { spinOut: true, music: true, fadeOut: true, spinIn: true },
  // pokefirered/src/field_fadetransition.c:571
  warpspinenter: { spinIn: true },
  // pokefirered/src/seagallop.c:316
  seagallop: { fadeOut: true },
  // pokeemerald/src/field_screen_effect.c:549 DoTeleportTileWarp
  rse_teleport_tile: { se: "SE_WARP_IN", music: true, fadeOut: true, spinIn: true },
  // pokeemerald/src/field_screen_effect.c:559 DoMossdeepGymWarp
  rse_mossdeep_gym: { se: "SE_WARP_IN", music: true, fadeOut: true, arriveSe: "SE_WARP_OUT" },
  // pokeemerald/src/field_screen_effect.c:1064 DoSpinExitWarp
  rse_spin_exit: { spinOut: true, music: true, fadeOut: true },
  // pokeemerald/src/field_screen_effect.c:571 DoPortholeWarp
  rse_porthole_enter: { fadeOut: true, hidePlayer: true },
  // pokeemerald/src/scrcmd.c:823
  warpmossdeepgym: { se: "SE_WARP_IN", music: true, fadeOut: true, arriveSe: "SE_WARP_OUT" },
  // pokeemerald/src/field_screen_effect.c:505 DoWhiteFadeWarp
  warpwhitefade: { music: true, fadeOut: true, white: true },
};

// Lua: warp.lua:956
function scripted(mod: any, game: any, kind: string | undefined, destMap: MapId, destX: number,
    destY: number, facing: string | undefined, onDone?: Done): boolean {
  const spec = SCRIPTED_KINDS[kind ?? "warp"] ?? SCRIPTED_KINDS.warp!;
  let [toMode, fromMode] = warpFadeModes(Fade, game, destMap);
  if (spec.white) { toMode = Fade.MODE.TO_WHITE; fromMode = Fade.MODE.FROM_WHITE; }
  // pokefirered/src/field_player_avatar.c:2017
  const savedFacing: string = Player.facing ?? "down";
  Warp._busy = true;

  const playSe = (id: any): void => {
    if (id != null && Audio && Audio.playSe) { try { Audio.playSe(id); } catch { /* pcall */ } }
  };

  const finish = (): void => {
    Warp._busy = false;
    Field._fieldCallback = false;
    if (onDone) onDone();
  };

  const arrive = (): void => {
    // pokefirered/src/field_fadetransition.c:542
    Field._fieldCallback = true;
    Warp.mapTransition(game, destMap, () => {
      // pokefirered/src/overworld.c:2144
      Player.setVisible(true);
      Player.spriteYOffset = 0;
      let arrivalFacing = facing ?? savedFacing;
      if (!spec.spinIn) {
        // pokefirered/src/scrcmd.c:729
        arrivalFacing = Collision.destArrivalFacing(game, destMap, destX, destY, "down");
      }
      Map.load(mod, game, destMap, {
        x: destX,
        y: destY,
        facing: arrivalFacing,
        depth1Connections: true,
      });
      if (spec.hidePlayer) Player.setVisible(false);
      Doors.reset();
      // pokeemerald/src/field_screen_effect.c:307
      if (spec.arriveSe) playSe(SE[spec.arriveSe]);
      if (spec.spinIn) {
        // pokefirered/src/field_fadetransition.c:307
        let faded = false, landed = false;
        Fade.begin(fromMode, 1, () => { faded = true; });
        playSe(SE.SE_WARP_OUT);
        teleportWarpInAnim(Player, savedFacing, () => { landed = true; });
        Task.spawn((): boolean => {
          if (!(faded && landed)) return false;
          finish();
          return true;
        });
        return;
      }
      warpExitArrival(game, destMap, destX, destY, fromMode, finish);
    });
  };

  // pokefirered/src/field_fadetransition.c:690
  const fadeOut = (): void => {
    const musicFrames = spec.music ? tryFadeOutOldMapMusic(game, destMap, destX, destY) : 0;
    const covered = !Fade.isActive() && (tonumber(Fade.t) ?? 0) >= 16;
    let faded = covered || !spec.fadeOut;
    if (!faded) {
      Fade.begin(toMode, 1, () => { faded = true; });
    }
    if (spec.se) playSe(SE[spec.se]);
    Task.spawn((t: any): boolean => {
      if (!faded) return false;
      if (t.frames < musicFrames && truthy(Audio._fadeOut)) return false;
      arrive();
      return true;
    });
  };

  if (spec.door) {
    // pokefirered/src/field_fadetransition.c:743
    // package.loaded["src.core.game3.map"]
    const curMap = Map && Map.current;
    const px = tonumber(Player.cellX) ?? 0, py = tonumber(Player.cellY) ?? 0;
    Doors.open(curMap, px, py - 1, { destMap }, () => {
      const closeDoor = (): void => {
        Player.setVisible(false);
        Doors.close(curMap, px, py - 1, { playSound: false }, fadeOut);
      };
      if (!Player.forceStep("up", closeDoor)) closeDoor();
    });
  } else if (spec.spinOut) {
    // pokefirered/src/field_fadetransition.c:712
    playSe(SE.SE_WARP_IN);
    teleportWarpOutAnim(Player, fadeOut);
  } else if (spec.fadeOut) {
    fadeOut();
  } else {
    arrive();
  }
  return true;
}

// Lua: warp.lua:1063
function isRse(): boolean {
  let ok: boolean, row: any;
  try { row = Profile.forSession(undefined); ok = true; } catch { ok = false; }
  return ok && typeof row === "object" && row !== null && row.family === "rse";
}

// Lua: warp.lua:1068
function mbIs(beh: any, name: string): boolean {
  const id = MB.id(name);
  return beh != null && id != null && beh === id;
}

// Lua: warp.lua:1073
function stepWarpScripted(mod: any, game: any, kind: string, destMap: MapId, destX: number,
    destY: number, srcX: any, srcY: any): boolean {
  [destMap, destX, destY] = announce(game, destMap, destX, destY, kind, srcX, srcY);
  if (Field && Field.lock) Field.lock();
  return Warp.scripted(mod, game, kind, destMap, destX, destY, undefined, () => {
    releaseField(Field);
  });
}

// Lua: warp.lua:1082
function ashEffect(name: string, cx: number, cy: number): void {
  const fn = FieldEffects[name];
  if (typeof fn === "function") { try { fn(cx, cy); } catch { /* pcall */ } }
}

// Lua: warp.lua:1088
function camPan(y: number): void {
  // package.loaded["src.core.game3.field_view"]
  if (FieldView && FieldView.setCameraPanning) FieldView.setCameraPanning(0, y);
}

// pokeemerald/src/field_effect.c:2143 StartLavaridgeGym1FWarp
// Lua: warp.lua:1094
function startLavaridge1F(mod: any, game: any, destMap: MapId, destX: number, destY: number,
    srcX: any, srcY: any): boolean {
  if (Warp._busy) return false;
  Field.lock();
  if (Field.holdInput) Field.holdInput(true);
  const t = { state: "puffs", count: 0, wait: 0, puff: 0 };
  Task.spawn((): boolean => {
    Field.lock();
    if (t.state === "puffs") {
      if (t.wait > 0) {
        t.wait = t.wait - 1;
        if (t.wait === 0) {
          Player.walkInPlace = false;
          Player.walkInPlaceFast = false;
        }
        return false;
      }
      // pokeemerald/src/field_effect.c:2163
      if (t.count > 3) {
        ashEffect("startAshPuff", Player.cellX, Player.cellY);
        t.state = "disappear";
        return false;
      }
      t.count = t.count + 1;
      Player.walkInPlace = true;
      Player.walkInPlaceFast = true;
      t.wait = 4;
      Audio.playSe(SE.SE_LAVARIDGE_FALL_WARP);
      return false;
    }
    t.puff = t.puff + 1;
    // pokeemerald/src/field_effect.c:2186
    if (t.state === "disappear" && t.puff >= 12) {
      Player.setVisible(false);
      t.state = "fade";
    }
    // pokeemerald/src/field_effect.c:2196
    if (t.state === "fade" && t.puff >= 30) {
      if (Field.holdInput) Field.holdInput(false);
      Warp.startFall(mod, game, destMap, destX, destY, srcX, srcY, { prologue: false });
      return true;
    }
    return false;
  });
  return true;
}

// pokeemerald/src/field_effect.c:1948 StartLavaridgeGymB1FWarp
// Lua: warp.lua:1146
function startLavaridgeB1F(mod: any, game: any, destMap: MapId, destX: number, destY: number,
    srcX: any, srcY: any): boolean {
  if (Warp._busy) return false;
  [destMap, destX, destY] = announce(game, destMap, destX, destY, "lavaridge_b1f", srcX, srcY);
  Warp._busy = true;
  const [toMode, fromMode] = warpFadeModes(Fade, game, destMap);
  Field.lock();
  const d: { state: string; d1: number; d2: number; d3: number; d4: number; y2: number;
    music?: number; faded?: boolean; t?: number } = { state: "shake", d1: 1, d2: 0, d3: 1, d4: 0, y2: 0 };
  // pokeemerald/src/field_effect.c:2062
  const exitEffect = (): void => {
    Player.setVisible(false);
    const e = { state: "wait", t: 0 };
    Fade.begin(fromMode, 1, () => { e.state = "puff"; });
    Task.spawn((): boolean => {
      Field.lock();
      if (e.state === "wait") return false;
      if (e.state === "puff") {
        ashEffect("startAshPuff", Player.cellX, Player.cellY);
        e.state = "popping";
        return false;
      }
      if (e.state === "popping") {
        e.t = e.t + 1;
        // pokeemerald/src/field_effect.c:2100
        if (e.t >= 12) {
          Player.setVisible(true);
          Audio.playSe(SE.SE_M_DIG);
          Player.scriptJump("right", 1);
          e.state = "jump";
        }
        return false;
      }
      if (truthy(Player.moving) || truthy(Player.jumping)) return false;
      Warp._busy = false;
      releaseField(Field);
      return true;
    });
  };
  Task.spawn((): boolean => {
    Field.lock();
    if (d.state === "shake") {
      // pokeemerald/src/field_effect.c:1970
      camPan(d.d1);
      d.d1 = -d.d1;
      d.d2 = d.d2 + 1;
      if (d.d2 > 7) {
        d.d2 = 0;
        d.state = "launch";
      }
      return false;
    } else if (d.state === "launch") {
      // pokeemerald/src/field_effect.c:1983
      Player.spriteYOffset = 0;
      d.d3 = 1;
      ashEffect("startAshLaunch", Player.cellX, Player.cellY);
      Audio.playSe(SE.SE_M_EXPLOSION);
      d.state = "rise";
    }
    if (d.state === "rise") {
      // pokeemerald/src/field_effect.c:1997
      camPan(d.d1);
      d.d1 = -d.d1;
      d.d2 = d.d2 + 1;
      if (d.d2 <= 17) {
        if (lmod(d.d2, 2) === 0 && d.d1 <= 3) d.d1 = d.d1 * 2;
      } else if (lmod(Math.floor(d.d2 / 4), 2) === 0 && d.d1 > 0) {
        d.d1 = Math.floor(d.d1 / 2);
      }
      if (d.d2 > 6) {
        if (d.y2 > -88) {
          d.y2 = d.y2 - d.d3;
          if (d.d3 <= 7) d.d3 = d.d3 + 1;
        } else {
          d.d4 = 1;
        }
      }
      Player.spriteYOffset = d.y2;
      if (d.d1 === 0 && d.d4 !== 0) {
        camPan(0);
        d.state = "fade";
        const musicFrames = tryFadeOutOldMapMusic(game, destMap, destX, destY);
        d.music = musicFrames;
        d.faded = false;
        Fade.begin(toMode, 1, () => { d.faded = true; });
        d.t = 0;
      }
      return false;
    }
    if (d.state === "fade") {
      d.t = d.t! + 1;
      if (!d.faded || (d.t < (d.music ?? 0) && truthy(Audio._fadeOut))) return false;
      Player.spriteYOffset = 0;
      Warp.mapTransition(game, destMap, () => {
        Map.load(mod, game, destMap, {
          x: destX, y: destY, facing: Player.facing, depth1Connections: true,
        });
        Field.lock();
        exitEffect();
      });
      return true;
    }
    return false;
  });
  return true;
}

// pokeemerald/src/field_screen_effect.c:495 DoDiveWarp
// Lua: warp.lua:1258
function startDive(mod: any, game: any, destMap: MapId, destX: number, destY: number): boolean {
  if (Warp._busy) return false;
  [destMap, destX, destY] = announce(game, destMap, destX, destY, "dive");
  Warp._busy = true;
  Field.lock();
  const facing = Player.facing;
  const [toMode, fromMode] = warpFadeModes(Fade, game, destMap);
  const musicFrames = tryFadeOutOldMapMusic(game, destMap, destX, destY);
  const E = Weather.rseEngine();
  if (truthy(E)) E.playRainStoppingSoundEffect();
  let faded = false;
  Fade.begin(toMode, 1, () => { faded = true; });
  Task.spawn((t: any): boolean => {
    if (!faded) return false;
    if (t.frames < musicFrames && truthy(Audio._fadeOut)) return false;
    Warp.mapTransition(game, destMap, () => {
      Map.load(mod, game, destMap, {
        x: destX, y: destY, facing, depth1Connections: true,
      });
      Player.setVisible(true);
      // pokeemerald/src/overworld.c:929 GetAdjustedInitialDirection
      Player.facing = facing;
      Dive.syncAvatar();
      warpExitArrival(game, destMap, destX, destY, fromMode, () => {
        Warp._busy = false;
        releaseField(Field);
      });
    });
    return true;
  });
  return true;
}

// pokeemerald/src/field_control_avatar.c:702 TryStartWarpEventScript
// Lua: warp.lua:1297
function rseStepWarp(mod: any, game: any, mapId: MapId, x: number, y: number,
    srcX: any, srcY: any): boolean | undefined {
  if (!(truthy(srcX) && truthy(srcY)) || !isRse()) return undefined;
  const beh = Collision.behavior(srcX, srcY);
  if (beh == null) return undefined;
  if (mbIs(beh, "LAVARIDGE_GYM_B1F_WARP")) {
    return Warp.startLavaridgeB1F(mod, game, mapId, x, y, srcX, srcY);
  }
  if (mbIs(beh, "LAVARIDGE_GYM_1F_WARP")) {
    return Warp.startLavaridge1F(mod, game, mapId, x, y, srcX, srcY);
  }
  if (mbIs(beh, "AQUA_HIDEOUT_WARP")) {
    return stepWarpScripted(mod, game, "rse_teleport_tile", mapId, x, y, srcX, srcY);
  }
  if (mbIs(beh, "BRIDGE_OVER_OCEAN")) {
    return stepWarpScripted(mod, game, "rse_spin_exit", mapId, x, y, srcX, srcY);
  }
  // pokeemerald/data/scripts/cave_hole.inc:23 EventScript_FallDownHoleMtPyre
  if (mbIs(beh, "MT_PYRE_HOLE")) {
    return Warp.startFall(mod, game, mapId, x, y, srcX, srcY);
  }
  if (mbIs(beh, "MOSSDEEP_GYM_WARP")) {
    return stepWarpScripted(mod, game, "rse_mossdeep_gym", mapId, x, y, srcX, srcY);
  }
  return undefined;
}

/**
 * Returns, as Brian's does: `[undefined, "warp busy"]` (Lua `nil, "warp busy"`)
 * when busy; a step-warp / start* boolean; Map.load's first value when it loads
 * at once (no fade, or no Fade module); otherwise true.
 */
// Lua: warp.lua:1325
function request(mod: any, game: any, mapId: MapId, x: number, y: number, facing?: string,
    opts?: WarpRequestOpts): any {
  const o: WarpRequestOpts = opts ?? {};
  if (Warp._busy) return [undefined, "warp busy"];
  if (!(truthy(o.door) || truthy(o.exitDoor) || truthy(o.escalator) || truthy(o.teleport) || truthy(o.fall))) {
    const special = rseStepWarp(mod, game, mapId, x, y, o.doorX, o.doorY);
    if (special != null) return special;
  }

  if (truthy(o.door)) {
    return Warp.startDoorEntrance(mod, game, mapId, x, y, o.doorX ?? x, o.doorY ?? y);
  }
  if (truthy(o.exitDoor)) {
    return Warp.startDoorExit(mod, game, mapId, x, y, o.doorX ?? x, o.doorY ?? y);
  }
  if (truthy(o.escalator)) {
    return Warp.startEscalator(mod, game, mapId, x, y, o.escalatorDir ?? "up", o.approachDir, o.escX, o.escY);
  }
  if (truthy(o.teleport)) {
    return Warp.startTeleport(mod, game, mapId, x, y);
  }
  if (truthy(o.fall)) {
    return Warp.startFall(mod, game, mapId, x, y);
  }
  [mapId, x, y] = announce(game, mapId, x, y, "warp", o.doorX, o.doorY);

  Warp._pending = {
    mapId,
    x,
    y,
    facing: facing ?? "down",
    fade: o.fade !== false,
  };

  const curMap = (game ? game.currentMap : undefined) ?? mapId;
  // Lua `opts.se or Doors.getSoundForWarp(...)` keeps the first of [sound, kind].
  const sound = truthy(o.se) ? o.se : Doors.getSoundForWarp(curMap, x, y, mapId, false)[0];

  const doLoad = (): any => {
    const loaded = Map.load(mod, game, mapId, {
      x,
      y,
      facing: facing ?? "down",
      depth1Connections: true,
    });
    // Lua `local result = Map.load(...)` keeps only the first value; Map.load's
    // failure is the tuple [undefined, err].
    const result = Array.isArray(loaded) ? loaded[0] : loaded;
    Warp._pending = undefined;
    if (Player && Player.setVisible) {
      Player.setVisible(true);
    }
    Doors.reset();
    return result;
  };

  if (o.fade === false) {
    if (o.se !== false) {
      if (Audio && Audio.playSe) { try { Audio.playSe(sound); } catch { /* pcall */ } }
    }
    return doLoad();
  }

  // pcall(require, "src.ui.game3.fade"): static import
  if (!(Fade && Fade.begin)) {
    if (o.se !== false) {
      if (Audio && Audio.playSe) { try { Audio.playSe(sound); } catch { /* pcall */ } }
    }
    return doLoad();
  }

  Warp._busy = true;
  if (Field && Field.lock) Field.lock();
  const [toMode, fromMode] = warpFadeModes(Fade, game, mapId);

  if (o.se !== false) {
    if (Audio && Audio.playSe) { try { Audio.playSe(sound); } catch { /* pcall */ } }
  }

  Fade.begin(toMode, 1, () => {
    Warp.mapTransition(game, mapId, () => {
      doLoad();
      if (Player && Player.setVisible) {
        Player.setVisible(true);
      }
      Doors.reset();
      warpExitArrival(game, mapId, x, y, fromMode, () => {
        Warp._busy = false;
        releaseField(Field);
      });
    });
  });

  return true;
}

// Lua: warp.lua:1421
function clear(): void {
  Warp._pending = undefined;
  Warp._busy = false;
  Warp._isEscalatorActive = false;
  // package.loaded["src.ui.game3.map_preview_screen"]
  if (MapPreviewScreen) {
    MapPreviewScreen._onDone = undefined;
    MapPreviewScreen.dismiss();
    MapPreviewScreen._cave = undefined;
  }
  // package.loaded["src.ui.game3.cave_transition"]
  if (CaveTransition) CaveTransition.clear();
  // package.loaded["src.core.game3.player"]
  if (Player && Player.setVisible) {
    Player.walkInPlace = false;
    Player.walkInPlaceFast = false;
    Player.spriteXOffset = 0;
    Player.spriteYOffset = 0;
    Player.setVisible(true);
  }
}

// Lua: warp.lua:6-9, 115, 162, 954, 1323 (the module table)
export const Warp = {
  _pending: undefined as PendingWarp | undefined,
  _busy: false,
  _isEscalatorActive: undefined as boolean | undefined,
  isBusy,
  fadeModes: warpFadeModes,
  mapTransition,
  releaseField,
  startDoorEntrance,
  startDoorExit,
  isEscalatorActive,
  startEscalator,
  startStairWarp,
  startTeleport,
  startEscapeRope,
  startFall,
  SCRIPTED_KINDS,
  scripted,
  startLavaridge1F,
  startLavaridgeB1F,
  startDive,
  rseStepWarp: rseStepWarp as typeof rseStepWarp | undefined,
  request,
  clear,
};

export default Warp;
