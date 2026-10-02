// gen1recomp src/ui/gen2/TileSheet.lua (bdfac727): a screen's own tile
// sheet, addressed the way the cart addresses it.
//
// The Gen 2 menus that are not built out of text boxes -- the #DEX, the
// POKeGEAR, the trainer card -- copy a sheet into VRAM at a known tile id and
// write tile ids into the tilemap. Transcribing one means writing the same
// ids at the same hlcoords: "draw sheet tile $NN at (tx, ty)".
//
// `firstTile` is the VRAM id the sheet's tile 0 was loaded at, so a tile id
// maps to a sheet index by subtracting it. A sheet is `wide` tiles across.
// Here the sheet is a cooked Gold graphic, and each draw is one cell.

import G, { type LcdImage, type Quad, putTile, putTiles } from "../platform/screen.ts";
import { Assets } from "../shared/render/Assets.ts";
import { GbcPalette } from "../shared/render/GbcPalette.ts";

type Colors = readonly (readonly number[])[];

export interface TileSheetOpts {
  path?: string;
  wide?: number;
  firstTile?: number;
  palette?: Colors;
  paletteFor?: (tile: number, tx: number, ty: number) => Colors | null | undefined;
  raw?: boolean;
}

export class TileSheet {
  path: string | undefined;
  wide: number;
  firstTile: number;
  palette: Colors | undefined;
  paletteFor: TileSheetOpts["paletteFor"];
  raw: boolean | undefined;
  quads: Quad[] = [];
  loaded: LcdImage | false | undefined = undefined;

  constructor(opts?: TileSheetOpts) {
    this.path = opts?.path;
    this.wide = opts?.wide || 16;
    this.firstTile = opts?.firstTile || 0;
    this.palette = opts?.palette;
    this.paletteFor = opts?.paletteFor;
    this.raw = opts?.raw;
  }

  /** Lua: TileSheet.lua:21 -- opts: path, wide, firstTile, palette or paletteFor, raw */
  static new(opts?: TileSheetOpts): TileSheet {
    return new TileSheet(opts);
  }

  /** Lua: TileSheet.lua:33 */
  image(): LcdImage | undefined {
    if (this.loaded === undefined) {
      this.loaded = false;
      if (this.path) {
        try {
          const image = Assets.image(this.path);
          if (image) this.loaded = image;
        } catch {
          // pcall(Assets.image, ...)
        }
      }
    }
    return this.loaded || undefined;
  }

  /** Lua: TileSheet.lua:46 */
  available(): boolean {
    return this.image() !== undefined;
  }

  /** Lua: TileSheet.lua:50 */
  quad(index: number): Quad | undefined {
    let quad = this.quads[index];
    if (!quad) {
      const image = this.image();
      if (!image) return undefined;
      const [w, h] = image.getDimensions();
      quad = G.newQuad((index % this.wide) * 8, Math.floor(index / this.wide) * 8, 8, 8, w, h);
      this.quads[index] = quad;
    }
    return quad;
  }

  /**
   * Lua: TileSheet.lua:66 -- VRAM tile `tile` at tile coordinates (tx, ty).
   * A tile outside the sheet is skipped, which lets a screen name a tile that
   * belongs to the font page instead.
   */
  draw(tile: number, tx: number, ty: number): boolean {
    const image = this.image();
    if (!image) return false;
    const index = tile - this.firstTile;
    if (index < 0) return false;
    // the sheet tile's place (what quad(index) would frame), and the one
    // putTile G.draw would end in for an 8x8 quad -- written out, with the
    // palette set and restored here rather than through a closure: this runs
    // for every tile a menu draws, hundreds a frame on the #DEX, the
    // POKeGEAR and the trainer card
    const col = index % this.wide;
    const row = Math.floor(index / this.wide);
    if (row * 8 >= image.h) return false;
    G.setColor(1, 1, 1, 1);
    let colors = this.palette;
    if (this.paletteFor) colors = this.paletteFor(tile, tx, ty) ?? colors;
    const id = image.ids && col < image.tw && row < image.th ? image.ids[row * image.tw + col] : undefined;
    const x = Math.round(G.tx + tx * 8);
    const y = Math.round(G.ty + ty * 8);
    if (colors && GbcPalette.available()) {
      const pal = G.palette;
      const keyed = G.keyed;
      if (this.raw) GbcPalette.useRaw(colors);
      else GbcPalette.use(colors);
      try {
        if (id !== undefined) putTile(id, x, y, false, false, image.obj);
      } finally {
        G.palette = pal;
        G.keyed = keyed;
      }
    } else if (id !== undefined) {
      putTile(id, x, y, false, false, image.obj);
    }
    return true;
  }

  /**
   * draw(tile) over a block of `wide` x `high` cells from (tx, ty): the same
   * cells, with one palette lookup and the rows filled natively (putTiles).
   * A per-cell palette (paletteFor) or an object sheet takes draw per cell.
   */
  fill(tile: number, tx: number, ty: number, wide: number, high: number): void {
    const image = this.image();
    if (wide <= 0 || high <= 0) return;
    if (!image || this.paletteFor || image.obj || G.objects) {
      for (let y = ty; y < ty + high; y++) for (let x = tx; x < tx + wide; x++) this.draw(tile, x, y);
      return;
    }
    const index = tile - this.firstTile;
    if (index < 0) return;
    const col = index % this.wide;
    const row = Math.floor(index / this.wide);
    if (row * 8 >= image.h) return;
    G.setColor(1, 1, 1, 1);
    const id = image.ids && col < image.tw && row < image.th ? image.ids[row * image.tw + col] : undefined;
    if (id === undefined) return;
    const x = Math.round(G.tx + tx * 8);
    const y = Math.round(G.ty + ty * 8);
    const colors = this.palette;
    if (colors && GbcPalette.available()) {
      const pal = G.palette;
      const keyed = G.keyed;
      if (this.raw) GbcPalette.useRaw(colors);
      else GbcPalette.use(colors);
      try {
        putTiles(id, x, y, wide, high);
      } finally {
        G.palette = pal;
        G.keyed = keyed;
      }
    } else {
      putTiles(id, x, y, wide, high);
    }
  }

  /** Lua: TileSheet.lua:95 -- a run of consecutive ids, left to right. */
  run(first: number, count: number, tx: number, ty: number): void {
    for (let i = 0; i < count; i++) this.draw(first + i, tx + i, ty);
  }

  /** Lua: TileSheet.lua:102 -- a rectangle of consecutive ids, row-major. */
  block(first: number, wide: number, high: number, tx: number, ty: number): void {
    for (let row = 0; row < high; row++) {
      for (let col = 0; col < wide; col++) this.draw(first + row * wide + col, tx + col, ty + row);
    }
  }
}

export default TileSheet;
