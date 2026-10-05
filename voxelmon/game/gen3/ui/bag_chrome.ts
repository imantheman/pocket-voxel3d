// Port of gen1recomp src/ui/game3/bag_chrome.lua (GPLv3 + additional terms; see LICENSE.md).
// Bag menu chrome + item icons from firered CacheFS (items/bag/).

import { byte, format, tonumber, tostring, truthy } from "../../../import/gen3/lua.ts";
import { G } from "../platform/graphics.ts";
import { newImageData, type Image, type ImageData, type Quad } from "../platform/image.ts";
import { Fs } from "../platform/fs.ts";
import { luaLoad } from "../platform/luadata.ts";
import { gsub } from "../platform/lpattern.ts";
import type { LuaTable } from "../platform/lt.ts";
import { NotPortedError } from "../notported.ts";
import Extract from "../../../import/gen3/extract_island1.ts";
import BagChromeExtract from "../../../import/gen3/bag_chrome_extract.ts";
import { Dataset } from "../core/dataset.ts";
import { CacheFs } from "../shared/import/CacheFs.ts";
import { ItemsData } from "../core/items_data.ts";

export interface BagDrawOpts { female?: boolean; pocketIdx?: unknown; frame?: number | null; rotation?: unknown }

/**
 * `pcall(require, "src.import.CacheFs")` and a call into it: a stub there is
 * a failed require (nil), as in ui/chrome.ts's viaCacheFs.
 */
function tryStub<T>(f: () => T): T | undefined {
  try {
    return f();
  } catch (e) {
    if (e instanceof NotPortedError) return undefined;
    throw e;
  }
}

// Lua: bag_chrome.lua:20
function cache_root(): string {
  return Extract.CACHE_ROOT || "data/generated/gba";
}

// Lua: bag_chrome.lua:24
function bag_root(): string {
  return cache_root() + "/" + BagChromeExtract.CACHE_SUB;
}

// Lua: bag_chrome.lua:28
function log(msg: unknown): void {
  if (BagChrome._logged) return;
  BagChrome._logged = true;
  console.log("[game3/bag_chrome] " + tostring(msg));
}

// Lua: bag_chrome.lua:34
function read_bytes(rel: string): string | undefined {
  const cache = BagChrome._cache;
  if (truthy(cache) && truthy(cache.read)) {
    const d = cache.read(rel);
    if (typeof d === "string" && d.length > 0) return d;
  }
  if (truthy(Dataset) && truthy(Dataset.cache)) {
    const d = Dataset.cache().read(rel);
    if (typeof d === "string" && d.length > 0) return d;
  }
  if (truthy(CacheFs) && truthy(CacheFs.readActive)) {
    const d = tryStub(() => CacheFs.readActive(rel));
    if (typeof d === "string" && d.length > 0) return d;
  }
  {
    let d = Fs.read(rel);
    if (typeof d === "string" && d.length > 0) return d;
    const alt = "data/generated/gba/" + gsub(rel, "^data/generated/gba/", "")[0];
    d = Fs.read(alt);
    if (typeof d === "string" && d.length > 0) return d;
  }
  // NOT FAITHFUL: the io.open candidates (rel, data/generated/gba/<rel>) are
  // the two paths love.filesystem just tried; there is no io on the 3DS.
  return undefined;
}

// Lua: bag_chrome.lua:72
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

// Lua: bag_chrome.lua:82
function rgba_to_imagedata(rgba: string | undefined, w: number, h: number): ImageData | undefined {
  if (!truthy(rgba) || rgba!.length < w * h * 4) return undefined;
  try {
    const imageData = newImageData(w, h, "rgba8", rgba);
    if (imageData) return imageData;
  } catch { /* pcall */ }
  return undefined;
}

// Lua: bag_chrome.lua:90
function rgba_to_image(rgba: string | undefined, w: number, h: number): Image | undefined {
  if (!truthy(rgba) || rgba!.length < w * h * 4) return undefined;
  let imageData: ImageData | undefined;
  try { imageData = newImageData(w, h, "rgba8", rgba); } catch { imageData = undefined; }
  if (!imageData) {
    imageData = newImageData(w, h);
    let i = 1;
    for (let y = 0; y <= h - 1; y++) {
      for (let x = 0; x <= w - 1; x++) {
        imageData.setPixel(x, y,
          (byte(rgba!, i) ?? 0) / 255,
          (byte(rgba!, i + 1) ?? 0) / 255,
          (byte(rgba!, i + 2) ?? 0) / 255,
          (byte(rgba!, i + 3) ?? 0) / 255);
        i = i + 4;
      }
    }
  }
  const image = G.newImage(imageData);
  if (image.setFilter) image.setFilter("nearest", "nearest");
  return image;
}

