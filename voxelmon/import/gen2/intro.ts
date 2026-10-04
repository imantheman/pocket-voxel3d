// Port of gen1recomp RomExtractorGen2.lua:5576-5747 (bdfac727): the Gold
// intro movie's data -- writeIntroSheet, introBackground, introPalettes and
// extractIntro (engine/movie/intro.asm). Crystal's branch (:5687-5689,
// CrystalMovie) is dropped: Gold only.
//
// Nothing is composed into a picture: the movie edits its BG map as it
// plays, so the tile sheets ship as 16-tile-wide sheets (tile id n at
// (n % 16, n / 16)) and the metatile/tilemap tables ship as tables, for the
// engine's port of GoldSilverIntro.lua to run the same routines over.
// Palettes are [r,g,b] 0-255 (palettes.ts colors / helpers.predefPal).

import { extractCrystalIntro } from "./crystalmovie.ts";
import type { Gen2Ctx } from "./ctx.ts";
import { predefPal, write2bpp } from "./helpers.ts";
import { type Rgb, colors } from "./palettes.ts";

/** :5576 — TILEMAP_WIDTH / 2, counted in metatiles. */
export const INTRO_TILEMAP_WIDTH = 16;
/** :5577 — four tile ids per metatile, 2x2 order. */
export const INTRO_METATILE_LENGTH = 4;
/** :5578 — tiles per sheet row. */
export const INTRO_SHEET_TILES = 16;
/** :5584-5586 */
export const INTRO_WATER_TILEMAP_ROWS = 32;
export const INTRO_GRASS_TILEMAP_ROWS = 16;
export const INTRO_WATER_FIRST_ROW = 15;
/** :5590-5592 — constants/scgb_constants.asm PREDEFPAL_*. */
const PREDEFPAL_GS_INTRO_JIGGLYPUFF_PIKACHU_BG = 56;
const PREDEFPAL_GS_INTRO_JIGGLYPUFF_PIKACHU_OB = 57;
const PREDEFPAL_GS_INTRO_STARTERS_TRANSITION = 58;
/** :5596 — OAMData_GSIntroStarter's 5x5 tiles. */
const INTRO_STARTER_TILES = 25;
/** :5599 — the starters' vTiles0 destinations. */
const INTRO_STARTER_VTILES = [0x10, 0x29, 0x42];

/** :5603 writeIntroSheet's padding: truncate/zero-pad to whole 16-tile
 * rows (at least one). Returns [bytes, rows]. */
export function introSheetBytes(pixels: number[]): [number[], number] {
  const tiles = Math.floor(pixels.length / 16);
  const rows = Math.max(1, Math.ceil(tiles / INTRO_SHEET_TILES));
  const length = rows * INTRO_SHEET_TILES * 16;
  const out = pixels.slice(0, length);
  while (out.length < length) out.push(0);
  return [out, rows];
}

/** RomExtractorGen2.lua:5603 writeIntroSheet — 128 px wide. Returns the gfx key. */
export function writeIntroSheet(ctx: Gen2Ctx, pixels: number[], relative: string, transparent = false): string {
  const [bytes, rows] = introSheetBytes(pixels);
  return write2bpp(ctx, bytes, INTRO_SHEET_TILES * 8, rows * 8, relative, transparent);
}

export interface IntroBackground {
  /** gfx key of the BG sheet (colour 0 transparent). */
  tiles: string;
  /** tilemapRows x 16 metatile indices, row-major (0-based metatile ids). */
  tilemap: number[];
  tilemapRows: number;
  /** (highest index + 1) x 4 tile ids: metatile m is meta[4m..4m+3]. */
  meta: number[];
  firstRow?: number;
  sprites?: string;
}

/**
 * RomExtractorGen2.lua:5617 introBackground — the act's sheet plus the two
 * tables Intro_Draw2x2Tiles reads. The metatile table's length comes from
 * the highest index the grid names (Brian's `1-based byte arrays` are JSON
 * arrays here: element i-1 = Lua [i]).
 */
export function introBackground(
  ctx: Gen2Ctx,
  gfxLabel: string,
  metaLabel: string,
  tilemapLabel: string,
  tilemapRows: number,
  relative: string,
): IntroBackground {
  const { rom } = ctx;
  const tiles = writeIntroSheet(ctx, ctx.decompressLz3Symbol(gfxLabel), relative, true);
  const tilemap = ctx.symbol(tilemapLabel);
  const grid: number[] = [];
  let highest = 0;
  for (let index = 0; index < tilemapRows * INTRO_TILEMAP_WIDTH; index++) {
    const value = rom.byte(tilemap.bank, tilemap.address + index);
    grid.push(value);
    if (value > highest) highest = value;
  }
  const meta = ctx.symbol(metaLabel);
  const metatiles: number[] = [];
  for (let index = 0; index < (highest + 1) * INTRO_METATILE_LENGTH; index++) {
    metatiles.push(rom.byte(meta.bank, meta.address + index));
  }
  return { tiles, tilemap: grid, tilemapRows, meta: metatiles };
}

export interface IntroPalettes {
  waterBg: Rgb[];
  waterOb: Rgb[][];
  magikarpBg: Rgb[];
  magikarpOb: Rgb[];
  grassBg: Rgb[];
  grassOb: Rgb[];
  startersOb: Rgb[];
  fireBg: Rgb[][];
}

