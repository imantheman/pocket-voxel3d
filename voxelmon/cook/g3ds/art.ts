// voxelmon/cook/g3ds/art.ts — what each metatile of a tileset pair is a
// picture of: the art statistics, the ground colours, the shape surface and
// the role table.
//
// MIT. Ported from UNDERdecoded/Gen2Recomped-DramaticShapes (MIT, Copyright
// (c) 2026 DramaticShape, modified by UNDERdecodedHD; THIRD_PARTY_NOTICES.md)
// at 726782f:
//   analyse()        lib/Gen3.lua:5499 analyse
//   shape surface    lib/Gen3.lua:5866 bakeShape, :6094 shapeDataForMap
//   roles            tools/gen3_metatiles_gen.lua (the generator his
//                    data/gen3_metatiles.lua was built with)
//
// FRLG TRANSLATION. His `data/gen3_metatiles.lua` is generated from
// Emerald's maps and is Emerald-only data, so it is not used: the generator
// itself is ported and run on each FRLG pair at cook time, over that pair's
// own palette and the FRLG maps that place it. (His generator profiles a
// tileset through one representative map's pair; here every pair is
// profiled through its own palette, which is the reading his own comment
// says the representative map was trying to approximate.)
//
// LAYERS. His "layer 1" is a metatile's bottom tiles and "layer 2" its top
// tiles (Gen3Tiles.bakeLayer). The FRLG cache keeps BG3+BG2 (`pair.under`)
// and BG1, drawn over the player (`pair.over`, 0 = clear). For the common
// layer type (NORMAL) those are exactly his two layers; for a COVERED
// metatile the top tiles are drawn under the player and the cache folds them
// into `under`, so its `n2` reads 0 here. That only ever moves a ground
// sample (the background vote) and never a cell's class.

import type { FrPair } from "../gen3.ts";

const CELL = 16;
/** lib/Gen3.lua:5497 GROUND_SAMPLE */
const GROUND_SAMPLE = 192;

export interface SlotStats {
  n1: number;
  n2: number;
  solidN: number;
  top2: number;
  bot2: number;
  topSolid: number;
  botSolid: number;
  rows2: number[];
  leaf: number;
  leaf2: number;
  warm: number;
  dark: number;
  bright: number;
  r: number;
  g: number;
  b: number;
  mr: number;
  mg: number;
  mb: number;
  solid: number;
  leafFrac: number;
  leafFrac2: number;
  leafy: boolean;
  overhead: boolean;
  rowsCovered: number;
  overhang: boolean;
  warmth: number;
  darkness: number;
  brightness: number;
  seamless: boolean;
}

/** A role row (gen3_metatiles.lua): { art, material, cap, face, kind, motif, axis, facing, ledge }. */
export interface Role {
  art: "surface" | "face" | "brow" | "banded";
  material: string;
  cap: number;
  face: number;
  kind: string;
  motif: boolean;
  axis: string;
  facing: string;
  ledge: boolean;
  nFace: number;
}

export interface PairArt {
  pair: FrPair;
  slots: number;
  stats: SlotStats[];
  /** The background (ground) colours, as rgb keys. */
  background: Set<number>;
  objectHist: Map<number, number>;
  /** Composite colour of a slot texel, 0..255 channels. */
  rgbAt(slot: number, x: number, y: number): [number, number, number];
  /** True when a slot texel is on the over layer. */
  overAt(slot: number, x: number, y: number): boolean;
}

export const rgbKey = (c: [number, number, number]): number => c[0] * 65536 + c[1] * 256 + c[2];

const artCache = new WeakMap<FrPair, PairArt>();

