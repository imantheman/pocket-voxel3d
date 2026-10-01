// gen1recomp src/ui/gen2/PcMenu.lua (bdfac727, MIT): the Pokemon PC's top
// menu (engine/pokemon/bills_pc_top.asm _BillsPC).
//
//   WITHDRAW POKéMON / DEPOSIT POKéMON / CHANGE BOX /
//   MOVE POKéMON W/O MAIL / MAIL BOX / SEE YA!
//
// MAIL BOX is the item PC's PLAYERSPCITEM_MAIL_BOX row rather than one of
// _BillsPC's five; a directly-constructed PcMenu still folds both PCs.  The
// Pokecenter's whose-PC menu (ui/CenterPcMenu.ts) opens this as BILL's PC with
// `bills = true`, which shows the cart's own five rows and leaves the MAIL BOX
// to <PLAYER>'s PC (ui/ItemPcMenu.ts).
//
// .MenuHeader is menu_coords 0, 0, 19, 17 -- the menu owns the whole screen,
// with "What?" in a text box along the bottom.  Choosing an entry pushes
// BoxMenu (the withdraw/deposit list) or the box picker.
//
// The assembled rows run through the ui.pc.items hook (Runtime.call, a null
// bus here), with SEE YA! appended after it.

import G from "../platform/screen.ts";
import { format } from "../platform/lua.ts";
import { Boxes } from "../core/Boxes.ts";
import { Mail } from "../core/Mail.ts";
import { Save } from "../core/Save.ts";
import { Logger } from "../shared/core/Logger.ts";
import { Sound } from "../shared/core/Sound.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Runtime } from "../shared/mods/Runtime.ts";
import { Screens } from "../shared/ui/Screens.ts";
import { Chrome } from "./Chrome.ts";
import { SaveMenu } from "./SaveMenu.ts";
import { Typer, type TyperPage } from "./Typer.ts";

export interface PcEntry {
  id?: string;
  label: string;
  builtin?: boolean;
  onSelect?: (menu: PcMenu, game: any) => void;
}

export interface PcMenuOpts {
  save?: any;
  house?: any;
  events?: any;
  bills?: boolean;
  writer?: (save: any) => unknown;
  saveExists?: boolean;
  onClose?: (changedDecorations: boolean) => void;
}

type SavePhase = "confirm" | "overwrite" | "saving" | "done";

// Lua: PcMenu.lua:38 -- _PCMonHoldingMailText (data/text/common_2.asm), the
// refusal BillsPC_MovePKMNMenu prints instead of opening the list.  Two
// pages, because the ASM has a `para` in the middle of it.
const MON_HOLDING_MAIL = [
  Strings.source("There is a POKéMON\nholding MAIL."),
  Strings.source("Please remove the\nMAIL."),
];

// Lua: PcMenu.lua:45 -- ../pokegold/data/text/common_2.asm:1306 _ChangeBoxSaveText
const CHANGE_BOX_SAVE_SOURCE = Strings.source("When you change a\n#MON BOX, data\vwill be saved. OK?");

// Lua: PcMenu.lua:48 -- YesNoBox's own `lb bc, SCREEN_WIDTH - 6, 7`
// (home/menu.asm:382-383).
const YESNO_X = 14, YESNO_Y = 7, YESNO_W = 6, YESNO_H = 5;

// Lua: PcMenu.lua:58 -- .strings, verbatim.  <PK> and <MN> are real font
// glyphs (codes $e1/$e2), which is the only reason "MOVE <PK><MN> W/O MAIL"
// fits inside a 20-tile screen.
const ENTRIES: PcEntry[] = [
  { id: "withdraw", label: Strings.source("WITHDRAW <PK><MN>"), builtin: true },
  { id: "deposit", label: Strings.source("DEPOSIT <PK><MN>"), builtin: true },
  { id: "changebox", label: Strings.source("CHANGE BOX"), builtin: true },
  { id: "move", label: Strings.source("MOVE <PK><MN> W/O MAIL"), builtin: true },
  // PLAYERSPCITEM_MAIL_BOX (engine/events/pokecenter_pc.asm), which BOTH
  // .WhichPC lists carry.
  { id: "mailbox", label: Strings.source("MAIL BOX"), builtin: true },
  { id: "seeya", label: Strings.source("SEE YA!"), builtin: true },
];

// Lua: PcMenu.lua:76 -- PLAYERSPCITEM_DECORATION, the one row the bedroom's
// PC has that a Pokecenter's does not; gated on `house`.
const DECORATION: PcEntry = {
  id: "decoration", label: Strings.source("DECORATION"), builtin: true,
};

