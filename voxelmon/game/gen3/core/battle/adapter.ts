// Port of gen1recomp src/core/game3/battle/adapter.lua (GPLv3 + additional terms; see LICENSE.md).
// Owned adapter for game3 battle (api-shaped, no host).
//
// Port notes:
// - Adapter.new builds one object per battle with its methods defined on it,
//   as Brian's closure table does (`function a:foo()` -> method shorthand with
//   `this`). BattleAdapter types it; other modules may add fields
//   (`_syncEffect`, ...), so it keeps an index signature.
// - Lua multiple returns are 0-based tuples: a:canApplyStatus returns
//   [false, reason] or [true] on every path (callers that test it as a
//   boolean take [0]).
// - `pcall(self:rng(), lo, hi)` is try/catch around calling the rng function;
//   `math.random` (the unarmed link_guard source) is platform/rng.ts random().
// - package.loaded["...engine"] and the lazy requires (engine, battle_text,
//   pokemon, link.battle, residual_handlers, link_guard) are static imports
//   used exactly as Brian guards them.
// - Union room (`st.unionRoom`) keeps Brian's guard; link/battle.ts is a
//   deferred stub, so that branch throws until the link cluster ports it.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tonumber, tostring, truthy, mod } from "../../../../import/gen3/lua.ts";
import { gsub, match } from "../../platform/lpattern.ts";
import { ipairs, len, pairs, seq, type LuaTable } from "../../platform/lt.ts";
import { random } from "../../platform/rng.ts";
import State from "./state.ts";
import Rules from "./rules.ts";
import ModRuntime from "../../shared/mods/Runtime.ts";
import LinkGuard from "./link_guard.ts";
import Engine from "./engine.ts";
import BattleText from "./battle_text.ts";
import Pokemon from "../pokemon.ts";
import LinkBattle from "../link/battle.ts";
import ResidualHandlers from "./residual_handlers.ts";

type Tbl = LuaTable;

/** An adapter event (`{ kind = ..., ... }`). */
export type AdapterEvent = Record<string, any>;

/** The object Adapter.new returns. */
export interface BattleAdapter {
  _st: any;
  _say: (text: string) => void;
  _events: Tbl;
  [k: string]: any;
  pushEvent(ev: AdapterEvent): AdapterEvent;
  events(): Tbl;
  eventMark(): number;
  eventsSince(mark?: number | null): Tbl;
  playAnim(kind: string, name: string, attacker?: any, target?: any, arg?: any): AdapterEvent;
  statusAnim(battler: any, status?: any): void;
  mon(battler: any): any;
  hp(battler: any): number;
  maxHp(battler: any): number;
  status(battler: any): string | null;
  hasStatus(battler: any, ...statuses: any[]): boolean;
  hasType(battler: any, typeId: any): boolean;
  uproarActive(): any;
  canApplyStatus(battler: any, status: any, source?: any, opts?: any): [boolean, string?];
  rollSleepTurns(): number;
  applyStatus(battler: any, status: any, source?: any, opts?: any): boolean;
  clearStatus(battler: any): void;
  stages(battler: any): any;
  changeStages(battler: any, changes: any): Record<string, { delta: number; limited: boolean }>;
  recordHp(battler: any, from: any, to: any, kind?: string): AdapterEvent | undefined;
  applyHpLoss(battler: any, amount: any, opts?: any): number;
  heal(battler: any, amount: any): number;
  setHp(battler: any, value: any): void;
  isFainted(battler: any): boolean;
  emitFaint(battler: any): void;
  displayName(battler: any): string;
  say(text: any, id?: any): void;
  sayText(id: any, fill?: any): string;
  sayFail(): void;
  rng(): (...a: any[]) => any;
  roll(lo: number, hi: number): number;
  activeBattlers(): Tbl;
  foeOf(battler: any): any;
  foesOf(battler: any): Tbl;
  partnerOf(battler: any): any;
  ownSide(battler: any): any;
  foeSide(battler: any): any;
  findHazard(side: any, id: any): any;
  isBattleDecided(): boolean;
  hasSubstitute(battler: any): boolean;
  abilityOf(battler: any): string | null;
  lastMoveOf(battler: any): any;
  partyMons(battler: any): Tbl;
  applyConfusion(battler: any, turns?: any, source?: any): boolean;
  useMove(user: any, moveId: any, target: any, opts?: any): any;
  setWeather(kind: any, turns?: any): void;
  tickWeather(): void;
}

