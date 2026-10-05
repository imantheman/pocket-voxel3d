// Port tooling: Game3.new():load() under the 3DS's QuickJS on the desktop
// (bash cc_g3_qjsboot.sh), to measure the load: time, the QuickJS heap
// (in use and peak, from qjs_run.c's counting allocator) and, per cache read,
// the time until the next read and the heap then. QJS_LIMIT_MB caps the heap
// as a console would. Then FRAMES frames are pumped (title screen). Never shipped.
import { reads, closeRead } from "./qjs_boot_host.ts";
import { G } from "../../voxelmon/game/gen3/platform/graphics.ts";
import { Game3 } from "../../voxelmon/game/gen3/core/Game3.ts";
import { Input } from "../../voxelmon/game/gen3/shared/core/Input.ts";

declare const print: (s: string) => void;
declare const nowUs: () => number;
declare const memUsage: () => [number, number];
declare const memPeakReset: () => void;
declare const gc: () => void;
declare const gcHold: (on: boolean) => void;
declare const QJS_FRAMES: number;
declare const QJS_SCRIPT: string;
declare const QJS_GC_HOLD: number;

const MB = (n: number): string => (n / 1048576).toFixed(1);
const [use0] = memUsage();
gc();
const [use1] = memUsage();
print(`[boot] after module eval: heap ${MB(use0)} MB (${MB(use1)} after gc)`);
memPeakReset();
const t0 = nowUs();
const HOLD = typeof QJS_GC_HOLD === "number" && QJS_GC_HOLD > 0;
if (HOLD) gcHold(true);
const game: any = Game3.new();
let ok = true;
try {
  game.load({});
} catch (e) {
  ok = false;
  print(`[boot] load failed: ${(e as Error)?.stack ?? e}`);
}
closeRead();
if (HOLD) gcHold(false);
const tLoad = (nowUs() - t0) / 1000;
const [use2, peak2] = memUsage();
gc();
const [use3] = memUsage();
let total = 0;
for (const r of reads) total += Math.max(0, r.size);
print(`[boot] load ${tLoad.toFixed(0)} ms ok=${ok} phase=${game.phase}; heap ${MB(use2)} MB (${MB(use3)} after gc), peak ${MB(peak2)} MB; ${reads.length} reads, ${MB(total)} MB`);
const nLoad = reads.length;

const FRAMES = typeof QJS_FRAMES === "number" ? QJS_FRAMES : 0;
const BIT: Record<string, number> = { UP: 0, DOWN: 1, LEFT: 2, RIGHT: 3, A: 4, B: 5, START: 6, SELECT: 7, L: 8, R: 9, X: 10, Y: 11 };
const presses = new Map<number, number>();
for (const part of (typeof QJS_SCRIPT === "string" ? QJS_SCRIPT : "").split(",").filter(Boolean)) {
  const [f, keys] = part.split(":");
  let m = 0;
  for (const k of keys!.split("+")) m |= 1 << BIT[k.toUpperCase()]!;
  presses.set(Number(f), m);
}
if (ok && FRAMES > 0) {
  memPeakReset();
  let held = 0, worst = 0, sum = 0, win = 0;
  const tf = nowUs();
  for (let f = 1; f <= FRAMES; f++) {
    const pr = presses.get(f);
    if (pr !== undefined) held = pr; else if (presses.has(f - 6)) held = 0;
    const ta = nowUs();
    try {
      (Input as any).hostButtons(held);
      game.update(1 / 60);
      G.beginFrame(); game.draw(); G.endFrame();
    } catch (e) {
      print(`[boot] frame ${f} failed: ${(e as Error)?.stack ?? e}`);
      break;
    }
    const dt = (nowUs() - ta) / 1000;
    sum += dt; if (dt > worst) worst = dt;
    win += dt;
    if (f % 60 === 0) { print(`[boot] frame ${f}: phase=${game.phase} heap ${MB(memUsage()[0])} MB, ${(win / 60).toFixed(2)} ms/frame`); win = 0; }
  }
  closeRead();
  const [u4, p4] = memUsage();
  print(`[boot] ${FRAMES} frames in ${((nowUs() - tf) / 1000).toFixed(0)} ms (avg ${(sum / FRAMES).toFixed(2)}, worst ${worst.toFixed(1)} ms); phase=${game.phase}; heap ${MB(u4)} MB, peak ${MB(p4)}; ${reads.length - nLoad} more reads`);
}

const fmt = (r: (typeof reads)[number]): string =>
  `${r.ms.toFixed(0).padStart(7)} ms ${String(r.size).padStart(9)} B  heap ${MB(r.heapAfter).padStart(6)} peak ${MB(r.peak).padStart(6)}  ${r.path}`;
print("--- slowest");
for (const r of [...reads].sort((a, b) => b.ms - a.ms).slice(0, 30)) print(fmt(r));
print("--- heap growth by read (heap after minus heap before)");
const growth = reads.map((r, i) => ({ r, d: r.heapAfter - (i > 0 ? reads[i - 1]!.heapAfter : use1) }));
for (const g of growth.sort((a, b) => b.d - a.d).slice(0, 25)) print(`${MB(g.d).padStart(7)} MB  ${fmt(g.r)}`);
