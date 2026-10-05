// Port of gen1recomp src/core/game3/scripting/natives_listmenu.lua (GPLv3 + additional terms; see LICENSE.md).
// The ListMenu special (pokefirered/src/field_specials.c:1164): badges,
// Silph Co. / Rocket Hideout / Dept. Store floors, lecture headers, berry
// powder, Trainer Tower floors; the scrolling script list menu screen.
//
// Port notes:
// - Lazily required by Game3's soft reset (package.loaded): also registers as
//   G3Lazy["src.core.game3.scripting.natives_listmenu"].
// - Handlers return Lua's multiple returns as a 0-based tuple (natives.ts).
// - pcall(require) / package.loaded / require of rom_text, text_ir, flags,
//   space, runtime, audio, frlg_font, window, stack, screens, trig, profile,
//   bag_chrome, natives: static imports treated as loaded.
// - A text IR is TextIR's 0-based Seg[] (rom_text.ts), and a segment's args
//   are 0-based: clearToLabel walks the IR 0-based, and seg.args[1] is
//   args[0].
// - NOT FAITHFUL: Emerald only. drawRseScrollArrows needs
//   src.ui.game3.rse.bag_chrome (not ported): it throws.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { ipairs, len, seq, type LuaTable } from "../../platform/lt.ts";
import { mod, tonumber, tostring } from "../../../../import/gen3/lua.ts";
import Std from "./stdscripts.ts";
import { SE } from "../se_ids.ts"; // pokefirered/include/constants/songs.h:9
import RomText from "../rom_text.ts";
import { TextIR, type Seg } from "./text_ir.ts";
import Flags from "./flags.ts";
import Space from "./space.ts";
import { Runtime } from "../runtime.ts";
import { G3Lazy } from "../lazy_registry.ts";
import { Audio } from "../audio.ts";
import { FrlgFont as FrlgFontMod } from "../../ui/frlg_font.ts";
import { Window as WindowMod } from "../../ui/window.ts";
import { Stack as StackMod } from "../../ui/stack.ts";
import { Screens } from "../../ui/screens.ts";
import { Trig } from "../trig.ts";
import { Profile } from "../profile.ts";
import { BagChrome as BagChromeMod } from "../../ui/bag_chrome.ts";
import Natives, { type Handler } from "./natives.ts";

const VAR_RESULT = 0x800D; // pokefirered/include/constants/vars.h:328
const VAR_0x8004 = 0x8004; // pokefirered/include/constants/vars.h:319

const SCR_MENU_CANCEL = 0x7F; // pokefirered/include/constants/menu.h:4

// pokefirered/include/constants/menu.h:75
const LISTMENU_BADGES = 0;
const LISTMENU_SILPHCO_FLOORS = 1;
const LISTMENU_ROCKET_HIDEOUT_FLOORS = 2;
const LISTMENU_DEPT_STORE_FLOORS = 3;
const LISTMENU_WIRELESS_LECTURE_HEADERS = 4;
const LISTMENU_BERRY_POWDER = 5;
const LISTMENU_TRAINER_TOWER_FLOORS = 6;

export interface ListLayout {
  maxShowed: number;
  count: number;
  left: number;
  top: number;
  height: number;
  keepOpen: boolean;
  width?: number;
  exchangeMenuId?: number;
}

// pokefirered/src/field_specials.c:1164
const LAYOUTS: Record<number, ListLayout> = {
  [LISTMENU_BADGES]: { maxShowed: 4, count: 9, left: 1, top: 1, height: 7, keepOpen: true },
  [LISTMENU_SILPHCO_FLOORS]: { maxShowed: 7, count: 12, left: 1, top: 1, height: 12, keepOpen: false },
  [LISTMENU_ROCKET_HIDEOUT_FLOORS]: { maxShowed: 4, count: 4, left: 1, top: 1, height: 8, keepOpen: false },
  [LISTMENU_DEPT_STORE_FLOORS]: { maxShowed: 4, count: 6, left: 1, top: 1, height: 8, keepOpen: false },
  [LISTMENU_WIRELESS_LECTURE_HEADERS]: { maxShowed: 4, count: 4, left: 1, top: 1, height: 8, keepOpen: true },
  [LISTMENU_BERRY_POWDER]: { maxShowed: 7, count: 12, left: 16, top: 1, height: 12, keepOpen: false },
  [LISTMENU_TRAINER_TOWER_FLOORS]: { maxShowed: 3, count: 3, left: 1, top: 1, height: 6, keepOpen: false },
};

