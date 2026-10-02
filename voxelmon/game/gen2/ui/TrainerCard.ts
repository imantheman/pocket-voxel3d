// gen1recomp src/ui/gen2/TrainerCard.lua (bdfac727, MIT): Gold's trainer card
// (engine/menus/trainer_card.asm), transcribed from the routines that draw it
// rather than laid out by eye.
//
// The card is not a text box.  TrainerCard_InitBorder writes the frame out of
// the sheet's own tiles: a row of $23, then a row of $23 + 17 spaces + $04 +
// $23, then d rows of $23 + 18 spaces + $23, then $23 + $24 + 17 spaces +
// $23, then a closing row of $23 -- d + 4 rows in all.  It is called twice,
// at (0,0) with d = 5 (rows 0-8) and at (0,8) with d = 6 (rows 8-17), so the
// two halves share row 8.
//
// Page 1 (TrainerCard_PrintTopHalfOfCard + _Page1_PrintDexCaught_GameTime):
//   (2,2) "NAME/", <NEXT> twice to (2,6) "MONEY"; the blank middle line is
//         then overwritten by the $27/$28 "ID No" tiles at (2,4)
//   (7,2) player name, (5,4) ID as 5 digits with leading zeros,
//         (7,6) money as PRINTNUM_MONEY 6 digits
//   (1,3) the $25 x12 + $26 divider
//   (14,1) the player's portrait: a 5x7 block of running tile ids from $00
//   (2,8) the $29..$2d status caption
//   (2,10) "#DEX" and (2,12) "PLAY TIME"; (15,10) caught count,
//         (11,12) hours as 4 digits then (16,12) minutes, with the colon at
//         (15,12) blinking every 32 frames
//   (12,15) "BADGES▶"
//
// Pages 2 and 3 (TrainerCard_Page2_3_InitObjectsAndStrings): the $79..$7d
// "BADGES" caption at (2,8), then eight gym leader faces from LeaderGFX --
// four at row 10 and four at row 13, each ten tiles laid 4 across then two
// rows of 3 offset one column in -- with the badges themselves as OBJs out of
// BadgeGFX at TrainerCard_JohtoBadgesOAM's coordinates.  Page 3 is really the
// Johto page redrawn (same faces, same badges, same flags) -- see drawPanel.
//
// Colour comes from _CGB_TrainerCard: the whole attrmap is palette 1
// (Falkner's trainer colours, which is what tints the frame), the portrait
// box is palette 0 (the player's), and each leader's lower two rows get that
// leader's own palette.

import { Save as Gen2Save } from "../core/Save.ts";
import G, { cachedBlock, keyOf } from "../platform/screen.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Font } from "../shared/render/Font.ts";
import { GbcPalette } from "../shared/render/GbcPalette.ts";
import { Chrome } from "./Chrome.ts";
import { TileSheet } from "./TileSheet.ts";

type Colors = readonly (readonly number[])[];

// Lua: TrainerCard.lua:49
const SCREEN_W = 20;
const SCREEN_H = 18;

// Lua: TrainerCard.lua:53 -- frame tiles, which live at $23 because
// ChrisPicAndTrainerCardGFX is the 35-tile portrait followed by the 6-tile frame.
const TILE_FRAME = 0x23;
const TILE_NOTCH_LOW = 0x24; // the (1, bottom-1) notch
const TILE_NOTCH_HIGH = 0x04; // the (18, top+1) one, from the portrait sheet
const TILE_DIVIDER = 0x25;
const TILE_DIVIDER_END = 0x26;
const TILE_ID_NO = [0x27, 0x28];
const TILE_STATUS = [0x29, 0x2a, 0x2b, 0x2c, 0x2d];
const TILE_BADGES_CAPTION = [0x79, 0x7a, 0x7b, 0x7c, 0x7d];
const TILE_COLON = 0x2e;

// Lua: TrainerCard.lua:65 -- Johto then Kanto, in badge order.
const JOHTO_BADGES = [
  Strings.source("ZEPHYR"), Strings.source("HIVE"), Strings.source("PLAIN"),
  Strings.source("FOG"), Strings.source("STORM"), Strings.source("MINERAL"),
  Strings.source("GLACIER"), Strings.source("RISING"),
];
const KANTO_BADGES = [
  Strings.source("BOULDER"), Strings.source("CASCADE"),
  Strings.source("THUNDER"), Strings.source("RAINBOW"), Strings.source("SOUL"),
  Strings.source("MARSH"), Strings.source("VOLCANO"), Strings.source("EARTH"),
];
const JOHTO_BADGES_LABEL = Strings.source("JOHTO BADGES");
const KANTO_BADGES_LABEL = Strings.source("KANTO BADGES");

