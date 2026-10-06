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
import {
  Canvas, Image, ImageData, Quad, SpriteBatch, newImage as makeImage, FileData, collectTextures, texturesListSent,
} from "./image.ts";

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
  /** variantFor's key text for the uniforms, and the version it was made at. */
  key = "";
  keyVersion = -1;
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
/** Frames begun (collectTextures scans every 8th). */
let frameNo = 0;
/** The screen clear's alpha (G.setFrameClearAlpha). */
let frameClearA = 1;

/**
 * One textured quad drawn while capturing (G.captureBegin, not LÖVE): its
 * image, its corners after the transform (top-left, top-right, bottom-right,
 * bottom-left as the image's frame runs), the frame over the image and the
 * colour's alpha. The voxel world turns what the 2D field draws in the
 * map's places into billboards from these (platform/world_fx.ts).
 */
export interface CapturedQuad {
  img: Image;
  /** x0 y0 x1 y1 x2 y2 x3 y3 */
  xy: number[];
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  alpha: number;
}
/** Where captured quads go; null when drawing as usual. */
let capture: CapturedQuad[] | null = null;

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
// what syncState last sent, so a run of primitives in one state costs a few
// compares (the host learns a state only when it changes)
let lastBlend = "", lastAlpha = "", lastShader: Shader | undefined | null = null;
let lastVer = -1, lastScissor: unknown = 0, lastEpoch = -1;
function syncState(): void {
  const sh0 = st.shader;
  const ver = sh0 ? sh0.version : -1;
  if (st.blend === lastBlend && st.alphaMode === lastAlpha && sh0 === lastShader && ver === lastVer
      && st.scissor === lastScissor && list.epoch === lastEpoch) return;
  lastBlend = st.blend; lastAlpha = st.alphaMode; lastShader = sh0; lastVer = ver;
  lastScissor = st.scissor;
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
  lastEpoch = list.epoch;
}

