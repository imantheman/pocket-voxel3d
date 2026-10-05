// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). love.graphics as gen1recomp's FRLG runtime uses it (see the
// LÖVE usage survey summarised in docs/firered-engine.md), recording a draw
// list (drawlist.ts) instead of drawing. Ported code calls `G.draw(...)`,
// `G.rectangle(...)` etc. with LÖVE's arguments unchanged.

import {
  DrawList, BLEND_ADD, BLEND_ADD_PREMUL, BLEND_ALPHA, BLEND_ALPHA_PREMUL, BLEND_MULTIPLY, BLEND_REPLACE, BLEND_SUBTRACT,
} from "./drawlist.ts";
import { effectByName, effectId, type Effect, type Rgba } from "./effects.ts";
import "./effects/index.ts";
import { getHost } from "./host.ts";
import { Canvas, Image, ImageData, Quad, SpriteBatch, newImage as makeImage, FileData } from "./image.ts";

export const SCREEN_W = 240;
export const SCREEN_H = 160;

// ------------------------------------------------------------ transforms

/** Affine matrix [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f. */
type M = [number, number, number, number, number, number];
const IDENT: M = [1, 0, 0, 1, 0, 0];
function mul(m: M, n: M): M {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

/** love.math.newTransform() */
export class Transform {
  m: M = [...IDENT];
  /** setMatrix(e1..e16), row-major 4x4 (LÖVE's default layout) */
  setMatrix(...v: number[]): this {
    const e = v.length === 1 && Array.isArray(v[0]) ? (v[0] as number[]) : v;
    this.m = [e[0]!, e[4]!, e[1]!, e[5]!, e[3]!, e[7]!];
    return this;
  }
  translate(x: number, y: number): this { this.m = mul(this.m, [1, 0, 0, 1, x, y]); return this; }
  scale(sx: number, sy = sx): this { this.m = mul(this.m, [sx, 0, 0, sy, 0, 0]); return this; }
  rotate(r: number): this { const c = Math.cos(r), s = Math.sin(r); this.m = mul(this.m, [c, s, -s, c, 0, 0]); return this; }
  transformPoint(x: number, y: number): [number, number] {
    const m = this.m;
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  }
  reset(): this { this.m = [...IDENT]; return this; }
}

// ------------------------------------------------------------ shaders

export class Shader {
  readonly effect: Effect;
  readonly id: number;
  uniforms: Record<string, unknown> = {};
  /** Bumped by send; the packed draw-list params are re-made only then. */
  version = 0;
  packedVersion = -1;
  packed: number[] = [];
  constructor(readonly name: string) {
    const e = effectByName(name);
    if (!e) throw new Error(`newShader: no effect named '${name}' (platform/effects)`);
    this.effect = e;
    this.id = effectId(name);
  }
  /** shader:send(name, value...) -- several values make an array uniform */
  send(name: string, ...values: unknown[]): void {
    this.uniforms[name] = values.length === 1 ? values[0] : values;
    this.version++;
  }
  hasUniform(_name: string): boolean { return true; }
  type(): string { return "Shader"; }
}

// ------------------------------------------------------------ state

interface State {
  color: Rgba;
  blend: string;
  alphaMode: string;
  shader: Shader | undefined;
  scissor: [number, number, number, number] | undefined;
  canvas: Canvas | undefined;
  m: M;
  lineWidth: number;
}

function fresh(): State {
  return { color: [1, 1, 1, 1], blend: "alpha", alphaMode: "alphamultiply", shader: undefined, scissor: undefined,
    canvas: undefined, m: [...IDENT], lineWidth: 1 };
}

let st: State = fresh();
const stack: { all: boolean; s: State }[] = [];
const list = new DrawList();
let frameOpen = false;

function blendCode(): number {
  switch (st.blend) {
    case "add": return st.alphaMode === "premultiplied" ? BLEND_ADD_PREMUL : BLEND_ADD;
    case "multiply": return BLEND_MULTIPLY;
    case "replace": return BLEND_REPLACE;
    case "subtract": return BLEND_SUBTRACT;
    default: return st.alphaMode === "premultiplied" ? BLEND_ALPHA_PREMUL : BLEND_ALPHA;
  }
}

/** Emit the state the next primitive draws with; [effect params] or none. */
function syncState(): void {
  let effect = 0;
  let params: number[] = [];
  const sh = st.shader;
  if (sh && sh.effect.pack) {
    effect = sh.id;
    if (sh.packedVersion !== sh.version) {
      sh.packed = sh.effect.pack(sh.uniforms);
      sh.packedVersion = sh.version;
    }
    params = sh.packed;
  }
  list.state(blendCode(), effect, params, st.scissor);
}

// CPU variant effects: a recoloured copy of the image per (image, uniforms)
const variants = new Map<string, Image>();
function variantFor(img: Image, sh: Shader): Image {
  if (!img.data) return img; // NOT FAITHFUL: a host-only image cannot be recoloured guest-side
  const key = `${img.id}:${img.data.version}:${sh.name}:${JSON.stringify(sh.uniforms, (_k, v) => (v instanceof Image ? `#${v.id}` : v))}`;
  const hit = variants.get(key);
  if (hit) return hit;
  const src = img.data.px;
  const out = new ImageData(img.w, img.h);
  const ctx = { u: sh.uniforms };
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const o = (y * img.w + x) * 4;
      const t: Rgba = [src[o]! / 255, src[o + 1]! / 255, src[o + 2]! / 255, src[o + 3]! / 255];
      const r = sh.effect.pixel(t, [1, 1, 1, 1], (x + 0.5) / img.w, (y + 0.5) / img.h, x, y, [], ctx);
      if (r) out.setPixel(x, y, r[0], r[1], r[2], r[3]);
    }
  }
  const v = new Image(img.w, img.h, out);
  v.wrap = img.wrap;
  if (variants.size > 256) variants.clear(); // NOT FAITHFUL: a crude bound on the cache
  variants.set(key, v);
  return v;
}

