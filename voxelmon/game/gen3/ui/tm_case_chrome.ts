// Port of gen1recomp src/ui/game3/tm_case_chrome.lua (GPLv3 + additional terms; see LICENSE.md).
// TM Case chrome loader and renderer from CacheFS (items/tm_case/). Lazily
// required by gen1recomp (pcall(require, "src.ui.game3.tm_case_chrome")); it
// registers in G3Lazy at the end.

import { format, tonumber } from "../../../import/gen3/lua.ts";
import { G } from "../platform/graphics.ts";
import { newImageData, type Image, type ImageData } from "../platform/image.ts";
import { Fs } from "../platform/fs.ts";
import { gsub } from "../platform/lpattern.ts";
import type { LuaTable } from "../platform/lt.ts";
import { NotPortedError } from "../notported.ts";
import { Extract } from "../../../import/gen3/extract_island1.ts";
import { TmCaseExtract } from "../../../import/gen3/tm_case_extract.ts";
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

// Lua: tm_case_chrome.lua:19
function cache_root(): string {
  return Extract.CACHE_ROOT || "data/generated/gba";
}

// Lua: tm_case_chrome.lua:23
function tm_root(): string {
  return cache_root() + "/" + TmCaseExtract.CACHE_SUB;
}

// Lua: tm_case_chrome.lua:27
function read_bytes(rel: string): string | undefined {
  const cache = TmCaseChrome._cache;
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

// Lua: tm_case_chrome.lua:65
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

export const TmCaseChrome = {
  _cache: undefined as any,
  _bgMale: undefined as Image | undefined,
  _bgFemale: undefined as Image | undefined,
  _coverMale: undefined as Image | undefined,
  _coverFemale: undefined as Image | undefined,
  _discs: {} as Record<number, Image | undefined>, // typeIdx (0..16) -> Image (TM)
  _discsHm: {} as Record<number, Image | undefined>, // typeIdx (0..16) -> Image (HM)
  _hmIcon: undefined as Image | undefined,
  _manifest: undefined as LuaTable,
  _logged: false,
  _ready: undefined as boolean | undefined,

  // Lua: tm_case_chrome.lua:93
  ready(): boolean {
    if (TmCaseChrome._ready != null) return TmCaseChrome._ready;
    const d = read_bytes(tm_root() + "/bg_male.rgba");
    TmCaseChrome._ready = d != null && d.length > 0;
    return TmCaseChrome._ready;
  },

  // Lua: tm_case_chrome.lua:100
  loadBg(female?: boolean): Image | undefined {
    if (female && TmCaseChrome._bgFemale) return TmCaseChrome._bgFemale;
    if (!female && TmCaseChrome._bgMale) return TmCaseChrome._bgMale;
    const filename = female ? "/bg_female.rgba" : "/bg_male.rgba";
    const raw = read_bytes(tm_root() + filename);
    if (!raw || raw.length < 240 * 160 * 4) return undefined;
    const img = rgba_to_image(raw, 240, 160);
    if (female) {
      TmCaseChrome._bgFemale = img;
    } else {
      TmCaseChrome._bgMale = img;
    }
    return img;
  },

  // Lua: tm_case_chrome.lua:115
  loadCover(female?: boolean): Image | undefined {
    if (female && TmCaseChrome._coverFemale) return TmCaseChrome._coverFemale;
    if (!female && TmCaseChrome._coverMale) return TmCaseChrome._coverMale;
    const filename = female ? "/cover_female.rgba" : "/cover_male.rgba";
    const raw = read_bytes(tm_root() + filename);
    if (!raw || raw.length < 240 * 160 * 4) return undefined;
    const img = rgba_to_image(raw, 240, 160);
    if (female) {
      TmCaseChrome._coverFemale = img;
    } else {
      TmCaseChrome._coverMale = img;
    }
    return img;
  },

  // Lua: tm_case_chrome.lua:130
  loadDisc(typeIdxIn: unknown, isHm?: boolean): Image | undefined {
    const typeIdx = tonumber(typeIdxIn) ?? 0;
    const tbl = isHm ? TmCaseChrome._discsHm : TmCaseChrome._discs;
    if (tbl[typeIdx]) return tbl[typeIdx];
    const filename = isHm ? format("%s/disc_hm_%d.rgba", tm_root(), typeIdx)
      : format("%s/disc_%d.rgba", tm_root(), typeIdx);
    const raw = read_bytes(filename);
    if (!raw || raw.length < 32 * 32 * 4) {
      if (isHm) {
        // Fallback to standard TM disc if HM disc not baked yet
        return TmCaseChrome.loadDisc(typeIdx, false);
      }
      return undefined;
    }
    const img = rgba_to_image(raw, 32, 32);
    tbl[typeIdx] = img;
    return img;
  },

  // Lua: tm_case_chrome.lua:149
  loadHmIcon(): Image | undefined {
    if (TmCaseChrome._hmIcon) return TmCaseChrome._hmIcon;
    const raw = read_bytes(tm_root() + "/hm_icon.rgba");
    if (!raw || raw.length < 16 * 12 * 4) return undefined;
    const img = rgba_to_image(raw, 16, 12);
    TmCaseChrome._hmIcon = img;
    return img;
  },

  // Lua: tm_case_chrome.lua:158
  drawBg(x?: number, y?: number, opts?: DrawOpts): boolean {
    opts = opts || {};
    const img = TmCaseChrome.loadBg(opts.female);
    if (img) {
      G.setColor(1, 1, 1, 1);
      G.draw(img, x ?? 0, y ?? 0);
      return true;
    }
    return false;
  },

  // Lua: tm_case_chrome.lua:169
  drawCover(x?: number, y?: number, opts?: DrawOpts): boolean {
    opts = opts || {};
    const img = TmCaseChrome.loadCover(opts.female);
    if (img) {
      G.setColor(1, 1, 1, 1);
      G.draw(img, x ?? 0, y ?? 0);
      return true;
    }
    return false;
  },

  // Lua: tm_case_chrome.lua:180
  drawDisc(typeIdx: unknown, x: number, y: number, isHm?: boolean): boolean {
    const img = TmCaseChrome.loadDisc(typeIdx, isHm);
    if (img) {
      G.setColor(1, 1, 1, 1);
      G.draw(img, x, y);
      return true;
    }
    return false;
  },

  // Lua: tm_case_chrome.lua:190
  drawHmIcon(x: number, y: number): boolean {
    const img = TmCaseChrome.loadHmIcon();
    if (img) {
      G.setColor(1, 1, 1, 1);
      G.draw(img, x, y);
      return true;
    }
    return false;
  },
};

export default TmCaseChrome;

G3Lazy["src.ui.game3.tm_case_chrome"] = TmCaseChrome;
