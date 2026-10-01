// The Gold screen, guest side: an immediate-mode Game Boy Color picture
// that the ported Gen 2 screens draw into every frame, mirrored to the core
// (crates/pocketvoxel-core/src/lcd.rs) as the diff against what it last sent.
//
// gen1recomp draws Gold through LÖVE -- boxes, tile-grid text and sprites
// painted into a 160x144 canvas each frame (src/ui/gen2/Chrome.lua,
// src/render/Font.lua). The screens are transcribed from pokegold, so what
// they paint lands on the hardware's 8px grid; here it lands on the
// hardware's own model instead: two 32x32 maps of (tile, attribute) cells,
// a list of 8x8 objects, and palettes. `begin()` clears the frame, the
// screen draws, `end()` sends only what changed.
//
// Tile ids are the run's fixed ids for cooked Gold graphics (the cook's
// `lcd` manifest, voxelmon/cook/gen2lcd.ts): every image is a grid of them,
// so a screen never manages VRAM.

import type { VoxelHost } from "../../host.ts";

export const LCD_W = 160;
export const LCD_H = 144;
export const LCD_OBJS_MAX = 128;
export const LCD_HOLE = 0xff;
/** Palette slots per layer. */
export const LCD_PALS = 16;

export const ATTR_PAL = 0x0f;
export const ATTR_HOLE = 0x10;
export const ATTR_X_FLIP = 0x20;
export const ATTR_Y_FLIP = 0x40;
export const ATTR_PRIORITY = 0x80;

export const FLAG_BG_ON = 0x01;
export const FLAG_WIN_ON = 0x02;
export const FLAG_OBJ_ON = 0x04;
export const FLAG_OBJ_TALL = 0x08;

/** Where the window map starts in the cell arrays. */
export const WINDOW = 1024;

/** An RGB colour, 0-255 a channel (gen1recomp's palette entries). */
export type Rgb = readonly [number, number, number];
/** Four colours, lightest (colour 0) first. */
export type Palette4 = readonly [Rgb, Rgb, Rgb, Rgb];

export interface LcdObj {
  x: number;
  y: number;
  tile: number;
  attr: number;
}

export function rgb555(c: Rgb): number {
  return ((c[2] >> 3) << 10) | ((c[1] >> 3) << 5) | (c[0] >> 3);
}

/** The picture state -- the same fields lcd.rs keeps. */
export class LcdState {
  cells = new Uint16Array(2048);
  attrs = new Uint8Array(2048).fill(ATTR_HOLE);
  objs: LcdObj[] = [];
  colours = new Uint16Array(128);
  scx = 0;
  scy = 0;
  wx = 7;
  wy = LCD_H;
  flags = FLAG_BG_ON | FLAG_OBJ_ON;
  lines = new Uint8Array(LCD_H);
  lineTarget = 0;
  /** The under layer shown this frame, its pixel (underX, underY) at the
   *  screen's top-left (Lcd.underAt). */
  underOn = false;
  underX = 0;
  underY = 0;

  clearMaps(): void {
    this.cells.fill(0);
    this.attrs.fill(ATTR_HOLE);
    this.objs.length = 0;
  }
}

/**
 * The frame the core would draw, one byte a pixel: slot*4+colour (objects
 * from slot 16) or LCD_HOLE. `pixel(tile, x, y)` is a tile's raw colour.
 * lcd.rs `render`, line for line, for tests and offline shots.
 */
