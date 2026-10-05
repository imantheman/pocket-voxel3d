// Port of gen1recomp src/core/game3/scripting/natives_trade.lua (GPLv3 + additional terms; see LICENSE.md).
// In-game trades (sInGameTrades): the trade mon, the party swap, the trade
// scene task, and the trade-eligibility checks the Cable Club shares.
//
// Port notes:
// - Handlers return Lua's multiple returns as a 0-based tuple (see
//   natives.ts); noteLinkTrade returns [key, vars] ([] for nil).
// - Trade.TRADES / Trade.MAIL_MESSAGES are Lua tables with an __index
//   metamethod onto the cache pack: Proxies here.
// - require / package.loaded / pcall(require, ...): every module is in the
//   bundle, so each is a static import used exactly as Brian guards it.
//   package.loaded["src.ui.game3.evolution_scene"] reads as not loaded while
//   that module is a stub (its isOpen throws NotPortedError).
// - `love and love.graphics` (tryTradeEvolution): always present here.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { seq, len, type LuaTable } from "../../platform/lt.ts";
import { truthy, tonumber, tostring, mod } from "../../../../import/gen3/lua.ts";
import { luaLoad } from "../../platform/luadata.ts";
import { NotPortedError } from "../../notported.ts";
import Strings from "../../shared/core/Strings.ts";
import Std from "./stdscripts.ts";
import Mail from "../mail.ts";
import GameVersion from "../../shared/core/GameVersion.ts";
import Dataset from "../dataset.ts";
import Flags from "./flags.ts";
import Runtime from "../runtime.ts";
import Space from "./space.ts";
import Pokemon from "../pokemon.ts";
import RomText from "../rom_text.ts";
import PokedexData from "../pokedex_data.ts";
import Party from "../party.ts";
import Dex from "../dex.ts";
import Evolution from "../evolution.ts";
import EvolutionScene from "../../ui/evolution_scene.ts";
import Fade from "../../ui/fade.ts";
import TradeScene from "../trade_scene.ts";
import Natives, { type Handler } from "./natives.ts";

/** Lua's `a or b`. */
function lor<A, B>(a: A, b: B): A | B {
  return truthy(a) ? a : b;
}

const VAR_0x8004 = 0x8004; // pokefirered/include/constants/vars.h:319
const VAR_0x8005 = 0x8005; // pokefirered/include/constants/vars.h:320

const SPECIES_NONE = 0; // pokefirered/include/constants/species.h:4
const SPECIES_EGG = 412; // pokefirered/include/constants/species.h:421
const METLOC_IN_GAME_TRADE = 0xFE; // pokefirered/include/constants/region_map_sections.h:218
const TRADED_FRIENDSHIP = 70; // pokefirered/src/trade_scene.c:1075

// pokefirered/src/trade_scene.c:2778
const FADE_FRAMES = 16;

const FILE = "data/generated/gba/trades/ingame_trades.lua";

const packs: Record<string, any> = {};
// Lua: natives_trade.lua:21
function pack(): any {
  const version = tostring(GameVersion.get());
  if (!packs[version]) {
    const src = Dataset.cache().read(FILE);
    if (!truthy(src)) throw new Error(FILE + " is not in the cache");
    const [chunk, err] = luaLoad(src, "@" + FILE);
    if (!truthy(chunk)) throw new Error(tostring(err));
    packs[version] = chunk!();
  }
  return packs[version];
}

// Lua: natives_trade.lua:56
function flagsMod(): typeof Flags {
  return Flags;
}

// Lua: natives_trade.lua:60
function sessionOf(): any {
  // package.loaded["src.core.game3.runtime"]
  const rt = Runtime;
  return lor(rt && rt.getSession && rt.getSession(), undefined);
}

// Lua: natives_trade.lua:65
function scriptStore(): any {
  // package.loaded["src.core.game3.scripting.space"]
  const session = sessionOf();
  return lor(lor(Space && Space.store, session && session.store), undefined);
}

// Lua: natives_trade.lua:71
function varGet(ctx: any, id: number): number {
  return tonumber(flagsMod().getVar(scriptStore(), ctx, id)) ?? 0;
}

// Lua: natives_trade.lua:75
function partyOf(): any {
  const session = sessionOf();
  return lor(session && session.party, seq());
}

