// The menu screens extractMenuGfx hands off to: the Unown puzzle, #DEX,
// Bill's PC, POKeGEAR and trainer card sheets. Port of gen1recomp
// RomExtractorGen2.lua:6383-6867 (bdfac727): ENLARGED_NIBBLE / orByte /
// unownPuzzlePicture / unownPuzzleGfx, pokedexGfx, billsPcGfx,
// readTilemapRLE, readFlatTilemap, pokegearGfx, trainerCardGfx.
//
// Crystal's gender splits (MalePokegearPals/FemalePokegearPals,
// ChrisCardPic/KrisCardPic + TrainerCardGFX) are read where Brian reads
// them; Gold's single-label paths are unchanged.
//
// Palettes are carried as [r, g, b] 0-255 triples (Brian's self:colors /
// predefPal); every sheet is a shade image (0..3, 0xff transparent).

import type { Gen2Ctx } from "./ctx.ts";
import { columnsToRows, predefPal, save, write2bpp, writeCompressedPic } from "./helpers.ts";
import { type Rgb, colors } from "./palettes.ts";
import { decode1bpp } from "../gfx.ts";

// ------------------------------------------------------------ Unown puzzle

/** RomExtractorGen2.lua:6398 ENLARGED_NIBBLE — .EnlargedTiles: each nibble
 * bit becomes two bits ($f -> $ff, $8 -> $c0). Index 0..15. */
export const ENLARGED_NIBBLE: readonly number[] = Array.from(
  { length: 16 },
  (_, value) =>
    (value & 1) * 0x03 + ((value >> 1) & 1) * 0x0c + ((value >> 2) & 1) * 0x30 + ((value >> 3) & 1) * 0xc0,
);

/** RomExtractorGen2.lua:6406 orByte — bitwise OR of two bytes. */
export function orByte(a: number, b: number): number {
  return (a | b) & 0xff;
}

/** :6419 PUZZLE_BORDER_TILES — UnownPuzzle_AddPuzzlePieceBorders' eight
 * destination tiles (every tile of a 3x3 piece but its centre $0d). */
export const PUZZLE_BORDER_TILES = [0x00, 0x01, 0x02, 0x0c, 0x0e, 0x18, 0x19, 0x1a];

/**
 * The enlarge half of RomExtractorGen2.lua:6421 unownPuzzlePicture
 * (ConvertLoadedPuzzlePieces .EnlargePuzzlePieceTiles): 36 small tiles
 * (6x6, 48x48) to 144 row-major tiles of a 12x12 sheet (96x96), a plain 2x
 * nearest-neighbour scale. Missing source bytes read as 0.
 */
export function enlargePuzzlePieces(small: number[]): number[] {
  const out: number[] = [];
  for (let row = 0; row < 6; row++) {
    for (let half = 0; half < 2; half++) {
      for (let col = 0; col < 6; col++) {
        const base = (row * 6 + col) * 16 + half * 8;
        for (let nibble = 0; nibble < 2; nibble++) {
          for (let line = 0; line < 4; line++) {
            let low = small[base + line * 2] ?? 0;
            let high = small[base + line * 2 + 1] ?? 0;
            if (nibble === 0) {
              low >>= 4;
              high >>= 4;
            } else {
              low &= 15;
              high &= 15;
            }
            low = ENLARGED_NIBBLE[low & 15]!;
            high = ENLARGED_NIBBLE[high & 15]!;
            out.push(low, high, low, high);
          }
        }
      }
    }
  }
  return out;
}

/** The border half of :6447-6459 — ORs the eight 2bpp border tiles over
 * every piece of the enlarged sheet, in place. */
export function addPuzzlePieceBorders(out: number[], raw: number[]): number[] {
  PUZZLE_BORDER_TILES.forEach((target, index) => {
    for (let pieceRow = 0; pieceRow < 4; pieceRow++) {
      for (let pieceCol = 0; pieceCol < 4; pieceCol++) {
        const tile = target + pieceCol * 3 + pieceRow * 36;
        for (let byte = 0; byte < 16; byte++) {
          const at = tile * 16 + byte;
          out[at] = orByte(out[at] ?? 0, raw[index * 16 + byte] ?? 0);
        }
      }
    }
  });
  return out;
}