// CPU variant effects: a recoloured copy of the image per (image, uniforms)
const variants = new Map<string, Image>();
/** A shader's uniforms as variantFor's key text, made again only after a send. */
function uniformKey(sh: Shader): string {
  if (sh.keyVersion !== sh.version) {
    sh.key = JSON.stringify(sh.uniforms, (_k, v) => (v instanceof Image ? `#${v.id}` : v));
    sh.keyVersion = sh.version;
  }
  return sh.key;
}
function variantFor(img: Image, sh: Shader): Image {
  if (!img.data) return img; // NOT FAITHFUL: a host-only image cannot be recoloured guest-side
  const key = `${img.id}:${img.data.version}:${sh.name}:${uniformKey(sh)}`;
  const hit = variants.get(key);
  if (hit) return hit;
  const src = img.data.px;
  const ctx = { u: sh.uniforms };
  const fast = sh.effect.variant;
  const out = fast ? new ImageData(img.w, img.h, fast(src, img.w, img.h, ctx)) : new ImageData(img.w, img.h);
  if (!fast) for (let y = 0; y < img.h; y++) {
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
  emitQuadS(img, local[0], local[1], local[2], local[3], local[4], local[5], qx, qy, qw, qh, sw, sh);
}

/**
 * One textured quad: the image's sub-rect (qx, qy, qw, qh of sw x sh) under
 * the local affine (la..lf, drawMatrix's layout) and the current transform.
 * The hot path of every screen -- scalars only, nothing allocated.
 */
function emitQuadS(img: Image, la: number, lb: number, lc: number, ld: number, le: number, lf: number,
  qx: number, qy: number, qw: number, qh: number, sw: number, sh: number): void {
  let tex = img;
  const sh0 = st.shader;
  if (sh0 && !sh0.effect.pack) tex = variantFor(img, sh0);
  tex.sync();
  if (recs.length) recImage(tex);
  const m = st.m;
  // m * local
  const a = m[0] * la + m[2] * lb, b = m[1] * la + m[3] * lb;
  const c = m[0] * lc + m[2] * ld, d = m[1] * lc + m[3] * ld;
  const e = m[0] * le + m[2] * lf + m[4], f = m[1] * le + m[3] * lf + m[5];
  const ax = a * qw, bx = b * qw, cy = c * qh, dy = d * qh;
  const col = st.color;
  if (capture) {
    capture.push({ img: tex, xy: [e, f, e + ax, f + bx, e + ax + cy, f + bx + dy, e + cy, f + dy],
      u0: qx / sw, v0: qy / sh, u1: (qx + qw) / sw, v1: (qy + qh) / sh, alpha: col[3] });
    return;
  }
  syncState();
  list.quad8(tex.id, e, f, e + ax, f + bx, e + ax + cy, f + bx + dy, e + cy, f + dy,
    qx / sw, qy / sh, (qx + qw) / sw, (qy + qh) / sh, col[0], col[1], col[2], col[3]);
}

// ------------------------------------------------------------ draw memos

/**
 * What a run of drawing put in the draw list, kept so the same run can be
 * replayed by copying it (not LÖVE; G.memoBegin / memoEnd / memoReplay).
 * The UI draws the same text and window frames every frame; replaying the
 * primitives they made last time skips the tokenising, the layout and the
 * per-glyph calls, and gives the same list, float for float. The caller
 * decides when its inputs are the same; this checks the rest: the same
 * transform, primitives only (no state change, canvas switch, clear or
 * sprite batch inside the run), the state left as it was found but for the
 * colour (which the replay restores), and no capture or CPU effect.
 */
export class DrawMemo {
  floats: Float32Array | null = null;
  images: Image[] = [];
  /** The transform it was recorded under. */
  m: M = [1, 0, 0, 1, 0, 0];
  /** The colour the run left. */
  color: Rgba = [1, 1, 1, 1];
  clear(): void { this.floats = null; this.images = []; }
}

/** A DrawMemo with its inputs: an object and up to six numbers (MemoSet). */
class KeyedMemo extends DrawMemo {
  ref: unknown = undefined;
  k0 = NaN; k1 = NaN; k2 = NaN; k3 = NaN; k4 = NaN; k5 = NaN;
}

/**
 * A few memos of one drawing function, by its inputs (an object, such as
 * the atlas it draws from, and up to six numbers): `run` replays the run
 * those inputs drew last time, or draws it with `fn` and keeps it. The
 * caller passes every input the drawing depends on.
 */
export class MemoSet {
  private l: KeyedMemo[] = [];
  private next = 0;
  constructor(private readonly size = 8) {}
  run(ref: unknown, k0: number, k1: number, k2: number, k3: number, k4: number, k5: number, fn: () => void): void {
    const l = this.l;
    let m: KeyedMemo | undefined;
    for (let i = 0; i < l.length; i++) {
      const e = l[i]!;
      if (e.ref === ref && e.k0 === k0 && e.k1 === k1 && e.k2 === k2 && e.k3 === k3 && e.k4 === k4 && e.k5 === k5) { m = e; break; }
    }
    if (m && G.memoReplay(m)) return;
    if (!m) {
      if (l.length < this.size) { m = new KeyedMemo(); l.push(m); } else { m = l[this.next]!; this.next = (this.next + 1) % this.size; }
      m.ref = ref; m.k0 = k0; m.k1 = k1; m.k2 = k2; m.k3 = k3; m.k4 = k4; m.k5 = k5;
      m.clear();
    }
    const rec = G.memoBegin(m);
    let ok = false;
    try {
      fn();
      ok = true;
    } finally {
      if (rec) {
        G.memoEnd(m);
        if (!ok) m.clear();
      }
    }
  }
}

interface Rec {
  memo: DrawMemo;
  start: number;
  stateOps: number;
  images: Image[];
  m: M;
  blend: string;
  alphaMode: string;
  shader: Shader | undefined;
  scissor: [number, number, number, number] | undefined;
  canvas: Canvas | undefined;
}
/** The recordings under way (nested runs record into each). */
const recs: Rec[] = [];

function recImage(img: Image): void {
  for (let i = 0; i < recs.length; i++) {
    const l = recs[i]!.images;
    if (l[l.length - 1] !== img && l.indexOf(img) < 0) l.push(img);
  }
}

function sameM(a: M, b: M): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3] && a[4] === b[4] && a[5] === b[5];
}

