// gen1recomp src/ui/gen2/MainMenu.lua (bdfac727): Gold's intro menu
// (engine/menus/main_menu.asm MainMenu).
//
// Which entries appear depends on whether a save exists
// (MainMenu_GetWhichMenu reads wSaveFileExists):
//   no save  -> NEW GAME, OPTION
//   save     -> CONTINUE, NEW GAME, OPTION
//   save + MYSTERY GIFT unlocked (Carrie, Goldenrod Dept. Store 5F) -> CONTINUE,
//            NEW GAME, OPTION, MYSTERY GIFT (MAINMENU_MYSTERY; the cart also
//            asks for a Game Boy Color, which every 3DS is)
//
// With a save present the menu also shows the clock box: the GAME clock (the
// RTC through the save's own start base), the same read the overworld makes.
// Choosing CONTINUE shows the save panel (DisplaySaveInfoOnContinue) and waits
// for A to confirm or B to back out (ConfirmContinue).

import { clockResetPending } from "./ResetClock.ts";
import { Clock } from "../core/Clock.ts";
import { Save } from "../core/Save.ts";
import { Logger } from "../shared/core/Logger.ts";
import { Music } from "../shared/core/Music.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Runtime } from "../shared/mods/Runtime.ts";
import { Chrome, type List } from "./Chrome.ts";
import { InitClock } from "./InitClock.ts";
import { MysteryGift } from "../core/MysteryGift.ts";
import { SaveMenu } from "./SaveMenu.ts";

// Lua: MainMenu.lua:31 -- ../pokecrystal/engine/menus/intro_menu.asm:487
// (SaveMenu.PANEL is read lazily: the two modules import each other's graph)
const panel = (): any => (SaveMenu as any).PANEL;
const PANEL_Y = 8;

// Lua: MainMenu.lua:42 -- Clock.DAY_NAMES is the single home for the table
const DAYS = Clock.DAY_NAMES;
const DAY_LABEL = Strings.source("DAY");

// Lua: MainMenu.lua:46 -- MUSIC_MAIN_MENU, resolved by name
const MENU_MUSIC = "Music_MainMenu";

export interface MainMenuOpts {
  onNewGame?: () => void;
  onContinue?: (save: any) => void;
  onOption?: () => void;
  onMysteryGift?: (save: any) => void;
  /** Not the cart's: set the game clock straight from here. */
  onSetClock?: (save: any) => void;
  onExit?: () => void;
  hasSave?: boolean;
  save?: any;
  clock?: { hour?: number; minute?: number; weekday?: number };
}

// Lua: MainMenu.lua:78 -- ui.title_menu.items identity
const sameItems = (_game: unknown, items: unknown): unknown => items;

export class MainMenu {
  static isOpaque = true;
  static DAYS = DAYS;
  static get PANEL(): any {
    return panel();
  }
  static PANEL_Y = PANEL_Y;

  isOpaque = true;
  game: any;
  onNewGame: (() => void) | undefined;
  onContinue: ((save: any) => void) | undefined;
  onOption: (() => void) | undefined;
  onMysteryGift: ((save: any) => void) | undefined;
  onSetClock: ((save: any) => void) | undefined;
  onExit: (() => void) | undefined;
  clock: MainMenuOpts["clock"];
  save: any;
  hasSave: boolean;
  phase: "menu" | "confirm" = "menu";
  confirmDelay = 0;
  list!: List;

  constructor(game: any, opts: MainMenuOpts = {}) {
    this.game = game;
    this.onNewGame = opts.onNewGame;
    this.onContinue = opts.onContinue;
    this.onOption = opts.onOption;
    this.onMysteryGift = opts.onMysteryGift;
    this.onSetClock = opts.onSetClock;
    this.onExit = opts.onExit;
    this.clock = opts.clock;
    this.save = opts.save;
    if (this.save == null && opts.hasSave !== false) {
      const [loaded] = Save.load();
      this.save = loaded;
    }
    this.hasSave = opts.hasSave ?? this.save != null;
    this.buildList();
  }

  /** Lua: MainMenu.lua:54 -- opts: onNewGame, onContinue(save), onOption, onExit, hasSave, save, clock */
  static new(game: any, opts?: MainMenuOpts): MainMenu {
    return new MainMenu(game, opts ?? {});
  }

  /** Lua: MainMenu.lua:48 */
  wantsFillScale(): boolean {
    return true;
  }

  /** Lua: MainMenu.lua:49 */
  drawsWidescreen(): boolean {
    return true;
  }

  /** Lua: MainMenu.lua:80 */
  buildList(): void {
    let items: { label: string; value: unknown }[] = [];
    if (this.hasSave) items.push({ label: Strings.get("CONTINUE"), value: "continue" });
    items.push({ label: Strings.get("NEW GAME"), value: "new" });
    items.push({ label: Strings.get("OPTION"), value: "option" });
    if (this.hasSave && this.onMysteryGift && MysteryGift.unlocked(this.save)) {
      items.push({ label: Strings.get("MYSTERY GIFT"), value: "gift" });
    }
    // Not on the cart: the clock without the title's password dance
    if (this.hasSave && this.onSetClock) items.push({ label: Strings.get("SET CLOCK"), value: "clock" });
    // Not on the cart (Brian's): a row to leave the game, as the Gen 1 port has.
    // The 3DS leaves through HOME, so it shows only when an owner can exit.
    if (this.onExit) items.push({ label: Strings.get("EXIT GAME"), value: "exit" });
    const hooked = Runtime.call("ui.title_menu.items", sameItems, this.game, items);
    if (hooked && typeof hooked === "object") items = hooked as typeof items;
    else Logger.error("ui.title_menu.items returned %s; keeping the vanilla items", typeof hooked);
    // MenuHeader's "db 1 ; default option": the first entry
    this.list = Chrome.List.new({
      items,
      x: 2,
      y: 2,
      spacing: 2,
      wrap: true,
      index: 1,
      onChoose: (value: unknown) => this.choose(value),
    } as any);
  }

