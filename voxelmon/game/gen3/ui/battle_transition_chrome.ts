// Port of gen1recomp src/ui/game3/battle_transition_chrome.lua (GPLv3 + additional terms; see LICENSE.md).
// FRLG battle transition chrome (ROM-baked under pokemon/battle_transition/).
//
// Port notes:
// - gen1recomp requires this module lazily (pcall(require) in
//   core/game3/battle_transition): it registers itself in G3Lazy under its
//   Lua name and is imported by core/lazy_modules.ts.
// - pcall(require, "src.core.game3.dataset") / "src.import.CacheFs" are
//   linked in (static imports), so those requires always succeed.
// - load_lua uses luaLoad (cache data chunks); the manifest comes back in the
//   lt.ts shape (mugshots / genders are sequences).
// - `love and love.image and love.graphics` guards are always true here and
//   are dropped. print -> console.log.
// - gridSquare's multiple returns are a tuple: [image, quads].
// - _gridQuads keeps Brian's 1-based keys (frame + 1); _gridFrames keeps
//   0-based frame keys (a plain JS array).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { byte, sub, tonumber, tostring, truthy } from "../../../import/gen3/lua.ts";
import { seq, ipairs, type LuaTable } from "../platform/lt.ts";
import { G } from "../platform/graphics.ts";
import { newImageData, type Image, type ImageData, type Quad } from "../platform/image.ts";
import { luaLoad } from "../platform/luadata.ts";
import Extract from "../../../import/gen3/extract_island1.ts";
import BattleTransitionExtract from "../../../import/gen3/battle_transition_extract.ts";
import Dataset from "../core/dataset.ts";
import CacheFs from "../shared/import/CacheFs.ts";
import { G3Lazy } from "../core/lazy_registry.ts";

export interface BattleTransitionChromeModule {
  _cache: any;
  _manifest: LuaTable | undefined;
  _bigPokeball: Image | undefined;
  _slidingPokeball: Image | undefined;
  _gridSquare: Image | undefined;
  _gridQuads: Record<number, Quad>;
  _gridFrames: (Image | undefined)[];
  _vsbars: Record<string, Image | undefined>;
  _banners: Record<string, Image | undefined>;
  _logged: boolean;
  _rseManifest?: LuaTable;
  _assets?: Record<string, any>;
  _assetImages?: Record<string, Image | false | undefined>;
  RSE_SUB: string;
  install(cache?: any): void;
  manifest(): LuaTable;
  assetInfo(key: any): any;
  assetPalette(key: string, which?: number, bank?: any): string | undefined;
  assetBanks(key: string, which?: number): number;
  assetImage(key: string, palBytes?: string): Image | undefined;
  rseManifest(): LuaTable;
  indexedImage(cacheKey: string, idx: LuaTable, w: number, h: number, palBytes: string): Image | undefined;
  ensureInstalled(): void;
  ready(): boolean;
  bigPokeball(): Image | undefined;
  slidingPokeball(): Image | undefined;
  gridSquare(): [Image | undefined, Record<number, Quad>];
  gridFrame(stage: number): Image | undefined;
  vsbar(mugshotKey?: any, genderKey?: any): Image | undefined;
  banner(mugshotKey?: any): Image | undefined;
}

export const BattleTransitionChrome = {} as BattleTransitionChromeModule;

BattleTransitionChrome._cache = undefined;
BattleTransitionChrome._manifest = undefined;
BattleTransitionChrome._bigPokeball = undefined;
BattleTransitionChrome._slidingPokeball = undefined;
BattleTransitionChrome._gridSquare = undefined;
BattleTransitionChrome._gridQuads = {};
BattleTransitionChrome._gridFrames = [];
BattleTransitionChrome._vsbars = {};
BattleTransitionChrome._banners = {};
BattleTransitionChrome._logged = false;

const MUGSHOT_KEYS = seq("lorelei", "bruno", "agatha", "lance", "blue");
const GENDER_KEYS = seq("male", "female");

// Lua: battle_transition_chrome.lua:22
function cache_root(): string {
  return truthy(Extract.CACHE_ROOT) ? Extract.CACHE_ROOT : "data/generated/gba";
}

// Lua: battle_transition_chrome.lua:26
function transition_root(): string {
  return cache_root() + "/" + BattleTransitionExtract.CACHE_SUB;
}

// Lua: battle_transition_chrome.lua:30
function log(msg: unknown): void {
  if (BattleTransitionChrome._logged) return;
  BattleTransitionChrome._logged = true;
  console.log("[game3/battle_transition_chrome] " + tostring(msg));
}