// Lua: TrainerCard.lua:84 -- badge captions have room for four font glyphs,
// not four bytes; a 4-glyph cut that lands inside a macro's multi-glyph
// expansion (several spans sharing one source `to`) backs up to the last span
// whose source the next one does not share.
function badgeCaption(text?: string): string {
  text = text ?? "";
  const spans = Font.split(text);
  if (spans.length <= 4) return text;
  let cut = 4;
  while (cut > 0 && spans[cut - 1]!.to === spans[cut]!.to) {
    cut = cut - 1;
  }
  if (cut === 0) return "";
  return text.slice(0, spans[cut - 1]!.to);
}

// Lua: TrainerCard.lua:104 -- the two slots _CGB_TrainerCard swaps by gender:
// CHRIS and FALKNER/KrisPalette.
const PLAYER_PALETTE = 1;
const BORDER_PALETTE = 2;

// Lua: TrainerCard.lua:110 -- Kris's attrmap: the border takes CHRIS's
// palette, the portrait takes hers, the top-right corner follows the border,
// and Clair's face borrows hers.
const FEMALE_ZONES = [
  [14, 1, 5, 7, BORDER_PALETTE],
  [18, 1, 1, 1, PLAYER_PALETTE],
  [14, 14, 4, 2, BORDER_PALETTE],
];

// Lua: TrainerCard.lua:118 -- TrainerCard_JohtoBadgesOAM lists the badges in
// wJohtoBadges bit order, which is not the order they are drawn in: Mineral
// comes before Storm.
const BADGE_OAM_ORDER = [
  "ZEPHYR", "HIVE", "PLAIN", "FOG", "MINERAL", "STORM", "GLACIER", "RISING",
];

/** menu_gfx.json `trainerCard` (the importer's shape). */
export interface TrainerCardGfx {
  card?: string;
  cardFemale?: string;
  cardTilesWide?: number;
  portraitTiles?: number;
  portraitWide?: number;
  status?: string;
  statusWide?: number;
  statusFirstTile?: number;
  leaders?: string;
  leadersWide?: number;
  leadersFirstTile?: number;
  badges?: string;
  badgesWide?: number;
  badgeOam?: { x: number; y: number; palette?: number; frames: number[] }[];
  badgePalette?: Colors;
  leaderClasses?: string[];
  paletteZones?: number[][];
}

export interface TrainerCardOpts {
  save?: any;
  onClose?: () => void;
  sprites?: any;
  palettes?: any;
  menuGfx?: any;
}

// Lua: TrainerCard.lua:197 -- PRINTNUM_MONEY prints a ¥ in front of the first
// significant digit rather than at a fixed column, and the field is six
// digits wide.
function moneyText(amount?: number): string {
  const digits = String(Math.max(0, Math.floor(amount ?? 0))).padStart(6, "0");
  const at = digits.search(/[1-9]/);
  const first = at >= 0 ? at + 1 : digits.length;
  return " ".repeat(first - 1) + "¥" + digits.slice(first - 1);
}

/** TrainerCard.pair's tables, by the stored pair they were made from. */
const pairCache = new WeakMap<object, Colors>();

export class TrainerCard {
  static isOpaque = true;
  static JOHTO_BADGES = JOHTO_BADGES;
  static KANTO_BADGES = KANTO_BADGES;
  static BADGE_OAM_ORDER = BADGE_OAM_ORDER;
  static moneyText = moneyText;

  isOpaque = true;
  game: any;
  save: any;
  palettes: any;
  sprites: any;
  onClose: (() => void) | undefined;
  /** 1 card, 2 Johto badges, 3 Kanto badges */
  page = 1;
  frames = 0;
  gfx: TrainerCardGfx | undefined;
  female = false;
  zone: Record<number, number> | undefined;
  zoneDefault = BORDER_PALETTE;
  card: TileSheet | undefined;
  status: TileSheet | undefined;
  leaders: TileSheet | undefined;
  badges: TileSheet | undefined;

  // Lua: TrainerCard.lua:124
  wantsFillScale(): boolean { return true; }
  // Lua: TrainerCard.lua:125
  drawsWidescreen(): boolean { return true; }

