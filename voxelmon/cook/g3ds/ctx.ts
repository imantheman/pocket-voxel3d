// voxelmon/cook/g3ds/ctx.ts — one map's Gen 3 context: what each cell IS.
//
// MIT. Ported from UNDERdecoded/Gen2Recomped-DramaticShapes (MIT, Copyright
// (c) 2026 DramaticShape, modified by UNDERdecodedHD; THIRD_PARTY_NOTICES.md)
// at 726782f, lib/Gen3.lua `Gen3.forMap` and the module functions after it:
//
//   groundHeight       :1091 (elevation ranks :436, ramp chains :907)
//   the scenery carve  :1265 buildScenery (trees, boulders, signposts,
//                      rocks in the sea, railings, indoor furniture)
//   roofAt / classAt   :2715 / :2792
//   roleAt / fenceAt   :3470-3880 (the role vocabulary)
//   buildings          :4391 (the warp-named buildings and the doorless masses)
//   floorMetatiles     :3409
//
// What is translated for FRLG is noted where it happens; everything else is
// his rule as written (comments trimmed to the rule; his files carry the
// measurements behind each one).

import type { FrMap, FrPair } from "../gen3.ts";
import { behaviourOf, layerTypeOf } from "../gen3.ts";
import { analysePair, type PairArt, type Role, rolesFor, type ShapeSurface, shapeSurface, type SlotStats } from "./art.ts";
import {
  behaviourClass,
  ELEV_DEFAULT,
  ELEV_MULTI,
  ELEV_SURF,
  ELEV_TRANSITION,
  FRLG_NAMES,
  isDoorBehaviour,
  MB_MOUNTAIN_TOP,
  STANDING,
} from "./shapes.ts";

/** One elevation step, world px (Gen3.lua COURSE). */
export const COURSE = 16;
const NEIGHBOURS: [number, number][] = [[0, -1], [0, 1], [-1, 0], [1, 0]];

export interface Building {
  cells: [number, number][];
  door: [number, number];
  overheadRows: number;
  roofed: boolean;
}

export interface Ctx {
  map: FrMap;
  pair: FrPair;
  art: PairArt;
  surface: ShapeSurface;
  width: number;
  height: number;
  outdoor: boolean;
  underground: boolean;
  slotOf(mid: number): number;
  metatileAt(cx: number, cy: number): number;
  offMap(cx: number, cy: number): boolean;
  blockedAt(cx: number, cy: number): boolean;
  elevationAt(cx: number, cy: number): number | null;
  attributes(m: number): number;
  coverAt(m: number): boolean;
  statsOf(m: number): SlotStats | undefined;
  metaRole(m: number): Role | undefined;
  groundHeight(cx: number, cy: number): number;
  sceneryAt(cx: number, cy: number): string | undefined;
  scenerySpan(cx: number, cy: number): number | undefined;
  sceneryShared(cx: number, cy: number): boolean;
  waterRocks: [number, number, number][];
  roofAt(cx: number, cy: number): boolean;
  classAt(cx: number, cy: number): { cls: string; pinned: boolean } | null;
  roleAt(cx: number, cy: number): string;
  buildings(): { list: Building[]; cell: Map<number, number> };
  isBuildingCell(cx: number, cy: number): boolean;
  metatileCounts(): Map<number, number>;
  floorMetatiles: number[];
  usesElevation: boolean;
}

const ck = (cx: number, cy: number) => cy * 8192 + cx;

/** Every map that draws from `pair`, for the role census. */
export type PairMaps = (pairName: string) => FrMap[];

const roleCache = new WeakMap<FrPair, (Role | undefined)[]>();

