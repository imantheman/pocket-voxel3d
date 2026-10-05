// Port of gen1recomp src/core/game3/battle/ai_cmds.lua (GPLv3 + additional terms; see LICENSE.md).
// FireRed battle AI command handlers (port of battle_ai_script_commands.c).
//
// Port notes:
// - bit_or_local / bit_and_local are Brian's 32-step bit loops; they equal
//   JS `(floor(a) | floor(b)) >>> 0` / `&` for every number (both keep the
//   low 32 bits, negatives as two's complement), so they are written that way.
// - Lazy requires (state, profile, ai, ai_items-free, rules, link_guard,
//   pokemon) are static imports; `pcall(require, abilities)` always succeeds,
//   and `pcall(Abilities.id, a)` stays a try/catch.
// - Damage.calc returns the tuple [dmg, info]; ai_damage takes [0].
// - mon_types returns the tuple [t1, t2].
// - The RSE (Emerald) branches (aiMoveHistory == "battler") are pure logic
//   and are ported as written; FRLG battle profiles never take them.
// - The DISCOURAGED table is built at load from EffectIds, as in Lua (with
//   Brian's numeric fallbacks).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { mod, tonumber, tostring, truthy } from "../../../../import/gen3/lua.ts";
import { ipairs, len, remove, type LuaTable } from "../../platform/lt.ts";
import Moves from "./moves.ts";
import Pokemon from "../pokemon.ts";
import Types from "./types.ts";
import Damage from "./damage.ts";
import EffectIds from "./effect_ids.ts";
import Guard from "./link_guard.ts";
import State from "./state.ts";
import BattleProfile from "./profile.ts";
import Abilities from "./abilities.ts";
import Ai from "./ai.ts";
import Rules from "./rules.ts";
import type { AiOp, AiVmState } from "./ai_vm.ts";

type Tbl = LuaTable;
type Cmd = (vm: AiVmState, op: AiOp) => void;

/** Lua `a or b` (b already evaluated). */
function lor<A, B>(a: A, b: B): A | B {
  return truthy(a) ? a : b;
}

/** Lua `a and b` (b already evaluated). */
function land<A, B>(a: A, b: B): A | B {
  return truthy(a) ? b : a;
}

export interface AiCmdsModule {
  CMD: Record<string, Cmd>;
  STATUS1: Record<string, number>;
  move_effect(moveId: unknown): number;
  move_power(moveId: unknown): number;
  ai_damage(vm: AiVmState, moveId: unknown, movesetIndex: number): number;
  battler(vm: AiVmState, id: unknown): any;
  side_of(vm: AiVmState, battler: any): any;
  canEscape(user: any, target: any): boolean;
  dispatch(vm: AiVmState, op: AiOp | null | undefined): void;
}

export const AiCmds = {} as AiCmdsModule;

// Lua: ai_cmds.lua:11
function bit_or_local(a: number | null | undefined, b: number | null | undefined): number {
  return (Math.floor(a ?? 0) | Math.floor(b ?? 0)) >>> 0;
}

// Lua: ai_cmds.lua:22
function bit_and_local(a: number | null | undefined, b: number | null | undefined): number {
  return (Math.floor(a ?? 0) & Math.floor(b ?? 0)) >>> 0;
}

// pret STATUS1 bits
const STATUS1: Record<string, number> = {
  SLEEP: 0x7,
  POISON: 0x8,
  BURN: 0x10,
  FREEZE: 0x20,
  PARALYSIS: 0x40,
  TOXIC_POISON: 0x80,
  PSN_ANY: 0x88,
  ANY: 0xFF,
};

const STATUS2 = {
  CONFUSION: 0x7,
  FLINCHED: 0x8,
  UPROAR: 0x70,
  BIDE: 0x300,
  MULTIPLETURNS: 0x1000,
  WRAPPED: 0xE000,
  FOCUS_ENERGY: 0x100000,
  TRANSFORMED: 0x200000,
  RECHARGE: 0x400000,
  RAGE: 0x800000,
  SUBSTITUTE: 0x1000000,
  DESTINY_BOND: 0x2000000,
  ESCAPE_PREVENTION: 0x4000000,
  NIGHTMARE: 0x8000000,
  CURSED: 0x10000000,
  FORESIGHT: 0x20000000,
  DEFENSE_CURL: 0x40000000,
  TORMENT: 0x80000000,
};

const STATUS3 = {
  LEECHSEED: 0x4,
  ALWAYS_HITS: 0x18,
  PERISH_SONG: 0x20,
  ON_AIR: 0x40,
  UNDERGROUND: 0x80,
  MINIMIZED: 0x100,
  CHARGED_UP: 0x200,
  ROOTED: 0x400,
  YAWN: 0x1800,
  IMPRISONED_OTHERS: 0x2000,
  MUDSPORT: 0x10000,
  WATERSPORT: 0x20000,
  UNDERWATER: 0x40000,
  SEMI_INVULNERABLE: 0x400C0,
};

const SIDE_STATUS = {
  REFLECT: 0x1,
  LIGHTSCREEN: 0x2,
  SPIKES: 0x10,
  SAFEGUARD: 0x20,
  FUTUREATTACK: 0x40,
  MIST: 0x100,
};

const E: any = EffectIds;
const DISCOURAGED: Record<number, boolean> = {
  [lor(E.EXPLOSION, 7)]: true,
  [lor(E.DREAM_EATER, 8)]: true,
  [lor(E.RAZOR_WIND, 39)]: true,
  [lor(E.SKY_ATTACK, 75)]: true,
  [lor(E.RECHARGE, 80)]: true,
  [lor(E.SKULL_BASH, 145)]: true,
  [lor(E.SOLAR_BEAM, 151)]: true,
  [lor(E.SPIT_UP, 161)]: true,
  [lor(E.FOCUS_PUNCH, 170)]: true,
  [lor(E.SUPERPOWER, 186)]: true,
  [lor(E.ERUPTION, 187)]: true,
  [lor(E.OVERHEAT, 204)]: true,
};

const STAT_KEY: Record<number, string> = {
  [1]: "attack",
  [2]: "defense",
  [3]: "speed",
  [4]: "spAtk",
  [5]: "spDef",
  [6]: "accuracy",
  [7]: "evasion",
};

// Lua: ai_cmds.lua:117
function rng(vm: AiVmState, lo?: number, hi?: number): number {
  const r: any = vm.rng;
  if (typeof r === "function") {
    try {
      const v = r(lo, hi);
      if (typeof v === "number") return v;
    } catch (_e) { /* pcall failed */ }
    try {
      const v = r();
      if (typeof v === "number") {
        if (hi != null && lo != null) {
          return lo + mod(Math.floor(v), hi - lo + 1);
        }
        return v;
      }
    } catch (_e) { /* pcall failed */ }
  }
  if (hi != null && lo != null) return Guard.fallback("ai_cmds.rng", lo, hi);
  return Guard.fallback("ai_cmds.rng", 0, 255);
}

// Lua: ai_cmds.lua:135
function random_u16(vm: AiVmState): number {
  // pret Random() returns u16; scripts use % 256 / % 16 / % num
  return rng(vm, 0, 65535);
}

