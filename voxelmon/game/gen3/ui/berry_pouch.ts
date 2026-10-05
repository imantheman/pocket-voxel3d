// Port of gen1recomp src/ui/game3/berry_pouch.lua (GPLv3 + additional terms; see LICENSE.md).
// FRLG Berry Pouch UI 1:1 with pokefirered (berry_pouch.c).
//
// Window Layouts (pokefirered/src/berry_pouch.c):
//   WIN_LIST:        tilemapLeft=11, tilemapTop=1,  width=18, height=14 -> (88, 8, 144, 112), 7 visible rows, pitch=16
//   WIN_DESCRIPTION: tilemapLeft=5,  tilemapTop=16, width=25, height=4  -> (40, 128, 200, 32), text at (40, 130)
//   WIN_HEADER:      tilemapLeft=1,  tilemapTop=1,  width=9,  height=2  -> (8, 8, 72, 16), text centered at (tx, 9)
//   WIN_SELECTED:    tilemapLeft=6,  tilemapTop=15, width=14, height=4  -> (48, 120, 112, 32)
//   WIN_CONTEXT:     tilemapLeft=22, tilemapTop=11, width=7,  height=8  -> (176, 88, 56, 64)
//   WIN_TOSS_LABEL:  tilemapLeft=6,  tilemapTop=15, width=16, height=4  -> (48, 120, 128, 32)
//   WIN_TOSS_QTY:    tilemapLeft=24, tilemapTop=15, width=5,  height=4  -> (192, 120, 40, 32)
//   WIN_TOSS_PROMPT: tilemapLeft=6,  tilemapTop=15, width=15, height=4  -> (48, 120, 120, 32)
//   WIN_YES_NO:      tilemapLeft=23, tilemapTop=15, width=6,  height=4  -> (184, 120, 48, 32)
//   WIN_MSG:         tilemapLeft=2,  tilemapTop=15, width=26, height=4  -> (16, 120, 208, 32)
//
// Sprites:
//   Berry Pouch Sprite: 64x64 centered at (40, 76) -> top-left (8, 44), wobbles on open and cursor move.
//   Item Icon Sprite:   24x24 centered in 32x32 at (24, 147) -> top-left (12, 135).

import { format, mod, tonumber, tostring, truthy } from "../../../import/gen3/lua.ts";
import { G } from "../platform/graphics.ts";
import { ipairs, len, seq, type LuaTable } from "../platform/lt.ts";
import { Stack } from "./stack.ts";
import { Window } from "./window.ts";
import { FrlgFont } from "./frlg_font.ts";
import { PartyMenu } from "./party_menu.ts";
import { BagMenu } from "./bag_menu.ts";
import { BagChrome } from "./bag_chrome.ts";
import { SellFlow } from "./sell_flow.ts";
import { ItemsData } from "../core/items_data.ts";
import { Bag, type BagRow } from "../core/bag.ts";
import { ItemUse } from "../core/item_use.ts";
import { PartyView } from "../core/battle/party_view.ts";
import { BattleItems } from "../core/battle/items.ts";
import { Battle } from "../core/battle.ts";
import { RomText } from "../core/rom_text.ts";
import { Audio } from "../core/audio.ts";
import { SE } from "../core/se_ids.ts";
import { G3Lazy } from "../core/lazy_registry.ts";

export interface BerryInput { wasPressed(k: string): boolean; isDown?(k: string): boolean }
export interface BerryShowOpts {
  session?: any; bag?: any; onClose?: () => void; sell?: boolean; fromBerryCrush?: boolean;
  cursor?: number; scroll?: number;
}

const VISIBLE = 7;
const ACTIONS = seq("USE", "GIVE", "TOSS", "EXIT") as (string | null)[];
const ACTION_TEXT: Record<string, number> = { USE: 0, TOSS: 1, GIVE: 2, EXIT: 3 };

const UP = "\xE2\x96\xB2"; // ▲
const DOWN = "\xE2\x96\xBC"; // ▼
const TIMES = "\xC3\x97"; // ×
const NUMERO = "\xE2\x84\x96"; // №