/** lib/Gen3.lua:5499 analyse, over one pair. */
export function analysePair(pair: FrPair): PairArt {
  const hit = artCache.get(pair);
  if (hit) return hit;
  const W = pair.cols * 16;
  const slots = pair.cols * pair.rows;
  const idx = (slot: number, x: number, y: number) =>
    (Math.floor(slot / pair.cols) * 16 + y) * W + (slot % pair.cols) * 16 + x;
  const overAt = (slot: number, x: number, y: number) => pair.over[idx(slot, x, y)] !== 0;
  const rgbAt = (slot: number, x: number, y: number): [number, number, number] => {
    const i = idx(slot, x, y);
    const o = pair.over[i]!;
    return pair.rgb[o !== 0 ? o : pair.under[i]!]!;
  };
  const stats: SlotStats[] = [];
  for (let s = 0; s < slots; s++) {
    stats.push({
      n1: 0, n2: 0, solidN: 0, top2: 0, bot2: 0, topSolid: 0, botSolid: 0, rows2: new Array(16).fill(0),
      leaf: 0, leaf2: 0, warm: 0, dark: 0, bright: 0, r: 0, g: 0, b: 0, mr: 0, mg: 0, mb: 0,
      solid: 0, leafFrac: 0, leafFrac2: 0, leafy: false, overhead: false, rowsCovered: 0, overhang: false,
      warmth: 0, darkness: 0, brightness: 0, seamless: false,
    });
  }
  // PASS ONE: the top layer
  const objectHist = new Map<number, number>();
  for (let s = 0; s < slots; s++) {
    const st = stats[s]!;
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const i = idx(s, x, y);
        const o = pair.over[i]!;
        if (o === 0) continue;
        st.n2++;
        if (y < 8) st.top2++;
        else st.bot2++;
        st.rows2[y]!++;
        const c = rgbKey(pair.rgb[o]!);
        objectHist.set(c, (objectHist.get(c) ?? 0) + 1);
      }
    }
  }
  // PASS TWO: the bottom layer, for the ground histogram and the edge strips
  const groundHist = new Map<number, number>();
  const seamlessHist = new Map<number, number>();
  for (let s = 0; s < slots; s++) {
    const st = stats[s]!;
    const L: number[] = [];
    const R: number[] = [];
    const T: number[] = [];
    const B: number[] = [];
    const all: number[] = [];
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const c = rgbKey(pair.rgb[pair.under[idx(s, x, y)]!]!);
        st.n1++;
        if (st.n2 >= GROUND_SAMPLE) groundHist.set(c, (groundHist.get(c) ?? 0) + 1);
        if (x === 0) L[y] = c;
        else if (x === 15) R[y] = c;
        if (y === 0) T[x] = c;
        else if (y === 15) B[x] = c;
        all.push(c);
      }
    }
    // WHICH METATILES TILE (Gen3.lua:5565)
    if (st.n2 === 0) {
      let okH = true;
      let okV = true;
      for (let i = 0; i < 16; i++) {
        if (L[i] !== R[i]) okH = false;
        if (T[i] !== B[i]) okV = false;
      }
      let distinct = 0;
      let leafish = 0;
      if (okH && okV) {
        const seen = new Set<number>();
        for (const c of all) {
          if (!seen.has(c)) {
            seen.add(c);
            distinct++;
          }
          const r = Math.floor(c / 65536);
          const g = Math.floor(c / 256) % 256;
          const b = c % 256;
          if (g > r * 1.1 && g > b * 1.35) leafish++;
        }
      }
      if (okH && okV && distinct >= 3 && leafish <= all.length * 0.5) {
        st.seamless = true;
        for (const c of all) seamlessHist.set(c, (seamlessHist.get(c) ?? 0) + 1);
      }
    }
  }
  // INDOORS THERE IS NOTHING DRAWN ON TOP OF THE FLOOR (Gen3.lua:5626)
  {
    let have = 0;
    for (const n of groundHist.values()) have += n;
    if (have < 2048) for (const [c, n] of seamlessHist) groundHist.set(c, (groundHist.get(c) ?? 0) + n);
  }
  // THE BACKGROUND SET (Gen3.lua:5640)
  const background = new Set<number>();
  let groundTotal = 0;
  for (const n of groundHist.values()) groundTotal += n;
  if (groundTotal > 0) {
    for (const [c, n] of groundHist) {
      if (n >= groundTotal * 0.002 && (objectHist.get(c) ?? 0) < n * 0.5) background.add(c);
    }
  }
  // PASS THREE: the object's own colours (Gen3.lua:5661 tally)
  const tally = (st: SlotStats, y: number, c: [number, number, number], layer: 1 | 2) => {
    if (layer === 1 && background.has(rgbKey(c))) return;
    const [r, g, b] = c;
    st.solidN++;
    if (y < 8) st.topSolid++;
    else st.botSolid++;
    st.r += r / 255;
    st.g += g / 255;
    st.b += b / 255;
    if (g > r * 1.1 && g > b * 1.35) {
      st.leaf++;
      if (layer === 2) st.leaf2++;
    }
    if (r > g * 1.05 && r > b * 1.1) st.warm++;
    const mx = Math.max(r, g, b) / 255;
    if (mx < 0.35) st.dark++;
    if (mx > 0.8) st.bright++;
  };
  for (let s = 0; s < slots; s++) {
    const st = stats[s]!;
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) tally(st, y, pair.rgb[pair.under[idx(s, x, y)]!]!, 1);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const o = pair.over[idx(s, x, y)]!;
        if (o !== 0) tally(st, y, pair.rgb[o]!, 2);
      }
    }
  }
  for (const st of stats) {
    const n = st.solidN > 0 ? st.solidN : 1;
    st.mr = st.r / n;
    st.mg = st.g / n;
    st.mb = st.b / n;
    st.solid = Math.min(1, st.solidN / 256);
    st.leafFrac = st.leaf / n;
    st.leafFrac2 = st.leaf2 / n;
    st.leafy = st.solid > 0.25 && st.leafFrac > 0.5 && st.mb < st.mg * 0.66;
    st.overhead = st.n2 >= GROUND_SAMPLE;
    let full2 = 0;
    for (let row = 0; row < 16; row++) if (st.rows2[row]! >= 8) full2++;
    st.rowsCovered = full2;
    st.overhang = full2 >= CELL - 2;
    st.warmth = st.warm / n;
    st.darkness = st.dark / n;
    st.brightness = st.bright / n;
  }
  const art: PairArt = { pair, slots, stats, background, objectHist, rgbAt, overAt };
  artCache.set(pair, art);
  return art;
}

