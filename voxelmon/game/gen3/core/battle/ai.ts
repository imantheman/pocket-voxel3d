// Port of gen1recomp src/core/game3/battle/ai.lua (GPLv3 + additional terms; see LICENSE.md).
// FireRed 1:1 battle AI — BattleAI_ChooseMoveOrAction scoring loop.
//
// Port notes:
// - Lazy requires, `pcall(require, ...)` (rng, ai_cmds, rules, dataset) and
//   the `package.loaded["src.core.game3.battle"]` probe are static imports
//   used exactly as Brian guards them (every module is in the bundle, so the
//   battle package reads as loaded).
// - `load(src, "@" .. rel, "t", {})` on the AI pack is luaLoad.
// - `math.random` (the last rng fallback) is platform random().
// - The adapter cache (a weak-keyed Lua table) is a WeakMap.
// - Multiple returns are 0-based tuples: pret_pick / pret_pick_rse ->
//   [slot, best]; Ai.chooseDoubles -> [slot, tid] or [null, tid, "run"|"watch"].
// - `act.target = nil` (shape) deletes the key.
// - The RSE (Emerald) branches (BattleProfile aiVariant "rse") are pure logic
//   and are ported as written; FRLG battle profiles never take them.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { mod, tonumber, truthy } from "../../../../import/gen3/lua.ts";
import { len, seq, type LuaTable } from "../../platform/lt.ts";
import { luaLoad } from "../../platform/luadata.ts";
import { random } from "../../platform/rng.ts";
import AiVm, { type AiPack, type AiRng } from "./ai_vm.ts";
import BattleProfile from "./profile.ts";
import State from "./state.ts";
import Engine from "./engine.ts";
import Adapter from "./adapter.ts";
import Moves from "./moves.ts";
import AiItems from "./ai_items.ts";
import AiSwitch from "./ai_switch.ts";
import AiCmds from "./ai_cmds.ts";
import Rules from "./rules.ts";
import Guard from "./link_guard.ts";
// package.loaded["src.core.game3.battle"] is battle.lua, which returns battle/init's
// table: import init directly (core/battle.ts reads it at load, which a cycle breaks).
import { Battle } from "./init.ts";
import Rng from "../rng.ts";
import Dataset from "../dataset.ts";

type Tbl = LuaTable;

/** Lua `a or b` (b already evaluated). */
function lor<A, B>(a: A, b: B): A | B {
  return truthy(a) ? a : b;
}

/** What the AI decided for one battler (the engine's action table). */
export interface AiAction {
  kind: string; // "move" | "switch" | "item" | "run" | "watch"
  move?: any;
  slot?: number | null;
  user: string; // "enemy"
  battler?: number;
  target?: number;
  scores?: Tbl;
  item?: number;
  aiItemType?: number;
  aiItemFlags?: number;
}

export interface AiOpts {
  battler?: number;
  rng?: AiRng | null;
  adapter?: any;
  pack?: AiPack | null;
  aiFlags?: number | null;
  force?: boolean;
  required?: boolean;
  [k: string]: any;
}

export interface AiModule {
  _pack: AiPack | null;
  _packTried: boolean;
  loadPack(opts?: AiOpts | null): AiPack | null;
  recordLastUsedMove(st: any, tid: number): void;
  usedMoves(st: any, tid: number | null | undefined): Tbl;
  chooseDoubles(st: any, b: any, id: number, aiFlags: number, pack: AiPack, rng: AiRng, bad: Tbl): [any, number, string?];
  flagsFor(st: any, opts?: AiOpts | null): number;
  chooseMove(st: any, opts?: AiOpts | null): AiAction | null;
  chooseAction(st: any, id?: number | null, opts?: AiOpts | null): AiAction | null;
  battleStart(st: any, opts?: AiOpts | null): void;
}

export const Ai = {} as AiModule;

Ai._pack = null;
Ai._packTried = false;

