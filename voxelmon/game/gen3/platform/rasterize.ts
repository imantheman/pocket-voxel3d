// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). A software renderer for the gen3 draw list: what the 3DS
// host draws on the GPU, drawn here pixel by pixel, exactly, for desktop tests
// and screenshots. Pixel centres decide coverage (as GL), textures sample
// nearest, targets are RGBA8 (rounded after every blend, as an RGBA8
// framebuffer), blend modes follow LÖVE 11's blend functions.

import {
  OP_CLEAR, OP_QUAD, OP_STATE, OP_TARGET, OP_TRIS, STATE_PARAMS,
  BLEND_ADD, BLEND_ADD_PREMUL, BLEND_ALPHA, BLEND_ALPHA_PREMUL, BLEND_MULTIPLY, BLEND_REPLACE, BLEND_SUBTRACT,
} from "./drawlist.ts";
import { effectById, type Rgba } from "./effects.ts";

export interface Tex { w: number; h: number; px: Uint8Array; repeat: boolean }

export class Rasterizer {
  /** Textures and canvases by id (canvases are textures too). */
  tex = new Map<number, Tex>();
  /** The frame (target 0). */
  frame: Tex;

  constructor(readonly w = 240, readonly h = 160) {
    this.frame = { w, h, px: new Uint8Array(w * h * 4), repeat: false };
  }

  run(buf: number[]): void {
    let target = this.frame;
    let blend = BLEND_ALPHA, effect = 0;
    let params: number[] = [];
    let scissor: number[] | undefined;
    let i = 0;
    while (i < buf.length) {
      const op = buf[i]!;
      if (op === OP_TARGET) {
        const id = buf[i + 1]!;
        target = id === 0 ? this.frame : this.tex.get(id) ?? this.frame;
        i += 2;
      } else if (op === OP_CLEAR) {
        const c = [buf[i + 1]!, buf[i + 2]!, buf[i + 3]!, buf[i + 4]!].map((v) => Math.round(clamp01(v) * 255));
        for (let p = 0; p < target.px.length; p += 4) { target.px[p] = c[0]!; target.px[p + 1] = c[1]!; target.px[p + 2] = c[2]!; target.px[p + 3] = c[3]!; }
        i += 5;
      } else if (op === OP_STATE) {
        blend = buf[i + 1]!;
        effect = buf[i + 2]!;
        const n = buf[i + 3]!;
        params = buf.slice(i + 4, i + 4 + n);
        const s = buf.slice(i + 4 + STATE_PARAMS, i + 8 + STATE_PARAMS);
        scissor = s[0]! < 0 ? undefined : s;
        i += 4 + STATE_PARAMS + 4;
      } else if (op === OP_QUAD) {
        const texId = buf[i + 1]!;
        const c = buf.slice(i + 2, i + 10);
        const [u0, v0, u1, v1] = buf.slice(i + 10, i + 14) as [number, number, number, number];
        const col = buf.slice(i + 14, i + 18) as Rgba;
        this.quad(target, this.tex.get(texId), c, u0, v0, u1, v1, col, blend, effect, params, scissor);
        i += 18;
      } else if (op === OP_TRIS) {
        const n = buf[i + 1]!;
        const col = buf.slice(i + 2, i + 6) as Rgba;
        for (let t = 0; t < n; t++) {
          const p = buf.slice(i + 6 + t * 6, i + 12 + t * 6);
          this.tri(target, p, col, blend, effect, params, scissor);
        }
        i += 6 + n * 6;
      } else throw new Error(`rasterize: bad op ${op} at ${i}`);
    }
  }

  private bounds(t: Tex, xs: number[], ys: number[], sc: number[] | undefined): [number, number, number, number] {
    let x0 = Math.max(0, Math.floor(Math.min(...xs))), y0 = Math.max(0, Math.floor(Math.min(...ys)));
    let x1 = Math.min(t.w, Math.ceil(Math.max(...xs))), y1 = Math.min(t.h, Math.ceil(Math.max(...ys)));
    if (sc) {
      x0 = Math.max(x0, Math.floor(sc[0]!)); y0 = Math.max(y0, Math.floor(sc[1]!));
      x1 = Math.min(x1, Math.floor(sc[0]! + sc[2]!)); y1 = Math.min(y1, Math.floor(sc[1]! + sc[3]!));
    }
    return [x0, y0, x1, y1];
  }

