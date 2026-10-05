// Port of gen1recomp src/core/game3/teachy_tv.lua (GPLv3 + additional terms; see LICENSE.md).
// pokefirered/src/teachy_tv.c:420 InitTeachyTvController
//
// The screen itself is src.ui.game3.teachy_tv, a lazily-required module:
// show() looks it up in G3Lazy and takes Brian's failed-require path (returns
// false) when it is absent.

import { tonumber } from "../../../import/gen3/lua.ts";
import { fromArray, ipairs, len, seq, type LuaTable } from "../platform/lt.ts";
import { RomText } from "./rom_text.ts";
import { TextIR } from "./scripting/text_ir.ts";
import { Bag } from "./bag.ts";
import { ItemsData } from "./items_data.ts";
import { Runtime } from "./runtime.ts";
import { Pokedude } from "./battle/pokedude.ts";
import { G3Lazy } from "./lazy_registry.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface Lesson { index: number; key: string; labelKey: string; introKey: string; outroKey: string }
export interface TeachyRes { mode: number; whichScript: number; scrollOffset: number; selectedRow: number; watched: Record<string, boolean>; [k: string]: any }

// Lua: teachy_tv.lua:32 -- pokefirered/include/constants/battle.h:78 B_OUTCOME_DREW
const B_OUTCOME_DREW = 3;

// Lua: teachy_tv.lua:35 -- pokefirered/src/teachy_tv.c:145 sWindowTemplates
const PAGE_WIDTH = 208;

// Lua: teachy_tv.lua:14 -- pokefirered/include/teachy_tv.h:4
const SCRIPT = {
  BATTLE: 0,
  STATUS: 1,
  MATCHUPS: 2,
  CATCHING: 3,
  TMS: 4,
  REGISTER: 5,
};

// Lua: teachy_tv.lua:128 -- pokefirered/src/teachy_tv.c:272 sBattleScript
const GRASS_SCRIPT = seq(
  "transition_render_bg2",
  "clear_bg2",
  "npc_move_and_setup_text_printer",
  "idle_if_text_printer_active",
  "idle_if_text_printer_active2",
  "text_printer_intro",
  "idle_if_text_printer_active2",
  "erase_text_window_if_key_pressed",
  "start_anim_npc_walk_into_grass",
  "dude_move_up",
  "dude_move_right",
  "battle_or_fade",
  "text_printer_outro",
  "idle_if_text_printer_active2",
  "erase_text_window_if_key_pressed",
  "dude_turn_left",
  "dude_move_left",
  "render_and_remove_bg1_end_graphic",
  "end",
);

// Lua: teachy_tv.lua:151 -- pokefirered/src/teachy_tv.c:364 sTMsScript
const BAG_SCRIPT = seq(
  "transition_render_bg2",
  "clear_bg2",
  "npc_move_and_setup_text_printer",
  "idle_if_text_printer_active",
  "idle_if_text_printer_active2",
  "text_printer_intro",
  "idle_if_text_printer_active2",
  "erase_text_window_if_key_pressed",
  "battle_or_fade",
  "text_printer_outro",
  "idle_if_text_printer_active2",
  "erase_text_window_if_key_pressed",
  "dude_turn_left",
  "dude_move_left",
  "render_and_remove_bg1_end_graphic",
  "end",
);

// Lua: teachy_tv.lua:400 -- pokefirered/include/constants/items.h:7
const ITEM_GREAT_BALL = 3;
const ITEM_POKE_BALL = 4;
const ITEM_NEST_BALL = 8;
const ITEM_POTION = 13;
const ITEM_ANTIDOTE = 14;

// Lua: teachy_tv.lua:418 -- pokefirered/src/item_menu.c:2061 BackUpPlayerBag
const BACKUP_POCKETS = seq("ITEMS", "KEY_ITEMS", "POKE_BALLS", "BERRY_POUCH");

// Lua: teachy_tv.lua:424 -- pokefirered/src/tm_case.c:1322 Pokedude_InitTMCase
const TM_CASE_POCKETS = seq("TM_CASE", "KEY_ITEMS");

