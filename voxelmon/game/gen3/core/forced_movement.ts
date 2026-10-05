// Port of gen1recomp src/core/game3/forced_movement.lua (GPLv3 + additional terms; see LICENSE.md).
// pokefirered/src/field_player_avatar.c:226 sForcedMovementFuncs
//
// Return shapes (Lua multiple returns -> 0-based tuples):
//   lookup -> [i, row] or []; tryDoMetatileBehaviorForcedMovement -> [moved, i?].
// The RSE table rows (muddy slope, secret-base mats) and step_callbacks_rse
// are Emerald only; isRse() is false for FireRed.

import { truthy } from "../../../import/gen3/lua.ts";
import { ipairs, len, seq, type LuaTable } from "../platform/lt.ts";
import { Collision as CollisionMod } from "./collision.ts";
import { Player as PlayerMod } from "./player.ts";
import { Profile } from "./profile.ts";
import { Bike } from "./bike.ts";
import { Audio } from "./audio.ts";
import { SE } from "./se_ids.ts";
import { Field as FieldMod } from "./field.ts";
import { Ctx } from "./scripting/ctx.ts";
import { Map as MapMod } from "./map.ts";
import { Events } from "./scripting/natives_events.ts";
import { Flags } from "./scripting/flags.ts";
import { Space as SpaceMod } from "./scripting/space.ts";
import { Warp as WarpMod } from "./warp.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */


type Beh = number | null | undefined;
export interface ForcedRow { name: string; check: (beh: Beh) => boolean; apply: (game: any) => any }

// Lua: forced_movement.lua:14 -- pokefirered/include/constants/metatile_behaviors.h:17
const MB_WATERFALL = 0x13;
const MB_ICE = 0x23;
const MB_WALK_EAST = 0x40;
const MB_WALK_WEST = 0x41;
const MB_WALK_NORTH = 0x42;
const MB_WALK_SOUTH = 0x43;
const MB_SLIDE_EAST = 0x44;
const MB_SLIDE_WEST = 0x45;
const MB_SLIDE_NORTH = 0x46;
const MB_SLIDE_SOUTH = 0x47;
const MB_TRICK_HOUSE_PUZZLE_8_FLOOR = 0x48;
const MB_EASTWARD_CURRENT = 0x50;
const MB_WESTWARD_CURRENT = 0x51;
const MB_NORTHWARD_CURRENT = 0x52;
const MB_SOUTHWARD_CURRENT = 0x53;
const MB_SPIN_RIGHT = 0x54;
const MB_SPIN_LEFT = 0x55;
const MB_SPIN_UP = 0x56;
const MB_SPIN_DOWN = 0x57;
const MB_STOP_SPINNING = 0x58;

// Lua: forced_movement.lua:36 -- pokefirered/src/event_object_movement.c:8925 sStepTimes
const FRAMES_NORMAL = 16;
const FRAMES_FAST_1 = 8;
const FRAMES_FAST_2 = 6;

// Lua: forced_movement.lua:40 (Lua sequences: d[1], d[2])
const DELTA: Record<string, [null, number, number]> = {
  up: [null, 0, -1],
  down: [null, 0, 1],
  left: [null, -1, 0],
  right: [null, 1, 0],
};

// Lua: forced_movement.lua:51
function player(): any {
  return PlayerMod;
}

// Lua: forced_movement.lua:55
function isRse(): boolean {
  try {
    return Profile.family() === "rse";
  } catch {
    return false;
  }
}

// Lua: forced_movement.lua:62
function rseBike(): any {
  return Bike.rse(undefined);
}

// Lua: forced_movement.lua:67
function se(id: any): void {
  try {
    if (Audio && Audio.playSe) Audio.playSe(id);
  } catch { /* pcall */ }
}

// Lua: forced_movement.lua:74
function behaviorPred(name: string | null, value?: number): (beh: Beh) => boolean {
  return (beh: Beh): boolean => {
    const fn = name ? (CollisionMod as any)[name] : null;
    if (fn) return fn(beh) === true;
    return beh === value;
  };
}

