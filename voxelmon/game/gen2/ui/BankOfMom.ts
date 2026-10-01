// gen1recomp src/ui/gen2/BankOfMom.lua (bdfac727, MIT): the six-digit money
// keypad BankOfMom's GET and SAVE both put up (engine/events/mom.asm
// Mom_SetUpWithdrawMenu / Mom_SetUpDepositMenu /
// Mom_WithdrawDepositMenuJoypad).  Not a generic ScriptMenu: nothing else in
// the game edits a number digit by digit, so this is its own screen the way
// the naming keyboard and the move-list are theirs.
//
// Layout, from the ASM's own coordinates:
//   `hlcoord 0, 0 / lb bc, 6, 18 / call Textbox` -- an interior 18x6 box at
//   (0,0), i.e. a 20x8 outer box.
//   (1,2) "SAVED@" / (12,2) wMomsMoney, PRINTNUM_MONEY | 3 bytes, width 6
//   (1,4) "HELD@"  / (12,4) wMoney,     PRINTNUM_MONEY | 3 bytes, width 6
//   (1,6) "DEPOSIT@" or "WITHDRAW@" / (12,6) the typed amount,
//   PRINTNUM_MONEY | PRINTNUM_LEADINGZEROS | 3, width 6
// PRINTNUM_MONEY puts the yen sign right before the field and the six digits
// after it, so column 12 is the yen and 13..18 are the digits -- which is
// where Mom_WithdrawDepositMenuJoypad's blinking cursor (`hlcoord 13, 6` plus
// wMomBankDigitCursorPosition) lands.
//
// UP/DOWN add or subtract the place value under the cursor (clamping at
// 999999 or 0 rather than wrapping), LEFT/RIGHT move the cursor, A accepts,
// B cancels.  wMomBankDigitCursorPosition starts at 5 -- the ones digit.

import G from "../platform/screen.ts";
import { format } from "../platform/lua.ts";
import { Sound } from "../shared/core/Sound.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Chrome } from "./Chrome.ts";

export interface BankOfMomOpts {
  kind?: string;
  saved?: number;
  held?: number;
  onDone?: (amount: number | undefined) => void;
  onCancel?: () => void;
}

// Lua: BankOfMom.lua:38
const BOX_X = 0, BOX_Y = 0, BOX_W = 20, BOX_H = 8;
const SAVED_LABEL_X = 1, SAVED_Y = 2;
const HELD_LABEL_X = 1, HELD_Y = 4;
const KIND_LABEL_X = 1, KIND_Y = 6;
const MONEY_X = 12;
const DIGIT_X = 13; // first digit column; DIGIT_X + position is the cursor

const MAX_MONEY = 999999;

// Lua: BankOfMom.lua:48 -- `.DigitQuantities`' first (and only reachable)
// six entries, 10^5..10^0.
const PLACE_VALUES = [100000, 10000, 1000, 100, 10, 1];

// Lua: BankOfMom.lua:53
const SAVED_LABEL = Strings.source("SAVED");
const HELD_LABEL = Strings.source("HELD");
const DEPOSIT_LABEL = Strings.source("DEPOSIT");
const WITHDRAW_LABEL = Strings.source("WITHDRAW");

// Lua: BankOfMom.lua:59 -- charmap.asm: ¥ is the currency glyph.
const YEN = "¥";

/** Lua: BankOfMom.lua:63 -- PrintNum PRINTNUM_MONEY, no leading zeros. */
function moneyText(amount?: number): string {
  const digits = format("%06d", Math.max(0, Math.floor(amount ?? 0)));
  const m = /[1-9]/.exec(digits);
  const first = m ? m.index + 1 : digits.length;
  return " ".repeat(first - 1) + YEN + digits.slice(first - 1);
}

/** Lua: BankOfMom.lua:70 -- PRINTNUM_MONEY | PRINTNUM_LEADINGZEROS. */
function moneyTextZeroed(amount?: number): string {
  return YEN + format("%06d", Math.max(0, Math.floor(amount ?? 0)));
}

