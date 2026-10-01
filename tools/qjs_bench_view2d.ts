// Gold's 2D view under QuickJS (bundle and run in tools/qjs_gold_harness.c
// with PROF=1, via cc_qjs_view2d.sh): a boot into the world, VIEW 2D, a walk
// round a loop, with each shown frame's phases timed -- the step, the 2D map
// (map2d), the rest of the draw, and the screen diff (lcd.end).
import { native } from "../voxelmon/game/quickjs-host.ts";
import { readGen2Container } from "../voxelmon/game/gen2/platform/container.ts";
import { loadGenerated, setGen2Source } from "../voxelmon/game/gen2/platform/data.ts";
import { Lcd } from "../voxelmon/game/gen2/platform/lcd.ts";
import { seed } from "../voxelmon/game/gen2/platform/rng.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";
import * as Map2d from "../voxelmon/game/gen2/platform/map2d.ts";
import { setLcd } from "../voxelmon/game/gen2/platform/screen.ts";
import { peopleView_W6 } from "../voxelmon/game/gen2/world/World.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";

const now = (globalThis as unknown as { voxel: { now: () => number } }).voxel.now;
setGen2Source(readGen2Container(native.gamedata()));
seed(17);
const scene = loadGenerated<{ atlas?: { lcd?: { firstPage: number; counts: number[] } } }>("scene");
const host = {
  lcdCells: () => {}, lcdObjs: () => {}, lcdPals: () => {}, lcdRegs: () => {}, lcdLines: () => {},
  lcdShow: () => {}, lcdBank: () => {}, lcdReset: () => {},
} as never;
const lcd = new Lcd(host);
const pages = scene?.atlas?.lcd;
if (pages) lcd.banks(pages.counts.map((count, k) => ({ base: k * 1024, page: pages.firstPage + k, count })));
const game: any = Game2.new();
game.load();
const WALK = [VOX_BTN.left, VOX_BTN.left, VOX_BTN.up, VOX_BTN.right, VOX_BTN.right, VOX_BTN.down];

// map2d timed by wrapping the module export the draw calls
const t = { n: 0, step: 0, map: 0, draw: 0, end: 0 };
let mapUs = 0;
const orig = (Map2d as any).drawMap2D;
let f = 0;
let inWorld = 0;
(globalThis as any).frame = (): void => {
  const a = now();
  let b = 0;
  if (!game.world?.map) b = f % 40 === 0 ? VOX_BTN.a : 0;
  else {
    inWorld++;
    if (inWorld === 1) game.options.view = "2d";
    b = WALK[Math.floor(inWorld / 20) % WALK.length]!;
  }
  f++;
  game.frame(b);
  const c = now();
  if (inWorld === 0 || (f & 1) === 1) return;
  mapUs = 0;
  game.draw(lcd);
  const d = now();
  lcd.end();
  const e = now();
  t.n++;
  t.step += c - a;
  t.draw += d - c;
  t.end += e - d;
  if (t.n % 300 === 0) {
    console.log(`[view2d] us/shown frame: step ${(t.step / t.n).toFixed(0)} draw ${(t.draw / t.n).toFixed(0)} lcd.end ${(t.end / t.n).toFixed(0)} (map ${game.world?.map?.id})`);
    // the 2D map alone, and the people list it reads, timed in a loop
    setLcd(lcd);
    const R = 40;
    let m = 0;
    let pv = 0;
    for (let k = 0; k < R; k++) {
      lcd.begin();
      const a1 = now();
      Map2d.drawMap2D(game.world, game.data);
      const b1 = now();
      const out: any[] = [];
      peopleView_W6(game.world, out, false, false, false);
      const c1 = now();
      m += b1 - a1;
      pv += c1 - b1;
    }
    console.log(`[view2d]   drawMap2D ${(m / R).toFixed(0)} us (of which the people list ~${(pv / R).toFixed(0)} us)`);
    let uv = 0;
    let mk = 0;
    for (let k = 0; k < R; k++) {
      const a2 = now();
      game.world.updateView();
      const b2 = now();
      game.world.mapCacheKey(game.world.map.id);
      const c2 = now();
      uv += b2 - a2;
      mk += c2 - b2;
    }
    console.log(`[view2d]   updateView ${(uv / R).toFixed(1)} us, mapCacheKey ${(mk / R).toFixed(1)} us`);
    const tt = (globalThis as any).__tt; const tn = (globalThis as any).__ttn;
    if (tt) console.log(`[view2d]   marks: ${tt.map((v: number) => (v / tn).toFixed(1)).join(" | ")}  (updateView | key+tiles | palettes | cells | regs | people | sprites-setup | sprites)`);
    const q = (globalThis as any).__m2d;
    if (q) console.log(`[view2d]   split: setup ${(q[0] / q[4]).toFixed(0)} palettes ${(q[1] / q[4]).toFixed(0)} cells ${(q[2] / q[4]).toFixed(0)} sprites ${(q[3] / q[4]).toFixed(0)}`);
    t.n = t.step = t.draw = t.end = 0;
  }
};
void orig; void mapUs;