// pokefirered/src/field_specials.c:1257 sListMenuLabels
const EXT_CLEAR_TO = 0x13;

// Lua: natives_listmenu.lua:39
function clearToLabel(key: string): any {
  const ir: Seg[] = RomText.translate(RomText.ir(key), {}, key);
  // 0-based IR seam (see the port notes)
  for (let i = 0; i < ir.length; i++) {
    const seg = ir[i]!;
    if (seg.t === "ext" && seg.cmd === EXT_CLEAR_TO) {
      const head: Seg[] = [], tail: Seg[] = [];
      for (let j = 0; j <= i - 1; j++) head.push(ir[j]!);
      for (let j = i + 1; j < ir.length; j++) tail.push(ir[j]!);
      return {
        text: TextIR.toPlain(head, {}),
        clearTo: seg.args![0],
        tail: TextIR.toPlain(tail, {}),
      };
    }
  }
  return RomText.plain(key);
}

// Lua: natives_listmenu.lua:58
function labelsFor(kind: number): LuaTable | undefined {
  const count = LAYOUTS[kind] && LAYOUTS[kind]!.count;
  if (!count) return undefined;
  const labels: LuaTable = seq();
  for (let i = 0; i <= count - 1; i++) {
    const key = RomText.key("sListMenuLabels", kind, i);
    if (kind === LISTMENU_BERRY_POWDER) {
      labels[i + 1] = clearToLabel(key);
    } else {
      labels[i + 1] = RomText.plain(key);
    }
  }
  return labels;
}

// Lua: natives_listmenu.lua:75
function flagsMod(): typeof Flags {
  return Flags;
}

// Lua: natives_listmenu.lua:79
function scriptStore(): any {
  const S: any = Space;
  const rt: any = Runtime;
  const session = rt && rt.getSession && rt.getSession();
  return (S && S.store) || (session && session.store) || undefined;
}

// Lua: natives_listmenu.lua:86
function varGet(ctx: any, id: number): number {
  return tonumber(flagsMod().getVar(scriptStore(), ctx, id)) ?? 0;
}

// Lua: natives_listmenu.lua:90
function setResult(ctx: any, value: any): void {
  flagsMod().setVar(scriptStore(), ctx, VAR_RESULT, tonumber(value) ?? 0);
}

// Lua: natives_listmenu.lua:94
function se(id: number): void {
  try { Audio.playSe(id); } catch { /* pcall */ }
}

const STACK_ID = "script_list_menu";

// pokefirered/src/strings.c:585 {FONT_SMALL}
const SMALL_FONT = { small: true };

// pokefirered/src/text.c:147
const LIST_ROW_H = 14;

let _font: any;
// Lua: natives_listmenu.lua:119
function frlgFont(): any {
  if (_font == null) {
    // pcall(require, "src.ui.game3.frlg_font")
    _font = FrlgFontMod || false;
  }
  return _font || undefined;
}

let _window: any;
// Lua: natives_listmenu.lua:128
function windowMod(): any {
  if (_window == null) {
    // pcall(require, "src.ui.game3.window")
    _window = WindowMod || false;
  }
  return _window || undefined;
}

// Lua: natives_listmenu.lua:137
function textWidth(text: any): number {
  const FrlgFont = frlgFont();
  if (FrlgFont && FrlgFont.measure) {
    let okM = true;
    let w: any;
    try { w = FrlgFont.measure(text); } catch { okM = false; }
    if (okM && tonumber(w) != null) return tonumber(w)!;
  }
  return tostring(text).length * 6;
}

// Lua: natives_listmenu.lua:147
// pokefirered/src/strings.c:585
function measure(label: any): number {
  if (typeof label === "object" && label != null) {
    // pokefirered/src/daycare.c:1482
    if (label.tailRight) return label.tailRight;
    return Math.max(textWidth(label.text), (label.clearTo || 0) + textWidth(label.tail));
  }
  return textWidth(label);
}

