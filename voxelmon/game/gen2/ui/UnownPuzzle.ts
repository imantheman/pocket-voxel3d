// gen1recomp src/ui/gen2/UnownPuzzle.lua (bdfac727, MIT): the Ruins of Alph
// sliding-panel puzzle (engine/games/unown_puzzle.asm _UnownPuzzle), opened
// by `special UnownPuzzle` from each chamber's `bg_event BGEVENT_UP` wall.
//
// Sixteen panels of a picture start on the OUTER ring of a 6x6 board and the
// interior 4x4 is empty; A picks a panel up, A puts it down on an empty cell,
// and the puzzle is solved when the interior holds panels 1..16 in reading
// order. START quits at any time. The `setval UNOWNPUZZLE_*` in front of the
// special picks which of the four pictures is being assembled (Kabuto,
// Omanyte, Aerodactyl, Ho-Oh), and `wSolvedUnownPuzzle` comes back out in
// wScriptVar so the chamber's `iftrue` can drop the floor.
//
// The board is a TILEMAP, so every coordinate below is the hlcoord the ASM
// writes:
//
//   hlcoord 0, 0 + SCREEN_AREA  filled with PUZZLE_BORDER ($ee)
//   hlcoord 4, 3, lb bc 12, 12  filled with PUZZLE_VOID ($ef) -- the interior
//   UnownPuzzleCoordData        cell i sits at (1 + 3*(i%6), 3*(i/6))
//   PlaceStartCancelBoxBorder   the box at rows 15-17, columns 4-15
//   PlaceStartCancelBox         $f6..$ff, the ten caption tiles, at (5,16)
//
// The cursor is an OBJ, four tiles mirrored into a 3x3 bracket, and it
// BLINKS: 16 frames on and 16 off -- except while a panel is held, when the
// panel itself rides the cursor (also OAM) and is drawn every frame.

import G from "../platform/screen.ts";
import { random as luaRandom } from "../platform/rng.ts";
import { Assets } from "../shared/render/Assets.ts";
import { GbcPalette } from "../shared/render/GbcPalette.ts";
import { Sound } from "../shared/core/Sound.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Chrome } from "./Chrome.ts";
import { TileSheet } from "./TileSheet.ts";
import type { LcdImage } from "../platform/screen.ts";

type Colors = readonly (readonly number[])[];
type Direction = "up" | "down" | "left" | "right";

export interface UnownPuzzleOpts {
  puzzle?: number;
  save?: any;
  random?: (n: number) => number;
  onClose?: (solved: boolean) => void;
}

// Lua: UnownPuzzle.lua:79 -- `DEF puzcoord EQUS "* 6 +"`.
function puzcoord(row: number, col: number): number {
  return row * 6 + col;
}

// SFX_*, in pokegold's own labels. Lua: UnownPuzzle.lua:106
const SFX_MOVE_CURSOR = "Sfx_Pound";
const SFX_MOVE_PIECE = "Sfx_MovePuzzlePiece";
const SFX_PICK_UP = "Sfx_MegaKick";
const SFX_PUT_DOWN = "Sfx_PlacePuzzlePieceDown";
const SFX_WRONG = "Sfx_Wrong";
const SFX_SOLVED = "Sfx_1stPlace";

// JoyTextDelay's 15-then-5 repeat. Lua: UnownPuzzle.lua:115
const REPEAT_DELAY = 15;
const REPEAT_RATE = 5;

// Lua: UnownPuzzle.lua:133
const DEAL_RETRIES = 512;

const DIRECTIONS: Direction[] = ["up", "down", "left", "right"];

// Lua: UnownPuzzle.lua:399
const BOX_X = 4;
const BOX_Y = 15;
const BOX_RIGHT = 15;
const CAPTION_X = 5;
const CAPTION_Y = 16;
const CAPTION_TILES = 10;
const CAPTION_FIRST = 0xf6;
const BOX_TOP_LEFT = 0xf0;
const BOX_TOP = 0xf1;
const BOX_TOP_RIGHT = 0xf2;
const BOX_SIDE = 0xf3;
const BOX_BOTTOM_LEFT = 0xf4;
const BOX_BOTTOM_RIGHT = 0xf5;

