// Port of gen1recomp src/ui/game3/naming_chrome.lua (GPLv3 + additional terms; see LICENSE.md).
// Load ROM-extracted naming-screen chrome (data/generated/gba/naming/).

import { tonumber } from "../../../import/gen3/lua.ts";
import { G } from "../platform/graphics.ts";
import { Fs } from "../platform/fs.ts";
import { type Image, type Quad } from "../platform/image.ts";
import { ipairs, seq } from "../platform/lt.ts";

type Img = Image;

const ROOTS = seq(
  "data/generated/gba/naming",
);

// Lua: naming_chrome.lua:12
function tryLoad(path: string): Img | null {
  // love and love.filesystem always exist here
  if (!Fs.getInfo(path)) {
    return null;
  }
  let ok: boolean, img: Img | undefined;
  try { img = G.newImage(path); ok = true; } catch { ok = false; }
  if (ok && img) {
    if (img.setFilter) img.setFilter("nearest", "nearest");
    return img;
  }
  return null;
}

// Lua: naming_chrome.lua:24
function loadManifest(root: string): any {
  const path = root + "/manifest.lua";
  // love.filesystem.load always exists here
  let ok: boolean, chunk: unknown;
  try { chunk = Fs.load(path)[0]; ok = true; } catch { ok = false; }
  if (!ok || typeof chunk !== "function") return null;
  let ok2: boolean, t: unknown;
  try { t = (chunk as () => unknown)(); ok2 = true; } catch { ok2 = false; }
  if (ok2 && typeof t === "object" && t !== null) return t;
  return null;
}

export const NamingChrome = {
  _ready: false,
  _images: {} as Record<string, Img | null | undefined>,

  KEYS: seq(
    "bg", "kb_upper", "kb_lower", "kb_symbols",
    "back_button", "ok_button", "page_swap_frame", "page_swap_button",
    "page_swap_button_upper", "page_swap_button_lower", "page_swap_button_others",
    "page_swap_upper", "page_swap_lower", "page_swap_others",
    "page_swap_button_glow", "back_button_glow", "ok_button_glow",
    "cursor", "input_arrow", "underscore", "rival",
  ),

  // Lua: naming_chrome.lua:43
  install(_cache?: unknown): boolean {
    NamingChrome._images = {};
    NamingChrome._ready = false;
    for (const [, root] of ipairs<string>(ROOTS)) {
      const man = loadManifest(root);
      if (man) {
        for (const [, k] of ipairs<string>(NamingChrome.KEYS)) {
          const p = man[k] ?? (root + "/" + k + ".png");
          NamingChrome._images[k] = tryLoad(p);
        }
        NamingChrome._ready = NamingChrome._images.bg != null;
        return NamingChrome._ready;
      }
      // Flat files without manifest
      NamingChrome._images.bg = tryLoad(root + "/bg.png");
      if (NamingChrome._images.bg) {
        NamingChrome._images.kb_upper = tryLoad(root + "/kb_upper.png");
        NamingChrome._images.kb_lower = tryLoad(root + "/kb_lower.png");
        NamingChrome._images.kb_symbols = tryLoad(root + "/kb_symbols.png");
        NamingChrome._images.back_button = tryLoad(root + "/back_button.png");
        NamingChrome._images.ok_button = tryLoad(root + "/ok_button.png");
        NamingChrome._images.page_swap_frame = tryLoad(root + "/page_swap_frame.png");
        NamingChrome._images.page_swap_button = tryLoad(root + "/page_swap_button.png");
        NamingChrome._images.page_swap_button_upper = tryLoad(root + "/page_swap_button_upper.png");
        NamingChrome._images.page_swap_button_lower = tryLoad(root + "/page_swap_button_lower.png");
        NamingChrome._images.page_swap_button_others = tryLoad(root + "/page_swap_button_others.png");
        NamingChrome._images.page_swap_upper = tryLoad(root + "/page_swap_upper.png");
        NamingChrome._images.page_swap_lower = tryLoad(root + "/page_swap_lower.png");
        NamingChrome._images.page_swap_others = tryLoad(root + "/page_swap_others.png");
        NamingChrome._images.page_swap_button_glow = tryLoad(root + "/page_swap_button_glow.png");
        NamingChrome._images.back_button_glow = tryLoad(root + "/back_button_glow.png");
        NamingChrome._images.ok_button_glow = tryLoad(root + "/ok_button_glow.png");
        NamingChrome._images.cursor = tryLoad(root + "/cursor.png");
        NamingChrome._images.input_arrow = tryLoad(root + "/input_arrow.png");
        NamingChrome._images.underscore = tryLoad(root + "/underscore.png");
        NamingChrome._images.rival = tryLoad(root + "/rival.png");
        NamingChrome._ready = true;
        return true;
      }
    }
    return false;
  },

  // Lua: naming_chrome.lua:86
  ready(): boolean {
    if (NamingChrome._ready) return true;
    return NamingChrome.install();
  },

  // Lua: naming_chrome.lua:91
  get(key: string): Img | null | undefined {
    NamingChrome.ready();
    return NamingChrome._images[key];
  },

  // Lua: naming_chrome.lua:96
  cursorQuad(frame?: unknown): [Img | null, Quad | null] {
    const img = NamingChrome.get("cursor");
    if (!img || !G.newQuad) return [null, null];
    const f = Math.max(0, Math.min(2, tonumber(frame) ?? 0));
    const qw = 16, qh = 16;
    const q = G.newQuad(f * qw, 0, qw, qh, ...img.getDimensions());
    return [img, q];
  },

  // Keyboard chrome: full frame + SELECT tab (extract v3).
  // WIN_KB text still originates at (24,80); older caches may be 152×64 inner-only.
  KB_X: 16,
  KB_Y: 72,
  KB_W: 176,
  KB_H: 80,
  KB_INNER_X: 24,
  KB_INNER_Y: 80,
  KB_INNER_W: 152,
  KB_INNER_H: 64,

  // Lua: naming_chrome.lua:116
  kbQuad(pageKey: string): [Img | null, Quad | null, string?] {
    const img = NamingChrome.get(pageKey);
    if (!img || !G.newQuad) return [null, null];
    const [iw, ih] = img.getDimensions();
    // v3: pre-cropped frame including border/tab
    if (iw <= NamingChrome.KB_W + 8 && ih <= NamingChrome.KB_H + 8 && iw >= 160) {
      return [img, null];
    }
    // v2: inner-only crop drawn at WIN_KB
    if (iw <= NamingChrome.KB_INNER_W + 8 && ih <= NamingChrome.KB_INNER_H + 8) {
      return [img, null, "inner"];
    }
    // Full 256×160 map: crop frame region
    const w = Math.min(NamingChrome.KB_W, iw - NamingChrome.KB_X);
    const h = Math.min(NamingChrome.KB_H, ih - NamingChrome.KB_Y);
    if (w < 1 || h < 1) return [img, null];
    const q = G.newQuad(NamingChrome.KB_X, NamingChrome.KB_Y, w, h, iw, ih);
    return [img, q];
  },
};

export default NamingChrome;
