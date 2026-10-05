// Port of gen1recomp src/ui/game3/window.lua (GPLv3 + additional terms; see LICENSE.md).
// Pret-style WindowTemplate helpers for game3 (tile coords on 240×160).
// Mirrors struct WindowTemplate { tilemapLeft, tilemapTop, width, height }.

import { tostring } from "../../../import/gen3/lua.ts";
import { G } from "../platform/graphics.ts";
import { Display } from "../core/display.ts";
import { Chrome } from "./chrome.ts";
import { FrlgFont, type Colors, type FontOpts } from "./frlg_font.ts";

export interface WindowTemplate {
  tilemapLeft: number; tilemapTop: number; width: number; height: number; paletteNum: number;
  left: number; top: number; w: number; h: number;
}
/** A template-like table: pret names or the short aliases. */
export type TemplateLike = Partial<WindowTemplate>;
export interface PrintOpts {
  ox?: number; oy?: number; maxWidth?: number; clipTiles?: number; colors?: Colors; limitChars?: number; small?: boolean;
  [k: string]: unknown;
}

const T: number = Display.TILE;

export const Window = {
  // FrlgFont glyphs are ~14px tall (LINE_PITCH 15). One tile is 8px, so menu
  // list rows MUST advance by 2 tiles or lines overlap.
  ROW_STRIDE: 2,
  TEXT_OY: 0, // pixel nudge inside a row (pret printers often +0/+1)
  // pret Menu_InitCursor / PrintStartMenuItems: cursor at x=0, labels at x=8,
  // optionHeight=15. Cursor is gText_SelectorArrow2 (charmap ▶ = 0xEF).
  CURSOR_WIDTH: 8,
  OPTION_HEIGHT: 15, // start menu / Menu_InitCursor pitch in pixels

  /** Build a template table (pret field names + short aliases). */
  // Lua: window.lua:22
  template(left: number, top: number, width: number, height: number, opts?: { paletteNum?: number }): WindowTemplate {
    opts = opts || {};
    return {
      tilemapLeft: left,
      tilemapTop: top,
      width,
      height,
      paletteNum: opts.paletteNum ?? 15,
      left,
      top,
      w: width,
      h: height,
    };
  },

  // Lua: window.lua:37
  fill(tpl: TemplateLike, r?: number, g?: number, b?: number, a?: number): void {
    const L = (tpl.left ?? tpl.tilemapLeft)!, Top = (tpl.top ?? tpl.tilemapTop)!,
      W = (tpl.w ?? tpl.width)!, H = (tpl.h ?? tpl.height)!;
    G.setColor(r ?? 1, g ?? 1, b ?? 1, a ?? 1);
    G.rectangle("fill", L * T, Top * T, W * T, H * T);
    G.setColor(1, 1, 1, 1);
  },

  /** Std 9-slice frame around content rect (content = left,top,width,height tiles). */
  // Lua: window.lua:46
  stdFrame(tpl: TemplateLike): void {
    const L = (tpl.left ?? tpl.tilemapLeft)!;
    const Top = (tpl.top ?? tpl.tilemapTop)!;
    const W = (tpl.w ?? tpl.width)!;
    const H = (tpl.h ?? tpl.height)!;
    Chrome.stdFrame(L, Top, W, H);
  },

  // pokefirered/src/text_window.c:80
  // Lua: window.lua:55
  fixedStdFrame(tpl: TemplateLike): void {
    Chrome.fixedStdFrame((tpl.left ?? tpl.tilemapLeft)!, (tpl.top ?? tpl.tilemapTop)!,
      (tpl.w ?? tpl.width)!, (tpl.h ?? tpl.height)!);
  },

  // Lua: window.lua:60
  userFrame(tpl: TemplateLike, frameType: unknown): void {
    Chrome.userFrame(frameType, (tpl.left ?? tpl.tilemapLeft)!, (tpl.top ?? tpl.tilemapTop)!,
      (tpl.w ?? tpl.width)!, (tpl.h ?? tpl.height)!);
  },

  // Lua: window.lua:65
  dialogueFrame(): void {
    Chrome.dialogueFrame();
  },

  // Lua: window.lua:69
  signFrame(): void {
    Chrome.signFrame();
  },

  /** Print with FrlgFont at tile (tx, ty) + optional pixel offsets. */
  // Lua: window.lua:74
  print(text: unknown, tx: number, ty: number, opts?: PrintOpts): void {
    opts = opts || {};
    const px = tx * T + (opts.ox ?? 0);
    const py = ty * T + (opts.oy != null ? opts.oy : Window.TEXT_OY);
    let maxW = opts.maxWidth;
    if (maxW == null && opts.clipTiles != null) {
      maxW = opts.clipTiles * T;
    }
    FrlgFont.draw(tostring(text != null ? text : ""), px, py, {
      maxWidth: maxW ?? (Display.COLS * T),
      colors: opts.colors || FrlgFont.COLOR.NORMAL,
      limitChars: opts.limitChars,
    });
  },

  // pokefirered/src/new_menu_helpers.c:61
  // Lua: window.lua:90
  printPx(text: unknown, px: number, py: number, opts?: PrintOpts): void {
    opts = opts || {};
    FrlgFont.draw(tostring(text != null ? text : ""), px, py, {
      maxWidth: opts.maxWidth ?? (Display.COLS * T),
      colors: opts.colors || FrlgFont.COLOR.NORMAL,
      limitChars: opts.limitChars,
      small: opts.small,
    });
  },

  /**
   * FRLG menu cursor: pret gText_SelectorArrow2 (charmap ▶ = 0xEF).
   * Drawn from ROM-extracted glyph sheet (latin_normal @ sFontNormalLatinGlyphs),
   * same dark-gray + shadow as menu text. Labels start CURSOR_WIDTH (8) px after.
   */
  // Lua: window.lua:103
  cursor(tx: number, ty: number, opts?: PrintOpts): void {
    opts = opts || {};
    const px = tx * T + (opts.ox ?? 0);
    const py = ty * T + (opts.oy != null ? opts.oy : Window.TEXT_OY);
    FrlgFont.drawGlyph(FrlgFont.CHAR_SELECTOR_ARROW, px, py, {
      colors: opts.colors || FrlgFont.COLOR.NORMAL,
    });
  },

  /** Pixel-space cursor (for 15px start-menu rows). */
  // Lua: window.lua:113
  cursorPx(px: number, py: number, opts?: PrintOpts): void {
    opts = opts || {};
    FrlgFont.drawGlyph(FrlgFont.CHAR_SELECTOR_ARROW, px, py, {
      colors: opts.colors || FrlgFont.COLOR.NORMAL,
    });
  },

  /** Label X after cursor column (pret text at +8px). */
  // Lua: window.lua:121
  labelTx(cursorTx: number): number {
    return cursorTx + 1;
  },

  /** Double-spaced menu row Y in tiles (approx; prefer menuRowPx for start menu). */
  // Lua: window.lua:126
  menuRowY(baseTop: number, index1: number): number {
    return baseTop + (index1 - 1) * Window.ROW_STRIDE;
  },

  // pokeemerald/src/menu.c:1203
  // Lua: window.lua:131
  optionHeight(opts?: FontOpts): number {
    const face = FrlgFont.face ? FrlgFont.face(opts) : undefined;
    if (face) return face.height;
    return Window.OPTION_HEIGHT;
  },

  /** Pret Menu_InitCursor option row Y in pixels. */
  // Lua: window.lua:138
  menuRowPx(baseTopPx: number, index1: number): number {
    return baseTopPx + (index1 - 1) * Window.optionHeight();
  },

  /** How many double-spaced rows fit in a content height (tiles), given headerTiles. */
  // Lua: window.lua:143
  fitRows(contentH: number, headerTiles?: number): number {
    headerTiles = headerTiles ?? 0;
    const avail = contentH - headerTiles;
    if (avail < Window.ROW_STRIDE) return 1;
    return Math.floor(avail / Window.ROW_STRIDE);
  },
};

export default Window;
