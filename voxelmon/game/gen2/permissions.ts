// Gen 2 collision bytes (COLL_*) to what they permit: a port of gen1recomp
// src/world/gen2/Permissions.lua at bdfac727 (MIT), which follows pokegold's
// CollisionPermissionTable and the movement checks in
// engine/overworld/player_movement.asm and home/map.asm.
//
// A Gen 2 metatile carries one collision byte per 2x2-tile quadrant -- per
// 16 px cell -- where Gen 1 judged a cell by its bottom-left tile id. The cook
// reads these to know land from water and wall (voxel shapes), and the Gold
// world reads them for movement.
//
// No Bun and no host here: the cook and the guest both load this file.

export const LAND = 0x00;
export const WATER = 0x01;
export const WALL = 0x0f;

export type Dir = "up" | "down" | "left" | "right";

/** CollisionPermissionTable, low nybble only (256 entries). */
const TABLE = [
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

/** GetTilePermission: LAND, WATER or WALL; a missing byte is WALL. */
export function permissionOf(coll: number | undefined): number {
  if (coll === undefined || coll < 0) return WALL;
  return TABLE[coll & 0xff] ?? WALL;
}
export const isLand = (c: number | undefined): boolean => permissionOf(c) === LAND;
export const isWater = (c: number | undefined): boolean => permissionOf(c) === WATER;
export const isWall = (c: number | undefined): boolean => permissionOf(c) === WALL;
/** DoPlayerMovement .CheckWalkable: nothing more than "the permission is LAND". */
export const isWalkable = isLand;

/** .CheckSurfable: keep surfing on WATER, land (exit) on LAND, else bump. */
export function surfable(c: number | undefined): "water" | "land" | null {
  const p = permissionOf(c);
  return p === WATER ? "water" : p === LAND ? "land" : null;
}

const set = (...xs: number[]): Set<number> => new Set(xs);
const member = (s: Set<number>, c: number | undefined): boolean =>
  c !== undefined && c >= 0 && s.has(c & 0xff);

/** Tall and long grass, and their unused aliases $10/$1c. */
const GRASS = set(0x10, 0x14, 0x18, 0x1c);
/** CheckSuperTallGrassTile: the LONG grass pair only (Bug Contest rate, rustle). */
const SUPER_TALL_GRASS = set(0x14, 0x1c);
/** CheckGrassCollision: NOT the grass list -- water is in it (surf encounters),
 * the unused grass aliases are not, and the cart's garbage rows are kept. */
const ENCOUNTER = set(0x08, 0x18, 0x14, 0x28, 0x29, 0x48, 0x49, 0x4a, 0x4b, 0x4c);
const ICE = set(0x23, 0x2b);
const WHIRLPOOL = set(0x24, 0x2c);
const CUT_TREE = set(0x12, 0x1a);
const HEADBUTT_TREE = set(0x15, 0x1d);
/** CheckWaterfallTile pairs COLL_WATERFALL with COLL_CURRENT_DOWN: the tile at
 * the top of a waterfall. */
const WATERFALL = set(0x33, 0x3b);
/** CheckCounterTile: doubles an A press's reach across a counter. */
const COUNTER = set(0x90, 0x98);
/** CheckCutCollision: both grasses too, so CUT mows grass as well as trees. */
const CUTTABLE = set(0x12, 0x1a, 0x10, 0x18, 0x14, 0x1c);

export const isGrass = (c: number | undefined): boolean => member(GRASS, c);
export const isSuperTallGrass = (c: number | undefined): boolean => member(SUPER_TALL_GRASS, c);
export const isEncounterCollision = (c: number | undefined): boolean => member(ENCOUNTER, c);
export const isIce = (c: number | undefined): boolean => member(ICE, c);
export const isWhirlpool = (c: number | undefined): boolean => member(WHIRLPOOL, c);
export const isCutTree = (c: number | undefined): boolean => member(CUT_TREE, c);
export const isHeadbuttTree = (c: number | undefined): boolean => member(HEADBUTT_TREE, c);
export const isWaterfall = (c: number | undefined): boolean => member(WATERFALL, c);
export const isCounter = (c: number | undefined): boolean => member(COUNTER, c);
export const isCuttable = (c: number | undefined): boolean => member(CUTTABLE, c);

/** HI_NYBBLE_CURRENT ($3x): the direction it forces, its low two bits. */
const CURRENT_DIR: Dir[] = ["right", "left", "up", "down"];
export function currentDirection(c: number | undefined): Dir | null {
  if (c === undefined || c < 0) return null;
  const b = c & 0xff;
  return (b & 0xf0) === 0x30 ? CURRENT_DIR[b & 3]! : null;
}

/** HI_NYBBLE_WARPS .warps: landing on a door, staircase or cave walks you down. */
const DOOR_FORCED = set(0x71, 0x79, 0x7a, 0x7b);
export function doorForcedDirection(c: number | undefined): Dir | null {
  return member(DOOR_FORCED, c) ? "down" : null;
}

/** Ledges ($a0-$a7) and the facings that hop them; Gold's order ($a0 is
 * HOP_RIGHT, where Crystal's is HOP_DOWN). */
const LEDGE_FACINGS: Dir[][] = [
  ["right"], ["left"], ["up"], ["down"], ["down", "right"], ["down", "left"], ["up", "right"], ["up", "left"],
];
export function isLedge(c: number | undefined): boolean {
  return c !== undefined && c >= 0 && ((c & 0xff) >> 4) === 0xa;
}
export function ledgeFacings(c: number | undefined): Dir[] | null {
  return isLedge(c) ? LEDGE_FACINGS[c! & 7]! : null;
}

/** One-way walls ($b0) and buoys ($c0): what STANDING on one blocks
 * (.MovementPermissionsData, whose masks land each COLL_x_WALL on direction x). */
const SIDE_BLOCKS: Dir[][] = LEDGE_FACINGS;
export function isSideWall(c: number | undefined): boolean {
  if (c === undefined || c < 0) return false;
  const hi = (c & 0xff) >> 4;
  return hi === 0xb || hi === 0xc;
}
export function sideBlocks(c: number | undefined): Dir[] | null {
  return isSideWall(c) ? SIDE_BLOCKS[c! & 7]! : null;
}

/** GetMovementPermissions' neighbour arms: which wall kinds each side sees. */
const NEIGHBOR_ARM: Record<Dir, Set<number>> = {
  down: set(0x2, 0x6, 0x7),
  up: set(0x3, 0x4, 0x5),
  right: set(0x1, 0x5, 0x7),
  left: set(0x0, 0x4, 0x6),
};

/**
 * The direction a neighbouring side wall blocks, or null. Gold's arms all
 * `set RIGHT, [hl]` (home/map.asm:1960) -- read as blocking DOWN by the
 * facing test -- where Crystal fixed each to its own facing (`sideWallArms`).
 */
export function neighborBlocks(neighborDir: Dir, c: number | undefined, sideWallArms = false): Dir | null {
  if (!isSideWall(c) || !NEIGHBOR_ARM[neighborDir].has(c! & 7)) return null;
  return sideWallArms ? neighborDir : "down";
}

const DELTA: Record<Dir, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

/** The whole GetMovementPermissions verdict: may a step `dir` leave (cx, cy)? */
export function stepPermitted(
  collOf: (x: number, y: number) => number | undefined,
  cx: number,
  cy: number,
  dir: Dir,
  sideWallArms = false,
): boolean {
  if (sideBlocks(collOf(cx, cy))?.includes(dir)) return false;
  if (dir === "down" || sideWallArms) {
    for (const nd of Object.keys(DELTA) as Dir[]) {
      const [dx, dy] = DELTA[nd];
      if (neighborBlocks(nd, collOf(cx + dx, cy + dy), sideWallArms) === dir) return false;
    }
  }
  return true;
}

const OPPOSITE: Record<Dir, Dir> = { up: "down", down: "up", left: "right", right: "left" };

/** WillObjectBumpIntoTile .dir_masks: the directions an object cannot enter from. */
export function entryBlocks(c: number | undefined): Dir[] | null {
  return sideBlocks(c)?.map((d) => OPPOSITE[d]) ?? null;
}

/** WillObjectBumpIntoWater: may an NPC step from one tile to the next? */
export function objectStepPermitted(fromColl: number | undefined, toColl: number | undefined, dir: Dir): boolean {
  if (sideBlocks(fromColl)?.includes(dir)) return false;
  if (!isLand(toColl)) return false;
  return !entryBlocks(toColl)?.includes(dir);
}

/** CheckWarpCollision: the pits and every $7x. */
export function isWarpCollision(c: number | undefined): boolean {
  if (c === undefined || c < 0) return false;
  return c === 0x60 || c === 0x68 || (c >> 4) === 7;
}

/** CheckDirectionalWarp: carpets want a press their way. */
const CARPET_DIR: Record<number, Dir> = { 0x70: "down", 0x76: "left", 0x78: "up", 0x7e: "right" };
export function carpetDirection(c: number | undefined): Dir | null {
  return c === undefined ? null : CARPET_DIR[c] ?? null;
}

/** CheckWarpFacingDown: the arrival tiles that spawn you facing down (the
 * unused rows kept, as the cart tests against the whole array). */
const WARP_FACING_DOWN = set(0x71, 0x79, 0x7a, 0x73, 0x7b, 0x74, 0x7c, 0x75, 0x7d);
export const warpFacesDown = (c: number | undefined): boolean => member(WARP_FACING_DOWN, c);

/** An immediate warp on landing (doors, stairs, caves, panels), not a carpet. */
export function isImmediateWarp(c: number | undefined): boolean {
  return isWarpCollision(c) && carpetDirection(c) === null;
}
