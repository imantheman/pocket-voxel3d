// Port of gen1recomp src/ui/game3/pokedex.lua (GPLv3 + additional terms; see LICENSE.md).
// game3 Pokédex UI: 1:1 Authentic Pokémon FireRed / LeafGreen Pokédex System.
// Implements:
// 1. Table of Contents (Mode Select) with orange section headers, Seen/Owned counts, and Category Icons.
// 2. Pokémon List (9 visible rows, №xxx, Pokéball badge, Species Name / -----, Type badges).
// 3. Detailed Data Screen (Top white card with specs, footprint, front pic; Bottom parchment card with 3-line flavor text; [START]CRY and {A}NEXT DATA).
// 4. Habitat Category Screen (Warm beige background, pulsing circular spotlight disc behind mon sprite, mini-page card with scanlines, side page flip arrows).
// 5. Area Map Screen (Kanto/Sevii Town Maps with blinking route markers or AREA UNKNOWN badge).
// 6. Size Comparison Screen (Trainer vs Mon scaling).
// 7. Caught Registration Screen.

import { format, rep, tonumber, tostring } from "../../../import/gen3/lua.ts";
import { ipairs, len, seq, type LuaTable } from "../platform/lt.ts";
import { G } from "../platform/graphics.ts";
import { Dex } from "../core/dex.ts";
import { Pokemon } from "../core/pokemon.ts";
import { Stack } from "./stack.ts";
import { FrlgFont, type Colors } from "./frlg_font.ts";
import { PokedexData } from "../core/pokedex_data.ts";
import { PokedexChrome } from "./pokedex_chrome.ts";
import { Strings } from "../shared/core/Strings.ts";
import { RomText } from "../core/rom_text.ts";
import { Audio } from "../core/audio.ts";
import { SE } from "../core/se_ids.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

void Strings; // required by Brian's module; nothing here calls it

interface InputLike { wasPressed(k: string): boolean }
interface ModeRow { isHeader?: boolean; id?: string; type?: string; icon?: string; unlocked?: boolean; label?: string }
interface XY { x: number; y: number }
interface SlotCoords { pic: XY; circle: XY; card: XY }

/** "№" (the Lua literal's UTF-8 bytes) */
const NO = "\xE2\x84\x96";

/** A colour table `{ fg = {r, g, b, a}, shadow = {...} }`. */
function cols(fg: number[], shadow: number[]): Colors {
  return { fg: seq(...fg) as number[], shadow: seq(...shadow) as number[], bg: undefined };
}

const LIST_VISIBLE = 9;

// pokefirered/src/pokedex_screen.c:347
const MODE_MAX_SHOWED = 9;

/**
 * Authentic pret sCategoryPageIconCoords layout mapping:
 * 1..4 mons on page: pic coords (top-left of 64x64 front sprite), circle coords (center of 32px radius spotlight), card coords (top-left of 64x38 mini card)
 */
const CATEGORY_PAGE_COORDS: Record<number, (SlotCoords | null)[]> = {
  1: seq(
    { pic: { x: 88, y: 24 }, circle: { x: 120, y: 56 }, card: { x: 88, y: 88 } },
  ),
  2: seq(
    { pic: { x: 24, y: 24 }, circle: { x: 56, y: 56 }, card: { x: 88, y: 24 } },
    { pic: { x: 144, y: 72 }, circle: { x: 176, y: 104 }, card: { x: 80, y: 88 } },
  ),
  3: seq(
    { pic: { x: 8, y: 16 }, circle: { x: 40, y: 48 }, card: { x: 72, y: 16 } },
    { pic: { x: 88, y: 72 }, circle: { x: 120, y: 104 }, card: { x: 24, y: 88 } },
    { pic: { x: 168, y: 24 }, circle: { x: 200, y: 56 }, card: { x: 168, y: 88 } },
  ),
  4: seq(
    { pic: { x: 0, y: 16 }, circle: { x: 32, y: 48 }, card: { x: 48, y: 24 } },
    { pic: { x: 56, y: 80 }, circle: { x: 88, y: 112 }, card: { x: 0, y: 96 } },
    { pic: { x: 120, y: 80 }, circle: { x: 152, y: 112 }, card: { x: 176, y: 88 } },
    { pic: { x: 176, y: 16 }, circle: { x: 208, y: 48 }, card: { x: 120, y: 32 } },
  ),
};

// Lua: pokedex.lua:86
function se(id: unknown): void {
  try {
    if (typeof id === "number") {
      Audio.playSe(id);
    } else if (SE && SE[id as string] != null) {
      Audio.playSe(SE[id as string]);
    }
  } catch { /* pcall */ }
}

// Lua: pokedex.lua:98
function play_cry(speciesId: unknown): void {
  try {
    if (Audio && Audio.playCry) {
      Audio.playCry(speciesId);
    }
  } catch { /* pcall */ }
}

// Lua: pokedex.lua:107
function species_label(sp: unknown): string {
  return Pokemon.name(sp);
}

const HABITAT_IDS = seq("grassland", "forest", "waters_edge", "sea", "cave", "mountain", "rough_terrain", "urban", "rare");

// src/pokedex_screen.c:320, :363
// Lua: pokedex.lua:114
function build_modes(session: any, dex: any): (ModeRow | null)[] {
  const isNat = PokedexData.isNationalUnlocked(session, dex);
  const rows: (ModeRow | null)[] = seq({ isHeader: true });
  if (isNat) {
    rows[len(rows) + 1] = { id: "numerical_kanto", type: "order", icon: "numerical", unlocked: true };
    rows[len(rows) + 1] = { id: "numerical_national", type: "order", icon: "numerical", unlocked: true };
  } else {
    rows[len(rows) + 1] = { id: "numerical_kanto", type: "order", icon: "numerical", unlocked: true };
  }
  rows[len(rows) + 1] = { isHeader: true };
  for (const [, id] of ipairs<string>(HABITAT_IDS)) {
    rows[len(rows) + 1] = { id, type: "habitat", icon: id, unlocked: PokedexData.isCategoryUnlocked(dex, id) };
  }
  rows[len(rows) + 1] = { isHeader: true };
  for (const [, id] of ipairs<string>(seq("atoz", "type", "lightest", "smallest"))) {
    rows[len(rows) + 1] = { id, type: "order", icon: id, unlocked: true };
  }
  rows[len(rows) + 1] = { isHeader: true };
  rows[len(rows) + 1] = { id: "cancel", type: "cancel", icon: "cancel", unlocked: true };

  const items = isNat ? "sListMenuItems_NatDexModeSelect" : "sListMenuItems_KantoDexModeSelect";
  for (const [i, row] of ipairs<ModeRow>(rows)) {
    row.label = RomText.at(items, i - 1);
  }
  return rows;
}

