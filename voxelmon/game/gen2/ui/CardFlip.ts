// gen1recomp src/ui/gen2/CardFlip.lua (bdfac727, MIT): Gold's card flip
// (engine/games/card_flip.asm _CardFlip), the `special CardFlip` the
// Goldenrod Game Corner's second machine calls.
//
// Three coins a go. A 24 card deck is dealt two at a time; the player picks
// one of the two face-down cards without seeing it, then bets on a square of
// a 6x8 board, and the card is turned over. A card is a Pokemon (Pikachu,
// Jigglypuff, Poliwag, Oddish) and a level (1-6), packed as level * 4 + mon.
//
// The payout ladder, from CardFlip_CheckWinCondition:
//
//   6   a PAIR of Pokemon      (Pikachu/Jigglypuff, or Poliwag/Oddish)
//   9   a PAIR of levels       (1-2, 3-4, or 5-6)
//   12  one Pokemon
//   18  one level
//   72  the exact card
//
// The four squares where a Pokemon pair meets a level pair are .Impossible.
//
// Layout (from the ASM): the odds board is CardFlipTilemap at (9,0), 11x12;
// twelve hand lights down column 9; the two chosen-card boxes at (2,0) and
// (2,6); the coin box at (9,15); the text box at (0,12).

import G from "../platform/screen.ts";
import { loadGenerated } from "../platform/data.ts";
import { random as luaRandom } from "../platform/rng.ts";
import { CoinCase } from "../core/CoinCase.ts";
import { Music } from "../shared/core/Music.ts";
import { Sound } from "../shared/core/Sound.ts";
import { Strings } from "../shared/core/Strings.ts";
import { GbcPalette } from "../shared/render/GbcPalette.ts";
import type { LcdImage, Quad } from "../platform/screen.ts";
import { Chrome } from "./Chrome.ts";
import { TileSheet } from "./TileSheet.ts";

type Colors = readonly (readonly number[])[];
type Lines = string[] & { source?: string };

export interface CardFlipOpts {
  save?: any;
  random?: (n: number) => number;
  onClose?: () => void;
}

export interface BoardCell {
  kind: "impossible" | "monPair" | "mon" | "levelPair" | "level" | "card";
  value?: number;
  payout: number;
}

// Lua: CardFlip.lua:100
const SHUFFLE_RETRIES = 256;

// Lua: CardFlip.lua:283 -- screen tile coordinates.
const LIGHT_X = 9;
const MON_COL: Record<number, number> = { 2: 12, 3: 14, 4: 16, 5: 18 };
const LEVEL_PAIR_COL = 10;
const LEVEL_COL = 11;
const MON_PAIR_ROW = 0;
const MON_ROW = 1;

// GetCoordsOfChosenCard. Lua: CardFlip.lua:293
const CARD_BOX = [{ x: 2, y: 0 }, { x: 2, y: 6 }];

const COIN_BOX_X = 9;
const COIN_BOX_Y = 15;
const COIN_LABEL_X = 10;
const COIN_LABEL_Y = 16;
const COIN_VALUE_X = 15;
const COIN_VALUE_Y = 16;

const TEXT_BOX_X = 0;
const TEXT_BOX_Y = 12;
const TEXT_X = 1;
const TEXT_Y = 14;
const TEXT_LINE = 2;

function lines(source: string): Lines {
  const out = source.split("\n") as Lines;
  out.source = source;
  return out;
}

/**
 * Lua: CardFlip.lua:330 -- deliberately \n-only: every entry is a fixed
 * two-line cart message.
 */
function localizedLines(value: Lines | null | undefined): string[] {
  if (!(value && value.source)) return value ?? [];
  const translated = Strings.lookup(value.source);
  if (translated === value.source) return value;
  return translated.split("\n");
}

// Lua: CardFlip.lua:341
const SFX_TRANSACTION = "Sfx_Transaction";
const SFX_KINESIS = "Sfx_Kinesis";
const SFX_START = "Sfx_SlotMachineStart";
const SFX_CHOOSE = "Sfx_ChooseACard";
const SFX_MOVE = "Sfx_PokeballsPlacedOnTable";
const SFX_WIN = "Sfx_2ndPlace";
const SFX_WRONG = "Sfx_Wrong";
const SFX_PAY_DAY = "Sfx_PayDay";
const SFX_QUIT = "Sfx_QuitSlots";

