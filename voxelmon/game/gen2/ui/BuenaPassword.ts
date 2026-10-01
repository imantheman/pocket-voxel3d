// gen1recomp src/ui/gen2/BuenaPassword.lua (bdfac727, MIT): Buena's two
// windows, Crystal only, chosen by `mode`:
//
//   password  pokecrystal engine/events/buena.asm:1 BuenasPassword, whose
//             .MenuHeader is `menu_coords 0, 0, 10, 7` with the right edge
//             moved to left + the category's points byte + 2 (:9-12), and
//             whose .PasswordIndices answer is zero based (:44-49).
//   prize     engine/events/buena.asm:64 BuenaPrize (:249,
//             home/scrolling_menu.asm:25-41, home/menu.asm:311)
//
// Neither is opaque: buena.asm:71-83 prints the prize question BEFORE the
// list goes up over it, and the password menu stands on the map. Screens.lua
// lists it as pending (Crystal), but the module itself is complete.

import G from "../platform/screen.ts";
import { tonumber } from "../platform/lua.ts";
import { Sound } from "../shared/core/Sound.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Chrome } from "./Chrome.ts";

export interface BuenaPrize {
  name: string;
  cost: number;
  [key: string]: any;
}

export interface BuenaPasswordOpts {
  mode?: string;
  words?: string[];
  width?: number | string;
  prizes?: BuenaPrize[];
  balance?: number | string;
  onDone?: (value: number) => void;
}

// Lua: BuenaPassword.lua:24 -- GetMenuTextStartCoord (home/menu.asm:214) on
// STATICMENU_CURSOR: labels at box + (2,2), cursor one left.
const WORD_X = 2, WORD_Y = 2, WORD_SPACING = 2;
const WORD_BOX_H = 8;

// Lua: BuenaPassword.lua:28 -- engine/events/buena.asm:249
const LIST_BOX_X = 1, LIST_BOX_Y = 1, LIST_BOX_W = 16, LIST_BOX_H = 9;
// home/scrolling_menu.asm:25-41
const FRAME_X = LIST_BOX_X - 1, FRAME_Y = LIST_BOX_Y - 1;
const FRAME_W = LIST_BOX_W + 2, FRAME_H = LIST_BOX_H + 2;
const LIST_X = 2, LIST_Y = 2, LIST_SPACING = 2;
// ScrollingMenu_CallFunctions1and2's `add hl, de` on
// wMenuData_ScrollingMenuWidth (engine/menus/scrolling_menu.asm:424-431).
const POINTS_X = LIST_X + 13;
const VISIBLE_ROWS = 4;
const ARROW_X = LIST_BOX_X + LIST_BOX_W - 1;
const ARROW_UP_Y = LIST_BOX_Y, ARROW_DOWN_Y = LIST_BOX_Y + LIST_BOX_H - 1;

// Lua: BuenaPassword.lua:42 -- BlueCardBalanceMenuHeader (buena.asm:208) and
// .DrawBox's PlaceString / two spaces / `lb bc, 1, 2` PrintNum (:181-203).
const BALANCE_BOX_X = 0, BALANCE_BOX_Y = 11, BALANCE_BOX_W = 12, BALANCE_BOX_H = 3;
const BALANCE_LABEL_X = 1, BALANCE_LABEL_Y = 12;
const BALANCE_NUM_X = 8;
const POINTS_LABEL = Strings.source("Points");

// Lua: BuenaPassword.lua:47
const UP_ARROW = "▲";
const DOWN_ARROW = "▼";

export class BuenaPassword {
  // Lua: BuenaPassword.lua:20
  static isOpaque = false;
  isOpaque = false;

  game: any;
  data: any;
  mode: "prize" | "password";
  words: string[];
  width: number;
  prizes: BuenaPrize[];
  balance: number;
  onDone?: (value: number) => void;
  index: number;
  scroll: number;
  done?: boolean;
  [key: string]: any;

  /**
   * Lua: BuenaPassword.lua:51 -- opts: mode, and then words/width/onDone(0..2)
   * or prizes/balance/onDone(row)
   */
  static new(game: any, opts?: BuenaPasswordOpts): BuenaPassword {
    return new BuenaPassword(game, opts ?? {});
  }

  constructor(game: any, opts: BuenaPasswordOpts) {
    this.game = game;
    this.data = (game && game.data) || {};
    this.mode = opts.mode === "prize" ? "prize" : "password";
    this.words = opts.words || [];
    this.width = Math.max(1, Math.floor(tonumber(opts.width) ?? 10));
    this.prizes = opts.prizes || [];
    this.balance = Math.max(0, Math.floor(tonumber(opts.balance) ?? 0));
    this.onDone = opts.onDone;
    // buena.asm:34 `db 1 ; default option` and :67-68.
    this.index = 1;
    this.scroll = 0;
  }

