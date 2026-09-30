// Ports gen1recomp src/core/gen2/MagnetTrain.lua at bdfac727 (MIT).
//
// The Magnet Train ride (pokegold engine/events/magnet_train.asm).
// `special MagnetTrain` takes the frame loop away from the overworld and runs
// a seven-entry jumptable until JUMPTABLE_EXIT. This file is that routine's
// state (love-free in the Lua too); the screen that draws it is
// ui/MagnetTrainRide.ts.
//
// One 32x18 background and three horizontal SCX bands:
//   scanlines   0-46    wMagnetTrainOffset * 2   bushes, always moving
//   scanlines  47-94    wMagnetTrainPosition     the train body
//   scanlines  95-143   wMagnetTrainOffset * 2   bushes again
// Everything is 8-bit and wraps like the ASM's `add`.
//
// Indexing: the LY table, `bands()`, `tilemap()` rows/columns and
// `playerOam()` are 0-based JS arrays of the Lua's sequences; `bands()` rows
// are [first scanline, last scanline, scx] (the values were already 0-based
// scanlines in the Lua). PAL_BG_* / `paletteSlot` keep the Lua's 1-based
// palette slots (how Palettes indexes a bgSet). `opts.bgTiles` and
// `opts.fgTilemap` are 0-based arrays.

import { mod } from "../platform/lua.ts";

// constants/gfx_constants.asm
const TILE_WIDTH = 8;
const SCREEN_WIDTH = 20;
const SCREEN_HEIGHT = 18;
const TILEMAP_WIDTH = 32;
const SCREEN_HEIGHT_PX = 144;

// SetMagnetTrainPals' four ByteFills: four rows green, ten gray, four more
// green, then six yellow tiles at (7, 8) for the player's window.
const BUSH_ROWS_TOP = 4; // hlbgcoord 0, 0  / bc = 4 * TILEMAP_WIDTH
const TRAIN_ROWS = 10; // hlbgcoord 0, 4  / bc = 10 * TILEMAP_WIDTH
const WINDOW_ROW = 8; // hlbgcoord 7, 8  / bc = 6
const WINDOW_COL = 7;
const WINDOW_WIDTH = 6;

// DrawMagnetTrain lays MagnetTrainTilemap over BG rows 6-9.
const FG_ROW = 6;
const FG_ROWS = 4;

// Lua: MagnetTrain.lua:54 -- every value in this file is a hardware byte.
function b(value: number): number {
  return mod(value, 256);
}

interface FrameEntry {
  oamset: number;
  duration: number;
  xflip: boolean;
}

// Lua: MagnetTrain.lua:66 -- data/sprite_anims/framesets.asm
// .Frameset_MagnetTrainRed: two OAM sets on an eight-frame beat, the fourth
// mirrored, then `oamrestart`. SPRITE_ANIM_FUNC_NULL: the only motion is
// wGlobalAnimXOffset.
const FRAMESET: (FrameEntry | "restart")[] = [
  { oamset: 1, duration: 8, xflip: false },
  { oamset: 2, duration: 8, xflip: false },
  { oamset: 1, duration: 8, xflip: false },
  { oamset: 2, duration: 8, xflip: true },
  "restart",
];

// data/sprite_anims/oam.asm: MAGNET_TRAIN_RED_1/_2 are vtile $00 and $04 over
// the same 2x2 block (ChrisSpriteGFX frame 0 and frame 3). Indexed by oamset
// (1-based in the Lua): OAMSET_VTILE[oamset - 1].
const OAMSET_VTILE = [0x00, 0x04];

// .OAMData_MagnetTrainRed, `dbsprite`. Every entry carries OAM_PRIO (behind
// BG colours 1-3; shows only through the window's colour 0).
const OAM_DATA = [
  { x: b(-1 * TILE_WIDTH), y: b(-1 * TILE_WIDTH), tile: 0x00 },
  { x: b(0 * TILE_WIDTH), y: b(-1 * TILE_WIDTH), tile: 0x01 },
  { x: b(-1 * TILE_WIDTH), y: b(0 * TILE_WIDTH), tile: 0x02 },
  { x: b(0 * TILE_WIDTH), y: b(0 * TILE_WIDTH), tile: 0x03 },
];

