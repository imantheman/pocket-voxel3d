// Port of gen1recomp src/import/gba/quantize.lua (GPLv3 + additional terms; see LICENSE.md).
// BGR555 -> BT.709 luminance -> 4-shade 2bpp (engine ImageWriter.SHADES ramp)
// plus per-tile RGB ramps clustered into BG palette slots.
// Outdoor stays <=8; Sevii interiors may use up to Quantize.MAX_PALETTE_SLOTS.
//
// Shapes: the Lua's 1-based sequences are 0-based JS arrays here -- an 8x8
// BGR555 tile `buf64[i]` is buf64[i - 1], a 2bpp tile's 16 bytes and the 64
// shades likewise, a ramp's four {r, g, b} shades ramp[0..3] (each [r, g, b]),
// and sheet.palettes / paletteCounts / tiles are indexed slot - 1 / id. Slot
// numbers and tile ids keep their Lua values (slots 1.., ids 0..).
// Every table.sort goes through luaSort (LuaJIT's quicksort).

import { luaSort } from "./luasort.ts";
import { mod, tonumber } from "./lua.ts";

export type Rgb = number[];
export type Ramp = Rgb[];

export interface Sheet {
  keys: Record<string, number>;
  tiles: number[][];
  tilePalettes: unknown[];
  palettes: Ramp[];
  paletteCounts: number[];
  count: number;
}

export interface SlotGroup {
  key: string;
  ramp: Ramp;
  count?: number;
  family?: string;
  categoryVotes?: Record<string, number>;
}

/** The Lua `#t` of a sequence held 0-based: the first border (t[n + 1] == nil). */
function seqLen(t: unknown[]): number {
  let n = 0;
  while (t[n] !== undefined && t[n] !== null) n++;
  return n;
}

// Lua: quantize.lua:16
function bgr555_to_rgb(c: number): [number, number, number] {
  const r5 = mod(c, 32);
  const g5 = mod(Math.floor(c / 32), 32);
  const b5 = mod(Math.floor(c / 1024), 32);
  return [r5 * 255 / 31, g5 * 255 / 31, b5 * 255 / 31];
}

// Lua: quantize.lua:23
function bgr555_to_y(c: number): number {
  const [r, g, b] = bgr555_to_rgb(c);
  return 0.2126 * (r / 255) + 0.7152 * (g / 255) + 0.0722 * (b / 255);
}

// Lua: quantize.lua:29 -- Per-tile thresholds from Y histogram (quartile-ish breakpoints).
function thresholds_from_tile(ys: number[]): [number, number, number] {
  const sorted: number[] = [];
  for (let i = 0; i < ys.length; i++) sorted[i] = ys[i]!;
  luaSort(sorted);
  const at = (p: number): number => {
    const i = Math.max(1, Math.min(sorted.length, Math.floor(p * sorted.length)));
    return sorted[i - 1]!;
  };
  const t1 = at(0.25);
  let t2 = at(0.50);
  let t3 = at(0.75);
  if (t2 <= t1) t2 = t1 + 1e-4;
  if (t3 <= t2) t3 = t2 + 1e-4;
  return [t1, t2, t3];
}

// Lua: quantize.lua:45
function shade_for_y(y: number, t1: number, t2: number, t3: number): number {
  if (y >= t3) return 0;
  if (y >= t2) return 1;
  if (y >= t1) return 2;
  return 3;
}

// Lua: quantize.lua:52
function copy_ramp(ramp: Ramp): Ramp {
  const out: Ramp = [];
  for (let i = 0; i < 4; i++) {
    const c = ramp[i]!;
    out[i] = [c[0]!, c[1]!, c[2]!];
  }
  return out;
}

// Lua: quantize.lua:61
function ramp_dist2(a: Ramp, b: Ramp): number {
  let d = 0;
  for (let i = 0; i < 4; i++) {
    for (let ch = 0; ch < 3; ch++) {
      const x = (a[i]![ch] ?? 0) - (b[i]![ch] ?? 0);
      d = d + x * x;
    }
  }
  return d;
}

// Lua: quantize.lua:72 -- Running average: dst already holds mean of n samples; fold in src.
function blend_ramp(dst: Ramp, src: Ramp, n: number): void {
  const n1 = n + 1;
  for (let i = 0; i < 4; i++) {
    for (let ch = 0; ch < 3; ch++) {
      dst[i]![ch] = Math.floor((dst[i]![ch]! * n + src[i]![ch]!) / n1 + 0.5);
    }
  }
}

