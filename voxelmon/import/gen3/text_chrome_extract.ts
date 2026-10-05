// Port of gen1recomp src/import/gba/text_chrome_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// Pure ROM extractor for GBA FireRed font glyphs, widths, and text window chrome.
// Extracts:
//   1) latin_normal font (512 glyphs @ 0x1FF300, widths @ 0x207300) -> 256x512 FG/Shadow
//   2) latin_small font (512 glyphs @ 0x1EAF00, widths @ 0x1EEF00) -> 256x512 FG/Shadow
//   2b) japanese_normal (512 glyphs @ 0x207500, widths @ 0x20F500) and
//       japanese_small (512 glyphs @ 0x1EF100) -> 256x512 FG/Shadow each
//   3) down_arrows prompt icon (8 frames 16x16 @ 0x1EA14C) -> 128x16 FG
//   4) menu_message dialogue frame (18 4bpp tiles @ 0x41F1C8, stdpal_0 @ 0x471DEC) -> 48x24 RGBA
//   5) std menu frame (9 4bpp tiles @ 0x471A4C, stdpal_3 @ 0x471E4C) -> 24x24 RGBA
//   6) signpost frame (19 4bpp tiles @ 0x470B0C, stdpal_1 @ 0x471E0C) -> 40x32 RGBA
// The Lua's 1-based pixel byte tables are 0-based Uint8Arrays here; the
// returned RGBA images are byte strings, as the Lua's table.concat results.

import { Versions } from "./versions.ts";
import { OnlineUiExtract } from "./online_ui_extract.ts";
import { format, fromBytes, tonumber, tostring } from "./lua.ts";
import type { Cache } from "./cache.ts";
import type { Rom } from "./rom.ts";

type Rgb = [number, number, number];
type Tile = number[][];
export interface FontSheet { fgRgba: string; shRgba: string; width: number; height: number; widths?: Record<number, number> }
export interface Frame { rgba: string; width: number; height: number }

// Lua: text_chrome_extract.lua:24
function bgr555_to_rgb8(c: unknown): Rgb {
  const n = (tonumber(c) ?? 0) % 32768;
  const r5 = n % 32, g5 = Math.floor(n / 32) % 32, b5 = Math.floor(n / 1024) % 32;
  return [Math.floor((r5 * 255) / 31 + 0.5), Math.floor((g5 * 255) / 31 + 0.5), Math.floor((b5 * 255) / 31 + 0.5)];
}

// Lua: text_chrome_extract.lua:34
function read_pal(rom: Rom, offset: number): Record<number, Rgb> {
  const pal: Record<number, Rgb> = {};
  for (let i = 0; i <= 15; i++) {
    const b0 = rom.get(offset + i * 2) ?? 0;
    const b1 = rom.get(offset + i * 2 + 1) ?? 0;
    pal[i] = bgr555_to_rgb8(b0 + b1 * 256);
  }
  return pal;
}

// Lua: text_chrome_extract.lua:46 -- 2bpp 8x8 tile, pix[y][x] (0-based)
function unpack_tile16(rom: Rom, offset: number): Tile {
  const pix: Tile = [];
  for (let y = 0; y <= 7; y++) {
    pix[y] = [];
    for (let x = 0; x <= 7; x++) {
      const byte_i = y * 2 + (1 - Math.floor(x / 4));
      const shift = (3 - (x % 4)) * 2;
      const byte = rom.get(offset + byte_i) ?? 0;
      pix[y]![x] = Math.floor(byte / 2 ** shift) % 4;
    }
  }
  return pix;
}

