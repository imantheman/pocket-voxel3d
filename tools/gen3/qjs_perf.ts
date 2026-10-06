// Port tooling: FireRed's per-frame cost, screen by screen, under the 3DS's
// own QuickJS on the desktop (bash cc_g3_qjsperf.sh). The playthrough of
// tools/gen3/playthrough.ts (title, a new game through the professor's
// speech and the naming screens, the house, the town, the lab, the rival
// battle, the start menu and its screens, a walk north) at the 60 fps model:
// one game.update and one draw per frame. Each segment prints update and
// draw ms (avg / p95 / max) and, with the profiling runner (qjs_prof.c),
// its own sampled profile.
//   QJS_WORLD3D=1  the field as the 3DS draws it in 3D (Game3World +
//                  WorldView over do-nothing scene ops), not VIEW 2D
//   QJS_PROF_N=<n> rows per profile table (0: no profiles)
// Never shipped.
import { reads, closeRead } from "./qjs_boot_host.ts";
import { G } from "../../voxelmon/game/gen3/platform/graphics.ts";
import { Game3 } from "../../voxelmon/game/gen3/core/Game3.ts";
import { Input } from "../../voxelmon/game/gen3/shared/core/Input.ts";
import { Runtime } from "../../voxelmon/game/gen3/core/runtime.ts";
import { Player } from "../../voxelmon/game/gen3/core/player.ts";
import { Collision } from "../../voxelmon/game/gen3/core/collision.ts";
import { Field } from "../../voxelmon/game/gen3/core/field.ts";
import { Party } from "../../voxelmon/game/gen3/core/party.ts";
import { BattleBridge } from "../../voxelmon/game/gen3/core/battle_bridge.ts";
import Trainers from "../../voxelmon/game/gen3/core/scripting/trainers.ts";
import { WorldView, parseWorldJson } from "../../voxelmon/game/gen3/platform/worldview.ts";
import { Game3World } from "../../voxelmon/game/gen3/platform/game3_world.ts";

declare const print: (s: string) => void;
declare const nowUs: () => number;
declare const readFile: (p: string) => string | undefined;
declare const memUsage: () => [number, number];
declare const profReset: undefined | (() => void);
declare const profDump: undefined | ((n: number, title: string) => void);
declare const profFrameBegin: undefined | (() => void);
declare const profFrameEnd: undefined | ((keep: boolean) => void);
declare const QJS_WORLD3D: number;
declare const QJS_PROF_N: number;
declare const QJS_MAX: number;
declare const QJS_SPIKE_MS: number;
declare const QJS_TRAINER: number;

const W3D = typeof QJS_WORLD3D === "number" && QJS_WORLD3D > 0;
const PROF_N = typeof QJS_PROF_N === "number" ? QJS_PROF_N : 30;
const MAX = typeof QJS_MAX === "number" && QJS_MAX > 0 ? QJS_MAX : 30000;
const hasProf = typeof profReset === "function";
/** QJS_SPIKE_MS: each segment's profile counts only its frames over this many ms. */
const SPIKE = typeof QJS_SPIKE_MS === "number" && QJS_SPIKE_MS > 0 ? QJS_SPIKE_MS : 0;
let spikes = 0;

const t0 = nowUs();
const game: any = Game3.new();
game.load({});
closeRead();
print(`[perf] load ${((nowUs() - t0) / 1000).toFixed(0)} ms, ${reads.length} reads, heap ${(memUsage()[0] / 1048576).toFixed(1)} MB; field ${W3D ? "3D (world)" : "VIEW 2D"}`);

let view: WorldView | undefined, field: Game3World | undefined;
if (W3D) {
  const ops = { mapShow() {}, mapHide() {}, cam() {}, pitch() {}, tint() {}, flatWorld() {}, g3Ents() {}, strips() {} };
  view = new WorldView(ops, parseWorldJson(readFile("world.json")));
  field = new Game3World(view);
}

const BIT: Record<string, number> = { UP: 0, DOWN: 1, LEFT: 2, RIGHT: 3, A: 4, B: 5, START: 6, SELECT: 7 };

