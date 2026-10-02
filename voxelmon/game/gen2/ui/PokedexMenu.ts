// gen1recomp src/ui/gen2/PokedexMenu.lua (bdfac727, MIT): Gen 2 #DEX,
// transcribed from engine/pokedex/pokedex.asm.
//
// The main screen is two layers, which is the thing to understand before any
// coordinate in here makes sense:
//
//   * The **background** holds the frontpic box, the SEEN/OWN box, the
//     vertical rule at column 8 and the bottom caption, and it is scrolled
//     left by POKEDEX_SCX (5 pixels).  So background tile column 0 lands at
//     screen x -5.
//   * The **window** holds the listing.  Pokedex_InitMainScreen sets hWX to
//     $47 (or $4a in OLD mode) and hWY to 0, so the window's own column 0 is
//     at screen x 64 (67 in OLD mode) and it covers the full height.  Twelve
//     of its columns fit on screen, which is exactly the 11-wide list plus
//     its scroll bar.
//
// The Lua painted both into one canvas with translate(); the Gold screen has
// the cart's own two maps, so here the background is drawn into the BG map
// with SCX = 5 and the listing into the window map at WX/WY -- the hardware's
// way, and the only one that keeps every cell on the grid (G.map, lcd.regs).
//
// Everything the screens draw comes out of one 64-tile sheet decompressed
// over vTiles2 tile $31, plus an *inverted* font: Pokedex_LoadInvertedFont
// flips both bitplanes of the standard font, so under PREDEFPAL_POKEDEX
// (white, orange, dark red, black) the dex prints white on black.  Here that
// is Chrome.printInverted, which draws the ordinary font page through the
// reversed palette; the inverted ' ' cell is a solid black tile no sheet
// carries, so PokedexMenu.blank paints it.
//
// Gold's dex sorts three ways -- NEW (Johto order), OLD (national, and the
// only mode that prints numbers) and A-Z.  SELECT opens the OPTION screen and
// START the SEARCH screen.

import { HallOfFame } from "../core/HallOfFame.ts";
import { Nests } from "../core/Nests.ts";
import { Unown } from "../core/Unown.ts";
import { FLAG_WIN_ON } from "../platform/lcd.ts";
import { tonumber, tostring } from "../platform/lua.ts";
import G, { currentLcd, type LcdImage, type Quad, cachedBlock, keyOf } from "../platform/screen.ts";
import { TypeChart } from "../shared/battle/TypeChart.ts";
import { Sound } from "../shared/core/Sound.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Sprites } from "../shared/pokemon/Sprites.ts";
import { Assets } from "../shared/render/Assets.ts";
import { GbcPalette } from "../shared/render/GbcPalette.ts";
import { MenuRepeat, type RepeatState } from "../shared/ui/MenuRepeat.ts";
import { Palettes } from "../world/Palettes.ts";
import { Chrome } from "./Chrome.ts";
import { TileSheet } from "./TileSheet.ts";

type Colors = readonly (readonly number[])[];

// Lua: PokedexMenu.lua:46 -- `db $3b, " OPTION ", $3c` / `db $3b, " SEARCH ", $3c`.
const OPTION_LABEL = Strings.source(" OPTION ");
const SEARCH_LABEL = Strings.source(" SEARCH ");
const MODE_LABELS: Record<string, string> = {
  NEW: Strings.source("NEW"),
  OLD: Strings.source("OLD"),
  "A-Z": Strings.source("A-Z"),
};
const SEEN_LABEL = Strings.source("SEEN");
const OWN_LABEL = Strings.source("OWN");
const HEIGHT_LABEL = Strings.source("HT");
const WEIGHT_LABEL = Strings.source("WT");
const SEARCH_TYPE1_LABEL = Strings.source("TYPE1");
const SEARCH_TYPE2_LABEL = Strings.source("TYPE2");
const BEGIN_SEARCH_LABEL = Strings.source("BEGIN SEARCH!!");
const CANCEL_LABEL = Strings.source("CANCEL");
const NO_SEARCH_RESULTS = Strings.source("No <PK><MN> found!");
const ENTRY_ACTION_LABEL = Strings.source(" PAGE AREA CRY PRNT");
const POUND_LABEL = Strings.source("lb");
const NEST_TITLE = Strings.source("%s'S NEST");

const LIST_DIRS = ["up", "down"];

// Lua: PokedexMenu.lua:75 -- wDexListingHeight is set to 7 by Pokedex_InitMainScreen.
const VISIBLE_ROWS = 7;
const MODES = ["NEW", "OLD", "A-Z"];

// Lua: PokedexMenu.lua:79 -- DexEntryScreen_ArrowCursorData, in its own order.
const ENTRY_ACTIONS = ["PAGE", "AREA", "CRY", "PRNT"];
// The four dwcoord columns the arrow parks in, row 17.
const ENTRY_ACTION_X = [1, 6, 11, 15];

// Lua: PokedexMenu.lua:85 -- engine/pokedex/pokedex.asm POKEDEX_SCX.
const SCX = 5;
// hWX values, less the hardware's 7-pixel bias.
const WINDOW_X: Record<string, number> = { NEW: 0x47 - 7, OLD: 0x4a - 7, "A-Z": 0x47 - 7 };

// Lua: PokedexMenu.lua:90 -- tile ids out of the dex sheet.
const TILE_BG = 0x32;
const TILE_BORDER = { // Pokedex_PlaceBorder
  topLeft: 0x33, top: 0x34, topRight: 0x35,
  left: 0x36, right: 0x37,
  bottomLeft: 0x38, bottom: 0x39, bottomRight: 0x3a,
};
const TILE_CAUGHT = 0x4f;
const TILE_FOOT = 0x5e;
const TILE_INCH = 0x5f;
const TILE_NO = [0x5c, 0x5d];
const TILE_DIVIDER = 0x61;
const TILE_PAGE_TOP = 0x55;
const TILE_PAGE_P = 0x56;
const TILE_PAGE_DIGIT = [0x57, 0x58];

// Lua: PokedexMenu.lua:106 -- String_SELECT_OPTION falls through into
// String_START_SEARCH with no terminator between them, so placing it at
// (1,17) writes all 18 tiles.
const BOTTOM_CAPTION = [
  0x3b, 0x48, 0x49, 0x4a, 0x44, 0x45, 0x46, 0x47,
  0x3c, 0x3b, 0x41, 0x42, 0x43, 0x4b, 0x4c, 0x4d, 0x4e, 0x3c,
];
// ...and the window gets its own copy of just the START > SEARCH half.
const WINDOW_CAPTION = [0x3c, 0x3b, 0x41, 0x42, 0x43, 0x4b, 0x4c, 0x4d, 0x4e, 0x3c];

interface CursorSprite {
  x: number;
  y: number;
  tile: number;
  xflip?: boolean;
  yflip?: boolean;
}

// Lua: PokedexMenu.lua:120 -- Pokedex_PutNewModeABCModeCursorOAM /
// Pokedex_PutOldModeCursorOAM.  dbsprite emits OAM coordinates, so screen
// space is (x - 8, y - 16); the cursor row adds 16 pixels per step.
function sprite(xTile: number, yTile: number, xPixel: number, yPixel: number, tile: number, xflip?: boolean, yflip?: boolean): CursorSprite {
  return {
    x: xTile * 8 + xPixel - 8,
    y: yTile * 8 + yPixel - 16,
    tile, xflip, yflip,
  };
}

// Lua: PokedexMenu.lua:128
const CURSOR_OAM = [
  sprite(9, 3, -1, 3, 0x30), sprite(9, 2, -1, 3, 0x31),
  sprite(10, 2, -1, 3, 0x32), sprite(11, 2, -1, 3, 0x32),
  sprite(12, 2, -1, 3, 0x33),
  sprite(16, 2, 0, 3, 0x33, true), sprite(17, 2, 0, 3, 0x32, true),
  sprite(18, 2, 0, 3, 0x32, true), sprite(19, 2, 0, 3, 0x31, true),
  sprite(19, 3, 0, 3, 0x30, true),
  sprite(9, 4, -1, 3, 0x30, false, true), sprite(9, 5, -1, 3, 0x31, false, true),
  sprite(10, 5, -1, 3, 0x32, false, true), sprite(11, 5, -1, 3, 0x32, false, true),
  sprite(12, 5, -1, 3, 0x33, false, true),
  sprite(16, 5, 0, 3, 0x33, true, true), sprite(17, 5, 0, 3, 0x32, true, true),
  sprite(18, 5, 0, 3, 0x32, true, true), sprite(19, 5, 0, 3, 0x31, true, true),
  sprite(19, 4, 0, 3, 0x30, true, true),
];

