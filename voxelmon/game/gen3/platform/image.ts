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
  }
}

/** The textures watched (tools: the live count). */
export function watchedTextures(): number { return watchRefs.length; }

/** love.image ImageData, plus the methods the runtime uses beyond the importer's. */
export class ImageData extends BaseImageData {
  /** Bumped on every change, so an Image made from it can tell it is stale. */
  version = 0;
  override setPixel(x: number, y: number, r: number, g: number, b: number, a = 1): void {
    super.setPixel(x, y, r, g, b, a);
    this.version++;
  }
  override paste(src: BaseImageData, dx: number, dy: number, sx?: number, sy?: number, sw?: number, sh?: number): void {
    super.paste(src, dx, dy, sx, sy, sw, sh);
    this.version++;
  }
  override mapPixel(fn: (x: number, y: number, r: number, g: number, b: number, a: number) => [number, number, number, number],
    x0?: number, y0?: number, w?: number, h?: number): void {
    super.mapPixel(fn, x0, y0, w, h);
    this.version++;
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
    if (this.data && this.uploaded !== this.data.version) {
      if (this.freed) { this.freed = false; unfree(this.id); }
      getHost().texUpload(this.id, this.w, this.h, this.data.px, this.wrap === "repeat");
      this.uploaded = this.data.version;
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
    this.data = d;
    this.uploaded = -1;
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
  constructor(texture: Image, readonly capacity = 1000) { this.texture = texture; }
  /** add(quad, x, y[, r, sx, sy]) -> 1-based index */
  add(quad: Quad | number, x?: number, y?: number, r = 0, sx = 1, sy?: number): number {
    this.version++;
    if (typeof quad === "number") {
      this.entries.push({ quad: undefined, x: quad, y: x ?? 0, r: y ?? 0, sx: 1, sy: 1 });
    } else {
      this.entries.push({ quad, x: x ?? 0, y: y ?? 0, r, sx, sy: sy ?? sx });
    }
    return this.entries.length;
  }
  set(index: number, quad: Quad, x = 0, y = 0, r = 0, sx = 1, sy?: number): void {
    const e = this.entries[index - 1];
    const syv = sy ?? sx;
    // re-setting a cell to what it already shows is common (field_view re-samples)
    if (e && e.quad === quad && e.x === x && e.y === y && e.r === r && e.sx === sx && e.sy === syv) return;
    this.version++;
    if (e) { e.quad = quad; e.x = x; e.y = y; e.r = r; e.sx = sx; e.sy = syv; }
    else this.entries[index - 1] = { quad, x, y, r, sx, sy: syv };
  }
  clear(): void { if (this.entries.length) this.version++; this.entries.length = 0; }
  getCount(): number { return this.entries.length; }
  getTexture(): Image { return this.texture; }
  setTexture(t: Image): void { if (t !== this.texture) this.version++; this.texture = t; }
  flush(): void {}
  release(): void {
    this.entries.length = 0;
    this.version++;
    if (hasHost()) getHost().batchFree?.(this.id);
    this.uploaded = -1;
  }
  type(): string { return "SpriteBatch"; }
}