/** RomExtractorGen2.lua:5655 introPalettes — every act's BG palette 0 (and
 * OBJ palettes); the fire act's four BG palettes are PREDEFPAL indices at
 * PalPacket_Pack + 1..4. */
export function introPalettes(ctx: Gen2Ctx): IntroPalettes {
  const waterBg = ctx.symbol("_CGB_GSIntro.ShellderLaprasBGPalette");
  const waterOb = ctx.symbol("_CGB_GSIntro.ShellderLaprasOBPals");
  const karpBg = ctx.symbol("Intro_LoadMagikarpPalettes.MagikarpBGPal");
  const karpOb = ctx.symbol("Intro_LoadMagikarpPalettes.MagikarpOBPal");
  const packet = ctx.symbol("PalPacket_Pack");
  const fireBg: Rgb[][] = [];
  for (let slot = 1; slot <= 4; slot++) fireBg.push(predefPal(ctx, ctx.rom.byte(packet.bank, packet.address + slot)));
  return {
    waterBg: colors(ctx, waterBg.bank, waterBg.address, 4),
    waterOb: [colors(ctx, waterOb.bank, waterOb.address, 4), colors(ctx, waterOb.bank, waterOb.address + 8, 4)],
    magikarpBg: colors(ctx, karpBg.bank, karpBg.address, 4),
    magikarpOb: colors(ctx, karpOb.bank, karpOb.address, 4),
    grassBg: predefPal(ctx, PREDEFPAL_GS_INTRO_JIGGLYPUFF_PIKACHU_BG),
    grassOb: predefPal(ctx, PREDEFPAL_GS_INTRO_JIGGLYPUFF_PIKACHU_OB),
    startersOb: predefPal(ctx, PREDEFPAL_GS_INTRO_STARTERS_TRANSITION),
    fireBg,
  };
}

/** :5734-5741 — lay each starter's column-major front pic (25 tiles) into
 * the OBJ stream at its vtile. Lua would leave nil holes if the stream were
 * shorter than a destination; we zero-fill them (never happens on Gold). */
export function layStarters(sprites: number[], pics: number[][]): number[] {
  const out = sprites.slice();
  pics.forEach((pic, i) => {
    const base = INTRO_STARTER_VTILES[i]! * 16;
    while (out.length < base) out.push(0);
    for (let offset = 0; offset < INTRO_STARTER_TILES * 16; offset++) out[base + offset] = pic[offset] ?? 0;
  });
  return out;
}

/**
 * RomExtractorGen2.lua:5684 extractIntro (Gold). intro.json:
 * {generation 2, source, water: IntroBackground (firstRow 15, sprites),
 * grass: IntroBackground (firstRow 0, sprites), fire: {tiles, sprites},
 * palettes: IntroPalettes}. Every sheet is a gfx key, 128 px wide, colour 0
 * transparent.
 */
export function extractIntro(ctx: Gen2Ctx): Record<string, unknown> {
  // :5685 — Crystal's intro is a different program with its own asset set
  // (pokecrystal engine/movie/intro.asm:1 CrystalIntro)
  if (ctx.crystal) return extractCrystalIntro(ctx);
  // :5693-5700 — act 1, underwater.
  const water = introBackground(ctx, "Intro_WaterGFX1", "Intro_WaterMeta", "Intro_WaterTilemap",
    INTRO_WATER_TILEMAP_ROWS, "intro/water_tiles.png");
  water.firstRow = INTRO_WATER_FIRST_ROW;
  water.sprites = writeIntroSheet(ctx, ctx.decompressLz3Symbol("Intro_WaterGFX2"), "intro/water_sprites.png", true);

  // :5702-5709 — act 2, grass.
  const grass = introBackground(ctx, "Intro_GrassGFX1", "Intro_GrassMeta", "Intro_GrassTilemap",
    INTRO_GRASS_TILEMAP_ROWS, "intro/grass_tiles.png");
  grass.firstRow = 0;
  grass.sprites = writeIntroSheet(ctx, ctx.decompressLz3Symbol("Intro_GrassGFX2"), "intro/grass_sprites.png", true);

  // :5711-5725 — act 3's BG: FireGFX1 padded/cut to $80 tiles, then FireGFX2.
  const fireTiles = ctx.decompressLz3Symbol("Intro_FireGFX1").slice(0, 0x80 * 16);
  while (fireTiles.length < 0x80 * 16) fireTiles.push(0);
  fireTiles.push(...ctx.decompressLz3Symbol("Intro_FireGFX2"));
  const fireTilesKey = writeIntroSheet(ctx, fireTiles, "intro/fire_tiles.png", true);

  // :5726-5741 — the OBJ sheet: FireGFX3 with the starters' pics over it.
  const fireSprites = layStarters(
    ctx.decompressLz3Symbol("Intro_FireGFX3"),
    ["ChikoritaFrontpic", "CyndaquilFrontpic", "TotodileFrontpic"].map((label) => ctx.decompressLz3Symbol(label)),
  );
  const fire = { tiles: fireTilesKey, sprites: writeIntroSheet(ctx, fireSprites, "intro/fire_sprites.png", true) };

  return {
    intro: {
      generation: 2,
      source: "ROM:Intro_*GFX/Tilemap/Meta",
      water,
      grass,
      fire,
      palettes: introPalettes(ctx),
    },
  };
}
