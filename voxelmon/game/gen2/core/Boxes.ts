// gen1recomp src/core/gen2/Boxes.lua at bdfac727 (MIT): the Gen 2 storage
// system -- 14 boxes of 20, the party<->box moves the PC does, and the default
// BOX1..BOX14 names. Rules from engine/pokemon/bills_pc.asm.
//
// Indexing: box numbers, party slots and in-box slots stay 1-based as the Lua
// passes them; storage is `save.boxes[box - 1]`, `save.boxNames[box - 1]`,
// `save.party[slot - 1]`, `box[slot - 1]`.
// Lua's `return ok, x` pairs come back as tuples `[ok, x]` (callers read both).

import { Mail } from "./Mail.ts";
import { Save } from "./Save.ts";
import { removeAt, tostring } from "../platform/lua.ts";

type SaveLike = Record<string, any> | null | undefined;
/** `true` or `false, reason` (Lua), as a tuple. */
export type BoxCheck = [true] | [false, string];
/** `true, mon` or `false, reason` (Lua), as a tuple. */
export type BoxResult = [true, any] | [false, string];

export const Boxes = {
  // Lua: Boxes.lua:22-24 -- Save's constants (read lazily: Save may still be
  // loading when this module is).
  get NUM_BOXES(): number {
    return Save.NUM_BOXES;
  },
  get MONS_PER_BOX(): number {
    return Save.MONS_PER_BOX;
  },
  get PARTY_SIZE(): number {
    return Save.PARTY_SIZE;
  },

  /** Lua: Boxes.lua:27 -- SetDefaultBoxNames (intro_menu.asm): "BOX" .. n. */
  defaultName(index: number): string {
    return "BOX" + tostring(index);
  },

  /** Lua: Boxes.lua:31 */
  name(save: SaveLike, index: number): string {
    const names = save && save.boxNames;
    const given = names && names[index - 1];
    if (typeof given === "string" && given !== "") return given;
    return Boxes.defaultName(index);
  },

  /** Lua: Boxes.lua:38 */
  rename(save: SaveLike, index: number, name: string): boolean {
    if (!save || index == null) return false;
    if (index < 1 || index > Boxes.NUM_BOXES) return false;
    save.boxNames = save.boxNames || [];
    save.boxNames[index - 1] = name;
    return true;
  },

  /** Lua: Boxes.lua:48 -- the box's mon list, created on demand (default: currentBox). */
  box(save: SaveLike, index?: number | null): any[] {
    if (!save) return [];
    index = index ?? save.currentBox ?? 1;
    if (index! < 1 || index! > Boxes.NUM_BOXES) return [];
    save.boxes = save.boxes || [];
    save.boxes[index! - 1] = save.boxes[index! - 1] || [];
    return save.boxes[index! - 1];
  },

  /** Lua: Boxes.lua:57 */
  count(save: SaveLike, index?: number | null): number {
    return Boxes.box(save, index).length;
  },

  /** Lua: Boxes.lua:61 */
  isFull(save: SaveLike, index?: number | null): boolean {
    return Boxes.count(save, index) >= Boxes.MONS_PER_BOX;
  },

  /** Lua: Boxes.lua:65 */
  setCurrent(save: SaveLike, index: number): boolean {
    if (!save || index < 1 || index > Boxes.NUM_BOXES) return false;
    save.currentBox = index;
    return true;
  },

  /** Lua: Boxes.lua:74 -- how many party members could still fight. */
  healthyCount(party: any[] | null | undefined): number {
    let n = 0;
    for (const mon of party || []) {
      if (mon == null) break; // ipairs
      if ((mon.hp || 0) > 0) n = n + 1;
    }
    return n;
  },

  /** Lua: Boxes.lua:83 -- [true] or [false, reason]. */
  canDeposit(save: SaveLike, partyIndex: number, boxIndex?: number | null): BoxCheck {
    if (!save) return [false, "No save."];
    const mon = save.party && save.party[partyIndex - 1];
    if (!mon) return [false, "There is no POKéMON there."];
    if (Boxes.isFull(save, boxIndex)) {
      return [false, "The BOX is full."];
    }
    if ((mon.hp || 0) > 0 && Boxes.healthyCount(save.party) <= 1) {
      return [false, "You can't deposit\nthe last POKéMON!"];
    }
    // BillsPC_CheckMon's .HasMail arm, checked AFTER the last-healthy rule
    // (PCString_RemoveMail): a boxed mon's letter has nowhere to live.
    if (Mail.monHoldsMail(mon)) {
      return [false, "Remove MAIL."];
    }
    return [true];
  },

  /** Lua: Boxes.lua:106 -- RestorePPOfDepositedPokemon (move_mon.asm:711-773). */
  restorePP(mon: any): void {
    for (const move of (mon && mon.moves) || []) {
      if (move == null) break; // ipairs
      if (typeof move === "object") move.pp = move.maxPp ?? move.pp;
    }
  },

  /** Lua: Boxes.lua:114 -- box_struct has no status/HP: refill from MAXHP (tempmon.asm:56-83). */
  enterBox(mon: any): any {
    if (!mon) return mon;
    Boxes.restorePP(mon);
    mon.status = undefined;
    mon.statusTurns = undefined;
    mon.hp = mon.isEgg ? 0 : (mon.maxHp ?? mon.hp);
    return mon;
  },

  /** Lua: Boxes.lua:123 -- [true, mon] or [false, reason]. */
  deposit(save: SaveLike, partyIndex: number, boxIndex?: number | null): BoxResult {
    const [ok, reason] = Boxes.canDeposit(save, partyIndex, boxIndex);
    if (!ok) return [false, reason!];
    const mon = removeAt(save!.party, partyIndex);
    // RemoveMonFromPartyOrBox's "Mail time!" tail: the letters behind move up.
    Mail.removeSlot(save, partyIndex);
    const box = Boxes.box(save, boxIndex);
    box.push(mon);
    // SendGetMonIntoFromBox's PC_DEPOSIT arm (move_mon.asm:633-635, :696-700).
    Boxes.enterBox(mon);
    return [true, mon];
  },

  /** Lua: Boxes.lua:140 -- [true] or [false, reason]. */
  canWithdraw(save: SaveLike, boxIndex: number | null | undefined, slot: number): BoxCheck {
    if (!save) return [false, "No save."];
    const box = Boxes.box(save, boxIndex);
    if (!box[slot - 1]) return [false, "There is no POKéMON there."];
    if ((save.party || []).length >= Boxes.PARTY_SIZE) {
      return [false, "You can't take\nany more POKéMON."];
    }
    return [true];
  },

  /** Lua: Boxes.lua:150 -- [true, mon] or [false, reason]. */
  withdraw(save: SaveLike, boxIndex: number | null | undefined, slot: number): BoxResult {
    const [ok, reason] = Boxes.canWithdraw(save, boxIndex, slot);
    if (!ok) return [false, reason!];
    const mon = removeAt(Boxes.box(save, boxIndex), slot);
    // The `get mon into Party` arm alone heals (move_mon.asm:666-693).
    mon.status = undefined;
    mon.statusTurns = undefined;
    if (mon.isEgg) {
      mon.hp = 0;
    } else {
      mon.hp = mon.maxHp ?? mon.hp;
    }
    save!.party = save!.party || [];
    save!.party.push(mon);
    return [true, mon];
  },

  /** Lua: Boxes.lua:170 -- RELEASE from a box: [true, mon] or [false, reason]. */
  release(save: SaveLike, boxIndex: number | null | undefined, slot: number): BoxResult {
    const box = Boxes.box(save, boxIndex);
    if (!box[slot - 1]) return [false, "There is no POKéMON there."];
    return [true, removeAt(box, slot)];
  },

  /** Lua: Boxes.lua:178 -- RELEASE off the DEPOSIT screen (bills_pc.asm:204-207). */
  releaseFromParty(save: SaveLike, slot: number): BoxResult {
    const party: any[] = (save && save.party) || [];
    if (!party[slot - 1]) return [false, "There is no POKéMON there."];
    const mon = removeAt(party, slot);
    Mail.removeSlot(save, slot);
    return [true, mon];
  },

  /** Lua: Boxes.lua:187 -- box-to-box move: [true, mon] or [false, reason]. */
  move(save: SaveLike, fromBox: number, slot: number, toBox: number): BoxResult {
    if (fromBox === toBox) return [false, "It's already there."];
    const source = Boxes.box(save, fromBox);
    if (!source[slot - 1]) return [false, "There is no POKéMON there."];
    if (Boxes.isFull(save, toBox)) return [false, "The BOX is full."];
    const mon = removeAt(source, slot);
    const target = Boxes.box(save, toBox);
    target.push(mon);
    return [true, mon];
  },

  /** Lua: Boxes.lua:203 -- .CheckCanUsePC: [true] or [false, reason]. */
  canUsePc(save: SaveLike): BoxCheck {
    if (!(save && save.party && save.party.length > 0)) {
      return [false, "You'll need a\nPOKéMON to call\fwith."];
    }
    return [true];
  },
};

export default Boxes;
