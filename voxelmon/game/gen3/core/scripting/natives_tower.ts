// Port of gen1recomp src/core/game3/scripting/natives_tower.lua (GPLv3 + additional terms; see LICENSE.md).
// Trainer Tower specials (pokefirered/src/trainer_tower.c CallTrainerTowerFunc
// and its FUNCS), party save/load/reduce, half-party choice, e-Reader trainer,
// battle records, StartSpecialBattle.
//
// Port notes:
// - Handlers return Lua's multiple returns as a 0-based tuple (natives.ts):
//   setResult returns [false, value]; runBattle / yieldHost booleans are
//   [bool]. singlesGfxFor / doublesGfxFor / currentFloor return tuples.
// - Tower.record returns Lua's two values as a tuple; `local rec =
//   Tower.record(...)` takes [0]. Tower.MUS_ENCOUNTER_BOY is not defined in
//   Brian's trainer_tower.lua either (nil), so it is read through `any`.
// - pcall(require, "src.ui.game3.trainer_tower_records") has no module here
//   (other workers' UI): it is looked up in G3Lazy; absent, Brian's
//   failed-require path (log, no screen).
// - pcall(require) / package.loaded / require of ops_a, fade, audio, bag,
//   items_data, party, easy_chat_text, runtime, space, flags, natives: static
//   imports treated as loaded.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tonumber, tostring } from "../../../../import/gen3/lua.ts";
import Std from "./stdscripts.ts";
import { Tower } from "../trainer_tower.ts";
import Flags from "./flags.ts";
import Space from "./space.ts";
import { Runtime } from "../runtime.ts";
import { G3Lazy } from "../lazy_registry.ts";
import { Ops } from "./ops_a.ts";
import { EasyChatText } from "../easy_chat_text.ts";
import { Fade as FadeMod } from "../../ui/fade.ts";
import { Bag } from "../bag.ts";
import { ItemsData } from "../items_data.ts";
import { Party } from "../party.ts";
import { Audio as AudioMod } from "../audio.ts";
import Natives, { type Handler, type HandlerRet } from "./natives.ts";


// pokefirered/include/constants/vars.h:319
const VAR_0x8004 = 0x8004;
const VAR_0x8005 = 0x8005;
const VAR_0x8006 = 0x8006;
// pokefirered/include/constants/vars.h:328
const VAR_RESULT = 0x800D;
// pokefirered/include/constants/vars.h:333
const VAR_TEXT_COLOR = 0x8012;
const VAR_PREV_TEXT_COLOR = 0x8013;
// pokefirered/include/constants/vars.h:9
const VAR_TEMP_1 = 0x4001;
const VAR_TEMP_3 = 0x4003;
// pokefirered/include/constants/vars.h:28
const VAR_OBJ_GFX_ID_0 = 0x4010;
const VAR_OBJ_GFX_ID_1 = 0x4011;
const VAR_OBJ_GFX_ID_2 = 0x4012;
const VAR_OBJ_GFX_ID_3 = 0x4013;

// pokefirered/include/constants/global.h:85
const MALE = 0, FEMALE = 1;

// pokefirered/include/constants/battle.h:76
const B_OUTCOME_WON = 1, B_OUTCOME_LOST = 2;

// pokefirered/include/constants/party_menu.h:59
const PARTY_MENU_TYPE_CHOOSE_MULTIPLE_MONS = 4;
// pokefirered/include/constants/party_menu.h:133
const CHOOSE_MONS_FOR_CABLE_CLUB_BATTLE = 0;

// pokefirered/src/battle_tower.c:902
const SPECIAL_BATTLE = { BATTLE_TOWER: 0, SECRET_BASE: 1, EREADER: 2 };

// Lua: natives_tower.lua:38
function flagsMod(): typeof Flags {
  return Flags;
}

// Lua: natives_tower.lua:42
function sessionOf(): any {
  const rt: any = Runtime;
  return (rt && rt.getSession && rt.getSession()) || undefined;
}