// Lua: forced_movement.lua:82
const isSpinTile = (beh: Beh): boolean => {
  if ((CollisionMod as any).isSpinTile) return (CollisionMod as any).isSpinTile(beh) === true;
  return beh != null && beh >= MB_SPIN_RIGHT && beh <= MB_SPIN_DOWN;
};

// Lua: forced_movement.lua:87
const isStopSpinning = behaviorPred("isStopSpinning", MB_STOP_SPINNING);

// Lua: forced_movement.lua:90 -- pokefirered/src/field_player_avatar.c:278 ForcedMovement_None
function forcedMovementNone(): false {
  const P = player();
  if (M.forced) {
    M.forced = false;
    P.spinning = false;
    P.animDisabled = false;
  }
  return false;
}

// Lua: forced_movement.lua:101 -- pokefirered/src/field_player_avatar.c:292 DoForcedMovement
function doForcedMovement(game: any, dir: string, frames?: number, opts?: any): boolean {
  const P = player();
  const d = DELTA[dir];
  if (!d) return forcedMovementNone();
  if (truthy(P.moving)) return false;
  M.forced = true;

  let lx: number | undefined, ly: number | undefined;
  if ((CollisionMod as any).ledgeLanding) {
    [lx, ly] = (CollisionMod as any).ledgeLanding(game, P.cellX, P.cellY, dir);
  }
  if (lx != null) {
    // pokefirered/src/field_player_avatar.c:307 PlayerJumpLedge
    forcedMovementNone();
    M.forced = true;
    return P.forcedStep(dir, undefined, { ledgeX: lx, ledgeY: ly });
  }

  const tx = P.cellX + d[1], ty = P.cellY + d[2];
  const [ok] = (CollisionMod as any).canEnter(game, tx, ty, {
    fromX: P.cellX, fromY: P.cellY, dir, surfing: P.surfing,
    elevation: P.currentElevation,
  });
  if (!ok) {
    // pokefirered/src/field_player_avatar.c:299
    return forcedMovementNone();
  }
  return P.forcedStep(dir, frames, opts);
}

// Lua: forced_movement.lua:132 -- pokefirered/src/field_player_avatar.c:330 ForcedMovement_Slip
function slip(game: any): boolean {
  const P = player();
  P.animDisabled = true;
  return doForcedMovement(game, P.facing, FRAMES_FAST_1);
}

// Lua: forced_movement.lua:139 -- pokefirered/src/field_player_avatar.c:335 ForcedMovement_WalkSouth
function walk(dir: string): (game: any) => boolean {
  return (game: any) => doForcedMovement(game, dir, FRAMES_NORMAL);
}

// Lua: forced_movement.lua:146 -- pokefirered/src/field_player_avatar.c:384 ForcedMovement_PushedSouthByCurrent
function current(dir: string): (game: any) => boolean {
  return (game: any) => doForcedMovement(game, dir, FRAMES_FAST_2);
}

// Lua: forced_movement.lua:153 -- pokefirered/src/field_player_avatar.c:355 ForcedMovement_SpinRight
function spin(dir: string): (game: any) => boolean {
  return (game: any) => {
    // pokefirered/src/field_player_avatar.c:379
    se(SE.SE_M_RAZOR_WIND2);
    const P = player();
    P.spinning = true;
    const moved = doForcedMovement(game, dir, FRAMES_FAST_1);
    if (!moved) P.spinning = false;
    return moved;
  };
}

// Lua: forced_movement.lua:166 -- pokefirered/src/field_player_avatar.c:404 ForcedMovement_Slide
function slide(dir: string): (game: any) => boolean {
  return (game: any) => {
    const P = player();
    P.animDisabled = true;
    return doForcedMovement(game, dir, FRAMES_FAST_1, { keepFacing: true });
  };
}

// Lua: forced_movement.lua:175 -- pokefirered/src/field_effect.c:1605 FldEff_UseWaterfall
function waterfallCurrent(game: any): boolean {
  const Field: any = FieldMod;
  if (Field && (Field._waterfall || Field.locked)) return false;
  return current("down")(game);
}

