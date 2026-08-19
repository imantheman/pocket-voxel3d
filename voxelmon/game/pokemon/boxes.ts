// PC storage: 12 boxes of 20, like the original (wBoxDataStart / Bill's PC,
// engine/pokemon/bills_pc.asm). Ported from src/pokemon/Boxes.lua. Older saves
// with a single `box` list are migrated into box 1. The generic save.lua
// serializer writes save.boxes (array -> 1-based Lua table) and save.currentBox
// straight through, matching the desktop recomp's format.
import type { PartyMon } from "../battle/mon.ts";

export const BOX_COUNT = 12;
export const BOX_CAPACITY = 20;

export function ensure(save: any): PartyMon[][] {
  if (!save.boxes) {
    save.boxes = [];
    for (let i = 0; i < BOX_COUNT; i++) save.boxes[i] = [];
    save.currentBox = 1;
    // migrate pre-12-box saves (save.box was a single list)
    if (Array.isArray(save.box)) {
      for (const mon of save.box) save.boxes[0].push(mon);
      save.box = null;
    }
  }
  save.currentBox = Math.max(1, Math.min(BOX_COUNT, save.currentBox ?? 1));
  return save.boxes as PartyMon[][];
}

/** The current box's mon list. */
export function active(save: any): PartyMon[] {
  return ensure(save)[save.currentBox - 1]!;
}

/**
 * Deposit into the current box; overflows into the next box with room
 * (divergence: the original refuses the catch when the box is full).
 * Returns the 1-based box number used, or null when every box is full.
 */
export function deposit(save: any, mon: PartyMon): number | null {
  const boxes = ensure(save);
  for (let off = 0; off < BOX_COUNT; off++) {
    const i = (save.currentBox - 1 + off) % BOX_COUNT;
    if (boxes[i]!.length < BOX_CAPACITY) {
      boxes[i]!.push(mon);
      return i + 1;
    }
  }
  return null;
}