// Lua: natives_tower.lua:47
function scriptStore(): any {
  const S: any = Space;
  const session = sessionOf();
  return (S && S.store) || (session && session.store) || undefined;
}

// Lua: natives_tower.lua:53
function varGet(ctx: any, id: number): number {
  return tonumber(flagsMod().getVar(scriptStore(), ctx, id)) ?? 0;
}

// Lua: natives_tower.lua:57
function varSet(ctx: any, id: number, value: any): void {
  flagsMod().setVar(scriptStore(), ctx, id, tonumber(value) ?? 0);
}

// Lua: natives_tower.lua:62
// pokefirered/src/scrcmd.c:99
function setResult(ctx: any, value: any): HandlerRet {
  varSet(ctx, VAR_RESULT, value);
  return [false, tonumber(value) ?? 0];
}

// Lua: natives_tower.lua:67
function setStringVar(ctx: any, adapters: any, index: number, text: any): void {
  if (adapters && adapters.setStringVar) { try { adapters.setStringVar(index, text); } catch { /* pcall */ } }
  if (ctx && ctx.stringVars) ctx.stringVars[index] = text;
}

// Lua: natives_tower.lua:72
function log(msg: string): void {
  TowerNatives._logged = TowerNatives._logged || {};
  if (TowerNatives._logged[msg]) return;
  TowerNatives._logged[msg] = true;
  console.log("[game3/tower] " + tostring(msg));
}

// Lua: natives_tower.lua:79
function currentFloor(session: any): [any, any] {
  const floorIdx = Tower.floorIndexForMap(session && session.map);
  if (!floorIdx) return [undefined, undefined];
  return [Tower.floor(Tower.getChallengeId(session), floorIdx), floorIdx];
}

// Lua: natives_tower.lua:85
function trainerRow(floor: any, index: any): any {
  const rows = floor && floor.trainers;
  if (typeof rows !== "object" || rows == null) return undefined;
  return rows[(tonumber(index) ?? 0) + 1];
}

// Lua: natives_tower.lua:92
// pokefirered/src/trainer_tower.c:105
function singlesGfxFor(facilityClass: any): [number, number] {
  const pack = Tower.pack();
  const info = pack && pack.singlesTrainerInfo;
  const row = (typeof info === "object" && info != null && facilityClass != null) ? info[facilityClass] : undefined;
  if (row) return [tonumber(row.objGfx) ?? Tower.GFX_YOUNGSTER, tonumber(row.gender) ?? MALE];
  // pokefirered/src/trainer_tower.c:576
  return [Tower.GFX_YOUNGSTER, MALE];
}

// Lua: natives_tower.lua:102
// pokefirered/src/trainer_tower.c:191
function doublesGfxFor(facilityClass: any): [number, number, number, number] {
  const pack = Tower.pack();
  const info = pack && pack.doublesTrainerInfo;
  const row = (typeof info === "object" && info != null && facilityClass != null) ? info[facilityClass] : undefined;
  if (row) {
    return [tonumber(row.objGfx1) ?? Tower.GFX_YOUNGSTER,
      tonumber(row.objGfx2) ?? Tower.GFX_YOUNGSTER,
      tonumber(row.gender1) ?? FEMALE,
      tonumber(row.gender2) ?? MALE];
  }
  // pokefirered/src/trainer_tower.c:594
  return [Tower.GFX_YOUNGSTER, Tower.GFX_YOUNGSTER, MALE, MALE];
}

