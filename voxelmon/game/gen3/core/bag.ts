// Port of gen1recomp src/core/game3/bag.lua (GPLv3 + additional terms; see LICENSE.md).
// game3 bag: pret ItemSlot pockets (AddBagItem / CheckBagHasSpace).
// Qty ≤ 999. Caps: ITEMS 42, KEY 30, BALLS 13, TMHM 58, BERRIES 43.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { Items } from "./items.ts";
import { ItemsData } from "./items_data.ts";
import { Profile } from "./profile.ts";
import { Constants } from "./constants.ts";
import { Space } from "./scripting/space.ts";
import { Flags } from "./scripting/flags.ts";
import { Bag as BagHost } from "../shared/inventory/Bag.ts";
import { insert, ipairs, len, pairs, remove, seq, sort } from "../platform/lt.ts";
import { mod, tonumber, tostring, truthy } from "../../../import/gen3/lua.ts";
import { find } from "../platform/lpattern.ts";

/** One pret ItemSlot: `{ id = ..., qty = ... }`. */
export interface BagSlot { id: any; qty: any }
/** A pocket: a Lua sequence of slots (`[null, slot, ...]`). */
export type Slots = (BagSlot | null)[];
export interface GameBag {
  pockets: Record<string, Slots>;
  /** Legacy mirror rebuilt on mutate for old UI / ferry code paths. */
  stacks: Record<string, number>;
  [k: string]: any;
}
export interface BagRow { id: any; qty: number; name: string; info: any; description: string }

const isTable = (v: unknown): v is Record<string | number, any> => v !== null && typeof v === "object";

const POCKET_KEYS: string[] = [
  "ITEMS", "KEY_ITEMS", "POKE_BALLS", "TM_CASE", "BERRY_POUCH",
];

// Lua: bag.lua:13
function empty_pockets(): Record<string, Slots> {
  const p: Record<string, Slots> = {};
  for (const k of POCKET_KEYS) {
    p[k] = seq();
  }
  return p;
}

// Lua: bag.lua:29
function slot_id_eq(a: any, b: any): boolean {
  if (a == null || b == null) return false;
  const na = ItemsData.toNumericId(a), nb = ItemsData.toNumericId(b);
  if (na !== undefined && nb !== undefined) return na === nb;
  return ItemsData.bagKey(a) === ItemsData.bagKey(b);
}

// Lua: bag.lua:36
function find_slot(slots: Slots | null | undefined, id: any): [number | null, BagSlot | null] {
  if (!slots) return [null, null];
  for (const [i, slot] of ipairs<BagSlot>(slots)) {
    if (slot_id_eq(slot.id, id)) {
      return [i, slot];
    }
  }
  return [null, null];
}

// Lua: bag.lua:46
function compact(slots: any): Slots {
  const out: Slots = seq();
  if (!isTable(slots)) return out;
  for (const [, slot] of ipairs<BagSlot>(slots)) {
    if (truthy(slot.id) && (tonumber(slot.qty) ?? 0) > 0) {
      out[len(out) + 1] = { id: slot.id, qty: tonumber(slot.qty) ?? 0 };
    }
  }
  return out;
}

// Lua: bag.lua:57
function sort_tm_pocket(slots: Slots): void {
  // pret SortPocketAndPlaceHMsFirst: HMs first, then TMs, stable-ish by id.
  sort<BagSlot>(slots, (a, b) => {
    const ah = ItemsData.isHm(a.id), bh = ItemsData.isHm(b.id);
    if (ah !== bh) return truthy(ah);
    const na = ItemsData.toNumericId(a.id) ?? 0;
    const nb = ItemsData.toNumericId(b.id) ?? 0;
    return na < nb;
  });
}

// Lua: bag.lua:69
// pokeemerald/src/item.c:615
function sort_by_id(slots: Slots): void {
  const n = len(slots);
  for (let i = 1; i <= n - 1; i++) {
    for (let j = i + 1; j <= n; j++) {
      const a = ItemsData.toNumericId((slots[i] as BagSlot).id) ?? 0;
      const b = ItemsData.toNumericId((slots[j] as BagSlot).id) ?? 0;
      if (a > b) { const t = slots[i]; slots[i] = slots[j]; slots[j] = t; }
    }
  }
}

