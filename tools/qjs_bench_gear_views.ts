// The Kanto Gear's views timed under the 3DS's QuickJS (tools/qjs_gold_harness.c
// with PROF=1): each view's whole draw, and EXPLORER's AREA map piece by
// piece. Never shipped.
import "../voxelmon/game/psp-main.ts";
import { drawKantoGear } from "../voxelmon/game/ui/kantogear.ts";
import { drawExplorer } from "../voxelmon/game/ui/gear/apps/explorer.ts";
import { drawMap } from "../voxelmon/game/ui/gear/apps/map.ts";
import { mapItems } from "../voxelmon/game/ui/gear/model.ts";
import { ctxFor } from "../voxelmon/game/ui/gear/ui.ts";

const g = globalThis as unknown as { voxelmonGame: any; voxel: { now: () => number } };
const game = g.voxelmonGame;
const now = g.voxel.now;
while (game.stack.length > 1) game.pop();
const WHERE = (globalThis as any).GEAR_MAP ?? "VIRIDIAN_CITY";
game.overworld.enter(WHERE, 18, 20, "down");
for (let i = 0; i < 30; i++) game.tick(0);
game.save.inventory = game.save.inventory ?? {};
game.save.inventory.TOWN_MAP = 1;
const nop = () => {};
const host: any = { uiTileBottom: nop, uiClearBottom: nop, uiSpriteBottom: nop, uiSpriteRectBottom: nop, uiRectBottom: nop };
function time(name: string, fn: () => void, n = 50): void {
  fn();
  const a = now();
  for (let i = 0; i < n; i++) fn();
  console.log(`gear ${name}: ${((now() - a) / n).toFixed(1)} us`);
}
const map = game.overworld.map;
console.log(`gear map ${map.id} ${map.widthCells}x${map.heightCells}`);
for (const v of ["home", "map", "explorer", "party"]) {
  game.setGearView(v);
  time(`drawKantoGear ${v}`, () => drawKantoGear(host, game));
}
const ctx = ctxFor(host, game, "explorer");
time("drawExplorer", () => drawExplorer(ctx));
time("drawMap", () => drawMap(ctxFor(host, game, "map")));
const ui = (game.gearUi ??= {}).explorer ??= {};
for (const page of ["wild", "trainers", "items", "area"]) {
  ui.page = page;
  time(`drawExplorer ${page}`, () => drawExplorer(ctxFor(host, game, "explorer")));
}
const W = 26, H = 13;
time("warpAtCell x window", () => { for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) map.warpAtCell?.(x, y); });
time("isWaterCell x window", () => { for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) map.isWaterCell?.(x, y); });
time("isWalkableCell x window", () => { for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) map.isWalkableCell(x, y); });
time("isGrassCell x window", () => { for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) map.isGrassCell?.(x, y); });
time("mapItems", () => mapItems(game.data, game.save, map.id));
(globalThis as any).frame = () => {};
