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

export interface BagView {
  entries: { name: string; qty: number }[];
  index: number;
  top: number;
  rows: number;
}

export class BagState implements GameState {
  readonly kind = "bag";
  private index = 0;
  private top = 0;

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
    },
  ) {}

  private ids(): string[] {
    return Bag.order(this.game.save);
  }

  update(): void {
    const p = this.game.input.pressed;
    const n = this.ids().length + 1;          // + CANCEL
    if (p.up) this.index = (this.index + n - 1) % n;
    if (p.down) this.index = (this.index + 1) % n;
    if (this.index < this.top) this.top = this.index;
    if (this.index >= this.top + ROWS) this.top = this.index - ROWS + 1;
    if (p.b || (p.a && this.index === n - 1)) {
      this.game.pop();
      return;
    }
    // Selecting a TM/HM opens the party as a chooser and teaches the move
    // (game.ts teachMachine) — pokered's UseItem -> ItemUseTMHM. USABLE_ON_PARTY
    // items take the same chooser into game.ts useItem. Everything else is
    // still inert; general item use/toss is a later rung.
    //
    // The bag stays open under either, which is what lets a stack of RARE
    // CANDY be used one after another (gen1recomp BagMenu.lua #796).
    if (p.a && this.index < this.ids().length) {
      const id = this.ids()[this.index]!;
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
  }

  view(): BagView {
    const save = this.game.save;
    const items = this.ids().map((id) => ({
      name: this.game.data.items?.[id]?.name ?? id,
      qty: save.inventory?.[id] ?? 0,
    }));
    return { entries: items, index: this.index, top: this.top, rows: ROWS };
  }
}
