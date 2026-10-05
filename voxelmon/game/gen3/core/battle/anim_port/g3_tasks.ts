// Port of gen1recomp src/core/game3/battle/anim_port/g3_tasks.lua (GPLv3 + additional terms; see LICENSE.md).
// Merges the gen-3 effect groups' tasks into one table.
//
// A lazily-required module (core pcalls it): registered in G3Lazy.
// NO TOP-LEVEL READS OF IMPORTS: Brian merges at require time; here the merge
// runs on the first access to the registered table (a view over `out`), so
// pairs/get/has see exactly Brian's table. Every group is a static import, so
// his `pcall(require, ...)` always takes the ok branch.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tostring } from "../../../../../import/gen3/lua.ts";
import { find } from "../../../platform/lpattern.ts";
import { ipairs, pairs, seq } from "../../../platform/lt.ts";
import { G3Lazy } from "../../lazy_registry.ts";
import G3Ghost from "./g3_ghost.ts";
import G3E3a from "./g3_e3a.ts";
import G3E3b from "./g3_e3b.ts";
import G3E3c from "./g3_e3c.ts";
import G3Dark from "./g3_dark.ts";
import G3Psychic from "./g3_psychic.ts";

// Lua: g3_tasks.lua:1
const MODULES = seq("g3_ghost", "g3_e3a", "g3_e3b", "g3_e3c", "g3_dark", "g3_psychic");

// Lua: g3_tasks.lua:3
const out: Record<string, any> = {};
let merged = false;

// Lua: g3_tasks.lua:4 -- the require-time merge loop, run once on first access.
function merge(): Record<string, any> {
  if (merged) return out;
  merged = true;
  const MODS: Record<string, any> = {
    g3_ghost: G3Ghost, g3_e3a: G3E3a, g3_e3b: G3E3b, g3_e3c: G3E3c, g3_dark: G3Dark, g3_psychic: G3Psychic,
  };
  for (const [, name] of ipairs<string>(MODULES)) {
    const mod = MODS[name];
    const ok = mod != null;
    if (ok && typeof mod === "object" && mod.tasks) {
      for (const [k, fn] of pairs(mod.tasks)) out[k] = fn;
    } else if (!ok && find(tostring(mod), "module '[^']*' not found") == null) {
      console.log("[battle.anim] " + name + ": " + tostring(mod));
    }
  }
  return out;
}

export const view: Record<string, any> = new Proxy(out, {
  get: (_t, k) => Reflect.get(merge(), k),
  has: (_t, k) => Reflect.has(merge(), k),
  ownKeys: () => Reflect.ownKeys(merge()),
  getOwnPropertyDescriptor: (_t, k) => Reflect.getOwnPropertyDescriptor(merge(), k),
  set: (_t, k, v) => Reflect.set(merge(), k, v),
});

// Lua: g3_tasks.lua:12
export default view;

G3Lazy["src.core.game3.battle.anim_port.g3_tasks"] = view;
