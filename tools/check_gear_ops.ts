// Debug: what one Kanto Gear redraw sends (bun tools/check_gear_ops.ts).
import { join } from "node:path";
import { loadRuntimeData } from "../voxelmon/game/data.ts";
import { VoxelmonGame } from "../voxelmon/game/game.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";
import { drawKantoGear } from "../voxelmon/game/ui/kantogear.ts";

const data = await loadRuntimeData(join(import.meta.dir, "../dist/voxelmon/gen"));
const game: any = new VoxelmonGame(data, new RecorderHost(), 1);
game.newGame();
while (game.stack.length > 1) game.pop();
game.overworld.enter("VIRIDIAN_CITY", 18, 20, "down");
for (let i = 0; i < 10; i++) game.tick(0);
const counts = new Map<string, number>();
const host = new Proxy({}, {
  get: (_t, name: string) => (...args: unknown[]) => {
    counts.set(name, (counts.get(name) ?? 0) + 1);
    void args;
  },
});
drawKantoGear(host as never, game);
console.log([...counts].sort((a, b) => b[1] - a[1]));
const t0 = performance.now();
for (let i = 0; i < 2000; i++) drawKantoGear(host as never, game);
console.log("bun us/draw", ((performance.now() - t0) / 2000 * 1000).toFixed(1));
