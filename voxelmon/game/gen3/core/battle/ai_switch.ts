// Port of gen1recomp src/core/game3/battle/ai_switch.lua (GPLv3 + additional terms; see LICENSE.md).
// FireRed battle AI switch decision (port of battle_ai_switch_items.c).
//
// Port notes:
// - `pcall(require, adapter)` and the lazy requires (link_guard, engine) are
//   static imports.
// - Multiple returns are 0-based tuples: shouldSwitch -> [false] or
//   [true, pick] (pick may be null); the local predicates likewise;
//   battlers_in -> [in1, in2]. trySwitch returns a party slot or null.
// - Lua `x and a or b` with a possibly nil is kept as Lua evaluates it
//   (party_of falls back to foeParty when playerParty is nil).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { mod, tonumber, tostring, truthy } from "../../../../import/gen3/lua.ts";
import { len, pairs, type LuaTable } from "../../platform/lt.ts";
import { gsub } from "../../platform/lpattern.ts";
import State from "./state.ts";
import Moves from "./moves.ts";
import Types from "./types.ts";
import Pokemon from "../pokemon.ts";
import Adapter from "./adapter.ts";
import Guard from "./link_guard.ts";
import Engine from "./engine.ts";
import type { AiRng } from "./ai_vm.ts";

type Tbl = LuaTable;

/** ai_type_calc's result flags (pret MOVE_RESULT_*). */
export interface AiTypeFlags {
  super: boolean;
  notVery: boolean;
  noEffect: boolean;
  [k: string]: boolean;
}

export interface AiSwitchModule {
  aiTypeCalc(mv: unknown, species: unknown, ability: number): AiTypeFlags;
  shouldSwitch(st: any, id: number, rng: AiRng): [boolean, (number | null)?];
  trySwitch(st: any, ad: any, id: number, rng: AiRng): number | null;
}

export const AiSwitch = {} as AiSwitchModule;

const AB = {
  VOLT_ABSORB: 10, WATER_ABSORB: 11, FLASH_FIRE: 18, SHADOW_TAG: 23,
  WONDER_GUARD: 25, LEVITATE: 26, NATURAL_CURE: 30, MAGNET_PULL: 42, ARENA_TRAP: 71,
};
const MOVE_STRUGGLE = 165;
const LAST_HIT_NONE = 0xFF;

let ABILITY_BY_NAME: Record<string, number> | null = null;
// Lua: ai_switch.lua:18
function ability_id(v: unknown): number {
  if (v == null) return 0;
  const n = tonumber(v);
  if (n != null) return n;
  if (typeof v !== "string" || v === "") return 0;
  if (!ABILITY_BY_NAME) {
    ABILITY_BY_NAME = {};
    // Lua: pcall(require, "src.core.game3.battle.adapter") -- always loads here
    if (truthy(Adapter) && truthy(Adapter.ABILITY_BY_ID)) {
      for (const [id, name] of pairs(Adapter.ABILITY_BY_ID)) ABILITY_BY_NAME[name as string] = id as number;
    }
  }
  return ABILITY_BY_NAME[gsub(v.toUpperCase(), "%s+", "_")[0]] ?? 0;
}

// Lua: ai_switch.lua:33
function battler_ability(b: any): number {
  if (!truthy(b)) return 0;
  if (truthy(b.expTracedAbility)) return ability_id(b.expTracedAbility);
  let a = b.ability;
  if (a == null && truthy(b.mon)) a = truthy(b.mon.ability) ? b.mon.ability : b.mon.abilityId;
  return ability_id(a);
}

// Lua: ai_switch.lua:41
function move_num(mv: unknown): number {
  const n = tonumber(mv);
  if (n != null) return n;
  if (mv == null || mv === "") return 0;
  return truthy(Moves.numForName) ? (Moves.numForName(mv) ?? 0) : 0;
}

// Lua: ai_switch.lua:48
function move_def(mv: unknown): Tbl {
  const n = move_num(mv);
  if (n === 0) return null;
  return Moves.get(mv);
}

