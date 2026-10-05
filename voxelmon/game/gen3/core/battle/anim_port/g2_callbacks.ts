// Port of gen1recomp src/core/game3/battle/anim_port/g2_callbacks.lua (GPLv3 + additional terms; see LICENSE.md).
// return require("src.core.game3.battle.anim_port.g2_modules").cb
//
// A lazily-required module (core pcalls it): registered in G3Lazy. The entry is
// a view of g2_modules' M.cb that reads it on first access (no top-level read
// of an import inside the cycle); pairs/get/has see exactly that table.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { G3Lazy } from "../../lazy_registry.ts";
import M from "./g2_modules.ts";

function target(): Record<string, any> {
  return M.cb;
}

// Lua: g2_callbacks.lua:1
export const view: Record<string, any> = new Proxy({} as Record<string, any>, {
  get: (_t, k) => Reflect.get(target(), k),
  has: (_t, k) => Reflect.has(target(), k),
  ownKeys: () => Reflect.ownKeys(target()),
  getOwnPropertyDescriptor: (_t, k) => {
    const d = Reflect.getOwnPropertyDescriptor(target(), k);
    if (d) d.configurable = true;
    return d;
  },
  set: (_t, k, v) => Reflect.set(target(), k, v),
});

export default view;

G3Lazy["src.core.game3.battle.anim_port.g2_callbacks"] = view;
