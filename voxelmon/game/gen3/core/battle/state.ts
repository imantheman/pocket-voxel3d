// Port of gen1recomp src/core/game3/battle/state.lua (GPLv3 + additional terms; see LICENSE.md).
// Battle state: battlers, sides, weather, result.
//
// Port notes:
// - battler_slots (State.newSlots): Brian's metatable maps slots 0 and 1 to
//   st.player / st.enemy and stores 2 and 3 raw. Here keys 0 and 1 are
//   non-enumerable accessors on a plain object (so pairs() skips them, as
//   Lua's pairs skips __index keys) and 2/3 are ordinary keys.
// - ensureBattleMoves' proxy (`{moves, pp}` with __index/__newindex = base)
//   is a JS Proxy: own `moves`/`pp` (while non-nil), every other read and
//   write goes to the party mon. pairs() over it sees only moves/pp, as Lua.
// - package.loaded engine, the lazy requires (link_guard, rng, adapter,
//   battle_text, rom_text) are static imports.
// - types_for returns [type1, type2] (a Lua multiple return).

import { tonumber, tostring, truthy, mod } from "../../../../import/gen3/lua.ts";
import { ipairs, len, seq, type LuaTable } from "../../platform/lt.ts";
import { Damage } from "./damage.ts";
import { Pokemon } from "../pokemon.ts";
import { Engine } from "./engine.ts";
import { Guard } from "./link_guard.ts";
import { Rng } from "../rng.ts";
import { Adapter } from "./adapter.ts";
import { BattleText } from "./battle_text.ts";
import { RomText } from "../rom_text.ts";

export type Battler = Record<string, any>;
export type BattleState = Record<string, any>;

// Lua: state.lua:9
function species_id(mon: any): number {
  if (!truthy(mon)) return 1;
  const s = truthy(mon.species) ? mon.species : mon.id;
  if (typeof s === "number") return s;
  if (typeof s === "string") {
    const id = Pokemon.speciesFromName(s);
    if (truthy(id)) return id as number;
    return tonumber(s) ?? 1;
  }
  return 1;
}

// Lua: state.lua:21
function types_for(species: number): [number, number] {
  if (!truthy(Pokemon._types)) {
    try {
      Pokemon.install(null);
    } catch (errI) {
      if (!truthy(Pokemon._installWarned)) {
        Pokemon._installWarned = true;
        console.log("[game3/pokemon] install failed: " + tostring(errI instanceof Error ? errI.message : errI));
      }
    }
  }
  const t = Pokemon.types(species);
  return [t[1] ?? 0, t[2] ?? 0];
}

// Lua: state.lua:33
function held_item(mon: any): number {
  if (!truthy(mon)) return 0;
  return tonumber(truthy(mon.item) ? mon.item : mon.heldItem) ?? 0;
}

const zeroStages = () => ({
  attack: 0, defense: 0, spAtk: 0, spDef: 0, speed: 0,
  accuracy: 0, evasion: 0,
});

// Lua: state.lua:248
function battler_slots(st: BattleState): LuaTable {
  const t: LuaTable = {};
  Object.defineProperty(t, 0, {
    get: () => st.player,
    set: (v) => { st.player = v; },
    enumerable: false,
    configurable: false,
  });
  Object.defineProperty(t, 1, {
    get: () => st.enemy,
    set: (v) => { st.enemy = v; },
    enumerable: false,
    configurable: false,
  });
  return t;
}

// Lua: state.lua:264
function first_usable(party: LuaTable, exclude?: number | null): number | null {
  const n = len(party ?? {});
  for (let i = 1; i <= n; i++) {
    const m = party[i];
    if (i !== exclude && truthy(m) && !truthy(m.isEgg) && (tonumber(m.hp) ?? 0) > 0
        && (tonumber(truthy(m.species) ? m.species : m.speciesId) ?? 0) !== 0) {
      return i;
    }
  }
  return null;
}

// Lua: state.lua:296 -- pokefirered/src/battle_controllers.c:237
function first_owned(party: LuaTable, owners: LuaTable, id: number, exclude?: number | null): number | null {
  const n = len(party ?? {});
  for (let i = 1; i <= n; i++) {
    const m = party[i];
    if (owners[i] === id && i !== exclude && truthy(m) && !truthy(m.isEgg) && (tonumber(m.hp) ?? 0) > 0
        && (tonumber(truthy(m.species) ? m.species : m.speciesId) ?? 0) !== 0) {
      return i;
    }
  }
  return null;
}