// Lua: bag.lua:79
function sort_pocket(pocket: string, slots: Slots): void {
  const model = ItemsData.BAG_MODEL;
  if (truthy(model.sortHmsFirst[pocket])) {
    sort_tm_pocket(slots);
  } else if (truthy(model.sortById[pocket])) {
    sort_by_id(slots);
  }
}

// Lua: bag.lua:88
function grant_key(bag: GameBag, itemId: any): boolean {
  const keySlots = bag.pockets.KEY_ITEMS;
  if (!keySlots) return false;
  for (const [, slot] of ipairs<BagSlot>(keySlots)) {
    if (slot_id_eq(slot.id, itemId)) return true;
  }
  const cap = ItemsData.CAPACITY.KEY_ITEMS ?? 30;
  if (len(keySlots) >= cap) return false;
  keySlots[len(keySlots) + 1] = { id: itemId, qty: 1 };
  return true;
}

// Lua: bag.lua:100
function sanitize_pockets(bag: GameBag | null | undefined): void {
  if (!bag || !isTable(bag.pockets)) return;
  const misplaced: any[] = seq();
  for (const k of POCKET_KEYS) {
    const slots = bag.pockets[k] ?? seq();
    const keep: Slots = seq();
    for (const [, slot] of ipairs<BagSlot>(slots)) {
      const correctPocket = ItemsData.pocketOf(slot.id);
      // pokefirered/src/item.c:92
      if (ItemsData.toNumericId(slot.id) !== 0) {
        if (correctPocket !== k) {
          misplaced[len(misplaced) + 1] = { id: slot.id, qty: tonumber(slot.qty) ?? 1, target: correctPocket };
        } else {
          keep[len(keep) + 1] = slot;
        }
      }
    }
    bag.pockets[k] = compact(keep);
  }

  for (const [, m] of ipairs(misplaced)) {
    const targetSlots = bag.pockets[m.target] ?? seq();
    const cap = ItemsData.CAPACITY[m.target] ?? 42;
    const [, slot] = find_slot(targetSlots, m.id);
    const qty = Items.clampGame3(m.qty);
    if (slot) {
      slot.qty = Items.clampGame3((tonumber(slot.qty) ?? 0) + qty);
    } else if (qty > 0 && len(targetSlots) < cap) {
      targetSlots[len(targetSlots) + 1] = { id: m.id, qty };
    }
    bag.pockets[m.target] = compact(targetSlots);
  }

  if (bag.pockets.TM_CASE && len(bag.pockets.TM_CASE) > 0) {
    sort_pocket("TM_CASE", bag.pockets.TM_CASE);
    const c = ItemsData.CONTAINERS.TM_CASE;
    if (c) grant_key(bag, c.item);
  }
  if (bag.pockets.BERRY_POUCH && len(bag.pockets.BERRY_POUCH) > 0) {
    sort_pocket("BERRY_POUCH", bag.pockets.BERRY_POUCH);
    const c = ItemsData.CONTAINERS.BERRY_POUCH;
    if (c) grant_key(bag, c.item);
  }
}

// Lua: bag.lua:145
function capped(pocket: string): boolean {
  return ItemsData.slotMax(pocket) < Items.GAME3_MAX_QTY
    || ItemsData.BAG_MODEL.splitSlots[pocket] === true;
}

// Lua: bag.lua:150
function pocket_total(slots: Slots | null | undefined, id: any): number {
  let n = 0;
  for (const [, slot] of ipairs<BagSlot>(slots ?? seq())) {
    if (slot_id_eq(slot.id, id)) n = n + (tonumber(slot.qty) ?? 0);
  }
  return n;
}

// Lua: bag.lua:159
// pokeemerald/src/item.c:174
function capped_can_add(slots: Slots, pocket: string, id: any, count: number): boolean {
  const slotCap = ItemsData.slotMax(pocket);
  const split = ItemsData.BAG_MODEL.splitSlots[pocket] === true;
  for (const [, slot] of ipairs<BagSlot>(slots)) {
    if (slot_id_eq(slot.id, id)) {
      const owned = tonumber(slot.qty) ?? 0;
      if (owned + count <= slotCap) return true;
      if (!split) return false;
      count = count - (slotCap - owned);
      if (count === 0) break;
    }
  }
  if (count > 0) {
    const empty = (ItemsData.CAPACITY[pocket] ?? 0) - len(slots);
    for (let _ = 1; _ <= empty; _++) {
      if (count > slotCap) {
        if (!split) return false;
        count = count - slotCap;
      } else {
        count = 0;
        break;
      }
    }
    if (count > 0) return false;
  }
  return true;
}