// ---- self-time profile of the step and the draw (--define PROFILE=true) ----
import { World } from "../voxelmon/game/gen2/world/World.ts";
import { Player } from "../voxelmon/game/gen2/world/Player.ts";
import { NPC as Npc } from "../voxelmon/game/gen2/world/Npc.ts";
import { Apricorns } from "../voxelmon/game/gen2/core/Apricorns.ts";
import { Pokerus } from "../voxelmon/game/gen2/core/Pokerus.ts";
import { Roamers } from "../voxelmon/game/gen2/core/Roamers.ts";
import { Phone } from "../voxelmon/game/gen2/core/Phone.ts";
declare const PROFILE: boolean;
if (typeof PROFILE !== "undefined" && PROFILE) {
  const ptime = new Map<string, number>();
  const pcalls = new Map<string, number>();
  const stackT: number[] = [];
  const wrapT = (obj: any, name: string, label: string): void => {
    const fn = obj?.[name];
    if (typeof fn !== "function") return;
    obj[name] = function (this: unknown, ...a: unknown[]) {
      const t0 = now();
      stackT.push(0);
      try {
        return fn.apply(this, a);
      } finally {
        const dt = now() - t0;
        const kids = stackT.pop()!;
        ptime.set(label, (ptime.get(label) ?? 0) + dt - kids);
        pcalls.set(label, (pcalls.get(label) ?? 0) + 1);
        if (stackT.length) stackT[stackT.length - 1]! += dt;
      }
    };
  };
  for (const [obj, tag] of [[Apricorns, "Apricorns"], [Roamers.Swarm, "Swarm"], [Pokerus, "Pokerus"], [Phone, "Phone"]] as const) {
    for (const k of Object.keys(obj as object)) if (typeof (obj as any)[k] === "function") wrapT(obj, k, `${tag}.${k}`);
  }
  for (const [cls, tag] of [[World, "W"], [Player, "P"], [Npc, "N"], [Game2, "G"]] as const) {
    for (const k of Object.getOwnPropertyNames((cls as any).prototype)) {
      if (k !== "constructor" && typeof (cls as any).prototype[k] === "function") wrapT((cls as any).prototype, k, `${tag}.${k}`);
    }
  }
  let pf = 0;
  const prev = (globalThis as any).frame;
  (globalThis as any).frame = (b: number): void => {
    prev(b);
    if (!game.world?.map) return;
    if (++pf % 600 === 0) {
      const rows = [...ptime.entries()].sort((x, y) => y[1] - x[1]).slice(0, 30)
        .map(([k, v]) => `${k} ${(v / 600).toFixed(1)}us x${((pcalls.get(k) ?? 0) / 600).toFixed(1)}`);
      console.log(`[view2d] profile (self, per step):\n  ${rows.join("\n  ")}`);
      ptime.clear();
      pcalls.clear();
    }
  };
}