// Lua: ai_cmds.lua:140
AiCmds.battler = function (vm: AiVmState, id: unknown): any {
  // AI_USER=1 → attacker (enemy), AI_TARGET=0 → target (player)
  if (id === 1 || id === "AI_USER") return vm.user;
  return vm.target;
};

// Lua: ai_cmds.lua:146
AiCmds.side_of = function (vm: AiVmState, battler: any): any {
  if (battler === vm.user) return vm.userSide;
  return vm.targetSide;
};

// Lua: ai_cmds.lua:151
function status1_bits(battler: any): number {
  const st = land(battler, lor(battler?.status, land(battler?.mon, battler?.mon?.status)));
  if (!truthy(st)) return 0;
  if (typeof st === "number") return st;
  const s = tostring(st).toUpperCase();
  if (s === "SLP" || s === "SLEEP") return STATUS1.SLEEP;
  if (s === "PSN" || s === "POISON") return STATUS1.POISON;
  if (s === "BRN" || s === "BURN") return STATUS1.BURN;
  if (s === "FRZ" || s === "FREEZE") return STATUS1.FREEZE;
  if (s === "PAR" || s === "PARALYSIS") return STATUS1.PARALYSIS;
  if (s === "TOX" || s === "TOXIC") return STATUS1.TOXIC_POISON;
  return 0;
}

// Lua: ai_cmds.lua:165
function status2_bits(battler: any): number {
  if (!truthy(battler)) return 0;
  let b = 0;
  if (truthy(battler.status2)) b = bit_or_local(b, tonumber(battler.status2) ?? 0);
  if (truthy(battler.confusionTurns) && battler.confusionTurns > 0) b = bit_or_local(b, STATUS2.CONFUSION);
  if (truthy(battler.focusEnergy) || truthy(battler.expFocusEnergy)) b = bit_or_local(b, STATUS2.FOCUS_ENERGY);
  if (lor(battler.substituteHP, 0) > 0) b = bit_or_local(b, STATUS2.SUBSTITUTE);
  if (truthy(battler.wrapped) || truthy(battler.trapped) || truthy(battler.expWrapped)) b = bit_or_local(b, STATUS2.WRAPPED);
  if (truthy(battler.meanLook) || truthy(battler.escapePrevention) || truthy(battler.expTrapped) || truthy(battler.expTrappedBy)) b = bit_or_local(b, STATUS2.ESCAPE_PREVENTION);
  if (truthy(battler.bideTurns)) b = bit_or_local(b, STATUS2.BIDE);
  if (truthy(battler.recharge)) b = bit_or_local(b, STATUS2.RECHARGE);
  if (truthy(battler.rage)) b = bit_or_local(b, STATUS2.RAGE);
  if (truthy(battler.torment)) b = bit_or_local(b, STATUS2.TORMENT);
  if (truthy(battler.destinyBond)) b = bit_or_local(b, STATUS2.DESTINY_BOND);
  if (truthy(battler.cursed)) b = bit_or_local(b, STATUS2.CURSED);
  if (truthy(battler.foresight)) b = bit_or_local(b, STATUS2.FORESIGHT);
  if (truthy(battler.defenseCurl)) b = bit_or_local(b, STATUS2.DEFENSE_CURL);
  if (truthy(battler.transformed)) b = bit_or_local(b, STATUS2.TRANSFORMED);
  return b;
}

// Lua: ai_cmds.lua:186
function status3_bits(battler: any): number {
  if (!truthy(battler)) return 0;
  let b = 0;
  if (truthy(battler.leechSeed) || truthy(battler.expLeechSeed)) b = bit_or_local(b, STATUS3.LEECHSEED);
  if (truthy(battler.rooted) || truthy(battler.ingrain)) b = bit_or_local(b, STATUS3.ROOTED);
  if (truthy(battler.yawnTurns)) b = bit_or_local(b, STATUS3.YAWN);
  if (truthy(battler.minimized)) b = bit_or_local(b, STATUS3.MINIMIZED);
  if (truthy(battler.chargedUp)) b = bit_or_local(b, STATUS3.CHARGED_UP);
  if (truthy(battler.mudSport)) b = bit_or_local(b, STATUS3.MUDSPORT);
  if (truthy(battler.waterSport)) b = bit_or_local(b, STATUS3.WATERSPORT);
  if (truthy(battler.perishSong)) b = bit_or_local(b, STATUS3.PERISH_SONG);
  if (truthy(battler.underground)) b = bit_or_local(b, STATUS3.UNDERGROUND);
  if (truthy(battler.onAir) || truthy(battler.fly)) b = bit_or_local(b, STATUS3.ON_AIR);
  if (truthy(battler.underwater)) b = bit_or_local(b, STATUS3.UNDERWATER);
  return b;
}

// Lua: ai_cmds.lua:203
function side_status_bits(side: any): number {
  if (!truthy(side)) return 0;
  let b = 0;
  if (lor(side.expReflectTurns, 0) > 0 || truthy(side.reflect)) b = bit_or_local(b, SIDE_STATUS.REFLECT);
  if (lor(side.expLightScreenTurns, 0) > 0 || truthy(side.lightScreen)) b = bit_or_local(b, SIDE_STATUS.LIGHTSCREEN);
  if (lor(side.expSafeguardTurns, 0) > 0 || truthy(side.safeguard)) b = bit_or_local(b, SIDE_STATUS.SAFEGUARD);
  if (truthy(side.mist) || lor(side.expMistTurns, 0) > 0) b = bit_or_local(b, SIDE_STATUS.MIST);
  if (truthy(side.hazards)) {
    for (const [, h] of ipairs<any>(side.hazards)) {
      if (h === "spikes" || (typeof h === "object" && h.kind === "spikes")) {
        b = bit_or_local(b, SIDE_STATUS.SPIKES);
      }
    }
  }
  if (truthy(side.tokens)) {
    for (const [, tok] of ipairs<any>(side.tokens)) {
      const k = lor(tok.kind, tok.id);
      if (k === "reflect") b = bit_or_local(b, SIDE_STATUS.REFLECT);
      if (k === "light_screen" || k === "lightScreen") b = bit_or_local(b, SIDE_STATUS.LIGHTSCREEN);
      if (k === "safeguard") b = bit_or_local(b, SIDE_STATUS.SAFEGUARD);
      if (k === "mist") b = bit_or_local(b, SIDE_STATUS.MIST);
    }
  }
  return b;
}

// Lua: ai_cmds.lua:229
function move_effect(moveId: unknown): number {
  // pokeemerald/src/battle_ai_script_commands.c:1925
  if (moveId == null || moveId === 0) return 0;
  const m = Moves.get(moveId);
  if (!truthy(m)) return 0;
  const e = m.effect;
  if (typeof e === "number") return e;
  return 0;
}

// Lua: ai_cmds.lua:239
function move_metadata(moveId: unknown): Tbl {
  if (moveId == null || moveId === 0 || moveId === "") {
    if (!truthy(Moves.romReady())) throw new Error("AI required ROM move cache missing");
    const row = Pokemon.battleMove(0);
    if (!truthy(row)) throw new Error("AI ROM MOVE_NONE metadata missing");
    if (!(typeof row.power === "number" && typeof row.type === "number")) {
      throw new Error("AI ROM MOVE_NONE metadata invalid");
    }
    return row;
  }
  return Moves.get(moveId);
}

