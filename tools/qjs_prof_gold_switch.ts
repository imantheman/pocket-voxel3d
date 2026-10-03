// Where Gold's map switch goes under QuickJS (a copy of qjs_prof_gold_step's
// wrapping, only the frames that changed the map counted; cc_qjs_prof_gswitch.sh): every method of the world's
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
import * as Map2d from "../voxelmon/game/gen2/platform/map2d.ts";
import * as Palettes from "../voxelmon/game/gen2/world/Palettes.ts";

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
// MAP=GOLDENROD_CITY at bundle time: that map, at its first door as the
// Citra tour arrives (gold_prof_entry.ts)
declare const MAP: string;
if (typeof MAP !== "undefined") {
  const door = game.world.maps[MAP]?.warps?.[0];
  game.world.warpToMapId(MAP, door?.x ?? 5, (door?.y ?? 5) + 1, "down");
} else {
  game.world.mapScenes.NEW_BARK_TOWN = 1;
  game.world.setMap("NEW_BARK_TOWN", 4, 8, "left");
}

const stats: Record<string, { us: number; n: number }> = {};
let depth = 0;
let on = true;
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
wrap((Lcd as any).prototype, "Lcd");
for (const [k, v] of Object.entries(Palettes)) if (v && typeof v === "object") wrap(v, `Palettes:${k}`);
for (const [mod, label] of [[Npc, "Npc"], [Player, "Player"], [Map, "Map"], [Follower, "Follower"], [CmdQueue, "CmdQueue"]] as const) {
  for (const [k, v] of Object.entries(mod)) {
    if (typeof v === "function" && (v as any).prototype) {
      wrap((v as any).prototype, `${label}:${k}`);
      wrap(v, `${label}:${k}(static)`);
    }
    else if (v && typeof v === "object") wrap(v, `${label}:${k}`);
  }
}


import { tilesFor as _tf } from "../voxelmon/game/gen2/platform/map2d.ts";
let f = 0;
let switches = 0;
let switchUs = 0;
let last = "";
let west = true;
const total: Record<string, { us: number; n: number }> = {};
(globalThis as any).frame = (): void => {
  let b = 0;
  const w = game.world;
  if (!w?.map) b = f % 40 === 0 ? VOX_BTN.a : 0;
  else {
    if (f === 5) game.options.view = "2d";
    const p = w.player;
    if (p && !p.moving) {
      if (w.map.id === "ROUTE_29" && p.cellX <= w.map.width * 2 - 4) west = false;
      if (w.map.id === "NEW_BARK_TOWN" && p.cellX >= 4) west = true;
    }
    b = game.stack.top() || w.busy() ? (f % 12 === 0 ? VOX_BTN.a : 0) : west ? VOX_BTN.left : VOX_BTN.right;
  }
  f++;
  if (f % 500 === 0) console.log(`[prof] at ${w?.map?.id} ${w?.player?.cellX},${w?.player?.cellY} top ${game.stack.top()?.screenId ?? game.stack.top()?.constructor?.name} busy ${w?.busy?.()}`);
  for (const k of Object.keys(stats)) delete stats[k];
  const a = now();
  game.frame(b);
  game.draw(lcd);
  lcd.end();
  const us = now() - a;
  const id = game.world?.map?.id ?? "";
  if (id !== last) {
    if (last && f > 30) {
      switches++;
      switchUs += us;
      for (const [k, s] of Object.entries(stats)) {
        const t = (total[k] ??= { us: 0, n: 0 });
        t.us += s.us;
        t.n += s.n;
      }
      if (switches % 8 === 0) {
        console.log(`[prof] ${switches} switches, ${(switchUs / switches / 1000).toFixed(2)} ms per switch frame (wrapped)`);
        const rows = Object.entries(total).sort((x, y) => y[1].us - x[1].us).slice(0, 36);
        for (const [k, s] of rows) console.log(`[prof]   ${(s.us / switches / 1000).toFixed(2).padStart(7)} ms  ${(s.n / switches).toFixed(1).padStart(7)} calls  ${k}`);
      }
    }
    last = id;
  }
};
