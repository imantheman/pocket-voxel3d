// Port of gen1recomp src/import/gba/extract_intro.lua (GPLv3 + additional terms; see LICENSE.md).
// Extract FRLG intro / title assets into firered cache for Game3 boot UI.
//
// Port notes:
// - The ROM comes in as the revised ROM bytes (RevisionView.forImports /
//   rom.raw): a Uint8Array, a byte string, or the Lua's shim { data = ... }
//   with either inside (RomExtractorGen3:runIntroAudio passes the shim).
// - Byte tables the Lua builds 1-based (decompressed tiles/maps, RGBA
//   tables, map buffers) are 0-based here: Lua `t[k + 1]` reads `t[k]`.
//   Palettes keep the Lua's 0-based integer keys.
// - The Lua's encodePng returns PNG bytes, and the composite/crop paths
//   decode those bytes again (love.filesystem.newFileData + newImageData).
//   Here encodePng returns the ImageData itself and the decode reads its
//   pixels; PNG bytes are made where a file is written. The round trip is
//   lossless RGBA8, so the pixels are the same.

import { Lz77 } from "./lz77.ts";
import { Versions } from "./versions.ts";
import { GameVersion } from "./game_version.ts";
import { ImageData } from "./imagedata.ts";
import { format, mod, tostring } from "./lua.ts";
import type { Cache } from "./cache.ts";

type Pal = Record<number, number>;
type Bytes = ArrayLike<number>;
type Rgba = [number, number, number, number];
/** What encodePng returns: the image (the Lua's PNG byte string). */
type Png = ImageData;
export type RomInput = Uint8Array | string | { data?: Uint8Array | string };

// Lua: extract_intro.lua:10
function write(cache: Cache | undefined, path: string, data: string | Png): boolean {
  const body = typeof data === "string" ? data : data.encode("png").bytes;
  if (cache && cache.write) {
    return cache.write(path, body);
  }
  // NOT FAITHFUL: the Lua falls back to love.filesystem.write (the save
  // directory); there is none here.
  return false;
}

// Lua: extract_intro.lua:20
function romBytes(rom: RomInput | undefined): Uint8Array | string | undefined {
  if (typeof rom === "string" || rom instanceof Uint8Array) return rom;
  if (rom !== null && typeof rom === "object") {
    if (typeof rom.data === "string" || rom.data instanceof Uint8Array) return rom.data;
  }
  return undefined;
}

// Lua: extract_intro.lua:28
function makeGet(data: Uint8Array | string): (i: number) => number {
  if (typeof data === "string") return (i) => (i >= 0 && i < data.length ? data.charCodeAt(i) : 0);
  return (i) => data[i] ?? 0;
}

// Lua: extract_intro.lua:34 -- [bytes (0-based), len]
function decompress(get: (i: number) => number, off: number): [Uint8Array, number] {
  const [out] = Lz77.decompress(get, off);
  return [out, out.length];
}

// Lua: extract_intro.lua:44
function readPal(get: (i: number) => number, off: number, count: number): Pal {
  const pal: Pal = {};
  for (let i = 0; i <= count - 1; i++) {
    const lo = get(off + i * 2);
    const hi = get(off + i * 2 + 1);
    pal[i] = lo + hi * 256;
  }
  return pal;
}

// Lua: extract_intro.lua:54
function bgr555_to_rgba(c: number | undefined, transparent0: boolean): Rgba {
  c = mod(c ?? 0, 32768);
  if (transparent0 && c === 0) return [0, 0, 0, 0];
  const r5 = mod(c, 32);
  const g5 = mod(Math.floor(c / 32), 32);
  const b5 = mod(Math.floor(c / 1024), 32);
  return [Math.floor(r5 * 255 / 31 + 0.5),
    Math.floor(g5 * 255 / 31 + 0.5),
    Math.floor(b5 * 255 / 31 + 0.5),
    255];
}

// Lua: extract_intro.lua:66
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

// Lua: extract_intro.lua:81
function isMagenta(r: number, g: number, b: number): boolean {
  return r === 255 && g === 0 && b === 255;
}

/** 64×96 Oak-speech portrait (8bpp tiles, 32-color pal, idx & 0x1F).
 * Color 0 + magenta are transparent so the oak_speech_bg shows through. */
// Lua: extract_intro.lua:87
function bakePortraitPng(tiles: Bytes, pal: Pal): Png | undefined {
  const W = 64, H = 96;
  return encodePng(W, H, (x, y) => {
    const tx = Math.floor(x / 8), ty = Math.floor(y / 8);
    const ti = ty * 8 + tx;
    const base = ti * 64;
    const idx = tiles[base + mod(y, 8) * 8 + mod(x, 8)] ?? 0;
    const li = mod(idx, 32);
    if (li === 0) return [0, 0, 0, 0];
    const c = pal[li] ?? 0;
    const [r, g, b] = bgr555_to_rgba(c, false);
    if (isMagenta(r, g, b)) return [0, 0, 0, 0];
    return [r, g, b, 255];
  });
}

/** Sequential 4bpp tile sheet (no tilemap). */
// Lua: extract_intro.lua:104
function bake4bppSheetPng(tiles: Bytes, pal: Pal, cols: number, rows: number, transparent0: boolean): Png | undefined {
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
    if (transparent0 && idx === 0) return [0, 0, 0, 0];
    const [r, g, b] = bgr555_to_rgba(pal[idx] ?? 0, false);
    if (isMagenta(r, g, b)) return [0, 0, 0, 0];
    return [r, g, b, 255];
  });
}

/** 4bpp tiles + u16 tilemap → RGBA screen (mapW×mapH tiles).
 * `pal` is either 16 colors (indices 0..15) or 64+ for multi-bank
 * (entry bits 12..15 select bank; color = pals[bank*16 + idx]).
 * screenSize: 0 = 32x32/linear, 1 = 64x32 (horizontal blocks), 2 = 32x64 (vertical blocks). */