// Lua: natives_tower.lua:117
// pokefirered/src/trainer_tower.c:559
function setNpcGraphics(ctx: any, floor: any): void {
  const challengeType = floor && floor.challengeType;
  if (challengeType === Tower.CHALLENGE_TYPE.SINGLE) {
    const row = trainerRow(floor, 0);
    varSet(ctx, VAR_OBJ_GFX_ID_1, singlesGfxFor(row && row.facilityClass)[0]);
  } else if (challengeType === Tower.CHALLENGE_TYPE.DOUBLE) {
    const row = trainerRow(floor, 0);
    const [gfx1, gfx2] = doublesGfxFor(row && row.facilityClass);
    varSet(ctx, VAR_OBJ_GFX_ID_0, gfx1);
    varSet(ctx, VAR_OBJ_GFX_ID_3, gfx2);
  } else if (challengeType === Tower.CHALLENGE_TYPE.KNOCKOUT) {
    const slots: number[] = [VAR_OBJ_GFX_ID_2, VAR_OBJ_GFX_ID_0, VAR_OBJ_GFX_ID_1];
    for (let j = 0; j <= Tower.MAX_TRAINERS_PER_FLOOR - 1; j++) {
      const row = trainerRow(floor, j);
      varSet(ctx, slots[j]!, singlesGfxFor(row && row.facilityClass)[0]);
    }
  }
}

// Lua: natives_tower.lua:137
// pokefirered/src/overworld.c:978 SetCurrentMapLayout
function setCurrentMapLayout(layoutId: any, mapId: any): boolean {
  if (!layoutId) return false;
  if (layoutId === Tower.layoutIdForMap(mapId)) return true;
  // pcall(require, "src.core.game3.scripting.ops_a")
  const O: any = Ops;
  if (!(O && O.setMapLayout)) return false;
  let ok = true;
  let applied: any;
  try { applied = O.setMapLayout(layoutId, undefined); } catch { ok = false; }
  if (!(ok && applied)) {
    log("layout " + tostring(layoutId) + " is not baked in this cache");
    return false;
  }
  return true;
}

// Lua: natives_tower.lua:151
// pokefirered/src/trainer_tower.c:682
function setOpponentTextColor(ctx: any, challengeType: any, facilityClass: any): void {
  let gender = MALE;
  if (challengeType === Tower.CHALLENGE_TYPE.DOUBLE) {
    const [, , gender1, gender2] = doublesGfxFor(facilityClass);
    gender = (varGet(ctx, VAR_TEMP_3) !== 0) ? gender2 : gender1;
  } else {
    const [, g] = singlesGfxFor(facilityClass);
    gender = g;
  }
  varSet(ctx, VAR_PREV_TEXT_COLOR, varGet(ctx, VAR_TEXT_COLOR));
  varSet(ctx, VAR_TEXT_COLOR, gender);
}

// Lua: natives_tower.lua:165
// pokefirered/src/trainer_tower.c:631
function convertSpeech(words: any): string {
  if (typeof words !== "object" || words == null) return "";
  return EasyChatText.phrase(words, 3, 2);
}

// Lua: natives_tower.lua:170
function natives(): typeof Natives {
  return Natives;
}

// Lua: natives_tower.lua:174
function recordsScreen(): any {
  // pcall(require, "src.ui.game3.trainer_tower_records")
  const Screen = G3Lazy["src.ui.game3.trainer_tower_records"];
  if (typeof Screen === "object" && Screen != null && Screen.show) return Screen;
  log("the trainer tower records screen could not be loaded");
  return undefined;
}

// Lua: natives_tower.lua:182
// pokefirered/src/party_menu_specials.c:38, pokefirered/src/party_menu.c:6317
function takeScreenForPartyMenu(): () => void {
  // pcall(require, "src.ui.game3.fade")
  const Fade: any = FadeMod;
  if (!(Fade && Fade.begin && Fade.MODE)) return () => {};
  const covered = !(Fade.isActive && Fade.isActive()) && (tonumber(Fade.t) ?? 0) >= 16;
  // pokefirered/src/party_menu.c:6329 FadeInFromBlack
  if (!(covered && Fade.mode === Fade.MODE.TO_BLACK)) return () => {};
  Fade.clear();
  return () => {
    Fade.begin(Fade.MODE.FROM_BLACK, 1, () => {});
  };
}

