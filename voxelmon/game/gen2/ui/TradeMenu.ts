// gen1recomp src/ui/gen2/TradeMenu.lua (bdfac727, MIT): the in-game trade
// conversation (engine/events/npc_trade.asm NPCTrade).
//
// NPCTrade is a straight line, and its ORDER is the whole of it:
//
//   1. the trade's flag is already set -> TRADE_DIALOG_AFTER, and stop.
//   2. TRADE_DIALOG_INTRO, then YesNoBox. A no is TRADE_DIALOG_CANCEL.
//   3. SelectTradeOrDayCareMon (PARTYMENUACTION_GIVE_MON). Backing out is the
//      SAME TRADE_DIALOG_CANCEL.
//   4. the picked mon against NPCTRADE_GIVEMON, then CheckTradeGender. Either
//      miss is TRADE_DIALOG_WRONG.
//   5. set the flag, NPCTradeCableText, DoNPCTrade, the trade animation,
//      TradedForText, RestartMapMusic, TRADE_DIALOG_COMPLETE.
//
// The lines come out of the cache: TradeTexts by dialog and then by the row's
// TRADE_DIALOGSET_*. {STRBUF} is the mon name the line splices in.

import { tonumber, tostring, truthy } from "../platform/lua.ts";
import G from "../platform/screen.ts";
import { CommonText } from "../core/CommonText.ts";
import { NpcTrade } from "../core/NpcTrade.ts";
import { Sound } from "../shared/core/Sound.ts";
import { Strings } from "../shared/core/Strings.ts";
import { TextBox } from "../shared/render/TextBox.ts";
import { Screens } from "../shared/ui/Screens.ts";
import { Chrome } from "./Chrome.ts";

// Lua: TradeMenu.lua:40 -- the shared speech box.
const BOX_X = 0;
const BOX_Y = 12;
const BOX_W = 20;
const BOX_H = 6;
const TEXT_X = 1;
const TEXT_Y = 14;
const TEXT_LINE = 2;
const ARROW_X = 18;
const ARROW_Y = 17;

// Lua: TradeMenu.lua:46 -- InitYesNoTextBoxParameters' default.
const YESNO_X = 14;
const YESNO_Y = 7;
const YESNO_W = 6;
const YESNO_H = 5;

// Lua: TradeMenu.lua:48
const GENDER_GLYPH: Record<string, string> = {
  TRADE_GENDER_MALE: "♂",
  TRADE_GENDER_FEMALE: "♀",
};

// Lua: TradeMenu.lua:56 -- fallbacks for a cache with no tradeTexts (the
// COLLECTOR set).
const FALLBACK: Record<string, string> = {
  TRADE_DIALOG_INTRO: Strings.source("I collect #MON.\nDo you have\v{STRBUF}?\fWant to trade it\nfor my {STRBUF}?"),
  TRADE_DIALOG_CANCEL: Strings.source("You don't want to\ntrade? Aww…"),
  TRADE_DIALOG_WRONG: Strings.source("Huh? That's not\n{STRBUF}. What a letdown…"),
  TRADE_DIALOG_COMPLETE: Strings.source("Yay! I got myself\n{STRBUF}!\vThanks!"),
  TRADE_DIALOG_AFTER: Strings.source("Hi, how's my old\n{STRBUF} doing?"),
};

// Lua: TradeMenu.lua:72 -- `para` ($51), `cont` ($55), `line` / `next`.
const PAGE = "\f";
const SCROLL = "\v";
const LINE = "\n";
const SEPARATORS = new RegExp(`([^${LINE}${PAGE}${SCROLL}]*)([${LINE}${PAGE}${SCROLL}])`, "g");

interface Message {
  pages: string[][];
  page: number;
  onDone?: () => void;
}

interface Confirm {
  pages: string[][];
  page: number;
  choice: number;
  onYes?: () => void;
  onNo?: () => void;
}

export interface TradeMenuOpts {
  /** The NPC_TRADE_* id. */
  trade?: number | string;
  save?: any;
  /** data's event tables (npcTrades, tradeTexts, tradeBuffers). */
  eventTables?: any;
  /** Fired once when the conversation ends (the caller pops the screen). */
  onClose?: () => void;
}

export class TradeMenu {
  // Lua: TradeMenu.lua:36
  static isOpaque = false;
  isOpaque = false;
  [key: string]: any;

  game: any;
  data: any;
  save: any;
  eventTables: any;
  id: number;
  onClose?: () => void;
  row: any;
  message: Message | null | undefined;
  confirm: Confirm | null | undefined;
  closed?: boolean;
  picking?: boolean;
  animating?: boolean;

