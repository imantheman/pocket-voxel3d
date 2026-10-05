// Port of gen1recomp src/inventory/Bag.lua (GPLv3 + additional terms; see LICENSE.md).
// The Gen 1/2 host bag over save.inventory (id -> qty) and save.bagOrder.
// The FireRed runtime reaches it from core/bag (applyHostWrites: remove,
// order) and scripting/adapters (add, remove) when there is no session bag.
//
// NOT FAITHFUL: Brian's default `data` is the Gen 1/2 Data singleton
// (require "src.core.Data"), which this runtime does not have; with no
// `data` passed every id falls to the ITEM pocket and the default capacity,
// as Brian's does for an id Data does not know.

import { insert, ipairs, len, pairs, remove as tremove, sort } from "../../platform/lt.ts";
import { tonumber, tostring } from "../../../../import/gen3/lua.ts";

type Save = { inventory?: Record<string, number>; bagOrder?: (string | null)[] } & Record<string, any>;

// Lua: Bag.lua:16
const POCKET_CAPACITY: Record<string, number> = {
  ITEM: 20,
  BALL: 12,
  KEY_ITEM: 25,
  TM_HM: 57,
};
const DEFAULT_CAPACITY = 20;

// Lua: Bag.lua:24
function isBadge(id: unknown): boolean {
  if (typeof id !== "string") return false;
  return id.includes("BADGE");
}

// Lua: Bag.lua:31
function pocketOf(id: string, data?: any): string {
  const def = data && data.items && data.items[id];
  return (def && def.pocket) || "ITEM";
}

export const Bag = {
  pocketOf,
  isBadge,

  // Lua: Bag.lua:43
  capacity(data?: any, pocket?: string): number {
    if (pocket && pocket !== "ITEM") {
      return POCKET_CAPACITY[pocket] ?? DEFAULT_CAPACITY;
    }
    const configured = data && data.constants && data.constants.bagSize;
    if (typeof configured === "number" && configured >= 1) {
      return Math.floor(configured);
    }
    return POCKET_CAPACITY.ITEM!;
  },

  // Lua: Bag.lua:60
  slots(save: Save | undefined, data?: any, pocket?: string): number {
    if (!save || !save.inventory) return 0;
    let n = 0;
    for (const [id] of pairs(save.inventory)) {
      if (!isBadge(id) && (!pocket || pocketOf(id as string, data) === pocket)) {
        n = n + 1;
      }
    }
    return n;
  },

  // Lua: Bag.lua:74
  order(save: Save | undefined, data?: any): (string | null)[] {
    if (!save) return [null];
    save.inventory = save.inventory || {};
    let order = save.bagOrder;
    if (!order) {
      const items = data ? data.items : undefined;
      order = [null];
      for (const [id] of pairs(save.inventory)) {
        if (!isBadge(id)) insert(order, id);
      }
      const indexOf = (x: string): any =>
        (items && items[x] && (items[x].index ?? items[x].itemId)) ?? Infinity;
      sort<string>(order, (a, b) => {
        const ia = indexOf(a);
        const ib = indexOf(b);
        if (ia !== ib) {
          if (typeof ia === typeof ib) return ia < ib;
          return tostring(ia) < tostring(ib);
        }
        if (typeof a === typeof b) return a < b;
        return tostring(a) < tostring(b);
      });
      save.bagOrder = order;
    }
    const seen: Record<string, boolean> = {};
    for (let i = len(order); i >= 1; i--) {
      const id = order[i]!;
      if (!save.inventory[id] || seen[id]) {
        tremove(order, i);
      } else {
        seen[id] = true;
      }
    }
    for (const [id] of pairs(save.inventory)) {
      if (!isBadge(id) && !seen[id as string]) insert(order, id);
    }
    return order;
  },

  // Lua: Bag.lua:115
  move(save: Save, id: string, pocket: string, toIndex: unknown, data?: any): boolean {
    const order = Bag.order(save, data);
    const slots: (number | null)[] = [null], ids: (string | null)[] = [null];
    for (let i = 1; i <= len(order); i++) {
      if (pocketOf(order[i]!, data) === pocket) {
        slots[len(slots) + 1] = i;
        ids[len(ids) + 1] = order[i]!;
      }
    }
    let from: number | undefined;
    for (let i = 1; i <= len(ids); i++) {
      if (ids[i] === id) { from = i; break; }
    }
    if (!from) return false;
    const to = Math.max(1, Math.min(Math.floor(tonumber(toIndex) ?? from), len(ids)));
    if (to === from) return false;
    insert(ids, to, tremove(ids, from));
    for (let i = 1; i <= len(slots); i++) order[slots[i]!] = ids[i]!;
    return true;
  },

  // Lua: Bag.lua:139
  add(save: Save | undefined, id: string, qty?: number, data?: any): boolean {
    if (!save) return false;
    save.inventory = save.inventory || {};
    const inv = save.inventory;
    const pocket = pocketOf(id, data);
    if (!inv[id] && !isBadge(id)
      && Bag.slots(save, data, pocket) >= Bag.capacity(data, pocket)) {
      return false;
    }
    if (!isBadge(id) && (inv[id] ?? 0) + (qty ?? 1) > 99) {
      return false;
    }
    const isNew = !inv[id];
    if (isNew && !isBadge(id)) {
      insert(Bag.order(save, data), id);
    }
    inv[id] = (inv[id] ?? 0) + (qty ?? 1);
    return true;
  },

  // Lua: Bag.lua:166
  remove(save: Save | undefined, id: string, qty?: number): void {
    if (!save || !save.inventory) return;
    const inv = save.inventory;
    inv[id] = (inv[id] ?? 0) - (qty ?? 1);
    if (inv[id]! <= 0) {
      delete inv[id];
      const order = save.bagOrder;
      if (order) {
        for (const [i, oid] of ipairs<string>(order)) {
          if (oid === id) { tremove(order, i); break; }
        }
      }
    }
  },
};

export default Bag;
