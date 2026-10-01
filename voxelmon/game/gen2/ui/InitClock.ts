// gen1recomp src/ui/gen2/InitClock.lua (bdfac727): the clock-setting screens
// (pokegold engine/rtc/timeset.asm).
//
// Two screens out of one file, because the cart builds them out of one set of
// pieces: a Textbox with an up arrow above the value and a down arrow below
// it, the d-pad walking the value with wraparound, A confirming, and a YES/NO
// box that either takes the answer or drops back to the picker.
//
//   mode "clock"  InitClock, the first thing OakSpeech does
//                 (engine/menus/intro_menu.asm OakSpeech: `farcall InitClock`).
//   mode "day"    SetDayOfWeek, the wheel Mom puts up with the POKeGEAR
//                 (maps/PlayersHouse1F.asm `special SetDayOfWeek`).
//
// Layout, from the hlcoord calls:
//   clock hour     Textbox (3,7) 2x15, up arrow (11,7), down (11,10),
//                  "<hour> o'clock" at (4,9)
//   clock minutes  Textbox (11,7) 2x7, up arrow (15,7), down (15,10),
//                  "<mm> min." at (12,9)
//   day            Textbox (9,3) 2x9, up arrow (14,3), down (14,6),
//                  the weekday at (10,5), question in the (0,12) 4x18 box
//
// The answer is written through core/Clock.ts (wStartHour / wStartMinute /
// wStartDay).

import G from "../platform/screen.ts";
import { format, mod } from "../platform/lua.ts";
import { Clock } from "../core/Clock.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Font } from "../shared/render/Font.ts";
import { GbcPalette } from "../shared/render/GbcPalette.ts";
import { Chrome } from "./Chrome.ts";
import { IntroFade } from "./IntroFade.ts";
import { Typer } from "./Typer.ts";

type Colors = readonly (readonly number[])[];

// Lua: InitClock.lua:40 -- data/text/common_1.asm (not extracted: PrintText
// reaches them from engine code).
const TEXT: Record<string, string> = {
  wokeUp: Strings.source("Zzz... Hm? Wha...?\nYou woke me up!" + "\fWill you check the\nclock for me?"),
  whatTime: Strings.source("What time is it?"),
  whatHours: Strings.source("What?\n%s?"),
  howManyMinutes: Strings.source("How many minutes?"),
  whoaMinutes: Strings.source("Whoa!\n%d min.?"),
  // OakText_ResponseToSetTime: NITE and before MORN_HOUR is "So dark...",
  // through DAY_HOUR is "I overslept!", the rest of the day is "Yikes!".
  soDark: Strings.source("%s!\nIt's so dark!"),
  overslept: Strings.source("%s!\nI overslept!"),
  yikes: Strings.source("%s!\nYikes! I over-\nslept!"),
  whatDay: Strings.source("What day is it?"),
  confirmDay: Strings.source("%s, is that right?"),
};

// Lua: InitClock.lua:64 -- constants/misc_constants.asm:37-39
const MORN_HOUR = 4;
const DAY_HOUR = 10;
const NITE_HOUR = 18;

// Lua: InitClock.lua:84 -- Clock.DAY_NAMES is the single translated home.
const DAYS = Clock.DAY_NAMES;

// Lua: InitClock.lua:261 -- data/text/common_1.asm's "@MIN." suffix
const MINUTES = Strings.source("%d min.");

// Lua: InitClock.lua:388 -- TimeSetUpArrowGFX / TimeSetDownArrowGFX
const ARROW_UP = "▲";
const ARROW_DOWN = "▼";

/**
 * Lua: InitClock.lua:390 -- the arrow tile REPLACES the border tile it lands
 * on (hlcoord 11, 7 is the box's own top row).
 *
 * NOT FAITHFUL: the cart loads TimeSetUpArrowGFX / TimeSetDownArrowGFX over
 * the ♂ / ♀ cells and the Lua draws them as 1px rows; the Gold screen has
 * neither a 1px rectangle nor those two tiles cooked, so they are the font's
 * own ▲ (FontsExtra_SolidBlackAndUpArrowGFX) and ▼ glyphs, on the paper.
 */