// Lua: CardFlip.lua:624
const CARDFLIP_PALS: { bg: Record<number, Colors>; obj: Record<number, Colors> } = {
  bg: {
    0: [[255, 255, 255], [140, 57, 255], [49, 156, 66], [0, 0, 0]], // Base / table green
    1: [[255, 255, 255], [239, 206, 0], [49, 156, 66], [0, 0, 0]], // Pikachu
    2: [[255, 255, 255], [255, 107, 247], [49, 156, 66], [0, 0, 0]], // Jigglypuff
    3: [[255, 255, 255], [66, 140, 247], [49, 156, 66], [0, 0, 0]], // Poliwag
    4: [[255, 255, 255], [66, 255, 66], [49, 156, 66], [0, 0, 0]], // Oddish
    5: [[255, 255, 255], [140, 57, 255], [49, 156, 66], [0, 0, 0]], // Level header
    6: [[255, 255, 255], [140, 57, 255], [49, 156, 66], [0, 0, 0]], // Border
    7: [[255, 255, 255], [140, 57, 255], [49, 156, 66], [0, 0, 0]], // Textbox
  },
  obj: {
    0: [[255, 255, 255], [248, 56, 40], [248, 56, 40], [248, 56, 40]], // GBC red OAM
  },
};

// Lua: CardFlip.lua:640 -- the cart's CardFlipTilemap, read once.
//
// NOT FAITHFUL: the Lua reads assets/generated/card_flip/card_flip.tilemap
// with love.filesystem.read. The guest has no binary file channel, so the
// bytes come from the dataset's "card_flip.tilemap" table (an array of bytes,
// or a string of byte chars) when the cook ships one; without it the board
// takes the Lua's own labelled-cell degrade.
let TILEMAP: number[] | false | null = null;
function getCardFlipTilemap(): number[] | null {
  if (TILEMAP === null) {
    TILEMAP = false;
    let raw: unknown;
    try {
      raw = loadGenerated("assets/generated/card_flip/card_flip.tilemap");
    } catch {
      raw = undefined;
    }
    if (typeof raw === "string" && raw.length > 0) {
      TILEMAP = Array.from(raw, (ch) => ch.charCodeAt(0) & 0xff);
    } else if (raw && typeof (raw as ArrayLike<number>).length === "number" && (raw as ArrayLike<number>).length > 0) {
      TILEMAP = Array.from(raw as ArrayLike<number>);
    }
  }
  return TILEMAP || null;
}

// Lua: CardFlip.lua:682
const HEADER_TILE_MAP: Record<number, number> = {
  0x3e: 0, 0x3f: 1,
  0x40: 3, 0x41: 4,
  0x42: 6, 0x43: 7,
  0x44: 9, 0x45: 10,
  0x46: 12, 0x47: 13,
  0x48: 15, 0x49: 16,
  0x4a: 18, 0x4b: 19,
  0x4c: 21, 0x4d: 22,
};

// Lua: CardFlip.lua:875
const FACE_DOWN_TILES = [
  [0x08, 0x09, 0x09, 0x09, 0x0a],
  [0x0b, 0x28, 0x2b, 0x28, 0x0c],
  [0x0b, 0x2c, 0x2d, 0x2e, 0x0c],
  [0x0b, 0x2f, 0x30, 0x31, 0x0c],
  [0x0b, 0x32, 0x33, 0x34, 0x0c],
  [0x0d, 0x0e, 0x0e, 0x0e, 0x0f],
];

// Lua: CardFlip.lua:884
const FACE_UP_TILES = [
  [0x18, 0x19, 0x19, 0x19, 0x1a],
  [0x1b, 0x35, 0x28, 0x28, 0x1c],
  [0x0b, 0x28, 0x28, 0x28, 0x0c],
  [0x0b, 0x28, 0x28, 0x28, 0x0c],
  [0x0b, 0x28, 0x28, 0x28, 0x0c],
  [0x1d, 0x1e, 0x1e, 0x1e, 0x1f],
];

// Lua: CardFlip.lua:893 -- each mon's 3x3 pic in card_flip_2.
const MON_ANCHORS: Record<number, number> = { 0: 24, 1: 33, 2: 42, 3: 51 };

/**
 * A fill in 8x8 pieces that never pass the rect's edge: grid-aligned pieces
 * become cells, the rest solid objects. G.rectangle alone would round a
 * ragged edge out to a whole 8px object; the Lua's 12px-tall covers need the
 * exact rect, which a cell row plus an object row offset by 4px gives.
 */
function fillExact(x: number, y: number, w: number, h: number): void {
  const xs: number[] = [];
  for (let xx = x; xx < x + w; xx += 8) xs.push(Math.min(xx, x + w - 8));
  const ys: number[] = [];
  for (let yy = y; yy < y + h; yy += 8) ys.push(Math.min(yy, y + h - 8));
  for (const yy of ys) for (const xx of xs) G.rectangle("fill", xx, yy, 8, 8);
}

export class CardFlip {
  // Lua: CardFlip.lua:63
  static isOpaque = true;
  isOpaque = true;

  // Lua: CardFlip.lua:66 -- CARDFLIP_DECK_SIZE EQU 4 * 6.
  static DECK_SIZE = 24;
  static NUM_MONS = 4;
  static NUM_LEVELS = 6;
  // .DeductCoins: `ld de, -3`.
  static BET = 3;