// src/pokedex_screen.c:803
// Lua: pokedex.lua:144
function category_title(id: string): string {
  for (const [i, hid] of ipairs<string>(HABITAT_IDS)) {
    if (hid === id) return RomText.at("sDexCategoryNamePtrs", i - 1);
  }
  throw new Error("unknown dex habitat " + tostring(id));
}

// src/pokedex_screen.c:2360
// Lua: pokedex.lua:152
function page_label(cur: number, total: number): string {
  return RomText.plain("gText_Page") + format("%2d/%2d", cur, total);
}

// pokefirered/src/pokedex_screen.c:3260
const HABITAT_CATEGORIES = seq(
  "grassland", "forest", "waters_edge", "sea", "cave",
  "mountain", "rough_terrain", "urban", "rare",
);

// =========================================================================
// Input Handling
// =========================================================================

// pokefirered/src/list_menu.c:438
// Lua: pokedex.lua:310
function mode_row_step(movingDown: boolean): number {
  const total = len(Pokedex.MODES);
  const maxScroll = Math.max(0, total - MODE_MAX_SHOWED);
  let scroll: number = Pokedex.modeScroll;
  let itemsAbove = Pokedex.modeCursor - 1 - scroll;
  let newRow: number;

  const landOn = (row: number): boolean => {
    const item: ModeRow | null | undefined = Pokedex.MODES[scroll + row + 1];
    if (item && !item.isHeader) {
      Pokedex.modeCursor = scroll + row + 1;
      return true;
    }
    return false;
  };

  if (!movingDown) {
    newRow = MODE_MAX_SHOWED - (Math.floor(MODE_MAX_SHOWED / 2) + MODE_MAX_SHOWED % 2) - 1;
    if (scroll === 0) {
      while (itemsAbove !== 0) {
        itemsAbove = itemsAbove - 1;
        if (landOn(itemsAbove)) return 1;
      }
      return 0;
    }
    while (itemsAbove > newRow) {
      itemsAbove = itemsAbove - 1;
      if (landOn(itemsAbove)) return 1;
    }
    scroll = scroll - 1;
  } else {
    newRow = Math.floor(MODE_MAX_SHOWED / 2) + MODE_MAX_SHOWED % 2;
    if (scroll >= maxScroll) {
      while (itemsAbove < MODE_MAX_SHOWED - 1) {
        itemsAbove = itemsAbove + 1;
        if (landOn(itemsAbove)) return 1;
      }
      return 0;
    }
    while (itemsAbove < newRow) {
      itemsAbove = itemsAbove + 1;
      if (landOn(itemsAbove)) return 1;
    }
    scroll = scroll + 1;
  }

  Pokedex.modeScroll = scroll;
  Pokedex.modeCursor = scroll + newRow + 1;
  return 2;
}

// pokefirered/src/list_menu.c:558
// Lua: pokedex.lua:363
function mode_change_selection(movingDown: boolean): boolean {
  let changed = false;
  for (;;) {
    const ret = mode_row_step(movingDown);
    if (ret !== 0) changed = true;
    if (ret !== 2) break;
    const item: ModeRow | null | undefined = Pokedex.MODES[Pokedex.modeCursor];
    if (!(item && item.isHeader)) break;
  }
  return changed;
}

// Lua: pokedex.lua:375
function handle_mode_select_input(input: InputLike): void {
  if (input.wasPressed("up")) {
    // pokefirered/src/pokedex_screen.c:1175-1176
    if (mode_change_selection(false)) se("SE_SELECT");
  } else if (input.wasPressed("down")) {
    if (mode_change_selection(true)) se("SE_SELECT");
  } else if (input.wasPressed("a")) {
    const m: ModeRow | null | undefined = Pokedex.MODES[Pokedex.modeCursor];
    if (!m || m.isHeader) return;
    if (m.type === "habitat") {
      if (m.unlocked) {
        Pokedex.currentCategory = m.id;
        Pokedex.categoryPage = 1;
        Pokedex.categorySlot = 1;
        Pokedex.screen = "category_grid";
        se("SE_SELECT");
      }
    } else if (m.type === "order") {
      Pokedex.currentOrder = m.id;
      Pokedex.listCursor = 1;
      Pokedex.cursor = 1;
      Pokedex.listScroll = 0;
      Pokedex.screen = "ordered_list";
      se("SE_SELECT");
    } else if (m.type === "cancel") {
      Pokedex.close();
    }
  } else if (input.wasPressed("b") || input.wasPressed("start")) {
    Pokedex.close();
  }
}

