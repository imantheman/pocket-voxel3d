// Gold's free walk (World.freeWalk, MOVEMENT: FREE -- the Kanto games' free
// movement ported): a continuous position steered by the camera's yaw, the
// logical cell following it, a door walked into warping, a map edge crossed,
// and MOVEMENT: GRID (or a host that sends no yaw) still walking the grid.
import { describe, expect, test } from "bun:test";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { haveGoldGen, useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";

const gold = haveGoldGen();

function boot(): any {
  useGoldGen();
  const game: any = Game2.new();
  game.load({ startWorld: true });
  return game;
}

function place(game: any, map: string, x: number, y: number): void {
  game.world.setMap(map, x, y, "down");
  for (let i = 0; i < 40; i++) game.frame(0);
}

function hold(game: any, b: number, frames: number): void {
  for (let i = 0; i < frames; i++) game.frame(b);
}

describe("gen2 free walk", () => {
  test.skipIf(!gold)("continuous, steered by the camera's yaw, the cell following", () => {
    const game = boot();
    const w = game.world;
    place(game, "NEW_BARK_TOWN", 8, 8);
    game.camYaw = 0;
    const p = w.player;
    const py0 = p.py;
    // a few frames up: the body moves, but not a whole cell, and not on the grid
    hold(game, VOX_BTN.up, 3);
    expect(p.moving).toBe(false);
    expect(p.py).toBeLessThan(py0);
    expect(p.py % 16).not.toBe(0);
    expect(p.cellY).toBe(8);
    // on past the half cell: the logical cell follows
    hold(game, VOX_BTN.up, 10);
    expect(p.cellY).toBe(7);
    expect(p.facing).toBe("up");

    // the camera turned a quarter (yaw pi/2): UP walks east
    place(game, "NEW_BARK_TOWN", 8, 8);
    game.camYaw = Math.PI / 2;
    const x0 = w.player.px;
    const y0 = w.player.py;
    hold(game, VOX_BTN.up, 6);
    expect(w.player.px).toBeGreaterThan(x0);
    expect(w.player.py).toBe(y0);
    expect(w.player.facing).toBe("right");

    // the circle pad pushed up-right with the camera straight: both at once
    place(game, "NEW_BARK_TOWN", 8, 8);
    game.camYaw = 0;
    game.stick = { x: 0.7, y: 0.7 };
    const a0 = [w.player.px, w.player.py];
    hold(game, 0, 6);
    expect(w.player.px).toBeGreaterThan(a0[0]);
    expect(w.player.py).toBeLessThan(a0[1]);
    game.stick = undefined;
  });

  test.skipIf(!gold)("a door walked into warps", () => {
    const game = boot();
    const w = game.world;
    game.camYaw = 0;
    // the player's house from New Bark Town: up into its door
    const door = w.maps.NEW_BARK_TOWN.warps.find((d: any) => d.destMap === "PLAYERS_HOUSE_1F");
    place(game, "NEW_BARK_TOWN", door.x, door.y + 1);
    game.camYaw = 0;
    for (let i = 0; i < 120 && w.map.id === "NEW_BARK_TOWN"; i++) game.frame(VOX_BTN.up);
    for (let i = 0; i < 60; i++) game.frame(0);
    expect(w.map.id).toBe("PLAYERS_HOUSE_1F");

    // (a fresh game: the house's own scene is still running in this one)
  });

  test.skipIf(!gold)("a map edge walked off crosses to the next map", () => {
    const game = boot();
    const w = game.world;
    // west off Route 29 into Cherrygrove (New Bark's west edge is scripted)
    place(game, "ROUTE_29", 5, 8);
    const map = w.map;
    let row = -1;
    for (let y = 0; y < map.heightCells && row < 0; y++) {
      if (map.isWalkable(0, y) && map.isWalkable(1, y) && map.isWalkable(2, y)) row = y;
    }
    expect(row).toBeGreaterThanOrEqual(0);
    place(game, "ROUTE_29", 2, row);
    game.camYaw = 0;
    for (let i = 0; i < 200 && w.map.id === "ROUTE_29"; i++) game.frame(VOX_BTN.left);
    expect(w.map.id).toBe("CHERRYGROVE_CITY");
  });

  test.skipIf(!gold)("a ledge hops from its cell; each cell crossed counts a step", async () => {
    const { Permissions } = await import("../voxelmon/game/gen2/world/Permissions.ts");
    const game = boot();
    const w = game.world;
    place(game, "ROUTE_29", 5, 8);
    const map = w.map;
    // a ledge facing down: walkable above it, the drop itself not, land past it
    let at: [number, number] | null = null;
    for (let y = 1; y < map.heightCells - 2 && !at; y++) {
      for (let x = 1; x < map.widthCells - 1 && !at; x++) {
        const f = Permissions.ledgeFacings(map.cellCollision(x, y));
        if (f && f.down && map.isWalkable(x, y - 1) && map.isWalkable(x, y) && !map.isWalkable(x, y + 1)
            && map.isWalkable(x, y + 2) && !w.npcAt(x, y - 1) && !w.npcAt(x, y + 2)) at = [x, y];
      }
    }
    expect(at).not.toBeNull();
    const [lx, ly] = at!;
    place(game, "ROUTE_29", lx, ly - 1);
    game.camYaw = 0;
    const steps0 = game.save.stepCount ?? 0;
    let jumped = false;
    for (let i = 0; i < 120 && !jumped; i++) {
      game.frame(VOX_BTN.down);
      if (w.player.jumping) jumped = true;
    }
    expect(jumped).toBe(true);
    for (let i = 0; i < 60; i++) game.frame(0);
    expect(w.player.cellY).toBe(ly + 2);
    // one free crossing (onto the ledge's cell) and the hop's landing
    expect(((game.save.stepCount ?? 0) - steps0 + 256) % 256).toBe(2);
  });

  test.skipIf(!gold)("MOVEMENT: GRID, or no yaw from the host, walks the grid", () => {
    const game = boot();
    const w = game.world;
    for (const how of ["grid option", "no yaw"]) {
      place(game, "NEW_BARK_TOWN", 8, 8);
      if (how === "grid option") {
        game.camYaw = 0;
        game.options.movement = "grid";
      } else {
        game.camYaw = undefined;
        delete game.options.movement;
      }
      // (a press from another facing turns in place first)
      for (let i = 0; i < 20 && !w.player.moving; i++) game.frame(VOX_BTN.up);
      // a grid step under way: moving, toward a whole cell
      expect(w.player.moving).toBe(true);
      expect(w.player.targetY).toBe(7);
      hold(game, 0, 30);
      expect(w.player.py % 16).toBe(0);
    }
    delete game.options.movement;
  });
});