  // Lua: CardFlip.lua:74
  static MONS: Record<number, string> = { 0: "PIKACHU", 1: "JIGGLYPUFF", 2: "POLIWAG", 3: "ODDISH" };
  static MON_LABELS: Record<number, string> = { 0: "PI", 1: "JI", 2: "PO", 3: "OD" };

  // Lua: CardFlip.lua:132
  static HANDS_PER_DECK = 12;

  // Lua: CardFlip.lua:147
  static PAYOUT_MON_PAIR = 6;
  static PAYOUT_LEVEL_PAIR = 9;
  static PAYOUT_MON = 12;
  static PAYOUT_LEVEL = 18;
  static PAYOUT_CARD = 72;

  static BOARD_W = 6;
  static BOARD_H = 8;

  // Lua: CardFlip.lua:157 -- BOARD[y][x], 0-based on both axes.
  static BOARD: BoardCell[][] = (() => {
    const board: BoardCell[][] = [];
    for (let y = 0; y < 8; y++) {
      const row: BoardCell[] = [];
      for (let x = 0; x < 6; x++) {
        let cell: BoardCell;
        if (y < 2 && x < 2) {
          cell = { kind: "impossible", payout: 0 };
        } else if (y === 0) {
          // .PikaJiggly / .PoliOddish: `and $2` splits the four in half.
          cell = { kind: "monPair", value: Math.floor((x - 2) / 2), payout: 6 };
        } else if (y === 1) {
          cell = { kind: "mon", value: x - 2, payout: 12 };
        } else if (x === 0) {
          // .OneTwo / .ThreeFour / .FiveSix, each reached from two rows.
          cell = { kind: "levelPair", value: Math.floor((y - 2) / 2), payout: 9 };
        } else if (x === 1) {
          cell = { kind: "level", value: y - 2, payout: 18 };
        } else {
          cell = { kind: "card", value: (y - 2) * 4 + (x - 2), payout: 72 };
        }
        row[x] = cell;
      }
      board[y] = row;
    }
    return board;
  })();

  // Lua: CardFlip.lua:306 -- data/text/common_3.asm.
  static TEXTS: Record<string, Lines> = {
    playWithThree: lines(Strings.source("Play with\n3 coins?")),
    notEnough: lines(Strings.source("Not enough\ncoins.")),
    chooseACard: lines(Strings.source("Choose a\ncard.")),
    placeYourBet: lines(Strings.source("Place\nyour bet")),
    playAgain: lines(Strings.source("Play\nagain?")),
    shuffled: lines(Strings.source("The cards\nshuffled.")),
    yeah: lines(Strings.source("Yeah!")),
    darn: lines(Strings.source("Darn…")),
  };

  game: any;
  save: any;
  onClose?: () => void;
  random: (n: number) => number;
  cursorX: number;
  cursorY: number;
  played: number;
  discarded: Record<number, boolean>;
  deck: number[];
  phase?: string;
  choice = 1;
  lines?: string[] | null;
  after?: (() => void) | null;
  which = 0;
  faceUp?: number | null;
  payoutLeft = 0;
  payoutTick = 0;
  flipTimer = 0;
  targetCard?: number;
  blink?: number;
  betBlink?: number;
  dtAccum?: number;
  sheet1?: TileSheet;
  sheet2?: TileSheet;
  sheet3?: TileSheet;
  sheetOn?: TileSheet;
  sheetOff?: TileSheet;
  s3Image?: LcdImage | null;
  quadCorner?: Quad;
  quadVEdge?: Quad;
  quadHEdge?: Quad;
  [key: string]: any;

  /** Lua: CardFlip.lua:82 -- `and $3`. */
  static mon(card: number): number {
    return card % 4;
  }
  /** Lua: CardFlip.lua:83 -- `and $1c`, over four. */
  static level(card: number): number {
    return Math.floor(card / 4);
  }
  /** Lua: CardFlip.lua:84 -- `and $18`. */
  static levelPair(card: number): number {
    return Math.floor(card / 8);
  }
  /** Lua: CardFlip.lua:85 */
  static card(level: number, mon: number): number {
    return level * 4 + mon;
  }

  /**
   * Lua: CardFlip.lua:102 -- CardFlip_ShuffleDeck: values 23 down to 1 into
   * random empty slots (rolls of 24-31 rejected); the slot left at zero IS
   * card 0. Returned 0-based.
   */
  static shuffle(random: (n: number) => number): number[] {
    const deck: number[] = [];
    for (let i = 0; i < CardFlip.DECK_SIZE; i++) deck[i] = 0;
    let value = CardFlip.DECK_SIZE - 1;
    while (value > 0) {
      let slot = 0;
      let tries = 0;
      do {
        slot = random(32);
        tries++;
      } while (!((slot < CardFlip.DECK_SIZE && deck[slot] === 0) || tries >= SHUFFLE_RETRIES));
      if (slot >= CardFlip.DECK_SIZE || deck[slot] !== 0) {
        slot = 0;
        while (slot < CardFlip.DECK_SIZE && deck[slot] !== 0) slot++;
      }
      deck[slot] = value;
      value--;
    }
    return deck;
  }

