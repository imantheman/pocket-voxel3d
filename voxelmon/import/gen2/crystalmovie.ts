// Crystal's intro movie and title screen: port of gen1recomp
// src/import/CrystalMovie.lua (bdfac727, MIT) -- pokecrystal
// engine/movie/intro.asm:1678-1777 and engine/movie/title.asm:364-374.
// RomExtractorGen2's extractIntro/extractTitle hand over here when the
// edition is Crystal (:5687, :2046).
//
// DEVIATION from Brian, as in title.ts (the gfx format stores shades, not
// RGB): where he `colorize`s an image through a palette and saves the RGB
// result, the SHADE image goes out under the same key and the palettes ride
// as data:
//   screenPalettes  the 8 TitleScreenPalettes BG palettes
//   screenPalMap    360 ints, 20x18 row-major, 0-based palette per cell
//                   (Brian's bgPalAt, engine/movie/title.asm:39-85)
//   suicunePalette  BG palette 0 (Brian tints every Suicune frame with it)
//   gemPalette      OBJ palette 0 (the crystal gem)
//   copyrightPalette  PREDEFPAL_GAMEFREAK_LOGO_BG (the card's colours)
// Colour of a pixel = palette[shade], exactly Brian's colorize. The *Gray
// keys are the same shade images (his gray PNGs are these images).

import { GfxImage, TRANSPARENT, decode2bpp } from "../gfx.ts";
import type { Gen2Ctx } from "./ctx.ts";
import { save, write2bpp } from "./helpers.ts";
import { type Rgb, colors } from "./palettes.ts";

const TILE_BYTES = 16;
const SHEET_TILES = 16;
/** vBGMap tilemaps and attrmaps are one full 32x32 map (intro.asm:1611-1628). */
const MAP_BYTES = 1024;

function padTiles(raw: number[], count: number): number[] {
  const length = count * TILE_BYTES;
  raw.length = Math.min(raw.length, length);
  while (raw.length < length) raw.push(0);
  return raw;
}

/** Lay `count` tiles of `source` (from tile `from`) over `target` at tile `at`. */
function overlayTiles(target: number[], source: number[], at: number, from: number, count: number): number[] {
  for (let offset = 0; offset < count * TILE_BYTES; offset++) {
    target[at * TILE_BYTES + offset] = source[from * TILE_BYTES + offset] ?? 0;
  }
  return target;
}

const blankTiles = (count: number): number[] => new Array<number>(count * TILE_BYTES).fill(0);

/** Sheets are 16 tiles a row so tile id N is (N % 16, N / 16)
 * (data/sprite_anims/oam.asm:120-136). Colour 0 transparent. */
function writeSheet(ctx: Gen2Ctx, raw: number[], count: number, relative: string): string {
  padTiles(raw, count);
  const rows = Math.ceil(count / SHEET_TILES);
  padTiles(raw, rows * SHEET_TILES);
  return write2bpp(ctx, raw, SHEET_TILES * 8, rows * 8, relative, true);
}

function readMap(ctx: Gen2Ctx, label: string): number[] {
  const bytes = ctx.decompressLz3Symbol(label);
  bytes.length = Math.min(bytes.length, MAP_BYTES);
  while (bytes.length < MAP_BYTES) bytes.push(0);
  return bytes;
}

/** 16 palettes: 8 BG then 8 OBJ (intro.asm:123-130). */
function readPalettes(ctx: Gen2Ctx, label: string): { bg: Rgb[][]; obj: Rgb[][] } {
  const symbol = ctx.symbol(label);
  const flat = colors(ctx, symbol.bank, symbol.address, 64);
  const bg: Rgb[][] = [];
  const obj: Rgb[][] = [];
  for (let pal = 0; pal < 8; pal++) {
    bg.push(flat.slice(pal * 4, pal * 4 + 4));
    obj.push(flat.slice((pal + 8) * 4, (pal + 8) * 4 + 4));
  }
  return { bg, obj };
}

