// A Citra shot of SPEED on Gold/Silver/Crystal's OPTION screen: the card's
// save continued, OPTION's top level, its ENHANCEMENTS page with the cursor
// on SPEED (1X), then RIGHT to 2X. Each is shot to the card (shot_N.ppm
// top, shot_N_b.ppm bottom) with a "[pv] bpshot N name" line. Never shipped.
import "../voxelmon/game/gen2/main.ts";
import { native } from "../voxelmon/game/quickjs-host.ts";
import { Save } from "../voxelmon/game/gen2/core/Save.ts";

const g = globalThis as unknown as { goldGame: any; frame: (b: number) => void };
const game = g.goldGame;
const mainFrame = g.frame;
const RIGHT = 1 << 3;

let i = 0;
let started = false;
let at = -1;
let shots = 0;
const shot = (name: string): void => {
  console.log(`[pv] bpshot ${shots} ${name} (speed ${game.gameSpeed()}X)`);
  shots++;
  native.screenshot?.();
};

g.frame = (b: number): void => {
  i++;
  if (!started) {
    started = true;
    const [save] = Save.load();
    game.continueGame(save);
  }
  let pad = 0;
  if (at < 0 && game.world?.map && game.phase === "play") {
    at = i + 60;
    game.setGameSpeed(1);
  }
  if (at >= 0) {
    const t = i - at;
    if (t === 0) { while (game.stack.top()) game.stack.pop(); game.showOptions(); game.stack.top().focusRow?.("cheats"); }
    if (t === 40) shot("option_top");
    if (t === 60) game.stack.top().focusRow?.("gameSpeed");
    if (t === 100) shot("enhancements_1x");
    if (t === 120 || t === 121) pad = RIGHT;
    if (t === 180) shot("enhancements_2x");
    if (t === 240) console.log("[pv] bpshot done");
  }
  mainFrame((b & ~0xff) | pad);
};