// Lua: bag_chrome.lua:142
function ensure_bg(): Image | undefined {
  if (BagChrome._bg) return BagChrome._bg;
  const man = BagChrome._manifest || load_lua(bag_root() + "/manifest.lua");
  BagChrome._manifest = man;
  const w = (man && man.width) || 240;
  const h = (man && man.height) || 160;
  const rgba = read_bytes(bag_root() + "/bg.rgba");
  BagChrome._bg = rgba_to_image(rgba, w, h);
  if (BagChrome._bg) log("bg ready");
  return BagChrome._bg;
}

// Lua: bag_chrome.lua:154
function ensure_bag_sheet(female: boolean): Image | undefined {
  if (female) {
    if (BagChrome._bagFemale) return BagChrome._bagFemale;
  } else {
    if (BagChrome._bagMale) return BagChrome._bagMale;
  }
  const man = BagChrome._manifest || load_lua(bag_root() + "/manifest.lua");
  BagChrome._manifest = man;
  const w = (man && man.bagW) || 64;
  const h = (man && man.bagH) || 256;
  const rel = bag_root() + (female ? "/bag_female.rgba" : "/bag_male.rgba");
  const img = rgba_to_image(read_bytes(rel), w, h);
  if (female) BagChrome._bagFemale = img; else BagChrome._bagMale = img;
  return img;
}

// Lua: bag_chrome.lua:170
function bag_quad(frameIn: unknown): Quad | undefined {
  const frame = Math.max(0, Math.min(3, tonumber(frameIn) ?? 0));
  let q = BagChrome._bagQuads[frame];
  if (q) return q;
  const img = BagChrome._bagMale || BagChrome._bagFemale;
  if (!img) return undefined;
  const [iw, ih] = img.getDimensions();
  q = G.newQuad(0, frame * 64, 64, 64, iw, ih);
  BagChrome._bagQuads[frame] = q;
  return q;
}

// src/item_menu_icons.c:52
const POCKET_FRAME: Record<number, number> = { 1: 2, 2: 3, 3: 1 };

// Lua: bag_chrome.lua:189
function named_image(name: string, w: number, h: number): Image | undefined {
  let img: Image | false | undefined = BagChrome._images[name];
  if (img != null) return img || undefined;
  img = rgba_to_image(read_bytes(bag_root() + "/" + name + ".rgba"), w, h);
  BagChrome._images[name] = img || false;
  return img;
}

const BIOS_SIN: Record<number, number> = {};
for (let i = 0; i <= 255; i++) {
  BIOS_SIN[i] = Math.floor(Math.sin(i * 2 * Math.PI / 256) * 16384 + 0.5);
}

// Lua: bag_chrome.lua:290
function bag_data(female: boolean): ImageData | undefined {
  const key = female ? "f" : "m";
  let d: ImageData | false | undefined = BagChrome._bagData[key];
  if (d != null) return d || undefined;
  const man = BagChrome._manifest || load_lua(bag_root() + "/manifest.lua");
  BagChrome._manifest = man;
  const w = (man && man.bagW) || 64;
  const h = (man && man.bagH) || 256;
  d = rgba_to_imagedata(read_bytes(bag_root() + (female ? "/bag_female.rgba" : "/bag_male.rgba")), w, h);
  BagChrome._bagData[key] = d || false;
  return d;
}

// src/sprite.c:1292
// Lua: bag_chrome.lua:304
function rotated_image(female: boolean, frame: number, rot: number): Image | undefined {
  const key = (female ? "f" : "m") + tostring(frame) + ":" + tostring(rot);
  let img: Image | false | undefined = BagChrome._rotated[key];
  if (img != null) return img || undefined;
  const src = bag_data(female);
  if (!src) {
    BagChrome._rotated[key] = false;
    return undefined;
  }
  const idx = ((rot % 256) + 256) % 256;
  const sn = BIOS_SIN[idx]!, cs = BIOS_SIN[(idx + 64) % 256]!;
  const pa = Math.floor(256 * cs / 16384);
  const pb = Math.floor(-(256 * sn) / 16384);
  const pc = Math.floor(256 * sn / 16384);
  const pd = Math.floor(256 * cs / 16384);
  const out = newImageData(64, 64);
  const base = frame * 64;
  for (let y = 0; y <= 63; y++) {
    const iy = y - 32;
    for (let x = 0; x <= 63; x++) {
      const ix = x - 32;
      const tx = Math.floor((pa * ix + pb * iy) / 256) + 32;
      const ty = Math.floor((pc * ix + pd * iy) / 256) + 32;
      if (tx >= 0 && tx < 64 && ty >= 0 && ty < 64) {
        const [r, g, b, a] = src.getPixel(tx, base + ty);
        out.setPixel(x, y, r, g, b, a);
      } else {
        out.setPixel(x, y, 0, 0, 0, 0);
      }
    }
  }
  img = G.newImage(out);
  img.setFilter("nearest", "nearest");
  BagChrome._rotated[key] = img;
  return img;
}