function emitQuad(img: Image, local: M, qx: number, qy: number, qw: number, qh: number, sw: number, sh: number): void {
  let tex = img;
  if (st.shader && !st.shader.effect.pack) tex = variantFor(img, st.shader);
  tex.sync();
  syncState();
  const m = mul(st.m, local);
  const corner = (x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const [x0, y0] = corner(0, 0), [x1, y1] = corner(qw, 0), [x2, y2] = corner(qw, qh), [x3, y3] = corner(0, qh);
  const c = st.color;
  list.quad(tex.id, [x0, y0, x1, y1, x2, y2, x3, y3], qx / sw, qy / sh, (qx + qw) / sw, (qy + qh) / sh, c[0], c[1], c[2], c[3]);
}

/** LÖVE's draw transform: translate(x,y) rotate(r) scale(sx,sy) translate(-ox,-oy) [shear ignored]. */
function drawMatrix(x = 0, y = 0, r = 0, sx = 1, sy?: number, ox = 0, oy = 0): M {
  const syv = sy ?? sx;
  const c = Math.cos(r), s = Math.sin(r);
  // [c -s; s c] * diag(sx, sy), then translate
  const a = c * sx, b = s * sx, cc = -s * syv, d = c * syv;
  return [a, b, cc, d, x - (a * ox + cc * oy), y - (b * ox + d * oy)];
}

function flatTris(points: number[]): void {
  syncState();
  const m = st.m;
  const out = new Array<number>(points.length);
  for (let i = 0; i < points.length; i += 2) {
    out[i] = m[0] * points[i]! + m[2] * points[i + 1]! + m[4];
    out[i + 1] = m[1] * points[i]! + m[3] * points[i + 1]! + m[5];
  }
  const c = st.color;
  list.tris(out, c[0], c[1], c[2], c[3]);
}

function fan(pts: number[]): number[] {
  const out: number[] = [];
  for (let i = 2; i + 3 < pts.length; i += 2) out.push(pts[0]!, pts[1]!, pts[i]!, pts[i + 1]!, pts[i + 2]!, pts[i + 3]!);
  return out;
}

/** A thick segment as two triangles. */
function segment(x1: number, y1: number, x2: number, y2: number, w: number, out: number[]): void {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * (w / 2), ny = (dx / len) * (w / 2);
  out.push(x1 + nx, y1 + ny, x2 + nx, y2 + ny, x2 - nx, y2 - ny, x1 + nx, y1 + ny, x2 - nx, y2 - ny, x1 - nx, y1 - ny);
}

function outline(pts: number[], closed: boolean): void {
  const out: number[] = [];
  const n = pts.length / 2;
  for (let i = 0; i < n - 1; i++) segment(pts[i * 2]!, pts[i * 2 + 1]!, pts[i * 2 + 2]!, pts[i * 2 + 3]!, st.lineWidth, out);
  if (closed && n > 2) segment(pts[(n - 1) * 2]!, pts[(n - 1) * 2 + 1]!, pts[0]!, pts[1]!, st.lineWidth, out);
  flatTris(out);
}

function ellipsePoints(x: number, y: number, rx: number, ry: number, a1: number, a2: number, segs: number, pie: boolean): number[] {
  const pts: number[] = pie ? [x, y] : [];
  for (let i = 0; i <= segs; i++) {
    const t = a1 + ((a2 - a1) * i) / segs;
    pts.push(x + Math.cos(t) * rx, y + Math.sin(t) * ry);
  }
  return pts;
}

const autoSegs = (r: number): number => Math.max(8, Math.ceil(Math.max(1, r) * 2));

function colorArgs(r: number | number[] | Record<string, number>, g?: number, b?: number, a?: number): Rgba {
  if (typeof r === "object") {
    // a JS array [r, g, b, a] (LÖVE's table as JS), a runtime-port sequence
    // [null, r, g, b, a] (lt.ts: slot 0 unused), or an object keyed 1..4
    const seqShaped = Array.isArray(r) && r[0] == null && r.length >= 4;
    const t = Array.isArray(r) ? (seqShaped ? r.slice(1) : r) : [r[1] ?? r["1"] ?? 1, r[2] ?? r["2"] ?? 1, r[3] ?? r["3"] ?? 1, r[4] ?? r["4"]];
    return [Number(t[0] ?? 1), Number(t[1] ?? 1), Number(t[2] ?? 1), t[3] === undefined ? 1 : Number(t[3])];
  }
  return [r, g ?? 1, b ?? 1, a ?? 1];
}

// ------------------------------------------------------------ the module

export const G = {
  // frame plumbing (not LÖVE): the platform calls these around Game3:draw
  // As LÖVE's run loop: graphics state (colour, blend, shader, canvas,
  // scissor) persists from frame to frame; each frame starts with
  // origin() and a clear of the screen. Draws made BETWEEN frames (a
  // screen compositing into a canvas during update) stay in the list and
  // reach the host with the next frame, ahead of that clear.
  beginFrame(): void {
    stack.length = 0;
    st.m = [...IDENT];
    frameOpen = true;
    list.target(0);
    list.clear(0, 0, 0, 1);
    if (st.canvas) list.target(st.canvas.id);
  },
  endFrame(): Float32Array {
    frameOpen = false;
    const out = list.buf;
    getHost().draw(out);
    list.reset();
    list.target(st.canvas ? st.canvas.id : 0);
    // NOTE: a view of reused storage, valid until the next draw call
    return out;
  },
  /** Drop all graphics state (tests; a soft reset). */
  resetState(): void {
    st = fresh();
    stack.length = 0;
  },
  isFrameOpen(): boolean { return frameOpen; },

  // ---- drawing
  draw(drawable: Image | SpriteBatch, ...a: unknown[]): void {
    if (drawable instanceof SpriteBatch) {
      const [x = 0, y = 0, r = 0, sx = 1, sy, ox = 0, oy = 0] = a as number[];
      const base = drawMatrix(x, y, r, sx, sy, ox, oy);
      const img = drawable.texture;
      for (const e of drawable.entries) {
        if (!e || e.x < -1e5 || e.y < -1e5) continue; // hidden cells (field_view parks them at -1e6)
        const local = mul(base, drawMatrix(e.x, e.y, e.r, e.sx, e.sy));
        if (e.quad) emitQuad(img, local, e.quad.x, e.quad.y, e.quad.w, e.quad.h, e.quad.sw, e.quad.sh);
        else emitQuad(img, local, 0, 0, img.w, img.h, img.w, img.h);
      }
      return;
    }
    if (a[0] instanceof Quad) {
      const q = a[0] as Quad;
      const [x, y, r, sx, sy, ox, oy] = a.slice(1) as number[];
      emitQuad(drawable, drawMatrix(x, y, r, sx, sy, ox, oy), q.x, q.y, q.w, q.h, q.sw, q.sh);
      return;
    }
    const [x, y, r, sx, sy, ox, oy] = a as number[];
    emitQuad(drawable, drawMatrix(x, y, r, sx, sy, ox, oy), 0, 0, drawable.w, drawable.h, drawable.w, drawable.h);
  },

  rectangle(mode: string, x: number, y: number, w: number, h: number, rx?: number, ry?: number): void {
    if (rx !== undefined && rx > 0) {
      const ryv = ry ?? rx;
      const pts: number[] = [];
      const corners: [number, number, number][] = [[x + w - rx, y + ryv, -Math.PI / 2], [x + w - rx, y + h - ryv, 0],
        [x + rx, y + h - ryv, Math.PI / 2], [x + rx, y + ryv, Math.PI]];
      for (const [cx, cy, a0] of corners) {
        for (let i = 0; i <= 4; i++) {
          const t = a0 + (Math.PI / 2) * (i / 4);
          pts.push(cx + Math.cos(t) * rx, cy + Math.sin(t) * ryv);
        }
      }
      if (mode === "fill") flatTris(fan(pts)); else outline(pts, true);
      return;
    }
    if (mode === "fill") flatTris([x, y, x + w, y, x + w, y + h, x, y, x + w, y + h, x, y + h]);
    else outline([x, y, x + w, y, x + w, y + h, x, y + h], true);
  },

  circle(mode: string, x: number, y: number, r: number, segs?: number): void {
    const pts = ellipsePoints(x, y, r, r, 0, Math.PI * 2, segs ?? autoSegs(r), false);
    if (mode === "fill") flatTris(fan([x, y, ...pts])); else outline(pts, true);
  },

  ellipse(mode: string, x: number, y: number, rx: number, ry: number, segs?: number): void {
    const pts = ellipsePoints(x, y, rx, ry, 0, Math.PI * 2, segs ?? autoSegs(Math.max(rx, ry)), false);
    if (mode === "fill") flatTris(fan([x, y, ...pts])); else outline(pts, true);
  },

  arc(mode: string, ...args: unknown[]): void {
    // arc(mode[, arctype], x, y, r, a1, a2[, segments]); default arctype "pie"
    let i = 0;
    let arctype = "pie";
    if (typeof args[0] === "string") { arctype = args[0]; i = 1; }
    const [x, y, r, a1, a2, segs] = args.slice(i) as number[];
    const pts = ellipsePoints(x!, y!, r!, r!, a1!, a2!, segs ?? autoSegs(r!), arctype === "pie");
    if (mode === "fill") flatTris(arctype === "pie" ? fan(pts) : fan([pts[0]!, pts[1]!, ...pts]));
    else outline(pts, arctype !== "open");
  },

  polygon(mode: string, ...v: unknown[]): void {
    const pts = (v.length === 1 && typeof v[0] === "object" ? toNums(v[0]) : (v as number[]));
    if (mode === "fill") flatTris(fan(pts)); else outline(pts, true);
  },

  line(...v: unknown[]): void {
    const pts = v.length === 1 && typeof v[0] === "object" ? toNums(v[0]) : (v as number[]);
    outline(pts, false);
  },

  points(..._v: unknown[]): void { /* unused by FRLG */ },

  print(..._a: unknown[]): void { /* debug fallbacks only in FRLG */ },
  printf(..._a: unknown[]): void { /* debug fallbacks only in FRLG */ },

  // ---- colour
  setColor(r: number | number[] | Record<string, number>, g?: number, b?: number, a?: number): void { st.color = colorArgs(r, g, b, a); },
  getColor(): Rgba { return [...st.color] as Rgba; },
  setBackgroundColor(): void {},

  // ---- scissor (screen space of the current target; transforms do not apply)
  setScissor(x?: number | number[], y?: number, w?: number, h?: number): void {
    if (x === undefined) { st.scissor = undefined; return; }
    if (Array.isArray(x)) { st.scissor = [x[0]!, x[1]!, x[2]!, x[3]!]; return; }
    st.scissor = [x, y!, Math.max(0, w!), Math.max(0, h!)];
  },
  intersectScissor(x: number, y: number, w: number, h: number): void {
    if (!st.scissor) { st.scissor = [x, y, Math.max(0, w), Math.max(0, h)]; return; }
    const [sx, sy, sw, sh] = st.scissor;
    const x0 = Math.max(sx, x), y0 = Math.max(sy, y);
    const x1 = Math.min(sx + sw, x + w), y1 = Math.min(sy + sh, y + h);
    st.scissor = [x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)];
  },
  getScissor(): [number, number, number, number] | undefined { return st.scissor ? [...st.scissor] as [number, number, number, number] : undefined; },

  // ---- transform stack
  push(kind?: string): void {
    stack.push({ all: kind === "all", s: { ...st, color: [...st.color] as Rgba, m: [...st.m] as M,
      scissor: st.scissor ? ([...st.scissor] as [number, number, number, number]) : undefined } });
  },
  pop(): void {
    const top = stack.pop();
    if (!top) return;
    if (top.all) {
      const canvasChanged = top.s.canvas !== st.canvas;
      st = top.s;
      if (canvasChanged) list.target(st.canvas ? st.canvas.id : 0);
    } else st.m = top.s.m;
  },
  origin(): void { st.m = [...IDENT]; },
  translate(x: number, y: number): void { st.m = mul(st.m, [1, 0, 0, 1, x, y]); },
  scale(sx: number, sy?: number): void { st.m = mul(st.m, [sx, 0, 0, sy ?? sx, 0, 0]); },
  rotate(r: number): void { const c = Math.cos(r), s = Math.sin(r); st.m = mul(st.m, [c, s, -s, c, 0, 0]); },
  shear(kx: number, ky = 0): void { st.m = mul(st.m, [1, ky, kx, 1, 0, 0]); },
  applyTransform(t: Transform): void { st.m = mul(st.m, t.m); },
  replaceTransform(t: Transform): void { st.m = [...t.m] as M; },
  transformPoint(x: number, y: number): [number, number] {
    const m = st.m;
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  },

  // ---- blend, line
  setBlendMode(mode: string, alphaMode = "alphamultiply"): void { st.blend = mode; st.alphaMode = alphaMode; },
  getBlendMode(): [string, string] { return [st.blend, st.alphaMode]; },
  setLineWidth(w: number): void { st.lineWidth = w; },
  getLineWidth(): number { return st.lineWidth; },
  setLineStyle(): void {},
  setLineJoin(): void {},

  // ---- canvases
  newCanvas(w = SCREEN_W, h = SCREEN_H, _opts?: unknown): Canvas { return new Canvas(w, h); },
  setCanvas(c?: Canvas | null): void {
    const next = c ?? undefined;
    if (next === st.canvas) return;
    st.canvas = next;
    list.target(next ? next.id : 0);
  },
  getCanvas(): Canvas | undefined { return st.canvas; },
  clear(r?: number | number[], g?: number, b?: number, a?: number): void {
    if (r === undefined) { list.clear(0, 0, 0, 0); return; }
    const c = colorArgs(r as number | number[], g, b, a ?? 1);
    list.clear(c[0], c[1], c[2], c[3]);
  },

  // ---- shaders
  newShader(name: string): Shader { return new Shader(name); },
  setShader(sh?: Shader | null): void { st.shader = sh ?? undefined; },
  getShader(): Shader | undefined { return st.shader; },

  // ---- objects
  newQuad(x: number, y: number, w: number, h: number, sw: number | Image, sh?: number): Quad {
    if (sw instanceof Image) return new Quad(x, y, w, h, sw.w, sw.h);
    return new Quad(x, y, w, h, sw, sh ?? sw);
  },
  newImage(src: ImageData | string | FileData): Image { return makeImage(src); },
  newSpriteBatch(texture: Image, capacity?: number): SpriteBatch { return new SpriteBatch(texture, capacity); },

  // ---- the "window": the GBA's own screen (presentFlat model)
  getWidth(): number { return st.canvas ? st.canvas.w : SCREEN_W; },
  getHeight(): number { return st.canvas ? st.canvas.h : SCREEN_H; },
  getDimensions(): [number, number] { return [G.getWidth(), G.getHeight()]; },
  getPixelDimensions(): [number, number] { return [SCREEN_W, SCREEN_H]; },
  getDPIScale(): number { return 1; },
};

function toNums(t: unknown): number[] {
  // a runtime sequence ([null, x1, y1, ...], lt.ts) or a plain JS array
  if (Array.isArray(t)) return (t[0] == null && t.length > 1 ? t.slice(1) : t).map(Number);
  const o = t as Record<string, number>;
  const out: number[] = [];
  for (let i = 1; o[i] !== undefined; i++) out.push(Number(o[i]));
  return out;
}

export default G;
