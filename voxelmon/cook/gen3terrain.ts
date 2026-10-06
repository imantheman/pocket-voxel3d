// voxelmon/cook/gen3terrain.ts — FireRed's world as geometry: the cell
// classifier and a port of the Voxel Overworld mod's terrain rules.
//
// Licence: MIT. The rules are ported from Gummygamer/gen1recomp-voxel-frlg
// (MIT, Copyright (c) Gummygamer; cloned at ~/voxel-frlg, @7a55b21),
// lib/Terrain.lua -- every rule below cites the line it comes from. Nothing
// here is ported from gen1recomp itself, so this file is outside the gen3
// licence split; the cell classifier is our own, written over the cache's
// ROM data (cook/gen3.ts).
//
// The mod meshes the map at run time from an engine seam we do not have
// (`ctx.cell` -> class wall/void/ground/water/ledge, `hasOver`,
// `overPixels`). `classifyCell` answers the same questions from the cache:
//
//   void   outside the map (the border block, tiled from the map's 0,0)
//   water  a surfable behaviour (MetatileBehavior_IsSurfable's set)
//   ledge  a jump behaviour (MB_JUMP_*; its collision bit is set, so it is
//          asked first)
//   wall   impassable: the grid's collision bits are set (doors included:
//          the game warps on the bump, so a door is part of its house)
//   ground everything else
//   hasOver / overPixels  the metatile's over layer (BG1) has opaque texels
//
// and `meshTerrain` then follows Terrain.lua's `build` cell for cell, over
// the whole map at once (the mod's chunking and streaming are a run-time
// budget, not part of the look). What our pak and renderer cannot say the
// way the mod does is noted where it happens:
//
//   - cards: the mod re-leans prop cards every frame to follow the camera's
//     tilt (Terrain.lua:718). A pak is static, so the cards are stored
//     upright and lean-coded, and the 3DS host's world shader leans them --
//     and, since our camera also swings round, turns them to face it (see
//     "the lean code"; FR_LEAN=0 bakes the lean for the runtime's rest pitch,
//     rung 2, 35 degrees: lean = (90-35)*0.8, main.lua:109, as before). Our
//     terrain pass has no alpha test, so a card is not one quad over keyed
//     art (its clear texels would still write depth): it is the keyed tile
//     cut into opaque rectangles, each its own quad.
//   - over layer: drawn by the mod as a second, depth-biased quad on a solid
//     top ("d", Terrain.lua:537-548). Here the tile page carries the
//     under+over composite and a solid's top samples it -- the same picture
//     without a coplanar decal. An overhead sheet ("o", OVERHEAD) is cut into
//     opaque rectangles like a card.
//   - no lighting: the mod's per-face sun, time of day, sky, haze, lit
//     windows (FACE codes + WINDOW, Gfx.lua's shader) have no slot in a VXPK
//     vertex beyond its colour; faces take spec FACE_SHADE, and the side
//     faces the tile's average colour times that shade (Terrain.lua:218-249).
//   - water is static: the mod rebinds the engine's animated atlas each frame.
//   - buildings: NOT FAITHFUL, on purpose (Isaac's call, 2026-10-05, from a
//     reference shot of how a house should look). The mod's rule makes every
//     cell of a building a flat-topped column (Terrain.lua:512-516) and
//     stands only the bottom row's art on the south face (Terrain.lua:557),
//     so the whole facade lies on the roof and the door row shows twice.
//     Outdoors, a building's run of box cells is instead split into a ROOF
//     (its north rows) and a FACADE (its south rows): the facade stands up,
//     leaned back by the mod's own card lean so it reads at the size the
//     characters do; the roof lies over the rest at the facade's top. See
//     `buildingRuns` below. FR_FACADE=0 cooks the mod's boxes unchanged.
//     The facade's lean follows the camera like the cards' (LEAN), so from
//     the side or behind a building is an upright box under its roof, its
//     sides and back dressed in its own wall art.

import { FACE_SHADE } from "../../contracts/spec/voxel-spec.ts";
import { FACE, type Quad } from "./geom.ts";
import {
  behaviourOf,
  cellAt,
  type FrMap,
  type FrPair,
  LEDGE_BEHAVIOURS,
  MAP_TYPE,
  SURF_BEHAVIOURS,
} from "./gen3.ts";

/** Terrain.lua:22 */
const CELL = 16;

/** Terrain.lua:32-36 -- column tops in game px. */
export const HEIGHT: Record<string, number> = { ground: 0, ledge: 0, water: -3 };
/** Terrain.lua:37 -- by run length 1 / 2 / 3 / 4+. */
export const RUN_HEIGHT = [8, 14, 18, 22];
/** Terrain.lua:40 -- an overhead sheet's height. */
export const OVERHEAD = 18;
/** Terrain.lua:108-112 */
const RUN_REACH = 3;
const MAX_STACK = 8;
export const PROP_MAX_RUN = 3;
export const PROP_VOID = true;
/** Terrain.lua:194 */
export const PROP_MAX_WIDTH = 2;
/** Terrain.lua:274 -- summed channel distance, 0..765. */
const KEY_TOLERANCE = 14;
/** Terrain.lua:705 */
const PROP_LIFT = 0.2;
/**
 * The card lean (radians back from upright): main.lua:109's
 * `(90 - tilt) * 0.8` degrees at the runtime's rest pitch (PITCH_RUNGS[2],
 * 35 degrees off straight down).
 */
export const CARD_LEAN = ((90 - 35) * 0.8 * Math.PI) / 180;

/**
 * The building rule (NOT FAITHFUL -- ours, see the header). Nothing in a
 * metatile says which rows of a building are roof and which are wall: FRLG
 * puts everything above a building's bottom row in the over layer, roof and
 * wall alike, so the player can pass behind it; the over layer only marks
 * "the player may be under this". So the split is by count: the north
 * FACADE_ROOF_MIN rows of a run are roof (40% of a deep one), the rest
 * stands as the facade. That is right for the houses, the lab, the centres,
 * the marts and the gyms (a 5-deep run: 3 roof rows counting the eave row
 * behind, 2 wall rows) and close on the big city blocks.
 */
export const FACADE = process.env.FR_FACADE !== "0";
const FACADE_ROOF_MIN = 3;
const FACADE_ROOF_SHARE = 0.4;
/** The tallest a facade stands, in rows of art at the card lean (~35 px). */
const FACADE_MAX_ROWS = 3;
/** How far the roof's front edge overhangs the facade, game px. */
const ROOF_OVERHANG = 2;
/**
 * The roof plane rises toward its back edge at this many degrees. Fixed: the
 * 3DS host's world shader knows it too (g3_world.c G3_ROOF_RISE_DEG), since
 * the rise is redrawn with the lean.
 */
const ROOF_RISE_DEG = 12;

