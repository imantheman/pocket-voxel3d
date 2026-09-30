// Port of gen1recomp RomExtractorGen2.lua:382-570 extractFont (bdfac727):
// the 1bpp Font page, the FontExtra page (with the Frames borders, the solid
// black/up-arrow pair and the Pokegear phone icon laid over it the way
// _LoadFontsExtra does), FontBattleExtra, the textbox Frames sheet, the Unown
// font and the map-name sign. Crystal's split black/arrow symbols
// (FontsExtra_SolidBlackGFX, FontsExtra2_UpArrowGFX, :480-492) are not in
// Gold's manifest and are dropped.
//
// The three font pages are INK sheets (Brian :382-385): black (shade 3) on
// transparent, since the text drawer multiplies by the current colour. The
// Unown font and map sign are ordinary 4-shade sheets.

import { GfxImage, TRANSPARENT, blit, decode2bpp } from "../gfx.ts";
import type { Gen2Ctx } from "./ctx.ts";
import { save, write2bpp } from "./helpers.ts";

/** :389-390 — Frames: NUM_FRAMES rows of 6 1bpp tiles (gfx/font.asm:10). */
export const TEXTBOX_FRAME_TILES = 6;
export const NUM_FRAMES = 8;
/** :423-424 — NUM_UNOWN + 1 tiles on pret's 3-wide sheet. */
const UNOWN_FONT_TILES = 27;
const UNOWN_FONT_WIDE = 3;
/** :427 */
const MAP_SIGN_TILES = 14;

/** RomExtractorGen2.lua:392 inkFrom1bpp — a set bit is black ink (3), a
 * clear bit transparent. */
export function inkFrom1bpp(raw: number[], width: number, height: number): GfxImage {
  const image = new GfxImage(width, height, TRANSPARENT);
  const tilesPerRow = width / 8;
  for (let tile = 0; tile < Math.floor(raw.length / 8); tile++) {
    const tileX = (tile % tilesPerRow) * 8;
    const tileY = Math.floor(tile / tilesPerRow) * 8;
    for (let y = 0; y < 8; y++) {
      const row = raw[tile * 8 + y]!;
      for (let x = 0; x < 8; x++) if ((row >> (7 - x)) & 1) image.set(tileX + x, tileY + y, 3);
    }
  }
  return image;
}

/** RomExtractorGen2.lua:409 inkFrom2bpp — shades 2 and 3 (Lua `r < 0.5`)
 * become black ink, 0 and 1 transparent. */
export function inkFrom2bpp(raw: number[], width: number, height: number): GfxImage {
  const shaded = decode2bpp(raw, width, height);
  const image = new GfxImage(width, height, TRANSPARENT);
  for (let i = 0; i < shaded.px.length; i++) if (shaded.px[i]! >= 2) image.px[i] = 3;
  return image;
}

/**
 * RomExtractorGen2.lua:429 extractFont. font.json: {generation 2, source,
 * image "fonts/font", imageExtra "fonts/font_extra", imageBattleExtra
 * "fonts/font_battle_extra", imageFrames "fonts/frames" (48x64: frame n is
 * row n, 0-based), frameBase 0x79, frameTiles 6, mainBase 0x80, extraBase
 * 0x60, glyphsPerRow 16, charmap (manifest fontCharmap), imageUnown?
 * "fonts/unown_font" (24x72), unownTiles 27, unownWide 3, unownBase 0x40,
 * imageMapSign? "fonts/map_entry_sign" (112x8), mapSignTiles 14,
 * mapSignBase 0x60}.
 */
