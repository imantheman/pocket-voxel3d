// Port of gen1recomp src/core/game3/scripting/trainers.lua (GPLv3 + additional terms; see LICENSE.md).
// Trainer party lookup + ROM-derived class/name/pic/party/dialog info for battles and overworld.
//
// Port notes:
// - pcall(require, X), lazy require and package.loaded[X] are static imports
//   (every module is in the bundle), with Brian's guards kept.
// - Cache chunks go through luaLoad (lt.ts shape: `trainers` keyed by
//   trainer id, `party` / `items` / `moves` sequences).
// - Strings are byte strings: GBA_CHAR's UTF-8 keys are written as bytes.
// - getBattleMusicRole / getVictoryMusicRole return [role, song] tuples.
// - live_dialogs' setmetatable({}, { __index = d }) is Object.create(d)
//   (reads fall through to d; own keys only for pairs, as in Lua).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { byte, mod, tonumber, tostring, truthy } from "../../../../import/gen3/lua.ts";
import { seq, len, ipairs, pairs, isEmpty, type LuaTable } from "../../platform/lt.ts";
import { gmatch } from "../../platform/lpattern.ts";
import { luaLoad } from "../../platform/luadata.ts";
import { Dataset } from "../dataset.ts";
import { CacheFs } from "../../shared/import/CacheFs.ts";
import { Pokemon } from "../pokemon.ts";
import { Space } from "./space.ts";
import { BattleText } from "../battle/battle_text.ts";
import { TrainerSight } from "../trainer_sight.ts";

// pokefirered/include/constants/trainers.h:264, :272, :273
const TRAINER_CLASS_RIVAL_EARLY = 81;
const TRAINER_CLASS_RIVAL_LATE = 89;
const TRAINER_CLASS_CHAMPION = 90;

// Lua: trainers.lua:12
function load_pack(): any {
  if (truthy(Trainers._pack)) return Trainers._pack;
  // pcall(require, "src.core.game3.dataset") always succeeds here.
  const cache: any = Dataset && Dataset.cache && Dataset.cache();
  let src: string | undefined;
  if (cache && cache.read) {
    src = cache.read("data/generated/gba/trainers.lua");
  }
  if (src == null) {
    // pcall(require, "src.import.CacheFs") always succeeds here.
    if (CacheFs && CacheFs.readActive) {
      src = CacheFs.readActive("data/generated/gba/trainers.lua");
    }
  }
  if (typeof src === "string" && src.length > 0) {
    const [chunk] = luaLoad(src, "@trainers.lua");
    if (chunk) {
      let ok: boolean, pack: any;
      try {
        pack = chunk();
        ok = true;
      } catch {
        ok = false;
      }
      if (ok && pack != null && typeof pack === "object") {
        Trainers.mergeDialogs(pack, cache);
        Trainers._pack = pack;
        return pack;
      }
    }
  }
  Trainers._pack = false;
  return undefined;
}

const DIALOG_KEYS = seq("scriptKey", "introTextKey", "defeatTextKey", "victoryTextKey", "notEnoughTextKey");

// Lua: trainers.lua:67
function decompose_ai_flags(flagsIn: unknown) {
  const flags = tonumber(flagsIn) ?? 0;
  return {
    checkBadMove: (mod(flags, 2) === 1),
    checkViability: (mod(Math.floor(flags / 2), 2) === 1),
    tryToFaint: (mod(Math.floor(flags / 4), 2) === 1),
    setupFirstTurn: (mod(Math.floor(flags / 8), 2) === 1),
    risky: (mod(Math.floor(flags / 16), 2) === 1),
    preferStrongestMove: (mod(Math.floor(flags / 32), 2) === 1),
    preferBatonPass: (mod(Math.floor(flags / 64), 2) === 1),
    doubleBattle: (mod(Math.floor(flags / 128), 2) === 1),
    hpAware: (mod(Math.floor(flags / 256), 2) === 1),
    roaming: (mod(Math.floor(flags / 0x20000000), 2) === 1),
    safari: (mod(Math.floor(flags / 0x40000000), 2) === 1),
    firstBattle: (flags >= 0x80000000),
  };
}

// Lua: trainers.lua:128
const GBA_CHAR: Record<string, number> = {
  " ": 0x00, "\xC3\xA9": 0x1B, "&": 0x2D, "+": 0x2E, "!": 0xAB, "?": 0xAC,
  ".": 0xAD, "-": 0xAE, "\xE2\x80\xA6": 0xB0, "\xE2\x80\x9C": 0xB1, "\xE2\x80\x9D": 0xB2, "\xE2\x80\x98": 0xB3,
  "\xE2\x80\x99": 0xB4, "'": 0xB4, "\xE2\x99\x82": 0xB5, "\xE2\x99\x80": 0xB6, ",": 0xB8, "/": 0xBA,
};

