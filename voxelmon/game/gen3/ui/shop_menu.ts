// Port of gen1recomp src/ui/game3/shop_menu.lua (GPLv3 + additional terms; see LICENSE.md).
// FRLG Poké Mart (shop.c / buy_menu_helpers.c): BUY / SELL / SEE YA!
// 1:1 pret GBA buy menu background, money box, stock list, in-bag popup, item icon, and description.

import { format, mod, tonumber, tostring, truthy } from "../../../import/gen3/lua.ts";
import { G } from "../platform/graphics.ts";
import { gmatch, matchAll } from "../platform/lpattern.ts";
import { ipairs, len, seq, type LuaTable } from "../platform/lt.ts";
import { NotPortedError } from "../notported.ts";
import { Stack } from "./stack.ts";
import { Window } from "./window.ts";
import { FrlgFont } from "./frlg_font.ts";
import { MoneyBox } from "./money_box.ts";
import { Chrome } from "./chrome.ts";
import { Fade } from "./fade.ts";
import { BagMenu } from "./bag_menu.ts";
import { BagChrome } from "./bag_chrome.ts";
import { ItemsData } from "../core/items_data.ts";
import { Bag } from "../core/bag.ts";
import { RomText } from "../core/rom_text.ts";
import { Profile } from "../core/profile.ts";
import { Marts } from "../core/marts.ts";
import { Audio } from "../core/audio.ts";
import { SE } from "../core/se_ids.ts";
import { R as QuestLogRecorder } from "../core/quest_log_recorder.ts";
import { Runtime } from "../core/runtime.ts";
import { G3Lazy } from "../core/lazy_registry.ts";

export interface ShopInput { wasPressed(k: string): boolean; isDown?(k: string): boolean }
export interface ShopRow { id: any; name: string; price: number; description: string }
export interface ShopShowOpts {
  items?: LuaTable; session?: any; onClose?: () => void; mart?: any; martType?: any;
}

const VISIBLE = 6;

const UP = "\xE2\x96\xB2"; // ▲
const DOWN = "\xE2\x96\xBC"; // ▼
const TIMES = "\xC3\x97"; // ×

// Lua: shop_menu.lua:29
function rse_shop(session: any): any {
  if (Profile.family(session) !== "rse") return undefined;
  // require("src.ui.game3.rse.shop_menu"): an Emerald module with no file; a
  // registered port is looked up in G3Lazy.
  const Rse = G3Lazy["src.ui.game3.rse.shop_menu"];
  if (Rse == null) throw new Error("NOT FAITHFUL: Emerald only (src.ui.game3.rse.shop_menu)");
  return Rse;
}

// Lua: shop_menu.lua:34
function mart_entry(items: unknown): any {
  // package.loaded["src.core.game3.marts"]
  const byKey = Marts ? Marts._byKey : undefined;
  if (byKey) {
    for (const e of byKey.values()) {
      if (e.items === items) return e;
    }
  }
  return undefined;
}

// Lua: shop_menu.lua:42
function se(id: unknown): void {
  try { Audio.playSe(id); } catch { /* pcall */ }
}

// Lua: shop_menu.lua:46
function money_of(session: any): number {
  return Math.max(0, Math.floor(tonumber(session ? session.money : undefined) ?? 0));
}

// Lua: shop_menu.lua:50
function set_money(session: any, amount: unknown): void {
  if (!session) return;
  session.money = Math.max(0, Math.floor(tonumber(amount) ?? 0));
}

// Lua: shop_menu.lua:55
function queue_shop_se(text: unknown, money: unknown): void {
  let n = 0;
  for (const _ of gmatch(tostring(text ?? ""), "[^\r\n]")) n = n + 1;
  ShopMenu._shopSe = { frames: n, money }; // pokefirered/src/menu_helpers.c:29
}

// Lua: shop_menu.lua:61
function tick_shop_se(force: boolean): boolean {
  const p = ShopMenu._shopSe;
  if (!p) return false;
  p.frames = p.frames - 1;
  if (!force && p.frames > 0) return false;
  ShopMenu._shopSe = undefined;
  MoneyBox.update(p.money);
  se(SE.SE_SHOP);
  return true;
}

