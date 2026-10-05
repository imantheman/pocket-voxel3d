// Port of gen1recomp src/core/game3/scripting/natives.lua (GPLv3 + additional terms; see LICENSE.md).
// callnative / special allowlist; unknown → safe-skip + log once.
// Handlers mirror pret specials → host adapters (heal / PC), not map coords.
//
// Port notes:
// - Handler convention: a special handler returns Lua's multiple returns as a
//   0-based tuple, [yield] or [yield, value] (`return false` -> `return [false]`,
//   `return yield_host(...)` -> `return [yield_host(...)]`). Natives.special
//   returns [yield, value, known]; Natives.callnative returns a boolean.
//   Callers read a handler's result through ret(), which also accepts a bare
//   value from a handler written the other way.
// - require / package.loaded / pcall(require): every module is in the bundle,
//   so each is a static import used exactly as Brian guards it. A module with
//   no file in the port takes Brian's failed-require path.
// - NOT FAITHFUL: no filesystem module discovery. listModuleDir lists a static
//   table of the natives_* modules that have a file in the port (NATIVE_FILES);
//   `pcall(require, MODULE_PACKAGE .. base)` resolves through the same table,
//   and a name not in it is a failed require. Brian's order and merge rules
//   (profile list + listing, sorted; later modules override earlier names)
//   are kept.
// - NOT FAITHFUL: ES module cycle. natives_* modules import this one, so this
//   module's load-time Natives.bind() can run while one of them is still
//   initialising (a TDZ ReferenceError). bind then skips that module as a
//   failed require and leaves boundGame unset, so the next ensureBound()
//   (Natives.special calls it first) binds again with every module loaded.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { seq, len, ipairs, pairs, sort, type LuaTable } from "../../platform/lt.ts";
import { match } from "../../platform/lpattern.ts";
import { truthy, tostring, tonumber, format, sub, mod } from "../../../../import/gen3/lua.ts";
import Strings from "../../shared/core/Strings.ts";
import Std from "./stdscripts.ts";
import Capabilities from "../capabilities.ts";
import Profile from "../profile.ts";
import Constants from "../constants.ts";
import GameVersion from "../../shared/core/GameVersion.ts";
import VsSeeker from "../vs_seeker.ts";
import Flags from "./flags.ts";
import Runtime from "../runtime.ts";
import Space from "./space.ts";
import Storage from "../storage.ts";
import Pokemon from "../pokemon.ts";
import RomText from "../rom_text.ts";
import Fade from "../../ui/fade.ts";
import PartyMenu from "../../ui/party_menu.ts";
import Rng from "../rng.ts";
import Trainers from "./trainers.ts";
import Audio from "../audio.ts";
import Party from "../party.ts";
import Objects from "../objects.ts";
import QuestLogRecorder from "../quest_log_recorder.ts";
import Help from "../../ui/help_system.ts";
import Encounters from "../encounters.ts";
import Bag from "../bag.ts";
import PcAnim from "../pc_anim.ts";
import EasyChatText from "../easy_chat_text.ts";
import Naming from "../../ui/naming.ts";
import Braille from "../../ui/braille.ts";
import PokedexData from "../pokedex_data.ts";
import Field from "../field.ts";
import Corner from "./natives_corner.ts";
import Cutscene from "./natives_cutscene.ts";
import Daycare from "./natives_daycare.ts";
import Elevator from "./natives_elevator.ts";
import Events from "./natives_events.ts";
import Fame from "./natives_fame.ts";
import FanClub from "./natives_fan_club.ts";
import Gift from "./natives_gift.ts";
import ListMenu from "./natives_listmenu.ts";
import MoveTeach from "./natives_moveteach.ts";
import Queries from "./natives_queries.ts";
import SeagallopNatives from "./natives_seagallop.ts";
import SizeRecordNatives from "./natives_size_record.ts";
import TowerNatives from "./natives_tower.ts";
import Trade from "./natives_trade.ts";
import NativesTv from "./natives_tv.ts";

export type HandlerRet = [boolean, any?];
export type Handler = (ctx: any, adapters?: any) => HandlerRet;

/** A handler's multiple returns as a tuple (see the port notes). */
function ret(r: any): any[] {
  return Array.isArray(r) ? r : [r];
}

/** Lua's `a or b`. */
function lor<A, B>(a: A, b: B): A | B {
  return truthy(a) ? a : b;
}

// Lua: natives.lua:17
function yield_host(ctx: any, _adapters: any, startFn: (done: () => void) => any): boolean {
  let finished = false;
  ctx.mode = "native";
  ctx.status = "waiting";
  ctx.nativePoll = () => finished;
  startFn(() => {
    finished = true;
  });
  return !finished; // true = caller should yield
}

// Lua: natives.lua:36
function vsSeeker(): any {
  return VsSeeker;
}

// Lua: natives.lua:40
function flagsMod(): typeof Flags {
  return Flags;
}

// Lua: natives.lua:44
function lastTalked(ctx: any): number {
  // package.loaded["src.core.game3.runtime"]
  const rt = Runtime;
  const sess = rt && rt.getSession && rt.getSession();
  return flagsMod().getVar(undefined, ctx, Constants.active(sess).var("VAR_LAST_TALKED"));
}

// Lua: natives.lua:50
function setResult(ctx: any, v: any): void {
  const rt = Runtime;
  const sess = rt && rt.getSession && rt.getSession();
  flagsMod().setVar(undefined, ctx, Constants.active(sess).var("VAR_RESULT"), v);
}

// Lua: natives.lua:56
function getSpecialVar(ctx: any, id: number): number {
  let v = tonumber(flagsMod().getVar(undefined, ctx, id)) ?? 0;
  if (v === 0 && ctx && typeof ctx.getVar === "function") {
    v = tonumber(ctx.getVar(id)) ?? 0;
  }
  return v;
}

// Lua: natives.lua:64
function setSpecialVar(ctx: any, id: number, value: any): void {
  // src/field_specials.c:2075-2078, include/constants/vars.h:75
  // package.loaded["src.core.game3.scripting.space"]
  flagsMod().setVar(Space ? Space.store : undefined, ctx, id, value);
  if (ctx && typeof ctx.setVar === "function") ctx.setVar(id, value);
}

const SLOT_CANCEL = 7; // pokefirered/src/party_menu.c:87

// Lua: natives.lua:73
function partyOf(): [any, any] {
  const rt = Runtime;
  const session = rt && rt.getSession && rt.getSession();
  return [session && session.party, session];
}

// Lua: natives.lua:79
function chosenMon(ctx: any): any {
  const [party] = partyOf();
  return party && party[getSpecialVar(ctx, 0x8004) + 1];
}

