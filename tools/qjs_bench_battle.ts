// A Gold battle under QuickJS (bundle this and run it in
// tools/qjs_gold_harness.c with PROF=1, via cc_qjs_battle.sh): Gold's dataset
// as gen2/main.ts loads it, then a wild battle on ROUTE_29 driven through
// FIGHT -> EMBER the way tests/voxel-gen2-ui-battle.test.ts does, with the
// update and the Gold screen's draw timed per battle phase.
import { native } from "../voxelmon/game/quickjs-host.ts";
import { readGen2Container } from "../voxelmon/game/gen2/platform/container.ts";
import { loadGenerated, setGen2Source } from "../voxelmon/game/gen2/platform/data.ts";
import { Lcd } from "../voxelmon/game/gen2/platform/lcd.ts";
import { resetDrawState, setLcd } from "../voxelmon/game/gen2/platform/screen.ts";
import { seed } from "../voxelmon/game/gen2/platform/rng.ts";
import { Input } from "../voxelmon/game/gen2/shared/core/Input.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";
import { Mon } from "../voxelmon/game/gen2/battle/Mon.ts";
import { Battle } from "../voxelmon/game/gen2/battle/Battle.ts";
import { Screens } from "../voxelmon/game/gen2/shared/ui/Screens.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";

const now = (globalThis as unknown as { voxel: { now: () => number } }).voxel.now;
setGen2Source(readGen2Container(native.gamedata()));
seed(0x29);
const scene = loadGenerated<{ atlas?: { lcd?: { firstPage: number; counts: number[] } } }>("scene");
const lcd = new Lcd({} as never);
const pages = scene?.atlas?.lcd;
if (pages) lcd.banks(pages.counts.map((count, k) => ({ base: k * 1024, page: pages.firstPage + k, count })));
lcd.shown = true;
setLcd(lcd);
const game: any = Game2.new();
try {
  game.load({ startWorld: false });
} catch {
  // the splash
}
game.stack.clear();
Input.reset();
const perfect = () => ({ attack: 15, defense: 15, speed: 15, special: 15 });

let state: any = null;
let done = true;
function newBattle(): void {
  seed(0x2929);
  const slot = game.data.gen2Encounters.grass.ROUTE_29.slots.DAY[0];
  const player: any = Mon.new(game.data, "CYNDAQUIL", 14, { dvs: perfect() });
  game.save.party = [player];
  const wild: any = Mon.new(game.data, slot.species, slot.level, { dvs: perfect() });
  const battle: any = Battle.new({ data: game.data, party: game.save.party, wild, save: game.save });
  done = false;
  Screens.push(game, "Gen2BattleState", { battle, save: game.save, onDone: () => { done = true; game.stack.pop(); } });
  state = game.stack.top();
}

const stats = new Map<string, { n: number; upd: number; draw: number; end: number }>();
let i = 0;
let total = 0;
(globalThis as unknown as { frame: (b: number) => void }).frame = (): void => {
  if (done) newBattle();
  const phase: string = state.phase;
  const tick = i % 4 === 0;
  let buttons = 0;
  if (phase === "menu") {
    if (tick && state.menuIndex === 1 && (state.messageTimer ?? 0) <= 0) buttons = VOX_BTN.a;
    else if (tick && state.menuIndex !== 1) buttons = VOX_BTN.up;
  } else if (phase === "moves") {
    const moves: any[] = state.playerMoves();
    const target = moves.findIndex((m: any) => m.id === "EMBER") + 1;
    if (tick) buttons = state.moveIndex < target ? VOX_BTN.down : state.moveIndex > target ? VOX_BTN.up : VOX_BTN.a;
  } else if (i % 8 === 0) buttons = VOX_BTN.a;
  i++;
  const a = now();
  Input.setButtons(buttons);
  Input.step();
  game.stack.update(1 / 60);
  const b = now();
  lcd.begin();
  resetDrawState();
  game.stack.draw();
  const c = now();
  lcd.end();
  const d = now();
  const key = state.anim?.animId ? "anim" : phase;
  const s = stats.get(key) ?? { n: 0, upd: 0, draw: 0, end: 0 };
  s.n++;
  s.upd += b - a;
  s.draw += c - b;
  s.end += d - c;
  stats.set(key, s);
  if (++total % 1500 === 0) {
    for (const [k, v] of stats) {
      console.log(`[battle] ${k}: ${v.n} frames, us: update ${(v.upd / v.n).toFixed(0)} draw ${(v.draw / v.n).toFixed(0)} lcd ${(v.end / v.n).toFixed(0)}`);
    }
    stats.clear();
  }
};

// ---- inclusive timing of the drawing layer, under QuickJS itself -----------
import G from "../voxelmon/game/gen2/platform/screen.ts";
import { Font } from "../voxelmon/game/gen2/shared/render/Font.ts";
import { Chrome } from "../voxelmon/game/gen2/ui/Chrome.ts";
import { GbcPalette } from "../voxelmon/game/gen2/shared/render/GbcPalette.ts";
import { BattleHud } from "../voxelmon/game/gen2/ui/BattleHud.ts";
const ptime = new Map<string, number>();
const pcalls = new Map<string, number>();
const done1 = new Set<string>();
function wrapT(obj: any, name: string, label: string): void {
  const f = obj?.[name];
  if (typeof f !== "function" || done1.has(label)) return;
  done1.add(label);
  obj[name] = function (this: unknown, ...a: unknown[]) {
    const t = now();
    try {
      return f.apply(this, a);
    } finally {
      ptime.set(label, (ptime.get(label) ?? 0) + (now() - t));
      pcalls.set(label, (pcalls.get(label) ?? 0) + 1);
    }
  };
}
// on only in a bundle built with --define PROFILE=true (cc_qjs_battle.sh ... prof)
declare const PROFILE: boolean;
const profiling = typeof PROFILE !== "undefined" && PROFILE;
if (profiling) {
for (const k of ["draw", "rectangle"]) wrapT(G, k, `G.${k}`);
for (const k of ["draw", "drawCode", "encode", "drawBox", "width"]) wrapT(Font, k, `Font.${k}`);
for (const k of Object.keys(Chrome)) if (/^[a-z]/.test(k) && typeof (Chrome as any)[k] === "function") wrapT(Chrome, k, `Chrome.${k}`);
for (const k of ["use", "with", "useRaw"]) wrapT(GbcPalette, k, `GbcPalette.${k}`);
for (const k of Object.getOwnPropertyNames(BattleHud.prototype)) {
  if (k !== "constructor" && typeof (BattleHud.prototype as any)[k] === "function") wrapT(BattleHud.prototype, k, `Hud.${k}`);
}
for (const k of ["palette", "findColour", "fillCells", "cell", "obj"]) wrapT(lcd, k, `lcd.${k}`);
}
let pframes = 0;
const prevFrame = (globalThis as any).frame;
(globalThis as any).frame = (b: number): void => {
  prevFrame(b);
  if (!profiling) return;
  if (state) {
    const proto = Object.getPrototypeOf(state);
    for (const k of Object.getOwnPropertyNames(proto)) {
      if (k !== "constructor" && typeof proto[k] === "function") wrapT(proto, k, `B.${k}`);
    }
  }
  if (++pframes % 1500 === 0) {
    const rows = [...ptime.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)
      .map(([k, v]) => `${k} ${(v / 1500).toFixed(0)}us x${((pcalls.get(k) ?? 0) / 1500).toFixed(1)}`);
    console.log(`[battle] profile:\n  ${rows.join("\n  ")}`);
    ptime.clear();
    pcalls.clear();
  }
};