export interface AdapterModule {
  normStatus(s: unknown): string | null;
  ABILITY_BY_ID: Record<number, string>;
  idOf(battler: any): any;
  fill(st: any, extra?: any): Record<string, any>;
  "new"(battleState: any, sayFn?: ((text: string) => void) | null): BattleAdapter;
}

export const Adapter = {} as AdapterModule;

// Lua: adapter.lua:9
function norm_status(s: unknown): string | null {
  if (!truthy(s) || s === 0) return null;
  const u = tostring(s).toUpperCase();
  if (u === "BURN") return "BRN";
  if (u === "POISON") return "PSN";
  if (u === "TOXIC") return "TOX";
  if (u === "SLEEP" || u === "SLP") return "SLP";
  if (u === "PARALYSIS" || u === "PAR") return "PAR";
  if (u === "FREEZE" || u === "FRZ") return "FRZ";
  if (u === "0" || u === "" || u === "NONE") return null;
  return u;
}
Adapter.normStatus = norm_status;

// pokefirered/include/constants/abilities.h:4
const ABILITY_BY_ID: Record<number, string> = {
  1: "STENCH", 2: "DRIZZLE", 3: "SPEED_BOOST", 4: "BATTLE_ARMOR", 5: "STURDY",
  6: "DAMP", 7: "LIMBER", 8: "SAND_VEIL", 9: "STATIC", 10: "VOLT_ABSORB",
  11: "WATER_ABSORB", 12: "OBLIVIOUS", 13: "CLOUD_NINE", 14: "COMPOUND_EYES",
  15: "INSOMNIA", 16: "COLOR_CHANGE", 17: "IMMUNITY", 18: "FLASH_FIRE",
  19: "SHIELD_DUST", 20: "OWN_TEMPO", 21: "SUCTION_CUPS", 22: "INTIMIDATE",
  23: "SHADOW_TAG", 24: "ROUGH_SKIN", 25: "WONDER_GUARD", 26: "LEVITATE",
  27: "EFFECT_SPORE", 28: "SYNCHRONIZE", 29: "CLEAR_BODY", 30: "NATURAL_CURE",
  31: "LIGHTNING_ROD", 32: "SERENE_GRACE", 33: "SWIFT_SWIM", 34: "CHLOROPHYLL",
  35: "ILLUMINATE", 36: "TRACE", 37: "HUGE_POWER", 38: "POISON_POINT",
  39: "INNER_FOCUS", 40: "MAGMA_ARMOR", 41: "WATER_VEIL", 42: "MAGNET_PULL",
  43: "SOUNDPROOF", 44: "RAIN_DISH", 45: "SAND_STREAM", 46: "PRESSURE",
  47: "THICK_FAT", 48: "EARLY_BIRD", 49: "FLAME_BODY", 50: "RUN_AWAY",
  51: "KEEN_EYE", 52: "HYPER_CUTTER", 53: "PICKUP", 54: "TRUANT", 55: "HUSTLE",
  56: "CUTE_CHARM", 57: "PLUS", 58: "MINUS", 59: "FORECAST", 60: "STICKY_HOLD",
  61: "SHED_SKIN", 62: "GUTS", 63: "MARVEL_SCALE", 64: "LIQUID_OOZE",
  65: "OVERGROW", 66: "BLAZE", 67: "TORRENT", 68: "SWARM", 69: "ROCK_HEAD",
  70: "DROUGHT", 71: "ARENA_TRAP", 72: "VITAL_SPIRIT", 73: "WHITE_SMOKE",
  74: "PURE_POWER", 75: "SHELL_ARMOR", 76: "CACOPHONY", 77: "AIR_LOCK",
};
Adapter.ABILITY_BY_ID = ABILITY_BY_ID;

// Lua: adapter.lua:46
function side_of(battler: any): any {
  if (battler !== null && typeof battler === "object") return battler.side;
  if (typeof battler === "string") return battler;
  if (typeof battler === "number") return State.sideOf(battler);
  return null;
}

