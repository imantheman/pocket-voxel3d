// voxelmon/cook/g3ds/struct.ts — one map's scene analysis: the per-tile
// shape grid, the building runs, the hulls and the per-pixel props.
//
// MIT. Ported from UNDERdecoded/Gen2Recomped-DramaticShapes (MIT, Copyright
// (c) 2026 DramaticShape, modified by UNDERdecodedHD; THIRD_PARTY_NOTICES.md)
// at 726782f, lib/Structures.lua -- `Structures.forMap` (:10366) and the Gen 3
// passes it runs, in his order:
//
//   the grid            forMap :10944 (TileShape.at -> Gen3 classAt, the
//                       interior shell :444, the paved-wall test :10852)
//   the door fold       :11077      the roof fold          :11101
//   elevation ground    :14455 buildGen3ElevationGround
//   hulls               :20860 buildCylinders (hull.ts roundTemplate)
//   the region flood    :11360 -> :24771 extractObjects / :25186 buildObject
//                                 -> :23017 buildVolume (the Gen 3 arm)
//   rock plateaus       :17854 buildGen3RockPlateaus (caves)
//   buildings founded   :5722 foundGen3Buildings
//   rock cut to a drop  :6570 capGen3Rock, :7019 climbGen3Masses
//   ledges              :7502 standGen3Ledges
//   falls               :22734 buildFalls
//   billboards / posts  :11585 (extractObjects forced)
//   tall-grass mats     :26466 buildGen3Grass
//   the apron           :9217 standGen3Apron
//
// The passes that only exist for Hoenn's terraced towns and authored
// profiles (bowls, synthesised levels, drawn terraces, flights, kerbs,
// palings, basins, hulls of boats, stalls, lamps, lathes, the brow clamp and
// the terrain grade) are not ported: no FRLG map states the elevation
// relief they reconstruct (FRLG towns and routes place elevations 0, 1 and 3
// only), and the authored profiles name Emerald tilesets.

import type { Quad } from "../geom.ts";
import { keyOf } from "../geom.ts";
import type { TileArt } from "../gen3terrain.ts";
import { type Building, COURSE, type Ctx } from "./ctx.ts";
import { type Canvas, roundHull } from "./hull.ts";
import { mergePointQuads } from "./merge.ts";
import { mergeUvRects } from "../rectmerge.ts";

/** Art px per hull voxel at the near and middle levels of detail (see buildCylinders). */
export interface HullSteps {
  near: number;
  mid: number;
}
export const HULL_STEPS: HullSteps = { near: Number(process.env.FR_HULL_NEAR ?? 2), mid: Number(process.env.FR_HULL_MID ?? 4) };
/** The coarser pair a map falls back to when its hulls would not fit (gen3cook). */
export const HULL_STEPS_LEAN: HullSteps = { near: 4, mid: 8 };

import { artOf, CLASS_H, isDoorBehaviour, ledgeHop } from "./shapes.ts";

export interface Shape {
  cls: string;
  h: number;
  art: string;
  flat: boolean;
  authored: boolean;
  base?: number;
  rock?: boolean;
  apron?: boolean;
}

export interface Run {
  front: number;
  north: number;
  extent: number;
  unit: number;
  fromRepeat: boolean;
  door: boolean;
  gen3RoofRows?: number;
  gen3PlanRows: number;
  gen3Bld?: number;
  gen3BldRows?: number;
  gen3BldPlan: number;
  foldRows?: number;
  base: number;
  roofRows: number;
  rise: number;
  peak: number;
  h: number;
  shedRoof?: number;
  gableExtent?: number;
  roofArtTop?: number;
  roofArtRows?: number;
  face?: { rows: number; dir: "north" | "south" };
  gen3ArtNorth?: number;
  octTrim?: boolean;
}

export interface Stamp {
  quads: Quad[];
  coarse: Quad[];
  mx: number;
  mz: number;
  my: number;
  r: number;
}

export interface SG {
  ctx: Ctx;
  shapeAt: Map<number, Shape>;
  tileAt: Map<number, number>;
  runs: Map<number, Run>;
  skip: Set<number>;
  ground: Map<number, number | false>;
  objectQuads: Quad[];
  grassQuads: Quad[];
  roundStamps: Stamp[];
  /** Tiles a hull claimed (the far level of detail re-extrudes them). */
  round: Set<number>;
  outdoor: boolean;
  hideBareRing: boolean;
  /** Tile keys whose cell roofAt names (forMap's gen3Roof). */
  gen3Roof: Set<number>;
  gen3RoomWallTop: number[] | null;
  tw: number;
  th: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** Synthetic tile id -> its art's page px (the TileArt composite). */
  tileOrigin(tile: number): [number, number];
  /** The map's own tile at a tile position (no swap, border-tiled outside). */
  rawTile(tx: number, ty: number): number;
  isWalkableCell(cx: number, cy: number): boolean;
  /** The colour a page px samples (rgb key), for the point-quad merge. */
  colourAtUv(u: number, v: number): number;
  stats: Record<string, number>;
}

/** Structures.lua:57 RING (tiles) and :65 ROUND_RING. */
export const RING = 12;
const ROUND_RING = 4;
/** Structures.lua:227-244 */
const MAX_ROWS = 6;
const GEN3_MAX_ROWS = 12;
const GEN3_MAX_RISE = 2;
const GEN3_MAX_LAND = 32;
/** Structures.lua:5720 */
const GEN3_OUTDOOR_FACADE_CAP = 40;
/** Structures.lua:1263 */
const TERRACE_MAX = 13;
/** Structures.lua:17833 */
const ROCK_LIFT = COURSE;
/** Structures.lua:22723-22726 */
const FALL_MAX = 96;
const FALL_POOL_MAX = 4096;
const FALL_RIM = 2;
const GORGE_WALL = 32;
/** Structures.lua:26447 */
const GRASS_MAT = 4;
/** Structures.lua:519 SHELL, :529 CAVE_SHELL */
const SHELL = 2;
/** Structures.lua:208-225 */
const OBJECT_MAX_ROWS = 6;
const OBJECT_MAX_QUADS = 4096;
const TILE_BG_RATIO = 0.2;
const CLUSTER_MIN_BG = 0.05;
const OBJECT_DEPTH = 6;
const PINNED_DEPTH: Record<string, number> = { billboard: 10, prop: 5, stool: 10, cutout: 1, column: 6, console: 10, post: 6, signpost: 2, bike: 2, fence: 4 };
/** Structures.lua:24658 OBJ_SHADE */
const OBJ_SHADE = { front: 1.0, back: 0.68, side: 0.78, top: 1.0, bottom: 0.55 };

const DIRS4: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const ck = (cx: number, cy: number) => cy * 8192 + cx;
const fl2 = (v: number) => Math.floor(v / 2);
const mod2 = (v: number) => ((v % 2) + 2) % 2;

