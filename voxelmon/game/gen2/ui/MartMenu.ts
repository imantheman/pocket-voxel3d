// gen1recomp src/ui/gen2/MartMenu.lua (bdfac727, MIT): Gen 2 POKeMART, the
// whole clerk conversation (engine/items/mart.asm).
//
// `pokemart dialog_id, mart_id` (macros/scripts/events.asm) is a BLOCKING
// script command.  Script_pokemart farcalls OpenMartDialog, which runs the top
// menu, the buy list and the sell list to completion before the script's next
// byte is read, so this screen owns the stack while it is up and the VM is
// parked on its resume exactly the way it is for a battle.
//
// Four dialog kinds share one buy list (MartTypeDialogs):
//   MARTTYPE_STANDARD  MartDialog   BUY / SELL / QUIT, StandardMart's loop
//   MARTTYPE_BITTER    HerbShop     intro -> BuyMenu -> come again
//   MARTTYPE_BARGAIN   BargainShop  one of each item, at its own prices
//   MARTTYPE_PHARMACY  Pharmacist   intro -> BuyMenu -> come again
// Only STANDARD sells: SellMenu is reached from its top menu and nowhere else.
//
// The screen is transcribed from the ASM's own coordinates (see the Lua's
// header, MartMenu.lua:16-55):
//   MenuHeader_BuySell      a 12x9 box at (0,0); BUY at (2,2), cursor col 1
//   MoneyTopRightMenuHeader a 9x3 box at (11,0), amount at (12,1)
//   MenuHeader_Buy          an unframed 19x9 rect at (1,3); names at (2,4),
//                           prices at (10,5); ▲ at (19,3), ▼ at (19,11)
//   UpdateItemDescription   a 20x6 box at (0,12), description at (1,14)
//   BuyItem/SellItem_MenuHeader a 13x3 box at (7,15); '×' at (8,16), total (12,16)
//   YesNoBox                a 6x5 box at (14,7); YES (16,8), NO (16,10)
//   MoneyBottomLeftMenuHeader a 9x3 box at (0,11), amount at (1,12)
//
// Every string is transcribed from data/text/common_2.asm and paired with its
// pokegold label in LABELS; the screen prefers the cache's own characters
// (CommonText) and falls back to the transcription.

import G from "../platform/screen.ts";
import { format } from "../platform/lua.ts";
import { CommonText } from "../core/CommonText.ts";
import { Save } from "../core/Save.ts";
import { Bag } from "../shared/inventory/Bag.ts";
import { Sound } from "../shared/core/Sound.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Screens } from "../shared/ui/Screens.ts";
import { Chrome } from "./Chrome.ts";
import { Typer, type TyperPage } from "./Typer.ts";

type Page = string[];
type PageList = Page[];

export interface MartEntry {
  id: string;
  name: string;
  price: number;
  soldOut?: boolean;
}

interface MartConfirm {
  pages: TyperPage[];
  page: number;
  choice: number;
  onYes?: () => void;
  onNo?: () => void;
}

export interface MartMenuOpts {
  save?: any;
  items?: Record<string, any>;
  marts?: any;
  martType?: number | string;
  martId?: number;
  text?: any;
  onClose?: () => void;
}

// Lua: MartMenu.lua:80 -- PlayTransactionSound: `call WaitSFX` then
// SFX_TRANSACTION, on the money changing hands.
const SFX_TRANSACTION = "Sfx_Transaction";

// Lua: MartMenu.lua:91 -- constants/mart_constants.asm.
const MART_TYPES: Record<number, string> = { 0: "STANDARD", 1: "BITTER", 2: "BARGAIN", 3: "PHARMACY" };
const NUM_MARTS = 34; // MART_UNDERGROUND is 33

// Lua: MartMenu.lua:97 -- GetMart: an id at or past NUM_MARTS sells DefaultMart.
const DEFAULT_MART = ["POKE_BALL", "POTION"];

// Lua: MartMenu.lua:101 -- MAX_ITEM_STACK.
const MAX_ITEM_STACK = 99;

// ---------------------------------------------------------------- layout
// Lua: MartMenu.lua:104
const TOP_BOX_X = 0, TOP_BOX_Y = 0, TOP_BOX_W = 12, TOP_BOX_H = 9;
const TOP_LABEL_X = 2, TOP_LABEL_Y = 2, TOP_SPACING = 2;

const MONEY_BOX_X = 11, MONEY_BOX_Y = 0, MONEY_BOX_W = 9, MONEY_BOX_H = 3;
const MONEY_X = 12, MONEY_Y = 1;

const MONEY_LOW_BOX_X = 0, MONEY_LOW_BOX_Y = 11;
const MONEY_LOW_X = 1, MONEY_LOW_Y = 12;

const LIST_BOX_X = 1, LIST_BOX_Y = 3, LIST_BOX_W = 19, LIST_BOX_H = 9;
const LIST_X = 2, LIST_Y = 4, LIST_SPACING = 2;
const PRICE_X = LIST_X + 8; // wMenuData_ScrollingMenuWidth
const VISIBLE_ROWS = 4; // MenuHeader_Buy's `db 4, 8 ; rows, columns`
const ARROW_X = LIST_BOX_X + LIST_BOX_W - 1;
const ARROW_UP_Y = LIST_BOX_Y, ARROW_DOWN_Y = LIST_BOX_Y + LIST_BOX_H - 1;

