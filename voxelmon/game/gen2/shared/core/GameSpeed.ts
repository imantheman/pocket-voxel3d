// gen1recomp src/core/GameSpeed.lua (bdfac727): the fast-forward multiplier
// for game logic -- the 1/60 fixed step run N times per real frame. Audio
// does not scale. On the 3DS the host decides how many steps a frame runs;
// this module only knows the levels, labels and option keys.

import { tonumber } from "../../platform/lua.ts";

// GameSpeed.lua:36 -- a cart may narrow the levels a player can reach
let allowed: number[] | null = null;

export const GameSpeed = {
  /** GameSpeed.lua:21 */
  LEVELS: [1, 2, 3, 4, 10, 20, 30, 50, 75, 100, 200],
  DEFAULT: 1,
  /** GameSpeed.lua:87 -- per-category speed (RFC 0007) */
  CATEGORIES: ["overworld", "battle", "menu"],

  /** GameSpeed.lua:24 */
  levelLabel(v: unknown): string {
    const n = tonumber(v) ?? GameSpeed.DEFAULT;
    if (n === 1) return "NORMAL";
    return `${n}X`;
  },

  /** GameSpeed.lua:36 */
  setAllowed(levels: unknown): void {
    if (!Array.isArray(levels) || levels.length === 0) {
      allowed = null;
      return;
    }
    const valid: number[] = [];
    const seen = new Set<number>();
    for (const want of GameSpeed.LEVELS) {
      for (const have of levels) {
        if (have === want && !seen.has(want)) {
          seen.add(want);
          valid.push(want);
        }
      }
    }
    allowed = valid.length > 0 ? valid : null;
  },

  /** GameSpeed.lua:50 */
  allowed(): number[] {
    return allowed ?? GameSpeed.LEVELS;
  },

  /** GameSpeed.lua:54 */
  isLocked(): boolean {
    return allowed != null && allowed.length <= 1;
  },

  /** GameSpeed.lua:58 -- nearest valid level for an arbitrary value. */
  clamp(v: unknown): number {
    const n = tonumber(v);
    const levels = GameSpeed.allowed();
    if (n === undefined) return levels[0] ?? GameSpeed.DEFAULT;
    let best = levels[0] ?? GameSpeed.DEFAULT;
    let bestDiff = Infinity;
    for (const level of levels) {
      const diff = Math.abs(level - n);
      if (diff < bestDiff) {
        best = level;
        bestDiff = diff;
      }
    }
    return best;
  },

  /** GameSpeed.lua:71 -- cycle to the next/previous level, wrapping. */
  cycle(v: unknown, dir?: number): number {
    const levels = GameSpeed.allowed();
    let cur = 1;
    for (let i = 0; i < levels.length; i++) {
      if (levels[i] === GameSpeed.clamp(v)) {
        cur = i + 1;
        break;
      }
    }
    const n = levels.length;
    const nextIdx = ((((cur - 1 + (dir ?? 1)) % n) + n) % n);
    return levels[nextIdx]!;
  },

  /** GameSpeed.lua:92 -- "overworld" -> "speedOverworld" */
  optionKey(category: string): string {
    return "speed" + category.slice(0, 1).toUpperCase() + category.slice(1);
  },
};

export default GameSpeed;
