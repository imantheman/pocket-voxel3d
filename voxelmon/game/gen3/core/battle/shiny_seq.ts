// Port of gen1recomp src/core/game3/battle/shiny_seq.lua (GPLv3 + additional terms; see LICENSE.md).
// Shiny sparkle on send-out / intro (Anim.launchShiny).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { truthy } from "../../../../import/gen3/lua.ts";
import { seq, len, ipairs, type LuaTable } from "../../platform/lt.ts";
import Anim from "./anim.ts";
import SummaryData from "../summary_data.ts";

export interface ShinySeqModule {
  isShiny(battler: any): boolean;
  startMany(battlers: LuaTable | null | undefined, keys: LuaTable | null | undefined, onDone?: any): boolean;
  start(battler: any, key: any, onDone?: any): boolean;
}

export const ShinySeq = {} as ShinySeqModule;

// Lua: shiny_seq.lua:6
ShinySeq.isShiny = function (battler: any): boolean {
  const mon = truthy(battler) ? battler.mon : undefined;
  return mon != null && SummaryData.isShiny(mon) === true;
};

// Lua: shiny_seq.lua:11
ShinySeq.startMany = function (battlers: LuaTable | null | undefined, keys: LuaTable | null | undefined, onDone?: any): boolean {
  const shinyKeys: LuaTable = [null];
  for (const [i, battler] of ipairs<any>(battlers ?? [null])) {
    if (ShinySeq.isShiny(battler)) {
      const k = truthy(keys) ? keys![i] : undefined;
      shinyKeys[len(shinyKeys) + 1] = truthy(k) ? k : i - 1;
    }
  }
  if (len(shinyKeys) === 0) return false;
  Anim.launchShiny(shinyKeys[1], { keys: shinyKeys, onEnd: onDone });
  return true;
};

// Lua: shiny_seq.lua:23
ShinySeq.start = function (battler: any, key: any, onDone?: any): boolean {
  return ShinySeq.startMany(seq(battler), seq(key), onDone);
};

export default ShinySeq;
