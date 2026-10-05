// Port of gen1recomp src/core/game3/battle/ai_items.lua (GPLv3 + additional terms; see LICENSE.md).
// FireRed battle AI trainer item use (port of battle_ai_switch_items.c ShouldUseItem).
//
// Port notes:
// - `pcall(require, "src.core.game3.items_data")` always succeeds here
//   (core/items_data.ts is linked in).
// - band() keeps Brian's loop (it stops at the first non-positive operand).
// - AiItems.effect returns a sequence e[1..6] with an `hp` field, as in Lua.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { mod, tonumber, tostring, truthy } from "../../../../import/gen3/lua.ts";
import { len, type LuaTable } from "../../platform/lt.ts";
import State from "./state.ts";
import ItemsData from "../items_data.ts";

type Tbl = LuaTable;

/** The AI's per-battle memory (st._aiHistory). */
export interface AiHistory {
  items: Tbl;
  itemsNo: number;
  usedMoves?: Record<number, Tbl>;
  abilities?: Record<number, number>;
  itemEffects?: Record<number, number>;
  [k: string]: any;
}

/** An item decision for the engine. */
export interface AiItemUse {
  item: number;
  aiItemType: number;
  aiItemFlags: number;
}

export interface AiItemsModule {
  TYPE: {
    FULL_RESTORE: number; HEAL_HP: number; CURE_CONDITION: number; X_STAT: number;
    GUARD_SPECS: number; NOT_RECOGNIZABLE: number;
  };
  ITEM_FULL_RESTORE: number;
  HEAL_HP_FULL: number;
  HEAL_HP_HALF: number;
  HEAL_HP_LVL_UP: number;
  band(a: unknown, b: unknown): number;
  itemNum(item: unknown): number;
  effect(item: unknown): Tbl | null;
  itemType(item: unknown, e: Tbl): number;
  hpParam(e: Tbl): number;
  history(st: any): AiHistory;
  statusName(b: any): string | null;
  shouldUseItem(st: any, id: number): AiItemUse | null;
}

export const AiItems = {} as AiItemsModule;

AiItems.TYPE = {
  FULL_RESTORE: 1, HEAL_HP: 2, CURE_CONDITION: 3, X_STAT: 4, GUARD_SPECS: 5, NOT_RECOGNIZABLE: 6,
};
const T = AiItems.TYPE;

AiItems.ITEM_FULL_RESTORE = 19;
AiItems.HEAL_HP_FULL = 0xFF;
AiItems.HEAL_HP_HALF = 0xFE;
AiItems.HEAL_HP_LVL_UP = 0xFD;

// Lua: ai_items.lua:17
function band(aIn: unknown, bIn: unknown): number {
  let a = Math.floor(tonumber(aIn) ?? 0), b = Math.floor(tonumber(bIn) ?? 0);
  let r = 0, bit = 1;
  while (a > 0 && b > 0) {
    if (mod(a, 2) === 1 && mod(b, 2) === 1) r = r + bit;
    a = Math.floor(a / 2); b = Math.floor(b / 2); bit = bit * 2;
  }
  return r;
}
AiItems.band = band;

// Lua: ai_items.lua:28
function item_num(item: unknown): number {
  const n = tonumber(item);
  if (n != null) return n;
  if (item == null || item === "") return 0;
  // Lua: pcall(require, "src.core.game3.items_data") -- always loads here
  if (truthy(ItemsData.toNumericId)) return ItemsData.toNumericId(item) ?? 0;
  return 0;
}
AiItems.itemNum = item_num;

