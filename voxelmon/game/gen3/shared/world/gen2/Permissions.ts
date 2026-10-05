// Port of gen1recomp src/world/gen2/Permissions.lua (GPLv3 + additional terms; see LICENSE.md).
// Gen 2 collision-byte permissions (LAND / WATER / WALL plus the special
// collisions: grass, ice, currents, ledges, side walls, warps).

import { mod } from "../../../../../import/gen3/lua.ts";
import { pairs } from "../../../platform/lt.ts";
import { GameVersion } from "../../core/GameVersion.ts";
import { CollPermissions } from "../../core/CollPermissions.ts";

type Coll = number | null | undefined;
export type DirSet = Record<string, boolean>;

// Lua: Permissions.lua:31
const GRASS: Record<number, boolean> = {
  [0x10]: true, // COLL_TALL_GRASS_10 (unused)
  [0x14]: true, // COLL_LONG_GRASS
  [0x18]: true, // COLL_TALL_GRASS
  [0x1c]: true, // COLL_LONG_GRASS_1C (unused)
};

// Lua: Permissions.lua:49
const SUPER_TALL_GRASS: Record<number, boolean> = {
  [0x14]: true, // COLL_LONG_GRASS
  [0x1c]: true, // COLL_LONG_GRASS_1C (unused)
};

// Lua: Permissions.lua:71
const ENCOUNTER_COLLISION: Record<number, boolean> = {
  [0x08]: true, // COLL_CUT_08
  [0x18]: true, // COLL_TALL_GRASS
  [0x14]: true, // COLL_LONG_GRASS
  [0x28]: true, // COLL_CUT_28
  [0x29]: true, // COLL_WATER
  [0x48]: true, // COLL_GRASS_48
  [0x49]: true, // COLL_GRASS_49
  [0x4a]: true, // COLL_GRASS_4A
  [0x4b]: true, // COLL_GRASS_4B
  [0x4c]: true, // COLL_GRASS_4C
};

// Lua: Permissions.lua:92
const ICE: Record<number, boolean> = { [0x23]: true, [0x2b]: true };            // CheckIceTile
const WHIRLPOOL: Record<number, boolean> = { [0x24]: true, [0x2c]: true };      // CheckWhirlpoolTile
const CUT_TREE: Record<number, boolean> = { [0x12]: true, [0x1a]: true };       // CheckCutTreeTile
const HEADBUTT_TREE: Record<number, boolean> = { [0x15]: true, [0x1d]: true };  // CheckHeadbuttTreeTile
const WATERFALL: Record<number, boolean> = { [0x33]: true, [0x3b]: true };
const COUNTER: Record<number, boolean> = { [0x90]: true, [0x98]: true };

// Lua: Permissions.lua:106
function member(set: Record<number, boolean>, coll: Coll): boolean {
  if (coll == null || coll < 0) return false;
  return set[mod(coll, 256)] === true;
}

// Lua: Permissions.lua:133 ({ [0] = "right", "left", "up", "down" })
const CURRENT_DIR: Record<number, string> = { 0: "right", 1: "left", 2: "up", 3: "down" };

// Lua: Permissions.lua:144
const DOOR_FORCED: Record<number, boolean> = {
  [0x71]: true, // COLL_DOOR
  [0x79]: true, // COLL_DOOR_79 (unused)
  [0x7a]: true, // COLL_STAIRCASE
  [0x7b]: true, // COLL_CAVE
};

// Lua: Permissions.lua:159
const CUTTABLE: Record<number, boolean> = {
  [0x12]: true, // COLL_CUT_TREE
  [0x1a]: true, // COLL_CUT_TREE_1A
  [0x10]: true, // COLL_TALL_GRASS_10
  [0x18]: true, // COLL_TALL_GRASS
  [0x14]: true, // COLL_LONG_GRASS
  [0x1c]: true, // COLL_LONG_GRASS_1C
};

// Lua: Permissions.lua:179
const LEDGE_FACINGS: Record<number, DirSet> = {
  [0x0]: { right: true },              // COLL_HOP_RIGHT
  [0x1]: { left: true },               // COLL_HOP_LEFT
  [0x2]: { up: true },                 // COLL_HOP_UP (unused)
  [0x3]: { down: true },               // COLL_HOP_DOWN
  [0x4]: { down: true, right: true },  // COLL_HOP_DOWN_RIGHT
  [0x5]: { down: true, left: true },   // COLL_HOP_DOWN_LEFT
  [0x6]: { up: true, right: true },    // COLL_HOP_UP_RIGHT (unused)
  [0x7]: { up: true, left: true },     // COLL_HOP_UP_LEFT (unused)
};

