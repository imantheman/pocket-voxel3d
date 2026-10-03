// Gold's VIEW 2D (voxelmon/game/gen2/platform/map2d.ts): what it draws past
// a map's edge.
import { describe, expect, test } from "bun:test";
import { haveGoldGen, useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";
import { mapTileAt, tilesFor } from "../voxelmon/game/gen2/platform/map2d.ts";
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

describe("gen2 VIEW 2D grid", () => {
  test.skipIf(!gold)("every map's grid matches the tile-at-a-time reference (mapTileAt), ids and palettes", () => {
    useGoldGen();
    const game = Game2.new();
    game.load({ startWorld: true });
    const world: any = game.world;
    let maps = 0;
    for (const id of Object.keys(world.maps)) {
      try {
        world.setMap(id, 1, 1, "down");
      } catch {
        continue;
      }
      const map = world.map;
      if (!map || map.id !== id) continue;
      const t = tilesFor(world, map, `test:${id}`);
      if (!t) continue;
      const [, tileset] = world.atlasFor(map.def);
      const tilePal: number[] = tileset.tilePalettes ?? [];
      const pad = (t.pw - map.width * 4) / 2;
      for (let y = 0; y < t.ph; y++) {
        for (let x = 0; x < t.pw; x++) {
          const tile = mapTileAt(world, map, x - pad, y - pad);
          const i = y * t.pw + x;
          if (t.ids[i] !== t.idOf(tile) || t.pal[i] !== (((tilePal[tile] ?? 1) - 1) & 7)) {
            throw new Error(`${id} (${x - pad}, ${y - pad}): ${t.ids[i]}/${t.pal[i]} != ${t.idOf(tile)}/${((tilePal[tile] ?? 1) - 1) & 7}`);
          }
        }
      }
      maps++;
    }
    expect(maps).toBeGreaterThan(300);
  });

  test.skipIf(!gold)("the grid goes to the 3DS shim as its arrays, not hex rows", () => {
    useGoldGen();
    const calls: string[] = [];
    let got: [Uint16Array, Uint8Array] | null = null;
    const nop = () => {};
    const lcd = new Lcd({
      lcdCells: nop, lcdObjs: nop, lcdPals: nop, lcdRegs: nop, lcdLines: nop, lcdShow: nop, lcdBank: nop, lcdReset: nop,
      lcdUnder: (w: number, h: number) => calls.push(`under ${w}x${h}`),
      lcdUnderRow: () => calls.push("row"),
      lcdUnderBin: (ids: Uint16Array, attrs: Uint8Array) => {
        calls.push("bin");
        got = [ids, attrs];
      },
    } as never);
    const ids = new Uint16Array([1, 2, 3, 4, 5, 6]);
    const attrs = new Uint8Array([7, 8, 9, 10, 11, 12]);
    lcd.under({}, ids, attrs, 3, 2);
    expect(calls).toEqual(["under 3x2", "bin"]);
    expect([...got![0]]).toEqual([1, 2, 3, 4, 5, 6]);
    expect([...got![1]]).toEqual([7, 8, 9, 10, 11, 12]);
  });
});
