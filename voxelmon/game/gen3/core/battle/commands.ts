// Port of gen1recomp src/core/game3/battle/commands.lua (GPLv3 + additional terms; see LICENSE.md).
// Battle commands: FIGHT / BAG / POKéMON / RUN (+ move slots).
//
// Port notes:
// - pcall(require, ...), lazy requires and package.loaded probes of
//   moves / state / profile / pokemon / ai / engine / battle / Gen3Compat /
//   link_guard are static imports, always "loaded".
// - Multiple returns are tuples: fightShortcut -> [act, text?] (or [null]);
//   Engine.canSwitch -> [ok, why]; Engine.tryFlee -> [ok, how].

import { tonumber, tostring, truthy } from "../../../../import/gen3/lua.ts";
import { ipairs, pairs, seq, type LuaTable } from "../../platform/lt.ts";
import { Runtime as ModRuntime } from "../../shared/mods/Runtime.ts";
import { Gen3Compat } from "../../shared/mods/Gen3Compat.ts";
import { RomText } from "../rom_text.ts";
import { Pokemon } from "../pokemon.ts";
import { BattleText } from "./battle_text.ts";
import { Moves } from "./moves.ts";
import { State } from "./state.ts";
import { BattleProfile } from "./profile.ts";
import { Ai } from "./ai.ts";
import { Engine } from "./engine.ts";
import { Battle } from "./init.ts";
import { Guard } from "./link_guard.ts";

export type Action = Record<string, any>;

const MENU = seq("FIGHT", "BAG", "POKEMON", "RUN");
// pokefirered/src/battle_controller_safari.c:162
const SAFARI_MENU = seq("BALL", "BAIT", "ROCK", "RUN");

// Lua: commands.lua:19
function battler_of(st: any, id: number | null | undefined): any {
  if (id == null || id === 0) return truthy(st) ? st.player : st;
  if (id === 1) return truthy(st) ? st.enemy : st;
  return truthy(st) && truthy(st.battlers) ? st.battlers[id] : null;
}

// Lua: commands.lua:25
function move_target_type(mv: any): number | null {
  // Lua: pcall(require, "src.core.game3.battle.moves") -- always loads here
  if (mv == null) return null;
  const m = Moves.get(mv);
  return tonumber(truthy(m) ? m.target : null) ?? 0;
}

// Lua: commands.lua:32
function tag(act: Action | null | undefined, id?: number | null, targetId?: number | null): any {
  if (!truthy(act)) return act;
  const a = act as Action;
  a.battler = id ?? 0;
  if (targetId != null) a.target = targetId;
  if (a.kind === "move") a.targetType = move_target_type(a.move);
  return a;
}

const MOVE_STRUGGLE = 165;
const ITEM_CHOICE_BAND = 186;

// Lua: commands.lua:87
function move_num(mv: any): number {
  const n = tonumber(mv);
  if (n != null) return n;
  if (mv == null || mv === "") return 0;
  // Lua: pcall(require, "src.core.game3.battle.moves") -- always loads here
  if (truthy(Moves.numForName)) return Moves.numForName(mv) ?? 0;
  return 0;
}

// Lua: commands.lua:96
function move_name(mv: any): any {
  return Moves.displayName(mv);
}

// Lua: commands.lua:101
function foe_of(st: any, b: any): any {
  if (!truthy(st) || !truthy(b)) return null;
  return (b.side === "enemy") ? st.player : st.enemy;
}

// Lua: commands.lua:106
function foes_of(st: any, b: any): LuaTable {
  if (truthy(st) && truthy(st.double)) {
    return State.foes(st, b);
  }
  return seq(foe_of(st, b));
}

// Lua: commands.lua:114
function imprisoned(st: any, b: any, num: number): boolean {
  for (const [, foe] of ipairs<any>(foes_of(st, b))) {
    if (truthy(foe) && truthy(foe.expImprison) && truthy(foe.mon) && truthy(foe.mon.moves)) {
      for (let i = 1; i <= 4; i++) {
        if (move_num(foe.mon.moves[i]) === num && num !== 0) return true;
      }
    }
  }
  return false;
}