// Lua: pokedex.lua:408
function handle_category_grid_input(input: InputLike): void {
  const dex = Pokedex._dex;
  const pages = PokedexData.getUnlockedCategoryPages(Pokedex.currentCategory, dex);
  const maxPages = Math.max(1, len(pages));
  Pokedex.categoryPage = Math.max(1, Math.min(Pokedex.categoryPage, maxPages));
  const curMons: LuaTable = (pages[Pokedex.categoryPage] && pages[Pokedex.categoryPage].mons) || {};
  const numMons = Math.max(1, len(curMons));
  Pokedex.categorySlot = Math.max(1, Math.min(Pokedex.categorySlot, numMons));

  if (input.wasPressed("left") || input.wasPressed("l")) {
    if (input.wasPressed("l") || Pokedex.categorySlot === 1) {
      if (Pokedex.categoryPage > 1) {
        Pokedex.categoryPage = Pokedex.categoryPage - 1;
        const newMons: LuaTable = (pages[Pokedex.categoryPage] && pages[Pokedex.categoryPage].mons) || {};
        Pokedex.categorySlot = Math.max(1, len(newMons));
        se("SE_PAGE");
      } else if (maxPages > 1 && input.wasPressed("l")) {
        Pokedex.categoryPage = maxPages;
        Pokedex.categorySlot = 1;
        se("SE_PAGE");
      }
    } else {
      Pokedex.categorySlot = Pokedex.categorySlot - 1;
      se("SE_SELECT");
    }
  } else if (input.wasPressed("right") || input.wasPressed("r")) {
    if (input.wasPressed("r") || Pokedex.categorySlot === numMons) {
      if (Pokedex.categoryPage < maxPages) {
        Pokedex.categoryPage = Pokedex.categoryPage + 1;
        Pokedex.categorySlot = 1;
        se("SE_PAGE");
      } else if (maxPages > 1 && input.wasPressed("r")) {
        Pokedex.categoryPage = 1;
        Pokedex.categorySlot = 1;
        se("SE_PAGE");
      }
    } else {
      Pokedex.categorySlot = Pokedex.categorySlot + 1;
      se("SE_SELECT");
    }
  } else if (input.wasPressed("up")) {
    if (Pokedex.categorySlot > 1) {
      Pokedex.categorySlot = Pokedex.categorySlot - 1;
      se("SE_SELECT");
    }
  } else if (input.wasPressed("down")) {
    if (Pokedex.categorySlot < numMons) {
      Pokedex.categorySlot = Pokedex.categorySlot + 1;
      se("SE_SELECT");
    }
  } else if (input.wasPressed("a")) {
    const sp = curMons[Pokedex.categorySlot];
    if (sp && Dex.isSeen(dex, sp)) {
      Pokedex.selectedSpecies = sp;
      Pokedex.dataPage = 1;
      Pokedex.page = "entry";
      Pokedex.subScreenPrev = "category_grid";
      Pokedex.screen = "data";
      se("SE_SELECT");
      play_cry(sp);
    } else {
      se("SE_HAZARD");
    }
  } else if (input.wasPressed("select")) {
    const sp = curMons[Pokedex.categorySlot];
    if (sp && Dex.isSeen(dex, sp)) {
      play_cry(sp);
    }
  } else if (input.wasPressed("b")) {
    Pokedex.screen = "mode_select";
    se("SE_SELECT");
  }
}

/** -> [index, species] */
// Lua: pokedex.lua:487
function find_adjacent_seen(orderKey: string, startIdx: number, delta: number): [number, any] {
  const list = PokedexData.getOrderList(orderKey, Pokedex._dex);
  const total = len(list);
  let cur = startIdx + delta;
  while (cur >= 1 && cur <= total) {
    const sp = list[cur];
    if (Dex.isSeen(Pokedex._dex, sp)) {
      return [cur, sp];
    }
    cur = cur + delta;
  }
  return [startIdx, list[startIdx]];
}

// Lua: pokedex.lua:501
function handle_ordered_list_input(input: InputLike): void {
  const list = PokedexData.getOrderList(Pokedex.currentOrder, Pokedex._dex);
  const total = len(list);

  if (input.wasPressed("up")) {
    if (Pokedex.listCursor > 1) {
      Pokedex.listCursor = Pokedex.listCursor - 1;
      Pokedex.cursor = Pokedex.listCursor;
      if (Pokedex.listCursor <= Pokedex.listScroll) {
        Pokedex.listScroll = Pokedex.listCursor - 1;
      }
      se("SE_SELECT");
    }
  } else if (input.wasPressed("down")) {
    if (Pokedex.listCursor < total) {
      Pokedex.listCursor = Pokedex.listCursor + 1;
      Pokedex.cursor = Pokedex.listCursor;
      if (Pokedex.listCursor > Pokedex.listScroll + LIST_VISIBLE) {
        Pokedex.listScroll = Pokedex.listCursor - LIST_VISIBLE;
      }
      se("SE_SELECT");
    }
  } else if (input.wasPressed("left") || input.wasPressed("l")) {
    if (Pokedex.currentOrder === "numerical_national") {
      Pokedex.currentOrder = "numerical_kanto";
      Pokedex.mode = "kanto";
      const kantoList = PokedexData.getOrderList("numerical_kanto", Pokedex._dex);
      Pokedex.listCursor = Math.min(len(kantoList), Pokedex.listCursor);
      Pokedex.cursor = Pokedex.listCursor;
      se("SE_SELECT");
    } else {
      Pokedex.listCursor = Math.max(1, Pokedex.listCursor - 10);
      Pokedex.cursor = Pokedex.listCursor;
      Pokedex.listScroll = Math.max(0, Pokedex.listCursor - 1);
      se("SE_PAGE");
    }
  } else if (input.wasPressed("right") || input.wasPressed("r")) {
    if (Pokedex.currentOrder === "numerical_kanto" && Pokedex.mode === "kanto") {
      Pokedex.currentOrder = "numerical_national";
      Pokedex.mode = "national";
      se("SE_SELECT");
    } else {
      Pokedex.listCursor = Math.min(total, Pokedex.listCursor + 10);
      Pokedex.cursor = Pokedex.listCursor;
      if (Pokedex.listCursor > Pokedex.listScroll + LIST_VISIBLE) {
        Pokedex.listScroll = Math.max(0, Pokedex.listCursor - LIST_VISIBLE);
      }
      se("SE_PAGE");
    }
  } else if (input.wasPressed("a")) {
    const sp = list[Pokedex.listCursor];
    if (sp && Dex.isSeen(Pokedex._dex, sp)) {
      Pokedex.selectedSpecies = sp;
      Pokedex.dataPage = 1;
      Pokedex.page = "entry";
      Pokedex.screen = "data";
      Pokedex.subScreenPrev = "ordered_list";
      se("SE_SELECT");
      play_cry(sp);
    } else {
      se("SE_HAZARD");
    }
  } else if (input.wasPressed("select")) {
    const sp = list[Pokedex.listCursor];
    if (sp && Dex.isSeen(Pokedex._dex, sp)) {
      play_cry(sp);
    }
  } else if (input.wasPressed("b")) {
    Pokedex.screen = "mode_select";
    se("SE_SELECT");
  }
}

