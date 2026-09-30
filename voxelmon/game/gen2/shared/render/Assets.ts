// gen1recomp src/render/Assets.lua (bdfac727): images by path, cached.
//
// There are no image files here: every Gold graphic was cooked into the
// Gold screen's tile pages (voxelmon/cook/gen2lcd.ts), and an "image" is
// its grid of tile ids (platform/screen.ts LcdImage). Paths are accepted in
// either form the engine spells them -- a gfx key ("fonts/font") or Brian's
// asset path ("assets/generated/fonts/font.png").
//
// The manifest arrives from the dataset (`lcdGfx`, cook3ds's container) on
// the device; tests hand it over from the cook directly (setManifest).

import { loadGenerated } from "../../platform/data.ts";
import type { LcdImage } from "../../platform/screen.ts";

const GENERATED = "assets/generated/";

let manifest: Record<string, number[]> | null = null;
const cache = new Map<string, LcdImage>();
const invalidators: (() => void)[] = [];

/** Images the hardware shows as objects, never as map cells. */
const OBJ_PREFIXES = ["sprites/", "icons/"];

function keyOf(path: string): string {
  let k = path;
  if (k.startsWith(GENERATED)) k = k.slice(GENERATED.length);
  // older cache prefixes ("gold/assets/generated/...") and extensions
  k = k.replace(/^[a-z]+\/assets\/generated\//, "").replace(/\.png$/, "");
  return k;
}

function theManifest(): Record<string, number[]> {
  if (!manifest) manifest = loadGenerated<Record<string, number[]>>("lcdGfx") ?? {};
  return manifest;
}

function build(key: string, entry: readonly number[]): LcdImage {
  const tw = entry[0]!;
  const th = entry[1]!;
  const ids: number[] = [];
  for (let i = 2; i + 1 < entry.length; i += 2) for (let k = 0; k < entry[i + 1]!; k++) ids.push(entry[i]! + k);
  const w = tw * 8;
  const h = th * 8;
  return {
    key,
    w,
    h,
    tw,
    th,
    ids,
    obj: OBJ_PREFIXES.some((p) => key.startsWith(p)),
    getDimensions: () => [w, h],
    getWidth: () => w,
    getHeight: () => h,
    release: () => {},
    setFilter: () => {},
  };
}

export const Assets = {
  loader: null as unknown,

  /** Hand over the tile manifest (tests; the device reads it from the dataset). */
  setManifest(m: Record<string, number[]> | null): void {
    manifest = m;
    cache.clear();
  },

  exists(path: string): boolean {
    return theManifest()[keyOf(path)] !== undefined;
  },

  /** Assets.lua:18 -- mod overrides do not exist here, so the path itself. */
  resolve<T>(path: T): T {
    return path;
  },

  /**
   * Assets.lua:34. Throws for a graphic that was never cooked, like
   * love.graphics.newImage on a missing file (callers pcall it).
   */
  image(path: string): LcdImage {
    const key = keyOf(path);
    let img = cache.get(key);
    if (!img) {
      const entry = theManifest()[key];
      if (!entry) throw new Error(`Assets: no cooked graphic "${key}"`);
      img = build(key, entry);
      cache.set(key, img);
    }
    return img;
  },

  imageData(path: string): LcdImage {
    return Assets.image(path);
  },

  register(hooks: (() => void) | { invalidate?: () => void; release?: () => void }): void {
    if (typeof hooks === "function") invalidators.push(hooks);
    else if (hooks.invalidate) invalidators.push(hooks.invalidate);
  },

  invalidate(): void {
    cache.clear();
    for (const fn of invalidators) {
      try {
        fn();
      } catch {
        // Assets.lua pcalls these
      }
    }
  },

  releaseSession(): void {
    cache.clear();
  },

  installLoader(_loader: unknown): void {},
};

export default Assets;
