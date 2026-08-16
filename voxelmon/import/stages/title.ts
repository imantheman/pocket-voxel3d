// Title-screen art. The logo, the player figure and the publisher logos are
// plain 2bpp tile strips (not compressed pics), so they decode like the emote
// sheet in field.ts and get composited into flat pages the cook can pack.
import type { Ctx } from "../ctx.ts";
import { GfxImage, blit, decode2bpp } from "../gfx.ts";

interface Strip {
  symbol: string;
  key: string;
  cols: number;
  rows: number;
}

const STRIPS: Strip[] = [
  { symbol: "PokemonLogoGraphics", key: "title/logo", cols: 16, rows: 6 },
  { symbol: "PlayerCharacterTitleGraphics", key: "title/player", cols: 7, rows: 7 },
  { symbol: "NintendoCopyrightLogoGraphics", key: "title/copyright", cols: 16, rows: 2 },
  { symbol: "GameFreakLogoGraphics", key: "title/gamefreak", cols: 16, rows: 2 },
];

export function extractTitle(ctx: Ctx): Record<string, unknown> {
  const anyCtx = ctx as unknown as { rom: any; gfx: any };
  const out: Record<string, unknown> = {};
  for (const s of STRIPS) {
    let sym: any;
    try {
      sym = ctx.symbol(s.symbol);
    } catch {
      console.warn("title: no symbol " + s.symbol);
      continue;
    }
    const tiles = s.cols * s.rows;
    const w = s.cols * 8;
    const h = s.rows * 8;
    try {
      const bytes = anyCtx.rom.bytes(sym.bank, sym.address, tiles * 16);
      const page = new GfxImage(w, h);
      for (let i = 0; i < tiles; i++) {
        const tile = decode2bpp(bytes.slice(i * 16, i * 16 + 16), 8, 8, true);
        blit(page, tile, (i % s.cols) * 8, Math.floor(i / s.cols) * 8);
      }
      anyCtx.gfx.add(s.key, page);
      out[s.key] = { w: w, h: h };
      console.log("title: " + s.key + " " + w + "x" + h);
    } catch (e) {
      console.warn("title: " + s.symbol + " failed: " + String(e).slice(0, 80));
    }
  }
  return out;
}