// Lua: teachy_tv.lua:443 -- pokefirered/src/item_menu.c:2208 Task_Bag_TeachyTvRegister
const REGISTER_DEMO: LuaTable = seq<any>(
  { at: 102, key: "right" },
  { at: 204, key: "a", item: 366 },
  { at: 306, key: "down" },
  { at: 408, key: "a" },
  { at: 510, key: "down" },
  { at: 612, key: "down" },
  { at: 714, exit: true },
);

// Lua: teachy_tv.lua:454 -- pokefirered/src/item_menu.c:2359 Task_Bag_TeachyTvTMs
const TMS_DEMO: LuaTable = seq<any>(
  { at: 102, key: "right" },
  { at: 204, key: "down" },
  { at: 306, key: "a", item: 364 },
  // pokefirered/src/item_menu.c:2385 exitCB = Pokedude_InitTMCase
  { at: 408, exit: true, tmCase: true },
);

// Lua: teachy_tv.lua:225
function pages_of(key: string): LuaTable {
  const box = RomText.box(key, { maxWidth: PAGE_WIDTH });
  // TextIR.splitPages returns a 0-based array (its port's shape): fromArray
  // makes it Brian's sequence.
  const out = fromArray(TextIR.splitPages(box));
  if (len(out) === 0) out[1] = "";
  return out;
}

// Lua: teachy_tv.lua:278
function sessionOf(session: any): any {
  if (session != null && typeof session === "object") return session;
  const got = Runtime && Runtime.getSession ? Runtime.getSession() : undefined;
  if (got != null && typeof got === "object") return got;
  return null;
}

// Lua: teachy_tv.lua:469
function pocket_slots(bag: any, key: string): LuaTable {
  const slots = (bag != null && typeof bag === "object" && bag.pockets != null && typeof bag.pockets === "object" && bag.pockets[key]) || [null];
  const out: LuaTable = [null];
  for (const [i, slot] of ipairs<any>(slots)) {
    out[i] = { id: slot.id, qty: tonumber(slot.qty) ?? 0 };
  }
  return out;
}

// Lua: teachy_tv.lua:479 -- pokefirered/src/item_menu.c:2065
function set_pocket(bag: any, key: string, slots: LuaTable): void {
  const out: LuaTable = [null];
  for (const [i, slot] of ipairs<any>(slots ?? [null])) {
    out[i] = { id: slot.id, qty: tonumber(slot.qty) ?? 0 };
  }
  bag.pockets[key] = out;
}

// Lua: teachy_tv.lua:487
function swap_pockets(bag: any, keys: LuaTable, into: any): Record<string, LuaTable> {
  Bag.migrate(bag);
  const taken: Record<string, LuaTable> = {};
  for (const [, key] of ipairs<string>(keys)) {
    taken[key] = pocket_slots(bag, key);
    set_pocket(bag, key, into ? into[key] : null);
  }
  Bag.migrate(bag);
  return taken;
}

// Lua: teachy_tv.lua:499
function by_pocket(entries: LuaTable): Record<string, LuaTable> {
  const out: Record<string, LuaTable> = {};
  for (const [, entry] of ipairs<any>(entries)) {
    const pocket = ItemsData.pocketOf(entry.id) || "ITEMS";
    out[pocket] = out[pocket] ?? [null];
    out[pocket][len(out[pocket]) + 1] = { id: entry.id, qty: entry.qty };
  }
  return out;
}