export interface NeighbourBody {
  /** Pixel rect of a connected map's body, in this map's world px. */
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export function buildScene(ctx: Ctx, art: TileArt, bodies: NeighbourBody[], steps: HullSteps = HULL_STEPS): SG {
  const map = ctx.map;
  const W = ctx.width;
  const H = ctx.height;
  const tw = W * 2;
  const th = H * 2;
  const x0 = -RING;
  const x1 = tw + RING - 1;
  const y0 = -RING;
  const y1 = th + RING - 1;
  const outdoor = ctx.outdoor;
  const stats: Record<string, number> = {};
  const bump = (k: string, n = 1) => (stats[k] = (stats[k] ?? 0) + n);

  const tileId = (mid: number, tx: number, ty: number) => ctx.slotOf(mid) * 4 + mod2(ty) * 2 + mod2(tx);
  const rawTile = (tx: number, ty: number) => tileId(ctx.metatileAt(fl2(tx), fl2(ty)), tx, ty);
  const tileOrigin = (tile: number): [number, number] => {
    const [fx, fy] = art.full(tile >> 2);
    return [fx + (tile & 1) * 8, fy + ((tile >> 1) & 1) * 8];
  };
  // a tile's art texel (px, py in 0..7): its slot texel
  const slotXY = (tile: number, px: number, py: number): [number, number, number] => [tile >> 2, (tile & 1) * 8 + px, ((tile >> 1) & 1) * 8 + py];
  const opaqueT = (tile: number, px: number, py: number) => {
    const [s, x, y] = slotXY(tile, px, py);
    return ctx.surface.opaque(s, x, y);
  };
  const rgbT = (tile: number, px: number, py: number) => {
    const [s, x, y] = slotXY(tile, px, py);
    return ctx.art.rgbAt(s, x, y);
  };
  const behaviourClassAt = (cx: number, cy: number) => ctx.classAt(cx, cy)?.cls;
  const isWalkableCell = (cx: number, cy: number) => {
    if (ctx.offMap(cx, cy) || ctx.blockedAt(cx, cy)) return false;
    const c = behaviourClassAt(cx, cy);
    return c !== "water" && c !== "waterfall";
  };

  // ---- the ring: border patch, foliage / rock truncation (forMap :10473) ----
  let hullRingOnly = false;
  let ringRock = false;
  {
    const border = [ctx.metatileAt(-2, -2), ctx.metatileAt(-1, -2), ctx.metatileAt(-2, -1), ctx.metatileAt(-1, -1)];
    let leafy = 0;
    let rocky = 0;
    for (const m of border) {
      if (ctx.statsOf(m)?.leafy) leafy++;
      const r = ctx.metaRole(m);
      if (r && r.art === "face" && r.material === "rock" && r.cap === 0) rocky++;
    }
    if (leafy >= 3) hullRingOnly = true;
    if (outdoor && rocky >= 3) ringRock = true;
  }
  // Structures.lua:166 gen3RingCarved: within ROUND_RING always; out to 8
  // tiles where no neighbour body is near (a horizon this map draws itself)
  const ringCarved = (tx: number, ty: number) => {
    const dtx = tx < 0 ? -tx : tx >= tw ? tx - tw + 1 : 0;
    const dty = ty < 0 ? -ty : ty >= th ? ty - th + 1 : 0;
    const dt = Math.max(dtx, dty);
    if (dt <= ROUND_RING) return true;
    const DEEP_RING = 8;
    if (dt > DEEP_RING) return false;
    const reach = RING * 8;
    const px0 = fl2(tx) * 16;
    const pz0 = fl2(ty) * 16;
    for (const b of bodies) {
      if (px0 + 16 > b.x0 - reach && px0 < b.x1 + reach && pz0 + 16 > b.z0 - reach && pz0 < b.z1 + reach) return false;
    }
    return true;
  };

  // ---- the interior shell (Structures.lua:444 indoorShell) ----
  const shapeOf = (cls: string, h: number, pinned: boolean): Shape => {
    const a = artOf(cls);
    return { cls, h, art: a, flat: a === "flat" || cls === "grass" || cls === "flower", authored: pinned || a !== "upright" };
  };
  const classShape = (cls: string): Shape => shapeOf(cls, CLASS_H[cls] ?? 0, false);
  // TileShape.at's Gen 3 arm
  const tileShapeAt = (tx: number, ty: number): Shape => {
    const cx = fl2(tx);
    const cy = fl2(ty);
    const r = ctx.classAt(cx, cy);
    const cls = r ? r.cls : "ground";
    let h = CLASS_H[cls] ?? 0;
    if (artOf(cls) !== "upright") h += ctx.groundHeight(cx, cy);
    return shapeOf(cls, h, r ? r.pinned : false);
  };
  let shell: number[] | null = null;
  let caveShell = false;
  if (!outdoor) {
    const counts = new Map<number, number>();
    const quads = new Map<number, number[]>();
    for (let cx = 0; cx < W; cx++) {
      const tx = cx * 2;
      const s = tileShapeAt(tx, 1);
      if (s.art === "upright" && !s.authored) {
        const nw = rawTile(tx, 0);
        counts.set(nw, (counts.get(nw) ?? 0) + 1);
        if (!quads.has(nw)) quads.set(nw, [nw, rawTile(tx + 1, 0), rawTile(tx, 1), rawTile(tx + 1, 1)]);
      }
    }
    let best: number | undefined;
    let bestN = 0;
    for (const [t, n] of counts) if (n > bestN) [best, bestN] = [t, n];
    if (best !== undefined) shell = quads.get(best)!;
    else {
      counts.clear();
      quads.clear();
      for (let cy = 0; cy < H; cy++) {
        for (let cx = 0; cx < W; cx++) {
          const s = tileShapeAt(cx * 2, cy * 2 + 1);
          if (s.art === "upright" && !s.authored) {
            const nw = rawTile(cx * 2, cy * 2);
            counts.set(nw, (counts.get(nw) ?? 0) + 1);
            if (!quads.has(nw)) quads.set(nw, [nw, rawTile(cx * 2 + 1, cy * 2), rawTile(cx * 2, cy * 2 + 1), rawTile(cx * 2 + 1, cy * 2 + 1)]);
          }
        }
      }
      best = undefined;
      bestN = 0;
      for (const [t, n] of counts) if (n > bestN) [best, bestN] = [t, n];
      if (best !== undefined && bestN >= 8) {
        shell = quads.get(best)!;
        caveShell = true;
      }
    }
  }
  const depth = caveShell ? RING : SHELL;
  const inShell = (tx: number, ty: number) =>
    shell !== null && !(tx >= 0 && ty >= 0 && tx < tw && ty < th) && tx >= -depth && ty >= -depth && tx < tw + depth && ty < th + depth;
  const shellTile = (tx: number, ty: number) => shell![mod2(ty) * 2 + mod2(tx)]!;
  const tileLookup = (tx: number, ty: number): number | undefined => {
    if (tx >= 0 && ty >= 0 && tx < tw && ty < th) return rawTile(tx, ty);
    if (!outdoor) return inShell(tx, ty) ? shellTile(tx, ty) : undefined;
    if ((hullRingOnly || ringRock) && !ringCarved(tx, ty)) return undefined;
    return rawTile(tx, ty);
  };

  // void tiles: all-black-or-transparent art never extrudes (Structures.lua:389)
  const voidMemo = new Map<number, boolean>();
  const isVoidTile = (tile: number) => {
    let v = voidMemo.get(tile);
    if (v === undefined) {
      v = true;
      for (let py = 0; py < 8 && v; py++) {
        for (let px = 0; px < 8; px++) {
          const [r, g, b] = rgbT(tile, px, py);
          if (Math.max(r, g, b) > 0.17 * 255) {
            v = false;
            break;
          }
        }
      }
      voidMemo.set(tile, v);
    }
    return v;
  };
  // the fabric between rooms (forMap :10805)
  const FABRIC_REACH = 3;
  const nearFloor = (tx: number, ty: number) => {
    const cx0 = fl2(tx);
    const cy0 = fl2(ty);
    for (let dy = -FABRIC_REACH; dy <= FABRIC_REACH; dy++) {
      for (let dx = -FABRIC_REACH; dx <= FABRIC_REACH; dx++) {
        const nx = cx0 + dx;
        const ny = cy0 + dy;
        if (nx >= 0 && ny >= 0 && nx < W && ny < H) {
          const c = ctx.classAt(nx, ny);
          if (c && c.cls !== "void") return true;
        }
      }
    }
    return false;
  };
  // BLOCKED PAVEMENT IS NOT A WALL (forMap :10852)
  const PAVED_SOLID = 0.15;
  const PAVED_TINT = 0.15;
  let pavedFloors: number[] | null | undefined;
  const pavedMean = new Map<number, [number, number, number]>();
  const meanOf = (m: number) => {
    let c = pavedMean.get(m);
    if (!c) {
      const s = ctx.slotOf(m);
      let r = 0;
      let g = 0;
      let b = 0;
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          const p = ctx.art.rgbAt(s, x, y);
          r += p[0] / 255;
          g += p[1] / 255;
          b += p[2] / 255;
        }
      }
      c = [r / 256, g / 256, b / 256];
      pavedMean.set(m, c);
    }
    return c;
  };
  const pavedVerdict = new Map<number, boolean>();
  const pavedWall = (tx: number, ty: number) => {
    const m = ctx.metatileAt(fl2(tx), fl2(ty));
    const st = ctx.statsOf(m);
    if (!st || st.leafy || st.n2 > 0 || st.solid > PAVED_SOLID) return false;
    const hit = pavedVerdict.get(m);
    if (hit !== undefined) return hit;
    if (pavedFloors === undefined) {
      const count = new Map<number, number>();
      let walked = 0;
      for (let cy = 0; cy < H; cy++) {
        for (let cx = 0; cx < W; cx++) {
          const c = ctx.classAt(cx, cy);
          if (c && (c.cls === "ground" || c.cls === "grass")) {
            const mm = ctx.metatileAt(cx, cy);
            count.set(mm, (count.get(mm) ?? 0) + 1);
            walked++;
          }
        }
      }
      const cut = Math.max(4, walked * 0.02);
      pavedFloors = walked > 0 ? [...count].filter(([, n]) => n >= cut).map(([mm]) => mm) : null;
      if (pavedFloors && pavedFloors.length === 0) pavedFloors = null;
    }
    if (!pavedFloors) {
      pavedVerdict.set(m, false);
      return false;
    }
    const a = meanOf(m);
    let best = Infinity;
    for (const f of pavedFloors) {
      const b = meanOf(f);
      best = Math.min(best, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
    }
    const v = best < PAVED_TINT;
    pavedVerdict.set(m, v);
    return v;
  };

  // ---- the grid ----
  const shapeAt = new Map<number, Shape>();
  const tileAt = new Map<number, number>();
  // WHICH TILE ROWS ARE ROOF (forMap :10754): the cells roofAt names
  const gen3Roof = new Set<number>();
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) if (ctx.roofAt(fl2(tx), fl2(ty))) gen3Roof.add(keyOf(tx, ty));
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      let tile = tileLookup(tx, ty);
      if (tile === undefined) continue;
      const k = keyOf(tx, ty);
      let s: Shape;
      if (inShell(tx, ty)) s = classShape("shell");
      else {
        s = tileShapeAt(tx, ty);
        if (isVoidTile(tile) && !s.authored) s = classShape("void");
      }
      if (!outdoor && shell && s.cls === "void" && !inShell(tx, ty) && nearFloor(tx, ty)) {
        s = classShape("shell");
        tile = shellTile(tx, ty);
      }
      if (outdoor && s.cls === "wall" && s.art === "upright" && !s.authored && !gen3Roof.has(k) && pavedWall(tx, ty)) s = classShape("ground");
      shapeAt.set(k, s);
      tileAt.set(k, tile);
    }
  }

  const S: SG = {
    ctx, shapeAt, tileAt, runs: new Map(), skip: new Set(), ground: new Map(),
    objectQuads: [], grassQuads: [], roundStamps: [], round: new Set(),
    outdoor, hideBareRing: hullRingOnly, gen3Roof, gen3RoomWallTop: shell !== null && !caveShell ? shell : null,
    tw, th, x0, x1, y0, y1, tileOrigin, rawTile, isWalkableCell, stats,
    colourAtUv: (u: number, v: number) => {
      // the page's composite rows start at full(0); slots run `cols` wide
      const [, R] = art.full(0);
      const cols = ctx.pair.cols;
      const x = Math.floor(u);
      const y = Math.floor(v) - R;
      if (y < 0) return -1;
      const c = ctx.art.rgbAt(Math.floor(y / 16) * cols + Math.floor(x / 16), x % 16, y % 16);
      return c[0] * 65536 + c[1] * 256 + c[2];
    },
  };

  // ---- the door fold (forMap :11077): a door rises with the wall it is cut into
  const doorFold = new Set<number>();
  for (let cy = fl2(y0); cy <= fl2(y1); cy++) {
    for (let cx = fl2(x0); cx <= fl2(x1); cx++) {
      if (ctx.offMap(cx, cy) || !isDoorBehaviour(ctx.attributes(ctx.metatileAt(cx, cy)))) continue;
      const ns = shapeAt.get(keyOf(cx * 2, cy * 2 - 1));
      if (!(ns && ns.art === "upright")) continue;
      for (let dy = 0; dy <= 1; dy++) {
        for (let dx = 0; dx <= 1; dx++) {
          const dk = keyOf(cx * 2 + dx, cy * 2 + dy);
          const ds = shapeAt.get(dk);
          if (!(ds && ds.authored)) {
            shapeAt.set(dk, classShape("wall"));
            doorFold.add(dk);
          }
        }
      }
    }
  }

  // ---- the roof course left walkable (forMap :11101) ----
  const roofFold = new Set<number>();
  {
    const statRA = (cx: number, cy: number) => (cx < 0 || cy < 0 || cx >= W || cy >= H ? undefined : ctx.statsOf(ctx.metatileAt(cx, cy)));
    const uprightRA = (cx: number, cy: number) => {
      const sh = shapeAt.get(keyOf(cx * 2, cy * 2));
      return !!sh && sh.art === "upright" && !sh.authored;
    };
    const roofCourse = (cx: number, cy: number) => {
      const sh = shapeAt.get(keyOf(cx * 2, cy * 2));
      if (!(sh && sh.cls === "ground" && sh.art === "flat")) return false;
      const st = statRA(cx, cy);
      if (!st || st.leafy) return false;
      return st.n2 >= 96 && st.solid >= 0.3;
    };
    const roofedBelow = (cx: number, cy: number) => {
      if (!uprightRA(cx, cy + 1)) return false;
      const st = statRA(cx, cy + 1);
      return st !== undefined && st.solid >= 0.7;
    };
    const done = new Set<number>();
    let folded = 0;
    for (let cy = 0; cy < H; cy++) {
      for (let cx = 0; cx < W; cx++) {
        if (done.has(ck(cx, cy)) || !roofedBelow(cx, cy) || !roofCourse(cx, cy)) continue;
        let a = cx;
        let b = cx;
        while (a - 1 >= 0 && roofedBelow(a - 1, cy)) a--;
        while (b + 1 < W && roofedBelow(b + 1, cy)) b++;
        let ok = true;
        let n = 0;
        for (let x = a; x <= b; x++) {
          const st = statRA(x, cy);
          if (st && st.leafy) done.add(ck(x, cy));
          else if (roofCourse(x, cy)) n++;
          else {
            ok = false;
            break;
          }
        }
        for (let x = a; x <= b; x++) done.add(ck(x, cy));
        if (ok && n >= 2) {
          for (let x = a; x <= b; x++) {
            if (!roofCourse(x, cy)) continue;
            for (let dy = 0; dy <= 1; dy++) {
              for (let dx = 0; dx <= 1; dx++) {
                const dk = keyOf(x * 2 + dx, cy * 2 + dy);
                shapeAt.set(dk, classShape("wall"));
                roofFold.add(dk);
              }
            }
            folded++;
          }
        }
      }
    }
    bump("roofFold", folded);
  }

  // a structure cell (forMap :11237)
  const structural = (k: number) => {
    const s = shapeAt.get(k);
    return !!s && s.art === "upright" && !s.authored;
  };

  // the flat ground tiles this map places, for the hulls' ground matching
  const groundTiles: number[] = [];
  {
    const seen = new Set<number>();
    for (const [k, s] of shapeAt) {
      if (s.flat && s.cls === "ground") {
        const t = tileAt.get(k)!;
        if (!seen.has(t)) {
          seen.add(t);
          groundTiles.push(t);
        }
      }
    }
    groundTiles.sort((a, b) => a - b);
  }

  // ---- buildGen3ElevationGround (:14455) ----
  {
    const seen = new Set<number>();
    for (let cy = 0; cy < H; cy++) {
      for (let cx = 0; cx < W; cx++) {
        if (!isWalkableCell(cx, cy)) continue;
        const e = ctx.elevationAt(cx, cy)!;
        if (e !== 15 && e !== 0) seen.add(e);
      }
    }
    const order = [...seen].sort((a, b) => a - b);
    if (order.length > 1) {
      const rank = new Map<number, number>();
      order.forEach((e, i) => rank.set(e, i));
      const isFloorClass = (c: string) => c === "ground" || c === "grass" || c === "slope";
      const hist = new Map<number, Map<number, number>>();
      for (let cy = 0; cy < H; cy++) {
        for (let cx = 0; cx < W; cx++) {
          if (!isWalkableCell(cx, cy)) continue;
          const r = rank.get(ctx.elevationAt(cx, cy)!);
          if (r === undefined || r <= 0) continue;
          for (let dy = 0; dy <= 1; dy++) {
            for (let dx = 0; dx <= 1; dx++) {
              const old = shapeAt.get(keyOf(cx * 2 + dx, cy * 2 + dy));
              if (old && old.flat && isFloorClass(old.cls)) {
                const hh = Math.round(old.h / COURSE) * COURSE;
                let t = hist.get(r);
                if (!t) hist.set(r, (t = new Map()));
                t.set(hh, (t.get(hh) ?? 0) + 1);
              }
            }
          }
        }
      }
      const levelH = new Map<number, number>();
      let below: number | undefined;
      for (let i = 0; i < order.length; i++) {
        const want = i * COURSE;
        let h = want;
        const hh = i > 0 ? hist.get(i) : undefined;
        if (hh) {
          let mode: number | undefined;
          let modeN = -1;
          let tot = 0;
          for (const [v, c] of hh) {
            tot += c;
            if (c > modeN) [mode, modeN] = [v, c];
          }
          if (mode !== undefined && mode > want && mode - want <= 2 * COURSE && modeN * 4 >= tot * 3) h = mode;
        }
        if (below !== undefined && h < below + COURSE) h = below + COURSE;
        levelH.set(i, h);
        below = h;
      }
      let n = 0;
      for (let cy = 0; cy < H; cy++) {
        for (let cx = 0; cx < W; cx++) {
          if (!isWalkableCell(cx, cy)) continue;
          const r = rank.get(ctx.elevationAt(cx, cy)!);
          if (r === undefined) continue;
          const h = levelH.get(r) ?? r * COURSE;
          for (let dy = 0; dy <= 1; dy++) {
            for (let dx = 0; dx <= 1; dx++) {
              const kk = keyOf(cx * 2 + dx, cy * 2 + dy);
              const old = shapeAt.get(kk);
              if (old && old.flat && isFloorClass(old.cls) && old.h !== h) {
                shapeAt.set(kk, { ...old, h, authored: true });
                n++;
              }
            }
          }
        }
      }
      bump("elevationTiles", n);
    }
  }

  // ---- hulls (buildCylinders :20860) ----
  buildCylinders(S, ctx, groundTiles, ringCarved, opaqueT, rgbT, tileOrigin, steps);

  // ---- the region flood -> objects, then volumes (:11360) ----
  {
    const seen = new Set<number>();
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const k = keyOf(tx, ty);
        if (!structural(k) || seen.has(k)) continue;
        const region: Region = { tiles: [], minX: tx, maxX: tx, minY: ty, maxY: ty };
        const queue: [number, number][] = [[tx, ty]];
        seen.add(k);
        while (queue.length) {
          const c = queue.pop()!;
          region.tiles.push(c);
          region.minX = Math.min(region.minX, c[0]);
          region.maxX = Math.max(region.maxX, c[0]);
          region.minY = Math.min(region.minY, c[1]);
          region.maxY = Math.max(region.maxY, c[1]);
          for (const [dx, dy] of DIRS4) {
            const nx = c[0] + dx;
            const ny = c[1] + dy;
            if (nx < x0 || nx > x1 || ny < y0 || ny > y1) continue;
            const nk = keyOf(nx, ny);
            if (structural(nk) && !seen.has(nk)) {
              seen.add(nk);
              queue.push([nx, ny]);
            }
          }
        }
        const leftover = extractObjects(S, region, false, opaqueT);
        if (leftover.length) buildVolume(S, leftover, doorFold, roofFold, gen3Roof);
      }
    }
  }

  buildRockPlateaus(S);
  foundBuildings(S);
  capRock(S);
  climbMasses(S);
  standLedges(S);
  buildFalls(S);
  standLedges(S);

  // ---- billboards (:11585): forced per-pixel slabs; posts one per cell ----
  {
    const seenB = new Set<number>();
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const k = keyOf(tx, ty);
        const s = shapeAt.get(k);
        if (!s || s.art !== "billboard" || seenB.has(k) || S.skip.has(k)) continue;
        const reg: Region = { tiles: [], minX: tx, maxX: tx, minY: ty, maxY: ty };
        const queue: [number, number][] = [[tx, ty]];
        seenB.add(k);
        while (queue.length) {
          const c = queue.pop()!;
          reg.tiles.push(c);
          reg.minX = Math.min(reg.minX, c[0]);
          reg.maxX = Math.max(reg.maxX, c[0]);
          reg.minY = Math.min(reg.minY, c[1]);
          reg.maxY = Math.max(reg.maxY, c[1]);
          for (const [dx, dy] of DIRS4) {
            const nk = keyOf(c[0] + dx, c[1] + dy);
            const ns = shapeAt.get(nk);
            if (ns && ns.art === "billboard" && ns.cls === s.cls && !seenB.has(nk)) {
              seenB.add(nk);
              queue.push([c[0] + dx, c[1] + dy]);
            }
          }
        }
        extractObjects(S, reg, true, opaqueT);
      }
    }
    const postCells = new Map<number, [number, number][]>();
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const s = shapeAt.get(keyOf(tx, ty));
        if (s && s.art === "post") {
          const c = keyOf(fl2(tx), fl2(ty));
          let l = postCells.get(c);
          if (!l) postCells.set(c, (l = []));
          l.push([tx, ty]);
        }
      }
    }
    for (const tiles of postCells.values()) {
      const reg: Region = { tiles, minX: tiles[0]![0], maxX: tiles[0]![0], minY: tiles[0]![1], maxY: tiles[0]![1] };
      for (const c of tiles) {
        reg.minX = Math.min(reg.minX, c[0]);
        reg.maxX = Math.max(reg.maxX, c[0]);
        reg.minY = Math.min(reg.minY, c[1]);
        reg.maxY = Math.max(reg.maxY, c[1]);
      }
      extractObjects(S, reg, "opaque", opaqueT);
    }
  }
  buildGrassMats(S);

  // the ground under every claimed cell that voted nothing: the commonest
  // flat ground on the map (forMap, after the billboards)
  {
    const votes = new Map<number, number>();
    let best: number | undefined;
    let bestN = 0;
    for (const [k, s] of shapeAt) {
      if (s.flat && s.cls === "ground") {
        const t = tileAt.get(k)!;
        const n = (votes.get(t) ?? 0) + 1;
        votes.set(t, n);
        if (n > bestN) [best, bestN] = [t, n];
      }
    }
    for (const [k, g] of S.ground) if (g === false && best !== undefined) S.ground.set(k, best);
  }
  standApron(S, ringCarved, hullRingOnly || ringRock);
  return S;
}

// ---------------------------------------------------------------------------
// hulls
// ---------------------------------------------------------------------------

