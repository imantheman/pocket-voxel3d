// Port of gen1recomp src/import/gba/quantize_lab.lua (GPLv3 + additional terms; see LICENSE.md).
// Interior demake (top-down):
//   1) Discover room-wide 4-shade ramps per FRLG palSlot (material codebook)
//   2) Assign each 8x8 quad to the best codebook ramp (majority-pal bias)
//   3) Bake 2bpp against that fixed ramp only
// Outdoor extract keeps BT.709 path in quantize.lua; this module is indoor-only.
//
// Shapes (as quantize.ts): the Lua's 1-based sequences are 0-based JS arrays
// -- buf64 / pal64 / shades / 2bpp bytes, a ramp's shades ramp[0..3], the
// codebook, entry lists. Indices and slot numbers this module RETURNS keep
// their Lua (1-based) values: bestCodebookIndex, resolveQuadRamp's index,
// primaryCodebookForCategory, majorityPalSlot, and mergeRampsToBudget's
// oldToSlot (oldToSlot[i - 1] = slot of entries[i - 1]).
// Floating point follows the Lua operation for operation; `x ^ 2` is x * x
// (LuaJIT's lj_vm_powi), other powers Math.pow (libm pow, as LuaJIT).
// Every table.sort goes through luaSort (LuaJIT's quicksort): the centroid
// sort's comparator is not a strict weak order.

import { luaSort } from "./luasort.ts";
import { format, mod, tostring } from "./lua.ts";

export type Rgb = number[];
export type Ramp = Rgb[];
export interface Lab { L: number; a: number; b: number; [k: string]: unknown }
export interface LabPixel extends Lab {
  r?: number; g?: number; idx?: number; key?: number | string; palSlot?: number; n?: number;
}
export interface CodebookEntry {
  ramp: Ramp;
  lab?: Lab[];
  frlgSlot?: number;
  pair?: string;
  slot?: number;
  categories?: Record<string, number>;
  primaryCategory?: string;
  [k: string]: unknown;
}
export interface MaterialEntry {
  ramp: Ramp;
  count: number;
  locked: boolean;
  frlgSlot: number;
  pair: string;
  categories?: Record<string, number>;
  primaryCategory?: string;
}
export interface QuadInput { buf?: number[]; pal?: number[]; pair?: string; category?: string }
export interface AssignOpts {
  preferFrlgSlot?: number;
  frlgBias?: number;
  preferRamp?: Ramp;
  rampBias?: number;
  requireCategory?: string;
  categoryBias?: number;
  itemCategory?: string;
  crossCatPenalty?: number;
}

const hasOwn = Object.prototype.hasOwnProperty;
const sq = (x: number): number => x * x;

// Lua: quantize_lab.lua:38
function bgr555_to_rgb(c: number | undefined): [number, number, number] {
  c = c ?? 0;
  const r5 = mod(c, 32);
  const g5 = mod(Math.floor(c / 32), 32);
  const b5 = mod(Math.floor(c / 1024), 32);
  return [r5 * 255 / 31, g5 * 255 / 31, b5 * 255 / 31];
}

// Lua: quantize_lab.lua:47 -- sRGB 0..255 -> XYZ (D65) -> CIE L*a*b*
function rgb_to_lab(r: number, g: number, b: number): [number, number, number] {
  const lin = (u: number): number => {
    u = u / 255;
    if (u <= 0.04045) return u / 12.92;
    return Math.pow((u + 0.055) / 1.055, 2.4);
  };
  const R = lin(r), G = lin(g), B = lin(b);
  let x = R * 0.4124564 + G * 0.3575761 + B * 0.1804375;
  let y = R * 0.2126729 + G * 0.7151522 + B * 0.0721750;
  let z = R * 0.0193339 + G * 0.1191920 + B * 0.9503041;
  // D65 white
  x = x / 0.95047; y = y / 1.0; z = z / 1.08883;
  const f = (t: number): number => {
    if (t > 0.008856) return Math.pow(t, 1 / 3);
    return (7.787 * t) + (16 / 116);
  };
  const fx = f(x), fy = f(y), fz = f(z);
  const L = (116 * fy) - 16;
  const a = 500 * (fx - fy);
  const bb = 200 * (fy - fz);
  return [L, a, bb];
}

// Lua: quantize_lab.lua:70
function lab_to_rgb(L: number, a: number, bb: number): [number, number, number] {
  const fy = (L + 16) / 116;
  const fx = a / 500 + fy;
  const fz = fy - bb / 200;
  const finv = (t: number): number => {
    const t3 = t * t * t;
    if (t3 > 0.008856) return t3;
    return (t - 16 / 116) / 7.787;
  };
  const x = 0.95047 * finv(fx);
  const y = 1.0 * finv(fy);
  const z = 1.08883 * finv(fz);
  const R = x * 3.2404542 + y * -1.5371385 + z * -0.4985314;
  const G = x * -0.9692660 + y * 1.8760108 + z * 0.0415560;
  const B = x * 0.0556434 + y * -0.2040259 + z * 1.0572252;
  const gamma = (u: number): number => {
    if (u <= 0.0031308) return 12.92 * u;
    return 1.055 * Math.pow(u, 1 / 2.4) - 0.055;
  };
  const clamp8 = (u: number): number => {
    u = gamma(u) * 255;
    if (u < 0) return 0;
    if (u > 255) return 255;
    return Math.floor(u + 0.5);
  };
  return [clamp8(R), clamp8(G), clamp8(B)];
}

// Lua: quantize_lab.lua:98
function chroma(a: number, b: number): number {
  return Math.sqrt(a * a + b * b);
}

// Lua: quantize_lab.lua:103 -- Cosine vs fixed red reference (a=1, b=0); range [-1, 1].
function red_ref_cos(a: number, b: number): number {
  const c = chroma(a, b);
  if (c < 1e-6) return 0;
  return a / c;
}

// Lua: quantize_lab.lua:117
function deltaE_w_lab(p: Lab, q: Lab, wL?: number): number {
  return QuantizeLab.deltaE_w(p.L, p.a, p.b, q.L, q.a, q.b, wL);
}

// Lua: quantize_lab.lua:121
function rgb_of_lab(p: Lab): Rgb {
  const [r, g, b] = lab_to_rgb(p.L, p.a, p.b);
  return [r, g, b];
}

// Lua: quantize_lab.lua:126
function copy_lab(p: Lab): LabPixel {
  return { L: p.L, a: p.a, b: p.b };
}

// Lua: quantize_lab.lua:130
function sort_centroids_light_to_dark<T extends Lab>(cents: T[]): void {
  luaSort(cents, (u, v) => {
    const dL = u.L - v.L;
    if (Math.abs(dL) >= QuantizeLab.L_TIE) {
      return u.L > v.L; // lightest first -> shade 0
    }
    const cu = red_ref_cos(u.a, u.b), cv = red_ref_cos(v.a, v.b);
    if (Math.abs(cu - cv) > 1e-9) return cu > cv;
    return chroma(u.a, u.b) > chroma(v.a, v.b);
  });
}