// Lua: pokedex.lua:578
function handle_data_input(input: InputLike): void {
  if (input.wasPressed("a")) {
    if (Pokedex.dataPage === 1) {
      Pokedex.dataPage = 2;
      se("SE_SELECT");
    } else {
      // On page 2, A is CANCEL (returns to list/grid)
      Pokedex.page = "list";
      Pokedex.screen = Pokedex.subScreenPrev;
      se("SE_SELECT");
    }
  } else if (input.wasPressed("b")) {
    if (Pokedex.dataPage === 2) {
      // On page 2, B is PREVIOUS DATA (returns to page 1)
      Pokedex.dataPage = 1;
      se("SE_SELECT");
    } else {
      // On page 1, B is CANCEL (returns to list/grid)
      Pokedex.page = "list";
      Pokedex.screen = Pokedex.subScreenPrev;
      se("SE_SELECT");
    }
  } else if (input.wasPressed("up")) {
    const [newIdx, newSp] = find_adjacent_seen(Pokedex.currentOrder, Pokedex.listCursor, -1);
    if (newIdx !== Pokedex.listCursor) {
      Pokedex.listCursor = newIdx;
      Pokedex.cursor = newIdx;
      Pokedex.selectedSpecies = newSp;
      Pokedex.dataPage = 1;
      se("SE_SELECT");
      play_cry(newSp);
    }
  } else if (input.wasPressed("down")) {
    const [newIdx, newSp] = find_adjacent_seen(Pokedex.currentOrder, Pokedex.listCursor, 1);
    if (newIdx !== Pokedex.listCursor) {
      Pokedex.listCursor = newIdx;
      Pokedex.cursor = newIdx;
      Pokedex.selectedSpecies = newSp;
      Pokedex.dataPage = 1;
      se("SE_SELECT");
      play_cry(newSp);
    }
  } else if (input.wasPressed("select") || input.wasPressed("start")) {
    const sp = Pokedex._regSpecies || Pokedex.selectedSpecies;
    play_cry(sp);
  }
}

// pokefirered/src/pokedex_screen.c:3427
// Lua: pokedex.lua:637
function handle_registration_input(input: InputLike): void {
  if (input.wasPressed("a") || input.wasPressed("b")) {
    Pokedex.close();
  }
}

// =========================================================================
// Render Passes (Authentic FRLG Layout & Styling)
// =========================================================================

const ORANGE = cols([255 / 255, 139 / 255, 57 / 255, 1], [205 / 255, 65 / 255, 57 / 255, 1]);
const BLACK_ON_GREY = cols([0x18 / 255, 0x18 / 255, 0x18 / 255, 1], [0xD0 / 255, 0xD0 / 255, 0xD0 / 255, 1]);
const LOCKED = cols([0xB8 / 255, 0xC0 / 255, 0xC8 / 255, 1], [0xE0 / 255, 0xE8 / 255, 0xF0 / 255, 1]);

/** 1. Table of Contents (Mode Select) Screen */
// Lua: pokedex.lua:664
function draw_mode_select(): void {
  const dex = Pokedex._dex;
  PokedexChrome.drawPaperBg();

  // Top Header Bar: POKéDEX   TABLE OF CONTENTS (centered, y=2)
  PokedexChrome.drawHeader(RomText.plain("gText_PokedexTableOfContents"), undefined, 2);

  // Left Column: 9 visible rows inside window (x=8, y=16..144, 14px pitch)
  const maxVisible = MODE_MAX_SHOWED;
  const startIdx = Pokedex.modeScroll + 1;
  const endIdx = Math.min(len(Pokedex.MODES), Pokedex.modeScroll + maxVisible);

  for (let i = startIdx; i <= endIdx; i++) {
    const r = i - startIdx;
    const y = 18 + r * 14;
    const m: ModeRow = Pokedex.MODES[i];

    if (m.isHeader) {
      // Section Header in bold vibrant orange with warm red shadow (GBA colors 15 & 14)
      FrlgFont.draw(m.label, 8, y, { colors: ORANGE });
    } else {
      // Cursor arrow
      if (i === Pokedex.modeCursor) {
        G.setColor(0x18 / 255, 0x18 / 255, 0x18 / 255, 1);
        G.polygon("fill",
          12, y + 2,
          17, y + 6,
          12, y + 10);
      }

      // Text colors: Unlocked (black) vs Locked (faint light grey)
      const txtColors = m.unlocked === false ? LOCKED : BLACK_ON_GREY;
      FrlgFont.draw(m.label, 20, y, { colors: txtColors });
    }
  }

  // Right Column: Seen & Owned Stats
  const isNat = PokedexData.isNationalUnlocked(Pokedex._session, dex);
  if (isNat) {
    const kantoSeen = Dex.countSeen(dex, "kanto");
    const natSeen = Dex.countSeen(dex, "national");
    const kantoOwn = Dex.countCaught(dex, "kanto");
    const natOwn = Dex.countCaught(dex, "national");

    FrlgFont.draw(RomText.plain("gText_Seen"), 168, 18, { small: true, colors: BLACK_ON_GREY });
    FrlgFont.draw(RomText.plain("gText_Kanto"), 176, 29, { small: true, colors: BLACK_ON_GREY });
    FrlgFont.draw(format("%3d", kantoSeen), 212, 29, { colors: ORANGE });
    FrlgFont.draw(RomText.plain("gText_National"), 176, 40, { small: true, colors: BLACK_ON_GREY });
    FrlgFont.draw(format("%3d", natSeen), 212, 40, { colors: ORANGE });

    FrlgFont.draw(RomText.plain("gText_Owned"), 168, 53, { small: true, colors: BLACK_ON_GREY });
    FrlgFont.draw(RomText.plain("gText_Kanto"), 176, 64, { small: true, colors: BLACK_ON_GREY });
    FrlgFont.draw(format("%3d", kantoOwn), 212, 64, { colors: ORANGE });
    FrlgFont.draw(RomText.plain("gText_National"), 176, 75, { small: true, colors: BLACK_ON_GREY });
    FrlgFont.draw(format("%3d", natOwn), 212, 75, { colors: ORANGE });
  } else {
    const kantoSeen = Dex.countSeen(dex, "kanto");
    const kantoOwn = Dex.countCaught(dex, "kanto");

    FrlgFont.draw(RomText.plain("gText_Seen"), 168, 25, { colors: BLACK_ON_GREY });
    FrlgFont.draw(format("%3d", kantoSeen), 212, 37, { colors: ORANGE });

    FrlgFont.draw(RomText.plain("gText_Owned"), 168, 53, { colors: BLACK_ON_GREY });
    FrlgFont.draw(format("%3d", kantoOwn), 212, 65, { colors: ORANGE });
  }

  // Category Preview Icon at x=168, y=88 (64x48)
  const selMode: ModeRow | null | undefined = Pokedex.MODES[Pokedex.modeCursor];
  if (selMode && selMode.icon) {
    PokedexChrome.drawCategoryIcon(selMode.icon, 168, 88);
  }

  // pokefirered/src/pokedex_screen.c:407-435, :1031-1035
  if (Pokedex.modeScroll > 0) {
    PokedexChrome.drawUpArrow(200, 19);
  }
  if (Pokedex.modeScroll < len(Pokedex.MODES) - maxVisible) {
    PokedexChrome.drawDownArrow(200, 141);
  }

  // Bottom Bar Controls: {DPAD_UPDOWN}PICK   {A_BUTTON}OK
  PokedexChrome.drawControlInfo(RomText.plain("gText_PickOK"), 236, 146);
}