function arrow(tx: number, ty: number, up: boolean, pal: Colors): void {
  Chrome.printThrough(up ? ARROW_UP : ARROW_DOWN, tx, ty, pal);
  G.setColor(1, 1, 1, 1);
}

export interface InitClockOpts {
  mode?: string;
  save?: any;
  onDone?: (a?: number, b?: number) => void;
  autoConfirm?: boolean;
  fades?: boolean;
  faded?: boolean;
  hour?: number;
  minute?: number;
  day?: number;
}

export class InitClock {
  static isOpaque = true;
  static TEXT = TEXT;
  static DAYS = DAYS;
  // Lua: InitClock.lua:67 -- ../pokecrystal/engine/rtc/timeset.asm:24
  static GROUND = [0, 0, 0];
  // Lua: InitClock.lua:70 -- pokecrystal/engine/gfx/cgb_layouts.asm:517
  static PALETTE: Colors = [
    [255, 255, 255],
    [247, 181, 140],
    [132, 115, 156],
    [0, 0, 0],
  ];

  [key: string]: any;
  game: any;
  mode: "clock" | "day";
  isOpaque: boolean;
  save: any;
  onDone: ((a?: number, b?: number) => void) | undefined;
  autoConfirm: boolean;
  hour: number;
  minute: number;
  day: number;
  yesNo = 1;
  phase: string;
  page = 1;
  typer: Typer;
  fades: boolean;
  blank?: boolean;
  pagesText?: string;
  pagesCache?: string[];

  /** Lua: InitClock.lua:106 -- PrintHour: the time-of-day WORD and a 1-12 hour, "MORN 5". */
  static hourString(hour?: number): string {
    const h = mod(Math.floor(hour ?? 0), 24);
    let display = h % 12;
    if (display === 0) display = 12;
    const word = Clock.daytimeLabel(h);
    return format("%s %d", word, display);
  }

  /** Lua: InitClock.lua:117 */
  static oclockString(hour?: number): string {
    return Strings.get("%s o'clock", InitClock.hourString(hour));
  }

  /** Lua: InitClock.lua:121 */
  static timeString(hour?: number, minute?: number): string {
    return format("%s:%02d", InitClock.hourString(hour), mod(Math.floor(minute ?? 0), 60));
  }

  /** Lua: InitClock.lua:128 -- OakText_ResponseToSetTime's ladder. */
  static responseKey(hour?: number): string {
    const h = mod(Math.floor(hour ?? 0), 24);
    if (h < MORN_HOUR) return "soDark";
    if (h <= DAY_HOUR) return "overslept";
    if (h < NITE_HOUR) return "yikes";
    return "soDark";
  }

  /** Lua: InitClock.lua:139 */
  constructor(game: any, opts: InitClockOpts = {}) {
    this.game = game;
    this.mode = opts.mode === "day" ? "day" : "clock";
    // ../pokecrystal/engine/rtc/timeset.asm:385
    this.isOpaque = this.mode !== "day";
    this.save = opts.save ?? (game ? game.save : undefined);
    this.onDone = opts.onDone;
    this.autoConfirm = opts.autoConfirm || false;
    this.hour = opts.hour ?? Clock.DEFAULT_HOUR;
    this.minute = opts.minute ?? Clock.DEFAULT_MINUTE;
    // `xor a / ld [wTempDayOfWeek], a`: the wheel opens on SUNDAY.
    this.day = opts.day ?? 0;
    // YesNoBox's cursor, which opens on YES.
    this.yesNo = 1;
    // The cart opens on the "you woke me up" page; the day wheel has no preamble.
    this.phase = this.mode === "day" ? "day" : "intro";
    this.page = 1;
    // ../pokecrystal/home/print_text.asm:5
    this.typer = Typer.new(game, { instant: this.autoConfirm || this.mode === "day" });
    this.startText();
    this.fades = !!opts.fades && this.mode !== "day" && !this.autoConfirm;
    if (this.fades) {
      // ../pokecrystal/engine/rtc/timeset.asm:22, :42
      if (opts.faded) {
        IntroFade.run(this, ["inBlack"]);
      } else {
        // ../pokecrystal/engine/menus/intro_menu.asm:42-49, :65
        this.blank = true;
        IntroFade.run(this, ["outBlack"], () => {
          this.blank = false;
          IntroFade.run(this, ["inBlack"]);
        });
      }
    }
  }

