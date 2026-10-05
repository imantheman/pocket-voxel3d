// Port of gen1recomp src/ui/game3/pc_menu.lua (GPLv3 + additional terms; see LICENSE.md).
// FRLG PC Hub Menu & Player PC Item Storage (pret data/scripts/pc.inc).
//
// Options:
// 1. BILL'S PC / SOMEONE'S PC (Opens Pokémon Storage System)
// 2. <PLAYER>'S PC (ITEM STORAGE / MAILBOX / TURN OFF)
// 3. PROF. OAK'S PC (Pokédex Rating)
// 4. HALL OF FAME (Game Clear check)
// 5. LOG OFF (Turns off PC with SE_PC_OFF)

/* eslint-disable @typescript-eslint/no-explicit-any */
import { mod, tostring } from "../../../import/gen3/lua.ts";
import { gmatch } from "../platform/lpattern.ts";
import { insert, ipairs, len, seq, type LuaTable } from "../platform/lt.ts";
import { Stack } from "./stack.ts";
import { Window } from "./window.ts";
import { Storage } from "../core/storage.ts";
import { Strings } from "../shared/core/Strings.ts";
import { RomText } from "../core/rom_text.ts";
import { Profile } from "../core/profile.ts";
import { Audio } from "../core/audio.ts";
import { SE } from "../core/se_ids.ts";
import { Flags } from "../core/scripting/flags.ts";
import { Space } from "../core/scripting/space.ts";
import { BoxStorageUI } from "./box_storage_ui.ts";
import { ItemPc } from "./item_pc.ts";
import { BagMenu } from "./bag_menu.ts";

interface RootRow { id: string; label: string }
interface StorageOption { id: string; label: string; desc: string }

const FLAG_SYS_NOT_SOMEONES_PC = 0x834; // pokefirered/include/constants/flags.h:1386
const FLAG_SYS_POKEDEX_GET = 0x829; // pokefirered/include/constants/flags.h:1375
const FLAG_SYS_GAME_CLEAR = 0x82C; // pokefirered/include/constants/flags.h:1378

// pokefirered/src/script_menu.c:831
const SCR_MENU_CANCEL = 127;

// Lua: pc_menu.lua:37, :44 and :50 build these at require time. Here they are
// built on first use: inside the ES import cycle RomText may not be
// initialised yet when this module loads.
let TOP_ACTIONS_T: LuaTable;
let ITEM_STORAGE_ACTIONS_T: LuaTable;
let TEXT_T: Record<string, string | undefined> | undefined;
function TEXT(): Record<string, string | undefined> {
  if (!TEXT_T) {
    TEXT_T = RomText.lazy({
      WHAT_TO_DO: "gText_WhatWouldYouLikeToDo", // pokefirered/src/player_pc.c:160
      NO_ITEMS: "gText_ThereAreNoItems", // pokefirered/src/player_pc.c:367
      NO_MAIL: "gText_TheresNoMailHere", // pokefirered/src/player_pc.c:232
      ACCESS_WHICH_PC: "Text_AccessWhichPC", // data/scripts/pc.inc:21
    });
  }
  return TEXT_T;
}

