// Title-screen art. The logo, the player figure and the publisher logos are
// plain 2bpp tile strips (not compressed pics), so they decode like the emote
// sheet in field.ts and get composited into flat pages the cook can pack.
import type { Ctx } from "../ctx.ts";
import { GfxImage, TRANSPARENT, blit, decode1bpp, decode2bpp } from "../gfx.ts";

interface Strip {
  symbol: string;
  key: string;
  cols: number;
  rows: number;
  /** 1bpp strips (build_rom_data.py raw_1bpp): a set bit is black. */
  bpp?: 1 | 2;
  /**
   * OAM art with a white interior: shade 0 stays opaque INSIDE the figure
   * and only the white joined to the edge goes clear, the way
   * build_rom_data.py _matte_color0 floods it, so Red covers the mon he
   * stands in front of and the box edge shows past his shoulder.
   */
  matte?: boolean;
}

const STRIPS: Strip[] = [
  { symbol: "PokemonLogoGraphics", key: "title/logo", cols: 16, rows: 6 },
  // gfx/title/player.png is 40x56 (rom_manifest field/title/player).
  { symbol: "PlayerCharacterTitleGraphics", key: "title/player", cols: 5, rows: 7, matte: true },
  { symbol: "NintendoCopyrightLogoGraphics", key: "title/copyright", cols: 16, rows: 2 },
  { symbol: "GameFreakLogoGraphics", key: "title/gamefreak", cols: 16, rows: 2 },
  // gfx/title/red_version.png: "Red" in tiles 0-1, "Version" in 5-9
  // (title.asm draws the two words at columns 7 and 10).
  { symbol: "Version_GFX", key: "title/version", cols: 10, rows: 1, bpp: 1 },
];

/** Flood the shade-0 pixels joined to the border to transparent. */
function matteEdges(page: GfxImage): void {
  const w = page.w;
  const h = page.h;
  const seen = new Uint8Array(w * h);
  const queue: number[] = [];
  const add = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = y * w + x;
    if (seen[i] || page.get(x, y) !== 0) return;
    seen[i] = 1;
    queue.push(i);
  };
  for (let x = 0; x < w; x++) { add(x, 0); add(x, h - 1); }
  for (let y = 0; y < h; y++) { add(0, y); add(w - 1, y); }
  while (queue.length) {
    const i = queue.shift()!;
    const x = i % w;
    const y = Math.floor(i / w);
    page.set(x, y, TRANSPARENT);
    add(x - 1, y); add(x + 1, y); add(x, y - 1); add(x, y + 1);
  }
}

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
      const per = s.bpp === 1 ? 8 : 16;
      const bytes = anyCtx.rom.bytes(sym.bank, sym.address, tiles * per);
      const page = new GfxImage(w, h);
      for (let i = 0; i < tiles; i++) {
        const slice = bytes.slice(i * per, i * per + per);
        const tile = s.bpp === 1
          ? decode1bpp(slice, 8, 8, true)
          : decode2bpp(slice, 8, 8, !s.matte);
        blit(page, tile, (i % s.cols) * 8, Math.floor(i / s.cols) * 8);
      }
      if (s.matte) matteEdges(page);
      anyCtx.gfx.add(s.key, page);
      out[s.key] = { w: w, h: h };
      console.log("title: " + s.key + " " + w + "x" + h);
    } catch (e) {
      console.warn("title: " + s.symbol + " failed: " + String(e).slice(0, 80));
    }
  }
  return out;
}