// Lua: ai.lua:13
Ai.loadPack = function (optsIn?: AiOpts | null): AiPack | null {
  const opts: AiOpts = optsIn ?? {};
  if (truthy(Ai._pack) && !truthy(opts.force)) return Ai._pack;
  Ai._packTried = true;
  const rel = "data/generated/gba/battle_ai/pack.lua";
  let src: string | undefined;
  let ok = false;
  let cache: any;
  try {
    cache = Dataset.cache();
    ok = true;
  } catch (_e) { /* pcall failed */ }
  if (ok && truthy(cache) && truthy(cache.read)) {
    src = cache.read(rel);
  }
  if (!truthy(src)) {
    if (truthy(opts.required)) {
      throw new Error("battle AI: " + rel + " is missing from the cache");
    }
    return null;
  }
  const [chunk, err] = luaLoad(src, "@" + rel);
  if (!chunk) throw new Error(err ?? "assertion failed!");
  const t: any = chunk();
  if (t == null || typeof t !== "object" || t.table == null || typeof t.table !== "object"
      || t.scripts == null || typeof t.scripts !== "object") {
    throw new Error("battle AI: " + rel + " is not a script pack");
  }
  Ai._pack = t as AiPack;
  return t as AiPack;
};

// Lua: ai.lua:37
function rng_fn(st: any, opts?: AiOpts | null): AiRng {
  if (truthy(opts) && truthy(opts!.rng)) return opts!.rng as AiRng;
  if (truthy(st) && typeof st.rng === "function") return st.rng;
  // Lua: pcall(require, "src.core.game3.rng") -- always loads here
  if (truthy(Rng) && truthy(Rng.compat)) return Guard.source("ai.rng", Rng.compat as AiRng);
  return Guard.source("ai.rng", random as AiRng);
}

// Lua: ai.lua:46
function roll(rng: AiRng, lo: number, hi: number): number {
  try {
    const v = rng(lo, hi);
    if (typeof v === "number") return v;
  } catch (_e) { /* pcall failed */ }
  try {
    const v = (rng as any)();
    if (typeof v === "number") {
      return lo + mod(Math.floor(v), hi - lo + 1);
    }
  } catch (_e) { /* pcall failed */ }
  return Guard.fallback("ai.roll", lo, hi);
}

// Lua: ai.lua:56
function to_u32(nIn: unknown): number {
  let n = tonumber(nIn) ?? 0;
  n = mod(Math.floor(n), 4294967296);
  if (n < 0) n = n + 4294967296;
  return n;
}

// Lua: ai.lua:63
// Brian's 32-step loop over two u32s is exactly JS `&` on them.
function bit_and_flags(a: unknown, b: unknown): number {
  return (to_u32(a) & to_u32(b)) >>> 0;
}

// Lua: ai.lua:73
function bit_or_flags(a: unknown, b: unknown): number {
  const ua = to_u32(a), ub = to_u32(b);
  return to_u32(ua + ub - bit_and_flags(ua, ub));
}

// Lua: ai.lua:78
function run_scripts(pack: AiPack, aiFlags: number, st: any, user: any, target: any, userSide: any,
  targetSide: any, scores: Tbl, simulatedRNG: Tbl, rng: AiRng): number {
  let aiAction = 0;
  let logicId = 0;
  let flags = to_u32(aiFlags);
  while (flags !== 0 && logicId < 32) {
    if (mod(flags, 2) === 1) {
      const scriptName = pack.table[logicId + 1]; // Lua 1-based; pret index 0
      if (truthy(scriptName) && truthy(pack.scripts[scriptName])) {
        for (let movesetIndex = 1; movesetIndex <= 4; movesetIndex++) {
          const vm = AiVm.new({
            pack: pack,
            st: st,
            user: user,
            target: target,
            userSide: userSide,
            targetSide: targetSide,
            scores: scores,
            simulatedRNG: simulatedRNG,
            movesetIndex: movesetIndex,
            rng: rng,
          });
          AiVm.run(vm, scriptName);
          aiAction = bit_or_flags(aiAction, vm.aiAction ?? 0);
          if (bit_and_flags(aiAction, 0x8) !== 0) break;
        }
      }
    }
    flags = Math.floor(flags / 2);
    logicId = logicId + 1;
  }
  return aiAction;
}

const MOVE_TARGET_BOTH = 0x08;
const MOVE_TARGET_SELF = 0x12;

// Lua: ai.lua:114
function move_num(mv: unknown): number {
  const n = tonumber(mv);
  if (n != null) return n;
  if (mv == null || mv === "") return 0;
  return truthy(Moves.numForName) ? (Moves.numForName(mv) ?? 0) : 0;
}

