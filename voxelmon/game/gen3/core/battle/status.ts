// Port of gen1recomp src/core/game3/battle/status.lua (GPLv3 + additional terms; see LICENSE.md).
// Status inflict + EOT chip (owned; KR left this to host engines).
//
// Port notes:
// - Adapter colon calls (`adapter:maxHp(b)`) are method calls on the adapter.
// - tickChip returns a sequence (lt.ts shape) of whatever sayText returned.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tostring, truthy } from "../../../../import/gen3/lua.ts";
import { len, seq, type LuaTable } from "../../platform/lt.ts";

export interface StatusModule {
  set(battler: any, status: any): void;
  clear(battler: any): void;
  tickChip(battler: any, adapter: any): LuaTable;
}

// Lua: status.lua:5
function status_of(battler: any): any {
  // battler and (battler.status or (battler.mon and battler.mon.status))
  let s: any = battler;
  if (truthy(battler)) {
    s = battler.status;
    if (!truthy(s)) s = truthy(battler.mon) ? battler.mon.status : battler.mon;
  }
  if (s === 0) return null;
  return s;
}

export const Status = {} as StatusModule;

// Lua: status.lua:11
Status.set = function (battler: any, status: any): void {
  if (!truthy(battler)) return;
  battler.status = status;
  if (truthy(battler.mon)) battler.mon.status = status;
};

// Lua: status.lua:17
Status.clear = function (battler: any): void {
  Status.set(battler, null);
};

/** End-of-turn burn / poison / toxic chip. Returns list of message strings. */
// Lua: status.lua:23 -- pokefirered/src/battle_util.c:805
Status.tickChip = function (battler: any, adapter: any): LuaTable {
  const msgs: LuaTable = seq();
  if (!truthy(battler) || truthy(adapter.isFainted(battler))) return msgs;
  let st: any = status_of(battler);
  if (!truthy(st)) return msgs;
  st = tostring(st).toUpperCase();
  const maxHp: number = adapter.maxHp(battler);
  let loss: number;
  let id: string, anim: string;
  if (st === "PSN" || st === "POISON") {
    loss = Math.floor(maxHp / 8);
    id = "STRINGID_PKMNHURTBYPOISON"; anim = "POISON";
  } else if (st === "TOX" || st === "TOXIC") {
    // pokefirered/src/battle_util.c:823
    loss = Math.floor(maxHp / 16);
    if (loss === 0) loss = 1;
    let c: number = battler.toxicCounter ?? 0;
    if (c < 15) c = c + 1;
    battler.toxicCounter = c;
    loss = loss * c;
    id = "STRINGID_PKMNHURTBYPOISON"; anim = "POISON";
  } else if (st === "BRN" || st === "BURN") {
    loss = Math.floor(maxHp / 8);
    id = "STRINGID_PKMNHURTBYBURN"; anim = "BURN";
  } else {
    return msgs;
  }
  if (loss === 0) loss = 1;
  // data/battle_scripts_1.s:3676
  msgs[len(msgs) + 1] = adapter.sayText(id, { atk: battler });
  if (truthy(adapter.playAnim)) adapter.playAnim("status", anim, battler, battler);
  adapter.applyHpLoss(battler, loss);
  return msgs;
};

export default Status;
