// A check that a drawing change left Gold's intro and title pixel-for-pixel
// as they were: every composed frame's Gold screen state (cells, attributes,
// objects, palettes, registers, line values) folded into one hash per
// screen, printed as "[hash] <screen> <frames> <hash>". Run it before and
// after a change (cc_qjs_hash_intro.sh) and compare. Never shipped.
import { native } from "../voxelmon/game/quickjs-host.ts";
import { readGen2Container } from "../voxelmon/game/gen2/platform/container.ts";
import { setGen2Source, loadGenerated } from "../voxelmon/game/gen2/platform/data.ts";
import { seed } from "../voxelmon/game/gen2/platform/rng.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";
import { Lcd } from "../voxelmon/game/gen2/platform/lcd.ts";
import { setLcd } from "../voxelmon/game/gen2/platform/screen.ts";
import { Mon } from "../voxelmon/game/gen2/battle/Mon.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";

setGen2Source(readGen2Container(native.gamedata()));
seed(17);
const scene = loadGenerated<{ atlas?: { lcd?: { firstPage: number; counts: number[] } } }>("scene");
const nop = (): void => {};
const lcd = new Lcd({ lcdCells: nop, lcdObjs: nop, lcdPals: nop, lcdRegs: nop, lcdLines: nop, lcdShow: nop, lcdBank: nop, lcdReset: nop, lcdUnder: nop, lcdUnderRow: nop, lcdUnderAt: nop, lcdAlias: nop } as never);
const pages = scene?.atlas?.lcd;
if (pages) lcd.banks(pages.counts.map((count, k) => ({ base: k * 1024, page: pages.firstPage + k, count })));
// TOUR=1 at bundle time: not the intro but a tour of the screens most
// drawing goes through -- the overworld in 3D and VIEW 2D, the START menu
// and what it opens, a wild battle -- on fixed inputs
declare const TOUR: boolean;
const tour = typeof TOUR !== "undefined" && TOUR;
const game: any = Game2.new();
game.load(tour ? { startWorld: true } : undefined);
if (tour) game.world.setMap("CHERRYGROVE_CITY", 10, 10, "down");
const B = VOX_BTN;
function tourPad(f: number): number {
  const tap = (k: number): number => (f % 24 === 0 ? k : 0);
  if (f < 300) return Math.floor(f / 40) % 2 ? B.left : B.right;
  if (f === 300) game.options.view = "2d";
  if (f < 600) return Math.floor(f / 40) % 2 ? B.up : B.down;
  if (f === 600) {
    game.options.view = "3d";
    game.openStartMenu();
  }
  // START menu: down through the items, A into each, B back out
  if (f < 2400) {
    const k = Math.floor((f - 600) / 24) % 6;
    return tap(k === 0 ? B.down : k === 1 ? B.a : k === 2 ? B.down : k === 3 ? B.up : B.b);
  }
  if (f === 2400) {
    while (game.stack.top()) game.stack.pop();
    game.world.startBattle({ wild: Mon.new(game.data, "PIDGEY", 5, {}) });
  }
  return f % 20 === 0 ? B.a : 0;
}

declare const DETAIL: boolean;
let h = 0x811c9dc5 | 0;
const mix = (v: number): void => {
  h = Math.imul(h ^ (v | 0), 16777619);
};
let f = 0;
let n = 0;
let last = "";
(globalThis as any).frame = (): void => {
  f++;
  game.frame(tour ? tourPad(f) : 0);
  if ((f & 1) !== 0) return;
  const top = game.stack.top();
  const name = top?.screenId ?? (game.world ? `world-${game.options?.view}` : "-");
  if (name !== last) {
    if (n > 0) console.log(`[hash] ${last} ${n} ${(h >>> 0).toString(16)}`);
    h = 0x811c9dc5 | 0;
    n = 0;
    last = name;
  }
  setLcd(lcd);
  game.draw(lcd);
  const s = lcd.s;
  for (let i = 0; i < 2048; i++) mix((s.cells[i]! << 8) | s.attrs[i]!);
  mix(s.objs.length);
  for (const o of s.objs) {
    mix(o.x);
    mix(o.y);
    mix(o.tile);
    mix(o.attr);
  }
  for (let i = 0; i < 128; i++) mix(s.colours[i]!);
  mix(s.scx);
  mix(s.scy);
  mix(s.wx);
  mix(s.wy);
  mix(s.flags);
  mix(s.lineTarget);
  if (s.lineTarget) for (let i = 0; i < 144; i++) mix(s.lines[i]!);
  // DETAIL=1 at bundle time: the Game Freak screen frame by frame
  if (typeof DETAIL !== "undefined" && DETAIL && name === "Gen2GameFreakPresents") {
    const objs = s.objs.map((o) => `${o.x},${o.y},${o.tile},${o.attr}`).join(" ");
    let cells = 0x811c9dc5 | 0;
    for (let i = 0; i < 2048; i++) cells = Math.imul(cells ^ ((s.cells[i]! << 8) | s.attrs[i]!), 16777619);
    let pals = "";
    for (let i = 0; i < 24; i++) pals += s.colours[i]!.toString(16) + "."; pals += " ob "; for (let i = 64; i < 80; i++) pals += s.colours[i]!.toString(16) + ".";
    console.log(`[hash] gf ${n} cells ${(cells >>> 0).toString(16)} pals ${pals} objs ${objs}`);
  }
  lcd.end();
  n++;
  // the last screen never changes away: its running hash now and then
  if (n % 200 === 0) console.log(`[hash] ${last} ${n} ${(h >>> 0).toString(16)} (so far)`);
};
