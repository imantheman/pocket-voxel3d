// Port of gen1recomp src/core/game3/scripting/natives_tv.lua (GPLv3 + additional terms; see LICENSE.md).
// Emerald TV specials (shows, Gabby & Ty, interviews, TV screens).
//
// Port notes:
// - NOT FAITHFUL: Emerald only. The whole module is RSE: its state lives in
//   src.core.game3.rse.tv and src.core.game3.rse.init, which have no module
//   in the port. `Tv` and `Rse` below stand for them and throw on any use, so
//   every entry point here throws "Emerald only" as soon as it touches them.
//   FRLG never reaches it: Capabilities denies natives_tv to the FRLG
//   profile (Natives.bind skips it), and map.ts calls updateScreensOnMap only
//   under the "tv" capability.
// - NOT FAITHFUL: Emerald only. The Lua runs installTimeHooks() and
//   installEasyChatTypes() when the module loads; here the module is always
//   in the bundle (map.ts imports it), so those two Emerald installs are not
//   run at load. Std.legacyHandlers still runs, as in Lua.
// - Handlers return Lua's multiple returns as a 0-based tuple (see natives.ts);
//   Tv / Rse multiple returns are read as tuples too.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { seq, ipairs, type LuaTable } from "../../platform/lt.ts";
import { truthy, tonumber, format, mod } from "../../../../import/gen3/lua.ts";
import { notPorted } from "../../notported.ts";
import Std from "./stdscripts.ts";
import Rng from "../rng.ts";
import Runtime from "../runtime.ts";
import Constants from "../constants.ts";
import Collision from "../collision.ts";
import Field from "../field.ts";
import MB from "../mb.ts";
import TextIR from "./text_ir.ts";
import RomText from "../rom_text.ts";
import TimeEvents from "../time_events.ts";
import EasyChatText from "../easy_chat_text.ts";
import Rtc from "../rtc.ts";
import type { Handler } from "./natives.ts";

/** Lua's `a or b`. */
function lor<A, B>(a: A, b: B): A | B {
  return truthy(a) ? a : b;
}

// NOT FAITHFUL: Emerald only (see the port notes): a module with no file in
// the port; any read or write of it throws.
function emeraldOnlyModule(name: string): any {
  const fail = (): never => notPorted(`NOT FAITHFUL: Emerald only: require("${name}") (no such module in the port)`);
  return new Proxy({}, { get: fail, set: fail, has: fail });
}

const Tv: any = emeraldOnlyModule("src.core.game3.rse.tv");
const Rse: any = emeraldOnlyModule("src.core.game3.rse.init");

// pokeemerald/include/constants/vars.h:287
const VAR_0x8004 = 0x8004;
const VAR_0x8005 = 0x8005;
const VAR_0x8006 = 0x8006;
const VAR_0x8007 = 0x8007;
const VAR_RESULT = 0x800D;
// pokeemerald/include/constants/vars.h:300
const VAR_CONTEST_CATEGORY = 0x8011;

// pokeemerald/src/tv.c:1038
const GABBY_TY_LOCAL_IDS: Record<number, LuaTable> = {
  1: seq(14, 13), 2: seq(5, 6), 3: seq(18, 17), 4: seq(21, 22),
  5: seq(8, 9), 6: seq(19, 20), 7: seq(23, 24), 8: seq(10, 11),
};

// Lua: natives_tv.lua:22
function random(): number {
  return Rng.Random();
}

// Lua: natives_tv.lua:26
function housesOpts(session: any): any {
  const [g, n] = Rse.mapGroupNum(session && session.map, session);
  const [hg, bn] = Rse.mapGroupNum("EM_LITTLEROOT_TOWN_BRENDANS_HOUSE_1F", session);
  const [, mn] = Rse.mapGroupNum("EM_LITTLEROOT_TOWN_MAYS_HOUSE_1F", session);
  return {
    mapGroup: g,
    mapNum: n,
    housesGroup: hg,
    brendanNum: bn,
    mayNum: mn,
    gender: tonumber(session && session.gender) ?? 0,
    flag: (name: any) => Rse.flag(name, session),
  };
}

// Lua: natives_tv.lua:41
function currentLayout(): [any, any] {
  // package.loaded["src.core.game3.runtime"]
  const game = Runtime && Runtime._game;
  const session = Rse.session();
  const mapId = session && session.map;
  const def = mapId && game && game.data && game.data.maps && game.data.maps[mapId];
  return [def, def && def.midLayout];
}