// ---------------------------------------------------------------------------
// the lean code (ours: the camera-following lean, 2026-10-05)
// ---------------------------------------------------------------------------
//
// A pak is static, but the mod re-leans its cards every frame (Terrain.lua:
// 718) and our host's camera also swings round the map, which no baked lean
// survives: seen from the side a baked facade is a slanted parallelogram over
// flat grey walls, and a baked card an edge-on streak. So with LEAN the cook
// stores the buildings and the cards at the REST pose (the lean the static
// rule used, CARD_LEAN, facing south: what an older host draws, and the
// bounds the host culls by) and tags each vertex with what the lean does
// to it from there; the 3DS host's world
// shader (crates/pocketvoxel-3ds/src/gen3/g3_world.pica) applies the lean
// for the frame's camera:
//
//   - a building (its facade, roof, side and back walls) leans its facade
//     back by the mod's card lean at the CURRENT pitch, (90 - pitch) * 0.8
//     degrees (main.lua:109), while the camera looks at the south front:
//     all of it within 10 degrees of the default yaw, eased to none by 28
//     (gen3/mod.rs facade_weight). At the rest pitch from the south that is
//     CARD_LEAN, exactly today's look; turned further the building is a
//     true box -- upright front, side and back walls meeting at the
//     corners -- under a real sloped roof, its sides and back dressed in its
//     own wall art.
//   - a built prop (a fence, a sign, a mailbox, a post, a railing, a small
//     building the mod stands as a card -- every card that is not foliage)
//     is world geometry: it keeps its place and its line along x, and
//     leans exactly as a facade does (upright once the camera turns away),
//     with its silhouette extruded a few px deep (a small building as deep
//     as its stack) as the lean fades. One exception: a narrow stack of
//     three or more rows is a fence or railing running north-south, which
//     the mod's stacking stands as one tall card; it lies down onto its own
//     cells as the camera turns (its art is drawn from above), rather than
//     standing up as a wall across the street.
//     Which cards are built and which are foliage is the mod's own colour
//     test (Keyed.foliage), not an id table: it needs no per-map data and
//     it already sorted FireRed's trees and bushes from its fences, signs
//     and posts in every map checked (the first town, the big city, Route
//     4). Ledges, water and its edges, paths and tall grass are terrain,
//     not cards, and are untouched by any of this.
//   - foliage (a tree, a bush: the mod's own foliage test, Keyed.foliage,
//     Terrain.lua:338-360 -- the cell's art is mostly green) turns about its
//     foot to face the camera's yaw and leans back by the card lean, as the
//     mod's cards and our people do. A two-cell tree turns as one card
//     about its middle.
//
// Two of these ideas -- dressing a building's sides and back in its own
// plain wall art, and turning a two-cell tree as one card -- come from
// ZallaxDev/pokeemerald-3Ds-dualscreen (MIT, Copyright (c) 2026 ZallaxDev and
// its contributors; 3ds_port/scripts/voxel_building.py and
// 3ds_port/src/voxel/voxel_tree.c, read at 38dac1e; THIRD_PARTY_NOTICES.md).
// No code of theirs is here: their buildings are modelled by hand.
//
// The vertex's colour alpha says which (255: no lean, drawn as stored), and
// the colour bytes plus the vertex's spare i16 (`w`) carry the numbers --
// see g3_world.pica's header for the decoding. FR_LEAN=0 bakes the old
// static lean instead (no codes), for an A/B.
export const LEAN = process.env.FR_LEAN !== "0";
const ROOF_T = Math.tan((ROOF_RISE_DEG * Math.PI) / 180);

/**
 * A building vertex: stored upright, it moves by
 *   y' = y + K (cos t - 1) - T B sin t,   z' = z - A sin t
 * for the facade lean t (T = ROOF_T). Shade 0..1. K is held in half px up to
 * 127.5 (a taller stack of built props leans its top a little short).
 */
export function buildingCode(shade: number, K: number, A: number, B: number): { w: number; abgr: number } {
  const w = Math.round(A * 64);
  const r = Math.min(255, Math.round(K * 2));
  const b256 = Math.round(B * 256);
  const a = Math.round(shade * 127);
  if (w < 0 || w > 32767 || r < 0 || r > 255 || b256 < 0 || b256 > 65535 || a < 0 || a > 127) {
    throw new Error(`lean code out of range: K ${K} A ${A} B ${B} shade ${shade}`);
  }
  return { w, abgr: ((a << 24) | ((b256 & 255) << 16) | ((b256 >> 8) << 8) | r) >>> 0 };
}

/**
 * A lying prop vertex `K` px up its card (shade 1, alpha 254): it leans by
 * the card lean at the default view and on down to lie flat as the facade
 * lean fades (g3_world.pica: y' = y + K (cos u - 1), z' = z - K sin u).
 */
export function lyingCode(K: number): { w: number; abgr: number } {
  return { w: 0, abgr: (0xfeffff00 | Math.min(255, Math.round(K * 2))) >>> 0 };
}

/** A foliage card vertex `dx` px east of its pivot, `K` px up the card (shade 1: alpha 191). */
export function cardCode(dx: number, K: number): { w: number; abgr: number } {
  const w = Math.round(dx * 64);
  if (w < -32768 || w > 32767) throw new Error(`card pivot out of range: ${dx}`);
  return { w, abgr: (0xbfffff00 | Math.min(255, Math.round(K * 2))) >>> 0 };
}

/**
 * A built prop vertex `K` px up its card, stored upright on the card's
 * plane; it leans as a facade does (y' = y + K (cos t - 1), z' = z - K sin t)
 * and is pushed `D` px back by as much as the facade lean has faded
 * (z' -= D (1 - weight)): the prop's depth, none at the default view.
 */
export function propCode(shade: number, K: number, D: number): { w: number; abgr: number } {
  const w = Math.round(D * 64);
  const r = Math.min(255, Math.round(K * 2));
  const a = 192 + Math.round(shade * 61);
  if (w < 0 || w > 32767 || r < 0) throw new Error(`prop code out of range: K ${K} D ${D}`);
  return { w, abgr: ((a << 24) | 0x00ff_ff00 | r) >>> 0 };
}

/** The most texels of one colour in a slot's under+over composite (a plain wall scores high). */
function plainness(pair: FrPair, slot: number): number {
  const W = pair.cols * 16;
  const sx = (slot % pair.cols) * 16;
  const sy = Math.floor(slot / pair.cols) * 16;
  const hist = new Map<number, number>();
  let best = 0;
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const i = (sy + y) * W + sx + x;
      const o = pair.over[i]!;
      const k = o !== 0 ? o : pair.under[i]! + 256;
      const n = (hist.get(k) ?? 0) + 1;
      hist.set(k, n);
      if (n > best) best = n;
    }
  }
  return best;
}

/** How many cells of border the cook meshes around a map (the Gen 1 cook's
 * RING: 12 tiles = 6 cells, cook/structures.ts). */
export const RING_CELLS = 6;

export type CellClass = "void" | "water" | "wall" | "ledge" | "ground";

export interface CellRec {
  class: CellClass;
  /** Atlas slot of the cell's metatile. */
  slot: number;
  hasOver: boolean;
  overPixels: number;
}

// ---------------------------------------------------------------------------
// the classifier (ours: the cache's ROM data in place of the mod's ctx.cell)
// ---------------------------------------------------------------------------

/** Opaque over-layer texels per atlas slot. */
function overCounts(pair: FrPair): Uint16Array {
  const W = pair.cols * 16;
  const n = new Uint16Array(pair.cols * pair.rows);
  for (let slot = 0; slot < n.length; slot++) {
    const sx = (slot % pair.cols) * 16;
    const sy = Math.floor(slot / pair.cols) * 16;
    let c = 0;
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (pair.over[(sy + y) * W + sx + x] !== 0) c++;
    n[slot] = c;
  }
  return n;
}

const overCache = new WeakMap<FrPair, Uint16Array>();

export function slotOf(pair: FrPair, mid: number): number {
  return pair.midToSlot.get(mid) ?? pair.midToSlot.get(0) ?? 0;
}

/** One cell as the mod's `ctx.cell` would answer it (see the header). */
export function classifyCell(root: string, map: FrMap, pair: FrPair, cx: number, cy: number): CellRec {
  let over = overCache.get(pair);
  if (!over) overCache.set(pair, (over = overCounts(pair)));
  const c = cellAt(map, cx, cy);
  const slot = slotOf(pair, c.mid);
  let cls: CellClass;
  if (!c.inside) cls = "void";
  else {
    const mb = behaviourOf(root, map, c.mid);
    // a ledge's grid collision bit is SET (the jump is the only way across),
    // so the behaviour is asked before the bit
    if (SURF_BEHAVIOURS.has(mb)) cls = "water";
    else if (LEDGE_BEHAVIOURS.has(mb)) cls = "ledge";
    else if (c.coll !== 0) cls = "wall";
    else cls = "ground";
  }
  const overPixels = over[slot] ?? 0;
  return { class: cls, slot, hasOver: overPixels > 0, overPixels };
}

// ---------------------------------------------------------------------------
// keying a pair's ground colour away (Terrain.lua:265-396)
// ---------------------------------------------------------------------------

export interface Keyed {
  /** Terrain.lua:316 -- the ground colour. */
  ground: [number, number, number];
  isGround: (rgb: [number, number, number]) => boolean;
  /** Terrain.lua:392 -- the slot that is nearly all ground, or null. */
  plain: number | null;
  foliage: boolean[];
  groundish: boolean[];
}

const keyedCache = new WeakMap<FrPair, Keyed | null>();

const rgbKey = (c: [number, number, number]): number => c[0] * 65536 + c[1] * 256 + c[2];