// Lua: adapter.lua:53
function id_of(battler: any): any {
  if (battler == null) return null;
  return State.idOf(battler);
}
Adapter.idOf = id_of;

/** Lua `a or b` (b already evaluated). */
function lor<A, B>(a: A, b: B): A | B {
  return truthy(a) ? a : b;
}

/** Lua `(c ~= nil and c ~= "") and c or d`. */
function nonEmptyOr(c: any, d: any): any {
  return (c != null && c !== "" && truthy(c)) ? c : d;
}

// Lua: adapter.lua:60
// src/battle_message.c:1523
Adapter.fill = function (st: any, extra?: any): Record<string, any> {
  const f: Record<string, any> = {};
  if (truthy(st)) {
    f.trainer = !truthy(st.wild);
    f.link = lor(st.link, null);
    f.double = lor(st.double, null);
    f.unionRoom = lor(st.unionRoom, null);
    f.linkOpponent = (truthy(st.link) && !truthy(st.unionRoom) && !truthy(st.towerLinkMulti)) ? true : null;
    f.towerLinkMulti = lor(st.towerLinkMulti, null);
    f.ghost = lor(st.ghostBattle, null);
    f.ghostUnveiled = lor(st.ghostUnveiled, null);
    f.legendary = lor(st.legendary, null);
    f.oldMan = lor(st.oldManTutorial, null);
    f.playerName = st.playerName;
    f.linkPlayerName = st.playerName;
    f.linkOpponent1Name = st.peerName;
    f.trainer1Class = nonEmptyOr(st.trainerClassName, st.trainerClass);
    f.trainer1Name = st.trainerName;
    if (truthy(st.trainerB)) {
      // pokeemerald/src/battle_message.c:2673
      f.twoOpponents = true;
      f.trainer2Class = nonEmptyOr(st.trainerB.className, st.trainerB.class);
      f.trainer2Name = st.trainerB.name;
      f.trainer2LoseText = st.trainerB.defeatText;
    }
    // pokeemerald/src/battle_message.c:2029
    f.wally = (truthy(st.kinds) && st.kinds.tutorial === "wally") ? true : null;
    if (truthy(st.partner)) {
      // pokeemerald/src/battle_message.c:2039
      f.inGamePartner = true;
      f.partnerClass = nonEmptyOr(st.partner.className, st.partner.class);
      f.partnerName = st.partner.name;
    }
    if (truthy(st.unionRoom)) {
      // src/battle_message.c:2039
      f.trainer1Class = LinkBattle.unionRoomTrainerClass();
      // src/battle_message.c:2058
      f.trainer1Name = st.peerName;
    }
    if (truthy(st.multi) && truthy(st.linkNames)) {
      // pokefirered/src/battle_message.c:1910
      const own: number = tonumber(st.linkOwn) ?? 0;
      const names = st.linkNames;
      const seat = truthy(st.linkSeatOf) ? st.linkSeatOf[own] : st.linkSeatOf;
      let opp: any = null;
      if (truthy(seat) && truthy(st.linkLocalOf)) opp = st.linkLocalOf[State.OPPOSITE(seat)];
      if (!truthy(opp)) opp = State.OPPOSITE(own);
      f.multi = true;
      f.linkPlayerName = lor(names[own], st.playerName);
      f.linkPartnerName = names[mod(own + 2, 4)];
      f.linkOpponent1Name = names[opp];
      f.linkOpponent2Name = names[mod(opp + 2, 4)];
      f.linkPlayerMon1 = State.battler(st, own);
      f.linkPlayerMon2 = State.battler(st, mod(own + 2, 4));
      f.linkOpponentMon1 = State.battler(st, opp);
      f.linkOpponentMon2 = State.battler(st, mod(opp + 2, 4));
    }
  }
  for (const [k, v] of pairs(lor(extra, {}))) f[k] = v;
  return f;
};

