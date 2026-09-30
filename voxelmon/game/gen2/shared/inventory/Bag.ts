// gen1recomp src/inventory/Bag.lua at bdfac727 (MIT): Gen 2's four pockets
// (item_data_constants.asm): Items 20, Balls 12, Key Items 25, TM/HM 57. A
// distinct item id takes one slot of ITS OWN pocket regardless of quantity.
// Badges live in the inventory table but are not bag items. save.bagOrder
// keeps acquisition order like wBagItems (a JS array).
//
// Where the Lua falls back to `require("src.core.Data")` (Gen 1's singleton,
// which a Gold boot never loads -- Game2.lua:1161), there is nothing to fall
// back to here: an omitted `data` is an empty dataset, which is what that
// unloaded singleton answers with.

type ItemDef = { pocket?: string; index?: number; itemId?: number; [k: string]: unknown };
type BagData = { items?: Record<string, ItemDef>; constants?: { bagSize?: unknown }; [k: string]: unknown } | null | undefined;
type BagSave = { inventory?: Record<string, number>; bagOrder?: string[]; [k: string]: unknown } | null | undefined;

const EMPTY_DATA: BagData = {};

// Lua: Bag.lua:16-22
const POCKET_CAPACITY: Record<string, number> = {
  ITEM: 20,
  BALL: 12,
  KEY_ITEM: 25,
  TM_HM: 57,
};
const DEFAULT_CAPACITY = 20;

// Lua: Bag.lua:24-27
function isBadge(id: unknown): boolean {
  if (typeof id !== "string") return false;
  return id.includes("BADGE");
}

// Lua: Bag.lua:31-35 -- unknown ids fall to ITEM, the Gen 1 behaviour.
function pocketOf(id: string, data?: BagData): string {
  data = data ?? EMPTY_DATA;
  const def = data && data.items && data.items[id];
  return (def && def.pocket) || "ITEM";
}

// Lua: Bag.lua:84-93 -- the ordering of Bag.order's rebuild (index, then id).
function orderKey(items: Record<string, ItemDef> | undefined, id: string): number {
  const def = items && items[id];
  const v = def ? def.index ?? def.itemId : undefined;
  return v ?? Infinity;
}

export const Bag = {
  pocketOf,

  // Lua: Bag.lua:43-53 -- a pocket argument gives that pocket's cap.
  capacity(data?: BagData, pocket?: string): number {
    data = data ?? EMPTY_DATA;
    if (pocket && pocket !== "ITEM") {
      return POCKET_CAPACITY[pocket] ?? DEFAULT_CAPACITY;
    }
    const configured = data && data.constants && data.constants.bagSize;
    if (typeof configured === "number" && configured >= 1) {
      return Math.floor(configured);
    }
    return POCKET_CAPACITY.ITEM!;
  },

  // Lua: Bag.lua:57
  isBadge,

  // Lua: Bag.lua:60-70 -- occupied slots, of one pocket or of everything.
  slots(save: BagSave, data?: BagData, pocket?: string): number {
    if (!save || !save.inventory) return 0;
    let n = 0;
    for (const id of Object.keys(save.inventory)) {
      if (!isBadge(id) && (!pocket || pocketOf(id, data) === pocket)) n += 1;
    }
    return n;
  },

  // Lua: Bag.lua:74-111 -- acquisition-ordered id list (wBagItems).
  order(save: BagSave, data?: BagData): string[] {
    if (!save) return [];
    save.inventory = save.inventory || {};
    let order = save.bagOrder;
    if (!order) {
      const items = (data ?? EMPTY_DATA)!.items;
      order = [];
      for (const id of Object.keys(save.inventory)) {
        if (!isBadge(id)) order.push(id);
      }
      order.sort((a, b) => {
        const ia = orderKey(items, a);
        const ib = orderKey(items, b);
        if (ia !== ib) return ia < ib ? -1 : 1;
        return a < b ? -1 : a > b ? 1 : 0;
      });
      save.bagOrder = order;
    }
    // drop stale ids, append unknown ones
    const seen: Record<string, boolean> = {};
    for (let i = order.length - 1; i >= 0; i--) {
      const id = order[i]!;
      if (!save.inventory[id] || seen[id]) order.splice(i, 1);
      else seen[id] = true;
    }
    for (const id of Object.keys(save.inventory)) {
      if (!isBadge(id) && !seen[id]) order.push(id);
    }
    return order;
  },

  // Lua: Bag.lua:115-134 -- engine/items/switch_items.asm:38 SwitchItemsInBag,
  // over the rows of ONE pocket. `toIndex` is the Lua's 1-based row.
  move(save: BagSave, id: string, pocket: string, toIndex: unknown, data?: BagData): boolean {
    const order = Bag.order(save, data);
    const slots: number[] = [];
    const ids: string[] = [];
    for (let i = 0; i < order.length; i++) {
      if (pocketOf(order[i]!, data) === pocket) {
        slots.push(i);
        ids.push(order[i]!);
      }
    }
    let from: number | undefined;
    for (let i = 0; i < ids.length; i++) {
      if (ids[i] === id) {
        from = i + 1;
        break;
      }
    }
    if (from === undefined) return false;
    const n = typeof toIndex === "number" ? toIndex : Number(toIndex);
    const to = Math.max(1, Math.min(Math.floor(Number.isNaN(n) || toIndex == null ? from : n), ids.length));
    if (to === from) return false;
    const [moved] = ids.splice(from - 1, 1);
    ids.splice(to - 1, 0, moved!);
    for (let i = 0; i < slots.length; i++) order[slots[i]!] = ids[i]!;
    return true;
  },

  // Lua: Bag.lua:139-163 -- false (adding nothing) when a new slot is needed
  // and the item's own pocket is full, or when the stack would pass 99.
  add(save: BagSave, id: string, qty?: number, data?: BagData): boolean {
    if (!save) return false;
    save.inventory = save.inventory || {};
    const inv = save.inventory;
    const pocket = pocketOf(id, data);
    if (!inv[id] && !isBadge(id) && Bag.slots(save, data, pocket) >= Bag.capacity(data, pocket)) {
      return false;
    }
    if (!isBadge(id) && (inv[id] ?? 0) + (qty ?? 1) > 99) {
      return false;
    }
    // Insert into the order BEFORE the inventory write (Bag.lua:153-156).
    const isNew = !inv[id];
    if (isNew && !isBadge(id)) {
      Bag.order(save, data).push(id);
    }
    inv[id] = (inv[id] ?? 0) + (qty ?? 1);
    return true;
  },

  // Lua: Bag.lua:166-179 -- remove qty (default 1); clears the slot at zero.
  remove(save: BagSave, id: string, qty?: number): void {
    if (!save || !save.inventory) return;
    const inv = save.inventory;
    inv[id] = (inv[id] ?? 0) - (qty ?? 1);
    if (inv[id]! <= 0) {
      delete inv[id];
      const order = save.bagOrder;
      if (order) {
        const i = order.indexOf(id);
        if (i >= 0) order.splice(i, 1);
      }
    }
  },
};

export default Bag;
