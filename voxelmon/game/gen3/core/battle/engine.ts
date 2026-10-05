// Port of gen1recomp src/core/game3/battle/engine.lua (GPLv3 + additional terms; see LICENSE.md).
// Owned turn resolver: moves, effects, residuals, commands.
//
// Port notes:
// - `require` at the top and the lazy requires / package.loaded probes
//   (link_guard, bg, scripting.space, scripting.flags, Gen3Compat,
//   effects.hit, effects._helpers, runtime, items, effects.hazards, pokemon)
//   are static imports used exactly as Brian guards them: every module is in
//   the bundle, so each is "loaded".
// - The move context (`Ctx` metatable) is the MoveCtx class: same fields, the
//   colon methods on its prototype. Other modules add fields freely, so it
//   keeps an index signature.
// - `pcall(adapter:rng(), lo, hi)` (Engine.roll) is try/catch around calling
//   the function adapter:rng() returns; adapter:rng() itself is evaluated
//   outside the pcall, as in Lua. RNG call order is Brian's throughout.
// - Lua multiple returns are 0-based tuples on every path of a function that
//   returns more than one value anywhere:
//     Engine.disobedient -> [null] | ["stop"] | ["called", slot]
//     Engine.canRun      -> [true] | [false, text | null]
//     Engine.canSwitch   -> [true] | [false, text]
//     Engine.tryFlee     -> [false] | [true] | [true, "item" | "ability"]
//     Engine.planTurnActions -> [actions, null]
//     Engine.planTurnFromActions / Engine.planTurn -> [actions, playerAct | null]
//   (local: forced_move -> [move, slot], player_identity -> [id, name],
//   types_of -> [type1, type2].)
//   Callees: Types.typeCalc -> [dmg, flags, product], HeldItems.of ->
//   [he, param, item], Abilities.escapeBlocker -> [holder, ability],
//   BattleText.key -> [key, fill].
// - Coroutines. Brian runs a move in a Lua coroutine when
//   st.interactiveChoices is set, and the Baton Pass effect yields to ask the
//   player for a party slot (effects/special.lua). JS has no coroutines that
//   can yield through ordinary frames, so the engine owns a small shim:
//     * Engine.coRunning() stands for `coroutine.running()` (truthy only
//       inside a resolve that Brian runs as a coroutine, or a resumed one).
//     * A yield site does `throw Engine.coYield(req, cont)`: `req` is the
//       value Brian yields, `cont(value)` is the rest of the yielding function
//       given the resume value (and returns what that function returns).
//     * Every frame between the yield and the coroutine body that has work
//       left after its call catches the CoYield, pushes
//       `(ret) => <rest of the frame given the callee returned ret>` onto
//       `e.conts`, and rethrows it untouched (a `pcall` there must rethrow a
//       CoYield, not treat it as an error). Frames with no work left need
//       nothing.
//     * coroutine.resume runs the continuations in order, innermost first,
//       each receiving the previous one's return value; a continuation that
//       yields again suspends the coroutine with the rest appended.
//   The engine's own frames (resolveMove, forEachTarget and the move body)
//   follow this. NOT FAITHFUL until effects/init.ts (Effects.run: pop the
//   EffectCtx and return true in its continuation) and effects/special.ts
//   (batonPass) follow it too; until then special.ts sees no coroutine and
//   takes its non-interactive path.
// - NOT FAITHFUL (load order): `ResidualHandlers.registerAll()` runs at module
//   load as Brian's does, but if residual_handlers is not evaluated yet (an
//   import cycle) or is still a stub, it is retried at the first
//   Engine.collectResidualEvents (the only way the battle collects residuals).
// - CHARGE_TEXT is keyed by EffectIds values, so it is built on first use
//   rather than at load (EffectIds may not be evaluated yet in a cycle).
// - Emerald-only conditions that only read battle state (BattleProfile.isRse,
//   Kinds frontier / Birch checks, playerHalf / foeHalf) are kept as written:
//   they are false for FRLG. NOT FAITHFUL: Emerald only: the Battle Pyramid
//   flee branch (rse.frontier.pyramid) throws.
// - `debug.traceback` on a failed coroutine resume rethrows the error itself.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { mod, tonumber, tostring, truthy } from "../../../../import/gen3/lua.ts";
import { ipairs, isEmpty, len, pairs, seq, type LuaTable } from "../../platform/lt.ts";
import { NotPortedError } from "../../notported.ts";
import Damage from "./damage.ts";
import Moves from "./moves.ts";
import State from "./state.ts";
import Effects from "./effects.ts";
import EffectIds from "./effect_ids.ts";
import Residuals from "./residuals.ts";
import ResidualHandlers from "./residual_handlers.ts";
import Commands from "./commands.ts";
import Types from "./types.ts";
import Rules from "./rules.ts";
import Secondary from "./effects/secondary.ts";
import HeldItems from "./held_items.ts";
import Abilities from "./abilities.ts";
import Oak from "./oak_advice.ts";
import BattleProfile from "./profile.ts";
import Kinds from "./kinds.ts";
import ModRuntime from "../../shared/mods/Runtime.ts";
import BattleText from "./battle_text.ts";
import RomText from "../rom_text.ts";
import LinkGuard from "./link_guard.ts";
import BattleBg from "./bg.ts";
import Space from "../scripting/space.ts";
import Flags from "../scripting/flags.ts";
import G3 from "../../shared/mods/Gen3Compat.ts";
import Hit from "./effects/hit.ts";
import H from "./effects/_helpers.ts";
import Runtime from "../runtime.ts";
import BattleItems from "./items.ts";
import Hazards from "./effects/hazards.ts";
import Pokemon from "../pokemon.ts";
import type { BattleAdapter } from "./adapter.ts";

type Tbl = LuaTable;
type Ad = BattleAdapter;

/** Lua `a or b` (b already evaluated). */
function lor<A, B>(a: A, b: B): A | B {
  return truthy(a) ? a : b;
}

/** Lua `t and t.k`. */
function tk(t: any, k: string): any {
  return truthy(t) ? t[k] : t;
}

/** Lua `type(v) == "table"`. */
function isTable(v: unknown): v is Tbl {
  return v !== null && typeof v === "object";
}

/** State.idOf, untyped: Lua ids flow through code that also takes nil. */
function idOf(b: any): any {
  return State.idOf(b);
}

/** The message of a caught Lua error (what `tostring(err)` prints). */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : tostring(e);
}

// ---------------------------------------------------------------- coroutines

/** A `coroutine.yield` unwinding to the enclosing engine coroutine (see notes). */
export class CoYield {
  readonly conts: ((v: any) => any)[] = [];
  constructor(readonly req: any, cont: (v: any) => any) {
    this.conts.push(cont);
  }
}

/** A suspended engine coroutine: its pending continuations (null once dead). */
interface CoThread {
  conts: ((v: any) => any)[] | null;
}

let coDepth = 0;

/** coroutine.resume: [true, yielded | returned] or [false, err]. */
function coResume(co: CoThread, first: (() => any) | null, value?: any): [boolean, any] {
  if (first == null && co.conts == null) return [false, "cannot resume dead coroutine"];
  coDepth++;
  try {
    if (first != null) {
      const r = first();
      co.conts = null;
      return [true, r];
    }
    const conts = co.conts as ((v: any) => any)[];
    let v = value;
    for (let i = 0; i < conts.length; i++) {
      try {
        v = conts[i](v);
      } catch (e) {
        if (e instanceof CoYield) {
          for (let j = i + 1; j < conts.length; j++) e.conts.push(conts[j]);
          co.conts = e.conts;
          return [true, e.req];
        }
        throw e;
      }
    }
    co.conts = null;
    return [true, v];
  } catch (e) {
    if (e instanceof CoYield) {
      co.conts = e.conts;
      return [true, e.req];
    }
    co.conts = null;
    return [false, e];
  } finally {
    coDepth--;
  }
}

// ---------------------------------------------------------------- module

export interface EngineModule {
  [k: string]: any;
  MOVE_TARGET: Record<string, number>;
  coRunning(): boolean;
  coYield(req: any, cont: (v: any) => any): CoYield;
  isForbiddenToCopy(move: any, listEndAtMimic?: boolean): boolean;
  NATURE_POWER_MOVES: Record<number, number>;
  moveNum(moveId: any, move?: any): number | null;
  hasFlag(move: any, flag: number): boolean;
  roll(adapter: any, lo: number, hi: number): number;
  terrainOf(st: any): number;
  cancelMultiTurnMoves(b: any): void;
  refreshLinks(st: any): void;
  hasBadge(st: any, n: number): boolean;
  linkSeatSwap(st: any): boolean;
  speedOf(battler: any, st: any, adapter?: any): number;
  clearTurnFlags(battler: any): void;
  effectivenessLine(flags: any, eff?: any): any;
  newContext(user: any, target: any, moveId: any, slot: any, adapter: Ad, st: any, out: Tbl, anim: any, opts?: any): MoveCtx;
  selfHit(M: MoveCtx, dmg: number): void;
  canceller(M: MoveCtx): boolean | "ghost" | "bide";
  isTwoTurnMove(move: any): boolean;
  setSemiInvulnerable(b: any, kind: any): void;
  isImprisoned(ad: any, b: any, num: any): boolean;
  turnOrderIds(st: any): Tbl;
  turnOrderNum(st: any, id: any): number;
  followMeId(st: any, ad: Ad, attacker: any): any;
  getMoveTarget(st: any, ad: Ad, attacker: any, moveId: any, setTarget?: number | null): any;
  resolveTarget(st: any, ad: Ad, attacker: any, moveId: any, chosenId: any, info?: any): any;
  moveLimitations(b: any, ad?: Ad | null): Record<number, boolean>;
  isTradedMon(st: any, mon: any): boolean;
  disobedient(M: MoveCtx): [string | null, number?];
  moveEndEffects(M: MoveCtx): void;
  moveEndLite(M: MoveCtx): void;
  afterAction(st: any, ad: Ad): void;
  lightningRodTook(M: MoveCtx): boolean;
  resetTargetValues(M: MoveCtx): void;
  forEachTarget(M: MoveCtx, body: (M: MoveCtx) => any): any;
  resolveMove(user: any, target: any, moveId: any, slot: any, adapter: Ad, st: any, out?: Tbl, opts?: any): Tbl;
  finishResolve(adapter: Ad, st: any, out: Tbl, anim: any, mark: number, prevSay: any, skipAfter: any): Tbl;
  resumeChoice(st: any, adapter: Ad, value: any): Tbl | null;
  mostSuitableMon(st: any, adapter: Ad, side: any): number | null;
  performEnemyItem(st: any, adapter: Ad, act: any): any;
  performSwitch(st: any, adapter: Ad, side: any, slot: number, opts?: any): any;
  cancelPendingAction(st: any, id: any): void;
  actionRunnable(st: any, act: any): boolean;
  switchOutEffects(st: any, adapter: Ad, battler: any): any;
  switchInEffects(st: any, adapter: Ad, battler: any, opts?: any): any;
  battleStartEffects(st: any, adapter: Ad): boolean;
  canRun(st: any, adapter: Ad, battler?: any): [boolean, any?];
  canSwitch(st: any, adapter: Ad, battler?: any): [boolean, string?];
  tryFlee(st: any, adapter: Ad, battler?: any): [boolean, string?];
  switchCandidates(st: any, side: any): Tbl;
  replacementCandidates(st: any, id: any): Tbl;
  faintedBattlers(st: any): Tbl;
  markAbsent(st: any, id: any): void;
  refreshAbsent(st: any): Tbl;
  pendingReplacements(st: any): Tbl;
  expAwardOrder(st: any): Tbl;
  planTurnActions(st: any, adapter: Ad, chosen?: any): [Tbl, null];
  planTurnFromActions(st: any, adapter: Ad, playerAct: any, enemyAct: any): [Tbl, any];
  planTurn(st: any, adapter: Ad): [Tbl, any];
  collectResidualEvents(st: any, adapter: Ad): any;
  hasLivingMons(party: any): boolean;
  nextLivingMonIndex(party: any, currentIdx: any): number | null;
  isPursuit(move: any): boolean;
  checkEnd(st: any, adapter?: Ad): any;
}

export const Engine = {} as EngineModule;

let rollWarned = false;
let badgeWarned = false;

Engine.coRunning = function (): boolean {
  return coDepth > 0;
};

Engine.coYield = function (req: any, cont: (v: any) => any): CoYield {
  return new CoYield(req, cont);
};

// Lua: engine.lua:27
let handlersPending = false;
function registerHandlers(): void {
  try {
    ResidualHandlers.registerAll();
    handlersPending = false;
  } catch (e) {
    if (!(e instanceof ReferenceError || e instanceof NotPortedError)) throw e;
    handlersPending = true;
  }
}
registerHandlers();

const E: any = EffectIds;

// pokefirered/include/constants/pokemon.h:238
const FLAG_PROTECT_AFFECTED = 2;
const FLAG_MAGIC_COAT_AFFECTED = 4;
const FLAG_SNATCH_AFFECTED = 8;
const FLAG_MIRROR_MOVE_AFFECTED = 16;

const MOVE_TARGET_SELECTED = 0;
const MOVE_TARGET_DEPENDS = 1;
const MOVE_TARGET_USER_OR_SELECTED = 2;
const MOVE_TARGET_RANDOM = 4;
const MOVE_TARGET_BOTH = 8;
const MOVE_TARGET_USER = 16;
const MOVE_TARGET_FOES_AND_ALLY = 32;
const MOVE_TARGET_OPPONENTS_FIELD = 64;
Engine.MOVE_TARGET = {
  SELECTED: MOVE_TARGET_SELECTED, DEPENDS: MOVE_TARGET_DEPENDS,
  USER_OR_SELECTED: MOVE_TARGET_USER_OR_SELECTED, RANDOM: MOVE_TARGET_RANDOM,
  BOTH: MOVE_TARGET_BOTH, USER: MOVE_TARGET_USER, FOES_AND_ALLY: MOVE_TARGET_FOES_AND_ALLY,
  OPPONENTS_FIELD: MOVE_TARGET_OPPONENTS_FIELD,
};

const MOVE_SNORE = 173, MOVE_SLEEP_TALK = 214, MOVE_STRUGGLE = 165, MOVE_CURSE = 174;
const MOVE_SKY_ATTACK = 143, MOVE_BOUNCE = 340, MOVE_FLY = 19, MOVE_DIG = 91, MOVE_DIVE = 291;

// pokefirered/src/battle_script_commands.c:707
const FORBIDDEN_TO_COPY: Tbl = seq(
  118, 165, 166, 102, -1, 68, 243, 182, 197, 203, 194, 214, 168, 266, 289, 270, 343, 271, 264,
);

// Lua: engine.lua:60
function forbidden(move: any, list_end_at_mimic?: boolean): boolean {
  for (const [, m] of ipairs(FORBIDDEN_TO_COPY)) {
    if (m === -1) {
      if (truthy(list_end_at_mimic)) return false;
    } else if (m === move) {
      return true;
    }
  }
  return false;
}
Engine.isForbiddenToCopy = forbidden;

// pokefirered/src/battle_script_commands.c:741
Engine.NATURE_POWER_MOVES = {
  0: 78, 1: 75, 2: 89, 3: 56, 4: 57, 5: 61, 6: 157, 7: 247, 8: 129, 9: 129,
};

// Lua: engine.lua:77
function move_num(moveId: any, move?: any): number | null {
  const n = tonumber(tk(move, "numId")) ?? tonumber(moveId);
  if (n != null) return n;
  if (typeof moveId === "string") return Moves.numForName(Moves.normalizeId(moveId)) ?? null;
  return null;
}
Engine.moveNum = move_num;

// Lua: engine.lua:85
function has_flag(move: any, flag: number): boolean {
  let f: any = tk(move, "flags");
  if (f == null || (move.numId == null && (tonumber(f) ?? 0) === 0)) {
    if (flag === FLAG_PROTECT_AFFECTED) {
      return (tonumber(tk(move, "target")) ?? 0) !== MOVE_TARGET_USER;
    }
    return false;
  }
  f = tonumber(f) ?? 0;
  return mod(Math.floor(f / flag), 2) === 1;
}
Engine.hasFlag = has_flag;

// Lua: engine.lua:98
function roll(adapter: any, lo: number, hi: number): number {
  if (truthy(adapter) && truthy(adapter.rng)) {
    const f = adapter.rng();
    let ok = false;
    let v: any;
    try { v = f(lo, hi); ok = true; } catch (e) { ok = false; v = errText(e); }
    if (ok && typeof v === "number") return v;
    if (!rollWarned) {
      rollWarned = true;
      console.log("[game3/engine] adapter rng failed: " + tostring(v));
    }
  }
  return LinkGuard.fallback("engine.roll", lo, hi);
}
Engine.roll = roll;

// Lua: engine.lua:111
function terrain_of(st: any): number {
  if (truthy(st) && st.terrain != null) return tonumber(st.terrain) ?? 8;
  // package.loaded["src.core.game3.battle.bg"]
  const Bg: any = BattleBg;
  if (truthy(Bg) && truthy(Bg.terrainId)) return tonumber(Bg.terrainId()) ?? 8;
  return 8;
}
Engine.terrainOf = terrain_of;

