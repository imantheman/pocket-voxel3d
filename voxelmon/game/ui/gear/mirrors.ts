// Touch for the game's own screens (the mod's contextual touch menus). The
// words stay where the game puts them, on the top screen, in its own text
// boxes; the bottom screen only offers something to tap:
//
//   a text box       -- a tap anywhere is A (next page / close)
//   YES / NO         -- two big buttons
//   a menu           -- its choices as buttons (START, the bag, the PC):
//                       any state with gearMenu() gets this
//   the naming grid  -- the letters as a keyboard, with DEL and END
//
// A tap puts the game's own cursor where it was aimed and presses A through
// the real input, so the game runs exactly as it would from the buttons.
import { COLS, ROWS, box, fill, fit, pill, text, width } from "./draw.ts";
import { header, type GearCtx } from "./ui.ts";

/** A state's menu, for the bottom screen to mirror. */
export interface GearMenu {
  title?: string;
  items: string[];
  index: number;
  /** Put the cursor on item i (the mirror then presses A). */
  select(i: number): void;
}

function top(game: any): any {
  return game.stack?.[game.stack.length - 1];
}

/** What the top of the stack wants from a tap, or null for the gear's own. */
export function mirrorKind(game: any): "text" | "choice" | "menu" | "naming" | null {
  const t = top(game);
  if (!t) return null;
  if (t.kind === "choice") return "choice";
  if (t.kind === "naming") return "naming";
  if (typeof t.gearMenu === "function" && t.gearMenu()) return "menu";
  if (t.kind === "textbox") return "text";
  return null;
}

function pressA(game: any): void {
  game.input?.injectPress?.("a");
}

/** Draw the mirror for the top state; false when there is none to draw
 * (a text box keeps the gear's own screen and just takes the tap). */
export function drawMirror(ctx: GearCtx): boolean {
  const kind = mirrorKind(ctx.game);
  const t = top(ctx.game);
  const { host, game } = ctx;
  if (kind === "choice") {
    header(ctx, "CHOOSE");
    box(host, 2, 4, 16, 10);
    pill(host, "m:yes", 4, 6, 12, "YES", () => { t.yes = true; pressA(game); }, !!t.yes);
    pill(host, "m:no", 4, 10, 12, "NO", () => { t.yes = false; pressA(game); }, !t.yes);
    return true;
  }
  if (kind === "menu") {
    const m: GearMenu = t.gearMenu();
    header(ctx, fit(m.title ?? "MENU", 11));
    const n = m.items.length;
    const perCol = n > 8 ? Math.ceil(n / 2) : n;
    m.items.forEach((label, i) => {
      const col = Math.floor(i / perCol);
      const row = i % perCol;
      const w = n > 8 ? 10 : COLS;
      pill(host, `m:${i}`, col * 10, 2 + row * 2, w, fit(label, w - 2), () => {
        m.select(i);
        pressA(game);
      }, i === m.index);
    });
    pill(host, "m:back", 0, ROWS - 1, COLS, "BACK", () => game.input?.injectPress?.("b"));
    return true;
  }
  if (kind === "naming") {
    drawNaming(ctx, t);
    return true;
  }
  return false;
}

/** The naming grid as a keyboard: every cell a key, then DEL and END. */
function drawNaming(ctx: GearCtx, t: any): void {
  const { host, game } = ctx;
  const v = t.view();
  header(ctx, fit(v.title ?? "NAME?", 11));
  text(host, 1, 1, `${v.name}${"_".repeat(Math.max(0, (v.maxLen ?? 7) - v.name.length))}`);
  const grid: string[][] = v.grid;
  grid.forEach((row, r) => {
    const wide = row.length === 1;
    row.forEach((cell, c) => {
      const w = wide ? COLS : 2;
      const x = wide ? 0 : c * 2 + 1;
      const label = cell === "lower case" ? "lower case" : cell === "UPPER CASE" ? "UPPER CASE" : cell;
      pill(host, `n:${r}:${c}`, x, 3 + r * 2, w, label, () => {
        t.touchCell?.(r, c);
        pressA(game);
      }, v.row === r && v.col === c);
    });
  });
  pill(host, "n:del", 0, ROWS - 1, 10, "DEL", () => game.input?.injectPress?.("b"));
  pill(host, "n:end", 10, ROWS - 1, 10, "END", () => game.input?.injectPress?.("start"));
}

/** A tap that hit nothing while a text box is up: next page. */
export function mirrorTapThrough(game: any): boolean {
  if (mirrorKind(game) !== "text") return false;
  pressA(game);
  return true;
}

/** The strip a text box puts along the bottom, so the tap is discoverable. */
export function drawTextHint(ctx: GearCtx): void {
  if (mirrorKind(ctx.game) !== "text") return;
  fill(ctx.host, 0, ROWS - 1, COLS, 1);
  const s = "TAP TO CONTINUE";
  text(ctx.host, Math.floor((COLS - width(s)) / 2), ROWS - 1, s, "fill");
}