// Lua: ai.lua:122
function move_target_byte(mv: unknown): number {
  if (move_num(mv) === 0) return 0;
  let ok = false;
  let m: any;
  try {
    m = Moves.get(mv);
    ok = true;
  } catch (_e) { /* pcall failed */ }
  return tonumber(ok && truthy(m) ? m.target : undefined) ?? 0;
}

// Lua: ai.lua:129
function random_u16(rng: AiRng): number {
  return roll(rng, 0, 65535);
}

const ad_cache = new WeakMap<object, any>();
// Lua: ai.lua:134
function adapter_for(st: any, opts?: AiOpts | null): any {
  if (truthy(opts) && truthy(opts!.adapter)) return opts!.adapter;
  // Lua: package.loaded["src.core.game3.battle"] -- linked in, so loaded (= battle/init)
  const BattleMod: any = Battle;
  let ad = truthy(BattleMod) ? BattleMod._adapter : BattleMod;
  if (truthy(ad) && ad._st === st) return ad;
  ad = ad_cache.get(st);
  if (!truthy(ad)) {
    ad = Adapter.new(st, function () { /* no say */ });
    ad_cache.set(st, ad);
  }
  return ad;
}

// Lua: ai.lua:148
// pokeemerald/src/battle_ai_script_commands.c:396
function pret_pick_rse(scores: Tbl, rng: AiRng, mon: any): [any, number] {
  let best = scores[1] ?? 0;
  let considered: Tbl = seq(1);
  for (let i = 2; i <= 4; i++) {
    if (move_num(truthy(mon) && truthy(mon.moves) ? mon.moves[i] : undefined) !== 0) {
      const s = scores[i] ?? 0;
      if (best === s) considered[len(considered) + 1] = i;
      if (best < s) {
        best = s;
        considered = seq(i);
      }
    }
  }
  return [considered[roll(rng, 1, len(considered))], best];
}

// Lua: ai.lua:165
// src/battle_ai_script_commands.c:370
function pret_pick(scores: Tbl, rng: AiRng): [any, number] {
  let best = scores[1] ?? 0;
  let considered: Tbl = seq(1);
  for (let i = 2; i <= 4; i++) {
    const s = scores[i] ?? 0;
    if (best < s) {
      best = s;
      considered = seq(i);
    }
    if (best === s) considered[len(considered) + 1] = i;
  }
  return [considered[roll(rng, 1, len(considered))], best];
}

// Lua: ai.lua:179
function double_first_usable(mon: any, id: number, bad?: Tbl): AiAction {
  for (let i = 1; i <= 4; i++) {
    const mv = truthy(mon) && truthy(mon.moves) ? mon.moves[i] : undefined;
    if (move_num(mv) !== 0 && !(truthy(bad) && truthy(bad[i]))) {
      return { kind: "move", move: mv, slot: i, user: "enemy", battler: id };
    }
  }
  return { kind: "move", move: "STRUGGLE", slot: null, user: "enemy", battler: id };
}

const AI_SCRIPT_CHECK_BAD_MOVE = 0x00000001;
const AI_SCRIPT_CHECK_VIABILITY = 0x00000002;
const AI_SCRIPT_TRY_TO_FAINT = 0x00000004;
const AI_SCRIPT_SETUP_FIRST_TURN = 0x00000008;
const AI_SCRIPT_RISKY = 0x00000010;
const AI_SCRIPT_PREFER_STRONGEST_MOVE = 0x00000020;
const AI_SCRIPT_PREFER_BATON_PASS = 0x00000040;
const AI_SCRIPT_DOUBLE_BATTLE = 0x00000080;
const AI_SCRIPT_HP_AWARE = 0x00000100;
const AI_SCRIPT_ROAMING = 0x20000000;
const AI_SCRIPT_SAFARI = 0x40000000;
const AI_SCRIPT_FIRST_BATTLE = 0x80000000;
// (unused in ai.lua, kept as Brian lists them)
void AI_SCRIPT_SETUP_FIRST_TURN; void AI_SCRIPT_RISKY; void AI_SCRIPT_PREFER_STRONGEST_MOVE;
void AI_SCRIPT_PREFER_BATON_PASS; void AI_SCRIPT_DOUBLE_BATTLE; void AI_SCRIPT_HP_AWARE;
void AI_SCRIPT_FIRST_BATTLE;

