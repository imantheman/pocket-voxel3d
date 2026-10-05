// Port of gen1recomp src/ui/game3/option_menu.lua (GPLv3 + additional terms; see LICENSE.md).
// The OPTION screen (pokefirered/src/option_menu.c), with Brian's grouped pages.

import { mod as luaMod, tonumber, tostring } from "../../../import/gen3/lua.ts";
import { len, type LuaTable } from "../platform/lt.ts";
import { G } from "../platform/graphics.ts";
import { Stack } from "./stack.ts";
import { Window } from "./window.ts";
import { Options } from "../core/options.ts";
import { Rows, type OptionCtx, type OptionRow } from "./option_rows.ts";
import { RomText } from "../core/rom_text.ts";
import { Screens } from "./screens.ts";
import { Runtime } from "../core/runtime.ts";
import { FrlgFont } from "./frlg_font.ts";
import { Trig } from "../core/trig.ts";
import { BagChrome } from "./bag_chrome.ts";
import { PokedexChrome } from "./pokedex_chrome.ts";
import { Chrome } from "./chrome.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Page { title: string; rows: LuaTable; index: number; scroll: number }
interface InputLike { wasPressed(k: string): boolean }

const VISIBLE = 7;
const WIN_X = 16, WIN_Y = 56, WIN_W = 208, WIN_H = 96;
const ROW_Y0 = WIN_Y + 2;
const ROW_STEP = 13;
const ROW_H = 14;
const LABEL_X = WIN_X + 8;
const VALUE_X = WIN_X + 0x82;
const HELP_BG = [0 / 255, 123 / 255, 197 / 255, 1];

// Lua: option_menu.lua:21
function ctx(): OptionCtx {
  return OptionMenu._ctx;
}

// Lua: option_menu.lua:25
function page(): Page | undefined {
  const pages = OptionMenu._pages;
  return pages ? (pages[len(pages)] ?? undefined) : undefined;
}

// Lua: option_menu.lua:30
function pushPage(title: string, rows: LuaTable): void {
  OptionMenu._pages[len(OptionMenu._pages) + 1] = {
    title, rows, index: 1, scroll: 0,
  };
}

// Lua: option_menu.lua:36
function buildTop(): LuaTable {
  const c = ctx();
  const flat = Rows.build(c);
  OptionMenu._flat = flat;
  return Rows.group(flat, (title, members) => {
    pushPage(title, members);
  });
}

// Lua: option_menu.lua:83
function rowCount(p: Page): number {
  return len(p.rows) + 1;
}

// Lua: option_menu.lua:87
function clampScroll(p: Page): void {
  const total = rowCount(p);
  if (total <= VISIBLE) {
    p.scroll = 0;
    return;
  }
  if (p.index - 1 < p.scroll) p.scroll = p.index - 1;
  if (p.index > p.scroll + VISIBLE) p.scroll = p.index - VISIBLE;
  if (p.scroll < 0) p.scroll = 0;
  if (p.scroll > total - VISIBLE) p.scroll = total - VISIBLE;
}

// Lua: option_menu.lua:108
function persist(): void {
  const c = ctx();
  const g = c && c.game;
  if (g && g.writeOptions) g.writeOptions();
}

// Lua: option_menu.lua:166
function valueColors(): any {
  return { fg: FrlgFont.STDPAL[5], shadow: FrlgFont.STDPAL[4], bg: FrlgFont.STDPAL[0] }; // src/option_menu.c:180
}

// src/menu_indicators.c:289
// Lua: option_menu.lua:172
function bob(k: number | undefined, freq: number): number {
  const v = Trig.sin(luaMod((k || 0) * freq, 256)) * 2 / 256;
  return v < 0 ? Math.ceil(v) : Math.floor(v);
}

// Lua: option_menu.lua:178
function scrollArrow(dir: string, x: number, y: number): void {
  // pcall(require, "src.ui.game3.bag_chrome"): a stub counts as a failed require
  if (BagChrome && BagChrome.drawArrow) {
    let drew = true, res: unknown;
    try { res = BagChrome.drawArrow(dir, x, y); } catch { drew = false; }
    if (drew && res) return;
  }
  FrlgFont.drawGlyph(dir === "up" ? FrlgFont.CHAR_UP_ARROW : FrlgFont.CHAR_DOWN_ARROW,
    x + 4, y + 1, { colors: FrlgFont.COLOR.RED });
}

// src/option_menu.c:316
// Lua: option_menu.lua:190
function drawHelpBar(): void {
  G.setColor(HELP_BG);
  G.rectangle("fill", 0, 0, 240, 16);
  G.setColor(1, 1, 1, 1);
  PokedexChrome.drawControlInfo(RomText.plain("gText_PickSwitchCancel"), 0xE4, 0);
}

