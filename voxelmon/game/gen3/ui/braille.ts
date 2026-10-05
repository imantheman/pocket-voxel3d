// Port of gen1recomp src/ui/game3/braille.lua (GPLv3 + additional terms; see LICENSE.md).
// pokefirered/src/braille_text.c:15
//
// Lua's `package.loaded["src.X"]` / `pcall(require, "src.X")` become the
// static imports below; Brian's pcall around each call is kept.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { byte, mod, tonumber, tostring } from "../../../import/gen3/lua.ts";
import { ipairs, len, seq, type LuaTable } from "../platform/lt.ts";
import { gmatch, gsub, match } from "../platform/lpattern.ts";
import { G } from "../platform/graphics.ts";
import { newImageData, type Image, type Quad } from "../platform/image.ts";
import { Fs } from "../platform/fs.ts";
import { Timer } from "../platform/timer.ts";
import { luaLoad } from "../platform/luadata.ts";
import { FrlgFont, type Colors } from "./frlg_font.ts";
import { Message } from "./message.ts";
import { Chrome } from "./chrome.ts";
import { TextIR } from "../core/scripting/text_ir.ts";
import { Dataset } from "../core/dataset.ts";
import { CacheFs } from "../shared/import/CacheFs.ts";
import { Logger } from "../shared/core/Logger.ts";

/** One encoded line: glyph codes, `false` for a character with no cell (a sequence). */
export type BrailleLine = (number | false | null)[];

export interface BrailleDrawOpts { limitChars?: unknown; maxWidth?: number; colors?: Colors }
export interface BrailleShowOpts { width?: unknown; speed?: unknown; session?: LuaTable }

// pokefirered/include/characters.h:285
const CODE: Record<string, number> = {
  " ": 0x00,
  A: 0x01, B: 0x05, C: 0x03, D: 0x0B, E: 0x09, F: 0x07, G: 0x0F,
  H: 0x0D, I: 0x06, J: 0x0E, K: 0x11, L: 0x15, M: 0x13, N: 0x1B,
  O: 0x19, P: 0x17, Q: 0x1F, R: 0x1D, S: 0x16, T: 0x1E, U: 0x31,
  V: 0x35, W: 0x2E, X: 0x33, Y: 0x3B, Z: 0x39,
  ",": 0x04, ".": 0x2C, "?": 0x34, "!": 0x1C, ":": 0x0C,
  ";": 0x14, "-": 0x30, "/": 0x12, "(": 0x3C, ")": 0x3C,
  "'": 0x10, "#": 0x3A, '"': 0x38,
};

// pokefirered/include/characters.h:337
const DIGIT: Record<string, number> = {
  "0": 0x0E, "1": 0x01, "2": 0x05, "3": 0x03, "4": 0x0B,
  "5": 0x09, "6": 0x07, "7": 0x0F, "8": 0x0D, "9": 0x06,
};

const hasOwn = Object.prototype.hasOwnProperty;
/** `t[k]` on a Lua table keyed by character (nil for anything else). */
function at(t: Record<string, number>, k: string): number | undefined {
  return hasOwn.call(t, k) ? t[k] : undefined;
}

// Lua: braille.lua:35
{
  const lower: Record<string, number> = {};
  for (const ch of Object.keys(CODE)) {
    if (match(ch, "^%u$") != null) lower[ch.toLowerCase()] = CODE[ch]!;
  }
  for (const ch of Object.keys(lower)) {
    CODE[ch] = lower[ch]!;
  }
}

const NUM_CHARS = 0x40;

// Lua: braille.lua:43
const RECOVERED: Record<string, number> = {};
for (let b = 0; b <= NUM_CHARS - 1; b++) {
  const ch = TextIR.CHARMAP[b];
  if (ch != null && at(CODE, ch) == null) RECOVERED[ch] = b;
}

const SHEET_PATHS = seq(
  "chrome/fonts/braille_fg.rgba",
  "data/generated/gba/chrome/fonts/braille_fg.rgba",
  "chrome/fonts/braille.rgba",
  "data/generated/gba/chrome/fonts/braille.rgba",
  "chrome/fonts/braille_fg.png",
  "data/generated/gba/chrome/fonts/braille_fg.png",
  "chrome/fonts/braille.png",
  "data/generated/gba/chrome/fonts/braille.png",
);

const SHADOW_PATHS = seq(
  "chrome/fonts/braille_shadow.rgba",
  "data/generated/gba/chrome/fonts/braille_shadow.rgba",
  "chrome/fonts/braille_shadow.png",
  "data/generated/gba/chrome/fonts/braille_shadow.png",
);

