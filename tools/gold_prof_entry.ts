// A Citra profile of Gold (cc_gold_bench.sh tools/gold_prof_entry.ts): the
// card's save continued, Gold's own step/draw/lcd/view split turned on
// (globalThis.goldProf -> "[pv] gold us/frame" lines every 300 ticks), and a
// tour of the heavy places, 15 seconds each, the player walking back and
// forth in each -- the towns, VIEW 2D, the START menu, a wild battle. A
// "[pv] prof scene:" line names each stop. Never shipped.
import "../voxelmon/game/gen2/main.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { Save } from "../voxelmon/game/gen2/core/Save.ts";
import { Mon } from "../voxelmon/game/gen2/battle/Mon.ts";

const g = globalThis as unknown as { goldGame: any; goldProf: boolean; frame: (b: number) => void };
g.goldProf = true;
const game = g.goldGame;
const mainFrame = g.frame;

type Stop = { name: string; map?: string; at?: [number, number]; hold?: number; view?: "2d" | "3d"; menu?: boolean; battle?: string };
const TOUR: Stop[] = [
  { name: "Route 29 3D", map: "ROUTE_29" },
  { name: "Goldenrod 3D", map: "GOLDENROD_CITY" },
  { name: "Ecruteak 3D", map: "ECRUTEAK_CITY" },
  { name: "Azalea 3D", map: "AZALEA_TOWN" },
  { name: "Olivine 3D", map: "OLIVINE_CITY" },
  { name: "Goldenrod 2D", map: "GOLDENROD_CITY", view: "2d" },
  { name: "START menu", menu: true },
  { name: "battle 3D", battle: "PIDGEY" },
  // a border crossed on foot (stop 8): Route 29 west into Cherrygrove, the
  // map change a player makes, its neighbour read ahead
  { name: "Route 29 west to Cherrygrove", map: "ROUTE_29", at: [4, 7], hold: VOX_BTN.left },
];
declare const ONLY: string;
declare const INTRO: boolean;
const STOP_TICKS = 15 * 60;
let started = false;
let n = 0;
let stop = -1;

function arrive(s: Stop): void {
  console.log(`[pv] prof scene: ${s.name}`);
  game.options.view = s.view ?? "3d";
  game.options.battleView = "3d";
  while (game.stack.top()) game.stack.pop();
  const w = game.world;
  if (s.map && w) {
    const def = w.maps[s.map];
    const door = def && def.warps ? def.warps[0] : undefined;
    if (s.at) w.warpToMapId(s.map, s.at[0], s.at[1], "left");
    else if (door) w.warpToMapId(s.map, door.x, door.y + 1, "down");
  }
  if (s.menu) game.openStartMenu();
  if (s.battle && w) w.startBattle({ wild: Mon.new(game.data, s.battle, 5, {}) });
}

g.frame = (b: number): void => {
  // INTRO=1 at bundle time: stay on the intro and title, no tour
  if (typeof INTRO !== "undefined" && INTRO) {
    mainFrame(b & ~0xff);
    return;
  }
  if (!started) {
    started = true;
    const [save] = Save.load();
    game.continueGame(save);
  }
  n++;
  // ONLY="5,7" at bundle time: just those stops (0-based, TOUR's order)
  const tour = typeof ONLY !== "undefined" ? ONLY.split(",").map((i) => TOUR[Number(i)]!).filter(Boolean) : TOUR;
  const at = Math.floor((n - 180) / STOP_TICKS);
  if (n >= 180 && at !== stop && at < tour.length) {
    stop = at;
    arrive(tour[at]!);
  }
  let pad = 0;
  const s = tour[stop];
  if (s && !s.menu && !s.battle && game.world?.map && !game.stack.top()) {
    pad = s.hold ?? (Math.floor(n / 90) % 2 === 0 ? VOX_BTN.left : VOX_BTN.right);
  } else if (s?.battle && n % 20 === 0) {
    pad = VOX_BTN.a;
  }
  mainFrame((b & ~0xff) | pad);
};
