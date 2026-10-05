// Port tooling: the frames of tools/gen3/qjs_perf.ts's playthrough, drawn by
// the desktop rasteriser under Bun, one hash per frame -- to check that a
// speed-up leaves every picture as it was. Run it twice and compare:
//   bun tools/gen3/perf_check.ts <out.txt> [--no-memo] [--3d] [--toggle2d f,f,..] [--max N] [--root DIR] [--check-fill]
// (--no-memo: graphics.ts's draw memos off, the plain path.) Never shipped.
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { DesktopHost } from "../../voxelmon/game/gen3/platform/desktop.ts";
import { G } from "../../voxelmon/game/gen3/platform/graphics.ts";

const argv = process.argv.slice(2);
const out = argv[0] ?? "/tmp/perf_check.txt";
const opt = (k: string): string | undefined => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const root = opt("--root") ?? join(homedir(), "gen3ref/frfull");
const host = new DesktopHost(root);
const g = globalThis as Record<string, unknown>;
g.__perfHost = host;
g.print = (s: string): void => { if (s.startsWith("[perf]") && !s.includes("    ")) console.log(s); };
g.nowUs = (): number => performance.now() * 1000;
g.readFile = (p: string): string | undefined => host.read(p);
g.memUsage = (): [number, number] => [0, 0];
g.QJS_PROF_N = 0;
if (argv.includes("--3d")) g.QJS_WORLD3D = 1;
if (opt("--max")) g.QJS_MAX = Number(opt("--max"));
if (argv.includes("--no-memo")) G.setMemo(false);
// --toggle2d f1,f2,...: VIEW 2D on/off at those frames (with --3d: the world, then the 2D field)
if (opt("--toggle2d")) g.__perfToggle2d = opt("--toggle2d")!.split(",").map(Number);
const lines: string[] = [];
g.__perfFrame = (f: number): void => {
  lines.push(`${f} ${Bun.hash(host.pixels()).toString(16)}`);
};
if (argv.includes("--check-fill")) {
  // quest_log_recorder's fillTiles (memoised) against the Lua's plain loop
  const { R } = await import("../../voxelmon/game/gen3/core/quest_log_recorder.ts");
  const { Map: MapM } = await import("../../voxelmon/game/gen3/core/map.ts") as any;
  const { tostring } = await import("../../voxelmon/import/gen3/lua.ts");
  const orig = R.fillTiles;
  let calls = 0, bad = 0;
  (R as any).fillTiles = function (game: any, session: any, frame: any, out: any): any {
    const r = orig.call(R, game, session, frame, out);
    const def = game && game.data && game.data.maps && game.data.maps[session.map];
    if (def && def.midLayout) {
      calls++;
      const cx = Math.floor(frame.x / 16), cy = Math.floor(frame.y / 16);
      for (let y = cy - 6; y <= cy + 6; y++) for (let x = cx - 8; x <= cx + 8; x++) {
        const [mid, pair] = MapM.worldMidAt(x, y, def);
        const t = out[tostring(x) + "," + tostring(y)];
        if (!t || t[1] !== mid || t[2] !== pair) { if (bad++ < 10) console.log(`fillTiles MISMATCH at ${x},${y} on ${session.map}`); }
      }
    }
    return r;
  };
  process.on("exit", () => console.log(`fillTiles check: ${calls} calls, ${bad} mismatched cells`));
}
await import("./qjs_perf.ts");
writeFileSync(out, lines.join("\n") + "\n");
console.log(`${lines.length} frames hashed -> ${out}`);