// Lua: Permissions.lua:213
const SIDE_BLOCKS: Record<number, DirSet> = {
  [0x0]: { right: true },              // COLL_RIGHT_WALL / RIGHT_BUOY
  [0x1]: { left: true },               // COLL_LEFT_WALL / LEFT_BUOY
  [0x2]: { up: true },                 // COLL_UP_WALL / UP_BUOY
  [0x3]: { down: true },               // COLL_DOWN_WALL (unused)
  [0x4]: { down: true, right: true },  // COLL_DOWN_RIGHT_WALL (unused)
  [0x5]: { down: true, left: true },   // COLL_DOWN_LEFT_WALL (unused)
  [0x6]: { up: true, right: true },    // COLL_UP_RIGHT_WALL (unused)
  [0x7]: { up: true, left: true },     // COLL_UP_LEFT_WALL (unused)
};

// Lua: Permissions.lua:239
const NEIGHBOR_ARM: Record<string, Record<number, boolean>> = {
  down: { [0x2]: true, [0x6]: true, [0x7]: true },  // UP_WALL kinds below
  up: { [0x3]: true, [0x4]: true, [0x5]: true },    // DOWN_WALL kinds above
  right: { [0x1]: true, [0x5]: true, [0x7]: true }, // LEFT_WALL kinds right
  left: { [0x0]: true, [0x4]: true, [0x6]: true },  // RIGHT_WALL kinds left
};

// Lua: Permissions.lua:262 (Lua sequences: d[1], d[2])
const NEIGHBOR_DELTA: Record<string, [null, number, number]> = {
  up: [null, 0, -1], down: [null, 0, 1], left: [null, -1, 0], right: [null, 1, 0],
};

// Lua: Permissions.lua:280
const OPPOSITE: Record<string, string> = { up: "down", down: "up", left: "right", right: "left" };

// Lua: Permissions.lua:309
const CARPET_DIR: Record<number, string> = {
  [0x70]: "down",  // COLL_WARP_CARPET_DOWN
  [0x76]: "left",  // COLL_WARP_CARPET_LEFT
  [0x78]: "up",    // COLL_WARP_CARPET_UP
  [0x7e]: "right", // COLL_WARP_CARPET_RIGHT
};

// Lua: Permissions.lua:326
const WARP_FACING_DOWN: Record<number, boolean> = {
  [0x71]: true, // COLL_DOOR
  [0x79]: true, // COLL_DOOR_79 (unused)
  [0x7a]: true, // COLL_STAIRCASE
  [0x73]: true, // COLL_STAIRCASE_73 (unused)
  [0x7b]: true, // COLL_CAVE
  [0x74]: true, // COLL_CAVE_74 (unused)
  [0x7c]: true, // COLL_WARP_PANEL
  [0x75]: true, // COLL_DOOR_75 (unused)
  [0x7d]: true, // COLL_DOOR_7D (unused)
};

