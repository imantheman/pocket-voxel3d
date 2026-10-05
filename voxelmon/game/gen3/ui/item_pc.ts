// Port of gen1recomp src/ui/game3/item_pc.lua (GPLv3 + additional terms; see LICENSE.md).
// The player's PC item storage list (pokefirered src/item_pc.c).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { format, mod, tostring } from "../../../import/gen3/lua.ts";
import { Extract } from "../../../import/gen3/extract_island1.ts";
import { G } from "../platform/graphics.ts";
import { newImageData, type Image } from "../platform/image.ts";
import { insert, ipairs, len, remove, seq, type LuaTable } from "../platform/lt.ts";
import { Stack } from "./stack.ts";
import { Window } from "./window.ts";
import { FrlgFont, type Colors } from "./frlg_font.ts";
import { ItemsData } from "../core/items_data.ts";
import { Bag } from "../core/bag.ts";
import { Storage } from "../core/storage.ts";
import { RomText } from "../core/rom_text.ts";
import { Trig } from "../core/trig.ts";
// include/constants/songs.h:6
import { SE } from "../core/se_ids.ts";
import { Audio } from "../core/audio.ts";
import { Dataset } from "../core/dataset.ts";
import { R as QuestLogRecorder } from "../core/quest_log_recorder.ts";
import { PartyMenu } from "./party_menu.ts";
import { BagChrome } from "./bag_chrome.ts";
import { Pokemon } from "../core/pokemon.ts";
import { Chrome } from "./chrome.ts";

// src/item_pc.c:733 ItemPc_CountPcItems
const MAX_SHOWED = 6;
// src/list_menu.c:305
const ROW_H = 16;
// src/item_pc.c:131 sWindowTemplates[0]
const LIST_X = 7 * 8, LIST_Y = 1 * 8;
const UP_TEXT_Y = 2;
const ITEM_X = 9;
const CURSOR_X = 1;
const QTY_X = 110;

// src/item_pc.c:124 sTextColors
// Lua: item_pc.lua:32. Built on first use: inside the ES import cycle
// FrlgFont may not be initialised yet when this module loads.
let COLORS_T: Record<number, Colors> | undefined;
function COLORS(): Record<number, Colors> {
  if (!COLORS_T) {
    COLORS_T = {
      0: { fg: FrlgFont.STDPAL[1], shadow: FrlgFont.STDPAL[2], bg: FrlgFont.STDPAL[0] },
      1: FrlgFont.COLOR.NORMAL,
      2: { fg: FrlgFont.STDPAL[3], shadow: FrlgFont.STDPAL[2], bg: FrlgFont.STDPAL[0] },
      3: { fg: FrlgFont.STDPAL[10], shadow: FrlgFont.STDPAL[2], bg: FrlgFont.STDPAL[0] },
    };
  }
  return COLORS_T;
}

interface Fx { on: boolean; state: number; l: number; r: number; t: number; b: number; white?: boolean; black?: boolean; cb?: () => void }

// Lua: item_pc.lua:329
const SUBMENU = seq(
  { key: "gText_Withdraw", run: "withdraw" },
  { key: "gOtherText_Give", run: "give" },
  { key: "gFameCheckerText_Cancel", run: "cancel" },
);