// Lua: engine.lua:120
// pokefirered/src/battle_util.c:203
Engine.cancelMultiTurnMoves = function (b: any): void {
  if (!truthy(b)) return;
  b.expLockedMove = null;
  b.expLockedSlot = null;
  b.expRampageTurns = null;
  b.expUproarTurns = null;
  b.uproar = null;
  b.bideTurns = null;
  b.twoTurnMove = null;
  b.twoTurnTarget = null;
  b.semiInvulnerable = null;
  b.onAir = null; b.underground = null; b.underwater = null;
  b.expRolloutTimer = null;
  b.expFuryCutter = null;
};

// Lua: engine.lua:137
// pokefirered/src/battle_main.c:2373
Engine.refreshLinks = function (st: any): void {
  if (!truthy(st)) return;
  const onField = new Set<any>();
  for (let id = 0; id <= 3; id++) {
    const b = State.battler(st, id);
    if (truthy(b)) onField.add(b);
  }
  for (let id = 0; id <= 3; id++) {
    const b = State.battler(st, id);
    if (truthy(b)) {
      const foe = !truthy(st.double) ? State.battler(st, State.OPPOSITE(id)) : null;
      const gone = (src: any): boolean => {
        if (truthy(st.double)) return !onField.has(src);
        return src !== foe;
      };
      if (truthy(b.expInfatuatedWith) && gone(b.expInfatuatedWith)) {
        b.expInfatuated = null; b.expInfatuatedWith = null;
      }
      if (truthy(b.expTrapSource) && gone(b.expTrapSource)) {
        b.expTrapTurns = null; b.expTrapSource = null; b.expTrapMove = null; b.wrapped = null;
      }
      if (truthy(b.expTrappedBy) && gone(b.expTrappedBy)) {
        b.expTrapped = null; b.expTrappedBy = null; b.escapePrevention = null;
      }
    }
  }
};

// Lua: engine.lua:166
// pokefirered/src/pokemon.c:2381
Engine.hasBadge = function (st: any, n: number): boolean {
  if (!truthy(st) || truthy(st.link)) return false;
  const b = st.badges;
  if (isTable(b)) return b[n] === true;
  if (typeof b === "number") return mod(Math.floor(b / 2 ** (n - 1)), 2) === 1;
  // package.loaded["src.core.game3.scripting.space"] / ["...scripting.flags"]
  const Sp: any = Space;
  const Fl: any = Flags;
  const badgeFlags = BattleProfile.of(st).badgeFlags;
  if (truthy(badgeFlags)) {
    // pokeemerald/src/battle_util.c:3930
    const flag = badgeFlags[n];
    if (!(truthy(flag) && truthy(Sp) && truthy(Sp.store) && truthy(Fl) && truthy(Fl.getFlag))) return false;
    return truthy(Fl.getFlag(Sp.store, null, flag)) ? true : false;
  }
  if (truthy(Sp) && truthy(Sp.store) && truthy(Fl) && truthy(Fl.hasBadge)) {
    let ok: boolean;
    let v: any;
    try { v = Fl.hasBadge(Sp.store, n); ok = true; } catch (e) { ok = false; v = errText(e); }
    if (!ok) {
      if (!badgeWarned) {
        badgeWarned = true;
        console.log("[game3/battle] hasBadge failed: " + tostring(v));
      }
      return false;
    }
    return v === true;
  }
  return false;
};

// Lua: engine.lua:195
// pokefirered/src/battle_controllers.c:163 InitLinkBtlControllers
function link_seat_swap(st: any): boolean {
  if (!(truthy(st) && truthy(st.link))) return false;
  return st.linkMaster === false;
}

Engine.linkSeatSwap = link_seat_swap;

// Lua: engine.lua:203
// pokefirered/src/battle_main.c:3399
function speed_of(battler: any, st: any, adapter?: any): number {
  const mon = tk(battler, "mon");
  let spe: number = tonumber(truthy(mon) ? lor(mon.speed, mon.spe) : mon) ?? 50;
  if (truthy(battler) && truthy(battler.expTransform) && truthy(battler.expTransform.speed)) {
    spe = battler.expTransform.speed;
  }
  let weather: any = truthy(adapter) ? Rules.weather.effective(st, adapter) : adapter;
  if (!truthy(weather)) weather = Rules.weather.kind(tk(st, "weather"));
  const ab = truthy(adapter) ? adapter.abilityOf(battler) : adapter;
  let mul = 1;
  if ((ab === "SWIFT_SWIM" && weather === "RAIN") || (ab === "CHLOROPHYLL" && weather === "SUN")) {
    mul = 2;
  }
  let stage: any = (truthy(battler) && truthy(battler.stages)) ? battler.stages.speed : null;
  if (!truthy(stage)) stage = 0;
  spe = Damage.applyStage(spe * mul, stage);
  const k = lor(tk(st, "kinds"), {}) as any;
  // pokeemerald/src/battle_main.c:4640
  const noBoost = truthy(st) && BattleProfile.isRse(st) && truthy(lor(k.frontier, k.recordedLink));
  if (truthy(battler) && battler.side === "player" && !noBoost && Engine.hasBadge(st, 3)) {
    spe = Math.floor(spe * 110 / 100);
  }
  const [he, param] = HeldItems.of(battler);
  if (he === HeldItems.HOLD.MACHO_BRACE) spe = Math.floor(spe / 2);
  const st1 = truthy(battler) ? lor(battler.status, tk(battler.mon, "status")) : battler;
  if (st1 === "PAR") spe = Math.floor(spe / 4);
  if (he === HeldItems.HOLD.QUICK_CLAW && truthy(st) && (tonumber(st.randomTurnNumber) ?? 0xFFFF)
      < Math.floor(0xFFFF * param / 100)) {
    spe = 0xFFFFFFFF;
  }
  return spe;
}
Engine.speedOf = speed_of;

// Lua: engine.lua:235
function clear_turn_flags(battler: any): void {
  if (!truthy(battler)) return;
  // pokefirered/src/battle_main.c:3623
  battler.expProtected = null;
  battler.expEnduring = null;
  battler.expMagicCoat = null;
  battler.expSnatch = null;
  battler.expHelpingHand = null;
  battler.flinched = null;
  battler.damageTakenThisTurn = 0;
  battler.lastPhysicalDamageTaken = null;
  battler.lastSpecialDamageTaken = null;
  battler.expHurtBy = null;
  battler.expHurtById = null;
  battler.lastPhysicalById = null;
  battler.lastSpecialById = null;
  battler.expLightningRodRedirected = null;
  battler.expMovedThisTurn = null;
  battler.expTurnOrder = null;
  battler.expUnableToMove = null;
  battler._statLoweredMsg = null;
  if (lor(battler.isFirstTurn, 0) > 0) battler.isFirstTurn = battler.isFirstTurn - 1;
  if (truthy(battler.expRechargeTurns)) {
    battler.expRechargeTurns = battler.expRechargeTurns - 1;
    if (battler.expRechargeTurns <= 0) {
      battler.expRechargeTurns = null;
      battler.expMustRecharge = null;
      battler.recharge = null;
    }
  }
}
Engine.clearTurnFlags = clear_turn_flags;

// Lua: engine.lua:268
function effectiveness_line(flags: any, eff?: any): any {
  if (truthy(flags)) {
    if (truthy(flags.super)) return State.text(null, "STRINGID_SUPEREFFECTIVE");
    if (truthy(flags.notVery)) return State.text(null, "STRINGID_NOTVERYEFFECTIVE");
    return null;
  }
  if (eff >= 2) return State.text(null, "STRINGID_SUPEREFFECTIVE");
  if (eff > 0 && eff < 1) return State.text(null, "STRINGID_NOTVERYEFFECTIVE");
  return null;
}
Engine.effectivenessLine = effectiveness_line;

// Lua: engine.lua:280
function say_id(ad: Ad, id: any, fill?: any): void {
  ad.sayText(id, fill);
}

// Lua: engine.lua:284 (local Ctx = {}; Ctx.__index = Ctx)
export class MoveCtx {
  [k: string]: any;
  isMoveContext!: boolean;
  adapter!: Ad;
  st: any;
  user: any;
  target: any;
  moveId: any;
  move: any;
  mnum: any;
  effect!: number;
  slot: any;
  out: Tbl;
  anim: any;
  opts: any;
  moveName: any;
  uname: any;
  tname: any;
  animTurn: any;

  // Lua: engine.lua:287
  say(text: any, id?: any): void { this.adapter.say(text, id); }
  // Lua: engine.lua:288
  sayId(id: any, fill?: any): void { this.adapter.sayText(id, fill); }

  // Lua: engine.lua:291
  // pokefirered/src/battle_script_commands.c:1108
  attackString(): void {
    if (truthy(this.printedUsed)) return;
    this.printedUsed = true;
    this.sayId(BattleText.USEDMOVE, { atk: this.user, currentMove: this.moveName });
    if (ModRuntime.wants("battle.move_used")) {
      const view = G3.moveView(this.move);
      ModRuntime.emit("battle.move_used", {
        battle: this.st, user: this.user, target: this.target, move: view,
        isCalled: truthy(this.opts.called) ? true : false,
        moveId: tk(view, "id"), moveNum: this.mnum, side: tk(this.user, "side"),
        userId: truthy(this.user) ? idOf(this.user) : this.user,
        targetId: truthy(this.target) ? idOf(this.target) : this.target,
      });
    }
  }

  // Lua: engine.lua:309
  // pokefirered/src/battle_script_commands.c:1122
  ppReduce(): void {
    if (truthy(this.ppDone)) return;
    this.ppDone = true;
    if (truthy(this.noPP) || !truthy(this.slot)) return;
    const mon = this.user.mon;
    if (!truthy(mon)) return;
    mon.pp = lor(mon.pp, seq());
    const pp = tonumber(mon.pp[this.slot]);
    if (pp == null) return;
    let cost = 1;
    const target = this.target;
    const ttype = tonumber(this.move.target) ?? 0;
    if (truthy(this.st) && truthy(this.st.double) && (ttype === MOVE_TARGET_FOES_AND_ALLY || ttype === MOVE_TARGET_BOTH
        || ttype === MOVE_TARGET_OPPONENTS_FIELD)) {
      for (const [, b] of ipairs(State.present(this.st))) {
        if (b !== this.user && this.adapter.abilityOf(b) === "PRESSURE"
            && (ttype === MOVE_TARGET_FOES_AND_ALLY || b.side !== this.user.side)) {
          cost = cost + 1;
        }
      }
    } else if (truthy(target) && target !== this.user && ttype !== MOVE_TARGET_USER
        && this.adapter.abilityOf(target) === "PRESSURE") {
      cost = 2;
    }
    if (pp > cost) mon.pp[this.slot] = pp - cost; else mon.pp[this.slot] = 0;
  }

  // Lua: engine.lua:337
  // pokefirered/src/battle_controller_player.c:2330
  attackAnimation(turn?: any, multihitLeft?: any): any {
    const ad = this.adapter, user = this.user;
    if (truthy(this.st) && truthy(this.st.double) && lor(this.animTargetsHit, 0) > 0) {
      const ttype = tonumber(this.move.target) ?? 0;
      // pokefirered/src/battle_script_commands.c:1677
      if (ttype === MOVE_TARGET_BOTH || ttype === MOVE_TARGET_FOES_AND_ALLY || ttype === MOVE_TARGET_DEPENDS) {
        return null;
      }
    }
    const behindSub = truthy(user) && lor(user.substituteHP, 0) > 0;
    if (behindSub && !truthy(this._subLowered)) {
      this._subLowered = true;
      ad.playAnim("special", "SUBSTITUTE_TO_MON", user, user);
    }
    const ev = ad.pushEvent({
      kind: "move",
      moveId: this.moveId,
      attacker: tk(user, "side"),
      target: tk(this.target, "side"),
      attackerId: truthy(user) ? idOf(user) : user,
      targetId: truthy(this.target) ? idOf(this.target) : this.target,
      turn: lor(lor(turn, this.animTurn), 0),
      damage: this._animDmg,
      power: this._animPower,
    });
    this.animTurn = lor(this.animTurn, 0) + 1;
    this.animTargetsHit = lor(this.animTargetsHit, 0) + 1;
    if (behindSub && lor(multihitLeft, 0) < 2) {
      this._subLowered = false;
      ad.playAnim("special", "MON_TO_SUBSTITUTE", user, user);
    }
    return ev;
  }

  // Lua: engine.lua:371
  isProtected(): boolean {
    const t = this.target;
    if (!truthy(t) || t === this.user || !truthy(t.expProtected)) return false;
    if (!has_flag(this.move, FLAG_PROTECT_AFFECTED)) return false;
    if (this.mnum === MOVE_CURSE && !(this.adapter.hasType(this.user, Types.ID.GHOST))) return false;
    return true;
  }

  // Lua: engine.lua:379
  lockOnActive(): boolean {
    const t = this.target;
    if (!(truthy(t) && lor(t.expLockedOn, 0) !== 0 && t.expLockedOn !== false)) return false;
    if (truthy(this.st) && truthy(this.st.double) && t.expLockedOnById != null) {
      return t.expLockedOnById === idOf(this.user);
    }
    return t.expLockedOnBy == null || t.expLockedOnBy === this.user.side;
  }

  // Lua: engine.lua:389
  // pokefirered/src/battle_script_commands.c:1003
  accuracyCheck(mode: any, printFail?: any): boolean {
    const ad = this.adapter, user = this.user, target = this.target;
    const failMsg = (reason: string): void => {
      this.missReason = reason;
      if (!truthy(printFail)) return;
      if (reason === "protected") {
        this.sayId("STRINGID_PKMNPROTECTEDITSELF", { def: target });
      } else if (reason === "fail") {
        this.failed = true;
        ad.sayFail();
      } else {
        this.sayId("STRINGID_ATTACKMISSED", { atk: user });
      }
    };
    if (mode === "noacc" || mode === "lockon") {
      if (mode === "lockon" && this.lockOnActive()) return true;
      if (truthy(target) && truthy(target.semiInvulnerable) && target !== user) {
        failMsg("fail");
        return false;
      }
      if (this.isProtected()) {
        failMsg("protected");
        return false;
      }
      return true;
    }
    // pokefirered/src/battle_script_commands.c:896
    if (this.isProtected()) {
      failMsg("protected");
      return false;
    }
    // pokefirered/src/battle_script_commands.c:1007
    if (Oak.active(this.st) && truthy(user) && user.side === "player") {
      const power = tonumber(tk(this.move, "power")) ?? 0;
      const mask = (power > 0) ? Oak.FLAG_INFLICT_DMG : Oak.FLAG_STAT_CHG;
      if (!Oak.testFlag(this.st, mask)) return !this.absorbed();
    }
    // pokefirered/src/battle_script_commands.c:1015
    if (truthy(this.st) && truthy(this.st.pokedude)) return !this.absorbed();
    if (this.lockOnActive()) return !this.absorbed();
    const semi = (truthy(target) && target !== user) ? target.semiInvulnerable : null;
    if (semi === "ON_AIR" && !truthy(this.ignoreOnAir)) { failMsg("miss"); return false; }
    if (semi === "UNDERGROUND" && !truthy(this.ignoreUnderground)) { failMsg("miss"); return false; }
    if (semi === "UNDERWATER" && !truthy(this.ignoreUnderwater)) { failMsg("miss"); return false; }
    const weather = Rules.weather.effective(this.st, ad);
    const eff = this.effect;
    if ((weather === "RAIN" && eff === E.THUNDER) || eff === E.ALWAYS_HIT || eff === E.VITAL_THROW) {
      return !this.absorbed();
    }
    const accStage: number = lor(truthy(user.stages) ? user.stages.accuracy : null, 0);
    const evaStage: number = lor((truthy(target) && truthy(target.stages)) ? target.stages.evasion : null, 0);
    let buff: number;
    if (truthy(target) && truthy(target.expIdentified)) {
      buff = accStage;
    } else {
      buff = accStage - evaStage;
    }
    if (buff < -6) buff = -6; else if (buff > 6) buff = 6;
    let moveAcc: number = tonumber(lor(this.accOverride, this.move.accuracy)) ?? 100;
    if (weather === "SUN" && eff === E.THUNDER) moveAcc = 50;
    const ratio = Rules.ACCURACY_STAGE[buff] as any;
    let calc = Math.floor(ratio[1] * moveAcc / ratio[2]);
    if (ad.abilityOf(user) === "COMPOUND_EYES") calc = Math.floor(calc * 130 / 100);
    if (weather === "SAND" && ad.abilityOf(target) === "SAND_VEIL") calc = Math.floor(calc * 80 / 100);
    if (ad.abilityOf(user) === "HUSTLE" && Types.isPhysical(lor(this.moveType, this.move.type))) {
      calc = Math.floor(calc * 80 / 100);
    }
    const [tHe, tParam] = HeldItems.of(target);
    if (tHe === HeldItems.HOLD.EVASION_UP) calc = Math.floor(calc * (100 - tParam) / 100);
    let hit: any;
    if (ModRuntime.wantsHook("battle.accuracy")) {
      const view = G3.moveView(this.move);
      hit = ModRuntime.call("battle.accuracy", function (c: any) {
        return roll(ad, 1, 100) <= c.accuracy;
      }, { battle: this.st, move: view, moveId: tk(view, "id"), moveNum: this.mnum,
        user: user, target: target, accuracy: calc, rng: ad.rng() });
    } else {
      hit = roll(ad, 1, 100) <= calc;
    }
    if (!truthy(hit)) {
      failMsg("miss");
      return false;
    }
    return !this.absorbed();
  }