function readColors(ctx: Gen2Ctx, label: string, count: number): Rgb[] {
  const symbol = ctx.symbol(label);
  return colors(ctx, symbol.bank, symbol.address, count);
}

/** CrystalMovie.lua:79 extractIntro. */
export function extractCrystalIntro(ctx: Gen2Ctx): Record<string, unknown> {
  const out: Record<string, any> = {
    generation: 2,
    layout: "crystal",
    source: "ROM:CrystalIntro (engine/movie/intro.asm)",
  };
  const lz = (label: string): number[] => ctx.decompressLz3Symbol(label);

  const unowns = padTiles(lz("IntroUnownsGFX"), 128);
  const grassSym = ctx.symbol("IntroGrass4GFX");
  const grass4 = ctx.rom.bytes(grassSym.bank, grassSym.address, TILE_BYTES);

  const unownsPath = writeSheet(ctx, [...unowns], 128, "intro/unowns_tiles.png");
  const pulsePath = writeSheet(ctx, lz("IntroPulseGFX"), 16, "intro/pulse_sprites.png");
  const backgroundPath = writeSheet(ctx, lz("IntroBackgroundGFX"), 128, "intro/background_tiles.png");
  const runPath = writeSheet(ctx, lz("IntroSuicuneRunGFX"), 192, "intro/suicune_run_sprites.png");
  const pichuPath = writeSheet(ctx, lz("IntroPichuWooperGFX"), 128, "intro/pichu_wooper_sprites.png");

  // IntroScene15: jump BG at vTiles2 plus IntroGrass4GFX at vTiles1 tile 0,
  // BG id $80 (intro.asm:744-753)
  const jump = blankTiles(256);
  overlayTiles(jump, lz("IntroSuicuneJumpGFX"), 0, 0, 128);
  overlayTiles(jump, grass4, 0x80, 0, 1);
  const jumpPath = writeSheet(ctx, jump, 256, "intro/suicune_jump_tiles.png");

  // the same grass tile is the SUICUNE_AWAY object's sheet (oam.asm:136)
  const unownBack = blankTiles(144);
  overlayTiles(unownBack, lz("IntroUnownBackGFX"), 0, 0, 48);
  overlayTiles(unownBack, grass4, 0x80, 0, 1);
  const unownBackPath = writeSheet(ctx, unownBack, 144, "intro/unown_back_sprites.png");

  // IntroScene17 loads 255 tiles from vTiles1, so BG id $80 is close tile 0
  // and ids wrap through $00-$7e (intro.asm:825-828)
  const closeRaw = padTiles(lz("IntroSuicuneCloseGFX"), 255);
  const close = blankTiles(256);
  for (let id = 0; id < 256; id++) {
    const from = (id + 128) % 256;
    if (from < 255) overlayTiles(close, closeRaw, id, from, 1);
  }
  const closePath = writeSheet(ctx, close, 256, "intro/suicune_close_tiles.png");

  // IntroScene19: suicune_back at vTiles2, the Unown ring at vTiles1, grass
  // over vTiles1 tile $7f = BG id $ff (intro.asm:890-901)
  const back = blankTiles(256);
  overlayTiles(back, lz("IntroSuicuneBackGFX"), 0, 0, 128);
  overlayTiles(back, unowns, 128, 0, 128);
  overlayTiles(back, grass4, 0xff, 0, 1);
  const backPath = writeSheet(ctx, back, 256, "intro/suicune_back_tiles.png");

  const crystalUnownsPath = writeSheet(ctx, lz("IntroCrystalUnownsGFX"), 32, "intro/crystal_unowns_tiles.png");

  // Intro_RustleGrass swaps 4 tiles at vTiles2 $09 through grass1/2/3
  // (intro.asm:1521-1547): one 16-tile row, frame f at f*4
  const grassStrip = blankTiles(16);
  ["IntroGrass1GFX", "IntroGrass2GFX", "IntroGrass3GFX"].forEach((label, frame) => {
    const sym = ctx.symbol(label);
    overlayTiles(grassStrip, ctx.rom.bytes(sym.bank, sym.address, 4 * TILE_BYTES), frame * 4, 0, 4);
  });
  out.grassFrames = writeSheet(ctx, grassStrip, 16, "intro/grass_anim.png");

  const unownPals = readPalettes(ctx, "IntroUnownsPalette");
  const backgroundPals = readPalettes(ctx, "IntroBackgroundPalette");
  const suicunePals = readPalettes(ctx, "IntroSuicunePalette");
  const closePals = readPalettes(ctx, "IntroSuicuneClosePalette");
  const crystalUnownsPals = readPalettes(ctx, "IntroCrystalUnownsPalette");

  const act = (
    tiles: string, sprites: string | undefined, tilemapLabel: string, attrmapLabel: string,
    palettes: { bg: Rgb[][]; obj: Rgb[][] },
  ): Record<string, unknown> => ({
    tiles,
    sprites,
    tilemap: readMap(ctx, tilemapLabel),
    attrmap: readMap(ctx, attrmapLabel),
    palettes,
  });

  out.acts = {
    unownA: act(unownsPath, pulsePath, "IntroUnownATilemap", "IntroUnownAAttrmap", unownPals),
    unownHI: act(unownsPath, pulsePath, "IntroUnownHITilemap", "IntroUnownHIAttrmap", unownPals),
    unowns: act(unownsPath, pulsePath, "IntroUnownsTilemap", "IntroUnownsAttrmap", unownPals),
    background: act(backgroundPath, runPath, "IntroBackgroundTilemap", "IntroBackgroundAttrmap", backgroundPals),
    suicuneJump: act(jumpPath, unownBackPath, "IntroSuicuneJumpTilemap", "IntroSuicuneJumpAttrmap", suicunePals),
    suicuneClose: act(closePath, undefined, "IntroSuicuneCloseTilemap", "IntroSuicuneCloseAttrmap", closePals),
    suicuneBack: act(backPath, unownBackPath, "IntroSuicuneBackTilemap", "IntroSuicuneBackAttrmap", suicunePals),
    crystalUnowns: act(crystalUnownsPath, undefined, "IntroCrystalUnownsTilemap", "IntroCrystalUnownsAttrmap", crystalUnownsPals),
  };
  // IntroScene7/10 load pichu_wooper into VRAM bank 1 (intro.asm:340-348);
  // OAM_BANK1 picks this sheet
  out.acts.background.sprites1 = pichuPath;

  const toWhite: Rgb[][] = [];
  out.fades = {
    toWhite,
    unownAppear: readColors(ctx, "Intro_Scene20_AppearUnown.pal1", 4),
    unownAppear2: readColors(ctx, "Intro_Scene20_AppearUnown.pal2", 4),
    wordFast: readColors(ctx, "Intro_FadeUnownWordPals.FastFadePalettes", 16),
    wordSlow: readColors(ctx, "Intro_FadeUnownWordPals.SlowFadePalettes", 16),
  };
  // Intro_Scene24_ApplyPaletteFade steps 8 rows of one palette each (:1155-1189)
  const fade = readColors(ctx, "Intro_Scene24_ApplyPaletteFade.FadePals", 32);
  for (let row = 0; row < 8; row++) toWhite.push(fade.slice(row * 4, row * 4 + 4));

  return { intro: out };
}