/** 2. Pokémon List Screen (9 Rows) */
// Lua: pokedex.lua:774
function draw_ordered_list(): void {
  const dex = Pokedex._dex;
  PokedexChrome.drawPaperBg();

  // Top Header Bar: POKéMON LIST (centered, y=2)
  PokedexChrome.drawHeader(RomText.plain("gText_PokemonListNoColor"), undefined, 2);

  const list = PokedexData.getOrderList(Pokedex.currentOrder, dex);
  const total = len(list);
  const textColors = BLACK_ON_GREY;

  // 9 visible rows (y = 18 + (i - 1) * 14)
  for (let i = 1; i <= LIST_VISIBLE; i++) {
    const idx = Pokedex.listScroll + i;
    if (idx > total) break;

    const rowY = 18 + (i - 1) * 14;
    const sp = list[idx];
    const seen = Dex.isSeen(dex, sp);
    const caught = Dex.isCaught(dex, sp);

    if (idx === Pokedex.listCursor) {
      // Black cursor triangle at x=20
      G.setColor(0x18 / 255, 0x18 / 255, 0x18 / 255, 1);
      G.polygon("fill",
        20, rowY + 3,
        25, rowY + 7,
        20, rowY + 11);
    }

    // Number: №001 (FONT_SMALL at x=28)
    const natId = Pokemon.national(sp) || 0;
    const num = (Pokedex.currentOrder === "numerical_kanto") ? sp : natId;
    const numStr = format(NO + "%03d", num);
    FrlgFont.draw(numStr, 28, rowY + 1, {
      small: true,
      colors: textColors,
    });

    // Caught Poké Ball icon at x=56
    if (caught) {
      PokedexChrome.drawCaughtMarker(56, rowY + 1);
    }

    // Name / dashes at x=72 (FONT_NORMAL)
    // src/pokedex_screen.c:1396
    const nameStr = seen ? species_label(sp) : RomText.plain("gText_5Dashes");
    FrlgFont.draw(nameStr, 72, rowY, {
      colors: textColors,
    });

    // Type badges on right side if caught (Type 1 at x=136, Type 2 at x=168)
    if (caught) {
      const t = Pokemon.types ? Pokemon.types(sp) : undefined;
      if (t && t[1] != null) {
        PokedexChrome.drawTypeBadge(t[1], 136, rowY + 1);
      }
      if (t && t[2] != null && t[2] !== t[1]) {
        PokedexChrome.drawTypeBadge(t[2], 168, rowY + 1);
      }
    }
  }

  // Scroll Down Arrow at x=200, y=141
  if (Pokedex.listScroll + LIST_VISIBLE < total) {
    PokedexChrome.drawDownArrow(200, 141);
  }
  if (Pokedex.listScroll > 0) {
    PokedexChrome.drawUpArrow(200, 19);
  }

  // Bottom Bar Controls: {DPAD_UPDOWN}PICK   {A_BUTTON}OK   {B_BUTTON}CANCEL
  PokedexChrome.drawControlInfo(RomText.plain("gText_PickOKExit"), 236, 146);
}

