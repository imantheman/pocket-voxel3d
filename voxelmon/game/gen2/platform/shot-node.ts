// Bun-only: see the Gold screen without a 3DS. Builds the cooked tile pages
// straight from the importer's graphics (the same buildLcdTiles the cook
// runs), hands the tile manifest to Assets, and renders an Lcd's current
// frame to a PNG -- holes shown as a checkerboard, where the world would be.

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { loadGen } from "../../../cook/data.ts";
import { buildLcdTiles, LCD_PAGE_TILES, type LcdTiles } from "../../../cook/gen2lcd.ts";
import { Assets } from "../shared/render/Assets.ts";
import { LCD_H, LCD_HOLE, LCD_W, type LcdState, renderLcd } from "./lcd.ts";
import { GOLD_GEN_DIR } from "./data-node.ts";

let tiles: LcdTiles | null = null;

/** Cook the tile pages once and give Assets their manifest. */
export function useGoldTiles(dir = GOLD_GEN_DIR): LcdTiles {
  if (!tiles) {
    tiles = buildLcdTiles(loadGen(dir));
    Assets.setManifest(tiles.gfx);
  }
  return tiles;
}

/** A tile id's raw colour at (x, y). */
export function tilePixel(t: LcdTiles, id: number, x: number, y: number): number {
  const page = t.pages[Math.floor(id / LCD_PAGE_TILES)];
  if (!page) return 0;
  const i = id % LCD_PAGE_TILES;
  return page.frames[0]![(Math.floor(i / 32) * 8 + y) * 256 + (i % 32) * 8 + x]! & 3;
}

/** The frame as RGBA, `scale` pixels per Game Boy pixel. */
export function lcdRgba(s: LcdState, scale = 1): Uint8Array {
  const t = useGoldTiles();
  const fb = renderLcd(s, (id, x, y) => tilePixel(t, id, x, y));
  const w = LCD_W * scale;
  const out = new Uint8Array(w * LCD_H * scale * 4);
  for (let y = 0; y < LCD_H * scale; y++) {
    for (let x = 0; x < w; x++) {
      const v = fb[Math.floor(y / scale) * LCD_W + Math.floor(x / scale)]!;
      const o = (y * w + x) * 4;
      if (v === LCD_HOLE) {
        const c = ((x >> 3) + (y >> 3)) & 1 ? 0x70 : 0x50;
        out[o] = c;
        out[o + 1] = c + 0x10;
        out[o + 2] = c + 0x30;
      } else {
        const c555 = s.colours[v]!;
        const e = (n: number): number => ((n & 31) << 3) | ((n & 31) >> 2);
        out[o] = e(c555);
        out[o + 1] = e(c555 >> 5);
        out[o + 2] = e(c555 >> 10);
      }
      out[o + 3] = 255;
    }
  }
  return out;
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function encodePng(w: number, h: number, rgba: Uint8Array): Uint8Array {
  const raw = new Uint8Array((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  }
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const png = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    png.set(p, at);
    at += p.length;
  }
  return png;
}

/** Write the Lcd frame to `path` as a PNG. */
export function shotLcd(s: LcdState, path: string, scale = 3): void {
  writeFileSync(path, encodePng(LCD_W * scale, LCD_H * scale, lcdRgba(s, scale)));
}
