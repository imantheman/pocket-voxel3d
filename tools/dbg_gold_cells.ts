// Debug: collision, walkability and people round a cell (bun tools/dbg_gold_cells.ts MAP x y).
import { useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";
import { Permissions } from "../voxelmon/game/gen2/world/Permissions.ts";

useGoldGen();
const game: any = Game2.new();
game.load({ startWorld: true });
const w = game.world;
const [id, xs, ys] = process.argv.slice(2);
if (id) w.setMap(id, Number(xs ?? 1), Number(ys ?? 1), "down");
const map = w.map;
const cx = Number(xs ?? 0);
const cy = Number(ys ?? 0);
console.log(map.id, map.widthCells, "x", map.heightCells, "player", w.player.cellX, w.player.cellY);
for (let y = Math.max(0, cy - (process.env.R ? 99 : 3)); y <= Math.min(map.heightCells - 1, cy + (process.env.R ? 99 : 3)); y++) {
  let line = "";
  for (let x = Math.max(0, cx - (process.env.R ? 99 : 4)); x <= Math.min(map.widthCells - 1, cx + (process.env.R ? 99 : 4)); x++) {
    const c = map.cellCollision(x, y);
    const n = w.npcAt(x, y);
    line += `${c.toString(16).padStart(2, "0")}${map.isWalkable(x, y) ? "w" : "."}${n ? "N" : " "} `;
  }
  console.log(String(y).padStart(2), line);
}
for (const d of ["up", "down", "left", "right"] as const) {
  console.log(d, "from", cx, cy, Permissions.stepPermitted((x: number, y: number) => w.cellCollisionAcross(map, x, y), cx, cy, d));
}
console.log("npcs", (w.npcs ?? []).map((n: any) => `${n.def?.sprite}@${n.cellX},${n.cellY}`).join(" "));