// Lua: natives_tower.lua:195
// pokefirered/src/trainer_tower.c:722
function runBattle(ctx: any, adapters: any, foe: any, battleOpts: any, after?: (outcome: number) => void): boolean {
  const N = natives();
  let outcome = B_OUTCOME_LOST;
  let settled = false;
  const settle = (): void => {
    if (settled) return;
    settled = true;
    if (after) after(outcome);
    varSet(ctx, VAR_RESULT, outcome);
  };
  if (!(adapters && adapters.startTrainerBattle)) {
    log("no startTrainerBattle host seam, so the battle cannot run");
    settle();
    return false;
  }
  const yielded = N.yieldHost(ctx, adapters, (done) => {
    adapters.startTrainerBattle(foe, (result: any) => {
      outcome = N.outcome_to_code(result || "win");
      done();
    }, battleOpts);
  });
  if (!yielded) {
    settle();
    return false;
  }
  const closedPoll = ctx.nativePoll;
  ctx.nativePoll = () => {
    if (closedPoll && !closedPoll()) return false;
    settle();
    return true;
  };
  return true;
}

// Lua: natives_tower.lua:229 (FUNCS, keyed by Tower.FUNC ids). Built on first
// use: module scope must not read the import cycle (Tower.FUNC).
let FUNCS_: Record<number, Handler> | undefined;
function funcs(): Record<number, Handler> {
if (FUNCS_) return FUNCS_;
const FUNCS: Record<number, Handler> = {};
FUNCS_ = FUNCS;

// Lua: natives_tower.lua:232
// pokefirered/src/trainer_tower.c:544 InitTrainerTowerFloor
FUNCS[Tower.FUNC.INIT_FLOOR] = (ctx) => {
  const session = sessionOf();
  const mapId = session && session.map;
  if (Tower.isPastFinalFloor(mapId)) {
    setResult(ctx, 3);
    setCurrentMapLayout(Tower.LAYOUT_ROOF, mapId);
    return [false];
  }
  const [floor, floorIdx] = currentFloor(session);
  if (!floor) {
    log("InitTrainerTowerFloor outside a tower floor map: " + tostring(mapId));
    return [false];
  }
  setResult(ctx, floor.challengeType);
  setCurrentMapLayout(Tower.floorLayoutFor(floorIdx, floor.challengeType), mapId);
  setNpcGraphics(ctx, floor);
  return [false];
};

// Lua: natives_tower.lua:252
// pokefirered/src/trainer_tower.c:651 BufferTowerOpponentSpeech
FUNCS[Tower.FUNC.GET_SPEECH] = (ctx, adapters) => {
  const session = sessionOf();
  const [floor] = currentFloor(session);
  if (!floor) return [false];
  const trainerId = varGet(ctx, VAR_0x8006);
  const challengeType = floor.challengeType;
  const classRow = (challengeType !== Tower.CHALLENGE_TYPE.DOUBLE)
    ? trainerRow(floor, trainerId) : trainerRow(floor, 0);
  const facilityClass = classRow && classRow.facilityClass;
  const row = trainerRow(floor, trainerId);
  const which = varGet(ctx, VAR_0x8005);
  let words: any;
  if (which === Tower.TEXT.INTRO) {
    setOpponentTextColor(ctx, challengeType, facilityClass);
    words = row && row.speechBefore;
  } else if (which === Tower.TEXT.PLAYER_LOST) {
    setOpponentTextColor(ctx, challengeType, facilityClass);
    words = row && row.speechWin;
  } else if (which === Tower.TEXT.PLAYER_WON) {
    setOpponentTextColor(ctx, challengeType, facilityClass);
    words = row && row.speechLose;
  } else if (which === Tower.TEXT.AFTER) {
    words = row && row.speechAfter;
  }
  setStringVar(ctx, adapters, 4, convertSpeech(words));
  return [false];
};

// Lua: natives_tower.lua:281
// pokefirered/src/trainer_tower.c:733 DoTrainerTowerBattle
FUNCS[Tower.FUNC.DO_BATTLE] = (ctx, adapters) => {
  const session = sessionOf();
  const [floor] = currentFloor(session);
  const foe = floor && Tower.battleFoe(session, floor, varGet(ctx, VAR_TEMP_1));
  if (!foe) {
    log("DoTrainerTowerBattle has no floor trainers in this cache");
    // pokefirered/include/constants/battle.h:77 B_OUTCOME_LOST
    return setResult(ctx, B_OUTCOME_LOST);
  }
  // pokefirered/src/trainer_tower.c:735 BATTLE_TYPE_TRAINER_TOWER
  return [runBattle(ctx, adapters, foe, {
    trainerId: 0,
    double: floor.challengeType === Tower.CHALLENGE_TYPE.DOUBLE,
    trainerTower: true,
    // pokefirered/src/battle_message.c:2066 GetTrainerTowerOpponentName
    trainerName: foe.trainerName,
    trainerPicId: foe.trainerPicId,
    // pokefirered/src/trainer_tower.c:717 CB2_EndTrainerTowerBattle
    noWhiteout: true,
  })];
};

// Lua: natives_tower.lua:304
// pokefirered/src/trainer_tower.c:747 TrainerTowerGetChallengeType
FUNCS[Tower.FUNC.GET_CHALLENGE_TYPE] = (ctx) => {
  if (varGet(ctx, VAR_0x8005) !== 0) return [false];
  const [floor] = currentFloor(sessionOf());
  if (!floor) return [false];
  return setResult(ctx, floor.challengeType);
};

// Lua: natives_tower.lua:312
// pokefirered/src/trainer_tower.c:753 TrainerTowerAddFloorCleared
FUNCS[Tower.FUNC.CLEARED_FLOOR] = () => {
  Tower.addFloorCleared(sessionOf());
  return [false];
};

// Lua: natives_tower.lua:318
// pokefirered/src/trainer_tower.c:759 GetFloorAlreadyCleared
FUNCS[Tower.FUNC.GET_FLOOR_CLEARED] = (ctx) => {
  const session = sessionOf();
  const cleared = Tower.isFloorAlreadyCleared(session, session && session.map);
  return setResult(ctx, cleared ? 1 : 0);
};

// Lua: natives_tower.lua:325
// pokefirered/src/trainer_tower.c:769 StartTrainerTowerChallenge
FUNCS[Tower.FUNC.START_CHALLENGE] = (ctx) => {
  Tower.startChallenge(sessionOf(), varGet(ctx, VAR_0x8005));
  return [false];
};

// Lua: natives_tower.lua:331
// pokefirered/src/trainer_tower.c:786 GetOwnerState
FUNCS[Tower.FUNC.GET_OWNER_STATE] = (ctx) => {
  const session = sessionOf();
  Tower.setTimerRunning(session, false);
  const rec = Tower.record(session)[0];
  let result = 0;
  if (rec.spokeToOwner) result = result + 1;
  if (rec.receivedPrize && rec.checkedFinalTime) result = result + 1;
  rec.spokeToOwner = true;
  return setResult(ctx, result);
};

// Lua: natives_tower.lua:343
// pokefirered/src/trainer_tower.c:799 GiveChallengePrize
FUNCS[Tower.FUNC.GIVE_PRIZE] = (ctx, adapters) => {
  const session = sessionOf();
  const rec = Tower.record(session)[0];
  if (rec.receivedPrize) return setResult(ctx, 2);
  const itemId = Tower.prizeItem(session);
  // pokefirered/src/trainer_tower.c:805 the bag-full branch, taken when the set is unknown
  if (!itemId) return setResult(ctx, 1);
  const bag = session && session.bag;
  const added = bag && Bag.add(bag, itemId, 1);
  if (!added) return setResult(ctx, 1);
  setStringVar(ctx, adapters, 2, ItemsData.displayName(itemId) || "");
  rec.receivedPrize = true;
  return setResult(ctx, 0);
};

// Lua: natives_tower.lua:361
// pokefirered/src/trainer_tower.c:819 CheckFinalTime
FUNCS[Tower.FUNC.CHECK_FINAL_TIME] = (ctx) => {
  const session = sessionOf();
  const rec = Tower.record(session)[0];
  let result: number;
  if (rec.checkedFinalTime) {
    result = 2;
  } else if (Tower.bestTime(session) > rec.timer) {
    Tower.setBestTime(session, rec.timer);
    result = 0;
  } else {
    result = 1;
  }
  rec.checkedFinalTime = true;
  return setResult(ctx, result);
};

// Lua: natives_tower.lua:378
// pokefirered/src/trainer_tower.c:838 TrainerTowerResumeTimer
FUNCS[Tower.FUNC.RESUME_TIMER] = () => {
  Tower.resumeTimer(sessionOf());
  return [false];
};

// Lua: natives_tower.lua:384
// pokefirered/src/trainer_tower.c:849 TrainerTowerSetPlayerLost
FUNCS[Tower.FUNC.SET_LOST] = () => {
  Tower.record(sessionOf())[0].hasLost = true;
  return [false];
};

// Lua: natives_tower.lua:390
// pokefirered/src/trainer_tower.c:854 GetTrainerTowerChallengeStatus
FUNCS[Tower.FUNC.GET_CHALLENGE_STATUS] = (ctx) => {
  const rec = Tower.record(sessionOf())[0];
  if (rec.hasLost) {
    rec.hasLost = false;
    return setResult(ctx, Tower.CHALLENGE_STATUS.LOST);
  }
  if (rec.statusUnk) {
    rec.statusUnk = false;
    return setResult(ctx, Tower.CHALLENGE_STATUS.UNK);
  }
  return setResult(ctx, Tower.CHALLENGE_STATUS.NORMAL);
};

// Lua: natives_tower.lua:404
// pokefirered/src/trainer_tower.c:888 GetCurrentTime
FUNCS[Tower.FUNC.GET_TIME] = (ctx, adapters) => {
  const session = sessionOf();
  const [minutes, seconds, centiseconds] = Tower.formatTime(Tower.readTime(session));
  setStringVar(ctx, adapters, 1, minutes);
  setStringVar(ctx, adapters, 2, seconds);
  setStringVar(ctx, adapters, 3, centiseconds);
  return [false];
};

// Lua: natives_tower.lua:414
// pokefirered/src/trainer_tower.c:899 ShowResultsBoard
FUNCS[Tower.FUNC.SHOW_RESULTS] = (ctx) => {
  const Screen = recordsScreen();
  if (!Screen) {
    varSet(ctx, VAR_TEMP_1, 0);
    return [false];
  }
  Screen.show({ session: sessionOf(), kind: "board" });
  varSet(ctx, VAR_TEMP_1, Screen.BOARD_WINDOW_ID);
  return [false];
};

// Lua: natives_tower.lua:426
// pokefirered/src/trainer_tower.c:924 CloseResultsBoard
FUNCS[Tower.FUNC.CLOSE_RESULTS] = (ctx) => {
  const Screen = recordsScreen();
  if (!Screen) return [false];
  if (varGet(ctx, VAR_TEMP_1) !== Screen.BOARD_WINDOW_ID) return [false];
  Screen.close();
  return [false];
};

// Lua: natives_tower.lua:435
// pokefirered/src/trainer_tower.c:931 TrainerTowerGetDoublesEligiblity
FUNCS[Tower.FUNC.CHECK_DOUBLES] = (ctx) => {
  const session = sessionOf();
  return setResult(ctx, Party.monsStateToDoubles(session && session.party));
};

// Lua: natives_tower.lua:442
// pokefirered/src/trainer_tower.c:937 TrainerTowerGetNumFloors
FUNCS[Tower.FUNC.GET_NUM_FLOORS] = (ctx, adapters) => {
  const [differs, numFloors] = Tower.numFloorsResult(Tower.getChallengeId(sessionOf()));
  if (differs) {
    setStringVar(ctx, adapters, 1, tostring(numFloors));
    return setResult(ctx, 1);
  }
  return setResult(ctx, 0);
};

// Lua: natives_tower.lua:452
// pokefirered/src/trainer_tower.c:952 ShouldWarpToCounter
FUNCS[Tower.FUNC.SHOULD_WARP_TO_COUNTER] = (ctx) => {
  return setResult(ctx, 0);
};

// Lua: natives_tower.lua:457
// pokefirered/src/trainer_tower.c:960 PlayTrainerTowerEncounterMusic
FUNCS[Tower.FUNC.ENCOUNTER_MUSIC] = (ctx) => {
  const [floor] = currentFloor(sessionOf());
  const row = trainerRow(floor, varGet(ctx, VAR_TEMP_1));
  const pack = Tower.pack();
  const lut = pack && pack.encounterMusic;
  const song = row && row.facilityClass && typeof lut === "object" && lut != null && lut[row.facilityClass];
  // pcall(require, "src.core.game3.audio")
  const Audio: any = AudioMod;
  if (Audio && Audio.playSong) {
    // pokefirered/src/sound.c:129 PlayNewMapMusic
    try { Audio.playSong(tonumber(song) ?? (Tower as any).MUS_ENCOUNTER_BOY); } catch { /* pcall */ }
  }
  return [false];
};

// Lua: natives_tower.lua:472
// pokefirered/src/trainer_tower.c:983 HasSpokenToOwner
FUNCS[Tower.FUNC.GET_BEAT_CHALLENGE] = (ctx) => {
  return setResult(ctx, Tower.record(sessionOf())[0].spokeToOwner ? 1 : 0);
};

return FUNCS;
}

