// gen1recomp src/ui/MenuRepeat.lua (bdfac727): held-direction repeat for
// menus (Gen 2: 15 frames, then every 5).

import type { MenuInput } from "../../ui/Chrome.ts";

export interface RepeatState {
  delay: number;
  rate: number;
  enabled: boolean;
  dir: string | null;
  frames: number;
}

const ALL_DIRS = ["up", "down", "left", "right"];

export const MenuRepeat = {
  GEN1_DELAY: 30,
  GEN1_RATE: 5,
  GEN2_DELAY: 15,
  GEN2_RATE: 5,

  new(delay?: number, rate?: number, enabled?: boolean): RepeatState {
    return {
      delay: Number(delay ?? MenuRepeat.GEN1_DELAY) || MenuRepeat.GEN1_DELAY,
      rate: Math.max(1, Number(rate ?? MenuRepeat.GEN1_RATE) || MenuRepeat.GEN1_RATE),
      enabled: enabled !== false,
      dir: null,
      frames: 0,
    };
  },

  reset(state: RepeatState): void {
    state.dir = null;
    state.frames = 0;
  },

  /** [dir or null, fresh press?] */
  direction(state: RepeatState, input: MenuInput & { isDown?(b: string): boolean }, dirs: string[] = ALL_DIRS): [string | null, boolean] {
    for (const dir of dirs) {
      if (input.wasPressed(dir)) {
        state.dir = dir;
        state.frames = 0;
        return [dir, true];
      }
    }
    const dir = state.dir;
    if (!(dir && state.enabled && input.isDown && input.isDown(dir))) {
      MenuRepeat.reset(state);
      return [null, false];
    }
    state.frames += 1;
    const afterDelay = state.frames - state.delay;
    if (afterDelay >= 0 && afterDelay % state.rate === 0) return [dir, false];
    return [null, false];
  },
};

export default MenuRepeat;
