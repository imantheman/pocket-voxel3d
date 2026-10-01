// gen1recomp src/ui/gen2/MailMenu.lua (bdfac727, MIT): MonMailAction
// (engine/pokemon/mon_menu.asm), the READ / TAKE / QUIT menu the party
// submenu's MAIL row opens.
//
// It is drawn OVER the party list -- MENU_BACKUP_TILES with
// `menu_coords 9, 10, SCREEN_WIDTH - 1, SCREEN_HEIGHT - 1` -- so it is not
// opaque and the list underneath keeps drawing.
//
// TAKE asks "Send the removed MAIL to your PC?" FIRST, and only a no drops
// into "The MAIL will lose its message. OK?", so the destructive answer is two
// deliberate presses away; a full mailbox ends the whole thing.
//
//   READ  ReadPartyMonMail, which is the Gen2MailRead screen
//   TAKE  yes -> SendMailToPC     -> _MailSentToPCText / _MailboxFullText
//         no  -> ReceiveItemFromPokemon on the mail ITEM
//                                 -> _MailDetachedText / _MailNoSpaceText
//   QUIT  `ld a, $3`, i.e. redraw the list and stay in it
//
// Strings are transcribed from data/text/common_2.asm and paired with their
// pokegold label in LABELS: the cache's own characters win when seeded.

import G from "../platform/screen.ts";
import { format } from "../platform/lua.ts";
import { Bag } from "../shared/inventory/Bag.ts";
import { CommonText } from "../core/CommonText.ts";
import { Mail } from "../core/Mail.ts";
import { Screens } from "../shared/ui/Screens.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Chrome } from "./Chrome.ts";
import { Typer } from "./Typer.ts";

type Page = string[];
type Pages = Page[];

export interface MailMenuOpts {
  save?: any;
  slot?: number;
  text?: any;
  onClose?: () => void;
}

export interface MailMenuText {
  askSendToPc: Pages;
  mailboxFull: Pages;
  sentToPc: Pages;
  loseMessage: Pages;
  detached: (name: string) => Pages;
  noSpace: Pages;
}

// Lua: MailMenu.lua:43 -- .MenuHeader: menu_coords 9, 10, 19, 17, labels at
// (left + 2, top + 2), two rows apart, cursor one column left.
const MENU_X = 9, MENU_Y = 10, MENU_W = 11, MENU_H = 8;
const MENU_LABEL_X = MENU_X + 2, MENU_LABEL_Y = MENU_Y + 2;

// Lua: MailMenu.lua:48 -- the shared speech box and YES/NO box.
const TEXT_BOX_X = 0, TEXT_BOX_Y = 12, TEXT_BOX_W = 20, TEXT_BOX_H = 6;
const TEXT_X = 1, TEXT_Y = 14, TEXT_LINE = 2;
const YESNO_X = 14, YESNO_Y = 7, YESNO_W = 6, YESNO_H = 5;
const DOWN_ARROW = "▼";
const ARROW_X = 18, ARROW_Y = 17;

// Lua: MailMenu.lua:55 -- .MenuData's three rows, verbatim.
const ENTRIES = [
  { id: "read", label: Strings.source("READ") },
  { id: "take", label: Strings.source("TAKE") },
  { id: "quit", label: Strings.source("QUIT") },
];

const page = (...lines: string[]): Page => lines;
const pages = (...ps: Page[]): Pages => ps;

// Lua: MailMenu.lua:64
const TEXT: MailMenuText = {
  askSendToPc: pages(page("Send the removed", "MAIL to your PC?")),
  mailboxFull: pages(page("Your PC's MAILBOX", "is full.")),
  sentToPc: pages(page("The MAIL was sent", "to your PC.")),
  loseMessage: pages(page("The MAIL will lose", "its message. OK?")),
  // _MailDetachedText's second line is a text_ram nickname, spliced in.
  detached: (name: string) => pages(page("MAIL detached from", format("%s.", name))),
  noSpace: pages(page("There's no space", "for removing MAIL.")),
};

// Lua: MailMenu.lua:77
const LABELS: Record<keyof MailMenuText, string> = {
  askSendToPc: "_MailAskSendToPCText",
  mailboxFull: "_MailboxFullText",
  sentToPc: "_MailSentToPCText",
  loseMessage: "_MailLoseMessageText",
  detached: "_MailDetachedText",
  noSpace: "_MailNoSpaceText",
};

// Lua: MailMenu.lua:86
const FILL: Partial<Record<keyof MailMenuText, (...a: string[]) => string[]>> = {
  detached: (name: string) => [name],
};