  /** Lua: CardFlip.lua:128 -- .CheckTheCard: wDeck + played * 2 + which. */
  static dealt(deck: number[], played: number, which: number): number {
    return deck[played * 2 + which]!;
  }

  /** Lua: CardFlip.lua:185 */
  static cell(x: number, y: number): BoardCell | undefined {
    const row = CardFlip.BOARD[y];
    return row ? row[x] : undefined;
  }

  /** Lua: CardFlip.lua:192 -- what a square pays against a card, or 0. */
  static payout(x: number, y: number, card: number | null | undefined): number {
    const cell = CardFlip.cell(x, y);
    if (!cell || card == null) return 0;
    const kind = cell.kind;
    if (kind === "impossible") return 0;
    if (kind === "monPair") return Math.floor(CardFlip.mon(card) / 2) === cell.value ? cell.payout : 0;
    if (kind === "mon") return CardFlip.mon(card) === cell.value ? cell.payout : 0;
    if (kind === "levelPair") return CardFlip.levelPair(card) === cell.value ? cell.payout : 0;
    if (kind === "level") return CardFlip.level(card) === cell.value ? cell.payout : 0;
    return card === cell.value ? cell.payout : 0;
  }

  /**
   * Lua: CardFlip.lua:221 -- ChooseCard_HandleJoypad, branch for branch: the
   * `and $e` snaps and the two teleports.
   */
  static moveCursor(x: number, y: number, direction: string): [number, number] {
    if (direction === "left") {
      if (y === 0) {
        // .mon_pair_left
        x = x - (x % 2);
        if (x < 3) return [1, 2]; // .left_to_number_gp
        return [x - 2, y];
      }
      if (y === 1) {
        // .mon_group_left
        if (x < 3) return [1, 2];
        return [x - 1, y];
      }
      if (x === 0) return [x, y];
      return [x - 1, y];
    }
    if (direction === "right") {
      if (y === 0) {
        // .mon_pair_right
        x = x - (x % 2);
        if (x >= 4) return [x, y];
        return [x + 2, y];
      }
      if (x >= 5) return [x, y];
      return [x + 1, y];
    }
    if (direction === "up") {
      if (x === 0) {
        // .num_pair_up
        y = y - (y % 2);
        if (y < 3) return [2, 1]; // .up_to_mon_group
        return [x, y - 2];
      }
      if (x === 1) {
        // .num_gp_up
        if (y < 3) return [2, 1];
        return [x, y - 1];
      }
      if (y === 0) return [x, y];
      return [x, y - 1];
    }
    if (direction === "down") {
      if (x === 0) {
        // .num_pair_down
        y = y - (y % 2);
        if (y >= 6) return [x, y];
        return [x, y + 2];
      }
      if (y >= 7) return [x, y];
      return [x, y + 1];
    }
    return [x, y];
  }

  /** Lua: CardFlip.lua:352 */
  wantsFillScale(): boolean {
    return true;
  }

  /** Lua: CardFlip.lua:353 */
  drawsWidescreen(): boolean {
    return true;
  }

  /** Lua: CardFlip.lua:356 -- opts: save, random(n), onClose(). */
  static new(game: any, opts?: CardFlipOpts): CardFlip {
    return new CardFlip(game, opts ?? {});
  }

  constructor(game: any, opts: CardFlipOpts) {
    this.game = game;
    this.save = opts.save || (game && game.save);
    this.onClose = opts.onClose;
    this.random = opts.random ?? ((n: number) => luaRandom(n) - 1);
    // `ld a, $2 / ld [wCardFlipCursorY], a / ld [wCardFlipCursorX], a`.
    this.cursorX = 2;
    this.cursorY = 2;
    this.played = 0;
    this.discarded = {};
    this.deck = CardFlip.shuffle(this.random);
    this.playMusic();
    this.enterAsk();
  }

  /** Lua: CardFlip.lua:378 */
  playMusic(): void {
    const data = this.game && this.game.data;
    if (!data) return;
    Music.play(data, "Music_GameCorner");
  }

  /** Lua: CardFlip.lua:384 */
  sfx(name: string): void {
    const data = this.game && this.game.data;
    if (data) Sound.play(data, name);
  }

  /** Lua: CardFlip.lua:389 */
  coins(): number {
    return CoinCase.coins(this.save);
  }

  /** Lua: CardFlip.lua:397 -- .AskPlayWithThree. */
  enterAsk(): void {
    this.phase = "ask";
    this.choice = 1;
    this.lines = CardFlip.TEXTS.playWithThree;
  }