/** RomExtractorGen2.lua:6421 unownPuzzlePicture. Returns the gfx key. */
export function unownPuzzlePicture(ctx: Gen2Ctx, label: string, relative: string): string {
  const out = enlargePuzzlePieces(ctx.decompressLz3Symbol(label));
  const borders = ctx.symbol("PuzzlePieceBorderData.TileBordersGFX");
  addPuzzlePieceBorders(out, ctx.rom.bytes(borders.bank, borders.address, 8 * 16));
  return write2bpp(ctx, out, 96, 96, relative);
}

/** constants/scgb_constants.asm PREDEFPAL_* (RomExtractorGen2.lua:4151,
 * :6520-6521; checked against pokegold). */
const PREDEFPAL_POKEDEX = 29;
const PREDEFPAL_CGB_BADGE = 36;
const PREDEFPAL_UNOWN_PUZZLE = 76;

export interface UnownPuzzleGfx {
  /** gfx keys, 96x96 each, in UNOWNPUZZLE_* order (0-based setval =
   * element index): KABUTO, OMANYTE, AERODACTYL, HO_OH. */
  pictures: string[];
  pieceTiles: number;
  piecesWide: number;
  /** 152x8, 19 tiles from vTiles0 $ed. */
  chrome: string;
  chromeFirstTile: number;
  chromeTiles: number;
  /** 32x8 OBJ sheet (colour 0 transparent) at $e0. */
  cursor: string;
  cursorFirstTile: number;
  palette: Rgb[];
  /** OBJ pal 0: entries 0,1,2,0 with colour 0 = pure red. */
  cursorPalette: Rgb[];
}

/** RomExtractorGen2.lua:6464 unownPuzzleGfx. */
export function unownPuzzleGfx(ctx: Gen2Ctx): UnownPuzzleGfx {
  const pictures = [
    ["KABUTO", "KabutoPuzzleLZ"],
    ["OMANYTE", "OmanytePuzzleLZ"],
    ["AERODACTYL", "AerodactylPuzzleLZ"],
    ["HO_OH", "HoOhPuzzleLZ"],
  ].map(([name, label]) => unownPuzzlePicture(ctx, label!, `menu/unown_puzzle/${name!.toLowerCase()}.png`));

  // :6486 UnownPuzzleStartCancelLZ lands at vTiles0 $ed.
  const chrome = write2bpp(ctx, ctx.decompressLz3Symbol("UnownPuzzleStartCancelLZ"), 152, 8, "menu/unown_puzzle/chrome.png");
  const cursorSym = ctx.symbol("UnownPuzzleCursorGFX");
  const cursor = write2bpp(
    ctx,
    ctx.rom.bytes(cursorSym.bank, cursorSym.address, 4 * 16),
    32,
    8,
    "menu/unown_puzzle/cursor.png",
    true,
  );

  // :6507-6514 _CGB_UnownPuzzle; OBJ colour 0 = `palred 31`, reordered 0,1,2,0.
  const ob = predefPal(ctx, PREDEFPAL_UNOWN_PUZZLE);
  ob[0] = [255, 0, 0];
  return {
    pictures,
    pieceTiles: 3,
    piecesWide: 4,
    chrome,
    chromeFirstTile: 0xed,
    chromeTiles: 19,
    cursor,
    cursorFirstTile: 0xe0,
    palette: predefPal(ctx, PREDEFPAL_UNOWN_PUZZLE),
    cursorPalette: [ob[0]!, ob[1]!, ob[2]!, ob[0]!],
  };
}

// ------------------------------------------------------------ #DEX

/** :6524 SCREEN_AREA — SCREEN_WIDTH * SCREEN_HEIGHT tiles. */
export const SCREEN_AREA = 20 * 18;