// Lua: PokedexMenu.lua:143
const CURSOR_OAM_OLD = [
  sprite(9, 3, -1, 0, 0x30), sprite(9, 2, -1, 0, 0x31),
  sprite(10, 2, -1, 0, 0x32), sprite(11, 2, -1, 0, 0x32),
  sprite(12, 2, -1, 0, 0x32), sprite(13, 2, -1, 0, 0x33),
  sprite(16, 2, -2, 0, 0x33, true), sprite(17, 2, -2, 0, 0x32, true),
  sprite(18, 2, -2, 0, 0x32, true), sprite(19, 2, -2, 0, 0x32, true),
  sprite(20, 2, -2, 0, 0x31, true), sprite(20, 3, -2, 0, 0x30, true),
  sprite(9, 4, -1, 0, 0x30, false, true), sprite(9, 5, -1, 0, 0x31, false, true),
  sprite(10, 5, -1, 0, 0x32, false, true), sprite(11, 5, -1, 0, 0x32, false, true),
  sprite(12, 5, -1, 0, 0x32, false, true), sprite(13, 5, -1, 0, 0x33, false, true),
  sprite(16, 5, -2, 0, 0x33, true, true), sprite(17, 5, -2, 0, 0x32, true, true),
  sprite(18, 5, -2, 0, 0x32, true, true), sprite(19, 5, -2, 0, 0x32, true, true),
  sprite(20, 5, -2, 0, 0x31, true, true), sprite(20, 4, -2, 0, 0x30, true, true),
];

// Lua: PokedexMenu.lua:158 -- Pokedex_PutScrollbarOAM: one OBJ, tile $0f,
// x 161, y from 20 to 141.
const SCROLLBAR_TILE = 0x0f;
const SCROLLBAR_X = 161 - 8;
const SCROLLBAR_TOP = 20 - 16;
const SCROLLBAR_TRAVEL = 121;

// Lua: PokedexMenu.lua:526 -- PadFrontpic centres the small pics in the 7x7 block.
const PIC_PAD: Record<number, [number, number]> = { 7: [0, 0], 6: [1, 1], 5: [1, 2] };

/** menu_gfx.json `pokedex` (the importer's shape). */
export interface PokedexGfx {
  tiles?: string;
  tilesWide?: number;
  firstTile?: number;
  objs?: string;
  objsWide?: number;
  palette?: Colors;
  cursorPalette?: Colors;
  questionMark?: string;
  questionMarkPalette?: Colors;
  footprints?: string;
  footprintOrder?: string[];
}

export interface DexRow {
  species: string;
  dex?: number;
  seen: boolean;
  caught: boolean;
}

export interface OptionMode {
  label: string;
  mode: string;
  unown?: boolean;
  lines: [string, string];
}

export interface PokedexMenuOpts {
  save?: any;
  pokedex?: any;
  pokemon?: any;
  palettes?: any;
  menuGfx?: any;
  font?: any;
  onClose?: () => void;
  entrySpecies?: string;
  newEntry?: boolean;
}

// Lua: PokedexMenu.lua:647 -- PrintNum: a right-aligned field of `digits`
// characters, space-padded unless PRINTNUM_LEADINGZEROS was set.  `before`
// splits the field into an integer part and a fraction with a '.' between.
function printNumString(value: number | undefined | null, digits: number, leadingZeros?: boolean, before?: number): string {
  let text = String(Math.max(0, Math.floor(value ?? 0))).padStart(digits, "0");
  if (!leadingZeros) {
    let kept = false;
    let out = "";
    for (let i = 1; i <= text.length; i++) {
      const ch = text[i - 1]!;
      // .PrintDigit stops suppressing once e runs out, which is the digit
      // immediately before the decimal point (and the units digit when there
      // is none), so those always print even as a zero.
      const forced = i === text.length || (before !== undefined && i >= before);
      if (ch !== "0" || kept || forced) {
        kept = true;
        out += ch;
      } else {
        out += " ";
      }
    }
    text = out;
  }
  if (before !== undefined) {
    return text.slice(0, before) + "." + text.slice(before);
  }
  return text;
}

/** Set the Gold screen's scroll / window registers for this frame. */
function regs(r: { scx?: number; wx?: number; wy?: number; window?: boolean }): void {
  const lcd = currentLcd();
  if (!lcd) return;
  lcd.regs({ scx: r.scx, wx: r.wx, wy: r.wy });
  if (r.window) lcd.regs({ flags: lcd.s.flags | FLAG_WIN_ON });
}

export class PokedexMenu {
  static isOpaque = true;
  static MODES = MODES;
  static printNumString = printNumString;

  // Lua: PokedexMenu.lua:1162 -- the SEARCH screen's type wheel: "-----" is
  // index 0 and the real types follow, in data/types/names.asm order.
  static SEARCH_TYPES = [
    "NORMAL", "FIGHTING", "FLYING", "POISON", "GROUND", "ROCK", "BUG", "GHOST",
    "STEEL", "FIRE", "WATER", "GRASS", "ELECTRIC", "PSYCHIC", "ICE", "DRAGON",
    "DARK",
  ];

  // Lua: PokedexMenu.lua:1172 -- .Modes, and the two-line description
  // Pokedex_DisplayModeDescription prints under each one.
  static OPTION_MODES: OptionMode[] = [
    { label: Strings.source("NEW POKéDEX MODE"), mode: "NEW",
      lines: [Strings.source("<PK><MN> are listed by"), Strings.source("evolution type.")] },
    { label: Strings.source("OLD POKéDEX MODE"), mode: "OLD",
      lines: [Strings.source("<PK><MN> are listed by"), Strings.source("official type.")] },
    { label: Strings.source("A to Z MODE"), mode: "A-Z",
      lines: [Strings.source("<PK><MN> are listed"), Strings.source("alphabetically.")] },
    { label: Strings.source("UNOWN MODE"), mode: "UNOWN", unown: true,
      lines: [Strings.source("UNOWN are listed"), Strings.source("in catching order.")] },
  ];

  // Lua: PokedexMenu.lua:1280 -- UnownModeLetterAndCursorCoords: the letter
  // cell and the cursor cell for each of the 26 SLOTS.
  static UNOWN_COORDS = [
    [4, 11, 3, 11], [4, 10, 3, 10], [4, 9, 3, 9], [4, 8, 3, 8],
    [4, 7, 3, 7], [4, 6, 3, 6], [4, 5, 3, 5], [4, 4, 3, 4],
    [4, 3, 3, 2], [5, 3, 5, 2], [6, 3, 6, 2], [7, 3, 7, 2],
    [8, 3, 8, 2], [9, 3, 9, 2], [10, 3, 10, 2], [11, 3, 11, 2],
    [12, 3, 12, 2], [13, 3, 13, 2], [14, 3, 15, 2], [14, 4, 15, 4],
    [14, 5, 15, 5], [14, 6, 15, 6], [14, 7, 15, 7], [14, 8, 15, 8],
    [14, 9, 15, 9], [14, 10, 15, 10],
  ];

  isOpaque = true;
  game: any;
  save: any;
  data: any;
  dex: any;
  pokemon: any;
  palettes: any;
  onClose: (() => void) | undefined;
  modeIndex = 1;
  index = 1;
  scroll = 0;
  hold!: RepeatState;
  /** list | entry | area | option | search | results | unown */
  view = "list";
  page = 1;
  entryAction = 1;
  picCache: Record<string, LcdImage | false> = {};
  optionIndex = 1;
  searchIndex = 1;
  unownIndex = 0;
  searchType: number[] = [1, 0];
  searchResults: DexRow[] | undefined;
  searchMessage: string | undefined;
  rows: DexRow[] = [];
  gfx: PokedexGfx | undefined;
  sheet: TileSheet | undefined;
  objs: TileSheet | undefined;
  dexPalette: Colors | undefined;
  mapGfx: any;
  mapSheet: TileSheet | undefined;
  unownFontBase: number | undefined;
  unownFont: TileSheet | undefined;
  newEntry = false;
  entryBlink = 0;
  areaBlink = 0;
  areaRegion: string | undefined;
  nestIcon: LcdImage | false | undefined;
  footprintQuad: Quad | undefined;

  // Lua: PokedexMenu.lua:164
  wantsFillScale(): boolean { return true; }
  // Lua: PokedexMenu.lua:165
  drawsWidescreen(): boolean { return true; }

