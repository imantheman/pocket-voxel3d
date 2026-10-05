// Port of gen1recomp src/ui/game3/box_storage_ui.lua (GPLv3 + additional terms; see LICENSE.md).
// FRLG Pokémon Storage System UI (pret src/pokemon_storage_system.c & User Image 2).
//
// Layout:
// 1. Left Data Panel: ~~~ PKMN DATA ~~~ header, TV monitor with cyan scanlines & front sprite,
//    and bottom stats/markings card.
// 2. Top Bar: PARTY POKéMON button (green) and CLOSE BOX button (cyan).
// 3. Box Header: ◀ [ Tree BOX 1 Tree ] ▶
// 4. 6×5 Box Grid: 30 slots (420 capacity across 14 boxes) with 2-frame mini-icon hover bounce.
// 5. Hand Cursor with authentic dark oval drop shadow.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { mod, tonumber } from "../../../import/gen3/lua.ts";
import { G } from "../platform/graphics.ts";
import { ipairs, len, seq, type LuaTable } from "../platform/lt.ts";
import { Stack } from "./stack.ts";
import { Window } from "./window.ts";
import { Pokemon } from "../core/pokemon.ts";
import { Storage } from "../core/storage.ts";
import { PcChrome, type HoldingSource } from "./pc_chrome.ts";
import { ReleaseSeq } from "./release_seq.ts";
import { SummaryMenu } from "./summary_menu.ts";
import { Strings } from "../shared/core/Strings.ts";
import { RomText } from "../core/rom_text.ts";
import { Profile } from "../core/profile.ts";
import { Audio } from "../core/audio.ts";
import { SE } from "../core/se_ids.ts";
import { Constants } from "../core/constants.ts";
import { Flags } from "../core/scripting/flags.ts";
import { Space } from "../core/scripting/space.ts";

// pokefirered/src/pokemon_storage_system_data.c:2027
// Lua: box_storage_ui.lua:25
const MENU_TEXT: Record<string, number> = {
  CANCEL: 0, STORE: 1, WITHDRAW: 2, MOVE: 3, SUMMARY: 6, RELEASE: 7,
  "SWITCH BOX": 9, WALLPAPER: 10, TAKE: 12,
};
const MENU_TEXT_FOREST = 22;
// pokeemerald/src/pokemon_storage_system.c:135
const MENU_TEXT_FOREST_RSE = 23;

// Grid positioning constants (6 cols × 5 rows inside 154×118 wallpaper at X: 80, Y: 16)
// Lua: box_storage_ui.lua:74
const GRID_ORIGIN_X = 84;
const GRID_ORIGIN_Y = 28;
const COL_W = 24;
const ROW_H = 24;

interface Holding extends HoldingSource { loc: string; boxId?: number | null; slot: number }
interface ActionTarget { mon: any; loc: string; boxId: number | null | undefined; slot: number }

