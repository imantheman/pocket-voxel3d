// Port of gen1recomp src/core/game3/scripting/natives_daycare.lua (GPLv3 + additional terms; see LICENSE.md).
// Day Care specials (Four Island and Route 5): state, deposit/withdraw,
// costs, levels gained, compatibility text, the level menu and the egg.
//
// Port notes:
// - Handlers return Lua's multiple returns as a 0-based tuple (see natives.ts).
// - require("src.ui.game3.daycare_menu") (a plain require) has no file in the
//   port: it is looked up in G3Lazy, and a missing entry throws the "module
//   not found" error Lua's require raises.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { ipairs, seq, type LuaTable } from "../../platform/lt.ts";
import { truthy, tonumber, tostring } from "../../../../import/gen3/lua.ts";
import Std from "./stdscripts.ts";
import Model from "../daycare.ts";
import Breeding from "../breeding.ts";
import Flags from "./flags.ts";
import Runtime, { G3Lazy } from "../runtime.ts";
import Space from "./space.ts";
import RomText from "../rom_text.ts";
import Mail from "../mail.ts";
import Natives, { type Handler, type HandlerRet } from "./natives.ts";

/** Lua's `a or b`. */
function lor<A, B>(a: A, b: B): A | B {
  return truthy(a) ? a : b;
}

const VAR_RESULT = 0x800D; // pokefirered/include/constants/vars.h:328
const VAR_0x8004 = 0x8004; // pokefirered/include/constants/vars.h:319
const VAR_0x8005 = 0x8005; // pokefirered/include/constants/vars.h:320

const PARTY_SIZE = 6; // pokefirered/include/constants/global.h:78
const SPECIES_NONE = 0; // pokefirered/include/constants/species.h:4

// pokefirered/include/constants/daycare.h:11
const DAYCARE_NO_MONS = 0;
const DAYCARE_EGG_WAITING = 1;
// pokefirered/include/constants/daycare.h:20
const DAYCARE_LEVEL_MENU_EXIT = 5;
const DAYCARE_EXITED_LEVEL_MENU = 2;

// pokefirered/include/constants/daycare.h:5
const PARENTS_INCOMPATIBLE = 0;
const PARENTS_LOW_COMPATIBILITY = 20;
const PARENTS_MED_COMPATIBILITY = 50;
const PARENTS_MAX_COMPATIBILITY = 70;

// pokefirered/include/constants/party_menu.h:61
const PARTY_MENU_TYPE_DAYCARE = 6;

// Lua: natives_daycare.lua:31
function flagsMod(): typeof Flags {
  return Flags;
}

// Lua: natives_daycare.lua:35
function sessionOf(): any {
  // package.loaded["src.core.game3.runtime"]
  const rt = Runtime;
  return lor(rt && rt.getSession && rt.getSession(), undefined);
}

// Lua: natives_daycare.lua:40
function scriptStore(): any {
  // package.loaded["src.core.game3.scripting.space"]
  const session = sessionOf();
  return lor(lor(Space && Space.store, session && session.store), undefined);
}

// Lua: natives_daycare.lua:46
function varGet(ctx: any, id: number): number {
  return tonumber(flagsMod().getVar(scriptStore(), ctx, id)) ?? 0;
}

// Lua: natives_daycare.lua:50
function varSet(ctx: any, id: number, value: any): void {
  flagsMod().setVar(scriptStore(), ctx, id, tonumber(value) ?? 0);
}

// Lua: natives_daycare.lua:54
function setResult(ctx: any, value: any): void {
  varSet(ctx, VAR_RESULT, value);
}

// Lua: natives_daycare.lua:58
function boolReturn(cond: any): HandlerRet {
  return [false, truthy(cond) ? 1 : 0];
}

// Lua: natives_daycare.lua:62
function setStringVar(ctx: any, adapters: any, index: number, text: string): void {
  if (adapters && truthy(adapters.setStringVar)) adapters.setStringVar(index, text);
  if (ctx && truthy(ctx.stringVars)) ctx.stringVars[index] = text;
}

// Lua: natives_daycare.lua:67
const speciesOf = Model.speciesOf;
const nicknameOf = Model.nickname;
const slotMon = Model.mon;
const eggPending = Model.isEggPending;

// Lua: natives_daycare.lua:73
// data/maps/FourIsland_PokemonDayCare/scripts.inc:86-88, data/maps/FourIsland/scripts.inc:95-104, data/scripts/day_care.inc:79-81, daycare.c, src/daycare.c:525, :1081
function partyIsFull(session: any): boolean {
  const party = lor(session && session.party, {} as any);
  let count = 0;
  for (let i = 1; i <= PARTY_SIZE; i++) {
    if (speciesOf(party[i]) !== SPECIES_NONE) count = count + 1;
  }
  return count >= PARTY_SIZE;
}