// Lua: MagnetTrain.lua:94 -- AddOrSubtractX: a mirrored object flips around its own 8-pixel cell.
function mirror(value: number, flip: boolean): number {
  if (!flip) return value;
  return b(-(value + TILE_WIDTH));
}

export interface MagnetTrainOam {
  x: number;
  y: number;
  tile: number;
  xflip: boolean;
}

export interface MagnetTrainOpts {
  toGoldenrod?: any;
  bgTiles?: any[];
  fgTilemap?: any[];
}

export class MagnetTrain {
  // PAL_BG_* as 1-based palette slots, the way world/Palettes indexes a bgSet.
  static PAL_BG_GRAY = 1;
  static PAL_BG_GREEN = 3;
  static PAL_BG_YELLOW = 5;
  static byte = b;
  static SHEET_FRAME: Record<number, number> = { [0x00]: 0, [0x04]: 3 };

  toGoldenrod = false;
  direction = 1;
  holdPosition = 0;
  initPosition = 0;
  finalPosition = 0;
  playerSpriteInitX = 0;
  index = 0;
  offset = 0;
  position = 0;
  waitCounter = 0;
  exited = false;
  globalX = 0;
  spriteX: number | undefined = undefined;
  spriteY: number | undefined = undefined;
  frame = -1;
  frameDuration = 0;
  oamFrame: FrameEntry | undefined = undefined;
  bgTiles: any[] | undefined = undefined;
  fgTilemap: any[] | undefined = undefined;
  ly: number[] | undefined = undefined;
  scx = 0;

  // Lua: MagnetTrain.lua:110 -- `toGoldenrod` is the wScriptVar the officer
  // left (Goldenrod FALSE, Saffron TRUE; `and a / jr nz, .ToGoldenrod`).
  // opts.bgTiles is MagnetTrainBGTiles (2x18), opts.fgTilemap
  // MagnetTrainTilemap (20x4); either may be missing (tilemap() -> undefined).
  static new(opts?: MagnetTrainOpts): MagnetTrain {
    opts = opts ?? {};
    const self = new MagnetTrain();
    self.toGoldenrod = opts.toGoldenrod != null && opts.toGoldenrod !== false;
    if (self.toGoldenrod) {
      // .ToGoldenrod: `ld a, -1` / `lb bc, -8 tiles, -12 tiles` /
      // `lb de, (11 tiles) + (11 tiles + 4), 12 tiles`.
      self.direction = b(-1);
      self.holdPosition = b(-8 * TILE_WIDTH); // b
      self.initPosition = b(-12 * TILE_WIDTH); // c
      self.finalPosition = b(12 * TILE_WIDTH); // e
      self.playerSpriteInitX = b((11 * TILE_WIDTH) + (11 * TILE_WIDTH + 4)); // d
    } else {
      // forwards: `ld a, 1` / `lb bc, 8 tiles, 12 tiles` /
      // `lb de, (11 tiles) - (11 tiles + 4), -12 tiles`.
      self.direction = 1;
      self.holdPosition = b(8 * TILE_WIDTH);
      self.initPosition = b(12 * TILE_WIDTH);
      self.finalPosition = b(-12 * TILE_WIDTH);
      self.playerSpriteInitX = b((11 * TILE_WIDTH) - (11 * TILE_WIDTH + 4));
    }

    // MagnetTrain_LoadGFX_PlayMusic's tail writes wJumptableIndex and the
    // three bytes after it, so the wait counter starts holding the init
    // position; state 0 overwrites it before any .WaitScene reads it.
    self.index = 0;
    self.offset = self.initPosition;
    self.position = self.initPosition;
    self.waitCounter = self.initPosition;
    self.exited = false;
    self.globalX = 0;

    // The sprite struct does not exist until .InitPlayerSpriteAnim runs.
    self.spriteX = undefined;
    self.spriteY = undefined;
    self.frame = -1;
    self.frameDuration = 0;
    self.oamFrame = undefined;

    self.bgTiles = opts.bgTiles;
    self.fgTilemap = opts.fgTilemap;
    self.updateLYOverrides(true);
    return self;
  }