export function renderLcd(
  s: LcdState,
  pixel: (tile: number, x: number, y: number) => number,
  out: Uint8Array = new Uint8Array(LCD_W * LCD_H),
): Uint8Array {
  const bgCol = new Uint8Array(LCD_W);
  const bgPri = new Uint8Array(LCD_W);
  let winLine = 0;
  const cell = (map: number, cx: number, cy: number, px: number, py: number): number => {
    const i = map + (cy & 31) * 32 + (cx & 31);
    const attr = s.attrs[i]!;
    if (attr & ATTR_HOLE) return -1;
    const tx = attr & ATTR_X_FLIP ? 7 - px : px;
    const ty = attr & ATTR_Y_FLIP ? 7 - py : py;
    return (pixel(s.cells[i]!, tx, ty) & 3) | (attr << 8);
  };
  for (let ly = 0; ly < LCD_H; ly++) {
    const row = ly * LCD_W;
    out.fill(LCD_HOLE, row, row + LCD_W);
    bgCol.fill(0);
    bgPri.fill(0);
    const scy = s.lineTarget === 1 ? s.lines[ly]! : s.scy;
    const scx = s.lineTarget === 2 ? s.lines[ly]! : s.scx;
    if (s.flags & FLAG_BG_ON) {
      const by = (ly + scy) & 0xff;
      for (let x = 0; x < LCD_W; x++) {
        const bx = (x + scx) & 0xff;
        const v = cell(0, bx >> 3, by >> 3, bx & 7, by & 7);
        if (v < 0) continue;
        const c = v & 3;
        const attr = v >> 8;
        out[row + x] = (attr & ATTR_PAL) * 4 + c;
        bgCol[x] = c;
        bgPri[x] = attr & ATTR_PRIORITY ? 1 : 0;
      }
    }
    if (s.flags & FLAG_WIN_ON && ly >= s.wy && s.wx <= 166) {
      const x0 = Math.max(0, s.wx - 7);
      for (let x = x0; x < LCD_W; x++) {
        const wx = x + 7 - s.wx;
        const v = cell(WINDOW, wx >> 3, winLine >> 3, wx & 7, winLine & 7);
        if (v < 0) {
          out[row + x] = LCD_HOLE;
          bgCol[x] = 0;
          bgPri[x] = 0;
          continue;
        }
        const c = v & 3;
        const attr = v >> 8;
        out[row + x] = (attr & ATTR_PAL) * 4 + c;
        bgCol[x] = c;
        bgPri[x] = attr & ATTR_PRIORITY ? 1 : 0;
      }
      winLine++;
    }
    if (!(s.flags & FLAG_OBJ_ON)) continue;
    const tall = (s.flags & FLAG_OBJ_TALL) !== 0;
    const h = tall ? 16 : 8;
    const n = Math.min(s.objs.length, LCD_OBJS_MAX);
    for (let i = n - 1; i >= 0; i--) {
      const o = s.objs[i]!;
      let ty = ly - o.y;
      if (ty < 0 || ty >= h) continue;
      if (o.attr & ATTR_Y_FLIP) ty = h - 1 - ty;
      const tile = tall ? (o.tile & ~1) + (ty >= 8 ? 1 : 0) : o.tile;
      for (let px = 0; px < 8; px++) {
        const x = o.x + px;
        if (x < 0 || x >= LCD_W) continue;
        const tx = o.attr & ATTR_X_FLIP ? 7 - px : px;
        const c = pixel(tile, tx, ty & 7) & 3;
        if (c === 0) continue;
        if (bgCol[x] !== 0 && (bgPri[x] || o.attr & ATTR_PRIORITY)) continue;
        out[row + x] = (16 + (o.attr & ATTR_PAL)) * 4 + c;
      }
    }
  }
  return out;
}

// Lookups, not toString(16).padStart: under QuickJS the formatting was a
// large part of sending a frame (every changed cell and every object).
const HEX2 = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
const hex2 = (v: number): string => HEX2[v & 0xff]!;
const hex4 = (v: number): string => HEX2[(v >> 8) & 0xff]! + HEX2[v & 0xff]!;

/**
 * The frame builder the screens draw through. One per run; the host ops
 * are optional on VoxelHost, so a host without the Gold screen draws
 * nothing and the logic still runs.
 */