// Lua: natives.lua:85
// pokefirered/src/field_specials.c:1631
function boxedMon(): any {
  const [, session] = partyOf();
  if (!truthy(session)) return undefined;
  // pcall(require, "src.core.game3.storage")
  const okS = true;
  if (!(okS && typeof Storage === "object" && Storage.getBoxMon)) return undefined;
  return Storage.getBoxMon(Storage.ensure(session),
    (tonumber(session.monBoxId) ?? 0) + 1, (tonumber(session.monBoxPos) ?? 0) + 1);
}

// Lua: natives.lua:96
// GetMonData(MON_DATA_NICKNAME) is gText_EggNickname for an egg
// (pokefirered/src/pokemon.c:3020)
function ensurePokemonNames(P: typeof Pokemon): void {
  if (truthy(P._names)) return;
  let okI = true;
  let errI: unknown;
  try { P.install(undefined); } catch (e) { okI = false; errI = e; }
  if (!okI && !truthy(P._installWarned)) {
    P._installWarned = true;
    console.log("[game3/pokemon] install failed: " + tostring(errI));
  }
}

// Lua: natives.lua:105
function nicknameOf(mon: any): string {
  if (!truthy(mon)) return "";
  if (Pokemon.isEgg(mon)) return RomText.plain("gText_EggNickname");
  if (truthy(mon.nickname) && mon.nickname !== "") return tostring(mon.nickname);
  ensurePokemonNames(Pokemon);
  return lor(Pokemon.name && Pokemon.name(lor(mon.species, mon.speciesId)), "");
}

// Lua: natives.lua:114
function setStringVar(ctx: any, adapters: any, index: number, text: any): void {
  if (adapters && truthy(adapters.setStringVar)) adapters.setStringVar(index, text);
  if (ctx && truthy(ctx.stringVars)) ctx.stringVars[index] = text;
}

// Lua: natives.lua:120
// pokefirered/src/party_menu_specials.c:38, pokefirered/src/party_menu.c:6317
function takeScreenForPartyMenu(): () => void {
  // pcall(require, "src.ui.game3.fade")
  const okF = true;
  if (!(okF && Fade && truthy(Fade.begin) && truthy(Fade.MODE))) return () => {};
  const covered = !(Fade.isActive && Fade.isActive()) && (tonumber(Fade.t) ?? 0) >= 16;
  // pokefirered/src/party_menu.c:6329 FadeInFromBlack
  if (!(covered && Fade.mode === Fade.MODE.TO_BLACK)) return () => {};
  Fade.clear();
  return () => {
    Fade.begin(Fade.MODE.FROM_BLACK, 1, () => {});
  };
}

const B_OUTCOME_WON = 1;
const B_OUTCOME_LOST = 2;
const B_OUTCOME_DREW = 3;
const B_OUTCOME_RAN = 4;
const B_OUTCOME_PLAYER_TELEPORTED = 5;
const B_OUTCOME_MON_FLED = 6;
const B_OUTCOME_CAUGHT = 7;
const B_OUTCOME_NO_SAFARI_BALLS = 8;
const B_OUTCOME_FORFEITED = 9;
const B_OUTCOME_MON_TELEPORTED = 10;

// Lua: natives.lua:198
function outcome_to_code(result: any): number {
  if (typeof result === "number") return result;
  if (result === "win" || result === "won") return B_OUTCOME_WON;
  else if (result === "lose" || result === "lost" || result === "whiteout" || result === "blackout") return B_OUTCOME_LOST;
  else if (result === "draw" || result === "drew") return B_OUTCOME_DREW;
  else if (result === "run" || result === "ran" || result === "fled_player") return B_OUTCOME_RAN;
  else if (result === "teleport_player" || result === "player_teleported") return B_OUTCOME_PLAYER_TELEPORTED;
  else if (result === "fled" || result === "mon_fled") return B_OUTCOME_MON_FLED;
  else if (result === "caught" || result === "catch") return B_OUTCOME_CAUGHT;
  else if (result === "no_safari_balls") return B_OUTCOME_NO_SAFARI_BALLS;
  else if (result === "forfeited") return B_OUTCOME_FORFEITED;
  else if (result === "mon_teleported") return B_OUTCOME_MON_TELEPORTED;
  return B_OUTCOME_WON;
}

// pokefirered/src/field_specials.c:557
const VERMILION_TRASH_ADJACENT: Record<number, LuaTable> = {
  1: seq(1, 5),
  2: seq(1, 5, -1),
  3: seq(1, 5, -1),
  4: seq(1, 5, -1),
  5: seq(5, -1),
  6: seq(-5, 1, 5),
  7: seq(-5, 1, 5, -1),
  8: seq(-5, 1, 5, -1),
  9: seq(-5, 1, 5, -1),
  10: seq(-5, 5, -1),
  11: seq(-5, 1),
  12: seq(-5, 1, -1),
  13: seq(-5, 1, -1),
  14: seq(-5, 1, -1),
  15: seq(-5, -1),
};

