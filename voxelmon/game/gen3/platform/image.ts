// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). LÖVE's drawables as the port uses them: Image (a host
// texture, with its source ImageData kept when the guest made it), Canvas
// (a render target), Quad, SpriteBatch; and love.image's ImageData /
// love.filesystem's FileData for PNG bytes.

import { getHost, hasHost } from "./host.ts";
import { ImageData as BaseImageData } from "../../../import/gen3/imagedata.ts";
import { decodePngBytes } from "./pngdecode.ts";
import { toBytes } from "../../../import/gen3/lua.ts";

let nextTexId = 1;
export function allocTexId(): number { return nextTexId++; }
/** Image.sync's scratch: the changed rects. */
const SUB: number[] = [];
let SUB32 = new Int32Array(4 * 64);
/** Rects a segment keeps before they become their bounding rect. */
const MAX_RECTS = 64;
/** The rects x0 y0 x1 y1... in r as their one bounding rect. */
function boundRects(r: number[]): void {
  let x0 = 1 << 30, y0 = 1 << 30, x1 = -(1 << 30), y1 = -(1 << 30);
  for (let i = 0; i < r.length; i += 4) {
    if (r[i]! < x0) x0 = r[i]!;
    if (r[i + 1]! < y0) y0 = r[i + 1]!;
    if (r[i + 2]! > x1) x1 = r[i + 2]!;
    if (r[i + 3]! > y1) y1 = r[i + 3]!;
  }
  r.length = 4;
  r[0] = x0; r[1] = y0; r[2] = x1; r[3] = y1;
}

type Blit = (dst: Uint8Array, dw: number, dx: number, dy: number, src: Uint8Array, sw: number, sx: number, sy: number, w: number, h: number) => boolean;
/** The host's rect copy (g3_shim.c g3Blit), where the binary has it: true when it copied. */
let nativeBlit: Blit | undefined;
export function setNativeBlit(f: Blit): void { nativeBlit = f; }

// ---- host textures given back (not LÖVE's API; LÖVE frees on GC)
//
// LÖVE frees an Image's texture when the Image is collected, and the port's
// screens drop images as Brian's do, without release(). Here each Image that
// has a host texture is watched through a WeakRef: once the Image is gone
// (QuickJS clears a WeakRef as the object is freed), collectTextures frees
// its texture. Every host free -- these and release()'s -- waits until the
// draw list being built when it was asked for has been rendered: the list
// (which can hold draws made during update, before beginFrame) names
// textures by id, and the host keeps it, and the world's billboards, until
// it renders them after the guest's frame. So a free asked for before a
// frame's endFrame is made at the next frame's beginFrame.
const watchRefs: WeakRef<Image>[] = [];
const watchIds: number[] = [];
/** Frees asked for since the last endFrame (texture ids). */
const freeLater = new Set<number>();
/** Frees asked for before the last endFrame: made at the next beginFrame. */
let freeReady: number[] = [];
const hasWeakRef = typeof WeakRef === "function";

/** Texture `id` is being made again: any free it still waits for is off. */
function unfree(id: number): void {
  freeLater.delete(id);
  const i = freeReady.indexOf(id);
  if (i >= 0) freeReady.splice(i, 1);
}

/** After a frame's draw list went to the host (graphics.ts endFrame). */
export function texturesListSent(): void {
  for (const id of freeLater) freeReady.push(id);
  freeLater.clear();
  for (const id of batchFreeLater) batchFreeReady.push(id);
  batchFreeLater.clear();
}

// The same for the host's copies of sprite batches (G3Host.batchUpload):
// a batch drawn by id goes when its SpriteBatch is collected or released.
const batchRefs: WeakRef<SpriteBatch>[] = [];
const batchIds: number[] = [];
const batchFreeLater = new Set<number>();
let batchFreeReady: number[] = [];

/** Sprite batch `sb` was just sent to the host (graphics.ts uploadBatch). */
export function batchUploaded(sb: SpriteBatch): void {
  batchFreeLater.delete(sb.id);
  const i = batchFreeReady.indexOf(sb.id);
  if (i >= 0) batchFreeReady.splice(i, 1);
  if (!hasWeakRef || sb.watched) return;
  sb.watched = true;
  batchRefs.push(new WeakRef(sb));
  batchIds.push(sb.id);
}