// Lua: ai_cmds.lua:249
function move_power(moveId: unknown): number {
  const m = move_metadata(moveId);
  return truthy(m) ? (tonumber(m.power) ?? 0) : 0;
}

// Lua: ai_cmds.lua:254
function move_type(moveId: unknown): number {
  const m = move_metadata(moveId);
  return truthy(m) ? (tonumber(m.type) ?? 0) : 0;
}

// Lua: ai_cmds.lua:259
function mon_types(battler: any): [any, any] {
  const t1 = truthy(battler) ? lor(battler.type1, 0) : 0;
  const t2 = truthy(battler) && truthy(battler.type2) ? battler.type2 : t1;
  return [t1, t2];
}

// Lua: ai_cmds.lua:265
function ability_of(battler: any): number {
  if (!truthy(battler)) return 0;
  let a = lor(battler.ability, battler.abilityId);
  if (truthy(battler.mon)) {
    a = lor(lor(a, battler.mon.ability), battler.mon.abilityId);
  }
  if (typeof a === "number") return a;
  if (typeof a === "string") {
    // Lua: pcall(require, "src.core.game3.battle.abilities") -- always loads here
    if (truthy(Abilities) && truthy(Abilities.id)) {
      let okId = false;
      let id: any;
      try {
        id = Abilities.id(a);
        okId = true;
      } catch (_e) { /* pcall failed */ }
      if (okId && truthy(id)) return id;
    }
  }
  return 0;
}

// Lua: ai_cmds.lua:282
function hp_percent(battler: any): number {
  if (!truthy(battler) || !truthy(battler.mon)) return 0;
  const hp = tonumber(battler.mon.hp) ?? 0;
  let maxHp = tonumber(battler.mon.maxHp) ?? 1;
  if (maxHp < 1) maxHp = 1;
  return Math.floor(100 * hp / maxHp);
}

// Lua: ai_cmds.lua:290
function pret_stat_level(battler: any, statId: any): number {
  const key = STAT_KEY[statId];
  if (!truthy(key)) return 6;
  const stages = lor(land(battler, battler?.stages), {});
  const s = tonumber(stages[key]) ?? 0;
  return s + 6; // pret 0..12 with 6 neutral
}

// Lua: ai_cmds.lua:299
// src/pokemon.c:2552
function spread_hit(vm: AiVmState, moveId: unknown): true | null {
  const st = vm.st;
  if (!(truthy(st) && truthy(st.double))) return null;
  const m = Moves.get(moveId);
  if (bit_and_local(tonumber(land(m, m?.target)) ?? 0, 0x08) === 0) return null;
  const id = State.idOf(vm.target);
  if (id == null) return null;
  return State.countPresentOnSide(st, State.sideOf(id)) === 2 ? true : null;
}

// Lua: ai_cmds.lua:310
function ai_damage(vm: AiVmState, moveId: unknown, movesetIndex: number): number {
  let dmg: number = Damage.calc(vm.user, vm.target, moveId, {
    forceCrit: false,
    forceRoll: 100,
    weather: land(vm.st, vm.st?.weather),
    rng: function () { return 100; },
    spread: spread_hit(vm, moveId),
  })[0];
  const sim = lor(land(vm.simulatedRNG, vm.simulatedRNG?.[movesetIndex]), 100);
  dmg = Math.floor(dmg * sim / 100);
  if (dmg === 0) dmg = 1;
  return dmg;
}

// Lua: ai_cmds.lua:324
function branch(vm: AiVmState, target: unknown): void {
  if (typeof target === "string") {
    vm.jump(target);
  }
}

// Lua: ai_cmds.lua:330
function next_ip(vm: AiVmState): void {
  vm.ip = vm.ip + 1;
}

// Command dispatch table
const CMD: Record<string, Cmd> = {};

// Lua: ai_cmds.lua:337
CMD.score = function (vm, op) {
  const idx = vm.movesetIndex;
  let s = (vm.scores[idx] ?? 100) + (op.delta ?? 0);
  if (s < 0) s = 0;
  if (s > 127) s = 127; // s8 clamp (pret stores s8)
  vm.scores[idx] = s;
  next_ip(vm);
};

// Lua: ai_cmds.lua:346
CMD["goto"] = function (vm, op) {
  branch(vm, op.target);
};

// Lua: ai_cmds.lua:350
CMD.call = function (vm, op) {
  vm.stack[len(vm.stack) + 1] = { script: vm.scriptName, ip: vm.ip + 1 };
  branch(vm, op.target);
};

// Lua: ai_cmds.lua:355
CMD["end"] = function (vm, _op) {
  if (len(vm.stack) > 0) {
    const frame = remove(vm.stack);
    vm.jump(frame.script, frame.ip);
  } else {
    vm.done = true;
  }
};

// Lua: ai_cmds.lua:364
CMD.flee = function (vm, _op) {
  vm.aiAction = bit_or_local(vm.aiAction ?? 0, 0x2 + 0x1 + 0x8); // FLEE|DONE|DO_NOT_ATTACK
  vm.done = true;
};

// Lua: ai_cmds.lua:369
CMD.watch = function (vm, _op) {
  vm.aiAction = bit_or_local(vm.aiAction ?? 0, 0x4 + 0x1 + 0x8);
  vm.done = true;
};

// Lua: ai_cmds.lua:374
const cmd_null: Cmd = function (vm, _op) {
  next_ip(vm);
};

CMD.ai_2a = cmd_null;
CMD.ai_2b = cmd_null;
CMD.ai_32 = cmd_null;
CMD.ai_33 = cmd_null;
CMD.ai_52 = cmd_null;
CMD.ai_53 = cmd_null;
CMD.ai_54 = cmd_null;
CMD.ai_55 = cmd_null;
CMD.ai_56 = cmd_null;
CMD.ai_57 = cmd_null;

// Lua: ai_cmds.lua:389
CMD.if_random_less_than = function (vm, op) {
  if (mod(random_u16(vm), 256) < (op.value ?? 0)) {
    branch(vm, op.target);
  } else {
    next_ip(vm);
  }
};

// Lua: ai_cmds.lua:397
CMD.if_random_greater_than = function (vm, op) {
  if (mod(random_u16(vm), 256) > (op.value ?? 0)) {
    branch(vm, op.target);
  } else {
    next_ip(vm);
  }
};

// Lua: ai_cmds.lua:405
CMD.if_random_equal = function (vm, op) {
  if (mod(random_u16(vm), 256) === (op.value ?? 0)) {
    branch(vm, op.target);
  } else {
    next_ip(vm);
  }
};

// Lua: ai_cmds.lua:413
CMD.if_random_not_equal = function (vm, op) {
  if (mod(random_u16(vm), 256) !== (op.value ?? 0)) {
    branch(vm, op.target);
  } else {
    next_ip(vm);
  }
};