  /** Lua: MainMenu.lua:115 */
  choose(value: unknown): void {
    if (value === "continue") {
      this.phase = "confirm";
      this.confirmDelay = 20; // ld c, 20 / DelayFrames before input is read
    } else if (value === "new") {
      if (this.onNewGame) this.onNewGame();
    } else if (value === "option") {
      if (this.onOption) this.onOption();
    } else if (value === "gift") {
      if (this.onMysteryGift) this.onMysteryGift(this.save);
    } else if (value === "clock") {
      if (this.onSetClock) this.onSetClock(this.save);
    } else if (value === "exit") {
      // love.event.quit has no 3DS form: only the owner's onExit
      if (this.onExit) this.onExit();
    }
  }

  /** Lua: MainMenu.lua:132 */
  enter(): void {
    const data = this.game?.data;
    const audio = data?.audio;
    if (audio && audio.runtime && audio.songs && audio.songs[MENU_MUSIC]) Music.play(data, MENU_MUSIC);
  }

  /** Lua: MainMenu.lua:140 */
  update(_dt?: number): void {
    const input = this.game?.input;
    if (!input) return;
    if (this.phase === "confirm") {
      if (this.confirmDelay && this.confirmDelay > 0) {
        this.confirmDelay -= 1;
        return;
      }
      if (input.wasPressed("a")) {
        if (this.onContinue) this.onContinue(this.save);
      } else if (input.wasPressed("b")) {
        this.phase = "menu";
      }
      return;
    }
    this.list.update(input);
  }

  /**
   * Lua: MainMenu.lua:162 -- .PlaceTime's reads after UpdateTime; weekday
   * 1-based for DAYS (Clock.weekday counts SUNDAY 0). A tuple.
   */
  clockParts(): [number, number, number] {
    if (this.clock) return [this.clock.hour ?? 0, this.clock.minute ?? 0, this.clock.weekday ?? 1];
    const save = this.save;
    return [Clock.hour(save), Clock.minute(save), Clock.weekday(save) + 1];
  }

  /** Lua: MainMenu.lua:172 -- ../pokecrystal/engine/rtc/timeset.asm:675 */
  static timeString(hour: number, minute: number): string {
    return InitClock.timeString(hour, minute);
  }

  /** Lua: MainMenu.lua:176 -- ../pokecrystal/engine/menus/main_menu.asm:286 */
  drawClockBox(): void {
    Chrome.textbox(0, 14, 18, 2);
    // .PlaceTime -> .PrintTimeNotSet while sRTCStatusFlags holds RTC_RESET
    if (clockResetPending(this.save)) {
      Chrome.print(Strings.get("TIME NOT SET"), 1, 15);
      return;
    }
    const [hour, minute, weekday] = this.clockParts();
    Chrome.print(Clock.weekdayName(weekday) ?? Strings.get(DAY_LABEL), 1, 15);
    Chrome.print(MainMenu.timeString(hour, minute), 4, 16);
  }

  /** Lua: MainMenu.lua:184 */
  drawSavePanel(): void {
    const PANEL = panel();
    const summary = Save.summary(this.save);
    Chrome.box(PANEL.x, PANEL_Y, PANEL.w, PANEL.h);
    if (!summary) {
      Chrome.print(Strings.get("NO SAVE FILE"), PANEL.labelX, PANEL_Y + PANEL.labelDy);
      return;
    }
    const labelY = PANEL_Y + PANEL.labelDy;
    Chrome.print(Strings.get("PLAYER %s", summary.name), PANEL.labelX, labelY);
    Chrome.print(Strings.get("BADGES"), PANEL.labelX, labelY + 2);
    Chrome.print(Strings.get("POKéDEX"), PANEL.labelX, labelY + 4);
    Chrome.print(Strings.get("TIME"), PANEL.labelX, labelY + 6);
    // ../pokecrystal/engine/menus/intro_menu.asm:555
    Chrome.print(Chrome.number(summary.badges, 2), PANEL.badgesX, PANEL_Y + PANEL.badgesDy);
    Chrome.print(Chrome.number(summary.caught, 3), PANEL.dexX, PANEL_Y + PANEL.dexDy);
    const timeY = PANEL_Y + PANEL.timeDy;
    Chrome.print(Chrome.number(summary.hours, 3), PANEL.timeX, timeY);
    Chrome.print(":", PANEL.timeX + 3, timeY);
    Chrome.print(Chrome.number(summary.minutes, 2, true), PANEL.timeX + 4, timeY);
  }

  /** Lua: MainMenu.lua:207 */
  drawPanel(): void {
    Chrome.clear();
    if (this.phase === "confirm") {
      this.drawSavePanel();
      return;
    }
    // two rows per entry plus the border; EXIT GAME grows it
    Chrome.box(0, 0, 17, Math.min(this.list.items.length * 2 + 2, Chrome.SCREEN_H));
    this.list.draw();
    if (this.hasSave) this.drawClockBox();
  }

  /** Lua: MainMenu.lua:221 */
  draw(): void {
    this.drawPanel();
  }

  /** Lua: MainMenu.lua:225 -- the Gold screen is the panel: no letterbox or fit. */
  drawWidescreen(_winW: number, _winH: number): void {
    this.drawPanel();
  }
}

export default MainMenu;