// Lua: extract_intro.lua:127
function bake4bppMapPng(tiles: Bytes, pal: Pal, map: Bytes, mapW: number, mapH: number,
  transparent0: boolean, screenSize?: number): Png | undefined {
  const tileCount = Math.floor(tiles.length / 32);
  const multi = pal[16] !== undefined || pal[32] !== undefined;
  const W = mapW * 8, H = mapH * 8;
  return encodePng(W, H, (x, y) => {
    const tx = Math.floor(x / 8), ty = Math.floor(y / 8);
    let mi: number; // Lua's mi - 1 (0-based)
    if (screenSize === 2) {
      const block = Math.floor(ty / 32);
      const subY = mod(ty, 32);
      mi = (block * 1024 + subY * 32 + tx) * 2;
    } else if (screenSize === 1) {
      const block = Math.floor(tx / 32);
      const subX = mod(tx, 32);
      mi = (block * 1024 + ty * 32 + subX) * 2;
    } else {
      mi = (ty * mapW + tx) * 2;
    }
    const entry = (map[mi] ?? 0) + (map[mi + 1] ?? 0) * 256;
    const tid = mod(entry, 1024);
    const hflip = mod(Math.floor(entry / 1024), 2) === 1;
    const vflip = mod(Math.floor(entry / 2048), 2) === 1;
    const pbank = mod(Math.floor(entry / 4096), 16);
    if (tid >= tileCount) return [0, 0, 0, 0];
    const sx = hflip ? (7 - mod(x, 8)) : mod(x, 8);
    const sy = vflip ? (7 - mod(y, 8)) : mod(y, 8);
    const base = tid * 32;
    const byte = tiles[base + sy * 4 + Math.floor(sx / 2)] ?? 0;
    const idx = mod(sx, 2) === 0 ? mod(byte, 16) : mod(Math.floor(byte / 16), 16);
    if (transparent0 && idx === 0) return [0, 0, 0, 0];
    let c: number;
    if (multi) {
      c = pal[pbank * 16 + idx] ?? pal[idx] ?? 0;
    } else {
      c = pal[idx] ?? 0;
    }
    const [r, g, b] = bgr555_to_rgba(c, false);
    if (isMagenta(r, g, b)) return [0, 0, 0, 0];
    return [r, g, b, 255];
  });
}

/** Separate Title Screen Copyright and Press Start layers cleanly from ROM.
 * Press Start uses indices 1..5 of pal bank 15.
 * Copyright notice uses indices 7..15. */
// Lua: extract_intro.lua:172
function bakeTitleLayers(tiles: Bytes, pal: Pal, map: Bytes, mapW: number, mapH: number): [Png | undefined, Png | undefined] {
  const tileCount = Math.floor(tiles.length / 32);
  const W = mapW * 8, H = mapH * 8;
  const copyPng = encodePng(W, H, (x, y) => {
    const tx = Math.floor(x / 8), ty = Math.floor(y / 8);
    const mi = (ty * mapW + tx) * 2;
    const entry = (map[mi] ?? 0) + (map[mi + 1] ?? 0) * 256;
    const tid = mod(entry, 1024);
    const hflip = mod(Math.floor(entry / 1024), 2) === 1;
    const vflip = mod(Math.floor(entry / 2048), 2) === 1;
    if (tid >= tileCount) return [0, 0, 0, 0];
    const sx = hflip ? (7 - mod(x, 8)) : mod(x, 8);
    const sy = vflip ? (7 - mod(y, 8)) : mod(y, 8);
    const base = tid * 32;
    const byte = tiles[base + sy * 4 + Math.floor(sx / 2)] ?? 0;
    const idx = mod(sx, 2) === 0 ? mod(byte, 16) : mod(Math.floor(byte / 16), 16);
    if (idx === 0 || (idx >= 1 && idx <= 5)) return [0, 0, 0, 0];
    const [r, g, b] = bgr555_to_rgba(pal[idx] ?? 0, false);
    return [r, g, b, 255];
  });

  const pressPng = encodePng(W, H, (x, y) => {
    const tx = Math.floor(x / 8), ty = Math.floor(y / 8);
    const mi = (ty * mapW + tx) * 2;
    const entry = (map[mi] ?? 0) + (map[mi + 1] ?? 0) * 256;
    const tid = mod(entry, 1024);
    const hflip = mod(Math.floor(entry / 1024), 2) === 1;
    const vflip = mod(Math.floor(entry / 2048), 2) === 1;
    if (tid >= tileCount) return [0, 0, 0, 0];
    const sx = hflip ? (7 - mod(x, 8)) : mod(x, 8);
    const sy = vflip ? (7 - mod(y, 8)) : mod(y, 8);
    const base = tid * 32;
    const byte = tiles[base + sy * 4 + Math.floor(sx / 2)] ?? 0;
    const idx = mod(sx, 2) === 0 ? mod(byte, 16) : mod(Math.floor(byte / 16), 16);
    if (idx >= 1 && idx <= 5) {
      const [r, g, b] = bgr555_to_rgba(pal[idx] ?? 0, false);
      return [r, g, b, 255];
    }
    return [0, 0, 0, 0];
  });

  return [copyPng, pressPng];
}

/** Build a 30×20 u16 screen map (as byte array, 0-based) for Controls Guide pages.
 * pret oak_speech.c case7 + ControlsGuide_LoadPage*:
 *   Fill whole BG with tile 0; color 0 of pal0 is overridden to stdpal_2[15] blue.
 *   Row 2 = red divider (tile 2); row 19 = bottom edge (tile 0xE).
 *   Page2/3: CopyToBgTilemapBufferRect overlay at (1,3) 5×16 (button icons).
 * TopBar is a WINDOW with PIXEL_FILL(15) same blue — not a dark navy strip. */