export const BagChrome = {
  _cache: undefined as any,
  _bg: undefined as Image | undefined,
  _bagMale: undefined as Image | undefined,
  _bagFemale: undefined as Image | undefined,
  _bagQuads: {} as Record<string | number, Quad>,
  _bagData: {} as Record<string, ImageData | false>,
  _rotated: {} as Record<string, Image | false>,
  _images: {} as Record<string, Image | false>,
  _icons: {} as Record<number, Image | false>, // id → Image
  _manifest: undefined as LuaTable | undefined,
  _ready: undefined as boolean | undefined,
  _logged: false,

  // Lua: bag_chrome.lua:113
  install(cache?: any): void {
    if (!truthy(cache) || !truthy(cache.read)) {
      if (truthy(Dataset) && truthy(Dataset.cache)) {
        cache = Dataset.cache();
      }
    }
    BagChrome._cache = cache;
    BagChrome._bg = undefined;
    BagChrome._bagMale = undefined;
    BagChrome._bagFemale = undefined;
    BagChrome._bagQuads = {};
    BagChrome._bagData = {};
    BagChrome._rotated = {};
    BagChrome._images = {};
    BagChrome._icons = {};
    BagChrome._manifest = undefined;
    BagChrome._ready = undefined;
    BagChrome._logged = false;
  },

  // Lua: bag_chrome.lua:134
  ready(): boolean {
    if (BagChrome._ready != null) return BagChrome._ready;
    const man = BagChrome._manifest || load_lua(bag_root() + "/manifest.lua");
    BagChrome._manifest = man;
    BagChrome._ready = man != null && read_bytes(bag_root() + "/bg.rgba") != null;
    return BagChrome._ready;
  },

  // Lua: bag_chrome.lua:185
  frameForPocket(pocketIdx: unknown): number {
    return POCKET_FRAME[tonumber(pocketIdx) ?? 1] ?? 2;
  },

  // Lua: bag_chrome.lua:197
  drawBg(x?: number, y?: number, opts?: { itemPc?: boolean; female?: boolean }): boolean {
    let img: Image | undefined;
    if (opts && opts.itemPc) {
      // src/item_menu.c:569
      img = named_image(opts.female ? "bg_itempc_female" : "bg_itempc", 240, 160);
      if (!img) throw new Error("BagChrome: bg_itempc.rgba is not in the cache");
    }
    img = img || ((opts && opts.female) ? named_image("bg_female", 240, 160) : undefined);
    img = img || ensure_bg();
    if (!img) return false;
    G.setColor(1, 1, 1, 1);
    G.draw(img, x ?? 0, y ?? 0);
    return true;
  },

  // src/item_menu.c:1163, 1332
  // Lua: bag_chrome.lua:213
  drawListFrame(rowsIn: unknown, female?: boolean): boolean {
    const suffix = female ? "_female" : "";
    const blank = named_image("list_blank" + suffix, 144, 96) || named_image("list_blank", 144, 96);
    const list = named_image("list" + suffix, 144, 96) || named_image("list", 144, 96);
    if (!(blank && list)) return false;
    const rows = Math.max(0, Math.min(12, tonumber(rowsIn) ?? 0));
    G.setColor(1, 1, 1, 1);
    G.draw(blank, 88, 8);
    if (rows > 0) {
      const key = "list_rows_" + tostring(rows);
      let q = BagChrome._bagQuads[key];
      if (!q) {
        q = G.newQuad(0, (12 - rows) * 8, 144, rows * 8, 144, 96);
        BagChrome._bagQuads[key] = q;
      }
      G.draw(list, q, 88, 8 + (12 - rows) * 8);
    }
    return true;
  },

  // src/item_menu.c:1118
  // Lua: bag_chrome.lua:234
  drawDescSelected(): boolean {
    const img = named_image("desc_sel", 240, 48);
    if (!img) return false;
    G.setColor(1, 1, 1, 1);
    G.draw(img, 0, 112);
    return true;
  },

  // src/item_menu_icons.c:249 CreateSwapLine, :282 UpdateSwapLinePos
  // Lua: bag_chrome.lua:243
  drawSwapLine(firstCenterX: number, centerY: number): boolean {
    const img = named_image("swap_line", 32, 16);
    if (!img) throw new Error("BagChrome: swap_line.rgba is not in the cache");
    let start = BagChrome._bagQuads.swap_start;
    if (!start) {
      start = G.newQuad(0, 0, 16, 16, 32, 16);
      BagChrome._bagQuads.swap_start = start;
      BagChrome._bagQuads.swap_mid = G.newQuad(16, 0, 16, 16, 32, 16);
    }
    const mid = BagChrome._bagQuads.swap_mid;
    G.setColor(1, 1, 1, 1);
    for (let i = 0; i <= 8; i++) {
      const x = firstCenterX + i * 16 - 8, y = centerY - 8;
      if (i === 0) {
        G.draw(img, start, x, y);
      } else if (i === 8) {
        G.draw(img, start, x + 16, y, 0, -1, 1);
      } else {
        G.draw(img, mid, x, y);
      }
    }
    return true;
  },

  // src/menu_indicators.c:259
  // Lua: bag_chrome.lua:268
  drawArrow(dir: string, x: number, y: number): boolean {
    const img = named_image("red_arrow", 16, 32);
    if (!img) return false;
    const key = "arrow_" + tostring(dir);
    let q = BagChrome._bagQuads[key];
    if (!q) {
      const top = (dir === "up" || dir === "down") ? 16 : 0;
      q = G.newQuad(0, top, 16, 16, 16, 32);
      BagChrome._bagQuads[key] = q;
    }
    const sx = (dir === "right") ? -1 : 1;
    const sy = (dir === "down") ? -1 : 1;
    G.setColor(1, 1, 1, 1);
    G.draw(img, q, x + (sx < 0 ? 16 : 0), y + (sy < 0 ? 16 : 0), 0, sx, sy);
    return true;
  },

  /** Draw bag sprite. pret field position ≈ (40, 68). */
  // Lua: bag_chrome.lua:341
  drawBag(px?: number, py?: number, opts?: BagDrawOpts): boolean {
    opts = opts || {};
    let female = opts.female === true;
    let img = ensure_bag_sheet(female);
    if (!img) {
      female = !female;
      img = ensure_bag_sheet(female);
    }
    if (!img) return false;
    let frame = opts.frame;
    if (frame == null) frame = BagChrome.frameForPocket(opts.pocketIdx);
    frame = Math.max(0, Math.min(3, Math.floor(frame)));
    const rot = Math.floor(tonumber(opts.rotation) ?? 0);
    G.setColor(1, 1, 1, 1);
    if (rot % 256 !== 0) {
      const r = rotated_image(female, frame, rot);
      if (r) {
        G.draw(r, px ?? 8, py ?? 36);
        return true;
      }
    }
    const q = bag_quad(frame);
    if (q) {
      G.draw(img, q, px ?? 8, py ?? 36);
    } else {
      G.draw(img, px ?? 8, py ?? 36);
    }
    return true;
  },

  // Lua: bag_chrome.lua:371
  iconImage(itemId: unknown): Image | undefined {
    const id = ItemsData.toNumericId(itemId) ?? tonumber(itemId);
    if (id == null) return undefined;
    if (BagChrome._icons[id] != null) {
      return BagChrome._icons[id] || undefined;
    }
    const rgba = read_bytes(format("%s/icons/%d.rgba", bag_root(), id));
    const img = rgba_to_image(rgba, 24, 24);
    BagChrome._icons[id] = img || false;
    return img;
  },

  /** Draw 24×24 item icon at pixel coords. */
  // Lua: bag_chrome.lua:385
  drawItemIcon(itemId: unknown, px?: number, py?: number, scale?: number): boolean {
    const img = BagChrome.iconImage(itemId);
    if (!img) return false;
    scale = scale ?? 1;
    G.setColor(1, 1, 1, 1);
    G.draw(img, px ?? 0, py ?? 0, 0, scale, scale);
    return true;
  },
};

export default BagChrome;