// Lua: natives_trade.lua:80
function speciesOf(mon: any): number {
  return tonumber(mon ? lor(mon.species, mon.speciesId) : undefined) ?? 0;
}

// Lua: natives_trade.lua:84
function isEgg(mon: any): boolean {
  if (!mon) return false;
  if (truthy(mon.isEgg) || truthy(mon.egg)) return true;
  return speciesOf(mon) === SPECIES_EGG;
}

// Lua: natives_trade.lua:90
function setStringVar(ctx: any, adapters: any, index: number, text: string): void {
  if (adapters && truthy(adapters.setStringVar)) adapters.setStringVar(index, text);
  if (ctx && truthy(ctx.stringVars)) ctx.stringVars[index] = text;
}

// Lua: natives_trade.lua:95
function pokemonMod(): typeof Pokemon {
  if (!truthy(Pokemon._names)) {
    try { Pokemon.install(undefined); } catch { /* pcall */ }
  }
  return Pokemon;
}

// Lua: natives_trade.lua:101
function speciesName(species: any): string {
  const P = pokemonMod();
  return lor(P.name && P.name(species), "");
}

// Lua: natives_trade.lua:108
// GetMonData(MON_DATA_NICKNAME) is gText_EggNickname for an egg
// (pokefirered/src/pokemon.c:3020)
function nicknameOf(mon: any): string {
  if (!mon) return "";
  if (Pokemon.isEgg(mon)) return RomText.plain("gText_EggNickname");
  if (truthy(mon.nickname) && mon.nickname !== "") return tostring(mon.nickname);
  return speciesName(speciesOf(mon));
}

// pokefirered/include/constants/species.h:157 KANTO_SPECIES_END
const KANTO_SPECIES_END = 151;
const SPECIES_MEW = 151; // pokefirered/include/constants/species.h:155
const SPECIES_DEOXYS = 410; // pokefirered/include/constants/species.h:419
const VERSION_RUBY = 2; // pokefirered/include/constants/global.h:9
const VERSION_SAPPHIRE = 1; // pokefirered/include/constants/global.h:8

// Lua: natives_trade.lua:131
// pokefirered/src/pokemon.c:3049 MON_DATA_SPECIES_OR_EGG
function speciesOrEgg(mon: any): number {
  if (!mon) return SPECIES_NONE;
  if (isEgg(mon)) return SPECIES_EGG;
  return speciesOf(mon);
}

// Lua: natives_trade.lua:137
function nationalUnlocked(sessionIn: any): boolean {
  // pcall(require, "src.core.game3.pokedex_data")
  if (!(PokedexData && PokedexData.isNationalUnlocked)) return false;
  const session = lor(sessionIn, undefined) ?? sessionOf();
  let unlocked: any;
  try {
    unlocked = PokedexData.isNationalUnlocked(session, session && session.dex);
  } catch {
    return false;
  }
  return unlocked === true;
}

// Lua: natives_trade.lua:349
// pokefirered/src/quest_log_events.c:1014
function questSpeciesName(mon: any): string {
  if (isEgg(mon)) return RomText.plain("gText_EggNickname");
  return speciesName(speciesOf(mon));
}

// Lua: natives_trade.lua:370
function evolutionOpen(): boolean {
  // package.loaded["src.ui.game3.evolution_scene"] (see the port notes)
  const Scene: any = EvolutionScene;
  if (!(Scene && truthy(Scene.isOpen))) return false;
  try {
    return truthy(Scene.isOpen());
  } catch (e) {
    if (e instanceof NotPortedError) return false;
    throw e;
  }
}

// Lua: natives_trade.lua:389
function fade(mode: number): void {
  // pcall(require, "src.ui.game3.fade")
  if (Fade && Fade.begin) {
    try { Fade.begin(mode, 1, () => {}); } catch { /* pcall */ }
  }
}