// Lua: ai_cmds.lua:421
function hp_cmp(vm: AiVmState, op: AiOp, pred: (a: number, b: number) => boolean): void {
  const b = AiCmds.battler(vm, op.battler);
  const pct = hp_percent(b);
  if (pred(pct, op.percent ?? 0)) {
    branch(vm, op.target);
  } else {
    next_ip(vm);
  }
}

// Lua: ai_cmds.lua:431
CMD.if_hp_less_than = function (vm, op) { hp_cmp(vm, op, (a, b) => a < b); };
// Lua: ai_cmds.lua:432
CMD.if_hp_more_than = function (vm, op) { hp_cmp(vm, op, (a, b) => a > b); };
// Lua: ai_cmds.lua:433
CMD.if_hp_equal = function (vm, op) { hp_cmp(vm, op, (a, b) => a === b); };
// Lua: ai_cmds.lua:434
CMD.if_hp_not_equal = function (vm, op) { hp_cmp(vm, op, (a, b) => a !== b); };

// Lua: ai_cmds.lua:436
function status_cmp(vm: AiVmState, op: AiOp, getBits: (b: any) => number, wantSet: boolean): void {
  const b = AiCmds.battler(vm, op.battler);
  const bits = getBits(b);
  const mask = op.status ?? 0;
  const hit = bit_and_local(bits, mask) !== 0;
  if ((wantSet && hit) || ((!wantSet) && (!hit))) {
    branch(vm, op.target);
  } else {
    next_ip(vm);
  }
}

// Lua: ai_cmds.lua:448
CMD.if_status = function (vm, op) { status_cmp(vm, op, status1_bits, true); };
// Lua: ai_cmds.lua:449
CMD.if_not_status = function (vm, op) { status_cmp(vm, op, status1_bits, false); };
// Lua: ai_cmds.lua:450
CMD.if_status2 = function (vm, op) { status_cmp(vm, op, status2_bits, true); };
// Lua: ai_cmds.lua:451
CMD.if_not_status2 = function (vm, op) { status_cmp(vm, op, status2_bits, false); };
// Lua: ai_cmds.lua:452
CMD.if_status3 = function (vm, op) { status_cmp(vm, op, status3_bits, true); };
// Lua: ai_cmds.lua:453
CMD.if_not_status3 = function (vm, op) { status_cmp(vm, op, status3_bits, false); };

// Lua: ai_cmds.lua:455
function side_cmp(vm: AiVmState, op: AiOp, wantSet: boolean): void {
  const b = AiCmds.battler(vm, op.battler);
  const side = AiCmds.side_of(vm, b);
  let bits = side_status_bits(side);
  // pokeemerald/src/battle_util.c:1815
  if (truthy(side) && truthy(side.tokens) && truthy(BattleProfile.rule(vm.st, "futureAttackSideStatus"))) {
    for (const [, tok] of ipairs<any>(side.tokens)) {
      if (tok.id === "EXP_FUTURE_SIGHT") bits = bit_or_local(bits, SIDE_STATUS.FUTUREATTACK);
    }
  }
  const hit = bit_and_local(bits, op.status ?? 0) !== 0;
  if ((wantSet && hit) || ((!wantSet) && (!hit))) {
    branch(vm, op.target);
  } else {
    next_ip(vm);
  }
}

// Lua: ai_cmds.lua:473
CMD.if_side_affecting = function (vm, op) { side_cmp(vm, op, true); };
// Lua: ai_cmds.lua:474
CMD.if_not_side_affecting = function (vm, op) { side_cmp(vm, op, false); };

// Lua: ai_cmds.lua:476
function result_cmp(vm: AiVmState, op: AiOp, pred: (a: any, b: any) => boolean): void {
  if (pred(lor(vm.funcResult, 0), op.value ?? 0)) {
    branch(vm, op.target);
  } else {
    next_ip(vm);
  }
}

// Lua: ai_cmds.lua:484
CMD.if_less_than = function (vm, op) { result_cmp(vm, op, (a, b) => a < b); };
// Lua: ai_cmds.lua:485
CMD.if_more_than = function (vm, op) { result_cmp(vm, op, (a, b) => a > b); };
// Lua: ai_cmds.lua:486
CMD.if_equal = function (vm, op) { result_cmp(vm, op, (a, b) => a === b); };
// Lua: ai_cmds.lua:487
CMD.if_not_equal = function (vm, op) { result_cmp(vm, op, (a, b) => a !== b); };
CMD.if_equal_ = CMD.if_equal;
CMD.if_not_equal_ = CMD.if_not_equal;

// Lua: ai_cmds.lua:491
CMD.if_less_than_ptr = function (vm, _op) { next_ip(vm); }; // unused / ptr stubs
// Lua: ai_cmds.lua:492
CMD.if_more_than_ptr = function (vm, _op) { next_ip(vm); };
// Lua: ai_cmds.lua:493
CMD.if_equal_ptr = function (vm, _op) { next_ip(vm); };
// Lua: ai_cmds.lua:494
CMD.if_not_equal_ptr = function (vm, _op) { next_ip(vm); };

// Lua: ai_cmds.lua:496
CMD.if_move = function (vm, op) {
  if (vm.moveConsidered === (op.move ?? -1)) {
    branch(vm, op.target);
  } else {
    next_ip(vm);
  }
};

// Lua: ai_cmds.lua:504
CMD.if_not_move = function (vm, op) {
  if (vm.moveConsidered !== (op.move ?? -1)) {
    branch(vm, op.target);
  } else {
    next_ip(vm);
  }
};

// Lua: ai_cmds.lua:512
function in_list(vm: AiVmState, listName: any, isHword: boolean): boolean {
  const list = vm.pack && vm.pack.data && vm.pack.data[listName];
  if (!truthy(list)) return false;
  const term = isHword ? 0xFFFF : 0xFF;
  const fr = lor(vm.funcResult, 0);
  for (const [, v] of ipairs(list)) {
    if (v === term) break;
    if (v === fr) return true;
  }
  return false;
}

// Lua: ai_cmds.lua:524
CMD.if_in_bytes = function (vm, op) {
  if (in_list(vm, op.list, false)) branch(vm, op.target); else next_ip(vm);
};
// Lua: ai_cmds.lua:527
CMD.if_not_in_bytes = function (vm, op) {
  if (!in_list(vm, op.list, false)) branch(vm, op.target); else next_ip(vm);
};
// Lua: ai_cmds.lua:530
CMD.if_in_hwords = function (vm, op) {
  if (in_list(vm, op.list, true)) branch(vm, op.target); else next_ip(vm);
};
// Lua: ai_cmds.lua:533
CMD.if_not_in_hwords = function (vm, op) {
  if (!in_list(vm, op.list, true)) branch(vm, op.target); else next_ip(vm);
};

// Lua: ai_cmds.lua:537
function has_attacking(vm: AiVmState): boolean {
  const mon = land(vm.user, vm.user?.mon);
  if (!truthy(mon) || !truthy(mon.moves)) return false;
  for (let i = 1; i <= 4; i++) {
    const mv = mon.moves[i];
    if (truthy(mv) && mv !== 0 && mv !== "" && move_power(mv) !== 0) return true;
  }
  return false;
}