  /** Lua: BuenaPassword.lua:69 */
  wantsFillScale(): boolean {
    return true;
  }

  /** Lua: BuenaPassword.lua:71 */
  count(): number {
    if (this.mode === "prize") return this.prizes.length;
    return this.words.length;
  }

  /** Lua: BuenaPassword.lua:76 */
  playSfx(name: string): void {
    const sfx = this.data.audio && this.data.audio.sfx;
    if (sfx && sfx[Sound.resolve(this.data, name)]) Sound.play(this.data, name);
  }

  /** Lua: BuenaPassword.lua:83 */
  finish(value: number): void {
    if (this.done) return;
    this.done = true;
    const stack = this.game && this.game.stack;
    if (stack) stack.pop();
    if (this.onDone) this.onDone(value);
  }

  /** Lua: BuenaPassword.lua:91 */
  ensureVisible(): void {
    const rows = Math.min(VISIBLE_ROWS, this.count());
    if (rows <= 0) return;
    if (this.index <= this.scroll) this.scroll = this.index - 1;
    else if (this.index > this.scroll + rows) this.scroll = this.index - rows;
    this.scroll = Math.max(0, Math.min(this.scroll, this.count() - rows));
  }

  /** Lua: BuenaPassword.lua:102 */
  update(_dt?: number): void {
    if (this.done) return;
    const input = this.game && this.game.input;
    if (!input) return;
    const total = this.count();
    if (total <= 0) return this.finish(this.mode === "prize" ? 0 : -1);
    // Neither header sets STATICMENU_WRAP (buena.asm:39, :256).
    if (input.wasPressed("up")) {
      if (this.index > 1) this.index = this.index - 1;
    } else if (input.wasPressed("down")) {
      if (this.index < total) this.index = this.index + 1;
    } else if (input.wasPressed("a")) {
      this.playSfx("Sfx_ReadText2");
      if (this.mode === "prize") return this.finish(this.index);
      // buena.asm:44-49 .PasswordIndices is zero based.
      return this.finish(this.index - 1);
    } else if (input.wasPressed("b")) {
      // STATICMENU_DISABLE_B (buena.asm:39).
      if (this.mode === "prize") {
        this.playSfx("Sfx_ReadText2");
        return this.finish(0);
      }
    }
    this.ensureVisible();
  }

  /** Lua: BuenaPassword.lua:128 */
  drawPasswordPanel(): void {
    Chrome.box(0, 0, this.width + 3, WORD_BOX_H);
    this.words.forEach((word, i0) => {
      const i = i0 + 1;
      const ty = WORD_Y + (i - 1) * WORD_SPACING;
      if (i === this.index) Chrome.cursor(WORD_X - 1, ty);
      Chrome.print(word, WORD_X, ty);
    });
  }

  /** Lua: BuenaPassword.lua:137 */
  drawPrizePanel(): void {
    Chrome.box(FRAME_X, FRAME_Y, FRAME_W, FRAME_H);
    for (let row = 1; row <= VISIBLE_ROWS; row++) {
      const i = row + this.scroll;
      const prize = this.prizes[i - 1];
      if (prize) {
        const ty = LIST_Y + (row - 1) * LIST_SPACING;
        if (i === this.index) Chrome.cursor(LIST_X - 1, ty);
        Chrome.print(prize.name, LIST_X, ty);
        // .PrintPrizePoints writes one char, `'0' + cost` (buena.asm:281-289).
        Chrome.print(String(((prize.cost % 10) + 10) % 10), POINTS_X, ty);
      }
    }
    // SCROLLINGMENU_DISPLAY_ARROWS: the up arrow only once scrolled, the down
    // arrow every pass (engine/menus/scrolling_menu.asm:348-358, :387-395).
    if (this.scroll > 0) Chrome.print(UP_ARROW, ARROW_X, ARROW_UP_Y);
    Chrome.print(DOWN_ARROW, ARROW_X, ARROW_DOWN_Y);

    Chrome.box(BALANCE_BOX_X, BALANCE_BOX_Y, BALANCE_BOX_W, BALANCE_BOX_H);
    Chrome.print(Strings.get(POINTS_LABEL), BALANCE_LABEL_X, BALANCE_LABEL_Y);
    Chrome.print(Chrome.number(this.balance, 2), BALANCE_NUM_X, BALANCE_LABEL_Y);
  }

  /** Lua: BuenaPassword.lua:160 */
  drawPanel(): void {
    if (this.mode === "prize") return this.drawPrizePanel();
    return this.drawPasswordPanel();
  }

  /** Lua: BuenaPassword.lua:165 */
  draw(): void {
    this.drawPanel();
    G.setColor(1, 1, 1, 1);
  }
}

export default BuenaPassword;
