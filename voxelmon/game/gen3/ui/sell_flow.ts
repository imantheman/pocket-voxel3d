// Port of gen1recomp src/ui/game3/sell_flow.lua (GPLv3 + additional terms; see LICENSE.md).
// src/item_menu.c:1787 Task_ItemContext_Sell, src/tm_case.c:1157 Task_SelectedTMHM_Sell

import { format, rep, tonumber, tostring } from "../../../import/gen3/lua.ts";
import { seq } from "../platform/lt.ts";
import { Window } from "./window.ts";
import { FrlgFont, type Colors } from "./frlg_font.ts";
import { Chrome } from "./chrome.ts";
import { ItemsData } from "../core/items_data.ts";
import { Bag } from "../core/bag.ts";
import { RomText } from "../core/rom_text.ts";
import { Trig } from "../core/trig.ts";
import { Audio } from "../core/audio.ts";
import { Profile } from "../core/profile.ts";
import { Space } from "../core/scripting/space.ts";
import { Adapters } from "../core/scripting/adapters.ts";
import { R as QuestLogRecorder } from "../core/quest_log_recorder.ts";
import { Runtime } from "../core/runtime.ts";
import { G3Lazy } from "../core/lazy_registry.ts";
import { BagMenu } from "./bag_menu.ts";
import { BagChrome } from "./bag_chrome.ts";

// include/constants/songs.h:254
import { SE } from "../core/se_ids.ts";

export interface SellInput { wasPressed(k: string): boolean; isDown?(k: string): boolean }
export interface SellOpts { itemId: any; session?: any; bag?: any; onDone?: (sold: boolean) => void; owned?: unknown }

// Lua: sell_flow.lua:16
function se(id: unknown): void {
  try { Audio.playSe(id); } catch { /* pcall */ }
}

// Lua: sell_flow.lua:20
function is_rse(session: any): boolean {
  return Profile.family(session) === "rse";
}

// Lua: sell_flow.lua:24
function price_of(itemId: any): number {
  const info = ItemsData.info(itemId);
  return Math.max(0, Math.floor(tonumber(info ? info.price : undefined) ?? 0));
}

// src/field_specials.c:1548 ContextNpcGetTextColor, src/menu_helpers.c:237 GetDialogBoxFontId
// Lua: sell_flow.lua:30
function dialog_colors(): Colors {
  // package.loaded["src.core.game3.scripting.space"]
  const Sp = Space as any;
  const ctx = Sp && Sp.vm && Sp.vm.ctx;
  let c: number = FrlgFont.NPC_TEXT_COLOR.NEUTRAL;
  if (ctx) {
    c = Adapters.resolveNpcColor(ctx, Sp.store);
  }
  if (c === FrlgFont.NPC_TEXT_COLOR.MALE) return FrlgFont.COLOR.MALE_NPC;
  return FrlgFont.COLOR.FEMALE_NPC;
}

// src/menu_helpers.c:169 AdjustQuantityAccordingToDPadInput
// Lua: sell_flow.lua:137
function adjust(q: number, qmax: number, input: SellInput): [number, boolean] {
  const before = q;
  if (input.wasPressed("up")) {
    q = q + 1;
    if (q > qmax) q = 1;
  } else if (input.wasPressed("down")) {
    q = q - 1;
    if (q <= 0) q = qmax;
  } else if (input.wasPressed("right")) {
    q = Math.min(qmax, q + 10);
  } else if (input.wasPressed("left")) {
    q = Math.max(1, q - 10);
  }
  return [q, q !== before];
}

// src/menu_indicators.c:270 SpriteCallback_ScrollIndicatorArrow
// Lua: sell_flow.lua:192
function bob(k: number, freq: number): number {
  const v = Trig.sin(((k * freq) % 256 + 256) % 256) * 2 / 256;
  return v < 0 ? Math.ceil(v) : Math.floor(v);
}

// src/money.c:90 PrintMoneyAmount
// Lua: sell_flow.lua:198
function money_string(amount: number): string {
  const digits = tostring(Math.floor(amount));
  return rep(" ", Math.max(0, 6 - digits.length))
    + RomText.plain("gText_PokedollarVar1", { stringVars: seq(digits) });
}

// src/money.c:107 PrintMoneyAmountInMoneyBoxWithBorder
// Lua: sell_flow.lua:205
function draw_money_box(amount: number): void {
  Window.stdFrame(Window.template(1, 1, 8, 3));
  Window.printPx(RomText.plain("gText_TrainerCardMoney"), 8, 8);
  const s = money_string(amount);
  const w = FrlgFont.measure(s, { small: true });
  Window.printPx(s, 8 + 64 - w, 8 + 12, { small: true });
}

export class SellFlow {
  itemId: any;
  name = "";
  session: any;
  bag: any;
  onDone: ((sold: boolean) => void) | undefined;
  qty = 1;
  yesNo = 1;
  k = 0;
  unit = 0;
  colors!: Colors;
  textColors!: Colors;
  text = "";
  state: string | undefined;
  owned = 1;
  sold: boolean | undefined;

