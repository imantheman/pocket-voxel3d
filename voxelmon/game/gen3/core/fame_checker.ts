// Port of gen1recomp src/core/game3/fame_checker.lua (GPLv3 + additional terms; see LICENSE.md).
// Fame Checker records (pokefirered/src/fame_checker.c): per person a pick
// state and a 6-bit flavor-text mask. The records are a Lua sequence of
// NUM_PERSONS tables (person p at recs[p + 1]), mirrored into
// session.modData.fameChecker.
// package.loaded["src.core.game3.runtime" / ".scripting.space"]: every module
// is in the bundle, so both are imported directly.

import { tonumber } from "../../../import/gen3/lua.ts";
import { seq, insert } from "../platform/lt.ts";
import RuntimeMod from "./runtime.ts";
import SpaceMod from "./scripting/space.ts";
import FlagsMod from "./scripting/flags.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface FameRecord { pickState: number; flavorTextFlags: number; [k: string]: any }

// pokefirered/include/constants/fame_checker.h:4
const PERSON = {
  OAK: 0,
  DAISY: 1,
  BROCK: 2,
  MISTY: 3,
  LTSURGE: 4,
  ERIKA: 5,
  KOGA: 6,
  SABRINA: 7,
  BLAINE: 8,
  LORELEI: 9,
  BRUNO: 10,
  AGATHA: 11,
  LANCE: 12,
  BILL: 13,
  MRFUJI: 14,
  GIOVANNI: 15,
};

// pokefirered/include/constants/fame_checker.h:22
const PICKSTATE = {
  NO_DRAW: 0,
  SILHOUETTE: 1,
  COLORED: 2,
};

// pokefirered/src/fame_checker.c:1064
const TRAINER_LEADER_GIOVANNI = 350;

const PICK = PICKSTATE;

function isTable(v: unknown): v is Record<string, any> {
  return v !== null && typeof v === "object";
}

// Lua: fame_checker.lua:66
function sessionOf(session: any): any {
  if (isTable(session)) return session;
  const rt: any = RuntimeMod;
  const got = rt && rt.getSession ? rt.getSession() : undefined;
  if (isTable(got)) return got;
  return undefined;
}

// Lua: fame_checker.lua:75
// pokefirered/src/fame_checker.c:1140 ResetFameChecker
function blankRecords(): any {
  const recs: any = seq();
  for (let i = 1; i <= FameChecker.NUM_PERSONS; i++) {
    recs[i] = { pickState: PICK.NO_DRAW, flavorTextFlags: 0 };
  }
  recs[FameChecker.PERSON.OAK + 1].pickState = PICK.COLORED;
  return recs;
}

// Lua: fame_checker.lua:198
function giovanniBeatenInGym(session: any): boolean {
  const Space: any = SpaceMod;
  const store = (Space && Space.store) || (isTable(session) ? session.store : undefined) || undefined;
  if (!store) return false;
  const r = (FlagsMod as any).isTrainerDefeated(store, null, TRAINER_LEADER_GIOVANNI);
  return r != null && r !== false;
}

