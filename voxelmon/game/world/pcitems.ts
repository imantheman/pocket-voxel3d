// {PLAYER}'s PC — the Item Storage System (engine/menus/pc.asm
// PlayerPCMenu / engine/items/item_pc.asm).
//
// A second bag, kept on the save beside the first. It is a BagSave of its own
// rather than a parallel pair of fields so rules/bag.ts drives it unchanged:
// the same acquisition order, the same one-slot-per-id rule, the same 99 cap
// per stack. Only the number of slots differs, and `add` already takes the
// capacity as data.
//
// pokered's box holds 50 (PC_ITEM_CAPACITY); field.pcItemCap carries it so a
// mod can say otherwise.

import type { BagSave } from "../rules/bag.ts";
import * as Bag from "../rules/bag.ts";
import type { VoxelmonData } from "../data.ts";

/** PC_ITEM_CAPACITY, when the cooked field data does not say. */
export const PC_ITEM_CAPACITY = 50;

/** The save slice the PC's own bag lives in. */
export interface PcSave {
  pc?: BagSave;
}

/** This save's PC bag, created empty on first use. */
export function pcBag(save: PcSave): BagSave {
  return (save.pc ??= { inventory: {}, bagOrder: [] });
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
