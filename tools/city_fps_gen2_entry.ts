// A Citra bench of the big Gen 2 cities in 3D (built with PV_BENCH set, so
// the host runs two ticks a frame and steps the camera mode and the 3D
// slider itself -- main.rs BENCH_COMBOS): the card's save continued, then
// the player stood at each spot below for one round of the host's
// schedule, with a top-screen shot in every combination. The host prints a
// "bench:" line per combination (vertices and draw calls per eye, CPU ms,
// command buffer). Never shipped.
import "../voxelmon/game/gen2/main.ts";
import { Save } from "../voxelmon/game/gen2/core/Save.ts";
import { native } from "../voxelmon/game/quickjs-host.ts";

const g = globalThis as unknown as { goldGame: any; frame: (b: number) => void };
const game = g.goldGame;
const mainFrame = g.frame;

// The host's schedule (main.rs BENCH_SEG, BENCH_COMBOS.len()).
const SEG = 360;
const COMBOS = 9;
const ROUND = SEG * COMBOS;

/** Map, and where in it as fractions of its width and height (a build
 * can name others: --define 'BENCH_SPOTS=[["MAP",0.5,0.5]]'). */
declare const BENCH_SPOTS: [string, number, number][];
const SPOTS: [string, number, number][] = typeof BENCH_SPOTS !== "undefined" ? BENCH_SPOTS : [
  ["GOLDENROD_CITY", 0.5, 0.5],
  ["GOLDENROD_CITY", 0.45, 0.85],
  ["GOLDENROD_CITY", 0.3, 0.3],
  ["ECRUTEAK_CITY", 0.5, 0.55],
  ["OLIVINE_CITY", 0.5, 0.5],
];

let started = false;
let n = 0;
const log = (s: string): void => console.log("[pv] bench: " + s);

/** The walkable, warp-free cell nearest (cx, cy) on the loaded map. */
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
  // round 0 is the boot; round k + 1 is spot k
  const k = Math.floor(n / ROUND) - 1;
  const t = n % ROUND;
  if (w?.map && k >= 0 && k < SPOTS.length) {
    const [id, fx, fy] = SPOTS[k]!;
    const def = w.maps[id];
    if (t === 10) {
      while (game.stack.top()) game.stack.pop();
      const cx = Math.floor(def.width * 2 * fx);
      const cy = Math.floor(def.height * 2 * fy);
      log(`spot ${k} ${id} (${def.width * 2}x${def.height * 2} cells): to ${cx},${cy}`);
      w.warpToMapId(id, cx, cy, "down");
    }
    if (t === 150 && w.map.id === id) {
      const p = w.player;
      const at = nearestOpen(w.map, p.cellX, p.cellY);
      if (at && (at[0] !== p.cellX || at[1] !== p.cellY)) w.setMap(id, at[0], at[1], "down");
      log(`spot ${k} ${id} stands at ${at ? at.join(",") : "?"}`);
    }
    // a shot of each measured combination, late in its settled half
    const c = Math.floor(t / SEG);
    if (c > 0 && t % SEG === SEG - 40) {
      log(`shot spot ${k} combo ${c} at ${w.map.id} (${w.player?.cellX},${w.player?.cellY})`);
      native.screenshot?.();
    }
  }
  if (k === SPOTS.length && t === 10) log("done");
  mainFrame(b & ~0xff);
};