  /** Lua: InitClock.lua:139 */
  static new(game: any, opts?: InitClockOpts): InitClock {
    return new InitClock(game, opts ?? {});
  }

  /** Lua: InitClock.lua:75 -- ../pokecrystal/home/text.asm:108 */
  palette(): Colors {
    if (this.mode === "day") return Chrome.DEFAULT_BOX_PALETTE;
    return InitClock.PALETTE;
  }

  /** Lua: InitClock.lua:88 -- ../pokecrystal/engine/rtc/timeset.asm:385 */
  wantsFillScale(): boolean {
    return this.mode !== "day";
  }

  /** Lua: InitClock.lua:89 */
  drawsWidescreen(): boolean {
    return this.mode !== "day";
  }

  /** Lua: InitClock.lua:184 */
  startText(): void {
    if (this.typer) this.typer.start(this.pageText());
  }

  /** Lua: InitClock.lua:189 -- the current question, split into its pages. */
  pages(): string[] {
    const question = this.question();
    if (this.pagesText === question && this.pagesCache) return this.pagesCache;
    const out: string[] = [];
    for (const page of question.split("\f")) {
      if (page !== "") {
        const lines = page.split("\n");
        // ../pokecrystal/home/text.asm:502
        out.push([lines[0], lines[1]].filter((l) => l !== undefined).join("\n"));
        for (let i = 3; i <= lines.length; i++) out.push([lines[i - 2], lines[i - 1]].join("\n"));
      }
    }
    if (out.length === 0) out[0] = "";
    this.pagesText = question;
    this.pagesCache = out;
    return out;
  }

  /** Lua: InitClock.lua:211 */
  pageText(): string {
    const pages = this.pages();
    return pages[Math.min(this.page, pages.length) - 1] ?? "";
  }

  /** Lua: InitClock.lua:217 -- true while there is another page of the same question. */
  morePages(): boolean {
    return this.page < this.pages().length;
  }

  /** Lua: InitClock.lua:222 -- the value the picker is walking and its wrap limit; a tuple. */
  value(): [number, number] {
    if (this.phase === "hour") return [this.hour, 23];
    if (this.phase === "minute") return [this.minute, 59];
    return [this.day, 6];
  }

  /** Lua: InitClock.lua:228 -- .AdvanceThroughMidnight / .DecreaseThroughMidnight: both ends wrap. */
  step(delta: number): void {
    let [value, last] = this.value();
    value = mod(value + delta, last + 1);
    if (this.phase === "hour") this.hour = value;
    else if (this.phase === "minute") this.minute = value;
    else this.day = value;
  }

  /** Lua: InitClock.lua:238 -- the line printed above the picker. */
  question(): string {
    if (this.phase === "intro") return Strings.get(TEXT.wokeUp!);
    if (this.phase === "hour") return Strings.get(TEXT.whatTime!);
    if (this.phase === "minute") return Strings.get(TEXT.howManyMinutes!);
    if (this.phase === "day") return Strings.get(TEXT.whatDay!);
    if (this.phase === "confirm-hour") return Strings.get(TEXT.whatHours!, InitClock.oclockString(this.hour));
    if (this.phase === "confirm-minute") return Strings.get(TEXT.whoaMinutes!, this.minute);
    if (this.phase === "confirm-day") return Strings.get(TEXT.confirmDay!, Clock.weekdayName(this.day + 1) ?? "?");
    if (this.phase === "response") {
      return Strings.get(TEXT[InitClock.responseKey(this.hour)]!, InitClock.timeString(this.hour, this.minute));
    }
    return "";
  }

