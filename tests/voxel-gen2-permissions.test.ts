// Gen 2 collision permissions (game/gen2/permissions.ts, a port of
// gen1recomp src/world/gen2/Permissions.lua at bdfac727) and the cook's
// collision-quadrant cell rules.
import { describe, expect, test } from "bun:test";
import * as P from "../voxelmon/game/gen2/permissions.ts";
import { GameMap, type MapDef, type TilesetDef } from "../voxelmon/cook/data.ts";

describe("Gen 2 collision permissions", () => {
  test("the permission table's three answers", () => {
    expect(P.permissionOf(0x00)).toBe(P.LAND); // COLL_FLOOR
    expect(P.permissionOf(0x07)).toBe(P.WALL); // COLL_WALL
    expect(P.permissionOf(0x29)).toBe(P.WATER); // COLL_WATER
    expect(P.permissionOf(0x12)).toBe(P.WALL); // COLL_CUT_TREE
    expect(P.permissionOf(0x18)).toBe(P.LAND); // COLL_TALL_GRASS
    expect(P.permissionOf(0x71)).toBe(P.LAND); // COLL_DOOR
    expect(P.permissionOf(0x90)).toBe(P.WALL); // counter
    expect(P.permissionOf(undefined)).toBe(P.WALL);
  });

  test("grass, encounters, ledges, currents, warps", () => {
    expect(P.isGrass(0x18)).toBe(true);
    expect(P.isEncounterCollision(0x29)).toBe(true); // surfing rolls too
    expect(P.isEncounterCollision(0x10)).toBe(false); // the unused alias does not
    expect(P.ledgeFacings(0xa0)).toEqual(["right"]); // Gold's $a0 is HOP_RIGHT
    expect(P.ledgeFacings(0xa3)).toEqual(["down"]);
    expect(P.currentDirection(0x33)).toBe("down"); // the waterfall
    expect(P.doorForcedDirection(0x7a)).toBe("down");
    expect(P.isImmediateWarp(0x71)).toBe(true);
    expect(P.isImmediateWarp(0x70)).toBe(false); // a carpet wants a press
    expect(P.carpetDirection(0x70)).toBe("down");
  });

  test("side walls: standing blocks, and Gold's neighbour arms all read DOWN", () => {
    expect(P.sideBlocks(0xb2)).toEqual(["up"]);
    const coll = (x: number, y: number) => (x === 0 && y === 1 ? 0xb2 : 0x00);
    // an UP_WALL below blocks the step down onto it
    expect(P.stepPermitted(coll, 0, 0, "down")).toBe(false);
    expect(P.stepPermitted(coll, 0, 0, "left")).toBe(true);
    expect(P.neighborBlocks("left", 0xb0)).toBe("down");
    expect(P.neighborBlocks("left", 0xb0, true)).toBe("left"); // Crystal's fix
  });

  test("the cook judges a Gen 2 cell by its metatile quadrant", () => {
    const tileset = {
      id: "TILESET_TEST", image: "tilesets/test", imageWidth: 128, imageHeight: 48, tilesPerRow: 16,
      blocks: [new Array(16).fill(1), new Array(16).fill(2)],
      collision: [[0x00, 0x07, 0x29, 0x18], [0x07, 0x07, 0x07, 0x07]],
    } as unknown as TilesetDef;
    const def = { id: "TEST", index: 0, tileset: "TILESET_TEST", width: 1, height: 1, blocks: [0], borderBlock: 1 } as MapDef;
    const m = new GameMap(def, tileset);
    expect(m.cellCollision(0, 0)).toBe(0x00);
    expect(m.isWalkableCell(0, 0)).toBe(true);
    expect(m.isWalkableCell(1, 0)).toBe(false);
    expect(m.isWaterCell(0, 1)).toBe(true);
    expect(m.isGrassCell(1, 1)).toBe(true);
    // off the map, the border block's quadrants
    expect(m.isWalkableCell(-1, 0)).toBe(false);
  });
});