export const PcMenu = {
  isMenu: true,

  open: false,
  mode: "root",
  cursor: 1,
  yesNoCursor: 2,
  storageCursor: null as number | null,

  _session: null as any,
  _onClose: null as ((result?: any) => void) | null,
  _closeOnExit: false,
  _silentClose: false,
  _select: false,
  _result: null as any,
  _status: null as string | null | undefined,
  _prevMode: null as string | null,
  _prevStatus: null as string | null | undefined,
  _prevCursor: null as number | null,
  _nextBedroom: null as boolean | null,
  _lastPrompt: null as string | null | undefined,
  _rootKey: null as string | null,
  _rootRows: null as LuaTable,

  // pokefirered/src/player_pc.c:85
  // Lua: pc_menu.lua:37
  get TOP_ACTIONS(): LuaTable {
    if (!TOP_ACTIONS_T) {
      TOP_ACTIONS_T = seq(
        rom_entry("item_storage", "sMenuActions_TopMenu[0]"),
        rom_entry("mailbox", "sMenuActions_TopMenu[1]"),
        rom_entry("turn_off", "sMenuActions_TopMenu[2]"),
      );
    }
    return TOP_ACTIONS_T;
  },

  // pokefirered/src/player_pc.c:94
  // Lua: pc_menu.lua:44
  get ITEM_STORAGE_ACTIONS(): LuaTable {
    if (!ITEM_STORAGE_ACTIONS_T) {
      ITEM_STORAGE_ACTIONS_T = seq(
        rom_entry("withdraw", "sMenuActions_ItemPc[0]", "sItemStorageActionDescriptionPtrs[0]"),
        rom_entry("deposit", "sMenuActions_ItemPc[1]", "sItemStorageActionDescriptionPtrs[1]"),
        rom_entry("cancel", "sMenuActions_ItemPc[2]", "sItemStorageActionDescriptionPtrs[2]"),
      );
    }
    return ITEM_STORAGE_ACTIONS_T;
  },

  // Lua: pc_menu.lua:76
  storageLabel: undefined as unknown as (session: any) => string,

  // pokefirered/src/script_menu.c:1006
  // Lua: pc_menu.lua:84
  _rootEntries(): LuaTable {
    const Rse = rse_pc();
    if (Rse) return Rse.rootEntries(PcMenu);
    const who = someone_or_bill_name(PcMenu._session);
    const player = player_pc_name(PcMenu._session);
    const store = script_store(PcMenu._session);
    const clear = Flags.getFlag(store, null, FLAG_SYS_GAME_CLEAR);
    const dex = clear || Flags.getFlag(store, null, FLAG_SYS_POKEDEX_GET);
    const key = (Strings.active() ? "t" : "e") + "\0" + who + "\0" + player
      + "\0" + (dex ? "d" : "") + (clear ? "c" : "");
    if (PcMenu._rootKey !== key) {
      PcMenu._rootKey = key;
      const rows: LuaTable = seq<RootRow>(
        { id: "storage", label: who },
        { id: "player", label: player },
      );
      if (dex) rows[len(rows) + 1] = { id: "oak", label: RomText.plain("gText_ProfOakSPc") };
      if (clear) rows[len(rows) + 1] = { id: "hall", label: RomText.plain("gText_HallOfFame_2") };
      rows[len(rows) + 1] = { id: "quit", label: RomText.plain("gText_LogOff") };
      PcMenu._rootRows = rows;
    }
    return PcMenu._rootRows;
  },

  // Lua: pc_menu.lua:109
  show(opts?: any): void {
    opts = opts ?? {};
    PcMenu.open = true;
    PcMenu._session = opts.session;
    PcMenu._onClose = opts.onClose;
    PcMenu._closeOnExit = opts.closeOnExit === true;
    PcMenu._silentClose = opts.silentClose === true;
    PcMenu._select = opts.startMode === "select";
    PcMenu._result = null;
    PcMenu.cursor = 1;
    PcMenu._prevStatus = null;
    PcMenu._prevCursor = null;
    Storage.ensure(PcMenu._session);
    const bedroom = opts.bedroom === true || PcMenu._nextBedroom === true;
    PcMenu._nextBedroom = null;
    if (opts.startMode === "player_pc" && rse_pc()) {
      rse_pc().enter(PcMenu, { bedroom });
    } else if (opts.startMode === "player_pc") {
      PcMenu.mode = "player_pc";
      PcMenu._status = TEXT().WHAT_TO_DO; // pokefirered/src/player_pc.c:160
    } else if (opts.startMode === "storage") {
      PcMenu.mode = "storage_menu";
      PcMenu.storageCursor = 1;
      PcMenu._status = PcMenu._storageOptions()[1].desc;
    } else if (PcMenu._select) {
      PcMenu.mode = "root";
      if (opts.prompt) PcMenu._lastPrompt = opts.prompt;
      PcMenu._status = PcMenu._lastPrompt;
    } else {
      PcMenu.mode = "root";
      PcMenu._status = TEXT().ACCESS_WHICH_PC;
    }
    Stack.push("pc_menu", PcMenu, { hideBelow: false });
  },

  // Lua: pc_menu.lua:144
  close(result?: any): void {
    PcMenu.open = false;
    Stack.pop("pc_menu");
    if (!PcMenu._silentClose) se(3);
    PcMenu._result = result;
    const cb = PcMenu._onClose;
    PcMenu._onClose = null;
    if (cb) cb(result);
  },

  // Lua: pc_menu.lua:161
  isOpen(): boolean {
    return PcMenu.open;
  },

  // Lua: pc_menu.lua:190
  _storageOptions(): LuaTable {
    return seq<StorageOption>(
      { id: "withdraw", label: RomText.plain("gText_WithdrawPokemon"), desc: RomText.plain("gText_WithdrawMonDescription") },
      { id: "deposit", label: RomText.plain("gText_DepositPokemon"), desc: RomText.plain("gText_DepositMonDescription") },
      { id: "move", label: RomText.plain("gText_MovePokemon"), desc: RomText.plain("gText_MoveMonDescription") },
      { id: "move_items", label: RomText.plain("gText_MoveItems"), desc: RomText.plain("gText_MoveItemsDescription") },
      { id: "quit", label: RomText.plain("gText_SeeYa"), desc: RomText.plain("gText_SeeYaDescription") },
    );
  },

  // Lua: pc_menu.lua:200
  handleInput(input: any): void {
    if (!PcMenu.open) return;
    const Rse = rse_pc();
    if (Rse && Rse.handles(PcMenu.mode)) return Rse.handleInput(PcMenu, input);

    // Message state
    if (PcMenu.mode === "msg") {
      if (input.wasPressed("a") || input.wasPressed("b")) {
        PcMenu.mode = PcMenu._prevMode ?? "root";
        PcMenu._status = PcMenu._prevStatus;
        if (PcMenu._prevCursor != null) PcMenu.cursor = PcMenu._prevCursor;
        PcMenu._prevStatus = null;
        PcMenu._prevCursor = null;
        se(5);
      }
      return;
    }

    // Storage System Menu (WITHDRAW POKéMON, DEPOSIT POKéMON, MOVE POKéMON, MOVE ITEMS, SEE YA!)
    const STORAGE_OPTIONS = PcMenu._storageOptions();

    // Root Menu
    if (PcMenu.mode === "root") {
      const entries = PcMenu._rootEntries();

      if (input.wasPressed("up")) {
        PcMenu.cursor = mod(PcMenu.cursor - 2, len(entries)) + 1;
        se(5);
      } else if (input.wasPressed("down")) {
        PcMenu.cursor = mod(PcMenu.cursor, len(entries)) + 1;
        se(5);
      } else if (input.wasPressed("a")) {
        const choice = entries[PcMenu.cursor] as RootRow;
        if (PcMenu._select || choice.id === "oak" || choice.id === "hall") {
          se(5); // pokefirered/src/menu.c:347
          return_row(PcMenu.cursor - 1);
        } else if (choice.id === "quit") {
          se(5); // pokefirered/src/menu.c:347
          PcMenu.close();
        } else if (choice.id === "storage") {
          se(5);
          se(2); // data/scripts/pc.inc:47
          PcMenu.mode = "storage_menu";
          PcMenu.storageCursor = PcMenu.storageCursor ?? 1;
          PcMenu.cursor = PcMenu.storageCursor;
          PcMenu._status = STORAGE_OPTIONS[PcMenu.cursor].desc;
        } else if (choice.id === "player") {
          se(5);
          se(2); // data/scripts/pc.inc:39
          PcMenu.mode = "player_pc";
          PcMenu.cursor = 1;
          PcMenu._status = RomText.plain("gText_WhatWouldYouLikeToDo");
        }
      } else if (input.wasPressed("b")) {
        se(5); // pokefirered/src/script_menu.c:831
        if (PcMenu._select) {
          return_row(SCR_MENU_CANCEL);
        } else {
          PcMenu.close();
        }
      }
      return;
    }

    // Storage Submenu (Withdraw, Deposit, Move Pokémon, Move Items, See Ya!)
    if (PcMenu.mode === "storage_menu") {
      if (input.wasPressed("up")) {
        PcMenu.cursor = mod(PcMenu.cursor - 2, len(STORAGE_OPTIONS)) + 1;
        PcMenu.storageCursor = PcMenu.cursor;
        PcMenu._status = STORAGE_OPTIONS[PcMenu.cursor].desc;
        se(5);
      } else if (input.wasPressed("down")) {
        PcMenu.cursor = mod(PcMenu.cursor, len(STORAGE_OPTIONS)) + 1;
        PcMenu.storageCursor = PcMenu.cursor;
        PcMenu._status = STORAGE_OPTIONS[PcMenu.cursor].desc;
        se(5);
      } else if (input.wasPressed("a")) {
        const choice = STORAGE_OPTIONS[PcMenu.cursor] as StorageOption;
        if (choice.id === "quit" && PcMenu._closeOnExit) {
          se(5);
          PcMenu.close();
        } else if (choice.id === "quit") {
          PcMenu.mode = "root";
          PcMenu.cursor = 1;
          PcMenu._status = TEXT().ACCESS_WHICH_PC;
          se(5);
        } else if (choice.id === "withdraw") {
          const party = (PcMenu._session && PcMenu._session.party) ?? seq();
          if (len(party) >= 6) {
            PcMenu._status = RomText.plain("gText_PartyFull");
            PcMenu._prevMode = "storage_menu";
            PcMenu.mode = "msg";
            se(5); // pokefirered/src/pokemon_storage_system_tasks.c:992
          } else {
            se(5);
            BoxStorageUI.show({
              session: PcMenu._session,
              subMode: "withdraw",
              onClose: () => {
                PcMenu.mode = "storage_menu";
                PcMenu.cursor = 1;
                PcMenu._status = STORAGE_OPTIONS[1].desc;
                se(2);
              },
            });
          }
        } else if (choice.id === "deposit") {
          const party = (PcMenu._session && PcMenu._session.party) ?? seq();
          if (len(party) <= 1) {
            PcMenu._status = RomText.plain("gText_JustOnePkmn");
            PcMenu._prevMode = "storage_menu";
            PcMenu.mode = "msg";
            se(SE.SE_FAILURE); // pokefirered/src/pokemon_storage_system_tasks.c:1052
          } else {
            se(5);
            BoxStorageUI.show({
              session: PcMenu._session,
              subMode: "deposit",
              onClose: () => {
                PcMenu.mode = "storage_menu";
                PcMenu.cursor = 2;
                PcMenu._status = STORAGE_OPTIONS[2].desc;
                se(2);
              },
            });
          }
        } else if (choice.id === "move" || choice.id === "move_items") {
          se(5);
          const curIdx = PcMenu.cursor;
          BoxStorageUI.show({
            session: PcMenu._session,
            subMode: choice.id,
            onClose: () => {
              PcMenu.mode = "storage_menu";
              PcMenu.cursor = curIdx;
              PcMenu._status = STORAGE_OPTIONS[curIdx].desc;
              se(2);
            },
          });
        }
      } else if (input.wasPressed("b") && PcMenu._closeOnExit) {
        se(5);
        PcMenu.close();
      } else if (input.wasPressed("b")) {
        PcMenu.mode = "root";
        PcMenu.cursor = 1;
        PcMenu._status = TEXT().ACCESS_WHICH_PC;
        se(5);
      }
      return;
    }

    // pokefirered/src/player_pc.c:189
    if (PcMenu.mode === "player_pc") {
      const actions = PcMenu.TOP_ACTIONS;
      if (input.wasPressed("up")) {
        if (PcMenu.cursor > 1) {
          PcMenu.cursor = PcMenu.cursor - 1;
          se(5);
        }
      } else if (input.wasPressed("down")) {
        if (PcMenu.cursor < len(actions)) {
          PcMenu.cursor = PcMenu.cursor + 1;
          se(5);
        }
      } else if (input.wasPressed("a") || input.wasPressed("b")) {
        se(5);
        const id = input.wasPressed("a") ? actions[PcMenu.cursor].id : "turn_off";
        if (id === "item_storage") {
          open_item_storage(1);
        } else if (id === "mailbox") {
          show_msg(TEXT().NO_MAIL, "player_pc", TEXT().WHAT_TO_DO, 1); // pokefirered/src/player_pc.c:227
        } else if (PcMenu._closeOnExit) {
          PcMenu.close(); // pokefirered/src/player_pc.c:257
        } else {
          PcMenu.mode = "root";
          PcMenu.cursor = 2;
          PcMenu._status = TEXT().ACCESS_WHICH_PC;
        }
      }
      return;
    }

    // pokefirered/src/player_pc.c:287
    if (PcMenu.mode === "item_storage") {
      const actions = PcMenu.ITEM_STORAGE_ACTIONS;
      if (input.wasPressed("up")) {
        if (PcMenu.cursor > 1) {
          PcMenu.cursor = PcMenu.cursor - 1;
          PcMenu._status = actions[PcMenu.cursor].desc;
          se(5);
        }
      } else if (input.wasPressed("down")) {
        if (PcMenu.cursor < len(actions)) {
          PcMenu.cursor = PcMenu.cursor + 1;
          PcMenu._status = actions[PcMenu.cursor].desc;
          se(5);
        }
      } else if (input.wasPressed("a") || input.wasPressed("b")) {
        se(5);
        const id = input.wasPressed("a") ? actions[PcMenu.cursor].id : "cancel";
        if (id === "withdraw") {
          const storage = Storage.ensure(PcMenu._session);
          if (len(storage.items) < 1) {
            show_msg(TEXT().NO_ITEMS, "item_storage", actions[1].desc, 1); // pokefirered/src/player_pc.c:352
          } else {
            // pokefirered/src/player_pc.c:378 Task_WithdrawItem_WaitFadeAndGoToItemStorage
            PcMenu.mode = "item_pc";
            ItemPc.show({
              session: PcMenu._session,
              onClose: () => { open_item_storage(1); },
            });
          }
        } else if (id === "deposit") {
          // pokefirered/src/player_pc.c:319 Task_DepositItem_WaitFadeAndGoToBag
          PcMenu.mode = "item_pc";
          const session = PcMenu._session;
          BagMenu.show(session && session.bag, {
            session,
            location: "itempc",
            pocket: "ITEMS",
            onClose: () => { open_item_storage(2); },
          });
        } else {
          PcMenu.mode = "player_pc"; // pokefirered/src/player_pc.c:399
          PcMenu.cursor = 1;
          PcMenu._status = TEXT().WHAT_TO_DO;
        }
      }
      return;
    }
  },

  // Lua: pc_menu.lua:437
  draw(): void {
    if (!PcMenu.open) return;
    const Rse = rse_pc();
    if (Rse && Rse.handles(PcMenu.mode)) return Rse.draw(PcMenu);
    if (Rse && PcMenu.mode === "root") {
      const labels: LuaTable = seq();
      for (const [i, e] of ipairs<RootRow>(PcMenu._rootEntries())) labels[i] = e.label;
      Rse.drawMenu(labels, PcMenu.cursor, len(labels) * 2);
      Rse.drawStatus(PcMenu);
      return;
    }

    // Root Menu Box
    if (PcMenu.mode === "root") {
      const entries = PcMenu._rootEntries();
      Window.stdFrame(Window.template(1, 1, 14, len(entries) * 2));
      for (const [i, e] of ipairs<RootRow>(entries)) {
        const yPx = 10 + (i - 1) * 16;
        if (i === PcMenu.cursor) Window.cursorPx(12, yPx);
        Window.printPx(e.label, 20, yPx);
      }

      // Bottom Dialogue
      Window.dialogueFrame();
      if (PcMenu._status) {
        const lines = status_lines();
        if (len(lines) > 0) Window.print(lines[1], 2, 15, { clipTiles: 26 });
        if (len(lines) > 1) Window.print(lines[2], 2, 17, { clipTiles: 26 });
      }
      return;
    }

    // Storage Submenu Box (WITHDRAW, DEPOSIT, MOVE, MOVE ITEMS, SEE YA!)
    if (PcMenu.mode === "storage_menu") {
      Window.stdFrame(Window.template(1, 1, 16, 10));
      for (const [i, opt] of ipairs<StorageOption>(PcMenu._storageOptions())) {
        const yPx = 10 + (i - 1) * 16;
        if (i === PcMenu.cursor) Window.cursorPx(12, yPx);
        Window.printPx(opt.label, 20, yPx);
      }

      // Bottom Dialogue
      Window.dialogueFrame();
      if (PcMenu._status) {
        const lines = status_lines();
        if (len(lines) > 0) Window.print(lines[1], 2, 15, { clipTiles: 26 });
        if (len(lines) > 1) Window.print(lines[2], 2, 17, { clipTiles: 26 });
      }
      return;
    }

    // pokefirered/src/player_pc.c:112
    if (PcMenu.mode === "player_pc" || PcMenu.mode === "item_storage") {
      const top = PcMenu.mode === "player_pc";
      const actions = top ? PcMenu.TOP_ACTIONS : PcMenu.ITEM_STORAGE_ACTIONS;
      Window.stdFrame(Window.template(1, 1, top ? 13 : 14, 6));
      for (const [i, e] of ipairs(actions)) {
        const yPx = 10 + (i - 1) * 16;
        if (i === PcMenu.cursor) Window.cursorPx(12, yPx);
        Window.printPx(e.label, 20, yPx);
      }
      draw_status_lines();
      return;
    }

    // Plain Message Box
    if (PcMenu.mode === "msg") {
      Window.dialogueFrame();
      if (PcMenu._status) Window.printPx(PcMenu._status, 16, 120);
      return;
    }
  },
};

