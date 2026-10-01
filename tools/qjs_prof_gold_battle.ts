// Where a Gold wild battle goes under QuickJS: the step, the Gold screen's
// compose (game.draw + lcd.end) and the 3D stage's emit (WorldView.emit,
// which hands a battle to BattleStage), each shown frame, with the screen on
// top, BattleStage, the drawing layer and the tile sheets wrapped and timed
// inclusively. Bundle and run in tools/qjs_gold_harness.c with PROF=1
// (cc_qjs_prof_battle.sh); NOWRAP=1 times the phases alone. Never shipped.
import { native } from "../voxelmon/game/quickjs-host.ts";
import { readGen2Container } from "../voxelmon/game/gen2/platform/container.ts";
import { setGen2Source, loadGenerated } from "../voxelmon/game/gen2/platform/data.ts";
import { seed } from "../voxelmon/game/gen2/platform/rng.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";
import { Lcd } from "../voxelmon/game/gen2/platform/lcd.ts";
import G, { setLcd } from "../voxelmon/game/gen2/platform/screen.ts";
import { TileSheet } from "../voxelmon/game/gen2/ui/TileSheet.ts";
import { Chrome } from "../voxelmon/game/gen2/ui/Chrome.ts";
import { WorldView } from "../voxelmon/game/gen2/platform/worldview.ts";
import { BattleStage } from "../voxelmon/game/gen2/platform/battlestage.ts";
import { Mon } from "../voxelmon/game/gen2/battle/Mon.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { Save } from "../voxelmon/game/gen2/core/Save.ts";
import { HpBar } from "../voxelmon/game/gen2/battle/HpBar.ts";
import { BattleHud } from "../voxelmon/game/gen2/ui/BattleHud.ts";
import { Font } from "../voxelmon/game/gen2/shared/render/Font.ts";
import { Strings } from "../voxelmon/game/gen2/shared/core/Strings.ts";
import { GbcPalette } from "../voxelmon/game/gen2/shared/render/GbcPalette.ts";
import { setSaveIo } from "../voxelmon/game/gen2/platform/saveio.ts";

const now = (globalThis as unknown as { voxel: { now: () => number } }).voxel.now;
setGen2Source(readGen2Container(native.gamedata()));
seed(17);
const scene = loadGenerated<any>("scene");
const nop = (): void => {};
const lcd = new Lcd({ lcdCells: nop, lcdObjs: nop, lcdPals: nop, lcdRegs: nop, lcdLines: nop, lcdShow: nop, lcdBank: nop, lcdReset: nop, lcdUnder: nop, lcdUnderRow: nop, lcdUnderAt: nop, lcdAlias: nop, lcdCellsBin: nop, lcdObjsBin: nop, lcdLinesBin: nop } as never);
const pages = scene?.atlas?.lcd;
if (pages) lcd.banks(pages.counts.map((count: number, k: number) => ({ base: k * 1024, page: pages.firstPage + k, count })));
// every scene op a no-op: only the guest's own work is timed
const host: any = new Proxy({}, { get: () => nop });
const view = new WorldView(host, scene ?? loadGenerated<any>("walker"));
// the card's files through the harness (GOLD_SAVE / GOLD_OPTIONS), as main.ts reads them
const nat = native as any;
setSaveIo({
  read: () => nat.saveData?.() ?? undefined,
  write: () => true,
  readOptions: () => nat.optionsData?.() ?? undefined,
  writeOptions: () => true,
});
const game: any = Game2.new();
// the card's save when the harness has one (GOLD_SAVE: what the Citra bench
// continues -- a real party, so a real battle screen), else a bare world
const [save] = Save.load();
console.log(`[battle] save: ${save ? "the card's" : "none, a bare world"}`);
if (save) {
  game.load();
  game.continueGame(save);
} else {
  game.load({ startWorld: true });
  game.world.setMap("ROUTE_29", 27, 3, "down");
}
game.options.battleView = "3d";

const stats: Record<string, { us: number; n: number }> = {};
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
declare const NOWRAP: boolean;
// TOPONLY=1: only the screen on top wrapped (less of the wrappers' own cost
// in the small helpers' totals)
declare const TOPONLY: boolean;
const wrapping = typeof NOWRAP === "undefined" || !NOWRAP;
if (wrapping && (typeof TOPONLY === "undefined" || !TOPONLY)) {
  wrap(Lcd.prototype, "Lcd");
  wrap(G, "G");
  wrap(TileSheet.prototype, "TileSheet");
  wrap(Chrome, "Chrome");
  wrap(BattleStage.prototype, "BattleStage");
  wrap(WorldView.prototype, "WorldView");
  wrap(HpBar, "HpBar");
  wrap(BattleHud.prototype, "BattleHud");
  wrap(Font, "Font");
  wrap(Strings, "Strings");
  wrap(GbcPalette, "GbcPalette");
}

let f = 0;
let n = 0;
const t = { step: 0, draw: 0, end: 0, view: 0 };
let lastTop = "";
function report(): void {
  if (n === 0) return;
  console.log(`[battle] ${lastTop}: ${n} frames, us/frame: steps ${(t.step / n).toFixed(1)} draw ${(t.draw / n).toFixed(1)} lcd.end ${(t.end / n).toFixed(1)} view ${(t.view / n).toFixed(1)}${wrapping ? " (wrapped)" : ""}`);
  const rows = Object.entries(stats).sort((x, y) => y[1].us - x[1].us).slice(0, 50);
  for (const [k, s] of rows) console.log(`[battle]   ${(s.us / n).toFixed(1).padStart(8)} us  ${(s.n / n).toFixed(1).padStart(7)} calls  ${k}`);
}
(globalThis as any).frame = (): void => {
  f++;
  if (f === 30) game.world.startBattle({ wild: Mon.new(game.data, "PIDGEY", 5, {}) });
  on = f > 30;
  const s0 = now();
  game.frame(f > 30 && f % 20 === 0 ? VOX_BTN.a : 0);
  t.step += now() - s0;
  if ((f & 1) !== 0) {
    on = false;
    return;
  }
  const top = game.stack.top();
  const name = top?.screenId ?? "world";
  if (top && wrapping) wrap(Object.getPrototypeOf(top), `top:${name}`);
  if (name !== lastTop) {
    if (f > 30) report();
    for (const k of Object.keys(stats)) delete stats[k];
    t.step = t.draw = t.end = t.view = 0;
    n = 0;
    lastTop = name;
  }
  setLcd(lcd);
  const a = now();
  game.draw(lcd);
  const b = now();
  lcd.end();
  const c = now();
  view.emit(game);
  const d = now();
  t.draw += b - a;
  t.end += c - b;
  t.view += d - c;
  n++;
  on = false;
  if (n % 600 === 0) report();
};