// Lua: natives_listmenu.lua:157
// pokefirered/src/field_specials.c:1355
function windowWidth(labels: LuaTable): number {
  let mwidth = 0;
  for (const [, label] of ipairs<any>(labels)) {
    const w = measure(label);
    if (w > mwidth) mwidth = w;
  }
  return Math.floor((mwidth + 9) / 8) + 1;
}

// Lua: natives_listmenu.lua:274
function arrowBob(freq: number): number {
  const v = Trig.sin(mod((Menu.arrowK || 0) * freq, 256)) * 2 / 256;
  return v < 0 ? Math.ceil(v) : Math.floor(v);
}

// Lua: natives_listmenu.lua:281
// pokefirered/src/field_specials.c:1485 Task_CreateMenuRemoveScrollIndicatorArrowPair
function drawRseScrollArrows(): void {
  // NOT FAITHFUL: Emerald only (see the port notes).
  const BagChrome = G3Lazy["src.ui.game3.rse.bag_chrome"];
  if (BagChrome == null) throw new Error("NOT FAITHFUL: Emerald only: src.ui.game3.rse.bag_chrome is not ported");
  // pokeemerald/src/field_specials.c:2743
  const cx = Math.floor(Menu.width / 2) * 8 + 12 + (Menu.left - 1) * 8;
  const t = Menu.arrowK || 0;
  if (Menu.scroll > 0) BagChrome.drawArrow("up", cx, 8, t);
  if (Menu.scroll < Menu.count - Menu.maxShowed) BagChrome.drawArrow("down", cx, Menu.height * 8 + 10, t);
}

// Lua: natives_listmenu.lua:290
function drawScrollArrows(): void {
  if (Menu.maxShowed === Menu.count) return;
  if (Profile.family() === "rse") return drawRseScrollArrows();
  // pcall(require, "src.ui.game3.bag_chrome")
  const BagChrome: any = BagChromeMod;
  if (!(BagChrome && BagChrome.drawArrow)) return;
  const x = 4 * Menu.width + 8 * Menu.left;
  if (Menu.scroll > 0) {
    BagChrome.drawArrow("up", x - 8, arrowBob(8));
  }
  if (Menu.scroll < Menu.count - Menu.maxShowed) {
    BagChrome.drawArrow("down", x - 8, 8 * Menu.height + 10 - 8 + arrowBob(-8));
  }
}

type PickFn = (index: number, keepOpen: boolean) => void;

