// voxelmon/cook/g3ds/hull.ts — round scenery: a drawing turned into a solid
// of revolution (trees, bushes, boulders).
//
// MIT. Ported from UNDERdecoded/Gen2Recomped-DramaticShapes (MIT, Copyright
// (c) 2026 DramaticShape, modified by UNDERdecodedHD; THIRD_PARTY_NOTICES.md)
// at 726782f, lib/Structures.lua:13139 roundTemplate -- its Gen 3 arm: the
// mask is the shape surface's own alpha (flooded in from the canvas border
// through clear texels), a crown clipped by its cell is domed over its top
// radius, each mask row revolves into discs, rows under the drawing repeat
// its bottom row to the floor, and the exposed voxel faces are emitted with
// the drawing on the front and back and the de-outlined material on the
// sides. The can / stump / planter / taper / well arms (interior props) are
// not ported; nothing in this cook asks for them.
//
// `step` (ours, as cook/trees.ts has it for the Gen 1/2 trees) carves the
// same drawing at step x step art px per voxel for the middle level of
// detail; step 1 is his carve.

import { FACE, type Quad } from "../geom.ts";

/** Structures.lua:13032 ROUND_SHADE */
const SHADE = { front: 1.0, back: 0.68, side: 0.78, top: 1.0, bottom: 0.55 };

/** Structures.lua:24664 shadeClass, on a 0..1 channel minimum. */
function shadeClass(v: number): "black" | "dark" | "light" | "white" {
  if (v <= 0.25) return "black";
  if (v <= 0.55) return "dark";
  if (v <= 0.85) return "light";
  return "white";
}

export interface Canvas {
  /** Canvas size in art px; NX wide (and deep), NY tall. */
  NX: number;
  NY: number;
  /** Is the art texel at (px, py) part of a drawn object (shape surface alpha)? */
  opaque(px: number, py: number): boolean;
  /** Its composite colour, 0..255. */
  rgb(px: number, py: number): [number, number, number];
  /** Its page px (top-left of the texel). */
  uv(px: number, py: number): [number, number];
}

export interface HullOut {
  quads: Quad[];
  /** Index into `groundCandidates` of the floor the drawing stands on, or -1. */
  ground: number;
}

/**
 * roundTemplate's Gen 3 arm. `groundCandidates` are the flat ground drawings
 * the map places, each as a texel colour lookup over 16x16 (the drawing's own
 * background picks its floor). Geometry is in canvas-local px: x and z
 * centred on the canvas, y from 0 at the foot.
 */
