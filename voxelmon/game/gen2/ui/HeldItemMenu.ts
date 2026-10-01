// gen1recomp src/ui/gen2/HeldItemMenu.lua (bdfac727, MIT):
// GiveTakePartyMonItem (engine/pokemon/mon_menu.asm) -- the GIVE / TAKE menu
// the party submenu's ITEM row opens, and the two routines behind it.
//
// It is here because MAIL cannot be reached without it: attaching a letter
// to a mon is GivePartyItem -> ComposeMailMessage and nothing else on the
// cart, so the compose keyboard's only door is this one.
//
// Drawn over the party list (`menu_coords 12, 12, SCREEN_WIDTH - 1,
// SCREEN_HEIGHT - 1`), so this state is not opaque.
//
//   GIVE  .GiveItem: DepositSellPack, then
//         - a KEY_ITEM or an untossable item is ItemCantHeldText and the PACK
//           comes straight back
//         - an empty-handed mon takes it (GiveItemToPokemon), and if the item
//           is MAIL the compose keyboard opens on top
//         - a mon already holding MAIL is refused with _PokemonRemoveMailText,
//           BEFORE the swap question is asked
//         - anything else is the swap question
//   TAKE  TakePartyItem: the item goes back to the bag, or
//         _ItemStorageFullText when it will not fit
//
// An EGG never gets here: GiveTakePartyMonItem's first two lines are
// `cp EGG / jr z, .cancel`.

import G from "../platform/screen.ts";
import { CommonText, type TextPage } from "../core/CommonText.ts";
import { Mail } from "../core/Mail.ts";
import { Sound } from "../shared/core/Sound.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Bag } from "../shared/inventory/Bag.ts";
import { Screens } from "../shared/ui/Screens.ts";
import { Chrome } from "./Chrome.ts";
import { Typer } from "./Typer.ts";

type Pages = TextPage[];

// Lua: HeldItemMenu.lua:45 -- GiveTakeItemMenuData: menu_coords 12, 12, 19, 17,
// STATICMENU_CURSOR and no NO_TOP_SPACING, so GIVE is at (14,14) and TAKE two
// rows under it.
const MENU_X = 12;
const MENU_Y = 12;
const MENU_W = 8;
const MENU_H = 6;
const MENU_LABEL_X = MENU_X + 2;
const MENU_LABEL_Y = MENU_Y + 2;

// Lua: HeldItemMenu.lua:48
const TEXT_BOX_X = 0;
const TEXT_BOX_Y = 12;
const TEXT_BOX_W = 20;
const TEXT_BOX_H = 6;
const TEXT_X = 1;
const TEXT_Y = 14;
const TEXT_LINE = 2;
const YESNO_X = 14;
const YESNO_Y = 7;
const YESNO_W = 6;
const YESNO_H = 5;
const DOWN_ARROW = "▼";
const ARROW_X = 18;
const ARROW_Y = 17;

// Lua: HeldItemMenu.lua:54
const ENTRIES = [
  { id: "give", label: Strings.source("GIVE") },
  { id: "take", label: Strings.source("TAKE") },
];

// Lua: HeldItemMenu.lua:59
const page = (...lines: string[]): TextPage => lines;
const pages = (...list: TextPage[]): Pages => list;

export interface HeldItemText {
  hold: (mon: string, item: string) => Pages;
  removeMail: Pages;
  notHolding: (mon: string) => Pages;
  storageFull: Pages;
  tookItem: (item: string, mon: string) => Pages;
  askSwap: (mon: string, item: string) => Pages;
  swapped: (mon: string, old: string, neu: string) => Pages;
  cantHold: Pages;
}

// Lua: HeldItemMenu.lua:64 -- data/text/common_2.asm. The {STRBUF} markers are
// text_ram fields, spliced here rather than being part of the string.
const TEXT: HeldItemText = {
  hold: (mon, item) => pages(page(`Made ${mon}`, `hold ${item}.`)),
  removeMail: pages(page("Please remove the", "MAIL first.")),
  notHolding: (mon) => pages(page(`${mon} isn't`, "holding anything.")),
  storageFull: pages(page("Item storage space", "full.")),
  tookItem: (item, mon) => pages(page(`Took ${item}`, `from ${mon}.`)),
  askSwap: (mon, item) => pages(page(`${mon} is`, "already holding"), page(`${item}.`, "Switch items?")),
  swapped: (mon, old, neu) => pages(page(`Took ${mon}'s`, `${old} and`), page("made it hold", `${neu}.`)),
  cantHold: pages(page("This item can't be", "held.")),
};

