// VIEW 2D's overworld (voxelmon/game/world/view2d.ts): the GB screen's BG
// ring against the map it draws.
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadRuntimeData, REQUIRED_MODULES } from "../voxelmon/game/data.ts";
import { VoxelmonGame } from "../voxelmon/game/game.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";
import { OverworldView2d } from "../voxelmon/game/world/view2d.ts";

const genDir = join(import.meta.dir, "../dist/voxelmon/gen");
const hasGen = REQUIRED_MODULES.every((m) => existsSync(join(genDir, `${m}.json`)));
const data = hasGen ? await loadRuntimeData(genDir) : null;

function gameAt(map: string, x: number, y: number): any {
  const game: any = new VoxelmonGame(data!, new RecorderHost(), 1);
  game.newGame();
  while (game.stack.length > 1) game.pop();
  game.overworld.enter(map, x, y, "down");
  return game;
}

/** The ring's tile at screen tile (sx, sy). */
function screenTile(v: any, sx: number, sy: number): number {
  return v.maps[(((v.scy >> 3) + sy) & 31) * 32 + (((v.scx >> 3) + sx) & 31)];
}

describe("VIEW 2D overworld", () => {
  test.skipIf(!hasGen)("the ring holds the map's tiles under the screen", () => {
    const game = gameAt("VIRIDIAN_POKECENTER", 3, 4);
    const v = new OverworldView2d().build(game)!;
    const p = game.overworld.player;
    const tx0 = Math.floor((Math.round(p.px) - 64) / 8);
    const ty0 = Math.floor((Math.round(p.py) - 64) / 8);
    for (let sy = 0; sy < 18; sy++) {
      for (let sx = 0; sx < 20; sx++) {
        expect(screenTile(v, sx, sy)).toBe(game.overworld.map.tileAt(tx0 + sx, ty0 + sy) & 0x7f);
      }
    }
    // the player's four sprites, at (64, 60) on screen
    expect(v.oam[0]! - 16).toBe(60);
    expect(v.oam[1]! - 8).toBe(64);
  });

  test.skipIf(!hasGen)("past a town's edge the connected route shows, not the border", () => {
    // Viridian's south edge: ROUTE_1 below, five blocks in
    const game = gameAt("VIRIDIAN_CITY", 20, 34);
    const v = new OverworldView2d().build(game)!;
    const route = data!.maps!.ROUTE_1!;
    const ts = data!.tilesets!.OVERWORLD! as unknown as { blocks: number[][] };
    const p = game.overworld.player;
    const tx0 = Math.floor((Math.round(p.px) - 64) / 8);
    const ty0 = Math.floor((Math.round(p.py) - 64) / 8);
    const viridianH = data!.maps!.VIRIDIAN_CITY!.height;
    let checked = 0;
    for (let sy = 0; sy < 18; sy++) {
      const ty = ty0 + sy;
      if (ty < viridianH * 4) continue;
      for (let sx = 0; sx < 20; sx++) {
        const tx = tx0 + sx;
        const nbx = Math.floor(tx / 4) - 5;
        const nby = Math.floor(ty / 4) - viridianH;
        if (nbx < 0 || nbx >= route.width) continue;
        const block = ts.blocks[route.blocks[nby * route.width + nbx]!]!;
        expect(screenTile(v, sx, sy)).toBe(block[(ty & 3) * 4 + (tx & 3)]! & 0x7f);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(40);
  });

  test.skipIf(!hasGen)("a cut tree's block is drawn as CUT leaves it", () => {
    const swaps = (data as any).field.cutTreeSwaps as { before: number; after: number }[];
    const def = data!.maps!.ROUTE_2!;
    const bi = def.blocks.findIndex((b) => swaps.some((s) => s.before === b));
    expect(bi).toBeGreaterThanOrEqual(0);
    const bx = bi % def.width;
    const by = Math.floor(bi / def.width);
    const game = gameAt("ROUTE_2", bx * 2, by * 2 + 2);
    const view = new OverworldView2d();
    const p = game.overworld.player;
    const tx0 = Math.floor((Math.round(p.px) - 64) / 8);
    const ty0 = Math.floor((Math.round(p.py) - 64) / 8);
    const ts = data!.tilesets!.OVERWORLD! as unknown as { blocks: number[][] };
    const at = (v: any) => screenTile(v, bx * 4 - tx0, by * 4 - ty0);
    const before = ts.blocks[def.blocks[bi]!]![0]! & 0x7f;
    expect(at(view.build(game))).toBe(before);
    game.overworld.map.markCut(bx * 2, by * 2);
    const after = ts.blocks[swaps.find((s) => s.before === def.blocks[bi])!.after]![0]! & 0x7f;
    expect(at(view.build(game))).toBe(after);
  });
});
