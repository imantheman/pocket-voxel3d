// The Kanto Gear's pieces timed under QuickJS (tools/qjs_gold_harness.c with
// PROF=1, via cc_qjs_gear.sh). Never shipped.
import "../voxelmon/game/psp-main.ts";
import { drawKantoGear } from "../voxelmon/game/ui/kantogear.ts";
import { availableApps, drawHome } from "../voxelmon/game/ui/gear/apps/home.ts";
import { wildRows } from "../voxelmon/game/ui/gear/model.ts";
import { clockStr, ctxFor, header } from "../voxelmon/game/ui/gear/ui.ts";
import { drawMirror, drawTextHint } from "../voxelmon/game/ui/gear/mirrors.ts";
import { text } from "../voxelmon/game/ui/gear/draw.ts";

const g = globalThis as unknown as { voxelmonGame: any; voxel: { now: () => number } };
const game = g.voxelmonGame;
const now = g.voxel.now;
while (game.stack.length > 1) game.pop();
game.overworld.enter("VIRIDIAN_CITY", 18, 20, "down");
for (let i = 0; i < 30; i++) game.tick(0);
const nop = () => {};
const host: any = { uiTileBottom: nop, uiClearBottom: nop, uiSpriteBottom: nop, uiSpriteRectBottom: nop, uiRectBottom: nop };
const real: any = { ...host };
const ctx = ctxFor(host, game, "home");
function time(name: string, fn: () => void, n = 2000): void {
  fn();
  const a = now();
  for (let i = 0; i < n; i++) fn();
  console.log(`gear ${name}: ${((now() - a) / n).toFixed(1)} us`);
}
time("drawKantoGear", () => drawKantoGear(real, game));
time("drawHome", () => drawHome(ctx));
time("header", () => header(ctx, "KANTO GEAR"));
time("clockStr", () => clockStr(false));
time("wildRows+Set", () => new Set(wildRows(game.data, "VIRIDIAN_CITY").map((r: any) => r.species)).size);
time("availableApps", () => availableApps(game));
time("text 10", () => text(host, 1, 3, "KANTO GEAR"));
time("drawMirror", () => drawMirror(ctxFor(host, game, "mirror")));
time("drawTextHint", () => drawTextHint(ctx));
time("ctxFor", () => ctxFor(host, game, "home"));
(globalThis as any).frame = () => {};
