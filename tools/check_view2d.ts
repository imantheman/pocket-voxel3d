// Debug: VIEW 2D's BG ring against the map, tile for tile, under Bun.
//   bun tools/check_view2d.ts [MAP] [x] [y]
import { join } from "node:path";
import { loadRuntimeData } from "../voxelmon/game/data.ts";
import { VoxelmonGame } from "../voxelmon/game/game.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";
import { OverworldView2d } from "../voxelmon/game/world/view2d.ts";

const data = await loadRuntimeData(join(import.meta.dir, "../dist/voxelmon/gen"));
const game: any = new VoxelmonGame(data, new RecorderHost(), 1);
game.newGame();
while (game.stack.length > 1) game.pop();
const id = process.argv[2] ?? "VIRIDIAN_POKECENTER";
game.overworld.enter(id, Number(process.argv[3] ?? 3), Number(process.argv[4] ?? 7), "down");
const view = new OverworldView2d();
const v = view.build(game)!;
const p = game.overworld.player;
const map = game.overworld.map;
console.log("map", map.id, "player", p.px, p.py, "scx", v.scx, "scy", v.scy);
let bad = 0;
const camX = Math.round(p.px) - 64;
const camY = Math.round(p.py) - 64;
for (let sy = 0; sy < 18; sy++) {
  let line = "";
  for (let sx = 0; sx < 20; sx++) {
    const ring = v.maps[(((v.scy >> 3) + sy) & 31) * 32 + (((v.scx >> 3) + sx) & 31)]!;
    const want = map.tileAt(Math.floor(camX / 8) + sx, Math.floor(camY / 8) + sy) & 0x7f;
    if (ring !== want) bad++;
    line += ring.toString(16).padStart(2, "0") + (ring === want ? " " : "!");
  }
  console.log(line);
}
console.log("mismatches", bad, "loads", JSON.stringify(v.loads));
