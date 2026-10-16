// A Citra shot of SPEED on Red/Blue/Yellow's OPTION screen: the card's save
// continued, OPTION opened over the world, R to ENHANCEMENTS (SPEED at its
// top, 1X), then RIGHT to 2X. Each is shot to the card (shot_N.ppm top,
// shot_N_b.ppm bottom) with a "[pv] bpshot N name" line. Never shipped.
import "../voxelmon/game/psp-main.ts";
import { native } from "../voxelmon/game/quickjs-host.ts";
import { OptionsMenuState } from "../voxelmon/game/ui/optionsmenu.ts";

const g = globalThis as unknown as { voxelmonGame: any; frame: (b: number) => void };
const game = g.voxelmonGame;
const mainFrame = g.frame;
const RIGHT = 1 << 3;
const START = 1 << 6;
const R = 1 << 26;

let i = 0;
let continued = false;
let at = -1;
let shots = 0;
const shot = (name: string): void => {
  console.log(`[pv] bpshot ${shots} ${name} (speed ${game.gameSpeed()}X)`);
  shots++;
  native.screenshot?.();
};

g.frame = (b: number): void => {
  i++;
  let pad = 0;
  const top = game.stack?.[game.stack.length - 1];
  if (!continued) {
    if (top?.kind === "title") {
      continued = true;
      game.pop();
      top.onChoose?.("continue");
    } else if (i % 30 === 0) pad = START;
  } else if (at < 0 && top?.kind === "overworld") {
    at = i + 60;
    game.setGameSpeed(1);
  }
  if (at >= 0) {
    const t = i - at;
    if (t === 0) game.push(new OptionsMenuState(game));
    if (t === 40) shot("settings");
    if (t === 60 || t === 61) pad = R;
    if (t === 120) shot("enhancements_1x");
    if (t === 140 || t === 141) pad = RIGHT;
    if (t === 200) shot("enhancements_2x");
    if (t === 260) console.log("[pv] bpshot done");
  }
  mainFrame((b & ~0xff & ~R) | pad);
};
