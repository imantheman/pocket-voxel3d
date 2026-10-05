// Port of gen1recomp src/ui/game3/prize_corner.lua (GPLv3 + additional terms; see LICENSE.md).
// pokefirered/src/script_menu.c:713
// The Game Corner prize lists (multichoice with a right-aligned price column).
//
// Port notes:
// - Lazily required: registers G3Lazy["src.ui.game3.prize_corner"] at the end.
// - Lua patterns go through platform/lpattern.ts; `love.graphics` is always
//   present; pcall(require, "src.core.game3.audio") always loads.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { seq, len, ipairs, type LuaTable } from "../platform/lt.ts";
import { find, gsub } from "../platform/lpattern.ts";
import { tonumber, tostring, sub, byte, mod, truthy } from "../../../import/gen3/lua.ts";
import { G3Lazy } from "../core/lazy_registry.ts";
import Stack from "./stack.ts";
import Window from "./window.ts";
import FrlgFont from "./frlg_font.ts";
import Audio from "../core/audio.ts";
import SE from "../core/se_ids.ts";

export interface PrizeRow {
  label: string;
  name: string;
  amount: string | undefined;
  column: number | undefined;
  nameSmall: boolean;
  amountSmall: boolean;
}

export interface PrizeGeom { left: number; top: number; width: number; height: number; tileX: number; tileY: number }

// pokefirered/include/constants/menu.h:21
const LIST_POKEMON_PRIZES = 14;
const LIST_COIN_PURCHASE = 27;
const LIST_TM_PRIZES = 30;
const LIST_BATTLE_ITEM_PRIZES = 41;

// Lua: prize_corner.lua:50
function starts_amount(token: string | undefined): boolean {
  if (token == null || token === "") return false;
  const b = byte(token, 1)!;
  if (b >= 0x30 && b <= 0x39) return true;
  return sub(token, 1, 2) === "\xC2\xA5";
}

// Lua: prize_corner.lua:175
function finish(result: number): void {
  const cb = PrizeCorner._done;
  PrizeCorner._done = undefined;
  PrizeCorner.open = false;
  PrizeCorner.rows = undefined;
  Stack.pop("prize_corner");
  if (cb) cb(result);
}

// Lua: prize_corner.lua:184
function se(): void {
  try { Audio.playSe(SE.SE_SELECT); } catch { /* pcall */ }
}

