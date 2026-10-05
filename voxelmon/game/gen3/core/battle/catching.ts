// Port of gen1recomp src/core/game3/battle/catching.lua (GPLv3 + additional terms; see LICENSE.md).
// Gen 3 catch mechanics (pret pokeball.c / battle_script_commands.c).
//
// Pure functions for catch calculations, ball multipliers, shake factor math,
// and caught Pokémon persistence into party or PC storage.
//
// Emits battle.ball_thrown and pokemon.caught; the roll is hooked as catch.rate.
//
// Port notes:
// - Lazy requires (rules, link_guard, Gen3Compat, storage, map_sections_extract,
//   rng) and `package.loaded` / `pcall(require)` probes of runtime / battle.init
//   are static imports, used exactly as Brian guards them.
// - Multiple returns are 0-based tuples: tryCatch -> [caught, shakes];
//   the local vanilla_catch too. Storage.findOpenSlot / depositCaught are
//   tuples in the storage port.
// - roll_rng: a table rng's `rng.random(rng, lo, hi)` is called as the
//   TS method `rng.random(lo, hi)` (colon methods take `this`, as everywhere
//   in the port). A function rng is called `rng(lo, hi)` as in Lua.
// - The Wally tutorial check in tryCatch is kept (st.kinds.tutorial is never
//   "wally" in FRLG; it is plain data, so no NOT FAITHFUL is needed).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tonumber, tostring, truthy, mod as lmod } from "../../../../import/gen3/lua.ts";
import { seq, len, pairs, type LuaTable } from "../../platform/lt.ts";
import { random as mathRandom } from "../../platform/rng.ts";
import ItemsData from "../items_data.ts";
import Pokemon from "../pokemon.ts";
import Types from "./types.ts";
import Dex from "../dex.ts";
import ModRuntime from "../../shared/mods/Runtime.ts";
import G3 from "../../shared/mods/Gen3Compat.ts";
import LinkGuard from "./link_guard.ts";
import Rules from "./rules.ts";
import Runtime from "../runtime.ts";
import { Battle as BattleInit } from "./init.ts";
import Storage from "../storage.ts";
import MapSectionsExtract from "../../../../import/gen3/map_sections_extract.ts";
import Rng from "../rng.ts";

/** Lua `a or b` (b already evaluated). */
function lor<A, B>(a: A, b: B): A | B {
  return truthy(a) ? a : b;
}

/** Lua `a and b` (b already evaluated). */
function land<A, B>(a: A, b: B): A | B {
  return truthy(a) ? b : a;
}

/** Lua `type(v) == "table"`. */
function isTable(v: unknown): v is Record<string | number, any> {
  return v !== null && typeof v === "object";
}

/** `ItemsData.toNumericId(id) or tonumber(id) or 4` */
function ball_num(itemId: any): number {
  return ItemsData.toNumericId(itemId) ?? tonumber(itemId) ?? 4;
}

export interface CatchResult {
  success: boolean;
  reason?: string;
  location: string | null | undefined;
  firstTimeCaught: boolean;
  mon: any;
  species?: any;
  box?: any;
  slot?: any;
  pending?: boolean;
}

export interface CatchingModule {
  BALL_BONUS: Record<number, number>;
  targetFor(st: any, attackerId: any): any;
  isBall(id: any): boolean | null;
  ballMultiplier(itemId: any, foeBattler: any, st: any, session: any): number;
  catchOdds(itemId: any, foeBattler: any, st: any, session: any): number;
  tryCatch(itemId: any, foeBattler: any, st: any, session: any, rng: any): [boolean, number];
  playerSecretId(session: any): number;
  storeCaught(session: any, foeBattler: any, ballId: any, opts?: any): CatchResult;
  givePending(session: any, res: any): boolean;
}

export const Catching = {} as CatchingModule;

// Ball catch bonuses (bonus × 10):
// Master = 255 (instant catch), Ultra = 20, Great/Safari = 15, Poke/Premier/Luxury = 10
Catching.BALL_BONUS = {
  [1]: 255, // MASTER_BALL
  [2]: 20,  // ULTRA_BALL
  [3]: 15,  // GREAT_BALL
  [4]: 10,  // POKE_BALL
  [5]: 15,  // SAFARI_BALL
  [6]: 10,  // NET_BALL (default; conditional boost 30)
  [7]: 10,  // DIVE_BALL (default; conditional boost 35)
  [8]: 10,  // NEST_BALL (conditional boost based on level)
  [9]: 10,  // REPEAT_BALL (conditional boost 30 if owned)
  [10]: 10, // TIMER_BALL (conditional boost based on turns)
  [11]: 10, // LUXURY_BALL
  [12]: 10, // PREMIER_BALL
};