const CORE: Record<string, Handler> = {
  // Lua: natives.lua:269
  // pokefirered/src/field_specials.c:552
  SetVermilionTrashCans: (ctx) => {
    const [first, second] = Natives.setVermilionTrashCans(Rng.Random);
    const F = flagsMod();
    F.setVar(undefined, ctx, 0x8004, first);
    F.setVar(undefined, ctx, 0x8005, second);
    return [false];
  },
  // Lua: natives.lua:278
  // pokefirered/src/battle_setup.c:865
  Script_HasTrainerBeenFought: (ctx) => {
    const F = flagsMod();
    const fid = F.trainerFlagId(lor(ctx.trainerBattleOpponentA, 0));
    setResult(ctx, F.getFlag(vsSeeker().store(), ctx, fid) ? 1 : 0);
    return [false];
  },
  // Lua: natives.lua:285
  // pokefirered/src/battle_setup.c:1007
  PlayTrainerEncounterMusic: (ctx) => {
    if (ctx.trainerBattleMode === 1 || ctx.trainerBattleMode === 8) return [false];
    const song = Trainers.getEncounterMusic && Trainers.getEncounterMusic(lor(ctx.trainerBattleOpponentA, 0));
    // pcall(require, "src.core.game3.audio")
    const okA = true;
    if (okA && Audio && Audio.playSong && truthy(song)) Audio.playSong(song);
    return [false];
  },
  // Lua: natives.lua:294
  // pokefirered/src/vs_seeker.c:1013
  ShouldTryRematchBattle: (ctx) => {
    const VS = vsSeeker();
    const ok = VS.shouldTryRematchBattle(lor(ctx.trainerBattleOpponentA, 0), lastTalked(ctx), VS.store());
    setResult(ctx, truthy(ok) ? 1 : 0);
    return [false];
  },
  // Lua: natives.lua:301
  // pokefirered/src/vs_seeker.c:1086
  IsTrainerReadyForRematch: (ctx) => {
    const ok = vsSeeker().isTrainerReadyForRematch(lor(ctx.trainerBattleOpponentA, 0), lastTalked(ctx));
    setResult(ctx, truthy(ok) ? 1 : 0);
    return [false];
  },
  // Lua: natives.lua:307
  // pokefirered/src/script_pokemon_util.c:90
  HasEnoughMonsForDoubleBattle: (ctx) => {
    const rt = Runtime;
    const session = rt && rt.getSession && rt.getSession();
    setResult(ctx, Party.monsStateToDoubles(session && session.party));
    return [false];
  },
  // Lua: natives.lua:315
  // pokefirered/src/battle_setup.c:848
  SetUpTrainerMovement: (ctx) => {
    // package.loaded["src.core.game3.objects"]
    const O = Objects;
    const lid = lastTalked(ctx);
    const eo = O && !truthy(O.isPlayer(lid)) && O.find(lid);
    if (truthy(eo) && O.setTrainerMovementType) {
      O.setTrainerMovementType(eo, vsSeeker().faceTypeFor(eo.facing));
    }
    return [false];
  },
  // Lua: natives.lua:325
  // pokefirered/src/vs_seeker.c:636
  VsSeekerResetObjectMovementAfterChargeComplete: () => {
    vsSeeker().resetObjectMovementAfterChargeComplete();
    return [false];
  },
  // Lua: natives.lua:330
  // pokefirered/src/vs_seeker.c:598
  VsSeekerFreezeObjectsAfterChargeComplete: () => {
    const O = Objects;
    for (const [, lid] of ipairs(lor(O && O._order, {}))) {
      const eo = O._byId[lid];
      if (truthy(eo)) eo.frozen = true;
    }
    return [false];
  },
  // Lua: natives.lua:339
  // pokefirered/src/battle_setup.c:870
  SetBattledTrainerFlag: (ctx) => {
    const F = flagsMod();
    const store = vsSeeker().store();
    if (truthy(store)) F.setFlag(store, ctx, F.trainerFlagId(lor(ctx.trainerBattleOpponentA, 0)), true);
    return [false];
  },
  // Lua: natives.lua:345
  SetUsedPkmnCenterQuestLogEvent: () => {
    const rt = Runtime;
    QuestLogRecorder.event(rt && rt.getSession(), "MonsWereFullyRestoredAtCenter", {});
    return [false];
  },
  // Lua: natives.lua:350
  GetQuestLogState: (ctx) => {
    // Playback has no script VM; scripts executing here always belong to live play.
    setResult(ctx, 0);
    return [false];
  },
  // Lua: natives.lua:355
  QuestLog_CutRecording: () => {
    const rt = Runtime;
    const session = rt && rt.getSession();
    if (truthy(session)) session._questNewScene = true;
    return [false];
  },
  // Lua: natives.lua:361
  QuestLog_StartRecordingInputsAfterDeferredEvent: () => {
    return [false]; // Events are captured at their completed engine transactions.
  },
  // Lua: natives.lua:364
  Script_SetHelpContext: (ctx) => {
    const id = Flags.getVar(undefined, ctx, 0x8004);
    Help.setContext(id);
    return [false];
  },
  // Lua: natives.lua:369
  BackupHelpContext: () => {
    Help.contextBackup = Help.contextOverride;
    return [false];
  },
  // Lua: natives.lua:374
  RestoreHelpContext: () => {
    Help.contextOverride = Help.contextBackup;
    return [false];
  },
  // Lua: natives.lua:379
  SetHelpContextForMap: () => {
    Help.setContext(undefined);
    return [false];
  },
  // Lua: natives.lua:383
  HelpSystem_Disable: () => {
    Help.enabled = false;
    return [false];
  },
  // Lua: natives.lua:387
  HelpSystem_Enable: () => {
    Help.enabled = true;
    return [false];
  },
  // Lua: natives.lua:392
  // pokefirered/src/field_specials.c:153
  GetBattleOutcome: (ctx) => {
    const outcome = (ctx && truthy(ctx.lastBattleOutcome)) ? ctx.lastBattleOutcome : B_OUTCOME_WON;
    setResult(ctx, outcome);
    return [false, outcome];
  },
  // Lua: natives.lua:398
  // pokefirered/src/field_specials.c:163
  GetLeadMonFriendship: (ctx) => {
    const rt = Runtime;
    const session = rt && rt.getSession && rt.getSession();
    const party = lor(session && session.party, seq());
    let lead = party[1];
    for (const [, mon] of ipairs<any>(party)) {
      const sp = tonumber(lor(mon.species, mon.speciesId)) ?? 0;
      if (sp !== 0 && !truthy(lor(mon.isEgg, mon.egg))) { lead = mon; break; }
    }
    const f = truthy(lead) ? (Pokemon.friendshipOf(lead) ?? 0) : 0;
    let score = 0;
    if (f === 255) score = 6;
    else if (f >= 200) score = 5;
    else if (f >= 150) score = 4;
    else if (f >= 100) score = 3;
    else if (f >= 50) score = 2;
    else if (f > 0) score = 1;
    setResult(ctx, score);
    return [false, score];
  },
  // Lua: natives.lua:420
  // pokefirered/src/field_specials.c:2075
  DaisyMassageServices: (ctx) => {
    const [, session] = partyOf();
    const mon = chosenMon(ctx);
    if (truthy(mon)) {
      Pokemon.adjustFriendship(mon, Pokemon.FRIENDSHIP_EVENT_MASSAGE,
        { mapSec: Pokemon.currentMapSec(session) });
    }
    setSpecialVar(ctx, 0x4025, 0);
    return [false];
  },
  // Lua: natives.lua:432
  // pokefirered/src/battle_setup.c:320
  StartMarowakBattle: (ctx, adapters) => {
    const foe: any = Encounters.takePendingWild();
    if (!(truthy(foe) && adapters && truthy(adapters.startWildBattle))) return [false];
    const rt = Runtime;
    const session = rt && rt.getSession && rt.getSession();
    // pcall(require, "src.core.game3.bag")
    const okB = true;
    const scope = lor(okB && truthy(session) && truthy(session.bag) && Bag.has(session.bag, 359, 1), false);
    foe.ghost = true;
    foe.ghostUnveiled = scope;
    foe.wildScripted = true;
    if (scope) {
      // pokefirered/src/battle_setup.c:327
      foe.gender = "F";
      foe.nature = 12;
      foe.ivs = { hp: 31, atk: 31, def: 31, spe: 31, spa: 31, spd: 31 };
    }
    return [yield_host(ctx, adapters, (done) => {
      adapters.startWildBattle(foe, (result: any) => {
        const code = outcome_to_code(result);
        if (ctx) ctx.lastBattleOutcome = code;
        // pokefirered/src/battle_setup.c:458
        setResult(ctx, code === B_OUTCOME_WON ? 0 : 1);
        if (done) done();
      }, { wildScripted: true });
    })];
  },
  // Lua: natives.lua:459
  // pokefirered/src/battle_setup.c:349 StartLegendaryBattle (special 0x138 / 312)
  StartLegendaryBattle: (ctx, adapters) => {
    const foe: any = Encounters.takePendingWild();
    if (!(truthy(foe) && adapters && truthy(adapters.startWildBattle))) return [false];
    foe.legendary = true;
    foe.specialWild = true;
    return [yield_host(ctx, adapters, (done) => {
      adapters.startWildBattle(foe, (result: any) => {
        const code = outcome_to_code(result);
        if (ctx) ctx.lastBattleOutcome = code;
        setResult(ctx, code);
        if (done) done();
      }, { legendary: true });
    })];
  },
  // Lua: natives.lua:475
  // pokefirered/src/battle_setup.c:378 StartGroudonKyogreBattle (special 0x137 / 311)
  StartGroudonKyogreBattle: (ctx, adapters) => {
    return Natives.CORE.StartLegendaryBattle(ctx, adapters);
  },
  // Lua: natives.lua:479
  // pokefirered/src/battle_setup.c:393 StartRegiBattle (special 0x139 / 313)
  StartRegiBattle: (ctx, adapters) => {
    return Natives.CORE.StartLegendaryBattle(ctx, adapters);
  },
  // Lua: natives.lua:483
  // pokefirered/src/battle_setup.c:339 StartSouthernIslandBattle (special 0x143 / 323)
  StartSouthernIslandBattle: (ctx, adapters) => {
    return Natives.CORE.StartLegendaryBattle(ctx, adapters);
  },
  // Lua: natives.lua:487
  // pokefirered/src/battle_setup.c:301 StartOldManTutorialBattle (special 0x9D / 157)
  StartOldManTutorialBattle: (ctx, adapters) => {
    const foe = {
      species: 13, // WEEDLE
      level: 5,
      gender: "M",
      oldManTutorial: true,
    };
    if (!(adapters && truthy(adapters.startWildBattle))) return [false];
    return [yield_host(ctx, adapters, (done) => {
      adapters.startWildBattle(foe, (result: any) => {
        const code = outcome_to_code(result);
        if (ctx) ctx.lastBattleOutcome = code;
        setResult(ctx, code);
        if (done) done();
      }, { oldManTutorial: true });
    })];
  },
  // Lua: natives.lua:504
  HealPlayerParty: (ctx, adapters) => {
    if (!(adapters && truthy(adapters.nurseHeal))) return [false];
    return [yield_host(ctx, adapters, adapters.nurseHeal)];
  },
  // Lua: natives.lua:509
  // pokefirered/src/pokemon_storage_system_menu.c:354
  ShowPokemonStorageSystemPC: (ctx, adapters) => {
    if (!(adapters && truthy(adapters.openPc))) return [false];
    return [yield_host(ctx, adapters, (done) => {
      adapters.openPc(() => { done(); }, { mode: "storage" });
    })];
  },
  // Lua: natives.lua:516
  // pokefirered/src/player_pc.c:163
  PlayerPC: (ctx, adapters) => {
    if (!(adapters && truthy(adapters.openPc))) return [false];
    return [yield_host(ctx, adapters, (done) => {
      adapters.openPc(() => { done(); }, { mode: "player" });
    })];
  },
  // Lua: natives.lua:523
  // pokefirered/src/player_pc.c:151
  BedroomPC: (ctx, adapters) => {
    if (!(adapters && truthy(adapters.openPc))) return [false];
    return [yield_host(ctx, adapters, (done) => {
      adapters.openPc(() => {
        // pokefirered/data/maps/PalletTown_PlayersHouse_2F/scripts.inc:46
        Flags.setVar(undefined, ctx, 0x8004, 1);
        PcAnim.turnOff(ctx);
        if (done) done();
      }, { bedroom: true });
    })];
  },
  // Lua: natives.lua:536
  // pokefirered/src/field_specials.c:212
  AnimatePcTurnOn: (ctx) => {
    PcAnim.turnOn(ctx);
    return [false];
  },
  // Lua: natives.lua:541
  // pokefirered/src/field_specials.c:286
  AnimatePcTurnOff: (ctx) => {
    PcAnim.turnOff(ctx);
    return [false];
  },
  // Lua: natives.lua:546
  // pokefirered/src/script_menu.c:977
  CreatePCMenu: (ctx, adapters) => {
    if (!(adapters && truthy(adapters.openPc))) return [false];
    return [yield_host(ctx, adapters, (done) => {
      adapters.openPc((result: any) => {
        setResult(ctx, tonumber(result) ?? 127);
        done();
      }, { mode: "select" });
    })];
  },
  // Lua: natives.lua:556
  // pokefirered/src/hof_pc.c:23
  HallOfFamePCBeginFade: (ctx, adapters) => {
    if (!(adapters && truthy(adapters.hallOfFamePc))) return [false];
    return [yield_host(ctx, adapters, (done) => {
      adapters.hallOfFamePc(() => {
        // pokefirered/src/hof_pc.c:40
        adapters.openPc((result: any) => {
          setResult(ctx, tonumber(result) ?? 127);
          done();
        }, { mode: "select", reshow: true });
      });
    })];
  },
  // Lua: natives.lua:568
  ShowTownMap: (ctx, adapters) => {
    if (!(adapters && truthy(adapters.showTownMap))) return [false];
    return [yield_host(ctx, adapters, adapters.showTownMap)];
  },
  // Lua: natives.lua:573
  // Shared intro/field primitives (fade / naming / cry)
  FadeScreen: (ctx, adapters) => {
    if (!(adapters && truthy(adapters.fadeScreen))) return [false];
    return [yield_host(ctx, adapters, (done) => {
      adapters.fadeScreen(0, 1, done);
    })];
  },
  // Lua: natives.lua:579
  OpenNaming: (ctx, adapters) => {
    if (!(adapters && truthy(adapters.openNaming))) return [false];
    return [yield_host(ctx, adapters, (done) => {
      adapters.openNaming({ title: Strings("NAME?") }, done);
    })];
  },
  // Lua: natives.lua:586
  // pokefirered/src/easy_chat_2.c:256 ShowEasyChatScreen (special 0x5F / 95)
  ShowEasyChatScreen: (ctx, adapters) => {
    if (!(adapters && truthy(adapters.openEasyChat))) {
      setResult(ctx, 0);
      flagsMod().setVar(undefined, ctx, 0x8004, 1);
      return [false];
    }
    return [yield_host(ctx, adapters, (done) => {
      const chatType = flagsMod().getVar(undefined, ctx, 0x8004) ?? 0;
      // package.loaded["src.core.game3.runtime"]
      const session = Runtime && Runtime.getSession && Runtime.getSession();
      const currentWords = lor(session && session.easyChatProfile, EasyChatText.DEFAULT_PROFILE);
      adapters.openEasyChat({
        type: chatType,
        words: currentWords,
        session,
      }, (confirmed: any, words: any) => {
        if (truthy(confirmed)) {
          if (truthy(session)) {
            session.easyChatProfile = words;
            if (truthy(session.flags)) {
              session.flags[0x82D] = true;
              session.flags["FLAG_SYS_SET_TRAINER_CARD_PROFILE"] = true;
            }
          }
          const F = flagsMod();
          // package.loaded["src.core.game3.scripting.space"]
          const store = lor(Space && Space.store, session && session.store);
          if (truthy(store)) {
            F.setFlag(store, ctx, 0x82D, true);
          }
          if (chatType === 0) { // EASY_CHAT_TYPE_PROFILE
            let matches = true;
            for (let i = 1; i <= 4; i++) {
              if (words[i] !== EasyChatText.PASSPHRASE_MYSTERY_EVENT[i]) {
                matches = false;
                break;
              }
            }
            F.setVar(undefined, ctx, 0x8004, matches ? 0 : 1);
          } else if (chatType === 14) { // EASY_CHAT_TYPE_QUESTIONNAIRE
            let matches = true;
            for (let i = 1; i <= 4; i++) {
              if (words[i] !== EasyChatText.PASSPHRASE_QUESTIONNAIRE[i]) {
                matches = false;
                break;
              }
            }
            F.setVar(undefined, ctx, 0x8004, matches ? 0 : 1);
          } else {
            F.setVar(undefined, ctx, 0x8004, 1);
          }
          setResult(ctx, 1);
        } else {
          setResult(ctx, 0);
          flagsMod().setVar(undefined, ctx, 0x8004, 1);
        }
        done();
      });
    })];
  },
  // Lua: natives.lua:648
  // pokefirered/src/easy_chat.c:276 ShowEasyChatMessage (special 0x60 / 96)
  ShowEasyChatMessage: (_ctx, adapters) => {
    const session = Runtime && Runtime.getSession && Runtime.getSession();
    const words = lor(session && session.easyChatProfile, EasyChatText.DEFAULT_PROFILE);
    // The saved profile is a list of word ids; the words themselves are drawn
    // here, so they go through the catalog like the picker's own list.
    const text = EasyChatText.phrase(words, 2, 2);
    if (adapters && truthy(adapters.openMessage)) {
      adapters.openMessage(text);
    }
    return [false];
  },
  // Lua: natives.lua:663
  // pret EventScript_ChangePokemonNickname: fadescreen TO_BLACK → this → waitstate.
  // Opens naming under the held black, fades in, writes nickname on confirm.
  ChangePokemonNickname: (ctx, adapters) => {
    if (!(adapters && truthy(adapters.openNaming))) return [false];
    return [yield_host(ctx, adapters, (done) => {
      const mon = chosenMon(ctx);
      const species = (truthy(mon) ? tonumber(lor(mon.species, mon.speciesId)) : undefined) ?? 1;
      ensurePokemonNames(Pokemon);
      // pokefirered/src/field_specials.c:1656
      const before = nicknameOf(mon);
      setStringVar(ctx, adapters, 3, before);
      setStringVar(ctx, adapters, 2, before);
      const sname = Pokemon.name(species);
      adapters.openNaming({
        title: Naming.monTitle(sname),
        template: "NICKNAME",
        maxLen: 10, // pret POKEMON_NAME_LENGTH
        species,
        personality: truthy(mon) ? mon.personality : mon,
        gender: truthy(mon) ? mon.gender : mon,
      }, (name: any) => {
        if (truthy(mon) && typeof name === "string" && name !== "") {
          mon.nickname = name;
        }
        done();
      });
    })];
  },
  // Lua: natives.lua:691
  // pokefirered/src/field_specials.c:1629 ChangeBoxPokemonNickname
  ChangeBoxPokemonNickname: (ctx, adapters) => {
    const mon = boxedMon();
    if (!(truthy(mon) && adapters && truthy(adapters.openNaming))) return [false];
    return [yield_host(ctx, adapters, (done) => {
      const species = tonumber(lor(mon.species, mon.speciesId)) ?? 1;
      ensurePokemonNames(Pokemon);
      const before = nicknameOf(mon);
      setStringVar(ctx, adapters, 3, before);
      setStringVar(ctx, adapters, 2, before);
      const sname = Pokemon.name(species);
      adapters.openNaming({
        title: Naming.monTitle(sname),
        template: "NICKNAME",
        // pokefirered/include/constants/global.h:63
        maxLen: 10,
        species,
        personality: mon.personality,
        gender: mon.gender,
      }, (name: any) => {
        // pokefirered/src/field_specials.c:1647 SetBoxMonNickAt
        if (typeof name === "string" && name !== "") {
          mon.nickname = name;
          setStringVar(ctx, adapters, 2, name);
        }
        done();
      });
    })];
  },
  // Lua: natives.lua:721
  // pokefirered/src/field_specials.c:2478 BrailleCursorToggle
  BrailleCursorToggle: (ctx) => {
    // pcall(require, "src.ui.game3.braille")
    const okB = true;
    if (!(okB && typeof Braille === "object")) return [false];
    if (getSpecialVar(ctx, 0x8006) === 0) {
      try { Braille.setCursor(getSpecialVar(ctx, 0x8004) + 27, getSpecialVar(ctx, 0x8005)); } catch (_e) { /* pcall */ }
    } else {
      try { Braille.clearCursor(); } catch (_e) { /* pcall */ }
    }
    return [false];
  },
  // Lua: natives.lua:732
  // pokefirered/src/party_menu_specials.c:14
  ChoosePartyMon: (ctx, adapters) => {
    return [Natives.choosePartyMon(ctx, adapters, "choose_single")];
  },
  // Lua: natives.lua:736
  // pokefirered/src/party_menu.c:5793
  ChooseMonForMoveTutor: (ctx) => {
    // pokefirered/src/party_menu.c:855
    setResult(ctx, 0);
    return [false];
  },
  // Lua: natives.lua:742
  // pokefirered/src/field_specials.c:1677
  IsMonOTIDNotPlayers: (ctx) => {
    const [, session] = partyOf();
    const mon = chosenMon(ctx);
    const playerId = tonumber(session && lor(lor(session.trainerId, session.id), session.playerId)) ?? 0;
    const monOt = tonumber(mon && lor(mon.otId, mon.ot_id)) ?? playerId;
    setResult(ctx, monOt !== playerId ? 1 : 0);
    return [false];
  },
  // Lua: natives.lua:751
  // pokefirered/src/field_specials.c:1671
  BufferMonNickname: (ctx, adapters) => {
    setStringVar(ctx, adapters, 1, nicknameOf(chosenMon(ctx)));
    return [false];
  },
  // Lua: natives.lua:755
  PlayCry: (ctx) => {
    // package.loaded["src.core.game3.scripting.space"]
    const species = tonumber(Flags.getVar(Space && Space.store, ctx, 0x8000)) ?? 0;
    Audio.playCry(species);
    return [false];
  },
  // Lua: natives.lua:763
  EnableNationalPokedex: (_ctx, adapters) => {
    const store = Space && Space.store;
    if (truthy(store) && Flags && Flags.setFlag) {
      Flags.setFlag(store, undefined, 0x840, true); // FLAG_SYS_NATIONAL_DEX
      if (Flags.setVar) {
        Flags.setVar(store, undefined, 0x404E, 0x6258); // VAR_NATIONAL_DEX
      }
    }
    const session = Runtime && Runtime.getSession && Runtime.getSession();
    if (truthy(session)) {
      session.national_dex_unlocked = true;
      if (truthy(session.dex)) {
        session.dex.nationalUnlocked = true;
      }
      if (truthy(session.store) && Flags && Flags.setFlag) {
        Flags.setFlag(session.store, undefined, 0x840, true);
        if (Flags.setVar) {
          Flags.setVar(session.store, undefined, 0x404E, 0x6258);
        }
      }
    }
    if (adapters && truthy(adapters.setFlag)) {
      adapters.setFlag(0x840, true);
    }
    return [false];
  },
  // Lua: natives.lua:793
  // pokefirered/src/event_data.c:107 IsNationalPokedexEnabled
  IsNationalPokedexEnabled: (ctx) => {
    const session = Runtime && Runtime.getSession && Runtime.getSession();
    const dex = session && session.dex;
    const isUnlocked = PokedexData.isNationalUnlocked(session, dex);
    const resVal = isUnlocked ? 1 : 0;
    setResult(ctx, resVal);
    return [false, resVal];
  },
  // Lua: natives.lua:804
  // pokefirered/src/save_location.c:98
  SetUnlockedPokedexFlags: () => {
    const rt = Runtime;
    const session = rt && rt.getSession && rt.getSession();
    if (truthy(session)) {
      const bits = tonumber(session.gcnLinkFlags) ?? 0;
      session.gcnLinkFlags = bits | 0x31;
    }
    return [false];
  },
  // Lua: natives.lua:814
  EnterHallOfFame: (ctx, adapters) => {
    const flagGameClear = lor(Flags.IDS && Flags.IDS.SYS_GAME_CLEAR, 0x82C);
    const store = Space && Space.store;
    const session = Runtime && Runtime.getSession && Runtime.getSession();
    const set_flag = (id: any): void => {
      if (truthy(store) && Flags && Flags.setFlag) {
        Flags.setFlag(store, undefined, id, true);
      }
      if (adapters && truthy(adapters.setFlag)) {
        adapters.setFlag(id, true);
      }
      if (truthy(session) && truthy(session.store) && Flags && Flags.setFlag) {
        Flags.setFlag(session.store, undefined, id, true);
      }
    };
    if (truthy(session)) {
      Natives.enterHallOfFameState(session, set_flag);
    }
    set_flag(flagGameClear);
    if (truthy(session)) {
      session.game_cleared = true;
    }
    if (adapters && truthy(adapters.hallOfFame)) {
      return [yield_host(ctx, adapters, adapters.hallOfFame)];
    }
    return [false];
  },
};

