// A Citra bench of the big Gen 1 cities in 3D (built with PV_BENCH set, so
// the host runs two ticks a frame and steps the camera mode and the 3D
// slider itself -- main.rs BENCH_COMBOS): the card's save continued, then
// the player stood at each spot below for one round of the host's
// schedule, with a top-screen shot in every combination. The host prints a
// "bench:" line per combination. Never shipped.
import "../voxelmon/game/psp-main.ts";

const g = globalThis as unknown as { voxelmonGame: any; frame: (b: number) => void };
const game = g.voxelmonGame;
const mainFrame = g.frame;
const START = 1 << 6;

// The host's schedule (main.rs BENCH_SEG, BENCH_COMBOS.len()).
const SEG = 360;
const COMBOS = 9;
const ROUND = SEG * COMBOS;

/** Map, and where in it as fractions of its width and height. */
const SPOTS: [string, number, number][] = [
  ["SAFFRON_CITY", 0.5, 0.5],
  ["SAFFRON_CITY", 0.5, 0.8],
  ["CELADON_CITY", 0.5, 0.6],
  ["CERULEAN_CITY", 0.5, 0.5],
];

let continued = false;
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
        if (x < 0 || y < 0 || x >= map.widthCells || y >= map.heightCells) continue;
        if (map.isWalkableCell(x, y) && !map.warpAtCell(x, y)) return [x, y];
      }
    }
  }
  return null;
}

function toOverworld(): void {
  while (game.stack.length > 1 && game.stack[game.stack.length - 1].kind !== "overworld") game.pop();
}

g.frame = (b: number): void => {
  n++;
  let pad = 0;
  const top = game.stack?.[game.stack.length - 1];
  if (!continued) {
    if (top?.kind === "title") {
      continued = true;
      game.pop();
      top.onChoose?.("continue");
    } else if (n % 30 === 0) pad = START;
  } else if (game.save) {
    game.save.options = { ...(game.save.options ?? {}), view: "3d" };
  }
  const ow = game.overworld;
  // round 0 is the boot; round k + 1 is spot k
  const k = Math.floor(n / ROUND) - 1;
  const t = n % ROUND;
  if (continued && ow?.map && k >= 0 && k < SPOTS.length) {
    const [id, fx, fy] = SPOTS[k]!;
    if (t === 10) {
      toOverworld();
      log(`spot ${k} ${id}: entering`);
      ow.enter(id, 2, 2, "down");
    }
    if (t === 100 && ow.map.id === id) {
      const m = ow.map;
      const cx = Math.floor(m.widthCells * fx);
      const cy = Math.floor(m.heightCells * fy);
      const at = nearestOpen(m, cx, cy);
      log(`spot ${k} ${id} (${m.widthCells}x${m.heightCells} cells): ${cx},${cy} -> ${at ? at.join(",") : "?"}`);
      if (at) ow.enter(id, at[0], at[1], "down");
      toOverworld();
    }
    const c = Math.floor(t / SEG);
    if (c > 0 && t % SEG === SEG - 40) {
      log(`shot spot ${k} combo ${c} at ${ow.map.id}`);
      (globalThis as any).voxel?.screenshot?.();
    }
  }
  if (k === SPOTS.length && t === 10) log("done");
  mainFrame((b & ~0xff) | pad);
};