// Lua: HeldItemMenu.lua:89
const LABELS: Record<keyof HeldItemText, string> = {
  hold: "_PokemonHoldItemText",
  removeMail: "_PokemonRemoveMailText",
  notHolding: "_PokemonNotHoldingText",
  storageFull: "_ItemStorageFullText",
  tookItem: "_PokemonTookItemText",
  askSwap: "_PokemonAskSwapItemText",
  swapped: "_PokemonSwapItemText",
  cantHold: "_ItemCantHeldText",
};

// Lua: HeldItemMenu.lua:101 -- each formatted entry's markers, in the order the
// ASM string names them.
const FILL: Partial<Record<keyof HeldItemText, (...a: string[]) => string[]>> = {
  hold: (mon, item) => [mon!, item!],
  notHolding: (mon) => [mon!],
  tookItem: (item, mon) => [item!, mon!],
  askSwap: (mon, item) => [mon!, item!],
  swapped: (mon, old, neu) => [mon!, old!, neu!],
};

// Lua: HeldItemMenu.lua:113 -- the cart's own strings where the cache has them,
// the transcriptions above otherwise.
function extractedText(text: any): HeldItemText {
  const out: any = { ...TEXT };
  for (const key of Object.keys(LABELS) as (keyof HeldItemText)[]) {
    const list = CommonText.of(text, LABELS[key]);
    if (list) {
      const fill = FILL[key];
      if (fill) out[key] = (...a: string[]) => CommonText.fill(list, fill(...a));
      else out[key] = list;
    }
  }
  return out as HeldItemText;
}

export interface HeldItemMenuOpts {
  save?: any;
  slot?: number;
  items?: Record<string, any>;
  text?: any;
  onClose?: () => void;
}

interface Confirm {
  pages: Pages;
  page: number;
  choice: number;
  onYes?: () => void;
  onNo?: () => void;
}

export class HeldItemMenu {
  // Lua: HeldItemMenu.lua:41
  static isOpaque = false;
  static TEXT = TEXT;
  static LABELS = LABELS;
  static ENTRIES = ENTRIES;
  isOpaque = false;

  game: any;
  save: any;
  slot: number;
  items: Record<string, any> | undefined;
  textData: any;
  TEXT: HeldItemText;
  onClose?: () => void;
  index: number;
  busy: boolean;
  message?: { pages: Pages; page: number; onDone?: () => void } | null;
  confirm?: Confirm | null;
  typer?: Typer | null;
  arrowBlink?: number;
  [key: string]: any;

  /** Lua: HeldItemMenu.lua:130 -- opts: save, slot, items (items.lua), text (text.lua), onClose() */
  static new(game: any, opts?: HeldItemMenuOpts): HeldItemMenu {
    return new HeldItemMenu(game, opts ?? {});
  }

  constructor(game: any, opts: HeldItemMenuOpts) {
    this.game = game;
    this.save = opts.save || (game && game.save);
    this.slot = opts.slot || 1;
    this.items = opts.items || (game && game.data && game.data.items);
    this.textData = opts.text || (game && game.world && game.world.text);
    this.TEXT = extractedText(this.textData);
    this.onClose = opts.onClose;
    this.index = 1;
    this.busy = false;
  }

  /** Lua: HeldItemMenu.lua:145 */
  mon(): any {
    return this.save && this.save.party && this.save.party[this.slot - 1];
  }

  /** Lua: HeldItemMenu.lua:149 */
  monName(): string {
    const mon = this.mon();
    if (!mon) return "#MON";
    return mon.nickname || mon.name || mon.species || "#MON";
  }

  /** Lua: HeldItemMenu.lua:155 */
  itemName(id: string | null | undefined): string {
    const def = id && this.items ? this.items[id] : undefined;
    return (def && def.name) || id || "?";
  }

  /** Lua: HeldItemMenu.lua:160 */
  close(): void {
    if (this.onClose) this.onClose();
  }

  /** Lua: HeldItemMenu.lua:165 -- home/menu.asm:793 */
  playSfx(name: string): void {
    const data = this.game && this.game.data;
    const sfx = data && data.audio && data.audio.sfx;
    if (sfx && sfx[Sound.resolve(data, name)]) Sound.play(data, name);
  }

  /** Lua: HeldItemMenu.lua:172 -- home/menu.asm:348 */
  say(list: Pages | undefined, onDone?: () => void): void {
    Typer.say(this, list, onDone);
  }