const BY_NAME: Record<string, Handler> = {
  // Lua: natives_trade.lua:466
  // pokefirered/src/trade_scene.c:2434
  GetInGameTradeSpeciesInfo: (ctx, adapters) => {
    const entry = Trade.entry(varGet(ctx, VAR_0x8004));
    if (!entry) return [false, SPECIES_NONE];
    setStringVar(ctx, adapters, 1, speciesName(entry.requestedSpecies));
    setStringVar(ctx, adapters, 2, speciesName(entry.species));
    return [false, entry.requestedSpecies];
  },
  // Lua: natives_trade.lua:474
  // pokefirered/src/trade_scene.c:2514
  GetTradeSpecies: (ctx) => {
    const mon = partyOf()[varGet(ctx, VAR_0x8005) + 1];
    if (isEgg(mon)) return [false, SPECIES_NONE];
    return [false, speciesOf(mon)];
  },
  // Lua: natives_trade.lua:480
  // pokefirered/src/trade_scene.c:2522
  CreateInGameTradePokemon: (ctx) => {
    Trade._offered = Trade.createTradeMon(varGet(ctx, VAR_0x8004), Trade.levelOfSlot(varGet(ctx, VAR_0x8005)));
    return [false];
  },
  // Lua: natives_trade.lua:485
  // pokefirered/src/trade_scene.c:2774
  DoInGameTradeScene: (ctx, adapters) => {
    Natives.awaitState(ctx, Trade.sceneTask(ctx, adapters, varGet(ctx, VAR_0x8004),
      varGet(ctx, VAR_0x8005)));
    return [false];
  },
};