  /** Lua: TradeMenu.lua:77 -- split a decoded text stream into pages of up to two lines. */
  static paginate(body: unknown): string[][] {
    body = CommonText.plain(body);
    const pages: string[][] = [];
    let current: string[] = [];
    const flush = (scroll: boolean): void => {
      if (current.length > 0) pages.push(current);
      current = scroll ? [current[current.length - 1] ?? ""] : [];
    };
    const text = tostring(truthy(body) ? body : "") + PAGE;
    for (const m of text.matchAll(SEPARATORS)) {
      const chunk = m[1]!;
      const sep = m[2]!;
      current.push(chunk);
      if (sep === PAGE) flush(false);
      else if (sep === SCROLL) flush(true);
    }
    if (pages.length === 0) pages[0] = [tostring(truthy(body) ? body : "")];
    return pages;
  }

  /**
   * Lua: TradeMenu.lua:108 -- GetTradeMonNames' three buffers, filled in
   * order out of the extractor's buffer list (events.tradeBuffers).
   */
  static fill(body: unknown, row: any, data: any, buffers?: string[] | null): string {
    const speciesName = (id: any): string => {
      const def = data && data.pokemon && data.pokemon[id];
      return (def && def.name) || (truthy(id) ? id : "#MON");
    };
    const give = speciesName(row && row.give);
    const get = speciesName(row && row.get);
    const byBuffer: Record<string, string> = {
      wStringBuffer1: give + (GENDER_GLYPH[row && row.gender] ?? ""),
      wStringBuffer2: get,
      wMonOrItemNameBuffer: give,
    };
    let n = 0;
    return tostring(truthy(body) ? body : "").replace(/\{STRBUF\}/g, () => {
      n = n + 1;
      return byBuffer[(buffers || [])[n - 1] || "wStringBuffer1"] ?? byBuffer.wStringBuffer1!;
    });
  }

  /** Lua: TradeMenu.lua:128 -- opts: trade (the NPC_TRADE_* id), save, eventTables, onClose. */
  static new(game: any, opts?: TradeMenuOpts): TradeMenu {
    return new TradeMenu(game, opts);
  }

  constructor(game: any, opts?: TradeMenuOpts) {
    const o: TradeMenuOpts = opts || {};
    this.game = game;
    this.data = (game && game.data) || {};
    this.save = o.save || (game && game.save);
    this.eventTables = o.eventTables || {};
    this.id = tonumber(o.trade) ?? 0;
    this.onClose = o.onClose;
    this.row = NpcTrade.row(this.eventTables, this.id);
    if (!this.row) {
      this.close();
    } else if (NpcTrade.done(this.save, this.id)) {
      this.say(NpcTrade.DIALOG_AFTER, () => this.close());
    } else {
      this.ask(
        NpcTrade.DIALOG_INTRO,
        () => this.openParty(),
        () => this.refuse(NpcTrade.DIALOG_CANCEL),
      );
    }
  }

  /** Lua: TradeMenu.lua:150 */
  wantsFillScale(): boolean {
    return true;
  }

  /** Lua: TradeMenu.lua:152 */
  lineFor(dialog: string): string[][] {
    const texts = this.eventTables.tradeTexts;
    const row = texts && texts[dialog];
    const set = this.row && this.row.dialog;
    const body = (row && set && row[set]) || FALLBACK[dialog] || "";
    const bufRow = (this.eventTables.tradeBuffers || {})[dialog];
    const buffers = bufRow && set && bufRow[set];
    return TradeMenu.paginate(this.expand(TradeMenu.fill(body, this.row, this.data, buffers)));
  }

  /** Lua: TradeMenu.lua:163 */
  say(dialog: string, onDone?: () => void): void {
    this.message = { pages: this.lineFor(dialog), page: 1, onDone };
  }

  /**
   * Lua: TradeMenu.lua:172 -- {PLAYER} (TradedForText) resolved the way the
   * shared TextBox does, since this screen prints through Chrome.
   */
  expand(body: string): string {
    const game = this.game;
    if (!(game && game.save)) return body;
    try {
      const out = TextBox.substitute(game, body);
      return truthy(out) ? out : body;
    } catch {
      return body;
    }
  }

  /** Lua: TradeMenu.lua:179 */
  sayRaw(body: string, buffers: string[] | null | undefined, onDone?: () => void): void {
    this.message = {
      pages: TradeMenu.paginate(this.expand(TradeMenu.fill(body, this.row, this.data, buffers))),
      page: 1,
      onDone,
    };
  }

  /** Lua: TradeMenu.lua:187 */
  ask(dialog: string, onYes?: () => void, onNo?: () => void): void {
    this.confirm = { pages: this.lineFor(dialog), page: 1, choice: 1, onYes, onNo };
  }

  /** Lua: TradeMenu.lua:192 */
  refuse(dialog: string): void {
    this.say(dialog, () => this.close());
  }

  /** Lua: TradeMenu.lua:196 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.onClose) this.onClose();
  }

  /** Lua: TradeMenu.lua:202 */
  playSfx(name: string): void {
    const sfx = this.data.audio && this.data.audio.sfx;
    if (sfx && sfx[Sound.resolve(this.data, name)]) {
      Sound.play(this.data, name);
    }
  }