// Lua: berry_pouch.lua:45
function se(id: unknown): void {
  try {
    if (Audio && Audio.playSe) Audio.playSe(id);
  } catch { /* pcall */ }
}

// Lua: berry_pouch.lua:63
function clamp_cursor(): [(BagRow | null)[], number] {
  const rows = BerryPouch.list();
  // src/berry_pouch.c:664
  let total = len(rows) + (BerryPouch._fromBerryCrush ? 0 : 1);
  if (total < 1) total = 1;

  if (BerryPouch.cursor > total) BerryPouch.cursor = total;
  if (BerryPouch.cursor < 1) BerryPouch.cursor = 1;

  if (BerryPouch.cursor <= BerryPouch.scroll) {
    BerryPouch.scroll = BerryPouch.cursor - 1;
  }
  if (BerryPouch.cursor > BerryPouch.scroll + VISIBLE) {
    BerryPouch.scroll = BerryPouch.cursor - VISIBLE;
  }
  if (BerryPouch.scroll < 0) BerryPouch.scroll = 0;
  const maxScroll = Math.max(0, total - VISIBLE);
  if (BerryPouch.scroll > maxScroll) BerryPouch.scroll = maxScroll;

  return [rows, total];
}

// Party-menu options for using/giving the selected berry.
//
// In battle this has to go through the battle system: ItemUse.useField, which
// the party menu falls back to, only knows session.party, and that snapshot is
// not written back until the battle ends.  A berry used there would be eaten
// with no effect on the live battler, so hand it to BagMenu instead - the same
// route a potion takes from the bag.
// Lua: berry_pouch.lua:92
function party_opts(row: BagRow, mode: string, party: LuaTable): Record<string, any> {
  const opts: Record<string, any> = {
    session: BerryPouch._session,
    bag: BerryPouch._bag,
    item: row.id,
    mode,
    onClose: () => {
      BerryPouch.mode = "list";
      clamp_cursor();
    },
  };
  if (mode !== "use") return opts;

  // package.loaded["src.core.game3.battle"]
  const st = Battle ? (Battle as any)._st : undefined;
  if (!(st && st.playerParty && BagMenu._battle && BagMenu._onBattleUse
    && BattleItems.needsPartySelect(row.id))) {
    return opts;
  }

  opts.battle = true;
  opts.battleOrder = PartyMenu.battleOrder(st);
  opts.layout = st.double ? "double" : undefined;
  opts.onSelect = (slot: any) => {
    if (!truthy(slot) || slot === 7) {
      PartyMenu.close();
      return;
    }
    const mon = party[slot];
    BagMenu.commitBattlePartyUse(st, row.id, slot, mon, () => { BerryPouch.close(); });
  };
  return opts;
}

