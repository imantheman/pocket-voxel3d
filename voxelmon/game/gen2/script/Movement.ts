// Gen 2 overworld movement-script helpers (macros/scripts/movement.asm).
// Import stores raw byte streams; the world steps them one command at a time.
//
// Port of gen1recomp src/script/gen2/Movement.lua at bdfac727 (MIT).

import { mod } from "../platform/lua.ts";

export type Dir = "down" | "up" | "left" | "right";

/** One decoded movement byte (Movement.decodeByte). */
export interface MovementAction {
  kind: string;
  dir?: Dir;
  frames?: number;
  spin?: boolean;
  on?: boolean;
  fixed?: boolean;
  mode?: "from" | "to";
}

// Lua: Movement.lua:8
const DIR: Record<number, Dir> = { 0: "down", 1: "up", 2: "left", 3: "right" };

// High nibble / command family (low 2 bits = facing when directional).
// Lua: Movement.lua:13
const STEP_END = 0x47;
const STEP_WAIT_END = 0x48;
// The two warp-exit bytes.  Each of StepFunction_TeleportFrom's two beats runs
// for 16 frames (`ld [hl], 16` into OBJECT_STEP_DURATION), and TeleportTo's
// three -- wait, descent, final spin -- for 16 each.  Lua: Movement.lua:18
const TELEPORT_FROM = 0x4c;
const TELEPORT_TO = 0x4d;
const TELEPORT_BEAT_FRAMES = 16;
const TELEPORT_FROM_FRAMES = 2 * TELEPORT_BEAT_FRAMES;
const TELEPORT_TO_FRAMES = 3 * TELEPORT_BEAT_FRAMES;
// The four OBJECT_FLAGS1 control bytes (macros/scripts/movement.asm:78-96).
// None of them consume a frame: each Movement_* handler ends in
// `jp ContinueReadingMovement` (engine/overworld/movement.asm:353-375).
// Lua: Movement.lua:27
const REMOVE_SLIDING = 0x38;
const SET_SLIDING = 0x39;
const REMOVE_FIXED_FACING = 0x3a;
const FIX_FACING = 0x3b;
// Movement_tree_shake (engine/overworld/movement.asm:334): 24 frames of
// STEP_TYPE_SLEEP with OBJECT_ACTION_WEIRD_TREE.  Lua: Movement.lua:33
const TREE_SHAKE = 0x56;
const TREE_SHAKE_FRAMES = 24;
// engine/events/forced_movement.asm:25-51; step_dig's frame count is the
// byte after it (macros/scripts/movement.asm:163-167).  Lua: Movement.lua:37
const TURN_HEAD = 0x00;
const TURN_IN = 0x24;
const STEP_DIG = 0x4f;
const STEP_DIG_FRAMES = 16;
// macros/scripts/movement.asm:99-106
const SHOW_OBJECT = 0x3c;
const HIDE_OBJECT = 0x3d;
// macros/scripts/movement.asm:211-214, engine/overworld/movement.asm:142-160
const RETURN_DIG = 0x58;
// engine/events/overworld.asm:864-872
const DIG_SPIN_FRAMES = 32;
// macros/scripts/movement.asm:158-160, engine/overworld/map_objects.asm:1368
const SKYFALL = 0x4e;
const SKYFALL_TOP = 0x59;
const SKYFALL_BEAT_FRAMES = 16;

// Lua: Movement.lua:53
function dir(nibble: number): Dir {
  return DIR[mod(nibble, 4)] ?? "down";
}

