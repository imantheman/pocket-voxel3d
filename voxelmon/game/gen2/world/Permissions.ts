// Gen 2 COLL_* -> permission (pokegold CollisionPermissionTable lo-nybble,
// home/map_objects.asm GetTilePermission). LAND=0, WATER=1, WALL=0x0f.
// A port of gen1recomp src/world/gen2/Permissions.lua at bdfac727 (MIT).
//
// ../permissions.ts is the cook's copy of the same module (the cook and the
// Gen 1 voxel map import it, and it cannot see GameVersion). This is the full
// engine module with the Lua's API and shapes: the direction sets it hands
// back (ledgeFacings, sideBlocks, entryBlocks) are `{ [dir]: true }` tables,
// as the Lua callers index them, and the side-wall arms follow
// GameVersion.fixes().sideWallArms. The permission table itself is shared.

import { GameVersion } from "../shared/core/GameVersion.ts";
import { LAND, WATER, WALL, permissionOf, type Dir } from "../permissions.ts";

export type { Dir };
/** A Lua `{ up = true, ... }` direction set. */
export type DirSet = Partial<Record<Dir, true>>;

type Coll = number | null | undefined;

const set = (...xs: number[]): Record<number, true> => {
  const out: Record<number, true> = {};
  for (const x of xs) out[x] = true;
  return out;
};
const m256 = (c: number): number => c - Math.floor(c / 256) * 256;

// Lua: Permissions.lua:69-77 -- tall / long grass (the _10 and _1C aliases are
// unused on the cart but land in the same permission).
const GRASS = set(0x10, 0x14, 0x18, 0x1c);

// Lua: Permissions.lua:84-90 -- CheckSuperTallGrassTile: the LONG grass pair
// only; doubles the Bug Contest rate and plays the rustle.
const SUPER_TALL_GRASS = set(0x14, 0x1c);

// Lua: Permissions.lua:97-120 -- CheckGrassCollision: NOT the GRASS list.
// COLL_WATER is in it (surf encounters), the unused grass aliases are not,
// and the cart's garbage rows ($08, $28, $48-$4c) are kept verbatim.
const ENCOUNTER_COLLISION = set(0x08, 0x18, 0x14, 0x28, 0x29, 0x48, 0x49, 0x4a, 0x4b, 0x4c);

// Lua: Permissions.lua:127-142 -- the single-collision predicates out of
// home/map_objects.asm, each a real constant and its unused alias.
const ICE = set(0x23, 0x2b);         // CheckIceTile
const WHIRLPOOL = set(0x24, 0x2c);   // CheckWhirlpoolTile
const CUT_TREE = set(0x12, 0x1a);    // CheckCutTreeTile
const HEADBUTT_TREE = set(0x15, 0x1d); // CheckHeadbuttTreeTile
// CheckWaterfallTile pairs COLL_WATERFALL with COLL_CURRENT_DOWN: the
// downward current is the tile at the TOP of a waterfall.
const WATERFALL = set(0x33, 0x3b);
// CheckCounterTile: DOUBLES an A press's reach over a counter (World:interact).
const COUNTER = set(0x90, 0x98);

// Lua: Permissions.lua:144
function member(s: Record<number, true>, coll: Coll): boolean {
  if (coll == null || coll < 0) return false;
  return s[m256(coll)] === true;
}

// Lua: Permissions.lua:171 -- .water_table, indexed by the low two bits.
const CURRENT_DIR: Dir[] = ["right", "left", "up", "down"];

// Lua: Permissions.lua:180-187 -- HI_NYBBLE_WARPS .warps: landing on a
// door/staircase/cave forces a walk DOWN off it.
const DOOR_FORCED = set(
  0x71, // COLL_DOOR
  0x79, // COLL_DOOR_79 (unused)
  0x7a, // COLL_STAIRCASE
  0x7b, // COLL_CAVE
);

// Lua: Permissions.lua:194-204 -- CheckCutCollision: both grasses too, so CUT
// mows tall grass as well as trees.
const CUTTABLE = set(0x12, 0x1a, 0x10, 0x18, 0x14, 0x1c);