export const BerryPouch = {
  isMenu: true,

  open: false,
  cursor: 1,
  scroll: 0,
  mode: "list", // "list" | "action" | "toss_select" | "toss_confirm" | "message"
  actionCursor: 1,
  yesNoCursor: 1,
  tossQty: 1,
  messageText: undefined as string | undefined,
  wobbleTimer: 0,

  _session: undefined as any,
  _bag: undefined as any,
  _onClose: undefined as (() => void) | undefined,
  _sellMode: false,
  _fromBerryCrush: false,
  _sell: undefined as SellFlow | undefined,

  // Lua: berry_pouch.lua:52
  isOpen(): boolean {
    return BerryPouch.open;
  },

  // Lua: berry_pouch.lua:56
  list(): (BagRow | null)[] {
    const bag = BerryPouch._bag;
    if (!bag) return seq();
    const rows = Bag.listPocket(bag, "BERRY_POUCH");
    return rows || seq();
  },

  // Lua: berry_pouch.lua:129
  show(session?: any, bag?: any, opts?: BerryShowOpts): void {
    opts = opts || {};
    BerryPouch.open = true;
    BerryPouch._session = session || opts.session;
    BerryPouch._bag = bag || opts.bag || (session && session.bag);
    BerryPouch._onClose = opts.onClose;
    BerryPouch._sellMode = opts.sell ? true : false;
    BerryPouch._fromBerryCrush = opts.fromBerryCrush ? true : false;
    BerryPouch._sell = undefined;
    BerryPouch.cursor = opts.cursor || 1;
    BerryPouch.scroll = opts.scroll || 0;
    BerryPouch.mode = "list";
    BerryPouch.actionCursor = 1;
    BerryPouch.yesNoCursor = 1;
    BerryPouch.tossQty = 1;
    BerryPouch.messageText = undefined;
    BerryPouch.wobbleTimer = 0.25; // Authentically trigger affine wobble on open
    clamp_cursor();
    Stack.push("berry_pouch", BerryPouch as unknown as LuaTable, { hideBelow: true, fullscreen: true });
  },

  // Lua: berry_pouch.lua:150
  close(): void {
    BerryPouch.open = false;
    Stack.pop("berry_pouch");
    const cb = BerryPouch._onClose;
    BerryPouch._onClose = undefined;
    if (cb) cb();
  },

  // Lua: berry_pouch.lua:158
  update(dt?: number): void {
    if (BerryPouch.wobbleTimer > 0) {
      BerryPouch.wobbleTimer = Math.max(0, BerryPouch.wobbleTimer - (dt ?? 0.016));
    }
  },

  // Lua: berry_pouch.lua:164
  handleInput(input: BerryInput): void {
    if (BerryPouch.mode === "sell" && BerryPouch._sell) {
      BerryPouch._sell.handleInput(input);
      return;
    }
    const [rows, total] = clamp_cursor();
    const row = rows[BerryPouch.cursor];

    // 1. Toss Quantity Select Mode (Task_Toss_SelectMultiple)
    if (BerryPouch.mode === "toss_select") {
      const maxQ = row ? (tonumber(row.qty) ?? 1) : 1;
      if (input.wasPressed("up") || input.wasPressed("right")) {
        if (BerryPouch.tossQty < maxQ) {
          BerryPouch.tossQty = BerryPouch.tossQty + 1;
        } else {
          BerryPouch.tossQty = 1; // wrap around to 1
        }
        se(SE.SE_SELECT);
      } else if (input.wasPressed("down") || input.wasPressed("left")) {
        if (BerryPouch.tossQty > 1) {
          BerryPouch.tossQty = BerryPouch.tossQty - 1;
        } else {
          BerryPouch.tossQty = maxQ; // wrap around to max
        }
        se(SE.SE_SELECT);
      } else if (input.wasPressed("a")) {
        se(SE.SE_SELECT);
        BerryPouch.mode = "toss_confirm";
        BerryPouch.yesNoCursor = 1;
      } else if (input.wasPressed("b")) {
        se(SE.SE_SELECT); // pokefirered/src/berry_pouch.c:1142
        BerryPouch.mode = "list";
      }
      return;
    }

    // 2. Toss Confirmation Mode (Task_AskTossMultiple & CreateYesNoMenuWin3)
    if (BerryPouch.mode === "toss_confirm") {
      if (input.wasPressed("up") || input.wasPressed("down")) {
        BerryPouch.yesNoCursor = (BerryPouch.yesNoCursor === 1) ? 2 : 1;
        se(SE.SE_SELECT);
      } else if (input.wasPressed("b")) {
        se(SE.SE_SELECT); // pokefirered/src/menu_helpers.c:57
        BerryPouch.mode = "list";
      } else if (input.wasPressed("a")) {
        if (BerryPouch.yesNoCursor === 1) {
          // YES: Toss items
          se(SE.SE_SELECT);
          if (row) {
            const bName = row.name || ItemsData.displayName(row.id);
            Bag.remove(BerryPouch._bag, row.id, BerryPouch.tossQty);
            BerryPouch.mode = "message";
            // src/berry_pouch.c:1161
            BerryPouch.messageText = RomText.box("gText_ThrewAwayStrVar2StrVar1s",
              { stringVars: seq(bName, tostring(BerryPouch.tossQty)) });
            clamp_cursor();
          } else {
            BerryPouch.mode = "list";
          }
        } else {
          // NO: Cancel toss
          se(SE.SE_SELECT); // pokefirered/src/menu_helpers.c:57
          BerryPouch.mode = "list";
        }
      }
      return;
    }

    // 3. Message Mode
    if (BerryPouch.mode === "message") {
      if (input.wasPressed("a") || input.wasPressed("b") || input.wasPressed("start")) {
        se(SE.SE_SELECT);
        BerryPouch.mode = "list";
        BerryPouch.messageText = undefined;
        clamp_cursor();
      }
      return;
    }

    // 4. Context Action Menu Mode (Task_NormalContextMenu)
    if (BerryPouch.mode === "action") {
      if (input.wasPressed("up")) {
        BerryPouch.actionCursor = mod(BerryPouch.actionCursor - 2, len(ACTIONS)) + 1;
        se(SE.SE_SELECT);
      } else if (input.wasPressed("down")) {
        BerryPouch.actionCursor = mod(BerryPouch.actionCursor, len(ACTIONS)) + 1;
        se(SE.SE_SELECT);
      } else if (input.wasPressed("a")) {
        se(SE.SE_SELECT);
        const act = ACTIONS[BerryPouch.actionCursor];
        const party: LuaTable = PartyView.live(BerryPouch._session);
        if (act === "EXIT" || !row) {
          BerryPouch.mode = "list";
        } else if (act === "USE") {
          // package.loaded["src.ui.game3.bag_menu"]
          // pokefirered/src/berry_pouch.c:1071
          const battleUse = BagMenu && BagMenu._battle
            && BattleItems.needsPartySelect(row.id);
          if (ItemUse.needsPartyTarget(row.id) || battleUse) {
            if (len(party) === 0) {
              BerryPouch.mode = "message";
              BerryPouch.messageText = RomText.plain("gText_ThereIsNoPokemon");
            } else {
              PartyMenu.show(party, BerryPouch._session && BerryPouch._session.moveOverlay,
                party_opts(row, "use", party));
            }
          } else {
            BerryPouch.mode = "message";
            // src/item_use.c:902 FieldUseFunc_OakStopsYou
            const session = BerryPouch._session;
            BerryPouch.messageText = RomText.box("gText_OakForbidsUseOfItemHere",
              { playerName: tostring((session && (session.name || session.playerName)) || "") });
          }
        } else if (act === "GIVE") {
          if (len(party) === 0) {
            BerryPouch.mode = "message";
            BerryPouch.messageText = RomText.plain("gText_ThereIsNoPokemon");
          } else {
            PartyMenu.show(party, BerryPouch._session && BerryPouch._session.moveOverlay, {
              session: BerryPouch._session,
              bag: BerryPouch._bag,
              item: row.id,
              mode: "give",
              onClose: () => {
                BerryPouch.mode = "list";
                clamp_cursor();
              },
            });
          }
        } else if (act === "TOSS") {
          const maxQ = row ? (tonumber(row.qty) ?? 1) : 1;
          if (maxQ === 1) {
            BerryPouch.tossQty = 1;
            BerryPouch.mode = "toss_confirm";
            BerryPouch.yesNoCursor = 1;
          } else {
            BerryPouch.tossQty = 1;
            BerryPouch.mode = "toss_select";
          }
        }
      } else if (input.wasPressed("b")) {
        se(SE.SE_SELECT); // pokefirered/src/berry_pouch.c:1052
        BerryPouch.mode = "list";
      }
      return;
    }

    // 5. List Navigation Mode (Task_BerryPouchMain)
    if (input.wasPressed("up")) {
      if (total > 0) {
        BerryPouch.cursor = mod(BerryPouch.cursor - 2, total) + 1;
        BerryPouch.wobbleTimer = 0.25;
        clamp_cursor();
        se(SE.SE_SELECT);
      }
    } else if (input.wasPressed("down")) {
      if (total > 0) {
        BerryPouch.cursor = mod(BerryPouch.cursor, total) + 1;
        BerryPouch.wobbleTimer = 0.25;
        clamp_cursor();
        se(SE.SE_SELECT);
      }
    } else if (input.wasPressed("left") || input.wasPressed("l")) {
      if (total > 0) {
        BerryPouch.cursor = Math.max(1, BerryPouch.cursor - VISIBLE);
        BerryPouch.wobbleTimer = 0.25;
        clamp_cursor();
        se(SE.SE_SELECT);
      }
    } else if (input.wasPressed("right") || input.wasPressed("r")) {
      if (total > 0) {
        BerryPouch.cursor = Math.min(total, BerryPouch.cursor + VISIBLE);
        BerryPouch.wobbleTimer = 0.25;
        clamp_cursor();
        se(SE.SE_SELECT);
      }
    } else if (input.wasPressed("a")) {
      if (BerryPouch.cursor === total) {
        // CLOSE option selected
        se(SE.SE_SELECT); // pokefirered/src/berry_pouch.c:963
        BerryPouch.close();
      } else if (row && BerryPouch._sellMode) {
        se(SE.SE_SELECT);
        // src/berry_pouch.c:1266 Task_ContextMenu_Sell
        BerryPouch.mode = "sell";
        BerryPouch._sell = SellFlow.start({
          itemId: row.id,
          owned: row.qty,
          session: BerryPouch._session,
          bag: BerryPouch._bag,
          onDone: () => {
            BerryPouch._sell = undefined;
            BerryPouch.mode = "list";
            clamp_cursor();
          },
        });
      } else if (row) {
        // Berry selected
        BerryPouch.mode = "action";
        BerryPouch.actionCursor = 1;
        se(SE.SE_SELECT);
      }
    } else if (input.wasPressed("b") || input.wasPressed("start")) {
      se(SE.SE_SELECT); // pokefirered/src/berry_pouch.c:957
      BerryPouch.close();
    }
  },

  // Lua: berry_pouch.lua:374
  draw(): void {
    if (!BerryPouch.open) return;
    const [rows, total] = clamp_cursor();
    const sel = rows[BerryPouch.cursor];

    // pcall(require, "src.ui.game3.berry_pouch_chrome"): no such module here
    // unless a port registers it in G3Lazy.
    const BerryPouchChrome = G3Lazy["src.ui.game3.berry_pouch_chrome"];
    const hasChrome = !!(BerryPouchChrome && BerryPouchChrome.ready && truthy(BerryPouchChrome.ready()));
    let isFemale = false;
    const session = BerryPouch._session;
    if (session && (session.gender === 1 || session.gender === "female" || session.playerGender === 1)) {
      isFemale = true;
    }

    // 1. Background (BG 1)
    if (hasChrome) {
      BerryPouchChrome.drawBg(0, 0, { female: isFemale });
    } else {
      // Fallback Background (Berry Pouch Green/Teal Theme)
      G.setColor(0.18, 0.48, 0.35, 1);
      G.rectangle("fill", 0, 0, 240, 160);

      // Header Frame
      Window.stdFrame(Window.template(1, 1, 9, 2));
      // List Menu Frame
      Window.stdFrame(Window.template(11, 1, 18, 14));
      // Description Frame
      Window.stdFrame(Window.template(5, 16, 25, 4));
    }

    // 2. Header (WIN 2: tilemapLeft=1, tilemapTop=1, width=9, height=2 -> 72px center at y=9)
    // src/berry_pouch.c:805
    const headerTitle = RomText.plain("gText_BerryPouch");
    const tw = FrlgFont.measure(headerTitle);
    const tx = Math.floor((72 - tw) / 2) + 8;
    FrlgFont.draw(headerTitle, tx, 9, { colors: FrlgFont.COLOR.LIGHT });

    // 3. Berry Pouch Sprite (64x64 centered at (40, 72) -> top-left at (8, 40))
    let wobbleAngle = 0;
    if (BerryPouch.wobbleTimer > 0) {
      // 1:1 affine wobble oscillation (-2..+2 deltas)
      wobbleAngle = Math.sin((BerryPouch.wobbleTimer / 0.25) * Math.PI * 4) * 0.08;
    }
    if (hasChrome) {
      BerryPouchChrome.drawPouch(8, 40, wobbleAngle);
    }

    // 4. Item Icon Sprite (24x24 centered in 27x27 white box at (20, 143) -> top-left at (8, 131))
    if (sel && BerryPouch.cursor <= len(rows)) {
      // pcall(require, "src.ui.game3.bag_chrome")
      if (BagChrome && BagChrome.drawItemIcon) {
        BagChrome.drawItemIcon(sel.id, 8, 131);
      }
    }

    // 5. Description Box (WIN 1: tilemapLeft=5, tilemapTop=16, width=25, height=4 -> screen (40, 128, 200, 32))
    if (BerryPouch.cursor === total && !BerryPouch._fromBerryCrush) {
      const closeDesc = RomText.plain("gText_TheBerryPouchWillBePutAway");
      FrlgFont.draw(closeDesc, 40, 130, { colors: FrlgFont.COLOR.LIGHT, linePitch: 14 });
    } else if (sel) {
      const desc = sel.description || ItemsData.description(sel.id) || "";
      FrlgFont.draw(desc, 40, 130, { colors: FrlgFont.COLOR.LIGHT, linePitch: 14 });
    }

    // 6. List Menu (WIN 0: tilemapLeft=11, tilemapTop=1, width=18, height=14 -> 7 visible rows, pitch=16)
    if (BerryPouch.scroll > 0) {
      FrlgFont.draw(UP, 160, 8, { colors: FrlgFont.COLOR.DARK_GRAY });
    }
    if (BerryPouch.scroll + VISIBLE < total) {
      FrlgFont.draw(DOWN, 160, 120, { colors: FrlgFont.COLOR.DARK_GRAY });
    }

    for (let i = 1; i <= VISIBLE; i++) {
      const idx = BerryPouch.scroll + i;
      if (idx > total) break;
      const y = 10 + (i - 1) * 16;

      // Selector Arrow at x = 89
      if (idx === BerryPouch.cursor && BerryPouch.mode === "list") {
        Window.cursorPx(89, y);
      }

      if (idx <= len(rows)) {
        const r = rows[idx]!;
        const berryNum = ItemsData.berryNumber(r.id) || idx;
        // №xx in FONT_SMALL at x = 97
        const noStr = format(NUMERO + "%02d", berryNum);
        FrlgFont.draw(noStr, 97, y, { small: true, colors: FrlgFont.COLOR.NORMAL });

        // Berry Name in FONT_NORMAL at x = 121 (spaced after №xx)
        const bName = r.name || ItemsData.displayName(r.id);
        FrlgFont.draw(bName, 121, y, { colors: FrlgFont.COLOR.NORMAL });

        // Quantity ×%3d in FONT_SMALL at x = 198
        const qStr = format(TIMES + "%3d", r.qty || 1);
        FrlgFont.draw(qStr, 198, y, { small: true, colors: FrlgFont.COLOR.NORMAL });
      } else if (!BerryPouch._fromBerryCrush) {
        // CLOSE option in FONT_NORMAL at x = 97
        // src/berry_pouch.c:661
        FrlgFont.draw(RomText.plain("gText_Close"), 97, y, { colors: FrlgFont.COLOR.NORMAL });
      }
    }

    // 7. Context Menu (WIN 13: 22, 11, 7, 8) + Selected Message (WIN 6: 6, 15, 14, 4)
    if (BerryPouch.mode === "action" && sel) {
      const bName = sel.name || ItemsData.displayName(sel.id);

      // WIN 6: Selected message
      Window.stdFrame(Window.template(6, 15, 14, 4));
      // src/berry_pouch.c:1031
      const selMsg = RomText.box("gText_Var1IsSelected", { stringVars: seq(bName) });
      FrlgFont.draw(selMsg, 52, 124, { colors: FrlgFont.COLOR.NORMAL, linePitch: 14 });

      // WIN 13: Action menu
      Window.stdFrame(Window.template(22, 11, 7, 8));
      for (const [i, act] of ipairs<string>(ACTIONS)) {
        const rowY = 90 + (i - 1) * 16;
        if (i === BerryPouch.actionCursor) {
          Window.cursorPx(177, rowY);
        }
        // src/berry_pouch.c:179 sContextMenuActions
        FrlgFont.draw(RomText.at("sContextMenuActions", ACTION_TEXT[act]!), 185, rowY, { colors: FrlgFont.COLOR.NORMAL });
      }
    }

    // 8. Toss Quantity Select UI (WIN 8: 6, 15, 16, 4 + WIN 0: 24, 15, 5, 4)
    if (BerryPouch.mode === "toss_select" && sel) {
      const bName = sel.name || ItemsData.displayName(sel.id);

      // WIN 8: Prompt
      Window.stdFrame(Window.template(6, 15, 16, 4));
      // src/berry_pouch.c:1097
      const tossMsg = RomText.box("gText_TossOutHowManyStrVar1s", { stringVars: seq(bName) });
      FrlgFont.draw(tossMsg, 52, 122, { colors: FrlgFont.COLOR.NORMAL, linePitch: 14 });

      // WIN 0: Quantity with arrows
      Window.stdFrame(Window.template(24, 15, 5, 4));
      const qStr = format(TIMES + "%02d", BerryPouch.tossQty);
      FrlgFont.draw(qStr, 196, 130, { small: true, colors: FrlgFont.COLOR.NORMAL });
      FrlgFont.draw(UP, 212, 122, { colors: FrlgFont.COLOR.DARK_GRAY });
      FrlgFont.draw(DOWN, 212, 144, { colors: FrlgFont.COLOR.DARK_GRAY });
    }

    // 9. Toss Confirmation Modal (WIN 7: 6, 15, 15, 4 + WIN 3: 23, 15, 6, 4)
    if (BerryPouch.mode === "toss_confirm" && sel) {
      // WIN 7: Confirmation prompt
      Window.stdFrame(Window.template(6, 15, 15, 4));
      // src/berry_pouch.c:1107
      const confMsg = RomText.box("gText_ThrowAwayStrVar2OfThisItemQM",
        { stringVars: { 2: tostring(BerryPouch.tossQty) } });
      FrlgFont.draw(confMsg, 52, 124, { colors: FrlgFont.COLOR.NORMAL, linePitch: 14 });

      // WIN 3: YES / NO
      Window.stdFrame(Window.template(23, 15, 6, 4));
      const yesY = 124;
      const noY = 140;
      if (BerryPouch.yesNoCursor === 1) {
        Window.cursorPx(185, yesY);
      } else {
        Window.cursorPx(185, noY);
      }
      FrlgFont.draw(RomText.plain("gText_Yes"), 193, yesY, { colors: FrlgFont.COLOR.NORMAL });
      FrlgFont.draw(RomText.plain("gText_No"), 193, noY, { colors: FrlgFont.COLOR.NORMAL });
    }

    // 10. Dialogue Message Modal (WIN 5: 2, 15, 26, 4)
    if (BerryPouch.mode === "message" && BerryPouch.messageText) {
      Window.stdFrame(Window.template(2, 15, 26, 4));
      FrlgFont.draw(BerryPouch.messageText, 20, 124, { colors: FrlgFont.COLOR.NORMAL, linePitch: 14 });
    }

    if (BerryPouch.mode === "sell" && BerryPouch._sell) {
      BerryPouch._sell.draw();
    }
  },
};

export default BerryPouch;