function buildCylinders(
  S: SG,
  ctx: Ctx,
  groundTiles: number[],
  ringCarved: (tx: number, ty: number) => boolean,
  opaqueT: (tile: number, px: number, py: number) => boolean,
  rgbT: (tile: number, px: number, py: number) => [number, number, number],
  tileOrigin: (tile: number) => [number, number],
  steps: HullSteps,
): void {
  const grouped = new Set<number>();
  const cache = new Map<string, { quads: Quad[]; coarse: Quad[]; ground: number }>();
  const candidates = groundTiles.map((t) => (x: number, y: number) => rgbT(t, x % 8, y % 8));
  // the canvas over cells (cx, cy)..: band b of NX rows reads cell row bandCY[b]
  const canvasAt = (cx: number, cy: number, NX: number, NY: number, bandCY?: number[]): Canvas | null => {
    const tileOf = (px: number, py: number) => {
      const band = Math.floor(py / NX);
      const srcCY = bandCY ? bandCY[band]! : cy + band;
      return S.tileAt.get(keyOf(cx * 2 + Math.floor(px / 8), srcCY * 2 + Math.floor((py % NX) / 8)));
    };
    for (let py = 0; py < NY; py += 8) for (let px = 0; px < NX; px += 8) if (tileOf(px, py) === undefined) return null;
    return {
      NX,
      NY,
      opaque: (px, py) => opaqueT(tileOf(px, py)!, px % 8, py % 8),
      rgb: (px, py) => rgbT(tileOf(px, py)!, px % 8, py % 8),
      uv: (px, py) => {
        const [u, v] = tileOrigin(tileOf(px, py)!);
        return [u + (px % 8), v + (py % 8)];
      },
    };
  };
  // standZ (:20860): the lowest walkable neighbour's floor
  const standZ = (cx: number, cy: number) => {
    let best: number | undefined;
    for (const [dx, dy] of DIRS4) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!S.isWalkableCell(nx, ny)) continue;
      const ns = S.shapeAt.get(keyOf(nx * 2, ny * 2));
      const z = ns?.h;
      if (z !== undefined && (best === undefined || z < best)) best = z;
    }
    return best ?? 0;
  };
  const claim = (tk: number, ground: number | false, z: number) => {
    S.skip.add(tk);
    S.round.add(tk);
    S.ground.set(tk, ground);
    if (z > 0) {
      const old = S.shapeAt.get(tk);
      if (old && (old.base ?? 0) < z) S.shapeAt.set(tk, { ...old, base: z });
    }
  };
  const carve = (sig: string, cv: Canvas) => {
    let tpl = cache.get(sig);
    if (!tpl) {
      // THE 3DS CANNOT DRAW HIS CARVE AT ITS OWN RESOLUTION (ours): a 32px
      // crown carved per pixel is ~2,300 quads after the merges below, and a
      // town shows dozens of them at once. So the near level of detail is
      // his carve at 2x2 art px per voxel (~650 quads; the drawing stays at
      // full resolution on its front and back), the middle one at 4x4
      // (~135), and the far one the cells as plain boxes (mesh.ts). The
      // ground match is his, read off the full-resolution carve.
      const ground = roundHull(cv, 1, candidates).ground;
      const near = roundHull(cv, steps.near);
      const mid = roundHull(cv, steps.mid);
      const squash = (q: Quad[]) => mergeUvRects(mergePointQuads(q, S.colourAtUv), undefined, 16);
      tpl = { quads: squash(near.quads), coarse: squash(mid.quads), ground };
      cache.set(sig, tpl);
    }
    return tpl;
  };
  const tw = S.tw;
  const th = S.th;
  for (let cy = fl2(S.y0); cy <= fl2(S.y1); cy++) {
    for (let cx = fl2(S.x0); cx <= fl2(S.x1); cx++) {
      const ckey = ck(cx, cy);
      const k = keyOf(cx * 2, cy * 2);
      let s = S.shapeAt.get(k);
      if (grouped.has(ckey)) {
        const shared = s !== undefined && s.art === "canopy" && ctx.sceneryShared(cx, cy);
        if (!shared) s = undefined;
      }
      const inBody = cx >= 0 && cy >= 0 && cx < ctx.width && cy < ctx.height;
      const near = inBody || ringCarved(cx * 2, cy * 2);
      if (!s || !near) continue;
      if (s.art === "canopy") {
        const span = ctx.scenerySpan(cx, cy) === 3 ? 3 : 2;
        let whole = true;
        for (let dy = 0; dy < span; dy++) {
          for (let dx = 0; dx < span; dx++) {
            if (dx + dy === 0) continue;
            const ps = S.shapeAt.get(keyOf((cx + dx) * 2, (cy + dy) * 2));
            if (!(ps && (ps.art === "cylinder" || ps.art === "canopy"))) whole = false;
          }
        }
        if (!whole) continue;
        const NX = span * 16;
        const cols = span * 2;
        const cv = canvasAt(cx, cy, NX, NX);
        if (!cv) continue;
        const ids: number[] = [];
        for (let dy = 0; dy < cols; dy++) for (let dx = 0; dx < cols; dx++) ids.push(S.tileAt.get(keyOf(cx * 2 + dx, cy * 2 + dy))!);
        const tpl = carve(`g${NX}|${ids.join(":")}`, cv);
        let ground: number | false = tpl.ground >= 0 ? groundTiles[tpl.ground]! : false;
        if (ground !== false && span > 2) {
          // a big tree's floor is the flat ground round it, by vote
          const vote = new Map<number, number>();
          const have = new Set<number>();
          let best: number | undefined;
          let bestN = 0;
          for (let i = -1; i <= span; i++) {
            for (const [x, y] of [[cx + i, cy - 1], [cx + i, cy + span], [cx - 1, cy + i], [cx + span, cy + i]] as const) {
              const ns = S.shapeAt.get(keyOf(x * 2, y * 2));
              if (!(ns && ns.flat && ns.cls !== "void" && ns.cls !== "water")) continue;
              for (let dy = 0; dy <= 1; dy++) {
                for (let dx = 0; dx <= 1; dx++) {
                  const t = S.tileAt.get(keyOf(x * 2 + dx, y * 2 + dy));
                  if (t === undefined) continue;
                  have.add(t);
                  const n = (vote.get(t) ?? 0) + 1;
                  vote.set(t, n);
                  if (n > bestN) [best, bestN] = [t, n];
                }
              }
            }
          }
          if (best !== undefined && !have.has(ground)) ground = best;
        }
        const z = standZ(cx, cy);
        S.roundStamps.push({ quads: tpl.quads, coarse: tpl.coarse, mx: cx * 16 + NX / 2, mz: cy * 16 + NX / 2, r: NX / 2, my: z });
        for (let dy = 0; dy < cols; dy++) for (let dx = 0; dx < cols; dx++) claim(keyOf(cx * 2 + dx, cy * 2 + dy), ground, z);
        for (let gy = 0; gy < span; gy++) for (let gx = 0; gx < span; gx++) if (gx + gy > 0) grouped.add(ckey + gy * 8192 + gx);
        S.stats.canopies = (S.stats.canopies ?? 0) + 1;
      } else if (s.art === "cylinder") {
        // a lone hull; a leafy crown drawn over it stacks the two (:21430)
        let stackCY: number | undefined;
        let crownCY: number | undefined;
        if (S.outdoor && s.cls !== "stump" && s.cls !== "can" && cy > 0) {
          const mB = ctx.metatileAt(cx, cy - 1);
          const stB = ctx.statsOf(mB);
          if (stB && stB.leafy) {
            const rB = ctx.metaRole(mB);
            const fullBleed = stB.solid >= 0.99;
            const allOverhang = !!rB && rB.material === "green" && rB.cap === 0 && rB.face > 0;
            let blockedAbove = false;
            const floorZ = S.shapeAt.get(keyOf(cx * 2, cy * 2))?.h ?? 0;
            for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
              const nx = cx + dx;
              const ny = cy + dy;
              if (nx >= 0 && ny >= 0 && nx < ctx.width && ny < ctx.height && S.isWalkableCell(nx, ny)) {
                const nz = S.shapeAt.get(keyOf(nx * 2, ny * 2))?.h ?? 0;
                if (nz >= floorZ + COURSE) blockedAbove = true;
              }
            }
            let crownDrawn = true;
            for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) if (S.tileAt.get(keyOf(cx * 2 + dx, (cy - 1) * 2 + dy)) === undefined) crownDrawn = false;
            if ((fullBleed || allOverhang) && !blockedAbove && crownDrawn) {
              stackCY = cy - 1;
              if (S.isWalkableCell(cx, cy - 1)) crownCY = cy - 1;
            }
          }
        }
        const cv = stackCY !== undefined ? canvasAt(cx, cy, 16, 32, [stackCY, cy]) : canvasAt(cx, cy, 16, 16);
        if (!cv) continue;
        const ids: number[] = [];
        for (const yy of stackCY !== undefined ? [stackCY, cy] : [cy]) {
          for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) ids.push(S.tileAt.get(keyOf(cx * 2 + dx, yy * 2 + dy))!);
        }
        const tpl = carve(`c${stackCY !== undefined ? "32" : "16"}|${ids.join(":")}`, cv);
        const ground: number | false = tpl.ground >= 0 ? groundTiles[tpl.ground]! : false;
        const z = standZ(cx, cy);
        S.roundStamps.push({ quads: tpl.quads, coarse: tpl.coarse, mx: cx * 16 + 8, mz: cy * 16 + 8, r: 8, my: z });
        if (crownCY !== undefined) for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) claim(keyOf(cx * 2 + dx, crownCY * 2 + dy), ground, z);
        for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) claim(keyOf(cx * 2 + dx, cy * 2 + dy), ground, z);
        S.stats.cylinders = (S.stats.cylinders ?? 0) + 1;
      }
    }
  }
  // ---- rocks in water: a hull over sea that stays sea (:19075 buildWaterRocks)
  for (const [cx, cy, n] of ctx.waterRocks) {
    const NX = n * 16;
    const cv = canvasAt(cx, cy, NX, NX);
    if (!cv) continue;
    const ids: number[] = [];
    for (let dy = 0; dy < n * 2; dy++) for (let dx = 0; dx < n * 2; dx++) ids.push(S.tileAt.get(keyOf(cx * 2 + dx, cy * 2 + dy))!);
    const sig = `w${NX}|${ids.join(":")}`;
    let tpl = cache.get(sig);
    if (!tpl) {
      const squash = (q: Quad[]) => mergeUvRects(mergePointQuads(q, S.colourAtUv), undefined, 16);
      tpl = { quads: squash(roundHull(cv, steps.near, [], true).quads), coarse: squash(roundHull(cv, steps.mid, [], true).quads), ground: -1 };
      cache.set(sig, tpl);
    }
    if (!tpl.quads.length) continue;
    const my = S.shapeAt.get(keyOf(cx * 2, cy * 2))?.h ?? 0;
    S.roundStamps.push({ quads: tpl.quads, coarse: tpl.coarse, mx: cx * 16 + NX / 2, mz: cy * 16 + NX / 2, r: NX / 2, my });
    S.stats.waterRocks = (S.stats.waterRocks ?? 0) + 1;
  }
  void tw;
  void th;
}

// ---------------------------------------------------------------------------
// per-pixel objects (extractObjects :24771, buildObject :25186)
// ---------------------------------------------------------------------------

