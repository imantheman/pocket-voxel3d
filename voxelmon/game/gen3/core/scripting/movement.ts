// Port of gen1recomp src/core/game3/scripting/movement.lua (GPLv3 + additional terms; see LICENSE.md).
// Async movement tracker + FRLG movement-action decode.
// activeMoves[localId]; done on step_end 0xFE. LocalId 0xFF = player.
// Lua differences: movement byte streams are 0-based arrays (the Lua's
// 1-based tables); entry.index keeps the Lua's 1-based value.

import { tonumber } from "../../../../import/gen3/lua.ts";
import { MovementEmerald } from "../../../../import/gen3/movement_emerald.ts";
import { Profile } from "../profile.ts";
import { Opcodes } from "./opcodes.ts";

/** One decoded movement action (the Lua's table). */
export type Action = Record<string, any> & { kind: string };

export interface MoveEntry {
  bytes: ArrayLike<number>;
  index: number;
  done: boolean;
  hostHandle: unknown;
}

export interface MoveCtx { activeMoves: Record<number, MoveEntry> }

export interface MoveAdapters {
  lookupMovement?: (key: string) => ArrayLike<number> | undefined;
  applyMovement?: (localId: number, stream: ArrayLike<number>, done: () => void) => unknown;
  pollMovement?: (localId: number, entry: MoveEntry) => boolean;
}

const DIR: Record<number, string> = { 0: "down", 1: "up", 2: "left", 3: "right" };

// FRLG MOVEMENT_ACTION_* (include/constants/event_object_movement.h).
// Older Emerald-ish 0x08 walk_normal tables are wrong for FireRed.
const DIAG: Record<string, [string, string, number, number]> = {
  UP_LEFT: ["up", "left", -1, -1],
  UP_RIGHT: ["up", "right", 1, -1],
  DOWN_LEFT: ["down", "left", -1, 1],
  DOWN_RIGHT: ["down", "right", 1, 1],
};

// Lua: movement.lua:55
function rseAction(b: number): Action {
  let name: unknown = MovementEmerald.nameOf(b);
  if (typeof name !== "string") return { kind: "nop" };
  name = (name as string).replace(/^MOVEMENT_ACTION_/, "");
  const n = name as string;
  // pokeemerald/src/event_object_movement.c:6495
  if (n === "EMOTE_HEART") return { kind: "emote", emoteType: "heart", frames: 60 };
  // pokeemerald/src/event_object_movement.c:6617
  if (n === "HIDE_REFLECTION") return { kind: "reflection", hidden: true };
  if (n === "SHOW_REFLECTION") return { kind: "reflection", hidden: false };
  // pokeemerald/src/event_object_movement.c:7228
  const wheelie = /^ACRO_END_WHEELIE_MOVE_([A-Z]+)$/.exec(n);
  if (wheelie) return { kind: "step", dir: wheelie[1]!.toLowerCase(), acroEndWheelie: true };
  // pokeemerald/src/event_object_movement.c:5290
  const dm = /^WALK_([A-Z]+)_DIAGONAL_([A-Z]+_[A-Z]+)$/.exec(n);
  if (dm && DIAG[dm[2]!]) {
    const d = DIAG[dm[2]!]!;
    return { kind: "step_diagonal", dirs: [d[0], d[1]], dx: d[2], dy: d[3], slow: dm[1] === "SLOW" };
  }
  // pokeemerald/src/event_object_movement.c:8809
  if (n === "LOCK_ANIM") return { kind: "lock_anim", locked: true };
  if (n === "UNLOCK_ANIM") return { kind: "lock_anim", locked: false };
  // pokeemerald/src/event_object_movement.c:6667
  const affine = /^WALK_([A-Z]+)_AFFINE$/.exec(n);
  if (affine) return { kind: "step", dir: affine[1]!.toLowerCase(), run: true, affine: true };
  // pokeemerald/src/event_object_movement.c:7292
  if (n === "LEVITATE") return { kind: "levitate", on: true };
  if (n === "STOP_LEVITATE") return { kind: "levitate", on: false };
  if (n === "STOP_LEVITATE_AT_TOP") return { kind: "levitate", on: false, atTop: true };
  // pokeemerald/src/event_object_movement.c:6828
  if (n === "FIGURE_8") return { kind: "figure8" };
  return { kind: "nop", name: n };
}