const Menu = {
  open: false,
  labels: undefined as LuaTable | undefined,
  scroll: 0,
  row: 1,
  maxShowed: 1,
  left: 1,
  top: 1,
  _onPick: undefined as PickFn | undefined,
  kind: undefined as number | undefined,
  count: 0,
  keepOpen: false,
  width: 0,
  height: 0,
  arrowK: 0,

  // Lua: natives_listmenu.lua:166
  isOpen(): boolean {
    return Menu.open === true;
  },

  // Lua: natives_listmenu.lua:170
  showItems(kind: number, labels: LuaTable | undefined, layout: ListLayout | undefined, scroll: any, cursor: any, onPick?: PickFn): boolean {
    if (!(layout && labels)) return false;
    Menu.kind = layout.exchangeMenuId ?? kind;
    const Preview = Screens.get("frontier_preview", Space.store);
    if (Preview) Preview.tutorOpen = Menu.kind === 9 || Menu.kind === 10;
    Menu.labels = labels;
    Menu.count = layout.count;
    Menu.maxShowed = Math.min(layout.maxShowed, layout.count);
    Menu.keepOpen = layout.keepOpen;
    Menu.scroll = Math.max(0, Math.min(tonumber(scroll) ?? 0, layout.count - Menu.maxShowed));
    Menu.row = Math.max(1, Math.min((tonumber(cursor) ?? 0) + 1, Menu.maxShowed));
    Menu.width = layout.width || windowWidth(labels);
    Menu.left = layout.left;
    // pokefirered/src/field_specials.c:1356
    if (Menu.left + Menu.width > 29) Menu.left = 29 - Menu.width;
    Menu.top = layout.top;
    Menu.height = layout.height;
    Menu.arrowK = 0;
    Menu._onPick = onPick;
    Menu.open = true;
    // pcall(require, "src.ui.game3.stack")
    const Stack: any = StackMod;
    if (!Stack) {
      Menu.open = false;
      if (onPick) onPick(SCR_MENU_CANCEL, false);
      return true;
    }
    Stack.push(STACK_ID, Menu, { hideBelow: false, drawUnder: true });
    return true;
  },

  // Lua: natives_listmenu.lua:200
  show(kind: number, scroll: any, cursor: any, onPick?: PickFn): boolean {
    return Menu.showItems(kind, labelsFor(kind), LAYOUTS[kind], scroll, cursor, onPick);
  },

  // Lua: natives_listmenu.lua:204
  close(): void {
    Menu.open = false;
    let okP = true;
    let Preview: any;
    try { Preview = Screens.get("frontier_preview"); } catch { okP = false; }
    if (okP && Preview) { Preview.tutorOpen = false; Preview.exchangeOpen = false; }
    Menu._onPick = undefined;
    const Stack: any = StackMod;
    if (Stack) Stack.pop(STACK_ID);
  },

  // Lua: natives_listmenu.lua:213
  selection(): number {
    return Menu.scroll + Menu.row - 1;
  },

  // Lua: natives_listmenu.lua:217
  move(delta: number): void {
    if (!Menu.open) return;
    if (delta < 0) {
      if (Menu.row > 1) {
        Menu.row = Menu.row - 1;
        se(SE.SE_SELECT);
      } else if (Menu.scroll > 0) {
        Menu.scroll = Menu.scroll - 1;
        se(SE.SE_SELECT);
      }
    } else if (delta > 0) {
      if (Menu.row < Menu.maxShowed && Menu.selection() + 1 < Menu.count) {
        Menu.row = Menu.row + 1;
        se(SE.SE_SELECT);
      } else if (Menu.scroll + Menu.maxShowed < Menu.count) {
        Menu.scroll = Menu.scroll + 1;
        se(SE.SE_SELECT);
      }
    }
  },

  // Lua: natives_listmenu.lua:239
  // pokefirered/src/field_specials.c:1407 Task_ListMenuHandleInput
  confirm(): void {
    if (!Menu.open) return;
    const index = Menu.selection();
    const keepOpen = Menu.keepOpen && index !== (Menu.count - 1);
    const cb = Menu._onPick;
    const scroll = Menu.scroll, row = Menu.row;
    se(SE.SE_SELECT);
    Menu.close();
    if (keepOpen) {
      Menu.scroll = scroll;
      Menu.row = row;
    }
    if (cb) cb(index, keepOpen);
  },

  // Lua: natives_listmenu.lua:253
  cancel(): void {
    if (!Menu.open) return;
    const cb = Menu._onPick;
    se(SE.SE_SELECT);
    Menu.close();
    if (cb) cb(SCR_MENU_CANCEL, false);
  },

  // Lua: natives_listmenu.lua:261
  handleInput(input: any): void {
    if (!(Menu.open && input)) return;
    if (input.wasPressed("up")) Menu.move(-1);
    else if (input.wasPressed("down")) Menu.move(1);
    else if (input.wasPressed("a")) Menu.confirm();
    else if (input.wasPressed("b")) Menu.cancel();
  },

  // Lua: natives_listmenu.lua:270
  update(): void {
    if (Menu.open) Menu.arrowK = (Menu.arrowK || 0) + 1;
  },

  // Lua: natives_listmenu.lua:305
  draw(): void {
    if (!(Menu.open && Menu.labels)) return;
    const Window = windowMod();
    if (!Window) return;
    const rows = Menu.maxShowed;
    const th = Menu.height || Math.max(2, Math.ceil((rows * LIST_ROW_H) / 8));
    Window.stdFrame(Window.template(Menu.left, Menu.top, Menu.width, th));
    const leftPx = Menu.left * 8;
    const topPx = Menu.top * 8;
    for (let i = 1; i <= rows; i++) {
      const label = Menu.labels[Menu.scroll + i];
      if (label) {
        const yPx = topPx + (i - 1) * LIST_ROW_H;
        const textPx = leftPx + Window.CURSOR_WIDTH;
        if (i === Menu.row) Window.cursorPx(leftPx, yPx);
        if (typeof label === "object" && label.tailRight) {
          // pokefirered/src/daycare.c:1486
          Window.printPx(label.text, leftPx + (label.textX || 8), yPx);
          if (label.tail && label.tail !== "") {
            Window.printPx(label.tail,
              leftPx + label.tailRight - textWidth(label.tail), yPx);
          }
        } else if (typeof label === "object") {
          Window.printPx(label.text, textPx, yPx);
          const FrlgFont = frlgFont();
          if (FrlgFont && FrlgFont.draw) {
            try {
              FrlgFont.draw(tostring(label.tail), textPx + (label.clearTo || 0), yPx, SMALL_FONT);
            } catch { /* pcall */ }
          }
        } else {
          Window.printPx(label, textPx, yPx);
        }
      }
    }
    drawScrollArrows();
    const preview = Screens.get("frontier_preview", Space.store);
    if (preview && preview.draw) preview.draw(Menu);
  },
};

