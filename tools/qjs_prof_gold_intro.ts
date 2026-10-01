// Where Gold's intro and title go under QuickJS: game.draw(lcd) + lcd.end()
// each shown frame, with the screen on top, the Gold LCD, its drawing layer
// (platform/screen.ts) and the tile sheets wrapped and timed inclusively.
// Bundle and run in tools/qjs_gold_harness.c with PROF=1
// (cc_qjs_prof_intro.sh). Read the totals as a ranking. Never shipped.
import { native } from "../voxelmon/game/quickjs-host.ts";
import { readGen2Container } from "../voxelmon/game/gen2/platform/container.ts";
import { setGen2Source, loadGenerated } from "../voxelmon/game/gen2/platform/data.ts";
import { seed } from "../voxelmon/game/gen2/platform/rng.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";
import { Lcd } from "../voxelmon/game/gen2/platform/lcd.ts";
import G, { setLcd } from "../voxelmon/game/gen2/platform/screen.ts";
import { TileSheet } from "../voxelmon/game/gen2/ui/TileSheet.ts";
import { Chrome } from "../voxelmon/game/gen2/ui/Chrome.ts";
import { Scenes } from "../voxelmon/game/gen2/ui/GoldSilverIntro.ts";

const now = (globalThis as unknown as { voxel: { now: () => number } }).voxel.now;
setGen2Source(readGen2Container(native.gamedata()));
seed(17);
const scene = loadGenerated<{ atlas?: { lcd?: { firstPage: number; counts: number[] } } }>("scene");
const nop = (): void => {};
const lcd = new Lcd({ lcdCells: nop, lcdObjs: nop, lcdPals: nop, lcdRegs: nop, lcdLines: nop, lcdShow: nop, lcdBank: nop, lcdReset: nop, lcdUnder: nop, lcdUnderRow: nop, lcdUnderAt: nop, lcdAlias: nop, lcdCellsBin: nop, lcdObjsBin: nop, lcdLinesBin: nop } as never);
const pages = scene?.atlas?.lcd;
if (pages) lcd.banks(pages.counts.map((count, k) => ({ base: k * 1024, page: pages.firstPage + k, count })));
const game: any = Game2.new();
game.load();

const drawStats: Record<string, { us: number; n: number }> = {};
const stepStats: Record<string, { us: number; n: number }> = {};
let stats = drawStats;
let on = false;
const done = new Set<any>();
function wrap(owner: any, label: string): void {
  if (!owner || done.has(owner)) return;
  done.add(owner);
  for (const name of Object.getOwnPropertyNames(owner)) {
    if (name === "constructor") continue;
    const d = Object.getOwnPropertyDescriptor(owner, name);
    if (!d || typeof d.value !== "function" || d.get || d.set) continue;
    const orig = d.value;
    const key = `${label}.${name}`;
    try {
      owner[name] = function (this: unknown, ...args: unknown[]) {
        if (!on) return orig.apply(this, args);
        const a = now();
        try {
          return orig.apply(this, args);
        } finally {
          const s = (stats[key] ??= { us: 0, n: 0 });
          s.us += now() - a;
          s.n++;
        }
      };
    } catch { /* frozen */ }
  }
}
// NOWRAP=1 at bundle time: nothing wrapped, only draw and lcd.end timed
declare const NOWRAP: boolean;
const wrapping = typeof NOWRAP === "undefined" || !NOWRAP;
if (wrapping) {
  wrap(Lcd.prototype, "Lcd");
  wrap(G, "G");
  wrap(TileSheet.prototype, "TileSheet");
  wrap(Chrome, "Chrome");
  wrap(Scenes, "Scenes");
}
let drawUs = 0;
let stepUs = 0;

let f = 0;
let us = 0;
let n = 0;
let lastTop = "";
(globalThis as any).frame = (): void => {
  f++;
  stats = stepStats;
  on = true;
  const s0 = now();
  game.frame(0);
  stepUs += now() - s0;
  on = false;
  stats = drawStats;
  if ((f & 1) !== 0) return;
  const top = game.stack.top();
  // the intro reported scene by scene (its scenes differ a lot)
  const name = (top?.screenId ?? "-") + (top?.screenId === "Gen2GoldSilverIntro" ? `:${top.scene}` : "");
  if (top && wrapping) {
    wrap(Object.getPrototypeOf(top), `top:${top.screenId}`);
    if (top.anims) {
      wrap(Object.getPrototypeOf(top.anims), "Anims");
      wrap(top.anims, "Anims");
    }
  }
  if (name !== lastTop) {
    // a new screen: report the last one's totals
    if (n > 0) {
      console.log(`[intro] ${lastTop}: ${n} composes, ${(us / n).toFixed(1)} us/compose (draw ${(drawUs / n).toFixed(1)}, lcd.end ${((us - drawUs) / n).toFixed(1)})${wrapping ? " (wrapped)" : ""}`);
      const rows = Object.entries(drawStats).sort((x, y) => y[1].us - x[1].us).slice(0, 14);
      for (const [k, s] of rows) console.log(`[intro]   ${(s.us / n).toFixed(1).padStart(8)} us  ${(s.n / n).toFixed(1).padStart(7)} calls  ${k}`);
      const P = (globalThis as any).lcdProf;
      if (P && P.n) console.log(`[intro]  lcd.end: rows ${(P.rows / P.n).toFixed(1)} pals ${(P.pals / P.n).toFixed(1)} objs ${(P.objs / P.n).toFixed(1)} regs+lines ${(P.lines / P.n).toFixed(1)}`);
      (globalThis as any).lcdProf = { rows: 0, pals: 0, objs: 0, lines: 0, n: 0 };
      console.log(`[intro]  steps: ${(stepUs / (2 * n)).toFixed(1)} us/step`);
      const srows = Object.entries(stepStats).sort((x, y) => y[1].us - x[1].us).slice(0, 14);
      for (const [k, s] of srows) console.log(`[intro]   ${(s.us / (2 * n)).toFixed(1).padStart(8)} us  ${(s.n / (2 * n)).toFixed(1).padStart(7)} calls/step  ${k}`);
    }
    for (const k of Object.keys(drawStats)) delete drawStats[k];
    for (const k of Object.keys(stepStats)) delete stepStats[k];
    stepUs = 0;
    us = 0;
    drawUs = 0;
    n = 0;
    lastTop = name;
  }
  setLcd(lcd);
  on = true;
  const a = now();
  game.draw(lcd);
  drawUs += now() - a;
  lcd.end();
  us += now() - a;
  n++;
  on = false;
};
