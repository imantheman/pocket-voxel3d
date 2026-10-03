// Where a Kanto map switch goes under QuickJS (bundle and run in
// tools/qjs_gold_harness.c with PROF=1, via cc_qjs_prof_mapswitch.sh): the
// real entry in VIEW 2D, the player walked across PALLET TOWN's top edge
// into ROUTE 1 and back (DOOR=1: in and out of Red's house). Every method of
// the game's classes is wrapped; only the frames that switched the map
// count. The wrappers cost something each, so read the totals as a
// ranking. Never shipped.
import "../voxelmon/game/psp-main.ts";
import { OverworldView2d } from "../voxelmon/game/world/view2d.ts";
import { GbEmitter } from "../voxelmon/game/gb/emit.ts";

declare const DOOR: boolean;
const door = typeof DOOR !== "undefined" && DOOR;
const g = globalThis as unknown as { voxelmonGame: any; frame: (b: number) => void; voxel: { now: () => number } };
const game = g.voxelmonGame;
const mainFrame = g.frame;
const now = g.voxel.now;

type Stat = { us: number; n: number };
let frameStats: Record<string, Stat> = {};
const total: Record<string, Stat> = {};
const wrapped = new Set<object>();
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
        const a = now();
        try {
          return orig.apply(this, args);
        } finally {
          const s = (frameStats[key] ??= { us: 0, n: 0 });
          s.us += now() - a;
          s.n++;
        }
      };
    } catch { /* frozen */ }
  }
}

while (game.stack.length > 1) game.pop();
game.save.options = { ...(game.save.options ?? {}), view: "2d", battleView: "2d" };
// past the start: OAK no longer stops the player at PALLET TOWN's edge
game.save.flags = { ...(game.save.flags ?? {}), EVENT_FOLLOWED_OAK_INTO_LAB: true, EVENT_GOT_STARTER: true };
if (door) game.overworld.enter("PALLET_TOWN", 5, 6, "up");
else game.overworld.enter("PALLET_TOWN", 10, 1, "up");

const protoOf = (o: any) => (o ? Object.getPrototypeOf(o) : undefined);
wrap(protoOf(game), "Game");
wrap(protoOf(game.overworld), "Overworld");
wrap(protoOf(game.overworld.map), "GameMap");
wrap(protoOf(game.overworld.player), "Player");
wrap(protoOf(game.overworld.entities?.[0]), "NPC");
wrap(protoOf(game.overworld.scripts ?? game.overworld.runner), "Script");
wrap(protoOf(game.scene), "Scene");
wrap(protoOf(game.audio), "Audio");
wrap(OverworldView2d.prototype, "View2d");
wrap(GbEmitter.prototype, "GbEmitter");
for (const [k, v] of Object.entries(game.overworld)) {
  const p = protoOf(v);
  if (p && p !== Object.prototype && p !== Array.prototype && typeof v === "object") wrap(p, `ow.${k}`);
}

let f = 0;
let switches = 0;
let switchUs = 0;
let worst = 0;
let last = game.overworld.map.id;
g.frame = (b: number): void => {
  const ow = game.overworld;
  const top = game.stack[game.stack.length - 1];
  let pad = 0;
  if (top?.kind === "overworld" && f > 30) pad = ow.map.id === "PALLET_TOWN" ? 1 << 0 : 1 << 1;
  else if (f % 8 === 0) pad = 1 << 4;
  frameStats = {};
  const a = now();
  mainFrame((b & ~0xff) | pad);
  const us = now() - a;
  f++;
  if (ow.map.id !== last) {
    last = ow.map.id;
    switches++;
    switchUs += us;
    worst = Math.max(worst, us);
    for (const [k, s] of Object.entries(frameStats)) {
      const t = (total[k] ??= { us: 0, n: 0 });
      t.us += s.us;
      t.n += s.n;
    }
    if (switches % 10 === 0) {
      console.log(`[prof] ${switches} switches (${door ? "door" : "seam"}), ${(switchUs / switches / 1000).toFixed(1)} ms per switch frame (wrapped), worst ${(worst / 1000).toFixed(1)} ms`);
      const rows = Object.entries(total).sort((x, y) => y[1].us - x[1].us).slice(0, 40);
      for (const [k, s] of rows) console.log(`[prof]   ${(s.us / switches / 1000).toFixed(2).padStart(7)} ms  ${(s.n / switches).toFixed(1).padStart(7)} calls  ${k}`);
    }
  }
};
