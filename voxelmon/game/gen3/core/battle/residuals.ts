// Port of gen1recomp src/core/game3/battle/residuals.lua (GPLv3 + additional terms; see LICENSE.md).
// End-of-turn residual scheduler (owned game3).
//
// Port notes:
// - `package.loaded["src.core.game3.battle.engine"]` reads the imported
//   Engine (every module is in the bundle); the lazy requires (state, moves)
//   are static imports.
// - The battler-keyed `hpBefore` table is a Map.
// - `pcall(fn, ctx)` is a try/catch; `error(err, 0)` rethrows the caught value.
// - Adapter colon calls (`adapter:hp(b)`) are method calls on the adapter.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tonumber, tostring, truthy } from "../../../../import/gen3/lua.ts";
import { ipairs, len, seq, type LuaTable } from "../../platform/lt.ts";
import Rules from "./rules.ts";
import EffectCtx from "./effect_ctx.ts";
import Engine from "./engine.ts";
import State from "./state.ts";
import Moves from "./moves.ts";

export type ResidualFn = (ctx: any) => unknown;

export interface ResidualsModule {
  register(phase: string, fn: ResidualFn): void;
  clear(): void;
  sortedBattlers(adapter: any): LuaTable;
  collectEvents(adapter: any): LuaTable;
  runTurn(adapter: any): LuaTable;
}

export const Residuals = {} as ResidualsModule;

let handlers: Record<string, LuaTable> = {};

/** Lua `a or b` (b already evaluated). */
function lor(a: any, b: any): any {
  return truthy(a) ? a : b;
}

// Lua: residuals.lua:10
Residuals.register = function (phase: string, fn: ResidualFn): void {
  handlers[phase] = truthy(handlers[phase]) ? handlers[phase] : seq();
  handlers[phase]![len(handlers[phase]) + 1] = fn;
};

// Lua: residuals.lua:15
Residuals.clear = function (): void {
  handlers = {};
};

// Lua: residuals.lua:19
function battlerSpeed(battler: any, adapter: any): number {
  if (!truthy(battler)) return 0;
  // package.loaded["src.core.game3.battle.engine"]
  if (truthy(Engine) && truthy(Engine.speedOf)) {
    return Engine.speedOf(battler, truthy(adapter) ? adapter._st : adapter, adapter);
  }
  const mon = battler.mon;
  const v = truthy(mon) ? (truthy(mon.speed) ? mon.speed : mon.spe) : mon;
  return tonumber(v) ?? 50;
}

// Lua: residuals.lua:30 -- pokefirered/src/battle_util.c:494
function sortedBattlers(adapter: any): LuaTable {
  const st = truthy(adapter) ? adapter._st : adapter;
  if (truthy(st) && truthy(st.double)) {
    let ids = st._endTurnOrder;
    if (!truthy(ids)) {
      let pri: any = null;
      if (truthy(st.turnActions)) {
        pri = {};
        for (const [, act] of ipairs(st.turnActions)) {
          if (act.battler != null && act.kind === "move") pri[act.battler] = Moves.priority(act.move);
        }
      }
      ids = State.speedOrder(st, adapter, { priority: pri });
    }
    const out: LuaTable = seq();
    for (const [, id] of ipairs<number>(ids)) {
      if (State.isPresent(st, id)) out[len(out) + 1] = State.battler(st, id);
    }
    return out;
  }
  let list = adapter.activeBattlers();
  if (!truthy(list)) list = seq();
  const a = list[1], b = list[2];
  if (truthy(a) && truthy(b)) {
    // pokefirered/src/battle_util.c:484
    const ids = truthy(st) ? st._endTurnOrder : st;
    if (truthy(ids) && truthy(ids[1]) && truthy(ids[2])) {
      if (ids[1] === b.id && ids[2] === a.id) {
        list[1] = b; list[2] = a;
      } else if (ids[1] === a.id) {
        list[1] = a; list[2] = b;
      }
      return list;
    }
    const sa = battlerSpeed(a, adapter), sb = battlerSpeed(b, adapter);
    if (sb > sa || (sb === sa && adapter.roll(0, 1) === 1)) {
      list[1] = b; list[2] = a;
    }
  }
  return list;
}
Residuals.sortedBattlers = sortedBattlers;