// ---- segments
interface Seg { name: string; up: number[]; dr: number[]; frames: number; f0: number; phases: Record<string, number> }
let seg: Seg | null = null;
const done: Seg[] = [];
function stats(a: number[]): string {
  if (!a.length) return "-";
  const s = [...a].sort((x, y) => x - y);
  let sum = 0;
  for (const v of a) sum += v;
  return `${(sum / a.length).toFixed(3)} / ${s[Math.floor(s.length * 0.95)]!.toFixed(3)} / ${s[s.length - 1]!.toFixed(3)}`;
}
function endSeg(): void {
  if (!seg) return;
  const s = seg;
  seg = null;
  done.push(s);
  const tot = s.up.map((u, i) => u + s.dr[i]!);
  print(`[perf] === ${s.name}: ${s.frames} frames (f${s.f0}..f${f}) phases ${JSON.stringify(s.phases)}`);
  print(`[perf]     update ms avg/p95/max ${stats(s.up)}   draw ${stats(s.dr)}   frame ${stats(tot)}`);
  const np = (globalThis as any).__np;
  if (np) {
    print(`[perf]     thrown NotPortedErrors: ${Object.entries(np).map(([k, v]) => `${k} ${v}`).join(", ")}`);
    (globalThis as any).__np = {};
  }
  if (hasProf && PROF_N > 0) profDump!(PROF_N, SPIKE ? `${s.name} (only its ${spikes} frames over ${SPIKE} ms)` : s.name);
  spikes = 0;
}
function startSeg(name: string): void {
  endSeg();
  seg = { name, up: [], dr: [], frames: 0, f0: f + 1, phases: {} };
  if (hasProf) profReset!();
}

// ---- the frame (main.ts's: update, then begin / draw / end / emit)
let f = 0;
let lastMap = "";
const inBattle = (): boolean => game.speedCategory?.() === "battle";
function frame(mask: number): void {
  f++;
  const tg = (globalThis as { __perfToggle2d?: number[] }).__perfToggle2d; // perf_check --toggle2d
  if (tg && tg.indexOf(f) >= 0) Game3World.force2d = !Game3World.force2d;
  if (SPIKE && hasProf) profFrameBegin!();
  const ta = nowUs();
  (Input as any).hostButtons(mask);
  game.update(1 / 60);
  const tb = nowUs();
  if (field) field.begin(game);
  G.beginFrame();
  game.draw();
  G.endFrame();
  if (field && view) view.emit(field.state(game));
  const tc = nowUs();
  (globalThis as { __perfFrame?: (f: number) => void }).__perfFrame?.(f); // tools/gen3/perf_check.ts
  if (SPIKE && hasProf) {
    const slow = (tc - ta) / 1000 > SPIKE;
    if (slow) spikes++;
    profFrameEnd!(slow);
  }
  if (seg) {
    seg.up.push((tb - ta) / 1000);
    seg.dr.push((tc - tb) / 1000);
    seg.frames++;
    const ph = `${game.phase}${inBattle() ? "/battle" : ""}${field?.world3d ? "/3d" : ""}`;
    seg.phases[ph] = (seg.phases[ph] ?? 0) + 1;
  }
  const s = Runtime.getSession?.();
  const map = s?.map ?? "";
  if (map !== lastMap) { lastMap = map; print(`[perf] f${f}: map ${map}`); }
  if (f >= MAX) throw new Error(`frame budget ${MAX} spent`);
}
const tap = (key: string, hold = 6, after = 20): void => {
  for (let i = 0; i < hold; i++) frame(1 << BIT[key]!);
  for (let i = 0; i < after; i++) frame(0);
};
const idle = (n: number): void => { for (let i = 0; i < n; i++) frame(0); };
const inField = (): boolean => !!Runtime.getSession?.()?.map && game.phase === "field";

