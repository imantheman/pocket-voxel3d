// A Citra check of RUNNING SHOES on a Gen 2 cart (cc_gold_bench.sh
// tools/gold_run_entry.ts): the card's save continued on Route 29, two
// seconds walking west, two seconds walking west holding B, in GRID
// movement; the cells covered by each are logged. Never shipped.
import "../voxelmon/game/gen2/main.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { Save } from "../voxelmon/game/gen2/core/Save.ts";

const g = globalThis as unknown as { goldGame: any; frame: (b: number) => void };
const game = g.goldGame;
const mainFrame = g.frame;
let started = false;
let n = 0;
let mark = 0;
let x0 = 0;

g.frame = (b: number): void => {
  if (!started) {
    started = true;
    const [save] = Save.load();
    game.continueGame(save);
    game.options.view = "3d";
    game.options.movement = "grid";
    delete game.options.runningShoes;
  }
  n++;
  let pad = 0;
  const w = game.world;
  if (w?.map) {
    if (!mark && n >= 120) {
      mark = n;
      w.warpToMapId("ROUTE_29", 50, 8, "left");
    }
    const t = mark ? n - mark : -1;
    if (t === 90) x0 = w.player.cellX;
    if (t >= 90 && t < 150) pad = VOX_BTN.left;
    if (t === 210) {
      console.log(`[pv] bench run: walking, 60 ticks: ${x0 - w.player.cellX} cells`);
      x0 = w.player.cellX;
    }
    if (t >= 240 && t < 300) pad = VOX_BTN.left | VOX_BTN.b;
    if (t === 215) w.warpToMapId("ROUTE_29", 50, 8, "left");
    if (t === 240) x0 = w.player.cellX;
    if (t === 360) console.log(`[pv] bench run: running (B), 60 ticks: ${x0 - w.player.cellX} cells`);
  }
  mainFrame((b & ~0xff) | pad);
};
