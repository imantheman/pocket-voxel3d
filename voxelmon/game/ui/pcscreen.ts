// The PC. Ports engine/menus/pc.asm's two menus: the machine's own list
// (SOMEONE'S PC / {PLAYER}'s PC / LOG OFF) and, inside the player's, the
// Item Storage System of engine/items/item_pc.asm — WITHDRAW / DEPOSIT /
// TOSS / LOG OFF over a second bag (world/pcitems.ts).
//
// The Pokemon half is ui/boxscreen.ts, which this hands off to; before this
// the PC tile opened that directly and item storage had no way in at all.
import type { GameState } from "../game.ts";
import * as Bag from "../rules/bag.ts";
import * as Pc from "../world/pcitems.ts";

const ROWS = 4;

export type PcMode = "root" | "items" | "list" | "quantity";

export interface PcView {
  mode: PcMode;
  /** Rows of whichever menu is open. */
  entries: { name: string; qty: number }[];
  index: number;
  top: number;
  rows: number;
  /** Menu labels when `mode` is "root" or "items". */
  labels: string[];
  qty: number;
  /** WITHDRAW / DEPOSIT / TOSS, while a list is open. */
  action: string;
}

interface PcGame {
  input: { pressed: Partial<Record<string, boolean>> };
  push(s: GameState): void;
  pop(): void;
  save: any;
  data: any;
  showText(text: string, onDone?: () => void): void;
  openBox(): void;
}

const ROOT = ["SOMEONE'S PC", "MY PC", "LOG OFF"];
const ITEMS = ["WITHDRAW ITEM", "DEPOSIT ITEM", "TOSS ITEM", "LOG OFF"];

export class PcState implements GameState {
  readonly kind = "pc";
  private mode: PcMode = "root";
  private index = 0;
  private top = 0;
  private menuIndex = 0;
  private itemsIndex = 0;
  private qty = 1;
  private action: "withdraw" | "deposit" | "toss" = "withdraw";

  constructor(private game: PcGame, private onDone?: () => void) {}

  private line(key: string, fallback: string): string {
    return (this.game.data?.text ?? {})[key] ?? fallback;
  }

  private name(id: string): string {
    return this.game.data.items?.[id]?.name ?? id;
  }

  /** The ids the open list is over: the PC's for withdraw/toss, the bag's
   * for deposit. */
  private ids(): string[] {
    if (this.action === "deposit") return Bag.order(this.game.save);
    return Pc.pcOrder(this.game.save);
  }

  private held(id: string): number {
    const inv = this.action === "deposit"
      ? this.game.save.inventory
      : Pc.pcBag(this.game.save).inventory;
    return inv?.[id] ?? 0;
  }

  private close(): void {
    this.game.pop();
    this.onDone?.();
  }

  /** Open a list, or say why it cannot be opened. */
  private startAction(a: "withdraw" | "deposit" | "toss"): void {
    this.action = a;
    const empty = this.ids().length === 0;
    if (empty) {
      this.game.showText(
        a === "deposit"
          ? this.line("_NothingToDepositText", "You have nothing\nto deposit.")
          : this.line("_NothingStoredText", "There is nothing\nstored."),
      );
      return;
    }
    this.game.showText(
      a === "deposit"
        ? this.line("_WhatToDepositText", "What do you want\nto deposit?")
        : a === "withdraw"
          ? this.line("_WhatToWithdrawText", "What do you want\nto withdraw?")
          : this.line("_WhatToTossText", "What do you want\nto toss away?"),
    );
    this.index = 0;
    this.top = 0;
    this.mode = "list";
  }

  /** Carry out the chosen action, and say when it could not be done. */
  private commit(id: string, n: number): void {
    const save = this.game.save;
    if (this.action === "deposit") {
      if (!Pc.deposit(save, id, n, this.game.data)) {
        this.game.showText(this.line("_NoRoomToStoreText", "No room left to\nstore items."));
      }
    } else if (this.action === "withdraw") {
      if (!Pc.withdraw(save, id, n, this.game.data)) {
        this.game.showText(this.line("_CantCarryMoreText", "You can't carry\nany more items."));
      } else {
        this.game.showText(
          this.line("_WithdrewItemText", "Withdrew\n{RAM:wNameBuffer}.")
            .replace(/\{RAM:\w+\}/g, this.name(id)),
        );
      }
    } else {
      Pc.tossFromPc(save, id, n);
    }
    // The list just changed under the cursor.
    const len = this.ids().length;
    if (this.index > len) this.index = Math.max(0, len);
    if (this.top > this.index) this.top = this.index;
    this.mode = this.ids().length === 0 ? "items" : "list";
  }

