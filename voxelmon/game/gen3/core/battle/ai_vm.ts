// Port of gen1recomp src/core/game3/battle/ai_vm.lua (GPLv3 + additional terms; see LICENSE.md).
// Battle AI script VM: run one pret AI script for one considered move.
//
// Port notes:
// - The lazy requires (battle/moves, battle/link_guard) are static imports.
// - `math.random` (the vm.rng fallback when no rng is passed) is platform
//   random() with Lua's argument rules, wrapped by Guard.source as Brian's is.
// - `vm:jump` is a closure method on the vm object, as in Lua.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tonumber, tostring, truthy } from "../../../../import/gen3/lua.ts";
import { type LuaTable } from "../../platform/lt.ts";
import { random } from "../../platform/rng.ts";
import AiCmds from "./ai_cmds.ts";
import Moves from "./moves.ts";
import Guard from "./link_guard.ts";

/** An AI rng: rng(lo, hi) -> lo..hi (Rng.compat / math.random rules). */
export type AiRng = (lo?: number, hi?: number) => number;

/** One decoded pret AI command (data/generated/gba/battle_ai/pack.lua). */
export interface AiOp {
  op?: string;
  /** branch label (a script name in pack.scripts) */
  target?: unknown;
  [k: string]: any;
}

/** The AI script pack: table[logicId + 1] = script name; scripts[name] = op sequence. */
export interface AiPack {
  table: LuaTable;
  scripts: Record<string, LuaTable>;
  data?: Record<string, LuaTable>;
  version?: number;
  [k: string]: any;
}

export interface AiVmOpts {
  pack?: AiPack | null;
  st?: any;
  user?: any;
  target?: any;
  userSide?: any;
  targetSide?: any;
  scores?: LuaTable;
  simulatedRNG?: LuaTable;
  movesetIndex?: number;
  moveConsidered?: number | string;
  rng?: AiRng | null;
}

export interface AiVmState {
  pack: AiPack | null | undefined;
  st: any;
  user: any; // enemy battler
  target: any; // player battler
  userSide: any;
  targetSide: any;
  scores: LuaTable;
  simulatedRNG: LuaTable;
  movesetIndex: number;
  moveConsidered: number | string;
  funcResult: any;
  stack: LuaTable;
  scriptName: string | null;
  ops: LuaTable | null;
  ip: number;
  done: boolean;
  aiAction: number;
  rng: AiRng;
  jump(name: any, ip?: number): void;
}

export interface AiVmModule {
  "new"(opts?: AiVmOpts | null): AiVmState;
  run(vm: AiVmState | null | undefined, scriptName: string | null | undefined): void;
  resolve_move_id(mv: unknown): number;
}

export const AiVm = {} as AiVmModule;

// Lua: ai_vm.lua:7
function resolve_move_id(mv: unknown): number {
  if (mv == null || mv === 0 || mv === "") return 0;
  if (typeof mv === "number") return mv;
  return Moves.numForName(mv) ?? 0;
}

// Lua: ai_vm.lua:13
AiVm.new = function (optsIn?: AiVmOpts | null): AiVmState {
  const opts: AiVmOpts = optsIn ?? {};
  const vm: AiVmState = {
    pack: opts.pack,
    st: opts.st,
    user: opts.user, // enemy battler
    target: opts.target, // player battler
    userSide: opts.userSide,
    targetSide: opts.targetSide,
    scores: opts.scores,
    simulatedRNG: opts.simulatedRNG,
    movesetIndex: opts.movesetIndex ?? 1,
    moveConsidered: opts.moveConsidered ?? 0,
    funcResult: 0,
    stack: [],
    scriptName: null,
    ops: null,
    ip: 1,
    done: false,
    aiAction: 0,
    rng: truthy(opts.rng) ? (opts.rng as AiRng) : Guard.source("ai_vm.rng", random as AiRng),
    // Lua: ai_vm.lua:36
    jump(name: any, ip?: number): void {
      const body = this.pack && this.pack.scripts && this.pack.scripts[name];
      if (!truthy(body)) throw new Error("battle AI: no script " + tostring(name) + " in the pack");
      this.scriptName = name;
      this.ops = body;
      this.ip = ip ?? 1;
    },
  };
  return vm;
};

// Lua: ai_vm.lua:48
/** Run script `scriptName` for movesetIndex; mutates vm.scores[movesetIndex]. */
AiVm.run = function (vm: AiVmState | null | undefined, scriptName: string | null | undefined): void {
  if (!truthy(vm) || !truthy(scriptName)) return;
  vm = vm as AiVmState;
  const mon = truthy(vm.user) ? vm.user.mon : vm.user;
  const slot = vm.movesetIndex;
  const mv = truthy(mon) && truthy(mon.moves) ? mon.moves[slot] : undefined;
  const pp = truthy(mon) && truthy(mon.pp) ? mon.pp[slot] : undefined;
  if (!truthy(mv) || mv === 0 || mv === "" || (pp != null && (tonumber(pp) as number) <= 0)) {
    vm.scores[slot] = 0;
    return;
  }
  vm.moveConsidered = resolve_move_id(mv);
  if (vm.moveConsidered === 0 && typeof mv === "string") {
    // keep string moves usable via Moves.get by name; store 0 for if_move numeric compares
    vm.moveConsidered = mv;
  }
  vm.done = false;
  vm.stack = [];
  vm.funcResult = 0;
  vm.jump(scriptName);
  let guard = 0;
  while (!vm.done && guard < 100000) {
    guard = guard + 1;
    const op = vm.ops ? vm.ops[vm.ip] : undefined;
    if (!truthy(op)) {
      vm.done = true;
      break;
    }
    AiCmds.dispatch(vm, op);
  }
};

AiVm.resolve_move_id = resolve_move_id;

export default AiVm;
