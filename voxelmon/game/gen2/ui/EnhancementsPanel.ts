// The bottom screen's ENHANCEMENTS page (ui/Companion.ts draws it under its
// own tab, which is always there). Not the cart's: the rows are OPTION's
// ENHANCEMENTS page -- the very row objects (OptionsMenu.enhancementRows),
// so the two read and write the same option keys with the same values and
// words, and a change on either shows on the other. What each one does is
// core/Cheats.ts (and voxelmon/game/gamespeed.ts for SPEED). Drawn in the
// CHEATS page's style -- labels from column 1, values right-aligned to
// column 18, a label too long to share its row with its value has the value
// on the row below -- and worked by touch alone:
//
//   row 0      the title, ENHANCEMENTS, where the other pages name the place
//   row 1      the time and the money, as on every page
//   rows 3-12  SPEED, EXP FOR CATCHING, PARTY EXP SHARE, TRADE EVO LV.40,
//              HMS WITHOUT MOVE, VISIBLE WILD: a tap on a row steps its value
//   row 13     clear, above the tabs, as on the other pages

import { Chrome } from "./Chrome.ts";
import { cachedBlock } from "../platform/screen.ts";
import { Strings } from "../shared/core/Strings.ts";
import { enhancementRows, type OptionRow } from "./OptionsMenu.ts";

const COLS = 20;
/** Where values end: printRight's edge, one column in from the screen's. */
const RIGHT = COLS - 1;
/** The page's title, and the word its tab would carry as text (one place). */
export const ENHANCEMENTS_TITLE = "ENHANCEMENTS";
/** The first row a setting stands on. */
const TOP = 3;

interface Placed {
  row: OptionRow;
  label: string;
  /** The row it starts on, and whether its value goes on the row below. */
  y: number;
  twoLine: boolean;
}

/** The widest a row's value gets: its ladder stepped through on a scratch table. */
function widest(row: OptionRow): number {
  const o: Record<string, any> = {};
  let w = 0;
  for (let i = 0; i < 8; i++) {
    w = Math.max(w, Strings.get(row.text!(o)).length);
    row.cycle!(o, 1);
  }
  return w;
}

export class EnhancementsPanel {
  private placed: Placed[] | null = null;

  /** The rows and where each stands (worked out once). */
  layout(): Placed[] {
    if (this.placed) return this.placed;
    const out: Placed[] = [];
    let y = TOP;
    for (const row of enhancementRows()) {
      if (!row.text || !row.cycle) continue;
      const label = Strings.get(row.label);
      const twoLine = 1 + label.length + 1 + widest(row) > RIGHT;
      out.push({ row, label, y, twoLine });
      y += twoLine ? 2 : 1;
    }
    this.placed = out;
    return out;
  }

  /** Each row's value as shown: what the page shows, for Companion's change check. */
  values(game: any): string[] {
    const o = game?.options ?? {};
    return this.layout().map((p) => Strings.get(p.row.text!(o)));
  }

  signature(game: any): string {
    return `E|${this.values(game).join("|")}`;
  }

  /** A tap at cell (cx, cy) of the page: the row under it steps, as RIGHT on OPTION does. */
  tap(game: any, _cx: number, cy: number): void {
    if (!game) return;
    if (!game.options || typeof game.options !== "object") game.options = {};
    for (const p of this.layout()) {
      if (cy >= p.y && cy < p.y + (p.twoLine ? 2 : 1)) {
        p.row.cycle!(game.options, 1, game);
        console.log(`[pv] gold enhancements: ${p.row.key} = ${String(game.options[p.row.key!])}`);
        // kept in this game's options file at once (OPTION writes it as it closes)
        game.persistOptions?.();
        return;
      }
    }
  }

  draw(game: any): void {
    Chrome.print(ENHANCEMENTS_TITLE, 0, 0);
    const values = this.values(game);
    // the rows are still while their values stand: recorded once and replayed
    cachedBlock(this, values.join("|"), () => {
      this.layout().forEach((p, i) => {
        Chrome.print(p.label, 1, p.y);
        Chrome.printRight(values[i]!, RIGHT, p.twoLine ? p.y + 1 : p.y);
      });
    });
  }
}

export default EnhancementsPanel;