/** Shared body of the Lua's per-font loops: sub-tiles {tx, ty, t} into the FG/shadow sheets. */
function blitSubTiles(fg: Uint8Array, sh: Uint8Array, sheetW: number, ox: number, oy: number,
  subTiles: { tx: number; ty: number; t: Tile }[]): void {
  for (const sub of subTiles) {
    for (let y = 0; y <= 7; y++) {
      for (let x = 0; x <= 7; x++) {
        const v = sub.t[y]![x]!;
        const pi = ((oy + sub.ty + y) * sheetW + ox + sub.tx + x) * 4;
        if (v === 1) fg.fill(255, pi, pi + 4);
        else if (v === 2) sh.fill(255, pi, pi + 4);
      }
    }
  }
}

// Lua: text_chrome_extract.lua:209 -- [fg, sh, w, h]
function decode_glyph_sheet(rom: Rom, glyphCount: number, tilesOf: (gid: number) => [number, number, number][]): [string, string, number, number] {
  const cols = 16;
  const sheetW = cols * 16, sheetH = Math.floor((glyphCount + cols - 1) / cols) * 16;
  const fg = new Uint8Array(sheetW * sheetH * 4), sh = new Uint8Array(sheetW * sheetH * 4);
  for (let gid = 0; gid <= glyphCount - 1; gid++) {
    const ox = (gid % cols) * 16;
    const oy = Math.floor(gid / cols) * 16;
    for (const sub of tilesOf(gid)) {
      const t = unpack_tile16(rom, sub[0]);
      for (let y = 0; y <= 7; y++) {
        for (let x = 0; x <= 7; x++) {
          const v = t[y]![x]!;
          if (v === 1 || v === 2) {
            const pi = ((oy + sub[2] + y) * sheetW + ox + sub[1] + x) * 4;
            const dst = v === 1 ? fg : sh;
            dst.fill(255, pi, pi + 4);
          }
        }
      }
    }
  }
  return [fromBytes(fg), fromBytes(sh), sheetW, sheetH];
}

// Lua: text_chrome_extract.lua:429
function decode_4bpp_frame(rom: Rom, offset: number, tilesW: number, tilesH: number, pal: Record<number, Rgb>, maxTiles?: number): Frame {
  const w = tilesW * 8, h = tilesH * 8;
  maxTiles = maxTiles ?? tilesW * tilesH;
  const px = new Uint8Array(w * h * 4);
  for (let ty = 0; ty <= tilesH - 1; ty++) {
    for (let tx = 0; tx <= tilesW - 1; tx++) {
      const tileIndex = ty * tilesW + tx;
      if (tileIndex < maxTiles) {
        const tileOff = offset + tileIndex * 32;
        for (let y = 0; y <= 7; y++) {
          for (let bx = 0; bx <= 3; bx++) {
            const byte = rom.get(tileOff + y * 4 + bx) ?? 0;
            const p0 = byte % 16, p1 = Math.floor(byte / 16) % 16;
            const px0 = tx * 8 + bx * 2, px1 = px0 + 1;
            const py = ty * 8 + y;
            const pi0 = (py * w + px0) * 4;
            if (p0 > 0 && pal[p0]) { const c = pal[p0]!; px[pi0] = c[0]; px[pi0 + 1] = c[1]; px[pi0 + 2] = c[2]; px[pi0 + 3] = 255; }
            else px.fill(0, pi0, pi0 + 4);
            const pi1 = (py * w + px1) * 4;
            if (p1 > 0 && pal[p1]) { const c = pal[p1]!; px[pi1] = c[0]; px[pi1 + 1] = c[1]; px[pi1 + 2] = c[2]; px[pi1 + 3] = 255; }
            else px.fill(0, pi1, pi1 + 4);
          }
        }
      }
    }
  }
  return { rgba: fromBytes(px), width: w, height: h };
}

// Lua: text_chrome_extract.lua:491
const KEYPAD_PALETTE: Rgb[] = [
  [255, 255, 255], // 0: transparent (alpha = 0)
  [255, 255, 255], // 1: white
  [98, 98, 98], // 2: dark grey (outline/shadow)
  [213, 213, 205], // 3: light grey
  [230, 8, 8], // 4: red (A button)
  [255, 189, 115], // 5: light orange
  [32, 156, 8], // 6: green (B button)
  [148, 246, 148], // 7: light green
  [49, 82, 205], // 8: blue (DPAD arrows)
  [164, 197, 246], // 9: light blue
  [0, 0, 0], // 10
  [0, 0, 0], // 11
  [0, 0, 0], // 12
  [0, 0, 0], // 13
  [0, 0, 0], // 14
  [0, 0, 0], // 15
];