  // Lua: engine.lua:477
  // pokefirered/src/battle_script_commands.c:912
  absorbed(): boolean {
    if (truthy(Abilities.absorb(this))) {
      this.missReason = "absorbed";
      return true;
    }
    return false;
  }

  // Lua: engine.lua:485
  faintMessage(battler: any): boolean {
    const ad = this.adapter;
    if (!truthy(battler) || truthy(battler._faintAnnounced)) return false;
    if (!ad.isFainted(battler)) return false;
    battler._faintAnnounced = true;
    ad.pushEvent({ kind: "faint", side: battler.side, battler: idOf(battler) });
    this.sayId("STRINGID_TARGETFAINTED", { def: battler });
    this.anim.fainted = true;
    this.anim.faints[len(this.anim.faints) + 1] = { side: lor(battler.side, "enemy"), battler: idOf(battler) };
    ad.emitFaint(battler);
    return true;
  }

  // Lua: engine.lua:499
  // pokefirered/src/battle_script_commands.c:2831
  tryFaintTarget(): void {
    const ad = this.adapter, user = this.user, target = this.target;
    if (!truthy(target) || target === user) return;
    if (!ad.isFainted(target) || truthy(target._faintAnnounced)) return;
    this.faintMessage(target);
    if (truthy(target.expDestinyBond) && user.side !== target.side && !ad.isFainted(user)) {
      this.sayId("STRINGID_PKMNTOOKFOE", { def: target, atk: user });
      ad.applyHpLoss(user, ad.hp(user));
      this.faintMessage(user);
    }
    if (truthy(target.expGrudge) && truthy(this.slot) && truthy(user.mon) && truthy(user.mon.pp) && !ad.isFainted(user)) {
      user.mon.pp[this.slot] = 0;
      this.sayId("STRINGID_PKMNLOSTPPGRUDGE", { atk: user, buff1: this.moveName });
    }
  }

  // Lua: engine.lua:515
  tryFaintUser(): void {
    if (this.adapter.isFainted(this.user)) this.faintMessage(this.user);
  }
}

// Lua: engine.lua:519
function new_ctx(user: any, target: any, moveId: any, slot: any, adapter: Ad, st: any, out: Tbl, anim: any, opts?: any): MoveCtx {
  const move = Moves.get(moveId);
  const M = new MoveCtx();
  M.isMoveContext = true;
  M.adapter = adapter;
  M.st = st;
  M.user = user;
  M.target = target;
  M.moveId = moveId;
  M.move = move;
  M.mnum = move_num(moveId, move);
  M.effect = tonumber(move.effect) ?? 0;
  M.slot = slot;
  M.out = out;
  M.anim = anim;
  M.opts = lor(opts, {});
  M.moveName = Moves.displayName(moveId);
  M.uname = adapter.displayName(user);
  M.tname = adapter.displayName(target);
  M.animTurn = 0;
  return M;
}
Engine.newContext = new_ctx;

// Lua: engine.lua:545
// pokefirered/data/battle_scripts_1.s:3741
Engine.selfHit = function (M: MoveCtx, dmg: number): void {
  const ad = M.adapter, user = M.user;
  const r = roll(ad, 85, 100);
  dmg = Math.floor(dmg * r / 100);
  if (dmg === 0) dmg = 1;
  const banded = HeldItems.rollFocusBand(ad, user);
  let hung: string | null = null;
  if (lor(user.substituteHP, 0) <= 0 && truthy(lor(user.expEnduring, banded)) && dmg >= ad.hp(user)) {
    dmg = ad.hp(user) - 1;
    hung = truthy(user.expEnduring) ? "endured" : "band";
  }
  user.expFocusBanded = null;
  M.sayId("STRINGID_ITHURTCONFUSION");
  ad.applyHpLoss(user, dmg);
  if (hung === "endured") {
    M.sayId("STRINGID_PKMNENDUREDHIT", { def: user });
  } else if (hung === "band") {
    HeldItems.focusBandMessage(ad, user);
  }
  M.tryFaintUser();
};

// Lua: engine.lua:568
// pokefirered/src/battle_util.c:1253
function canceller(M: MoveCtx): boolean | "ghost" | "bide" {
  const ad = M.adapter, user = M.user;
  user.expDestinyBond = null;
  user.destinyBond = null;
  user.expGrudge = null;

  const st = ad.status(user);
  if (st === "SLP") {
    const up = ad.uproarActive();
    if (truthy(up) && ad.abilityOf(user) !== "SOUNDPROOF") {
      ad.clearStatus(user);
      user.expNightmare = null;
      M.sayId("STRINGID_PKMNWOKEUPINUPROAR", { atk: user });
    } else {
      const toSub = (ad.abilityOf(user) === "EARLY_BIRD") ? 2 : 1;
      let turns = tonumber(user.sleepTurns)
        ?? tonumber(truthy(user.mon) ? lor(user.mon.sleepTurns, user.mon.sleep) : user.mon);
      if (turns == null || turns <= 0) turns = ad.rollSleepTurns();
      if (turns < toSub) turns = 0; else turns = turns - toSub;
      user.sleepTurns = turns;
      if (turns > 0) {
        if (M.mnum !== MOVE_SNORE && M.mnum !== MOVE_SLEEP_TALK) {
          M.sayId("STRINGID_PKMNFASTASLEEP", { atk: user });
          ad.statusAnim(user, "SLP");
          return false;
        }
      } else {
        ad.clearStatus(user);
        user.expNightmare = null;
        M.sayId("STRINGID_PKMNWOKEUP", { atk: user });
      }
    }
  }

  if (ad.status(user) === "FRZ") {
    if (roll(ad, 0, 4) !== 0) {
      if (M.effect !== E.THAW_HIT) {
        M.sayId("STRINGID_PKMNISFROZEN", { atk: user });
        ad.statusAnim(user, "FRZ");
        return false;
      }
    } else {
      ad.clearStatus(user);
      M.sayId("STRINGID_PKMNWASDEFROSTED2", { atk: user });
    }
  }

  if (truthy(Abilities.truantLoafs(ad, user))) {
    // pokefirered/src/battle_util.c:1337
    Engine.cancelMultiTurnMoves(user);
    M.sayId("STRINGID_PKMNLOAFING", { atk: user });
    user.expUnableToMove = true;
    return false;
  }

  if (truthy(user.expMustRecharge)) {
    user.expMustRecharge = null;
    user.expRechargeTurns = null;
    user.recharge = null;
    Engine.cancelMultiTurnMoves(user);
    M.sayId("STRINGID_PKMNMUSTRECHARGE", { atk: user });
    return false;
  }

  if (truthy(user.flinched)) {
    user.flinched = null;
    Engine.cancelMultiTurnMoves(user);
    M.sayId("STRINGID_PKMNFLINCHED", { atk: user });
    user.expUnableToMove = true;
    return false;
  }

  if (truthy(user.expDisabledMove) && M.mnum === user.expDisabledMove) {
    Engine.cancelMultiTurnMoves(user);
    M.sayId("STRINGID_PKMNMOVEISDISABLED", { active: user, currentMove: M.moveName });
    user.expUnableToMove = true;
    return false;
  }

  if (lor(user.expTauntedTurns, 0) > 0 && (tonumber(M.move.power) ?? 0) === 0) {
    Engine.cancelMultiTurnMoves(user);
    M.sayId("STRINGID_PKMNCANTUSEMOVETAUNT", { active: user, currentMove: M.moveName });
    user.expUnableToMove = true;
    return false;
  }

  if (truthy(M.mnum) && Engine.isImprisoned(ad, user, M.mnum)) {
    Engine.cancelMultiTurnMoves(user);
    M.sayId("STRINGID_PKMNCANTUSEMOVESEALED", { active: user, currentMove: M.moveName });
    user.expUnableToMove = true;
    return false;
  }

  if (lor(user.confusionTurns, 0) > 0) {
    user.confusionTurns = user.confusionTurns - 1;
    if (user.confusionTurns > 0) {
      M.sayId("STRINGID_PKMNISCONFUSED", { atk: user });
      ad.playAnim("status", "CONFUSION", user, user);
      if (roll(ad, 0, 1) === 0) {
        Engine.cancelMultiTurnMoves(user);
        // pokefirered/src/battle_util.c:1424
        const dmg = Damage.base(user, user, { power: 40, type: 0, effect: 0 }, {
          power: 40, moveType: 0, adapter: ad,
        });
        Engine.selfHit(M, dmg);
        user.expUnableToMove = true;
        return false;
      }
    } else {
      user.confusionTurns = null;
      M.sayId("STRINGID_PKMNHEALEDCONFUSION", { atk: user });
    }
  }

  if (ad.status(user) === "PAR" && roll(ad, 0, 3) === 0) {
    M.sayId("STRINGID_PKMNISPARALYZED", { atk: user });
    ad.statusAnim(user, "PAR");
    user.expUnableToMove = true;
    return false;
  }

  // pokefirered/src/battle_util.c:1451
  if (truthy(M.st) && truthy(M.st.ghostBattle) && !truthy(M.st.ghostUnveiled)) {
    if (user.side === "player") {
      // pokefirered/data/battle_scripts_1.s:3809
      M.sayId("STRINGID_MONTOOSCAREDTOMOVE", { atk: user });
      ad.playAnim("general", "MON_SCARED", user, ad.foeOf(user));
    } else {
      // pokefirered/data/battle_scripts_1.s:3815
      const getOut = State.text(M.st, "STRINGID_GHOSTGETOUTGETOUT");
      ad.pushEvent({ kind: "msg", text: getOut, wait: 0, id: "STRINGID_GHOSTGETOUTGETOUT" });
      ad._say(getOut);
      ad.playAnim("general", "GHOST_GET_OUT", user, ad.foeOf(user));
    }
    return "ghost";
  }

  if (truthy(user.expInfatuated)) {
    const lover = lor((truthy(M.st) && truthy(M.st.double)) ? user.expInfatuatedWith : null, null) ?? ad.foeOf(user);
    M.sayId("STRINGID_PKMNINLOVE", { atk: user, scrActive: lover });
    ad.playAnim("status", "INFATUATION", user, user);
    if (roll(ad, 0, 1) === 0) {
      Engine.cancelMultiTurnMoves(user);
      M.sayId("STRINGID_PKMNIMMOBILIZEDBYLOVE", { atk: user });
      user.expUnableToMove = true;
      return false;
    }
  }

  if (lor(user.bideTurns, 0) > 0) {
    user.bideTurns = user.bideTurns - 1;
    if (user.bideTurns > 0) {
      M.sayId("STRINGID_PKMNSTORINGENERGY", { atk: user });
      return false;
    }
    return "bide";
  }

  if (ad.status(user) === "FRZ" && M.effect === E.THAW_HIT) {
    ad.clearStatus(user);
    M.sayId("STRINGID_PKMNWASDEFROSTEDBY", { atk: user, currentMove: M.moveName });
  }
  return true;
}
Engine.canceller = canceller;

// Lua: engine.lua:734
// pokefirered/data/battle_scripts_1.s:3251
function bide_attack(M: MoveCtx): void {
  const ad = M.adapter, user = M.user;
  const dmgStored: number = lor(user.expBideDamage, 0);
  const src = user.expBideTarget;
  user.expBideDamage = null;
  user.expBideTarget = null;
  user.bideTurns = null;
  user.expLockedMove = null;
  user.expLockedSlot = null;
  M.sayId("STRINGID_PKMNUNLEASHEDENERGY", { atk: user });
  if (dmgStored <= 0) {
    M.failed = true;
    ad.sayFail();
    return;
  }
  if (truthy(src) && truthy(src.side) && truthy(M.st) && !truthy(M.st.double) && truthy(M.st[src.side])) M.target = M.st[src.side];
  if (truthy(src) && truthy(M.st) && truthy(M.st.double)) {
    const sid = idOf(src);
    // pokefirered/src/battle_util.c:1500
    if (State.isPresent(M.st, sid)) {
      M.target = State.battler(M.st, sid);
    } else {
      M.target = State.battler(M.st, Engine.getMoveTarget(M.st, ad, user, M.moveId, MOVE_TARGET_SELECTED + 1));
    }
    M.tname = ad.displayName(M.target);
  }
  const target = M.target;
  if (!M.accuracyCheck("normal", true)) return;
  const [, flags] = Types.typeCalc(M.move.type, target.type1, target.type2, null, target.expIdentified);
  if (truthy(flags.immune)) {
    M.sayId("STRINGID_ITDOESNTAFFECT", { def: target });
    return;
  }
  Hit.applySetDamage(M, dmgStored * 2);
  M.tryFaintTarget();
}

// Lua: engine.lua:772
function run_called(M: MoveCtx, calledId: any, opts?: any): any {
  opts = lor(opts, {});
  const sub: Record<string, any> = {};
  for (const [k, v] of pairs(lor(M.opts, {}))) sub[k] = v;
  sub.called = true;
  sub.anim = M.anim;
  sub.noAttackString = null;
  sub.calledBy = M.moveId;
  M.anim.calledBy = lor(M.anim.calledBy, M.moveId);
  let target = M.target;
  const cmove = Moves.get(calledId);
  if (truthy(M.st) && truthy(M.st.double)) {
    target = State.battler(M.st, Engine.getMoveTarget(M.st, M.adapter, M.user, calledId));
  } else if (tonumber(cmove.target) === MOVE_TARGET_USER) target = M.user; else target = M.adapter.foeOf(M.user);
  return Engine.resolveMove(M.user, target, calledId, opts.slot, M.adapter, M.st, M.out, sub);
}

// Lua: engine.lua:790
// pokefirered/src/battle_script_commands.c:7519
function pick_metronome(M: MoveCtx): number {
  for (let n = 1; n <= 64; n++) {
    const m = roll(M.adapter, 1, 511);
    if (m < 355 && !forbidden(m, false)) return m;
  }
  const list: Tbl = seq();
  for (let m = 1; m <= 354; m++) if (!forbidden(m, false)) list[len(list) + 1] = m;
  return list[roll(M.adapter, 1, len(list))];
}

// Lua: engine.lua:800
function invalid_sleep_talk(move: any): boolean {
  // pokefirered/src/battle_script_commands.c:7834
  return move == null || move === 0 || move === MOVE_SLEEP_TALK || move === 274 || move === 119 || move === 118;
}

// Lua: engine.lua:805
function is_two_turn(move: any): boolean {
  const m = Moves.get(move);
  const e = tonumber(tk(m, "effect"));
  return e === E.SKULL_BASH || e === E.RAZOR_WIND || e === E.SKY_ATTACK || e === E.SOLAR_BEAM
    || e === E.SEMI_INVULNERABLE || e === E.BIDE;
}
Engine.isTwoTurnMove = is_two_turn;

// Lua: engine.lua:813
function call_moves(M: MoveCtx): any {
  const ad = M.adapter, user = M.user, eff = M.effect;
  if (eff === E.METRONOME) {
    M.attackString();
    M.ppReduce();
    M.attackAnimation();
    return run_called(M, pick_metronome(M));
  } else if (eff === E.SLEEP_TALK) {
    // pokefirered/data/battle_scripts_1.s:1307
    if (ad.status(user) !== "SLP") {
      M.attackString();
      M.ppReduce();
      M.failed = true;
      ad.sayFail();
      return undefined;
    }
    M.sayId("STRINGID_PKMNFASTASLEEP", { atk: user });
    ad.statusAnim(user, "SLP");
    M.attackString();
    M.ppReduce();
    const mon = lor(user.mon, {}) as any;
    const valid: Tbl = seq();
    for (let i = 1; i <= 4; i++) {
      const mv = move_num(truthy(mon.moves) ? mon.moves[i] : mon.moves);
      const pp = truthy(mon.pp) ? mon.pp[i] : mon.pp;
      if (mv != null && !invalid_sleep_talk(mv) && mv !== 264 && mv !== 253 && !is_two_turn(mv)
          && !(truthy(user.expDisabledMove) && mv === user.expDisabledMove)
          && !(truthy(user.expEncoreMove) && move_num(user.expEncoreMove) !== mv && lor(user.expEncoreTurns, 0) > 0)) {
        valid[len(valid) + 1] = { move: mv, slot: i, pp: pp };
      }
    }
    if (len(valid) === 0) {
      M.failed = true;
      ad.sayFail();
      return undefined;
    }
    const pick = valid[roll(ad, 1, len(valid))];
    M.attackAnimation();
    return run_called(M, pick.move);
  } else if (eff === E.MIRROR_MOVE) {
    // pokefirered/src/battle_script_commands.c:6350
    M.attackString();
    const mv = user.expLastTakenMove;
    if (truthy(mv) && mv !== 0) {
      M.ppReduce();
      return run_called(M, mv);
    }
    M.ppReduce();
    M.failed = true;
    M.sayId("STRINGID_MIRRORMOVEFAILED");
    return undefined;
  } else if (eff === E.ASSIST) {
    // pokefirered/src/battle_script_commands.c:9091
    M.attackString();
    const list: Tbl = seq();
    for (const [i, mon] of ipairs(ad.partyMons(user))) {
      if (i !== user.partyIndex && truthy(mon) && lor(mon.species, 0) !== 0 && !truthy(mon.isEgg)) {
        for (let j = 1; j <= 4; j++) {
          const mv = move_num(truthy(mon.moves) ? mon.moves[j] : mon.moves);
          if (mv != null && mv !== 0 && !invalid_sleep_talk(mv) && !forbidden(mv, false)) {
            list[len(list) + 1] = mv;
          }
        }
      }
    }
    M.ppReduce();
    if (len(list) === 0) {
      M.failed = true;
      ad.sayFail();
      return undefined;
    }
    M.attackAnimation();
    return run_called(M, list[roll(ad, 1, len(list))]);
  } else if (eff === E.NATURE_POWER) {
    // pokefirered/src/battle_script_commands.c:8718
    M.attackString();
    const called = lor(Engine.NATURE_POWER_MOVES[terrain_of(M.st)], 129);
    M.sayId("STRINGID_NATUREPOWERTURNEDINTO", { currentMove: Moves.displayName(called) });
    return run_called(M, called, { slot: M.slot });
  }
  return undefined;
}