  /** Lua: CardFlip.lua:403 -- .DeductCoins: "at least three coins". */
  deduct(): void {
    if (this.coins() < CardFlip.BET) {
      this.phase = "message";
      this.lines = CardFlip.TEXTS.notEnough;
      this.after = () => this.quit();
      return;
    }
    CoinCase.takeCoins(this.save, CardFlip.BET);
    this.sfx(SFX_TRANSACTION);
    this.enterChoose();
  }

  /** Lua: CardFlip.lua:417 */
  enterChoose(): void {
    this.phase = "choose";
    this.which = 0; // wCardFlipWhichCard
    this.faceUp = null;
    this.lines = CardFlip.TEXTS.chooseACard;
  }

  /** Lua: CardFlip.lua:424 */
  enterBet(): void {
    this.phase = "bet";
    this.lines = CardFlip.TEXTS.placeYourBet;
  }

  /** Lua: CardFlip.lua:430 -- .CheckTheCard. */
  flip(): void {
    const card = CardFlip.dealt(this.deck, this.played, this.which);
    this.faceUp = card;
    this.discarded[card] = true;
    const won = CardFlip.payout(this.cursorX, this.cursorY, card);
    this.payoutLeft = won;
    this.payoutTick = 0;
    this.phase = "flipping";
    this.flipTimer = 0;
    this.targetCard = card;
  }

  /** Lua: CardFlip.lua:442 */
  updateFlipping(): void {
    this.flipTimer = (this.flipTimer || 0) + 1;
    if (this.flipTimer === 4) {
      this.sfx(SFX_CHOOSE);
    } else if (this.flipTimer >= 12) {
      if ((this.payoutLeft || 0) > 0) {
        this.phase = "payout";
        this.lines = CardFlip.TEXTS.yeah;
        this.sfx(SFX_WIN);
      } else {
        this.phase = "result";
        this.lines = CardFlip.TEXTS.darn;
        this.sfx(SFX_WRONG);
      }
    }
  }

  /** Lua: CardFlip.lua:459 -- .TabulateTheResult. */
  tabulate(): void {
    const won = CardFlip.payout(this.cursorX, this.cursorY, this.faceUp);
    this.payoutLeft = won;
    this.payoutTick = 0;
    if (won > 0) {
      this.phase = "payout";
      this.lines = CardFlip.TEXTS.yeah;
      this.sfx(SFX_WIN);
    } else {
      this.phase = "result";
      this.lines = CardFlip.TEXTS.darn;
      this.sfx(SFX_WRONG);
    }
  }

  /**
   * Lua: CardFlip.lua:476 -- .Payout: one coin every two frames, the case
   * checked BEFORE each increment so a full case swallows the rest.
   */
  updatePayout(): void {
    this.payoutTick = this.payoutTick + 1;
    if (this.payoutTick % 2 === 1) return;
    if (this.payoutLeft <= 0) {
      this.phase = "result";
      return;
    }
    this.payoutLeft = this.payoutLeft - 1;
    if (this.coins() < CoinCase.MAX_COINS) {
      CoinCase.giveCoins(this.save, 1);
      this.sfx(SFX_PAY_DAY);
    }
  }

  /** Lua: CardFlip.lua:492 -- .PlayAgain. */
  enterAgain(): void {
    this.phase = "again";
    this.choice = 1;
    this.lines = CardFlip.TEXTS.playAgain;
  }

  /** Lua: CardFlip.lua:498 -- .Continue: only a twelfth hand reshuffles. */
  continue(): void {
    this.played = this.played + 1;
    if (this.played >= CardFlip.HANDS_PER_DECK) {
      this.played = 0;
      this.deck = CardFlip.shuffle(this.random);
      this.discarded = {};
      this.phase = "message";
      this.lines = CardFlip.TEXTS.shuffled;
      this.after = () => this.deduct();
      return;
    }
    this.deduct();
  }

  /** Lua: CardFlip.lua:512 */
  quit(): void {
    this.phase = "quit";
    this.sfx(SFX_QUIT);
    const data = this.game && this.game.data;
    if (data) Music.restoreMap(data);
    if (this.onClose) this.onClose();
  }

  /** Lua: CardFlip.lua:520 -- fixed 60Hz ticks off a dt accumulator. */
  update(dt?: number): void {
    if (dt && dt > 0) {
      this.dtAccum = (this.dtAccum || 0) + dt;
      const TICK = 1 / 60;
      while (this.dtAccum >= TICK) {
        this.dtAccum = this.dtAccum - TICK;
        this.tick();
      }
    } else {
      this.tick();
    }
  }