// Lua: Permissions.lua:208-226 -- ledges ($a0-$a7) and the facings that hop
// them. Gold's order: $a0 is HOP_RIGHT here, not Crystal's HOP_DOWN.
const LEDGE_FACINGS: DirSet[] = [
  { right: true },              // COLL_HOP_RIGHT
  { left: true },               // COLL_HOP_LEFT
  { up: true },                 // COLL_HOP_UP (unused)
  { down: true },               // COLL_HOP_DOWN
  { down: true, right: true },  // COLL_HOP_DOWN_RIGHT
  { down: true, left: true },   // COLL_HOP_DOWN_LEFT
  { up: true, right: true },    // COLL_HOP_UP_RIGHT (unused)
  { up: true, left: true },     // COLL_HOP_UP_LEFT (unused)
];

// Lua: Permissions.lua:239-265 -- one-way walls ($b0) and buoys ($c0).
// GetMovementPermissions builds wTilePermissions from the STANDING tile
// (.MovementPermissionsData[coll & 7], whose DOWN/UP/LEFT/RIGHT masks are
// compared against FACE_* bits, landing each COLL_x_WALL on blocking exactly
// direction x) and from the four NEIGHBOUR tiles.
//   ../pokegold/home/map.asm:1960 -- all four arms `set RIGHT, [hl]`
//   ../pokecrystal/home/map.asm:1638 -- each arm sets its own FACE_* bit
const SIDE_BLOCKS: DirSet[] = [
  { right: true },              // COLL_RIGHT_WALL / RIGHT_BUOY
  { left: true },               // COLL_LEFT_WALL / LEFT_BUOY
  { up: true },                 // COLL_UP_WALL / UP_BUOY
  { down: true },               // COLL_DOWN_WALL (unused)
  { down: true, right: true },  // COLL_DOWN_RIGHT_WALL (unused)
  { down: true, left: true },   // COLL_DOWN_LEFT_WALL (unused)
  { up: true, right: true },    // COLL_UP_RIGHT_WALL (unused)
  { up: true, left: true },     // COLL_UP_LEFT_WALL (unused)
];

// Lua: Permissions.lua:279-287 -- the neighbour arms; `neighborDir` names
// where the tile sits relative to the player ("down" = the tile below).
// ../pokegold/home/map.asm:1946, ../pokecrystal/home/map.asm:1511
const NEIGHBOR_ARM: Record<Dir, Record<number, true>> = {
  down: set(0x2, 0x6, 0x7),  // UP_WALL kinds below
  up: set(0x3, 0x4, 0x5),    // DOWN_WALL kinds above
  right: set(0x1, 0x5, 0x7), // LEFT_WALL kinds right
  left: set(0x0, 0x4, 0x6),  // RIGHT_WALL kinds left
};

// Lua: Permissions.lua:305-307
const NEIGHBOR_DELTA: Record<Dir, [number, number]> = {
  up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0],
};

// Lua: Permissions.lua:323 -- WillObjectBumpIntoTile .dir_masks,
// engine/overworld/npc_movement.asm:116
const OPPOSITE: Record<Dir, Dir> = { up: "down", down: "up", left: "right", right: "left" };

// Lua: Permissions.lua:351-357 -- carpet warps need a press in their
// direction (CheckDirectionalWarp).
const CARPET_DIR: Record<number, Dir> = {
  0x70: "down",  // COLL_WARP_CARPET_DOWN
  0x76: "left",  // COLL_WARP_CARPET_LEFT
  0x78: "up",    // COLL_WARP_CARPET_UP
  0x7e: "right", // COLL_WARP_CARPET_RIGHT
};

// Lua: Permissions.lua:363-379 -- CheckWarpFacingDown; the `; unused` rows are
// transcribed, as the cart tests against the whole array.
const WARP_FACING_DOWN = set(0x71, 0x79, 0x7a, 0x73, 0x7b, 0x74, 0x7c, 0x75, 0x7d);