// Lua: natives_tv.lua:50
function tvMetatile(on: boolean): any {
  const C = Constants.of("emerald");
  return C.require("metatile_labels", on ? "METATILE_Building_TV_On" : "METATILE_Building_TV_Off");
}

// Lua: natives_tv.lua:55
function setScreens(metatile: any): any {
  const [def, layout] = currentLayout();
  if (!truthy(layout)) return 0;
  const tv = MB.id("TELEVISION");
  return Tv.setScreens(layout,
    (x: number, y: number) => Collision.behaviorOn(def, x, y),
    (x: number, y: number, m: any) => { Field.setMetatile(x, y, m, true); },
    (b: any) => b === tv,
    metatile);
}

// Lua: natives_tv.lua:106
function stringVars(ctx: any): LuaTable {
  if (!truthy(ctx)) return {};
  if (typeof ctx.stringVars !== "object" || ctx.stringVars == null) ctx.stringVars = seq("", "", "");
  return ctx.stringVars;
}

// Lua: natives_tv.lua:112
function syncStringVars(ctx: any, adapters: any): void {
  if (!(adapters && truthy(adapters.setStringVar) && ctx && truthy(ctx.stringVars))) return;
  for (let i = 1; i <= 3; i++) adapters.setStringVar(i, lor(ctx.stringVars[i], ""));
}

// Lua: natives_tv.lua:117
function setStringVar(ctx: any, adapters: any, i: number, text: any): void {
  stringVars(ctx)[i] = text;
  if (adapters && truthy(adapters.setStringVar)) adapters.setStringVar(i, text);
}

// Lua: natives_tv.lua:122
function textView(ctx: any, adapters: any): any {
  const a = lor(adapters, {} as any);
  const val = (v: any): any => { if (typeof v === "function") return v(); return v; };
  return {
    stringVars: lor(ctx && ctx.stringVars, {}),
    playerName: lor(val(a.playerName), ctx && ctx.playerName),
    rivalName: lor(val(a.rivalName), ctx && ctx.rivalName),
  };
}

// Lua: natives_tv.lua:141
function showMessage(ctx: any, adapters: any, res: any): string {
  syncStringVars(ctx, adapters);
  const body = NativesTv.render(ctx, adapters, res);
  NativesTv.lastMessage = body;
  NativesTv.lastText = res;
  if (ctx) {
    ctx.messageOpen = true;
    ctx.printerDone = false;
  }
  const open = adapters && lor(adapters.openMessageStay, adapters.openMessageAsync);
  if (truthy(open)) {
    open(body, undefined);
  } else if (adapters && truthy(adapters.openMessage)) {
    adapters.openMessage(body);
  }
  return body;
}

// Lua: natives_tv.lua:160
function setResult(ctx: any, v: any): void {
  Rse.setSpecialVar(ctx, VAR_RESULT, v);
}

// Lua: natives_tv.lua:164
function boolRet(ctx: any, v: any): [boolean, number] {
  const r = truthy(v) ? 1 : 0;
  setResult(ctx, r);
  return [false, r];
}

// Lua: natives_tv.lua:170
function monIndexVar(ctx: any): any {
  return Rse.specialVar(ctx, VAR_0x8004);
}

// Lua: natives_tv.lua:174
function contestMon(session: any): any {
  const impl = Rse.system("contest");
  const idx = truthy(impl) ? tonumber(typeof impl.contestMonPartyIndex === "function" ? impl.contestMonPartyIndex()
    : impl.contestMonPartyIndex) : undefined;
  const party = lor(session && session.party, {} as any);
  if (idx != null) return party[idx + 1];
  return undefined;
}

// Lua: natives_tv.lua:184
// pokeemerald/src/tv.c:1479
function towerInterview(session: any): any {
  const impl = Rse.system("frontier");
  if (truthy(impl) && typeof impl.towerInterviewTv === "function") return impl.towerInterviewTv(session);
  const f = session && session.frontier;
  return (typeof f === "object" && f != null) ? lor(f.towerInterview, {}) : {};
}

// Lua: natives_tv.lua:191
function lilycoveContestLady(session: any): any {
  const r = Rse.call("lilycoveLady", "contestLadyTvData", "PutLilycoveContestLadyShowOnTheAir", undefined, session);
  return (typeof r === "object" && r != null) ? r : undefined;
}