interface Region {
  tiles: [number, number][];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

function shadeClass(v: number): string {
  if (v <= 0.25) return "black";
  if (v <= 0.55) return "dark";
  if (v <= 0.85) return "light";
  return "white";
}

function extractObjects(
  S: SG,
  region: Region,
  force: boolean | "opaque",
  opaqueT: (tile: number, px: number, py: number) => boolean,
): [number, number][] {
  const bw = (region.maxX - region.minX + 1) * 8;
  const bh = (region.maxY - region.minY + 1) * 8;
  const member = new Set(region.tiles.map((c) => keyOf(c[0], c[1])));
  const Wd = bw + 2;
  const Hd = bh + 2;
  const state: (string | undefined)[] = new Array(Wd * Hd);
  const srcTile: number[] = new Array(Wd * Hd);
  const srcPx: number[] = new Array(Wd * Hd);
  for (let iy = 0; iy < Hd; iy++) {
    for (let ix = 0; ix < Wd; ix++) {
      const i = iy * Wd + ix;
      const px = ix - 1;
      const py = iy - 1;
      const tx = region.minX + Math.floor(px / 8);
      const ty = region.minY + Math.floor(py / 8);
      const k = keyOf(tx, ty);
      const inside = px >= 0 && px < bw && py >= 0 && py < bh;
      const apron = iy === Hd - 1 || ((force || !S.outdoor) && (iy === 0 || ix === 0 || ix === Wd - 1));
      if (inside && member.has(k)) {
        const tile = S.tileAt.get(k)!;
        srcTile[i] = tile;
        srcPx[i] = (py % 8) * 8 + (px % 8);
        // GEN 3: the shape surface's alpha is the silhouette; forced pools
        // keep every opaque texel
        state[i] = opaqueT(tile, px % 8, py % 8) ? "solid" : "cand";
      } else if (inside || apron) {
        if (force) state[i] = inside ? "iair" : "air";
        else {
          const s = S.shapeAt.get(k);
          state[i] = s && s.flat && s.cls !== "void" ? "air" : "barrier";
        }
      } else state[i] = "barrier";
    }
  }
  // flood the background from the air
  const flooded = new Uint8Array(Wd * Hd);
  const queue: number[] = [];
  for (let i = 0; i < state.length; i++) {
    if (state[i] === "air" || state[i] === "iair") {
      flooded[i] = 1;
      queue.push(i);
    }
  }
  while (queue.length) {
    const i = queue.pop()!;
    const ix = i % Wd;
    const iy = Math.floor(i / Wd);
    for (const [dx, dy] of DIRS4) {
      const nx = ix + dx;
      const ny = iy + dy;
      if (nx < 0 || nx >= Wd || ny < 0 || ny >= Hd) continue;
      const ni = ny * Wd + nx;
      if (flooded[ni]) continue;
      const ns = state[ni];
      if (ns === "cand" || ns === "air" || ns === "iair") {
        flooded[ni] = 1;
        queue.push(ni);
      }
    }
  }
  // which tiles are sprite-like
  const sprite = new Set<number>();
  for (const c of region.tiles) {
    const k = keyOf(c[0], c[1]);
    if (force) sprite.add(k);
    else {
      const bx = (c[0] - region.minX) * 8;
      const by = (c[1] - region.minY) * 8;
      let bg = 0;
      for (let py = 0; py < 8; py++) for (let px = 0; px < 8; px++) if (flooded[(by + py + 1) * Wd + (bx + px + 1)]) bg++;
      if (bg / 64 >= TILE_BG_RATIO) sprite.add(k);
    }
  }
  const claimed = new Set<number>();
  const clusterSeen = new Set<number>();
  for (const c of region.tiles) {
    const k = keyOf(c[0], c[1]);
    if (!sprite.has(k) || clusterSeen.has(k)) continue;
    const cluster: Region = { tiles: [], minX: c[0], maxX: c[0], minY: c[1], maxY: c[1] };
    const q: [number, number][] = [c];
    clusterSeen.add(k);
    while (q.length) {
      const cc = q.pop()!;
      cluster.tiles.push(cc);
      cluster.minX = Math.min(cluster.minX, cc[0]);
      cluster.maxX = Math.max(cluster.maxX, cc[0]);
      cluster.minY = Math.min(cluster.minY, cc[1]);
      cluster.maxY = Math.max(cluster.maxY, cc[1]);
      for (const [dx, dy] of DIRS4) {
        const nk = keyOf(cc[0] + dx, cc[1] + dy);
        if (sprite.has(nk) && !clusterSeen.has(nk)) {
          clusterSeen.add(nk);
          q.push([cc[0] + dx, cc[1] + dy]);
        }
      }
    }
    let scaffold = false;
    if (!force) {
      for (const cc of cluster.tiles) {
        const sh = S.shapeAt.get(keyOf(cc[0], cc[1]));
        if (sh && (sh.cls === "shell" || (!S.outdoor && sh.cls === "counter"))) scaffold = true;
      }
    }
    if (!scaffold && buildObject(S, region, cluster, state, flooded, srcTile, srcPx, Wd, force)) {
      for (const cc of cluster.tiles) claimed.add(keyOf(cc[0], cc[1]));
    }
  }
  return region.tiles.filter((c) => !claimed.has(keyOf(c[0], c[1])));
}

function buildObject(
  S: SG,
  region: Region,
  cluster: Region,
  state: (string | undefined)[],
  flooded: Uint8Array,
  srcTile: number[],
  srcPx: number[],
  Wd: number,
  force: boolean | "opaque",
): boolean {
  const rows = cluster.maxY - cluster.minY + 1;
  if (!force) {
    if (rows > OBJECT_MAX_ROWS) return false;
    const dirs: [number, number][] = S.outdoor ? [[0, 1]] : DIRS4;
    let touches = false;
    for (const c of cluster.tiles) {
      for (const [dx, dy] of dirs) {
        const ss = S.shapeAt.get(keyOf(c[0] + dx, c[1] + dy));
        if (ss && ss.flat && ss.cls !== "void") touches = true;
      }
    }
    if (!touches) return false;
    const cols = new Map<number, Set<number>>();
    for (const c of cluster.tiles) {
      let s = cols.get(c[0]);
      if (!s) cols.set(c[0], (s = new Set()));
      s.add(c[1]);
    }
    for (const [tx, ys] of cols) {
      const front = Math.max(...ys);
      let extent = 0;
      while (ys.has(front - extent)) extent++;
      if (extent > 1) {
        const t0 = S.rawTile(tx, front);
        for (let k = 1; k < extent; k++) if (S.rawTile(tx, front - k) === t0) return false;
      }
    }
  }
  const memberC = new Set(cluster.tiles.map((c) => keyOf(c[0], c[1])));
  const bw = (cluster.maxX - cluster.minX + 1) * 8;
  const bh = (cluster.maxY - cluster.minY + 1) * 8;
  const solidPx = new Map<number, number>();
  let count = 0;
  let bgCount = 0;
  for (const c of cluster.tiles) {
    const rx = (c[0] - region.minX) * 8;
    const ry = (c[1] - region.minY) * 8;
    for (let py = 0; py < 8; py++) {
      for (let px = 0; px < 8; px++) {
        const i = (ry + py + 1) * Wd + (rx + px + 1);
        const st = state[i];
        const on = st !== undefined && st !== "air" && st !== "iair" && st !== "barrier" && !flooded[i];
        if (on) {
          const lx = (c[0] - cluster.minX) * 8 + px;
          const ly = (c[1] - cluster.minY) * 8 + py;
          solidPx.set(ly * bw + lx, i);
          count++;
        } else bgCount++;
      }
    }
  }
  if (count === 0 || count > OBJECT_MAX_QUADS) return false;
  if (!force && bgCount / (count + bgCount) < CLUSTER_MIN_BG) return false;
  if (!force) {
    let pminx = bw;
    let pmaxx = -1;
    let pminy = bh;
    let pmaxy = -1;
    for (const idx of solidPx.keys()) {
      const lx = idx % bw;
      const ly = Math.floor(idx / bw);
      pminx = Math.min(pminx, lx);
      pmaxx = Math.max(pmaxx, lx);
      pminy = Math.min(pminy, ly);
      pmaxy = Math.max(pmaxy, ly);
    }
    const rw = pmaxx - pminx + 1;
    const rh = pmaxy - pminy + 1;
    if (pmaxx >= pminx && rw >= 4 && rh >= 4 && count >= rw * rh) return false;
  }
  let depth = OBJECT_DEPTH;
  if (force) {
    const cs = S.shapeAt.get(keyOf(cluster.tiles[0]![0], cluster.tiles[0]![1]));
    depth = (cs && PINNED_DEPTH[cs.cls]) || PINNED_DEPTH.billboard!;
  }
  const wx0 = cluster.minX * 8;
  // the floor it stands on: its own cell's height
  let baseY = 0;
  {
    const fs = S.shapeAt.get(keyOf(cluster.minX, cluster.maxY));
    if (fs && fs.flat) baseY = fs.h;
    else {
      const ss = S.shapeAt.get(keyOf(cluster.minX, cluster.maxY + 1));
      if (ss && ss.flat && ss.cls !== "void" && ss.cls !== "water") baseY = Math.max(0, ss.h);
    }
  }
  const at = (lx: number, ly: number) => (lx < 0 || lx >= bw || ly < 0 || ly >= bh ? undefined : solidPx.get(ly * bw + lx));
  // 8-connected components; each stands on its own lowest row
  const comp = new Map<number, { lowY: number; n: number; z0: number; z1: number }>();
  const comps: { lowY: number; n: number; z0: number; z1: number }[] = [];
  for (let ly = 0; ly < bh; ly++) {
    for (let lx = 0; lx < bw; lx++) {
      const idx = ly * bw + lx;
      if (!solidPx.has(idx) || comp.has(idx)) continue;
      const c = { lowY: ly, n: 0, z0: 0, z1: 0 };
      comps.push(c);
      const stack = [idx];
      comp.set(idx, c);
      while (stack.length) {
        const p = stack.pop()!;
        const px = p % bw;
        const py = Math.floor(p / bw);
        c.n++;
        if (py > c.lowY) c.lowY = py;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = px + dx;
            const ny = py + dy;
            if ((dx || dy) && nx >= 0 && nx < bw && ny >= 0 && ny < bh) {
              const ni = ny * bw + nx;
              if (solidPx.has(ni) && !comp.has(ni)) {
                comp.set(ni, c);
                stack.push(ni);
              }
            }
          }
        }
      }
    }
  }
  for (const c of comps) {
    c.z0 = cluster.minY * 8 + Math.floor(c.lowY / 8) * 8 + (8 - depth) / 2;
    c.z1 = c.z0 + depth;
  }
  const uvOf = (i: number): [number, number] => {
    const [u, v] = S.tileOrigin(srcTile[i]!);
    const p = srcPx[i]!;
    return [u + (p % 8) + 0.5, v + Math.floor(p / 8) + 0.5];
  };
  const quads = S.objectQuads;
  const q0 = quads.length;
  // front/back faces merged into row runs of texels contiguous in the art
  // (ours: his object pass emits a quad per pixel; a run spanning the same
  // texels in order draws exactly the same picture)
  // ... and runs of the same span, component and art tile in consecutive
  // rows of one 8px band stacked into one rectangle (the texels under it are
  // the same block of the art, row for row)
  type RowRun = { lx: number; lx2: number; ly: number; ly2: number; c: { lowY: number; z0: number; z1: number }; t: number; i0: number; i1: number };
  const open = new Map<string, RowRun>();
  const rects: RowRun[] = [];
  for (let ly = 0; ly < bh; ly++) {
    const seen = new Set<string>();
    let lx = 0;
    while (lx < bw) {
      const i = at(lx, ly);
      if (i === undefined) {
        lx++;
        continue;
      }
      const c = comp.get(ly * bw + lx)!;
      let lx2 = lx;
      while (lx2 + 1 < bw) {
        const j = at(lx2 + 1, ly);
        if (j === undefined || comp.get(ly * bw + lx2 + 1) !== c || srcTile[j] !== srcTile[i] || Math.floor((lx2 + 1) / 8) !== Math.floor(lx / 8)) break;
        lx2++;
      }
      const t = srcTile[i]!;
      const key = `${lx},${lx2}`;
      const prev = open.get(key);
      if (prev && prev.c === c && prev.t === t && prev.ly2 === ly - 1 && Math.floor(ly / 8) === Math.floor(prev.ly / 8)) {
        prev.ly2 = ly;
        prev.i1 = at(lx2, ly)!;
      } else {
        const r: RowRun = { lx, lx2, ly, ly2: ly, c, t, i0: i, i1: at(lx2, ly)! };
        rects.push(r);
        open.set(key, r);
      }
      seen.add(key);
      lx = lx2 + 1;
    }
    for (const k of [...open.keys()]) if (!seen.has(k)) open.delete(k);
  }
  for (const r of rects) {
    const { c } = r;
    const x = wx0 + r.lx;
    const xb = wx0 + r.lx2 + 1;
    const y = baseY + c.lowY - r.ly2;
    const yt = baseY + c.lowY - r.ly + 1;
    const [ua, va] = uvOf(r.i0);
    const [ub, vb] = uvOf(r.i1);
    const u0 = ua - 0.45;
    const u1 = ub + 0.45;
    const v0 = va - 0.45;
    const v1 = vb + 0.45;
    quads.push({ c: [[x, y, c.z1], [xb, y, c.z1], [xb, yt, c.z1], [x, yt, c.z1]], uv: [[u0, v1], [u1, v1], [u1, v0], [u0, v0]], shade: OBJ_SHADE.front, f: 5 });
    quads.push({ c: [[xb, y, c.z0], [x, y, c.z0], [x, yt, c.z0], [xb, yt, c.z0]], uv: [[u1, v1], [u0, v1], [u0, v0], [u1, v0]], shade: OBJ_SHADE.back, f: 6 });
  }
  // the edges: his object pass emits each exposed pixel face point-sampled
  // with its own texel; here a RUN of such faces along a row (tops,
  // undersides) or a column (sides) of one component and one 8px art tile is
  // one quad whose texture walks the same texels in order -- the same
  // picture, a fraction of the quads (ours)
  const yOf = (ly: number, c: { lowY: number }) => baseY + c.lowY - ly;
  for (const [dy, shade, f] of [[-1, OBJ_SHADE.top, 3], [1, OBJ_SHADE.bottom, 4]] as const) {
    for (let ly = 0; ly < bh; ly++) {
      let lx = 0;
      while (lx < bw) {
        const i = at(lx, ly);
        const c = i === undefined ? undefined : comp.get(ly * bw + lx)!;
        const exposed = (x2: number) => {
          const j = at(x2, ly);
          if (j === undefined || at(x2, ly + dy) !== undefined || comp.get(ly * bw + x2) !== c || srcTile[j] !== srcTile[i!]) return false;
          return dy < 0 || yOf(ly, c!) > baseY;
        };
        if (i === undefined || !exposed(lx)) {
          lx++;
          continue;
        }
        let lx2 = lx;
        while (lx2 + 1 < bw && Math.floor((lx2 + 1) / 8) === Math.floor(lx / 8) && exposed(lx2 + 1)) lx2++;
        const y = yOf(ly, c!) + (dy < 0 ? 1 : 0);
        const x = wx0 + lx;
        const xb = wx0 + lx2 + 1;
        const [ua, v] = uvOf(i);
        const [ub] = uvOf(at(lx2, ly)!);
        const u0 = ua - 0.45;
        const u1 = ub + 0.45;
        const { z0, z1 } = c!;
        if (dy < 0) quads.push({ c: [[x, y, z0], [xb, y, z0], [xb, y, z1], [x, y, z1]], uv: [[u0, v], [u1, v], [u1, v], [u0, v]], shade, f });
        else quads.push({ c: [[x, y, z1], [xb, y, z1], [xb, y, z0], [x, y, z0]], uv: [[u0, v], [u1, v], [u1, v], [u0, v]], shade, f });
        lx = lx2 + 1;
      }
    }
  }
  for (const [dx, f] of [[-1, 2], [1, 1]] as const) {
    for (let lx = 0; lx < bw; lx++) {
      let ly = 0;
      while (ly < bh) {
        const i = at(lx, ly);
        const c = i === undefined ? undefined : comp.get(ly * bw + lx)!;
        const exposed = (y2: number) => {
          const j = at(lx, y2);
          return j !== undefined && at(lx + dx, y2) === undefined && comp.get(y2 * bw + lx) === c && srcTile[j] === srcTile[i!];
        };
        if (i === undefined || !exposed(ly)) {
          ly++;
          continue;
        }
        let ly2 = ly;
        while (ly2 + 1 < bh && Math.floor((ly2 + 1) / 8) === Math.floor(ly / 8) && exposed(ly2 + 1)) ly2++;
        const x = wx0 + lx + (dx > 0 ? 1 : 0);
        const yTop = yOf(ly, c!) + 1;
        const yBot = yOf(ly2, c!);
        const [u, va] = uvOf(i);
        const [, vb] = uvOf(at(lx, ly2)!);
        const v0 = va - 0.45;
        const v1 = vb + 0.45;
        const { z0, z1 } = c!;
        if (dx < 0) quads.push({ c: [[x, yBot, z0], [x, yBot, z1], [x, yTop, z1], [x, yTop, z0]], uv: [[u, v1], [u, v1], [u, v0], [u, v0]], shade: OBJ_SHADE.side, f });
        else quads.push({ c: [[x, yBot, z1], [x, yBot, z0], [x, yTop, z0], [x, yTop, z1]], uv: [[u, v1], [u, v1], [u, v0], [u, v0]], shade: OBJ_SHADE.side, f });
        ly = ly2 + 1;
      }
    }
  }
  // the floor under it: the commonest flat neighbour
  const votes = new Map<number, number>();
  let best: number | undefined;
  let bestN = 0;
  for (const c of cluster.tiles) {
    for (const [dx, dy] of DIRS4) {
      const nk = keyOf(c[0] + dx, c[1] + dy);
      const ns = S.shapeAt.get(nk);
      if (ns && ns.flat && ns.cls !== "void" && !memberC.has(nk)) {
        const t = S.tileAt.get(nk)!;
        const n = (votes.get(t) ?? 0) + 1;
        votes.set(t, n);
        if (n > bestN) [best, bestN] = [t, n];
      }
    }
  }
  // (ours) a fence stands at its class height: the drawing, however tall it
  // is drawn, squashed onto the 10px his class states (shapes.ts ART.fence)
  const cls0 = S.shapeAt.get(keyOf(cluster.tiles[0]![0], cluster.tiles[0]![1]))?.cls;
  if (force && cls0 === "fence") {
    let top = baseY;
    for (let qi = q0; qi < quads.length; qi++) for (const c of quads[qi]!.c) top = Math.max(top, c[1]);
    const k = top > baseY ? Math.min(1, CLASS_H.fence! / (top - baseY)) : 1;
    if (k < 1) {
      for (let qi = q0; qi < quads.length; qi++) {
        const q = quads[qi]!;
        q.c = q.c.map(([x, y, z]) => [x, baseY + (y - baseY) * k, z]) as typeof q.c;
      }
    }
  }
  for (const c of cluster.tiles) {
    const k = keyOf(c[0], c[1]);
    S.skip.add(k);
    S.ground.set(k, best ?? false);
    if (baseY > 0) {
      const old = S.shapeAt.get(k);
      if (old) S.shapeAt.set(k, { ...old, base: baseY });
    }
  }
  S.stats.objects = (S.stats.objects ?? 0) + 1;
  return true;
}

// ---------------------------------------------------------------------------
// volumes (buildVolume :23017, the Gen 3 arm)
// ---------------------------------------------------------------------------

function roofPlanTable(S: SG): { plan: Set<number>; inside: Set<number> } {
  const memo = (S as unknown as { _plan?: { plan: Set<number>; inside: Set<number> } })._plan;
  if (memo) return memo;
  const plan = new Set<number>();
  const inside = new Set<number>();
  const bd = S.ctx.buildings();
  for (const bl of bd.list) {
    const byRow = new Map<number, number[]>();
    for (const c of bl.cells) {
      inside.add(ck(c[0], c[1]));
      let r = byRow.get(c[1]);
      if (!r) byRow.set(c[1], (r = []));
      r.push(c[0]);
    }
    for (const [ry, xs] of byRow) {
      xs.sort((a, b) => a - b);
      let lo = 0;
      let hi = xs.length - 1;
      if (xs.length >= 3) {
        lo = 1;
        hi = xs.length - 2;
      }
      let whole = true;
      for (let i = lo; i <= hi; i++) if (!S.ctx.roofAt(xs[i]!, ry)) whole = false;
      if (whole) for (const rx of xs) if (S.ctx.roofAt(rx, ry)) plan.add(ck(rx, ry));
    }
  }
  const t = { plan, inside };
  (S as unknown as { _plan?: typeof t })._plan = t;
  return t;
}