// Lua: trainers.lua:134
function gba_char_sum(text: unknown): number {
  let sum = 0;
  for (const [ch] of gmatch(tostring(text ?? ""), "[%z\x01-\x7F\xC2-\xF4][\x80-\xBF]*")) {
    const c = ch as string;
    const b = byte(c)!;
    let v = GBA_CHAR[c];
    if (v == null) {
      if (c.length === 1 && b >= 48 && b <= 57) v = 0xA1 + (b - 48);
      else if (c.length === 1 && b >= 65 && b <= 90) v = 0xBB + (b - 65);
      else if (c.length === 1 && b >= 97 && b <= 122) v = 0xD5 + (b - 97);
      else v = 0;
    }
    sum = sum + v;
  }
  return sum;
}

// Lua: trainers.lua:151
// pokefirered/src/battle_main.c:1555
function double_personalities(t: any): LuaTable {
  let nameHash = 0;
  const out: LuaTable = [null];
  for (const [i, m] of ipairs<any>(t.party ?? [null])) {
    nameHash = mod(nameHash + gba_char_sum(t.name), 0x100000000);
    nameHash = mod(nameHash + gba_char_sum(Pokemon.name(tonumber(m.species) ?? 0)), 0x100000000);
    out[i] = mod(0x80 + mod(nameHash * 256, 0x100000000), 0x100000000);
  }
  return out;
}

const DIALOG_TEXT_KEYS: Record<string, string> = {
  intro: "introTextKey", defeat: "defeatTextKey",
  victory: "victoryTextKey", notEnough: "notEnoughTextKey",
};

// Lua: trainers.lua:230
function live_dialogs(t: any): any {
  const d = t.dialogs ?? {};
  // package.loaded["src.core.game3.scripting.space"]: the module is loaded.
  const Sp = Space;
  const vm = Sp && Sp.vm;
  if (!(vm && vm.getText)) return d;
  let out: any;
  for (const [field, keyName] of pairs<string>(DIALOG_TEXT_KEYS)) {
    const key = t[keyName];
    const ir = truthy(key) ? vm.getText(key) : undefined;
    if (ir != null && typeof ir === "object") {
      out = out ?? Object.create(d);
      out[field] = ir;
    }
  }
  return out ?? d;
}

export interface TrainerDef {
  id: number;
  class: number;
  className: string;
  pic: number;
  name: string;
  gender: number;
  encounterMusic: number;
  doubleBattle: boolean;
  partySize: number;
  partyFlags: number;
  lastLevel: number;
  aiFlags: number;
  ai: ReturnType<typeof decompose_ai_flags>;
  items: LuaTable;
  party: LuaTable;
  dialogs: any;
  scriptKey: any;
  introTextKey: any;
  defeatTextKey: any;
  victoryTextKey: any;
  notEnoughTextKey: any;
}

