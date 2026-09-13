// Trainer-card art (engine/menus/start_sub_menus.asm DrawTrainerInfo).
// Four plain 2bpp tile strips, decoded the way title.ts decodes the title
// screen's — no compressed pics here.
//
// Shapes are the ones the drawing code needs, and each is the sheet's own
// tile order:
//
//   badges   GymLeaderFaceAndBadgeTileGraphics — 8 gyms of [face, badge],
//            each 16x16, as a 2-tile-wide strip: per gym, 4 face tiles then
//            4 badge tiles (DrawBadges picks one or the other per slot).
//   numbers  BadgeNumbersTileGraphics — the eight 8x8 slot digits.
//   frame    TrainerInfoTextBoxTileGraphics — a 3x3 box: the patterned band
//            and the eight edge/corner pieces the card's boxes are drawn from.
//   circle   CircleTile — the dot either side of the BADGES banner.
import type { Ctx } from "../ctx.ts";
import { GfxImage, blit, decode2bpp } from "../gfx.ts";

interface Strip {
  symbol: string;
  key: string;
  cols: number;
  rows: number;
}

const STRIPS: Strip[] = [
  { symbol: "GymLeaderFaceAndBadgeTileGraphics", key: "trainer_card/badges", cols: 2, rows: 32 },
  { symbol: "BadgeNumbersTileGraphics", key: "trainer_card/numbers", cols: 2, rows: 4 },
  { symbol: "TrainerInfoTextBoxTileGraphics", key: "trainer_card/frame", cols: 3, rows: 3 },
  { symbol: "CircleTile", key: "trainer_card/circle", cols: 1, rows: 1 },
];

export function extractTrainerCard(ctx: Ctx): Record<string, unknown> {
  const anyCtx = ctx as unknown as { rom: any; gfx: any };
  const out: Record<string, unknown> = {};
  for (const s of STRIPS) {
    let sym: any;
    try {
      sym = ctx.symbol(s.symbol);
    } catch {
      console.warn("trainer_card: no symbol " + s.symbol);
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
      console.log("trainer_card: " + s.key + " " + w + "x" + h);
    } catch (e) {
      console.warn("trainer_card: " + s.symbol + " failed: " + String(e).slice(0, 80));
    }
  }
  return out;
}
