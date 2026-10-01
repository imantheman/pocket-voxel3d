// A Citra profile of Gold's overworld (cc_gold_bench.sh tools/gold_prof_entry.ts):
// the card's save continued, Gold's own step/draw/lcd/view split turned on
// (globalThis.goldProf -> "[pv] gold us/frame" lines every 300 ticks), and the
// player walking back and forth -- left for two seconds, right for two -- so
// the walk's cost is in it. STILL=1 at bundle time stands still. Never shipped.
import "../voxelmon/game/gen2/main.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { Save } from "../voxelmon/game/gen2/core/Save.ts";

declare const STILL: boolean;
const g = globalThis as unknown as { goldGame: any; goldProf: boolean; frame: (b: number) => void };
g.goldProf = true;
const game = g.goldGame;
const mainFrame = g.frame;
let started = false;
let n = 0;
g.frame = (b: number): void => {
  if (!started) {
    started = true;
    const [save] = Save.load();
    game.continueGame(save);
  }
  n++;
  let pad = 0;
  if (!(typeof STILL !== "undefined" && STILL) && n > 120) pad = Math.floor(n / 120) % 2 === 0 ? VOX_BTN.left : VOX_BTN.right;
  mainFrame((b & ~0xff) | pad);
};
