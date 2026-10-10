// Port tooling: the VIEW 2D bench's walk (voxelmon/game/gen3/platform/
// bench_view2d.ts) on the desktop -- a new game placed on a map as main.ts's
// bench places it, then the bench's standing / walking / running phases,
// each frame drawn by the desktop rasteriser and hashed -- to check that a
// VIEW 2D speed-up leaves every picture as it was (run before and after,
// compare the files), and that a bench's walk really moves (the player's
// cell at each phase's end). Never shipped.
//   bun tools/gen3/view2d_check.ts <out.txt> <MAP:x:y> [walk] [shots f,f,..] [--max N]
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setHost } from "../../voxelmon/game/gen3/platform/host.ts";
import { DesktopHost } from "../../voxelmon/game/gen3/platform/desktop.ts";
import { G } from "../../voxelmon/game/gen3/platform/graphics.ts";
import { setSaveStore, memorySaveStore } from "../../voxelmon/game/gen3/platform/savefs.ts";
import { setAudio, silentAudio } from "../../voxelmon/game/gen3/platform/audio.ts";
import { encodePng } from "../../voxelmon/import/gen3/png.ts";

const argv = process.argv.slice(2);
const out = argv[0] ?? "/tmp/view2d_check.txt";
const [map, x, y] = (argv[1] ?? "FR_PALLET_TOWN:6:8").split(":");
const walk = argv[2] ?? "RRRLLL";
const shots = new Set((argv[3] ?? "").split(",").filter(Boolean).map(Number));
const maxAt = argv.indexOf("--max");
const MAX = maxAt >= 0 ? Number(argv[maxAt + 1]) : 1e9;
const SHOT_DIR = "/tmp/view2d_shots";
mkdirSync(SHOT_DIR, { recursive: true });

const host = new DesktopHost(join(homedir(), "gen3ref/frfull"));
setHost(host);
setSaveStore(memorySaveStore());
setAudio(silentAudio());

const { Game3 } = await import("../../voxelmon/game/gen3/core/Game3.ts");
const { Input } = await import("../../voxelmon/game/gen3/shared/core/Input.ts");
const { BenchView2d } = await import("../../voxelmon/game/gen3/platform/bench_view2d.ts");
const game: any = Game3.new();
game.load({});
game._handleBootAction({
  action: "new_game", name: "RED", rivalName: "BLUE", gender: 0,
  start: { map, x: Number(x ?? 0), y: Number(y ?? 0), facing: "down" },
});
const bench = new BenchView2d(`view2d:${walk}`);
const lines: string[] = [];
bench.log = (s) => { console.log(s); };
let tick = 0;
const t0 = performance.now();
while (!bench.done && tick < MAX) {
  tick++;
  (Input as any).hostButtons(bench.at(tick, game));
  game.update(1 / 60);
  G.beginFrame();
  game.draw();
  G.endFrame();
  const px = host.pixels();
  lines.push(`${tick} ${Bun.hash(px).toString(16)}`);
  if (shots.has(tick)) {
    const name = `${SHOT_DIR}/${map}_${tick}.png`;
    writeFileSync(name, encodePng(240, 160, px));
    console.log(`shot ${name}`);
  }
}
writeFileSync(out, lines.join("\n") + "\n");
console.log(`${lines.length} frames hashed -> ${out} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
