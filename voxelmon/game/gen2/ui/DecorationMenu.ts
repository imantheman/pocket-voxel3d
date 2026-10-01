// gen1recomp src/ui/gen2/DecorationMenu.lua (bdfac727, MIT): the bedroom
// PC's DECORATION option, _PlayerDecorationMenu
// (engine/overworld/decorations.asm), reached from PLAYERSPCITEM_DECORATION in
// the PLAYERSPC_HOUSE list (engine/events/pokecenter_pc.asm).
//
// Two menus stacked, plus one question:
//
//   .MenuHeader           the categories the player owns something in, at
//                         menu_coords 5, 0, 19, 17, with EXIT always last
//   .NonscrollingMenuHeader / .ScrollingMenuHeader
//                         that category's decorations, then its PUT IT AWAY
//                         row, then CANCEL (one list that scrolls covers both)
//   DecoSideMenuHeader    RIGHT SIDE / LEFT SIDE / CANCEL, for the ornaments
//
// Nothing here touches the map. wChangedDecorations is carried back through
// onDone so `special PlayersHousePC` can answer TRUE and warp-reload the room.

import G from "../platform/screen.ts";
import { Decorations } from "../core/Decorations.ts";
import type { DecoCategory, DecoState } from "../core/Decorations.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Chrome } from "./Chrome.ts";
import { Typer } from "./Typer.ts";

export interface DecorationMenuOpts {
  save?: any;
  events?: any;
  onDone?: (changed: boolean) => void;
}

// Lua: DecorationMenu.lua:33 -- .category_pointers' eighth row, always shown.
const EXIT = Strings.source("EXIT");
// Lua: DecorationMenu.lua:35 -- DecoSideMenuHeader's three items.
const SIDES: { id: string | undefined; label: string }[] = [
  { id: "right", label: Strings.source("RIGHT SIDE") },
  { id: "left", label: Strings.source("LEFT SIDE") },
  { id: undefined, label: Strings.source("CANCEL") },
];

// Lua: DecorationMenu.lua:42 -- .ScrollingMenuData's `db 8, 0`.
const VISIBLE = 8;

export class DecorationMenu {
  // Lua: DecorationMenu.lua:30 -- pokecrystal decorations.asm:8
  static isOpaque = false;
  isOpaque = false;

  game: any;
  save: any;
  events: any;
  onDone?: (changed: boolean) => void;
  state: DecoState;
  changed: boolean;
  mode: "category" | "items" | "side";
  index: number;
  scroll: number;
  pages: string[] | null;
  pageIndex = 1;
  typer: Typer | null = null;
  categories: DecoCategory[] = [];
  category?: DecoCategory;
  rows: number[] = [];
  pendingDeco?: number;
  sideIndex = 1;
  done?: boolean;
  [key: string]: any;

  /** Lua: DecorationMenu.lua:44 */
  wantsFillScale(): boolean {
    return true;
  }

  /** Lua: DecorationMenu.lua:47 -- opts: save, events (wEventFlags), onDone(changed) */
  static new(game: any, opts?: DecorationMenuOpts): DecorationMenu {
    return new DecorationMenu(game, opts ?? {});
  }

  constructor(game: any, opts: DecorationMenuOpts) {
    this.game = game;
    this.save = opts.save || (game && game.save);
    this.events = opts.events;
    this.onDone = opts.onDone;
    this.state = Decorations.state(this.save);
    // wChangedDecorations, cleared once on the way in.
    this.changed = false;
    this.mode = "category";
    this.index = 1;
    this.scroll = 0;
    this.pages = null;
    this.buildCategories();
  }

  /** Lua: DecorationMenu.lua:65 */
  buildCategories(): void {
    this.categories = Decorations.ownedCategories(this.events);
    this.index = Math.min(this.index, this.categories.length + 1);
  }

  /** Lua: DecorationMenu.lua:70 */
  finish(): void {
    if (this.done) return;
    this.done = true;
    if (this.onDone) this.onDone(this.changed);
  }

  /**
   * Lua: DecorationMenu.lua:79 -- CANCEL and PUT IT AWAY are plain
   * DecorationAttributes rows, so they spell themselves.
   */
  rowName(decoId: number): string {
    return Decorations.name(decoId);
  }

  /** Lua: DecorationMenu.lua:83 */
  openCategory(category: DecoCategory): void {
    const rows = Decorations.rows(this.events, category);
    if (rows.length === 0) {
      // PopulateDecoCategoryMenu .empty.
      this.say([Strings.get(Decorations.NOTHING_TO_CHOOSE)]);
      return;
    }
    this.category = category;
    this.rows = rows;
    this.mode = "items";
    this.index = 1;
    this.scroll = 0;
  }

  /** Lua: DecorationMenu.lua:99 -- home/menu.asm:328 MenuTextboxBackup */
  say(pages: string[] | null | undefined): void {
    if (!pages || pages.length === 0) return;
    this.pages = pages;
    this.pageIndex = 1;
    this.typer = Typer.new(this.game);
    this.typer.start(pages[0]);
  }

  /**
   * Lua: DecorationMenu.lua:110 -- MenuTextboxBackup returns to the menu
   * underneath, so a message sits over the list it was printed from.
   */
  advanceMessage(): void {
    this.pageIndex = this.pageIndex + 1;
    if (this.pages && this.pageIndex <= this.pages.length) {
      if (this.typer) this.typer.start(this.pages[this.pageIndex - 1]);
      return;
    }
    this.pages = null;
    this.typer = null;
  }