// Lua: ai_cmds.lua:547
CMD.if_user_has_attacking_move = function (vm, op) {
  if (has_attacking(vm)) branch(vm, op.target); else next_ip(vm);
};
// Lua: ai_cmds.lua:550
CMD.if_user_has_no_attacking_moves = function (vm, op) {
  if (!has_attacking(vm)) branch(vm, op.target); else next_ip(vm);
};

// Lua: ai_cmds.lua:554
CMD.get_turn_count = function (vm, _op) {
  vm.funcResult = lor(land(vm.st, vm.st?.turn), 0);
  next_ip(vm);
};

// Lua: ai_cmds.lua:559
CMD.get_type = function (vm, op) {
  const which = op.which ?? 0;
  const [t1u, t2u] = mon_types(vm.user);
  const [t1t, t2t] = mon_types(vm.target);
  if (which === 0) vm.funcResult = t1t; // AI_TYPE1_TARGET
  else if (which === 1) vm.funcResult = t1u;
  else if (which === 2) vm.funcResult = t2t;
  else if (which === 3) vm.funcResult = t2u;
  else if (which === 4) vm.funcResult = move_type(vm.moveConsidered);
  else vm.funcResult = 0;
  next_ip(vm);
};

// Lua: ai_cmds.lua:572
CMD.get_considered_move_power = function (vm, _op) {
  vm.funcResult = move_power(vm.moveConsidered);
  next_ip(vm);
};

// Lua: ai_cmds.lua:577
CMD.get_how_powerful_move_is = function (vm, _op) {
  const considered = vm.moveConsidered;
  const eff = move_effect(considered);
  const pow = move_power(considered);
  if (DISCOURAGED[eff] || pow <= 1) {
    vm.funcResult = 0; // MOVE_POWER_DISCOURAGED
    next_ip(vm);
    return;
  }
  const moveDmgs: Tbl = [];
  const mon = vm.user.mon;
  for (let i = 1; i <= 4; i++) {
    const mv = truthy(mon) && truthy(mon.moves) ? mon.moves[i] : undefined;
    const valid = truthy(mv) && mv !== 0 && mv !== "";
    const e = valid ? move_effect(mv) : 0;
    const p = valid ? move_power(mv) : 0;
    if (valid && !DISCOURAGED[e] && p > 1) {
      moveDmgs[i] = ai_damage(vm, mv, i);
    } else {
      moveDmgs[i] = 0;
    }
  }
  let best = true;
  const mine = moveDmgs[vm.movesetIndex] ?? 0;
  for (let i = 1; i <= 4; i++) {
    if ((moveDmgs[i] ?? 0) > mine) {
      best = false;
      break;
    }
  }
  vm.funcResult = best ? 2 : 1; // MOST / NOT_MOST
  next_ip(vm);
};

// Lua: ai_cmds.lua:611
CMD.get_last_used_move = function (vm, op) {
  const b = AiCmds.battler(vm, op.battler);
  vm.funcResult = lor(land(b, b?.lastMove), 0);
  next_ip(vm);
};

// Lua: ai_cmds.lua:617
CMD.if_would_go_first = function (vm, op) {
  // 0 = user(attacker) first, 1 = target first
  let userSpe = tonumber(land(vm.user.mon, lor(vm.user.mon?.speed, vm.user.mon?.spe))) ?? 0;
  let tgtSpe = tonumber(land(vm.target.mon, lor(vm.target.mon?.speed, vm.target.mon?.spe))) ?? 0;
  const _us = pret_stat_level(vm.user, 3); // speed stage already in Damage; use stages
  const _ts = pret_stat_level(vm.target, 3);
  void _us; void _ts;
  // Approximate with stage mul via Damage
  userSpe = userSpe * (Damage.stageMul(lor(land(vm.user.stages, vm.user.stages?.speed), 0)));
  tgtSpe = tgtSpe * (Damage.stageMul(lor(land(vm.target.stages, vm.target.stages?.speed), 0)));
  const first = (userSpe >= tgtSpe) ? 0 : 1;
  if (first === (op.battler ?? 0)) {
    branch(vm, op.target);
  } else {
    next_ip(vm);
  }
};

// Lua: ai_cmds.lua:634
CMD.if_would_not_go_first = function (vm, op) {
  let userSpe = tonumber(land(vm.user.mon, lor(vm.user.mon?.speed, vm.user.mon?.spe))) ?? 0;
  let tgtSpe = tonumber(land(vm.target.mon, lor(vm.target.mon?.speed, vm.target.mon?.spe))) ?? 0;
  userSpe = userSpe * (Damage.stageMul(lor(land(vm.user.stages, vm.user.stages?.speed), 0)));
  tgtSpe = tgtSpe * (Damage.stageMul(lor(land(vm.target.stages, vm.target.stages?.speed), 0)));
  const first = (userSpe >= tgtSpe) ? 0 : 1;
  if (first !== (op.battler ?? 0)) {
    branch(vm, op.target);
  } else {
    next_ip(vm);
  }
};

// Lua: ai_cmds.lua:647
CMD.count_alive_pokemon = function (vm, op) {
  const b = AiCmds.battler(vm, op.battler);
  const party = lor(land(b === vm.user, land(vm.st, vm.st?.foeParty)), land(vm.st, vm.st?.playerParty));
  const onField = lor(land(b, b?.partyIndex), 1);
  let onField2 = onField;
  let n = 0;
  // src/battle_ai_script_commands.c:1099
  if (truthy(vm.st) && truthy(vm.st.double)) {
    const id = State.idOf(b);
    const partner = land(id, truthy(id) ? State.battler(vm.st, State.PARTNER(id as number)) : undefined);
    onField2 = lor(land(partner, partner?.partyIndex), onField);
  }
  for (let i = 1; i <= 6; i++) {
    const mon = land(party, party?.[i]);
    const sp = land(mon, lor(mon?.species, mon?.id));
    if (i !== onField && i !== onField2 && (tonumber(land(mon, mon?.hp)) ?? 0) !== 0
        && truthy(sp) && sp !== 0 && !truthy(mon.isEgg)) {
      n = n + 1;
    }
  }
  vm.funcResult = n;
  next_ip(vm);
};

// Lua: ai_cmds.lua:672
CMD.get_considered_move = function (vm, _op) {
  vm.funcResult = lor(vm.moveConsidered, 0);
  next_ip(vm);
};

// Lua: ai_cmds.lua:677
CMD.get_considered_move_effect = function (vm, _op) {
  vm.funcResult = move_effect(vm.moveConsidered);
  next_ip(vm);
};

// Lua: ai_cmds.lua:682
CMD.get_ability = function (vm, op) {
  const b = AiCmds.battler(vm, op.battler);
  // Player (target) side: use known ability or guess; enemy (user): known
  if (b === vm.target) {
    vm.funcResult = ability_of(b);
  } else {
    vm.funcResult = ability_of(b);
  }
  next_ip(vm);
};