  // Lua: MagnetTrain.lua:154
  done(): boolean {
    return this.exited;
  }

  // Lua: MagnetTrain.lua:159 -- MagnetTrain's .loop, one pass: exit bit,
  // PlaySpriteAnimations, the jumptable, the LY overrides. Returns the sfx
  // label the frame played (only SFX_TRAIN_ARRIVED, on the last).
  update(): string | undefined {
    if (this.exited) return undefined;
    this.stepSpriteFrame();
    const sfx = this.runJumptable();
    this.updateLYOverrides();
    return sfx;
  }

  // Lua: MagnetTrain.lua:168 -- MagnetTrain_Jumptable.Next
  next(): void {
    this.index = this.index + 1;
  }

  // Lua: MagnetTrain.lua:175 -- .WaitScene: 128 holds for 129 frames.
  waitScene(): void {
    if (this.waitCounter === 0) {
      this.next();
      return;
    }
    this.waitCounter = this.waitCounter - 1;
  }

  // Lua: MagnetTrain.lua:183 -- MagnetTrain_Jumptable
  runJumptable(): string | undefined {
    const index = this.index;
    if (index === 0) {
      // .InitPlayerSpriteAnim: InitSpriteAnimStruct at d = (8 + 2) * 8 + 5,
      // e = wMagnetTrainPlayerSpriteInitX, then SPRITEANIMSTRUCT_TILE_ID = 0.
      this.spriteY = b((8 + 2) * TILE_WIDTH + 5);
      this.spriteX = this.playerSpriteInitX;
      this.frame = -1;
      this.frameDuration = 0;
      this.oamFrame = undefined;
      this.next();
      this.waitCounter = 128;
    } else if (index === 1 || index === 3 || index === 5) {
      this.waitScene();
    } else if (index === 2) {
      // .MoveTrain1: one pixel a frame to the hold position, then park 128.
      if (this.position === this.holdPosition) {
        this.next();
        this.waitCounter = 128;
        return undefined;
      }
      this.position = b(this.position - this.direction);
      this.globalX = b(this.globalX + this.direction);
    } else if (index === 4) {
      // .MoveTrain2: double speed until it leaves the screen.
      if (this.position === this.finalPosition) {
        this.next();
        return undefined;
      }
      this.position = b(this.position - 2 * this.direction);
      this.globalX = b(this.globalX + 2 * this.direction);
    } else if (index >= 6) {
      // .TrainArrived: JUMPTABLE_EXIT and SFX_TRAIN_ARRIVED; the loop reads
      // the exit bit at the top of the next pass.
      this.exited = true;
      return "Sfx_TrainArrived";
    }
    return undefined;
  }

  // Lua: MagnetTrain.lua:230 -- MagnetTrain_UpdateLYOverrides: runs of
  // 6*8-1, 6*8 and 6*8+1 lines (144); hSCX takes the first band's value; the
  // offset advances by two AFTER the write. `initial` is
  // MagnetTrain_InitLYOverrides (fill with the init position, no advance).
  updateLYOverrides(initial?: boolean): number[] {
    const ly = this.ly ?? [];
    if (initial) {
      for (let line = 0; line < SCREEN_HEIGHT_PX; line++) ly[line] = this.initPosition;
      this.ly = ly;
      this.scx = this.initPosition;
      return ly;
    }
    const scx = b(this.offset * 2);
    this.scx = scx;
    let line = 0;
    for (let i = 1; i <= 6 * TILE_WIDTH - 1; i++) { ly[line] = scx; line = line + 1; }
    for (let i = 1; i <= 6 * TILE_WIDTH; i++) { ly[line] = this.position; line = line + 1; }
    for (let i = 1; i <= 6 * TILE_WIDTH + 1; i++) { ly[line] = scx; line = line + 1; }
    this.ly = ly;
    this.offset = b(this.offset + 2 * this.direction);
    return ly;
  }

