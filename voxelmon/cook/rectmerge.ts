// voxelmon/cook/rectmerge.ts — merge textured quads into rectangles.
//
// The building emitter (buildings.ts, VoxelMod Buildings.lua) merges exposed
// faces into runs along ONE axis only, one texel tall, and stops every run at
// the 8px lattice. So a flat 8x8 patch of facade is eight strips, not one
// quad, and a city of nothing but buildings -- Saffron -- came out at 1.49M
// vertices. That is past the huge-map line, which makes the 3DS re-read and
// re-build the map every time the player crosses a chunk.
//
// Two neighbouring quads can become one when doing so cannot change a single
// sampled texel:
//
//   - same plane, same facing, same winding, same flat shade;
//   - their texture coordinates are the SAME affine function of position.
//     Each quad's uv is inset a hair inside its texel rect (0.05 in the
//     building emitter, 0.02 in the ground's); with the inset taken off, the
//     uv of every quad is an exact affine map of (a, b) on its plane. Two
//     quads with the same map sample the same texel at every point either
//     one covers, so their union samples exactly what they did. That one
//     test covers both run kinds -- a strip reading consecutive texels and a
//     single texel stretched over a run -- and refuses any pair whose rows
//     are not consecutive in the sheet, or run the wrong way;
//   - the merged rectangle stays inside one 8px lattice cell of its plane.
//     Upstream's lattice was for its world-curve effect, which this runtime
//     does not have; it is kept here because 8 divides the 128px chunk, so a
//     merged quad can never straddle a chunk line the partition and the
//     culls rely on.
//
// Per-corner (AO) shades, point-sampled quads, tree hull quads and anything
// that is not an axis-aligned rectangle pass through untouched and in place.
// Output order is input order, with each merged rectangle standing where its
// first piece stood.

import type { Quad } from "./geom.ts";

const AXES: [number, number, number][] = [
  [0, 1, 2], // x-plane: a = y, b = z
  [1, 0, 2], // y-plane: a = x, b = z
  [2, 0, 1], // z-plane: a = x, b = y
];

/** The merge lattice: 8 world px, a divisor of the 128px chunk. */
export const RECT_CELL = 8;

/** A uv coordinate this close to an integer is a texel edge, inset. */
const EDGE_TOL = 0.1;

interface Piece {
  at: number; // input index
  a0: number;
  a1: number;
  b0: number;
  b1: number;
}

const r6 = (x: number): number => Math.round(x * 1e6) / 1e6;

/**
 * The quad's plane, its rect, the uv inset, and its uv as an affine map of
 * (a, b) with the inset removed -- or null when it is not a candidate.
 */
function analyse(q: Quad) {
  if (!q.uv || q.tree || typeof q.shade !== "number" || q.c.length !== 4) return null;
  let axis = -1;
  for (const [ax] of AXES) {
    if (q.c.every((c) => c[ax] === q.c[0][ax])) {
      axis = ax;
      break;
    }
  }
  if (axis < 0) return null;
  const [, aAx, bAx] = AXES[axis];
  const as = q.c.map((c) => c[aAx]);
  const bs = q.c.map((c) => c[bAx]);
  const a0 = Math.min(...as);
  const a1 = Math.max(...as);
  const b0 = Math.min(...bs);
  const b1 = Math.max(...bs);
  if (a0 === a1 || b0 === b1) return null;
  // an axis-aligned rectangle: every corner on the bounding box's corners
  if (!q.c.every((c) => (c[aAx] === a0 || c[aAx] === a1) && (c[bAx] === b0 || c[bAx] === b1))) {
    return null;
  }
  // the inset: every uv coordinate the same hair off an integer
  let inset = -1;
  const U: [number, number][] = [];
  for (const [u, v] of q.uv) {
    const ru = Math.round(u);
    const rv = Math.round(v);
    const du = Math.abs(u - ru);
    const dv = Math.abs(v - rv);
    if (du > EDGE_TOL || dv > EDGE_TOL) return null;
    for (const d of [du, dv]) {
      if (inset < 0) inset = r6(d);
      else if (Math.abs(inset - d) > 1e-6) return null;
    }
    U.push([ru, rv]);
  }
  // affine fit from three corners, checked on the fourth
  const P = q.c.map((c) => [c[aAx], c[bAx]] as [number, number]);
  const solve = (k: 0 | 1): [number, number, number] | null => {
    // find corners differing only in a, and only in b
    let ga = NaN;
    let gb = NaN;
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        if (i === j) continue;
        if (P[i][1] === P[j][1] && P[i][0] !== P[j][0]) ga = (U[j][k] - U[i][k]) / (P[j][0] - P[i][0]);
        if (P[i][0] === P[j][0] && P[i][1] !== P[j][1]) gb = (U[j][k] - U[i][k]) / (P[j][1] - P[i][1]);
      }
    }
    if (!Number.isFinite(ga) || !Number.isFinite(gb)) return null;
    const off = U[0][k] - ga * P[0][0] - gb * P[0][1];
    for (let i = 0; i < 4; i++) {
      if (Math.abs(ga * P[i][0] + gb * P[i][1] + off - U[i][k]) > 1e-6) return null;
    }
    return [r6(ga), r6(gb), r6(off)];
  };
  const mu = solve(0);
  const mv = solve(1);
  if (!mu || !mv) return null;
  const cellA = Math.floor(a0 / RECT_CELL);
  const cellB = Math.floor(b0 / RECT_CELL);
  if (Math.floor((a1 - 1e-6) / RECT_CELL) !== cellA || Math.floor((b1 - 1e-6) / RECT_CELL) !== cellB) {
    return null;
  }
  // winding sign on the plane, so a merge never flips a face
  const e1 = [P[1][0] - P[0][0], P[1][1] - P[0][1]];
  const e2 = [P[2][0] - P[0][0], P[2][1] - P[0][1]];
  const sign = Math.sign(e1[0] * e2[1] - e1[1] * e2[0]);
  const key = [
    axis, q.c[0][axis], q.f, q.shade, sign, inset, cellA, cellB, ...mu, ...mv, q.own ? 1 : 0,
  ].join("|");
  return { key, aAx, bAx, a0, a1, b0, b1, mu, mv, inset };
}