export interface PokedexGfx {
  /** 128 x rows*8, 16 tiles wide, first tile $31. */
  tiles: string;
  tilesWide: number;
  firstTile: number;
  tileCount: number;
  /** OBJ sheet (colour 0 transparent), 16 tiles wide. */
  objs: string;
  objsWide: number;
  palette: Rgb[];
  cursorPalette: Rgb[];
  /** 56x56 matted pic. */
  questionMark: string;
  questionMarkPalette: Rgb[];
  /** 16 x 16*n 1bpp strip (white/black, opaque), one 16x16 per species. */
  footprints: string;
  footprintOrder: string[];
}

/** Pads a decompressed 2bpp stream out to whole 16-tile rows (:6550-6552). */
function padToRows(pixels: number[]): { pixels: number[]; tiles: number; rows: number } {
  const tiles = Math.floor(pixels.length / 16);
  const rows = Math.ceil(tiles / 16);
  const out = pixels.slice();
  while (out.length < rows * 16 * 16) out.push(0);
  return { pixels: out, tiles, rows };
}

/** RomExtractorGen2.lua:6547 pokedexGfx. */
export function pokedexGfx(ctx: Gen2Ctx): PokedexGfx {
  const dex = padToRows(ctx.decompressLz3Symbol("PokedexLZ"));
  const tiles = write2bpp(ctx, dex.pixels, 128, dex.rows * 8, "pokedex/dex.png");
  const objs = padToRows(ctx.decompressLz3Symbol("PokedexSlowpokeLZ"));
  const objsKey = write2bpp(ctx, objs.pixels, 128, objs.rows * 8, "pokedex/objs.png", true);
  const cursorPal = ctx.symbol("PokedexCursorPalette");

  // :6578 LoadQuestionMarkPic, a 7x7 `--columns` pic.
  writeCompressedPic(ctx, "LoadQuestionMarkPic.QuestionMarkLZ", 7, "pokedex/question_mark.png");
  const qmPal = ctx.symbol("PokedexQuestionMarkPalette");

  // :6589-6603 Footprints: 256-byte blocks of eight species, tops then
  // bottoms 128 bytes later.
  const prints = ctx.symbol("Footprints");
  const species = ctx.manifest.constants.speciesOrder ?? [];
  const stream: number[] = [];
  for (let index = 0; index < species.length; index++) {
    const base = Math.floor(index / 8) * 256 + (index % 8) * 16;
    for (let i = 0; i < 16; i++) stream.push(ctx.rom.byte(prints.bank, prints.address + base + i));
    for (let i = 0; i < 16; i++) stream.push(ctx.rom.byte(prints.bank, prints.address + base + 128 + i));
  }
  const footprints = save(ctx, decode1bpp(stream, 16, species.length * 16), "pokedex/footprints.png");

  return {
    tiles,
    tilesWide: 16,
    firstTile: 0x31,
    tileCount: dex.tiles,
    objs: objsKey,
    objsWide: 16,
    palette: predefPal(ctx, PREDEFPAL_POKEDEX),
    cursorPalette: colors(ctx, cursorPal.bank, cursorPal.address, 4),
    questionMark: "pokedex/question_mark",
    questionMarkPalette: colors(ctx, qmPal.bank, qmPal.address, 4),
    footprints,
    footprintOrder: species,
  };
}

// ------------------------------------------------------------ Bill's PC

export interface BillsPcGfx {
  /** 32x8, four tiles at vTiles2 $5c. */
  icons: string;
  firstTile: number;
  palette: Rgb[];
  orangePalette?: Rgb[];
}

