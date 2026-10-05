// Port of gen1recomp src/ui/game3/chrome.lua (GPLv3 + additional terms; see LICENSE.md).
// FRLG field UI chrome (pret graphics/text_window).
// Dialogue uses menu_message tiles (WindowFunc_DrawDialogueFrame).
// Menus use std 9-slice (WindowFunc_DrawStdFrameWithCustomTileAndPalette).
// Assets: sevii/gba/chrome/*_rgba.png (pret PNGs + stdpal_* baked).

import { format, mod, tonumber, tostring, truthy } from "../../../import/gen3/lua.ts";
import { G } from "../platform/graphics.ts";
import { newImageData, type Image, type ImageData, type Quad } from "../platform/image.ts";
import { Fs } from "../platform/fs.ts";
import { len, seq, type LuaTable } from "../platform/lt.ts";
import { NotPortedError } from "../notported.ts";
// Display.TILE comes from the leaf data table, so reading it at load is safe
// in the import cycle; display.ts is still loaded here.
import { Display } from "../core/display_table.ts";
import "../core/display.ts";
import { CacheFs } from "../shared/import/CacheFs.ts";
import { Profile } from "../core/profile.ts";
import { Runtime } from "../core/runtime.ts";
import { GameVersion } from "../../../import/gen3/game_version.ts";
import { FrlgFont, type Col } from "./frlg_font.ts";

export interface TileAtlas { image: Image; quads: Record<number, Quad>; path: string | undefined; layout?: string }
interface ArrowAtlas { image: Image; quads: Record<number, Quad>; frameW: number; frameH: number; count: number; path: string | undefined }
interface PathItem { path: string; w: number; h: number }

/**
 * Lua's `pcall(require, "src.import.CacheFs")` followed by a call into it:
 * while CacheFs is still a stub it stands for a failed require (the call
 * yields nil and Brian's love.filesystem fallback runs). Other errors raise.
 */
function viaCacheFs<T>(f: () => T): T | undefined {
  try {
    return f();
  } catch (e) {
    if (e instanceof NotPortedError) return undefined;
    throw e;
  }
}

const T: number = Display.TILE; // 8

const PATHS: Record<string, PathItem[]> = {
  dlg: [
    { path: "chrome/menu_message_rgba.rgba", w: 48, h: 24 },
    { path: "data/generated/gba/chrome/menu_message_rgba.rgba", w: 48, h: 24 },
  ],
  std: [
    { path: "chrome/std_rgba.rgba", w: 24, h: 24 },
    { path: "data/generated/gba/chrome/std_rgba.rgba", w: 24, h: 24 },
  ],
  sign: [
    { path: "chrome/signpost_rgba.rgba", w: 40, h: 32 },
    { path: "data/generated/gba/chrome/signpost_rgba.rgba", w: 40, h: 32 },
  ],
  textCursor: [
    { path: "chrome/fonts/text_cursor.rgba", w: 16, h: 16 },
    { path: "data/generated/gba/chrome/fonts/text_cursor.rgba", w: 16, h: 16 },
  ],
  arrow: [
    { path: "chrome/fonts/down_arrows_fg.rgba", w: 128, h: 16 },
    { path: "data/generated/gba/chrome/fonts/down_arrows_fg.rgba", w: 128, h: 16 },
  ],
};

// Lua: chrome.lua:47
function log(msg: unknown): void {
  // print -> Logger once shared/core/Logger is ported
  console.log("[game3/chrome] " + tostring(msg));
}

// Lua: chrome.lua:51
function loadImage(candidates: (PathItem | string)[]): [Image | undefined, string | undefined] {
  for (const item of candidates) {
    const path = typeof item === "object" ? item.path : item;
    const w = typeof item === "object" ? item.w : 48;
    const h = typeof item === "object" ? item.h : 24;
    const data = viaCacheFs(() => CacheFs.read(path) as string | undefined);
    if (data !== undefined && typeof data === "string" && data.length > 0) {
      if (data.length === w * h * 4) {
        let id: ImageData | undefined;
        try { id = newImageData(w, h, "rgba8", data); } catch { id = undefined; }
        if (id) {
          const img = G.newImage(id);
          if (img && img.setFilter) img.setFilter("nearest", "nearest");
          return [img, path];
        }
      } else {
        let fd;
        try { fd = Fs.newFileData(data, path); } catch { fd = undefined; }
        if (fd) {
          let id: ImageData | undefined;
          try { id = newImageData(fd); } catch { id = undefined; }
          if (id) {
            const img = G.newImage(id);
            if (img && img.setFilter) img.setFilter("nearest", "nearest");
            return [img, path];
          }
        }
      }
    }
    if (Fs.getInfo(path)) {
      let img: Image | undefined;
      try { img = G.newImage(path); } catch { img = undefined; }
      if (img) {
        if (img.setFilter) img.setFilter("nearest", "nearest");
        return [img, path];
      }
    }
  }
  return [undefined, undefined];
}

