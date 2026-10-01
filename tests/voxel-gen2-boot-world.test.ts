// The Gold engine end to end, headless: Game2 straight into the world (the
// boot cinema skipped, as POKEPORT_DRIVER does), stepped frame by frame with
// the pad, drawn onto the Gold screen, and the voxel scene emitted under it.

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VOX_BTN, VOX_OP } from "../contracts/spec/voxel-spec.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";
import { haveGoldGen, useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { Lcd } from "../voxelmon/game/gen2/platform/lcd.ts";
import { WorldView } from "../voxelmon/game/gen2/platform/worldview.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";

const gold = haveGoldGen();
const WALKER = join(import.meta.dir, "..", "dist", "voxelmon", "paks_gold", "gamedata.json");

function walkerData(): unknown {
  try {
    const text = readFileSync(WALKER, "utf8");
    if (text.startsWith("PVG2")) {
      const { readGen2Container } = require("../voxelmon/game/gen2/platform/container.ts");
      const c = readGen2Container(text);
      return JSON.parse(c.scene ?? c.walker);
    }
    return JSON.parse(text);
  } catch {
    return null;
  }
}

describe("gen2 boot into the world", () => {
  test.skipIf(!gold)("Game2 walks the bedroom and the scene follows", async () => {
    useGoldGen();
    const { useGoldTiles } = await import("../voxelmon/game/gen2/platform/shot-node.ts");
    useGoldTiles();
    const host = new RecorderHost();
    const lcd = new Lcd(host);
    const game = Game2.new();
    game.load({ startWorld: true });
    expect(game.phase).toBe("play");
    expect(game.world?.map?.id).toBe("PLAYERS_HOUSE_2F");
    const view = new WorldView(host, walkerData() as never);
    let tick = 0;
    const step = (buttons: number, n = 1): void => {
      for (let i = 0; i < n; i++) {
        game.frame(buttons);
        game.draw(lcd);
        lcd.end();
        view.emit(game);
        host.frameDone(tick++, buttons);
      }
    };
    step(0, 30);
    const start = { x: game.world.player.cellX, y: game.world.player.cellY };
    // walk left a few cells
    step(VOX_BTN.left, 40);
    step(0, 20);
    const moved = game.world.player.cellX !== start.x || game.world.player.cellY !== start.y;
    expect(moved).toBe(true);
    const trace = host.text();
    // the map, the camera and the player card
    expect(trace).toContain(`o ${VOX_OP.mapShow} 0 `);
    expect(trace).toContain(`o ${VOX_OP.cam} `);
    expect(trace).toMatch(new RegExp(`o ${VOX_OP.ent} 0 `));
    if (process.env.GOLD_SHOTS) writeFileSync(`${process.env.GOLD_SHOTS}/boot_world.vtrace`, trace);
  });
});