const BY_NAME: Record<string, Handler> = {
  // Lua: natives_tower.lua:492
  // pokefirered/src/trainer_tower.c:438 CallTrainerTowerFunc
  CallTrainerTowerFunc: (ctx, adapters) => {
    const index = varGet(ctx, VAR_0x8004);
    const fn = funcs()[index];
    if (!fn) {
      log("CallTrainerTowerFunc index out of range: " + tostring(index));
      return [false];
    }
    return fn(ctx, adapters);
  },

  // Lua: natives_tower.lua:503
  // pokefirered/src/load_save.c:160 SavePlayerParty
  SavePlayerParty: () => {
    Tower.savePlayerParty(sessionOf());
    return [false];
  },

  // Lua: natives_tower.lua:509
  // pokefirered/src/load_save.c:170 LoadPlayerParty
  LoadPlayerParty: () => {
    Tower.loadPlayerParty(sessionOf());
    return [false];
  },

  // Lua: natives_tower.lua:515
  // pokefirered/src/script_pokemon_util.c:197 ReducePlayerPartyToThree
  ReducePlayerPartyToThree: () => {
    Tower.reducePartyToThree(sessionOf());
    return [false];
  },

  // Lua: natives_tower.lua:521
  // pokefirered/src/script_pokemon_util.c:152 ChooseHalfPartyForBattle
  ChooseHalfPartyForBattle: (ctx, adapters) => {
    const session = sessionOf();
    Tower.clearSelectedOrder(session);
    let picked: any;
    let settled = false;
    const restore = takeScreenForPartyMenu();
    const settle = (): void => {
      if (settled) return;
      settled = true;
      const order = Tower.setSelectedOrder(session, picked);
      // pokefirered/src/script_pokemon_util.c:159 CB2_ReturnFromChooseHalfParty
      varSet(ctx, VAR_RESULT, (order[1] !== 0) ? 1 : 0);
    };
    if (!(adapters && adapters.chooseParty)) {
      settle();
      restore();
      return [false];
    }
    const yielded = natives().yieldHost(ctx, adapters, (done) => {
      adapters.chooseParty(TowerNatives.chooseOptions(), (chosen: any) => {
        picked = chosen;
        restore();
        done();
      });
    });
    if (!yielded) {
      settle();
      return [false];
    }
    const closedPoll = ctx.nativePoll;
    ctx.nativePoll = () => {
      if (closedPoll && !closedPoll()) return false;
      settle();
      return true;
    };
    return [true];
  },

  // Lua: natives_tower.lua:559
  // pokefirered/src/battle_tower.c:1354 ValidateEReaderTrainer
  ValidateEReaderTrainer: (ctx) => {
    // pokefirered/data/maps/SevenIsland_House_Room1/scripts.inc:9
    return setResult(ctx, Tower.ereaderTrainer(sessionOf()) ? 0 : 1);
  },

  // Lua: natives_tower.lua:565
  // pokefirered/src/battle_records.c:83 ShowBattleRecords
  ShowBattleRecords: (ctx, adapters) => {
    const session = sessionOf();
    // pokefirered/src/battle_records.c:136
    const kind = (varGet(ctx, VAR_0x8004) !== 0) ? "tower" : "link";
    const Screen = recordsScreen();
    // src/battle_records.c:83, cable_club.inc:566-575
    if (!Screen) {
      takeScreenForPartyMenu()();
      return [natives().yieldHost(ctx, adapters, (done) => { done(); })];
    }
    return [natives().yieldHost(ctx, adapters, (done) => {
      Screen.show({ session, kind, onDone: done });
    })];
  },

  // Lua: natives_tower.lua:581
  // pokefirered/src/battle_tower.c:895 StartSpecialBattle
  StartSpecialBattle: (ctx, adapters) => {
    const session = sessionOf();
    const which = varGet(ctx, VAR_0x8004);
    let foe: any;
    let after: ((outcome: number) => void) | undefined;
    if (which === SPECIAL_BATTLE.EREADER) {
      foe = Tower.ereaderFoe(session);
      after = (outcome) => {
        // pokefirered/src/battle_tower.c:1406 PrintEReaderTrainerFarewellMessage
        const trainer = session && session.ereaderTrainer;
        const words = trainer
          && ((outcome === B_OUTCOME_WON) ? trainer.farewellPlayerWon : trainer.farewellPlayerLost);
        setStringVar(ctx, adapters, 4, convertSpeech(words));
      };
    } else if (which === SPECIAL_BATTLE.SECRET_BASE) {
      // pokefirered/src/battle_tower.c:915
      Tower.copyHeldItems(session, true);
    }
    if (!foe) {
      log("StartSpecialBattle " + tostring(which) + " has no opponent data in this save");
      return setResult(ctx, B_OUTCOME_LOST);
    }
    // pokefirered/src/battle_tower.c:933 BATTLE_TYPE_EREADER_TRAINER
    return [runBattle(ctx, adapters, foe, {
      trainerId: 0,
      eReader: which === SPECIAL_BATTLE.EREADER,
      // src/battle_tower.c:895-933
      battleTower: which === SPECIAL_BATTLE.BATTLE_TOWER,
      secretBase: which === SPECIAL_BATTLE.SECRET_BASE,
      // pokefirered/src/battle_message.c:2072 CopyEReaderTrainerName5
      trainerName: foe.trainerName,
      trainerPicId: foe.trainerPicId,
      noWhiteout: true,
    }, after)];
  },
};

export const TowerNatives = {
  _logged: undefined as Record<string, boolean> | undefined,
  // Lua: natives_tower.lua:476 (built on first read; see funcs())
  get FUNCS(): Record<number, Handler> { return funcs(); },

  // Lua: natives_tower.lua:479
  // pokefirered/src/party_menu.c:5651 InitChooseMonsForBattle
  chooseOptions(): any {
    return {
      menuType: PARTY_MENU_TYPE_CHOOSE_MULTIPLE_MONS,
      mode: "choose_multi",
      count: Tower.SELECTED_ORDER_SIZE,
      min: 1,
      // pokefirered/src/party_menu.c:5687 the menu's own default is this rule
      chooseMonsBattleType: CHOOSE_MONS_FOR_CABLE_CLUB_BATTLE,
    };
  },

  BY_NAME,
  /** Set by Std.legacyHandlers: special id -> handler. */
  HANDLERS: undefined as Record<number, Handler> | undefined,
};
// Lua: natives_tower.lua:616
Std.legacyHandlers(TowerNatives);

export default TowerNatives;