// Lua: forced_movement.lua:182 -- pokefirered/src/metatile_behavior.c:620
function never(): boolean { return false; }

// Lua: forced_movement.lua:185 -- pokefirered/src/field_player_avatar.c:433 ForcedMovement_MatJump
function matJump(): boolean { return false; }

// Lua: forced_movement.lua:188 -- pokefirered/src/field_player_avatar.c:439 ForcedMovement_MatSpin
function matSpin(): boolean { return false; }

// Lua: forced_movement.lua:191 -- pokeemerald/src/field_player_avatar.c:567 ForcedMovement_MuddySlope
function muddySlope(game: any): boolean {
  const P = player();
  const B = rseBike();
  const speed = B ? B.playerSpeed() : 0;
  const fastest = B ? B.SPEED.FASTEST : 4;
  if ((P.moveDir ?? P.facing) !== "up" || speed < fastest) {
    if (B) B.updateCounterSpeed(0);
    return doForcedMovement(game, "down", FRAMES_FAST_1, { keepFacing: true });
  }
  return false;
}

// Lua: forced_movement.lua:266 -- pokeemerald/src/metatile_behavior.c:338
function isForcedMovementTileRse(beh: number): boolean {
  return (beh >= MB_WALK_EAST && beh <= MB_TRICK_HOUSE_PUZZLE_8_FLOOR)
    || (beh >= MB_EASTWARD_CURRENT && beh <= MB_SOUTHWARD_CURRENT)
    || (CollisionMod as any).isMuddySlope(beh)
    || (CollisionMod as any).isCrackedFloor(beh)
    || beh === MB_WATERFALL
    || beh === MB_ICE
    || (CollisionMod as any).isSecretBaseJumpMat(beh)
    || (CollisionMod as any).isSecretBaseSpinMat(beh);
}

// Lua: forced_movement.lua:370 -- [x, y]
function playerDestCoords(): [number, number] {
  const P = player();
  if (truthy(P.moving) && P.targetX != null) return [P.targetX, P.targetY];
  return [P.cellX, P.cellY];
}