// -------------------------------------------------------------- title screen

/** :225 tilesFrom2bpp — every tile with colour 0 transparent. */
function tilesFrom2bpp(raw: number[]): GfxImage[] {
  const tiles: GfxImage[] = [];
  for (let offset = 0; offset + TILE_BYTES <= raw.length; offset += TILE_BYTES) {
    tiles.push(decode2bpp(raw.slice(offset, offset + TILE_BYTES), 8, 8, true));
  }
  return tiles;
}

/** :236 blitTile — the opaque pixels only. */
function blitTile(target: GfxImage, tile: GfxImage | undefined, tx: number, ty: number): void {
  if (!tile) return;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const v = tile.get(x, y);
      if (v !== TRANSPARENT) target.set(tx + x, ty + y, v);
    }
  }
}

/** :265 — engine/movie/splash.asm:20-30 sets SCGB_GAMEFREAK_LOGO before the
 * copyright card: gfx/sgb/predef.pal:79 PREDEFPAL_GAMEFREAK_LOGO_BG. */
const COPYRIGHT_TILES = 29;
const COPYRIGHT_BG: Rgb[] = [[0, 0, 0], [66, 90, 90], [173, 173, 173], [255, 255, 255]];

/** :271 — data/copyright.asm at hlcoord 2, 7 (intro_menu.asm:1315-1326). */
const COPYRIGHT_LINES = [
  [0x60, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x6b, 0x6c],
  [0x60, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x6d, 0x6e, 0x6f, 0x70, 0x71, 0x72, 0x7a, 0x7b, 0x7c],
  [0x60, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x7b, 0x7c],
];

