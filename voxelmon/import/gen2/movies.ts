// Port of gen1recomp RomExtractorGen2.lua (bdfac727) :2493-2802
// extractCredits / extractDiploma / extractTrade, and :7416-7480
// readMagnetTrain / extractStubs: the cutscene art that is not a battle or a
// map. Gold only: CREDITS_SCENES_CRYSTAL (:2501, Pichu/Smoochum/Ditto/
// Igglybuff), Crystal's 12 credits palette sets / 3 per scene (:2570) and
// Crystal's theEndY 9 (:2543) are dropped.
//
// Every stage tolerates missing symbols the way Brian's does (`if
// self.symbols[label]`): the field is simply omitted. All images are shade
// images (gfx keys, see helpers.ts); the colours ride as data in `palettes`.

import type { Gen2Ctx } from "./ctx.ts";
import { write2bpp } from "./helpers.ts";
import { type Rgb, colors } from "./palettes.ts";

// ---------------------------------------------------------------- credits

/** RomExtractorGen2.lua:2493 CREDITS_SCENES (engine/movie/credits.asm):
 * Gold's four mon scenes, 3/3/3/4 frames of 4x4 tiles. */
export const CREDITS_SCENES = [
  { species: "BELLOSSOM", label: "CreditsBellossomGFX", frames: 3 },
  { species: "TOGEPI", label: "CreditsTogepiGFX", frames: 3 },
  { species: "ELEKID", label: "CreditsElekidGFX", frames: 3 },
  { species: "SENTRET", label: "CreditsSentretGFX", frames: 4 },
];
// :2501 CREDITS_SCENES_CRYSTAL: Crystal only -- dropped.
const CREDITS_BORDER_TILES = 9; // :2507
const CREDITS_THEEND_TILES = 16; // :2508
/** :2572 — Gold's CreditsPalettes is 6 sets, one per scene (Crystal 12/3). */
const CREDITS_PALETTE_SETS = 6;

export interface CreditsScene {
  species: string;
  /** gfx key "credits/<species>": 32 wide, 32*frames tall (frames stacked). */
  image: string;
  frames: number;
  width: number;
  height: number;
}

/**
 * RomExtractorGen2.lua:2510 extractCredits. credits.json:
 * - generation 2, source;
 * - border "credits/border" (72x8 strip, 9 tiles), borderTiles 9, and the
 *   1-BASED strip columns borderTopTile 5 / borderBottomTile 1 /
 *   borderFillTile 9 (DrawCreditsBorder's start ids);
 * - theEnd "credits/theend" (64x16), theEndX 6, theEndY 8, theEndWidth 8;
 * - scenes: 4 CreditsScene (only when all four labels exist);
 * - palettes: 6 sets x 4 [r,g,b], palettesPerScene 1.
 */
