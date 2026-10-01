// gen1recomp src/ui/gen2/PrizeMenu.lua (bdfac727, MIT): the Game Corner's
// three prize counters, and the coin case they all read.
//
// Unlike the slot machine and card flip, these are not engine screens on the
// cart: each counter is a MAP SCRIPT that opens a static menu, and the whole
// transaction is script commands the VM already has opcodes for:
//
//   coins   GameCornerCoinVendorScript (engine/events/std_scripts.asm)
//   item    the TM counters (CeladonGameCornerPrizeRoomTMVendor,
//           GoldenrodGameCornerTMVendorScript)
//   mon     the Pokemon counters (CeladonGameCornerPokemonVendor,
//           GoldenrodGameCornerPrizeMonVendorScript)
//
// So this module is NOT a stack state the game ever pushes and carries no
// Screens id; it is kept as a transcription of the counters' own tables,
// because the ORDER of the checks is what a player notices:
//
//   item counter  coins, then the question, then the PACK's room
//   mon counter   coins, then the PARTY's room, then the question
//   coin counter  the case's room FIRST, the wallet second
//
// Every counter's menu header is `menu_coords 0, 2, W, TEXTBOX_Y - 1` (the
// coin vendor's `0, 4, 15, 11`) with STATICMENU_CURSOR: first label at (2,4)
// (coin vendor (2,6)), cursor in column 1, labels two rows apart.
// DisplayCoinCaseBalance (engine/menus/menu_2.asm): Textbox at (11,0) with a
// 7x1 interior, "COIN" at (12,0) in the border row, the count at (13,1).

import G from "../platform/screen.ts";
import { format } from "../platform/lua.ts";
import { Bag } from "../shared/inventory/Bag.ts";
import { CoinCase } from "../core/CoinCase.ts";
import { CommonText, type TextPage } from "../core/CommonText.ts";
import { Font } from "../shared/render/Font.ts";
import { Save } from "../core/Save.ts";
import { Sound } from "../shared/core/Sound.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Mon } from "../battle/Mon.ts";
import { Catching } from "../battle/Catching.ts";
import { Chrome } from "./Chrome.ts";

export interface Prize {
  id?: string;
  name?: string;
  cost?: number;
  level?: number;
  amount?: number;
  label?: string;
  cancel?: boolean;
  silver?: { id: string; name: string };
}

export interface Counter {
  kind: "item" | "mon" | "coins";
  menu: { x: number; y: number; w: number; h: number };
  priceRight?: number;
  prizes: Prize[];
}

/** A text beat: pages plus the source string and args Strings re-renders. */
type Sourced = TextPage[] & { source?: string; args?: unknown[] };
type SourcedPage = TextPage & { source?: string; args?: unknown[] };

export interface CounterTexts {
  intro: Sourced;
  which: SourcedPage;
  confirm?: (name: string) => Sourced;
  hereYouGo?: Sourced;
  notEnoughCoins?: Sourced;
  noRoom?: Sourced;
  comeAgain: Sourced;
  noCoinCase: Sourced;
  bought?: Record<number, Sourced>;
  notEnoughMoney?: Sourced;
  caseFull?: Sourced;
}

export interface PrizeMenuOpts {
  save?: any;
  counter?: string | Counter;
  texts?: string;
  version?: string;
  data?: any;
  hasCoinCase?: boolean;
  where?: any;
  onClose?: () => void;
}

interface Message {
  pages: TextPage[];
  page: number;
  onDone?: () => void;
}

interface Confirm {
  pages: TextPage[];
  page: number;
  choice: number;
  onYes?: () => void;
  onNo?: () => void;
}

// Lua: PrizeMenu.lua:74
function money(save: any): number {
  const player = save && save.player;
  return (player && player.money) || 0;
}