// Lua: pc_menu.lua:20
function rse_pc(): any {
  if (Profile.family(PcMenu._session) !== "rse") return null;
  // NOT FAITHFUL: Emerald only (src.ui.game3.rse.player_pc is not ported)
  throw new Error("NOT FAITHFUL: Emerald only (rse/player_pc)");
}

// Lua: pc_menu.lua:30
// NOTE: e.id is a raw field next to the lazy label/desc, as Brian's rawset on
// the setmetatable'd table.
function rom_entry(id: string, labelKey: string, descKey?: string): any {
  const map: Record<string, string> = { label: labelKey };
  if (descKey != null) map.desc = descKey;
  const e: any = RomText.lazy(map);
  e.id = id;
  return e;
}

// Lua: pc_menu.lua:57
function se(id: unknown): void {
  try { Audio.playSe(id); } catch { /* pcall */ }
}

// Lua: pc_menu.lua:65
function script_store(session: any): any {
  // package.loaded["src.core.game3.scripting.space"]: always loaded here.
  return (Space && Space.store) ?? (session ? session.store : null) ?? session;
}

// pokefirered/src/script_menu.c:1027
// Lua: pc_menu.lua:71
function someone_or_bill_name(session: any): string {
  const isBill = Flags.getFlag(script_store(session), null, FLAG_SYS_NOT_SOMEONES_PC);
  return isBill ? RomText.plain("gText_BillSPc") : RomText.plain("gText_SomeoneSPc");
}
PcMenu.storageLabel = someone_or_bill_name;

