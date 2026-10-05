// Port of gen1recomp src/ui/game3/daycare_menu.lua (GPLv3 + additional terms; see LICENSE.md).
// pokefirered/src/daycare.c:1531 -- the Day-Care level menu.
//
// Required lazily (natives_daycare requires it by name), so it registers
// itself in G3Lazy. Brian's `pcall(require, ...)` helpers for stack, window
// and frlg_font always succeed here (all ported), so they return the static
// imports.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tonumber, tostring } from "../../../import/gen3/lua.ts";
import { Strings } from "../shared/core/Strings.ts";
import { RomText } from "../core/rom_text.ts";
import { SE } from "../core/se_ids.ts";
import { Stack } from "./stack.ts";
import { Window, type WindowTemplate } from "./window.ts";
import { FrlgFont } from "./frlg_font.ts";
import { Daycare } from "../core/daycare.ts";
import { Pokemon } from "../core/pokemon.ts";
import { Audio } from "../core/audio.ts";
import { G3Lazy } from "../core/lazy_registry.ts";
import { ipairs, type LuaTable } from "../platform/lt.ts";
import { gmatch } from "../platform/lpattern.ts";

interface DcRow { value: number; text: string; symbol: string; level: string; labelText?: string; levelXPx?: number | false }

const DAYCARE_MON_COUNT = 2; // pokefirered/include/constants/global.h:34
const DAYCARE_LEVEL_MENU_EXIT = 5; // pokefirered/include/constants/daycare.h:20
const STACK_ID = "daycare_level_menu";

let _stack: typeof Stack | false | null = null;
// Lua: daycare_menu.lua:30
function stackMod(): typeof Stack | null {
  if (_stack == null) _stack = Stack || false;
  return _stack || null;
}

let _window: typeof Window | false | null = null;
// Lua: daycare_menu.lua:39
function windowMod(): typeof Window | null {
  if (_window == null) _window = Window || false;
  return _window || null;
}

let _font: typeof FrlgFont | false | null = null;
// Lua: daycare_menu.lua:48
function frlgFont(): typeof FrlgFont | null {
  if (_font == null) _font = FrlgFont || false;
  return _font || null;
}

// Lua: daycare_menu.lua:56
function daycareMod(): any {
  return Daycare;
}

// Lua: daycare_menu.lua:60
function pokemonMod(): any {
  const P: any = Pokemon;
  if (!P._names) { try { P.install(null); } catch { /* pcall */ } }
  return P;
}

// Lua: daycare_menu.lua:66
function se(id: number | undefined): void {
  try { (Audio as any).playSe(id); } catch { /* pcall */ }
}

let _template: WindowTemplate | null = null;

