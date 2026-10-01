// The static menu a script puts up: a port of gen1recomp
// src/ui/gen2/ScriptMenu.lua (bdfac727, MIT) -- `loadmenu` then
// `verticalmenu` or `_2dmenu` (home/menu.asm VerticalMenu / _2DMenu,
// engine/menus/menu.asm _2DMenu_). The vending machines, the Game Corner
// prize counters, the coin vendor and Earl's blackboard use one.
//
//   MenuBox draws the border from (left, top) to (right, bottom) inclusive.
//   GetMenuTextStartCoord: box + 1 for the border, + 1 more row unless
//     STATICMENU_NO_TOP_SPACING, + 1 more column if STATICMENU_CURSOR.
//
// A vertical menu's items are two rows apart and its answer is wMenuCursorY;
// a 2D menu's answer is `(cursorY - 1) * cols + cursorX`. Both are one-based
// and both answer 0 for B.

import { Chrome } from "./Chrome.ts";
import { CoinCase } from "../core/CoinCase.ts";
import { Runtime } from "../shared/mods/Runtime.ts";
import { Sound } from "../shared/core/Sound.ts";
import { idiv, mod, tonumber } from "../platform/lua.ts";
import G from "../platform/screen.ts";

export interface MenuHeader {
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
  dataFlags?: number;
  items?: string[];
  gridItems?: string[];
  grid?: { rows: number; cols: number; spacing?: number };
  cursor?: number;
  [k: string]: any;
}

export interface ScriptMenuOpts {
  header?: MenuHeader;
  style?: "vertical" | "2d";
  balance?: "coins" | "money" | "moneycoins";
  save?: any;
  onChoose?: (index: number) => void;
  title?: string;
  kind?: string;
}

// Lua: ScriptMenu.lua:44 -- constants/menu_constants.asm, the wMenuDataFlags bits.
const STATICMENU_DISABLE_B = 0x01;
// STATICMENU_WRAP (bit 2): no header a script loads sets it.
const STATICMENU_WRAP = 0x04;
const STATICMENU_NO_TOP_SPACING = 0x40;
const STATICMENU_CURSOR = 0x80;

// Lua: ScriptMenu.lua:56 -- key-repeat cadence, inert until a hook turns it on.
const REPEAT_DELAY = 16;
const REPEAT_RATE = 4;

// Lua: ScriptMenu.lua:60 -- ui.list_menu identity.
function sameOpts<T>(opts: T): T {
  return opts;
}

// Lua: ScriptMenu.lua:62
function hasFlag(flags: unknown, bit: number): boolean {
  return mod(Math.floor((tonumber(flags) ?? 0) / bit), 2) === 1;
}

// Lua: ScriptMenu.lua:185 -- one cursor step along an axis.
function step(current: number, total: number, delta: number, wrap: boolean): number {
  if (total <= 0) return current;
  const next = current + delta;
  if (wrap) return mod(next - 1, total) + 1;
  return Math.max(1, Math.min(total, next));
}

export class ScriptMenu {
  [key: string]: any;
  // Lua: ScriptMenu.lua:41
  static isOpaque = false;

  isOpaque = false;
  game: any;
  data: any;
  balance?: string;
  save: any;
  header: MenuHeader = {};
  style = "vertical";
  onChoose?: (index: number) => void;
  items: string[] = [];
  rows = 0;
  cols = 1;
  spacing = 0;
  textX = 0;
  textY = 0;
  showCursor = false;
  row = 1;
  col = 1;
  wrap = false;
  pageJump = false;
  keyRepeat = false;
  repeatDelay = REPEAT_DELAY;
  repeatRate = REPEAT_RATE;
  holdDir: string | undefined;
  holdFrames = 0;
  done?: boolean;

  // Lua: ScriptMenu.lua:68 -- GetMenuTextStartCoord, exactly.
  static startCoord(header: MenuHeader | null | undefined): [number, number] {
    const flags = (header && header.dataFlags) || 0;
    let y = ((header && header.top) || 0) + 1;
    let x = ((header && header.left) || 0) + 1;
    if (!hasFlag(flags, STATICMENU_NO_TOP_SPACING)) y += 1;
    if (hasFlag(flags, STATICMENU_CURSOR)) x += 1;
    return [x, y];
  }

