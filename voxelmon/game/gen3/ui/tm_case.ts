// Port of gen1recomp src/ui/game3/tm_case.lua (GPLv3 + additional terms; see LICENSE.md).
// FRLG TM Case Sub-Container UI (item_menu.c / tm_case.c).
// 1:1 layout matching pret pokefirered:
// - WIN_TITLE: (0, 1, 10, 2) -> (0, 8, 80, 16), centered title "TM CASE"
// - WIN_LIST: (10, 1, 19, 10) -> (80, 8, 152, 80), 5 visible rows on dashed lines
// - WIN_DESCRIPTION: (12, 12, 18, 8) -> (96, 96, 144, 64), text at (98, 100)
// - WIN_MOVE_INFO_LABELS: (1, 13, 5, 6) -> (8, 104, 40, 48), TYPE / POWER / ACCURACY / PP
// - WIN_MOVE_INFO: (7, 13, 5, 6) -> (56, 104, 40, 48), Type Badge & right-aligned values
// - Disc Sprite: centered at (41, 46) -> top-left at (25, 30)
// - WIN_USE_GIVE_EXIT: (22, 13, 7, 6) -> (176, 104, 56, 48)

import { format, mod, tonumber, truthy } from "../../../import/gen3/lua.ts";
import { G } from "../platform/graphics.ts";
import type { Quad } from "../platform/image.ts";
import { ipairs, len, seq, type LuaTable } from "../platform/lt.ts";
import { Stack } from "./stack.ts";
import { Window } from "./window.ts";
import { FrlgFont } from "./frlg_font.ts";
import { SummaryChrome } from "./summary_chrome.ts";
import { PartyMenu } from "./party_menu.ts";
import { BagChrome } from "./bag_chrome.ts";
import { SellFlow } from "./sell_flow.ts";
import { ItemsData } from "../core/items_data.ts";
import { Bag, type BagRow } from "../core/bag.ts";
import { Pokemon } from "../core/pokemon.ts";
import { SummaryData } from "../core/summary_data.ts";
import { RomText } from "../core/rom_text.ts";
import { Trig } from "../core/trig.ts";
import { Audio } from "../core/audio.ts";
import { SE } from "../core/se_ids.ts";
import { G3Lazy } from "../core/lazy_registry.ts";
import type { Seg } from "../core/scripting/text_ir.ts";

export interface TmInput { wasPressed(k: string): boolean; isDown?(k: string): boolean }
export interface TmShowOpts {
  session?: any; bag?: any; onClose?: () => void; sell?: boolean; cursor?: number; scroll?: number;
}

const VISIBLE = 5; // 1:1 pret sTMCaseDynamicResources->maxTMsShown = 5
const ACTIONS = seq("USE", "GIVE", "EXIT") as (string | null)[];

// src/list_menu.c:73 sMenuInfoIcons TYPE, POWER, ACCURACY, PP
const INFO_LABEL_RECTS = seq(seq(64, 80), seq(0, 96), seq(64, 96), seq(0, 112)) as ((number | null)[] | null)[];
const INFO_LABEL_QUADS: Record<number, Quad> = {};

// Lua: tm_case.lua:38
function se(id: unknown): void {
  try {
    if (Audio && Audio.playSe) Audio.playSe(id);
  } catch { /* pcall */ }
}

// Lua: tm_case.lua:56
function get_total_count(): number {
  const rows = TmCase.list();
  return len(rows) + 1; // +1 for Cancel
}
void get_total_count; // unused in Brian's file too

// Lua: tm_case.lua:61
function clamp_cursor(): (BagRow | null)[] {
  const rows = TmCase.list();
  const total = len(rows) + 1;
  if (total < 1) {
    TmCase.cursor = 1;
    TmCase.scroll = 0;
    return rows;
  }
  if (TmCase.cursor > total) TmCase.cursor = total;
  if (TmCase.cursor < 1) TmCase.cursor = 1;
  if (TmCase.cursor <= TmCase.scroll) {
    TmCase.scroll = TmCase.cursor - 1;
  }
  if (TmCase.cursor > TmCase.scroll + VISIBLE) {
    TmCase.scroll = TmCase.cursor - VISIBLE;
  }
  if (TmCase.scroll < 0) TmCase.scroll = 0;
  return rows;
}

// src/menu_indicators.c:270 SpriteCallback_ScrollIndicatorArrow
// Lua: tm_case.lua:232
function arrowBob(freq: number): number {
  const v = Trig.sin(mod((TmCase._arrowK ?? 0) * freq, 256)) * 2 / 256;
  return v < 0 ? Math.ceil(v) : Math.floor(v);
}

