// Where Gold's overworld step goes under QuickJS: every method of the world's
// classes wrapped and timed inclusively over a 2D walk (bundle and run in
// tools/qjs_gold_harness.c with PROF=1, via cc_qjs_prof_step.sh). The
// wrappers cost something each, so read the totals as a ranking, not as
// the step's real cost. Never shipped.
import { native } from "../voxelmon/game/quickjs-host.ts";
import { readGen2Container } from "../voxelmon/game/gen2/platform/container.ts";
import { setGen2Source } from "../voxelmon/game/gen2/platform/data.ts";
import { seed } from "../voxelmon/game/gen2/platform/rng.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";
import { World } from "../voxelmon/game/gen2/world/World.ts";
import * as Npc from "../voxelmon/game/gen2/world/Npc.ts";
import * as Player from "../voxelmon/game/gen2/world/Player.ts";
import * as Map from "../voxelmon/game/gen2/world/Map.ts";
import * as Follower from "../voxelmon/game/gen2/world/Follower.ts";
import * as CmdQueue from "../voxelmon/game/gen2/world/CmdQueue.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { Music } from "../voxelmon/game/gen2/shared/core/Music.ts";
import { MapNameSign } from "../voxelmon/game/gen2/world/MapNameSign.ts";
import { Runtime as ModRuntime } from "../voxelmon/game/gen2/shared/mods/Runtime.ts";
import { Save } from "../voxelmon/game/gen2/core/Save.ts";
import { AutoInput } from "../voxelmon/game/gen2/core/AutoInput.ts";
import { Lcd } from "../voxelmon/game/gen2/platform/lcd.ts";
import { loadGenerated } from "../voxelmon/game/gen2/platform/data.ts";

const now = (globalThis as unknown as { voxel: { now: () => number } }).voxel.now;
setGen2Source(readGen2Container(native.gamedata()));
seed(17);
const scene = loadGenerated<{ atlas?: { lcd?: { firstPage: number; counts: number[] } } }>("scene");
const nop = () => {};
const lcd = new Lcd({ lcdCells: nop, lcdObjs: nop, lcdPals: nop, lcdRegs: nop, lcdLines: nop, lcdShow: nop, lcdBank: nop, lcdReset: nop } as never);
const pages = scene?.atlas?.lcd;
if (pages) lcd.banks(pages.counts.map((count, k) => ({ base: k * 1024, page: pages.firstPage + k, count })));
const game: any = Game2.new();
// straight into the world (no intro to press through), where the Citra
// bench's save stands; VIEW 2D=1 at bundle time walks in VIEW 2D
declare const VIEW2D: boolean;
game.load({ startWorld: true });
game.world.setMap("ROUTE_29", 27, 3, "down");

const stats: Record<string, { us: number; n: number }> = {};
let depth = 0;
let on = false;
function wrap(owner: any, label: string): void {
  if (!owner) return;
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
        depth++;
        try {
          return orig.apply(this, args);
        } finally {
          depth--;
          const s = (stats[key] ??= { us: 0, n: 0 });
          s.us += now() - a;
          s.n++;
        }
      };
    } catch { /* frozen: leave it */ }
  }
}
wrap(World.prototype, "World");
wrap(Game2.prototype, "Game2");
wrap(Music, "Music");
wrap(MapNameSign, "MapNameSign");
wrap(ModRuntime, "ModRuntime");
wrap(Save, "Save");
wrap(AutoInput.prototype, "AutoInput");
for (const [mod, label] of [[Npc, "Npc"], [Player, "Player"], [Map, "Map"], [Follower, "Follower"], [CmdQueue, "CmdQueue"]] as const) {
  for (const [k, v] of Object.entries(mod)) {
    if (typeof v === "function" && (v as any).prototype) wrap((v as any).prototype, `${label}:${k}`);
    else if (v && typeof v === "object") wrap(v, `${label}:${k}`);
  }
}

const WALK = [VOX_BTN.left, VOX_BTN.left, VOX_BTN.up, VOX_BTN.right, VOX_BTN.right, VOX_BTN.down];
let f = 0;
let inWorld = 0;
let stepUs = 0;
let steps = 0;
(globalThis as any).frame = (): void => {
  let b = 0;
  if (!game.world?.map) b = f % 40 === 0 ? VOX_BTN.a : 0;
  else {
    inWorld++;
    if (inWorld === 1) game.options.view = typeof VIEW2D !== "undefined" && VIEW2D ? "2d" : "3d";
    b = WALK[Math.floor(inWorld / 20) % WALK.length]!;
  }
  f++;
  on = inWorld > 60;
  const a = now();
  game.frame(b);
  if (on) {
    stepUs += now() - a;
    steps++;
  }
  on = false;
  if ((f & 1) === 0) {
    game.draw(lcd);
    lcd.end();
  }
  if (inWorld > 60 && steps % 1500 === 0) {
    console.log(`[prof] ${steps} steps, ${(stepUs / steps).toFixed(1)} us/step (wrapped), map ${game.world?.map?.id}`);
    const rows = Object.entries(stats).sort((x, y) => y[1].us - x[1].us).slice(0, 28);
    for (const [k, s] of rows) console.log(`[prof]   ${(s.us / steps).toFixed(2).padStart(7)} us/step  ${(s.n / steps).toFixed(2).padStart(6)} calls/step  ${k}`);
  }
};