const TEXT_BOX_X = 0, TEXT_BOX_Y = 12, TEXT_BOX_W = 20, TEXT_BOX_H = 6;
// TEXTBOX_INNERY + 2: a text box's two lines are TWO rows apart, which is
// also where <NEXT> puts an item description's second line.
const TEXT_X = 1, TEXT_Y = 14, TEXT_LINE = 2;

const QTY_BOX_X = 7, QTY_BOX_Y = 15, QTY_BOX_W = 13, QTY_BOX_H = 3;
const QTY_X = 8, QTY_Y = 16;
const QTY_PRICE_X = 12;

const YESNO_X = 14, YESNO_Y = 7, YESNO_W = 6, YESNO_H = 5;

// Lua: MartMenu.lua:135 -- charmap.asm glyphs.
const TIMES = "×";
const YEN = "¥";
const UP_ARROW = "▲";
const DOWN_ARROW = "▼";

/**
 * Lua: MartMenu.lua:146 -- PrintNum PRINTNUM_MONEY without LEADINGZEROS
 * (home/print_num.asm .PrintYen): the ¥ floats just before the first
 * significant digit and the string is always seven tiles.
 */
function moneyText(amount?: number): string {
  const digits = format("%06d", Math.max(0, Math.floor(amount ?? 0)));
  const m = /[1-9]/.exec(digits);
  const first = m ? m.index + 1 : digits.length;
  return " ".repeat(first - 1) + YEN + digits.slice(first - 1);
}

// ----------------------------------------------------------------- text
// Lua: MartMenu.lua:158 -- a "page" is one screenful of the speech box: up to
// two lines.  A `para` starts a new page; a `cont` scrolls one line.
const pages = (...p: Page[]): PageList => p;
const page = (...l: string[]): Page => l;

// Lua: MartMenu.lua:161
const TEXTS: Record<string, Record<string, any>> = {
  // MartDialog / StandardMart (engine/items/mart.asm).
  STANDARD: {
    welcome: page("Welcome! How may I", "help you?"), // MartWelcomeText
    askMore: page("Can I do anything", "else for you?"), // MartAskMoreText
    comeAgain: pages(page("Please come again!")),
    howMany: page("How many?"),
    thanks: pages(page("Here you are.", "Thank you!")),
    noMoney: pages(page("You don't have", "enough money.")),
    packFull: pages(page("You can't carry", "any more items.")),
    // MartFinalPriceText: text_decimal sets PRINTNUM_LEFTALIGN; the ¥ is a
    // literal in the string.
    finalPrice: (qty: number, name: string, total: number) =>
      pages(page(format("%d %s(S)", qty, name), format("will be %s%d.", YEN, total))),
  },
  // HerbShop (MARTTYPE_BITTER): the Goldenrod Underground herb lady.
  BITTER: {
    intro: pages(
      page("Hello, dear."),
      page("I sell inexpensive", "herbal medicine."),
      page("They're good, but", "a trifle bitter."),
      page("Your POKéMON may", "not like them."),
      page("Hehehehe…")),
    comeAgain: pages(page("Come again, dear.", "Hehehehe…")),
    howMany: page("How many?"),
    thanks: pages(page("Thank you, dear.", "Hehehehe…")),
    noMoney: pages(page("Hehehe… You don't", "have the money.")),
    packFull: pages(page("Oh? Your PACK is", "full, dear.")),
    finalPrice: (qty: number, name: string, total: number) =>
      pages(page(format("%d %s(S)", qty, name), format("will be %s%d.", YEN, total))),
  },
  // BargainShop (MARTTYPE_BARGAIN): one of each item, at BargainShopData's prices.
  BARGAIN: {
    intro: pages(
      page("Hiya! Care to see", "some bargains?"),
      page("I sell rare items", "that nobody else"),
      page("carries--but only", "one of each item.")),
    comeAgain: pages(page("Come by again", "sometime.")),
    thanks: pages(page("Thanks.")),
    noMoney: pages(page("Uh-oh, you're", "short on funds.")),
    packFull: pages(page("Uh-oh, your PACK", "is chock-full.")),
    // `cont` scrolls the box one line, so the second page opens on the first
    // page's second line.
    soldOut: pages(
      page("You bought that", "already. I'm all"),
      page("already. I'm all", "sold out of it.")),
    finalPrice: (_qty: number, name: string, total: number) =>
      pages(page(format("%s costs", name), format("%s%d. Want it?", YEN, total))),
  },
  // Pharmacist (MARTTYPE_PHARMACY): Cianwood.
  PHARMACY: {
    intro: pages(page("What's up? Need", "some medicine?")),
    comeAgain: pages(page("All right.", "See you around.")),
    howMany: page("How many?"),
    thanks: pages(page("Thanks much!")),
    noMoney: pages(page("Huh? That's not", "enough money.")),
    packFull: pages(page("You don't have any", "more space.")),
    finalPrice: (qty: number, name: string, total: number) =>
      pages(page(format("%d %s(S)", qty, name), format("will cost %s%d.", YEN, total))),
  },
};