// Lua: ai_switch.lua:54
function move_power(mv: unknown): number {
  const m = move_def(mv);
  return truthy(m) ? (tonumber(m.power) ?? 0) : 0;
}

// Lua: ai_switch.lua:59
function move_type(mv: unknown): number {
  const m = move_def(mv);
  return truthy(m) ? (tonumber(m.type) ?? 0) : 0;
}

// Lua: ai_switch.lua:64
function species_of(mon: any): number {
  if (!truthy(mon)) return 0;
  const s = truthy(mon.species) ? mon.species : truthy(mon.speciesId) ? mon.speciesId : mon.id;
  if (typeof s === "number") return s;
  if (typeof s === "string") {
    const fromName = truthy(Pokemon.speciesFromName) ? Pokemon.speciesFromName(s) : null;
    return truthy(fromName) ? (fromName as number) : (tonumber(s) ?? 0);
  }
  return 0;
}

// Lua: ai_switch.lua:74
function mon_usable(mon: any): boolean {
  return mon != null && (tonumber(mon.hp) ?? 0) !== 0 && species_of(mon) !== 0 && !truthy(mon.isEgg);
}

// Lua: ai_switch.lua:79
// src/battle_ai_switch_items.c:112
function party_ability(mon: any): number {
  const explicit = truthy(mon) ? (truthy(mon.ability) ? mon.ability : mon.abilityId) : mon;
  if (explicit != null) return ability_id(explicit);
  const pair = Pokemon.abilities(species_of(mon));
  let num = truthy(mon) ? mon.abilityNum : mon;
  if (num == null) {
    num = ((pair[2] ?? 0) !== 0) ? mod(tonumber(truthy(mon) ? mon.personality : mon) ?? 0, 2) : 0;
  }
  if (num !== 0) return pair[2] ?? 0;
  return pair[1] ?? 0;
}

// Lua: ai_switch.lua:92
// src/battle_script_commands.c:1513
function ai_type_calc(mv: unknown, species: unknown, ability: number): AiTypeFlags {
  const f: AiTypeFlags = { super: false, notVery: false, noEffect: false };
  if (move_num(mv) === MOVE_STRUGGLE || move_num(mv) === 0) return f;
  const mt = move_type(mv);
  const power = move_power(mv);
  if (ability === AB.LEVITATE && mt === Types.ID.GROUND) {
    f.noEffect = true;
  } else {
    const ty = Pokemon.types(species);
    const t1 = ty[1] ?? 0, t2 = ty[2] ?? 0;
    // Lua: ai_switch.lua:102
    const modulate = (mult: number): void => {
      if (mult === 0) {
        f.noEffect = true; f.notVery = false; f.super = false;
      } else if (mult === 5) {
        if (power !== 0 && !f.noEffect) {
          if (f.super) f.super = false; else f.notVery = true;
        }
      } else if (mult === 20) {
        if (power !== 0 && !f.noEffect) {
          if (f.notVery) f.notVery = false; else f.super = true;
        }
      }
    };
    const t = Types.TABLE;
    for (let i = 1; i <= len(t); i += 3) {
      const a = t[i], d = t[i + 1], m = t[i + 2];
      if (a !== -1 && a === mt) {
        if (d === t1) modulate(m as number);
        if (d === t2 && t1 !== t2) modulate(m as number);
      }
    }
  }
  if (ability === AB.WONDER_GUARD && (!f.super || (f.super && f.notVery)) && power !== 0) {
    f.noEffect = true;
  }
  return f;
}
AiSwitch.aiTypeCalc = ai_type_calc;

// Lua: ai_switch.lua:131
function roll(rng: AiRng, lo: number, hi: number): number {
  try {
    const v = rng(lo, hi);
    if (typeof v === "number") return v;
  } catch (_e) { /* pcall failed */ }
  return Guard.fallback("ai_switch.roll", lo, hi);
}

// Lua: ai_switch.lua:137
function status_bits(b: any): number {
  let s = truthy(b) ? (truthy(b.status) ? b.status : (truthy(b.mon) ? b.mon.status : b.mon)) : b;
  if (typeof s === "number") return s;
  s = truthy(s) ? tostring(s).toUpperCase() : "";
  if (s === "SLP" || s === "SLEEP") return 0x7;
  return 0;
}

