// Port tooling: the long session's frames (platform/bench_leak.ts, the tour
// of 75 map changes and 16 battles) drawn by the desktop rasteriser under
// Bun, one hash per shown frame -- to check that a memory change (a cache
// bounded, a picture let go and made again) leaves every picture as it
// was. Run it on two trees and compare the files:
//   bun tools/gen3/leak_check.ts <out.txt> [--tight] [--every N] [--root DIR]
// --tight: the host says the app heap has nothing free, so every cache that
// sizes itself from it (platform/membudget.ts) keeps its least. The field is
// drawn as VIEW 2D (no world here). Never shipped.
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { DesktopHost } from "../../voxelmon/game/gen3/platform/desktop.ts";

const argv = process.argv.slice(2);
const out = argv[0] ?? "/tmp/leak_check.txt";
const opt = (k: string): string | undefined => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const every = Number(opt("--every") ?? 1);
const host = new DesktopHost(opt("--root") ?? join(homedir(), "leakcard"));
if (argv.includes("--tight")) (host as unknown as { heapFree(): number }).heapFree = (): number => 0;
const g = globalThis as Record<string, unknown>;
g.__perfHost = host;
await import("./qjs_boot_host.ts");
const { G } = await import("../../voxelmon/game/gen3/platform/graphics.ts");
const { Game3 } = await import("../../voxelmon/game/gen3/core/Game3.ts");
const { Input } = await import("../../voxelmon/game/gen3/shared/core/Input.ts");
const { BenchLeak } = await import("../../voxelmon/game/gen3/platform/bench_leak.ts");

/* eslint-disable @typescript-eslint/no-explicit-any */
const game: any = Game3.new();
game.load({});
game._handleBootAction({ action: "new_game", name: "RED", rivalName: "BLUE", gender: 0, start: { map: "FR_PALLET_TOWN", x: 6, y: 8, facing: "down" } });
const bench = new BenchLeak(game, () => "");
const lines: string[] = [];
let tick = 0;
while (!bench.done && tick < 300000) {
  tick++;
  (Input as any).hostButtons(bench.at(tick, game));
  game.update(1 / 60);
  G.beginFrame();
  game.draw();
  G.endFrame();
  if (tick % every === 0) lines.push(`${tick} ${Bun.hash(host.pixels()).toString(16)}`);
}
writeFileSync(out, lines.join("\n") + "\n");
console.log(`${tick} ticks, ${lines.length} frames hashed -> ${out}`);