// Lua: MartMenu.lua:237 -- SellMenu's own strings (MARTTYPE_STANDARD only).
const SELL_TEXTS: Record<string, any> = {
  cantBuy: pages(page("Sorry, I can't buy", "that from you.")),
  howMany: page("How many?"),
  // MartSellPriceText's `para` is a real page break; the YES/NO box comes up
  // on the second page without a further press.
  price: (total: number) => pages(page("I can pay you", format("%s%d.", YEN, total)), page("Is that OK?")),
  bought: (name: string, total: number) => pages(page(format("Got %s%d for", YEN, total), format("%s(S).", name))),
};

// Lua: MartMenu.lua:261 -- the data/text/common_2.asm label behind each entry.
const LABELS: Record<string, Record<string, string>> = {
  STANDARD: {
    welcome: "_MartWelcomeText", askMore: "_MartAskMoreText",
    comeAgain: "_MartComeAgainText", howMany: "_MartHowManyText",
    thanks: "_MartThanksText", noMoney: "_MartNoMoneyText",
    packFull: "_MartPackFullText", finalPrice: "_MartFinalPriceText",
  },
  BITTER: {
    intro: "_HerbShopLadyIntroText", comeAgain: "_HerbalLadyComeAgainText",
    howMany: "_HerbalLadyHowManyText", thanks: "_HerbalLadyThanksText",
    noMoney: "_HerbalLadyNoMoneyText", packFull: "_HerbalLadyPackFullText",
    finalPrice: "_HerbalLadyFinalPriceText",
  },
  BARGAIN: {
    intro: "_BargainShopIntroText", comeAgain: "_BargainShopComeAgainText",
    thanks: "_BargainShopThanksText", noMoney: "_BargainShopNoFundsText",
    packFull: "_BargainShopPackFullText", soldOut: "_BargainShopSoldOutText",
    finalPrice: "_BargainShopFinalPriceText",
  },
  PHARMACY: {
    intro: "_PharmacyIntroText", comeAgain: "_PharmacyComeAgainText",
    howMany: "_PharmacyHowManyText", thanks: "_PharmacyThanksText",
    noMoney: "_PharmacyNoMoneyText", packFull: "_PharmacyPackFullText",
    finalPrice: "_PharmacyFinalPriceText",
  },
  SELL: {
    cantBuy: "_MartCantBuyText", howMany: "_MartSellHowManyText",
    price: "_MartSellPriceText", bought: "_MartBoughtText",
  },
};

// Lua: MartMenu.lua:298 -- entries that are ONE screenful of lines rather
// than a list of pages, because they sit under a menu instead of paging.
const SINGLE_PAGE: Record<string, boolean> = { welcome: true, askMore: true, howMany: true };

// Lua: MartMenu.lua:304 -- the formatted entries, keyed by LABEL: the markers
// come in the string's order, and the bargain shop names its item FIRST.
const FILL: Record<string, (...a: any[]) => unknown[]> = {
  _MartFinalPriceText: (qty, name, total) => [qty, name, total],
  _HerbalLadyFinalPriceText: (qty, name, total) => [qty, name, total],
  _PharmacyFinalPriceText: (qty, name, total) => [qty, name, total],
  _BargainShopFinalPriceText: (_qty, name, total) => [name, total],
  _MartSellPriceText: (total) => [total],
  _MartBoughtText: (name, total) => [total, name],
};

/**
 * Lua: MartMenu.lua:324 -- one dialog's table with every entry the cache
 * carries replaced by the extracted string.  Anything missing falls through
 * (the Lua's __index metatable, a prototype here) to the transcription.
 */
function extractedText(text: any, base: Record<string, any>, labels: Record<string, string> | undefined): Record<string, any> {
  const out: Record<string, any> = Object.create(base);
  for (const key of Object.keys(labels || {})) {
    const label = labels![key]!;
    const list = CommonText.of(text, label);
    if (list) {
      const fill = FILL[label];
      if (fill) {
        out[key] = (...a: any[]) => CommonText.fill(list, fill(...a));
      } else if (SINGLE_PAGE[key]) {
        out[key] = list[0];
      } else {
        out[key] = list;
      }
    }
  }
  return out;
}

// Lua: MartMenu.lua:530 -- TOP_ITEMS
const TOP_ITEMS = [Strings.source("BUY"), Strings.source("SELL"), Strings.source("QUIT")];

export class MartMenu {
  // Lua: MartMenu.lua:87 -- the top menu overlays the mart; BuyMenu is
  // FadeToMenu + BlankScreen, so enterBuy shadows this for the list.
  static isOpaque = false;
  isOpaque: boolean | undefined = false;
  // Lua: MartMenu.lua:151, 252, 253, 292
  static moneyText = moneyText;
  static MART_TYPES = MART_TYPES;
  static TEXTS = TEXTS;
  static LABELS = LABELS;

  game: any;
  save: any;
  items: Record<string, any> | undefined;
  marts: any;
  martType: string;
  martId: number;
  onClose?: () => void;
  textData: any;
  text: Record<string, any>;
  sellText: Record<string, any>;
  index: number;
  scroll: number;
  entries: MartEntry[] = [];
  phase = "top";
  topLines?: Page;
  topIndex = 1;
  message?: { pages: TyperPage[]; page: number; onDone?: () => void };
  confirm?: MartConfirm;
  typer?: Typer;
  qtyItem?: MartEntry;
  qty = 1;
  qtyMax = 1;
  pack?: any;
  [key: string]: any;

