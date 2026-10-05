// Port of gen1recomp src/import/gba/extract_naming.lua (GPLv3 + additional terms; see LICENSE.md).
// Extract FRLG naming-screen chrome from ROM → firered cache.
// Offsets: Versions.NAMING (FireRed USA 1.0).
// Layout reference: pret naming_screen.c (ROM is source of truth for pixels).
//
// Port notes (as extract_intro.ts):
// - The ROM comes in as the revised ROM bytes (Uint8Array or byte string),
//   or the Lua's shim { data = ... } holding them.
// - Byte tables the Lua builds 1-based are 0-based here (Lua `t[k + 1]` reads
//   `t[k]`); palettes and palette banks keep the Lua's 0-based integer keys.
// - encodePng returns the ImageData (the Lua: its PNG bytes), and cropPng
//   reads that ImageData instead of decoding the PNG again (lossless RGBA8,
//   same pixels). PNG bytes are made where a file is written.

import { Lz77 } from "./lz77.ts";
import { Versions } from "./versions.ts";
import { ImageData } from "./imagedata.ts";
import { format, mod } from "./lua.ts";
import type { Cache } from "./cache.ts";

type Pal = Record<number, number>;
type Bytes = ArrayLike<number>;
type Rgba = [number, number, number, number];
type Png = ImageData;
export type RomInput = Uint8Array | string | { data?: Uint8Array | string };

// Lua: extract_naming.lua:13
function write(cache: Cache | undefined, path: string, data: string | Png): boolean {
  const body = typeof data === "string" ? data : data.encode("png").bytes;
  if (cache && cache.write) {
    return cache.write(path, body);
  }
  // NOT FAITHFUL: no love.filesystem.write fallback (the save directory) here.
  return false;
}

// Lua: extract_naming.lua:23
function romBytes(rom: RomInput | undefined): Uint8Array | string | undefined {
  if (typeof rom === "string" || rom instanceof Uint8Array) return rom;
  if (rom !== null && typeof rom === "object" && (typeof rom.data === "string" || rom.data instanceof Uint8Array)) return rom.data;
  return undefined;
}

// Lua: extract_naming.lua:29
function makeGet(data: Uint8Array | string): (i: number) => number {
  if (typeof data === "string") return (i) => (i >= 0 && i < data.length ? data.charCodeAt(i) : 0);
  return (i) => data[i] ?? 0;
}

// Lua: extract_naming.lua:35 -- [bytes (0-based), len]
function decompress(get: (i: number) => number, off: number): [Uint8Array, number] {
  const [out] = Lz77.decompress(get, off);
  return [out, out.length];
}

// Lua: extract_naming.lua:43 -- 0-based (Lua bytes[i] for i = 1..n -> bytes[i - 1])
function readRaw(get: (i: number) => number, off: number, n: number): number[] {
  const bytes: number[] = [];
  for (let i = 1; i <= n; i++) bytes[i - 1] = get(off + i - 1);
  return bytes;
}

// Lua: extract_naming.lua:49
function readPal(get: (i: number) => number, off: number, count: number): Pal {
  const pal: Pal = {};
  for (let i = 0; i <= count - 1; i++) {
    const lo = get(off + i * 2);
    const hi = get(off + i * 2 + 1);
    pal[i] = lo + hi * 256;
  }
  return pal;
}

// Lua: extract_naming.lua:59
function bgr555_to_rgba(c: number | undefined, transparent0: boolean): Rgba {
  c = mod(c ?? 0, 32768);
  if (transparent0 && c === 0) return [0, 0, 0, 0];
  const r5 = mod(c, 32);
  const g5 = mod(Math.floor(c / 32), 32);
  const b5 = mod(Math.floor(c / 1024), 32);
  const r = Math.floor(r5 * 255 / 31 + 0.5);
  const g = Math.floor(g5 * 255 / 31 + 0.5);
  const b = Math.floor(b5 * 255 / 31 + 0.5);
  // Magenta key
  if (r > 240 && g < 16 && b > 240) return [0, 0, 0, 0];
  return [r, g, b, 255];
}

// Lua: extract_naming.lua:73
function encodePng(W: number, H: number, setPixel: (x: number, y: number) => Rgba): Png | undefined {
  const id = ImageData.new(W, H);
  for (let y = 0; y <= H - 1; y++) {
    for (let x = 0; x <= W - 1; x++) {
      const [r, g, b, a] = setPixel(x, y);
      id.setPixel(x, y, r / 255, g / 255, b / 255, a / 255);
    }
  }
  return id;
}

