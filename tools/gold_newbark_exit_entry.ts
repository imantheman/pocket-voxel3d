// A Citra check of leaving New Bark Town (cc_gold_bench.sh
// tools/gold_newbark_exit_entry.ts) the way Isaac's crash happened: the
// card's save continued, VIEW switched 3D -> 2D -> 3D in town, then out west
// onto Route 29 and back, again and again, the view switched at a different
// point of each round (in town, mid-route, at the seam). Each map change and
// switch logged. ONLY=1 at bundle time: New Bark's scene put back to the
// teacher's stop-you and the party emptied, as before the starter.
// Never shipped.
import "../voxelmon/game/gen2/main.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { Save } from "../voxelmon/game/gen2/core/Save.ts";

declare const ONLY: string;
const g = globalThis as unknown as { goldGame: any; goldProf: boolean; frame: (b: number) => void };
g.goldProf = true;
const game = g.goldGame;
const mainFrame = g.frame;

let started = false;
let n = 0;
let placed = false;
let lastMap = "";
let goWest = true;
let round = 0;
let lastSwitch = 0;

function setView(v: string, why: string): void {
  if (game.options.view === v) return;
  game.options.view = v;
  lastSwitch = n;
  console.log(`[pv] bench view ${v} (${why}) at ${game.world.map.id} ${game.world.player?.cellX},${game.world.player?.cellY} tick ${n}`);
}

g.frame = (b: number): void => {
  if (!started) {
    started = true;
    const [save] = Save.load();
    game.continueGame(save);
    game.options.view = "3d";
    game.options.movement = "grid";
    // the teacher's scene done (the card's save is from before the starter)
    // unless ONLY: then as before the starter, the party empty too
    game.world.mapScenes.NEW_BARK_TOWN = typeof ONLY !== "undefined" ? 0 : 1;
    if (typeof ONLY !== "undefined") game.save.party = [];
  }
  n++;
  const w = game.world;
  let pad = 0;
  if (w?.map && n >= 120) {
    if (!placed) {
      placed = true;
      w.warpToMapId("NEW_BARK_TOWN", 4, 8, "left");
    }
    if (w.map.id !== lastMap) {
      console.log(`[pv] bench map ${w.map.id} at tick ${n} cell ${w.player?.cellX},${w.player?.cellY} view ${game.options.view}`);
      if (w.map.id === "ROUTE_29") {
        round++;
        // round 2: cross in 2D, back to 3D just over the seam
        if (round % 3 === 2) setView("3d", "just over the seam");
      }
      lastMap = w.map.id;
    }
    const p = w.player;
    const idle = p && !p.moving && !game.stack.top() && !w.busy();
    if (idle) {
      const width = (w.map.width ?? 0) * 2;
      if (w.map.id === "ROUTE_29" && p.cellX <= width - 8) {
        if (goWest && round % 3 === 0) setView("2d", "mid-route");
        goWest = false;
      }
      if (w.map.id === "NEW_BARK_TOWN" && p.cellX >= 4) {
        if (!goWest) {
          // round 1: 3D -> 2D -> 3D in town before leaving
          if (round % 3 === 0 || round % 3 === 1) setView("2d", "in town");
        }
        goWest = true;
      }
    }
    // in town a second after a switch to 2D, back to 3D (the 3D -> 2D -> 3D)
    if (game.options.view === "2d" && w.map.id === "NEW_BARK_TOWN" && n - lastSwitch === 60 && round % 3 !== 1) setView("3d", "back in town");
    if (n - lastSwitch < 60 && n - lastSwitch > 0) pad = 0;
    else if (game.stack.top() || w.busy()) pad = n % 12 === 0 ? VOX_BTN.a : 0;
    else pad = goWest ? VOX_BTN.left : VOX_BTN.right;
    if (n % 120 === 0) console.log(`[pv] bench at ${w.map.id} ${p?.cellX},${p?.cellY} view ${game.options.view} round ${round}`);
  }
  mainFrame((b & ~0xff) | pad);
};
