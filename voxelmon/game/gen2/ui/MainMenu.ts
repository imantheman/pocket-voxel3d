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
import { TextBox } from "../shared/render/TextBox.ts";
import { Vc } from "../vc/session.ts";

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
  /** VC saves (vc/session.ts): CONTINUE on the VC title's save, and a new
   *  game that saves there. Absent: no VC choice is offered. */
  onContinueVc?: (luaSave: any) => void;
  onNewGameVc?: () => void;
  /** COPY SAVE (not on the cart): one save written over the other with the
   *  VC converter; the owner backs the destination up, writes, and comes
   *  back to a fresh title. Absent: no COPY SAVE row. */
  onCopy?: (dir: CopyDir) => void;
  onOption?: () => void;
  onMysteryGift?: (save: any) => void;
  /** Not the cart's: set the game clock straight from here. */
  onSetClock?: (save: any) => void;
  onExit?: () => void;
  hasSave?: boolean;
  save?: any;
  clock?: { hour?: number; minute?: number; weekday?: number };
}

/** COPY SAVE's directions: the Lua save over the VC title's, or back. */
export type CopyDir = "toVc" | "toLua";

/** The summary a COPY SAVE box shows. */
interface Summary { name: string; badges: number; caught: number; hours: number; minutes: number }

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
  onContinueVc: ((luaSave: any) => void) | undefined;
  onNewGameVc: (() => void) | undefined;
  onCopy: ((dir: CopyDir) => void) | undefined;
  /** COPY SAVE: the directions there are (a source save for each), then
   *  CANCEL; the confirm's YES 1 / NO 2 (NO first). */
  copyRows: { id: CopyDir | "cancel"; label: string }[] = [];
  copyIndex = 0;
  copyDir: CopyDir = "toVc";
  copyChoice = 2;
  /** The save choice (LUA SAVE / VC SAVE), for CONTINUE or NEW GAME. */
  pick: { id: "lua" | "vc"; label: string }[] = [];
  pickIndex = 0;
  pickFor: "continue" | "new" = "continue";
  /** NEW GAME over a VC game: "replaced?", YES 1 / NO 2 (NO first). */
  replaceChoice = 2;
  onOption: (() => void) | undefined;
  onMysteryGift: ((save: any) => void) | undefined;
  onSetClock: ((save: any) => void) | undefined;
  onExit: (() => void) | undefined;
  clock: MainMenuOpts["clock"];
  save: any;
  hasSave: boolean;
  phase: "menu" | "confirm" | "pick" | "replace" | "copy" | "copyConfirm" | "copying" = "menu";
  /** "Copying..." shows this many frames before the copy runs. */
  copyWait = 0;
  confirmDelay = 0;
  list!: List;

  constructor(game: any, opts: MainMenuOpts = {}) {
    this.game = game;
    this.onNewGame = opts.onNewGame;
    this.onContinue = opts.onContinue;
    this.onContinueVc = opts.onContinueVc;
    this.onNewGameVc = opts.onNewGameVc;
    this.onCopy = opts.onCopy;
    this.onOption = opts.onOption;
    this.onMysteryGift = opts.onMysteryGift;
    this.onSetClock = opts.onSetClock;
    this.onExit = opts.onExit;
    this.clock = opts.clock;
    this.save = opts.save;
    if (this.save == null && opts.hasSave !== false) {
      const [loaded, , err] = Save.load();
      this.save = loaded;
      // a save that is there but cannot be read keeps CONTINUE, which says
      // why instead of going on; NEW GAME's first save keeps a copy of it
      if (!loaded && err && err !== "missing") this.loadErr = err;
    }
    this.hasSave = opts.hasSave ?? (this.save != null || this.loadErr !== undefined || this.vcContinues());
    this.buildList();
  }

  /** The VC title's save can be continued (it holds a game). */
  vcContinues(): boolean {
    return !!this.onContinueVc && Vc.present() && Vc.hasGame();
  }

  /** COPY SAVE's rows: a direction only when its source holds a game. */
  copyDirections(): { id: CopyDir; label: string }[] {
    const out: { id: CopyDir; label: string }[] = [];
    if (!this.onCopy || !Vc.present()) return out;
    if (this.save != null) out.push({ id: "toVc", label: Strings.get("LUA TO VC") });
    if (Vc.hasGame()) out.push({ id: "toLua", label: Strings.get("VC TO LUA") });
    return out;
  }

  private openCopy(): void {
    this.copyRows = [...this.copyDirections(), { id: "cancel", label: Strings.get("CANCEL") }];
    this.copyIndex = 0;
    this.phase = "copy";
  }

  /** The save choice, LUA SAVE first; only the saves there are (CONTINUE). */
  private openPick(forWhat: "continue" | "new"): void {
    this.pickFor = forWhat;
    this.pick = [];
    if (forWhat === "new" || this.save != null || this.loadErr !== undefined) this.pick.push({ id: "lua", label: Strings.get("LUA SAVE") });
    this.pick.push({ id: "vc", label: Strings.get("VC SAVE") });
    this.pickIndex = 0;
    this.phase = "pick";
  }

  private pickChosen(id: "lua" | "vc"): void {
    if (this.pickFor === "new") {
      if (id === "lua") { this.onNewGame?.(); return; }
      // a new game saved to the VC title writes over the game in it: asked
      // first, as the cartridge asks before a save replaces an older file
      if (Vc.hasGame()) {
        this.replaceChoice = 2;
        this.phase = "replace";
        return;
      }
      this.onNewGameVc?.();
      return;
    }
    if (id === "lua") {
      if (this.save == null && this.loadErr !== undefined) { this.phase = "menu"; this.sayUnreadable(); return; }
      this.onContinue?.(this.save);
      return;
    }
    this.onContinueVc?.(this.save);
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
    // Not on the cart: copy one save over the other (the VC title there)
    if (this.copyDirections().length) items.push({ label: Strings.get("COPY SAVE"), value: "copy" });
    items.push({ label: Strings.get("OPTION"), value: "option" });
    if (this.save != null && this.onMysteryGift && MysteryGift.unlocked(this.save)) {
      items.push({ label: Strings.get("MYSTERY GIFT"), value: "gift" });
    }
    // Not on the cart: the clock without the title's password dance
    if (this.save != null && this.onSetClock) items.push({ label: Strings.get("SET CLOCK"), value: "clock" });
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

  /** Why the save in the slot could not be read, when it could not. */
  loadErr?: string;

  /** CONTINUE on a save that could not be read: say so, stay on the menu. */
  private sayUnreadable(): void {
    const why = String(this.loadErr ?? "").replace(/\s+/g, " ").slice(0, 54);
    const rows: string[] = [];
    for (let i = 0; i < why.length && rows.length < 3; i += 18) rows.push(why.slice(i, i + 18));
    const text =
      "The save file could\nnot be read.\f" +
      (rows.length ? `${rows.join("\n")}\f` : "") +
      "It is left as it is.\nSaving a new game\nkeeps a copy of it\nas .unreadable.";
    Logger.warn("gold continue refused: %s", String(this.loadErr));
    this.game?.stack?.push?.(TextBox.new(this.game, text));
  }

  /** Lua: MainMenu.lua:115 */
  choose(value: unknown): void {
    // With a VC title holding a game, CONTINUE asks which save; with the
    // VC title there at all, NEW GAME asks where it saves (Lua first).
    if (value === "continue" && this.vcContinues()) {
      this.openPick("continue");
    } else if (value === "new" && this.onNewGameVc && Vc.present()) {
      this.openPick("new");
    } else if (value === "continue" && this.save == null && this.loadErr !== undefined) {
      this.sayUnreadable();
    } else if (value === "continue") {
      this.phase = "confirm";
      this.confirmDelay = 20; // ld c, 20 / DelayFrames before input is read
    } else if (value === "new") {
      if (this.onNewGame) this.onNewGame();
    } else if (value === "copy") {
      this.openCopy();
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
    if (this.phase === "pick") {
      if (input.wasPressed("up") || input.wasPressed("down")) {
        const n = this.pick.length;
        this.pickIndex = (this.pickIndex + (input.wasPressed("up") ? n - 1 : 1)) % n;
      } else if (input.wasPressed("a")) {
        this.pickChosen(this.pick[this.pickIndex]!.id);
      } else if (input.wasPressed("b")) {
        this.phase = "menu";
      }
      return;
    }
    if (this.phase === "copy") {
      if (input.wasPressed("up") || input.wasPressed("down")) {
        const n = this.copyRows.length;
        this.copyIndex = (this.copyIndex + (input.wasPressed("up") ? n - 1 : 1)) % n;
      } else if (input.wasPressed("a")) {
        const id = this.copyRows[this.copyIndex]!.id;
        if (id === "cancel") this.phase = "menu";
        else {
          this.copyDir = id;
          this.copyChoice = 2;
          this.phase = "copyConfirm";
        }
      } else if (input.wasPressed("b")) {
        this.phase = "menu";
      }
      return;
    }
    if (this.phase === "copyConfirm") {
      if (input.wasPressed("up") || input.wasPressed("down")) {
        this.copyChoice = this.copyChoice === 1 ? 2 : 1;
      } else if (input.wasPressed("a")) {
        if (this.copyChoice === 1) {
          console.log(`[pv] vc: copy: ${this.copyDir === "toVc" ? "LUA TO VC" : "VC TO LUA"}: YES`);
          this.phase = "copying";
          this.copyWait = 60;
        } else this.phase = "copy";
      } else if (input.wasPressed("b")) {
        this.phase = "copy";
      }
      return;
    }
    if (this.phase === "copying") {
      if (--this.copyWait <= 0) {
        this.phase = "menu";
        this.onCopy?.(this.copyDir);
      }
      return;
    }
    if (this.phase === "replace") {
      if (input.wasPressed("up") || input.wasPressed("down")) {
        this.replaceChoice = this.replaceChoice === 1 ? 2 : 1;
      } else if (input.wasPressed("a")) {
        if (this.replaceChoice === 1) this.onNewGameVc?.();
        else this.phase = "pick";
      } else if (input.wasPressed("b")) {
        this.phase = "pick";
      }
      return;
    }
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

  /** The save choice: the two saves in the menu's box, and the info box of
   *  the one under the cursor (CONTINUE only). */
  drawPick(): void {
    Chrome.box(0, 0, 17, this.pick.length * 2 + 2);
    this.pick.forEach((e, i) => {
      Chrome.print(e.label, 2, 2 + i * 2);
      if (i === this.pickIndex) Chrome.cursor(1, 2 + i * 2);
    });
    if (this.pickFor !== "continue") return;
    const cur = this.pick[this.pickIndex];
    if (cur?.id === "vc") {
      const s = Vc.summary();
      this.drawSavePanel(s ? { name: s.name, badges: s.badges, caught: s.caught, hours: s.hours, minutes: s.minutes } : undefined);
    } else {
      this.drawSavePanel();
    }
  }

  /** COPY SAVE's directions and CANCEL, in the menu's box. */
  drawCopy(): void {
    Chrome.box(0, 0, 13, this.copyRows.length * 2 + 2);
    this.copyRows.forEach((e, i) => {
      Chrome.print(e.label, 2, 2 + i * 2);
      if (i === this.copyIndex) Chrome.cursor(1, 2 + i * 2);
    });
  }

  /** One save's lines on the copy's confirm: its title, then the four
   *  CONTINUE lines (or "(EMPTY)"), one row each, kept to x <= 12 so the
   *  YES/NO box beside them covers nothing. */
  private drawCopyLines(y: number, title: string, s: Summary | null | undefined): void {
    Chrome.print(title, 1, y);
    if (!s) {
      Chrome.print(Strings.get("   (EMPTY)"), 1, y + 1);
      return;
    }
    Chrome.print(s.name, 2, y + 1);
    Chrome.print(Strings.get("BADGES"), 2, y + 2);
    Chrome.print(Chrome.number(s.badges, 2), 10, y + 2);
    Chrome.print(Strings.get("POKéDEX"), 2, y + 3);
    Chrome.print(Chrome.number(s.caught, 3), 10, y + 3);
    Chrome.print(Strings.get("TIME"), 2, y + 4);
    Chrome.print(Chrome.number(s.hours, 3), 7, y + 4);
    Chrome.print(":", 10, y + 4);
    Chrome.print(Chrome.number(s.minutes, 2, true), 11, y + 4);
  }

  /** The copy's confirm: "COPY: LUA SAVE" and its lines, "REPLACE: VC
   *  SAVE" and its lines (or "TO: VC SAVE" / "(EMPTY)"), then "Copy the LUA
   *  save / over the VC save?" with YES/NO, NO first -- the Gen 1 games'
   *  words (voxelmon/game/vc/copysave.ts). */
  drawCopyConfirm(): void {
    const toVc = this.copyDir === "toVc";
    const vc = Vc.summary();
    const lua = Save.summary(this.save);
    const src = toVc ? lua : vc;
    const dst = toVc ? vc : lua;
    const [from, to] = toVc ? ["LUA", "VC"] : ["VC", "LUA"];
    Chrome.box(0, 0, 20, 12);
    this.drawCopyLines(1, Strings.get("COPY: %s SAVE", from), src);
    this.drawCopyLines(6, dst ? Strings.get("REPLACE: %s SAVE", to) : Strings.get("TO: %s SAVE", to), dst);
    Chrome.textbox(0, 12, 18, 4);
    Chrome.print(Strings.get("Copy the %s save", from), 1, 14);
    Chrome.print(Strings.get("over the %s save?", to), 1, 16);
    Chrome.box(14, 7, 6, 5);
    Chrome.print(Strings.get("YES"), 16, 8);
    Chrome.print(Strings.get("NO"), 16, 10);
    Chrome.cursor(15, this.copyChoice === 1 ? 8 : 10);
  }

  /** "Copying..." while the copy waits its 60 frames. */
  drawCopying(): void {
    Chrome.textbox(0, 12, 18, 4);
    Chrome.print(Strings.get("Copying..."), 1, 14);
  }

  /** "The VC save will be replaced. Is that OK?" -- the YES/NO SaveMenu uses. */
  drawReplace(): void {
    Chrome.textbox(0, 10, 18, 6);
    Chrome.print(Strings.get("The VC save will"), 1, 12);
    Chrome.print(Strings.get("be replaced."), 1, 14);
    Chrome.print(Strings.get("Is that OK?"), 1, 16);
    Chrome.box(0, 4, 6, 5);
    Chrome.print(Strings.get("YES"), 2, 5);
    Chrome.print(Strings.get("NO"), 2, 7);
    Chrome.cursor(1, this.replaceChoice === 1 ? 5 : 7);
  }

  /** Lua: MainMenu.lua:184 (a summary handed in: the VC save's) */
  drawSavePanel(given?: { name: string; badges: number; caught: number; hours: number; minutes: number }): void {
    const PANEL = panel();
    const summary = given ?? Save.summary(this.save);
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
    if (this.phase === "pick") {
      this.drawPick();
      return;
    }
    if (this.phase === "replace") {
      this.drawReplace();
      return;
    }
    if (this.phase === "copy") {
      this.drawCopy();
      return;
    }
    if (this.phase === "copyConfirm") {
      this.drawCopyConfirm();
      return;
    }
    if (this.phase === "copying") {
      this.drawCopying();
      return;
    }
    if (this.phase === "confirm") {
      this.drawSavePanel();
      return;
    }
    // two rows per entry plus the border; EXIT GAME grows it
    Chrome.box(0, 0, 17, Math.min(this.list.items.length * 2 + 2, Chrome.SCREEN_H));
    this.list.draw();
    if (this.save != null) this.drawClockBox();
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