export class Lcd {
  /** What is being drawn this frame. */
  readonly s = new LcdState();
  /** What the core holds. */
  private sent = new LcdState();
  private sentObjs = "";
  private sentShown = false;
  /** Rows sent as all hole (attribute exactly ATTR_HOLE throughout). */
  private readonly sentHoleRow = new Uint8Array(64);
  private sentUnderX = 0;
  private sentUnderY = 0;
  /** The core's defaults (lcd.rs LcdScreen::default). */
  private sentRegs = `0,0,7,${LCD_H},${FLAG_BG_ON | FLAG_OBJ_ON}`;
  /** 32-bit views of the current and the sent cells (end()'s diff). */
  private s32: Uint32Array[] | undefined;
  private t32: Uint32Array[] | undefined;
  private sentLines = "0";
  shown = false;
  /** Palette slots handed out this frame, by colour key. */
  private bgPalKeys: string[] = [];
  private objPalKeys: string[] = [];
  /** Bumped by begin(): anything cached against this frame's palette slots keys on it. */
  frame = 0;
  /** A draw touched the window map this frame (end() diffs its rows only then). */
  windowUsed = false;
  private sentWindowUsed = false;
  private lastBgPal: Palette4 | null = null;
  private lastBgSlot = 0;
  private lastObjPal: Palette4 | null = null;
  private lastObjSlot = 0;
  /** Palette slot a draw uses when it names none. */
  bgPal = 0;
  objPal = 0;

  constructor(private readonly host: VoxelHost) {}

  /** Tell the core which atlas pages the tile ids live in (once, at boot). */
  banks(list: readonly { base: number; page: number; count: number }[]): void {
    for (const b of list) this.host.lcdBank?.(b.base, b.page, b.count);
  }

  /** Start a frame: every cell a hole, no objects, no palettes handed out. */
  begin(): void {
    this.frame++;
    this.windowUsed = false;
    this.s.clearMaps();
    this.bgPalKeys.length = 0;
    this.objPalKeys.length = 0;
    this.lastBgPal = null;
    this.lastObjPal = null;
    this.s.scx = 0;
    this.s.scy = 0;
    this.s.wx = 7;
    this.s.wy = LCD_H;
    this.s.flags = FLAG_BG_ON | FLAG_OBJ_ON;
    this.s.lineTarget = 0;
    this.s.underOn = false;
    this.bgPal = 0;
    this.objPal = 0;
  }

  /**
   * A palette slot for these four colours this frame, shared with any draw
   * that asked for the same colours. Past 16 distinct palettes a layer the
   * last slot is reused (and the screen shows the overflow).
   */
  palette(p: Palette4, obj = false): number {
    // the hot path: the same palette object as the last call this frame
    if (obj) {
      if (p === this.lastObjPal) return this.lastObjSlot;
    } else if (p === this.lastBgPal) return this.lastBgSlot;
    const c0 = rgb555(p[0]);
    const c1 = rgb555(p[1]);
    const c2 = rgb555(p[2]);
    const c3 = rgb555(p[3]);
    const keys = obj ? this.objPalKeys : this.bgPalKeys;
    const cols = this.s.colours;
    const off = obj ? 16 * 4 : 0;
    let slot = -1;
    for (let i = 0; i < keys.length; i++) {
      const b = off + i * 4;
      if (cols[b] === c0 && cols[b + 1] === c1 && cols[b + 2] === c2 && cols[b + 3] === c3) {
        slot = i;
        break;
      }
    }
    if (slot < 0) {
      slot = Math.min(keys.length, LCD_PALS - 1);
      keys[slot] = "";
      const b = off + slot * 4;
      cols[b] = c0;
      cols[b + 1] = c1;
      cols[b + 2] = c2;
      cols[b + 3] = c3;
    }
    if (obj) {
      this.lastObjPal = p;
      this.lastObjSlot = slot;
    } else {
      this.lastBgPal = p;
      this.lastBgSlot = slot;
    }
    return slot;
  }