// Lua: shop_menu.lua:72
function buy_price(itemId: any): number {
  const info = ItemsData.info(itemId);
  return Math.max(0, Math.floor(tonumber(info ? info.price : undefined) ?? 0));
}

// Lua: shop_menu.lua:78
function stock_rows(items: LuaTable | undefined): (ShopRow | null)[] {
  const rows: (ShopRow | null)[] = seq();
  for (const [, id] of ipairs(items ?? seq())) {
    const name = ItemsData.displayName(id);
    const price = buy_price(id);
    const desc = ItemsData.description(id);
    rows[len(rows) + 1] = { id, name, price, description: desc };
  }
  return rows;
}

// Lua: shop_menu.lua:90
const rows_cache: { key: string | false; rows: (ShopRow | null)[] | undefined } = { key: false, rows: undefined };
// Lua: shop_menu.lua:91
function cached_rows(kind: string, src: LuaTable | undefined): (ShopRow | null)[] {
  // Lua's tostring(src) is the table's address; a per-table id stands in.
  const key = kind + "|" + table_id(src) + "|" + tostring(ShopMenu._rowsGen ?? 0);
  if (rows_cache.key === key && rows_cache.rows) return rows_cache.rows;
  const rows = stock_rows(src);
  rows_cache.key = key;
  rows_cache.rows = rows;
  return rows;
}

const tableIds = new WeakMap<object, number>();
let nextTableId = 1;
function table_id(t: unknown): string {
  if (t == null || typeof t !== "object") return tostring(t);
  let id = tableIds.get(t);
  if (id == null) {
    id = nextTableId++;
    tableIds.set(t, id);
  }
  return "table: " + tostring(id);
}

// Lua: shop_menu.lua:166
function do_fade_transition(onDark?: () => void, onDone?: () => void): void {
  // pcall(require, "src.ui.game3.fade") ... and love and love.graphics
  if (Fade && Fade.begin && G) {
    ShopMenu._fading = true;
    Fade.begin(Fade.MODE.TO_BLACK, 1, () => {
      if (onDark) onDark();
      Fade.begin(Fade.MODE.FROM_BLACK, 1, () => {
        ShopMenu._fading = false;
        if (onDone) onDone();
      });
    });
  } else {
    if (onDark) onDark();
    if (onDone) onDone();
  }
}

// Lua: shop_menu.lua:183
function clamp_buy_cursor(): (ShopRow | null)[] {
  const rows = cached_rows("stock", ShopMenu._items);
  const total = len(rows) + 1; // including CANCEL
  if (ShopMenu.cursor > total) ShopMenu.cursor = total;
  if (ShopMenu.cursor < 1) ShopMenu.cursor = 1;
  if (ShopMenu.cursor <= ShopMenu.scroll) {
    ShopMenu.scroll = ShopMenu.cursor - 1;
  }
  if (ShopMenu.cursor > ShopMenu.scroll + VISIBLE) {
    ShopMenu.scroll = ShopMenu.cursor - VISIBLE;
  }
  if (ShopMenu.scroll < 0) ShopMenu.scroll = 0;
  return rows;
}

// Lua: shop_menu.lua:199
function begin_buy_qty(item: ShopRow | null | undefined): void {
  if (!item) return;
  const session = ShopMenu._session;
  const curMoney = money_of(session);
  if (item.price > curMoney) {
    ShopMenu._status = RomText.box("gText_YouDontHaveMoney");
    ShopMenu.mode = "buy_msg";
    ShopMenu._pending = undefined;
    se(5); // pokefirered/src/shop.c:888
    return;
  }
  ShopMenu._pending = item;
  ShopMenu.qty = 1;
  ShopMenu.mode = "buy_qty";
  // src/shop.c:902
  ShopMenu._status = RomText.box("gText_Var1CertainlyHowMany", { stringVars: seq(item.name) });
  se(5);
}

