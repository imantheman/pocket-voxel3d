// Port of gen1recomp src/core/game3/trainer_tower.lua (GPLv3 + additional terms; see LICENSE.md).
// Trainer Tower (Sevii Island 7): floor sets, records, timer, party stash.
//
// Return shapes (Lua multiple returns -> 0-based tuples):
//   record -> [rec, state]; formatTime -> [minutes, seconds, centiseconds];
//   numFloorsResult -> [differs, numFloors]. Everything else returns one value.
// Tower reads song ids through song_fields (Tower.MUS_X), as Brian's does.

import { Logger } from "../shared/core/Logger.ts";
import { format, tonumber, tostring, truthy } from "../../../import/gen3/lua.ts";
import { ipairs, len, pairs, remove, seq, type LuaTable } from "../platform/lt.ts";
import { luaLoad } from "../platform/luadata.ts";
import { Fs } from "../platform/fs.ts";
import { Extract } from "../../../import/gen3/extract_island1.ts";
import { TrainerTowerExtract } from "../../../import/gen3/trainer_tower_extract.ts";
import { CacheFs } from "../shared/import/CacheFs.ts";
import { song_fields } from "./song_fields.ts";
import { Dataset } from "./dataset.ts";
import { Runtime } from "./runtime.ts";
import { Task } from "./task.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface TowerRecord {
  timer: number;
  bestTime: number;
  floorsCleared: number;
  spokeToOwner: boolean;
  receivedPrize: boolean;
  checkedFinalTime: boolean;
  hasLost: boolean;
  statusUnk: boolean;
  validated: boolean;
  setId: number;
  [k: string]: any;
}
export interface TowerState { challengeId: number; records: LuaTable; timerRunning: boolean }
export interface TowerHeader { numFloors: number; id: number; _src?: any }

// Lua: trainer_tower.lua:58 -- pokefirered/include/constants/layouts.h:355
const LAYOUT_DOUBLES_FIRST = 366;
// Lua: trainer_tower.lua:60 -- pokefirered/include/constants/layouts.h:363
const LAYOUT_KNOCKOUT_FIRST = 374;

// Lua: trainer_tower.lua:94 -- pokefirered/src/trainer_tower.c:400
const SINGLE_MON_IDXS: Record<number, LuaTable> = {
  0: seq(0, 2), 1: seq(1, 3), 2: seq(2, 4), 3: seq(3, 5),
  4: seq(4, 1), 5: seq(5, 2), 6: seq(0, 3), 7: seq(1, 4),
};
// Lua: trainer_tower.lua:99 -- pokefirered/src/trainer_tower.c:412
const DOUBLE_MON_IDXS: Record<number, LuaTable> = {
  0: seq(0, 1), 1: seq(1, 3), 2: seq(2, 0), 3: seq(3, 4),
  4: seq(4, 2), 5: seq(5, 2), 6: seq(0, 3), 7: seq(1, 5),
};
// Lua: trainer_tower.lua:104 -- pokefirered/src/trainer_tower.c:424
const KNOCKOUT_MON_IDXS: Record<number, LuaTable> = {
  0: seq(0, 2, 4), 1: seq(1, 3, 5), 2: seq(2, 3, 1), 3: seq(3, 4, 0),
  4: seq(4, 1, 2), 5: seq(5, 0, 3), 6: seq(0, 5, 2), 7: seq(1, 4, 5),
};

// Lua: trainer_tower.lua:115 -- pokefirered/src/trainer_tower_sets.c:8951
const NO_HEADER: TowerHeader = { numFloors: 8, id: 0 };

// Lua: trainer_tower.lua:126
function log(msg: unknown): void {
  if (Tower._logged) return;
  Tower._logged = true;
  Logger.info("%s", "[game3/trainer_tower] " + tostring(msg));
}

// Lua: trainer_tower.lua:132
function log_once(key: string, msg: unknown): void {
  Tower._logKeys = Tower._logKeys ?? {};
  if (Tower._logKeys[key]) return;
  Tower._logKeys[key] = true;
  Logger.info("%s", "[game3/trainer_tower] " + tostring(msg));
}

// Lua: trainer_tower.lua:140
function read_bytes(rel: string): string | null {
  try {
    const cache = Dataset.cache();
    if (cache && cache.read) {
      try {
        const d = cache.read(rel);
        if (typeof d === "string" && d.length > 0) return d;
      } catch { /* pcall */ }
    }
  } catch { /* pcall */ }
  if (CacheFs && CacheFs.readActive) {
    try {
      const d = CacheFs.readActive(rel);
      if (typeof d === "string" && d.length > 0) return d;
    } catch { /* pcall */ }
  }
  try {
    const d = Fs.read(rel);
    if (typeof d === "string" && d.length > 0) return d;
  } catch { /* pcall */ }
  // NOT FAITHFUL: io.open(rel, "rb") has no 3DS equivalent beyond Fs.read above.
  return null;
}

