// Battle card animations. The v1 battle port kept pokered's animation
// BEATS — the queue still carries an anim row per move (battle.ts
// performMove), still pays PlayMoveAnimation's Delay3, and still holds
// SlideDownFaintedMonPic's FAINT_SLIDE frames — but drew nothing in them
// (battle.ts's own header calls it out: "move subanimations ... nothing
// draws"). This fills those beats.
//
// What it does NOT do is port pokered's per-move subanimations. Those are
// sequences of GB tile/OAM frames composited over a 2D battle screen
// (data/moves/animations.asm + engine/battle/animations.asm); this port
// stands the two mons up as billboards in a 3D voxel arena, where a
// tile-space overlay has nowhere to land. So every move shares one physical
// reading — the attacker lunges, the defender is knocked back and flickers
// — which is the part of a Gen 1 battle animation that survives the change
// of medium. The faint slide, by contrast, IS the reference's: the same
// FAINT_SLIDE frames sinking the pic by the same 4 px a frame.

import { Q4 } from "../../../contracts/spec/voxel-spec.ts";
import { FAINT_SLIDE, FAINT_SLIDE_STEP } from "../rules/timing.ts";

/** Card sides, matching the `card` op and staging.ts's CardDesire.side. */
export const SIDE_PLAYER = 0;
export const SIDE_ENEMY = 1;

export type AnimKind = "lunge" | "hit" | "faint";

export interface BattleAnim {
  kind: AnimKind;
  /** The card that moves: SIDE_PLAYER or SIDE_ENEMY. */
  side: number;
  frame: number;
  total: number;
}

/** Frames each animation holds the queue for. */
export function animFrames(kind: AnimKind): number {
  // The lunge covers PlayMoveAnimation's slot, where the reference would be
  // running the move's own subanimation; 16 frames is about the length of a
  // short one and keeps a turn's rhythm close to the real thing. The faint
  // is the reference's exact count.
  if (kind === "faint") return FAINT_SLIDE;
  return 16;
}

/** How far a lunge reaches, and how far a hit knocks back, in px. */
const LUNGE_PX = 7;
const KNOCKBACK_PX = 5;

/** The per-frame offset + visibility a card gets from the animation. */
export interface CardFx {
  /** Q4 px, world X/Y/Z. dy is lift; negative sinks into the floor. */
  dx: number;
  dy: number;
  dz: number;
  /** The card is not drawn this frame (the hit flicker's dark half). */
  hidden: boolean;
}

export const NO_FX: CardFx = { dx: 0, dy: 0, dz: 0, hidden: false };

const px = (v: number): number => Math.round(v * Q4);

/**
 * The offset for `side`'s card on this frame. `towardX`/`towardZ` is a unit
 * vector from this card toward the other one, in world axes — the arena
 * places the two mons on a diagonal as often as not, so a lunge has to
 * follow the line between them rather than a fixed screen direction.
 */
export function cardFx(
  anims: readonly BattleAnim[],
  side: number,
  towardX: number,
  towardZ: number,
): CardFx {
  // At most one animation per side runs at a time, but both sides animate
  // together: a landed hit lunges the attacker and recoils the defender in
  // the same beat.
  const anim = anims.find((a) => a.side === side);
  if (!anim) return NO_FX;
  // Over the LAST frame index, not the count, so t hits exactly 1 on the
  // final frame and the card is back at rest before the animation is
  // dropped — off-by-one here leaves a visible snap.
  const span = Math.max(1, anim.total - 1);
  const t = Math.min(1, anim.frame / span);

  if (anim.kind === "faint") {
    // SlideDownFaintedMonPic: the pic sinks by FAINT_SLIDE_STEP px a frame.
    // Sinking (rather than sliding off a 2D screen) reads the same here
    // because the ground occludes it from the feet up.
    return { dx: 0, dy: px(-FAINT_SLIDE_STEP * anim.frame), dz: 0, hidden: false };
  }

  if (anim.kind === "lunge") {
    // Out and back: sin runs 0 -> 1 -> 0 over the beat, so the card returns
    // to its cell exactly on the last frame and nothing has to snap.
    const reach = Math.sin(Math.PI * t) * LUNGE_PX;
    return { dx: px(towardX * reach), dy: 0, dz: px(towardZ * reach), hidden: false };
  }

  // hit: knocked AWAY from the attacker (so, away from the card it faces),
  // easing back in, while flickering on a 2-frame cadence for the first
  // half — the reference flashes the target's pic on the damage frame.
  const recoil = (1 - t) * KNOCKBACK_PX;
  return {
    dx: px(-towardX * recoil),
    dy: 0,
    dz: px(-towardZ * recoil),
    hidden: anim.frame < anim.total / 2 && (anim.frame & 2) !== 0,
  };
}

/** A unit vector from `from` toward `to` in world axes, given cell coords. */
export function towardCell(
  from: [number, number],
  to: [number, number],
): [number, number] {
  const dx = to[0] - from[0];
  const dz = to[1] - from[1];
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return [0, 0];
  return [dx / len, dz / len];
}