// Lua: quantize_lab.lua:144
function encode_2bpp(shades: number[]): number[] {
  const out: number[] = [];
  for (let y = 0; y < 8; y++) {
    let low = 0, high = 0;
    for (let x = 0; x < 8; x++) {
      const shade = shades[y * 8 + x] ?? 0;
      const bit = 7 - x;
      const mask = 2 ** bit;
      if (mod(shade, 2) === 1) low = low + mask;
      if (mod(Math.floor(shade / 2), 2) === 1) high = high + mask;
    }
    out[y * 2] = low;
    out[y * 2 + 1] = high;
  }
  return out;
}

/**
 * Lua: quantize_lab.lua:163 -- Pad unique colours (sorted light->dark) into DMG
 * slots 0=lightest ... 3=darkest. Interpolate internal slots.
 */
function pad_unique_to_ramp(sorted: Lab[]): Lab[] {
  const n = sorted.length;
  if (n === 0) {
    const g = { L: 50, a: 0, b: 0 };
    return [g, g, g, g];
  } else if (n === 1) {
    const c = sorted[0]!;
    return [c, c, c, c];
  } else if (n === 2) {
    const c1 = sorted[0]!, c4 = sorted[1]!;
    const c2 = { L: c1.L * 0.66 + c4.L * 0.34, a: c1.a * 0.66 + c4.a * 0.34, b: c1.b * 0.66 + c4.b * 0.34 };
    const c3 = { L: c1.L * 0.34 + c4.L * 0.66, a: c1.a * 0.34 + c4.a * 0.66, b: c1.b * 0.34 + c4.b * 0.66 };
    return [c1, c2, c3, c4];
  } else if (n === 3) {
    const c1 = sorted[0]!, c2 = sorted[1]!, c4 = sorted[2]!;
    const c3 = { L: (c2.L + c4.L) / 2, a: (c2.a + c4.a) / 2, b: (c2.b + c4.b) / 2 };
    return [c1, c2, c3, c4];
  }
  return [sorted[0]!, sorted[1]!, sorted[2]!, sorted[3]!];
}

// Lua: quantize_lab.lua:197 -- [pixels, uniques]
function gather_pixels(buf64: number[], pal64?: number[]): [LabPixel[], LabPixel[]] {
  const pixels: LabPixel[] = [];
  const byKey = new Map<number, LabPixel>();
  const order: number[] = [];
  for (let i = 0; i < 64; i++) {
    const c = buf64[i] ?? 0;
    const [r, g, b] = bgr555_to_rgb(c);
    const [L, a, bb] = rgb_to_lab(r, g, b);
    const palSlot = (pal64 && pal64[i]) ?? 0;
    const p: LabPixel = { L, a, b: bb, r, g, idx: i + 1, key: c, palSlot };
    pixels[i] = p;
    if (!byKey.has(c)) {
      byKey.set(c, { L, a, b: bb, r, g, key: c, n: 0, palSlot });
      order.push(c);
    }
    const u = byKey.get(c)!;
    u.n = u.n! + 1;
  }
  const uniques: LabPixel[] = [];
  for (const k of order) uniques.push(byKey.get(k)!);
  return [pixels, uniques];
}

// Lua: quantize_lab.lua:221 -- [groups (palSlot -> pixels), order]
function group_by_palslot(pixels: LabPixel[]): [Map<number, LabPixel[]>, number[]] {
  const groups = new Map<number, LabPixel[]>();
  const order: number[] = [];
  for (let i = 0; i < pixels.length; i++) {
    const p = pixels[i]!;
    const s = p.palSlot ?? 0;
    if (!groups.has(s)) {
      groups.set(s, []);
      order.push(s);
    }
    groups.get(s)!.push(p);
  }
  luaSort(order, (a, b) => {
    const na = groups.get(a)!.length, nb = groups.get(b)!.length;
    if (na !== nb) return na > nb;
    return a < b;
  });
  return [groups, order];
}

// Lua: quantize_lab.lua:240
function mean_lab(list: Lab[]): Lab {
  let L = 0, a = 0, b = 0;
  const n = list.length;
  if (n === 0) return { L: 50, a: 0, b: 0 };
  for (let i = 0; i < n; i++) {
    L = L + list[i]!.L;
    a = a + list[i]!.a;
    b = b + list[i]!.b;
  }
  return { L: L / n, a: a / n, b: b / n };
}

// Lua: quantize_lab.lua:252 -- dE_eff: additive palSlot penalty (not multiplicative).
function deltaE_eff(p: LabPixel, cent: LabPixel): number {
  let d = deltaE_w_lab(p, cent);
  if ((p.palSlot ?? 0) !== (cent.palSlot ?? 0)) d = d + QuantizeLab.PALSLOT_ADD;
  return d;
}

// Lua: quantize_lab.lua:260 -- [index (0-based here), distance]
function nearest_centroid(p: LabPixel, cents: LabPixel[]): [number, number] {
  let best = 0, bestD = 1e18;
  for (let i = 0; i < cents.length; i++) {
    const d = deltaE_eff(p, cents[i]!);
    if (d < bestD) { best = i; bestD = d; }
  }
  return [best, bestD];
}

/**
 * Lua: quantize_lab.lua:271 -- Structural outlier: baseline = mean LAB of
 * majority-count palSlot only. Returns locked centroid (with immutable
 * palSlot) or undefined.
 */
function structural_outlier(pixels: LabPixel[]): LabPixel | undefined {
  const [groups, order] = group_by_palslot(pixels);
  if (order.length === 0) return undefined;
  const bgSlot = order[0]!;
  const baseline = mean_lab(groups.get(bgSlot)!);
  let best: LabPixel | undefined, bestD = -1;
  if (order.length === 1) {
    for (let i = 0; i < pixels.length; i++) {
      const p = pixels[i]!;
      const d = deltaE_w_lab(p, baseline);
      if (d > bestD) { bestD = d; best = p; }
    }
  } else {
    for (let i = 0; i < pixels.length; i++) {
      const p = pixels[i]!;
      if ((p.palSlot ?? 0) !== bgSlot) {
        const d = deltaE_w_lab(p, baseline);
        if (d > bestD) { bestD = d; best = p; }
      }
    }
  }
  if (!best || bestD < QuantizeLab.OUTLIER_DE_MIN) return undefined;
  const c = copy_lab(best);
  c.palSlot = best.palSlot ?? 0;
  return c;
}

/**
 * Lua: quantize_lab.lua:303 -- Seed k centroids with immutable palSlot from the
 * seed pixel (pure perceptual farthest-point).
 */