// Lua: text_chrome_extract.lua:562
function format_widths_lua(widths: Record<number, number>, comment: string): string {
  const lines = [
    "-- " + tostring(comment),
    "-- Extracted directly from ROM \xe2\x80\x94 do not hand-edit.",
    "return {",
  ];
  let maxKey = 0;
  for (const k of Object.keys(widths)) if (Number(k) > maxKey) maxKey = Number(k);
  for (let i = 0; i <= maxKey; i++) {
    const comma = i < maxKey ? "," : "";
    lines.push(format("  [%d] = %d%s", i, widths[i] ?? 0, comma));
  }
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

// Lua: text_chrome_extract.lua:582
function read_ptr(rom: Rom, offset: number): number {
  let v = 0;
  for (let i = 3; i >= 0; i--) v = v * 256 + (rom.get(offset + i) ?? 0);
  return v - 0x08000000;
}

// Lua: text_chrome_extract.lua:597
function write_cache(cache: Cache, rel: string, data: string): void {
  cache.write(rel, data);
}

export const TextChromeExtract = {
  CACHE_SUB: "chrome",
  FORMAT_VERSION: 2,
  // src/braille_text.c:15
  BRAILLE_GFX: 0x46fb0c,
  BRAILLE_GLYPHS: 64,
  JAPANESE_GLYPHS: 512,
  USER_FRAMES_TABLE: 0x471e8c, // pokefirered/src/text_window_graphics.c:42
  USER_FRAME_COUNT: 10,

  // Lua: text_chrome_extract.lua:62 -- 512 glyphs, each four 8x8 2bpp tiles in a 16x16 layout
  extractLatinNormal(rom: Rom): FontSheet {
    const baseGfx = Versions.address(0x1ff300);
    const baseWidths = Versions.address(0x207300);
    const glyphCount = 512, cols = 16;
    const rows = Math.floor((glyphCount + cols - 1) / cols);
    const sheetW = cols * 16, sheetH = rows * 16;
    const fg = new Uint8Array(sheetW * sheetH * 4), sh = new Uint8Array(sheetW * sheetH * 4);
    const widths: Record<number, number> = {};
    for (let gid = 0; gid <= glyphCount - 1; gid++) {
      const gOff = baseGfx + gid * 64;
      const t0 = unpack_tile16(rom, gOff), t1 = unpack_tile16(rom, gOff + 16);
      const t2 = unpack_tile16(rom, gOff + 32), t3 = unpack_tile16(rom, gOff + 48);
      const ox = (gid % cols) * 16, oy = Math.floor(gid / cols) * 16;
      blitSubTiles(fg, sh, sheetW, ox, oy, [
        { tx: 0, ty: 0, t: t0 }, { tx: 8, ty: 0, t: t1 }, { tx: 0, ty: 8, t: t2 }, { tx: 8, ty: 8, t: t3 },
      ]);
      widths[gid] = rom.get(baseWidths + gid) ?? 6;
    }
    return { fgRgba: fromBytes(fg), shRgba: fromBytes(sh), width: sheetW, height: sheetH, widths };
  },

  // Lua: text_chrome_extract.lua:134 -- 512 glyphs, each two 8x8 2bpp tiles in an 8x16 layout
  extractLatinSmall(rom: Rom): FontSheet {
    const baseGfx = Versions.address(0x1eaf00);
    const baseWidths = Versions.address(0x1eef00);
    // pokefirered/src/text.c:1380
    const glyphCount = 512, cols = 16;
    const rows = Math.floor((glyphCount + cols - 1) / cols);
    const sheetW = cols * 16, sheetH = rows * 16;
    const fg = new Uint8Array(sheetW * sheetH * 4), sh = new Uint8Array(sheetW * sheetH * 4);
    const widths: Record<number, number> = {};
    for (let gid = 0; gid <= glyphCount - 1; gid++) {
      const gOff = baseGfx + gid * 32;
      const t0 = unpack_tile16(rom, gOff), t1 = unpack_tile16(rom, gOff + 16);
      const ox = (gid % cols) * 16, oy = Math.floor(gid / cols) * 16;
      blitSubTiles(fg, sh, sheetW, ox, oy, [{ tx: 0, ty: 0, t: t0 }, { tx: 0, ty: 8, t: t1 }]);
      widths[gid] = rom.get(baseWidths + gid) ?? 4;
    }
    return { fgRgba: fromBytes(fg), shRgba: fromBytes(sh), width: sheetW, height: sheetH, widths };
  },

  // Lua: text_chrome_extract.lua:245 (pokefirered/src/text.c:227 sFontNormalJapaneseGlyphs, :228 widths)
  extractJapaneseNormal(rom: Rom): FontSheet {
    const base = Versions.address(0x207500);
    const baseWidths = Versions.address(0x20f500);
    const [fgRgba, shRgba, w, h] = decode_glyph_sheet(rom, TextChromeExtract.JAPANESE_GLYPHS, (gid) => {
      const g = base + 0x200 * Math.floor(gid / 8) + 0x20 * (gid % 8);
      return [[g, 0, 0], [g + 0x10, 8, 0], [g + 0x100, 0, 8], [g + 0x110, 8, 8]];
    });
    const widths: Record<number, number> = {};
    for (let gid = 0; gid <= 0x118 - 1; gid++) widths[gid] = rom.get(baseWidths + gid) ?? 10;
    // text.c:1492 a Japanese space is 10px wide
    widths[0] = 10;
    return { fgRgba, shRgba, width: w, height: h, widths };
  },

  // Lua: text_chrome_extract.lua:262 (pokefirered/src/text.c:141; every glyph 8px wide, text.c:1391)
  extractJapaneseSmall(rom: Rom): FontSheet {
    const base = Versions.address(0x1ef100);
    const [fgRgba, shRgba, w, h] = decode_glyph_sheet(rom, TextChromeExtract.JAPANESE_GLYPHS, (gid) => {
      const g = base + 0x200 * Math.floor(gid / 16) + 0x10 * (gid % 16);
      return [[g, 0, 0], [g + 0x100, 0, 8]];
    });
    return { fgRgba, shRgba, width: w, height: h };
  },

  // Lua: text_chrome_extract.lua:272 (src/braille_text.c:15)
  extractBraille(rom: Rom): FontSheet & { cols: number; rows: number; glyphCount: number; glyphW: number; glyphH: number } {
    const baseGfx = Versions.address(TextChromeExtract.BRAILLE_GFX);
    const glyphCount = TextChromeExtract.BRAILLE_GLYPHS, cols = 16;
    const rows = Math.floor((glyphCount + cols - 1) / cols);
    const sheetW = cols * 16, sheetH = rows * 16;
    const fg = new Uint8Array(sheetW * sheetH * 4), sh = new Uint8Array(sheetW * sheetH * 4);
    for (let gid = 0; gid <= glyphCount - 1; gid++) {
      // src/braille_text.c:333
      const gOff = baseGfx + 512 * Math.floor(gid / 8) + 32 * (gid % 8);
      const subTiles = [
        { tx: 0, ty: 0, t: unpack_tile16(rom, gOff) },
        { tx: 8, ty: 0, t: unpack_tile16(rom, gOff + 16) },
        { tx: 0, ty: 8, t: unpack_tile16(rom, gOff + 256) },
        { tx: 8, ty: 8, t: unpack_tile16(rom, gOff + 272) },
      ];
      blitSubTiles(fg, sh, sheetW, (gid % cols) * 16, Math.floor(gid / cols) * 16, subTiles);
    }
    return {
      fgRgba: fromBytes(fg), shRgba: fromBytes(sh), width: sheetW, height: sheetH,
      cols, rows, glyphCount, glyphW: 16, glyphH: 16,
    };
  },

  // Lua: text_chrome_extract.lua:338 -- 8 frames of 16x16 (sDownArrowTiles @ 0x1EA14C)
  extractDownArrows(rom: Rom | undefined): Frame {
    const baseGfx = Versions.address(0x1ea14c);
    const sheetW = 128, sheetH = 16;
    const pal: Record<number, [number, number, number, number]> = {
      0: [0, 0, 0, 0],
      1: [0, 0, 0, 0],
      2: [48, 48, 48, 255], // dark shadow
      3: [213, 213, 205, 255], // highlight
      4: [230, 8, 8, 255], // red arrow
      5: [255, 189, 115, 255],
      6: [32, 156, 8, 255],
      7: [148, 246, 148, 255],
      8: [49, 82, 205, 255],
      9: [164, 197, 246, 255], // light blue shadow (for dark arrow)
    };
    const px = new Uint8Array(sheetW * sheetH * 4);
    for (let ty = 0; ty <= 1; ty++) {
      for (let tx = 0; tx <= 15; tx++) {
        const tileOff = baseGfx + (ty * 16 + tx) * 32;
        for (let row = 0; row <= 7; row++) {
          for (let col = 0; col <= 7; col += 2) {
            const byte = (rom ? rom.get(tileOff + row * 4 + Math.floor(col / 2)) : undefined) ?? 0;
            const p0 = byte % 16, p1 = Math.floor(byte / 16) % 16;
            const py0 = ty * 8 + row;
            const pi0 = (py0 * sheetW + tx * 8 + col) * 4;
            px.set(pal[p0] ?? pal[0]!, pi0);
            const pi1 = (py0 * sheetW + tx * 8 + col + 1) * 4;
            px.set(pal[p1] ?? pal[0]!, pi1);
          }
        }
      }
    }
    return { rgba: fromBytes(px), width: sheetW, height: sheetH };
  },

  // Lua: text_chrome_extract.lua:400 (pokefirered/src/text.c:32)
  extractTextCursor(rom: Rom | undefined): Frame {
    const baseGfx = Versions.address(0x1ea54c), basePal = Versions.address(0x3cc2e4);
    const c5 = (n: number): number => Math.floor((n % 32) * 255 / 31 + 0.5);
    const pal: Record<number, number[]> = { 0: [0, 0, 0, 0] };
    for (let i = 1; i <= 15; i++) {
      const lo = (rom ? rom.get(basePal + i * 2) : undefined) ?? 0;
      const hi = (rom ? rom.get(basePal + i * 2 + 1) : undefined) ?? 0;
      const v = lo + hi * 256;
      pal[i] = [c5(v), c5(Math.floor(v / 32)), c5(Math.floor(v / 1024)), 255];
    }
    const px = new Uint8Array(16 * 16 * 4);
    for (let t = 0; t <= 3; t++) {
      const ox = (t % 2) * 8, oy = Math.floor(t / 2) * 8;
      for (let row = 0; row <= 7; row++) {
        for (let col = 0; col <= 7; col++) {
          const byte = (rom ? rom.get(baseGfx + t * 32 + row * 4 + Math.floor(col / 2)) : undefined) ?? 0;
          const idx = col % 2 === 0 ? byte % 16 : Math.floor(byte / 16);
          px.set(pal[idx]!, ((oy + row) * 16 + ox + col) * 4);
        }
      }
    }
    return { rgba: fromBytes(px), width: 16, height: 16 };
  },

  // Lua: text_chrome_extract.lua:481
  extractMenuMessage(rom: Rom): Frame {
    const pal0 = read_pal(rom, Versions.address(0x471dec));
    return decode_4bpp_frame(rom, Versions.address(0x41f1c8), 6, 3, pal0, 18);
  },

  // Lua: text_chrome_extract.lua:486
  extractStdFrame(rom: Rom): Frame {
    const pal3 = read_pal(rom, Versions.address(0x471e4c));
    return decode_4bpp_frame(rom, Versions.address(0x471a4c), 3, 3, pal3, 9);
  },

  // Lua: text_chrome_extract.lua:510
  extractKeypadIcons(rom: Rom | undefined): Frame {
    const off: number = Versions.KEYPAD_ICONS_GFX ?? 0x1ea700;
    const w = 128, h = 32;
    const tilesX = 16, tilesY = 4;
    const get = (i: number): number => (rom && rom.get ? rom.get(i) : 0) || 0;
    const pixels = new Array<number>(w * h).fill(0);
    let tileIdx = 0;
    for (let ty = 0; ty <= tilesY - 1; ty++) {
      for (let tx = 0; tx <= tilesX - 1; tx++) {
        const tileOff = off + tileIdx * 32;
        tileIdx++;
        for (let y = 0; y <= 7; y++) {
          for (let bx = 0; bx <= 3; bx++) {
            const byte = get(tileOff + y * 4 + bx);
            const p0 = byte % 16, p1 = Math.floor(byte / 16) % 16;
            const px0 = tx * 8 + bx * 2, px1 = px0 + 1;
            const py = ty * 8 + y;
            pixels[py * w + px0] = p0;
            pixels[py * w + px1] = p1;
          }
        }
      }
    }
    const out = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const idx = pixels[i] ?? 0;
      if (idx !== 0) {
        const c = KEYPAD_PALETTE[idx] ?? [255, 255, 255];
        out[i * 4] = c[0]; out[i * 4 + 1] = c[1]; out[i * 4 + 2] = c[2]; out[i * 4 + 3] = 255;
      }
    }
    return { rgba: fromBytes(out), width: w, height: h };
  },

  // Lua: text_chrome_extract.lua:557
  extractSignpostFrame(rom: Rom): Frame {
    const pal1 = read_pal(rom, Versions.address(0x471e0c));
    return decode_4bpp_frame(rom, Versions.address(0x470b0c), 5, 4, pal1, 19);
  },

  // Lua: text_chrome_extract.lua:590
  extractUserFrame(rom: Rom, frameType: number): Frame {
    const entry = Versions.address(TextChromeExtract.USER_FRAMES_TABLE) + frameType * 8;
    const tiles = read_ptr(rom, entry);
    const pal = read_pal(rom, read_ptr(rom, entry + 4));
    return decode_4bpp_frame(rom, tiles, 3, 3, pal, 9);
  },

  // Lua: text_chrome_extract.lua:605
  run(rom: Rom, cache: Cache, opts: { cacheRoot?: string } = {}): boolean {
    const root = opts.cacheRoot ?? "data/generated/gba";
    const cDir = root + "/" + TextChromeExtract.CACHE_SUB;
    const fDir = cDir + "/fonts";

    // 1) Fonts
    const norm = TextChromeExtract.extractLatinNormal(rom);
    write_cache(cache, fDir + "/latin_normal_fg.rgba", norm.fgRgba);
    write_cache(cache, fDir + "/latin_normal_shadow.rgba", norm.shRgba);
    write_cache(cache, fDir + "/latin_widths.lua", format_widths_lua(norm.widths!, "sFontNormalLatinGlyphWidths (FireRed @ 0x207300)"));

    const small = TextChromeExtract.extractLatinSmall(rom);
    write_cache(cache, fDir + "/latin_small_fg.rgba", small.fgRgba);
    write_cache(cache, fDir + "/latin_small_shadow.rgba", small.shRgba);
    write_cache(cache, fDir + "/latin_small_widths.lua", format_widths_lua(small.widths!, "sFontSmallLatinGlyphWidths (FireRed @ 0x1EEF00)"));

    const jpn = TextChromeExtract.extractJapaneseNormal(rom);
    write_cache(cache, fDir + "/japanese_normal_fg.rgba", jpn.fgRgba);
    write_cache(cache, fDir + "/japanese_normal_shadow.rgba", jpn.shRgba);
    write_cache(cache, fDir + "/japanese_widths.lua", format_widths_lua(jpn.widths!, "sFontNormalJapaneseGlyphWidths (FireRed @ 0x20F500)"));

    const jps = TextChromeExtract.extractJapaneseSmall(rom);
    write_cache(cache, fDir + "/japanese_small_fg.rgba", jps.fgRgba);
    write_cache(cache, fDir + "/japanese_small_shadow.rgba", jps.shRgba);

    const braille = TextChromeExtract.extractBraille(rom);
    write_cache(cache, fDir + "/braille_fg.rgba", braille.fgRgba);
    write_cache(cache, fDir + "/braille_shadow.rgba", braille.shRgba);
    write_cache(cache, fDir + "/braille.lua", format(
      "return { glyphCount = %d, cols = %d, rows = %d, glyphW = %d, glyphH = %d, width = %d, height = %d }\n",
      braille.glyphCount, braille.cols, braille.rows,
      braille.glyphW, braille.glyphH, braille.width, braille.height));

    const arrows = TextChromeExtract.extractDownArrows(rom);
    write_cache(cache, fDir + "/down_arrows_fg.rgba", arrows.rgba);
    write_cache(cache, fDir + "/text_cursor.rgba", TextChromeExtract.extractTextCursor(rom).rgba);

    const kp = TextChromeExtract.extractKeypadIcons(rom);
    write_cache(cache, root + "/keypad_icons.rgba", kp.rgba);
    write_cache(cache, cDir + "/keypad_icons.rgba", kp.rgba);
    write_cache(cache, fDir + "/keypad_icons.rgba", kp.rgba);

    // 2) Window Chrome
    write_cache(cache, cDir + "/menu_message_rgba.rgba", TextChromeExtract.extractMenuMessage(rom).rgba);
    write_cache(cache, cDir + "/std_rgba.rgba", TextChromeExtract.extractStdFrame(rom).rgba);
    write_cache(cache, cDir + "/signpost_rgba.rgba", TextChromeExtract.extractSignpostFrame(rom).rgba);

    for (let i = 0; i <= TextChromeExtract.USER_FRAME_COUNT - 1; i++) {
      const user = TextChromeExtract.extractUserFrame(rom, i);
      write_cache(cache, cDir + "/user_frame_" + i + ".rgba", user.rgba);
    }

    const listRows = OnlineUiExtract.listChrome(rom, (path, data) => write_cache(cache, path, data), cDir);

    // 3) Manifest
    const manifestContent = [
      "return {",
      "  formatVersion = 1,",
      "  fonts = {",
      "    latin_normal = { width = 256, height = 512, glyphs = 512 },",
      "    latin_small = { width = 256, height = 512, glyphs = 512 },",
      "    japanese_normal = { width = 256, height = 512, glyphs = 512 },",
      "    japanese_small = { width = 256, height = 512, glyphs = 512 },",
      "    down_arrows = { width = 128, height = 16, frames = 8 },",
      "  },",
      "  frames = {",
      "    menu_message = { width = 48, height = 24, tilesW = 6, tilesH = 3 },",
      "    std = { width = 24, height = 24, tilesW = 3, tilesH = 3 },",
      "    signpost = { width = 40, height = 32, tilesW = 5, tilesH = 4 },",
      "  },",
      OnlineUiExtract.manifestRows(listRows),
      "}",
      "",
    ].join("\n");
    write_cache(cache, cDir + "/manifest.lua", manifestContent);

    return true;
  },
};

export default TextChromeExtract;
