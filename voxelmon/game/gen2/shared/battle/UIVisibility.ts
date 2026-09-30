// gen1recomp src/battle/UIVisibility.lua (bdfac727): a mod hook that can hide
// the bottom UI. No mods here: always visible.

export const UIVisibility = {
  bottomVisible(_state?: unknown, _queryState?: unknown): boolean {
    return true;
  },
};

export default UIVisibility;