const EXT_FONT = 0x06, EXT_CLEAR = 0x11, EXT_CLEAR_TO = 0x13;
const FONT_SMALL = 0;

// Lua: tm_case.lua:241
// The IR is TextIR's own 0-based Seg[] (see core/rom_text.ts), and so is an
// ext segment's args (Lua args[1] -> args[0]).
function labelIr(itemId: any): Seg[] {
  const out: Seg[] = [];
  const add = (key: string): void => {
    for (const seg of RomText.ir(key)) {
      if (seg.t !== "eos") out.push(seg);
    }
  };
  const tmNum = ItemsData.tmNumber(itemId) ?? 0;
  // src/tm_case.c:678 GetTMNumberAndMoveString
  add("gText_FontSmall");
  if (ItemsData.isHm(itemId)) {
    add("sText_ClearTo18");
    add("gText_NumberClear01");
    out.push({ t: "text", s: format("%01d", tmNum) });
  } else {
    add("gText_NumberClear01");
    out.push({ t: "text", s: format("%02d", tmNum) });
  }
  add("sText_SingleSpace");
  add("gText_FontNormal");
  out.push({ t: "text", s: Pokemon.moveName(Pokemon.moveFromTmItem(itemId)) || "" });
  return out;
}

// Lua: tm_case.lua:265
function drawTmLabel(itemId: any, x: number, y: number): void {
  let px = x, small = false;
  for (const seg of labelIr(itemId)) {
    if (seg.t === "ext" && seg.cmd === EXT_FONT) {
      small = (seg.args ? seg.args[0] : undefined) === FONT_SMALL;
    } else if (seg.t === "ext" && seg.cmd === EXT_CLEAR) {
      px = px + ((seg.args ? seg.args[0] : undefined) ?? 0);
    } else if (seg.t === "ext" && seg.cmd === EXT_CLEAR_TO) {
      px = Math.max(px, x + ((seg.args ? seg.args[0] : undefined) ?? 0));
    } else if (seg.t === "text") {
      const [, endX] = FrlgFont.draw(seg.s, px, y, { small, colors: FrlgFont.COLOR.NORMAL });
      px = endX!;
    }
  }
}