export const ItemPc = {
  isMenu: true,

  open: false,
  mode: "list",
  scroll: 0,
  row: 0,

  k: 0,
  qty: 1,
  subCursor: 1,
  moveOrig: null as number | null,
  resultText: null as string | null,
  msgText: null as string | null,
  _session: null as any,
  _onClose: null as (() => void) | null,
  _images: null as Record<string, Image> | null,
  _fx: null as Fx | null,
  _pending: null as { pos: number; qty: number } | null,
  _heldKey: undefined as string | undefined,
  _heldFrames: undefined as number | undefined,

  // Lua: item_pc.lua:203
  isOpen(): boolean {
    return ItemPc.open;
  },

  // src/item_pc.c:218 ItemPc_Init
  // Lua: item_pc.lua:208
  show(opts?: any): void {
    opts = opts ?? {};
    ItemPc.open = true;
    ItemPc._session = opts.session;
    ItemPc._onClose = opts.onClose;
    if (!opts.keepPosition) {
      ItemPc.scroll = 0; ItemPc.row = 0;
    }
    ItemPc.mode = "list";
    ItemPc.moveOrig = null;
    ItemPc.k = 0;
    set_cursor_position();
    set_scroll_position();
    ItemPc._fx = fx_on();
    se(SE.SE_PC_LOGIN);
    Stack.push("item_pc", ItemPc, { hideBelow: true, fullscreen: true });
  },

  // Lua: item_pc.lua:359
  handleInput(input: any): void {
    if (!ItemPc.open) return;
    ItemPc.k = ItemPc.k + 1;
    const fx = ItemPc._fx;
    if (fx) {
      if (step_fx(fx)) {
        ItemPc._fx = null;
        if (fx.cb) fx.cb();
      }
      return;
    }
    track_held(input);
    const mode = ItemPc.mode;

    if (mode === "list") {
      // src/item_pc.c:707 Task_ItemPcMain
      if (input.wasPressed("select")) {
        if (cursor_pos() !== len(items())) {
          se(SE.SE_SELECT);
          begin_move();
        }
        return;
      }
      if (input.wasPressed("a")) {
        se(SE.SE_SELECT);
        if (cursor_pos() === len(items())) {
          turn_off();
        } else {
          ItemPc.mode = "submenu";
          ItemPc.subCursor = 1;
        }
      } else if (input.wasPressed("b")) {
        se(SE.SE_SELECT);
        turn_off();
      } else if (held_repeat(input, "up")) {
        if (move_cursor(false)) se(SE.SE_SELECT);
      } else if (held_repeat(input, "down")) {
        if (move_cursor(true)) se(SE.SE_SELECT);
      }
    } else if (mode === "move") {
      // src/item_pc.c:782 Task_ItemPcMoveItemModeRun
      if (held_repeat(input, "up")) {
        if (move_cursor(false)) se(SE.SE_SELECT);
      } else if (held_repeat(input, "down")) {
        if (move_cursor(true)) se(SE.SE_SELECT);
      }
      if (input.wasPressed("a") || input.wasPressed("select")) {
        se(SE.SE_SELECT);
        end_move(true);
      } else if (input.wasPressed("b")) {
        se(SE.SE_SELECT);
        end_move(false);
      }
    } else if (mode === "submenu") {
      // src/menu.c:614 Menu_ProcessInputNoWrapAround
      if (input.wasPressed("up")) {
        if (ItemPc.subCursor > 1) { ItemPc.subCursor = ItemPc.subCursor - 1; se(SE.SE_SELECT); }
      } else if (input.wasPressed("down")) {
        if (ItemPc.subCursor < len(SUBMENU)) { ItemPc.subCursor = ItemPc.subCursor + 1; se(SE.SE_SELECT); }
      } else if (input.wasPressed("a")) {
        se(SE.SE_SELECT);
        const run = SUBMENU[ItemPc.subCursor]!.run;
        if (run === "withdraw") {
          // src/item_pc.c:853 Task_ItemPcWithdraw
          ItemPc.qty = 1;
          if (selected_entry().qty === 1) {
            do_withdraw();
          } else {
            ItemPc.mode = "qty";
          }
        } else if (run === "give") {
          give();
        } else {
          return_from_submenu();
        }
      } else if (input.wasPressed("b")) {
        se(SE.SE_SELECT);
        return_from_submenu();
      }
    } else if (mode === "qty") {
      // src/item_pc.c:975 Task_ItemPcHandleWithdrawMultiple, src/menu_helpers.c:169
      const qmax = selected_entry().qty;
      let q = ItemPc.qty;
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
      if (q !== ItemPc.qty) {
        ItemPc.qty = q;
        se(SE.SE_SELECT);
      } else if (input.wasPressed("a")) {
        se(SE.SE_SELECT);
        do_withdraw();
      } else if (input.wasPressed("b")) {
        se(SE.SE_SELECT);
        return_from_submenu();
      }
    } else if (mode === "result") {
      // src/item_pc.c:894 Task_ItemPcWaitButtonAndFinishWithdrawMultiple
      if (input.wasPressed("a") || input.wasPressed("b")) {
        se(SE.SE_SELECT);
        const p = ItemPc._pending;
        ItemPc._pending = null;
        if (p) {
          // src/item_pc.c:924 RemovePCItem, ItemPcCompaction
          const list = items();
          list[p.pos].qty = list[p.pos].qty - p.qty;
          if (list[p.pos].qty <= 0) remove(list, p.pos);
        }
        clean_up_withdraw();
      }
    } else if (mode === "msg") {
      // src/item_pc.c:1037 gTask_ItemPcWaitButtonAndExitSubmenu
      if (input.wasPressed("a")) {
        se(SE.SE_SELECT);
        ItemPc.msgText = null;
        return_from_submenu();
      }
    }
  },

  // Lua: item_pc.lua:508
  draw(): void {
    if (!ItemPc.open) return;
    const mode = ItemPc.mode;
    const sub = mode !== "list" && mode !== "move";
    const C = COLORS();
    G.setColor(1, 1, 1, 1);
    G.draw(load_bg(sub ? "bg_submenu" : "bg"), 0, 0);

    // src/item_pc.c:578 ItemPc_PrintWithdrawItem
    FrlgFont.draw(RomText.plain("gText_WithdrawItem"), 8, 8 + 1,
      { small: true, colors: C[0], linePitch: 13 + 1 });

    const list = items();
    const n = len(list);
    const shown = max_showed();
    for (let i = 0; i <= shown - 1; i++) {
      const idx = ItemPc.scroll + i;
      if (idx > n) break;
      const y = LIST_Y + UP_TEXT_Y + i * ROW_H;
      if (idx === n) {
        FrlgFont.draw(RomText.plain("gFameCheckerText_Cancel"), LIST_X + ITEM_X, y, { colors: C[1] });
      } else {
        const e = list[idx + 1];
        FrlgFont.draw(ItemsData.displayName(e.id), LIST_X + ITEM_X, y, { colors: C[1] });
        // src/item_pc.c:553 ItemPc_ItemPrintFunc
        FrlgFont.draw(RomText.plain("gText_TimesStrVar1", { stringVars: seq(format("%3d", e.qty)) }),
          LIST_X + QTY_X, y, { small: true, colors: C[1] });
      }
      if (mode === "move" && idx === ItemPc.moveOrig) {
        FrlgFont.drawGlyph(FrlgFont.CHAR_SELECTOR_ARROW, LIST_X, y, { colors: C[2] });
      }
    }
    const cursorY = LIST_Y + UP_TEXT_Y + ItemPc.row * ROW_H;
    if (mode === "list") {
      FrlgFont.drawGlyph(FrlgFont.CHAR_SELECTOR_ARROW, LIST_X + CURSOR_X, cursorY, { colors: C[1] });
    } else if (mode !== "move") {
      FrlgFont.drawGlyph(FrlgFont.CHAR_SELECTOR_ARROW, LIST_X, cursorY, { colors: C[2] });
    }

    // src/item_pc.c:515 ItemPc_MoveCursorFunc
    const pos = mode === "move" ? ItemPc.moveOrig! : cursor_pos();
    const entry = list[pos + 1];
    BagChrome.drawItemIcon((entry ? entry.id : null) ?? ((ItemsData as any).ITEMS_COUNT ?? 375), 8, 124);
    if (mode === "move") {
      FrlgFont.draw(RomText.plain("gOtherText_WhereShouldTheStrVar1BePlaced",
        { stringVars: seq(ItemsData.displayName(entry.id)) }), 40, 112 + 3,
      { colors: C[0], linePitch: 14 + 3 });
      // src/item_menu_icons.c:282 UpdateSwapLinePos
      BagChrome.drawSwapLine(96 - 32, cursorY - LIST_Y + 7);
    } else if (mode === "list") {
      let desc: string;
      if (!entry) {
        desc = RomText.plain("gText_ReturnToPC");
      } else if (ItemsData.pocketOf(entry.id) === "TM_CASE") {
        desc = Pokemon.moveName(Pokemon.moveFromTmItem(entry.id));
      } else {
        desc = ItemsData.description(entry.id);
      }
      FrlgFont.draw(desc, 40, 112 + 3, { colors: C[3], linePitch: 14 });
    }

    // src/item_pc.c:640 ItemPc_PlaceTopMenuScrollIndicatorArrows
    if (mode === "list") {
      if (ItemPc.scroll > 0) {
        BagChrome.drawArrow("up", 128 - 8, 8 - 8 + bob(ItemPc.k, 8));
      }
      if (ItemPc.scroll < total() - shown) {
        BagChrome.drawArrow("down", 128 - 8, 104 - 8 + bob(ItemPc.k, -8));
      }
    }

    if (mode === "submenu") {
      // src/item_pc.c:835 Task_ItemPcSubmenuInit
      Window.stdFrame(Window.template(22, 13, 7, 6));
      for (const [i, opt] of ipairs<{ key: string; run: string }>(SUBMENU)) {
        const y = 13 * 8 + 2 + (i - 1) * ROW_H;
        FrlgFont.draw(RomText.plain(opt.key), 22 * 8 + 8, y, { colors: C[1] });
        if (i === ItemPc.subCursor) {
          FrlgFont.drawGlyph(FrlgFont.CHAR_SELECTOR_ARROW, 22 * 8, y, { colors: C[1] });
        }
      }
      Window.fixedStdFrame(Window.template(6, 15, 14, 4));
      FrlgFont.draw(RomText.box("gText_Var1IsSelected", { stringVars: seq(ItemsData.displayName(entry.id)) }),
        6 * 8, 15 * 8 + 2, { colors: C[1], maxWidth: 14 * 8 });
    } else if (mode === "qty") {
      // src/item_pc.c:942 ItemPc_WithdrawMultipleInitWindow
      Window.fixedStdFrame(Window.template(6, 15, 16, 4));
      FrlgFont.draw(RomText.box("gText_WithdrawHowMany", { stringVars: seq(ItemsData.displayName(entry.id)) }),
        6 * 8, 15 * 8 + 2, { colors: FrlgFont.COLOR.NORMAL, maxWidth: 16 * 8 });
      Window.stdFrame(Window.template(24, 15, 5, 4));
      FrlgFont.draw(RomText.plain("gText_TimesStrVar1", { stringVars: seq(format("%03d", ItemPc.qty)) }),
        24 * 8 + 8, 15 * 8 + 10, { small: true, letterSpacing: 1, colors: C[1] });
      // src/item_pc.c:646 ItemPc_PlaceWithdrawQuantityScrollIndicatorArrows
      BagChrome.drawArrow("up", 212 - 8, 120 - 8 + bob(ItemPc.k, 8));
      BagChrome.drawArrow("down", 212 - 8, 152 - 8 + bob(ItemPc.k, -8));
    } else if (mode === "result") {
      Window.fixedStdFrame(Window.template(6, 15, 23, 4));
      FrlgFont.draw(ItemPc.resultText, 6 * 8, 15 * 8 + 2, { colors: FrlgFont.COLOR.NORMAL, maxWidth: 23 * 8 });
    } else if (mode === "msg") {
      // src/item_pc.c:1140 ItemPc_PrintOnWindow5WithContinueTask
      Window.dialogueFrame();
      FrlgFont.draw(ItemPc.msgText, Chrome.DLG_LEFT * 8, Chrome.DLG_TOP * 8 + 1,
        { maxWidth: Chrome.DLG_W * 8, colors: FrlgFont.COLOR.NORMAL });
    }

    if (ItemPc._fx) draw_fx(ItemPc._fx);
  },
};