/** RomExtractorGen2.lua:6611 billsPcGfx — undefined without PCMailGFX. */
export function billsPcGfx(ctx: Gen2Ctx): BillsPcGfx | undefined {
  if (!ctx.location("PCMailGFX")) return undefined;
  const gfx = ctx.symbol("PCMailGFX");
  const pc: BillsPcGfx = {
    icons: write2bpp(ctx, ctx.rom.bytes(gfx.bank, gfx.address, 4 * 16), 32, 8, "pc/mail_item.png"),
    firstTile: 0x5c,
    palette: predefPal(ctx, PREDEFPAL_POKEDEX),
  };
  const orange = ctx.location("BillsPCOrangePalette");
  if (orange) pc.orangePalette = colors(ctx, orange[0], orange[1], 4);
  return pc;
}

// ------------------------------------------------------------ POKeGEAR

/** InitPokegearTilemap's ByteFill tile (engine/pokegear/pokegear.asm:232-238). */
const POKEGEAR_FILL = 0x4f;

/**
 * RomExtractorGen2.lua:6632 readTilemapRLE — Pokegear_LoadTilemapRLE's
 * `tile, count` pairs ($ff ends), cut at `cells` and padded with $4f.
 * Returns `cells` tile ids, row-major (element i = Lua [i+1]).
 */
export function readTilemapRLE(ctx: Gen2Ctx, label: string, cells: number): number[] {
  const symbol = ctx.symbol(label);
  const out: number[] = [];
  let offset = 0;
  while (out.length < cells) {
    const tile = ctx.rom.byte(symbol.bank, symbol.address + offset);
    if (tile === 0xff) break;
    const count = ctx.rom.byte(symbol.bank, symbol.address + offset + 1);
    offset += 2;
    for (let i = 0; i < count && out.length < cells; i++) out.push(tile);
  }
  while (out.length < cells) out.push(POKEGEAR_FILL);
  return out;
}

/** RomExtractorGen2.lua:6655 readFlatTilemap — FillTownMap's flat
 * $ff-terminated map, padded with $4f to `cells`. */
export function readFlatTilemap(ctx: Gen2Ctx, label: string, cells: number): number[] {
  const symbol = ctx.symbol(label);
  const out: number[] = [];
  for (let i = 0; i < cells; i++) {
    const tile = ctx.rom.byte(symbol.bank, symbol.address + i);
    if (tile === 0xff) break;
    out.push(tile);
  }
  while (out.length < cells) out.push(POKEGEAR_FILL);
  return out;
}

export interface PokegearGfx {
  /** 128x48: TownMapGFX $00-$2f then PokegearGFX $30-$5f. */
  tiles: string;
  tilesWide: number;
  townMapTiles: number;
  /** 16x40 OBJ sheet (colour 0 transparent). */
  sprites: string;
  spritesWide: number;
  nestIcon?: string;
  /** SCREEN_AREA (360) tile ids each, row-major 20x18. */
  cards: { clock: number[]; phone: number[]; radio: number[] };
  maps: { johto: number[]; kanto: number[] };
  /** Six 4-colour BG palettes (element i = palette i). */
  palettes: Rgb[][];
  /** 96 entries for tiles $00..$5f, 1-BASED palette numbers (Lua indexes
   * gear.palettes with them directly: palette n = palettes[n - 1] here). */
  palMap: number[];
}

