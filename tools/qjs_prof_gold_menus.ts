// Where Gold's START menu screens go under QuickJS, screen by screen: the
// card's save continued (GOLD_SAVE), each screen opened and held, the
// compose (game.draw + lcd.end) and the step timed, and with WRAP the
// screen on top, the drawing layer and the tile sheets wrapped and timed
// inclusively. Bundle and run in tools/qjs_gold_harness.c with PROF=1
// (cc_qjs_prof_menus.sh). Never shipped.
import { native } from "../voxelmon/game/quickjs-host.ts";
import { readGen2Container } from "../voxelmon/game/gen2/platform/container.ts";
import { setGen2Source, loadGenerated } from "../voxelmon/game/gen2/platform/data.ts";
import { setSaveIo } from "../voxelmon/game/gen2/platform/saveio.ts";
import { seed } from "../voxelmon/game/gen2/platform/rng.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";
import { Save } from "../voxelmon/game/gen2/core/Save.ts";
import { Lcd } from "../voxelmon/game/gen2/platform/lcd.ts";
import G, { setLcd } from "../voxelmon/game/gen2/platform/screen.ts";
import { TileSheet } from "../voxelmon/game/gen2/ui/TileSheet.ts";
import { Chrome } from "../voxelmon/game/gen2/ui/Chrome.ts";
import { Font } from "../voxelmon/game/gen2/shared/render/Font.ts";
import { GbcPalette } from "../voxelmon/game/gen2/shared/render/GbcPalette.ts";
import { Assets } from "../voxelmon/game/gen2/shared/render/Assets.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { setClockSource } from "../voxelmon/game/gen2/platform/clock.ts";

const now = (globalThis as unknown as { voxel: { now: () => number } }).voxel.now;
const nat = native as any;
setGen2Source(readGen2Container(native.gamedata()));
setSaveIo({
  read: () => nat.saveData?.() ?? undefined,
  write: () => true,
  readOptions: () => nat.optionsData?.() ?? undefined,
  writeOptions: () => true,
});
seed(17);
const scene = loadGenerated<any>("scene");
const nop = (): void => {};
const lcd = new Lcd({ lcdCells: nop, lcdObjs: nop, lcdPals: nop, lcdRegs: nop, lcdLines: nop, lcdShow: nop, lcdBank: nop, lcdReset: nop, lcdUnder: nop, lcdUnderRow: nop, lcdUnderAt: nop, lcdAlias: nop, lcdCellsBin: nop, lcdObjsBin: nop, lcdLinesBin: nop } as never);
const pages = scene?.atlas?.lcd;
if (pages) lcd.banks(pages.counts.map((count: number, k: number) => ({ base: k * 1024, page: pages.firstPage + k, count })));
const game: any = Game2.new();
game.load();
const [save] = Save.load();
console.log(`[menus] save: ${save ? "the card's" : "none"}`);
if (save) game.continueGame(save);