// Lua: catching.lua:33
function roll_rng(rng: any, loIn?: number, hiIn?: number): number {
  const lo = loIn ?? 0;
  const hi = hiIn ?? 255;
  if (typeof rng === "function") {
    try {
      const v = rng(lo, hi);
      if (typeof v === "number") return v;
    } catch { /* pcall failed */ }
  } else if (isTable(rng) && typeof rng.random === "function") {
    try {
      const v = rng.random(lo, hi);
      if (typeof v === "number") return v;
    } catch { /* pcall failed */ }
  }
  return LinkGuard.fallback("catching.roll", lo, hi);
}

// pokefirered/src/battle_script_commands.c:9471
// Lua: catching.lua:47
Catching.targetFor = function (st: any, attackerId: any): any {
  const id = (tonumber(attackerId) ?? 0);
  const t = (lmod(id, 2) === 0) ? (id + 1) : (id - 1);
  if (t === 1 || !truthy(st)) return land(st, st?.enemy);
  return lor(land(st.battlers, st.battlers?.[t]), st.enemy);
};

// Lua: catching.lua:54
Catching.isBall = function (id: any): boolean | null {
  const num = ItemsData.toNumericId(id) ?? tonumber(id);
  if (num == null) return null;
  return num >= 1 && num <= 12;
};

// Lua: catching.lua:60
/** Evaluate effective ball multiplier (bonus × 10) for a given foe and battle state. */
Catching.ballMultiplier = function (itemId: any, foeBattler: any, st: any, session: any): number {
  const num = ball_num(itemId);
  if (num === 1) return 255;
  let mult = Catching.BALL_BONUS[num] ?? 10;
  const mon = land(foeBattler, foeBattler?.mon);
  const level = tonumber(land(mon, mon?.level)) ?? 50;

  if (num === 6) { // NET BALL: 3x if Water or Bug
    const t1 = land(foeBattler, foeBattler?.type1);
    const t2 = land(foeBattler, foeBattler?.type2);
    const WATER = lor(land(Types.ID, Types.ID?.WATER), 11);
    const BUG = lor(land(Types.ID, Types.ID?.BUG), 7);
    if (t1 === WATER || t2 === WATER || t1 === BUG || t2 === BUG) {
      mult = 30;
    }
  } else if (num === 7) { // DIVE BALL: 3.5x in water/surf
    const terrain = land(st, st?.terrain);
    if (terrain === "water" || terrain === "surf" || terrain === "underwater") {
      mult = 35;
    }
  } else if (num === 8) { // NEST BALL: (40 - level) / 10 for level < 40, clamped to min 1.0 (10)
    if (level < 40) {
      mult = Math.max(10, (40 - level));
    }
  } else if (num === 9) { // REPEAT BALL: 3x if already caught in Pokédex
    const species = land(foeBattler, lor(foeBattler?.species, land(foeBattler?.mon, foeBattler?.mon?.species)));
    let dex = land(session, session?.dex);
    if (!truthy(dex)) {
      // pcall(require, "src.core.game3.runtime") always succeeds here
      if (truthy(Runtime) && truthy(Runtime.getSession)) {
        const s = Runtime.getSession();
        dex = land(s, s?.dex);
      }
    }
    if (truthy(species) && truthy(dex) && Dex.isCaught(dex, species)) {
      mult = 30;
    }
  } else if (num === 10) { // TIMER BALL: min(40, 10 + turns)
    const turns = lor(land(st, lor(st?.turn, st?.turnCount)), 1);
    mult = Math.min(40, 10 + turns);
  }

  return mult;
};

// Lua: catching.lua:107
/** Calculate catch odds 'a' (0..255).
 * Formula: a = floor(((3 * maxHP - 2 * HP) * catchRate * ballBonus) / (3 * maxHP)) * statusBonus */