// Lua: chrome.lua:93
function resolveFrames(): [LuaTable | undefined, string | undefined] {
  let row: unknown;
  let ok: boolean;
  try { row = Profile.forSession(); ok = true; } catch { ok = false; }
  const ui = ok && row !== null && typeof row === "object" ? (row as LuaTable).ui : undefined;
  if (ui !== null && typeof ui === "object" && ui.frames !== null && typeof ui.frames === "object") {
    return [ui.frames, (row as LuaTable).id];
  }
  return [undefined, undefined];
}

// Lua: chrome.lua:106
function frames(): LuaTable | undefined {
  // package.loaded["src.core.game3.runtime"] / ["src.core.GameVersion"]
  const session = Runtime ? Runtime.session : undefined;
  const GV = GameVersion;
  const v = (session !== null && typeof session === "object" && truthy(session.version) ? session.version : undefined)
    ?? (GV && truthy(GV.current) ? GV.current : undefined) ?? "";
  if (v === Chrome._syncVersion) return Chrome._frames;
  Chrome._syncVersion = v;
  const [spec, id] = resolveFrames();
  const key = spec ? id : "frlg";
  if (Chrome._specKey !== key) {
    if (Chrome._specKey !== undefined) Chrome.invalidate();
    Chrome._specKey = key;
  }
  Chrome._frames = spec;
  return spec;
}

// Lua: chrome.lua:126
function manifest(spec: LuaTable): LuaTable | undefined {
  if (Chrome._manifest === undefined) {
    const t = spec.manifest ? viaCacheFs(() => CacheFs.loadActive(spec.manifest)) : undefined;
    Chrome._manifest = t !== null && typeof t === "object" ? t : false;
  }
  return Chrome._manifest || undefined;
}

// Lua: chrome.lua:166
function makeQuads(img: Image, cols: number, rows: number): Record<number, Quad> {
  const quads: Record<number, Quad> = {};
  const [iw, ih] = img.getDimensions();
  let i = 0;
  for (let ty = 0; ty <= rows - 1; ty++) {
    for (let tx = 0; tx <= cols - 1; tx++) {
      quads[i] = G.newQuad(tx * 8, ty * 8, 8, 8, iw, ih);
      i = i + 1;
    }
  }
  return quads;
}

// Lua: chrome.lua:179
function ensureDlg(): TileAtlas | undefined {
  if (Chrome._dlg) return Chrome._dlg;
  const spec = frames();
  const d = spec ? spec.dialogue : undefined;
  if (truthy(d)) {
    const m = manifest(spec);
    const info = m && m.frames ? m.frames[d.manifestKey] : undefined;
    if (info === null || typeof info !== "object") {
      throw new Error("Chrome: chrome/manifest.lua has no frames." + tostring(d.manifestKey));
    }
    const [img, path] = loadImage([{ path: d.path, w: info.width, h: info.height }]);
    if (!img) throw new Error("Chrome: " + tostring(d.path) + " is not in the cache");
    Chrome._dlg = { image: img, quads: makeQuads(img, info.tilesW, info.tilesH), path, layout: d.layout };
    return Chrome._dlg;
  }
  const [img, path] = loadImage(PATHS.dlg!);
  if (!img) {
    if (!Chrome._logged) {
      log("menu_message atlas missing — dialogue frame fallback");
      Chrome._logged = true;
    }
    return undefined;
  }
  Chrome._dlg = { image: img, quads: makeQuads(img, 6, 3), path };
  log("dialogue chrome ready " + tostring(path));
  return Chrome._dlg;
}

