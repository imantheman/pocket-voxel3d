// gen1recomp src/core/gen2/PcItems.lua at bdfac727 (MIT): the PC item list's
// display order (../pokecrystal/engine/events/pokecenter_pc.asm:568,
// engine/items/switch_items.asm:1).
//
// save.pcItems is item id -> count; save.pcOrder is the list of ids in the
// order the PC shows them. `move`'s toIndex is 1-based, as the Lua passes it.

import { insertAt, removeAt, tonumber } from "../platform/lua.ts";

type SaveLike = Record<string, any>;
/** The item table (data.items): id -> { index, ... }. */
type ItemsLike = Record<string, { index?: number; [k: string]: unknown } | undefined> | null | undefined;

// Lua: PcItems.lua:6-9
function indexOf(items: ItemsLike, id: string): number {
  const def = items && items[id];
  return (def && def.index) ?? Infinity;
}

// Lua: PcItems.lua:11-17 -- by item index, then by id.
function byIndex(items: ItemsLike): (a: string, b: string) => number {
  return (a, b) => {
    const ia = indexOf(items, a);
    const ib = indexOf(items, b);
    if (ia !== ib) return ia < ib ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  };
}

export const PcItems = {
  /**
   * Lua: PcItems.lua:19 -- save.pcOrder, created (sorted by item index) on
   * demand, with dropped/duplicate ids removed and new ids appended sorted.
   */
  order(save: SaveLike, items?: ItemsLike): string[] {
    save.pcItems = save.pcItems || {};
    let order = save.pcOrder;
    if (order === null || typeof order !== "object") {
      order = Object.keys(save.pcItems);
      order.sort(byIndex(items));
      save.pcOrder = order;
    }
    const seen: Record<string, boolean> = {};
    for (let i = order.length; i >= 1; i--) {
      const id = order[i - 1];
      if (save.pcItems[id] == null || seen[id]) {
        removeAt(order, i);
      } else {
        seen[id] = true;
      }
    }
    const added: string[] = [];
    for (const id of Object.keys(save.pcItems)) {
      if (!seen[id]) added.push(id);
    }
    added.sort(byIndex(items));
    for (const id of added) order.push(id);
    return order;
  },

  /** Lua: PcItems.lua:47 -- engine/items/switch_items.asm:38, :64. */
  move(save: SaveLike, id: string, toIndex: unknown, items?: ItemsLike): boolean {
    const order = PcItems.order(save, items);
    let from: number | undefined;
    for (let i = 1; i <= order.length; i++) {
      if (order[i - 1] === id) {
        from = i;
        break;
      }
    }
    if (from === undefined) return false;
    const to = Math.max(1, Math.min(Math.floor(tonumber(toIndex) ?? from), order.length));
    // engine/items/switch_items.asm:33
    if (to === from) return false;
    insertAt(order, to, removeAt(order, from)!);
    return true;
  },
};

export default PcItems;
