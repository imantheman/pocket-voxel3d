// A Citra bench of VISIBLE WILD on Red/Blue/Yellow (bundled in place of
// game.js): the card's save continued, then each place below walked back
// and forth for SEG host steps, the guest timing itself per rendered frame
// (as tools/speed_bench_gen1_entry.ts does) and logging one "vwbench:" line
// per segment beside the host's own perf lines:
//
//   forest  the forest (its 3D is off by the map's own rule), OFF at 1X,
//           then MANY at 1X and 2X
//   route   the big grass route with 3D on, OFF at 1X, MANY at 1X and 2X
//
// The walk is a row of the busiest grass, so the mons are round it the whole
// time; a touch starts nothing here (the shell's battle is held back) but
// the mon still goes and the spawner refills, so that is measured too.
// Never shipped.
import "../voxelmon/game/psp-main.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { native } from "../voxelmon/game/quickjs-host.ts";
import { CELL_LAND, WINDOW_X, WINDOW_Y, classifyCells } from "../voxelmon/game/visiblewild.ts";

const g = globalThis as unknown as { voxelmonGame: any; frame: (b: number) => void };
const game = g.voxelmonGame;
const mainFrame = g.frame;
const START = 1 << 6;
const now = (): number => native.now?.() ?? 0;
const log = (s: string): void => console.log("[pv] vwbench: " + s);

/** Host steps per segment: 20 s. */
const SEG = 1200;
const SEGS: { map: string; vw: string; speed: number }[] = [
  { map: "VIRIDIAN_FOREST", vw: "off", speed: 1 },
  { map: "VIRIDIAN_FOREST", vw: "many", speed: 1 },
  { map: "VIRIDIAN_FOREST", vw: "many", speed: 2 },
  { map: "ROUTE_11", vw: "off", speed: 1 },
  { map: "ROUTE_11", vw: "many", speed: 1 },
  { map: "ROUTE_11", vw: "many", speed: 2 },
];

let continued = false;
let ready = -1;
let n = 0;

let acc = 0;
let segFrames = 0, segSum = 0, segMax = 0, segSteps = 0, segTicks = 0, segOver = 0, monSum = 0, tiles = 0;
let touches0 = 0;

const toOverworld = (): void => {
  while (game.stack.length > 1 && game.stack[game.stack.length - 1].kind !== "overworld") game.pop();
};

// no battle starts here: the touch is counted, the mon goes, the walk goes on
let held = 0;
game.pushStubBattle = (): void => { held++; };

/** The busiest grass cell, then the longest walkable row through or next to
 *  it (no warp, no water, nobody near), up to 10 cells. */
function walkRow(): [number, number, number] | null {
  const o = game.overworld;
  const m = o.map;
  // the pure classification, so the game's own (a few rows a tick) is timed
  const kinds = classifyCells(m, game.data.encounters?.[m.id], game.data.field?.indoorEncounters);
  const w = m.widthCells, h = m.heightCells;
  let at: [number, number] | null = null;
  let bestN = -1;
  for (let cy = 1; cy < h - 1; cy++) for (let cx = 1; cx < w - 1; cx++) {
    if (kinds[cy * w + cx] !== CELL_LAND) continue;
    let k = 0;
    for (let y = Math.max(1, cy - WINDOW_Y); y <= Math.min(h - 2, cy + WINDOW_Y); y++) {
      for (let x = Math.max(1, cx - WINDOW_X); x <= Math.min(w - 2, cx + WINDOW_X); x++) if (kinds[y * w + x] === CELL_LAND) k++;
    }
    if (k > bestN) { bestN = k; at = [cx, cy]; }
  }
  if (!at) return null;
  const npcs = o.npcs ?? [];
  const near = (c: number, y: number): boolean => npcs.some((p: any) => Math.abs(p.cellX - c) <= 1 && Math.abs(p.cellY - y) <= 1);
  const ok = (c: number, y: number): boolean => m.isWalkableCell(c, y) && !m.isWaterCell(c, y) && !m.warpAtCell(c, y)
    && !m.isWarpTileCell(c, y) && !near(c, y);
  let best: [number, number, number] | null = null;
  let bestScore = -1;
  for (let y = Math.max(1, at[1] - 4); y <= Math.min(h - 2, at[1] + 4); y++) {
    for (let x = Math.max(1, at[0] - 10); x <= Math.min(w - 2, at[0] + 10); x++) {
      let len = 0;
      while (x + len < w - 1 && len < 10 && ok(x + len, y)) len++;
      if (len < 5) continue;
      const score = len * 4 - Math.abs(y - at[1]) - Math.abs(x + len / 2 - at[0]) / 2;
      if (score > bestScore) { bestScore = score; best = [x, y, len - 1]; }
    }
  }
  log(`${m.id}: busiest grass ${at.join(",")} (${bestN} cells in the window); row ${best ? best.join(",") : "none"}`);
  return best;
}