// Lua: battle_transition_chrome.lua:36
function resolve_cache(cache: any): any {
  if (truthy(cache) && truthy(cache.read)) return cache;
  // pcall(require, "src.core.game3.dataset")
  if (truthy(Dataset) && truthy(Dataset.cache)) {
    return Dataset.cache();
  }
  return {
    read: (rel: string): string | undefined => {
      // pcall(require, "src.import.CacheFs")
      if (truthy(CacheFs) && truthy(CacheFs.readActive)) {
        return CacheFs.readActive(rel);
      }
      return undefined;
    },
  };
}

// Lua: battle_transition_chrome.lua:53
function read_bytes(rel: string): string | undefined {
  const cache = BattleTransitionChrome._cache;
  if (truthy(cache) && truthy(cache.read)) {
    const d = cache.read(rel);
    if (typeof d === "string" && d.length > 0) return d;
  }
  // pcall(require, "src.core.game3.dataset")
  if (truthy(Dataset) && truthy(Dataset.cache)) {
    const d = Dataset.cache().read(rel);
    if (typeof d === "string" && d.length > 0) return d;
  }
  return undefined;
}

// Lua: battle_transition_chrome.lua:67
function load_lua(rel: string): LuaTable | undefined {
  const src = read_bytes(rel);
  if (!truthy(src)) return undefined;
  const [chunk] = luaLoad(src!, "@" + rel);
  if (!truthy(chunk)) return undefined;
  try {
    return (chunk as () => LuaTable)();
  } catch {
    return undefined;
  }
}

// Lua: battle_transition_chrome.lua:77
function rgba_to_data(rgba: string | undefined, w: number, h: number, keyed?: boolean): ImageData | undefined {
  if (!truthy(rgba) || rgba!.length < w * h * 4) return undefined;
  let imageData: ImageData | undefined;
  try { imageData = newImageData(w, h, "rgba8", rgba); } catch { imageData = undefined; }
  if (!imageData) return undefined;
  if (keyed) {
    const [kr, kg, kb] = imageData.getPixel(0, 0);
    imageData.mapPixel((_x, _y, r, g, b, a) => {
      if (r === kr && g === kg && b === kb) return [r, g, b, 0];
      return [r, g, b, a];
    });
  }
  return imageData;
}

// Lua: battle_transition_chrome.lua:92
function data_to_image(imageData: ImageData | undefined, wrap?: boolean): Image | undefined {
  if (!imageData) return undefined;
  const image = G.newImage(imageData);
  if (image.setFilter) image.setFilter("nearest", "nearest");
  if (wrap && image.setWrap) { try { image.setWrap("repeat", "repeat"); } catch { /* pcall */ } }
  return image;
}

// Lua: battle_transition_chrome.lua:100
function rgba_to_image(rgba: string | undefined, w: number, h: number, keyed?: boolean, wrap?: boolean): Image | undefined {
  return data_to_image(rgba_to_data(rgba, w, h, keyed), wrap);
}

// Lua: battle_transition_chrome.lua:104
BattleTransitionChrome.install = function (cache?: any): void {
  BattleTransitionChrome._cache = resolve_cache(cache);
  BattleTransitionChrome._manifest = undefined;
  BattleTransitionChrome._bigPokeball = undefined;
  BattleTransitionChrome._slidingPokeball = undefined;
  BattleTransitionChrome._gridSquare = undefined;
  BattleTransitionChrome._gridQuads = {};
  BattleTransitionChrome._gridFrames = [];
  BattleTransitionChrome._vsbars = {};
  BattleTransitionChrome._banners = {};
  BattleTransitionChrome._logged = false;
  BattleTransitionChrome._rseManifest = undefined;

  const root = transition_root();
  BattleTransitionChrome._manifest = load_lua(root + "/manifest.lua");

  const bp = read_bytes(root + "/big_pokeball.rgba");
  const sp = read_bytes(root + "/sliding_pokeball.rgba");
  const gs = read_bytes(root + "/grid_square.rgba");

  BattleTransitionChrome._bigPokeball = rgba_to_image(bp, 240, 160, true);
  BattleTransitionChrome._slidingPokeball = rgba_to_image(sp, 32, 32);
  const gridData = rgba_to_data(gs, 8, 120, true);
  BattleTransitionChrome._gridSquare = data_to_image(gridData);
  if (gridData) {
    for (let frame = 0; frame <= 14; frame++) {
      const fd = newImageData(8, 8);
      fd.paste(gridData, 0, 0, 0, frame * 8, 8, 8);
      BattleTransitionChrome._gridFrames[frame] = data_to_image(fd, true);
    }
  }

  if (BattleTransitionChrome._gridSquare) {
    for (let frame = 0; frame <= 14; frame++) {
      BattleTransitionChrome._gridQuads[frame + 1] = G.newQuad(
        0, frame * 8, 8, 8, 8, 120,
      );
    }
  }

  const manifest = BattleTransitionChrome._manifest ?? {};
  BattleTransitionChrome._assets = {};
  BattleTransitionChrome._assetImages = {};
  for (const [, key] of ipairs<string>(manifest.mugshots ?? MUGSHOT_KEYS)) {
    for (const [, gender] of ipairs<string>(manifest.genders ?? GENDER_KEYS)) {
      const vsKey = key + "_" + gender;
      const vsRgba = read_bytes(root + "/vsbar_" + vsKey + ".rgba");
      if (truthy(vsRgba)) {
        BattleTransitionChrome._vsbars[vsKey] = rgba_to_image(vsRgba, 256, 160, true, true);
      }
    }
    const bRgba = read_bytes(root + "/banner_" + key + ".rgba");
    if (truthy(bRgba)) {
      BattleTransitionChrome._banners[key] = rgba_to_image(bRgba, 120, 8);
    }
  }

  if (!BattleTransitionChrome._bigPokeball) {
    log("transition chrome missing \xE2\x80\x94 re-run --pokemon extract");
  }
};

