// gen1recomp src/ui/gen2/Chrome.lua (bdfac727): the shared Gen 2 menu
// chrome -- boxes, tile-grid text, the scrolling cursor list -- that nearly
// every Gold screen is built out of (engine/menus/menu.asm SetUpMenu +
// GetScrollingMenuJoypad).
//
// Everything is in 8px tile coordinates on the 20x18 grid, which is also
// the Gold screen's own grid (platform/lcd.ts), so a box is border and
// blank cells and a string is glyph cells. The panel fitting (fitScale,
// letterbox, withPanel) belonged to a desktop window: here the screen IS
// the panel, so those draw straight through at the origin.
//
// One ordering change from the Lua: printThrough settles its palette BEFORE
// it paints the paper behind the string, so the paper reuses the palette's
// colour 0 instead of spending a palette slot of its own (the Gold screen
// has sixteen). What lands on screen is the same.

import { format, sub } from "../platform/lua.ts";
import G, { putTile, SOLID } from "../platform/screen.ts";
import { Font } from "../shared/render/Font.ts";
import { GbcPalette } from "../shared/render/GbcPalette.ts";

type Colors = readonly (readonly number[])[];

// charmap.asm "¥"
const YEN = "¥";

/** What List.update reads (shared/core/Input.ts). */
export interface MenuInput {
  wasPressed(button: string): boolean;
}

export interface ListItem {
  label: string;
  value: unknown;
  disabled?: boolean;
  [k: string]: unknown;
}

export interface ListOpts {
  items?: (ListItem | string | number)[];
  x?: number;
  y?: number;
  spacing?: number;
  rows?: number;
  wrap?: boolean;
  startAccepts?: boolean;
  onChoose?: (value: unknown, index: number) => void;
  onCancel?: () => void;
  onMove?: (value: unknown, index: number) => void;
  palette?: Colors | null | false;
  index?: number;
}

function setPaper(pal: Colors): void {
  const paper = pal[0] ?? [255, 255, 255];
  G.setColor(paper[0]! / 255, paper[1]! / 255, paper[2]! / 255, 1);
}

/**
 * printThrough's cells written straight, when they sit on the cell grid and
 * every glyph is a whole 8px cell: each cell its glyph, or the paper
 * (colour 0, SOLID[0]) where a code has no glyph -- which is what the paper
 * rectangle with the glyphs over it comes to. Returns the width, or -1 when
 * the string is off the grid and the general path must draw it.
 */
function gridPrint(codes: number[], x: number, y: number, pal: Colors): number {
  const x0 = Math.round(x + G.tx);
  const y0 = Math.round(y + G.ty);
  if ((x0 & 7) !== 0 || (y0 & 7) !== 0 || G.objects) return -1;
  for (let i = 0; i < codes.length; i++) if (Font.advanceOf(codes[i]!) !== 8) return -1;
  const savedPal = G.palette;
  const savedKeyed = G.keyed;
  G.setColor(1, 1, 1, 1);
  GbcPalette.useRaw(pal);
  for (let i = 0; i < codes.length; i++) {
    const id = Font.tileOf(codes[i]!);
    putTile(id === undefined ? SOLID[0] : id, x0 + i * 8, y0);
  }
  G.palette = savedPal;
  G.keyed = savedKeyed;
  G.setColor(0, 0, 0, 1);
  return codes.length * 8;
}

function flatPrint(text: string, tx: number, ty: number): number {
  G.setColor(0, 0, 0, 1);
  return Font.draw(text, tx * 8, ty * 8);
}

function flatCursor(tx: number, ty: number, hollow?: boolean): void {
  G.setColor(0, 0, 0, 1);
  Font.drawCode(hollow ? Chrome.CURSOR_HOLLOW : Chrome.CURSOR, tx * 8, ty * 8);
}

/** Chrome.lua:489 -- a vertical cursor list. */
export class List {
  items: ListItem[] = [];
  x: number;
  y: number;
  spacing: number;
  rows: number;
  wrap: boolean;
  startAccepts: boolean;
  onChoose?: (value: unknown, index: number) => void;
  onCancel?: () => void;
  onMove?: (value: unknown, index: number) => void;
  palette: Colors | null;
  /** 1-based, as in the Lua. */
  index: number;
  scroll = 0;

