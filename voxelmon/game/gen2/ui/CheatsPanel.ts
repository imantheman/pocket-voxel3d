// The bottom screen's CHEATS page (ui/Companion.ts draws it under the "!"
// tab, which is there while OPTION's CHEATS row is ON). Not the cart's: the
// settings and what each one does are core/Cheats.ts; the row names are the
// Kanto games' (the green gear's CHEATS page) where the two share a cheat.
// Drawn in the panel's own style -- labels from column 1, values
// right-aligned to column 18 (the mon pages' edge), a label too long to share its row with its
// value has the value on the row below, groups a row apart -- and worked by
// touch alone:
//
//   row 0      the title, CHEATS, where the other pages name the place
//   row 1      the time and the money, as on every page
//   rows 3-9   WILD ENCOUNTERS (its value below it), SHINY ODDS,
//              ALWAYS CATCH, INSTANT WIN, FAST EGGS, INFINITE MONEY: a tap
//              on a row steps its value
//   rows 11-12 DEX FULL (SET, then "FILL THE POKéDEX?" YES/NO) and GIVE
//              ITEMS (OPEN: a pocket's items eight at a time, what the PACK
//              holds of each on the right; an item's own page with its
//              QUANTITY, then BACK | GIVE, then "GIVE 10 POTION?" YES/NO)
//   row 13     clear, above the tabs, as on the other pages
//
// The one-shot actions only run while the overworld itself has the frame
// (no menu or text open over it), so nothing on the top screen is showing a
// bag or a dex that has just changed under it.

import { Chrome } from "./Chrome.ts";
import { Cheats, SHINY_ODDS, WILD_RATES, WILD_RATE_LABELS } from "../core/Cheats.ts";

const COLS = 20;
/** Where values end: printRight's edge, one column in from the screen's. */
const RIGHT = COLS - 1;
type View = "list" | "dex" | "items" | "qty" | "give" | "message";

interface Row {
  label: string;
  /** The value's text, and the widest it can be (measured up front). */
  value: (o: Record<string, any>) => string;
  widest: number;
  tap: (panel: CheatsPanel, game: any) => void;
  /** The row it starts on. */
  y: number;
}

const onOff = (key: string) => (o: Record<string, any>): string => (o[key] === true ? "ON" : "OFF");
const toggle = (key: string) => (panel: CheatsPanel, game: any): void => {
  game.options[key] = game.options[key] !== true;
  panel.changed(game, key);
};

/** The page: the settings, then the two actions a row apart. */
const ROWS: Row[] = [
  {
    label: "WILD ENCOUNTERS", widest: 6, y: 3,
    value: (o) => WILD_RATE_LABELS[Cheats.wildRate(o)],
    tap: (panel, game) => {
      game.options.wildEncounters = Cheats.step(WILD_RATES, Cheats.wildRate(game.options), 1);
      panel.changed(game, "wildEncounters");
    },
  },
  {
    label: "SHINY ODDS", widest: 6, y: 5,
    value: (o) => `1/${Cheats.shinyOdds(o)}`,
    tap: (panel, game) => {
      game.options.shinyOdds = Cheats.step(SHINY_ODDS, Cheats.shinyOdds(game.options), 1);
      panel.changed(game, "shinyOdds");
    },
  },
  { label: "ALWAYS CATCH", widest: 3, y: 6, value: onOff("alwaysCatch"), tap: toggle("alwaysCatch") },
  { label: "INSTANT WIN", widest: 3, y: 7, value: onOff("instantVictory"), tap: toggle("instantVictory") },
  { label: "FAST EGGS", widest: 3, y: 8, value: onOff("fastEggs"), tap: toggle("fastEggs") },
  { label: "INFINITE MONEY", widest: 3, y: 9, value: onOff("infiniteMoney"), tap: toggle("infiniteMoney") },
  { label: "DEX FULL", widest: 3, y: 11, value: () => "SET", tap: (p) => p.go("dex") },
  { label: "GIVE ITEMS", widest: 4, y: 12, value: () => "OPEN", tap: (p) => p.go("items") },
];