// Lua: item_pc.lua:39
function se(id: unknown): void {
  try { Audio.playSe(id); } catch { /* pcall */ }
}

// Lua: item_pc.lua:43
function item_root(): string {
  // pcall(require, "src.import.gba.extract_island1"): the module is always there.
  const root = (Extract && Extract.CACHE_ROOT) || "data/generated/gba";
  return root + "/items/item_pc";
}

// Lua: item_pc.lua:49
function load_bg(name: string): Image {
  ItemPc._images = ItemPc._images ?? {};
  let img = ItemPc._images[name];
  if (img) return img;
  const rel = item_root() + "/" + name + ".rgba";
  const bytes = Dataset.cache().read(rel);
  if (!bytes || bytes.length < 240 * 160 * 4) {
    throw new Error("ItemPc: " + rel + " is not in the cache");
  }
  img = G.newImage(newImageData(240, 160, "rgba8", bytes));
  ItemPc._images[name] = img;
  return img;
}

// Lua: item_pc.lua:63
function items(): LuaTable {
  return Storage.ensure(ItemPc._session).items;
}

// Lua: item_pc.lua:67
function total(): number {
  return len(items()) + 1;
}

// Lua: item_pc.lua:71
function max_showed(): number {
  return Math.min(total(), MAX_SHOWED);
}

