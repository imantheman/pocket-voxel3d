// Port of gen1recomp src/ui/game3/shop_chrome.lua (GPLv3 + additional terms; see LICENSE.md).
// FRLG Poké Mart shop chrome loader (items/shop/bg.rgba). Lazily required by
// gen1recomp (pcall(require, "src.ui.game3.shop_chrome")); it registers in
// G3Lazy at the end.

import { tostring } from "../../../import/gen3/lua.ts";
import { G } from "../platform/graphics.ts";
import { newImageData, type Image, type ImageData } from "../platform/image.ts";
import { Fs } from "../platform/fs.ts";
import { luaLoad } from "../platform/luadata.ts";
import { gsub } from "../platform/lpattern.ts";
import type { LuaTable } from "../platform/lt.ts";
import { NotPortedError } from "../notported.ts";
import { Extract } from "../../../import/gen3/extract_island1.ts";
import { ShopChromeExtract } from "../../../import/gen3/shop_chrome_extract.ts";
import { Dataset } from "../core/dataset.ts";
import { CacheFs } from "../shared/import/CacheFs.ts";
import { G3Lazy } from "../core/lazy_registry.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

interface ReadCache { read(rel: string): string | undefined }

/** `pcall(require, X)` and a call into it: a stub there is a failed require. */
function tryStub<T>(f: () => T): T | undefined {
  try {
    return f();
  } catch (e) {
    if (e instanceof NotPortedError) return undefined;
    throw e;
  }
}

// Lua: shop_chrome.lua:14
function cache_root(): string {
  return Extract.CACHE_ROOT || "data/generated/gba";
}

// Lua: shop_chrome.lua:18
function shop_root(): string {
  return cache_root() + "/" + ShopChromeExtract.CACHE_SUB;
}

// Lua: shop_chrome.lua:22
function log(msg: unknown): void {
  if (ShopChrome._logged) return;
  ShopChrome._logged = true;
  console.log("[game3/shop_chrome] " + tostring(msg));
}

// Lua: shop_chrome.lua:28
function resolve_cache(cache?: any): ReadCache {
  if (cache && cache.read) return cache;
  if (Dataset && Dataset.cache) {
    return Dataset.cache();
  }
  return {
    read: (rel: string): string | undefined => {
      if (CacheFs && CacheFs.readActive) {
        return tryStub(() => CacheFs.readActive(rel));
      }
      return undefined;
    },
  };
}

// Lua: shop_chrome.lua:45
function read_bytes(rel: string): string | undefined {
  const cache = ShopChrome._cache;
  if (cache && cache.read) {
    const d = cache.read(rel);
    if (typeof d === "string" && d.length > 0) return d;
  }
  if (Dataset && Dataset.cache) {
    const d = Dataset.cache().read(rel);
    if (typeof d === "string" && d.length > 0) return d;
  }
  if (CacheFs && CacheFs.readActive) {
    const d = tryStub(() => CacheFs.readActive(rel));
    if (typeof d === "string" && d.length > 0) return d;
  }
  let d = Fs.read(rel);
  if (typeof d === "string" && d.length > 0) return d;
  const alt = "data/generated/gba/" + gsub(rel, "^data/generated/gba/", "")[0];
  d = Fs.read(alt);
  if (typeof d === "string" && d.length > 0) return d;
  // NOT FAITHFUL: the io.open candidates are the two paths Fs just tried;
  // there is no stdio on the 3DS.
  return undefined;
}

// Lua: shop_chrome.lua:83
function load_lua(rel: string): LuaTable | undefined {
  const src = read_bytes(rel);
  if (!src) return undefined;
  const [chunk] = luaLoad(src, "@" + rel);
  if (!chunk) return undefined;
  try { return chunk(); } catch { return undefined; }
}

// Lua: shop_chrome.lua:93
function rgba_to_image(rgba: string | undefined, w: number, h: number): Image | undefined {
  if (!rgba || rgba.length < w * h * 4) return undefined;
  let imageData: ImageData | undefined;
  try { imageData = newImageData(w, h, "rgba8", rgba.length === w * h * 4 ? rgba : rgba.slice(0, w * h * 4)); } catch { imageData = undefined; }
  if (!imageData) return undefined;
  const image = G.newImage(imageData);
  if (image.setFilter) image.setFilter("nearest", "nearest");
  return image;
}

export const ShopChrome = {
  _cache: undefined as ReadCache | undefined,
  _manifest: undefined as LuaTable,
  _bg: undefined as Image | undefined,
  _bgTm: undefined as Image | undefined,
  _logged: false,

  // Lua: shop_chrome.lua:103
  install(cache?: unknown): void {
    ShopChrome._cache = resolve_cache(cache);
    ShopChrome._manifest = undefined;
    ShopChrome._bg = undefined;
    ShopChrome._bgTm = undefined;
    ShopChrome._logged = false;

    const root = shop_root();
    ShopChrome._manifest = load_lua(root + "/manifest.lua");
    const bgData = read_bytes(root + "/bg.rgba");
    const bgTmData = read_bytes(root + "/bg_tm.rgba");

    ShopChrome._bg = rgba_to_image(bgData, 240, 160);
    ShopChrome._bgTm = rgba_to_image(bgTmData, 240, 160);

    if (!ShopChrome._bg) {
      log("shop chrome missing \xE2\x80\x94 re-run extract");
    }
  },

  // Lua: shop_chrome.lua:123
  ensureInstalled(): void {
    if (!ShopChrome._cache) {
      ShopChrome.install();
    }
  },

  // Lua: shop_chrome.lua:129
  ready(): boolean {
    ShopChrome.ensureInstalled();
    return ShopChrome._bg != null;
  },

  // Lua: shop_chrome.lua:134
  bg(isTm?: boolean): Image | undefined {
    ShopChrome.ensureInstalled();
    if (isTm && ShopChrome._bgTm) {
      return ShopChrome._bgTm;
    }
    return ShopChrome._bg;
  },

  // Lua: shop_chrome.lua:142
  drawBg(x?: number, y?: number, isTm?: boolean): boolean {
    const img = ShopChrome.bg(isTm);
    if (img) {
      G.setColor(1, 1, 1, 1);
      G.draw(img, x ?? 0, y ?? 0);
      return true;
    }
    return false;
  },
};

export default ShopChrome;

G3Lazy["src.ui.game3.shop_chrome"] = ShopChrome;