  /** Lua: CardFlip.lua:534 */
  tick(): void {
    const input = this.game && this.game.input;
    if (!input) return;
    const phase = this.phase;

    if (phase === "ask" || phase === "again") {
      if (input.wasPressed("up") || input.wasPressed("down")) {
        this.choice = this.choice === 1 ? 2 : 1;
        return;
      }
      // YesNoBox's carry: B leaves either way.
      if (input.wasPressed("b")) {
        this.quit();
        return;
      }
      if (input.wasPressed("a")) {
        if (this.choice !== 1) this.quit();
        else if (phase === "ask") this.deduct();
        else this.continue();
      }
      return;
    }

    if (phase === "message") {
      if (input.wasPressed("a") || input.wasPressed("b")) {
        const after = this.after;
        this.after = null;
        if (after) after();
      }
      return;
    }

    // .ChooseACard: the highlight alternates on its own; A locks the lit one.
    if (phase === "choose") {
      if (input.wasPressed("a")) {
        this.sfx(SFX_START);
        this.enterBet();
        return;
      }
      this.blink = (this.blink || 0) + 1;
      if (this.blink >= 4) {
        this.blink = 0;
        this.which = this.which === 0 ? 1 : 0;
        this.sfx(SFX_KINESIS);
      }
      return;
    }

    if (phase === "bet") {
      for (const dir of ["left", "right", "up", "down"]) {
        if (input.wasPressed(dir)) {
          const [x, y] = CardFlip.moveCursor(this.cursorX, this.cursorY, dir);
          if (x !== this.cursorX || y !== this.cursorY) this.sfx(SFX_MOVE);
          this.cursorX = x;
          this.cursorY = y;
          return;
        }
      }
      if (input.wasPressed("a")) this.flip();
      return;
    }

    if (phase === "flipping") {
      this.updateFlipping();
      return;
    }

    if (phase === "payout") {
      this.updatePayout();
      return;
    }

    if (phase === "result") {
      // WaitPressAorB_BlinkCursor.
      if (input.wasPressed("a") || input.wasPressed("b")) this.enterAgain();
    }
  }

  /** Lua: CardFlip.lua:657 */
  sheets(): [TileSheet, TileSheet, TileSheet, TileSheet, TileSheet] {
    if (this.sheet1 == null) {
      this.sheet1 = TileSheet.new({ path: "assets/generated/card_flip/card_flip_1.png", wide: 16, firstTile: 0 });
      this.sheet2 = TileSheet.new({ path: "assets/generated/card_flip/card_flip_2.png", wide: 3, firstTile: 0 });
      this.sheet3 = TileSheet.new({ path: "assets/generated/card_flip/card_flip_3.png", wide: 1, firstTile: 0 });
      this.sheetOn = TileSheet.new({ path: "assets/generated/card_flip/on.png", wide: 1, firstTile: 0 });
      this.sheetOff = TileSheet.new({ path: "assets/generated/card_flip/off.png", wide: 1, firstTile: 0 });
    }
    return [this.sheet1, this.sheet2!, this.sheet3!, this.sheetOn!, this.sheetOff!];
  }

  /** Lua: CardFlip.lua:668 */
  cursorQuads(): [LcdImage | null | undefined, Quad | undefined, Quad | undefined, Quad | undefined] {
    if (this.s3Image === undefined) {
      const [, , s3] = this.sheets();
      this.s3Image = s3.image() ?? null;
      if (this.s3Image) {
        this.quadCorner = G.newQuad(0, 0, 8, 8, 8, 56); // Tile 0: corner
        this.quadVEdge = G.newQuad(0, 8, 8, 8, 8, 56); // Tile 1: vertical edge
        this.quadHEdge = G.newQuad(0, 16, 8, 8, 8, 56); // Tile 2: horizontal edge
      }
    }
    return [this.s3Image, this.quadCorner, this.quadVEdge, this.quadHEdge];
  }

  /**
   * Lua: CardFlip.lua:699 -- the red OAM cursor frame. The Lua multiplies
   * the tiles over the board so white passes through; here they are objects
   * in OBJ palette 0, whose colour 0 the hardware leaves transparent.
   */
  drawOamBox(px: number, py: number, w: number, h: number): void {
    const [img, qCorner, qVEdge, qHEdge] = this.cursorQuads();
    if (!(img && qCorner && qVEdge && qHEdge)) {
      // Fallback: plain 1px red outline
      G.setColor(248 / 255, 56 / 255, 40 / 255, 1);
      G.rectangle("fill", px, py, w, 1);
      G.rectangle("fill", px, py + h - 1, w, 1);
      G.rectangle("fill", px, py, 1, h);
      G.rectangle("fill", px + w - 1, py, 1, h);
      G.setColor(1, 1, 1, 1);
      return;
    }
    const objects = G.objects;
    G.objects = true;
    GbcPalette.withRaw(CARDFLIP_PALS.obj[0], () => {
      // 4 corners
      G.draw(img, qCorner, px, py, 0, 1, 1);
      G.draw(img, qCorner, px + w, py, 0, -1, 1);
      G.draw(img, qCorner, px, py + h, 0, 1, -1);
      G.draw(img, qCorner, px + w, py + h, 0, -1, -1);
      // top & bottom edges
      if (w > 16) {
        for (let x = px + 8; x <= px + w - 16; x += 8) {
          G.draw(img, qHEdge, x, py, 0, 1, 1);
          G.draw(img, qHEdge, x, py + h, 0, 1, -1);
        }
      }
      // left & right edges
      if (h > 16) {
        for (let y = py + 8; y <= py + h - 16; y += 8) {
          G.draw(img, qVEdge, px, y, 0, 1, 1);
          G.draw(img, qVEdge, px + w, y, 0, -1, 1);
        }
      }
    });
    G.objects = objects;
    G.setColor(1, 1, 1, 1);
  }