export function extractCredits(ctx: Gen2Ctx): Record<string, unknown> {
  const { rom } = ctx;
  const data: Record<string, unknown> = {
    generation: 2,
    source: "ROM:CreditsBorderGFX + Credits<Mon>GFX + TheEndGFX + CreditsPalettes",
  };

  if (ctx.location("CreditsBorderGFX")) {
    const border = ctx.symbol("CreditsBorderGFX");
    data.border = write2bpp(
      ctx,
      rom.bytes(border.bank, border.address, CREDITS_BORDER_TILES * 16),
      CREDITS_BORDER_TILES * 8,
      8,
      "credits/border.png",
    );
    data.borderTiles = CREDITS_BORDER_TILES;
    data.borderTopTile = 5;
    data.borderBottomTile = 1;
    data.borderFillTile = 9;
  }

  if (ctx.location("TheEndGFX")) {
    const theEnd = ctx.symbol("TheEndGFX");
    data.theEnd = write2bpp(ctx, rom.bytes(theEnd.bank, theEnd.address, CREDITS_THEEND_TILES * 16), 64, 16, "credits/theend.png");
    // :2540 Credits_TheEnd: hlcoord 6, 8, eight tiles a row (Crystal: 6, 9).
    data.theEndX = 6;
    data.theEndWidth = 8;
    data.theEndY = 8;
  }

  const scenes: CreditsScene[] = [];
  for (const scene of CREDITS_SCENES) {
    if (!ctx.location(scene.label)) continue;
    const sym = ctx.symbol(scene.label);
    const raw = rom.bytes(sym.bank, sym.address, scene.frames * 16 * 16);
    const image = write2bpp(ctx, raw, 32, 32 * scene.frames, `credits/${scene.species.toLowerCase()}.png`);
    scenes.push({ species: scene.species, image, frames: scene.frames, width: 32, height: 32 });
  }
  // :2564 — all or nothing.
  if (scenes.length === CREDITS_SCENES.length) data.scenes = scenes;

  if (ctx.location("CreditsPalettes")) {
    const pal = ctx.symbol("CreditsPalettes");
    const palettes: Rgb[][] = [];
    for (let set = 0; set < CREDITS_PALETTE_SETS; set++) palettes.push(colors(ctx, pal.bank, pal.address + set * 8, 4));
    data.palettes = palettes;
    data.palettesPerScene = 1;
  }

  return { credits: data };
}

// ---------------------------------------------------------------- diploma

// :2608 — engine/events/diploma.asm PlaceDiplomaOnScreen.
const DIPLOMA_TILES = 112;
const DIPLOMA_SHEET_TILES = 16;
const DIPLOMA_SCREEN_W = 20;
const DIPLOMA_SCREEN_H = 18;
const DIPLOMA_PALETTE_SETS = 8;

/** Brian's pad-with-0 / table.remove-to-length (:2623, :2739, :7106). */
function fitLength(bytes: number[], length: number): number[] {
  const out = bytes.slice(0, length);
  while (out.length < length) out.push(0);
  return out;
}

/**
 * RomExtractorGen2.lua:2613 extractDiploma. diploma.json:
 * - generation 2, source;
 * - image "diploma/diploma" (128x56, DiplomaGFX lz3, row-major), tiles 112,
 *   sheetTiles 16;
 * - page1: 360 tile ids, flat row-major (row * 20 + column), width 20,
 *   height 18;
 * - palettes: 8 sets x 4 [r,g,b] (set 0 is the one the screen draws).
 */
export function extractDiploma(ctx: Gen2Ctx): Record<string, unknown> {
  const data: Record<string, unknown> = {
    generation: 2,
    source: "ROM:DiplomaGFX + DiplomaPage1Tilemap + DiplomaPalettes",
  };

  if (ctx.location("DiplomaGFX")) {
    const pixels = fitLength(ctx.decompressLz3Symbol("DiplomaGFX"), DIPLOMA_TILES * 16);
    data.image = write2bpp(
      ctx,
      pixels,
      DIPLOMA_SHEET_TILES * 8,
      (DIPLOMA_TILES / DIPLOMA_SHEET_TILES) * 8,
      "diploma/diploma.png",
    );
    data.tiles = DIPLOMA_TILES;
    data.sheetTiles = DIPLOMA_SHEET_TILES;
  }

  if (ctx.location("DiplomaPage1Tilemap")) {
    const sym = ctx.symbol("DiplomaPage1Tilemap");
    data.page1 = ctx.rom.bytes(sym.bank, sym.address, DIPLOMA_SCREEN_W * DIPLOMA_SCREEN_H);
    data.width = DIPLOMA_SCREEN_W;
    data.height = DIPLOMA_SCREEN_H;
  }

  if (ctx.location("DiplomaPalettes")) {
    const pal = ctx.symbol("DiplomaPalettes");
    const palettes: Rgb[][] = [];
    for (let set = 0; set < DIPLOMA_PALETTE_SETS; set++) palettes.push(colors(ctx, pal.bank, pal.address + set * 8, 4));
    data.palettes = palettes;
  }

  return { diploma: data };
}