function sameScissor(a: [number, number, number, number] | undefined, b: [number, number, number, number] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

/** Whether a run drawn now could be recorded or replayed at all. */
function memoable(): boolean {
  const sh = st.shader;
  return memoOn && !capture && !(sh && !sh.effect.pack);
}
/** G.setMemo: memos on (false: every run is drawn plainly; tools/gen3/perf_check.ts compares the two). */
let memoOn = true;

/** A sprite batch's quads, batch-local, to the host (G3Host.batchUpload). */
let batchScratch = new Float32Array(12 * 256);
function uploadBatch(host: ReturnType<typeof getHost>, sb: SpriteBatch): void {
  const ents = sb.entries;
  const img = sb.texture;
  if (batchScratch.length < ents.length * 12) batchScratch = new Float32Array(ents.length * 12 * 2);
  const q8 = batchScratch;
  let n = 0;
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i];
    if (!e || e.x < -1e5 || e.y < -1e5) continue; // hidden cells (field_view parks them at -1e6)
    let a: number, b: number, c: number, d: number, ex: number, fy: number;
    const er = e.r ?? 0, esx = e.sx ?? 1, esy = e.sy ?? e.sx ?? 1;
    if (er === 0 && esx === 1 && esy === 1) {
      // drawMatrixInto's numbers for the plain cell, without the call
      a = 1; b = 0; c = 0; d = 1; ex = e.x - 0; fy = e.y - 0;
    } else {
      drawMatrixInto(e.x, e.y, er, esx, esy, 0, 0);
      a = DM[0]!; b = DM[1]!; c = DM[2]!; d = DM[3]!; ex = DM[4]!; fy = DM[5]!;
    }
    const q = e.quad;
    const qx = q ? q.x : 0, qy = q ? q.y : 0, qw = q ? q.w : img.w, qh = q ? q.h : img.h;
    const sw = q ? q.sw : img.w, sh = q ? q.sh : img.h;
    const ax = a * qw, bx = b * qw, cy = c * qh, dy = d * qh;
    const o = n * 12;
    q8[o] = ex; q8[o + 1] = fy; q8[o + 2] = ex + ax; q8[o + 3] = fy + bx;
    q8[o + 4] = ex + ax + cy; q8[o + 5] = fy + bx + dy; q8[o + 6] = ex + cy; q8[o + 7] = fy + dy;
    q8[o + 8] = qx / sw; q8[o + 9] = qy / sh; q8[o + 10] = (qx + qw) / sw; q8[o + 11] = (qy + qh) / sh;
    n++;
  }
  host.batchUpload!(sb.id, img.id, q8.subarray(0, n * 12), n);
  sb.uploaded = sb.version;
}