Catching.catchOdds = function (itemId: any, foeBattler: any, st: any, session: any): number {
  const num = ball_num(itemId);
  if (num === 1) return 255;

  const species = land(foeBattler, lor(foeBattler?.species, land(foeBattler?.mon, foeBattler?.mon?.species)));
  const meta = truthy(species) ? Pokemon.speciesMeta(species) : species;
  let catchRate = lor(land(meta, tonumber(meta?.catchRate)), 45) as number;
  // pokefirered/src/battle_script_commands.c:9496
  if (num === 5 && truthy(st) && truthy(st.safariState)) {
    // require("src.core.game3.battle.rules")
    catchRate = Rules.safari.ballCatchRate(st.safariState);
  }

  const mon = land(foeBattler, foeBattler?.mon);
  const hp = Math.max(1, tonumber(land(mon, mon?.hp)) ?? 1);
  const maxHp = Math.max(1, tonumber(land(mon, mon?.maxHp)) ?? hp);

  const mult = Catching.ballMultiplier(itemId, foeBattler, st, session);
  let baseOdds = Math.floor(((maxHp * 3 - hp * 2) * catchRate * mult / 10) / (3 * maxHp));
  baseOdds = Math.max(1, baseOdds);

  const status = land(foeBattler, lor(foeBattler?.status, land(mon, mon?.status)));
  let odds = baseOdds;
  if (truthy(status)) {
    const s = tostring(status).toUpperCase();
    if (s === "SLP" || s === "SLEEP" || s === "FRZ" || s === "FREEZE") {
      odds = Math.floor(baseOdds * 2);
    } else if (s === "PSN" || s === "TOX" || s === "BRN" || s === "PAR"
        || s === "POISON" || s === "BURN" || s === "PARALYSIS") {
      odds = Math.floor(baseOdds * 15 / 10);
    }
  }

  return Math.max(1, Math.min(255, odds));
};

// Lua: catching.lua:143
function vanilla_catch(itemId: any, foeBattler: any, st: any, session: any, rng: any): [boolean, number] {
  const num = ball_num(itemId);
  if (num === 1) {
    return [true, 4];
  }

  const odds = Catching.catchOdds(itemId, foeBattler, st, session);

  if (odds >= 255) {
    return [true, 4];
  }

  // pret GBA shake check threshold 'b'
  // b = floor(1048560 / sqrt(sqrt(16711680 / a)))
  const shakeOdds = Math.floor(1048560 / Math.sqrt(Math.sqrt(16711680 / odds)));
  let shakes = 0;

  for (let n = 1; n <= 4; n++) {
    const r = roll_rng(rng, 0, 65535);
    if (r < shakeOdds) {
      shakes = shakes + 1;
    } else {
      return [false, shakes];
    }
  }

  return [true, 4];
}

// Lua: catching.lua:172
function battle_state(st: any): any {
  if (truthy(st)) return st;
  // package.loaded["src.core.game3.battle.init"] (always loaded here)
  const B: any = BattleInit;
  return (truthy(B) && truthy(B.getState)) ? lor(B.getState(), undefined) : undefined;
}

// Lua: catching.lua:181
/** Attempt to catch the foe.
 * Returns: [caught (bool), shakes (0..4)].
 * pokefirered/src/battle_script_commands.c:9463 */