// Lua: ai_items.lua:39
// src/pokemon.c:4843 GetItemEffectParamOffset
function param_offset(e: Tbl, effectByte: number, effectBit: number): number {
  let offset = 6;
  for (let i = 0; i <= 5; i++) {
    if (i <= 3) {
      if (i === effectByte) return 0;
    } else if (i === 4) {
      let val = tonumber(e[5]) ?? 0;
      if (band(val, 0x20) !== 0) val = val - 0x20;
      let j = 0;
      while (val > 0) {
        if (mod(val, 2) === 1) {
          if (j === 2 && band(val, 0x10) !== 0) val = val - 0x10;
          if (j === 0 || j === 1 || j === 2 || j === 3) {
            if (i === effectByte && band(val, effectBit) !== 0) return offset;
            offset = offset + 1;
          } else if (j === 7) {
            if (i === effectByte) return 0;
          }
        }
        j = j + 1;
        val = Math.floor(val / 2);
        if (i === effectByte) effectBit = Math.floor(effectBit / 2);
      }
    } else {
      let val = tonumber(e[6]) ?? 0;
      let j = 0;
      while (val > 0) {
        if (mod(val, 2) === 1) {
          if (j <= 6) {
            if (i === effectByte && band(val, effectBit) !== 0) return offset;
            offset = offset + 1;
          } else if (i === effectByte) {
            return 0;
          }
        }
        j = j + 1;
        val = Math.floor(val / 2);
        if (i === effectByte) effectBit = Math.floor(effectBit / 2);
      }
    }
  }
  return offset;
}

// Lua: ai_items.lua:83
AiItems.effect = function (item: unknown): Tbl | null {
  // Lua: pcall(require, "src.core.game3.items_data") -- always loads here
  const info = ItemsData.info(item_num(item)) ?? null;
  const e = info ? info.effect : null;
  if (e == null || typeof e !== "object" || len(e) < 6) return null;
  const off = band(e[5], 0x04) !== 0 ? param_offset(e, 4, 0x04) : 0;
  const out: Tbl = [null, tonumber(e[1]) ?? 0, tonumber(e[2]) ?? 0, tonumber(e[3]) ?? 0, tonumber(e[4]) ?? 0,
    tonumber(e[5]) ?? 0, tonumber(e[6]) ?? 0];
  out.hp = off !== 0 ? (tonumber(e[off + 1]) ?? null) : null;
  return out;
};

// Lua: ai_items.lua:94
// src/battle_ai_switch_items.c:546
AiItems.itemType = function (item: unknown, e: Tbl): number {
  if (item_num(item) === AiItems.ITEM_FULL_RESTORE) return T.FULL_RESTORE;
  if (band(e[5], 0x04) !== 0) return T.HEAL_HP;
  if (band(e[4], 0x3F) !== 0) return T.CURE_CONDITION;
  if (band(e[1], 0x3F) !== 0 || e[2] !== 0 || e[3] !== 0) return T.X_STAT;
  if (band(e[4], 0x80) !== 0) return T.GUARD_SPECS;
  return T.NOT_RECOGNIZABLE;
};

// Lua: ai_items.lua:104
// src/pokemon.c:4843
AiItems.hpParam = function (e: Tbl): number {
  if (band(e[5], 0x04) === 0) return 0;
  return e.hp ?? 0;
};

// Lua: ai_items.lua:110
// src/battle_ai_script_commands.c:262
AiItems.history = function (st: any): AiHistory {
  if (truthy(st._aiHistory)) return st._aiHistory;
  const h: AiHistory = { items: [], itemsNo: 0 };
  if (truthy(st) && !truthy(st.wild) && !truthy(st.safari)) {
    for (let i = 1; i <= 4; i++) {
      const it = item_num(truthy(st.trainerItems) ? st.trainerItems[i] : st.trainerItems);
      if (it !== 0) {
        h.itemsNo = h.itemsNo + 1;
        h.items[h.itemsNo] = it;
      }
    }
  }
  for (let i = h.itemsNo + 1; i <= 4; i++) h.items[i] = 0;
  st._aiHistory = h;
  return h;
};

// Lua: ai_items.lua:127
function status_name(b: any): string | null {
  let s = truthy(b) ? (truthy(b.status) ? b.status : (truthy(b.mon) ? b.mon.status : b.mon)) : b;
  if (!truthy(s) || s === 0) return null;
  s = tostring(s).toUpperCase();
  if (s === "SLEEP") return "SLP";
  if (s === "POISON") return "PSN";
  if (s === "TOXIC") return "TOX";
  if (s === "BURN") return "BRN";
  if (s === "FREEZE") return "FRZ";
  if (s === "PARALYSIS") return "PAR";
  return s;
}
AiItems.statusName = status_name;

