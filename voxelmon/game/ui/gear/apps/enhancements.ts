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
// Laid out as CHEATS is: labels at the left edge, values ending in column
// 17 (their bars in 18), column 19 clear, a row clear under the header.
import { center, fill, pressedId, region, right, text, wrap } from "../draw.ts";
import type { GearCtx } from "../ui.ts";
import {
  ENHANCEMENT_GEAR, VISIBLE_WILD_ROW, enhancementDefs, enhancementIndex, setEnhancement, type ExtrasRowDef,
} from "../../extras_layout.ts";

/** Every value ends in column 17, its bar in 18; column 19 stays clear. */
const VALUE_END = 18;
/** The pills of the inline rows: a column after the longest label
 *  (TRADE EVO LV40, fourteen glyphs). */
const TOGGLE_X = 15;
/** VISIBLE WILD's value, under its label (CHEATS' WILD_X). */
const CYCLE_X = 11;
/** One clear row under the header. */
const FIRST_Y = 2;

function opts(ctx: GearCtx): Record<string, unknown> {
  return (ctx.save.options ??= {});
}

/** A row drawn on its own line with the value under it (a three-way). */
function cycles(d: ExtrasRowDef): boolean {
  return d === VISIBLE_WILD_ROW;
}

/** The gear's label for a row (OPTION's when no short one is set). */
export function gearLabel(d: ExtrasRowDef): string {
  return ENHANCEMENT_GEAR[d.key]?.label ?? d.label;
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

export function drawEnhancements(ctx: GearCtx): void {
  const { host, ui } = ctx;
  const o = opts(ctx);
  const defs = enhancementDefs();
  let y = FIRST_Y;
  defs.forEach((d, i) => {
    const at = enhancementIndex(o, d);
    const next = () => {
      ui.sel = i;
      setEnhancement(o, d, (at + 1) % d.choices.length);
    };
    text(host, 0, y, gearLabel(d));
    if (cycles(d)) {
      // the label has the row to itself; its value sits under it, right
      valuePill(ctx, `enh:${d.key}`, CYCLE_X, y + 1, d.choices[at] ?? "", next);
      y += 3;
      return;
    }
    // SPEED's 2X and a toggle's ON a dark bar; 1X and OFF lifted off it,
    // the STORE's toggle look
    valuePill(ctx, `enh:${d.key}`, TOGGLE_X, y, d.choices[at] ?? "", next, at === 0);
    y += 2;
  });
  // what the last row tapped does: two lines a row clear of the rows above
  // and of the bottom edge
  const d = defs[ui.sel ?? 0] ?? defs[0]!;
  const said = gearAbout(d, d.choices[enhancementIndex(o, d)] ?? "");
  wrap(said, 18).slice(0, 2).forEach((line, k) => center(host, y + k, line));
}

/** The rows' values, for the gear's still-frame key (kantogear.ts): the
 *  page is drawn again when OPTION changes one under it. */
export function enhancementsKey(save: { options?: Record<string, unknown> } | undefined): string {
  const o = save?.options ?? {};
  return enhancementDefs().map((d) => enhancementIndex(o, d)).join("");
}
