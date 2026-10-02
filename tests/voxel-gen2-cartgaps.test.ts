// What the Gold/Silver carts did that the port had left out (the 2026-10-02
// audit): wild held items, the wall TOWN MAP, PROF.OAK's rating at the end
// of the HALL OF FAME, and the clock-reset password.
import { describe, expect, test } from "bun:test";
import { haveGoldGen, useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";
import { rollWildItem } from "../voxelmon/game/gen2/world/World.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";

const gold = haveGoldGen();

/** A roll function that hands out `bytes` in order. */
function rolls(...bytes: number[]): (n: number) => number {
  let i = 0;
  return () => bytes[i++] ?? 0;
}

describe("wild held items", () => {
  test("75% none, then 8% of the rest Item2, else Item1", () => {
    const miltank = { items: ["MOOMOO_MILK", "MOOMOO_MILK"] };
    const pair = { items: ["MYSTERYBERRY", "MOON_STONE"] };
    expect(rollWildItem(pair, rolls(191))).toBeUndefined();
    expect(rollWildItem(pair, rolls(192, 20))).toBe("MYSTERYBERRY");
    expect(rollWildItem(pair, rolls(255, 19))).toBe("MOON_STONE");
    expect(rollWildItem(miltank, rolls(200, 0))).toBe("MOOMOO_MILK");
  });

  test("an empty slot rolls to nothing: CHANSEY's LUCKY EGG is the 2% one", () => {
    const chansey = { items: { "2": "LUCKY_EGG" } };
    expect(rollWildItem(chansey, rolls(255, 50))).toBeUndefined();
    expect(rollWildItem(chansey, rolls(255, 5))).toBe("LUCKY_EGG");
    expect(rollWildItem({ items: [] }, rolls(255, 0))).toBeUndefined();
    expect(rollWildItem(undefined)).toBeUndefined();
  });

  test.skipIf(!gold)("a wild battle's mon comes out holding its roll", () => {
    useGoldGen();
    const game: any = Game2.new();
    game.load({ startWorld: true });
    game.writeSave = () => [true];
    for (let k = 0; k < 30; k++) game.frame(0);
    const w = game.world;
    let held = 0;
    let none = 0;
    for (let i = 0; i < 200; i++) {
      const wild: any = { species: "MILTANK", level: 5 };
      const base = game.stack.states.length;
      w.startBattle({ wild }, () => {});
      while (game.stack.states.length > base) game.stack.pop();
      if (wild.item === "MOOMOO_MILK") held++;
      else if (wild.item == null) none++;
    }
    expect(held + none).toBe(200);
    // 25% expected: comfortably inside 10..45%
    expect(held).toBeGreaterThan(20);
    expect(held).toBeLessThan(90);
  });
});

describe("the wall TOWN MAP", () => {
  test.skipIf(!gold)("OverworldTownMap opens the region map; B puts it away and the script goes on", () => {
    useGoldGen();
    const game: any = Game2.new();
    game.load({ startWorld: true });
    game.writeSave = () => [true];
    for (let k = 0; k < 30; k++) game.frame(0);
    const w = game.world;
    const id = w.constants.specialOrder.indexOf("OverworldTownMap");
    expect(id).toBeGreaterThanOrEqual(0);
    w.vm.start([{ op: "special", id }, { op: "end" }]);
    for (let k = 0; k < 20; k++) game.frame(0);
    const top = game.stack.top();
    expect(top?.screenId ?? top?.constructor?.name).toContain("Pokegear");
    expect(top.townMap).toBe(true);
    for (let k = 0; k < 6; k++) game.frame(k === 0 ? VOX_BTN.b : 0);
    expect(game.stack.top()?.townMap).toBeUndefined();
    for (let k = 0; k < 20; k++) game.frame(0);
    expect(w.vm.running()).toBe(false);
  });
});