// Lua: ai_switch.lua:145
function moves_of(b: any): Tbl {
  return (truthy(b) && truthy(b.mon) && truthy(b.mon.moves)) ? b.mon.moves : [];
}

// Lua: ai_switch.lua:149
function last_landed(b: any): number {
  return move_num(truthy(b) ? b.expLastLandedMove : b);
}

// Lua: ai_switch.lua:153
function last_hit_by(b: any): any {
  const id = truthy(b) ? b.expLastHitById : b;
  if (id == null) return LAST_HIT_NONE;
  return id;
}

// Lua: ai_switch.lua:159
function battlers_in(st: any, id: number): [number, number] {
  let in2 = id;
  if (truthy(st.double)) {
    const pid = State.PARTNER(id);
    if (!State.isAbsent(st, pid) && truthy(State.battler(st, pid))) in2 = pid;
  }
  return [id, in2];
}

// Lua: ai_switch.lua:168
function excluded(st: any, i: number, in1: number, in2: number): boolean {
  const b1 = State.battler(st, in1), b2 = State.battler(st, in2);
  const pend = truthy(st.monToSwitchInto) ? st.monToSwitchInto : {};
  return (truthy(b1) && b1.partyIndex === i) || (truthy(b2) && b2.partyIndex === i)
    || pend[in1] === i || pend[in2] === i
    // pokeemerald/src/battle_ai_switch_items.c:66
    || ((st.foeHalf != null || st.playerHalf != null) && !truthy(State.ownsSlot(st, in1, i)));
}

// Lua: ai_switch.lua:177
function party_of(st: any, id: number): Tbl {
  return (mod(id, 2) === 0 && truthy(st.playerParty)) ? st.playerParty : st.foeParty;
}

// Lua: ai_switch.lua:182
// pokeemerald/src/battle_ai_switch_items.c:49
function opposing_left(id: number): number {
  return (mod(id, 2) === 0) ? 1 : 0;
}

// Lua: ai_switch.lua:186
function num_battlers(st: any): number {
  return truthy(st.double) ? 4 : 2;
}

// Lua: ai_switch.lua:191
// src/battle_ai_switch_items.c:17
function if_perish_song(_st: any, b: any): [boolean, (number | null)?] {
  if (truthy(b.perishSong) && tonumber(b.expPerishTurns) === 0) return [true, null];
  return [false];
}

// Lua: ai_switch.lua:197
// src/battle_ai_switch_items.c:32
function if_wonder_guard(st: any, b: any, id: number, rng: AiRng): [boolean, (number | null)?] {
  if (truthy(st.double)) return [false];
  const opp = State.battler(st, opposing_left(id));
  if (!truthy(opp) || battler_ability(opp) !== AB.WONDER_GUARD) return [false];
  for (let i = 1; i <= 4; i++) {
    const mv = moves_of(b)[i];
    if (move_num(mv) !== 0 && ai_type_calc(mv, opp.species, battler_ability(opp)).super) return [false];
  }
  const party = party_of(st, id);
  for (let i = 1; i <= 6; i++) {
    const mon = truthy(party) ? party[i] : party;
    if (mon_usable(mon) && i !== b.partyIndex) {
      for (let j = 1; j <= 4; j++) {
        const mv = truthy(mon.moves) ? mon.moves[j] : mon.moves;
        if (move_num(mv) !== 0 && ai_type_calc(mv, opp.species, battler_ability(opp)).super
            && roll(rng, 0, 2) < 2) {
          return [true, i];
        }
      }
    }
  }
  return [false];
}