/** `keyed(ts)`, Terrain.lua:276. Null when no ground colour wins (Terrain.lua:312). */
export function keyed(pair: FrPair): Keyed | null {
  const hit = keyedCache.get(pair);
  if (hit !== undefined) return hit;
  const W = pair.cols * 16;
  const slots = pair.cols * pair.rows;
  const under = (slot: number, x: number, y: number) =>
    pair.rgb[pair.under[(Math.floor(slot / pair.cols) * 16 + y) * W + (slot % pair.cols) * 16 + x]!]!;
  const overByte = (slot: number, x: number, y: number) =>
    pair.over[(Math.floor(slot / pair.cols) * 16 + y) * W + (slot % pair.cols) * 16 + x]!;
  // Terrain.lua:284-311: a tile votes for its commonest colour when that
  // covers a quarter of it; the ground is the colour with the most votes.
  const votes = new Map<number, number>();
  let bestKey: number | null = null;
  let bestN = 0;
  for (let slot = 0; slot < slots; slot++) {
    const hist = new Map<number, number>();
    let top: number | null = null;
    let topN = 0;
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        // the under layer is opaque everywhere (a > 0.5 always)
        const k = rgbKey(under(slot, x, y));
        const n = (hist.get(k) ?? 0) + 1;
        hist.set(k, n);
        if (n > topN) {
          top = k;
          topN = n;
        }
      }
    }
    if (top !== null && topN >= 64) {
      const n = (votes.get(top) ?? 0) + 1;
      votes.set(top, n);
      if (n > bestN) {
        bestKey = top;
        bestN = n;
      }
    }
  }
  if (bestKey === null) {
    keyedCache.set(pair, null);
    return null;
  }
  const g: [number, number, number] = [Math.floor(bestKey / 65536), Math.floor(bestKey / 256) % 256, bestKey % 256];
  // Terrain.lua:317
  const isGround = (c: [number, number, number]) =>
    Math.abs(c[0] - g[0]) + Math.abs(c[1] - g[1]) + Math.abs(c[2] - g[2]) <= KEY_TOLERANCE;
  // Terrain.lua:338: greenish (g >= r and g - b >= 0.04, channels 0..1)
  const greenish = (c: [number, number, number]) => c[1] >= c[0] && (c[1] - c[2]) / 255 >= 0.04;
  let plain: number | null = null;
  let plainN = 0;
  const foliage: boolean[] = [];
  const groundish: boolean[] = [];
  for (let slot = 0; slot < slots; slot++) {
    let n = 0;
    let other = 0;
    let green = 0;
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const c = under(slot, x, y);
        if (isGround(c)) n++;
        else {
          other++;
          if (greenish(c)) green++;
        }
      }
    }
    if (n > plainN) {
      plain = slot;
      plainN = n;
    }
    foliage[slot] = other >= 30 && green / other >= 0.5;
    // Terrain.lua:346-360: a tree's centre tile is all over layer
    if (!foliage[slot]) {
      let on = 0;
      let og = 0;
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          const b = overByte(slot, x, y);
          if (b === 0) continue;
          const c = pair.rgb[b]!;
          if (isGround(c)) continue;
          on++;
          if (greenish(c)) og++;
        }
      }
      foliage[slot] = on >= 30 && og / on >= 0.5;
    }
    // Terrain.lua:364
    groundish[slot] = n >= 110;
  }
  const k: Keyed = { ground: g, isGround, plain: plainN >= 230 ? plain : null, foliage, groundish };
  keyedCache.set(pair, k);
  return k;
}

/** averageColour(ts, slot), Terrain.lua:227: the under layer's mean colour. */
export function averageColour(pair: FrPair, slot: number): [number, number, number] {
  const W = pair.cols * 16;
  const sx = (slot % pair.cols) * 16;
  const sy = Math.floor(slot / pair.cols) * 16;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const c = pair.rgb[pair.under[(sy + y) * W + sx + x]!]!;
      r += c[0];
      g += c[1];
      b += c[2];
    }
  }
  return [r / 256, g / 256, b / 256];
}

/**
 * The same over the under+over composite. NOT FAITHFUL (the building rule):
 * a roof cell's under layer is the ground below the eave, so its average is
 * grass; a building's side walls take the composite of its wall instead.
 */
export function averageColourFull(pair: FrPair, slot: number): [number, number, number] {
  const W = pair.cols * 16;
  const sx = (slot % pair.cols) * 16;
  const sy = Math.floor(slot / pair.cols) * 16;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const i = (sy + y) * W + sx + x;
      const o = pair.over[i]!;
      const c = pair.rgb[o !== 0 ? o : pair.under[i]!]!;
      r += c[0];
      g += c[1];
      b += c[2];
    }
  }
  return [r / 256, g / 256, b / 256];
}

/** The first texel row of a slot's over layer with anything in it (16 if none). */
function firstOverRow(pair: FrPair, slot: number): number {
  const W = pair.cols * 16;
  const sx = (slot % pair.cols) * 16;
  const sy = Math.floor(slot / pair.cols) * 16;
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (pair.over[(sy + y) * W + sx + x] !== 0) return y;
  return 16;
}

// ---------------------------------------------------------------------------
// what stands up, and what stands as a card (Terrain.lua:93-216)
// ---------------------------------------------------------------------------

type Get = (x: number, y: number) => CellRec | null;

/** Terrain.lua:116 */
function solidRec(r: CellRec | null): boolean {
  return r !== null && (r.class === "wall" || r.class === "void");
}

/** Terrain.lua:120 */
function attachedAt(get: Get, x: number, y: number, depth: number): boolean {
  const r = get(x, y);
  if (!(r && r.class === "ground" && r.hasOver)) return false;
  const south = get(x, y + 1);
  if (!south) return false;
  return solidRec(south) || (depth < RUN_REACH && attachedAt(get, x, y + 1, depth + 1));
}

/** Terrain.lua:128 */
function solidish(get: Get, x: number, y: number): boolean {
  const r = get(x, y);
  return r !== null && (solidRec(r) || attachedAt(get, x, y, 0));
}

/** Terrain.lua:136 -- the border is not part of any structure. */
function structureCell(get: Get, x: number, y: number): boolean {
  const r = get(x, y);
  if (r === null || r.class === "void") return false;
  return solidish(get, x, y);
}

/** Terrain.lua:142 */
function runAt(get: Get, x: number, y: number): number {
  let run = 1;
  for (let d = 1; d <= RUN_REACH; d++) {
    if (!structureCell(get, x, y - d)) break;
    run++;
  }
  for (let d = 1; d <= RUN_REACH; d++) {
    if (!structureCell(get, x, y + d)) break;
    run++;
  }
  return run;
}

/** Terrain.lua:158 */
function foliageCell(get: Get, k: Keyed | null, x: number, y: number): boolean {
  const r = get(x, y);
  if (!(r && r.class === "wall")) return false;
  if (k === null) return false;
  return k.foliage[r.slot] === true || ((!r.hasOver || r.overPixels <= 24) && k.groundish[r.slot] === true);
}

/** Terrain.lua:169 */
function groveAt(get: Get, k: Keyed | null, x: number, y: number): boolean {
  if (foliageCell(get, k, x, y)) return true;
  for (const dir of [-1, 1]) {
    for (let d = 1; d <= RUN_REACH; d++) {
      if (!structureCell(get, x, y + dir * d)) break;
      if (foliageCell(get, k, x, y + dir * d)) return true;
    }
  }
  return false;
}

/** Terrain.lua:182 */
function widthAt(get: Get, x: number, y: number): number {
  let width = 1;
  for (let d = 1; d <= 3; d++) {
    if (!structureCell(get, x - d, y)) break;
    width++;
  }
  for (let d = 1; d <= 3; d++) {
    if (!structureCell(get, x + d, y)) break;
    width++;
  }
  return width;
}

/** Terrain.lua:199 */
function isProp(get: Get, k: Keyed | null, x: number, y: number, outdoor: boolean, depth = 0): boolean {
  if (!outdoor) return false;
  const r = get(x, y);
  if (!r) return false;
  if (r.class === "void") return PROP_VOID;
  if (r.class === "wall") {
    return runAt(get, x, y) <= PROP_MAX_RUN || widthAt(get, x, y) <= PROP_MAX_WIDTH || groveAt(get, k, x, y);
  }
  if (depth < RUN_REACH && attachedAt(get, x, y, 0)) return isProp(get, k, x, y + 1, outdoor, depth + 1);
  return false;
}

/** Terrain.lua:214 */
function runHeight(run: number): number {
  return RUN_HEIGHT[Math.min(run, RUN_HEIGHT.length) - 1]!;
}

// ---------------------------------------------------------------------------
// the mesh (Terrain.lua:402-598, cards Terrain.lua:718-766)
// ---------------------------------------------------------------------------