// Lua: engine.lua:896
// src/battle_message.c:1029
let CHARGE_TEXT_T: Record<number, string> | null = null;
function CHARGE_TEXT(): Record<number, string> {
  if (CHARGE_TEXT_T == null) {
    CHARGE_TEXT_T = {
      [E.RAZOR_WIND]: "STRINGID_PKMNWHIPPEDWHIRLWIND",
      [E.SOLAR_BEAM]: "STRINGID_PKMNTOOKSUNLIGHT",
      [E.SKULL_BASH]: "STRINGID_PKMNLOWEREDHEAD",
      [E.SKY_ATTACK]: "STRINGID_PKMNISGLOWING",
    };
  }
  return CHARGE_TEXT_T;
}

// Lua: engine.lua:903
const SEMI_TEXT: Record<number, Tbl> = {
  [MOVE_FLY]: seq("STRINGID_PKMNFLEWHIGH", "ON_AIR"),
  [MOVE_BOUNCE]: seq("STRINGID_PKMNSPRANGUP", "ON_AIR"),
  [MOVE_DIG]: seq("STRINGID_PKMNDUGHOLE", "UNDERGROUND"),
  [MOVE_DIVE]: seq("STRINGID_PKMNHIDUNDERWATER", "UNDERWATER"),
};

// Lua: engine.lua:910
function set_semi(b: any, kind: any): void {
  b.semiInvulnerable = kind;
  b.onAir = kind === "ON_AIR" ? true : null;
  b.underground = kind === "UNDERGROUND" ? true : null;
  b.underwater = kind === "UNDERWATER" ? true : null;
}
Engine.setSemiInvulnerable = set_semi;

// Lua: engine.lua:919
// pokefirered/data/battle_scripts_1.s:794
function charge_turn(M: MoveCtx): boolean {
  const ad = M.adapter, user = M.user, eff = M.effect;
  const isCharge = truthy(CHARGE_TEXT()[eff]) || eff === E.SEMI_INVULNERABLE;
  if (!isCharge) return false;
  if (user.twoTurnMove != null && move_num(user.twoTurnMove) === M.mnum) {
    user.twoTurnMove = null;
    user.twoTurnTarget = null;
    user.expLockedMove = null;
    user.expLockedSlot = null;
    M.noPP = true;
    M.secondTurn = true;
    M.animTurn = 1;
    if (M.mnum === MOVE_SKY_ATTACK) M.extraEffect = { eff: "FLINCH" };
    if (M.mnum === MOVE_BOUNCE) M.extraEffect = { eff: "PARALYSIS" };
    return false;
  }
  if (eff === E.SOLAR_BEAM && Rules.weather.effective(M.st, ad) === "SUN") {
    M.ppReduce();
    M.noPP = true;
    return false;
  }
  if (ModRuntime.wantsHook("battle.charge_required")) {
    const required = ModRuntime.call("battle.charge_required", function (c: any) {
      return c.charge;
    }, { battle: M.st, user: user, target: M.target,
      move: G3.moveView(M.move),
      charge: true, isCalled: truthy(M.opts.called) ? true : false });
    if (required === false) {
      M.ppReduce();
      M.noPP = true;
      return false;
    }
  }
  M.ppReduce();
  M.attackAnimation(0);
  user.twoTurnMove = M.moveId;
  user.twoTurnTarget = M.target;
  user.expLockedMove = M.moveId;
  user.expLockedSlot = M.slot;
  if (eff === E.SEMI_INVULNERABLE) {
    const row = SEMI_TEXT[M.mnum];
    if (!truthy(row)) throw new Error("no semi-invulnerable text for move " + tostring(M.mnum));
    M.sayId(row[1], { atk: user });
    set_semi(user, row[2]);
  } else {
    M.sayId(CHARGE_TEXT()[eff], { atk: user });
    if (eff === E.SKULL_BASH) {
      Secondary.changeStat(ad, user, "defense", 1, { user: true, allowPtr: true, noMsg: lor(user.stages.defense, 0) >= 6 });
    }
  }
  M.anim.statusOnly = true;
  M.anim.charging = true;
  return true;
}

// Lua: engine.lua:975
// pokefirered/data/battle_scripts_1.s:761
function ohko(M: MoveCtx): void {
  const ad = M.adapter, user = M.user, target = M.target;
  M.attackString();
  M.ppReduce();
  if (!M.accuracyCheck("lockon", true)) {
    M.anim.missed = true;
    return;
  }
  const [, flags] = Types.typeCalc(M.move.type, target.type1, target.type2, null, target.expIdentified);
  if (truthy(flags.immune) || (ad.abilityOf(target) === "LEVITATE" && tonumber(M.move.type) === Types.ID.GROUND)) {
    M.anim.missed = true;
    M.sayId("STRINGID_ITDOESNTAFFECT", { def: target });
    return;
  }
  const banded = HeldItems.rollFocusBand(ad, target);
  target.expFocusBanded = null;
  if (ad.abilityOf(target) === "STURDY") {
    M.anim.missed = true;
    M.sayId("STRINGID_PKMNPROTECTEDBY", { def: target, defAbility: Abilities.id("STURDY") });
    return;
  }
  const uLvl: number = tonumber(tk(user.mon, "level")) ?? 1;
  const tLvl: number = tonumber(tk(target.mon, "level")) ?? 1;
  let hit: boolean;
  // pokefirered/src/battle_script_commands.c:7104
  if (M.lockOnActive() && uLvl >= tLvl) {
    hit = true;
  } else {
    const chance = (tonumber(M.move.accuracy) ?? 30) + (uLvl - tLvl);
    hit = roll(ad, 1, 100) < chance && uLvl >= tLvl;
  }
  if (!hit) {
    M.anim.missed = true;
    if (uLvl >= tLvl) {
      M.sayId("STRINGID_ATTACKMISSED", { atk: user });
    } else {
      M.sayId("STRINGID_PKMNUNAFFECTED", { def: target });
    }
    return;
  }
  const hpBefore = ad.hp(target);
  let dmg = hpBefore;
  const endured = truthy(target.expEnduring) ? true : false;
  const hung = !endured ? banded : false;
  if (endured || truthy(hung)) dmg = Math.max(0, hpBefore - 1);
  Hit.dealDamage(M, dmg, { physical: Types.isPhysical(M.move.type) });
  if (endured) {
    M.sayId("STRINGID_PKMNENDUREDHIT", { def: target });
  } else if (truthy(hung)) {
    HeldItems.focusBandMessage(ad, target);
  } else {
    M.sayId("STRINGID_ONEHITKO");
  }
  M.tryFaintTarget();
}

// Lua: engine.lua:1033
// pokefirered/src/battle_script_commands.c:866
function try_bounce(M: MoveCtx): boolean {
  const ad = M.adapter, user = M.user, target = M.target;
  if (truthy(M.opts.bounced)) return false;
  if (truthy(target) && target !== user && truthy(target.expMagicCoat) && has_flag(M.move, FLAG_MAGIC_COAT_AFFECTED)) {
    target.expMagicCoat = null;
    M.attackString();
    M.ppReduce();
    M.sayId("STRINGID_PKMNMOVEBOUNCED", { atk: user, currentMove: M.moveName });
    M.user = target; M.target = user;
    const un = M.uname;
    M.uname = M.tname; M.tname = un;
    M.slot = null;
    M.noPP = true;
    M.opts.bounced = true;
    return true;
  }
  let foe = ad.foeOf(user);
  if (truthy(M.st) && truthy(M.st.double)) {
    foe = null;
    for (const [, id] of ipairs(Engine.turnOrderIds(M.st))) {
      const b = State.battler(M.st, id);
      if (truthy(b) && b !== user && truthy(b.expSnatch) && State.isPresent(M.st, id)) { foe = b; break; }
    }
  }
  if (truthy(foe) && foe !== user && truthy(foe.expSnatch) && has_flag(M.move, FLAG_SNATCH_AFFECTED)) {
    foe.expSnatch = null;
    M.attackString();
    M.ppReduce();
    ad.playAnim("general", "SNATCH_MOVE", user, foe);
    M.sayId("STRINGID_PKMNSNATCHEDMOVE", { def: foe, scrActive: user });
    M.user = foe; M.target = user;
    const un = M.uname;
    M.uname = ad.displayName(foe); M.tname = un;
    M.slot = null;
    M.noPP = true;
    M.opts.bounced = true;
    return true;
  }
  return false;
}

// Lua: engine.lua:1073
// pokefirered/src/battle_util.c:427
Engine.isImprisoned = function (ad: any, b: any, num: any): boolean {
  if (!(truthy(ad) && truthy(b) && truthy(num))) return false;
  const st = ad._st;
  const foes = (truthy(st) && truthy(st.double)) ? lor(State.foes(st, b), seq(ad.foeOf(b))) : seq(ad.foeOf(b));
  for (const [, foe] of ipairs(foes)) {
    if (truthy(foe) && truthy(foe.expImprison)) {
      const fm = lor(truthy(foe.mon) ? foe.mon.moves : foe.mon, {}) as any;
      for (let j = 1; j <= 4; j++) {
        if (truthy(fm[j]) && move_num(fm[j]) === num) return true;
      }
    }
  }
  return false;
};

// Lua: engine.lua:1088
Engine.turnOrderIds = function (st: any): Tbl {
  if (truthy(st) && truthy(st.turnOrder) && len(st.turnOrder) > 0) return st.turnOrder;
  return State.presentIds(st);
};

// Lua: engine.lua:1094
// pokefirered/src/battle_script_commands.c:2092
Engine.turnOrderNum = function (st: any, id: any): number {
  const order = Engine.turnOrderIds(st);
  for (const [i, v] of ipairs(order)) {
    if (v === id) return i - 1;
  }
  return 4;
};

// Lua: engine.lua:1102
function has_bit(v: any, b: number): boolean { return mod(Math.floor((tonumber(v) ?? 0) / b), 2) === 1; }

// Lua: engine.lua:1104
function follow_me_id(st: any, ad: Ad, attacker: any): any {
  const side = ad.foeSide(attacker);
  if (!truthy(side)) return null;
  if (side.expFollowMeId != null) return side.expFollowMeId;
  if (truthy(side.expFollowMe)) return idOf(side.expFollowMe);
  return null;
}
Engine.followMeId = follow_me_id;

// Lua: engine.lua:1113
function foe_left(aid: number): number { return (mod(aid, 2) === 0) ? 1 : 0; }

// Lua: engine.lua:1115
function random_foe_flank(st: any, ad: Ad, aid: number): number {
  if (roll(ad, 0, 1) === 1) return foe_left(aid);
  return foe_left(aid) + 2;
}

// Lua: engine.lua:1121
// pokefirered/src/battle_util.c:3054
Engine.getMoveTarget = function (st: any, ad: Ad, attacker: any, moveId: any, setTarget?: number | null): any {
  const aid = idOf(attacker);
  const mv = Moves.get(moveId);
  const ttype = truthy(setTarget) ? (setTarget as number) - 1 : (tonumber(tk(mv, "target")) ?? 0);
  const count = (truthy(st) && truthy(st.double)) ? 4 : 2;
  let target: any;
  if (ttype === MOVE_TARGET_SELECTED) {
    const fm = follow_me_id(st, ad, attacker);
    if (fm != null && ad.hp(State.battler(st, fm)) > 0) {
      target = fm;
    } else {
      for (let n = 1; n <= 256; n++) {
        target = mod(roll(ad, 0, count - 1), count);
        // pokefirered/src/battle_controllers.c:163
        if (truthy(st) && truthy(st.link)) target = State.battlerOrder(st)[target + 1];
        if (target !== aid && mod(target, 2) !== mod(aid, 2) && State.isPresent(st, target)) break;
        target = null;
      }
      target = target ?? foe_left(aid);
      let lr = 0;
      for (let id = 0; id <= count - 1; id++) {
        const b = State.battler(st, id);
        if (truthy(b) && mod(id, 2) !== mod(aid, 2) && ad.abilityOf(b) === "LIGHTNING_ROD") lr = lr + 1;
      }
      if (tonumber(tk(mv, "type")) === Types.ID.ELECTRIC && lr > 0
          && ad.abilityOf(State.battler(st, target)) !== "LIGHTNING_ROD") {
        target = State.PARTNER(target);
        const rb = State.battler(st, target);
        if (truthy(rb)) rb.expLightningRodRedirected = true;
      }
    }
  } else if (ttype === MOVE_TARGET_DEPENDS || ttype === MOVE_TARGET_BOTH || ttype === MOVE_TARGET_FOES_AND_ALLY
      || ttype === MOVE_TARGET_OPPONENTS_FIELD) {
    target = foe_left(aid);
    if (!State.isPresent(st, target) && count === 4) target = State.PARTNER(target);
  } else if (ttype === MOVE_TARGET_RANDOM) {
    const fm = follow_me_id(st, ad, attacker);
    if (fm != null && ad.hp(State.battler(st, fm)) > 0) {
      target = fm;
    } else if (truthy(st) && truthy(st.double)) {
      target = random_foe_flank(st, ad, aid);
      if (!State.isPresent(st, target)) target = State.PARTNER(target);
    } else {
      target = foe_left(aid);
    }
  } else {
    target = aid;
  }
  if (truthy(st)) {
    st.moveTarget = lor(st.moveTarget, {});
    st.moveTarget[aid] = target;
  }
  return target;
};

// Lua: engine.lua:1177
// pokefirered/src/battle_main.c:4024
Engine.resolveTarget = function (st: any, ad: Ad, attacker: any, moveId: any, chosenId: any, info?: any): any {
  info = lor(info, {});
  const aid = idOf(attacker);
  const mv = Moves.get(moveId);
  const ttype = tonumber(tk(mv, "target")) ?? 0;
  const chosenMv = lor(truthy(info.chosenMove) ? Moves.get(info.chosenMove) : null, mv);
  const chosenRandom = has_bit(tk(chosenMv, "target"), MOVE_TARGET_RANDOM);
  let mt = chosenId;
  if (mt == null || truthy(info.recompute)) mt = Engine.getMoveTarget(st, ad, attacker, moveId);
  st.moveTarget = lor(st.moveTarget, {});
  st.moveTarget[aid] = mt;
  const absent_fix = (t: any): any => {
    if (!State.isPresent(st, t)) {
      if (mod(t, 2) !== mod(aid, 2)) {
        t = State.PARTNER(t);
      } else {
        t = foe_left(aid);
        if (!State.isPresent(st, t)) t = State.PARTNER(t);
      }
    }
    return t;
  };
  const fm = follow_me_id(st, ad, attacker);
  if (fm != null && ttype === MOVE_TARGET_SELECTED && mod(fm, 2) !== mod(aid, 2)
      && ad.hp(State.battler(st, fm)) > 0) {
    return fm;
  }
  if (truthy(st.double) && fm == null && ((tonumber(tk(mv, "power")) ?? 0) !== 0 || ttype !== MOVE_TARGET_USER)
      && ad.abilityOf(State.battler(st, mt)) !== "LIGHTNING_ROD"
      && tonumber(tk(mv, "type")) === Types.ID.ELECTRIC) {
    let best: any = null, bestNum = 4;
    for (let id = 0; id <= 3; id++) {
      const b = State.battler(st, id);
      if (truthy(b) && mod(id, 2) !== mod(aid, 2) && id !== mt && ad.abilityOf(b) === "LIGHTNING_ROD") {
        const n = Engine.turnOrderNum(st, id);
        if (n < bestNum) { best = id; bestNum = n; }
      }
    }
    if (best == null) {
      let t = mt;
      if (chosenRandom) t = random_foe_flank(st, ad, aid);
      return absent_fix(t);
    }
    State.battler(st, best).expLightningRodRedirected = true;
    return best;
  }
  if (truthy(st.double) && chosenRandom) {
    let t = random_foe_flank(st, ad, aid);
    if (!State.isPresent(st, t)) t = State.PARTNER(t);
    return t;
  }
  return absent_fix(mt);
};

