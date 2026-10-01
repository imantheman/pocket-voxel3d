// Gold's VIEW 2D (voxelmon/game/gen2/platform/map2d.ts): what it draws past
// a map's edge.
import { describe, expect, test } from "bun:test";
import { haveGoldGen, useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";
import { mapTileAt } from "../voxelmon/game/gen2/platform/map2d.ts";

const gold = haveGoldGen();

describe("gen2 VIEW 2D", () => {
  test.skipIf(!gold)("past New Bark Town's west edge Route 29 shows, not the border", () => {
    useGoldGen();
    const game = Game2.new();
    game.load({ startWorld: true });
    const world: any = game.world;
    world.setMap("NEW_BARK_TOWN", 6, 6, "down");
    const map = world.map;
    expect(map.id).toBe("NEW_BARK_TOWN");
    const conn = map.connections.west;
    expect(conn).toBeTruthy();
    const route = world.maps[conn.mapId ?? conn.map];
    const blocks: number[][] = map.tileset.blocks;
    let checked = 0;
    for (let ty = 0; ty < map.height * 4; ty++) {
      for (let tx = -8; tx < 0; tx++) {
        const nbx = Math.floor(tx / 4) + route.width;
        const nby = Math.floor(ty / 4) - (conn.offset ?? 0);
        if (nby < 0 || nby >= route.height) continue;
        const want = blocks[route.blocks[nby * route.width + nbx]]![(ty & 3) * 4 + (tx & 3)];
        expect(mapTileAt(world, map, tx, ty)).toBe(want!);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(40);
    // and somewhere nothing connects (above the town): the border block
    const border = blocks[map.borderBlock]!;
    expect(mapTileAt(world, map, 4, -5)).toBe(border[(-5 & 3) * 4 + 0]!);
  });
});
