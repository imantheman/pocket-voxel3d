// Port of gen1recomp src/ui/game3/berry_pouch_chrome.lua (GPLv3 + additional terms; see LICENSE.md).
// Berry Pouch chrome loader and renderer from CacheFS (items/berry_pouch/).
// Lazily required by gen1recomp (pcall(require,
// "src.ui.game3.berry_pouch_chrome")); it registers in G3Lazy at the end.

import { G } from "../platform/graphics.ts";
import { newImageData, type Image, type ImageData } from "../platform/image.ts";
import { Fs } from "../platform/fs.ts";
import { gsub } from "../platform/lpattern.ts";
import type { LuaTable } from "../platform/lt.ts";
import { NotPortedError } from "../notported.ts";
import { Extract } from "../../../import/gen3/extract_island1.ts";
import { BerryPouchExtract } from "../../../import/gen3/berry_pouch_extract.ts";
import { Dataset } from "../core/dataset.ts";
import { CacheFs } from "../shared/import/CacheFs.ts";
import { G3Lazy } from "../core/lazy_registry.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

interface DrawOpts { female?: boolean }

/** `pcall(require, X)` and a call into it: a stub there is a failed require. */
function tryStub<T>(f: () => T): T | undefined {
  try {
    return f();
  } catch (e) {
    if (e instanceof NotPortedError) return undefined;
    throw e;
  }
}

// Lua: berry_pouch_chrome.lua:15
function cache_root(): string {
  return Extract.CACHE_ROOT || "data/generated/gba";
}

// Lua: berry_pouch_chrome.lua:19
function bp_root(): string {
  return cache_root() + "/" + BerryPouchExtract.CACHE_SUB;
}

// Lua: berry_pouch_chrome.lua:23
function read_bytes(rel: string): string | undefined {
  const cache = BerryPouchChrome._cache;
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

// Lua: berry_pouch_chrome.lua:61
function rgba_to_image(rgba: string, w: number, h: number): Image | undefined {
  // Brian's ffi.copy / setPixel loop: the first w*h*4 bytes, one copy here.
  let data: ImageData | undefined;
  try { data = newImageData(w, h, "rgba8", rgba.length === w * h * 4 ? rgba : rgba.slice(0, w * h * 4)); } catch { data = undefined; }
  if (!data) return undefined;
  const img = G.newImage(data);
  if (img && img.setFilter) {
    img.setFilter("nearest", "nearest");
  }
  return img;
}

export const BerryPouchChrome = {
  _cache: undefined as any,
  _bgMale: undefined as Image | undefined,
  _bgFemale: undefined as Image | undefined,
  _pouch: undefined as Image | undefined,
  _manifest: undefined as LuaTable,
  _logged: false,

  // Lua: berry_pouch_chrome.lua:89
  ready(): boolean {
    if (BerryPouchChrome._bgMale) return true;
    const d = read_bytes(bp_root() + "/bg_male.rgba");
    return d != null && d.length > 0;
  },

  // Lua: berry_pouch_chrome.lua:95
  loadBg(female?: boolean): Image | undefined {
    if (female && BerryPouchChrome._bgFemale) return BerryPouchChrome._bgFemale;
    if (!female && BerryPouchChrome._bgMale) return BerryPouchChrome._bgMale;
    const filename = female ? "/bg_female.rgba" : "/bg_male.rgba";
    const raw = read_bytes(bp_root() + filename);
    if (!raw || raw.length < 240 * 160 * 4) return undefined;
    const img = rgba_to_image(raw, 240, 160);
    if (female) {
      BerryPouchChrome._bgFemale = img;
    } else {
      BerryPouchChrome._bgMale = img;
    }
    return img;
  },

  // Lua: berry_pouch_chrome.lua:110
  loadPouch(): Image | undefined {
    if (BerryPouchChrome._pouch) return BerryPouchChrome._pouch;
    const raw = read_bytes(bp_root() + "/pouch.rgba");
    if (!raw || raw.length < 64 * 64 * 4) return undefined;
    const img = rgba_to_image(raw, 64, 64);
    BerryPouchChrome._pouch = img;
    return img;
  },

  // Lua: berry_pouch_chrome.lua:119
  drawBg(x?: number, y?: number, opts?: DrawOpts): boolean {
    opts = opts || {};
    const img = BerryPouchChrome.loadBg(opts.female);
    if (img) {
      G.setColor(1, 1, 1, 1);
      G.draw(img, x ?? 0, y ?? 0);
      return true;
    }
    return false;
  },

  // Lua: berry_pouch_chrome.lua:130
  drawPouch(x?: number, y?: number, angle?: number): boolean {
    const img = BerryPouchChrome.loadPouch();
    if (img) {
      G.setColor(1, 1, 1, 1);
      if (angle != null && Math.abs(angle) > 0.001) {
        G.draw(img, (x ?? 0) + 32, (y ?? 0) + 32, angle, 1, 1, 32, 32);
      } else {
        G.draw(img, x ?? 0, y ?? 0);
      }
      return true;
    }
    return false;
  },
};

export default BerryPouchChrome;

G3Lazy["src.ui.game3.berry_pouch_chrome"] = BerryPouchChrome;
