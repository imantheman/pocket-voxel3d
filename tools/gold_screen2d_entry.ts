// A Citra check of Gold's 2D SCREEN / 2D ZOOM options (cc_gold_bench.sh
// tools/gold_screen2d_entry.ts): the card's save continued in VIEW 2D, then
// each setting held for six seconds while the player walks a little loop --
// the START menu opened over the last one -- with Gold's own step/draw/lcd/
// view split on and a top-screen shot (native screenshot, main.rs
// dump_top_screen) three seconds into each. Never shipped.
import "../voxelmon/game/gen2/main.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { Save } from "../voxelmon/game/gen2/core/Save.ts";
import { native } from "../voxelmon/game/quickjs-host.ts";

const g = globalThis as unknown as { goldGame: any; goldProf: boolean; frame: (b: number) => void };
g.goldProf = true;
const game = g.goldGame;
const mainFrame = g.frame;

type Stop = { screen2d: string; zoom2d: number; menu?: boolean };
const STOPS: Stop[] = [
  { screen2d: "normal", zoom2d: 100 },
  { screen2d: "wide", zoom2d: 100 },
  { screen2d: "normal", zoom2d: 60 },
  { screen2d: "wide", zoom2d: 80 },
  { screen2d: "wide", zoom2d: 60 },
  { screen2d: "wide", zoom2d: 50 },
  { screen2d: "wide", zoom2d: 40 },
  { screen2d: "normal", zoom2d: 40 },
  { screen2d: "wide", zoom2d: 40, menu: true },
  { screen2d: "wide", zoom2d: 60, menu: true },
];
const STOP_TICKS = 6 * 60;
const WALK = [VOX_BTN.left, VOX_BTN.left, VOX_BTN.up, VOX_BTN.right, VOX_BTN.right, VOX_BTN.down];
let started = false;
let n = 0;
let at = -1;

g.frame = (b: number): void => {
  if (!started) {
    started = true;
    const [save] = Save.load();
    game.continueGame(save);
    game.options.view = "2d";
  }
  n++;
  let pad = 0;
  if (game.world?.map && n >= 120) {
    const k = Math.floor((n - 120) / STOP_TICKS);
    const t = (n - 120) % STOP_TICKS;
    if (k !== at && k < STOPS.length) {
      at = k;
      const s = STOPS[k]!;
      game.options.screen2d = s.screen2d;
      game.options.zoom2d = s.zoom2d;
      while (game.stack.top()) game.stack.pop();
      if (s.menu) game.openStartMenu();
      console.log(`[pv] bench screen2d ${s.screen2d} zoom ${s.zoom2d}${s.menu ? " menu" : ""}`);
    }
    const s = STOPS[at];
    if (s && t === 180) {
      console.log(`[pv] bench shot ${at} ${typeof native.screenshot}`);
      native.screenshot?.();
    }
    if (s && !s.menu && k < STOPS.length) pad = WALK[Math.floor(t / 20) % WALK.length]!;
  }
  mainFrame((b & ~0xff) | pad);
};