/** Lua: MailMenu.lua:94 */
function extractedText(text: any): MailMenuText {
  const out: any = { ...TEXT };
  for (const key of Object.keys(LABELS) as (keyof MailMenuText)[]) {
    const list = CommonText.of(text, LABELS[key]);
    if (list) {
      const fill = FILL[key];
      if (fill) out[key] = (...a: string[]) => CommonText.fill(list, fill(...a));
      else out[key] = list;
    }
  }
  return out as MailMenuText;
}

interface Message {
  pages: Pages;
  page: number;
  onDone?: () => void;
}

interface Confirm {
  pages: Pages;
  page: number;
  choice: number;
  onYes?: () => void;
  onNo?: () => void;
}

export class MailMenu {
  // Lua: MailMenu.lua:38 -- drawn over the party list.
  static isOpaque = false;
  isOpaque = false;

  static TEXT = TEXT;
  static LABELS = LABELS;
  static ENTRIES = ENTRIES;

  game: any;
  save: any;
  slot: number;
  textData: any;
  TEXT: MailMenuText;
  onClose?: () => void;
  index: number;
  message: Message | null;
  confirm: Confirm | null;
  reading: boolean;
  [key: string]: any;

  /** Lua: MailMenu.lua:112 -- opts: save, slot (1-based party index), text, onClose() */
  static new(game: any, opts?: MailMenuOpts): MailMenu {
    return new MailMenu(game, opts ?? {});
  }

  constructor(game: any, opts: MailMenuOpts) {
    this.game = game;
    this.save = opts.save || (game && game.save);
    this.slot = opts.slot || 1;
    this.textData = opts.text || (game && game.world && game.world.text);
    this.TEXT = extractedText(this.textData);
    this.onClose = opts.onClose;
    this.index = 1;
    this.message = null;
    this.confirm = null;
    this.reading = false;
  }

  /** Lua: MailMenu.lua:128 */
  mon(): any {
    return this.save && this.save.party && this.save.party[this.slot - 1];
  }

  /** Lua: MailMenu.lua:132 */
  monName(): string {
    const mon = this.mon();
    if (!mon) return "#MON";
    return mon.nickname || mon.name || mon.species || "#MON";
  }

  /** Lua: MailMenu.lua:138 */
  close(): void {
    if (this.onClose) this.onClose();
  }

  /** Lua: MailMenu.lua:142 */
  say(list: Pages | undefined, onDone?: () => void): void {
    this.message = { pages: list || [], page: 1, onDone };
  }

  /** Lua: MailMenu.lua:146 */
  ask(list: Pages | undefined, onYes?: () => void, onNo?: () => void): void {
    this.confirm = { pages: list || [], page: 1, choice: 1, onYes, onNo };
  }

  /**
   * Lua: MailMenu.lua:153 -- .read: ReadPartyMonMail. The read screen is
   * opaque and full-page, so it goes on the stack.
   */
  read(): void {
    const game = this.game;
    if (!(game && game.stack)) return this.close();
    this.reading = true;
    Screens.push(game, "Gen2MailRead", {
      entry: Mail.get(this.save, this.slot),
      onClose: () => {
        game.stack.pop();
        this.reading = false;
        // `ld a, $0` returns to the party list rather than staying here.
        this.close();
      },
    });
  }

  /** Lua: MailMenu.lua:169 -- .take: the first question. */
  take(): void {
    this.ask(this.TEXT.askSendToPc, () => this.sendToPc(), () => this.removeToBag());
  }

  /** Lua: MailMenu.lua:174 */
  sendToPc(): void {
    if (!Mail.sendToPc(this.save, this.slot)) {
      return this.say(this.TEXT.mailboxFull, () => this.close());
    }
    this.say(this.TEXT.sentToPc, () => this.close());
  }

  /**
   * Lua: MailMenu.lua:185 -- .RemoveMailToBag: the second question, then
   * ReceiveItemFromPokemon. The item only leaves the mon once the bag took it.
   */
  removeToBag(): void {
    this.ask(this.TEXT.loseMessage, () => {
      const mon = this.mon();
      if (!(mon && Mail.monHoldsMail(mon))) return this.close();
      const data = this.game && this.game.data;
      if (!Bag.add(this.save, mon.item, 1, data)) {
        return this.say(this.TEXT.noSpace, () => this.close());
      }
      const name = this.monName();
      mon.item = undefined;
      Mail.clear(this.save, this.slot);
      this.say(this.TEXT.detached(name), () => this.close());
    }, () => {
      // `jr c, .done`: saying no here leaves everything alone.
      this.close();
    });
  }

