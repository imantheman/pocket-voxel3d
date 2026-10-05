// Port of gen1recomp src/core/game3/battle_bridge.lua (GPLv3 + additional terms; see LICENSE.md).
// Battle entry for Sevii: owned game3 battle + white-out / FRLG money (H3/H6/H7).
// No host Battle / no save.party swap. H4 remaps are transitional (party_view keeps Gen3 ids).
//
// Port notes:
// - `package.loaded[...]` probes and `pcall(require, ...)` of runtime modules
//   read the imported module: every runtime module is linked in here, so it is
//   always "loaded" and always requires cleanly.
// - Lua multiple returns are 0-based tuples: start() returns [true] or
//   [null, err]; applyFrlgMoneyLoss/applyWhiteoutMoneyLoss return
//   [lost, money]; twoOpponentFoe returns [foe, half].
// - NOT FAITHFUL: src.world.gen2.World (the Gen 2 host world) is not part of
//   this runtime, so installWhiteoutIntercept's pcall(require) reads as failed.
// - NOT FAITHFUL: src.core.game3.roamer has no stub/port yet, so the roamer
//   pcall(require) in finish() reads as failed (no Roamer.onBattleEnd).
// - NOT FAITHFUL: Emerald only: the rse.init (TV) and rse.rematch calls throw.

import { mod as lmod, tonumber, tostring, truthy } from "../../../import/gen3/lua.ts";
import { ipairs, len, pairs, seq, type LuaTable } from "../platform/lt.ts";
import Party from "./party.ts";
import PartyView from "./battle/party_view.ts";
import Downgrade from "./battle_downgrade.ts";
import Pokemon from "./pokemon.ts";
import ModRuntime from "../shared/mods/Runtime.ts";
import G3 from "../shared/mods/Gen3Compat.ts";
import Runtime from "./runtime.ts";
import BattleProfile from "./battle/profile.ts";
import Safari from "./safari.ts";
import Space from "./scripting/space.ts";
import Flags from "./scripting/flags.ts";
import Field from "./field.ts";
import Trainers from "./scripting/trainers.ts";
import Natives from "./scripting/natives.ts";
import Profile from "./profile.ts";
import Capabilities from "./capabilities.ts";
import Audio from "./audio.ts";
import Fade from "../ui/fade.ts";
import StayMessage from "../ui/message.ts";
import Battle from "./battle.ts";
import GameMap from "./map.ts";
import Collision from "./collision.ts";
import Player from "./player.ts";
import BattleTransition from "./battle_transition.ts";
import Encounters from "./encounters.ts";

type Tbl = LuaTable;

/** Lua `a or b` (b already evaluated). */
function lor<A, B>(a: A, b: B): A | B {
  return truthy(a) ? a : b;
}

/** Lua `a and b` (b already evaluated). */
function land<A, B>(a: A, b: B): A | B {
  return truthy(a) ? b : a;
}

/** Lua `t and t.k`. */
function tk(t: any, k: string): any {
  return truthy(t) ? t[k] : t;
}

/** Lua `type(v) == "table"`. */
function isTable(v: unknown): v is Tbl {
  return v !== null && typeof v === "object";
}

/** Shallow copy of a table (`for k, v in pairs(t) do out[k] = v end`). */
function copyTable(t: Tbl): Tbl {
  const out: Tbl = Array.isArray(t) ? [] : {};
  for (const [k, v] of pairs(t)) out[k] = v;
  return out;
}

// Lua: battle_bridge.lua:18
function runtimeActive(): any {
  // package.loaded["src.core.game3.runtime"]
  return truthy(Runtime) && truthy(Runtime.isActive) && Runtime.isActive();
}

// pokefirered/include/constants/flags.h:1327
const FLAG_SYS_SAFARI_MODE = 0x800;

// pokefirered/src/battle_setup.c:239
// Lua: battle_bridge.lua:27
function safari_mode_active(session: Tbl): boolean {
  if (truthy(BattleProfile.get(session).safari)) {
    // pokeemerald/src/battle_setup.c:391
    return Safari.isActive(session);
  }
  if (truthy(session) && truthy(session.safari) && truthy(session.safari.active)) return true;
  // pcall(require, "src.core.game3.scripting.space") always succeeds here
  if (!truthy(Space) || !truthy(Space.store)) return false;
  if (!truthy(Flags) || !truthy(Flags.getFlag)) return false;
  return truthy(Flags.getFlag(Space.store, undefined, FLAG_SYS_SAFARI_MODE)) ? true : false;
}

// pokefirered/src/overworld.c:1270
// Lua: battle_bridge.lua:41
function map_battle_scene(mapId: any, game?: Tbl): number | undefined {
  if (typeof mapId !== "string") return undefined;
  let g = game;
  if (!truthy(g)) {
    // package.loaded["src.core.game3.runtime"]
    g = land(Runtime, Runtime._game);
  }
  const def = truthy(g) && truthy(g!.data) && truthy(g!.data.maps) ? g!.data.maps[mapId] : undefined;
  if (!truthy(def)) return undefined;
  return tonumber(def.battleType);
}