// Lua: residuals.lua:74
function runStepAndRecord(adapter: any, battler: any, phase: string, fn: ResidualFn, events: LuaTable): boolean {
  if (truthy(battler) && truthy(adapter.isFainted(battler))) return false;
  if (truthy(adapter.isBattleDecided())) return false;

  let active = adapter.activeBattlers();
  if (!truthy(active)) active = seq();
  const hpBefore = new Map<any, number>();
  for (const [, b] of ipairs(active)) {
    if (truthy(b) && truthy(b.side)) {
      hpBefore.set(b, adapter.hp(b));
    }
  }

  const capturedMsgs: LuaTable = seq();
  const prevSay = adapter._say;
  adapter._say = function (text: any): void {
    capturedMsgs[len(capturedMsgs) + 1] = tostring(truthy(text) ? text : "");
  };
  let mark = truthy(adapter.eventMark) ? adapter.eventMark() : adapter.eventMark;
  if (!truthy(mark)) mark = 0;

  const opts = EffectCtx.borrowOpts(phase);
  const ctx = EffectCtx.push(adapter, null, battler, null, null, adapter.rng(), opts);
  let ok = true, err: unknown = null;
  try {
    fn(ctx);
  } catch (e) {
    ok = false;
    err = e;
  }
  EffectCtx.pop();

  const hpChanges: LuaTable = seq();
  const faints: LuaTable = seq();
  for (const [, b] of ipairs(active)) {
    if (truthy(b) && truthy(b.side)) {
      const before = hpBefore.get(b) ?? 0;
      const after = adapter.hp(b);
      if (before !== after) {
        hpChanges[len(hpChanges) + 1] = {
          side: b.side,
          battler: b.id,
          from: before,
          to: after,
          maxHp: adapter.maxHp(b),
        };
      }
      if (truthy(adapter.isFainted(b)) && before > 0) {
        faints[len(faints) + 1] = { side: b.side, battler: b.id };
        if (!truthy(b._faintAnnounced)) {
          b._faintAnnounced = true;
          if (truthy(adapter.pushEvent)) adapter.pushEvent({ kind: "faint", side: b.side, battler: b.id });
          adapter.sayText("STRINGID_ATTACKERFAINTED", { atk: b });
        }
        adapter.emitFaint(b);
      }
    }
  }

  adapter._say = prevSay;
  if (!ok) throw err;

  if (len(capturedMsgs) > 0 || len(hpChanges) > 0 || len(faints) > 0) {
    events[len(events) + 1] = {
      phase: phase,
      target: battler,
      msgs: capturedMsgs,
      hpChanges: hpChanges,
      faints: faints,
      events: lor(truthy(adapter.eventsSince) ? adapter.eventsSince(mark) : adapter.eventsSince, seq()),
    };
  }

  if (truthy(battler) && truthy(adapter.isFainted(battler))) {
    if (Rules.shouldHaltBattlerOnFaint(phase)) {
      return true;
    }
  }
  return false;
}

// Lua: residuals.lua:147
function run_phase(adapter: any, phase: string, battler: any, events: LuaTable): boolean {
  const list = handlers[phase];
  if (!truthy(list)) return false;
  for (const [, fn] of ipairs<ResidualFn>(list)) {
    if (truthy(adapter.isBattleDecided())) return true;
    if (runStepAndRecord(adapter, battler, phase, fn, events)) return true;
  }
  return false;
}

// Lua: residuals.lua:157
Residuals.collectEvents = function (adapter: any): LuaTable {
  const events: LuaTable = seq();
  if (!truthy(adapter) || truthy(adapter.isBattleDecided())) return events;

  // package.loaded["src.core.game3.battle.engine"]
  if (truthy(Engine) && truthy(Engine.refreshLinks)) Engine.refreshLinks(adapter._st);
  // pokefirered/src/battle_main.c:2957
  for (const [, b] of ipairs(adapter.activeBattlers())) {
    b.expProtected = null;
    b.expEnduring = null;
  }

  const st = adapter._st;
  if (truthy(st)) {
    st._endTurnOrder = null;
    // pokefirered/src/battle_util.c:484
    const order: LuaTable = seq();
    for (const [, b] of ipairs(sortedBattlers(adapter))) order[len(order) + 1] = b.id;
    st._endTurnOrder = order;
    if (truthy(st.double)) {
      // pokefirered/src/battle_util.c:484
      st.turnOrder = order;
    }
  }

  for (const [, phase] of ipairs<string>(Rules.FIELD_PHASES_ORDER)) {
    if (truthy(adapter.isBattleDecided())) break;
    run_phase(adapter, phase, null, events);
  }

  if (!truthy(adapter.isBattleDecided())) {
    for (const [, battler] of ipairs(sortedBattlers(adapter))) {
      for (const [, phase] of ipairs<string>(Rules.BATTLER_PHASES_ORDER)) {
        if (truthy(adapter.isBattleDecided()) || truthy(adapter.isFainted(battler))) break;
        if (run_phase(adapter, phase, battler, events)) break;
      }
    }
  }

  for (const [, phase] of ipairs<string>(Rules.POST_PHASES_ORDER)) {
    if (truthy(adapter.isBattleDecided())) break;
    run_phase(adapter, phase, null, events);
  }

  if (truthy(st)) st._endTurnOrder = null;
  return events;
};

// Lua: residuals.lua:205
Residuals.runTurn = function (adapter: any): LuaTable {
  return Residuals.collectEvents(adapter);
};

export default Residuals;