/** Whether a row's value goes on the row below its label. */
const twoLine = (r: Row): boolean => 1 + r.label.length + 1 + r.widest > RIGHT;
const rowsOf = (r: Row): number => (twoLine(r) ? 2 : 1);

/** The item list's pockets: label, first column (its cursor one left). */
const POCKETS: { pocket: string; label: string; x: number }[] = [
  { pocket: "ITEM", label: "ITEM", x: 2 },
  { pocket: "BALL", label: "BALL", x: 7 },
  { pocket: "KEY_ITEM", label: "KEY", x: 12 },
  { pocket: "TM_HM", label: "TM", x: 16 },
];
const LIST_TOP = 4;
const LIST_ROWS = 8;
const NAV_ROW = 12;
/** The two boxes along the bottom (YES / NO, BACK / GIVE): the battle
 *  panel's pair, four rows high, a row clear of the tabs. */
const BOX_ROW = 9;
/** The QUANTITY row's controls: a step down, the presets, a step up. */
const QTY_ROW = 8;
const QTY: { label: string; x: number; set: (q: number) => number }[] = [
  { label: "-", x: 1, set: (q) => q - 1 },
  { label: "1", x: 4, set: () => 1 },
  { label: "10", x: 7, set: () => 10 },
  { label: "50", x: 11, set: () => 50 },
  { label: "99", x: 15, set: () => 99 },
  { label: "+", x: 18, set: (q) => q + 1 },
];

/** `text` cut with an ellipsis to `room` tiles. */
function fit(text: string, room: number): string {
  return text.length > room ? `${text.slice(0, Math.max(0, room - 1))}…` : text;
}

export class CheatsPanel {
  view: View = "list";
  pocket = "ITEM";
  scroll = 0;
  item = "";
  qty = 1;
  message: string[] = [];
  /** Where the message's tap goes. */
  back: View = "list";

  /** A setting changed: kept in this game's options file at once. */
  changed(game: any, key: string): void {
    console.log(`[pv] gold cheats: ${key} = ${String(game.options[key])}`);
    game.persistOptions?.();
  }

  go(view: View): void {
    this.view = view;
  }

  /** The overworld has the frame: nothing on the stack, no script running. */
  private idle(game: any): boolean {
    if (game?.stack?.top?.()) return false;
    const world = game?.world;
    return !!world && (typeof world.acceptsMenuInput !== "function" || !!world.acceptsMenuInput());
  }

  private say(lines: string[], back: View): void {
    this.message = lines;
    this.back = back;
    this.view = "message";
  }

  private itemsOf(game: any): string[] {
    return Cheats.itemsIn(game?.data, this.pocket);
  }

  private itemName(game: any, id: string): string {
    return String(game?.data?.items?.[id]?.name ?? id);
  }

  private count(table: unknown, id: string): number {
    const t = table as Record<string, number> | undefined;
    return (t && t[id]) || 0;
  }

  /** How many the item page will give. */
  private giving(game: any): number {
    return Math.min(this.qty, Cheats.maxGive(game?.save, game?.data, this.item));
  }

  /** What the page shows, for Companion's change check. */
  signature(game: any): string {
    const o = game?.options ?? {};
    let s = `C|${this.view}|${this.pocket}|${this.scroll}|${this.item}|${this.qty}|${this.message.join("/")}`;
    if (this.view === "list") for (const r of ROWS) s += `|${r.value(o)}`;
    const inv = game?.save?.inventory ?? {};
    if (this.view === "items") {
      for (const id of this.itemsOf(game).slice(this.scroll * LIST_ROWS, (this.scroll + 1) * LIST_ROWS)) s += `|${this.count(inv, id)}`;
    }
    if (this.view === "qty") s += `|${this.count(inv, this.item)}|${this.count(game?.save?.pcItems, this.item)}`;
    return s;
  }

  // ------------------------------------------------------------------ taps

