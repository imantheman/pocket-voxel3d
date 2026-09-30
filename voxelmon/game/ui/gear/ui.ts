// Kanto Gear app scaffolding: what every app is handed (GearCtx), where it
// keeps its own screen state, and the chrome they share -- the header with
// its arrows and clock, the page tabs along the bottom, a BACK pill.
import { UI_TILE } from "../../../../contracts/spec/voxel-spec.ts";
import { ARROW_CURSOR } from "../tiles.ts";
import { COLS, FILL_BIT, LIGHT_BIT, ROWS, fill, pill, region, text, width, type GearHost } from "./draw.ts";
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
 * main.rs paints the bar; everything here is drawn light over it. */
export function header(ctx: GearCtx, title: string, opts: HeaderOpts = {}): void {
  const { host } = ctx;
  const many = !!opts.arrows;
  const w = width(title) + (many ? 4 : 0);
  const x = Math.max(0, Math.floor((CLOCK_COL - w) / 2));
  if (many) {
    host.uiTileBottom(x, 0, UI_TILE.arrowLeft | LIGHT_BIT);
    host.uiTileBottom(x + w - 1, 0, ARROW_CURSOR | LIGHT_BIT);
    if (opts.onLeft) region("hdr:left", 0, 0, x + 1, 1, opts.onLeft);
    if (opts.onRight) region("hdr:right", x + w - 1, 0, Math.max(1, CLOCK_COL - (x + w - 1)), 1, opts.onRight);
  }
  text(host, x + (many ? 2 : 0), 0, title, "light");
  if (opts.onTitle) region("hdr:title", x + (many ? 1 : 0), 0, width(title) + 2, 1, opts.onTitle);
  const aside = opts.aside ?? clockStr(ctx.gear.clock24);
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

/** Open a view (HOME, or an app), the one place views change. */
export function go(ctx: GearCtx, view: GearViewId): void {
  ctx.game.setGearView?.(view);
}