  /** Lua: CardFlip.lua:745 */
  drawBoard(): void {
    const [s1, s2, , sOn, sOff] = this.sheets();
    const tm = getCardFlipTilemap();

    // Green background fill
    G.setColor(49 / 255, 156 / 255, 66 / 255, 1);
    G.rectangle("fill", 0, 0, 160, 144);

    if (!tm || !s2.available()) {
      // Fallback simple board
      for (let row = 0; row < CardFlip.HANDS_PER_DECK; row++) {
        Chrome.print(row === this.played ? "o" : ".", LIGHT_X, row);
      }
      for (let x = 2; x <= 5; x++) {
        Chrome.print(CardFlip.MON_LABELS[x - 2]!, MON_COL[x]!, MON_ROW);
        if (x % 2 === 0) Chrome.print("6", MON_COL[x]! + 1, MON_PAIR_ROW);
      }
      for (let y = 2; y <= 7; y++) {
        const pair = Math.floor((y - 2) / 2);
        const isBottom = (y - 2) % 2 === 1;
        const row = 3 + pair * 3 + (isBottom ? 1 : 0);
        Chrome.print(String(y - 1), LEVEL_COL, row);
        if (y % 2 === 0) Chrome.print("9", LEVEL_PAIR_COL, row);
        for (let x = 2; x <= 5; x++) {
          const card = CardFlip.card(y - 2, x - 2);
          Chrome.print(this.discarded[card] ? " " : "?", MON_COL[x]!, row);
        }
      }
      return;
    }

    // The 11x12 board tilemap at (9, 0)
    for (let ty = 0; ty <= 11; ty++) {
      for (let tx = 0; tx <= 10; tx++) {
        const tileId = tm[ty * 11 + tx] ?? 0;
        const screenX = 9 + tx;
        const screenY = ty;
        // Attribute palette
        let pal = 0;
        if (screenY >= 1 && screenY <= 2) {
          if (screenX === 12 || screenX === 13) pal = 1; // Pikachu
          else if (screenX === 14 || screenX === 15) pal = 2; // Jigglypuff
          else if (screenX === 16 || screenX === 17) pal = 3; // Poliwag
          else if (screenX === 18 || screenX === 19) pal = 4; // Oddish
        } else if (screenX === 9) {
          pal = 1; // Lights
        }
        const colors = CARDFLIP_PALS.bg[pal];
        s1.palette = colors;
        s2.palette = colors;
        if (screenX === 9) {
          // Column 9: the hand lights
          if (screenY === this.played) {
            sOn.palette = colors;
            sOn.draw(0, screenX, screenY);
          } else {
            sOff.palette = colors;
            sOff.draw(0, screenX, screenY);
          }
        } else if (tileId >= 0x3e) {
          // card_flip_2, through the 2x2 header tile mapping
          const mappedId = HEADER_TILE_MAP[tileId] ?? tileId - 0x3e;
          s2.draw(mappedId, screenX, screenY);
        } else {
          s1.draw(tileId, screenX, screenY);
        }
      }
    }

    // Discarded card covers (each stacked card cell is 16x12 px)
    for (let y = 2; y <= 7; y++) {
      const level = y - 2;
      const pair = Math.floor(level / 2);
      const isBottom = level % 2 === 1;
      const py = 24 + pair * 24 + (isBottom ? 12 : 0);
      for (let x = 2; x <= 5; x++) {
        const card = CardFlip.card(level, x - 2);
        if (this.discarded[card]) {
          G.setColor(49 / 255, 156 / 255, 66 / 255, 1);
          fillExact(MON_COL[x]! * 8, py, 16, 12);
        }
      }
    }
  }

  /** Lua: CardFlip.lua:840 */
  cursorBounds(): [number, number, number, number] {
    const x = this.cursorX;
    const y = this.cursorY;
    if (y === 0) {
      // Pokemon pair: 32x8
      return [(MON_COL[x] ?? 12) * 8, MON_PAIR_ROW * 8, 32, 8];
    } else if (y === 1) {
      // Single Pokemon: 16x16
      return [(MON_COL[x] ?? 12) * 8, MON_ROW * 8, 16, 16];
    } else if (x === 0) {
      // Level pair: 8x24
      const pair = Math.floor((y - 2) / 2);
      return [LEVEL_PAIR_COL * 8, 24 + pair * 24, 8, 24];
    } else if (x === 1) {
      // Single level: 8x12
      const pair = Math.floor((y - 2) / 2);
      const isBottom = (y - 2) % 2 === 1;
      return [LEVEL_COL * 8, 24 + pair * 24 + (isBottom ? 12 : 0), 8, 12];
    }
    // Exact card: 16x12
    const pair = Math.floor((y - 2) / 2);
    const isBottom = (y - 2) % 2 === 1;
    return [(MON_COL[x] ?? 12) * 8, 24 + pair * 24 + (isBottom ? 12 : 0), 16, 12];
  }