// Lua: engine.lua:1232
// pokefirered/src/battle_util.c:361
Engine.moveLimitations = function (b: any, ad?: Ad | null): Record<number, boolean> {
  const bad: Record<number, boolean> = {};
  const mon = lor(tk(b, "mon"), {}) as any;
  const he = HeldItems.of(b)[0];
  const foe = truthy(ad) ? (ad as Ad).foeOf(b) : ad;
  for (let i = 1; i <= 4; i++) {
    const mv = truthy(mon.moves) ? mon.moves[i] : mon.moves;
    let n: any = null;
    if (mv != null && mv !== "" && mv !== 0) n = lor(move_num(mv), null);
    if (n == null || n === 0) {
      bad[i] = true;
    } else {
      if (tonumber(truthy(mon.pp) ? mon.pp[i] : mon.pp) === 0) bad[i] = true;
      if (truthy(b.expDisabledMove) && n === b.expDisabledMove) bad[i] = true;
      if (truthy(b.expTormented) && n === move_num(b.lastMoveId)) bad[i] = true;
      if (lor(b.expTauntedTurns, 0) > 0 && (tonumber(Moves.get(mv).power) ?? 0) === 0) bad[i] = true;
      if (truthy(ad) && truthy((ad as Ad)._st) && truthy((ad as Ad)._st.double)) {
        if (Engine.isImprisoned(ad, b, n)) bad[i] = true;
      } else if (truthy(foe) && truthy(foe.expImprison)) {
        const fm = lor(truthy(foe.mon) ? foe.mon.moves : foe.mon, {}) as any;
        for (let j = 1; j <= 4; j++) {
          if (truthy(fm[j]) && move_num(fm[j]) === n) bad[i] = true;
        }
      }
      if (lor(b.expEncoreTurns, 0) > 0 && truthy(b.expEncoreMove) && move_num(b.expEncoreMove) !== n) bad[i] = true;
      if (he === HeldItems.HOLD.CHOICE_BAND && truthy(b.choicedMove) && b.choicedMove !== n) bad[i] = true;
    }
  }
  return bad;
};

// Lua: engine.lua:1262
function player_identity(st: any): [any, any] {
  let id = st.playerTrainerId;
  let nm = lor(st.playerOtName, st.playerName);
  if (id == null) {
    // package.loaded["src.core.game3.runtime"]
    const R: any = Runtime;
    let ok: boolean;
    let sess: any;
    try {
      sess = (truthy(R) && truthy(R.getSession)) ? R.getSession() : null;
      ok = true;
    } catch (e) { ok = false; sess = e; }
    if (ok && truthy(sess)) {
      id = lor(lor(lor(sess.trainerId, sess.id), sess.playerId), 12345);
      nm = lor(lor(lor(sess.name, sess.playerName), nm), "RED");
    }
  }
  return [id, nm];
}

// Lua: engine.lua:1276
// pokefirered/src/pokemon.c:5965
Engine.isTradedMon = function (st: any, mon: any): boolean {
  if (!truthy(mon) || mon.otId == null) return false;
  const [pid, pname] = player_identity(lor(st, {}));
  if (pid == null) return false;
  return tonumber(mon.otId) !== tonumber(pid)
    || (mon.otName != null && pname != null && tostring(mon.otName) !== tostring(pname));
};

// Lua: engine.lua:1285
// src/battle_message.c:1180
const LOAF_TEXT: Tbl = seq(
  "STRINGID_PKMNLOAFING", "STRINGID_PKMNWONTOBEY",
  "STRINGID_PKMNTURNEDAWAY", "STRINGID_PKMNPRETENDNOTNOTICE",
);

// Lua: engine.lua:1291
// pokefirered/src/battle_util.c:3143
function disobedient(M: MoveCtx): [string | null, number?] {
  const ad = M.adapter, user = M.user, st = M.st;
  if (!truthy(st) || truthy(st.link) || truthy(st.pokedude) || !truthy(user) || user.side !== "player") return [null];
  // pokeemerald/src/battle_util.c:3922
  if (truthy(st.playerHalf) && idOf(user) === 2) return [null];
  const mon = lor(lor(State.partyMon(user), user.mon), {}) as any;
  const species = tonumber(user.species);
  let ob = 0;
  if (!((species === 151 || species === 410) && mon.fatefulEncounter === false)) {
    // pokeemerald/src/battle_util.c:3924
    if (BattleProfile.isRse(st) && Kinds.has(st, "frontier")) return [null];
    if (!Engine.isTradedMon(st, mon) || Engine.hasBadge(st, 8)) return [null];
    ob = 10;
    if (Engine.hasBadge(st, 2)) ob = 30;
    if (Engine.hasBadge(st, 4)) ob = 50;
    if (Engine.hasBadge(st, 6)) ob = 70;
  }
  const lvl: number = tonumber(tk(user.mon, "level")) ?? tonumber(mon.level) ?? 1;
  if (lvl <= ob) return [null];
  if (Math.floor((lvl + ob) * roll(ad, 0, 255) / 256) < ob) return [null];
  if (M.mnum === 99) user.rage = null;
  if (ad.status(user) === "SLP" && (M.mnum === MOVE_SNORE || M.mnum === MOVE_SLEEP_TALK)) {
    M.sayId("STRINGID_PKMNIGNORESASLEEP", { atk: user });
    return ["stop"];
  }
  if (Math.floor((lvl + ob) * roll(ad, 0, 255) / 256) < ob
      && (M.mnum !== 264 || !truthy(BattleProfile.rule(st, "obedienceFocusPunchExempt")))) {
    const bad = Engine.moveLimitations(user, ad);
    if (truthy(M.slot)) bad[M.slot] = true;
    if (bad[1] && bad[2] && bad[3] && bad[4]) {
      M.sayId(LOAF_TEXT[mod(roll(ad, 0, 3), 4) + 1], { atk: user });
      return ["stop"];
    }
    let slot: number;
    do { slot = mod(roll(ad, 0, 3), 4) + 1; } while (bad[slot]);
    M.sayId("STRINGID_PKMNIGNOREDORDERS", { atk: user });
    return ["called", slot];
  }
  const diff = lvl - ob;
  let r = roll(ad, 0, 255);
  const ab = ad.abilityOf(user);
  if (r < diff && !truthy(ad.status(user)) && ab !== "VITAL_SPIRIT" && ab !== "INSOMNIA" && !truthy(ad.uproarActive())) {
    M.sayId("STRINGID_PKMNBEGANTONAP", { atk: user });
    ad.applyStatus(user, "SLP", user, { force: true, ignoreSafeguard: true });
    ad.statusAnim(user, "SLP");
    M.sayId("STRINGID_PKMNFELLASLEEP", { eff: user });
    return ["stop"];
  }
  r = r - diff;
  if (r < diff) {
    M.sayId("STRINGID_PKMNWONTOBEY", { atk: user });
    Engine.cancelMultiTurnMoves(user);
    const dmg = Damage.base(user, user, { power: 40, type: 0, effect: 0 }, {
      power: 40, moveType: 0, adapter: ad,
    });
    Engine.selfHit(M, dmg);
    return ["stop"];
  }
  M.sayId(LOAF_TEXT[mod(roll(ad, 0, 3), 4) + 1], { atk: user });
  return ["stop"];
}
Engine.disobedient = disobedient;

// Lua: engine.lua:1355
// pokefirered/src/battle_script_commands.c:4121
Engine.moveEndEffects = function (M: MoveCtx): void {
  const ad = M.adapter, user = M.user, target = M.target;
  if (truthy(target) && target !== user) Abilities.synchronize(M, target, user);
  Abilities.onDamage(M);
  Abilities.immunityCure(ad);
  if (truthy(target) && target !== user) Abilities.synchronize(M, user, target);
  const chosenNum = move_num(lor(M.opts.calledBy, M.moveId));
  if (!truthy(M.notObeyed) && truthy(HeldItems.has(user, HeldItems.HOLD.CHOICE_BAND)) && chosenNum !== MOVE_STRUGGLE
      && !truthy(user.choicedMove)) {
    const cm = Moves.get(lor(M.opts.calledBy, M.moveId));
    if (!(tonumber(tk(cm, "effect")) === E.BATON_PASS && !truthy(M.failed))) {
      user.choicedMove = chosenNum;
    }
  }
  if (truthy(user.choicedMove)) {
    if (!truthy(H.slotOf(user, user.choicedMove))) user.choicedMove = null;
  }
  HeldItems.moveEnd(ad);
  HeldItems.kingsRockShellBell(M);
};

// Lua: engine.lua:1377
Engine.moveEndLite = function (M: MoveCtx): void {
  Abilities.immunityCure(M.adapter);
  HeldItems.moveEnd(M.adapter);
};

// Lua: engine.lua:1383
// pokefirered/src/battle_util.c:1208
Engine.afterAction = function (st: any, ad: Ad): void {
  if (!truthy(st) || truthy(st.over)) return;
  for (let n = 1; n <= 4; n++) {
    let did: any = false;
    if (!truthy(did)) did = Abilities.runIntimidate(ad);
    if (!truthy(did)) did = Abilities.runTrace(ad);
    for (const [, id] of ipairs(State.battlerOrder(st))) {
      const b = State.battler(st, id);
      if (truthy(b) && !ad.isFainted(b)) {
        if (truthy(HeldItems.normal(ad, b, true))) {
          did = true;
          break;
        }
      }
    }
    if (!truthy(did)) did = Abilities.forecast(ad);
    if (!truthy(did)) break;
  }
};

// Lua: engine.lua:1404
// pokefirered/src/battle_script_commands.c:4056
function move_end(M: MoveCtx): void {
  const ad = M.adapter, user = M.user, target = M.target;
  if (truthy(target) && target !== user && truthy(target.rage) && !ad.isFainted(target)
      && user.side !== target.side && !truthy(M.noEffect) && lor(M.hitsLanded, 0) > 0
      && (tonumber(M.move.power) ?? 0) > 0 && lor(target.stages.attack, 0) < 6) {
    target.stages.attack = target.stages.attack + 1;
    M.sayId("STRINGID_PKMNRAGEBUILDING", { def: target });
  }
  if (truthy(target) && target !== user && ad.status(target) === "FRZ" && !ad.isFainted(target)
      && truthy(lor(M.specialHit, false)) && !truthy(M.noEffect) && tonumber(lor(M.moveType, M.move.type)) === Types.ID.FIRE) {
    ad.clearStatus(target);
    M.sayId("STRINGID_PKMNWASDEFROSTED", { def: target });
  }
  Engine.moveEndEffects(M);
  const chosen = lor(M.opts.calledBy, M.moveId);
  const chosenMove = truthy(M.opts.calledBy) ? lor(Moves.get(M.opts.calledBy), M.move) : M.move;
  if (tonumber(chosenMove.effect) !== E.BATON_PASS) {
    user.lastMoveId = chosen;
    user.lastMove = chosen;
    user.expLastResulting = M.moveId;
  }
  if (truthy(M.printedUsed)) user.expLastPrinted = chosen;
  if (truthy(M.notObeyed)) {
    user.lastMoveId = null;
    user.lastMove = null;
  }
  if (truthy(target) && target !== user && !truthy(M.noEffect) && !truthy(M.anim.missed)
      && has_flag(chosenMove, FLAG_MIRROR_MOVE_AFFECTED) && !ad.isFainted(target)) {
    target.expLastTakenMove = chosen;
  }
  if (truthy(target) && target !== user && !truthy(M.noEffect) && !truthy(M.anim.missed) && lor(M.hitsLanded, 0) > 0) {
    target.expLastLandedMove = M.mnum;
    target.expLastHitByType = tonumber(lor(M.moveType, M.move.type));
  }
}

// Lua: engine.lua:1440
function run(M: MoveCtx): any {
  const ad = M.adapter, user = M.user;
  const eff = M.effect;

  if (!truthy(M.opts.called)) {
    user.expMovedThisTurn = true;
    const c = canceller(M);
    if (c === false) {
      M.anim.statusOnly = true;
      M.anim.cancelled = true;
      user.lastMoveId = null;
      user.lastMove = null;
      Engine.moveEndLite(M);
      return undefined;
    }
    if (c === "bide") {
      M.anim.statusOnly = false;
      bide_attack(M);
      move_end(M);
      return undefined;
    }
    if (c === "ghost") {
      M.anim.statusOnly = true;
      move_end(M);
      return undefined;
    }
    if (truthy(Abilities.soundproofBlocks(M))) {
      M.notObeyed = true;
      move_end(M);
      return undefined;
    }
    if (truthy(M.slot) && truthy(user.mon) && truthy(user.mon.pp) && tonumber(user.mon.pp[M.slot]) === 0
        && !truthy(user.expLockedMove) && M.mnum !== MOVE_STRUGGLE) {
      M.attackString();
      M.sayId("STRINGID_BUTNOPPLEFT");
      M.anim.statusOnly = true;
      return undefined;
    }
    if (!truthy(user.expLockedMove)) {
      const [d, slot] = disobedient(M);
      if (d === "stop") {
        M.anim.statusOnly = true;
        M.anim.cancelled = true;
        user.lastMoveId = null;
        user.lastMove = null;
        Engine.moveEndLite(M);
        return undefined;
      } else if (d === "called") {
        M.anim.statusOnly = true;
        return run_called(M, user.mon.moves[slot as number], { slot: slot });
      }
    }
  }

  if (eff !== E.PROTECT && eff !== E.ENDURE) {
    user.expProtectStreak = 0;
  }

  if (charge_turn(M)) {
    move_end(M);
    return undefined;
  }

  if (eff === E.METRONOME || eff === E.SLEEP_TALK || eff === E.MIRROR_MOVE || eff === E.ASSIST
      || eff === E.NATURE_POWER) {
    M.anim.statusOnly = true;
    return call_moves(M);
  }

  if (eff === E.FOCUS_PUNCH && (lor(user.lastPhysicalDamageTaken, 0) > 0 || lor(user.lastSpecialDamageTaken, 0) > 0)) {
    // pokefirered/data/battle_scripts_1.s:2255
    M.ppReduce();
    M.sayId("STRINGID_PKMNLOSTFOCUS", { atk: user });
    M.anim.statusOnly = true;
    return undefined;
  }

  // The rest of body() after Effects.runForMove returned `handled`.
  const afterEffects = (handled: any): void => {
    if (!truthy(handled)) {
      M.attackAnimation();
      M.sayId("STRINGID_BUTNOTHINGHAPPENED");
    }
    M.tryFaintTarget();
    M.tryFaintUser();
    move_end(M);
  };

  const body = (): void => {
    try_bounce(M);
    Engine.lightningRodTook(M);

    if (eff === E.OHKO) {
      ohko(M);
      move_end(M);
      return;
    }

    if (eff === E.BIDE) {
      // pokefirered/data/battle_scripts_1.s:575
      M.attackString();
      M.ppReduce();
      M.attackAnimation();
      user.bideTurns = 2;
      user.expBideDamage = 0;
      user.expBideTarget = null;
      user.expLockedMove = M.moveId;
      user.expLockedSlot = M.slot;
      M.anim.statusOnly = true;
      move_end(M);
      return;
    }

    const power = tonumber(M.move.power) ?? 0;
    if (power > 0) {
      Hit.run(M);
      move_end(M);
      return;
    }

    M.anim.statusOnly = true;
    M.attackString();
    M.ppReduce();
    let handled: any;
    try {
      handled = Effects.runForMove(ad, M.user, M.target, M.moveId, M);
    } catch (e) {
      // A yield can only come from inside a registered effect, after which
      // Effects.run returns true.
      if (e instanceof CoYield) e.conts.push(() => afterEffects(true));
      throw e;
    }
    afterEffects(handled);
  };

  return Engine.forEachTarget(M, body);
}

// Lua: engine.lua:1567
// pokefirered/src/battle_script_commands.c:888
Engine.lightningRodTook = function (M: MoveCtx): boolean {
  const t = M.target;
  if (!(truthy(t) && truthy(t.expLightningRodRedirected))) return false;
  t.expLightningRodRedirected = null;
  M.attackString();
  M.sayId("STRINGID_PKMNSXTOOKATTACK", { def: t, defAbility: Abilities.id("LIGHTNING_ROD") });
  return true;
};

// Lua: engine.lua:1577
// pokefirered/src/battle_script_commands.c:3469
Engine.resetTargetValues = function (M: MoveCtx): void {
  M.noEffect = null; M.missReason = null; M.failed = null; M.hitSubstitute = null;
  M.hpDealt = null; M.firstDmg = null; M.hitsLanded = null; M.targetDamaged = null; M.specialHit = null;
  M.dmgMultiplier = 1;
  M.ignoreOnAir = null; M.ignoreUnderground = null; M.ignoreUnderwater = null;
  M.brokeWall = null; M._animDmg = null; M._animPower = null;
  if (truthy(M.anim)) M.anim.missed = false;
};

// Lua: engine.lua:1586
function set_target(M: MoveCtx, b: any): void {
  M.target = b;
  M.tname = M.adapter.displayName(b);
  if (truthy(b)) b._statLoweredMsg = null;
}