const BY_NAME: Record<string, Handler> = {
  // Lua: natives_tv.lua:209
  // pokeemerald/src/tv.c:6825
  ResetTVShowState: () => {
    Tv.resetShowState();
    return [false];
  },
  // Lua: natives_tv.lua:214
  // pokeemerald/src/tv.c:3359
  CheckForPlayersHouseNews: () => {
    return [false, Tv.checkForPlayersHouseNews(housesOpts(Rse.session()))];
  },
  // Lua: natives_tv.lua:218
  // pokeemerald/src/tv.c:1004
  IsGabbyAndTyShowOnTheAir: () => {
    return [false, truthy(Tv.isGabbyAndTyOnAir(Rse.session())) ? 1 : 0];
  },
  // Lua: natives_tv.lua:222
  // pokeemerald/src/tv.c:996
  GabbyAndTyGetBattleNum: () => {
    return [false, NativesTv.gabbyBattleNum(Rse.session())];
  },
  // Lua: natives_tv.lua:226
  // pokeemerald/src/tv.c:1038
  GetGabbyAndTyLocalIds: (ctx) => {
    const ids = GABBY_TY_LOCAL_IDS[NativesTv.gabbyBattleNum(Rse.session())];
    if (ids) {
      Rse.setSpecialVar(ctx, VAR_0x8004, ids[1]);
      Rse.setSpecialVar(ctx, VAR_0x8005, ids[2]);
    }
    return [false];
  },
  // Lua: natives_tv.lua:235
  // pokeemerald/src/tv.c:1009
  GabbyAndTyGetLastQuote: (ctx, adapters) => {
    const g = Tv.state(Rse.session()).gabbyAndTyData;
    const q = g.quote && g.quote[0];
    if (q == null || q === -1 || q === Tv.EC_EMPTY_WORD) return [false, 0];
    setStringVar(ctx, adapters, 1, EasyChatText.word(q));
    g.quote[0] = Tv.EC_EMPTY_WORD;
    return [false, 1];
  },
  // Lua: natives_tv.lua:244
  // pokeemerald/src/tv.c:1020
  GabbyAndTyGetLastBattleTrivia: () => {
    const g = Tv.state(Rse.session()).gabbyAndTyData;
    if (!truthy(g.battleTookMoreThanOneTurn2)) return [false, 1];
    if (truthy(g.playerThrewABall2)) return [false, 2];
    if (truthy(g.playerUsedHealingItem2)) return [false, 3];
    if (truthy(g.playerLostAMon2)) return [false, 4];
    return [false, 0];
  },
  // Lua: natives_tv.lua:253
  // pokeemerald/src/tv.c:935
  GabbyAndTyBeforeInterview: () => {
    Tv.gabbyAndTyBeforeInterview(Rse.session());
    return [false];
  },
  // Lua: natives_tv.lua:258
  // pokeemerald/src/tv.c:979
  GabbyAndTyAfterInterview: () => {
    Tv.gabbyAndTyAfterInterview(Rse.session());
    return [false];
  },
  // Lua: natives_tv.lua:263
  // pokeemerald/src/tv.c:775
  GetRandomActiveShowIdx: () => {
    return [false, Tv.getRandomActiveShowIdx(Rse.session(), random)];
  },
  // Lua: natives_tv.lua:267
  // pokeemerald/src/tv.c:901
  GetNextActiveShowIfMassOutbreak: (ctx) => {
    return [false, Tv.nextActiveIfMassOutbreak(Rse.session(), Rse.specialVar(ctx, VAR_0x8004))];
  },
  // Lua: natives_tv.lua:271
  // pokeemerald/src/tv.c:882
  GetSelectedTVShow: (ctx) => {
    return [false, Tv.selectedShowKind(Rse.session(), Rse.specialVar(ctx, VAR_0x8004))];
  },
  // Lua: natives_tv.lua:275
  // pokeemerald/src/tv.c:3386
  GetMomOrDadStringForTVMessage: (ctx, adapters) => {
    const session = Rse.session();
    const opts = housesOpts(session);
    opts.random = random;
    opts.getTemp3 = () => Rse.var("VAR_TEMP_3", session);
    opts.setTemp3 = (v: any) => { Rse.setVar("VAR_TEMP_3", v, session); };
    const who = Tv.momOrDad(opts);
    setStringVar(ctx, adapters, 1, Rse.text(who === "mom" ? "gText_Mom" : "gText_Dad"));
    return [false];
  },
  // Lua: natives_tv.lua:286
  // pokeemerald/src/tv.c:875
  TurnOnTVScreen: () => {
    setScreens(tvMetatile(true));
    return [false];
  },
  // Lua: natives_tv.lua:291
  // pokeemerald/src/tv.c:869
  TurnOffTVScreen: () => {
    setScreens(tvMetatile(false));
    return [false];
  },
  // Lua: natives_tv.lua:296
  // pokeemerald/src/tv.c:2621
  DoPokeNews: (ctx, adapters) => {
    const session = Rse.session();
    const hours = lor(Rtc.localTime && Rtc.localTime.hours, 0);
    const [res, shown] = Tv.doPokeNews(session, hours, stringVars(ctx));
    if (!truthy(shown)) return boolRet(ctx, false);
    showMessage(ctx, adapters, res);
    return boolRet(ctx, true);
  },
  // Lua: natives_tv.lua:306
  // pokeemerald/src/tv.c:4198
  DoTVShow: (ctx, adapters) => {
    const [res, done] = Tv.doTVShow(Rse.session(), Rse.specialVar(ctx, VAR_0x8004), stringVars(ctx));
    if (!truthy(res)) return boolRet(ctx, true);
    showMessage(ctx, adapters, res);
    return boolRet(ctx, done);
  },
  // Lua: natives_tv.lua:313
  // pokeemerald/src/tv.c:5427
  DoTVShowInSearchOfTrainers: (ctx, adapters) => {
    const [res, done] = Tv.doInSearchOfTrainers(Rse.session(), stringVars(ctx));
    showMessage(ctx, adapters, res);
    return boolRet(ctx, done);
  },
  // Lua: natives_tv.lua:319
  // pokeemerald/src/tv.c:2894
  InterviewBefore: (ctx, adapters) => {
    Tv._stringVar1 = undefined;
    Tv._stringVar2 = undefined;
    Tv._var8006 = undefined;
    const r = Tv.interviewBefore(Rse.session(), Rse.specialVar(ctx, VAR_0x8005));
    if (truthy(Tv._stringVar1)) setStringVar(ctx, adapters, 1, Tv._stringVar1);
    if (truthy(Tv._stringVar2)) setStringVar(ctx, adapters, 2, Tv._stringVar2);
    if (truthy(Tv._var8006)) Rse.setSpecialVar(ctx, VAR_0x8006, Tv._var8006);
    return boolRet(ctx, r);
  },
  // Lua: natives_tv.lua:328
  // pokeemerald/src/tv.c:1077
  InterviewAfter: (ctx) => {
    const session = Rse.session();
    Tv.interviewAfter(session, Rse.specialVar(ctx, VAR_0x8005), {
      var8004: Rse.specialVar(ctx, VAR_0x8004),
      var8007: Rse.specialVar(ctx, VAR_0x8007),
      contestCategory: Rse.specialVar(ctx, VAR_CONTEST_CATEGORY),
      contestMon: contestMon(session),
      towerInterview: towerInterview(session),
    });
    return [false];
  },
  // Lua: natives_tv.lua:340
  // pokeemerald/src/tv.c:3024
  IsLeadMonNicknamedOrNotEnglish: (ctx) => {
    return boolRet(ctx, Tv.isLeadMonNicknamedOrNotEnglish(Rse.session()));
  },
  // Lua: natives_tv.lua:344
  // pokeemerald/src/tv.c:2779
  SetContestCategoryStringVarForInterview: (ctx, adapters) => {
    const show = Tv.state(Rse.session()).tvShows[Rse.specialVar(ctx, VAR_0x8004)];
    const cat = tonumber(show && show.contestCategory) ?? 0;
    setStringVar(ctx, adapters, 2, Rse.text(format("gStdStrings[%d]", cat)));
    return [false];
  },
  // Lua: natives_tv.lua:351
  // pokeemerald/src/tv.c:3268
  IsTVShowAlreadyInQueue: (ctx) => {
    return boolRet(ctx, Tv.isShowAlreadyInQueue(Rse.session(), Rse.specialVar(ctx, VAR_0x8004)));
  },
  // Lua: natives_tv.lua:355
  // pokeemerald/src/tv.c:3280
  TryPutNameRaterShowOnTheAir: (ctx) => {
    const sv = stringVars(ctx);
    return boolRet(ctx, Tv.tryPutNameRaterShowOnTheAir(Rse.session(), monIndexVar(ctx), sv[3]));
  },
  // Lua: natives_tv.lua:360
  // pokeemerald/src/tv.c:1897
  TryPutTreasureInvestigatorsOnAir: (ctx) => {
    Tv.tryPutTreasureInvestigatorsOnAir(Rse.session(), Rse.specialVar(ctx, VAR_0x8005));
    return [false];
  },
  // Lua: natives_tv.lua:365
  // pokeemerald/src/tv.c:2186
  TryPutLotteryWinnerReportOnAir: (ctx) => {
    Tv.tryPutLotteryWinnerReportOnAir(Rse.session(), Rse.specialVar(ctx, VAR_0x8004), Rse.specialVar(ctx, VAR_0x8005));
    return [false];
  },
  // Lua: natives_tv.lua:370
  // pokeemerald/src/tv.c:2324
  TryPutTrainerFanClubOnAir: () => {
    Tv.tryPutTrainerFanClubOnAir(Rse.session());
    return [false];
  },
  // Lua: natives_tv.lua:375
  // pokeemerald/src/tv.c:2342
  ShouldHideFanClubInterviewer: (ctx) => {
    Tv._var8006 = undefined;
    const hide = Tv.shouldHideFanClubInterviewer(Rse.session());
    if (truthy(Tv._var8006)) Rse.setSpecialVar(ctx, VAR_0x8006, Tv._var8006);
    return boolRet(ctx, hide);
  },
  // Lua: natives_tv.lua:382
  // pokeemerald/src/tv.c:1338
  PutFanClubSpecialOnTheAir: (ctx) => {
    const session = Rse.session();
    const recs = session && session.linkBattleRecords;
    const entries = (typeof recs === "object" && recs != null) ? lor(recs.entries, recs) : {};
    const first = (typeof entries === "object" && entries != null) ? lor(entries[1], entries[0]) : undefined;
    Tv.putFanClubSpecialOnTheAir(session, Rse.specialVar(ctx, VAR_0x8006), Rse.specialVar(ctx, VAR_0x8005),
      stringVars(ctx)[1], (typeof first === "object" && first != null) ? first.language : undefined);
    return [false];
  },
  // Lua: natives_tv.lua:392
  // pokeemerald/src/tv.c:1581
  PutLilycoveContestLadyShowOnTheAir: (ctx) => {
    const session = Rse.session();
    const lady = lilycoveContestLady(session);
    if (truthy(lady)) {
      Tv.putLilycoveContestLadyShowOnTheAir(session, lady);
      setResult(ctx, truthy(Tv._result) ? 1 : 0);
    }
    return [false];
  },
};

