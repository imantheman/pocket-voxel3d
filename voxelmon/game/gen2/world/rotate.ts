// A facing turned `quarterTurns` clockwise (up -> right -> down -> left): a
// screen-relative press into the world direction it means with the 3D camera
// swung round, and (turned back) the pose a sprite shows the camera -- the
// Kanto games' rotateDir (world/collision.ts) and poseDir (scene.ts).
// Only the overworld goes through it: a menu is flat on the screen.

export type Facing = "down" | "up" | "left" | "right";

const CYCLE: Facing[] = ["up", "right", "down", "left"];

export function rotateFacing(d: Facing, quarterTurns: number): Facing {
  const i = CYCLE.indexOf(d);
  if (i < 0) return d;
  const q = ((Math.round(quarterTurns) % 4) + 4) % 4;
  return CYCLE[(i + q) % 4]!;
}