const MANIFEST_PATHS = seq(
  "chrome/fonts/braille.lua",
  "data/generated/gba/chrome/fonts/braille.lua",
);

interface Size { w: number; h: number }
const SHEET_SIZES = seq<Size>(
  { w: 256, h: 64 },
  { w: 128, h: 128 },
  { w: 256, h: 128 },
);

const WHITE = seq(1, 1, 1, 1);
// pokefirered/src/field_specials.c:2488
const CURSOR_SEQ = seq(0, 1, 2, 3, 2, 1);

// Lua: braille.lua:89
function log(msg: unknown): void {
  if (Braille._logged) return;
  Braille._logged = true;
  Logger.info("%s", "[game3/braille] " + tostring(msg));
}

// Lua: braille.lua:95
// NOT FAITHFUL: no io.open on the 3DS. The last-resort OS reads of the path
// and its data/generated/gba form are dropped; love.filesystem already read both.
function read_bytes(rel: string): string | undefined {
  try {
    const cache = Dataset.cache();
    if (cache && cache.read) {
      try {
        const d = cache.read(rel);
        if (typeof d === "string" && d.length > 0) return d;
      } catch { /* pcall */ }
    }
  } catch { /* pcall */ }
  if (CacheFs && CacheFs.readActive) {
    try {
      const d = CacheFs.readActive(rel);
      if (typeof d === "string" && d.length > 0) return d;
    } catch { /* pcall */ }
  }
  {
    try {
      const d = Fs.read(rel);
      if (typeof d === "string" && d.length > 0) return d;
    } catch { /* pcall */ }
    const alt = "data/generated/gba/" + gsub(rel, "^data/generated/gba/", "")[0];
    try {
      const d = Fs.read(alt);
      if (typeof d === "string" && d.length > 0) return d;
    } catch { /* pcall */ }
  }
  return undefined;
}

// Lua: braille.lua:128
function load_lua(paths: (string | null)[]): any {
  for (const [, path] of ipairs<string>(paths)) {
    const src = read_bytes(path);
    if (src) {
      const [chunk] = luaLoad(src, "@" + path);
      if (chunk) {
        let ok = true, t: unknown;
        try { t = chunk(); } catch { ok = false; }
        if (ok && t != null && typeof t === "object") return t;
      }
    }
  }
  return undefined;
}

// Lua: braille.lua:142
function image_from(data: string, path: string, manifest: any): Image | undefined {
  const sizes: (Size | null)[] = seq();
  if (manifest != null && typeof manifest === "object" && tonumber(manifest.width) != null && tonumber(manifest.height) != null) {
    sizes[1] = { w: Math.floor(tonumber(manifest.width)!), h: Math.floor(tonumber(manifest.height)!) };
  }
  for (const [, size] of ipairs<Size>(SHEET_SIZES)) sizes[len(sizes) + 1] = size;
  for (const [, size] of ipairs<Size>(sizes)) {
    if (data.length === size.w * size.h * 4) {
      let id;
      try { id = newImageData(size.w, size.h, "rgba8", data); } catch { id = undefined; }
      if (id) {
        const img = G.newImage(id);
        if (img && img.setFilter) img.setFilter("nearest", "nearest");
        return img;
      }
    }
  }
  if (Fs.newFileData) {
    let fd;
    try { fd = Fs.newFileData(data, path); } catch { fd = undefined; }
    if (fd) {
      let id;
      try { id = newImageData(fd); } catch { id = undefined; }
      if (id) {
        const img = G.newImage(id);
        if (img && img.setFilter) img.setFilter("nearest", "nearest");
        return img;
      }
    }
  }
  return undefined;
}

// Lua: braille.lua:173
function load_sheet(paths: (string | null)[], manifest: any): [Image | undefined, string | undefined] {
  for (const [, path] of ipairs<string>(paths)) {
    const data = read_bytes(path);
    if (data) {
      const img = image_from(data, path, manifest);
      if (img) return [img, path];
    }
  }
  return [undefined, undefined];
}

// Lua: braille.lua:197
function ensure(): boolean {
  if (Braille._quads) return true;
  if (Braille._tried) return Braille._fg != null;
  Braille._tried = true;
  if (!G.newQuad) return false;
  const manifest = load_lua(MANIFEST_PATHS);
  const [fg, path] = load_sheet(SHEET_PATHS, manifest);
  if (!fg) {
    log("no braille glyph sheet in the cache; printing the plain text instead");
    return false;
  }
  Braille._fg = fg;
  Braille._sh = load_sheet(SHADOW_PATHS, manifest)[0];
  const w = fg.getWidth(), h = fg.getHeight();
  const cols = Braille.sheetCols(manifest, w);
  const quads: Record<number, Quad> = {};
  for (let code = 0; code <= Braille.NUM_CHARS - 1; code++) {
    const [gx, gy] = Braille.glyphCell(code, cols);
    if (gy + Braille.GLYPH_HEIGHT <= h) {
      quads[code] = G.newQuad(gx, gy, Braille.GLYPH_WIDTH, Braille.GLYPH_HEIGHT, w, h);
    }
  }
  Braille._quads = quads;
  log("braille glyph sheet from " + tostring(path));
  return true;
}