  /**
   * Put these four colours in slot `slot` this frame (the 2D map reserves
   * BG slots 0-7 for its own eight, so its attribute bytes can be copied
   * straight in). Slots fill in order: set 0, 1, ... before anything asks
   * palette() for one, and later palette() calls find or follow them.
   */
  setPalette(slot: number, p: Palette4, obj = false): void {
    const keys = obj ? this.objPalKeys : this.bgPalKeys;
    if (slot < 0 || slot >= LCD_PALS || slot > keys.length) return;
    keys[slot] = "";
    const b = (obj ? 16 * 4 : 0) + slot * 4;
    const cols = this.s.colours;
    cols[b] = rgb555(p[0]);
    cols[b + 1] = rgb555(p[1]);
    cols[b + 2] = rgb555(p[2]);
    cols[b + 3] = rgb555(p[3]);
    if (obj) this.lastObjPal = null;
    else this.lastBgPal = null;
  }

  /**
   * A palette slot already handed out this frame that has colour `c`, as
   * slot*4 + index, or -1. Lets a flat fill reuse a text palette's paper
   * instead of spending a slot of its own.
   */
  findColour(c: Rgb, obj = false): number {
    const v = rgb555(c);
    const keys = obj ? this.objPalKeys : this.bgPalKeys;
    const base = obj ? 16 * 4 : 0;
    for (let slot = 0; slot < keys.length; slot++) {
      for (let i = 0; i < 4; i++) if (this.s.colours[base + slot * 4 + i] === v) return slot * 4 + i;
    }
    return -1;
  }

  /** One cell. `layer` 0 background, 1 window; tx/ty in tiles. */
  cell(tx: number, ty: number, tile: number, attr = this.bgPal, layer = 0): void {
    if (tx < 0 || ty < 0 || tx > 31 || ty > 31) return;
    if (layer) this.windowUsed = true;
    const i = layer * WINDOW + ty * 32 + tx;
    this.s.cells[i] = tile & 0xffff;
    this.s.attrs[i] = attr & ~ATTR_HOLE & 0xff;
  }

  fill(tx: number, ty: number, tw: number, th: number, tile: number, attr = this.bgPal, layer = 0): void {
    for (let y = ty; y < ty + th; y++) for (let x = tx; x < tx + tw; x++) this.cell(x, y, tile, attr, layer);
  }

  /** A rect of cells in one tile and attribute, a native fill per row (clipped to the map). */
  fillCells(tx: number, ty: number, tw: number, th: number, tile: number, attr: number, layer = 0): void {
    const x0 = Math.max(0, tx);
    const x1 = Math.min(32, tx + tw);
    const y0 = Math.max(0, ty);
    const y1 = Math.min(32, ty + th);
    if (x1 <= x0) return;
    if (layer) this.windowUsed = true;
    const cells = this.s.cells;
    const attrs = this.s.attrs;
    const a = attr & ~ATTR_HOLE & 0xff;
    for (let y = y0; y < y1; y++) {
      const i = layer * WINDOW + y * 32;
      cells.fill(tile & 0xffff, i + x0, i + x1);
      attrs.fill(a, i + x0, i + x1);
    }
  }

  /** Put cells back to holes: the world shows through them again. */
  hole(tx: number, ty: number, tw: number, th: number, layer = 0): void {
    if (layer) this.windowUsed = true;
    for (let y = Math.max(0, ty); y < Math.min(32, ty + th); y++) {
      for (let x = Math.max(0, tx); x < Math.min(32, tx + tw); x++) {
        const i = layer * WINDOW + y * 32 + x;
        this.s.cells[i] = 0;
        this.s.attrs[i] = ATTR_HOLE;
      }
    }
  }

  /** One 8x8 object at screen pixels. Earlier objects draw on top. */
  obj(x: number, y: number, tile: number, attr = this.objPal): void {
    if (this.s.objs.length >= LCD_OBJS_MAX) return;
    if (x <= -8 || y <= -16 || x >= LCD_W || y >= LCD_H) return;
    this.s.objs.push({ x: Math.round(x), y: Math.round(y), tile: tile & 0xffff, attr: attr & 0xff });
  }

