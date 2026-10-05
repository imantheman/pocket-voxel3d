// Port of gen1recomp src/core/game3/battle/effects/_helpers.lua (GPLv3 + additional terms; see LICENSE.md).
// Effect helpers (owned; no src.core.Strings / no KR).
//
// Port notes:
// - The lazy requires (adapter, types, moves) are static imports, used only
//   inside the functions, as Brian's are.
// - preparedMoves returns a Lua sequence (lt.ts: slot 0 unused).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { truthy, tonumber, tostring } from "../../../../../import/gen3/lua.ts";
import { pairs, ipairs, len, type LuaTable } from "../../../platform/lt.ts";
import type { EffectContext } from "../effect_ctx.ts";
import Adapter from "../adapter.ts";
import Types from "../types.ts";
import Moves from "../moves.ts";

/** Lua `a == b` where both may be nil (null and undefined are both nil). */
function eq(a: unknown, b: unknown): boolean {
  return a === b || (a == null && b == null);
}

export const H = {
  // Lua: _helpers.lua:5
  displayName(ctx: EffectContext, battler: any): any {
    return ctx.adapter.displayName(battler);
  },

  // Lua: _helpers.lua:9
  abilityId(name: any): any {
    if (typeof name === "number") return name;
    for (const [id, n] of pairs(Adapter.ABILITY_BY_ID)) {
      if (n === name) return id;
    }
    throw new Error("no ability id for " + tostring(name));
  },

  // Lua: _helpers.lua:18
  sayFail(ctx: EffectContext): void {
    const M = H.move(ctx);
    if (truthy(M)) M.failed = true;
    ctx.adapter.sayFail();
  },

  // Lua: _helpers.lua:24
  ownSide(ctx: EffectContext): any {
    return ctx.adapter.ownSide(ctx.user);
  },

  // Lua: _helpers.lua:28
  foeSide(ctx: EffectContext): any {
    return ctx.adapter.foeSide(ctx.user);
  },

  // Lua: _helpers.lua:32
  move(ctx: EffectContext | null | undefined): any {
    const o = truthy(ctx) ? ctx!.opts : ctx;
    if (o != null && typeof o === "object" && truthy(o.isMoveContext)) return o;
    return null;
  },

  // Lua: _helpers.lua:38
  attackAnim(ctx: EffectContext): void {
    const M = H.move(ctx);
    if (truthy(M) && truthy(M.attackAnimation)) M.attackAnimation();
  },

  // Lua: _helpers.lua:43
  accuracy(ctx: EffectContext, mode?: string): any {
    const M = H.move(ctx);
    if (!truthy(M) || !truthy(M.accuracyCheck)) return true;
    return M.accuracyCheck(truthy(mode) ? mode : "normal", true);
  },

  // Lua: _helpers.lua:49
  findHazard(adapter: any, side: any, id: any): any {
    if (truthy(adapter.findHazard)) return adapter.findHazard(side, id);
    if (!truthy(side) || !truthy(side.hazards)) return null;
    for (const [, h] of ipairs(side.hazards)) {
      if (eq(h.id, id)) return h;
    }
    return null;
  },

  // Lua: _helpers.lua:58
  hasType(_ctx: EffectContext, battler: any, typeId: any): boolean {
    if (!truthy(battler)) return false;
    let id = typeId;
    if (typeof typeId === "string") id = Types.ID[typeId.toUpperCase()];
    let t1 = battler.type1, t2 = battler.type2;
    if (truthy(battler.expTransform)) {
      t1 = truthy(battler.expTransform.type1) ? battler.expTransform.type1 : t1;
      t2 = truthy(battler.expTransform.type2) ? battler.expTransform.type2 : t2;
    }
    return eq(t1, id) || eq(t2, id);
  },

  // Lua: _helpers.lua:71
  lastMove(ctx: EffectContext, battler: any): any {
    if (!truthy(battler)) return null;
    if (truthy(ctx.adapter.lastMoveOf)) {
      return ctx.adapter.lastMoveOf(battler);
    }
    return truthy(battler.lastMoveId) ? battler.lastMoveId : battler.lastMove;
  },

  // Lua: _helpers.lua:79
  preparedMoves(ctx: EffectContext, battler: any): LuaTable {
    const mon = ctx.adapter.mon(battler);
    if (!truthy(mon)) return [null];
    const out: LuaTable = [null];
    for (let i = 1; i <= 4; i++) {
      const id = truthy(mon.moves) ? mon.moves[i] : mon.moves;
      if (truthy(id)) {
        const pp = truthy(mon.pp) && truthy(mon.pp[i]) ? mon.pp[i] : 0;
        out[len(out) + 1] = { id, pp, slot: i };
      }
    }
    return out;
  },

  // Lua: _helpers.lua:92
  moveNum(ref: any): number | null | undefined {
    if (ref == null) return null;
    if (typeof ref === "object") {
      ref = truthy(ref.numId) ? ref.numId : truthy(ref.id) ? ref.id : ref.move;
    }
    const n = tonumber(ref);
    if (n != null) return n;
    const m = Moves.get(ref);
    const num = tonumber(truthy(m) ? m.numId : m);
    return num != null ? num : Moves.numForName(ref);
  },

  // Lua: _helpers.lua:102
  slotOf(battler: any, moveRef: any): number | null {
    const mon = truthy(battler) ? battler.mon : battler;
    const want = H.moveNum(moveRef);
    if (!truthy(mon) || !truthy(mon.moves) || !truthy(want)) return null;
    for (let i = 1; i <= 4; i++) {
      if (H.moveNum(mon.moves[i]) === want) return i;
    }
    return null;
  },
};

export default H;