export const Permissions = {
  // Lua: Permissions.lua:8-10
  LAND,
  WATER,
  WALL,

  // Lua: Permissions.lua:32-35
  of(coll: Coll): number {
    if (coll == null || coll < 0) return WALL;
    return permissionOf(m256(coll));
  },

  // Lua: Permissions.lua:37
  isLand(coll: Coll): boolean {
    return Permissions.of(coll) === LAND;
  },

  // Lua: Permissions.lua:41
  isWater(coll: Coll): boolean {
    return Permissions.of(coll) === WATER;
  },

  // Lua: Permissions.lua:45
  isWall(coll: Coll): boolean {
    return Permissions.of(coll) === WALL;
  },

  // Lua: Permissions.lua:49-53 -- DoPlayerMovement's .CheckWalkable: nothing
  // more than "the permission is LAND_TILE".
  isWalkable(coll: Coll): boolean {
    return Permissions.of(coll) === LAND;
  },

  // Lua: Permissions.lua:55-67 -- .CheckSurfable: "water" keep surfing, "land"
  // this step is .ExitWater, undefined (nil) the step bumps.
  surfable(coll: Coll): "water" | "land" | undefined {
    const perm = Permissions.of(coll);
    if (perm === WATER) return "water";
    if (perm === LAND) return "land";
    return undefined;
  },

  // Lua: Permissions.lua:79
  isGrass(coll: Coll): boolean {
    if (coll == null) return false;
    return GRASS[m256(coll)] === true;
  },

  // Lua: Permissions.lua:92
  isSuperTallGrass(coll: Coll): boolean {
    if (coll == null) return false;
    return SUPER_TALL_GRASS[m256(coll)] === true;
  },

  // Lua: Permissions.lua:122
  isEncounterCollision(coll: Coll): boolean {
    if (coll == null) return false;
    return ENCOUNTER_COLLISION[m256(coll)] === true;
  },

  // Lua: Permissions.lua:149-154
  isIce(coll: Coll): boolean { return member(ICE, coll); },
  isWhirlpool(coll: Coll): boolean { return member(WHIRLPOOL, coll); },
  isCutTree(coll: Coll): boolean { return member(CUT_TREE, coll); },
  isHeadbuttTree(coll: Coll): boolean { return member(HEADBUTT_TREE, coll); },
  isWaterfall(coll: Coll): boolean { return member(WATERFALL, coll); },
  isCounter(coll: Coll): boolean { return member(COUNTER, coll); },

  // Lua: Permissions.lua:156-178 -- .CheckTile's HI_NYBBLE_CURRENT arm: every
  // $3x is a current; the low two bits pick the forced direction, so
  // COLL_WATERFALL $33 and COLL_CURRENT_DOWN $3b both come out DOWN. It runs
  // above .CheckTurning and OVERRIDES the d-pad.
  currentDirection(coll: Coll): Dir | undefined {
    if (coll == null || coll < 0) return undefined;
    const c = m256(coll);
    if (c - (c % 16) !== 0x30) return undefined;
    return CURRENT_DIR[c % 4];
  },

  // Lua: Permissions.lua:189
  doorForcedDirection(coll: Coll): Dir | undefined {
    if (coll != null && DOOR_FORCED[coll]) return "down";
    return undefined;
  },

  // Lua: Permissions.lua:206
  isCuttable(coll: Coll): boolean { return member(CUTTABLE, coll); },

  // Lua: Permissions.lua:228
  isLedge(coll: Coll): boolean {
    if (coll == null || coll < 0) return false;
    return Math.floor(m256(coll) / 16) === 0xa;
  },

  // Lua: Permissions.lua:233-237 -- the facings that jump this ledge, or nil.
  ledgeFacings(coll: Coll): DirSet | undefined {
    if (!Permissions.isLedge(coll)) return undefined;
    return LEDGE_FACINGS[coll! % 8];
  },

  // Lua: Permissions.lua:267
  isSideWall(coll: Coll): boolean {
    if (coll == null || coll < 0) return false;
    const hi = Math.floor(m256(coll) / 16);
    return hi === 0xb || hi === 0xc;
  },

  // Lua: Permissions.lua:273-277 -- directions a player STANDING on this tile
  // may not move, or nil.
  sideBlocks(coll: Coll): DirSet | undefined {
    if (!Permissions.isSideWall(coll)) return undefined;
    return SIDE_BLOCKS[coll! % 8];
  },

  // Lua: Permissions.lua:289-296 -- ../pokecrystal/home/map.asm:1638
  neighborBlocks(neighborDir: Dir, coll: Coll): Dir | undefined {
    if (!Permissions.isSideWall(coll)) return undefined;
    const arm = NEIGHBOR_ARM[neighborDir];
    if (!(arm && arm[coll! % 8])) return undefined;
    if (GameVersion.fixes().sideWallArms) return neighborDir;
    return "down";
  },

  // Lua: Permissions.lua:298
  neighborBlocksDown(neighborDir: Dir, coll: Coll): boolean {
    return Permissions.neighborBlocks(neighborDir, coll) === "down";
  },

  // Lua: Permissions.lua:302-320 -- the whole GetMovementPermissions verdict:
  // may a step `dir` leave (cx, cy)? `collOf(x, y)` answers the collision byte.
  stepPermitted(collOf: (x: number, y: number) => Coll, cx: number, cy: number, dir: Dir): boolean {
    const standing = Permissions.sideBlocks(collOf(cx, cy));
    if (standing && standing[dir]) return false;
    if (dir === "down" || GameVersion.fixes().sideWallArms) {
      for (const nd of Object.keys(NEIGHBOR_DELTA) as Dir[]) {
        const d = NEIGHBOR_DELTA[nd];
        if (Permissions.neighborBlocks(nd, collOf(cx + d[0], cy + d[1])) === dir) {
          return false;
        }
      }
    }
    return true;
  },

  // Lua: Permissions.lua:325-331
  entryBlocks(coll: Coll): DirSet | undefined {
    const row = Permissions.sideBlocks(coll);
    if (!row) return undefined;
    const out: DirSet = {};
    for (const d of Object.keys(row) as Dir[]) out[OPPOSITE[d]] = true;
    return out;
  },

  // Lua: Permissions.lua:333-341 -- WillObjectBumpIntoWater,
  // engine/overworld/npc_movement.asm:60
  objectStepPermitted(fromColl: Coll, toColl: Coll, dir: Dir): boolean {
    const leave = Permissions.sideBlocks(fromColl);
    if (leave && leave[dir]) return false;
    if (!Permissions.isLand(toColl)) return false;
    const enter = Permissions.entryBlocks(toColl);
    if (enter && enter[dir]) return false;
    return true;
  },

  // Lua: Permissions.lua:343-349 -- COLL_PIT / COLL_PIT_68 plus high-nybble $7
  // (CheckWarpCollision / HI_NYBBLE_WARPS).
  isWarpCollision(coll: Coll): boolean {
    if (coll == null || coll < 0) return false;
    if (coll === 0x60 || coll === 0x68) return true;
    return Math.floor(coll / 16) === 7;
  },

  // Lua: Permissions.lua:359
  carpetDirection(coll: Coll): Dir | undefined {
    return coll == null ? undefined : CARPET_DIR[coll];
  },

  // Lua: Permissions.lua:381 -- CheckWarpFacingDown: RefreshPlayerSprite runs
  // it against the tile the player ARRIVES on.
  warpFacesDown(coll: Coll): boolean { return member(WARP_FACING_DOWN, coll); },

  // Lua: Permissions.lua:383-387 -- immediate warp on landing (doors, stairs,
  // caves, panels) vs carpet.
  isImmediateWarp(coll: Coll): boolean {
    if (!Permissions.isWarpCollision(coll)) return false;
    return CARPET_DIR[coll!] === undefined;
  },
};

export default Permissions;