  regs(r: { scx?: number; scy?: number; wx?: number; wy?: number; flags?: number }): void {
    if (r.scx !== undefined) this.s.scx = r.scx & 0xff;
    if (r.scy !== undefined) this.s.scy = r.scy & 0xff;
    if (r.wx !== undefined) this.s.wx = r.wx & 0xff;
    if (r.wy !== undefined) this.s.wy = r.wy & 0xff;
    if (r.flags !== undefined) this.s.flags = r.flags & 0xff;
  }

  /**
   * The UNDER layer (VIEW 2D's map, gen2/platform/map2d.ts): a whole map's
   * cells, sent to the core once per `key` (a new key, a new upload) and
   * shown under the background's holes -- the frame then sends a camera
   * position, not the screen's cells.
   */
  under(key: unknown, ids: Uint16Array, attrs: Uint8Array, w: number, h: number): void {
    if (key === this.underKey) return;
    this.underKey = key;
    const host = this.host;
    host.lcdUnder?.(w, h);
    for (let y = 0; y < h; y++) {
      let hex = "";
      for (let x = y * w, end = x + w; x < end; x++) hex += hex4(ids[x]!) + hex2(attrs[x]!);
      host.lcdUnderRow?.(y, hex);
    }
  }
  private underKey: unknown = null;
  private sentUnder = "0";

  /** Show the under layer this frame, its pixel (x, y) at the top-left. */
  underAt(x: number, y: number): void {
    this.s.underOn = true;
    this.s.underX = x | 0;
    this.s.underY = y | 0;
  }

  /** Per-line scroll for effects (1 SCY, 2 SCX); 0 turns it off. */
  lines(target: number, values?: ArrayLike<number>): void {
    this.s.lineTarget = target;
    if (values) for (let i = 0; i < LCD_H; i++) this.s.lines[i] = (values[i] ?? 0) & 0xff;
  }