/**
 * The SHAPE SURFACE (Gen3.lua:5866 bakeShape, :6094 shapeDataForMap): the
 * composite with every bottom-layer texel painted in a ground colour (and
 * nothing over it) cut away. Per map, the map's own floor metatiles add
 * their colours to the background (shapeDataForMap). `solidFrac` per slot
 * is Gen3.solidForMap.
 */
export interface ShapeSurface {
  opaque(slot: number, x: number, y: number): boolean;
  solidFrac: Float32Array;
}

export function shapeSurface(art: PairArt, floorSlots: number[]): ShapeSurface {
  const pair = art.pair;
  const W = pair.cols * 16;
  const idx = (slot: number, x: number, y: number) =>
    (Math.floor(slot / pair.cols) * 16 + y) * W + (slot % pair.cols) * 16 + x;
  const background = new Set(art.background);
  if (floorSlots.length > 0) {
    const floorHist = new Map<number, number>();
    let floorTotal = 0;
    for (const s of floorSlots) {
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          const c = rgbKey(pair.rgb[pair.under[idx(s, x, y)]!]!);
          floorHist.set(c, (floorHist.get(c) ?? 0) + 1);
          floorTotal++;
        }
      }
    }
    for (const [c, n] of floorHist) {
      if (n >= floorTotal * 0.002 && (art.objectHist.get(c) ?? 0) < n * 0.5) background.add(c);
    }
  }
  const mask = new Uint8Array(art.slots * 256);
  const solidFrac = new Float32Array(art.slots);
  for (let s = 0; s < art.slots; s++) {
    let n = 0;
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const i = idx(s, x, y);
        const on = pair.over[i] !== 0 || !background.has(rgbKey(pair.rgb[pair.under[i]!]!));
        if (on) {
          mask[s * 256 + y * 16 + x] = 1;
          n++;
        }
      }
    }
    solidFrac[s] = Math.min(1, n / 256);
  }
  return { opaque: (slot, x, y) => mask[slot * 256 + y * 16 + x] === 1, solidFrac };
}

// ---------------------------------------------------------------------------
// the role table (tools/gen3_metatiles_gen.lua)
// ---------------------------------------------------------------------------

/** gen3_metatiles_gen.lua mat(): what a pixel is drawn in. */
function mat(r: number, g: number, b: number): string {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  if (mx - mn <= 22) {
    if (mx > 205) return "stone";
    if (mx > 95) return "grey";
    return "dark";
  }
  if (b === mx && b - r > 35) return "water";
  if (g === mx && g - r > 22) return "green";
  if (r === mx && r - b > 12) {
    if (g - b < (r - g) * 0.9 + 6) return "rock";
    return "sand";
  }
  if (b === mx) return "water";
  if (g === mx) return "green";
  return "other";
}
const SURFACE = new Set(["green", "sand", "stone"]);
const FACE_M = new Set(["rock", "grey", "dark"]);

/**
 * One role row per slot (gen3_metatiles_gen.lua's classifier). `kindOf`
 * gives the behaviour family of a slot (water / ledge / mountain / ""), and
 * `downOf` the commonest slot placed directly below it on the pair's maps
 * (the census's `down` field), for the motif pass.
 */
