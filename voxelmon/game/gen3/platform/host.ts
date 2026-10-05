// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). What the gen3 guest needs from its host: textures, the
// per-frame draw list, cache reads, the clock. The 3DS host implements it
// over QuickJS natives; tests use platform/desktop.ts.

export interface G3Host {
  /** Upload RGBA8 pixels as texture `id` (replacing any texture with that id). */
  texUpload(id: number, w: number, h: number, rgba: Uint8Array, repeat: boolean): void;
  /** Make texture `id` from a cooked image in the cache (`path`); its [w, h], or undefined. */
  texFromCache(id: number, path: string): [number, number] | undefined;
  /** Make texture `id` a w x h render target (a canvas). */
  canvasNew(id: number, w: number, h: number): void;
  texFree(id: number): void;
  /** One composed frame's draw list (drawlist.ts). */
  /** The view is valid only during the call (the guest reuses the storage). */
  draw(list: Float32Array): void;
  /**
   * Optional: hold sprite batch `id` -- `count` quads of 12 floats each
   * (x0 y0 x1 y1 x2 y2 x3 y3 u0 v0 u1 v1, batch-local, corners TL TR BR BL)
   * on texture `tex` -- for OP_BATCH to draw. Replaces any batch with that id.
   * A host without it is sent the quads every frame instead.
   */
  batchUpload?(id: number, tex: number, quads: Float32Array, count: number): void;
  batchFree?(id: number): void;
  /**
   * Optional: a PNG (a byte string) decoded by the host -- [w, h, RGBA8] --
   * or undefined, when the guest's own decoder (pngdecode.ts) is to do it.
   * Only where the pixels are exactly the guest decoder's.
   */
  pngDecode?(png: string): [number, number, Uint8Array] | undefined;
  /** A cache file's bytes as a byte string, or undefined. */
  read(path: string): string | undefined;
  exists(path: string): boolean;
  /** Seconds, monotonic (love.timer.getTime). */
  now(): number;
}

let host: G3Host | undefined;

export function setHost(h: G3Host): void { host = h; }
export function getHost(): G3Host {
  if (!host) throw new Error("gen3 platform: no host bound (setHost)");
  return host;
}
export function hasHost(): boolean { return host !== undefined; }