// Lua: PcMenu.lua:85 -- the exit row, put back on the end AFTER the
// ui.pc.items hook has run, so a mod cannot orphan the way out.
const EXIT_ID = "seeya";

// Lua: PcMenu.lua:88 -- ui.pc.items identity: an unhooked build hands its
// own list back.
function sameItems(_game: any, items: PcEntry[]): PcEntry[] {
  return items;
}

export class PcMenu {
  // Lua: PcMenu.lua:52
  static isOpaque = true;
  isOpaque = true;
  // Lua: PcMenu.lua:553
  static ENTRIES = ENTRIES;

  game: any;
  save: any;
  onClose?: (changedDecorations: boolean) => void;
  house: boolean;
  events: any;
  writer: (save: any) => unknown;
  saveExists?: boolean;
  entries: PcEntry[];
  changedDecorations: boolean;
  index: number;
  message: string | undefined;
  messagePages: string[] | undefined;
  messagePage: number | undefined;
  messageCloses: boolean;
  picking?: boolean;
  pickIndex = 1;
  changeBox?: number;
  savePhase?: SavePhase;
  saveChoice = 1;
  saved?: boolean;
  existed?: boolean;
  savePage?: number;
  saveTimer = 0;
  typer?: Typer;
  savePagesText?: string;
  savePagesCache?: TyperPage[];
  [key: string]: any;

  /** Lua: PcMenu.lua:90 */
  wantsFillScale(): boolean {
    return true;
  }

  /** Lua: PcMenu.lua:91 */
  drawsWidescreen(): boolean {
    return true;
  }

  /**
   * Lua: PcMenu.lua:98 -- opts: save, house (the bedroom's PC, which also
   * does decorations), events, bills (_BillsPC's own five rows, no MAIL BOX),
   * onClose(changedDecorations)
   */
  static new(game: any, opts?: PcMenuOpts): PcMenu {
    return new PcMenu(game, opts ?? {});
  }

  constructor(game: any, opts: PcMenuOpts) {
    this.game = game;
    this.save = opts.save || (game && game.save);
    this.onClose = opts.onClose;
    this.house = opts.house ? true : false;
    this.events = opts.events;
    // The same route the start menu's SAVE row takes (Game2.writeSave).
    this.writer = opts.writer
      || (game && typeof game.writeSave === "function" ? () => game.writeSave() : undefined)
      || ((s: any) => Save.save(s));
    this.saveExists = opts.saveExists;
    // BILL's PC shows the cart's own five rows; the bedroom's PC keeps the
    // MAILBOX (it is on both .WhichPC lists).
    const dropMailbox = opts.bills && !this.house;
    let entries: PcEntry[] = [];
    for (const entry of ENTRIES) {
      const drop = entry.id === EXIT_ID || (dropMailbox && entry.id === "mailbox");
      if (!drop) entries.push(entry);
    }
    if (this.house) entries.push(DECORATION);
    // Lua: PcMenu.lua:132 -- same hook name and payload as the Gen 1 PC.  A
    // hook that answers with anything but a table is degraded to vanilla.
    const hooked: unknown = Runtime.call("ui.pc.items", sameItems, game, entries);
    if (Array.isArray(hooked)) {
      entries = hooked as PcEntry[];
    } else {
      Logger.error("ui.pc.items returned %s; keeping the vanilla items", typeof hooked);
    }
    // SEE YA! goes back on last: it is the row B lands on.
    for (const entry of ENTRIES) {
      if (entry.id === EXIT_ID) entries.push(entry);
    }
    this.entries = entries;
    // wChangedDecorations, carried out to `special PlayersHousePC`.
    this.changedDecorations = false;
    this.index = 1;
    this.message = undefined;
    // Whether clearing the message also logs off: .CheckCanUsePC's does;
    // BillsPC_MovePKMNMenu's mail refusal does not.
    this.messageCloses = true;
    // Lua: PcMenu.lua:163 -- .CheckCanUsePC: an empty party gets the
    // "You'll need a POKéMON" line and the PC never opens.
    const [ok, reason] = Boxes.canUsePc(this.save);
    if (!ok) {
      const pages = (Strings.get(reason!) + "\f").split("\f");
      pages.pop();
      this.message = pages[0];
      this.messagePages = pages;
      this.messagePage = 1;
    }
  }

  /**
   * Lua: PcMenu.lua:181 -- a refusal that leaves the PC open: the message
   * replaces the menu until a button clears it.
   */
  notice(pages: string[]): void {
    this.message = pages[0];
    this.messagePages = pages;
    this.messagePage = 1;
    this.messageCloses = false;
  }

