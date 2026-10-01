// The Kanto games' 2D overworld under QuickJS (bundle and run in
// tools/qjs_gold_harness.c with PROF=1, via cc_qjs_kanto2d.sh): the real
// entry, straight into Viridian City, VIEW 2D (or 3D with VIEW3D defined),
// a walk round a loop, each frame timed -- the whole frame, the 2D view's
// build (world/view2d.ts) and the scene's emit. Never shipped.
import "../voxelmon/game/psp-main.ts";
import { OverworldView2d } from "../voxelmon/game/world/view2d.ts";
import { GbEmitter } from "../voxelmon/game/gb/emit.ts";

declare const VIEW3D: boolean;
const g = globalThis as unknown as { voxelmonGame: any; frame: (b: number) => void; voxel: { now: () => number } };
const game = g.voxelmonGame;
const mainFrame = g.frame;
const now = g.voxel.now;
const WALK = [1 << 2, 1 << 2, 1 << 0, 1 << 3, 1 << 3, 1 << 1];

const t = { n: 0, frame: 0, build: 0, emit: 0, worst: 0 };
function timed(proto: any, name: string, key: "build" | "emit"): void {
  const orig = proto[name];
  proto[name] = function (this: unknown, ...args: unknown[]) {
    const a = now();
    const r = orig.apply(this, args);
    t[key] += now() - a;
    return r;
  };
}
timed(OverworldView2d.prototype, "build", "build");
timed(GbEmitter.prototype, "emit", "emit");

while (game.stack.length > 1) game.pop();
game.overworld.enter("VIRIDIAN_CITY", 18, 20, "down");
game.save.options = { ...(game.save.options ?? {}), view: typeof VIEW3D !== "undefined" && VIEW3D ? "3d" : "2d" };
let profLine = "";
let tickUs = 0;
{
  const origTick = game.tick.bind(game);
  game.tick = (b: number) => {
    const a = now();
    origTick(b);
    if (f > 60) tickUs += now() - a;
  };
}
game.prof = { now, line: (l: string) => (profLine = l), upd: 0, emit: 0, aud: 0, maps: 0, ents: 0, ui: 0 };
let f = 0;
g.frame = (b: number): void => {
  const top = game.stack[game.stack.length - 1];
  let pad = 0;
  if (top?.kind === "overworld") pad = WALK[Math.floor(f / 24) % WALK.length]!;
  else if (f % 8 === 0) pad = 1 << 5; // B out of whatever opened
  const a = now();
  mainFrame((b & ~0xff) | pad);
  const d = now() - a;
  f++;
  if (f > 60) {
    t.n++;
    t.frame += d;
    if (d > t.worst) t.worst = d;
  }
  if (f % 600 === 0 && t.n > 0) {
    const us = (x: number) => ((x / t.n) * 1000).toFixed(0);
    console.log(`kanto2d ${typeof VIEW3D !== "undefined" && VIEW3D ? "3D" : "2D"} ${game.overworld.map?.id}: frame ${us(t.frame)} us (worst ${(t.worst * 1000).toFixed(0)}), view2d build ${us(t.build)}, gb emit ${us(t.emit)}`);
    console.log(`kanto2d   per 300 ticks, us: ${profLine}; tick ${us(tickUs)} us/frame, outside tick ${us(t.frame - tickUs)}`);
  }
};
