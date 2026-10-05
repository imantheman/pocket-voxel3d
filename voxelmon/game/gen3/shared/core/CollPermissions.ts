// Port of gen1recomp src/core/CollPermissions.lua (GPLv3 + additional terms; see LICENSE.md).
// home/map_objects.asm -- collision byte -> LAND / WATER / WALL.

import { mod } from "../../../../import/gen3/lua.ts";

// 0-based (the Lua's TABLE[(coll % 256) + 1])
const TABLE: number[] = [
  0, 0, 0, 0, 0, 0, 0, 15, 0, 0, 0, 0, 0, 0, 0, 15,
  0, 0, 15, 0, 0, 15, 0, 0, 0, 0, 15, 0, 0, 15, 0, 0,
  1, 1, 1, 0, 1, 1, 1, 15, 1, 1, 1, 0, 1, 1, 1, 15,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 15, 0, 0, 0, 0, 0, 0, 0, 15, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  15, 15, 15, 15, 15, 0, 0, 0, 15, 15, 15, 15, 15, 0, 0, 0,
  15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 15,
];

export const CollPermissions = {
  LAND: 0x00,
  WATER: 0x01,
  WALL: 0x0f,

  // Lua: CollPermissions.lua:28
  of(coll: number | undefined | null): number {
    if (coll === undefined || coll === null || coll < 0) return CollPermissions.WALL;
    return TABLE[mod(coll, 256)] ?? CollPermissions.WALL;
  },

  // Lua: CollPermissions.lua:33
  isLand(coll: number | undefined | null): boolean {
    return CollPermissions.of(coll) === CollPermissions.LAND;
  },

  // Lua: CollPermissions.lua:37
  isWater(coll: number | undefined | null): boolean {
    return CollPermissions.of(coll) === CollPermissions.WATER;
  },

  // Lua: CollPermissions.lua:41
  isWall(coll: number | undefined | null): boolean {
    return CollPermissions.of(coll) === CollPermissions.WALL;
  },

  // Lua: CollPermissions.lua:45
  isWalkable(coll: number | undefined | null): boolean {
    return CollPermissions.of(coll) === CollPermissions.LAND;
  },

  // Lua: CollPermissions.lua:49
  isLedge(coll: number | undefined | null): boolean {
    if (coll === undefined || coll === null || coll < 0) return false;
    return Math.floor(mod(coll, 256) / 16) === 0xa;
  },
};

export default CollPermissions;
