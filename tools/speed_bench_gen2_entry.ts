// A Citra bench of GAME SPEED on Gold/Silver/Crystal (gamespeed.ts): the
// card's save continued, then each heavy place below run for SEG host steps
// at 1X and again at 2X, the guest timing itself per rendered frame (the
// frame() calls between two of the host's renders, voxel.lastStep) and
// logging one "speedbench:" line per segment beside the host's perf lines:
//
//   city    the biggest city, walking back and forth along a clear row
//   forest  the forest, the same
//   battle  a wild battle with BATTLE SCENE on, FIGHT -> SWIFT every turn,
//           each turn's length logged
//   menu    the party screen, the cursor cycling
//
// The walks also log how long ten tiles took from a standstill. Not run
// with PV_BENCH. Never shipped.
import "../voxelmon/game/gen2/main.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { native } from "../voxelmon/game/quickjs-host.ts";
import { Save } from "../voxelmon/game/gen2/core/Save.ts";
import { Mon } from "../voxelmon/game/gen2/battle/Mon.ts";
import { Battle } from "../voxelmon/game/gen2/battle/Battle.ts";
import { Screens } from "../voxelmon/game/gen2/shared/ui/Screens.ts";

const g = globalThis as unknown as { goldGame: any; frame: (b: number) => void };
const game = g.goldGame;
const mainFrame = g.frame;
const now = (): number => native.now?.() ?? 0;
const log = (s: string): void => console.log("[pv] speedbench: " + s);

const SEG = 1200;
declare const BENCH_CITY: string;
const CITY = typeof BENCH_CITY !== "undefined" ? BENCH_CITY : "GOLDENROD_CITY";
const FOREST = "ILEX_FOREST";
/** --define 'BENCH_PHASES=["battle"]' runs only some; BENCH_PROF=true adds
 * gen2/main.ts's own step/draw/lcd/view split (goldProf). */
declare const BENCH_PHASES: string[];
declare const BENCH_PROF: boolean;
const PHASES: readonly string[] = typeof BENCH_PHASES !== "undefined" ? BENCH_PHASES : ["city", "forest", "battle", "menu"];
if (typeof BENCH_PROF !== "undefined" && BENCH_PROF) (globalThis as unknown as { goldProf?: boolean }).goldProf = true;
const perfect = () => ({ attack: 15, defense: 15, speed: 15, special: 15 });

// logic ticks, counted where they run (the fallback may run fewer than SPEED)
const logicFrame = game.logicFrame.bind(game);
game.logicFrame = (b: number): void => { segTicks++; logicFrame(b); };

let started = false;
let ready = -1;
let n = 0;

let acc = 0;
let segFrames = 0;
let segSum = 0;
let segMax = 0;
let segSteps = 0;
let segTicks = 0;
let segOver = 0;