  /**
   * Lua: PokedexMenu.lua:171 -- opts: save, pokedex, pokemon, palettes,
   * menuGfx, onClose(), entrySpecies (open straight on that species' ENTRY
   * screen, the way `predef NewPokedexEntry` does), newEntry (the two-page
   * NewPokedexEntry viewing, no action bar).
   */
  static new(game: any, opts?: PokedexMenuOpts): PokedexMenu {
    opts = opts ?? {};
    const self = new PokedexMenu();
    self.game = game;
    self.save = opts.save ?? (game ? game.save : undefined);
    const data = (game && game.data) || {};
    // engine/pokedex/pokedex.asm:447
    self.data = data;
    self.dex = opts.pokedex ?? data.gen2Pokedex;
    self.pokemon = opts.pokemon ?? data.pokemon;
    self.palettes = opts.palettes ?? data.gen2Palettes;
    self.onClose = opts.onClose;
    // InitPokedex: wLastDexMode -> wCurDexMode (engine/pokedex/pokedex.asm:97).
    self.modeIndex = 1;
    MODES.forEach((name, i) => {
      if (self.save && name === self.save.lastDexMode) self.modeIndex = i + 1;
    });
    self.index = 1;
    self.scroll = 0;
    // engine/pokedex/pokedex.asm:36-39
    self.hold = MenuRepeat.new(MenuRepeat.GEN2_DELAY, MenuRepeat.GEN2_RATE);
    self.view = "list";
    self.page = 1;
    self.entryAction = 1;
    self.picCache = {};
    self.optionIndex = 1;
    self.searchIndex = 1;
    self.unownIndex = 0;
    // wDexSearchMonType1 starts at NORMAL + 1 and TYPE2 at 0 ("-----").
    self.searchType = [1, 0];
    self.searchResults = undefined;

    const menuGfx = opts.menuGfx ?? data.gen2MenuGfx ?? {};
    const gfx: PokedexGfx | undefined = menuGfx.pokedex;
    self.gfx = gfx;
    if (gfx) {
      self.sheet = TileSheet.new({
        path: gfx.tiles, wide: gfx.tilesWide || 16,
        firstTile: gfx.firstTile || 0x31, palette: gfx.palette,
      });
      self.objs = TileSheet.new({
        path: gfx.objs, wide: gfx.objsWide || 16,
        firstTile: 0, palette: gfx.cursorPalette,
      });
      // Kept as the raw palette: the COLOR option substitutes palettes at
      // draw time.
      self.dexPalette = gfx.palette;
    }

    // pokegold engine/pokegear/pokegear.asm Pokedex_GetArea: the AREA page
    // draws through the Pokegear's own town-map tiles and TownMapPals.
    const mapGfx = menuGfx.pokegear;
    self.mapGfx = mapGfx;
    if (mapGfx) {
      self.mapSheet = TileSheet.new({
        path: mapGfx.tiles, wide: mapGfx.tilesWide || 16, firstTile: 0,
        paletteFor: (tile: number) => {
          if (!mapGfx.palettes) return undefined;
          if (tile >= 0x60) return mapGfx.palettes[0];
          const slot = (mapGfx.palMap && mapGfx.palMap[tile]) || 1;
          return mapGfx.palettes[slot - 1];
        },
      });
    }

    // Pokedex_LoadUnownFont: 27 tiles at vTiles2 tile FIRST_UNOWN_CHAR, drawn
    // through the dex palette REVERSED (the routine inverts the tiles on their
    // way into VRAM).
    const font = opts.font ?? data.font;
    if (font && font.imageUnown && gfx) {
      self.unownFontBase = font.unownBase || 0x40;
      self.unownFont = TileSheet.new({
        path: font.imageUnown, wide: font.unownWide || 3,
        firstTile: font.unownBase || 0x40,
        paletteFor: () => {
          const pal = self.dexPalette;
          if (!pal) return undefined;
          return [pal[3]!, pal[2]!, pal[1]!, pal[0]!];
        },
      });
    }
    self.rebuild();
    // NewPokedexEntry (engine/items/item_effects.asm:534-542): catching a mon
    // the player did not already own runs the dex straight into that
    // species' ENTRY screen rather than the listing.
    if (opts.entrySpecies) {
      for (let index = 1; index <= self.rows.length; index++) {
        if (self.rows[index - 1]!.species === opts.entrySpecies) {
          self.index = index;
          self.view = "entry";
          self.page = 1;
          self.ensureVisible();
          break;
        }
      }
      // _NewPokedexEntry's own tail: `ld a, [wCurPartySpecies] / call
      // PlayMonCry` (engine/pokedex/pokedex.asm:2554-2555).
      if (opts.newEntry && self.view === "entry") {
        self.newEntry = true;
        self.playCry(opts.entrySpecies);
      }
    }
    return self;
  }

  // Lua: PokedexMenu.lua:281
  mode(): string {
    return MODES[this.modeIndex - 1]!;
  }

  // Lua: PokedexMenu.lua:285
  styled(): boolean {
    return this.sheet !== undefined && this.sheet.available();
  }

  // Lua: PokedexMenu.lua:291 -- the species list in the current sort order.
  // OLD is the national (index) order.
  order(): string[] {
    const dex = this.dex;
    if (!dex) return [];
    const mode = this.mode();
    if (mode === "NEW" && dex.newOrder) return dex.newOrder;
    if (mode === "A-Z" && dex.alphabeticalOrder) return dex.alphabeticalOrder;
    const out: string[] = [];
    for (const species of Object.keys(dex.entries || {})) {
      const entry = dex.entries[species];
      out[(entry.dex ?? out.length + 1) - 1] = species;
    }
    return out;
  }

  // Lua: PokedexMenu.lua:304
  rebuild(): void {
    const seen = (this.save && this.save.pokedex && this.save.pokedex.seen) || {};
    const caught = (this.save && this.save.pokedex && this.save.pokedex.caught) || {};
    const rows: DexRow[] = [];
    for (const species of this.order()) {
      if (species === undefined) break; // ipairs stops at a hole
      const entry = this.dex && this.dex.entries && this.dex.entries[species];
      if (entry) {
        rows.push({
          species,
          dex: entry.dex,
          seen: seen[species] === true,
          caught: caught[species] === true,
        });
      }
    }
    this.rows = rows;
    this.index = Math.max(1, Math.min(this.index, Math.max(1, rows.length)));
    this.ensureVisible();
  }