/** 3. Detailed Data Entry Screen (Page 1: Specs & Flavor Text, Page 2: Size Chart & Area Map) */
// Lua: pokedex.lua:860
function draw_data_screen(): void {
  const dex = Pokedex._dex;
  const sp = Pokedex._regSpecies || Pokedex.selectedSpecies;
  const natId = Pokemon.national(sp) || 0;
  const dispNum = (Pokedex.currentOrder === "numerical_kanto") ? sp : natId;
  const name = species_label(sp);
  const entry = PokedexChrome.getEntry(sp);
  const isCaught = Dex.isCaught(dex, sp);
  const isPage2 = (Pokedex.dataPage === 2);

  // Authentic pret Pokédex card text colors
  const upperColors = cols([0, 0, 0, 1], [230 / 255, 222 / 255, 197 / 255, 1]);
  const lowerColors = cols([0, 0, 0, 1], [197 / 255, 180 / 255, 139 / 255, 1]);

  if (!isPage2) {
    // ================= PAGE 1: SPECS & FLAVOR TEXT =================
    // 1. Card Background Chassis (240x160 FRLG exact tilemap card)
    PokedexChrome.drawDataCardBg();

    // 2. Top Header Bar
    if (Pokedex.subScreenPrev === "category_grid") {
      PokedexChrome.drawHeader(category_title(Pokedex.currentCategory), 8, 2);
      PokedexChrome.drawHeader(page_label(1, 2), 176, 2);
    } else {
      PokedexChrome.drawHeader(RomText.plain("gText_PokemonListNoColor"), undefined, 2);
    }

    // 3. Top Specs Window (sWindowTemplate_DexEntry_SpeciesStats at x=16, y=24)
    // Line 1 (y = 32): Dex No in FONT_SMALL at x=16; Species Name in FONT_NORMAL at x=44
    const noStr = format(NO + "%03d", dispNum);
    FrlgFont.draw(noStr, 16, 32, { small: true, colors: upperColors });
    FrlgFont.draw(name, 44, 32, { small: false, colors: upperColors });

    // Line 2 (y = 48): Category in FONT_SMALL at x=16
    // src/pokedex_screen.c:2694
    const catStr = isCaught ? entry.categoryName : (rep("?", 11) + RomText.plain("gText_PokedexPokemon"));
    FrlgFont.draw(catStr, 16, 48, { small: true, colors: upperColors });

    // Line 3 (y = 60): HT in FONT_SMALL at x=16; Height value at x=46
    FrlgFont.draw(RomText.plain("gText_HT"), 16, 60, { small: true, colors: upperColors });
    const htStr = isCaught ? (entry.heightFormatted || " ??'??\"") : " ??'??\"";
    FrlgFont.draw(htStr, 46, 60, { small: true, colors: upperColors });

    // Line 4 (y = 72): WT in FONT_SMALL at x=16; Weight value at x=46
    FrlgFont.draw(RomText.plain("gText_WT"), 16, 72, { small: true, colors: upperColors });
    // src/pokedex_screen.c:2834
    const wtStr = isCaught ? entry.weightFormatted : ("????.? " + RomText.plain("gText_Lbs"));
    FrlgFont.draw(wtStr, 46, 72, { small: true, colors: upperColors });

    // Footprint (16x16) at screen x=104, y=64 (window x=88, y=40)
    if (isCaught) {
      PokedexChrome.drawFootprint(sp, 104, 64);
    }

    // Front Sprite (64x64) at screen x=152, y=24 (sWindowTemplate_DexEntry_MonPic at x=152, y=24)
    const pic = Pokemon.dexFrontPic(sp, Dex.defaultPersonality(Pokedex._dex, sp));
    if (pic && pic.image) {
      G.setColor(1, 1, 1, 1);
      G.draw(pic.image, 152, 24);
    }

    // 4. Bottom Flavor Text Window (sWindowTemplate_DexEntry_FlavorText at x=0, y=88, w=240, h=56)
    if (isCaught) {
      const desc = entry.description;
      if (desc && desc.length > 0) {
        const maxW = FrlgFont.measure(desc);
        const startX = Math.max(0, Math.floor((240 - maxW) / 2));
        FrlgFont.draw(desc, startX, 96, {
          colors: lowerColors,
          linePitch: 14,
          maxWidth: 240,
        });
      }
    }

    // 5. Bottom Bar Controls
    const [cryHint, controlInfo] = Pokedex.controlInfoForDataPage(Pokedex.screen);
    if (cryHint) {
      PokedexChrome.drawControlInfoLeft(cryHint, 8, 146);
    }
    PokedexChrome.drawControlInfo(controlInfo, 236, 146);
  } else {
    // ================= PAGE 2: SIZE CHART & AREA MAP =================
    // 1. Area Card Background Chassis (240x160 white card with inset size box)
    PokedexChrome.drawAreaCardBg();

    // 2. Top Header Bar
    if (Pokedex.subScreenPrev === "category_grid") {
      PokedexChrome.drawHeader(category_title(Pokedex.currentCategory), 8, 2);
      PokedexChrome.drawHeader(page_label(2, 2), 176, 2);
    } else {
      PokedexChrome.drawHeader(RomText.plain("gText_PokemonListNoColor"), undefined, 2);
    }

    // 3. Top Left: Mon Icon (32x32) at (14, 20)
    const icon = Pokemon.dexIcon(sp, Dex.defaultPersonality(Pokedex._dex, sp));
    if (icon && icon.image) {
      const q = icon.quads && icon.quads[0];
      G.setColor(1, 1, 1, 1);
      if (q) {
        G.draw(icon.image, q, 14, 20);
      } else {
        G.draw(icon.image, 14, 20);
      }
    }

    // Top Left: Dex No & Species Name
    const noStr = format(NO + "%03d", dispNum);
    FrlgFont.draw(noStr, 48, 16, { small: true, colors: upperColors });
    FrlgFont.draw(name, 51, 28, { small: false, colors: upperColors });

    // Top Left: Type Badges (at x=48, y=42)
    if (isCaught) {
      const t = Pokemon.types ? Pokemon.types(sp) : undefined;
      const t1 = t ? t[1] : undefined;
      const t2 = t ? t[2] : undefined;
      if (t1 != null) {
        PokedexChrome.drawTypeBadge(t1, 48, 42);
      }
      if (t2 != null && t2 !== t1) {
        PokedexChrome.drawTypeBadge(t2, 80, 42);
      }
    }

    // 4. Left Bottom: SIZE Title & Size Comparison Silhouettes
    // pokefirered/src/pokedex_screen.c:648
    const sizeW = FrlgFont.measure(RomText.plain("gText_Size"), { small: true });
    FrlgFont.draw(RomText.plain("gText_Size"), 16 + Math.floor((80 - sizeW) / 2), 60, { small: true, colors: upperColors });

    if (isCaught) {
      // pokefirered/src/pokedex_screen.c:3107
      const pic = Pokemon.dexFrontPic(sp, Dex.defaultPersonality(Pokedex._dex, sp));
      if (pic && pic.image) {
        PokedexChrome.drawSilhouette(pic.image, 40, 104 + (entry.pokemonOffset || 0),
          Pokedex.silhouetteScale(entry.pokemonScale), Pokedex.silhouetteScale(entry.pokemonScale), 32, 32);
      }

      // pokefirered/src/pokedex_screen.c:3114
      const trainerImg = PokedexChrome.getTrainerPic(Pokedex.playerGender());
      if (trainerImg) {
        PokedexChrome.drawSilhouette(trainerImg, 80, 104 + (entry.trainerOffset || 0),
          Pokedex.silhouetteScale(entry.trainerScale), Pokedex.silhouetteScale(entry.trainerScale), 32, 32);
      }
    }

    // 5. Right: AREA Title & Region Map
    // pokefirered/src/pokedex_screen.c:658
    const areaW = FrlgFont.measure(RomText.plain("gText_Area"), { small: true });
    FrlgFont.draw(RomText.plain("gText_Area"), 136 + Math.floor((96 - areaW) / 2), 52, { small: true, colors: upperColors });

    // pokefirered/src/pokedex_screen.c:678
    const mapX = 136, mapY = 64;
    PokedexChrome.drawMap("kanto", mapX, mapY);

    // pokefirered/src/pokedex_screen.c:3129
    let drawn = 0;
    for (const [, aKey] of ipairs<string>(PokedexData.getWildAreasForSpecies(sp))) {
      if (PokedexData.getAreaMapKey(aKey) === "kanto") {
        const m = PokedexData.getAreaMarker(aKey);
        if (m) {
          PokedexChrome.drawAreaMarker(m.shape, mapX + (m.x - 32), mapY + m.y);
          drawn = drawn + 1;
        }
      }
    }

    // pokefirered/src/pokedex_screen.c:3130
    if (drawn === 0) {
      // Area Unknown Wide Ellipse
      const ellipseImg = PokedexChrome.getImage("blit_wide_ellipse");
      if (ellipseImg) {
        G.setColor(1, 1, 1, 1);
        G.draw(ellipseImg, mapX + 4, mapY + 28);
      }
      const unkW = FrlgFont.measure(RomText.plain("gText_AreaUnknown"), { small: true });
      FrlgFont.draw(RomText.plain("gText_AreaUnknown"), mapX + Math.floor((96 - unkW) / 2), mapY + 29, {
        small: true,
        colors: upperColors,
      });
    }

    // 6. Bottom Bar Controls on Page 2
    PokedexChrome.drawControlInfoLeft(RomText.plain("gText_Cry"), 8, 146);
    PokedexChrome.drawControlInfo(RomText.plain("gText_CancelPreviousData"), 236, 146);
  }
}