  // Lua: ScriptMenu.lua:79 -- the item list and the grid shape.
  static layout(header: MenuHeader | null | undefined, style?: string): [string[], number, number, number] {
    const grid = header ? header.grid : undefined;
    if (style === "2d" && grid) {
      return [header!.gridItems ?? [], grid.rows, grid.cols, grid.spacing || 0];
    }
    const items = (header && header.items) || [];
    return [items, items.length, 1, 0];
  }

  // Lua: ScriptMenu.lua:90 -- the 1-based answer _2DMenu_ computes.
  static choiceIndex(row: number, col: number, cols?: number): number {
    return (row - 1) * (cols || 1) + col;
  }

  // Lua: ScriptMenu.lua:99
  static new(game: any, opts?: ScriptMenuOpts): ScriptMenu {
    const o = opts ?? {};
    const self = new ScriptMenu();
    self.game = game;
    self.data = (game && game.data) || {};
    // The balance box the `special` before the `loadmenu` put up.
    self.balance = o.balance;
    self.save = o.save ?? (game ? game.save : undefined);
    self.header = o.header ?? {};
    self.style = o.style ?? "vertical";
    self.onChoose = o.onChoose;
    [self.items, self.rows, self.cols, self.spacing] = ScriptMenu.layout(self.header, self.style);
    [self.textX, self.textY] = ScriptMenu.startCoord(self.header);
    self.showCursor = hasFlag(self.header.dataFlags, STATICMENU_CURSOR);
    // MenuHeader's last byte is wMenuCursorPosition, 1-based.
    const start = Math.max(1, Math.min(self.items.length, tonumber(self.header.cursor) ?? 1));
    self.row = idiv(start - 1, self.cols) + 1;
    self.col = mod(start - 1, self.cols) + 1;

    // ui.list_menu (the null mod bus here): guarded by wantsHook.
    self.wrap = hasFlag(self.header.dataFlags, STATICMENU_WRAP);
    self.pageJump = false;
    self.keyRepeat = false;
    self.repeatDelay = REPEAT_DELAY;
    self.repeatRate = REPEAT_RATE;
    self.holdDir = undefined;
    self.holdFrames = 0;
    if (Runtime.wantsHook("ui.list_menu")) {
      const hooked: any = Runtime.call(
        "ui.list_menu",
        sameOpts,
        {
          wrap: self.wrap,
          pageJump: self.pageJump,
          keyRepeat: self.keyRepeat,
          repeatDelay: self.repeatDelay,
          repeatRate: self.repeatRate,
        },
        {
          game,
          title: o.title,
          kind: o.kind ?? "script_" + self.style,
          itemCount: self.items.length,
        },
      );
      if (hooked !== null && typeof hooked === "object") {
        if (hooked.wrap != null) self.wrap = !!hooked.wrap;
        if (hooked.pageJump != null) self.pageJump = !!hooked.pageJump;
        if (hooked.keyRepeat != null) self.keyRepeat = !!hooked.keyRepeat;
        self.repeatDelay = tonumber(hooked.repeatDelay) ?? self.repeatDelay;
        self.repeatRate = Math.max(1, tonumber(hooked.repeatRate) ?? self.repeatRate);
      }
    }
    return self;
  }

  // Lua: ScriptMenu.lua:168
  wantsFillScale(): boolean {
    return true;
  }

  // Lua: ScriptMenu.lua:170
  finish(index: number): void {
    if (this.done) return;
    this.done = true;
    if (this.onChoose) this.onChoose(index);
  }

  // Lua: ScriptMenu.lua:176
  playSfx(name: string): void {
    const sfx = this.data.audio && this.data.audio.sfx;
    if (sfx && sfx[Sound.resolve(this.data, name)]) {
      Sound.play(this.data, name);
    }
  }