// ---- walking (playthrough.ts's BFS)
const DIRS: [string, number, number][] = [["up", 0, -1], ["down", 0, 1], ["left", -1, 0], ["right", 1, 0]];
function firstStep(tx: number, ty: number): string | undefined {
  const C: any = Collision, P: any = Player;
  const Wd = C._widthCells, H = C._heightCells;
  const sx = P.cellX, sy = P.cellY;
  const goal = (x: number, y: number): boolean =>
    ty < 0 ? y === 0 : ty >= H ? y === H - 1 : tx < 0 ? x === 0 : tx >= Wd ? x === Wd - 1 : x === tx && y === ty;
  const seen = new Map<number, string>();
  const q: [number, number][] = [[sx, sy]];
  seen.set(sy * Wd + sx, "");
  while (q.length) {
    const [x, y] = q.shift()!;
    if (goal(x, y)) {
      let k = y * Wd + x, dir = "";
      while (k !== sy * Wd + sx) { const v = seen.get(k)!; const [d, from] = v.split("@"); dir = d!; k = Number(from); }
      return dir || undefined;
    }
    for (const [d, dx, dy] of DIRS) {
      let nx = x + dx, ny = y + dy;
      const [lx, ly] = C.ledgeLanding(game, x, y, d);
      if (lx != null) { nx = lx; ny = ly; } else {
        if (nx < 0 || ny < 0 || nx >= Wd || ny >= H) continue;
        const [ok] = C.canEnter(game, nx, ny, { fromX: x, fromY: y, dir: d, elevation: P.currentElevation });
        if (!ok) continue;
      }
      const k = ny * Wd + nx;
      if (seen.has(k)) continue;
      seen.set(k, `${d}@${y * Wd + x}`);
      q.push([nx, ny]);
    }
  }
  return undefined;
}
const KEY: Record<string, string> = { up: "UP", down: "DOWN", left: "LEFT", right: "RIGHT" };
function pathTo(tx: number, ty: number, untilMapChange = true, limit = 3000, onArrive = "DOWN"): boolean {
  const start = lastMap, s0 = f;
  while (f - s0 < limit) {
    if (untilMapChange && lastMap !== start) return true;
    if (inBattle()) return false;
    const P: any = Player;
    if (P.moving || Runtime.uiBusy?.() || (Field as any).locked) { frame(Runtime.uiBusy?.() ? 1 << BIT.A! : 0); continue; }
    const C: any = Collision;
    const atEdge = ty < 0 ? P.cellY === 0 : ty >= C._heightCells ? P.cellY === C._heightCells - 1 : tx < 0 ? P.cellX === 0 : tx >= C._widthCells ? P.cellX === C._widthCells - 1 : false;
    let key: string;
    if (atEdge || (P.cellX === tx && P.cellY === ty)) {
      if (!untilMapChange) return true;
      key = tx < 0 ? "LEFT" : tx >= C._widthCells ? "RIGHT" : ty < 0 ? "UP" : ty >= C._heightCells ? "DOWN" : onArrive;
    } else {
      const d = firstStep(tx, ty);
      if (!d) { print(`[perf] f${f}: no path to (${tx},${ty}) on ${lastMap}`); return false; }
      key = KEY[d]!;
    }
    frame(1 << BIT[key]!);
  }
  return false;
}
function walkTo(tx: number, ty: number, untilMapChange = true, limit = 1500): boolean {
  const start = lastMap, s0 = f;
  let stuck = 0, lastX = -1, lastY = -1, axisX = true;
  while (f - s0 < limit) {
    if (untilMapChange && lastMap !== start) return true;
    const P: any = Player;
    const x = P.cellX, y = P.cellY;
    if (!untilMapChange && x === tx && y === ty) return true;
    if (x === lastX && y === lastY) stuck++; else { stuck = 0; lastX = x; lastY = y; }
    if (stuck > 90) { axisX = !axisX; stuck = 0; tap("A", 4, 10); }
    const dx = tx - x, dy = ty - y;
    let key: string;
    if (dx === 0 && dy === 0) key = "DOWN";
    else if ((axisX && dx !== 0) || dy === 0) key = dx > 0 ? "RIGHT" : dx < 0 ? "LEFT" : dy > 0 ? "DOWN" : "UP";
    else key = dy > 0 ? "DOWN" : "UP";
    frame(P.moving ? 0 : 1 << BIT[key]!);
  }
  return false;
}
function warpTo(toMap: string): boolean {
  const def = game.data?.maps?.[lastMap];
  const warps: any[] = [];
  for (const k in def?.warps ?? {}) warps.push(def.warps[k]);
  const live = warps.filter((w) => w && (Collision as any).warpAt(w.x, w.y));
  const w = live.find((w) => w.destMap === toMap) ?? live[0];
  if (!w) { print(`[perf] f${f}: no warp out of ${lastMap}`); return false; }
  if ((Collision as any).isDoorWarp(game, w.x, w.y) && !(Collision as any).isExitWarp(game, w.x, w.y)) return pathTo(w.x, w.y + 1, true, 3000, "UP");
  return pathTo(w.x, w.y, true);
}
function talkThrough(limit = 3000): boolean {
  const s0 = f;
  let free = 0;
  while (f - s0 < limit) {
    if (inBattle()) return true;
    if (Runtime.uiBusy?.() || (Field as any).locked || (Field as any).running) { free = 0; tap("A", 4, 16); }
    else { free++; frame(0); if (free > 90) return true; }
  }
  return false;
}

/** main.ts's bench start: a new game placed on a map. */
function place(map: string, x: number, y: number): void {
  game._handleBootAction({ action: "new_game", name: "RED", rivalName: "BLUE", gender: 0, start: { map, x, y, facing: "down" } });
  idle(90);
}