function clearRow(m: any, w: number, h: number, want: number): [number, number, number] | null {
  let best: [number, number, number] | null = null;
  const cx = Math.floor(w / 2);
  const cy = Math.floor(h / 2);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let len = 0;
      while (x + len < w - 1 && len <= want) {
        const c = x + len;
        if (!(m.isWalkableCell(c, y) && !m.isGrassCell(c, y) && !m.warpAt(c, y))) break;
        // nobody standing on the row or beside it
        let near = false;
        for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1 && !near; dx++) near = !!game.world.npcAt(c + dx, y + dy);
        if (near) break;
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

function party(): any[] {
  return ["MEW", "ARCANINE", "LAPRAS", "SNORLAX", "JOLTEON", "DRAGONITE"].map((sp) =>
    Mon.new(game.data, sp, 70, { dvs: perfect(), moves: [{ id: "SWIFT", pp: 63, maxPp: 63 }] }));
}

function setup(): void {
  game.options.view = "3d";
  game.options.battleView = "3d";
  game.options.movement = "grid";
  game.options.battleScene = true;
  game.save.party = party();
  game.save.repelSteps = 60000;
  if (game.world) game.world.trainerBeaten = () => true;
}

// ---- the walk ---------------------------------------------------------------
let row: [number, number, number] | null = null;
let dir = 1;
let stepsTaken = 0;
let legStart = 0;
let lastCell = "";
let tenBase = -1;
let tenT0 = 0;
let tenSteps0 = 0;
let tenArmed = false;
let tiles = 0;

function placeWalk(map: string): void {
  while (game.stack.top()) game.stack.pop();
  const w = game.world;
  w.trainerBeaten = () => true;
  const def = w.maps[map];
  w.setMap(map, 2, 2, "right");
  row = clearRow(w.map, def.width * 2, def.height * 2, 12);
  if (row) w.setMap(map, row[0], row[1], "right");
  log(`${map}: row ${row ? row.join(",") : "none"}`);
  dir = 1;
  tenArmed = true;
  lastCell = "";
}

function walkPad(t: number): number {
  const p = game.world?.player;
  if (!p || !row) return 0;
  const cell = `${p.cellX},${p.cellY}`;
  if (lastCell && cell !== lastCell) { stepsTaken++; tiles++; }
  lastCell = cell;
  if (t < 60) { legStart = stepsTaken; return 0; }
  if (tenArmed) {
    tenArmed = false;
    tenBase = stepsTaken;
    tenT0 = now();
    tenSteps0 = n;
    legStart = stepsTaken;
  }
  if (tenBase >= 0 && stepsTaken - tenBase >= Math.min(10, row[2])) {
    log(`ten tiles (${Math.min(10, row[2])}) at ${game.gameSpeed()}X: ${n - tenSteps0} host steps, ${((now() - tenT0) / 1000).toFixed(0)} ms`);
    tenBase = -1;
  }
  if (stepsTaken - legStart >= row[2]) {
    dir = -dir;
    legStart = stepsTaken;
  }
  return dir > 0 ? VOX_BTN.right : VOX_BTN.left;
}

// ---- the battle ---------------------------------------------------------------
let state: any = null;
let battleDone = true;
let lastPhase = "";
let turnT0 = 0;
let turnSteps0 = 0;
let battles = 0;

function battlePad(t: number): number {
  if (battleDone) {
    if (t < 30) return 0;
    while (game.stack.top()) game.stack.pop();
    game.save.party = party();
    const wild: any = Mon.new(game.data, "CHANSEY", 60, { dvs: perfect() });
    const battle: any = Battle.new({ data: game.data, party: game.save.party, wild, save: game.save });
    battleDone = false;
    battles++;
    lastPhase = "";
    Screens.push(game, "Gen2BattleState", { battle, save: game.save, onDone: () => { battleDone = true; game.stack.pop(); } });
    state = game.stack.top();
  }
  const ph: string = state.phase;
  if (ph !== lastPhase) {
    if (ph === "moves") { turnT0 = now(); turnSteps0 = n; }
    if (ph === "menu" && turnSteps0 > 0) {
      log(`turn at ${game.gameSpeed()}X: ${n - turnSteps0} host steps, ${((now() - turnT0) / 1000).toFixed(0)} ms`);
      turnSteps0 = 0;
    }
    lastPhase = ph;
  }
  const tick = n % 2 === 0;
  if (!tick) return 0;
  if (ph === "menu") return state.menuIndex === 1 && (state.messageTimer ?? 0) <= 0 ? VOX_BTN.a : state.menuIndex !== 1 ? VOX_BTN.up : 0;
  if (ph === "moves") return state.moveIndex > 1 ? VOX_BTN.up : VOX_BTN.a;
  return VOX_BTN.a;
}

// ---- the menu ---------------------------------------------------------------
function menuPad(t: number): number {
  if (t === 1) {
    while (game.stack.top()) game.stack.pop();
    game.save.party = party();
    Screens.push(game, "Gen2PartyMenu", { prompt: "choose", submenu: true, onCancel: () => game.stack.pop() });
  }
  return t % 6 === 0 ? VOX_BTN.down : 0;
}

g.frame = (b: number): void => {
  n++;
  if (!started) {
    started = true;
    const [save] = Save.load();
    game.continueGame(save);
  }
  let pad = 0;
  if (ready < 0 && game.world?.map && game.phase === "play") {
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
        log(`seg ${prev} ${((k - 1) & 1) + 1}X: ${segFrames} frames in ${segSteps} steps (${(segFrames * 60 / Math.max(1, segSteps)).toFixed(1)} fps), ${segTicks} logic ticks; guest js per frame avg ${(segSum / Math.max(1, segFrames) / 1000).toFixed(2)} max ${(segMax / 1000).toFixed(1)} ms; frames over 25 ms ${segOver}; tiles ${tiles}; battles ${battles}`);
      }
      segFrames = segSum = segMax = segSteps = segTicks = segOver = 0;
      tiles = 0;
      battles = 0;
      if (!phase) { log("done"); ready = Number.MAX_SAFE_INTEGER; }
      else {
        game.setGameSpeed(speed);
        log(`seg ${phase} ${speed}X: start`);
        if (phase === "city") placeWalk(CITY);
        if (phase === "forest") placeWalk(FOREST);
        if (phase === "battle") { battleDone = true; while (game.stack.top()) game.stack.pop(); game.world.setMap("ROUTE_29", 20, 8, "down"); }
      }
    }
    if (phase === "city" || phase === "forest") pad = walkPad(t);
    else if (phase === "battle") pad = battlePad(t);
    else if (phase === "menu") pad = menuPad(t);
  }
  const t0 = now();
  mainFrame((b & ~0xff) | pad);
  acc += now() - t0;
  segSteps++;
  if (!native.lastStep || native.lastStep()) {
    segFrames++;
    segSum += acc;
    if (acc > segMax) segMax = acc;
    if (acc > 25000) segOver++;
    acc = 0;
  }
};