export const BoxStorageUI = {
  isMenu: true,

  open: false,
  mode: "browse", // browse | action_menu | box_menu | pick_box | pick_wallpaper | party_drawer | message
  subMode: "move", // withdraw | deposit | move | move_items

  // Grid cursor:
  // 1..30 = 6 cols × 5 rows in current box
  // 0 = Box Title Header
  // -10 = PARTY POKéMON button
  // -20 = CLOSE BOX button
  // -1..-6 = Party Drawer slots 1..6 (when party drawer is open)
  cursorSlot: 1,
  holdingMon: null as any,
  holdingSource: null as Holding | null, // { loc = "box"|"party", boxId = 1, slot = 1 }

  actionCursor: 1,
  boxMenuCursor: 1,
  wallpaperCursor: 1,
  partyCursor: 1,

  hoverTimer: 0,
  hoverFrame: 0,

  drawerOpen: false,
  _session: null as any,
  _onClose: null as (() => void) | null,
  _prevPartySlot: null as number | null,
  _actionSource: null as string | null,
  _actionTarget: null as ActionTarget | null,
  _activeActions: null as LuaTable,
  _lastUsedBox: null as number | null,
  _status: null as string | null,

  // Lua: box_storage_ui.lua:147
  show(opts?: any): void {
    opts = opts ?? {};
    BoxStorageUI.open = true;
    BoxStorageUI._session = opts.session;
    BoxStorageUI._onClose = opts.onClose;
    BoxStorageUI.mode = "browse";
    BoxStorageUI.subMode = opts.subMode ?? "move";
    BoxStorageUI.cursorSlot = 1;
    BoxStorageUI._prevPartySlot = null;
    BoxStorageUI.holdingMon = null;
    BoxStorageUI.holdingSource = null;
    BoxStorageUI.hoverTimer = 0;
    BoxStorageUI.hoverFrame = 0;
    BoxStorageUI.partyCursor = 1;
    BoxStorageUI.drawerOpen = false;
    BoxStorageUI._actionSource = null;
    BoxStorageUI._actionTarget = null;
    const storage = Storage.ensure(BoxStorageUI._session);
    // Repair a party left with gaps by an older build before any slot is indexed.
    if (BoxStorageUI._session) Storage.compactParty(BoxStorageUI._session.party);
    // pokefirered/src/pokemon_storage_system_tasks.c:426
    BoxStorageUI._lastUsedBox = storage ? ((tonumber(storage.currentBox) ?? 1) - 1) : null;

    if (BoxStorageUI.subMode === "deposit") {
      // In deposit submode, start directly in party drawer mode
      BoxStorageUI.mode = "party_drawer";
      BoxStorageUI.drawerOpen = true;
      BoxStorageUI.partyCursor = 1;
    }

    Stack.push("box_storage", BoxStorageUI, { hideBelow: true, fullscreen: true });
    se(5);
  },

  // Lua: box_storage_ui.lua:181
  close(): void {
    // pokefirered/src/pokemon_storage_system_tasks.c:1979
    update_box_to_send_mons();
    BoxStorageUI.open = false;
    BoxStorageUI.holdingMon = null;
    BoxStorageUI.holdingSource = null;
    BoxStorageUI.drawerOpen = false;
    BoxStorageUI._actionSource = null;
    BoxStorageUI._actionTarget = null;
    Stack.pop("box_storage");
    const cb = BoxStorageUI._onClose;
    BoxStorageUI._onClose = null;
    if (cb) cb();
  },

  // Lua: box_storage_ui.lua:196
  isOpen(): boolean {
    return BoxStorageUI.open;
  },

  // Lua: box_storage_ui.lua:200
  update(dt?: number): void {
    if (!BoxStorageUI.open) return;

    // Release sequence animation update
    if (ReleaseSeq.isActive()) {
      ReleaseSeq.update(dt);
      return;
    }

    // Hover Bounce animation: toggles frame 0 and frame 1 every 0.14s
    BoxStorageUI.hoverTimer = BoxStorageUI.hoverTimer + (dt ?? (1 / 60));
    if (BoxStorageUI.hoverTimer >= 0.14) {
      BoxStorageUI.hoverTimer = 0;
      BoxStorageUI.hoverFrame = (BoxStorageUI.hoverFrame === 0) ? 1 : 0;
    }
  },

  // Lua: box_storage_ui.lua:276
  handleInput(input: any): void {
    if (!BoxStorageUI.open) return;

    if (ReleaseSeq.isActive()) {
      ReleaseSeq.handleInput(input);
      return;
    }

    // Message dismiss
    if (BoxStorageUI.mode === "message") {
      if (input.wasPressed("a") || input.wasPressed("b")) {
        const returnMode = (BoxStorageUI._actionSource === "party" || BoxStorageUI.drawerOpen) ? "party_drawer" : "browse";
        BoxStorageUI.mode = returnMode;
        BoxStorageUI._status = null;
        se(5);
      }
      return;
    }

    // Party Drawer Selection Mode
    if (BoxStorageUI.mode === "party_drawer") {
      const party = (BoxStorageUI._session && BoxStorageUI._session.party) ?? seq();
      BoxStorageUI.partyCursor = BoxStorageUI.partyCursor ?? 1;
      BoxStorageUI.drawerOpen = true;

      if (input.wasPressed("up")) {
        BoxStorageUI.partyCursor = BoxStorageUI.partyCursor - 1;
        if (BoxStorageUI.partyCursor < 1) BoxStorageUI.partyCursor = 7;
        if (BoxStorageUI.partyCursor >= 2 && BoxStorageUI.partyCursor <= 6) {
          BoxStorageUI._prevPartySlot = BoxStorageUI.partyCursor;
        }
        se(5);
      } else if (input.wasPressed("down")) {
        BoxStorageUI.partyCursor = BoxStorageUI.partyCursor + 1;
        if (BoxStorageUI.partyCursor > 7) BoxStorageUI.partyCursor = 1;
        if (BoxStorageUI.partyCursor >= 2 && BoxStorageUI.partyCursor <= 6) {
          BoxStorageUI._prevPartySlot = BoxStorageUI.partyCursor;
        }
        se(5);
      } else if (input.wasPressed("left")) {
        if (BoxStorageUI.partyCursor !== 1) {
          BoxStorageUI._prevPartySlot = BoxStorageUI.partyCursor;
          BoxStorageUI.partyCursor = 1;
          se(5);
        }
      } else if (input.wasPressed("right")) {
        if (BoxStorageUI.partyCursor === 1) {
          BoxStorageUI.partyCursor = BoxStorageUI._prevPartySlot ?? 2;
          se(5);
        } else {
          // Exit party drawer to Box 1 slot 1
          BoxStorageUI.mode = "browse";
          BoxStorageUI.drawerOpen = false;
          BoxStorageUI.cursorSlot = 1;
          se(5);
        }
      } else if (input.wasPressed("b")) {
        if (BoxStorageUI.subMode === "deposit" && BoxStorageUI.holdingMon == null) {
          BoxStorageUI.close();
        } else {
          BoxStorageUI.mode = "browse";
          BoxStorageUI.drawerOpen = false;
          BoxStorageUI.cursorSlot = 1;
          se(5);
        }
      } else if (input.wasPressed("a")) {
        if (BoxStorageUI.partyCursor === 7) { // CANCEL button
          if (BoxStorageUI.subMode === "deposit" && BoxStorageUI.holdingMon == null) {
            BoxStorageUI.close();
          } else {
            BoxStorageUI.mode = "browse";
            BoxStorageUI.drawerOpen = false;
            BoxStorageUI.cursorSlot = 1;
            se(5);
          }
        } else {
          const pIdx = BoxStorageUI.partyCursor;
          const mon = party[pIdx];

          // If holding a mon (Move mode)
          if (BoxStorageUI.holdingMon) {
            if (BoxStorageUI.holdingSource && BoxStorageUI.holdingSource.loc === "party" && BoxStorageUI.holdingSource.slot === pIdx) {
              // Place mon back into same slot
              BoxStorageUI.holdingMon = null;
              BoxStorageUI.holdingSource = null;
              se(se_id("SE_BAG_POCKET"));
            } else if (BoxStorageUI.holdingSource && BoxStorageUI.holdingSource.loc === "party") {
              // Swap between two party slots
              const srcIdx = BoxStorageUI.holdingSource.slot;
              const targetMon = party[pIdx];
              party[srcIdx] = targetMon;
              party[pIdx] = BoxStorageUI.holdingMon;
              BoxStorageUI.holdingMon = null;
              BoxStorageUI.holdingSource = null;
              se(se_id("SE_BAG_POCKET"));
            } else if (BoxStorageUI.holdingSource && BoxStorageUI.holdingSource.loc === "box") {
              // Placing/Swapping from box into party
              const srcBox = BoxStorageUI.holdingSource.boxId!;
              const srcSlot = BoxStorageUI.holdingSource.slot;
              const storage = Storage.ensure(BoxStorageUI._session);
              const box = (storage.boxes as any)[srcBox];
              if (mon) {
                // Swap box mon with party mon
                box.mons[srcSlot] = mon;
                party[pIdx] = BoxStorageUI.holdingMon;
                BoxStorageUI.holdingMon = null;
                BoxStorageUI.holdingSource = null;
                se(se_id("SE_BAG_POCKET"));
              } else {
                // Place into empty party slot
                party[pIdx] = BoxStorageUI.holdingMon;
                box.mons[srcSlot] = null;
                BoxStorageUI.holdingMon = null;
                BoxStorageUI.holdingSource = null;
                se(se_id("SE_BAG_POCKET"));
              }
            }
            // pokefirered/src/pokemon_storage_system_tasks.c SetUpHidePartyMenu -> CompactPartySlots
            Storage.compactParty(party);
          } else if (mon) {
            BoxStorageUI._actionSource = "party";
            BoxStorageUI._actionTarget = { mon, loc: "party", boxId: null, slot: pIdx };
            if (BoxStorageUI.subMode === "deposit") {
              BoxStorageUI._activeActions = seq("STORE", "SUMMARY", "CANCEL");
            } else {
              BoxStorageUI._activeActions = seq("STORE", "SUMMARY", "MOVE", "CANCEL");
            }
            BoxStorageUI.actionCursor = 1;
            BoxStorageUI.mode = "action_menu";
            se(5);
          }
        }
      }
      return;
    }

    // Context Action Menu
    if (BoxStorageUI.mode === "action_menu") {
      const actions = BoxStorageUI._activeActions ?? seq("CANCEL");
      const returnMode = (BoxStorageUI._actionSource === "party" || BoxStorageUI.drawerOpen) ? "party_drawer" : "browse";

      if (input.wasPressed("up")) {
        BoxStorageUI.actionCursor = mod(BoxStorageUI.actionCursor - 2, len(actions)) + 1;
        se(5);
      } else if (input.wasPressed("down")) {
        BoxStorageUI.actionCursor = mod(BoxStorageUI.actionCursor, len(actions)) + 1;
        se(5);
      } else if (input.wasPressed("a")) {
        const choice = actions[BoxStorageUI.actionCursor];
        if (choice === "CANCEL") {
          BoxStorageUI.mode = returnMode;
          se(5);
        } else if (choice === "WITHDRAW") {
          const [mon, loc, bId, sId] = mon_at_cursor();
          if (loc === "box" && mon) {
            const [ok] = Storage.withdraw(BoxStorageUI._session, bId!, sId!);
            if (ok) {
              BoxStorageUI.mode = returnMode;
              se(se_id("SE_BAG_POCKET"));
            } else {
              BoxStorageUI._status = RomText.plain("gText_YourPartysFull");
              BoxStorageUI.mode = "message";
              se(5); // pokefirered/src/pokemon_storage_system_tasks.c:992
            }
          }
        } else if (choice === "STORE" || choice === "DEPOSIT") {
          const [mon, loc, , sId] = mon_at_cursor();
          if (loc === "party" && mon) {
            const party = (BoxStorageUI._session && BoxStorageUI._session.party) ?? seq();
            if (len(party) <= 1) {
              BoxStorageUI._status = RomText.plain("gText_JustOnePkmn");
              BoxStorageUI.mode = "message";
              se(se_id("SE_FAILURE")); // pokefirered/src/pokemon_storage_system_tasks.c:1052
            } else {
              const [ok] = Storage.deposit(BoxStorageUI._session, sId!);
              if (ok) {
                const newParty = (BoxStorageUI._session && BoxStorageUI._session.party) ?? seq();
                if (len(newParty) === 0) {
                  BoxStorageUI.drawerOpen = false;
                  BoxStorageUI.mode = "browse";
                  BoxStorageUI.cursorSlot = 1;
                } else {
                  BoxStorageUI.partyCursor = Math.min(len(newParty), BoxStorageUI.partyCursor ?? 1);
                  BoxStorageUI.mode = returnMode;
                }
                se(se_id("SE_BAG_POCKET"));
              } else {
                BoxStorageUI._status = RomText.plain("gText_BoxIsFull2");
                BoxStorageUI.mode = "message";
                se(5); // pokefirered/src/pokemon_storage_system_tasks.c:1225
              }
            }
          }
        } else if (choice === "MOVE") {
          const [mon, loc, bId, sId] = mon_at_cursor();
          if (mon) {
            BoxStorageUI.holdingMon = mon;
            BoxStorageUI.holdingSource = { loc: loc!, boxId: bId, slot: sId! };
            BoxStorageUI.mode = returnMode;
            se(5);
          }
        } else if (choice === "SUMMARY") {
          BoxStorageUI.mode = returnMode;
          open_summary_for_cursor();
        } else if (choice === "TAKE") {
          const [mon] = mon_at_cursor();
          if (mon) {
            const [ok, err] = Storage.detachHeldItem(BoxStorageUI._session, mon);
            if (ok) {
              // pokefirered/src/pokemon_storage_system_tasks.c:1501
              BoxStorageUI._status = RomText.plain("gText_PlacedItemInBag");
              BoxStorageUI.mode = "message";
              se(se_id("SE_BAG_POCKET"));
            } else if (err === "bag_full") {
              BoxStorageUI._status = RomText.plain("gText_BagIsFull2");
              BoxStorageUI.mode = "message";
              se(se_id("SE_FAILURE")); // pokefirered/src/pokemon_storage_system_tasks.c:1487
            } else {
              BoxStorageUI._status = Strings("This POK\xC3\xA9MON isn't holding anything.");
              BoxStorageUI.mode = "message";
              se(5); // pokefirered/src/pokemon_storage_system_tasks.c:1493
            }
          }
        } else if (choice === "RELEASE") {
          const [mon, loc, bId, sId] = mon_at_cursor();
          if (loc === "box" && mon) {
            const col = mod(sId! - 1, 6);
            const row = Math.floor((sId! - 1) / 6);
            const px = GRID_ORIGIN_X + col * COL_W + 12;
            const py = GRID_ORIGIN_Y + row * ROW_H + 12;
            BoxStorageUI.mode = "browse";
            BoxStorageUI.drawerOpen = false;
            ReleaseSeq.start({
              session: BoxStorageUI._session,
              mon,
              boxId: bId,
              slotIdx: sId,
              startX: px,
              startY: py,
              onComplete: (released: boolean) => {
                if (released) {
                  se(se_id("SE_BAG_POCKET"));
                }
              },
            });
          }
        }
      } else if (input.wasPressed("b")) {
        BoxStorageUI.mode = returnMode;
        se(5);
      }
      return;
    }

    // Box Header Menu (Switch Box, Wallpaper, Cancel)
    if (BoxStorageUI.mode === "box_menu") {
      const boxActions = seq("SWITCH BOX", "WALLPAPER", "CANCEL");
      if (input.wasPressed("up")) {
        BoxStorageUI.boxMenuCursor = mod(BoxStorageUI.boxMenuCursor - 2, len(boxActions)) + 1;
        se(5);
      } else if (input.wasPressed("down")) {
        BoxStorageUI.boxMenuCursor = mod(BoxStorageUI.boxMenuCursor, len(boxActions)) + 1;
        se(5);
      } else if (input.wasPressed("a")) {
        const choice = boxActions[BoxStorageUI.boxMenuCursor];
        if (choice === "CANCEL") {
          BoxStorageUI.mode = "browse";
          se(5);
        } else if (choice === "SWITCH BOX") {
          BoxStorageUI.mode = "pick_box";
          se(5);
        } else if (choice === "WALLPAPER") {
          BoxStorageUI.mode = "pick_wallpaper";
          const [box] = current_box_data();
          BoxStorageUI.wallpaperCursor = (box ? box.wallpaper : null) ?? 1;
          se(5);
        }
      } else if (input.wasPressed("b")) {
        BoxStorageUI.mode = "browse";
        se(5);
      }
      return;
    }

    // Pick Wallpaper
    if (BoxStorageUI.mode === "pick_wallpaper") {
      const count = wallpaper_count(BoxStorageUI._session);
      if (input.wasPressed("up")) {
        BoxStorageUI.wallpaperCursor = mod(BoxStorageUI.wallpaperCursor - 2, count) + 1;
        se(5);
      } else if (input.wasPressed("down")) {
        BoxStorageUI.wallpaperCursor = mod(BoxStorageUI.wallpaperCursor, count) + 1;
        se(5);
      } else if (input.wasPressed("a")) {
        const [box] = current_box_data();
        if (box) box.wallpaper = BoxStorageUI.wallpaperCursor;
        BoxStorageUI.mode = "browse";
        se(se_id("SE_BAG_POCKET"));
      } else if (input.wasPressed("b")) {
        BoxStorageUI.mode = "browse";
        se(5);
      }
      return;
    }

    // Pick Box
    if (BoxStorageUI.mode === "pick_box") {
      const storage = Storage.ensure(BoxStorageUI._session);
      if (input.wasPressed("up")) {
        storage.currentBox = mod(storage.currentBox - 2, Storage.TOTAL_BOXES_COUNT) + 1;
        se(5);
      } else if (input.wasPressed("down")) {
        storage.currentBox = mod(storage.currentBox, Storage.TOTAL_BOXES_COUNT) + 1;
        se(5);
      } else if (input.wasPressed("a") || input.wasPressed("b")) {
        BoxStorageUI.mode = "browse";
        se(5);
      }
      return;
    }

    // Standard Browse Navigation
    if (BoxStorageUI.mode === "browse") {
      // L / R Triggers cycle boxes
      if (input.wasPressed("l")) {
        switch_box(-1);
        return;
      } else if (input.wasPressed("r")) {
        switch_box(1);
        return;
      }

      // Top Buttons: PARTY POKéMON (-10) & CLOSE BOX (-20)
      if (BoxStorageUI.cursorSlot === -10) {
        if (input.wasPressed("right")) {
          BoxStorageUI.cursorSlot = -20;
          se(5);
        } else if (input.wasPressed("down")) {
          BoxStorageUI.cursorSlot = 0;
          se(5);
        } else if (input.wasPressed("a")) {
          BoxStorageUI.mode = "party_drawer";
          BoxStorageUI.drawerOpen = true;
          BoxStorageUI.partyCursor = 1;
          se(5);
        } else if (input.wasPressed("b")) {
          BoxStorageUI.close();
        }
        return;
      } else if (BoxStorageUI.cursorSlot === -20) {
        if (input.wasPressed("left")) {
          BoxStorageUI.cursorSlot = -10;
          se(5);
        } else if (input.wasPressed("down")) {
          BoxStorageUI.cursorSlot = 0;
          se(5);
        } else if (input.wasPressed("a")) {
          BoxStorageUI.close();
        } else if (input.wasPressed("b")) {
          BoxStorageUI.close();
        }
        return;
      }

      // Box Header slot = 0
      if (BoxStorageUI.cursorSlot === 0) {
        if (input.wasPressed("left")) {
          switch_box(-1);
        } else if (input.wasPressed("right")) {
          switch_box(1);
        } else if (input.wasPressed("up")) {
          BoxStorageUI.cursorSlot = -10;
          se(5);
        } else if (input.wasPressed("down")) {
          BoxStorageUI.cursorSlot = 1; // enter top row of grid
          se(5);
        } else if (input.wasPressed("a")) {
          BoxStorageUI.mode = "box_menu";
          BoxStorageUI.boxMenuCursor = 1;
          se(5);
        } else if (input.wasPressed("b")) {
          BoxStorageUI.close();
        }
        return;
      }

      // 6×5 Box Grid slots: 1..30
      const slot = BoxStorageUI.cursorSlot;
      const col = mod(slot - 1, 6); // 0..5
      const row = Math.floor((slot - 1) / 6); // 0..4

      if (input.wasPressed("up")) {
        if (row > 0) {
          BoxStorageUI.cursorSlot = slot - 6;
          se(5);
        } else {
          BoxStorageUI.cursorSlot = 0; // Move to Box Header
          se(5);
        }
      } else if (input.wasPressed("down")) {
        if (row < 4) {
          BoxStorageUI.cursorSlot = slot + 6;
          se(5);
        }
      } else if (input.wasPressed("left")) {
        if (col > 0) {
          BoxStorageUI.cursorSlot = slot - 1;
          se(5);
        } else {
          // Wrap to previous box right edge
          switch_box(-1);
          BoxStorageUI.cursorSlot = row * 6 + 6;
        }
      } else if (input.wasPressed("right")) {
        if (col < 5) {
          BoxStorageUI.cursorSlot = slot + 1;
          se(5);
        } else {
          // Wrap to next box left edge
          switch_box(1);
          BoxStorageUI.cursorSlot = row * 6 + 1;
        }
      } else if (input.wasPressed("a")) {
        if (BoxStorageUI.holdingMon) {
          // Place/Swap holding mon into box slot
          const src = BoxStorageUI.holdingSource!;
          const storage = Storage.ensure(BoxStorageUI._session);
          if (src.loc === "box") {
            Storage.moveMon(BoxStorageUI._session, "box", src.slot, "box", slot, src.boxId as any, storage.currentBox);
          } else if (src.loc === "party") {
            Storage.moveMon(BoxStorageUI._session, "party", src.slot, "box", slot, undefined, storage.currentBox);
          }
          BoxStorageUI.holdingMon = null;
          BoxStorageUI.holdingSource = null;
          se(se_id("SE_BAG_POCKET"));
        } else {
          const [mon, , bId] = mon_at_cursor();
          if (mon) {
            BoxStorageUI._actionSource = "box";
            BoxStorageUI._actionTarget = { mon, loc: "box", boxId: bId, slot };
            if (BoxStorageUI.subMode === "withdraw") {
              BoxStorageUI._activeActions = seq("WITHDRAW", "SUMMARY", "RELEASE", "CANCEL");
            } else if (BoxStorageUI.subMode === "move_items") {
              BoxStorageUI._activeActions = seq("TAKE", "SUMMARY", "CANCEL");
            } else {
              BoxStorageUI._activeActions = seq("MOVE", "SUMMARY", "WITHDRAW", "RELEASE", "CANCEL");
            }
            BoxStorageUI.actionCursor = 1;
            BoxStorageUI.mode = "action_menu";
            se(5);
          }
        }
      } else if (input.wasPressed("b")) {
        if (BoxStorageUI.holdingMon) {
          BoxStorageUI.holdingMon = null;
          BoxStorageUI.holdingSource = null;
          se(5);
        } else {
          BoxStorageUI.close();
        }
      }
    }
  },

  // Lua: box_storage_ui.lua:740
  draw(): void {
    if (!BoxStorageUI.open) return;
    const session = BoxStorageUI._session;
    const storage = Storage.ensure(session);
    if (!storage) return;
    const [box, bId] = current_box_data();

    // 1. Full Salmon / Scrolling Background (BG3)
    PcChrome.drawBackground();

    // 2. Box Wallpaper (BG2, X: 80, Y: 16)
    PcChrome.drawWallpaper((box ? box.wallpaper : null) ?? 1, session.waldaPhrase);

    // 3. Interface Frame (BG1, X: 0, Y: 0)
    PcChrome.drawInterfaceFrame();

    // 4. Top Buttons (PARTY POKéMON & CLOSE BOX)
    let activeBtn: string | null = null;
    if (BoxStorageUI.cursorSlot === -10) activeBtn = "party";
    else if (BoxStorageUI.cursorSlot === -20) activeBtn = "close";
    PcChrome.drawTopButtons(activeBtn);

    // 5. Box Title Header (◀  BOX 1  ▶)
    PcChrome.drawBoxHeader(box ? box.name : null, bId, BoxStorageUI.cursorSlot === 0);

    // 6. Left TV Monitor & Info Panel Text/Sprite
    const hoverMon = BoxStorageUI.holdingMon || mon_at_cursor()[0];
    PcChrome.drawLeftDataPanel(hoverMon ?? undefined, BoxStorageUI.hoverFrame);

    // 7. 30 Mini-Icons in Box Grid (6 cols × 5 rows)
    for (let s = 1; s <= Storage.IN_BOX_COUNT; s++) {
      const isPickedUp = (BoxStorageUI.holdingMon && BoxStorageUI.holdingSource
        && BoxStorageUI.holdingSource.loc === "box"
        && BoxStorageUI.holdingSource.boxId === bId
        && BoxStorageUI.holdingSource.slot === s);

      const mon = (!isPickedUp) && box && box.mons[s];
      if (mon) {
        const col = mod(s - 1, 6);
        const row = Math.floor((s - 1) / 6);
        const px = GRID_ORIGIN_X + col * COL_W;
        const py = GRID_ORIGIN_Y + row * ROW_H;

        const isHovered = (BoxStorageUI.cursorSlot === s && BoxStorageUI.mode !== "party_drawer" && !BoxStorageUI.holdingMon);
        const bounceY = (isHovered && BoxStorageUI.hoverFrame === 1) ? -2 : 0;
        const f = (isHovered && BoxStorageUI.hoverFrame === 1) ? 1 : 0;
        const icon: any = Pokemon.monIcon(mon);

        if (icon && icon.image) {
          const q = icon.quads && (icon.quads[f] ?? icon.quads[0]);
          G.setColor(1, 1, 1, 1);
          if (q) {
            G.draw(icon.image, q, px, py + bounceY);
          } else {
            G.draw(icon.image, px, py + bounceY);
          }
        }

        // Held Item indicator (small yellow dot/diamond)
        const held = mon.heldItem ?? mon.item;
        if (held != null && held !== false && held > 0) {
          G.setColor(240 / 255, 180 / 255, 60 / 255, 1);
          G.rectangle("fill", px + 22, py + 22 + bounceY, 3, 3);
          G.setColor(1, 1, 1, 1);
        }
      }
    }

    // 8. Party Drawer Overlay (if active or drawer open)
    if (BoxStorageUI.mode === "party_drawer" || BoxStorageUI.drawerOpen) {
      PcChrome.drawPartyDrawer(session.party, BoxStorageUI.partyCursor, BoxStorageUI.hoverFrame, BoxStorageUI.holdingSource);
    }

    // 9. Draw Hand Cursor & Shadow
    let curX = 100, curY = 32;
    let showShadow = false;
    let vFlip = false;

    if (BoxStorageUI.mode === "party_drawer" || (BoxStorageUI.mode === "action_menu" && BoxStorageUI._actionSource === "party")) {
      [curX, curY] = PcChrome.getPartyCursorCoords(BoxStorageUI.partyCursor);
    } else if (BoxStorageUI.cursorSlot === -10) {
      curX = 120;
      curY = BoxStorageUI.holdingMon ? 8 : 14;
      vFlip = true;
    } else if (BoxStorageUI.cursorSlot === -20) {
      curX = 208;
      curY = BoxStorageUI.holdingMon ? 8 : 14;
      vFlip = true;
    } else if (BoxStorageUI.cursorSlot === 0) {
      curX = 162;
      curY = 12;
    } else if (BoxStorageUI.cursorSlot >= 1 && BoxStorageUI.cursorSlot <= 30) {
      const s = BoxStorageUI.cursorSlot;
      const col = mod(s - 1, 6);
      const row = Math.floor((s - 1) / 6);
      curX = col * 24 + 100;
      curY = row * 24 + 32;
      // Shadow only shows when hovering over an EMPTY box slot
      const isPickedUp = (BoxStorageUI.holdingMon && BoxStorageUI.holdingSource
        && BoxStorageUI.holdingSource.loc === "box"
        && BoxStorageUI.holdingSource.boxId === bId
        && BoxStorageUI.holdingSource.slot === s);
      // Lua: `(not isPickedUp) and box and box.mons[s]` is false (not nil)
      // when picked up, so the shadow stays off there.
      const monInSlot = isPickedUp ? false : (box ? box.mons[s] : null);
      showShadow = (monInSlot == null);
    }

    const cursorState = BoxStorageUI.holdingMon ? "holding" : "idle";
    PcChrome.drawHandCursor(curX, curY, cursorState, showShadow, vFlip);

    // If holding a mon, draw floating mini-icon under hand cursor
    if (BoxStorageUI.holdingMon) {
      const hIcon: any = Pokemon.monIcon(BoxStorageUI.holdingMon);
      if (hIcon && hIcon.image) {
        const q = hIcon.quads && hIcon.quads[0];
        G.setColor(1, 1, 1, 1);
        if (q) {
          G.draw(hIcon.image, q, curX - 16, curY - 12);
        } else {
          G.draw(hIcon.image, curX - 16, curY - 12);
        }
        G.setColor(1, 1, 1, 1);
      }
    }

    // 10. Context Action Menu Popup
    if (BoxStorageUI.mode === "action_menu") {
      const actions = BoxStorageUI._activeActions ?? seq("CANCEL");
      const th = len(actions) * 2;
      let menuLeft = 13;
      let menuTop = 5;
      let textLeft = 114;

      if (BoxStorageUI._actionSource === "party" || BoxStorageUI.drawerOpen) {
        menuLeft = 11;
        menuTop = 4;
        textLeft = 98;
      }

      Window.stdFrame(Window.template(menuLeft, menuTop, 10, th));
      for (const [i, act] of ipairs<string>(actions)) {
        const yPx = (menuTop * 8 + 2) + (i - 1) * 16;
        if (i === BoxStorageUI.actionCursor) Window.cursorPx(textLeft - 8, yPx);
        Window.printPx(menu_text(act), textLeft, yPx);
      }
    }

    // 10. Box Menu Popup
    if (BoxStorageUI.mode === "box_menu") {
      const boxActions = seq("SWITCH BOX", "WALLPAPER", "CANCEL");
      Window.stdFrame(Window.template(5, 3, 12, 6));
      for (const [i, act] of ipairs<string>(boxActions)) {
        const yPx = 26 + (i - 1) * 16;
        if (i === BoxStorageUI.boxMenuCursor) Window.cursorPx(42, yPx);
        Window.printPx(menu_text(act), 50, yPx);
      }
    }

    // 11. Wallpaper Picker Popup
    if (BoxStorageUI.mode === "pick_wallpaper") {
      Window.stdFrame(Window.template(5, 2, 14, 10));
      // pokefirered/src/pokemon_storage_system_tasks.c:279
      Window.printPx(RomText.plain("gText_PickTheWallpaper"), 44, 18, { small: true });
      const count = wallpaper_count(BoxStorageUI._session);
      for (let i = 1; i <= 4; i++) {
        const wpId = mod(BoxStorageUI.wallpaperCursor - 1 + i - 1, count) + 1;
        const textId = wpId > len(PcChrome.wallpaperNames())
          ? menu_text_forest(BoxStorageUI._session) - 1
          : menu_text_forest(BoxStorageUI._session) + wpId - 1;
        const wpName = RomText.at("sMenuTexts", textId);
        const yPx = 34 + (i - 1) * 14;
        if (i === 1) Window.cursorPx(44, yPx);
        Window.printPx(wpName, 52, yPx);
      }
    }

    // 12. Message Overlay
    if (BoxStorageUI.mode === "message") {
      Window.dialogueFrame();
      if (BoxStorageUI._status) {
        Window.printPx(BoxStorageUI._status, 16, 120);
      }
    }

    // 13. Release Sequence Rendering
    if (ReleaseSeq.isActive()) {
      ReleaseSeq.draw();
    }
  },
};

