// Port of gen1recomp src/core/game3/scripting/collision_std.lua (GPLv3 + additional terms; see LICENSE.md).
// Gen3 collision -> shared std script keys (mirrors Gen2 TILE_COLLISION_STD_SCRIPTS).
// Wired from FRLG metatile behaviors in collision.lua (MB_PC -> COLL_PC, etc.).
// Any map whose extract tagged a tile with that behavior gets this script -- no
// per-map coordinate hardcoding.

import { mod } from "../../../../import/gen3/lua.ts";

export const CollisionStd = {
  // Gen2 COLL_* bytes we emit from sevii/gba/collision.lua
  COLL_PC: 0x93,
  COLL_COUNTER: 0x90,
  COLL_BOOKSHELF: 0x91,
  COLL_TOWN_MAP: 0x95,

  // Facing this collision runs the named game3 script (shared, not map-local).
  // Lua: collision_std.lua:15
  SCRIPTS: {
    [0x93]: "EventScript_PC", // MB_PC -> COLL_PC
    [0x85]: "EventScript_WallTownMap", // MB_TOWN_MAP
    [0x95]: "EventScript_WallTownMap", // COLL_TOWN_MAP
  } as Record<number, string>,

  // Lua: collision_std.lua:21
  scriptFor(coll: number | null | undefined): string | undefined {
    if (coll == null) return undefined;
    return CollisionStd.SCRIPTS[mod(coll, 256)];
  },

  // Lua: collision_std.lua:26
  isCounter(coll: number | null | undefined): boolean {
    if (coll == null) return false;
    return mod(coll, 256) === CollisionStd.COLL_COUNTER;
  },
};

export default CollisionStd;