  /** Lua: TrainerCard.lua:128 -- opts: save, onClose(), sprites, palettes, menuGfx */
  static new(game: any, opts?: TrainerCardOpts): TrainerCard {
    opts = opts ?? {};
    const self = new TrainerCard();
    self.game = game;
    self.save = opts.save ?? (game ? game.save : undefined);
    const data = (game && game.data) || {};
    self.palettes = opts.palettes ?? data.gen2Palettes;
    self.sprites = opts.sprites ?? data.gen2Sprites;
    self.onClose = opts.onClose;
    self.page = 1;
    self.frames = 0;

    const gfx: TrainerCardGfx | undefined = (opts.menuGfx ?? data.gen2MenuGfx ?? {}).trainerCard;
    self.gfx = gfx;
    self.female = Gen2Save.isFemale(self.save) && gfx != null && gfx.cardFemale != null;
    if (gfx) {
      // One palette lookup per cell, flattened from the FillBoxCGB zones the
      // way PackGfx does it.  Anything outside a zone is palette 1.
      const zone: Record<number, number> = {};
      self.zone = zone;
      self.zoneDefault = BORDER_PALETTE;
      const paint = (z: number[]): void => {
        for (let y = z[1]!; y <= z[1]! + z[3]! - 1; y++) {
          for (let x = z[0]!; x <= z[0]! + z[2]! - 1; x++) {
            zone[y * SCREEN_W + x] = z[4]!;
          }
        }
      };
      for (const z of gfx.paletteZones ?? []) paint(z);
      if (self.female) {
        self.zoneDefault = PLAYER_PALETTE;
        for (const z of FEMALE_ZONES) paint(z);
      }
      const paletteFor = (_tile: number, tx: number, ty: number): Colors | undefined => self.colorsAt(tx, ty);
      self.card = TileSheet.new({
        path: (self.female && gfx.cardFemale) || gfx.card,
        wide: gfx.cardTilesWide || 16, firstTile: 0,
        paletteFor,
      });
      self.status = TileSheet.new({
        path: gfx.status, wide: gfx.statusWide || 6,
        firstTile: gfx.statusFirstTile || 0x29, paletteFor,
      });
      self.leaders = TileSheet.new({
        path: gfx.leaders, wide: gfx.leadersWide || 10,
        firstTile: gfx.leadersFirstTile || 0x29, paletteFor,
      });
      self.badges = TileSheet.new({
        path: gfx.badges, wide: gfx.badgesWide || 2, firstTile: 0,
        palette: gfx.badgePalette,
      });
    }
    return self;
  }

  // Lua: TrainerCard.lua:192
  styled(): boolean {
    return this.card !== undefined && this.card.available();
  }

  /**
   * Lua: TrainerCard.lua:198 -- the eight BG palettes _CGB_TrainerCard loads:
   * the player's, then the seven leaders whose classes have a pic palette of
   * their own.
   */
  palette(index: number): Colors | undefined {
    const pals = this.palettes;
    if (!pals) return undefined;
    if (index === 1) {
      return this.pair(pals.trainers && pals.trainers.PLAYER);
    }
    const classes = (this.gfx && this.gfx.leaderClasses) || [];
    const cls = classes[index - 2];
    return this.pair(pals.trainers && cls !== undefined ? pals.trainers[cls] : undefined);
  }

  /**
   * Lua: TrainerCard.lua:210 -- LoadPalette_White_Col1_Col2_Black: the two
   * stored colours sit between white and black.
   */
  pair(colors: any): Colors | undefined {
    if (!(colors && colors[0] && colors[1])) return undefined;
    // one table per stored pair: every tile of a zone asks, and a fresh
    // table each time missed every palette cache below (asPalette, the
    // resolve memo, the screen's slot cache)
    let made = pairCache.get(colors);
    if (!made) {
      made = [[255, 255, 255], colors[0], colors[1], [0, 0, 0]];
      pairCache.set(colors, made);
    }
    return made;
  }

  // Lua: TrainerCard.lua:217
  colorsAt(tx: number, ty: number): Colors | undefined {
    const index = (this.zone && this.zone[ty * SCREEN_W + tx]) || this.zoneDefault || BORDER_PALETTE;
    return this.palette(index);
  }

  // Lua: TrainerCard.lua:223 -- Kanto's page only exists once the player has
  // been there; the cart gates it on the Kanto badges having started.
  pages(): number {
    const player = this.save && this.save.player;
    const kb = player ? player.kantoBadges : undefined;
    const kanto = kb != null && Object.keys(kb).length > 0;
    return kanto ? 3 : 2;
  }