// Lua: shop_menu.lua:219
function commit_buy(): void {
  const p = ShopMenu._pending;
  const session = ShopMenu._session;
  if (!p || !session) return;
  ShopMenu._rowsGen = (ShopMenu._rowsGen ?? 0) + 1;
  const cost = (p.price ?? 0) * ShopMenu.qty;
  const curMoney = money_of(session);
  if (cost > curMoney) {
    ShopMenu._status = RomText.box("gText_YouDontHaveMoney");
    ShopMenu.mode = "buy_msg";
    ShopMenu._pending = undefined;
    return;
  }
  let bag = session.bag;
  if (!bag) {
    session.bag = Bag.new();
    bag = session.bag;
  }
  // src/shop.c:991
  if (!Bag.canAdd(bag, p.id, ShopMenu.qty) || !Bag.add(bag, p.id, ShopMenu.qty)[0]) {
    ShopMenu._status = RomText.box("gText_NoMoreRoomForThis");
    ShopMenu.mode = "buy_msg";
    ShopMenu._pending = undefined;
    return;
  }
  set_money(session, curMoney - cost);
  const Q = QuestLogRecorder;
  // package.loaded["src.core.game3.runtime"]
  const rt = Runtime;
  Q.event(session, ShopMenu.qty === 1 ? "BoughtItem" : "BoughtItemsIncludingItem",
    { D0: Q.location(rt ? rt._game : undefined, session)[0], D1: ItemsData.displayName(p.id), D2: cost });

  // src/shop.c:985
  ShopMenu._status = RomText.box("gText_HereYouGoThankYou");

  queue_shop_se(ShopMenu._status, session.money); // pokefirered/src/shop.c:999
  ShopMenu.mode = "buy_msg";
  ShopMenu._pending = undefined;
}

// src/shop.c:281 Task_HandleShopMenuSell, :288 CB2_GoToSellMenu
// Lua: shop_menu.lua:260
function open_sell_bag(): void {
  // pcall(require, "src.ui.game3.fade")
  const okF = true;
  ShopMenu._fading = true;
  const go = (): void => {
    ShopMenu._fading = false;
    ShopMenu.mode = "sell";
    ShopMenu._status = undefined;
    if (okF && Fade && Fade.clear) Fade.clear();
    const session = ShopMenu._session;
    BagMenu.show(session ? session.bag : undefined, {
      session,
      location: "shop",
      // src/shop.c:325 Task_ReturnToShopMenu
      onClose: () => {
        ShopMenu.mode = "root";
        ShopMenu.cursor = 1;
        ShopMenu._status = RomText.box("gText_AnythingElseICanHelp");
      },
    });
  };
  if (okF && Fade && Fade.begin) {
    Fade.begin(Fade.MODE.TO_BLACK, 1, go);
  } else {
    go();
  }
}

/** The status text split into lines ([^\r\n]+), as a sequence. */
function status_lines(s: unknown): (string | null)[] {
  const lines: (string | null)[] = seq();
  for (const [line] of gmatch(tostring(s), "[^\r\n]+")) {
    lines[len(lines) + 1] = line as string;
  }
  return lines;
}

