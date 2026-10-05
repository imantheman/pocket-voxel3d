// Port of gen1recomp src/core/game3/storage.lua (GPLv3 + additional terms; see LICENSE.md).
// Gen 3 (FRLG) Pokémon Storage System & Player PC (pret pokemon_storage_system.c).
//
// 14 Boxes × 30 Slots = 420 Pokémon Capacity.
// Unique Item Slots in Player's PC: profile bag.pcItems (30 FRLG, 50 Emerald).
// Includes PC Heal Exploit, Circular Spillover, Sparse Serialization, and Bag-Full Guard.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { ItemsData } from "./items_data.ts";
import { Bag } from "./bag.ts";
import { Items } from "./items.ts";
import { Profile } from "./profile.ts";
import { Constants } from "./constants.ts";
import { Pokemon } from "./pokemon.ts";
import { R as QuestLogRecorder } from "./quest_log_recorder.ts";
import { RomText } from "./rom_text.ts";
import { Space } from "./scripting/space.ts";
import { Flags } from "./scripting/flags.ts";
import { Queries } from "./scripting/natives_queries.ts";
import { ipairs, len, pairs, remove, seq, sort } from "../platform/lt.ts";
import { format, mod, tonumber, tostring, truthy } from "../../../import/gen3/lua.ts";

/** One storage box: `mons` is a sparse sequence 1..30 (nil = empty). */
export interface StorageBox { name: string; wallpaper: number; mons: any[] }
export interface PcItem { id: any; qty: any }
export interface StorageData {
  currentBox: number;
  /** boxes[1..14] */
  boxes: (StorageBox | null)[];
  /** Player PC item storage, a sequence */
  items: (PcItem | null)[];
  [k: string]: any;
}

const isTable = (v: unknown): v is Record<string | number, any> => v !== null && typeof v === "object";
/** Lua `a or b`. */
const or = <A, B>(a: A, b: B): A | B => (truthy(a) ? a : b);
/** Lua `a and b`. */
const and = <A, B>(a: A, b: B): A | B => (truthy(a) ? b : a);

// Lua: storage.lua:22
function save_ids(session: any): [any, any, any] {
  const row = Profile.forSession(session);
  const names = row.save.storage;
  const C = Constants.of(row.id);
  return [C.require("vars", names.sendVar), C.require("flags", names.boxFullFlag),
    C.require("flags", names.pcOwnerFlag)];
}

// Lua: storage.lua:34
function script_store(session: any): any {
  // package.loaded["src.core.game3.scripting.space"]
  return or(and(Space, Space.store), or(and(session, session?.store), null));
}

// Lua: storage.lua:352
function box_name(storage: StorageData, zeroBased: any): string {
  const box = Storage.getBox(storage, (tonumber(zeroBased) ?? 0) + 1);
  return (box && truthy(box.name)) ? box.name : "";
}

// Lua: storage.lua:358
// pokefirered/src/field_specials.c:1985
function should_show_box_was_full(): boolean {
  const handler = Queries.BY_NAME && Queries.BY_NAME.ShouldShowBoxWasFullMessage;
  if (!truthy(handler)) return false;
  const [, v] = handler(null);
  return (tonumber(v) ?? 0) !== 0;
}

/** A sequence that Lua shrank by nil-ing its tail: drop JS's trailing nulls (len/ipairs/pairs see no change). */
function trimSeq(t: any): void {
  if (Array.isArray(t)) while (t.length > 1 && t[t.length - 1] == null) t.length--;
}

