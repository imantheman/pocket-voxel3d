// Port tooling: what Game3.load reads, and what each read costs. Wraps the
// desktop host's read so every cache file the load touches is listed with its
// size and the time until the next read (the parse and use of that file),
// then the heap after load. Never shipped.
//   bun tools/gen3/load_probe.ts [cache-root=~/gen3ref/frfull] [frames=0] [script]
import { homedir } from "node:os";
import { join } from "node:path";
import { setHost } from "../../voxelmon/game/gen3/platform/host.ts";
import { DesktopHost } from "../../voxelmon/game/gen3/platform/desktop.ts";
import { G } from "../../voxelmon/game/gen3/platform/graphics.ts";
import { setSaveStore, memorySaveStore } from "../../voxelmon/game/gen3/platform/savefs.ts";
import { setAudio, silentAudio } from "../../voxelmon/game/gen3/platform/audio.ts";

const ROOT = process.argv[2] || join(homedir(), "gen3ref/frfull");
const FRAMES = Number(process.argv[3] ?? 0);
const SCRIPT = process.argv[4] ?? "";
const host = new DesktopHost(ROOT);
const reads: { path: string; size: number; t: number; ms: number }[] = [];
let last: (typeof reads)[number] | undefined;
const t0 = performance.now();
const rawRead = host.read.bind(host);
host.read = (p: string) => {
  const now = performance.now();
  if (last) last.ms = now - last.t;
  const s = rawRead(p);
  last = { path: p, size: s?.length ?? -1, t: performance.now(), ms: 0 };
  reads.push(last);
  return s;
};
setHost(host);
setSaveStore(memorySaveStore());
setAudio(silentAudio());
const { Game3 } = await import("../../voxelmon/game/gen3/core/Game3.ts");
const { Input } = await import("../../voxelmon/game/gen3/shared/core/Input.ts");
const tImp = performance.now();
const game: any = Game3.new();
game.load({});
const tLoad = performance.now();
if (last) last.ms = tLoad - last.t;
const loadReads = reads.length;
console.log(`import ${(tImp - t0).toFixed(0)} ms, load ${(tLoad - tImp).toFixed(0)} ms, phase=${game.phase}, ${loadReads} reads, ${(reads.reduce((a, r) => a + Math.max(0, r.size), 0) / 1e6).toFixed(1)} MB`);
const BIT: Record<string, number> = { UP: 0, DOWN: 1, LEFT: 2, RIGHT: 3, A: 4, B: 5, START: 6, SELECT: 7, L: 8, R: 9, X: 10, Y: 11 };
const presses = new Map<number, number>();
for (const part of SCRIPT.split(",").filter(Boolean)) {
  const [f, keys] = part.split(":");
  let m = 0;
  for (const k of keys!.split("+")) m |= 1 << BIT[k.toUpperCase()]!;
  presses.set(Number(f), m);
}
let held = 0;
for (let f = 1; f <= FRAMES; f++) {
  const pr = presses.get(f);
  if (pr !== undefined) held = pr; else if (presses.has(f - 6)) held = 0;
  (Input as any).hostButtons(held);
  game.update(1 / 60);
  G.beginFrame(); game.draw(); G.endFrame();
}
if (last && FRAMES) last.ms = performance.now() - last.t;
if (FRAMES) console.log(`after ${FRAMES} frames: phase=${game.phase}, ${reads.length - loadReads} more reads`);
const mem = process.memoryUsage();
console.log(`rss ${(mem.rss / 1e6).toFixed(0)} MB heapUsed ${(mem.heapUsed / 1e6).toFixed(0)} MB`);
const sorted = [...reads].sort((a, b) => b.ms - a.ms);
console.log("--- slowest (ms after read, size, path)");
for (const r of sorted.slice(0, 40)) console.log(`${r.ms.toFixed(1).padStart(8)} ${String(r.size).padStart(9)} ${r.path}`);
console.log("--- biggest");
for (const r of [...reads].sort((a, b) => b.size - a.size).slice(0, 40)) console.log(`${r.ms.toFixed(1).padStart(8)} ${String(r.size).padStart(9)} ${r.path}`);
if (process.env.PROBE_ALL) for (const r of reads) console.log(`ALL ${r.ms.toFixed(1)} ${r.size} ${r.path}`);