// Lua: bag.lua:188
// pokeemerald/src/item.c:238
function capped_add(bag: GameBag, pocket: string, id: any, count: number): [boolean, number] {
  const slotCap = ItemsData.slotMax(pocket);
  const split = ItemsData.BAG_MODEL.splitSlots[pocket] === true;
  const cap = ItemsData.CAPACITY[pocket] ?? 0;
  const slots: Slots = seq();
  for (const [i, slot] of ipairs<BagSlot>(bag.pockets[pocket] ?? seq())) {
    slots[i] = { id: slot.id, qty: tonumber(slot.qty) ?? 0 };
  }
  let left = count;
  for (const [, slot] of ipairs<BagSlot>(slots)) {
    if (slot_id_eq(slot.id, id)) {
      if (slot.qty + left <= slotCap) {
        slot.qty = slot.qty + left;
        left = 0;
        break;
      }
      if (!split) return [false, 0];
      left = left - (slotCap - slot.qty);
      slot.qty = slotCap;
      if (left === 0) break;
    }
  }
  while (left > 0) {
    if (len(slots) >= cap) return [false, 0];
    if (left > slotCap) {
      if (!split) return [false, 0];
      slots[len(slots) + 1] = { id, qty: slotCap };
      left = left - slotCap;
    } else {
      slots[len(slots) + 1] = { id, qty: left };
      left = 0;
    }
  }
  sort_pocket(pocket, slots);
  bag.pockets[pocket] = slots;
  return [true, count];
}

// Lua: bag.lua:227
// pokeemerald/src/item.c:345
function capped_remove(bag: GameBag, pocket: string, id: any, count: number): boolean {
  const slots = bag.pockets[pocket] ?? seq();
  if (pocket_total(slots, id) < count) return false;
  for (const [, slot] of ipairs<BagSlot>(slots)) {
    if (count === 0) break;
    if (slot_id_eq(slot.id, id)) {
      const owned = tonumber(slot.qty) ?? 0;
      if (owned >= count) {
        slot.qty = owned - count;
        count = 0;
      } else {
        count = count - owned;
        slot.qty = 0;
      }
    }
  }
  bag.pockets[pocket] = compact(slots);
  return true;
}

// Lua: bag.lua:247
function rebuild_stacks(bag: GameBag): void {
  bag.stacks = {};
  for (const k of POCKET_KEYS) {
    for (const [, slot] of ipairs<BagSlot>(bag.pockets[k] ?? seq())) {
      const id = slot.id;
      const qty = tonumber(slot.qty) ?? 0;
      if (truthy(id) && qty > 0) {
        const key = ItemsData.bagKey(id);
        bag.stacks[key] = (bag.stacks[key] ?? 0) + qty;
        // Also mirror host string if known
        const num = ItemsData.toNumericId(id);
        if (num !== undefined && Items.FRLG_TO_HOST[num]) {
          bag.stacks[Items.FRLG_TO_HOST[num]] = bag.stacks[key];
        }
      }
    }
  }
}

// Lua: bag.lua:266
function ensure(bag: any): GameBag {
  if (!truthy(bag)) return bag;
  if (!isTable(bag.pockets)) {
    Bag.migrate(bag);
  }
  for (const k of POCKET_KEYS) {
    bag.pockets[k] = bag.pockets[k] ?? seq();
  }
  sanitize_pockets(bag);
  bag.stacks = bag.stacks ?? {};
  return bag;
}

// Lua: bag.lua:342
// pokeemerald/src/item.c:136
function pyramidBag(_bag: any): [any, any] {
  // NOT FAITHFUL: Emerald only. Brian reads
  // package.loaded["src.core.game3.rse.frontier.pyramid"], which FRLG never
  // loads (rse/ is not ported), so this is always nil here.
  return [null, null];
}

const FLAG_SYS_GOT_BERRY_POUCH = 0x847; // include/constants/flags.h:1405