export const Trade = {
  FILE,

  // Lua: natives_trade.lua:32
  // pokefirered/src/data/ingame_trades.h:1 sInGameTrades
  TRADES: new Proxy({} as Record<number, any>, { get: (_t, id) => pack().trades[id as any] }),

  // Lua: natives_trade.lua:33
  entry(id: any): any {
    return pack().trades[id];
  },
  COUNT: 9,

  // Lua: natives_trade.lua:39
  // pokefirered/src/data/ingame_trades.h:184 sInGameTradeMailMessages
  MAIL_MESSAGES: new Proxy({} as Record<number, any>, { get: (_t, id) => pack().mail[id as any] }),

  // pokefirered/src/trade.c:144 gLinkPartnerMail
  PARTNER_MAIL: {} as Record<number, any>,

  /** The mon CreateInGameTradePokemon built (Brian's Trade._offered). */
  _offered: undefined as any,

  // Lua: natives_trade.lua:45
  // pokefirered/src/trade_scene.c:2488 gLinkPartnerMail[0] = mail
  setPartnerMail(mailNum: any, record: any): boolean {
    const id = tonumber(mailNum);
    if (id == null) return false;
    Trade.PARTNER_MAIL[id] = record;
    return true;
  },

  // Lua: natives_trade.lua:52
  clearPartnerMail(): void {
    Trade.PARTNER_MAIL = {};
  },

  // pokefirered/include/constants/trade.h:24
  CAN_TRADE_MON: 0,
  CANT_TRADE_LAST_MON: 1,
  CANT_TRADE_NATIONAL: 2,
  CANT_TRADE_EGG_YET: 3,
  CANT_TRADE_INVALID_MON: 4,
  CANT_TRADE_PARTNER_EGG_YET: 5,

  // Lua: natives_trade.lua:146
  // pokefirered/src/field_specials.c:2458 IsBadEggInParty
  hasBadEgg(partyIn?: any): boolean {
    const party = lor(partyIn, undefined) ?? partyOf();
    for (let i = 1; i <= 6; i++) {
      if (truthy(party[i]) && party[i].isBadEgg === true) return true;
    }
    return false;
  },

  // Lua: natives_trade.lua:155
  // pokefirered/src/trade.c:2745 CanTradeSelectedMon
  canTradeSelectedMon(partyIn: any, monIdx: any, optsIn?: any): number {
    const party = lor(partyIn, undefined) ?? partyOf();
    const opts = lor(optsIn, undefined) ?? {};
    const idx = (tonumber(monIdx) ?? 0) + 1;
    const count = tonumber(opts.partyCount) ?? len(party);
    const species2: Record<number, number> = {};
    const species: Record<number, number> = {};
    for (let i = 1; i <= count; i++) {
      species2[i] = speciesOrEgg(party[i]);
      species[i] = speciesOf(party[i]);
    }

    let national = opts.nationalDex;
    if (national == null) national = nationalUnlocked(opts.session);
    if (!truthy(national)) {
      // pokefirered/src/trade.c:2767
      if (species2[idx] != null && species2[idx]! > KANTO_SPECIES_END) {
        return Trade.CANT_TRADE_NATIONAL;
      }
      // pokefirered/src/trade.c:2775
      if (species2[idx] === SPECIES_NONE) return Trade.CANT_TRADE_EGG_YET;
    }

    // pokefirered/src/trade.c:2780
    const partner = opts.partner;
    if (truthy(partner)) {
      let version = tonumber(partner.version) ?? 0;
      version = mod(version, 0x100);
      if (version !== VERSION_RUBY && version !== VERSION_SAPPHIRE) {
        const flags = tonumber(partner.progressFlags) ?? 0;
        if (mod(flags, 16) === 0) {
          if (species2[idx] === SPECIES_EGG) return Trade.CANT_TRADE_PARTNER_EGG_YET;
          if (species2[idx] != null && species2[idx]! > KANTO_SPECIES_END) {
            return Trade.CANT_TRADE_INVALID_MON;
          }
        }
      }
    }

    // pokefirered/src/trade.c:2795
    if (species[idx] === SPECIES_DEOXYS || species[idx] === SPECIES_MEW) {
      if (truthy(party[idx]) && party[idx].fatefulEncounter === false) {
        return Trade.CANT_TRADE_INVALID_MON;
      }
    }

    // pokefirered/src/trade.c:2803
    for (let i = 1; i <= count; i++) {
      if (species2[i] === SPECIES_EGG) species2[i] = SPECIES_NONE;
    }
    let left = 0;
    for (let i = 1; i <= count; i++) {
      if (i !== idx) left = left + (species2[i] ?? 0);
    }
    if (left !== 0) return Trade.CAN_TRADE_MON;
    return Trade.CANT_TRADE_LAST_MON;
  },

  // Lua: natives_trade.lua:213
  // pokefirered/src/trade.c:546 sMessages
  refusalText(code: any): string | undefined {
    if (code === Trade.CANT_TRADE_LAST_MON) {
      return RomText.plain("gText_OnlyPkmnForBattle");
    }
    if (code === Trade.CANT_TRADE_EGG_YET || code === Trade.CANT_TRADE_PARTNER_EGG_YET) {
      return RomText.plain("gText_EggCantBeTradedNow");
    }
    if (code === Trade.CANT_TRADE_NATIONAL || code === Trade.CANT_TRADE_INVALID_MON) {
      return RomText.plain("gText_PkmnCantBeTradedNow");
    }
    return undefined;
  },

  // Lua: natives_trade.lua:228
  // pokefirered/data/scripts/cable_club.inc:1440 CableClub_Text_YouHaveAMonThatCantBeTaken
  badEggText(): string {
    return RomText.plain("CableClub_Text_YouHaveAMonThatCantBeTaken");
  },

  // Lua: natives_trade.lua:232
  peerMonRefusalText(): string {
    return RomText.plain("gText_OtherTrainersPkmnCantBeTraded");
  },

  // Lua: natives_trade.lua:237
  // pokefirered/src/trade_scene.c:2500 GetInGameTradeMail
  tradeMail(entry: any): any {
    const words = entry ? Trade.MAIL_MESSAGES[tonumber(entry.mailNum) ?? -1] : undefined;
    if (!truthy(words)) return undefined;
    const record: any = Mail.clear(undefined);
    for (let i = 1; i <= Mail.MAIL_WORDS_COUNT; i++) {
      record.words[i] = lor(words[i], Mail.EC_WORD_UNDEFINED);
    }
    record.playerName = Strings(entry.otName);
    record.trainerId = entry.otId;
    record.species = entry.species;
    record.itemId = entry.heldItem;
    record.design = Mail.designOf(entry.heldItem);
    return record;
  },

  // Lua: natives_trade.lua:253
  // pokefirered/src/trade_scene.c:2456 CreateInGameTradePokemonInternal
  createTradeMon(tradeIdx: any, levelIn?: any): any {
    const entry = Trade.entry(tonumber(tradeIdx) ?? -1);
    if (!truthy(entry)) return undefined;
    const level = Math.max(1, Math.min(100, tonumber(levelIn) ?? 5));

    const P = pokemonMod();
    const nickname = Strings(entry.nickname), otName = Strings(entry.otName);
    const scratch = { party: seq(), name: otName, trainerId: entry.otId };
    const [ok, , mon] = Party.giveMon(scratch, entry.species, level, nickname);
    if (!(truthy(ok) && truthy(mon))) return undefined;

    mon.personality = entry.personality;
    mon.nature = lor(P.natureId && P.natureId(entry.personality), 0);
    mon.ivs = {
      hp: entry.ivs[1], atk: entry.ivs[2], def: entry.ivs[3],
      spe: entry.ivs[4], spa: entry.ivs[5], spd: entry.ivs[6],
    };
    mon.nickname = nickname;
    mon.name = nickname;
    mon.ot = otName;
    mon.otName = otName;
    mon.otId = entry.otId;
    mon.otGender = entry.otGender;
    const abilities: LuaTable = lor(P.abilities && P.abilities(entry.species), seq());
    const ability = lor(lor(abilities[entry.abilityNum + 1], abilities[1]), 0);
    mon.ability = ability;
    mon.abilityId = ability;
    mon.gender = lor(P.gender && P.gender(entry.species, entry.personality), "U");
    mon.metLocation = METLOC_IN_GAME_TRADE;
    if (entry.conditions != null && typeof entry.conditions === "object") {
      // pokeemerald/src/trade.c:4571
      const c = entry.conditions;
      mon.contest = { cool: c[1], beauty: c[2], cute: c[3], smart: c[4], tough: c[5], sheen: lor(entry.sheen, 0) };
    }
    mon.item = entry.heldItem;
    mon.heldItem = entry.heldItem;
    // pokefirered/src/trade_scene.c:2483
    if (entry.heldItem !== 0 && Mail.isMailItem(entry.heldItem)) {
      Trade.PARTNER_MAIL[0] = Trade.tradeMail(entry);
      mon.mail = 0;
    } else {
      mon.mail = undefined;
    }
    mon.hp = undefined;
    P.applyStats(mon);
    return mon;
  },

  // Lua: natives_trade.lua:303
  // pokefirered/src/trade_scene.c:1054 TradeMons
  tradeMons(session: any, playerSlot: any, offered: any): any {
    if (!(truthy(session) && truthy(offered))) return undefined;
    session.party = lor(session.party, undefined) ?? seq();
    const party = session.party;
    const slot = (tonumber(playerSlot) ?? 0) + 1;
    const sent = party[slot];
    if (!truthy(sent)) return undefined;
    // pokefirered/src/trade_scene.c:1060
    const playerMail = tonumber(sent.mail);
    const partnerMail = tonumber(offered.mail);
    // pokefirered/src/trade_scene.c:1066
    if (playerMail != null && playerMail !== Mail.MAIL_NONE) {
      const record = Mail.slot(session, playerMail);
      if (record) Mail.clear(record);
    }
    party[slot] = offered;
    // pokefirered/src/trade_scene.c:1075
    if (!isEgg(offered)) {
      offered.friendship = TRADED_FRIENDSHIP;
      offered.happiness = TRADED_FRIENDSHIP;
    }
    // pokefirered/src/trade_scene.c:1078
    if (partnerMail != null && partnerMail !== Mail.MAIL_NONE) {
      const record = Trade.PARTNER_MAIL[partnerMail];
      if (truthy(record)) Mail.giveMailToMon2(session, offered, record);
    }
    // pokefirered/src/trade_scene.c:1081 UpdatePokedexForReceivedMon
    // pokefirered/src/trade_scene.c:1036
    if (!isEgg(offered)) {
      session.dex = lor(session.dex, undefined) ?? { seen: {}, owned: {}, caught: {} };
      session.dex.seen = lor(session.dex.seen, undefined) ?? {};
      session.dex.owned = lor(session.dex.owned, undefined) ?? {};
      session.dex.caught = lor(session.dex.caught, undefined) ?? {};
      const species = speciesOf(offered);
      if (species !== SPECIES_NONE) {
        session.dex.seen[species] = true;
        Dex.handleSetPokedexFlag(session.dex, species, true, offered.personality);
      }
    }
    return sent;
  },

  // pokefirered/include/constants/game_stat.h:25
  GAME_STAT_POKEMON_TRADES: 21,

  // Lua: natives_trade.lua:355
  // pokefirered/src/trade_scene.c:2599
  noteLinkTrade(session: any, sent: any, received: any, partnerName: any, unionRoom: any): [string?, any?] {
    if (session == null || typeof session !== "object") return [];
    let key = "TradedMon1ForTrainersMon2";
    if (!truthy(unionRoom)) {
      key = "TradedMon1ForPersonsMon2";
      // pokefirered/src/trade_scene.c:2606
      if (session.gameStats == null || typeof session.gameStats !== "object") session.gameStats = {};
      const id = Trade.GAME_STAT_POKEMON_TRADES;
      session.gameStats[id] = Math.min(0xFFFFFF, Math.floor(tonumber(session.gameStats[id]) ?? 0) + 1);
    }
    // pokefirered/src/quest_log_events.c:1280
    return [key, {
      S1: tostring(lor(partnerName, "")), S2: questSpeciesName(received),
      S3: questSpeciesName(sent),
    }];
  },

  // Lua: natives_trade.lua:376
  // pokefirered/src/trade_scene.c:2277
  tryTradeEvolution(mon: any, session: any): boolean {
    const target = Evolution.tradeTarget(mon, session);
    if (target == null) return false;
    // pcall(require, "src.ui.game3.evolution_scene"); `love and love.graphics`: always here
    const ES: any = EvolutionScene;
    if (ES && truthy(ES.start)) {
      ES.start(mon, target, { canStop: false, session, via: "trade" });
      return true;
    }
    Evolution.apply(mon, target, session, session && session.bag, "trade");
    return false;
  },

  // Lua: natives_trade.lua:397
  // pokefirered/src/trade_scene.c:2774 DoInGameTradeScene
  sceneTask(ctx: any, adapters: any, tradeIdx: any, playerSlot: any): () => boolean {
    const entry = Trade.entry(tonumber(tradeIdx) ?? -1);
    let frames = 0;
    let phase = "fadeout";
    return (): boolean => {
      if (phase === "fadeout") {
        if (frames === 0) {
          // pcall(require, "src.ui.game3.fade")
          if (Fade && Fade.MODE) fade(Fade.MODE.TO_BLACK);
        }
        frames = frames + 1;
        // pokefirered/src/trade_scene.c:2784 Task_InGameTrade
        if (frames < FADE_FRAMES) return false;
        phase = "scene";
        const session = sessionOf();
        const offered = lor(Trade._offered, undefined)
          ?? Trade.createTradeMon(tradeIdx, Trade.levelOfSlot(playerSlot));
        Trade._offered = undefined;
        const sent = partyOf()[(tonumber(playerSlot) ?? 0) + 1];
        if (!(truthy(offered) && truthy(sent))) {
          if (adapters && truthy(adapters.log)) {
            adapters.log("[game3] in-game trade " + tostring(tradeIdx) + " had no mon to swap");
          }
          phase = "abort";
          frames = 0;
          if (Fade && Fade.MODE) fade(Fade.MODE.FROM_BLACK);
          return false;
        }
        let swapped = false;
        TradeScene.play(sent, offered, undefined, {
          otName: truthy(entry) ? Strings(entry.otName) : undefined,
          // pokefirered/src/trade_scene.c:1776 TradeMons(gSpecialVar_0x8005, 0)
          onSwap: () => {
            if (!truthy(Trade.tradeMons(session, playerSlot, offered))) return;
            swapped = true;
            // pokefirered/src/trade_scene.c:2445 BufferInGameTradeMonName
            setStringVar(ctx, adapters, 1, nicknameOf(offered));
            setStringVar(ctx, adapters, 2, speciesName(speciesOf(offered)));
          },
          // pokefirered/src/trade_scene.c:1778
          onEvolve: () => {
            if (!swapped) return;
            Trade.tryTradeEvolution(offered, session);
          },
        });
        return false;
      }
      if (phase === "abort") {
        frames = frames + 1;
        return frames >= FADE_FRAMES;
      }
      if (phase === "scene") {
        if (TradeScene.step()) phase = "evolving";
        return false;
      }
      // pokefirered/src/trade_scene.c:1777 gCB2_AfterEvolution
      return !evolutionOpen();
    };
  },

  // Lua: natives_trade.lua:459
  levelOfSlot(playerSlot: any): number {
    const mon = partyOf()[(tonumber(playerSlot) ?? 0) + 1];
    return tonumber(mon ? mon.level : undefined) ?? 5;
  },

  BY_NAME,
  /** Set by Std.legacyHandlers (stdscripts.lua:262): special id -> handler. */
  HANDLERS: undefined as Record<number, Handler> | undefined,
};
// Lua: natives_trade.lua:492
Std.legacyHandlers(Trade);

export default Trade;