  // Lua: MagnetTrain.lua:253 -- the SCX bands this frame as
  // [first scanline, last scanline (inclusive), scx].
  bands(): [number, number, number][] {
    const ly = this.ly;
    if (!ly) return [];
    const out: [number, number, number][] = [];
    let start = 0;
    let value = ly[0]!;
    for (let line = 0; line < SCREEN_HEIGHT_PX; line++) {
      if (ly[line] !== value) {
        out.push([start, line - 1, value]);
        start = line;
        value = ly[line]!;
      }
    }
    out.push([start, SCREEN_HEIGHT_PX - 1, value]);
    return out;
  }

  // Lua: MagnetTrain.lua:278 -- DrawMagnetTrain: rows 0-17 are the BG tile
  // pair for that row repeated across 32 columns (`.FillAlt`), then the four
  // 20-tile foreground lines over rows 6-9. undefined without the tilemaps.
  tilemap(): any[][] | undefined {
    const bg = this.bgTiles;
    if (!(bg && bg.length >= SCREEN_HEIGHT * 2)) return undefined;
    const rows: any[][] = [];
    for (let row = 0; row < SCREEN_HEIGHT; row++) {
      const even = bg[row * 2];
      const odd = bg[row * 2 + 1];
      const line: any[] = [];
      for (let col = 0; col < TILEMAP_WIDTH; col++) {
        line[col] = col % 2 === 0 ? even : odd;
      }
      rows[row] = line;
    }
    const fg = this.fgTilemap;
    if (fg && fg.length >= SCREEN_WIDTH * FG_ROWS) {
      for (let line = 0; line < FG_ROWS; line++) {
        const row = rows[FG_ROW + line]!;
        for (let col = 0; col < SCREEN_WIDTH; col++) {
          row[col] = fg[line * SCREEN_WIDTH + col];
        }
      }
    }
    return rows;
  }

  // Lua: MagnetTrain.lua:304 -- SetMagnetTrainPals read back: the (1-based)
  // palette slot of a cell. `col` and `row` are 0-based BG map coordinates.
  static paletteSlot(col: number, row: number): number {
    if (row === WINDOW_ROW && col >= WINDOW_COL && col < WINDOW_COL + WINDOW_WIDTH) {
      return MagnetTrain.PAL_BG_YELLOW;
    }
    if (row < BUSH_ROWS_TOP) return MagnetTrain.PAL_BG_GREEN;
    if (row < BUSH_ROWS_TOP + TRAIN_ROWS) return MagnetTrain.PAL_BG_GRAY;
    return MagnetTrain.PAL_BG_GREEN;
  }

  // Lua: MagnetTrain.lua:321 -- GetSpriteAnimFrame cut down to one frameset:
  // a duration-8 frame shows nine times.
  stepSpriteFrame(): void {
    if (this.spriteX === undefined) return;
    if (this.frameDuration !== 0) {
      this.frameDuration = this.frameDuration - 1;
      return;
    }
    this.frame = this.frame + 1;
    let entry = FRAMESET[this.frame];
    if (entry === "restart") {
      this.frame = 0;
      entry = FRAMESET[0];
    }
    const e = entry as FrameEntry;
    this.frameDuration = e.duration;
    this.oamFrame = e;
  }

  // Lua: MagnetTrain.lua:343 -- the four OAM entries this frame in SCREEN
  // pixels (hardware byte minus the 8/16 origins). `tile` is the vtile
  // (MagnetTrain.SHEET_FRAME maps it to a walking-sheet frame). Empty before
  // .InitPlayerSpriteAnim.
  playerOam(): MagnetTrainOam[] {
    const entry = this.oamFrame;
    if (!(entry && this.spriteX !== undefined)) return [];
    const vtile = OAMSET_VTILE[entry.oamset - 1]!;
    const out: MagnetTrainOam[] = [];
    for (const sprite of OAM_DATA) {
      const x = b(this.spriteX + this.globalX + mirror(sprite.x, entry.xflip));
      const y = b(this.spriteY! + sprite.y);
      out.push({
        x: x - 8,
        y: y - 16,
        tile: vtile + sprite.tile,
        xflip: entry.xflip,
      });
    }
    return out;
  }
}

export default MagnetTrain;