export function makeCtx(root: string, map: FrMap, pair: FrPair, pairMaps: PairMaps): Ctx {
  const width = map.width;
  const height = map.height;
  const art = analysePair(pair);
  const slotOf = (mid: number) => pair.midToSlot.get(mid) ?? pair.midToSlot.get(0) ?? 0;
  const statsOf = (m: number) => art.stats[slotOf(m)];
  // MAP_TYPE: open sky (Gen3.lua:3231 reads data/gen3_maps.lua's `outdoor`)
  const outdoor = map.outdoor && map.mapType !== 5; // not under the sea
  const underground = map.mapType === 4;

  const offMap = (cx: number, cy: number) => cx < 0 || cy < 0 || cx >= width || cy >= height;
  // THE BORDER PATCH TILES; IT DOES NOT SMEAR (Gen3.lua:755)
  const metatileAt = (cx: number, cy: number): number => {
    if (!offMap(cx, cy)) return map.cells[cy * width + cx]!.mid;
    const bw = map.border.w;
    const bh = map.border.h;
    const bx = ((cx % bw) + bw) % bw;
    const by = ((cy % bh) + bh) % bh;
    return map.border.mids[by * bw + bx] ?? 0;
  };
  const blockedAt = (cx: number, cy: number) => (offMap(cx, cy) ? true : map.cells[cy * width + cx]!.coll !== 0);
  const elevationAt = (cx: number, cy: number) => (offMap(cx, cy) ? null : map.cells[cy * width + cx]!.elev);
  const attrMemo = new Map<number, number>();
  const attributes = (m: number) => {
    let b = attrMemo.get(m);
    if (b === undefined) attrMemo.set(m, (b = behaviourOf(root, map, m)));
    return b;
  };
  const layerMemo = new Map<number, number>();
  // Gen3.lua:831 coverAt: the top half is drawn above the player unless the
  // layer type is COVERED
  const coverAt = (m: number) => {
    let l = layerMemo.get(m);
    if (l === undefined) layerMemo.set(m, (l = layerTypeOf(root, map, m)));
    return l !== 1;
  };

  // ---- the role table, per pair (art.ts rolesFor; the census is the pair's maps)
  let roles = roleCache.get(pair);
  if (!roles) {
    const down = new Map<number, Map<number, number>>();
    const used = new Set<number>();
    const kinds = new Map<number, string>();
    for (const m2 of pairMaps(pair.name)) {
      for (let y = 0; y < m2.height; y++) {
        for (let x = 0; x < m2.width; x++) {
          const a = slotOf(m2.cells[y * m2.width + x]!.mid);
          used.add(a);
          if (!kinds.has(a)) {
            const b = behaviourOf(root, m2, m2.cells[y * m2.width + x]!.mid);
            const cls = behaviourClass(b);
            kinds.set(a, cls === "water" || cls === "waterfall" ? "water" : cls === "ledge" ? "ledge" : b === MB_MOUNTAIN_TOP ? "mountain" : "");
          }
          if (y + 1 < m2.height) {
            const d = slotOf(m2.cells[(y + 1) * m2.width + x]!.mid);
            let t = down.get(a);
            if (!t) down.set(a, (t = new Map()));
            t.set(d, (t.get(d) ?? 0) + 1);
          }
        }
      }
    }
    const downOf = (s: number): number | undefined => {
      const t = down.get(s);
      if (!t) return undefined;
      let best: number | undefined;
      let bn = 0;
      for (const [k, v] of [...t].sort((p, q) => p[0] - q[0])) {
        if (v > bn) {
          best = k;
          bn = v;
        }
      }
      return best;
    };
    roles = rolesFor(art, (s) => kinds.get(s) ?? "", downOf, (s) => used.has(s));
    roleCache.set(pair, roles);
  }
  const roleRows = roles;
  const metaRole = (m: number) => roleRows[slotOf(m)];

  // ---- the map's own floor (Gen3.lua:3409) and its shape surface
  const floorMetatiles: number[] = [];
  {
    const counts = new Map<number, number>();
    let total = 0;
    for (let cy = 0; cy < height; cy++) {
      for (let cx = 0; cx < width; cx++) {
        if (!blockedAt(cx, cy)) {
          const m = metatileAt(cx, cy);
          counts.set(m, (counts.get(m) ?? 0) + 1);
          total++;
        }
      }
    }
    const list = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    let acc = 0;
    for (let i = 0; i < list.length; i++) {
      const [m, n] = list[i]!;
      if (i < 12 && (n >= 3 || acc < total * 0.6)) {
        floorMetatiles.push(m);
        acc += n;
      }
    }
    floorMetatiles.sort((a, b) => a - b);
  }
  const surface = shapeSurface(art, floorMetatiles.map(slotOf));

  // ---- the height field (Gen3.lua:436 buildElevationRanks, :1091 groundHeight)
  let elevHeight: Map<number, number> | null = null;
  {
    const seen = new Set<number>();
    for (const c of map.cells) {
      const e = c.elev;
      if (e !== ELEV_TRANSITION && e !== ELEV_MULTI && e !== ELEV_SURF) seen.add(e);
    }
    const list = [...seen].sort((a, b) => a - b);
    let datum = list.indexOf(ELEV_DEFAULT) + 1;
    if (datum === 0) datum = 1;
    elevHeight = new Map();
    list.forEach((e, i) => elevHeight!.set(e, (i + 1 - datum) * COURSE));
    elevHeight.set(ELEV_SURF, -COURSE / 8);
    // Gen3.lua:3363 elevationIsReal: indoors the elevation grid is sprite
    // priority unless a level other than the reserved four covers a region
    if (!outdoor) {
      const ELEV_REGION_MIN = 8;
      let real = false;
      const seenR = new Set<number>();
      outer: for (let cy = 0; cy < height; cy++) {
        for (let cx = 0; cx < width; cx++) {
          const e = elevationAt(cx, cy)!;
          if (e === ELEV_TRANSITION || e === ELEV_SURF || e === ELEV_DEFAULT || e === ELEV_MULTI || seenR.has(ck(cx, cy))) continue;
          seenR.add(ck(cx, cy));
          const st: [number, number][] = [[cx, cy]];
          let sz = 0;
          while (st.length) {
            const c = st.pop()!;
            sz++;
            if (sz >= ELEV_REGION_MIN) {
              real = true;
              break outer;
            }
            for (const [dx, dy] of NEIGHBOURS) {
              const nx = c[0] + dx;
              const ny = c[1] + dy;
              if (!offMap(nx, ny) && !seenR.has(ck(nx, ny)) && elevationAt(nx, ny) === e) {
                seenR.add(ck(nx, ny));
                st.push([nx, ny]);
              }
            }
          }
        }
      }
      if (!real) elevHeight = null;
    }
  }
  const usesElevation = elevHeight !== null;

  // ramps (Gen3.lua:907 rampHeightAt): a chain of passable transition cells
  // between two real levels climbs one course per cell
  const treadMeta = (m: number): boolean => {
    const r = metaRole(m);
    if (!r || r.art !== "banded" || r.face > 1) return false;
    const st = statsOf(m);
    return st !== undefined && st.solid >= 0.75;
  };
  let rampCache: Map<number, number> | null = null;
  const passableRamp = (x: number, y: number) => !offMap(x, y) && elevationAt(x, y) === ELEV_TRANSITION && !blockedAt(x, y);
  const rampHeightAt = (cx: number, cy: number): number | undefined => {
    if (rampCache === null) {
      rampCache = new Map();
      if (elevHeight) {
        const eh = elevHeight;
        const seen = new Set<number>();
        for (let sy = 0; sy < height; sy++) {
          for (let sx = 0; sx < width; sx++) {
            if (seen.has(ck(sx, sy)) || !passableRamp(sx, sy)) continue;
            const chain: [number, number][] = [];
            const stack: [number, number][] = [[sx, sy]];
            seen.add(ck(sx, sy));
            while (stack.length) {
              const c = stack.pop()!;
              chain.push(c);
              for (const [dx, dy] of NEIGHBOURS) {
                const nx = c[0] + dx;
                const ny = c[1] + dy;
                if (!seen.has(ck(nx, ny)) && passableRamp(nx, ny)) {
                  seen.add(ck(nx, ny));
                  stack.push([nx, ny]);
                }
              }
            }
            let lo: number | undefined;
            let hi: number | undefined;
            for (const c of chain) {
              for (const [dx, dy] of NEIGHBOURS) {
                const ne = elevationAt(c[0] + dx, c[1] + dy);
                if (ne !== null && ne !== ELEV_TRANSITION && ne !== ELEV_MULTI && ne !== ELEV_SURF) {
                  const nh = eh.get(ne);
                  if (nh !== undefined) {
                    if (lo === undefined || nh < lo) lo = nh;
                    if (hi === undefined || nh > hi) hi = nh;
                  }
                }
              }
            }
            if (lo === undefined || hi === undefined || hi <= lo) continue;
            let treads = false;
            let flat = false;
            for (const c of chain) {
              const m2 = metatileAt(c[0], c[1]);
              if (treadMeta(m2)) {
                treads = true;
                break;
              }
              const r = metaRole(m2);
              if (!r || r.art === "surface") {
                flat = true;
                break;
              }
            }
            if (!treads && !flat) {
              // A LADDER IS A FACE, NOT A FLIGHT
              for (const c of chain) rampCache!.set(ck(c[0], c[1]), hi);
              continue;
            }
            const spread = (target: number): Map<number, number> => {
              const dist = new Map<number, number>();
              const queue: [number, number][] = [];
              for (const c of chain) {
                for (const [dx, dy] of NEIGHBOURS) {
                  const ne = elevationAt(c[0] + dx, c[1] + dy);
                  const nh = ne !== null ? eh.get(ne) : undefined;
                  if (nh === target && ne !== ELEV_TRANSITION && !dist.has(ck(c[0], c[1]))) {
                    dist.set(ck(c[0], c[1]), 0);
                    queue.push(c);
                  }
                }
              }
              for (let qi = 0; qi < queue.length; qi++) {
                const c = queue[qi]!;
                const d = dist.get(ck(c[0], c[1]))!;
                for (const [dx, dy] of NEIGHBOURS) {
                  const nx = c[0] + dx;
                  const ny = c[1] + dy;
                  if (!dist.has(ck(nx, ny)) && passableRamp(nx, ny) && seen.has(ck(nx, ny))) {
                    dist.set(ck(nx, ny), d + 1);
                    queue.push([nx, ny]);
                  }
                }
              }
              return dist;
            };
            const dLo = spread(lo);
            const dHi = spread(hi);
            for (const c of chain) {
              const a = dLo.get(ck(c[0], c[1]));
              const b = dHi.get(ck(c[0], c[1]));
              if (a !== undefined && b !== undefined) rampCache!.set(ck(c[0], c[1]), Math.min(hi, lo + (a + 1) * COURSE));
            }
          }
        }
      }
    }
    return rampCache.get(ck(cx, cy));
  };
  const groundCache = new Map<number, number>();
  const groundHeight = (cx: number, cy: number): number => {
    if (!elevHeight) return 0;
    const hit = groundCache.get(ck(cx, cy));
    if (hit !== undefined) return hit;
    const e = elevationAt(cx, cy);
    let h: number;
    if (e === null) h = 0;
    else if (e === ELEV_TRANSITION) {
      if (blockedAt(cx, cy)) h = 0;
      else {
        const r = rampHeightAt(cx, cy);
        if (r !== undefined) h = r;
        else {
          let best: number | undefined;
          for (const [dx, dy] of NEIGHBOURS) {
            const ne = elevationAt(cx + dx, cy + dy);
            if (ne !== null && ne !== ELEV_TRANSITION && ne !== ELEV_MULTI) {
              const nh = elevHeight.get(ne);
              if (nh !== undefined && (best === undefined || nh < best)) best = nh;
            }
          }
          h = best ?? 0;
        }
      }
    } else if (e === ELEV_MULTI) {
      // A BRIDGE DECK: one course over the highest real level beside it (FRLG
      // states no bridge behaviours, so the lift is always one course)
      let best = 0;
      for (const [dx, dy] of NEIGHBOURS) {
        const ne = elevationAt(cx + dx, cy + dy);
        if (ne !== null && ne !== ELEV_MULTI && ne !== ELEV_SURF) {
          const nh = elevHeight.get(ne);
          if (nh !== undefined && nh > best) best = nh;
        }
      }
      h = best + COURSE;
    } else h = elevHeight.get(e) ?? 0;
    groundCache.set(ck(cx, cy), h);
    return h;
  };

  // ---- the scenery carve (Gen3.lua:1265 buildScenery) ----
  const RING = 8;
  const sx0 = -RING;
  const sy0 = -RING;
  const sx1 = width + RING - 1;
  const sy1 = height + RING - 1;
  const stride = sx1 - sx0 + 1;
  const sidx = (cx: number, cy: number) => (cy - sy0) * stride + (cx - sx0);
  let scenery: Map<number, string> | null = null;
  const sceneryScale = new Map<number, number>();
  const sceneryShared = new Set<number>();
  const waterRocks: [number, number, number][] = [];
  let ctxRef: Ctx;

  const buildScenery = () => {
    scenery = new Map();
    const sc = scenery;
    const inRing = (cx: number, cy: number) => cx >= sx0 && cy >= sy0 && cx <= sx1 && cy <= sy1;
    const material = (m: number) => metaRole(m)?.material;
    const leafAt = (cx: number, cy: number) => {
      if (!inRing(cx, cy)) return false;
      if (!offMap(cx, cy) && !blockedAt(cx, cy)) return false;
      const m = metatileAt(cx, cy);
      const st = statsOf(m);
      // FRLG (ours): 0.4, not his 0.5 -- an FRLG tree's body half beside open
      // grass draws 0.48 of its cell (the garden trees by a museum, every forest's
      // edge column); the fringe his threshold keeps out is walkable and is
      // already refused above
      // ...and a cell his role table calls a tree (a green motif: a top
      // with no face ever drawn under it) is foliage even where the colour
      // test reads it short -- the sunlit crown row along the top of an FRLG
      // wood draws 0.33 of its leaves in pale greens the test passes over
      const ro = metaRole(m);
      const treeRole = !!ro && ro.motif && ro.material === "green";
      if (!(st && (st.leafy || treeRole) && st.solid > 0.4)) return false;
      const mt = material(m);
      if (mt !== undefined && mt !== "green") return false;
      return true;
    };
    const crownAt = (cx: number, cy: number) => {
      if (!inRing(cx, cy)) return false;
      const m = metatileAt(cx, cy);
      const st = statsOf(m);
      if (!(st && st.leafy)) return false;
      if (!(st.leafFrac2 > 0.5 && st.leafFrac2 >= st.leafFrac * 0.9)) return false;
      return material(m) === "green";
    };
    const crownTop = (cx: number, cy: number) => crownAt(cx, cy) && !(leafAt(cx, cy - 1) || crownAt(cx, cy - 1));
    const footAt = (cx: number, cy: number) => {
      if (!inRing(cx, cy)) return false;
      if (!offMap(cx, cy) && !blockedAt(cx, cy)) return false;
      const m = metatileAt(cx, cy);
      const st = statsOf(m);
      if (!st) return false;
      if (!(st.leafFrac > 0.25 && st.leafFrac2 <= st.leafFrac * 0.1)) return false;
      return material(m) === "green";
    };
    const claimed = new Set<number>();
    for (let cy = sy0; cy <= sy1; cy++) {
      for (let cx = sx0; cx <= sx1; cx++) {
        const i = sidx(cx, cy);
        if (claimed.has(i) || !(leafAt(cx, cy) || crownTop(cx, cy))) continue;
        const ie = sidx(cx + 1, cy);
        const is = sidx(cx, cy + 1);
        const id = sidx(cx + 1, cy + 1);
        const anchorTop = crownTop(cx, cy);
        // ...AND HOENN DRAWS TREES AT TWO SIZES (the 3x3)
        if (anchorTop && cx + 2 <= sx1 && cy + 2 <= sy1) {
          let nine = true;
          const nk: number[] = [];
          const seenM = new Set<number>();
          for (let dy = 0; dy <= 2 && nine; dy++) {
            for (let dx = 0; dx <= 2; dx++) {
              const j = sidx(cx + dx, cy + dy);
              nk.push(j);
              if (claimed.has(j)) nine = false;
              const mm = metatileAt(cx + dx, cy + dy);
              if (seenM.has(mm)) nine = false;
              else seenM.add(mm);
              if (dy < 2 ? !crownAt(cx + dx, cy + dy) : !footAt(cx + dx, cy + dy)) nine = false;
            }
          }
          if (nine) {
            for (const j of nk) {
              claimed.add(j);
              sc.set(j, "cylinder");
            }
            sc.set(i, "canopy");
            sceneryScale.set(i, 3);
            continue;
          }
        }
        // AND THE 2x2 HAS TO BE A 2x2 DRAWING
        const mA = metatileAt(cx, cy);
        const mB = metatileAt(cx + 1, cy);
        const mC = metatileAt(cx, cy + 1);
        const motif = mA !== mB && mA !== mC;
        const widen = anchorTop && (footAt(cx, cy + 1) || footAt(cx + 1, cy + 1));
        // FRLG (ours): the standard tree is a crown row of solid blocked
        // leaves over a FOOT row -- the trunk with grass round it, 0.43 of
        // the cell drawn, so it fails `leafAt`'s solid > 0.5 -- and FRLG
        // draws neither row above the player, so `crownAt` (which reads the
        // above-player layer) never widens the square. A crown of blocked
        // leaves standing on its foot is the same whole tree his `widen`
        // and 3x3 rules describe ("a tree stands on its own foot"), so the
        // foot row is accepted under a leafy crown row.
        const footed = leafAt(cx, cy) && leafAt(cx + 1, cy) && (footAt(cx, cy + 1) || footAt(cx + 1, cy + 1));
        // (and under a walk-behind crown that his `widen` accepts, the body
        // row FRLG draws on the player's layer is that crown's foot)
        const quarterAt = (qx: number, qy: number) =>
          leafAt(qx, qy) || (widen && crownAt(qx, qy)) || ((footed || widen) && qy === cy + 1 && footAt(qx, qy));
        const four =
          motif && cx < sx1 && cy < sy1 && (leafAt(cx, cy) || widen) &&
          quarterAt(cx + 1, cy) && quarterAt(cx, cy + 1) && quarterAt(cx + 1, cy + 1) &&
          !claimed.has(ie) && !claimed.has(is) && !claimed.has(id);
        if (four) {
          for (const j of [i, ie, is, id]) claimed.add(j);
          sc.set(i, "canopy");
          sc.set(ie, "cylinder");
          sc.set(is, "cylinder");
          sc.set(id, "cylinder");
          sceneryScale.set(i, 2);
        } else if (leafAt(cx, cy)) {
          claimed.add(i);
          sc.set(i, "cylinder");
        }
      }
    }
    // FRLG (ours): where trees stand in rows the greedy square takes a crown
    // and the crown below it, and the lower tree's FOOT row (trunk on grass)
    // is left over -- blocked, so it would stand as a box of trunk art under
    // the hulls. A foot directly under a claimed tree cell is that tree's
    // trunk: a hull of its own drawing, as his lone-cell fallback gives a
    // leaf that formed no square.
    for (let cy = sy0 + 1; cy <= sy1; cy++) {
      for (let cx = sx0; cx <= sx1; cx++) {
        const i = sidx(cx, cy);
        if (claimed.has(i) || !footAt(cx, cy) || !claimed.has(sidx(cx, cy - 1))) continue;
        claimed.add(i);
        sc.set(i, "cylinder");
      }
    }
    // ...AND TWO TREES MAY STAND IN THE SAME CELL
    for (let cy = sy0; cy < sy1; cy++) {
      for (let cx = sx0; cx < sx1; cx++) {
        const i = sidx(cx, cy);
        const ie = sidx(cx + 1, cy);
        const is = sidx(cx, cy + 1);
        const id = sidx(cx + 1, cy + 1);
        let whole =
          sc.get(i) !== "canopy" && sc.get(ie) !== "canopy" && sc.get(is) !== "canopy" && sc.get(id) !== "canopy" &&
          crownAt(cx, cy) && crownAt(cx + 1, cy) && footAt(cx, cy + 1) && footAt(cx + 1, cy + 1);
        if (whole) {
          const seenM = new Set<number>();
          for (const [x, y] of [[cx, cy], [cx + 1, cy], [cx, cy + 1], [cx + 1, cy + 1]] as const) {
            const mm = metatileAt(x, y);
            if (seenM.has(mm)) whole = false;
            else seenM.add(mm);
          }
        }
        if (whole) {
          let rs = cx;
          let re = cx + 1;
          while (footAt(rs - 1, cy + 1)) rs--;
          while (footAt(re + 1, cy + 1)) re++;
          if ((re - rs + 1) % 2 !== 0 || (cx - rs) % 2 !== 0) whole = false;
        }
        if (whole && (claimed.has(i) || claimed.has(ie) || claimed.has(is) || claimed.has(id))) {
          for (const j of [i, ie, is, id]) claimed.add(j);
          sc.set(i, "canopy");
          for (const j of [ie, is, id]) if (sc.get(j) !== "canopy") sc.set(j, "cylinder");
          sceneryScale.set(i, 2);
          sceneryShared.add(i);
        }
      }
    }
    // A BOULDER IS A ROCK STANDING IN A FIELD
    const LUMP_MAX = 9;
    const onLand = (cx: number, cy: number) => {
      for (const [dx, dy] of NEIGHBOURS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (!offMap(nx, ny) && !blockedAt(nx, ny) && ctxRef.roleAt(nx, ny) !== "water") return true;
      }
      return false;
    };
    const rocky = (cx: number, cy: number) => {
      if (!inRing(cx, cy) || sc.has(sidx(cx, cy)) || offMap(cx, cy) || !blockedAt(cx, cy)) return false;
      const m = metatileAt(cx, cy);
      const st = statsOf(m);
      if (!(st && st.solid > 0.5) || st.overhead) return false;
      return !leafAt(cx, cy);
    };
    const lumpMemo = new Map<number, [number, number][] | false>();
    const lump = (cx: number, cy: number): [number, number][] | null => {
      const hit = lumpMemo.get(ck(cx, cy));
      if (hit !== undefined) return hit || null;
      const seen = new Set<number>([ck(cx, cy)]);
      const q: [number, number][] = [[cx, cy]];
      for (let qh = 0; qh < q.length; qh++) {
        if (q.length > LUMP_MAX) {
          for (const k2 of seen) lumpMemo.set(k2, false);
          return null;
        }
        const c = q[qh]!;
        for (const [dx, dy] of NEIGHBOURS) {
          const nx = c[0] + dx;
          const ny = c[1] + dy;
          if (!seen.has(ck(nx, ny)) && rocky(nx, ny)) {
            seen.add(ck(nx, ny));
            q.push([nx, ny]);
          }
        }
      }
      for (const k2 of seen) lumpMemo.set(k2, q);
      return q;
    };
    // A LATHE IS NOT A MODELLER: a drawing that does not taper is not round
    const taperMemo = new Map<number, boolean>();
    const tapers = (m: number) => {
      const hit = taperMemo.get(m);
      if (hit !== undefined) return hit;
      const s = slotOf(m);
      let wmin = 99;
      let wmax = -1;
      for (let fy = 0; fy < 16; fy++) {
        let lo = 99;
        let hi = -1;
        for (let fx = 0; fx < 16; fx++) {
          if (surface.opaque(s, fx, fy)) {
            if (fx < lo) lo = fx;
            if (fx > hi) hi = fx;
          }
        }
        if (hi >= 0) {
          const w = hi - lo + 1;
          if (w < wmin) wmin = w;
          if (w > wmax) wmax = w;
        }
      }
      const ok = wmax >= 0 && wmax - wmin > 1;
      taperMemo.set(m, ok);
      return ok;
    };
    const BOULDER_RUN_MAX = 8;
    const runMemo = new Map<number, number>();
    const blockedRun = (cx: number, cy: number) => {
      if (outdoor || offMap(cx, cy)) return 0;
      const hit = runMemo.get(ck(cx, cy));
      if (hit !== undefined) return hit;
      if (!blockedAt(cx, cy)) return 0;
      const q: [number, number][] = [[cx, cy]];
      const seen = new Set<number>([ck(cx, cy)]);
      for (let qi = 0; qi < q.length; qi++) {
        const c = q[qi]!;
        for (const [dx, dy] of NEIGHBOURS) {
          const nx = c[0] + dx;
          const ny = c[1] + dy;
          if (!offMap(nx, ny) && !seen.has(ck(nx, ny)) && blockedAt(nx, ny)) {
            seen.add(ck(nx, ny));
            q.push([nx, ny]);
          }
        }
      }
      for (const c of q) runMemo.set(ck(c[0], c[1]), q.length);
      return q.length;
    };
    for (let cy = sy0; cy <= sy1; cy++) {
      for (let cx = sx0; cx <= sx1; cx++) {
        const i = sidx(cx, cy);
        if (claimed.has(i) || !rocky(cx, cy) || !lump(cx, cy)) continue;
        const ie = sidx(cx + 1, cy);
        const is = sidx(cx, cy + 1);
        const id = sidx(cx + 1, cy + 1);
        const mA = metatileAt(cx, cy);
        const mB = metatileAt(cx + 1, cy);
        const mC = metatileAt(cx, cy + 1);
        const capA = metaRole(mA)?.cap ?? 0;
        const capB = metaRole(mB)?.cap ?? 0;
        const four =
          mA !== mB && mA !== mC && cx < sx1 && cy < sy1 && capA > 0 && capB > 0 &&
          (outdoor || blockedRun(cx, cy) > BOULDER_RUN_MAX) &&
          rocky(cx + 1, cy) && rocky(cx, cy + 1) && rocky(cx + 1, cy + 1) &&
          !claimed.has(ie) && !claimed.has(is) && !claimed.has(id) &&
          (lump(cx, cy) ?? []).length <= 6 && onLand(cx, cy);
        if (four) {
          for (const j of [i, ie, is, id]) claimed.add(j);
          sc.set(i, "canopy");
          sc.set(ie, "cylinder");
          sc.set(is, "cylinder");
          sc.set(id, "cylinder");
        } else if (capA > 0 && (lump(cx, cy) ?? []).length <= 4 && onLand(cx, cy) && tapers(mA) && blockedRun(cx, cy) <= BOULDER_RUN_MAX) {
          claimed.add(i);
          sc.set(i, "cylinder");
        }
      }
    }
    // A SIGN IS A BOARD ON A POST, NOT A BLOCK OF MASONRY (outdoors)
    if (outdoor) {
      const lone = (cx: number, cy: number) => {
        if (!inRing(cx, cy) || sc.has(sidx(cx, cy)) || offMap(cx, cy) || !blockedAt(cx, cy)) return false;
        const m = metatileAt(cx, cy);
        const st = statsOf(m);
        if (!st || st.leafy || st.overhead || st.overhang || st.solid < 0.4) return false;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1]] as const) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (!offMap(nx, ny) && blockedAt(nx, ny)) return false;
        }
        if (blockedAt(cx, cy - 1) && metatileAt(cx, cy - 1) === m) return false;
        return true;
      };
      for (let cy = 0; cy < height; cy++) for (let cx = 0; cx < width; cx++) if (lone(cx, cy)) sc.set(sidx(cx, cy), "signpost");
    }
    // A ROCK STANDING IN THE SEA
    const waterCell = (cx: number, cy: number) => offMap(cx, cy) || behaviourClass(attributes(metatileAt(cx, cy))) === "water";
    const rockCell = (cx: number, cy: number) => {
      if (offMap(cx, cy) || !blockedAt(cx, cy)) return false;
      const m = metatileAt(cx, cy);
      const bn = behaviourClass(attributes(m));
      if (bn !== undefined && bn !== "ground" && bn !== "grass") return false;
      const st = statsOf(m);
      return !!(st && st.solid > 0.4 && !st.leafy && !st.overhead);
    };
    if (outdoor) {
      for (let cy = 0; cy < height - 1; cy++) {
        for (let cx = 0; cx < width - 1; cx++) {
          if (!(rockCell(cx, cy) && rockCell(cx + 1, cy) && rockCell(cx, cy + 1) && rockCell(cx + 1, cy + 1) && !sc.has(sidx(cx, cy)))) continue;
          let ringed = true;
          let sea = 0;
          for (const [dx, dy] of [[-1, -1], [0, -1], [1, -1], [2, -1], [-1, 0], [2, 0], [-1, 1], [2, 1], [-1, 2], [0, 2], [1, 2], [2, 2]] as const) {
            if (waterCell(cx + dx, cy + dy)) sea++;
            else if (!rockCell(cx + dx, cy + dy)) {
              ringed = false;
              break;
            }
          }
          if (sea < 7) ringed = false;
          if (ringed) {
            for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) sc.set(sidx(cx + dx, cy + dy), "water");
            waterRocks.push([cx, cy, 2]);
          }
        }
      }
      // FRLG (ours): FRLG names its sea rocks -- a BLOCKED cell carrying a
      // water behaviour is a rock you cannot surf onto (the harbour town, the sea
      // routes), one cell each -- where Emerald leaves them MB_NORMAL in
      // 2x2s. Each is the same rock standing in open water: a 16px hull over
      // a cell that stays sea, when enough of its drawing is not water.
      for (let cy = 0; cy < height; cy++) {
        for (let cx = 0; cx < width; cx++) {
          if (!blockedAt(cx, cy) || sc.has(sidx(cx, cy))) continue;
          const m = metatileAt(cx, cy);
          if (behaviourClass(attributes(m)) !== "water") continue;
          const s = slotOf(m);
          let rock = 0;
          for (let y = 0; y < 16; y++) {
            for (let x = 0; x < 16; x++) {
              const [r, g, b] = art.rgbAt(s, x, y).map((c) => c / 255) as [number, number, number];
              const d1 = b - Math.max(r, g);
              if (!(d1 > 0.15 || (Math.min(r, g, b) > 0.62 && d1 > 0.04))) rock++;
            }
          }
          if (rock >= 40) waterRocks.push([cx, cy, 1]);
        }
      }
    }
    // A RAIL IS NOT A WALL (outdoors): thin, drawn on a surface, no face
    const railStands = (m: number) => {
      if (attributes(m) === MB_MOUNTAIN_TOP) return false;
      const r = metaRole(m);
      if (!r) return false;
      return r.cap >= 1 && r.face <= 1;
    };
    if (outdoor) {
      for (let cy = 0; cy < height; cy++) {
        for (let cx = 0; cx < width; cx++) {
          const i = sidx(cx, cy);
          if (sc.has(i) || !blockedAt(cx, cy)) continue;
          const m = metatileAt(cx, cy);
          const st = statsOf(m);
          if (st && st.solid > 0.06 && st.solid < 0.35 && !st.leafy && !st.overhead && !st.overhang && railStands(m)) sc.set(i, "fence");
        }
      }
      // FRLG (ours): FRLG's fences -- white pickets, grey railings, brown
      // stakes -- are posts and rails drawn over the lawn, 0.3 to 0.7 of the
      // cell drawn: past his carve's ceiling, so his role table calls them a
      // brow (or, for the stakes, banded rock) and the rock pass stands them
      // up as a one-course bank of fence pictures. They are the drawing his
      // Johto profile pins `post` for every fence there: a thin per-pixel
      // slab, each cell its own (Structures' post pool). So a blocked, thin
      // (0.06..0.75), non-foliage, non-overhead cell standing ON walkable
      // ground -- open ground (or more fence) both sides along one axis, the
      // way a fence line runs and a cliff edge never does -- is a fence; and
      // so is every railing his own carve found above.
      const thin = (cx: number, cy: number) => {
        if (offMap(cx, cy) || !blockedAt(cx, cy) || sc.has(sidx(cx, cy))) return false;
        const m = metatileAt(cx, cy);
        const st = statsOf(m);
        if (!st || st.leafy || st.overhead || st.overhang || st.solid <= 0.06 || st.solid >= 0.75) return false;
        const bc = behaviourClass(attributes(m));
        return bc === undefined || bc === "ground";
      };
      const open = (cx: number, cy: number) => !offMap(cx, cy) && !blockedAt(cx, cy);
      const posts: number[] = [];
      for (let cy = 0; cy < height; cy++) {
        for (let cx = 0; cx < width; cx++) {
          const i = sidx(cx, cy);
          if (sc.get(i) === "fence") {
            posts.push(i);
            continue;
          }
          if (!thin(cx, cy)) continue;
          // (a sign set into the line, as the city's fences carry, continues it)
          const side = (x: number, y: number) => {
            const n = offMap(x, y) ? undefined : sc.get(sidx(x, y));
            if (open(x, y) || thin(x, y) || n === "fence" || n === "signpost") return true;
            return !offMap(x, y) && behaviourClass(attributes(metatileAt(x, y))) === "signpost";
          };
          const alongX = side(cx - 1, cy) && side(cx + 1, cy) && (open(cx, cy - 1) || open(cx, cy + 1));
          const alongY = side(cx, cy - 1) && side(cx, cy + 1) && (open(cx - 1, cy) || open(cx + 1, cy));
          if (alongX || alongY) posts.push(i);
        }
      }
      // His own class for them, `fence` (10px, low): drawn as the post
      // pool's thin slab squashed to that height (shapes.ts ART.fence,
      // struct.ts buildObject).
      for (const i of posts) sc.set(i, "fence");
    }
    // INDOOR FURNITURE, from the floor showing around it
    if (!outdoor) {
      const FURNITURE_MAX = 8;
      const blobCells = new Map<number, [number, number][]>();
      const seenBlob = new Set<number>();
      for (let cy = 0; cy < height; cy++) {
        for (let cx = 0; cx < width; cx++) {
          if (seenBlob.has(ck(cx, cy)) || !blockedAt(cx, cy)) continue;
          const stack: [number, number][] = [[cx, cy]];
          const cells: [number, number][] = [];
          seenBlob.add(ck(cx, cy));
          while (stack.length) {
            const c = stack.pop()!;
            cells.push(c);
            for (const [dx, dy] of NEIGHBOURS) {
              const nx = c[0] + dx;
              const ny = c[1] + dy;
              if (!offMap(nx, ny) && !seenBlob.has(ck(nx, ny)) && blockedAt(nx, ny)) {
                seenBlob.add(ck(nx, ny));
                stack.push([nx, ny]);
              }
            }
          }
          for (const c of cells) blobCells.set(ck(c[0], c[1]), cells);
        }
      }
      const named = (m: number) => {
        const bc = behaviourClass(attributes(m));
        return bc !== undefined && bc !== "ground" && bc !== "wall";
      };
      for (let cy = 0; cy < height; cy++) {
        for (let cx = 0; cx < width; cx++) {
          const i = sidx(cx, cy);
          const cells = blobCells.get(ck(cx, cy));
          if (sc.has(i) || !cells || cells.length > FURNITURE_MAX) continue;
          const m = metatileAt(cx, cy);
          if (named(m)) continue;
          const f = surface.solidFrac[slotOf(m)]!;
          const st = statsOf(m);
          if (f > 0.12 && st) sc.set(i, st.n2 > 0 ? "prop" : "tabletop");
        }
      }
      // AN OBJECT IS NOT HALF A TABLE AND HALF A TREE
      const reclaimed = new Set<[number, number][]>();
      for (const cells of blobCells.values()) {
        if (reclaimed.has(cells) || cells.length > FURNITURE_MAX) continue;
        reclaimed.add(cells);
        let ok = true;
        let part = false;
        const want: [number, string][] = [];
        for (const c of cells) {
          const i2 = sidx(c[0], c[1]);
          const m2 = metatileAt(c[0], c[1]);
          const st2 = statsOf(m2);
          if (named(m2) || !st2) {
            ok = false;
            break;
          }
          const prior = sc.get(i2);
          if (prior === "prop" || prior === "tabletop") part = true;
          else if (prior === "cylinder" || prior === "canopy" || prior === undefined) want.push([i2, st2.n2 > 0 ? "prop" : "tabletop"]);
          else {
            ok = false;
            break;
          }
        }
        if (ok && part) {
          for (const [j, cls] of want) {
            sc.set(j, cls);
            sceneryScale.delete(j);
            sceneryShared.delete(j);
          }
        }
      }
    }
  };
  const sceneryAt = (cx: number, cy: number): string | undefined => {
    if (scenery === null) buildScenery();
    if (cx < sx0 || cy < sy0 || cx > sx1 || cy > sy1) return undefined;
    return scenery!.get(sidx(cx, cy));
  };
  const scenerySpan = (cx: number, cy: number) => {
    if (scenery === null) buildScenery();
    return sceneryScale.get(sidx(cx, cy));
  };
  const sceneryIsShared = (cx: number, cy: number) => {
    if (scenery === null) buildScenery();
    return sceneryShared.has(sidx(cx, cy));
  };

  // Gen3.lua:2715 roofAt: outdoors, blocked, a nearly full above-player layer, not foliage
  const roofAt = (cx: number, cy: number): boolean => {
    if (!outdoor || !blockedAt(cx, cy)) return false;
    const m = metatileAt(cx, cy);
    if (sceneryAt(cx, cy)) return false;
    const st = statsOf(m);
    if (!st) return false;
    return st.overhead && st.solid > 0.75 && !st.leafy;
  };

  // ---- the role vocabulary (Gen3.lua:3470-3880) ----
  const touchesWalkable = (cx: number, cy: number) => {
    for (const [dx, dy] of NEIGHBOURS) if (!offMap(cx + dx, cy + dy) && !blockedAt(cx + dx, cy + dy)) return true;
    return false;
  };
  const leafyMeta = (m: number) => {
    const st = statsOf(m);
    if (!(st && st.leafy && st.solid > 0.5)) return false;
    return metaRole(m)?.material === "green";
  };
  const FENCE_DEEP = 3;
  const RING8: [number, number][] = [[0, -1], [0, 1], [1, 0], [-1, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const massAt = (cx: number, cy: number) => {
    if (offMap(cx, cy) || !blockedAt(cx, cy)) return false;
    const r = metaRole(metatileAt(cx, cy));
    if (!r) return true;
    if (r.kind === "tree" || (r.motif && r.material === "green") || leafyMeta(metatileAt(cx, cy))) return false;
    return true;
  };
  const groundAcross = (cx: number, cy: number, dx: number, dy: number): string | null => {
    for (let step = 1; step <= FENCE_DEEP; step++) {
      const nx = cx + dx * step;
      const ny = cy + dy * step;
      if (offMap(nx, ny)) return null;
      if (!blockedAt(nx, ny)) return metaRole(metatileAt(nx, ny))?.material ?? null;
      if (!massAt(nx, ny)) return null;
    }
    return null;
  };
  const fenceAt = (cx: number, cy: number, m: number) => {
    const r0 = metaRole(m);
    if (!r0 || r0.cap !== 0) return false;
    for (const [ox, oy] of [[0, 0], [-1, 0], [0, -1], [-1, -1]] as const) {
      const ax = cx + ox;
      const ay = cy + oy;
      if (massAt(ax, ay) && massAt(ax + 1, ay) && massAt(ax, ay + 1) && massAt(ax + 1, ay + 1)) return false;
    }
    for (const [dx, dy] of RING8) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (offMap(nx, ny)) continue;
      const r = metaRole(metatileAt(nx, ny));
      if (!r) continue;
      if (r.cap > 0 && r.face > 0) return false;
      if (blockedAt(nx, ny)) {
        if (r.art === "surface" || r.cap >= 12) return false;
        if (!touchesWalkable(nx, ny)) return false;
      }
    }
    let ground: string | null = null;
    for (const [ax, ay] of [[0, 1], [1, 0]] as const) {
      const a = groundAcross(cx, cy, ax, ay);
      const b = groundAcross(cx, cy, -ax, -ay);
      if (a && b && a === b) {
        ground = a;
        break;
      }
    }
    if (ground === null) return false;
    const seen = new Map<number, number>([[ck(cx, cy), 0]]);
    const q: [number, number][] = [[cx, cy]];
    for (let qh = 0; qh < q.length; qh++) {
      const c = q[qh]!;
      const d = seen.get(ck(c[0], c[1])) ?? 0;
      if (metaRole(metatileAt(c[0], c[1]))?.kind === "ledge") return false;
      for (const [dx, dy] of NEIGHBOURS) {
        const nx = c[0] + dx;
        const ny = c[1] + dy;
        if (offMap(nx, ny)) continue;
        if (!blockedAt(nx, ny)) {
          if (treadMeta(metatileAt(nx, ny))) return false;
        } else if (d < FENCE_DEEP && !seen.has(ck(nx, ny)) && massAt(nx, ny)) {
          seen.set(ck(nx, ny), d + 1);
          q.push([nx, ny]);
        }
      }
    }
    return true;
  };
  const roleMemo = new Map<number, string>();
  const roleAt = (cx: number, cy: number): string => {
    const hit = roleMemo.get(ck(cx, cy));
    if (hit !== undefined) return hit;
    const m = metatileAt(cx, cy);
    const r = metaRole(m);
    let role: string;
    if (!r) role = blockedAt(cx, cy) ? "prop" : "floor";
    else if ((r.kind === "water" || (r.material === "water" && blockedAt(cx, cy))) && behaviourClass(attributes(m)) === "water") role = "water";
    else if (r.kind === "ledge") role = "ledge";
    else if (!blockedAt(cx, cy)) {
      let stair = r.art === "banded";
      if (stair) {
        const st = statsOf(m);
        if (r.face > 1) stair = false;
        if (st && st.solid < 0.75) stair = false;
      }
      role = stair ? "stair" : "floor";
    } else if (r.kind === "tree" || (r.motif && r.material === "green") || leafyMeta(m)) role = "tree";
    else if (r.motif && attributes(m) !== MB_MOUNTAIN_TOP) role = "prop";
    else if (isBuildingCell(cx, cy)) role = "wall";
    else if (!touchesWalkable(cx, cy)) role = "shelf";
    else if (r.art === "surface") role = "shelf";
    else if (r.art === "face" || r.art === "brow" || ["rock", "sand", "stone", "manmade"].includes(r.material)) role = fenceAt(cx, cy, m) ? "fence" : "cliff";
    else role = "prop";
    roleMemo.set(ck(cx, cy), role);
    return role;
  };

  // ---- the buildings the warps name (Gen3.lua:4391 ctx.buildings) ----
  let counts: Map<number, number> | null = null;
  const metatileCounts = () => {
    if (counts) return counts;
    counts = new Map();
    for (let cy = 0; cy < height; cy++) {
      for (let cx = 0; cx < width; cx++) {
        const m = metatileAt(cx, cy);
        counts.set(m, (counts.get(m) ?? 0) + 1);
      }
    }
    return counts;
  };
  const RARE_BUILD = 4;
  const LINTEL_MAX = 2;
  /** Structures.lua GEN3_MAX_ROWS (12 tile rows), in cells. */
  const GEN3_MAX_ROWS_CELLS = 6;
  const blockedCell = (cx: number, cy: number) => !offMap(cx, cy) && blockedAt(cx, cy);
  const foliageCell = (cx: number, cy: number) => {
    const m = metatileAt(cx, cy);
    const st = statsOf(m);
    if (!(st && st.leafy && st.solid > 0.5)) return false;
    return metaRole(m)?.material === "green";
  };
  const warpSet = new Set(map.warps.map((w) => ck(w.x, w.y)));
  const lintelCell = (cx: number, cy: number) => {
    if (!outdoor) return false;
    if (!(blockedCell(cx - 1, cy) && blockedCell(cx + 1, cy))) return false;
    const m = metatileAt(cx, cy);
    const st = statsOf(m);
    if (!(st && st.solid >= 0.9)) return false;
    return (metatileCounts().get(m) ?? 0) <= RARE_BUILD;
  };
  const bespokeCell = (cx: number, cy: number) => (metatileCounts().get(metatileAt(cx, cy)) ?? 0) <= RARE_BUILD;
  const overheadBespoke = (cx: number, cy: number) => {
    const st = statsOf(metatileAt(cx, cy));
    if (!(st && st.overhead && st.solid >= 0.9)) return false;
    return bespokeCell(cx, cy);
  };
  const runAbove = (cx: number, doorY: number): [number, number] | null => {
    const y = doorY - 1;
    if (y < 0) return null;
    let mass = y;
    if (!blockedCell(cx, mass)) {
      if (!warpSet.has(ck(cx, doorY))) return null;
      let n = 0;
      while (n < LINTEL_MAX && mass - n >= 0 && !blockedCell(cx, mass - n) && lintelCell(cx, mass - n)) n++;
      if (n === 0) return null;
      mass -= n;
      if (mass < 0 || !blockedCell(cx, mass)) return null;
    }
    let top = mass;
    while (top - 1 >= 0 && blockedCell(cx, top - 1) && y - (top - 1) < 8) top--;
    const WALK_BEHIND_GAP = 1;
    while (outdoor && bespokeCell(cx, top)) {
      let g = 0;
      while (g < WALK_BEHIND_GAP && top - 1 - g >= 0 && !blockedCell(cx, top - 1 - g) && overheadBespoke(cx, top - 1 - g)) g++;
      if (g === 0) break;
      const nxt = top - g - 1;
      if (nxt < 0 || !blockedCell(cx, nxt) || !bespokeCell(cx, nxt) || y - nxt >= 8) break;
      top = nxt;
      while (top - 1 >= 0 && blockedCell(cx, top - 1) && y - (top - 1) < 8) top--;
    }
    return [top, y];
  };
  let built: { list: Building[]; cell: Map<number, number> } | null = null;
  const buildings = () => {
    if (built) return built;
    const b: { list: Building[]; cell: Map<number, number> } = { list: [], cell: new Map() };
    built = b;
    const roofTop = (cx: number, doorY: number, floorY?: number): [number, number] | null => {
      const r = runAbove(cx, doorY);
      if (!r) return null;
      let [t] = r;
      const bot = r[1];
      if (floorY !== undefined && floorY > t) t = floorY;
      for (let y = t; y <= bot; y++) if (roofAt(cx, y)) return [y, bot];
      return null;
    };
    for (const wp of map.warps) {
      const wx = wp.x;
      const wy = wp.y;
      const t0rr = roofTop(wx, wy);
      const t0r = t0rr ? t0rr[0] : undefined;
      const ra = runAbove(wx, wy);
      const t0 = t0r ?? (ra ? ra[0] : undefined);
      const twin = b.cell.has(ck(wx, wy));
      if (t0 === undefined || twin || b.cell.has(ck(wx, t0))) continue;
      const cells: [number, number][] = [];
      let overheadRows = 0;
      const taken: { cx: number; top: number; raw: number }[] = [];
      const id = b.list.length + 1;
      const claim = (cx: number, y: number) => {
        if (!b.cell.has(ck(cx, y))) {
          b.cell.set(ck(cx, y), id);
          cells.push([cx, y]);
        }
      };
      // FRLG (ours): FRLG towns stand buildings shoulder to shoulder (the
      // house beside a northern city's centre), and `take` walking out five columns
      // from one door swallows the next building's columns -- and with them
      // the cell that building's own door would have started from. A column
      // nearer another door on the same street belongs to that door.
      // (two doors into the same place -- a department store's pair -- are
      // one building's)
      const otherDoorNearer = (cx: number) =>
        map.warps.some(
          (w) => w.destMap !== wp.destMap && Math.abs(w.y - wy) <= 3 && Math.abs(cx - w.x) < Math.abs(cx - wx),
        );
      const take = (cx: number): boolean => {
        if (otherDoorNearer(cx)) return false;
        const r = runAbove(cx, wy);
        if (!r) return false;
        let [t] = r;
        const bot = r[1];
        const rawTop = t;
        if (t0r !== undefined) {
          const rr = roofTop(cx, wy, t0r - 1);
          if (!rr || Math.abs(rr[0] - t0r) > 1) return false;
          t = rr[0];
        } else if (Math.abs(t - t0) > 1) return false;
        if (t0r === undefined) {
          const cnt = metatileCounts();
          while (t < bot) {
            if ((cnt.get(metatileAt(cx, t)) ?? 0) > RARE_BUILD) t++;
            else break;
          }
        }
        let grew = 0;
        for (let k = 0; k < 4; k++) {
          const ny = t - 1;
          if (ny < 0 || blockedAt(cx, ny)) break;
          const mm = metatileAt(cx, ny);
          const st = statsOf(mm);
          if (!(st && st.overhead && st.solid >= 0.9 && (metatileCounts().get(mm) ?? 0) <= RARE_BUILD)) break;
          t = ny;
          grew++;
        }
        if (grew > overheadRows) overheadRows = grew;
        if (outdoor) {
          let allLeaf = true;
          for (let y = t; y <= bot; y++) {
            if (!foliageCell(cx, y)) {
              allLeaf = false;
              break;
            }
          }
          if (allLeaf) return false;
        }
        taken.push({ cx, top: t, raw: rawTop });
        for (let y = t; y <= bot; y++) claim(cx, y);
        return true;
      };
      take(wx);
      for (let dx = 1; dx <= 5; dx++) if (!take(wx + dx)) break;
      for (let dx = 1; dx <= 5; dx++) if (!take(wx - dx)) break;
      let walkY0: number | undefined;
      for (const c of cells) if (walkY0 === undefined || c[1] < walkY0) walkY0 = c[1];
      const RARE = 4;
      {
        const cnt = metatileCounts();
        let x0: number | undefined;
        let x1: number | undefined;
        for (const c of cells) {
          if (x0 === undefined || c[0] < x0) x0 = c[0];
          if (x1 === undefined || c[0] > x1) x1 = c[0];
        }
        const grab = (cx: number) => {
          if (cx < 0 || cx >= width || otherDoorNearer(cx)) return false;
          const r = runAbove(cx, wy);
          if (!r) return false;
          for (let y = r[0]; y <= r[1]; y++) if ((cnt.get(metatileAt(cx, y)) ?? 0) > RARE) return false;
          for (let y = r[0]; y <= r[1]; y++) claim(cx, y);
          taken.push({ cx, top: r[0], raw: r[0] });
          return true;
        };
        if (x1 !== undefined && x0 !== undefined) {
          for (let d = 1; d <= 3; d++) if (!grab(x1 + d)) break;
          for (let d = 1; d <= 3; d++) if (!grab(x0 - d)) break;
        }
        let nx0: number | undefined;
        let nx1: number | undefined;
        for (const c of cells) {
          if (nx0 === undefined || c[0] < nx0) nx0 = c[0];
          if (nx1 === undefined || c[0] > nx1) nx1 = c[0];
        }
        if (nx0 !== undefined && nx1 !== undefined) {
          // the door's own row, across the building
          for (let cx = nx0; cx <= nx1; cx++) {
            if (b.cell.has(ck(cx, wy)) || !blockedAt(cx, wy)) continue;
            const mm = metatileAt(cx, wy);
            const under = outdoor && wy > 0 && b.cell.get(ck(cx, wy - 1)) === id;
            if ((cnt.get(mm) ?? 0) <= RARE || under) claim(cx, wy);
          }
        }
      }
      if (outdoor && taken.length > 1) {
        let tMin: number | undefined;
        for (const e of taken) if (tMin === undefined || e.top < tMin) tMin = e.top;
        for (const e of taken) {
          const newTop = Math.max(tMin!, e.raw);
          for (let y = e.top - 1; y >= newTop; y--) {
            const st = statsOf(metatileAt(e.cx, y));
            if (st && st.leafy) break;
            claim(e.cx, y);
          }
        }
      }
      {
        const cnt = metatileCounts();
        let x0 = Infinity;
        let x1 = -Infinity;
        for (const c of cells) {
          x0 = Math.min(x0, c[0]);
          x1 = Math.max(x1, c[0]);
        }
        let top: number | undefined;
        for (const c of cells) if (top === undefined || c[1] < top) top = c[1];
        for (let k = 0; k < 2; k++) {
          if (top === undefined || top <= 0) break;
          const row = top - 1;
          let ok = true;
          for (let cx = x0; cx <= x1; cx++) {
            if (!blockedAt(cx, row) || (cnt.get(metatileAt(cx, row)) ?? 0) !== 1) {
              ok = false;
              break;
            }
          }
          if (!ok) break;
          for (let cx = x0; cx <= x1; cx++) claim(cx, row);
          top = row;
        }
      }
      let drop = false;
      if (cells.length > 0 && t0r === undefined) {
        let y0: number | undefined;
        let y1: number | undefined;
        let rare = 0;
        let above = 0;
        let nc = 0;
        const cnt = metatileCounts();
        const yCut = outdoor && walkY0 !== undefined ? wy - 1 : undefined;
        for (const c of cells) {
          if (yCut === undefined || c[1] <= yCut) {
            if (y0 === undefined || c[1] < y0) y0 = c[1];
            if (y1 === undefined || c[1] > y1) y1 = c[1];
            nc++;
            if ((cnt.get(metatileAt(c[0], c[1])) ?? 0) <= RARE_BUILD * 8) rare++;
          }
        }
        if (y0 !== undefined && y0 === y1 && y0 > 0) {
          for (const c of cells) if (c[1] === y0 && blockedAt(c[0], y0 - 1)) above++;
          if (above * 2 >= nc && rare * 5 < nc * 2) drop = true;
        }
      }
      if (drop) {
        for (const c of cells) b.cell.delete(ck(c[0], c[1]));
        continue;
      }
      if (cells.length > 0) b.list.push({ cells, door: [wx, wy], overheadRows, roofed: t0r !== undefined });
    }
    // THE DOORLESS MASSES: a solid, roofed rectangle standing free (outdoors)
    if (outdoor) {
      const DOORLESS_MIN_SPAN = 2;
      const DOORLESS_SOLID = 0.9;
      const seenMass = new Set<number>();
      const unclaimed = (cx: number, cy: number) => !offMap(cx, cy) && !b.cell.has(ck(cx, cy)) && blockedAt(cx, cy);
      for (let cy0 = 0; cy0 < height; cy0++) {
        for (let cx0 = 0; cx0 < width; cx0++) {
          if (seenMass.has(ck(cx0, cy0)) || !unclaimed(cx0, cy0)) continue;
          const stack: [number, number][] = [[cx0, cy0]];
          const cells: [number, number][] = [];
          seenMass.add(ck(cx0, cy0));
          while (stack.length) {
            const c = stack.pop()!;
            cells.push(c);
            for (const [dx, dy] of NEIGHBOURS) {
              const nx = c[0] + dx;
              const ny = c[1] + dy;
              if (!seenMass.has(ck(nx, ny)) && unclaimed(nx, ny)) {
                seenMass.add(ck(nx, ny));
                stack.push([nx, ny]);
              }
            }
          }
          let x0 = Infinity;
          let x1 = -Infinity;
          let y0 = Infinity;
          let y1 = -Infinity;
          for (const c of cells) {
            x0 = Math.min(x0, c[0]);
            x1 = Math.max(x1, c[0]);
            y0 = Math.min(y0, c[1]);
            y1 = Math.max(y1, c[1]);
          }
          const w = x1 - x0 + 1;
          const h = y1 - y0 + 1;
          let ok = w >= DOORLESS_MIN_SPAN && h >= DOORLESS_MIN_SPAN && cells.length === w * h;
          if (ok) {
            const inMass = new Set(cells.map((c) => ck(c[0], c[1])));
            outer: for (const c of cells) {
              for (const [dx, dy] of NEIGHBOURS) {
                const nx = c[0] + dx;
                const ny = c[1] + dy;
                if (inMass.has(ck(nx, ny))) continue;
                if (offMap(nx, ny) || blockedAt(nx, ny)) {
                  ok = false;
                  break outer;
                }
              }
            }
          }
          if (ok) for (let cx = x0; cx <= x1; cx++) if (!roofAt(cx, y0)) ok = false;
          if (ok) {
            for (const c of cells) {
              const st = statsOf(metatileAt(c[0], c[1]));
              if (!(st && st.solid >= DOORLESS_SOLID)) {
                ok = false;
                break;
              }
            }
          }
          if (ok) {
            const id = b.list.length + 1;
            for (const c of cells) b.cell.set(ck(c[0], c[1]), id);
            b.list.push({ cells, door: [x0 + Math.floor((x1 - x0) / 2), y1], overheadRows: 0, roofed: true });
          }
        }
      }
      // (both FRLG passes below) only what is drawn as a building, not a named surface (water)
      const builtArt = (cx: number, cy: number) => {
        const bc = behaviourClass(attributes(metatileAt(cx, cy)));
        return bc === undefined || bc === "ground" || bc === "wall";
      };
      // FRLG (ours): and a warp-named building whose roof FRLG draws UNDER
      // the player (layer type COVERED: the gyms' and civic halls' flat roofs)
      // states no roof rows, so `take` above keeps only the door's column and
      // the rest of the mass is left to be cut down as rock. Grow each
      // warp-named footprint through the solid, non-foliage blocked cells of
      // its own mass -- never below its door's row, never more than a
      // building's width from the door, never into scenery or another
      // building -- which is the footprint his `take` reads off a roof
      // Emerald does state.
      const GROW_REACH = 8;
      for (let id = 1; id <= b.list.length; id++) {
        const bl = b.list[id - 1]!;
        if (bl.overheadRows < 0) continue;
        const [dx0, dy0] = bl.door;
        const q = [...bl.cells];
        for (let qi = 0; qi < q.length; qi++) {
          const c = q[qi]!;
          for (const [ox, oy] of NEIGHBOURS) {
            const nx = c[0] + ox;
            const ny = c[1] + oy;
            if (offMap(nx, ny) || b.cell.has(ck(nx, ny)) || !blockedAt(nx, ny) || ny > dy0 || ny < dy0 - GEN3_MAX_ROWS_CELLS) continue;
            if (Math.abs(nx - dx0) > GROW_REACH || sceneryAt(nx, ny)) continue;
            const st = statsOf(metatileAt(nx, ny));
            if (!(st && st.solid >= DOORLESS_SOLID && !st.leafy) || !builtArt(nx, ny)) continue;
            b.cell.set(ck(nx, ny), id);
            bl.cells.push([nx, ny]);
            q.push([nx, ny]);
          }
        }
      }
      // FRLG (ours): the cities are full of doorless facades -- the big cities'
      // apartment blocks, the houses no warp leads into -- standing
      // shoulder to shoulder with warp-named buildings and with fences along
      // their fronts, so his doorless rule (a free-standing solid rectangle,
      // walkable all round) rejects nearly all of them, and his rock pass then
      // cuts them down to a one-course bank. The building is the part of the
      // mass that is a building's drawing: columns that begin at a cell
      // roofAt names and run down through solid, non-foliage blocked cells.
      // Neighbouring such columns whose roofs start within a row of each other
      // are one building, as `take` above joins a warp-named one.
      // a building fronts the ground: some cell south of its foot is walkable
      // land (the rock piles in the sea roof over the player too)
      // (or past a fence in front of it)
      const land = (cx: number, cy: number) => !offMap(cx, cy) && !blockedAt(cx, cy) && behaviourClass(attributes(metatileAt(cx, cy))) !== "water";
      const fronts = (group: { cx: number; bot: number }[]) =>
        group.some((s) => land(s.cx, s.bot + 1) || (sceneryAt(s.cx, s.bot + 1) === "fence" && land(s.cx, s.bot + 2)));
      // A roof may also be a course left WALKABLE over the mass (his
      // `gen3RoofUnseen`: overhead, solid, not foliage) -- the top of a roof
      // you walk behind, with the building blocked beneath it.
      const unseenRoof = (cx: number, cy: number) => {
        if (offMap(cx, cy) || blockedAt(cx, cy) || cy + 1 >= height || !blockedAt(cx, cy + 1)) return false;
        const st = statsOf(metatileAt(cx, cy));
        return !!(st && st.overhead && st.solid >= 0.9 && !st.leafy);
      };
      const roofTopAt = (cx: number, cy: number) => (roofAt(cx, cy) || unseenRoof(cx, cy)) && builtArt(cx, cy);
      const segs: { cx: number; top: number; bot: number }[] = [];
      for (let cx = 0; cx < width; cx++) {
        let cy = 0;
        while (cy < height) {
          if (b.cell.has(ck(cx, cy)) || !roofTopAt(cx, cy) || (cy > 0 && roofTopAt(cx, cy - 1) && !b.cell.has(ck(cx, cy - 1)))) {
            cy++;
            continue;
          }
          let bot = cy;
          while (bot + 1 < height && !b.cell.has(ck(cx, bot + 1)) && blockedAt(cx, bot + 1) && !sceneryAt(cx, bot + 1)) {
            const st = statsOf(metatileAt(cx, bot + 1));
            if (!(st && st.solid >= DOORLESS_SOLID && !st.leafy) || !builtArt(cx, bot + 1)) break;
            bot++;
          }
          // three rows at least: a roof course over a single face row is a
          // raised wall (the enclosures' hedge banks), not a house
          if (bot - cy + 1 >= 3) segs.push({ cx, top: cy, bot });
          cy = bot + 1;
        }
      }
      const used = new Set<(typeof segs)[number]>();
      for (const s0 of segs) {
        if (used.has(s0)) continue;
        const group = [s0];
        used.add(s0);
        for (;;) {
          const last = group[group.length - 1]!;
          const next = segs.find((s) => !used.has(s) && s.cx === last.cx + 1 && Math.abs(s.top - last.top) <= 1);
          if (!next) break;
          group.push(next);
          used.add(next);
        }
        if (group.length < DOORLESS_MIN_SPAN || !fronts(group)) continue;
        const id = b.list.length + 1;
        const cells: [number, number][] = [];
        let ybot = 0;
        for (const s of group) {
          for (let y = s.top; y <= s.bot; y++) {
            b.cell.set(ck(s.cx, y), id);
            cells.push([s.cx, y]);
          }
          ybot = Math.max(ybot, s.bot);
        }
        b.list.push({ cells, door: [group[Math.floor(group.length / 2)]!.cx, ybot], overheadRows: 0, roofed: true });
      }
    }
    return b;
  };
  let inSceneClass = false;
  const isBuildingCell = (cx: number, cy: number) => buildings().cell.has(ck(cx, cy));

  // ---- Gen3.lua:2792 classAt ----
  const classCache = new Map<number, string>();
  let inRoleClass = false;
  const asLandscape = (cls: string, cx: number, cy: number): string => {
    if (cls !== "wall" || inRoleClass || !outdoor) return cls;
    inRoleClass = true;
    const r = roleAt(cx, cy);
    inRoleClass = false;
    if (r === "cliff" || r === "shelf" || r === "fence") return "cliff";
    return cls;
  };
  const classAt = (cx: number, cy: number): { cls: string; pinned: boolean } | null => {
    const m = metatileAt(cx, cy);
    let scene = sceneryAt(cx, cy);
    if (scene && !inSceneClass) {
      inSceneClass = true;
      const isB = isBuildingCell(cx, cy);
      inSceneClass = false;
      if (isB) scene = undefined;
    }
    if (scene && !outdoor) {
      const row = behaviourClass(attributes(m));
      if (row !== undefined && row !== "ground" && row !== "wall") scene = undefined;
    }
    if (scene && behaviourClass(attributes(m)) !== "ledge") return { cls: scene, pinned: true };
    // OFF THE MAP THERE IS NO COLLISION, ONLY ART
    let blocked: boolean;
    if (offMap(cx, cy)) {
      const st = statsOf(m);
      blocked = !!(st && st.solid > 0.5);
    } else blocked = blockedAt(cx, cy);
    if (!blocked && elevationAt(cx, cy) === ELEV_MULTI) return { cls: "bridge", pinned: false };
    if (!blocked && elevationAt(cx, cy) === ELEV_SURF) {
      const row = behaviourClass(attributes(m));
      if (row === "waterfall") return { cls: "waterfall", pinned: false };
      if (row !== "bridge" && row !== "log") return { cls: "water", pinned: false };
    }
    const key = m * 2 + (blocked ? 1 : 0);
    const hit = classCache.get(key);
    if (hit !== undefined) return { cls: asLandscape(hit, cx, cy), pinned: false };
    const b = attributes(m);
    let cls = behaviourClass(b);
    // FRLG: MB_SIGNPOST names a sign; outdoors it is the carve's signpost and
    // indoors (a poster, a notice on a wall) the wall it hangs on
    if (cls === "signpost" && !outdoor) cls = "wall";
    if (cls === undefined) cls = blocked ? "wall" : "ground";
    else if (cls === "ground" || cls === "grass" || cls === "slope") {
      if (blocked) cls = "wall";
    }
    // A PASSABLE CELL CANNOT BE SOMETHING YOU ARE STANDING INSIDE
    if (!blocked && STANDING.has(cls) && !isDoorBehaviour(b)) cls = "ground";
    // COVER on a blocked cell is what stands up (no FRLG profile names a cover class)
    classCache.set(key, cls);
    return { cls: asLandscape(cls, cx, cy), pinned: false };
  };

  ctxRef = {
    map, pair, art, surface, width, height, outdoor, underground,
    slotOf, metatileAt, offMap, blockedAt, elevationAt, attributes, coverAt, statsOf, metaRole,
    groundHeight, sceneryAt, scenerySpan, sceneryShared: sceneryIsShared,
    get waterRocks() {
      if (scenery === null) buildScenery();
      return waterRocks;
    },
    roofAt, classAt, roleAt, buildings, isBuildingCell, metatileCounts, floorMetatiles, usesElevation,
  };
  return ctxRef;
}

/** The FRLG behaviour name of a cell (debug / stats). */
export function behaviourName(b: number): string {
  return FRLG_NAMES[b] ?? `0x${b.toString(16)}`;
}