/** drawMatrix's six numbers into the scratch below (no array per draw). */
const DM = [1, 0, 0, 1, 0, 0];
function drawMatrixInto(x: number, y: number, r: number, sx: number, sy: number, ox: number, oy: number): void {
  let a: number, b: number, cc: number, d: number;
  if (r === 0) {
    a = sx; b = 0; cc = 0; d = sy;
  } else {
    const co = Math.cos(r), s = Math.sin(r);
    a = co * sx; b = s * sx; cc = -s * sy; d = co * sy;
  }
  DM[0] = a; DM[1] = b; DM[2] = cc; DM[3] = d;
  DM[4] = x - (a * ox + cc * oy); DM[5] = y - (b * ox + d * oy);
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
  if (capture) return; // only textured quads are captured
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
    // the host textures of collected or released images (image.ts): every
    // frame the frees already due, every 8th the scan for collected ones
    collectTextures((++frameNo & 7) === 0);
    stack.length = 0;
    st.m = [...IDENT];
    frameOpen = true;
    list.target(0);
    list.clear(0, 0, 0, frameClearA);
    if (st.canvas) list.target(st.canvas.id);
  },
  endFrame(): Float32Array {
    frameOpen = false;
    const out = list.buf;
    getHost().draw(out);
    texturesListSent();
    list.reset();
    list.target(st.canvas ? st.canvas.id : 0);
    // NOTE: a view of reused storage, valid until the next draw call
    return out;
  },
  /**
   * The alpha beginFrame clears the screen to (not LÖVE): 1 as LÖVE's run
   * loop, 0 while the 3DS host draws the voxel world under this frame
   * (worldview.ts), so what the frame leaves undrawn shows the world.
   */
  setFrameClearAlpha(a: number): void { frameClearA = a; },
  /**
   * Until captureEnd (not LÖVE): every textured quad drawn goes into `out`
   * (CapturedQuad) instead of the draw list, and untextured shapes and
   * sprite batches draw nothing -- how the voxel world learns where the 2D
   * field would have drawn a door or a field effect.
   */
  captureBegin(out: CapturedQuad[]): void { capture = out; },
  captureEnd(): void { capture = null; },
  /** Drop all graphics state (tests; a soft reset). */
  resetState(): void {
    st = fresh();
    stack.length = 0;
  },
  isFrameOpen(): boolean { return frameOpen; },

  /**
   * Replay `memo` (DrawMemo) if it holds a run recorded under the current
   * transform and a run can be replayed now; true if it did. The caller has
   * already checked that the run's own inputs are the same.
   */
  memoReplay(memo: DrawMemo): boolean {
    const fl = memo.floats;
    if (!fl || !sameM(st.m, memo.m) || !memoable()) return false;
    syncState();
    const imgs = memo.images;
    for (let i = 0; i < imgs.length; i++) {
      const img = imgs[i]!;
      img.sync();
      if (recs.length) recImage(img);
    }
    list.append(fl);
    const c = st.color, mc = memo.color;
    c[0] = mc[0]; c[1] = mc[1]; c[2] = mc[2]; c[3] = mc[3];
    return true;
  },
  /** Draw memos on or off (tests: the same frames either way). */
  setMemo(on: boolean): void { memoOn = on; },
  /** Start recording a run into `memo` (false: this run cannot be recorded; draw it plainly). */
  memoBegin(memo: DrawMemo): boolean {
    if (!memoable()) return false;
    syncState();
    recs.push({
      memo, start: list.length, stateOps: list.stateOps, images: [], m: [...st.m] as M,
      blend: st.blend, alphaMode: st.alphaMode, shader: st.shader, scissor: st.scissor, canvas: st.canvas,
    });
    return true;
  },
  /** End the recording memoBegin started (after the run, even if it threw). */
  memoEnd(memo: DrawMemo): void {
    const r = recs.pop();
    if (!r || r.memo !== memo) { memo.clear(); recs.length = 0; return; }
    if (list.stateOps !== r.stateOps || !sameM(st.m, r.m) || st.blend !== r.blend || st.alphaMode !== r.alphaMode
        || st.shader !== r.shader || !sameScissor(st.scissor, r.scissor) || st.canvas !== r.canvas || capture) {
      memo.clear();
      return;
    }
    memo.floats = list.copyFrom(r.start);
    memo.images = r.images;
    memo.m = r.m;
    const c = st.color;
    memo.color = [c[0], c[1], c[2], c[3]];
  },

  // ---- drawing
  draw(drawable: Image | SpriteBatch, p1?: unknown, p2?: unknown, p3?: unknown, p4?: unknown, p5?: unknown,
    p6?: unknown, p7?: unknown, p8?: unknown): void {
    if (drawable instanceof SpriteBatch) {
      if (capture) return; // only single textured quads are captured
      drawMatrixInto((p1 as number) ?? 0, (p2 as number) ?? 0, (p3 as number) ?? 0, (p4 as number) ?? 1,
        (p5 as number) ?? (p4 as number) ?? 1, (p6 as number) ?? 0, (p7 as number) ?? 0);
      const ba = DM[0]!, bb = DM[1]!, bc = DM[2]!, bd = DM[3]!, be = DM[4]!, bf = DM[5]!;
      const img = drawable.texture;
      const host = getHost();
      const sh0 = st.shader;
      if (host.batchUpload && !(sh0 && !sh0.effect.pack)) {
        // the host holds the batch: one op a frame, the quads re-sent only after a change
        if (drawable.uploaded !== drawable.version) uploadBatch(host, drawable);
        img.sync();
        syncState();
        const m = st.m;
        const col = st.color;
        list.batch(drawable.id, img.id,
          m[0] * ba + m[2] * bb, m[1] * ba + m[3] * bb, m[0] * bc + m[2] * bd, m[1] * bc + m[3] * bd,
          m[0] * be + m[2] * bf + m[4], m[1] * be + m[3] * bf + m[5], col[0], col[1], col[2], col[3]);
        return;
      }
      const ents = drawable.entries;
      for (let i = 0; i < ents.length; i++) {
        const e = ents[i];
        if (!e || e.x < -1e5 || e.y < -1e5) continue; // hidden cells (field_view parks them at -1e6)
        drawMatrixInto(e.x, e.y, e.r ?? 0, e.sx ?? 1, e.sy ?? e.sx ?? 1, 0, 0);
        // base * entry
        const la = ba * DM[0]! + bc * DM[1]!, lb = bb * DM[0]! + bd * DM[1]!;
        const lc = ba * DM[2]! + bc * DM[3]!, ld = bb * DM[2]! + bd * DM[3]!;
        const le = ba * DM[4]! + bc * DM[5]! + be, lf = bb * DM[4]! + bd * DM[5]! + bf;
        const q = e.quad;
        if (q) emitQuadS(img, la, lb, lc, ld, le, lf, q.x, q.y, q.w, q.h, q.sw, q.sh);
        else emitQuadS(img, la, lb, lc, ld, le, lf, 0, 0, img.w, img.h, img.w, img.h);
      }
      return;
    }
    if (p1 instanceof Quad) {
      const q = p1;
      if (p4 === undefined && p5 === undefined && p6 === undefined && p7 === undefined && p8 === undefined) {
        // the common call, draw(image, quad, x, y): drawMatrixInto's identity
        emitQuadS(drawable, 1, 0, 0, 1, (p2 as number) ?? 0, (p3 as number) ?? 0, q.x, q.y, q.w, q.h, q.sw, q.sh);
        return;
      }
      const sx = (p5 as number) ?? 1;
      drawMatrixInto((p2 as number) ?? 0, (p3 as number) ?? 0, (p4 as number) ?? 0, sx, (p6 as number) ?? sx,
        (p7 as number) ?? 0, (p8 as number) ?? 0);
      emitQuadS(drawable, DM[0]!, DM[1]!, DM[2]!, DM[3]!, DM[4]!, DM[5]!, q.x, q.y, q.w, q.h, q.sw, q.sh);
      return;
    }
    const sx = (p4 as number) ?? 1;
    drawMatrixInto((p1 as number) ?? 0, (p2 as number) ?? 0, (p3 as number) ?? 0, sx, (p5 as number) ?? sx,
      (p6 as number) ?? 0, (p7 as number) ?? 0);
    emitQuadS(drawable, DM[0]!, DM[1]!, DM[2]!, DM[3]!, DM[4]!, DM[5]!, 0, 0, drawable.w, drawable.h, drawable.w, drawable.h);
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
    if (mode === "fill") {
      // flatTris of the rectangle's two triangles, without the arrays
      if (capture) return;
      syncState();
      const m = st.m;
      const x1 = x + w, y1 = y + h;
      const c = st.color;
      list.rect(m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5],
        m[0] * x1 + m[2] * y + m[4], m[1] * x1 + m[3] * y + m[5],
        m[0] * x1 + m[2] * y1 + m[4], m[1] * x1 + m[3] * y1 + m[5],
        m[0] * x + m[2] * y1 + m[4], m[1] * x + m[3] * y1 + m[5], c[0], c[1], c[2], c[3]);
    } else outline([x, y, x + w, y, x + w, y + h, x, y + h], true);
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
  setColor(r: number | number[] | Record<string, number>, g?: number, b?: number, a?: number): void {
    if (typeof r === "number") {
      // the common call: no array made (push copies the colour, so writing in place is safe)
      const c = st.color;
      c[0] = r; c[1] = g ?? 1; c[2] = b ?? 1; c[3] = a ?? 1;
      return;
    }
    st.color = colorArgs(r, g, b, a);
  },
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