const MODULE_DIR = "src/core/game3/scripting";
const MODULE_PACKAGE = "src.core.game3.scripting.";

const KNOWN_MODULES: LuaTable = seq(
  "natives_berry",
  "natives_blender",
  "natives_clock",
  "natives_contest",
  "natives_corner",
  "natives_cutscene",
  "natives_daycare",
  "natives_diploma_rse",
  "natives_dewford",
  "natives_elevator",
  "natives_events",
  "natives_easy_chat_profile_rse",
  "natives_fame",
  "natives_fan_club",
  "natives_field_rse",
  "natives_frontier_story",
  "natives_frontier_tutor_rse",
  "natives_game_corner_rse",
  "natives_egg_hatch_rse",
  "natives_ereader_rse",
  "natives_gift",
  "natives_lilycove_lady",
  "natives_link",
  "natives_listmenu",
  "natives_lottery",
  "natives_match_call",
  "natives_moveteach",
  "natives_old_man",
  "natives_pc_rse",
  "natives_pokeblock",
  "natives_puzzles_rse",
  "natives_queries",
  "natives_region_map_rse",
  "natives_scenes_rse",
  "natives_seagallop",
  "natives_secret_base",
  "natives_size_record",
  "natives_size_record_rse",
  "natives_tower",
  "natives_trade",
  "natives_tv",
  "natives_walda_rse",
  "natives_wireless",
  "natives_frontier",
  "natives_tower_rse",
  "natives_tents",
  "natives_link_rse",
  "natives_factory",
  "natives_pike",
  "natives_dome",
  "natives_palace",
  "natives_arena",
  "natives_pyramid",
  "natives_trainer_hill",
  "natives_apprentice",
  "natives_event_islands",
  "natives_shared_rse",
);