// Lua: ai_cmds.lua:693
CMD.get_highest_type_effectiveness = function (vm, _op) {
  let best = 0;
  const mon = vm.user.mon;
  const [t1, t2] = mon_types(vm.target);
  for (let i = 1; i <= 4; i++) {
    const mv = truthy(mon) && truthy(mon.moves) ? mon.moves[i] : undefined;
    if (truthy(mv) && mv !== 0 && mv !== "") {
      const mt = move_type(mv);
      const [u1, u2] = mon_types(vm.user);
      const hasStab = (mt === u1 || mt === u2);
      const units = Types.aiTypeCalcUnits(mt, t1, t2, hasStab);
      if (units > best) best = units;
    }
  }
  vm.funcResult = best;
  next_ip(vm);
};

// Lua: ai_cmds.lua:711
CMD.if_type_effectiveness = function (vm, op) {
  const mt = move_type(vm.moveConsidered);
  const [t1, t2] = mon_types(vm.target);
  const [u1, u2] = mon_types(vm.user);
  const hasStab = (mt === u1 || mt === u2);
  const units = Types.aiTypeCalcUnits(mt, t1, t2, hasStab);
  if (units === (op.effectiveness ?? -1)) {
    branch(vm, op.target);
  } else {
    next_ip(vm);
  }
};

// Lua: ai_cmds.lua:724
CMD.if_status_in_party = function (vm, op) {
  // Best-effort: scan party for matching status1 bits
  const party = lor(land(op.battler === 1, land(vm.st, vm.st?.foeParty)), land(vm.st, vm.st?.playerParty));
  const mask = op.status ?? 0;
  if (truthy(party)) {
    for (const [, mon] of ipairs<any>(party)) {
      if (truthy(mon) && (tonumber(mon.hp) ?? 0) > 0) {
        const fake = { status: mon.status, mon: mon };
        if (bit_and_local(status1_bits(fake), mask) !== 0 || status1_bits(fake) === mask) {
          // pret compares status == statusToCompareTo exactly for in_party
          const bits = status1_bits(fake);
          if (bits === mask || (mask !== 0 && bit_and_local(bits, mask) === mask)) {
            branch(vm, op.target);
            return;
          }
        }
      }
    }
  }
  next_ip(vm);
};

// Lua: ai_cmds.lua:746
CMD.if_status_not_in_party = function (vm, _op) {
  // Bugged in pret; treat as no-op branch skip
  next_ip(vm);
};

// Lua: ai_cmds.lua:751
CMD.get_weather = function (vm, _op) {
  const w = land(vm.st, vm.st?.weather);
  // AI_WEATHER_SUN=0 RAIN=1 SAND=2 HAIL=3; no weather leaves 0 (pret zero-init)
  if (w === "rain" || w === "RAIN") vm.funcResult = 1;
  else if (w === "sandstorm" || w === "SANDSTORM" || w === "sand") vm.funcResult = 2;
  else if (w === "sun" || w === "SUN" || w === "sunny") vm.funcResult = 0;
  else if (w === "hail" || w === "HAIL") vm.funcResult = 3;
  else vm.funcResult = 0;
  next_ip(vm);
};

// Lua: ai_cmds.lua:763
CMD.if_effect = function (vm, op) {
  if (move_effect(vm.moveConsidered) === (op.effect ?? -1)) {
    branch(vm, op.target);
  } else {
    next_ip(vm);
  }
};

// Lua: ai_cmds.lua:771
CMD.if_not_effect = function (vm, op) {
  if (move_effect(vm.moveConsidered) !== (op.effect ?? -1)) {
    branch(vm, op.target);
  } else {
    next_ip(vm);
  }
};

// Lua: ai_cmds.lua:779
function stat_cmp(vm: AiVmState, op: AiOp, pred: (a: number, b: number) => boolean): void {
  const b = AiCmds.battler(vm, op.battler);
  const lvl = pret_stat_level(b, op.stat);
  if (pred(lvl, op.level ?? 0)) {
    branch(vm, op.target);
  } else {
    next_ip(vm);
  }
}

// Lua: ai_cmds.lua:789
CMD.if_stat_level_less_than = function (vm, op) { stat_cmp(vm, op, (a, b) => a < b); };
// Lua: ai_cmds.lua:790
CMD.if_stat_level_more_than = function (vm, op) { stat_cmp(vm, op, (a, b) => a > b); };
// Lua: ai_cmds.lua:791
CMD.if_stat_level_equal = function (vm, op) { stat_cmp(vm, op, (a, b) => a === b); };
// Lua: ai_cmds.lua:792
CMD.if_stat_level_not_equal = function (vm, op) { stat_cmp(vm, op, (a, b) => a !== b); };

// Lua: ai_cmds.lua:794
CMD.if_can_faint = function (vm, op) {
  if (move_power(vm.moveConsidered) < 2) {
    next_ip(vm);
    return;
  }
  const dmg = ai_damage(vm, vm.moveConsidered, vm.movesetIndex);
  const hp = tonumber(land(vm.target.mon, vm.target.mon?.hp)) ?? 0;
  if (hp <= dmg) {
    branch(vm, op.target);
  } else {
    next_ip(vm);
  }
};

// Lua: ai_cmds.lua:808
CMD.if_cant_faint = function (vm, op) {
  if (move_power(vm.moveConsidered) < 2) {
    next_ip(vm);
    return;
  }
  const dmg = ai_damage(vm, vm.moveConsidered, vm.movesetIndex);
  const hp = tonumber(land(vm.target.mon, vm.target.mon?.hp)) ?? 0;
  if (hp > dmg) {
    branch(vm, op.target);
  } else {
    next_ip(vm);
  }
};

// Lua: ai_cmds.lua:822
function mon_has_move(battler: any, moveId: unknown): boolean {
  const mon = land(battler, battler?.mon);
  if (!truthy(mon) || !truthy(mon.moves)) return false;
  for (let i = 1; i <= 4; i++) {
    const mv = mon.moves[i];
    if (mv === moveId) return true;
    if (typeof mv === "string" && Moves.numForName(mv) === moveId) return true;
  }
  return false;
}

// Lua: ai_cmds.lua:833
function rse_history(vm: AiVmState): boolean {
  return BattleProfile.rule(vm.st, "aiMoveHistory") === "battler";
}

// Lua: ai_cmds.lua:837
function history_moves(vm: AiVmState): Tbl {
  return Ai.usedMoves(vm.st, State.idOf(vm.target));
}

// Lua: ai_cmds.lua:842
function list_has(list: Tbl, moveId: unknown): boolean {
  const want = tonumber(moveId) ?? Moves.numForName(moveId);
  for (let i = 1; i <= 4; i++) {
    if (list[i] !== 0 && list[i] === want) return true;
  }
  return false;
}

// Lua: ai_cmds.lua:850
function own_moves(battler: any): Tbl {
  const out: Tbl = [null, 0, 0, 0, 0];
  const mon = land(battler, battler?.mon);
  for (let i = 1; i <= 4; i++) {
    const mv = truthy(mon) && truthy(mon.moves) ? mon.moves[i] : undefined;
    out[i] = typeof mv === "number" ? mv : lor(land(mv, truthy(mv) ? Moves.numForName(mv) : undefined), 0);
  }
  return out;
}

