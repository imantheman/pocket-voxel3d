// Port of gen1recomp src/core/GameSpeed.lua (GPLv3 + additional terms; see LICENSE.md).
// Fast-forward multiplier for game logic: speeding up runs the 1/60 fixed
// step N times per real frame; audio does not scale.

import { ipairs, len } from "../../platform/lt.ts";
import { mod, tonumber, tostring } from "../../../../import/gen3/lua.ts";

type Levels = (number | null)[];

// Lua: GameSpeed.lua:34
let allowed: Levels | undefined;

export const GameSpeed = {
  // Lua: GameSpeed.lua:21
  LEVELS: [null, 1, 2, 3, 4, 10, 20, 30, 50, 75, 100, 200] as Levels,
  DEFAULT: 1,

  // Lua: GameSpeed.lua:24
  levelLabel(v: unknown): string {
    const n = tonumber(v) ?? GameSpeed.DEFAULT;
    if (n === 1) return "NORMAL";
    return tostring(n) + "X";
  },

  // Lua: GameSpeed.lua:36
  setAllowed(levels: unknown): void {
    if (levels == null || typeof levels !== "object" || len(levels) === 0) { allowed = undefined; return; }
    const valid: Levels = [null];
    const seen: Record<number, boolean> = {};
    for (const [, want] of ipairs<number>(GameSpeed.LEVELS)) {
      for (const [, have] of ipairs<number>(levels)) {
        if (have === want && !seen[want]) {
          seen[want] = true;
          valid[len(valid) + 1] = want;
        }
      }
    }
    allowed = (len(valid) > 0) ? valid : undefined;
  },

  // Lua: GameSpeed.lua:50
  allowed(): Levels {
    return allowed || GameSpeed.LEVELS;
  },

  // Lua: GameSpeed.lua:54
  isLocked(): boolean {
    return allowed !== undefined && len(allowed) <= 1;
  },

  // Lua: GameSpeed.lua:58
  clamp(v: unknown): number {
    const n = tonumber(v);
    const levels = GameSpeed.allowed();
    if (n === undefined) return levels[1] ?? GameSpeed.DEFAULT;
    let best = levels[1] ?? GameSpeed.DEFAULT, bestDiff = Infinity;
    for (const [, level] of ipairs<number>(levels)) {
      const diff = Math.abs(level - n);
      if (diff < bestDiff) { best = level; bestDiff = diff; }
    }
    return best;
  },

  // Lua: GameSpeed.lua:71
  cycle(v: unknown, dir?: number): number {
    const levels = GameSpeed.allowed();
    let cur = 1;
    for (const [i, level] of ipairs<number>(levels)) {
      if (level === GameSpeed.clamp(v)) { cur = i; break; }
    }
    const nextIdx = mod(cur - 1 + (dir ?? 1), len(levels)) + 1;
    return levels[nextIdx]!;
  },

  // Lua: GameSpeed.lua:87
  CATEGORIES: [null, "overworld", "battle", "menu"] as (string | null)[],

  // Lua: GameSpeed.lua:92
  optionKey(category: string): string {
    return "speed" + category.slice(0, 1).toUpperCase() + category.slice(1);
  },
};

export default GameSpeed;