export const TeachyTv = {
  // Lua: teachy_tv.lua:9 -- pokefirered/include/constants/items.h:438
  ITEM_TEACHY_TV: 366,
  // pokefirered/include/constants/items.h:436
  ITEM_TM_CASE: 364,

  SCRIPT,

  // Lua: teachy_tv.lua:24 -- pokefirered/src/teachy_tv.c:196 gTeachyTvString_Cancel
  CANCEL: -2,
  // pokefirered/src/teachy_tv.c:713 TeachyTvOptionListController
  NO_INPUT: -1,

  // Lua: teachy_tv.lua:29 -- pokefirered/src/teachy_tv.c:424
  MODE: { FRESH: 0, RESUME_LIST: 1, RESUME_SCRIPT: 2 },

  // Lua: teachy_tv.lua:37
  LESSONS: {
    [SCRIPT.BATTLE]: {
      index: SCRIPT.BATTLE,
      key: "BATTLE",
      // pokefirered/src/data/text/teachy_tv.h:1
      labelKey: "gTeachyTvString_TeachBattle",
      // pokefirered/src/data/text/teachy_tv.h:15
      introKey: "gTeachyTvText_BattleScript1",
      // pokefirered/src/data/text/teachy_tv.h:30
      outroKey: "gTeachyTvText_BattleScript2",
    },
    [SCRIPT.STATUS]: {
      index: SCRIPT.STATUS,
      key: "STATUS",
      labelKey: "gTeachyTvString_StatusProblems",
      introKey: "gTeachyTvText_StatusScript1",
      outroKey: "gTeachyTvText_StatusScript2",
    },
    [SCRIPT.MATCHUPS]: {
      index: SCRIPT.MATCHUPS,
      key: "MATCHUPS",
      labelKey: "gTeachyTvString_TypeMatchups",
      introKey: "gTeachyTvText_MatchupsScript1",
      outroKey: "gTeachyTvText_MatchupsScript2",
    },
    [SCRIPT.CATCHING]: {
      index: SCRIPT.CATCHING,
      key: "CATCHING",
      labelKey: "gTeachyTvString_CatchPkmn",
      introKey: "gTeachyTvText_CatchingScript1",
      outroKey: "gTeachyTvText_CatchingScript2",
    },
    [SCRIPT.TMS]: {
      index: SCRIPT.TMS,
      key: "TMS",
      labelKey: "gTeachyTvString_AboutTMs",
      introKey: "gTeachyTvText_TMsScript1",
      outroKey: "gTeachyTvText_TMsScript2",
    },
    [SCRIPT.REGISTER]: {
      index: SCRIPT.REGISTER,
      key: "REGISTER",
      labelKey: "gTeachyTvString_RegisterItem",
      introKey: "gTeachyTvText_RegisterScript1",
      outroKey: "gTeachyTvText_RegisterScript2",
    },
  } as Record<number, Lesson>,

  // Lua: teachy_tv.lua:101 -- pokefirered/src/teachy_tv.c:168 sListMenuItems
  ORDER: seq(
    SCRIPT.BATTLE,
    SCRIPT.STATUS,
    SCRIPT.MATCHUPS,
    SCRIPT.CATCHING,
    SCRIPT.TMS,
    SCRIPT.REGISTER,
  ) as (number | null)[],

  // Lua: teachy_tv.lua:111 -- pokefirered/src/teachy_tv.c:201 sListMenuItems_NoTMCase
  ORDER_NO_TM_CASE: seq(
    SCRIPT.BATTLE,
    SCRIPT.STATUS,
    SCRIPT.MATCHUPS,
    SCRIPT.CATCHING,
  ) as (number | null)[],

  // Lua: teachy_tv.lua:119 -- pokefirered/src/data/text/teachy_tv.h:8
  HELLO: "gTeachyTvText_PokedudeSaysHello",
  // pokefirered/src/data/text/teachy_tv.h:142
  TM_TYPES: "gPokedudeText_TMTypes",
  // pokefirered/src/data/text/teachy_tv.h:152
  TM_DESCRIPTION: "gPokedudeText_ReadTMDescription",

  // Lua: teachy_tv.lua:170
  STEPS: {
    [SCRIPT.BATTLE]: GRASS_SCRIPT,
    [SCRIPT.STATUS]: GRASS_SCRIPT,
    [SCRIPT.MATCHUPS]: GRASS_SCRIPT,
    [SCRIPT.CATCHING]: GRASS_SCRIPT,
    [SCRIPT.TMS]: BAG_SCRIPT,
    [SCRIPT.REGISTER]: BAG_SCRIPT,
  } as Record<number, LuaTable>,

  // Lua: teachy_tv.lua:180 -- pokefirered/src/teachy_tv.c:262 sWhereToReturnToFromBattle
  RESUME_STEP: {
    [SCRIPT.BATTLE]: 12,
    [SCRIPT.STATUS]: 12,
    [SCRIPT.MATCHUPS]: 12,
    [SCRIPT.CATCHING]: 12,
    [SCRIPT.TMS]: 9,
    [SCRIPT.REGISTER]: 9,
  } as Record<number, number>,

  // Lua: teachy_tv.lua:190 -- pokefirered/include/battle_transition.h:25
  TRANSITION: { SLICE: 8, WHITE_BARS_FADE: 9 },

  // Lua: teachy_tv.lua:193 -- pokefirered/include/constants/item_menu.h:18
  BAG_LOCATION: { REGISTER: 9, TMS: 10 },

  onDemonstration: null as ((session: any, scriptId: any, opts: any) => unknown) | null,

  // Lua: teachy_tv.lua:195
  lesson(scriptId: unknown): Lesson | undefined {
    return TeachyTv.LESSONS[tonumber(scriptId) ?? -1];
  },

  // Lua: teachy_tv.lua:200 -- pokefirered/src/teachy_tv.c:549 TeachyTvSetupWindow
  hasTmCase(session: any, bag?: any): boolean {
    bag = bag ?? ((session != null && typeof session === "object" && session.bag) || null);
    if (bag == null || typeof bag !== "object") return false;
    return Bag.has(bag, TeachyTv.ITEM_TM_CASE, 1) ? true : false;
  },

  // Lua: teachy_tv.lua:208 -- pokefirered/src/teachy_tv.c:168 sListMenuItems
  menuItems(session: any, bag?: any): LuaTable {
    const order = TeachyTv.hasTmCase(session, bag) ? TeachyTv.ORDER : TeachyTv.ORDER_NO_TM_CASE;
    const rows: LuaTable = [null];
    for (let i = 1; i <= len(order); i++) {
      const lesson = TeachyTv.LESSONS[order[i]!];
      rows[i] = { index: lesson.index, label: RomText.plain(lesson.labelKey), key: lesson.key };
    }
    // pokefirered/src/teachy_tv.c:196
    rows[len(rows) + 1] = { index: TeachyTv.CANCEL, label: RomText.plain("gTeachyTvString_Cancel"), key: "CANCEL" };
    return rows;
  },

  // Lua: teachy_tv.lua:221 -- pokefirered/src/teachy_tv.c:557 gMultiuseListMenuTemplate
  maxShowed(session: any, bag?: any): number {
    return TeachyTv.hasTmCase(session, bag) ? 6 : 5;
  },

  // Lua: teachy_tv.lua:233 -- pokefirered/src/teachy_tv.c:838
  introPages(scriptId: unknown): LuaTable {
    const lesson = TeachyTv.lesson(scriptId);
    if (!lesson) return [null];
    return pages_of(lesson.introKey);
  },

  // Lua: teachy_tv.lua:240 -- pokefirered/src/teachy_tv.c:853
  outroPages(scriptId: unknown): LuaTable {
    const lesson = TeachyTv.lesson(scriptId);
    if (!lesson) return [null];
    return pages_of(lesson.outroKey);
  },

  // Lua: teachy_tv.lua:246
  pagesOf: pages_of,

  // Lua: teachy_tv.lua:249 -- pokefirered/src/teachy_tv.c:1069 TTVcmd_TaskBattleOrFadeByOptionChosen
  endsInBattle(scriptId: unknown): boolean {
    const id = tonumber(scriptId);
    return id === SCRIPT.BATTLE || id === SCRIPT.STATUS
      || id === SCRIPT.MATCHUPS || id === SCRIPT.CATCHING;
  },

  // Lua: teachy_tv.lua:256 -- pokefirered/src/teachy_tv.c:1087 TeachyTvSetupBagItemsByOptionChosen
  bagLocation(scriptId: unknown): number | null {
    const id = tonumber(scriptId);
    if (id === SCRIPT.TMS) return TeachyTv.BAG_LOCATION.TMS;
    if (id === SCRIPT.REGISTER) return TeachyTv.BAG_LOCATION.REGISTER;
    return null;
  },

  // Lua: teachy_tv.lua:264 -- pokefirered/src/teachy_tv.c:1172 TeachyTvPrepBattle
  battleTransition(scriptId: unknown): number {
    if (tonumber(scriptId) === SCRIPT.BATTLE) {
      return TeachyTv.TRANSITION.WHITE_BARS_FADE;
    }
    return TeachyTv.TRANSITION.SLICE;
  },

  // Lua: teachy_tv.lua:272 -- pokefirered/src/teachy_tv.c:1208 TeachyTvRestorePlayerPartyCallback
  modeAfterBattle(outcome: unknown): number {
    if (tonumber(outcome) === B_OUTCOME_DREW) return TeachyTv.MODE.RESUME_LIST;
    return TeachyTv.MODE.RESUME_SCRIPT;
  },
  // Lua: teachy_tv.lua:276
  B_OUTCOME_DREW,

  // Lua: teachy_tv.lua:287 -- pokefirered/src/teachy_tv.c:31 struct TeachyTvCtrlBlk
  resources(sessionIn?: any): TeachyRes | null {
    const session = sessionOf(sessionIn);
    if (session == null || typeof session !== "object") return null;
    let md = session.modData;
    if (md == null || typeof md !== "object") {
      md = {};
      session.modData = md;
    }
    let res = session.teachyTv;
    if (res == null || typeof res !== "object") res = md.teachyTv;
    if (res == null || typeof res !== "object") res = {};
    res.mode = tonumber(res.mode) ?? TeachyTv.MODE.FRESH;
    res.whichScript = tonumber(res.whichScript) ?? SCRIPT.BATTLE;
    res.scrollOffset = tonumber(res.scrollOffset) ?? 0;
    res.selectedRow = tonumber(res.selectedRow) ?? 0;
    if (res.watched == null || typeof res.watched !== "object") res.watched = {};
    session.teachyTv = res;
    md.teachyTv = res;
    return res;
  },

  // Lua: teachy_tv.lua:309 -- pokefirered/src/teachy_tv.c:420 InitTeachyTvController
  initController(session: any, mode: unknown): TeachyRes | null {
    const res = TeachyTv.resources(session);
    if (!res) return null;
    const m = tonumber(mode) ?? TeachyTv.MODE.FRESH;
    res.mode = m;
    if (m === TeachyTv.MODE.FRESH) {
      res.scrollOffset = 0;
      res.selectedRow = 0;
      res.whichScript = SCRIPT.BATTLE;
    }
    if (m === TeachyTv.MODE.RESUME_LIST) {
      res.mode = TeachyTv.MODE.FRESH;
    }
    return res;
  },

  // Lua: teachy_tv.lua:326 -- pokefirered/src/teachy_tv.c:445 SetTeachyTvControllerModeToResume
  setModeToResume(session: any): TeachyRes | null {
    const res = TeachyTv.resources(session);
    if (!res) return null;
    res.mode = TeachyTv.MODE.RESUME_LIST;
    return res;
  },

  // Lua: teachy_tv.lua:334 -- pokefirered/src/teachy_tv.c:437 CB2_ReturnToTeachyTV
  returnToTv(session: any): TeachyRes | null {
    const res = TeachyTv.resources(session);
    if (!res) return null;
    if (res.mode === TeachyTv.MODE.RESUME_LIST) {
      return TeachyTv.initController(session, TeachyTv.MODE.RESUME_LIST);
    }
    return TeachyTv.initController(session, TeachyTv.MODE.RESUME_SCRIPT);
  },

  // Lua: teachy_tv.lua:343
  selectLesson(session: any, scriptId: unknown): number | null {
    const res = TeachyTv.resources(session);
    if (!res) return null;
    const id = tonumber(scriptId);
    if (!TeachyTv.LESSONS[id ?? -1]) return null;
    res.whichScript = id!;
    return id!;
  },

  // Lua: teachy_tv.lua:352
  whichScript(session: any): number {
    const res = TeachyTv.resources(session);
    return res ? res.whichScript ?? SCRIPT.BATTLE : SCRIPT.BATTLE;
  },

  // Lua: teachy_tv.lua:357
  markWatched(session: any, scriptId: unknown): boolean {
    const res = TeachyTv.resources(session);
    const lesson = TeachyTv.lesson(scriptId);
    if (!(res && lesson)) return false;
    res.watched[lesson.key] = true;
    return true;
  },

  // Lua: teachy_tv.lua:365
  hasWatched(session: any, scriptId: unknown): boolean {
    const res = TeachyTv.resources(session);
    const lesson = TeachyTv.lesson(scriptId);
    if (!(res && lesson)) return false;
    return res.watched[lesson.key] === true;
  },

  // Lua: teachy_tv.lua:372
  watchedCount(session: any): number {
    const res = TeachyTv.resources(session);
    if (!res) return 0;
    let n = 0;
    for (const [, id] of ipairs<number>(TeachyTv.ORDER)) {
      if (res.watched[TeachyTv.LESSONS[id].key]) n = n + 1;
    }
    return n;
  },

  // Lua: teachy_tv.lua:383 -- pokefirered/src/teachy_tv.c:755
  TIMING: {
    TITLE: 64,
    CLEAR: 134,
    NPC_WAIT: 35,
    DUDE_X_START: 8,
    DUDE_X_END: 0x78,
    DUDE_Y: 0x38,
    MOVE_UP: 48,
    MOVE_RIGHT: 0x30,
    END_GRAPHIC: 127,
    END: 64,
  },

  // Lua: teachy_tv.lua:397 -- pokefirered/include/constants/event_objects.h:96 OBJ_EVENT_GFX_TEACHY_TV_HOST
  HOST_GFX: 90,

  // Lua: teachy_tv.lua:407 -- pokefirered/src/item_menu.c:2167 AddBagItem
  POKEDUDE_BAG: seq<any>(
    { id: ITEM_POTION, qty: 1 },
    { id: ITEM_ANTIDOTE, qty: 1 },
    { id: 366, qty: 1 },
    { id: 364, qty: 1 },
    { id: ITEM_POKE_BALL, qty: 5 },
    { id: ITEM_GREAT_BALL, qty: 1 },
    { id: ITEM_NEST_BALL, qty: 1 },
  ) as LuaTable,

  // Lua: teachy_tv.lua:421 -- pokefirered/include/constants/items.h:300 ITEM_TM01
  POKEDUDE_TMS: seq(289, 291, 297, 323) as (number | null)[],

  // Lua: teachy_tv.lua:427 -- pokefirered/src/tm_case.c:1351 POKEDUDE_INPUT_DELAY
  POKEDUDE_INPUT_DELAY: 102,

  // Lua: teachy_tv.lua:430 -- pokefirered/src/tm_case.c:1353 Task_Pokedude_Run
  TM_CASE_DEMO: seq<any>(
    { wait: true },
    { key: "down" }, { key: "down" }, { key: "down" },
    { key: "up" }, { key: "up" }, { key: "up" },
    { text: "TM_TYPES" },
    { wait: true },
    { key: "down" }, { key: "down" }, { key: "down" },
    { key: "up" }, { key: "up" }, { key: "up" },
    { text: "TM_DESCRIPTION" },
    { exit: true },
  ) as LuaTable,

  // Lua: teachy_tv.lua:462
  bagDemoPlan(scriptId: unknown): LuaTable | null {
    const id = tonumber(scriptId);
    if (id === SCRIPT.REGISTER) return REGISTER_DEMO;
    if (id === SCRIPT.TMS) return TMS_DEMO;
    return null;
  },

  // Lua: teachy_tv.lua:511 -- pokefirered/src/item_menu.c:2061 BackUpPlayerBag
  backUpPlayerBag(sessionIn: any, pokedude?: any): any {
    const session = sessionOf(sessionIn);
    const bag = session ? session.bag : null;
    if (bag == null || typeof bag !== "object") return null;
    const backup = {
      pockets: swap_pockets(bag, BACKUP_POCKETS, pokedude),
      registeredItem: session.registeredItem,
    };
    session.registeredItem = null;
    session.teachyBagBackup = backup;
    return backup;
  },

  // Lua: teachy_tv.lua:525 -- pokefirered/src/item_menu.c:2082 RestorePlayerBag
  restorePlayerBag(sessionIn: any): boolean {
    const session = sessionOf(sessionIn);
    const backup = session ? session.teachyBagBackup : null;
    const bag = session ? session.bag : null;
    if (!(backup && bag != null && typeof bag === "object")) return false;
    swap_pockets(bag, BACKUP_POCKETS, backup.pockets);
    session.registeredItem = backup.registeredItem;
    session.teachyBagBackup = null;
    return true;
  },

  // Lua: teachy_tv.lua:537 -- pokefirered/src/item_menu.c:2162 InitPokedudeBag
  initPokedudeBag(sessionIn: any, scriptId: unknown): number | null {
    const session = sessionOf(sessionIn);
    TeachyTv.backUpPlayerBag(session, by_pocket(TeachyTv.POKEDUDE_BAG));
    return TeachyTv.bagLocation(scriptId);
  },

  // Lua: teachy_tv.lua:544 -- pokefirered/src/tm_case.c:1322 Pokedude_InitTMCase
  initPokedudeTmCase(sessionIn: any): any {
    const session = sessionOf(sessionIn);
    const bag = session ? session.bag : null;
    if (bag == null || typeof bag !== "object") return null;
    const tms: LuaTable = [null];
    for (const [i, id] of ipairs<number>(TeachyTv.POKEDUDE_TMS)) tms[i] = { id, qty: 1 };
    const backup = { pockets: swap_pockets(bag, TM_CASE_POCKETS, by_pocket(tms)) };
    session.teachyTmCaseBackup = backup;
    return backup;
  },

  // Lua: teachy_tv.lua:556 -- pokefirered/src/tm_case.c:1450
  restorePokedudeTmCase(sessionIn: any): boolean {
    const session = sessionOf(sessionIn);
    const backup = session ? session.teachyTmCaseBackup : null;
    const bag = session ? session.bag : null;
    if (!(backup && bag != null && typeof bag === "object")) return false;
    swap_pockets(bag, TM_CASE_POCKETS, backup.pockets);
    session.teachyTmCaseBackup = null;
    return true;
  },

  // Lua: teachy_tv.lua:567 -- pokefirered/src/teachy_tv.c:1172 TeachyTvPrepBattle
  startDemonstration(session: any, scriptId: unknown, opts?: any): boolean {
    const hook = TeachyTv.onDemonstration;
    if (typeof hook === "function") {
      return hook(session, scriptId, opts) !== false;
    }
    return Pokedude.startTeachyTvBattle(sessionOf(session), scriptId, opts) !== false;
  },

  // Lua: teachy_tv.lua:577 -- pokefirered/src/item_use.c:534 InitTeachyTvFromBag
  show(sessionIn: any, bag?: any, opts?: any): boolean {
    const session = sessionOf(sessionIn);
    TeachyTv.initController(session, TeachyTv.MODE.FRESH);
    // pcall(require, "src.ui.game3.teachy_tv")
    const Ui = G3Lazy["src.ui.game3.teachy_tv"];
    if (Ui != null && typeof Ui === "object" && Ui.show) {
      Ui.show(session, bag, opts);
      return true;
    }
    return false;
  },
};

export default TeachyTv;