// Lua: extract_intro.lua:222
function buildControlsGuideMap(pageOverlay: Bytes | undefined): [number[], number, number] {
  const mapW = 30, mapH = 20;
  const map: number[] = [];
  for (let i = 1; i <= mapW * mapH * 2; i++) map[i - 1] = 0;
  const fill = (entry: number, x: number, y: number, w: number, h: number): void => {
    for (let yy = y; yy <= y + h - 1; yy++) {
      for (let xx = x; xx <= x + w - 1; xx++) {
        const mi = (yy * mapW + xx) * 2;
        map[mi] = mod(entry, 256);
        map[mi + 1] = mod(Math.floor(entry / 256), 256);
      }
    }
  };
  // Entire screen tile 0 / pal 0 (= guide blue after pal[0] override)
  fill(0x0000, 0, 0, 30, 20);
  // pret uses pal 13 (= stdpal_2) for chrome rows: 0xD00F / 0xD002 / 0xD00E
  fill(0xD00F, 0, 0, 30, 2);
  fill(0xD002, 0, 2, 30, 1);
  fill(0xD00E, 0, 19, 30, 1);
  if (pageOverlay) {
    // CopyToBgTilemapBufferRect(1, overlay, 1, 3, 5, 16)
    for (let y = 0; y <= 15; y++) {
      for (let x = 0; x <= 4; x++) {
        const oi = (y * 5 + x) * 2;
        const entry = (pageOverlay[oi] ?? 0) + (pageOverlay[oi + 1] ?? 0) * 256;
        const mi = ((y + 3) * mapW + (x + 1)) * 2;
        map[mi] = mod(entry, 256);
        map[mi + 1] = mod(Math.floor(entry / 256), 256);
      }
    }
  }
  // Page 1: pret fills (1,3) 5×16 with 0x3000 to clear icons — that uses pal3
  // and draws the dark stripe. Skip on page 1 so the intro text page is uniform blue.
  return [map, mapW, mapH];
}

/** Pikachu intro: 30×18 tilemap placed at (0,2) on a 30×20 screen. */
// Lua: extract_intro.lua:259
function buildPikachuIntroMap(tm18: Bytes): [number[], number, number] {
  const mapW = 30, mapH = 20;
  const map: number[] = [];
  for (let i = 1; i <= mapW * mapH * 2; i++) map[i - 1] = 0;
  for (let y = 0; y <= 17; y++) {
    for (let x = 0; x <= 29; x++) {
      const si = (y * 30 + x) * 2;
      const di = ((y + 2) * mapW + x) * 2;
      map[di] = tm18[si] ?? 0;
      map[di + 1] = tm18[si + 1] ?? 0;
    }
  }
  return [map, mapW, mapH];
}

/** 8bpp tiles + u16 tilemap (title logo). */
// Lua: extract_intro.lua:275
function bake8bppMapPng(tiles: Bytes, pal: Pal, map: Bytes, mapW: number, mapH: number, transparent0: boolean): Png | undefined {
  const tileCount = Math.floor(tiles.length / 64);
  const W = mapW * 8, H = mapH * 8;
  return encodePng(W, H, (x, y) => {
    const tx = Math.floor(x / 8), ty = Math.floor(y / 8);
    const mi = (ty * mapW + tx) * 2;
    const entry = (map[mi] ?? 0) + (map[mi + 1] ?? 0) * 256;
    const tid = mod(entry, 1024);
    const hflip = mod(Math.floor(entry / 1024), 2) === 1;
    const vflip = mod(Math.floor(entry / 2048), 2) === 1;
    if (tid >= tileCount) return [0, 0, 0, 0];
    const sx = hflip ? (7 - mod(x, 8)) : mod(x, 8);
    const sy = vflip ? (7 - mod(y, 8)) : mod(y, 8);
    const idx = tiles[tid * 64 + sy * 8 + sx] ?? 0;
    if (transparent0 && idx === 0) return [0, 0, 0, 0];
    return bgr555_to_rgba(pal[idx] ?? 0, false);
  });
}

// Lua: extract_intro.lua:295 -- RGBA tables 0-based (Lua's o + k is o + k - 1)
function blitLayer(dst: Uint8Array, src: Uint8Array, W: number, H: number, srcW?: number): void {
  srcW = srcW ?? W;
  for (let y = 0; y <= H - 1; y++) {
    for (let x = 0; x <= W - 1; x++) {
      if (x < srcW) {
        const si = (y * srcW + x) * 4;
        const a = src[si + 3] ?? 0;
        const r = src[si] ?? 0, g = src[si + 1] ?? 0, b = src[si + 2] ?? 0;
        if (a > 0 && !(r === 0 && g === 0 && b === 0)) {
          const di = (y * W + x) * 4;
          dst[di] = r; dst[di + 1] = g; dst[di + 2] = b; dst[di + 3] = 255;
        }
      }
    }
  }
}

// Lua: extract_intro.lua:312
function pngToRgbaTable(png: Png | undefined, W: number, H: number): Uint8Array | undefined {
  // Re-decode via ImageData when available (composite path).
  // (The Lua decodes the PNG bytes; here the ImageData is read directly.)
  if (!png) return undefined;
  const id = png;
  const rgba = new Uint8Array(W * H * 4);
  for (let y = 0; y <= H - 1; y++) {
    for (let x = 0; x <= W - 1; x++) {
      const [r, g, b, a] = id.getPixel(x, y);
      const o = (y * W + x) * 4;
      rgba[o] = Math.floor(r * 255 + 0.5);
      rgba[o + 1] = Math.floor(g * 255 + 0.5);
      rgba[o + 2] = Math.floor(b * 255 + 0.5);
      rgba[o + 3] = Math.floor(a * 255 + 0.5);
    }
  }
  return rgba;
}

// Lua: extract_intro.lua:331
function rgbaTableToPng(rgba: Uint8Array, W: number, H: number): Png | undefined {
  return encodePng(W, H, (x, y) => {
    const o = (y * W + x) * 4;
    return [rgba[o] ?? 0, rgba[o + 1] ?? 0, rgba[o + 2] ?? 0, rgba[o + 3] ?? 0];
  });
}

// Lua: extract_intro.lua:338
function cropPng(pngBytes: Png | undefined, srcW: number, srcH: number, x0: number, y0: number, cw: number, ch: number): Png | undefined {
  const rgba = pngToRgbaTable(pngBytes, srcW, srcH);
  if (!rgba) return undefined;
  return encodePng(cw, ch, (x, y) => {
    const sx = x0 + x, sy = y0 + y;
    if (sx < 0 || sy < 0 || sx >= srcW || sy >= srcH) {
      return [0, 0, 0, 0];
    }
    const o = (sy * srcW + sx) * 4;
    return [rgba[o] ?? 0, rgba[o + 1] ?? 0, rgba[o + 2] ?? 0, rgba[o + 3] ?? 0];
  });
}