export const M = {
  // Lua: forced_movement.lua:47
  forced: false,
  lastSpinTile: null as Beh,
  _mapId: null as any,

  // Lua: forced_movement.lua:60
  isRse,

  // Lua: forced_movement.lua:204 -- pokefirered/src/field_player_avatar.c:226 sForcedMovementFuncs
  TABLE: seq<ForcedRow>(
    { name: "Slip", check: behaviorPred(null, MB_TRICK_HOUSE_PUZZLE_8_FLOOR), apply: slip },
    { name: "Slip", check: behaviorPred("isIce", MB_ICE), apply: slip },
    { name: "WalkSouth", check: behaviorPred("isWalkSouth", MB_WALK_SOUTH), apply: walk("down") },
    { name: "WalkNorth", check: behaviorPred("isWalkNorth", MB_WALK_NORTH), apply: walk("up") },
    { name: "WalkWest", check: behaviorPred("isWalkWest", MB_WALK_WEST), apply: walk("left") },
    { name: "WalkEast", check: behaviorPred("isWalkEast", MB_WALK_EAST), apply: walk("right") },
    { name: "PushedSouthByCurrent",
      check: behaviorPred("isSouthwardCurrent", MB_SOUTHWARD_CURRENT), apply: current("down") },
    { name: "PushedNorthByCurrent",
      check: behaviorPred("isNorthwardCurrent", MB_NORTHWARD_CURRENT), apply: current("up") },
    { name: "PushedWestByCurrent",
      check: behaviorPred("isWestwardCurrent", MB_WESTWARD_CURRENT), apply: current("left") },
    { name: "PushedEastByCurrent",
      check: behaviorPred("isEastwardCurrent", MB_EASTWARD_CURRENT), apply: current("right") },
    { name: "SpinRight", check: behaviorPred("isSpinRight", MB_SPIN_RIGHT), apply: spin("right") },
    { name: "SpinLeft", check: behaviorPred("isSpinLeft", MB_SPIN_LEFT), apply: spin("left") },
    { name: "SpinUp", check: behaviorPred("isSpinUp", MB_SPIN_UP), apply: spin("up") },
    { name: "SpinDown", check: behaviorPred("isSpinDown", MB_SPIN_DOWN), apply: spin("down") },
    { name: "SlideSouth", check: behaviorPred("isSlideSouth", MB_SLIDE_SOUTH), apply: slide("down") },
    { name: "SlideNorth", check: behaviorPred("isSlideNorth", MB_SLIDE_NORTH), apply: slide("up") },
    { name: "SlideWest", check: behaviorPred("isSlideWest", MB_SLIDE_WEST), apply: slide("left") },
    { name: "SlideEast", check: behaviorPred("isSlideEast", MB_SLIDE_EAST), apply: slide("right") },
    { name: "PushedSouthByCurrent",
      check: behaviorPred("isWaterfall", MB_WATERFALL), apply: waterfallCurrent },
    { name: "MatJump", check: never, apply: matJump },
    { name: "MatSpin", check: never, apply: matSpin },
  ) as (ForcedRow | null)[],

  // Lua: forced_movement.lua:234 -- pokeemerald/src/field_player_avatar.c:144 sForcedMovementTestFuncs
  TABLE_RSE: seq<ForcedRow>(
    { name: "Slip", check: behaviorPred("isTrickHouseSlipperyFloor", MB_TRICK_HOUSE_PUZZLE_8_FLOOR), apply: slip },
    { name: "Slip", check: behaviorPred("isIce", MB_ICE), apply: slip },
    { name: "WalkSouth", check: behaviorPred("isWalkSouth", MB_WALK_SOUTH), apply: walk("down") },
    { name: "WalkNorth", check: behaviorPred("isWalkNorth", MB_WALK_NORTH), apply: walk("up") },
    { name: "WalkWest", check: behaviorPred("isWalkWest", MB_WALK_WEST), apply: walk("left") },
    { name: "WalkEast", check: behaviorPred("isWalkEast", MB_WALK_EAST), apply: walk("right") },
    { name: "PushedSouthByCurrent",
      check: behaviorPred("isSouthwardCurrent", MB_SOUTHWARD_CURRENT), apply: current("down") },
    { name: "PushedNorthByCurrent",
      check: behaviorPred("isNorthwardCurrent", MB_NORTHWARD_CURRENT), apply: current("up") },
    { name: "PushedWestByCurrent",
      check: behaviorPred("isWestwardCurrent", MB_WESTWARD_CURRENT), apply: current("left") },
    { name: "PushedEastByCurrent",
      check: behaviorPred("isEastwardCurrent", MB_EASTWARD_CURRENT), apply: current("right") },
    { name: "SlideSouth", check: behaviorPred("isSlideSouth", MB_SLIDE_SOUTH), apply: slide("down") },
    { name: "SlideNorth", check: behaviorPred("isSlideNorth", MB_SLIDE_NORTH), apply: slide("up") },
    { name: "SlideWest", check: behaviorPred("isSlideWest", MB_SLIDE_WEST), apply: slide("left") },
    { name: "SlideEast", check: behaviorPred("isSlideEast", MB_SLIDE_EAST), apply: slide("right") },
    { name: "PushedSouthByCurrent",
      check: behaviorPred("isWaterfall", MB_WATERFALL), apply: waterfallCurrent },
    { name: "MatJump", check: behaviorPred("isSecretBaseJumpMat"), apply: matJump },
    { name: "MatSpin", check: behaviorPred("isSecretBaseSpinMat"), apply: matSpin },
    { name: "MuddySlope", check: behaviorPred("isMuddySlope"), apply: muddySlope },
  ) as (ForcedRow | null)[],

  // Lua: forced_movement.lua:260
  activeTable(): (ForcedRow | null)[] {
    if (isRse()) return M.TABLE_RSE;
    return M.TABLE;
  },

  // Lua: forced_movement.lua:278 -- pokefirered/src/metatile_behavior.c:266
  isForcedMovementTile(beh: Beh): boolean {
    if (beh == null) return false;
    if (isRse()) return isForcedMovementTileRse(beh);
    return (beh >= MB_WALK_EAST && beh <= MB_TRICK_HOUSE_PUZZLE_8_FLOOR)
      || (beh >= MB_EASTWARD_CURRENT && beh <= MB_SOUTHWARD_CURRENT)
      || beh === MB_WATERFALL
      || beh === MB_ICE
      || (beh >= MB_SPIN_RIGHT && beh <= MB_SPIN_DOWN);
  },

  // Lua: forced_movement.lua:288
  lookup(beh: Beh): [number, ForcedRow] | [] {
    const T = M.activeTable();
    for (let i = 1; i <= len(T); i++) {
      if (T[i]!.check(beh)) return [i, T[i]!];
    }
    return [];
  },

  // Lua: forced_movement.lua:297 -- pokefirered/src/field_player_avatar.c:252
  tryDoMetatileBehaviorForcedMovement(game: any, beh: Beh): [boolean, number?] {
    const T = M.activeTable();
    for (let i = 1; i <= len(T); i++) {
      const row = T[i]!;
      if (row.check(beh)) {
        M.lastSpinTile = beh;
        return [truthy(row.apply(game)) ? true : false, i];
      }
    }
    return [forcedMovementNone()];
  },

  // Lua: forced_movement.lua:310 -- pokefirered/src/field_player_avatar.c:931 PlayerApplyTileForcedMovement
  applyTileForcedMovement(game: any, beh: Beh): boolean {
    let moved = false;
    const T = M.activeTable();
    for (let i = 1; i <= len(T); i++) {
      if (T[i]!.check(beh)) {
        moved = truthy(T[i]!.apply(game)) ? true : moved;
      }
    }
    return moved;
  },

  // Lua: forced_movement.lua:322 -- pokefirered/src/field_player_avatar.c:200 TryUpdatePlayerSpinDirection
  tryUpdatePlayerSpinDirection(game: any): boolean {
    if (!(M.forced && isSpinTile(M.lastSpinTile))) return false;
    const P = player();
    if (truthy(P.moving)) return true;
    const beh = (CollisionMod as any).behavior(P.cellX, P.cellY);
    if (isStopSpinning(beh)) return false;
    if (isSpinTile(beh)) M.lastSpinTile = beh;
    M.applyTileForcedMovement(game, M.lastSpinTile);
    return true;
  },

  // Lua: forced_movement.lua:333
  stepCallbacks: {} as Record<string, (game: any, data: any) => any>,

  // Lua: forced_movement.lua:336 -- pokefirered/src/field_tasks.c:38 sPerStepCallbacks
  registerStepCallback(name: string, fn: (game: any, data: any) => any): void {
    M.stepCallbacks[name] = fn;
  },

  // Lua: forced_movement.lua:340
  _stepTask: null as any,
  _stepData: {} as Record<string, any>,

  // Lua: forced_movement.lua:344 -- pokefirered/src/field_tasks.c:66 Task_RunPerStepCallback
  runStepCallback(game: any): boolean {
    const rse = isRse();
    if (rse) {
      // pokeemerald/src/field_tasks.c:189 Task_MuddySlope
      // NOT FAITHFUL: Emerald only -- src.core.game3.step_callbacks_rse is not ported.
      throw new Error("NOT FAITHFUL: Emerald only: src.core.game3.step_callbacks_rse");
    }
    if (!(Ctx && Ctx.stepCallback)) return false;
    let name: string | undefined;
    try {
      name = Ctx.stepCallback(MapMod ? MapMod.current : undefined)[0];
    } catch {
      return false;
    }
    if (!name) return false;
    // pokefirered/src/field_tasks.c:96
    if (Ctx._stepCallback !== M._stepTask) {
      M._stepTask = Ctx._stepCallback;
      M._stepData = {};
    }
    const fn = M.stepCallbacks[name];
    if (!fn) return false;
    let ok = true;
    let res: any;
    try { res = fn(game, M._stepData); } catch { ok = false; }
    return (ok && truthy(res)) ? true : false;
  },

  // Lua: forced_movement.lua:423
  reset(): void {
    M.forced = false;
    M.lastSpinTile = null;
    const P = player();
    if (P) {
      P.spinning = false;
      P.animDisabled = false;
    }
  },

  // Lua: forced_movement.lua:434 -- pokefirered/src/field_player_avatar.c:1229 ClearPlayerAvatarInfo
  isForced(): boolean {
    const mapId = (CollisionMod as any)._mapId;
    if (mapId !== M._mapId) {
      M._mapId = mapId;
      M.reset();
    }
    return M.forced;
  },

  // Lua: forced_movement.lua:444 -- pokefirered/src/field_player_avatar.c:141 gPlayerAvatar.preventStep
  fieldControlsLocked(): boolean {
    const Field: any = FieldMod;
    if (Field && Field.locked) return true;
    const Space: any = SpaceMod;
    if (Space && Space.vm && Space.vm.isRunning && Space.vm.isRunning()) return true;
    const W: any = WarpMod;
    if (W && W.isBusy && W.isBusy()) return true;
    return false;
  },

  // Lua: forced_movement.lua:455 -- pokefirered/src/field_player_avatar.c:136 player_step
  onStepFinished(game: any): boolean {
    const P = player();
    if (truthy(P.moving)) return false;
    if (M.fieldControlsLocked()) return false;
    M.isForced();
    if (M.tryUpdatePlayerSpinDirection(game)) return true;
    const [moved] = M.tryDoMetatileBehaviorForcedMovement(game, (CollisionMod as any).behavior(P.cellX, P.cellY));
    return moved ? true : false;
  },
};