  /** Lua: HeldItemMenu.lua:176 */
  ask(list: Pages | undefined, onYes?: () => void, onNo?: () => void): void {
    this.confirm = { pages: list || [], page: 1, choice: 1, onYes, onNo };
    Typer.begin(this, this.confirm);
  }

  // ------------------------------------------------------------------- GIVE

  /**
   * Lua: HeldItemMenu.lua:187 -- .GiveItem's `cp KEY_ITEM_POCKET` and
   * CheckTossableItem: a key item or an untossable item cannot be held.
   */
  canHold(itemId: string | null | undefined): boolean {
    const def = itemId && this.items ? this.items[itemId] : undefined;
    if (def && def.pocket === "KEY_ITEM") return false;
    if (def && def.canToss === false) return false;
    return true;
  }

  /** Lua: HeldItemMenu.lua:194 */
  openPack(): void {
    const game = this.game;
    if (!(game && game.stack)) return this.close();
    this.busy = true;
    Screens.push(game, "Gen2PackMenu", {
      save: this.save,
      // DepositSellPack: the PACK is a chooser here, so a field item must not
      // run its effect on the way past.
      give: true,
      onChoose: (itemId: string) => {
        game.stack.pop();
        this.busy = false;
        this.giveItem(itemId);
      },
      onClose: () => {
        game.stack.pop();
        this.busy = false;
        // `.quit`: backing out of the PACK ends the whole GIVE.
        this.close();
      },
    });
  }

  /** Lua: HeldItemMenu.lua:218 -- TryGiveItemToPartymon, in its own order. */
  giveItem(itemId: string | null | undefined): void {
    const mon = this.mon();
    if (!(mon && itemId)) return this.close();
    if (!this.canHold(itemId)) {
      return this.say(this.TEXT.cantHold, () => this.openPack());
    }
    const held = mon.item;
    if (held && Mail.isMail(held)) {
      // .please_remove_mail: a `ret`, so the whole GIVE ends here.
      return this.say(this.TEXT.removeMail, () => this.close());
    }
    if (!held) {
      Bag.remove(this.save, itemId, 1);
      mon.item = itemId;
      const name = this.itemName(itemId);
      return this.say(this.TEXT.hold(this.monName(), name), () => {
        this.composeIfMail(itemId);
      });
    }
    // .already_holding_item: the swap question, then ReceiveItemFromPokemon for
    // the old one. A bag that cannot take it back puts the old item straight
    // back on the mon (.bag_full), so nothing is ever destroyed.
    this.ask(
      this.TEXT.askSwap(this.monName(), this.itemName(held)),
      () => {
        Bag.remove(this.save, itemId, 1);
        if (!Bag.add(this.save, held, 1, this.game && this.game.data)) {
          Bag.add(this.save, itemId, 1, this.game && this.game.data);
          return this.say(this.TEXT.storageFull, () => this.close());
        }
        mon.item = itemId;
        this.say(this.TEXT.swapped(this.monName(), this.itemName(held), this.itemName(itemId)), () => this.composeIfMail(itemId));
      },
      () => this.close(),
    );
  }

  /**
   * Lua: HeldItemMenu.lua:256 -- GivePartyItem's tail: `farcall ItemIsMail /
   * call ComposeMailMessage`. The keyboard has no cancel, so an empty message
   * is a blank letter, not a refusal.
   */
  composeIfMail(itemId: string): void {
    if (!Mail.isMail(itemId)) return this.close();
    const game = this.game;
    if (!(game && game.stack)) return this.close();
    this.busy = true;
    Screens.push(game, "Gen2MailCompose", {
      onDone: (message: string) => {
        game.stack.pop();
        this.busy = false;
        Mail.compose(this.save, this.slot, message, this.mon(), itemId);
        this.close();
      },
    });
  }

  // ------------------------------------------------------------------- TAKE

  /** Lua: HeldItemMenu.lua:273 */
  takeItem(): void {
    const mon = this.mon();
    if (!mon) return this.close();
    const held = mon.item;
    if (!held) {
      return this.say(this.TEXT.notHolding(this.monName()), () => this.close());
    }
    if (!Bag.add(this.save, held, 1, this.game && this.game.data)) {
      return this.say(this.TEXT.storageFull, () => this.close());
    }
    mon.item = undefined;
    // Taking a mail item back leaves no letter behind it. The MAIL row's own
    // TAKE is the path that asks about the PC first (MailMenu); this one is
    // only reachable for a mon NOT holding mail.
    Mail.clear(this.save, this.slot);
    this.say(this.TEXT.tookItem(this.itemName(held), this.monName()), () => this.close());
  }