let row: [number, number, number] | null = null;
let dir = 1;
let legStart = 0;
let lastLanded = 0;

function place(map: string): void {
  toOverworld();
  const o = game.overworld;
  o.enter(map, 2, 2, "right");
  row = walkRow();
  if (row) o.enter(map, row[0], row[1], "right");
  dir = 1;
  legStart = o.player.landedCount;
  lastLanded = legStart;
}

function walkPad(t: number): number {
  const p = game.overworld?.player;
  if (!p || !row) return 0;
  if (p.landedCount !== lastLanded) { tiles += p.landedCount - lastLanded; lastLanded = p.landedCount; }
  if (t < 60) { legStart = p.landedCount; return 0; }
  if (p.landedCount - legStart >= row[2] && !p.moving) { dir = -dir; legStart = p.landedCount; }
  return dir > 0 ? VOX_BTN.right : VOX_BTN.left;
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
  } else if (ready < 0 && top?.kind === "overworld") {
    const s = game.save;
    s.options = { ...(s.options ?? {}), view: "3d", battleView: "3d", movement: "grid" };
    s.repelSteps = 0;
    game.overworld.trainerDefeated = () => true;
    ready = n + 60;
    log("ready");
  }
  if (ready >= 0 && n >= ready) {
    const k = Math.floor((n - ready) / SEG);
    const t = (n - ready) % SEG;
    const seg = SEGS[k];
    if (t === 0) {
      if (k > 0) {
        const p = SEGS[k - 1]!;
        log(`seg ${p.map} ${p.vw} ${p.speed}X: ${segFrames} frames in ${segSteps} steps (${(segFrames * 60 / Math.max(1, segSteps)).toFixed(1)} fps), ${segTicks} logic ticks; guest js per frame avg ${(segSum / Math.max(1, segFrames) / 1000).toFixed(2)} max ${(segMax / 1000).toFixed(1)} ms; frames over 25 ms ${segOver}; mons avg ${(monSum / Math.max(1, segSteps)).toFixed(1)}; touches ${held - touches0}; tiles ${tiles}`);
      }
      segFrames = segSum = segMax = segSteps = segTicks = segOver = monSum = tiles = 0;
      touches0 = held;
      if (!seg) { log("done"); ready = Number.MAX_SAFE_INTEGER; }
      else {
        game.save.options.visibleWild = seg.vw;
        game.setGameSpeed(seg.speed);
        log(`seg ${seg.map} ${seg.vw} ${seg.speed}X: start`);
        place(seg.map);
      }
    }
    if (seg) pad = walkPad(t);
  }
  const t0 = now();
  const k0 = game.tickIndex;
  mainFrame((b & ~0xff) | pad);
  const dt = now() - t0;
  acc += dt;
  segSteps++;
  segTicks += game.tickIndex - k0;
  monSum += game.overworld?.wild?.mons?.length ?? 0;
  if (!native.lastStep || native.lastStep()) {
    segFrames++;
    segSum += acc;
    if (acc > segMax) segMax = acc;
    if (acc > 25000) segOver++;
    acc = 0;
  }
};
