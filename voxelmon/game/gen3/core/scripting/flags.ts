// Port of gen1recomp src/core/game3/scripting/flags.lua (GPLv3 + additional terms; see LICENSE.md).
// Sevii / FRLG flag and variable store: persist narrative and story flags;
// never persist specialVars 0x8000-0x8014.
//
// Port notes:
// - lazyReq(name) of profile/constants is a static import.
// - repairForGame's `require(path)` on the profile's `saveRules` module name
//   resolves through a static table of the rules modules in the port
//   (SAVE_RULES); a name with no module throws NotPortedError, as a failed
//   require would.
// - NOT FAITHFUL: a JS object holds `flags[1234]` and `flags["1234"]` as one
//   key where the Lua table holds two. Brian always writes and clears both
//   together, so the reads agree.
// - activeBadges returns the 0-based tuple [badges, lookup].

/* eslint-disable @typescript-eslint/no-explicit-any */
import { ipairs, pairs, sort, len, seq, type LuaTable } from "../../platform/lt.ts";
import { find } from "../../platform/lpattern.ts";
import { format, sub, tonumber, tostring, truthy, mod } from "../../../../import/gen3/lua.ts";
import { notPorted } from "../../notported.ts";
import { Ctx } from "./ctx.ts";
import FlagsTable from "./flags_table.ts";
import ModRuntime from "../../shared/mods/Runtime.ts";
import Profile from "../profile.ts";
import Constants from "../constants.ts";
import FireredRules from "../profiles/firered_rules.ts";

export interface BadgeInfo {
  num: number;
  flag: number;
  name: string;
  gym: string;
  fieldMove: string;
}

export interface FlagStore {
  flags: Record<string | number, any>;
  vars: Record<string | number, any>;
  [key: string]: any;
}

export interface VersionFlags {
  game: string;
  IDS: Record<string, number>;
  VAR_IDS: Record<string, number>;
  NAMES: Record<number, string>;
  VAR_NAMES: Record<number, string>;
  BADGES: LuaTable;
  TRAINER_FLAGS_START: number;
  TRAINER_FLAGS_END: number;
  FLAGS_COUNT: number;
}

const FT: any = FlagsTable;

// Lua: flags.lua:329 (require(path) of the profile's saveRules module)
// Built on first use: firered_rules imports this module (import cycle).
let saveRules: Record<string, any> | undefined;
function SAVE_RULES(): Record<string, any> {
  return (saveRules ??= {
    "src.core.game3.profiles.firered_rules": FireredRules,
  });
}

// Table-driven flag definitions with backwards-compatible aliases
// Lua: flags.lua:17
const IDS: Record<string, number> = {};
const NAMES: Record<number, string> = FT.FLAGS_BY_ID ?? {};

for (const [k, v] of pairs<number>(FT.FLAGS ?? {})) {
  const ks = k as string;
  IDS[ks] = v;
  if (find(ks, "^FLAG_") != null) {
    const stripped = sub(ks, 6);
    if (IDS[stripped] == null) {
      IDS[stripped] = v;
    }
  }
}

// Table-driven var definitions with backwards-compatible aliases
// Lua: flags.lua:31
const VAR_IDS: Record<string, number> = {};
const VAR_NAMES: Record<number, string> = FT.VARS_BY_ID ?? {};

for (const [k, v] of pairs<number>(FT.VARS ?? {})) {
  const ks = k as string;
  VAR_IDS[ks] = v;
  if (IDS[ks] == null) {
    IDS[ks] = v;
  }
  if (find(ks, "^VAR_") != null) {
    const stripped = sub(ks, 5);
    if (VAR_IDS[stripped] == null) {
      VAR_IDS[stripped] = v;
    }
    if (IDS[stripped] == null) {
      IDS[stripped] = v;
    }
  }
}

// Badge definitions
// Lua: flags.lua:81
const BADGES: LuaTable = FT.BADGES ?? seq<BadgeInfo>(
  { num: 1, flag: 0x820, name: "BOULDER", gym: "PEWTER", fieldMove: "FLASH" },
  { num: 2, flag: 0x821, name: "CASCADE", gym: "CERULEAN", fieldMove: "CUT" },
  { num: 3, flag: 0x822, name: "THUNDER", gym: "VERMILION", fieldMove: "FLY" },
  { num: 4, flag: 0x823, name: "RAINBOW", gym: "CELADON", fieldMove: "STRENGTH" },
  { num: 5, flag: 0x824, name: "SOUL", gym: "FUCHSIA", fieldMove: "SURF" },
  { num: 6, flag: 0x825, name: "MARSH", gym: "SAFFRON", fieldMove: "ROCK_SMASH" },
  { num: 7, flag: 0x826, name: "VOLCANO", gym: "CINNABAR", fieldMove: "WATERFALL" },
  { num: 8, flag: 0x827, name: "EARTH", gym: "VIRIDIAN", fieldMove: "DIVE" },
);