// Lua: ai.lua:202
function uses_ai(st: any): boolean {
  if (!truthy(st)) return false;
  if (!truthy(st.wild)) return true;
  if (BattleProfile.of(st).aiVariant === "rse") {
    // pokeemerald/src/battle_controller_opponent.c:1563
    return (truthy(st.kinds) && truthy(st.kinds.firstBattle)) || truthy(st.safari) || truthy(st.roamer);
  }
  if (truthy(st.roamer) || truthy(st.safari) || truthy(st.firstBattle) || truthy(st.wildScripted) || truthy(st.legendary)) return true;
  const flags = to_u32(st.aiFlags);
  return flags !== 0;
}

// Lua: ai.lua:215
// src/battle_controller_opponent.c:1350
function choose_move_core(st: any, id: number, opts: AiOpts): AiAction | null {
  const b = State.battler(st, id);
  const mon = truthy(b) ? b.mon : b;
  if (!truthy(mon)) return null;
  const rng = rng_fn(st, opts);
  const ad = adapter_for(st, opts);
  const double = truthy(st.double);
  // Lua: ai.lua:224
  const shape = (act: AiAction): AiAction => {
    if (!double) {
      delete act.target;
      if (opts.battler == null) delete act.battler;
    }
    return act;
  };

  let bad: Tbl = {};
  let okL = false;
  let lim: any;
  try {
    lim = Engine.moveLimitations(b, ad);
    okL = true;
  } catch (_e) { /* pcall failed */ }
  if (okL && lim != null && typeof lim === "object") bad = lim;
  // src/battle_main.c:3147
  if (truthy(bad[1]) && truthy(bad[2]) && truthy(bad[3]) && truthy(bad[4])) {
    return shape({ kind: "move", move: "STRUGGLE", slot: null, user: "enemy", battler: id });
  }

  if (!uses_ai(st)) {
    // src/battle_controller_opponent.c:1389
    let slot: number = 0, mv: any;
    for (let _ = 1; _ <= 1000; _++) {
      slot = roll(rng, 0, 3) + 1;
      mv = truthy(mon.moves) ? mon.moves[slot] : mon.moves;
      if (move_num(mv) !== 0) break;
    }
    if (move_num(mv) === 0) return shape(double_first_usable(mon, id, bad));
    let tid: number;
    if (bit_and_flags(move_target_byte(mv), MOVE_TARGET_SELF) !== 0) {
      tid = id;
    } else if (double) {
      tid = bit_and_flags(random_u16(rng), 2);
    } else {
      tid = State.OPPOSITE(id);
    }
    return shape({ kind: "move", move: mv, slot: slot, user: "enemy", battler: id, target: tid,
      scores: seq(0, 0, 0, 0) });
  }

  const bp = BattleProfile.of(st);
  const rse = bp.aiVariant === "rse";
  const aiFlags = Ai.flagsFor(st, opts);
  let pack: AiPack | null | undefined = opts.pack;
  if (aiFlags !== 0 && !truthy(pack)) pack = Ai.loadPack();

  // src/battle_ai_script_commands.c:301
  const scores: Tbl = seq(100, 100, 100, 100);
  const simulatedRNG: Tbl = [];
  for (let i = 1; i <= 4; i++) {
    if (truthy(bad[i])) scores[i] = 0;
    simulatedRNG[i] = 100 - roll(rng, 0, 15);
  }
  // src/battle_ai_script_commands.c:317
  let tid: number;
  if (double && rse) {
    // pokeemerald/src/battle_ai_script_commands.c:350
    tid = bit_and_flags(random_u16(rng), 2) + ((b.side === "player") ? 1 : 0);
    if (State.isAbsent(st, tid)) tid = (tid >= 2) ? (tid - 2) : (tid + 2);
  } else if (double) {
    tid = bit_and_flags(random_u16(rng), 2);
    if (State.isAbsent(st, tid)) tid = 2 - tid;
  } else {
    tid = State.OPPOSITE(id);
  }
  const target = State.battler(st, tid);
  // Lua `(b.side == "player") and st.playerSide or st.enemySide` (and the reverse)
  const userSide = (b.side === "player" && truthy(st.playerSide)) ? st.playerSide : st.enemySide;
  const targetSide = (b.side === "player" && truthy(st.enemySide)) ? st.enemySide : st.playerSide;

  if (double && rse && bp.rules.aiDoubles === "per_target" && aiFlags !== 0 && truthy(pack) && truthy(pack!.table)) {
    let [slot2, tid2, action] = Ai.chooseDoubles(st, b, id, aiFlags, pack!, rng, bad);
    if (action === "run" || action === "watch") {
      return shape({ kind: action, user: "enemy", battler: id, scores: scores });
    }
    const mv2 = truthy(slot2) && truthy(mon.moves) ? mon.moves[slot2] : undefined;
    if (move_num(mv2) === 0) {
      const fb = double_first_usable(mon, id, bad);
      fb.scores = scores;
      return shape(fb);
    }
    // pokeemerald/src/battle_controller_opponent.c:1581
    const tt2 = move_target_byte(mv2);
    if (bit_and_flags(tt2, MOVE_TARGET_SELF) !== 0) tid2 = id;
    if (bit_and_flags(tt2, MOVE_TARGET_BOTH) !== 0) {
      tid2 = 0;
      if (State.isAbsent(st, tid2)) tid2 = 2;
    }
    return shape({ kind: "move", move: mv2, slot: slot2, user: "enemy", battler: id, target: tid2,
      scores: scores });
  }
  if (rse) Ai.recordLastUsedMove(st, tid);

  let aiAction = 0;
  if (aiFlags !== 0 && truthy(pack) && truthy(pack!.table) && truthy(pack!.scripts) && truthy(target)) {
    aiAction = run_scripts(pack!, aiFlags, st, b, target, userSide, targetSide, scores, simulatedRNG, rng);
  } else if (truthy(st.roamer)) {
    // data/battle_ai_scripts.s: BattleAI_Roaming checks if_can_escape
    // Lua: pcall(require, "src.core.game3.battle.ai_cmds") -- always loads here
    let canEscape = true;
    if (truthy(AiCmds) && truthy(AiCmds.canEscape)) {
      canEscape = AiCmds.canEscape(b, target);
    }
    if (canEscape) {
      aiAction = 0x2;
    }
  } else if (truthy(st.safari)) {
    // data/battle_ai_scripts.s:3242
    // Lua: pcall(require, "src.core.game3.battle.rules") -- always loads here
    const rate = lor(Rules.safari.fleeRate(st.safariState), 0);
    aiAction = (mod(random_u16(rng), 100) < rate) ? 0x2 : 0x4;
  }
  // src/battle_ai_script_commands.c:383
  if (bit_and_flags(aiAction, 0x2) !== 0) {
    return shape({ kind: "run", user: "enemy", battler: id, scores: scores });
  }
  if (bit_and_flags(aiAction, 0x4) !== 0) {
    return shape({ kind: "watch", user: "enemy", battler: id, scores: scores });
  }

  let slot: any;
  if (rse) {
    slot = pret_pick_rse(scores, rng, mon)[0];
  } else {
    slot = pret_pick(scores, rng)[0];
  }
  const mv = truthy(mon.moves) ? mon.moves[slot] : mon.moves;
  if (move_num(mv) === 0) {
    const fb = double_first_usable(mon, id, bad);
    fb.scores = scores;
    return shape(fb);
  }
  // src/battle_controller_opponent.c:1370
  const tt = move_target_byte(mv);
  if (bit_and_flags(tt, MOVE_TARGET_SELF) !== 0) tid = id;
  if (bit_and_flags(tt, MOVE_TARGET_BOTH) !== 0) {
    tid = double ? 0 : State.OPPOSITE(id);
    if (double && State.isAbsent(st, tid)) tid = 2;
  }
  return shape({
    kind: "move",
    move: mv,
    slot: slot,
    user: "enemy",
    battler: id,
    target: tid,
    scores: scores,
  });
}

