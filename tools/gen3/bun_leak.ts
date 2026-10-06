// Port tooling: the device bench's long session (platform/bench_leak.ts)
// under Bun on the desktop host, for WHERE the heap grows: between two of
// the session's steps (its log lines, counted from 0) a heap snapshot each,
// and the growth by the property path holding it (heap_diff.ts).
//   bun tools/gen3/bun_leak.ts <a> <b> [--depth N] [--top N] [--root DIR]
// The field is drawn as VIEW 2D (no world here). Never shipped.
import { homedir } from "node:os";
import { join } from "node:path";
import { DesktopHost } from "../../voxelmon/game/gen3/platform/desktop.ts";
import { heapDiff } from "./heap_diff.ts";

const argv = process.argv.slice(2);
const opt = (k: string): string | undefined => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const A = Number(argv[0] ?? 2), B = Number(argv[1] ?? 20);
const host = new DesktopHost(opt("--root") ?? join(homedir(), "leakcard"));
(host as any).draw = function (): void { this.frames++; };
const g = globalThis as Record<string, unknown>;
g.__perfHost = host;
await import("./qjs_boot_host.ts");
const { G } = await import("../../voxelmon/game/gen3/platform/graphics.ts");
const { Game3 } = await import("../../voxelmon/game/gen3/core/Game3.ts");
const { Input } = await import("../../voxelmon/game/gen3/shared/core/Input.ts");
const { BenchLeak } = await import("../../voxelmon/game/gen3/platform/bench_leak.ts");
const jsc = await import("bun:jsc");

const game: any = Game3.new();
game.load({});
game._handleBootAction({ action: "new_game", name: "RED", rivalName: "BLUE", gender: 0, start: { map: "FR_PALLET_TOWN", x: 6, y: 8, facing: "down" } });
let step = 0;
let snapA: any;
const mb = (b: number): string => (b / 1048576).toFixed(1);
const bench = new BenchLeak(game, () => {
  Bun.gc(true);
  const hs = jsc.heapStats();
  const s = step++;
  if (s === A) snapA = Bun.generateHeapSnapshot();
  if (s === B && snapA) {
    for (const l of heapDiff(snapA, Bun.generateHeapSnapshot() as any, Number(opt("--top") ?? 50), Number(opt("--depth") ?? 3))) console.log(l);
    snapA = undefined;
  }
  return `step ${s}: bun heap ${mb(hs.heapSize)} MB (${hs.objectCount} objects)`;
});
let tick = 0;
while (!bench.done && tick < 300000) {
  tick++;
  (Input as any).hostButtons(bench.at(tick, game));
  game.update(1 / 60);
  G.beginFrame();
  game.draw();
  G.endFrame();
}
console.log(`${tick} ticks`);