  constructor(opts: ListOpts = {}) {
    for (const entry of opts.items ?? []) {
      if (typeof entry === "object" && entry !== null) this.items.push(entry);
      else this.items.push({ label: String(entry), value: entry });
    }
    this.x = opts.x ?? 1;
    this.y = opts.y ?? 1;
    this.spacing = opts.spacing ?? 2;
    this.rows = Math.min(opts.rows ?? this.items.length, this.items.length);
    this.wrap = opts.wrap !== false;
    this.startAccepts = opts.startAccepts ?? false;
    this.onChoose = opts.onChoose;
    this.onCancel = opts.onCancel;
    this.onMove = opts.onMove;
    this.palette = opts.palette === undefined ? Chrome.DEFAULT_BOX_PALETTE : opts.palette || null;
    this.index = Math.max(1, Math.min(opts.index ?? 1, Math.max(1, this.items.length)));
    this.ensureVisible();
  }

  static new(opts: ListOpts = {}): List {
    return new List(opts);
  }

  current(): ListItem | undefined {
    return this.items[this.index - 1];
  }

  ensureVisible(): void {
    if (this.rows <= 0) return;
    if (this.index <= this.scroll) this.scroll = this.index - 1;
    else if (this.index > this.scroll + this.rows) this.scroll = this.index - this.rows;
    this.scroll = Math.max(0, Math.min(this.scroll, this.items.length - this.rows));
  }

  move(delta: number): void {
    if (this.items.length === 0) return;
    let next = this.index + delta;
    if (next < 1) {
      if (!this.wrap) return;
      next = this.items.length;
    } else if (next > this.items.length) {
      if (!this.wrap) return;
      next = 1;
    }
    this.index = next;
    this.ensureVisible();
    this.onMove?.(this.current()?.value, this.index);
  }

  /** Chrome.lua:560 -- true when the press was consumed. */
  update(input: MenuInput | null | undefined): boolean {
    if (!input) return false;
    if (input.wasPressed("up")) {
      this.move(-1);
      return true;
    }
    if (input.wasPressed("down")) {
      this.move(1);
      return true;
    }
    if (input.wasPressed("a") || (this.startAccepts && input.wasPressed("start"))) {
      const item = this.current();
      if (item && !item.disabled && this.onChoose) this.onChoose(item.value, this.index);
      return true;
    }
    if (input.wasPressed("b")) {
      this.onCancel?.();
      return true;
    }
    return false;
  }

  draw(): void {
    for (let row = 1; row <= this.rows; row++) {
      const i = row + this.scroll;
      const item = this.items[i - 1];
      if (!item) continue;
      const ty = this.y + (row - 1) * this.spacing;
      if (i === this.index) {
        if (this.palette) Chrome.cursorThrough(this.x - 1, ty, this.palette);
        else flatCursor(this.x - 1, ty);
      }
      if (this.palette) Chrome.printThrough(item.label, this.x, ty, this.palette);
      else flatPrint(item.label, this.x, ty);
    }
    // the ▼ hint Gold shows when there is more below
    if (this.rows < this.items.length && this.scroll + this.rows < this.items.length) {
      const ay = (this.y + this.rows * this.spacing - 1) * 8;
      if (this.palette) {
        const [, drawGlyph, finish] = Chrome.paletteGlyphs(this.palette);
        drawGlyph(Chrome.DOWN_ARROW, (this.x - 1) * 8, ay);
        finish();
      } else {
        G.setColor(0, 0, 0, 1);
        Font.drawCode(Chrome.DOWN_ARROW, (this.x - 1) * 8, ay);
      }
    }
  }
}