export const OptionMenu: any = {
  isMenu: true,

  open: false,
  cursor: 1,

  _session: undefined as any,
  _onClose: undefined as (() => void) | undefined,
  _game: undefined as any,
  _ctx: undefined as OptionCtx | undefined,
  _pages: undefined as (Page | null)[] | undefined,
  _flat: undefined as LuaTable,
  _arrowK: 0,

  // Lua: option_menu.lua:45
  show(opts?: any): any {
    opts = opts || {};
    const other = Screens.redirect("option", OptionMenu, opts.session);
    if (other) return other.show(opts);
    OptionMenu.open = true;
    OptionMenu._session = opts.session;
    OptionMenu._onClose = opts.onClose;
    // package.loaded["src.core.game3.runtime"]
    OptionMenu._game = opts.game || (Runtime && Runtime._game);
    const engine = Options.engine(opts.session)
      || (OptionMenu._game && OptionMenu._game.options)
      || (opts.session && opts.session.options)
      || {};
    Options.bind(opts.session || {}, engine);
    OptionMenu._ctx = {
      session: opts.session,
      game: OptionMenu._game,
      options: engine,
    };
    OptionMenu._pages = [null];
    pushPage(RomText.plain("gText_MenuOption"), buildTop()); // src/option_menu.c:537
    OptionMenu.cursor = 1;
    Stack.push("option", OptionMenu, { hideBelow: true, fullscreen: true });
    return undefined;
  },

  // Lua: option_menu.lua:70
  close(): void {
    OptionMenu.open = false;
    OptionMenu._pages = undefined;
    Stack.pop("option");
    const cb = OptionMenu._onClose;
    OptionMenu._onClose = undefined;
    if (cb) cb();
  },

  // Lua: option_menu.lua:79
  isOpen(): boolean {
    return OptionMenu.open;
  },

  // Lua: option_menu.lua:99
  move(delta: number): void {
    const p = page();
    if (!p) return;
    const total = rowCount(p);
    p.index = luaMod(p.index - 1 + delta, total) + 1;
    OptionMenu.cursor = p.index;
    clampScroll(p);
  },

  // Lua: option_menu.lua:114
  adjust(delta: number): void {
    const p = page();
    if (!p) return;
    const row: OptionRow | undefined = p.rows[p.index] ?? undefined;
    if (!row || !row.step) return;
    if (row.step(ctx(), delta)) persist();
  },

  // Lua: option_menu.lua:122
  confirm(): void {
    const p = page();
    if (!p) return;
    if (p.index > len(p.rows)) {
      OptionMenu.back();
      return;
    }
    const row: OptionRow | undefined = p.rows[p.index] ?? undefined;
    if (!row) return;
    if (row.activate) {
      row.activate(ctx());
      return;
    }
    OptionMenu.adjust(1);
  },

  // Lua: option_menu.lua:138
  back(): void {
    const pages = OptionMenu._pages;
    if (pages && len(pages) > 1) {
      pages[len(pages)] = null;
      const p = page();
      OptionMenu.cursor = p ? p.index : 1;
      return;
    }
    OptionMenu.close();
  },

  // Lua: option_menu.lua:149
  handleInput(input?: InputLike): void {
    if (!input) return;
    if (input.wasPressed("up")) OptionMenu.move(-1);
    else if (input.wasPressed("down")) OptionMenu.move(1);
    else if (input.wasPressed("left")) OptionMenu.adjust(-1);
    else if (input.wasPressed("right")) OptionMenu.adjust(1);
    else if (input.wasPressed("a")) OptionMenu.confirm();
    else if (input.wasPressed("b") || input.wasPressed("start")) OptionMenu.back();
  },

  // Lua: option_menu.lua:160
  update(): void {
    if (OptionMenu.open) {
      OptionMenu._arrowK = (OptionMenu._arrowK || 0) + 1;
    }
  },

  // Lua: option_menu.lua:198
  draw(): void {
    if (!OptionMenu.open) return;
    const p = page();
    if (!p) return;
    const c = ctx();

    G.setColor(0, 0, 0, 1);
    G.rectangle("fill", 0, 0, 240, 160);
    G.setColor(1, 1, 1, 1);
    drawHelpBar();

    Chrome.fixedStdFrame(2, 3, 26, 2); // src/option_menu.c:537
    Window.printPx(p.title, 16 + 8, 24 + 1, { colors: FrlgFont.COLOR.NORMAL });

    const frameType = tonumber(Options.block(c.options).frameType) ?? 0;
    Window.userFrame(Window.template(2, 7, 26, 12), frameType);

    const total = rowCount(p);
    clampScroll(p);
    const vcol = valueColors();
    for (let slot = 1; slot <= VISIBLE; slot++) {
      const idx = p.scroll + slot;
      if (idx <= total) {
        const y = ROW_Y0 + (slot - 1) * ROW_STEP; // src/option_menu.c:563
        if (idx > len(p.rows)) {
          Window.printPx(RomText.at("sOptionMenuItemsNames", 6), LABEL_X, y, { colors: FrlgFont.COLOR.NORMAL });
        } else {
          const row: OptionRow = p.rows[idx];
          Window.printPx(row.label || "?", LABEL_X, y, { colors: FrlgFont.COLOR.NORMAL });
          if (row.value) {
            let ok = true, text: unknown;
            try { text = row.value(c); } catch { ok = false; }
            Window.printPx(ok ? tostring(text) : "----", VALUE_X, y, { colors: vcol });
          }
        }
      }
    }

    // src/option_menu.c:572
    const selTop = ROW_Y0 + (p.index - p.scroll - 1) * ROW_STEP;
    const selBot = selTop + ROW_H;
    G.setColor(0, 0, 0, 2 / 16);
    if (selTop > WIN_Y) {
      G.rectangle("fill", WIN_X, WIN_Y, WIN_W, selTop - WIN_Y);
    }
    if (selBot < WIN_Y + WIN_H) {
      G.rectangle("fill", WIN_X, selBot, WIN_W, WIN_Y + WIN_H - selBot);
    }
    G.setColor(1, 1, 1, 1);

    if (total > VISIBLE) {
      const k = OptionMenu._arrowK || 0;
      if (p.scroll > 0) {
        scrollArrow("up", 208, WIN_Y + bob(k, 8));
      }
      if (p.scroll + VISIBLE < total) {
        scrollArrow("down", 208, WIN_Y + WIN_H - 16 + bob(k, -8));
      }
    }
  },
};

export default OptionMenu;