// Lua: natives_daycare.lua:112
function levelMenu(): any {
  // require("src.ui.game3.daycare_menu") (see the port notes)
  const Menu = G3Lazy["src.ui.game3.daycare_menu"];
  if (Menu == null) throw new Error("module 'src.ui.game3.daycare_menu' not found");
  return Menu;
}

// pokefirered/src/daycare.c:86 sDaycareLevelMenuWindowTemplate
const LEVEL_MENU_LAYOUT = {
  maxShowed: 3, count: 3, left: 12, top: 1, width: 17, keepOpen: false,
};

const BY_NAME: Record<string, Handler> = {
  // Lua: natives_daycare.lua:142
  // pokefirered/src/daycare.c:1227 GetDaycareState
  GetDaycareState: (ctx) => {
    const dc = Daycare.stateOf();
    let state = DAYCARE_NO_MONS;
    if (truthy(dc)) {
      if (eggPending(dc)) {
        state = DAYCARE_EGG_WAITING;
      } else {
        const n = Daycare.count(dc);
        // pokefirered/src/daycare.c:1236
        if (n > 0) state = n + 1;
      }
    }
    setResult(ctx, state);
    return [false, state];
  },
  // Lua: natives_daycare.lua:158
  // pokefirered/src/daycare.c:1575
  IsThereMonInRoute5Daycare: (_ctx) => {
    const r5 = Daycare.route5Of();
    return boolReturn(speciesOf(r5 && r5.mon) !== SPECIES_NONE);
  },
  // Lua: natives_daycare.lua:163
  // pokefirered/src/daycare.c:1244
  GetDaycarePokemonCount: () => {
    return [false, Daycare.count(Daycare.stateOf())];
  },
  // Lua: natives_daycare.lua:167
  // pokefirered/src/daycare.c:1555 ChooseSendDaycareMon
  ChooseSendDaycareMon: (ctx, adapters) => {
    return [Natives.choosePartyMon(ctx, adapters, PARTY_MENU_TYPE_DAYCARE)];
  },
  // Lua: natives_daycare.lua:172
  // pokefirered/src/daycare.c:455 StoreSelectedPokemonInDaycare
  StoreSelectedPokemonInDaycare: (ctx) => {
    const session = sessionOf();
    if (!truthy(session)) return [false];
    const selected = varGet(ctx, VAR_0x8004);
    if (selected >= PARTY_SIZE) return [false];
    Model.deposit(session, selected + 1);
    return [false];
  },
  // Lua: natives_daycare.lua:181
  // pokefirered/src/daycare.c:1563 PutMonInRoute5Daycare
  PutMonInRoute5Daycare: (ctx) => {
    const session = sessionOf();
    if (!truthy(session)) return [false];
    const selected = varGet(ctx, VAR_0x8004);
    if (selected >= PARTY_SIZE) return [false];
    Model.depositRoute5(session, selected + 1);
    return [false];
  },
  // Lua: natives_daycare.lua:190
  // pokefirered/src/daycare.c:546 TakePokemonFromDaycare
  TakePokemonFromDaycare: (ctx, adapters) => {
    const session = sessionOf();
    // data/maps/FourIsland_PokemonDayCare/scripts.inc:86-88
    if (partyIsFull(session)) {
      setResult(ctx, SPECIES_NONE);
      return [false, SPECIES_NONE];
    }
    const dc = Daycare.stateOf(session);
    const index = varGet(ctx, VAR_0x8004) + 1;
    const mon = slotMon(dc, index);
    if (!truthy(mon)) {
      setResult(ctx, SPECIES_NONE);
      return [false, SPECIES_NONE];
    }
    setStringVar(ctx, adapters, 1, nicknameOf(mon));
    return [false, Model.take(session, index)];
  },
  // Lua: natives_daycare.lua:208
  // pokefirered/src/daycare.c:1588 TakePokemonFromRoute5Daycare
  TakePokemonFromRoute5Daycare: (ctx, adapters) => {
    const session = sessionOf();
    // data/scripts/day_care.inc:79-81
    if (partyIsFull(session)) {
      setResult(ctx, SPECIES_NONE);
      return [false, SPECIES_NONE];
    }
    const r5 = Daycare.route5Of(session);
    const mon = r5 && r5.mon;
    if (!truthy(mon)) {
      setResult(ctx, SPECIES_NONE);
      return [false, SPECIES_NONE];
    }
    setStringVar(ctx, adapters, 1, nicknameOf(mon));
    return [false, Model.takeRoute5(session)];
  },
  // Lua: natives_daycare.lua:225
  // pokefirered/src/daycare.c:594 GetDaycareCost
  GetDaycareCost: (ctx, adapters) => {
    const dc = Daycare.stateOf();
    const index = varGet(ctx, VAR_0x8004) + 1;
    const mon = slotMon(dc, index);
    setStringVar(ctx, adapters, 1, nicknameOf(mon));
    const cost = truthy(mon) ? lor(Daycare.cost(mon, dc.steps[index]), 0) : 0;
    varSet(ctx, VAR_0x8005, cost);
    setStringVar(ctx, adapters, 2, tostring(cost));
    return [false];
  },
  // Lua: natives_daycare.lua:236
  // pokefirered/src/daycare.c:1569 GetCostToWithdrawRoute5DaycareMon
  GetCostToWithdrawRoute5DaycareMon: (ctx, adapters) => {
    const r5 = Daycare.route5Of();
    const mon = r5 && r5.mon;
    setStringVar(ctx, adapters, 1, nicknameOf(mon));
    const cost = truthy(mon) ? lor(Daycare.cost(mon, r5.steps), 0) : 0;
    varSet(ctx, VAR_0x8005, cost);
    setStringVar(ctx, adapters, 2, tostring(cost));
    return [false];
  },
  // Lua: natives_daycare.lua:246
  // pokefirered/src/daycare.c:606 GetNumLevelsGainedFromDaycare
  GetNumLevelsGainedFromDaycare: (ctx, adapters) => {
    const dc = Daycare.stateOf();
    const index = varGet(ctx, VAR_0x8004) + 1;
    const mon = slotMon(dc, index);
    if (!truthy(mon)) return [false, 0];
    const gained = Daycare.levelsGained(mon, dc.steps[index]);
    setStringVar(ctx, adapters, 1, nicknameOf(mon));
    setStringVar(ctx, adapters, 2, tostring(gained));
    return [false, gained];
  },
  // Lua: natives_daycare.lua:257
  // pokefirered/src/daycare.c:1583 GetNumLevelsGainedForRoute5DaycareMon
  GetNumLevelsGainedForRoute5DaycareMon: (ctx, adapters) => {
    const r5 = Daycare.route5Of();
    const mon = r5 && r5.mon;
    if (!truthy(mon)) return [false, 0];
    const gained = Daycare.levelsGained(mon, r5.steps);
    setStringVar(ctx, adapters, 1, nicknameOf(mon));
    setStringVar(ctx, adapters, 2, tostring(gained));
    return [false, gained];
  },
  // Lua: natives_daycare.lua:267
  // pokefirered/src/daycare.c:1200 _GetDaycareMonNicknames
  GetDaycareMonNicknames: (ctx, adapters) => {
    const dc = Daycare.stateOf();
    const first = slotMon(dc, 1);
    if (truthy(first)) {
      setStringVar(ctx, adapters, 1, nicknameOf(first));
      setStringVar(ctx, adapters, 3, tostring(lor(lor(first.otName, first.ot), "")));
    }
    const second = slotMon(dc, 2);
    if (truthy(second)) setStringVar(ctx, adapters, 2, nicknameOf(second));
    return [false];
  },
  // Lua: natives_daycare.lua:279
  // pokefirered/src/daycare.c:1338 SetDaycareCompatibilityString
  SetDaycareCompatibilityString: (ctx, adapters) => {
    const text = Daycare.compatibilityText(Daycare.compatibility(Daycare.stateOf()));
    setStringVar(ctx, adapters, 4, text);
    return [false];
  },
  // Lua: natives_daycare.lua:285
  // pokefirered/src/daycare.c:1531 ShowDaycareLevelMenu
  ShowDaycareLevelMenu: (ctx) => {
    const Menu = levelMenu();
    let done = false;
    Natives.awaitState(ctx, () => done);
    const shown = Menu.show(Daycare.stateOf(), (value: any) => {
      // pokefirered/src/daycare.c:1504 Task_HandleDaycareLevelMenuInput
      if (value === 0 || value === 1) {
        setResult(ctx, value);
      } else {
        setResult(ctx, DAYCARE_EXITED_LEVEL_MENU);
      }
      done = true;
    });
    if (!truthy(shown)) {
      setResult(ctx, DAYCARE_EXITED_LEVEL_MENU);
      done = true;
    }
    return [false];
  },
  // Lua: natives_daycare.lua:306
  // pokefirered/src/daycare.c:982 RejectEggFromDayCare
  RejectEggFromDayCare: () => {
    Breeding.removeEgg(Daycare.stateOf());
    return [false];
  },
  // Lua: natives_daycare.lua:311
  // pokefirered/src/daycare.c:1133 GiveEggFromDaycare
  GiveEggFromDaycare: () => {
    const dc = Daycare.stateOf();
    if (!eggPending(dc)) return [false];
    const session = sessionOf();
    // pokefirered/data/maps/FourIsland/scripts.inc:96
    if (partyIsFull(session)) return [false];
    Breeding.giveEggFromDaycare(session);
    return [false];
  },
  // Lua: natives_daycare.lua:321
  // pokeemerald/src/daycare.c:329 GetDaycareCostAndPrepareString
  GetDaycareCostAndPrepareString: (ctx, adapters) => {
    const dc = Daycare.stateOf();
    const index = varGet(ctx, VAR_0x8004) + 1;
    const mon = slotMon(dc, index);
    setStringVar(ctx, adapters, 1, nicknameOf(mon));
    const cost = truthy(mon) ? lor(Daycare.cost(mon, dc.steps[index]), 0) : 0;
    setStringVar(ctx, adapters, 2, tostring(cost));
    varSet(ctx, VAR_0x8005, cost);
    return [false];
  },
  // Lua: natives_daycare.lua:332
  // pokeemerald/src/egg_hatch.c:400 _CheckDaycareMonReceivedMail
  CheckDaycareMonReceivedMail: (ctx, adapters) => {
    const session = sessionOf();
    const dc = Daycare.stateOf(session);
    const index = varGet(ctx, VAR_0x8004) + 1;
    const mon = slotMon(dc, index);
    const mail = truthy(dc) && truthy(dc.mail) ? dc.mail[index] : undefined;
    if (!(truthy(mon) && mail != null && typeof mail === "object" && !Mail.isEmpty(mail.message))) return boolReturn(false);
    const nick = nicknameOf(mon);
    const player = tostring(lor(session && lor(session.name, session.playerName), ""));
    if (nick !== mail.monName || player !== mail.otName) {
      setStringVar(ctx, adapters, 1, nick);
      setStringVar(ctx, adapters, 2, mail.otName);
      setStringVar(ctx, adapters, 3, mail.monName);
      return boolReturn(true);
    }
    return boolReturn(false);
  },
};