export const FameChecker = {
  PERSON,
  // pokefirered/include/constants/fame_checker.h:20
  NUM_PERSONS: 16,
  // pokefirered/src/fame_checker.c:1158
  NUM_FLAVOR_TEXTS: 6,
  PICKSTATE,
  // pokefirered/src/fame_checker.c:32
  NON_TRAINER_START: 0xFE00,
  // pokefirered/src/fame_checker.c:145 sTrainerIdxs (Lua [0] = first: a 0-based array)
  TRAINER_IDS: [
    0xFE00,
    0xFE01,
    414,
    415,
    416,
    417,
    418,
    420,
    419,
    410,
    411,
    412,
    413,
    0xFE02,
    0xFE03,
    348,
  ] as number[],

  // Lua: fame_checker.lua:84
  records(sessionIn?: any): any {
    const session = sessionOf(sessionIn);
    if (!isTable(session)) return undefined;
    let md = session.modData;
    if (!isTable(md)) {
      md = {};
      session.modData = md;
    }
    let recs = session.fameChecker;
    if (!isTable(recs)) recs = md.fameChecker;
    if (!isTable(recs)) recs = blankRecords();
    for (let i = 1; i <= FameChecker.NUM_PERSONS; i++) {
      let rec = recs[i];
      if (!isTable(rec)) {
        rec = { pickState: PICK.NO_DRAW, flavorTextFlags: 0 };
        recs[i] = rec;
      }
      rec.pickState = tonumber(rec.pickState) ?? PICK.NO_DRAW;
      rec.flavorTextFlags = tonumber(rec.flavorTextFlags) ?? 0;
    }
    session.fameChecker = recs;
    md.fameChecker = recs;
    return recs;
  },

  // Lua: fame_checker.lua:109
  record(session: any, person: unknown): FameRecord | undefined {
    const p = tonumber(person);
    if (p == null || p < 0 || p >= FameChecker.NUM_PERSONS) return undefined;
    const recs = FameChecker.records(session);
    if (!recs) return undefined;
    return recs[p + 1];
  },

  // Lua: fame_checker.lua:118
  // pokefirered/src/fame_checker.c:1140
  reset(sessionIn?: any): boolean {
    const session = sessionOf(sessionIn);
    if (!isTable(session)) return false;
    delete session.fameChecker;
    if (isTable(session.modData)) delete session.modData.fameChecker;
    return FameChecker.records(session) != null;
  },

  // Lua: fame_checker.lua:127
  // pokefirered/src/fame_checker.c:1152 FullyUnlockFameChecker
  fullyUnlock(session?: any): boolean {
    const recs = FameChecker.records(session);
    if (!recs) return false;
    let all = 0;
    for (let j = 0; j <= FameChecker.NUM_FLAVOR_TEXTS - 1; j++) {
      all = all | (1 << j);
    }
    for (let i = 1; i <= FameChecker.NUM_PERSONS; i++) {
      recs[i].pickState = PICK.COLORED;
      recs[i].flavorTextFlags = all;
    }
    return true;
  },

  // Lua: fame_checker.lua:142
  // pokefirered/src/fame_checker.c:1232 UpdatePickStateFromSpecialVar8005
  updatePickState(person: unknown, state: unknown, session?: any): boolean {
    const p = tonumber(person), st = tonumber(state);
    if (p == null || st == null) return false;
    if (p < 0 || p >= FameChecker.NUM_PERSONS) return false;
    if (st < 0 || st >= 3) return false;
    if (st === PICK.NO_DRAW) return false;
    const rec = FameChecker.record(session, p);
    if (!rec) return false;
    if (st === PICK.SILHOUETTE && rec.pickState === PICK.COLORED) return false;
    rec.pickState = st;
    return true;
  },

  // Lua: fame_checker.lua:156
  // pokefirered/src/fame_checker.c:1222 SetFlavorTextFlagFromSpecialVars
  setFlavorText(person: unknown, slot: unknown, session?: any): boolean {
    const p = tonumber(person), s = tonumber(slot);
    if (p == null || s == null) return false;
    if (p < 0 || p >= FameChecker.NUM_PERSONS) return false;
    if (s < 0 || s >= FameChecker.NUM_FLAVOR_TEXTS) return false;
    const rec = FameChecker.record(session, p);
    if (!rec) return false;
    rec.flavorTextFlags = rec.flavorTextFlags | (1 << s);
    FameChecker.updatePickState(p, PICK.SILHOUETTE, session);
    return true;
  },

  // Lua: fame_checker.lua:168
  pickState(session: any, person: unknown): number {
    const rec = FameChecker.record(session, person);
    if (!rec) return PICK.NO_DRAW;
    return rec.pickState;
  },

  // Lua: fame_checker.lua:174
  flavorTextFlags(session: any, person: unknown): number {
    const rec = FameChecker.record(session, person);
    if (!rec) return 0;
    return rec.flavorTextFlags;
  },

  // Lua: fame_checker.lua:180
  hasFlavorText(session: any, person: unknown, slot: unknown): boolean {
    const s = tonumber(slot);
    if (s == null || s < 0 || s >= FameChecker.NUM_FLAVOR_TEXTS) return false;
    const rec = FameChecker.record(session, person);
    if (!rec) return false;
    return ((rec.flavorTextFlags >>> s) & 1) === 1;
  },

  // Lua: fame_checker.lua:189
  // pokefirered/src/fame_checker.c:1246 HasUnlockedAllFlavorTextsForCurrentPerson
  hasUnlockedAllFlavorTexts(session: any, person: unknown): boolean {
    const rec = FameChecker.record(session, person);
    if (!rec) return false;
    for (let i = 0; i <= FameChecker.NUM_FLAVOR_TEXTS - 1; i++) {
      if (((rec.flavorTextFlags >>> i) & 1) !== 1) return false;
    }
    return true;
  },

  // Lua: fame_checker.lua:207
  // pokefirered/src/fame_checker.c:1062 AdjustGiovanniIndexIfBeatenInGym
  adjustGiovanniIndex(index: unknown, beaten: unknown): number {
    const i = tonumber(index) ?? 0;
    if (beaten == null || beaten === false) return i;
    if (i === 9) return FameChecker.PERSON.GIOVANNI;
    if (i > 9) return i - 1;
    return i;
  },

  // Lua: fame_checker.lua:216
  // pokefirered/src/fame_checker.c:1546 FC_PopulateListMenu
  unlockedPersons(sessionIn?: any): any {
    const session = sessionOf(sessionIn);
    const recs = FameChecker.records(session);
    if (!recs) return seq();
    const beaten = giovanniBeatenInGym(session);
    const list: any = seq();
    for (let i = 0; i <= FameChecker.NUM_PERSONS - 1; i++) {
      const idx = FameChecker.adjustGiovanniIndex(i, beaten);
      if (recs[idx + 1].pickState !== PICK.NO_DRAW) {
        insert(list, idx);
      }
    }
    return list;
  },
};

export default FameChecker;
