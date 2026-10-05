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
  draw(list: number[]): void;
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
