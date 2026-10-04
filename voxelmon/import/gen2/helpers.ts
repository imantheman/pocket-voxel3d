// Shared helpers for the later Gen 2 stages: RomExtractorGen2.lua's small
// self: methods (write2bpp :310, writeCompressedPic :323, picBank :249,
// predefPal :5647, speciesName :4689, percentOf :368) and ImageWriter.lua's
// columnsToRows (:135) / deinterleave (:153), at gen1recomp bdfac727.
//
// Image paths: Brian's `assets/generated/<rel>.png` becomes the gfx key
// `<rel>` (gfxKey below). His ImageWriter.save OVERWRITES a path written
// twice; GfxBin refuses duplicate keys, so `save` keeps the FIRST image and
// ignores a later one of the same key -- only use it where the repeat
// writes are the same pixels (the cases Brian dedupes by path).

import { type GfxImage, decode2bpp, matteColor0 } from "../gfx.ts";
import type { Gen2Ctx } from "./ctx.ts";
import { type Rgb, colors } from "./palettes.ts";

/** `assets/generated/fonts/font.png` or `fonts/font.png` -> `fonts/font`. */
export function gfxKey(relative: string): string {
  return relative.replace(/^assets\/generated\//, "").replace(/\.png$/, "");
}

/** RomExtractorGen2.lua:295 save — see the file comment on repeats.
 * Returns the gfx key. */
export function save(ctx: Gen2Ctx, image: GfxImage, relative: string): string {
  const key = gfxKey(relative);
  if (!ctx.gfx.has(key)) ctx.gfx.add(key, image);
  return key;
}

/** RomExtractorGen2.lua:310 write2bpp. Returns the gfx key. */
export function write2bpp(
  ctx: Gen2Ctx,
  raw: number[],
  width: number,
  height: number,
  relative: string,
  transparent = false,
): string {
  return save(ctx, decode2bpp(raw, width, height, transparent), relative);
}

/** ImageWriter.lua:135 columnsToRows — `rgbgfx --columns` tile order
 * (column-major) back to row-major. */
export function columnsToRows(raw: number[], tilesWide: number, tilesHigh: number, bytesPerTile = 16): number[] {
  const out: number[] = new Array(raw.length);
  for (let y = 0; y < tilesHigh; y++) {
    for (let x = 0; x < tilesWide; x++) {
      const source = (x * tilesHigh + y) * bytesPerTile;
      const target = (y * tilesWide + x) * bytesPerTile;
      for (let offset = 0; offset < bytesPerTile; offset++) out[target + offset] = raw[source + offset]!;
    }
  }
  // Lua leaves holes past tilesWide*tilesHigh tiles; trim to that many.
  out.length = tilesWide * tilesHigh * bytesPerTile;
  return out;
}

/** ImageWriter.lua:153 deinterleave — undo pret's `--interleave` (8x16
 * OBJ pairs stored as consecutive tiles). */
export function deinterleave(raw: number[], width: number, bytesPerTile = 16): number[] {
  const widthTiles = width / 8;
  const numTiles = Math.floor(raw.length / bytesPerTile);
  const out: number[] = new Array(numTiles * bytesPerTile);
  for (let i = 0; i < numTiles; i++) {
    const row = Math.floor(i / widthTiles);
    const src = i * 2 - (row % 2 === 1 ? widthTiles * (row + 1) - 1 : widthTiles * row);
    for (let offset = 0; offset < bytesPerTile; offset++) {
      out[i * bytesPerTile + offset] = raw[src * bytesPerTile + offset] ?? 0;
    }
  }
  return out;
}

/** RomExtractorGen2.lua:18 FIX_PIC_BANK (engine/gfx/load_pics.asm FixPicBank). */
export const FIX_PIC_BANK: Record<number, number> = { 0x13: 0x1f, 0x14: 0x20, 0x1f: 0x2e };

/** :25 — pokecrystal engine/gfx/load_pics.asm:250 PICS_FIX; macros/data.asm
 * stores BANK(pic) - PICS_FIX flat. */
export const PICS_FIX = 0x36;

/** RomExtractorGen2.lua:249 picBank — Gold's three-entry remap, or Crystal's
 * flat `+ PICS_FIX`. */
export function picBank(stored: number, crystal = false): number {
  if (crystal) return stored + PICS_FIX;
  return FIX_PIC_BANK[stored] ?? stored;
}

/**
 * RomExtractorGen2.lua:323 writeCompressedPic — an lz3 pic, tiles x tiles,
 * columns-to-rows, white backdrop matted (flood from the border), saved.
 * Returns the whole decompressed stream (the anim's extra tiles ride past
 * the base picture).
 */
export function writeCompressedPic(ctx: Gen2Ctx, label: string, tiles: number, relative: string): number[] {
  const stream = ctx.decompressLz3Symbol(label);
  writePicStream(ctx, stream, tiles, relative);
  return stream;
}

/** The body of writeCompressedPic for a stream already in hand. */
export function writePicStream(ctx: Gen2Ctx, stream: number[], tiles: number, relative: string): string {
  const size = tiles * 8;
  const byteLength = (size * size) / 4;
  const pixels: number[] = [];
  for (let i = 0; i < byteLength; i++) pixels.push(stream[i] ?? 0);
  const rows = columnsToRows(pixels, tiles, tiles);
  return save(ctx, matteColor0(decode2bpp(rows, size, size)), relative);
}

/** RomExtractorGen2.lua:5647 predefPal — PredefPals row `index`, 4 colours. */
export function predefPal(ctx: Gen2Ctx, index: number): Rgb[] {
  const pals = ctx.symbol("PredefPals");
  return colors(ctx, pals.bank, pals.address + index * 8, 4);
}

/** RomExtractorGen2.lua:4689 speciesName — `index` is the 1-based species
 * id (dex number); a miss returns the number itself. */
export function speciesName(ctx: Gen2Ctx, index: number): string | number {
  const order = ctx.manifest.constants.speciesOrder ?? [];
  return (index >= 1 ? order[index - 1] : undefined) ?? index;
}

/** RomExtractorGen2.lua:368 percentOf — RGBDS `percent` back to 0-100. */
export function percentOf(raw: number | undefined): number {
  return Math.floor(((raw ?? 0) * 100) / 255 + 0.5);
}

/** A 1-based Lua lookup into a manifest order list: list[i - 1]. */
export function lua<T>(list: T[] | undefined, index: number): T | undefined {
  return list && index >= 1 ? list[index - 1] : undefined;
}
