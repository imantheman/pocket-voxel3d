// Port of gen1recomp src/core/game3/scripting/natives_queries.lua (GPLv3 + additional terms; see LICENSE.md).
// FRLG query specials: party, dex, money, bag and map questions answered
// into VAR_RESULT or the special's return value.
//
// Port notes:
// - Handlers return Lua's multiple returns as a 0-based tuple, [yield] or
//   [yield, value] (see natives.ts).
// - require / package.loaded / pcall(require) are static imports used as
//   Brian guards them.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { len, type LuaTable } from "../../platform/lt.ts";
import { truthy, tostring, tonumber, mod } from "../../../../import/gen3/lua.ts";
import RomText from "../rom_text.ts";
import Std from "./stdscripts.ts";
import Constants from "../constants.ts";
import Profile from "../profile.ts";
import Flags from "./flags.ts";
import Runtime from "../runtime.ts";
import Space from "./space.ts";
import Pokemon from "../pokemon.ts";
import Items from "../items.ts";
import Bag from "../bag.ts";
import Dex from "../dex.ts";
import PokedexData from "../pokedex_data.ts";
import Rng from "../rng.ts";
import Player from "../player.ts";
import Storage from "../storage.ts";
import type { Handler } from "./natives.ts";

/** Lua's `a or b`. */
function lor<A, B>(a: A, b: B): A | B {
  return truthy(a) ? a : b;
}

const PARTY_SIZE = 6; // pokefirered/include/constants/global.h:78
const SPECIES_EGG = 412; // pokefirered/include/constants/species.h:421
const SPECIES_DODRIO = 85; // pokefirered/include/constants/species.h:89
const ITEM_ENIGMA_BERRY = 175; // pokefirered/include/constants/items.h:179
const FIRST_BERRY_INDEX = 133; // pokefirered/include/constants/items.h:181
const LAST_BERRY_INDEX = 175; // pokefirered/include/constants/items.h:182
const ITEM_BERRY_POUCH = 365; // pokefirered/include/constants/items.h:437
const KANTO_DEX_COUNT = 151; // pokefirered/include/constants/pokedex.h:424
const JOHTO_DEX_COUNT = 251; // pokefirered/include/constants/pokedex.h:425
const NATIONAL_DEX_COUNT = 386; // pokefirered/include/constants/pokedex.h:426

// Lua: natives_queries.lua:17
function C(): any {
  return Constants.of(Profile.forSession(undefined).id);
}

// pokefirered/src/field_specials.c:1519
const STARTER_SPECIES: Record<number, number> = { 0: 1, 1: 7, 2: 4 };

// pokefirered/src/field_specials.c:362
const SLOT_MACHINE_IDS: LuaTable = [null,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 5,
];

// Lua: natives_queries.lua:30
function flagsMod(): typeof Flags {
  return Flags;
}

// Lua: natives_queries.lua:34
function sessionOf(): any {
  // package.loaded["src.core.game3.runtime"]
  const rt = Runtime;
  return lor(rt && rt.getSession && rt.getSession(), undefined);
}

// Lua: natives_queries.lua:39
function scriptStore(): any {
  // package.loaded["src.core.game3.scripting.space"]
  const session = sessionOf();
  return lor(lor(Space && Space.store, session && session.store), undefined);
}

// Lua: natives_queries.lua:45
function varGet(ctx: any, id: number): number {
  return tonumber(flagsMod().getVar(scriptStore(), ctx, id)) ?? 0;
}

// Lua: natives_queries.lua:49
function varSet(ctx: any, id: number, value: any): void {
  flagsMod().setVar(scriptStore(), ctx, id, tonumber(value) ?? 0);
}

// Lua: natives_queries.lua:54
// pokefirered/src/scrcmd.c:99
function setResult(ctx: any, value: any): void {
  varSet(ctx, 0x800D, value);
}

// Lua: natives_queries.lua:58
function boolResult(ctx: any, cond: any): [boolean, number] {
  const v = truthy(cond) ? 1 : 0;
  setResult(ctx, v);
  return [false, v];
}

// Lua: natives_queries.lua:65
// pokefirered/src/scrcmd.c:109
function boolReturn(cond: any): [boolean, number] {
  return [false, truthy(cond) ? 1 : 0];
}

// Lua: natives_queries.lua:69
function partyOf(): LuaTable {
  const session = sessionOf();
  return lor(session && session.party, {});
}