  // Lua: ScriptMenu.lua:197 -- one edge press or key-repeat tick.
  nav(dir: string): void {
    if (dir === "up") {
      this.row = step(this.row, this.rows, -1, this.wrap);
    } else if (dir === "down") {
      this.row = step(this.row, this.rows, 1, this.wrap);
    } else if (this.cols > 1 && dir === "left") {
      this.col = step(this.col, this.cols, -1, this.wrap);
    } else if (this.cols > 1 && dir === "right") {
      this.col = step(this.col, this.cols, 1, this.wrap);
    } else if (this.pageJump && dir === "left") {
      this.row = step(this.row, this.rows, -this.rows, this.wrap);
    } else if (this.pageJump && dir === "right") {
      this.row = step(this.row, this.rows, this.rows, this.wrap);
    }
  }

  // Lua: ScriptMenu.lua:214 -- StaticMenuJoypad, then MenuClickSound.
  update(_dt?: number): void {
    if (this.done) return;
    const input = this.game ? this.game.input : undefined;
    if (!input) return;
    let pressed: string | undefined;
    if (input.wasPressed("up")) {
      pressed = "up";
    } else if (input.wasPressed("down")) {
      pressed = "down";
    } else if (input.wasPressed("left")) {
      pressed = "left";
    } else if (input.wasPressed("right")) {
      pressed = "right";
    }
    if (pressed) {
      this.nav(pressed);
      this.holdDir = pressed;
      this.holdFrames = 0;
    } else if (input.wasPressed("a")) {
      this.playSfx("Sfx_ReadText2");
      this.finish(ScriptMenu.choiceIndex(this.row, this.col, this.cols));
    } else if (input.wasPressed("b") && !hasFlag(this.header.dataFlags, STATICMENU_DISABLE_B)) {
      this.playSfx("Sfx_ReadText2");
      this.finish(0);
    }
    if (this.done) return;

    // Hold-to-scroll, opt-in through ui.list_menu's keyRepeat.
    if (!this.keyRepeat) return;
    const dir = this.holdDir;
    if (dir && input.isDown && input.isDown(dir)) {
      this.holdFrames += 1;
      const afterDelay = this.holdFrames - this.repeatDelay;
      if (afterDelay >= 0 && mod(afterDelay, this.repeatRate) === 0) {
        this.nav(dir);
      }
    } else {
      this.holdDir = undefined;
      this.holdFrames = 0;
    }
  }

  // Lua: ScriptMenu.lua:257
  itemPosition(index: number): [number, number] {
    const row = idiv(index - 1, this.cols);
    const col = mod(index - 1, this.cols);
    return [this.textX + col * this.spacing, this.textY + row * 2];
  }

  // Lua: ScriptMenu.lua:267 -- drawn BEFORE the menu box, as the cart does.
  drawBalance(): void {
    const kind = this.balance;
    if (!kind) return;
    const player = this.save ? this.save.player : undefined;
    const money = (player && player.money) || 0;
    if (kind === "coins") {
      Chrome.coinBalanceBox(CoinCase.coins(this.save));
    } else if (kind === "moneycoins") {
      Chrome.moneyAndCoinBalanceBox(money, CoinCase.coins(this.save));
    } else {
      Chrome.moneyBalanceBox(money);
    }
  }

  // Lua: ScriptMenu.lua:281
  drawPanel(): void {
    this.drawBalance();
    const h = this.header;
    const left = h.left || 0;
    const top = h.top || 0;
    Chrome.box(left, top, (h.right ?? left) - left + 1, (h.bottom ?? top) - top + 1);
    this.items.forEach((label, i) => {
      const [x, y] = this.itemPosition(i + 1);
      Chrome.print(label, x, y);
    });
    if (this.showCursor) {
      const [x, y] = this.itemPosition(ScriptMenu.choiceIndex(this.row, this.col, this.cols));
      Chrome.cursor(x - 1, y);
    }
    G.setColor(1, 1, 1, 1);
  }

  // Lua: ScriptMenu.lua:299
  draw(): void {
    this.drawPanel();
  }
}

export default ScriptMenu;