// Lua: bag.lua:406
function mark_container(flagName: string): void {
  // package.loaded["src.core.game3.scripting.space"]: the stub's store is nil.
  const store = isTable(Space) && Space.store;
  if (truthy(store)) {
    const game = Profile.active().id;
    const id = Constants.of(game).require("flags", flagName);
    Flags.setFlag(store, null, id, true);
  }
}

// listPocket rows per bag and pocket, rebuilt only when the pocket's
// (id, qty) slots or the loaded item pack change.  Bag menus call listPocket
// every frame; each row costs three ItemsData.info lookups.
interface RowEntry { byId: any; n: number; ids: any[]; qtys: any[]; rows: (BagRow | null)[] }
const rowCache = new WeakMap<object, Record<string, RowEntry>>();

// Lua: bag.lua:525
function rows_match(entry: RowEntry, slots: Slots, byId: any): boolean {
  if (entry.byId !== byId) return false;
  const ids = entry.ids, qtys = entry.qtys, n = entry.n;
  for (let i = 1; i <= n; i++) {
    const slot = slots[i];
    if (slot == null || slot.id !== ids[i] || slot.qty !== qtys[i]) return false;
  }
  return slots[n + 1] == null;
}

/** pokefirered/src/coins.c */
const Coins = {
  MAX_COINS: 9999,

  // Lua: bag.lua:652
  // pokefirered/src/coins.c:11
  get(session: any): number {
    if (!isTable(session)) return 0;
    const n = Math.floor(tonumber(session.coins) ?? 0);
    if (n < 0) return 0;
    if (n > Bag.MAX_COINS) return Bag.MAX_COINS;
    return n;
  },

  // Lua: bag.lua:661
  // pokefirered/src/coins.c:16
  set(session: any, amount: any): number {
    if (!isTable(session)) return 0;
    let n = Math.floor(tonumber(amount) ?? 0);
    if (n < 0) n = 0;
    if (n > Bag.MAX_COINS) n = Bag.MAX_COINS;
    session.coins = n;
    return n;
  },

  // Lua: bag.lua:671
  // pokefirered/src/coins.c:21
  add(session: any, toAdd: any): boolean {
    if (!isTable(session)) return false;
    let coins = Coins.get(session);
    if (coins >= Bag.MAX_COINS) return false;
    let n = Math.floor(tonumber(toAdd) ?? 0);
    if (n < 0) n = 0;
    const sum = mod(coins + n, 65536);
    if (sum >= coins) {
      coins = (sum > Bag.MAX_COINS) ? Bag.MAX_COINS : sum;
    } else {
      coins = Bag.MAX_COINS;
    }
    Coins.set(session, coins);
    return true;
  },

  // Lua: bag.lua:688
  // pokefirered/src/coins.c:41
  remove(session: any, toSub: any): boolean {
    if (!isTable(session)) return false;
    const coins = Coins.get(session);
    let n = Math.floor(tonumber(toSub) ?? 0);
    if (n < 0) n = 0;
    if (coins >= n) {
      Coins.set(session, coins - n);
      return true;
    }
    return false;
  },
};

