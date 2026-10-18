// A Citra shot of the border fill past map edges in Gold/Silver/Crystal 3D:
// the card's save continued, then the player stood at each spot below (the
// nearest open cell to it) and the top screen shot once the map and its
// strips have built. Each shot is "[pv] bpshot N MAP x,y". Never shipped.
import "../voxelmon/game/gen2/main.ts";
import { Save } from "../voxelmon/game/gen2/core/Save.ts";
import { native } from "../voxelmon/game/quickjs-host.ts";

const g = globalThis as unknown as { goldGame: any; frame: (b: number) => void };
const game = g.goldGame;
const mainFrame = g.frame;

/** Map and cell (a build can name others: --define 'SHOT_SPOTS=[["MAP",x,y]]'). */
declare const SHOT_SPOTS: [string, number, number][];
const SPOTS: [string, number, number][] = typeof SHOT_SPOTS !== "undefined" ? SHOT_SPOTS : [
  ["ROUTE_34", 13, 17], // the day-care route: its yard
  ["ROUTE_34", 14, 22], // and south of its fence
  ["ROUTE_34", 16, 34], // its east edge where the short connection starts
  ["ROUTE_29", 8, 3], // the first route, its north edge west of its short north connection
  ["ROUTE_35", 3, 20], // beside the park gate route, west edge
  ["ROUTE_1", 4, 18], // a Kanto route, west edge
  ["GOLDENROD_CITY", 20, 18],
];
/** Frames a spot gets: warp, settle, build, shot. */
const PER = 420;

let started = false;
let n = 0;
const log = (s: string): void => console.log("[pv] " + s);

function nearestOpen(map: any, cx: number, cy: number): [number, number] | null {
  for (let r = 0; r < 24; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (!map.inBounds(x, y)) continue;
        if (map.isWalkableCell(x, y) && !map.warpAt(x, y)) return [x, y];
      }
    }
  }
  return null;
}

g.frame = (b: number): void => {
  if (!started) {
    started = true;
    const [save] = Save.load();
    game.continueGame(save);
    game.options.view = "3d";
  }
  n++;
  const w = game.world;
  // the first 600 frames are the boot; spot k after
  const k = Math.floor((n - 600) / PER);
  const t = (n - 600) % PER;
  if (n >= 600 && w?.map && k >= 0 && k < SPOTS.length) {
    const [id, x, y] = SPOTS[k]!;
    if (t === 10) {
      while (game.stack.top()) game.stack.pop();
      w.warpToMapId(id, x, y, "down");
    }
    if (t === 150 && w.map.id === id) {
      const at = nearestOpen(w.map, x, y);
      if (at) w.setMap(id, at[0], at[1], "down");
    }
    if (t === PER - 30) {
      log(`bpshot ${k} ${w.map.id} ${w.player?.cellX},${w.player?.cellY}`);
      native.screenshot?.();
    }
  }
  if (n >= 600 && k === SPOTS.length && t === 10) log("bpshot done");
  mainFrame(b & ~0xff);
};
