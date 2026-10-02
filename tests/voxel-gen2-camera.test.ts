// Gold's walk with the 3D camera swung round (Game2.camTurns, World.pollInput):
// a press is screen-relative, so "up" walks away from the camera, as on the
// Kanto games (world/collision.ts rotateDir); and rotateFacing, which the
// sprites' poses turn back through.
import { describe, expect, test } from "bun:test";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { haveGoldGen, useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";
import { rotateFacing } from "../voxelmon/game/gen2/world/rotate.ts";
import { spritePose } from "../voxelmon/game/gen2/world/Player.ts";

const gold = haveGoldGen();

describe("gen2 camera-relative walk", () => {
  test("rotateFacing turns clockwise and back", () => {
    expect(rotateFacing("up", 1)).toBe("right");
    expect(rotateFacing("up", 2)).toBe("down");
    expect(rotateFacing("left", 1)).toBe("up");
    expect(rotateFacing("down", -1)).toBe("right");
    expect(rotateFacing("right", 4)).toBe("right");
    for (const d of ["up", "down", "left", "right"] as const) {
      for (let q = 0; q < 4; q++) expect(rotateFacing(rotateFacing(d, q), -q)).toBe(d);
    }
  });

  test.skipIf(!gold)("UP walks the way the camera faces, whichever way it is turned", () => {
    useGoldGen();
    const game: any = Game2.new();
    game.load({ startWorld: true });
    const w = game.world;
    // an open stretch of New Bark Town
    const walk = (turns: number): [number, number] => {
      w.setMap("NEW_BARK_TOWN", 8, 8, "down");
      for (let i = 0; i < 30; i++) game.frame(0);
      const x0 = w.player.cellX;
      const y0 = w.player.cellY;
      game.camTurns = turns;
      for (let i = 0; i < 40; i++) game.frame(i < 30 ? VOX_BTN.up : 0);
      game.camTurns = 0;
      return [w.player.cellX - x0, w.player.cellY - y0];
    };
    // no turn: north; a quarter turn: east; half: south; three quarters: west
    const n = walk(0);
    expect(n[1]).toBeLessThan(0);
    expect(n[0]).toBe(0);
    const e = walk(1);
    expect(e[0]).toBeGreaterThan(0);
    expect(e[1]).toBe(0);
    const s = walk(2);
    expect(s[1]).toBeGreaterThan(0);
    expect(s[0]).toBe(0);
    const west = walk(3);
    expect(west[0]).toBeLessThan(0);
    expect(west[1]).toBe(0);
  });
  test.skipIf(!gold)("people show the camera the side it sees: walking toward a turned camera shows the face", () => {
    useGoldGen();
    const game: any = Game2.new();
    game.load({ startWorld: true });
    const w = game.world;
    w.setMap("NEW_BARK_TOWN", 8, 8, "down");
    for (let i = 0; i < 30; i++) game.frame(0);
    // the camera turned half round, the player pressing DOWN (toward the
    // camera): the walk goes world north, and the sprite must show its front
    game.camTurns = 2;
    for (let i = 0; i < 6; i++) game.frame(VOX_BTN.down);
    const p = w.player;
    expect(p.facing).toBe("up");
    const front = spritePose(p.sprite, "down", p.walkPhase(), p.drawFlip())[0];
    const seen = w.viewState(true).player.view;
    expect(seen.frame).toBe(front);
    expect(seen.facing).toBe("up"); // the world facing is left as it is
    // and an NPC's pose turns the same way
    const npc = w.npcs.find((n: any) => n.sprite);
    if (npc) {
      npc.facing = "left";
      const turned = npc.viewState(2);
      expect(turned.frame).toBe(spritePose(npc.sprite, rotateFacing("left", -2), turned.phase, turned.flip)[0]);
      expect(npc.viewState(0).frame).toBe(spritePose(npc.sprite, "left", turned.phase, turned.flip)[0]);
    }
    game.camTurns = 0;
  });
});