export const Bag = {
  // Lua: bag.lua:21
  new(): GameBag {
    return {
      pockets: empty_pockets(),
      // Legacy mirror rebuilt on mutate for old UI / ferry code paths.
      stacks: {},
    };
  },

  // Lua: bag.lua:280
  /** Migrate legacy { stacks } or schema { items=… } into pockets. */
  migrate(bag: any): GameBag {
    if (!truthy(bag)) return Bag.new();
    if (isTable(bag.pockets) && truthy(bag.pockets.ITEMS)) {
      ensure(bag);
      rebuild_stacks(bag);
      return bag;
    }

    const fresh = Bag.new();
    const absorb = (id: any, qty: any): void => {
      const q = tonumber(qty) ?? 0;
      if (q > 0 && id != null) {
        Bag.add(fresh, id, q);
      }
    };

    if (isTable(bag.stacks)) {
      for (const [id, qty] of pairs(bag.stacks)) {
        absorb(id, qty);
      }
    }

    // Schema newGame shape
    // (pairs order: Lua's is unspecified; this is insertion order.)
    const map: Record<string, string> = {
      items: "ITEMS",
      keyItems: "KEY_ITEMS",
      pokeballs: "POKE_BALLS",
      berries: "BERRY_POUCH",
      tmsHms: "TM_CASE",
    };
    for (const [field] of pairs(map)) {
      const list = bag[field];
      if (isTable(list)) {
        for (const [, entry] of ipairs(list)) {
          if (isTable(entry)) {
            absorb(entry.id ?? entry.itemId ?? entry[1], entry.qty ?? entry.quantity ?? entry[2] ?? 1);
          } else if (truthy(entry)) {
            absorb(entry, 1);
          }
        }
        // also allow map form
        for (const [id, qty] of pairs(list)) {
          if (typeof id !== "number" || !isTable(qty)) {
            if (typeof qty === "number") absorb(id, qty);
          }
        }
      }
    }

    bag.pockets = fresh.pockets;
    bag.stacks = fresh.stacks;
    // Drop legacy pocket table fields from schema shape if present
    return bag;
  },

  // Lua: bag.lua:335
  clear(bag: any): void {
    bag = ensure(bag);
    bag.pockets = empty_pockets();
    bag.stacks = {};
  },

  // Lua: bag.lua:351
  get(bag: any, id: any): number {
    const [Py, ps] = pyramidBag(bag);
    if (Py) return Py.bagCount(ps, id);
    bag = ensure(bag);
    if (!truthy(bag) || id == null) return 0;
    const pocket = ItemsData.pocketOf(id);
    const slots: Slots = bag.pockets[pocket] ?? seq();
    if (capped(pocket)) {
      const total = pocket_total(slots, id);
      if (total > 0) return total;
    }
    const [, slot] = find_slot(slots, id);
    if (slot) return tonumber(slot.qty) ?? 0;
    // stacks fallback
    return bag.stacks[ItemsData.bagKey(id)]
      ?? bag.stacks[tostring(id)]
      ?? 0;
  },

  // Lua: bag.lua:370
  has(bag: any, id: any, qty?: any): boolean {
    const q = Math.max(1, Math.floor(tonumber(qty) ?? 1));
    return Bag.get(bag, id) >= q;
  },

  // Lua: bag.lua:375
  canAdd(bag: any, id: any, qty?: any): boolean {
    const [Py, ps] = pyramidBag(bag);
    if (Py) return Py.bagHasSpace(ps, id, qty ?? 1);
    bag = ensure(bag);
    const q = Math.max(1, Math.floor(tonumber(qty) ?? 1));
    // pokefirered/src/item.c:92
    if (!truthy(id) || ItemsData.toNumericId(id) === 0) return false;
    const pocket = ItemsData.pocketOf(id);
    const cap = ItemsData.CAPACITY[pocket] ?? 42;
    const slots: Slots = bag.pockets[pocket] ?? seq();
    if (capped(pocket)) return capped_can_add(slots, pocket, id, q);
    const [, slot] = find_slot(slots, id);
    if (slot) {
      const have = tonumber(slot.qty) ?? 0;
      return (have + q) <= Items.GAME3_MAX_QTY;
    }
    // Need empty slot; TM Case / Berry Pouch auto-grant may need KEY slot too
    if (len(slots) >= cap) return false;
    const c = ItemsData.CONTAINERS[pocket];
    if (c && !Bag.has(bag, c.item, 1)) {
      const keySlots: Slots = bag.pockets.KEY_ITEMS ?? seq();
      if (len(keySlots) >= (ItemsData.CAPACITY.KEY_ITEMS ?? 30) && find_slot(keySlots, c.item)[0] == null) {
        return false;
      }
    }
    return true;
  },

  FLAG_SYS_GOT_BERRY_POUCH,

  // Lua: bag.lua:418
  add(bag: any, id: any, qty?: any): [boolean, number] {
    const [Py, ps] = pyramidBag(bag);
    if (Py) {
      const ok = Py.bagAdd(ps, id, qty ?? 1);
      return [ok, truthy(ok) ? (qty ?? 1) : 0];
    }
    bag = ensure(bag);
    const q = Math.max(0, Math.floor(tonumber(qty) ?? 1));
    if (q <= 0 || !truthy(id) || ItemsData.toNumericId(id) === 0) return [false, 0];

    // Prefer numeric FRLG id in slots
    const num = ItemsData.toNumericId(id);
    const storeId = num ?? id;

    if (!Bag.canAdd(bag, storeId, q)) {
      return [false, 0];
    }

    const pocket = ItemsData.pocketOf(storeId);

    const container = ItemsData.CONTAINERS[pocket];
    if (container && !Bag.has(bag, container.item, 1)) {
      if (!grant_key(bag, container.item)) {
        return [false, 0];
      }
    }
    // src/item.c:242
    for (const [cPocket, c] of pairs(ItemsData.CONTAINERS)) {
      if (truthy(c.flag) && (pocket === cPocket || num === c.item || storeId === c.item)) {
        mark_container(c.flag as string);
      }
    }

    if (capped(pocket)) {
      const [ok, placed] = capped_add(bag, pocket, storeId, q);
      if (ok) rebuild_stacks(bag);
      return [ok, placed];
    }

    const slots: Slots = bag.pockets[pocket];
    const [, slot] = find_slot(slots, storeId);
    if (slot) {
      const have = tonumber(slot.qty) ?? 0;
      const nextQty = Items.clampGame3(have + q);
      const placed = nextQty - have;
      slot.qty = nextQty;
      rebuild_stacks(bag);
      return [placed === q, placed];
    }

    const placed = Items.clampGame3(q);
    slots[len(slots) + 1] = { id: storeId, qty: placed };
    sort_pocket(pocket, slots);
    rebuild_stacks(bag);
    return [placed === q, placed];
  },

  // Lua: bag.lua:475
  remove(bag: any, id: any, qty?: any): boolean {
    const [Py, ps] = pyramidBag(bag);
    if (Py) return Py.bagRemove(ps, id, qty ?? 1);
    bag = ensure(bag);
    const q = Math.max(1, Math.floor(tonumber(qty) ?? 1));
    if (!truthy(id)) return false;
    const num = ItemsData.toNumericId(id);
    const storeId = num ?? id;
    const pocket = ItemsData.pocketOf(storeId);
    if (capped(pocket)) {
      const ok = capped_remove(bag, pocket, storeId, q);
      if (ok) rebuild_stacks(bag);
      return ok;
    }
    const slots: Slots = bag.pockets[pocket];
    const [idx, slot] = find_slot(slots, storeId);
    if (!slot) return false;
    const have = tonumber(slot.qty) ?? 0;
    if (have < q) return false;
    slot.qty = have - q;
    if (slot.qty <= 0) {
      remove(slots, idx as number);
    }
    bag.pockets[pocket] = compact(slots);
    sort_pocket(pocket, bag.pockets[pocket]);
    rebuild_stacks(bag);
    return true;
  },

  // Lua: bag.lua:505
  set(bag: any, id: any, qty: any): number {
    const q = Items.clampGame3(qty);
    const have = Bag.get(bag, id);
    if (q <= 0) {
      if (have > 0) Bag.remove(bag, id, have);
      return 0;
    }
    if (have > q) {
      Bag.remove(bag, id, have - q);
    } else if (have < q) {
      Bag.add(bag, id, q - have);
    }
    return Bag.get(bag, id);
  },

  // Lua: bag.lua:538
  /**
   * Ordered list of { id, qty, name, info } for a pocket (bag UI).
   * The returned rows are shared between calls until the pocket changes, so
   * callers must not modify them.
   */
  listPocket(bag: any, pocket?: string): (BagRow | null)[] {
    bag = ensure(bag);
    pocket = pocket ?? "ITEMS";
    const slots: Slots = bag.pockets[pocket] ?? seq();
    let byId = ItemsData._byId;
    let perBag = rowCache.get(bag);
    const entry = perBag && perBag[pocket];
    if (entry && byId && rows_match(entry, slots, byId)) return entry.rows;
    const rows: (BagRow | null)[] = seq();
    for (const [, slot] of ipairs<BagSlot>(slots)) {
      const qty = tonumber(slot.qty) ?? 0;
      if (truthy(slot.id) && qty > 0) {
        rows[len(rows) + 1] = {
          id: slot.id,
          qty,
          name: ItemsData.displayName(slot.id),
          info: ItemsData.info(slot.id),
          description: ItemsData.description(slot.id),
        };
      }
    }
    byId = ItemsData._byId;
    if (byId) {
      let n = 0;
      const ids: any[] = seq(), qtys: any[] = seq();
      for (const [i, slot] of ipairs<BagSlot>(slots)) {
        n = i;
        ids[i] = slot.id; qtys[i] = slot.qty;
      }
      if (!perBag) {
        perBag = {};
        rowCache.set(bag, perBag);
      }
      perBag[pocket] = { byId, n, ids, qtys, rows };
    }
    return rows;
  },

  // Lua: bag.lua:576
  mergeFromHost(bag: any, hostInventory: any): void {
    bag = ensure(bag);
    if (!isTable(hostInventory)) return;
    for (const [id, qty] of pairs(hostInventory)) {
      if (typeof id === "string" && find(id, "BADGE", 1, true) == null) {
        const n = tonumber(qty) ?? 0;
        if (n > 0) {
          const num = ItemsData.toNumericId(id);
          if (num !== undefined || Items.isHostSafe(id)) {
            Bag.add(bag, num ?? id, n);
          }
        }
      }
    }
  },

  // Lua: bag.lua:592
  restoreSidecar(bag: any, sidecar: any): void {
    bag = ensure(bag);
    if (!isTable(sidecar)) return;
    const absorb = (tbl: any): void => {
      if (!isTable(tbl)) return;
      for (const [id, qty] of pairs(tbl)) {
        const n = tonumber(qty) ?? 0;
        if (n > 0) Bag.add(bag, id, n);
      }
    };
    absorb(sidecar.quarantine);
    absorb(sidecar.overflow);
    absorb(sidecar.bag);
    if (isTable(sidecar.stacks)) absorb(sidecar.stacks);
  },

  // Lua: bag.lua:608
  splitForHost(bag: any, hostInventory?: any): [Record<string, number>, Record<string, number>, Record<string, number>] {
    hostInventory = hostInventory ?? {};
    const hostWrites: Record<string, number> = {}, quarantine: Record<string, number> = {}, overflow: Record<string, number> = {};
    bag = ensure(bag);
    if (!truthy(bag)) return [hostWrites, quarantine, overflow];
    // Iterate pockets once (avoid double-count from stacks numeric+host mirrors).
    for (const pocket of POCKET_KEYS) {
      for (const [, slot] of ipairs<BagSlot>(bag.pockets[pocket] ?? seq())) {
        const qty = Items.clampGame3(slot.qty);
        if (truthy(slot.id) && qty > 0) {
          const num = ItemsData.toNumericId(slot.id);
          const hostId: string | undefined = (num !== undefined ? Items.FRLG_TO_HOST[num] : undefined)
            || (typeof slot.id === "string" && tonumber(slot.id) === undefined ? slot.id : undefined)
            || undefined;
          if (!hostId) {
            const qkey = num !== undefined ? ("FRLG_" + tostring(num)) : tostring(slot.id);
            quarantine[qkey] = (quarantine[qkey] ?? 0) + qty;
          } else if (!Items.isHostSafe(hostId)) {
            quarantine[hostId] = (quarantine[hostId] ?? 0) + qty;
          } else {
            const room = Items.HOST_MAX_QTY;
            const placed = Math.min(qty, room);
            if (placed > 0) {
              hostWrites[hostId] = (hostWrites[hostId] ?? 0) + placed;
            }
            const rem = qty - placed;
            if (rem > 0) {
              overflow[hostId] = (overflow[hostId] ?? 0) + rem;
            }
          }
        }
      }
    }
    return [hostWrites, quarantine, overflow];
  },

  MAX_COINS: 9999, // pokefirered/include/constants/coins.h:4

  Coins,

  // Lua: bag.lua:700
  applyHostWrites(save: any, hostWrites: Record<string, any>): void {
    if (!truthy(save)) return;
    save.inventory = save.inventory ?? {};
    for (const [id, qty0] of pairs(hostWrites)) {
      const qty = Math.min(Items.HOST_MAX_QTY, Math.floor(tonumber(qty0) ?? 0));
      if (qty <= 0) {
        if (truthy(BagHost.remove)) {
          const have = save.inventory[id] ?? 0;
          if (have > 0) BagHost.remove(save, id as any, have);
        } else {
          delete save.inventory[id];
        }
      } else {
        save.inventory[id] = qty;
        if (truthy(BagHost.order)) {
          const order = BagHost.order(save);
          let found = false;
          for (const [, oid] of ipairs(order)) {
            if (oid === id) { found = true; break; }
          }
          if (!found) insert(order, id);
        }
      }
    }
  },
};

export default Bag;