// Lua: battle_transition_chrome.lua:166
BattleTransitionChrome.manifest = function (): LuaTable {
  BattleTransitionChrome.ensureInstalled();
  return BattleTransitionChrome._manifest ?? {};
};

// Lua: battle_transition_chrome.lua:171
BattleTransitionChrome.assetInfo = function (key: any): any {
  const info = (BattleTransitionChrome.manifest().assets ?? {})[key];
  if (!truthy(info)) throw new Error("battle transition chrome: no asset '" + tostring(key) + "' in the manifest");
  return info;
};

// Lua: battle_transition_chrome.lua:177
function asset_data(key: string): any {
  BattleTransitionChrome.ensureInstalled();
  let hit = BattleTransitionChrome._assets![key];
  if (truthy(hit)) return hit;
  const info = BattleTransitionChrome.assetInfo(key);
  const root = transition_root();
  hit = {
    info,
    idx: read_bytes(root + "/" + info.idx),
    pal: read_bytes(root + "/" + info.pal),
    pal2: truthy(info.pal2) ? read_bytes(root + "/" + info.pal2) : undefined,
  };
  if (!(truthy(hit.idx) && truthy(hit.pal))) throw new Error("battle transition chrome: asset '" + key + "' missing from the cache");
  BattleTransitionChrome._assets![key] = hit;
  return hit;
}

// Lua: battle_transition_chrome.lua:194
BattleTransitionChrome.assetPalette = function (key: string, which?: number, bank?: any): string | undefined {
  const a = asset_data(key);
  const bytes: string | undefined = (which === 2) ? a.pal2 : a.pal;
  if (!truthy(bytes)) throw new Error("battle transition chrome: asset '" + key + "' has no palette " + tostring(which));
  bank = tonumber(bank) ?? 0;
  const banks = Math.floor(bytes!.length / 32);
  if (bank < 0 || bank >= banks) return undefined;
  return sub(bytes!, bank * 32 + 1, bank * 32 + 32);
};

// Lua: battle_transition_chrome.lua:204
BattleTransitionChrome.assetBanks = function (key: string, which?: number): number {
  const a = asset_data(key);
  const bytes: string | undefined = (which === 2) ? a.pal2 : a.pal;
  return truthy(bytes) ? Math.floor(bytes!.length / 32) : 0;
};

// Lua: battle_transition_chrome.lua:210
function bgr555(bytes: string, i: number): [number, number, number] {
  const lo = byte(bytes, i * 2 + 1), hi = byte(bytes, i * 2 + 2);
  const v = (lo ?? 0) + (hi ?? 0) * 256;
  const c5 = (x: number): number => Math.floor(x * 255 / 31 + 0.5);
  return [c5(v % 32), c5(Math.floor(v / 32) % 32), c5(Math.floor(v / 1024) % 32)];
}