// Lua: engine.lua:1593
// pokefirered/src/battle_script_commands.c:4308
Engine.forEachTarget = function (M: MoveCtx, body: (M: MoveCtx) => any): any {
  const st = M.st, ad = M.adapter;
  const ttype = tonumber(tk(M.move, "target")) ?? 0;
  M.targets = truthy(M.target) ? seq(idOf(M.target)) : seq();
  M.targetIndex = 1;
  if (!(truthy(st) && truthy(st.double)) || truthy(M.noSpread)) return body(M);
  if (ttype === MOVE_TARGET_FOES_AND_ALLY) {
    // pokefirered/src/battle_script_commands.c:8532
    const uid = idOf(M.user);
    const ids: Tbl = seq();
    for (const [, id] of ipairs(State.battlerOrder(st))) {
      if (id !== uid && State.isPresent(st, id)) ids[len(ids) + 1] = id;
    }
    if (len(ids) === 0) return body(M);
    M.targets = ids;
    M.deferUserFaint = (M.effect === E.EXPLOSION);
    let anyLanded = false;
    const finish = (): void => {
      M.anim.missed = !anyLanded;
      if (truthy(M.deferUserFaint)) {
        M.deferUserFaint = null;
        M.tryFaintUser();
      }
    };
    // `for i, id in ipairs(ids)`, resumable after a yield inside body.
    const loop = (from: number): void => {
      for (let i = from; ids[i] != null; i++) {
        const id = ids[i];
        if (i > 1) Engine.resetTargetValues(M);
        M.targetIndex = i;
        set_target(M, State.battler(st, id));
        try {
          body(M);
        } catch (e) {
          if (e instanceof CoYield) {
            e.conts.push(() => {
              if (!truthy(M.anim.missed)) anyLanded = true;
              if (truthy(M.stopTargets)) return finish();
              return loop(i + 1);
            });
          }
          throw e;
        }
        if (!truthy(M.anim.missed)) anyLanded = true;
        if (truthy(M.stopTargets)) break;
      }
      finish();
    };
    loop(1);
    return undefined;
  }
  if (ttype === MOVE_TARGET_BOTH) {
    const second = (firstMissed: any): void => {
      if (truthy(M.stopTargets) || !truthy(M.target)) return;
      const pid = State.PARTNER(idOf(M.target));
      const nb = State.battler(st, pid);
      if (truthy(nb) && State.isPresent(st, pid) && ad.hp(nb) > 0) {
        Engine.resetTargetValues(M);
        M.targets[2] = pid;
        M.targetIndex = 2;
        set_target(M, nb);
        try {
          body(M);
        } catch (e) {
          if (e instanceof CoYield) e.conts.push(() => { M.anim.missed = truthy(firstMissed) && truthy(M.anim.missed); });
          throw e;
        }
        M.anim.missed = truthy(firstMissed) && truthy(M.anim.missed);
      }
    };
    try {
      body(M);
    } catch (e) {
      if (e instanceof CoYield) e.conts.push(() => second(M.anim.missed));
      throw e;
    }
    second(M.anim.missed);
    return undefined;
  }
  return body(M);
};

// Lua: engine.lua:1646
/** Resolve a move. Returns message list.
 * Also fills out._anim (presentation meta for AnimSeq): moveId, user, target, */
Engine.resolveMove = function (user: any, target: any, moveId: any, slot: any, adapter: Ad, st: any, out?: Tbl, opts?: any): Tbl {
  const o: Tbl = lor(out, null) ?? seq();
  opts = lor(opts, {});
  const chosenTargetId = (target != null && typeof target !== "string") ? idOf(target) : null;
  if (truthy(st)) {
    user = State.occupant(st, user);
    target = State.occupant(st, target);
  }

  const nested = truthy(opts.called) && opts.anim != null;
  const prevSay = adapter._say;
  const mark = adapter.eventMark();
  if (!nested) {
    adapter._say = function (text: string): void { o[len(o) + 1] = text; };
  }

  const absentUser = truthy(st) && truthy(st.double) && truthy(user) && truthy(State.isAbsent(st, idOf(user)));
  if (!truthy(opts.called) && truthy(st) && (truthy(st.over) || absentUser)) {
    const anim0 = { moveId: moveId, user: user, target: target, hits: seq(), heals: seq(), faints: seq(),
      missed: false, statusOnly: true, msgs: seq(), events: seq() };
    o._anim = anim0;
    adapter._say = prevSay;
    return o;
  }

  const chosenMoveId = moveId;
  let retarget = false;
  let locked = false;
  if (!truthy(opts.called) && truthy(user)) {
    if (truthy(user.expLockedMove) && !truthy(opts.pursuitSwitch)) {
      moveId = user.expLockedMove;
      slot = user.expLockedSlot;
      locked = true;
      if (truthy(user.twoTurnTarget) && truthy(st) && truthy(State.occupant(st, user.twoTurnTarget))) {
        target = State.occupant(st, user.twoTurnTarget);
      }
    } else if (truthy(user.expEncoreMove) && lor(user.expEncoreTurns, 0) > 0) {
      const es: any = H.slotOf(user, user.expEncoreMove);
      if (truthy(es)) {
        if (move_num(user.mon.moves[es]) !== move_num(moveId)) retarget = true;
        moveId = user.mon.moves[es];
        slot = es;
      }
    }
  }
  // pokefirered/src/battle_main.c:3963
  if (truthy(st) && truthy(st.double) && truthy(user) && !truthy(opts.called) && !truthy(opts.pursuitSwitch)
      && !truthy(opts.noRetarget) && !absentUser) {
    for (let id = 0; id <= 3; id++) {
      const b = State.battler(st, id);
      if (truthy(b)) b.expLightningRodRedirected = null;
    }
    const uid = idOf(user);
    let tid = chosenTargetId;
    if (locked) {
      tid = lor(lor(truthy(st.moveTarget) ? st.moveTarget[uid] : null,
        truthy(user.twoTurnTarget) ? idOf(user.twoTurnTarget) : null), tid);
    }
    const rid = Engine.resolveTarget(st, adapter, user, moveId, tid, {
      recompute: retarget || tid == null, chosenMove: locked ? moveId : chosenMoveId,
    });
    target = lor(State.battler(st, rid), target);
  }

  const anim = lor(opts.anim, null) ?? {
    moveId: moveId,
    user: user,
    target: target,
    hits: seq(),
    heals: seq(),
    faints: seq(),
    missed: false,
    statusOnly: false,
  };
  if (nested) {
    anim.moveId = moveId;
    anim.target = target;
  }

  if (!truthy(opts.called)) Engine.refreshLinks(st);
  if (!truthy(opts.called) && truthy(st) && truthy(st._focusPunchSetup)) {
    const list = st._focusPunchSetup;
    st._focusPunchSetup = null;
    for (const [, b] of ipairs(list)) {
      if (!adapter.isFainted(b)) {
        adapter.playAnim("general", "FOCUS_PUNCH_SETUP", b, b);
        say_id(adapter, "STRINGID_PKMNTIGHTENINGFOCUS", { atk: b });
      }
    }
  }

  const M = new_ctx(user, target, moveId, slot, adapter, st, o, anim, opts);
  if (truthy(opts.called)) M.printedUsed = false;
  if (truthy(user)) user._statLoweredMsg = null;
  if (truthy(target)) target._statLoweredMsg = null;
  if (!truthy(opts.called)) adapter._syncEffect = null;
  if (nested || !(truthy(st) && truthy(st.interactiveChoices))) {
    try {
      run(M);
    } catch (e) {
      // A yield of an enclosing coroutine crossing this frame: keep its tail.
      if (e instanceof CoYield) {
        e.conts.push(() => {
          if (nested) return o;
          return Engine.finishResolve(adapter, st, o, anim, mark, prevSay, opts.called);
        });
      }
      throw e;
    }
  } else {
    const co: CoThread = { conts: null };
    const [ok, req] = coResume(co, () => run(M));
    if (!ok) throw req;
    if (co.conts != null) {
      st.pendingChoice = { co: co, req: req, M: M };
      return Engine.finishResolve(adapter, st, o, anim, mark, prevSay, true);
    }
  }

  if (nested) return o;
  return Engine.finishResolve(adapter, st, o, anim, mark, prevSay, opts.called);
};

// Lua: engine.lua:1758
Engine.finishResolve = function (adapter: Ad, st: any, out: Tbl, anim: any, mark: number, prevSay: any, skipAfter: any): Tbl {
  if (!truthy(skipAfter)) Engine.afterAction(st, adapter);

  anim.events = adapter.eventsSince(mark);
  anim.heals = seq();
  for (const [, ev] of ipairs(anim.events)) {
    if (ev.kind === "hp") {
      anim.heals[len(anim.heals) + 1] = { side: ev.side, from: ev.from, to: ev.to, maxHp: ev.maxHp };
    }
  }
  anim.msgs = seq();
  const n = len(out);
  for (let i = 1; i <= n; i++) anim.msgs[i] = out[i];
  out.events = anim.events;
  out._anim = anim;
  out.pendingChoice = (truthy(st) && truthy(st.pendingChoice)) ? lor(st.pendingChoice.req, null) : null;
  adapter._say = prevSay;
  return out;
};

// Lua: engine.lua:1778
// pokefirered/src/battle_script_commands.c:4626
Engine.resumeChoice = function (st: any, adapter: Ad, value: any): Tbl | null {
  const pend = truthy(st) ? st.pendingChoice : st;
  if (!truthy(pend)) return null;
  st.pendingChoice = null;
  const M = pend.M;
  const out: Tbl = seq();
  const anim = {
    moveId: M.moveId, user: M.user, target: M.target, hits: seq(), heals: seq(), faints: seq(),
    missed: false, statusOnly: true,
  };
  M.out = out;
  const prevSay = adapter._say;
  const mark = adapter.eventMark();
  adapter._say = function (text: string): void { out[len(out) + 1] = text; };
  const [ok, req] = coResume(pend.co, null, value);
  if (!ok) {
    adapter._say = prevSay;
    throw req;
  }
  if (pend.co.conts != null) {
    st.pendingChoice = { co: pend.co, req: req, M: M };
    return Engine.finishResolve(adapter, st, out, anim, mark, prevSay, true);
  }
  return Engine.finishResolve(adapter, st, out, anim, mark, prevSay, false);
};

// Lua: engine.lua:1805
// pokefirered/src/battle_ai_switch_items.c:428
Engine.mostSuitableMon = function (st: any, adapter: Ad, side: any): number | null {
  const id = (typeof side === "number") ? side : idOf(side);
  if (isTable(side)) side = side.side;
  if (typeof side !== "string") side = State.sideOf(id);
  const party = (side === "player") ? st.playerParty : st.foeParty;
  const active = State.battler(st, id);
  let opp = State.battler(st, State.OPPOSITE(id));
  const pending = lor(st.monToSwitchInto, {}) as any;
  if (truthy(pending[id])) return pending[id];
  let in2 = id;
  if (truthy(st.double)) {
    if (State.isPresent(st, State.PARTNER(id))) in2 = State.PARTNER(id);
    // pokefirered/src/battle_ai_switch_items.c:448
    let oid = mod(Math.floor(roll(adapter, 0, 65535) / 2), 2) * 2 + (1 - mod(id, 2));
    if (!State.isPresent(st, oid)) oid = State.PARTNER(oid);
    opp = State.battler(st, oid);
  }
  if (!truthy(party) || !truthy(opp)) return null;
  const activeIdx = tk(active, "partyIndex");
  const partner = State.battler(st, in2);
  const in2Idx = tk(partner, "partyIndex");
  const valid = (i: number, mon: any): boolean => {
    return truthy(mon) && !truthy(mon.isEgg) && (tonumber(mon.hp) ?? 0) > 0 && i !== activeIdx && i !== in2Idx
      && i !== pending[id] && i !== pending[in2]
      && (tonumber(lor(mon.species, mon.speciesId)) ?? 0) !== 0
      // pokeemerald/src/battle_ai_switch_items.c:671
      && ((st.foeHalf == null && st.playerHalf == null) || truthy(State.ownsSlot(st, id, i)));
  };
  // pokefirered/src/battle_ai_switch_items.c:404
  const modulate = (atk: any, d1: any, d2: any, v: number): number => {
    const t: any = Types.TABLE;
    const n = len(t);
    for (let i = 1; i <= n; i += 3) {
      if (t[i] !== -1 && t[i] === atk) {
        if (t[i + 1] === d1) v = Math.floor(v * t[i + 2] / 10);
        if (t[i + 1] === d2 && d1 !== d2) v = Math.floor(v * t[i + 2] / 10);
      }
    }
    return v;
  };
  const types_of = (mon: any): [any, any] => {
    const b = State.makeBattler(mon, side, {});
    return [b.type1, lor(b.type2, b.type1)];
  };
  const oT1 = opp.type1, oT2 = lor(opp.type2, opp.type1);
  const invalid: Record<number, boolean> = {};
  for (;;) {
    let bestDmg = 0, bestId: number | null = null;
    for (let i = 1; i <= 6; i++) {
      const mon = party[i];
      if (valid(i, mon) && !invalid[i]) {
        const [t1, t2] = types_of(mon);
        let v = modulate(oT1, t1, t2, 10);
        v = modulate(oT2, t1, t2, v);
        if (bestDmg < v) { bestDmg = v; bestId = i; }
      } else {
        invalid[i] = true;
      }
    }
    if (bestId == null) break;
    const mon = party[bestId];
    for (let j = 1; j <= 4; j++) {
      const mv = truthy(mon.moves) ? mon.moves[j] : mon.moves;
      const n = move_num(mv);
      if (n != null && n !== 0) {
        const [, flags] = Types.typeCalc(Moves.get(mv).type, opp.type1, opp.type2);
        if (truthy(flags.super)) return bestId;
      }
    }
    invalid[bestId] = true;
  }
  // pokefirered/src/battle_ai_switch_items.c:510
  let bestDmg = 0, bestId: number | null = null;
  for (let i = 1; i <= 6; i++) {
    const mon = party[i];
    if (valid(i, mon)) {
      for (let j = 1; j <= 4; j++) {
        const mv = truthy(mon.moves) ? mon.moves[j] : mon.moves;
        const n = move_num(mv);
        let dmg = 0;
        if (n != null && n !== 0) {
          const m = Moves.get(mv);
          if ((tonumber(m.power) ?? 0) !== 1) {
            const mt = tonumber(m.type) ?? 0;
            dmg = 2;
            if (truthy(active) && (active.type1 === mt || active.type2 === mt)) dmg = Math.floor(dmg * 15 / 10);
            const r: any = Types.typeCalc(mt, opp.type1, opp.type2, dmg)[0];
            dmg = truthy(r) ? r : 0;
          }
        }
        if (bestDmg < dmg) { bestDmg = dmg; bestId = i; }
      }
    }
  }
  return bestId;
};

// Lua: engine.lua:1901
// pokefirered/src/battle_main.c:4150
Engine.performEnemyItem = function (st: any, adapter: Ad, act: any): any {
  return BattleItems.enemyUse(st, adapter, act);
};

// Lua: engine.lua:1907
// pokefirered/src/battle_script_commands.c:4467
function switched_event(st: any, adapter: Ad, id: any, nb: any, old: any, opts: any): void {
  if (!ModRuntime.wants("battle.battler_switched")) return;
  const mon = tk(nb, "mon");
  const sp = truthy(mon) ? tonumber(lor(mon.species, mon.speciesId)) : mon;
  ModRuntime.emit("battle.battler_switched", {
    battle: st, side: truthy(adapter.ownSide) ? adapter.ownSide(nb) : adapter.ownSide, sideName: tk(nb, "side"), battler: nb,
    previous: old, battlerId: id, reason: tk(opts, "reason"),
    species: G3.speciesName(sp), speciesId: sp,
    partyIndex: tk(nb, "partyIndex"),
  });
}

// Lua: engine.lua:1919
Engine.performSwitch = function (st: any, adapter: Ad, side: any, slot: number, opts?: any): any {
  opts = lor(opts, {});
  const id = (typeof side === "number") ? side : idOf(side);
  side = State.sideOf(id);
  const old = State.battler(st, id);
  const party = (side === "player") ? st.playerParty : st.foeParty;
  if (!truthy(old) || !truthy(party) || !truthy(party[slot])) return null;
  const oldSlot = old.partyIndex;
  if (side === "player" && !truthy(st.double)) {
    if (!truthy(opts.isShift) && opts.reason !== "shift") {
      State.trackParticipant(st, st.enemy, lor(oldSlot, 1));
    }
  }
  Engine.switchOutEffects(st, adapter, old);
  State.syncBattlerToParty(old, party);
  const nb = State.makeBattler(party[slot], side, { partyIndex: slot, id: id, st: st });
  if (truthy(opts.batonPass)) {
    // pokefirered/src/battle_main.c:2350
    for (const [k, v] of pairs(lor(old.stages, {}))) nb.stages[k] = v;
    nb.confusionTurns = old.confusionTurns;
    nb.expFocusEnergy = old.expFocusEnergy;
    nb.focusEnergy = old.focusEnergy;
    nb.substituteHP = old.substituteHP;
    nb.expSeeded = old.expSeeded;
    nb.expSeedSource = old.expSeedSource;
    nb.expIngrain = old.expIngrain;
    nb.expPerishTurns = old.expPerishTurns;
    nb.expCursed = old.expCursed;
    nb.expTrapped = old.expTrapped;
    nb.escapePrevention = old.escapePrevention;
    nb.expLockedOn = old.expLockedOn;
    nb.expLockedOnBy = old.expLockedOnBy;
  }
  if (truthy(st.battlers)) st.battlers[id] = nb; else st[side] = nb;
  if (truthy(st.absent)) st.absent[id] = null;
  if (truthy(st.monToSwitchInto)) st.monToSwitchInto[id] = null;
  Engine.cancelPendingAction(st, id);
  if (truthy(st.double)) {
    // pokefirered/src/battle_script_commands.c:4966
    State.updateSentPokes(st, nb);
    for (let oid = 0; oid <= 3; oid++) {
      const b = State.battler(st, oid);
      if (truthy(b) && oid !== id) {
        if (b.expSeedSource === old) b.expSeedSource = nb;
        if (b.expTrapSource === old) {
          b.expTrapTurns = null; b.expTrapSource = null; b.wrapped = null;
        }
        if (b.expTrappedBy === old) {
          b.expTrapped = null; b.expTrappedBy = null; b.escapePrevention = null;
        }
        if (b.expInfatuatedWith === old) {
          b.expInfatuated = null; b.expInfatuatedWith = null; b.expInfatuatedBy = null;
        }
        if (b.expLockedOnById === id) { b.expLockedOn = null; b.expLockedOnById = null; b.expLockedOnBy = null; }
      }
    }
    adapter.pushEvent({ kind: "switch", side: side, battler: id, from: oldSlot, to: slot, reason: opts.reason });
    switched_event(st, adapter, id, nb, old, opts);
    return nb;
  }
  const foe = (side === "player") ? st.enemy : st.player;
  if (side === "player") {
    if (truthy(opts.isShift) || opts.reason === "shift") {
      // pokefirered/src/battle_script_commands.c:5945
      State.resetSentPokes(st);
    } else {
      State.trackParticipant(st, st.enemy, slot);
    }
  } else if (truthy(st.player)) {
    // pokefirered/src/battle_util.c:254
    State.opponentSwitchInResetSentPokes(st, nb);
  }
  if (truthy(foe)) {
    if (foe.expSeedSource === old) foe.expSeedSource = nb;
    if (foe.expTrapSource === old) {
      foe.expTrapTurns = null;
      foe.expTrapSource = null;
      foe.wrapped = null;
    }
    if (foe.expTrappedBy === old) {
      foe.expTrapped = null;
      foe.escapePrevention = null;
    }
    foe.expInfatuated = null;
    if (foe.expLockedOnBy === side) foe.expLockedOn = null;
  }
  adapter.pushEvent({ kind: "switch", side: side, battler: id, from: oldSlot, to: slot, reason: opts.reason });
  switched_event(st, adapter, id, nb, old, opts);
  return nb;
};

