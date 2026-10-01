// gen1recomp src/ui/gen2/MailboxMenu.lua (bdfac727, MIT): the MAILBOX in
// the player's PC, _PlayerMailBoxMenu and MailboxPC (engine/pokemon/mail.asm).
//
// InitMail runs first and answers z when sMailboxCount is 0 -- an empty
// MAILBOX is _EmptyMailboxText and nothing else.
//
// Layout, from the two headers:
//   .TopMenuHeader  menu_coords 8, 1, 18, 10 -- a scrolling menu, four rows,
//                   each printed by MailboxPC_PrintMailAuthor (the AUTHOR)
//   .SubMenuHeader  menu_coords 0, 0, 13, 9 with STATICMENU_CURSOR, so its
//                   four labels start at (2,2) and step two rows
//
// The submenu's four rows are .Jumptable's four routines:
//   READ MAIL    ReadMailMessage, which is the Gen2MailRead screen
//   PUT IN PACK  "message will be lost. OK?" -> ReceiveItem, then
//                DeleteMailFromPC (the STATIONERY goes back in the bag)
//   ATTACH MAIL  the party list, refusing an EGG and a mon already holding
//                anything (`jr .try_again` loops), then MoveMailFromPCToParty
//   CANCEL       `ret`
//
// Drawn over whatever opened the PC, so this state is not opaque.

import G from "../platform/screen.ts";
import { Bag } from "../shared/inventory/Bag.ts";
import { Breeding } from "../core/Breeding.ts";
import { CommonText } from "../core/CommonText.ts";
import { Mail } from "../core/Mail.ts";
import type { MailEntry } from "../core/Mail.ts";
import { Screens } from "../shared/ui/Screens.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Chrome } from "./Chrome.ts";
import { Typer } from "./Typer.ts";

type Page = string[];
type Pages = Page[];

export interface MailboxMenuOpts {
  save?: any;
  text?: any;
  onClose?: () => void;
}

export interface MailboxText {
  empty: Pages;
  messageLost: Pages;
  packFull: Pages;
  putAway: Pages;
  alreadyHolding: Pages;
  egg: Pages;
  moved: Pages;
}

// Lua: MailboxMenu.lua:43
const LIST_X = 8, LIST_Y = 1, LIST_W = 11, LIST_H = 10;
// InitScrollingMenu lays its rows two inside the box's corner and steps two.
const ROW_X = LIST_X + 2, ROW_Y = LIST_Y + 2, ROW_STEP = 2;
const VISIBLE_ROWS = 4;

const SUB_X = 0, SUB_Y = 0, SUB_W = 14, SUB_H = 10;
const SUB_LABEL_X = SUB_X + 2, SUB_LABEL_Y = SUB_Y + 2;

const TEXT_BOX_X = 0, TEXT_BOX_Y = 12, TEXT_BOX_W = 20, TEXT_BOX_H = 6;
const TEXT_X = 1, TEXT_Y = 14, TEXT_LINE = 2;
const YESNO_X = 14, YESNO_Y = 7, YESNO_W = 6, YESNO_H = 5;
const DOWN_ARROW = "▼";
const ARROW_X = 18, ARROW_Y = 17;

// Lua: MailboxMenu.lua:58 -- .SubMenuData, verbatim.
const SUB_ENTRIES = [
  { id: "read", label: Strings.source("READ MAIL") },
  { id: "pack", label: Strings.source("PUT IN PACK") },
  { id: "attach", label: Strings.source("ATTACH MAIL") },
  { id: "cancel", label: Strings.source("CANCEL") },
];

const page = (...lines: string[]): Page => lines;
const pages = (...ps: Page[]): Pages => ps;

// Lua: MailboxMenu.lua:69 -- common_2.asm's _EmptyMailboxText .. block.
const TEXT: MailboxText = {
  empty: pages(page("There's no MAIL", "here.")),
  messageLost: pages(page("The MAIL's message", "will be lost. OK?")),
  packFull: pages(page("The PACK is full.")),
  putAway: pages(page("The cleared MAIL", "was put away.")),
  alreadyHolding: pages(page("It's already hold-", "ing an item.")),
  egg: pages(page("An EGG can't hold", "any MAIL.")),
  moved: pages(page("The MAIL was moved", "from the MAILBOX.")),
};

// Lua: MailboxMenu.lua:79
const LABELS: Record<keyof MailboxText, string> = {
  empty: "_EmptyMailboxText",
  messageLost: "_MailMessageLostText",
  packFull: "_MailPackFullText",
  putAway: "_MailClearedPutAwayText",
  alreadyHolding: "_MailAlreadyHoldingItemText",
  egg: "_MailEggText",
  moved: "_MailMovedFromBoxText",
};