  // Lua: sell_flow.lua:42
  static start(opts: SellOpts): SellFlow {
    const self = new SellFlow();
    self.itemId = opts.itemId;
    self.name = ItemsData.displayName(opts.itemId);
    self.session = opts.session;
    self.bag = opts.bag;
    self.onDone = opts.onDone;
    self.qty = 1;
    self.yesNo = 1;
    self.k = 0;
    self.unit = Math.floor(price_of(opts.itemId) / 2);
    self.colors = dialog_colors();
    if (price_of(opts.itemId) === 0) {
      self.state = "cant";
      if (is_rse(self.session)) {
        self.text = RomText.box("gText_CantBuyKeyItem", { stringVars: { 2: self.name } });
      } else {
        self.text = RomText.box("gText_OhNoICantBuyThat", { stringVars: seq(self.name) });
      }
      self.textColors = self.colors;
      return self;
    }
    const owned = Math.max(1, tonumber(opts.owned) ?? 1);
    self.owned = Math.min(self.rseBerry() ? 999 : 99, owned);
    if (owned === 1) {
      self.ask();
    } else {
      self.state = "qty";
      if (is_rse(self.session)) {
        self.text = RomText.box("gText_HowManyToSell", { stringVars: { 2: self.name } });
      } else {
        self.text = RomText.box("gText_HowManyWouldYouLikeToSell", { stringVars: seq(self.name) });
      }
      self.textColors = self.colors;
    }
    return self;
  }

  // Lua: sell_flow.lua:80
  rseBerry(): boolean {
    if (!is_rse(this.session)) return false;
    // pcall(require, "src.ui.game3.bag_menu")
    try {
      return (BagMenu.currentPocket && BagMenu.currentPocket() === "BERRY_POUCH") || false;
    } catch {
      return false;
    }
  }

  // Lua: sell_flow.lua:86
  total(): number {
    return this.unit * this.qty;
  }

  // src/item_menu.c:1840 Task_PrintSaleConfirmationText
  // Lua: sell_flow.lua:91
  ask(): void {
    this.state = "confirm";
    this.yesNo = 1;
    if (is_rse(this.session)) {
      this.text = RomText.box("gText_ICanPayVar1", { stringVars: seq(tostring(this.total())) });
    } else {
      this.text = RomText.box("gText_ICanPayThisMuch_WouldThatBeOkay",
        { stringVars: { 3: tostring(this.total()) } });
    }
    this.textColors = this.colors;
  }

  // src/item_menu.c:1917 Task_SellItem_Yes, :1928 Task_FinalizeSaleToShop
  // Lua: sell_flow.lua:104
  commit(): void {
    const earn = this.total();
    if (is_rse(this.session)) {
      this.text = RomText.box("gText_TurnedOverVar1ForVar2", { stringVars: seq(tostring(earn), this.name) });
    } else {
      this.text = RomText.box("gText_TurnedOverItemsWorthYen",
        { stringVars: { 1: this.name, 3: tostring(earn) } });
    }
    this.textColors = FrlgFont.COLOR.NORMAL;
    this.state = "done";
    se(SE.SE_SHOP);
    if (this.bag && Bag.remove(this.bag, this.itemId, this.qty) && this.session) {
      this.session.money = Math.max(0, Math.floor(tonumber(this.session.money) ?? 0)) + earn;
      const Q = QuestLogRecorder;
      // package.loaded["src.core.game3.runtime"]
      const rt = Runtime;
      Q.event(this.session, "SoldItemsIncludingItem",
        { D0: Q.location(rt ? rt._game : undefined, this.session)[0], D1: this.name, D2: earn });
    }
    this.sold = true;
  }

  // Lua: sell_flow.lua:125
  finish(): void {
    this.state = undefined;
    const cb = this.onDone;
    this.onDone = undefined;
    if (cb) cb(this.sold === true);
  }

  // Lua: sell_flow.lua:132
  active(): boolean {
    return this.state != null;
  }

  // Lua: sell_flow.lua:153
  handleInput(input: SellInput): void {
    this.k = this.k + 1;
    const st = this.state;
    if (st === "cant" || st === "done") {
      if (input.wasPressed("a") || input.wasPressed("b")) {
        se(SE.SE_SELECT);
        this.finish();
      }
    } else if (st === "qty") {
      const [q, changed] = adjust(this.qty, this.owned, input);
      if (changed) {
        this.qty = q;
        se(SE.SE_SELECT);
      } else if (input.wasPressed("a")) {
        se(SE.SE_SELECT);
        this.ask();
      } else if (input.wasPressed("b")) {
        se(SE.SE_SELECT);
        this.finish();
      }
    } else if (st === "confirm") {
      // src/menu_helpers.c:47 Task_CallYesOrNoCallback
      if (input.wasPressed("up") && this.yesNo !== 1) {
        this.yesNo = 1;
        se(SE.SE_SELECT);
      } else if (input.wasPressed("down") && this.yesNo !== 2) {
        this.yesNo = 2;
        se(SE.SE_SELECT);
      } else if (input.wasPressed("a")) {
        se(SE.SE_SELECT);
        if (this.yesNo === 1) this.commit(); else this.finish();
      } else if (input.wasPressed("b")) {
        se(SE.SE_SELECT);
        this.finish();
      }
    }
  }

