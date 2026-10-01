// gen1recomp src/render/Font.lua (bdfac727): the tile font and charmap,
// drawing onto the Gold screen.
//
// Glyphs live on pages -- fonts/font holds codes $80-$FF, fonts/font_extra
// $60-$7F, fonts/font_battle_extra swaps in at $60 during battle
// (Font.useBattleExtra), and fonts/frames answers $79-$7E with the chosen
// text box frame. A glyph is one tile of its page's cooked image, so
// drawing a code is putting that tile id at a cell (or an object, off the
// grid). The TTF path (Font.lua's translations) does not exist here.
//
// Strings are JavaScript strings: the charmap's sequences ("é", "<PK>",
// "'d") are matched greedily, longest first, as Font.split does on bytes.
// Span positions are 1-based character indices, as in the Lua.

import { putTile, putTiles } from "../../platform/screen.ts";
import G from "../../platform/screen.ts";
import { Assets } from "./Assets.ts";
import { Logger } from "../core/Logger.ts";
import type { LcdImage } from "../../platform/screen.ts";

const GLYPH = 8;
// engine/gfx/load_font.asm:29 LoadFrame (Font.lua:24)
const FRAME_BASE = 0x79;
const FRAME_TILES = 6;
// Font.lua:252 -- charmap $7F
const SPACE = 0x7f;
// Font.lua:224 -- FontBattleExtra's 25 tiles
const BATTLE_EXTRA_TILES = 25;

export interface FontDef {
  image?: string;
  imageExtra?: string;
  imageBattleExtra?: string;
  imageFrames?: string;
  mainBase?: number;
  extraBase?: number;
  glyphsPerRow?: number;
  frameBase?: number;
  frameTiles?: number;
  charmap?: { seq: string; code: number }[];
  border?: Record<string, number>;
  pages?: Record<string, { image: string; base: number; glyphsPerRow?: number; advance?: number; charmap?: { seq: string; code: number }[] }>;
}

interface Page {
  id: string;
  image: LcdImage;
  base: number;
  perRow: number;
  /** Frames: the row of the frames sheet this page reads. */
  row?: number;
  advance: number;
}

interface Span {
  from: number;
  to: number;
  code?: number;
}

interface State {
  def: FontDef;
  pages: Record<string, Page>;
  order: Page[];
  byFirst: Map<string, { seq: string; code: number }[]>;
  frameBase: number;
  frameTiles: number;
  framePages?: Page[];
  battleExtra?: boolean;
}

let state: State | null = null;
let loadedFrom: { font: FontDef } | null = null;
let currentFrame = 1;
const reported = new Set<string>();
// Font.encode's answers, per string: a menu prints the same few strings every
// frame. Bounded, and dropped whenever the font changes. Callers only read
// the arrays.
let encoded = new Map<string, number[]>();
const ENCODED_MAX = 512;

// Font.lua:47
function pagesOf(def: FontDef): Record<string, { image: string; base: number; glyphsPerRow: number; inactive?: boolean; advance?: number }> {
  const pages: Record<string, { image: string; base: number; glyphsPerRow: number; inactive?: boolean; advance?: number }> = {};
  if (def.image) pages.main = { image: def.image, base: def.mainBase ?? 0x80, glyphsPerRow: def.glyphsPerRow ?? 16 };
  if (def.imageExtra) pages.extra = { image: def.imageExtra, base: def.extraBase ?? 0x60, glyphsPerRow: def.glyphsPerRow ?? 16 };
  if (def.imageBattleExtra) {
    pages.battleExtra = {
      image: def.imageBattleExtra,
      base: def.extraBase ?? 0x60,
      glyphsPerRow: def.glyphsPerRow ?? 16,
      inactive: true,
    };
  }
  for (const [id, page] of Object.entries(def.pages ?? {})) {
    if (page && page.image) pages[id] = { glyphsPerRow: 16, ...page };
  }
  return pages;
}

/** Font.lua:227 */
function pageFor(code: number): Page | null {
  if (!state) return null;
  const frames = state.framePages;
  if (frames && code >= state.frameBase && code < state.frameBase + state.frameTiles) {
    const page = frames[currentFrame - 1];
    if (page) return page;
  }
  if (state.battleExtra && state.pages.battleExtra) {
    const swap = state.pages.battleExtra;
    if (code >= swap.base && code < swap.base + BATTLE_EXTRA_TILES) return swap;
  }
  for (const page of state.order) if (code >= page.base) return page;
  return null;
}

