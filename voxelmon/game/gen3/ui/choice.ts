// Port of gen1recomp src/ui/game3/choice.lua (GPLv3 + additional terms; see LICENSE.md).
// Yes/No + multichoice (pret yesnobox / multichoice / multichoicegrid). Writes VAR_RESULT via callback.

import { mod, tonumber, tostring, truthy } from "../../../import/gen3/lua.ts";
import { matchAll as matchAllCaps } from "../platform/lpattern.ts";
import { ipairs, len, seq } from "../platform/lt.ts";
import { Display } from "../core/display.ts";
import { RomText } from "../core/rom_text.ts";
import { SE } from "../core/se_ids.ts";
import { Audio } from "../core/audio.ts";
import { Runtime } from "../core/runtime.ts";
import { Window } from "./window.ts";

export interface ChoiceLayout {
  style?: string; left?: unknown; top?: unknown; maxRight?: unknown; cols?: unknown; ignoreBPress?: boolean;
  [k: string]: unknown;
}

/** `pcall(function() require("src.core.game3.audio").playSe(SE.SE_SELECT) end)`: errors are swallowed, as pcall does. */
function playSelect(): void {
  try { Audio.playSe(SE.SE_SELECT); } catch { /* pcall */ }
}

export const Choice = {
  active: false,
  kind: undefined as string | undefined, // "yesno" | "multi"
  options: undefined as (string | null)[] | undefined,
  cursor: 1,
  done: undefined as ((v: any) => void) | undefined,
  left: undefined as number | undefined,
  top: undefined as number | undefined,
  cols: 1,
  ignoreBPress: false,
  style: undefined as string | undefined,
  maxRight: undefined as number | undefined,

  // Lua: choice.lua:20
  isOpen(): boolean {
    return Choice.active ? true : false;
  },

  // pokefirered/src/main.c:480
  // Lua: choice.lua:25
  reset(): boolean {
    Choice.active = false;
    Choice.kind = undefined;
    Choice.options = undefined;
    Choice.cursor = 1;
    Choice.done = undefined;
    Choice.left = undefined;
    Choice.top = undefined;
    Choice.cols = 1;
    Choice.ignoreBPress = false;
    Choice.style = undefined;
    return true;
  },

  // Lua: choice.lua:39
  yesNo(cb: ((yes: boolean) => void) | undefined, layout?: ChoiceLayout): void {
    Choice.active = true;
    Choice.kind = "yesno";
    layout = layout || {};
    Choice.style = layout.style;
    if (layout.style === "battle") {
      // pokefirered/src/battle_message.c:1288
      const caps = matchAll2(RomText.plain("gText_BattleYesNoChoice"));
      Choice.options = seq(caps[0], caps[1]) as (string | null)[];
    } else {
      // pokefirered/src/strings.c:414
      Choice.options = seq(RomText.plain("gText_Yes"), RomText.plain("gText_No"));
    }
    Choice.cursor = 1;
    Choice.done = cb;
    // pokefirered/src/new_menu_helpers.c:48
    Choice.left = tonumber(layout.left) ?? 21;
    Choice.top = tonumber(layout.top) ?? 9;
    Choice.maxRight = undefined;
    Choice.cols = 1;
    Choice.ignoreBPress = layout.ignoreBPress || false;
  },

  // Lua: choice.lua:62
  multi(options: (string | null)[] | undefined, defaultIdx: unknown, cb: ((idx: number) => void) | undefined, layout?: ChoiceLayout): void {
    Choice.active = true;
    Choice.kind = "multi";
    Choice.style = undefined;
    Choice.options = options || seq();
    Choice.cursor = (tonumber(defaultIdx) ?? 0) + 1;
    if (Choice.cursor < 1) Choice.cursor = 1;
    if (Choice.cursor > len(Choice.options)) Choice.cursor = 1;
    Choice.done = cb;
    layout = layout || {};
    Choice.left = tonumber(layout.left) ?? (Display.COLS - 10);
    Choice.top = tonumber(layout.top) ?? 5;
    Choice.maxRight = tonumber(layout.maxRight);
    Choice.cols = tonumber(layout.cols) ?? 1;
    Choice.ignoreBPress = layout.ignoreBPress || false;
  },

  // Lua: choice.lua:79
  move(dy?: number, dx?: number): void {
    if (!Choice.active || !Choice.options) return;
    const n = len(Choice.options);
    if (n < 1) return;
    const cols = Choice.cols || 1;
    if (cols <= 1) {
      let delta = dy || 0;
      if (delta === 0 && dx != null) delta = dx;
      if (delta !== 0) {
        Choice.cursor = mod(Choice.cursor - 1 + delta, n) + 1;
        playSelect();
      }
      return;
    }

    // 2D Grid navigation
    const rows = Math.ceil(n / cols);
    const cur = Choice.cursor - 1;
    let curCol = mod(cur, cols);
    let curRow = Math.floor(cur / cols);

    if (dy != null && dy !== 0) {
      curRow = mod(curRow + dy, rows);
    }
    if (dx != null && dx !== 0) {
      curCol = mod(curCol + dx, cols);
    }

    let target = curRow * cols + curCol;
    if (target >= n) {
      target = n - 1;
    }
    if (target + 1 !== Choice.cursor) {
      Choice.cursor = target + 1;
      playSelect();
    }
  },

  // Lua: choice.lua:117
  confirm(): void {
    if (!Choice.active) return;
    playSelect();
    const cb = Choice.done;
    const kind = Choice.kind;
    const cursor = Choice.cursor;
    Choice.active = false;
    Choice.kind = undefined;
    Choice.options = undefined;
    Choice.cols = 1;
    Choice.ignoreBPress = false;
    Choice.done = undefined;
    if (!cb) return;
    if (kind === "yesno") {
      cb(cursor === 1);
    } else {
      cb(cursor - 1);
    }
  },

  // Lua: choice.lua:137
  cancel(): void {
    if (!Choice.active) return;
    if (Choice.ignoreBPress) {
      return;
    }
    playSelect(); // pokefirered/src/menu_helpers.c:57
    const cb = Choice.done;
    const kind = Choice.kind;
    Choice.active = false;
    Choice.kind = undefined;
    Choice.options = undefined;
    Choice.cols = 1;
    Choice.ignoreBPress = false;
    Choice.done = undefined;
    if (!cb) return;
    if (kind === "yesno") {
      cb(false);
    } else {
      cb(127); // FRLG B-cancel often 0x7F
    }
  },

  // Lua: choice.lua:159
  autoPick(indexOrYes: unknown): void {
    if (!Choice.active) return;
    if (Choice.kind === "yesno") {
      Choice.cursor = truthy(indexOrYes) ? 1 : 2;
    } else {
      Choice.cursor = (tonumber(indexOrYes) ?? 0) + 1;
    }
    Choice.confirm();
  },

  // Lua: choice.lua:169
  draw(): void {
    if (!Choice.active || !Choice.options) return;
    if (Choice.style === "battle" && Choice.kind === "yesno") {
      // pokefirered/src/battle_script_commands.c:9775
      const L = Choice.left!, Tp = Choice.top!;
      const session = Runtime && Runtime.getSession ? Runtime.getSession() : undefined;
      const opts = session !== null && typeof session === "object" ? session.options : undefined;
      const frameType = tonumber(opts !== null && typeof opts === "object" ? opts.frameType : undefined) ?? 0;
      // pokefirered/src/battle_bg.c:693
      Window.userFrame(Window.template(L, Tp, 5, 4), frameType);
      for (const [i, lab] of ipairs<string>(Choice.options)) {
        const rowPx = (Tp + (i - 1) * 2) * 8;
        if (i === Choice.cursor) Window.cursorPx(L * 8, rowPx);
        // pokefirered/src/battle_message.c:2574
        Window.printPx(lab, (L + 1) * 8, rowPx + 2);
      }
      return;
    }

    if (Choice.kind === "yesno") {
      // pokefirered/src/menu.c:531
      const L = Choice.left!, Tp = Choice.top!;
      Window.stdFrame(Window.template(L, Tp, 6, 4));
      for (const [i, lab] of ipairs<string>(Choice.options)) {
        const rowPx = Tp * 8 + 2 + (i - 1) * 14;
        if (i === Choice.cursor) Window.cursorPx(L * 8, rowPx);
        Window.printPx(lab, L * 8 + 8, rowPx);
      }
      return;
    }

    const n = len(Choice.options);
    const cols = Choice.cols || 1;
    if (cols <= 1) {
      let tw = 8;
      for (const [, lab] of ipairs<string>(Choice.options)) {
        const need = Math.min(18, Math.max(6, Math.floor(tostring(lab).length * 0.7) + 2));
        if (need > tw) tw = need;
      }
      const th = Math.max(2, Math.ceil((n * Window.OPTION_HEIGHT) / 8));
      let tx = Choice.left ?? (Display.COLS - tw - 2);
      if (Choice.kind === "multi" && Choice.maxRight != null && tx + tw > Choice.maxRight) {
        tx = Choice.maxRight - tw;
      }
      const ty = Choice.top ?? 5;
      Window.stdFrame(Window.template(tx, ty, tw, th));
      const leftPx = tx * 8;
      const topPx = ty * 8;
      for (const [i, lab] of ipairs<string>(Choice.options)) {
        const yPx = Window.menuRowPx(topPx, i);
        if (i === Choice.cursor) Window.cursorPx(leftPx, yPx);
        Window.printPx(lab, leftPx + Window.CURSOR_WIDTH, yPx);
      }
    } else {
      // Multi-column grid
      const rows = Math.ceil(n / cols);
      const colTileWidths: number[] = seq() as number[];
      for (let c = 1; c <= cols; c++) {
        let maxW = 4;
        for (let r = 1; r <= rows; r++) {
          const idx = (r - 1) * cols + c;
          if (idx <= n) {
            const lab = tostring(Choice.options[idx] ?? "");
            const need = Math.floor(lab.length * 0.7) + 2;
            if (need > maxW) maxW = need;
          }
        }
        colTileWidths[c] = maxW;
      }
      let totalTileW = 0;
      for (let c = 1; c <= cols; c++) {
        totalTileW = totalTileW + colTileWidths[c]!;
      }
      const th = Math.max(2, Math.ceil((rows * Window.OPTION_HEIGHT) / 8));
      let tx = Choice.left ?? 2;
      if (Choice.maxRight != null && tx + totalTileW > Choice.maxRight) {
        tx = Choice.maxRight - totalTileW;
      }
      if (tx < 0) tx = 0;
      const ty = Choice.top ?? 5;
      Window.stdFrame(Window.template(tx, ty, totalTileW, th));

      const topPx = ty * 8;
      for (const [i, lab] of ipairs<string>(Choice.options)) {
        const idx0 = i - 1;
        const c = mod(idx0, cols) + 1;
        const r = Math.floor(idx0 / cols) + 1;

        let colOffsetTiles = 0;
        for (let prevC = 1; prevC <= c - 1; prevC++) {
          colOffsetTiles = colOffsetTiles + colTileWidths[prevC]!;
        }
        const colLeftPx = (tx + colOffsetTiles) * 8;
        const yPx = Window.menuRowPx(topPx, r);

        if (i === Choice.cursor) {
          Window.cursorPx(colLeftPx, yPx);
        }
        Window.printPx(lab, colLeftPx + Window.CURSOR_WIDTH, yPx);
      }
    }
  },
};

/** `s:match("^(.-)\n(.*)$")` -> both captures (nil, nil on no match). */
function matchAll2(s: string): [string | undefined, string | undefined] {
  const m = matchAllCaps(s, "^(.-)\n(.*)$");
  return m ? [m[0] as string, m[1] as string] : [undefined, undefined];
}


export default Choice;
