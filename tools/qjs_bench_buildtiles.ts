// buildTiles (world/view2d.ts), the 2D view's per-map tile cache, timed
// under QuickJS over every cooked Kanto map (tools/qjs_gold_harness.c via
// cc_qjs_buildtiles.sh). Never shipped.
import "../voxelmon/game/psp-main.ts";
import { buildTiles } from "../voxelmon/game/world/view2d.ts";

const g = globalThis as unknown as { voxelmonGame: any; frame: (b: number) => void; voxel: { now: () => number } };
const game = g.voxelmonGame;
const now = g.voxel.now;
while (game.stack.length > 1) game.pop();
const ow = game.overworld;
const names = ["PALLET_TOWN", "ROUTE_1", "VIRIDIAN_CITY", "SAFFRON_CITY", "CELADON_CITY", "REDS_HOUSE_1F", "ROUTE_17"];
let done = false;
g.frame = (): void => {
  if (done) return;
  done = true;
  let sum = 0;
  for (const id of names) {
    ow.enter(id, 3, 3, "down");
    const map = ow.map;
    const a = now();
    for (let k = 0; k < 10; k++) buildTiles(map, game.data.maps, game.data.field?.cutTreeSwaps);
    const us = (now() - a) / 10;
    sum += us;
    console.log(`[bt] ${id} ${map.def.width}x${map.def.height} blocks: ${(us / 1000).toFixed(2)} ms`);
  }
  console.log(`[bt] mean ${(sum / names.length / 1000).toFixed(2)} ms`);
};
