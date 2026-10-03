// Gold/Silver's clock reset, both halves.
//
// "password" -- the title's Down + Select + B (TitleScreenMain's
// TITLESCREENOPTION_RESET_CLOCK -> _ResetClock, engine/rtc/reset_password.asm):
//   _PasswordAskResetClockText "Reset the clock?" over a NO / YES menu; then
//   ClockResetPassword: "Please enter the password.", five digits at (14,15)
//   starting 00000 with the cursor on the last, a ▲ under the digit being set;
//   LEFT / RIGHT move, UP / DOWN turn the digit (9 wraps to 0), A enters.
//   Right: sRTCStatusFlags gets RTC_RESET and "Password OK. / Select CONTINUE &
//   / reset settings."; wrong: "Wrong password!". Either way the cart resets.
//   The password (.CalculatePassword) is a byte sum: the two bytes of the
//   trainer ID, the first five characters of the name (to the terminator),
//   and the three bytes of the money.
//
// "restart" -- CONTINUE on a save carrying the flag (Continue_CheckRTC_
// RestartClock -> RestartClock, engine/rtc/restart_clock.asm): "The clock's
// time may be wrong. / Please reset the time.", "Set with the Control Pad. /
// Confirm: A Button / Cancel: B Button", then the day / hour / minute editor
// (LEFT / RIGHT pick, UP / DOWN change, ▲ / ▼ round the one picked); A asks
// "Is this OK?" -- YES sets the clock, "The clock has been reset."; NO goes
// back to the editor. B cancels the CONTINUE.
//
// The flag is the port's save.rtc.resetPending, written through Save.save.
//
// "delete" -- the title's Up + B + Select (TITLESCREENOPTION_DELETE_SAVE_DATA
// -> _DeleteSaveData): "Clear all save data?" over NO / YES; YES erases the
// slot. The same NO-first menu, so it lives here too.

import { Chrome } from "./Chrome.ts";
import { Clock } from "../core/Clock.ts";
import { Font } from "../shared/render/Font.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Typer } from "./Typer.ts";
import { pagesOf } from "./CenterPcMenu.ts";
import G from "../platform/screen.ts";

const TEXT = {
  ask: Strings.source("Reset the clock?"),
  clearAll: Strings.source("Clear all save\ndata?"),
  enter: Strings.source("Please enter the\npassword."),
  wrong: Strings.source("Wrong password!"),
  ok: Strings.source("Password OK.\nSelect CONTINUE &\vreset settings."),
  mayBeWrong: Strings.source("The clock's time\nmay be wrong.\fPlease reset the\ntime."),
  howTo: Strings.source("Set with the\nControl Pad.\fConfirm: A Button\nCancel:  B Button"),
  isOk: Strings.source("Is this OK?"),
  wasReset: Strings.source("The clock has been\nreset."),
  yes: Strings.source("YES"),
  no: Strings.source("NO"),
};

const DIGITS = 5;
/** The digits' row and first column, in their own box over the prompt (the
 *  cart prints them at hlcoord 14, 15 under a one-line prompt; the port's
 *  prompt keeps both its lines); the ▲ goes on the row below. */
const DIGIT_X = 14;
const DIGIT_Y = 8;

/** .CalculatePassword: the ID's two bytes, the name's first five, the money's three. */
export function clockResetPassword(save: any): number {
  const p = (save && save.player) || {};
  const id = Math.floor(Number(p.id) || 0) & 0xffff;
  let sum = (id >> 8) + (id & 0xff);
  const name: number[] = Font.encode(String(p.name ?? ""));
  for (const code of name.slice(0, 5)) {
    if (code === 0x50) break;
    sum += code & 0xff;
  }
  const money = Math.max(0, Math.floor(Number(p.money) || 0)) & 0xffffff;
  sum += ((money >> 16) & 0xff) + ((money >> 8) & 0xff) + (money & 0xff);
  return sum & 0xffff;
}

export function clockResetPending(save: any): boolean {
  return !!(save && save.rtc && save.rtc.resetPending);
}

export interface ResetClockOpts {
  mode: "password" | "restart" | "delete";
  /** delete: empties the save slot (Save.erase in the game). */
  erase?: () => void;
  save: any;
  /** Writes the save (Save.save in the game). */
  persist?: (save: any) => void;
  /** password: the cart resets either way; restart: true once the clock is set. */
  onDone?: (ok: boolean) => void;
  /** restart: skip "The clock's time may be wrong" (the menu's SET CLOCK). */
  asked?: boolean;
}

type Step = "ask" | "digits" | "edit" | "confirm" | "message";

export class ResetClock {
  [key: string]: any;
  static isOpaque = true;
  isOpaque = true;
  screenId = "Gen2ResetClock";

