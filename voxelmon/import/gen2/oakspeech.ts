// Port of gen1recomp RomExtractorGen2.lua (bdfac727): splashGfx (:4146-4233)
// and extractOakSpeech (:4269). Crystal-only pieces are dropped: the Ditto
// splash (GameFreakDittoGFX / GameFreakDittoPaletteFade /
// _CGB_GamefreakLogo.GamefreakDittoPalette) and the Chris/Kris player pics
// (ChrisPic/KrisPic) -- none are Gold symbols, so Gold's playerPic falls
// back to CalPic exactly as Brian's does, and the demo mon is MARILL.

import type { Gen2Ctx } from "./ctx.ts";
import { inkFrom1bpp } from "./font.ts";
import { gfxKey, predefPal, save, write2bpp, writeCompressedPic } from "./helpers.ts";
import { attempt, decodeGen2Text } from "./text.ts";

/** :4151-4153 constants/scgb_constants.asm */
const PREDEFPAL_GAMEFREAK_LOGO_OB = 77;
const PREDEFPAL_GAMEFREAK_LOGO_BG = 78;

/**
 * RomExtractorGen2.lua:4171 splashGfx — GameFreakLogoGFX is
 * gamefreak_presents.1bpp (13 tiles) + gamefreak_logo.1bpp (15 tiles, 3x5
 * row-major); GameFreakLogoStarsGFX is logo_star.2bpp (2) + sparkle (3).
 * Returns {presents "splash/presents" (104x8 ink), logo "splash/logo"
 * (24x40 ink), obPalette, bgPalette (4 colours each), star? "splash/star"
 * (8x16, shade 0 transparent), sparkle? "splash/sparkle" (24x8)}, or
 * undefined without the symbol.
 */
export function splashGfx(ctx: Gen2Ctx): Record<string, unknown> | undefined {
  const logoSym = ctx.location("GameFreakLogoGFX");
  if (!logoSym) return undefined;
  const raw = ctx.rom.bytes(logoSym[0], logoSym[1], 28 * 8);
  const presents = raw.slice(0, 13 * 8);
  const logo = raw.slice(13 * 8, 28 * 8);
  const out: Record<string, unknown> = {
    presents: save(ctx, inkFrom1bpp(presents, 104, 8), "splash/presents.png"),
    logo: save(ctx, inkFrom1bpp(logo, 24, 40), "splash/logo.png"),
    obPalette: predefPal(ctx, PREDEFPAL_GAMEFREAK_LOGO_OB),
    bgPalette: predefPal(ctx, PREDEFPAL_GAMEFREAK_LOGO_BG),
  };
  // :4184 — kept at the old path too.
  save(ctx, inkFrom1bpp(logo, 24, 40), "intro/gamefreak_logo.png");

  const stars = ctx.location("GameFreakLogoStarsGFX");
  if (stars) {
    out.star = write2bpp(ctx, ctx.rom.bytes(stars[0], stars[1], 2 * 16), 8, 16, "splash/star.png", true);
    out.sparkle = write2bpp(ctx, ctx.rom.bytes(stars[0], stars[1] + 2 * 16, 3 * 16), 24, 8, "splash/sparkle.png", true);
  }
  // :4205-4230 Ditto / ditto fade / ditto palette: Crystal only.
  return out;
}

/**
 * RomExtractorGen2.lua:4269 extractOakSpeech(pokemon). oak_speech.json:
 * {generation 2, source, music "Music_Route30", demoSpecies "MARILL",
 * oakPic "intro/oak", playerPic "intro/cal", marillPic (the pokemon
 * table's spriteFront, else "battle/front/marill"), shrink1 "intro/shrink1",
 * shrink2 "intro/shrink2", gamefreakLogo "intro/gamefreak_logo", splash
 * (splashGfx), text {_OakText1.._OakText7: string}}. Trainer and shrink
 * pics are 7x7 lz3 pics, matted like every writeCompressedPic.
 */
export function extractOakSpeech(ctx: Gen2Ctx, pokemon?: Record<string, any>): Record<string, unknown> {
  const charmap = ctx.manifest.charmap ?? {};
  const texts: Record<string, string> = {};
  for (let i = 1; i <= 7; i++) {
    const label = `_OakText${i}`;
    const sym = ctx.symbol(label);
    texts[label] = decodeGen2Text(ctx, sym.bank, sym.address, charmap);
  }
  writeCompressedPic(ctx, "PokemonProfPic", 7, "intro/oak.png");
  writeCompressedPic(ctx, "CalPic", 7, "intro/cal.png");
  // :4281 — pcall'd: a bad shrink pic costs only that frame.
  if (ctx.location("Shrink1Pic")) attempt(() => writeCompressedPic(ctx, "Shrink1Pic", 7, "intro/shrink1.png"));
  if (ctx.location("Shrink2Pic")) attempt(() => writeCompressedPic(ctx, "Shrink2Pic", 7, "intro/shrink2.png"));
  const splash = splashGfx(ctx);
  const demoSpecies = "MARILL"; // pokegold engine/menus/intro_menu.asm:519
  const demoMon = pokemon?.[demoSpecies];
  return {
    generation: 2,
    source: "ROM:OakSpeech (_OakText1-7, PokemonProfPic, CalPic)",
    music: "Music_Route30",
    demoSpecies,
    oakPic: "intro/oak",
    // ChrisPic is Crystal's: Gold falls back to CalPic (:4316)
    playerPic: "intro/cal",
    marillPic: demoMon?.spriteFront ? gfxKey(demoMon.spriteFront) : `battle/front/${demoSpecies.toLowerCase()}`,
    shrink1: "intro/shrink1",
    shrink2: "intro/shrink2",
    gamefreakLogo: "intro/gamefreak_logo",
    splash,
    text: texts,
  };
}