  /** Lua: PcMenu.lua:189 -- home/menu.asm:746 */
  playSfx(name: string): void {
    const data = this.game && this.game.data;
    const sfx = data && data.audio && data.audio.sfx;
    if (sfx && sfx[Sound.resolve(data, name)]) Sound.play(data, name);
  }

  /** Lua: PcMenu.lua:195 */
  close(): void {
    if (this.onClose) this.onClose(this.changedDecorations);
  }

  /**
   * Lua: PcMenu.lua:201 -- engine/pokemon/bills_pc.asm:2403
   * BillsPC_ChangeBoxSubmenu .Switch, engine/menus/save.asm:40 ChangeBoxSaveGame
   */
  beginChangeBox(index: number): void {
    this.changeBox = index;
    this.setSavePhase("confirm");
    this.saveChoice = 1;
    this.saved = undefined;
    let existed = this.saveExists;
    if (existed == null) existed = Save.exists();
    this.existed = existed;
  }

  /** Lua: PcMenu.lua:212 -- .refused: wCurBox untouched, the picker still up. */
  refuseChangeBox(): void {
    this.savePhase = undefined;
    this.changeBox = undefined;
    this.saveTimer = 0;
    this.typer = undefined;
  }

  /** Lua: PcMenu.lua:220 -- save.asm:336 SavingDontTurnOffThePower / :241 SavedTheGame */
  setSavePhase(phase: SavePhase): void {
    this.savePhase = phase;
    this.savePage = 1;
    this.saveTimer = 0;
    const pinned = phase === "saving" || phase === "done" ? "MID" : undefined;
    this.typer = Typer.new(this.game, { speed: pinned });
    this.typer.start(this.savePages()[0]);
  }

  /** Lua: PcMenu.lua:229 */
  acceptChangeBox(): void {
    if (this.saveChoice === 2) return this.refuseChangeBox();
    if (this.savePhase === "confirm" && this.existed) {
      this.setSavePhase("overwrite");
      this.saveChoice = 1;
      return;
    }
    this.setSavePhase("saving");
  }

  /**
   * Lua: PcMenu.lua:241 -- `ld [wCurBox], a` sits between SaveBox and
   * SavingDontTurnOffThePower, so the new index rides the file written.
   */
  writeChangeBox(): void {
    Boxes.setCurrent(this.save, this.changeBox!);
    const result = this.writer(this.save);
    // the writer answers `ok, err` (a tuple here); only `ok` is read
    const ok = Array.isArray(result) ? result[0] : result;
    this.saved = ok ? true : false;
    // engine/menus/save.asm:266
    if (ok) {
      Sound.waitSfxDone();
      SaveMenu.playSaveSfx(this.game, SaveMenu.SFX_SAVE);
    }
  }

  /** Lua: PcMenu.lua:252 */
  savePromptText(): string {
    if (this.savePhase === "overwrite") return Strings.get(SaveMenu.OVERWRITE_PROMPT_SOURCE);
    if (this.savePhase === "saving") return Strings.get(SaveMenu.SAVING_PROMPT_SOURCE);
    if (this.savePhase === "done") {
      if (this.saved) {
        const name = (this.save.player && this.save.player.name) || "GOLD";
        return Strings.get("%s saved\nthe game.", name);
      }
      return Strings.get("Could not save.");
    }
    return Strings.get(CHANGE_BOX_SAVE_SOURCE);
  }

  /** Lua: PcMenu.lua:269 */
  savePages(): TyperPage[] {
    const text = this.savePromptText();
    if (this.savePagesText !== text || !this.savePagesCache) {
      this.savePagesText = text;
      this.savePagesCache = SaveMenu.pagesOf(text);
    }
    return this.savePagesCache;
  }

  /** Lua: PcMenu.lua:278 */
  savePrompt(): TyperPage | undefined {
    const pages = this.savePages();
    return pages[(this.savePage || 1) - 1] || pages[0];
  }

  /** Lua: PcMenu.lua:284 -- save.asm:209 SaveTheGame_yesorno */
  saveYesNoVisible(pages?: TyperPage[]): boolean {
    if (this.savePhase !== "confirm" && this.savePhase !== "overwrite") return false;
    if (Typer.typing(this)) return false;
    return (this.savePage || 1) >= (pages || this.savePages()).length;
  }