  /**
   * Lua: MartMenu.lua:351 -- the shelf: `lists` is a 1-based array in MART_*
   * order (a 0-based JS array here); a flat top-level array is accepted too.
   * A missing table leaves the shelf empty rather than inventing stock.
   */
  static inventory(marts: any, martId?: number): string[] {
    martId = martId || 0;
    if (martId >= NUM_MARTS) return DEFAULT_MART;
    if (marts === null || typeof marts !== "object") return [];
    const lists = marts.lists || marts;
    const list = lists[martId];
    if (list === null || typeof list !== "object") return DEFAULT_MART;
    return list;
  }

  /**
   * Lua: MartMenu.lua:363 -- BargainShopData is loaded by BargainShop itself,
   * not by the mart id.
   */
  static bargainRows(marts: any): any[] {
    const rows = marts !== null && typeof marts === "object" ? marts.bargain : undefined;
    if (rows === null || typeof rows !== "object") return [];
    return rows;
  }

  /** Lua: MartMenu.lua:458 -- BuySell_MultiplyPrice. */
  static buyPrice(unit?: number, qty?: number): number {
    return (unit || 0) * (qty ?? 1);
  }

  /**
   * Lua: MartMenu.lua:466 -- Sell_HalvePrice shifts the PRODUCT right once,
   * so the halving happens after the multiply.
   */
  static sellPrice(unit?: number, qty?: number): number {
    return Math.floor(((unit || 0) * (qty ?? 1)) / 2);
  }

  /**
   * Lua: MartMenu.lua:372 -- opts: save, items, marts, martType (MARTTYPE_*
   * number or name), martId (number), text (text.lua), onClose()
   */
  static new(game: any, opts?: MartMenuOpts): MartMenu {
    return new MartMenu(game, opts ?? {});
  }

  constructor(game: any, opts: MartMenuOpts) {
    this.game = game;
    this.save = opts.save || (game && game.save);
    this.items = opts.items || (game && game.data && game.data.items);
    this.marts = opts.marts || (game && game.data && game.data.gen2Marts);
    // The dialog byte, or the MARTTYPE_* name; anything unrecognised is
    // MartDialog, the way MartTypeDialogs' jumptable lands on entry 0.
    const kind = opts.martType ?? 0;
    if (typeof kind === "string") {
      this.martType = TEXTS[kind] ? kind : "STANDARD";
    } else {
      this.martType = MART_TYPES[kind] || "STANDARD";
    }
    this.martId = opts.martId || 0;
    this.onClose = opts.onClose;
    // text.lua rides on the world: the mart is opened by a script on a map.
    this.textData = opts.text || (game && game.world && game.world.text);
    this.text = extractedText(this.textData, TEXTS[this.martType]!, LABELS[this.martType]);
    this.sellText = extractedText(this.textData, SELL_TEXTS, LABELS.SELL);
    this.index = 1;
    this.scroll = 0;
    this.buildEntries();
    if (this.martType === "STANDARD") {
      // .HowMayIHelpYou prints into the speech box and returns TOPMENU
      // without waiting: the welcome line stays under BUY/SELL/QUIT.
      this.phase = "top";
      this.topLines = this.text.welcome;
      this.topIndex = 1;
    } else {
      // HerbShop / BargainShop / Pharmacist: intro, then straight into BuyMenu.
      this.phase = "intro";
      this.say(this.text.intro, () => this.enterBuy());
    }
  }

  /**
   * Lua: MartMenu.lua:416 -- a standard mart prices each row out of
   * ItemAttributes; the bargain shop carries its own price per row and sells
   * one of each, tracked by wBargainShopFlags.
   */
  buildEntries(): void {
    const entries: MartEntry[] = [];
    if (this.martType === "BARGAIN") {
      const sold = (this.save && this.save.bargainShop) || {};
      for (const row of MartMenu.bargainRows(this.marts)) {
        if (row == null) break; // ipairs
        const id = row.item || row.id || row[0];
        const def = id && this.items && this.items[id];
        entries.push({
          id,
          name: (def && def.name) || id || "?",
          price: row.price || row[1] || 0,
          soldOut: sold[id] === true,
        });
      }
    } else {
      for (const id of MartMenu.inventory(this.marts, this.martId)) {
        if (id == null) break; // ipairs
        const def = this.items && this.items[id];
        entries.push({ id, name: (def && def.name) || id, price: (def && def.price) || 0 });
      }
    }
    this.entries = entries;
  }

  // ----------------------------------------------------------------- money
  /** Lua: MartMenu.lua:444 */
  money(): number {
    const player = this.save && this.save.player;
    return (player && player.money) || 0;
  }

  /**
   * Lua: MartMenu.lua:451 -- GiveMoney clamps at MaxMoney and TakeMoney at
   * zero (engine/events/money.asm).
   */
  setMoney(amount: number): void {
    const player = this.save && this.save.player;
    if (!player) return;
    player.money = Math.max(0, Math.min(Math.floor(amount || 0), Save.MAX_MONEY));
  }

  // ---------------------------------------------------------------- overlays
  /**
   * Lua: MartMenu.lua:474 -- PrintText plus the JoyWaitAorB that follows it
   * everywhere in mart.asm.  ../pokecrystal/engine/items/mart.asm:167
   */
  say(list: TyperPage[], onDone?: () => void): void {
    Typer.say(this, list, onDone);
  }