// Lua: ai.lua:371
// pokeemerald/src/battle_ai_script_commands.c:618
Ai.recordLastUsedMove = function (st: any, tid: number): void {
  const t = State.battler(st, tid);
  if (!truthy(t)) return;
  const h = AiItems.history(st);
  h.usedMoves = h.usedMoves ?? {};
  let row = h.usedMoves![tid];
  // pokeemerald/src/battle_main.c:3260
  if (!truthy(row) || row.mon !== State.partyMon(t)) {
    row = { mon: State.partyMon(t), 1: 0, 2: 0, 3: 0, 4: 0 };
    h.usedMoves![tid] = row;
  }
  const last = move_num(lor(t.lastMoveId, t.lastMove));
  for (let i = 1; i <= 4; i++) {
    if (row[i] === last) break;
    if (row[i] === 0) {
      row[i] = last;
      break;
    }
  }
};

// Lua: ai.lua:393
Ai.usedMoves = function (st: any, tid: number | null | undefined): Tbl {
  const t = State.battler(st, tid);
  const h = truthy(st) ? st._aiHistory : st;
  const row = truthy(h) && truthy(h.usedMoves) && tid != null ? h.usedMoves[tid] : undefined;
  if (!truthy(row) || !truthy(t) || row.mon !== State.partyMon(t)) return seq(0, 0, 0, 0);
  return row;
};