  /** Lua: HeldItemMenu.lua:295 */
  choose(): void {
    const entry = ENTRIES[this.index - 1];
    if (!entry) return;
    if (entry.id === "give") return this.openPack();
    this.takeItem();
  }

  // ------------------------------------------------------------------ update

  /** Lua: HeldItemMenu.lua:304 */
  updateMessage(input: any): void {
    Typer.step(this);
    if (Typer.typing(this)) return;
    if (!(input.wasPressed("a") || input.wasPressed("b"))) return;
    // home/joypad.asm:392
    this.playSfx("Sfx_ReadText2");
    const message = this.message!;
    if (message.page < message.pages.length) {
      Typer.turn(this, message);
      return;
    }
    this.message = null;
    this.typer = null;
    if (message.onDone) message.onDone();
  }

  /** Lua: HeldItemMenu.lua:320 */
  updateConfirm(input: any): void {
    Typer.step(this);
    if (Typer.typing(this)) return;
    const confirm = this.confirm!;
    if (confirm.page < confirm.pages.length) {
      if (input.wasPressed("a") || input.wasPressed("b")) {
        this.playSfx("Sfx_ReadText2");
        Typer.turn(this, confirm);
      }
      return;
    }
    if (input.wasPressed("up") || input.wasPressed("down")) {
      confirm.choice = confirm.choice === 1 ? 2 : 1;
      return;
    }
    if (input.wasPressed("b")) {
      // home/menu.asm:520
      this.playSfx("Sfx_ReadText2");
      this.confirm = null;
      this.typer = null;
      if (confirm.onNo) confirm.onNo();
      return;
    }
    if (input.wasPressed("a")) {
      // home/menu.asm:520
      this.playSfx("Sfx_ReadText2");
      const yes = confirm.choice === 1;
      this.confirm = null;
      this.typer = null;
      if (yes) {
        if (confirm.onYes) confirm.onYes();
      } else if (confirm.onNo) {
        confirm.onNo();
      }
    }
  }

  /** Lua: HeldItemMenu.lua:357 */
  update(_dt?: number): void {
    // The PACK or the keyboard is on top of the stack; it owns input.
    if (this.busy) return;
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
      // home/menu.asm:381
      this.playSfx("Sfx_ReadText2");
      this.choose();
    } else if (input.wasPressed("b")) {
      // home/menu.asm:381
      this.playSfx("Sfx_ReadText2");
      this.close();
    }
  }

  // -------------------------------------------------------------------- draw

  /** Lua: HeldItemMenu.lua:383 */
  drawTextBox(lines: string[] | null | undefined): void {
    Chrome.box(TEXT_BOX_X, TEXT_BOX_Y, TEXT_BOX_W, TEXT_BOX_H);
    (lines || []).forEach((line, i) => {
      Chrome.print(line, TEXT_X, TEXT_Y + i * TEXT_LINE);
    });
  }

  /** Lua: HeldItemMenu.lua:390 */
  drawYesNo(choice: number): void {
    Chrome.box(YESNO_X, YESNO_Y, YESNO_W, YESNO_H);
    Chrome.print(Strings.get("YES"), YESNO_X + 2, YESNO_Y + 1);
    Chrome.print(Strings.get("NO"), YESNO_X + 2, YESNO_Y + 3);
    Chrome.cursor(YESNO_X + 1, YESNO_Y + (choice === 1 ? 1 : 3));
  }

  /** Lua: HeldItemMenu.lua:397 */
  drawPanel(): void {
    if (this.message) {
      this.drawTextBox(Typer.text(this, this.message.pages[this.message.page - 1]) as string[]);
      if (this.message.page < this.message.pages.length && !Typer.typing(this) && Typer.arrowOn(this)) {
        Chrome.print(DOWN_ARROW, ARROW_X, ARROW_Y);
      }
      G.setColor(1, 1, 1, 1);
      return;
    }
    if (this.confirm) {
      this.drawTextBox(Typer.text(this, this.confirm.pages[this.confirm.page - 1]) as string[]);
      if (Typer.typing(this)) {
        G.setColor(1, 1, 1, 1);
        return;
      }
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

  /** Lua: HeldItemMenu.lua:430 */
  draw(): void {
    this.drawPanel();
  }
}

export default HeldItemMenu;