// ---------------------------------------------------------------- trade

// :2717 — engine/movie/trade_animation.asm, gfx/trade/.
const TRADE_BASE_TILE = 0x31;
const TRADE_SCENE_TILES = 49;
const TRADE_SHEET_TILES = 7;
const TRADE_GAMEBOY_W = 6;
const TRADE_GAMEBOY_H = 8;
const TRADE_TUBE_W = 12;
const TRADE_TUBE_H = 3;
const TRADE_BALL_TILES = 6;
const TRADE_POOF_TILES = 12;
const TRADE_BULGE_TILES = 2;
const TRADE_BUBBLE_TILES = 4;

export interface TradeTilemap {
  width: number;
  height: number;
  /** flat row-major tile ids (row * width + column); id - baseTile indexes
   * the scene sheet. */
  tiles: number[];
}

export interface TradeSheet {
  /** gfx key "trade/<name>"; OBJ sheets have colour 0 transparent. */
  image: string;
  tiles: number;
  sheetTiles: number;
}

/**
 * RomExtractorGen2.lua:2727 extractTrade. trade.json:
 * - generation 2, source;
 * - image "trade/scene" (56x56 BG sheet, TradeGameBoyLZ, 49 tiles),
 *   tiles 49, sheetTiles 7, baseTile 0x31 (tilemap id - baseTile = sheet
 *   index);
 * - gameBoy {width 6, height 8, tiles}, tube {width 12, height 3, tiles};
 * - ball/poof/bulge/bubble TradeSheet (OBJ, colour 0 transparent):
 *   ball 8x48 (6 tiles, 1 across), poof 16x48 (12, 2), bulge 8x16 (2, 1),
 *   bubble 16x16 (4, 2);
 * - arrows {image "trade/arrows" 8x16 BG (index 0 right/sends, 1 left/
 *   receives), tiles 2, sheetTiles 1}.
 */
export function extractTrade(ctx: Gen2Ctx): Record<string, unknown> {
  const { rom } = ctx;
  const data: Record<string, unknown> = {
    generation: 2,
    source:
      "ROM:TradeGameBoyLZ + TradeGameBoyTilemap + TradeLinkTubeTilemap" +
      " + TradeBallGFX + TradePoofGFX + TradeCableGFX + TradeBubbleGFX" +
      " + TradeArrowRightGFX + TradeArrowLeftGFX",
  };

  if (ctx.location("TradeGameBoyLZ")) {
    const pixels = fitLength(ctx.decompressLz3Symbol("TradeGameBoyLZ"), TRADE_SCENE_TILES * 16);
    data.image = write2bpp(ctx, pixels, TRADE_SHEET_TILES * 8, TRADE_SHEET_TILES * 8, "trade/scene.png");
    data.tiles = TRADE_SCENE_TILES;
    data.sheetTiles = TRADE_SHEET_TILES;
    data.baseTile = TRADE_BASE_TILE;
  }

  // :2755 — flat, in TradeAnim_CopyBoxFromDEtoHL's row order.
  const tilemap = (label: string, width: number, height: number): TradeTilemap | undefined => {
    if (!ctx.location(label)) return undefined;
    const sym = ctx.symbol(label);
    return { width, height, tiles: rom.bytes(sym.bank, sym.address, width * height) };
  };
  data.gameBoy = tilemap("TradeGameBoyTilemap", TRADE_GAMEBOY_W, TRADE_GAMEBOY_H);
  data.tube = tilemap("TradeLinkTubeTilemap", TRADE_TUBE_W, TRADE_TUBE_H);

  // :2769 — object sheets: colour 0 transparent.
  const sprite = (label: string, tiles: number, across: number, relative: string): TradeSheet | undefined => {
    if (!ctx.location(label)) return undefined;
    const sym = ctx.symbol(label);
    const raw = rom.bytes(sym.bank, sym.address, tiles * 16);
    const image = write2bpp(ctx, raw, across * 8, (tiles / across) * 8, relative, true);
    return { image, tiles, sheetTiles: across };
  };
  data.ball = sprite("TradeBallGFX", TRADE_BALL_TILES, 1, "trade/ball.png");
  data.poof = sprite("TradePoofGFX", TRADE_POOF_TILES, 2, "trade/poof.png");
  data.bulge = sprite("TradeCableGFX", TRADE_BULGE_TILES, 1, "trade/bulge.png");
  data.bubble = sprite("TradeBubbleGFX", TRADE_BUBBLE_TILES, 2, "trade/bubble.png");

  // :2786 — two one-tile BG symbols in one sheet: right (sends), left.
  if (ctx.location("TradeArrowRightGFX") && ctx.location("TradeArrowLeftGFX")) {
    const right = ctx.symbol("TradeArrowRightGFX");
    const left = ctx.symbol("TradeArrowLeftGFX");
    const raw = [...rom.bytes(right.bank, right.address, 16), ...rom.bytes(left.bank, left.address, 16)];
    data.arrows = { image: write2bpp(ctx, raw, 8, 16, "trade/arrows.png"), tiles: 2, sheetTiles: 1 };
  }

  // Absent optional fields are omitted, never null.
  for (const key of Object.keys(data)) if (data[key] === undefined) delete data[key];
  return { trade: data };
}