  /** Lua: MartMenu.lua:479 */
  updateMessage(input: any): void {
    Typer.step(this);
    if (Typer.typing(this)) return;
    if (!(input.wasPressed("a") || input.wasPressed("b"))) return;
    const message = this.message!;
    if (message.page < message.pages.length) {
      Typer.turn(this, message);
      return;
    }
    this.message = undefined;
    if (message.onDone) message.onDone();
  }

  /**
   * Lua: MartMenu.lua:494 -- MartConfirmPurchase / the sell flow's YesNoBox.
   * The prompt's last page is the one the box sits on.
   */
  ask(list: TyperPage[] | undefined, onYes?: () => void, onNo?: () => void): void {
    this.confirm = { pages: list || [], page: 1, choice: 1, onYes, onNo };
    Typer.begin(this, this.confirm);
  }

  /** Lua: MartMenu.lua:500 */
  updateConfirm(input: any): void {
    const confirm = this.confirm!;
    Typer.step(this);
    if (Typer.typing(this)) return;
    if (confirm.page < confirm.pages.length) {
      if (input.wasPressed("a") || input.wasPressed("b")) Typer.turn(this, confirm);
      return;
    }
    if (input.wasPressed("up") || input.wasPressed("down")) {
      confirm.choice = confirm.choice === 1 ? 2 : 1;
      return;
    }
    if (input.wasPressed("b")) {
      this.confirm = undefined;
      if (confirm.onNo) confirm.onNo();
      return;
    }
    if (input.wasPressed("a")) {
      const yes = confirm.choice === 1;
      this.confirm = undefined;
      if (yes) {
        if (confirm.onYes) confirm.onYes();
      } else if (confirm.onNo) {
        confirm.onNo();
      }
    }
  }

  // ---------------------------------------------------------------- top menu
  /**
   * Lua: MartMenu.lua:537 -- .TopMenu copies MenuHeader_BuySell fresh every
   * pass: the cursor is back on BUY each time.
   */
  enterTop(lines?: Page): void {
    this.phase = "top";
    this.topLines = lines || this.text.askMore;
    this.topIndex = 1;
  }

  /** Lua: MartMenu.lua:543 */
  updateTop(input: any): void {
    if (input.wasPressed("up")) {
      this.topIndex = this.topIndex > 1 ? this.topIndex - 1 : TOP_ITEMS.length;
      return;
    } else if (input.wasPressed("down")) {
      this.topIndex = this.topIndex < TOP_ITEMS.length ? this.topIndex + 1 : 1;
      return;
    } else if (input.wasPressed("b")) {
      this.quit();
      return;
    } else if (input.wasPressed("a")) {
      if (this.topIndex === 1) this.enterBuy();
      else if (this.topIndex === 2) this.enterSell();
      else this.quit();
    }
  }

  /** Lua: MartMenu.lua:565 -- .Quit: the come-again line, then STANDARDMART_EXIT. */
  quit(): void {
    this.phase = "outro";
    this.say(this.text.comeAgain, () => {
      if (this.onClose) this.onClose();
    });
  }

  // ---------------------------------------------------------------- buy list
  /**
   * Lua: MartMenu.lua:577 -- BuyMenu resets the cursor/scroll backups on
   * entry, so the cursor survives a sale but not a trip through the top menu.
   */
  enterBuy(): void {
    this.phase = "buy";
    this.index = 1;
    this.scroll = 0;
    // BuyMenu: `call FadeToMenu / farcall BlankScreen`.
    this.isOpaque = this.phase === "buy";
  }

  /** Lua: MartMenu.lua:587 */
  total(): number {
    return this.entries.length + 1; // the -1 terminator draws as CANCEL
  }

  /** Lua: MartMenu.lua:591 */
  isCancel(): boolean {
    return this.index > this.entries.length;
  }

  /** Lua: MartMenu.lua:595 */
  selected(): MartEntry | undefined {
    return this.entries[this.index - 1];
  }