// Lua: chrome.lua:207
function ensureStd(): TileAtlas | undefined {
  if (Chrome._std) return Chrome._std;
  const [img, path] = loadImage(PATHS.std!);
  if (!img) return undefined;
  Chrome._std = { image: img, quads: makeQuads(img, 3, 3), path };
  return Chrome._std;
}

// Lua: chrome.lua:215
function blitTile(atlas: TileAtlas, tile: number, px: number, py: number, vflip?: boolean): void {
  const q = atlas.quads[tile];
  if (!q) return;
  if (vflip) {
    G.draw(atlas.image, q, px, py + 8, 0, 1, -1);
  } else {
    G.draw(atlas.image, q, px, py);
  }
}

// Lua: chrome.lua:225
function fillRect(px: number, py: number, pw: number, ph: number, r: number, g: number, b: number, a?: number): void {
  G.setColor(r, g, b, a ?? 1);
  G.rectangle("fill", px, py, pw, ph);
  G.setColor(1, 1, 1, 1);
}

/**
 * pret WindowFunc_DrawDialogueFrame for the standard field textbox.
 * Content window: (2,15) 26×4. Outer chrome occupies rows 14–19, cols 0–29.
 * pokeemerald/src/menu.c:319
 */
// Lua: chrome.lua:234
function drawMessageBox(atlas: TileAtlas, L: number, Top: number, W: number, H: number): void {
  G.setColor(1, 1, 1, 1);
  const cell = (tile: number, tx: number, ty: number, vflip?: boolean): void => {
    blitTile(atlas, tile, tx * T, ty * T, vflip);
  };
  const fill = (tile: number, tx: number, ty: number, w: number, h: number, vflip?: boolean): void => {
    for (let y = ty; y <= ty + h - 1; y++) {
      for (let x = tx; x <= tx + w - 1; x++) cell(tile, x, y, vflip);
    }
  };
  fill(1, L - 2, Top - 1, 1, 1);
  fill(3, L - 1, Top - 1, 1, 1);
  fill(4, L, Top - 1, W - 1, 1);
  fill(5, L + W - 1, Top - 1, 1, 1);
  fill(6, L + W, Top - 1, 1, 1);
  fill(7, L - 2, Top, 1, H);
  fill(9, L - 1, Top, 1, H);
  fill(10, L + W, Top, 1, H);
  fill(1, L - 2, Top + H, 1, 1, true);
  fill(3, L - 1, Top + H, 1, 1, true);
  fill(4, L, Top + H, W - 1, 1, true);
  fill(5, L + W - 1, Top + H, 1, 1, true);
  fill(6, L + W, Top + H, 1, 1, true);
  const c = Chrome.windowFillColor();
  fillRect(L * T, Top * T, W * T, H * T, c[1]!, c[2]!, c[3]!, 1);
}

// Lua: chrome.lua:313
function ensureSign(): TileAtlas | undefined {
  if (Chrome._sign) return Chrome._sign;
  const [img, path] = loadImage(PATHS.sign!);
  if (!img) return undefined;
  // signpost atlas is 6×3 like menu_message (pret text_window/signpost.png).
  Chrome._sign = { image: img, quads: makeQuads(img, 6, 3), path };
  return Chrome._sign;
}

// Lua: chrome.lua:322
function ensureArrow(): ArrowAtlas | undefined {
  if (Chrome._arrow) return Chrome._arrow;
  const [img, path] = loadImage(PATHS.arrow!);
  if (!img) return undefined;
  const [iw, ih] = img.getDimensions();
  // pret down_arrows: 8 frames in a row (typically 8×8 each).
  const count = 8;
  let fw = Math.floor(iw / count);
  if (fw < 1) fw = iw;
  const fh = ih;
  const quads: Record<number, Quad> = {};
  for (let i = 0; i <= count - 1; i++) {
    quads[i] = G.newQuad(i * fw, 0, fw, fh, iw, ih);
  }
  Chrome._arrow = { image: img, quads, frameW: fw, frameH: fh, count, path };
  return Chrome._arrow;
}