export const PrizeCorner = {
  isMenu: true,

  LIST_POKEMON_PRIZES,
  LIST_COIN_PURCHASE,
  LIST_TM_PRIZES,
  LIST_BATTLE_ITEM_PRIZES,

  // pokefirered/include/constants/menu.h:4
  SCR_MENU_CANCEL: 127,

  // pokefirered/src/strings.c:425
  COLUMNS: {
    [LIST_POKEMON_PRIZES]: seq(0x55, 0x55, 0x4B, 0x4B, 0x4B),
    [LIST_COIN_PURCHASE]: seq(0x45, 0x40),
    [LIST_TM_PRIZES]: seq(0x48, 0x48, 0x48, 0x48, 0x48),
    [LIST_BATTLE_ITEM_PRIZES]: seq(0x5A, 0x50, 0x50, 0x50, 0x50),
  } as Record<number, LuaTable>,

  // pokefirered/src/strings.c:425
  NAME_SMALL: {
    [LIST_COIN_PURCHASE]: true,
  } as Record<number, boolean>,

  // pokefirered/src/script_menu.c:754 (Lua `{ [0] = 1, 2, ... }`: slot 0 used)
  WINDOW_HEIGHT: [1, 2, 4, 6, 7, 9, 11, 13, 14],

  // pokefirered/src/script_menu.c:745
  TEXT_OX: 8,
  TEXT_OY: 2,
  ROW_PITCH: 14,

  open: false as boolean,
  listId: undefined as number | undefined,
  rows: undefined as LuaTable | undefined,
  cursor: 1,
  wrapAround: false,
  ignoreBPress: false,
  geom: undefined as PrizeGeom | undefined,
  _tpl: undefined as any,
  _done: undefined as ((result: number) => void) | undefined,

  // Lua: prize_corner.lua:46
  isPrizeList(listId: any): boolean {
    return PrizeCorner.COLUMNS[tonumber(listId) ?? -1] != null;
  },

  // Lua: prize_corner.lua:58
  // pokefirered/src/strings.c:425
  splitLabel(labelIn: any): [string, string?] {
    const label = tostring(labelIn ?? "");
    const tokens: LuaTable = seq<string>(), starts: LuaTable = seq<number>();
    let at = 1;
    for (;;) {
      const r = find(label, "%S+", at);
      if (!r) break;
      const [s, e] = r;
      tokens[len(tokens) + 1] = sub(label, s, e);
      starts[len(starts) + 1] = s;
      at = e + 1;
    }
    let cut: number | undefined = undefined;
    for (let i = len(tokens); i >= 1; i--) {
      if (starts_amount(tokens[i])) {
        cut = i;
        break;
      }
    }
    if (cut == null || cut === 1) return [label, undefined];
    const name = gsub(sub(label, 1, starts[cut] - 1), "%s+$", "")[0];
    return [name, sub(label, starts[cut])];
  },

  // Lua: prize_corner.lua:82
  // pokefirered/src/script_menu.c:745
  buildRows(listId: any, labels: any): LuaTable | undefined {
    const columns = PrizeCorner.COLUMNS[tonumber(listId) ?? -1];
    if (!columns) return undefined;
    const small = PrizeCorner.NAME_SMALL[tonumber(listId) as number] ? true : false;
    const rows: LuaTable = seq<PrizeRow>();
    for (const [i, entry] of ipairs<any>(labels ?? {})) {
      const given = (entry != null && typeof entry === "object") ? entry : undefined;
      const label = (given && truthy(given.label)) ? given.label : entry;
      // (`given and tonumber(given.stop) or columns[i]`)
      const column = (given && tonumber(given.stop) != null) ? tonumber(given.stop) : columns[i];
      let name: any, amount: any;
      if (given && truthy(given.name)) {
        name = given.name; amount = given.amount;
      } else {
        [name, amount] = PrizeCorner.splitLabel(label);
      }
      if (column == null) {
        name = tostring(label ?? ""); amount = undefined;
      }
      rows[i] = {
        label: tostring(label ?? ""),
        name,
        amount,
        column,
        nameSmall: (given && given.small != null) ? (truthy(given.small) ? true : false) : small,
        amountSmall: true,
      };
    }
    return rows;
  },

  // Lua: prize_corner.lua:113
  // pokefirered/src/text.c:1123
  rowWidth(row: PrizeRow | undefined): number {
    if (!row) return 0;
    let width = FrlgFont.measure(row.name, { small: row.nameSmall });
    if (row.column != null && row.amount != null) {
      if (row.column > width) width = row.column;
      width = width + FrlgFont.measure(row.amount, { small: row.amountSmall });
    }
    return width;
  },

  // Lua: prize_corner.lua:124
  // pokefirered/src/script_menu.c:736
  layout(_listId: any, rows: LuaTable | undefined, leftIn: any, top: any): PrizeGeom {
    let widest = 0;
    for (const [, row] of ipairs<PrizeRow>(rows ?? {})) {
      const w = PrizeCorner.rowWidth(row);
      if (w > widest) widest = w;
    }
    const width = Math.floor((widest + 9) / 8) + 1;
    let left = tonumber(leftIn) ?? 0;
    if (left + width > 28) left = 28 - width;
    const count = len(rows ?? {});
    const height = PrizeCorner.WINDOW_HEIGHT[count] ?? 1;
    return {
      left,
      top: tonumber(top) ?? 0,
      width,
      height,
      // pokefirered/src/script_menu.c:1195
      tileX: left + 1,
      tileY: (tonumber(top) ?? 0) + 1,
    };
  },

  // Lua: prize_corner.lua:147
  // pokefirered/src/script_menu.c:799
  wrapsAround(count: any): boolean {
    return (tonumber(count) ?? 0) > 3;
  },

  // Lua: prize_corner.lua:151
  isOpen(): boolean {
    return PrizeCorner.open ? true : false;
  },

  // Lua: prize_corner.lua:155
  show(optsIn?: any): boolean {
    const opts = optsIn ?? {};
    const listId = tonumber(opts.listId);
    const rows = PrizeCorner.buildRows(listId, opts.labels);
    if (!rows || len(rows) === 0) return false;
    PrizeCorner.open = true;
    PrizeCorner.listId = listId;
    PrizeCorner.rows = rows;
    PrizeCorner.geom = PrizeCorner.layout(listId, rows, opts.left, opts.top);
    PrizeCorner._tpl = Window.template(PrizeCorner.geom.tileX, PrizeCorner.geom.tileY,
      PrizeCorner.geom.width, PrizeCorner.geom.height);
    PrizeCorner.cursor = (tonumber(opts.default) ?? 0) + 1;
    if (PrizeCorner.cursor < 1 || PrizeCorner.cursor > len(rows)) PrizeCorner.cursor = 1;
    PrizeCorner.wrapAround = PrizeCorner.wrapsAround(len(rows));
    PrizeCorner.ignoreBPress = truthy(opts.ignoreBPress) ? true : false;
    PrizeCorner._done = opts.onChoose;
    Stack.push("prize_corner", PrizeCorner as any, { hideBelow: false, drawUnder: true });
    return true;
  },

  // Lua: prize_corner.lua:189
  // pokefirered/src/script_menu.c:818
  move(delta: number): void {
    if (!(PrizeCorner.open && PrizeCorner.rows)) return;
    const n = len(PrizeCorner.rows);
    if (n < 1 || delta === 0) return;
    let next1 = PrizeCorner.cursor + delta;
    if (PrizeCorner.wrapAround) {
      next1 = mod(next1 - 1, n) + 1;
    } else if (next1 < 1 || next1 > n) {
      return;
    }
    if (next1 !== PrizeCorner.cursor) {
      PrizeCorner.cursor = next1;
      se();
    }
  },

  // Lua: prize_corner.lua:205
  confirm(): void {
    if (!PrizeCorner.open) return;
    se();
    finish(PrizeCorner.cursor - 1);
  },

  // Lua: prize_corner.lua:212
  // pokefirered/src/script_menu.c:828
  cancel(): void {
    if (!PrizeCorner.open) return;
    if (PrizeCorner.ignoreBPress) return;
    se();
    finish(PrizeCorner.SCR_MENU_CANCEL);
  },

  // Lua: prize_corner.lua:219
  handleInput(input: any): void {
    if (!(PrizeCorner.open && input)) return;
    if (input.wasPressed("up")) {
      PrizeCorner.move(-1);
    } else if (input.wasPressed("down")) {
      PrizeCorner.move(1);
    } else if (input.wasPressed("a")) {
      PrizeCorner.confirm();
    } else if (input.wasPressed("b")) {
      PrizeCorner.cancel();
    }
  },

  // Lua: prize_corner.lua:232
  rowPx(index1: number): [number, number] {
    const g = PrizeCorner.geom;
    if (!g) return [0, 0];
    return [g.tileX * 8, g.tileY * 8 + PrizeCorner.TEXT_OY + (index1 - 1) * PrizeCorner.ROW_PITCH];
  },

  // Lua: prize_corner.lua:238
  draw(): void {
    if (!(PrizeCorner.open && PrizeCorner.rows && PrizeCorner.geom)) return;
    // `love and love.graphics`: always present here
    const g = PrizeCorner.geom;
    Window.stdFrame(PrizeCorner._tpl ?? Window.template(g.tileX, g.tileY, g.width, g.height));
    for (const [i, row] of ipairs<PrizeRow>(PrizeCorner.rows)) {
      const [baseX, y] = PrizeCorner.rowPx(i);
      if (i === PrizeCorner.cursor) {
        Window.cursorPx(baseX, y);
      }
      Window.printPx(row.name, baseX + PrizeCorner.TEXT_OX, y, { small: row.nameSmall });
      if (row.column != null && row.amount != null) {
        Window.printPx(row.amount, baseX + PrizeCorner.TEXT_OX + row.column, y,
          { small: row.amountSmall });
      }
    }
  },

  // Lua: prize_corner.lua:256
  reset(): boolean {
    PrizeCorner.open = false;
    PrizeCorner.rows = undefined;
    PrizeCorner.geom = undefined;
    PrizeCorner._tpl = undefined;
    PrizeCorner._done = undefined;
    PrizeCorner.cursor = 1;
    Stack.pop("prize_corner");
    return true;
  },
};

export default PrizeCorner;

G3Lazy["src.ui.game3.prize_corner"] = PrizeCorner;
