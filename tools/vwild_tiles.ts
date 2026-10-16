// bun tools/vwild_tiles.ts <genDir> <map> <x0> <y0> <w> <h>: each cell's four
// tile ids (TL TR / BL BR) and the tileset's grass tile. Never shipped.
import { loadRuntimeData } from "../voxelmon/game/data.ts";
import { GameMap } from "../voxelmon/game/world/map.ts";

const [dir, id, x0, y0, w, h] = process.argv.slice(2);
const data = await loadRuntimeData(dir!);
const def = (data as any).maps[id!];
const map = new GameMap(def, (data as any).tilesets[def.tileset], (data.field as any).waterTilesets);
console.log("grassTile", (map as any).tileset.grassTile, "tileset", def.tileset,
  "walkable", JSON.stringify((((data as any).tilesets[def.tileset]).walkable ?? []).map((x: number) => x.toString(16))));
for (let cy = +y0!; cy < +y0! + +h!; cy++) {
  let a = "", b = "";
  for (let cx = +x0!; cx < +x0! + +w!; cx++) {
    const t = (dx: number, dy: number) => map.tileAt(cx * 2 + dx, cy * 2 + dy).toString(16).padStart(2, "0");
    a += `${t(0, 0)} ${t(1, 0)} | `;
    b += `${t(0, 1)} ${t(1, 1)} | `;
  }
  console.log(`y${cy} ${a}\n    ${b}`);
}
