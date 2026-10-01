// The Gold screen's tile pages: every Gold graphic the Gen 2 screens draw,
// cut into 8x8 tiles, de-duplicated, and packed 1024 to a 256x256 page.
//
// The Gold screen (crates/pocketvoxel-core/src/lcd.rs) names tiles by a
// 16-bit id that stays fixed for the whole run, through banks: page k of
// these holds ids k*1024 .. k*1024+count. An image becomes a grid of ids --
// the manifest below -- so a ported screen draws "fonts/font" or
// "battle/front/chikorita" without ever loading VRAM.
//
// Pixels are raw colours 0-3 (the screen's palettes colour them); the
// importer's transparent 0xff becomes colour 0, which is what an object
// treats as clear and a map cell shows as its palette's lightest colour --
// the hardware's own rules.
//

import { ATLAS_KIND } from "../../contracts/spec/voxel-spec.ts";
import type { PageDef } from "./atlas.ts";
import type { GenData } from "./data.ts";

export const LCD_PAGE_TILES = 1024;
/** Tile id of a solid tile of colour c (0-3); 0 is also the blank tile. */
export const LCD_SOLID = [0, 1, 2, 3] as const;
const PAGE_PX = 256;

/**
 * Where each image's tiles are: key -> [wTiles, hTiles, start0, len0,
 * start1, len1, ...], the image's tile ids row-major as runs of
 * consecutive ids (most images are one run; repeats break it).
 */
export type LcdGfxManifest = Record<string, number[]>;

export interface LcdTiles {
  pages: PageDef[];
  /** Tiles on each page (the last is partly used). */
  counts: number[];
  gfx: LcdGfxManifest;
  /** Unique tiles over all pages. */
  tiles: number;
}

/**
 * The gfx keys the Gold screen draws: every Gold graphic. That includes the
 * map tilesets -- the overworld is voxels, but screens still draw from them
 * (the magnet train rides through tilesets/train_station's tiles) -- which
 * cost three pages after de-duplication.
 */
export function lcdKeys(gen: Pick<GenData, "gfx">): string[] {
  return Object.keys(gen.gfx).sort();
}

export function buildLcdTiles(gen: Pick<GenData, "gfx" | "gfxBin">, keys = lcdKeys(gen)): LcdTiles {
  const ids = new Map<string, number>();
  const tiles: Uint8Array[] = [];
  // ids 0-3 are solid tiles of colours 0-3 (LCD_SOLID): what a filled
  // rectangle draws with, and id 0 doubles as the blank tile
  for (let c = 0; c < 4; c++) {
    const solid = new Uint8Array(64).fill(c);
    ids.set(key64(solid), c);
    tiles.push(solid);
  }
  const gfx: LcdGfxManifest = {};
  for (const key of keys) {
    const e = gen.gfx[key]!;
    const tw = Math.ceil(e.w / 8);
    const th = Math.ceil(e.h / 8);
    const runs: number[] = [tw, th];
    let runStart = -1;
    let runLen = 0;
    for (let ty = 0; ty < th; ty++) {
      for (let tx = 0; tx < tw; tx++) {
        const t = new Uint8Array(64);
        for (let y = 0; y < 8; y++) {
          const py = ty * 8 + y;
          if (py >= e.h) continue;
          for (let x = 0; x < 8; x++) {
            const px = tx * 8 + x;
            if (px >= e.w) continue;
            const v = gen.gfxBin[e.off + py * e.w + px]!;
            t[y * 8 + x] = v === 0xff ? 0 : v & 3;
          }
        }
        const k = key64(t);
        let id = ids.get(k);
        if (id === undefined) {
          id = tiles.length;
          ids.set(k, id);
          tiles.push(t);
        }
        if (runLen > 0 && id === runStart + runLen) {
          runLen++;
        } else {
          if (runLen > 0) runs.push(runStart, runLen);
          runStart = id;
          runLen = 1;
        }
      }
    }
    if (runLen > 0) runs.push(runStart, runLen);
    gfx[key] = runs;
  }
  if (tiles.length > 0xffff) throw new Error(`Gold screen: ${tiles.length} tiles overflow 16-bit ids`);
  const pages: PageDef[] = [];
  const counts: number[] = [];
  const cols = PAGE_PX / 8;
  for (let first = 0; first < tiles.length; first += LCD_PAGE_TILES) {
    const n = Math.min(LCD_PAGE_TILES, tiles.length - first);
    // rows only as tall as the page's tiles need, rounded to a power of two
    // (the GPU wants power-of-two textures)
    const rows = Math.ceil(n / cols);
    let h = 8;
    while (h < rows * 8) h *= 2;
    const lin = new Uint8Array(PAGE_PX * h);
    for (let i = 0; i < n; i++) {
      const t = tiles[first + i]!;
      const ox = (i % cols) * 8;
      const oy = Math.floor(i / cols) * 8;
      for (let y = 0; y < 8; y++) lin.set(t.subarray(y * 8, y * 8 + 8), (oy + y) * PAGE_PX + ox);
    }
    pages.push({ w: PAGE_PX, h, kind: ATLAS_KIND.pics, frames: [lin], name: `lcd/${pages.length}` });
    counts.push(n);
  }
  return { pages, counts, gfx, tiles: tiles.length };
}

function key64(t: Uint8Array): string {
  // four colours pack two bits a pixel: 16 bytes, as a string
  let s = "";
  for (let i = 0; i < 64; i += 4) s += String.fromCharCode(t[i]! | (t[i + 1]! << 2) | (t[i + 2]! << 4) | (t[i + 3]! << 6));
  return s;
}

/** The tile ids of an image, row-major, from its manifest entry. */
export function lcdImageTiles(entry: readonly number[]): { w: number; h: number; ids: number[] } {
  const ids: number[] = [];
  for (let i = 2; i + 1 < entry.length; i += 2) for (let k = 0; k < entry[i + 1]!; k++) ids.push(entry[i]! + k);
  return { w: entry[0]!, h: entry[1]!, ids };
}