// NOT FAITHFUL: no filesystem module discovery. The natives_* modules that
// have a file in the port, in `ls` order; each entry loads its module (a thunk,
// so a module still initialising in an import cycle reads as a failed require).
// FRLG's profile also names natives_link and natives_wireless, which have no
// file in the port: their require fails, as in Lua when a module is missing.
const NATIVE_FILES: Record<string, () => any> = {
  natives_corner: () => Corner,
  natives_cutscene: () => Cutscene,
  natives_daycare: () => Daycare,
  natives_elevator: () => Elevator,
  natives_events: () => Events,
  natives_fame: () => Fame,
  natives_fan_club: () => FanClub,
  natives_gift: () => Gift,
  natives_listmenu: () => ListMenu,
  natives_moveteach: () => MoveTeach,
  natives_queries: () => Queries,
  natives_seagallop: () => SeagallopNatives,
  natives_size_record: () => SizeRecordNatives,
  natives_tower: () => TowerNatives,
  natives_trade: () => Trade,
  natives_tv: () => NativesTv,
};

/** Set when a bind met a module still initialising (see the port notes). */
let bindIncomplete = false;

// Lua: natives.lua:1017 pcall(require, MODULE_PACKAGE .. base)
function requireNative(base: string): [boolean, any] {
  const load = NATIVE_FILES[base];
  if (load == null) return [false, "module '" + MODULE_PACKAGE + base + "' not found"];
  try {
    return [true, load()];
  } catch (e) {
    if (e instanceof ReferenceError) bindIncomplete = true;
    return [false, e];
  }
}

