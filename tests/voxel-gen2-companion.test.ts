// Gold's bottom screen (voxelmon/game/gen2/ui/Companion.ts): its pages, turned
// by touch -- a tap is the finger lifting after it went down on a target.
import { describe, expect, test } from "bun:test";
import { haveGoldGen, useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";
import { Mon } from "../voxelmon/game/gen2/battle/Mon.ts";
import { Companion } from "../voxelmon/game/gen2/ui/Companion.ts";

const gold = haveGoldGen();

/** A host that keeps the cells sent to the bottom screen (target 1). */
function bottomHost(): { host: any; cells: string[] } {
  const cells: string[] = [];
  let target = 0;
  const host: any = {
    lcdTarget: (k: number) => { target = k; },
    lcdCells: (offset: number, hex: string) => { if (target === 1) cells.push(`${offset}:${hex}`); },
    lcdShow: () => {}, lcdBank: () => {}, lcdReset: () => {}, lcdRegs: () => {},
    lcdObjs: () => {}, lcdPals: () => {}, lcdLines: () => {},
  };
  return { host, cells };
}

/** A tap at panel cell (cx, cy): bottom-screen pixels are 16 a cell. */
function tap(c: Companion, game: any, cx: number, cy: number): void {
  c.touch(game, cx * 16 + 8, cy * 16 + 8, true);
  c.touch(game, cx * 16 + 8, cy * 16 + 8, true);
  c.touch(game, 0, 0, false);
}

describe("gen2 Companion (the bottom screen)", () => {
  test.skipIf(!gold)("tabs, a mon's page and back; every page draws to screen 1", async () => {
    useGoldGen();
    // the cooked tile pages, so the town map has art to draw
    const { useGoldTiles } = await import("../voxelmon/game/gen2/platform/shot-node.ts");
    useGoldTiles();
    const game: any = Game2.new();
    game.load({ startWorld: true });
    game.save.party = [
      Mon.new(game.data, "CYNDAQUIL", 12, {}),
      Mon.new(game.data, "TOGEPI", 5, {}),
    ];
    const { host, cells } = bottomHost();
    const c = new Companion(host, []);
    const page = () => (c as any).page as string;
    const draw = () => {
      const before = cells.length;
      for (let i = 0; i < 20; i++) c.frame(game);
      return cells.length - before;
    };
    expect(draw()).toBeGreaterThan(0);
    expect(page()).toBe("party");
    // a still panel sends nothing more
    expect(draw()).toBe(0);

    // the second mon's name row (row 4) opens its page; a tap there turns to
    // the next mon, wrapping
    tap(c, game, 3, 4);
    expect(page()).toBe("mon");
    expect((c as any).mon).toBe(1);
    expect(draw()).toBeGreaterThan(0);
    tap(c, game, 3, 7);
    expect((c as any).mon).toBe(0);

    // the tab row: <PK><MN> (columns 0-2), BADGE (4-9), CARD (10-14), MAP (16-19)
    tap(c, game, 9, 14);
    expect(page()).toBe("badges");
    expect(draw()).toBeGreaterThan(0);
    tap(c, game, 12, 14);
    expect(page()).toBe("card");
    expect(draw()).toBeGreaterThan(0);
    tap(c, game, 18, 14);
    expect(page()).toBe("map");
    expect(draw()).toBeGreaterThan(0);
    // the MAP page follows the player across the sea: one POKeGEAR, handed
    // the new landmark (Kanto's region with it)
    const gear = (c as any).gear;
    const before = gear.currentLandmark;
    game.world.setMap("VERMILION_CITY", 10, 10, "down");
    for (let i = 0; i < 30; i++) game.frame(0);
    expect(game.world.map.id).toBe("VERMILION_CITY");
    expect(draw()).toBeGreaterThan(0);
    expect((c as any).gear).toBe(gear);
    expect(gear.currentLandmark).not.toBe(before);
    expect(gear.region()).toBe("kanto");
    tap(c, game, 2, 14);
    expect(page()).toBe("party");

    // an empty party row and the gap between tabs do nothing
    tap(c, game, 3, 10);
    expect(page()).toBe("party");
    tap(c, game, 3, 14);
    expect(page()).toBe("party");

    // a finger that is only resting (never lifted) does nothing yet
    c.touch(game, 9 * 16, 14 * 16, true);
    expect(page()).toBe("party");
    c.touch(game, 0, 0, false);
    expect(page()).toBe("badges");
  });
});
