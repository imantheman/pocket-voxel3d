// A Citra bench of GAME SPEED on Red/Blue/Yellow (gamespeed.ts): the card's
// save continued, then each heavy place below run for SEG host steps at 1X
// and again at 2X, the guest timing itself per rendered frame (the frame()
// calls between two of the host's renders, voxel.lastStep) and logging one
// "speedbench:" line per segment beside the host's own perf lines:
//
//   city    the biggest city, walking back and forth along a clear row
//   forest  the forest, the same
//   battle  a wild battle with animations on, A mashed: SWIFT every turn,
//           each turn's length logged
//   menu    the party screen over the world, the cursor cycling
//
// The walks also log how long ten tiles took from a standstill. Not run
// with PV_BENCH (the host paces itself as it does for a player). Never
// shipped.
import "../voxelmon/game/psp-main.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { native } from "../voxelmon/game/quickjs-host.ts";
import { newMon } from "../voxelmon/game/battle/mon.ts";
import { PartyState } from "../voxelmon/game/ui/partyscreen.ts";

const g = globalThis as unknown as { voxelmonGame: any; frame: (b: number) => void };
const game = g.voxelmonGame;
const mainFrame = g.frame;
const START = 1 << 6;
const now = (): number => native.now?.() ?? 0;
const log = (s: string): void => console.log("[pv] speedbench: " + s);

/** Host steps per segment (one place at one speed): 20 s. */
const SEG = 1200;
declare const BENCH_CITY: string;
const CITY = typeof BENCH_CITY !== "undefined" ? BENCH_CITY : "SAFFRON_CITY";
const FOREST = "VIRIDIAN_FOREST";
const PHASES = ["city", "forest", "battle", "menu"] as const;

let continued = false;
let ready = -1;
let n = 0;

// ---- the guest's own clock, per rendered frame --------------------------
let acc = 0;
let segFrames = 0;
let segSum = 0;
let segMax = 0;
let segSteps = 0;
let segTicks = 0;
const over: number[] = [];

/** A clear row (no grass, warp, water or door) of up to `want` cells. */
function clearRow(m: any, want: number, npcs: any[]): [number, number, number] | null {
  let best: [number, number, number] | null = null;
  // nobody standing on the row or beside it
  const near = (c: number, y: number): boolean => npcs.some((p) => Math.abs(p.cellX - c) <= 1 && Math.abs(p.cellY - y) <= 1);
  const cx = Math.floor(m.widthCells / 2);
  const cy = Math.floor(m.heightCells / 2);
  for (let y = 1; y < m.heightCells - 1; y++) {
    for (let x = 1; x < m.widthCells - 1; x++) {
      let len = 0;
      while (x + len < m.widthCells - 1 && len <= want) {
        const c = x + len;
        const ok = m.isWalkableCell(c, y) && !m.isGrassCell(c, y) && !m.isWaterCell(c, y)
          && !m.warpAtCell(c, y) && !m.isDoorTileCell(c, y) && !m.isWarpTileCell(c, y) && !near(c, y);
        if (!ok) break;
        len++;
      }
      const run = Math.min(len - 1, want);
      if (run < 4) continue;
      const d = Math.abs(x - cx) + Math.abs(y - cy);
      if (!best || run > best[2] || (run === best[2] && d < Math.abs(best[0] - cx) + Math.abs(best[1] - cy))) {
        best = [x, y, run];
      }
    }
  }
  return best;
}

function toOverworld(): void {
  while (game.stack.length > 1 && game.stack[game.stack.length - 1].kind !== "overworld") game.pop();
}

function setup(): void {
  const s = game.save;
  s.options = { ...(s.options ?? {}), view: "3d", battleView: "3d", movement: "grid", animations: true };
  s.repelSteps = 60000;
  const mon = (species: string, level: number): any => {
    const m = newMon(game.data, species, level);
    m.moves = [{ id: "SWIFT", pp: 63 }];
    return m;
  };
  s.party = ["MEW", "ARCANINE", "LAPRAS", "SNORLAX", "JOLTEON", "DRAGONITE"].map((sp) => mon(sp, 70));
  // no trainer spots the walk
  game.overworld.trainerDefeated = () => true;
}

// ---- the walk: back and forth along the row --------------------------------
let row: [number, number, number] | null = null;
let dir = 1;
let legStart = 0;
let tenStart = -1;
let tenT0 = 0;
let tenBase = 0;
let tenSteps0 = 0;
let tiles = 0;
let lastLanded = 0;

function placeWalk(map: string): void {
  toOverworld();
  const ow = game.overworld;
  ow.enter(map, 2, 2, "right");
  row = clearRow(ow.map, 12, ow.npcs ?? []);
  if (row) ow.enter(map, row[0], row[1], "right");
  log(`${map}: row ${row ? row.join(",") : "none"}`);
  dir = 1;
  tenStart = -1;
}

