// The ITEM screen. Reads the ported Bag (rules/bag.ts, itself a port of
// gen1recomp Bag.lua) — acquisition order, quantities, CANCEL last, with the
// same scrolling window the start menu uses.
import type { GameState } from "../game.ts";
import * as Bag from "../rules/bag.ts";
import { PartyState } from "./partyscreen.ts";

const ROWS = 4;

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
    // (game.ts teachMachine) — pokered's UseItem -> ItemUseTMHM. Every other
    // item is still inert; general item use/toss is a later rung.
    if (p.a && this.index < this.ids().length) {
      const id = this.ids()[this.index]!;
      if (this.game.data.items?.[id]?.machine?.move) {
        this.game.push(
          new PartyState(this.game as never, {
            onPick: (i: number) => this.game.teachMachine(i, id),
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