  // Lua: TrainerCard.lua:231
  update(_dt?: number): void {
    this.frames = this.frames + 1;
    const input = this.game ? this.game.input : undefined;
    if (!input) return;
    if (input.wasPressed("b") || input.wasPressed("start")) {
      if (this.onClose) this.onClose();
      return;
    }
    const pages = this.pages();
    if (input.wasPressed("right")) {
      this.page = this.page < pages ? this.page + 1 : 1;
    } else if (input.wasPressed("left")) {
      this.page = this.page > 1 ? this.page - 1 : pages;
    } else if (input.wasPressed("a")) {
      // Page 1's A is "turn the page"; page 2's A quits (TrainerCard_Page2_Joypad).
      if (this.page === 1) {
        this.page = 2;
      } else if (this.onClose) {
        this.onClose();
      }
    }
  }

  // Lua: TrainerCard.lua:254
  caughtCount(): number {
    let caught = 0;
    const table = (this.save && this.save.pokedex && this.save.pokedex.caught) || {};
    for (const key of Object.keys(table)) {
      if (table[key]) caught = caught + 1;
    }
    return caught;
  }

  // Lua: TrainerCard.lua:271
  tile(sheet: TileSheet | undefined, id: number, tx: number, ty: number): void {
    if (sheet) sheet.draw(id, tx, ty);
  }

  // Lua: TrainerCard.lua:276 -- TrainerCard_InitBorder, literally.
  frame(ty: number, interiorRows: number): void {
    const sheet = this.card;
    for (let x = 0; x <= SCREEN_W - 1; x++) this.tile(sheet, TILE_FRAME, x, ty);
    this.tile(sheet, TILE_FRAME, 0, ty + 1);
    this.tile(sheet, TILE_NOTCH_HIGH, 18, ty + 1);
    this.tile(sheet, TILE_FRAME, 19, ty + 1);
    for (let row = 2; row <= interiorRows + 1; row++) {
      this.tile(sheet, TILE_FRAME, 0, ty + row);
      this.tile(sheet, TILE_FRAME, 19, ty + row);
    }
    const notch = ty + interiorRows + 2;
    this.tile(sheet, TILE_FRAME, 0, notch);
    this.tile(sheet, TILE_NOTCH_LOW, 1, notch);
    this.tile(sheet, TILE_FRAME, 19, notch);
    for (let x = 0; x <= SCREEN_W - 1; x++) {
      this.tile(sheet, TILE_FRAME, x, ty + interiorRows + 3);
    }
  }

  // Lua: TrainerCard.lua:297 -- the 5x7 portrait: running tile ids from $00,
  // row-major, at (14,1).
  drawPortrait(): void {
    const wide = (this.gfx && this.gfx.portraitWide) || 5;
    const high = Math.floor(((this.gfx && this.gfx.portraitTiles) || 35) / wide);
    for (let row = 0; row <= high - 1; row++) {
      for (let col = 0; col <= wide - 1; col++) {
        this.tile(this.card, row * wide + col, 14 + col, 1 + row);
      }
    }
  }

  // Lua: TrainerCard.lua:310 -- TrainerCard_PrintTopHalfOfCard runs once, in
  // .InitRAM, and no page redraws it -- so the name, ID, money and portrait
  // stay on screen behind the badge pages too.
  print(text: string, tx: number, ty: number): void {
    Chrome.printThrough(text, tx, ty, this.colorsAt(tx, ty));
  }

  // Lua: TrainerCard.lua:314
  cursor(tx: number, ty: number, hollow?: boolean): void {
    Chrome.cursorThrough(tx, ty, this.colorsAt(tx, ty), false, hollow);
  }

  // Lua: TrainerCard.lua:318
  drawTopHalf(): void {
    // the frame, the name, ID, money and the portrait: the same cells until
    // one of them changes (screen.ts cachedBlock)
    const player = (this.save || {}).player || {};
    const key = `top:${player.name}:${player.id}:${player.money}:${keyOf(this.card)}:${keyOf(this.palettes)}`
      + `:${GbcPalette.stateKey()}`;
    cachedBlock(this, key, () => this.drawTopHalfNow());
  }

  /** drawTopHalf's drawing. */
  private drawTopHalfNow(): void {
    const player = (this.save || {}).player || {};
    this.frame(0, 5);
    this.print(Strings.get("NAME/"), 2, 2);
    this.print(player.name || "GOLD", 7, 2);
    this.tile(this.card, TILE_ID_NO[0]!, 2, 4);
    this.tile(this.card, TILE_ID_NO[1]!, 3, 4);
    this.print(Chrome.number(player.id || 0, 5, true), 5, 4);
    this.print(Strings.get("MONEY"), 2, 6);
    this.print(moneyText(player.money), 7, 6);
    for (let x = 1; x <= 12; x++) this.tile(this.card, TILE_DIVIDER, x, 3);
    this.tile(this.card, TILE_DIVIDER_END, 13, 3);
    this.drawPortrait();
  }

