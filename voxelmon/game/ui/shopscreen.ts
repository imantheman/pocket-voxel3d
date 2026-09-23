// Poké Mart, ported from src/ui/ShopMenu.lua (engine/events/pokemart.asm
// DisplayPokemartDialogue_). BUY/SELL/QUIT loops until QUIT; BUY and SELL each
// drop into a list, then a 1-99 quantity chooser (DisplayChooseQuantityMenu)
// and a YES/NO price confirm. The reference nests ListMenu > QuantityBox >
// ChoiceBox screens; this port folds those into one state's sub-modes since
// the TS port hand-rolls its menus rather than sharing a ListMenu, but the
// flow, prices, prompts and guards match ShopMenu.lua exactly.
import type { GameState } from "../game.ts";
import * as Bag from "../rules/bag.ts";

const ROWS = 4;
const MONEY_CAP = 999999;

// ShopMenu.lua footer strings (romText fallbacks kept verbatim).
const GREET = "Take your time.";
const NOT_ENOUGH = "You don't have\nenough money.";
const BAG_FULL = "You can't carry\nany more items.";
const UNSELLABLE = "I can't put a\nprice on that.";
const BOUGHT = "Here you are!\nThank you!";
// VendingMachineText's own line -- the machine has no clerk to thank you.
const POPPED = (name: string) => `${name}\npopped out!`;
const SOLD = "Thank you!";

export type ShopMode = "menu" | "list" | "quantity" | "confirm";

export interface ShopRow {
  id: string;
  label: string;
  right: string;
}

export interface ShopView {
  mode: ShopMode;
  money: number;
  menuIndex: number; // 0 BUY, 1 SELL, 2 QUIT
  buying: boolean;
  list: ShopRow[];
  listIndex: number;
  listTop: number;
  rows: number;
  selName: string;
  qty: number;
  total: number;
  confirmYes: boolean;
  footer: string | null;
}

interface ShopGame {
  input: any;
  pop(): void;
  save: any;
  data: any;
}

export class ShopState implements GameState {
  readonly kind = "shop";
  private mode: ShopMode = "menu";
  private menuIndex = 0;
  private buying = true;
  private list: ShopRow[] = [];
  private listIndex = 0;
  private listTop = 0;
  private selId = "";
  private selName = "";
  private unitPrice = 0;
  private maxQty = 1;
  private qty = 1;
  private confirmYes = true;
  private footer: string | null = null;

  /**
   * `vending` is the Celadon rooftop machine (world/vending.ts): the same
   * list and the same money, without the parts a machine does not have --
   * no BUY/SELL/QUIT menu to pick BUY from, no clerk's greeting, and no
   * quantity box, because a machine drops one can per coin slot.
   */
  constructor(
    private game: ShopGame,
    private stock: string[],
    private onQuit?: () => void,
    private vending = false,
  ) {
    if (vending) {
      this.buying = true;
      this.buildBuyList();
      this.mode = "list";
      this.footer = null;
    }
  }

  /** The clerk's idle line, which a vending machine does not say. */
  private get greeting(): string | null {
    return this.vending ? null : GREET;
  }

  private name(id: string): string {
    return this.game.data.items?.[id]?.name ?? id;
  }
  private price(id: string): number {
    return this.game.data.items?.[id]?.price ?? 0;
  }

  private quit(): void {
    this.game.pop();
    this.onQuit?.();
  }

  // buy(game, stock): stock -> { label, right = "¥price" }.
  private buildBuyList(): void {
    this.list = this.stock
      .filter((id) => this.game.data.items?.[id])
      .map((id) => ({ id, label: this.name(id), right: `\u00a5${this.price(id)}` }));
    this.listIndex = 0;
    this.listTop = 0;
    this.footer = this.greeting;
  }

  // sell(game): Bag.order -> { label, right = "xN" } (no price in the label,
  // pokemart.asm .sellMenuLoop clears wPrintItemPrices; issue #116).
  private buildSellList(): void {
    this.list = Bag.order(this.game.save).map((id) => ({
      id,
      label: this.name(id),
      right: `x${this.game.save.inventory?.[id] ?? 0}`,
    }));
    this.listIndex = 0;
    this.listTop = 0;
    this.footer = this.greeting;
  }

  private clampWindow(): void {
    if (this.listIndex < this.listTop) this.listTop = this.listIndex;
    if (this.listIndex >= this.listTop + ROWS) this.listTop = this.listIndex - ROWS + 1;
  }

  private unsellable(id: string): boolean {
    // pokemart.asm IsKeyItem / IsItemHM (rules/bag.ts precious). This used
    // to stand on a `tossable === false` proxy because the item records had
    // no key-item flag -- and no record sets `tossable` at all, so the
    // clerk would buy the TOWN MAP, the POKeDEX, every badge.
    return Bag.precious(this.game.data, id);
  }