const BADGE_LOSS_MULT = seq(2, 4, 6, 9, 12, 16, 20, 25, 30); // index 0..8 badges
const BADGE_FLAGS = seq(
  0x820, 0x821, 0x822, 0x823, 0x824, 0x825, 0x826, 0x827, // FLAG_BADGE01..08
);

// Lua: battle_bridge.lua:59
function count_badges(session: Tbl, hostSave: Tbl): number {
  let flags: Tbl = undefined;
  // package.loaded["src.core.game3.scripting.space"]
  const store = truthy(Space) && truthy(Space.getStore) ? Space.getStore() : undefined;
  if (truthy(store) && truthy(store.flags)) {
    flags = store.flags;
  } else if (truthy(session) && truthy(session.flags)) {
    flags = session.flags;
  }
  if (truthy(flags)) {
    let n = 0;
    for (const [, fid] of ipairs<number>(BADGE_FLAGS)) {
      if (truthy(flags[fid]) || truthy(flags[tostring(fid)])) n = n + 1;
    }
    return Math.min(8, n);
  }
  let badges = 0;
  if (truthy(hostSave)) {
    const inv = lor(hostSave.inventory, {});
    for (const [id, qty] of pairs(inv)) {
      // id:find("BADGE", 1, true): a plain find
      if (typeof id === "string" && id.includes("BADGE") && lor(qty, 0) > 0) {
        badges = badges + 1;
      }
    }
    if (typeof hostSave.badges === "number") {
      badges = Math.max(badges, hostSave.badges);
    } else if (isTable(hostSave.badges)) {
      let c = 0;
      for (const [, v] of pairs(hostSave.badges)) if (truthy(v)) c = c + 1;
      badges = Math.max(badges, c);
    }
  }
  return Math.max(0, Math.min(8, badges));
}

const LEAD_FIELDS = seq("species", "level", "rawIv", "iv", "ivs", "evs", "heldItem",
  "moves", "personality");

// pokefirered/src/battle_main.c:1539
// Lua: battle_bridge.lua:174
function hooked_trainer_party(foe: Tbl, trainerId: any): Tbl {
  if (!isTable(foe) || !isTable(foe.party) || len(foe.party) === 0) return foe;
  const named = G3.partyNames(foe.party);
  const out = ModRuntime.call("trainer.party", (_a: any, _b: any, party: any) => {
    return party;
  }, foe.trainerClass, trainerId, named);
  if (!isTable(out) || len(out) === 0) return foe;
  const copy = copyTable(foe);
  copy.party = G3.partyNums(out);
  const lead = copy.party[1];
  for (const [, key] of ipairs<string>(LEAD_FIELDS)) copy[key] = lead[key];
  return copy;
}

// Lua: battle_bridge.lua:190
function battle_payload(B: Tbl, opts: Tbl, foe: Tbl, isDouble: boolean): Tbl {
  const st = truthy(B.getState) ? B.getState() : undefined;
  const enemy = truthy(st) && truthy(st.enemy) ? st.enemy.mon : undefined;
  const sp = truthy(enemy) ? tonumber(lor(enemy.species, enemy.speciesId)) : undefined;
  const tid = lor(opts.trainerId, tk(foe, "trainerId"));
  return {
    battle: st, kind: truthy(opts.link) ? "link" : truthy(opts.wild) ? "wild" : "trainer",
    trainerId: lor(land(!truthy(opts.wild), tid), undefined),
    trainerClass: lor(land(!truthy(opts.wild) && truthy(foe), tk(foe, "trainerClass")), undefined),
    species: G3.speciesName(sp), speciesId: sp,
    level: tk(enemy, "level"), double: truthy(isDouble) ? true : false,
  };
}

