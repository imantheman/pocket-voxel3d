// Port of gen1recomp src/core/game3/save_schema_firered.lua (GPLv3 + additional terms; see LICENSE.md).
// Native Fire Red save schema (engine SaveData JSON). No GBA Flash dumps.
//
// The session and save tables are Lua tables in the lt.ts shape (sequences
// are `[null, a, b, ...]`); SaveData's serializer turns them into the same
// bytes gen1recomp writes. Fields the Lua leaves nil are `undefined` here.

import { ipairs, len, pairs, remove, concat, seq, type LuaTable } from "../platform/lt.ts";
import { mod, tonumber, tostring, truthy } from "../../../import/gen3/lua.ts";
import { MapIds } from "./map_ids.ts";
import { Options } from "./options.ts";
import { Profile } from "./profile.ts";
import ModRuntime from "../shared/mods/Runtime.ts";
import { Ctx } from "./scripting/ctx.ts";
import { Chat } from "./link/chat.ts";
import { Mail } from "./mail.ts";
import { Bag } from "./bag.ts";
import { Rng } from "./rng.ts";
import { Storage } from "./storage.ts";
import { SaveSections } from "./save_sections.ts";
import QuestLog from "./quest_log.ts";
import { ItemsData } from "./items_data.ts";
import { save_mon as SaveMon } from "./save_mon.ts";
import { Pokemon } from "./pokemon.ts";
import { Player } from "./player.ts";
import { FireredRules } from "./profiles/firered_rules.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Session = Record<string, any>;
type Rules = typeof FireredRules;

/** `require(row.saveRules)`: the rules modules the 3DS build carries. */
// (looked up lazily: firered_rules -> field -> this module is an import cycle)
const RULES_MODULES: Record<string, (() => Rules) | undefined> = {
  "src.core.game3.profiles.firered_rules": () => FireredRules,
};

// Lua: save_schema_firered.lua:12
function empty_string_vars(): LuaTable {
  return seq("", "", "");
}

// Lua: save_schema_firered.lua:16
function empty_special_vars(version?: string): Record<number, number> {
  const t: Record<number, number> = {};
  for (let i = Ctx.SPECIAL_LO as number; i <= (Ctx.specialLayout(version).hi as number); i++) {
    t[i] = 0;
  }
  return t;
}

// Lua: save_schema_firered.lua:34
function rules_of(session: any): Rules {
  return Schema.rulesFor(session != null && typeof session === "object" ? session.version : undefined);
}

// Lua: save_schema_firered.lua:38
function copy_list(t: any): LuaTable | undefined {
  if (t == null || typeof t !== "object") return undefined;
  const out: LuaTable = [null];
  for (const [i, v] of ipairs(t)) out[i] = v;
  return out;
}

// Lua: save_schema_firered.lua:45
// (pcall(require, "src.core.game3.mail"): the module is always present here)
function mail_module(): any {
  if (Mail != null && typeof Mail === "object") return Mail;
  return undefined;
}

// Lua: save_schema_firered.lua:51
function mail_export(session: Session): any {
  const M = mail_module();
  if (M && typeof M.export === "function") return M.export(session);
  return session.mail;
}

// Lua: save_schema_firered.lua:57
function mail_restore(save: Session): any {
  const M = mail_module();
  if (M && typeof M.restore === "function") return M.restore(save.mail);
  return save.mail;
}

// Lua: save_schema_firered.lua:67
function is_own_mon(session: Session, mon: Record<string, any>): boolean {
  const otName = mon.otName ?? mon.ot ?? mon.originalTrainer;
  const name = session.name ?? session.playerName;
  if (typeof otName === "string" && typeof name === "string" && otName !== name) return false;
  const otId = tonumber(mon.otId), tid = tonumber(session.trainerId);
  if (otId != null && tid != null && mod(otId, 0x10000) !== mod(tid, 0x10000)) return false;
  return true;
}