// Lua: item_pc.lua:75
function cursor_pos(): number {
  return ItemPc.scroll + ItemPc.row;
}

// src/item_pc.c:620 ItemPc_SetCursorPosition
// Lua: item_pc.lua:80
function set_cursor_position(): void {
  const n = len(items());
  const shown = max_showed();
  if (ItemPc.scroll !== 0 && ItemPc.scroll + shown > n + 1) {
    ItemPc.scroll = (n + 1) - shown;
  }
  if (ItemPc.scroll + ItemPc.row >= n + 1) {
    if (n + 1 < 2) ItemPc.row = 0; else ItemPc.row = n;
  }
  if (ItemPc.row > shown - 1) {
    ItemPc.scroll = ItemPc.scroll + ItemPc.row - (shown - 1);
    ItemPc.row = shown - 1;
  }
}

// src/item_pc.c:747 ItemPc_SetScrollPosition
// Lua: item_pc.lua:96
function set_scroll_position(): void {
  const shown = max_showed();
  if (ItemPc.row > 3) {
    let i = 0;
    while (i <= ItemPc.row - 3) {
      if (ItemPc.scroll + shown === len(items()) + 1) break;
      ItemPc.row = ItemPc.row - 1;
      ItemPc.scroll = ItemPc.scroll + 1;
      i = i + 1;
    }
  }
}