// Lua: PrizeMenu.lua:79
function setMoney(save: any, amount: number): void {
  const player = save && save.player;
  if (!player) return;
  player.money = Math.max(0, Math.min(Math.floor(amount || 0), Save.MAX_MONEY));
}

// Lua: PrizeMenu.lua:168
function sourcedPages(source: string, ...args: unknown[]): Sourced {
  const rendered = args.length > 0 ? format(source, ...args) : source;
  const value = (CommonText.pages(rendered) ?? []) as Sourced;
  value.source = source;
  value.args = args;
  return value;
}

// Lua: PrizeMenu.lua:176
function sourcedPage(source: string, ...args: unknown[]): SourcedPage {
  const value = sourcedPages(source, ...args);
  const first = (value[0] ?? []) as SourcedPage;
  first.source = value.source;
  first.args = value.args;
  return first;
}

// Lua: PrizeMenu.lua:183
function localizedPages(value: Sourced | null | undefined): TextPage[] {
  if (!(value && value.source)) return value ?? [];
  const args = value.args ?? [];
  const translated = args.length > 0 ? Strings.get(value.source, ...args) : Strings.get(value.source);
  return CommonText.pages(translated) ?? [];
}

// Lua: PrizeMenu.lua:190
function localizedPage(value: SourcedPage | null | undefined): TextPage {
  if (!(value && value.source)) return value ?? [];
  return localizedPages(value as unknown as Sourced)[0] ?? [];
}

// Lua: PrizeMenu.lua:350 -- layout.
const COIN_BOX_X = 11;
const COIN_BOX_Y = 0;
const COIN_BOX_W = 9;
const COIN_BOX_H = 3;
const COIN_LABEL_X = 12;
const COIN_LABEL_Y = 0;
const COIN_VALUE_X = 13;
const COIN_VALUE_Y = 1;

const TEXT_BOX_X = 0;
const TEXT_BOX_Y = 12;
const TEXT_BOX_W = 20;
const TEXT_BOX_H = 6;
const TEXT_X = 1;
const TEXT_Y = 14;
const TEXT_LINE = 2;

// YesNoBox: a 6x5 box at (14,7), YES at (16,8), NO at (16,10), cursor col 15.
const YESNO_X = 14;
const YESNO_Y = 7;
const YESNO_W = 6;
const YESNO_H = 5;

const SFX_TRANSACTION = "Sfx_Transaction";

/**
 * Lua: PrizeMenu.lua:594 -- glyph-aware, so a multi-byte character or a macro
 * is never cut mid-sequence.
 */
function clampToTiles(text: string, maxTiles: number): string {
  const spans = Font.split(text);
  if (spans.length <= maxTiles) return text;
  let cut = maxTiles;
  while (cut > 0 && spans[cut - 1]!.to === spans[cut]!.to) cut = cut - 1;
  if (cut === 0) return "";
  return text.slice(0, spans[cut - 1]!.to);
}

export class PrizeMenu {
  // Lua: PrizeMenu.lua:56
  static isOpaque = true;
  isOpaque = true;

  // Lua: PrizeMenu.lua:65 -- the coin case lives in core/CoinCase; these are aliases.
  static get MAX_COINS(): number {
    return CoinCase.MAX_COINS;
  }
  static coins = CoinCase.coins;
  static giveCoins = CoinCase.giveCoins;
  static takeCoins = CoinCase.takeCoins;
  static HAVE_MORE = CoinCase.HAVE_MORE;
  static HAVE_AMOUNT = CoinCase.HAVE_AMOUNT;
  static HAVE_LESS = CoinCase.HAVE_LESS;
  static checkCoins = CoinCase.checkCoins;

