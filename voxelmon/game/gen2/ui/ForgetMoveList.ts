// gen1recomp src/ui/gen2/ForgetMoveList.lua (bdfac727, MIT): the four-row
// "which move should be forgotten?" box -- engine/pokemon/learn.asm:135-166.

import { Chrome } from "./Chrome.ts";

type Colors = readonly (readonly number[])[];

export interface ForgetMoveEntry {
  id: string;
  [k: string]: unknown;
}

// Lua: ForgetMoveList.lua:5
export const ForgetMoveList = {
  x: 5,
  y: 2,
  interiorW: 13,
  interiorH: 8,
  cursorX: 6,
  nameX: 7,
  y0: 4,
  step: 2,
  rows: 4,

  /** Lua: ForgetMoveList.lua:10 */
  rowY(slot: number): number {
    return ForgetMoveList.y0 + (slot - 1) * ForgetMoveList.step;
  },

  /** Lua: ForgetMoveList.lua:14 */
  label(entry: ForgetMoveEntry | null | undefined, moveData?: Record<string, any> | null): string {
    if (!entry) return "-";
    const def = moveData ? moveData[entry.id] : undefined;
    return (def && def.name) || entry.id;
  },

  /** Lua: ForgetMoveList.lua:20 */
  draw(
    moves: (ForgetMoveEntry | null | undefined)[] | null | undefined,
    cursor: number,
    moveData?: Record<string, any> | null,
    palette?: Colors | null,
  ): void {
    Chrome.textbox(ForgetMoveList.x, ForgetMoveList.y, ForgetMoveList.interiorW, ForgetMoveList.interiorH);
    for (let slot = 1; slot <= ForgetMoveList.rows; slot++) {
      const ty = ForgetMoveList.rowY(slot);
      const label = ForgetMoveList.label(moves ? moves[slot - 1] : undefined, moveData);
      if (palette) Chrome.printThrough(label, ForgetMoveList.nameX, ty, palette);
      else Chrome.print(label, ForgetMoveList.nameX, ty);
      if (slot === cursor) {
        if (palette) Chrome.cursorThrough(ForgetMoveList.cursorX, ty, palette);
        else Chrome.cursor(ForgetMoveList.cursorX, ty);
      }
    }
  },
};

export default ForgetMoveList;