export const Trainers = {
  _pack: undefined as any,

  DIALOGS_REL: "data/generated/gba/trainers/dialogs.lua",

  // Lua: trainers.lua:45
  mergeDialogs(pack: any, cache: any): number {
    if (pack == null || typeof pack !== "object" || pack.trainers == null || typeof pack.trainers !== "object") return 0;
    const src = cache && cache.read && cache.read(Trainers.DIALOGS_REL);
    if (typeof src !== "string" || src === "") return 0;
    const [chunk] = luaLoad(src, "@" + Trainers.DIALOGS_REL);
    let ok = false, rows: any = undefined;
    if (chunk) {
      try {
        rows = chunk();
        ok = true;
      } catch (e) {
        ok = false;
        rows = e;
      }
    }
    if (!ok || rows == null || typeof rows !== "object") return 0;
    let n = 0;
    for (const [id, d] of pairs<any>(rows)) {
      const row = pack.trainers[id];
      if (row != null && typeof row === "object" && d != null && typeof d === "object" && isEmpty(row.dialogs ?? {})) {
        row.dialogs = d.dialogs ?? {};
        for (const [, k] of ipairs<string>(DIALOG_KEYS)) {
          if (row[k] == null) row[k] = d[k];
        }
        n = n + 1;
      }
    }
    return n;
  },

  // Lua: trainers.lua:85
  pack(): any {
    return load_pack() || undefined;
  },

  // Lua: trainers.lua:90
  /** Get full trainer definition record by trainerId. */
  get(trainerIdIn: unknown): TrainerDef | undefined {
    const trainerId = tonumber(trainerIdIn);
    if (trainerId == null) return undefined;

    const pack = load_pack();
    const row = pack && pack.trainers && pack.trainers[trainerId];
    if (row) {
      const classNames = pack && pack.classNames;
      const klass = tonumber(row.class) ?? 0;
      const dlgs = row.dialogs ?? {};
      return {
        id: trainerId,
        class: klass,
        className: row.className ?? (classNames && classNames[klass]) ?? "",
        pic: tonumber(row.pic) ?? 0,
        name: row.name ?? "",
        gender: tonumber(row.gender) ?? 0,
        encounterMusic: tonumber(row.encounterMusic) ?? 0,
        doubleBattle: truthy(row.doubleBattle) ? true : false,
        partySize: tonumber(row.partySize) ?? (row.party != null && row.party !== false ? len(row.party) : undefined) ?? 0,
        partyFlags: tonumber(row.partyFlags) ?? 0,
        lastLevel: tonumber(row.lastLevel) ?? 1,
        aiFlags: tonumber(row.aiFlags) ?? 0,
        ai: decompose_ai_flags(row.aiFlags),
        items: row.items ?? seq(0, 0, 0, 0),
        party: row.party ?? [null],
        dialogs: dlgs,
        scriptKey: row.scriptKey,
        introTextKey: row.introTextKey,
        defeatTextKey: row.defeatTextKey,
        victoryTextKey: row.victoryTextKey,
        notEnoughTextKey: row.notEnoughTextKey,
      };
    }

    return undefined;
  },

  _doublePersonalities: double_personalities,

  // Lua: trainers.lua:169
  /**
   * Resolve a foe battler struct + full party for battle runtime.
   * Guarantees:
   * 1. Uniform Flat IV scaling: actualIv = (rawIv * 31) / 255 across all 6 stats
   * 2. Explicit Zero EVs across all stats (no residual player data)
   * 3. Correct custom moves and held items
   */
  foeFromId(trainerIdIn: unknown): any {
    const trainerId = tonumber(trainerIdIn);
    if (trainerId == null) return undefined;

    const t = Trainers.get(trainerId);
    if (!t || !t.party || len(t.party) === 0) {
      return undefined;
    }

    const foeParty: LuaTable = [null];
    const pers: LuaTable = t.doubleBattle ? double_personalities(t) : {};
    for (const [pi, m] of ipairs<any>(t.party)) {
      const rawIv = tonumber(m.rawIv) ?? tonumber(m.iv) ?? 0;
      const iv = tonumber(m.iv) ?? Math.floor((rawIv * 31) / 255);
      const mon = {
        species: tonumber(m.species) ?? 1,
        level: tonumber(m.level) ?? 5,
        rawIv,
        iv,
        ivs: { hp: iv, atk: iv, def: iv, spa: iv, spd: iv, spe: iv },
        // Trainer EVs are strictly zero
        evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
        heldItem: tonumber(m.heldItem) ?? undefined,
        moves: m.moves,
        trainerId,
        personality: pers[pi],
      };
      foeParty[len(foeParty) + 1] = mon;
    }

    const lead = foeParty[1];
    return {
      species: lead.species,
      level: lead.level,
      rawIv: lead.rawIv,
      iv: lead.iv,
      ivs: lead.ivs,
      evs: lead.evs,
      heldItem: lead.heldItem,
      moves: lead.moves,
      personality: lead.personality,
      trainerId,
      aiFlags: t.aiFlags,
      ai: t.ai,
      items: t.items,
      party: foeParty,
      trainerName: t.name,
      trainerClass: t.class,
      trainerClassName: t.className,
      trainerPic: t.pic,
      gender: t.gender,
      encounterMusic: t.encounterMusic,
      doubleBattle: t.doubleBattle,
    };
  },

  // Lua: trainers.lua:250
  /**
   * ROM-derived trainer presentation info (class / name / pic / partySize / dialogs).
   * opts.rivalName replaces the placeholder "TERRY" of the rival and champion
   * classes when provided.
   */
  info(trainerIdIn: unknown, optsIn?: any): any {
    const opts = optsIn ?? {};
    const trainerId = tonumber(trainerIdIn);
    if (trainerId == null) return undefined;

    const t = Trainers.get(trainerId);
    if (!t) return undefined;

    const info = {
      class: t.class,
      className: t.className,
      name: t.name,
      pic: t.pic,
      gender: t.gender,
      encounterMusic: t.encounterMusic,
      doubleBattle: t.doubleBattle,
      partySize: t.partySize ?? len(t.party),
      lastLevel: t.lastLevel,
      aiFlags: t.aiFlags,
      ai: t.ai,
      items: t.items,
      party: t.party,
      dialogs: live_dialogs(t),
    };

    // pokefirered/src/battle_message.c:2078 names these classes by the player's
    // rival, recognised by class id: a mod may rename the class itself.
    const klass = tonumber(info.class);
    if ((klass === TRAINER_CLASS_RIVAL_EARLY || klass === TRAINER_CLASS_RIVAL_LATE
        || klass === TRAINER_CLASS_CHAMPION) && truthy(opts.rivalName) && opts.rivalName !== "") {
      info.name = opts.rivalName;
    }
    return info;
  },

  // Lua: trainers.lua:286
  /** Get dialog texts table: { intro, defeat, victory, notEnough } */
  dialogs(trainerId: unknown): any {
    const t = Trainers.get(trainerId);
    return (t && live_dialogs(t)) || {};
  },

  // Lua: trainers.lua:293
  /**
   * FRLG intro string pieces for a trainer battle.
   * pokefirered/src/battle_message.c:1569, :1622
   */
  introStrings(trainerId: unknown, monName: unknown, opts?: any): { wants: any; sentOut: any; info: any } {
    const info = Trainers.info(trainerId, opts);
    // include/constants/opponents.h:4
    let shown = info;
    if (!shown) {
      shown = Trainers.info(0, opts);
      if (!truthy(shown)) throw new Error("no trainer 0");
    }
    const fill = {
      trainer: true,
      trainer1Class: shown.className ?? tonumber(shown.class),
      trainer1Name: shown.name,
      opponentMon1: monName,
    };
    return {
      wants: BattleText.get("sText_Trainer1WantsToBattle", fill),
      sentOut: BattleText.get("sText_Trainer1SentOutPkmn", fill),
      info: info ?? {},
    };
  },

  // Lua: trainers.lua:312
  /** Resolve encounter BGM song ID for a trainer (pret PlayTrainerEncounterMusic / include/constants/trainers.h & songs.h). */
  getEncounterMusic(trainerId: unknown): number {
    const perGame = TrainerSight.encounterMusic(trainerId);
    if (truthy(perGame)) return perGame;
    const t = Trainers.get(trainerId);
    if (!t) return 285; // MUS_ENCOUNTER_BOY
    const musicCode = mod(tonumber(t.encounterMusic) ?? 0, 128);
    // TRAINER_ENCOUNTER_MUSIC_FEMALE (1), GIRL (2), TWINS (9) -> MUS_ENCOUNTER_GIRL (284)
    // TRAINER_ENCOUNTER_MUSIC_MALE (0), INTENSE (4), COOL (5), SWIMMER (8), ELITE_FOUR (10), HIKER (11), INTERVIEWER (12), RICH (13) -> MUS_ENCOUNTER_BOY (285)
    // Default (SUSPICIOUS 3, AQUA 6, MAGMA 7, etc.) -> MUS_ENCOUNTER_ROCKET (283)
    if (musicCode === 1 || musicCode === 2 || musicCode === 9) {
      return 284; // MUS_ENCOUNTER_GIRL
    } else if (musicCode === 3 || musicCode === 6 || musicCode === 7) {
      return 283; // MUS_ENCOUNTER_ROCKET
    } else {
      return 285; // MUS_ENCOUNTER_BOY
    }
  },

  // Lua: trainers.lua:331
  // pokefirered/src/pokemon.c:5850
  getBattleMusicRole(trainerId: unknown): [string, number] {
    const t = Trainers.get(trainerId);
    const klass = t && tonumber(t.class);
    if (klass === 90) {
      return ["battleChampion", 299];
    } else if (klass === 84 || klass === 87) {
      return ["battleGymLeader", 296];
    }
    return ["battleTrainer", 297];
  },

  // Lua: trainers.lua:343
  // pokefirered/src/battle_main.c:3746
  getVictoryMusicRole(trainerId: unknown): [string, number] {
    const t = Trainers.get(trainerId);
    const klass = t && tonumber(t.class);
    if (klass === 84 || klass === 90) {
      return ["victoryGymLeader", 312];
    }
    return ["victoryTrainer", 310];
  },
};

export default Trainers;