function walkPad(t: number): number {
  const p = game.overworld?.player;
  if (!p || !row) return 0;
  if (p.landedCount !== lastLanded) {
    tiles += p.landedCount - lastLanded;
    lastLanded = p.landedCount;
  }
  // a second's rest, then ten tiles from a standstill, timed
  if (t < 60) { legStart = p.landedCount; return 0; }
  if (tenStart < 0) {
    tenStart = t;
    tenT0 = now();
    tenBase = p.landedCount;
    tenSteps0 = n;
    legStart = p.landedCount;
  }
  if (tenBase >= 0 && p.landedCount - tenBase >= Math.min(10, row[2])) {
    log(`ten tiles (${Math.min(10, row[2])}) at ${game.gameSpeed()}X: ${n - tenSteps0} host steps, ${((now() - tenT0) / 1000).toFixed(0)} ms`);
    tenBase = -1;
  }
  if (p.landedCount - legStart >= row[2] && !p.moving) {
    dir = -dir;
    legStart = p.landedCount;
  }
  return dir > 0 ? VOX_BTN.right : VOX_BTN.left;
}

// ---- the battle: A mashed, each turn timed ----------------------------------
let turnT0 = 0;
let turnSteps0 = 0;
let lastPhase = "";
let battles = 0;
let restAt = 0;

function battlePad(t: number): number {
  const bv = game.battleView?.();
  if (!bv) {
    if (t < restAt) return 0;
    toOverworld();
    const s = game.save;
    for (const m of s.party) { m.hp = m.stats.hp; m.status = null; for (const mv of m.moves) mv.pp = 63; }
    game.startWildBattle("CHANSEY", 60);
    battles++;
    lastPhase = "";
    restAt = t + 30;
    return 0;
  }
  restAt = t + 30;
  const ph: string = bv.battle.phase;
  if (ph !== lastPhase) {
    if (ph === "moveSelect") { turnT0 = now(); turnSteps0 = n; }
    if (ph === "menu" && lastPhase !== "" && turnSteps0 > 0) {
      log(`turn at ${game.gameSpeed()}X: ${n - turnSteps0} host steps, ${((now() - turnT0) / 1000).toFixed(0)} ms`);
      turnSteps0 = 0;
    }
    lastPhase = ph;
  }
  return n % 2 === 0 ? VOX_BTN.a : 0;
}

// ---- the menu ---------------------------------------------------------------
function menuPad(t: number): number {
  if (t === 1) {
    toOverworld();
    game.push(new PartyState(game));
  }
  return t % 6 === 0 ? VOX_BTN.down : 0;
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
    setup();
    ready = n + 60;
    log(`ready; city ${CITY}`);
  }
  if (ready >= 0 && n >= ready) {
    const k = Math.floor((n - ready) / SEG);
    const t = (n - ready) % SEG;
    const phase = PHASES[k >> 1];
    const speed = (k & 1) + 1;
    if (t === 0) {
      if (k > 0) {
        const prev = PHASES[(k - 1) >> 1];
        log(`seg ${prev} ${((k - 1) & 1) + 1}X: ${segFrames} frames in ${segSteps} steps (${(segFrames * 60 / Math.max(1, segSteps)).toFixed(1)} fps), ${segTicks} logic ticks; guest js per frame avg ${(segSum / Math.max(1, segFrames) / 1000).toFixed(2)} max ${(segMax / 1000).toFixed(1)} ms; frames over 25 ms ${over.length}; tiles ${tiles}; battles ${battles}`);
      }
      segFrames = segSum = segMax = segSteps = segTicks = 0;
      over.length = 0;
      tiles = 0;
      battles = 0;
      if (!phase) { log("done"); ready = Number.MAX_SAFE_INTEGER; }
      else {
        game.setGameSpeed(speed);
        log(`seg ${phase} ${speed}X: start`);
        if (phase === "city") placeWalk(CITY);
        if (phase === "forest") placeWalk(FOREST);
        if (phase === "battle") { toOverworld(); game.overworld.enter("ROUTE_1", 8, 20, "up"); restAt = 30; }
        lastLanded = game.overworld?.player?.landedCount ?? 0;
      }
    }
    if (phase === "city" || phase === "forest") pad = walkPad(t);
    else if (phase === "battle") pad = battlePad(t);
    else if (phase === "menu") pad = menuPad(t);
  }
  const t0 = now();
  // logic ticks, counted where they run (the fallback may run fewer than SPEED)
  const k0 = game.tickIndex;
  mainFrame((b & ~0xff) | pad);
  const dt = now() - t0;
  acc += dt;
  segSteps++;
  segTicks += game.tickIndex - k0;
  if (!native.lastStep || native.lastStep()) {
    segFrames++;
    segSum += acc;
    if (acc > segMax) segMax = acc;
    if (acc > 25000) over.push(acc);
    acc = 0;
  }
};