  // Lua: PrizeMenu.lua:105 -- the map scripts' own EQU prices.
  static COUNTERS: Record<string, Counter> = {
    CELADON_TM: {
      kind: "item",
      menu: { x: 0, y: 2, w: 16, h: 10 },
      priceRight: 13,
      prizes: [
        { id: "TM_DOUBLE_TEAM", name: Strings.source("TM32"), cost: 1500 },
        { id: "TM_PSYCHIC_M", name: Strings.source("TM29"), cost: 3500 },
        { id: "TM_HYPER_BEAM", name: Strings.source("TM15"), cost: 7500 },
      ],
    },
    CELADON_MON: {
      kind: "mon",
      menu: { x: 0, y: 2, w: 18, h: 10 },
      priceRight: 16,
      prizes: [
        { id: "MR__MIME", name: Strings.source("MR.MIME"), cost: 3333, level: 15 },
        { id: "EEVEE", name: Strings.source("EEVEE"), cost: 6666, level: 15 },
        { id: "PORYGON", name: Strings.source("PORYGON"), cost: 9999, level: 20 },
      ],
    },
    GOLDENROD_TM: {
      kind: "item",
      menu: { x: 0, y: 2, w: 16, h: 10 },
      priceRight: 13,
      prizes: [
        { id: "TM_THUNDER", name: Strings.source("TM25"), cost: 5500 },
        { id: "TM_BLIZZARD", name: Strings.source("TM14"), cost: 5500 },
        { id: "TM_FIRE_BLAST", name: Strings.source("TM38"), cost: 5500 },
      ],
    },
    GOLDENROD_MON: {
      kind: "mon",
      menu: { x: 0, y: 2, w: 18, h: 10 },
      priceRight: 16,
      prizes: [
        { id: "ABRA", name: Strings.source("ABRA"), cost: 200, level: 10 },
        {
          id: "EKANS", name: Strings.source("EKANS"), cost: 700, level: 10,
          silver: { id: "SANDSHREW", name: Strings.source("SANDSHREW") },
        },
        { id: "DRATINI", name: Strings.source("DRATINI"), cost: 2100, level: 10 },
      ],
    },
    // GameCornerCoinVendorScript: `menu_coords 0, 4, 15, TEXTBOX_Y - 1`.
    COIN_VENDOR: {
      kind: "coins",
      menu: { x: 0, y: 4, w: 16, h: 8 },
      prizes: [
        { amount: 50, cost: 1000, label: Strings.source(" 50 :  ¥1000") },
        { amount: 500, cost: 10000, label: Strings.source("500 : ¥10000") },
      ],
    },
  };

  // Lua: PrizeMenu.lua:195 -- three rooms, three wordings.
  static TEXTS: Record<string, CounterTexts> = {
    CELADON: {
      intro: sourcedPages(Strings.source("Welcome!\fWe exchange your\ncoins for fabulous\vprizes!")),
      which: sourcedPage(Strings.source("Which prize would\nyou like?")),
      confirm: (name: string) => sourcedPages(Strings.source("OK, so you wanted\na %s?"), name),
      hereYouGo: sourcedPages(Strings.source("Here you go!")),
      notEnoughCoins: sourcedPages(Strings.source("You don't have\nenough coins.")),
      noRoom: sourcedPages(Strings.source("You have no room\nfor it.")),
      comeAgain: sourcedPages(Strings.source("Oh. Please come\nback with coins!")),
      noCoinCase: sourcedPages(Strings.source("Oh? You don't have\na COIN CASE.")),
    },
    GOLDENROD: {
      intro: sourcedPages(Strings.source("Welcome!\fWe exchange your\ngame coins for\vfabulous prizes!")),
      which: sourcedPage(Strings.source("Which prize would\nyou like?")),
      confirm: (name: string) => sourcedPages(Strings.source("%s.\nIs that right?"), name),
      hereYouGo: sourcedPages(Strings.source("Here you go!")),
      notEnoughCoins: sourcedPages(Strings.source("Sorry! You need\nmore coins.")),
      noRoom: sourcedPages(Strings.source("Sorry. You can't\ncarry any more.")),
      comeAgain: sourcedPages(Strings.source("OK. Please save\nyour coins and\vcome again!")),
      noCoinCase: sourcedPages(Strings.source("Oh? You don't have\na COIN CASE.")),
    },
    COIN_VENDOR: {
      intro: sourcedPages(Strings.source("Welcome to the\nGAME CORNER.")),
      which: sourcedPage(Strings.source("Do you need some\ngame coins?")),
      bought: {
        50: sourcedPages(Strings.source("Thank you!\nHere are 50 coins.")),
        500: sourcedPages(Strings.source("Thank you! Here\nare 500 coins.")),
      },
      notEnoughMoney: sourcedPages(Strings.source("You don't have\nenough money.")),
      caseFull: sourcedPages(Strings.source("Whoops! Your COIN\nCASE is full.")),
      comeAgain: sourcedPages(Strings.source("No coins for you?\nCome again!")),
      noCoinCase: sourcedPages(Strings.source(
        "Do you need game\ncoins?\fOh, you don't have\na COIN CASE for\vyour coins.")),
    },
  };