// Lua: natives.lua:949
function moduleNames(profile?: any): LuaTable {
  const names = (lor(profile, undefined) ?? Profile.active()).nativeModules;
  return (typeof names === "object" && names != null) ? names : KNOWN_MODULES;
}

// Lua: natives.lua:955
function collectModule(names: LuaTable, seen: Record<string, boolean>, entry: any): void {
  const base = typeof entry === "string" ? match(entry, "^(natives_[%w_]+)%.lua$") : undefined;
  if (base != null && typeof base === "string" && !seen[base]) {
    seen[base] = true;
    names[len(names) + 1] = base;
  }
}

let listing: LuaTable | undefined;

// Lua: natives.lua:965
// NOT FAITHFUL: no filesystem module discovery (love.filesystem.getDirectoryItems
// / `ls`): the listing is NATIVE_FILES' names as "<name>.lua".
function listModuleDir(): LuaTable {
  if (listing) return listing;
  listing = seq();
  for (const name of Object.keys(NATIVE_FILES)) {
    listing[len(listing) + 1] = name + ".lua";
  }
  return listing;
}

// Lua: natives.lua:986
function discoverModules(profile?: any): LuaTable {
  profile = lor(profile, undefined) ?? Profile.active();
  const names: LuaTable = seq();
  const seen: Record<string, boolean> = {};
  if (truthy(profile.discoverNatives)) {
    for (const [, entry] of ipairs(listModuleDir())) collectModule(names, seen, entry);
  }
  for (const [, base] of ipairs(moduleNames(profile))) collectModule(names, seen, base + ".lua");
  sort(names);
  return names;
}