export const ShopMenu = {
  isMenu: true,

  open: false,
  mode: "root",
  cursor: 1,
  scroll: 0,
  qty: 1,
  yesNoCursor: 1,
  // src/shop.c:140 sShopMenuActions_BuySellQuit
  ROOT: seq({ id: "buy" }, { id: "sell" }, { id: "quit" }) as ({ id: string } | null)[],

  _pending: undefined as ShopRow | undefined,
  _shopSe: undefined as { frames: number; money: unknown } | undefined,
  _fading: false,
  _items: undefined as LuaTable | undefined,
  _rowsGen: undefined as number | undefined,
  _session: undefined as any,
  _onClose: undefined as (() => void) | undefined,
  _rse: undefined as any,
  _status: undefined as string | undefined,

  // Lua: shop_menu.lua:100
  show(opts?: ShopShowOpts): void {
    opts = opts || {};
    ShopMenu.open = true;
    ShopMenu.mode = "root";
    ShopMenu.cursor = 1;
    ShopMenu.scroll = 0;
    ShopMenu.qty = 1;
    ShopMenu.yesNoCursor = 1;
    ShopMenu._pending = undefined;
    ShopMenu._shopSe = undefined;
    ShopMenu._fading = false;
    ShopMenu._items = opts.items || seq();
    ShopMenu._rowsGen = (ShopMenu._rowsGen ?? 0) + 1;
    ShopMenu._session = opts.session;
    ShopMenu._onClose = opts.onClose;
    ShopMenu._rse = rse_shop(opts.session);
    // data/text/poke_mart.inc:1
    if (!ShopMenu._rse) ShopMenu._status = RomText.box("Text_MayIHelpYou");
    // pcall(require, "src.ui.game3.money_box")
    if (MoneyBox && MoneyBox.hide) MoneyBox.hide();
    // pcall(require, "src.ui.game3.chrome")
    if (Chrome && Chrome.invalidate) Chrome.invalidate();
    if (ShopMenu._rse) {
      ShopMenu._rse.show(ShopMenu, { mart: opts.mart || mart_entry(opts.items), martType: opts.martType });
    }
    Stack.push("shop", ShopMenu as unknown as LuaTable, { hideBelow: false });
    // pokefirered/src/shop.c:205
  },

  // Lua: shop_menu.lua:129
  close(): void {
    ShopMenu.open = false;
    Stack.pop("shop");
    if (MoneyBox && MoneyBox.hide) MoneyBox.hide();
    const cb = ShopMenu._onClose;
    ShopMenu._onClose = undefined;
    if (cb) cb();
  },

  // pokefirered/src/main.c:480
  // Lua: shop_menu.lua:140
  reset(): void {
    ShopMenu.open = false;
    ShopMenu._fading = false;
    ShopMenu.mode = "root";
    ShopMenu._onClose = undefined;
    ShopMenu._pending = undefined;
    ShopMenu._shopSe = undefined;
    ShopMenu._session = undefined;
    ShopMenu._rse = undefined;
  },

  // Lua: shop_menu.lua:151
  isOpen(): boolean {
    return ShopMenu.open;
  },

  // Lua: shop_menu.lua:155
  isShopCamera(): boolean {
    return ShopMenu.open && ShopMenu.mode !== "root";
  },

  // Lua: shop_menu.lua:159
  shopCameraOffset(): any {
    if (ShopMenu._rse && ShopMenu.isShopCamera()) return ShopMenu._rse.CAMERA_OFFSET;
    return undefined;
  },

  // Lua: shop_menu.lua:287
  handleInput(input: ShopInput): any {
    if (!ShopMenu.open || ShopMenu._fading) return;
    if (ShopMenu._rse) return ShopMenu._rse.handleInput(ShopMenu, input);

    if (ShopMenu.mode === "buy_msg") {
      if (input.wasPressed("a") || input.wasPressed("b")) {
        ShopMenu.mode = "buy";
        ShopMenu._status = undefined;
        clamp_buy_cursor();
        if (!tick_shop_se(true)) se(5); // pokefirered/src/shop.c:1008
      } else {
        tick_shop_se(false);
      }
      return;
    }

    if (ShopMenu.mode === "buy_confirm") {
      if (input.wasPressed("up") || input.wasPressed("down")) {
        ShopMenu.yesNoCursor = (ShopMenu.yesNoCursor === 1) ? 2 : 1;
        se(5);
      } else if (input.wasPressed("a")) {
        se(5); // pokefirered/src/menu_helpers.c:52
        if (ShopMenu.yesNoCursor === 1) {
          commit_buy();
        } else {
          ShopMenu.mode = "buy";
          ShopMenu._pending = undefined;
          ShopMenu._status = undefined;
        }
      } else if (input.wasPressed("b")) {
        ShopMenu.mode = "buy";
        ShopMenu._pending = undefined;
        ShopMenu._status = undefined;
        se(5); // pokefirered/src/menu_helpers.c:57
      }
      return;
    }

    if (ShopMenu.mode === "buy_qty") {
      const p = ShopMenu._pending;
      const session = ShopMenu._session;
      const unit = p ? p.price : 0;
      const money = money_of(session);
      const maxQ = Math.max(1, Math.min(99, Math.floor(money / Math.max(1, unit))));

      if (input.wasPressed("up")) {
        ShopMenu.qty = Math.min(maxQ, ShopMenu.qty + 1);
        se(5);
      } else if (input.wasPressed("down")) {
        ShopMenu.qty = Math.max(1, ShopMenu.qty - 1);
        se(5);
      } else if (input.wasPressed("right")) {
        ShopMenu.qty = Math.min(maxQ, ShopMenu.qty + 10);
        se(5);
      } else if (input.wasPressed("left")) {
        ShopMenu.qty = Math.max(1, ShopMenu.qty - 10);
        se(5);
      } else if (input.wasPressed("a")) {
        ShopMenu.mode = "buy_confirm";
        ShopMenu.yesNoCursor = 1;
        const totalCost = unit * ShopMenu.qty;
        // src/shop.c:958
        ShopMenu._status = RomText.box("gText_Var1AndYouWantedVar2",
          { stringVars: seq(p!.name, tostring(ShopMenu.qty), tostring(totalCost)) });
        se(5);
      } else if (input.wasPressed("b")) {
        ShopMenu.mode = "buy";
        ShopMenu._pending = undefined;
        ShopMenu._status = undefined;
        se(5); // pokefirered/src/shop.c:962
      }
      return;
    }

    if (ShopMenu.mode === "buy") {
      const rows = cached_rows("stock", ShopMenu._items);
      const total = len(rows) + 1;

      if (input.wasPressed("up")) {
        ShopMenu.cursor = mod(ShopMenu.cursor - 2, total) + 1;
        clamp_buy_cursor();
        se(5);
      } else if (input.wasPressed("down")) {
        ShopMenu.cursor = mod(ShopMenu.cursor, total) + 1;
        clamp_buy_cursor();
        se(5);
      } else if (input.wasPressed("a")) {
        if (ShopMenu.cursor > len(rows)) {
          se(5); // pokefirered/src/shop.c:884
          do_fade_transition(() => {
            ShopMenu.mode = "root";
            ShopMenu.cursor = 1;
            ShopMenu._status = RomText.plain("gText_AnythingElseICanHelp");
          });
        } else {
          begin_buy_qty(rows[ShopMenu.cursor]);
        }
      } else if (input.wasPressed("b")) {
        se(5); // pokefirered/src/shop.c:884
        do_fade_transition(() => {
          ShopMenu.mode = "root";
          ShopMenu.cursor = 1;
          ShopMenu._status = RomText.plain("gText_AnythingElseICanHelp");
        });
      }
      return;
    }

    // root mode
    if (ShopMenu.mode === "root") {
      if (input.wasPressed("up")) {
        ShopMenu.cursor = mod(ShopMenu.cursor - 2, len(ShopMenu.ROOT)) + 1;
        se(5);
      } else if (input.wasPressed("down")) {
        ShopMenu.cursor = mod(ShopMenu.cursor, len(ShopMenu.ROOT)) + 1;
        se(5);
      } else if (input.wasPressed("a")) {
        const e = ShopMenu.ROOT[ShopMenu.cursor];
        if (!e || e.id === "quit") {
          se(5); // pokefirered/src/menu.c:376
          ShopMenu.close();
          return;
        } else if (e.id === "buy") {
          se(5);
          do_fade_transition(() => {
            ShopMenu.mode = "buy";
            ShopMenu.cursor = 1;
            ShopMenu.scroll = 0;
            ShopMenu._status = undefined;
            ShopMenu._pending = undefined;
          });
        } else if (e.id === "sell") {
          se(5);
          open_sell_bag();
        }
      } else if (input.wasPressed("b") || input.wasPressed("start")) {
        se(5); // pokefirered/src/shop.c:265
        ShopMenu.close();
      }
    }
  },

  // Lua: shop_menu.lua:433
  draw(): any {
    if (!ShopMenu.open) return;
    if (ShopMenu._rse) return ShopMenu._rse.draw(ShopMenu);
    const session = ShopMenu._session;

    // pcall(require, "src.ui.game3.shop_chrome"): no such module here unless
    // a port registers it in G3Lazy.
    const ShopChrome = G3Lazy["src.ui.game3.shop_chrome"];
    let shopChrome = false;
    if (ShopChrome && ShopChrome.ready) {
      try { shopChrome = truthy(ShopChrome.ready()); } catch (e) {
        if (!(e instanceof NotPortedError)) throw e;
      }
    }
    // pcall(require, "src.ui.game3.bag_chrome")
    const okBC = true;

    if (ShopMenu.mode === "root") {
      // Top-left Menu Box (sShopMenuWindowTemplate: tile 2, 1, 12, 6)
      Window.stdFrame(Window.template(2, 1, 12, 6));
      for (const [i] of ipairs(ShopMenu.ROOT)) {
        const yPx = 10 + (i - 1) * 16;
        if (i === ShopMenu.cursor) Window.cursorPx(20, yPx);
        Window.printPx(RomText.at("sShopMenuActions_BuySellQuit", i - 1), 28, yPx);
      }

      // Bottom Clerk Dialogue Window
      Window.dialogueFrame();
      if (ShopMenu._status) {
        const lines = status_lines(ShopMenu._status);
        if (len(lines) > 0) Window.print(lines[1], 2, 15, { clipTiles: 26 });
        if (len(lines) > 1) Window.print(lines[2], 2, 17, { clipTiles: 26 });
      }
      return;
    }

    if (ShopMenu.mode === "sell") return;
    const isInteractiveQty = (ShopMenu.mode === "buy_qty" || ShopMenu.mode === "buy_confirm");
    const isSpeech = isInteractiveQty || ShopMenu.mode === "buy_msg";

    if (shopChrome) {
      ShopChrome.drawBg(0, 0);
    }

    // Top-left Money Window (Window 0: tile 1, 1, 8, 3 with border)
    Window.stdFrame(Window.template(1, 1, 8, 3));
    // src/money.c:110, :86
    Window.printPx(RomText.plain("gText_TrainerCardMoney"), 8, 8);
    const moneyStr = RomText.plain("gText_PokedollarVar1", { stringVars: seq(tostring(money_of(session))) });
    const mw = (FrlgFont.measure ? FrlgFont.measure(moneyStr, { small: true }) : undefined) || (6 * moneyStr.length);
    Window.printPx(moneyStr, Math.max(8, 72 - mw), 20, { small: true });

    // Right Stock / Bag List
    const rows = cached_rows("stock", ShopMenu._items);
    const total = len(rows) + 1;

    if (ShopMenu.scroll > 0) {
      Window.print(UP, 26, 1);
    }
    if (ShopMenu.scroll + VISIBLE < total) {
      Window.print(DOWN, 26, 12);
    }

    let selId: any = undefined;
    let selDesc: string | undefined = undefined;

    for (let vis = 1; vis <= VISIBLE; vis++) {
      const idx = ShopMenu.scroll + vis;
      if (idx > total) break;
      const y = 1 + (vis - 1) * 2;
      if (idx === ShopMenu.cursor) {
        Window.cursor(11, y);
      }
      if (idx > len(rows)) {
        // src/shop.c:525, :577
        Window.print(RomText.plain("gFameCheckerText_Cancel"), 12, y);
        if (idx === ShopMenu.cursor) selDesc = RomText.plain("gText_QuitShopping");
      } else {
        const r = rows[idx]!;
        if (idx === ShopMenu.cursor) {
          selId = r.id;
          selDesc = r.description;
        }
        Window.print(r.name, 12, y, { clipTiles: 9 });
        // src/shop.c:611
        const pStr = RomText.plain("gText_PokedollarVar1", { stringVars: seq(tostring(r.price)) });
        const pw = (FrlgFont.measure ? FrlgFont.measure(pStr) : undefined) || (8 * pStr.length);
        Window.printPx(pStr, Math.max(168, 222 - pw), y * 8);
      }
    }

    const activeId = (ShopMenu._pending && ShopMenu._pending.id) || selId;

    // Bottom Description Bar (Window 5) vs Speech Bubble (Window 2)
    if (isSpeech && ShopMenu._status) {
      // When clerk is speaking (e.g. quantity selection or confirmation), draw dialogue bubble
      Window.dialogueFrame();
      const lines = status_lines(ShopMenu._status);
      if (len(lines) > 0) Window.print(lines[1], 2, 15, { clipTiles: 26 });
      if (len(lines) > 1) Window.print(lines[2], 2, 17, { clipTiles: 26 });
    } else {
      // Standard browsing mode: 24×24 item icon inside white square + 2-3 line description
      if (okBC && BagChrome && BagChrome.drawItemIcon && activeId) {
        BagChrome.drawItemIcon(activeId, 8, 124);
      }
      if (selDesc) {
        const lines = status_lines(selDesc);
        const whiteColor = FrlgFont.COLOR.WHITE;
        if (len(lines) > 0) Window.printPx(lines[1], 40, 117, { maxWidth: 192, colors: whiteColor });
        if (len(lines) > 1) Window.printPx(lines[2], 40, 131, { maxWidth: 192, colors: whiteColor });
        if (len(lines) > 2) Window.printPx(lines[3], 40, 145, { maxWidth: 192, colors: whiteColor });
      }
    }

    // In-Bag Overlay Box (Window 1: tile 1, 11, 13, 2) — ONLY visible during quantity/purchase dialogue
    if (isInteractiveQty && activeId) {
      let inBagCount = 0;
      if (session && session.bag) {
        inBagCount = Bag.get(session.bag, activeId);
      }
      Window.stdFrame(Window.template(1, 11, 13, 2));
      // src/shop.c:917
      const inBag = RomText.plain("gText_InBagVar1", { stringVars: seq("\x01") });
      const caps = matchAll(inBag, "^(.-)%s*\x01(.*)$");
      const label = caps ? caps[0] : undefined;
      let countStr = caps ? caps[1] as string : undefined;
      Window.printPx(label, 12, 89);
      countStr = tostring(inBagCount) + countStr;
      const cw = (FrlgFont.measure ? FrlgFont.measure(countStr, { small: true }) : undefined) || (6 * countStr.length);
      Window.printPx(countStr, Math.max(64, 106 - cw), 89, { small: true });
    }

    // Quantity Selection Pop-up (Window 3: tile 17, 9, 12, 4)
    if ((ShopMenu.mode === "buy_qty") && ShopMenu._pending) {
      Window.stdFrame(Window.template(17, 9, 12, 4));
      const unit = ShopMenu._pending.price ?? 0;
      // Red scroll arrows at (152, 68) and (152, 100)
      G.setColor(220 / 255, 60 / 255, 30 / 255, 1);
      Window.printPx(UP, 152, 68);
      Window.printPx(DOWN, 152, 100);
      G.setColor(1, 1, 1, 1);

      const qtyStr = format(TIMES + "%02d", ShopMenu.qty);
      Window.printPx(qtyStr, 138, 82, { small: true });
      const totalStr = RomText.plain("gText_PokedollarVar1", { stringVars: seq(tostring(unit * ShopMenu.qty)) });
      const tw = (FrlgFont.measure ? FrlgFont.measure(totalStr, { small: true }) : undefined) || (6 * totalStr.length);
      Window.printPx(totalStr, Math.max(170, 228 - tw), 82, { small: true });
    }

    // YES / NO Confirmation Pop-up (Standard GBA tile 21, 9, 6, 4)
    if (ShopMenu.mode === "buy_confirm") {
      Window.stdFrame(Window.template(21, 9, 6, 4));
      Window.printPx(RomText.plain("gText_Yes"), 184, 76);
      Window.printPx(RomText.plain("gText_No"), 184, 92);
      Window.cursorPx(174, ShopMenu.yesNoCursor === 2 ? 92 : 76);
    }
  },
};

export default ShopMenu;
