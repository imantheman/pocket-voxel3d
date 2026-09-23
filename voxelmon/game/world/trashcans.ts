// LT. SURGE's double locks, ported from gen1recomp OverworldController
// trashCanSwitch (engine/events/hidden_events/vermilion_gym_trash.asm
// GymTrashScript).
//
// Fifteen cans in a 5x3 grid. One hides the first switch; opening it puts
// the second switch in a can NEXT to that one, and opening that one opens
// the motorized door. A wrong second guess resets both locks and hides the
// first switch somewhere else. The can coordinates, the adjacency table and
// the door block all come out of field.hiddenExtras.trashCans, which the
// importer wrote from the ROM.

/** Where the two switches are hiding, while the puzzle is unsolved. */
export interface TrashPuzzle {
  /** The can with the first switch, re-rolled on every Vermilion City load. */
  first?: number;
  /** The can with the second, chosen when the first is opened. */
  second?: number;
}

export interface TrashSave {
  flags: Record<string, boolean>;
  trashPuzzle?: TrashPuzzle;
}

interface TrashData {
  cans?: { can: number; x: number; y: number }[];
  adjacent?: Record<string, number[]>;
  firstLockEvent?: string;
  secondLockEvent?: string;
  /** The block the solved puzzle stamps over the doorway, and where. */
  doorBlock?: { bx: number; by: number; block: number };
}

/**
 * The importer's table has no doorBlock -- gen1recomp supplies it from
 * FieldDefaults, so this does too: VermilionGymSetDoorTile writes block 5
 * (clear floor) over the doorway at (2,2).
 */
export const DOOR_BLOCK = { bx: 2, by: 2, block: 5 };

export const FIRST_LOCK = "EVENT_1ST_LOCK_OPENED";
export const SECOND_LOCK = "EVENT_2ND_LOCK_OPENED";

export function trashData(data: any): TrashData | null {
  return (data?.field?.hiddenExtras?.trashCans as TrashData | undefined) ?? null;
}

/** The can at (x, y) on this map, or null when that is not a can. */
export function canAt(data: any, mapId: string, x: number, y: number): number | null {
  const tc = trashData(data);
  if (!tc || mapId !== "VERMILION_GYM") return null;
  const hit = (tc.cans ?? []).find((c) => c.x === x && c.y === y);
  return hit ? hit.can : null;
}

/** Random & $0e: an even can, 0..14. Rolled on every Vermilion City load. */
export function rollFirst(rand: () => number): number {
  return (rand() & 0x0e) % 16;
}

/**
 * Where the second switch goes once the first is open. GymTrashCans rows
 * are `mask, cand1..cand4`, the mask doubling as the candidate count; the
 * asm ANDs it with a random byte and uses `result - 1` as the offset. A
 * result of 0 underflows into the bank's zero padding and lands the switch
 * in can 0 whatever the adjacency -- the documented GymTrashCans bug, kept.
 */
export function rollSecond(adj: number[], rand: () => number): number {
  const masked = rand() & adj.length;
  return masked === 0 ? 0 : (adj[masked - 1] ?? 0);
}

export type TrashOutcome =
  | { kind: "trash" }
  | { kind: "first"; second: number }
  | { kind: "second" }
  | { kind: "fail"; first: number };

/**
 * Press A on can `can`. Mutates the save the way the ROM does -- the flags,
 * and where the switches hide -- and says what happened; the caller prints
 * the line, plays the beep and (on "second") opens the door.
 *
 * `rand` returns a random byte, 0..255.
 */
export function openCan(
  data: any,
  save: TrashSave,
  can: number,
  rand: () => number,
): TrashOutcome {
  // "Don't do the trash can puzzle if it's already been done."
  if (save.flags[SECOND_LOCK]) return { kind: "trash" };
  const puz = (save.trashPuzzle ??= {});
  // Normally rolled by Vermilion City's map load, the only way in; this
  // covers a save from before that hook and a debug warp straight here.
  if (puz.first === undefined) puz.first = rollFirst(rand);

  if (!save.flags[FIRST_LOCK]) {
    if (can !== puz.first) return { kind: "trash" };
    save.flags[FIRST_LOCK] = true;
    const adj = trashData(data)?.adjacent?.[String(puz.first)] ?? [];
    puz.second = rollSecond(adj, rand);
    return { kind: "first", second: puz.second };
  }
  if (can === puz.second) {
    save.flags[SECOND_LOCK] = true;
    return { kind: "second" };
  }
  // A wrong second can relocks the first and hides it again.
  save.flags[FIRST_LOCK] = false;
  puz.first = rollFirst(rand);
  puz.second = undefined;
  return { kind: "fail", first: puz.first };
}