function seed_centroids(pixels: LabPixel[], k: number, locked?: LabPixel[]): LabPixel[] {
  const cents: LabPixel[] = [];
  if (locked) {
    for (let i = 0; i < locked.length; i++) {
      const c = copy_lab(locked[i]!);
      c.palSlot = locked[i]!.palSlot ?? 0;
      cents.push(c);
    }
  }
  while (cents.length < k) {
    let bestI = 0, bestD = -1;
    for (let i = 0; i < pixels.length; i++) {
      const p = pixels[i]!;
      let dmin = 1e18;
      if (cents.length === 0) {
        dmin = 1;
      } else {
        for (let j = 0; j < cents.length; j++) {
          // Perceptual only; assignment phase still uses deltaE_eff (+50 palSlot).
          const d = deltaE_w_lab(p, cents[j]!);
          if (d < dmin) dmin = d;
        }
      }
      if (dmin > bestD) { bestD = dmin; bestI = i; }
    }
    const c = copy_lab(pixels[bestI]!);
    c.palSlot = pixels[bestI]!.palSlot ?? 0;
    cents.push(c);
  }
  return cents;
}

// Lua: quantize_lab.lua:335
function kmeans(pixels: LabPixel[], k: number, locked?: LabPixel[]): LabPixel[] {
  const cents = seed_centroids(pixels, k, locked);
  const lockedN = locked ? locked.length : 0;
  // palSlot on every centroid is immutable from here on.
  for (let it = 0; it < QuantizeLab.KMEANS_ITERS; it++) {
    const sums: { L: number; a: number; b: number; w: number }[] = [];
    for (let i = 0; i < k; i++) sums[i] = { L: 0, a: 0, b: 0, w: 0 };
    for (let i = 0; i < pixels.length; i++) {
      const p = pixels[i]!;
      const [ci] = nearest_centroid(p, cents);
      const w = (p.n ?? 1) * (1 + chroma(p.a, p.b) / 40);
      const s = sums[ci]!;
      s.L = s.L + p.L * w;
      s.a = s.a + p.a * w;
      s.b = s.b + p.b * w;
      s.w = s.w + w;
    }
    for (let i = lockedN; i < k; i++) {
      if (sums[i]!.w > 0) {
        // Update LAB only; keep cents[i].palSlot unchanged.
        cents[i]!.L = sums[i]!.L / sums[i]!.w;
        cents[i]!.a = sums[i]!.a / sums[i]!.w;
        cents[i]!.b = sums[i]!.b / sums[i]!.w;
      }
    }
  }
  return cents;
}

// Lua: quantize_lab.lua:365
function assign_shades(pixels: LabPixel[], cents: LabPixel[]): number[] {
  const shades: number[] = [];
  for (let i = 0; i < pixels.length; i++) {
    const [ci] = nearest_centroid(pixels[i]!, cents);
    shades[i] = ci; // 0..3 light->dark (the Lua's ci - 1)
  }
  return shades;
}

// Lua: quantize_lab.lua:374
function ramp_from_cents(cents: Lab[]): Ramp {
  const ramp: Ramp = [];
  for (let i = 0; i < 4; i++) ramp[i] = rgb_of_lab(cents[i]!);
  return ramp;
}

/**
 * Lua: quantize_lab.lua:384 -- Unique <= 4: map by L* rank into slots
 * 0=lightest ... 3=darkest with extreme padding.
 */
function bypass_unique(pixels: LabPixel[], uniques: LabPixel[]): [number[], Ramp, number[]] {
  sort_centroids_light_to_dark(uniques);
  const n = uniques.length;
  const keyToShade = new Map<unknown, number>();
  if (n === 1) {
    keyToShade.set(uniques[0]!.key, 0);
  } else if (n === 2) {
    keyToShade.set(uniques[0]!.key, 0); // lightest
    keyToShade.set(uniques[1]!.key, 3); // darkest (never slot 1)
  } else if (n === 3) {
    keyToShade.set(uniques[0]!.key, 0);
    keyToShade.set(uniques[1]!.key, 1);
    keyToShade.set(uniques[2]!.key, 3);
  } else {
    for (let i = 0; i < 4; i++) keyToShade.set(uniques[i]!.key, i);
  }
  const shades: number[] = [];
  for (let i = 0; i < pixels.length; i++) shades[i] = keyToShade.get(pixels[i]!.key) ?? 0;
  const padded = pad_unique_to_ramp(uniques);
  return [encode_2bpp(shades), ramp_from_cents(padded), shades];
}

// Lua: quantize_lab.lua:435
function ramp_to_lab(ramp: Ramp): Lab[] {
  const out: Lab[] = [];
  for (let i = 0; i < 4; i++) {
    const c = ramp[i]!;
    const [L, a, b] = rgb_to_lab(c[0] ?? 0, c[1] ?? 0, c[2] ?? 0);
    out[i] = { L, a, b };
  }
  return out;
}

// Lua: quantize_lab.lua:454
function ramp_dist_lab(la: Lab[], lb: Lab[]): number {
  let d = 0;
  for (let i = 0; i < 4; i++) d = d + deltaE_w_lab(la[i]!, lb[i]!);
  return d;
}

// Lua: quantize_lab.lua:462 -- [best, bestN]
function majority_pal_slot(pal64?: number[]): [number, number] {
  const counts = new Map<number, number>();
  let best = 0, bestN = -1;
  for (let i = 0; i < 64; i++) {
    const s = (pal64 && pal64[i]) ?? 0;
    const n = (counts.get(s) ?? 0) + 1;
    counts.set(s, n);
    if (n > bestN || (n === bestN && s < best)) { best = s; bestN = n; }
  }
  return [best, bestN];
}

/** Lua: quantize_lab.lua:476 -- Build a 4-shade light->dark ramp from LAB samples (optional .n weight). */
function ramp_from_lab_samples(samples: LabPixel[] | undefined): Ramp {
  if (!samples || samples.length === 0) {
    return [[255, 255, 255], [170, 170, 170], [85, 85, 85], [0, 0, 0]];
  }
  const uniques: LabPixel[] = [];
  const byKey = new Map<number | string, LabPixel>();
  const order: (number | string)[] = [];
  for (let i = 0; i < samples.length; i++) {
    const p = samples[i]!;
    let key = p.key;
    if (key === undefined) key = format("%.3f:%.3f:%.3f", p.L, p.a, p.b);
    if (!byKey.has(key)) {
      byKey.set(key, { L: p.L, a: p.a, b: p.b, r: p.r, g: p.g, key, n: 0, palSlot: p.palSlot ?? 0 });
      order.push(key);
    }
    const u = byKey.get(key)!;
    u.n = u.n! + (p.n ?? 1);
  }
  for (const k of order) uniques.push(byKey.get(k)!);
  if (uniques.length <= 4) {
    sort_centroids_light_to_dark(uniques);
    return ramp_from_cents(pad_unique_to_ramp(uniques));
  }
  const cents: Lab[] = kmeans(uniques, 4, undefined);
  sort_centroids_light_to_dark(cents);
  while (cents.length < 4) {
    const c = copy_lab(cents[cents.length - 1] ?? { L: 50, a: 0, b: 0 });
    cents.push(c);
  }
  return ramp_from_cents(cents);
}

