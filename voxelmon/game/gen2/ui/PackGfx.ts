// gen1recomp src/ui/gen2/PackGfx.lua (bdfac727, MIT): the PACK screen's
// chrome, drawn from the cart's own tiles.
//
// engine/items/pack.asm builds this screen out of tiles, not rectangles, and
// transcribing it that way is what makes the bag picture, the pocket plaque and
// the ◀▶/▼▲ header land on the 8px grid by construction:
//
//   Pack_InitGFX   copies PackMenuGFX ($60 tiles) to vTiles2 tile $00, fills
//                  rows 1-11 with the background tile $24, clears the item
//                  area at (5,1) 15x11, and lays the header at (0,0) as the
//                  20 running tiles $28..$3b
//   PlacePackGFX   lays $50..$5e as a 5x3 block at (0,3) -- the bag picture,
//                  which DrawPackGFX swaps per pocket out of PackGFX
//   DrawPocketName lays a 5x3 block at (0,7) from its own 5x12 tilemap
//   _CGB_PackPals  loads six BG palettes and colours five rectangles with
//                  them: the two header halves, the CURSOR column (7,2) 1x9
//                  whose colour 3 is red, the pocket plaque (red) and the bag
//                  picture (green) -- engine/gfx/cgb_layouts.asm:715-734
//
// A cache from before the pack stage simply has no `pack` table; PackMenu
// falls back to its plain boxes then.
//
// Here every tile is one Gold-screen cell (the sheet is a cooked graphic),
// and palette zones pick the palette each cell goes through.

import G, { type LcdImage, type Quad } from "../platform/screen.ts";
import { Assets } from "../shared/render/Assets.ts";
import { GbcPalette } from "../shared/render/GbcPalette.ts";
import { Chrome } from "./Chrome.ts";

type Colors = readonly (readonly number[])[];

/** menu_gfx.json `pack` (the importer's shape). */
export interface PackGfxDef {
  menu?: string;
  menuTiles?: number;
  menuTilesWide?: number;
  backgroundTile?: number;
  headerFirstTile?: number;
  pack?: string;
  packFirstTile?: number;
  packTilesWide?: number;
  packTilesHigh?: number;
  pocketPicture?: Record<string, number>;
  pocketName?: number[][];
  pocketOrder?: string[];
  palettes?: Colors[];
  palettesFemale?: Colors[];
  /** [x, y, w, h, palette (1-based)] */
  paletteZones?: number[][];
  [k: string]: unknown;
}

const SCREEN_W = 20;
// const SCREEN_H = 18 (the Lua declares it; nothing reads it)
// Textbox(0, TEXTBOX_Y - 2) with a 4-row interior: rows 12..17.
const DESCRIPTION_Y = 12;

export class PackGfx {
  static DESCRIPTION_Y = DESCRIPTION_Y;
  static SCREEN_W = SCREEN_W;

  gfx: PackGfxDef | undefined;
  images: Record<string, LcdImage | false> = {};
  quads: Record<string, Quad> = {};
  /** Per-cell palette index (1-based, as the importer writes it). */
  zone: Record<number, number> | undefined;

  /** Lua: PackGfx.lua:33 */
  constructor(menuGfx?: { pack?: PackGfxDef } | null) {
    this.gfx = menuGfx ? menuGfx.pack : undefined;
    if (this.gfx) {
      // paletteZones is a list of rectangles; flatten it to a per-cell lookup so
      // drawing a tile is one table read rather than a scan.
      this.zone = {};
      for (const z of this.gfx.paletteZones ?? []) {
        const [x0, y0, w, h, pal] = z as [number, number, number, number, number];
        for (let y = y0; y <= y0 + h - 1; y++) {
          for (let x = x0; x <= x0 + w - 1; x++) {
            this.zone[y * SCREEN_W + x] = pal;
          }
        }
      }
    }
  }

  /** Lua: PackGfx.lua:33 */
  static new(menuGfx?: { pack?: PackGfxDef } | null): PackGfx {
    return new PackGfx(menuGfx);
  }

  /** Lua: PackGfx.lua:54 */
  available(): boolean {
    return this.gfx !== undefined && this.image("menu") !== undefined;
  }

