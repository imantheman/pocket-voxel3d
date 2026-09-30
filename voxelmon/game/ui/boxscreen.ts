// Bill's PC box storage, ported from src/ui/BoxMenu.lua (engine/pokemon/
// bills_pc.asm semantics via Boxes.ts): WITHDRAW / DEPOSIT / RELEASE / CHANGE
// BOX against the current box. The reference nests Menu > ListMenu > submenu >
// ChoiceBox screens; folded here into one state's sub-modes like the shop,
// with the flow, guards and text matching BoxMenu.lua. Yellow-only PRINT BOX
// and the Pikachu-happiness beat are dropped.
import type { GameState } from "../game.ts";
import type { PartyMon } from "../battle/mon.ts";
import * as Boxes from "../pokemon/boxes.ts";
import { SummaryState } from "./partyscreen.ts";
import { modifyHappiness } from "../world/pikachu.ts";

const ROWS = 4;
const PARTY_MAX = 6;

type Mode = "menu" | "list" | "submenu" | "confirm" | "message";
type ListKind = "withdraw" | "deposit" | "release" | "changebox";

export interface BoxRow {
  label: string;
  right: string;
}

export interface BoxView {
  mode: Mode;
  currentBox: number;
  menuIndex: number;
  list: BoxRow[];
  listIndex: number;
  listTop: number;
  rows: number;
  submenuLabel: string; // "WITHDRAW" | "DEPOSIT"
  submenuIndex: number;
  confirmYes: boolean;
  footer: string | null;
}

interface BoxGame {
  input: any;
  push(s: GameState): void;
  pop(): void;
  save: any;
  data: any;
  writeSave?(): void;
  playCry?(species: string): void;
}

const MENU = ["WITHDRAW", "DEPOSIT", "RELEASE", "CHANGE BOX", "SEE YA!"];

export class BoxState implements GameState {
  readonly kind = "box";
  private mode: Mode = "menu";
  private menuIndex = 0;
  private kindOfList: ListKind = "withdraw";
  private list: BoxRow[] = [];
  private listIndex = 0;
  private listTop = 0;
  private submenuIndex = 0;
  private confirmYes = false;
  private confirmKind: "release" | "changebox" = "release";
  private pendingBox = 1;
  private footer: string | null = null;
  private returnMode: "menu" | "list" | "release-list" = "menu";

  constructor(private game: BoxGame, private onQuit?: () => void) {
    Boxes.ensure(game.save);
  }

  private monName(mon: PartyMon): string {
    return mon.nickname ?? this.game.data.pokemon?.[mon.species]?.name ?? mon.species;
  }
  private monLabel(mon: PartyMon): string {
    return `${this.monName(mon)} <LV>${mon.level}`;
  }
  private cry(mon: PartyMon): void {
    this.game.playCry?.(mon.species);
  }
  private quit(): void {
    this.game.pop();
    this.onQuit?.();
  }

  private box(): PartyMon[] {
    return Boxes.active(this.game.save);
  }
  private party(): PartyMon[] {
    return (this.game.save.party ?? []) as PartyMon[];
  }

  private toMessage(text: string, ret: "menu" | "list" | "release-list"): void {
    this.footer = text;
    this.returnMode = ret;
    this.mode = "message";
  }

  private openList(kind: ListKind): void {
    this.kindOfList = kind;
    this.listIndex = 0;
    this.listTop = 0;
    if (kind === "changebox") {
      const boxes = Boxes.ensure(this.game.save);
      this.list = boxes.map((b, i) => ({
        label: `${i + 1 === this.game.save.currentBox ? "*" : " "}BOX ${i + 1}`,
        right: `${b.length}/${Boxes.BOX_CAPACITY}`,
      }));
    } else if (kind === "deposit") {
      this.list = this.party().map((m) => ({ label: this.monLabel(m), right: "" }));
    } else {
      this.list = this.box().map((m) => ({ label: this.monLabel(m), right: "" }));
    }
    this.mode = "list";
  }

  update(): void {
    const p = this.game.input.pressed;
    if (this.mode === "menu") return this.updateMenu(p);
    if (this.mode === "list") return this.updateList(p);
    if (this.mode === "submenu") return this.updateSubmenu(p);
    if (this.mode === "confirm") return this.updateConfirm(p);
    if (this.mode === "message") {
      if (p.a || p.b) {
        if (this.returnMode === "release-list") this.rebuildAfterRelease();
        else this.mode = this.returnMode;
      }
      return;
    }
  }

  private updateMenu(p: any): void {
    const n = MENU.length;
    if (p.up) this.menuIndex = (this.menuIndex + n - 1) % n;
    if (p.down) this.menuIndex = (this.menuIndex + 1) % n;
    if (p.b) { this.quit(); return; }
    if (!p.a) return;
    switch (this.menuIndex) {
      case 0: // WITHDRAW
        if (this.box().length === 0) return this.toMessage("What? There are\nno POKéMON here!", "menu");
        if (this.party().length >= PARTY_MAX) {
          return this.toMessage("You can't take\nany more POKéMON.", "menu");
        }
        return this.openList("withdraw");
      case 1: // DEPOSIT
        if (this.party().length <= 1) return this.toMessage("You can't deposit\nthe last POKéMON!", "menu");
        if (this.box().length >= Boxes.BOX_CAPACITY) {
          return this.toMessage("Oops! This Box is\nfull of POKéMON.", "menu");
        }
        return this.openList("deposit");
      case 2: // RELEASE
        if (this.box().length === 0) return this.toMessage("What? There are\nno POKéMON here!", "menu");
        return this.openList("release");
      case 3: // CHANGE BOX
        return this.openList("changebox");
      default: // SEE YA!
        return this.quit();
    }
  }