// Lua: UnownPuzzle.lua:414 -- the whole screen wears PREDEFPAL_UNOWN_PUZZLE.
function paletteColor(colors: Colors, index: number): [number, number, number] {
  const c = GbcPalette.color(colors, index);
  return [(c[0] ?? 0) / 255, (c[1] ?? 0) / 255, (c[2] ?? 0) / 255];
}

// Lua: UnownPuzzle.lua:476 -- .OAM_NotHoldingPiece: {col, tile, row, flipX, flipY}.
const CURSOR_CELLS: [number, number, number, boolean, boolean][] = [
  [0, 0, 0, false, false], [1, 1, 0, false, false],
  [2, 0, 0, true, false],
  [0, 0, 1, false, false], [1, 3, 1, false, false],
  [2, 0, 1, true, false],
  [0, 0, 2, false, true], [1, 1, 2, false, true],
  [2, 0, 2, true, true],
];

export class UnownPuzzle {
  // Lua: UnownPuzzle.lua:47
  static isOpaque = true;
  isOpaque = true;

  // Lua: UnownPuzzle.lua:50
  static BORDER_TILE = 0xee;
  static VOID_TILE = 0xef;

  // Lua: UnownPuzzle.lua:58 -- PREDEFPAL_UNOWN_PUZZLE.
  static PALETTE: Colors = [
    [255, 255, 255], [197, 165, 90], [148, 107, 90], [0, 0, 0],
  ];
  // Lua: UnownPuzzle.lua:65 -- OBJ colour 0 forced to red, reordered 0,1,2,0.
  static CURSOR_PALETTE: Colors = [
    [255, 0, 0], [197, 165, 90], [148, 107, 90], [255, 0, 0],
  ];

  // Lua: UnownPuzzle.lua:69
  static COLUMNS = 6;
  static ROWS = 6;
  static CELLS = 36;
  static PIECES = 16;
  static PIECE_TILES = 3;
  static PIECES_WIDE = 4;

  static puzcoord = puzcoord;

  // Lua: UnownPuzzle.lua:84 -- .PuzzlePieceInitialPositions.
  static START_CELLS: number[] = (() => {
    const out: number[] = [];
    for (let col = 0; col <= 5; col++) out.push(puzcoord(0, col));
    for (let row = 1; row <= 5; row++) {
      out.push(puzcoord(row, 0));
      out.push(puzcoord(row, 5));
    }
    return out;
  })();

  // Lua: UnownPuzzle.lua:96 -- .SolvedPuzzleConfiguration.
  static SOLVED: number[] = [
    0, 0, 0, 0, 0, 0,
    0, 1, 2, 3, 4, 0,
    0, 5, 6, 7, 8, 0,
    0, 9, 10, 11, 12, 0,
    0, 13, 14, 15, 16, 0,
    0, 0, 0, 0, 0, 0,
  ];

  // Lua: UnownPuzzle.lua:121
  static CAPTION = Strings.source("START>CANCEL");

  game: any;
  onClose?: (solved: boolean) => void;
  puzzle: number;
  random: (n: number) => number;
  /** 0-based cell -> piece (0 = empty). The Lua's pieces[cell + 1]. */
  pieces: number[];
  cursor: number;
  holding: boolean;
  held: number;
  solved: boolean;
  frame: number;
  repeatLeft: number;
  lastDirection: Direction | null;
  waiting: boolean;
  closed?: boolean;
  palette: Colors = UnownPuzzle.PALETTE;
  cursorPalette: Colors = UnownPuzzle.CURSOR_PALETTE;
  chrome?: TileSheet;
  picture?: LcdImage;
  cursorSheet?: LcdImage;
  [key: string]: any;