  /** A tap at cell (cx, cy) of the page (rows 0-13). */
  tap(game: any, cx: number, cy: number): void {
    if (this.view === "message") {
      this.view = this.back;
      return;
    }
    if (this.view === "list") {
      for (const r of ROWS) if (cy >= r.y && cy < r.y + rowsOf(r)) return r.tap(this, game);
      return;
    }
    if (this.view === "dex") return this.dexTap(game, cx, cy);
    if (this.view === "items") return this.itemsTap(game, cx, cy);
    if (this.view === "qty") return this.qtyTap(game, cx, cy);
    if (this.view === "give") return this.giveTap(game, cx, cy);
  }

  /** The left box (YES, BACK) or the right one (NO, GIVE), or neither. */
  private box(cx: number, cy: number): "left" | "right" | undefined {
    if (cy < BOX_ROW || cy >= BOX_ROW + 4) return undefined;
    return cx < 10 ? "left" : "right";
  }

  private dexTap(game: any, cx: number, cy: number): void {
    const b = this.box(cx, cy);
    if (!b) return;
    if (b === "right") {
      this.view = "list";
      return;
    }
    if (!this.idle(game)) return this.say(["Close the menu", "first."], "list");
    const n = Cheats.fillDex(game.save, game.data, true);
    console.log(`[pv] gold cheats: dex full (${n})`);
    this.say([`All ${n} are`, "seen and owned."], "list");
  }

  private itemsTap(game: any, cx: number, cy: number): void {
    if (cy === 0) {
      if (cx >= 14) this.view = "list";
      return;
    }
    const items = this.itemsOf(game);
    const pages = Math.max(1, Math.ceil(items.length / LIST_ROWS));
    if (cy === 3) {
      for (const p of POCKETS) {
        if (cx >= p.x - 1 && cx < p.x + p.label.length && p.pocket !== this.pocket) {
          this.pocket = p.pocket;
          this.scroll = 0;
        }
      }
      return;
    }
    if (cy === NAV_ROW) {
      this.scroll = (this.scroll + (cx < 10 ? pages - 1 : 1)) % pages;
      return;
    }
    const id = items[this.scroll * LIST_ROWS + (cy - LIST_TOP)];
    if (cy >= LIST_TOP && cy < LIST_TOP + LIST_ROWS && id) {
      this.item = id;
      this.qty = 1;
      this.view = "qty";
    }
  }

  private qtyTap(game: any, cx: number, cy: number): void {
    if (cy === 0) {
      if (cx >= 14) this.view = "items";
      return;
    }
    const max = Cheats.maxGive(game.save, game.data, this.item);
    if (cy === QTY_ROW && max > 1) {
      // the control nearest the finger
      let best = QTY[0]!;
      for (const q of QTY) if (Math.abs(cx - (q.x + (q.label.length - 1) / 2)) < Math.abs(cx - (best.x + (best.label.length - 1) / 2))) best = q;
      this.qty = Math.max(1, Math.min(max, best.set(this.qty)));
      return;
    }
    const b = this.box(cx, cy);
    if (b === "left") this.view = "items";
    else if (b === "right") {
      if (max === 0) return this.say(["You already have", "that one."], "qty");
      this.view = "give";
    }
  }

  private giveTap(game: any, cx: number, cy: number): void {
    const b = this.box(cx, cy);
    if (!b) return;
    if (b === "right") {
      this.view = "qty";
      return;
    }
    if (!this.idle(game)) return this.say(["Close the menu", "first."], "qty");
    const got = Cheats.giveItem(game.save, game.data, this.item, this.giving(game));
    console.log(`[pv] gold cheats: give ${this.item} x${this.qty}: pack ${got.bag}, pc ${got.pc}${got.short ? `, ${got.short}` : ""}`);
    if (got.bag + got.pc === 0) return this.say(["The PACK and the", "PC are full."], "items");
    const lines = got.pc === 0
      ? [`Put ${got.bag} in`, "the PACK."]
      : got.bag === 0
        ? [`Put ${got.pc} in`, "the PC."]
        : [`${got.bag} in the PACK,`, `${got.pc} in the PC.`];
    this.say(lines, "items");
  }

  // ------------------------------------------------------------------ draw