// Decode one byte into an action table.
// Returns { kind="step"|"turn"|"sleep"|"end"|..., dir=?, frames=? }.
// Lua: Movement.lua:59
function decodeByte(b: number): MovementAction {
  if (b === STEP_END || b === STEP_WAIT_END) {
    return { kind: "end" };
  }
  const family = b & 0xfc;
  const d = dir(b & 0x03);
  if (family === 0x00) { // turn_head
    return { kind: "turn", dir: d };
  } else if (family === 0x04) { // turn_step (face then step)
    return { kind: "step", dir: d };
  } else if (family === 0x08) { // slow_step
    return { kind: "step", dir: d };
  } else if (family === 0x0c) { // step
    return { kind: "step", dir: d };
  } else if (family === 0x10) { // big_step
    return { kind: "step", dir: d };
  } else if (family === 0x14 || family === 0x18 || family === 0x1c) { // slides
    return { kind: "step", dir: d };
  } else if (family === 0x20 || family === 0x24 || family === 0x28) {
    // turn_away / turn_in / turn_waterfall all `jp TurningStep`, which steps a
    // cell under OBJECT_ACTION_SPIN -- movement.asm:483-513, :693-715 (#1716)
    return { kind: "step", dir: d, spin: true };
  } else if (family === 0x2c || family === 0x30 || family === 0x34) {
    // slow_jump_step / jump_step / fast_jump_step reach JumpStep
    // (engine/overworld/movement.asm:741) and StepFunction_NPCJump
    // (engine/overworld/map_objects.asm:1129): TWO beats, two cells.
    return { kind: "jump", dir: d };
  } else if (b === SET_SLIDING || b === REMOVE_SLIDING) {
    // Movement_set_sliding / _remove_sliding toggle SLIDING_F
    // (engine/overworld/movement.asm:353-363): the object keeps its facing and
    // step frame for the whole stream (maps/BurnedTowerB1F.asm:103-125).
    return { kind: "sliding", on: b === SET_SLIDING };
  } else if (b === FIX_FACING || b === REMOVE_FIXED_FACING) {
    // Movement_fix_facing / _remove_fixed_facing toggle FIXED_FACING_F
    // (engine/overworld/movement.asm:365-375; InitStep skips the facing
    // write, engine/overworld/map_objects.asm:284-294).
    return { kind: "fixfacing", fixed: b === FIX_FACING };
  } else if (b === SHOW_OBJECT || b === HIDE_OBJECT) {
    // OBJECT_FLAGS1 (macros/scripts/movement.asm:99-106)
    // (engine/events/overworld.asm:864-872)
    return { kind: "visible", on: b === SHOW_OBJECT };
  } else if (b >= 0x3e && b <= 0x46) { // step_sleep N
    return { kind: "sleep", frames: (b - 0x3e + 1) * 16 };
  } else if (b === TELEPORT_FROM || b === TELEPORT_TO) {
    // Movement_teleport_from / _to set STEP_TYPE_TELEPORT_FROM / _TO
    // (engine/overworld/movement.asm:95; StepFunction_TeleportFrom / _To in
    // engine/overworld/map_objects.asm).
    return {
      kind: "teleport",
      mode: b === TELEPORT_FROM ? "from" : "to",
      frames: b === TELEPORT_FROM ? TELEPORT_FROM_FRAMES : TELEPORT_TO_FRAMES,
    };
  } else if (b === TREE_SHAKE) {
    // Movement_tree_shake (engine/overworld/movement.asm:334); SetFacingWeirdTree
    // (engine/overworld/map_object_action.asm:204) rocks the tree for 24
    // frames (maps/Route36.asm:260-262).
    return { kind: "treeshake", frames: TREE_SHAKE_FRAMES };
  } else if (b === RETURN_DIG) {
    // Movement_return_dig (engine/overworld/movement.asm:142-160)
    // (engine/overworld/map_objects.asm:1481-1493)
    return { kind: "returndig" };
  } else if (b === SKYFALL || b === SKYFALL_TOP) {
    // StepFunction_Skyfall (engine/overworld/map_objects.asm:1368)
    return {
      kind: b === SKYFALL ? "skyfall" : "skyfalltop",
      frames: b === SKYFALL ? 2 * SKYFALL_BEAT_FRAMES : SKYFALL_BEAT_FRAMES,
    };
  }
  return { kind: "nop" };
}

// Lua: Movement.lua:161
function isEnd(b: number): boolean {
  return b === STEP_END || b === STEP_WAIT_END;
}

