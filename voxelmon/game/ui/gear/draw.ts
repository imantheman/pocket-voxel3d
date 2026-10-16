// Kanto Gear drawing: the bottom screen's 20x18 GB-tile grid, the sprite and
// rect ops beside it, and the tap targets every panel registers as it draws.
//
// A panel draws AND declares where it can be touched in the same pass
// (button/pill/region), so the hit test always matches what is on screen:
// the touch handler (kantogear.ts) tests a tap against the targets the last
// frame drew, lights the one under the finger, and fires it on release.
import {
  ARROW_CURSOR,
  BORDER_BL,
  BORDER_BR,
  BORDER_H,
  BORDER_TL,
  BORDER_TR,
  BORDER_V,
  encodeGlyphs,
  SPACE,
} from "../tiles.ts";
import { UI_PAGE_COLS, UI_TILE } from "../../../../contracts/spec/voxel-spec.ts";
import type { VoxelHost } from "../../host.ts";

export const COLS = 20;
export const ROWS = 18;
/** The bottom target is 320x240 filled by the grid (main.rs tpxx/tpxy). */
export const TILE_W = 320 / COLS; // 16
export const TILE_H = 240 / ROWS; // 13.33

/** Glyph drawn light-green: text on the dark header bar (main.rs LIGHT_BIT). */
export const LIGHT_BIT = 0x8000;
/** A solid dark cell with its glyph light: the selected look (FILL_BIT). */
export const FILL_BIT = 0x4000;
/** A dark glyph with no cell behind it: ordinary text and borders. */
export const DARKTEXT_BIT = 0x2000;
/** The cell drawn half a cell (8 px) to the right (main.rs HALF_BIT): how a
 *  label whose width and its space's do not share a parity sits centred. */
export const HALF_BIT = 0x1000;

export type Ink = "dark" | "light" | "fill";
const INK_BIT: Record<Ink, number> = { dark: DARKTEXT_BIT, light: LIGHT_BIT, fill: FILL_BIT };

/** The host surface the gear draws through. The sprite-rect and rect ops are
 * optional: an older host draws nothing for them. */
export type GearHost = Pick<VoxelHost, "uiTileBottom" | "uiClearBottom" | "uiSpriteBottom"> &
  Partial<Pick<VoxelHost, "uiSpriteRectBottom" | "uiRectBottom">>;

// ---------------------------------------------------------------------------
// tap targets
// ---------------------------------------------------------------------------

export interface Target {
  id: string;
  /** Bottom-screen px. */
  x: number;
  y: number;
  w: number;
  h: number;
  tap: () => void;
}

let targets: Target[] = [];
let pressed: string | null = null;

/** Start a frame's targets afresh (drawKantoGear calls it first). */
export function beginTargets(): void {
  targets = [];
}

/** The targets the last frame drew, topmost last. */
export function currentTargets(): readonly Target[] {
  return targets;
}

/** The id under the finger, or null. */
export function pressedId(): string | null {
  return pressed;
}

export function setPressed(id: string | null): void {
  pressed = id;
}

/** The topmost target at a px, or undefined. */
export function targetAt(x: number, y: number): Target | undefined {
  for (let i = targets.length - 1; i >= 0; i--) {
    const t = targets[i]!;
    if (x >= t.x && x < t.x + t.w && y >= t.y && y < t.y + t.h) return t;
  }
  return undefined;
}

/** A tap target in cells. */
export function region(id: string, cx: number, cy: number, cw: number, ch: number, tap: () => void): void {
  targets.push({ id, x: cx * TILE_W, y: cy * TILE_H, w: cw * TILE_W, h: ch * TILE_H, tap });
}

/** A tap target in px (the map, the notes pad). */
export function regionPx(id: string, x: number, y: number, w: number, h: number, tap: () => void): void {
  targets.push({ id, x, y, w, h, tap });
}

// ---------------------------------------------------------------------------
// glyphs
// ---------------------------------------------------------------------------

/** Text at a cell, clipped to the grid. Returns the glyph count. The GB
 * font has no "%" or "+": dark text draws them from rects in their cells. */