export const Chrome = {
  // charmap.asm: ▶ the cursor, ▷ its hollow form, ▼ the advance arrow
  CURSOR: 0xed,
  CURSOR_HOLLOW: 0xec,
  DOWN_ARROW: 0xee,
  SCREEN_W: 20,
  SCREEN_H: 18,
  worldSurround: false,
  List,
  DEFAULT_BOX_PALETTE: [
    [255, 255, 255],
    [255, 255, 255],
    [255, 255, 255],
    [0, 0, 0],
  ] as Colors,

  /** Chrome.lua:30 -- a flat rect in the box palette's paper. */
  paletteFill(px: number, py: number, pw: number, ph: number, palette?: Colors): void {
    const pal = palette ?? Chrome.DEFAULT_BOX_PALETTE;
    GbcPalette.with(pal, () => {
      const c = GbcPalette.color(pal, 1);
      G.setColor(c[0]! / 255, c[1]! / 255, c[2]! / 255, 1);
      G.rectangle("fill", px, py, pw, ph);
    });
    G.setColor(0, 0, 0, 1);
  },

  // the desktop window's panel fitting: the Gold screen is the panel
  letterbox(..._a: unknown[]): void {},
  playfieldRect(): [number, number, number, number] {
    return [0, 0, Chrome.SCREEN_W * 8, Chrome.SCREEN_H * 8];
  },
  fitScaleFor(): number {
    return 1;
  },
  fitOriginFor(): [number, number] {
    return [0, 0];
  },
  fitScale(): number {
    return 1;
  },
  fitOrigin(): [number, number] {
    return [0, 0];
  },
  positionLift(): number {
    return 0;
  },

  clear(): void {
    Chrome.paletteFill(0, 0, Chrome.SCREEN_W * 8, Chrome.SCREEN_H * 8);
  },

  /** Chrome.lua:125 */
  clipTo(x: number, y: number, w: number, h: number): void {
    const [x1, y1] = G.transformPoint(x, y);
    G.intersectScissor(Math.floor(x1), Math.floor(y1), Math.ceil(w), Math.ceil(h));
  },

  /** Chrome.lua:139 -- the panel IS the screen: draw at the origin, clipped to it. */
  withPanel(_winW: number, _winH: number, _r: number, _g: number, _b: number, drawFn: () => void): void {
    G.push("all");
    G.origin();
    Chrome.clipTo(0, 0, Chrome.SCREEN_W * 8, Chrome.SCREEN_H * 8);
    try {
      drawFn();
    } finally {
      G.pop();
    }
  },

  withClip(drawFn: () => void): void {
    G.push("all");
    Chrome.clipTo(0, 0, Chrome.SCREEN_W * 8, Chrome.SCREEN_H * 8);
    try {
      drawFn();
    } finally {
      G.pop();
    }
  },

  /** Chrome.lua:165 */
  paletteBox(tx: number, ty: number, tw: number, th: number, palette?: Colors): void {
    const pal = palette ?? Chrome.DEFAULT_BOX_PALETTE;
    G.setColor(1, 1, 1, 1);
    GbcPalette.with(pal, () => Font.drawBox(tx, ty, tw, th));
    G.setColor(0, 0, 0, 1);
  },

  /** A bordered box, tile coords. */
  box(tx: number, ty: number, tw: number, th: number): void {
    Chrome.paletteBox(tx, ty, tw, th);
  },

  /** Gold's Textbox: interior width/height, border drawn around it. */
  textbox(tx: number, ty: number, interiorW: number, interiorH: number): void {
    Chrome.box(tx, ty, interiorW + 2, interiorH + 2);
  },

  print(text: string, tx: number, ty: number): number {
    return Chrome.printThrough(text, tx, ty, Chrome.DEFAULT_BOX_PALETTE);
  },

  /** Chrome.lua:216 -- COLOR mode, optional inversion, then rBGP. */
  throughPalette(palette: Colors, invert?: boolean): Colors {
    let pal = GbcPalette.resolve(palette);
    if (invert) pal = [pal[3]!, pal[2]!, pal[1]!, pal[0]!];
    return GbcPalette.remap(pal, GbcPalette.bgp)!;
  },

  rawPalette(palette: Colors, invert?: boolean): Colors {
    return invert ? [palette[3]!, palette[2]!, palette[1]!, palette[0]!] : palette;
  },

  /**
   * Chrome.lua:241 -- [pal, drawGlyph(code, x, y), finish()]; pal is null
   * without a palette, and the glyphs then draw flat.
   */
  paletteGlyphs(
    palette?: Colors | null,
    invert?: boolean,
    raw?: boolean,
  ): [Colors | null, (code: number, x: number, y: number) => void, () => void] {
    if (!palette) return [null, Font.drawCode, () => {}];
    const pal = raw ? Chrome.rawPalette(palette, invert) : Chrome.throughPalette(palette, invert);
    const saved = G.palette;
    const savedKeyed = G.keyed;
    let shaded = false;
    const drawGlyph = (code: number, x: number, y: number): void => {
      if (!shaded) {
        G.setColor(1, 1, 1, 1);
        GbcPalette.useRaw(pal);
        G.claim();
        shaded = true;
      }
      Font.drawCode(code, x, y);
    };
    const finish = (): void => {
      if (shaded) {
        G.palette = saved;
        G.keyed = savedKeyed;
      }
      G.setColor(0, 0, 0, 1);
    };
    return [pal, drawGlyph, finish];
  },

  /** Chrome.lua:295 -- the string's cells: paper, then glyphs through the palette. */
  printThrough(text: string, tx: number, ty: number, palette?: Colors | null, invert?: boolean, raw?: boolean): number {
    if (palette) {
      const gp = raw ? Chrome.rawPalette(palette, invert) : Chrome.throughPalette(palette, invert);
      const w = gridPrint(Font.encode(text), tx * 8, ty * 8, gp);
      if (w >= 0) return w;
    }
    const [pal, drawGlyph, finish] = Chrome.paletteGlyphs(palette, invert, raw);
    if (!pal) return flatPrint(text, tx, ty);
    const width = Font.width(text);
    // settle the glyph palette first so the paper finds its colour 0
    drawGlyph(-1, 0, 0);
    setPaper(pal);
    G.rectangle("fill", tx * 8, ty * 8, width, 8);
    let pen = tx * 8;
    for (const code of Font.encode(text)) {
      drawGlyph(code, pen, ty * 8);
      pen += Font.advanceOf(code);
    }
    finish();
    return width;
  },

  /** Chrome.lua:316 -- through the inverted font (the #DEX's white on black). */
  printInverted(text: string, tx: number, ty: number, palette?: Colors | null): number {
    if (!palette) return Chrome.print(text, tx, ty);
    return Chrome.printThrough(text, tx, ty, palette, true);
  },

  /** Right-aligned in a field ending at tile `txEnd` (exclusive): PrintNum. */
  printRight(text: string, txEnd: number, ty: number): number {
    return Chrome.printRightThrough(text, txEnd, ty, Chrome.DEFAULT_BOX_PALETTE);
  },

  printRightThrough(text: string, txEnd: number, ty: number, palette?: Colors | null, invert?: boolean, raw?: boolean): number {
    if (palette) {
      const gp = raw ? Chrome.rawPalette(palette, invert) : Chrome.throughPalette(palette, invert);
      const codes = Font.encode(text);
      const w = gridPrint(codes, txEnd * 8 - codes.length * 8, ty * 8, gp);
      if (w >= 0) return w;
    }
    const [pal, drawGlyph, finish] = Chrome.paletteGlyphs(palette, invert, raw);
    const width = Font.width(text);
    const x = txEnd * 8 - width;
    if (!pal) {
      G.setColor(0, 0, 0, 1);
      return Font.draw(text, x, ty * 8);
    }
    drawGlyph(-1, 0, 0);
    setPaper(pal);
    G.rectangle("fill", x, ty * 8, width, 8);
    let pen = x;
    for (const code of Font.encode(text)) {
      drawGlyph(code, pen, ty * 8);
      pen += Font.advanceOf(code);
    }
    finish();
    return width;
  },

  /**
   * Chrome.lua:361 -- wrap to `width` tiles; "\n" is the cart's own hard
   * break.
   */
  wrap(text: unknown, width?: number): string[] {
    const budget = (width ?? Chrome.SCREEN_W) * 8;
    const lines: string[] = [];
    for (const segment of String(text ?? "").split("\n")) {
      let line: string | null = null;
      for (const word of segment.split(/\s+/).filter((w) => w !== "")) {
        const candidate: string = line !== null ? `${line} ${word}` : word;
        if (line !== null && Font.width(candidate) > budget) {
          lines.push(line);
          line = word;
        } else {
          line = candidate;
        }
      }
      if (line !== null) lines.push(line);
    }
    return lines;
  },

  /** Chrome.lua:381 -- ../pokecrystal/home/text.asm:473 */
  printWrapped(text: unknown, tx: number, ty: number, width?: number, rows?: number, step = 1, palette?: Colors | null): number {
    const lines = Chrome.wrap(text, width);
    const n = Math.min(lines.length, rows ?? lines.length);
    for (let i = 1; i <= n; i++) {
      if (palette) Chrome.printThrough(lines[i - 1]!, tx, ty + (i - 1) * step, palette);
      else Chrome.print(lines[i - 1]!, tx, ty + (i - 1) * step);
    }
    return lines.length;
  },

  cursor(tx: number, ty: number, hollow?: boolean): void {
    Chrome.cursorThrough(tx, ty, Chrome.DEFAULT_BOX_PALETTE, false, hollow);
  },

  /** Chrome.lua:411 -- the cursor glyph through a palette, on its paper. */
  cursorThrough(tx: number, ty: number, palette?: Colors | null, invert?: boolean, hollow?: boolean, raw?: boolean): void {
    if (!palette) {
      flatCursor(tx, ty, hollow);
      return;
    }
    const pal = raw ? Chrome.rawPalette(palette, invert) : Chrome.throughPalette(palette, invert);
    const saved = G.palette;
    const savedKeyed = G.keyed;
    GbcPalette.useRaw(pal);
    G.claim();
    setPaper(pal);
    G.rectangle("fill", tx * 8, ty * 8, 8, 8);
    G.setColor(1, 1, 1, 1);
    Font.drawCode(hollow ? Chrome.CURSOR_HOLLOW : Chrome.CURSOR, tx * 8, ty * 8);
    G.palette = saved;
    G.keyed = savedKeyed;
    G.setColor(0, 0, 0, 1);
  },

  /** Space-padded unless leadingZeros (PRINTNUM_LEADINGZEROS). */
  number(value: number | null | undefined, width?: number, leadingZeros?: boolean): string {
    const text = String(Math.floor(value ?? 0));
    const pad = Math.max(0, (width ?? 0) - text.length);
    return (leadingZeros ? "0" : " ").repeat(pad) + text;
  },

  /** Chrome.lua:441 -- PrintNum PRINTNUM_MONEY: the ¥ floats before the first digit. */
  money(amount: number | null | undefined): string {
    const digits = format("%06d", Math.max(0, Math.floor(amount ?? 0)));
    const m = /[1-9]/.exec(digits);
    const first = m ? m.index + 1 : digits.length;
    return " ".repeat(first - 1) + YEN + sub(digits, first);
  },

  /** engine/menus/menu_2.asm DisplayCoinCaseBalance */
  coinBalanceBox(coins: number): void {
    Chrome.textbox(11, 0, 7, 1);
    Chrome.printThrough("COIN", 12, 0, Chrome.DEFAULT_BOX_PALETTE);
    Chrome.printThrough(Chrome.number(coins, 4, true), 13, 1, Chrome.DEFAULT_BOX_PALETTE);
  },

  /** DisplayMoneyAndCoinBalance */
  moneyAndCoinBalanceBox(money: number, coins: number): void {
    Chrome.textbox(5, 0, 13, 3);
    Chrome.printThrough("MONEY", 6, 1, Chrome.DEFAULT_BOX_PALETTE);
    Chrome.printThrough(Chrome.money(money), 12, 1, Chrome.DEFAULT_BOX_PALETTE);
    Chrome.printThrough("COIN", 6, 3, Chrome.DEFAULT_BOX_PALETTE);
    Chrome.printThrough(Chrome.number(coins, 4, true), 15, 3, Chrome.DEFAULT_BOX_PALETTE);
  },

  /** PlaceMoneyTopRight */
  moneyBalanceBox(money: number): void {
    Chrome.box(11, 0, 9, 3);
    Chrome.printThrough(Chrome.money(money), 12, 1, Chrome.DEFAULT_BOX_PALETTE);
  },
};

export default Chrome;
