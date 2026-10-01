// Debug: a map's board -- walls #, floor ., ice ~, pits/warps W, people N,
// boulders O, rocks R (bun tools/dbg_gold_board.ts MAP [FLAGS=..])
import { useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";
import { Permissions } from "../voxelmon/game/gen2/world/Permissions.ts";
import { FlagNames } from "../voxelmon/game/gen2/core/FlagNames.ts";

useGoldGen();
const game: any = Game2.new();
game.load({ startWorld: true });
const w = game.world;
for (const f of (process.env.FLAGS ?? "").split(",").filter(Boolean)) w.events.set(FlagNames.events[f] ?? Number(f), true);
const id = process.argv[2]!;
const def = w.maps[id];
const w0 = def.warps?.[0];
w.setMap(id, w0?.x ?? 1, w0?.y ?? 1, "down");
const map = w.map;
console.log(id, map.widthCells, "x", map.heightCells);
const hdr = [...Array(map.widthCells)].map((_, x) => String(x % 10)).join("");
console.log("   " + hdr);
for (let y = 0; y < map.heightCells; y++) {
  let r = "";
  for (let x = 0; x < map.widthCells; x++) {
    const c = map.cellCollision(x, y);
    const n = w.npcAt(x, y);
    const warp = (def.warps ?? []).some((wp: any) => wp.x === x && wp.y === y);
    r += n ? (n.def?.sprite === "SPRITE_BOULDER" ? "O" : n.def?.sprite === "SPRITE_ROCK" ? "R" : "N")
      : warp ? "W" : Permissions.isIce(c) ? "~" : Permissions.isWaterfall(c) ? "v" : Permissions.isWhirlpool(c) ? "@" : Permissions.surfable(c) === "water" ? "=" : Permissions.isGrass(c) ? "," : map.isWalkable(x, y) ? "." : "#";
  }
  console.log(String(y).padStart(2) + " " + r);
}
console.log("warps", (def.warps ?? []).map((wp: any, i: number) => `${i + 1}:(${wp.x},${wp.y})->${wp.destMap}#${wp.destWarp} coll ${map.cellCollision(wp.x, wp.y).toString(16)}`).join("  "));
