// The boot intro's art: the GAME FREAK splash and the Gengar/Nidorino
// attract fight (engine/movie/splash.asm, engine/movie/intro.asm).
//
// gen1recomp rips these from the pokered source tree (tools/extract/gfx.py
// extract_intro reads gfx/splash/*.png and gfx/intro/*.png). Pocket Voxel
// only ever reads the ROM, so every piece here is decoded out of the
// cartridge at the manifest's own symbols -- which is also why the shapes
// below are asserted rather than assumed.
import type { Ctx } from "../ctx.ts";
import { GfxImage, blit, decode2bpp, matteColor0 } from "../gfx.ts";

/** Decode `count` tiles as ONE row, so tile i lands at x = i*8. */
function strip(ctx: Ctx, symbol: string, count: number, transparent: boolean): GfxImage {
  const sym = ctx.symbol(symbol);
  const raw = (ctx as unknown as { rom: { bytes(b: number, a: number, n: number): number[] } })
    .rom.bytes(sym.bank, sym.address, count * 16);
  return decode2bpp(raw, count * 8, 8, transparent);
}

/** One 8x8 tile out of a `strip`. */
function tile(src: GfxImage, index: number): GfxImage {
  const out = new GfxImage(8, 8);
  blit(out, src, 0, 0, index * 8, 0, 8, 8);
  return out;
}

/**
 * GameFreakIntro is twenty tiles: thirteen letter tiles ($80-$8C), the six
 * that make the 16x24 studio logo ($8D-$92), and a blank ($93). The OAM
 * table that places them (GameFreakLogoOAMData, splash.asm:211-228) puts
 * the logo two tiles wide by three tall and spells the row beneath it out
 * of the letter tiles -- which is why the letters are addressed by name
 * here rather than copied in order.
 */
const GF_TILES = 20;
/** G A M E _ F R E A K: the letter row at (40,80), ten tiles wide. */
const GF_TEXT = [0, 1, 2, 3, 19, 4, 5, 3, 1, 6];

export function extractIntro(ctx: Ctx): Record<string, unknown> {
  const anyCtx = ctx as unknown as {
    rom: { bytes(b: number, a: number, n: number): number[] };
    gfx: { add(key: string, image: GfxImage): void };
  };
  const out: Record<string, unknown> = {};
  const add = (key: string, image: GfxImage): void => {
    anyCtx.gfx.add(key, image);
    out[key] = { w: image.w, h: image.h };
  };

  // --- the splash ---------------------------------------------------------
  try {
    const gf = strip(ctx, "GameFreakIntro", GF_TILES, true);
    const logo = new GfxImage(16, 24);
    for (let i = 0; i < 6; i++) {
      blit(logo, gf, (i % 2) * 8, Math.floor(i / 2) * 8, (13 + i) * 8, 0, 8, 8);
    }
    add("intro/gflogo", logo);
    // The 3x10-frame flash the logo does on arrival (splash.asm:72-82) is a
    // palette rotation, which a page cannot do at draw time -- so the other
    // end of the rotation is its own page and the movie swaps between them.
    // One shade lighter, floored at 1: shifting all the way to 0 would put
    // the logo the same colour as the paper it stands on, and the flash
    // would read as the logo disappearing rather than as it shimmering.
    const dim = new GfxImage(16, 24);
    for (let y = 0; y < 24; y++) {
      for (let x = 0; x < 16; x++) {
        const v = logo.get(x, y);
        dim.set(x, y, v === 0xff ? 0xff : Math.max(1, v - 1));
      }
    }
    add("intro/gflogo_dim", dim);
    const text = new GfxImage(GF_TEXT.length * 8, 8);
    GF_TEXT.forEach((t, i) => blit(text, gf, i * 8, 0, t * 8, 0, 8, 8));
    add("intro/gftext", text);
  } catch (e) {
    console.warn("intro: GameFreakIntro failed: " + String(e).slice(0, 100));
  }

  // The small stars that rain off the logo. One tile holds two of them: the
  // upper in GB color 1, the lower in color 2, and MoveDownSmallStars
  // toggles OBP1 to %10100000 every step (splash.asm:199-203), which blanks
  // colors 2 and 3 -- so the lower star blinks. `star_blink` is that
  // toggled state, kept as its own page so the blink is pixel-exact rather
  // than a guess at which pixels belong to which star.
  try {
    const star = tile(strip(ctx, "FallingStar", 1, true), 0);
    add("intro/star", star);
    const blink = new GfxImage(8, 8);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const v = star.get(x, y);
        blink.set(x, y, v === 1 ? 1 : 0xff);
      }
    }
    add("intro/star_blink", blink);
  } catch (e) {
    console.warn("intro: FallingStar failed: " + String(e).slice(0, 100));
  }

  // --- the fight ----------------------------------------------------------
  // Nidorino is three 48x48 OAM poses, and OAM sheets are stored COLUMN
  // major: tile i is column i/6, row i%6. Read row major he comes out as
  // confetti, which is the only reason this is worth a comment.
  const NIDO = ["FightIntroFrontMon", "FightIntroFrontMon2", "FightIntroFrontMon3"];
  NIDO.forEach((symbol, n) => {
    try {
      const src = strip(ctx, symbol, 36, true);
      const pose = new GfxImage(48, 48);
      for (let i = 0; i < 36; i++) {
        blit(pose, src, Math.floor(i / 6) * 8, (i % 6) * 8, i * 8, 0, 8, 8);
      }
      add(`intro/nido${n + 1}`, pose);
    } catch (e) {
      console.warn(`intro: ${symbol} failed: ` + String(e).slice(0, 100));
    }
  });

  // Gengar is a BACKGROUND pose, so the ROM keeps a de-duplicated 96-tile
  // bank (FightIntroBackMon) and three 7x7 tile-id maps that arrange it
  // (GengarIntroTiles1..3, written to the screen by IntroCopyTiles ->
  // CopyTileIDs). A map addresses the bank by linear tile id, so the bank
  // wants no re-ordering at all; the maps themselves are row major.
  // Edge-connected white is matted off the assembled pose the
  // way the title screen's Red is, so the letterbox shows through around
  // him while the whites inside him stay.
  try {
    const bank = strip(ctx, "FightIntroBackMon", 96, false);
    for (let n = 1; n <= 3; n++) {
      const sym = ctx.symbol(`GengarIntroTiles${n}`);
      const map = anyCtx.rom.bytes(sym.bank, sym.address, 49);
      const pose = new GfxImage(56, 56, 0);
      for (let i = 0; i < 49; i++) {
        const t = map[i]!;
        blit(pose, bank, (i % 7) * 8, Math.floor(i / 7) * 8, t * 8, 0, 8, 8);
      }
      add(`intro/gengar${n}`, matteColor0(pose));
    }
  } catch (e) {
    console.warn("intro: gengar failed: " + String(e).slice(0, 100));
  }

  return out;
}