// Lua: battle_bridge.lua:205
function writeback(session: Tbl, battleParty: Tbl, remap: Tbl, result: any, save: Tbl, opts?: Tbl): void {
  opts = lor(opts, {}) as Tbl;
  if (!truthy(session)) return;
  Downgrade.writebackPlayerPp(session.party, session.move_overlay, remap, battleParty);
  for (const [i, mon] of ipairs<Tbl>(lor(session.party, seq()))) {
    const src = truthy(battleParty) ? battleParty[i] : battleParty;
    if (truthy(src)) {
      Party.applyBattleFields(mon, {
        hp: src.hp,
        maxHp: src.maxHp,
        status: src.status,
        sleep: src.sleep,
        level: src.level,
        exp: src.exp,
        pp: src.pp,
        maxPp: src.maxPp,
        ppBonusesPacked: src.ppBonusesPacked,
        moves: src.moves,
        species: lor(src.species, src.speciesId),
        speciesId: lor(src.speciesId, src.species),
        name: src.name,
        growthRate: src.growthRate,
        evs: src.evs,
        friendship: src.friendship,
        pokerus: src.pokerus,
        attack: lor(src.attack, src.atk),
        defense: lor(src.defense, src.def),
        speed: lor(src.speed, src.spe),
        spAtk: lor(src.spAtk, src.spa),
        spDef: lor(src.spDef, src.spd),
        atk: lor(src.attack, src.atk),
        def: lor(src.defense, src.def),
        spe: lor(src.speed, src.spe),
        spa: lor(src.spAtk, src.spa),
        spd: lor(src.spDef, src.spd),
        ability: src.ability,
        abilityId: src.abilityId,
        _allowMoveRewrite: true,
      });
      // pokefirered/src/battle_controller_player.c:1909
      let held = lor(src.item, src.heldItem);
      if (held === 0 || held === "") held = undefined;
      mon.item = held;
      mon.heldItem = held;
    }
  }
  const lost = (result === "lose" || result === "whiteout" || result === "blackout");
  if (!lost) return;
  // pokefirered/src/cable_club.c:780 LoadPlayerParty
  if (truthy(opts.link)) return;
  // pokeemerald/src/battle_setup.c:950
  if (opts.firstBattleKind === "birch") return;
  // pokeemerald/src/battle_tower.c:1994
  if (truthy(opts.scriptedLoss)) return;

  // pret CB2_EndTrainerBattle EARLY_RIVAL + RIVAL_BATTLE_HEAL_AFTER:
  // heal and continue script — no white-out warp.
  const flags = tonumber(opts.rivalFlags) ?? 0;
  const healAfter = lor(opts.noWhiteout,
    land(opts.earlyRival, lmod(flags, 2) === 1)); // bit0 = RIVAL_BATTLE_HEAL_AFTER
  if (truthy(healAfter)) {
    // pokeemerald/data/scripts/secret_base.inc:641-652
    if (!truthy(opts.deferHeal)) Party.healAll(session.party);
    return;
  }

  BattleBridge.applyWhiteoutMoneyLoss(session, save);
  Field.respawnAtHeal();
}

// pokefirered/src/pokemon.c:5483
// Lua: battle_bridge.lua:276
function league_trainer_class(foe: Tbl, opts: Tbl): any {
  const tid = tonumber(lor(tk(opts, "trainerId"), tk(foe, "trainerId")));
  if (tid != null) {
    // pcall(require, "src.core.game3.scripting.trainers") always succeeds here
    const info = truthy(Trainers) && truthy(Trainers.info) ? Trainers.info(tid) : undefined;
    if (truthy(info) && info.class != null) return info.class;
  }
  return tk(foe, "trainerClass");
}