/** A wild battle: FIGHT, then Scratch (top left), Ember (bottom left), Growl (top right) in turn. */
function wildBattle(species: number, level: number): void {
  const [ok, err] = (BattleBridge as any).startWild((Runtime as any)._mod, game, { species, level }, {});
  if (!ok) print(`[perf] startWild failed: ${err}`);
  const s0 = f;
  let k = 0;
  for (let i = 0; i < 600 && !inBattle(); i++) frame(0); // the transition
  while (inBattle() && f - s0 < 9000) {
    const m = k++ % 3;
    tap("A", 4, 30);
    if (m === 1) tap("DOWN", 4, 10);
    if (m === 2) tap("RIGHT", 4, 10);
    tap("A", 4, 30);
    for (let i = 0; i < 8 && inBattle(); i++) tap("B", 4, 26);
  }
}

// ---- the run
try {
  startSeg("boot + credits + title attract");
  idle(430);
  startSeg("title -> new game: the professor's speech, naming");
  tap("START");
  let n = 0;
  while (!inField() && f < MAX) tap(n++ % 7 === 6 ? "START" : "A", 6, 39);
  startSeg("field: bedroom idle");
  idle(240);
  startSeg("field: down the stairs");
  warpTo("FR_PLAYERS_HOUSE_1F");
  idle(60);
  // the town, the battle and the menus from a placed new game (main.ts's
  // bench start), with a party given as a script's givemon would
  place("FR_PALLET_TOWN", 6, 8);
  startSeg("field: town walk (NPCs)");
  pathTo(12, 4, false, 600);
  pathTo(4, 14, false, 900);
  pathTo(16, 14, false, 900);
  pathTo(10, 8, false, 600);
  startSeg("field: town idle");
  idle(300);
  {
    const session = Runtime.getSession();
    (Party as any).giveMon(session, 4, 12);
    (Party as any).giveMon(session, 1, 12);
  }
  // the first battle loads the battle and its animations' packs (the
  // desktop reads the raw cache: Lua text and PNGs, unlike the card)
  startSeg("battle: first (loads; wild, Scratch / Ember / Growl)");
  wildBattle(16, 4);
  startSeg("field: after the battle");
  idle(120);
  startSeg("battle: second (wild: intro, menus, move animations)");
  wildBattle(19, 4);
  startSeg("field: after the battle");
  idle(120);
  if (typeof QJS_TRAINER === "number" && QJS_TRAINER > 0) {
    // QJS_TRAINER=<id>: a trainer battle too (its transition and pictures load on first use)
    startSeg(`battle: trainer ${QJS_TRAINER} (first: the transition, the intro)`);
    const foe = (Trainers as any).foeFromId(QJS_TRAINER);
    const [ok, err] = foe ? (BattleBridge as any).start((Runtime as any)._mod, game, foe, { trainerId: QJS_TRAINER }) : [false, "no party"];
    if (!ok) print(`[perf] trainer battle failed to start: ${err}`);
    for (let i = 0; i < 600 && !inBattle(); i++) frame(0);
    for (let i = 0; i < 400; i++) frame(0); // the intro, up to the action menu
    startSeg("field: after the battle");
    (BattleBridge as any).finishPending("win");
    idle(120);
  }
  startSeg("menu: start menu, party, summary, bag");
  tap("START", 4, 40);
  tap("A", 4, 90); // the first row (no dex yet): the party
  tap("A", 4, 60); // a mon's action menu
  tap("A", 4, 120); // summary
  tap("RIGHT", 4, 60);
  tap("RIGHT", 4, 60);
  tap("B", 4, 60);
  tap("B", 4, 40);
  tap("B", 4, 60);
  tap("DOWN", 4, 20);
  tap("A", 4, 120); // bag
  tap("RIGHT", 4, 40);
  tap("RIGHT", 4, 40);
  tap("B", 4, 90);
  tap("B", 4, 60);
  idle(60);
  startSeg("field: town -> route 1 (connection)");
  pathTo(0, -1, true, 3000);
  startSeg("field: route walk (grass)");
  pathTo(0, -1, true, 2500);
  endSeg();
} catch (e) {
  endSeg();
  print(`[perf] stopped at f${f}: ${(e as Error)?.stack ?? e}`);
}
print("[perf] summary (ms: update avg/p95/max | draw avg/p95/max | frame avg/p95/max)");
for (const s of done) {
  const tot = s.up.map((u, i) => u + s.dr[i]!);
  print(`[perf] ${s.name.padEnd(56)} ${String(s.frames).padStart(5)}f  up ${stats(s.up)} | draw ${stats(s.dr)} | frame ${stats(tot)}`);
}