// Lua: state.lua:533
// pret pokefirered/src/battle_main.c gWishFutureKnock.knockedOffMons: one bit
// per party index per side.  A mon whose item was knocked off stays marked for
// the rest of the battle even after it switches out and back in -- the
// per-battler `expKnockedOff` volatile dies with the battler, so Thief and
// Trick would otherwise be allowed against it again.
function knocked_off_key(b: any): [string | null, number?] {
  const side = truthy(b) ? b.side : null;
  if (side !== "player" && side !== "enemy") return [null];
  const idx = tonumber(truthy(b) ? b.partyIndex : null) ?? 1;
  if (idx < 1 || idx > 6) return [null];
  return [side, 1 << (idx - 1)];
}

const LOCAL_ORDER = seq(0, 1, 2, 3);
// pokefirered/src/battle_controllers.c:163
const LINK_FOLLOWER_ORDER = seq(1, 0, 3, 2);

export const State = {
  newSlots: battler_slots,
  firstUsable: first_usable,

  // Lua: state.lua:38
  makeBattler(mon: any, side: string, opts?: any): Battler {
    opts = opts ?? {};
    const id = tonumber(opts.id) ?? ((side === "enemy") ? 1 : 0);
    mon = Damage.ensureStats(mon, truthy(mon) ? mon.level : mon);
    const species = species_id(mon);
    const [t1, t2] = types_for(species);
    let ability = truthy(mon.ability) ? mon.ability : mon.abilityId;
    if (!truthy(ability) && truthy(Pokemon.abilityId)) {
      ability = Pokemon.abilityId(species, truthy(mon.personality) ? mon.personality : 0);
    }
    const b: Battler = {
      mon,
      id,
      side, // "player" | "enemy"
      flank: (id < 2) ? "left" : "right",
      partyIndex: truthy(opts.partyIndex) ? opts.partyIndex : 1,
      species,
      type1: t1,
      type2: (t2 !== t1) ? t2 : null,
      ability,
      item: held_item(mon),
      stages: zeroStages(),
      status: mon.status,
      fainted: (tonumber(mon.hp) ?? 0) <= 0,
      // pokefirered/src/battle_main.c:2228
      isFirstTurn: 2,
    };
    // pokefirered/src/battle_script_commands.c:4489
    if (truthy(opts.st) && State.isKnockedOff(opts.st, b)) {
      b.item = 0;
      b.expKnockedOff = true;
    }
    return b;
  },

  // Lua: state.lua:77 -- pokefirered/src/battle_main.c:2565
  zeroBattler(b: any): any {
    if (b === null || typeof b !== "object") return b;
    b.mon = { species: 0, level: 0, hp: 0, maxHp: 0, moves: {}, pp: {} };
    b.species = 0;
    b.type1 = 0;
    b.type2 = null;
    b.ability = null;
    b.item = 0;
    b.status = null;
    b.partyIndex = null;
    b._partyMon = null;
    b.participants = null;
    b.stages = zeroStages();
    b.isFirstTurn = 0;
    b.zeroed = true;
    return b;
  },

  // Lua: state.lua:97
  PARTNER(id: number): number { return mod(id + 2, 4); },
  // Lua: state.lua:98
  OPPOSITE(id: number): number { return (mod(id, 2) === 0) ? (id + 1) : (id - 1); },
  // Lua: state.lua:99
  sideOf(id: number): string { return (mod(id, 2) === 0) ? "player" : "enemy"; },
  // Lua: state.lua:100
  flankOf(id: number): string { return (id < 2) ? "left" : "right"; },
  // Lua: state.lua:101
  positionsOnSide(side: string): LuaTable { return (side === "player") ? seq(0, 2) : seq(1, 3); },

  // Lua: state.lua:103
  idOf(b: any): number | null {
    if (typeof b === "number") return b;
    if (typeof b === "string") return (b === "enemy") ? 1 : 0;
    if (b === null || typeof b !== "object") return null;
    if (truthy(b.id)) return b.id;
    if (b.side === "enemy") return 1;
    if (b.side === "player") return 0;
    return null;
  },

  // Lua: state.lua:113
  battler(st: any, id: number | null | undefined): any {
    if (!truthy(st) || id == null) return null;
    if (truthy(st.battlers)) return st.battlers[id];
    if (id === 0) return st.player;
    if (id === 1) return st.enemy;
    return null;
  },

  // Lua: state.lua:121
  occupant(st: any, b: any): any {
    if (b == null || !truthy(st)) return b;
    if (typeof b === "string") return st[b];
    const id = State.idOf(b);
    if (id == null) return b;
    return State.battler(st, id) ?? b;
  },

  // Lua: state.lua:129
  isAbsent(st: any, id: number): boolean {
    return (truthy(st) && truthy(st.absent) && truthy(st.absent[id])) ? true : false;
  },

  // Lua: state.lua:133
  isPresent(st: any, id: number): boolean {
    return State.battler(st, id) != null && !State.isAbsent(st, id);
  },

  // Lua: state.lua:137
  isAlive(st: any, id: number): boolean {
    return State.isPresent(st, id) && !State.isFainted(State.battler(st, id));
  },

  // Lua: state.lua:141
  partner(st: any, b: any): any {
    const id = State.idOf(b);
    if (id == null || !(truthy(st) && truthy(st.double))) return null;
    const p = State.PARTNER(id);
    if (!State.isPresent(st, p)) return null;
    return State.battler(st, p);
  },

  // Lua: state.lua:149
  opposite(st: any, b: any): any {
    const id = State.idOf(b);
    if (id == null) return null;
    return State.battler(st, State.OPPOSITE(id));
  },

  // Lua: state.lua:159
  battlerOrder(st: any): LuaTable {
    // pokefirered/src/battle_controllers.c:229
    if (truthy(st) && truthy(st.multi) && truthy(st.linkOrder)) return st.linkOrder;
    if (truthy(st) && truthy(st.link) && st.linkMaster === false) return LINK_FOLLOWER_ORDER;
    return LOCAL_ORDER;
  },

  // Lua: state.lua:166
  presentIds(st: any): LuaTable {
    const out: LuaTable = [null];
    for (const [, id] of ipairs<number>(State.battlerOrder(st))) {
      if (State.isPresent(st, id)) out[len(out) + 1] = id;
    }
    return out;
  },

  // Lua: state.lua:174
  present(st: any): LuaTable {
    const out: LuaTable = [null];
    for (const [, id] of ipairs<number>(State.battlerOrder(st))) {
      if (State.isPresent(st, id)) out[len(out) + 1] = State.battler(st, id);
    }
    return out;
  },

  // Lua: state.lua:182
  foes(st: any, b: any): LuaTable {
    const id = State.idOf(b);
    const out: LuaTable = [null];
    if (id == null) return out;
    for (let i = 0; i <= 3; i++) {
      if (mod(i, 2) !== mod(id, 2) && State.isPresent(st, i)) out[len(out) + 1] = State.battler(st, i);
    }
    return out;
  },

  // Lua: state.lua:192
  allies(st: any, b: any): LuaTable {
    const id = State.idOf(b);
    const out: LuaTable = [null];
    if (id == null) return out;
    for (let i = 0; i <= 3; i++) {
      if (mod(i, 2) === mod(id, 2) && State.isPresent(st, i)) out[len(out) + 1] = State.battler(st, i);
    }
    return out;
  },

  // Lua: state.lua:203 -- pokefirered/src/pokemon.c:2651
  countPresentOnSide(st: any, side: string): number {
    let n = 0;
    for (const [, id] of ipairs<number>(State.positionsOnSide(side))) {
      if (State.isPresent(st, id)) n = n + 1;
    }
    return n;
  },

  // Lua: state.lua:212 -- pokefirered/src/battle_main.c:3400
  speedOrder(st: any, adapter?: any, opts?: any): LuaTable {
    opts = opts ?? {};
    // package.loaded engine: always loaded here
    const ids = State.presentIds(st);
    const spe: Record<number, number> = {};
    for (const [, id] of ipairs<number>(ids)) {
      const b = State.battler(st, id);
      if (truthy(Engine) && truthy(Engine.speedOf)) {
        spe[id] = Engine.speedOf(b, st, adapter);
      } else {
        const m = b.mon;
        spe[id] = tonumber(truthy(m) ? (truthy(m.speed) ? m.speed : m.spe) : m) ?? 50;
      }
    }
    const coin = (): number => {
      if (truthy(adapter) && truthy(adapter.roll)) return adapter.roll(0, 1);
      return Guard.fallback("state.coin", 0, 1);
    };
    const n = len(ids);
    for (let i = 1; i <= n - 1; i++) {
      for (let j = i + 1; j <= n; j++) {
        const a = ids[i], b = ids[j];
        const pa = (truthy(opts.priority) ? opts.priority[a] : null) ?? 0;
        const pb = (truthy(opts.priority) ? opts.priority[b] : null) ?? 0;
        let swap: boolean;
        if (pa !== pb) {
          swap = pa < pb;
        } else if (spe[a] === spe[b]) {
          swap = coin() === 1;
        } else {
          swap = spe[a]! < spe[b]!;
        }
        if (swap) { ids[i] = b; ids[j] = a; }
      }
    }
    return ids;
  },

  // Lua: state.lua:277 -- pokefirered/src/battle_main.c:1291
  slotOwner(st: any, side: string, slot: number): any {
    const owners = truthy(st) && truthy(st.partyOwner) ? st.partyOwner[side] : null;
    return (truthy(owners) ? owners[slot] : null) ?? null;
  },

  // Lua: state.lua:282
  ownsSlot(st: any, id: number | null | undefined, slot: unknown): boolean {
    // pokeemerald/src/battle_util.c:2331
    if (truthy(st) && truthy(st.foeHalf) && id != null && mod(id, 2) === 1) {
      return (id === 1) === ((tonumber(slot) ?? 0) <= st.foeHalf);
    }
    // pokeemerald/src/battle_util.c:2274
    if (truthy(st) && truthy(st.playerHalf) && id != null && mod(id, 2) === 0) {
      return (id === 0) === ((tonumber(slot) ?? 0) <= st.playerHalf);
    }
    if (!(truthy(st) && truthy(st.multi) && truthy(st.partyOwner))) return true;
    return State.slotOwner(st, State.sideOf(id as number), slot as number) === id;
  },

  // Lua: state.lua:307
  new(opts?: any): BattleState {
    opts = opts ?? {};
    const playerParty = truthy(opts.playerParty) ? opts.playerParty : [null];
    const owners = truthy(opts.multi) && truthy(opts.partyOwner) ? opts.partyOwner : null;
    const foeMon = opts.foeMon;
    const foeParty = truthy(opts.foeParty) ? opts.foeParty : seq(foeMon);
    if (truthy(owners)) {
      opts.playerIndex = opts.playerIndex || first_owned(playerParty, owners.player, 0);
      opts.partnerIndex = opts.partnerIndex || first_owned(playerParty, owners.player, 2);
      opts.foeIndex = opts.foeIndex || first_owned(foeParty, owners.enemy, 1);
      opts.foePartnerIndex = opts.foePartnerIndex || first_owned(foeParty, owners.enemy, 3);
    }
    const foeHalf = truthy(opts.double) ? (tonumber(opts.foeHalf) ?? null) : null;
    if (foeHalf != null) {
      // pokeemerald/src/battle_controllers.c:650
      const owners2: LuaTable = { enemy: [null] };
      for (let i = 1; i <= len(foeParty); i++) owners2.enemy[i] = (i <= foeHalf) ? 1 : 3;
      opts.foeIndex = opts.foeIndex || first_owned(foeParty, owners2.enemy, 1, 0);
      opts.foePartnerIndex = opts.foePartnerIndex || first_owned(foeParty, owners2.enemy, 3, 0) || false;
    }
    const playerHalf = truthy(opts.double) ? (tonumber(opts.playerHalf) ?? null) : null;
    if (playerHalf != null) {
      // pokeemerald/src/battle_util.c:2281
      const own: LuaTable = [null];
      for (let i = 1; i <= len(playerParty); i++) own[i] = (i <= playerHalf) ? 0 : 2;
      opts.playerIndex = first_owned(playerParty, own, 0, 0) || opts.playerIndex;
      opts.partnerIndex = opts.partnerIndex || first_owned(playerParty, own, 2, 0) || false;
    }
    const pi = opts.playerIndex || first_usable(playerParty) || 1;
    const ei = opts.foeIndex || first_usable(foeParty) || 1;
    const eMon = foeMon || (truthy(foeParty) && foeParty[ei]) || (truthy(foeParty) && foeParty[1]);
    const st: BattleState = {
      kind: truthy(opts.wild) ? "wild" : "trainer",
      wild: truthy(opts.wild) ? true : false,
      playerParty,
      foeParty,
      player: null,
      enemy: null,
      playerSide: { hazards: {}, id: "player" },
      enemySide: { hazards: {}, id: "enemy" },
      weather: opts.weather,
      weatherTurns: 0,
      terrain: opts.terrain,
      turn: 0,
      over: false,
      result: null,
      rng: truthy(opts.rng) ? opts.rng : Guard.source("state.rng", Rng.compat),
      fleeAttempts: 0,
      log: [null],
    };
    st.double = truthy(opts.double) ? true : false;
    st.foeHalf = foeHalf;
    st.playerHalf = playerHalf;
    st.multi = (st.double && truthy(owners)) ? true : false;
    st.partyOwner = st.multi ? owners : null;
    st.battlersCount = st.double ? 4 : 2;
    st.battlers = battler_slots(st);
    st.absent = {};
    st.chosen = {};
    st.turnOrder = [null];
    st.monToSwitchInto = {};
    st.moveTarget = {};
    const pMon = playerParty[pi];
    st.player = State.makeBattler(pMon, "player", { partyIndex: pi, id: 0 });
    st.enemy = State.makeBattler(eMon, "enemy", { partyIndex: ei, id: 1 });
    if (!st.double) {
      State.trackParticipant(st, st.enemy, pi);
      return st;
    }
    // pokefirered/src/battle_controllers.c:290
    const p2 = opts.partnerIndex || (!truthy(owners) && !truthy(playerHalf) && first_usable(playerParty, pi)) || null;
    if (truthy(p2) && truthy(playerParty[p2])) {
      st.battlers[2] = State.makeBattler(playerParty[p2], "player", { partyIndex: p2, id: 2 });
    } else {
      st.absent[2] = true;
    }
    let e2 = opts.foePartnerIndex;
    if (e2 == null) e2 = (!truthy(owners) && first_usable(st.foeParty, st.enemy.partyIndex)) || null;
    if (truthy(e2) && truthy(st.foeParty[e2])) {
      st.battlers[3] = State.makeBattler(st.foeParty[e2], "enemy", { partyIndex: e2, id: 3 });
    } else {
      st.absent[3] = true;
    }
    State.resetSentPokes(st);
    return st;
  },

  // Lua: state.lua:396 -- pokefirered/src/battle_util.c:239
  resetSentPokes(st: any): void {
    const sent: LuaTable = [null];
    for (const id of [0, 2]) {
      const b = State.battler(st, id);
      if (truthy(b) && truthy(b.partyIndex) && !State.isAbsent(st, id)) sent[len(sent) + 1] = b.partyIndex;
    }
    for (const id of [1, 3]) {
      const foe = State.battler(st, id);
      if (truthy(foe)) {
        foe.participants = {};
        for (const [, pi] of ipairs<number>(sent)) foe.participants[pi] = true;
      }
    }
    if (truthy(st.enemy) && !truthy(st.enemy.participants)) {
      st.enemy.participants = {};
      if (truthy(st.player) && truthy(st.player.partyIndex) && !State.isAbsent(st, 0)) {
        st.enemy.participants[st.player.partyIndex] = true;
      }
    }
  },

  // Lua: state.lua:418 -- pokefirered/src/battle_util.c:254
  opponentSwitchInResetSentPokes(st: any, foeBattler: any): void {
    if (!truthy(foeBattler)) return;
    foeBattler.participants = {};
    for (const id of [0, 2]) {
      const b = State.battler(st, id);
      if (truthy(b) && !State.isAbsent(st, id) && truthy(b.partyIndex)) {
        foeBattler.participants[b.partyIndex] = true;
      }
    }
    if (!truthy(st.double) && truthy(st.player) && !State.isAbsent(st, 0) && truthy(st.player.partyIndex)) {
      foeBattler.participants[st.player.partyIndex] = true;
    }
  },

  // Lua: state.lua:433 -- pokefirered/src/battle_util.c:273
  updateSentPokes(st: any, battler: any): void {
    if (!truthy(battler)) return;
    if (battler.side === "enemy") {
      return State.opponentSwitchInResetSentPokes(st, battler);
    }
    for (const id of [1, 3]) {
      const foe = State.battler(st, id);
      if (truthy(foe)) State.trackParticipant(st, foe, battler.partyIndex);
    }
    if (!truthy(st.double) && truthy(st.enemy)) {
      State.trackParticipant(st, st.enemy, battler.partyIndex);
    }
  },

  // Lua: state.lua:447
  displayName(battler: any): string {
    if (!truthy(battler)) return "POK\xC3\xA9MON";
    const mon = battler.mon;
    if (truthy(mon) && truthy(mon.nickname) && mon.nickname !== "") return mon.nickname;
    try {
      if (!truthy(Pokemon._names)) Pokemon.install(null);
    } catch {
      // Lua: pcall swallows
    }
    return Pokemon.name(battler.species);
  },

  // Lua: state.lua:458 -- src/battle_message.c:1807
  text(st: any, id: string, fill?: any): any {
    fill = Adapter.fill(st, fill);
    return BattleText.get(id, fill);
  },

  // Lua: state.lua:463
  prefixedName(st: any, battler: any, name?: string | null): string {
    name = name ?? State.displayName(battler);
    if (truthy(battler) && battler.side === "player") return name;
    const prefix = (st != null && !truthy(st.wild)) ? "sText_FoePkmnPrefix" : "sText_WildPkmnPrefix";
    let ok: boolean, pre: any;
    try {
      pre = RomText.plain(prefix);
      ok = true;
    } catch {
      ok = false;
    }
    const p = (ok && truthy(pre)) ? pre : ((st != null && !truthy(st.wild)) ? "Foe " : "Wild ");
    return p + name;
  },

  // Lua: state.lua:472
  isFainted(battler: any): boolean {
    if (!truthy(battler)) return true;
    if (typeof battler === "string") return false;
    return truthy(battler.fainted) || (tonumber(truthy(battler.mon) ? battler.mon.hp : null) ?? 0) <= 0;
  },

  // Lua: state.lua:478
  applyHpLoss(battler: any, amount: unknown): number {
    if (!truthy(battler) || !truthy(battler.mon)) return 0;
    let amt = Math.floor(tonumber(amount) ?? 0);
    if (amt < 0) amt = 0;
    const hp = tonumber(battler.mon.hp) ?? 0;
    const lost = Math.min(hp, amt);
    battler.mon.hp = hp - lost;
    if (battler.mon.hp <= 0) {
      battler.mon.hp = 0;
      battler.fainted = true;
    }
    return lost;
  },

  // Lua: state.lua:492
  heal(battler: any, amount: unknown): number {
    if (!truthy(battler) || !truthy(battler.mon)) return 0;
    const amt = Math.floor(tonumber(amount) ?? 0);
    const hp = tonumber(battler.mon.hp) ?? 0;
    const maxHp = tonumber(battler.mon.maxHp) ?? hp;
    const nextHp = Math.min(maxHp, hp + amt);
    const gained = nextHp - hp;
    battler.mon.hp = nextHp;
    if (nextHp > 0) battler.fainted = false;
    return gained;
  },

  // Lua: state.lua:504
  ensureBattleMoves(battler: any): any {
    if (!truthy(battler) || !truthy(battler.mon)) return null;
    if (truthy(battler._partyMon)) return battler.mon;
    const base = battler.mon;
    const moves: LuaTable = [null], pp: LuaTable = [null];
    for (let i = 1; i <= 4; i++) {
      moves[i] = (truthy(base.moves) ? base.moves[i] : null) ?? null;
      pp[i] = (truthy(base.pp) ? base.pp[i] : null) ?? null;
    }
    const raw: Record<string | symbol, any> = { moves, pp };
    const proxy = new Proxy(raw, {
      get(t, k) { return t[k] != null ? t[k] : base[k]; },
      set(t, k, v) {
        if (t[k] != null) t[k] = v; // rawset of an existing key
        else base[k] = v; // __newindex = base
        return true;
      },
      has(t, k) { return t[k] != null || base[k] != null; },
    });
    battler._partyMon = base;
    battler.mon = proxy;
    battler.permanentSlots = battler.permanentSlots ?? seq(true, true, true, true);
    return proxy;
  },

  // Lua: state.lua:523
  partyMon(battler: any): any {
    if (!truthy(battler)) return null;
    return truthy(battler._partyMon) ? battler._partyMon : battler.mon;
  },

  // Lua: state.lua:541
  markKnockedOff(st: any, b: any): void {
    if (!truthy(st)) return;
    const [side, flag] = knocked_off_key(b);
    if (!truthy(side)) return;
    st.knockedOff = st.knockedOff ?? { player: 0, enemy: 0 };
    st.knockedOff[side as string] = (st.knockedOff[side as string] ?? 0) | (flag as number);
  },

  // Lua: state.lua:549
  isKnockedOff(st: any, b: any): boolean {
    if (!truthy(st)) return false;
    const [side, flag] = knocked_off_key(b);
    if (!truthy(side)) return false;
    return (((truthy(st.knockedOff) ? st.knockedOff[side as string] : null) ?? 0) & (flag as number)) !== 0;
  },

  // Lua: state.lua:556
  wipeVolatilesAndStages(battler: any, opts?: any): void {
    opts = opts ?? {};
    if (!truthy(battler)) return;
    const bp = truthy(opts.batonPass);
    if (!bp) {
      battler.stages = zeroStages();
    }
    // Volatile status conditions
    battler.volatiles = (bp && truthy(battler.volatiles)) ? battler.volatiles : {};
    battler.confusion = bp ? battler.confusion : null;
    battler.seeded = null;
    battler.trapped = null;
    battler.attracted = null;
    battler.substitute = bp ? battler.substitute : null;
    battler.focusEnergy = bp ? battler.focusEnergy : null;
    battler.toxicCounter = null;
    battler.disabled = null;
    battler.encore = null;
    battler.taunt = null;
    battler.bide = null;
    battler.rage = null;
    battler.endure = null;
    battler.protect = null;
    battler.destinyBond = null;
    battler.perishSong = bp ? battler.perishSong : null;
  },

  // Lua: state.lua:585
  syncBattlerToParty(battler: any, party: any): void {
    if (!truthy(battler) || !truthy(party)) return;
    // pokefirered/src/battle_main.c:2565
    if (truthy(battler.zeroed)) return;
    const idx = truthy(battler.partyIndex) ? battler.partyIndex : 1;
    const mon = party[idx];
    if (!truthy(mon)) return;
    const bMon = battler.mon;
    if (!truthy(bMon)) return;
    mon.hp = tonumber(bMon.hp) ?? 0;
    mon.maxHp = tonumber(bMon.maxHp) ?? mon.maxHp;
    let status = truthy(battler.status) ? battler.status : bMon.status;
    if (status === 0) status = null;
    mon.status = status;
    mon.sleep = bMon.sleep;
    mon.level = truthy(bMon.level) ? bMon.level : mon.level;
    mon.exp = truthy(bMon.exp) ? bMon.exp : mon.exp;
    if (truthy(battler._partyMon)) {
      // pokefirered/include/battle.h:28
      const perm = battler.permanentSlots ?? {};
      mon.pp = mon.pp ?? [null];
      mon.moves = mon.moves ?? [null];
      for (let i = 1; i <= 4; i++) {
        if (truthy(perm[i]) && !truthy(battler.transformed)) {
          mon.pp[i] = (truthy(bMon.pp) ? bMon.pp[i] : null) ?? mon.pp[i];
          if (truthy(battler.sketched) && truthy(battler.sketched[i])) {
            mon.moves[i] = bMon.moves[i];
          }
        }
      }
      return;
    }
    if (truthy(bMon.pp)) mon.pp = bMon.pp;
    if (truthy(bMon.moves)) mon.moves = bMon.moves;
  },

  // Lua: state.lua:621
  trackParticipant(st: any, foeBattler: any, partyIndex?: number | null): void {
    if (!truthy(st) || !truthy(foeBattler)) return;
    foeBattler.participants = foeBattler.participants ?? {};
    partyIndex = partyIndex || (truthy(st.player) ? st.player.partyIndex : null) || 1;
    foeBattler.participants[partyIndex as number] = true;
  },
};

export default State;
