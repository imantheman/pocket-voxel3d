// Port tooling: the transitions bench (tools/gen3/qjs_load.ts, the device's
// PV_G3_BENCH_SCRIPT=load) drawn by the desktop rasteriser under Bun -- the
// original pixels -- with a PNG wherever the bench asks for a shot (its
// "stray" part: a few seconds into each fight) and the battle pixel checks
// (tools/gen3/battle_pixels.ts) on every battle frame:
//   bun tools/gen3/load_shots.ts [part=stray] [outdir=/tmp/ldshots] [--root DIR]
// Never shipped.
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { DesktopHost } from "../../voxelmon/game/gen3/platform/desktop.ts";
import { encodePng } from "../../voxelmon/import/gen3/png.ts";
import { checkBattlePixels } from "./battle_pixels.ts";

const argv = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const opt = (k: string): string | undefined => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
const part = argv[0] ?? "stray";
const out = argv[1] ?? "/tmp/ldshots";
mkdirSync(out, { recursive: true });
const root = opt("--root") ?? join(homedir(), "gen3ref/frfull");
const host = new DesktopHost(root);
const g = globalThis as Record<string, unknown>;
// (qjs_load.ts takes console.log over for the bench's marks)
const log = console.log.bind(console);
g.__perfHost = host;
g.print = (s: string): void => { if (/^\[(load\] ===|mark|stray)/.test(s) || s.includes("g3 stray")) log(s); };
g.nowUs = (): number => performance.now() * 1000;
g.readFile = (p: string): string | undefined => host.read(p);
g.memUsage = (): [number, number] => [0, 0];
g.QJS_PROF_N = 0;
g.QJS_WORLD3D = 1;
g.QJS_PART = part;
let want = false, n = 0, bad = 0;
const boxStr = host.read("data/generated/gba/pokemon/battle/healthbox_player.rgba");
const box = boxStr ? Uint8Array.from(boxStr, (c) => c.charCodeAt(0)) : undefined;
g.__perfFrame = (f: number): void => {
  const b = g.__loadBench as { shot?: () => void; inBattleNow?: () => boolean } | undefined;
  if (b && !b.shot) b.shot = (): void => { want = true; };
  const b2 = g.__loadBench as { inBattle?: () => boolean } | undefined;
  if (!want && !(b2?.inBattle?.() ?? false)) return;
  const px = host.pixels();
  const r = checkBattlePixels(px, box);
  if (r && r.problems.length) { if (bad++ < 10) log(`[pixels] f${f}: ${r.problems.join("; ")}`); }
  if (want) {
    want = false;
    const name = `${out}/shot${n++}_f${f}.png`;
    writeFileSync(name, encodePng(240, 160, px));
    log(`[shot] ${name}${r ? ` (${r.summary})` : ""}`);
    if (process.argv.includes("--oam")) {
      const pool = (g.__oam as any)?._sprites as any[] | undefined;
      for (let i = 0; pool && i < pool.length; i++) {
        const s = pool[i];
        if (s?.inUse) log(`  oam ${i}: at ${s.x},${s.y} (+${s.x2},${s.y2}) ${s.image ? `image ${s.image.id}` : "no image"} cb ${s.callback?.name} layer ${s.layer} inv ${s.invisible} clip ${s.clip ? JSON.stringify(s.clip) : "-"} pri ${s.oam?.priority}`);
      }
      // the frame's quads of 32x32 or less left of x 40, by target
      const l = lastList;
      for (let i = 0, target = 0; l && i < l.length;) {
        const op = l[i]!;
        if (op === 1) { target = l[i + 1]!; i += 2; } else if (op === 2) i += 5;
        else if (op === 3) i += 24;
        else if (op === 4) {
          const x0 = Math.min(l[i + 2]!, l[i + 4]!, l[i + 6]!, l[i + 8]!), y0 = Math.min(l[i + 3]!, l[i + 5]!, l[i + 7]!, l[i + 9]!);
          const x1 = Math.max(l[i + 2]!, l[i + 4]!, l[i + 6]!, l[i + 8]!), y1 = Math.max(l[i + 3]!, l[i + 5]!, l[i + 7]!, l[i + 9]!);
          if (x0 < 40 && x1 - x0 <= 32 && y1 - y0 <= 32 && y0 < 70) log(`  quad target ${target} tex ${l[i + 1]} ${x0},${y0} ${x1 - x0}x${y1 - y0}`);
          i += 18;
        } else if (op === 5) i += 6 + l[i + 1]! * 6;
        else if (op === 6) i += 13;
        else break;
      }
    }
  }
};
let lastList: Float32Array | undefined;
{
  // only battle frames (and a shot's) are drawn: the rasteriser is ~40 ms a
  // frame, and the field's frames are not what is checked
  const d0 = host.draw.bind(host);
  host.draw = (list: Float32Array): void => {
    const b = g.__loadBench as { inBattle?: () => boolean } | undefined;
    if (!want && !(b?.inBattle?.() ?? false) && !process.argv.includes("--all")) return;
    lastList = list.slice();
    d0(list);
  };
}
g.__oam = (await import("../../voxelmon/game/gen3/core/oam.ts")).Oam;
await import("./qjs_load.ts");
log(`[pixels] ${bad} battle frames failed the checks`);