// SetFacingWeirdTree's own index: OBJECT_STEP_FRAME is incremented BEFORE
// masking, so the quarter changes every four frames
// (engine/overworld/map_object_action.asm:204, data/sprites/facings.asm:46-52).
// Lua: Movement.lua:194
function treeShakeIndex(frame?: number): number {
  return mod(Math.floor(mod((frame ?? 0) + 1, 16) / 4), 4);
}

// Sine (home/sine.asm) with StepFunction_TeleportFrom's amplitude:
// `ld d, $60 / call Sine / ld a, h / sub $60`.  Lua: Movement.lua:204
function teleportYOffset(height: number): number {
  return Math.floor(0x60 * Math.sin(mod(height, 64) * Math.PI / 32)) - 0x60;
}

// engine/overworld/map_objects.asm:1796-1817.  Lua: Movement.lua:214
const JUMP_Y = [
  -4, -6, -8, -10, -11, -12, -12, -12,
  -11, -10, -9, -8, -6, -4, 0, 0,
];

// Lua: Movement.lua:219.  `idx` stays Lua's 1-based index into the curve.
function jumpYOffset(progress?: number, frames?: number): number {
  const curve = JUMP_Y;
  const n = curve.length;
  const t = ((progress ?? 0) - 1) * (n - 1) / Math.max((frames ?? n) - 1, 1) + 1;
  let idx = Math.floor(t);
  if (idx < 1) idx = 1;
  if (idx >= n) return curve[n - 1]!;
  return Math.floor(curve[idx - 1]! + (curve[idx]! - curve[idx - 1]!) * (t - idx) + 0.5);
}

// Lua: Movement.lua:229
const DIR_BYTE: Record<string, number> = { down: 0, up: 1, left: 2, right: 3 };

// The `step <dir>` family ($0c-$0f), what InitMovementBuffer fills for a
// trainer walking up to the player.  Lua: Movement.lua:233
function stepByte(d: string): number {
  return 0x0c + (DIR_BYTE[d] ?? 0);
}

// Script_ForcedMovement's stream, `back` being the direction thrown in
// -- engine/events/forced_movement.asm:25-51.  Lua: Movement.lua:239
function forcedMovementBytes(back: string): number[] {
  const d = DIR_BYTE[back] ?? 0;
  return [
    STEP_DIG, STEP_DIG_FRAMES, TURN_IN + d,
    STEP_DIG, STEP_DIG_FRAMES, TURN_HEAD + d,
    STEP_END,
  ];
}

// .DigOut / .DigReturn -- engine/events/overworld.asm:864-872
// Lua: Movement.lua:249
function digOutBytes(): number[] {
  return [STEP_DIG, DIG_SPIN_FRAMES, HIDE_OBJECT, STEP_END];
}

// Lua: Movement.lua:253
function digReturnBytes(): number[] {
  return [SHOW_OBJECT, RETURN_DIG, DIG_SPIN_FRAMES, STEP_END];
}

export const Movement = {
  DIR,
  FACING: DIR,
  // Lua: Movement.lua:165-184
  STEP_END,
  STEP_WAIT_END,
  TELEPORT_FROM,
  TELEPORT_TO,
  TELEPORT_BEAT_FRAMES,
  REMOVE_SLIDING,
  SET_SLIDING,
  REMOVE_FIXED_FACING,
  FIX_FACING,
  TREE_SHAKE,
  TREE_SHAKE_FRAMES,
  STEP_DIG,
  STEP_DIG_FRAMES,
  SHOW_OBJECT,
  HIDE_OBJECT,
  RETURN_DIG,
  DIG_SPIN_FRAMES,
  SKYFALL,
  SKYFALL_TOP,
  SKYFALL_BEAT_FRAMES,
  // OBJECT_JUMP_HEIGHT's start values: $10 for the rise (.InitSpinRise) and
  // 0 for the descent (.InitDescent).  Lua: Movement.lua:210
  TELEPORT_RISE_HEIGHT: 0x10,
  TELEPORT_FALL_HEIGHT: 0,
  JUMP_Y,
  dir,
  decodeByte,
  isEnd,
  treeShakeIndex,
  teleportYOffset,
  jumpYOffset,
  stepByte,
  forcedMovementBytes,
  digOutBytes,
  digReturnBytes,
};

export default Movement;
