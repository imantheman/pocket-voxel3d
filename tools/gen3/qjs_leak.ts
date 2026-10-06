// Port tooling: the device bench's long session (platform/bench_leak.ts)
// under the 3DS's QuickJS on the desktop (tools/gen3/qjs_run.c), for the
// QuickJS heap: at each step of the session its line gives the heap in use
// as it stands and after a full cycle collection (what is garbage the
// collector has not reached yet, and what is held). The host keeps no
// textures (qjs_boot_host.ts), so this is the guest's own heap alone.
//   bun build tools/gen3/qjs_leak.ts --outfile /tmp/qjs_leak.js --target browser --minify-syntax
//   qjs_run /tmp/qjs_leak.js <cache root>
// Never shipped.
import { closeRead } from "./qjs_boot_host.ts";
import { G } from "../../voxelmon/game/gen3/platform/graphics.ts";
import { Game3 } from "../../voxelmon/game/gen3/core/Game3.ts";
import { Input } from "../../voxelmon/game/gen3/shared/core/Input.ts";
import { BenchLeak } from "../../voxelmon/game/gen3/platform/bench_leak.ts";

declare const print: (s: string) => void;
declare const nowUs: () => number;
declare const memUsage: () => [number, number];
declare const gc: () => void;
declare const gcHold: (hold: boolean) => void;

const mb = (b: number): string => (b / 1048576).toFixed(1);
const t0 = nowUs();
gcHold(true);
const game: any = Game3.new();
game.load({});
closeRead();
gcHold(false);
print(`[qleak] load ${((nowUs() - t0) / 1000).toFixed(0)} ms, heap ${mb(memUsage()[0])} MB`);
game._handleBootAction({ action: "new_game", name: "RED", rivalName: "BLUE", gender: 0, start: { map: "FR_PALLET_TOWN", x: 6, y: 8, facing: "down" } });

declare const memDetail: undefined | (() => Record<string, number>);
let lastDetail: Record<string, number> | undefined;
const bench = new BenchLeak(game, () => {
  const before = memUsage()[0];
  const tg = nowUs();
  gc();
  const after = memUsage()[0];
  let detail = "";
  if (typeof memDetail === "function") {
    // what grew since the last step, by kind
    const d = memDetail();
    if (lastDetail) {
      const kb = (k: string): string => `${k} ${(((d[k] ?? 0) - (lastDetail![k] ?? 0)) / 1024).toFixed(0)}`;
      detail = ` | grew KB: ${["str", "obj", "prop", "shape", "func", "code", "binary"].map(kb).join(" ")}; ` +
        `objects ${d.objN! - lastDetail.objN!}, arrays ${d.arrayN! - lastDetail.arrayN!}, buffers ${d.binaryN! - lastDetail.binaryN!}`;
    }
    lastDetail = d;
  }
  return `js heap ${mb(before)} MB, ${mb(after)} MB after a collection (${((nowUs() - tg) / 1000).toFixed(0)} ms)${detail}`;
});
let tick = 0;
try {
  while (!bench.done && tick < 200000) {
    tick++;
    (Input as any).hostButtons(bench.at(tick, game));
    game.update(1 / 60);
    G.beginFrame();
    game.draw();
    G.endFrame();
  }
} catch (e) {
  print(`[qleak] stopped at tick ${tick}: ${(e as Error)?.stack ?? e}`);
}
print(`[qleak] ${tick} ticks, ${((nowUs() - t0) / 1000).toFixed(0)} ms`);