  /** Lua: MailMenu.lua:203 */
  choose(): void {
    const entry = ENTRIES[this.index - 1];
    if (!entry) return;
    if (entry.id === "read") return this.read();
    if (entry.id === "take") return this.take();
    this.close();
  }

  /** Lua: MailMenu.lua:211 */
  updateMessage(input: any): void {
    Typer.step(this);
    if (!(input.wasPressed("a") || input.wasPressed("b"))) return;
    const message = this.message!;
    if (message.page < message.pages.length) {
      message.page = message.page + 1;
      return;
    }
    this.message = null;
    if (message.onDone) message.onDone();
  }

  /** Lua: MailMenu.lua:223 */
  updateConfirm(input: any): void {
    Typer.step(this);
    const confirm = this.confirm!;
    if (confirm.page < confirm.pages.length) {
      if (input.wasPressed("a") || input.wasPressed("b")) confirm.page = confirm.page + 1;
      return;
    }
    if (input.wasPressed("up") || input.wasPressed("down")) {
      confirm.choice = confirm.choice === 1 ? 2 : 1;
      return;
    }
    if (input.wasPressed("b")) {
      this.confirm = null;
      if (confirm.onNo) confirm.onNo();
      return;
    }
    if (input.wasPressed("a")) {
      const yes = confirm.choice === 1;
      this.confirm = null;
      if (yes) {
        if (confirm.onYes) confirm.onYes();
      } else if (confirm.onNo) {
        confirm.onNo();
      }
    }
  }

  /** Lua: MailMenu.lua:252 */
  update(_dt?: number): void {
    // The read screen is on top of the stack; it owns input until it pops.
    if (this.reading) return;
    const input = this.game && this.game.input;
    if (!input) return;
    if (this.message) return this.updateMessage(input);
    if (this.confirm) return this.updateConfirm(input);

    const total = ENTRIES.length;
    if (input.wasPressed("up")) {
      this.index = this.index > 1 ? this.index - 1 : total;
    } else if (input.wasPressed("down")) {
      this.index = this.index < total ? this.index + 1 : 1;
    } else if (input.wasPressed("a")) {
      this.choose();
    } else if (input.wasPressed("b")) {
      // `jp c, .done`: B is QUIT.
      this.close();
    }
  }

  /** Lua: MailMenu.lua:273 */
  drawTextBox(lines: Page | undefined): void {
    Chrome.box(TEXT_BOX_X, TEXT_BOX_Y, TEXT_BOX_W, TEXT_BOX_H);
    (lines || []).forEach((line, i) => {
      Chrome.print(line, TEXT_X, TEXT_Y + i * TEXT_LINE);
    });
  }

  /** Lua: MailMenu.lua:280 */
  drawYesNo(choice: number): void {
    Chrome.box(YESNO_X, YESNO_Y, YESNO_W, YESNO_H);
    Chrome.print(Strings.get("YES"), YESNO_X + 2, YESNO_Y + 1);
    Chrome.print(Strings.get("NO"), YESNO_X + 2, YESNO_Y + 3);
    Chrome.cursor(YESNO_X + 1, YESNO_Y + (choice === 1 ? 1 : 3));
  }

  /** Lua: MailMenu.lua:287 */
  drawPanel(): void {
    if (this.message) {
      this.drawTextBox(this.message.pages[this.message.page - 1]);
      if (this.message.page < this.message.pages.length && Typer.arrowOn(this)) {
        Chrome.print(DOWN_ARROW, ARROW_X, ARROW_Y);
      }
      G.setColor(1, 1, 1, 1);
      return;
    }
    if (this.confirm) {
      this.drawTextBox(this.confirm.pages[this.confirm.page - 1]);
      if (this.confirm.page >= this.confirm.pages.length) {
        this.drawYesNo(this.confirm.choice);
      } else if (Typer.arrowOn(this)) {
        Chrome.print(DOWN_ARROW, ARROW_X, ARROW_Y);
      }
      G.setColor(1, 1, 1, 1);
      return;
    }
    Chrome.box(MENU_X, MENU_Y, MENU_W, MENU_H);
    ENTRIES.forEach((entry, i) => {
      const row = i + 1;
      const ty = MENU_LABEL_Y + (row - 1) * 2;
      if (row === this.index) Chrome.cursor(MENU_LABEL_X - 1, ty);
      Chrome.print(Strings.get(entry.label), MENU_LABEL_X, ty);
    });
    G.setColor(1, 1, 1, 1);
  }

  /** Lua: MailMenu.lua:316 */
  draw(): void {
    this.drawPanel();
  }
}

export default MailMenu;
