// ENHANCEMENTS: OPTION's ENHANCEMENTS page as a gear app, always on HOME
// and in the L/R order (ui/extras_layout.ts has the words, ../../../extras.ts,
// ../../../gamespeed.ts and ../../../visiblewild.ts what each one does).
//
//   the list      SPEED and the four toggles are pills at the right of
//                 their rows (SPEED 1X / 2X, the rest ON / OFF); VISIBLE
//                 WILD cycles OFF / SOME / MANY under its label, as CHEATS'
//                 WILD ENCOUNTERS does. The box at the foot says what the
//                 last row tapped does, its full name first.
//   the state     the same save.options keys OPTION's page reads and writes,
//                 through the same enhancementIndex / setEnhancement, so a
//                 change on either screen is the other's too.
//
// Laid out as CHEATS is: labels from column 1 (a column off the edge, as
// the STORE's list), whole -- one too long to leave a clear column before
// its pill has its row, and the value goes right-aligned on the row under
// it -- values ending in column 17 (their bars in 18), column 19 clear, a
// row clear under the header, two pages with a pager over the bottom row.
import { center, fill, pressedId, region, right, text, wrap } from "../draw.ts";
import { LIST_CAPTION_Y, LIST_LABEL_X, listLayout, listPager, type GearCtx, type ListSlot } from "../ui.ts";
import {
  ENHANCEMENT_GEAR, VISIBLE_WILD_ROW, enhancementDefs, enhancementIndex, setEnhancement, type ExtrasRowDef,
} from "../../extras_layout.ts";

/** Every value ends in column 17, its bar in 18; column 19 stays clear. */
const VALUE_END = 18;
/** The toggles' and SPEED's pills (CHEATS' TOGGLE_X). */
const TOGGLE_X = 15;
/** VISIBLE WILD's value, under its label (CHEATS' WILD_X). */
const CYCLE_X = 11;

function opts(ctx: GearCtx): Record<string, unknown> {
  return (ctx.save.options ??= {});
}

/** A row drawn on its own line with the value under it (a three-way). */
function cycles(d: ExtrasRowDef): boolean {
  return d === VISIBLE_WILD_ROW;
}

/** The gear's label for a row: OPTION's own, whole (no cut-down names). */
export function gearLabel(d: ExtrasRowDef): string {
  return d.label;
}

/** The box's words for a row at its current choice. */
export function gearAbout(d: ExtrasRowDef, choice: string): string {
  const a = ENHANCEMENT_GEAR[d.key]?.about;
  if (!a) return d.label;
  return typeof a === "string" ? a : (a[choice] ?? "");
}

/** A pill whose label is right-aligned, ending in column 17 (CHEATS'
 *  valuePill): lit when `on`, inverted under the finger. */
function valuePill(ctx: GearCtx, id: string, x: number, y: number, label: string, tap: () => void, on = false): void {
  const { host } = ctx;
  const w = VALUE_END - x + 1;
  const lit = on !== (pressedId() === id);
  if (!lit) fill(host, x, y, w, 1);
  right(host, y, label, lit ? "dark" : "fill", VALUE_END);
  region(id, x, y, w, 1, tap);
}

/** Where each row goes (ui.ts listLayout): whole labels, a value on the
 *  label's row when it leaves a clear column, else on the row under it;
 *  two pages (SPEED to TRADE EVO, then HMS and VISIBLE WILD). */
export function enhancementRows(): { slots: ListSlot[]; pages: number } {
  return listLayout(enhancementDefs().map((d) => ({
    label: gearLabel(d), x: cycles(d) ? CYCLE_X : TOGGLE_X, below: cycles(d),
  })));
}

export function drawEnhancements(ctx: GearCtx): void {
  const { host, ui } = ctx;
  const o = opts(ctx);
  const defs = enhancementDefs();
  const { slots, pages } = enhancementRows();
  const page = Math.min(Math.max(0, ui.page ?? 0), pages - 1);
  defs.forEach((d, i) => {
    const r = slots[i]!;
    if (r.page !== page) return;
    const at = enhancementIndex(o, d);
    const next = () => {
      ui.sel = i;
      setEnhancement(o, d, (at + 1) % d.choices.length);
    };
    text(host, LIST_LABEL_X, r.label, gearLabel(d));
    // SPEED's 2X and a toggle's ON a dark bar; 1X and OFF lifted off it,
    // the STORE's toggle look; VISIBLE WILD's three always a bar
    valuePill(ctx, `enh:${d.key}`, r.x, r.value, d.choices[at] ?? "", next, !cycles(d) && at === 0);
  });
  // what the last row tapped does (a row of this page): two lines over the
  // pager, a row clear either side
  let sel = ui.sel ?? 0;
  if (slots[sel]?.page !== page) sel = slots.findIndex((s) => s.page === page);
  const d = defs[sel] ?? defs[0]!;
  const said = gearAbout(d, d.choices[enhancementIndex(o, d)] ?? "");
  wrap(said, 18).slice(0, 2).forEach((line, k) => center(host, LIST_CAPTION_Y + k, line));
  if (pages > 1) listPager(ctx, "enh:page", page, pages, (p) => { ui.page = p; ui.sel = undefined; });
}

/** The rows' values, for the gear's still-frame key (kantogear.ts): the
 *  page is drawn again when OPTION changes one under it. */
export function enhancementsKey(save: { options?: Record<string, unknown> } | undefined): string {
  const o = save?.options ?? {};
  return enhancementDefs().map((d) => enhancementIndex(o, d)).join("");
}