// Lua: adapter.lua:123
Adapter.new = function (battleState: any, sayFn?: ((text: string) => void) | null): BattleAdapter {
  const a: BattleAdapter = {
    _st: battleState,
    _say: truthy(sayFn) ? sayFn as (text: string) => void : function (): void { /* no-op */ },
    _events: seq(),

    // Lua: adapter.lua:130
    pushEvent(ev: AdapterEvent): AdapterEvent {
      this._events[len(this._events) + 1] = ev;
      return ev;
    },
    // Lua: adapter.lua:134
    events(): Tbl { return this._events; },
    // Lua: adapter.lua:135
    eventMark(): number { return len(this._events); },
    // Lua: adapter.lua:136
    eventsSince(mark?: number | null): Tbl {
      const out: Tbl = seq();
      const n = len(this._events);
      for (let i = (lor(mark, 0) as number) + 1; i <= n; i++) out[len(out) + 1] = this._events[i];
      return out;
    },

    // Lua: adapter.lua:142
    playAnim(kind: string, name: string, attacker?: any, target?: any, arg?: any): AdapterEvent {
      return this.pushEvent({
        kind: "anim",
        anim: kind,
        name: name,
        attacker: side_of(attacker),
        target: side_of(target),
        attackerId: id_of(attacker),
        targetId: id_of(target),
        arg: arg,
      });
    },

    // Lua: adapter.lua:155
    statusAnim(battler: any, status?: any): void {
      const names: Record<string, string> = {
        PSN: "POISON", TOX: "POISON", BRN: "BURN", SLP: "SLEEP",
        PAR: "PARALYSIS", FRZ: "FREEZE",
      };
      const n = names[lor(norm_status(lor(status, this.status(battler))), "") as string];
      if (truthy(n)) this.playAnim("status", n, battler, battler);
    },

    // Lua: adapter.lua:164
    mon(battler: any): any { return truthy(battler) ? battler.mon : battler; },
    // Lua: adapter.lua:165
    hp(battler: any): number {
      if (!(truthy(battler) && truthy(battler.mon))) return 0;
      return tonumber(battler.mon.hp) ?? 0;
    },
    // Lua: adapter.lua:166
    maxHp(battler: any): number {
      if (!(truthy(battler) && truthy(battler.mon))) return 0;
      return tonumber(battler.mon.maxHp) ?? 0;
    },
    // Lua: adapter.lua:167
    status(battler: any): string | null {
      if (!truthy(battler)) return null;
      return norm_status(lor(battler.status, truthy(battler.mon) ? battler.mon.status : battler.mon));
    },
    // Lua: adapter.lua:170
    hasStatus(battler: any, ...statuses: any[]): boolean {
      const cur = this.status(battler);
      if (!truthy(cur)) return false;
      for (let i = 0; i < statuses.length; i++) {
        if (cur === norm_status(statuses[i])) return true;
      }
      return false;
    },

    // Lua: adapter.lua:179
    hasType(battler: any, typeId: any): boolean {
      if (!truthy(battler)) return false;
      return battler.type1 === typeId || battler.type2 === typeId;
    },

    // Lua: adapter.lua:184
    uproarActive(): any {
      for (const [, b] of ipairs(this.activeBattlers())) {
        if (lor(b.expUproarTurns, 0) > 0 && !this.isFainted(b)) return b;
      }
      return null;
    },

    // Lua: adapter.lua:192
    // pokefirered/src/battle_script_commands.c:2150
    canApplyStatus(battler: any, status: any, source?: any, opts?: any): [boolean, string?] {
      opts = lor(opts, {});
      if (!truthy(battler)) return [false, "none"];
      status = norm_status(status);
      if (truthy(this.status(battler))) return [false, "status"];
      const side = this.ownSide(battler);
      if (!truthy(opts.ignoreSafeguard) && source !== battler && truthy(side) && lor(side.expSafeguardTurns, 0) > 0) {
        return [false, "safeguard"];
      }
      const ab = this.abilityOf(battler);
      if (status === "PSN" || status === "TOX") {
        if (this.hasType(battler, 3) || this.hasType(battler, 8)) return [false, "type"];
        if (ab === "IMMUNITY") return [false, "ability"];
      } else if (status === "BRN") {
        if (this.hasType(battler, 10)) return [false, "type"];
        if (ab === "WATER_VEIL") return [false, "ability"];
      } else if (status === "FRZ") {
        if (this.hasType(battler, 15)) return [false, "type"];
        if (Rules.weather.effective(this._st, this) === "SUN") return [false, "sun"];
        if (ab === "MAGMA_ARMOR") return [false, "ability"];
      } else if (status === "PAR") {
        if (ab === "LIMBER") return [false, "ability"];
      } else if (status === "SLP") {
        if (ab !== "SOUNDPROOF" && truthy(this.uproarActive())) return [false, "uproar"];
        if (ab === "INSOMNIA" || ab === "VITAL_SPIRIT") return [false, "ability"];
      }
      return [true];
    },

    // Lua: adapter.lua:221
    rollSleepTurns(): number {
      const f = this.rng();
      let ok = false;
      let v: any;
      try { v = f(0, 3); ok = true; } catch (e) { ok = false; v = e; }
      if (!(ok && typeof v === "number")) {
        v = LinkGuard.fallback("adapter.sleep", 0, 3);
      }
      return mod(Math.floor(v), 4) + 2;
    },

    // Lua: adapter.lua:229
    applyStatus(battler: any, status: any, source?: any, opts?: any): boolean {
      opts = lor(opts, {});
      if (!truthy(battler)) return false;
      status = norm_status(status);
      if (!truthy(opts.force)) {
        const ok = this.canApplyStatus(battler, status, source, opts)[0];
        if (!ok) return false;
      } else if (truthy(this.status(battler))) {
        return false;
      }
      battler.status = status;
      if (truthy(battler.mon)) battler.mon.status = status;
      if (status === "TOX") battler.toxicCounter = 0;
      if (status === "SLP") {
        // pokefirered/src/battle_script_commands.c:2356
        battler.sleepTurns = tonumber(opts.turns) ?? this.rollSleepTurns();
        // package.loaded["src.core.game3.battle.engine"]
        if (truthy(Engine) && truthy(Engine.cancelMultiTurnMoves)) Engine.cancelMultiTurnMoves(battler);
      } else if (status === "FRZ") {
        if (truthy(Engine) && truthy(Engine.cancelMultiTurnMoves)) Engine.cancelMultiTurnMoves(battler);
      }
      // pokefirered/src/battle_script_commands.c:2110
      if (ModRuntime.wants("battle.status_inflicted")) {
        ModRuntime.emit("battle.status_inflicted", {
          battle: this._st, target: battler, status: status, source: source,
          side: battler.side, battlerId: id_of(battler),
          sourceId: (source !== null && typeof source === "object") ? id_of(source) : null,
        });
      }
      return true;
    },
    // Lua: adapter.lua:261
    clearStatus(battler: any): void {
      if (!truthy(battler)) return;
      battler.status = null;
      battler.toxicCounter = null;
      battler.sleepTurns = null;
      if (truthy(battler.mon)) battler.mon.status = null;
    },
    // Lua: adapter.lua:268
    stages(battler: any): any { return truthy(battler) ? battler.stages : battler; },
    // Lua: adapter.lua:269
    changeStages(battler: any, changes: any): Record<string, { delta: number; limited: boolean }> {
      const result: Record<string, { delta: number; limited: boolean }> = {};
      if (!truthy(battler) || !truthy(battler.stages) || changes === null || typeof changes !== "object") return result;
      for (const [k, d] of pairs(changes)) {
        const cur: number = lor(battler.stages[k], 0);
        let nxt = cur + (tonumber(d) ?? 0);
        if (nxt < -6) nxt = -6; else if (nxt > 6) nxt = 6;
        battler.stages[k] = nxt;
        result[k] = { delta: nxt - cur, limited: (nxt - cur) === 0 };
      }
      return result;
    },

    // Lua: adapter.lua:282
    recordHp(battler: any, from: any, to: any, kind?: string): AdapterEvent | undefined {
      if (!truthy(battler) || from === to) return undefined;
      return this.pushEvent({
        kind: lor(kind, "hp"),
        side: battler.side,
        battler: id_of(battler),
        from: from,
        to: to,
        maxHp: this.maxHp(battler),
      });
    },

    // Lua: adapter.lua:294
    applyHpLoss(battler: any, amount: any, opts?: any): number {
      if (!truthy(battler) || !truthy(battler.mon)) return 0;
      const before = this.hp(battler);
      const lost = State.applyHpLoss(battler, amount);
      this.recordHp(battler, before, this.hp(battler), (truthy(opts) && truthy(opts.hit)) ? "hit" : "hp");
      return lost;
    },
    // Lua: adapter.lua:301
    heal(battler: any, amount: any): number {
      if (!truthy(battler) || !truthy(battler.mon)) return 0;
      const before = this.hp(battler);
      const gained = State.heal(battler, amount);
      this.recordHp(battler, before, this.hp(battler), "hp");
      return gained;
    },
    // Lua: adapter.lua:308
    setHp(battler: any, value: any): void {
      if (!truthy(battler) || !truthy(battler.mon)) return;
      const before = this.hp(battler);
      const maxHp = this.maxHp(battler);
      let v = Math.floor(tonumber(value) ?? 0);
      if (v < 0) v = 0;
      if (maxHp > 0 && v > maxHp) v = maxHp;
      battler.mon.hp = v;
      if (v <= 0) battler.fainted = true; else battler.fainted = false;
      this.recordHp(battler, before, v, "hp");
    },
    // Lua: adapter.lua:319
    isFainted(battler: any): boolean { return State.isFainted(battler); },
    // Lua: adapter.lua:320
    emitFaint(battler: any): void {
      if (truthy(battler)) {
        battler.fainted = true;
        if (truthy(battler.mon)) battler.mon.hp = 0;
        // pokefirered/src/battle_script_commands.c:2878
        if (battler.side === "player" && truthy(battler.mon) && !truthy(battler._faintFriendship)) {
          battler._faintFriendship = true;
          let foeLevel = 0;
          for (const [, foe] of ipairs(State.foes(this._st, battler))) {
            const lv: number = tonumber(truthy(foe.mon) ? foe.mon.level : foe.mon) ?? 0;
            if (lv > foeLevel) foeLevel = lv;
          }
          Pokemon.adjustFriendshipOnBattleFaint(battler.mon, tonumber(battler.mon.level),
            foeLevel, { mapSec: Pokemon.currentMapSec(this._st.session) });
        }
        // pokefirered/src/battle_script_commands.c:2831
        if (ModRuntime.wants("battle.fainted") && battler._modFainted !== lor(battler.mon, true)) {
          battler._modFainted = lor(battler.mon, true);
          ModRuntime.emit("battle.fainted", {
            battle: this._st, battler: battler, side: this.ownSide(battler),
            sideName: battler.side, battlerId: id_of(battler),
          });
        }
      }
    },
    // Lua: adapter.lua:346
    displayName(battler: any): string { return State.displayName(battler); },
    // Lua: adapter.lua:347
    say(text: any, id?: any): void {
      const t = tostring(lor(text, ""));
      this.pushEvent({ kind: "msg", text: t, id: id });
      this._say(t);
    },
    // Lua: adapter.lua:352
    sayText(id: any, fill?: any): string {
      fill = Adapter.fill(this._st, fill);
      const text = BattleText.get(id, fill);
      this.pushEvent({ kind: "msg", text: text, id: BattleText.key(id, fill)[0] });
      this._say(text);
      return text;
    },
    // Lua: adapter.lua:361
    // src/battle_message.c:336
    sayFail(): void { this.sayText("STRINGID_BUTITFAILED"); },
    // Lua: adapter.lua:362
    rng(): (...a: any[]) => any {
      return lor(this._st.rng, null) ?? LinkGuard.source("adapter.rng", random);
    },
    // Lua: adapter.lua:365
    roll(lo: number, hi: number): number {
      const f = this.rng();
      let ok = false;
      let v: any;
      try { v = f(lo, hi); ok = true; } catch (e) { ok = false; v = e; }
      if (ok && typeof v === "number") return v;
      return LinkGuard.fallback("adapter.roll", lo, hi);
    },
    // Lua: adapter.lua:370
    activeBattlers(): Tbl { return State.present(this._st); },
    // Lua: adapter.lua:371
    foeOf(battler: any): any {
      if (!truthy(battler)) return null;
      const st = this._st;
      if (!truthy(st.double)) {
        if (battler.side === "player") return st.enemy;
        return st.player;
      }
      const opp = State.OPPOSITE(id_of(battler));
      if (State.isPresent(st, opp)) return State.battler(st, opp);
      const alt = State.PARTNER(opp);
      if (State.isPresent(st, alt)) return State.battler(st, alt);
      return State.battler(st, opp);
    },
    // Lua: adapter.lua:384
    foesOf(battler: any): Tbl { return State.foes(this._st, battler); },
    // Lua: adapter.lua:385
    partnerOf(battler: any): any { return State.partner(this._st, battler); },
    // Lua: adapter.lua:386
    ownSide(battler: any): any {
      if (!truthy(battler)) return null;
      if (battler.side === "player") return this._st.playerSide;
      return this._st.enemySide;
    },
    // Lua: adapter.lua:391
    foeSide(battler: any): any {
      if (!truthy(battler)) return null;
      if (battler.side === "player") return this._st.enemySide;
      return this._st.playerSide;
    },
    // Lua: adapter.lua:396
    findHazard(side: any, id: any): any {
      if (!truthy(side) || !truthy(side.hazards)) return null;
      for (const [, h] of ipairs(side.hazards)) {
        if (h.id === id) return h;
      }
      return null;
    },
    // Lua: adapter.lua:403
    isBattleDecided(): boolean {
      return this._st.over === true;
    },
    // Lua: adapter.lua:406
    hasSubstitute(battler: any): boolean {
      return truthy(battler) && lor(battler.substituteHP, 0) > 0;
    },
    // Lua: adapter.lua:409
    abilityOf(battler: any): string | null {
      if (!truthy(battler)) return null;
      if (truthy(battler.expTracedAbility)) return battler.expTracedAbility;
      if (truthy(battler.expAbilitySuppressed)) return null;
      let id: any = battler.ability;
      if (!truthy(id) && truthy(battler.mon)) {
        id = lor(battler.mon.ability, battler.mon.abilityId);
      }
      if (typeof id === "string" && id !== "") {
        return gsub(id.toUpperCase(), "%s+", "_")[0];
      }
      id = tonumber(id);
      if (id != null && id > 0) {
        if (truthy(ABILITY_BY_ID[id])) return ABILITY_BY_ID[id];
        // pcall(require, "src.core.game3.pokemon"): always loads here
        if (truthy(Pokemon) && truthy(Pokemon.abilityName)) {
          const n: any = Pokemon.abilityName(id);
          if (truthy(n) && n !== "" && match(n, "^ABILITY") == null) {
            return gsub(tostring(n).toUpperCase(), "%s+", "_")[0];
          }
        }
      }
      return null;
    },
    // Lua: adapter.lua:433
    lastMoveOf(battler: any): any {
      return truthy(battler) ? lor(battler.lastMoveId, battler.lastMove) : battler;
    },
    // Lua: adapter.lua:436
    partyMons(battler: any): Tbl {
      if (!truthy(battler)) return seq();
      if (battler.side === "player") return lor(this._st.playerParty, seq());
      return lor(this._st.foeParty, seq());
    },
    // Lua: adapter.lua:442
    // pokefirered/src/battle_script_commands.c:2413
    applyConfusion(battler: any, turns?: any, _source?: any): boolean {
      if (!truthy(battler)) return false;
      if (lor(battler.confusionTurns, 0) > 0) return false;
      let t = tonumber(turns);
      if (t == null) t = mod(this.roll(0, 3), 4) + 2;
      battler.confusionTurns = t;
      return true;
    },
    // Lua: adapter.lua:450
    useMove(user: any, moveId: any, target: any, opts?: any): any {
      return Engine.resolveMove(user, target, moveId, truthy(opts) ? opts.slot : opts, this, this._st, seq());
    },

    // Lua: adapter.lua:455
    setWeather(kind: any, turns?: any): void {
      this._st.weather = kind;
      this._st.weatherTurns = lor(turns, 5);
    },

    // Lua: adapter.lua:460
    tickWeather(): void {
      if (truthy(ResidualHandlers.tickWeather)) ResidualHandlers.tickWeather(this);
    },
  };

  return a;
};

export default Adapter;