// Lua: quantize.lua:82
function gray_ramp(): Ramp {
  const out: Ramp = [];
  for (let i = 0; i < 4; i++) {
    const v = Math.floor(Quantize.SHADES_Y[i]! * 255 + 0.5);
    out[i] = [v, v, v];
  }
  return out;
}

// Lua: quantize.lua:189
function dist2_rgb(r: number, g: number, b: number, c: Rgb): number {
  const dr = r - c[0]!, dg = g - c[1]!, db = b - c[2]!;
  return dr * dr + dg * dg + db * db;
}

const FAMILY_CROSS_PENALTY = 80000; // squared RGB; prefer same-family merges
// Same family but very different hues (red roof vs blue wall) may take another slot.
const FAMILY_SPLIT_DIST = 45000;

// Lua: quantize.lua:336
function family_of(category: string | undefined): string {
  return Quantize.CAT_FAMILY[category ?? ""] ?? "path";
}

// Lua: quantize.lua:340
// NOT FAITHFUL (order): the Lua walks `votes` with pairs(), so a tie for the
// most votes goes to whichever key LuaJIT's (seeded) string hash visits
// first; here the first key inserted.
function majority_key(votes: Record<string, number>): string | undefined {
  let best: string | undefined, bestN = 0;
  for (const k of Object.keys(votes)) {
    const n = votes[k]!;
    if (n > bestN) { best = k; bestN = n; }
  }
  return best;
}

// Lua: quantize.lua:505
function ramp_chroma(ramp: Ramp): number {
  let m = 0;
  for (let i = 0; i < 4; i++) {
    const c = ramp[i]!;
    const spread = Math.max(c[0]!, c[1]!, c[2]!) - Math.min(c[0]!, c[1]!, c[2]!);
    if (spread > m) m = spread;
  }
  return m;
}