/** RomExtractorGen2.lua:6683 pokegearGfx. */
export function pokegearGfx(ctx: Gen2Ctx): PokegearGfx {
  const townMap = ctx.decompressLz3Symbol("TownMapGFX");
  const gearTiles = ctx.decompressLz3Symbol("PokegearGFX");
  const sheet: number[] = [];
  for (let i = 0; i < 0x30 * 16; i++) sheet.push(townMap[i] ?? 0);
  for (let i = 0; i < 0x30 * 16; i++) sheet.push(gearTiles[i] ?? 0);
  const tiles = write2bpp(ctx, sheet, 128, 48, "pokegear/gear.png");

  const spriteBytes = ctx.decompressLz3Symbol("PokegearSpritesGFX");
  while (spriteBytes.length < 10 * 16) spriteBytes.push(0);
  const sprites = write2bpp(ctx, spriteBytes, 16, 40, "pokegear/sprites.png", true);

  const gear: PokegearGfx = {
    tiles,
    tilesWide: 16,
    townMapTiles: 0x30,
    sprites,
    spritesWide: 2,
    cards: {
      clock: readTilemapRLE(ctx, "ClockTilemapRLE", SCREEN_AREA),
      phone: readTilemapRLE(ctx, "PhoneTilemapRLE", SCREEN_AREA),
      radio: readTilemapRLE(ctx, "RadioTilemapRLE", SCREEN_AREA),
    },
    maps: {
      johto: readFlatTilemap(ctx, "JohtoMap", SCREEN_AREA),
      kanto: readFlatTilemap(ctx, "KantoMap", SCREEN_AREA),
    },
    palettes: [],
    palMap: [],
  };
  // :6704 engine/pokegear/pokegear.asm:2298
  const nest = ctx.location("PokedexNestIconGFX");
  if (nest) gear.nestIcon = write2bpp(ctx, ctx.rom.bytes(nest[0], nest[1], 16), 8, 8, "pokegear/nest_icon.png", true);

  // :6722-6736 — Gold's single PokegearPals; Crystal picks the set by player
  // gender (pokecrystal engine/gfx/color.asm:1330,1333).
  const pals = ctx.location("PokegearPals") ? ctx.symbol("PokegearPals") : ctx.symbol("MalePokegearPals");
  for (let i = 0; i < 6; i++) gear.palettes.push(colors(ctx, pals.bank, pals.address + i * 8, 4));
  const female = ctx.location("FemalePokegearPals");
  if (female) {
    const list: Rgb[][] = [];
    for (let i = 0; i < 6; i++) list.push(colors(ctx, female[0], female[1] + i * 8, 4));
    (gear as PokegearGfx & { palettesFemale?: Rgb[][] }).palettesFemale = list;
  }

  // :6739-6745 TownMapPals.PalMap, low nybble even ids, high odd.
  const palMap = ctx.symbol("TownMapPals.PalMap");
  for (let i = 0; i < 48; i++) {
    const byte = ctx.rom.byte(palMap.bank, palMap.address + i);
    gear.palMap.push((byte % 8) + 1, (Math.floor(byte / 16) % 8) + 1);
  }
  return gear;
}

// ------------------------------------------------------------ trainer card

export interface BadgeOam {
  /** Screen space: OAM y - 16, x - 8. */
  y: number;
  x: number;
  palette: number;
  /** The two 4-byte animation cycles, 8 bytes. */
  frames: number[];
}

export interface TrainerCardGfx {
  /** 128x24: 35 portrait tiles (5x7) then 6 frame tiles at $23, padded. */
  card: string;
  /** Crystal: Kris's card. */
  cardFemale?: string;
  cardTilesWide: number;
  portraitTiles: number;
  portraitWide: number;
  frameFirstTile: number;
  status: string;
  statusWide: number;
  statusFirstTile: number;
  /** 80x72: eight 10-tile faces then the 5 BADGES tiles at $79 (padded to 90). */
  leaders: string;
  leadersWide: number;
  leadersFirstTile: number;
  /** 16x176 OBJ sheet (colour 0 transparent). */
  badges: string;
  badgesWide: number;
  badgeOam: BadgeOam[];
  badgePalette: Rgb[];
  leaderClasses: string[];
  /** FillBoxCGB zones {x, y, width, height, palette}, palette 1-BASED. */
  paletteZones: number[][];
}

