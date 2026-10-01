// A Citra check of Gold's bottom-screen touch (cc_gold_bench.sh
// tools/gold_touch_entry.ts): the card's save continued straight away, then
// the host's buttons -- touch bits and all -- passed through untouched, so
// taps can be posted to an unfocused Citra. Never shipped.
import "../voxelmon/game/gen2/main.ts";
import { Save } from "../voxelmon/game/gen2/core/Save.ts";

const g = globalThis as unknown as { goldGame: any; frame: (b: number) => void };
const game = g.goldGame;
const mainFrame = g.frame;
let started = false;
g.frame = (b: number): void => {
  if (!started) {
    started = true;
    const [save] = Save.load();
    game.continueGame(save);
  }
  mainFrame(b);
};
