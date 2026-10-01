// A Citra check of Gold's options file (cc_gold_bench.sh tools/gold_options_entry.ts):
// on the first frame, log what the card's options file held at boot, then
// set TILT SHIFT to SOFT and persist the options. Boot it twice: the second
// boot's first line shows what the first wrote. Never shipped.
import "../voxelmon/game/gen2/main.ts";
import { native } from "../voxelmon/game/quickjs-host.ts";

const g = globalThis as unknown as { goldGame: any; frame: (b: number) => void };
const game = g.goldGame;
const mainFrame = g.frame;
let n = 0;
g.frame = (b: number): void => {
  if (n++ === 0) {
    const before = native.optionsData?.();
    console.log(`[opt] at boot: ${before === undefined ? "none" : before.slice(0, 160).replace(/\s+/g, " ")}`);
    console.log(`[opt] loaded tiltShift=${String(game.options?.tiltShift)}`);
    game.options.tiltShift = "soft";
    game.persistOptions();
    const after = native.optionsData?.();
    console.log(`[opt] after write: ${after === undefined ? "none" : after.length + " bytes"}`);
  }
  mainFrame(b);
};