  // Lua: PrizeMenu.lua:264 -- PARTY_LENGTH.
  static PARTY_LENGTH = Save.PARTY_SIZE;

  // Lua: PrizeMenu.lua:266
  static canAfford = CoinCase.canAfford;

  game: any;
  save: any;
  data: any;
  where: any;
  onClose?: () => void;
  counter: Counter;
  text: CounterTexts;
  version: string;
  prizes: Prize[] = [];
  index: number;
  hasCoinCase: boolean;
  phase?: string;
  message?: Message | null;
  confirm?: Confirm | null;
  [key: string]: any;

  /** Lua: PrizeMenu.lua:270 -- the room check; the two kinds ask at different points. */
  static hasRoom(save: any, counter: Counter, prize: Prize, data?: any): boolean {
    if (counter.kind === "mon") {
      return ((save && save.party) || []).length < PrizeMenu.PARTY_LENGTH;
    }
    if (counter.kind === "coins") {
      // `checkcoins MAX_COINS - amount / ifequal HAVE_MORE`.
      return PrizeMenu.checkCoins(save, PrizeMenu.MAX_COINS - (prize.amount ?? 0)) !== PrizeMenu.HAVE_MORE;
    }
    // giveitem's own failure, asked of Bag.add against a scratch copy.
    const inv: Record<string, number> = (save && save.inventory) || {};
    const scratch: { inventory: Record<string, number> } = { inventory: {} };
    for (const id of Object.keys(inv)) scratch.inventory[id] = inv[id]!;
    return Bag.add(scratch, prize.id!, 1, data || {}) === true;
  }

  /** Lua: PrizeMenu.lua:291 -- "ok", "coins", "room", or "money". */
  static check(save: any, counter: Counter, prize: Prize, data?: any): string {
    if (counter.kind === "coins") {
      if (!PrizeMenu.hasRoom(save, counter, prize, data)) return "room";
      if (money(save) < (prize.cost ?? 0)) return "money";
      return "ok";
    }
    if (!PrizeMenu.canAfford(save, prize.cost)) return "coins";
    if (counter.kind === "mon" && !PrizeMenu.hasRoom(save, counter, prize, data)) return "room";
    return "ok";
  }