// Lua: extract_naming.lua:88
function bake4bppSheet(tiles: Bytes, pal: Pal, cols: number, rows: number, transparent0: boolean,
  keep?: Record<number, boolean>): Png | undefined {
  const tileCount = Math.floor(tiles.length / 32);
  const W = cols * 8, H = rows * 8;
  return encodePng(W, H, (x, y) => {
    const tx = Math.floor(x / 8), ty = Math.floor(y / 8);
    const ti = ty * cols + tx;
    if (ti >= tileCount) return [0, 0, 0, 0];
    const base = ti * 32;
    const row = mod(y, 8);
    const px = mod(x, 8);
    const byte = tiles[base + row * 4 + Math.floor(px / 2)] ?? 0;
    const idx = mod(px, 2) === 0 ? mod(byte, 16) : mod(Math.floor(byte / 16), 16);
    if (keep && !keep[idx]) return [0, 0, 0, 0];
    if (transparent0 && idx === 0) return [0, 0, 0, 0];
    return bgr555_to_rgba(pal[idx] ?? 0, false);
  });
}

/** 16×16 OBJ: 4 tiles in row-major 2×2 (matches pret cursor.png). */
// Lua: extract_naming.lua:107
export function bakeObj16(tiles4: Bytes, pal: Pal): Png | undefined {
  return encodePng(16, 16, (x, y) => {
    const tx = Math.floor(x / 8), ty = Math.floor(y / 8);
    const ti = ty * 2 + tx;
    const base = ti * 32;
    const row = mod(y, 8);
    const px = mod(x, 8);
    const byte = tiles4[base + row * 4 + Math.floor(px / 2)] ?? 0;
    const idx = mod(px, 2) === 0 ? mod(byte, 16) : mod(Math.floor(byte / 16), 16);
    if (idx === 0) return [0, 0, 0, 0];
    return bgr555_to_rgba(pal[idx] ?? 0, false);
  });
}

// Lua: extract_naming.lua:121
function bake4bppMap(tiles: Bytes, palBanks: Record<number, Pal>, map: Bytes, mapW: number, mapH: number,
  defaultBank?: number, transparent0?: boolean): Png | undefined {
  const dBank = defaultBank ?? 0;
  const tileCount = Math.floor(tiles.length / 32);
  const W = mapW * 8, H = mapH * 8;
  return encodePng(W, H, (x, y) => {
    const tx = Math.floor(x / 8), ty = Math.floor(y / 8);
    const mi = (ty * mapW + tx) * 2; // Lua's mi - 1
    const entry = (map[mi] ?? 0) + (map[mi + 1] ?? 0) * 256;
    const tid = mod(entry, 1024);
    const hflip = mod(Math.floor(entry / 1024), 2) === 1;
    const vflip = mod(Math.floor(entry / 2048), 2) === 1;
    const bank = mod(Math.floor(entry / 4096), 16);
    if (tid >= tileCount) return [0, 0, 0, 0];
    const pal = palBanks[bank] ?? palBanks[dBank] ?? palBanks[0]!;
    const sx = hflip ? (7 - mod(x, 8)) : mod(x, 8);
    const sy = vflip ? (7 - mod(y, 8)) : mod(y, 8);
    const base = tid * 32;
    const byte = tiles[base + sy * 4 + Math.floor(sx / 2)] ?? 0;
    const idx = mod(sx, 2) === 0 ? mod(byte, 16) : mod(Math.floor(byte / 16), 16);
    if (transparent0 && idx === 0) return [0, 0, 0, 0];
    return bgr555_to_rgba(pal[idx] ?? 0, false);
  });
}

// Lua: extract_naming.lua:145
function cropPng(pngBytes: Png, srcW: number, srcH: number, x0: number, y0: number, cw: number, ch: number): Png {
  // (The Lua decodes the PNG bytes into an ImageData here; this reads the ImageData.)
  const id = pngBytes;
  const out = ImageData.new(cw, ch);
  for (let y = 0; y <= ch - 1; y++) {
    for (let x = 0; x <= cw - 1; x++) {
      const sx = x0 + x, sy = y0 + y;
      if (sx >= 0 && sy >= 0 && sx < srcW && sy < srcH) {
        const [r, g, b, a] = id.getPixel(sx, sy);
        out.setPixel(x, y, r, g, b, a);
      } else {
        out.setPixel(x, y, 0, 0, 0, 0);
      }
    }
  }
  return out;
}

