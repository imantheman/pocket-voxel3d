// Port of gen1recomp src/ui/game3/region_map_gpu.lua (GPLv3 + additional terms; see LICENSE.md).
// The Town Map's GBA display registers (blend, windows, backdrop) and the
// compositor that draws its BG/OBJ layers through them with the
// `region_map` effect (Brian's shader at region_map_gpu.lua:138), plus the
// region_map/ cache images, frame quads and manifest.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { Dataset } from "../core/dataset.ts";
// src.import.gba.extract_island1's CACHE_ROOT forwards to CachePaths
// (extract_island1.lua:21), so that is read directly, as dataset.ts does.
import { CachePaths } from "../core/cache_paths.ts";
import { RegionMapExtract as RegionExtract } from "../../../import/gen3/region_map_extract.ts";
import { G, type Shader } from "../platform/graphics.ts";
import { FileData, newImageData, type Image, type Quad } from "../platform/image.ts";
import { luaLoad } from "../platform/luadata.ts";
import { ipairs, len, pairs, seq, toArray, unpack, type LuaTable } from "../platform/lt.ts";

/** A window rectangle {l, t, r, b} (a Lua sequence). */
export type Rect = LuaTable;

export interface GpuRegs {
  tgt1: number; tgt2: number; effect: number; bldy: number; eva: number; evb: number;
  winin0: number; winin1: number; winout: number;
  win0: Rect; win1: Rect;
  win0on: boolean; win1on: boolean;
  [k: string]: any;
}

export interface Region { rects: LuaTable; mask: number }

/** One BG/OBJ layer handed to compose. */
export interface Layer { bit: number; obj?: boolean; tone?: LuaTable; draw: (alpha: number) => void }

/** compose's palette state: the fade levels and the backdrop colour. */
export interface PalState { bgFade: number; objFade: number; backdrop: LuaTable }

// Lua: region_map_gpu.lua:85
function rectOf(dims: Rect): Rect | undefined {
  const l = dims[1], t = dims[2];
  let r = dims[3], b = dims[4];
  if (r > Gpu.W || l > r) r = Gpu.W;
  if (b > Gpu.H || t > b) b = Gpu.H;
  if (r <= l || b <= t) return undefined;
  return seq(l, t, r, b);
}

// Lua: region_map_gpu.lua:93
function subtract(rects: LuaTable, cut: Rect): LuaTable {
  const out: LuaTable = seq();
  for (const [, r] of ipairs(rects)) {
    const l = r[1], t = r[2], rr = r[3], b = r[4];
    const cl = Math.max(l, cut[1]), ct = Math.max(t, cut[2]), cr = Math.min(rr, cut[3]), cb = Math.min(b, cut[4]);
    if (cl >= cr || ct >= cb) {
      out[len(out) + 1] = r;
    } else {
      if (t < ct) out[len(out) + 1] = seq(l, t, rr, ct);
      if (cb < b) out[len(out) + 1] = seq(l, cb, rr, b);
      if (l < cl) out[len(out) + 1] = seq(l, ct, cl, cb);
      if (cr < rr) out[len(out) + 1] = seq(cr, ct, rr, cb);
    }
  }
  return out;
}

let shader: Shader | undefined;
// Lua: region_map_gpu.lua:159
function getShader(): Shader {
  if (!shader) shader = G.newShader("region_map");
  return shader;
}

// Lua: region_map_gpu.lua:164
function has(mask: number, b: number): boolean {
  return (mask & b) !== 0;
}

// Lua: region_map_gpu.lua:214
function cacheDir(): string {
  return CachePaths.CACHE_ROOT + "/" + RegionExtract.CACHE_SUB + "/";
}

// Lua: region_map_gpu.lua:219
function readCache(rel: string): string {
  const d = Dataset.cache().read(rel);
  if (d == null) throw new Error(rel + " is not in the cache");
  return d;
}

const quads: Record<string, Quad> = {};
let manifest: any;