// Lua: battle_transition_chrome.lua:217
BattleTransitionChrome.assetImage = function (key: string, palBytes?: string): Image | undefined {
  const a = asset_data(key);
  palBytes = palBytes ?? BattleTransitionChrome.assetPalette(key, 1, a.info.previewBank ?? 0);
  const cacheKey = key + ":" + palBytes;
  let img = BattleTransitionChrome._assetImages![cacheKey];
  if (img != null) return img || undefined;
  const w = a.info.w, h = a.info.h;
  const lut: [number, number, number][] = [];
  for (let i = 0; i <= 15; i++) lut[i] = bgr555(palBytes!, i);
  const data = newImageData(w, h);
  const idx: string = a.idx;
  data.mapPixel((x, y) => {
    const c = (byte(idx, y * w + x + 1) ?? 0) % 16;
    if (c === 0) return [0, 0, 0, 0];
    const rgb = lut[c];
    return [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, 1];
  });
  img = G.newImage(data);
  img.setFilter("nearest", "nearest");
  try { img.setWrap("repeat", "repeat"); } catch { /* pcall */ }
  BattleTransitionChrome._assetImages![cacheKey] = img;
  return img;
};

BattleTransitionChrome.RSE_SUB = "battle_transition_rse";

// Lua: battle_transition_chrome.lua:244
BattleTransitionChrome.rseManifest = function (): LuaTable {
  BattleTransitionChrome.ensureInstalled();
  let m = BattleTransitionChrome._rseManifest;
  if (truthy(m)) return m;
  const rel = cache_root() + "/" + BattleTransitionChrome.RSE_SUB + "/manifest.lua";
  m = load_lua(rel);
  if (!truthy(m)) throw new Error("battle transition chrome: " + rel + " missing from the cache");
  BattleTransitionChrome._rseManifest = m;
  return m;
};

// Lua: battle_transition_chrome.lua:255
BattleTransitionChrome.indexedImage = function (cacheKey: string, idx: LuaTable, w: number, h: number, palBytes: string): Image | undefined {
  BattleTransitionChrome.ensureInstalled();
  const key = cacheKey + ":" + palBytes;
  let img = BattleTransitionChrome._assetImages![key];
  if (img != null) return img || undefined;
  const lut: [number, number, number][] = [];
  for (let i = 0; i <= 15; i++) lut[i] = bgr555(palBytes, i);
  const data = newImageData(w, h);
  data.mapPixel((x, y) => {
    const c = (idx[y * w + x + 1] ?? 0) % 16;
    if (c === 0) return [0, 0, 0, 0];
    const rgb = lut[c];
    return [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, 1];
  });
  img = G.newImage(data);
  img.setFilter("nearest", "nearest");
  BattleTransitionChrome._assetImages![key] = img;
  return img;
};

// Lua: battle_transition_chrome.lua:276
BattleTransitionChrome.ensureInstalled = function (): void {
  if (!truthy(BattleTransitionChrome._cache)) {
    BattleTransitionChrome.install();
  }
};

// Lua: battle_transition_chrome.lua:282
BattleTransitionChrome.ready = function (): boolean {
  BattleTransitionChrome.ensureInstalled();
  return BattleTransitionChrome._bigPokeball != null;
};

// Lua: battle_transition_chrome.lua:287
BattleTransitionChrome.bigPokeball = function (): Image | undefined {
  BattleTransitionChrome.ensureInstalled();
  return BattleTransitionChrome._bigPokeball;
};

// Lua: battle_transition_chrome.lua:292
BattleTransitionChrome.slidingPokeball = function (): Image | undefined {
  BattleTransitionChrome.ensureInstalled();
  return BattleTransitionChrome._slidingPokeball;
};

// Lua: battle_transition_chrome.lua:297
BattleTransitionChrome.gridSquare = function (): [Image | undefined, Record<number, Quad>] {
  BattleTransitionChrome.ensureInstalled();
  return [BattleTransitionChrome._gridSquare, BattleTransitionChrome._gridQuads];
};

// Lua: battle_transition_chrome.lua:302
BattleTransitionChrome.gridFrame = function (stage: number): Image | undefined {
  BattleTransitionChrome.ensureInstalled();
  return BattleTransitionChrome._gridFrames[stage];
};

// Lua: battle_transition_chrome.lua:307
BattleTransitionChrome.vsbar = function (mugshotKey?: any, genderKey?: any): Image | undefined {
  BattleTransitionChrome.ensureInstalled();
  genderKey = (genderKey === "female" || genderKey === 1) ? "female" : "male";
  const key = tostring(truthy(mugshotKey) ? mugshotKey : "lorelei").toLowerCase() + "_" + genderKey;
  return BattleTransitionChrome._vsbars[key];
};

// Lua: battle_transition_chrome.lua:314
BattleTransitionChrome.banner = function (mugshotKey?: any): Image | undefined {
  BattleTransitionChrome.ensureInstalled();
  const key = tostring(truthy(mugshotKey) ? mugshotKey : "lorelei").toLowerCase();
  return BattleTransitionChrome._banners[key];
};

G3Lazy["src.ui.game3.battle_transition_chrome"] = BattleTransitionChrome;

export default BattleTransitionChrome;