/** Structures.lua:5584 gen3RoofPlanAt */
function roofPlanAt(S: SG, gen3Roof: Set<number>, cx: number, cy: number): boolean {
  const t = roofPlanTable(S);
  if (!t.inside.has(ck(cx, cy))) return gen3Roof.has(keyOf(cx * 2, cy * 2));
  return t.plan.has(ck(cx, cy));
}

/** Structures.lua:5673 gen3RoofUnseen */
function roofUnseen(S: SG, cx: number, cy: number): boolean {
  if (S.ctx.offMap(cx, cy) || S.ctx.blockedAt(cx, cy)) return false;
  const st = S.ctx.statsOf(S.ctx.metatileAt(cx, cy));
  return !!(st && st.overhead && st.solid >= 0.9 && !st.leafy);
}

function buildVolume(S: SG, tiles: [number, number][], doorFold: Set<number>, roofFold: Set<number>, gen3Roof: Set<number>): void {
  const ctx = S.ctx;
  const cols = new Map<number, Set<number>>();
  for (const c of tiles) {
    let s = cols.get(c[0]);
    if (!s) cols.set(c[0], (s = new Set()));
    s.add(c[1]);
  }
  // A ROOM'S WALL IS DRAWN INSIDE THE ROOM
  const clipY = !S.outdoor ? ctx.height * 2 - 1 : null;
  const clipX = ctx.width * 2 - 1;
  const spans = (ys: Set<number>): [number, number][] => {
    const sorted = [...ys].sort((a, b) => a - b);
    const out: [number, number][] = [];
    let i = 0;
    while (i < sorted.length) {
      const n = sorted[i]!;
      let f = n;
      while (i + 1 < sorted.length && sorted[i + 1] === f + 1) f = sorted[++i]!;
      i++;
      out.push([n, f]);
    }
    return out;
  };
  // THE REGION'S OWN SPAN
  let spanN: number | undefined;
  let spanF: number | undefined;
  {
    const votes = new Map<string, number>();
    let best: [number, number] | undefined;
    let bestN = 0;
    let total = 0;
    for (const ys of cols.values()) {
      for (const [n, f] of spans(ys)) {
        const k = `${n}:${f}`;
        const v = (votes.get(k) ?? 0) + 1;
        votes.set(k, v);
        total++;
        if (v > bestN) [best, bestN] = [[n, f], v];
      }
    }
    if (best && total >= 3 && bestN * 3 >= total && total <= 64 && best[1] - best[0] + 1 <= GEN3_MAX_ROWS) [spanN, spanF] = best;
  }
  const bd = ctx.buildings();
  const doorsKnown = bd.list.length > 0;
  const isB = (tx: number, ty: number) => ctx.isBuildingCell(fl2(tx), fl2(ty));
  const runs: { tx: number; run: Run }[] = [];
  const heightVotes = new Map<number, number>();
  const repeatVotes = new Map<number, number>();
  for (const [tx, ys] of [...cols].sort((a, b) => a[0] - b[0])) {
    for (let [north, front] of spans(ys)) {
      // A FACADE STARTS AT ITS ROOF
      let facade = false;
      if (doorsKnown) {
        let firstRoof: number | undefined;
        for (let ty = north; ty <= front; ty++) {
          if (gen3Roof.has(keyOf(tx, ty))) {
            firstRoof = ty;
            break;
          }
        }
        if (firstRoof !== undefined && firstRoof > north && isB(tx, firstRoof)) {
          // FRLG (ours): the rows above the first roof row that are the SAME
          // building's are its top course (FRLG draws a parapet or eave under
          // the player and the storeys over it), not landscape the run walked
          // into, so they stay in the column
          let n2 = firstRoof;
          while (n2 - 1 >= north && isB(tx, n2 - 1)) n2--;
          // ...and so is the roof course his roof fold stood up behind it
          while (n2 - 1 >= north && roofFold.has(keyOf(tx, n2 - 1))) n2--;
          north = n2;
          facade = true;
        }
      }
      if (spanN !== undefined && !facade && doorsKnown) {
        for (let ty = north; ty <= front; ty++) if (isB(tx, ty)) facade = true;
      }
      if (spanN !== undefined && spanF !== undefined && !facade) {
        if (north < spanN && front >= spanN) north = spanN;
        if (front > spanF && north <= spanF) front = spanF;
      }
      if (clipY !== null && tx >= 0 && tx <= clipX && front >= 0 && north <= clipY) {
        if (north < 0) north = 0;
        if (front > clipY) front = clipY;
      }
      const extent = front - north + 1;
      let unit = Math.min(extent, MAX_ROWS);
      let repeatRead = false;
      if (extent > 1) {
        const t0 = S.rawTile(tx, front);
        for (let k = 1; k < extent; k++) {
          if (S.rawTile(tx, front - k) === t0) {
            unit = Math.min(Math.max(k, 2), MAX_ROWS);
            repeatRead = true;
            break;
          }
        }
        if (!repeatRead && extent > 2 && S.rawTile(tx, front - 1) === S.rawTile(tx, front - 2)) {
          unit = 2;
          repeatRead = true;
        }
      }
      let foldRows = 0;
      for (let ty = north; ty <= front; ty++) {
        if (roofFold.has(keyOf(tx, ty))) foldRows++;
        else break;
      }
      // HOW DEEP THE BUILDING IS, ASKED OF THE BUILDING
      let gen3Bld: number | undefined;
      let gen3BldRows = 0;
      let gen3BldPlan = 0;
      if (doorsKnown) {
        const cx = fl2(tx);
        const id = bd.cell.get(ck(cx, fl2(front)));
        if (id !== undefined) {
          let top = front;
          for (let ty = front; ty >= 0; ty--) {
            if (bd.cell.get(ck(cx, fl2(ty))) === id) top = ty;
            else break;
          }
          gen3Bld = id;
          gen3BldRows = front - top + 1;
          for (let ty = top; ty <= front; ty++) {
            const cy2 = fl2(ty);
            if (roofPlanAt(S, gen3Roof, cx, cy2)) gen3BldPlan++;
            else if (!roofUnseen(S, cx, cy2)) break;
          }
        }
      }
      let gen3RoofRows = 0;
      let gen3PlanRows = 0;
      for (let ty = north + foldRows; ty <= front; ty++) {
        if (gen3Roof.has(keyOf(tx, ty))) gen3RoofRows++;
        else break;
      }
      for (let ty = north + foldRows; ty <= front; ty++) {
        const cx2 = fl2(tx);
        const cy2 = fl2(ty);
        if (roofPlanAt(S, gen3Roof, cx2, cy2)) gen3PlanRows++;
        else if (!roofUnseen(S, cx2, cy2)) break;
      }
      if (gen3RoofRows > 0 && extent <= GEN3_MAX_ROWS) {
        unit = extent;
        repeatRead = false;
      } else if (gen3RoofRows > 0 && gen3Bld !== undefined && gen3BldRows > GEN3_MAX_ROWS && gen3BldRows <= extent) {
        unit = gen3BldRows;
        repeatRead = false;
      }
      if (foldRows > 0 && unit > foldRows) unit -= foldRows;
      let isDoor = false;
      for (let ty = north; ty <= front; ty++) if (doorFold.has(keyOf(tx, ty))) isDoor = true;
      const under = S.shapeAt.get(keyOf(tx, front + 1));
      let runBase = under && (under.flat || under.cls === "terrace") && under.cls !== "void" ? under.h : 0;
      if (runBase < 0) runBase = 0;
      const run: Run = {
        front, north, extent, unit, fromRepeat: repeatRead, door: isDoor,
        gen3RoofRows: gen3RoofRows > 0 ? gen3RoofRows : undefined,
        gen3PlanRows, gen3Bld, gen3BldRows: gen3BldRows > 0 ? gen3BldRows : undefined, gen3BldPlan,
        foldRows: foldRows > 0 ? foldRows : undefined, base: runBase,
        roofRows: 0, rise: 0, peak: 0, h: 0,
      };
      runs.push({ tx, run });
      const h = unit * 8;
      heightVotes.set(h, (heightVotes.get(h) ?? 0) + 1);
      if (repeatRead) repeatVotes.set(h, (repeatVotes.get(h) ?? 0) + 1);
    }
  }
  // region consensus
  let modeH = 16;
  let modeN = 0;
  for (const [h, n] of heightVotes) if (n > modeN || (n === modeN && h > modeH)) [modeH, modeN] = [h, n];
  const modeRepeat = (repeatVotes.get(modeH) ?? 0) * 2 > modeN;
  let regionRoofRows = 0;
  let regionRoofH = 0;
  let regionExtent = 0;
  let regionPlanRows = 0;
  let regionBaseMin: number | undefined;
  let regionBaseMax: number | undefined;
  let regionMaxH = 0;
  let regionMaxExtent = 0;
  for (const r of runs) {
    regionMaxH = Math.max(regionMaxH, r.run.unit * 8);
    regionMaxExtent = Math.max(regionMaxExtent, r.run.extent);
  }
  const regionCompact = S.outdoor && runs.length > 1 && runs.length <= 64 && regionMaxExtent <= GEN3_MAX_ROWS;
  // A ROOF IS PITCHED OR IT IS FLAT, AND THE WHOLE BUILDING AGREES
  let regionFlatRoof = false;
  if (regionCompact) {
    let votes = 0;
    for (const r of runs) {
      const run = r.run;
      if ((run.gen3RoofRows ?? 0) > 0 && run.north + 4 <= run.front) {
        const rowTile = (ty: number) => S.tileAt.get(keyOf(r.tx, ty)) ?? S.rawTile(r.tx, ty);
        const a0 = rowTile(run.north);
        const a2 = rowTile(run.north + 2);
        const a4 = rowTile(run.north + 4);
        if (a0 === a2 || a2 === a4) votes++;
      }
    }
    regionFlatRoof = votes >= 2;
  }
  for (const r of runs) {
    const rr = r.run.gen3RoofRows;
    if (!rr) continue;
    regionRoofRows = Math.max(regionRoofRows, rr);
    regionPlanRows = Math.max(regionPlanRows, r.run.gen3PlanRows || rr);
    regionRoofH = Math.max(regionRoofH, r.run.unit * 8);
    regionExtent = Math.max(regionExtent, r.run.extent);
    const b = r.run.base;
    if (regionBaseMin === undefined || b < regionBaseMin) regionBaseMin = b;
    if (regionBaseMax === undefined || b > regionBaseMax) regionBaseMax = b;
  }
  const bldExtent = new Map<number, number>();
  const bldPlan = new Map<number, number>();
  for (const r of runs) {
    const id = r.run.gen3Bld;
    if (id !== undefined && (r.run.gen3RoofRows ?? 0) > 0) {
      bldExtent.set(id, Math.max(bldExtent.get(id) ?? 0, r.run.gen3BldRows ?? 0));
      bldPlan.set(id, Math.max(bldPlan.get(id) ?? 0, r.run.gen3BldPlan));
    }
  }
  // THE ROOF COURSE THAT IS DRAWN BUT NOT BUILT
  let roofArtAbove = 0;
  if (regionRoofRows > 0) {
    let north: number | undefined;
    for (const r of runs) if (north === undefined || r.run.north < north) north = r.run.north;
    for (const r of runs) if (r.run.north !== north) north = undefined;
    if (north !== undefined && north >= 2) {
      const cy = fl2(north) - 1;
      let ok = true;
      let any = false;
      for (const r of runs) {
        const cx = fl2(r.tx);
        const st = ctx.offMap(cx, cy) ? undefined : ctx.statsOf(ctx.metatileAt(cx, cy));
        const nk = keyOf(r.tx, north - 1);
        const sh = S.shapeAt.get(nk);
        const free = !S.runs.has(nk) && !S.skip.has(nk) && !!sh && sh.cls === "ground" && sh.art === "flat";
        if (!(st && free && !st.leafy && st.n2 > 0 && st.solid >= 0.3)) {
          ok = false;
          break;
        }
        any = true;
      }
      if (ok && any) roofArtAbove = 2;
    }
  }
  const drawnOf = (r: { tx: number; run: Run }) => {
    let sum = 0;
    let n = 0;
    for (let ty = r.run.north; ty <= r.run.front; ty += 2) {
      const cx = fl2(r.tx);
      const cy = fl2(ty);
      const st = ctx.statsOf(ctx.metatileAt(cx, cy));
      if (st) {
        sum += st.solid;
        n++;
      }
    }
    return n ? sum / n : undefined;
  };
  const roofedNorth = new Map<number, number>();
  for (const r of runs) if (r.run.gen3RoofRows) roofedNorth.set(r.tx, r.run.north);
  const groundShape = (): Shape => ({ cls: "ground", h: 0, art: "flat", flat: true, authored: true });
  for (const r of runs) {
    const run = r.run;
    const regionDrawn = drawnOf(r);
    let h = run.unit * 8;
    // THE OCTAGON UNDER THE BOX
    if (run.gen3RoofRows && run.gen3RoofRows > 1) {
      let n = run.north;
      let moved = 0;
      while (moved < run.gen3RoofRows - 2 && n + 1 < run.front) {
        const st = ctx.statsOf(ctx.metatileAt(fl2(r.tx), fl2(n)));
        if (st && st.solid < 0.55 && !st.leafy) {
          n += 2;
          moved += 2;
        } else break;
      }
      if (moved > 0) {
        run.octTrim = true;
        for (let ty = run.north; ty < n; ty++) {
          const dk = keyOf(r.tx, ty);
          S.runs.delete(dk);
          const old = S.shapeAt.get(dk);
          S.shapeAt.set(dk, { ...groundShape(), h: old && old.flat ? old.h : 0 });
        }
        run.north = n;
        run.extent -= moved;
        run.gen3RoofRows = Math.max(1, run.gen3RoofRows - moved);
        if (run.unit > run.extent) run.unit = run.extent;
        h = run.unit * 8;
      }
    }
    // A CLIFF FACE IS THE DROP ITSELF (from the ROM's elevation)
    let face: { top: number; dir: "north" | "south" } | undefined;
    let built3 = false;
    for (let ty = run.north; ty <= run.front; ty++) if (isB(r.tx, ty)) built3 = true;
    const minExt = run.gen3RoofRows ? 4 : 2;
    if (ctx.usesElevation && !run.door && !built3 && run.extent >= minExt) {
      const cx = fl2(r.tx);
      const landPast = (cy0: number, step: number): [number, number] | null => {
        for (let i = 1; i <= 4; i++) {
          const ncy = cy0 + step * i;
          if (ncy < 0) return null;
          if (!ctx.blockedAt(cx, ncy)) return [ctx.groundHeight(cx, ncy), i];
        }
        return null;
      };
      let nl = landPast(fl2(run.north), -1);
      let sl = landPast(fl2(run.front), 1);
      if (run.extent < 4 && ((nl ? nl[1] : 9) > 1 || (sl ? sl[1] : 9) > 1)) {
        nl = null;
        sl = null;
      }
      if (nl && sl) {
        if (sl[0] - nl[0] >= COURSE) face = { top: sl[0], dir: "north" };
        else if (nl[0] - sl[0] >= COURSE) face = { top: nl[0], dir: "south" };
      }
    }
    let adopted = false;
    let flatDoor = false;
    if (run.door) {
      h = modeH;
      adopted = !modeRepeat;
      flatDoor = modeRepeat;
    } else if (run.fromRepeat && modeH > h) {
      h = modeH;
      adopted = true;
    }
    const fabric = run.gen3RoofRows !== undefined || (regionCompact && run.extent >= 4);
    const drawnCap = fabric ? Infinity : run.extent * 8;
    if (regionCompact && regionRoofRows === 0 && regionMaxH > h) h = Math.min(regionMaxH, drawnCap);
    // A SPRAWL WITH NO ROOF ANYWHERE IN IT IS LANDSCAPE
    if (regionRoofRows === 0 && !run.gen3RoofRows && runs.length > 16) {
      let cap = GEN3_MAX_LAND;
      if (regionDrawn !== undefined && regionDrawn < 0.35) cap = 8;
      h = Math.min(cap, Math.max(regionMaxH, COURSE));
    }
    if (regionRoofRows > 0) {
      if (run.gen3RoofRows) run.gen3RoofRows = regionRoofRows;
      else if (
        fabric && regionCompact && run.extent >= 4 &&
        [r.tx - 1, r.tx + 1, r.tx - 2, r.tx + 2].some((x) => roofedNorth.get(x) === run.north)
      ) {
        run.gen3RoofRows = regionRoofRows;
      }
      if (regionBaseMax !== undefined && regionBaseMin !== undefined && regionBaseMax - regionBaseMin <= COURSE && run.gen3RoofRows) run.base = regionBaseMax;
      if (regionRoofH > h) h = Math.min(regionRoofH, drawnCap);
      // A ROOF SEEN FROM ABOVE IS DEPTH, NOT HEIGHT
      let wallExtent = regionExtent;
      let wallPlan = regionPlanRows;
      const bid = run.gen3Bld;
      if (bid !== undefined && (bldExtent.get(bid) ?? 0) > 0) {
        wallExtent = bldExtent.get(bid)!;
        wallPlan = bldPlan.get(bid) ?? 0;
      }
      let wall = (wallExtent - wallPlan) * 8;
      if (wall < 8) wall = 8;
      const vault = wallPlan * 2 >= wallExtent && wallPlan >= 3;
      const riseRows = vault ? Math.min(wallPlan, 4) : Math.min(wallPlan, GEN3_MAX_RISE);
      if (vault) run.shedRoof = GEN3_MAX_RISE;
      const proposed = wall + riseRows * 8;
      if (proposed < h) h = proposed;
      if (h > drawnCap) h = drawnCap;
    }
    // ONLY A BUILDING MAY BE AS TALL AS THE BUILDING
    if (!run.gen3RoofRows && adopted) {
      h = run.unit * 8;
      adopted = false;
    }
    let warpBuilt = false;
    for (let ty = run.north; ty <= run.front; ty++) if (isB(r.tx, ty)) warpBuilt = true;
    let roofRows = 0;
    if (run.gen3RoofRows) {
      roofRows = Math.max(0, Math.min(run.gen3RoofRows, Math.floor(h / 8) - 1));
      const riseCap = run.shedRoof ? Math.min(run.shedRoof, 4) : GEN3_MAX_RISE;
      if (roofRows > riseCap) roofRows = riseCap;
      if (regionFlatRoof) roofRows = 0;
      if (roofRows > 0 && S.rawTile(r.tx, run.north) === S.rawTile(r.tx, run.north + 1)) roofRows = 0;
    } else if (!regionCompact && !warpBuilt) {
      // GEN 3 TERRAIN DOES NOT PITCH, and landscape is low
      roofRows = 0;
      let landCap = GEN3_MAX_LAND;
      if (regionDrawn !== undefined && regionDrawn < 0.35) landCap = 8;
      if (h > landCap) h = landCap;
    } else if (S.outdoor && (!run.fromRepeat || adopted) && h >= 16 && !flatDoor) {
      roofRows = Math.min(2, Math.floor(h / 8) - 1);
      if (roofRows > 0 && S.rawTile(r.tx, run.north) === S.rawTile(r.tx, run.north + 1)) roofRows = 0;
      if (roofRows > 0) run.shedRoof = roofRows;
    }
    const fold = run.foldRows ?? 0;
    let drawn: number;
    if (run.gen3RoofRows) drawn = run.gen3RoofRows + fold;
    else if (fold > 0 || warpBuilt) drawn = Math.max(roofRows, run.extent - 2);
    else drawn = roofRows;
    run.roofRows = roofRows;
    // EVERY HOENN ROOF IS A SHED
    if (roofRows > 0) run.shedRoof = Math.min(roofRows, 4);
    const wallCourses = Math.floor(h / 8) - roofRows;
    const inferredRoof = warpBuilt && !run.gen3RoofRows;
    let artFloor = roofRows;
    const planFloor = run.gen3PlanRows ?? 0;
    if (planFloor > artFloor) artFloor = Math.min(planFloor, drawn);
    if (wallCourses > 0 && drawn > run.extent - wallCourses && !inferredRoof) drawn = Math.max(artFloor, run.extent - wallCourses);
    if (roofRows > 0 && (roofArtAbove > 0 || drawn > roofRows || fold > 0)) {
      run.roofArtTop = run.north - roofArtAbove;
      run.roofArtRows = drawn + roofArtAbove;
    }
    // ...AND THE ROOF'S DRAWING STARTS WHERE THE BUILDING'S DOES
    if (roofRows > 0 && roofFold.size) {
      let top = run.north;
      while (top - 1 >= 0 && run.north - (top - 1) <= GEN3_MAX_ROWS && roofFold.has(keyOf(r.tx, top - 1))) top--;
      if (top < run.north) {
        const bot = (run.roofArtTop ?? run.north) + (run.roofArtRows ?? roofRows) - 1;
        run.roofArtTop = top;
        run.roofArtRows = bot - top + 1;
      }
    }
    if (face) {
      roofRows = 0;
      run.roofRows = 0;
      run.gen3RoofRows = undefined;
      run.roofArtRows = undefined;
      run.roofArtTop = undefined;
      run.base = face.top;
      h = 0;
      run.face = { rows: run.extent, dir: face.dir };
    }
    run.rise = roofRows * 8;
    run.peak = h + run.base;
    run.h = h - run.rise + run.base;
    for (let ty = run.north; ty <= run.front; ty++) S.runs.set(keyOf(r.tx, ty), run);
  }
  // ONE ROOF SURFACE PER BUILDING (no FRLG profile states the pointed `tent_roof`)
  if (regionCompact) {
    let gext: number | undefined;
    for (const r of runs) if (r.run.roofRows > 0 && (gext === undefined || r.run.extent > gext)) gext = r.run.extent;
    if (gext !== undefined && gext > 1) for (const r of runs) if (r.run.roofRows > 0) r.run.gableExtent = gext;
  }
  S.stats.runs = (S.stats.runs ?? 0) + runs.length;
}