// Lua: trainer_tower.lua:167
function load_pack(): any {
  if (Tower._pack != null) return Tower._pack || null;
  const rel = Tower.cacheRel();
  const src = read_bytes(rel);
  if (typeof src === "string" && src.length > 0) {
    const [chunk] = luaLoad(src, "@" + rel);
    let ok = false;
    let pack: any;
    if (chunk) {
      try { pack = chunk(); ok = true; } catch { ok = false; }
    }
    if (chunk && ok && pack != null && typeof pack === "object") {
      Tower._pack = pack;
      return pack;
    }
  }
  log("no " + rel + " in cache; the tower has no floor set");
  Tower._pack = false;
  return null;
}

// Lua: trainer_tower.lua:244
function session_of(): any {
  return Runtime && Runtime.getSession ? Runtime.getSession() ?? null : null;
}

// Lua: trainer_tower.lua:251 -- pokefirered/include/global.h:693
const RECORD_DEFAULTS: Record<string, number | boolean> = {
  timer: 0,
  bestTime: 215999,
  floorsCleared: 0,
  spokeToOwner: false,
  receivedPrize: false,
  checkedFinalTime: false,
  hasLost: false,
  statusUnk: false,
  validated: false,
  setId: 0,
};

// Lua: trainer_tower.lua:278
function normalize_record(rec: any): TowerRecord {
  if (rec == null || typeof rec !== "object") return Tower.newRecord();
  for (const [key, value] of pairs(RECORD_DEFAULTS)) {
    const have = rec[key];
    if (typeof value === "boolean") {
      rec[key] = truthy(have) ? true : false;
    } else {
      rec[key] = tonumber(have) ?? value;
    }
  }
  return rec;
}

// Lua: trainer_tower.lua:403
function stop_task(): void {
  const id = Tower._taskId;
  Tower._taskId = null;
  if (id == null) return;
  if (Task && Task.cancel) {
    try { Task.cancel(id); } catch { /* pcall */ }
  }
}

// Lua: trainer_tower.lua:411
function start_task(): void {
  if (Tower._taskId != null) return;
  if (!(Task && Task.spawn)) return;
  const task = Task.spawn(() => {
    const session = session_of();
    const state = session ? Tower.state(session) : null;
    if (!(state && state.timerRunning)) {
      Tower._taskId = null;
      return true;
    }
    // pokefirered/src/trainer_tower.c:485 SetVBlankCounter1Ptr
    const rec = state.records[state.challengeId + 1];
    rec.timer = rec.timer + 1;
    return false;
  });
  Tower._taskId = task ? task.id ?? null : null;
}

// Lua: trainer_tower.lua:512
function deep_copy(value: any): any {
  if (value == null || typeof value !== "object") return value;
  const out: any = Array.isArray(value) ? [] : {};
  for (const [k, v] of pairs(value)) out[k] = deep_copy(v);
  return out;
}

// Lua: trainer_tower.lua:519
function save_block(session: any): any {
  if (session == null || typeof session !== "object") return null;
  if (session.modData == null || typeof session.modData !== "object") session.modData = {};
  return session.modData;
}

// Lua: trainer_tower.lua:78 -- pokefirered/src/trainer_tower.c:353
const FLOOR_LAYOUTS: Record<number, Record<number, number>> = {};