// src/list_menu.c:438
// Lua: item_pc.lua:110
function move_cursor(down: boolean): boolean {
  const count = total();
  const shown = max_showed();
  let scroll = ItemPc.scroll, row = ItemPc.row;
  let newRow: number;
  if (!down) {
    newRow = (shown === 1) ? 0 : (shown - (Math.floor(shown / 2) + mod(shown, 2)) - 1);
    if (scroll === 0) {
      if (row === 0) return false;
      row = row - 1;
    } else if (row > newRow) {
      row = row - 1;
    } else {
      row = newRow;
      scroll = scroll - 1;
    }
  } else {
    newRow = (shown === 1) ? 0 : (Math.floor(shown / 2) + mod(shown, 2));
    if (scroll === count - shown) {
      if (row >= shown - 1) return false;
      row = row + 1;
    } else if (row < newRow) {
      row = row + 1;
    } else {
      row = newRow;
      scroll = scroll + 1;
    }
  }
  ItemPc.scroll = scroll; ItemPc.row = row;
  return true;
}

// Lua: item_pc.lua:142
function held_repeat(input: any, key: string): boolean {
  if (input.wasPressed(key)) return true;
  // src/main.c:309
  return ItemPc._heldKey === key && (ItemPc._heldFrames ?? 0) >= 40 && mod((ItemPc._heldFrames ?? 0) - 40, 5) === 0;
}