/** Where the tile page keeps each picture of a slot (cook/gen3cook.ts). */
export interface TileArt {
  /** Top-left page px of a slot's under layer. */
  under(slot: number): [number, number];
  /** Top-left page px of a slot's under+over composite. */
  full(slot: number): [number, number];
  /** Centre page px of an opaque white texel block (flat-colour faces). */
  white: [number, number];
}

export interface TerrainStats {
  cells: number;
  walls: number;
  water: number;
  ledges: number;
  voids: number;
  props: number;
  cards: number;
  boxes: number;
  sheets: number;
  /** Building runs stood as roof + facade (the building rule). */
  facades: number;
}

export interface TerrainGeometry {
  /** Tops and sides: the ground, the boxes, the indoor border wall. */
  terrain: Quad[];
  /** Water tops (sunk to HEIGHT.water). */
  water: Quad[];
  /** Prop cards, cut into opaque rectangles. */
  cards: Quad[];
  /** Overhead sheets, cut likewise. */
  sheets: Quad[];
  stats: TerrainStats;
  /** Per cell of the meshed area, the class, height and prop flag (debug). */
  grid: { x0: number; y0: number; w: number; h: number; cls: string[]; height: number[]; prop: boolean[] };
}

/** Pack an ABGR colour from 0..255 channels. */
function abgr(r: number, g: number, b: number): number {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return (0xff000000 | (c(b) << 16) | (c(g) << 8) | c(r)) >>> 0;
}

/** INSET, the sliver every UV edge is pulled in by (mesh.ts INSET; Terrain.lua:492's e). */
const E = 0.02;

/**
 * Cut a 16x16 mask into opaque rectangles: column runs, then neighbouring
 * columns with the same run merged. Tall pieces, so a leaned card's rounded
 * integer corners rarely collapse a piece to nothing.
 */
function rects(mask: (x: number, y: number) => boolean): [number, number, number, number][] {
  const runs: [number, number, number, number][] = []; // x0, x1, y0, y1 (exclusive ends)
  let open = new Map<string, [number, number, number, number]>();
  for (let x = 0; x < 16; x++) {
    const next = new Map<string, [number, number, number, number]>();
    let y = 0;
    while (y < 16) {
      if (!mask(x, y)) {
        y++;
        continue;
      }
      const y0 = y;
      while (y < 16 && mask(x, y)) y++;
      const key = `${y0},${y}`;
      const prev = open.get(key);
      if (prev && prev[1] === x) {
        prev[1] = x + 1;
        next.set(key, prev);
      } else {
        const r: [number, number, number, number] = [x, x + 1, y0, y];
        runs.push(r);
        next.set(key, r);
      }
    }
    open = next;
  }
  return runs;
}

type CellInfo = { rec: CellRec; h: number; prop: boolean; attached: boolean };

/** One column of a building, stood as roof + facade (the building rule). */
interface BuildingRun {
  x: number;
  /** First (north) and last (south) cell of the run; first facade row. */
  ya: number;
  yb: number;
  yf: number;
  /** Facade: foot z (the run's south edge), top z and height. */
  zs: number;
  zt: number;
  H: number;
  /** Roof back edge z and height; texel rows of the back row left off. */
  zn: number;
  Hb: number;
  skip: number;
  /** Every run, by each of its cells (shared). */
  byCell: Map<number, BuildingRun>;
  /**
   * LEAN: the facade's height and depth coefficients (its top stands at
   * Ky cos t, zs - Sz sin t for the lean t; at CARD_LEAN that is H, zt), and
   * the building's plainest wall cell per facade row from the bottom (its
   * sides and back are dressed in them).
   */
  Ky: number;
  Sz: number;
  sideArt: number[];
}

/**
 * NOT FAITHFUL (see FACADE): find the outdoor buildings and lay out each
 * column of one. A building cell is a box the mod would raise (Terrain.lua:
 * 449-450: a wall, or an overhang attached to one, that is not a prop); a
 * run is the cells of one column of them, north to south. Its south rows are
 * the facade, the rest the roof (FACADE_ROOF_MIN / _SHARE). The facade is
 * leaned back by the mod's card lean (CARD_LEAN, main.lua:109) with its art
 * at full length, so it stands as tall as the characters read; every run of
 * one building (4-connected) takes the height of its commonest facade, so a
 * roof is one level. Runs shorter than four cells keep the mod's boxes.
 */
function buildingRuns(
  pair: FrPair,
  info: Map<number, CellInfo>,
  key: (x: number, y: number) => number,
  mx0: number,
  my0: number,
  mw: number,
  mh: number,
): BuildingRun[] {
  const isBuilding = (x: number, y: number): boolean => {
    const c = info.get(key(x, y));
    return !!c && !c.prop && c.h > 0 && (c.rec.class === "wall" || c.attached);
  };
  const byCell = new Map<number, BuildingRun>();
  const runs: BuildingRun[] = [];
  const facadeRows = new Map<BuildingRun, number>();
  for (let x = mx0; x < mx0 + mw; x++) {
    let y = my0;
    while (y < my0 + mh) {
      if (!isBuilding(x, y)) {
        y++;
        continue;
      }
      const ya = y;
      while (y < my0 + mh && isBuilding(x, y)) y++;
      const yb = y - 1;
      const L = yb - ya + 1;
      if (L < 4) continue;
      const R = Math.max(FACADE_ROOF_MIN, Math.round(L * FACADE_ROOF_SHARE));
      const run: BuildingRun = { x, ya, yb, yf: ya + R, zs: 0, zt: 0, H: 0, zn: 0, Hb: 0, skip: 0, byCell, Ky: 0, Sz: 0, sideArt: [] };
      runs.push(run);
      facadeRows.set(run, L - R);
      for (let yy = ya; yy <= yb; yy++) byCell.set(key(x, yy), run);
    }
  }
  // one height per building: its commonest facade (ties to the lower)
  const seen = new Set<BuildingRun>();
  const cosL = Math.cos(CARD_LEAN);
  for (const start of runs) {
    if (seen.has(start)) continue;
    const comp: BuildingRun[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const r = stack.pop()!;
      comp.push(r);
      for (let yy = r.ya; yy <= r.yb; yy++) {
        for (const nx of [r.x - 1, r.x + 1]) {
          const n = byCell.get(key(nx, yy));
          if (n && !seen.has(n)) {
            seen.add(n);
            stack.push(n);
          }
        }
      }
    }
    const votes = new Map<number, number>();
    for (const r of comp) votes.set(facadeRows.get(r)!, (votes.get(facadeRows.get(r)!) ?? 0) + 1);
    let F = 0;
    let best = -1;
    for (const [f, n] of [...votes].sort((a, b) => a[0] - b[0])) {
      if (n > best) {
        F = f;
        best = n;
      }
    }
    // a deep city block would stand as tall as its whole facade and hide the
    // streets behind it: its facade leans further back instead
    const H = Math.round(CELL * Math.min(F, FACADE_MAX_ROWS) * cosL);
    // LEAN: the same facade as coefficients of the lean (see BuildingRun).
    // A facade of up to three rows is its art leaned rigidly (Sz = Ky = its
    // length); a deeper one keeps the capped height and leans further back.
    // Sz stops at 255 px, what the lean code holds (a facade of 11+ rows
    // then leans a little less than the cook's rule).
    const Ky = CELL * Math.min(F, FACADE_MAX_ROWS);
    const H0 = Ky * cosL;
    const sinL = Math.sin(CARD_LEAN);
    // the plainest wall cell of each facade row, counted from the bottom
    const sideArt: number[] = [];
    for (let row = 0; ; row++) {
      let best = -1;
      let slot = -1;
      for (const r of comp) {
        if (r.yb - row < r.yf) continue;
        const s = info.get(key(r.x, r.yb - row))!.rec.slot;
        const p = plainness(pair, s);
        if (p > best) {
          best = p;
          slot = s;
        }
      }
      if (slot < 0) break;
      sideArt.push(slot);
    }
    for (const r of comp) {
      const len = CELL * (r.yb - r.yf + 1);
      r.Ky = Ky;
      r.Sz = len > H0 ? Math.min(255, Math.round((Math.sqrt(len * len - H0 * H0) / sinL) * 64) / 64) : 0;
      r.sideArt = sideArt;
    }
    for (const r of comp) {
      const len = CELL * (r.yb - r.yf + 1);
      r.zs = (r.yb + 1) * CELL;
      r.zt = r.zs - (len > H ? Math.sqrt(len * len - H * H) : 0);
      r.H = H;
      // the back row of a roof is often the eave over open ground (an
      // attached cell, Terrain.lua:120): its picture starts where the eave does
      const back = info.get(key(r.x, r.ya))!;
      r.skip = back.rec.class === "ground" ? Math.min(CELL - 1, firstOverRow(pair, back.rec.slot)) : 0;
      r.zn = r.ya * CELL + r.skip;
      if (r.zt > r.zn) {
        r.Hb = H + (r.zt - r.zn) * Math.tan((ROOF_RISE_DEG * Math.PI) / 180);
      } else {
        r.zn = r.zt;
        r.Hb = H;
      }
    }
  }
  return runs;
}