// Lua: box_storage_ui.lua:33
function menu_text_forest(session: any): number {
  return Profile.family(session) === "rse" ? MENU_TEXT_FOREST_RSE : MENU_TEXT_FOREST;
}

// Lua: box_storage_ui.lua:38
function menu_text(act: string): string {
  const id = MENU_TEXT[act];
  if (id == null) throw new Error(act);
  return RomText.at("sMenuTexts", id);
}

// Lua: box_storage_ui.lua:42
function wallpaper_count(session: any): number {
  let count = len(PcChrome.wallpaperNames());
  const walda = session != null && typeof session === "object" ? session.waldaPhrase : undefined;
  // pokeemerald/src/pokemon_storage_system.c:4334
  if (Profile.family(session) === "rse" && walda != null && typeof walda === "object"
      && walda.unlocked === true && PcChrome.hasFriends()) count = count + 1;
  return count;
}

// Lua: box_storage_ui.lua:79
function se(id: unknown): void {
  try { Audio.playSe(id); } catch { /* pcall */ }
}

// Lua: box_storage_ui.lua:83
function se_id(name: string): any {
  return SE[name];
}

// Lua: box_storage_ui.lua:87
function storage_ids(session: any): [any, any] {
  const row: any = Profile.forSession(session);
  const C = Constants.of(row.id);
  const names = row.save.storage;
  return [C.require("vars", names.sendVar), C.require("flags", names.boxFullFlag)];
}