// Lua: ai_cmds.lua:861
// pokeemerald/src/battle_ai_script_commands.c:1803
function rse_has_move(vm: AiVmState, op: AiOp, negate: boolean): void {
  const which = tonumber(op.battler) ?? 0;
  let list: Tbl;
  if (which === 1 || (which === 3 && negate)) {
    list = own_moves(vm.user);
  } else if (which === 3) {
    const p = truthy(vm.st) ? State.battler(vm.st, State.PARTNER(State.idOf(vm.user)!)) : vm.st;
    if (!truthy(p) || (tonumber(land(p.mon, p.mon?.hp)) ?? 0) <= 0) return next_ip(vm);
    list = own_moves(p);
  } else {
    list = history_moves(vm);
  }
  const has = list_has(list, op.move);
  if (has !== negate) branch(vm, op.target); else next_ip(vm);
}

// Lua: ai_cmds.lua:879
// pokeemerald/src/battle_ai_script_commands.c:1901
function rse_has_effect(vm: AiVmState, op: AiOp, negate: boolean): void {
  const which = tonumber(op.battler) ?? 0;
  let found = false;
  if (which === 1 || which === 3) {
    for (const [, mv] of ipairs<number>(own_moves(vm.user))) {
      if (mv !== 0 && move_effect(mv) === op.effect) found = true;
    }
  } else {
    const hist = history_moves(vm);
    const gate = negate && truthy(hist) ? hist : own_moves(vm.user);
    for (let i = 1; i <= 4; i++) {
      if (gate[i] !== 0 && move_effect(hist[i]) === op.effect) found = true;
    }
  }
  if (found !== negate) branch(vm, op.target); else next_ip(vm);
}

// Lua: ai_cmds.lua:896
CMD.if_has_move = function (vm, op) {
  if (rse_history(vm)) return rse_has_move(vm, op, false);
  const b = AiCmds.battler(vm, op.battler);
  if (mon_has_move(b, op.move)) branch(vm, op.target); else next_ip(vm);
};
// Lua: ai_cmds.lua:901
CMD.if_doesnt_have_move = function (vm, op) {
  if (rse_history(vm)) return rse_has_move(vm, op, true);
  const b = AiCmds.battler(vm, op.battler);
  if (!mon_has_move(b, op.move)) branch(vm, op.target); else next_ip(vm);
};

// Lua: ai_cmds.lua:907
function mon_has_effect(battler: any, effect: unknown): boolean {
  const mon = land(battler, battler?.mon);
  if (!truthy(mon) || !truthy(mon.moves)) return false;
  for (let i = 1; i <= 4; i++) {
    const mv = mon.moves[i];
    if (truthy(mv) && mv !== 0 && mv !== "" && move_effect(mv) === effect) return true;
  }
  return false;
}

// Lua: ai_cmds.lua:917
CMD.if_has_move_with_effect = function (vm, op) {
  if (rse_history(vm)) return rse_has_effect(vm, op, false);
  const b = AiCmds.battler(vm, op.battler);
  if (b === vm.target) {
    // pret history path — best-effort use known moves
    if (mon_has_effect(b, op.effect)) branch(vm, op.target); else next_ip(vm);
  } else {
    if (mon_has_effect(b, op.effect)) branch(vm, op.target); else next_ip(vm);
  }
};

// Lua: ai_cmds.lua:928
CMD.if_doesnt_have_move_with_effect = function (vm, op) {
  if (rse_history(vm)) return rse_has_effect(vm, op, true);
  const b = AiCmds.battler(vm, op.battler);
  if (!mon_has_effect(b, op.effect)) branch(vm, op.target); else next_ip(vm);
};

// Lua: ai_cmds.lua:934
CMD.if_any_move_disabled_or_encored = function (vm, _op) {
  // best-effort false
  next_ip(vm);
};

// Lua: ai_cmds.lua:939
CMD.if_curr_move_disabled_or_encored = function (vm, _op) {
  next_ip(vm);
};

// Lua: ai_cmds.lua:944
// pokefirered/src/battle_ai_script_commands.c:1713
CMD.if_random_safari_flee = function (vm, op) {
  const rate = Rules.safari.fleeRate(land(vm.st, vm.st?.safariState));
  if (mod(random_u16(vm), 100) < rate) {
    branch(vm, op.target);
  } else {
    next_ip(vm);
  }
};

// Lua: ai_cmds.lua:954
CMD.get_hold_effect = function (vm, _op) {
  vm.funcResult = 0; // HOLD_EFFECT_NONE / ITEM_NONE
  next_ip(vm);
};

// Lua: ai_cmds.lua:959
CMD.get_gender = function (vm, _op) {
  vm.funcResult = 0;
  next_ip(vm);
};

// Lua: ai_cmds.lua:964
CMD.is_first_turn_for = function (vm, op) {
  const b = AiCmds.battler(vm, op.battler);
  vm.funcResult = truthy(land(b, b?.isFirstTurn)) ? 1 : 0;
  if (truthy(b) && b.isFirstTurn == null && truthy(vm.st) && lor(vm.st.turn, 0) <= 1) {
    vm.funcResult = 1;
  }
  next_ip(vm);
};

// Lua: ai_cmds.lua:973
CMD.get_stockpile_count = function (vm, op) {
  const b = AiCmds.battler(vm, op.battler);
  vm.funcResult = lor(land(b, b?.stockpile), 0);
  next_ip(vm);
};

// Lua: ai_cmds.lua:980
// src/battle_ai_script_commands.c:1806
CMD.is_double_battle = function (vm, _op) {
  vm.funcResult = (truthy(vm.st) && truthy(vm.st.double)) ? 1 : 0;
  next_ip(vm);
};

// Lua: ai_cmds.lua:985
CMD.get_used_held_item = function (vm, _op) {
  vm.funcResult = 0;
  next_ip(vm);
};

// Lua: ai_cmds.lua:990
CMD.get_move_type_from_result = function (vm, _op) {
  vm.funcResult = move_type(vm.funcResult);
  next_ip(vm);
};

// Lua: ai_cmds.lua:995
CMD.get_move_power_from_result = function (vm, _op) {
  vm.funcResult = move_power(vm.funcResult);
  next_ip(vm);
};

// Lua: ai_cmds.lua:1000
CMD.get_move_effect_from_result = function (vm, _op) {
  vm.funcResult = move_effect(vm.funcResult);
  next_ip(vm);
};

// Lua: ai_cmds.lua:1005
CMD.get_protect_count = function (vm, op) {
  const b = AiCmds.battler(vm, op.battler);
  // pokefirered/src/battle_ai_script_commands.c:1847-1856
  vm.funcResult = lor(land(b, b?.expProtectStreak), 0);
  next_ip(vm);
};

// Lua: ai_cmds.lua:1012
CMD.if_level_cond = function (vm, op) {
  const ul = tonumber(land(vm.user.mon, vm.user.mon?.level)) ?? 1;
  const tl = tonumber(land(vm.target.mon, vm.target.mon?.level)) ?? 1;
  const cond = op.cond ?? 0;
  let ok = false;
  if (cond === 0) ok = ul > tl;
  else if (cond === 1) ok = ul < tl;
  else if (cond === 2) ok = ul === tl;
  if (ok) branch(vm, op.target); else next_ip(vm);
};

