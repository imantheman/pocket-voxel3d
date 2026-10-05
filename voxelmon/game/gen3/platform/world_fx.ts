// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). What the 2D field draws in the map's places, as the voxel
// world's billboards (worldview.ts WorldEnt). FieldView draws its doors and
// field effects in screen px off its camera; drawn with the camera at 0, 0
// under G.captureBegin (graphics.ts), the same calls give textured quads in
// map px, and each becomes
//
//   - a card standing in a cell (the default: splashes, dust, a cut tree,
//     the balloons over heads, particles), its feet on the cell's floor and
//     lifted by how far above the cell's bottom edge the 2D draw put it --
//     the same rule game3_world.ts gives the people;
//   - a decal flat on the floor (what the 2D draw lays on the ground: tracks,
//     ripples, the tall grass's base, the warp arrow, a jumper's shadow);
//   - a decal on a building's facade (the door animations), leaned back as
//     the cook leans the facade, its foot on the door cell's south edge.
//
// Nothing here reads or changes the game; game3_world.ts and worldbench.ts
// decide which quad is which.

import type { CapturedQuad } from "./graphics.ts";
import { Image, ImageData } from "./image.ts";
import { CELL, ENT_CARD, ENT_GROUND, ENT_WALL, type WorldEnt } from "./worldview.ts";

/**
 * The facade's lean back from upright: voxelmon/cook/gen3terrain.ts
 * CARD_LEAN (main.lua:109's card lean at the rest pitch). A facade of up to
 * three rows stands at exactly this lean with its art at full length, so a
 * door's frame of 16 px is 16 px up the facade.
 */
export const FACADE_LEAN = ((90 - 35) * 0.8 * Math.PI) / 180;

/** A captured quad's box in map px and its frame (u0 > u1 when mirrored). */
export interface QuadBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

/** The quad's bounding box, its frame mirrored where the draw flipped it. */
export function quadBox(q: CapturedQuad): QuadBox {
  const p = q.xy;
  const x0 = Math.min(p[0]!, p[2]!, p[4]!, p[6]!), x1 = Math.max(p[0]!, p[2]!, p[4]!, p[6]!);
  const y0 = Math.min(p[1]!, p[3]!, p[5]!, p[7]!), y1 = Math.max(p[1]!, p[3]!, p[5]!, p[7]!);
  // corner 1 left of corner 0: drawn with a negative x scale; corner 3 above 0: negative y
  const flipX = p[2]! < p[0]!, flipY = p[7]! < p[1]!;
  return {
    x0, y0, x1, y1,
    u0: flipX ? q.u1 : q.u0, u1: flipX ? q.u0 : q.u1,
    v0: flipY ? q.v1 : q.v0, v1: flipY ? q.v0 : q.v1,
  };
}

/**
 * A card standing on the floor of the cell whose bottom edge is at `feetY`
 * (map px), lifted by the quad's height above that edge, pulled `pull` px
 * toward the eye past the person it goes with.
 */
export function cardEnt(q: CapturedQuad, feetY: number, pull = 0): WorldEnt {
  const b = quadBox(q);
  return {
    tex: q.img.id, x: (b.x0 + b.x1) / 2, z: feetY - CELL / 2, lift: feetY - b.y1,
    w: b.x1 - b.x0, h: b.y1 - b.y0, u0: b.u0, v0: b.v0, u1: b.u1, v1: b.v1,
    alpha: q.alpha, kind: ENT_CARD, param: pull,
  };
}

/** The cell bottom a card drawn there stands on: the cell holding its bottom row. */
export function feetOf(q: CapturedQuad): number {
  const b = quadBox(q);
  return (Math.floor((b.y1 - 1) / CELL) + 1) * CELL;
}

/** A decal flat on the floor where the 2D draw put it (its top to the north). */
export function groundEnt(q: CapturedQuad): WorldEnt {
  const b = quadBox(q);
  return {
    tex: q.img.id, x: (b.x0 + b.x1) / 2, z: (b.y0 + b.y1) / 2, lift: 0,
    w: b.x1 - b.x0, h: b.y1 - b.y0, u0: b.u0, v0: b.v0, u1: b.u1, v1: b.v1,
    alpha: q.alpha, kind: ENT_GROUND, param: 0,
  };
}

/**
 * A decal up a south-facing facade from `footY` (map px: the south edge of
 * the cell the 2D draw's bottom row is in), as tall up the facade as the
 * quad is tall on the screen.
 */
export function wallEnt(q: CapturedQuad, footY: number, lean = FACADE_LEAN, img?: Image): WorldEnt {
  const b = quadBox(q);
  return {
    tex: (img ?? q.img).id, x: (b.x0 + b.x1) / 2, z: footY, lift: 0,
    w: b.x1 - b.x0, h: b.y1 - b.y0, u0: b.u0, v0: b.v0, u1: b.u1, v1: b.v1,
    alpha: q.alpha, kind: ENT_WALL, param: lean,
  };
}

const backed = new Map<Image, { version: number; img: Image }>();

/**
 * The image with its clear texels filled with `rgb` (0..1), cached: a door's
 * frames are drawn over a dark rectangle -- the room behind the opening
 * door (doors.ts draw) -- which a billboard, cutting clear texels, cannot
 * draw. Undefined for an image the guest holds no pixels of.
 */
export function backedImage(img: Image, rgb: [number, number, number]): Image | undefined {
  const d = img.data;
  if (!d) return undefined;
  const hit = backed.get(img);
  if (hit && hit.version === d.version) {
    hit.img.sync();
    return hit.img;
  }
  const out = new ImageData(d.w, d.h, d.px);
  const px = out.px;
  const r = Math.round(rgb[0] * 255), g = Math.round(rgb[1] * 255), bl = Math.round(rgb[2] * 255);
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3]! / 255;
    px[i] = Math.round(px[i]! * a + r * (1 - a));
    px[i + 1] = Math.round(px[i + 1]! * a + g * (1 - a));
    px[i + 2] = Math.round(px[i + 2]! * a + bl * (1 - a));
    px[i + 3] = 255;
  }
  if (hit) hit.img.release();
  const made = new Image(d.w, d.h, out);
  made.sync(); // the host draws it by id
  backed.set(img, { version: d.version, img: made });
  return made;
}