export interface IntroOpts { root?: string; sha1?: string; introIndex?: string }
export interface IntroMeta {
  version: number;
  sha1?: string;
  assets: Record<string, string>;
  has_rom: boolean;
  note?: string;
  introIndex?: string;
}

const has = (v: unknown): boolean => v !== undefined && v !== null && v !== false;

export const ExtractIntro = {
  get ASSETS(): Record<string, any> { return Versions.INTRO; },

  // Lua: extract_intro.lua:351 -- [true, meta]
  run(rom: RomInput | undefined, cache: Cache | undefined, opts?: IntroOpts): [boolean, IntroMeta] {
    opts = opts ?? {};
    const root = opts.root ?? "data/generated/gba/intro";
    const game = (opts.sha1 !== undefined ? GameVersion.forSha1(opts.sha1) : undefined) ?? "firered";
    const leafgreen = game === "leafgreen";
    const data = romBytes(rom);
    const meta: IntroMeta = {
      version: 3,
      sha1: opts.sha1,
      assets: {},
      has_rom: data !== undefined,
    };

    if (data === undefined) {
      write(cache, root + "/meta.json",
        format('{"version":3,"sha1":"%s","has_rom":false}\n', tostring(opts.sha1 ?? "")));
      return [true, meta];
    }

    const get = makeGet(data);
    const A = Versions.INTRO;
    // love.image is always available here (the ImageData stand-in).
    const okLove = true;

    const saveAsset = (name: string, png: Png | undefined): boolean => {
      if (!png) return false;
      write(cache, root + "/" + name, png);
      meta.assets[name] = root + "/" + name;
      return true;
    };

    if (okLove) {
      // Portraits
      {
        const pal = readPal(get, A.oak_pal, 32);
        const [tiles] = decompress(get, A.oak_tiles);
        saveAsset("oak.png", bakePortraitPng(tiles, pal));
      }
      {
        const pal = readPal(get, A.red_pal, 32);
        const [tiles] = decompress(get, A.red_tiles);
        saveAsset("boy.png", bakePortraitPng(tiles, pal));
      }
      {
        const pal = readPal(get, A.leaf_pal, 32);
        const [tiles] = decompress(get, A.leaf_tiles);
        saveAsset("girl.png", bakePortraitPng(tiles, pal));
      }
      if (has(A.rival_pal) && has(A.rival_tiles)) {
        const pal = readPal(get, A.rival_pal, 32);
        const [tiles] = decompress(get, A.rival_tiles);
        saveAsset("rival.png", bakePortraitPng(tiles, pal));
      }
      {
        const pal = readPal(get, A.platform_pal, 16);
        const [tiles] = decompress(get, A.platform_tiles);
        // pret platform.png is 32×96 (3 stacked 32×32 frames); idx 0 is transparent.
        saveAsset("platform.png", bake4bppSheetPng(tiles, pal, 4, 12, true));
      }

      // Oak speech BG + Nidoran♀ + poke ball (ROM Versions.INTRO extras)
      if (has(A.oak_speech_bg_tiles) && has(A.oak_speech_bg_map)) {
        const pal = readPal(get, has(A.oak_speech_bg_pal) ? A.oak_speech_bg_pal : A.platform_pal, 16);
        const [tiles] = decompress(get, A.oak_speech_bg_tiles);
        const [map] = decompress(get, A.oak_speech_bg_map);
        saveAsset("oak_speech_bg.png", bake4bppMapPng(tiles, pal, map, 32, 20, false));
      }
      // Controls guide + Pikachu intro (shared bg_tiles, NOT oak_speech_bg)
      if (has(A.guide_bg_tiles) && has(A.guide_bg_pal)) {
        const pals = readPal(get, A.guide_bg_pal, 64);
        // pret LoadPalette(GetTextWindowPalette(2)+15, BG_PLTT_ID(0), 2):
        // force pal0[0] to stdpal_2 color 15 = RGB(0,123,197).
        let guideBlue: number;
        {
          const r5 = Math.floor(0 * 31 / 255 + 0.5);
          const g5 = Math.floor(123 * 31 / 255 + 0.5);
          const b5 = Math.floor(197 * 31 / 255 + 0.5);
          guideBlue = r5 + g5 * 32 + b5 * 1024;
        }
        pals[0] = guideBlue;
        // Icon tile "background" (pal3 index 0) matches field blue so D-Pad/A/B
        // don't sit in dark rectangles (ROM art uses idx0 as fill).
        pals[48] = guideBlue;
        // TopBar / chrome rows use BG pal 13 = GetTextWindowPalette(2) (stdpal_2).
        if (has(A.stdpal_2)) {
          const std2 = readPal(get, A.stdpal_2, 16);
          for (let i = 0; i <= 15; i++) {
            // Lua: pals[k] = std2[i] (nil would clear the slot; std2 is full)
            const v = std2[i];
            if (v === undefined) delete pals[13 * 16 + i]; else pals[13 * 16 + i] = v;
          }
        } else {
          // Fallback: synthesize stdpal_2 color 15 + a few used indices from known RGB.
          for (let i = 0; i <= 15; i++) pals[13 * 16 + i] = guideBlue;
          pals[13 * 16 + 12] = (0) + (82 * 32) + (115 * 1024); // approx idx12
          {
            const r5 = Math.floor(0 * 31 / 255 + 0.5);
            const g5 = Math.floor(82 * 31 / 255 + 0.5);
            const b5 = Math.floor(115 * 31 / 255 + 0.5);
            pals[13 * 16 + 12] = r5 + g5 * 32 + b5 * 1024;
          }
          {
            const r5 = Math.floor(0 * 31 / 255 + 0.5);
            const g5 = Math.floor(115 * 31 / 255 + 0.5);
            const b5 = Math.floor(139 * 31 / 255 + 0.5);
            pals[13 * 16 + 13] = r5 + g5 * 32 + b5 * 1024;
          }
          pals[13 * 16 + 15] = guideBlue;
          // Red for divider (stdpal_2 idx often maps via tile; use pure red)
          pals[13 * 16 + 1] = 31; // red-ish low; tile 2 uses 12/13/15
        }
        // Ensure multi-bank bake sees bank 13
        if (pals[13 * 16] === undefined) pals[13 * 16] = guideBlue;
        const [tiles] = decompress(get, A.guide_bg_tiles);
        const [map1] = buildControlsGuideMap(undefined);
        saveAsset("controls_page1.png", bake4bppMapPng(tiles, pals, map1, 30, 20, false));
        if (has(A.controls_page2_map)) {
          const overlay: number[] = [];
          for (let i = 0; i <= 159; i++) overlay[i] = get(A.controls_page2_map + i);
          const [map2] = buildControlsGuideMap(overlay);
          saveAsset("controls_page2.png", bake4bppMapPng(tiles, pals, map2, 30, 20, false));
        }
        if (has(A.controls_page3_map)) {
          const overlay: number[] = [];
          for (let i = 0; i <= 159; i++) overlay[i] = get(A.controls_page3_map + i);
          const [map3] = buildControlsGuideMap(overlay);
          saveAsset("controls_page3.png", bake4bppMapPng(tiles, pals, map3, 30, 20, false));
        }
        if (has(A.pikachu_intro_map)) {
          const [tm] = decompress(get, A.pikachu_intro_map);
          const [mapP] = buildPikachuIntroMap(tm);
          saveAsset("pikachu_intro_bg.png", bake4bppMapPng(tiles, pals, mapP, 30, 20, false));
        }
      }
      // Pikachu intro OBJ (body/ears/eyes) — pret CreateSprite stack on paper BG
      if (has(A.pikachu_pal) && has(A.pikachu_body)) {
        const pal = readPal(get, A.pikachu_pal, 16);
        const [body] = decompress(get, A.pikachu_body);
        saveAsset("pikachu_body.png", bake4bppSheetPng(body, pal, 4, 8, true));
        if (has(A.pikachu_ears)) {
          const [ears] = decompress(get, A.pikachu_ears);
          saveAsset("pikachu_ears.png", bake4bppSheetPng(ears, pal, 4, 4, true));
        }
        if (has(A.pikachu_eyes)) {
          const [eyes] = decompress(get, A.pikachu_eyes);
          // 0x80 = 4 tiles → two 16×8 frames stacked (tile offsets 0 and 2)
          saveAsset("pikachu_eyes.png", bake4bppSheetPng(eyes, pal, 2, 2, true));
        }
      }
      if (has(A.nidoran_f_tiles) && has(A.nidoran_f_pal)) {
        const [palBytes] = decompress(get, A.nidoran_f_pal);
        const pal: Pal = {};
        for (let i = 0; i <= 15; i++) {
          const lo = palBytes[i * 2] ?? 0;
          const hi = palBytes[i * 2 + 1] ?? 0;
          pal[i] = lo + hi * 256;
        }
        const [tiles] = decompress(get, A.nidoran_f_tiles);
        saveAsset("nidoran_f.png", bake4bppSheetPng(tiles, pal, 8, 8, true));
      }
      if (has(A.ball_poke_tiles) && has(A.ball_poke_pal)) {
        const [palBytes] = decompress(get, A.ball_poke_pal);
        const pal: Pal = {};
        for (let i = 0; i <= 15; i++) {
          const lo = palBytes[i * 2] ?? 0;
          const hi = palBytes[i * 2 + 1] ?? 0;
          pal[i] = lo + hi * 256;
        }
        const [tiles] = decompress(get, A.ball_poke_tiles);
        saveAsset("ball_poke.png", bake4bppSheetPng(tiles, pal, 2, 6, true));
      }

      // Title layers
      let logoPng: Png | undefined, boxPng: Png | undefined, copyPng: Png | undefined;
      {
        const pal = readPal(get, A.logo_pal, 256);
        const [tiles] = decompress(get, A.logo_tiles);
        const [map] = decompress(get, A.logo_map);
        logoPng = bake8bppMapPng(tiles, pal, map, 32, 20, true);
        saveAsset("title_logo.png", cropPng(logoPng, 256, 160, 0, 0, 240, 160) ?? logoPng);
      }
      {
        const pal = readPal(get, A.box_pal, 16);
        const [tiles] = decompress(get, A.box_tiles);
        const [map] = decompress(get, A.box_map);
        boxPng = bake4bppMapPng(tiles, pal, map, 32, 20, true);
        saveAsset("box_art_mon.png", cropPng(boxPng, 256, 160, 0, 0, 240, 160) ?? boxPng);
      }
      {
        const pal = readPal(get, A.copyright_pal, 16);
        const [tiles] = decompress(get, A.copyright_tiles);
        const [map] = decompress(get, A.copyright_map);
        const [titleCopy, titlePress] = bakeTitleLayers(tiles, pal, map, 32, 20);
        const copyCrop = cropPng(titleCopy, 256, 160, 0, 0, 240, 160) ?? titleCopy;
        const pressCrop = cropPng(titlePress, 256, 160, 0, 0, 240, 160) ?? titlePress;
        saveAsset("title_copyright.png", copyCrop);
        saveAsset("title_press_start.png", pressCrop);
        // CacheContract / boot.lua names (full-screen positioned layers).
        saveAsset("press_start.png", pressCrop);
        saveAsset("copyright_press_start.png", copyCrop);
        copyPng = titleCopy;
      }

      // Full title composite (240×160) without press-start (blinks separately).
      // CacheContract requires data/generated/gba/intro/title_screen.png.
      if (logoPng && boxPng && copyPng) {
        const W = 240, H = 160;
        const dst = new Uint8Array(W * H * 4); // Lua dst[o + k] -> dst[o + k - 1]
        for (let i = 1; i <= W * H; i++) {
          const o = (i - 1) * 4;
          dst[o] = 0; dst[o + 1] = 0; dst[o + 2] = 0; dst[o + 3] = 255;
        }
        const boxR = pngToRgbaTable(boxPng, 256, 160);
        const logoR = pngToRgbaTable(logoPng, 256, 160);
        const copyR = pngToRgbaTable(copyPng, 256, 160);
        if (boxR) blitLayer(dst, boxR, W, H, 256);
        if (logoR) blitLayer(dst, logoR, W, H, 256);
        // Copyright bars only (strip press-start band so boot can blink it)
        if (copyR) {
          for (let y = 0; y <= H - 1; y++) {
            const skipPress = y >= 124 && y < 144;
            if (!skipPress) {
              for (let x = 0; x <= W - 1; x++) {
                const si = (y * 256 + x) * 4;
                const a = copyR[si + 3] ?? 0;
                const r = copyR[si] ?? 0, g = copyR[si + 1] ?? 0, b = copyR[si + 2] ?? 0;
                if (a > 0 && !(r === 0 && g === 0 && b === 0)) {
                  const di = (y * W + x) * 4;
                  dst[di] = r; dst[di + 1] = g; dst[di + 2] = b; dst[di + 3] = 255;
                }
              }
            }
          }
        }
        saveAsset("title_screen.png", rgbaTableToPng(dst, W, H));
      }

      // Intro Cutscene Movie assets (pokefirered/src/intro.c)
      const M = Versions.INTRO_MOVIE;
      if (has(M)) {
        // Copyright Screen: 32×32 map, text already at y≈48 within the visible 160px
        // (BG0VOFS=0). Crop the GBA viewport — do NOT start at y=48 or text sits at y=0.
        if (has(M.copyright_pal) && has(M.copyright_tiles) && has(M.copyright_map)) {
          const pal = readPal(get, M.copyright_pal, 16);
          const [tiles] = decompress(get, M.copyright_tiles);
          const [map] = decompress(get, M.copyright_map);
          const copyScreen = bake4bppMapPng(tiles, pal, map, 32, 32, false, 0);
          saveAsset("intro_copyright.png", cropPng(copyScreen, 256, 256, 0, 0, 240, 160) ?? copyScreen);
        }
        // Game Freak Scene
        if (has(M.gf_bg_pal) && has(M.gf_bg_tiles) && has(M.gf_bg_map)) {
          const pal = readPal(get, M.gf_bg_pal, 16);
          const [tiles] = decompress(get, M.gf_bg_tiles);
          const [map] = decompress(get, M.gf_bg_map);
          const gfBg = bake4bppMapPng(tiles, pal, map, 32, 20, false, 0);
          saveAsset("intro_gf_bg.png", cropPng(gfBg, 256, 160, 0, 0, 240, 160) ?? gfBg);
        }
        if (has(M.gf_logo_pal) && has(M.gf_text_tiles)) {
          const pal = readPal(get, M.gf_logo_pal, 16);
          const [tiles] = decompress(get, M.gf_text_tiles);
          // 144×16 (18×2 tiles)
          saveAsset("intro_gf_text.png", bake4bppSheetPng(tiles, pal, 18, 2, true));
        }
        if (has(M.gf_logo_pal) && has(M.gf_logo_tiles)) {
          const pal = readPal(get, M.gf_logo_pal, 16);
          const [tiles] = decompress(get, M.gf_logo_tiles);
          // 32×64 (4×8 tiles)
          saveAsset("intro_gf_logo.png", bake4bppSheetPng(tiles, pal, 4, 8, true));
        }
        if (has(M.star_pal) && has(M.star_tiles)) {
          const pal = readPal(get, M.star_pal, 16);
          const [tiles] = decompress(get, M.star_tiles);
          // 16×16 (2×2 tiles)
          saveAsset("intro_star.png", bake4bppSheetPng(tiles, pal, 2, 2, true));
        }
        if (has(M.sparkles_pal) && has(M.sparkles_small_tiles)) {
          const pal = readPal(get, M.sparkles_pal, 16);
          const [tiles] = decompress(get, M.sparkles_small_tiles);
          // 16×16 (2×2 tiles)
          saveAsset("intro_sparkles_small.png", bake4bppSheetPng(tiles, pal, 2, 2, true));
        }
        if (has(M.sparkles_pal) && has(M.sparkles_big_tiles)) {
          const pal = readPal(get, M.sparkles_pal, 16);
          const [tiles] = decompress(get, M.sparkles_big_tiles);
          // 32×128 (4×16 tiles, 4 frames of 32×32)
          saveAsset("intro_sparkles_big.png", bake4bppSheetPng(tiles, pal, 4, 16, true));
        }
        if (has(M.gf_logo_pal) && has(M.presents_tiles)) {
          const pal = readPal(get, M.gf_logo_pal, 16);
          const [tiles] = decompress(get, M.presents_tiles);
          // 64×8 (8×1 tiles)
          saveAsset("intro_presents.png", bake4bppSheetPng(tiles, pal, 8, 1, true));
        }

        // Scene 1 (Grass Close-up: 32×64 tiles, screenSize=2)
        if (has(M.scene1_grass_pal) && has(M.scene1_grass_tiles) && has(M.scene1_grass_map)) {
          const pal = readPal(get, M.scene1_grass_pal, 16);
          const [tiles] = decompress(get, M.scene1_grass_tiles);
          const [map] = decompress(get, M.scene1_grass_map);
          saveAsset("intro_scene1_grass.png", bake4bppMapPng(tiles, pal, map, 32, 64, true, 2));
        }
        if (has(M.scene1_bg_pal) && has(M.scene1_bg_tiles) && has(M.scene1_bg_map)) {
          const pal = readPal(get, M.scene1_bg_pal, 16);
          const [tiles] = decompress(get, M.scene1_bg_tiles);
          const [map] = decompress(get, M.scene1_bg_map);
          saveAsset("intro_scene1_bg.png", bake4bppMapPng(tiles, pal, map, 32, 64, false, 2));
        }

        // Scene 2 (Forest Clearing & Close-ups)
        // LoadPalette(..., BG_PLTT_ID(1), 96) → hardware banks 1..3.
        if (has(M.scene2_bg_pal) && has(M.scene2_bg_tiles) && has(M.scene2_bg_map)) {
          const filePal = readPal(get, M.scene2_bg_pal, 48);
          const pal: Pal = {};
          for (let i = 0; i <= 15; i++) {
            pal[i] = 0;
            pal[16 + i] = filePal[i] ?? 0;
            pal[32 + i] = filePal[16 + i] ?? 0;
            pal[48 + i] = filePal[32 + i] ?? 0;
          }
          const [tiles] = decompress(get, M.scene2_bg_tiles);
          const [map] = decompress(get, M.scene2_bg_map);
          saveAsset("intro_scene2_bg.png", bake4bppMapPng(tiles, pal, map, 32, 64, false, 2));
        }
        if (has(M.scene2_plants_pal) && has(M.scene2_plants_tiles) && has(M.scene2_plants_map)) {
          const pal = readPal(get, M.scene2_plants_pal, 16);
          const [tiles] = decompress(get, M.scene2_plants_tiles);
          const [map] = decompress(get, M.scene2_plants_map);
          const plants = bake4bppMapPng(tiles, pal, map, 32, 20, true, 0);
          saveAsset("intro_scene2_plants.png", plants);
        }
        if (has(M.gengar_pal) && has(M.scene2_gengar_close_tiles) && has(M.scene2_gengar_close_map)) {
          const pal = readPal(get, M.gengar_pal, 16);
          const [tiles] = decompress(get, M.scene2_gengar_close_tiles);
          const [map] = decompress(get, M.scene2_gengar_close_map);
          saveAsset("intro_scene2_gengar_close.png", bake4bppMapPng(tiles, pal, map, 32, 32, true, 0));
        }
        if (has(M.scene2_nidorino_close_pal) && has(M.scene2_nidorino_close_tiles) && has(M.scene2_nidorino_close_map)) {
          const pal = readPal(get, M.scene2_nidorino_close_pal, 16);
          const [tiles] = decompress(get, M.scene2_nidorino_close_tiles);
          const [map] = decompress(get, M.scene2_nidorino_close_map);
          saveAsset("intro_scene2_nidorino_close.png", bake4bppMapPng(tiles, pal, map, 32, 32, true, 0));
        }
        if (has(M.gengar_pal) && has(M.scene2_gengar_tiles)) {
          const pal = readPal(get, M.gengar_pal, 16);
          const [tiles] = decompress(get, M.scene2_gengar_tiles);
          // 64×64 (8×8 tiles)
          saveAsset("intro_scene2_gengar.png", bake4bppSheetPng(tiles, pal, 8, 8, true));
        }
        if (has(M.nidorino_pal) && has(M.scene2_nidorino_tiles)) {
          const pal = readPal(get, M.nidorino_pal, 16);
          const [tiles] = decompress(get, M.scene2_nidorino_tiles);
          // 64×64 (8×8 tiles)
          saveAsset("intro_scene2_nidorino.png", bake4bppSheetPng(tiles, pal, 8, 8, true));
        }

        // Scene 3 (Fight Arena)
        // Bg pal is LoadPalette(..., BG_PLTT_ID(1), 64) → hardware banks 1..2.
        // Map entries use banks 1/2 (and 0 for empty); shift file pal into those slots.
        if (has(M.scene3_bg_pal) && has(M.scene3_bg_tiles) && has(M.scene3_bg_map)) {
          const filePal = readPal(get, M.scene3_bg_pal, 32);
          const pal: Pal = {};
          for (let i = 0; i <= 15; i++) {
            pal[i] = 0;
            pal[16 + i] = filePal[i] ?? 0;
            pal[32 + i] = filePal[16 + i] ?? 0;
          }
          const [tiles] = decompress(get, M.scene3_bg_tiles);
          const [map] = decompress(get, M.scene3_bg_map);
          const s3Bg = bake4bppMapPng(tiles, pal, map, 32, 20, false, 0);
          saveAsset("intro_scene3_bg.png", s3Bg);
        }
        if (has(M.gengar_pal) && has(M.scene3_gengar_anim_tiles) && has(M.scene3_gengar_anim_map)) {
          const pal = readPal(get, M.gengar_pal, 16);
          const [tiles] = decompress(get, M.scene3_gengar_anim_tiles);
          const [map] = decompress(get, M.scene3_gengar_anim_map);
          // screenSize=2 → 32×64 tiles (256×512), frames stacked vertically
          saveAsset("intro_scene3_gengar_anim.png", bake4bppMapPng(tiles, pal, map, 32, 64, true, 2));
        }
        if (has(M.scene3_grass_pal) && has(M.scene3_grass_tiles)) {
          const pal = readPal(get, M.scene3_grass_pal, 16);
          const [tiles] = decompress(get, M.scene3_grass_tiles);
          // 64×64 (8×8 tiles)
          saveAsset("intro_scene3_grass.png", bake4bppSheetPng(tiles, pal, 8, 8, true));
        }
        if (has(M.gengar_pal) && has(M.scene3_gengar_static_tiles)) {
          const pal = readPal(get, M.gengar_pal, 16);
          const [tiles] = decompress(get, M.scene3_gengar_static_tiles);
          // 64×192 (8×24 tiles) — 4 OAM pieces, not 3 stacked frames
          saveAsset("intro_scene3_gengar_static.png", bake4bppSheetPng(tiles, pal, 8, 24, true));
        }
        if (has(M.nidorino_pal) && has(M.scene3_nidorino_tiles)) {
          const pal = readPal(get, M.nidorino_pal, 16);
          const [tiles] = decompress(get, M.scene3_nidorino_tiles);
          // 64×320 (8×40 tiles, 5 frames of 64×64)
          saveAsset("intro_scene3_nidorino.png", bake4bppSheetPng(tiles, pal, 8, 40, true));
        }
        if (has(M.scene3_swipe_pal) && has(M.scene3_swipe_tiles)) {
          const pal = readPal(get, M.scene3_swipe_pal, 16);
          const [tiles] = decompress(get, M.scene3_swipe_tiles);
          // 32×160 (4×20 tiles): two 32×64 swipe halves
          saveAsset("intro_scene3_swipe.png", bake4bppSheetPng(tiles, pal, 4, 20, true));
        }
        if (has(M.scene3_recoil_dust_pal) && has(M.scene3_recoil_dust_tiles)) {
          const pal = readPal(get, M.scene3_recoil_dust_pal, 16);
          const [tiles] = decompress(get, M.scene3_recoil_dust_tiles);
          // 16×64 (2×8 tiles)
          saveAsset("intro_scene3_recoil_dust.png", bake4bppSheetPng(tiles, pal, 2, 8, true));
        }
      }

      // Title Screen particle effects (pokefirered/src/title_screen.c)
      const T = Versions.TITLE_EFFECTS;
      if (has(T)) {
        if (has(T.border_bg_tiles) && has(T.border_bg_map)) {
          const pal = readPal(get, A.copyright_pal, 16);
          const [tiles] = decompress(get, T.border_bg_tiles);
          const [map] = decompress(get, T.border_bg_map);
          const borderBg = bake4bppMapPng(tiles, pal, map, 32, 20, false, 0);
          saveAsset("title_border_bg.png", cropPng(borderBg, 256, 160, 0, 0, 240, 160) ?? borderBg);
        }
        if (has(T.flames_pal) && has(T.flames_tiles)) {
          const pal = readPal(get, T.flames_pal, 16);
          const [tiles] = decompress(get, T.flames_tiles);
          // 0x500 = 40 tiles → 10 frames of 16×16 (2×20)
          saveAsset("title_flames.png", bake4bppSheetPng(tiles, pal, 2, leafgreen ? 22 : 20, true));
        }
        if (leafgreen) {
          const pal = readPal(get, T.flames_pal, 16);
          const [tiles] = decompress(get, T.blank_flames_tiles);
          saveAsset("title_streak.png", bake4bppSheetPng(tiles, pal, 4, 2, true));
        }
        if (has(T.flames_pal) && has(T.slash_tiles)) {
          const pal = readPal(get, T.flames_pal, 16);
          const [tiles] = decompress(get, T.slash_tiles);
          // 64×64 (8×8 tiles)
          saveAsset("title_slash.png", bake4bppSheetPng(tiles, pal, 8, 8, true));
        }
      }
    } else {
      meta.note = "love.image unavailable; wrote text stubs only";
    }

    const assetList: string[] = [];
    for (const k of Object.keys(meta.assets)) {
      assetList.push(k);
    }
    assetList.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    write(cache, root + "/meta.json",
      format(
        '{"version":3,"sha1":"%s","has_rom":true,"assets":[%s]}\n',
        tostring(opts.sha1 ?? ""),
        assetList.map((n) => '"' + n + '"').join(",")));

    // Gen1/2-shaped index: data/generated/intro.lua points at extracted PNGs.
    const indexPath = opts.introIndex ?? "data/generated/intro.lua";
    const pathMap: [string, string][] = [
      ["oakPic", "oak.png"],
      ["playerPic", "boy.png"],
      ["playerPicFemale", "girl.png"],
      ["rivalPic", "rival.png"],
      ["platform", "platform.png"],
      ["oakSpeechBg", "oak_speech_bg.png"],
      ["controlsPage1", "controls_page1.png"],
      ["controlsPage2", "controls_page2.png"],
      ["controlsPage3", "controls_page3.png"],
      ["pikachuIntroBg", "pikachu_intro_bg.png"],
      ["pikachuBody", "pikachu_body.png"],
      ["pikachuEars", "pikachu_ears.png"],
      ["pikachuEyes", "pikachu_eyes.png"],
      ["nidoranFront", "nidoran_f.png"],
      ["ballPoke", "ball_poke.png"],
      ["titleScreen", "title_screen.png"],
      ["titleLogo", "title_logo.png"],
      ["boxArtMon", "box_art_mon.png"],
      ["pressStart", "press_start.png"],
      ["copyrightPressStart", "copyright_press_start.png"],
      ["titleBorder", "title_border_bg.png"],
      ["titleFlames", "title_flames.png"],
      ["titleStreak", "title_streak.png"],
      ["titleSlash", "title_slash.png"],
      // Intro Cutscene Assets
      ["introCopyright", "intro_copyright.png"],
      ["introGfBg", "intro_gf_bg.png"],
      ["introGfText", "intro_gf_text.png"],
      ["introGfLogo", "intro_gf_logo.png"],
      ["introStar", "intro_star.png"],
      ["introSparklesSmall", "intro_sparkles_small.png"],
      ["introSparklesBig", "intro_sparkles_big.png"],
      ["introPresents", "intro_presents.png"],
      ["introScene1Grass", "intro_scene1_grass.png"],
      ["introScene1Bg", "intro_scene1_bg.png"],
      ["introScene2Bg", "intro_scene2_bg.png"],
      ["introScene2Plants", "intro_scene2_plants.png"],
      ["introScene2GengarClose", "intro_scene2_gengar_close.png"],
      ["introScene2NidorinoClose", "intro_scene2_nidorino_close.png"],
      ["introScene2Gengar", "intro_scene2_gengar.png"],
      ["introScene2Nidorino", "intro_scene2_nidorino.png"],
      ["introScene3Bg", "intro_scene3_bg.png"],
      ["introScene3GengarAnim", "intro_scene3_gengar_anim.png"],
      ["introScene3Grass", "intro_scene3_grass.png"],
      ["introScene3GengarStatic", "intro_scene3_gengar_static.png"],
      ["introScene3Nidorino", "intro_scene3_nidorino.png"],
      ["introScene3Swipe", "intro_scene3_swipe.png"],
      ["introScene3RecoilDust", "intro_scene3_recoil_dust.png"],
    ];
    const lines: string[] = [
      "return {\n",
      "  generation = 3,\n",
      format("  version = %q,\n", game),
      '  source = "ROM:title_screen + oak_speech",\n',
    ];
    if (opts.sha1 !== undefined) {
      lines.push(format("  sha1 = %q,\n", tostring(opts.sha1)));
    }
    for (const [key, file] of pathMap) {
      if (meta.assets[file] !== undefined) {
        lines.push(format("  %s = %q,\n", key, root + "/" + file));
      }
    }
    lines.push("}\n");
    write(cache, indexPath, lines.join(""));
    meta.introIndex = indexPath;

    return [true, meta];
  },
};

export default ExtractIntro;
