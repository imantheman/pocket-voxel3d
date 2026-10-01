// The Kanto games' title screen under QuickJS (bundle and run in
// tools/qjs_gold_harness.c with PROF=1, via cc_qjs_title.sh): the real entry
// left on its title, every method of the game, the scene, the GB screen's
// emitter and the screen on top wrapped and timed inclusively. Read the
// totals as a ranking. Never shipped.
import "../voxelmon/game/psp-main.ts";
import { VoxelmonGame } from "../voxelmon/game/game.ts";
import { Scene } from "../voxelmon/game/scene.ts";
import { GbEmitter } from "../voxelmon/game/gb/emit.ts";

const g = globalThis as unknown as { voxelmonGame: any; frame: (b: number) => void; voxel: { now: () => number } };
const game = g.voxelmonGame;
const mainFrame = g.frame;
const now = g.voxel.now;

const stats: Record<string, { us: number; n: number }> = {};
let on = false;
const wrapped = new Set<any>();
function wrap(owner: any, label: string): void {
  if (!owner || wrapped.has(owner)) return;
  wrapped.add(owner);
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
wrap(VoxelmonGame.prototype, "Game");
wrap(Scene.prototype, "Scene");
wrap(GbEmitter.prototype, "GbEmitter");

let f = 0;
let frameUs = 0;
let frames = 0;
g.frame = (b: number): void => {
  f++;
  const top = game.stack?.[game.stack.length - 1];
  if (top) wrap(Object.getPrototypeOf(top), `top:${top.kind ?? top.constructor?.name}`);
  on = f > 120;
  const a = now();
  mainFrame(b & ~0xff);
  if (on) {
    frameUs += now() - a;
    frames++;
  }
  on = false;
  if (frames > 0 && frames % 600 === 0) {
    console.log(`[title] ${frames} frames, ${(frameUs / frames).toFixed(1)} us/frame (wrapped), top ${top?.kind}`);
    const rows = Object.entries(stats).sort((x, y) => y[1].us - x[1].us).slice(0, 24);
    for (const [k, s] of rows) console.log(`[title]   ${(s.us / frames).toFixed(1).padStart(8)} us/frame  ${(s.n / frames).toFixed(2).padStart(6)} calls  ${k}`);
  }
};
