// Port of gen1recomp src/core/game3/town_map_stub.lua (GPLv3 + additional terms; see LICENSE.md).
// Standalone Game3 town-map unlock helpers (KR sevii.town_map stand-in).
// Required lazily (pcall(require, "src.core.game3.town_map_stub")), so it
// registers itself in G3Lazy.

import { G3Lazy } from "./lazy_registry.ts";

export const TownMap = {
  // Lua: town_map_stub.lua:5
  unlock(..._a: unknown[]): void {},

  // Lua: town_map_stub.lua:8
  registerUnlockOnly(..._a: unknown[]): void {},

  // Lua: town_map_stub.lua:11
  register(..._a: unknown[]): void {},

  // Lua: town_map_stub.lua:14
  show(..._a: unknown[]): void {},
};

G3Lazy["src.core.game3.town_map_stub"] = TownMap;

export default TownMap;