export const Daycare = {
  SAVE_KEY: Model.SAVE_KEY,
  stateOf: Model.stateOf,
  route5Of: Model.route5Of,
  count: Model.count,
  levelAfterSteps: Model.levelAfterSteps,
  levelsGained: Model.levelsGained,
  cost: Model.cost,
  applyExperience: Model.applyExperience,
  teachMove: Model.teachMove,
  withdraw: Model.withdraw,
  step: Model.step,

  // pokefirered/src/daycare.c:1271 GetDaycareCompatibilityScore
  compatibility: Breeding.compatibility,

  // Lua: natives_daycare.lua:98
  // pokefirered/src/strings.c:1252 sCompatibilityMessages
  compatibilityText(score: any): string {
    if (score === PARENTS_INCOMPATIBLE) {
      return RomText.plain("gDaycareText_PlayOther");
    }
    if (score === PARENTS_LOW_COMPATIBILITY) {
      return RomText.plain("gDaycareText_DontLikeOther");
    }
    if (score === PARENTS_MED_COMPATIBILITY) {
      return RomText.plain("gDaycareText_GetAlong");
    }
    return RomText.plain("gDaycareText_GetAlongVeryWell");
  },

  LEVEL_MENU_LAYOUT,

  // Lua: natives_daycare.lua:123
  // pokefirered/src/daycare.c:1486 DaycarePrintMonInfo
  levelMenuRows(dc: any): LuaTable {
    const Menu = levelMenu();
    const rows: LuaTable = seq();
    for (const [i, row] of ipairs<any>(Menu.rows(dc))) {
      rows[i] = {
        text: row.text,
        symbol: row.symbol,
        // pokefirered/src/daycare.c:1482
        tailRight: Menu.LEVEL_RIGHT,
        tail: row.level,
        textX: Menu.TEXT_X,
        value: row.value,
      };
    }
    return rows;
  },

  BY_NAME,
  /** Set by Std.legacyHandlers (stdscripts.lua:262): special id -> handler. */
  HANDLERS: undefined as Record<number, Handler> | undefined,

  DAYCARE_NO_MONS,
  DAYCARE_EGG_WAITING,
  DAYCARE_EXITED_LEVEL_MENU,
  DAYCARE_LEVEL_MENU_EXIT,
  PARENTS_INCOMPATIBLE,
  PARENTS_LOW_COMPATIBILITY,
  PARENTS_MED_COMPATIBILITY,
  PARENTS_MAX_COMPATIBILITY,
};
// Lua: natives_daycare.lua:351
Std.legacyHandlers(Daycare);

export default Daycare;