// Lua: flags.lua:92
function buildBadgeLookup(badges: LuaTable): Record<string | number, BadgeInfo> {
  const BADGE_LOOKUP: Record<string | number, BadgeInfo> = {};
  for (const [, b] of ipairs<BadgeInfo>(badges)) {
    BADGE_LOOKUP[b.num] = b;
    BADGE_LOOKUP[b.name] = b;
    BADGE_LOOKUP[b.name.toLowerCase()] = b;
    BADGE_LOOKUP[b.name + "BADGE"] = b;
    BADGE_LOOKUP[(b.name + "BADGE").toLowerCase()] = b;
    BADGE_LOOKUP[b.name + "_BADGE"] = b;
    BADGE_LOOKUP[(b.name + "_BADGE").toLowerCase()] = b;
    BADGE_LOOKUP[b.fieldMove] = b;
    BADGE_LOOKUP[b.fieldMove.toLowerCase()] = b;
    BADGE_LOOKUP[b.flag] = b;
    BADGE_LOOKUP[tostring(b.flag)] = b;
    BADGE_LOOKUP[format("FLAG_BADGE0%d_GET", b.num)] = b;
  }
  return BADGE_LOOKUP;
}

// Lua: flags.lua:111
const BADGE_LOOKUP = buildBadgeLookup(BADGES);
const badgeLookups: Record<string, Record<string | number, BadgeInfo>> = {};

// Lua: flags.lua:114 -- [badges, lookup]
function activeBadges(): [LuaTable, Record<string | number, BadgeInfo>] {
  const game = Profile.forSession(null).id;
  const t = Flags.forVersion(game);
  if (t.BADGES === Flags.BADGES) return [Flags.BADGES, BADGE_LOOKUP];
  let lookup = badgeLookups[t.game];
  if (!lookup) {
    lookup = buildBadgeLookup(t.BADGES);
    badgeLookups[t.game] = lookup;
  }
  return [t.BADGES, lookup];
}

// pokeemerald/src/party_menu.c:120
// Lua: flags.lua:132
const EM_BADGES = seq(
  { num: 1, name: "STONE", gym: "RUSTBORO", fieldMove: "CUT" },
  { num: 2, name: "KNUCKLE", gym: "DEWFORD", fieldMove: "FLASH" },
  { num: 3, name: "DYNAMO", gym: "MAUVILLE", fieldMove: "ROCK_SMASH" },
  { num: 4, name: "HEAT", gym: "LAVARIDGE", fieldMove: "STRENGTH" },
  { num: 5, name: "BALANCE", gym: "PETALBURG", fieldMove: "SURF" },
  { num: 6, name: "FEATHER", gym: "FORTREE", fieldMove: "FLY" },
  { num: 7, name: "MIND", gym: "MOSSDEEP", fieldMove: "DIVE" },
  { num: 8, name: "RAIN", gym: "SOOTOPOLIS", fieldMove: "WATERFALL" },
);

// Lua: flags.lua:143
function sortedKeys(t: Record<string, any>): LuaTable {
  const keys: LuaTable = seq();
  for (const [k] of pairs(t)) keys[len(keys) + 1] = k;
  sort(keys);
  return keys;
}

// Lua: flags.lua:150
function buildGenerated(game: string): VersionFlags {
  const C: any = Constants.of(game);
  const flags = C.flags, vars = C.vars;
  const ids: Record<string, number> = {}, varIds: Record<string, number> = {};
  const fkeys = sortedKeys(flags.byName), vkeys = sortedKeys(vars.byName);
  for (const [, k] of ipairs<string>(fkeys)) ids[k] = flags.byName[k];
  for (const [, k] of ipairs<string>(vkeys)) {
    varIds[k] = vars.byName[k];
    if (ids[k] == null) ids[k] = vars.byName[k];
  }
  for (const [, k] of ipairs<string>(fkeys)) {
    if (find(k, "^FLAG_") != null && ids[sub(k, 6)] == null) ids[sub(k, 6)] = flags.byName[k];
  }
  for (const [, k] of ipairs<string>(vkeys)) {
    if (find(k, "^VAR_") != null) {
      const s = sub(k, 5);
      if (varIds[s] == null) varIds[s] = vars.byName[k];
      if (ids[s] == null) ids[s] = vars.byName[k];
    }
  }
  const badges: LuaTable = seq();
  for (const [i, b] of ipairs<any>(EM_BADGES)) {
    badges[i] = {
      num: b.num, name: b.name, gym: b.gym, fieldMove: b.fieldMove,
      flag: flags.byName[format("FLAG_BADGE0%d_GET", b.num)],
    };
  }
  return {
    game,
    IDS: ids,
    VAR_IDS: varIds,
    NAMES: flags.byId.FLAG_ ?? {},
    VAR_NAMES: vars.byId.VAR_ ?? {},
    BADGES: badges,
    TRAINER_FLAGS_START: ids.TRAINER_FLAGS_START,
    TRAINER_FLAGS_END: ids.TRAINER_FLAGS_END,
    FLAGS_COUNT: ids.FLAGS_COUNT,
  };
}

