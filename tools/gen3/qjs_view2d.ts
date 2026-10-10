// Port tooling: the VIEW 2D bench (voxelmon/game/gen3/platform/bench_view2d.ts)
// under the 3DS's own QuickJS on the desktop, with the sampling profiler
// (tools/gen3/qjs_prof.c): a new game placed on a map as main.ts's bench
// places it, then the bench's phases, each with its update / draw ms and a
// profile of its frames (or, with QJS_SPIKE_MS, of its frames over that).
//   bash cc_g3_qjsview2d.sh <MAP:x:y> <walk> [spike ms] [prof rows]
// Never shipped.
import { closeRead } from "./qjs_boot_host.ts";
import { G } from "../../voxelmon/game/gen3/platform/graphics.ts";
import { Game3 } from "../../voxelmon/game/gen3/core/Game3.ts";
import { Input } from "../../voxelmon/game/gen3/shared/core/Input.ts";
import { BenchView2d } from "../../voxelmon/game/gen3/platform/bench_view2d.ts";
import { Display } from "../../voxelmon/game/gen3/core/display.ts";
import { zoom2dSpec } from "../../voxelmon/game/gen3/platform/zoom2d.ts";

declare const print: (s: string) => void;
declare const nowUs: () => number;
declare const profReset: undefined | (() => void);
declare const profDump: undefined | ((n: number, title: string) => void);
declare const profFrameBegin: undefined | (() => void);
declare const profFrameEnd: undefined | ((keep: boolean) => void);
declare const QJS_PROF_N: number;
declare const QJS_SPIKE_MS: number;
declare const QJS_PLACE: string;
declare const QJS_WALK: string;
/** "update" or "draw": profile (and spike-test) only that part of each frame. */
declare const QJS_PART: string;
const PART = typeof QJS_PART === "string" ? QJS_PART : "all";

const PROF_N = typeof QJS_PROF_N === "number" ? QJS_PROF_N : 30;
const SPIKE = typeof QJS_SPIKE_MS === "number" && QJS_SPIKE_MS > 0 ? QJS_SPIKE_MS : 0;
const hasProf = typeof profReset === "function";

const game: any = Game3.new();
game.load({});
closeRead();
const [map, x, y] = (typeof QJS_PLACE === "string" ? QJS_PLACE : "FR_PALLET_TOWN:6:8").split(":");
game._handleBootAction({ action: "new_game", name: "RED", rivalName: "BLUE", gender: 0, start: { map, x: Number(x), y: Number(y), facing: "down" } });

const bench = new BenchView2d(`view2d:${typeof QJS_WALK === "string" ? QJS_WALK : "RRRLLL"}`);
let phase = "";
let up: number[] = [], dr: number[] = [];
let spikes = 0;
function stats(a: number[]): string {
  if (!a.length) return "-";
  const s = [...a].sort((p, q) => p - q);
  let sum = 0;
  for (const v of a) sum += v;
  return `${(sum / a.length).toFixed(3)} / ${s[Math.floor(s.length * 0.95)]!.toFixed(3)} / ${s[s.length - 1]!.toFixed(3)}`;
}
function endPhase(): void {
  if (!phase) return;
  print(`[perf] === ${phase}: ${up.length} frames; update ms avg/p95/max ${stats(up)}   draw ${stats(dr)}`);
  // (the bench itself resets and dumps the profile a phase: bench_view2d.ts)
  if (SPIKE) print(`[perf]     (the profile below: only its ${spikes} frames over ${SPIKE} ms)`);
  up = []; dr = []; spikes = 0;
}
bench.log = (s) => print(s);
let tick = 0;
while (!bench.done) {
  tick++;
  const keys = bench.at(tick, game);
  if (bench.phaseName !== phase) { endPhase(); phase = bench.phaseName; }
  if (SPIKE && hasProf && PART !== "draw") profFrameBegin!();
  const ta = nowUs();
  (Input as any).hostButtons(keys);
  game.update(1 / 60);
  const tb = nowUs();
  if (SPIKE && hasProf && PART === "update") profFrameEnd!((tb - ta) / 1000 > SPIKE);
  if (SPIKE && hasProf && PART === "draw") profFrameBegin!();
  // (VIEW 2D's zoom, as platform/game3_world.ts begin sets it on the 3DS)
  (Display as any).zoom2d = zoom2dSpec(game.options);
  G.beginFrame();
  game.draw();
  G.endFrame();
  const tc = nowUs();
  if (SPIKE && hasProf && PART !== "update") {
    const slow = (PART === "draw" ? tc - tb : tc - ta) / 1000 > SPIKE;
    if (slow) spikes++;
    profFrameEnd!(slow);
  } else if (SPIKE && (tb - ta) / 1000 > SPIKE) spikes++;
  up.push((tb - ta) / 1000);
  dr.push((tc - tb) / 1000);
}
endPhase();