// Lua: box_storage_ui.lua:95
function script_store(session: any): any {
  // package.loaded["src.core.game3.scripting.space"]: always loaded here.
  return (Space && Space.store) ?? (session ? session.store : null) ?? null;
}

// pokefirered/src/pokemon_storage_system_tasks.c:2763
// Lua: box_storage_ui.lua:101
function update_box_to_send_mons(): void {
  const storage = Storage.ensure(BoxStorageUI._session);
  if (!storage) return;
  const cur = (tonumber(storage.currentBox) ?? 1) - 1;
  if (BoxStorageUI._lastUsedBox === cur) return;
  const store = script_store(BoxStorageUI._session);
  const [VAR_PC_BOX_TO_SEND_MON, FLAG_SHOWN_BOX_WAS_FULL_MESSAGE] = storage_ids(BoxStorageUI._session);
  Flags.setFlag(store, null, FLAG_SHOWN_BOX_WAS_FULL_MESSAGE, false);
  Flags.setVar(store, null, VAR_PC_BOX_TO_SEND_MON, cur);
  BoxStorageUI._lastUsedBox = cur;
}

// Lua: box_storage_ui.lua:114
function current_box_data(): [any, number | null] {
  const storage = Storage.ensure(BoxStorageUI._session);
  if (!storage) return [null, null];
  const bId = storage.currentBox ?? 1;
  return [(storage.boxes as any)[bId], bId];
}