export function extractFont(ctx: Gen2Ctx): Record<string, unknown> {
  const { rom } = ctx;
  const font = ctx.symbol("Font");
  const image = save(ctx, inkFrom1bpp(rom.bytes(font.bank, font.address, 128 * 8), 128, 64), "fonts/font.png");

  // :436 Extra page ($60+): FontExtra 2bpp ink, then the Frames borders.
  const extra = ctx.symbol("FontExtra");
  const extraImg = inkFrom2bpp(rom.bytes(extra.bank, extra.address, (128 * 16) / 4), 128, 16);
  const frames = ctx.symbol("Frames");
  const frameSheet = inkFrom1bpp(
    rom.bytes(frames.bank, frames.address, NUM_FRAMES * TEXTBOX_FRAME_TILES * 8),
    TEXTBOX_FRAME_TILES * 8,
    NUM_FRAMES * 8,
  );
  const imageFrames = save(ctx, frameSheet, "fonts/frames.png");
  // :450 — frame 0 still bakes into the extra page at $79-$7e.
  for (let t = 0; t < TEXTBOX_FRAME_TILES; t++) {
    const destId = 0x79 + t - 0x60;
    blit(extraImg, frameSheet, (destId % 16) * 8, Math.floor(destId / 16) * 8, t * 8, 0, 8, 8);
  }
  // :455-479 — _LoadFontsExtra writes $60-$61 from the 1bpp solid-black and
  // up-arrow pair and $62 from PokegearPhoneIconGFX; FontExtra's own tiles
  // there (unused bold letters) never show on the cart. Tolerated if absent.
  const solid = ctx.location("FontsExtra_SolidBlackAndUpArrowGFX");
  if (solid) {
    const solidImg = inkFrom1bpp(rom.bytes(solid[0], solid[1], 2 * 8), 16, 8);
    blit(extraImg, solidImg, 0, 0, 0, 0, 8, 8); // $60
    blit(extraImg, solidImg, 8, 0, 8, 0, 8, 8); // $61
  }
  const phone = ctx.location("PokegearPhoneIconGFX");
  if (phone) {
    blit(extraImg, inkFrom2bpp(rom.bytes(phone[0], phone[1], 16), 8, 8), 16, 0, 0, 0, 8, 8); // $62
  }
  const imageExtra = save(ctx, extraImg, "fonts/font_extra.png");

  const battleExtra = ctx.symbol("FontBattleExtra");
  const imageBattleExtra = save(
    ctx,
    inkFrom2bpp(rom.bytes(battleExtra.bank, battleExtra.address, (128 * 16) / 4), 128, 16),
    "fonts/font_battle_extra.png",
  );

  const data: Record<string, unknown> = {
    generation: 2,
    source:
      "ROM:Font, FontExtra, Frames, FontBattleExtra, PokegearPhoneIconGFX, FontsExtra_SolidBlackAndUpArrowGFX",
    image,
    imageExtra,
    imageBattleExtra,
    imageFrames,
    frameBase: 0x79,
    frameTiles: TEXTBOX_FRAME_TILES,
    mainBase: 0x80,
    extraBase: 0x60,
    glyphsPerRow: 16,
    charmap: ctx.manifest.fontCharmap ?? {},
  };

  // :520-552 — the Unown font: a 4-shade SHEET (tile n = letter n+1, tile
  // 26 the cursor), uninverted, as it sits in the ROM.
  const unown = ctx.location("UnownFont");
  if (unown) {
    data.imageUnown = write2bpp(
      ctx,
      rom.bytes(unown[0], unown[1], UNOWN_FONT_TILES * 16),
      UNOWN_FONT_WIDE * 8,
      (UNOWN_FONT_TILES / UNOWN_FONT_WIDE) * 8,
      "fonts/unown_font.png",
    );
    data.unownTiles = UNOWN_FONT_TILES;
    data.unownWide = UNOWN_FONT_WIDE;
    data.unownBase = 0x40; // FIRST_UNOWN_CHAR
    data.source = `${data.source}, UnownFont`;
  }
  // :553-564 — the map-name sign frame (14 tiles loaded at $60).
  const sign = ctx.location("MapEntryFrameGFX");
  if (sign) {
    data.imageMapSign = write2bpp(
      ctx,
      rom.bytes(sign[0], sign[1], MAP_SIGN_TILES * 16),
      MAP_SIGN_TILES * 8,
      8,
      "fonts/map_entry_sign.png",
    );
    data.mapSignTiles = MAP_SIGN_TILES;
    data.mapSignBase = 0x60;
    data.source = `${data.source}, MapEntryFrameGFX`;
  }
  return data;
}
