// {PLAYER}'s PC — the Item Storage System (engine/menus/pc.asm
// PlayerPCMenu / engine/items/item_pc.asm).
//
// A second bag, kept on the save beside the first, in gen1recomp's fields:
// `pcItems` (id -> count) and `pcOrder`, so a save carries its PC both ways
// (and his new game's POTION is in it). rules/bag.ts drives it unchanged
// through a BagSave view of those two fields: the same acquisition order,
// the same one-slot-per-id rule, the same 99 cap per stack. Only the number
// of slots differs, and `add` already takes the capacity as data.
//
// Saves this port wrote before 2026-10-04 kept the PC in `pc = { inventory,
// bagOrder }`; the first look folds that into his fields (savecompat.ts).
//
// pokered's box holds 50 (PC_ITEM_CAPACITY); field.pcItemCap carries it so a
// mod can say otherwise.

import type { BagSave } from "../rules/bag.ts";
import * as Bag from "../rules/bag.ts";
import type { VoxelmonData } from "../data.ts";
import { migratePc } from "../savecompat.ts";

/** PC_ITEM_CAPACITY, when the cooked field data does not say. */
export const PC_ITEM_CAPACITY = 50;

/** The save slice the PC's own bag lives in (gen1recomp's field names). */
export interface PcSave {
  pcItems?: Record<string, number>;
  pcOrder?: string[];
  /** The pre-2026-10-04 home of the PC's items; folded in on first use. */
  pc?: BagSave;
}

/** This save's PC bag: a BagSave over pcItems / pcOrder, created empty on first use. */
export function pcBag(save: PcSave): BagSave {
  if (save.pc) migratePc(save);
  if (!save.pcItems || typeof save.pcItems !== "object") save.pcItems = {};
  return {
    get inventory() {
      return (save.pcItems ??= {});
    },
    set inventory(v: Record<string, number>) {
      save.pcItems = v;
    },
    get bagOrder() {
      return save.pcOrder;
    },
    set bagOrder(v: string[] | undefined) {
      save.pcOrder = v;
    },
  };
}

/**
 * A `data`-shaped stand-in whose bagSize is the PC's capacity, so
 * `Bag.add` enforces 50 slots here and 20 in the bag without either knowing
 * about the other.
 */
export function pcCapacityData(
  data?: Pick<VoxelmonData, "constants"> & { field?: { pcItemCap?: number } },
): Pick<VoxelmonData, "constants"> {
  const cap = data?.field?.pcItemCap;
  return {
    constants: {
      ...(data?.constants ?? {}),
      bagSize: typeof cap === "number" && cap >= 1 ? cap : PC_ITEM_CAPACITY,
    },
  } as Pick<VoxelmonData, "constants">;
}

/** Ids in the PC, in the order they went in. */
export function pcOrder(save: PcSave): string[] {
  return Bag.order(pcBag(save));
}

/**
 * Move `qty` of `id` from the bag into the PC.
 *
 * Returns false and moves NOTHING when the PC has no room — the item must
 * not leave the bag before the box has taken it, or a full box would eat it.
 */
export function deposit(
  save: PcSave & BagSave,
  id: string,
  qty: number,
  data?: Parameters<typeof pcCapacityData>[0],
): boolean {
  const have = save.inventory?.[id] ?? 0;
  const n = Math.min(qty, have);
  if (n <= 0) return false;
  if (!Bag.add(pcBag(save), id, n, pcCapacityData(data))) return false;
  Bag.remove(save, id, n);
  return true;
}

/** Move `qty` of `id` out of the PC and into the bag, same rule reversed. */
export function withdraw(
  save: PcSave & BagSave,
  id: string,
  qty: number,
  data?: Pick<VoxelmonData, "constants">,
): boolean {
  const box = pcBag(save);
  const have = box.inventory?.[id] ?? 0;
  const n = Math.min(qty, have);
  if (n <= 0) return false;
  if (!Bag.add(save, id, n, data)) return false;
  Bag.remove(box, id, n);
  return true;
}

/** Throw `qty` of `id` away out of the PC. */
export function tossFromPc(save: PcSave, id: string, qty: number): void {
  Bag.remove(pcBag(save), id, qty);
}