/** Two passes of the strip merge: along a, then along b. Exact rectangles only. */
function mergeRects(list: Piece[]): Piece[][] {
  const pass = (groups: Piece[][], lo: "a0" | "b0", hi: "a1" | "b1", olo: "a0" | "b0", ohi: "a1" | "b1") => {
    const box = (g: Piece[]) => ({
      a0: Math.min(...g.map((p) => p.a0)),
      a1: Math.max(...g.map((p) => p.a1)),
      b0: Math.min(...g.map((p) => p.b0)),
      b1: Math.max(...g.map((p) => p.b1)),
    });
    const boxes = groups.map((g) => ({ g, ...box(g) }));
    boxes.sort((p, q) => p[olo] - q[olo] || p[ohi] - q[ohi] || p[lo] - q[lo]);
    const out: typeof boxes = [];
    for (const r of boxes) {
      const prev = out[out.length - 1];
      if (prev && prev[olo] === r[olo] && prev[ohi] === r[ohi] && prev[hi] === r[lo]) {
        prev.g = prev.g.concat(r.g);
        prev[hi] = r[hi];
      } else {
        out.push({ ...r });
      }
    }
    return out.map((b) => b.g);
  };
  let groups = list.map((p) => [p]);
  groups = pass(groups, "a0", "a1", "b0", "b1");
  groups = pass(groups, "b0", "b1", "a0", "a1");
  return groups;
}

export interface RectMergeStats {
  before: number;
  after: number;
}

/** Merge what can be merged without changing a texel; see the file header. */
export function mergeUvRects(quads: Quad[], stats?: RectMergeStats): Quad[] {
  type A = NonNullable<ReturnType<typeof analyse>>;
  const info: (A | null)[] = quads.map(analyse);
  const groups = new Map<string, Piece[]>();
  info.forEach((a, at) => {
    if (!a) return;
    let g = groups.get(a.key);
    if (!g) groups.set(a.key, (g = []));
    g.push({ at, a0: a.a0, a1: a.a1, b0: a.b0, b1: a.b1 });
  });
  // replacement quad for the first piece of each merged rect; null = dropped
  const replace = new Map<number, Quad | null>();
  for (const pieces of groups.values()) {
    if (pieces.length < 2) continue;
    for (const g of mergeRects(pieces)) {
      if (g.length < 2) continue;
      const first = Math.min(...g.map((p) => p.at));
      const t = quads[first];
      const a = info[first]!;
      const A0 = Math.min(...g.map((p) => p.a0));
      const A1 = Math.max(...g.map((p) => p.a1));
      const B0 = Math.min(...g.map((p) => p.b0));
      const B1 = Math.max(...g.map((p) => p.b1));
      // the template's corner pattern, stretched to the merged rect
      const c = t.c.map((corner) => {
        const next: [number, number, number] = [...corner];
        next[a.aAx] = corner[a.aAx] === a.a0 ? A0 : A1;
        next[a.bAx] = corner[a.bAx] === a.b0 ? B0 : B1;
        return next;
      });
      // uv from the shared map, re-inset toward the rect's interior
      const cu = (A0 + A1) / 2;
      const cv = (B0 + B1) / 2;
      const at = (m: [number, number, number], pa: number, pb: number) => m[0] * pa + m[1] * pb + m[2];
      const uc = at(a.mu, cu, cv);
      const vc = at(a.mv, cu, cv);
      const uv = c.map((corner) => {
        const pa = corner[a.aAx];
        const pb = corner[a.bAx];
        const u = at(a.mu, pa, pb);
        const v = at(a.mv, pa, pb);
        return [
          u + Math.sign(uc - u) * a.inset,
          v + Math.sign(vc - v) * a.inset,
        ] as [number, number];
      });
      replace.set(first, { ...t, c, uv });
      for (const p of g) if (p.at !== first) replace.set(p.at, null);
    }
  }
  const out: Quad[] = [];
  quads.forEach((q, i) => {
    if (!replace.has(i)) out.push(q);
    else {
      const r = replace.get(i);
      if (r) out.push(r);
    }
  });
  if (stats) {
    stats.before += quads.length;
    stats.after += out.length;
  }
  return out;
}