function watch(img: Image): void {
  if (!hasWeakRef || img.watched) return;
  img.watched = true;
  watchRefs.push(new WeakRef(img));
  watchIds.push(img.id);
}

/**
 * At the top of a frame (graphics.ts beginFrame): the frees asked for
 * before the last endFrame go to the host. `scan`: look for collected
 * Images too (a walk of the watched list; the caller does it every few
 * frames), whose textures are freed a frame later.
 */
export function collectTextures(scan: boolean): void {
  if (freeReady.length) {
    const host = getHost();
    for (let i = 0; i < freeReady.length; i++) host.texFree(freeReady[i]!);
    freeReady = [];
  }
  if (batchFreeReady.length) {
    const host = getHost();
    for (let i = 0; i < batchFreeReady.length; i++) host.batchFree?.(batchFreeReady[i]!);
    batchFreeReady = [];
  }
  if (scan) {
    let j = 0;
    for (let i = 0; i < watchRefs.length; i++) {
      const r = watchRefs[i]!;
      const img = r.deref();
      if (img === undefined) { freeLater.add(watchIds[i]!); continue; }
      if (!img.watched) continue; // released: no longer watched (watch() again on its next upload)
      watchRefs[j] = r; watchIds[j] = watchIds[i]!; j++;
    }
    watchRefs.length = j; watchIds.length = j;
    j = 0;
    for (let i = 0; i < batchRefs.length; i++) {
      const r = batchRefs[i]!;
      const sb = r.deref();
      if (sb === undefined) { batchFreeLater.add(batchIds[i]!); continue; }
      if (!sb.watched) continue;
      batchRefs[j] = r; batchIds[j] = batchIds[i]!; j++;
    }
    batchRefs.length = j; batchIds.length = j;
  }
}

/** The textures watched (tools: the live count). */
export function watchedTextures(): number { return watchRefs.length; }

/** love.image ImageData, plus the methods the runtime uses beyond the importer's. */
export class ImageData extends BaseImageData {
  /** Bumped on every change, so an Image made from it can tell it is stale. */
  version = 0;

  // Where it changed (not LÖVE): an Image made from it uploads only the
  // rects that changed since its last upload when the host can do that
  // (G3Host.texSub) -- the field's tile animations paste a bank of 16x16
  // cells into a whole atlas. Changes are kept in segments, one per upload
  // of any Image from this data (from version, to version, rects x0 y0 x1 y1
  // with exclusive ends), and the open one since the last upload. A change
  // made without the methods below (px written and version bumped by hand)
  // leaves `tracked` behind `version`: the next upload is then a whole one.
  /** The version after the last change these methods saw. */
  private tracked = 0;
  /** The open segment: from this version, these rects. */
  private segFrom = 0;
  private rects: number[] = [];
  private segs: { from: number; to: number; rects: number[] }[] = [];

  private mark(x0: number, y0: number, x1: number, y1: number): void {
    const r = this.rects, n = r.length;
    if (n >= 4 && r[n - 3] === y0 && r[n - 1] === y1 && r[n - 2] === x0) r[n - 2] = x1; // a run along its rows
    else if (n >= 4 && x0 >= r[n - 4]! && y0 >= r[n - 3]! && x1 <= r[n - 2]! && y1 <= r[n - 1]!) { /* inside the last */ }
    else if (n >= MAX_RECTS * 4) { r.push(x0, y0, x1, y1); boundRects(r); }
    else r.push(x0, y0, x1, y1);
    this.tracked = this.version;
  }