  /** Lua: InitClock.lua:264 -- the value the picker box shows, or undefined. */
  display(): string | undefined {
    if (this.phase === "hour") return InitClock.oclockString(this.hour);
    if (this.phase === "minute") return Strings.get(MINUTES, this.minute);
    if (this.phase === "day") return Clock.weekdayName(this.day + 1) ?? "?";
    return undefined;
  }

  /** Lua: InitClock.lua:271 */
  confirming(): boolean {
    return this.phase === "confirm-hour" || this.phase === "confirm-minute" || this.phase === "confirm-day";
  }

  /** Lua: InitClock.lua:276 */
  finish(): void {
    if (this.mode === "day") {
      Clock.setWeekday(this.save, this.day);
      if (this.onDone) this.onDone(this.day);
      return;
    }
    Clock.setTime(this.save, this.hour, this.minute);
    const done = (): void => {
      if (this.onDone) this.onDone(this.hour, this.minute);
    };
    // ../pokecrystal/engine/menus/intro_menu.asm:628
    if (this.fades) return IntroFade.run(this, ["outBlack"], done);
    done();
  }

  /** Lua: InitClock.lua:293 -- A on a picker confirms it, YES takes it, NO drops back. */
  accept(): void {
    // A on a page that has more behind it turns the page, the way `para` does.
    if (this.morePages()) {
      this.page += 1;
      this.startText();
      return;
    }
    this.page = 1;
    if (this.phase === "intro") {
      this.phase = "hour";
    } else if (this.phase === "hour") {
      this.phase = "confirm-hour";
    } else if (this.phase === "confirm-hour") {
      this.phase = "minute";
    } else if (this.phase === "minute") {
      this.phase = "confirm-minute";
    } else if (this.phase === "confirm-minute") {
      this.phase = "response";
    } else if (this.phase === "response") {
      // ../pokecrystal/engine/menus/intro_menu.asm:628
      return this.finish();
    } else if (this.phase === "day") {
      this.phase = "confirm-day";
    } else if (this.phase === "confirm-day") {
      return this.finish();
    }
    this.startText();
  }

  /** Lua: InitClock.lua:322 */
  decline(): void {
    if (this.phase === "confirm-hour") this.phase = "hour";
    else if (this.phase === "confirm-minute") this.phase = "minute";
    else if (this.phase === "confirm-day") this.phase = "day";
    this.startText();
  }

  /** Lua: InitClock.lua:333 */
  update(_dt?: number): void {
    // ../pokecrystal/home/fade.asm:22-101
    if (IntroFade.advance(this)) return;
    // The driver path walks itself to the end taking every default.
    if (this.autoConfirm) {
      this.accept();
      return;
    }
    const input = this.game && this.game.input;
    // ../pokecrystal/home/print_text.asm:5, ../pokecrystal/home/text.asm:473
    if (this.typer && !this.typer.tick()) {
      if (input && (input.wasPressed("a") || input.wasPressed("b"))) this.typer.shown = this.typer.total;
      return;
    }
    if (!input) return;
    if (this.confirming() && !this.morePages()) {
      // YesNoBox: the cursor walks two rows and B is NO.
      if (input.wasPressed("up") || input.wasPressed("down")) {
        this.yesNo = this.yesNo === 1 ? 2 : 1;
      } else if (input.wasPressed("a")) {
        if (this.yesNo === 1) this.accept();
        else this.decline();
        this.yesNo = 1;
      } else if (input.wasPressed("b")) {
        this.decline();
        this.yesNo = 1;
      }
      return;
    }
    if (input.wasPressed("up")) this.step(1);
    else if (input.wasPressed("down")) this.step(-1);
    else if (input.wasPressed("a")) this.accept();
  }