  /** Lua: TradeMenu.lua:209 -- SelectTradeOrDayCareMon. */
  openParty(): void {
    const game = this.game;
    if (!(game && game.stack)) {
      return this.refuse(NpcTrade.DIALOG_CANCEL);
    }
    this.picking = true;
    Screens.push(game, "Gen2PartyMenu", {
      party: this.save && this.save.party,
      prompt: "choose",
      onChoose: (index: number) => {
        game.stack.pop();
        this.picking = false;
        this.chose(index);
      },
      onCancel: () => {
        game.stack.pop();
        this.picking = false;
        this.refuse(NpcTrade.DIALOG_CANCEL);
      },
    });
  }

  /** Lua: TradeMenu.lua:231 -- `index` is the 1-based party slot. */
  chose(index: number): void {
    const mon = this.save && this.save.party && this.save.party[index - 1];
    const refusal = NpcTrade.check(this.row, mon);
    if (truthy(refusal)) return this.refuse(refusal!);
    // The flag is set BEFORE the swap, and the cable line before that.
    NpcTrade.markDone(this.save, this.id);
    const texts = this.eventTables.tradeTexts || {};
    const bufs = this.eventTables.tradeBuffers || {};
    // NPCTradeCableText is a bare PrintText (engine/events/npc_trade.asm:37-41).
    this.sayRaw(
      texts.NPCTradeCableText || Strings.source("OK, connect the\nGame Link Cable."),
      bufs.NPCTradeCableText,
      () => {
        const [given, received] = NpcTrade.perform(this.data, this.save, this.row, index) ?? [undefined, undefined];
        this.playAnim(given, received, () => {
          this.sayRaw(
            texts.TradedForText || Strings.source("{PLAYER} traded\n{STRBUF} for\v{STRBUF}."),
            bufs.TradedForText,
            () => this.refuse(NpcTrade.DIALOG_COMPLETE),
          );
        });
      },
    );
  }

  /**
   * Lua: TradeMenu.lua:260 -- `predef TradeAnimation`, a screen of its own;
   * with no stack (headless) the conversation just carries on.
   */
  playAnim(given: any, received: any, onDone: () => void): void {
    const game = this.game;
    if (!(game && game.stack && given)) return onDone();
    this.animating = true;
    Screens.push(game, "Gen2TradeAnim", {
      row: this.row,
      given,
      received,
      save: this.save,
      eventTables: this.eventTables,
      onDone: () => {
        game.stack.pop();
        this.animating = false;
        onDone();
      },
    });
  }

  /** Lua: TradeMenu.lua:278 */
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

  /** Lua: TradeMenu.lua:289 */
  updateConfirm(input: any): void {
    const confirm = this.confirm!;
    if (confirm.page < confirm.pages.length) {
      if (input.wasPressed("a") || input.wasPressed("b")) {
        confirm.page = confirm.page + 1;
      }
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

  /** Lua: TradeMenu.lua:317 */
  update(_dt?: number): void {
    if (this.picking || this.animating) return;
    const input = this.game && this.game.input;
    if (!input) return;
    if (this.message) return this.updateMessage(input);
    if (this.confirm) return this.updateConfirm(input);
  }

  /** Lua: TradeMenu.lua:325 */
  drawTextBox(lines: string[] | null | undefined): void {
    Chrome.box(BOX_X, BOX_Y, BOX_W, BOX_H);
    (lines || []).forEach((line, i) => {
      Chrome.print(line, TEXT_X, TEXT_Y + i * TEXT_LINE);
    });
  }

  /** Lua: TradeMenu.lua:332 */
  drawYesNo(choice: number): void {
    Chrome.box(YESNO_X, YESNO_Y, YESNO_W, YESNO_H);
    Chrome.print(Strings.get("YES"), YESNO_X + 2, YESNO_Y + 1);
    Chrome.print(Strings.get("NO"), YESNO_X + 2, YESNO_Y + 3);
    Chrome.cursor(YESNO_X + 1, YESNO_Y + (choice === 1 ? 1 : 3));
  }

  /** Lua: TradeMenu.lua:339 */
  draw(): void {
    if (this.message) {
      this.drawTextBox(this.message.pages[this.message.page - 1]);
      if (this.message.page < this.message.pages.length) {
        Chrome.print("▼", ARROW_X, ARROW_Y);
      }
    } else if (this.confirm) {
      this.drawTextBox(this.confirm.pages[this.confirm.page - 1]);
      if (this.confirm.page >= this.confirm.pages.length) {
        this.drawYesNo(this.confirm.choice);
      } else {
        Chrome.print("▼", ARROW_X, ARROW_Y);
      }
    } else {
      this.drawTextBox(null);
    }
    G.setColor(1, 1, 1, 1);
  }
}

export default TradeMenu;