// Lua: natives.lua:1058
function log_once(kind: string, id: any, logger?: any, name?: any): void {
  const key = kind + ":" + tostring(id);
  if (Natives._logged[key]) return;
  Natives._logged[key] = true;
  let msg = format("[game3] skip unknown %s 0x%X", kind, tonumber(id) ?? 0);
  if (truthy(name)) msg = msg + " (" + tostring(name) + ")";
  if (truthy(logger)) logger(msg); else console.log(msg);
}

export const Natives = {
  ALLOW: {} as Record<string, any>,

  _logged: {} as Record<string, boolean>,

  // Lua: natives.lua:28
  yieldHost: yield_host,

  // Lua: natives.lua:31
  // pokefirered/src/script.c:366
  awaitState(ctx: any, task: any): void {
    if (typeof task !== "function") return;
    ctx.stateWait = task;
  },

  // Lua: natives.lua:133
  // pokefirered/src/party_menu_specials.c:14
  choosePartyMon(ctx: any, adapters: any, menuType: any): boolean {
    const [party, session] = partyOf();
    const resolveTo = (slot0: any): void => {
      setSpecialVar(ctx, 0x8004, slot0);
    };
    if (adapters && truthy(adapters.chooseParty)) {
      const restore = takeScreenForPartyMenu();
      return yield_host(ctx, adapters, (done) => {
        adapters.chooseParty({ menuType }, (slot0: any) => {
          resolveTo(tonumber(slot0) ?? SLOT_CANCEL);
          restore();
          done();
        });
      });
    }
    // pcall(require, "src.ui.game3.party_menu")
    const okUi = true;
    if (!(okUi && PartyMenu && truthy(PartyMenu.show) && truthy(party) && truthy(party[1]))) {
      resolveTo(SLOT_CANCEL);
      return false;
    }
    const restore = takeScreenForPartyMenu();
    let picked: any;
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      // pokefirered/src/party_menu.c:1252
      resolveTo(lor(picked, SLOT_CANCEL));
    };
    const yielded = yield_host(ctx, adapters, (done) => {
      PartyMenu.show(party, undefined, {
        mode: "choose",
        session,
        onSelect: (slot: any) => {
          picked = truthy(slot) ? ((tonumber(slot) ?? 1) - 1) : SLOT_CANCEL;
        },
        onClose: () => {
          restore();
          done();
        },
      });
    });
    if (!yielded) {
      settle();
      return false;
    }
    const closedPoll = ctx.nativePoll;
    ctx.nativePoll = () => {
      if (!truthy(closedPoll())) return false;
      settle();
      return true;
    };
    return true;
  },

  B_OUTCOME: {
    WON: B_OUTCOME_WON,
    LOST: B_OUTCOME_LOST,
    DREW: B_OUTCOME_DREW,
    RAN: B_OUTCOME_RAN,
    PLAYER_TELEPORTED: B_OUTCOME_PLAYER_TELEPORTED,
    MON_FLED: B_OUTCOME_MON_FLED,
    CAUGHT: B_OUTCOME_CAUGHT,
    NO_SAFARI_BALLS: B_OUTCOME_NO_SAFARI_BALLS,
    FORFEITED: B_OUTCOME_FORFEITED,
    MON_TELEPORTED: B_OUTCOME_MON_TELEPORTED,
  },
  // Lua: natives.lua:226
  outcome_to_code,

  // Lua: natives.lua:248
  // pokefirered/src/field_specials.c:552 SetVermilionTrashCans
  // Returns the 0-based tuple [first, second].
  setVermilionTrashCans(random: () => number): [number, number] {
    const first = mod(random(), 15) + 1;
    let second = first;
    const deltas = VERMILION_TRASH_ADJACENT[first];
    if (deltas) {
      second = mod(second + deltas[mod(random(), len(deltas)) + 1], 65536);
    }
    if (second > 15) {
      if (mod(first, 5) === 1) {
        second = first + 1;
      } else if (mod(first, 5) === 0) {
        second = first - 1;
      } else {
        second = first + 1;
      }
    }
    return [first, second];
  },

  CORE,

  // Lua: natives.lua:847
  // pokefirered/src/post_battle_event_funcs.c:12 EnterHallOfFame
  enterHallOfFameState(session: any, setFlag?: (id: number) => void): void {
    // pokefirered/src/post_battle_event_funcs.c:18
    Party.healAll(session.party);
    session.gameStats = (typeof session.gameStats === "object" && session.gameStats != null) ? session.gameStats : seq();
    // pokefirered/src/post_battle_event_funcs.c:28
    if ((tonumber(session.gameStats[1]) ?? 0) === 0) {
      const pt = lor(lor(session.playtime, session.playTime), {} as any);
      const h = tonumber(lor(pt.hours, session.playTimeHours)) ?? 0;
      const m = tonumber(lor(pt.minutes, session.playTimeMinutes)) ?? 0;
      const s = tonumber(lor(pt.seconds, session.playTimeSeconds)) ?? 0;
      session.gameStats[1] = (h << 16) | (m << 8) | s;
    }
    // pokefirered/src/load_save.c:144
    session.specialSaveWarpFlags = (tonumber(session.specialSaveWarpFlags) ?? 0) | 0x01;
    // pokefirered/src/overworld.c:694
    const dest = Field.flyDestination("MAPSEC_PALLET_TOWN");
    if (!truthy(dest)) throw new Error("no heal location for MAPSEC_PALLET_TOWN");
    session.continueGameWarp = { map: dest!.map, x: dest!.x, y: dest!.y };
    // pokefirered/src/post_battle_event_funcs.c:35
    let gave = false;
    for (let i = 1; i <= 6; i++) {
      const mon = (typeof session.party === "object" && session.party != null) ? session.party[i] : undefined;
      if (typeof mon === "object" && mon != null && !Pokemon.isEgg(mon) && !truthy(mon.championRibbon)) {
        mon.championRibbon = true;
        gave = true;
      }
    }
    if (gave) {
      // pokefirered/src/post_battle_event_funcs.c:47
      const n = tonumber(session.gameStats[42]) ?? 0;
      session.gameStats[42] = Math.min(0xFFFFFF, n + 1);
      if (setFlag) setFlag(0x83B); // pokefirered/include/constants/flags.h:1393
    }
  },

  KNOWN_MODULES,
  MODULE_DIR,

  // Lua: natives.lua:953
  moduleNames,
  // Lua: natives.lua:996
  discoverModules,

  // Lua: natives.lua:998
  versionOf(session?: any): string {
    return Profile.resolveId(lor(Profile.sessionVersion(session), undefined) ?? GameVersion.get());
  },

  // Set by bind (natives.lua:1030-1036).
  boundGame: undefined as string | undefined,
  boundVersion: undefined as string | undefined,
  BY_NAME: undefined as Record<string, any> | undefined,
  MODULE_NAMES: undefined as LuaTable,
  MODULES: undefined as Record<string, any> | undefined,
  Queries: undefined as any,
  Seagallop: undefined as any,

  // Lua: natives.lua:1002
  bind(version?: any): boolean {
    const id = Profile.resolveId(lor(version, undefined) ?? Natives.versionOf());
    const game = Constants.gameKey(id);
    if (Natives.boundGame === game) return false;
    const profile = Profile.of(id);
    const scope = { version: id };
    bindIncomplete = false;
    const names = discoverModules(profile);
    const modules: Record<string, any> = {};
    const byName: Record<string, any> = {};
    if (typeof profile.coreSpecials === "object" && profile.coreSpecials != null) {
      for (const [, name] of ipairs<string>(profile.coreSpecials)) {
        const fn = Natives.CORE[name];
        if (fn != null) byName[name] = fn;
      }
    } else {
      for (const [name, fn] of pairs(Natives.CORE)) byName[name] = fn;
    }
    for (const [, base] of ipairs<string>(names)) {
      if (Capabilities.nativeAllowed(scope, base)) {
        const [ok, m] = requireNative(base);
        if (ok && typeof m === "object" && m != null) {
          modules[base] = m;
          for (const [name, fn] of pairs(lor(m.BY_NAME, {}))) byName[name] = fn;
        }
      }
    }
    for (const [key] of pairs(Natives.ALLOW)) {
      if (sub(tostring(key), 1, 8) === "special:") delete Natives.ALLOW[key];
    }
    for (const [sid, fn] of pairs(Std.bindById(byName, game))) {
      Natives.ALLOW["special:" + tostring(sid)] = fn;
    }
    // NOT FAITHFUL: ES module cycle (see the port notes): an incomplete bind
    // leaves boundGame unset so the next ensureBound binds again.
    Natives.boundGame = bindIncomplete ? undefined : game;
    Natives.boundVersion = id;
    Natives.BY_NAME = byName;
    Natives.MODULE_NAMES = names;
    Natives.MODULES = modules;
    Natives.Queries = modules["natives_queries"];
    Natives.Seagallop = modules["natives_seagallop"];
    return true;
  },

  // Lua: natives.lua:1040
  ensureBound(session?: any): boolean {
    return Natives.bind(Natives.versionOf(session));
  },

  // Lua: natives.lua:1044
  specialName(specialId: any, game?: any): any {
    return Std.specialName(lor(lor(game, Natives.boundGame), "firered"), specialId);
  },

  // Lua: natives.lua:1048
  handlerFor(name: string): any {
    return (Natives.BY_NAME && Natives.BY_NAME[name]) ?? undefined;
  },

  // Lua: natives.lua:1054
  resetLog(): void {
    Natives._logged = {};
  },

  /** Returns whether the VM should yield (native wait). */
  // Lua: natives.lua:1068
  log_once,

  // Lua: natives.lua:1070
  callnative(ctx: any, fnAddr: any, adapters?: any): boolean {
    const id = tonumber(fnAddr) ?? 0;
    const handler = Natives.ALLOW["native:" + tostring(id)];
    if (truthy(handler)) {
      return truthy(ret(handler(ctx, adapters))[0]);
    }
    log_once("callnative", id, adapters && adapters.log);
    return false;
  },

  // src/scrcmd.c:92-97
  NATIVE_SYMBOLS: {} as Record<number, any>,
  // Lua: natives.lua:1082
  resolveNative(addr: any): any {
    const id = tonumber(addr) ?? 0;
    const sym = Natives.NATIVE_SYMBOLS[id];
    if (truthy(sym)) {
      const fn = Natives.ALLOW["native:" + tostring(sym)];
      if (truthy(fn)) return fn;
    }
    return Natives.ALLOW["native:" + tostring(id)];
  },

  // Lua: natives.lua:1092
  // Returns the 0-based tuple [yield, value, known].
  special(ctx: any, specialId: any, adapters?: any): [boolean, any, boolean] {
    Natives.ensureBound();
    const id = tonumber(specialId) ?? 0;
    const handler = Natives.ALLOW["special:" + tostring(id)];
    if (truthy(handler)) {
      const [yld, value] = ret(handler(ctx, adapters));
      return [truthy(yld), value, true];
    }
    log_once("special", id, adapters && adapters.log, Natives.specialName(id));
    return [false, undefined, false];
  },
};

// Lua: natives.lua:1052
// NOT FAITHFUL: ES module cycle — a module still initialising (ReferenceError)
// leaves the bind to the next ensureBound (see the port notes).
try {
  Natives.bind();
} catch (e) {
  if (!(e instanceof ReferenceError)) throw e;
  Natives.boundGame = undefined;
}

export default Natives;