// ---------------------------------------------------------------------------
// caves, buildings, rock, ledges, falls
// ---------------------------------------------------------------------------

/** Structures.lua:5460 finishedFloor */
function finishedFloor(S: SG, cx: number, cy: number): number | undefined {
  const sh = S.shapeAt.get(keyOf(cx * 2, cy * 2));
  if (sh && sh.flat && sh.cls !== "void" && sh.cls !== "water") return sh.h;
  return S.ctx.groundHeight(cx, cy);
}

/** Structures.lua:17854 buildGen3RockPlateaus. FRLG: his `rock_plateau`
 * profile names Emerald's cave tilesets; here every underground map is one. */
function buildRockPlateaus(S: SG): void {
  const ctx = S.ctx;
  if (S.outdoor || !ctx.underground) return;
  const W = ctx.width;
  const H = ctx.height;
  const rock = new Set<number>();
  const base = new Map<number, number>();
  const edge = new Map<number, number>();
  for (let cy = 0; cy < H; cy++) {
    for (let cx = 0; cx < W; cx++) {
      const k0 = keyOf(cx * 2, cy * 2);
      const s0 = S.shapeAt.get(k0);
      const claimable = !!s0 && !S.skip.has(k0) && ((s0.cls === "wall" && s0.art === "upright" && !s0.authored) || s0.cls === "tabletop");
      if (!claimable) continue;
      const run = S.runs.get(k0);
      if (run && (run.gen3RoofRows || run.door)) continue;
      rock.add(ck(cx, cy));
    }
  }
  for (const k of rock) {
    const cx = k % 8192;
    const cy = Math.floor(k / 8192);
    let best: number | undefined;
    for (const [dx, dy] of DIRS4) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (rock.has(ck(nx, ny))) continue;
      const ns = S.shapeAt.get(keyOf(nx * 2, ny * 2));
      const deck = ctx.elevationAt(nx, ny) === 15;
      const nrun = S.runs.get(keyOf(nx * 2, ny * 2));
      if (ns && ns.flat && ns.cls !== "void" && !deck) {
        let nh = ns.h;
        if (nrun && nrun.h > nh) nh = nrun.h;
        if (best === undefined || nh > best) best = nh;
        if (S.isWalkableCell(nx, ny) && (!edge.has(k) || nh > edge.get(k)!)) edge.set(k, nh);
      }
    }
    if (best !== undefined) base.set(k, best);
    const walk = (dx: number, dy: number) => S.isWalkableCell(cx + dx, cy + dy);
    if ((walk(-1, 0) && walk(1, 0)) || (walk(0, -1) && walk(0, 1))) edge.delete(k);
  }
  {
    const q = [...base.keys()];
    for (let head = 0; head < q.length; head++) {
      const k = q[head]!;
      const cx = k % 8192;
      const cy = Math.floor(k / 8192);
      for (const [dx, dy] of DIRS4) {
        const nk = ck(cx + dx, cy + dy);
        if (rock.has(nk) && !base.has(nk)) {
          base.set(nk, base.get(k)!);
          q.push(nk);
        }
      }
    }
  }
  const isFloor = new Set(ctx.floorMetatiles);
  let n = 0;
  for (const k of rock) {
    const cx = k % 8192;
    const cy = Math.floor(k / 8192);
    const floorArt = isFloor.has(ctx.metatileAt(cx, cy));
    let h: number;
    if (floorArt) h = base.get(k) ?? 0;
    else if (edge.has(k)) h = edge.get(k)!;
    else h = (base.get(k) ?? 0) + ROCK_LIFT;
    for (let dy = 0; dy <= 1; dy++) {
      for (let dx = 0; dx <= 1; dx++) {
        const tk = keyOf(cx * 2 + dx, cy * 2 + dy);
        S.runs.delete(tk);
        S.shapeAt.set(tk, { cls: "ground", h, base: h, art: "flat", flat: true, authored: true, rock: true });
      }
    }
    n++;
  }
  S.stats.rockPlateau = n;
}

/** Structures.lua:5722 foundGen3Buildings */
function foundBuildings(S: SG): void {
  const ctx = S.ctx;
  const W = ctx.width;
  const H = ctx.height;
  const MAXH = S.outdoor ? GEN3_OUTDOOR_FACADE_CAP : GEN3_MAX_ROWS * 8;
  const bd = ctx.buildings();
  const doorsKnown = bd.list.length > 0;
  // ONE RUN, ONE BUILDING: cut a column at each further building's first row
  if (doorsKnown) {
    const seenRun = new Set<Run>();
    for (let cy = 0; cy < H; cy++) {
      for (let cx = 0; cx < W; cx++) {
        for (let dx = 0; dx <= 1; dx++) {
          const tx = cx * 2 + dx;
          const run = S.runs.get(keyOf(tx, cy * 2));
          if (!run || seenRun.has(run)) continue;
          seenRun.add(run);
          const starts: [number, number][] = [];
          let prev: number | undefined;
          for (let ty = run.north; ty <= run.front; ty++) {
            const id = bd.cell.get(ck(fl2(tx), fl2(ty)));
            if (id !== undefined && id !== prev) starts.push([ty, id]);
            if (id !== undefined) prev = id;
          }
          if (starts.length > 1) {
            let last = run.front;
            for (let i = starts.length - 1; i >= 1; i--) {
              const at = starts[i]![0];
              const copy: Run = { ...run, north: at, front: last, extent: last - at + 1, roofArtTop: undefined, roofArtRows: undefined, gableExtent: undefined, gen3ArtNorth: undefined };
              for (let ty = at; ty <= last; ty++) S.runs.set(keyOf(tx, ty), copy);
              last = at - 1;
            }
            run.front = last;
            run.extent = last - run.north + 1;
          }
        }
      }
    }
  }
  const looksBuilt = (run: Run) => (run.gen3RoofRows ?? 0) > 0 || run.rise > 0 || run.door;
  const isBuildingRun = (run: Run | undefined, cx: number, cy: number) => {
    if (!run) return false;
    if (ctx.isBuildingCell(cx, cy)) return true;
    if (!looksBuilt(run)) return false;
    if (!doorsKnown) return true;
    return ctx.isBuildingCell(cx, cy);
  };
  type E = { run: Run; cells: Set<number>; list: [number, number][]; bld?: number };
  const order: E[] = [];
  const byRun = new Map<Run, E>();
  const buildingCell = new Set<number>();
  for (let cy = 0; cy < H; cy++) {
    for (let cx = 0; cx < W; cx++) {
      for (let dy = 0; dy <= 1; dy++) {
        for (let dx = 0; dx <= 1; dx++) {
          const run = S.runs.get(keyOf(cx * 2 + dx, cy * 2 + dy));
          if (!isBuildingRun(run, cx, cy)) continue;
          let e = byRun.get(run!);
          if (!e) {
            e = { run: run!, cells: new Set(), list: [] };
            byRun.set(run!, e);
            order.push(e);
          }
          if (!e.cells.has(ck(cx, cy))) {
            e.cells.add(ck(cx, cy));
            e.list.push([cx, cy]);
          }
          buildingCell.add(ck(cx, cy));
        }
      }
    }
  }
  const isWaterCell = (cx: number, cy: number) => S.shapeAt.get(keyOf(cx * 2, cy * 2))?.cls === "water";
  // PASS 1: the STREET
  const street = new Map<E, number>();
  const noLand: E[] = [];
  for (const e of order) {
    let zBase: number | undefined;
    for (const c of e.list) {
      for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
        const nx = c[0] + dx;
        const ny = c[1] + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H || e.cells.has(ck(nx, ny))) continue;
        if (isWaterCell(nx, ny)) continue;
        if (buildingCell.has(ck(nx, ny))) continue;
        if (S.isWalkableCell(nx, ny)) {
          const z = finishedFloor(S, nx, ny);
          if (z !== undefined && (zBase === undefined || z < zBase)) zBase = z;
        }
      }
    }
    if (zBase !== undefined) street.set(e, zBase);
    else noLand.push(e);
  }
  // PASS 2: A HOUSE'S INNER COLUMNS SHARE ITS STREET
  const runAtCell = new Map<number, E[]>();
  for (const e of order) {
    for (const c of e.list) {
      let t = runAtCell.get(ck(c[0], c[1]));
      if (!t) runAtCell.set(ck(c[0], c[1]), (t = []));
      t.push(e);
    }
  }
  for (let it = 0; it < 8; it++) {
    let settled = 0;
    for (const e of noLand) {
      if (street.has(e)) continue;
      let best: number | undefined;
      for (const c of e.list) {
        for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
          for (const o of runAtCell.get(ck(c[0] + dx, c[1] + dy)) ?? []) {
            const z = o !== e ? street.get(o) : undefined;
            if (z !== undefined && (best === undefined || z < best)) best = z;
          }
        }
      }
      if (best !== undefined) {
        street.set(e, best);
        settled++;
      }
    }
    if (!settled) break;
  }
  // PASS 2b: ONE BUILDING, ONE ROOFLINE, ONE FLOOR; its doorstep
  const bldFacade = new Map<number, number>();
  const bldBase = new Map<number, number>();
  const bldOverhead = new Map<number, number>();
  const bldRows = new Map<number, number>();
  const bldRoofRows = new Map<number, number>();
  const bldDoor = new Map<number, number>();
  if (doorsKnown) {
    bd.list.forEach((bl: Building, i: number) => {
      const id = i + 1;
      // the doorstep: the walkable cell in front of the door (FRLG doors are
      // blocked cells, so the step is the first walkable one south)
      for (const [dx, dy] of [[0, 1], [0, 2], [-1, 1], [1, 1], [-1, 0], [1, 0]] as const) {
        const nx = bl.door[0] + dx;
        const ny = bl.door[1] + dy;
        if (nx >= 0 && ny >= 0 && nx < W && ny < H && S.isWalkableCell(nx, ny)) {
          const z = finishedFloor(S, nx, ny);
          if (z !== undefined) {
            bldDoor.set(id, z);
            break;
          }
        }
      }
      bldOverhead.set(id, bl.overheadRows);
      let y0b = Infinity;
      let y1b = -Infinity;
      for (const c of bl.cells) {
        y0b = Math.min(y0b, c[1]);
        y1b = Math.max(y1b, c[1]);
      }
      bldRows.set(id, y1b - y0b + 1);
      const cols = new Map<number, number[]>();
      for (const c of bl.cells) {
        let t = cols.get(c[0]);
        if (!t) cols.set(c[0], (t = []));
        t.push(c[1]);
      }
      let deepest = 0;
      for (const [cx, ys] of cols) {
        ys.sort((a, b) => a - b);
        let n = 0;
        for (const cy of ys) {
          let top: boolean | null = false;
          if (roofPlanAt(S, S.gen3Roof, cx, cy)) top = true;
          if (!top) {
            const r = ctx.metaRole(ctx.metatileAt(cx, cy));
            if (r && r.cap >= 12 && r.face <= 2) top = true;
          }
          if (!top) {
            if (roofUnseen(S, cx, cy)) top = null;
            else break;
          }
          if (top) n++;
        }
        deepest = Math.max(deepest, n);
      }
      bldRoofRows.set(id, deepest);
    });
    for (const e of order) {
      for (const c of e.list) {
        const id = bd.cell.get(ck(c[0], c[1]));
        if (id !== undefined) {
          e.bld = id;
          break;
        }
      }
      if (e.bld === undefined) continue;
      const m = e.run.h - e.run.base + e.run.rise;
      if (!bldFacade.has(e.bld) || m > bldFacade.get(e.bld)!) bldFacade.set(e.bld, m);
      const ov = bldOverhead.get(e.bld) ?? 0;
      if (ov > 0) {
        const want = m + ov * COURSE;
        if (want > bldFacade.get(e.bld)!) bldFacade.set(e.bld, want);
      }
      const z = street.get(e);
      if (z !== undefined && (!bldBase.has(e.bld) || z < bldBase.get(e.bld)!)) bldBase.set(e.bld, z);
    }
  }
  for (const e of order) {
    const run = e.run;
    let zBase = street.get(e) ?? 0;
    if (e.bld !== undefined && bldBase.has(e.bld)) zBase = bldBase.get(e.bld)!;
    if (e.bld !== undefined && bldDoor.has(e.bld) && zBase < bldDoor.get(e.bld)!) zBase = bldDoor.get(e.bld)!;
    if (zBase < 0) zBase = 0;
    let measured = run.h - run.base + run.rise;
    if (e.bld !== undefined && bldFacade.has(e.bld)) measured = bldFacade.get(e.bld)!;
    let capH = MAXH;
    const ov = e.bld !== undefined ? bldOverhead.get(e.bld) ?? 0 : 0;
    if (e.bld !== undefined && ov > 0 && bldRows.has(e.bld)) {
      capH += ov * COURSE;
      const own = bldRows.get(e.bld)! * COURSE;
      if (own < capH) capH = own;
      if (capH < MAXH) capH = MAXH;
    }
    if (S.outdoor && e.bld !== undefined && bldRows.has(e.bld)) {
      const rows = bldRows.get(e.bld)!;
      const wall = Math.max(1, rows - (bldRoofRows.get(e.bld) ?? 0));
      const own = wall * COURSE + COURSE;
      if (own > capH) capH = own;
      if (capH > rows * COURSE) capH = rows * COURSE;
    }
    if (measured > capH) measured = capH;
    if (measured < 0) measured = 0;
    if (measured === 0) {
      let ownH = 0;
      for (const c of e.list) {
        for (let dy = 0; dy <= 1; dy++) {
          for (let dx = 0; dx <= 1; dx++) {
            const sh2 = S.shapeAt.get(keyOf(c[0] * 2 + dx, c[1] * 2 + dy));
            const hh = sh2 && !sh2.flat ? sh2.h : 0;
            if (hh > ownH) ownH = hh;
          }
        }
      }
      if (ownH > zBase) measured = Math.min(ownH - zBase, capH);
    }
    if (e.bld !== undefined && ov > 0) run.gen3ArtNorth = Math.max(0, run.north - ov * 2);
    run.base = zBase;
    run.peak = measured + zBase;
    run.h = measured - run.rise + zBase;
    // ...AND THE ROOF'S DRAWING STOPS WHERE THE WALL'S BEGINS
    if (S.outdoor && !run.gen3RoofRows && run.roofArtTop !== undefined && run.roofArtRows !== undefined && run.roofRows > 0) {
      const wallRows = Math.floor((run.h - zBase) / 8);
      if (wallRows > 0) {
        let keep = run.front - wallRows - run.roofArtTop + 1;
        if (keep < run.roofRows) keep = run.roofRows;
        if (keep < run.roofArtRows) run.roofArtRows = keep;
      }
    }
  }
  S.stats.buildings = bd.list.length;
  S.stats.buildingRuns = order.length;
}

