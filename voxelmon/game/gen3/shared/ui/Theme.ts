// Port of gen1recomp src/ui/Theme.lua (GPLv3 + additional terms; see LICENSE.md).
// The cursor/border/geometry constants every menu used to redeclare
// locally, centralized so field.theme can restyle all of them at once.
// Defaults are the current literals; the merge never runs without a mod.
//
// The FireRed runtime reads one field (healCancelBox, from
// scripting/adapters). Differences:
// - cols/rows are Gen 1's Renderer.WIDTH / HEIGHT (160x144) divided by 8,
//   written as their values: the 3DS's Renderer is an inert stub.
// - NOT FAITHFUL: load() keeps Theme.border undefined and never merges a
//   mod theme: src.render.Font (Gen 1's font, Font.BORDER) and
//   src.mods.Merge are not part of this runtime and no mod loads.

export const Theme: Record<string, any> = {
  cursor: 0xED,
  cursorHollow: 0xEC,
  moreArrow: 0xEE,
  tile: 8,
  cols: 160 / 8,
  rows: 144 / 8,
  textBox: { tx: 0, ty: 12, tw: 20, th: 6, maxCols: 18 },
  choiceBox: { tx: 14, ty: 7, tw: 6, th: 5 },
  healCancelBox: { tx: 11, ty: 6, tw: 9, th: 6, firstItem: 2 },
  trainerSwitchBox: { tx: 0, ty: 7, tw: 6, th: 5 },
  useNextMonBox: { tx: 13, ty: 9, tw: 6, th: 5 },
  saveBox: { tx: 0, ty: 7, tw: 6, th: 5 },

  // Lua: Theme.lua:33
  load(_data: any): void {
    Theme.border = undefined;
  },
};

export default Theme;