// Lua: commands.lua:125
function choiced(b: any): number | null {
  const cm = truthy(b) ? move_num(b.choicedMove) : 0;
  if ((tonumber(truthy(b) ? b.item : null) ?? 0) !== ITEM_CHOICE_BAND) return null;
  if (cm === 0 || cm === 0xFFFF) return null;
  return cm;
}

// Lua: commands.lua:256 -- battle_controller_opponent.c:1339
function first_usable_action(b: any, id: number | null | undefined): Action {
  const mon = truthy(b) ? b.mon : null;
  for (let i = 1; i <= 4; i++) {
    const mv = truthy(mon) && truthy(mon.moves) ? mon.moves[i] : null;
    const p = truthy(mon) && truthy(mon.pp) ? mon.pp[i] : null;
    if (truthy(mv) && mv !== 0 && mv !== "" && (p == null || (tonumber(p) as number) > 0)) {
      return { kind: "move", move: mv, slot: i, user: "enemy", battler: id };
    }
  }
  return { kind: "move", move: "STRUGGLE", slot: null, user: "enemy", battler: id };
}

// Lua: commands.lua:268
function vanilla_enemy_action(st: any, battlerId: number | null | undefined): any {
  const id = battlerId ?? 1;
  if (truthy(st) && truthy(st.double)) {
    const b = battler_of(st, id);
    let act: any;
    let ok: boolean, res: any;
    try {
      res = truthy(Ai.chooseAction) ? Ai.chooseAction(st, id) : Ai.chooseMove(st, { battler: id });
      ok = true;
    } catch (e) {
      ok = false;
      res = e;
    }
    if (ok && truthy(res) && truthy(res.kind) && (res.battler === id || (res.battler == null && id === 1))) act = res;
    act = act ?? first_usable_action(b, id);
    return tag(act, id, act.target);
  }
  let ok: boolean, act: any;
  try {
    act = truthy(Ai.chooseAction) ? Ai.chooseAction(st, 1) : Ai.chooseMove(st);
    ok = true;
  } catch (e) {
    ok = false;
    act = e;
  }
  if (ok && truthy(act) && act.kind === "move") {
    act.battler = (battlerId != null) ? 1 : null;
    return act;
  }
  if (ok && truthy(act) && (act.kind === "switch" || act.kind === "item" || act.kind === "run" || act.kind === "watch")) {
    act.battler = 1;
    return act;
  }
  const fb = first_usable_action(st.enemy, null);
  fb.battler = null;
  if (battlerId != null) fb.battler = 1;
  return fb;
}

// Lua: commands.lua:301
function normalize_enemy_action(st: any, res: any, battlerId: number | null | undefined): any {
  const id = battlerId ?? 1;
  if (typeof res === "string" || typeof res === "number") res = { kind: "move", move: res };
  if (res === null || typeof res !== "object") return null;
  const act: Action = {};
  for (const [k, v] of pairs(res)) act[k] = v;
  act.kind = truthy(act.kind) ? act.kind : "move";
  if (act.kind === "move") {
    const ref = truthy(act.move) ? act.move : act.id;
    const num = ref != null ? Gen3Compat.moveId(ref) : null;
    if (!truthy(num)) return null;
    const b = battler_of(st, id);
    const moves = (truthy(b) && truthy(b.mon) && truthy(b.mon.moves)) ? b.mon.moves : {};
    act.move = num;
    act.id = null;
    if (!truthy(act.slot) || tonumber(moves[act.slot]) !== num) {
      act.slot = null;
      for (let i = 1; i <= 4; i++) {
        if (tonumber(moves[i]) === num) { act.slot = i; break; }
      }
    }
  }
  act.user = truthy(act.user) ? act.user : "enemy";
  if (truthy(st) && truthy(st.double)) return tag(act, id, act.target);
  act.battler = (battlerId != null) ? 1 : null;
  return act;
}

