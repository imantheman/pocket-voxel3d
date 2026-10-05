// Port support for gen1recomp's FireRed importer (GPLv3 + additional terms;
// see LICENSE.md). love.image's ImageData, as the importer uses it: RGBA8
// pixels, channels 0..1 at the API (as LOVE), PNG encode through png.ts.
// Rounding follows LOVE 11's float->byte conversion (x * 255 + 0.5, clamped).

import { encodePng } from "./png.ts";
import { fromBytes, toBytes } from "./lua.ts";

function toByte(v: number): number {
  const b = Math.floor(v * 255 + 0.5);
  return b < 0 ? 0 : b > 255 ? 255 : b;
}

export class ImageData {
  readonly w: number;
  readonly h: number;
  readonly px: Uint8Array;

  constructor(w: number, h: number, bytes?: string | Uint8Array) {
    this.w = w;
    this.h = h;
    this.px = new Uint8Array(w * h * 4);
    if (bytes !== undefined) this.px.set(typeof bytes === "string" ? toBytes(bytes).subarray(0, w * h * 4) : bytes.subarray(0, w * h * 4));
  }

  /** love.image.newImageData(w, h[, format, bytes]) */
  static new(w: number, h: number, _format?: string, bytes?: string | Uint8Array): ImageData {
    return new ImageData(w, h, bytes);
  }

  getWidth(): number { return this.w; }
  getHeight(): number { return this.h; }
  getDimensions(): [number, number] { return [this.w, this.h]; }

  setPixel(x: number, y: number, r: number, g: number, b: number, a = 1): void {
    const o = (y * this.w + x) * 4;
    this.px[o] = toByte(r); this.px[o + 1] = toByte(g); this.px[o + 2] = toByte(b); this.px[o + 3] = toByte(a);
  }

  getPixel(x: number, y: number): [number, number, number, number] {
    const o = (y * this.w + x) * 4;
    return [this.px[o]! / 255, this.px[o + 1]! / 255, this.px[o + 2]! / 255, this.px[o + 3]! / 255];
  }

  mapPixel(fn: (x: number, y: number, r: number, g: number, b: number, a: number) => [number, number, number, number],
    x0 = 0, y0 = 0, w = this.w, h = this.h): void {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
      const [r, g, b, a] = this.getPixel(x, y);
      const out = fn(x, y, r, g, b, a);
      this.setPixel(x, y, out[0], out[1], out[2], out[3]);
    }
  }

  paste(src: ImageData, dx: number, dy: number, sx = 0, sy = 0, sw = src.w, sh = src.h): void {
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      const tx = dx + x, ty = dy + y;
      if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) continue;
      const so = ((sy + y) * src.w + sx + x) * 4, to = (ty * this.w + tx) * 4;
      this.px.set(src.px.subarray(so, so + 4), to);
    }
  }

  /** The raw RGBA bytes as a byte string (ImageData:getString). */
  getString(): string { return fromBytes(this.px); }

  /** ImageData:encode("png") -> FileData-like with getString(). */
  encode(format: string): { getString(): string; bytes: Uint8Array } {
    if (format !== "png") throw new Error("ImageData:encode: only png");
    const bytes = encodePng(this.w, this.h, this.px);
    return { bytes, getString: () => fromBytes(bytes) };
  }

  release(): void {}
}

export default ImageData;