  /** Lua: PcMenu.lua:292 */
  updateChangeBox(): void {
    const typed = Typer.step(this);
    // SavingDontTurnOffThePower is DelayFrames, not a prompt
    // (engine/menus/save.asm:55).
    if (this.savePhase === "saving") {
      if (!typed) return;
      this.saveTimer = this.saveTimer + 1;
      if (this.saveTimer >= SaveMenu.SAVING_FRAMES) {
        this.writeChangeBox();
        this.setSavePhase("done");
      }
      return;
    }
    if (this.savePhase === "done") {
      if (!typed) return;
      this.saveTimer = this.saveTimer + 1;
      if (this.saveTimer >= SaveMenu.SAVED_FRAMES) {
        this.savePhase = undefined;
        this.changeBox = undefined;
        this.picking = false;
        this.typer = undefined;
      }
      return;
    }

    const input = this.game && this.game.input;
    if (!input) return;
    if (Typer.typing(this)) return;
    // ../pokecrystal/home/text.asm:502 _ContText
    if (!this.saveYesNoVisible()) {
      if (input.wasPressed("a") || input.wasPressed("b")) {
        this.playSfx("Sfx_ReadText2");
        this.savePage = (this.savePage || 1) + 1;
        if (this.typer) this.typer.start(this.savePages()[this.savePage - 1]);
      }
      return;
    }
    if (input.wasPressed("up") || input.wasPressed("down")) {
      this.saveChoice = this.saveChoice === 1 ? 2 : 1;
    } else if (input.wasPressed("a")) {
      // home/menu.asm:345
      this.playSfx("Sfx_ReadText2");
      this.acceptChangeBox();
    } else if (input.wasPressed("b")) {
      // B out of a yes/no is NO (InterpretTwoOptionMenu returns carry).
      this.playSfx("Sfx_ReadText2");
      this.refuseChangeBox();
    }
  }

  /** Lua: PcMenu.lua:341 */
  choose(): void {
    const entry = this.entries[this.index - 1];
    if (!entry) return;
    const game = this.game;
    // A hook-injected row carries label + onSelect and no id the ladder knows.
    if (typeof entry.onSelect === "function") {
      entry.onSelect(this, game);
      return;
    }
    if (entry.id === "seeya") {
      this.close();
      return;
    }
    if (entry.id === "decoration") {
      if (!(game && game.stack)) return;
      Screens.push(game, "Gen2DecorationMenu", {
        save: this.save,
        events: this.events,
        onDone: (changed: any) => {
          this.changedDecorations = this.changedDecorations || changed || false;
          game.stack.pop();
        },
      });
      return;
    }
    if (entry.id === "mailbox") {
      if (!(game && game.stack)) return;
      Screens.push(game, "Gen2MailboxMenu", {
        save: this.save,
        onClose: () => game.stack.pop(),
      });
      return;
    }
    if (entry.id === "changebox") {
      this.picking = true;
      this.pickIndex = this.save.currentBox || 1;
      return;
    }
    // BillsPC_MovePKMNMenu asks IsAnyMonHoldingMail BEFORE it opens the list.
    if (entry.id === "move" && Mail.anyMonHoldingMail(this.save)) {
      this.notice([Strings.get(MON_HOLDING_MAIL[0]!), Strings.get(MON_HOLDING_MAIL[1]!)]);
      return;
    }
    if (!(game && game.stack)) return;
    Screens.push(game, "Gen2BoxMenu", {
      save: this.save,
      mode: entry.id, // "withdraw" | "deposit" | "move"
      onClose: () => game.stack.pop(),
    });
  }

  /** Lua: PcMenu.lua:396 */
  update(_dt?: number): void {
    const input = this.game && this.game.input;
    if (!input) return;

    if (this.message != null) {
      if (input.wasPressed("a") || input.wasPressed("b")) {
        const pages = this.messagePages;
        if (pages && this.messagePage! < pages.length) {
          this.messagePage = this.messagePage! + 1;
          this.message = pages[this.messagePage - 1];
          return;
        }
        const closes = this.messageCloses;
        this.message = undefined;
        this.messagePages = undefined;
        this.messagePage = undefined;
        this.messageCloses = true;
        if (closes) this.close();
      }
      return;
    }

    if (this.savePhase) {
      this.updateChangeBox();
      return;
    }

    if (this.picking) {
      const total = Boxes.NUM_BOXES;
      if (input.wasPressed("up")) {
        this.pickIndex = this.pickIndex > 1 ? this.pickIndex - 1 : total;
      } else if (input.wasPressed("down")) {
        this.pickIndex = this.pickIndex < total ? this.pickIndex + 1 : 1;
      } else if (input.wasPressed("a")) {
        // engine/menus/scrolling_menu.asm:24
        this.playSfx("Sfx_ReadText2");
        if (this.pickIndex === (this.save.currentBox || 1)) {
          this.picking = false;
        } else {
          this.beginChangeBox(this.pickIndex);
        }
      } else if (input.wasPressed("b")) {
        this.playSfx("Sfx_ReadText2");
        this.picking = false;
      }
      return;
    }

    if (input.wasPressed("up")) {
      this.index = this.index > 1 ? this.index - 1 : this.entries.length;
    } else if (input.wasPressed("down")) {
      this.index = this.index < this.entries.length ? this.index + 1 : 1;
    } else if (input.wasPressed("a")) {
      // home/menu.asm:476
      this.playSfx("Sfx_ReadText2");
      this.choose();
    } else if (input.wasPressed("b")) {
      this.playSfx("Sfx_ReadText2");
      this.close();
    }
  }