  /**
   * Lua: UnownPuzzle.lua:135 -- InitUnownPuzzlePiecePositions: `call Random /
   * and $f` into the initial-position list, rerolling while taken (capped).
   */
  static deal(random: (n: number) => number): number[] {
    const pieces: number[] = [];
    for (let cell = 0; cell < UnownPuzzle.CELLS; cell++) pieces[cell] = 0;
    for (let piece = 1; piece <= UnownPuzzle.PIECES; piece++) {
      let cell = 0;
      let tries = 0;
      do {
        cell = UnownPuzzle.START_CELLS[random(16)]!;
        tries++;
      } while (!(pieces[cell] === 0 || tries >= DEAL_RETRIES));
      if (pieces[cell] !== 0) {
        for (const candidate of UnownPuzzle.START_CELLS) {
          if (pieces[candidate] === 0) {
            cell = candidate;
            break;
          }
        }
      }
      pieces[cell] = piece;
    }
    return pieces;
  }

  /** Lua: UnownPuzzle.lua:159 -- CheckSolvedUnownPuzzle. */
  static isSolved(pieces: number[]): boolean {
    for (let cell = 0; cell < UnownPuzzle.CELLS; cell++) {
      if ((pieces[cell] ?? 0) !== UnownPuzzle.SOLVED[cell]) return false;
    }
    return true;
  }

  /**
   * Lua: UnownPuzzle.lua:174 -- .d_up / .d_down / .d_left / .d_right, each a
   * list of refusals. Returns the new position, or null when refused.
   */
  static moveCursor(position: number | null | undefined, direction: string): number | null {
    const pos = position ?? 0;
    if (direction === "up") {
      if (pos < puzcoord(1, 0)) return null;
      return pos - UnownPuzzle.COLUMNS;
    } else if (direction === "down") {
      for (let col = 1; col <= 4; col++) {
        if (pos === puzcoord(4, col)) return null;
      }
      if (pos >= puzcoord(5, 0)) return null;
      return pos + UnownPuzzle.COLUMNS;
    } else if (direction === "left") {
      if (pos === 0) return null;
      for (let row = 1; row <= 5; row++) {
        if (pos === puzcoord(row, 0)) return null;
      }
      if (pos === puzcoord(5, 5)) return puzcoord(5, 0);
      return pos - 1;
    } else if (direction === "right") {
      for (let row = 0; row <= 5; row++) {
        if (pos === puzcoord(row, 5)) return null;
      }
      if (pos === puzcoord(5, 0)) return puzcoord(5, 5);
      return pos + 1;
    }
    return null;
  }

  /** Lua: UnownPuzzle.lua:204 -- UnownPuzzleCoordData's dwcoord. */
  static cellTile(cell: number): [number, number] {
    const row = Math.floor(cell / UnownPuzzle.COLUMNS);
    const col = cell % UnownPuzzle.COLUMNS;
    return [1 + col * UnownPuzzle.PIECE_TILES, row * UnownPuzzle.PIECE_TILES];
  }

  /** Lua: UnownPuzzle.lua:212 -- the vacant tile column. */
  static vacantTile(cell: number): number {
    const row = Math.floor(cell / UnownPuzzle.COLUMNS);
    const col = cell % UnownPuzzle.COLUMNS;
    if (row >= 1 && row <= 4 && col >= 1 && col <= 4) return UnownPuzzle.VOID_TILE;
    return UnownPuzzle.BORDER_TILE;
  }

  /** Lua: UnownPuzzle.lua:225 -- opts: puzzle, save, random(n) -> 0..n-1, onClose(solved). */
  static new(game: any, opts?: UnownPuzzleOpts): UnownPuzzle {
    return new UnownPuzzle(game, opts ?? {});
  }

  constructor(game: any, opts: UnownPuzzleOpts) {
    this.game = game;
    this.onClose = opts.onClose;
    this.puzzle = opts.puzzle ?? 0;
    this.random = opts.random ?? ((n: number) => luaRandom(n) - 1);
    // ByteFill over the Miscellaneous block: a clean board, cursor at 0.
    this.pieces = UnownPuzzle.deal(this.random);
    this.cursor = 0;
    this.holding = false;
    this.held = 0;
    this.solved = false;
    this.frame = 0;
    this.repeatLeft = 0;
    this.lastDirection = null;
    this.waiting = false;
    this.loadGfx();
  }