// Lua: box_storage_ui.lua:121
function mon_at_cursor(): [any, string | null, number | null | undefined, number | null] {
  const session = BoxStorageUI._session;
  const storage = Storage.ensure(session);
  if (BoxStorageUI.mode === "action_menu" && BoxStorageUI._actionTarget) {
    const t = BoxStorageUI._actionTarget;
    return [t.mon, t.loc, t.boxId, t.slot];
  } else if (BoxStorageUI.mode === "party_drawer" || (BoxStorageUI.drawerOpen && BoxStorageUI._actionSource === "party")) {
    const pIdx = BoxStorageUI.partyCursor ?? 1;
    if (pIdx < 1 || pIdx > 6) return [null, "party", null, pIdx];
    const isPickedUp = (BoxStorageUI.holdingMon && BoxStorageUI.holdingSource
      && BoxStorageUI.holdingSource.loc === "party"
      && BoxStorageUI.holdingSource.slot === pIdx);
    if (isPickedUp) {
      return [null, "party", null, pIdx];
    }
    return [session && session.party && session.party[pIdx], "party", null, pIdx];
  } else if (BoxStorageUI.cursorSlot >= 1 && BoxStorageUI.cursorSlot <= 30) {
    if (!storage) return [null, "box", null, BoxStorageUI.cursorSlot];
    const box = (storage.boxes as any)[storage.currentBox ?? 1];
    return [box && box.mons[BoxStorageUI.cursorSlot], "box", storage.currentBox, BoxStorageUI.cursorSlot];
  } else if (BoxStorageUI.cursorSlot <= -1 && BoxStorageUI.cursorSlot >= -6) {
    const pIdx = -BoxStorageUI.cursorSlot;
    return [session && session.party && session.party[pIdx], "party", null, pIdx];
  }
  return [null, null, null, null];
}

