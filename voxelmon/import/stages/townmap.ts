// TOWN MAP art (engine/items/town_map.asm LoadTownMap). Two plain 2bpp
// strips, decoded like title.ts's.
//
// The 20x18 tile LAYOUT is not here — the extractor already decompressed it
// into field.townMap.background.map (the RLE that LoadTownMap walks), along
// with every map's grid coordinates. This stage only fetches the pixels the
// layout indexes into:
//
//   tiles   WorldMapTileGraphics — 2bpp, 16 tiles as a 4x4 sheet; the layout
//           uses indices 4..15 of it (0..3 are unused by Kanto's map).
//   cursor  TownMapCursor — the 16x16 marker on the selected location, and
//           the reason this file has two decode paths: it is ONE BIT per
//           pixel with the clear bit transparent (gen1recomp
//           build_rom_data.py raw_1bpp), so reading it as 2bpp pulls twice
//           the bytes and renders the overrun as noise.
import type { Ctx } from "../ctx.ts";
import { GfxImage, blit, decode1bpp, decode2bpp } from "../gfx.ts";

interface Strip {
  symbol: string;
  key: string;
  cols: number;
  rows: number;
  /** 1bpp sheets decode whole, not tile by tile. */
  bpp1?: boolean;
}

const STRIPS: Strip[] = [
  { symbol: "WorldMapTileGraphics", key: "townmap/tiles", cols: 4, rows: 4 },
  { symbol: "TownMapCursor", key: "townmap/cursor", cols: 2, rows: 2, bpp1: true },
];

export function extractTownMap(ctx: Ctx): Record<string, unknown> {
  const anyCtx = ctx as unknown as { rom: any; gfx: any };
  const out: Record<string, unknown> = {};
  for (const s of STRIPS) {
    let sym: any;
    try {
      sym = ctx.symbol(s.symbol);
    } catch {
      console.warn("townmap: no symbol " + s.symbol);
      continue;
    }
    const tiles = s.cols * s.rows;
    const w = s.cols * 8;
    const h = s.rows * 8;
    try {
      let page: GfxImage;
      if (s.bpp1) {
        page = decode1bpp(anyCtx.rom.bytes(sym.bank, sym.address, tiles * 8), w, h, true);
      } else {
        const bytes = anyCtx.rom.bytes(sym.bank, sym.address, tiles * 16);
        page = new GfxImage(w, h);
        for (let i = 0; i < tiles; i++) {
          const tile = decode2bpp(bytes.slice(i * 16, i * 16 + 16), 8, 8, true);
          blit(page, tile, (i % s.cols) * 8, Math.floor(i / s.cols) * 8);
        }
      }
      anyCtx.gfx.add(s.key, page);
      out[s.key] = { w: w, h: h };
      console.log("townmap: " + s.key + " " + w + "x" + h);
    } catch (e) {
      console.warn("townmap: " + s.symbol + " failed: " + String(e).slice(0, 80));
    }
  }
  return out;
}
