// voxelmon/cook/g3ds/merge.ts — fewer quads for the same picture.
//
// MIT, ours (not from DramaticShapes). His hulls and per-pixel props emit a
// quad per exposed voxel face, each POINT-sampled (one texel stretched over
// the face): a 32px tree crown is ~2,900 quads, far past what the 3DS draws
// at frame rate. Two point-sampled faces in one plane, facing the same way,
// at the same shade, whose texels are the SAME COLOUR, draw identically when
// one texel stands for both -- so each plane's faces are rasterised to its
// unit grid, labelled by colour, and covered greedily with rectangles. Every
// pixel on screen keeps the colour it had; only the quad count changes.
// Texture-mapped faces (the drawing on a hull's front and back) and anything
// that is not an axis-aligned rectangle pass through untouched, in place.

import type { Quad } from "../geom.ts";

type Rgb = (u: number, v: number) => number;

interface Group {
  axis: number;
  plane: number;
  pattern: [boolean, boolean][];
  shade: number;
  f: Quad["f"];
  tree: boolean;
  cells: Map<string, { a: number; b: number; col: number; u: number; v: number }>;
}

const AXES: [number, number, number][] = [
  [0, 1, 2], // x-plane: a = y, b = z
  [1, 0, 2], // y-plane: a = x, b = z
  [2, 0, 1], // z-plane: a = x, b = y
];

/** Merge the point-sampled, flat-shaded, axis-aligned quads of `quads` by colour. */
export function mergePointQuads(quads: Quad[], colourAt: Rgb): Quad[] {
  const out: Quad[] = [];
  const groups = new Map<string, Group>();
  const order: (Quad | Group)[] = [];
  for (const q of quads) {
    if (q.uv || typeof q.shade !== "number" || q.abgr !== undefined || q.abgrs || q.w) {
      order.push(q);
      continue;
    }
    let axis = -1;
    for (let i = 0; i < 3; i++) {
      const [p] = AXES[i]!;
      if (q.c.every((c) => c[p] === q.c[0]![p])) {
        axis = i;
        break;
      }
    }
    if (axis < 0) {
      order.push(q);
      continue;
    }
    const [p, ia, ib] = AXES[axis]!;
    const as = q.c.map((c) => c[ia]!);
    const bs = q.c.map((c) => c[ib]!);
    const a0 = Math.min(...as);
    const a1 = Math.max(...as);
    const b0 = Math.min(...bs);
    const b1 = Math.max(...bs);
    // a rectangle: every corner on a min/max of both axes, all four distinct
    const pattern = q.c.map((c) => [c[ia] === a1, c[ib] === b1] as [boolean, boolean]);
    const corners = new Set(pattern.map(([x, y]) => `${x}${y}`));
    if (corners.size !== 4 || !q.c.every((c) => (c[ia] === a0 || c[ia] === a1) && (c[ib] === b0 || c[ib] === b1))) {
      order.push(q);
      continue;
    }
    if (![a0, a1, b0, b1].every(Number.isInteger)) {
      order.push(q);
      continue;
    }
    const key = `${axis}|${q.c[0]![p]}|${pattern.map(([x, y]) => `${+x}${+y}`).join("")}|${q.shade}|${q.f}|${q.tree ? 1 : 0}`;
    let g = groups.get(key);
    if (!g) {
      g = { axis, plane: q.c[0]![p]!, pattern, shade: q.shade, f: q.f, tree: !!q.tree, cells: new Map() };
      groups.set(key, g);
      order.push(g);
    }
    const col = colourAt(q.u ?? 0, q.v ?? 0);
    for (let a = a0; a < a1; a++) for (let b = b0; b < b1; b++) g.cells.set(`${a},${b}`, { a, b, col, u: q.u ?? 0, v: q.v ?? 0 });
  }
  for (const item of order) {
    if (!("cells" in item)) {
      out.push(item);
      continue;
    }
    const g = item;
    const [p, ia, ib] = AXES[g.axis]!;
    const cells = [...g.cells.values()].sort((x, y) => x.b - y.b || x.a - y.a);
    const done = new Set<string>();
    for (const c of cells) {
      const k0 = `${c.a},${c.b}`;
      if (done.has(k0)) continue;
      let a1 = c.a + 1;
      while (true) {
        const n = g.cells.get(`${a1},${c.b}`);
        if (!n || n.col !== c.col || done.has(`${a1},${c.b}`)) break;
        a1++;
      }
      let b1 = c.b + 1;
      grow: while (true) {
        for (let a = c.a; a < a1; a++) {
          const n = g.cells.get(`${a},${b1}`);
          if (!n || n.col !== c.col || done.has(`${a},${b1}`)) break grow;
        }
        b1++;
      }
      for (let a = c.a; a < a1; a++) for (let b = c.b; b < b1; b++) done.add(`${a},${b}`);
      const corner = ([hiA, hiB]: [boolean, boolean]): [number, number, number] => {
        const v: [number, number, number] = [0, 0, 0];
        v[p] = g.plane;
        v[ia] = hiA ? a1 : c.a;
        v[ib] = hiB ? b1 : c.b;
        return v;
      };
      const q: Quad = { c: g.pattern.map(corner), u: c.u, v: c.v, shade: g.shade, f: g.f };
      if (g.tree) q.tree = true;
      out.push(q);
    }
  }
  return out;
}