// Lua: natives_listmenu.lua:347
function present(ctx: any, kind: number, scroll: number, cursor: number): [boolean] {
  let done = false;
  Natives.awaitState(ctx, () => done);
  const shown = Menu.show(kind, scroll, cursor, (index, keepOpen) => {
    setResult(ctx, index);
    ListMenu._suspended = keepOpen ? { kind, scroll: Menu.scroll, row: Menu.row } : undefined;
    done = true;
  });
  if (!shown) {
    // pokefirered/src/field_specials.c:1250
    setResult(ctx, SCR_MENU_CANCEL);
    done = true;
  }
  return [false];
}

const BY_NAME: Record<string, Handler> = {
  // Lua: natives_listmenu.lua:382
  // pokefirered/src/field_specials.c:1164
  ListMenu: (ctx) => {
    const kind = varGet(ctx, VAR_0x8004);
    let scroll = 0, cursor = 0;
    if (kind === LISTMENU_SILPHCO_FLOORS) {
      scroll = tonumber(ListMenu.elevatorScroll) ?? 0;
      cursor = tonumber(ListMenu.elevatorCursorPos) ?? 0;
    }
    ListMenu._suspended = undefined;
    return present(ctx, kind, scroll, cursor);
  },
  // Lua: natives_listmenu.lua:393
  // pokefirered/src/field_specials.c:1469 ReturnToListMenu
  ReturnToListMenu: (ctx) => {
    const state = ListMenu._suspended;
    if (!state) return [false];
    return present(ctx, state.kind, state.scroll, state.row - 1);
  },
};

export const ListMenu = {
  LISTMENU_BADGES,
  LISTMENU_SILPHCO_FLOORS,
  LISTMENU_BERRY_POWDER,
  LAYOUTS,
  // Lua: natives_listmenu.lua:73
  labelsFor,
  Menu,
  // Lua: natives_listmenu.lua:135
  windowMod,
  _suspended: undefined as { kind: number; scroll: number; row: number } | undefined,
  /** Set by natives_elevator (Silph Co.'s floor list scroll / cursor). */
  elevatorScroll: undefined as number | undefined,
  elevatorCursorPos: undefined as number | undefined,

  // Lua: natives_listmenu.lua:365
  // pokefirered/src/daycare.c:1531 ShowDaycareLevelMenu
  presentItems(ctx: any, key: any, labels: LuaTable, layout: ListLayout, onPick?: (index: number) => void): [boolean] {
    let done = false;
    Natives.awaitState(ctx, () => done);
    const shown = Menu.showItems(key, labels, layout, 0, 0, (index) => {
      if (onPick) onPick(index);
      done = true;
    });
    if (!shown) {
      if (onPick) onPick(SCR_MENU_CANCEL);
      done = true;
    }
    return [false];
  },

  // Game3's soft reset calls ListMenu.close (package.loaded probe); the Lua
  // module has no `close`, so that probe finds nothing to call.
  BY_NAME,
  /** Set by Std.legacyHandlers: special id -> handler. */
  HANDLERS: undefined as Record<number, Handler> | undefined,
};
// Lua: natives_listmenu.lua:399
Std.legacyHandlers(ListMenu);

G3Lazy["src.core.game3.scripting.natives_listmenu"] = ListMenu;

export default ListMenu;