// Lua: save_schema_firered.lua:77
// pokefirered/src/pokemon.c:1796 CreateBoxMon OT_ID_PLAYER_ID
function repair_own_mon(session: Session, mon: any): void {
  if (mon == null || typeof mon !== "object") return;
  if (!is_own_mon(session, mon)) return;
  const stamped = mon.metLocationName;
  const met = rules_of(session).OWN_MON_MET_LOCATION;
  if (truthy(met) && mon.metLocation == null && !(typeof stamped === "string" && stamped !== "")) {
    mon.metLocation = met;
  }
  const secret = tonumber(session.secretId);
  if (secret != null && tonumber(mon.otSecretId) !== secret) {
    mon.otSecretId = secret;
  }
}

// Lua: save_schema_firered.lua:104
// pokefirered/src/union_room_chat.c:1430
function registered_texts_restore(v: any): LuaTable | undefined {
  if (v == null || typeof v !== "object") return undefined;
  const out: LuaTable = [null];
  for (let i = 1; i <= (Chat.KB_ROWS as number); i++) {
    const s = v[i];
    if (s != null && typeof s !== "string") return undefined;
    const tokens = Chat.tokens(s ?? "");
    while (len(tokens) > (Chat.REGISTER_CHARS as number)) remove(tokens);
    out[i] = concat(tokens);
  }
  return out;
}

// Lua: save_schema_firered.lua:119
// pokefirered/src/link_rfu_3.c:1178
function trainer_name_records_restore(v: any): LuaTable | undefined {
  if (v == null || typeof v !== "object") return undefined;
  const out: LuaTable = [null];
  for (const [, r] of ipairs<any>(v)) {
    if (len(out) >= 20) break;
    if (r != null && typeof r === "object" && typeof r.name === "string") {
      out[len(out) + 1] = { name: Chat.cleanName(r.name), trainerId: mod(Math.floor(tonumber(r.trainerId) ?? 0), 65536) };
    }
  }
  return out;
}

// Lua: save_schema_firered.lua:133
// pokeemerald/include/global.h:206
function pokedex_view(v: any): { mode: number; order: number } | undefined {
  if (v == null || typeof v !== "object") return undefined;
  let mode = Math.floor(tonumber(v.mode) ?? 0), order = Math.floor(tonumber(v.order) ?? 0);
  if (mode < 0 || mode > 1) mode = 0;
  if (order < 0 || order > 5) order = 0;
  return { mode, order };
}

/** The tail of Lua's `x and f(x) or nil`: a false result reads as nil. */
function orNil(v: any): any {
  return truthy(v) ? v : undefined;
}

/** Lua's `type(v) == "table" and v or nil`. */
function tableOr<T>(v: any, dflt: T): any {
  return v != null && typeof v === "object" ? v : dflt;
}