// Lua: item_pc.lua:148
function track_held(input: any): void {
  let key: string | undefined;
  if (input.isDown) {
    if (input.isDown("up")) key = "up"; else if (input.isDown("down")) key = "down";
  }
  if (key !== ItemPc._heldKey || input.wasPressed(key ?? "")) {
    ItemPc._heldKey = key;
    ItemPc._heldFrames = 0;
  } else if (key) {
    ItemPc._heldFrames = (ItemPc._heldFrames ?? 0) + 1;
  }
}

// src/pc_screen_effect.c:52 Task_PCScreenEffect_TurnOn
// Lua: item_pc.lua:162
function fx_on(): Fx {
  return { on: true, state: 0, l: 120, r: 120, t: 80, b: 81 };
}

// src/pc_screen_effect.c:118 Task_PCScreenEffect_TurnOff
// Lua: item_pc.lua:167
function fx_off(cb: () => void): Fx {
  return { on: false, state: 0, l: 0, r: 240, t: 0, b: 160, cb };
}

// Lua: item_pc.lua:171
function step_fx(fx: Fx): boolean {
  if (fx.on) {
    if (fx.state === 2) {
      fx.l = fx.l - 16; fx.r = fx.r + 16;
      if (fx.l <= 0 || fx.r >= 240) { fx.l = 0; fx.r = 240; fx.white = false; }
      if (fx.l !== 0) return false;
    } else if (fx.state === 3) {
      fx.t = fx.t - 20; fx.b = fx.b + 20;
      if (fx.t <= 0 || fx.b >= 160) { fx.t = 0; fx.b = 160; }
      if (fx.t !== 0) return false;
    } else if (fx.state === 1) {
      fx.white = true;
    } else if (fx.state >= 4) {
      return true;
    }
  } else {
    if (fx.state === 2) {
      fx.t = fx.t + 20; fx.b = fx.b - 20;
      if (fx.t >= 80 || fx.b <= 81) { fx.t = 80; fx.b = 81; fx.white = true; }
      if (fx.t !== 80) return false;
    } else if (fx.state === 3) {
      fx.l = fx.l + 16; fx.r = fx.r - 16;
      if (fx.l >= 120 || fx.r <= 120) { fx.l = 120; fx.r = 120; fx.black = true; }
      if (fx.l !== 120) return false;
    } else if (fx.state >= 4) {
      return true;
    }
  }
  fx.state = fx.state + 1;
  return false;
}

// Lua: item_pc.lua:226
function finish_close(): void {
  ItemPc.open = false;
  Stack.pop("item_pc");
  const cb = ItemPc._onClose;
  ItemPc._onClose = null;
  if (cb) cb();
}

// src/item_pc.c:668 Task_ItemPcTurnOff1
// Lua: item_pc.lua:235
function turn_off(after?: () => void): void {
  se(SE.SE_PC_OFF);
  ItemPc._fx = fx_off(after ?? finish_close);
}

// Lua: item_pc.lua:240
function selected_entry(): any {
  return items()[cursor_pos() + 1];
}

// Lua: item_pc.lua:244
function return_from_submenu(): void {
  ItemPc.mode = "list";
}

// src/item_pc.c:917 Task_ItemPcCleanUpWithdraw
// Lua: item_pc.lua:249
function clean_up_withdraw(): void {
  set_cursor_position();
  return_from_submenu();
}

// src/item_pc.c:880 ItemPc_DoWithdraw
// Lua: item_pc.lua:255
function do_withdraw(): void {
  const entry = selected_entry();
  const id = entry.id, qty = ItemPc.qty;
  const session = ItemPc._session;
  if (Bag.canAdd(session.bag, id, qty) && Bag.add(session.bag, id, qty)[0]) {
    QuestLogRecorder.event(session, "WithdrewItemFromPC",
      seq(ItemsData.displayName(id)));
    ItemPc.mode = "result";
    ItemPc.resultText = RomText.plain("gText_WithdrewQuantItem",
      { stringVars: seq(ItemsData.displayName(id), tostring(qty)) });
    ItemPc._pending = { pos: cursor_pos() + 1, qty };
  } else {
    ItemPc.mode = "result";
    ItemPc.resultText = RomText.plain("gText_NoMoreRoomInBag");
    ItemPc._pending = null;
  }
}