// Lua: engine.lua:2011
// pokefirered/src/battle_script_commands.c:5013
Engine.cancelPendingAction = function (st: any, id: any): void {
  for (const [, act] of ipairs(lor(tk(st, "turnActions"), seq()))) {
    if (act.battler === id && !truthy(act.done)) act.finished = true;
  }
};

// Lua: engine.lua:2017
Engine.actionRunnable = function (st: any, act: any): boolean {
  if (!truthy(act) || truthy(act.finished) || truthy(act.done)) return false;
  if (act.battler != null && truthy(State.isAbsent(st, act.battler))) return false;
  return true;
};

// Lua: engine.lua:2024
// pokefirered/src/battle_script_commands.c:9197
Engine.switchOutEffects = function (st: any, adapter: Ad, battler: any): any {
  if (!truthy(battler) || !truthy(adapter)) return false;
  return Abilities.switchOut(adapter, battler);
};

// Lua: engine.lua:2030
// pokefirered/src/battle_script_commands.c:4960
Engine.switchInEffects = function (st: any, adapter: Ad, battler: any, opts?: any): any {
  opts = lor(opts, {});
  if (!truthy(battler) || !truthy(adapter) || (truthy(st) && truthy(st.over))) return false;
  if (truthy(opts.spikes)) {
    const layers = Hazards.layers(adapter.ownSide(battler));
    if (layers > 0 && !adapter.hasType(battler, Types.ID.FLYING) && adapter.abilityOf(battler) !== "LEVITATE") {
      const denom = seq(8, 6, 4)[Math.min(layers, 3)] as number;
      const dmg = Math.max(1, Math.floor(adapter.maxHp(battler) / denom));
      adapter.applyHpLoss(battler, dmg);
      say_id(adapter, "STRINGID_PKMNHURTBYSPIKES", { scrActive: battler });
      if (adapter.isFainted(battler)) return true;
    }
  }
  if (adapter.isFainted(battler)) return false;
  if (adapter.abilityOf(battler) === "TRUANT") battler.expTruantCounter = 1;
  let did: any = Abilities.switchIn(adapter, battler);
  if (!truthy(did)) did = HeldItems.onSwitchIn(adapter, battler);
  if (!truthy(opts.deferIntimidate)) {
    for (let n = 1; n <= 4; n++) {
      if (!(truthy(Abilities.runIntimidate(adapter)) || truthy(Abilities.runTrace(adapter)))) break;
      did = true;
    }
  }
  return did;
};

// Lua: engine.lua:2058
// pokefirered/src/battle_main.c:2856
Engine.battleStartEffects = function (st: any, adapter: Ad): boolean {
  if (!truthy(st) || !truthy(adapter)) return false;
  let did = false;
  const w = Rules.weather.kind(st.overworldWeather);
  if (truthy(w) && !truthy(st._overworldWeatherDone)) {
    st._overworldWeatherDone = true;
    if (Rules.weather.kind(st.weather) !== w) {
      st.weather = w; st.weatherTurns = 0;
      // src/battle_message.c:1160
      say_id(adapter, (w === "SAND") ? "STRINGID_SANDSTORMISRAGING"
        : ((w === "SUN") ? "STRINGID_SUNLIGHTSTRONG" : "STRINGID_ITISRAINING"));
      adapter.playAnim("general", (w === "SAND") ? "SANDSTORM_CONTINUES" : ((w === "SUN") ? "SUN_CONTINUES"
        : "RAIN_CONTINUES"), st.player, st.player);
      did = true;
    }
  }
  const order = Residuals.sortedBattlers(adapter);
  // pokefirered/src/battle_util.c:1678
  if (!truthy(st.safari)) {
    for (const [, b] of ipairs(order)) {
      if (truthy(Abilities.switchIn(adapter, b))) did = true;
    }
    for (let n = 1; n <= 4; n++) {
      if (!(truthy(Abilities.runIntimidate(adapter)) || truthy(Abilities.runTrace(adapter)))) break;
      did = true;
    }
  }
  for (const [, b] of ipairs(order)) {
    if (truthy(HeldItems.onSwitchIn(adapter, b))) did = true;
  }
  return did;
};

// Lua: engine.lua:2092
// pokefirered/src/battle_main.c:3002
Engine.canRun = function (st: any, adapter: Ad, battler?: any): [boolean, any?] {
  battler = lor(battler, tk(st, "player"));
  if (!truthy(st) || !truthy(battler)) return [false, null];
  // pokeemerald/src/battle_util.c:407
  if (!truthy(st.wild) && (Kinds.has(st, "frontier") || Kinds.has(st, "trainerHill"))) return [true];
  // pokefirered/src/battle_main.c:3240
  if (truthy(st.link)) return [true];
  if (!truthy(st.wild)) return [false, State.text(st, "STRINGID_NORUNNINGFROMTRAINERS")];
  if (truthy(HeldItems.has(battler, HeldItems.HOLD.CAN_ALWAYS_RUN)) || adapter.abilityOf(battler) === "RUN_AWAY") {
    return [true];
  }
  const [holder, ab] = Abilities.escapeBlocker(adapter, battler);
  if (truthy(holder)) {
    return [false, State.text(st, "STRINGID_PREVENTSESCAPE", { scrActive: holder, scrActiveAbility: Abilities.id(ab) })];
  }
  if (truthy(battler.expTrapped) || truthy(battler.escapePrevention) || lor(battler.expTrapTurns, 0) > 0 || truthy(battler.expIngrain)) {
    return [false, State.text(st, "STRINGID_CANTESCAPE")];
  }
  if (Kinds.isBirchFirstBattle(st)) {
    // pokeemerald/src/battle_main.c:4078
    return [false, State.text(st, BattleProfile.of(st).firstBattle.cantRun)];
  }
  return [true];
};

// Lua: engine.lua:2118
// pokefirered/src/battle_main.c:3196
Engine.canSwitch = function (st: any, adapter: Ad, battler?: any): [boolean, string?] {
  battler = lor(battler, tk(st, "player"));
  if (!truthy(battler)) return [true];
  if (truthy(battler.expTrapped) || truthy(battler.escapePrevention) || lor(battler.expTrapTurns, 0) > 0 || truthy(battler.expIngrain)) {
    // src/party_menu.c:5964
    const name = lor((truthy(adapter) && truthy(adapter.displayName)) ? adapter.displayName(battler) : null, "POK\xC3\xA9MON");
    let ok: boolean;
    let txt: any;
    try { txt = RomText.ascii("gText_PkmnCantSwitchOut", { stringVars: seq(name) }); ok = true; } catch (e) { ok = false; txt = e; }
    if (ok && truthy(txt)) return [false, txt];
    return [false, name + " can't be switched out!"];
  }
  const [holder, ab] = Abilities.escapeBlocker(adapter, battler);
  if (truthy(holder)) {
    // src/pokemon.c:6029
    let ok: boolean;
    let txt: any;
    try {
      txt = State.text(st, "gText_PkmnsXPreventsSwitching", {
        buff1: State.prefixedName(st, holder), lastAbility: Abilities.id(ab),
      });
      ok = true;
    } catch (e) { ok = false; txt = e; }
    if (ok && truthy(txt)) return [false, txt];
    return [false, "Can't escape!"];
  }
  return [true];
};

// Lua: engine.lua:2141
// pokefirered/src/battle_main.c:4229
Engine.tryFlee = function (st: any, adapter: Ad, battler?: any): [boolean, string?] {
  battler = lor(battler, tk(st, "player"));
  if (!truthy(st.wild)) {
    say_id(adapter, "STRINGID_NORUNNINGFROMTRAINERS");
    return [false];
  }
  const foe = adapter.foeOf(battler);
  if (truthy(HeldItems.has(battler, HeldItems.HOLD.CAN_ALWAYS_RUN))) {
    adapter.playAnim("general", "SMOKEBALL_ESCAPE", battler, battler);
    say_id(adapter, "STRINGID_PKMNFLEDUSINGITS", { atk: battler, lastItem: HeldItems.itemOf(battler) });
    return [true, "item"];
  }
  if (adapter.abilityOf(battler) === "RUN_AWAY") {
    say_id(adapter, "STRINGID_PKMNFLEDUSING", { atk: battler, atkAbility: Abilities.id("RUN_AWAY") });
    return [true, "ability"];
  }
  if (truthy(st.ghostBattle) && battler.side === "player") {
    say_id(adapter, "STRINGID_GOTAWAYSAFELY");
    return [true];
  }
  let ok = false;
  const mySpe: number = tonumber(tk(battler.mon, "speed")) ?? 0;
  const foeSpe: number = tonumber(truthy(foe) ? tk(foe.mon, "speed") : foe) ?? 0;
  const vanilla_run = (pSpd: number, eSpd: number): boolean => {
    if (truthy(st.double)) {
      // pokefirered/src/battle_main.c:4259
      return false;
    } else if (truthy(st.pyramid)) {
      // pokeemerald/src/battle_util.c:432
      throw new Error("NOT FAITHFUL: Emerald only (rse.frontier.pyramid run multiplier)");
    } else if (pSpd < eSpd) {
      const speedVar = mod(Math.floor(pSpd * 128 / Math.max(1, eSpd)) + lor(st.fleeAttempts, 0) * 30, 256);
      return speedVar > roll(adapter, 0, 255);
    }
    return true;
  };
  if (ModRuntime.wantsHook("battle.run")) {
    ok = truthy(ModRuntime.call("battle.run", function (c: any) {
      return vanilla_run(c.pSpd, c.eSpd);
    }, { battle: st, pSpd: mySpe, eSpd: foeSpe, attempts: lor(st.fleeAttempts, 0),
      rng: adapter.rng(), battler: battler })) ? true : false;
  } else {
    ok = vanilla_run(mySpe, foeSpe);
  }
  st.fleeAttempts = lor(st.fleeAttempts, 0) + 1;
  if (ok) {
    say_id(adapter, "STRINGID_GOTAWAYSAFELY");
    return [true];
  }
  battler.expDestinyBond = null; battler.destinyBond = null; battler.expGrudge = null; battler.expFuryCutter = 0;
  say_id(adapter, "STRINGID_CANTESCAPE2");
  return [false];
};

// Lua: engine.lua:2200
// pokefirered/src/battle_script_commands.c:4536
Engine.switchCandidates = function (st: any, side: any): Tbl {
  const id = (typeof side === "number") ? side : idOf(side);
  if (typeof side !== "string") side = State.sideOf(id);
  const party = (side === "player") ? st.playerParty : st.foeParty;
  const excl: Record<number, boolean> = {};
  const ids = truthy(st.double) ? lor(State.positionsOnSide(side), seq(id)) : seq(id);
  for (const [, bid] of ipairs(ids)) {
    const b = State.battler(st, bid);
    if (truthy(b) && truthy(b.partyIndex)) excl[b.partyIndex] = true;
    const pend = truthy(st.monToSwitchInto) ? st.monToSwitchInto[bid] : st.monToSwitchInto;
    if (truthy(pend) && bid !== id) excl[pend] = true;
  }
  const out: Tbl = seq();
  for (const [i, mon] of ipairs(lor(party, seq()))) {
    // pokefirered/src/battle_script_commands.c:6919
    if (!excl[i] && truthy(mon) && (tonumber(mon.hp) ?? 0) > 0 && !truthy(mon.isEgg)
        && (id == null || truthy(State.ownsSlot(st, id, i)))) {
      out[len(out) + 1] = i;
    }
  }
  return out;
};

// Lua: engine.lua:2224
// pokefirered/src/party_menu.c:5916
Engine.replacementCandidates = function (st: any, id: any): Tbl {
  const side = State.sideOf(id);
  const party = (side === "player") ? st.playerParty : st.foeParty;
  const excl: Record<number, boolean> = {};
  for (const [, bid] of ipairs(truthy(st.double) ? lor(State.positionsOnSide(side), seq(id)) : seq(id))) {
    const b = State.battler(st, bid);
    if (truthy(b) && truthy(b.partyIndex)) excl[b.partyIndex] = true;
    const pend = truthy(st.monToSwitchInto) ? st.monToSwitchInto[bid] : st.monToSwitchInto;
    if (truthy(pend)) excl[pend] = true;
  }
  const out: Tbl = seq();
  for (const [i, mon] of ipairs(lor(party, seq()))) {
    if (!excl[i] && truthy(mon) && !truthy(mon.isEgg) && (tonumber(mon.hp) ?? 0) > 0
        && (tonumber(lor(mon.species, mon.speciesId)) ?? 0) !== 0 && truthy(State.ownsSlot(st, id, i))) {
      out[len(out) + 1] = i;
    }
  }
  return out;
};

// Lua: engine.lua:2244
Engine.faintedBattlers = function (st: any): Tbl {
  const out: Tbl = seq();
  for (const [, id] of ipairs(State.battlerOrder(st))) {
    const b = State.battler(st, id);
    if (truthy(b) && !truthy(State.isAbsent(st, id)) && State.isFainted(b)) out[len(out) + 1] = id;
  }
  return out;
};

// Lua: engine.lua:2254
// pokefirered/src/battle_script_commands.c:4870
Engine.markAbsent = function (st: any, id: any): void {
  st.absent = lor(st.absent, {});
  st.absent[id] = true;
  Engine.cancelPendingAction(st, id);
};

// Lua: engine.lua:2261
// pokefirered/src/battle_util.c:1156
Engine.refreshAbsent = function (st: any): Tbl {
  const back: Tbl = seq();
  if (!(truthy(st) && truthy(st.double) && truthy(st.absent))) return back;
  for (const [, id] of ipairs(State.battlerOrder(st))) {
    if (truthy(st.absent[id]) && truthy(State.battler(st, id)) && len(Engine.replacementCandidates(st, id)) > 0) {
      st.absent[id] = null;
      back[len(back) + 1] = id;
    }
  }
  return back;
};

// Lua: engine.lua:2274
// pokefirered/src/battle_util.c:1144
Engine.pendingReplacements = function (st: any): Tbl {
  const out: Tbl = seq();
  for (const [, id] of ipairs(Engine.faintedBattlers(st))) {
    const cands = Engine.replacementCandidates(st, id);
    out[len(out) + 1] = { battler: id, side: State.sideOf(id), candidates: cands, noMons: len(cands) === 0 };
  }
  return out;
};

// Lua: engine.lua:2284
// pokefirered/src/battle_script_commands.c:3113
Engine.expAwardOrder = function (st: any): Tbl {
  const out: Tbl = seq();
  for (const [, id] of ipairs(Engine.faintedBattlers(st))) {
    if (State.sideOf(id) === "enemy") out[len(out) + 1] = id;
  }
  return out;
};

// Lua: engine.lua:2292
function is_chosen_map(t: any): boolean {
  if (!isTable(t) || t.kind != null) return false;
  for (let id = 0; id <= 3; id++) {
    if (t[id] != null) return true;
  }
  return isEmpty(t);
}

// Lua: engine.lua:2300
function forced_move(b: any, mv: any, slot: any): [any, any] {
  if (!truthy(b)) return [mv, slot];
  if (truthy(b.expLockedMove)) return [b.expLockedMove, slot];
  if (truthy(b.expEncoreMove) && lor(b.expEncoreTurns, 0) > 0) return [b.expEncoreMove, slot];
  if (truthy(b.choicedMove) && truthy(HeldItems.has(b, HeldItems.HOLD.CHOICE_BAND)) && move_num(mv) !== b.choicedMove
      && move_num(mv) !== MOVE_STRUGGLE) {
    const cs: any = H.slotOf(b, b.choicedMove);
    if (truthy(cs) && (tonumber(truthy(b.mon.pp) ? b.mon.pp[cs] : b.mon.pp) ?? 1) > 0) return [b.mon.moves[cs], cs];
  }
  return [mv, slot];
}

// Lua: engine.lua:2313
function is_meta_first(kind: any): boolean { return kind === "bag" || kind === "switch" || kind === "item"; }