  /**
   * Lua: PrizeMenu.lua:308 -- the transaction once the player said yes. Item
   * counters giveitem BEFORE takecoins, so a full bag costs nothing.
   */
  static buy(save: any, counter: Counter, prize: Prize, data?: any, where?: any): string {
    if (counter.kind === "coins") {
      const reason = PrizeMenu.check(save, counter, prize, data);
      if (reason !== "ok") return reason;
      PrizeMenu.giveCoins(save, prize.amount);
      setMoney(save, money(save) - (prize.cost ?? 0));
      return "ok";
    }
    if (!PrizeMenu.canAfford(save, prize.cost)) return "coins";
    if (counter.kind === "mon") {
      if (!PrizeMenu.hasRoom(save, counter, prize, data)) return "room";
      const mon = Mon.new(data, prize.id!, prize.level);
      if (!mon) return "room";
      save.party = save.party || [];
      // A `givepoke`: AddPartyMon's stamp (move_mon.asm:143-149).
      Mon.stampOT(save, mon);
      // ../pokecrystal/engine/pokemon/move_mon.asm:1761-1773
      const stamp: Record<string, any> = { version: save.version, save, data };
      if (where !== null && typeof where === "object") {
        for (const key of Object.keys(where)) {
          if (stamp[key] == null) stamp[key] = where[key];
        }
      }
      Catching.stampCaughtData(mon, stamp as any);
      save.party.push(mon);
      // `special GameCornerPrizeMonCheckDex` before the givepoke.
      save.pokedex = save.pokedex || { seen: {}, caught: {} };
      save.pokedex.seen[prize.id!] = true;
      save.pokedex.caught[prize.id!] = true;
      PrizeMenu.takeCoins(save, prize.cost);
      return "ok";
    }
    if (!Bag.add(save, prize.id!, 1, data || {})) return "room";
    PrizeMenu.takeCoins(save, prize.cost);
    return "ok";
  }

  /** Lua: PrizeMenu.lua:365 */
  wantsFillScale(): boolean {
    return true;
  }

  /** Lua: PrizeMenu.lua:366 */
  drawsWidescreen(): boolean {
    return true;
  }

  /**
   * Lua: PrizeMenu.lua:370 -- opts: save, counter (a COUNTERS key or a table),
   * texts (a TEXTS key), version, data, hasCoinCase (defaults to the bag),
   * where, onClose.
   */
  static new(game: any, opts?: PrizeMenuOpts): PrizeMenu {
    return new PrizeMenu(game, opts ?? {});
  }

  constructor(game: any, opts: PrizeMenuOpts) {
    this.game = game;
    this.save = opts.save || (game && game.save);
    this.data = opts.data || (game && game.data);
    this.where = opts.where;
    this.onClose = opts.onClose;
    const counter = opts.counter || "CELADON_TM";
    this.counter = (typeof counter === "object" && counter)
      || PrizeMenu.COUNTERS[counter as string] || PrizeMenu.COUNTERS.CELADON_TM!;
    const textKey = opts.texts || (this.counter.kind === "coins" ? "COIN_VENDOR" : "CELADON");
    this.text = PrizeMenu.TEXTS[textKey] || PrizeMenu.TEXTS.CELADON!;
    this.version = opts.version || (this.save && this.save.version) || "gold";
    this.buildPrizes();
    this.index = 1;
    // `checkitem COIN_CASE / iffalse` is the first thing after the intro.
    if (opts.hasCoinCase != null) {
      this.hasCoinCase = opts.hasCoinCase;
    } else {
      const inv = (this.save && this.save.inventory) || {};
      this.hasCoinCase = (inv.COIN_CASE || 0) > 0;
    }
    this.say(this.text.intro, () => {
      if (!this.hasCoinCase) this.say(this.text.noCoinCase, () => this.close());
      else this.enterMenu();
    });
  }

  /** Lua: PrizeMenu.lua:406 -- the Goldenrod mon counter's `checkver` swap. */
  buildPrizes(): void {
    const silver = this.version === "silver";
    const out: Prize[] = [];
    for (const prize of this.counter.prizes) {
      if (silver && prize.silver) {
        const swapped: Prize = { ...prize };
        swapped.id = prize.silver.id;
        swapped.name = prize.silver.name;
        delete swapped.silver;
        out.push(swapped);
      } else {
        out.push(prize);
      }
    }
    // Every counter's menu data ends with a literal CANCEL row.
    out.push({ cancel: true, label: Strings.source("CANCEL") });
    this.prizes = out;
  }

