// Gold's walker (docs/gold-plan.md step 1): the Gen 1 overworld over Gold's
// maps, cells judged by collision byte. Runs on the Gold import
// (dist/voxelmon/gold/gen, from the player's own ROM); skipped without it.
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { loadGen } from "../voxelmon/cook/data.ts";
import { buildGen2Gamedata } from "../voxelmon/cook/gen2gamedata.ts";
import { fromObject } from "../voxelmon/game/data.ts";
import { VoxelmonGame } from "../voxelmon/game/game.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";

const genDir = join(import.meta.dir, "../dist/voxelmon/gold/gen");
const hasGold = existsSync(join(genDir, "maps.json"));

function goldGame(): VoxelmonGame {
  const gen = loadGen(genDir);
  const cooked = ["PLAYERS_HOUSE_2F", "PLAYERS_HOUSE_1F", "NEW_BARK_TOWN", "ELMS_LAB", "ROUTE_29"];
  const json = new TextDecoder().decode(buildGen2Gamedata(gen, { sprites: {} }, cooked));
  const game = new VoxelmonGame(fromObject(JSON.parse(json)), new RecorderHost(), 1);
  game.newGame();
  return game;
}

describe("Gold: walking Johto", () => {
  test.skipIf(!hasGold)("a new game wakes in the player's room, and the house leads out to New Bark Town", () => {
    const game = goldGame();
    const ow = game.overworld as any;
    expect([ow.map.id, ow.player.cellX, ow.player.cellY]).toEqual(["PLAYERS_HOUSE_2F", 3, 3]);
    expect(game.stackKinds()).toEqual(["overworld"]);
    const walk = (btn: number, frames: number) => {
      for (let i = 0; i < frames; i++) game.tick(btn);
      for (let i = 0; i < 40; i++) game.tick(0);
    };
    walk(VOX_BTN.right, 80);
    walk(VOX_BTN.up, 80); // the stairs at (7,0)
    expect(ow.map.id).toBe("PLAYERS_HOUSE_1F");
    walk(VOX_BTN.down, 200);
    walk(VOX_BTN.left, 40);
    walk(VOX_BTN.down, 200); // the front door mat
    expect(ow.map.id).toBe("NEW_BARK_TOWN");
    const x = ow.player.cellX;
    walk(VOX_BTN.left, 120);
    expect(ow.player.cellX).toBeLessThan(x); // the town is walkable by collision
  });

  test.skipIf(!hasGold)("walls and water stop you: the collision bytes rule", () => {
    const game = goldGame();
    const map = (game.overworld as any).map;
    expect(map.byCollision).toBe(true);
    // the bedroom's walls are the top row
    expect(map.isWalkableCell(3, 0)).toBe(false);
    expect(map.isWalkableCell(3, 3)).toBe(true);
  });
});
