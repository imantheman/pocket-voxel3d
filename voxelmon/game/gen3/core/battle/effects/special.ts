// Port of gen1recomp src/core/game3/battle/effects/special.lua (GPLv3 + additional terms; see LICENSE.md).
// Special status moves: Roar, Conversion 1/2, Transform, Mimic, Disable,
// Sketch, Baton Pass, Teleport, Follow Me, Trick, Recycle.
//
// Port notes:
// - engine() / state() / moves() and the other lazy requires are static
//   imports, used only inside the functions.
// - rawset(proxy, k, v) on State.ensureBattleMoves' proxy (a table whose
//   __newindex writes through to the party mon) defines an own property on
//   the proxy object (Object.defineProperty), which bypasses a write-through
//   set trap the same way rawset bypasses __newindex.
// - Abilities.escapeBlocker returns (foe, ability): a tuple.
// - BattleText.key returns (key, fill): Brian takes the first value.
// - Coroutines go through the engine's shim (engine.ts: CoYield):
//   coroutine.running() is Engine.coRunning(), and Baton Pass's
//   coroutine.yield({kind = "baton_pass"}) throws Engine.coYield(req, cont),
//   where cont is the rest of batonPass (finish) given the resumed value.
//   Effects.run carries the yield through its pcall (effects/init.ts).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { truthy, tonumber } from "../../../../../import/gen3/lua.ts";
import { ipairs, pairs, len, seq, type LuaTable } from "../../../platform/lt.ts";
import type { EffectContext } from "../effect_ctx.ts";
import H from "./_helpers.ts";
import Types from "../types.ts";
import Secondary from "./secondary.ts";
import BattleText from "../battle_text.ts";
import EngineMod from "../engine.ts";
import StateMod from "../state.ts";
import MovesMod from "../moves.ts";
import Pokemon from "../../pokemon.ts";
import SwitchSeq from "../switch_seq.ts";
import Damage from "../damage.ts";
import Abilities from "../abilities.ts";
import BattleProfile from "../profile.ts";

function lor(a: any, b: any): any {
  return truthy(a) ? a : b;
}

/** Lua rawset: an own property, past any write-through proxy. */
function rawset(t: any, k: string, v: any): void {
  Object.defineProperty(t, k, { value: v, writable: true, enumerable: true, configurable: true });
}

/** coroutine.running(): truthy inside an engine coroutine (engine.ts shim). */
function coroutine_running(): boolean {
  return EngineMod.coRunning();
}

// Lua: special.lua:8
function engine(): any { return EngineMod; }
// Lua: special.lua:9
function state(): any { return StateMod; }
// Lua: special.lua:10
function moves(): any { return MovesMod; }
// Lua: special.lua:11
function move_name(id: any): any { return Pokemon.moveName(H.moveNum(id)); }

// Lua: special.lua:13
function end_battle(ctx: EffectContext, reason: string): void {
  const st = ctx.adapter._st;
  st.over = true;
  st.result = "run";
  st.endReason = reason;
  ctx.adapter.pushEvent({ kind: "end", result: "run", reason });
}

// Lua: special.lua:21
function sent_out_fill(ctx: EffectContext, battler: any): any {
  return SwitchSeq.switchInFill(ctx.adapter._st, battler);
}

