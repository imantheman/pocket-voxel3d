// A Citra check of the 3D slider (cc_gold_bench.sh tools/gold_stereo_entry.ts,
// Citra's factor_3d up): the card's save continued in VIEW 3D, a small map
// (New Bark Town), a long one (Route 29) and a city (Cherrygrove) visited,
// then the START menu over the last -- a shot of both eyes three seconds
// into each (native screenshot: shot_N.ppm and shot_N_r.ppm), so the
// player's parallax and the flat screens' can be measured. Never shipped.
import "../voxelmon/game/gen2/main.ts";
import { Save } from "../voxelmon/game/gen2/core/Save.ts";
import { native } from "../voxelmon/game/quickjs-host.ts";

const g = globalThis as unknown as { goldGame: any; frame: (b: number) => void };
const game = g.goldGame;
const mainFrame = g.frame;

const STOPS: { map: string; x: number; y: number; menu?: boolean }[] = [
  { map: "NEW_BARK_TOWN", x: 9, y: 9 },
  { map: "ROUTE_29", x: 40, y: 9 },
  { map: "CHERRYGROVE_CITY", x: 16, y: 9 },
  { map: "CHERRYGROVE_CITY", x: 16, y: 9, menu: true },
];
const STOP_TICKS = 5 * 60;
let started = false;
let n = 0;
let at = -1;

g.frame = (b: number): void => {
  if (!started) {
    started = true;
    const [save] = Save.load();
    game.continueGame(save);
    game.options.view = "3d";
  }
  n++;
  if (game.world?.map && n >= 120) {
    const k = Math.floor((n - 120) / STOP_TICKS);
    const t = (n - 120) % STOP_TICKS;
    if (k !== at && k < STOPS.length) {
      at = k;
      const s = STOPS[k]!;
      while (game.stack.top()) game.stack.pop();
      if (s.menu) game.openStartMenu();
      else game.world.warpToMapId(s.map, s.x, s.y, "down");
      console.log(`[pv] bench stereo ${s.map}${s.menu ? " menu" : ""}`);
    }
    if (t === 180 && k < STOPS.length) native.screenshot?.();
  }
  mainFrame(b & ~0xff);
};