  /** Lua: PrizeMenu.lua:426 */
  say(list: Sourced | null | undefined, onDone?: () => void): void {
    this.message = { pages: localizedPages(list), page: 1, onDone };
  }

  /** Lua: PrizeMenu.lua:430 */
  ask(list: Sourced, onYes?: () => void, onNo?: () => void): void {
    this.confirm = { pages: localizedPages(list), page: 1, choice: 1, onYes, onNo };
  }

  /** Lua: PrizeMenu.lua:435 -- `db 1 ; default option` every pass. */
  enterMenu(): void {
    this.phase = "menu";
    this.index = 1;
    this.message = null;
  }

  /** Lua: PrizeMenu.lua:443 */
  close(): void {
    if (this.onClose) this.onClose();
  }

  /** Lua: PrizeMenu.lua:447 */
  cancel(): void {
    this.say(this.text.comeAgain, () => this.close());
  }

  /** Lua: PrizeMenu.lua:451 */
  sfx(name: string): void {
    if (this.data) Sound.play(this.data, name);
  }

  /** Lua: PrizeMenu.lua:455 */
  prizeName(prize: Prize): string {
    if (this.counter.kind === "coins") return format("%d coins", prize.amount);
    const items = this.data && this.data.items;
    const mons = this.data && this.data.pokemon;
    const def = this.counter.kind === "mon" ? mons : items;
    const entry = def && def[prize.id!];
    return (entry && entry.name) || prize.id!;
  }

  /** Lua: PrizeMenu.lua:466 */
  refuse(reason: string): void {
    const text = this.text;
    if (reason === "coins") this.say(text.notEnoughCoins, () => this.close());
    else if (reason === "money") this.say(text.notEnoughMoney, () => this.close());
    else if (reason === "room") this.say(text.noRoom || text.caseFull, () => this.close());
  }

  /** Lua: PrizeMenu.lua:477 */
  choose(): void {
    const prize = this.prizes[this.index - 1];
    if (!prize || prize.cancel) {
      this.cancel();
      return;
    }
    // The pre-confirm ladder; a refusal ends the conversation.
    const reason = PrizeMenu.check(this.save, this.counter, prize, this.data);
    if (reason !== "ok") {
      this.refuse(reason);
      return;
    }
    if (this.counter.kind === "coins") {
      // The coin vendor never asks.
      this.complete(prize);
      return;
    }
    this.ask(this.text.confirm!(this.prizeName(prize)),
      () => this.complete(prize),
      () => this.cancel());
  }

  /** Lua: PrizeMenu.lua:501 -- ../pokecrystal/engine/pokemon/caught_data.asm:177-193 */
  caughtWhere(): any {
    if (this.where) return this.where;
    const world = this.game && this.game.world;
    if (!(world && world.caughtDataOpts)) return null;
    return world.caughtDataOpts();
  }

  /** Lua: PrizeMenu.lua:508 */
  complete(prize: Prize): void {
    const reason = PrizeMenu.buy(this.save, this.counter, prize, this.data, this.caughtWhere());
    if (reason !== "ok") {
      this.refuse(reason);
      return;
    }
    this.sfx(SFX_TRANSACTION);
    const bought = this.text.bought && prize.amount != null ? this.text.bought[prize.amount] : undefined;
    this.say(bought || this.text.hereYouGo, () => this.enterMenu());
  }

  /** Lua: PrizeMenu.lua:520 */
  updateMessage(input: any): void {
    if (!(input.wasPressed("a") || input.wasPressed("b"))) return;
    const message = this.message!;
    if (message.page < message.pages.length) {
      message.page = message.page + 1;
      return;
    }
    this.message = null;
    if (message.onDone) message.onDone();
  }

