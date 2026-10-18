// Kanto Gear app scaffolding: what every app is handed (GearCtx), where it
// keeps its own screen state, and the chrome they share -- the header with
// its arrows and clock, the page tabs along the bottom, a BACK pill.
import { UI_TILE } from "../../../../contracts/spec/voxel-spec.ts";
import { ARROW_CURSOR, encodeGlyphs } from "../tiles.ts";
import {
  COLS, DARKTEXT_BIT, FILL_BIT, HALF_BIT, LIGHT_BIT, ROWS, TILE_H, TILE_W,
  fill, pill, pressedId, region, regionPx, text, width, type GearHost,
} from "./draw.ts";
import { gearSave, type GearSave, type GearViewId } from "./model.ts";

/**
 * The game as the gear sees it. Loose on purpose (the gear reads a wide slice
 * of the game and couples to none of its types); every path used exists on
 * VoxelmonGame.
 */
export type GearGame = any;

export interface GearCtx {
  host: GearHost;
  game: GearGame;
  data: any;
  save: any;
  gear: GearSave;
  /** This app's own screen state (page, selection, scroll). */
  ui: Record<string, any>;
}

/** Build the context for one app, its state kept on game.gearUi[app]. */
export function ctxFor(host: GearHost, game: GearGame, app: string): GearCtx {
  const all = (game.gearUi ??= {}) as Record<string, Record<string, any>>;
  const ui = (all[app] ??= {});
  return { host, game, data: game.data, save: game.save, gear: gearSave(game.save), ui };
}

// ---------------------------------------------------------------------------
// the clock
// ---------------------------------------------------------------------------

