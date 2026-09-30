// gen1recomp src/ui/Theme.lua (bdfac727): the UI glyphs and box geometry.
// No mod themes here, so load() only picks up the font's border.

import { Font } from "../render/Font.ts";

export const Theme = {
  cursor: 0xed,
  cursorHollow: 0xec,
  moreArrow: 0xee,
  tile: 8,
  cols: 20,
  rows: 18,
  textBox: { tx: 0, ty: 12, tw: 20, th: 6, maxCols: 18 },
  choiceBox: { tx: 14, ty: 7, tw: 6, th: 5 } as { tx: number; ty: number; tw: number; th: number; firstItem?: number },
  healCancelBox: { tx: 11, ty: 6, tw: 9, th: 6, firstItem: 2 },
  trainerSwitchBox: { tx: 0, ty: 7, tw: 6, th: 5 },
  saveBox: { tx: 0, ty: 7, tw: 6, th: 5 },
  border: Font.BORDER as Record<string, number>,

  load(_data?: unknown): void {
    Theme.border = Font.BORDER;
  },
};

export default Theme;