export const Storage = {
  TOTAL_BOXES_COUNT: 14,
  IN_BOX_COUNT: 30,
  TOTAL_BOX_MONS: 420,
  MAX_ITEM_QTY: 999,
  DEFAULT_WALLPAPERS: 4, // pokefirered/src/pokemon_storage_system_menu.c:420

  // Lua: storage.lua:18
  defaultWallpaper(boxNumber: number): number {
    return mod(boxNumber - 1, Storage.DEFAULT_WALLPAPERS) + 1;
  },

  // Lua: storage.lua:30
  pcItemsCount(session?: any): number {
    return Profile.forSession(session).bag.pcItems;
  },

  // Lua: storage.lua:41
  /**
   * Close gaps in the party in place so mons fill slots 1..n in order.
   * pokefirered/src/pokemon.c CompactPartySlots
   */
  compactParty(party: any): any {
    if (!isTable(party)) return party;
    const keys: ({ n: number; k: number | string } | null)[] = seq();
    for (const [k, m] of pairs(party)) {
      const n = tonumber(k);
      if (n !== undefined && m != null) keys[len(keys) + 1] = { n, k };
    }
    sort<{ n: number; k: number | string }>(keys, (a, b) => a.n < b.n);
    const mons: any[] = seq();
    for (const [i, e] of ipairs(keys)) mons[i] = party[e.k];
    for (const [, e] of ipairs(keys)) party[e.k] = null;
    for (const [i, m] of ipairs(mons)) party[i] = m;
    trimSeq(party);
    return party;
  },

  // Lua: storage.lua:57
  /** Create a fresh Storage instance (14 boxes, 30 slots each). */
  new(): StorageData {
    const storage: StorageData = {
      currentBox: 1,
      boxes: seq(),
      items: seq({ id: 13, qty: 1 }), // Player PC item storage (starts with 1 POTION, pokefirered/src/player_pc.c:100)
    };
    for (let b = 1; b <= Storage.TOTAL_BOXES_COUNT; b++) {
      storage.boxes[b] = {
        name: format("BOX %d", b),
        wallpaper: Storage.defaultWallpaper(b),
        mons: seq(), // 1..30 slots (nil = empty)
      };
    }
    return storage;
  },

  // Lua: storage.lua:74
  /** Ensure session has storage initialized. */
  ensure(session: any): StorageData {
    if (!truthy(session)) return undefined as unknown as StorageData;
    if (!truthy(session.storage)) {
      session.storage = Storage.new();
    }
    if (!truthy(session.storage.boxes) || len(session.storage.boxes) < Storage.TOTAL_BOXES_COUNT) {
      const fresh = Storage.new();
      fresh.currentBox = session.storage.currentBox ?? 1;
      fresh.items = session.storage.items ?? fresh.items;
      for (let b = 1; b <= Storage.TOTAL_BOXES_COUNT; b++) {
        if (truthy(session.storage.boxes) && session.storage.boxes[b] != null) {
          fresh.boxes[b] = session.storage.boxes[b];
        }
      }
      session.storage = fresh;
    }
    if (!truthy(session.storage.items)) {
      session.storage.items = seq({ id: 13, qty: 1 });
    }
    return session.storage;
  },

  // Lua: storage.lua:97
  /** The "PC Heal" Exploit: Fully heals HP, restores all move PPs, and clears status ailments. */
  fullHealMon(mon: any): any {
    if (!truthy(mon) || !isTable(mon)) return mon;
    // Restore HP
    if (truthy(mon.maxHp) && mon.maxHp > 0) {
      mon.hp = mon.maxHp;
    } else if (truthy(mon.hp)) {
      mon.hp = mon.maxHp ?? mon.hp;
    }
    // Restore move PPs
    if (isTable(mon.moves)) {
      for (const [, move] of ipairs(mon.moves)) {
        if (isTable(move)) {
          if (truthy(move.maxPp) && move.maxPp > 0) {
            move.pp = move.maxPp;
          } else if (truthy(move.pp)) {
            move.pp = move.maxPp ?? move.pp ?? 35;
          }
        }
      }
    }
    // Clear all non-volatile & volatile statuses
    delete mon.status;
    delete mon.statusAilment;
    delete mon.sleepTurns;
    mon.fainted = false;
    return mon;
  },

  // Lua: storage.lua:126
  /** Get Box table by ID (1..14). */
  getBox(storage: StorageData | null | undefined, boxId: number): StorageBox | null | undefined {
    if (!storage || !truthy(storage.boxes)) return undefined;
    return storage.boxes[boxId];
  },

  // Lua: storage.lua:132
  /** Get Pokémon in a specific box slot (1..30). */
  getBoxMon(storage: StorageData | null | undefined, boxId: number, slotIdx: number): any {
    const box = Storage.getBox(storage, boxId);
    return and(box, and(box?.mons, box?.mons?.[slotIdx]));
  },

  // Lua: storage.lua:138
  /** Count Pokémon in a specific box. */
  countBoxMons(storage: StorageData | null | undefined, boxId: number): number {
    if (!storage || !truthy(storage.boxes) || storage.boxes[boxId] == null) return 0;
    let count = 0;
    for (let slot = 1; slot <= Storage.IN_BOX_COUNT; slot++) {
      if ((storage.boxes[boxId] as StorageBox).mons[slot] != null) {
        count = count + 1;
      }
    }
    return count;
  },

  // Lua: storage.lua:150
  /** Count total Pokémon across all 14 boxes. */
  countTotalMons(storage: StorageData | null | undefined): number {
    if (!storage || !truthy(storage.boxes)) return 0;
    let count = 0;
    for (let b = 1; b <= Storage.TOTAL_BOXES_COUNT; b++) {
      count = count + Storage.countBoxMons(storage, b);
    }
    return count;
  },

  // Lua: storage.lua:161
  /**
   * Find the first open slot starting from currentBox, iterating circularly through all 14 boxes.
   * Returns: boxId, slotIdx (or nil, nil if completely full).
   */
  findOpenSlot(storage: StorageData | null | undefined): [number | null, number | null] {
    if (!storage) return [null, null];
    const cur = storage.currentBox ?? 1;
    for (let offset = 0; offset <= Storage.TOTAL_BOXES_COUNT - 1; offset++) {
      const b = mod(cur - 1 + offset, Storage.TOTAL_BOXES_COUNT) + 1;
      const box = storage.boxes[b];
      if (box) {
        for (let s = 1; s <= Storage.IN_BOX_COUNT; s++) {
          if (box.mons[s] == null) {
            return [b, s];
          }
        }
      }
    }
    return [null, null];
  },

  // Lua: storage.lua:181
  /**
   * Deposit a Pokémon from party into a box.
   * Performs the authentic Gen 3 "PC Heal".
   * Returns: success (bool), boxId, slotIdx / error_reason.
   */
  deposit(session: any, partyIdx: number, targetBoxId?: number, targetSlotIdx?: number): [boolean, any?, any?] {
    if (!truthy(session) || !truthy(session.party) || session.party[partyIdx] == null) {
      return [false, "invalid_party_mon"];
    }
    if (len(session.party) <= 1) {
      return [false, "last_pokemon"];
    }
    const storage = Storage.ensure(session);
    const bId = targetBoxId ?? storage.currentBox ?? 1;
    const box = storage.boxes[bId];
    if (!box) return [false, "invalid_box"];

    let slot = targetSlotIdx;
    if (slot == null || box.mons[slot] != null) {
      // Find first open slot in target box
      for (let s = 1; s <= Storage.IN_BOX_COUNT; s++) {
        if (box.mons[s] == null) {
          slot = s;
          break;
        }
      }
    }
    if (slot == null) {
      return [false, "box_full"];
    }

    const mon = remove(session.party, partyIdx);
    Storage.fullHealMon(mon);
    box.mons[slot] = mon;
    QuestLogRecorder.event(session, "DepositedMonInPC",
      { D0: Pokemon.displayMonName(mon), D1: box.name });
    return [true, bId, slot];
  },

  // Lua: storage.lua:217
  /**
   * Withdraw a Pokémon from a box into the party.
   * Returns: success (bool), partyIdx / error_reason.
   */
  withdraw(session: any, boxId: number, slotIdx: number): [boolean, any] {
    if (!truthy(session)) return [false, "no_session"];
    session.party = session.party ?? seq();
    if (len(session.party) >= 6) {
      return [false, "party_full"];
    }
    const storage = Storage.ensure(session);
    const box = storage.boxes[boxId];
    if (!box || !truthy(box.mons[slotIdx])) {
      return [false, "empty_slot"];
    }

    const mon = box.mons[slotIdx];
    box.mons[slotIdx] = null;
    session.party[len(session.party) + 1] = mon;
    QuestLogRecorder.event(session, "WithdrewMonFromPC",
      { D0: box.name, D1: Pokemon.displayMonName(mon) });
    return [true, len(session.party)];
  },

  // Lua: storage.lua:240
  /**
   * Move / Swap Pokémon between locations (party <-> party, party <-> box, box <-> box).
   * Handles PC heal if moving into a box.
   * srcLoc/destLoc: "party" | "box"
   */
  moveMon(session: any, srcLoc: string, srcIdx: number, destLoc: string, destIdx: number,
    srcBox?: number, destBox?: number): [boolean, string?] {
    if (!truthy(session)) return [false, "no_session"];
    const storage = Storage.ensure(session);
    session.party = session.party ?? seq();

    let srcMon: any, destMon: any;

    if (srcLoc === "party") {
      srcMon = session.party[srcIdx];
    } else if (srcLoc === "box") {
      const box = storage.boxes[srcBox ?? storage.currentBox];
      srcMon = and(box, box?.mons[srcIdx]);
    }

    if (destLoc === "party") {
      destMon = session.party[destIdx];
    } else if (destLoc === "box") {
      const box = storage.boxes[destBox ?? storage.currentBox];
      destMon = and(box, box?.mons[destIdx]);
    }

    if (!truthy(srcMon)) return [false, "src_empty"];

    // Cannot leave party empty if withdrawing/moving away
    let partyCount = 0;
    for (const [, m] of pairs(session.party)) { if (m != null) partyCount = partyCount + 1; }
    if (srcLoc === "party" && destLoc === "box" && !truthy(destMon) && partyCount <= 1) {
      return [false, "last_pokemon"];
    }

    // Apply PC heal to any mon landing in a box
    if (destLoc === "box") Storage.fullHealMon(srcMon);
    if (srcLoc === "box" && truthy(destMon)) Storage.fullHealMon(destMon);

    // Assign to dest
    if (destLoc === "party") {
      session.party[destIdx] = srcMon;
    } else if (destLoc === "box") {
      const box = storage.boxes[destBox ?? storage.currentBox] as StorageBox;
      box.mons[destIdx] = srcMon;
    }

    // Assign to src
    if (srcLoc === "party") {
      session.party[srcIdx] = destMon;
    } else if (srcLoc === "box") {
      const box = storage.boxes[srcBox ?? storage.currentBox] as StorageBox;
      box.mons[srcIdx] = destMon;
    }

    const Q = QuestLogRecorder;
    const srcName = Pokemon.displayMonName(srcMon);
    const dstName = truthy(destMon) ? Pokemon.displayMonName(destMon) : destMon;
    const srcBoxName = (storage.boxes[srcBox ?? storage.currentBox] as StorageBox).name;
    const dstBoxName = (storage.boxes[destBox ?? storage.currentBox] as StorageBox).name;
    if (srcLoc === "party" && destLoc === "party") {
      Q.event(session, "SwitchMon1WithMon2", seq(srcName, dstName));
    } else if (srcLoc === "box" && destLoc === "box") {
      const same = (srcBox ?? storage.currentBox) === (destBox ?? storage.currentBox);
      const key = truthy(destMon) ? (same ? "SwitchedMonsWithinBox" : "SwitchedMonsBetweenBoxes")
        : (same ? "MovedMonWithinBox" : "MovedMonToNewBox");
      Q.event(session, key, {
        D0: srcBoxName, D1: srcName,
        D2: or(and(destMon, or(and(same, dstName), dstBoxName)), dstBoxName), D3: dstName,
      });
    } else if (truthy(destMon)) {
      Q.event(session, "SwitchedPartyMonForPCMon", {
        D0: or(and(srcLoc === "box", srcBoxName), dstBoxName),
        D1: or(and(srcLoc === "box", srcName), dstName), D2: or(and(srcLoc === "party", srcName), dstName),
      });
    } else if (srcLoc === "party") {
      Q.event(session, "DepositedMonInPC", { D0: srcName, D1: dstBoxName });
    } else { Q.event(session, "WithdrewMonFromPC", { D0: srcBoxName, D1: srcName }); }
    // A mon moved out of (or into) the middle of the party must not leave a gap.
    Storage.compactParty(session.party);
    return [true];
  },

  // Lua: storage.lua:315
  /** Release a Pokémon from a box slot. */
  releaseMon(session: any, boxId: number, slotIdx: number): [any, string?] {
    const storage = Storage.ensure(session);
    const box = storage.boxes[boxId];
    if (!box || !truthy(box.mons[slotIdx])) {
      return [null, "empty_slot"];
    }
    const mon = box.mons[slotIdx];
    box.mons[slotIdx] = null;
    return [mon];
  },

  // Lua: storage.lua:327
  // pokefirered/src/pokemon.c:3708
  sendMonToPC(session: any, mon: any): [boolean, number | null, number | null, number | null] {
    if (!truthy(session) || !truthy(mon)) return [false, null, null, null];
    const storage = Storage.ensure(session);
    const store = script_store(session);
    const [VAR_PC_BOX_TO_SEND_MON, FLAG_SHOWN_BOX_WAS_FULL_MESSAGE] = save_ids(session);
    Queries.setPCBoxToSendMon(Flags.getVar(store, null, VAR_PC_BOX_TO_SEND_MON));
    const intended = tonumber(Queries.pcBoxToSendMon) ?? 0;

    Storage.fullHealMon(mon);
    const [bId, slot] = Storage.findOpenSlot(storage);
    if (bId == null || slot == null) {
      return [false, null, null, intended];
    }
    (storage.boxes[bId] as StorageBox).mons[slot] = mon;
    if ((bId - 1) !== intended) {
      Flags.setFlag(store, null, FLAG_SHOWN_BOX_WAS_FULL_MESSAGE, false);
    }
    Flags.setVar(store, null, VAR_PC_BOX_TO_SEND_MON, bId - 1);
    session.monBoxId = bId - 1;
    session.monBoxPos = slot - 1;
    return [true, bId, slot, intended];
  },

  // Lua: storage.lua:367
  // pokefirered/src/field_specials.c:1995
  isDestinationBoxFull(session: any): boolean {
    const storage = Storage.ensure(session);
    const store = script_store(session);
    const [VAR_PC_BOX_TO_SEND_MON, FLAG_SHOWN_BOX_WAS_FULL_MESSAGE] = save_ids(session);
    Queries.setPCBoxToSendMon(Flags.getVar(store, null, VAR_PC_BOX_TO_SEND_MON));
    const bId = Storage.findOpenSlot(storage)[0];
    if (bId == null) return false;
    if ((bId - 1) !== (tonumber(Queries.pcBoxToSendMon) ?? 0)) {
      Flags.setFlag(store, null, FLAG_SHOWN_BOX_WAS_FULL_MESSAGE, false);
    }
    Flags.setVar(store, null, VAR_PC_BOX_TO_SEND_MON, bId - 1);
    return should_show_box_was_full();
  },

  // Lua: storage.lua:384
  // pokefirered/src/battle_script_commands.c:9617
  pcTransferMessage(session: any, name: any, boxWasFull?: boolean | null): any {
    const storage = Storage.ensure(session);
    const store = script_store(session);
    const [VAR_PC_BOX_TO_SEND_MON, , FLAG_SYS_NOT_SOMEONES_PC] = save_ids(session);
    name = tostring(name ?? "");
    const sent = box_name(storage, Flags.getVar(store, null, VAR_PC_BOX_TO_SEND_MON));
    let shown = boxWasFull;
    if (shown == null) shown = should_show_box_was_full();
    const bills = truthy(Flags.getFlag(store, null, FLAG_SYS_NOT_SOMEONES_PC));
    // pokefirered/src/naming_screen.c:732
    const full = truthy(shown) ? box_name(storage, Queries.pcBoxToSendMon) : null;
    const i = (truthy(shown) ? 2 : 0) + (bills ? 1 : 0);
    return RomText.box(RomText.key("sTransferredToPCMessages", i), { stringVars: seq(sent, name, full) });
  },

  // Lua: storage.lua:403
  /** Automatic Spillover Capture Storage: Stores a caught Pokémon across 14 boxes. */
  depositCaught(session: any, mon: any): [boolean, any, any?, any?] {
    if (!truthy(session) || !truthy(mon)) return [false, "invalid_mon"];
    const [ok, bId, slot, intended] = Storage.sendMonToPC(session, mon);
    if (!ok) {
      return [false, "storage_full"];
    }
    return [true, bId, slot, intended];
  },

  // Lua: storage.lua:413
  /** Player PC Item Storage (profile bag.pcItems unique items). */
  depositItem(session: any, bagPocket: string, bagIdx: number, qty?: any): [boolean, string?] {
    if (!truthy(session) || !truthy(session.bag)) return [false, "no_bag"];
    Storage.ensure(session);
    const q = Math.max(1, Math.floor(tonumber(qty) ?? 1));

    const items = Bag.listPocket(session.bag, bagPocket);
    const slot = truthy(items) ? items[bagIdx] : null;
    if (!slot || (tonumber(slot.qty) ?? 0) < q) {
      return [false, "insufficient_bag_qty"];
    }

    const itemId = slot.id;
    const [ok, err] = Storage.addPcItem(session, itemId, q);
    if (!ok) return [false, err];

    Bag.remove(session.bag, itemId, q);
    QuestLogRecorder.event(session, "StoredItemInPC",
      seq(Items.displayName(itemId)));
    return [true];
  },

  // Lua: storage.lua:435
  // src/item.c:385 AddPCItem
  addPcItem(session: any, itemId: any, qty?: any): [boolean, string?] {
    const storage = Storage.ensure(session);
    const q = Math.max(1, Math.floor(tonumber(qty) ?? 1));
    // Check if item already exists in PC items
    let foundIdx: number | null = null;
    for (const [i, entry] of ipairs<PcItem>(storage.items)) {
      if (entry.id === itemId) {
        foundIdx = i;
        break;
      }
    }

    if (foundIdx != null) {
      const curQty = (storage.items[foundIdx] as PcItem).qty ?? 0;
      // Refuse when the stack cannot take the whole deposit.  Capping with
      // math.min while the bag below is debited the full qty destroyed the
      // overflow: a stack already at MAX_ITEM_QTY lost every deposited item.
      if (curQty + q > Storage.MAX_ITEM_QTY) {
        return [false, "pc_item_stack_full"];
      }
      (storage.items[foundIdx] as PcItem).qty = curQty + q;
    } else {
      if (len(storage.items) >= Storage.pcItemsCount(session)) {
        return [false, "pc_items_full"];
      }
      storage.items[len(storage.items) + 1] = { id: itemId, qty: q };
    }
    return [true];
  },

  // Lua: storage.lua:466
  /** Withdraw item from Player PC to Bag. */
  withdrawItem(session: any, pcIdx: number, qty?: any): [boolean, string?] {
    if (!truthy(session) || !truthy(session.bag)) return [false, "no_bag"];
    const storage = Storage.ensure(session);
    const q = Math.max(1, Math.floor(tonumber(qty) ?? 1));

    const entry = storage.items[pcIdx];
    if (!entry || (tonumber(entry.qty) ?? 0) < q) {
      return [false, "insufficient_pc_qty"];
    }

    if (!Bag.canAdd(session.bag, entry.id, q)) {
      return [false, "bag_full"];
    }

    const [ok] = Bag.add(session.bag, entry.id, q);
    if (!ok) return [false, "bag_full"];

    QuestLogRecorder.event(session, "WithdrewItemFromPC",
      seq(Items.displayName(entry.id)));
    entry.qty = entry.qty - q;
    if (entry.qty <= 0) {
      remove(storage.items, pcIdx);
    }
    return [true];
  },

  // Lua: storage.lua:493
  /** Toss item from Player PC. */
  tossItem(session: any, pcIdx: number, qty?: any): [boolean, string?] {
    const storage = Storage.ensure(session);
    const q = Math.max(1, Math.floor(tonumber(qty) ?? 1));
    const entry = storage.items[pcIdx];
    if (!entry || (tonumber(entry.qty) ?? 0) < q) {
      return [false, "insufficient_pc_qty"];
    }
    entry.qty = entry.qty - q;
    if (entry.qty <= 0) {
      remove(storage.items, pcIdx);
    }
    return [true];
  },

  // Lua: storage.lua:508
  /** Move Items Mode: Detach held item from Pokémon and send to Bag with Bag-Full pre-check. */
  detachHeldItem(session: any, mon: any): [boolean, any] {
    if (!truthy(session) || !truthy(session.bag) || !truthy(mon)) return [false, "invalid_args"];
    const itemId = mon.heldItem ?? mon.item;
    if (!truthy(itemId) || itemId === 0) return [false, "no_item"];

    if (!Bag.canAdd(session.bag, itemId, 1)) {
      return [false, "bag_full"];
    }

    const [ok] = Bag.add(session.bag, itemId, 1);
    if (!ok) return [false, "bag_full"];

    delete mon.heldItem;
    delete mon.item;
    return [true, itemId];
  },

  // Lua: storage.lua:526
  /** Sparse Serialization: Encodes only non-empty boxes and slots for minimal disk footprint. */
  serialize(storage: StorageData | null | undefined): any {
    if (!storage) return undefined;
    const data: { currentBox: number; boxes: any[]; items: any[] } = {
      currentBox: storage.currentBox ?? 1,
      boxes: seq(),
      items: seq(),
    };
    // Only serialize non-empty items
    for (const [, item] of ipairs<PcItem>(storage.items ?? seq())) {
      if (truthy(item) && truthy(item.id) && (tonumber(item.qty) ?? 0) > 0) {
        data.items[len(data.items) + 1] = { id: item.id, qty: item.qty };
      }
    }
    // Only serialize non-empty boxes & slots
    for (let b = 1; b <= Storage.TOTAL_BOXES_COUNT; b++) {
      const box = storage.boxes && storage.boxes[b];
      if (box) {
        const boxData: StorageBox = {
          name: box.name,
          wallpaper: box.wallpaper,
          mons: seq(),
        };
        let hasMon = false;
        for (let s = 1; s <= Storage.IN_BOX_COUNT; s++) {
          if (box.mons[s] != null) {
            boxData.mons[s] = box.mons[s];
            hasMon = true;
          }
        }
        if (hasMon || box.name !== format("BOX %d", b) || box.wallpaper !== Storage.defaultWallpaper(b)) {
          data.boxes[b] = boxData;
        }
      }
    }
    return data;
  },

  // Lua: storage.lua:564
  /** Sparse Deserialization: Restores full 14-box structure from sparse save data. */
  deserialize(data: any): StorageData {
    const storage = Storage.new();
    if (!truthy(data)) return storage;
    storage.currentBox = tonumber(data.currentBox) ?? 1;
    if (data.items == null) {
      // pokefirered/src/player_pc.c:100
      storage.items = seq();
    } else {
      storage.items = seq();
      for (const [, item] of ipairs(data.items)) {
        if (truthy(item) && truthy(item.id) && (tonumber(item.qty) ?? 0) > 0) {
          storage.items[len(storage.items) + 1] = { id: item.id, qty: item.qty };
        }
      }
    }
    for (let b = 1; b <= Storage.TOTAL_BOXES_COUNT; b++) {
      const bData = and(data.boxes, data.boxes?.[b]);
      if (truthy(bData)) {
        const box = storage.boxes[b] as StorageBox;
        if (truthy(bData.name)) box.name = tostring(bData.name);
        if (truthy(bData.wallpaper)) box.wallpaper = tonumber(bData.wallpaper) ?? 1;
        if (isTable(bData.mons)) {
          for (let s = 1; s <= Storage.IN_BOX_COUNT; s++) {
            if (bData.mons[s] != null) {
              box.mons[s] = bData.mons[s];
            }
          }
        }
      }
    }
    return storage;
  },

  // Lua: storage.lua:596
  restore(data: any, legacyPc?: any, pcItems?: any): StorageData {
    const hasData = isTable(data);
    const hasPc = isTable(legacyPc);
    const hasPcItems = isTable(pcItems);
    if (!hasData && !hasPc && !hasPcItems) {
      return Storage.new();
    }
    const storage = Storage.deserialize(hasData ? data : null);
    if (hasPc) {
      if (!hasData) {
        storage.items = seq();
        for (const [, it] of ipairs(legacyPc.items ?? seq())) {
          const id = isTable(it) ? tonumber(it.id ?? it.itemId) : undefined;
          const qty = isTable(it) ? (tonumber(it.qty ?? it.quantity) ?? 0) : 0;
          if (id !== undefined && qty > 0 && len(storage.items) < Storage.pcItemsCount()) {
            storage.items[len(storage.items) + 1] = { id, qty: Math.min(Storage.MAX_ITEM_QTY, qty) };
          }
        }
      }
      if (Storage.countTotalMons(storage) === 0) {
        for (const [, mon] of ipairs(legacyPc.mons ?? seq())) {
          const [b, s] = Storage.findOpenSlot(storage);
          if (b == null) break;
          (storage.boxes[b] as StorageBox).mons[s as number] = mon;
        }
      }
    } else if (!hasData && hasPcItems) {
      storage.items = seq();
      for (const [k, v] of pairs(pcItems)) {
        let id: number | undefined = undefined;
        let qty = 0;
        if (typeof k === "number" && isTable(v)) {
          id = tonumber(v.id ?? v.itemId);
          qty = tonumber(v.qty ?? v.quantity ?? v.count) ?? 0;
        } else if (typeof k === "string" && typeof v === "number") {
          id = ItemsData.toNumericId(k);
          qty = v;
        } else if (typeof k === "number" && typeof v === "number") {
          id = k;
          qty = v;
        }
        if (id !== undefined && qty > 0 && len(storage.items) < Storage.pcItemsCount()) {
          storage.items[len(storage.items) + 1] = { id, qty: Math.min(Storage.MAX_ITEM_QTY, qty) };
        }
      }
    }
    return storage;
  },
};

export default Storage;