/** Lua: MailboxMenu.lua:93 */
function extractedText(text: any): MailboxText {
  const out: any = { ...TEXT };
  for (const key of Object.keys(LABELS) as (keyof MailboxText)[]) {
    const list = CommonText.of(text, LABELS[key]);
    if (list) out[key] = list;
  }
  return out as MailboxText;
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

export class MailboxMenu {
  // Lua: MailboxMenu.lua:41
  static isOpaque = false;
  isOpaque = false;

  static TEXT = TEXT;
  static LABELS = LABELS;
  static SUB_ENTRIES = SUB_ENTRIES;

  game: any;
  save: any;
  textData: any;
  TEXT: MailboxText;
  onClose?: () => void;
  index: number;
  scroll: number;
  submenu: { index: number } | null;
  message: Message | null;
  confirm: Confirm | null;
  picking: boolean;
  [key: string]: any;

  /** Lua: MailboxMenu.lua:103 -- opts: save, text (text.lua), onClose() */
  static new(game: any, opts?: MailboxMenuOpts): MailboxMenu {
    return new MailboxMenu(game, opts ?? {});
  }

  constructor(game: any, opts: MailboxMenuOpts) {
    this.game = game;
    this.save = opts.save || (game && game.save);
    this.textData = opts.text || (game && game.world && game.world.text);
    this.TEXT = extractedText(this.textData);
    this.onClose = opts.onClose;
    // wCurMessageIndex / wCurMessageScrollPosition, reset by MailboxPC.
    this.index = 1;
    this.scroll = 0;
    this.submenu = null;
    this.message = null;
    this.confirm = null;
    this.picking = false;
    // InitMail's z branch: no menu, one line, gone.
    if (Mail.mailboxCount(this.save) === 0) this.say(this.TEXT.empty, () => this.close());
  }

  /** Lua: MailboxMenu.lua:126 */
  box(): MailEntry[] {
    return Mail.mailbox(this.save);
  }

  /** Lua: MailboxMenu.lua:130 */
  count(): number {
    return Mail.mailboxCount(this.save);
  }

  /** Lua: MailboxMenu.lua:134 */
  selected(): MailEntry | undefined {
    return this.box()[this.index - 1];
  }

  /** Lua: MailboxMenu.lua:138 */
  close(): void {
    if (this.onClose) this.onClose();
  }

  /** Lua: MailboxMenu.lua:142 */
  say(list: Pages | undefined, onDone?: () => void): void {
    this.message = { pages: list || [], page: 1, onDone };
  }

  /** Lua: MailboxMenu.lua:146 */
  ask(list: Pages | undefined, onYes?: () => void, onNo?: () => void): void {
    this.confirm = { pages: list || [], page: 1, choice: 1, onYes, onNo };
  }

  /** Lua: MailboxMenu.lua:151 */
  clampIndex(): void {
    const total = this.count();
    if (total === 0) {
      this.index = 1;
      this.scroll = 0;
      return;
    }
    if (this.index > total) this.index = total;
    if (this.index < 1) this.index = 1;
    if (this.index <= this.scroll) this.scroll = this.index - 1;
    else if (this.index > this.scroll + VISIBLE_ROWS) this.scroll = this.index - VISIBLE_ROWS;
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, total - VISIBLE_ROWS)));
  }

  // ----------------------------------------------------------- submenu rows

  /** Lua: MailboxMenu.lua:170 */
  readMail(): void {
    const game = this.game;
    const entry = this.selected();
    if (!(game && game.stack && entry)) return;
    this.picking = true;
    Screens.push(game, "Gen2MailRead", {
      entry,
      onClose: () => {
        game.stack.pop();
        this.picking = false;
        this.submenu = null;
      },
    });
  }

  /**
   * Lua: MailboxMenu.lua:188 -- .PutInPack: the yes/no first, then
   * ReceiveItem; a full PACK leaves the letter in the MAILBOX intact.
   */
  putInPack(): void {
    this.ask(this.TEXT.messageLost, () => {
      const entry = this.selected();
      if (!entry) {
        this.submenu = null;
        return;
      }
      const data = this.game && this.game.data;
      if (!Bag.add(this.save, entry.type, 1, data)) {
        return this.say(this.TEXT.packFull, () => {
          this.submenu = null;
        });
      }
      Mail.deleteFromPc(this.save, this.index);
      this.clampIndex();
      this.say(this.TEXT.putAway, () => {
        this.submenu = null;
        if (this.count() === 0) {
          // The next .loop calls InitMail again, which now answers z.
          this.say(this.TEXT.empty, () => this.close());
        }
      });
    }, () => {
      // `ret c`: the question was the whole thing.
      this.submenu = null;
    });
  }

  /**
   * Lua: MailboxMenu.lua:216 -- .AttachMail's loop: both refusals go back to
   * the party list (`jr .try_again`).
   */
  attachMail(): void {
    const game = this.game;
    if (!(game && game.stack)) {
      this.submenu = null;
      return;
    }
    this.picking = true;
    Screens.push(game, "Gen2PartyMenu", {
      save: this.save,
      party: this.save.party,
      prompt: "choose",
      onChoose: (slot: number, mon: any) => {
        game.stack.pop();
        this.picking = false;
        if (Breeding.isEgg(mon)) return this.say(this.TEXT.egg, () => this.attachMail());
        if (mon && mon.item) return this.say(this.TEXT.alreadyHolding, () => this.attachMail());
        if (!Mail.moveFromPcToParty(this.save, this.index, slot)) {
          this.submenu = null;
          return;
        }
        this.clampIndex();
        this.say(this.TEXT.moved, () => {
          this.submenu = null;
          if (this.count() === 0) this.say(this.TEXT.empty, () => this.close());
        });
      },
      onCancel: () => {
        game.stack.pop();
        this.picking = false;
        // `.exit2` -> CloseSubmenu: back to the letter list.
        this.submenu = null;
      },
    });
  }

  /** Lua: MailboxMenu.lua:258 */
  chooseSub(): void {
    const entry = SUB_ENTRIES[this.submenu!.index - 1];
    if (!entry) return;
    if (entry.id === "read") return this.readMail();
    if (entry.id === "pack") return this.putInPack();
    if (entry.id === "attach") return this.attachMail();
    this.submenu = null;
  }

  // ----------------------------------------------------------------- update

  /** Lua: MailboxMenu.lua:269 */
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

  /** Lua: MailboxMenu.lua:281 */
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

  /** Lua: MailboxMenu.lua:310 */
  updateSubmenu(input: any): void {
    const total = SUB_ENTRIES.length;
    const sub = this.submenu!;
    if (input.wasPressed("up")) {
      sub.index = sub.index > 1 ? sub.index - 1 : total;
    } else if (input.wasPressed("down")) {
      sub.index = sub.index < total ? sub.index + 1 : 1;
    } else if (input.wasPressed("a")) {
      this.chooseSub();
    } else if (input.wasPressed("b")) {
      this.submenu = null;
    }
  }

  /** Lua: MailboxMenu.lua:325 */
  update(_dt?: number): void {
    if (this.picking) return;
    const input = this.game && this.game.input;
    if (!input) return;
    if (this.message) return this.updateMessage(input);
    if (this.confirm) return this.updateConfirm(input);
    if (this.submenu) return this.updateSubmenu(input);

    const total = this.count();
    if (total === 0) return this.close();
    if (input.wasPressed("up")) {
      this.index = this.index > 1 ? this.index - 1 : total;
      this.clampIndex();
    } else if (input.wasPressed("down")) {
      this.index = this.index < total ? this.index + 1 : 1;
      this.clampIndex();
    } else if (input.wasPressed("a")) {
      this.submenu = { index: 1 };
    } else if (input.wasPressed("b")) {
      // .exit: PAD_B out of the scrolling menu ends _PlayerMailBoxMenu.
      this.close();
    }
  }

  // ------------------------------------------------------------------- draw

  /** Lua: MailboxMenu.lua:351 */
  drawTextBox(lines: Page | undefined): void {
    Chrome.box(TEXT_BOX_X, TEXT_BOX_Y, TEXT_BOX_W, TEXT_BOX_H);
    (lines || []).forEach((line, i) => {
      Chrome.print(line, TEXT_X, TEXT_Y + i * TEXT_LINE);
    });
  }

  /** Lua: MailboxMenu.lua:358 */
  drawYesNo(choice: number): void {
    Chrome.box(YESNO_X, YESNO_Y, YESNO_W, YESNO_H);
    Chrome.print(Strings.get("YES"), YESNO_X + 2, YESNO_Y + 1);
    Chrome.print(Strings.get("NO"), YESNO_X + 2, YESNO_Y + 3);
    Chrome.cursor(YESNO_X + 1, YESNO_Y + (choice === 1 ? 1 : 3));
  }

  /** Lua: MailboxMenu.lua:365 */
  drawList(): void {
    Chrome.box(LIST_X, LIST_Y, LIST_W, LIST_H);
    const box = this.box();
    for (let row = 1; row <= VISIBLE_ROWS; row++) {
      const i = row + this.scroll;
      const entry = box[i - 1];
      if (entry) {
        const ty = ROW_Y + (row - 1) * ROW_STEP;
        if (i === this.index) Chrome.cursor(ROW_X - 1, ty);
        // MailboxPC_PrintMailAuthor: a blank author draws a blank row.
        Chrome.print(entry.author || "", ROW_X, ty);
      }
    }
  }

  /** Lua: MailboxMenu.lua:382 */
  drawSubmenu(): void {
    Chrome.box(SUB_X, SUB_Y, SUB_W, SUB_H);
    SUB_ENTRIES.forEach((entry, i) => {
      const row = i + 1;
      const ty = SUB_LABEL_Y + (row - 1) * 2;
      if (row === this.submenu!.index) Chrome.cursor(SUB_LABEL_X - 1, ty);
      Chrome.print(Strings.get(entry.label), SUB_LABEL_X, ty);
    });
  }

  /** Lua: MailboxMenu.lua:391 */
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
    this.drawList();
    if (this.submenu) this.drawSubmenu();
    G.setColor(1, 1, 1, 1);
  }

  /** Lua: MailboxMenu.lua:416 */
  draw(): void {
    this.drawPanel();
  }
}

export default MailboxMenu;
