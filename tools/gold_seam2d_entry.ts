// A Citra check of Gold's map switches in VIEW 2D (cc_gold_bench.sh
// tools/gold_seam2d_entry.ts): the card's save continued, VIEW 2D on, then
// across New Bark Town's west edge onto Route 29 and back, over and over;
// DOOR=1 in and out of Elm's lab instead. Each switch logged with the
// game's own time spent on the frame that made it. Never shipped.
import "../voxelmon/game/gen2/main.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { Save } from "../voxelmon/game/gen2/core/Save.ts";

declare const DOOR: boolean;
const door = typeof DOOR !== "undefined" && DOOR;
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

g.frame = (b: number): void => {
  if (!started) {
    started = true;
    const [save] = Save.load();
    game.continueGame(save);
    game.options.view = "2d";
    game.options.movement = "grid";
    game.world.mapScenes.NEW_BARK_TOWN = 1;
  }
  n++;
  const w = game.world;
  let pad = 0;
  if (w?.map && n >= 120) {
    if (!placed) {
      placed = true;
      // Elm's lab door is at (6, 3); stand under it facing up
      if (door) w.warpToMapId("NEW_BARK_TOWN", 6, 4, "up");
      else w.warpToMapId("NEW_BARK_TOWN", 4, 8, "left");
    }
    const t0 = Date.now();
    const p = w.player;
    const idle = p && !p.moving && !game.stack.top() && !w.busy();
    if (door) {
      if (game.stack.top() || w.busy()) pad = n % 12 === 0 ? VOX_BTN.a : 0;
      else if (idle) pad = w.map.id === "NEW_BARK_TOWN" ? VOX_BTN.up : VOX_BTN.down;
    } else {
      if (idle) {
        const width = (w.map.width ?? 0) * 2;
        if (w.map.id === "ROUTE_29" && p.cellX <= width - 4) goWest = false;
        if (w.map.id === "NEW_BARK_TOWN" && p.cellX >= 4) goWest = true;
      }
      if (game.stack.top() || w.busy()) pad = n % 12 === 0 ? VOX_BTN.a : 0;
      else pad = goWest ? VOX_BTN.left : VOX_BTN.right;
    }
    mainFrame((b & ~0xff) | pad);
    const ms = Date.now() - t0;
    if (w.map.id !== lastMap) {
      if (lastMap) console.log(`[pv] bench switch ${round++} ${lastMap} -> ${w.map.id}: game frame ${ms} ms`);
      lastMap = w.map.id;
    }
    return;
  }
  mainFrame((b & ~0xff) | pad);
};