// ---------------------------------------------------------------- magnet train / stubs

// :7428 — engine/events/magnet_train.asm.
const MAGNET_TRAIN_BG_ROWS = 18; // SCREEN_HEIGHT
const MAGNET_TRAIN_FG_WIDTH = 20; // SCREEN_WIDTH
const MAGNET_TRAIN_FG_ROWS = 4;

export interface MagnetTrain {
  source: string;
  /** MagnetTrainBGTiles: 36 ids, two per screen row (2x18, row-major),
   * repeated across the screen by DrawMagnetTrain's .FillAlt. */
  bgTiles: number[];
  /** MagnetTrainTilemap: 80 ids, 20x4 row-major, over BG rows 6-9. Ids
   * index TILESET_TRAIN_STATION's tiles; no graphics of its own. */
  tilemap: number[];
  width: number;
  rows: number;
}

/** RomExtractorGen2.lua:7432 readMagnetTrain — undefined when the manifest
 * lacks either label. */
export function readMagnetTrain(ctx: Gen2Ctx): MagnetTrain | undefined {
  if (!(ctx.location("MagnetTrainBGTiles") && ctx.location("MagnetTrainTilemap"))) return undefined;
  const bg = ctx.symbol("MagnetTrainBGTiles");
  const fg = ctx.symbol("MagnetTrainTilemap");
  return {
    source: "ROM:MagnetTrainBGTiles + MagnetTrainTilemap",
    bgTiles: ctx.rom.bytes(bg.bank, bg.address, MAGNET_TRAIN_BG_ROWS * 2),
    tilemap: ctx.rom.bytes(fg.bank, fg.address, MAGNET_TRAIN_FG_WIDTH * MAGNET_TRAIN_FG_ROWS),
    width: MAGNET_TRAIN_FG_WIDTH,
    rows: MAGNET_TRAIN_FG_ROWS,
  };
}

/** RomExtractorGen2.lua:7462 extractStubs — field.json: {generation 2,
 * source (the stub note), magnetTrain?: MagnetTrain}. */
export function extractStubs(ctx: Gen2Ctx): Record<string, unknown> {
  const field: Record<string, unknown> = {
    generation: 2,
    source: "Gold Phase 2 stub -- not yet extracted, see docs/gold-phase1.md",
  };
  const magnetTrain = readMagnetTrain(ctx);
  if (magnetTrain) field.magnetTrain = magnetTrain;
  return { field };
}