/** Bounce prompt arrow (pret down_arrows). px,py = top-left of glyph. pokeemerald/src/text.c:819 */
// Lua: chrome.lua:408
function drawRseArrow(a: LuaTable, px: number, py: number, frame: unknown): void {
  if (Chrome._rseArrow === undefined) {
    Chrome._rseArrow = loadImage([{ path: a.path, w: a.w, h: a.h }])[0] || false;
    if (!Chrome._rseArrow) throw new Error("Chrome: " + tostring(a.path) + " is not in the cache");
  }
  const img = Chrome._rseArrow as Image;
  const offs = a.yOffsets;
  const off = offs[mod(Math.floor(tonumber(frame) ?? 0), len(offs)) + 1];
  Chrome._rseArrowQuads = Chrome._rseArrowQuads || {};
  let q = Chrome._rseArrowQuads[off];
  if (!q) {
    const [iw, ih] = img.getDimensions();
    q = G.newQuad(0, off, a.w, a.frameH, iw, ih);
    Chrome._rseArrowQuads[off] = q;
  }
  G.setColor(1, 1, 1, 1);
  G.draw(img, q, px, py);
}

// Lua: chrome.lua:449
function ensureUser(frameType: unknown): TileAtlas | undefined {
  let n = tonumber(frameType) ?? 0;
  if (n < 0 || n >= Chrome.userFrameCount() || n !== Math.floor(n)) n = 0; // pokefirered/src/text_window_graphics.c:58
  const cached = Chrome._user[n];
  if (cached !== undefined) return cached || undefined;
  const spec = frames();
  let img: Image | undefined, path: string | undefined;
  if (spec && truthy(spec.user)) {
    [img, path] = loadImage([{ path: format(spec.user, n), w: 24, h: 24 }]);
    if (!img) throw new Error("Chrome: " + format(spec.user, n) + " is not in the cache");
  } else {
    const rel = "chrome/user_frame_" + tostring(n) + ".rgba";
    [img, path] = loadImage([
      { path: rel, w: 24, h: 24 },
      { path: "data/generated/gba/" + rel, w: 24, h: 24 },
    ]);
  }
  Chrome._user[n] = img ? { image: img, quads: makeQuads(img, 3, 3), path } : false;
  return Chrome._user[n] || undefined;
}

// Lua: chrome.lua:520
function drawNineSlice(atlas: TileAtlas, tx: number, ty: number, tw: number, th: number): void {
  G.setColor(1, 1, 1, 1);
  const L = tx, Top = ty, W = tw, H = th;
  const cell = (tile: number, cx: number, cy: number): void => {
    blitTile(atlas, tile, cx * T, cy * T, false);
  };
  const hspan = (tile: number, cx: number, cy: number, n: number): void => {
    for (let i = 0; i <= n - 1; i++) cell(tile, cx + i, cy);
  };
  const vspan = (tile: number, cx: number, cy: number, n: number): void => {
    for (let i = 0; i <= n - 1; i++) cell(tile, cx, cy + i);
  };

  fillRect(L * T, Top * T, W * T, H * T, 1, 1, 1, 1);

  cell(0, L - 1, Top - 1);
  hspan(1, L, Top - 1, W);
  cell(2, L + W, Top - 1);
  vspan(3, L - 1, Top, H);
  vspan(5, L + W, Top, H);
  cell(6, L - 1, Top + H);
  hspan(7, L, Top + H, W);
  cell(8, L + W, Top + H);
}

