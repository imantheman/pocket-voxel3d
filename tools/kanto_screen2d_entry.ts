// A Citra check of the Kanto games' 2D SCREEN / 2D ZOOM OUT options
// (cc_kanto_bench.sh tools/kanto_screen2d_entry.ts): the card's save
// continued from the title in VIEW 2D, then each setting held for six seconds
// while the player walks a little loop -- the START menu opened over the
// last one -- with a top-screen shot (native screenshot, main.rs
// dump_top_screen) three seconds into each. Never shipped.
import "../voxelmon/game/psp-main.ts";
import { native } from "../voxelmon/game/quickjs-host.ts";

declare const WARP: string;
const g = globalThis as unknown as { voxelmonGame: any; frame: (b: number) => void };
const game = g.voxelmonGame;
const mainFrame = g.frame;
const START = 1 << 6;
const B = 1 << 5;
const WALK = [1 << 2, 1 << 2, 1 << 0, 1 << 3, 1 << 3, 1 << 1]; // left left up right right down

type Stop = { screen2d: string; zoom2d: number; menu?: boolean };
const STOPS: Stop[] = [
  { screen2d: "normal", zoom2d: 100 },
  { screen2d: "wide", zoom2d: 100 },
  { screen2d: "normal", zoom2d: 60 },
  { screen2d: "wide", zoom2d: 80 },
  { screen2d: "wide", zoom2d: 60 },
  { screen2d: "wide", zoom2d: 60, menu: true },
];
const STOP_TICKS = 6 * 60;
let continued = false;
let n = 0;
let at = -1;
let i = 0;

g.frame = (b: number): void => {
  const top = game.stack?.[game.stack.length - 1];
  let pad = 0;
  if (!continued) {
    if (top?.kind === "title") {
      continued = true;
      game.pop();
      top.onChoose?.("continue");
      if (typeof WARP !== "undefined") {
        const [map, x, y] = WARP.split(",");
        game.overworld.enter(map, Number(x), Number(y), "down");
        while (game.stack.length > 1 && game.stack[game.stack.length - 1].kind !== "overworld") game.pop();
      }
    } else if (i % 30 === 0) pad = START;
  } else {
    n++;
    const o = (game.save.options ??= {});
    o.view = "2d";
    o.movement = "grid";
    if (n >= 120) {
      const k = Math.floor((n - 120) / STOP_TICKS);
      const t = (n - 120) % STOP_TICKS;
      if (k !== at && k < STOPS.length) {
        at = k;
        console.log(`[pv] bench screen2d ${STOPS[k]!.screen2d} zoom ${STOPS[k]!.zoom2d}${STOPS[k]!.menu ? " menu" : ""}`);
      }
      const s = STOPS[Math.min(at, STOPS.length - 1)]!;
      o.screen2d = s.screen2d;
      o.zoom2d = s.zoom2d;
      if (t === 180 && k < STOPS.length) {
        console.log(`[pv] bench shot ${at} ${typeof native.screenshot}`);
        native.screenshot?.();
      }
      if (s.menu) {
        if (top?.kind === "overworld" && t === 20) pad = START;
      } else if (top?.kind !== "overworld") {
        if (i % 20 === 0) pad = B;
      } else if (k < STOPS.length) pad = WALK[Math.floor(t / 20) % WALK.length]!;
    }
  }
  i++;
  mainFrame((b & ~0xff) | pad);
};