export const DaycareMenu = {
  isMenu: true,
  // pokefirered/src/daycare.c:86 sDaycareLevelMenuWindowTemplate
  WINDOW: { left: 12, top: 1, width: 17, height: 5 },
  // pokefirered/src/new_menu_helpers.c:91 FONT_NORMAL_COPY_2 maxLetterHeight
  ROW_PITCH: 14,
  // pokefirered/src/daycare.c:113 .item_X
  TEXT_X: 8,
  // pokefirered/src/daycare.c:1482
  LEVEL_RIGHT: 132,
  ROW_COUNT: 3,
  DAYCARE_LEVEL_MENU_EXIT,

  open: false,
  rowList: null as (DcRow | null)[] | null,
  cursor: 1,
  _onPick: null as ((value: number | null | undefined) => void) | null | undefined,

  // Lua: daycare_menu.lua:70
  textWidth(text: unknown): number {
    const F = frlgFont();
    if (F && F.measure) {
      let ok = true, w: unknown;
      try { w = F.measure(text); } catch { ok = false; }
      if (ok && tonumber(w) != null) return tonumber(w)!;
    }
    return tostring(text).length * 6;
  },

  // pokefirered/src/daycare.c:1357 NameHasGenderSymbol
  // Lua: daycare_menu.lua:80
  nameHasGenderSymbol(name: unknown, gender: string): boolean {
    let males = 0, females = 0;
    for (const _ of gmatch(tostring(name ?? ""), "\xE2\x99\x82")) males = males + 1; // ♂
    for (const _ of gmatch(tostring(name ?? ""), "\xE2\x99\x80")) females = females + 1; // ♀
    if (gender === "M") return males !== 0 && females === 0;
    if (gender === "F") return females !== 0 && males === 0;
    return false;
  },

  // pokefirered/src/daycare.c:1379 AppendGenderSymbol
  // Lua: daycare_menu.lua:90
  genderSymbol(name: unknown, gender: string): string {
    if (gender === "M") {
      if (!DaycareMenu.nameHasGenderSymbol(name, "M")) return "\xE2\x99\x82";
    } else if (gender === "F") {
      if (!DaycareMenu.nameHasGenderSymbol(name, "F")) return "\xE2\x99\x80";
    }
    // pokefirered/src/trade.c:527 gText_GenderlessSymbol
    return "";
  },

  // pokefirered/src/daycare.c:1486 DaycarePrintMonInfo
  // Lua: daycare_menu.lua:101
  rows(dc: any): (DcRow | null)[] {
    const D = daycareMod();
    const P = pokemonMod();
    const rows: (DcRow | null)[] = [null];
    for (let i = 1; i <= DAYCARE_MON_COUNT; i++) {
      const mon = D.mon(dc, i);
      const name: string = mon ? D.nickname(mon) : "";
      const species = tonumber(mon && (mon.species ?? mon.speciesId)) ?? 0;
      const gender: string = mon ? P.gender(species, mon.personality) : "U";
      let level = "";
      if (mon) {
        // pokefirered/src/daycare.c:1479 GetLevelAfterDaycareSteps
        level = Strings("Lv%s",
          tostring(D.levelAfterSteps(mon, dc && dc.steps && dc.steps[i])));
      }
      rows[i] = {
        value: i - 1,
        text: name,
        symbol: mon ? DaycareMenu.genderSymbol(name, gender) : "",
        level,
      };
    }
    // pokefirered/src/daycare.c:97 sLevelMenuItems
    rows[DaycareMenu.ROW_COUNT] = {
      value: DAYCARE_LEVEL_MENU_EXIT, text: RomText.plain("gOtherText_Exit"), symbol: "", level: "",
    };
    return rows;
  },

  // pokefirered/src/daycare.c:1464
  // Lua: daycare_menu.lua:131
  label(row: DcRow | null | undefined): string {
    if (!row) return "";
    return tostring(row.text ?? "") + tostring(row.symbol ?? "");
  },

  // pokefirered/src/daycare.c:1482
  // Lua: daycare_menu.lua:137
  levelX(row: DcRow | null | undefined): number | null {
    const text = (row && row.level) || "";
    if (text === "") return null;
    return DaycareMenu.LEVEL_RIGHT - DaycareMenu.textWidth(text);
  },

  // Lua: daycare_menu.lua:143
  isOpen(): boolean {
    return DaycareMenu.open === true;
  },

  // Lua: daycare_menu.lua:147
  show(dc: any, onPick?: (value: number | null | undefined) => void): boolean {
    const S = stackMod();
    if (!S) return false;
    DaycareMenu.rowList = DaycareMenu.rows(dc);
    for (const [, row] of ipairs<DcRow>(DaycareMenu.rowList)) {
      row.labelText = DaycareMenu.label(row);
      row.levelXPx = DaycareMenu.levelX(row) ?? false;
    }
    DaycareMenu.cursor = 1;
    DaycareMenu._onPick = onPick;
    DaycareMenu.open = true;
    S.push(STACK_ID, DaycareMenu as LuaTable, { hideBelow: false, drawUnder: true });
    return true;
  },

  // Lua: daycare_menu.lua:162
  close(): void {
    DaycareMenu.open = false;
    DaycareMenu._onPick = null;
    const S = stackMod();
    if (S) S.pop(STACK_ID);
  },

  // pokefirered/src/list_menu.c:620 ListMenuDefaultCursorMoveFunc
  // Lua: daycare_menu.lua:170
  move(delta: number): void {
    if (!DaycareMenu.open) return;
    const want = DaycareMenu.cursor + delta;
    if (want < 1 || want > DaycareMenu.ROW_COUNT) return;
    DaycareMenu.cursor = want;
    se(SE.SE_SELECT);
  },

  // pokefirered/src/daycare.c:1504
  // Lua: daycare_menu.lua:179
  confirm(): void {
    if (!DaycareMenu.open) return;
    const row = DaycareMenu.rowList && DaycareMenu.rowList[DaycareMenu.cursor];
    const cb = DaycareMenu._onPick;
    const value = row ? row.value : null;
    DaycareMenu.close();
    if (cb) cb(value);
  },

  // pokefirered/src/daycare.c:1521
  // Lua: daycare_menu.lua:189
  cancel(): void {
    if (!DaycareMenu.open) return;
    const cb = DaycareMenu._onPick;
    DaycareMenu.close();
    if (cb) cb(null);
  },

  // pokefirered/src/daycare.c:1498 Task_HandleDaycareLevelMenuInput
  // Lua: daycare_menu.lua:197
  handleInput(input: any): void {
    if (!(DaycareMenu.open && input)) return;
    if (input.wasPressed("a")) DaycareMenu.confirm();
    else if (input.wasPressed("b")) DaycareMenu.cancel();
    else if (input.wasPressed("up")) DaycareMenu.move(-1);
    else if (input.wasPressed("down")) DaycareMenu.move(1);
  },

  // Lua: daycare_menu.lua:208
  draw(): void {
    if (!(DaycareMenu.open && DaycareMenu.rowList)) return;
    const W0 = windowMod();
    if (!W0) return;
    const W = DaycareMenu.WINDOW;
    if (!_template) {
      _template = W0.template(W.left, W.top, W.width, W.height);
    }
    // pokefirered/src/daycare.c:1539 DrawStdWindowFrame
    W0.stdFrame(_template);
    const leftPx = W.left * 8, topPx = W.top * 8;
    for (let i = 1; i <= DaycareMenu.ROW_COUNT; i++) {
      const row = DaycareMenu.rowList[i];
      if (row) {
        const yPx = topPx + (i - 1) * DaycareMenu.ROW_PITCH;
        // pokefirered/src/daycare.c:114 .cursor_X
        if (i === DaycareMenu.cursor) W0.cursorPx(leftPx, yPx);
        W0.printPx(row.labelText ?? DaycareMenu.label(row), leftPx + DaycareMenu.TEXT_X, yPx);
        let levelX: number | false | null | undefined = row.levelXPx;
        if (levelX == null) levelX = DaycareMenu.levelX(row);
        if (levelX !== false && levelX != null) W0.printPx(row.level, leftPx + levelX, yPx);
      }
    }
  },
};

G3Lazy["src.ui.game3.daycare_menu"] = DaycareMenu;

export default DaycareMenu;