// Lua: forced_movement.lua:377 -- pokefirered/src/field_tasks.c:173 IcefallCaveIcePerStepCallback
M.registerStepCallback("ice", (_game: any, data: any) => {
  const state = data.state ?? 0;
  if (state === 0) {
    [data.prevX, data.prevY] = playerDestCoords();
    data.state = 1;
  } else if (state === 1) {
    const [x, y] = playerDestCoords();
    if (x === data.prevX && y === data.prevY) return false;
    data.prevX = x; data.prevY = y;
    const beh = (CollisionMod as any).behavior(x, y);
    if ((CollisionMod as any).isThinIce(beh)) {
      // pokefirered/src/field_tasks.c:139 MarkIcePuzzleCoordVisited
      for (const [i, c] of ipairs<any>(Events.ICEFALL_CAVE_ICE_COORDS)) {
        if (c[1] === x && c[2] === y) {
          const Space: any = SpaceMod;
          Flags.setFlag(Space.store, Space.vm ? Space.vm.ctx ?? null : null, i, true);
          break;
        }
      }
      data.delay = 4; data.state = 2; data.iceX = x; data.iceY = y;
    } else if ((CollisionMod as any).isCrackedIce(beh)) {
      data.delay = 4; data.state = 3; data.iceX = x; data.iceY = y;
    }
  } else if (data.delay !== 0) {
    data.delay = data.delay - 1;
  } else {
    const Field: any = FieldMod;
    if (state === 2) {
      se(SE.SE_ICE_CRACK);
      Field.setMetatile(data.iceX, data.iceY, Events.METATILE_SEAFOAM_CRACKED_ICE, false);
    } else {
      se(SE.SE_ICE_BREAK);
      Field.setMetatile(data.iceX, data.iceY, Events.METATILE_SEAFOAM_ICE_HOLE, false);
      const Space: any = SpaceMod;
      Flags.setVar(Space.store, Space.vm ? Space.vm.ctx ?? null : null, "VAR_TEMP_1", 1);
    }
    data.state = 1;
  }
  return false;
});

export const forced_movement = M;
export default M;
