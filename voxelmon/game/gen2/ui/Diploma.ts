// The #DEX-completion diploma: a port of gen1recomp src/ui/gen2/Diploma.lua
// (bdfac727, MIT) -- engine/events/diploma.asm PlaceDiplomaOnScreen, reached
// through `special Diploma`. Only page 1 is ever shown in play (page 2 is the
// Game Boy Printer's second sheet), so this is PlaceDiplomaOnScreen alone.
//
// THE CERTIFICATE IS A TILEMAP, NOT A TEXT BOX. DiplomaPage1Tilemap (a whole
// SCREEN_AREA of tile ids) goes straight over the background before a single
// string is placed, so the border, the seal and the ribbon are cart art: the
// importer's `data.gen2Diploma` (diploma.json). Without it, a plain
// Chrome.box frame stands in.
//
// Positions are PlaceDiplomaOnScreen's literal hlcoord operands:
//   hlcoord 2, 5    "PLAYER"
//   hlcoord 15, 5   .EmptyString -- a bare terminator, nothing to draw
//   hlcoord 9, 5    wPlayerName
//   hlcoord 2, 8    .Certification, five `next`-joined lines: rows 8-12
//
// COLOUR. _CGB_Diploma loads DiplomaPalettes and WipeAttrmap zeroes the
// attrmap, so every tile -- art and text alike -- draws through set 0.
//
// WaitPressAorB_BlinkCursor just parks on A or B; there is no menu here.

import { Chrome } from "./Chrome.ts";
import { GbcPalette } from "../shared/render/GbcPalette.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Assets } from "../shared/render/Assets.ts";
import G, { type LcdImage, type Quad } from "../platform/screen.ts";

type Colors = readonly (readonly number[])[];

// Lua: Diploma.lua:47
const CERTIFICATION = [
  Strings.source("This certifies"),
  Strings.source("that you have"),
  Strings.source("completed the"),
  Strings.source("new #DEX."),
  Strings.source("Congratulations!"),
];

export interface DiplomaOpts {
  playerName?: string;
  gfx?: any;
  onClose?: () => void;
}

interface PageTile {
  quad: Quad;
  x: number;
  y: number;
}

export class Diploma {
  [key: string]: any;
  static isOpaque = true;
  isOpaque = true;

  game: any;
  playerName = "?";
  onClose?: () => void;
  gfx: any;
  images: Record<string, LcdImage | false> = {};
  done = false;
  // The Lua's sprite batch: the page's tiles, built once.
  tilemap: { image: LcdImage; tiles: PageTile[] } | false | undefined = undefined;

  // Lua: Diploma.lua:45
  wantsFillScale(): boolean {
    return true;
  }

  // Lua: Diploma.lua:56 -- opts: playerName, gfx, onClose()
  static new(game: any, opts?: DiplomaOpts): Diploma {
    const o = opts ?? {};
    const self = new Diploma();
    self.game = game;
    const save = game ? game.save : undefined;
    self.playerName = o.playerName ?? (save && save.player && save.player.name) ?? "?";
    self.onClose = o.onClose;
    self.gfx = o.gfx ?? ((game && game.data) || {}).gen2Diploma;
    self.images = {};
    self.done = false;
    return self;
  }

  // Lua: Diploma.lua:70
  finish(): void {
    if (this.done) return;
    this.done = true;
    if (this.onClose) this.onClose();
  }

  // Lua: Diploma.lua:76
  update(_dt?: number): void {
    if (this.done) return;
    const input = this.game ? this.game.input : undefined;
    if (!input) return;
    if (input.wasPressed("a") || input.wasPressed("b")) this.finish();
  }

  // Lua: Diploma.lua:86 -- set 0 of DiplomaPalettes.
  palette(): Colors | undefined {
    const palettes = this.gfx && this.gfx.palettes;
    return palettes ? palettes[0] : undefined;
  }

  // Lua: Diploma.lua:91
  image(path: string | undefined): LcdImage | undefined {
    if (!path) return undefined;
    let cached = this.images[path];
    if (cached === undefined) {
      try {
        cached = Assets.image(path);
      } catch {
        cached = false;
      }
      this.images[path] = cached;
    }
    return cached || undefined;
  }

  // Lua: Diploma.lua:107 -- the page as one batch of 8x8 tiles, built once.
  batch(): { image: LcdImage; tiles: PageTile[] } | undefined {
    if (this.tilemap !== undefined) return this.tilemap || undefined;
    const gfx = this.gfx;
    const image = gfx && gfx.page1 ? this.image(gfx.image) : undefined;
    if (!image) {
      this.tilemap = false;
      return undefined;
    }
    const across = gfx.sheetTiles || 16;
    const width = gfx.width || Chrome.SCREEN_W;
    const height = gfx.height || Chrome.SCREEN_H;
    const [iw, ih] = image.getDimensions();
    const quads: Record<number, Quad> = {};
    const tiles: PageTile[] = [];
    for (let index = 0; index < width * height; index++) {
      const tile = gfx.page1[index] ?? 0;
      let quad = quads[tile];
      if (!quad) {
        quad = G.newQuad((tile % across) * 8, Math.floor(tile / across) * 8, 8, 8, iw, ih);
        quads[tile] = quad;
      }
      tiles.push({ quad, x: (index % width) * 8, y: Math.floor(index / width) * 8 });
    }
    this.tilemap = { image, tiles };
    return this.tilemap;
  }

  // Lua: Diploma.lua:134
  drawPanel(): void {
    const palette = this.palette();
    const batch = this.batch();

    if (batch) {
      // ClearTilemap leaves the screen on colour 0 of the loaded set.
      const paper = GbcPalette.color(palette, 1);
      G.setColor(paper[0]! / 255, paper[1]! / 255, paper[2]! / 255, 1);
      G.rectangle("fill", 0, 0, Chrome.SCREEN_W * 8, Chrome.SCREEN_H * 8);
      G.setColor(1, 1, 1, 1);
      const blit = (): void => {
        for (const t of batch.tiles) G.draw(batch.image, t.quad, t.x, t.y);
      };
      // A palette-less cache falls back to the sheet's own grey shades.
      if (palette) GbcPalette.with(palette, blit);
      else blit();
      G.setColor(1, 1, 1, 1);
    } else {
      // No gfx/diploma in the cache: a placeholder frame, not the real seal.
      Chrome.clear();
      Chrome.box(0, 0, Chrome.SCREEN_W, Chrome.SCREEN_H);
    }

    Chrome.printThrough(Strings.get("PLAYER"), 2, 5, palette);
    Chrome.printThrough(this.playerName, 9, 5, palette);
    CERTIFICATION.forEach((line, i) => {
      Chrome.printThrough(Strings.get(line), 2, 8 + i, palette);
    });
  }

  // Lua: Diploma.lua:166
  draw(): void {
    this.drawPanel();
  }

  // Lua: Diploma.lua:176 -- PlaceDiplomaOnScreen opens on ClearBGPalettes /
  // ClearTilemap, so the diploma's own paper is the whole screen.
  drawsWidescreen(): boolean {
    return true;
  }

  // Lua: Diploma.lua:178 -- the Gold screen is the panel; no letterbox.
  drawWidescreen(_winW: number, _winH: number): void {
    G.setColor(1, 1, 1, 1);
    G.push();
    G.origin();
    this.drawPanel();
    G.pop();
  }
}

export default Diploma;