  update(): void {
    const p = this.game.input.pressed;

    if (this.mode === "menu") {
      if (p.up) this.menuIndex = (this.menuIndex + 2) % 3;
      if (p.down) this.menuIndex = (this.menuIndex + 1) % 3;
      if (p.b) { this.quit(); return; }
      if (p.a) {
        if (this.menuIndex === 0) { this.buying = true; this.buildBuyList(); this.mode = "list"; }
        else if (this.menuIndex === 1) { this.buying = false; this.buildSellList(); this.mode = "list"; }
        else this.quit();
      }
      return;
    }

    if (this.mode === "list") {
      const n = this.list.length + 1; // + CANCEL
      if (p.up) this.listIndex = (this.listIndex + n - 1) % n;
      if (p.down) this.listIndex = (this.listIndex + 1) % n;
      this.clampWindow();
      if (p.b || (p.a && this.listIndex === this.list.length)) {
        if (this.vending) { this.quit(); return; }
        this.mode = "menu";
        this.footer = null;
        return;
      }
      if (p.a && this.listIndex < this.list.length) this.chooseItem(this.list[this.listIndex]!);
      return;
    }

    if (this.mode === "quantity") {
      if (p.up) this.qty = Math.min(this.maxQty, this.qty + 1);
      if (p.down) this.qty = Math.max(1, this.qty - 1);
      if (p.right) this.qty = Math.min(this.maxQty, this.qty + 10);
      if (p.left) this.qty = Math.max(1, this.qty - 10);
      if (p.b) { this.mode = "list"; this.footer = this.greeting; return; }
      if (p.a) {
        const total = this.unitPrice * this.qty;
        this.footer = this.buying
          ? `${this.selName}?\nThat will be\n\u00a5${total}. OK?`
          : `I can pay you\n\u00a5${total} for that.`;
        this.confirmYes = true;
        this.mode = "confirm";
      }
      return;
    }

    if (this.mode === "confirm") {
      if (p.up || p.down) this.confirmYes = !this.confirmYes;
      if (p.b) { this.mode = "list"; this.footer = this.greeting; return; }
      if (p.a) {
        if (this.confirmYes) this.commit();
        else { this.mode = "list"; this.footer = this.greeting; }
      }
      return;
    }
  }

  private chooseItem(row: ShopRow): void {
    const save = this.game.save;
    if (this.buying) {
      const price = this.price(row.id);
      if ((save.money ?? 0) < price) { this.footer = NOT_ENOUGH; return; }
      this.selId = row.id;
      this.selName = row.label;
      this.unitPrice = price;
      this.maxQty = Math.min(99, Math.floor((save.money ?? 0) / Math.max(1, price)));
      this.qty = 1;
      this.mode = "quantity";
      if (this.vending) {
        this.maxQty = 1;
        this.footer = `${this.selName}?\nThat will be\n\u00a5${price}. OK?`;
        this.confirmYes = true;
        this.mode = "confirm";
      }
    } else {
      if (this.unsellable(row.id)) { this.footer = UNSELLABLE; return; }
      this.selId = row.id;
      this.selName = row.label;
      this.unitPrice = Math.floor(this.price(row.id) / 2);
      this.maxQty = save.inventory?.[row.id] ?? 1;
      this.qty = 1;
      this.mode = "quantity";
    }
  }

  private commit(): void {
    const save = this.game.save;
    const total = this.unitPrice * this.qty;
    if (this.buying) {
      if ((save.money ?? 0) < total) { this.footer = NOT_ENOUGH; this.mode = "list"; return; }
      if (!Bag.add(save, this.selId, this.qty, this.game.data)) {
        this.footer = BAG_FULL;
        this.mode = "list";
        return;
      }
      save.money = (save.money ?? 0) - total;
      this.footer = this.vending ? POPPED(this.selName) : BOUGHT;
    } else {
      save.money = Math.min(MONEY_CAP, (save.money ?? 0) + total);
      Bag.remove(save, this.selId, this.qty);
      this.buildSellList(); // rebuild: sold-out rows drop, others show new "xN"
      this.footer = SOLD; // (buildSellList reset it to GREET; set the result)
    }
    this.mode = "list";
  }

  view(): ShopView {
    return {
      mode: this.mode,
      money: this.game.save.money ?? 0,
      menuIndex: this.menuIndex,
      buying: this.buying,
      list: this.list,
      listIndex: this.listIndex,
      listTop: this.listTop,
      rows: ROWS,
      selName: this.selName,
      qty: this.qty,
      total: this.unitPrice * this.qty,
      confirmYes: this.confirmYes,
      footer: this.footer,
    };
  }
}
