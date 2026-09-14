// The ITEM screen. Reads the ported Bag (rules/bag.ts, itself a port of
// gen1recomp Bag.lua) — acquisition order, quantities, CANCEL last, with the
// same scrolling window the start menu uses.
import type { GameState } from "../game.ts";
import * as Bag from "../rules/bag.ts";
import { PartyState } from "./partyscreen.ts";

const ROWS = 4;

/**
 * Items that open the party as a chooser and then act on the mon picked —
 * the ported slice of ItemEffects.needsTarget (gen1recomp
 * src/inventory/ItemEffects.lua:75-83), which in full also covers potions,
 * status cures, revives, vitamins, PP UP and the evolution stones. TM/HMs
 * need a target too but take their own branch below, since the bag reads
 * those off the item data rather than a list.
 */
const USABLE_ON_PARTY = new Set(["RARE_CANDY"]);

/**
 * Key items that act on the world rather than on a Pokemon — StartMenu_Item's
 * .useOrTossItem straight into UseItem. The BICYCLE mounts and dismounts
 * (game.ts useKeyItem -> world/bike.ts).
 */
const USABLE_IN_FIELD = new Set(["BICYCLE"]);

/** ItemMenu's two choices for a selected item (StartMenu_Item). */
export type BagMode = "list" | "submenu" | "quantity";

export interface BagView {
  entries: { name: string; qty: number }[];
  index: number;
  top: number;
  rows: number;
  /** "list" until an item is picked; then USE/TOSS, then how many. */
  mode: BagMode;
  submenuIndex: number;
  /** How many to toss, while `mode` is "quantity". */
  qty: number;
}

export class BagState implements GameState {
  readonly kind = "bag";
  private index = 0;
  private top = 0;
  private mode: BagMode = "list";
  private submenuIndex = 0;
  private qty = 1;

  constructor(
    private game: {
      input: any;
      push(s: GameState): void;
      pop(): void;
      save: any;
      data: any;
      teachMachine(partyIndex: number, itemId: string): void;
      useItem(partyIndex: number, itemId: string): void;
      useKeyItem(itemId: string): void;
      closeToOverworld(): void;
      showText(text: string, onDone?: () => void): void;
      showChoice(text: string, choice: (yes: boolean) => void): void;
    },
  ) {}

  private ids(): string[] {
    return Bag.order(this.game.save);
  }

  /** The item the cursor is on, or undefined on CANCEL. */
  private selected(): string | undefined {
    return this.ids()[this.index];
  }

  private line(key: string, fallback: string): string {
    return (this.game.data?.text ?? {})[key] ?? fallback;
  }

  private itemName(id: string): string {
    return this.game.data.items?.[id]?.name ?? id;
  }

  /** ItemMenu's TOSS branch (StartMenu_Item .tossItem). */
  private toss(id: string, qty: number): void {
    // TossItem refuses a key item outright -- they are one of a kind and
    // several of them cannot be replaced.
    if (this.game.data.items?.[id]?.keyItem) {
      this.mode = "list";
      this.game.showText(this.line("_TooImportantToTossText", "That's too impor-\ntant to toss!"));
      return;
    }
    const ask = this.line("_IsItOKToTossItemText", "Is it OK to toss\n{RAM:wStringBuffer}?")
      .replace(/\{RAM:\w+\}/g, this.itemName(id));
    this.game.showChoice(ask, (yes) => {
      this.mode = "list";
      if (!yes) return;
      Bag.remove(this.game.save, id, qty);
      // The list just got shorter; keep the cursor on something real.
      const n = this.ids().length;
      if (this.index > n) this.index = n;
      if (this.top > this.index) this.top = this.index;
    });
  }

  private updateSubmenu(p: any): void {
    const id = this.selected();
    if (!id) { this.mode = "list"; return; }
    if (p.up) this.submenuIndex = 0;
    if (p.down) this.submenuIndex = 1;
    if (p.b) { this.mode = "list"; return; }
    if (!p.a) return;
    if (this.submenuIndex === 1) {
      // TOSS: a stack asks how many, a single one does not.
      const have = this.game.save.inventory?.[id] ?? 0;
      if (this.game.data.items?.[id]?.keyItem || have <= 1) {
        this.toss(id, 1);
      } else {
        this.qty = 1;
        this.mode = "quantity";
      }
      return;
    }
    this.mode = "list";
    this.use(id);
  }

  private updateQuantity(p: any): void {
    const id = this.selected();
    if (!id) { this.mode = "list"; return; }
    const have = this.game.save.inventory?.[id] ?? 1;
    if (p.up) this.qty = Math.min(have, this.qty + 1);
    if (p.down) this.qty = Math.max(1, this.qty - 1);
    if (p.right) this.qty = Math.min(have, this.qty + 10);
    if (p.left) this.qty = Math.max(1, this.qty - 10);
    if (p.b) { this.mode = "submenu"; return; }
    if (p.a) this.toss(id, this.qty);
  }

  /** What pressing USE does, by item -- unchanged from before the submenu. */
  private use(id: string): void {
    const teach = !!this.game.data.items?.[id]?.machine?.move;
    if (USABLE_IN_FIELD.has(id)) {
      // ItemUseBicycle closes the WHOLE start menu, not just the item
      // list: you land back on the map already riding. Leaving the start
      // menu up would also swallow the walking input that follows.
      this.game.closeToOverworld();
      this.game.useKeyItem(id);
      return;
    }
    if (teach || USABLE_ON_PARTY.has(id)) {
      this.game.push(
        new PartyState(this.game as never, {
          onPick: (i: number) =>
            teach ? this.game.teachMachine(i, id) : this.game.useItem(i, id),
        }),
      );
    }
  }

  update(): void {
    const p = this.game.input.pressed;
    if (this.mode === "submenu") return this.updateSubmenu(p);
    if (this.mode === "quantity") return this.updateQuantity(p);
    const n = this.ids().length + 1;          // + CANCEL
    if (p.up) this.index = (this.index + n - 1) % n;
    if (p.down) this.index = (this.index + 1) % n;
    if (this.index < this.top) this.top = this.index;
    if (this.index >= this.top + ROWS) this.top = this.index - ROWS + 1;
    if (p.b || (p.a && this.index === n - 1)) {
      this.game.pop();
      return;
    }
    // Picking an item opens ItemMenu's USE / TOSS (StartMenu_Item). USE is
    // what the bag did before this; TOSS is how the bag gets emptied, which
    // it previously had no way to do at all.
    //
    // The bag stays open under either, which is what lets a stack of RARE
    // CANDY be used one after another (gen1recomp BagMenu.lua #796).
    if (p.a && this.index < this.ids().length) {
      this.mode = "submenu";
      this.submenuIndex = 0;
    }
  }

  view(): BagView {
    const save = this.game.save;
    const items = this.ids().map((id) => ({
      name: this.game.data.items?.[id]?.name ?? id,
      qty: save.inventory?.[id] ?? 0,
    }));
    return {
      entries: items,
      index: this.index,
      top: this.top,
      rows: ROWS,
      mode: this.mode,
      submenuIndex: this.submenuIndex,
      qty: this.qty,
    };
  }
}