  private quad(t: Tex, tex: Tex | undefined, c: number[], u0: number, v0: number, u1: number, v1: number, col: Rgba,
    blend: number, effect: number, params: number[], sc: number[] | undefined): void {
    // the quad is affine (a transformed rectangle): TL + s*(TR-TL) + t*(BL-TL)
    const ax = c[2]! - c[0]!, ay = c[3]! - c[1]!, bx = c[6]! - c[0]!, by = c[7]! - c[1]!;
    const det = ax * by - ay * bx;
    if (det === 0) return;
    const [x0, y0, x1, y1] = this.bounds(t, [c[0]!, c[2]!, c[4]!, c[6]!], [c[1]!, c[3]!, c[5]!, c[7]!], sc);
    const fx = effectById(effect);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const px = x + 0.5 - c[0]!, py = y + 0.5 - c[1]!;
        const s = (px * by - py * bx) / det, tt = (ax * py - ay * px) / det;
        if (s < 0 || s >= 1 || tt < 0 || tt >= 1) continue;
        const u = u0 + (u1 - u0) * s, v = v0 + (v1 - v0) * tt;
        const texel = tex ? sample(tex, u, v) : ([1, 1, 1, 1] as Rgba);
        let out: Rgba | undefined;
        if (fx) out = fx.pixel(texel, col, u, v, x, y, params, { u: {}, sample: (id, su, sv) => { const st = this.tex.get(id); return st ? sample(st, su, sv) : [0, 0, 0, 0]; } });
        else out = [texel[0] * col[0], texel[1] * col[1], texel[2] * col[2], texel[3] * col[3]];
        if (out) blendPx(t, x, y, out, blend);
      }
    }
    function sample(tx: Tex, su: number, sv: number): Rgba {
      let ix = Math.floor(su * tx.w), iy = Math.floor(sv * tx.h);
      if (tx.repeat) { ix = ((ix % tx.w) + tx.w) % tx.w; iy = ((iy % tx.h) + tx.h) % tx.h; }
      else { ix = Math.min(tx.w - 1, Math.max(0, ix)); iy = Math.min(tx.h - 1, Math.max(0, iy)); }
      const o = (iy * tx.w + ix) * 4;
      return [tx.px[o]! / 255, tx.px[o + 1]! / 255, tx.px[o + 2]! / 255, tx.px[o + 3]! / 255];
    }
  }

  private tri(t: Tex, p: number[], col: Rgba, blend: number, effect: number, params: number[], sc: number[] | undefined): void {
    const [x0, y0, x1, y1] = this.bounds(t, [p[0]!, p[2]!, p[4]!], [p[1]!, p[3]!, p[5]!], sc);
    const fx = effectById(effect);
    const area = (p[2]! - p[0]!) * (p[5]! - p[1]!) - (p[4]! - p[0]!) * (p[3]! - p[1]!);
    if (area === 0) return;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const cx = x + 0.5, cy = y + 0.5;
        const w0 = (p[2]! - cx) * (p[5]! - cy) - (p[4]! - cx) * (p[3]! - cy);
        const w1 = (p[4]! - cx) * (p[1]! - cy) - (p[0]! - cx) * (p[5]! - cy);
        const w2 = (p[0]! - cx) * (p[3]! - cy) - (p[2]! - cx) * (p[1]! - cy);
        const inside = area > 0 ? w0 >= 0 && w1 >= 0 && w2 >= 0 : w0 <= 0 && w1 <= 0 && w2 <= 0;
        if (!inside) continue;
        const out = fx ? fx.pixel([1, 1, 1, 1], col, 0, 0, x, y, params, { u: {} }) : col;
        if (out) blendPx(t, x, y, out, blend);
      }
    }
  }
}

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }

/** LÖVE 11 blend functions on an RGBA8 target. */
function blendPx(t: Tex, x: number, y: number, s: Rgba, mode: number): void {
  const o = (y * t.w + x) * 4;
  const d = [t.px[o]! / 255, t.px[o + 1]! / 255, t.px[o + 2]! / 255, t.px[o + 3]! / 255];
  const sr = clamp01(s[0]), sg = clamp01(s[1]), sb = clamp01(s[2]), sa = clamp01(s[3]);
  let r: number, g: number, b: number, a: number;
  switch (mode) {
    case BLEND_ALPHA: // SRC_ALPHA, 1-SRC_ALPHA | ONE, 1-SRC_ALPHA
      r = sr * sa + d[0]! * (1 - sa); g = sg * sa + d[1]! * (1 - sa); b = sb * sa + d[2]! * (1 - sa); a = sa + d[3]! * (1 - sa); break;
    case BLEND_ALPHA_PREMUL: // ONE, 1-SRC_ALPHA
      r = sr + d[0]! * (1 - sa); g = sg + d[1]! * (1 - sa); b = sb + d[2]! * (1 - sa); a = sa + d[3]! * (1 - sa); break;
    case BLEND_ADD: // SRC_ALPHA, ONE | ZERO, ONE
      r = d[0]! + sr * sa; g = d[1]! + sg * sa; b = d[2]! + sb * sa; a = d[3]!; break;
    case BLEND_ADD_PREMUL: // ONE, ONE | ZERO, ONE
      r = d[0]! + sr; g = d[1]! + sg; b = d[2]! + sb; a = d[3]!; break;
    case BLEND_MULTIPLY: // DST_COLOR, ZERO (both)
      r = d[0]! * sr; g = d[1]! * sg; b = d[2]! * sb; a = d[3]! * sa; break;
    case BLEND_REPLACE:
      r = sr; g = sg; b = sb; a = sa; break;
    case BLEND_SUBTRACT: // reverse subtract: dst - src*a
      r = d[0]! - sr * sa; g = d[1]! - sg * sa; b = d[2]! - sb * sa; a = d[3]!; break;
    default:
      r = sr; g = sg; b = sb; a = sa;
  }
  t.px[o] = Math.round(clamp01(r) * 255); t.px[o + 1] = Math.round(clamp01(g) * 255);
  t.px[o + 2] = Math.round(clamp01(b) * 255); t.px[o + 3] = Math.round(clamp01(a) * 255);
}