  // ------------------------------------------------------------------ drawing

  /**
   * Lua: InitClock.lua:377 -- the picker box: (bx, by, bw, bh, arrowX, tx, ty),
   * or null while no picker is up.
   */
  pickerBox(): [number, number, number, number, number, number, number] | null {
    if (this.phase === "hour") return [3, 7, 15, 2, 11, 4, 9];
    if (this.phase === "minute") return [11, 7, 7, 2, 15, 12, 9];
    if (this.phase === "day") return [9, 3, 9, 2, 14, 10, 5];
    return null;
  }

  /** Lua: InitClock.lua:407 */
  drawPanel(): void {
    // ../pokecrystal/engine/menus/intro_menu.asm:42-49
    const palette = this.palette();
    if (this.blank) {
      Chrome.paletteFill(0, 0, Chrome.SCREEN_W * 8, Chrome.SCREEN_H * 8, palette);
      G.setColor(1, 1, 1, 1);
      return;
    }
    // ../pokecrystal/engine/rtc/timeset.asm:22-32
    if (this.mode !== "day") {
      const ground = GbcPalette.color(palette, 4) ?? InitClock.GROUND;
      G.setColor(ground[0]! / 255, ground[1]! / 255, ground[2]! / 255, 1);
      G.rectangle("fill", 0, 0, Chrome.SCREEN_W * 8, Chrome.SCREEN_H * 8);
      G.setColor(1, 1, 1, 1);
    }
    const value = this.display();
    if (value) {
      const [bx, by, bw, bh, arrowX, tx, ty] = this.pickerBox()!;
      Chrome.paletteBox(bx, by, bw + 2, bh + 2, palette);
      // The two arrows sit ON the border rows.
      arrow(arrowX, by, true, palette);
      arrow(arrowX, by + bh + 1, false, palette);
      Chrome.printThrough(value, tx, ty, palette);
    }
    // The question shares the bottom textbox every other Gold prompt uses.
    Chrome.paletteBox(0, 12, 20, 6, palette);
    // ../pokecrystal/home/text.asm:473
    Chrome.printWrapped((Typer.text(this, []) as string[]).join("\n"), 1, 14, 18, 2, 2, palette);
    if (this.confirming()) {
      // ../pokecrystal/home/menu.asm:418
      Chrome.paletteBox(14, 7, 6, 5, palette);
      Chrome.printThrough(Strings.get("YES"), 16, 8, palette);
      Chrome.printThrough(Strings.get("NO"), 16, 10, palette);
      Chrome.cursorThrough(15, this.yesNo === 1 ? 8 : 10, palette);
    }
  }

  /** Lua: InitClock.lua:448 */
  drawBody(): void {
    IntroFade.paint(this, Chrome.SCREEN_W * 8, Chrome.SCREEN_H * 8, () => this.drawPanel());
  }

  /** Lua: InitClock.lua:453 */
  draw(): void {
    Chrome.withClip(() => this.drawBody());
  }

  /** Lua: InitClock.lua:457 */
  drawWidescreen(winW: number, winH: number): void {
    const ground = InitClock.GROUND;
    let r = ground[0]! / 255;
    let g = ground[1]! / 255;
    let b = ground[2]! / 255;
    if (this.blank) {
      r = 1;
      g = 1;
      b = 1;
    }
    const index = this.blank ? 1 : 4;
    [r, g, b] = IntroFade.surround(this, this.palette(), r, g, b, index);
    Chrome.withPanel(winW, winH, r, g, b, () => this.drawBody());
  }
}

export default InitClock;
