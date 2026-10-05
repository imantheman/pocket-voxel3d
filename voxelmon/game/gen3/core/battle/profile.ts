// Port of gen1recomp src/core/game3/battle/profile.lua (GPLv3 + additional terms; see LICENSE.md).
// Per-game battle profile: AI flag bits, battle kinds, rules, strings, music.
//
// Port notes:
// - The weak-keyed caches (`setmetatable({}, { __mode = "k" })`) are WeakMaps.
// - error(msg, 2) becomes a thrown Error (no position prefix).
// - `require("src.core.game3.constants")` and `rom_text` are static imports.

import { tonumber, tostring, truthy } from "../../../../import/gen3/lua.ts";
import { ipairs, pairs } from "../../platform/lt.ts";
import { Profile } from "../profile.ts";
import { Constants } from "../constants.ts";
import { RomText } from "../rom_text.ts";

export type BattleProfileT = Record<string, any>;

// pokefirered/include/constants/battle_ai.h:37
const FRLG_AI_BITS: Record<string, number> = {
  CHECK_BAD_MOVE: 0,
  CHECK_VIABILITY: 1,
  TRY_TO_FAINT: 2,
  SETUP_FIRST_TURN: 3,
  RISKY: 4,
  PREFER_STRONGEST_MOVE: 5,
  PREFER_BATON_PASS: 6,
  DOUBLE_BATTLE: 7,
  HP_AWARE: 8,
  UNKNOWN: 9,
  ROAMING: 29,
  SAFARI: 30,
  FIRST_BATTLE: 31,
};

const DEFAULTS: BattleProfileT = {
  family: "frlg",
  aiVariant: "frlg",
  aiFlagBits: FRLG_AI_BITS,
  kinds: {
    firstBattle: "oak",
    tutorial: "oldman",
    ghost: true,
    pokedude: true,
  },
  firstBattle: null,
  rules: {
    obedienceFocusPunchExempt: true,
    critExclusions: {},
    noExp: { link: true, trainerTower: true, eReader: true },
    pickup: "flat",
    money: "frlg",
    moneyMessageAlways: false,
    whiteout: "frlg",
    lostText: "frlg",
    legendaryAi: true,
    wildScriptedAi: true,
  },
  strings: {
    caught: "STRINGID_GOTCHAPKMNCAUGHT",
    legendaryIntro: "sText_WildPkmnAppeared2",
    // pokefirered/src/battle_controller_safari.c:446
    safariPrompt: "gText_WhatWillPlayerThrow",
    // pokefirered/src/battle_interface.c:1762
    safariBallsLeft: "gText_HighlightRed_Left",
    // pokefirered/src/pokemon_summary_screen.c:3899
    hmCantForget: "gText_PokeSum_HmMovesCantBeForgotten",
  },
  // pokefirered/src/battle_anim_special.c:1200
  sounds: { caughtIntro: "MUS_CAUGHT_INTRO", caught: "MUS_CAUGHT" },
  badgeFlags: null,
  music: null,
  animCacheFallback: "firered/",
};

let merged = new WeakMap<object, BattleProfileT>();

const SHALLOW_MERGE: Record<string, boolean> = { rules: true, kinds: true, strings: true, sounds: true };

const isTable = (v: unknown): v is Record<string, any> => v !== null && typeof v === "object";

// Lua: profile.lua:66
function merge(base: BattleProfileT, over: any): BattleProfileT {
  if (!isTable(over)) return base;
  const out: BattleProfileT = {};
  for (const [k, v] of pairs(base)) out[k] = v;
  for (const [k, v] of pairs(over)) {
    if (SHALLOW_MERGE[k] && isTable(v) && isTable(base[k])) {
      const t: Record<string, any> = {};
      for (const [k2, v2] of pairs(base[k])) t[k2] = v2;
      for (const [k2, v2] of pairs(v)) t[k2] = v2;
      out[k] = t;
    } else {
      out[k] = v;
    }
  }
  return out;
}

// Lua: profile.lua:83
function row_for(session: any): any {
  try {
    const row = Profile.forSession(session);
    if (isTable(row)) return row;
  } catch {
    // Lua: pcall failed
  }
  return null;
}

let hosted = new WeakMap<object, Record<string, BattleProfileT>>();

// Lua: profile.lua:178
function music_by_class(list: any, className: any, def: any): any {
  for (const [, row] of ipairs<any>(list ?? {})) {
    for (const [, c] of ipairs(row.classes)) {
      if (c === className) return row.song;
    }
  }
  return def;
}