/** The device clock, 12- or 24-hour; "" when the runtime has none. */
export function clockStr(clock24: boolean): string {
  try {
    const d = new Date();
    const m = d.getMinutes();
    const h = d.getHours();
    const mm = m < 10 ? `0${m}` : String(m);
    if (clock24) return `${h < 10 ? "0" : ""}${h}:${mm}`;
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${mm}${h >= 12 ? "PM" : "AM"}`;
  } catch {
    return "";
  }
}

/** Columns left of the clock: 8 wide ("12:59PM" and a margin). */
export const CLOCK_COL = COLS - 8;

// ---------------------------------------------------------------------------
// the header
// ---------------------------------------------------------------------------

export interface HeaderOpts {
  /** Draw ◀ ▶ either side of the title, with their L and R keys (the app
   *  switcher). */
  arrows?: boolean;
  onLeft?: () => void;
  onRight?: () => void;
  /** Tapping the title (apps go HOME). */
  onTitle?: () => void;
  /** A light label at the far right instead of the clock (battle panels). */
  aside?: string;
}

/** The dark bar on row 0: the title between its arrows, the clock right.
 * main.rs paints the bar; everything here is drawn light over it. An app's
 * header is the switcher (switcherHeader). Any other title is centred in
 * the columns left of the clock. */
export function header(ctx: GearCtx, title: string, opts: HeaderOpts = {}): void {
  if (opts.arrows) {
    switcherHeader(ctx, title, opts);
    return;
  }
  const { host } = ctx;
  const w = width(title);
  const wide = w > CLOCK_COL && opts.aside === undefined;
  const x = wide ? Math.max(1, Math.floor((COLS - w) / 2)) : Math.max(0, Math.floor((CLOCK_COL - w) / 2));
  text(host, x, 0, title, "light");
  if (opts.onTitle) region("hdr:title", x, 0, w, 1, opts.onTitle);
  const aside = wide ? "" : opts.aside ?? clockStr(ctx.gear.clock24);
  if (aside) text(host, Math.max(0, COLS - width(aside) - 1), 0, aside, "light");
}

// ---------------------------------------------------------------------------
// the app switcher: [L] ◀ TITLE ▶ [R]
// ---------------------------------------------------------------------------

/** The bar's height in px (main.rs paints rows 0..1 of 240/18). */
const BAR_PX = Math.floor(TILE_H);
/**
 * A shoulder-button key: a light key with its letter dark, a px of the bar
 * clear above and below it. It sits against its arrow's cell, not in it: a
 * light glyph's cell is drawn opaque, so a key reaching into it is cut off.
 * The font's arrows leave the outer part of their cells empty (the ◀'s ink
 * starts 4 px in, the ▶'s ends 4 px short), which is the gap between a key
 * and its arrow.
 */
export const KEY_W = 9;
const KEY_H = BAR_PX - 2;
/** Clear px at least between the switcher and the screen's edge, and between
 *  it and the clock. */
export const SWITCHER_EDGE = 6;
/** The keys' letters, 1 px horizontal strokes and 2 px vertical ones, as the
 *  font's glyphs are drawn on this screen. */
const KEY_GLYPH: Record<"L" | "R", string[]> = {
  L: ["XX...", "XX...", "XX...", "XX...", "XX...", "XX...", "XXXXX"],
  R: ["XXXX.", "XX.XX", "XX.XX", "XXXX.", "XX.X.", "XX.XX", "XX.XX"],
};

/** Where an app header's parts go, in bottom-screen px. */
export interface SwitcherLayout {
  /** The ◀ cell's left edge, the title's first cell's, the ▶ cell's. */
  left: number;
  title: number;
  right: number;
  /** The L key's and the R key's left edges (KEY_W wide). */
  keyL: number;
  keyR: number;
  /** The clock's first cell, or -1 when the switcher has the bar to itself. */
  clock: number;
}

/** The px the whole switcher spans, key to key, for a title `n` glyphs long:
 *  the arrows half a cell off the title, each key against its arrow's cell. */
export function switcherWidth(n: number): number {
  return KEY_W + 16 + 8 + n * 16 + 8 + 16 + KEY_W;
}

/**
 * Lay the switcher out: centred in the room left of the clock, SWITCHER_EDGE
 * clear of the screen's edge and of the clock, the arrows and the title on
 * the grid's half cells (HALF_BIT). The room is measured against the widest
 * the clock gets in its mode ("12:59PM", "23:59"), so a header does not move
 * when the hour does; a title that only fits beside the clock it shows now
 * (EXPLORER beside "9:47AM") centres in that room instead; and one that fits
 * beside neither (ENHANCEMENTS; EXPLORER beside "12:59PM") has the bar to
 * itself, centred, as it always has.
 */
export function switcherLayout(n: number, clock: string, clock24: boolean): SwitcherLayout {
  const w = switcherWidth(n);
  const lead = KEY_W; // the L key's edge to the ◀ cell's
  const clockAt = (s: string): number => (COLS - width(s) - 1) * TILE_W;
  const rooms: [number, number, number][] = [];
  if (clock) {
    rooms.push([SWITCHER_EDGE, clockAt(clock24 ? "23:59" : "12:59PM") - SWITCHER_EDGE, clockAt(clock)]);
    rooms.push([SWITCHER_EDGE, clockAt(clock) - SWITCHER_EDGE, clockAt(clock)]);
  }
  rooms.push([SWITCHER_EDGE, COLS * TILE_W - SWITCHER_EDGE, -1]);
  let room = rooms[rooms.length - 1]!;
  // (the whole bar: centred, whatever fits)
  let left = Math.max(0, Math.round((room[0] + (room[1] - room[0] - w) / 2 + lead) / 8) * 8);
  for (const r of rooms) {
    const [a, b] = r;
    // the ◀ cell on a half cell, as near the centre as fits
    const lo = Math.ceil((a + lead) / 8) * 8;
    const hi = Math.floor((b - w + lead) / 8) * 8;
    if (hi < lo) continue;
    const ideal = a + (b - a - w) / 2 + lead;
    left = Math.min(hi, Math.max(lo, Math.round(ideal / 8) * 8));
    room = r;
    break;
  }
  const title = left + 24;
  const right = title + n * 16 + 8;
  return { left, title, right, keyL: left - KEY_W, keyR: right + 16, clock: room[2] };
}

/** Glyphs from a px column on the grid's half cells (HALF_BIT). */
function textAtPx(host: GearHost, px: number, y: number, codes: number[], bit: number): void {
  const cell = Math.floor(px / TILE_W);
  const half = px - cell * TILE_W >= TILE_W / 2 ? HALF_BIT : 0;
  for (let i = 0; i < codes.length; i++) {
    const cx = cell + i;
    if (cx >= 0 && cx < COLS) host.uiTileBottom(cx, y, codes[i]! | bit | half);
  }
}

/** One shoulder-button key on the bar: a light key, corners cut, its letter
 *  in the darkest green. Rects draw over the bar and under the grid. */
function shoulderKey(host: GearHost, x: number, letter: "L" | "R"): void {
  if (!host.uiRectBottom) return;
  const y = Math.floor((BAR_PX - KEY_H) / 2);
  host.uiRectBottom(x + 1, y, KEY_W - 2, KEY_H, 0);
  host.uiRectBottom(x, y + 1, KEY_W, KEY_H - 2, 0);
  const rows = KEY_GLYPH[letter];
  const gw = rows[0]!.length;
  const gx = x + Math.ceil((KEY_W - gw) / 2);
  const gy = y + Math.floor((KEY_H - rows.length) / 2);
  // each run of a row, merged down while the rows under it repeat it
  const done = rows.map(() => new Set<number>());
  rows.forEach((row, ry) => {
    for (let rx = 0; rx < gw; rx++) {
      if (row[rx] !== "X" || done[ry]!.has(rx)) continue;
      let len = 1;
      while (rx + len < gw && row[rx + len] === "X") len++;
      const run = row.slice(rx, rx + len);
      const edgeOk = (r: string): boolean => r.slice(rx, rx + len) === run && r[rx - 1] !== "X" && r[rx + len] !== "X";
      let h = 1;
      if (edgeOk(row)) while (ry + h < rows.length && edgeOk(rows[ry + h]!)) h++;
      for (let k = 0; k < h; k++) for (let j = 0; j < len; j++) done[ry + k]!.add(rx + j);
      host.uiRectBottom!(gx + rx, gy + ry, len, h, 3);
      rx += len - 1;
    }
  });
}

/** An app's header: its title between ◀ and ▶, each arrow with the
 *  shoulder button that turns the gear that way beside it, and the clock. */
function switcherHeader(ctx: GearCtx, title: string, opts: HeaderOpts): void {
  const { host } = ctx;
  const n = width(title);
  const clock = opts.aside ?? clockStr(ctx.gear.clock24);
  const L = switcherLayout(n, clock, ctx.gear.clock24);
  textAtPx(host, L.left, 0, [UI_TILE.arrowLeft], LIGHT_BIT);
  textAtPx(host, L.right, 0, [ARROW_CURSOR], LIGHT_BIT);
  textAtPx(host, L.title, 0, encodeGlyphs(title), LIGHT_BIT);
  shoulderKey(host, L.keyL, "L");
  shoulderKey(host, L.keyR, "R");
  const end = L.clock >= 0 ? L.clock : COLS * TILE_W;
  if (opts.onLeft) regionPx("hdr:left", 0, 0, L.left + TILE_W, TILE_H, opts.onLeft);
  if (opts.onRight) regionPx("hdr:right", L.right, 0, Math.max(TILE_W, end - L.right), TILE_H, opts.onRight);
  if (opts.onTitle) regionPx("hdr:title", L.left + TILE_W, 0, L.right - L.left - TILE_W, TILE_H, opts.onTitle);
  if (L.clock >= 0 && clock) text(host, L.clock / TILE_W, 0, clock, "light");
}

// ---------------------------------------------------------------------------
// page tabs and BACK along the bottom row
// ---------------------------------------------------------------------------

export interface Tab {
  id: string;
  label: string;
}

/** Page tabs across row 17, the chosen one inverted. */
export function tabs(ctx: GearCtx, list: Tab[], active: string, pick: (id: string) => void, y = ROWS - 1): void {
  if (list.length === 0) return;
  const w = Math.floor(COLS / list.length);
  list.forEach((t, i) => {
    const x = i * w;
    const cw = i === list.length - 1 ? COLS - x : w;
    pill(ctx.host, `tab:${t.id}`, x, y, cw, t.label, () => pick(t.id), t.id === active);
  });
}

/** A full-width bar along the bottom with a centred light label. */
export function bottomBar(ctx: GearCtx, label: string): void {
  fill(ctx.host, 0, ROWS - 1, COLS, 1);
  text(ctx.host, Math.max(0, Math.floor((COLS - width(label)) / 2)), ROWS - 1, label, "fill");
}

/** BACK (left) and an optional second pill (right) on the bottom row. */
export function backRow(ctx: GearCtx, back: () => void, other?: { label: string; tap: () => void }): void {
  pill(ctx.host, "back", 0, ROWS - 1, other ? 10 : COLS, "BACK", back);
  if (other) pill(ctx.host, "back:other", 10, ROWS - 1, 10, other.label, other.tap);
}

/** ◀ and ▶ pills at the ends of the bottom row (prev/next item), with a
 * label between them. */
export function stepper(ctx: GearCtx, label: string, prev: () => void, next: () => void, y = ROWS - 1): void {
  pill(ctx.host, "step:prev", 0, y, 3, "", prev);
  ctx.host.uiTileBottom(1, y, UI_TILE.arrowLeft | FILL_BIT);
  pill(ctx.host, "step:next", COLS - 3, y, 3, "", next);
  ctx.host.uiTileBottom(COLS - 2, y, ARROW_CURSOR | FILL_BIT);
  fill(ctx.host, 3, y, COLS - 6, 1);
  text(ctx.host, 3 + Math.max(0, Math.floor((COLS - 6 - width(label)) / 2)), y, label, "fill");
}

// ---------------------------------------------------------------------------
// settings lists (CHEATS, ENHANCEMENTS): labels, values, pages
// ---------------------------------------------------------------------------

/** Labels a column in from the edge, as the STORE's list. */
export const LIST_LABEL_X = 1;
/** The last row an item may use; the caption's two lines; the pager. Each
 *  has a clear row before it, and row 17 stays clear. */
export const LIST_LAST_ROW = 11;
export const LIST_CAPTION_Y = 13;
export const LIST_PAGER_Y = 16;

export interface ListSlot {
  page: number;
  /** The label's row, and the value's (the same, or the row under it). */
  label: number;
  value: number;
  /** The value pill's first column. */
  x: number;
}

/**
 * Where a settings list's rows go. A label (whole, never cut down) that
 * leaves a clear column before its pill shares the row; a longer one, or
 * one marked `below`, has its row and the value sits right-aligned on the
 * row under it. A clear row after every item; what does not fit above the
 * caption goes on the next page.
 */
export function listLayout(items: readonly { label: string; x: number; below?: boolean }[]): { slots: ListSlot[]; pages: number } {
  const slots: ListSlot[] = [];
  let page = 0;
  let y = 2;
  for (const it of items) {
    const inline = !it.below && LIST_LABEL_X + width(it.label) < it.x;
    const h = inline ? 1 : 2;
    if (y + h - 1 > LIST_LAST_ROW) { page += 1; y = 2; }
    slots.push({ page, label: y, value: inline ? y : y + 1, x: it.x });
    y += h + 1;
  }
  return { slots, pages: page + 1 };
}

/** ◀ PAGE 1/2 ▶ on the pager row: the arrows as their own pills a column
 *  in from either edge, the label between them on the paper. */
export function listPager(ctx: GearCtx, id: string, page: number, pages: number, go: (page: number) => void): void {
  const { host } = ctx;
  const y = LIST_PAGER_Y;
  // the arrow light on the bar, dark while the finger lifts the bar away
  const ink = (pid: string): number => (!host.uiRectBottom ? FILL_BIT : pressedId() === pid ? DARKTEXT_BIT : LIGHT_BIT);
  pill(host, `${id}:prev`, 1, y, 3, "", () => go((page + pages - 1) % pages));
  host.uiTileBottom(2, y, UI_TILE.arrowLeft | ink(`${id}:prev`));
  pill(host, `${id}:next`, COLS - 4, y, 3, "", () => go((page + 1) % pages));
  host.uiTileBottom(COLS - 3, y, ARROW_CURSOR | ink(`${id}:next`));
  const label = `PAGE ${page + 1}/${pages}`;
  text(host, Math.floor((COLS - width(label)) / 2), y, label);
}

/** Open a view (HOME, or an app), the one place views change. */
export function go(ctx: GearCtx, view: GearViewId): void {
  ctx.game.setGearView?.(view);
}