/** 4. Habitat Category Screen (Pulsing Spotlight Disc & Mini Card) */
// Lua: pokedex.lua:1043
function draw_habitat_grid(): void {
  const dex = Pokedex._dex;

  // Solid warm beige background (#E8E0CE)
  G.setColor(232 / 255, 224 / 255, 206 / 255, 1);
  G.rectangle("fill", 0, 0, 240, 160);

  PokedexChrome.drawBars();

  const catKey = Pokedex.currentCategory;
  const title = category_title(catKey);
  const pages = PokedexData.getUnlockedCategoryPages(catKey, dex);
  const maxPages = Math.max(1, len(pages));
  Pokedex.categoryPage = Math.max(1, Math.min(Pokedex.categoryPage, maxPages));
  const curMons: LuaTable = (pages[Pokedex.categoryPage] && pages[Pokedex.categoryPage].mons) || {};
  let numMons = len(curMons);
  if (numMons === 0) numMons = 1;
  Pokedex.categorySlot = Math.max(1, Math.min(Pokedex.categorySlot, numMons));

  // Header Bar (y=2)
  PokedexChrome.drawHeader(title, 8, 2);
  PokedexChrome.drawHeader(page_label(Pokedex.categoryPage, maxPages), 176, 2);

  Pokedex.spotlightTimer = Pokedex.spotlightTimer + 0.05;

  const layout = CATEGORY_PAGE_COORDS[numMons] || CATEGORY_PAGE_COORDS[1]!;

  for (let slot = 1; slot <= numMons; slot++) {
    const sp = curMons[slot];
    const coords = layout[slot];
    if (sp && coords) {
      const isSelected = (slot === Pokedex.categorySlot);
      const seen = Dex.isSeen(dex, sp);
      const caught = Dex.isCaught(dex, sp);

      // Pulsing Spotlight Disc behind mon sprite (selected pulses, unselected stays idle)
      PokedexChrome.drawHabitatSpotlight(coords.circle.x, coords.circle.y, 32, Pokedex.spotlightTimer, isSelected);

      // Pokémon Front Sprite
      if (seen) {
        const pic = Pokemon.dexFrontPic(sp, Dex.defaultPersonality(Pokedex._dex, sp));
        if (pic && pic.image) {
          G.setColor(1, 1, 1, 1);
          G.draw(pic.image, coords.pic.x, coords.pic.y);
        }
      } else {
        FrlgFont.draw("?", coords.pic.x + 26, coords.pic.y + 24, { color: seq(0.4, 0.4, 0.4, 1) as number[] });
      }

      // Mini Page Card
      PokedexChrome.drawMiniCard(sp, coords.card.x, coords.card.y, caught, seen, isSelected);
    }
  }

  // Side Page Flip Arrows
  if (Pokedex.categoryPage < maxPages) {
    PokedexChrome.drawSideArrow("right", 222, 74);
  }
  if (Pokedex.categoryPage > 1) {
    PokedexChrome.drawSideArrow("left", 10, 74);
  }

  // src/pokedex_screen.c:2386
  PokedexChrome.drawControlInfo(RomText.plain("gText_PickFlipPageCheckCancel"), 236, 146);
}