export const BattleProfile = {
  DEFAULTS,

  // Lua: profile.lua:89
  forRow(row: any): BattleProfileT {
    if (!isTable(row)) return BattleProfile.DEFAULTS;
    let p = merged.get(row);
    if (p) return p;
    p = merge(BattleProfile.DEFAULTS, row.battle);
    if (p.badgeFlags == null && p.family === "rse" && isTable(row.badges)) {
      const base = tonumber(row.badges.flagBase);
      if (base != null) {
        const flags: (number | null)[] = [null];
        const count = tonumber(row.badges.count) ?? 8;
        for (let i = 1; i <= count; i++) flags[i] = base + i - 1;
        p.badgeFlags = flags;
      }
    }
    p.gameId = row.id;
    merged.set(row, p);
    return p;
  },

  // Lua: profile.lua:107
  get(session?: any): BattleProfileT {
    return BattleProfile.forRow(row_for(session));
  },

  // Lua: profile.lua:114 -- pokeemerald/src/battle_controllers.c:397
  withHostRules(p: BattleProfileT, hostVersion: string): BattleProfileT {
    let byHost = hosted.get(p);
    if (!byHost) {
      byHost = {};
      hosted.set(p, byHost);
    }
    let out = byHost[hostVersion];
    if (out) return out;
    const row: any = Profile.of(hostVersion);
    const h = BattleProfile.forRow(row);
    out = {};
    for (const [k, v] of pairs(p)) out[k] = v;
    out.family = row.family ?? h.family;
    out.rules = h.rules;
    out.rulesFrom = h.gameId;
    byHost[hostVersion] = out;
    return out;
  },

  // Lua: profile.lua:133
  of(st?: any): BattleProfileT {
    const p = BattleProfile.get(isTable(st) ? st.session : null);
    const host = isTable(st) ? st.hostRules : null;
    if (typeof host === "string") return BattleProfile.withHostRules(p, host);
    return p;
  },

  // Lua: profile.lua:140
  isRse(st?: any): boolean {
    return BattleProfile.of(st).family === "rse";
  },

  // Lua: profile.lua:144
  aiBit(p: BattleProfileT, name: string): number {
    const bit = p.aiFlagBits[name];
    if (bit == null) {
      throw new Error("battle profile " + tostring(p.gameId) + " has no AI script bit " + tostring(name));
    }
    return Math.pow(2, bit);
  },

  // Lua: profile.lua:152
  aiFlags(p: BattleProfileT, names: any): number {
    let v = 0;
    for (const [, name] of ipairs<string>(names)) v = v + BattleProfile.aiBit(p, name);
    return v;
  },

  // Lua: profile.lua:158
  rule(st: any, name: string): any {
    return BattleProfile.of(st).rules[name];
  },

  // Lua: profile.lua:162
  constants(p: BattleProfileT): any {
    return Constants.of(truthy(p.gameId) ? p.gameId : "firered");
  },

  // Lua: profile.lua:166
  song(p: BattleProfileT, name: string): any {
    const id = BattleProfile.constants(p).song(name);
    if (id == null) throw new Error("battle profile: no song " + tostring(name));
    return id;
  },

  // Lua: profile.lua:172
  classNameOf(p: BattleProfileT, classId: any): any {
    classId = tonumber(classId);
    if (classId == null) return null;
    return BattleProfile.constants(p).name("trainer_classes", classId, "TRAINER_CLASS_");
  },

  // Lua: profile.lua:187
  battleSong(p: BattleProfileT, info?: any): any {
    const m = p.music;
    if (!truthy(m)) return null;
    info = info ?? {};
    if (truthy(info.kind) && truthy(m.kinds) && truthy(m.kinds[info.kind])) return BattleProfile.song(p, m.kinds[info.kind]);
    if (truthy(info.link)) return BattleProfile.song(p, truthy(m.link) ? m.link : m.trainer);
    if (truthy(info.wild)) return BattleProfile.song(p, m.wild);
    const className = BattleProfile.classNameOf(p, info.trainerClass);
    let song = music_by_class(m.byClass, className, m.trainer);
    if (truthy(className) && truthy(m.rivalWallyText) && className === m.rivalClass && !truthy(info.frontier)
        && info.trainerName === RomText.plain(m.rivalWallyText)) {
      song = m.trainer;
    }
    return BattleProfile.song(p, song);
  },

  // Lua: profile.lua:203
  victorySong(p: BattleProfileT, info?: any): any {
    const m = p.music;
    if (!truthy(m)) return null;
    info = info ?? {};
    if (truthy(info.wild)) return BattleProfile.song(p, m.victoryWild);
    const className = BattleProfile.classNameOf(p, info.trainerClass);
    return BattleProfile.song(p, music_by_class(m.victoryByClass, className, m.victoryTrainer));
  },

  // Lua: profile.lua:212
  reset(): void {
    merged = new WeakMap();
    hosted = new WeakMap();
  },
};

export default BattleProfile;