export const Special = {
  // Lua: special.lua:26
  // pokefirered/src/battle_script_commands.c:6905
  roar(ctx: EffectContext): any {
    const ad = ctx.adapter, user = ctx.user, target = ctx.target;
    const st = ad._st;
    if (ad.abilityOf(target) === "SUCTION_CUPS") {
      return ad.sayText("STRINGID_PKMNANCHORSITSELFWITH", { def: target, defAbility: H.abilityId("SUCTION_CUPS") });
    }
    if (truthy(target.expIngrain)) {
      return ad.sayText("STRINGID_PKMNANCHOREDITSELF", { def: target });
    }
    if (!truthy(H.accuracy(ctx, "lockon"))) return;
    if (!truthy(H.accuracy(ctx, "normal"))) return;
    const candidates = engine().switchCandidates(st, truthy(st.double) ? target.id : target.side);
    if (!truthy(st.wild) && len(candidates) < 1) return H.sayFail(ctx);
    const uLvl = tonumber(truthy(user.mon) ? user.mon.level : user.mon) ?? 1;
    const tLvl = tonumber(truthy(target.mon) ? target.mon.level : target.mon) ?? 1;
    if (uLvl < tLvl) {
      const r = ad.roll(0, 255);
      if (Math.floor(r * (uLvl + tLvl) / 256) + 1 <= Math.floor(tLvl / 4)) {
        return H.sayFail(ctx);
      }
    }
    H.attackAnim(ctx);
    if (truthy(st.wild)) {
      // pokefirered/data/battle_scripts_1.s:3283
      ad.pushEvent({ kind: "switch_out", side: target.side, reason: "roar" });
      end_battle(ctx, "roar");
      return;
    }
    const slot = candidates[ad.roll(1, len(candidates))];
    const nb = engine().performSwitch(st, ad, truthy(st.double) ? target.id : target.side, slot, { reason: "roar" });
    if (truthy(nb)) {
      const M = H.move(ctx);
      if (truthy(M)) M.target = nb;
      ad.sayText("STRINGID_PKMNWASDRAGGEDOUT", { def: nb });
      engine().switchInEffects(st, ad, nb, { spikes: true, deferIntimidate: true });
    }
  },

  // Lua: special.lua:65
  // pokefirered/src/battle_script_commands.c:7003
  conversion(ctx: EffectContext): void {
    const ad = ctx.adapter, user = ctx.user;
    const mon = lor(user.mon, {});
    const list: LuaTable = [null];
    for (let i = 1; i <= 4; i++) {
      const mv = H.moveNum(truthy(mon.moves) ? mon.moves[i] : mon.moves);
      if (!truthy(mv) || mv === 0) break;
      let t = tonumber(moves().get(mv).type) ?? 0;
      if (t === Types.ID.MYSTERY) {
        t = H.hasType(ctx, user, Types.ID.GHOST) ? Types.ID.GHOST : Types.ID.NORMAL;
      }
      if (!H.hasType(ctx, user, t)) list[len(list) + 1] = t;
    }
    if (len(list) === 0) return H.sayFail(ctx);
    const t = list[ad.roll(1, len(list))];
    user.type1 = t; user.type2 = t;
    H.attackAnim(ctx);
    ad.sayText("STRINGID_PKMNCHANGEDTYPE", { atk: user, buff1: Types.name(t) });
  },

  // Lua: special.lua:86
  // pokefirered/src/battle_script_commands.c:7699
  conversion2(ctx: EffectContext): void {
    const ad = ctx.adapter, user = ctx.user;
    const last = user.expLastLandedMove;
    const lastType = user.expLastHitByType;
    if (!truthy(last) || last === 0 || lastType == null) return H.sayFail(ctx);
    let foe = ad.foeOf(user);
    if (truthy(ad._st.double) && user.expLastHitById != null) {
      foe = lor(state().battler(ad._st, user.expLastHitById), foe);
    }
    if (truthy(engine().isTwoTurnMove(last)) && truthy(foe) && truthy(foe.twoTurnMove)) return H.sayFail(ctx);
    const valid: LuaTable = [null];
    const t = Types.TABLE;
    let i = 1;
    while (i <= len(t)) {
      const a = t[i], d = t[i + 1], m = t[i + 2];
      if (a === -1) break;
      if (a === lastType && (m as number) <= 5 && !H.hasType(ctx, user, d)) valid[len(valid) + 1] = d;
      i = i + 3;
    }
    if (len(valid) === 0) return H.sayFail(ctx);
    const pick = valid[ad.roll(1, len(valid))];
    user.type1 = pick; user.type2 = pick;
    H.attackAnim(ctx);
    ad.sayText("STRINGID_PKMNCHANGEDTYPE", { atk: user, buff1: Types.name(pick) });
  },

  // Lua: special.lua:113
  // pokefirered/src/battle_script_commands.c:7398
  transform(ctx: EffectContext): void {
    const ad = ctx.adapter, user = ctx.user, target = ctx.target;
    if (truthy(target.transformed) || truthy(target.semiInvulnerable)) return H.sayFail(ctx);
    const proxy = state().ensureBattleMoves(user);
    const tm = lor(target.mon, {});
    rawset(proxy, "attack", Damage.monStat(tm, "attack", 50));
    rawset(proxy, "defense", Damage.monStat(tm, "defense", 50));
    rawset(proxy, "speed", Damage.monStat(tm, "speed", 50));
    rawset(proxy, "spAtk", Damage.monStat(tm, "spAtk", 50));
    rawset(proxy, "spDef", Damage.monStat(tm, "spDef", 50));
    rawset(proxy, "atk", proxy.attack);
    rawset(proxy, "def", proxy.defense);
    rawset(proxy, "spe", proxy.speed);
    rawset(proxy, "spa", proxy.spAtk);
    rawset(proxy, "spd", proxy.spDef);
    rawset(proxy, "ivs", tm.ivs);
    rawset(proxy, "species", tm.species);
    for (let i = 1; i <= 4; i++) {
      const mv = truthy(tm.moves) ? tm.moves[i] : tm.moves;
      proxy.moves[i] = mv;
      if (truthy(mv) && mv !== 0) {
        const pp = tonumber(moves().get(mv).pp) ?? 5;
        proxy.pp[i] = Math.min(5, pp);
      } else {
        proxy.pp[i] = null;
      }
    }
    for (const [k, v] of pairs(lor(target.stages, {}))) user.stages[k] = v;
    user.type1 = target.type1; user.type2 = target.type2;
    user.ability = target.ability;
    user.expTracedAbility = target.expTracedAbility;
    user.transformed = true;
    user.expTransform = {
      species: target.species, type1: target.type1, type2: target.type2,
      // pokefirered/src/battle_script_commands.c:7416
      personality: truthy(target.mon) ? target.mon.personality : target.mon,
    };
    user.expDisabledMove = null;
    user.expDisableTurns = null;
    user.permanentSlots = seq(false, false, false, false);
    H.attackAnim(ctx);
    ad.sayText("STRINGID_PKMNTRANSFORMEDINTO", { atk: user, buff1: Pokemon.name(target.species) });
  },

  // Lua: special.lua:158
  // pokefirered/src/battle_script_commands.c:7478
  mimic(ctx: EffectContext): void {
    const ad = ctx.adapter, user = ctx.user, target = ctx.target;
    if (lor(target.substituteHP, 0) > 0) return H.sayFail(ctx);
    if (!truthy(H.accuracy(ctx, "lockon"))) return;
    const last = H.moveNum(H.lastMove(ctx, target));
    if (!truthy(last) || last === 0 || truthy(user.transformed) || truthy(engine().isForbiddenToCopy(last, true))) {
      return H.sayFail(ctx);
    }
    if (truthy(H.slotOf(user, last))) return H.sayFail(ctx);
    const M = H.move(ctx);
    const slot = truthy(M) ? M.slot : M;
    if (!truthy(slot)) return H.sayFail(ctx);
    const proxy = state().ensureBattleMoves(user);
    proxy.moves[slot] = last;
    proxy.pp[slot] = Math.min(5, tonumber(moves().get(last).pp) ?? 5);
    user.permanentSlots[slot] = false;
    H.attackAnim(ctx);
    ad.sayText("STRINGID_PKMNLEARNEDMOVE2", { atk: user, buff1: move_name(last) });
  },

  // Lua: special.lua:179
  // pokefirered/src/battle_script_commands.c:7617
  disable(ctx: EffectContext): void {
    const ad = ctx.adapter, target = ctx.target;
    if (!truthy(H.accuracy(ctx, "normal"))) return;
    const last = H.lastMove(ctx, target);
    const slot: any = truthy(last) ? H.slotOf(target, last) : last;
    const mon = target.mon;
    if (truthy(target.expDisabledMove) || !truthy(slot) || !truthy(mon) || !truthy(mon.pp) || (tonumber(mon.pp[slot]) ?? 0) <= 0) {
      return H.sayFail(ctx);
    }
    target.expDisabledMove = H.moveNum(mon.moves[slot]);
    target.expDisableTurns = ad.roll(0, 3) % 4 + 2;
    target.disabled = true;
    H.attackAnim(ctx);
    ad.sayText("STRINGID_PKMNMOVEWASDISABLED", { def: target, buff1: move_name(mon.moves[slot]) });
  },

  // Lua: special.lua:196
  // pokefirered/src/battle_script_commands.c:7768
  sketch(ctx: EffectContext): void {
    const ad = ctx.adapter, user = ctx.user, target = ctx.target;
    if (lor(target.substituteHP, 0) > 0) return H.sayFail(ctx);
    const last = H.moveNum(target.expLastPrinted);
    if (truthy(user.transformed) || !truthy(last) || last === 0 || last === 165 || last === 166) return H.sayFail(ctx);
    const mon = lor(user.mon, {});
    for (let i = 1; i <= 4; i++) {
      const mv = H.moveNum(truthy(mon.moves) ? mon.moves[i] : mon.moves);
      if (mv !== 166 && mv === last) return H.sayFail(ctx);
    }
    const M = H.move(ctx);
    const slot = truthy(M) ? M.slot : M;
    if (!truthy(slot)) return H.sayFail(ctx);
    const fullPp = tonumber(moves().get(last).pp) ?? 5;
    const party = state().partyMon(user);
    if (truthy(party)) {
      party.moves = lor(party.moves, [null]);
      party.pp = lor(party.pp, [null]);
      party.moves[slot] = last;
      party.pp[slot] = fullPp;
    }
    if (truthy(user._partyMon)) {
      user.mon.moves[slot] = last;
      user.mon.pp[slot] = fullPp;
      user.sketched = lor(user.sketched, {});
      user.sketched[slot] = true;
    }
    H.attackAnim(ctx);
    ad.sayText("STRINGID_PKMNSKETCHEDMOVE", { atk: user, buff1: move_name(last) });
  },

  // Lua: special.lua:228
  // pokefirered/data/battle_scripts_1.s:1690
  batonPass(ctx: EffectContext): void {
    const ad = ctx.adapter, user = ctx.user;
    const st = ad._st;
    const candidates = engine().switchCandidates(st, truthy(st.double) ? user.id : user.side);
    if (len(candidates) === 0) return H.sayFail(ctx);
    H.attackAnim(ctx);
    // The rest of batonPass once `pick` is known (also the coroutine
    // continuation of the two yields below).
    const finish = (pick: any): void => {
      let slot = candidates[1];
      for (const [, c] of ipairs(candidates)) {
        if (c === pick) slot = pick;
      }
      const nb = engine().performSwitch(st, ad, truthy(st.double) ? user.id : user.side, slot, { batonPass: true, reason: "baton_pass" });
      if (truthy(nb)) {
        const M = H.move(ctx);
        if (truthy(M)) M.user = nb;
        const fill = sent_out_fill(ctx, nb);
        const text = BattleText.get(BattleText.SWITCHINMON, fill);
        // pokefirered/data/battle_scripts_1.s:1705
        ad.pushEvent({ kind: "msg", text, wait: 0, id: BattleText.key(BattleText.SWITCHINMON, fill)[0] });
        ad._say(text);
        engine().switchInEffects(st, ad, nb, { spikes: true, deferIntimidate: true });
      }
    };
    let pick: any;
    if (typeof st.batonPassChooser === "function") {
      let ok = true, v: any;
      try { v = st.batonPassChooser(user.side, candidates); } catch (e) { ok = false; v = e; }
      if (ok) pick = tonumber(v);
    } else if (truthy(st.link) && truthy(st.interactiveChoices) && coroutine_running()) {
      // pokefirered/src/battle_script_commands.c:4626
      throw engine().coYield({ kind: "baton_pass", side: user.side, battler: user.id, candidates },
        (v: any) => finish(tonumber(v)));
    } else if (user.side === "player" && truthy(st.interactiveChoices) && coroutine_running()) {
      // pokefirered/src/battle_script_commands.c:4626
      throw engine().coYield({ kind: "baton_pass", side: user.side, battler: user.id, candidates },
        (v: any) => finish(tonumber(v)));
    } else if (user.side === "enemy") {
      // pokefirered/src/battle_controller_opponent.c:1410
      pick = engine().mostSuitableMon(st, ad, truthy(st.double) ? user.id : "enemy");
    }
    finish(pick);
  },

  // Lua: special.lua:266
  // pokefirered/data/battle_scripts_1.s:1921
  teleport(ctx: EffectContext): any {
    const ad = ctx.adapter, user = ctx.user;
    const st = ad._st;
    if (!truthy(st.wild)) return H.sayFail(ctx);
    const item = tonumber(user.item) ?? 0;
    const ab = ad.abilityOf(user);
    let foe = ad.foeOf(user);
    let fab = truthy(foe) ? ad.abilityOf(foe) : foe;
    if (truthy(ad._st.double)) {
      const r = Abilities.escapeBlocker(ad, user) ?? [];
      foe = r[0]; fab = r[1];
    }
    if (!(ab === "RUN_AWAY" || item === 194)) {
      if (fab === "SHADOW_TAG" || (fab === "ARENA_TRAP" && !H.hasType(ctx, user, Types.ID.FLYING) && ab !== "LEVITATE")
          || (fab === "MAGNET_PULL" && H.hasType(ctx, user, Types.ID.STEEL))) {
        return ad.sayText("STRINGID_PKMNSXMADEITINEFFECTIVE", { scrActive: foe, scrActiveAbility: H.abilityId(fab) });
      }
      if (truthy(user.expTrapped) || truthy(user.escapePrevention) || lor(user.expTrapTurns, 0) > 0 || truthy(user.expIngrain)) {
        return H.sayFail(ctx);
      }
    }
    H.attackAnim(ctx);
    ad.sayText("STRINGID_PKMNFLEDFROMBATTLE", { atk: user });
    end_battle(ctx, "teleport");
    // pokeemerald/src/battle_script_commands.c:6487
    if (BattleProfile.rule(st, "teleportOutcome") === "side") {
      st.result = (user.side === "player") ? "player_teleported" : "mon_teleported";
    }
  },

  // Lua: special.lua:297
  // pokefirered/src/battle_script_commands.c:8702
  followMe(ctx: EffectContext): void {
    const side = ctx.adapter.ownSide(ctx.user);
    if (truthy(side)) {
      side.expFollowMe = ctx.user;
      side.expFollowMeId = ctx.user.id;
    }
    H.attackAnim(ctx);
    ctx.adapter.sayText("STRINGID_PKMNCENTERATTENTION", { atk: ctx.user });
  },

  // Lua: special.lua:308
  // pokefirered/src/battle_script_commands.c:8798
  trick(ctx: EffectContext): any {
    const ad = ctx.adapter, user = ctx.user, target = ctx.target;
    if (lor(target.substituteHP, 0) > 0) return H.sayFail(ctx);
    if (!truthy(H.accuracy(ctx, "normal"))) return;
    // src/battle_script_commands.c:8799-8810
    const StType = ad._st;
    if (truthy(StType) && truthy(StType.trainerTower)) return H.sayFail(ctx);
    if (user.side !== "player" && !(truthy(StType) && (truthy(StType.link) || truthy(StType.battleTower)
        || truthy(StType.eReader) || truthy(StType.secretBase)))) {
      return H.sayFail(ctx);
    }
    const St = state();
    if (truthy(user.expKnockedOff) || truthy(target.expKnockedOff)
        || (truthy(St) && (truthy(St.isKnockedOff(ad._st, user)) || truthy(St.isKnockedOff(ad._st, target))))) {
      return H.sayFail(ctx);
    }
    const ui = tonumber(user.item) ?? 0, ti = tonumber(target.item) ?? 0;
    if ((ui === 0 && ti === 0) || ui === 175 || ti === 175 || Secondary.isMail(ui) || Secondary.isMail(ti)) {
      return H.sayFail(ctx);
    }
    if (ad.abilityOf(target) === "STICKY_HOLD") {
      return ad.sayText("STRINGID_PKMNSXMADEYINEFFECTIVE", {
        def: target, defAbility: H.abilityId("STICKY_HOLD"), currentMove: H.moveNum(lor(ctx.move, ctx.moveId)),
      });
    }
    user.item = ti; target.item = ui;
    Secondary.persistItem(user, ti);
    // Both sides: the target's party mon must take the item its battler now
    // holds, or it keeps the old one and duplicates it on switch-out.
    Secondary.persistItem(target, ui);
    H.attackAnim(ctx);
    ad.sayText("STRINGID_PKMNSWITCHEDITEMS", { atk: user });
    // src/battle_script_commands.c:8870
    if (ui !== 0 && ti !== 0) {
      ad.sayText("STRINGID_PKMNOBTAINEDXYOBTAINEDZ", {
        atk: user, def: target, buff1: Secondary.itemName(ti), buff2: Secondary.itemName(ui),
      });
    } else if (ti !== 0) {
      ad.sayText("STRINGID_PKMNOBTAINEDX", { atk: user, buff1: Secondary.itemName(ti) });
    } else {
      ad.sayText("STRINGID_PKMNOBTAINEDX2", { def: target, buff2: Secondary.itemName(ui) });
    }
  },

  // Lua: special.lua:353
  // pokefirered/src/battle_script_commands.c:9366
  recycle(ctx: EffectContext): void {
    const ad = ctx.adapter, user = ctx.user;
    const side = ad.ownSide(user);
    const used = tonumber(truthy(side) ? side.expUsedHeldItem : side) ?? tonumber(user.expUsedHeldItem) ?? 0;
    if (used === 0 || (tonumber(user.item) ?? 0) !== 0) return H.sayFail(ctx);
    user.expUsedHeldItem = null;
    if (truthy(side)) side.expUsedHeldItem = null;
    user.item = used;
    Secondary.persistItem(user, used);
    H.attackAnim(ctx);
    ad.sayText("STRINGID_XFOUNDONEY", { atk: user, lastItem: used });
  },
};

export default Special;