// Lua: box_storage_ui.lua:217
function switch_box(delta: number): void {
  const storage = Storage.ensure(BoxStorageUI._session);
  const cur = storage.currentBox ?? 1;
  storage.currentBox = mod(cur - 1 + delta, Storage.TOTAL_BOXES_COUNT) + 1;
  se(5);
}

// Lua: box_storage_ui.lua:224
function open_summary_for_cursor(): void {
  const returnMode = (BoxStorageUI._actionSource === "party" || BoxStorageUI.drawerOpen) ? "party_drawer" : "browse";
  const [mon, loc, , sId] = mon_at_cursor();
  if (!mon) return;

  if (loc === "box") {
    const [box] = current_box_data();
    const boxMons: LuaTable = seq();
    let startIndex = 1;
    for (let s = 1; s <= Storage.IN_BOX_COUNT; s++) {
      const m = box && box.mons[s];
      if (m) {
        boxMons[len(boxMons) + 1] = m;
        if (s === sId) {
          startIndex = len(boxMons);
        }
      }
    }
    if (len(boxMons) > 0) {
      SummaryMenu.openMenu(boxMons, startIndex, {
        session: BoxStorageUI._session,
        context: "box",
        onClose: () => {
          BoxStorageUI.mode = returnMode;
          se(5);
        },
      });
    }
  } else if (loc === "party") {
    const partyMons: LuaTable = seq();
    let startIndex = 1;
    const party = (BoxStorageUI._session && BoxStorageUI._session.party) ?? seq();
    for (let p = 1; p <= 6; p++) {
      const m = party[p];
      if (m) {
        partyMons[len(partyMons) + 1] = m;
        if (p === sId) {
          startIndex = len(partyMons);
        }
      }
    }
    SummaryMenu.openMenu(partyMons, startIndex, {
      session: BoxStorageUI._session,
      context: "party",
      onClose: () => {
        BoxStorageUI.mode = returnMode;
        se(5);
      },
    });
  }
}

export default BoxStorageUI;
