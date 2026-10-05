// Port of gen1recomp src/core/game3/battle/anim_port/g2_modules.lua (GPLv3 + additional terms; see LICENSE.md).
// Merges the g2 effect groups: each group's cb into g2_pret's P.CB (raw) and M.cb (wrapped
// with P.cb), each group's tasks into M.tasks.
//
// NO TOP-LEVEL READS OF IMPORTS: Brian merges at require time; here M.cb / M.tasks
// are getters that run his merge loop on first read (every group is a static
// import, so his `pcall(require, ...)` always takes the ok branch).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { find } from "../../../platform/lpattern.ts";
import { ipairs, pairs, seq } from "../../../platform/lt.ts";
import { tostring } from "../../../../../import/gen3/lua.ts";
import P from "./g2_pret.ts";
import G2Dragon from "./g2_dragon.ts";
import G2Fight from "./g2_fight.ts";
import G2Fire from "./g2_fire.ts";
import G2Flying from "./g2_flying.ts";
import G2Effects2a from "./g2_effects2a.ts";
import G2Effects2b from "./g2_effects2b.ts";
import G2Effects2c from "./g2_effects2c.ts";

// Lua: g2_modules.lua:3
const NAMES = seq("g2_dragon", "g2_fight", "g2_fire", "g2_flying", "g2_effects2a", "g2_effects2b", "g2_effects2c");

const cb: Record<string, any> = {};
const tasks: Record<string, any> = {};
let merged = false;

// Lua: g2_modules.lua:7 -- the require-time merge loop, run once on first read of M.cb / M.tasks.
function merge(): void {
  if (merged) return;
  merged = true;
  // pcall(require, "src.core.game3.battle.anim_port." .. n): static imports by name.
  const MODS: Record<string, any> = {
    g2_dragon: G2Dragon, g2_fight: G2Fight, g2_fire: G2Fire, g2_flying: G2Flying,
    g2_effects2a: G2Effects2a, g2_effects2b: G2Effects2b, g2_effects2c: G2Effects2c,
  };
  for (const [, n] of ipairs<string>(NAMES)) {
    const mod = MODS[n];
    const ok = mod != null;
    if (ok && typeof mod === "object") {
      for (const [k, fn] of pairs(mod.cb ?? {})) {
        P.CB[k] = fn;
        cb[k] = P.cb(fn);
      }
      for (const [k, fn] of pairs(mod.tasks ?? {})) {
        tasks[k] = fn;
      }
    } else if (!ok && find(tostring(mod), "not found") == null) {
      console.log("[battle.anim] " + n + ": " + tostring(mod));
    }
  }
}

// Lua: g2_modules.lua:5 -- local M = { cb = {}, tasks = {} }
export const M: Record<string, any> = {
  get cb() { merge(); return cb; },
  get tasks() { merge(); return tasks; },
};

// Lua: g2_modules.lua:22
export default M;