  /** Lua: PcMenu.lua:456 */
  drawPanel(): void {
    Chrome.clear();
    if (this.message != null) {
      Chrome.box(0, 12, 20, 6);
      // A text box's two lines sit two tile rows apart (TextBox line1 = ty+2,
      // line2 = ty+4).
      let line = 14;
      for (const part of this.message.split("\n")) {
        Chrome.print(part, 1, line);
        line = line + 2;
      }
      G.setColor(1, 1, 1, 1);
      return;
    }

    if (this.picking) {
      // CHANGE BOX: the 14 box names with how full each one is, six at a time.
      Chrome.box(0, 0, 20, 14);
      const rows = 6;
      const scroll = Math.max(0, Math.min(this.pickIndex - rows, Boxes.NUM_BOXES - rows));
      for (let row = 1; row <= rows; row++) {
        const i = row + scroll;
        const ty = row * 2 - 1;
        if (i === this.pickIndex) Chrome.cursor(1, ty);
        Chrome.print(Boxes.name(this.save, i), 2, ty);
        Chrome.printRight(format("%d/%d", Boxes.count(this.save, i), Boxes.MONS_PER_BOX), 18, ty);
      }
      if (this.savePhase) {
        // ChangeBoxSaveGame's MenuTextbox, then YesNoBox over the box list.
        Chrome.box(0, 12, 20, 6);
        const pages = this.savePages();
        const page = pages[(this.savePage || 1) - 1] || pages[0];
        const lines = Typer.text(this, typeof page === "string" ? page.split("\n") : page) || [];
        Chrome.print(lines[0] || "", 1, 14);
        Chrome.print(lines[1] || "", 1, 16);
        if (!Typer.typing(this) && (this.savePage || 1) < pages.length && Typer.arrowOn(this)) {
          Chrome.print(SaveMenu.DOWN_ARROW, SaveMenu.ARROW_X, SaveMenu.ARROW_Y);
        }
        if (this.saveYesNoVisible(pages)) {
          Chrome.box(YESNO_X, YESNO_Y, YESNO_W, YESNO_H);
          Chrome.print(Strings.get("YES"), YESNO_X + 2, YESNO_Y + 1);
          Chrome.print(Strings.get("NO"), YESNO_X + 2, YESNO_Y + 3);
          Chrome.cursor(YESNO_X + 1, YESNO_Y + (this.saveChoice === 1 ? 1 : 3));
        }
        G.setColor(1, 1, 1, 1);
        return;
      }
      Chrome.box(0, 14, 20, 4);
      Chrome.print(Strings.get("Which BOX?"), 1, 16);
      G.setColor(1, 1, 1, 1);
      return;
    }

    // .LogIn prints _PCWhatText ("What?") into the (0,12) box at (1,14).  The
    // box goes down first: the menu window is drawn over it wherever a folded
    // list runs past row 12.
    Chrome.box(0, 12, 20, 6);
    Chrome.print(Strings.get("What?"), 1, 14);

    // ClearPCItemScreen: Textbox at (0,0) with a 10x18 interior; labels at
    // (2,2), rows two apart, cursor one column left.  The window is sized to
    // the list rather than to the five the cart ships.
    Chrome.box(0, 0, 20, Math.max(12, this.entries.length * 2 + 2));
    this.entries.forEach((entry, k) => {
      const i = k + 1;
      const ty = i * 2;
      if (i === this.index) Chrome.cursor(1, ty);
      Chrome.print(entry.builtin ? Strings.get(entry.label) : entry.label, 2, ty);
    });
    G.setColor(1, 1, 1, 1);
  }

  /** Lua: PcMenu.lua:538 */
  draw(): void {
    this.drawPanel();
  }

  /**
   * Lua: PcMenu.lua:542 -- the letterbox, fit scale and origin are no-ops on
   * the Gold screen (the screen is the panel), so this is drawPanel at the
   * origin.
   */
  drawWidescreen(_winW?: number, _winH?: number): void {
    G.push();
    this.drawPanel();
    G.pop();
  }
}

export default PcMenu;