  /**
   * Lua: DecorationMenu.lua:122 -- DoDecorationAction2. An ornament row asks
   * which side first, and only then applies.
   */
  chooseRow(decoId: number): void {
    const attr = Decorations.attributes(decoId);
    const action = attr && attr.action ? (Decorations.ACTIONS as Record<string, any>)[attr.action] : undefined;
    if (!action) {
      // DecoAction_nothing sets carry: back to the category list, silently.
      this.mode = "category";
      this.buildCategories();
      return;
    }
    if (action.ornament) {
      this.mode = "side";
      this.pendingDeco = decoId;
      this.sideIndex = 1;
      return;
    }
    this.applyRow(decoId, undefined);
  }

  /** Lua: DecorationMenu.lua:141 */
  applyRow(decoId: number, side: string | undefined): void {
    const [changed, pages] = Decorations.apply(this.state, decoId, side);
    if (changed) {
      this.changed = true;
      const attr = Decorations.attributes(decoId);
      const action = attr && attr.action ? (Decorations.ACTIONS as Record<string, any>)[attr.action] : undefined;
      if (action && action.ornament && !action.put) Decorations.clearOtherSide(this.state, decoId, side);
    }
    this.say(pages);
  }

  /** Lua: DecorationMenu.lua:154 */
  update(_dt?: number): void {
    const input = this.game && this.game.input;
    if (!(input && !this.done)) return;

    if (this.pages) {
      Typer.step(this);
      if (Typer.typing(this)) return;
      if (input.wasPressed("a") || input.wasPressed("b")) this.advanceMessage();
      return;
    }

    if (this.mode === "side") {
      if (input.wasPressed("up")) {
        this.sideIndex = this.sideIndex > 1 ? this.sideIndex - 1 : SIDES.length;
      } else if (input.wasPressed("down")) {
        this.sideIndex = this.sideIndex < SIDES.length ? this.sideIndex + 1 : 1;
      } else if (input.wasPressed("a")) {
        const pick = SIDES[this.sideIndex - 1];
        this.mode = "items";
        // .nope: CANCEL and B are the same arm, and neither prints anything.
        this.applyRow(this.pendingDeco!, pick && pick.id);
        this.pendingDeco = undefined;
      } else if (input.wasPressed("b")) {
        this.mode = "items";
        this.pendingDeco = undefined;
      }
      return;
    }

    if (this.mode === "items") {
      const total = this.rows.length;
      if (input.wasPressed("up")) {
        this.index = this.index > 1 ? this.index - 1 : total;
      } else if (input.wasPressed("down")) {
        this.index = this.index < total ? this.index + 1 : 1;
      } else if (input.wasPressed("a")) {
        this.chooseRow(this.rows[this.index - 1]!);
      } else if (input.wasPressed("b")) {
        this.mode = "category";
        this.buildCategories();
      }
      this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, total - VISIBLE)));
      if (this.index - 1 < this.scroll) this.scroll = this.index - 1;
      if (this.index > this.scroll + VISIBLE) this.scroll = this.index - VISIBLE;
      return;
    }

    const total = this.categories.length + 1;
    if (input.wasPressed("up")) {
      this.index = this.index > 1 ? this.index - 1 : total;
    } else if (input.wasPressed("down")) {
      this.index = this.index < total ? this.index + 1 : 1;
    } else if (input.wasPressed("a")) {
      const category = this.categories[this.index - 1];
      if (category) this.openCategory(category);
      else this.finish(); // DecoExitMenu: `scf`, which leaves the whole menu
    } else if (input.wasPressed("b")) {
      this.finish();
    }
  }

  /**
   * Lua: DecorationMenu.lua:223 -- GetMenuTextStartCoord: the first label
   * one row inside the border and one more for STATICMENU_CURSOR, rows two
   * apart.
   */
  drawList(x: number, y: number, w: number, h: number, labels: string[], index: number, scroll: number): void {
    Chrome.box(x, y, w, h);
    for (let row = 1; row <= Math.min(labels.length - scroll, VISIBLE); row++) {
      const i = row + scroll;
      const ty = y + row * 2;
      if (i === index) Chrome.cursor(x + 1, ty);
      Chrome.print(labels[i - 1]!, x + 2, ty);
    }
  }

  /** Lua: DecorationMenu.lua:236 */
  drawPanel(): void {
    if (this.mode === "category") {
      const labels = this.categories.map((category) => category.label);
      labels.push(Strings.get(EXIT));
      // menu_coords 5, 0, 19, 17: the list hugs the right edge and the room
      // stays visible down the left.
      this.drawList(5, 0, 15, 18, labels, this.index, 0);
    } else if (this.mode === "items") {
      const labels = this.rows.map((decoId) => this.rowName(decoId));
      this.drawList(0, 0, 20, 18, labels, this.index, this.scroll);
    }

    if (this.mode === "side") {
      const labels = SIDES.map((side) => Strings.get(side.label));
      // menu_coords 0, 0, 12, 7
      this.drawList(0, 0, 13, 8, labels, this.sideIndex, 0);
    }

    if (this.pages) {
      Chrome.box(0, 12, 20, 6);
      let line = 14;
      let shown: string[] | undefined = this.typer ? this.typer.lines() : undefined;
      if (!shown) shown = (this.pages[this.pageIndex - 1] || "").split("\n");
      for (const part of shown) {
        Chrome.print(part, 1, line);
        line = line + 2;
      }
    }

    G.setColor(1, 1, 1, 1);
  }

  /** Lua: DecorationMenu.lua:276 */
  draw(): void {
    this.drawPanel();
  }
}

export default DecorationMenu;