export const Permissions = {
  // Lua: Permissions.lua:6 (aliases of CollPermissions, read at use: no
  // top-level reads of imports)
  get LAND(): number { return CollPermissions.LAND; },
  get WATER(): number { return CollPermissions.WATER; },
  get WALL(): number { return CollPermissions.WALL; },

  // Lua: Permissions.lua:10
  of(coll: Coll): number { return CollPermissions.of(coll); },
  isLand(coll: Coll): boolean { return CollPermissions.isLand(coll); },
  isWater(coll: Coll): boolean { return CollPermissions.isWater(coll); },
  isWall(coll: Coll): boolean { return CollPermissions.isWall(coll); },
  isWalkable(coll: Coll): boolean { return CollPermissions.isWalkable(coll); },
  isLedge(coll: Coll): boolean { return CollPermissions.isLedge(coll); },

  // Lua: Permissions.lua:24
  surfable(coll: Coll): "water" | "land" | null {
    const perm = Permissions.of(coll);
    if (perm === Permissions.WATER) return "water";
    if (perm === Permissions.LAND) return "land";
    return null;
  },

  // Lua: Permissions.lua:41
  isGrass(coll: Coll): boolean {
    if (coll == null) return false;
    return GRASS[mod(coll, 256)] === true;
  },

  // Lua: Permissions.lua:54
  isSuperTallGrass(coll: Coll): boolean {
    if (coll == null) return false;
    return SUPER_TALL_GRASS[mod(coll, 256)] === true;
  },

  // Lua: Permissions.lua:84
  isEncounterCollision(coll: Coll): boolean {
    if (coll == null) return false;
    return ENCOUNTER_COLLISION[mod(coll, 256)] === true;
  },

  // Lua: Permissions.lua:111
  isIce(coll: Coll): boolean { return member(ICE, coll); },
  isWhirlpool(coll: Coll): boolean { return member(WHIRLPOOL, coll); },
  isCutTree(coll: Coll): boolean { return member(CUT_TREE, coll); },
  isHeadbuttTree(coll: Coll): boolean { return member(HEADBUTT_TREE, coll); },
  isWaterfall(coll: Coll): boolean { return member(WATERFALL, coll); },
  isCounter(coll: Coll): boolean { return member(COUNTER, coll); },

  // Lua: Permissions.lua:135
  currentDirection(coll: Coll): string | null {
    if (coll == null || coll < 0) return null;
    coll = mod(coll, 256);
    if (coll - mod(coll, 16) !== 0x30) return null;
    return CURRENT_DIR[mod(coll, 4)] ?? null;
  },

  // Lua: Permissions.lua:151
  doorForcedDirection(coll: Coll): string | null {
    if (coll != null && DOOR_FORCED[coll]) return "down";
    return null;
  },

  // Lua: Permissions.lua:168
  isCuttable(coll: Coll): boolean { return member(CUTTABLE, coll); },

  // Lua: Permissions.lua:191
  ledgeFacings(coll: Coll): DirSet | undefined {
    if (!Permissions.isLedge(coll)) return undefined;
    return LEDGE_FACINGS[mod(coll as number, 8)];
  },

  // Lua: Permissions.lua:224
  isSideWall(coll: Coll): boolean {
    if (coll == null || coll < 0) return false;
    const hi = Math.floor(mod(coll, 256) / 16);
    return hi === 0xb || hi === 0xc;
  },

  // Lua: Permissions.lua:231
  sideBlocks(coll: Coll): DirSet | undefined {
    if (!Permissions.isSideWall(coll)) return undefined;
    return SIDE_BLOCKS[mod(coll as number, 8)];
  },

  // Lua: Permissions.lua:247
  neighborBlocks(neighborDir: string, coll: Coll): string | null {
    if (!Permissions.isSideWall(coll)) return null;
    const arm = NEIGHBOR_ARM[neighborDir];
    if (!(arm && arm[mod(coll as number, 8)])) return null;
    if (GameVersion.fixes().sideWallArms) return neighborDir;
    return "down";
  },

  // Lua: Permissions.lua:255
  neighborBlocksDown(neighborDir: string, coll: Coll): boolean {
    return Permissions.neighborBlocks(neighborDir, coll) === "down";
  },

  // Lua: Permissions.lua:266
  stepPermitted(collOf: (x: number, y: number) => Coll, cx: number, cy: number, dir: string): boolean {
    const standing = Permissions.sideBlocks(collOf(cx, cy));
    if (standing && standing[dir]) return false;
    if (dir === "down" || GameVersion.fixes().sideWallArms) {
      for (const [nd, d] of pairs<[null, number, number]>(NEIGHBOR_DELTA)) {
        if (Permissions.neighborBlocks(nd as string, collOf(cx + d[1], cy + d[2])) === dir) {
          return false;
        }
      }
    }
    return true;
  },

  // Lua: Permissions.lua:282
  entryBlocks(coll: Coll): DirSet | undefined {
    const row = Permissions.sideBlocks(coll);
    if (!row) return undefined;
    const out: DirSet = {};
    for (const [d] of pairs(row)) out[OPPOSITE[d as string]] = true;
    return out;
  },

  // Lua: Permissions.lua:291
  objectStepPermitted(fromColl: Coll, toColl: Coll, dir: string): boolean {
    const leave = Permissions.sideBlocks(fromColl);
    if (leave && leave[dir]) return false;
    if (!Permissions.isLand(toColl)) return false;
    const enter = Permissions.entryBlocks(toColl);
    if (enter && enter[dir]) return false;
    return true;
  },

  // Lua: Permissions.lua:300
  isWarpCollision(coll: Coll): boolean {
    if (coll == null || coll < 0) return false;
    if (coll === 0x60 || coll === 0x68) return true;
    return Math.floor(coll / 16) === 7;
  },

  // Lua: Permissions.lua:316
  carpetDirection(coll: Coll): string | undefined {
    return coll == null ? undefined : CARPET_DIR[coll];
  },

  // Lua: Permissions.lua:338
  warpFacesDown(coll: Coll): boolean { return member(WARP_FACING_DOWN, coll); },

  // Lua: Permissions.lua:341
  isImmediateWarp(coll: Coll): boolean {
    if (!Permissions.isWarpCollision(coll)) return false;
    return CARPET_DIR[coll as number] == null;
  },
};

export default Permissions;