// Lua: natives_queries.lua:74
function speciesOf(mon: any): number {
  return tonumber(mon && lor(mon.species, mon.speciesId)) ?? 0;
}

// Lua: natives_queries.lua:78
function isEgg(mon: any): boolean {
  if (!truthy(mon)) return false;
  if (truthy(mon.isEgg) || truthy(mon.egg)) return true;
  return speciesOf(mon) === SPECIES_EGG;
}

// Lua: natives_queries.lua:85
// pokefirered/src/pokemon.c:3742
function playerPartyCount(): number {
  const party = partyOf();
  let n = 0;
  while (n < PARTY_SIZE && speciesOf(party[n + 1]) !== 0) {
    n = n + 1;
  }
  return n;
}

// Lua: natives_queries.lua:95
// pokefirered/src/pokemon.c:3245
function speciesOrEgg(mon: any): number {
  if (isEgg(mon)) return SPECIES_EGG;
  return speciesOf(mon);
}

// Lua: natives_queries.lua:100
function dexOf(): any {
  const session = sessionOf();
  return session && session.dex;
}

// Lua: natives_queries.lua:105
function nameOfPlayer(): string {
  const session = sessionOf();
  return tostring(lor(session && lor(session.name, session.playerName), ""));
}

// Lua: natives_queries.lua:110
function setStringVar(ctx: any, adapters: any, index: number, text: any): void {
  if (adapters && truthy(adapters.setStringVar)) adapters.setStringVar(index, text);
  if (ctx && truthy(ctx.stringVars)) ctx.stringVars[index] = text;
}

// Lua: natives_queries.lua:116
// pokefirered/src/pokemon.c:5174
function speciesFromNational(nat: number): number {
  let ok = true;
  let sp: any;
  try { sp = Pokemon.speciesFromNational(nat); } catch (_e) { ok = false; }
  return lor(ok && tonumber(sp), nat) as number;
}

// Lua: natives_queries.lua:124
// pokefirered/src/field_specials.c:1671; GetMonData(MON_DATA_NICKNAME) is
// gText_EggNickname for an egg (pokemon.c:3020)
function nicknameOf(mon: any): string {
  if (!truthy(mon)) return "";
  if (Pokemon.isEgg(mon)) return RomText.plain("gText_EggNickname");
  if (truthy(mon.nickname) && mon.nickname !== "") return tostring(mon.nickname);
  try {
    if (!truthy(Pokemon._names)) Pokemon.install(undefined);
  } catch (_e) { /* pcall */ }
  return lor(Pokemon.name && Pokemon.name(speciesOf(mon)), "");
}

// Lua: natives_queries.lua:135
function itemName(itemId: number): string {
  // pcall(require, "src.core.game3.items")
  const ok = true;
  if (ok && Items && Items.displayName) {
    return tostring(lor(Items.displayName(itemId), ""));
  }
  return "";
}

// Lua: natives_queries.lua:143
function heldItemOf(mon: any): number {
  return tonumber(mon && lor(lor(mon.heldItem, mon.item), mon.holdItem)) ?? 0;
}

// Lua: natives_queries.lua:147
function bagOf(): any {
  const session = sessionOf();
  return session && session.bag;
}

// Lua: natives_queries.lua:152
function bagHas(itemId: number, qty?: number): boolean {
  const bag = bagOf();
  if (!truthy(bag)) return false;
  // pcall(require, "src.core.game3.bag")
  const ok = true;
  if (!(ok && Bag && Bag.has)) return false;
  return Bag.has(bag, itemId, qty ?? 1) ? true : false;
}