export const Chrome = {
  DLG_LEFT: 2,
  DLG_TOP: 15,
  DLG_W: 26,
  DLG_H: 4,

  _dlg: undefined as TileAtlas | undefined, // { image, quads[0..17] }
  _std: undefined as TileAtlas | undefined, // { image, quads[0..8] }
  _sign: undefined as TileAtlas | undefined,
  _arrow: undefined as ArrowAtlas | undefined, // { image, quads[], frameW, frameH, count }
  _logged: false,

  _syncVersion: undefined as string | undefined,
  _frames: undefined as LuaTable | undefined,
  _specKey: undefined as string | undefined,
  _manifest: undefined as LuaTable | false | undefined,
  _arrowSpec: undefined as LuaTable | undefined,
  _textCursor: undefined as Image | false | undefined,
  _rseArrow: undefined as Image | false | undefined,
  _rseArrowQuads: undefined as Record<number, Quad> | undefined,

  frames,

  // Lua: chrome.lua:134
  dialogueWindow(): [number, number, number, number] {
    const spec = frames();
    const w = spec ? spec.dialogueWindow : undefined;
    if (truthy(w)) return [w.left, w.top, w.width, w.height];
    return [Chrome.DLG_LEFT, Chrome.DLG_TOP, Chrome.DLG_W, Chrome.DLG_H];
  },

  // pokefirered/src/text_window_graphics.c:58
  // Lua: chrome.lua:142
  userFrameCount(): number {
    const spec = frames();
    return (spec ? spec.userCount : undefined) ?? 10;
  },

  // Lua: chrome.lua:147
  arrowSpec(): LuaTable | undefined {
    const spec = frames();
    const a = spec ? spec.arrow : undefined;
    if (!truthy(a)) return undefined;
    if (Chrome._arrowSpec) return Chrome._arrowSpec;
    const m = manifest(spec);
    const info = m && m.fonts ? m.fonts[a.manifestKey] : undefined;
    if (info === null || typeof info !== "object") {
      throw new Error("Chrome: chrome/manifest.lua has no fonts." + tostring(a.manifestKey));
    }
    Chrome._arrowSpec = {
      path: a.path, w: info.width, h: info.height, frameH: info.frameH,
      yOffsets: info.yOffsets, delay: a.delay, lastPage: a.lastPage,
    };
    return Chrome._arrowSpec;
  },

  // Lua: chrome.lua:263
  windowFillColor(): Col {
    if (FrlgFont.face) FrlgFont.face();
    const c = FrlgFont.STDPAL ? FrlgFont.STDPAL[1] : undefined;
    if (c !== null && typeof c === "object") return c;
    return seq(1, 1, 1, 1) as Col;
  },

  // Lua: chrome.lua:271
  dialogueFrame(): void {
    let L = Chrome.DLG_LEFT, Top = Chrome.DLG_TOP, W = Chrome.DLG_W, H = Chrome.DLG_H;
    const atlas = ensureDlg();
    if (atlas && atlas.layout === "message_box") {
      [L, Top, W, H] = Chrome.dialogueWindow();
      return drawMessageBox(atlas, L, Top, W, H);
    }
    if (!atlas) {
      // Soft fallback if assets missing (should not happen in-repo).
      fillRect(0, 14 * T, 30 * T, 6 * T, 0.19, 0.32, 0.80, 1);
      fillRect(2, 14 * T + 2, 30 * T - 4, 6 * T - 4, 1, 1, 1, 1);
      return;
    }

    G.setColor(1, 1, 1, 1);
    const cell = (tile: number, tx: number, ty: number, vflip?: boolean): void => {
      blitTile(atlas, tile, tx * T, ty * T, vflip);
    };
    const row = (tile: number, tx: number, ty: number, count: number, vflip?: boolean): void => {
      for (let i = 0; i <= count - 1; i++) {
        cell(tile, tx + i, ty, vflip);
      }
    };

    // Top edge (T-1)
    cell(0, L - 2, Top - 1);
    cell(1, L - 1, Top - 1);
    row(2, L, Top - 1, W);
    cell(3, L + W, Top - 1);
    cell(4, L + W + 1, Top - 1);
    // Sides row T+0
    cell(5, L - 2, Top);
    cell(6, L - 1, Top);
    cell(8, L + W, Top);
    cell(9, L + W + 1, Top);
    // Sides row T+1
    cell(10, L - 2, Top + 1);
    cell(11, L - 1, Top + 1);
    cell(12, L + W, Top + 1);
    cell(13, L + W + 1, Top + 1);
    // Sides row T+2 (V-flip of T+1)
    cell(10, L - 2, Top + 2, true);
    cell(11, L - 1, Top + 2, true);
    cell(12, L + W, Top + 2, true);
    cell(13, L + W + 1, Top + 2, true);
    // Sides row T+3 (V-flip of T+0)
    cell(5, L - 2, Top + 3, true);
    cell(6, L - 1, Top + 3, true);
    cell(8, L + W, Top + 3, true);
    cell(9, L + W + 1, Top + 3, true);
    // Bottom edge (T+4 = V-flip of top)
    cell(0, L - 2, Top + 4, true);
    cell(1, L - 1, Top + 4, true);
    row(2, L, Top + 4, W, true);
    cell(3, L + W, Top + 4, true);
    cell(4, L + W + 1, Top + 4, true);

    // Interior: PIXEL_FILL(1) white paper (stdpal_0 index 1).
    fillRect(L * T, Top * T, W * T, H * T, 1, 1, 1, 1);
  },

  /** pret WindowFunc_DrawSignpostFrame — same geometry as dialogue, signpost tiles. */
  // Lua: chrome.lua:342
  signFrame(): void {
    const spec = frames();
    if (spec && spec.sign === false) return Chrome.dialogueFrame();
    const L = Chrome.DLG_LEFT, Top = Chrome.DLG_TOP, W = Chrome.DLG_W, H = Chrome.DLG_H;
    const atlas = ensureSign();
    if (!atlas) {
      // Fall back to dialogue chrome if signpost missing.
      return Chrome.dialogueFrame();
    }

    G.setColor(1, 1, 1, 1);
    const cell = (tile: number, tx: number, ty: number, vflip?: boolean): void => {
      blitTile(atlas, tile, tx * T, ty * T, vflip);
    };
    const row = (tile: number, tx: number, ty: number, count: number, vflip?: boolean): void => {
      for (let i = 0; i <= count - 1; i++) {
        cell(tile, tx + i, ty, vflip);
      }
    };

    cell(0, L - 2, Top - 1);
    cell(1, L - 1, Top - 1);
    row(2, L, Top - 1, W);
    cell(3, L + W, Top - 1);
    cell(4, L + W + 1, Top - 1);
    cell(5, L - 2, Top);
    cell(6, L - 1, Top);
    cell(8, L + W, Top);
    cell(9, L + W + 1, Top);
    cell(10, L - 2, Top + 1);
    cell(11, L - 1, Top + 1);
    cell(12, L + W, Top + 1);
    cell(13, L + W + 1, Top + 1);
    cell(10, L - 2, Top + 2, true);
    cell(11, L - 1, Top + 2, true);
    cell(12, L + W, Top + 2, true);
    cell(13, L + W + 1, Top + 2, true);
    cell(5, L - 2, Top + 3, true);
    cell(6, L - 1, Top + 3, true);
    cell(8, L + W, Top + 3, true);
    cell(9, L + W + 1, Top + 3, true);
    cell(0, L - 2, Top + 4, true);
    cell(1, L - 1, Top + 4, true);
    row(2, L, Top + 4, W, true);
    cell(3, L + W, Top + 4, true);
    cell(4, L + W + 1, Top + 4, true);

    // Sign interior is parchment / light tan (stdpal_1-ish).
    fillRect(L * T, Top * T, W * T, H * T, 0.97, 0.94, 0.82, 1);
  },

  // pokefirered/src/text.c:1313
  // Lua: chrome.lua:398
  textCursorImage(): Image | undefined {
    if (Chrome._textCursor === undefined) {
      Chrome._textCursor = loadImage(PATHS.textCursor!)[0] || false;
    }
    return Chrome._textCursor || undefined;
  },

  // Lua: chrome.lua:427
  promptArrow(px: number, py: number, frame: unknown): void {
    const rse = Chrome.arrowSpec();
    if (rse) return drawRseArrow(rse, px, py, frame);
    const atlas = ensureArrow();
    if (!atlas) {
      G.setColor(230 / 255, 8 / 255, 8 / 255, 1);
      G.polygon("fill",
        px, py + 2,
        px + 8, py + 2,
        px + 4, py + 7);
      G.setColor(1, 1, 1, 1);
      return;
    }
    let f = tonumber(frame) ?? 0;
    f = mod(f, atlas.count);
    const q = atlas.quads[f]!;
    G.setColor(1, 1, 1, 1);
    G.draw(atlas.image, q, px, py);
  },

  _user: {} as Record<number, TileAtlas | false>,

  // Lua: chrome.lua:474
  userFrame(frameType: unknown, tx: number, ty: number, tw: number, th: number): void {
    const atlas = ensureUser(frameType);
    if (!atlas) return Chrome.stdFrame(tx, ty, tw, th);
    drawNineSlice(atlas, tx, ty, tw, th);
  },

  _frameType: 0,

  // Lua: chrome.lua:482
  setFrameType(nIn: unknown): number {
    let n = tonumber(nIn) ?? 0;
    if (n < 0) n = 0;
    if (n !== Chrome._frameType) {
      Chrome._frameType = n;
      if (Chrome.invalidate) Chrome.invalidate();
    }
    return Chrome._frameType;
  },

  /** pret std 9-slice around content (tx,ty,tw,th) in tiles. */
  // Lua: chrome.lua:493
  stdFrame(tx: number, ty: number, tw: number, th: number): void {
    const ft = Chrome._frameType ?? 0;
    const user = ensureUser(ft);
    if (user) return drawNineSlice(user, tx, ty, tw, th);
    const atlas = ensureStd();
    if (atlas) return drawNineSlice(atlas, tx, ty, tw, th);
    fillRect(tx * T - 8, ty * T - 8, (tw + 2) * T, (th + 2) * T, 98 / 255, 115 / 255, 123 / 255, 1);
    fillRect(tx * T - 6, ty * T - 6, (tw + 2) * T - 4, (th + 2) * T - 4, 205 / 255, 213 / 255, 213 / 255, 1);
    fillRect(tx * T, ty * T, tw * T, th * T, 1, 1, 1, 1);
  },

  // src/text_window.c:35
  // Lua: chrome.lua:505
  fixedStdFrame(tx: number, ty: number, tw: number, th: number): void {
    const spec = frames();
    if (spec && spec.std === "user") return Chrome.stdFrame(tx, ty, tw, th);
    const atlas = ensureStd();
    if (atlas) return drawNineSlice(atlas, tx, ty, tw, th);
    fillRect(tx * T - 8, ty * T - 8, (tw + 2) * T, (th + 2) * T, 98 / 255, 115 / 255, 123 / 255, 1);
    fillRect(tx * T - 6, ty * T - 6, (tw + 2) * T - 4, (th + 2) * T - 4, 205 / 255, 213 / 255, 213 / 255, 1);
    fillRect(tx * T, ty * T, tw * T, th * T, 1, 1, 1, 1);
  },

  /**
   * pret MapNamePopupCreateWindow 9-slice banner at pixel coordinates (px, py).
   * Content size is (widthTiles * 8) wide by 16 high.
   * Outer border spans: x in [px, px + (widthTiles + 2)*8], y in [py, py + 24].
   */
  // Lua: chrome.lua:549
  mapPopupFrame(px: number, py: number, widthTilesIn?: unknown): void {
    const widthTiles = tonumber(widthTilesIn) ?? 14;
    const contentW = widthTiles * 8;
    const atlas = ensureStd();

    if (atlas) {
      G.setColor(1, 1, 1, 1);
      const cell = (tile: number, cx: number, cy: number, vflip?: boolean): void => {
        blitTile(atlas, tile, cx, cy, vflip);
      };
      const hspan = (tile: number, cx: number, cy: number, n: number, vflip?: boolean): void => {
        for (let i = 0; i <= n - 1; i++) cell(tile, cx + i * 8, cy, vflip);
      };

      // 1. Content background: pure white PIXEL_FILL(1)
      fillRect(px + 8, py + 4, contentW, 16, 1, 1, 1, 1);

      // 2. Top edge (row 0, y = py) — mirrored from bottom edge (tiles 6, 7, 8 vflipped)
      cell(6, px, py, true);
      hspan(7, px + 8, py, widthTiles, true);
      cell(8, px + 8 + contentW, py, true);

      // 3. Left & Right borders (height = 1 tile / 8px middle row, y = py + 8)
      cell(3, px, py + 8);
      cell(5, px + 8 + contentW, py + 8);

      // 4. Bottom edge (row 2, y = py + 16)
      cell(6, px, py + 16, false);
      hspan(7, px + 8, py + 16, widthTiles, false);
      cell(8, px + 8 + contentW, py + 16, false);
      return;
    }

    // Fallback if atlas missing
    fillRect(px, py, contentW + 16, 24, 98 / 255, 115 / 255, 123 / 255, 1);
    fillRect(px + 2, py + 2, contentW + 12, 20, 205 / 255, 213 / 255, 213 / 255, 1);
    fillRect(px + 8, py + 4, contentW, 16, 1, 1, 1, 1);
  },

  // Lua: chrome.lua:589
  invalidate(): void {
    Chrome._dlg = undefined;
    Chrome._std = undefined;
    Chrome._sign = undefined;
    Chrome._arrow = undefined;
    Chrome._textCursor = undefined;
    Chrome._user = {};
    Chrome._rseArrow = undefined;
    Chrome._rseArrowQuads = undefined;
    Chrome._arrowSpec = undefined;
    Chrome._manifest = undefined;
    Chrome._logged = false;
  },
};

export default Chrome;
