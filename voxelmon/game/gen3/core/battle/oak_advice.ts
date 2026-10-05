// Port of gen1recomp src/core/game3/battle/oak_advice.lua (GPLv3 + additional terms; see LICENSE.md).
// pokefirered/src/battle_controller_oak_old_man.c:626
//
// Port notes:
// - Oak.TEXT entries are lt.ts sequences; partyMenu's `field = true` is a
//   property on that array.
// - The lazy require of battle.ui is a static import (ui.ts is a
//   presentation stub until it is ported).
// - The `(.-)\\p` page split uses lpattern's gmatch.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tonumber, tostring, truthy, mod as lmod } from "../../../../import/gen3/lua.ts";
import { seq, len, ipairs, type LuaTable } from "../../platform/lt.ts";
import { gmatch } from "../../platform/lpattern.ts";
import RomText from "../rom_text.ts";
import BattleText from "./battle_text.ts";
import Ui from "./ui.ts";

export interface OakModule {
  FLAG_INFLICT_DMG: number;
  FLAG_STAT_CHG: number;
  FLAG_HP_RESTORE: number;
  FLAG_PARTY_MENU: number;
  TEXT: Record<string, LuaTable>;
  active(st: any): boolean;
  testFlag(st: any, mask: any): boolean;
  setFlag(st: any, mask: any): void;
  pending(st: any, mask: any): boolean;
  pages(st: any, key: string): LuaTable | undefined;
  screens(pages: LuaTable | null | undefined): LuaTable;
  take(st: any, mask: any, key: string): LuaTable | undefined;
  say(st: any, key: string, sayFn?: ((text: string, key?: string) => void) | null): boolean;
  sayOnce(st: any, mask: any, key: string, sayFn?: ((text: string, key?: string) => void) | null): boolean;
}

export const Oak = {} as OakModule;

// pokefirered/include/battle_controllers.h:287
Oak.FLAG_INFLICT_DMG = 1;
Oak.FLAG_STAT_CHG = 2;
Oak.FLAG_HP_RESTORE = 4;
Oak.FLAG_PARTY_MENU = 8;

// pokefirered/src/battle_message.c:507
Oak.TEXT = {
  forPetesSake: seq("gText_ForPetesSake", "gText_TheTrainerThat", "gText_TryBattling"),
  inflictingDamage: seq("gText_InflictingDamageIsKey"),
  loweringStats: seq("gText_LoweringStats"),
  keepAnEyeOnHp: seq("gText_KeepAnEyeOnHP"),
  noRunning: seq("gText_OakNoRunningFromATrainer"),
  winEarnsPrize: seq("gText_WinEarnsPrizeMoney"),
  howDisappointing: seq("gText_HowDissapointing"),
  // pokefirered/src/strings.c:345
  partyMenu: Object.assign(seq("gText_OakImportantToGetToKnowPokemonThroughly", "gText_OakThisIsListOfPokemon"), { field: true }),
};

// pokefirered/src/battle_setup.c:899
// Lua: oak_advice.lua:28
Oak.active = function (st: any): boolean {
  return (truthy(st) && truthy(st.firstBattle)) ? true : false;
};

// pokefirered/src/battle_controller_oak_old_man.c:2228
// Lua: oak_advice.lua:33
Oak.testFlag = function (st: any, mask: any): boolean {
  if (!truthy(st) || !truthy(mask) || mask <= 0) return false;
  return lmod(Math.floor((tonumber(st.oakMsgFlags) ?? 0) / mask), 2) === 1;
};

// Lua: oak_advice.lua:38
Oak.setFlag = function (st: any, mask: any): void {
  if (!truthy(st) || !truthy(mask) || mask <= 0) return;
  if (Oak.testFlag(st, mask)) return;
  st.oakMsgFlags = (tonumber(st.oakMsgFlags) ?? 0) + mask;
};

// Lua: oak_advice.lua:44
Oak.pending = function (st: any, mask: any): boolean {
  return Oak.active(st) && !Oak.testFlag(st, mask);
};

// Lua: oak_advice.lua:48
Oak.pages = function (st: any, key: string): LuaTable | undefined {
  const keys = Oak.TEXT[key];
  if (keys == null) return undefined;
  const name = st.playerName;
  const out: LuaTable = seq();
  for (let i = 1; i <= len(keys); i++) {
    if (truthy(keys.field)) {
      out[i] = RomText.ascii(keys[i], { playerName: name });
    } else {
      out[i] = BattleText.get(keys[i], { playerName: name });
    }
  }
  return out;
};

// Lua: oak_advice.lua:63
Oak.screens = function (pages: LuaTable | null | undefined): LuaTable {
  const out: LuaTable = seq();
  for (const [, page] of ipairs(pages ?? seq())) {
    for (const [part] of gmatch(tostring(page) + "\\p", "(.-)\\p")) {
      if (part !== "") out[len(out) + 1] = part;
    }
  }
  return out;
};

// pokefirered/src/party_menu.c:5832
// Lua: oak_advice.lua:74
Oak.take = function (st: any, mask: any, key: string): LuaTable | undefined {
  if (!Oak.pending(st, mask)) return undefined;
  Oak.setFlag(st, mask);
  const pages = Oak.pages(st, key);
  if (!truthy(pages) || len(pages) === 0) return undefined;
  return Oak.screens(pages);
};

// Lua: oak_advice.lua:82
Oak.say = function (st: any, key: string, sayFnIn?: ((text: string, key?: string) => void) | null): boolean {
  if (!Oak.active(st)) return false;
  const pages = Oak.pages(st, key);
  if (!truthy(pages) || len(pages) === 0) return false;
  // require("src.core.game3.battle.ui")
  let sayFn = sayFnIn;
  if (!truthy(sayFn)) sayFn = (t: string) => { Ui.push(t); };
  const keys = Oak.TEXT[key];
  for (const [i, p] of ipairs<string>(pages)) {
    // pokefirered/src/battle_bg.c:359
    if (truthy(Ui.markVoiceover)) Ui.markVoiceover(p);
    sayFn!(p, keys[i]);
  }
  return true;
};

// Lua: oak_advice.lua:97
Oak.sayOnce = function (st: any, mask: any, key: string, sayFn?: ((text: string, key?: string) => void) | null): boolean {
  if (!Oak.pending(st, mask)) return false;
  Oak.setFlag(st, mask);
  return Oak.say(st, key, sayFn);
};

export default Oak;