  /** Lua: PrizeMenu.lua:531 */
  updateConfirm(input: any): void {
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

  /** Lua: PrizeMenu.lua:559 */
  update(_dt?: number): void {
    const input = this.game && this.game.input;
    if (!input) return;
    if (this.confirm) {
      this.updateConfirm(input);
      return;
    }
    if (this.message) {
      this.updateMessage(input);
      return;
    }
    if (this.phase !== "menu") return;
    if (input.wasPressed("up")) {
      this.index = this.index > 1 ? this.index - 1 : this.prizes.length;
    } else if (input.wasPressed("down")) {
      this.index = this.index < this.prizes.length ? this.index + 1 : 1;
    } else if (input.wasPressed("b")) {
      this.cancel();
    } else if (input.wasPressed("a")) {
      this.choose();
    }
  }

  /** Lua: PrizeMenu.lua:583 -- DisplayCoinCaseBalance. */
  drawCoinBox(): void {
    Chrome.textbox(COIN_BOX_X, COIN_BOX_Y, COIN_BOX_W - 2, COIN_BOX_H - 2);
    Chrome.print(Strings.get("COIN"), COIN_LABEL_X, COIN_LABEL_Y);
    Chrome.print(Chrome.number(PrizeMenu.coins(this.save), 4, true), COIN_VALUE_X, COIN_VALUE_Y);
  }

  /** Lua: PrizeMenu.lua:612 */
  drawPanel(): void {
    Chrome.clear();
    this.drawCoinBox();
    if (this.phase === "menu" || this.confirm) {
      const menu = this.counter.menu;
      Chrome.textbox(menu.x, menu.y, menu.w - 2, menu.h - 2);
      this.prizes.forEach((prize, i0) => {
        const i = i0 + 1;
        const ty = menu.y + 2 + (i - 1) * 2;
        if (i === this.index) Chrome.cursor(menu.x + 1, ty);
        if (prize.name) {
          const priceText = String(prize.cost);
          const priceRight = this.counter.priceRight ?? 0;
          // -2: at least one blank tile between the name and the price.
          const nameBudget = priceRight - priceText.length - 2;
          Chrome.print(clampToTiles(Strings.lookup(prize.name), nameBudget), menu.x + 2, ty);
          Chrome.print(priceText, menu.x + priceRight - priceText.length + 1, ty);
        } else {
          Chrome.print(Strings.lookup(prize.label ?? ""), menu.x + 2, ty);
        }
      });
    }
    let lines: TextPage | undefined;
    if (this.confirm) lines = this.confirm.pages[this.confirm.page - 1];
    else if (this.message) lines = this.message.pages[this.message.page - 1];
    else if (this.phase === "menu") lines = localizedPage(this.text.which);
    if (lines) {
      Chrome.textbox(TEXT_BOX_X, TEXT_BOX_Y, TEXT_BOX_W - 2, TEXT_BOX_H - 2);
      lines.forEach((line, i) => Chrome.print(line, TEXT_X, TEXT_Y + i * TEXT_LINE));
    }
    if (this.confirm && this.confirm.page >= this.confirm.pages.length) {
      Chrome.textbox(YESNO_X, YESNO_Y, YESNO_W - 2, YESNO_H - 2);
      Chrome.print(Strings.get("YES"), YESNO_X + 2, YESNO_Y + 1);
      Chrome.print(Strings.get("NO"), YESNO_X + 2, YESNO_Y + 3);
      Chrome.cursor(YESNO_X + 1, YESNO_Y + 1 + (this.confirm.choice - 1) * 2);
    }
  }

  /** Lua: PrizeMenu.lua:655 */
  draw(): void {
    this.drawPanel();
  }

  /** Lua: PrizeMenu.lua:659 */
  drawWidescreen(winW: number, winH: number): void {
    Chrome.letterbox(winW, winH, 1, 1, 1);
    const scale = Chrome.fitScale();
    G.push();
    const [ox, oy] = Chrome.fitOrigin();
    G.translate(ox, oy);
    G.scale(scale, scale);
    this.drawPanel();
    G.pop();
  }
}

export default PrizeMenu;