/** Gen3.lua:6923 courseAt / :7005 faceKindAt (without the paved-ground set, which needs the census of walkable brows -- applied below) */
function courseAt(S: SG, cx: number, cy: number, paved: Set<number>): number {
  const m = S.ctx.metatileAt(cx, cy);
  const r = S.ctx.metaRole(m);
  if (!r) return 0;
  if (r.ledge) return 1;
  if (paved.has(m)) return 0;
  if (r.art === "face") return 1;
  if (r.face >= 12) return 1;
  if (r.art === "brow") return 1;
  return 0;
}

/** Gen3.lua:6861 groundMetaFor: a brow or face metatile walkable in most of its cells is paving. */
function pavedMetas(S: SG): Set<number> {
  const ctx = S.ctx;
  const total = new Map<number, number>();
  const walk = new Map<number, number>();
  for (let cy = 0; cy < ctx.height; cy++) {
    for (let cx = 0; cx < ctx.width; cx++) {
      const m = ctx.metatileAt(cx, cy);
      const r = ctx.metaRole(m);
      if (r && (r.art === "brow" || r.face >= 12)) {
        total.set(m, (total.get(m) ?? 0) + 1);
        if (S.isWalkableCell(cx, cy)) walk.set(m, (walk.get(m) ?? 0) + 1);
      }
    }
  }
  const set = new Set<number>();
  for (const [m, n] of total) if ((walk.get(m) ?? 0) * 2 > n) set.add(m);
  return set;
}

/** Structures.lua:6570 capGen3Rock: rock is a short drop, not a volume. */
function capRock(S: SG): void {
  const ctx = S.ctx;
  if (!S.outdoor) return;
  const W = ctx.width;
  const H = ctx.height;
  const paved = pavedMetas(S);
  const doorsKnown = ctx.buildings().list.length > 0;
  const rockIsBuilding = (run: Run | undefined, cx: number, cy: number) => {
    if (!run) return false;
    if (ctx.isBuildingCell(cx, cy)) return true;
    const looks = (run.gen3RoofRows ?? 0) > 0 || run.rise > 0 || run.door;
    if (!looks) return false;
    return !doorsKnown;
  };
  const rockWall = new Set<number>();
  (S as unknown as { _rockWall: Set<number> })._rockWall = rockWall;
  let n = 0;
  for (let cy = 0; cy < H; cy++) {
    for (let cx = 0; cx < W; cx++) {
      const k = keyOf(cx * 2, cy * 2);
      const sh = S.shapeAt.get(k);
      const run = S.runs.get(k);
      const blocked = !S.isWalkableCell(cx, cy);
      const c = sh?.cls;
      const terrainRock = !!sh && !S.skip.has(k) && blocked && !rockIsBuilding(run, cx, cy) && (c === "wall" || c === "cliff" || c === "ground");
      if (!terrainRock) continue;
      const zs: number[] = [];
      let viaWall = false;
      for (const [dx, dy] of DIRS4) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H || !S.isWalkableCell(nx, ny)) continue;
        const nc = S.shapeAt.get(keyOf(nx * 2, ny * 2))?.cls;
        if (nc !== "fence" && nc !== "post" && nc !== "sign" && nc !== "signpost") {
          const z = finishedFloor(S, nx, ny);
          if (z !== undefined) zs.push(z);
        }
      }
      if (zs.length === 0) {
        const WALL_DEEP = 4;
        const floorOut = (dx: number, dy: number) => {
          for (let step = 1; step <= WALL_DEEP; step++) {
            const nx = cx + dx * step;
            const ny = cy + dy * step;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) return undefined;
            if (S.isWalkableCell(nx, ny)) return finishedFloor(S, nx, ny);
          }
          return undefined;
        };
        const zN = floorOut(0, -1);
        const zS = floorOut(0, 1);
        const zW = floorOut(-1, 0);
        const zE = floorOut(1, 0);
        if ((zN !== undefined && zS !== undefined) || (zW !== undefined && zE !== undefined)) {
          for (const z of [zN, zS, zW, zE]) if (z !== undefined) zs.push(z);
          viaWall = true;
          rockWall.add(ck(cx, cy));
        }
      }
      if (zs.length === 0) continue;
      const lo = Math.min(...zs);
      const hi = Math.max(...zs);
      const dz = hi - lo;
      let h = Math.min(TERRACE_MAX * COURSE, Math.max(COURSE, dz));
      if (dz === 0 && !viaWall) {
        h = courseAt(S, cx, cy, paved) > 0 ? COURSE : 0;
        const r = ctx.metaRole(ctx.metatileAt(cx, cy));
        const isFace = !paved.has(ctx.metatileAt(cx, cy)) && !!r && r.face >= 12;
        const isBrow = !!r && r.art === "brow" && r.cap > 0;
        if (h > 0 && isFace && !isBrow) {
          // A FRONT FACE IS NOT A BANK: flush with the ground it fronts
          let fronts = true;
          let any = false;
          for (const [dx, dy] of DIRS4) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H || !S.isWalkableCell(nx, ny)) continue;
            any = true;
            const ox = cx - dx;
            const oy = cy - dy;
            const ow = ox >= 0 && oy >= 0 && ox < W && oy < H ? S.isWalkableCell(ox, oy) : undefined;
            if (ow !== false) fronts = false;
          }
          if (any && fronts) h = 0;
        }
      }
      const top = lo + h;
      const was = run ? run.h : sh!.h;
      if (was !== top) {
        for (let dy = 0; dy <= 1; dy++) {
          for (let dx = 0; dx <= 1; dx++) {
            const kk = keyOf(cx * 2 + dx, cy * 2 + dy);
            const old = S.shapeAt.get(kk);
            if (old) {
              S.shapeAt.set(kk, { ...old, h: top });
              S.runs.delete(kk);
            }
          }
        }
        n++;
      }
    }
  }
  S.stats.rockCut = n;
}

/** Structures.lua:7019 climbGen3Masses: the inside of a mountain climbs a course a step. */
function climbMasses(S: SG): void {
  const ctx = S.ctx;
  if (!S.outdoor) return;
  const W = ctx.width;
  const H = ctx.height;
  const paved = pavedMetas(S);
  const mass = new Set<number>();
  for (let cy = 0; cy < H; cy++) {
    for (let cx = 0; cx < W; cx++) {
      const k = keyOf(cx * 2, cy * 2);
      const sh = S.shapeAt.get(k);
      if (S.isWalkableCell(cx, cy) || !sh || S.skip.has(k)) continue;
      if ((sh.cls === "wall" || sh.cls === "cliff" || sh.cls === "ground") && !ctx.isBuildingCell(cx, cy)) mass.add(ck(cx, cy));
    }
  }
  const massDraw = new Map<number, number>();
  {
    const comp = new Set<number>();
    for (const k of mass) {
      if (comp.has(k)) continue;
      const list = [k];
      comp.add(k);
      let ndraw = 0;
      for (let head = 0; head < list.length; head++) {
        const c = list[head]!;
        const cy = Math.floor(c / 8192);
        const cx = c - cy * 8192;
        if (courseAt(S, cx, cy, paved) > 0) ndraw++;
        for (const [dx, dy] of DIRS4) {
          const nk = ck(cx + dx, cy + dy);
          if (mass.has(nk) && !comp.has(nk)) {
            comp.add(nk);
            list.push(nk);
          }
        }
      }
      for (const c of list) massDraw.set(c, ndraw);
    }
  }
  const warps = new Set<number>();
  for (const w of ctx.map.warps) {
    warps.add(ck(w.x, w.y));
    for (let up = 1; up <= 2; up++) {
      const ny = w.y - up;
      if (ny < 0 || !S.isWalkableCell(w.x, ny)) break;
      const r = ctx.metaRole(ctx.metatileAt(w.x, ny));
      if ((r ? r.cap : 16) > 0) break;
      warps.add(ck(w.x, ny));
    }
  }
  const zAt = (cx: number, cy: number) => S.shapeAt.get(keyOf(cx * 2, cy * 2))?.h ?? 0;
  const want = new Map<number, number>();
  const q: number[] = [];
  for (const k of mass) {
    const cy = Math.floor(k / 8192);
    const cx = k - cy * 8192;
    let edge = false;
    for (const [dx, dy] of DIRS4) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx >= 0 && ny >= 0 && nx < W && ny < H && !mass.has(ck(nx, ny)) && !warps.has(ck(nx, ny))) edge = true;
    }
    if (edge) {
      want.set(k, zAt(cx, cy));
      q.push(k);
    }
  }
  const CAP = TERRACE_MAX * COURSE;
  const rockWall = (S as unknown as { _rockWall?: Set<number> })._rockWall ?? new Set<number>();
  const dist = new Map<number, number>();
  for (const k of q) dist.set(k, 0);
  for (let qh = 0; qh < q.length; qh++) {
    const k = q[qh]!;
    const cy = Math.floor(k / 8192);
    const cx = k - cy * 8192;
    for (const [dx, dy] of DIRS4) {
      const nx = cx + dx;
      const ny = cy + dy;
      const nk = ck(nx, ny);
      if (!mass.has(nk) || dist.has(nk) || rockWall.has(nk)) continue;
      dist.set(nk, dist.get(k)! + 1);
      let best: number | undefined;
      for (const [ex, ey] of DIRS4) {
        const pk = ck(nx + ex, ny + ey);
        if (dist.get(pk) === dist.get(nk)! - 1 && want.has(pk) && (best === undefined || want.get(pk)! > best)) best = want.get(pk)!;
      }
      const budget = massDraw.get(nk) ?? 0;
      const rise = dist.get(nk)! <= budget ? COURSE : 0;
      want.set(nk, Math.min(CAP, (best ?? 0) + rise));
      q.push(nk);
    }
  }
  for (const k of mass) {
    if (rockWall.has(k) && !want.has(k)) {
      const cy = Math.floor(k / 8192);
      const cx = k - cy * 8192;
      let lo: number | undefined;
      for (const [dx, dy] of DIRS4) {
        const nz = want.get(ck(cx + dx, cy + dy));
        if (nz !== undefined && (lo === undefined || nz < lo)) lo = nz;
      }
      if (lo !== undefined) want.set(k, lo);
    }
  }
  for (let it = 0; it < 4; it++) {
    let moved = false;
    for (const k of mass) {
      const cy = Math.floor(k / 8192);
      const cx = k - cy * 8192;
      const z = want.get(k) ?? zAt(cx, cy);
      let lo: number | undefined;
      for (const [dx, dy] of DIRS4) {
        const nk = ck(cx + dx, cy + dy);
        if (mass.has(nk)) {
          const nz = want.get(nk) ?? zAt(cx + dx, cy + dy);
          if (lo === undefined || nz < lo) lo = nz;
        }
      }
      if (lo !== undefined && lo > z) {
        want.set(k, lo);
        moved = true;
      }
    }
    if (!moved) break;
  }
  for (const k of mass) {
    if (!want.has(k)) continue;
    const cy = Math.floor(k / 8192);
    const cx = k - cy * 8192;
    let cap: number | undefined;
    for (const [dx, dy] of DIRS4) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H || mass.has(ck(nx, ny)) || warps.has(ck(nx, ny)) || !S.isWalkableCell(nx, ny)) continue;
      const fz = finishedFloor(S, nx, ny);
      let walled = true;
      for (const [ex, ey] of DIRS4) {
        const xx = nx + ex;
        const yy = ny + ey;
        if (xx >= 0 && yy >= 0 && xx < W && yy < H && S.isWalkableCell(xx, yy)) walled = false;
      }
      const allow = walled ? fz : fz !== undefined ? fz + COURSE : undefined;
      if (allow !== undefined && (cap === undefined || allow < cap)) cap = allow;
    }
    if (cap !== undefined && want.get(k)! > cap) {
      const was = zAt(cx, cy);
      want.set(k, was > cap ? was : cap);
    }
  }
  let raised = 0;
  for (const [k, z] of want) {
    const cy = Math.floor(k / 8192);
    const cx = k - cy * 8192;
    if (z <= zAt(cx, cy)) continue;
    for (let dy = 0; dy <= 1; dy++) {
      for (let dx = 0; dx <= 1; dx++) {
        const kk = keyOf(cx * 2 + dx, cy * 2 + dy);
        const old = S.shapeAt.get(kk);
        if (old) {
          S.shapeAt.set(kk, { ...old, h: z });
          S.runs.delete(kk);
        }
      }
    }
    raised++;
  }
  S.stats.massClimb = raised;
}