  // Lua: PokedexMenu.lua:325
  ensureVisible(): void {
    if (this.index <= this.scroll) {
      this.scroll = this.index - 1;
    } else if (this.index > this.scroll + VISIBLE_ROWS) {
      this.scroll = this.index - VISIBLE_ROWS;
    }
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, this.rows.length - VISIBLE_ROWS)));
  }

  // Lua: PokedexMenu.lua:335
  current(): DexRow | undefined {
    return this.rows[this.index - 1];
  }

  // Lua: PokedexMenu.lua:339
  totals(): [number, number] {
    let seen = 0;
    let caught = 0;
    for (const entry of this.rows) {
      if (entry.seen) seen = seen + 1;
      if (entry.caught) caught = caught + 1;
    }
    return [seen, caught];
  }

  // Lua: PokedexMenu.lua:352 -- the entry bar's arrow flashes, on the same
  // 32-step period the AREA map's own blink uses.
  cursorVisible(): boolean {
    return ((this.entryBlink || 0) % 32) < 20;
  }

  // Lua: PokedexMenu.lua:358 -- Pokedex: wCurDexMode -> wLastDexMode on the
  // way out (engine/pokedex/pokedex.asm:60), which lives in the saved game data.
  close(): void {
    if (this.save) this.save.lastDexMode = MODES[this.modeIndex - 1];
    if (this.onClose) this.onClose();
  }

  // Lua: PokedexMenu.lua:363
  update(_dt?: number): void {
    this.entryBlink = (this.entryBlink || 0) + 1;
    const input = this.game ? this.game.input : undefined;
    if (!input) return;
    if (this.view === "entry") {
      // NewPokedexEntry is two WaitPressAorB_BlinkCursor pages and then out
      // (engine/pokedex/new_pokedex_entry.asm:19-23).
      if (this.newEntry) {
        if (input.wasPressed("a") || input.wasPressed("b")) {
          if (this.page === 1) {
            this.page = 2;
          } else {
            this.close();
          }
        }
        return;
      }
      // DexEntryScreen_ArrowCursorData: LEFT/RIGHT walk an arrow across four
      // actions at (1,17) (6,17) (11,17) (15,17), and A runs the one under it;
      // B backs out to the listing.
      if (input.wasPressed("right")) {
        this.entryAction = (this.entryAction % ENTRY_ACTIONS.length) + 1;
      } else if (input.wasPressed("left")) {
        this.entryAction = ((this.entryAction - 2 + ENTRY_ACTIONS.length) % ENTRY_ACTIONS.length) + 1;
      } else if (input.wasPressed("a")) {
        const action = ENTRY_ACTIONS[this.entryAction - 1];
        if (action === "PAGE") {
          this.page = this.page === 1 ? 2 : 1;
        } else if (action === "AREA") {
          this.view = "area";
          this.areaRegion = undefined;
        } else if (action === "CRY") {
          const row = this.current();
          this.playCry(row ? row.species : undefined);
        } else if (action === "PRNT") {
          this.printEntry();
        }
      } else if (input.wasPressed("b")) {
        this.view = "list";
      }
      return;
    }
    if (this.view === "area") return this.updateArea(input);
    if (this.view === "option") return this.updateOption(input);
    if (this.view === "search") return this.updateSearch(input);
    if (this.view === "unown") return this.updateUnown(input);
    const [dir, edge] = MenuRepeat.direction(this.hold, input, LIST_DIRS);
    if (input.wasPressed("b")) {
      this.close();
      return;
    } else if (input.wasPressed("select")) {
      // Pokedex_UpdateMainScreen: SELECT opens the OPTION screen and START the
      // SEARCH screen; neither cycles anything in place.
      this.view = "option";
      this.optionIndex = this.modeIndex;
      return;
    } else if (input.wasPressed("start")) {
      this.view = "search";
      this.searchIndex = 1;
      this.searchType = this.searchType ?? [1, 0];
      this.searchResults = undefined;
      return;
    } else if (dir === "up") {
      // pokedex.asm:982-1011
      if (this.index > 1) {
        this.index = this.index - 1;
      } else if (edge) {
        this.index = this.rows.length;
      }
      this.ensureVisible();
      return;
    } else if (dir === "down") {
      if (this.index < this.rows.length) {
        this.index = this.index + 1;
      } else if (edge) {
        this.index = 1;
      }
      this.ensureVisible();
      return;
    } else if (input.wasPressed("a")) {
      const row = this.current();
      // Pokedex_UpdateMainScreen's .a returns unless the mon has been seen.
      if (row && row.seen) {
        this.view = "entry";
        this.page = 1;
        // Pokedex_InitDexEntryScreen's tail cries the selected mon
        // (pokedex.asm:345-347); PAGE itself does not (:386-394).
        this.playCry(row.species);
      }
      return;
    }
  }

  // Lua: PokedexMenu.lua:459
  monName(species: string): string {
    const def = this.pokemon && this.pokemon[species];
    return (def && def.name) || species;
  }

  /** Cached Assets.image (the Lua's pcall'd load). */
  private load(path: string): LcdImage | undefined {
    let cached = this.picCache[path];
    if (cached === undefined) {
      try {
        cached = Assets.image(path) || false;
      } catch {
        cached = false;
      }
      this.picCache[path] = cached;
    }
    return cached || undefined;
  }

  // Lua: PokedexMenu.lua:464
  picFor(species: string): [LcdImage | undefined, boolean] {
    const def = this.pokemon && this.pokemon[species];
    let path: string | undefined = def ? def.spriteFront : undefined;
    // Pokedex_LoadSelectedMonTiles (engine/pokedex/pokedex.asm:2364) copies
    // wFirstUnownSeen into wUnownLetter before GetMonFrontpic, so the #DEX
    // shows the form the player FIRST met.
    let letter: number | undefined;
    if (species === Unown.SPECIES) {
      const first = (this.save && tonumber(this.save.firstUnownSeen)) || 0;
      if (first !== 0) {
        letter = first;
        path = Unown.formSprite(this.pokemon, first, false) || path;
      }
    }
    if (!path) return [undefined, false];
    const [key, trueColor] = Sprites.pic(path, {
      species,
      side: "front",
      kind: "dex",
      data: this.game && this.game.data,
      letter,
    } as any);
    if (!key) return [undefined, trueColor];
    return [this.load(key), trueColor];
  }

  // Lua: PokedexMenu.lua:498
  questionMark(): LcdImage | undefined {
    const path = this.gfx && this.gfx.questionMark;
    if (!path) return undefined;
    return this.load(path);
  }

  /**
   * Lua: PokedexMenu.lua:528 -- Pokedex_PlaceFrontpicTopLeftCorner lays a 7x7
   * block of tiles at (1,1) on every dex screen, filled with the mon's
   * frontpic if it has been seen, with LoadQuestionMarkPic's if not.  The
   * listing draws every mon through PokedexQuestionMarkPalette; the entry
   * screen (`ownColors`) uses the species' own two colours.
   */
  drawPic(row: DexRow | undefined, tx: number, ty: number, ownColors?: boolean): void {
    let image: LcdImage | undefined;
    let colors: Colors | undefined;
    let trueColor = false;
    if (row && row.seen) {
      [image, trueColor] = this.picFor(row.species);
      if (ownColors) {
        colors = this.palettes ? Palettes.monColors(this.palettes, row.species) : undefined;
      } else {
        colors = this.gfx && this.gfx.questionMarkPalette;
      }
    } else {
      image = this.questionMark();
      colors = this.gfx && this.gfx.questionMarkPalette;
    }
    if (!image) return;

    const blank = colors ? GbcPalette.color(colors, 1) : [255, 255, 255];
    G.setColor(blank[0]! / 255, blank[1]! / 255, blank[2]! / 255, 1);
    G.rectangle("fill", tx * 8, ty * 8, 7 * 8, 7 * 8);

    const tiles = Math.floor(image.getWidth() / 8);
    const pad = PIC_PAD[tiles] ?? PIC_PAD[7]!;
    G.setColor(1, 1, 1, 1);
    const body = (): void => {
      G.draw(image!, (tx + pad[0]) * 8, (ty + pad[1]) * 8);
    };
    if (colors && !(trueColor && GbcPalette.mode === "gbc") && GbcPalette.available()) {
      GbcPalette.with(colors, body);
    } else {
      body();
    }
  }

  // Lua: PokedexMenu.lua:564 -- Pokedex_DrawFootprint: $62..$65 at (18,1), a
  // 2x2 out of the footprint strip.
  drawFootprint(species: string, tx: number, ty: number): void {
    const path = this.gfx && this.gfx.footprints;
    const order = this.gfx && this.gfx.footprintOrder;
    if (!(path && order)) return;
    const at = order.indexOf(species);
    if (at < 0) return;
    const image = this.load(path);
    if (!image) return;
    let quad = this.footprintQuad;
    if (!quad) {
      const [w, h] = image.getDimensions();
      quad = G.newQuad(0, 0, 16, 16, w, h);
      this.footprintQuad = quad;
    }
    quad.setViewport(0, at * 16, 16, 16);
    G.setColor(1, 1, 1, 1);
    const body = (): void => G.draw(image, quad!, tx * 8, ty * 8);
    if (this.gfx!.palette && GbcPalette.available()) {
      GbcPalette.with(this.gfx!.palette, body);
    } else {
      body();
    }
  }

  // Lua: PokedexMenu.lua:595
  tile(id: number, tx: number, ty: number): void {
    if (this.sheet) this.sheet.draw(id, tx, ty);
  }

  // Lua: PokedexMenu.lua:599
  fill(id: number, tx: number, ty: number, wide: number, high: number): void {
    // the sheet's block fill: the same cells as tile() each, one lookup
    if (this.sheet) this.sheet.fill(id, tx, ty, wide, high);
  }

  // Lua: PokedexMenu.lua:607
  text(str: string, tx: number, ty: number): void {
    Chrome.printInverted(str, tx, ty, this.gfx && this.gfx.palette);
  }

  // Lua: PokedexMenu.lua:614 -- the inverted font's ' ' cell: a solid shade 3
  // (black under PREDEFPAL_POKEDEX); every ClearBox and box interior here is
  // made of it.
  blank(tx: number, ty: number, wide: number, high: number): void {
    const paper = this.dexPalette ? GbcPalette.color(this.dexPalette, 4) : [0, 0, 0];
    G.setColor(paper[0]! / 255, paper[1]! / 255, paper[2]! / 255, 1);
    G.rectangle("fill", tx * 8, ty * 8, wide * 8, high * 8);
    G.setColor(1, 1, 1, 1);
  }

  // Lua: PokedexMenu.lua:628 -- Pokedex_PlaceBorder: b interior rows by c
  // interior columns.
  border(tx: number, ty: number, interiorRows: number, interiorCols: number): void {
    const B = TILE_BORDER;
    this.tile(B.topLeft, tx, ty);
    for (let i = 1; i <= interiorCols; i++) this.tile(B.top, tx + i, ty);
    this.tile(B.topRight, tx + interiorCols + 1, ty);
    this.blank(tx + 1, ty + 1, interiorCols, interiorRows);
    for (let row = 1; row <= interiorRows; row++) {
      this.tile(B.left, tx, ty + row);
      this.tile(B.right, tx + interiorCols + 1, ty + row);
    }
    const bottom = ty + interiorRows + 1;
    this.tile(B.bottomLeft, tx, bottom);
    for (let i = 1; i <= interiorCols; i++) this.tile(B.bottom, tx + i, bottom);
    this.tile(B.bottomRight, tx + interiorCols + 1, bottom);
  }

  // -------------------------------------------------------------- main screen

  /**
   * Lua: PokedexMenu.lua:676 -- Pokedex_DrawMainScreenBG, drawn behind the
   * window and scrolled by SCX.  The Lua translated by -SCX; here the cells go
   * into the BG map and SCX scrolls it, as on the cart.
   */
  drawMainBackground(): void {
    // the same cells every frame until the totals, the entry shown or the
    // colours change: recorded once, replayed after (screen.ts cachedBlock)
    // (the entry's pic, last, is drawn outside it: the cursor moves it)
    const [seen, caught] = this.totals();
    const key = `bg:${seen},${caught}:${this.mode()}:${keyOf(this.dexPalette)}:${keyOf(this.sheet)}`
      + `:${GbcPalette.stateKey()}`;
    cachedBlock(this, key, () => this.drawMainBackgroundNow());
    G.push();
    G.map = 0;
    this.drawPic(this.current(), 1, 1);
    G.pop();
  }

  /** drawMainBackground's drawing. */
  private drawMainBackgroundNow(): void {
    G.push();
    G.map = 0;
    regs({ scx: SCX });

    // One column past the screen: SCX uncovers five pixels of column 20, which
    // the BG map holds the same background fill in.
    this.fill(TILE_BG, 0, 0, Chrome.SCREEN_W + 1, Chrome.SCREEN_H);
    this.border(0, 0, 7, 7);
    this.border(0, 9, 6, 7);

    const [seen, caught] = this.totals();
    this.text(Strings.get(SEEN_LABEL), 1, 11);
    this.text(printNumString(seen, 3), 5, 12);
    this.text(Strings.get(OWN_LABEL), 1, 14);
    this.text(printNumString(caught, 3), 5, 15);

    BOTTOM_CAPTION.forEach((id, i) => this.tile(id, i + 1, 17));

    // The rule between the two halves of the background and the window.
    this.tile(0x59, 8, 0);
    for (let y = 1; y <= 7; y++) this.tile(0x5a, 8, y);
    this.tile(0x53, 8, 8);
    this.tile(0x54, 8, 9);
    for (let y = 10; y <= 15; y++) this.tile(0x5a, 8, y);
    this.tile(0x5b, 8, 16);
    G.pop();
  }

  /**
   * Lua: PokedexMenu.lua:710 -- DrawPokedexListWindow + Pokedex_PrintListing,
   * on the window layer.  hWX puts the window's column 0 at screen x 64 (67
   * in OLD mode) and only twelve of its columns fit.
   */
  drawMainWindow(): void {
    // the list window is the same cells until it scrolls or the colours
    // change (screen.ts cachedBlock)
    const [seen, caught] = this.totals();
    const key = `win:${this.mode()}:${this.scroll}:${keyOf(this.rows)}:${this.rows.length}:${seen},${caught}`
      + `:${keyOf(this.sheet)}:${keyOf(this.gfx)}:${GbcPalette.stateKey()}`;
    cachedBlock(this, key, () => this.drawMainWindowNow());
  }

  /** drawMainWindow's drawing. */
  private drawMainWindowNow(): void {
    const old = this.mode() === "OLD";
    G.push();
    G.map = 1;
    regs({ wx: (WINDOW_X[this.mode()] ?? 64) + 7, wy: 0, window: true });

    // ClearBox(0, 1) 15 rows by 11 columns, then the top and bottom edges.
    this.blank(0, 1, 11, 15);
    for (let x = 0; x <= 10; x++) {
      this.tile(TILE_BORDER.top, x, 0);
      this.tile(TILE_BORDER.bottom, x, 16);
    }
    this.tile(0x3f, 5, 0);
    this.tile(0x40, 5, 16);

    // The scroll bar column, or its flat OLD-mode replacement.
    let top = 0x50;
    let mid = 0x51;
    let bottom = 0x52;
    if (old) {
      top = 0x66;
      mid = 0x67;
      bottom = 0x68;
    }
    this.tile(top, 11, 0);
    for (let y = 1; y <= 15; y++) this.tile(mid, 11, y);
    this.tile(bottom, 11, 16);

    this.fill(TILE_BG, 0, 17, 12, 1);
    WINDOW_CAPTION.forEach((id, i) => this.tile(id, i, 17));

    for (let row = 1; row <= VISIBLE_ROWS; row++) {
      const entry = this.rows[row + this.scroll - 1];
      if (entry) {
        const ty = row * 2;
        if (old) {
          this.text(printNumString(entry.dex ?? 0, 3, true), 0, ty - 1);
        }
        if (entry.seen) {
          if (entry.caught) this.tile(TILE_CAUGHT, 0, ty);
          this.text(this.monName(entry.species), 1, ty);
        } else {
          this.text("-----", 1, ty);
        }
      }
    }
    G.pop();
  }

  // Lua: PokedexMenu.lua:753
  drawCursorObjs(): void {
    // the cursor's objects and the scroll bar's thumb stand still until the
    // cursor moves -- the thumb rides the whole list, so the absolute index
    // and the list's length are in the key (screen.ts cachedBlock)
    const key = `cur:${this.mode()}:${this.index}:${this.scroll}:${this.rows.length}:${keyOf(this.objs)}`
      + `:${keyOf(this.gfx)}:${keyOf(this.palettes)}:${GbcPalette.stateKey()}`;
    cachedBlock(this, key, () => this.drawCursorObjsNow());
  }

  /** drawCursorObjs's drawing. */
  private drawCursorObjsNow(): void {
    const objs = this.objs;
    if (!(objs && objs.available())) {
      // Without the OBJ sheet, mark the row the way every other Gen 2 list does.
      const row = this.index - this.scroll;
      Chrome.cursor(Math.floor((WINDOW_X[this.mode()] ?? 64) / 8) - 1, row * 2);
      return;
    }
    const table = this.mode() === "OLD" ? CURSOR_OAM_OLD : CURSOR_OAM;
    // Pokedex_LoadCursorOAM adds (cursor & 7) * 16 to every y.
    const offset = ((this.index - this.scroll - 1) % 8) * 16;
    for (const obj of table) {
      const quad = objs.quad(obj.tile);
      const image = objs.image();
      if (quad && image) {
        G.setColor(1, 1, 1, 1);
        const sx = obj.xflip ? -1 : 1;
        const sy = obj.yflip ? -1 : 1;
        const ox = obj.xflip ? 8 : 0;
        const oy = obj.yflip ? 8 : 0;
        const body = (): void => {
          // OAM: an object even where it lands on the 8px grid.
          G.objects = true;
          G.draw(image, quad, obj.x + ox, obj.y + offset + oy, 0, sx, sy);
          G.objects = false;
        };
        if (this.gfx!.cursorPalette && GbcPalette.available()) {
          GbcPalette.with(this.gfx!.cursorPalette, body);
        } else {
          body();
        }
      }
    }

    // The scroll bar thumb rides the whole list, not the page.  Its OAM
    // attribute byte is 0, so it wears OBJ palette 0, which _CGB_Pokedex_Resume
    // left as InitPartyMenuOBPals' first entry.
    const total = Math.max(1, this.rows.length - 1);
    const travel = Math.floor((this.index - 1) * SCROLLBAR_TRAVEL / total);
    const quad = objs.quad(SCROLLBAR_TILE);
    if (quad && this.mode() !== "OLD") {
      G.setColor(1, 1, 1, 1);
      const pals = this.palettes && this.palettes.partyMenu;
      const colors = pals && pals[0];
      const body = (): void => {
        G.objects = true;
        G.draw(objs.image()!, quad, SCROLLBAR_X, SCROLLBAR_TOP + travel);
        G.objects = false;
      };
      if (colors && GbcPalette.available()) {
        GbcPalette.with(colors, body);
      } else {
        body();
      }
    }
  }

  // Lua: PokedexMenu.lua:805
  drawList(): void {
    this.drawMainBackground();
    this.drawMainWindow();
    this.drawCursorObjs();
  }

  // ------------------------------------------------------------- entry screen

  /**
   * Lua: PokedexMenu.lua:828 -- PRNT.  Pokedex_Print hands the entry to the
   * Game Boy Printer; Brian writes the page out as a PNG under prints/ in the
   * save folder instead.
   */
  printEntry(): void {
    // NOT FAITHFUL: the 3DS has no printer and no prints/ folder
    // (src/core/Printer.lua is desktop-only and inert here), so the call into
    // it and the "Printed X's data!" box are dropped and PRNT does nothing.
  }

  // Lua: PokedexMenu.lua:847 -- PlayMonCry, silent for a species with no
  // extracted cry rather than raising.
  playCry(species: string | undefined): void {
    if (!species) return;
    const cries = this.data && this.data.audio && this.data.audio.cries;
    if (cries && cries[species]) Sound.playCry(this.data, species);
  }

  // ---------------------------------------------------------------- AREA
  //
  // engine/pokegear/pokegear.asm:2285, :2322
  // Lua: PokedexMenu.lua:856
  areaRegionName(): string {
    return this.areaRegion || "johto";
  }

  // Lua: PokedexMenu.lua:864 -- the Pokegear's own tilemap blit: a flat list
  // of tile ids, row-major over the 20x18 screen.
  drawTilemap(cells: unknown): void {
    if (!Array.isArray(cells)) return;
    const sheet = this.mapSheet;
    if (!sheet) return;
    let i = 0;
    for (let ty = 0; ty <= Chrome.SCREEN_H - 1; ty++) {
      for (let tx = 0; tx <= Chrome.SCREEN_W - 1; tx++) {
        const id = cells[i];
        if (id != null) sheet.draw(id, tx, ty);
        i = i + 1;
      }
    }
  }

  // Lua: PokedexMenu.lua:878
  updateArea(input: any): void {
    this.areaBlink = (this.areaBlink || 0) + 1;
    if (input.wasPressed("b") || input.wasPressed("a")) {
      this.view = "entry";
      return;
    }
    if (input.wasPressed("left")) {
      this.areaRegion = "johto";
    } else if (input.wasPressed("right")) {
      // pokegear.asm:2373
      if (HallOfFame.hasEntered(this.game && this.game.save)) {
        this.areaRegion = "kanto";
      }
    }
  }

  // Lua: PokedexMenu.lua:895 -- engine/pokegear/pokegear.asm:2451
  nestIconColors(): Colors | undefined {
    const set = this.palettes ? Palettes.objectSet(this.palettes, "DAY") : undefined;
    return (set && set[0]) || (this.mapGfx && this.mapGfx.palettes && this.mapGfx.palettes[0]);
  }

  // Lua: PokedexMenu.lua:902 -- engine/pokegear/pokegear.asm:2298
  drawNestIcon(x: number, y: number): void {
    if (this.nestIcon === undefined) {
      this.nestIcon = false;
      const path = this.mapGfx && this.mapGfx.nestIcon;
      if (path) {
        try {
          const image = Assets.image(path);
          if (image) this.nestIcon = image;
        } catch {
          // pcall: no icon
        }
      }
    }
    G.setColor(1, 1, 1, 1);
    const icon = this.nestIcon;
    if (!icon) {
      const ink = this.nestIconColors();
      const dark = ink ? GbcPalette.color(ink, 4) : [0, 0, 0];
      G.setColor(dark[0]! / 255, dark[1]! / 255, dark[2]! / 255, 1);
      G.rectangle("fill", x + 1, y + 1, 6, 6);
      G.setColor(1, 1, 1, 1);
      return;
    }
    // The nest marks are OAM on the cart.
    const body = (): void => {
      G.objects = true;
      G.draw(icon, x, y);
      G.objects = false;
    };
    const colors = this.nestIconColors();
    if (colors && GbcPalette.available()) {
      GbcPalette.withRaw(colors, body);
    } else {
      body();
    }
  }

  // Lua: PokedexMenu.lua:931 -- engine/pokegear/pokegear.asm:2403
  drawAreaHeader(title: string): void {
    const pals = this.mapGfx && this.mapGfx.palettes;
    const pal: Colors | undefined = pals && pals[0];
    // engine/pokedex/pokedex.asm:2459
    const paper = pal ? GbcPalette.color(pal, 4) : [0, 0, 0];
    G.setColor(paper[0]! / 255, paper[1]! / 255, paper[2]! / 255, 1);
    G.rectangle("fill", 0, 0, Chrome.SCREEN_W * 8, 8);
    G.setColor(1, 1, 1, 1);
    const sheet = this.mapSheet;
    if (sheet) {
      sheet.draw(0x06, 0, 1);
      for (let x = 1; x <= Chrome.SCREEN_W - 2; x++) sheet.draw(0x07, x, 1);
      sheet.draw(0x17, Chrome.SCREEN_W - 1, 1);
    }
    Chrome.printThrough(title, 2, 0, pal, true, true);
  }

  // Lua: PokedexMenu.lua:949
  drawArea(): void {
    const row = this.current();
    if (!row) return;
    const region = this.areaRegionName();
    const save = this.game && this.game.save;
    const nests = Nests.find(this.data, row.species, region, save);

    const maps = this.mapGfx && this.mapGfx.maps;
    const cells = maps && maps[region];
    if (cells) {
      this.drawTilemap(cells);
    }

    this.drawAreaHeader(Strings.get(NEST_TITLE, this.monName(row.species)));

    // engine/pokegear/pokegear.asm:2385
    const on = ((this.areaBlink || 0) % 32) < 16;
    if (!on) return;
    for (const index of nests) {
      const mark = Nests.landmark(this.data, index);
      if (mark && mark.x != null && mark.y != null) {
        // engine/pokegear/pokegear.asm:2444
        this.drawNestIcon(mark.x - 4, mark.y - 4);
      }
    }
  }

  /**
   * Lua: PokedexMenu.lua:976 -- Pokedex_InitDexEntryScreen only pushes the
   * window off screen (hWX $a7); it never resets hSCX, so this screen
   * inherits the main screen's 5-pixel scroll.
   */
  drawEntry(): void {
    const row = this.current();
    if (!row) return;
    const entry = this.dex && this.dex.entries && this.dex.entries[row.species];
    if (!entry) return;

    G.push();
    G.map = 0;
    regs({ scx: SCX });
    try {
      this.drawEntryBody(row, entry);
    } finally {
      G.pop();
    }
  }

  // Lua: PokedexMenu.lua:990 -- Pokedex_DrawDexEntryScreenBG + DisplayDexEntry.
  drawEntryBody(row: DexRow, entry: any): void {
    // One column past the screen, because the scroll exposes it.
    this.fill(TILE_BG, 0, 0, Chrome.SCREEN_W + 1, Chrome.SCREEN_H);
    this.border(0, 0, 15, 18);
    // The right border column is then erased: (19,0) becomes the top edge,
    // rows 1-15 blank, and (19,16) the bottom edge.
    this.tile(TILE_BORDER.top, 19, 0);
    this.blank(19, 1, 1, 15);
    this.tile(TILE_BORDER.bottom, 19, 16);

    for (let x = 1; x <= 19; x++) this.tile(TILE_DIVIDER, x, 10);
    // Pokedex_DrawDexEntryScreenBG blanks 18 columns, _NewPokedexEntry's own
    // ByteFill 19 (pokedex.asm:1155-1157, :2540-2545).
    this.blank(1, 17, this.newEntry ? 19 : 18, 1);
    this.tile(0x3b, 0, 17);
    // _NewPokedexEntry ByteFills the action row away (pokedex.asm:2540-2545).
    if (!this.newEntry) {
      this.text(Strings.get(ENTRY_ACTION_LABEL), 1, 17);
      // Pokedex_InitArrowCursor parks an arrow on the selected action, at the
      // arrow's own dwcoord column, drawn white on the dark bar and blinking.
      if (this.cursorVisible()) {
        Chrome.cursorThrough(ENTRY_ACTION_X[(this.entryAction || 1) - 1] ?? 1, 17,
          this.gfx && this.gfx.palette, true);
      }
    }

    this.drawPic(row, 1, 1, true);
    this.drawFootprint(row.species, 18, 1);

    this.text(this.monName(row.species), 9, 3);
    this.text(entry.kind || "", 9, 5);
    this.tile(TILE_NO[0]!, 2, 8);
    this.tile(TILE_NO[1]!, 3, 8);
    this.text(printNumString(entry.dex ?? 0, 3, true), 4, 8);

    // .Height / .Weight are placeholder strings until the mon is caught:
    // "HT  ?'??"" at (9,7) and "WT   ???lb" at (9,9).
    this.text(Strings.get(HEIGHT_LABEL), 9, 7);
    this.text(Strings.get(WEIGHT_LABEL), 9, 9);
    this.tile(TILE_FOOT, 14, 7);
    this.text(Strings.get(POUND_LABEL), 17, 9);

    if (!row.caught) {
      this.text("  ?", 11, 7);
      this.text("??", 15, 7);
      this.tile(TILE_INCH, 17, 7);
      this.text("  ???", 11, 9);
      return;
    }

    // The height word is four digits with two in front of the point and the
    // point replaced by the foot mark; the weight word is five with four in
    // front.
    const height = printNumString(entry.height ?? 0, 4, false, 2);
    this.text(height.slice(0, 2), 12, 7);
    this.text(height.slice(3), 15, 7);
    this.tile(TILE_INCH, 17, 7);
    this.text(printNumString(entry.weight ?? 0, 5, false, 4), 11, 9);

    // Page marker, then the description.  ClearBox(2,11) is 5 rows by 18
    // columns and <NEXT> steps two rows, so the three lines land on 11/13/15.
    this.tile(TILE_PAGE_TOP, 1, 9);
    this.tile(TILE_PAGE_TOP, 2, 9);
    this.tile(TILE_PAGE_P, 1, 10);
    this.tile(TILE_PAGE_DIGIT[this.page - 1] ?? TILE_PAGE_DIGIT[0]!, 2, 10);

    const text = this.page === 2 ? entry.text2 : entry.text;
    let ty = 11;
    for (const part of tostring(text ?? "").split("<NEXT>")) {
      if (ty > 15) break;
      this.text(part, 2, ty);
      ty = ty + 2;
    }
  }

  // ---------------------------------------------------------------- fallbacks

  // Lua: PokedexMenu.lua:1085 -- a cache from before the dex sheet was
  // extracted has no `pokedex` table: the plain boxes this screen used before.
  drawPlain(): void {
    Chrome.clear();
    if (this.view === "unown") {
      Chrome.box(2, 1, 15, 13);
      const list = this.unownDex();
      const slot = Math.min(this.unownIndex || 0, Math.max(0, list.length - 1));
      list.forEach((value, i) => {
        const coords = PokedexMenu.UNOWN_COORDS[i];
        if (coords) {
          Chrome.print(Unown.name(value) || "?", coords[0]!, coords[1]!);
          if (i === slot) Chrome.cursor(coords[2]!, coords[3]!);
        }
      });
      const letter = list[slot];
      if (letter != null) {
        this.drawUnownPic(letter, 6, 5);
        Chrome.print(Unown.word(letter) || "", 4, 15);
      }
      return;
    }
    if (this.view === "entry") {
      const row = this.current();
      const entry = row && this.dex && this.dex.entries && this.dex.entries[row.species];
      Chrome.box(0, 0, 20, 10);
      if (row && entry) {
        Chrome.print(`${Chrome.number(entry.dex ?? 0, 3, true)}  ${this.monName(row.species)}`, 1, 1);
        Chrome.print(entry.kind || "", 1, 3);
        Chrome.print(Strings.get(HEIGHT_LABEL) + " " + printNumString(entry.height ?? 0, 4, false, 2), 1, 5);
        Chrome.print(Strings.get(WEIGHT_LABEL) + " " + printNumString(entry.weight ?? 0, 5, false, 4), 1, 7);
        this.drawPic(row, 12, 1, true);
        Chrome.box(0, 10, 20, 8);
        let ty = 11;
        for (const part of String(entry.text || "").split("<NEXT>")) {
          if (ty > 16) break;
          Chrome.print(part, 1, ty);
          ty = ty + 1;
        }
      }
      return;
    }
    Chrome.box(0, 0, 13, 18);
    for (let row = 1; row <= VISIBLE_ROWS; row++) {
      const i = row + this.scroll;
      const entry = this.rows[i - 1];
      if (entry) {
        const ty = 1 + (row - 1) * 2;
        if (i === this.index) Chrome.cursor(0, ty);
        Chrome.print(Chrome.number(entry.dex ?? 0, 3, true), 1, ty);
        Chrome.print(entry.seen ? this.monName(entry.species) : "-----", 5, ty);
      }
    }
    Chrome.box(13, 0, 7, 11);
    this.drawPic(this.current(), 13, 1);
    Chrome.box(13, 11, 7, 7);
    const [seen, caught] = this.totals();
    Chrome.print(Strings.get(MODE_LABELS[this.mode()] ?? this.mode()), 14, 12);
    Chrome.print(Strings.get(SEEN_LABEL), 14, 14);
    Chrome.printRight(String(seen), 19, 15);
    Chrome.print(Strings.get(OWN_LABEL), 14, 16);
    Chrome.printRight(String(caught), 19, 17);
  }

  // ---------------------------------------------------------- OPTION / SEARCH

  // Lua: PokedexMenu.lua:1193 -- Pokedex_CheckUnlockedUnownMode: `bit
  // STATUSFLAGS_UNOWN_DEX_F`, which is ENGINE_UNOWN_DEX -- the flag the Ruins
  // of Alph researcher sets, NOT "an Unown has been caught".
  unownUnlocked(): boolean {
    const flags = (this.save && this.save.engineFlags) || {};
    return flags[Unown.ENGINE_UNOWN_DEX] === true;
  }

  // Lua: PokedexMenu.lua:1198
  optionRows(): OptionMode[] {
    const rows: OptionMode[] = [];
    for (const entry of PokedexMenu.OPTION_MODES) {
      if (!entry.unown || this.unownUnlocked()) rows.push(entry);
    }
    return rows;
  }

  // Lua: PokedexMenu.lua:1206
  updateOption(input: any): void {
    const rows = this.optionRows();
    if (input.wasPressed("up")) {
      this.optionIndex = this.optionIndex > 1 ? this.optionIndex - 1 : rows.length;
    } else if (input.wasPressed("down")) {
      this.optionIndex = this.optionIndex < rows.length ? this.optionIndex + 1 : 1;
    } else if (input.wasPressed("b") || input.wasPressed("select")) {
      // .return_to_main_screen: SELECT and B both back out without changing
      // anything.
      this.view = "list";
    } else if (input.wasPressed("a")) {
      const row = rows[this.optionIndex - 1];
      if (row && row.unown) {
        // .MenuAction_UnownMode is the one option row that does NOT go back to
        // the listing: it sets DEXSTATE_UNOWN_MODE, its own screen.
        this.view = "unown";
        this.unownIndex = 0;
        return;
      }
      this.view = "list";
      if (row) {
        MODES.forEach((name, i) => {
          if (name === row.mode) {
            // .ChangeMode resets the listing to the top when the mode actually
            // changes, and does nothing at all when it does not.
            if (i + 1 !== this.modeIndex) {
              this.modeIndex = i + 1;
              this.index = 1;
              this.scroll = 0;
              this.rebuild();
            }
          }
        });
      }
    }
  }

  // ------------------------------------------------------------ UNOWN MODE
  //
  // Pokedex_InitUnownMode / Pokedex_UpdateUnownMode plus PrintUnownWord
  // (engine/pokedex/unown_dex.asm).  The screen is the FORM list: wUnownDex
  // holds the letters in the order they were first caught, and
  // wDexCurUnownIndex walks it with LEFT and RIGHT only.

  // Lua: PokedexMenu.lua:1255
  unownDex(): number[] {
    return Unown.dex(this.save);
  }

  // Lua: PokedexMenu.lua:1259
  updateUnown(input: any): void {
    const list = this.unownDex();
    if (input.wasPressed("a") || input.wasPressed("b")) {
      // .a_b returns to DEXSTATE_OPTION_SCR, not to the listing.
      this.view = "option";
      return;
    }
    if (input.wasPressed("right")) {
      // `.right`: `inc a / cp e / ret nc` -- the last slot cannot advance, and
      // there is no wrap.
      if (this.unownIndex + 1 < list.length) {
        this.unownIndex = this.unownIndex + 1;
      }
    } else if (input.wasPressed("left")) {
      if (this.unownIndex > 0) this.unownIndex = this.unownIndex - 1;
    }
  }

  // Lua: PokedexMenu.lua:1293 -- Pokedex_DrawUnownModeBG: a 10x13 box at
  // (2,1), a 1x13 box at (2,14), the two arrow tiles, the frontpic at (6,5)
  // and the word at (4,15).
  drawUnown(): void {
    const list = this.unownDex();
    this.fill(TILE_BG, 0, 0, Chrome.SCREEN_W, Chrome.SCREEN_H);
    this.border(2, 1, 10, 13);
    this.border(2, 14, 1, 13);
    this.tile(0x3d, 2, 15);
    this.tile(0x3e, 16, 15);

    const slot = Math.min(this.unownIndex || 0, Math.max(0, list.length - 1));
    const letter = list[slot];
    if (letter != null) {
      // Pokedex_LoadUnownFrontpicTiles: the pic is the FORM's.
      this.drawUnownPic(letter, 6, 5);
      this.unownText(Unown.word(letter) || "", 4, 15);
    }
    list.forEach((value, i) => {
      const coords = PokedexMenu.UNOWN_COORDS[i];
      if (coords) {
        this.unownText(Unown.name(value) || "?", coords[0]!, coords[1]!);
        if (i === slot) {
          this.unownCursor(coords[2]!, coords[3]!);
        }
      }
    });
  }

  // Lua: PokedexMenu.lua:1334 -- one letter of the Unown font: 'A' is tile
  // FIRST_UNOWN_CHAR.  Anything that is not a letter goes through the
  // ordinary font instead.
  unownGlyph(char: string, tx: number, ty: number): boolean {
    const sheet = this.unownFont;
    if (!(sheet && sheet.available())) return false;
    const index = Unown.index(char);
    if (index === undefined) return false;
    return sheet.draw((this.unownFontBase || 0x40) + index - 1, tx, ty);
  }

  // Lua: PokedexMenu.lua:1342
  unownText(str: string, tx: number, ty: number): void {
    const text = tostring(str ?? "");
    for (let i = 1; i <= text.length; i++) {
      const char = text[i - 1]!;
      if (!this.unownGlyph(char, tx + i - 1, ty)) {
        this.text(char, tx + i - 1, ty);
      }
    }
  }

  // Lua: PokedexMenu.lua:1355 -- FIRST_UNOWN_CHAR + NUM_UNOWN, the diamond the
  // ring is pointed at with.  Without the sheet the shared cursor glyph stands in.
  unownCursor(tx: number, ty: number): void {
    const sheet = this.unownFont;
    if (sheet && sheet.available()
      && sheet.draw((this.unownFontBase || 0x40) + Unown.NUM_UNOWN, tx, ty)) {
      return;
    }
    this.text("▶", tx, ty);
  }

  // Lua: PokedexMenu.lua:1364
  drawUnownPic(letter: number, tx: number, ty: number): void {
    const form = Unown.formSprite(this.pokemon, letter, false);
    if (!form) return;
    const [path, trueColor] = Sprites.pic(form, {
      species: Unown.SPECIES,
      side: "front",
      kind: "dex",
      data: this.game && this.game.data,
      letter,
    } as any);
    if (!path) return;
    const cached = this.load(path);
    if (!cached) return;
    const colors = this.palettes ? Palettes.monColors(this.palettes, Unown.SPECIES) : undefined;
    G.setColor(1, 1, 1, 1);
    const body = (): void => G.draw(cached, tx * 8, ty * 8);
    if (colors && !(trueColor && GbcPalette.mode === "gbc") && GbcPalette.available()) {
      GbcPalette.with(colors, body);
    } else {
      body();
    }
  }

  // Lua: PokedexMenu.lua:1397 -- Pokedex_UpdateSearchScreen: four rows, and
  // left/right walk the type wheel on the two that carry one.
  updateSearch(input: any): void {
    const row = this.searchIndex;
    const count = PokedexMenu.SEARCH_TYPES.length;
    if (input.wasPressed("up")) {
      this.searchIndex = row > 1 ? row - 1 : 4;
    } else if (input.wasPressed("down")) {
      this.searchIndex = row < 4 ? row + 1 : 1;
    } else if (row <= 2 && (input.wasPressed("left") || input.wasPressed("right"))) {
      const delta = input.wasPressed("right") ? 1 : -1;
      this.searchType[row - 1] = (this.searchType[row - 1]! + delta + count + 1) % (count + 1);
    } else if (input.wasPressed("b") || input.wasPressed("start")) {
      this.view = "list";
    } else if (input.wasPressed("a")) {
      if (row <= 2) {
        // .MenuAction_MonSearchType: A steps the wheel too.
        this.searchType[row - 1] = (this.searchType[row - 1]! + 1) % (count + 1);
      } else if (row === 3) {
        this.beginSearch();
      } else {
        this.view = "list";
      }
    }
  }

  // Lua: PokedexMenu.lua:1422
  searchTypeName(slot: number): string {
    const index = this.searchType[slot - 1] || 0;
    if (index === 0) return "-----";
    const id = PokedexMenu.SEARCH_TYPES[index - 1];
    return id ? TypeChart.displayName(id, this.data) : "-----";
  }

  // Lua: PokedexMenu.lua:1432 -- search compares internal type ids, never
  // their translated display names.
  searchTypeId(slot: number): string | undefined {
    const index = this.searchType[slot - 1] || 0;
    return index !== 0 ? PokedexMenu.SEARCH_TYPES[index - 1] : undefined;
  }

  // Lua: PokedexMenu.lua:1440 -- Pokedex_SearchForMons: a mon matches when its
  // two types cover both of the wanted ones, in either order; "-----" matches
  // anything.  Only SEEN mon are searched.
  beginSearch(): void {
    const want1 = this.searchTypeId(1);
    const want2 = this.searchTypeId(2);
    const results: DexRow[] = [];
    for (const entry of this.rows) {
      if (entry.seen) {
        const def = this.pokemon && this.pokemon[entry.species];
        const types: string[] = (def && def.types) || [];
        const a = types[0];
        const b = types[1] ?? types[0];
        let ok = true;
        if (want1) ok = ok && (a === want1 || b === want1);
        if (want2) ok = ok && (a === want2 || b === want2);
        if (ok) results.push(entry);
      }
    }
    this.searchResults = results;
    if (results.length === 0) {
      // .MenuAction_BeginSearch redraws the search screen and stays put when
      // nothing matched.
      this.searchMessage = NO_SEARCH_RESULTS;
      return;
    }
    this.searchMessage = undefined;
    this.rows = results;
    this.index = 1;
    this.scroll = 0;
    this.ensureVisible();
    this.view = "list";
  }

  // Lua: PokedexMenu.lua:1471 -- Pokedex_DrawOptionScreenBG: two bordered
  // boxes, the title on the top rule, the mode list from (3,4) two rows apart
  // and the description at (1,14).
  drawOption(): void {
    this.fill(TILE_BG, 0, 0, Chrome.SCREEN_W, Chrome.SCREEN_H);
    this.border(0, 2, 8, 18);
    this.border(0, 12, 4, 18);
    // `db $3b, " OPTION ", $3c`: the two end-cap tiles are the dex sheet's.
    this.tile(0x3b, 0, 1);
    this.text(Strings.get(OPTION_LABEL), 1, 1);
    this.tile(0x3c, 9, 1);
    const rows = this.optionRows();
    rows.forEach((row, i) => {
      this.text(Strings.get(row.label), 3, 4 + i * 2);
      if (i + 1 === this.optionIndex) this.text("▶", 2, 4 + i * 2);
    });
    const current = rows[this.optionIndex - 1];
    if (current) {
      this.text(Strings.get(current.lines[0]), 1, 14);
      this.text(Strings.get(current.lines[1]), 1, 15);
    }
  }

  // Lua: PokedexMenu.lua:1494 -- Pokedex_DrawSearchScreenBG: one tall box,
  // TYPE1/TYPE2 at (3,4) and (3,6) with their arrows at columns 8 and 17,
  // and the two-row menu at (3,13).
  drawSearch(): void {
    this.fill(TILE_BG, 0, 0, Chrome.SCREEN_W, Chrome.SCREEN_H);
    this.border(0, 2, 14, 18);
    this.tile(0x3b, 0, 1);
    this.text(Strings.get(SEARCH_LABEL), 1, 1);
    this.tile(0x3c, 9, 1);
    this.text(Strings.get(SEARCH_TYPE1_LABEL), 3, 4);
    this.text(Strings.get(SEARCH_TYPE2_LABEL), 3, 6);
    this.text(this.searchTypeName(1), 10, 4);
    this.text(this.searchTypeName(2), 10, 6);
    // `.TypeLeftRightArrows: db $3d, "        ", $3e`
    for (const y of [4, 6]) {
      this.tile(0x3d, 8, y);
      this.tile(0x3e, 17, y);
    }
    this.text(Strings.get(BEGIN_SEARCH_LABEL), 3, 13);
    this.text(Strings.get(CANCEL_LABEL), 3, 15);
    if (this.searchMessage) this.text(Strings.get(this.searchMessage), 3, 10);
    const rows = [4, 6, 13, 15];
    const y = rows[this.searchIndex - 1] ?? 4;
    this.text("▶", 2, y);
  }

  // Lua: PokedexMenu.lua:1518
  drawPanel(): void {
    if (!this.styled()) {
      this.drawPlain();
      G.setColor(1, 1, 1, 1);
      return;
    }
    // Every dex screen starts from a full-screen fill, so the frame under it
    // is the sheet's own background rather than the white a text box wants.
    G.setColor(0, 0, 0, 1);
    G.rectangle("fill", 0, 0, Chrome.SCREEN_W * 8, Chrome.SCREEN_H * 8);
    if (this.view === "entry") {
      this.drawEntry();
    } else if (this.view === "area") {
      this.drawArea();
    } else if (this.view === "option") {
      this.drawOption();
    } else if (this.view === "search") {
      this.drawSearch();
    } else if (this.view === "unown") {
      this.drawUnown();
    } else {
      this.drawList();
    }
    G.setColor(1, 1, 1, 1);
  }

  // Lua: PokedexMenu.lua:1545
  draw(): void {
    this.drawPanel();
  }

  // Lua: PokedexMenu.lua:1549 -- the Gold screen is the panel: no letterbox or fit.
  drawWidescreen(_winW?: number, _winH?: number): void {
    G.push();
    this.drawPanel();
    G.pop();
  }
}

export default PokedexMenu;
