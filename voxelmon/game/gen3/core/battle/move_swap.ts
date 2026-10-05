// Port of gen1recomp src/core/game3/battle/move_swap.lua (GPLv3 + additional terms; see LICENSE.md).
// Battle move-menu SELECT reordering (pret battle_controller_player.c).
//
// Port notes:
// - rawget(proxy, "moves" / "pp"): State.ensureBattleMoves' proxy always
//   holds its own moves / pp tables (never nil), so a plain read returns the
//   raw field, as rawget does.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { truthy } from "../../../../import/gen3/lua.ts";
import { seq, ipairs } from "../../platform/lt.ts";
import Pokemon from "../pokemon.ts";
import State from "./state.ts";

export interface MoveSwapModule {
  moveCount(mon: any): number;
  canStart(st: any, battler: any): boolean;
  initialCursor(current: number): number;
  step(cursor: number, dir: string, n: number): number;
  apply(battler: any, slotA: number, slotB: number): boolean;
}

export const MoveSwap = {} as MoveSwapModule;

// Lua: move_swap.lua:3
function filled(mv: any): boolean {
  return mv != null && mv !== 0 && mv !== "";
}

// Lua: move_swap.lua:7
MoveSwap.moveCount = function (mon: any): number {
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    if (!filled(truthy(mon) && truthy(mon.moves) ? mon.moves[i] : undefined)) break;
    n = n + 1;
  }
  return n;
};

// pokeemerald/src/battle_controller_player.c:601
// Lua: move_swap.lua:17
MoveSwap.canStart = function (st: any, battler: any): boolean {
  if (!truthy(st) || truthy(st.link) || !truthy(battler) || !truthy(battler.mon)) return false;
  return MoveSwap.moveCount(battler.mon) > 1;
};

// pokeemerald/src/battle_controller_player.c:604
// Lua: move_swap.lua:23
MoveSwap.initialCursor = function (current: number): number {
  if (current !== 0) return 0;
  return current + 1;
};

// pokeemerald/src/battle_controller_player.c:795
// Lua: move_swap.lua:29
MoveSwap.step = function (cursor: number, dir: string, n: number): number {
  if (dir === "left") {
    if (cursor % 2 === 1) return cursor - 1;
  } else if (dir === "right") {
    if (cursor % 2 === 0 && cursor + 1 < n) return cursor + 1;
  } else if (dir === "up") {
    if (cursor >= 2) return cursor - 2;
  } else if (dir === "down") {
    if (cursor < 2 && cursor + 2 < n) return cursor + 2;
  }
  return cursor;
};

// Lua: move_swap.lua:42
function swap_field(t: any, a: number, b: number): void {
  if (t !== null && typeof t === "object") { const x = t[a]; t[a] = t[b]; t[b] = x; }
}

const SLOT_KEYS = seq("expLockedSlot", "expEncoreSlot");

// pokeemerald/src/battle_controller_player.c:676
// Lua: move_swap.lua:47
MoveSwap.apply = function (battler: any, slotA: number, slotB: number): boolean {
  if (!truthy(battler) || !truthy(battler.mon) || slotA === slotB) return false;
  const party = State.partyMon(battler);
  if (truthy(battler._partyMon)) {
    const proxy = battler.mon;
    swap_field(proxy.moves, slotA, slotB);
    swap_field(proxy.pp, slotA, slotB);
    swap_field(battler.permanentSlots, slotA, slotB);
    swap_field(battler.sketched, slotA, slotB);
    if (!truthy(battler.transformed) && truthy(party)) {
      Pokemon.swapMoves(party, slotA, slotB);
    }
  } else {
    Pokemon.swapMoves(truthy(party) ? party : battler.mon, slotA, slotB);
  }
  for (const [, key] of ipairs<string>(SLOT_KEYS)) {
    if (battler[key] === slotA) {
      battler[key] = slotB;
    } else if (battler[key] === slotB) {
      battler[key] = slotA;
    }
  }
  return true;
};

export default MoveSwap;