/** :280 extractCopyright — the card, on the backdrop (shade 0 = COPYRIGHT_BG[0]). */
function extractCopyright(ctx: Gen2Ctx): { copyright: string; copyrightSplash: string } {
  const symbol = ctx.symbol("CopyrightGFX");
  const raw = ctx.rom.bytes(symbol.bank, symbol.address, COPYRIGHT_TILES * TILE_BYTES);
  const copyright = write2bpp(ctx, raw, COPYRIGHT_TILES * 8, 8, "title/copyright.png");
  const tiles = tilesFrom2bpp(raw);
  const splash = new GfxImage(160, 144, 0);
  COPYRIGHT_LINES.forEach((line, row) => {
    line.forEach((id, column) => blitTile(splash, tiles[id - 0x60], (2 + column) * 8, (7 + row) * 8));
  });
  return { copyright, copyrightSplash: save(ctx, splash, "title/copyright_splash.png") };
}

/** :303 bgPalAt — _TitleScreen's ByteFills (title.asm:39-85), 0-based. */
export function crystalTitlePalAt(col: number, row: number): number {
  if (row === 9 && col >= 5 && col <= 15) return 1;
  if (row >= 3 && row <= 4) return 2;
  if (row === 5) return 3;
  if (row === 6) return 4;
  if (row === 7) return 5;
  if (row >= 8 && row <= 9) return 6;
  if (row === 17) return 7;
  return 0;
}