export const Gpu = {
  W: 240,
  H: 160,

  BG0: 1, BG1: 2, BG2: 4, BG3: 8, OBJ: 16,
  CLR: 32,
  BD: 32,
  BG_ALL: 15,
  ALL: 63,

  NONE: 0, BLEND: 1, LIGHTEN: 2, DARKEN: 3,

  // Lua: region_map_gpu.lua:16
  new(): GpuRegs {
    return {
      tgt1: 0, tgt2: 0, effect: Gpu.NONE, bldy: 0, eva: 0, evb: 0,
      winin0: 0, winin1: 0, winout: 0,
      win0: seq(0, 0, 0, 0), win1: seq(0, 0, 0, 0),
      win0on: false, win1on: false,
    };
  },

  // src/region_map.c:3711 ResetGpuRegs
  // Lua: region_map_gpu.lua:26
  reset(g: GpuRegs): void {
    [g.tgt1, g.tgt2, g.effect] = [0, 0, Gpu.NONE];
    g.bldy = 0;
    g.win0 = seq(0, 0, 0, 0);
    g.win1 = seq(0, 0, 0, 0);
    [g.winin0, g.winin1] = [0, 0];
    [g.win0on, g.win1on] = [false, false];
  },

  // src/region_map.c:3723 SetBldCnt
  // Lua: region_map_gpu.lua:36
  setBldCnt(g: GpuRegs, tgt2: number, tgt1: number, effect: number): void {
    [g.tgt2, g.tgt1, g.effect] = [tgt2, tgt1, effect];
  },

  // src/region_map.c:3731 SetBldY
  // Lua: region_map_gpu.lua:41
  setBldY(g: GpuRegs, y: number): void {
    g.bldy = y;
  },

  // src/region_map.c:3736 SetBldAlpha
  // Lua: region_map_gpu.lua:46
  setBldAlpha(g: GpuRegs, evb: number, eva: number): void {
    [g.evb, g.eva] = [evb, eva];
  },

  // src/region_map.c:3743 SetWinIn
  // Lua: region_map_gpu.lua:51
  setWinIn(g: GpuRegs, win0: number, win1: number): void {
    [g.winin0, g.winin1] = [win0, win1];
  },

  // src/region_map.c:3750 SetWinOut
  // Lua: region_map_gpu.lua:56
  setWinOut(g: GpuRegs, mask: number): void {
    g.winout = mask;
  },

  // src/region_map.c:3755 SetDispCnt
  // Lua: region_map_gpu.lua:61
  setDispCnt(g: GpuRegs, idx: number, clear: boolean): void {
    if (idx === 0) g.win0on = !clear; else g.win1on = !clear;
  },

  // src/region_map.c:3770 SetGpuWindowDims
  // Lua: region_map_gpu.lua:66
  setWindowDims(g: GpuRegs, idx: number, l: number, t: number, r: number, b: number): void {
    const dims = seq(l, t, r, b);
    if (idx === 0) g.win0 = dims; else g.win1 = dims;
  },

  // src/region_map.c:3670 SaveRegionMapGpuRegs
  // Lua: region_map_gpu.lua:72
  save(g: GpuRegs): Record<string, any> {
    return {
      tgt1: g.tgt1, tgt2: g.tgt2, effect: g.effect, bldy: g.bldy, eva: g.eva, evb: g.evb,
      winin0: g.winin0, winin1: g.winin1, winout: g.winout,
      win0: seq(...unpack(g.win0)), win1: seq(...unpack(g.win1)),
    };
  },

  // src/region_map.c:3687 SetRegionMapGpuRegs
  // Lua: region_map_gpu.lua:81
  restore(g: GpuRegs, saved: Record<string, any>): void {
    for (const [k, v] of pairs(saved)) g[k as string] = v;
  },

  // Lua: region_map_gpu.lua:110
  regions(g: GpuRegs): LuaTable {
    const full = seq(0, 0, Gpu.W, Gpu.H);
    if (!g.win0on && !g.win1on) {
      return seq<Region>({ rects: seq(full), mask: Gpu.ALL });
    }
    const out: LuaTable = seq(), covered: LuaTable = seq();
    if (g.win0on) {
      const r = rectOf(g.win0);
      if (r) {
        out[len(out) + 1] = { rects: seq(r), mask: g.winin0 };
        covered[len(covered) + 1] = r;
      }
    }
    if (g.win1on) {
      const r = rectOf(g.win1);
      if (r) {
        let rs: LuaTable = seq(r);
        for (const [, c] of ipairs(covered)) rs = subtract(rs, c);
        out[len(out) + 1] = { rects: rs, mask: g.winin1 };
        covered[len(covered) + 1] = r;
      }
    }
    let rest: LuaTable = seq(full);
    for (const [, c] of ipairs(covered)) rest = subtract(rest, c);
    out[len(out) + 1] = { rects: rest, mask: g.winout };
    return out;
  },

  // Lua: region_map_gpu.lua:168
  compose(g: GpuRegs, pal: PalState, layers: LuaTable): void {
    const sh = getShader();
    const sc = G.getScissor();
    G.setShader(sh);
    // Lua: region_map_gpu.lua:172
    const apply = (effect: number, fadeY: number, tone?: LuaTable): void => {
      sh.send("fadeY", fadeY);
      sh.send("fx", effect);
      sh.send("amt", Math.min(g.bldy, 16));
      if (tone) {
        sh.send("tintOn", 1);
        // seam with the platform: effects read vectors as 0-based arrays
        sh.send("tone", toArray(tone));
      } else {
        sh.send("tintOn", 0);
      }
    };
    for (const [, region] of ipairs<Region>(Gpu.regions(g))) {
      const clr = has(region.mask, Gpu.CLR);
      for (const [, r] of ipairs(region.rects)) {
        G.setScissor(r[1], r[2], r[3] - r[1], r[4] - r[2]);
        const bdFx = (clr && has(g.tgt1, Gpu.BD) && g.effect !== Gpu.BLEND) ? g.effect : Gpu.NONE;
        apply(bdFx, pal.bgFade);
        const bd = pal.backdrop;
        G.setColor(bd[1], bd[2], bd[3], 1);
        G.rectangle("fill", 0, 0, Gpu.W, Gpu.H);
        for (const [, layer] of ipairs<Layer>(layers)) {
          if (has(region.mask, layer.bit)) {
            let effect = (clr && has(g.tgt1, layer.bit)) ? g.effect : Gpu.NONE;
            let alpha = 1;
            if (effect === Gpu.BLEND) {
              alpha = Math.min(g.eva, 16) / 16;
              effect = Gpu.NONE;
            }
            apply(effect, layer.obj ? pal.objFade : pal.bgFade, layer.tone);
            G.setColor(1, 1, 1, alpha);
            layer.draw(alpha);
          }
        }
      }
    }
    G.setShader();
    G.setColor(1, 1, 1, 1);
    if (sc) G.setScissor(sc[0], sc[1], sc[2], sc[3]); else G.setScissor();
  },

  images: {} as Record<string, Image>,

  // Lua: region_map_gpu.lua:224
  image(name: string): Image {
    let img = Gpu.images[name];
    if (img) return img;
    const rel = cacheDir() + name + ".png";
    const fd = new FileData(readCache(rel), name + ".png");
    img = G.newImage(newImageData(fd));
    img.setFilter("nearest", "nearest");
    Gpu.images[name] = img;
    return img;
  },

  // Lua: region_map_gpu.lua:236
  frameQuad(name: string, frame: number, w: number, h: number): Quad {
    const key = name + ":" + frame;
    let q = quads[key];
    if (!q) {
      const img = Gpu.image(name);
      q = G.newQuad(0, frame * h, w, h, img.getWidth(), img.getHeight());
      quads[key] = q;
    }
    return q;
  },

  // Lua: region_map_gpu.lua:248
  manifest(): any {
    if (!manifest) {
      const rel = cacheDir() + "manifest.lua";
      const [chunk, err] = luaLoad(readCache(rel), "@" + rel);
      if (!chunk) throw new Error(err);
      manifest = chunk();
    }
    return manifest;
  },

  // Lua: region_map_gpu.lua:256
  rgb(c: number): LuaTable {
    const r5 = c % 32, g5 = Math.floor(c / 32) % 32, b5 = Math.floor(c / 1024) % 32;
    return seq(Math.floor(r5 * 255 / 31 + 0.5) / 255, Math.floor(g5 * 255 / 31 + 0.5) / 255,
      Math.floor(b5 * 255 / 31 + 0.5) / 255, 1);
  },

  // Lua: region_map_gpu.lua:262
  topBarColor(i: number): LuaTable {
    return Gpu.rgb(Gpu.manifest().topBarPal[i]);
  },
};

export default Gpu;
