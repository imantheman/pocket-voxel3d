// Port of gen1recomp src/core/game3/battle/anim_ctx.lua (GPLv3 + additional terms; see LICENSE.md).
// The battle-anim context a move animation reads (pret gAnimMoveDmg,
// gAnimFriendship, gBattleTerrain, ...), built from the live battle state.

import { tonumber } from "../../../../import/gen3/lua.ts";
import { NotPortedError } from "../../notported.ts";
import { Anim } from "./anim.ts";
import { AnimCoords } from "./anim_coords.ts";
import { BattleBg } from "./bg.ts";
import { Battle } from "./init.ts";
import { Moves } from "./moves.ts";

// Lua: anim_ctx.lua:6
function battle_state(): any {
  // package.loaded["src.core.game3.battle"]
  const B: any = Battle;
  return B != null ? B._st : undefined;
}

// Lua: anim_ctx.lua:11
function battler_id(key: unknown): number {
  return AnimCoords.fixedId(key) ?? ((key === "enemy") ? 1 : 0);
}

// Lua: anim_ctx.lua:16 -- pokefirered/src/battle_anim_utility_funcs.c:840
function terrain_id(st: any): number | null {
  const v = st ? tonumber(st.terrain) : undefined;
  if (v != null) return v;
  // pcall(require, "src.core.game3.battle.bg")
  try {
    return BattleBg.terrainId ? (BattleBg.terrainId() ?? null) : null;
  } catch (e) {
    if (e instanceof NotPortedError) return null;
    throw e;
  }
}

export const AnimCtx: Record<string, any> = {
  // Lua: anim_ctx.lua:23
  behindSubstitute(lowered?: any): any {
    const out = AnimCoords.idTable();
    for (let id = 0; id <= 3; id++) {
      const p = Anim._present[id];
      const low = lowered ? (lowered[id] ?? (id < 2 ? lowered[AnimCoords.sideOf(id)] : null)) : null;
      out[id] = !!((p && p.substitute) || (low != null && low !== false));
    }
    return out;
  },

  // Lua: anim_ctx.lua:34 -- pokefirered/src/battle_controller_player.c:2316
  build(attackerIn?: unknown, targetIn?: unknown, opts?: Record<string, any>): Record<string, any> {
    opts = opts || {};
    const st = battle_state();
    const attacker = attackerIn ?? "player";
    const target = targetIn ?? attacker;
    const atkId = battler_id(attacker);
    const a = AnimCoords.battler(st, atkId);
    const mon = (a && a.mon) || {};
    const ap = Anim._present[atkId];
    const ctx: Record<string, any> = {
      behindSubstitute: AnimCtx.behindSubstitute(opts.lowered),
      battlerAttacker: atkId,
      battlerTarget: battler_id(target),
      effectBattler: battler_id(opts.effectBattler ?? target),
      isDouble: AnimCoords.isDouble(st),
      animArg: tonumber(opts.animArg) ?? 0,
      movePower: 0,
      moveDmg: tonumber(opts.moveDmg) ?? 0,
      friendship: tonumber(mon.friendship ?? mon.happiness) ?? 0,
      weather: st ? (st.weather ?? null) : null,
      battleTerrain: terrain_id(st),
      furyCutterCounter: a ? (tonumber(a.expFuryCutter) ?? 0) : 0,
      rolloutTimer: a ? (tonumber(a.expRolloutTimer) ?? 0) : 0,
      rolloutTimerStartValue: 5,
      attackerHp: (ap && ap.displayHp) ?? tonumber(mon.hp) ?? 0,
      attackerMaxHp: (ap && ap.displayMaxHp) ?? tonumber(mon.maxHp) ?? 1,
      playerGender: st ? (st.playerGender ?? 0) : 0,
      lastUsedItem: st ? (st.lastUsedItem ?? null) : null,
      ballThrowCaseId: st ? (st.ballThrowCaseId ?? 0) : 0,
      // pokefirered/src/battle_anim_special.c:2273
      safariReaction: (st ? tonumber(st.safariReaction) : undefined) ?? 0,
      oldManTutorial: st ? (st.oldManTutorial ?? false) : false,
      wallyTutorial: !!(st && st.kinds && st.kinds.tutorial === "wally"),
      pokeball: mon.pokeball,
      ballItem: {
        player: st && st.player && st.player.mon && st.player.mon.pokeball,
        enemy: st && st.enemy && st.enemy.mon && st.enemy.mon.pokeball,
      },
    };
    ctx.animMoveDmg = ctx.moveDmg;
    ctx.damage = ctx.moveDmg;
    ctx.animFriendship = ctx.friendship;
    ctx.weatherMoveAnim = ctx.weather;
    ctx.furyCutter = ctx.furyCutterCounter;
    if (opts.moveId != null && opts.moveId !== false) {
      const M: any = Moves;
      const mv = M.get ? M.get(opts.moveId) : null;
      ctx.movePower = mv ? (tonumber(mv.power) ?? 0) : 0;
    }
    return ctx;
  },
};

export default AnimCtx;