// Lua: ai.lua:403
// pokeemerald/src/battle_ai_script_commands.c:448
Ai.chooseDoubles = function (st: any, b: any, id: number, aiFlags: number, pack: AiPack, rng: AiRng,
  bad: Tbl): [any, number, string?] {
  const mon = b.mon;
  const bestPoints: Record<number, number> = {}, actionOrMove: Record<number, any> = {};
  for (let i = 0; i <= 3; i++) {
    const t = State.battler(st, i);
    if (i === id || State.isAbsent(st, i) || !truthy(t)
        || (tonumber(truthy(t.mon) ? t.mon.hp : t.mon) ?? 0) <= 0) {
      actionOrMove[i] = null;
      bestPoints[i] = -1;
    } else {
      // pokeemerald/src/battle_ai_script_commands.c:315
      const scores: Tbl = seq(100, 100, 100, 100), simulatedRNG: Tbl = [];
      for (let k = 1; k <= 4; k++) {
        if (truthy(bad) && truthy(bad[k])) scores[k] = 0;
        simulatedRNG[k] = 100 - roll(rng, 0, 15);
      }
      random_u16(rng);
      if (mod(i, 2) !== mod(id, 2)) Ai.recordLastUsedMove(st, i);
      const userSide = (b.side === "player" && truthy(st.playerSide)) ? st.playerSide : st.enemySide;
      const targetSide = (t.side === "player" && truthy(st.playerSide)) ? st.playerSide : st.enemySide;
      const aiAction = run_scripts(pack, aiFlags, st, b, t, userSide, targetSide, scores, simulatedRNG, rng);
      if (bit_and_flags(aiAction, 0x2) !== 0) {
        actionOrMove[i] = "run";
        bestPoints[i] = -1;
      } else if (bit_and_flags(aiAction, 0x4) !== 0) {
        actionOrMove[i] = "watch";
        bestPoints[i] = -1;
      } else {
        const [slot, best] = pret_pick_rse(scores, rng, mon);
        actionOrMove[i] = slot;
        bestPoints[i] = best;
        if (i === State.PARTNER(id) && best < 100) bestPoints[i] = -1;
      }
    }
  }
  let most = bestPoints[0];
  let targets: Tbl = seq(0);
  for (let i = 1; i <= 3; i++) {
    if (most === bestPoints[i]) targets[len(targets) + 1] = i;
    if (most < bestPoints[i]) {
      most = bestPoints[i];
      targets = seq(i);
    }
  }
  const tid = targets[roll(rng, 1, len(targets))];
  const pick = actionOrMove[tid];
  if (pick === "run" || pick === "watch") return [null, tid, pick];
  return [pick, tid];
};