/** Structures.lua:7502 standGen3Ledges: a ledge is the rim of the terrace it edges. */
function standLedges(S: SG): void {
  const ctx = S.ctx;
  if (!S.outdoor) return;
  const W = ctx.width;
  const H = ctx.height;
  const lipH = CLASS_H.ledge!;
  const zAt = (cx: number, cy: number) => (cx < 0 || cy < 0 || cx >= W || cy >= H ? undefined : S.shapeAt.get(keyOf(cx * 2, cy * 2))?.h);
  const setZ = (cx: number, cy: number, z: number, lip: boolean) => {
    for (let dy = 0; dy <= 1; dy++) {
      for (let dx = 0; dx <= 1; dx++) {
        const kk = keyOf(cx * 2 + dx, cy * 2 + dy);
        const old = S.shapeAt.get(kk);
        if (old) {
          S.shapeAt.set(kk, { ...old, h: lip ? z + lipH : z });
          S.runs.delete(kk);
        }
      }
    }
  };
  const bankable = (sx: number, sy: number) => {
    if (sx < 0 || sy < 0 || sx >= W || sy >= H || !S.isWalkableCell(sx, sy)) return false;
    const rr = ctx.roleAt(sx, sy);
    return rr !== "ledge" && rr !== "stair" && rr !== "water";
  };
  const BANK_MAX = 8;
  const bankedAt: [number, number, number][] = [];
  let lipped = 0;
  let banked = 0;
  const bankRun = (sx: number, sy: number, dx: number, dy: number, top: number) => {
    let n = 0;
    for (let step = 0; step < BANK_MAX; step++) {
      const bx = sx - dx * step;
      const by = sy - dy * step;
      if (!bankable(bx, by)) break;
      const bz = zAt(bx, by);
      if (bz === undefined || bz > top) break;
      if (bz < top) {
        setZ(bx, by, top, false);
        banked++;
        n++;
        bankedAt.push([bx, by, top]);
      }
    }
    return n;
  };
  for (let round = 0; round < 6; round++) {
    let moved = 0;
    for (let cy = 0; cy < H; cy++) {
      for (let cx = 0; cx < W; cx++) {
        const hop = ledgeHop(ctx.attributes(ctx.metatileAt(cx, cy)));
        if (!hop) continue;
        const [dx, dy] = hop;
        const reach = (ddx: number, ddy: number): [number, number, number] | null => {
          for (let step = 1; step <= 3; step++) {
            const sx = cx + ddx * step;
            const sy = cy + ddy * step;
            if (sx < 0 || sy < 0 || sx >= W || sy >= H) return null;
            if (S.isWalkableCell(sx, sy)) {
              const z = zAt(sx, sy);
              return z === undefined ? null : [z, sx, sy];
            }
            const rr = ctx.roleAt(sx, sy);
            if (rr !== "ledge" && rr !== "cliff" && rr !== "shelf") return null;
          }
          return null;
        };
        const high = reach(-dx, -dy);
        const low = reach(dx, dy);
        const lz = zAt(cx, cy);
        if (lz !== undefined && low) {
          const want = low[0] + lipH;
          const top = high && high[0] > want ? high[0] : want;
          const cur = S.shapeAt.get(keyOf(cx * 2, cy * 2));
          if (lz !== top - lipH || !cur || cur.h !== top) {
            setZ(cx, cy, top - lipH, true);
            lipped++;
            moved++;
          }
          if (high) moved += bankRun(high[1], high[2], -dx, -dy, top);
        } else if (lz !== undefined && high) {
          const top = Math.max(lz, high[0]);
          const cur = S.shapeAt.get(keyOf(cx * 2, cy * 2));
          if (lz < top || !cur || cur.h !== top + lipH) {
            setZ(cx, cy, top, true);
            lipped++;
            moved++;
          }
          moved += bankRun(high[1], high[2], -dx, -dy, top);
        }
      }
    }
    if (!moved) break;
  }
  // ...and what stands on a banked terrace comes up with it
  for (const [bx, by, top] of bankedAt) {
    for (const [dx, dy] of DIRS4) {
      const nx = bx + dx;
      const ny = by + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const rr = ctx.roleAt(nx, ny);
      if (rr === "floor" || rr === "water" || rr === "stair" || rr === "ledge") continue;
      const nz = zAt(nx, ny);
      if (nz === undefined || nz >= top) continue;
      const lift = top - nz;
      for (let dy2 = 0; dy2 <= 1; dy2++) {
        for (let dx2 = 0; dx2 <= 1; dx2++) {
          const kk = keyOf(nx * 2 + dx2, ny * 2 + dy2);
          const old = S.shapeAt.get(kk);
          if (old && old.cls !== "void" && old.cls !== "water") {
            S.shapeAt.set(kk, { ...old, h: old.h + lift, authored: true, base: old.base !== undefined ? old.base + lift : undefined });
            S.runs.delete(kk);
          }
        }
      }
      // a hull standing there rides up too
      for (const st of S.roundStamps) {
        const scx = Math.floor((st.mx - st.r) / 16);
        const scy = Math.floor((st.mz - st.r) / 16);
        if (scx === nx && scy === ny && st.my < top) st.my = top;
      }
    }
  }
  S.stats.ledges = (S.stats.ledges ?? 0) + lipped;
  S.stats.banked = (S.stats.banked ?? 0) + banked;
}

/** Structures.lua:22734 buildFalls */
function buildFalls(S: SG): void {
  const cols = new Map<number, Set<number>>();
  for (const [k, s] of S.shapeAt) {
    if (s.cls !== "waterfall") continue;
    const tx = (k % 4096) - 64;
    const ty = Math.floor(k / 4096) - 64;
    let c = cols.get(tx);
    if (!c) cols.set(tx, (c = new Set()));
    c.add(ty);
  }
  if (cols.size === 0) return;
  const fallRun = (h: number, north: number, front: number): Run => ({
    north, front, extent: front - north + 1, unit: front - north + 1, h, peak: h, rise: 0, roofRows: 0,
    fromRepeat: false, door: false, gen3PlanRows: 0, gen3BldPlan: 0, base: 0,
  });
  const crest: [number, number, number][] = [];
  let height = 0;
  for (const [tx, ys] of cols) {
    const sorted = [...ys].sort((a, b) => a - b);
    let i = 0;
    while (i < sorted.length) {
      const north = sorted[i]!;
      let front = north;
      while (i + 1 < sorted.length && sorted[i + 1] === front + 1) front = sorted[++i]!;
      i++;
      const extent = front - north + 1;
      const step = Math.min(8, Math.floor(FALL_MAX / extent));
      for (let ty = north; ty <= front; ty++) S.runs.set(keyOf(tx, ty), fallRun((front - ty + 1) * step, ty, ty));
      const crestH = extent * step;
      height = Math.max(height, crestH);
      crest.push([tx, north - 1, crestH]);
    }
  }
  if (height <= 0) return;
  const isWater = (tx: number, ty: number) => S.shapeAt.get(keyOf(tx, ty))?.cls === "water";
  const seen = new Set<number>();
  const queue: [number, number, number][] = [];
  for (const c of crest) {
    const k = keyOf(c[0], c[1]);
    if (!seen.has(k) && isWater(c[0], c[1])) {
      seen.add(k);
      queue.push(c);
    }
  }
  const raised: [number, number, number][] = [];
  while (queue.length && raised.length < FALL_POOL_MAX) {
    const c = queue.pop()!;
    raised.push(c);
    S.runs.set(keyOf(c[0], c[1]), fallRun(c[2], c[1], c[1]));
    for (const [dx, dy] of DIRS4) {
      const nx = c[0] + dx;
      const ny = c[1] + dy;
      const nk = keyOf(nx, ny);
      if (nx >= S.x0 && nx <= S.x1 && ny >= S.y0 && ny <= S.y1 && !seen.has(nk) && isWater(nx, ny)) {
        seen.add(nk);
        queue.push([nx, ny, c[2]]);
      }
    }
  }
  let edge = raised;
  for (let r = 0; r < FALL_RIM; r++) {
    const next: [number, number, number][] = [];
    for (const c of edge) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const tx = c[0] + dx;
          const ty = c[1] + dy;
          const k = keyOf(tx, ty);
          const s = S.shapeAt.get(k);
          if (s && s.art === "upright" && s.cls !== "waterfall" && !seen.has(k)) {
            seen.add(k);
            const run = S.runs.get(k);
            if (!run || run.h < c[2]) S.runs.set(k, fallRun(c[2], ty, ty));
            next.push([tx, ty, c[2]]);
          }
        }
      }
    }
    edge = next;
  }
  for (const [k, s] of S.shapeAt) {
    if (s.cls === "cliff" && s.h < GORGE_WALL && !S.runs.has(k)) {
      const tx = (k % 4096) - 64;
      const ty = Math.floor(k / 4096) - 64;
      let holds = false;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (S.shapeAt.get(keyOf(tx + dx, ty + dy))?.cls === "terrace") holds = true;
      if (!holds && isWaterNear(S, tx, ty)) S.runs.set(k, fallRun(GORGE_WALL, ty, ty));
    }
  }
  S.stats.falls = raised.length;
}

// (ours) his gorge rule raises every short cliff on a map with a fall; on
// FRLG's outdoor maps that would stand the whole coastline up, so it is held
// to cliffs beside water, which is the gorge it was written for
function isWaterNear(S: SG, tx: number, ty: number): boolean {
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (S.shapeAt.get(keyOf(tx + dx, ty + dy))?.cls === "water") return true;
  return false;
}

/** Structures.lua:26466 buildGen3Grass: tall grass (a tuft plan) is a low mat. */
function buildGrassMats(S: SG): void {
  const ctx = S.ctx;
  const mat = new Map<number, number>();
  for (let ty = S.y0; ty <= S.y1; ty++) {
    for (let tx = S.x0; tx <= S.x1; tx++) {
      const k = keyOf(tx, ty);
      const s = S.shapeAt.get(k);
      if (!s || s.cls !== "grass" || S.skip.has(k)) continue;
      // grass_kind: only MB_TALL_GRASS is a "tuft"
      if (ctx.attributes(ctx.metatileAt(fl2(tx), fl2(ty))) !== 0x02) continue;
      mat.set(k, S.runs.get(k)?.h ?? s.h);
    }
  }
  const E = 0.05;
  for (const [k, gz] of mat) {
    const tx = (k % 4096) - 64;
    const ty = Math.floor(k / 4096) - 64;
    const tile = S.tileAt.get(k);
    if (tile === undefined) continue;
    const [ax, ay] = S.tileOrigin(tile);
    const uA = ax + E;
    const uB = ax + 8 - E;
    const vA = ay + E;
    const vB = ay + 8 - E;
    const wx = tx * 8;
    const wz = ty * 8;
    const x1 = wx + 8;
    const z1 = wz + 8;
    const top = gz + GRASS_MAT;
    S.grassQuads.push({ c: [[wx, top, wz], [x1, top, wz], [x1, top, z1], [wx, top, z1]], uv: [[uA, vA], [uB, vA], [uB, vB], [uA, vB]], shade: OBJ_SHADE.top, f: 3 });
    if (mat.get(keyOf(tx, ty + 1)) !== gz) {
      const v = ay + 7.5;
      S.grassQuads.push({ c: [[wx, gz, z1], [x1, gz, z1], [x1, top, z1], [wx, top, z1]], uv: [[uA, v], [uB, v], [uB, v], [uA, v]], shade: OBJ_SHADE.side, f: 5 });
    }
    if (mat.get(keyOf(tx, ty - 1)) !== gz) {
      const v = ay + 0.5;
      S.grassQuads.push({ c: [[x1, gz, wz], [wx, gz, wz], [wx, top, wz], [x1, top, wz]], uv: [[uB, v], [uA, v], [uA, v], [uB, v]], shade: OBJ_SHADE.side, f: 6 });
    }
    if (mat.get(keyOf(tx + 1, ty)) !== gz) {
      const u = ax + 7.5;
      S.grassQuads.push({ c: [[x1, gz, z1], [x1, gz, wz], [x1, top, wz], [x1, top, z1]], uv: [[u, vB], [u, vA], [u, vA], [u, vB]], shade: OBJ_SHADE.side, f: 1 });
    }
    if (mat.get(keyOf(tx - 1, ty)) !== gz) {
      const u = ax + 0.5;
      S.grassQuads.push({ c: [[wx, gz, wz], [wx, gz, z1], [wx, top, z1], [wx, top, wz]], uv: [[u, vA], [u, vB], [u, vB], [u, vA]], shade: OBJ_SHADE.side, f: 2 });
    }
  }
  S.stats.grassMats = mat.size;
}

/** Structures.lua:9217 standGen3Apron: the ring stands at the height of the edge it abuts. */
function standApron(S: SG, ringCarved: (tx: number, ty: number) => boolean, truncated: boolean): void {
  if (!S.outdoor) return;
  const { tw, th } = S;
  for (let ty = -RING; ty < th + RING; ty++) {
    for (let tx = -RING; tx < tw + RING; tx++) {
      if (tx >= 0 && ty >= 0 && tx < tw && ty < th) continue;
      const k = keyOf(tx, ty);
      let sh = S.shapeAt.get(k);
      const carved = !truncated || ringCarved(tx, ty);
      const ex = tx < 0 ? 0 : tx >= tw ? tw - 1 : tx;
      const ey = ty < 0 ? 0 : ty >= th ? th - 1 : ty;
      const es = S.shapeAt.get(keyOf(ex, ey));
      if (!sh && carved && es) {
        S.shapeAt.set(k, { cls: "ground", art: "flat", flat: true, h: es.h, base: 0, authored: true, apron: true });
        if (!S.tileAt.has(k)) S.tileAt.set(k, S.tileAt.get(keyOf(ex, ey))!);
        sh = S.shapeAt.get(k);
      }
      if (sh && sh.cls !== "void" && sh.cls !== "water" && es && sh.h !== es.h) {
        S.shapeAt.set(k, { ...sh, h: es.h, base: sh.base !== undefined ? es.h : undefined });
        S.runs.delete(k);
      }
    }
  }
}