/** The tile id a code draws as, or undefined. */
function tileOf(code: number): number | undefined {
  const page = pageFor(code);
  if (!page) return undefined;
  const g = code - page.base;
  if (page.row !== undefined) {
    // a frames row: glyph g is tile g of that row
    return page.image.ids[page.row * page.image.tw + g];
  }
  const col = g % page.perRow;
  const row = Math.floor(g / page.perRow);
  if (row >= page.image.th || col >= page.image.tw) return undefined;
  return page.image.ids[row * page.image.tw + col];
}

export const Font = {
  TTF_BASE: 0x400000,
  DEFAULT_BORDER: { tl: 0x79, h: 0x7a, tr: 0x7b, v: 0x7c, bl: 0x7d, br: 0x7e } as Record<string, number>,
  BORDER: { tl: 0x79, h: 0x7a, tr: 0x7b, v: 0x7c, bl: 0x7d, br: 0x7e } as Record<string, number>,

  /** Font.lua:112 -- `data.font` is the importer's font.json. */
  load(data: { font: FontDef }): void {
    loadedFrom = data;
    const def = data.font;
    const s: State = {
      def,
      pages: {},
      order: [],
      byFirst: new Map(),
      frameBase: def.frameBase ?? FRAME_BASE,
      frameTiles: def.frameTiles ?? FRAME_TILES,
    };
    for (const [id, page] of Object.entries(pagesOf(def))) {
      let img: LcdImage;
      try {
        img = Assets.image(page.image);
      } catch {
        continue;
      }
      const entry: Page = { id, image: img, base: page.base, perRow: page.glyphsPerRow, advance: page.advance ?? GLYPH };
      s.pages[id] = entry;
      if (!page.inactive) s.order.push(entry);
    }
    if (def.imageFrames) {
      try {
        const img = Assets.image(def.imageFrames);
        s.framePages = [];
        for (let row = 0; row < img.th; row++) {
          s.framePages.push({ id: "frames", image: img, base: s.frameBase, perRow: s.frameTiles, row, advance: GLYPH });
        }
      } catch {
        // no frames sheet: the extra page's row 0 answers $79-$7E
      }
    }
    s.order.sort((a, b) => b.base - a.base);
    const bucket = (entry: { seq?: unknown; code?: unknown }): void => {
      if (typeof entry?.seq !== "string" || entry.seq === "" || typeof entry.code !== "number") return;
      const first = entry.seq[0]!;
      let list = s.byFirst.get(first);
      if (!list) s.byFirst.set(first, (list = []));
      list.push(entry as { seq: string; code: number });
    };
    for (const e of def.charmap ?? []) bucket(e);
    for (const page of Object.values(def.pages ?? {})) for (const e of page.charmap ?? []) bucket(e);
    for (const list of s.byFirst.values()) list.sort((a, b) => b.seq.length - a.seq.length);
    Font.BORDER = { ...Font.DEFAULT_BORDER, ...(def.border ?? {}) };
    state = s;
    encoded = new Map();
  },

  ttfActive(): boolean {
    return false;
  },

  invalidate(): void {
    if (loadedFrom) Font.load(loadedFrom);
  },

  /** Font.lua:242 -- swap FontBattleExtra in at $60; returns the old state. */
  useBattleExtra(on: boolean): boolean {
    if (!state) return false;
    const was = state.battleExtra ?? false;
    state.battleExtra = !!on;
    return was;
  },
  battleExtraActive(): boolean {
    return state?.battleExtra === true;
  },
  setFrame(index: number): void {
    currentFrame = Math.floor(Number(index) || 1);
  },
  frameIndex(): number {
    return currentFrame;
  },

  /** Font.lua:303 -- greedy charmap segmentation; `#` spells POKé. */
  split(text: string): Span[] {
    const spans: Span[] = [];
    const n = text.length;
    let i = 0;
    while (i < n) {
      const ch = text[i]!;
      const candidates = state?.byFirst.get(ch);
      if (!candidates && ch === "#") {
        for (const sub of Font.split("POKé")) spans.push({ from: i + 1, to: i + 1, code: sub.code });
        i += 1;
        continue;
      }
      let span: Span | null = null;
      for (const entry of candidates ?? []) {
        if (text.startsWith(entry.seq, i)) {
          span = { from: i + 1, to: i + entry.seq.length, code: entry.code };
          break;
        }
      }
      if (!span) {
        // one character (a surrogate pair counts as one)
        const cp = text.codePointAt(i)!;
        const len = cp > 0xffff ? 2 : 1;
        span = { from: i + 1, to: i + len };
      }
      spans.push(span);
      i = span.to;
    }
    return spans;
  },

  /** Font.lua:366 */
  spansFitting(spans: Span[], budget: number): number {
    let used = 0;
    let fit = 0;
    for (const span of spans) {
      used += Font.advanceOf(span.code ?? SPACE);
      if (used > budget) break;
      fit++;
    }
    return fit;
  },

  /** Font.lua:377 -- codes; an unmapped character is a space (logged once). */
  encode(text: string): number[] {
    const hit = encoded.get(text);
    if (hit) return hit;
    const codes: number[] = [];
    for (const span of Font.split(text)) {
      let code = span.code;
      if (code === undefined) {
        const ch = text.slice(span.from - 1, span.to);
        if (!reported.has(ch) && ch.charCodeAt(0) >= 32) {
          reported.add(ch);
          Logger.warn("font: no glyph for %q", ch);
        }
        code = SPACE;
      }
      codes.push(code);
    }
    if (encoded.size >= ENCODED_MAX) encoded.clear();
    encoded.set(text, codes);
    return codes;
  },

  /** Font.lua:394 -- one glyph at pixel (x, y) of the current transform. */
  drawCode(code: number, x: number, y: number): void {
    const id = tileOf(code);
    if (id === undefined) return;
    putTile(id, Math.round(x + G.tx), Math.round(y + G.ty));
  },

  /** The tile id a code draws as (for screens that write cells directly). */
  tileOf,

  advanceOf(code: number): number {
    const page = pageFor(code);
    return page ? page.advance : GLYPH;
  },

  width(text: string): number {
    let w = 0;
    for (const code of Font.encode(text)) w += Font.advanceOf(code);
    return w;
  },

  /** Font.lua:431 -- returns the width drawn. */
  draw(text: string, x: number, y: number): number {
    let pen = x;
    for (const code of Font.encode(text)) {
      Font.drawCode(code, pen, y);
      pen += Font.advanceOf(code);
    }
    return pen - x;
  },

  /**
   * Font.lua:446 -- a bordered box in tile coords: the interior in the
   * palette's colour 0 (the fill colour, when one is given and no palette
   * is active), the frame from the frame glyphs.
   */
  drawBox(tx: number, ty: number, tw: number, th: number, fill?: readonly number[]): void {
    const saved = G.getColor();
    if (fill && fill.length >= 3) G.setColor(fill[0]! / 255, fill[1]! / 255, fill[2]! / 255, 1);
    else G.setColor(1, 1, 1, 1);
    // with a palette active the Lua's white rectangle is drawn through it:
    // colour 0 of that palette, which is the blank tile in the palette
    // the interior in one block (putBlank's cells, one palette lookup)
    const bx = Math.round(tx * 8 + G.tx);
    const by = Math.round(ty * 8 + G.ty);
    if (fill && fill.length >= 3) {
      const savedPal = G.palette;
      G.palette = [[fill[0]!, fill[1]!, fill[2]!], savedPal[1]!, savedPal[2]!, savedPal[3]!];
      putTiles(0, bx, by, tw, th);
      G.palette = savedPal;
    } else {
      putTiles(0, bx, by, tw, th);
    }
    G.setColor(saved);
    const B = Font.BORDER;
    Font.drawCode(B.tl!, tx * 8, ty * 8);
    Font.drawCode(B.tr!, (tx + tw - 1) * 8, ty * 8);
    Font.drawCode(B.bl!, tx * 8, (ty + th - 1) * 8);
    Font.drawCode(B.br!, (tx + tw - 1) * 8, (ty + th - 1) * 8);
    for (let i = 1; i <= tw - 2; i++) {
      Font.drawCode(B.h!, (tx + i) * 8, ty * 8);
      Font.drawCode(B.h!, (tx + i) * 8, (ty + th - 1) * 8);
    }
    for (let j = 1; j <= th - 2; j++) {
      Font.drawCode(B.v!, tx * 8, (ty + j) * 8);
      Font.drawCode(B.v!, (tx + tw - 1) * 8, (ty + j) * 8);
    }
  },
};

Assets.register(Font.invalidate);

export default Font;