  game: any;
  mode: "password" | "restart" | "delete" = "password";
  erase?: () => void;
  save: any;
  persist?: (save: any) => void;
  onDone?: (ok: boolean) => void;
  step: Step = "message";
  done = false;
  /** NO / YES (or YES / NO for "Is this OK?"): 0 is the top row. */
  choice = 0;
  digits: number[] = [0, 0, 0, 0, 0];
  cursor = DIGITS - 1;
  /** The editor: day 0..6, hour, minute, and the field picked (0 day, 1 hour, 2 minute). */
  day = 0;
  hour = 0;
  minute = 0;
  field = 0;
  message?: { pages: any[]; page: number; onDone?: () => void };
  typer?: Typer;

  static new(game: any, opts: ResetClockOpts): ResetClock {
    const self = new ResetClock();
    self.game = game;
    self.mode = opts.mode;
    self.save = opts.save;
    self.persist = opts.persist;
    self.onDone = opts.onDone;
    self.erase = opts.erase;
    if (self.mode === "delete") {
      self.say(TEXT.clearAll, () => {
        self.step = "ask";
        self.choice = 0;
      });
      self.nextAtOnce = true;
    } else if (self.mode === "password") {
      self.say(TEXT.ask, () => {
        self.step = "ask";
        self.choice = 0;
      });
      self.nextAtOnce = true;
    } else {
      self.day = Clock.weekday(self.save);
      self.hour = Clock.hour(self.save);
      self.minute = Clock.minute(self.save);
      const edit = (): void => self.say(TEXT.howTo, () => {
        self.step = "edit";
      });
      if (opts.asked) edit();
      else self.say(TEXT.mayBeWrong, edit);
    }
    return self;
  }

  say(source: string, then?: () => void): void {
    this.step = "message";
    Typer.say(this, pagesOf(Strings.get(source)), then);
  }

  finish(ok: boolean): void {
    if (this.done) return;
    this.done = true;
    if (this.onDone) this.onDone(ok);
  }

  update(_dt?: number): void {
    if (this.done) return;
    const input = this.game ? this.game.input : undefined;
    if (!input) return;
    const pressed = (b: string): boolean => input.wasPressed(b);

    if (this.step === "message") {
      const m = this.message;
      Typer.step(this);
      if (Typer.typing(this) || !m) return;
      // the prompts that carry on into a menu or the digits do so at once
      const last = m.page >= m.pages.length;
      if (last && this.pendingStep()) {
        this.message = undefined;
        if (m.onDone) m.onDone();
        return;
      }
      if (!(pressed("a") || pressed("b"))) return;
      if (!last) {
        Typer.turn(this, m);
        return;
      }
      this.message = undefined;
      if (m.onDone) m.onDone();
      return;
    }

    if (this.step === "ask" || this.step === "confirm") {
      if (pressed("up") || pressed("down")) this.choice = 1 - this.choice;
      const yes = this.step === "ask" ? this.choice === 1 : this.choice === 0;
      if (pressed("b") || (pressed("a") && !yes)) {
        if (this.step === "ask") return this.finish(false);
        this.step = "edit";
        return;
      }
      if (!pressed("a")) return;
      if (this.step === "ask" && this.mode === "delete") {
        if (this.erase) this.erase();
        return this.finish(true);
      }
      if (this.step === "ask") {
        this.digits = [0, 0, 0, 0, 0];
        this.cursor = DIGITS - 1;
        this.say(TEXT.enter, () => {
          this.step = "digits";
        });
        this.nextAtOnce = true;
      } else {
        Clock.setWeekday(this.save, this.day);
        Clock.setTime(this.save, this.hour, this.minute);
        if (this.save.rtc) delete this.save.rtc.resetPending;
        if (this.persist) this.persist(this.save);
        this.say(TEXT.wasReset, () => this.finish(true));
      }
      return;
    }

    if (this.step === "digits") {
      if (pressed("left")) this.cursor = Math.max(0, this.cursor - 1);
      else if (pressed("right")) this.cursor = Math.min(DIGITS - 1, this.cursor + 1);
      else if (pressed("up")) this.digits[this.cursor] = (this.digits[this.cursor]! + 1) % 10;
      else if (pressed("down")) this.digits[this.cursor] = (this.digits[this.cursor]! + 9) % 10;
      else if (pressed("a")) {
        const entered = this.digits.reduce((n, d) => n * 10 + d, 0);
        if (entered === clockResetPassword(this.save)) {
          this.save.rtc = this.save.rtc ?? {};
          this.save.rtc.resetPending = true;
          if (this.persist) this.persist(this.save);
          this.say(TEXT.ok, () => this.finish(true));
        } else {
          this.say(TEXT.wrong, () => this.finish(false));
        }
      }
      return;
    }

    if (this.step === "edit") {
      if (pressed("b")) return this.finish(false);
      if (pressed("left")) this.field = Math.max(0, this.field - 1);
      else if (pressed("right")) this.field = Math.min(2, this.field + 1);
      else if (pressed("up") || pressed("down")) {
        const d = pressed("up") ? 1 : -1;
        if (this.field === 0) this.day = (this.day + d + 7) % 7;
        else if (this.field === 1) this.hour = (this.hour + d + 24) % 24;
        else this.minute = (this.minute + d + 60) % 60;
      } else if (pressed("a")) {
        this.say(TEXT.isOk, () => {
          this.step = "confirm";
          this.choice = 0;
        });
        this.nextAtOnce = true;
      }
    }
  }