  /** Lua: MartMenu.lua:599 */
  ensureVisible(): void {
    if (this.index <= this.scroll) {
      this.scroll = this.index - 1;
    } else if (this.index > this.scroll + VISIBLE_ROWS) {
      this.scroll = this.index - VISIBLE_ROWS;
    }
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, this.total() - VISIBLE_ROWS)));
  }

  /**
   * Lua: MartMenu.lua:609 -- _2DMENU_EXIT_UP / _DOWN with .d_up refusing to
   * move at scroll zero: the buy list does NOT wrap.
   */
  updateBuy(input: any): void {
    if (input.wasPressed("up")) {
      if (this.index > 1) {
        this.index = this.index - 1;
        this.ensureVisible();
      }
      return;
    } else if (input.wasPressed("down")) {
      if (this.index < this.total()) {
        this.index = this.index + 1;
        this.ensureVisible();
      }
      return;
    } else if (input.wasPressed("b")) {
      this.leaveBuy();
      return;
    } else if (input.wasPressed("a")) {
      // .a_button treats a -1 selection as B.
      if (this.isCancel()) this.leaveBuy();
      else this.offerToBuy();
    }
  }

  /**
   * Lua: MartMenu.lua:639 -- BuyMenu returns into StandardMart .Buy, which
   * falls through to .AnythingElse; the other kinds end on come-again.
   */
  leaveBuy(): void {
    // CloseSubmenu restores the map before .AnythingElse.
    this.isOpaque = undefined;
    if (this.martType === "STANDARD") this.enterTop(this.text.askMore);
    else this.quit();
  }

  /** Lua: MartMenu.lua:649 */
  offerToBuy(): void {
    const entry = this.selected();
    if (!entry) return;
    if (this.martType === "BARGAIN") {
      // BargainShopAskPurchaseQuantity: one of each, no selector, and a
      // CHECK_FLAG on wBargainShopFlags ahead of everything else.
      if (entry.soldOut) {
        this.say(this.text.soldOut);
        return;
      }
      this.qtyItem = entry;
      this.qty = 1;
      this.qtyMax = 1;
      this.confirmPurchase();
      return;
    }
    this.qtyItem = entry;
    this.qty = 1;
    this.qtyMax = MAX_ITEM_STACK;
    this.phase = "buyQuantity";
  }

  /** Lua: MartMenu.lua:671 */
  confirmPurchase(): void {
    const entry = this.qtyItem!;
    const total = MartMenu.buyPrice(entry.price, this.qty);
    this.ask(this.text.finalPrice(this.qty, entry.name, total),
      () => this.completePurchase(total),
      () => this.cancelPurchase());
  }

  /** Lua: MartMenu.lua:681 -- .cancel keeps index/scroll. */
  cancelPurchase(): void {
    this.phase = "buy";
  }

  /** Lua: MartMenu.lua:687 -- PlayTransactionSound. */
  playTransaction(): void {
    const data = this.game && this.game.data;
    if (data) Sound.play(data, SFX_TRANSACTION);
  }

  /**
   * Lua: MartMenu.lua:694 -- money is compared BEFORE the bag is asked for
   * room, so a broke player is told about the money and never about the PACK.
   */
  completePurchase(total: number): void {
    const entry = this.qtyItem!;
    if (this.money() < total) {
      this.phase = "buy";
      this.say(this.text.noMoney);
      return;
    }
    const ok = Bag.add(this.save, entry.id, this.qty, this.game && this.game.data);
    if (!ok) {
      this.phase = "buy";
      this.say(this.text.packFull);
      return;
    }
    if (this.martType === "BARGAIN") {
      // FlagAction SET_FLAG on wBargainShopFlags; the daily rollover is not
      // modelled here, so the flag simply lives on the save.
      this.save.bargainShop = this.save.bargainShop || {};
      this.save.bargainShop[entry.id] = true;
      entry.soldOut = true;
    }
    // .proceed's order: the bargain flag, PlayTransactionSound, TakeMoney,
    // and only then MARTTEXT_HERE_YOU_GO.
    this.playTransaction();
    this.setMoney(this.money() - total);
    this.phase = "buy";
    this.say(this.text.thanks);
  }

  // --------------------------------------------------------- quantity picker
  /**
   * Lua: MartMenu.lua:732 -- BuySellToss_InterpretJoypad: up and down WRAP;
   * left and right step by ten and CLAMP.
   */
  quantityStep(delta: number): void {
    let n = this.qty + delta;
    if (delta === 1) {
      if (n > this.qtyMax) n = 1;
    } else if (delta === -1) {
      if (n < 1) n = this.qtyMax;
    } else if (delta > 0) {
      if (n > this.qtyMax) n = this.qtyMax;
    } else {
      if (n <= 0) n = 1;
    }
    this.qty = n;
  }

  /** Lua: MartMenu.lua:746 */
  updateQuantity(input: any, onAccept: () => void, onCancel: () => void): void {
    if (input.wasPressed("up")) this.quantityStep(1);
    else if (input.wasPressed("down")) this.quantityStep(-1);
    else if (input.wasPressed("right")) this.quantityStep(10);
    else if (input.wasPressed("left")) this.quantityStep(-10);
    else if (input.wasPressed("b")) onCancel();
    else if (input.wasPressed("a")) onAccept();
  }

  // --------------------------------------------------------------- sell flow
  /**
   * Lua: MartMenu.lua:772 -- SellMenu opens DepositSellPack.  `world = {}`
   * has no useFieldItem, so PackMenu.useSelected falls through to onChoose.
   * The PACK is held rather than stacked (Screens.build, not push).
   */
  enterSell(): void {
    this.phase = "sell";
    this.pack = Screens.build(this.game, "Gen2PackMenu", {
      save: this.save,
      items: this.items,
      world: {},
      onChoose: (itemId: string, count: number) => this.offerToSell(itemId, count),
      onClose: () => this.leaveSell(),
    });
  }

  /** Lua: MartMenu.lua:783 */
  leaveSell(): void {
    this.pack = undefined;
    this.enterTop(this.text.askMore);
  }

  /**
   * Lua: MartMenu.lua:791 -- .TryToSellItem: _CheckTossableItem is the real
   * gate; a CANT_TOSS item gets MartCantBuyText.
   */
  offerToSell(itemId: string, count: number): void {
    const def = this.items && this.items[itemId];
    if (!def || def.canToss === false) {
      this.say(this.sellText.cantBuy);
      return;
    }
    // Nothing in stock is not a sale.
    if ((count || 0) < 1) {
      this.say(this.sellText.cantBuy);
      return;
    }
    // The selector's ceiling is how many you hold; the unit price is the
    // item's own ItemAttributes price (issue #1243).
    this.qtyItem = { id: itemId, name: def.name || itemId, price: def.price || 0 };
    this.qty = 1;
    this.qtyMax = count;
    this.phase = "sellQuantity";
  }

  /** Lua: MartMenu.lua:817 */
  confirmSale(): void {
    const total = MartMenu.sellPrice(this.qtyItem!.price, this.qty);
    this.ask(this.sellText.price(total),
      () => this.completeSale(total),
      () => {
        this.phase = "sell";
      });
  }

  /** Lua: MartMenu.lua:824 */
  completeSale(total: number): void {
    const entry = this.qtyItem!;
    this.setMoney(this.money() + total);
    Bag.remove(this.save, entry.id, this.qty);
    if (this.pack) this.pack.rebuild();
    this.phase = "sell";
    // PlayTransactionSound comes after MartBoughtText on the cart; both land
    // on the same frame here.
    this.playTransaction();
    this.say(this.sellText.bought(entry.name, total));
  }

  // ----------------------------------------------------------------- update
  /** Lua: MartMenu.lua:838 */
  update(dt?: number): void {
    const input = this.game && this.game.input;
    if (!input) return;
    if (this.message) {
      this.updateMessage(input);
      return;
    }
    if (this.confirm) {
      this.updateConfirm(input);
      return;
    }
    const phase = this.phase;
    if (phase === "top") {
      this.updateTop(input);
    } else if (phase === "buy") {
      this.updateBuy(input);
    } else if (phase === "buyQuantity") {
      this.updateQuantity(input, () => this.confirmPurchase(), () => {
        this.phase = "buy";
      });
    } else if (phase === "sell") {
      if (this.pack) this.pack.update(dt);
    } else if (phase === "sellQuantity") {
      this.updateQuantity(input, () => this.confirmSale(), () => {
        this.phase = "sell";
      });
    }
  }

  // ------------------------------------------------------------------- draw
  /** Lua: MartMenu.lua:868 */
  drawTextBox(lines: string[] | undefined): void {
    Chrome.box(TEXT_BOX_X, TEXT_BOX_Y, TEXT_BOX_W, TEXT_BOX_H);
    (lines || []).forEach((line, k) => {
      Chrome.print(line, TEXT_X, TEXT_Y + k * TEXT_LINE);
    });
  }

  /** Lua: MartMenu.lua:875 */
  drawMoneyBox(): void {
    Chrome.box(MONEY_BOX_X, MONEY_BOX_Y, MONEY_BOX_W, MONEY_BOX_H);
    Chrome.print(moneyText(this.money()), MONEY_X, MONEY_Y);
  }

  /** Lua: MartMenu.lua:881 -- PlaceMoneyBottomLeft / PlaceMoneyAtTopLeftOfTextbox. */
  drawMoneyBoxLow(): void {
    Chrome.box(MONEY_LOW_BOX_X, MONEY_LOW_BOX_Y, MONEY_BOX_W, MONEY_BOX_H);
    Chrome.print(moneyText(this.money()), MONEY_LOW_X, MONEY_LOW_Y);
  }

  /** Lua: MartMenu.lua:886 */
  drawTopMenu(): void {
    Chrome.box(TOP_BOX_X, TOP_BOX_Y, TOP_BOX_W, TOP_BOX_H);
    TOP_ITEMS.forEach((label, k) => {
      const i = k + 1;
      const ty = TOP_LABEL_Y + k * TOP_SPACING;
      if (i === this.topIndex) Chrome.cursor(TOP_LABEL_X - 1, ty);
      Chrome.print(Strings.get(label), TOP_LABEL_X, ty);
    });
  }

  /**
   * Lua: MartMenu.lua:898 -- a TM prints the MOVE's description
   * (PrintItemDescription branches at TM01 into PrintMoveDescription).
   */
  description(): string | undefined {
    const entry = this.selected();
    if (!entry) return undefined;
    const def = this.items && this.items[entry.id];
    if (def && def.teaches) {
      const moves = this.game && this.game.data && this.game.data.moves;
      const moveDef = moves && moves[def.teaches];
      if (moveDef && moveDef.description) return moveDef.description;
    }
    return def ? def.description ?? undefined : undefined;
  }

  /**
   * Lua: MartMenu.lua:914 -- a GB glyph REPLACES the tile it prints over, so
   * white under the seven money tiles first is that replacement.
   */
  printPriceOpaque(amount: number, ty: number): void {
    G.setColor(1, 1, 1, 1);
    G.rectangle("fill", PRICE_X * 8, ty * 8, 7 * 8, 8);
    G.setColor(0, 0, 0, 1);
    Chrome.print(moneyText(amount), PRICE_X, ty);
  }

  /**
   * Lua: MartMenu.lua:922 -- ScrollingMenu_UpdateDisplay calls
   * ClearWholeMenuBox, not MenuBox: the MenuHeader_Buy rect is a cleared
   * field, not a framed window.
   */
  drawBuyList(): void {
    for (let row = 1; row <= VISIBLE_ROWS; row++) {
      const i = row + this.scroll;
      const ty = LIST_Y + (row - 1) * LIST_SPACING;
      if (i <= this.entries.length) {
        const entry = this.entries[i - 1]!;
        if (i === this.index) Chrome.cursor(LIST_X - 1, ty);
        Chrome.print(entry.name, LIST_X, ty);
        this.printPriceOpaque(entry.price, ty + 1);
      } else if (i === this.total()) {
        if (i === this.index) Chrome.cursor(LIST_X - 1, ty);
        Chrome.print(Strings.get("CANCEL"), LIST_X, ty);
      }
    }
    // SCROLLINGMENU_DISPLAY_ARROWS: the ▲ only once scrolled, the ▼ always.
    if (this.scroll > 0) Chrome.print(UP_ARROW, ARROW_X, ARROW_UP_Y);
    Chrome.print(DOWN_ARROW, ARROW_X, ARROW_DOWN_Y);
  }

  /** Lua: MartMenu.lua:949 */
  drawDescription(): void {
    Chrome.box(TEXT_BOX_X, TEXT_BOX_Y, TEXT_BOX_W, TEXT_BOX_H);
    if (this.isCancel()) return;
    const description = this.description();
    if (description == null) return;
    // The description's own '<NEXT>' steps SCREEN_WIDTH * 2 (home/text.asm
    // NextLineChar), which is TEXT_LINE.  '\n' covers hand-written data.
    let m = /^([\s\S]*?)<NEXT>([\s\S]*)$/.exec(description);
    if (!m) m = /^([\s\S]*?)\n([\s\S]*)$/.exec(description);
    const first = m ? m[1] : undefined;
    const second = m ? m[2] : undefined;
    Chrome.print(first ?? description, TEXT_X, TEXT_Y);
    if (second != null) Chrome.print(second, TEXT_X, TEXT_Y + TEXT_LINE);
  }

  /** Lua: MartMenu.lua:964 */
  drawQuantityBox(total: number): void {
    Chrome.box(QTY_BOX_X, QTY_BOX_Y, QTY_BOX_W, QTY_BOX_H);
    Chrome.print(TIMES, QTY_X, QTY_Y);
    // `lb bc, PRINTNUM_LEADINGZEROS | 1, 2`: two digits, zero padded.
    Chrome.print(Chrome.number(this.qty, 2, true), QTY_X + 1, QTY_Y);
    Chrome.print(moneyText(total), QTY_PRICE_X, QTY_Y);
  }

  /** Lua: MartMenu.lua:972 */
  drawYesNo(choice: number): void {
    Chrome.box(YESNO_X, YESNO_Y, YESNO_W, YESNO_H);
    Chrome.print(Strings.get("YES"), YESNO_X + 2, YESNO_Y + 1);
    Chrome.print(Strings.get("NO"), YESNO_X + 2, YESNO_Y + 3);
    Chrome.cursor(YESNO_X + 1, YESNO_Y + (choice === 1 ? 1 : 3));
  }

  /** Lua: MartMenu.lua:980 -- ../pokecrystal/engine/items/mart.asm:517 MartConfirmPurchase */
  yesNoVisible(): boolean {
    const confirm = this.confirm;
    if (!confirm || confirm.page < confirm.pages.length) return false;
    return !Typer.typing(this);
  }

  /** Lua: MartMenu.lua:987 -- whatever the overlays sit on top of. */
  drawUnder(): void {
    const phase = this.phase;
    if (phase === "top") {
      this.drawTopMenu();
      this.drawTextBox(this.topLines);
    } else if (phase === "buy" || phase === "buyQuantity") {
      // BlankScreen (engine/overworld/player_object.asm): the whole tilemap
      // is spaces before the money box, the list and the description go down.
      Chrome.clear();
      this.drawMoneyBox();
      this.drawBuyList();
      this.drawDescription();
    } else if (phase === "sell" || phase === "sellQuantity") {
      if (this.pack) this.pack.drawPanel();
    }
  }

  /** Lua: MartMenu.lua:1005 */
  drawPanel(): void {
    this.drawUnder();

    if (this.phase === "buyQuantity" && !(this.message || this.confirm)) {
      // StandardMartAskPurchaseQuantity prints MARTTEXT_HOW_MANY first, then
      // the selector is drawn over the bottom of that box.
      this.drawTextBox(this.text.howMany);
      this.drawQuantityBox(MartMenu.buyPrice(this.qtyItem!.price, this.qty));
    } else if (this.phase === "sellQuantity" && !(this.message || this.confirm)) {
      this.drawTextBox(this.sellText.howMany);
      // .okay_to_sell prints the question, THEN the money box on its top left.
      this.drawMoneyBoxLow();
      this.drawQuantityBox(MartMenu.sellPrice(this.qtyItem!.price, this.qty));
    }

    if (this.message) {
      this.drawTextBox(this.pageLines(this.message.pages[this.message.page - 1]));
      // LoadBlinkingCursor puts the ▼ at hlcoord 18, 17 while a `para` waits.
      if (this.message.page < this.message.pages.length
        && (this.typer == null || this.typer.done())
        && Typer.arrowOn(this)) {
        Chrome.print(DOWN_ARROW, 18, 17);
      }
    } else if (this.confirm) {
      this.drawTextBox(this.pageLines(this.confirm.pages[this.confirm.page - 1]));
      if (this.yesNoVisible()) this.drawYesNo(this.confirm.choice);
    }
    G.setColor(1, 1, 1, 1);
  }

  /** Typer.text(self, page) with the page as the fallback (Lua: MartMenu.lua:1022). */
  pageLines(page: TyperPage | undefined): string[] | undefined {
    const fallback = typeof page === "string" ? page.split("\n") : page;
    return Typer.text(this, fallback);
  }

  /** Lua: MartMenu.lua:1038 */
  draw(): void {
    this.drawPanel();
  }
}

export default MartMenu;