// Lua: extract_naming.lua:163
function loadMenuPalBanks(get: (i: number) => number, off: number): Record<number, Pal> {
  const banks: Record<number, Pal> = {};
  for (let b = 0; b <= 5; b++) {
    banks[b] = readPal(get, off + b * 32, 16);
  }
  return banks;
}

export interface NamingOpts { root?: string; sha1?: string }

const CACHE_SUB = "gba/naming";

export const ExtractNaming = {
  CACHE_SUB,
  get ASSETS(): Record<string, any> { return Versions.NAMING; },

  /** [ok, err] */
  // Lua: extract_naming.lua:172
  run(rom: RomInput | undefined, cache: Cache | undefined, opts?: NamingOpts): [boolean, string?] {
    opts = opts ?? {};
    const data = romBytes(rom);
    if (data === undefined) return [false, "no rom bytes"];
    const get = makeGet(data);
    const A = Versions.NAMING;
    const root = opts.root ?? ("data/generated/" + ExtractNaming.CACHE_SUB);
    const out = (name: string): string => root + "/" + name;

    const [menuGfx] = decompress(get, A.menu_gfx);
    const menuBanks = loadMenuPalBanks(get, A.menu_pal);
    const rivalPal = readPal(get, A.rival_pal, 16);

    const [bgMap] = decompress(get, A.background_map);
    const [kbUpper] = decompress(get, A.keyboard_upper_map);
    const [kbLower] = decompress(get, A.keyboard_lower_map);
    const [kbSym] = decompress(get, A.keyboard_symbols_map);

    const bgPng = bake4bppMap(menuGfx, menuBanks, bgMap, 32, 20, 0, false);
    if (bgPng) {
      // Visible 240×160 (map is 256×160)
      write(cache, out("bg.png"), cropPng(bgPng, 256, 160, 0, 0, 240, 160) ?? bgPng);
    }

    // Keyboard page chrome: full blue frame + SELECT tab (not just WIN_KB).
    // Opaque bbox ≈ (17,75)-(189,151); crop (16,72) 176×80 keeps the border/tab
    // that page_swap sprites sit on (pret BG1/BG2 keyboard_* tilemaps).
    const KB_X = 16, KB_Y = 72, KB_W = 176, KB_H = 80;
    const bakeKb = (map: Bytes, name: string): void => {
      const full = bake4bppMap(menuGfx, menuBanks, map, 32, 20, 0, false);
      if (!full) return;
      const cropped = cropPng(full, 256, 160, KB_X, KB_Y, KB_W, KB_H);
      write(cache, out(name), cropped ?? full);
    };
    bakeKb(kbUpper, "kb_upper.png");
    bakeKb(kbLower, "kb_lower.png");
    bakeKb(kbSym, "kb_symbols.png");

    const btnPal = menuBanks[4] ?? menuBanks[0]!;
    const curPal = menuBanks[5] ?? menuBanks[0]!;

    const sheet = (off: number, nbytes: number, cols: number, rows: number, pal: Pal, fname: string,
      transparent0?: boolean, keep?: Record<number, boolean>): void => {
      const tiles = readRaw(get, off, nbytes);
      const png = bake4bppSheet(tiles, pal, cols, rows, transparent0 !== false, keep);
      if (png) write(cache, out(fname), png);
    };

    const glowPal: Pal = {};
    for (let i = 0; i <= 15; i++) glowPal[i] = 0;
    glowPal[14] = 0x7FFF; // White mask for index 14 (tinted by naming screen cursor pulse)

    const pillBorder: Record<number, boolean> = { 14: true };
    sheet(A.back_button, 0x1E0, 5, 3, btnPal, "back_button.png");
    sheet(A.ok_button, 0x1E0, 5, 3, btnPal, "ok_button.png");
    sheet(A.page_swap_frame, 0x280, 5, 4, glowPal, "page_swap_button_glow.png", true, pillBorder);
    sheet(A.back_button, 0x1E0, 5, 3, glowPal, "back_button_glow.png", true, pillBorder);
    sheet(A.ok_button, 0x1E0, 5, 3, glowPal, "ok_button_glow.png", true, pillBorder);
    sheet(A.page_swap_frame, 0x280, 5, 4, btnPal, "page_swap_frame.png");
    sheet(A.page_swap_button, 0x100, 4, 2, menuBanks[1] ?? btnPal, "page_swap_button.png");
    sheet(A.page_swap_button, 0x100, 4, 2, menuBanks[1] ?? btnPal, "page_swap_button_upper.png");
    sheet(A.page_swap_button, 0x100, 4, 2, menuBanks[2] ?? btnPal, "page_swap_button_lower.png");
    sheet(A.page_swap_button, 0x100, 4, 2, menuBanks[3] ?? btnPal, "page_swap_button_others.png");
    sheet(A.page_swap_upper, 0x60, 5, 1, btnPal, "page_swap_upper.png");
    sheet(A.page_swap_lower, 0x60, 5, 1, btnPal, "page_swap_lower.png");
    sheet(A.page_swap_others, 0x60, 5, 1, btnPal, "page_swap_others.png");
    sheet(A.input_arrow, 0x20, 1, 1, btnPal, "input_arrow.png");
    sheet(A.underscore, 0x20, 1, 1, btnPal, "underscore.png");

    // Cursor: 3× 16×16 frames (idle / squish / filled), row-major 2×2 tiles each.
    const frames = [
      readRaw(get, A.cursor, 0x80),
      readRaw(get, A.cursor_squished, 0x80),
      readRaw(get, A.cursor_filled, 0x80),
    ];
    const curStrip = encodePng(48, 16, (x, y) => {
      const fi = Math.floor(x / 16);
      const lx = mod(x, 16);
      const tiles = frames[fi];
      if (!tiles) return [0, 0, 0, 0];
      const tx = Math.floor(lx / 8), ty = Math.floor(y / 8);
      const ti = ty * 2 + tx;
      const base = ti * 32;
      const row = mod(y, 8);
      const px = mod(lx, 8);
      const byte = tiles[base + row * 4 + Math.floor(px / 2)] ?? 0;
      const idx = mod(px, 2) === 0 ? mod(byte, 16) : mod(Math.floor(byte / 16), 16);
      if (idx === 0) return [0, 0, 0, 0];
      return bgr555_to_rgba(curPal[idx] ?? 0, false);
    });
    if (curStrip) write(cache, out("cursor.png"), curStrip);

    sheet(A.rival_gfx, 0x900, 2, 36, rivalPal, "rival.png");

    const manifest = format(
      "return {\n"
      + "  version = 3,\n"
      + "  bg = %q,\n"
      + "  kb_upper = %q,\n"
      + "  kb_lower = %q,\n"
      + "  kb_symbols = %q,\n"
      + "  back_button = %q,\n"
      + "  ok_button = %q,\n"
      + "  page_swap_frame = %q,\n"
      + "  page_swap_button = %q,\n"
      + "  page_swap_button_upper = %q,\n"
      + "  page_swap_button_lower = %q,\n"
      + "  page_swap_button_others = %q,\n"
      + "  page_swap_upper = %q,\n"
      + "  page_swap_lower = %q,\n"
      + "  page_swap_others = %q,\n"
      + "  page_swap_button_glow = %q,\n"
      + "  back_button_glow = %q,\n"
      + "  ok_button_glow = %q,\n"
      + "  cursor = %q,\n"
      + "  input_arrow = %q,\n"
      + "  underscore = %q,\n"
      + "  rival = %q,\n"
      + "  kb_x = 16,\n"
      + "  kb_y = 72,\n"
      + "  kb_w = 176,\n"
      + "  kb_h = 80,\n"
      + "}\n",
      out("bg.png"), out("kb_upper.png"), out("kb_lower.png"), out("kb_symbols.png"),
      out("back_button.png"), out("ok_button.png"), out("page_swap_frame.png"),
      out("page_swap_button.png"), out("page_swap_button_upper.png"),
      out("page_swap_button_lower.png"), out("page_swap_button_others.png"),
      out("page_swap_upper.png"), out("page_swap_lower.png"), out("page_swap_others.png"),
      out("page_swap_button_glow.png"), out("back_button_glow.png"), out("ok_button_glow.png"),
      out("cursor.png"), out("input_arrow.png"),
      out("underscore.png"), out("rival.png"));
    write(cache, out("manifest.lua"), manifest);
    return [true];
  },

  // Lua: extract_naming.lua:309
  ready(cache: Cache | undefined, cacheRoot?: string): boolean {
    const root = (cacheRoot ?? "data/generated") + "/" + ExtractNaming.CACHE_SUB;
    const path = root + "/manifest.lua";
    if (cache && cache.exists) {
      return cache.exists(path);
    }
    // NOT FAITHFUL: no love.filesystem.getInfo fallback here.
    return false;
  },
};

export default ExtractNaming;