  /** The last page of a prompt hands straight on to its menu / digits. */
  pendingStep(): boolean {
    if (!this.nextAtOnce) return false;
    this.nextAtOnce = false;
    return true;
  }

  /** The editor's three fields: label text and column. */
  fields(): [string, number][] {
    const day = Strings.get(Clock.weekdayName(this.day + 1) ?? "");
    return [
      [day, 2],
      [Chrome.number(this.hour, 2), 12],
      [Chrome.number(this.minute, 2, true), 15],
    ];
  }

  drawPanel(): void {
    G.setColor(1, 1, 1, 1);
    G.rectangle("fill", 0, 0, Chrome.SCREEN_W * 8, Chrome.SCREEN_H * 8);
    Chrome.clear();
    if (this.mode === "restart") {
      Chrome.textbox(0, 1, 18, 3);
      const fields = this.fields();
      for (const [text, x] of fields) Chrome.print(text, x, 3);
      Chrome.print(":", 14, 3);
      if (this.step === "edit") {
        const x = fields[this.field]![1];
        Chrome.print("▲", x, 2);
        Chrome.print("▼", x, 4);
      }
    }
    Chrome.textbox(0, 12, 18, 4);
    const m = this.message;
    if (m) {
      const page = m.pages[m.page - 1];
      const lines = Typer.text(this, typeof page === "string" ? page.split("\n") : page) as string[] | undefined;
      const name = this.save?.player?.name ?? "";
      (lines ?? []).slice(0, 2).forEach((line, i) => Chrome.print(line.split("{PLAYER}").join(name), 1, 14 + i * 2));
    } else if (this.step === "digits") {
      Strings.get(TEXT.enter).split("\n").slice(0, 2).forEach((l, i) => Chrome.print(l, 1, 14 + i * 2));
    } else if (this.step === "edit") {
      // the howTo's last page stays up under the editor
      const how = Strings.get(TEXT.howTo).split("\f").pop()!.split("\n");
      how.slice(0, 2).forEach((l, i) => Chrome.print(l, 1, 14 + i * 2));
    } else if (this.step === "ask" && this.mode === "delete") {
      Strings.get(TEXT.clearAll).split("\n").forEach((l, i) => Chrome.print(l, 1, 14 + i * 2));
    } else if (this.step === "ask") {
      Chrome.print(Strings.get(TEXT.ask), 1, 14);
    } else if (this.step === "confirm") {
      Chrome.print(Strings.get(TEXT.isOk), 1, 14);
    }
    if (this.step === "digits") {
      Chrome.textbox(DIGIT_X - 1, DIGIT_Y - 1, DIGITS, 2);
      this.digits.forEach((d, i) => Chrome.print(String(d), DIGIT_X + i, DIGIT_Y));
      Chrome.print("▲", DIGIT_X + this.cursor, DIGIT_Y + 1);
    }
    if (this.step === "ask" || this.step === "confirm") {
      // _ResetClock's menu is NO over YES; "Is this OK?" is YES over NO
      const rows = this.step === "ask" ? [TEXT.no, TEXT.yes] : [TEXT.yes, TEXT.no];
      Chrome.textbox(14, 6, 4, 3);
      rows.forEach((r, i) => Chrome.print(Strings.get(r), 16, 7 + i * 2));
      Chrome.cursor(15, 7 + this.choice * 2);
    }
  }

  draw(): void {
    this.drawPanel();
  }

  drawsWidescreen(): boolean {
    return true;
  }

  drawWidescreen(_winW: number, _winH: number): void {
    G.setColor(1, 1, 1, 1);
    G.push();
    G.origin();
    this.drawPanel();
    G.pop();
  }

  wantsFillScale(): boolean {
    return true;
  }
}

export default ResetClock;