  // Lua: TrainerCard.lua:333
  drawCard(): void {
    const save = this.save || {};
    this.drawTopHalf();
    cachedBlock(this, `frame8:${keyOf(this.card)}:${keyOf(this.palettes)}:${GbcPalette.stateKey()}`,
      () => this.frame(8, 6));

    // The $29..$2d caption plaque, which sits on the row the two halves share.
    TILE_STATUS.forEach((id, i) => this.tile(this.status, id, 2 + i, 8));

    // `#` is the compression byte for POKé, four tiles, so spelling it out is
    // what the cart actually draws.
    this.print(Strings.get("POKéDEX"), 2, 10);
    this.print(Strings.get("PLAY TIME"), 2, 12);
    this.print(Chrome.number(this.caughtCount(), 3), 15, 10);

    const time = save.playTime || {};
    this.print(Chrome.number(time.hours || 0, 4), 11, 12);
    // The colon is $2e, which belongs to CardStatusGFX rather than the card
    // sheet, and TrainerCard_Page1_PrintGameTime xors it with ' ' every 32
    // frames -- which is what makes the clock look like it is running.
    if (Math.floor(this.frames / 32) % 2 === 0) {
      this.tile(this.status, TILE_COLON, 15, 12);
    }
    this.print(Chrome.number(time.minutes || 0, 2, true), 16, 12);

    this.print(Strings.get("BADGES"), 12, 15);
    this.cursor(18, 15);
  }

  // Lua: TrainerCard.lua:366 -- TrainerCard_Page2_3_PlaceLeadersFaces: four
  // tiles across the top row, then two rows of three offset one column in,
  // ten tiles per face with the id running on across all eight.
  drawLeaderFace(first: number, tx: number, ty: number): number {
    let id = first;
    for (let col = 0; col <= 3; col++) {
      this.tile(this.leaders, id, tx + col, ty);
      id = id + 1;
    }
    for (let row = 1; row <= 2; row++) {
      for (let col = 1; col <= 3; col++) {
        this.tile(this.leaders, id, tx + col, ty + row);
        id = id + 1;
      }
    }
    return id;
  }

  // Lua: TrainerCard.lua:382
  drawBadgeSprites(owned: Record<string | number, unknown>, names: string[]): void {
    const list = this.gfx && this.gfx.badgeOam;
    const badges = this.badges;
    if (!(list && badges && badges.available())) return;
    // Eight frames on a 3-bit counter, stepped every 8 VBlanks.
    const frame = Math.floor(this.frames / 8) % 8;
    list.forEach((obj, i) => {
      // The OAM table is in wJohtoBadges bit order, which is not the drawing
      // order (Mineral is listed before Storm), so the earned flag is looked up
      // by name -- or by that name's position, since a save may key the array
      // either way.
      const name = BADGE_OAM_ORDER[i]!;
      let slot: number | undefined;
      names.forEach((badge, index) => {
        if (badge === name) slot = index + 1;
      });
      if (owned[name] || (slot !== undefined && owned[slot])) {
        const tile = obj.frames[frame] ?? 0;
        // Bit 7 of the tile id is an x-flip, which is how Risingbadge turns.
        const flip = tile >= 0x80;
        const base = flip ? tile - 0x80 : tile;
        const sx = flip ? -1 : 1;
        const body = (): void => {
          // TrainerCard_Page2_3_OAMUpdate writes these to OAM: objects even
          // where they land on the 8px grid.
          G.objects = true;
          for (const cell of [[0, 0, 0], [1, 0, 1], [0, 1, 2], [1, 1, 3]] as const) {
            const quad = badges.quad(base + cell[2]);
            const image = badges.image();
            if (quad && image) {
              const px = obj.x + (flip ? 1 - cell[0] : cell[0]) * 8;
              G.draw(image, quad, px + (flip ? 8 : 0), obj.y + cell[1] * 8, 0, sx, 1);
            }
          }
          G.objects = false;
        };
        G.setColor(1, 1, 1, 1);
        if (this.gfx!.badgePalette && GbcPalette.available()) {
          GbcPalette.with(this.gfx!.badgePalette, body);
        } else {
          body();
        }
      }
    });
  }

