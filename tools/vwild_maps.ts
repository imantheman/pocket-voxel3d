// bun tools/vwild_maps.ts [genDir] [mapId]: VISIBLE WILD's encounter cells
// per map (land / water / the raw grass count), biggest first -- where to
// bench and shoot; with a map id, its grid (g grass kept, x grass left out,
// w water kept, . floor, # wall, D warp). Never shipped.
import { loadRuntimeData } from "../voxelmon/game/data.ts";
import { GameMap } from "../voxelmon/game/world/map.ts";
import { CELL_LAND, CELL_WATER, classifyCells } from "../voxelmon/game/visiblewild.ts";

const dir = process.argv[2] ?? "dist/voxelmon/yellow/gen";
const only = process.argv[3];
const data = await loadRuntimeData(dir);
const indoor = (data.field as { indoorEncounters?: { firstIndoorMap: number; excludedTileset: string } }).indoorEncounters;
const rows: [string, number, number, number, number][] = [];
for (const [id, def] of Object.entries(data.maps)) {
  if (only && id !== only) continue;
  const enc = data.encounters?.[id];
  if (!enc) continue;
  const ts = data.tilesets?.[(def as { tileset: string }).tileset];
  if (!ts) continue;
  const map = new GameMap(def as never, ts as never, (data.field as { waterTilesets?: string[] }).waterTilesets);
  const k = classifyCells(map, enc, indoor);
  let land = 0, water = 0, grass = 0;
  for (const v of k) { if (v === CELL_LAND) land++; else if (v === CELL_WATER) water++; }
  for (let y = 0; y < map.heightCells; y++) for (let x = 0; x < map.widthCells; x++) if (map.isGrassCell(x, y)) grass++;
  rows.push([id, land, water, grass, map.widthCells * map.heightCells]);
  if (only) {
    for (let y = 0; y < map.heightCells; y++) {
      let s = "";
      for (let x = 0; x < map.widthCells; x++) {
        const v = k[y * map.widthCells + x];
        s += v === CELL_LAND ? (map.isGrassCell(x, y) ? "g" : "f") : v === CELL_WATER ? "w"
          : map.warpAtCell(x, y) ? "D" : map.isGrassCell(x, y) ? "x" : map.isWaterCell(x, y) ? "~"
          : map.isWalkableCell(x, y) ? "." : "#";
      }
      console.log(s);
    }
  }
}
rows.sort((a, b) => b[1] - a[1]);
console.log("map\tland\twater\tgrass\tcells");
for (const r of rows) console.log(r.join("\t"));