// Lua: ai_cmds.lua:1024
CMD.if_target_taunted = function (vm, _op) {
  next_ip(vm); // false
};

// Lua: ai_cmds.lua:1028
CMD.if_target_not_taunted = function (vm, op) {
  branch(vm, op.target); // always true (taunt unsupported)
};

// Lua: ai_cmds.lua:1032
function can_escape_check(user: any, target: any): boolean {
  if (!truthy(user)) return true;
  if (truthy(user.meanLook) || truthy(user.escapePrevention) || truthy(user.expTrapped) || truthy(user.expTrappedBy)
      || lor(user.expTrapTurns, 0) > 0 || truthy(user.wrapped) || truthy(user.expIngrain)) {
    return false;
  }
  if (truthy(target) && !(truthy(target.fainted) || (truthy(target.mon) && (tonumber(target.mon.hp) ?? 0) <= 0))) {
    const tab = ability_of(target);
    const uab = ability_of(user);
    // SHADOW_TAG: 23
    if (tab === 23 && uab !== 23) {
      return false;
    }
    // ARENA_TRAP: 71, LEVITATE: 26, FLYING: 2
    if (tab === 71 && uab !== 26) {
      const [t1, t2] = mon_types(user);
      if (t1 !== Types.ID.FLYING && t2 !== Types.ID.FLYING) {
        return false;
      }
    }
    // MAGNET_PULL: 42, STEEL: 8
    if (tab === 42) {
      const [t1, t2] = mon_types(user);
      if (t1 === Types.ID.STEEL || t2 === Types.ID.STEEL) {
        return false;
      }
    }
  }
  return true;
}

// Lua: ai_cmds.lua:1062
CMD.if_can_escape = function (vm, op) {
  if (can_escape_check(vm.user, vm.target)) branch(vm, op.target); else next_ip(vm);
};

// Lua: ai_cmds.lua:1066
CMD.if_cant_escape = function (vm, op) {
  if (!can_escape_check(vm.user, vm.target)) branch(vm, op.target); else next_ip(vm);
};

// Lua: ai_cmds.lua:1070
AiCmds.canEscape = function (user: any, target: any): boolean {
  return can_escape_check(user, target);
};

// Lua: ai_cmds.lua:1075
// pokeemerald/src/battle_ai_script_commands.c:1140
function wanted_battler(vm: AiVmState, which: unknown): any {
  if (which === 1) return vm.user;
  if (which === 3 || which === 2) {
    const base = (which === 3) ? vm.user : vm.target;
    const id = State.idOf(base);
    if (id != null && truthy(vm.st)) return lor(State.battler(vm.st, State.PARTNER(id)), null);
    return null;
  }
  return vm.target;
}

// Lua: ai_cmds.lua:1086
function same_side(a: any, b: any): boolean {
  return a != null && b != null && a.side === b.side;
}

// Lua: ai_cmds.lua:1091
// pokeemerald/src/battle_ai_script_commands.c:2268
CMD.if_target_is_ally = function (vm, op) {
  if (same_side(vm.user, vm.target)) branch(vm, op.target); else next_ip(vm);
};

// Lua: ai_cmds.lua:1096
// pokeemerald/src/battle_ai_script_commands.c:1156
CMD.is_of_type = function (vm, op) {
  const b = wanted_battler(vm, op.battler);
  const [t1, t2] = mon_types(b);
  vm.funcResult = (truthy(b) && (t1 === op.type || t2 === op.type)) ? 1 : 0;
  next_ip(vm);
};

const ABILITY_SHADOW_TAG = 23, ABILITY_MAGNET_PULL = 42, ABILITY_ARENA_TRAP = 71;

// Lua: ai_cmds.lua:1106
// pokeemerald/src/battle_ai_script_commands.c:1407
CMD.check_ability = function (vm, op) {
  const b = wanted_battler(vm, op.battler);
  const want = tonumber(op.ability) ?? 0;
  let ability: any = want;
  if (op.battler === 0 || op.battler === 2) {
    const hist = land(vm.st, land(vm.st?._aiHistory, vm.st?._aiHistory?.abilities));
    const recorded = land(hist, truthy(hist) ? hist[State.idOf(b) as any] : undefined);
    const own = ability_of(b);
    if (truthy(recorded) && recorded !== 0) {
      ability = recorded;
      vm.funcResult = ability;
    } else if (own === ABILITY_SHADOW_TAG || own === ABILITY_MAGNET_PULL || own === ABILITY_ARENA_TRAP) {
      ability = own;
    } else {
      const species = truthy(b) ? lor(tonumber(lor(b.species, land(b.mon, b.mon?.species))), 0) : 0;
      const pair = lor(Pokemon.abilities(species), {});
      const a1 = lor(pair[1], 0), a2 = lor(pair[2], 0);
      if (a1 !== 0) {
        if (a2 !== 0) {
          if (a1 !== want && a2 !== want) ability = a1; else ability = 0;
        } else {
          ability = a1;
        }
      } else {
        ability = a2;
      }
    }
  } else {
    ability = ability_of(b);
  }
  if (ability === 0) {
    vm.funcResult = 2;
  } else if (ability === want) {
    vm.funcResult = 1;
  } else {
    vm.funcResult = 0;
  }
  next_ip(vm);
};

// Lua: ai_cmds.lua:1148
// pokeemerald/src/battle_ai_script_commands.c:2276
CMD.if_flash_fired = function (vm, op) {
  const b = wanted_battler(vm, op.battler);
  if (truthy(b) && truthy(b.expFlashFire)) branch(vm, op.target); else next_ip(vm);
};

// Lua: ai_cmds.lua:1154
// pokeemerald/src/battle_ai_script_commands.c:2061
CMD.if_holds_item = function (vm, op) {
  const b = wanted_battler(vm, op.battler);
  let item = 0;
  if (same_side(b, vm.user)) {
    const mon = land(b, b?.mon);
    item = tonumber(land(b, lor(b?.item, land(mon, lor(mon?.item, mon?.heldItem))))) ?? 0;
  } else {
    const hist = land(vm.st, land(vm.st?._aiHistory, vm.st?._aiHistory?.itemEffects));
    item = tonumber(land(hist, truthy(hist) ? hist[State.idOf(b) as any] : undefined)) ?? 0;
  }
  const v = tonumber(op.item) ?? 0;
  if (bit_or_local(mod(v, 256), mod(Math.floor(v / 256), 256)) === item) {
    branch(vm, op.target);
  } else {
    next_ip(vm);
  }
};

// Lua: ai_cmds.lua:1173
AiCmds.dispatch = function (vm: AiVmState, op: AiOp | null | undefined): void {
  if (!truthy(op) || !truthy(op!.op)) {
    vm.done = true;
    return;
  }
  const fn = CMD[op!.op as string];
  if (truthy(fn)) {
    fn(vm, op!);
  } else {
    // unknown: skip safely
    next_ip(vm);
  }
};

AiCmds.CMD = CMD;
AiCmds.STATUS1 = STATUS1;
AiCmds.move_effect = move_effect;
AiCmds.move_power = move_power;
AiCmds.ai_damage = ai_damage;

export default AiCmds;