export const Commands = {
  MENU,
  SAFARI_MENU,

  // Lua: commands.lua:14
  menuFor(st: any): LuaTable {
    if (truthy(st) && truthy(st.safari)) return Commands.SAFARI_MENU;
    return Commands.MENU;
  },

  /** Build a player action from menu selection. menuIndex 1..4; moveSlot 1..4 when FIGHT. */
  // Lua: commands.lua:42
  playerAction(st: any, menuIndex?: number | null, moveSlot?: number | null, battlerId?: number | null, targetId?: number | null): any {
    if (battlerId != null || targetId != null) {
      const b = battler_of(st, battlerId);
      const act = Commands.playerAction({ player: b, safari: truthy(st) ? st.safari : st }, menuIndex, moveSlot, null, null);
      return tag(act, battlerId ?? 0, targetId);
    }
    menuIndex = menuIndex ?? 1;
    if (truthy(st) && truthy(st.safari)) {
      // pokefirered/src/battle_controller_safari.c:162
      const sf = BattleProfile.of(st).safari;
      const list = (truthy(sf) && truthy(sf.actions)) ? sf.actions : seq("ball", "bait", "rock", "run");
      const act = list[menuIndex] ?? "ball";
      if (act === "run") return { kind: "run", user: "player", safariRun: true };
      return { kind: "safari", action: act, user: "player" };
    }
    const kind = Commands.MENU[menuIndex] ?? "FIGHT";
    if (kind === "FIGHT") {
      const mon = truthy(st.player) ? st.player.mon : st.player;
      const slot = moveSlot ?? 1;
      const move = truthy(mon) && truthy(mon.moves) ? mon.moves[slot] : null;
      const pp = truthy(mon) && truthy(mon.pp) ? mon.pp[slot] : null;
      if (!truthy(move) || move === 0 || move === "" || (pp != null && (tonumber(pp) as number) <= 0)) {
        // Fall back to first usable
        for (let i = 1; i <= 4; i++) {
          const mv = truthy(mon) && truthy(mon.moves) ? mon.moves[i] : null;
          const p = truthy(mon) && truthy(mon.pp) ? mon.pp[i] : null;
          if (truthy(mv) && mv !== 0 && mv !== "" && (p == null || (tonumber(p) as number) > 0)) {
            return { kind: "move", move: mv, slot: i, user: "player" };
          }
        }
        return { kind: "move", move: "STRUGGLE", slot: null, user: "player" };
      }
      return { kind: "move", move, slot, user: "player" };
    } else if (kind === "RUN") {
      return { kind: "run", user: "player" };
    } else if (kind === "BAG") {
      return { kind: "bag", user: "player" };
    } else if (kind === "POKEMON") {
      return { kind: "switch", user: "player" };
    }
    throw new Error("unknown battle menu command " + tostring(kind));
  },

  // Lua: commands.lua:133 -- pokefirered/src/battle_util.c:302
  selectionError(st: any, slot: number | null | undefined, battlerId?: number | null): any {
    const b = battler_of(st, battlerId);
    const mon = truthy(b) ? b.mon : null;
    if (!truthy(mon) || !truthy(slot)) return null;
    const mv = truthy(mon.moves) ? mon.moves[slot as number] : null;
    const num = move_num(mv);
    const fill = { active: b, currentMove: move_name(mv), trainer: truthy(st) && !truthy(st.wild) };
    let err: any = null;
    if (truthy(b.expDisabledMove) && move_num(b.expDisabledMove) === num && num !== 0) {
      err = BattleText.get("STRINGID_PKMNMOVEISDISABLED", fill);
    }
    if ((truthy(b.expTormented) || truthy(b.torment)) && num !== MOVE_STRUGGLE && num !== 0
        && move_num(truthy(b.lastMoveId) ? b.lastMoveId : b.lastMove) === num) {
      err = BattleText.get("STRINGID_PKMNCANTUSEMOVETORMENT", fill);
    }
    if ((tonumber(b.expTauntedTurns) ?? 0) > 0) {
      const def = Moves.get(mv);
      if (truthy(def) && (tonumber(def.power) ?? 0) === 0) {
        err = BattleText.get("STRINGID_PKMNCANTUSEMOVETAUNT", fill);
      }
    }
    if (imprisoned(st, b, num)) {
      err = BattleText.get("STRINGID_PKMNCANTUSEMOVESEALED", fill);
    }
    const cm = choiced(b);
    if (truthy(cm) && cm !== num) {
      // pokefirered/src/battle_util.c:348
      err = BattleText.get("STRINGID_ITEMALLOWSONLYYMOVE", { lastItem: b.item, currentMove: move_name(cm) });
    }
    const pp = truthy(mon.pp) ? tonumber(mon.pp[slot as number]) : null;
    if (pp != null && pp <= 0) {
      err = BattleText.get("STRINGID_NOPPLEFT");
    }
    return err;
  },

  // Lua: commands.lua:171 -- pokefirered/src/battle_util.c:361
  moveUsable(st: any, slot: number, battlerId?: number | null): boolean {
    const b = battler_of(st, battlerId);
    const mon = truthy(b) ? b.mon : null;
    const mv = truthy(mon) && truthy(mon.moves) ? mon.moves[slot] : null;
    if (move_num(mv) === 0) return false;
    return Commands.selectionError(st, slot, battlerId) == null;
  },

  /** -> [act, text] when no move is usable (Struggle), [act] under Encore, else [null]. */
  // Lua: commands.lua:180 -- pokefirered/src/battle_main.c:3146
  fightShortcut(st: any, battlerId?: number | null): [any, any?] {
    const b = battler_of(st, battlerId);
    if (!truthy(b) || !truthy(b.mon)) return [null];
    let any = false;
    for (let i = 1; i <= 4; i++) {
      if (Commands.moveUsable(st, i, battlerId)) { any = true; break; }
    }
    if (!any) {
      const act: Action = { kind: "move", move: "STRUGGLE", slot: null, user: "player" };
      if (battlerId != null) tag(act, battlerId);
      return [act, BattleText.get("STRINGID_PKMNHASNOMOVESLEFT", { active: b, trainer: truthy(st) && !truthy(st.wild) })];
    }
    if (truthy(b.expEncoreMove) && (tonumber(b.expEncoreTurns) ?? 0) > 0) {
      let slot = b.expEncoreSlot;
      if (!truthy(slot)) {
        for (let i = 1; i <= 4; i++) {
          if (move_num(b.mon.moves[i]) === move_num(b.expEncoreMove)) { slot = i; break; }
        }
      }
      if (truthy(slot)) {
        const act: Action = { kind: "move", move: b.mon.moves[slot], slot, user: "player" };
        if (battlerId != null) tag(act, battlerId);
        return [act];
      }
    }
    return [null];
  },

  // Lua: commands.lua:209 -- pokefirered/src/party_menu.c:5916
  switchError(st: any, slot: number, forced?: boolean | null, battlerId?: number | null): any {
    const party = truthy(st) ? st.playerParty : null;
    const mon = truthy(party) ? party[slot] : null;
    if (!truthy(mon)) return null;
    const vars = { stringVars: seq(Pokemon.displayMonName(mon)) };
    if (truthy(st.multi) && truthy(st.partyOwner)) {
      const own = tonumber(battlerId) ?? tonumber(st.linkOwn) ?? 0;
      const owner = truthy(st.partyOwner.player) ? st.partyOwner.player[slot] : null;
      if (owner != null && owner !== own) {
        // pokefirered/src/party_menu.c:5922
        const name = (truthy(st.linkNames) ? st.linkNames[owner] : null) ?? "";
        return RomText.ascii("gText_CantSwitchWithAlly", { stringVars: seq(name) });
      }
    }
    if (truthy(st.playerHalf) && slot > st.playerHalf) {
      // pokeemerald/src/party_menu.c:5807
      return RomText.ascii("gText_CantSwitchWithAlly", { stringVars: seq((truthy(st.partner) ? st.partner.name : null) ?? "") });
    }
    if ((tonumber(mon.hp) ?? 0) <= 0) return RomText.ascii("gText_PkmnHasNoEnergy", vars);
    if (truthy(st.player) && st.player.partyIndex === slot) return RomText.ascii("gText_PkmnAlreadyInBattle", vars);
    if (truthy(st.double)) {
      // pokefirered/src/party_menu.c:5934
      const b2 = battler_of(st, 2);
      if (truthy(b2) && b2.partyIndex === slot && !(truthy(st.absent) && truthy(st.absent[2]))) {
        return RomText.ascii("gText_PkmnAlreadyInBattle", vars);
      }
      const pend = st.monToSwitchInto ?? {};
      const partner = (battlerId === 2) ? 0 : 2;
      if (battlerId != null && pend[partner] === slot) {
        return RomText.ascii("gText_PkmnAlreadySelected", vars);
      }
    }
    if (truthy(mon.isEgg)) return RomText.ascii("gText_EggCantBattle");
    if (truthy(forced)) return null;
    // package.loaded engine / battle: always loaded here
    const ad = truthy(Battle) ? Battle._adapter : null;
    if (truthy(Engine) && truthy(Engine.canSwitch) && truthy(ad)) {
      const [ok, why] = Engine.canSwitch(st, ad, battler_of(st, battlerId));
      if (!truthy(ok)) return why;
    }
    return null;
  },

  // Lua: commands.lua:329 -- pokefirered/src/battle_controller_opponent.c:1350
  enemyAction(st: any, battlerId?: number | null): any {
    if (!ModRuntime.wantsHook("battle.enemy_action")) {
      return vanilla_enemy_action(st, battlerId);
    }
    let vanilla: any;
    const res = ModRuntime.call("battle.enemy_action", (battle: any, bid: any) => {
      vanilla = vanilla_enemy_action(battle, bid);
      return vanilla;
    }, st, battlerId);
    if (res != null && res === vanilla) return vanilla;
    return normalize_enemy_action(st, res, battlerId) ?? vanilla ?? vanilla_enemy_action(st, battlerId);
  },

  /** Wild flee: pret-ish odds from speed (simplified). */
  // Lua: commands.lua:343
  tryFlee(st: any, adapter: any): boolean {
    // package.loaded engine: always loaded here
    if (truthy(Engine) && truthy(Engine.tryFlee)) {
      const [ok] = Engine.tryFlee(st, adapter, st.player);
      return truthy(ok) ? true : false;
    }
    if (!truthy(st.wild)) {
      adapter.sayText("STRINGID_NORUNNINGFROMTRAINERS");
      return false;
    }
    const pm = st.player.mon, em = st.enemy.mon;
    const pSpe = tonumber(truthy(pm.speed) ? pm.speed : pm.spe) ?? 50;
    const eSpe = tonumber(truthy(em.speed) ? em.speed : em.spe) ?? 50;
    const odds = Math.floor((pSpe * 128) / Math.max(1, eSpe)) + 30 * (st.fleeAttempts ?? 0);
    st.fleeAttempts = (st.fleeAttempts ?? 0) + 1;
    const roll = adapter.rng();
    let r: number;
    let ok: boolean, v: any;
    try {
      v = roll(0, 255);
      ok = true;
    } catch (e) {
      ok = false;
      v = e;
    }
    if (ok && typeof v === "number") {
      r = v;
    } else {
      r = Guard.fallback("commands.flee", 0, 255);
    }
    if (r < odds) {
      adapter.sayText("STRINGID_GOTAWAYSAFELY");
      return true;
    }
    adapter.sayText("STRINGID_CANTESCAPE2");
    return false;
  },
};

export default Commands;
