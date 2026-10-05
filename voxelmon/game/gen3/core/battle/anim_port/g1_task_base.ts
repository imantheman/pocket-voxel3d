// Port of gen1recomp src/core/game3/battle/anim_port/g1_task_base.lua (GPLv3 + additional terms; see LICENSE.md).
// Group 1 visual-task base: the wrapper that turns a pooled anim task into a
// pret task (gBattleAnimArgs copied into t._A, data cleared), and helpers.
//
// Port notes:
// - A task's func is `(t, vm)` (anim_tasks calls t.func(t, vm)).
// - package.loaded["src.core.game3.battle"] is init.ts's Battle (Battle._st).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tonumber } from "../../../../../import/gen3/lua.ts";
import { find } from "../../../platform/lpattern.ts";
import { Battle } from "../init.ts";
import { P } from "./g1_pret.ts";

export const K: Record<string, any> = {};

type TaskFn = (t: any, vm: any) => any;

// Lua: g1_task_base.lua:5
function to_num(v: unknown): number {
  if (typeof v === "string") {
    const l = v.toLowerCase();
    if (find(l, "target") != null) return 1;
    if (find(l, "attacker") != null) return 0;
    return tonumber(v) ?? 0;
  }
  return tonumber(v) ?? 0;
}

// Lua: g1_task_base.lua:16 -- pokefirered/src/task.c:30
K.wrap = function (initFn: TaskFn): TaskFn {
  return function (t: any, vm: any): any {
    if (t._g1) {
      const fn: TaskFn = t._fn ?? initFn;
      return fn(t, t._vm ?? vm);
    }
    t._g1 = true;
    P.hookVmReset();
    t._vm = vm;
    const A: number[] = [];
    for (let i = 0; i <= 7; i++) A[i] = P.s16(to_num(t.data[i]));
    t._A = A;
    for (let i = 0; i <= 15; i++) t.data[i] = 0;
    t._fn = initFn;
    return initFn(t, vm);
  };
};

// Lua: g1_task_base.lua:34
K.destroy = function (t: any): void {
  P.destroyTask(t);
};

// Lua: g1_task_base.lua:39 -- pokefirered/src/battle_anim_mons.c:333
K.battlerSide = function (vm: any, animBattlerIn: unknown): any {
  const animBattler = tonumber(animBattlerIn) ?? 0;
  if (animBattler === 0) return P.atk(vm);
  if (animBattler === 1) return P.tgt(vm);
  if ((animBattler === 2 || animBattler === 3) && vm && vm.battlerId) return vm.battlerId(animBattler);
  return null;
};

// Lua: g1_task_base.lua:47
K.mon = function (side: any): any {
  if (side == null || side === false) return null;
  return P.present(side);
};

// Lua: g1_task_base.lua:52
K.monX = function (vm: any, side: any): number {
  return P.coord(vm, side, P.X_2);
};

// Lua: g1_task_base.lua:56
K.monY = function (vm: any, side: any): number {
  return P.coord(vm, side, P.Y_PIC_OFFSET_DEFAULT);
};

// Lua: g1_task_base.lua:60
K.ctx = function (vm: any, key: string, fallback: any): any {
  const c = vm ? vm.ctx : null;
  if (c && c[key] != null) return c[key];
  if (vm && vm[key] != null) return vm[key];
  return fallback;
};

// Lua: g1_task_base.lua:67
K.sideFromCtx = function (v: unknown): any {
  if (v === "player" || v === "enemy") return v;
  const n = tonumber(v);
  if (n == null || n < 0 || n > 3) return null;
  return n;
};

// Lua: g1_task_base.lua:74
K.battleState = function (): any {
  // package.loaded["src.core.game3.battle"]
  const B: any = Battle;
  return B ? (B._st ?? null) : null;
};

export default K;