  /** Send what changed since the last end(). */
  end(): void {
    const h = this.host;
    // A frame that is all holes and no objects shows nothing: the screen is
    // hidden then, so the host neither redraws nor composites a transparent
    // layer over the world (the overworld with no text up, most of the time).
    const shown = this.shown && !this.empty();
    if (shown !== this.sentShown) {
      h.lcdShow?.(shown ? 1 : 0);
      this.sentShown = shown;
    }
    if (!shown) return;
    const s = this.s;
    const t = this.sent;
    {
      const on = s.underOn;
      if (on ? this.sentUnder === "0" || s.underX !== this.sentUnderX || s.underY !== this.sentUnderY : this.sentUnder !== "0") {
        h.lcdUnderAt?.(on ? 1 : 0, s.underX, s.underY);
        this.sentUnder = on ? "1" : "0";
        this.sentUnderX = s.underX;
        this.sentUnderY = s.underY;
      }
    }
    // cells: per 32-cell row, the span from the first to the last change.
    // Rows are compared 32 bits at a time first (16 words of tiles, 8 of
    // attributes): most rows do not change, and this is the frame's
    // biggest loop under QuickJS.
    const sc32 = (this.s32 ??= [new Uint32Array(s.cells.buffer), new Uint32Array(s.attrs.buffer)]);
    const tc32 = (this.t32 ??= [new Uint32Array(t.cells.buffer), new Uint32Array(t.attrs.buffer)]);
    // the window's 32 rows only when it holds something now or did when sent
    const rows = this.windowUsed || this.sentWindowUsed ? 64 : 32;
    this.sentWindowUsed = this.windowUsed;
    const holeRow = this.sentHoleRow;
    for (let row = 0; row < rows; row++) {
      // A row that is all hole now and was all hole when sent shows nothing
      // either time, whatever its tiles: 8 words looked at, not 24. (VIEW
      // 2D's screen is all hole but its text: the map is the under layer.)
      const aw0 = row * 8;
      let hole = true;
      for (let k = 0; k < 8; k++) {
        if (sc32[1]![aw0 + k] !== 0x10101010) {
          hole = false;
          break;
        }
      }
      if (hole && holeRow[row]) continue;
      holeRow[row] = hole ? 1 : 0;
      let same = true;
      const cw = row * 16;
      for (let k = 0; k < 16; k++) {
        if (sc32[0]![cw + k] !== tc32[0]![cw + k]) {
          same = false;
          break;
        }
      }
      if (same) {
        const aw = row * 8;
        for (let k = 0; k < 8; k++) {
          if (sc32[1]![aw + k] !== tc32[1]![aw + k]) {
            same = false;
            break;
          }
        }
      }
      if (same) continue;
      const base = row * 32;
      let a = -1;
      let b = -1;
      for (let x = 0; x < 32; x++) {
        const i = base + x;
        if (s.cells[i] !== t.cells[i] || s.attrs[i] !== t.attrs[i]) {
          if (a < 0) a = i;
          b = i;
        }
      }
      if (a < 0) continue;
      let hex = "";
      for (let i = a; i <= b; i++) {
        hex += hex4(s.cells[i]!) + hex2(s.attrs[i]!);
        t.cells[i] = s.cells[i]!;
        t.attrs[i] = s.attrs[i]!;
      }
      h.lcdCells?.(a, hex);
    }
    // palettes: the span that changed
    {
      let a = -1;
      let b = -1;
      for (let i = 0; i < 128; i++) {
        if (s.colours[i] !== t.colours[i]) {
          if (a < 0) a = i;
          b = i;
        }
      }
      if (a >= 0) {
        let hex = "";
        for (let i = a; i <= b; i++) {
          hex += hex4(s.colours[i]!);
          t.colours[i] = s.colours[i]!;
        }
        h.lcdPals?.(a, hex);
      }
    }
    let objs = "";
    for (const o of s.objs) objs += hex4(o.y) + hex4(o.x) + hex4(o.tile) + hex2(o.attr);
    if (objs !== this.sentObjs) {
      h.lcdObjs?.(objs);
      this.sentObjs = objs;
    }
    const regs = `${s.scx},${s.scy},${s.wx},${s.wy},${s.flags}`;
    if (regs !== this.sentRegs) {
      h.lcdRegs?.(s.scx, s.scy, s.wx, s.wy, s.flags);
      this.sentRegs = regs;
    }
    let lines = String(s.lineTarget);
    if (s.lineTarget) {
      lines = "";
      for (let i = 0; i < LCD_H; i++) lines += hex2(s.lines[i]!);
    }
    if (lines !== this.sentLines) {
      h.lcdLines?.(s.lineTarget, s.lineTarget ? lines : "");
      this.sentLines = lines;
    }
  }

  /** True when nothing would be drawn: every visible cell a hole, no objects. */
  empty(): boolean {
    if (this.s.objs.length > 0 || this.s.underOn) return false;
    // a scrolled screen can show rows past the first eighteen: never hide it
    if (this.s.scx !== 0 || this.s.scy !== 0 || this.s.lineTarget !== 0) return false;
    const a32 = (this.e32 ??= new Uint32Array(this.s.attrs.buffer));
    // the visible 18 rows of the background (bit 4 set in all four bytes)
    for (let i = 0; i < 18 * 8; i++) if ((a32[i]! & 0x10101010) !== 0x10101010) return false;
    if (this.windowUsed && this.s.flags & FLAG_WIN_ON) {
      for (let i = 256; i < 256 + 18 * 8; i++) if ((a32[i]! & 0x10101010) !== 0x10101010) return false;
    }
    return true;
  }
  private e32: Uint32Array | undefined;

  /** Forget what the core holds (after a host scene reset). */
  invalidate(): void {
    this.sent = new LcdState();
    this.t32 = undefined;
    this.sent.attrs.fill(0xfe); // matches nothing: every cell resends
    this.sentHoleRow.fill(0);
    this.sentObjs = "\0";
    this.sentShown = !this.shown;
    this.sentRegs = "";
    this.sentLines = "\0";
    // lcdReset drops the core's under layer: upload it again when next asked
    this.underKey = null;
    this.sentUnder = "0";
    this.host.lcdReset?.();
  }
}