  /** Lua: UnownPuzzle.lua:254 */
  gfx(): any {
    const data = this.game && this.game.data;
    const menu = data && data.gen2MenuGfx;
    return (menu && menu.unownPuzzle) || null;
  }

  /** Lua: UnownPuzzle.lua:260 */
  loadGfx(): void {
    const gfx = this.gfx();
    this.palette = (gfx && gfx.palette) || UnownPuzzle.PALETTE;
    this.cursorPalette = (gfx && gfx.cursorPalette) || UnownPuzzle.CURSOR_PALETTE;
    if (!gfx) return;
    this.chrome = TileSheet.new({
      path: gfx.chrome,
      wide: gfx.chromeTiles || 19,
      firstTile: gfx.chromeFirstTile || 0xed,
      palette: this.palette,
    });
    const path = gfx.pictures && gfx.pictures[((this.puzzle % 4) + 4) % 4];
    if (path) {
      try {
        const image = Assets.image(path);
        if (image) this.picture = image;
      } catch {
        // pcall
      }
    }
    if (gfx.cursor) {
      try {
        const image = Assets.image(gfx.cursor);
        if (image) this.cursorSheet = image;
      } catch {
        // pcall
      }
    }
  }

  /** Lua: UnownPuzzle.lua:289 -- WaitPlaySFX (home/audio.asm:220). */
  sfx(name: string): void {
    const data = this.game && this.game.data;
    Sound.waitSfxDone();
    if (data) Sound.play(data, name);
  }

  /** Lua: UnownPuzzle.lua:296 -- UnownPuzzle_CheckCurrentTileOccupancy. */
  occupant(cell?: number): number {
    return this.pieces[cell ?? this.cursor] ?? 0;
  }

  /** Lua: UnownPuzzle.lua:303 -- UnownPuzzle_A. */
  pressA(): void {
    if (!this.holding) {
      const piece = this.occupant();
      if (piece === 0) {
        this.sfx(SFX_WRONG);
        return;
      }
      this.sfx(SFX_PICK_UP);
      this.pieces[this.cursor] = 0;
      this.held = piece;
      this.holding = true;
      return;
    }
    if (this.occupant() !== 0) {
      this.sfx(SFX_WRONG);
      return;
    }
    this.sfx(SFX_PUT_DOWN);
    this.pieces[this.cursor] = this.held;
    this.held = 0;
    this.holding = false;
    if (!UnownPuzzle.isSolved(this.pieces)) return;
    // The solve: caption blanked, cursor cleared, hold on the fanfare.
    this.solved = true;
    this.waiting = true;
    this.sfx(SFX_SOLVED);
  }