// pokefirered/src/script_menu.c:1031
// Lua: pc_menu.lua:79
function player_pc_name(session: any): string {
  return RomText.plain("gText_SPc", { playerName: session ? (session.name ?? session.playerName) : undefined });
}

// Lua: pc_menu.lua:156
function return_row(index: number): void {
  PcMenu._silentClose = true;
  PcMenu.close(index);
}

// Lua: pc_menu.lua:165
function show_msg(text: string | undefined, prevMode: string, prevStatus: string | undefined, prevCursor: number): void {
  PcMenu._status = text;
  PcMenu._prevMode = prevMode;
  PcMenu._prevStatus = prevStatus;
  PcMenu._prevCursor = prevCursor;
  PcMenu.mode = "msg";
}

// Lua: pc_menu.lua:173
function open_item_storage(cursor: number): void {
  PcMenu.mode = "item_storage";
  PcMenu.cursor = cursor;
  PcMenu._status = PcMenu.ITEM_STORAGE_ACTIONS[cursor].desc;
}

// The status text's lines (`for line in s:gmatch("[^\r\n]+")`), shared by the
// three draw paths that inline the same loop in the Lua.
function status_lines(): LuaTable {
  const lines: LuaTable = seq();
  for (const [line] of gmatch(tostring(PcMenu._status), "[^\r\n]+")) {
    insert(lines, line);
  }
  return lines;
}

// Lua: pc_menu.lua:179
function draw_status_lines(): void {
  Window.dialogueFrame();
  if (!PcMenu._status) return;
  const lines = status_lines();
  if (len(lines) > 0) Window.print(lines[1], 2, 15, { clipTiles: 26 });
  if (len(lines) > 1) Window.print(lines[2], 2, 17, { clipTiles: 26 });
}

export default PcMenu;