export class BankOfMom {
  // Lua: BankOfMom.lua:36
  static isOpaque = false;
  isOpaque = false;

  game: any;
  data: any;
  kind: string;
  saved: number;
  held: number;
  onDone?: (amount: number | undefined) => void;
  amount: number;
  position: number;
  blink: number;
  done?: boolean;
  [key: string]: any;

  /**
   * Lua: BankOfMom.lua:76 -- opts: kind ("deposit" | "withdraw"), saved
   * (wMomsMoney), held (wMoney), onDone(amount) -- nil for B
   */
  static new(game: any, opts?: BankOfMomOpts): BankOfMom {
    return new BankOfMom(game, opts ?? {});
  }

  constructor(game: any, opts: BankOfMomOpts) {
    this.game = game;
    this.data = (game && game.data) || {};
    this.kind = opts.kind || "deposit";
    this.saved = opts.saved || 0;
    this.held = opts.held || 0;
    this.onDone = opts.onDone;
    this.amount = 0;
    this.position = 5; // ones digit, rightmost
    this.blink = 0;
  }

  /** Lua: BankOfMom.lua:91 */
  wantsFillScale(): boolean {
    return true;
  }

  /** Lua: BankOfMom.lua:93 */
  finish(amount: number | undefined): void {
    if (this.done) return;
    this.done = true;
    if (this.onDone) this.onDone(amount);
  }

  /** Lua: BankOfMom.lua:99 */
  playSfx(name: string): void {
    const sfx = this.data.audio && this.data.audio.sfx;
    if (sfx && sfx[Sound.resolve(this.data, name)]) Sound.play(this.data, name);
  }

  /** Lua: BankOfMom.lua:106 */
  update(dt?: number): void {
    if (this.done) return;
    this.blink = this.blink + (dt || 0);
    const input = this.game && this.game.input;
    if (!input) return;
    if (input.wasPressed("up")) {
      this.amount = Math.min(this.amount + PLACE_VALUES[this.position]!, MAX_MONEY);
    } else if (input.wasPressed("down")) {
      this.amount = Math.max(this.amount - PLACE_VALUES[this.position]!, 0);
    } else if (input.wasPressed("left")) {
      this.position = Math.max(0, this.position - 1);
    } else if (input.wasPressed("right")) {
      this.position = Math.min(5, this.position + 1);
    } else if (input.wasPressed("a")) {
      this.playSfx("Sfx_ReadText2");
      this.finish(this.amount);
    } else if (input.wasPressed("b")) {
      this.playSfx("Sfx_ReadText2");
      this.finish(undefined);
    }
  }

  /** Lua: BankOfMom.lua:129 */
  drawPanel(): void {
    Chrome.box(BOX_X, BOX_Y, BOX_W, BOX_H);
    Chrome.print(Strings.get(SAVED_LABEL), SAVED_LABEL_X, SAVED_Y);
    Chrome.print(moneyText(this.saved), MONEY_X, SAVED_Y);
    Chrome.print(Strings.get(HELD_LABEL), HELD_LABEL_X, HELD_Y);
    Chrome.print(moneyText(this.held), MONEY_X, HELD_Y);
    Chrome.print(Strings.get(this.kind === "withdraw" ? WITHDRAW_LABEL : DEPOSIT_LABEL),
      KIND_LABEL_X, KIND_Y);
    Chrome.print(moneyTextZeroed(this.amount), MONEY_X, KIND_Y);
    // Lua: BankOfMom.lua:138 -- `hlcoord 13, 6 / ... / ld [hl], ' '` blanks
    // the digit under the cursor every `hVBlankCounter and $10` window; a
    // white square over that tile every half second reads the same.
    if (Math.floor(this.blink * 2) % 2 === 1) {
      G.setColor(1, 1, 1, 1);
      G.rectangle("fill", (DIGIT_X + this.position) * 8, KIND_Y * 8, 8, 8);
    }
    G.setColor(1, 1, 1, 1);
  }

  /** Lua: BankOfMom.lua:150 */
  draw(): void {
    this.drawPanel();
  }
}

export default BankOfMom;