/**
 * Lua: quantize_lab.lua:517 -- If a FRLG palSlot holds two far-apart hues,
 * emit two sample lists so they become separate codebook materials.
 */
function split_hue_modes(samples: LabPixel[]): LabPixel[][] {
  const chromatic: LabPixel[] = [];
  let totalW = 0;
  for (let i = 0; i < samples.length; i++) {
    const p = samples[i]!;
    const w = p.n ?? 1;
    totalW = totalW + w;
    if (chroma(p.a, p.b) >= 8) chromatic.push(p);
  }
  if (chromatic.length < 4 || totalW < QuantizeLab.MIN_MATERIAL_PIXELS * 2) return [samples];

  // Farthest-point k=2 on (a,b), then assign.
  const s0 = chromatic[0]!;
  let s1 = chromatic[0]!, bestD = -1;
  for (let i = 0; i < chromatic.length; i++) {
    const p = chromatic[i]!;
    const d = sq(p.a - s0.a) + sq(p.b - s0.b);
    if (d > bestD) { bestD = d; s1 = p; }
  }
  let s2 = s1, bestD2 = -1;
  for (let i = 0; i < chromatic.length; i++) {
    const p = chromatic[i]!;
    const d = sq(p.a - s1.a) + sq(p.b - s1.b);
    if (d > bestD2) { bestD2 = d; s2 = p; }
  }
  let c1: Lab = { L: s1.L, a: s1.a, b: s1.b };
  let c2: Lab = { L: s2.L, a: s2.a, b: s2.b };
  // Refine means once
  for (let it = 0; it < 4; it++) {
    let a1 = 0, b1 = 0, w1 = 0, L1 = 0;
    let a2 = 0, b2 = 0, w2 = 0, L2 = 0;
    for (let i = 0; i < chromatic.length; i++) {
      const p = chromatic[i]!;
      const w = p.n ?? 1;
      const d1 = sq(p.a - c1.a) + sq(p.b - c1.b);
      const d2 = sq(p.a - c2.a) + sq(p.b - c2.b);
      if (d1 <= d2) {
        a1 = a1 + p.a * w; b1 = b1 + p.b * w; L1 = L1 + p.L * w; w1 = w1 + w;
      } else {
        a2 = a2 + p.a * w; b2 = b2 + p.b * w; L2 = L2 + p.L * w; w2 = w2 + w;
      }
    }
    if (w1 > 0) c1 = { L: L1 / w1, a: a1 / w1, b: b1 / w1 };
    if (w2 > 0) c2 = { L: L2 / w2, a: a2 / w2, b: b2 / w2 };
  }

  const de = deltaE_w_lab(c1, c2);
  if (de < QuantizeLab.HUE_SPLIT_DE) return [samples];

  const g1: LabPixel[] = [], g2: LabPixel[] = [];
  let w1 = 0, w2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const p = samples[i]!;
    const w = p.n ?? 1;
    const d1 = deltaE_w_lab(p, c1);
    const d2 = deltaE_w_lab(p, c2);
    if (d1 <= d2) { g1.push(p); w1 = w1 + w; }
    else { g2.push(p); w2 = w2 + w; }
  }
  const minW = totalW * QuantizeLab.HUE_SPLIT_MIN_FRAC;
  if (w1 < minW || w2 < minW || g1.length === 0 || g2.length === 0) return [samples];
  return [g1, g2];
}