Catching.tryCatch = function (itemId: any, foeBattler: any, st: any, session: any, rng: any): [boolean, number] {
  // pokefirered/src/battle_script_commands.c:9485
  if (truthy(st) && (truthy(st.oldManTutorial) || truthy(st.pokedude))) {
    return [true, 4];
  }
  // pokeemerald/src/battle_script_commands.c:9921
  if (truthy(st) && truthy(st.kinds) && st.kinds.tutorial === "wally") return [true, 4];
  // pokeemerald/src/battle_script_commands.c:9995
  if (truthy(st) && !truthy(st.safari)) {
    const ballId = ball_num(itemId);
    const r = lor(st.battleResults, { catchAttempts: {} });
    st.battleResults = r;
    r.lastUsedItem = ballId;
    if (ballId === 1) {
      r.usedMasterBall = true;
    } else if ((r.catchAttempts[ballId - 1] ?? 0) < 255) {
      r.catchAttempts[ballId - 1] = (r.catchAttempts[ballId - 1] ?? 0) + 1;
    }
  }
  let caught: any;
  let shakes: any;
  if (ModRuntime.wantsHook("catch.rate")) {
    // require("src.mods.Gen3Compat")
    const mon = land(foeBattler, foeBattler?.mon);
    const species = land(foeBattler, lor(foeBattler?.species, land(mon, lor(mon?.species, mon?.speciesId))));
    const ballNum = ball_num(itemId);
    const ret = ModRuntime.call("catch.rate", (b: any, _m: any, _s: any, o: any) => {
      const id = lor(b != null ? G3.itemId(b) : undefined, ballNum);
      return vanilla_catch(id, o.target, st, o.session, o.rng);
    }, G3.itemName(ballNum) ?? "POKE_BALL", mon, G3.speciesView(species), {
      battle: battle_state(st), target: foeBattler, session: session, rng: rng,
      ballId: ballNum, species: G3.speciesName(species), speciesId: tonumber(species),
      rate: Catching.catchOdds(itemId, foeBattler, st, session),
    });
    // a hook returns (caught, shakes)
    [caught, shakes] = Array.isArray(ret) ? ret : [ret, undefined];
    caught = truthy(caught) ? true : false;
    shakes = tonumber(shakes) ?? (caught ? 4 : 0);
  } else {
    [caught, shakes] = vanilla_catch(itemId, foeBattler, st, session, rng);
  }
  if (ModRuntime.wants("battle.ball_thrown")) {
    // require("src.mods.Gen3Compat")
    const mon = land(foeBattler, foeBattler?.mon);
    const species = land(foeBattler, lor(foeBattler?.species, land(mon, lor(mon?.species, mon?.speciesId))));
    const ballNum = ball_num(itemId);
    ModRuntime.emit("battle.ball_thrown", {
      battle: battle_state(st), ball: G3.itemName(ballNum), ballId: ballNum,
      caught: caught, shakes: shakes, mon: mon, target: foeBattler,
      species: G3.speciesName(species), speciesId: tonumber(species),
    });
  }
  return [caught, shakes];
};

// Lua: catching.lua:233
function clone_mon(mon: any): any {
  if (!isTable(mon)) return undefined;
  const copy: any = Array.isArray(mon) ? [] : {};
  for (const [k, v] of pairs(mon)) {
    if (isTable(v)) {
      const inner: any = Array.isArray(v) ? [] : {};
      for (const [ik, iv] of pairs(v)) inner[ik] = iv;
      copy[k] = inner;
    } else {
      copy[k] = v;
    }
  }
  return copy;
}

// pokefirered/src/new_game.c:56
// Lua: catching.lua:249
Catching.playerSecretId = function (session: any): number {
  if (!isTable(session)) return 0;
  let sec = tonumber(lor(session.secretId, session.otSecretId));
  const tid = tonumber(lor(lor(session.trainerId, session.id), session.playerId));
  if (sec == null && tid != null) {
    const scan = (list: any): number | undefined => {
      for (const [, m] of pairs(lor(list, {}))) {
        const ms = isTable(m) ? tonumber(m.otSecretId) : undefined;
        if (ms != null && tonumber(m.otId) === tid) return ms;
      }
      return undefined;
    };
    sec = scan(session.party);
    const storage = session.storage;
    const boxes = (sec == null && truthy(storage) && truthy(storage.boxes)) ? storage.boxes : {};
    for (const [, box] of pairs(boxes)) {
      if (sec == null) sec = scan(isTable(box) ? box.mons : undefined);
    }
  }
  if (sec == null) {
    // pcall(require, "src.core.game3.rng") always succeeds here
    const r = (truthy(Rng) && truthy(Rng.Random)) ? Rng.Random() : undefined;
    sec = truthy(r) ? r as number : mathRandom(0, 0xFFFF);
  }
  sec = lmod(Math.floor(sec), 0x10000);
  session.secretId = sec;
  return sec;
};

// pokefirered/src/battle_script_commands.c:9617
// Lua: catching.lua:277
function emit_caught(res: any): void {
  if (!ModRuntime.wants("pokemon.caught")) return;
  // require("src.mods.Gen3Compat"); package.loaded["src.core.game3.runtime"]
  const R = Runtime;
  const mon = res.mon;
  ModRuntime.emit("pokemon.caught", {
    battle: battle_state(undefined), mon: mon, species: G3.speciesName(res.species),
    speciesId: tonumber(res.species), isNew: res.firstTimeCaught,
    ball: G3.itemName(mon.pokeball), ballId: mon.pokeball,
    destination: res.location === "pc" ? "box" : "party",
    box: res.box, slot: res.slot, game: truthy(R) ? R._game : undefined,
  });
}