  private clampWindow(): void {
    if (this.listIndex < this.listTop) this.listTop = this.listIndex;
    if (this.listIndex >= this.listTop + ROWS) this.listTop = this.listIndex - ROWS + 1;
  }

  private updateList(p: any): void {
    const n = this.list.length + 1; // + CANCEL
    if (p.up) this.listIndex = (this.listIndex + n - 1) % n;
    if (p.down) this.listIndex = (this.listIndex + 1) % n;
    this.clampWindow();
    if (p.b || (p.a && this.listIndex === this.list.length)) { this.mode = "menu"; return; }
    if (!(p.a && this.listIndex < this.list.length)) return;

    if (this.kindOfList === "changebox") {
      this.pendingBox = this.listIndex + 1;
      this.confirmKind = "changebox";
      this.confirmYes = false;
      this.footer = "When you change a\nPOKéMON BOX, data\nwill be saved. OK?";
      this.mode = "confirm";
      return;
    }
    if (this.kindOfList === "release") {
      this.confirmKind = "release";
      this.confirmYes = false; // defaultNo
      const mon = this.box()[this.listIndex]!;
      this.footer = `Once released,\n${this.monName(mon)} is\ngone forever. OK?`;
      this.mode = "confirm";
      return;
    }
    // withdraw / deposit -> per-mon submenu
    this.submenuIndex = 0;
    this.mode = "submenu";
  }

  private updateSubmenu(p: any): void {
    if (p.up) this.submenuIndex = (this.submenuIndex + 2) % 3;
    if (p.down) this.submenuIndex = (this.submenuIndex + 1) % 3;
    if (p.b) { this.mode = "list"; return; }
    if (!p.a) return;
    if (this.submenuIndex === 0) return this.doTransfer();
    if (this.submenuIndex === 1) { // STATS
      const mon = this.kindOfList === "deposit"
        ? this.party()[this.listIndex]
        : this.box()[this.listIndex];
      if (mon) this.game.push(new SummaryState(this.game as any, -1, mon));
      return;
    }
    this.mode = "list"; // CANCEL
  }

  private doTransfer(): void {
    if (this.kindOfList === "withdraw") {
      const box = this.box();
      const mon = box[this.listIndex];
      if (!mon) { this.mode = "list"; return; }
      if (this.party().length >= PARTY_MAX) return this.toMessage("The party is full!", "list");
      box.splice(this.listIndex, 1);
      this.party().push(mon);
      this.cry(mon);
      this.toMessage(`${this.monName(mon)} is\ntaken out.`, "menu");
    } else {
      const mon = this.party()[this.listIndex];
      if (!mon) { this.mode = "list"; return; }
      if (this.party().length <= 1) return this.toMessage("You need at least\none POKéMON!", "list");
      const box = this.box();
      if (box.length >= Boxes.BOX_CAPACITY) {
        return this.toMessage(`BOX ${this.game.save.currentBox} is full!`, "list");
      }
      this.party().splice(this.listIndex, 1);
      box.push(mon);
      // PIKAHAPPY_DEPOSITED: Pikachu does not like the PC
      modifyHappiness(this.game.save, "DEPOSITED", mon);
      this.cry(mon);
      this.toMessage(`${this.monName(mon)} was\nstored in Box ${this.game.save.currentBox}.`, "menu");
    }
  }

  private updateConfirm(p: any): void {
    if (p.up || p.down) this.confirmYes = !this.confirmYes;
    if (p.b) { this.mode = "list"; return; }
    if (!p.a) return;
    if (!this.confirmYes) { this.mode = "list"; return; }
    if (this.confirmKind === "changebox") {
      this.game.save.currentBox = this.pendingBox;
      this.game.writeSave?.();
      this.mode = "menu";
      return;
    }
    // release
    const box = this.box();
    const mon = box[this.listIndex];
    if (!mon) { this.mode = "list"; return; }
    box.splice(this.listIndex, 1);
    this.cry(mon);
    this.toMessage(`${this.monName(mon)} was\nreleased outside.\nBye ${this.monName(mon)}!`, "release-list");
  }

  private rebuildAfterRelease(): void {
    if (this.box().length === 0) { this.mode = "menu"; return; }
    this.openList("release");
    this.listIndex = Math.max(0, Math.min(this.listIndex, this.list.length - 1));
    this.clampWindow();
  }

  view(): BoxView {
    return {
      mode: this.mode,
      currentBox: this.game.save.currentBox ?? 1,
      menuIndex: this.menuIndex,
      list: this.list,
      listIndex: this.listIndex,
      listTop: this.listTop,
      rows: ROWS,
      submenuLabel: this.kindOfList === "deposit" ? "DEPOSIT" : "WITHDRAW",
      submenuIndex: this.submenuIndex,
      confirmYes: this.confirmYes,
      footer: this.footer,
    };
  }
}