export const Pokedex: any = {
  isMenu: true,

  open: false,
  screen: "mode_select",
  subScreenPrev: "mode_select",

  // Mode select state
  modeCursor: 1,
  modeScroll: 0,
  MODES: seq() as (ModeRow | null)[],

  // Habitat grid state
  currentCategory: "grassland",
  categoryPage: 1,
  categorySlot: 1,
  spotlightTimer: 0,

  // Ordered list state
  currentOrder: "numerical_kanto",
  listCursor: 1,
  listScroll: 0,

  selectedSpecies: 1,

  // Data screen state
  dataPage: 1, // 1: FR desc, 2: LG desc

  // Compatibility aliases
  cursor: 1,
  mode: "kanto",
  page: "list",

  // Session & Dex references
  _dex: undefined as any,
  _session: undefined as any,
  _onClose: undefined as (() => void) | undefined,
  _regSpecies: undefined as number | undefined,

  // Lua: pokedex.lua:156
  maxSpecies(): number {
    if (Pokedex.mode === "national" || Pokedex.currentOrder === "numerical_national") {
      return Dex.NATIONAL_MAX || 386;
    }
    return Dex.regionalMax(undefined);
  },

  // pokefirered/src/pokedex_screen.c:3113
  // Lua: pokedex.lua:164
  silhouetteScale(romScale: unknown): number {
    let s = tonumber(romScale) ?? 256;
    if (s <= 0) s = 256;
    return 256 / s;
  },

  // pokefirered/src/trainer_pokemon_sprites.c:276
  // Lua: pokedex.lua:171
  playerGender(): string {
    const s = Pokedex._session;
    const g = s && (s.gender ?? s.playerGender);
    if (g === "female" || g === 1) return "female";
    return "male";
  },

  // Lua: pokedex.lua:178
  show(dex?: any, opts?: any): void {
    opts = opts || {};
    Pokedex.open = true;
    Pokedex._dex = dex || (opts.session && opts.session.dex) || Dex.new();
    Pokedex._session = opts.session;
    Pokedex._onClose = opts.onClose;
    Pokedex._regSpecies = undefined;

    PokedexData.init();
    PokedexChrome.install();
    if (!Pokemon._names) Pokemon.install(undefined);

    Pokedex.MODES = build_modes(opts.session, Pokedex._dex);
    Pokedex.resetScreenState();

    if (opts.mode) {
      const m = String(opts.mode).replace(/[A-Z]+/g, (x) => x.toLowerCase()); // opts.mode:lower()
      if (m === "regional" || m === "kanto") {
        Pokedex.mode = "kanto";
        Pokedex.currentOrder = "numerical_kanto";
        Pokedex.screen = "ordered_list";
        Pokedex.page = "list";
      } else if (m === "national") {
        Pokedex.mode = "national";
        Pokedex.currentOrder = "numerical_national";
        Pokedex.screen = "ordered_list";
        Pokedex.page = "list";
      } else {
        Pokedex.mode = "kanto";
        Pokedex.screen = "mode_select";
        Pokedex.page = "list";
      }
    } else {
      Pokedex.mode = "kanto";
      Pokedex.screen = "mode_select";
      Pokedex.page = "list";
    }

    Stack.push("pokedex", Pokedex, { hideBelow: true, fullscreen: true });
    se("SE_PIN");
  },

  /** -> [category, pageIdx] or [] */
  // Lua: pokedex.lua:226
  categoryForSpecies(speciesId: unknown): [string?, number?] {
    const sp = tonumber(speciesId);
    if (sp == null) return [];
    PokedexData.init();
    for (const [, catKey] of ipairs<string>(HABITAT_CATEGORIES)) {
      for (const [pageIdx, page] of ipairs<LuaTable>(PokedexData.getCategoryPages(catKey))) {
        for (const [, member] of ipairs(page)) {
          if (member === sp) return [catKey, pageIdx];
        }
      }
    }
    return [];
  },

  // Lua: pokedex.lua:240
  showRegistration(speciesId: unknown, opts?: any): void {
    opts = opts || {};
    Pokedex.open = true;
    Pokedex._regSpecies = tonumber(speciesId) || 1;
    Pokedex.selectedSpecies = Pokedex._regSpecies;
    Pokedex._session = opts.session;
    Pokedex._dex = (opts.session && opts.session.dex) || Dex.new();
    Pokedex._onClose = opts.onDone || opts.onClose;

    PokedexData.init();
    PokedexChrome.install();
    if (!Pokemon._names) Pokemon.install(undefined);

    Pokedex.mode = "registration";
    Pokedex.page = "entry";
    Pokedex.screen = "registration";
    Pokedex.dataPage = 1;

    // pokefirered/src/pokedex_screen.c:3316
    const [catKey, pageIdx] = Pokedex.categoryForSpecies(Pokedex._regSpecies);
    if (catKey) {
      Pokedex.currentCategory = catKey;
      Pokedex.categoryPage = pageIdx || 1;
      Pokedex.subScreenPrev = "category_grid";
    } else {
      Pokedex.subScreenPrev = "mode_select";
    }

    Stack.push("pokedex", Pokedex, { hideBelow: true, fullscreen: true });
    play_cry(Pokedex._regSpecies);
  },

  // pokedex_screen.c
  // Lua: pokedex.lua:275
  resetScreenState(): void {
    Pokedex.screen = "mode_select";
    Pokedex.subScreenPrev = "mode_select";
    Pokedex.modeCursor = 2;
    Pokedex.modeScroll = 0;
    Pokedex.listCursor = 1;
    Pokedex.listScroll = 0;
    Pokedex.cursor = 1;
    Pokedex.mode = "kanto";
    Pokedex.page = "list";
    Pokedex.currentCategory = "grassland";
    Pokedex.categoryPage = 1;
    Pokedex.categorySlot = 1;
    Pokedex.spotlightTimer = 0;
    Pokedex.currentOrder = "numerical_kanto";
    Pokedex.selectedSpecies = 1;
    Pokedex.dataPage = 1;
    Pokedex._regSpecies = undefined;
  },

  // Lua: pokedex.lua:295
  update(_dt?: number): void {
    PokedexChrome._animTimer = (PokedexChrome._animTimer || 0) + 0.05;
  },

  // Lua: pokedex.lua:299
  close(): void {
    Pokedex.open = false;
    Stack.pop("pokedex");
    Pokedex.resetScreenState();
    const cb = Pokedex._onClose;
    Pokedex._onClose = undefined;
    if (cb) cb();
  },

  // Lua: pokedex.lua:308
  isOpen(): boolean {
    return Pokedex.open;
  },

  // Lua: pokedex.lua:643
  handleInput(input?: InputLike): void {
    if (!input) return;

    if (Pokedex.screen === "mode_select") {
      handle_mode_select_input(input);
    } else if (Pokedex.screen === "category_grid") {
      handle_category_grid_input(input);
    } else if (Pokedex.screen === "ordered_list") {
      handle_ordered_list_input(input);
    } else if (Pokedex.screen === "data") {
      handle_data_input(input);
    } else if (Pokedex.screen === "registration") {
      handle_registration_input(input);
    }
  },

  /** -> [cryHint, controlInfo] */
  // pokefirered/src/pokedex_screen.c:2960
  // Lua: pokedex.lua:852
  controlInfoForDataPage(screen: string): [string | undefined, string] {
    if (screen === "registration") {
      return [undefined, RomText.plain("gText_Next")];
    }
    return [RomText.plain("gText_Cry"), RomText.plain("gText_NextDataCancel")];
  },

  // Lua: pokedex.lua:1121
  draw(): void {
    if (!Pokedex.open) return;

    if (Pokedex.screen === "mode_select") {
      draw_mode_select();
    } else if (Pokedex.screen === "category_grid") {
      draw_habitat_grid();
    } else if (Pokedex.screen === "ordered_list") {
      draw_ordered_list();
    } else if (Pokedex.screen === "data" || Pokedex.screen === "registration") {
      draw_data_screen();
    }
  },
};

export default Pokedex;