export function text(host: GearHost, x: number, y: number, s: string, ink: Ink = "dark"): number {
  if (ink === "dark" && /[%+]/.test(s)) {
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "%") percent(host, x + width(s.slice(0, i)), y);
      else if (s[i] === "+") plus(host, x + width(s.slice(0, i)), y);
    }
  }
  const codes = encodeGlyphs(s);
  const bit = INK_BIT[ink];
  for (let i = 0; i < codes.length && x + i < COLS; i++) {
    if (x + i < 0) continue;
    host.uiTileBottom(x + i, y, codes[i]! | bit);
  }
  if (ink === "dark" && host.uiRectBottom && /[%+]/.test(s)) {
    // the drawn "%" and "+" sit under the grid: their cells stay empty, or
    // the glyph's paper would cover them (they never showed)
    for (let i = 0; i < s.length; i++) {
      const cx = x + width(s.slice(0, i));
      if ((s[i] === "%" || s[i] === "+") && cx >= 0 && cx < COLS) host.uiTileBottom(cx, y, 0);
    }
  }
  return codes.length;
}

/** A "%" in a cell: two dots and a stepped slash, darkest green. */
function percent(host: GearHost, cx: number, cy: number): void {
  if (!host.uiRectBottom || cx < 0 || cx >= COLS) return;
  const x = Math.round(cx * TILE_W) + 3;
  const y = Math.round(cy * TILE_H) + 2;
  host.uiRectBottom(x, y, 3, 3, 3);
  host.uiRectBottom(x + 7, y + 7, 3, 3, 3);
  for (let k = 0; k < 5; k++) host.uiRectBottom(x + 8 - k * 2, y + k * 2, 2, 2, 3);
}

/** A "+" in a cell. */
function plus(host: GearHost, cx: number, cy: number): void {
  if (!host.uiRectBottom || cx < 0 || cx >= COLS) return;
  const x = Math.round(cx * TILE_W);
  const y = Math.round(cy * TILE_H);
  host.uiRectBottom(x + 7, y + 3, 3, 8, 3);
  host.uiRectBottom(x + 4, y + 6, 9, 2, 3);
}

/** Glyph width of a string (ligatures count once). */
export function width(s: string): number {
  return encodeGlyphs(s).length;
}

/** Text centred in [x0, x0 + w). */
export function center(host: GearHost, y: number, s: string, ink: Ink = "dark", x0 = 0, w = COLS): void {
  text(host, x0 + Math.max(0, Math.floor((w - width(s)) / 2)), y, s, ink);
}

/** Text ending one cell in from `right` (exclusive). */
export function right(host: GearHost, y: number, s: string, ink: Ink = "dark", rightEdge = COLS - 1): void {
  text(host, Math.max(0, rightEdge - width(s)), y, s, ink);
}

/** Raw tile codes (an HP bar) at a cell. */
export function tiles(host: GearHost, x: number, y: number, codes: number[], bit = 0): void {
  for (let i = 0; i < codes.length && x + i < COLS; i++) host.uiTileBottom(x + i, y, codes[i]! | bit);
}

/** One tile. */
export function tile(host: GearHost, x: number, y: number, code: number, ink: Ink = "dark"): void {
  host.uiTileBottom(x, y, code | INK_BIT[ink]);
}

/** A solid dark block of cells. */
export function fill(host: GearHost, x0: number, y0: number, w: number, h: number): void {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w && x < COLS; x++) host.uiTileBottom(x, y, SPACE | FILL_BIT);
  }
}

/** A GB text-box border; the interior is left alone. */
export function box(host: GearHost, x0: number, y0: number, w: number, h: number, ink: Ink = "dark"): void {
  const bit = ink === "fill" ? 0 : INK_BIT[ink];
  const x1 = x0 + w - 1;
  const y1 = y0 + h - 1;
  host.uiTileBottom(x0, y0, BORDER_TL | bit);
  host.uiTileBottom(x1, y0, BORDER_TR | bit);
  host.uiTileBottom(x0, y1, BORDER_BL | bit);
  host.uiTileBottom(x1, y1, BORDER_BR | bit);
  for (let x = x0 + 1; x < x1; x++) {
    host.uiTileBottom(x, y0, BORDER_H | bit);
    host.uiTileBottom(x, y1, BORDER_H | bit);
  }
  for (let y = y0 + 1; y < y1; y++) {
    host.uiTileBottom(x0, y, BORDER_V | bit);
    host.uiTileBottom(x1, y, BORDER_V | bit);
  }
}