// Lua: ai_switch.lua:222
// src/battle_ai_switch_items.c:176
function has_super_effective(st: any, b: any, noRng: boolean, rng: AiRng, id?: number): boolean {
  // Lua: ai_switch.lua:223
  const scan = (oid: number): boolean => {
    const opp = State.battler(st, oid);
    if (State.isAbsent(st, oid) || !truthy(opp)) return false;
    for (let i = 1; i <= 4; i++) {
      const mv = moves_of(b)[i];
      if (move_num(mv) !== 0 && ai_type_calc(mv, opp.species, battler_ability(opp)).super) {
        if (noRng || roll(rng, 0, 9) !== 0) return true;
      }
    }
    return false;
  };
  const left = opposing_left(id ?? 1);
  if (scan(left)) return true;
  if (!truthy(st.double)) return false;
  return scan(left + 2);
}

// Lua: ai_switch.lua:241
// src/battle_ai_switch_items.c:82
function absorbs_opponents_move(st: any, b: any, id: number, rng: AiRng): [boolean, (number | null)?] {
  if ((has_super_effective(st, b, true, rng, id) && roll(rng, 0, 2) !== 0) || last_landed(b) === 0) {
    return [false];
  }
  const last = b.expLastLandedMove;
  if (last_landed(b) === 0xFFFF || move_power(last) === 0) return [false];
  const mt = move_type(last);
  let absorb: number;
  if (mt === Types.ID.FIRE) absorb = AB.FLASH_FIRE;
  else if (mt === Types.ID.WATER) absorb = AB.WATER_ABSORB;
  else if (mt === Types.ID.ELECTRIC) absorb = AB.VOLT_ABSORB;
  else return [false];
  if (battler_ability(b) === absorb) return [false];
  const [in1, in2] = battlers_in(st, id);
  for (let i = 1; i <= 6; i++) {
    const party = party_of(st, id);
    const mon = truthy(party) ? party[i] : party;
    if (mon_usable(mon) && !excluded(st, i, in1, in2)) {
      if (absorb === party_ability(mon) && roll(rng, 0, 1) === 1) return [true, i];
    }
  }
  return [false];
}

// Lua: ai_switch.lua:265
// src/battle_ai_switch_items.c:236
function find_mon_with_flags(st: any, b: any, id: number, flag: string, modulo: number, rng: AiRng): [boolean, (number | null)?] {
  const last = last_landed(b);
  if (last === 0) return [false];
  if (last === 0xFFFF || last_hit_by(b) === LAST_HIT_NONE || move_power(b.expLastLandedMove) === 0) {
    return [false];
  }
  const [in1, in2] = battlers_in(st, id);
  for (let i = 1; i <= 6; i++) {
    const party = party_of(st, id);
    const mon = truthy(party) ? party[i] : party;
    if (mon_usable(mon) && !excluded(st, i, in1, in2)) {
      const f = ai_type_calc(b.expLastLandedMove, species_of(mon), party_ability(mon));
      if (f[flag]) {
        const opp = State.battler(st, last_hit_by(b));
        for (let j = 1; j <= 4; j++) {
          const mv = truthy(mon.moves) ? mon.moves[j] : mon.moves;
          if (move_num(mv) !== 0 && truthy(opp)
              && ai_type_calc(mv, opp.species, battler_ability(opp)).super
              && roll(rng, 0, modulo - 1) === 0) {
            return [true, i];
          }
        }
      }
    }
  }
  return [false];
}

// Lua: ai_switch.lua:293
// src/battle_ai_switch_items.c:146
function if_natural_cure(st: any, b: any, id: number, rng: AiRng): [boolean, (number | null)?] {
  const hp = tonumber(truthy(b.mon) ? b.mon.hp : b.mon) ?? 0;
  const maxHp = tonumber(truthy(b.mon) ? b.mon.maxHp : b.mon) ?? 1;
  if (mod(status_bits(b), 8) === 0 || battler_ability(b) !== AB.NATURAL_CURE || hp < Math.floor(maxHp / 2)) {
    return [false];
  }
  const last = last_landed(b);
  if ((last === 0 || last === 0xFFFF) && roll(rng, 0, 1) === 1) {
    return [true, null];
  } else if (move_power(last) === 0 && roll(rng, 0, 1) === 1) {
    return [true, null];
  }
  let [ok, pick] = find_mon_with_flags(st, b, id, "noEffect", 1, rng);
  if (ok) return [true, pick];
  [ok, pick] = find_mon_with_flags(st, b, id, "notVery", 1, rng);
  if (ok) return [true, pick];
  if (roll(rng, 0, 1) === 1) return [true, null];
  return [false];
}

