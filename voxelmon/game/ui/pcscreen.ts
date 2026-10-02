// The PC. Ports engine/menus/pc.asm's two menus: the machine's own list
// (SOMEONE'S PC, or BILL'S PC once he is met / {PLAYER}'s PC / PROF.OAK'S PC
// once the POKéDEX is in hand / PKMN LEAGUE once a team is in the HALL OF
// FAME / LOG OFF -- DisplayPCMainMenu) and, inside the player's, the
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
  showChoice?(text: string, cb: (yes: boolean) => void): void;
  openDexRating?(onDone?: () => void): void;
  openHallOfFamePc?(onDone?: () => void): void;
}

type RootId = "someone" | "mine" | "oak" | "league" | "logoff";
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
      // players_pc.asm's own IsKeyItem check: the PC will not toss one
      // either, and it says so rather than quietly doing nothing.
      if (Bag.precious(this.game.data, id)) {
        this.game.showText(
          this.line("_TooImportantToTossText", "That's too impor-\ntant to toss!"),
        );
      } else {
        Pc.tossFromPc(save, id, n);
      }
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

  /** DisplayPCMainMenu's rows for this save. */
  private rootRows(): { id: RootId; label: string }[] {
    const flags = this.game.save?.flags ?? {};
    const rows: { id: RootId; label: string }[] = [
      { id: "someone", label: flags.EVENT_MET_BILL ? "BILL'S PC" : "SOMEONE'S PC" },
      { id: "mine", label: "MY PC" },
    ];
    if (flags.EVENT_GOT_POKEDEX) {
      rows.push({ id: "oak", label: "PROF.OAK'S PC" });
      // wNumHoFTeams, inside the POKéDEX check as on the cart
      if ((this.game.save?.hallOfFame?.length ?? 0) > 0) rows.push({ id: "league", label: "PKMN LEAGUE" });
    }
    rows.push({ id: "logoff", label: "LOG OFF" });
    return rows;
  }

  private rootLabels(): string[] {
    return this.rootRows().map((r) => r.label);
  }

  private updateRoot(p: PcGame["input"]["pressed"]): void {
    const rows = this.rootRows();
    const n = rows.length;
    if (this.menuIndex >= n) this.menuIndex = n - 1;
    if (p.up) this.menuIndex = (this.menuIndex + n - 1) % n;
    if (p.down) this.menuIndex = (this.menuIndex + 1) % n;
    if (p.b) { this.close(); return; }
    if (!p.a) return;
    const id = rows[this.menuIndex]!.id;
    if (id === "someone") {
      // SOMEONE'S PC is the Pokemon storage this tile used to open directly.
      const met = this.game.save?.flags?.EVENT_MET_BILL;
      this.game.showText(
        met
          ? this.line("_AccessedBillsPCText", "Accessed BILL's\nPC.\fAccessed POKéMON\nStorage System.")
          : this.line("_AccessedSomeonesPCText", "Accessed someone's\nPC."),
        () => this.game.openBox(),
      );
      return;
    }
    if (id === "mine") {
      this.game.showText(this.line("_AccessedMyPCText", "Accessed my PC."));
      this.itemsIndex = 0;
      this.mode = "items";
      return;
    }
    if (id === "oak") return this.openOaksPc();
    if (id === "league") {
      // PKMNLeaguePC: the list, then back to this menu
      this.game.showText(
        this.line("_AccessedHoFPCText", "Accessed POKéMON\nLEAGUE's site.\fAccessed the HALL\nOF FAME List."),
        () => this.game.openHallOfFamePc?.(),
      );
      return;
    }
    this.close();
  }

  /** OpenOaksPC (engine/menus/oaks_pc.asm): accessed, rate? YES rates, closed. */
  private openOaksPc(): void {
    const closed = (): void => this.game.showText(this.line("_ClosedOaksPCText", "Closed link to\nPROF.OAK's PC."));
    this.game.showText(this.line("_AccessedOaksPCText", "Accessed PROF.\nOAK's PC."), () => {
      if (!this.game.showChoice) return closed();
      this.game.showChoice(this.line("_GetDexRatedText", "Want to get your\nPOKéDEX rated?"), (yes) => {
        if (yes && this.game.openDexRating) this.game.openDexRating(closed);
        else closed();
      });
    });
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
    // One of a thing needs no counter, and neither does a key item or an
    // HM: DisplayChooseQuantityMenu is skipped for those (players_pc.asm).
    if (this.held(id) <= 1 || Bag.precious(this.game.data, id)) this.commit(id, 1);
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

  /** The Kanto Gear's touch mirror for the two menus (not the item lists,
   * which scroll and take a quantity). */
  gearMenu(): { title: string; items: string[]; index: number; select(i: number): void } | null {
    if (this.mode === "root") {
      return { title: "PC", items: this.rootLabels(), index: this.menuIndex, select: (i: number) => { this.menuIndex = i; } };
    }
    if (this.mode === "items") {
      return { title: "MY PC", items: ITEMS, index: this.itemsIndex, select: (i: number) => { this.itemsIndex = i; } };
    }
    return null;
  }

  view(): PcView {
    const ids = this.mode === "root" || this.mode === "items" ? [] : this.ids();
    return {
      mode: this.mode,
      entries: ids.map((id) => ({ name: this.name(id), qty: this.held(id) })),
      index: this.index,
      top: this.top,
      rows: ROWS,
      labels: this.mode === "root" ? this.rootLabels() : this.mode === "items" ? ITEMS : [],
      qty: this.qty,
      action: this.action.toUpperCase(),
    };
  }

  /** Which menu row the cursor is on, for the renderer. */
  menuCursor(): number {
    return this.mode === "root" ? this.menuIndex : this.itemsIndex;
  }
}