const CHAR_PATTERN = "[%z\x01-\x7f\xc2-\xf4][\x80-\xbf]*";

// Lua: braille.lua:235
function* chars(text: unknown): Generator<string> {
  for (const caps of gmatch(tostring(text ?? ""), CHAR_PATTERN)) yield caps[0] as string;
}

// A Unicode braille cell (U+2800-U+283F, dots 1-6 as bits 0-5) is drawn as that
// cell: pokefirered/include/characters.h:282 keeps every dot combination in the
// braille font, numbered dot 1 = 0x01, 4 = 0x02, 2 = 0x04, 5 = 0x08, 3 = 0x10,
// 6 = 0x20.  A mod can hand over a European cart's own braille this way, cells
// such as German ä that no Latin character spells included.
const CELL_BIT = seq(0x01, 0x04, 0x10, 0x02, 0x08, 0x20);

// Lua: braille.lua:246
function unicode_cell(ch: string): number | undefined {
  const b1 = byte(ch, 1), b2 = byte(ch, 2), b3 = byte(ch, 3);
  if (ch.length !== 3 || b1 !== 0xE2 || b2 !== 0xA0 || b3 == null || b3 < 0x80 || b3 > 0xBF) {
    return undefined;
  }
  let dots = b3 - 0x80, code = 0;
  for (let dot = 1; dot <= 6; dot++) {
    if (mod(dots, 2) === 1) code = code + CELL_BIT[dot]!;
    dots = Math.floor(dots / 2);
  }
  return code;
}

let encodeCache = new Map<string, (BrailleLine | null)[]>();
let encodeCacheN = 0;

