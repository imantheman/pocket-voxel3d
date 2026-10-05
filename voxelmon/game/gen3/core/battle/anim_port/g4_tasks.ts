// Port of gen1recomp src/core/game3/battle/anim_port/g4_tasks.lua (GPLv3 + additional terms; see LICENSE.md).
// The g4 group's visual tasks: g4_tasks_a + g4_tasks_b merged behind a shared
// kit K (pan helpers, aux tasks, mon pic sizes); each task's data is zeroed on
// its first frame.

import { tonumber } from "../../../../../import/gen3/lua.ts";
import { pairs } from "../../../platform/lt.ts";
import { G3Lazy } from "../../lazy_registry.ts";
import { AnimCallbacks } from "../anim_callbacks.ts";
import { P } from "./g4_pret.ts";
import { T } from "./g4_templates.ts";
import PicSizes from "./g1_pic_sizes.ts";
import g4TasksA from "./g4_tasks_a.ts";
import g4TasksB from "./g4_tasks_b.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Task = Record<string, any>;

// Lua: g4_tasks.lua:4
export default function g4Tasks(host: any): Record<string, any> {
  const K: Record<string, any> = { P: P, T: T, host: host };
  let nextId = 0;

  // Lua: g4_tasks.lua:8
  K.destroy = function (t: Task): void {
    host._destroy(t);
  };

  // Lua: g4_tasks.lua:12
  K.cb = function (): any {
    // package.loaded["src.core.game3.battle.anim_callbacks"]._g4
    // (Brian's anim_callbacks merges the groups when it loads; the port merges
    // them on first use, so make sure they are in before reading _g4.)
    if (AnimCallbacks && AnimCallbacks._loadGroups) AnimCallbacks._loadGroups();
    return AnimCallbacks ? AnimCallbacks._g4 : null;
  };

  // Lua: g4_tasks.lua:18 -- pokefirered/src/battle_anim.c:1214
  K.keepPan = function (pan: number): number {
    if (pan > P.SOUND_PAN_TARGET) return P.SOUND_PAN_TARGET;
    if (pan < P.SOUND_PAN_ATTACKER) return P.SOUND_PAN_ATTACKER;
    return pan;
  };

  // Lua: g4_tasks.lua:25 -- pokefirered/src/battle_anim.c:1226
  K.panInc = function (src: number, tgt: number, inc: number): number {
    inc = Math.abs(inc);
    if (src < tgt) return inc;
    if (src > tgt) return -inc;
    return 0;
  };

  // Lua: g4_tasks.lua:32
  function fresh(t: Task, _vm: any): void {
    nextId = nextId + 1;
    t._g4id = nextId;
    t._g4init = true;
    for (let i = 0; i <= 15; i++) t.data[i] = 0;
  }

  // Lua: g4_tasks.lua:39
  K.spawnAux = function (vm: any, fn: any, priority: any): Task | null {
    const t = host.spawn("_G4Aux", priority ?? 2, {}, vm);
    if (!t) return null;
    fresh(t, vm);
    t._g4kind = "aux";
    t.func = fn;
    return t;
  };
  host.REGISTRY._G4Aux = host._stub;

  // Lua: g4_tasks.lua:50 -- pokefirered/src/battle_anim_mons.c:1999 (returns [w, h])
  K.monSize = function (vm: any, side: any): [number, number] {
    // pcall(require, "src.core.game3.battle.anim_port.g1_pic_sizes"): a real module, the ok path.
    const sizes: any = PicSizes;
    const sp = tonumber(P.species(vm, side));
    if (sizes != null && typeof sizes === "object" && sp != null) {
      const tbl = (side === "player") ? (sizes.back ?? sizes) : (sizes.front ?? sizes);
      const e = tbl[sp];
      if (e != null && typeof e === "object") return [e.w ?? e[1] ?? 64, e.h ?? e[2] ?? 64];
      if (typeof e === "number" && e > 0) return [P.rshift(e, 8), P.band(e, 0xFF)];
    }
    return [64, 64];
  };

  const TABLE: Record<string, any> = {};
  for (const [k, v] of pairs(g4TasksA(K))) TABLE[k as string] = v;
  for (const [k, v] of pairs(g4TasksB(K))) TABLE[k as string] = v;

  const OUT: Record<string, any> = {};
  for (const [name, fn] of pairs(TABLE)) {
    // Lua: g4_tasks.lua:68
    OUT[name as string] = function (t: Task, vm: any): any {
      if (!t._g4init) fresh(t, vm);
      return fn(t, vm);
    };
  }
  return OUT;
}

// pcall(require, "src.core.game3.battle.anim_port.g4_tasks") in anim_tasks.lua
G3Lazy["src.core.game3.battle.anim_port.g4_tasks"] = g4Tasks;