  // pokeemerald/src/item_menu.c:2120 InitSellHowManyInput, :1201 PrintItemSoldAmount
  // Lua: sell_flow.lua:214
  drawRse(): void {
    const st = this.state;
    // require("src.ui.game3.rse.shop_menu"): an Emerald module with no file;
    // a registered port is looked up in G3Lazy.
    const Shop = G3Lazy["src.ui.game3.rse.shop_menu"];
    if (Shop == null) throw new Error("NOT FAITHFUL: Emerald only (src.ui.game3.rse.shop_menu)");
    if (st !== "cant") {
      Shop.drawMoneyBox(tonumber(this.session ? this.session.money : undefined) ?? 0);
    }
    Window.dialogueFrame();
    const w = Chrome.DLG_W * 8;
    FrlgFont.draw(FrlgFont.wrap(this.text, w), Chrome.DLG_LEFT * 8, Chrome.DLG_TOP * 8 + 1,
      { maxWidth: w, colors: FrlgFont.COLOR.NORMAL });
    if (st === "qty") {
      const q = Shop.WIN.qty;
      Window.stdFrame(q);
      Window.fill(q, 1, 1, 1, 1);
      const digits = this.rseBerry() ? 3 : 2;
      Window.printPx(RomText.plain("gText_xVar1", { stringVars: seq(format("%0" + tostring(digits) + "d", this.qty)) }),
        q.left * 8, q.top * 8 + 1);
      Shop.drawMoneyAmount(null, q, this.total());
    } else if (st === "confirm") {
      const yn = Shop.WIN.yesno;
      Window.stdFrame(yn);
      Window.fill(yn, 1, 1, 1, 1);
      const pitch = Window.optionHeight();
      Window.printPx(RomText.plain("gText_Yes"), yn.left * 8 + 8, yn.top * 8 + 1);
      Window.printPx(RomText.plain("gText_No"), yn.left * 8 + 8, yn.top * 8 + 1 + pitch);
      Window.cursorPx(yn.left * 8, yn.top * 8 + 1 + (this.yesNo - 1) * pitch);
    }
  }

  // Lua: sell_flow.lua:244
  draw(): void {
    const st = this.state;
    if (!st) return;
    if (is_rse(this.session)) return this.drawRse();
    if (st !== "cant") {
      draw_money_box(tonumber(this.session ? this.session.money : undefined) ?? 0);
    }
    // src/item_menu.c:1021 DisplayItemMessageInBag
    Window.dialogueFrame();
    const w = Chrome.DLG_W * 8;
    FrlgFont.draw(FrlgFont.wrap(this.text, w), Chrome.DLG_LEFT * 8, Chrome.DLG_TOP * 8 + 1,
      { maxWidth: w, colors: this.textColors });
    if (st === "qty") {
      // src/bag.c:87 sWindowTemplates[1], src/item_menu.c:1866
      Window.stdFrame(Window.template(17, 9, 12, 4));
      FrlgFont.draw(RomText.plain("gText_TimesStrVar1", { stringVars: seq(format("%02d", this.qty)) }),
        136 + 4, 72 + 10, { small: true, letterSpacing: 1, colors: FrlgFont.COLOR.NORMAL });
      FrlgFont.draw(money_string(this.total()), 136 + 56, 72 + 10, { small: true, colors: FrlgFont.COLOR.NORMAL });
      // src/item_menu.c:781 CreatePocketScrollArrowPair_SellQuantity
      // pcall(require, "src.ui.game3.bag_chrome")
      if (BagChrome && BagChrome.drawArrow) {
        BagChrome.drawArrow("up", 152 - 8, 72 - 8 + bob(this.k, 8));
        BagChrome.drawArrow("down", 152 - 8, 104 - 8 + bob(this.k, -8));
      }
    } else if (st === "confirm") {
      // src/bag.c:299 BagCreateYesNoMenuTopRight, src/menu.c:531 CreateYesNoMenu
      Window.stdFrame(Window.template(21, 9, 6, 4));
      const x = 21 * 8, y = 9 * 8 + 2;
      FrlgFont.draw(RomText.plain("gText_Yes"), x + 8, y, { colors: FrlgFont.COLOR.NORMAL });
      FrlgFont.draw(RomText.plain("gText_No"), x + 8, y + FrlgFont.LINE_PITCH, { colors: FrlgFont.COLOR.NORMAL });
      Window.cursorPx(x, y + (this.yesNo === 2 ? FrlgFont.LINE_PITCH : 0));
    }
  }
}

export default SellFlow;
