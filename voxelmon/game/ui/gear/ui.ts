// Kanto Gear app scaffolding: what every app is handed (GearCtx), where it
// keeps its own screen state, and the chrome they share -- the header with
// its arrows and clock, the page tabs along the bottom, a BACK pill.
import { UI_TILE } from "../../../../contracts/spec/voxel-spec.ts";
import { ARROW_CURSOR } from "../tiles.ts";
import { COLS, DARKTEXT_BIT, FILL_BIT, LIGHT_BIT, ROWS, fill, pill, pressedId, region, text, width, type GearHost } from "./draw.ts";
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
  /** Draw ◀ ▶ either side of the title (the app switcher). */
  arrows?: boolean;
  onLeft?: () => void;
  onRight?: () => void;
  /** Tapping the title (apps go HOME). */
  onTitle?: () => void;
  /** A light label at the far right instead of the clock (battle panels). */
  aside?: string;
}

/** The dark bar on row 0: the title between its arrows, the clock right.
 * main.rs paints the bar; everything here is drawn light over it. A title
 * too long to leave the clock its columns (ENHANCEMENTS, sixteen with its
 * arrows) has the bar to itself, centred, a column clear of either end. */
export function header(ctx: GearCtx, title: string, opts: HeaderOpts = {}): void {
  const { host } = ctx;
  const many = !!opts.arrows;
  const w = width(title) + (many ? 4 : 0);
  const wide = w > CLOCK_COL && opts.aside === undefined;
  const x = wide ? Math.max(1, Math.floor((COLS - w) / 2)) : Math.max(0, Math.floor((CLOCK_COL - w) / 2));
  if (many) {
    host.uiTileBottom(x, 0, UI_TILE.arrowLeft | LIGHT_BIT);
    host.uiTileBottom(x + w - 1, 0, ARROW_CURSOR | LIGHT_BIT);
    if (opts.onLeft) region("hdr:left", 0, 0, x + 1, 1, opts.onLeft);
    const rightEnd = wide ? COLS : CLOCK_COL;
    if (opts.onRight) region("hdr:right", x + w - 1, 0, Math.max(1, rightEnd - (x + w - 1)), 1, opts.onRight);
  }
  text(host, x + (many ? 2 : 0), 0, title, "light");
  if (opts.onTitle) region("hdr:title", x + (many ? 1 : 0), 0, width(title) + 2, 1, opts.onTitle);
  const aside = wide ? "" : opts.aside ?? clockStr(ctx.gear.clock24);
  if (aside) text(host, Math.max(0, COLS - width(aside) - 1), 0, aside, "light");
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