export function rolesFor(
  art: PairArt,
  kindOf: (slot: number) => string,
  downOf: (slot: number) => number | undefined,
  used: (slot: number) => boolean,
): (Role | undefined)[] {
  const rows: (Role | undefined)[] = [];
  for (let s = 0; s < art.slots; s++) {
    if (!used(s)) continue;
    const prof: string[] = [];
    const count = new Map<string, number>();
    const rowL: number[] = [];
    const colL: number[] = new Array(16).fill(0);
    for (let y = 0; y < 16; y++) {
      const tally = new Map<string, number>();
      let acc = 0;
      for (let x = 0; x < 16; x++) {
        const [r, g, b] = art.rgbAt(s, x, y);
        const k = mat(r, g, b);
        tally.set(k, (tally.get(k) ?? 0) + 1);
        const L = (r + g + b) / 3;
        acc += L;
        colL[x]! += L;
      }
      rowL.push(acc / 16);
      // a tie between two materials is broken by name (lowest wins)
      let best = "none";
      let bn = 0;
      for (const k of [...tally.keys()].sort()) {
        const v = tally.get(k)!;
        if (v > bn) {
          best = k;
          bn = v;
        }
      }
      prof.push(best);
      count.set(best, (count.get(best) ?? 0) + 1);
    }
    for (let x = 0; x < 16; x++) colL[x] = colL[x]! / 16;
    let cap = 0;
    while (cap < 16 && SURFACE.has(prof[cap]!)) cap++;
    let trailCap = 0;
    while (trailCap < 16 && SURFACE.has(prof[15 - trailCap]!)) trailCap++;
    let faceRun = 0;
    for (let y = cap; y < 16; y++) {
      if (FACE_M.has(prof[y]!)) faceRun++;
      else break;
    }
    let nSurf = 0;
    let nFace = 0;
    for (const p of prof) {
      if (SURFACE.has(p)) nSurf++;
      else if (FACE_M.has(p)) nFace++;
    }
    const band = (t: number[]): [number, number] => {
      let lo = t[0]!;
      let hi = t[0]!;
      for (const L of t) {
        if (L < lo) lo = L;
        if (L > hi) hi = L;
      }
      let rep = 0;
      for (let i = 0; i < 8; i++) rep += Math.abs(t[i]! - t[i + 8]!);
      return [hi - lo, rep / 8];
    };
    const [dRow, pRow] = band(rowL);
    const [dCol, pCol] = band(colL);
    const rowBanded = dRow >= 55 && pRow <= 16;
    const colBanded = dCol >= 55 && pCol <= 16;
    const periodic = rowBanded || colBanded;
    let ledge = false;
    for (let y = 1; y < 15; y++) {
      const L = rowL[y]!;
      if (rowL[y - 1]! - L >= 40 && rowL[y + 1]! - L >= 40) {
        ledge = true;
        break;
      }
    }
    let axis = "";
    if (rowBanded && colBanded) axis = dRow >= dCol ? "y" : "x";
    else if (rowBanded) axis = "y";
    else if (colBanded) axis = "x";
    const rocky = count.get("rock") ?? 0;
    const manmade = (count.get("grey") ?? 0) + (count.get("stone") ?? 0) + (count.get("other") ?? 0);
    const greeny = count.get("green") ?? 0;
    const sandy = count.get("sand") ?? 0;
    const watery = count.get("water") ?? 0;
    let material: string;
    if (watery >= 10) material = "water";
    else if (rocky >= manmade && rocky >= greeny && rocky >= sandy && rocky > 0) material = "rock";
    else if (greeny >= manmade && greeny >= sandy && greeny > 0) material = "green";
    else if (sandy >= manmade && sandy > 0) material = "sand";
    else if (manmade > 0) material = "manmade";
    else material = "other";
    let facing = "";
    if (nFace > 0) {
      if (cap > trailCap) facing = "S";
      else if (trailCap > cap) facing = "N";
    }
    let a: Role["art"];
    if (periodic && material !== "water" && material !== "green") a = "banded";
    else if (nFace === 0) a = "surface";
    else if (nSurf === 0) a = "face";
    else a = "brow";
    rows[s] = { art: a, material, cap, face: faceRun, kind: kindOf(s), motif: false, axis, facing, ledge, nFace };
  }
  // PASS 2: A CAP MUST HAVE A FACE UNDER IT (the motif mark)
  for (let s = 0; s < rows.length; s++) {
    const rr = rows[s];
    if (!rr || rr.art !== "surface" || rr.material === "water") continue;
    let cur = s;
    let ok = false;
    const seen = new Set<number>();
    for (let i = 0; i < 4; i++) {
      const d = downOf(cur);
      if (d === undefined || seen.has(d)) break;
      seen.add(d);
      const rd = rows[d];
      if (!rd) break;
      if (rd.nFace > 0) {
        ok = true;
        break;
      }
      // (the generator's `role == "floor" or "water"` break never fires: a
      // row's role IS its art family, so it is left out)
      cur = d;
    }
    rr.motif = !ok;
  }
  return rows;
}