  /**
   * The rects holding every change since version `from` (an upload's), into
   * `out` (x0 y0 x1 y1 each, inside the image); their count, or -1 when that
   * is not known (an untracked change, or `from` older than the segments kept).
   */
  changedSince(from: number, out: number[]): number {
    if (this.tracked !== this.version) return -1;
    out.length = 0;
    for (const v of this.rects) out.push(v);
    let at = this.segFrom;
    const s = this.segs;
    for (let i = s.length - 1; at > from && i >= 0; i--) {
      if (s[i]!.to !== at) return -1;
      at = s[i]!.from;
      for (const v of s[i]!.rects) out.push(v);
    }
    if (at !== from) return -1;
    if (out.length > MAX_RECTS * 8) boundRects(out);
    let n = 0;
    for (let i = 0; i < out.length; i += 4) {
      const x0 = Math.max(0, out[i]!), y0 = Math.max(0, out[i + 1]!), x1 = Math.min(this.w, out[i + 2]!), y1 = Math.min(this.h, out[i + 3]!);
      if (x1 <= x0 || y1 <= y0) continue;
      out[n * 4] = x0; out[n * 4 + 1] = y0; out[n * 4 + 2] = x1; out[n * 4 + 3] = y1;
      n++;
    }
    out.length = n * 4;
    return n;
  }

  /** An Image uploaded this version: the open segment closes here. */
  uploadedNow(): void {
    if (this.tracked !== this.version) {
      this.segs.length = 0;
      this.tracked = this.version;
    } else if (this.rects.length) {
      this.segs.push({ from: this.segFrom, to: this.version, rects: this.rects });
      if (this.segs.length > 4) this.segs.shift();
      this.rects = [];
    }
    this.segFrom = this.version;
  }

  override setPixel(x: number, y: number, r: number, g: number, b: number, a = 1): void {
    super.setPixel(x, y, r, g, b, a);
    this.version++;
    if (!this.bulk) this.mark(x, y, x + 1, y + 1);
  }
  /** Inside mapPixel: its rect is marked once, not each pixel. */
  private bulk = false;
  override paste(src: BaseImageData, dx: number, dy: number, sx?: number, sy?: number, sw?: number, sh?: number): void {
    // a rect inside both images, by the host's copy where it has one (NOT
    // FAITHFUL: performance, the same bytes) -- the base's row copies make a
    // typed-array view per row, and a tile animation step pastes a whole
    // bank of 16x16 cells
    if (!(nativeBlit && src !== this
        && nativeBlit(this.px, this.w, dx, dy, src.px, src.w, sx ?? 0, sy ?? 0, sw ?? src.w, sh ?? src.h))) {
      super.paste(src, dx, dy, sx, sy, sw, sh);
    }
    this.version++;
    this.mark(dx, dy, dx + (sw ?? src.w), dy + (sh ?? src.h));
  }
  override mapPixel(fn: (x: number, y: number, r: number, g: number, b: number, a: number) => [number, number, number, number],
    x0?: number, y0?: number, w?: number, h?: number): void {
    this.bulk = true;
    try { super.mapPixel(fn, x0, y0, w, h); } finally { this.bulk = false; }
    this.version++;
    const ax = x0 ?? 0, ay = y0 ?? 0;
    this.mark(ax, ay, ax + (w ?? this.w), ay + (h ?? this.h));
  }
  clone(): ImageData {
    return new ImageData(this.w, this.h, this.px.slice());
  }
  getFormat(): string { return "rgba8"; }
  type(): string { return "ImageData"; }
  typeOf(t: string): boolean { return t === "ImageData" || t === "Data" || t === "Object"; }
}

/** love.filesystem FileData: encoded bytes (a PNG) and a name. */
export class FileData {
  constructor(readonly bytes: string, readonly name: string) {}
  getString(): string { return this.bytes; }
  getSize(): number { return this.bytes.length; }
}

/**
 * love.image.newImageData(w, h[, format[, rawdata]]) | (FileData) | (path).
 * A path or FileData decodes a PNG.
 */
export function newImageData(a: number | FileData | string, h?: number, _fmt?: string, data?: string | Uint8Array): ImageData {
  if (typeof a === "number") return new ImageData(a, h!, data);
  const bytes = typeof a === "string" ? getHost().read(a) : a.bytes;
  if (bytes === undefined) throw new Error(`newImageData: cannot read ${typeof a === "string" ? a : a.name}`);
  // the host's decoder where it has one and gives the same pixels (G3Host.pngDecode)
  const nat = getHost().pngDecode?.(bytes);
  if (nat) return new ImageData(nat[0], nat[1], nat[2]);
  const png = decodePngBytes(toBytes(bytes));
  return new ImageData(png.w, png.h, png.rgba);
}