export const Tower = {
  // Lua: trainer_tower.lua:4 -- pokefirered/include/constants/trainer_tower.h:30
  MAX_FLOORS: 8,
  // pokefirered/include/constants/trainer_tower.h:32
  MAX_TRAINERS_PER_FLOOR: 3,
  // pokefirered/include/constants/trainer_tower.h:61
  MAX_TIME: 215999,
  // pokefirered/include/constants/trainer_tower.h:4
  CHALLENGE_TYPE: { SINGLE: 0, DOUBLE: 1, KNOCKOUT: 2, MIXED: 3 },
  NUM_CHALLENGE_TYPES: 4,
  // pokefirered/include/constants/trainer_tower.h:10
  CHALLENGE_STATUS: { LOST: 0, UNK: 1, NORMAL: 2 },
  // pokefirered/include/constants/trainer_tower.h:56
  TEXT: { INTRO: 2, PLAYER_LOST: 3, PLAYER_WON: 4, AFTER: 5 },

  // Lua: trainer_tower.lua:18 -- pokefirered/include/constants/trainer_tower.h:34
  FUNC: {
    INIT_FLOOR: 0,
    GET_SPEECH: 1,
    DO_BATTLE: 2,
    GET_CHALLENGE_TYPE: 3,
    CLEARED_FLOOR: 4,
    GET_FLOOR_CLEARED: 5,
    START_CHALLENGE: 6,
    GET_OWNER_STATE: 7,
    GIVE_PRIZE: 8,
    CHECK_FINAL_TIME: 9,
    RESUME_TIMER: 10,
    SET_LOST: 11,
    GET_CHALLENGE_STATUS: 12,
    GET_TIME: 13,
    SHOW_RESULTS: 14,
    CLOSE_RESULTS: 15,
    CHECK_DOUBLES: 16,
    GET_NUM_FLOORS: 17,
    SHOULD_WARP_TO_COUNTER: 18,
    ENCOUNTER_MUSIC: 19,
    GET_BEAT_CHALLENGE: 20,
  },
  FUNC_COUNT: 21,

  // Lua: trainer_tower.lua:44 -- pokefirered/src/trainer_tower.c:364 ([0] = 63, then 1..)
  PRIZE_ITEMS: {
    0: 63, 1: 64, 2: 65, 3: 66, 4: 67, 5: 70, 6: 179, 7: 180, 8: 185, 9: 186, 10: 187,
    11: 198, 12: 199, 13: 201, 14: 218,
  } as Record<number, number>,

  // Lua: trainer_tower.lua:49 -- pokefirered/include/constants/event_objects.h:24
  GFX_YOUNGSTER: 18,

  // Lua: trainer_tower.lua:54 -- pokefirered/include/constants/layouts.h:286
  LAYOUT_LOBBY: 297,
  LAYOUT_FIRST_FLOOR: 298,
  LAYOUT_ROOF: 306,

  // Lua: trainer_tower.lua:63
  MAP_LAYOUT_ID: {
    FR_TRAINER_TOWER_LOBBY: 297,
    FR_TRAINER_TOWER_1F: 298,
    FR_TRAINER_TOWER_2F: 299,
    FR_TRAINER_TOWER_3F: 300,
    FR_TRAINER_TOWER_4F: 301,
    FR_TRAINER_TOWER_5F: 302,
    FR_TRAINER_TOWER_6F: 303,
    FR_TRAINER_TOWER_7F: 304,
    FR_TRAINER_TOWER_8F: 305,
    FR_TRAINER_TOWER_ROOF: 306,
    FR_TRAINER_TOWER_ELEVATOR: 307,
  } as Record<string, number>,

  // Lua: trainer_tower.lua:86
  FLOOR_LAYOUTS,

  // Lua: trainer_tower.lua:89 -- pokefirered/include/constants/global.h:78
  PARTY_SIZE: 6,
  // pokefirered/src/party_menu.c:413
  SELECTED_ORDER_SIZE: 3,

  // Lua: trainer_tower.lua:108
  MON_IDXS: {
    0: SINGLE_MON_IDXS,
    1: DOUBLE_MON_IDXS,
    2: KNOCKOUT_MON_IDXS,
  } as Record<number, Record<number, LuaTable>>,

  _logged: null as boolean | null,
  _logKeys: null as Record<string, boolean> | null,
  _pack: null as any,
  _header: null as TowerHeader | null,
  _taskId: null as number | null,

  // Lua: trainer_tower.lua:117
  cacheRel(): string {
    let root: string | undefined;
    try { root = Extract && typeof Extract === "object" ? Extract.CACHE_ROOT : undefined; } catch { root = undefined; }
    root = root || "data/generated/gba";
    const name = (TrainerTowerExtract && typeof TrainerTowerExtract === "object" && TrainerTowerExtract.CACHE_REL)
      || "trainer_tower.lua";
    return root + "/" + name;
  },

  // Lua: trainer_tower.lua:138
  logOnce: log_once,

  // Lua: trainer_tower.lua:184
  resetPack(): void {
    Tower._pack = null;
    Tower._header = null;
    Tower._logged = null;
    Tower._logKeys = null;
  },

  // Lua: trainer_tower.lua:191
  setPack(pack: any): any {
    Tower.resetPack();
    Tower._pack = (pack != null && typeof pack === "object") ? pack : false;
    return Tower._pack || null;
  },

  // Lua: trainer_tower.lua:197
  pack(): any {
    return load_pack();
  },

  // Lua: trainer_tower.lua:202 -- pokefirered/src/trainer_tower.c:527
  header(): TowerHeader {
    const pack = load_pack();
    const h = pack ? (pack.header ?? pack.localHeader) : null;
    if (h == null || typeof h !== "object") return NO_HEADER;
    let cached = Tower._header;
    if (cached && cached._src === h) return cached;
    cached = {
      numFloors: tonumber(h.numFloors) ?? NO_HEADER.numFloors,
      id: tonumber(h.id) ?? NO_HEADER.id,
      _src: h,
    };
    Tower._header = cached;
    return cached;
  },

  // Lua: trainer_tower.lua:217
  normalizeMode(modeIn: unknown): number {
    let mode = tonumber(modeIn) ?? 0;
    // pokefirered/src/trainer_tower.c:772
    if (mode < 0 || mode >= Tower.NUM_CHALLENGE_TYPES) mode = 0;
    return Math.floor(mode);
  },

  // Lua: trainer_tower.lua:225 -- pokefirered/src/trainer_tower.c:529
  floors(modeIn: unknown): LuaTable | null {
    const mode = Tower.normalizeMode(modeIn);
    const pack = load_pack();
    const rows = pack && pack.floors ? (pack.floors[mode] ?? pack.floors[tostring(mode)]) : null;
    if (rows == null || typeof rows !== "object" || rows[1] == null || typeof rows[1] !== "object") {
      log_once("no-floors", "gTrainerTowerFloors is not in this cache; the tower has no floor set");
      return null;
    }
    return rows;
  },

  // Lua: trainer_tower.lua:237 -- pokefirered/src/trainer_tower.c:22
  floor(mode: unknown, floorIdxIn: unknown): any {
    const floorIdx = tonumber(floorIdxIn) ?? 0;
    if (floorIdx < 0 || floorIdx >= Tower.MAX_FLOORS) return null;
    const rows = Tower.floors(mode);
    return rows ? rows[floorIdx + 1] ?? null : null;
  },

  // Lua: trainer_tower.lua:248
  sessionOf: session_of,

  // Lua: trainer_tower.lua:264
  newRecord(): TowerRecord {
    const rec: any = {};
    for (const [key, value] of pairs(RECORD_DEFAULTS)) rec[key] = value;
    return rec;
  },

  // Lua: trainer_tower.lua:270
  newState(): TowerState {
    const records: LuaTable = [null];
    for (let mode = 0; mode <= Tower.NUM_CHALLENGE_TYPES - 1; mode++) {
      records[mode + 1] = Tower.newRecord();
    }
    return { challengeId: 0, records, timerRunning: false };
  },

  // Lua: trainer_tower.lua:291
  state(session?: any): TowerState {
    session = session ?? session_of();
    if (session == null || typeof session !== "object") return Tower.newState();
    let mod = session.modData;
    if (mod == null || typeof mod !== "object") {
      mod = {};
      session.modData = mod;
    }
    let state = session.trainerTower;
    if (state == null || typeof state !== "object") state = mod.trainerTower;
    if (state == null || typeof state !== "object") state = Tower.newState();
    state.challengeId = Tower.normalizeMode(state.challengeId);
    if (state.records == null || typeof state.records !== "object") state.records = [null];
    for (let mode = 0; mode <= Tower.NUM_CHALLENGE_TYPES - 1; mode++) {
      state.records[mode + 1] = normalize_record(state.records[mode + 1]);
    }
    state.timerRunning = truthy(state.timerRunning) ? true : false;
    session.trainerTower = state;
    mod.trainerTower = state;
    return state;
  },

  // Lua: trainer_tower.lua:314 -- pokefirered/src/trainer_tower.c:23
  record(session?: any, mode?: unknown): [TowerRecord, TowerState] {
    const state = Tower.state(session);
    if (mode == null) mode = state.challengeId;
    return [state.records[Tower.normalizeMode(mode) + 1], state];
  },

  // Lua: trainer_tower.lua:320
  getChallengeId(session?: any): number {
    return Tower.state(session).challengeId;
  },

  // Lua: trainer_tower.lua:325 -- pokefirered/src/trainer_tower.c:771
  setChallengeId(session: any, mode: unknown): number {
    const state = Tower.state(session);
    state.challengeId = Tower.normalizeMode(mode);
    return state.challengeId;
  },

  // Lua: trainer_tower.lua:332 -- pokefirered/src/trainer_tower.c:1044
  validateRecord(session: any, mode?: unknown): TowerRecord {
    const rec = Tower.record(session, mode)[0];
    const id = Tower.header().id;
    if (rec.setId !== id) {
      rec.setId = id;
      rec.bestTime = Tower.MAX_TIME;
      rec.receivedPrize = false;
    }
    return rec;
  },

  // Lua: trainer_tower.lua:344 -- pokefirered/src/trainer_tower.c:1077
  bestTime(session?: any, mode?: unknown): number {
    return tonumber(Tower.record(session, mode)[0].bestTime) ?? Tower.MAX_TIME;
  },

  // Lua: trainer_tower.lua:349 -- pokefirered/src/trainer_tower.c:1082
  setBestTime(session: any, value: unknown, mode?: unknown): number {
    const rec = Tower.record(session, mode)[0];
    rec.bestTime = Math.max(0, Math.floor(tonumber(value) ?? Tower.MAX_TIME));
    return rec.bestTime;
  },

  // Lua: trainer_tower.lua:356 -- pokefirered/src/trainer_tower.c:1087
  resetResults(session?: any): TowerState {
    const state = Tower.state(session);
    for (let mode = 0; mode <= Tower.NUM_CHALLENGE_TYPES - 1; mode++) {
      state.records[mode + 1].bestTime = Tower.MAX_TIME;
    }
    return state;
  },

  // Lua: trainer_tower.lua:364
  layoutIdForMap(mapId: any): number | undefined {
    return Tower.MAP_LAYOUT_ID[mapId ?? ""];
  },

  // Lua: trainer_tower.lua:369 -- pokefirered/src/trainer_tower.c:521
  floorIndexForMap(mapId: any): number | null {
    const layoutId = Tower.layoutIdForMap(mapId);
    if (!layoutId) return null;
    return layoutId - Tower.LAYOUT_FIRST_FLOOR;
  },

  // Lua: trainer_tower.lua:376 -- pokefirered/src/trainer_tower.c:546
  isPastFinalFloor(mapId: any): boolean {
    const layoutId = Tower.layoutIdForMap(mapId);
    if (!layoutId) return false;
    return (layoutId - Tower.LAYOUT_LOBBY) > Tower.header().numFloors;
  },

  // Lua: trainer_tower.lua:383 -- pokefirered/src/trainer_tower.c:553
  floorLayoutFor(floorIdx: unknown, challengeType: unknown): number | null {
    const row = FLOOR_LAYOUTS[tonumber(floorIdx) ?? -1];
    if (!row) return null;
    return row[tonumber(challengeType) ?? -1] ?? null;
  },

  // Lua: trainer_tower.lua:390 -- pokefirered/src/trainer_tower.c:799
  prizeItem(session?: any, mode?: unknown): number | null {
    const state = Tower.state(session);
    if (mode == null) mode = state.challengeId;
    const floors = Tower.floors(mode);
    if (!floors) return null;
    return Tower.PRIZE_ITEMS[floors[1].prize] ?? Tower.PRIZE_ITEMS[0];
  },

  // Lua: trainer_tower.lua:399 -- pokefirered/src/trainer_tower.c:485
  isTimerRunning(session?: any): boolean {
    return Tower.state(session).timerRunning === true;
  },

  // Lua: trainer_tower.lua:431 -- pokefirered/src/trainer_tower.c:485
  setTimerRunning(session: any, on: unknown): boolean {
    const state = Tower.state(session);
    state.timerRunning = truthy(on) ? true : false;
    stop_task();
    if (state.timerRunning) start_task();
    return state.timerRunning;
  },

  // Lua: trainer_tower.lua:440 -- pokefirered/src/trainer_tower.c:769
  startChallenge(session: any, mode: unknown): TowerRecord {
    const state = Tower.state(session);
    state.challengeId = Tower.normalizeMode(mode);
    Tower.validateRecord(session, state.challengeId);
    const rec = state.records[state.challengeId + 1];
    rec.validated = true;
    rec.floorsCleared = 0;
    rec.timer = 0;
    rec.spokeToOwner = false;
    rec.checkedFinalTime = false;
    Tower.setTimerRunning(session, true);
    return rec;
  },

  // Lua: trainer_tower.lua:455 -- pokefirered/src/trainer_tower.c:838
  resumeTimer(session?: any): TowerRecord {
    const rec = Tower.record(session)[0];
    if (rec.spokeToOwner) return rec;
    if (rec.timer >= Tower.MAX_TIME) {
      rec.timer = Tower.MAX_TIME;
      Tower.setTimerRunning(session, false);
    } else {
      Tower.setTimerRunning(session, true);
    }
    return rec;
  },

  // Lua: trainer_tower.lua:468 -- pokefirered/src/trainer_tower.c:888
  readTime(session?: any): number {
    const rec = Tower.record(session)[0];
    if (rec.timer >= Tower.MAX_TIME) {
      Tower.setTimerRunning(session, false);
      rec.timer = Tower.MAX_TIME;
    }
    return rec.timer;
  },

  // Lua: trainer_tower.lua:478 -- pokefirered/src/trainer_tower.c:872
  formatTime(framesIn: unknown): [string, string, string] {
    let frames = Math.max(0, Math.floor(tonumber(framesIn) ?? 0));
    const minutes = Math.floor(frames / (60 * 60));
    frames = frames % (60 * 60);
    const seconds = Math.floor(frames / 60);
    frames = frames % 60;
    const centiseconds = Math.floor(frames * 168 / 100);
    return [format("%2d", minutes), format("%2d", seconds), format("%02d", centiseconds)];
  },

  // Lua: trainer_tower.lua:491 -- pokefirered/src/trainer_tower.c:753
  addFloorCleared(session?: any): number {
    const rec = Tower.record(session)[0];
    rec.floorsCleared = rec.floorsCleared + 1;
    return rec.floorsCleared;
  },

  // Lua: trainer_tower.lua:498 -- pokefirered/src/trainer_tower.c:759
  isFloorAlreadyCleared(session: any, mapId: any): boolean {
    const layoutId = Tower.layoutIdForMap(mapId);
    if (!layoutId) return true;
    const state = Tower.state(session);
    const rec = state.records[state.challengeId + 1];
    const floor = Tower.floor(state.challengeId, layoutId - Tower.LAYOUT_FIRST_FLOOR);
    const floorIdx = floor ? floor.floorIdx ?? Tower.MAX_FLOORS : Tower.MAX_FLOORS;
    if ((layoutId - Tower.LAYOUT_FIRST_FLOOR) === rec.floorsCleared
      && (layoutId - Tower.LAYOUT_LOBBY) <= floorIdx) {
      return false;
    }
    return true;
  },

  // Lua: trainer_tower.lua:526 -- pokefirered/src/load_save.c:160
  savePlayerParty(session?: any): LuaTable | null {
    session = session ?? session_of();
    const block = save_block(session);
    if (!block) return null;
    const saved: LuaTable = [null];
    for (let i = 1; i <= Tower.PARTY_SIZE; i++) {
      const mon = session.party ? session.party[i] : null;
      if (mon != null) saved[i] = deep_copy(mon);
    }
    block.savedPlayerParty = saved;
    session.savedPlayerParty = saved;
    return saved;
  },

  // Lua: trainer_tower.lua:541 -- pokefirered/src/load_save.c:170
  loadPlayerParty(session?: any): LuaTable | null {
    session = session ?? session_of();
    const block = save_block(session);
    const saved = session ? (session.savedPlayerParty ?? (block ? block.savedPlayerParty : null)) : null;
    if (saved == null || typeof saved !== "object") {
      log_once("no-saved-party", "LoadPlayerParty with no stashed party; the party is left alone");
      return null;
    }
    const party: LuaTable = [null];
    for (let i = 1; i <= Tower.PARTY_SIZE; i++) {
      if (saved[i] != null) party[i] = deep_copy(saved[i]);
    }
    session.party = party;
    session.savedPlayerParty = saved;
    if (block) block.savedPlayerParty = saved;
    return party;
  },

  // Lua: trainer_tower.lua:559
  savedPlayerParty(session?: any): LuaTable | null {
    session = session ?? session_of();
    const block = save_block(session);
    return session ? (session.savedPlayerParty ?? (block ? block.savedPlayerParty : null)) ?? null : null;
  },

  // Lua: trainer_tower.lua:566 -- pokefirered/src/party_menu.c:413
  selectedOrder(session?: any): LuaTable {
    session = session ?? session_of();
    const block = save_block(session);
    let order = session ? (session.selectedOrderFromParty ?? (block ? block.selectedOrderFromParty : null)) : null;
    if (order == null || typeof order !== "object") order = [null];
    for (let i = 1; i <= Tower.SELECTED_ORDER_SIZE; i++) {
      order[i] = Math.floor(tonumber(order[i]) ?? 0);
    }
    if (session) {
      session.selectedOrderFromParty = order;
      if (block) block.selectedOrderFromParty = order;
    }
    return order;
  },

  // Lua: trainer_tower.lua:582 -- pokefirered/src/party_menu.c:5674
  battleEntryEligible(mon: any): boolean {
    if (mon == null || typeof mon !== "object") return false;
    const species = tonumber(mon.species ?? mon.speciesId) ?? 0;
    if (species === 0 || species === 412) return false;
    if (truthy(mon.isEgg) || truthy(mon.egg)) return false;
    // pokefirered/src/party_menu.c:5687 CHOOSE_MONS_FOR_CABLE_CLUB_BATTLE
    if ((tonumber(mon.hp) ?? 0) === 0) return false;
    return true;
  },

  // Lua: trainer_tower.lua:593 -- pokefirered/src/party_menu.c:3780
  setSelectedOrder(session: any, picks: unknown): LuaTable {
    session = session ?? session_of();
    const order = Tower.selectedOrder(session);
    for (let i = 1; i <= Tower.SELECTED_ORDER_SIZE; i++) order[i] = 0;
    const party = (session && session.party) || [null];
    const slots: LuaTable = [null];
    if (typeof picks === "number") {
      slots[1] = Math.floor(picks) + 1;
    } else if (picks != null && typeof picks === "object") {
      for (const [, slot] of ipairs(picks)) slots[len(slots) + 1] = Math.floor(tonumber(slot) ?? 0);
    }
    let n = 0;
    for (const [, slot] of ipairs<number>(slots)) {
      if (n < Tower.SELECTED_ORDER_SIZE && slot >= 1 && slot <= Tower.PARTY_SIZE
        && Tower.battleEntryEligible(party[slot])) {
        let dup = false;
        for (let i = 1; i <= n; i++) {
          if (order[i] === slot) dup = true;
        }
        if (!dup) {
          n = n + 1;
          order[n] = slot;
        }
      }
    }
    return order;
  },

  // Lua: trainer_tower.lua:622 -- pokefirered/src/party_menu.c:5659
  clearSelectedOrder(session?: any): LuaTable {
    return Tower.setSelectedOrder(session, null);
  },

  // Lua: trainer_tower.lua:627 -- pokefirered/src/script_pokemon_util.c:197
  reducePartyToThree(session?: any): LuaTable | null {
    session = session ?? session_of();
    if (session == null || typeof session !== "object") return null;
    const order = Tower.selectedOrder(session);
    const source = session.party ?? [null];
    const party: LuaTable = [null];
    for (let i = 1; i <= Tower.SELECTED_ORDER_SIZE; i++) {
      const slot = order[i];
      if (slot !== 0 && source[slot] != null) party[len(party) + 1] = source[slot];
    }
    session.party = party;
    return party;
  },

  // Lua: trainer_tower.lua:642 -- pokefirered/src/trainer_tower.c:1026
  partyMaxLevel(session?: any): number {
    session = session ?? session_of();
    let top = 0;
    for (const [, mon] of ipairs<any>((session && session.party) || [null])) {
      const species = tonumber(mon.species ?? mon.speciesId) ?? 0;
      if (species !== 0 && !truthy(mon.isEgg) && !truthy(mon.egg)) {
        const level = tonumber(mon.level) ?? 0;
        if (level > top) top = level;
      }
    }
    return top;
  },

  // Lua: trainer_tower.lua:656 -- pokefirered/src/pokemon.c:1973
  battleTowerMon(src: any, level?: unknown): any {
    if (src == null || typeof src !== "object") return null;
    const moves: LuaTable = [null];
    for (let i = 1; i <= 4; i++) {
      const move = tonumber(src.moves ? src.moves[i] : undefined) ?? 0;
      if (move !== 0) moves[len(moves) + 1] = move;
    }
    const iv = {
      hp: tonumber(src.hpIV) ?? 0,
      atk: tonumber(src.attackIV) ?? 0,
      def: tonumber(src.defenseIV) ?? 0,
      spe: tonumber(src.speedIV) ?? 0,
      spa: tonumber(src.spAttackIV) ?? 0,
      spd: tonumber(src.spDefenseIV) ?? 0,
    };
    return {
      species: tonumber(src.species) ?? 1,
      level: tonumber(level) ?? tonumber(src.level) ?? 5,
      heldItem: tonumber(src.heldItem),
      moves: (len(moves) > 0) ? moves : null,
      ppBonuses: tonumber(src.ppBonuses) ?? 0,
      iv: iv.hp,
      ivs: iv,
      evs: {
        hp: tonumber(src.hpEV) ?? 0,
        atk: tonumber(src.attackEV) ?? 0,
        def: tonumber(src.defenseEV) ?? 0,
        spe: tonumber(src.speedEV) ?? 0,
        spa: tonumber(src.spAttackEV) ?? 0,
        spd: tonumber(src.spDefenseEV) ?? 0,
      },
      personality: tonumber(src.personality) ?? 0,
      abilityNum: tonumber(src.abilityNum) ?? 0,
      friendship: tonumber(src.friendship) ?? 0,
      otId: tonumber(src.otId) ?? 0,
      nickname: typeof src.nickname === "string" ? src.nickname : null,
      trainerId: 0,
    };
  },

  // Lua: trainer_tower.lua:697 -- pokefirered/src/trainer_tower.c:988
  buildEnemyParty(session: any, floor: any, trainerIdxIn: unknown): LuaTable | null {
    session = session ?? session_of();
    if (floor == null || typeof floor !== "object" || floor.trainers == null || typeof floor.trainers !== "object") return null;
    const trainerIdx = Math.floor(tonumber(trainerIdxIn) ?? 0);
    const level = Tower.partyMaxLevel(session);
    const rec = Tower.record(session)[0];
    const floorIdx = Math.max(0, Math.min(Tower.MAX_FLOORS - 1, rec.floorsCleared));
    const idxs = (Tower.MON_IDXS[floor.challengeType] ?? SINGLE_MON_IDXS)[floorIdx];
    const mons: LuaTable = [null];
    // (Lua `mons[#mons + 1] = nil` leaves a hole; JS keeps the slot, removed below)
    let n = 0;
    if (floor.challengeType === Tower.CHALLENGE_TYPE.DOUBLE) {
      for (let i = 1; i <= 2; i++) {
        const trainer = floor.trainers[i];
        const src = trainer && trainer.mons ? trainer.mons[(idxs[i] ?? 0) + 1] : null;
        const m = Tower.battleTowerMon(src, level);
        if (m != null) mons[++n] = m;
      }
    } else if (floor.challengeType === Tower.CHALLENGE_TYPE.KNOCKOUT) {
      const trainer = floor.trainers[trainerIdx + 1];
      const src = trainer && trainer.mons ? trainer.mons[(idxs[trainerIdx + 1] ?? 0) + 1] : null;
      const m = Tower.battleTowerMon(src, level);
      if (m != null) mons[++n] = m;
    } else {
      const trainer = floor.trainers[trainerIdx + 1];
      for (let i = 1; i <= 2; i++) {
        const src = trainer && trainer.mons ? trainer.mons[(idxs[i] ?? 0) + 1] : null;
        const m = Tower.battleTowerMon(src, level);
        if (m != null) mons[++n] = m;
      }
    }
    for (let i = len(mons); i >= 1; i--) {
      if (mons[i] == null) remove(mons, i);
    }
    if (len(mons) === 0) return null;
    return mons;
  },

  // Lua: trainer_tower.lua:731 -- pokefirered/src/trainer_tower.c:457
  facilityClassPic(facilityClassIn: unknown): number | null {
    const facilityClass = tonumber(facilityClassIn);
    if (facilityClass == null) return null;
    const pack = load_pack();
    const pics = pack ? pack.facilityClassPic : null;
    return pics != null && typeof pics === "object" ? tonumber(pics[facilityClass]) ?? null : null;
  },

  // Lua: trainer_tower.lua:740 -- pokefirered/src/trainer_tower.c:733
  battleFoe(session: any, floor: any, trainerIdx: unknown): any {
    const mons = Tower.buildEnemyParty(session, floor, trainerIdx);
    if (!mons) return null;
    const trainer = floor.trainers[Math.floor(tonumber(trainerIdx) ?? 0) + 1] ?? floor.trainers[1];
    const lead = mons[1];
    const foe: any = {
      party: mons,
      // pokefirered/src/trainer_tower.c:740 TRAINER_NONE
      trainerId: 0,
      trainerName: trainer ? trainer.name ?? null : null,
      trainerClass: trainer ? tonumber(trainer.facilityClass) ?? null : null,
      // pokefirered/src/trainer_tower.c:457 GetTrainerTowerTrainerFrontSpriteId
      trainerPicId: Tower.facilityClassPic(trainer ? trainer.facilityClass : undefined),
      doubleBattle: floor.challengeType === Tower.CHALLENGE_TYPE.DOUBLE,
    };
    for (const [, key] of ipairs<string>(seq("species", "level", "iv", "ivs", "evs", "heldItem", "moves", "personality"))) {
      foe[key] = lead[key];
    }
    return foe;
  },

  // Lua: trainer_tower.lua:762 -- pokefirered/src/battle_tower.c:1354 ValidateEReaderTrainer
  ereaderTrainer(session?: any): any {
    session = session ?? session_of();
    const block = save_block(session);
    const trainer = session ? (session.ereaderTrainer ?? (block ? block.ereaderTrainer : null)) : null;
    if (trainer == null || typeof trainer !== "object") return null;
    // pokefirered/src/battle_tower.c:1368 an all-zero record is no trainer at all
    const rows = trainer.party;
    if (rows == null || typeof rows !== "object" || rows[1] == null || typeof rows[1] !== "object") {
      // pokefirered/src/battle_tower.c:1392 ClearEReaderTrainer
      if (session) session.ereaderTrainer = null;
      if (block) block.ereaderTrainer = null;
      return null;
    }
    return trainer;
  },

  // Lua: trainer_tower.lua:779 -- pokefirered/src/battle_tower.c:927
  ereaderFoe(session?: any): any {
    session = session ?? session_of();
    const trainer = Tower.ereaderTrainer(session);
    const rows = trainer != null && typeof trainer === "object" ? trainer.party : null;
    if (rows == null || typeof rows !== "object") return null;
    const mons: LuaTable = [null];
    for (let i = 1; i <= 3; i++) {
      const mon = Tower.battleTowerMon(rows[i]);
      if (mon) mons[len(mons) + 1] = mon;
    }
    if (len(mons) === 0) return null;
    const lead = mons[1];
    const foe: any = {
      party: mons,
      trainerId: 0,
      trainerName: trainer.name,
      trainerClass: tonumber(trainer.facilityClass),
      // pokefirered/src/battle_tower.c:1335 GetEreaderTrainerFrontSpriteId
      trainerPicId: Tower.facilityClassPic(trainer.facilityClass),
    };
    for (const [, key] of ipairs<string>(seq("species", "level", "iv", "ivs", "evs", "heldItem", "moves", "personality"))) {
      foe[key] = lead[key];
    }
    return foe;
  },

  // Lua: trainer_tower.lua:806 -- pokefirered/src/battle_tower.c:915
  copyHeldItems(session: any, toSaved?: boolean): boolean {
    session = session ?? session_of();
    const saved = Tower.savedPlayerParty(session);
    if (saved == null || typeof saved !== "object") return false;
    const party = (session && session.party) || [null];
    for (let i = 1; i <= Tower.PARTY_SIZE; i++) {
      const from = toSaved ? party[i] : saved[i];
      const into = toSaved ? saved[i] : party[i];
      if (from != null && typeof from === "object" && into != null && typeof into === "object") {
        into.heldItem = from.heldItem;
      }
    }
    return true;
  },

  // Lua: trainer_tower.lua:822 -- pokefirered/src/trainer_tower.c:937
  numFloorsResult(mode?: unknown): [boolean, number] {
    const header = Tower.header();
    const floors = Tower.floors(mode);
    const floorIdx = floors ? floors[1].floorIdx ?? Tower.MAX_FLOORS : Tower.MAX_FLOORS;
    if (header.numFloors !== floorIdx) {
      return [true, header.numFloors];
    }
    return [false, header.numFloors];
  },
};

// Lua: trainer_tower.lua:79
for (let i = 0; i <= Tower.MAX_FLOORS - 1; i++) {
  FLOOR_LAYOUTS[i] = {
    [Tower.CHALLENGE_TYPE.SINGLE]: Tower.LAYOUT_FIRST_FLOOR + i,
    [Tower.CHALLENGE_TYPE.DOUBLE]: LAYOUT_DOUBLES_FIRST + i,
    [Tower.CHALLENGE_TYPE.KNOCKOUT]: LAYOUT_KNOCKOUT_FIRST + i,
  };
}

// Lua: trainer_tower.lua:51 -- pokefirered/include/constants/songs.h:293
song_fields(Tower);

export default Tower;