export const BattleBridge = {
  _remap: undefined as Tbl,
  _battleParty: undefined as Tbl,
  _interceptInstalled: false,
  _whiteoutHook: undefined as (() => boolean) | undefined,
  _finish: undefined as ((result?: any) => void) | undefined,

  mapBattleScene: map_battle_scene,

  // Lua: battle_bridge.lua:94
  calcMoneyLossFrlg(session: Tbl, hostSave?: Tbl): number {
    let maxLv = 1;
    const party = tk(session, "party");
    if (isTable(party)) {
      // pokefirered/src/pokemon.c:6085
      for (const [, mon] of ipairs<Tbl>(party)) {
        if (truthy(mon) && !truthy(Pokemon.isEgg(mon))) {
          const lv = tonumber(mon.level) ?? 1;
          if (lv > maxLv) maxLv = lv;
        }
      }
    }
    const badges = count_badges(session, hostSave);
    // pret: toplevel * 4 * sWhiteOutMoneyLossMultipliers[nbadges]
    const mult = BADGE_LOSS_MULT[badges + 1] ?? 2;
    return maxLv * 4 * mult;
  },

  // Lua: battle_bridge.lua:112
  applyFrlgMoneyLoss(session: Tbl, hostSave?: Tbl): [number, number] {
    const loss = BattleBridge.calcMoneyLossFrlg(session, hostSave);
    let money = tonumber(tk(session, "money")) ?? tonumber(tk(hostSave, "money")) ?? 0;
    money = Math.max(0, money - loss);
    if (truthy(session)) session.money = money;
    if (truthy(hostSave)) hostSave!.money = money;
    return [loss, money];
  },

  // pokeemerald/src/overworld.c:361
  // Lua: battle_bridge.lua:122
  applyWhiteoutMoneyLoss(session: Tbl, hostSave?: Tbl): [number, number] {
    if (BattleProfile.get(session).rules.whiteout !== "half") {
      return BattleBridge.applyFrlgMoneyLoss(session, hostSave);
    }
    const money = tonumber(tk(session, "money")) ?? tonumber(tk(hostSave, "money")) ?? 0;
    const kept = Math.floor(money / 2);
    if (truthy(session)) session.money = kept;
    if (truthy(hostSave)) hostSave!.money = kept;
    return [money - kept, kept];
  },

  // Lua: battle_bridge.lua:134
  installWhiteoutIntercept(_mod: any, game?: Tbl): void {
    if (BattleBridge._interceptInstalled) return;
    BattleBridge._interceptInstalled = true;

    // Lua: battle_bridge.lua:138
    const onWhiteout = (): boolean => {
      if (!truthy(Runtime.isActive())) return false;
      const session = Runtime.getSession();
      BattleBridge.applyWhiteoutMoneyLoss(session, tk(game, "save"));
      Field.respawnAtHeal();
      return true;
    };
    BattleBridge._whiteoutHook = onWhiteout;

    // NOT FAITHFUL: pcall(require, "src.world.gen2.World") -- the Gen 2 host
    // world is not part of this runtime, so the require reads as failed.
    const ok = false;
    const World: any = undefined;
    if (ok && truthy(World)) {
      if (typeof World.whiteOut === "function" && !truthy(World._game3WhiteOut)) {
        const prev = World.whiteOut;
        World.whiteOut = function (this: any, ...a: any[]) {
          if (onWhiteout()) return;
          return prev.call(this, ...a);
        };
        World._game3WhiteOut = true;
      }
      if (typeof World.warpToPokemonCenter === "function" && !truthy(World._game3WarpPC)) {
        const prev = World.warpToPokemonCenter;
        World.warpToPokemonCenter = function (this: any, ...a: any[]) {
          if (truthy(runtimeActive()) && onWhiteout()) return;
          return prev.call(this, ...a);
        };
        World._game3WarpPC = true;
      }
    }
  },

  // pokefirered/src/battle_main.c:713
  // Lua: battle_bridge.lua:287
  applyLeagueFriendship(session: Tbl, battleParty: Tbl, foe: Tbl, opts?: Tbl): boolean {
    opts = lor(opts, {}) as Tbl;
    if (truthy(opts.wild) || !isTable(session)) return false;
    if (!truthy(Pokemon.isLeagueTrainerClass(league_trainer_class(foe, opts)))) return false;
    const ctx = { leagueBattle: true, mapSec: Pokemon.currentMapSec(session) };
    let changed = false;
    for (const [i, mon] of ipairs<Tbl>(lor(session.party, seq()))) {
      if (truthy(Pokemon.adjustFriendship(mon, Pokemon.FRIENDSHIP_EVENT_LEAGUE_BATTLE, ctx))) {
        changed = true;
        if (truthy(battleParty) && truthy(battleParty[i])) {
          battleParty[i].friendship = Pokemon.friendshipOf(mon);
        }
      }
    }
    return changed;
  },

  // pokeemerald/src/battle_main.c:1977
  // Lua: battle_bridge.lua:305
  twoOpponentFoe(foeA: Tbl, trainerIdB: any): [Tbl, number] {
    const foeB = Trainers.foeFromId(trainerIdB);
    if (!isTable(foeA) || !isTable(foeA.party) || !truthy(foeB)) {
      throw new Error("two-opponent battle needs trainer parties for A and B (" + tostring(trainerIdB) + ")");
    }
    const out = copyTable(foeA);
    const party: Tbl = seq();
    for (let i = 1; i <= Math.min(3, len(foeA.party)); i++) party[len(party) + 1] = foeA.party[i];
    const half = len(party);
    for (let i = 1; i <= Math.min(3, len(foeB.party)); i++) party[len(party) + 1] = foeB.party[i];
    out.party = party;
    return [out, half];
  },

  EXTRA_KINDS: seq(
    "twoOpponents", "partner", "recordedLink", "frontier", "trainerHill", "kyogreGroudon", "regi",
    "groudon", "kyogre", "rayquaza", "trainerIdB",
    "tutorialKind", "playerHalf", "partnerTrainerId", "partnerBackPic", "trainerItems",
    "battleTower", "secretBase", "dome", "palace", "arena", "factory", "pike", "pyramid", "frontierTrainer", "frontierTrainerB",
    "towerLinkMulti", "victoryTextB",
  ),

  // pokeemerald/src/battle_main.c:5098
  // Lua: battle_bridge.lua:330
  tvBattleEnd(_session: Tbl, result: any): void {
    // package.loaded["src.core.game3.battle"]
    const B = Battle;
    const st = truthy(B) && truthy(B.getState) ? B.getState() : undefined;
    if (!truthy(st)) return;
    const k = lor(st.kinds, {});
    const r = lor(st.battleResults, { catchAttempts: {} });
    const speciesOf = (b: Tbl): number =>
      truthy(b) && truthy(b.mon) ? (tonumber(Pokemon.speciesOf(b.mon)) ?? 0) : 0;
    const nickOf = (b: Tbl): any =>
      lor(truthy(b) && truthy(b.mon) ? lor(b.mon.nickname, b.mon.name) : undefined, "");
    const enemy = st.enemy;
    const caught = result === "caught" || result === "catch";
    const results = {
      playerMon1Species: speciesOf(st.player), playerMon1Name: nickOf(st.player),
      playerMon2Species: truthy(st.player2) ? speciesOf(st.player2) : 0,
      caughtMonSpecies: caught ? speciesOf(enemy) : 0,
      caughtMonNick: caught ? nickOf(enemy) : "",
      caughtMonBall: lor(land(caught, r.lastUsedItem), 0),
      catchAttempts: lor(r.catchAttempts, {}),
      usedMasterBall: lor(r.usedMasterBall, false),
      lastUsedItem: lor(r.lastUsedItem, 0),
      lastOpponentSpecies: speciesOf(enemy),
      shinyWildMon: lor(truthy(st.wild) && truthy(enemy) && truthy(enemy.mon) ? Pokemon.isShiny(enemy.mon) : false, false),
    };
    const battleType = {
      link: lor(st.link, k.link), recordedLink: k.recordedLink, trainer: !truthy(st.wild),
      firstBattle: k.firstBattle != null, safari: lor(st.safari, k.safari), ereaderTrainer: st.eReader,
      wallyTutorial: k.tutorial === "wally", frontier: k.frontier,
    };
    const code = Natives.outcome_to_code(lor(result, "win"));
    // NOT FAITHFUL: Emerald only -- require("src.core.game3.rse.init").call("tv",
    // "onBattleEnd", "TryPutPokemonTodayOnAir", nil, results, code, battleType)
    void results; void code; void battleType;
    throw new Error("NOT FAITHFUL: Emerald only (rse.init tv.onBattleEnd)");
  },

  /**
   * Start owned game3 battle (async). opts.done(result) when finished.
   * opts.earlyRival / opts.rivalFlags / opts.noWhiteout: Oaks Lab tutorial loss.
   */
  // Lua: battle_bridge.lua:365
  start(mod: any, game: Tbl, foe: Tbl, opts?: Tbl): [true] | [null, any] {
    const o0: Tbl = lor(opts, {});
    opts = o0;
    const session = truthy(o0.link) && isTable(o0.session) ? o0.session : Runtime.getSession();
    if (!truthy(session)) return [null, "no session"];

    BattleBridge.installWhiteoutIntercept(mod, game);
    if (truthy(o0.wild) && Profile.family(session) === "rse") {
      // pokeemerald/src/battle_setup.c:417
      // NOT FAITHFUL: Emerald only -- require("src.core.game3.rse.init").call("tv",
      // "incrementDailyWildBattles", "IncrementDailyWildBattles", nil)
      throw new Error("NOT FAITHFUL: Emerald only (rse.init tv.incrementDailyWildBattles)");
    }

    const linkParty = lor(land(truthy(o0.link) && isTable(o0.linkParty), o0.linkParty), undefined);
    let battleParty: Tbl, remap: Tbl;
    if (truthy(linkParty)) {
      [battleParty, remap] = PartyView.fromSession(linkParty, undefined);
    } else {
      [battleParty, remap] = PartyView.fromSession(session.party, session.move_overlay);
    }
    if (len(battleParty) === 0) return [null, "empty party"];
    let foeHalf: any;
    if (truthy(o0.twoOpponents) && truthy(o0.trainerIdB) && !truthy(o0.wild)) {
      [foe, foeHalf] = BattleBridge.twoOpponentFoe(foe, o0.trainerIdB);
    } else if (truthy(o0.twoOpponents) && truthy(o0.frontierFoeHalf) && !truthy(o0.wild)) {
      foeHalf = o0.frontierFoeHalf;
    }
    const isDouble = !truthy(o0.wild)
      && truthy(lor(lor(o0.double, foeHalf), tk(foe, "doubleBattle"))) ? true : false;
    if (isDouble && Party.monsStateToDoubles(lor(linkParty, session.party)) !== Party.PLAYER_HAS_TWO_USABLE_MONS) {
      return [null, "need two mons"];
    }
    if (!truthy(o0.link) && truthy(Capabilities.gate(session, "match_call"))) {
      // pokeemerald/src/battle_setup.c:402
      // NOT FAITHFUL: Emerald only -- require("src.core.game3.rse.rematch"):
      // onWildBattleStart(session) / onTrainerBattleStart(session)
      throw new Error("NOT FAITHFUL: Emerald only (rse.rematch on battle start)");
    }

    BattleBridge._remap = remap;
    BattleBridge._battleParty = battleParty;

    BattleBridge.applyLeagueFriendship(session, battleParty, foe, o0);

    const save = tk(game, "save");
    const done = o0.done;

    if (!truthy(o0.wild) && truthy(ModRuntime.wantsHook("trainer.party"))) {
      foe = hooked_trainer_party(foe, lor(o0.trainerId, tk(foe, "trainerId")));
    }

    // Lua: battle_bridge.lua:413
    const finish = (result?: any): void => {
      // pokefirered/src/battle_main.c:196
      // pcall(require, "src.core.game3.scripting.natives") always succeeds here
      if (truthy(Natives) && truthy(Natives.outcome_to_code)) {
        session.battleOutcome = Natives.outcome_to_code(lor(result, "win"));
      }
      if (!truthy(linkParty)) writeback(session, battleParty, remap, result, save, o0);
      if (Profile.family(session) === "rse") {
        BattleBridge.tvBattleEnd(session, result);
      }
      if (truthy(o0.roamer) || truthy(tk(foe, "roamer"))) {
        // NOT FAITHFUL: pcall(require, "src.core.game3.roamer") -- roamer has no
        // stub/port in this runtime yet, so the require reads as failed.
        const okR = false;
        const Roamer: any = undefined;
        if (okR && truthy(Roamer) && truthy(Roamer.onBattleEnd)) {
          const st = truthy(Battle) && truthy(Battle.getState) ? Battle.getState() : undefined;
          const enemyMon = lor(truthy(st) && truthy(st.enemy) ? st.enemy.mon : undefined, foe);
          Roamer.onBattleEnd(session, enemyMon, result, tk(st, "endReason"));
        }
      }
      // pokefirered/src/battle_main.c:3861
      if (truthy(ModRuntime.wants("battle.ended"))) {
        // package.loaded["src.core.game3.battle"]
        const B = Battle;
        ModRuntime.emit("battle.ended", {
          battle: lor(truthy(B) && truthy(B.getState) ? B.getState() : undefined, undefined),
          result: lor(result, "win"),
        });
      }
      BattleBridge._remap = undefined;
      BattleBridge._battleParty = undefined;
      BattleBridge._finish = undefined;
      if (truthy(o0.firstBattleKind) || truthy(o0.firstBattle)) {
        // pokeemerald/src/battle_setup.c:952 CB2_EndFirstBattle Overworld_ClearSavedMusic
        try {
          Audio.clearSavedSong();
        } catch {
          // pcall
        }
      }
      try {
        Audio.restoreMapSong();
      } catch {
        // pcall
      }
      // pcall(require, "src.ui.game3.fade") always succeeds here
      if (truthy(Fade) && truthy(Fade.begin) && !truthy(o0.headless) && o0.fade !== false) {
        Fade.begin(Fade.MODE.FROM_BLACK, 1);
      }
      // pokefirered/src/battle_setup.c:432
      if (truthy(Space) && truthy(Space.returnToField)) {
        try {
          Space.returnToField();
        } catch {
          // pcall(Space.returnToField)
        }
      }
      if (truthy(done)) done(lor(result, "win"));
    };
    BattleBridge._finish = finish;

    // package.loaded["src.core.game3.map"] or require("src.core.game3.map")
    const mapId = GameMap.current;
    const mapDef = truthy(game) && truthy(game.data) && truthy(game.data.maps) && truthy(mapId)
      ? game.data.maps[mapId as string] : undefined;
    const mapKind = lor(tk(mapDef, "kind"), o0.mapKind);
    const mapType = lor(tk(mapDef, "mapType"), o0.mapType);
    let mapBattleScene = lor(tk(mapDef, "battleType"), o0.mapBattleScene);
    if (!truthy(mapBattleScene)) mapBattleScene = map_battle_scene(mapId, game);
    // pokefirered/src/battle_setup.c:471 PlayerGetDestCoords
    let mapBehavior = o0.mapBehavior;
    if (mapBehavior == null) {
      // pcall(require, collision / player) always succeeds here
      if (truthy(Collision.behavior)) {
        let bx = Player.cellX, by = Player.cellY;
        if (truthy(Player.moving)) { bx = Player.targetX; by = Player.targetY; }
        mapBehavior = Collision.behavior(bx, by);
      }
    }

    let gender = 0;
    if (session.gender === "female" || session.gender === "F" || session.gender === 1) {
      gender = 1;
    } else if (truthy(save) && (save.gender === 1 || save.gender === "female" || save.gender === "F")) {
      gender = 1;
    }

    const wildScripted = lor(o0.wildScripted, tk(foe, "wildScripted"));
    const legendary = lor(o0.legendary, tk(foe, "legendary"));
    const roamer = lor(o0.roamer, tk(foe, "roamer"));
    // pokefirered/src/battle_setup.c:237
    const standardWild = truthy(o0.wild) && !truthy(o0.trainerId)
      && !truthy(wildScripted) && !truthy(legendary) && !truthy(roamer)
      && !truthy(o0.firstBattle) && !truthy(o0.oldManTutorial) && !truthy(o0.firstBattleKind)
      && !truthy(o0.tutorialKind);
    let safari = lor(o0.safari, tk(foe, "safari"));
    if (!truthy(safari)) safari = lor(standardWild && safari_mode_active(session), undefined);
    const startOpts: Tbl = {
      // pokefirered/src/cable_club.c:664 BATTLE_TYPE_LINK
      link: lor(lor(o0.link, tk(foe, "link")), undefined),
      session,
      spectate: o0.spectate,
      autoFight: o0.autoFight,
      linkFlags: o0.linkFlags,
      // pokefirered/src/battle_controllers.c:148 InitLinkBtlControllers
      linkMaster: o0.linkMaster,
      hostRules: lor(land(o0.link, o0.hostRules), undefined),
      multi: lor(land(o0.link, o0.multi), undefined),
      unionRoom: o0.unionRoom,
      peerName: lor(lor(o0.peerName, tk(foe, "name")), undefined),
      wild: o0.wild,
      wildScripted,
      legendary,
      safari,
      roamer,
      firstBattle: lor(o0.firstBattle, tk(foe, "firstBattle")),
      firstBattleKind: o0.firstBattleKind,
      oldManTutorial: lor(o0.oldManTutorial, tk(foe, "oldManTutorial")),
      aiFlags: lor(o0.aiFlags, tk(foe, "aiFlags")),
      double: isDouble,
      playerParty: battleParty,
      foe,
      headless: o0.headless,
      fade: o0.fade,
      rng: o0.rng,
      mapKind,
      mapType,
      mapBehavior,
      mapBattleScene,
      terrain: o0.terrain,
      trainerId: lor(o0.trainerId, tk(foe, "trainerId")),
      // pokefirered/src/trainer_tower.c:735 BATTLE_TYPE_TRAINER_TOWER
      trainerTower: lor(o0.trainerTower, tk(foe, "trainerTower")),
      // pokefirered/src/battle_tower.c:933 BATTLE_TYPE_EREADER_TRAINER
      eReader: lor(o0.eReader, tk(foe, "eReader")),
      // pokefirered/src/battle_message.c:2066 GetTrainerTowerOpponentName
      trainerName: lor(o0.trainerName, tk(foe, "trainerName")),
      trainerClass: lor(o0.trainerClass, tk(foe, "trainerClass")),
      trainerClassName: lor(o0.trainerClassName, tk(foe, "trainerClassName")),
      trainerPicId: lor(o0.trainerPicId, tk(foe, "trainerPicId")),
      defeatText: lor(o0.defeatText, tk(foe, "defeatText")),
      defeatTextB: o0.defeatTextB,
      foeHalf,
      victoryText: lor(o0.victoryText, tk(foe, "victoryText")),
      earlyRival: o0.earlyRival,
      rivalFlags: o0.rivalFlags,
      rivalName: lor(lor(o0.rivalName, session.rivalName), tk(save, "rivalName")),
      playerGender: lor(o0.playerGender, gender),
      onDone: (result: any) => {
        finish(result);
      },
      onStarted: () => {
        // pokefirered/src/battle_main.c:612
        if (truthy(ModRuntime.wants("battle.started"))) {
          ModRuntime.emit("battle.started", battle_payload(Battle, o0, foe, isDouble));
        }
      },
    };

    for (const [, k] of ipairs<string>(BattleBridge.EXTRA_KINDS)) {
      if (truthy(o0[k])) startOpts[k] = o0[k];
    }

    // Lua: battle_bridge.lua:565
    const resolve_battle_song = (o: Tbl, so: Tbl): any => {
      if (truthy(o) && truthy(o.song)) return o.song;
      // pcall(require, "src.core.game3.audio") always succeeds here
      if (!truthy(Audio)) return undefined;
      const bp = BattleProfile.get(session);
      if (truthy(bp.music)) {
        const tid = lor(land(!truthy(so.wild), so.trainerId), undefined);
        // pcall(require, "src.core.game3.scripting.trainers") always succeeds here
        const info = truthy(tid) && truthy(Trainers) ? lor(Trainers.info(tid), undefined) : undefined;
        // pokeemerald/src/pokemon.c:6426
        return BattleProfile.battleSong(bp, {
          wild: so.wild, link: so.link, trainerClass: tk(info, "class"),
          trainerName: tk(info, "name"),
          kind: truthy(so.kyogreGroudon) ? "kyogreGroudon" : truthy(so.regi) ? "regi" : undefined,
        });
      }
      if (truthy(tk(o, "wild")) || truthy(tk(so, "wild"))) {
        const f = lor(tk(o, "foe"), tk(so, "foe"));
        const sp = truthy(f) ? lor(lor(f.species, f.id), f.speciesId) : f;
        // pokefirered/src/battle_setup.c:349 StartLegendaryBattle
        const legendarySong = Audio.legendaryBattleSong(sp);
        if (truthy(legendarySong)) return legendarySong;
        return lor(Audio.role("battleWild"), 298);
      } else {
        const tid = lor(lor(tk(so, "trainerId"), tk(o, "trainerId")), truthy(o) && truthy(o.foe) ? o.foe.trainerId : undefined);
        if (!(truthy(Trainers) && truthy(Trainers.getBattleMusicRole))) {
          return lor(Audio.role("battleTrainer"), 297);
        }
        const [role, fallback] = Trainers.getBattleMusicRole(tid);
        return lor(Audio.role(role), fallback);
      }
    };

    const battleSong = resolve_battle_song(o0, startOpts);
    startOpts.song = battleSong;

    // pret CreateBattleStartTask: PlayMapChosenOrBattleBGM starts immediately
    // on frame 1 of the battle transition on the overworld.
    if (!truthy(o0.headless) && truthy(battleSong)) {
      if (truthy(Audio) && truthy(Audio.playSong)) {
        Audio.playSong(battleSong);
      }
    }

    {
      // package.loaded["src.ui.game3.message"]
      if (truthy(StayMessage) && truthy(StayMessage.closeStay)) StayMessage.closeStay();
    }

    // Lua: battle_bridge.lua:615
    const doStart = (): [true] | [null, any] => {
      const [ok, err] = Battle.start(startOpts);
      if (!truthy(ok)) {
        BattleBridge._finish = undefined;
        BattleBridge._remap = undefined;
        BattleBridge._battleParty = undefined;
        if (truthy(done)) done("win");
        return [null, err];
      }
      return [true];
    };

    if (truthy(o0.headless) || o0.fade === false) {
      return doStart();
    }

    // pcall(require, "src.core.game3.battle_transition") always succeeds here
    if (truthy(BattleTransition) && truthy(BattleTransition.start)) {
      // package.loaded["src.core.game3.field"] or require("src.core.game3.field")
      if (truthy(Field) && truthy(Field.lock)) Field.lock();

      const leadMon = truthy(battleParty) ? battleParty[1] : battleParty;
      let playerLv = lor(land(leadMon, lor(tk(leadMon, "level"), tk(leadMon, "lvl"))), 5);
      let foeLv = lor(lor(tk(foe, "level"),
        truthy(foe) && truthy(foe.party) && truthy(foe.party[1])
          ? lor(foe.party[1].level, foe.party[1].lvl) : undefined), 3);
      if (isDouble) {
        [playerLv, foeLv] = PartyView.doubleTransitionLevels(battleParty, tk(foe, "party"));
      }

      const pickOpts: Tbl = {
        wild: o0.wild,
        mapKind,
        terrain: o0.terrain,
        playerLevel: playerLv,
        enemyLevel: foeLv,
        trainerId: startOpts.trainerId,
        trainerClass: lor(land(!truthy(o0.wild) && truthy(foe), tk(foe, "trainerClass")), undefined),
        trainerTower: startOpts.trainerTower,
        eReader: startOpts.eReader,
        playerGender: startOpts.playerGender,
        transitionId: o0.transitionId,
      };
      if (Profile.family(session) === "rse") {
        // pokeemerald/src/battle_setup.c:696
        pickOpts.mapType = mapType;
        pickOpts.mapBehavior = mapBehavior;
        pickOpts.flashLevel = session.flashLevel;
        pickOpts.pyramid = o0.pyramid;
      }
      const tid = BattleTransition.pick(pickOpts);
      BattleTransition.start(tid, pickOpts, () => {
        doStart();
      });
      return [true];
    }

    // pcall(require, "src.ui.game3.fade") always succeeds here
    if (truthy(Fade) && truthy(Fade.begin)) {
      // package.loaded["src.core.game3.field"] or require("src.core.game3.field")
      if (truthy(Field) && truthy(Field.lock)) Field.lock();
      Fade.begin(Fade.MODE.TO_BLACK, 1, () => {
        doStart();
      });
      return [true];
    }
    return doStart();
  },

  // Lua: battle_bridge.lua:682
  startWild(mod: any, game: Tbl, encounter: Tbl, opts?: Tbl): [true] | [null, any] {
    const o: Tbl = lor(opts, {});
    o.wild = true;
    // pret battle_setup.c resets the encounter cooldown when a battle starts, so
    // the grace period re-arms after every wild battle -- including ones nothing
    // stepped into (scripted battles, fishing).
    // pcall(require, "src.core.game3.encounters") always succeeds here
    if (truthy(Encounters) && truthy(Encounters.resetRateModifiers)) {
      Encounters.resetRateModifiers();
    }
    return BattleBridge.start(mod, game, encounter, o);
  },

  // pokeemerald/src/battle_setup.c:917
  // Lua: battle_bridge.lua:696
  startFirstBattle(mod: any, game: Tbl, opts?: Tbl): [true] | [null, any] {
    opts = lor(opts, {}) as Tbl;
    const bp = BattleProfile.get(Runtime.getSession());
    const fb = bp.firstBattle;
    if (!truthy(fb)) throw new Error("battle profile " + tostring(bp.gameId) + " has no first battle");
    const C = BattleProfile.constants(bp);
    // pokeemerald/src/battle_controllers.c:70
    const foe = { species: C.require("species", fb.species), level: fb.level, item: 0 };
    const o: Tbl = {};
    for (const [k, v] of pairs(opts)) o[k] = v;
    o.wild = true;
    o.firstBattleKind = bp.kinds.firstBattle;
    o.transitionId = truthy(opts.transitionId) ? opts.transitionId : C.require("battle", fb.transition);
    // pokeemerald/src/battle_setup.c:941
    // pcall(require, "src.core.game3.encounters") always succeeds here
    if (truthy(Encounters) && truthy(Encounters.resetRateModifiers)) {
      Encounters.resetRateModifiers();
    }
    return BattleBridge.start(mod, game, foe, o);
  },

  /** Tests / emergency: complete pending battle writeback. */
  // Lua: battle_bridge.lua:720
  finishPending(result?: any): void {
    // package.loaded["src.core.game3.battle"] or require("src.core.game3.battle")
    if (truthy(Battle.isActive) && truthy(Battle.isActive())) {
      Battle.abort(lor(result, "win"));
      return;
    }
    if (BattleBridge._finish) {
      const f = BattleBridge._finish;
      BattleBridge._finish = undefined;
      return f(lor(result, "win"));
    }
  },

  // pokefirered/src/main.c:480
  // Lua: battle_bridge.lua:735
  reset(): void {
    BattleBridge._finish = undefined;
    BattleBridge._remap = undefined;
    BattleBridge._battleParty = undefined;
  },
};

export default BattleBridge;