// Lua: engine.lua:2315
function order_hook(st: any, adapter: Ad, a: any, aMove: any, b: any, bMove: any, vanilla: () => any): boolean {
  return truthy(ModRuntime.call("battle.turn_order", function () {
    return vanilla();
  }, a, truthy(aMove) ? lor(G3.moveView(aMove), null) : null, b, truthy(bMove) ? lor(G3.moveView(bMove), null) : null,
  { battle: st, rng: adapter.rng(), playerMove: truthy(aMove) ? G3.moveName(move_num(aMove)) : aMove,
    enemyMove: truthy(bMove) ? G3.moveName(move_num(bMove)) : bMove,
    firstId: idOf(a), secondId: idOf(b) })) ? true : false;
}

/** Lua `kind == "move" and Moves.priority(move) or 0`. */
function row_priority(r: any): number {
  if (r.kind !== "move") return 0;
  return lor(Moves.priority(r.move), 0);
}

// Lua: engine.lua:2326
// pokefirered/src/battle_main.c:3532
Engine.planTurnActions = function (st: any, adapter: Ad, chosen?: any): [Tbl, null] {
  chosen = lor(chosen, {});
  st.chosen = chosen;
  st.monToSwitchInto = lor(st.monToSwitchInto, {});
  for (let id = 0; id <= 3; id++) clear_turn_flags(State.battler(st, id));
  Engine.refreshLinks(st);
  if (truthy(st.playerSide)) { st.playerSide.expFollowMe = null; st.playerSide.expFollowMeId = null; }
  if (truthy(st.enemySide)) { st.enemySide.expFollowMe = null; st.enemySide.expFollowMeId = null; }
  const rows: Record<number, any> = {};
  for (let id = 0; id <= 3; id++) {
    const act = chosen[id];
    const b = State.battler(st, id);
    if (truthy(b) && truthy(State.isAbsent(st, id))) {
      // pokefirered/src/battle_main.c:3115
      rows[id] = { battler: id, user: b, kind: "nothing", finished: true };
    } else if (truthy(act) && truthy(b)) {
      const row: Record<string, any> = {};
      for (const [k, v] of pairs(act)) row[k] = v;
      row.battler = id;
      row.user = b;
      row.kind = lor(act.kind, "move");
      if (row.kind === "move") {
        [row.move, row.slot] = forced_move(b, act.move, act.slot);
        const mv = Moves.get(row.move);
        row.targetType = tonumber(tk(mv, "target")) ?? 0;
      }
      rows[id] = row;
    }
  }
  // pokefirered/src/battle_util.c:1223
  for (const [, row] of pairs(rows)) {
    const b = row.user;
    const mv = lor(b.expLockedMove, (row.kind === "move" && truthy(row.move)) ? row.move : null);
    if (truthy(b.rage) && move_num(mv) !== 99) b.rage = null;
  }
  const order: Tbl = seq();
  let sortable = 0;
  // pokefirered/src/battle_controllers.c:163 the non-master owns the odd battler ids
  const ids = State.battlerOrder(st);
  if (truthy(rows[0]) && rows[0].kind === "run") {
    order[1] = 0;
    for (let id = 1; id <= 3; id++) if (truthy(rows[id])) order[len(order) + 1] = id;
  } else {
    for (const [, id] of ipairs(ids)) {
      if (truthy(rows[id]) && is_meta_first(rows[id].kind)) order[len(order) + 1] = id;
    }
    for (const [, id] of ipairs(ids)) {
      if (truthy(rows[id]) && !is_meta_first(rows[id].kind)) {
        order[len(order) + 1] = id;
        sortable = sortable + 1;
      }
    }
  }
  if (sortable >= 2) {
    // pokefirered/src/battle_main.c:2926
    st.randomTurnNumber = roll(adapter, 0, 0xFFFF);
    const n = len(order);
    for (let i = 1; i <= n - 1; i++) {
      for (let j = i + 1; j <= n; j++) {
        const r1 = rows[order[i]], r2 = rows[order[j]];
        if (!is_meta_first(r1.kind) && !is_meta_first(r2.kind)) {
          const p1 = row_priority(r1);
          const p2 = row_priority(r2);
          const s1 = speed_of(r1.user, st, adapter);
          const s2 = speed_of(r2.user, st, adapter);
          const vanilla_swap = (): boolean => {
            // pokefirered/src/battle_main.c:3505
            if (p1 !== p2) {
              return p1 < p2;
            } else if (s1 === s2) {
              return roll(adapter, 0, 1) === 1;
            }
            return s1 < s2;
          };
          let swap: boolean;
          if (ModRuntime.wantsHook("battle.turn_order")) {
            swap = !order_hook(st, adapter, r1.user, r1.kind === "move" ? r1.move : null,
              r2.user, r2.kind === "move" ? r2.move : null,
              function () { return !vanilla_swap(); });
          } else {
            swap = vanilla_swap();
          }
          if (swap) { const t = order[i]; order[i] = order[j]; order[j] = t; }
        }
      }
    }
  }
  // pokefirered/src/battle_main.c:3669
  const focus: Tbl = seq();
  for (let id = 0; id <= 3; id++) {
    const row = rows[id];
    if (truthy(row) && row.kind === "move") {
      const mv = Moves.get(row.move);
      if (tonumber(tk(mv, "effect")) === E.FOCUS_PUNCH && !truthy(row.user.expLockedMove)
          && !adapter.hasStatus(row.user, "SLP")) {
        focus[len(focus) + 1] = row.user;
      }
    }
  }
  st._focusPunchSetup = (len(focus) > 0) ? focus : null;
  const actions: Tbl = seq();
  for (const [i, id] of ipairs(order)) {
    rows[id].user.expTurnOrder = i;
    actions[i] = rows[id];
  }
  st.turnOrder = order;
  st.turnActions = actions;
  return [actions, null];
};

// Lua: engine.lua:2435
Engine.planTurnFromActions = function (st: any, adapter: Ad, playerAct: any, enemyAct: any): [Tbl, any] {
  if (is_chosen_map(playerAct) && enemyAct == null) {
    return Engine.planTurnActions(st, adapter, playerAct);
  }
  if (truthy(st) && truthy(st.double)) {
    return Engine.planTurnActions(st, adapter, {
      0: lor(playerAct, null) ?? Commands.playerAction(st, 1, 1),
      1: lor(enemyAct, null) ?? Commands.enemyAction(st, 1),
    });
  }
  playerAct = lor(playerAct, null) ?? Commands.playerAction(st, 1, 1);
  enemyAct = lor(enemyAct, null) ?? Commands.enemyAction(st);

  clear_turn_flags(st.player);
  clear_turn_flags(st.enemy);
  Engine.refreshLinks(st);
  if (truthy(st.playerSide)) st.playerSide.expFollowMe = null;
  if (truthy(st.enemySide)) st.enemySide.expFollowMe = null;

  // pokefirered/src/battle_util.c:1223
  const chosen = (b: any, act: any): any => {
    if (!truthy(b)) return null;
    if (truthy(b.expLockedMove)) return b.expLockedMove;
    return (truthy(act) && act.kind === "move" && truthy(act.move)) ? act.move : null;
  };
  const pChosen = chosen(st.player, playerAct);
  const eChosen = chosen(st.enemy, enemyAct);
  if (truthy(st.player) && truthy(st.player.rage) && move_num(pChosen) !== 99) st.player.rage = null;
  if (truthy(st.enemy) && truthy(st.enemy.rage) && move_num(eChosen) !== 99) st.enemy.rage = null;

  const actions: Tbl = seq();
  const enemyMeta = enemyAct.kind === "switch" || enemyAct.kind === "item";
  const enemy_meta_row = (): any => {
    const row: Record<string, any> = {};
    for (const [k, v] of pairs(enemyAct)) row[k] = v;
    row.user = st.enemy; row.battler = 1;
    return row;
  };
  // pokefirered/src/battle_main.c:3537
  if (truthy(st.safari)) {
    if (truthy(st.player)) st.player.expTurnOrder = 1;
    if (truthy(st.enemy)) st.enemy.expTurnOrder = 2;
    // pokefirered/src/battle_controller_opponent.c:1364
    actions[len(actions) + 1] = {
      user: st.enemy, battler: 1,
      kind: (enemyAct.kind === "run") ? "run" : "watch",
    };
    st.turnOrder = seq(0, 1);
    st.turnActions = actions;
    return [actions, playerAct];
  }
  const forced = (b: any, mv: any, slot: any): [any, any] => {
    if (!truthy(b)) return [mv, slot];
    if (truthy(b.expLockedMove)) return [b.expLockedMove, slot];
    if (truthy(b.expEncoreMove) && lor(b.expEncoreTurns, 0) > 0) return [b.expEncoreMove, slot];
    if (truthy(b.choicedMove) && truthy(HeldItems.has(b, HeldItems.HOLD.CHOICE_BAND)) && move_num(mv) !== b.choicedMove
        && move_num(mv) !== MOVE_STRUGGLE) {
      const cs: any = H.slotOf(b, b.choicedMove);
      if (truthy(cs) && (tonumber(truthy(b.mon.pp) ? b.mon.pp[cs] : b.mon.pp) ?? 1) > 0) return [b.mon.moves[cs], cs];
    }
    return [mv, slot];
  };

  if (playerAct.kind === "run" || playerAct.kind === "bag" || playerAct.kind === "switch") {
    if (truthy(st.player)) st.player.expTurnOrder = 1;
    if (enemyMeta) {
      // pokefirered/src/battle_main.c:3586
      if (truthy(st.enemy)) st.enemy.expTurnOrder = 2;
      actions[len(actions) + 1] = enemy_meta_row();
    } else if (enemyAct.kind === "move") {
      if (truthy(st.enemy)) st.enemy.expTurnOrder = 2;
      const [eMove, eSlot] = forced(st.enemy, enemyAct.move, enemyAct.slot);
      actions[len(actions) + 1] = {
        user: st.enemy, target: st.player,
        move: eMove, slot: eSlot,
        battler: 1, kind: "move",
      };
    } else {
      if (truthy(st.enemy)) st.enemy.expTurnOrder = 2;
      actions[len(actions) + 1] = enemy_meta_row();
    }
    st.turnOrder = seq(0, 1);
    st.turnActions = actions;
    return [actions, playerAct];
  }

  let pMove = playerAct.move, pSlot = playerAct.slot;
  if (enemyMeta) {
    // pokefirered/src/battle_main.c:3586
    [pMove, pSlot] = forced(st.player, pMove, pSlot);
    if (truthy(st.enemy)) st.enemy.expTurnOrder = 1;
    if (truthy(st.player)) st.player.expTurnOrder = 2;
    actions[1] = enemy_meta_row();
    if (truthy(pMove)) {
      actions[2] = { user: st.player, target: st.enemy, move: pMove, slot: pSlot, battler: 0, kind: "move" };
      const mv = Moves.get(pMove);
      st._focusPunchSetup = null;
      if (tonumber(tk(mv, "effect")) === E.FOCUS_PUNCH && !truthy(st.player.expLockedMove)
          && !adapter.hasStatus(st.player, "SLP")) {
        st._focusPunchSetup = seq(st.player);
      }
    }
    st.turnOrder = seq(1, 0);
    st.turnActions = actions;
    return [actions, null];
  }

  let eMove = enemyAct.move, eSlot = enemyAct.slot;
  [pMove, pSlot] = forced(st.player, pMove, pSlot);
  if (truthy(eMove)) [eMove, eSlot] = forced(st.enemy, eMove, eSlot);
  // pokefirered/src/battle_main.c:2926
  st.randomTurnNumber = roll(adapter, 0, 0xFFFF);
  const pPri = Moves.priority(pMove);
  const ePri = Moves.priority(eMove);
  const pSpe = speed_of(st.player, st, adapter);
  const eSpe = speed_of(st.enemy, st, adapter);
  // pokefirered/src/battle_main.c:3400
  const vanilla_first = (): boolean => {
    if (pPri !== ePri) {
      return pPri > ePri;
    } else if (pSpe !== eSpe) {
      return pSpe > eSpe;
    }
    // pokefirered/src/battle_controllers.c:163 the non-master reads battler1/battler2 swapped
    return (roll(adapter, 0, 1) === 1) === link_seat_swap(st);
  };
  let playerFirst: boolean;
  if (ModRuntime.wantsHook("battle.turn_order")) {
    playerFirst = order_hook(st, adapter, st.player, pMove, st.enemy, eMove, vanilla_first);
  } else {
    playerFirst = vanilla_first();
  }
  // pokefirered/src/battle_main.c:3682
  const focus: Tbl = seq();
  for (const [, row] of ipairs(seq(seq(st.player, pMove), seq(st.enemy, eMove)))) {
    if (truthy(row[2])) {
      let okM: boolean;
      let mv: any;
      try { mv = Moves.get(row[2]); okM = true; } catch (e) { okM = false; mv = e; }
      if (okM && truthy(mv) && tonumber(mv.effect) === E.FOCUS_PUNCH && !truthy(row[1].expLockedMove)
          && !adapter.hasStatus(row[1], "SLP")) {
        focus[len(focus) + 1] = row[1];
      }
    }
  }
  st._focusPunchSetup = (len(focus) > 0) ? focus : null;

  const enemy_turn_action = (): any => {
    if (enemyAct.kind === "move") {
      return { user: st.enemy, target: st.player, move: eMove, slot: eSlot, battler: 1, kind: "move" };
    } else {
      return enemy_meta_row();
    }
  };

  const player_turn_action = (): any => {
    return { user: st.player, target: st.enemy, move: pMove, slot: pSlot, battler: 0, kind: "move" };
  };

  if (playerFirst) {
    st.player.expTurnOrder = 1; st.enemy.expTurnOrder = 2;
    actions[len(actions) + 1] = player_turn_action();
    actions[len(actions) + 1] = enemy_turn_action();
    st.turnOrder = seq(0, 1);
  } else {
    st.player.expTurnOrder = 2; st.enemy.expTurnOrder = 1;
    actions[len(actions) + 1] = enemy_turn_action();
    actions[len(actions) + 1] = player_turn_action();
    st.turnOrder = seq(1, 0);
  }
  st.turnActions = actions;
  return [actions, null];
};

// Lua: engine.lua:2608
Engine.planTurn = function (st: any, adapter: Ad): [Tbl, any] {
  return Engine.planTurnFromActions(st, adapter, null, null);
};

// Lua: engine.lua:2612
Engine.collectResidualEvents = function (_st: any, adapter: Ad): any {
  if (handlersPending) registerHandlers();
  return Residuals.collectEvents(adapter);
};

// Lua: engine.lua:2618
// pokeemerald/src/battle_script_commands.c:3556
// pokefirered/src/battle_script_commands.c:3395
function mon_can_battle(mon: any): boolean {
  if (!truthy(mon) || (tonumber(mon.hp) ?? 0) <= 0) return false;
  if (Pokemon.isEgg(mon)) return false;
  return true;
}

// Lua: engine.lua:2624
Engine.hasLivingMons = function (party: any): boolean {
  if (!truthy(party)) return false;
  for (const [, mon] of ipairs(party)) {
    if (mon_can_battle(mon)) return true;
  }
  return false;
};

// Lua: engine.lua:2632
Engine.nextLivingMonIndex = function (party: any, currentIdx: any): number | null {
  if (!truthy(party)) return null;
  for (const [i, mon] of ipairs(party)) {
    if (i !== currentIdx && mon_can_battle(mon)) return i;
  }
  return null;
};

// Lua: engine.lua:2640
Engine.isPursuit = function (move: any): boolean {
  if (!truthy(move)) return false;
  if (typeof move === "string" && move.toUpperCase() === "PURSUIT") return true;
  if (typeof move === "number" && move === 228) return true;
  if (isTable(move) && (move.id === 228 || move.effect === 128 || (truthy(move.name) && move.name.toUpperCase() === "PURSUIT"))) {
    return true;
  }
  return false;
};

// Lua: engine.lua:2650
Engine.checkEnd = function (st: any, _adapter?: Ad): any {
  if (!truthy(st)) return null;
  if (truthy(st.over)) return st.result;

  if (truthy(st.player) && truthy(st.playerParty)) {
    State.syncBattlerToParty(st.player, st.playerParty);
  }
  if (truthy(st.enemy) && truthy(st.foeParty)) {
    State.syncBattlerToParty(st.enemy, st.foeParty);
  }
  if (truthy(st.double)) {
    const b2 = State.battler(st, 2), b3 = State.battler(st, 3);
    if (truthy(b2) && truthy(st.playerParty)) State.syncBattlerToParty(b2, st.playerParty);
    if (truthy(b3) && truthy(st.foeParty)) State.syncBattlerToParty(b3, st.foeParty);
  }

  let playerAlive: boolean;
  if (truthy(st.playerHalf)) {
    // pokeemerald/src/battle_script_commands.c:3543
    const own: Tbl = seq();
    const n = Math.min(st.playerHalf, len(lor(st.playerParty, seq())));
    for (let i = 1; i <= n; i++) own[i] = st.playerParty[i];
    playerAlive = Engine.hasLivingMons(own);
  } else {
    playerAlive = Engine.hasLivingMons(st.playerParty);
  }
  if (!playerAlive) {
    st.over = true;
    // pokefirered/src/battle_script_commands.c:3413
    st.result = (truthy(st.link) && !Engine.hasLivingMons(st.foeParty)) ? "draw" : "lose";
    return st.result;
  }

  const foeAlive = Engine.hasLivingMons(st.foeParty);
  if (!foeAlive) {
    st.over = true;
    st.result = "win";
    return "win";
  }

  return null;
};

export default Engine;