/** A horizontal rule of border tiles. */
export function rule(host: GearHost, y: number, x0 = 0, w = COLS): void {
  for (let x = x0; x < x0 + w && x < COLS; x++) host.uiTileBottom(x, y, BORDER_H | DARKTEXT_BIT);
}

/** The ▶ cursor. */
export function cursor(host: GearHost, x: number, y: number, ink: Ink = "dark"): void {
  host.uiTileBottom(x, y, ARROW_CURSOR | INK_BIT[ink]);
}

// ---------------------------------------------------------------------------
// buttons
// ---------------------------------------------------------------------------

/**
 * Text centred on a pixel column of the bottom screen: its glyphs on the
 * grid, shifted half a cell (HALF_BIT) where the label's width and the
 * centre do not meet on a cell edge -- a five-letter word in a six-cell
 * pill sits in the middle, not half a cell to one side.
 */
export function textCenteredPx(host: GearHost, centerPx: number, y: number, s: string, ink: Ink): void {
  const codes = encodeGlyphs(s);
  const start = Math.round(centerPx - (codes.length * TILE_W) / 2);
  const cell = Math.floor(start / TILE_W);
  const half = start - cell * TILE_W >= TILE_W / 2 ? HALF_BIT : 0;
  const bit = INK_BIT[ink] | half;
  for (let i = 0; i < codes.length; i++) {
    const cx = cell + i;
    if (cx >= 0 && cx < COLS) host.uiTileBottom(cx, y, codes[i]! | bit);
  }
}

/** A row's top and bottom in px, on the host's own cell edges (main.rs
 *  truncates cy * 240 / 18). */
function rowPx(y: number): [number, number] {
  return [Math.floor(y * TILE_H), Math.floor((y + 1) * TILE_H)];
}

/**
 * A one-row button: a solid dark bar with its label light, the look the
 * battle panel's selected option has. Under the finger it inverts (light
 * bar, dark label) so a press is seen before it fires. `on` draws it
 * inverted permanently -- the chosen tab, a toggle that is set. The bar is
 * a flat rect under the grid and the label is centred to the pixel
 * (textCenteredPx); a host without rects gets the bar in cells.
 */
export function pill(
  host: GearHost,
  id: string,
  x: number,
  y: number,
  w: number,
  label: string,
  tap: () => void,
  on = false,
): void {
  pillPx(host, id, x * TILE_W, y, w * TILE_W, label, tap, on);
}

/** pill() at any pixel x and width (HOME's grid, an even margin round it). */
export function pillPx(
  host: GearHost,
  id: string,
  xPx: number,
  y: number,
  wPx: number,
  label: string,
  tap: () => void,
  on = false,
): void {
  const lit = on !== (pressed === id);
  const [top, bot] = rowPx(y);
  if (!host.uiRectBottom) {
    // the old cells: a bar of fill, the label cell-centred
    const x = Math.round(xPx / TILE_W), w = Math.round(wPx / TILE_W);
    if (!lit) fill(host, x, y, w, 1);
    center(host, y, label, lit ? "dark" : "fill", x, w);
  } else {
    // inverted: the label dark on the paper, the bar gone
    if (!lit) host.uiRectBottom(Math.round(xPx), top, Math.round(wPx), bot - top, 3);
    textCenteredPx(host, xPx + wPx / 2, y, label, lit ? "dark" : "light");
  }
  regionPx(id, xPx, top, wPx, bot - top, tap);
}

/** A bordered button; filled while pressed or when `on`. */
export function button(
  host: GearHost,
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  tap: () => void,
  on = false,
): void {
  const lit = on || pressed === id;
  if (lit) fill(host, x, y, w, h);
  box(host, x, y, w, h, lit ? "fill" : "dark");
  center(host, y + Math.floor((h - 1) / 2), label, lit ? "fill" : "dark", x + 1, w - 2);
  region(id, x, y, w, h, tap);
}

// ---------------------------------------------------------------------------
// sprites and rects
// ---------------------------------------------------------------------------