// Lua: ai_switch.lua:314
// src/battle_ai_switch_items.c:223
function stats_raised(b: any): boolean {
  let total = 0;
  for (const [, v0] of pairs(truthy(b.stages) ? b.stages : {})) {
    const v = tonumber(v0) ?? 0;
    if (v > 0) total = total + v;
  }
  return total > 3;
}

// Lua: ai_switch.lua:323
function is_steel(b: any): boolean {
  return b.type1 === Types.ID.STEEL || b.type2 === Types.ID.STEEL;
}

// Lua: ai_switch.lua:328
// src/battle_ai_switch_items.c:302
AiSwitch.shouldSwitch = function (st: any, id: number, rng: AiRng): [boolean, (number | null)?] {
  const b = State.battler(st, id);
  if (!truthy(b) || !truthy(b.mon)) return [false];
  if (truthy(b.expTrapped) || truthy(b.escapePrevention) || (tonumber(b.expTrapTurns) ?? 0) > 0 || truthy(b.expIngrain)) {
    return [false];
  }
  for (let oid = 0; oid <= num_battlers(st) - 1; oid++) {
    const o = State.battler(st, oid);
    if (truthy(o) && State.sideOf(oid) !== State.sideOf(id)) {
      const a = battler_ability(o);
      if (a === AB.SHADOW_TAG || a === AB.ARENA_TRAP) return [false];
    }
  }
  for (let oid = 0; oid <= num_battlers(st) - 1; oid++) {
    const o = State.battler(st, oid);
    if (truthy(o) && battler_ability(o) === AB.MAGNET_PULL && is_steel(b)) return [false];
  }
  const [in1, in2] = battlers_in(st, id);
  let available = 0;
  for (let i = 1; i <= 6; i++) {
    const party = party_of(st, id);
    const mon = truthy(party) ? party[i] : party;
    if (mon_usable(mon) && !excluded(st, i, in1, in2)) available = available + 1;
  }
  if (available === 0) return [false];

  let [ok, pick] = if_perish_song(st, b);
  if (ok) return [true, pick];
  [ok, pick] = if_wonder_guard(st, b, id, rng);
  if (ok) return [true, pick];
  [ok, pick] = absorbs_opponents_move(st, b, id, rng);
  if (ok) return [true, pick];
  [ok, pick] = if_natural_cure(st, b, id, rng);
  if (ok) return [true, pick];
  if (has_super_effective(st, b, false, rng, id) || stats_raised(b)) return [false];
  [ok, pick] = find_mon_with_flags(st, b, id, "noEffect", 2, rng);
  if (ok) return [true, pick];
  [ok, pick] = find_mon_with_flags(st, b, id, "notVery", 3, rng);
  if (ok) return [true, pick];
  return [false];
};

// Lua: ai_switch.lua:370
// src/battle_ai_switch_items.c:358
AiSwitch.trySwitch = function (st: any, ad: any, id: number, rng: AiRng): number | null {
  const [ok, pick0] = AiSwitch.shouldSwitch(st, id, rng);
  if (!ok) return null;
  let pick: number | null | undefined = pick0;
  if (pick == null) {
    if (truthy(Engine.mostSuitableMon)) pick = Engine.mostSuitableMon(st, ad, id);
    if (pick == null) {
      const in1 = (mod(id, 2) === 0) ? id : 1;
      const in2 = truthy(st.double) ? State.PARTNER(in1) : in1;
      for (let i = 1; i <= 6; i++) {
        const party = party_of(st, id);
        const mon = truthy(party) ? party[i] : party;
        if (truthy(mon) && (tonumber(mon.hp) ?? 0) !== 0 && !excluded(st, i, in1, in2)) {
          pick = i;
          break;
        }
      }
    }
  }
  return pick ?? null;
};

export default AiSwitch;