  update(): void {
    const p = this.game.input.pressed;
    if (this.mode === "root") return this.updateRoot(p);
    if (this.mode === "items") return this.updateItems(p);
    if (this.mode === "quantity") return this.updateQuantity(p);
    return this.updateList(p);
  }

  private updateRoot(p: PcGame["input"]["pressed"]): void {
    const n = ROOT.length;
    if (p.up) this.menuIndex = (this.menuIndex + n - 1) % n;
    if (p.down) this.menuIndex = (this.menuIndex + 1) % n;
    if (p.b) { this.close(); return; }
    if (!p.a) return;
    if (this.menuIndex === 0) {
      // SOMEONE'S PC is the Pokemon storage this tile used to open directly.
      this.game.showText(
        this.line("_AccessedSomeonesPCText", "Accessed someone's\nPC."),
        () => this.game.openBox(),
      );
      return;
    }
    if (this.menuIndex === 1) {
      this.game.showText(this.line("_AccessedMyPCText", "Accessed my PC."));
      this.itemsIndex = 0;
      this.mode = "items";
      return;
    }
    this.close();
  }

  private updateItems(p: PcGame["input"]["pressed"]): void {
    const n = ITEMS.length;
    if (p.up) this.itemsIndex = (this.itemsIndex + n - 1) % n;
    if (p.down) this.itemsIndex = (this.itemsIndex + 1) % n;
    if (p.b) { this.mode = "root"; return; }
    if (!p.a) return;
    if (this.itemsIndex === 0) this.startAction("withdraw");
    else if (this.itemsIndex === 1) this.startAction("deposit");
    else if (this.itemsIndex === 2) this.startAction("toss");
    else this.mode = "root";
  }

  private updateList(p: PcGame["input"]["pressed"]): void {
    const ids = this.ids();
    const n = ids.length + 1; // + CANCEL
    if (p.up) this.index = (this.index + n - 1) % n;
    if (p.down) this.index = (this.index + 1) % n;
    if (this.index < this.top) this.top = this.index;
    if (this.index >= this.top + ROWS) this.top = this.index - ROWS + 1;
    if (p.b || (p.a && this.index === n - 1)) { this.mode = "items"; return; }
    if (!p.a) return;
    const id = ids[this.index];
    if (!id) return;
    // One of a thing needs no counter; a stack gets the 1-99 chooser.
    if (this.held(id) <= 1) this.commit(id, 1);
    else { this.qty = 1; this.mode = "quantity"; }
  }

  private updateQuantity(p: PcGame["input"]["pressed"]): void {
    const id = this.ids()[this.index];
    if (!id) { this.mode = "list"; return; }
    const have = this.held(id);
    if (p.up) this.qty = Math.min(have, this.qty + 1);
    if (p.down) this.qty = Math.max(1, this.qty - 1);
    if (p.right) this.qty = Math.min(have, this.qty + 10);
    if (p.left) this.qty = Math.max(1, this.qty - 10);
    if (p.b) { this.mode = "list"; return; }
    if (p.a) this.commit(id, this.qty);
  }

  view(): PcView {
    const ids = this.mode === "root" || this.mode === "items" ? [] : this.ids();
    return {
      mode: this.mode,
      entries: ids.map((id) => ({ name: this.name(id), qty: this.held(id) })),
      index: this.index,
      top: this.top,
      rows: ROWS,
      labels: this.mode === "root" ? ROOT : this.mode === "items" ? ITEMS : [],
      qty: this.qty,
      action: this.action.toUpperCase(),
    };
  }

  /** Which menu row the cursor is on, for the renderer. */
  menuCursor(): number {
    return this.mode === "root" ? this.menuIndex : this.itemsIndex;
  }
}
