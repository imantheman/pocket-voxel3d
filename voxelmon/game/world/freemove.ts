// Free movement: the walk DramaticShapeVoxelMod gives its free-roam camera
// rungs (lib/FreeMove.lua), ported.
//
// The engine walks a grid -- sixteen frames a cell, four directions, input
// locked mid-step. Under a camera that swings to any angle that gait reads as
// riding a rail: push forward with the camera at thirty degrees and you walk
// straight north. Free movement makes the player's position continuous and
// steers it by the camera's own yaw, so forward is where you look, at any
// angle, sliding along whatever you graze.
//
// THE GRID IS STILL THE GAME. Every fact the world cares about -- what
// blocks, what warps, what rustles, what bites -- is a fact about cells, so
// the walk keeps the player's logical cell synced to wherever they stand and
// hands every one of those questions to the engine's own machinery (see
// Overworld.freeWalk). This module is only the geometry: which way a push
// goes, and how far the body can get.

import type { Dir } from "./collision.ts";

/**
 * The body: a circle in the ground plane, radius in world px (FreeMove.RADIUS).
 * Small enough to walk every one-cell corridor the game has -- half a cell is
 * eight -- and big enough to keep off wall faces when sliding along them.
 */
export const FREE_RADIUS = 5.5;

/**
 * The world direction of a screen push under a camera at `yaw`.
 *
 * `sx`/`sy` are the pad in screen terms: +x right, +y DOWN the screen. `yaw`
 * uses the camera's convention -- 0 looks north (-z), and forward on the
 * screen is where the camera looks -- so up on the pad is always away from
 * the camera. Returns a unit vector in map terms (+x east, +y south), or null
 * for no push. Diagonals come out the same length as straights, so walking at
 * an angle is not faster than walking along an axis.
 */
export function freeDir(sx: number, sy: number, yaw: number): [number, number] | null {
  if (sx === 0 && sy === 0) return null;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  // screen right is the camera's right, (cos, sin); screen up is its
  // forward, (sin, -cos)
  const x = sx * c - sy * s;
  const y = sx * s + sy * c;
  const len = Math.hypot(x, y);
  return len === 0 ? null : [x / len, y / len];
}

/**
 * The grid direction nearest a world vector -- which way the body faces, what
 * A talks to, and which way a special push (a ledge, an edge, a boulder) is
 * handed to the grid's own handlers.
 */
export function quantize(x: number, y: number): Dir {
  if (Math.abs(x) > Math.abs(y)) return x > 0 ? "right" : "left";
  return y > 0 ? "down" : "up";
}

/**
 * Can the body stand with its cell origin at `(px, py)`? The body's centre is
 * the middle of that cell-sized square; the four corners of its bounding box
 * each have to land in a cell `open` allows. Standing exactly on a cell, those
 * corners all fall inside it, so a player at rest never tests a neighbour.
 */
export function bodyClear(
  px: number,
  py: number,
  open: (cx: number, cy: number) => boolean,
): boolean {
  const cx = px + 8;
  const cy = py + 8;
  for (const ox of [-FREE_RADIUS, FREE_RADIUS]) {
    for (const oy of [-FREE_RADIUS, FREE_RADIUS]) {
      if (!open(Math.floor((cx + ox) / 16), Math.floor((cy + oy) / 16))) return false;
    }
  }
  return true;
}

/**
 * Move by `(dx, dy)` as far as the world allows, one axis at a time -- which
 * is what makes a push into a wall at an angle SLIDE along it instead of
 * stopping dead.
 */
export function slide(
  px: number,
  py: number,
  dx: number,
  dy: number,
  open: (cx: number, cy: number) => boolean,
): { px: number; py: number; moved: boolean } {
  let nx = px;
  let ny = py;
  if (dx !== 0 && bodyClear(px + dx, py, open)) nx = px + dx;
  if (dy !== 0 && bodyClear(nx, py + dy, open)) ny = py + dy;
  return { px: nx, py: ny, moved: nx !== px || ny !== py };
}

/**
 * How much of a push has to lean along an axis for a block on that axis to
 * count as pushing INTO it (an edge crossed, a ledge hopped). Well under a
 * diagonal's 0.71, so a walk at forty-five degrees still crosses; over the
 * wobble of a pad held "straight", so sliding along a wall never trips it.
 */
export const FREE_AXIS_LEAN = 0.35;

/** The logical cell a free position stands in: whichever centre is nearest. */
export function cellOf(p: number): number {
  return Math.round(p / 16);
}

/**
 * Where the pad rests before it counts as pushed, as a fraction of its
 * throw (the host's own STICK_DEAD over its range), and the walk's floor
 * speed the moment it does -- a bare touch is still a walk, not a shuffle.
 */
export const STICK_DEAD = 0.25;
export const STICK_MIN_THROW = 0.4;

/**
 * The circle pad as a push: its direction on the pad (+y up) and how far it
 * is pushed, 0.4..1, or null inside the dead zone. The throw past the dead
 * zone is stretched over the floor..1 range, so the walk starts at the floor
 * speed as the pad leaves centre and reaches full speed at the rim.
 */
export function stickPush(
  stick: { x: number; y: number } | undefined,
): { x: number; y: number; throw: number } | null {
  if (!stick) return null;
  const len = Math.hypot(stick.x, stick.y);
  if (len <= STICK_DEAD) return null;
  const t = Math.min(1, (len - STICK_DEAD) / (1 - STICK_DEAD));
  return {
    x: stick.x / len,
    y: stick.y / len,
    throw: STICK_MIN_THROW + t * (1 - STICK_MIN_THROW),
  };
}