// Lua: catching.lua:293
/** Store a caught Pokémon into session party or PC.
 * Marks Pokédex as caught, tracks firstTimeCaught, and returns result info. */
Catching.storeCaught = function (session: any, foeBattler: any, ballId: any, opts?: any): CatchResult {
  if (!truthy(session) || !truthy(foeBattler) || !truthy(foeBattler.mon)) {
    return { success: false, location: undefined, firstTimeCaught: false, mon: undefined };
  }

  session.party = lor(session.party, seq());
  session.dex = lor(session.dex, Dex.new());

  const mon = clone_mon(foeBattler.mon);
  const otName = lor(lor(session.name, session.playerName), "RED");
  const trainerId = lor(lor(lor(session.trainerId, session.id), session.playerId), 12345);
  mon.ot = otName;
  mon.otName = otName;
  // pokefirered/src/pokemon.c:3692
  mon.otId = trainerId;
  mon.otSecretId = Catching.playerSecretId(session);
  mon.pokeball = ItemsData.toNumericId(ballId) ?? 4;
  mon.nickname = lor(mon.nickname, "");
  // pokefirered/src/pokemon.c:1817
  mon.metLocation = lor(Pokemon.currentMapSec(session), mon.metLocation);
  mon.metLevel = tonumber(mon.level) ?? tonumber(mon.metLevel);
  // pokefirered/src/pokemon_summary_screen.c:2633 GetMapNameGeneric_
  let okSec = false;
  let secName: any;
  try {
    // require("src.import.gba.map_sections_extract")
    const info = MapSectionsExtract.getInfo(mon.metLocation, session.map, 0);
    secName = land(info, info?.name);
    okSec = true;
  } catch { okSec = false; }
  if (okSec && typeof secName === "string" && secName !== "" && secName !== "???") {
    mon.metLocationName = secName;
  }
  const species = lor(lor(foeBattler.species, mon.species), mon.speciesId);
  mon.species = species;
  mon.speciesId = species;
  if (!truthy(mon.name) || mon.name === "") {
    mon.name = Pokemon.name(species);
  }

  const wasCaught = Dex.registerCapture(session.dex, species, undefined, mon.personality);
  const firstTimeCaught = !truthy(wasCaught);

  let location = "party";
  let boxId: any;
  let boxSlot: any;
  let pending: boolean | undefined;
  if (len(session.party) < 6) {
    session.party[len(session.party) + 1] = mon;
    location = "party";
  } else {
    // require("src.core.game3.storage")
    let ok: any;
    let bId: any;
    let sId: any;
    if (truthy(opts) && truthy(opts.deferPc)) {
      ok = Storage.findOpenSlot(Storage.ensure(session))[0] != null;
      pending = ok ? true : undefined;
    } else {
      [ok, bId, sId] = Storage.depositCaught(session, mon);
    }
    if (truthy(ok)) {
      location = "pc";
      boxId = bId;
      boxSlot = sId;
    } else {
      return {
        success: false,
        reason: "storage_full",
        location: undefined,
        firstTimeCaught: false,
        mon: undefined,
      };
    }
  }

  const res: CatchResult = {
    success: true,
    location: location,
    firstTimeCaught: firstTimeCaught,
    mon: mon,
    species: species,
    box: boxId,
    slot: boxSlot,
    pending: pending,
  };
  if (!truthy(pending)) emit_caught(res);
  return res;
};

// pokefirered/src/battle_script_commands.c:9617 Cmd_givecaughtmon
// Lua: catching.lua:377
Catching.givePending = function (session: any, res: any): boolean {
  if (!(truthy(res) && truthy(res.pending))) return true;
  res.pending = undefined;
  // require("src.core.game3.storage")
  const [ok, bId, sId] = Storage.depositCaught(session, res.mon);
  res.box = bId;
  res.slot = sId;
  if (ok) emit_caught(res);
  return ok;
};

export default Catching;
