// Gold's VIEW 2D (voxelmon/game/gen2/platform/map2d.ts): what it draws past
// a map's edge.
import { describe, expect, test } from "bun:test";
import { haveGoldGen, useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";
import { mapTileAt } from "../voxelmon/game/gen2/platform/map2d.ts";
import { Lcd } from "../voxelmon/game/gen2/platform/lcd.ts";

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

  test.skipIf(!gold)("the sea moves: its tile is aliased to the frame of the step", async () => {
    useGoldGen();
    const { useGoldTiles } = await import("../voxelmon/game/gen2/platform/shot-node.ts");
    useGoldTiles();
    const aliases: [number, number, number][] = [];
    const nop = () => {};
    const host = {
      lcdShow: nop, lcdBank: nop, lcdReset: nop, lcdCells: nop, lcdRegs: nop, lcdObjs: nop, lcdPals: nop,
      lcdLines: nop, lcdUnder: nop, lcdUnderRow: nop, lcdUnderAt: nop,
      lcdAlias: (slot: number, from: number, to: number) => aliases.push([slot, from, to]),
    };
    const lcd = new Lcd(host as never);
    const game: any = Game2.new();
    game.load({ startWorld: true });
    game.options.view = "2d";
    game.world.setMap("CHERRYGROVE_CITY", 10, 8, "down");
    const tos = new Set<number>();
    for (let i = 0; i < 240; i++) {
      game.frame(0);
      game.draw(lcd);
      lcd.end();
      for (const a of aliases) if (a[1] >= 0) tos.add(a[2]);
    }
    // aliased at all, and to more than one frame as the steps go by
    expect(aliases.some((a) => a[1] >= 0)).toBe(true);
    expect(tos.size).toBeGreaterThan(1);
  });
});
