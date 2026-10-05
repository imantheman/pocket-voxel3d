// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). LÖVE's drawables as the port uses them: Image (a host
// texture, with its source ImageData kept when the guest made it), Canvas
// (a render target), Quad, SpriteBatch; and love.image's ImageData /
// love.filesystem's FileData for PNG bytes.

import { getHost } from "./host.ts";
import { ImageData as BaseImageData } from "../../../import/gen3/imagedata.ts";
import { decodePngBytes } from "./pngdecode.ts";
import { toBytes } from "../../../import/gen3/lua.ts";

let nextTexId = 1;
export function allocTexId(): number { return nextTexId++; }

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

  constructor(w: number, h: number, data?: ImageData, id = allocTexId()) {
    this.id = id;
    this.w = w;
    this.h = h;
    this.data = data;
  }

  /** The host has this image's current pixels. */
  sync(): void {
    if (this.data && this.uploaded !== this.data.version) {
      getHost().texUpload(this.id, this.w, this.h, this.data.px, this.wrap === "repeat");
      this.uploaded = this.data.version;
    }
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
  release(): void {
    getHost().texFree(this.id);
    this.data = undefined;
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
  if (dims) return new Image(dims[0], dims[1], undefined, id);
  const d = newImageData(src);
  return new Image(d.w, d.h, d, id);
}

export class Canvas extends Image {
  constructor(w: number, h: number) {
    super(w, h);
    this.isCanvas = true;
    getHost().canvasNew(this.id, w, h);
  }
  override sync(): void {}
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

export class SpriteBatch {
  texture: Image;
  entries: BatchEntry[] = [];
  constructor(texture: Image, readonly capacity = 1000) { this.texture = texture; }
  /** add(quad, x, y[, r, sx, sy]) -> 1-based index */
  add(quad: Quad | number, x?: number, y?: number, r = 0, sx = 1, sy?: number): number {
    if (typeof quad === "number") {
      this.entries.push({ quad: undefined, x: quad, y: x ?? 0, r: y ?? 0, sx: 1, sy: 1 });
    } else {
      this.entries.push({ quad, x: x ?? 0, y: y ?? 0, r, sx, sy: sy ?? sx });
    }
    return this.entries.length;
  }
  set(index: number, quad: Quad, x = 0, y = 0, r = 0, sx = 1, sy?: number): void {
    this.entries[index - 1] = { quad, x, y, r, sx, sy: sy ?? sx };
  }
  clear(): void { this.entries.length = 0; }
  getCount(): number { return this.entries.length; }
  getTexture(): Image { return this.texture; }
  setTexture(t: Image): void { this.texture = t; }
  flush(): void {}
  release(): void { this.entries.length = 0; }
  type(): string { return "SpriteBatch"; }
}