/** CrystalMovie.lua:298 extractTitle. */
export function extractCrystalTitle(ctx: Gen2Ctx): Record<string, unknown> {
  // TitleLogoGFX decompresses to vTiles1: BG id $80 is logo tile 0 (title.asm:91-94)
  const logoTiles = tilesFrom2bpp(ctx.decompressLz3Symbol("TitleLogoGFX"));
  // TitleSuicuneGFX fills vTiles4-5: bank-1 ids $80-$ff then $00-$7f (:24-27)
  const suicuneTiles = tilesFrom2bpp(ctx.decompressLz3Symbol("TitleSuicuneGFX"));
  const gemTiles = tilesFrom2bpp(ctx.decompressLz3Symbol("TitleCrystalGFX"));
  const pals = readPalettes(ctx, "TitleScreenPalettes");

  const shade = new GfxImage(160, 144, TRANSPARENT);
  // DrawTitleGraphic lays 7 rows of 20 running tiles from d=$80 (:107-112,275-302)
  for (let row = 0; row < 7; row++) {
    for (let col = 0; col < 20; col++) blitTile(shade, logoTiles[row * 20 + col], col * 8, (row + 3) * 8);
  }
  // copyright line: 13 tiles from d=$c on the window's row 0, at hWY = $88
  for (let index = 0; index < 13; index++) blitTile(shade, logoTiles[128 + 12 + index], (3 + index) * 8, 17 * 8);
  const screen = save(ctx, shade, "title/crystal_screen.png");

  const logo = new GfxImage(160, 56, TRANSPARENT);
  for (let y = 0; y < 56; y++) for (let x = 0; x < 160; x++) logo.set(x, y, shade.get(x, 24 + y));
  const image = save(ctx, logo, "title/crystal_logo.png");
  const mark = new GfxImage(88, 8, TRANSPARENT);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 88; x++) mark.set(x, y, shade.get(40 + x, 72 + y));
  const wordmark = save(ctx, mark, "title/crystal_wordmark.png");

  // LoadSuicuneFrame: 6 rows of 8 tiles, row stride 16; frame bases
  // $80/$88/$00/$08 (:245-273)
  const suicuneFrames: string[] = [];
  [0x00, 0x08, 0x80, 0x88].forEach((base, i) => {
    const frame = new GfxImage(64, 48, TRANSPARENT);
    for (let row = 0; row < 6; row++) {
      for (let col = 0; col < 8; col++) blitTile(frame, suicuneTiles[base + row * 16 + col], col * 8, row * 8);
    }
    suicuneFrames.push(save(ctx, frame, `title/crystal_suicune_${i + 1}.png`));
  });

  // InitializeBackground: five 48x16 strips of six 8x16 OBJs (:304-338)
  const gemImage = new GfxImage(48, 80, TRANSPARENT);
  for (let strip = 0; strip < 5; strip++) {
    for (let slot = 0; slot < 6; slot++) {
      const tile = strip * 12 + slot * 2;
      blitTile(gemImage, gemTiles[tile], slot * 8, strip * 16);
      blitTile(gemImage, gemTiles[tile + 1], slot * 8, strip * 16 + 8);
    }
  }
  const gem = save(ctx, gemImage, "title/crystal_gem.png");
  const { copyright, copyrightSplash } = extractCopyright(ctx);

  const unit = (c: Rgb): number[] => [c[0] / 255, c[1] / 255, c[2] / 255];
  const screenPalMap: number[] = [];
  for (let row = 0; row < 18; row++) for (let col = 0; col < 20; col++) screenPalMap.push(crystalTitlePalAt(col, row));

  return {
    title: {
      generation: 2,
      layout: "crystal_title",
      source: "ROM:TitleSuicuneGFX + TitleLogoGFX + TitleCrystalGFX + TitleScreenPalettes + CopyrightGFX",
      screen,
      screenGray: screen,
      image,
      wordmark,
      suicune: suicuneFrames[0],
      suicuneFrames,
      suicuneFramesGray: suicuneFrames,
      // hlcoord 6, 12 (title.asm:252) in screen pixels
      suicuneX: 48,
      suicuneY: 96,
      // SuicuneFrameIterator advances every 8 frames (:217-243)
      suicuneEvery: 8,
      gem,
      gemGray: gem,
      copyright,
      copyrightSplash,
      copyrightBackdrop: unit(COPYRIGHT_BG[0]!),
      copyrightInk: unit(COPYRIGHT_BG[3]!),
      // strip 0 starts at OAM (64, -$22), stops at screen (56, 6) (:306-311,340-362)
      gemX: 56,
      gemY: 6,
      gemFromY: -50,
      gemStep: 2,
      // TitleScreenEntrance (intro_menu.asm:1078-1111)
      entrance: { scx: 112, step: 4, lines: 80, hideBelow: 136 },
      entranceSfx: "Sfx_TitleScreenEntrance",
      // TitleScreenTimer (intro_menu.asm:1125-1136)
      timeoutFrames: 73 * 60 + 36,
      sky: unit(pals.bg[0]![0]!),
      below: unit(pals.bg[0]![0]!),
      palettes: { bg: pals.bg, obj: pals.obj },
      // DEVIATION (file comment): the colours Brian baked into the images
      screenPalettes: pals.bg,
      screenPalMap,
      suicunePalette: pals.bg[0],
      gemPalette: pals.obj[0],
      copyrightPalette: COPYRIGHT_BG,
    },
  };
}