const stats: Record<string, { us: number; n: number }> = {};
let on = false;
const done = new Set<any>();
function wrap(owner: any, label: string): void {
  if (!owner || done.has(owner)) return;
  done.add(owner);
  for (const name of Object.getOwnPropertyNames(owner)) {
    if (name === "constructor" || /^[A-Z]/.test(name)) continue; // classes stay constructible
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
declare const WRAP: boolean;
const wrapping = typeof WRAP !== "undefined" && WRAP;
if (wrapping) {
  wrap(Lcd.prototype, "Lcd");
  wrap(G, "G");
  wrap(TileSheet.prototype, "TileSheet");
  wrap(Chrome, "Chrome");
  wrap(GbcPalette, "GbcPalette");
}

type Stop = { name: string; item?: string; step?: number; gearCard?: number };
const STOPS: Stop[] = [
  { name: "START menu" },
  { name: "POKEDEX", item: "pokedex", step: VOX_BTN.down },
  { name: "PARTY", item: "pokemon", step: VOX_BTN.down },
  { name: "PACK", item: "pack", step: VOX_BTN.down },
  { name: "POKEGEAR", item: "pokegear" },
  // every card, the engine flags that gate them all forced on
  { name: "POKEGEAR card 2", item: "pokegear", gearCard: 2, step: VOX_BTN.down },
  { name: "POKEGEAR card 3", item: "pokegear", gearCard: 3, step: VOX_BTN.down },
  { name: "POKEGEAR card 4", item: "pokegear", gearCard: 4, step: VOX_BTN.down },
  { name: "TRAINER CARD", item: "status" },
  { name: "OPTION", item: "option", step: VOX_BTN.down },
];
const PER = 360;
// HASH=1: each stop's composed frames folded into one hash instead (for
// checking a drawing change left every screen as it was)
declare const HASH: boolean;
declare const DUMP: string;
declare const DUMPN: number;
declare const OPEN: boolean;
const opening = typeof OPEN !== "undefined" && OPEN;
let sumOpen = 0;
let sumClose = 0;
let worstOpen = 0;
let worstOpenAt = -1;
let worstClose = 0;
let worstCloseAt = -1;
const hashing = typeof HASH !== "undefined" && HASH;
// a frozen clock while hashing: the POKEGEAR's clock card shows the time
if (hashing) setClockSource({ now: () => 1790000000 });
// NOCACHE=1: every cachedBlock drawn for real, the reference for HASH
declare const NOCACHE: boolean;
if (typeof NOCACHE !== "undefined" && NOCACHE) (globalThis as { noBlockCache?: boolean }).noBlockCache = true;
let h = 0x811c9dc5 | 0;
const mix = (v: number): void => {
  h = Math.imul(h ^ (v | 0), 16777619);
};
let f = 0;
let stop = -1;
let n = 0;
const t = { step: 0, draw: 0 };
function report(): void {
  if (opening && stop >= 0) {
    console.log(`[menus] open/close ${STOPS[stop]!.name}: open worst ${worstOpen.toFixed(0)} us at frame ${worstOpenAt} (60 frames ${(sumOpen / 1000).toFixed(1)} ms), close worst ${worstClose.toFixed(0)} us at frame ${worstCloseAt} (60 frames ${(sumClose / 1000).toFixed(1)} ms), top ${game.stack.top()?.screenId}`);
    worstOpen = worstClose = sumOpen = sumClose = 0;
    worstOpenAt = worstCloseAt = -1;
    return;
  }
  if (n === 0 || stop < 0) return;
  if (hashing) {
    console.log(`[menus] hash ${STOPS[stop]!.name} ${n} ${(h >>> 0).toString(16)}`);
    h = 0x811c9dc5 | 0;
    return;
  }
  console.log(`[menus] ${STOPS[stop]!.name} (${game.stack.top()?.screenId}): compose ${(t.draw / n).toFixed(1)} us, step ${(t.step / (2 * n)).toFixed(1)} us${wrapping ? " (wrapped)" : ""}`);
  if (wrapping) {
    const rows = Object.entries(stats).sort((x, y) => y[1].us - x[1].us).slice(0, 22);
    for (const [k, s] of rows) console.log(`[menus]   ${(s.us / n).toFixed(1).padStart(8)} us  ${(s.n / n).toFixed(1).padStart(7)} calls  ${k}`);
  }
}
(globalThis as any).frame = (): void => {
  f++;
  if (f < 120) {
    game.frame(0);
    return;
  }
  const k = Math.floor((f - 120) / PER);
  if (k !== stop) {
    report();
    stop = k;
    if (k >= STOPS.length) return;
    stop = k;
    for (const key of Object.keys(stats)) delete stats[key];
    t.step = t.draw = 0;
    n = 0;
    while (game.stack.top()) game.stack.pop();
    game.openStartMenu();
    const s = STOPS[stop]!;
    if (s.item) {
      // OPEN=1 goes the way the START menu goes: through the fade
      if (opening) game.openStartMenuItem(s.item);
      else game.pushStartMenuItem(s.item);
    }
    if (s.gearCard && !opening) {
      const gear = game.stack.top();
      gear.flags = () => new Proxy({}, { get: () => true });
      gear.cards = gear.visibleCards();
      gear.cardIndex = Math.min(s.gearCard, gear.cards.length);
      console.log(`[menus] gear card ${gear.cardIndex}/${gear.cards.length}: ${gear.card()?.id}`);
    }
  }
  if (stop >= STOPS.length) return;
  const s = STOPS[stop]!;
  const top = game.stack.top();
  if (top && wrapping) wrap(Object.getPrototypeOf(top), `top:${top.screenId}`);
  // the first 60 frames settle (the screen's fade in), then everything counts
  const counting = (f - 120) % PER > 60;
  on = counting;
  const local = (f - 120) % PER;
  const a = now();
  let pad = s.step && f % 45 === 0 ? s.step : 0;
  if (opening) pad = local === 200 ? VOX_BTN.b : 0;
  // HASH: every screen walked through its cursor, pages and pockets
  if (hashing && local > 30 && local % 20 === 0) {
    const WALK = [VOX_BTN.down, VOX_BTN.down, VOX_BTN.right, VOX_BTN.down, VOX_BTN.left, VOX_BTN.up, VOX_BTN.right, VOX_BTN.right];
    pad = WALK[Math.floor(local / 20) % WALK.length]!;
  }
  game.frame(pad);
  if (counting) t.step += now() - a;
  if ((f & 1) === 0) {
    setLcd(lcd);
    const b = now();
    game.draw(lcd);
    if (opening) {
      const spent = now() - a;
      if (local < 60) sumOpen += spent;
      if (local >= 200 && local < 260) sumClose += spent;
      if (local < 60 && spent > worstOpen) {
        worstOpen = spent;
        worstOpenAt = local;
      }
      if (local >= 200 && local < 260 && spent > worstClose) {
        worstClose = spent;
        worstCloseAt = local;
      }
    }
    if (hashing && counting && n === (typeof DUMPN !== "undefined" ? DUMPN : 5) && typeof DUMP !== "undefined" && (STOPS[stop]!.name === DUMP || String(stop) === String(DUMP))) {
      const st = lcd.s;
      console.log(`[menus] dump cells ${Array.from(st.cells.slice(0, 640)).join(",")}`);
      console.log(`[menus] dump attrs ${Array.from(st.attrs.slice(0, 640)).join(",")}`);
      console.log(`[menus] dump colours ${Array.from(st.colours).join(",")}`);
      console.log(`[menus] dump win ${Array.from(st.cells.slice(640)).join(",")}`);
      console.log(`[menus] dump winattr ${Array.from(st.attrs.slice(640)).join(",")}`);
      console.log(`[menus] dump objs ${st.objs.map((o) => [o.x, o.y, o.tile, o.attr].join(":")).join(",")}`);
      console.log(`[menus] dump regs ${[st.scx, st.scy, st.wx, st.wy, st.flags, st.lineTarget].join(",")}`);
    }
    if (hashing && counting && typeof DUMP !== "undefined" && (STOPS[stop]!.name === DUMP || String(stop) === String(DUMP))) {
      const st = lcd.s;
      let fh = 0x811c9dc5 | 0;
      for (let i = 0; i < 2048; i++) fh = Math.imul(fh ^ ((st.cells[i]! << 8) | st.attrs[i]!), 16777619);
      for (const o of st.objs) fh = Math.imul(fh ^ ((o.x << 16) ^ (o.y << 8) ^ o.tile ^ (o.attr << 24)), 16777619);
      for (let i = 0; i < 128; i++) fh = Math.imul(fh ^ st.colours[i]!, 16777619);
      console.log(`[menus] fh ${n} ${(fh >>> 0).toString(16)} ${st.scx},${st.scy},${st.wx},${st.wy},${st.flags},${st.lineTarget}`);
    }
    if (hashing && counting) {
      const st = lcd.s;
      for (let i = 0; i < 2048; i++) mix((st.cells[i]! << 8) | st.attrs[i]!);
      mix(st.objs.length);
      for (const o of st.objs) {
        mix(o.x);
        mix(o.y);
        mix(o.tile);
        mix(o.attr);
      }
      for (let i = 0; i < 128; i++) mix(st.colours[i]!);
      mix(st.scx);
      mix(st.scy);
      mix(st.wx);
      mix(st.wy);
      mix(st.flags);
      mix(st.lineTarget);
      if (st.lineTarget) for (let i = 0; i < 144; i++) mix(st.lines[i]!);
    }
    lcd.end();
    if (counting) {
      t.draw += now() - b;
      n++;
    }
  }
  on = false;
};