  /** Lua: UnownPuzzle.lua:333 */
  quit(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.onClose) this.onClose(this.solved);
  }

  /** Lua: UnownPuzzle.lua:341 -- .done_joypad. */
  step(direction: Direction): boolean {
    const target = UnownPuzzle.moveCursor(this.cursor, direction);
    if (target == null) return false;
    this.cursor = target;
    this.sfx(this.holding ? SFX_MOVE_PIECE : SFX_MOVE_CURSOR);
    return true;
  }

  /** Lua: UnownPuzzle.lua:351 */
  update(_dt?: number): void {
    this.frame = this.frame + 1;
    const input = this.game && this.game.input;
    if (!input) return;
    if (this.waiting) {
      // SimpleWaitPressAorB, then UnownPuzzle_Quit with wSolvedUnownPuzzle set.
      if (input.wasPressed("a") || input.wasPressed("b")) this.quit();
      return;
    }
    if (input.wasPressed("start")) {
      this.quit();
      return;
    }
    if (input.wasPressed("a")) {
      this.pressA();
      return;
    }
    let held: Direction | null = null;
    for (const direction of DIRECTIONS) {
      if (input.wasPressed(direction)) {
        held = direction;
        this.lastDirection = direction;
        this.repeatLeft = REPEAT_DELAY;
        this.step(direction);
        return;
      }
    }
    for (const direction of DIRECTIONS) {
      if (input.isDown && input.isDown(direction)) held = held ?? direction;
    }
    if (held !== this.lastDirection) {
      this.lastDirection = held;
      this.repeatLeft = REPEAT_DELAY;
      return;
    }
    if (!held) return;
    this.repeatLeft = this.repeatLeft - 1;
    if (this.repeatLeft > 0) return;
    this.repeatLeft = REPEAT_RATE;
    this.step(held);
  }

  /** Lua: UnownPuzzle.lua:419 */
  drawTile(tile: number, tx: number, ty: number): boolean {
    if (this.chrome && this.chrome.draw(tile, tx, ty)) return true;
    if (tile === UnownPuzzle.VOID_TILE) G.setColor(...paletteColor(this.palette, 1));
    else G.setColor(...paletteColor(this.palette, 3));
    G.rectangle("fill", tx * 8, ty * 8, 8, 8);
    G.setColor(0, 0, 0, 1);
    return false;
  }

  /** Lua: UnownPuzzle.lua:432 */
  fillCell(cell: number, tile: number): void {
    const [tx, ty] = UnownPuzzle.cellTile(cell);
    for (let row = 0; row < UnownPuzzle.PIECE_TILES; row++) {
      for (let col = 0; col < UnownPuzzle.PIECE_TILES; col++) this.drawTile(tile, tx + col, ty + row);
    }
  }

  /** Lua: UnownPuzzle.lua:443 -- .Corners: the panel's row and column in the 4x4 picture. */
  drawPiece(piece: number, tx: number, ty: number): void {
    const size = UnownPuzzle.PIECE_TILES * 8;
    const picture = this.picture;
    if (picture) {
      const index = piece - 1;
      const sx = (index % UnownPuzzle.PIECES_WIDE) * size;
      const sy = Math.floor(index / UnownPuzzle.PIECES_WIDE) * size;
      const [w, h] = picture.getDimensions();
      const quad = G.newQuad(sx, sy, size, size, w, h);
      G.setColor(1, 1, 1, 1);
      // Colours 1 and 2 alone: BG palette 0 turns the panels tan and brown.
      const body = (): void => G.draw(picture, quad, tx * 8, ty * 8);
      if (this.palette && GbcPalette.available()) GbcPalette.with(this.palette, body);
      else body();
      G.setColor(0, 0, 0, 1);
      return;
    }
    G.setColor(...paletteColor(this.palette, 2));
    G.rectangle("fill", tx * 8, ty * 8, size, size);
    G.setColor(0, 0, 0, 1);
    G.rectangle("line", tx * 8 + 0.5, ty * 8 + 0.5, size - 1, size - 1);
    Chrome.print(String(piece), tx + 1, ty + 1);
  }

  /** Lua: UnownPuzzle.lua:485 -- the bracket, OBJ palette 0. */
  drawCursor(tx: number, ty: number): void {
    const sheet = this.cursorSheet;
    if (!sheet) {
      G.setColor(...paletteColor(this.cursorPalette, 4));
      G.rectangle("line", tx * 8 + 0.5, ty * 8 + 0.5, 23, 23);
      G.setColor(0, 0, 0, 1);
      return;
    }
    const [w, h] = sheet.getDimensions();
    G.setColor(1, 1, 1, 1);
    const body = (): void => {
      // The bracket is OAM over the board, not cells replacing it.
      const objects = G.objects;
      G.objects = true;
      for (const [col, tile, row, flipX, flipY] of CURSOR_CELLS) {
        const quad = G.newQuad(tile * 8, 0, 8, 8, w, h);
        const sx = flipX ? -1 : 1;
        const sy = flipY ? -1 : 1;
        const ox = (tx + col) * 8 + (flipX ? 8 : 0);
        const oy = (ty + row) * 8 + (flipY ? 8 : 0);
        G.draw(sheet, quad, ox, oy, 0, sx, sy);
      }
      G.objects = objects;
    };
    if (this.cursorPalette && GbcPalette.available()) GbcPalette.with(this.cursorPalette, body);
    else body();
    G.setColor(0, 0, 0, 1);
  }

  /** Lua: UnownPuzzle.lua:516 */
  drawStartCancel(): void {
    this.drawTile(BOX_TOP_LEFT, BOX_X, BOX_Y);
    for (let tx = BOX_X + 1; tx <= BOX_RIGHT - 1; tx++) this.drawTile(BOX_TOP, tx, BOX_Y);
    this.drawTile(BOX_TOP_RIGHT, BOX_RIGHT, BOX_Y);
    this.drawTile(BOX_SIDE, BOX_X, BOX_Y + 1);
    for (let tx = BOX_X + 1; tx <= BOX_RIGHT - 1; tx++) this.drawTile(UnownPuzzle.VOID_TILE, tx, BOX_Y + 1);
    this.drawTile(BOX_SIDE, BOX_RIGHT, BOX_Y + 1);
    this.drawTile(BOX_BOTTOM_LEFT, BOX_X, BOX_Y + 2);
    for (let tx = BOX_X + 1; tx <= BOX_RIGHT - 1; tx++) this.drawTile(BOX_TOP, tx, BOX_Y + 2);
    this.drawTile(BOX_BOTTOM_RIGHT, BOX_RIGHT, BOX_Y + 2);
    // On the solve the border is redrawn without the caption.
    if (this.solved) return;
    let drew = false;
    if (this.chrome) {
      drew = this.chrome.available();
      for (let i = 0; i < CAPTION_TILES; i++) this.chrome.draw(CAPTION_FIRST + i, CAPTION_X + i, CAPTION_Y);
    }
    if (!drew) Chrome.print(Strings.lookup(UnownPuzzle.CAPTION), CAPTION_X, CAPTION_Y);
  }

  /** Lua: UnownPuzzle.lua:542 */
  drawPanel(): void {
    Chrome.clear();
    for (let ty = 0; ty < Chrome.SCREEN_H; ty++) {
      for (let tx = 0; tx < Chrome.SCREEN_W; tx++) this.drawTile(UnownPuzzle.BORDER_TILE, tx, ty);
    }
    for (let cell = 0; cell < UnownPuzzle.CELLS; cell++) {
      const [tx, ty] = UnownPuzzle.cellTile(cell);
      const piece = this.occupant(cell);
      if (piece !== 0) this.drawPiece(piece, tx, ty);
      else this.fillCell(cell, UnownPuzzle.vacantTile(cell));
    }
    this.drawStartCancel();
    if (this.solved) return;
    const [tx, ty] = UnownPuzzle.cellTile(this.cursor);
    if (this.holding) {
      // .OAM_HoldingPiece: the panel rides the cursor, in OAM, every frame.
      if (this.held !== 0) {
        const objects = G.objects;
        G.objects = true;
        this.drawPiece(this.held, tx, ty);
        G.objects = objects;
      }
    } else if (Math.floor(this.frame / 16) % 2 === 0) {
      // `ldh a, [hVBlankCounter] / and $10`: sixteen frames on, sixteen off.
      this.drawCursor(tx, ty);
    }
  }

  /** Lua: UnownPuzzle.lua:570 */
  draw(): void {
    this.drawPanel();
  }

  /** Lua: UnownPuzzle.lua:577 -- ClearBGPalettes / ClearTilemap: the whole screen. */
  drawsWidescreen(): boolean {
    return true;
  }

  /** Lua: UnownPuzzle.lua:579 */
  drawWidescreen(winW: number, winH: number): void {
    Chrome.letterbox(winW, winH, 0, 0, 0);
    const scale = Chrome.fitScale();
    G.push();
    const [ox, oy] = Chrome.fitOrigin();
    G.translate(ox, oy);
    G.scale(scale, scale);
    this.drawPanel();
    G.pop();
  }
}

export default UnownPuzzle;