export const Braille = {
  // pokefirered/src/braille_text.c:209
  GLYPH_WIDTH: 16,
  // pokefirered/src/new_menu_helpers.c:121
  GLYPH_HEIGHT: 16,
  LINE_PITCH: 18,
  // pokefirered/include/characters.h:335
  NUM_CHARS,
  CODE,
  // pokefirered/include/characters.h:337
  NUMBER: 0x3A,
  DIGIT,

  _fg: undefined as Image | undefined,
  _sh: undefined as Image | undefined,
  _quads: undefined as Record<number, Quad> | undefined,
  _tried: false,
  _logged: false,
  _cursor: undefined as { x: number; y: number } | undefined,
  _text: undefined as string | undefined,
  _width: undefined as number | undefined,

  unicodeCell: unicode_cell,

  // Lua: braille.lua:184
  sheetCols(manifest: any, imageWidth: unknown): number {
    const cols = manifest != null && typeof manifest === "object" ? tonumber(manifest.cols) : undefined;
    if (cols != null && cols >= 1) return Math.floor(cols);
    return Math.max(1, Math.floor((tonumber(imageWidth) ?? Braille.GLYPH_WIDTH) / Braille.GLYPH_WIDTH));
  },

  // pokefirered/src/braille_text.c:200
  // Lua: braille.lua:191
  glyphCell(codeIn: unknown, colsIn: unknown): [number, number] {
    const cols = Math.max(1, Math.floor(tonumber(colsIn) ?? 1));
    const code = Math.floor(tonumber(codeIn) ?? 0);
    return [mod(code, cols) * Braille.GLYPH_WIDTH, Math.floor(code / cols) * Braille.GLYPH_HEIGHT];
  },

  // Lua: braille.lua:224
  hasSheet(): boolean {
    return ensure() && Braille._quads != null;
  },

  // Lua: braille.lua:228
  invalidate(): void {
    Braille._fg = undefined;
    Braille._sh = undefined;
    Braille._quads = undefined;
    Braille._tried = false;
  },

  // Lua: braille.lua:263
  encode(text: unknown): (BrailleLine | null)[] {
    const key = tostring(text ?? "");
    const hit = encodeCache.get(key);
    if (hit) return hit;
    const lines: (BrailleLine | null)[] = seq(seq());
    let cur = lines[1]!;
    let inNumber = false;
    for (const ch of chars(text)) {
      if (ch === "\n") {
        lines[len(lines) + 1] = seq();
        cur = lines[len(lines)]!;
        inNumber = false;
      } else if (ch !== "\r") {
        const cell = unicode_cell(ch);
        const digit = cell == null ? at(Braille.DIGIT, ch) : undefined;
        let code = cell ?? at(Braille.CODE, ch) ?? at(RECOVERED, ch);
        if (cell != null) {
          // a cell spells its own number sign, as the carts' braille does
          inNumber = false;
        } else if (digit != null) {
          if (!inNumber) {
            inNumber = true;
            cur[len(cur) + 1] = Braille.NUMBER;
          }
          code = digit;
        } else if (code === 0x00) {
          inNumber = false;
        }
        cur[len(cur) + 1] = code ?? false;
      }
    }
    if (encodeCacheN > 64) {
      encodeCache = new Map();
      encodeCacheN = 0;
    }
    encodeCache.set(key, lines);
    encodeCacheN = encodeCacheN + 1;
    return lines;
  },

  // pokefirered/src/text.c:1020
  // Lua: braille.lua:304
  width(text: unknown): number {
    let best = 0;
    for (const [, line] of ipairs<BrailleLine>(Braille.encode(text))) {
      const w = len(line) * Braille.GLYPH_WIDTH;
      if (w > best) best = w;
    }
    return best;
  },

  // Lua: braille.lua:313
  countGlyphs(text: unknown): number {
    let n = 0;
    for (const [, line] of ipairs<BrailleLine>(Braille.encode(text))) {
      n = n + len(line);
    }
    return n;
  },

  // pokefirered/src/field_specials.c:2478
  // Lua: braille.lua:322
  setCursor(px: unknown, py: unknown): void {
    Braille._cursor = { x: tonumber(px) ?? 0, y: tonumber(py) ?? 0 };
  },

  // Lua: braille.lua:326
  clearCursor(): void {
    Braille._cursor = undefined;
  },

  // Lua: braille.lua:330
  cursor(): { x: number; y: number } | undefined {
    return Braille._cursor;
  },

  // pokefirered/src/scrcmd.c:1558
  // Lua: braille.lua:335
  show(text: unknown, optsIn?: BrailleShowOpts | unknown): boolean {
    const opts: BrailleShowOpts = optsIn != null && typeof optsIn === "object" ? optsIn as BrailleShowOpts : {};
    const body = tostring(text ?? "");
    Braille._text = body;
    Braille._width = tonumber(opts.width) ?? Braille.width(body);
    Braille.clearCursor();
    Message.showStay(body, { frame: "braille", speed: opts.speed, session: opts.session });
    return true;
  },

  // Lua: braille.lua:346
  isOpen(): boolean {
    return (Message && Message.isOpen() && Message.frameKind() === "braille") || false;
  },

  // Lua: braille.lua:351
  hide(): void {
    if (Message && Message.isOpen() && Message.frameKind() === "braille") {
      Message.close();
    }
    Braille.clearCursor();
  },

  // pokefirered/src/braille_text.c:196
  // Lua: braille.lua:360
  drawText(text: unknown, x: number, y: number, opts?: BrailleDrawOpts | null): boolean {
    opts = opts || {};
    const limit = tonumber(opts.limitChars);
    if (!ensure()) {
      FrlgFont.draw(tostring(text ?? ""), x, y, {
        maxWidth: opts.maxWidth ?? 208,
        limitChars: limit,
        colors: opts.colors ?? FrlgFont.COLOR.NORMAL,
      });
      return false;
    }
    const colors = opts.colors ?? FrlgFont.COLOR.NORMAL!;
    let drawn = 0;
    for (const [row, line] of ipairs<BrailleLine>(Braille.encode(text))) {
      const penY = y + (row - 1) * Braille.LINE_PITCH;
      for (const [col, code] of ipairs<number | false>(line)) {
        if (limit != null && drawn >= limit) {
          G.setColor(1, 1, 1, 1);
          return true;
        }
        drawn = drawn + 1;
        const quad = code !== false ? Braille._quads![code] : undefined;
        if (quad) {
          const penX = x + (col - 1) * Braille.GLYPH_WIDTH;
          if (Braille._sh && colors.shadow) {
            G.setColor(colors.shadow);
            G.draw(Braille._sh, quad, penX, penY);
          }
          G.setColor((colors.fg ?? WHITE) as number[]);
          G.draw(Braille._fg!, quad, penX, penY);
        }
      }
    }
    G.setColor(1, 1, 1, 1);
    return true;
  },

  // Lua: braille.lua:397
  drawCursor(): void {
    const c = Braille._cursor;
    if (!c) return;
    const t = Timer.getTime() || 0;
    Chrome.promptArrow(c.x, c.y, CURSOR_SEQ[1 + mod(Math.floor(t * 8), len(CURSOR_SEQ))] ?? 0);
  },
};

export default Braille;