export class Image {
  readonly id: number;
  w: number;
  h: number;
  /** The pixels, when the guest made this image (needed for CPU effect variants). */
  data: ImageData | undefined;
  private uploaded = -1;
  filter = "nearest";
  wrap = "clamp";
  isCanvas = false;
  /** Watched for collection (collectTextures): it has a host texture. */
  watched = false;
  /** The cache path a host-made image came from (made again after a release). */
  src: string | undefined;
  /** release() gave the host texture back; a later draw makes it again. */
  protected freed = false;

  constructor(w: number, h: number, data?: ImageData, id = allocTexId()) {
    this.id = id;
    this.w = w;
    this.h = h;
    this.data = data;
  }

  /** The host has this image's current pixels. */
  sync(): void {
    const d = this.data;
    if (d && this.uploaded !== d.version) {
      if (this.freed) { this.freed = false; unfree(this.id); }
      const host = getHost();
      // only what changed since this image's last upload, where the host
      // can write it in place (NOT FAITHFUL: performance, same pixels)
      const n = this.uploaded >= 0 && host.texSub ? d.changedSince(this.uploaded, SUB) : -1;
      if (n > 0) {
        if (SUB32.length < n * 4) SUB32 = new Int32Array(n * 8);
        for (let i = 0; i < n * 4; i++) SUB32[i] = SUB[i]!;
      }
      if (n !== 0 && !(n > 0 && host.texSub!(this.id, this.w, this.h, SUB32, n, d.px))) {
        host.texUpload(this.id, this.w, this.h, d.px, this.wrap === "repeat");
      }
      d.uploadedNow();
      this.uploaded = d.version;
      watch(this);
    } else if (this.freed) this.remake();
  }

  /**
   * A released image drawn again (a draw memo replays the images it
   * recorded, which LÖVE code never does with a released one): its texture
   * is made again from its cache path (an image with pixels is uploaded
   * again by sync).
   */
  private remake(): void {
    this.freed = false;
    unfree(this.id);
    if (this.src !== undefined && getHost().texFromCache(this.id, this.src)) watch(this);
  }

  getDimensions(): [number, number] { return [this.w, this.h]; }
  getWidth(): number { return this.w; }
  getHeight(): number { return this.h; }
  setFilter(min: string, _mag?: string): void { this.filter = min; }
  getFilter(): [string, string] { return [this.filter, this.filter]; }
  setWrap(h: string, _v?: string): void {
    this.wrap = h;
    this.uploaded = -1; // the host learns the wrap on upload
  }
  /** Image:replacePixels(imageData) -- whole image. */
  replacePixels(d: ImageData): void {
    // the same data again (the field's double-buffered atlases): the host
    // holds this image's pixels as of its last upload, and sync sends what
    // changed since
    if (d !== this.data || this.w !== d.w || this.h !== d.h) this.uploaded = -1;
    this.data = d;
  }
  /**
   * The host texture back (at the next frame, collectTextures). The pixels
   * stay with the Image, so a draw memo that replays it after this still
   * draws it (sync uploads it again); LÖVE code itself never draws a
   * released image.
   */
  release(): void {
    if (this.freed) return;
    this.freed = true;
    this.watched = false;
    this.uploaded = -1;
    freeLater.add(this.id);
  }
  type(): string { return this.isCanvas ? "Canvas" : "Image"; }
  typeOf(t: string): boolean { return t === this.type() || t === "Texture" || t === "Drawable" || t === "Object"; }
}

/** love.graphics.newImage(imageData | path) */
export function newImage(src: ImageData | string | FileData): Image {
  if (src instanceof ImageData) {
    const img = new Image(src.w, src.h, src);
    return img;
  }
  if (src instanceof FileData) {
    const d = newImageData(src);
    return new Image(d.w, d.h, d);
  }
  // a cache path: a cooked image the host holds; fall back to decoding it here
  const id = allocTexId();
  const dims = getHost().texFromCache(id, src);
  if (dims) {
    const img = new Image(dims[0], dims[1], undefined, id);
    img.src = src;
    watch(img);
    return img;
  }
  const d = newImageData(src);
  return new Image(d.w, d.h, d, id);
}