  draw(game: any): void {
    const o = game?.options ?? {};
    if (this.view === "list") {
      Chrome.print("CHEATS", 0, 0);
      for (const r of ROWS) {
        Chrome.print(r.label, 1, r.y);
        Chrome.printRight(r.value(o), RIGHT, twoLine(r) ? r.y + 1 : r.y);
      }
      return;
    }
    if (this.view === "dex") {
      Chrome.print("CHEATS", 0, 0);
      this.textBox(["FILL THE POKéDEX?"]);
      this.boxes("YES", "NO");
      return;
    }
    if (this.view === "message") {
      Chrome.print(this.back === "list" ? "CHEATS" : "GIVE ITEMS", 0, 0);
      this.textBox(this.message);
      Chrome.print("▼", 18, 7);
      return;
    }
    // the item views share their title row
    Chrome.print("GIVE ITEMS", 0, 0);
    if (this.view !== "give") Chrome.printRight("BACK", RIGHT, 0);
    if (this.view === "items") this.drawItems(game);
    else if (this.view === "qty") this.drawQty(game);
    else {
      // "GIVE 10 POTION?" on one line when it fits, else the name below
      const n = this.giving(game);
      const name = this.itemName(game, this.item);
      const one = `GIVE ${n} ${name}?`;
      this.textBox(one.length <= COLS - 2 ? [one] : [`GIVE ${n}`, `${name}?`]);
      this.boxes("YES", "NO");
    }
  }

  /** The battle panel's text box, rows 2-7, two lines a row apart. */
  private textBox(lines: string[]): void {
    Chrome.box(0, 2, COLS, 6);
    lines.slice(0, 2).forEach((line, i) => Chrome.print(fit(line, COLS - 2), 1, 4 + i * 2));
  }

  private boxes(left: string, right: string): void {
    [left, right].forEach((label, k) => {
      const x = k * 10;
      Chrome.box(x, BOX_ROW, 10, 4);
      Chrome.print(label, x + 2, BOX_ROW + 2);
    });
  }

  private drawItems(game: any): void {
    for (const p of POCKETS) {
      Chrome.print(p.label, p.x, 3);
      if (p.pocket === this.pocket) Chrome.cursor(p.x - 1, 3);
    }
    const items = this.itemsOf(game);
    const pages = Math.max(1, Math.ceil(items.length / LIST_ROWS));
    if (this.scroll >= pages) this.scroll = 0;
    const inv = game?.save?.inventory ?? {};
    for (let k = 0; k < LIST_ROWS; k++) {
      const id = items[this.scroll * LIST_ROWS + k];
      if (!id) break;
      const have = this.count(inv, id);
      const qty = have > 0 ? `×${have}` : "";
      Chrome.print(fit(this.itemName(game, id), RIGHT - 1 - (qty ? qty.length + 1 : 0)), 1, LIST_TOP + k);
      if (qty) Chrome.printRight(qty, RIGHT, LIST_TOP + k);
    }
    Chrome.print("PREV", 1, NAV_ROW);
    const at = `${this.scroll + 1}/${pages}`;
    Chrome.print(at, Math.floor((COLS - at.length) / 2), NAV_ROW);
    Chrome.printRight("NEXT", RIGHT, NAV_ROW);
  }

  private drawQty(game: any): void {
    const save = game?.save ?? {};
    const max = Cheats.maxGive(save, game?.data, this.item);
    Chrome.print(fit(this.itemName(game, this.item), RIGHT - 1), 1, 3);
    const line = (label: string, value: string, row: number): void => {
      Chrome.print(label, 1, row);
      Chrome.printRight(value, RIGHT, row);
    };
    line("IN PACK", `×${this.count(save.inventory, this.item)}`, 4);
    line("IN PC", `×${this.count(save.pcItems, this.item)}`, 5);
    line("QUANTITY", max === 0 ? "-" : `×${this.giving(game)}`, 7);
    if (max > 1) for (const q of QTY) Chrome.print(q.label, q.x, QTY_ROW);
    this.boxes("BACK", "GIVE");
  }
}

export default CheatsPanel;