  // Lua: TrainerCard.lua:429
  drawBadges(names: string[], owned: Record<string | number, unknown>): void {
    this.drawTopHalf();
    this.frame(8, 6);
    TILE_BADGES_CAPTION.forEach((id, i) => this.tile(this.leaders, id, 2 + i, 8));
    let id = (this.gfx && this.gfx.leadersFirstTile) || 0x29;
    for (let face = 0; face <= 3; face++) id = this.drawLeaderFace(id, 2 + face * 4, 10);
    for (let face = 0; face <= 3; face++) id = this.drawLeaderFace(id, 2 + face * 4, 13);
    this.drawBadgeSprites(owned, names);
  }

  // ---------------------------------------------------------------- fallback

  // Lua: TrainerCard.lua:443
  drawPlain(): void {
    const save = this.save || {};
    const player = save.player || {};
    const P = Chrome.DEFAULT_BOX_PALETTE;
    Chrome.clear();
    if (this.page === 1) {
      Chrome.box(0, 0, 20, 9);
      Chrome.printThrough(Strings.get("NAME/"), 2, 2, P);
      Chrome.printThrough(player.name || "GOLD", 7, 2, P);
      Chrome.printThrough(Strings.get("ID No"), 2, 4, P);
      Chrome.printThrough(Chrome.number(player.id || 0, 5, true), 5, 4, P);
      Chrome.printThrough(Strings.get("MONEY"), 2, 6, P);
      Chrome.printThrough(moneyText(player.money), 7, 6, P);
      Chrome.box(0, 8, 20, 10);
      Chrome.printThrough(Strings.get("POKéDEX"), 2, 10, P);
      Chrome.printThrough(Chrome.number(this.caughtCount(), 3), 15, 10, P);
      Chrome.printThrough(Strings.get("PLAY TIME"), 2, 12, P);
      const time = save.playTime || {};
      Chrome.printThrough(Chrome.number(time.hours || 0, 4), 11, 12, P);
      Chrome.printThrough(":", 15, 12, P);
      Chrome.printThrough(Chrome.number(time.minutes || 0, 2, true), 16, 12, P);
      Chrome.printThrough(Strings.get("BADGES"), 12, 15, P);
      Chrome.cursorThrough(18, 15, P);
      return;
    }
    const names = this.page === 2 ? JOHTO_BADGES : KANTO_BADGES;
    // TrainerCard_Page3_Joypad hands TrainerCard_Page2_3_AnimateBadges the
    // exact same TrainerCard_JohtoBadgesOAM pointer page 2 uses, so page 3
    // never once reads wKantoBadges, it just relabels the Johto flags.
    const held = player.badges || {};
    Chrome.box(0, 0, 20, 9);
    Chrome.printThrough(Strings.get(this.page === 2 ? JOHTO_BADGES_LABEL : KANTO_BADGES_LABEL), 2, 2, P);
    Chrome.box(0, 8, 20, 10);
    names.forEach((name, i) => {
      const tx = 2 + (i % 4) * 4;
      const ty = 10 + Math.floor(i / 4) * 3;
      const label = held[i + 1] || held[name] ? badgeCaption(Strings.get(name)) : "----";
      Chrome.printThrough(label, tx, ty, P);
    });
  }

  // Lua: TrainerCard.lua:483
  drawPanel(): void {
    if (!this.styled()) {
      this.drawPlain();
      G.setColor(1, 1, 1, 1);
      return;
    }
    Chrome.paletteFill(0, 0, SCREEN_W * 8, SCREEN_H * 8, Chrome.DEFAULT_BOX_PALETTE);
    const player = (this.save && this.save.player) || {};
    if (this.page === 1) {
      this.drawCard();
    } else if (this.page === 2) {
      this.drawBadges(JOHTO_BADGES, player.badges || {});
    } else {
      // Page 3 reuses TrainerCard_JohtoBadgesOAM wholesale, header word and
      // all, so it is really the Johto page again.
      this.drawBadges(JOHTO_BADGES, player.badges || {});
    }
    G.setColor(1, 1, 1, 1);
  }

  // Lua: TrainerCard.lua:503
  draw(): void {
    this.drawPanel();
  }

  // Lua: TrainerCard.lua:507 -- the Gold screen is the panel: no letterbox or fit.
  drawWidescreen(_winW?: number, _winH?: number): void {
    G.push();
    this.drawPanel();
    G.pop();
  }
}

export default TrainerCard;