// Lua: quantize_lab.lua:593 -- [sorted significant slots, counts]
function significant_pal_slots(pal64?: number[]): [number[], Map<number, number>] {
  const counts = new Map<number, number>();
  for (let i = 0; i < 64; i++) {
    const s = (pal64 && pal64[i]) ?? 0;
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const sig: number[] = [];
  for (const [s, n] of counts) {
    if (n >= QuantizeLab.MIXED_MIN_PIXELS) sig.push(s);
  }
  luaSort(sig);
  return [sig, counts];
}

// Lua: quantize_lab.lua:670
function copy_cat_votes(src: Record<string, number> | undefined): Record<string, number> | undefined {
  if (!src) return undefined;
  const out: Record<string, number> = {};
  for (const c of Object.keys(src)) out[c] = src[c]!;
  return out;
}

// Lua: quantize_lab.lua:677
function add_cat_votes(dst: Record<string, number> | undefined, src: Record<string, number> | undefined): Record<string, number> | undefined {
  if (!src) return dst;
  dst = dst ?? {};
  for (const c of Object.keys(src)) dst[c] = (hasOwn.call(dst, c) ? dst[c]! : 0) + src[c]!;
  return dst;
}

// Lua: quantize_lab.lua:780
function min_shade_de(p: Lab, rampLab: Lab[]): number {
  let best = 1e18;
  for (let s = 0; s < 4; s++) {
    const d = deltaE_w_lab(p, rampLab[s]!);
    if (d < best) best = d;
  }
  return best;
}

// Lua: quantize_lab.lua:789
function quad_ramp_error(pixels: LabPixel[], rampLab: Lab[]): number {
  let sum = 0;
  for (let i = 0; i < pixels.length; i++) {
    const p = pixels[i]!;
    // Structural outlines + vibrant colours outvote flat floors/walls.
    let w = 1.0;
    if (p.L < 45) w = w + 2.0;
    if (chroma(p.a, p.b) > 10) w = w + 1.5;
    sum = sum + min_shade_de(p, rampLab) * w;
  }
  return sum;
}

// Lua: quantize_lab.lua:993
function clamp_weights(na: number, nb: number, cap?: number): [number, number] {
  cap = cap ?? QuantizeLab.WEIGHT_RATIO_CAP;
  if (na < 1) na = 1;
  if (nb < 1) nb = 1;
  if (na > nb * cap) na = nb * cap;
  if (nb > na * cap) nb = na * cap;
  return [na, nb];
}

// Lua: quantize_lab.lua:1002
function blend_ramps(a: Ramp, b: Ramp, na: number, nb: number): Ramp {
  [na, nb] = clamp_weights(na, nb);
  const out: Ramp = [];
  const den = na + nb;
  const la = ramp_to_lab(a), lb = ramp_to_lab(b);
  for (let i = 0; i < 4; i++) {
    const L = (la[i]!.L * na + lb[i]!.L * nb) / den;
    const aa = (la[i]!.a * na + lb[i]!.a * nb) / den;
    const bb = (la[i]!.b * na + lb[i]!.b * nb) / den;
    const [r, g, brgb] = lab_to_rgb(L, aa, bb);
    out[i] = [r, g, brgb];
  }
  return out;
}

/**
 * Lua: quantize_lab.lua:1019 -- Reject merge if the hypothetical blend pushes
 * the rarer ramp too far from its origin.
 */
function rare_shift_ok_lab(rareLab: Lab[], blendedLab: Lab[]): boolean {
  for (let i = 0; i < 4; i++) {
    const r = rareLab[i]!, b = blendedLab[i]!;
    const dL = Math.abs(r.L - b.L);
    const dab = Math.sqrt(sq(r.a - b.a) + sq(r.b - b.b));
    if (dL > QuantizeLab.DL_SHIFT_MAX || dab > QuantizeLab.DAB_SHIFT_MAX) return false;
  }
  return true;
}

interface Cluster {
  ramp: Ramp;
  lab: Lab[];
  count: number;
  locked: boolean;
  members: number[];
  alive: boolean;
  catVotes?: Record<string, number>;
}

export const QuantizeLab = {
  W_L: 2.0,
  L_TIE: 1.0, // |dL| below this -> hue/chroma tie-break
  NEAR_DUPE_EPS: 12.0, // Tuned for standard ramp_dist_lab
  // Outdoor bank/merge: slightly tighter than indoor so sand/water stay apart,
  // but not so tight that buildings fragment into noisy near-dupes.
  OUTDOOR_NEAR_DUPE_EPS: 8.0,
  MAX_SLOTS: 22, // per tileset-pair codebook budget (sheet also <=22)
  WEIGHT_RATIO_CAP: 2, // max 2:1 usage weights when blending
  PALSLOT_ADD: 50.0, // legacy; unused in top-down bake
  OUTLIER_DE_MIN: 25.0, // legacy per-quad path
  DL_SHIFT_MAX: 10.0, // material merge: reject if rare->blend |dL| exceeds
  DAB_SHIFT_MAX: 4.0, // material merge: reject if rare->blend chroma shift exceeds
  KMEANS_ITERS: 6,
  MIN_MATERIAL_PIXELS: 4,
  MIXED_MIN_PIXELS: 10, // minority palSlot >= this (diagnostics)
  HUE_SPLIT_DE: 28.0, // split one FRLG palSlot into 2 materials
  HUE_SPLIT_MIN_FRAC: 0.18,
  // Outdoor locked terrain: one 4-shade ramp family (no tip/base hue split).
  OUTDOOR_TERRAIN_FAMILY: {
    TREE: "TREE",
    WATER: "WATER",
    SAND: "SAND",
    CLIFF: "CLIFF",
    COAST_CLIFF: "CLIFF",
  } as Record<string, string>,
  BLACK_RAMP: [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]] as Ramp,

  OUTDOOR_FRLG_BIAS: 50.0, // soft prefer matching FRLG palSlot outdoors
  OUTDOOR_RAMP_BIAS: 40.0, // soft prefer semantic seed ramp on mixed edges
  // Soft push plaza grass/path away from water/sand codebook entries.
  OUTDOOR_CROSS_CAT_PENALTY: 120.0,
  OUTDOOR_GRASS_CATS: {
    SHORT_GRASS: true,
    TALL_GRASS: true,
    TOWN_PATH: true,
  } as Record<string, boolean>,

  // Lua: quantize_lab.lua:109
  deltaE_w(L1: number, a1: number, b1: number, L2: number, a2: number, b2: number, wL?: number): number {
    wL = wL ?? QuantizeLab.W_L;
    const dL = (L1 - L2) * wL;
    const da = a1 - a2;
    const db = b1 - b2;
    return Math.sqrt(dL * dL + da * da + db * db);
  },

  /**
   * Lua: quantize_lab.lua:413 -- Demake one 8x8 BGR555 quad -> [2bpp, 4-colour
   * RGB ramp (light->dark), shades]. pal64: optional per-pixel FRLG palette slot.
   */
  quadTo2bppAndRamp(buf64: number[], pal64?: number[]): [number[], Ramp, number[]] {
    const [pixels, uniques] = gather_pixels(buf64, pal64);
    if (uniques.length <= 4) return bypass_unique(pixels, uniques);

    const lock = structural_outlier(pixels);
    const locked = lock ? [lock] : undefined;
    const cents = kmeans(pixels, 4, locked);
    sort_centroids_light_to_dark(cents);
    while (cents.length < 4) {
      const last = cents[cents.length - 1];
      const c = copy_lab(last ?? { L: 50, a: 0, b: 0 });
      c.palSlot = (last && last.palSlot) ?? 0;
      cents.push(c);
    }
    const shades = assign_shades(pixels, cents);
    // No medoid polish: k-means centroids are optimal.
    return [encode_2bpp(shades), ramp_from_cents(cents), shades];
  },

  // Lua: quantize_lab.lua:445
  rampDistance(a: Ramp, b: Ramp): number {
    const la = ramp_to_lab(a), lb = ramp_to_lab(b);
    let d = 0;
    for (let i = 0; i < 4; i++) d = d + deltaE_w_lab(la[i]!, lb[i]!);
    return d;
  },

  // Lua: quantize_lab.lua:609
  isMixedQuad(pal64?: number[]): boolean {
    const [sig] = significant_pal_slots(pal64);
    return sig.length >= 2;
  },

  // Lua: quantize_lab.lua:615 -- Local 4-shade ramp for one quad (used for mixed / high-residual tiles).
  rampFromQuad(buf64: number[], pal64?: number[]): Ramp {
    const [pixels] = gather_pixels(buf64, pal64);
    return ramp_from_lab_samples(pixels);
  },

  // Lua: quantize_lab.lua:620
  terrainFamily(category: string | undefined): string | undefined {
    const t = QuantizeLab.OUTDOOR_TERRAIN_FAMILY;
    const k = category ?? "";
    return hasOwn.call(t, k) ? t[k] : undefined;
  },

  // Lua: quantize_lab.lua:624 (the tie-break makes pairs() order moot)
  primaryCategory(catVotes: Record<string, number> | undefined): string | undefined {
    if (!catVotes) return undefined;
    let bestC: string | undefined, bestN = -1;
    for (const c of Object.keys(catVotes)) {
      const n = catVotes[c]!;
      if (n > bestN || (n === bestN && (bestC === undefined || c < bestC))) { bestC = c; bestN = n; }
    }
    return bestC;
  },

  // Lua: quantize_lab.lua:635
  entryHasCategory(entry: { categories?: Record<string, number> } | undefined, category: string | undefined): boolean {
    if (!category || category === "") return true;
    const votes = entry && entry.categories;
    if (!votes) return false;
    if ((hasOwn.call(votes, category) ? votes[category]! : 0) > 0) return true;
    const fam = QuantizeLab.terrainFamily(category);
    if (!fam) return false;
    for (const c of Object.keys(votes)) {
      if (votes[c]! > 0 && QuantizeLab.terrainFamily(c) === fam) return true;
    }
    return false;
  },

  /**
   * Lua: quantize_lab.lua:649 -- Best codebook index (1-based) whose categories
   * include `category` (terrain family ok).
   */
  primaryCodebookForCategory(codebook: CodebookEntry[] | undefined, category: string | undefined): number | undefined {
    if (!codebook || !category) return undefined;
    const fam = QuantizeLab.terrainFamily(category) ?? category;
    let bestI: number | undefined, bestN = -1;
    for (let i = 1; i <= codebook.length; i++) {
      const e = codebook[i - 1]!;
      const votes = e.categories ?? {};
      let n = 0;
      for (const c of Object.keys(votes)) {
        if (c === category || QuantizeLab.terrainFamily(c) === fam) n = n + votes[c]!;
      }
      if (n > bestN || (n === bestN && (bestI === undefined || i < bestI))) { bestN = n; bestI = i; }
    }
    if (bestN > 0) return bestI;
    return undefined;
  },

  /**
   * Lua: quantize_lab.lua:690 -- Step 1: discover one (or hue-split) material
   * ramp per (pair, FRLG palSlot). quads: { buf, pal, pair, category? }.
   */
  discoverMaterialEntries(quads: QuadInput[] | undefined, opts?: { forbidHueSplit?: boolean }): MaterialEntry[] {
    opts = opts ?? {};
    const forbidHueSplit = !!opts.forbidHueSplit;
    interface Bucket {
      pair: string; frlgSlot: number; byKey: Map<number, LabPixel>; order: number[];
      pixelN: number; quadN?: number; catVotes: Record<string, number>;
    }
    const buckets = new Map<string, Bucket>();
    const majCounts = new Map<string, number>(); // key -> quads with this majority

    for (const q of quads ?? []) {
      const pair = q.pair ?? "";
      const [maj] = majority_pal_slot(q.pal);
      const majKey = pair + ":" + tostring(maj);
      majCounts.set(majKey, (majCounts.get(majKey) ?? 0) + 1);
      const qCat = q.category;

      const seen = new Set<string>();
      for (let i = 0; i < 64; i++) {
        const c = (q.buf && q.buf[i]) ?? 0;
        const frlg = (q.pal && q.pal[i]) ?? 0;
        const key = pair + ":" + tostring(frlg);
        let b = buckets.get(key);
        if (!b) {
          b = { pair, frlgSlot: frlg, byKey: new Map(), order: [], pixelN: 0, catVotes: {} };
          buckets.set(key, b);
        }
        b.pixelN = b.pixelN + 1;
        if (!b.byKey.has(c)) {
          const [r, g, bb] = bgr555_to_rgb(c);
          const [L, a, labB] = rgb_to_lab(r, g, bb);
          b.byKey.set(c, { L, a, b: labB, r, g, key: c, n: 0, palSlot: frlg });
          b.order.push(c);
        }
        const u = b.byKey.get(c)!;
        u.n = u.n! + 1;
        seen.add(key);
      }
      for (const key of seen) {
        const b = buckets.get(key)!;
        b.quadN = (b.quadN ?? 0) + 1;
        if (qCat && qCat !== "") b.catVotes[qCat] = (hasOwn.call(b.catVotes, qCat) ? b.catVotes[qCat]! : 0) + 1;
      }
    }

    const keys = luaSort([...buckets.keys()]);

    const entries: MaterialEntry[] = [];
    for (const key of keys) {
      const b = buckets.get(key)!;
      if (b.pixelN >= QuantizeLab.MIN_MATERIAL_PIXELS) {
        const samples: LabPixel[] = [];
        for (const ck of b.order) samples.push(b.byKey.get(ck)!);
        const primary = QuantizeLab.primaryCategory(b.catVotes);
        // Only collapse tip/base foliage. Water/sand/cliff keep hue modes so
        // foam/rocks/highlights can remain separate materials.
        const skipSplit = forbidHueSplit || primary === "TREE";
        const modes = skipSplit ? [samples] : split_hue_modes(samples);
        let baseWeight = majCounts.get(key) ?? b.quadN ?? 1;
        if (baseWeight < 1) baseWeight = 1;
        const cats = copy_cat_votes(b.catVotes);
        for (let mi = 0; mi < modes.length; mi++) {
          const modeSamples = modes[mi]!;
          let modeW = 0;
          for (let i = 0; i < modeSamples.length; i++) modeW = modeW + (modeSamples[i]!.n ?? 1);
          const weight = Math.max(1, Math.floor(baseWeight * modeW / Math.max(1, b.pixelN) + 0.5));
          const e: MaterialEntry = {
            ramp: ramp_from_lab_samples(modeSamples),
            count: weight,
            locked: false,
            frlgSlot: b.frlgSlot,
            pair: b.pair,
            categories: cats ? copy_cat_votes(cats) : undefined,
          };
          if (primary !== undefined) e.primaryCategory = primary;
          entries.push(e);
        }
      }
    }
    return entries;
  },

  // Lua: quantize_lab.lua:813 -- dE_w between two BGR555 pixels (MRF seam gating).
  pixelDeltaE(cA: number, cB: number): number {
    const [r1, g1, b1] = bgr555_to_rgb(cA);
    const [r2, g2, b2] = bgr555_to_rgb(cB);
    const [L1, a1, bb1] = rgb_to_lab(r1, g1, b1);
    const [L2, a2, bb2] = rgb_to_lab(r2, g2, b2);
    return QuantizeLab.deltaE_w(L1, a1, bb1, L2, a2, bb2);
  },

  // Lua: quantize_lab.lua:824 -- [best slot, its count]
  majorityPalSlot(pal64?: number[]): [number, number] {
    return majority_pal_slot(pal64);
  },

  // Lua: quantize_lab.lua:828
  quadRampError(buf64: number[], pal64: number[] | undefined, ramp: Ramp, _frlgSlot?: number): number {
    const [pixels] = gather_pixels(buf64, pal64);
    return quad_ramp_error(pixels, ramp_to_lab(ramp));
  },

  /**
   * Lua: quantize_lab.lua:833 -- Step 2: pick codebook index (1-based) by
   * weighted sum of min-shade dE_w (pair-scoped).
   */
  bestCodebookIndex(buf64: number[], pal64: number[] | undefined, codebook: CodebookEntry[] | undefined,
    pair?: string, opts?: AssignOpts): number {
    if (!codebook || codebook.length === 0) return 1;
    const [pixels] = gather_pixels(buf64, pal64);
    pair = pair ?? "";
    const preferFrlg = opts ? opts.preferFrlgSlot : undefined;
    const frlgBias = (opts && opts.frlgBias) || 0;
    const preferRamp = opts ? opts.preferRamp : undefined;
    const rampBias = (opts && opts.rampBias) || 0;
    const requireCat = opts ? opts.requireCategory : undefined;
    const categoryBias = (opts && opts.categoryBias) || 0;
    const itemCat = opts ? opts.itemCategory : undefined;
    const crossPen = (opts && opts.crossCatPenalty) || 0;

    const cross_penalty = (e: CodebookEntry): number => {
      if (crossPen <= 0 || !itemCat) return 0;
      if (QuantizeLab.OUTDOOR_GRASS_CATS[itemCat]) {
        if (QuantizeLab.entryHasCategory(e, "WATER") || QuantizeLab.entryHasCategory(e, "SAND")) return crossPen;
        const primary = e.primaryCategory;
        if (primary === "WATER" || primary === "SAND") return crossPen;
      }
      return 0;
    };

    const score_range = (onlyMatching: boolean): number | undefined => {
      let bestI: number | undefined, bestD = 1e18;
      for (let i = 1; i <= codebook.length; i++) {
        const e = codebook[i - 1]!;
        if ((e.pair ?? "") === pair) {
          if (!onlyMatching || QuantizeLab.entryHasCategory(e, requireCat)) {
            const lab = e.lab ?? ramp_to_lab(e.ramp);
            let d = quad_ramp_error(pixels, lab) + cross_penalty(e);
            if (preferFrlg !== undefined && frlgBias !== 0 && (e.frlgSlot ?? 0) === preferFrlg) d = d - frlgBias;
            if (preferRamp && rampBias > 0 && e.ramp) {
              const rd = QuantizeLab.rampDistance(e.ramp, preferRamp);
              d = d - rampBias / (1 + rd / 12);
            }
            if (requireCat && categoryBias > 0 && QuantizeLab.entryHasCategory(e, requireCat)) d = d - categoryBias;
            if (d < bestD) { bestD = d; bestI = i; }
          }
        }
      }
      return bestI;
    };

    let bestI: number | undefined;
    if (requireCat) bestI = score_range(true);
    if (bestI === undefined) bestI = score_range(false);

    // Safe fallback if a pair string is missing/mismatched
    if (bestI === undefined) {
      let bestD = 1e18;
      for (let i = 1; i <= codebook.length; i++) {
        const e = codebook[i - 1]!;
        const lab = e.lab ?? ramp_to_lab(e.ramp);
        const d = quad_ramp_error(pixels, lab) + cross_penalty(e);
        if (d < bestD) { bestD = d; bestI = i; }
      }
    }
    return bestI ?? 1;
  },

  // Lua: quantize_lab.lua:911 -- Opaque void 2bpp: all shade 3 (atlas black).
  solidBlackBpp(): number[] {
    const shades: number[] = [];
    for (let i = 0; i < 64; i++) shades[i] = 3;
    return encode_2bpp(shades);
  },

  /**
   * Lua: quantize_lab.lua:920 -- Strict codebook adoption. Returns
   * [ramp, sheetSlot | undefined, mode ("codebook"|"local"), codebookIndex | undefined].
   */
  resolveQuadRamp(buf64: number[], pal64: number[] | undefined, codebook: CodebookEntry[] | undefined,
    pair?: string, opts?: AssignOpts): [Ramp, number | undefined, string, number | undefined] {
    if (!codebook || codebook.length === 0) {
      const [pixels] = gather_pixels(buf64, pal64);
      return [ramp_from_lab_samples(pixels), undefined, "local", undefined];
    }
    const ci = QuantizeLab.bestCodebookIndex(buf64, pal64, codebook, pair, opts);
    const entry = codebook[ci - 1]!;
    return [entry.ramp, entry.slot, "codebook", ci];
  },

  // Lua: quantize_lab.lua:932 -- Step 3: bake 2bpp by nearest dE_w shade in a fixed ramp: [bpp, shades].
  quadTo2bppAgainstRamp(buf64: number[], ramp: Ramp): [number[], number[]] {
    const rampLab = ramp_to_lab(ramp);
    const shades: number[] = [];
    for (let i = 0; i < 64; i++) {
      const [r, g, b] = bgr555_to_rgb(buf64[i] ?? 0);
      const [L, a, bb] = rgb_to_lab(r, g, b);
      const p = { L, a, b: bb };
      let best = 0, bestD = 1e18;
      for (let s = 0; s < 4; s++) {
        const d = deltaE_w_lab(p, rampLab[s]!);
        if (d < bestD) { best = s; bestD = d; }
      }
      shades[i] = best;
    }
    return [encode_2bpp(shades), shades];
  },

  // Lua: quantize_lab.lua:950 -- True when any pixel is exact BGR555 0.
  bufHasExactBlack(buf64: number[]): boolean {
    for (let i = 0; i < 64; i++) {
      if (mod(buf64[i] ?? 0, 0x8000) === 0) return true;
    }
    return false;
  },

  /**
   * Lua: quantize_lab.lua:961 -- Bake a quad; exact-black pixels reserve shade
   * 3 as true black for this tile only. Returns [bpp16, usedRamp, lockedBlack].
   */
  bakeQuad(buf64: number[], ramp: Ramp): [number[], Ramp, boolean] {
    if (!QuantizeLab.bufHasExactBlack(buf64)) {
      const [bpp] = QuantizeLab.quadTo2bppAgainstRamp(buf64, ramp);
      return [bpp, ramp, false];
    }
    const used: Ramp = [
      [ramp[0]![0]!, ramp[0]![1]!, ramp[0]![2]!],
      [ramp[1]![0]!, ramp[1]![1]!, ramp[1]![2]!],
      [ramp[2]![0]!, ramp[2]![1]!, ramp[2]![2]!],
      [0, 0, 0],
    ];
    const rampLab = ramp_to_lab(used);
    const shades: number[] = [];
    for (let i = 0; i < 64; i++) {
      const c = mod(buf64[i] ?? 0, 0x8000);
      if (c === 0) {
        shades[i] = 3;
      } else {
        const [r, g, b] = bgr555_to_rgb(c);
        const [L, a, bb] = rgb_to_lab(r, g, b);
        const p = { L, a, b: bb };
        let best = 0, bestD = 1e18;
        for (let s = 0; s < 3; s++) { // shades 0-2 only; 3 is reserved black
          const d = deltaE_w_lab(p, rampLab[s]!);
          if (d < bestD) { best = s; bestD = d; }
        }
        shades[i] = best;
      }
    }
    return [encode_2bpp(shades), used, true];
  },

  /**
   * Lua: quantize_lab.lua:1036 -- Agglomerative merge of provisional ramps into
   * <= maxSlots. Returns [finalRamps, oldToSlot] (oldToSlot[i - 1] = slot).
   */
  mergeRampsToBudget(entries: { ramp: Ramp; count?: number; locked?: boolean; categories?: Record<string, number> }[] | undefined,
    maxSlots?: number, opts?: { nearDupeEps?: number; guardTerrainFamilies?: boolean }): [Ramp[], number[]] {
    maxSlots = maxSlots ?? QuantizeLab.MAX_SLOTS;
    opts = opts ?? {};
    const nearEps = opts.nearDupeEps ?? QuantizeLab.NEAR_DUPE_EPS;
    const guardFam = !!opts.guardTerrainFamilies;
    if (!entries || entries.length === 0) {
      return [[[[255, 255, 255], [170, 170, 170], [85, 85, 85], [0, 0, 0]]], []];
    }

    const cluster_family = (c: Cluster): string | undefined => {
      const primary = QuantizeLab.primaryCategory(c.catVotes);
      return primary ? QuantizeLab.terrainFamily(primary) : undefined;
    };
    const families_conflict = (ca: Cluster, cb: Cluster): boolean => {
      if (!guardFam) return false;
      const fa = cluster_family(ca), fb = cluster_family(cb);
      return fa !== undefined && fb !== undefined && fa !== fb;
    };

    // clusters[id] with the Lua's 1-based ids (index 0 unused)
    const clusters: Cluster[] = [];
    let active: number[] = []; // dense list of cluster ids
    for (let i = 1; i <= entries.length; i++) {
      const e = entries[i - 1]!;
      const ramp: Ramp = [
        [e.ramp[0]![0]!, e.ramp[0]![1]!, e.ramp[0]![2]!],
        [e.ramp[1]![0]!, e.ramp[1]![1]!, e.ramp[1]![2]!],
        [e.ramp[2]![0]!, e.ramp[2]![1]!, e.ramp[2]![2]!],
        [e.ramp[3]![0]!, e.ramp[3]![1]!, e.ramp[3]![2]!],
      ];
      clusters[i] = {
        ramp,
        lab: ramp_to_lab(ramp),
        count: e.count ?? 1,
        locked: !!e.locked,
        members: [i],
        alive: true,
        catVotes: copy_cat_votes(e.categories),
      };
      active.push(i);
    }

    // [ok, keep, drop]
    const try_merge = (ia: number, ib: number, force: boolean): [boolean, number?, number?] => {
      const ca = clusters[ia], cb = clusters[ib];
      if (!(ca && cb && ca.alive && cb.alive)) return [false];
      if (ca.locked && cb.locked) return [false];
      if (families_conflict(ca, cb)) return [false];

      // Keep = locked or higher-count (dominant); drop = rare.
      let keep = ia, drop = ib;
      if (cb.locked && !ca.locked) {
        keep = ib; drop = ia;
      } else if (!ca.locked && !cb.locked && cb.count > ca.count) {
        keep = ib; drop = ia;
      }

      const ck = clusters[keep]!, cd = clusters[drop]!;
      let blended: Ramp, blendedLab: Lab[];
      if (force) {
        // Panic merge: absorb rare into dominant without corrupting dominant colours.
        blended = ck.ramp;
        blendedLab = ck.lab;
      } else {
        blended = blend_ramps(ck.ramp, cd.ramp, ck.count, cd.count);
        blendedLab = ramp_to_lab(blended);
        if (!rare_shift_ok_lab(cd.lab, blendedLab)) return [false];
      }

      ck.ramp = blended;
      ck.lab = blendedLab;
      ck.count = ck.count + cd.count;
      ck.locked = ck.locked || cd.locked;
      ck.catVotes = add_cat_votes(ck.catVotes, cd.catVotes);
      for (const m of cd.members) ck.members.push(m);
      cd.alive = false;
      return [true, keep, drop];
    };

    // Near-dupe: single O(n^2) sweep (union into lower id)
    {
      const n = active.length;
      for (let i = 0; i < n; i++) {
        const a = active[i]!;
        let ca = clusters[a];
        if (ca && ca.alive) {
          for (let j = i + 1; j < n; j++) {
            const b = active[j]!;
            const cb = clusters[b];
            if (cb && cb.alive && !(ca.locked && cb.locked) && !families_conflict(ca, cb)) {
              if (ramp_dist_lab(ca.lab, cb.lab) < nearEps) {
                const [ok] = try_merge(a, b, false);
                if (ok) {
                  ca = clusters[a]!;
                  if (!ca.alive) break;
                }
              }
            }
          }
        }
      }
      const nxt: number[] = [];
      for (const id of active) if (clusters[id]!.alive) nxt.push(id);
      active = nxt;
    }

    // Hard cap: closest-pair (same design). Rank pairs by LAB distance, then try
    // shift-ok merges from closest; force only the nearest if all reject.
    while (active.length > maxSlots) {
      const pairs: { a: number; b: number; d: number }[] = [];
      for (let i = 0; i < active.length; i++) {
        const a = active[i]!;
        const ca = clusters[a]!;
        for (let j = i + 1; j < active.length; j++) {
          const b = active[j]!;
          const cb = clusters[b]!;
          if (!(ca.locked && cb.locked) && !families_conflict(ca, cb)) {
            pairs.push({ a, b, d: ramp_dist_lab(ca.lab, cb.lab) });
          }
        }
      }
      if (pairs.length === 0) break;
      luaSort(pairs, (u, v) => {
        if (u.d !== v.d) return u.d < v.d;
        if (u.a !== v.a) return u.a < v.a;
        return u.b < v.b;
      });
      let mergedOk = false;
      let drop: number | undefined;
      for (const p of pairs) {
        const [ok, , d] = try_merge(p.a, p.b, false);
        if (ok) { mergedOk = true; drop = d; break; }
      }
      if (!mergedOk) {
        const [ok, , d] = try_merge(pairs[0]!.a, pairs[0]!.b, true);
        if (!ok) break;
        drop = d;
      }
      const nxt: number[] = [];
      for (const id of active) if (id !== drop && clusters[id]!.alive) nxt.push(id);
      active = nxt;
    }

    luaSort(active, (a, b) => {
      const ca = clusters[a]!, cb = clusters[b]!;
      if (ca.locked !== cb.locked) return ca.locked;
      if (ca.count !== cb.count) return ca.count > cb.count;
      return a < b;
    });

    const finalRamps: Ramp[] = [];
    const oldToSlot: number[] = [];
    for (let s = 0; s < active.length; s++) {
      const slot = s + 1;
      if (slot > maxSlots) break;
      const id = active[s]!;
      finalRamps[slot - 1] = clusters[id]!.ramp;
      for (const m of clusters[id]!.members) oldToSlot[m - 1] = slot;
    }
    for (let i = 1; i <= entries.length; i++) {
      if (oldToSlot[i - 1] === undefined) {
        let best = 1, bestD = 1e18;
        const lab = ramp_to_lab(entries[i - 1]!.ramp);
        for (let s = 1; s <= finalRamps.length; s++) {
          const d = ramp_dist_lab(lab, ramp_to_lab(finalRamps[s - 1]!));
          if (d < bestD) { best = s; bestD = d; }
        }
        oldToSlot[i - 1] = best;
      }
    }
    return [finalRamps, oldToSlot];
  },

  // Expose helpers for tests
  _rgb_to_lab: rgb_to_lab,
  _pad_unique_to_ramp: pad_unique_to_ramp,
  _red_ref_cos: red_ref_cos,
  _sort_centroids: sort_centroids_light_to_dark,
};

export default QuantizeLab;