export const NativesTv = {
  // Lua: natives_tv.lua:69
  setScreens,

  // Lua: natives_tv.lua:72
  // pokeemerald/src/tv.c:826
  updateScreensOnMap(sessionIn?: any): void {
    const session = lor(sessionIn, undefined) ?? Rse.session();
    if (!truthy(session)) return;
    Rse.setFlag("FLAG_SYS_TV_WATCH", true, session);
    const news = Tv.checkForPlayersHouseNews(housesOpts(session));
    if (news === Tv.PLAYERS_HOUSE_TV_LATI) {
      setScreens(tvMetatile(true));
    } else if (news === Tv.PLAYERS_HOUSE_TV_MOVIE) {
      return;
    } else if (session.map === "EM_LILYCOVE_CITY_COVE_LILY_MOTEL_1F") {
      setScreens(tvMetatile(true));
    } else if (truthy(Rse.flag("FLAG_SYS_TV_START", session)) && (NativesTv.anyShowOnAir(session)
        || Tv.findPokeNewsOnAir(session) !== 0xFF || truthy(Tv.isGabbyAndTyOnAir(session)))) {
      Rse.setFlag("FLAG_SYS_TV_WATCH", false, session);
      setScreens(tvMetatile(true));
    }
  },

  // Lua: natives_tv.lua:91
  // pokeemerald/src/tv.c:813
  findAnyShowOnAir(session: any): any {
    return Tv.findAnyShowOnAir(session, random);
  },

  // Lua: natives_tv.lua:95
  anyShowOnAir(session: any): boolean {
    return NativesTv.findAnyShowOnAir(session) !== 0xFF;
  },

  // Lua: natives_tv.lua:100
  // pokeemerald/src/tv.c:996
  gabbyBattleNum(session: any): number {
    const n = tonumber(Tv.state(session).gabbyAndTyData.battleNum) ?? 0;
    if (n > 5) return mod(n, 3) + 6;
    return n;
  },

  // Lua: natives_tv.lua:133
  // pokeemerald/src/field_message_box.c:62
  render(ctx: any, adapters: any, res: any): string {
    const view = textView(ctx, adapters);
    if (truthy(res.text)) return TextIR.toTextBox(TextIR.fromAscii(res.text), view);
    return RomText.box(RomText.key(res.group, res.index), view);
  },

  // Lua: natives_tv.lua:158
  showMessage,
  lastMessage: undefined as string | undefined,
  lastText: undefined as any,

  // Lua: natives_tv.lua:197
  // pokeemerald/src/clock.c:46
  installTimeHooks(): void {
    const [perDay] = TimeEvents.handlers();
    if (perDay.UpdateTVShowsPerDay == null) {
      TimeEvents.onDay("UpdateTVShowsPerDay", (sess: any, days: any) => {
        if (truthy(Rse.isRse(sess))) Tv.updatePerDay(sess, days);
      });
    }
  },

  BY_NAME,
  /** Set by Std.legacyHandlers (stdscripts.lua:262): special id -> handler. */
  HANDLERS: undefined as Record<number, Handler> | undefined,

  // Lua: natives_tv.lua:404
  // pokeemerald/src/easy_chat.c:1486
  installEasyChatTypes(): boolean {
    // pcall(require, "src.core.game3.rse.easy_chat_types"): no such module in
    // the port, so the require fails (NOT FAITHFUL: Emerald only).
    const ok = false;
    const Types: any = undefined;
    if (!(ok && typeof Types === "object" && Types.register)) return false;
    for (const [, typeId] of ipairs(seq(Tv.EASY_CHAT_TYPE.INTERVIEW, Tv.EASY_CHAT_TYPE.FAN_CLUB, Tv.EASY_CHAT_TYPE.GABBY_AND_TY,
      Tv.EASY_CHAT_TYPE.CONTEST_INTERVIEW, Tv.EASY_CHAT_TYPE.BATTLE_TOWER_INTERVIEW, Tv.EASY_CHAT_TYPE.FAN_QUESTION))) {
      const slot = (ctx: any, sess: any): any[] => {
        return Tv.easyChatWords(sess, typeId, Rse.specialVar(ctx, VAR_0x8005), Rse.specialVar(ctx, VAR_0x8006));
      };
      Types.register(typeId, {
        words: (ctx: any, sess: any) => {
          const [arr, first, count] = slot(ctx, sess);
          if (!truthy(arr)) return undefined;
          const out: LuaTable = seq();
          for (let i = 0; i <= count - 1; i++) out[i + 1] = lor(arr[first + i], Tv.EC_EMPTY_WORD);
          return out;
        },
        commit: (ctx: any, sess: any, words: any) => {
          const s = Tv.state(sess);
          let arr: any;
          let first: number;
          let count: number;
          if (typeId === Tv.EASY_CHAT_TYPE.GABBY_AND_TY) {
            arr = s.gabbyAndTyData.quote; first = 0; count = 1;
          } else {
            const show = s.tvShows[Rse.specialVar(ctx, VAR_0x8005)];
            if (!(truthy(show) && typeof show.words === "object" && show.words != null)) return;
            arr = show.words;
            first = (typeId === Tv.EASY_CHAT_TYPE.FAN_CLUB || typeId === Tv.EASY_CHAT_TYPE.CONTEST_INTERVIEW)
              ? Rse.specialVar(ctx, VAR_0x8006) + 1 : 1;
            count = typeId === Tv.EASY_CHAT_TYPE.INTERVIEW ? 4 : 1;
          }
          for (let i = 0; i <= count - 1; i++) arr[first + i] = tonumber(words[i + 1]) ?? Tv.EC_EMPTY_WORD;
        },
      });
    }
    return true;
  },
};

// Lua: natives_tv.lua:440-441 NativesTv.installTimeHooks(); NativesTv.installEasyChatTypes()
// NOT FAITHFUL: Emerald only: not run at load (see the port notes).
// Lua: natives_tv.lua:442
Std.legacyHandlers(NativesTv);

export default NativesTv;