export const Movement = {
  LOCALID_PLAYER: Opcodes.LOCALID_PLAYER,
  STEP_END: Opcodes.STEP_END,

  // FRLG MOVEMENT_ACTION_* names used by curated fallback content / tests.
  CMD: {
    FACE_DOWN: 0x00,
    FACE_UP: 0x01,
    FACE_LEFT: 0x02,
    FACE_RIGHT: 0x03,
    WALK_SLOWER_DOWN: 0x08,
    WALK_SLOWER_UP: 0x09,
    WALK_SLOWER_LEFT: 0x0A,
    WALK_SLOWER_RIGHT: 0x0B,
    WALK_SLOW_DOWN: 0x0C,
    WALK_SLOW_UP: 0x0D,
    WALK_SLOW_LEFT: 0x0E,
    WALK_SLOW_RIGHT: 0x0F,
    WALK_DOWN: 0x10, // WALK_NORMAL_*
    WALK_UP: 0x11,
    WALK_LEFT: 0x12,
    WALK_RIGHT: 0x13,
    DELAY_16: 0x1C,
    WALK_FAST_DOWN: 0x1D,
    WALK_FAST_UP: 0x1E,
    WALK_FAST_LEFT: 0x1F,
    WALK_FAST_RIGHT: 0x20,
    SET_INVISIBLE: 0x60,
    SET_VISIBLE: 0x61,
    EMOTE_EXCLAMATION: 0x62,
    EMOTE_QUESTION: 0x63,
    EMOTE_X: 0x64,
    EMOTE_DOUBLE_EXCLAMATION: 0x65,
    EMOTE_SMILE: 0x66,
    STEP_END: 0xFE,
  } as Record<string, number>,

  decodeRse: rseAction,

  // Lua: movement.lua:90
  decodeAction(bv: unknown): Action {
    const b = tonumber(bv) ?? 0;
    if (b === Movement.STEP_END || b === 0xFF) {
      return { kind: "end" };
    }
    if (b >= 0x100) return rseAction(b);
    if (b <= 0x07) {
      return { kind: "turn", dir: DIR[((b % 4) + 4) % 4] };
    }
    // Walk slower / slow / normal (0x08–0x13): four dirs each.
    if (b >= 0x08 && b <= 0x13) {
      return { kind: "step", dir: DIR[(b - 0x08) % 4] };
    }
    // Jump 2 cells (0x14–0x17): MOVEMENT_ACTION_JUMP_2_DOWN/UP/LEFT/RIGHT (e.g. ledge hop)
    if (b >= 0x14 && b <= 0x17) {
      return { kind: "jump", dir: DIR[b - 0x14], distance: 2 };
    }
    // Delay 1 / 2 / 4 / 8 / 16 frames (scaled up for host step rate).
    if (b >= 0x18 && b <= 0x1C) {
      const frames = ({ 0x18: 2, 0x19: 4, 0x1A: 8, 0x1B: 16, 0x1C: 32 } as Record<number, number>)[b];
      return { kind: "sleep", frames: frames ?? 8 };
    }
    // Walk fast / in-place / faster walks → step or turn-in-place.
    if (b >= 0x1D && b <= 0x20) {
      // pokeemerald/src/event_object_movement.c:5639
      const fast = Profile.family(undefined) === "rse" || undefined;
      return { kind: "step", dir: DIR[b - 0x1D], fast };
    }
    if (b >= 0x21 && b <= 0x30) {
      return { kind: "turn", dir: DIR[(b - 0x21) % 4] };
    }
    if (b >= 0x35 && b <= 0x38) {
      return { kind: "step", dir: DIR[b - 0x35] };
    }
    if (b >= 0x39 && b <= 0x3C) {
      return { kind: "step", dir: DIR[b - 0x39] };
    }
    // pokefirered/src/event_object_movement.c:5333 StartRunningAnim (MOVE_SPEED_FAST_1)
    if (b >= 0x3D && b <= 0x40) {
      return { kind: "step", dir: DIR[b - 0x3D], run: true };
    }
    // pokefirered/src/event_object_movement.c:6529 InitRunSlow
    if (b >= 0x41 && b <= 0x44) {
      return { kind: "step", dir: DIR[b - 0x41], run: true, slow: true };
    }
    // Jump special (0x46–0x49)
    if (b >= 0x46 && b <= 0x49) {
      return { kind: "jump", dir: DIR[b - 0x46], distance: 1 };
    }
    // pokefirered/src/event_object_movement.c:6772 MovementAction_FacePlayer_Step0
    if (b === 0x4A) {
      return { kind: "face_player" };
    }
    // pokefirered/src/event_object_movement.c:6784 MovementAction_FaceAwayPlayer_Step0
    if (b === 0x4B) {
      return { kind: "face_player", away: true };
    }
    // pokefirered/src/event_object_movement.c:6796 MovementAction_LockFacingDirection_Step0
    if (b === 0x4C) {
      return { kind: "lock_facing", locked: true };
    }
    // pokefirered/src/event_object_movement.c:6803 MovementAction_UnlockFacingDirection_Step0
    if (b === 0x4D) {
      return { kind: "lock_facing", locked: false };
    }
    // Jump 1 cell (0x4E–0x51): MOVEMENT_ACTION_JUMP_DOWN/UP/LEFT/RIGHT
    if (b >= 0x4E && b <= 0x51) {
      return { kind: "jump", dir: DIR[b - 0x4E], distance: 1 };
    }
    const rse = b >= 0x52 && b <= 0x67 && Profile.family(undefined) === "rse";
    if (rse && b >= 0x52 && b <= 0x55) {
      // pokeemerald/src/event_object_movement.c:6289
      return { kind: "jump", dir: DIR[b - 0x52], distance: 0, jumpType: "high" };
    }
    if (rse && b >= 0x56 && b <= 0x59) {
      // pokeemerald/src/event_object_movement.c:6357
      const THEN: Record<number, string> = { 0: "up", 1: "down", 2: "right", 3: "left" };
      return { kind: "jump", dir: DIR[b - 0x56], distance: 0, jumpType: "normal", thenFace: THEN[b - 0x56] };
    }
    if (rse && (b === 0x5C || b === 0x5D)) {
      // pokeemerald/src/event_object_movement.c:6444
      return { kind: "jump_landing_effect", on: b === 0x5C };
    }
    if (rse && b === 0x67) {
      // pokeemerald/src/event_object_movement.c:6503
      return { kind: "reveal_trainer" };
    }
    // Jump in place / face (0x52–0x59)
    if (b >= 0x52 && b <= 0x55) {
      return { kind: "turn", dir: DIR[b - 0x52] };
    }
    if (b >= 0x56 && b <= 0x59) {
      return { kind: "turn", dir: DIR[b - 0x56] };
    }
    if (b === 0x5A) {
      return { kind: "face_original" };
    }
    // Jump special with effect (0xA6–0xA9)
    if (b >= 0xA6 && b <= 0xA9) {
      return { kind: "jump", dir: DIR[b - 0xA6], distance: 1 };
    }
    if (b === 0x60) return { kind: "hide" };
    if (b === 0x61) return { kind: "show" };
    // Emotes: 60 frames animation in pokefirered (sAnimCmd_ExclamationMark1 etc.)
    if (b === 0x62) return { kind: "emote", emoteType: "exclamation", frames: 60 };
    if (b === 0x63) return { kind: "emote", emoteType: "question", frames: 60 };
    if (b === 0x64) return { kind: "emote", emoteType: "x", frames: 60 };
    if (b === 0x65) return { kind: "emote", emoteType: "double_exclamation", frames: 60 };
    if (b === 0x66) return { kind: "emote", emoteType: "smile", frames: 60 };
    // MOVEMENT_ACTION_NURSE_JOY_BOW_DOWN (0x5B): ANIM_NURSE_BOW ≈ 48 frames.
    if (b === 0x5B) {
      return { kind: "bow", frames: 48 };
    }
    // pokefirered/src/event_object_movement.c:7040 MovementAction_DisableAnimation_Step0
    if (b === 0x5E) {
      return { kind: "animate", inanimate: true };
    }
    // pokefirered/src/event_object_movement.c:7047 MovementAction_RestoreAnimation_Step0
    if (b === 0x5F) {
      return { kind: "animate", inanimate: false };
    }
    // pokefirered/src/event_object_movement.c:7135 MovementAction_RockSmashBreak_Step0
    if (b === 0x68) {
      return { kind: "remove_obstacle", frames: 64 };
    }
    // pokefirered/src/event_object_movement.c:7163 MovementAction_CutTree_Step0
    if (b === 0x69) {
      return { kind: "remove_obstacle", frames: 56 };
    }
    return { kind: "nop" };
  },

  // Lua: movement.lua:222 -- bytes 0-based
  actionsFromBytes(bytes: unknown): Action[] {
    const out: Action[] = [];
    if (bytes === null || typeof bytes !== "object") return out;
    const arr = bytes as ArrayLike<number>;
    for (let i = 0; i < arr.length; i++) {
      const act = Movement.decodeAction(arr[i]);
      if (act.kind === "end") break;
      if (act.kind !== "nop") out.push(act);
    }
    return out;
  },

  // Lua: movement.lua:233
  start(ctx: MoveCtx, localIdV: unknown, bytes: unknown, adapters?: MoveAdapters): MoveEntry {
    const localId = tonumber(localIdV) ?? 0;
    let stream: unknown = bytes;
    if (typeof bytes === "string") {
      stream = adapters && adapters.lookupMovement && adapters.lookupMovement(bytes);
    }
    if (stream === null || typeof stream !== "object") {
      stream = [Movement.STEP_END];
    }
    const s = stream as ArrayLike<number>;
    const entry: MoveEntry = {
      bytes: s,
      index: 1,
      done: false,
      hostHandle: undefined,
    };
    ctx.activeMoves[localId] = entry;
    if (adapters && adapters.applyMovement) {
      entry.hostHandle = adapters.applyMovement(localId, s, () => {
        entry.done = true;
      });
    } else {
      // Instant-complete stub (unit tests / no host).
      for (let i = 0; i < s.length; i++) {
        if (s[i] === Movement.STEP_END) {
          entry.done = true;
          break;
        }
      }
      if (!entry.done && s.length === 0) entry.done = true;
    }
    return entry;
  },

  // Lua: movement.lua:266
  tick(ctx: MoveCtx, adapters?: MoveAdapters): void {
    for (const k of Object.keys(ctx.activeMoves)) {
      const localId = Number(k);
      const entry = ctx.activeMoves[localId]!;
      if (!entry.done && adapters && adapters.pollMovement) {
        if (adapters.pollMovement(localId, entry)) {
          entry.done = true;
        }
      }
    }
  },

  // Lua: movement.lua:276
  isDone(ctx: MoveCtx, localIdV: unknown): boolean {
    const localId = tonumber(localIdV) ?? 0;
    // waitmovement 0 waits for all
    if (localId === 0) {
      for (const k of Object.keys(ctx.activeMoves)) {
        if (!ctx.activeMoves[Number(k)]!.done) return false;
      }
      return true;
    }
    const entry = ctx.activeMoves[localId];
    if (!entry) return true;
    return entry.done === true;
  },

  /** Drop finished tracks so the next waitmovement 0 is not confused by leftovers. */
  // Lua: movement.lua:291
  pruneDone(ctx: MoveCtx | undefined): void {
    if (!ctx || !ctx.activeMoves) return;
    const keep: Record<number, MoveEntry> = {};
    for (const k of Object.keys(ctx.activeMoves)) {
      const entry = ctx.activeMoves[Number(k)];
      if (entry && !entry.done) {
        keep[Number(k)] = entry;
      }
    }
    ctx.activeMoves = keep;
  },

  // Lua: movement.lua:302
  makePoll(ctx: MoveCtx, localId: unknown, adapters?: MoveAdapters): () => boolean {
    return () => {
      Movement.tick(ctx, adapters);
      const done = Movement.isDone(ctx, localId);
      if (done) Movement.pruneDone(ctx);
      return done;
    };
  },

  /** Ensure extracted movement ends with 0xFE (include terminator); 0-based arrays. */
  // Lua: movement.lua:312
  ensureTerminated(bytes: ArrayLike<number>): number[] {
    const out: number[] = [];
    for (let i = 0; i < bytes.length; i++) {
      out[i] = bytes[i]!;
      if (bytes[i] === Movement.STEP_END) {
        return out;
      }
    }
    out.push(Movement.STEP_END);
    return out;
  },
};

export default Movement;