export const Schema = {
  VERSION: 1,

  // Lua: save_schema_firered.lua:25
  rulesFor(version?: string): Rules {
    const row = Profile.of(version);
    const path = row.saveRules;
    if (typeof path !== "string") {
      throw new Error("game3 profile '" + tostring(row.id) + "' has no saveRules module");
    }
    const rules = RULES_MODULES[path];
    // NOT FAITHFUL: Emerald only -- no rules module but FireRed's is carried.
    if (!rules) throw new Error("module '" + path + "' not found (Emerald only)");
    return rules();
  },

  // Lua: save_schema_firered.lua:63
  useContinueGameWarp(session: Session): void {
    return rules_of(session).useContinueGameWarp(session, true);
  },

  // Lua: save_schema_firered.lua:91
  repairOwnMons(session: Session): void {
    for (const [, mon] of ipairs(session.party ?? [null])) {
      repair_own_mon(session, mon);
    }
    const storage = session.storage;
    for (const [, box] of pairs<any>(storage && storage.boxes || {})) {
      for (const [, mon] of pairs(tableOr(box, undefined) ? box.mons ?? {} : {})) {
        repair_own_mon(session, mon);
      }
    }
  },

  /** Factory for a pristine New Game after Oak intro finishes. */
  // Lua: save_schema_firered.lua:142
  newGame(opts?: Record<string, any> | null): Session {
    const o: Record<string, any> = opts ?? {};
    const version: string = o.version ?? Profile.active().id;
    const rules = Schema.rulesFor(version);
    const start = o.start ?? MapIds.newGameStart(version);
    let session: Session = {
      schemaVersion: Schema.VERSION,
      engine: "game3",
      version,
      generation: 3,
      party: seq(),
      bag: Bag.new(),
      dex: { seen: {}, owned: {}, caught: {}, national: false },
      money: tonumber(o.money) ?? rules.newGameMoney(),
      coins: 0,
      // include/global.h:354, src/berry_powder.c:50
      berryPowder: 0,
      name: o.name ?? rules.DEFAULT_NAME,
      rivalName: o.rivalName ?? rules.DEFAULT_RIVAL,
      gender: o.gender ?? 0, // 0 boy / 1 girl
      map: start.map,
      x: start.x,
      y: start.y,
      facing: start.facing ?? "down",
      healMap: start.healMap ?? start.map,
      healX: start.healX ?? start.x,
      healY: start.healY ?? start.y,
      stringVars: empty_string_vars(),
      specialVars: empty_special_vars(version),
      flags: rules.newGameFlags(),
      vars: {},
      playtime: { hours: 0, minutes: 0, seconds: 0 },
      easyChatProfile: copy_list(rules.EASY_CHAT_PROFILE),
      options: undefined,
      registeredItem: undefined,
      monBoxId: undefined,
      monBoxPos: undefined,
      // pokefirered/include/global.h:764
      dynamicWarp: undefined,
      escapeWarp: undefined,
      // pokefirered/include/global.h:770
      flashLevel: 0,
      move_overlay: {},
      trainerId: undefined,
      secretId: undefined,
      rng: undefined,
      vsSeeker: rules.newVsSeeker(),
      roamer: undefined,
    };
    // pret new_game.c: SeedWildEncounterRng(Random()) after title SeedRngAndSetTrainerId.
    if (o.trainerIdLower != null) {
      // pokeemerald/src/new_game.c:84
      session.trainerId = mod(Math.floor(tonumber(o.trainerIdLower) ?? 0), 65536);
    } else {
      session.trainerId = Rng.seedNewGame({ seed: o.rngSeed });
    }
    // pokefirered/src/new_game.c:56 InitPlayerTrainerId
    session.secretId = Rng.Random();
    session.id = session.trainerId;
    session.playerId = session.trainerId;
    Rng.captureToSession(session);
    session.storage = Storage.new();
    rules.newGamePcItems(session.storage);
    rules.newGameInit(session, o);
    SaveSections.newGame(session, version);
    Options.ensure(session);
    // Plan naming: text_speed / l_equals_a aliases mirror Options fields.
    session.options.text_speed = session.options.textSpeed;
    session.options.l_equals_a = (session.options.buttonMode === 2);
    if (o.engineOptions != null && typeof o.engineOptions === "object") {
      Options.bind(session, o.engineOptions);
    }
    session.modData = {};
    if (truthy(ModRuntime.wantsHook("save.new_game"))) {
      const hooked = ModRuntime.call("save.new_game", (s: Session) => s, session);
      if (hooked != null && typeof hooked === "object") session = hooked;
    }
    return session;
  },

  // Lua: save_schema_firered.lua:225
  toSaveTable(session: any): Session | undefined {
    if (session == null || typeof session !== "object") return undefined;
    Options.ensure(session);
    Rng.captureToSession(session);
    const [warpFlags, continueWarp] = rules_of(session).saveWarpFields(session);
    const engineOptions = Options.engine(session);
    const out: Session = {
      schemaVersion: session.schemaVersion ?? Schema.VERSION,
      engine: "game3",
      version: session.version ?? Profile.active().id,
      generation: session.generation ?? 3,
      name: session.name,
      rivalName: session.rivalName,
      gender: session.gender,
      money: session.money,
      coins: session.coins,
      // include/global.h:354, src/berry_powder.c:50
      berryPowder: session.berryPowder ?? 0,
      berryCrushPressingSpeeds: session.berryCrushPressingSpeeds,
      pokemonJumpRecords: session.pokemonJumpRecords,
      dodrioBerryPickingRecords: session.dodrioBerryPickingRecords,
      // pokefirered/src/union_room_chat.c:1182
      registeredTexts: session.registeredTexts,
      // pokefirered/src/link_rfu_3.c:1122
      trainerNameRecords: session.trainerNameRecords,
      party: session.party,
      bag: session.bag,
      inventory: session.bag, // SaveData compatibility alias
      dex: session.dex,
      pokedex: pokedex_view(session.pokedex),
      map: session.map,
      x: session.x,
      y: session.y,
      facing: session.facing,
      // package.loaded["src.core.game3.player"]: the module is always loaded here
      biking: (Player != null && Player.biking != null && Player.biking === true)
        || (session != null && session.biking === true)
        || false,
      bikeType: session.bikeType,
      healMap: session.healMap,
      healX: session.healX,
      healY: session.healY,
      stringVars: session.stringVars ?? empty_string_vars(),
      specialVars: session.specialVars ?? empty_special_vars(session.version),
      flags: session.flags ?? {},
      vars: session.vars ?? {},
      playTime: session.playtime ?? session.playTime ?? { hours: 0, minutes: 0, seconds: 0 },
      easyChatProfile: session.easyChatProfile,
      options: truthy(engineOptions) ? engineOptions : session.options,
      storage: truthy(session.storage) ? orNil(Storage.serialize(session.storage)) : undefined,
      registeredItem: session.registeredItem,
      monBoxId: session.monBoxId,
      monBoxPos: session.monBoxPos,
      // pokefirered/include/global.h:764
      dynamicWarp: session.dynamicWarp,
      escapeWarp: session.escapeWarp,
      continueGameWarp: continueWarp,
      specialSaveWarpFlags: warpFlags,
      // pokefirered/include/global.h:348
      gcnLinkFlags: tonumber(session.gcnLinkFlags) ?? 0,
      // pokefirered/include/global.h:770
      flashLevel: tonumber(session.flashLevel),
      move_overlay: session.move_overlay ?? {},
      trainerId: session.trainerId,
      // (the Lua constructor lists secretId twice)
      secretId: session.secretId,
      rng: session.rng,
      vsSeeker: session.vsSeeker,
      roamer: session.roamer,
      // GAME_STAT_* counters: slot-machine jackpots, hatched eggs, link W/L/D,
      // link trades, and the sticker-man brags that read them.
      gameStats: session.gameStats ?? {},
      // Link battle records (Record Corner / fan club) and the trainer card's
      // link win/loss counters -- both read back by link and UI modules.
      linkBattleRecords: tableOr(session.linkBattleRecords, {}),
      trainerCard: tableOr(session.trainerCard, {}),
      // Hall of Fame induction (pret hall_of_fame.c): written by
      // commit_clear_and_save, read by the trainer card and HOF viewers.
      game_cleared: session.game_cleared === true,
      hasHallOfFameRecords: session.hasHallOfFameRecords === true,
      hofDebutHours: tonumber(session.hofDebutHours),
      hofDebutMinutes: tonumber(session.hofDebutMinutes),
      hofDebutSeconds: tonumber(session.hofDebutSeconds),
      hofDebutTime: session.hofDebutTime,
      hallOfFameTeams: tableOr(session.hallOfFameTeams, {}),
      mail: mail_export(session),
      questLog: QuestLog.export(session),
      modData: session.modData,
      meta: session.meta,
    };
    SaveSections.export(session, out, session.version);
    return out;
  },

  // Lua: save_schema_firered.lua:319
  hasNoneItemSlot(bag: any): boolean {
    if (bag == null || typeof bag !== "object") return false;
    if (bag.pockets != null && typeof bag.pockets === "object") {
      for (const [, slots] of pairs<any>(bag.pockets)) {
        if (slots != null && typeof slots === "object") {
          for (const [, slot] of ipairs<any>(slots)) {
            if (slot != null && typeof slot === "object" && slot.id != null && ItemsData.toNumericId(slot.id) === 0) {
              return true;
            }
          }
        }
      }
    }
    if (bag.stacks != null && typeof bag.stacks === "object") {
      for (const [id, qty] of pairs<any>(bag.stacks)) {
        if (ItemsData.toNumericId(id) === 0 && (tonumber(qty) ?? 0) > 0) return true;
      }
    }
    return false;
  },

  // Lua: save_schema_firered.lua:341
  fromSaveTable(save: any): Session {
    if (save == null || typeof save !== "object") return Schema.newGame();
    const version: string = save.version ?? Profile.active().id;
    const rules = Schema.rulesFor(version);
    let bag = save.bag ?? save.inventory ?? {};
    if (truthy(rules.purgeNoneItemFlags) && Schema.hasNoneItemSlot(bag) && save.flags != null && typeof save.flags === "object") {
      rules.purgeNoneItemFlags(save);
    }
    if (bag == null || typeof bag !== "object" || !truthy(bag.pockets)) {
      bag = Bag.migrate(tableOr(bag, {}));
    } else {
      Bag.migrate(bag); // ensure stacks mirror
    }
    const session: Session = {
      schemaVersion: save.schemaVersion ?? Schema.VERSION,
      engine: save.engine ?? "game3",
      version,
      generation: tonumber(save.generation) ?? 3,
      // A party saved with gaps (older PC builds) is closed up on load.
      party: Storage.compactParty(save.party ?? [null]),
      bag,
      dex: save.dex ?? {},
      pokedex: pokedex_view(save.pokedex),
      money: save.money ?? 0,
      coins: save.coins ?? 0,
      berryPowder: tonumber(save.berryPowder) ?? 0,
      berryCrushPressingSpeeds: tableOr(save.berryCrushPressingSpeeds, undefined),
      pokemonJumpRecords: tableOr(save.pokemonJumpRecords, undefined),
      dodrioBerryPickingRecords: tableOr(save.dodrioBerryPickingRecords, undefined),
      registeredTexts: registered_texts_restore(save.registeredTexts),
      trainerNameRecords: trainer_name_records_restore(save.trainerNameRecords),
      name: save.name ?? rules.DEFAULT_NAME,
      rivalName: save.rivalName ?? rules.DEFAULT_RIVAL,
      gender: save.gender ?? 0,
      map: save.map ?? MapIds.newGameStart(version).map,
      x: save.x ?? MapIds.newGameStart(version).x,
      y: save.y ?? MapIds.newGameStart(version).y,
      facing: save.facing ?? "down",
      biking: save.biking === true,
      bikeType: save.bikeType,
      healMap: save.healMap,
      healX: save.healX,
      healY: save.healY,
      stringVars: save.stringVars ?? empty_string_vars(),
      specialVars: save.specialVars ?? empty_special_vars(version),
      flags: save.flags ?? {},
      vars: save.vars ?? {},
      playtime: save.playTime ?? save.playtime ?? { hours: 0, minutes: 0, seconds: 0 },
      easyChatProfile: save.easyChatProfile ?? copy_list(rules.EASY_CHAT_PROFILE),
      options: undefined,
      storage: Storage.restore(save.storage, save.pc, save.pcItems ?? save.pc_items),
      registeredItem: save.registeredItem,
      monBoxId: save.monBoxId,
      monBoxPos: save.monBoxPos,
      // pokefirered/include/global.h:764
      dynamicWarp: tableOr(save.dynamicWarp, undefined),
      escapeWarp: tableOr(save.escapeWarp, undefined),
      continueGameWarp: tableOr(save.continueGameWarp, undefined),
      specialSaveWarpFlags: tonumber(save.specialSaveWarpFlags) ?? 0,
      // pokefirered/include/global.h:348
      gcnLinkFlags: tonumber(save.gcnLinkFlags) ?? 0,
      // pokefirered/include/global.h:770
      flashLevel: tonumber(save.flashLevel),
      move_overlay: save.move_overlay ?? {},
      trainerId: save.trainerId,
      secretId: save.secretId,
      id: save.trainerId,
      playerId: save.trainerId,
      rng: save.rng,
      vsSeeker: rules.restoreVsSeeker(save.vsSeeker),
      roamer: tableOr(save.roamer, undefined),
      // Additive: a save written before this key exists loads as an empty table.
      gameStats: tableOr(save.gameStats, {}),
      // Additive: older saves load these as empty tables.
      linkBattleRecords: tableOr(save.linkBattleRecords, {}),
      trainerCard: tableOr(save.trainerCard, {}),
      // Additive: older saves load these as defaults.
      game_cleared: save.game_cleared === true,
      hasHallOfFameRecords: save.hasHallOfFameRecords === true,
      hofDebutHours: tonumber(save.hofDebutHours),
      hofDebutMinutes: tonumber(save.hofDebutMinutes),
      hofDebutSeconds: tonumber(save.hofDebutSeconds),
      hofDebutTime: save.hofDebutTime,
      hallOfFameTeams: tableOr(save.hallOfFameTeams, {}),
      mail: mail_restore(save),
      questLog: QuestLog.restore(save.questLog),
      modData: tableOr(save.modData, {}),
      meta: save.meta,
    };
    SaveSections.restore(save, session, version);
    SaveMon.each(session, SaveMon.normalize);
    rules.resetStateOnContinue(session);
    rules.useContinueGameWarp(session);
    Schema.ensureMonBalls(session);
    Schema.repairOwnMons(session);
    if (truthy(rules.repairSaveState)) rules.repairSaveState(session);
    Schema.repairRoamer(session);
    if (save.options != null && typeof save.options === "object") {
      Options.bind(session, save.options);
    } else {
      Options.ensure(session);
    }
    return session;
  },

  // Lua: save_schema_firered.lua:447
  repairRoamer(session: any): void {
    if (!truthy(session) || truthy(session.roamer)) return;
    const repair = rules_of(session).repairRoamer;
    if (truthy(repair)) repair(session);
  },

  // Lua: save_schema_firered.lua:453
  ensureMonBall(mon: any): void {
    if (mon == null || typeof mon !== "object") return;
    // pokefirered/src/pokemon.c:1820
    mon.pokeball = tonumber(mon.pokeball) ?? 4;
  },

  // Lua: save_schema_firered.lua:459
  ensureMonNumbering(mon: any): void {
    if (mon == null || typeof mon !== "object") return;
    if (truthy(Pokemon.numberingOf(mon))) return;
    const raw = mon.species ?? mon.speciesId ?? mon.id;
    if (typeof raw === "string" || tonumber(raw) == null) return;
    mon.speciesNumbering = Pokemon.NUMBERING_INTERNAL;
  },

  // Lua: save_schema_firered.lua:468
  ensureMonBalls(session: Session): void {
    for (const [, mon] of ipairs(session.party ?? [null])) {
      Schema.ensureMonBall(mon);
      Schema.ensureMonNumbering(mon);
    }
    const storage = session.storage;
    for (const [, box] of pairs<any>(storage && storage.boxes || {})) {
      for (const [, mon] of pairs(tableOr(box, undefined) ? box.mons ?? {} : {})) {
        Schema.ensureMonBall(mon);
        Schema.ensureMonNumbering(mon);
      }
    }
  },
};

export default Schema;