/** RomExtractorGen2.lua:6760 trainerCardGfx. */
export function trainerCardGfx(ctx: Gen2Ctx): TrainerCardGfx {
  // :6760-6795 Gold's ChrisPicAndTrainerCardGFX: 41 tiles in one INCBIN
  // pair. Crystal keeps the $23-portrait-then-6-frame-tiles layout but splits
  // it: Chris/KrisCardPic (5x7, built --columns) then 6 tiles of
  // TrainerCardGFX (pokecrystal engine/gfx/player_gfx.asm:96-112).
  const cardSheet = (portraitLabel: string, frameLabel: string | undefined, relative: string): string => {
    let cardTiles: number[];
    if (frameLabel) {
      const portrait = ctx.symbol(portraitLabel);
      const frame = ctx.symbol(frameLabel);
      cardTiles = [
        ...columnsToRows(ctx.rom.bytes(portrait.bank, portrait.address, 35 * 16), 5, 7),
        ...ctx.rom.bytes(frame.bank, frame.address, 6 * 16),
      ];
    } else {
      const sym = ctx.symbol(portraitLabel);
      cardTiles = ctx.rom.bytes(sym.bank, sym.address, 41 * 16);
    }
    while (cardTiles.length < 48 * 16) cardTiles.push(0);
    return write2bpp(ctx, cardTiles, 128, 24, relative);
  };
  let card: string;
  let cardFemale: string | undefined;
  if (ctx.location("ChrisPicAndTrainerCardGFX")) {
    card = cardSheet("ChrisPicAndTrainerCardGFX", undefined, "trainer_card/card.png");
  } else {
    card = cardSheet("ChrisCardPic", "TrainerCardGFX", "trainer_card/card.png");
    if (ctx.location("KrisCardPic")) cardFemale = cardSheet("KrisCardPic", "TrainerCardGFX", "trainer_card/card_f.png");
  }

  const status = ctx.symbol("CardStatusGFX");
  const statusKey = write2bpp(ctx, ctx.rom.bytes(status.bank, status.address, 6 * 16), 48, 8, "trainer_card/status.png");

  const leaders = ctx.symbol("LeaderGFX");
  const leaderTiles = ctx.rom.bytes(leaders.bank, leaders.address, 86 * 16);
  while (leaderTiles.length < 90 * 16) leaderTiles.push(0);
  const leadersKey = write2bpp(ctx, leaderTiles, 80, 72, "trainer_card/leaders.png");

  const badges = ctx.symbol("BadgeGFX");
  const badgesKey = write2bpp(ctx, ctx.rom.bytes(badges.bank, badges.address, 44 * 16), 16, 176, "trainer_card/badges.png", true);

  // :6832-6846 TrainerCard_JohtoBadgesOAM: a pointer, then 11 bytes a badge.
  const oam = ctx.symbol("TrainerCard_JohtoBadgesOAM");
  const badgeOam: BadgeOam[] = [];
  for (let i = 0; i < 8; i++) {
    const at = oam.address + 2 + i * 11;
    const frames: number[] = [];
    for (let f = 0; f < 8; f++) frames.push(ctx.rom.byte(oam.bank, at + 3 + f));
    badgeOam.push({
      y: ctx.rom.byte(oam.bank, at) - 16,
      x: ctx.rom.byte(oam.bank, at + 1) - 8,
      palette: ctx.rom.byte(oam.bank, at + 2),
      frames,
    });
  }

  return {
    card,
    cardFemale,
    cardTilesWide: 16,
    portraitTiles: 35,
    portraitWide: 5,
    frameFirstTile: 0x23,
    status: statusKey,
    statusWide: 6,
    statusFirstTile: 0x29,
    leaders: leadersKey,
    leadersWide: 10,
    leadersFirstTile: 0x29,
    badges: badgesKey,
    badgesWide: 2,
    badgeOam,
    badgePalette: predefPal(ctx, PREDEFPAL_CGB_BADGE),
    leaderClasses: ["FALKNER", "BUGSY", "WHITNEY", "MORTY", "CHUCK", "JASMINE", "PRYCE"],
    paletteZones: [
      [14, 1, 5, 7, 1],
      [18, 1, 1, 1, 2],
      [2, 11, 4, 2, 2],
      [6, 11, 4, 2, 3],
      [10, 11, 4, 2, 4],
      [14, 11, 4, 2, 5],
      [2, 14, 4, 2, 6],
      [6, 14, 4, 2, 7],
      [10, 14, 4, 2, 8],
    ],
  };
}