/** A whole atlas page into a px rect (a front pic, the town map). */
export function sprite(host: GearHost, page: number, x: number, y: number, w: number, h: number): void {
  if (page >= 0) host.uiSpriteBottom(page, Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

/** One 16x16 frame of an overworld sprite sheet (frame 0 faces down). */
export function spriteFrame(
  host: GearHost,
  page: number,
  x: number,
  y: number,
  size: number,
  frame = 0,
  mirror = false,
): void {
  if (page < 0 || !host.uiSpriteRectBottom) return;
  host.uiSpriteRectBottom(page, Math.round(x), Math.round(y), size, size, 0, frame * 16, 16, 16, mirror ? 1 : 0);
}

/** A UI-page tile blown up (a badge quarter, the ball). */
export function uiTileIcon(host: GearHost, uiPage: number, code: number, x: number, y: number, size: number): void {
  if (uiPage < 0 || !host.uiSpriteRectBottom) return;
  const sx = (code % UI_PAGE_COLS) * 8;
  const sy = Math.floor(code / UI_PAGE_COLS) * 8;
  host.uiSpriteRectBottom(uiPage, Math.round(x), Math.round(y), size, size, sx, sy, 8, 8, 0);
}

/** A badge's 2x2 art (trainer_card/badges), face or badge half. */
export function badgeIcon(host: GearHost, uiPage: number, gym: number, x: number, y: number, cell: number, face = false): void {
  const base = UI_TILE.badge + gym * UI_TILE.badgeStride + (face ? 0 : UI_TILE.badgeHalf);
  uiTileIcon(host, uiPage, base, x, y, cell);
  uiTileIcon(host, uiPage, base + 1, x + cell, y, cell);
  uiTileIcon(host, uiPage, base + 2, x, y + cell, cell);
  uiTileIcon(host, uiPage, base + 3, x + cell, y + cell, cell);
}

/** A flat rect, under the grid: shade 0 light .. 3 darkest. */
export function rect(host: GearHost, x: number, y: number, w: number, h: number, shade: number): void {
  if (w <= 0 || h <= 0) return;
  host.uiRectBottom?.(Math.round(x), Math.round(y), Math.round(w), Math.round(h), shade);
}

// ---------------------------------------------------------------------------
// text layout
// ---------------------------------------------------------------------------

/** Word-wrap to `w` glyphs a line; a word longer than a line is cut. */
export function wrap(s: string, w: number): string[] {
  const out: string[] = [];
  for (const para of s.split("\n")) {
    let line = "";
    for (const word of para.split(" ")) {
      if (!word) continue;
      const next = line ? `${line} ${word}` : word;
      if (width(next) <= w) { line = next; continue; }
      if (line) out.push(line);
      line = width(word) <= w ? word : word.slice(0, w);
    }
    out.push(line);
  }
  return out;
}

/** Cut to `n` glyphs, ending in an ellipsis when it had to be cut. */
export function fit(s: string, n: number): string {
  if (width(s) <= n) return s;
  let cut = s.slice(0, Math.max(1, n - 1));
  while (cut.length > 1 && width(cut) > n - 1) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

/** A label at column `x` and its value right-aligned to end before
 * `rightEdge` (exclusive): the label/value rows of the info pages. */
export function row(host: GearHost, y: number, label: string, value: string, x = 1, rightEdge = COLS - 1, ink: Ink = "dark"): void {
  text(host, x, y, label, ink);
  right(host, y, value, ink, rightEdge);
}

/** A scrolled window over `count` rows that keeps `sel` in view. */
export function windowTop(sel: number, count: number, visible: number, top: number): number {
  let t = Math.min(top, Math.max(0, count - visible));
  if (sel < t) t = sel;
  if (sel >= t + visible) t = sel - visible + 1;
  return Math.max(0, t);
}

// ---------------------------------------------------------------------------
// drag targets (the notes pad): the finger's path while it stays down
// ---------------------------------------------------------------------------

export interface DragTarget {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** A point of the stroke, in bottom-screen px; `start` on the first. */
  move: (x: number, y: number, start: boolean) => void;
}

let drags: DragTarget[] = [];

export function beginDrags(): void {
  drags = [];
}

/** A px rect that follows the stylus while it is down inside it. */
export function dragPx(id: string, x: number, y: number, w: number, h: number,
  move: (x: number, y: number, start: boolean) => void): void {
  drags.push({ id, x, y, w, h, move });
}

export function dragAt(x: number, y: number): DragTarget | undefined {
  return drags.find((d) => x >= d.x && x < d.x + d.w && y >= d.y && y < d.y + d.h);
}

export function dragById(id: string): DragTarget | undefined {
  return drags.find((d) => d.id === id);
}