export const Quantize = {
  // Matches src/import/ImageWriter.lua SHADES (white -> black).
  SHADES_Y: [1.0, 2 / 3, 1 / 3, 0.0] as number[],
  MAX_PALETTE_SLOTS: 22,

  // Squared RGB distance threshold for merging demake ramps into one GBC slot.
  // Low enough that pink PC floors and green outdoor grass stay separate while
  // near-duplicate tiles still share a slot (Gen2 only has 8 BG palettes).
  RAMP_MERGE_DIST: 18000,

  MIXED_HUE_SPREAD: 120, // above this -> treat as transition; use map context

  /**
   * Lua: quantize.lua:94 -- Quantize 8x8 BGR555 (64 entries) -> 16 bytes of GB
   * 2bpp. Optional shared thresholds (t1,t2,t3) keep shade cuts identical
   * across every tile on the same Gen2 slot. Returns [bpp, ys, shades].
   */
  tileTo2bpp(buf64: number[], t1?: number, t2?: number, t3?: number): [number[], number[], number[]] {
    const ys: number[] = [];
    for (let i = 0; i < 64; i++) ys[i] = bgr555_to_y(buf64[i] ?? 0);
    if (!(t1 !== undefined && t2 !== undefined && t3 !== undefined)) {
      [t1, t2, t3] = thresholds_from_tile(ys);
      let ymin = ys[0]!, ymax = ys[0]!;
      for (let i = 1; i < 64; i++) {
        if (ys[i]! < ymin) ymin = ys[i]!;
        if (ys[i]! > ymax) ymax = ys[i]!;
      }
      if (ymax - ymin < 0.05) {
        t1 = 0.25; t2 = 0.5; t3 = 0.75;
      }
    }
    const shades: number[] = [];
    const out: number[] = [];
    for (let y = 0; y < 8; y++) {
      let low = 0, high = 0;
      for (let x = 0; x < 8; x++) {
        const shade = shade_for_y(ys[y * 8 + x]!, t1, t2!, t3!);
        shades[y * 8 + x] = shade;
        const bit = 7 - x;
        const mask = 2 ** bit;
        if (shade % 2 === 1) low = low + mask;
        if (Math.floor(shade / 2) % 2 === 1) high = high + mask;
      }
      out[y * 2] = low;
      out[y * 2 + 1] = high;
    }
    return [out, ys, shades];
  },

  // Lua: quantize.lua:130 -- Quartile thresholds from a pooled luminance list (one set per Gen2 slot).
  thresholdsFromYs(ys: number[] | undefined): [number, number, number] {
    if (!ys || ys.length === 0) return [0.25, 0.5, 0.75];
    const sorted: number[] = [];
    for (let i = 0; i < ys.length; i++) sorted[i] = ys[i]!;
    luaSort(sorted);
    const at = (p: number): number => {
      const i = Math.max(1, Math.min(sorted.length, Math.floor(p * sorted.length)));
      return sorted[i - 1]!;
    };
    const t1 = at(0.25);
    let t2 = at(0.50), t3 = at(0.75);
    if (t2 <= t1) t2 = t1 + 1e-4;
    if (t3 <= t2) t3 = t2 + 1e-4;
    return [t1, t2, t3];
  },

  // Lua: quantize.lua:146 -- Mean RGB of an 8x8 BGR555 tile (for soft slot hints).
  meanRgb(buf64: number[]): [number, number, number] {
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < 64; i++) {
      const [rr, gg, bb] = bgr555_to_rgb(buf64[i] ?? 0);
      r = r + rr; g = g + gg; b = b + bb; n = n + 1;
    }
    if (n === 0) return [0, 0, 0];
    return [r / n, g / n, b / n];
  },

  // Lua: quantize.lua:157 -- Average BGR555 colours per quantized shade -> 4 RGB entries for GbcPalette.
  rampFromTile(buf64: number[], shades?: number[]): Ramp {
    const sums: number[][] = [];
    for (let s = 0; s < 4; s++) sums[s] = [0, 0, 0, 0];
    for (let i = 0; i < 64; i++) {
      const shade = (shades && shades[i]) ?? 0;
      const [r, g, b] = bgr555_to_rgb(buf64[i] ?? 0);
      const bucket = sums[shade]!;
      bucket[0] = bucket[0]! + r;
      bucket[1] = bucket[1]! + g;
      bucket[2] = bucket[2]! + b;
      bucket[3] = bucket[3]! + 1;
    }
    const ramp = gray_ramp();
    for (let s = 0; s < 4; s++) {
      const n = sums[s]![3]!;
      if (n > 0) {
        ramp[s] = [
          Math.floor(sums[s]![0]! / n + 0.5),
          Math.floor(sums[s]![1]! / n + 0.5),
          Math.floor(sums[s]![2]! / n + 0.5),
        ];
      }
    }
    return ramp;
  },

  // Lua: quantize.lua:184 -- Quantize + demake ramp in one pass: [bpp, ramp, ys, shades].
  tileTo2bppAndRamp(buf64: number[]): [number[], Ramp, number[], number[]] {
    const [bpp, ys, shades] = Quantize.tileTo2bpp(buf64);
    return [bpp, Quantize.rampFromTile(buf64, shades), ys, shades];
  },

  /**
   * Lua: quantize.lua:198 -- Snap each BGR555 pixel to the nearest colour in a
   * fixed 4-shade ramp, then pack as 2bpp indices. Returns [bpp, shades].
   */
  tileTo2bppAgainstRamp(buf64: number[], ramp?: Ramp): [number[], number[]] {
    ramp = ramp ?? gray_ramp();
    const shades: number[] = [];
    const out: number[] = [];
    for (let y = 0; y < 8; y++) {
      let low = 0, high = 0;
      for (let x = 0; x < 8; x++) {
        const [r, g, b] = bgr555_to_rgb(buf64[y * 8 + x] ?? 0);
        let best = 0, bestD = Infinity;
        for (let s = 0; s < 4; s++) {
          const d = dist2_rgb(r, g, b, ramp[s]!);
          if (d < bestD) { best = s; bestD = d; }
        }
        shades[y * 8 + x] = best;
        const bit = 7 - x;
        const mask = 2 ** bit;
        if (best % 2 === 1) low = low + mask;
        if (Math.floor(best / 2) % 2 === 1) high = high + mask;
      }
      out[y * 2] = low;
      out[y * 2 + 1] = high;
    }
    return [out, shades];
  },

  // Lua: quantize.lua:224 -- Hue spread in an 8x8 -- high means grass|sand-style mixed tile.
  tileHueSpread(buf64: number[]): number {
    let minR = 255, minG = 255, minB = 255;
    let maxR = 0, maxG = 0, maxB = 0;
    for (let i = 0; i < 64; i++) {
      const [r, g, b] = bgr555_to_rgb(buf64[i] ?? 0);
      if (r < minR) minR = r;
      if (g < minG) minG = g;
      if (b < minB) minB = b;
      if (r > maxR) maxR = r;
      if (g > maxG) maxG = g;
      if (b > maxB) maxB = b;
    }
    return (maxR - minR) + (maxG - minG) + (maxB - minB);
  },

  // Lua: quantize.lua:242 -- Hash 16-byte 2bpp tile for dedupe (a byte string).
  tileKey(bpp16: number[]): string {
    let s = "";
    for (let i = 0; i < 16; i++) {
      const v = bpp16[i] ?? 0;
      if (v < 0 || v > 255 || !Number.isInteger(v)) throw new Error("bad argument #1 to 'char' (invalid value)");
      s += String.fromCharCode(v);
    }
    return s;
  },

  // Lua: quantize.lua:253 -- Grow a sheet of unique 2bpp tiles.
  Sheet(): Sheet {
    return {
      keys: {},
      tiles: [], // list of 16-byte arrays (tiles[id])
      tilePalettes: [], // legacy; prefer tilePalettesByTileset in extract
      palettes: [], // demake ramps (palettes[slot - 1])
      paletteCounts: [],
      count: 0,
    };
  },

  // Lua: quantize.lua:265 -- FRLG map pal 0..12 -> Gen2 BG slot 1..7 (legacy helper / tests).
  frlgPalToGen2(palSlot: unknown): number {
    const p = mod(Math.floor(tonumber(palSlot) ?? 0), 16);
    return mod(p, 7) + 1;
  },

  // Lua: quantize.lua:271 -- Force-accumulate a demake ramp into a specific BG slot.
  accumulatePalette(sheet: Sheet, slot: number, ramp: Ramp): number {
    if (slot < 1) slot = 1;
    if (slot > Quantize.MAX_PALETTE_SLOTS) slot = Quantize.MAX_PALETTE_SLOTS;
    if (!sheet.palettes[slot - 1]) {
      sheet.palettes[slot - 1] = copy_ramp(ramp);
      sheet.paletteCounts[slot - 1] = 1;
      return slot;
    }
    blend_ramp(sheet.palettes[slot - 1]!, ramp, sheet.paletteCounts[slot - 1]!);
    sheet.paletteCounts[slot - 1] = sheet.paletteCounts[slot - 1]! + 1;
    return slot;
  },

  /**
   * Lua: quantize.lua:286 -- Demake one FRLG 16-colour BGR555 palette -> 4 RGB
   * shades (light->dark by Y). Colour 0 is transparent in FRLG and is skipped.
   * pal16 is keyed 0..15 (the Lua reads pal16[1..15]).
   */
  rampFromFrlgPal(pal16: number[] | undefined): Ramp {
    const entries: { y: number; r: number; g: number; b: number }[] = [];
    for (let i = 1; i <= 15; i++) {
      const c = (pal16 && pal16[i]) ?? 0;
      const [r, g, b] = bgr555_to_rgb(c);
      const y = 0.2126 * (r / 255) + 0.7152 * (g / 255) + 0.0722 * (b / 255);
      entries.push({ y, r, g, b });
    }
    if (entries.length === 0) return gray_ramp();
    luaSort(entries, (a, b) => a.y > b.y);
    const ramp: Ramp = [];
    for (let s = 0; s < 4; s++) {
      const idx = 1 + Math.floor(s * (entries.length - 1) / 3 + 0.5);
      const e = entries[idx - 1]!;
      ramp[s] = [Math.floor(e.r + 0.5), Math.floor(e.g + 0.5), Math.floor(e.b + 0.5)];
    }
    return ramp;
  },

  // Semantic families: groups in different families avoid sharing a Gen2 slot
  // until we are forced to by the 8-slot budget.
  CAT_FAMILY: {
    WATER: "blue",
    TREE: "green",
    SHORT_GRASS: "green",
    TALL_GRASS: "green",
    SAND: "yellow",
    CLIFF: "brown",
    COAST_CLIFF: "brown",
    ROCK_DECK: "brown",
    LEDGE: "brown",
    BUILDING: "struct",
    DOOR: "struct",
    SIGN: "struct",
    PATH: "path",
    TOWN_PATH: "path",
    PIER: "path",
    STAIR: "path",
    CAVE: "brown",
    BLOCKED: "path",
  } as Record<string, string>,

  /**
   * Lua: quantize.lua:353 -- Build <=8 Gen2 slots from FRLG-palette groups
   * (joint / context-aware). Returns map key -> slot (1..8) and writes
   * sheet.palettes.
   */
  mapGroupsToSlots(sheet: Sheet, groups: SlotGroup[]): Record<string, number> {
    sheet.palettes = [];
    sheet.paletteCounts = [];
    const keyToSlot: Record<string, number> = {};
    if (groups.length === 0) {
      sheet.palettes[0] = gray_ramp();
      sheet.paletteCounts[0] = 1;
      return keyToSlot;
    }

    const G: { key: string; ramp: Ramp; count: number; family: string }[] = [];
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i]!;
      let fam = g.family;
      if (!fam && g.categoryVotes) fam = family_of(majority_key(g.categoryVotes));
      G[i] = { key: g.key, ramp: copy_ramp(g.ramp), count: g.count ?? 1, family: fam ?? "path" };
    }
    luaSort(G, (a, b) => {
      if (a.count !== b.count) return a.count > b.count;
      return a.key < b.key;
    });

    // One seed per family from the most-used group in that family.
    interface Seed { ramp: Ramp; family: string; members: number[]; count: number }
    const seeds: Seed[] = [];
    const used: boolean[] = [];
    const familiesSeen: Record<string, boolean> = {};
    for (let i = 0; i < G.length; i++) {
      const fam = G[i]!.family;
      if (!familiesSeen[fam] && seeds.length < 8) {
        familiesSeen[fam] = true;
        used[i] = true;
        seeds.push({ ramp: copy_ramp(G[i]!.ramp), family: fam, members: [i], count: G[i]!.count });
      }
    }

    // Leftovers: merge into nearest same-family seed, or split if hue is far
    // and we still have free Gen2 slots (roof red vs wall blue).
    for (let i = 0; i < G.length; i++) {
      if (!used[i]) {
        let bestS = 0, bestD = Infinity; // Lua bestS = 1 (0-based here)
        let bestSameS: number | undefined, bestSameD = Infinity;
        for (let s = 0; s < seeds.length; s++) {
          const d = ramp_dist2(seeds[s]!.ramp, G[i]!.ramp);
          let dPen = d;
          if (seeds[s]!.family !== G[i]!.family) {
            dPen = d + FAMILY_CROSS_PENALTY;
          } else if (d < bestSameD) {
            bestSameS = s; bestSameD = d;
          }
          if (dPen < bestD) { bestS = s; bestD = dPen; }
        }
        if (bestSameS !== undefined && bestSameD > FAMILY_SPLIT_DIST && seeds.length < 8) {
          used[i] = true;
          seeds.push({ ramp: copy_ramp(G[i]!.ramp), family: G[i]!.family, members: [i], count: G[i]!.count });
        } else {
          const seed = seeds[bestSameS ?? bestS]!;
          seed.members.push(i);
          blend_ramp(seed.ramp, G[i]!.ramp, seed.count);
          seed.count = seed.count + G[i]!.count;
          used[i] = true;
        }
      }
    }

    for (let s = 0; s < seeds.length; s++) {
      sheet.palettes[s] = seeds[s]!.ramp;
      sheet.paletteCounts[s] = seeds[s]!.count;
      for (const gi of seeds[s]!.members) keyToSlot[G[gi]!.key] = s + 1;
    }
    return keyToSlot;
  },

  /**
   * Lua: quantize.lua:446 -- Snap a mid's four quadrant slots toward majority
   * when they disagree weakly. slots/ramps are length-4 (0-based here).
   * (The pairs() walk over the counts only decides ties below 3, which return
   * early, so the order does not matter.)
   */
  cohereMetatileSlots(slots: (number | undefined)[], ramps: Ramp[]): (number | undefined)[] {
    const counts = new Map<number, number>();
    for (let i = 0; i < 4; i++) {
      const s = slots[i] ?? 1;
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    let maj = slots[0] ?? 1, majN = 0;
    for (const [s, n] of counts) {
      if (n > majN) { maj = s; majN = n; }
    }
    if (majN < 3) return slots; // only snap clear 3-1 majorities
    let majRamp: Ramp | undefined;
    for (let i = 0; i < 4; i++) {
      if (slots[i] === maj) { majRamp = ramps[i]; break; }
    }
    if (!majRamp) return slots;
    const out = [slots[0], slots[1], slots[2], slots[3]];
    for (let i = 0; i < 4; i++) {
      if (out[i] !== maj) {
        const d = ramp_dist2(ramps[i]!, majRamp);
        // Allow snap when the odd tile is not a wildly different material.
        if (d <= Quantize.RAMP_MERGE_DIST * 3) out[i] = maj;
      }
    }
    return out;
  },

  /**
   * Lua: quantize.lua:477 -- Outdoor LAB: snap a mid's four codebook indices on
   * a clear 3-1 majority. undefined entries (void quads) are left alone and do
   * not vote. (Ties break on the smaller index, so pairs() order is moot.)
   */
  cohereCodebookIndices(indices: (number | undefined)[]): (number | undefined)[] {
    const counts = new Map<number, number>();
    for (let i = 0; i < 4; i++) {
      const s = indices[i];
      if (s !== undefined) counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    let maj: number | undefined, majN = 0;
    for (const [s, n] of counts) {
      if (n > majN || (n === majN && (maj === undefined || s < maj))) { maj = s; majN = n; }
    }
    if (maj === undefined || majN < 3) return indices;
    const out = [indices[0], indices[1], indices[2], indices[3]];
    for (let i = 0; i < 4; i++) {
      if (out[i] !== undefined && out[i] !== maj) out[i] = maj;
    }
    return out;
  },

  // Lua: quantize.lua:501
  categoryFamily(category: string | undefined): string {
    return Quantize.CAT_FAMILY[category ?? ""] ?? "path";
  },

  // Lua: quantize.lua:516 -- Nearest existing Gen2 slot for a ramp (no create / no blend). Returns 1..8.
  nearestPaletteSlot(sheet: Sheet, ramp: Ramp): number {
    let best = 1, bestD = Infinity;
    const n = seqLen(sheet.palettes);
    for (let i = 1; i <= n; i++) {
      const d = ramp_dist2(sheet.palettes[i - 1]!, ramp);
      if (d < bestD) { best = i; bestD = d; }
    }
    return best;
  },

  /**
   * Lua: quantize.lua:527 -- Seed <=8 GBC slots via farthest-point sampling,
   * biased toward high-chroma ramps.
   */
  seedPalettes(sheet: Sheet, ramps: Ramp[]): void {
    if (ramps.length === 0) {
      sheet.palettes[0] = gray_ramp();
      sheet.paletteCounts[0] = 1;
      return;
    }
    const scored: { ramp: Ramp; chroma: number; i: number }[] = [];
    for (let i = 0; i < ramps.length; i++) scored[i] = { ramp: ramps[i]!, chroma: ramp_chroma(ramps[i]!), i: i + 1 };
    luaSort(scored, (a, b) => {
      if (a.chroma !== b.chroma) return a.chroma > b.chroma;
      return a.i < b.i;
    });
    const candN = Math.max(8, Math.min(scored.length, Math.floor(scored.length / 2)));
    const seeds: Ramp[] = [scored[0]!.ramp];
    while (seeds.length < 8 && seeds.length < candN) {
      let bestIdx: number | undefined, bestMin = -1;
      for (let ci = 1; ci <= candN; ci++) {
        // the Lua indexes scored[ci] past #scored when candN > #scored (an error there)
        const ramp = scored[ci - 1]!.ramp;
        let minD = Infinity;
        for (let s = 0; s < seeds.length; s++) {
          const d = ramp_dist2(seeds[s]!, ramp);
          if (d < minD) minD = d;
        }
        if (minD > bestMin) { bestMin = minD; bestIdx = ci; }
      }
      if (bestIdx === undefined || bestMin <= Quantize.RAMP_MERGE_DIST) break;
      seeds.push(scored[bestIdx - 1]!.ramp);
    }
    for (let i = 0; i < seeds.length; i++) {
      sheet.palettes[i] = copy_ramp(seeds[i]!);
      sheet.paletteCounts[i] = 1;
    }
  },

  // Lua: quantize.lua:567 -- Assign (or merge) a demake ramp into one of 8 Gen2 BG slots. Returns 1..8.
  assignPaletteSlot(sheet: Sheet, ramp: Ramp): number | undefined {
    let best: number | undefined, bestD = Infinity;
    const n = seqLen(sheet.palettes);
    for (let i = 1; i <= n; i++) {
      const d = ramp_dist2(sheet.palettes[i - 1]!, ramp);
      if (d < bestD) { best = i; bestD = d; }
    }
    if (best !== undefined && bestD <= Quantize.RAMP_MERGE_DIST) {
      // Near-duplicate of an existing slot: refine centroid.
      blend_ramp(sheet.palettes[best - 1]!, ramp, sheet.paletteCounts[best - 1]!);
      sheet.paletteCounts[best - 1] = sheet.paletteCounts[best - 1]! + 1;
      return best;
    }
    if (n < 8) {
      const i = n + 1;
      sheet.palettes[i - 1] = copy_ramp(ramp);
      sheet.paletteCounts[i - 1] = 1;
      return i;
    }
    // All 8 slots taken and not near any: keep seed hues pure (no blend).
    return best;
  },

  /**
   * Lua: quantize.lua:593 -- Intern a 2bpp tile by bit pattern only.
   * gen2Slot is accepted for call-site compatibility but ignored for identity.
   */
  intern(sheet: Sheet, bpp16: number[], _gen2Slot?: number): number {
    const key = Quantize.tileKey(bpp16);
    const existing = Object.prototype.hasOwnProperty.call(sheet.keys, key) ? sheet.keys[key] : undefined;
    if (existing !== undefined) return existing;
    const id = sheet.count;
    sheet.count = id + 1;
    sheet.keys[key] = id;
    sheet.tiles[id] = bpp16;
    return id;
  },

  // Lua: quantize.lua:606 -- Always allocate a new tile id (no bpp dedupe).
  internUnique(sheet: Sheet, bpp16: number[]): number {
    const id = sheet.count;
    sheet.count = id + 1;
    sheet.tiles[id] = bpp16;
    // Deliberately omit sheet.keys -- content may still dedupe the same bpp.
    return id;
  },

  /**
   * Lua: quantize.lua:616 -- Pack sheet tiles into a contiguous 2bpp byte
   * string, 16 per row by default: [raw, width, height].
   */
  sheetToRaw(sheet: Sheet, tilesPerRow = 16): [string, number, number] {
    const n = sheet.count;
    if (n === 0) return ["", 0, 0];
    const rows = Math.ceil(n / tilesPerRow);
    const width = tilesPerRow * 8;
    const height = rows * 8;
    const expected = width * height / 4; // 2bpp
    const raw = new Array<number>(expected).fill(0);
    for (let tid = 0; tid < n; tid++) {
      const tile = sheet.tiles[tid]!;
      const col = tid % tilesPerRow;
      const row = Math.floor(tid / tilesPerRow);
      const destTile = row * tilesPerRow + col;
      const base = destTile * 16;
      for (let b = 0; b < 16; b++) raw[base + b] = tile[b] ?? 0;
    }
    let s = "";
    for (let i = 0; i < raw.length; i++) s += String.fromCharCode(raw[i]!);
    return [s, width, height];
  },

  /**
   * Lua: quantize.lua:651 -- Ensure special-tileset slots exist (fill unused
   * with gray). At least 8 for stock Gen2.
   */
  finalizePalettes(sheet: Sheet): Ramp[] {
    let n = 8;
    for (let i = 1; i <= Quantize.MAX_PALETTE_SLOTS; i++) {
      if (sheet.palettes[i - 1]) n = i;
    }
    if (n < 8) n = 8;
    const pals: Ramp[] = [];
    for (let i = 0; i < n; i++) {
      pals[i] = sheet.palettes[i] ? copy_ramp(sheet.palettes[i]!) : gray_ramp();
    }
    return pals;
  },

  bgr555_to_y,
  bgr555_to_rgb,
  copy_ramp,
  ramp_dist2,
};

export default Quantize;