export class Canvas extends Image {
  constructor(w: number, h: number) {
    super(w, h);
    this.isCanvas = true;
    getHost().canvasNew(this.id, w, h);
    watch(this);
  }
  /** A released canvas drawn again is made again (empty: its pixels went with it). */
  override sync(): void {
    if (!this.freed) return;
    this.freed = false;
    unfree(this.id);
    getHost().canvasNew(this.id, this.w, this.h);
    watch(this);
  }
  override replacePixels(): void { throw new Error("Canvas:replacePixels"); }
}

export class Quad {
  constructor(public x: number, public y: number, public w: number, public h: number,
    public sw: number, public sh: number) {}
  setViewport(x: number, y: number, w: number, h: number, sw?: number, sh?: number): void {
    this.x = x; this.y = y; this.w = w; this.h = h;
    if (sw !== undefined) this.sw = sw;
    if (sh !== undefined) this.sh = sh;
  }
  getViewport(): [number, number, number, number] { return [this.x, this.y, this.w, this.h]; }
  getTextureDimensions(): [number, number] { return [this.sw, this.sh]; }
  type(): string { return "Quad"; }
}

export interface BatchEntry { quad: Quad | undefined; x: number; y: number; r: number; sx: number; sy: number }

let nextBatchId = 1;

export class SpriteBatch {
  texture: Image;
  entries: BatchEntry[] = [];
  /** The host's name for this batch (G3Host.batchUpload). */
  readonly id = nextBatchId++;
  /** Bumped by every change; the host copy is re-sent only then. */
  version = 0;
  uploaded = -1;
  /** Watched for collection (collectTextures): the host holds a copy. */
  watched = false;
  /**
   * The host copy's quads as last sent (graphics.ts uploadBatch), 12 floats
   * per entry in entry order (a hidden entry's are -1e6: the host skips
   * it), and the entries changed since: only those are worked out again.
   */
  out: Float32Array | null = null;
  dirty: number[] = [];
  dirtyAll = true;
  constructor(texture: Image, readonly capacity = 1000) { this.texture = texture; }
  /** add(quad, x, y[, r, sx, sy]) -> 1-based index */
  add(quad: Quad | number, x?: number, y?: number, r = 0, sx = 1, sy?: number): number {
    this.version++;
    if (typeof quad === "number") {
      this.entries.push({ quad: undefined, x: quad, y: x ?? 0, r: y ?? 0, sx: 1, sy: 1 });
    } else {
      this.entries.push({ quad, x: x ?? 0, y: y ?? 0, r, sx, sy: sy ?? sx });
    }
    this.dirty.push(this.entries.length - 1);
    return this.entries.length;
  }
  set(index: number, quad: Quad, x = 0, y = 0, r = 0, sx = 1, sy?: number): void {
    const e = this.entries[index - 1];
    const syv = sy ?? sx;
    // re-setting a cell to what it already shows is common (field_view re-samples)
    if (e && e.quad === quad && e.x === x && e.y === y && e.r === r && e.sx === sx && e.sy === syv) return;
    this.version++;
    if (e) { e.quad = quad; e.x = x; e.y = y; e.r = r; e.sx = sx; e.sy = syv; }
    else { if (index - 1 > this.entries.length) this.dirtyAll = true; this.entries[index - 1] = { quad, x, y, r, sx, sy: syv }; }
    this.dirty.push(index - 1);
  }
  clear(): void { if (this.entries.length) this.version++; this.entries.length = 0; this.dirtyAll = true; }
  getCount(): number { return this.entries.length; }
  getTexture(): Image { return this.texture; }
  setTexture(t: Image): void {
    // the host draws a batch with the texture its draw op names, and the
    // quads it holds depend on the texture only through its size (a quadless
    // cell's frame): another texture of the same size needs no re-send (the
    // field's double-buffered atlases swap on every tile animation step)
    const o = this.texture;
    if (t !== o && (t.w !== o.w || t.h !== o.h)) { this.version++; this.dirtyAll = true; }
    this.texture = t;
  }
  flush(): void {}
  release(): void {
    this.entries.length = 0;
    this.dirtyAll = true;
    this.version++;
    // the host's copy goes once the list naming it has been rendered (collectTextures)
    if (hasHost()) batchFreeLater.add(this.id);
    this.watched = false;
    this.uploaded = -1;
  }
  type(): string { return "SpriteBatch"; }
}