// Lua: ai_items.lua:141
function mon_valid(mon: any): boolean {
  if (!truthy(mon) || truthy(mon.isEgg)) return false;
  const sp = truthy(mon.species) ? mon.species : truthy(mon.speciesId) ? mon.speciesId : mon.id;
  return (tonumber(mon.hp) ?? 0) !== 0 && sp != null && sp !== 0;
}

// Lua: ai_items.lua:148
// src/battle_ai_switch_items.c:562
AiItems.shouldUseItem = function (st: any, id: number): AiItemUse | null {
  const b = State.battler(st, id);
  if (!truthy(b) || !truthy(b.mon)) return null;
  const h = AiItems.history(st);
  let validMons = 0;
  for (let i = 1; i <= 6; i++) {
    if (mon_valid(truthy(st.foeParty) ? st.foeParty[i] : st.foeParty)) validMons = validMons + 1;
  }
  const hp = tonumber(b.mon.hp) ?? 0;
  const maxHp = tonumber(b.mon.maxHp) ?? 0;
  for (let i = 0; i <= 3; i++) {
    if (!(i > 0 && validMons > (h.itemsNo - i) + 1)) {
      const item = h.items[i + 1] ?? 0;
      const e = item !== 0 ? AiItems.effect(item) : null;
      if (truthy(e)) {
        const kind = AiItems.itemType(item, e);
        st.aiItemType = st.aiItemType ?? {};
        st.aiItemType[id] = kind;
        let flags = 0;
        let shouldUse = false;
        if (kind === T.FULL_RESTORE) {
          if (hp < Math.floor(maxHp / 4) && hp !== 0) shouldUse = true;
        } else if (kind === T.HEAL_HP) {
          const param = AiItems.hpParam(e);
          if (param !== 0 && hp !== 0) {
            if (hp < Math.floor(maxHp / 4) || maxHp - hp > param) shouldUse = true;
          }
        } else if (kind === T.CURE_CONDITION) {
          const s = status_name(b);
          if (band(e[4], 0x20) !== 0 && s === "SLP") { flags = flags + 0x20; shouldUse = true; }
          if (band(e[4], 0x10) !== 0 && (s === "PSN" || s === "TOX")) { flags = flags + 0x10; shouldUse = true; }
          if (band(e[4], 0x08) !== 0 && s === "BRN") { flags = flags + 0x08; shouldUse = true; }
          if (band(e[4], 0x04) !== 0 && s === "FRZ") { flags = flags + 0x04; shouldUse = true; }
          if (band(e[4], 0x02) !== 0 && s === "PAR") { flags = flags + 0x02; shouldUse = true; }
          if (band(e[4], 0x01) !== 0 && (tonumber(b.confusionTurns) ?? 0) > 0) { flags = flags + 0x01; shouldUse = true; }
        } else if (kind === T.X_STAT) {
          if ((tonumber(b.isFirstTurn) ?? 0) !== 0) {
            if (band(e[1], 0x0F) !== 0) flags = flags + 0x01;
            if (band(e[2], 0xF0) !== 0) flags = flags + 0x02;
            if (band(e[2], 0x0F) !== 0) flags = flags + 0x04;
            if (band(e[3], 0x0F) !== 0) flags = flags + 0x08;
            if (band(e[3], 0xF0) !== 0) flags = flags + 0x20;
            if (band(e[1], 0x30) !== 0) flags = flags + 0x80;
            shouldUse = true;
          }
        } else if (kind === T.GUARD_SPECS) {
          // Lua `(b.side == "player") and st.playerSide or st.enemySide`
          const side = (b.side === "player" && truthy(st.playerSide)) ? st.playerSide : st.enemySide;
          if ((tonumber(b.isFirstTurn) ?? 0) !== 0 && (tonumber(truthy(side) ? side.expMistTurns : side) ?? 0) === 0) {
            shouldUse = true;
          }
        } else {
          return null;
        }
        if (shouldUse) {
          st.aiItemFlags = st.aiItemFlags ?? {};
          st.aiItemFlags[id] = flags;
          h.items[i + 1] = 0;
          return { item: item, aiItemType: kind, aiItemFlags: flags };
        }
      }
    }
  }
  return null;
};

export default AiItems;