const BY_NAME: Record<string, Handler> = {
  // Lua: natives_queries.lua:162
  // pokefirered/src/prof_pc.c:23
  GetPokedexCount: (ctx) => {
    const dex = dexOf();
    const mode = (varGet(ctx, 0x8004) === 0) ? "kanto" : "national";
    varSet(ctx, 0x8005, Dex.countSeen(dex, mode));
    varSet(ctx, 0x8006, Dex.countCaught(dex, mode));
    const enabled = PokedexData.isNationalUnlocked(sessionOf(), dex) ? 1 : 0;
    return [false, enabled];
  },
  // Lua: natives_queries.lua:173
  // pokefirered/src/field_specials.c:1537
  SetSeenMon: (ctx) => {
    const dex = dexOf();
    const species = varGet(ctx, 0x8004);
    if (truthy(dex) && species > 0) Dex.setSeen(dex, species);
    return [false];
  },
  // Lua: natives_queries.lua:181
  // pokefirered/src/field_specials.c:158
  SetHiddenItemFlag: (ctx) => {
    const store = scriptStore();
    if (truthy(store)) flagsMod().setFlag(store, ctx, varGet(ctx, 0x8004), true);
    return [false];
  },
  // Lua: natives_queries.lua:187
  // pokefirered/src/pokemon.c:3742
  CalculatePlayerPartyCount: (_ctx) => {
    const n = playerPartyCount();
    return [false, n];
  },
  // Lua: natives_queries.lua:192
  // pokefirered/src/pokemon_storage_system_menu.c:141
  CountPartyNonEggMons: (_ctx) => {
    const party = partyOf();
    let count = 0;
    for (let i = 1; i <= PARTY_SIZE; i++) {
      const mon = party[i];
      if (speciesOf(mon) !== 0 && !isEgg(mon)) count = count + 1;
    }
    return [false, count];
  },
  // Lua: natives_queries.lua:202
  // pokefirered/src/pokemon_storage_system_menu.c:155
  CountPartyAliveNonEggMons_IgnoreVar0x8004Slot: (ctx) => {
    const party = partyOf();
    const skip = varGet(ctx, 0x8004) + 1;
    let count = 0;
    for (let i = 1; i <= PARTY_SIZE; i++) {
      const mon = party[i];
      if (i !== skip && speciesOf(mon) !== 0 && !isEgg(mon)
        && (tonumber(mon.hp) ?? 0) !== 0) {
        count = count + 1;
      }
    }
    return [false, count];
  },
  // Lua: natives_queries.lua:216
  // pokefirered/src/field_specials.c:1767
  DoesPlayerPartyContainSpecies: (ctx) => {
    const party = partyOf();
    const want = varGet(ctx, 0x8004);
    for (let i = 1; i <= playerPartyCount(); i++) {
      if (speciesOrEgg(party[i]) === want) return boolReturn(true);
    }
    return boolReturn(false);
  },
  // Lua: natives_queries.lua:225
  // pokefirered/src/field_specials.c:2494
  PlayerPartyContainsSpeciesWithPlayerID: (ctx) => {
    const session = sessionOf();
    const party = partyOf();
    const want = varGet(ctx, 0x8004);
    const playerId = tonumber(session && session.trainerId) ?? 0;
    for (let i = 1; i <= playerPartyCount(); i++) {
      const mon = party[i];
      const otId = tonumber(mon && lor(mon.otId, mon.ot_id)) ?? playerId;
      if (speciesOrEgg(mon) === want && otId === playerId) {
        return boolReturn(true);
      }
    }
    return boolReturn(false);
  },
  // Lua: natives_queries.lua:240
  // pokefirered/src/field_specials.c:524
  GetPartyMonSpecies: (ctx) => {
    const mon = partyOf()[varGet(ctx, 0x8004) + 1];
    const species = speciesOrEgg(mon);
    return [false, species];
  },
  // Lua: natives_queries.lua:246
  // pokefirered/src/party_menu_specials.c:102
  IsSelectedMonEgg: (ctx) => {
    const mon = partyOf()[varGet(ctx, 0x8004) + 1];
    return boolResult(ctx, isEgg(mon));
  },
  // Lua: natives_queries.lua:251
  // pokefirered/src/field_specials.c:529
  IsMonOTNameNotPlayers: (ctx, adapters) => {
    const mon = partyOf()[varGet(ctx, 0x8004) + 1];
    const player = nameOfPlayer();
    const otName = tostring(lor(mon && lor(mon.otName, mon.ot_name), player));
    setStringVar(ctx, adapters, 1, otName);
    return boolReturn(otName !== player);
  },
  // Lua: natives_queries.lua:259
  // pokefirered/src/field_specials.c:1619
  NameRaterWasNicknameChanged: (ctx, adapters) => {
    const mon = partyOf()[varGet(ctx, 0x8004) + 1];
    const nick = nicknameOf(mon);
    setStringVar(ctx, adapters, 1, nick);
    const before = tostring(lor(ctx && ctx.stringVars && ctx.stringVars[3], ""));
    return boolReturn(before !== nick);
  },
  // Lua: natives_queries.lua:267
  // pokefirered/src/daycare.c:1216
  GetSelectedMonNicknameAndSpecies: (ctx, adapters) => {
    // pokefirered/src/party_menu.c:1200
    const mon = partyOf()[varGet(ctx, 0x8004) + 1];
    const species = speciesOf(mon);
    setStringVar(ctx, adapters, 1, nicknameOf(mon));
    return [false, species];
  },
  // Lua: natives_queries.lua:275
  // pokefirered/src/money.c:63
  IsEnoughForCostInVar0x8005: (ctx) => {
    const session = sessionOf();
    const money = tonumber(session && session.money) ?? 0;
    return boolReturn(money >= varGet(ctx, 0x8005));
  },
  // Lua: natives_queries.lua:281
  // pokefirered/src/money.c:68
  SubtractMoneyFromVar0x8005: (ctx) => {
    const session = sessionOf();
    if (truthy(session)) {
      const money = tonumber(session.money) ?? 0;
      session.money = Math.max(0, money - varGet(ctx, 0x8005));
    }
    return [false];
  },
  // Lua: natives_queries.lua:290
  // pokefirered/src/pokedex.c:110
  HasAllKantoMons: (_ctx) => {
    const dex = dexOf();
    for (let i = 1; i <= KANTO_DEX_COUNT - 1; i++) {
      if (!Dex.isCaught(dex, i)) return boolReturn(false);
    }
    return boolReturn(true);
  },
  // Lua: natives_queries.lua:299
  // pokefirered/src/pokedex.c:123
  HasAllMons: (_ctx) => {
    const dex = dexOf();
    const caughtNational = (nat: number): boolean => {
      return Dex.isCaught(dex, speciesFromNational(nat));
    };
    for (let i = 1; i <= KANTO_DEX_COUNT - 1; i++) {
      if (!caughtNational(i)) return boolReturn(false);
    }
    for (let i = KANTO_DEX_COUNT + 1; i <= JOHTO_DEX_COUNT - 3; i++) {
      if (!caughtNational(i)) return boolReturn(false);
    }
    for (let i = JOHTO_DEX_COUNT + 1; i <= NATIONAL_DEX_COUNT - 2; i++) {
      if (!caughtNational(i)) return boolReturn(false);
    }
    return boolReturn(true);
  },
  // Lua: natives_queries.lua:317
  // pokefirered/src/field_specials.c:1525
  GetStarterSpecies: (ctx) => {
    let idx = varGet(ctx, C().var("VAR_STARTER_MON"));
    if (idx > 2) idx = 0;
    return [false, STARTER_SPECIES[idx] ?? STARTER_SPECIES[0]];
  },
  // Lua: natives_queries.lua:323
  // pokefirered/src/field_specials.c:387
  GetRandomSlotMachineId: (_ctx) => {
    const pick = SLOT_MACHINE_IDS[mod(Rng.Random(), len(SLOT_MACHINE_IDS)) + 1];
    return [false, pick];
  },
  // Lua: natives_queries.lua:329
  // pokefirered/src/field_specials.c:137
  BufferBigGuyOrBigGirlString: (ctx, adapters) => {
    const session = sessionOf();
    const female = (tonumber(session && session.gender) ?? 0) !== 0;
    setStringVar(ctx, adapters, 1, RomText.plain(female ? "gText_BigGirl" : "gText_BigGuy"));
    return [false];
  },
  // Lua: natives_queries.lua:336
  // pokefirered/src/field_player_avatar.c:1082
  GetPlayerFacingDirection: (ctx) => {
    // package.loaded["src.core.game3.player"]
    const P = Player;
    const dirs: Record<string, number> = { down: 1, up: 2, left: 3, right: 4 };
    const key = P && P.facing;
    const facing = (key != null ? dirs[key] : undefined) ?? varGet(ctx, 0x800C);
    return [false, facing];
  },
  // Lua: natives_queries.lua:343
  // pokefirered/src/seagallop.c:496
  IsPlayerLeftOfVermilionSailor: (_ctx) => {
    const session = sessionOf();
    const onMap = truthy(session) && session.map === "FR_VERMILION_CITY";
    const x = tonumber(session && session.x) ?? 0;
    return boolReturn(onMap && x < 24);
  },
  // Lua: natives_queries.lua:350
  // pokefirered/src/field_specials.c:2470
  IsPlayerNotInTrainerTowerLobby: () => {
    const session = sessionOf();
    return boolReturn((session && session.map) !== "FR_TRAINER_TOWER_LOBBY");
  },
  // Lua: natives_queries.lua:355
  // pokefirered/src/union_room.c:3606
  BufferUnionRoomPlayerName: () => {
    return boolReturn(false);
  },
  // Lua: natives_queries.lua:359
  // pokefirered/src/field_specials.c:2458
  IsBadEggInParty: () => {
    const party = partyOf();
    for (let i = 1; i <= playerPartyCount(); i++) {
      if (truthy(party[i]) && party[i].isBadEgg === true) return boolReturn(true);
    }
    return boolReturn(false);
  },
  // Lua: natives_queries.lua:367
  // pokefirered/src/field_specials.c:432
  IsThereRoomInAnyBoxForMorePokemon: () => {
    const session = sessionOf();
    const storage = session && session.storage;
    if (!(truthy(storage) && truthy(storage.boxes))) return boolReturn(true);
    for (let b = 1; b <= Storage.TOTAL_BOXES_COUNT; b++) {
      for (let s = 1; s <= Storage.IN_BOX_COUNT; s++) {
        if (Storage.getBoxMon(storage, b, s) == null) return boolReturn(true);
      }
    }
    return boolReturn(false);
  },
  // Lua: natives_queries.lua:380
  // pokefirered/src/dodrio_berry_picking.c:2911
  IsDodrioInParty: (ctx) => {
    const party = partyOf();
    for (let i = 1; i <= PARTY_SIZE; i++) {
      const mon = party[i];
      if (speciesOf(mon) !== 0 && speciesOrEgg(mon) === SPECIES_DODRIO) {
        return boolResult(ctx, true);
      }
    }
    return boolResult(ctx, false);
  },
  // Lua: natives_queries.lua:391
  // pokefirered/src/item.c:142
  HasAtLeastOneBerry: (ctx) => {
    if (!bagHas(ITEM_BERRY_POUCH, 1)) return boolResult(ctx, false);
    for (let itemId = FIRST_BERRY_INDEX; itemId <= LAST_BERRY_INDEX; itemId++) {
      if (bagHas(itemId, 1)) return boolResult(ctx, true);
    }
    return boolResult(ctx, false);
  },
  // Lua: natives_queries.lua:399
  // pokefirered/src/script_pokemon_util.c:119
  DoesPartyHaveEnigmaBerry: (ctx, adapters) => {
    const party = partyOf();
    for (let i = 1; i <= PARTY_SIZE; i++) {
      if (heldItemOf(party[i]) === ITEM_ENIGMA_BERRY) {
        setStringVar(ctx, adapters, 1, itemName(ITEM_ENIGMA_BERRY));
        return boolReturn(true);
      }
    }
    return boolReturn(false);
  },
  // Lua: natives_queries.lua:410
  // pokefirered/src/field_specials.c:1985
  ShouldShowBoxWasFullMessage: (ctx) => {
    const store = scriptStore();
    const F = flagsMod();
    const shownFlag = C().flag("FLAG_SHOWN_BOX_WAS_FULL_MESSAGE");
    if (F.getFlag(store, ctx, shownFlag)) {
      return boolReturn(false);
    }
    const session = sessionOf();
    const storage = session && session.storage;
    const current = (tonumber(storage && storage.currentBox) ?? 1) - 1;
    if (current === varGet(ctx, C().var("VAR_PC_BOX_TO_SEND_MON"))) return boolReturn(false);
    if (truthy(store)) F.setFlag(store, ctx, shownFlag, true);
    return boolReturn(true);
  },
  // Lua: natives_queries.lua:425
  // pokefirered/src/field_specials.c:1980
  GetPCBoxToSendMon: () => {
    return [false, lor(Queries.pcBoxToSendMon, 0)];
  },
  // Lua: natives_queries.lua:429
  // pokefirered/src/field_specials.c:2056
  BufferTMHMMoveName: (ctx, adapters) => {
    const move = Pokemon.moveFromTmItem(varGet(ctx, 0x8004));
    if (!truthy(move)) return boolReturn(false);
    setStringVar(ctx, adapters, 1, Pokemon.moveName(move));
    return boolReturn(true);
  },
};

export const Queries = {
  BY_NAME,
  /** Set by Std.legacyHandlers (stdscripts.lua:262): special id -> handler. */
  HANDLERS: undefined as Record<number, Handler> | undefined,
  pcBoxToSendMon: 0,

  // Lua: natives_queries.lua:442
  setPCBoxToSendMon(boxId: any): void {
    Queries.pcBoxToSendMon = tonumber(boxId) ?? 0;
  },
};
// Lua: natives_queries.lua:437
Std.legacyHandlers(Queries);

// Lua: natives_queries.lua:440
// pokefirered/src/field_specials.c:1975
Queries.pcBoxToSendMon = 0;

export default Queries;