export function meshTerrain(root: string, map: FrMap, pair: FrPair, art: TileArt): TerrainGeometry {
  // Terrain.lua:427 -- open sky, and not under the sea
  const outdoor = map.outdoor && map.mapType !== MAP_TYPE.underwater;
  const k = keyed(pair);

  // every cell anyone reads: the meshed ring, plus what the rules reach past it
  const PAD = RING_CELLS + RUN_REACH + MAX_STACK + 2;
  const gx0 = -PAD;
  const gy0 = -PAD;
  const gw = map.width + 2 * PAD;
  const gh = map.height + 2 * PAD;
  const recs: CellRec[] = [];
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) recs.push(classifyCell(root, map, pair, gx0 + x, gy0 + y));
  const get: Get = (x, y) => {
    const ix = x - gx0;
    const iy = y - gy0;
    if (ix < 0 || iy < 0 || ix >= gw || iy >= gh) return classifyCell(root, map, pair, x, y);
    return recs[iy * gw + ix]!;
  };

  // classify every meshed cell (+1 skirt for the sides): Terrain.lua:438-456
  const mx0 = -RING_CELLS;
  const my0 = -RING_CELLS;
  const mw = map.width + 2 * RING_CELLS;
  const mh = map.height + 2 * RING_CELLS;
  const info = new Map<number, { rec: CellRec; h: number; prop: boolean; attached: boolean }>();
  const key = (x: number, y: number) => (y + 4096) * 8192 + (x + 4096);
  for (let y = my0 - 1; y <= my0 + mh; y++) {
    for (let x = mx0 - 1; x <= mx0 + mw; x++) {
      const c = get(x, y)!;
      const attached = attachedAt(get, x, y, 0);
      let h: number;
      let prop = false;
      if (isProp(get, k, x, y, outdoor)) {
        prop = true;
        h = 0;
      } else if (c.class === "void") {
        // indoors the border is a tall dark wall all round the room
        h = runHeight(RUN_HEIGHT.length);
      } else if (attached || solidRec(c)) {
        h = runHeight(runAt(get, x, y));
      } else {
        h = HEIGHT[c.class] ?? 0;
      }
      info.set(key(x, y), { rec: c, h, prop, attached });
    }
  }

  const terrain: Quad[] = [];
  const water: Quad[] = [];
  const cards: Quad[] = [];
  const sheets: Quad[] = [];
  const stats: TerrainStats = { cells: 0, walls: 0, water: 0, ledges: 0, voids: 0, props: 0, cards: 0, boxes: 0, sheets: 0, facades: 0 };
  const runs = FACADE && outdoor ? buildingRuns(pair, info, key, mx0, my0, mw, mh) : [];
  const inRun = new Set<number>();
  for (const run of runs) for (let y = run.ya; y <= run.yb; y++) inRun.add(key(run.x, y));
  const grid = { x0: mx0, y0: my0, w: mw, h: mh, cls: [] as string[], height: [] as number[], prop: [] as boolean[] };
  const white = art.white;
  const cosL = Math.cos(CARD_LEAN);
  const sinL = Math.sin(CARD_LEAN);
  const PW = pair.cols * 16;
  const isGroundAt = (layer: Uint8Array, slot: number, x: number, y: number): boolean | null => {
    const b = layer[(Math.floor(slot / pair.cols) * 16 + y) * PW + (slot % pair.cols) * 16 + x]!;
    if (layer === pair.over && b === 0) return null; // clear
    return k ? k.isGround(pair.rgb[b]!) : false;
  };
  // a card's keyed art (Terrain.lua:755-756): the over layer's non-ground
  // texels win over the under layer's
  const cardMasks = (r: CellRec) => {
    const fromOver = (x2: number, y2: number) => r.hasOver && isGroundAt(pair.over, r.slot, x2, y2) === false;
    const fromUnder = (x2: number, y2: number) => !fromOver(x2, y2) && isGroundAt(pair.under, r.slot, x2, y2) === false;
    return { fromOver, fromUnder };
  };
  // Terrain.lua:520-533: how many prop cells below this one its card stacks on
  const belowOf = (x: number, y: number): number => {
    let below = 0;
    for (let d = 1; d <= MAX_STACK; d++) {
      if (isProp(get, k, x, y + d, outdoor)) below++;
      else break;
    }
    return below >= MAX_STACK ? 0 : below;
  };

  // LEAN: the foliage cards' pivots, the foot of the vertical axis each
  // turns about (a card with no pivot is a built prop and leans like a
  // facade instead). A column's stack of cards -- every prop cell standing
  // on one foot -- is foliage when any of its cells is (the trunk row of a
  // tree is often not green itself). Foliage stacks on the same foot row in
  // neighbouring columns turn together in pairs, as one card about their
  // seam, where the two read as one picture: their art runs on across the
  // seam and stops at the outer edges, as a two-cell tree's halves do
  // (Terrain.lua:194 PROP_MAX_WIDTH, the widest prop). A lone column, or a
  // run whose seams carry no more art than its outer edges, turns column by
  // column.
  const pivots = new Map<number, number>();
  // LEAN: the built props' stacks, by foot: how many rows, and whether a
  // neighbouring column on the same foot is built too (a wide thing: a
  // small building, a fence along x). A narrow stack of three or more rows
  // is a fence or railing running north-south, which the mod's stacking
  // stands up as one tall card: it lies down onto its own cells as the
  // camera turns, rather than standing up as a wall (see "the lean code").
  const built = new Map<number, { rows: number; wide: boolean }>();
  if (LEAN && k !== null) {
    type Stack = { edge: [number, number]; foliage: boolean; rows: number };
    // (foot row) -> column -> its stack
    const feet = new Map<number, Map<number, Stack>>();
    for (let y = my0; y < my0 + mh; y++) {
      for (let x = mx0; x < mx0 + mw; x++) {
        const c = info.get(key(x, y))!;
        if (!c.prop || inRun.has(key(x, y))) continue;
        const foot = y + belowOf(x, y);
        let row = feet.get(foot);
        if (!row) feet.set(foot, (row = new Map()));
        const st = row.get(x) ?? { edge: [0, 0], foliage: false, rows: 0 };
        st.rows++;
        if (k.foliage[c.rec.slot]) st.foliage = true;
        const { fromOver, fromUnder } = cardMasks(c.rec);
        for (let ty = 0; ty < 16; ty++) {
          if (fromOver(0, ty) || fromUnder(0, ty)) st.edge[0]++;
          if (fromOver(15, ty) || fromUnder(15, ty)) st.edge[1]++;
        }
        row.set(x, st);
      }
    }
    for (const [foot, row] of feet) {
      const isBuilt = (x: number) => row.has(x) && !row.get(x)!.foliage;
      for (const [x, st] of row) {
        if (!st.foliage) built.set(key(x, foot), { rows: st.rows, wide: isBuilt(x - 1) || isBuilt(x + 1) });
      }
      const xs = [...row.keys()].filter((x) => row.get(x)!.foliage).sort((a, b) => a - b);
      let i = 0;
      while (i < xs.length) {
        // a run xs[i..j] of neighbouring foliage columns
        let j = i;
        while (j + 1 < xs.length && xs[j + 1] === xs[j]! + 1) j++;
        // pairs, in the phase whose seams carry the most art
        const score = (phase: number): number => {
          let sc = 0;
          for (let p = i + phase; p + 1 <= j; p += 2) {
            const a = row.get(xs[p]!)!.edge;
            const b = row.get(xs[p + 1]!)!.edge;
            sc += a[1] + b[0] - a[0] - b[1];
          }
          return sc;
        };
        const s0 = score(0);
        const s1 = score(1);
        const phase = s0 >= s1 ? 0 : 1;
        const paired = Math.max(s0, s1) > 0;
        for (let p = i; p <= j; p++) {
          const x = xs[p]!;
          let pivot = x * CELL + CELL / 2;
          if (paired && p >= i + phase) {
            const first = (p - i - phase) % 2 === 0;
            if (first && p + 1 <= j) pivot = (x + 1) * CELL;
            else if (!first) pivot = x * CELL;
          }
          pivots.set(key(x, foot), pivot);
        }
        i = j + 1;
      }
    }
  }

  for (let ly = 0; ly < mh; ly++) {
    for (let lx = 0; lx < mw; lx++) {
      const x = mx0 + lx;
      const y = my0 + ly;
      const c = info.get(key(x, y))!;
      const r = c.rec;
      stats.cells++;
      if (r.class === "wall") stats.walls++;
      else if (r.class === "water") stats.water++;
      else if (r.class === "ledge") stats.ledges++;
      else if (r.class === "void") stats.voids++;
      if (c.prop) stats.props++;
      grid.cls.push(r.class);
      grid.height.push(c.h);
      grid.prop.push(c.prop);
      // a building's cells are meshed by their run (below)
      if (inRun.has(key(x, y))) continue;

      const wx = x * CELL;
      const wz = y * CELL;
      const h = c.h;
      // Terrain.lua:502-505: a prop's own cell is laid with the plain slot
      const key_ = c.prop ? k : null;
      const groundSlot = key_ && key_.plain !== null ? key_.plain : r.slot;
      const card = c.prop && key_ !== null;
      // the top's picture: the under layer, or -- on a solid -- the
      // under+over composite (the mod's "d" decal, Terrain.lua:537-548)
      const decal = r.hasOver && !card && h > 0;
      const [tx, ty] = decal ? art.full(groundSlot) : art.under(groundSlot);
      const [ux, uy] = art.under(groundSlot);
      const top: Quad = {
        c: [
          [wx, h, wz],
          [wx + CELL, h, wz],
          [wx + CELL, h, wz + CELL],
          [wx, h, wz + CELL],
        ],
        uv: [
          [tx + E, ty + E],
          [tx + CELL - E, ty + E],
          [tx + CELL - E, ty + CELL - E],
          [tx + E, ty + CELL - E],
        ],
        shade: FACE_SHADE.up,
        f: FACE.up,
      };
      // Terrain.lua:513-516 -- top face; water sinks into its own stream
      (r.class === "water" ? water : terrain).push(top);
      if (h > 0) stats.boxes++;

      // Terrain.lua:520-533 -- a prop stands as a card, stacked on the prop
      // cells below it in its column
      if (card) {
        const below = belowOf(x, y);
        const zfoot = (y + below + 1) * CELL;
        // Terrain.lua:723-747: one 16x16 card per cell, lifted, leaned back
        // (LEAN: stored upright, the lean and the turn to the camera are the
        // host's, about the card's pivot)
        const zf = zfoot - 1.5;
        const lo = CELL * below;
        const pivot = pivots.get(key(x, y + below));
        const stack = built.get(key(x, y + below));
        // a narrow tall stack (a north-south fence) lies down, not up
        const lying = stack !== undefined && !stack.wide && stack.rows >= 3;
        const pt = (px: number, up: number): [number, number, number] =>
          [px, PROP_LIFT + cosL * up, zf - sinL * up];
        const { fromOver, fromUnder } = cardMasks(r);
        for (const [mask, at] of [
          [fromUnder, art.under(r.slot)],
          [fromOver, art.full(r.slot)],
        ] as const) {
          for (const [x0, x1, y0, y1] of rects(mask)) {
            const upTop = lo + (CELL - y0);
            const upBot = lo + (CELL - y1);
            const q: Quad = {
              c: [pt(wx + x0, upTop), pt(wx + x1, upTop), pt(wx + x1, upBot), pt(wx + x0, upBot)],
              uv: [
                [at[0] + x0 + E, at[1] + y0 + E],
                [at[0] + x1 - E, at[1] + y0 + E],
                [at[0] + x1 - E, at[1] + y1 - E],
                [at[0] + x0 + E, at[1] + y1 - E],
              ],
              shade: 1,
              f: FACE.south,
            };
            if (LEAN) {
              // foliage turns about its pivot; a built prop leans like a facade
              const codes =
                pivot !== undefined
                  ? [x0, x1, x1, x0].map((xx, i) => cardCode(wx + xx - pivot, i < 2 ? upTop : upBot))
                  : [upTop, upTop, upBot, upBot].map((u) => (lying ? lyingCode(u) : propCode(1, u, 0)));
              q.w = codes.map((cd) => cd.w);
              q.abgrs = codes.map((cd) => cd.abgr);
            }
            cards.push(q);
          }
        }
        // LEAN: a built prop is world geometry, so it has some depth: its
        // silhouette extruded back (a back face, and a strip along every
        // edge of the silhouette in the edge texel's colour) -- a sign, a
        // mailbox or a fence a few px, a small building a card stands for as
        // deep as its stack allows. The depth comes in as the facade lean
        // fades (propCode): seen from the side the prop is a slab, not a
        // line; at the default view it is the card it was, the back face a
        // px behind it and the strips a px deep.
        if (LEAN && pivot === undefined && !lying) {
          // a wide stack of rows is a small building, as deep as its stack
          // allows; anything else (a sign, a mailbox, a post, a fence along
          // x) a few px
          const rows = stack?.rows ?? 1;
          const deep = rows > 1 && stack?.wide === true;
          const D = deep ? Math.min(32, CELL * (rows - 1)) : 4;
          const solid = (x2: number, y2: number) =>
            x2 >= 0 && x2 < 16 && y2 >= 0 && y2 < 16 && (fromOver(x2, y2) || fromUnder(x2, y2));
          const at = art.full(r.slot);
          const zb = zf - 1;
          const face = (
            c: [number, number, number][],
            ups: number[],
            uv: [number, number][],
            shade: number,
            f: Quad["f"],
          ) => {
            // a corner on the back plane (zb) takes the depth; each is
            // stored at the rest lean, K = u up the card
            const codes = ups.map((u, i) => propCode(shade, u, c[i]![2] === zb ? D - 1 : 0));
            const at0 = c.map((p, i): [number, number, number] => {
              const u = (codes[i]!.abgr & 255) / 2;
              return [p[0], p[1] + u * (cosL - 1), p[2] - u * sinL];
            });
            cards.push({ c: at0, uv, shade, f, w: codes.map((cd) => cd.w), abgrs: codes.map((cd) => cd.abgr) });
          };
          const up = (row: number) => lo + (CELL - row);
          // the back face, the silhouette's rectangles again
          for (const [x0, x1, y0, y1] of rects(solid)) {
            const [ua, ub] = [up(y0), up(y1)];
            face(
              [[wx + x1, PROP_LIFT + ua, zb], [wx + x0, PROP_LIFT + ua, zb], [wx + x0, PROP_LIFT + ub, zb], [wx + x1, PROP_LIFT + ub, zb]],
              [ua, ua, ub, ub],
              [[at[0] + x1 - E, at[1] + y0 + E], [at[0] + x0 + E, at[1] + y0 + E], [at[0] + x0 + E, at[1] + y1 - E], [at[0] + x1 - E, at[1] + y1 - E]],
              FACE_SHADE.north,
              FACE.north,
            );
          }
          // the top and bottom edges: runs along x of texels open above/below
          for (const [dy, f, sh] of [[-1, FACE.up, FACE_SHADE.up], [1, FACE.down, FACE_SHADE.down]] as const) {
            for (let ty = 0; ty < 16; ty++) {
              let tx = 0;
              while (tx < 16) {
                if (!(solid(tx, ty) && !solid(tx, ty + dy))) {
                  tx++;
                  continue;
                }
                const t0 = tx;
                while (tx < 16 && solid(tx, ty) && !solid(tx, ty + dy)) tx++;
                const u = up(dy < 0 ? ty : ty + 1);
                // a small building's top takes the art's rows down from its
                // edge, front to back (its roof reads as roof from above);
                // any other edge, its edge row stretched
                let span = 1;
                if (dy < 0 && deep) while (ty + span < 16 && solid(t0, ty + span)) span++;
                const vf = at[1] + ty + (span > 1 ? E : 0.5);
                const vb = span > 1 ? at[1] + ty + span - E : vf;
                face(
                  [[wx + t0, PROP_LIFT + u, zf], [wx + tx, PROP_LIFT + u, zf], [wx + tx, PROP_LIFT + u, zb], [wx + t0, PROP_LIFT + u, zb]],
                  [u, u, u, u],
                  [[at[0] + t0 + E, vf], [at[0] + tx - E, vf], [at[0] + tx - E, vb], [at[0] + t0 + E, vb]],
                  sh,
                  f,
                );
              }
            }
          }
          // the left and right edges: runs along y of texels open beside
          for (const [dx, f, sh] of [[-1, FACE.west, FACE_SHADE.west], [1, FACE.east, FACE_SHADE.east]] as const) {
            for (let tx = 0; tx < 16; tx++) {
              let ty = 0;
              while (ty < 16) {
                if (!(solid(tx, ty) && !solid(tx + dx, ty))) {
                  ty++;
                  continue;
                }
                const t0 = ty;
                while (ty < 16 && solid(tx, ty) && !solid(tx + dx, ty)) ty++;
                const X = wx + (dx < 0 ? tx : tx + 1);
                const [ua, ub] = [up(t0), up(ty)];
                const u = at[0] + tx + 0.5;
                face(
                  [[X, PROP_LIFT + ua, zf], [X, PROP_LIFT + ua, zb], [X, PROP_LIFT + ub, zb], [X, PROP_LIFT + ub, zf]],
                  [ua, ua, ub, ub],
                  [[u, at[1] + t0 + E], [u, at[1] + t0 + E], [u, at[1] + ty - E], [u, at[1] + ty - E]],
                  sh,
                  f,
                );
              }
            }
          }
        }
        stats.cards++;
      }

      // Terrain.lua:537-548 -- over open ground the over layer is a sheet
      // held above (a solid's is in its top already)
      if (r.hasOver && !card && !(h > 0)) {
        const [fx, fy] = art.full(groundSlot);
        const overAt = (x2: number, y2: number) =>
          pair.over[(Math.floor(groundSlot / pair.cols) * 16 + y2) * PW + (groundSlot % pair.cols) * 16 + x2] !== 0;
        for (const [x0, x1, y0, y1] of rects(overAt)) {
          sheets.push({
            c: [
              [wx + x0, OVERHEAD, wz + y0],
              [wx + x1, OVERHEAD, wz + y0],
              [wx + x1, OVERHEAD, wz + y1],
              [wx + x0, OVERHEAD, wz + y1],
            ],
            uv: [
              [fx + x0 + E, fy + y0 + E],
              [fx + x1 - E, fy + y0 + E],
              [fx + x1 - E, fy + y1 - E],
              [fx + x0 + E, fy + y1 - E],
            ],
            shade: FACE_SHADE.up,
            f: FACE.up,
          });
        }
        stats.sheets++;
      }

      // Terrain.lua:551-585 -- sides wherever the next cell is lower: the
      // south face is the art stood on end, the others the tile's average
      const avg = averageColour(pair, r.slot);
      const side = (nx: number, ny: number, f: number, a: [number, number], b: [number, number]) => {
        const n = info.get(key(x + nx, y + ny));
        const nh = n ? n.h : h;
        if (!(nh < h)) return;
        if (f === FACE.south) {
          terrain.push({
            c: [
              [a[0], h, a[1]],
              [b[0], h, b[1]],
              [b[0], nh, b[1]],
              [a[0], nh, a[1]],
            ],
            uv: [
              [ux + E, uy + E],
              [ux + CELL - E, uy + E],
              [ux + CELL - E, uy + CELL - E],
              [ux + E, uy + CELL - E],
            ],
            shade: FACE_SHADE.south,
            f: FACE.south,
          });
        } else {
          const s = f === FACE.east ? FACE_SHADE.east : f === FACE.west ? FACE_SHADE.west : FACE_SHADE.north;
          terrain.push({
            c: [
              [a[0], h, a[1]],
              [b[0], h, b[1]],
              [b[0], nh, b[1]],
              [a[0], nh, a[1]],
            ],
            uv: [white, white, white, white],
            shade: s,
            abgr: abgr(avg[0] * s, avg[1] * s, avg[2] * s),
            f: f as Quad["f"],
          });
        }
      };
      side(0, 1, FACE.south, [wx, wz + CELL], [wx + CELL, wz + CELL]);
      side(1, 0, FACE.east, [wx + CELL, wz + CELL], [wx + CELL, wz]);
      side(-1, 0, FACE.west, [wx, wz], [wx, wz + CELL]);
      side(0, -1, FACE.north, [wx + CELL, wz], [wx, wz]);
    }
  }

  // LEAN: one run as an upright box under its roof plane, every vertex
  // lean-coded (see "the lean code"). With t the facade lean, the facade's
  // top is at (Ky cos t, zt = zs - Sz sin t); the roof runs from its back
  // edge (zn, Hb) over the facade's top to the overhang, rising ROOF_T per
  // px toward the back (Hb = Ky cos t + (zt - zn) T); the side walls fill
  // under it, each in columns along z that slide with zt and rows that keep
  // their share of the height; under the leaned facade the wall is a wedge
  // that closes to nothing when the facade stands upright. At t = CARD_LEAN
  // every corner is where the static rule below puts it.
  const leanRun = (run: BuildingRun) => {
    const X0 = run.x * CELL;
    const X1 = X0 + CELL;
    const { zs, zn, Ky, Sz } = run;
    const D = zs - zn;
    // stored at the rest lean (see "the lean code"): the upright corner
    // moved as the code moves it for t = CARD_LEAN
    const sL = Math.sin(CARD_LEAN);
    const cL = Math.cos(CARD_LEAN);
    const vert = (x: number, y: number, z: number, shade: number, K: number, A: number, B: number) => {
      const code = buildingCode(shade, K, A, B);
      const Kq = (code.abgr & 255) / 2;
      const Aq = code.w / 64;
      const Bq = ((code.abgr >>> 8) & 255) + ((code.abgr >>> 16) & 255) / 256;
      return {
        p: [x, y + Kq * (cL - 1) - ROOF_T * Bq * sL, z - Aq * sL] as [number, number, number],
        code,
      };
    };
    type V = ReturnType<typeof vert>;
    const push = (vs: V[], uv: [number, number][], shade: number, f: Quad["f"]) => {
      terrain.push({
        c: vs.map((v) => v.p),
        uv,
        shade,
        abgrs: vs.map((v) => v.code.abgr),
        w: vs.map((v) => v.code.w),
        f,
      });
    };
    const cellUv = (at: [number, number], u0: number, u1: number, v0: number, v1: number): [number, number][] => [
      [at[0] + u0 + E, at[1] + v0 + E],
      [at[0] + u1 - E, at[1] + v0 + E],
      [at[0] + u1 - E, at[1] + v1 - E],
      [at[0] + u0 + E, at[1] + v1 - E],
    ];
    // the facade: its rows top to bottom, a point f of the way up it is
    // (Ky f cos t, zs - Sz f sin t)
    const F = run.yb - run.yf + 1;
    const sS = FACE_SHADE.south;
    const fac = (x: number, f: number, shade: number = sS) => {
      const y = Math.round(Ky * f);
      return vert(x, y, zs, shade, y, Sz * f, 0);
    };
    for (let i = 0; i < F; i++) {
      const slot = info.get(key(run.x, run.yf + i))!.rec.slot;
      const f0 = 1 - i / F;
      const f1 = 1 - (i + 1) / F;
      push([fac(X0, f0), fac(X1, f0), fac(X1, f1), fac(X0, f1)], cellUv(art.full(slot), 0, CELL, 0, CELL), sS, FACE.south);
    }
    // the roof: a point s of the way from its back edge to the overhang
    const R = run.yf - run.ya;
    const sU = FACE_SHADE.up;
    const roof = (x: number, s: number) => {
      const z = zn + (zs + ROOF_OVERHANG - zn) * s;
      return vert(x, Ky + ROOF_T * (zs - z), z, sU, Ky, Sz * s, Sz * (1 - s));
    };
    if (R > 0) {
      const total = R * CELL - run.skip;
      let acc = 0;
      for (let j = 0; j < R; j++) {
        const slot = info.get(key(run.x, run.ya + j))!.rec.slot;
        const v0 = j === 0 ? run.skip : 0;
        const s0 = acc / total;
        const s1 = (acc + CELL - v0) / total;
        acc += CELL - v0;
        push([roof(X0, s0), roof(X1, s0), roof(X1, s1), roof(X0, s1)], cellUv(art.full(slot), 0, CELL, v0, CELL), sU, FACE.up);
      }
    }
    // the walls under it: n rows of the building's plainest wall art (each
    // row's share t of the height at every column), columns a cell deep
    // from the front; a point l of the way from the back wall to zt, t up
    const n = Math.max(1, Math.round((Ky + (D * ROOF_T) / 2) / CELL));
    const art_ = (row: number) => art.full(run.sideArt[Math.min(row, run.sideArt.length - 1)] ?? run.sideArt[0]!);
    const wall = (x: number, l: number, t: number, shade: number) =>
      vert(x, t * (Ky + (1 - l) * D * ROOF_T), zn + l * D, shade, t * Ky, l * Sz, t * (1 - l) * Sz);
    // under the leaned facade: the facade's line, and the wall's front edge
    const wedge = (x: number, t: number, shade: number) => [fac(x, t, shade), wall(x, 1, t, shade)];
    const side = (x: number, f: Quad["f"], east: boolean) => {
      const sh = east ? FACE_SHADE.east : FACE_SHADE.west;
      // column edges, front to back: zs, zs - 16, ..., zn
      const zEdges: number[] = [];
      for (let z = zs; z > zn; z -= CELL) zEdges.push(z);
      zEdges.push(zn);
      for (let j = 0; j < n; j++) {
        const t0 = j / n;
        const t1 = (j + 1) / n;
        const at = art_(j);
        // the art's top row is up: v runs top (t1) to bottom (t0)
        for (let c = 0; c + 1 < zEdges.length; c++) {
          const za = zEdges[c]!;
          const zb = zEdges[c + 1]!;
          const la = (za - zn) / D;
          const lb = (zb - zn) / D;
          // east: south on the viewer's left; west: mirrored
          const ua = east ? zs - CELL * c - za : CELL - (zs - CELL * c - za);
          const ub = east ? zs - CELL * c - zb : CELL - (zs - CELL * c - zb);
          push(
            [wall(x, la, t1, sh), wall(x, lb, t1, sh), wall(x, lb, t0, sh), wall(x, la, t0, sh)],
            [
              [at[0] + ua + (east ? E : -E), at[1] + E],
              [at[0] + ub + (east ? -E : E), at[1] + E],
              [at[0] + ub + (east ? -E : E), at[1] + CELL - E],
              [at[0] + ua + (east ? E : -E), at[1] + CELL - E],
            ],
            sh,
            f,
          );
        }
        // the wedge's row: from the facade's line to the wall's front edge
        const [fa, wa] = wedge(x, t1, sh);
        const [fb, wb] = wedge(x, t0, sh);
        push([fa, wa, wb, fb], cellUv(at, 0, CELL, 0, CELL), sh, f);
      }
    };
    const sameProfile = (nx: number) => {
      const o = run.byCell.get(key(nx, run.yb));
      return o !== undefined && o.yb === run.yb && o.Ky === Ky && o.Sz === Sz && o.zn <= zn;
    };
    if (!sameProfile(run.x + 1)) side(X1, FACE.east, true);
    if (!sameProfile(run.x - 1)) side(X0, FACE.west, false);
    // the back wall
    const sN = FACE_SHADE.north;
    for (let j = 0; j < n; j++) {
      const t0 = j / n;
      const t1 = (j + 1) / n;
      push([wall(X1, 0, t1, sN), wall(X0, 0, t1, sN), wall(X0, 0, t0, sN), wall(X1, 0, t0, sN)], cellUv(art_(j), 0, CELL, 0, CELL), sN, FACE.north);
    }
  };

  // the building rule (NOT FAITHFUL, see the header and FACADE): each run
  // stands as a leaned facade under a roof plane
  for (const run of runs) {
    if (LEAN) {
      stats.facades++;
      leanRun(run);
      continue;
    }
    stats.facades++;
    const X0 = run.x * CELL;
    const X1 = X0 + CELL;
    const zs = run.zs;
    const zt = run.zt;
    const H = run.H;
    const zn = run.zn;
    const Hb = run.Hb;
    const uvCell = (slot: number, v0: number, v1: number): [number, number][] => {
      const [fx, fy] = art.full(slot);
      return [
        [fx + E, fy + v0 + E],
        [fx + CELL - E, fy + v0 + E],
        [fx + CELL - E, fy + v1 - E],
        [fx + E, fy + v1 - E],
      ];
    };
    // the facade: its rows top to bottom down the leaned plane, each its own
    // under+over picture, the bottom row (the door's) at the ground
    const F = run.yb - run.yf + 1;
    for (let i = 0; i < F; i++) {
      const slot = info.get(key(run.x, run.yf + i))!.rec.slot;
      const t0 = i / F;
      const t1 = (i + 1) / F;
      const z0 = zt + (zs - zt) * t0;
      const z1 = zt + (zs - zt) * t1;
      const h0 = H * (1 - t0);
      const h1 = H * (1 - t1);
      terrain.push({
        c: [
          [X0, h0, z0],
          [X1, h0, z0],
          [X1, h1, z1],
          [X0, h1, z1],
        ],
        uv: uvCell(slot, 0, CELL),
        shade: FACE_SHADE.south,
        f: FACE.south,
      });
    }
    // the roof: its rows back to front over the plane from the back edge to
    // the overhang, the art of each in proportion (the back row from where
    // its eave's art starts)
    const R = run.yf - run.ya;
    if (R > 0 && zt > zn) {
      const slope = (Hb - H) / (zt - zn);
      const zf = zt + ROOF_OVERHANG;
      const hf = H - ROOF_OVERHANG * slope;
      const total = R * CELL - run.skip;
      let acc = 0;
      for (let j = 0; j < R; j++) {
        const slot = info.get(key(run.x, run.ya + j))!.rec.slot;
        const v0 = j === 0 ? run.skip : 0;
        const len = CELL - v0;
        const s0 = acc / total;
        const s1 = (acc + len) / total;
        acc += len;
        const za = zn + (zf - zn) * s0;
        const zb = zn + (zf - zn) * s1;
        const ha = Hb + (hf - Hb) * s0;
        const hb = Hb + (hf - Hb) * s1;
        terrain.push({
          c: [
            [X0, ha, za],
            [X1, ha, za],
            [X1, hb, zb],
            [X0, hb, zb],
          ],
          uv: uvCell(slot, v0, CELL),
          shade: FACE_SHADE.up,
          f: FACE.up,
        });
      }
    }
    // the side walls: one flat colour (the wall's), under the roof end and
    // down the facade's slope; skipped where the neighbouring run has the
    // same profile (the face would be inside the building)
    const wallAvg = averageColourFull(pair, info.get(key(run.x, run.yb))!.rec.slot);
    const flatSide = (f: number, corners: [number, number, number][]) => {
      const s = f === FACE.east ? FACE_SHADE.east : f === FACE.west ? FACE_SHADE.west : FACE_SHADE.north;
      terrain.push({
        c: corners,
        uv: [white, white, white, white],
        shade: s,
        abgr: abgr(wallAvg[0] * s, wallAvg[1] * s, wallAvg[2] * s),
        f: f as Quad["f"],
      });
    };
    const sameProfile = (nx: number) => {
      const n = run.byCell.get(key(nx, run.yb));
      return n !== undefined && n.yb === run.yb && n.zt === zt && n.H === H && n.zn <= zn && n.Hb >= Hb;
    };
    if (!sameProfile(run.x + 1)) {
      if (zt > zn) flatSide(FACE.east, [[X1, H, zt], [X1, Hb, zn], [X1, 0, zn], [X1, 0, zt]]);
      flatSide(FACE.east, [[X1, 0, zs], [X1, H, zt], [X1, 0, zt], [X1, 0, zs]]);
    }
    if (!sameProfile(run.x - 1)) {
      if (zt > zn) flatSide(FACE.west, [[X0, Hb, zn], [X0, H, zt], [X0, 0, zt], [X0, 0, zn]]);
      flatSide(FACE.west, [[X0, H, zt], [X0, 0, zs], [X0, 0, zs], [X0, 0, zt]]);
    }
    // the back wall
    flatSide(FACE.north, [[X1, Hb, zn], [X0, Hb, zn], [X0, 0, zn], [X1, 0, zn]]);
  }
  return { terrain, water, cards, sheets, stats, grid };
}
