// Port tooling: the transitions bench (voxelmon/game/gen3/platform/bench_load.ts,
// the device's PV_G3_BENCH_SCRIPT=load) under the 3DS's own QuickJS on the
// desktop (bash .cc_ld_qjs.sh): the same session, frame for frame at the 60
// fps model (one update and one draw a frame), each of the bench's marks a
// segment with its update/draw times and, under the profiling runner
// (qjs_prof.c) with QJS_SPIKE_MS, a profile of its slow frames alone.
//   QJS_WORLD3D=1   the field as the 3DS draws it in 3D (Game3World + WorldView
//                   over do-nothing scene ops)
//   QJS_PROF_N=<n>  rows per profile table (0: none)
//   QJS_SPIKE_MS    only frames over this many ms are profiled
//   QJS_LOGS=1      the runtime's own log lines too
// Never shipped.
import { reads, closeRead } from "./qjs_boot_host.ts";
import { G } from "../../voxelmon/game/gen3/platform/graphics.ts";
import { Game3 } from "../../voxelmon/game/gen3/core/Game3.ts";
import { Input } from "../../voxelmon/game/gen3/shared/core/Input.ts";
import { WorldView, parseWorldJson } from "../../voxelmon/game/gen3/platform/worldview.ts";
import { Game3World } from "../../voxelmon/game/gen3/platform/game3_world.ts";
import { BenchLoad } from "../../voxelmon/game/gen3/platform/bench_load.ts";
import { getHost } from "../../voxelmon/game/gen3/platform/host.ts";

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
declare const QJS_LOGS: number;
declare const QJS_PART: string;

const W3D = typeof QJS_WORLD3D === "number" && QJS_WORLD3D > 0;
const PROF_N = typeof QJS_PROF_N === "number" ? QJS_PROF_N : 30;
const MAX = typeof QJS_MAX === "number" && QJS_MAX > 0 ? QJS_MAX : 40000;
const SPIKE = typeof QJS_SPIKE_MS === "number" && QJS_SPIKE_MS > 0 ? QJS_SPIKE_MS : 0;
const LOGS = typeof QJS_LOGS === "number" && QJS_LOGS > 0;
const hasProf = typeof profReset === "function";

interface Seg { name: string; up: number[]; dr: number[]; f0: number }
let seg: Seg | null = null;
const done: Seg[] = [];
let f = 0;
let spikes = 0;

function stats(a: number[]): string {
  if (!a.length) return "-";
  const s = [...a].sort((x, y) => x - y);
  let sum = 0;
  for (const v of a) sum += v;
  return `${(sum / a.length).toFixed(2)} / ${s[Math.floor(s.length * 0.95)]!.toFixed(2)} / ${s[s.length - 1]!.toFixed(2)}`;
}
function endSeg(): void {
  if (!seg) return;
  const s = seg;
  seg = null;
  done.push(s);
  const tot = s.up.map((u, i) => u + s.dr[i]!);
  const slow = tot.filter((t) => SPIKE && t > SPIKE).length;
  print(`[load] === ${s.name}: ${s.up.length} frames (f${s.f0}..f${f}); frame ms avg/p95/max ${stats(tot)}  update ${stats(s.up)}  draw ${stats(s.dr)}${SPIKE ? `; ${slow} over ${SPIKE} ms` : ""}`);
  if (hasProf && PROF_N > 0 && (!SPIKE || spikes > 0)) profDump!(PROF_N, SPIKE ? `${s.name} (only its ${spikes} frames over ${SPIKE} ms)` : s.name);
  spikes = 0;
}
function startSeg(name: string): void {
  endSeg();
  seg = { name, up: [], dr: [], f0: f + 1 };
  if (hasProf) profReset!();
}

// the bench's marks start the segments; its other lines go out as they are
console.log = (...a: unknown[]): void => {
  const s = a.map((x) => (typeof x === "string" ? x : String(x))).join(" ");
  const m = s.match(/^\[pv\] g3 mark: (.*?)(?: \(tick \d+.*\))?$/);
  if (m && !/menu entries|start failed|still on|no warp/.test(m[1]!)) { startSeg(m[1]!.split(";")[0]!); print(`[mark] f${f} ${s.slice(14)}`); return; }
  if (LOGS || s.startsWith("[pv] g3 mark") || s.startsWith("[pv] g3 stray")) print(s);
};
console.warn = console.log; console.error = console.log;

const t0 = nowUs();
const game: any = Game3.new();
game.load({});
closeRead();
print(`[load] Game3.load ${((nowUs() - t0) / 1000).toFixed(0)} ms, ${reads.length} reads, heap ${(memUsage()[0] / 1048576).toFixed(1)} MB; field ${W3D ? "3D (world)" : "VIEW 2D"}`);
game._handleBootAction({ action: "new_game", name: "RED", rivalName: "BLUE", gender: 0, start: { map: "FR_PALLET_TOWN", x: 6, y: 8, facing: "down" } });

let view: WorldView | undefined, field: Game3World | undefined;
if (W3D) {
  const ops = { mapShow() {}, mapHide() {}, cam() {}, pitch() {}, tint() {}, flatWorld() {}, g3Ents() {}, strips() {} };
  view = new WorldView(ops, parseWorldJson(readFile("world.json")));
  field = new Game3World(view);
}

const bench = new BenchLoad(game, () => `heap ${(memUsage()[0] / 1048576).toFixed(1)} MB`, typeof QJS_PART === "string" ? QJS_PART : "");
(globalThis as { __loadBench?: BenchLoad }).__loadBench = bench; // tools/gen3/load_shots.ts
// the bench's probe sees each frame's draw list (the stale party icon check)
{
  const host = getHost() as { draw(list: Float32Array): void };
  const draw0 = host.draw.bind(host);
  bench.probeAlways = true;
  host.draw = (list: Float32Array): void => { bench.probeFrame(list); draw0(list); };
}
let tick = 0;
try {
  startSeg("(start)");
  while (!bench.done && f < MAX) {
    f++;
    if (SPIKE && hasProf) profFrameBegin!();
    const ta = nowUs();
    (Input as any).hostButtons(bench.at(++tick, game));
    game.update(1 / 60);
    (bench as any).afterUpdate?.();
    const tb = nowUs();
    if (field) field.begin(game);
    G.beginFrame();
    game.draw();
    G.endFrame();
    if (field && view) view.emit(field.state(game));
    const tc = nowUs();
    if (SPIKE && hasProf) {
      const slow = (tc - ta) / 1000 > SPIKE;
      if (slow) spikes++;
      profFrameEnd!(slow);
    }
    (globalThis as { __perfFrame?: (f: number) => void }).__perfFrame?.(f); // tools/gen3/load_shots.ts
    const cur = seg as Seg | null; // (startSeg sets it from the console hook)
    if (cur) { cur.up.push((tb - ta) / 1000); cur.dr.push((tc - tb) / 1000); }
  }
  endSeg();
} catch (e) {
  endSeg();
  print(`[load] stopped at f${f}: ${(e as Error)?.stack ?? e}`);
}
print(`[stray] ${bench.strays} battle frames with a stray party picture (bench_load.ts probeFrame)`);
print("[load] summary (frame ms avg / p95 / max)");
for (const s of done) {
  const tot = s.up.map((u, i) => u + s.dr[i]!);
  print(`[load] ${s.name.padEnd(28)} ${String(s.up.length).padStart(5)}f  ${stats(tot)}`);
}