export function roundHull(
  cv: Canvas,
  step = 1,
  groundCandidates: ((x: number, y: number) => [number, number, number])[] = [],
  blueBg = false,
): HullOut {
  const NXa = cv.NX;
  const NYa = cv.NY;
  const NX = NXa / step;
  const NY = NYa / step;
  const N2 = NX / 2;
  // WATER IS BACKGROUND FOR A ROCK STANDING IN IT (Structures.lua:13175):
  // the ripple is bluer than the rock, and the wave highlights paler
  const art1 = (px: number, py: number): boolean => {
    if (!cv.opaque(px, py)) return false;
    if (!blueBg) return true;
    const [r, g, b] = cv.rgb(px, py).map((c) => c / 255) as [number, number, number];
    const d1 = b - Math.max(r, g);
    const lo = Math.min(r, g, b);
    return !(d1 > 0.15 || (lo > 0.62 && d1 > 0.04));
  };
  // a canvas voxel is a step x step art block: opaque when most of it is
  const opaqueV = (px: number, py: number): boolean => {
    if (step === 1) return art1(px, py);
    let n = 0;
    for (let dy = 0; dy < step; dy++) for (let dx = 0; dx < step; dx++) if (art1(px * step + dx, py * step + dy)) n++;
    return n * 2 >= step * step;
  };
  const rgbV = (px: number, py: number) => cv.rgb(px * step + (step >> 1), py * step + (step >> 1));
  const cls: (string)[] = new Array(NX * NY);
  for (let py = 0; py < NY; py++) {
    for (let px = 0; px < NX; px++) {
      if (!opaqueV(px, py)) cls[py * NX + px] = "off";
      else {
        const [r, g, b] = rgbV(px, py);
        cls[py * NX + px] = shadeClass(Math.min(r, g, b) / 255);
      }
    }
  }
  // GEN 3 STATES ITS OWN SILHOUETTE: flood from the band's border through
  // clear texels only, per cell band of NX rows
  const mask: boolean[] = new Array(NX * NY).fill(false);
  for (let band = 0; band < NY / NX; band++) {
    const y0 = band * NX;
    const y1 = band * NX + NX - 1;
    const out = new Uint8Array(NX * NY);
    const stack: number[] = [];
    const seed = (i: number) => {
      if (!out[i] && cls[i] === "off") {
        out[i] = 1;
        stack.push(i);
      }
    };
    for (let px = 0; px < NX; px++) {
      seed(y0 * NX + px);
      seed(y1 * NX + px);
    }
    for (let py = y0; py <= y1; py++) {
      seed(py * NX);
      seed(py * NX + NX - 1);
    }
    while (stack.length) {
      const i = stack.pop()!;
      const px = i % NX;
      const py = Math.floor(i / NX);
      if (px > 0) seed(i - 1);
      if (px < NX - 1) seed(i + 1);
      if (py > y0) seed(i - NX);
      if (py < y1) seed(i + NX);
    }
    for (let i = y0 * NX; i < (y1 + 1) * NX; i++) mask[i] = !out[i] && cls[i] !== "off";
  }
  if (!mask.some(Boolean)) return { quads: [], ground: -1 };

  // CLOSE THE TOP OF A CLIPPED CROWN: a radius-deep quarter-ellipse dome
  const rowSpan = (iy: number): [number, number] | null => {
    let lo = -1;
    let hi = -1;
    for (let ix = 0; ix < NX; ix++) {
      if (mask[iy * NX + ix]) {
        if (lo < 0) lo = ix;
        hi = ix;
      }
    }
    return lo < 0 ? null : [lo, hi];
  };
  {
    let top = -1;
    for (let iy = 0; iy < NY; iy++) {
      if (rowSpan(iy)) {
        top = iy;
        break;
      }
    }
    let widest = 0;
    for (let iy = 0; iy < NY; iy++) {
      const s = rowSpan(iy);
      if (s && s[1] - s[0] + 1 > widest) widest = s[1] - s[0] + 1;
    }
    const s0 = top >= 0 ? rowSpan(top) : null;
    const w0 = s0 ? s0[1] - s0[0] + 1 : 0;
    if (top >= 0 && widest > 0 && w0 > widest * 0.34) {
      const DOME = Math.max(4 / step, Math.floor(widest / 2));
      for (let k = 0; k < DOME; k++) {
        const iy = top + k;
        if (iy >= NY) break;
        const s = rowSpan(iy);
        if (!s) continue;
        const [lo, hi] = s;
        const t = (k + 1) / DOME;
        const keep = Math.sqrt(1 - (1 - t) * (1 - t));
        const mid = (lo + hi) / 2;
        const half = ((hi - lo + 1) * keep) / 2;
        for (let ix = lo; ix <= hi; ix++) if (Math.abs(ix + 0.5 - (mid + 0.5)) > half) mask[iy * NX + ix] = false;
      }
    }
  }

  // the ground the ball stands on: the drawing's own background names it
  let ground = -1;
  if (groundCandidates.length > 0) {
    let bestScore = Infinity;
    groundCandidates.forEach((g, gi) => {
      let score = 0;
      let n = 0;
      for (let py = 0; py < NY; py++) {
        for (let px = 0; px < NX; px++) {
          const i = py * NX + px;
          const c = cls[i];
          if (mask[i] || !(c === "light" || c === "white")) continue;
          const [r1, g1, b1] = rgbV(px, py);
          const [r2, g2, b2] = g((px * step) % 16, (py * step) % 16);
          score += (r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2;
          n++;
        }
      }
      if (n > 0 && score / n < bestScore) {
        bestScore = score / n;
        ground = gi;
      }
    });
  }

  // discs: per mask pixel a z chord [z0, z1)
  const z0 = new Int16Array(NX * NY).fill(-1);
  const z1 = new Int16Array(NX * NY).fill(-1);
  const src = new Int16Array(NX * NY).fill(-1);
  const loRow = new Int16Array(NY).fill(-1);
  const hiRow = new Int16Array(NY).fill(-1);
  let yBot = -1;
  for (let iy = 0; iy < NY; iy++) {
    const s = rowSpan(iy);
    if (!s) continue;
    const [lo, hi] = s;
    loRow[iy] = lo;
    hiRow[iy] = hi;
    yBot = iy;
    const c = (lo + hi + 1) / 2;
    const hw = (hi - lo + 1) / 2;
    for (let ix = lo; ix <= hi; ix++) {
      const i = iy * NX + ix;
      if (!mask[i]) continue;
      const dx = ix + 0.5 - c;
      let n = 1;
      if (hw * hw > dx * dx) n = Math.max(1, Math.floor(2 * Math.sqrt(hw * hw - dx * dx) + 0.5));
      z0[i] = Math.floor(N2 - n / 2 + 0.5);
      z1[i] = z0[i] + n;
      src[i] = iy;
    }
  }
  // foot: rows under the mask repeat the bottom row's discs and pixels
  for (let iy = yBot + 1; iy < NY; iy++) {
    loRow[iy] = loRow[yBot]!;
    hiRow[iy] = hiRow[yBot]!;
    for (let ix = loRow[yBot]!; ix <= hiRow[yBot]!; ix++) {
      const b = yBot * NX + ix;
      if (z0[b]! < 0) continue;
      const i = iy * NX + ix;
      z0[i] = z0[b]!;
      z1[i] = z1[b]!;
      src[i] = yBot;
    }
  }
  const solidAt = (ix: number, iy: number, iz: number) => {
    if (ix < 0 || ix > NX - 1 || iy < 0 || iy > NY - 1) return false;
    const i = iy * NX + ix;
    return z0[i]! >= 0 && iz >= z0[i]! && iz < z1[i]!;
  };
  // texel (art px) of canvas voxel (ix, row): the block's top-left
  const texel = (ix: number, row: number) => cv.uv(ix * step, row * step);
  const pointUv = (ix: number, row: number): [number, number] => {
    const [u, v] = cv.uv(ix * step + (step >> 1), row * step + (step >> 1));
    return [u + 0.5, v + 0.5];
  };
  // cap interiors sample the canopy a couple of rows below the rim, skipping
  // outline-dark pixels
  const deepTexel = (ix: number, iy: number): [number, number] => {
    for (let iy2 = iy + 2; iy2 <= Math.min(NY - 1, iy + 4); iy2++) {
      const i = iy2 * NX + ix;
      if (mask[i] && cls[i] !== "black") return pointUv(ix, iy2);
    }
    return pointUv(ix, iy);
  };
  // side walls read as material, not outline: walk inward past black pixels
  const sideTexel = (ix: number, iy: number): [number, number] => {
    const r = yBot >= 0 && iy > yBot ? yBot : src[iy * NX + ix]!;
    const dir = ix + ix < loRow[iy]! + hiRow[iy]! ? 1 : -1;
    for (let s = 0; s <= 3; s++) {
      const x2 = ix + dir * s;
      const i2 = r * NX + x2;
      if (x2 < 0 || x2 > NX - 1 || !mask[i2]) break;
      if (cls[i2] !== "black") return pointUv(x2, r);
    }
    return pointUv(ix, r);
  };

  const quads: Quad[] = [];
  const point = (c: [number, number, number][], uv: [number, number], shade: number, f: Quad["f"]) =>
    quads.push({ c, u: uv[0], v: uv[1], shade, f });
  for (let iy = 0; iy < NY; iy++) {
    if (loRow[iy]! < 0) continue;
    const yB = NY - 1 - iy;
    const yT = NY - iy;
    // front and back: the drawing, columns merged where they share a chord
    // plane; a run never crosses the 8px art seam (one tile's u range)
    let ix = loRow[iy]!;
    while (ix <= hiRow[iy]!) {
      const i = iy * NX + ix;
      if (z0[i]! < 0) {
        ix++;
        continue;
      }
      let ix2 = ix;
      while (ix2 + 1 <= hiRow[iy]!) {
        const j = iy * NX + ix2 + 1;
        if (z0[j] === z0[i] && z1[j] === z1[i] && src[j] === src[i] && Math.floor(((ix2 + 1) * step) / 8) === Math.floor((ix * step) / 8)) ix2++;
        else break;
      }
      const x0 = ix - N2;
      const x1 = ix2 - N2 + 1;
      const row = src[i]!;
      const [ax0, ay] = texel(ix, row);
      const [ax1] = texel(ix2, row);
      const u0 = ax0 + 0.05;
      const u1 = ax1 + step - 1 + 0.95;
      const v0 = ay + 0.05;
      const v1 = ay + step - 1 + 0.95;
      const zF = z1[i]! - N2;
      const zB = z0[i]! - N2;
      quads.push({ c: [[x0, yB, zF], [x1, yB, zF], [x1, yT, zF], [x0, yT, zF]], uv: [[u0, v1], [u1, v1], [u1, v0], [u0, v0]], shade: SHADE.front, f: FACE.south });
      quads.push({ c: [[x1, yB, zB], [x0, yB, zB], [x0, yT, zB], [x1, yT, zB]], uv: [[u1, v1], [u0, v1], [u0, v0], [u1, v0]], shade: SHADE.back, f: FACE.north });
      ix = ix2 + 1;
    }
    // sides, steps, undersides: constant-texel quads over the z runs a
    // neighbour does not cover
    for (let ix = loRow[iy]!; ix <= hiRow[iy]!; ix++) {
      const i = iy * NX + ix;
      if (z0[i]! < 0) continue;
      const uvc = pointUv(ix, src[i]!);
      const x0 = ix - N2;
      const x1 = ix - N2 + 1;
      const pieces = (nx: number, ny: number, emit: (zA: number, zB: number, izA: number, izB: number) => void) => {
        let iz = z0[i]!;
        while (iz < z1[i]!) {
          if (!solidAt(nx, ny, iz)) {
            let iz2 = iz;
            while (iz2 + 1 < z1[i]! && !solidAt(nx, ny, iz2 + 1)) iz2++;
            emit(iz - N2, iz2 - N2 + 1, iz, iz2);
            iz = iz2 + 1;
          } else iz++;
        }
      };
      const side = sideTexel(ix, iy);
      // (ours) at step > 1 a face spans a block of the drawing, so instead of
      // one texel for the block it wears the texels his step-1 faces would:
      // a top or an underside the block's art columns across x (constant in
      // z, as his are), a side the block's art rows down y (one column)
      const textured = step > 1;
      const sideQ = (c: [number, number, number][], f: Quad["f"]) => {
        if (!textured) return point(c, side, SHADE.side, f);
        // pointUv is the block's middle texel plus half a texel
        const u = side[0];
        const top = side[1] - 0.5 - (step >> 1);
        const v0 = top + 0.05;
        const v1 = top + step - 0.05;
        // corners: bottom, bottom, top, top
        quads.push({ c, uv: [[u, v1], [u, v1], [u, v0], [u, v0]], shade: SHADE.side, f });
      };
      const flatQ = (c: [number, number, number][], uvp: [number, number], shade: number, f: Quad["f"]) => {
        if (!textured) return point(c, uvp, shade, f);
        // the block holding the point texel (pointUv: its middle texel plus
        // half a texel), its columns across x
        const ax = uvp[0] - 0.5 - (step >> 1);
        const v = uvp[1];
        const uA = ax + 0.05;
        const uB = ax + step - 0.05;
        const uv = c.map(([x]) => [x === x0 ? uA : uB, v] as [number, number]);
        quads.push({ c, uv, shade, f });
      };
      pieces(ix - 1, iy, (zA, zB) => sideQ([[x0, yB, zA], [x0, yB, zB], [x0, yT, zB], [x0, yT, zA]], FACE.west));
      pieces(ix + 1, iy, (zA, zB) => sideQ([[x1, yB, zB], [x1, yB, zA], [x1, yT, zA], [x1, yT, zB]], FACE.east));
      pieces(ix, iy - 1, (zA, zB, izA, izB) => {
        const top = (za: number, zb: number, uv: [number, number]) =>
          flatQ([[x0, yT, za], [x1, yT, za], [x1, yT, zb], [x0, yT, zb]], uv, SHADE.top, FACE.up);
        if (izA === z0[i] && izB === z1[i]! - 1 && izB - izA >= 2) {
          // the dome cap: outline on the rim cells, canopy inside
          top(zA, zA + 1, uvc);
          top(zA + 1, zB - 1, deepTexel(ix, iy));
          top(zB - 1, zB, uvc);
        } else top(zA, zB, uvc);
      });
      if (iy < NY - 1) {
        pieces(ix, iy + 1, (zA, zB) => flatQ([[x0, yB, zB], [x1, yB, zB], [x1, yB, zA], [x0, yB, zA]], uvc, SHADE.bottom, FACE.down));
      }
    }
  }
  if (step !== 1) for (const q of quads) q.c = q.c.map(([x, y, z]) => [x * step, y * step, z * step]) as [number, number, number][];
  return { quads, ground };
}