// Lua: ai.lua:454
// src/battle_ai_script_commands.c:331
Ai.flagsFor = function (st: any, optsIn?: AiOpts | null): number {
  const opts: AiOpts = optsIn ?? {};
  const bp = BattleProfile.of(st);
  const rse = bp.aiVariant === "rse";
  const double = truthy(st.double);
  let aiFlags: number;
  if (rse) {
    // pokeemerald/src/battle_ai_script_commands.c:361
    if (truthy(st.safari)) {
      aiFlags = BattleProfile.aiBit(bp, "SAFARI");
    } else if (truthy(st.roamer)) {
      aiFlags = BattleProfile.aiBit(bp, "ROAMING");
    } else if (truthy(st.kinds) && truthy(st.kinds.firstBattle)) {
      aiFlags = BattleProfile.aiBit(bp, "FIRST_BATTLE");
    } else {
      aiFlags = tonumber(lor(opts.aiFlags, st.aiFlags)) ?? 0;
    }
    // pokeemerald/src/battle_ai_script_commands.c:378
    if (double) aiFlags = bit_or_flags(aiFlags, BattleProfile.aiBit(bp, "DOUBLE_BATTLE"));
  } else if (truthy(st.safari)) {
    aiFlags = AI_SCRIPT_SAFARI;
  } else if (truthy(st.roamer)) {
    aiFlags = AI_SCRIPT_ROAMING;
  } else if (truthy(st.legendary)) {
    aiFlags = bit_or_flags(AI_SCRIPT_CHECK_BAD_MOVE, bit_or_flags(AI_SCRIPT_TRY_TO_FAINT, AI_SCRIPT_CHECK_VIABILITY));
  } else if (truthy(st.wildScripted)) {
    aiFlags = AI_SCRIPT_CHECK_BAD_MOVE;
  } else {
    aiFlags = tonumber(lor(opts.aiFlags, st.aiFlags)) ?? 0;
  }
  return aiFlags;
};

// Lua: ai.lua:489
/**
 * Choose enemy move via pret AI scripts.
 * @returns { kind="move", move=..., slot=i, user="enemy", scores=... }
 */
Ai.chooseMove = function (st: any, optsIn?: AiOpts | null): AiAction | null {
  const opts: AiOpts = optsIn ?? {};
  if (!truthy(st)) return null;
  const id = opts.battler ?? 1;
  return choose_move_core(st, id, opts);
};

// Lua: ai.lua:497
// src/battle_main.c:3125
Ai.chooseAction = function (st: any, idIn?: number | null, optsIn?: AiOpts | null): AiAction | null {
  const opts: AiOpts = optsIn ?? {};
  const id = idIn ?? 1;
  if (!truthy(st)) return null;
  const b = State.battler(st, id);
  if (!truthy(b) || !truthy(b.mon)) return null;
  if (truthy(b.expLockedMove) || truthy(b.expMustRecharge)) {
    let act: AiAction = { kind: "move", move: b.expLockedMove, slot: b.expLockedSlot, user: "enemy", battler: id };
    if (!truthy(act.move)) act = double_first_usable(b.mon, id);
    return act;
  }
  const rng = rng_fn(st, opts);
  const ad = adapter_for(st, opts);
  // src/battle_ai_switch_items.c:358
  if (!truthy(st.wild) && !truthy(st.pokedude) && !truthy(st.oldManTutorial)) {
    const pick = AiSwitch.trySwitch(st, ad, id, rng);
    if (truthy(pick)) {
      st.monToSwitchInto = lor(st.monToSwitchInto, {});
      st.monToSwitchInto[id] = pick;
      return { kind: "switch", slot: pick, user: "enemy", battler: id };
    }
    // pokeemerald/src/battle_ai_switch_items.c:815
    const use = (mod(id, 2) === 1) ? AiItems.shouldUseItem(st, id) : null;
    if (truthy(use)) {
      return {
        kind: "item",
        item: use!.item,
        aiItemType: use!.aiItemType,
        aiItemFlags: use!.aiItemFlags,
        user: "enemy",
        battler: id,
        target: id,
      };
    }
  }
  return choose_move_core(st, id, {
    battler: id,
    rng: rng,
    adapter: ad,
    pack: opts.pack,
    aiFlags: opts.aiFlags,
  });
};

// Lua: ai.lua:545
// src/battle_controllers.c:59
Ai.battleStart = function (st: any, optsIn?: AiOpts | null): void {
  const opts: AiOpts = optsIn ?? {};
  if (!truthy(st)) return;
  st._aiHistory = null;
  AiItems.history(st);
  const rng = rng_fn(st, opts);
  for (let _ = 1; _ <= 4; _++) roll(rng, 0, 15);
  if (truthy(st.double)) random_u16(rng);
};

export default Ai;