  /** Lua: CardFlip.lua:901 -- face-down, flipping, or face-up card at (2,0) or (2,6). */
  drawCards(): void {
    const [s1, s2] = this.sheets();
    for (let slot = 1; slot <= 2; slot++) {
      const box = CARD_BOX[slot - 1]!;
      const bx = box.x * 8;
      const by = box.y * 8;
      const chosen = slot - 1 === this.which;
      const isFlipping = this.phase === "flipping" && chosen;
      const isFaceUp = this.faceUp != null && chosen;

      if (isFaceUp || (isFlipping && (this.flipTimer || 0) >= 4)) {
        const activeCard = this.faceUp ?? this.targetCard ?? 0;
        const lvl = CardFlip.level(activeCard) + 1;
        const mon = CardFlip.mon(activeCard);
        const monPal = CARDFLIP_PALS.bg[mon + 1] || CARDFLIP_PALS.bg[1];
        s1.palette = CARDFLIP_PALS.bg[0];
        for (let cy = 1; cy <= 6; cy++) {
          for (let cx = 1; cx <= 5; cx++) s1.draw(FACE_UP_TILES[cy - 1]![cx - 1]!, box.x + cx - 1, box.y + cy - 1);
        }
        // Level digit at (box.x + 3, box.y + 1)
        if (isFaceUp || (isFlipping && (this.flipTimer || 0) >= 8)) {
          Chrome.print(String(lvl), box.x + 3, box.y + 1);
          // the 3x3 pic from card_flip_2 at (box.x + 1, box.y + 2)
          s2.palette = monPal;
          const anchor = MON_ANCHORS[mon] ?? 24;
          for (let py = 0; py <= 2; py++) {
            for (let px = 0; px <= 2; px++) s2.draw(anchor + py * 3 + px, box.x + 1 + px, box.y + 2 + py);
          }
        }
      } else {
        s1.palette = CARDFLIP_PALS.bg[0];
        for (let cy = 1; cy <= 6; cy++) {
          for (let cx = 1; cx <= 5; cx++) s1.draw(FACE_DOWN_TILES[cy - 1]![cx - 1]!, box.x + cx - 1, box.y + cy - 1);
        }
        if (this.phase === "choose" && chosen) {
          // the OAM red selection box around the 5x6 card (40x48 px)
          this.drawOamBox(bx, by, 40, 48);
        }
      }
    }
  }

  /** Lua: CardFlip.lua:956 */
  drawPanel(): void {
    this.drawBoard();
    this.drawCards();

    // Message box at (0, 12), interior 8x4
    if (this.lines) {
      Chrome.textbox(TEXT_BOX_X, TEXT_BOX_Y, 8, 4);
      localizedLines(this.lines as Lines).forEach((line, i) => Chrome.print(line, TEXT_X, TEXT_Y + i * TEXT_LINE));
    }

    // Coin box at (9, 15), interior 9x1
    Chrome.textbox(COIN_BOX_X, COIN_BOX_Y, 9, 1);
    Chrome.print(Strings.get("COIN"), COIN_LABEL_X, COIN_LABEL_Y);
    Chrome.print(Chrome.number(this.coins(), 4, true), COIN_VALUE_X, COIN_VALUE_Y);

    if (this.phase === "bet") {
      this.betBlink = (this.betBlink || 0) + 1;
      if (this.betBlink % 32 < 24) {
        const [px, py, w, h] = this.cursorBounds();
        this.drawOamBox(px, py, w, h);
      }
    }

    if (this.phase === "ask" || this.phase === "again") {
      // YesNoBox: a 6x5 box at (14,7), YES at (16,8), NO at (16,10).
      Chrome.textbox(14, 7, 4, 3);
      Chrome.print(Strings.get("YES"), 16, 8);
      Chrome.print(Strings.get("NO"), 16, 10);
      Chrome.cursor(15, 8 + (this.choice - 1) * 2);
    }
  }

  /** Lua: CardFlip.lua:990 */
  draw(): void {
    this.drawPanel();
  }

  /** Lua: CardFlip.lua:994 */
  drawWidescreen(winW: number, winH: number): void {
    Chrome.letterbox(winW, winH, 1, 1, 1);
    const scale = Chrome.fitScale();
    G.push();
    const [ox, oy] = Chrome.fitOrigin();
    G.translate(ox, oy);
    G.scale(scale, scale);
    this.drawPanel();
    G.pop();
  }
}

export default CardFlip;