export const TmCase = {
  isMenu: true,

  open: false,
  cursor: 1,
  scroll: 0,
  mode: "list", // "list" | "action" | "message"
  actionCursor: 1,
  messageText: undefined as string | undefined,

  _session: undefined as any,
  _bag: undefined as any,
  _onClose: undefined as (() => void) | undefined,
  _sellMode: false,
  _sell: undefined as SellFlow | undefined,
  _arrowK: undefined as number | undefined,

  labelIr,

  // Lua: tm_case.lua:45
  isOpen(): boolean {
    return TmCase.open;
  },

  // Lua: tm_case.lua:49
  list(): (BagRow | null)[] {
    const bag = TmCase._bag;
    if (!bag) return seq();
    const rows = Bag.listPocket(bag, "TM_CASE");
    return rows || seq();
  },

  // Lua: tm_case.lua:81
  show(session?: any, bag?: any, opts?: TmShowOpts): void {
    opts = opts || {};
    TmCase.open = true;
    TmCase._session = session || opts.session;
    TmCase._bag = bag || opts.bag || (session && session.bag);
    TmCase._onClose = opts.onClose;
    TmCase._sellMode = opts.sell ? true : false;
    TmCase._sell = undefined;
    TmCase.cursor = opts.cursor || 1;
    TmCase.scroll = opts.scroll || 0;
    TmCase.mode = "list";
    TmCase.actionCursor = 1;
    TmCase.messageText = undefined;
    clamp_cursor();
    Stack.push("tm_case", TmCase as unknown as LuaTable, { hideBelow: true, fullscreen: true });
  },

  // Lua: tm_case.lua:98
  close(): void {
    TmCase.open = false;
    Stack.pop("tm_case");
    const cb = TmCase._onClose;
    TmCase._onClose = undefined;
    if (cb) cb();
  },

  // Lua: tm_case.lua:106
  handleInput(input: TmInput): void {
    if (TmCase.mode === "sell" && TmCase._sell) {
      TmCase._sell.handleInput(input);
      return;
    }
    if (TmCase.mode === "message") {
      if (input.wasPressed("a") || input.wasPressed("b") || input.wasPressed("start")) {
        se(SE.SE_SELECT);
        TmCase.mode = "list";
        TmCase.messageText = undefined;
        clamp_cursor();
      }
      return;
    }

    if (TmCase.mode === "action") {
      if (input.wasPressed("up")) {
        TmCase.actionCursor = mod(TmCase.actionCursor - 2, len(ACTIONS)) + 1;
        se(SE.SE_SELECT);
      } else if (input.wasPressed("down")) {
        TmCase.actionCursor = mod(TmCase.actionCursor, len(ACTIONS)) + 1;
        se(SE.SE_SELECT);
      } else if (input.wasPressed("a")) {
        se(SE.SE_SELECT);
        const act = ACTIONS[TmCase.actionCursor];
        const rows = clamp_cursor();
        const row = rows[TmCase.cursor];
        if (act === "EXIT" || !row) {
          TmCase.mode = "list";
        } else if (act === "GIVE") {
          TmCase.mode = "message";
          // src/tm_case.c:1078
          TmCase.messageText = RomText.box("gText_ItemCantBeHeld", { stringVars: seq(ItemsData.displayName(row.id)) });
        } else if (act === "USE") {
          const party = (TmCase._session && TmCase._session.party) || seq();
          if (len(party) === 0) {
            TmCase.mode = "message";
            TmCase.messageText = RomText.plain("gText_ThereIsNoPokemon");
          } else {
            PartyMenu.show(party, TmCase._session && TmCase._session.moveOverlay, {
              session: TmCase._session,
              bag: TmCase._bag,
              item: row.id,
              mode: "use",
              onClose: () => {
                TmCase.mode = "list";
                clamp_cursor();
              },
            });
          }
        }
      } else if (input.wasPressed("b")) {
        se(SE.SE_SELECT); // pokefirered/src/tm_case.c:1006
        TmCase.mode = "list";
      }
      return;
    }

    // List mode navigation
    const rows = clamp_cursor();
    const total = len(rows) + 1;

    if (input.wasPressed("up")) {
      if (total > 0) {
        TmCase.cursor = mod(TmCase.cursor - 2, total) + 1;
        clamp_cursor();
        se(SE.SE_SELECT);
      }
    } else if (input.wasPressed("down")) {
      if (total > 0) {
        TmCase.cursor = mod(TmCase.cursor, total) + 1;
        clamp_cursor();
        se(SE.SE_SELECT);
      }
    } else if (input.wasPressed("left") || input.wasPressed("l")) {
      if (total > 0) {
        TmCase.cursor = Math.max(1, TmCase.cursor - VISIBLE);
        clamp_cursor();
        se(SE.SE_SELECT);
      }
    } else if (input.wasPressed("right") || input.wasPressed("r")) {
      if (total > 0) {
        TmCase.cursor = Math.min(total, TmCase.cursor + VISIBLE);
        clamp_cursor();
        se(SE.SE_SELECT);
      }
    } else if (input.wasPressed("a")) {
      if (TmCase.cursor === total) {
        // Clicked CANCEL
        se(SE.SE_SELECT); // pokefirered/src/tm_case.c:915
        TmCase.close();
      } else {
        const row = rows[TmCase.cursor];
        if (row && TmCase._sellMode) {
          se(SE.SE_SELECT);
          // src/tm_case.c:1157 Task_SelectedTMHM_Sell
          TmCase.mode = "sell";
          TmCase._sell = SellFlow.start({
            itemId: row.id,
            owned: row.qty,
            session: TmCase._session,
            bag: TmCase._bag,
            onDone: () => {
              TmCase._sell = undefined;
              TmCase.mode = "list";
              clamp_cursor();
            },
          });
        } else if (row) {
          TmCase.mode = "action";
          TmCase.actionCursor = 1;
          se(SE.SE_SELECT);
        }
      }
    } else if (input.wasPressed("b") || input.wasPressed("start")) {
      se(SE.SE_SELECT); // pokefirered/src/tm_case.c:915
      TmCase.close();
    }
  },

  // Lua: tm_case.lua:227
  update(): void {
    if (TmCase.open) TmCase._arrowK = (TmCase._arrowK ?? 0) + 1;
  },

  // Lua: tm_case.lua:282
  draw(): void {
    if (!TmCase.open) return;
    const rows = clamp_cursor();
    const total = len(rows) + 1;
    const isCancel = (TmCase.cursor === total);
    const sel = !isCancel ? rows[TmCase.cursor] : undefined;

    // pcall(require, "src.ui.game3.tm_case_chrome"): no such module here
    // unless a port registers it in G3Lazy.
    const TmCaseChrome = G3Lazy["src.ui.game3.tm_case_chrome"];
    const hasChrome = !!(TmCaseChrome && TmCaseChrome.ready && truthy(TmCaseChrome.ready()));
    let isFemale = false;
    const session = TmCase._session;
    if (session && (session.gender === 1 || session.gender === "female" || session.playerGender === 1)) {
      isFemale = true;
    }

    // 1. Background (240x160) - BG2 Base
    if (hasChrome) {
      TmCaseChrome.drawBg(0, 0, { female: isFemale });
    } else {
      G.setColor(0.18, 0.42, 0.58, 1);
      G.rectangle("fill", 0, 0, 240, 160);
      Window.stdFrame(Window.template(1, 4, 11, 15));
      Window.stdFrame(Window.template(13, 1, 16, 18));
    }

    // 2. Disc Sprite (in between BG2 and BG1)
    if (sel) {
      const moveId = Pokemon.moveFromTmItem(sel.id);
      const moveRow = Pokemon.battleMove(moveId) || {};
      const typeIdx = tonumber(moveRow.type) ?? 0;
      const isHm = ItemsData.isHm(sel.id);
      const tmNum = ItemsData.tmNumber(sel.id) || 1;
      const tmIdx = isHm ? (tmNum - 1) : (tmNum - 1 + 8);

      // 1:1 dynamic rack positioning formula from pokefirered SetDiscSpritePosition:
      const cx = 41 - Math.floor((14 * tmIdx) / 58);
      const cy = 46 + Math.floor((8 * tmIdx) / 58);

      if (hasChrome) TmCaseChrome.drawDisc(typeIdx, cx - 16, cy - 16, isHm);
    }

    // 3. Pocket Cover Overlay (BG1 Priority 0 over Disc Sprite)
    if (hasChrome) {
      TmCaseChrome.drawCover(0, 0, { female: isFemale });
    }

    // 4. Header Title: "TM CASE" (WIN_TITLE: 0, 1, 10, 2 -> 72px center at y=9)
    // src/tm_case.c:1528
    const title = RomText.plain("gText_TMCase");
    const tw = FrlgFont.measure(title);
    const tx = Math.floor((72 - tw) / 2) + 4;
    FrlgFont.draw(title, tx, 9, { colors: FrlgFont.COLOR.LIGHT });

    // 4. Left Pane: Move Details (WIN_MOVE_INFO_LABELS & WIN_MOVE_INFO: y=104..152)
    // src/tm_case.c:1531 DrawMoveInfoLabels
    const infoImg = SummaryChrome.menuInfoImage();
    if (!truthy(infoImg)) throw new Error("menu_info");
    G.setColor(1, 1, 1, 1);
    for (const [i, r] of ipairs<(number | null)[]>(INFO_LABEL_RECTS)) {
      INFO_LABEL_QUADS[i] = INFO_LABEL_QUADS[i] || G.newQuad(r[1]!, r[2]!, 40, 12, 128, 128);
      G.draw(infoImg!, INFO_LABEL_QUADS[i], 8, 104 + (i - 1) * 12);
    }

    if (sel) {
      const moveId = Pokemon.moveFromTmItem(sel.id);
      const moveRow = Pokemon.battleMove(moveId) || {};
      const moveType = tonumber(moveRow.type) ?? 0;
      const power = tonumber(moveRow.power) ?? 0;
      const accuracy = tonumber(moveRow.accuracy) ?? 0;
      const pp = tonumber(moveRow.pp) ?? 0;

      // Type Badge (32x12 at x=44, y=104)
      SummaryChrome.drawTypeBadge(moveType, 44, 104);

      // Values (x=52..68, right-aligned)
      const powStr = power >= 2 ? format("%3d", power) : "---";
      const accStr = accuracy > 0 ? format("%3d", accuracy) : "---";
      const ppStr = pp > 0 ? format("%3d", pp) : "---";

      FrlgFont.draw(powStr, 56, 116, { colors: FrlgFont.COLOR.NORMAL });
      FrlgFont.draw(accStr, 56, 128, { colors: FrlgFont.COLOR.NORMAL });
      FrlgFont.draw(ppStr, 56, 140, { colors: FrlgFont.COLOR.NORMAL });
    } else {
      // Cancel / Empty selected
      FrlgFont.draw("---", 56, 104, { colors: FrlgFont.COLOR.NORMAL });
      FrlgFont.draw("---", 56, 116, { colors: FrlgFont.COLOR.NORMAL });
      FrlgFont.draw("---", 56, 128, { colors: FrlgFont.COLOR.NORMAL });
      FrlgFont.draw("---", 56, 140, { colors: FrlgFont.COLOR.NORMAL });
    }

    // 5. Right Pane: List Menu (WIN_LIST: 10, 1, 19, 10 -> x=80, y=8, 5 visible rows)
    // src/tm_case.c:773 CreateListScrollArrows
    // pcall(require, "src.ui.game3.bag_chrome")
    if (BagChrome && BagChrome.drawArrow) {
      if (TmCase.scroll > 0) {
        BagChrome.drawArrow("up", 152, arrowBob(8));
      }
      if (TmCase.scroll + VISIBLE < total) {
        BagChrome.drawArrow("down", 152, 80 + arrowBob(-8));
      }
    }

    for (let i = 1; i <= VISIBLE; i++) {
      const idx = TmCase.scroll + i;
      if (idx > total) break;
      const y = 10 + (i - 1) * 16;

      // src/tm_case.c:769 PrintListCursorAtRow
      if (idx === TmCase.cursor && TmCase.mode === "list") {
        Window.cursorPx(80, y);
      }

      if (idx <= len(rows)) {
        const r = rows[idx]!;
        const isHm = ItemsData.isHm(r.id);
        drawTmLabel(r.id, 88, y);
        // src/tm_case.c:718 List_ItemPrintFunc
        if (isHm) {
          if (hasChrome) TmCaseChrome.drawHmIcon(88, y);
        } else {
          FrlgFont.draw(RomText.plain("gText_TimesStrVar1", { stringVars: seq(format("%3d", r.qty || 1)) }),
            206, y, { small: true, colors: FrlgFont.COLOR.NORMAL });
        }
      } else {
        // src/tm_case.c:655
        FrlgFont.draw(RomText.plain("gText_Close"), 88, y, { colors: FrlgFont.COLOR.NORMAL });
      }
    }

    // 6. Bottom Description Pane (WIN_DESCRIPTION: 12, 12, 18, 8 -> text at 98, 100)
    if (TmCase.mode !== "action") {
      let descText: string | undefined;
      if (isCancel) {
        descText = RomText.plain("gText_TMCaseWillBePutAway");
      } else if (sel) {
        const moveId = Pokemon.moveFromTmItem(sel.id);
        const moveName = Pokemon.moveName(moveId) || "---";
        descText = SummaryData.moveDescription(moveId, moveName);
        if (!descText || descText === "---") {
          descText = sel.description || ItemsData.description(sel.id);
        }
      }
      if (descText) {
        const wrapped = FrlgFont.wrap(descText, 136);
        FrlgFont.draw(wrapped, 98, 100, { maxWidth: 136, linePitch: 14, colors: FrlgFont.COLOR.LIGHT });
      }
    }

    // 7. Action Pop-up Menu (WIN_USE_GIVE_EXIT: 22, 13, 7, 6 -> 176, 104, 56, 48)
    if (TmCase.mode === "action" && sel) {
      // Bottom left prompt window (WIN_SELECTED_MSG: 5, 15, 15, 4 -> 40, 120, 120, 32)
      Window.stdFrame(Window.template(5, 15, 15, 4));
      // src/tm_case.c:980, :678 GetTMNumberAndMoveString
      const tmLabel = format(ItemsData.isHm(sel.id) ? "%s%d %s" : "%s%02d %s",
        RomText.plain("gText_NumberClear01"), ItemsData.tmNumber(sel.id),
        Pokemon.moveName(Pokemon.moveFromTmItem(sel.id)));
      FrlgFont.draw(RomText.box("gText_Var1IsSelected", { stringVars: seq(tmLabel) }), 44, 122,
        { maxWidth: 112, linePitch: 14, colors: FrlgFont.COLOR.NORMAL });

      const popX = 22;
      const popY = 13;
      const popW = 7;
      const popH = 6;
      Window.stdFrame(Window.template(popX, popY, popW, popH));
      for (const [i] of ipairs(ACTIONS)) {
        const rowY = (popY * 8) + (i - 1) * 16 + 2;
        if (i === TmCase.actionCursor) {
          Window.cursorPx(popX * 8 + 1, rowY);
        }
        // src/tm_case.c:221 sMenuActions
        FrlgFont.draw(RomText.at("sMenuActions", i - 1), popX * 8 + 9, rowY, { colors: FrlgFont.COLOR.NORMAL });
      }
    }

    if (TmCase.mode === "sell" && TmCase._sell) {
      TmCase._sell.draw();
    }

    // 8. Message Modal
    if (TmCase.mode === "message" && TmCase.messageText) {
      Window.stdFrame(Window.template(2, 15, 26, 4));
      const wrapped = FrlgFont.wrap(TmCase.messageText, 192);
      FrlgFont.draw(wrapped, 20, 122, { maxWidth: 192, linePitch: 14, colors: FrlgFont.COLOR.NORMAL });
    }
  },
};

export default TmCase;
