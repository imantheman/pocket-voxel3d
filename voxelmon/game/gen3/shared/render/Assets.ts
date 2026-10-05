// Port of gen1recomp src/render/Assets.lua (GPLv3 + additional terms; see LICENSE.md).
// Central image cache plus the mod-visible asset search path. Every
// renderer goes through Assets.image, so an enabled mod could shadow a
// generated asset, and one flush() drops every downstream cache.
//
// No loader installed means resolve() is the identity (always so here: no
// mods load on the 3DS). love.graphics.newImage / love.image.newImageData /
// love.filesystem.getInfo are the platform's G.newImage, newImageData, Fs.

import { G } from "../../platform/graphics.ts";
import { newImageData, type Image, type ImageData } from "../../platform/image.ts";
import { Fs } from "../../platform/fs.ts";
import { ipairs, len, pairs } from "../../platform/lt.ts";

export interface AssetLoaderBridge {
  overrideOrder(): ({ id: string; path: string } | null)[];
  derivedPath(rel: string): string | undefined;
}

// resolved path -> Image
let cache: Record<string, Image> = {};
// downstream caches that must empty when the search path changes
const invalidators: ((() => void) | null)[] = [null];
// optional GPU release hooks for session end (never run on hot reload flush)
const releasers: ((() => void) | null)[] = [null];

const GENERATED = "assets/generated/";

// Lua: Assets.lua:27
function exists(path: string): boolean {
  return Fs.getInfo(path) !== undefined;
}

export const Assets = {
  /** The loader bridge; undefined until a mod loader installs one (never, here). */
  loader: undefined as AssetLoaderBridge | undefined,
  exists,

  // Lua: Assets.lua:36
  resolve(path: any): any {
    if (typeof path !== "string") return path;
    if (path.slice(0, GENERATED.length) !== GENERATED) return path;

    const rel = path.slice(GENERATED.length);
    const loader = Assets.loader;
    if (loader) {
      for (const [, mod] of ipairs<{ id: string; path: string }>(loader.overrideOrder())) {
        const candidate = mod.path + "/overrides/" + rel;
        if (exists(candidate)) return candidate;
      }
      const derived = loader.derivedPath(rel);
      if (derived) return derived;
    }
    return path;
  },

  // Lua: Assets.lua:57
  image(path: string): Image {
    const resolved = Assets.resolve(path);
    let image = cache[resolved];
    if (!image) {
      image = G.newImage(resolved);
      cache[resolved] = image;
    }
    return image;
  },

  // Lua: Assets.lua:69
  imageData(path: string): ImageData {
    return newImageData(Assets.resolve(path));
  },

  // Lua: Assets.lua:78
  register(hooks: (() => void) | { invalidate?: () => void; release?: () => void }): void {
    if (typeof hooks === "function") {
      invalidators[len(invalidators) + 1] = hooks;
      return;
    }
    if (hooks.invalidate) invalidators[len(invalidators) + 1] = hooks.invalidate;
    if (hooks.release) releasers[len(releasers) + 1] = hooks.release;
  },

  // Lua: Assets.lua:90
  invalidate(): void {
    cache = {};
    for (const [, fn] of ipairs<() => void>(invalidators)) {
      try { fn(); } catch { /* pcall */ }
    }
  },

  flush: undefined as unknown as () => void,

  // Lua: Assets.lua:100
  releaseSession(): void {
    for (const [, img] of pairs<Image & { release?: () => void }>(cache)) {
      if (img && img.release) {
        try { img.release(); } catch { /* pcall */ }
      }
    }
    cache = {};
    for (const [, fn] of ipairs<() => void>(releasers)) {
      try { fn(); } catch { /* pcall */ }
    }
  },

  // Lua: Assets.lua:111
  installLoader(loader: any): void {
    if (!loader) {
      Assets.loader = undefined;
      Assets.invalidate();
      return;
    }
    const bridge: AssetLoaderBridge = {
      overrideOrder() {
        const order: ({ id: string; path: string } | null)[] = [null];
        const loaded = loader.loaded || [null];
        for (let i = len(loaded); i >= 1; i--) {
          order[len(order) + 1] = { id: loaded[i].manifest.id, path: loaded[i].path };
        }
        return order;
      },
      derivedPath(rel: string) {
        for (const [, mod] of ipairs<{ id: string; path: string }>(this.overrideOrder())) {
          const candidate = "save/mod-derived/" + mod.id + "/" + rel;
          if (exists(candidate)) return candidate;
        }
        return undefined;
      },
    };
    Assets.loader = bridge;
    Assets.invalidate();
  },
};

// Lua: Assets.lua:95
Assets.flush = Assets.invalidate;

export default Assets;