  /** Lua: PackGfx.lua:58 */
  image(key: string): LcdImage | undefined {
    const path = this.gfx ? (this.gfx[key] as string | undefined) : undefined;
    if (!path) return undefined;
    let cached = this.images[path];
    if (cached === undefined) {
      try {
        cached = Assets.image(path);
      } catch {
        // pcall(Assets.image, path)
        cached = false;
      }
      this.images[path] = cached;
    }
    return cached || undefined;
  }

  /** Lua: PackGfx.lua:71 -- one 8x8 tile out of a sheet `tilesWide` tiles across. */
  quad(image: LcdImage, tilesWide: number, index: number): Quad {
    const key = `${image.key}:${tilesWide}:${index}`;
    let quad = this.quads[key];
    if (!quad) {
      const [w, h] = image.getDimensions();
      quad = G.newQuad((index % tilesWide) * 8, Math.floor(index / tilesWide) * 8, 8, 8, w, h);
      this.quads[key] = quad;
    }
    return quad;
  }

  /** Lua: PackGfx.lua:84 -- the palette a screen cell draws with: its attrmap zone, else palette 0. */
  colorsAt(tx: number, ty: number): Colors | undefined {
    const pals = this.gfx ? this.gfx.palettes : undefined;
    if (!pals) return undefined;
    const index = (this.zone && this.zone[ty * SCREEN_W + tx]) || 1;
    return pals[index - 1];
  }

  /** Lua: PackGfx.lua:91 */
  blit(image: LcdImage | undefined, tilesWide: number, index: number, tx: number, ty: number): void {
    if (!image) return;
    G.setColor(1, 1, 1, 1);
    const colors = this.colorsAt(tx, ty);
    const body = (): void => {
      G.draw(image, this.quad(image, tilesWide, index), tx * 8, ty * 8);
    };
    if (colors && GbcPalette.available()) {
      GbcPalette.with(colors, body);
    } else {
      body();
    }
  }

  /**
   * Lua: PackGfx.lua:108 -- a tile out of PackMenuGFX, addressed by its VRAM
   * id ($00 is the sheet's first tile, so id and index are the same here).
   */
  menuTile(tile: number, tx: number, ty: number): void {
    this.blit(this.image("menu"), this.gfx!.menuTilesWide || 16, tile, tx, ty);
  }

  /**
   * Lua: PackGfx.lua:114 -- everything behind the item list: the header
   * strip, the background column, the bag picture for this pocket, and the
   * pocket plaque.
   */
  draw(pocketId: string): void {
    const gfx = this.gfx!;
    Chrome.paletteFill(0, 0, SCREEN_W * 8, 18 * 8, Chrome.DEFAULT_BOX_PALETTE);

    // ◀▶ POCKET       ▼▲ ITEMS: 20 running tiles from $28.
    const header = gfx.headerFirstTile ?? 0x28;
    for (let tx = 0; tx <= SCREEN_W - 1; tx++) {
      this.menuTile(header + tx, tx, 0);
    }

    // Rows 1-11 are filled with $24; the item area at (5,1) is then cleared, so
    // only the left five columns keep the pattern.
    const background = gfx.backgroundTile ?? 0x24;
    for (let ty = 1; ty <= 11; ty++) {
      for (let tx = 0; tx <= 4; tx++) {
        this.menuTile(background, tx, ty);
      }
    }

    // The bag picture: 15 tiles, 5 across, from this pocket's row in PackGFX.
    const packImage = this.image("pack");
    const firstRow = gfx.pocketPicture ? gfx.pocketPicture[pocketId] : undefined;
    if (packImage && firstRow !== undefined) {
      const wide = gfx.packTilesWide || 5;
      for (let i = 0; i <= wide * (gfx.packTilesHigh || 3) - 1; i++) {
        this.blit(packImage, wide, firstRow + i, i % wide, 3 + Math.floor(i / wide));
      }
    }

    // The pocket plaque, from DrawPocketName's own tilemap.
    const order = gfx.pocketOrder ?? [];
    let block: number[] | undefined;
    order.forEach((id, i) => {
      if (id === pocketId) block = gfx.pocketName ? gfx.pocketName[i] : undefined;
    });
    if (block) {
      block.forEach((tile, i) => {
        this.menuTile(tile, i % 5, 7 + Math.floor(i / 5));
      });
    }
  }
}

export default PackGfx;