// src/item_pc.c:1011 Task_ItemPcGive
// Lua: item_pc.lua:274
function give(): void {
  const session = ItemPc._session;
  const party = (session && session.party) ?? seq();
  if (len(party) === 0) {
    ItemPc.mode = "msg";
    ItemPc.msgText = RomText.plain("gText_ThereIsNoPokemon");
    return;
  }
  const id = selected_entry().id;
  let hole: number | undefined;
  ItemPc.mode = "party";
  PartyMenu.show(party, session.moveOverlay, {
    session,
    bag: session.bag,
    item: id,
    mode: "give",
    giveSource: {
      // src/item.c:416 RemovePCItem
      remove: (itemId: any): boolean => {
        const list = items();
        for (const [i, e] of ipairs(list)) {
          if (e.id === itemId) {
            e.qty = e.qty - 1;
            if (e.qty <= 0) {
              remove(list, i);
              hole = i;
            }
            return true;
          }
        }
        return false;
      },
      // src/item.c:385 AddPCItem
      restore: (itemId: any): boolean => {
        const list = items();
        for (const [, e] of ipairs(list)) {
          if (e.id === itemId) {
            e.qty = e.qty + 1;
            return true;
          }
        }
        insert(list, Math.min(hole ?? (len(list) + 1), len(list) + 1), { id: itemId, qty: 1 });
        return true;
      },
      // src/quest_log_events.c:1168 LoadEvent_GaveHeldItemFromPC
      quest: (monName: any, itemName: any): [string, LuaTable] => ["GaveMonHeldItemFromPC", seq(itemName, monName)],
    },
    onClose: () => {
      set_cursor_position();
      return_from_submenu();
    },
  });
}

// src/item_pc.c:766 ItemPc_MoveItemModeInit
// Lua: item_pc.lua:336
function begin_move(): void {
  ItemPc.moveOrig = cursor_pos();
  ItemPc.mode = "move";
}

// src/item_pc.c:800 ItemPc_InsertItemIntoNewSlot, :818 ItemPc_MoveItemModeCancel
// Lua: item_pc.lua:342
function end_move(commit: boolean): void {
  const from = ItemPc.moveOrig!, pos = cursor_pos();
  ItemPc.moveOrig = null;
  ItemPc.mode = "list";
  if (commit && !(from === pos || from === pos - 1)) {
    const list = items();
    const slot = remove(list, from + 1);
    const to = pos > from ? pos - 1 : pos;
    insert(list, to + 1, slot);
  }
  if (from < pos) ItemPc.row = ItemPc.row - 1;
  if (ItemPc.row < 0) {
    ItemPc.row = 0;
    ItemPc.scroll = Math.max(0, ItemPc.scroll - 1);
  }
}

// src/menu_indicators.c:270 SpriteCallback_ScrollIndicatorArrow
// Lua: item_pc.lua:488
function bob(k: number, freq: number): number {
  const v = Trig.sin(mod(k * freq, 256)) * 2 / 256;
  return v < 0 ? Math.ceil(v) : Math.floor(v);
}

// Lua: item_pc.lua:493
function draw_fx(fx: Fx): void {
  G.setColor(0, 0, 0, 1);
  G.rectangle("fill", 0, 0, 240, fx.t);
  G.rectangle("fill", 0, fx.b, 240, 160 - fx.b);
  G.rectangle("fill", 0, fx.t, fx.l, fx.b - fx.t);
  G.rectangle("fill", fx.r, fx.t, 240 - fx.r, fx.b - fx.t);
  if (fx.black) {
    G.rectangle("fill", 0, 0, 240, 160);
  } else if (fx.white) {
    G.setColor(1, 1, 1, 1);
    G.rectangle("fill", fx.l, fx.t, fx.r - fx.l, fx.b - fx.t);
  }
  G.setColor(1, 1, 1, 1);
}

export default ItemPc;
