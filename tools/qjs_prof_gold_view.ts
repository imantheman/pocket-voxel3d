// Where Gold's 3D view goes under QuickJS: WorldView.emit (the scene ops a
// shown frame sends) and the World methods it reads, every method wrapped
// and timed inclusively over a 3D walk on Route 29. Bundle and run
// in tools/qjs_gold_harness.c with PROF=1 (cc_qjs_prof_view.sh). The
// wrappers cost something each: read the totals as a ranking. Never shipped.
import { native } from "../voxelmon/game/quickjs-host.ts";
import { readGen2Container } from "../voxelmon/game/gen2/platform/container.ts";
import { setGen2Source, loadGenerated } from "../voxelmon/game/gen2/platform/data.ts";
import { seed } from "../voxelmon/game/gen2/platform/rng.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";
import { World, peopleView_W6 } from "../voxelmon/game/gen2/world/World.ts";
import { WorldView } from "../voxelmon/game/gen2/platform/worldview.ts";
import { BattleStage } from "../voxelmon/game/gen2/platform/battlestage.ts";
import * as Npc from "../voxelmon/game/gen2/world/Npc.ts";
import * as Player from "../voxelmon/game/gen2/world/Player.ts";
import * as Map from "../voxelmon/game/gen2/world/Map.ts";
import { Palettes } from "../voxelmon/game/gen2/world/Palettes.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";

const now = (globalThis as unknown as { voxel: { now: () => number } }).voxel.now;
setGen2Source(readGen2Container(native.gamedata()));
seed(17);
const walker = loadGenerated<any>("scene") ?? loadGenerated<any>("walker");
const nop = (): void => {};
// every op a no-op: only the guest's own work is timed
const host: any = new Proxy({}, { get: () => nop });
const view = new WorldView(host, walker);
const game: any = Game2.new();
game.load({ startWorld: true });
// Route 29, where the Citra bench's save stands (cc_gold_bench.sh)
game.world.setMap("ROUTE_29", 27, 3, "down");

const stats: Record<string, { us: number; n: number }> = {};
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
        try {
          return orig.apply(this, args);
        } finally {
          const s = (stats[key] ??= { us: 0, n: 0 });
          s.us += now() - a;
          s.n++;
        }
      };
    } catch { /* frozen: leave it */ }
  }
}
wrap(WorldView.prototype, "WorldView");
wrap(BattleStage.prototype, "BattleStage");
wrap(World.prototype, "World");
wrap(Palettes, "Palettes");
for (const [mod, label] of [[Npc, "Npc"], [Player, "Player"], [Map, "Map"]] as const) {
  for (const [k, v] of Object.entries(mod)) {
    if (typeof v === "function" && (v as any).prototype) wrap((v as any).prototype, `${label}:${k}`);
    else if (v && typeof v === "object") wrap(v, `${label}:${k}`);
  }
}

const WALK = [VOX_BTN.left, VOX_BTN.left, VOX_BTN.up, VOX_BTN.right, VOX_BTN.right, VOX_BTN.down];
let f = 0;
let emitUs = 0;
let emits = 0;
(globalThis as any).frame = (): void => {
  f++;
  game.frame(f > 60 ? WALK[Math.floor(f / 20) % WALK.length]! : 0);
  if ((f & 1) === 0 && f > 60) {
    on = true;
    const a = now();
    view.emit(game);
    emitUs += now() - a;
    emits++;
    on = false;
    if (emits % 600 === 0) {
      // the people list alone, unwrapped
      const w = game.world;
      const a0 = now();
      for (let k = 0; k < 100; k++) peopleView_W6(w, [], false, false, false);
      const npcs = (w.npcs ?? []).length;
      const ghosts = (w.ghosts ?? []).length;
      console.log(`[prof] peopleView_W6 ${((now() - a0) / 100).toFixed(1)} us/call (${npcs} npcs, ${ghosts} ghosts)`);
      console.log(`[prof] ${emits} emits, ${(emitUs / emits).toFixed(1)} us/emit (wrapped), map ${game.world?.map?.id}`);
      const rows = Object.entries(stats).sort((x, y) => y[1].us - x[1].us).slice(0, 30);
      for (const [k, s] of rows) console.log(`[prof]   ${(s.us / emits).toFixed(2).padStart(8)} us/emit  ${(s.n / emits).toFixed(2).padStart(7)} calls/emit  ${k}`);
    }
  }
};