const versionTables: Record<string, VersionFlags> = {};

// Lua: flags.lua:329
function repairForGame(store: any): void {
  const path = Profile.forSession(store).saveRules;
  let rules: any = null;
  if (typeof path === "string") {
    rules = SAVE_RULES()[path];
    if (rules == null) notPorted(`require("${path}") (no such module in the port yet)`);
  }
  if (rules && rules.repairSaveState) rules.repairSaveState(store);
}

function idOf(id: any, table: Record<string, number>): number {
  const n = tonumber(id);
  if (n != null) return n;
  if (typeof id === "string") {
    const v = table[id];
    if (v != null) return v;
  }
  return 0;
}

export const Flags = {
  IDS,
  NAMES,
  VAR_IDS,
  VAR_NAMES,

  // pret TRAINER_FLAGS_START (FLAG_0x4FF + 1). Trainer N -> flag 0x500 + N.
  TRAINER_FLAGS_START: (IDS.TRAINER_FLAGS_START ?? 0x500) as number,
  TRAINER_FLAGS_END: (IDS.TRAINER_FLAGS_END ?? 0x7FF) as number,

  // Lua: flags.lua:54
  trainerFlagId(trainerId: any): number {
    return Flags.TRAINER_FLAGS_START + (tonumber(trainerId) ?? 0);
  },

  // Lua: flags.lua:58
  isTrainerDefeated(store: any, session: any, trainerId?: any): boolean {
    const tId = trainerId ?? session;
    const fid = Flags.trainerFlagId(tId);
    return Flags.getFlag(store, null, fid);
  },

  // Lua: flags.lua:64
  setTrainerDefeated(store: any, session: any, trainerId?: any, on?: any): void {
    let tId = trainerId;
    let val = on;
    if (on == null && typeof session === "number") {
      tId = session;
      val = trainerId;
    }
    const fid = Flags.trainerFlagId(tId);
    Flags.setFlag(store, null, fid, val !== false);
  },

  // pret EventScript_ResetAllMapFlags (derived from event_scripts.s).
  NEW_GAME_HIDE_FLAGS: FT.NEW_GAME_HIDE_FLAGS as LuaTable,

  NEW_GAME_RESET_VARS: (FT.NEW_GAME_RESET_VARS ?? seq()) as LuaTable,

  BADGES,

  // Lua: flags.lua:126
  badgeInfo(badgeKey: any): BadgeInfo | undefined {
    const [, lookup] = activeBadges();
    return lookup[badgeKey] ?? (typeof badgeKey === "number" ? lookup[badgeKey] : undefined);
  },

  // Lua: flags.lua:192
  forVersion(id: any): VersionFlags {
    const game = Constants.gameKey(id);
    let t = versionTables[game];
    if (t) return t;
    if (game === "firered") {
      t = {
        game,
        IDS: Flags.IDS,
        VAR_IDS: Flags.VAR_IDS,
        NAMES: Flags.NAMES,
        VAR_NAMES: Flags.VAR_NAMES,
        BADGES: Flags.BADGES,
        TRAINER_FLAGS_START: Flags.TRAINER_FLAGS_START,
        TRAINER_FLAGS_END: Flags.TRAINER_FLAGS_END,
        FLAGS_COUNT: Flags.IDS.FLAGS_COUNT,
      };
    } else {
      t = buildGenerated(game);
    }
    versionTables[game] = t;
    return t;
  },

  // Lua: flags.lua:215
  active(session?: any): VersionFlags {
    return Flags.forVersion(Constants.versionOf(session));
  },

  /** Check if badge is obtained */
  // Lua: flags.lua:220
  hasBadge(store: any, badgeKey: any): boolean {
    const info = Flags.badgeInfo(badgeKey);
    if (!info) return false;
    return Flags.getFlag(store, null, info.flag);
  },

  /** Set or clear a badge */
  // Lua: flags.lua:227
  setBadge(store: any, badgeKey: any, on?: any): void {
    const info = Flags.badgeInfo(badgeKey);
    if (!info) return;
    Flags.setFlag(store, null, info.flag, on !== false);
  },

  /** Count total badges obtained (0..8) */
  // Lua: flags.lua:234
  countBadges(store: any): number {
    let n = 0;
    for (const [, b] of ipairs<BadgeInfo>(activeBadges()[0])) {
      if (Flags.getFlag(store, null, b.flag)) {
        n = n + 1;
      }
    }
    return n;
  },

  /** Get badges bitmask (bit 0 = badge 1, ..., bit 7 = badge 8) */
  // Lua: flags.lua:245
  getBadgesMask(store: any): number {
    let mask = 0;
    for (const [, b] of ipairs<BadgeInfo>(activeBadges()[0])) {
      if (Flags.getFlag(store, null, b.flag)) {
        const bitVal = 1 << (b.num - 1);
        mask = mask + bitVal;
      }
    }
    return mask;
  },

  /** Set badges from bitmask */
  // Lua: flags.lua:257
  setBadgesMask(store: any, maskIn: any): void {
    const mask = tonumber(maskIn) ?? 0;
    for (const [, b] of ipairs<BadgeInfo>(activeBadges()[0])) {
      const bitVal = 1 << (b.num - 1);
      const has = (mask & bitVal) !== 0;
      Flags.setFlag(store, null, b.flag, has);
    }
  },

  // Lua: flags.lua:266
  nameFor(flagIdIn: any): string {
    const flagId = tonumber(flagIdIn) ?? 0;
    return Flags.NAMES[flagId] ?? format("FLAG_0x%03X", flagId);
  },

  // Lua: flags.lua:271
  varNameFor(varIdIn: any): string {
    const varId = tonumber(varIdIn) ?? 0;
    return Flags.VAR_NAMES[varId] ?? format("VAR_0x%04X", varId);
  },

  // Lua: flags.lua:276
  applyNewGameHideFlags(store: any): void {
    if (!store) return;
    store.flags = store.flags ?? {};
    for (const [, id] of ipairs<number>(Flags.NEW_GAME_HIDE_FLAGS)) {
      store.flags[id] = true;
    }
    store.vars = store.vars ?? {};
    for (const [, sv] of ipairs<any>(Flags.NEW_GAME_RESET_VARS)) {
      store.vars[sv.id] = sv.value;
    }
  },

  /**
   * Sessions started before hide-flag seeding: hide town Oak until the
   * leave-town scene has run (VAR_MAP_SCENE_PALLET_TOWN_OAK ~= 0).
   * Do not force-hide lab Oak (43) -- clearflag during the lead warp must stick.
   */
  // Lua: flags.lua:291
  ensurePalletOakHidden(store: any): void {
    if (!store) return;
    if (Profile.family() !== "frlg") return;
    const sceneVar = Flags.VAR_IDS.MAP_SCENE_PALLET_TOWN_OAK ?? 0x4050;
    const scene = Flags.getVar(store, null, sceneVar);
    if (scene !== 0) return;
    const hidePalletOak = Flags.IDS.HIDE_OAK_IN_PALLET_TOWN ?? 0x02C;
    if (!Flags.getFlag(store, null, hidePalletOak)) {
      Flags.setFlag(store, null, hidePalletOak, true);
    }
  },

  /** Repair/normalize legacy saves that missed initial hide flags. */
  // Lua: flags.lua:304
  repairSaveState(store: any): void {
    if (!store) return;
    Flags.ensurePalletOakHidden(store);

    // Bill human in sea cottage: if helped flag (0x233) is false, human is hidden (0x033)
    if (!Flags.getFlag(store, null, 0x233)) {
      Flags.setFlag(store, null, 0x033, true);
    }

    // Running shoes guy in Pewter: if badge 1 (0x820) is false, guy is hidden (0x092)
    if (!Flags.getFlag(store, null, 0x820)) {
      Flags.setFlag(store, null, 0x092, true);
    }

    // Fuji in Lavender house: if rescued (0x23C) is false, Fuji in house is hidden (0x035)
    if (!Flags.getFlag(store, null, 0x23C)) {
      Flags.setFlag(store, null, 0x035, true);
    }

    // Oak in champ room: if champion defeated (0x4BC) is false, oak in champ room is hidden (0x05A)
    if (!Flags.getFlag(store, null, 0x4BC)) {
      Flags.setFlag(store, null, 0x05A, true);
    }
  },

  // Lua: flags.lua:335
  newStore(_seed?: any): FlagStore {
    const store: FlagStore = {
      flags: {},
      vars: {},
    };
    // First Sevii boot: Bill street intro onFrame wants MAP_SCENE == 2.
    // Extracted scripts advance this (e.g. to 3 after door warp).
    const game = Profile.resolveId(undefined);
    const seviiScene = Flags.forVersion(game).VAR_IDS.MAP_SCENE_ONE_ISLAND_HARBOR;
    if (seviiScene != null) store.vars[seviiScene] = 2;
    return store;
  },

  // Lua: flags.lua:348
  loadInto(store: any, saved: any): any {
    if (!saved) return store;
    for (const [k, v] of pairs(saved.flags ?? {})) {
      store.flags[tonumber(k) ?? k] = truthy(v) ? true : false;
    }
    for (const [k, v] of pairs(saved.vars ?? {})) {
      const id = tonumber(k) ?? k;
      if (!Ctx.isSpecial(id)) {
        store.vars[id] = tonumber(v) ?? 0;
      }
    }
    repairForGame(store);
    return store;
  },

  /** Snapshot for Sevii sidecar -- excludes special vars. */
  // Lua: flags.lua:364
  serialize(store: any): { flags: Record<string, boolean>; vars: Record<string, number> } {
    const flags: Record<string, boolean> = {}, vars: Record<string, number> = {};
    for (const [id, v] of pairs(store.flags ?? {})) {
      if (truthy(v)) flags[tostring(id)] = true;
    }
    for (const [id, v] of pairs(store.vars ?? {})) {
      if (!Ctx.isSpecial(id)) {
        vars[tostring(id)] = tonumber(v) ?? 0;
      }
    }
    return { flags, vars };
  },

  // Lua: flags.lua:377
  getFlag(store: any, _ctx: any, idIn: any): boolean {
    const id = idOf(idIn, Flags.IDS);
    if (!store || !store.flags) return false;
    if (store.flags[id] === true || store.flags[tostring(id)] === true) {
      return true;
    }
    if (id > 0) {
      const hexKey = format("0x%X", id);
      if (store.flags[hexKey] === true) return true;
      const name = Flags.NAMES[id];
      if (name != null && store.flags[name] === true) return true;
    }
    return false;
  },

  // Lua: flags.lua:392
  setFlag(store: any, ctx: any, idIn: any, on?: any): void {
    const id = idOf(idIn, Flags.IDS);
    if (!store || !store.flags) return;
    const announce = ModRuntime.wants("flag.changed")
      && Flags.getFlag(store, ctx, id) !== (truthy(on) ? true : false);
    const strId = tostring(id);
    if (truthy(on)) {
      store.flags[id] = true;
      store.flags[strId] = true;
    } else {
      delete store.flags[id];
      delete store.flags[strId];
      if (id > 0) {
        const hexKey = format("0x%X", id);
        delete store.flags[hexKey];
        const name = Flags.NAMES[id];
        if (name != null) delete store.flags[name];
      }
    }
    if (announce) {
      ModRuntime.emit("flag.changed", { name: Flags.NAMES[id] ?? id, id, value: truthy(on) ? true : false });
    }
  },

  // Lua: flags.lua:416
  getVar(store: any, ctx: any, idIn: any): number {
    const id = idOf(idIn, Flags.VAR_IDS);
    if (Ctx.isSpecial(id)) {
      if (!(ctx && ctx.specialVars)) return 0;
      return ctx.specialVars[id] ?? 0;
    }
    // src/event_data.c:235-241
    if (id < 0x4000) return id;
    if (!(store && store.vars)) return 0;
    return store.vars[id] ?? 0;
  },

  // Lua: flags.lua:428
  setVar(store: any, ctx: any, idIn: any, valueIn: any): void {
    const id = idOf(idIn, Flags.VAR_IDS);
    const value = tonumber(valueIn) ?? 0;
    if (Ctx.isSpecial(id)) {
      if (!(ctx && ctx.specialVars)) return;
      ctx.specialVars[id] = mod(value, 65536);
    } else {
      if (!(store && store.vars)) return;
      store.vars[id] = mod(value, 65536);
    }
  },

  // Lua: flags.lua:440
  onMapLoad(store: any): void {
    if (store && store.vars) {
      Ctx.clearTemps(store.vars);
    }
    // pret: Temp flags 0x01..0x1F are cleared on map load
    if (store && store.flags) {
      for (let fid = 0x01; fid <= 0x1F; fid++) {
        Flags.setFlag(store, null, fid, false);
      }
    }
    repairForGame(store);
  },
};

export default Flags;
