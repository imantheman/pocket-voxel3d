// `G`: the part of love.graphics the Gen 2 screens draw with, landing on
// the Gold screen (platform/lcd.ts) instead of a canvas.
//
// gen1recomp's screens paint with `local G = love.graphics` -- setColor,
// draw, rectangle, push/translate/pop -- into a 160x144 canvas. Ported
// screens keep those calls; this turns each into Gold screen cells and
// objects:
//
// - `G.draw(image, quad, x, y, r, sx, sy)` cuts the (tile-aligned) quad into
//   8x8 tiles. A tile that lands on the 8px grid becomes a background cell,
//   one that does not becomes an object. Images the hardware shows as
//   objects (overworld sprites, party icons) are always objects: `image.obj`.
//   sx/sy of -1 flip; any other scale or rotation is not representable and
//   draws unscaled.
// - `G.rectangle("fill", ...)` fills with the current colour: whole cells
//   when it covers them, solid-tile objects for any ragged edge.
// - The palette every draw goes through is `G.palette`, which
//   GbcPalette.use/with set (shared/render/GbcPalette.ts), exactly as the
//   Lua's shader uniforms did.
// - push/pop/translate/origin/setScissor behave as in LÖVE. `scale` is
//   accepted and ignored: the Gold screen IS the 160x144 panel, so the fit
//   scales the Lua applies around a panel have nothing to do here.
// - Offscreen canvases do not exist. setCanvas/newCanvas are accepted so a
//   port can keep its structure, and draws inside a canvas are dropped
//   (a port that relies on a canvas's content redraws it directly).
//
// A cell holds one tile: a later draw on the same cell replaces it, where
// LÖVE would have composited. That is the hardware's rule, and Gold's
// screens were laid out for it.

import { ATTR_PRIORITY, ATTR_X_FLIP, ATTR_Y_FLIP, type Lcd, LCD_H, LCD_W, type Palette4, type Rgb } from "./lcd.ts";

/** A cooked Gold graphic: its size and the tile ids of its 8x8 grid. */
export interface LcdImage {
  key: string;
  /** Pixels. */
  w: number;
  h: number;
  /** Tiles. */
  tw: number;
  th: number;
  /** Row-major tile ids, tw * th of them. */
  ids: number[];
  /** Always drawn as objects (the hardware's OAM graphics). */
  obj: boolean;
  getDimensions(): [number, number];
  getWidth(): number;
  getHeight(): number;
  /** LÖVE's image:release(): nothing to free. */
  release(): void;
  setFilter(..._a: unknown[]): void;
}

export interface Quad {
  x: number;
  y: number;
  w: number;
  h: number;
  sw: number;
  sh: number;
  getViewport(): [number, number, number, number];
  setViewport(x: number, y: number, w: number, h: number): void;
}

/** Solid-colour tiles (cook/gen2lcd.ts LCD_SOLID). */
export const SOLID = [0, 1, 2, 3] as const;

/** rBGP's four shades (GbcPalette.lua DMG_SHADES): the default palette. */
export const DMG_SHADES: Palette4 = [
  [255, 255, 255],
  [170, 170, 170],
  [85, 85, 85],
  [0, 0, 0],
];

interface DrawState {
  tx: number;
  ty: number;
  scissor: [number, number, number, number] | null;
  colour: [number, number, number, number];
  palette: Palette4;
  keyed: boolean;
  /** Every tile drawn now is an object, even on the grid (G.objects). */
  objects: boolean;
  /**
   * null: cells are screen positions (the default). 0 or 1: cells are
   * positions in that map (0 background, 1 window), unclipped by the screen,
   * for a screen that scrolls the BG or uses the window (G.map).
   */
  map: number | null;
}

let lcd: Lcd | null = null;
// putTile's shortcuts: the target's cell arrays, and the palette slot the
// last cell drawn used (valid for one lcd frame)
let cellsOf = new Uint16Array(0);
let attrsOf = new Uint8Array(0);
let cachePal: Palette4 | null = null;
let cacheFrame = -1;
let cacheSlot = 0;
let st: DrawState = fresh();
const stack: DrawState[] = [];
let canvasDepth = 0;

function fresh(): DrawState {
  return { tx: 0, ty: 0, scissor: null, colour: [1, 1, 1, 1], palette: DMG_SHADES, keyed: false, objects: false, map: null };
}

/** The Gold screen draws land on (null: drawing is a no-op, as in tests of logic). */
export function setLcd(target: Lcd | null): void {
  lcd = target;
  cellsOf = target ? target.s.cells : new Uint16Array(0);
  attrsOf = target ? target.s.attrs : new Uint8Array(0);
  cachePal = null;
}

export function currentLcd(): Lcd | null {
  return lcd;
}

/** Reset the draw state at the start of a frame. */
export function resetDrawState(): void {
  st = fresh();
  stack.length = 0;
  canvasDepth = 0;
}

function clipped(x: number, y: number, w: number, h: number): boolean {
  if (x + w <= 0 || y + h <= 0 || x >= LCD_W || y >= LCD_H) return true;
  const s = st.scissor;
  if (!s) return false;
  return x + w <= s[0] || y + h <= s[1] || x >= s[0] + s[2] || y >= s[1] + s[3];
}

function rgb255(c: readonly number[]): Rgb {
  // setColor takes 0..1 (LÖVE 11); tolerate 0..255 tables too
  const scale = c[0]! > 1 || c[1]! > 1 || c[2]! > 1 ? 1 : 255;
  return [Math.round(c[0]! * scale), Math.round(c[1]! * scale), Math.round(c[2]! * scale)];
}

/**
 * Put one 8x8 tile at screen pixel (x, y). The cell path is written out in
 * full rather than through clipped()/lcd.cell(): under the 3DS's QuickJS a
 * function call costs more than everything else a tile does, and a screen
 * puts hundreds of tiles every frame.
 */
export function putTile(id: number, x: number, y: number, flipX = false, flipY = false, asObj = false): void {
  const l = lcd;
  if (l === null || canvasDepth > 0) return;
  const s = st;
  const flips = (flipX ? ATTR_X_FLIP : 0) | (flipY ? ATTR_Y_FLIP : 0);
  if (!asObj && !s.objects && (x & 7) === 0 && (y & 7) === 0) {
    const map = s.map;
    let base = 0;
    if (map === null) {
      if (x < 0 || y < 0 || x >= LCD_W || y >= LCD_H) return;
      const sc = s.scissor;
      if (sc !== null && (x + 8 <= sc[0] || y + 8 <= sc[1] || x >= sc[0] + sc[2] || y >= sc[1] + sc[3])) return;
    } else {
      // a map cell: positions in that map, unclipped by the screen
      if (x < 0 || y < 0 || x >= 256 || y >= 256) return;
      base = map === 1 ? 1024 : 0;
    }
    if (base) l.windowUsed = true;
    const i = base + (y >> 3) * 32 + (x >> 3);
    let slot: number;
    if (s.palette === cachePal && l.frame === cacheFrame) slot = cacheSlot;
    else {
      slot = l.palette(s.palette);
      cachePal = s.palette;
      cacheFrame = l.frame;
      cacheSlot = slot;
    }
    cellsOf[i] = id & 0xffff;
    attrsOf[i] = (slot | flips | (s.keyed ? ATTR_PRIORITY : 0)) & 0xef;
    return;
  }
  if (clipped(x, y, 8, 8)) return;
  l.obj(x, y, id, l.palette(s.palette, true) | flips);
}

/**
 * putTile(id) over a block of `cols` x `rows` cells from (x, y): the same
 * cells putTile would write one by one, with one palette lookup and the rows
 * filled natively. Off the 8px grid, or with every tile an object, it is
 * putTile per cell.
 */
export function putTiles(id: number, x: number, y: number, cols: number, rows: number): void {
  const l = lcd;
  if (l === null || canvasDepth > 0 || cols <= 0 || rows <= 0) return;
  const s = st;
  if (s.objects || (x & 7) !== 0 || (y & 7) !== 0) {
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) putTile(id, x + i * 8, y + j * 8);
    return;
  }
  let cx0 = x >> 3;
  let cy0 = y >> 3;
  let cx1 = cx0 + cols;
  let cy1 = cy0 + rows;
  let layer = 0;
  const map = s.map;
  if (map === null) {
    cx0 = Math.max(cx0, 0);
    cy0 = Math.max(cy0, 0);
    cx1 = Math.min(cx1, LCD_W / 8);
    cy1 = Math.min(cy1, LCD_H / 8);
    // putTile drops a cell only when it lies wholly outside the scissor
    const sc = s.scissor;
    if (sc !== null) {
      cx0 = Math.max(cx0, Math.floor(sc[0] / 8));
      cy0 = Math.max(cy0, Math.floor(sc[1] / 8));
      cx1 = Math.min(cx1, Math.ceil((sc[0] + sc[2]) / 8));
      cy1 = Math.min(cy1, Math.ceil((sc[1] + sc[3]) / 8));
    }
  } else {
    cx0 = Math.max(cx0, 0);
    cy0 = Math.max(cy0, 0);
    cx1 = Math.min(cx1, 32);
    cy1 = Math.min(cy1, 32);
    layer = map === 1 ? 1 : 0;
  }
  if (cx1 <= cx0 || cy1 <= cy0) return;
  let slot: number;
  if (s.palette === cachePal && l.frame === cacheFrame) slot = cacheSlot;
  else {
    slot = l.palette(s.palette);
    cachePal = s.palette;
    cacheFrame = l.frame;
    cacheSlot = slot;
  }
  l.fillCells(cx0, cy0, cx1 - cx0, cy1 - cy0, id, (slot | (s.keyed ? ATTR_PRIORITY : 0)) & 0xef, layer);
}

/** putTile at (x, y) of the current translation, rounded: a glyph's draw. */
export function putTileAt(id: number, x: number, y: number): void {
  putTile(id, Math.round(x + st.tx), Math.round(y + st.ty));
}

/** A cell with an explicit palette slot (a fill reusing a palette on screen). */
function putCell(id: number, x: number, y: number, slot: number): void {
  if (!lcd || canvasDepth > 0) return;
  if (st.map === null && clipped(x, y, 8, 8)) return;
  if ((x & 7) !== 0 || (y & 7) !== 0) return;
  lcd.cell(x >> 3, y >> 3, id, slot | (st.keyed ? ATTR_PRIORITY : 0), st.map ?? 0);
}

export const G = {
  getWidth: (): number => LCD_W,
  getHeight: (): number => LCD_H,
  getDimensions: (): [number, number] => [LCD_W, LCD_H],

  push(_mode?: string): void {
    stack.push({ ...st, colour: [...st.colour] as DrawState["colour"] });
  },
  pop(): void {
    const s = stack.pop();
    if (s) st = s;
  },
  origin(): void {
    st.tx = 0;
    st.ty = 0;
  },
  translate(x: number, y: number): void {
    st.tx += x;
    st.ty += y;
  },
  scale(_sx: number, _sy?: number): void {},
  /** The current translation (what transformPoint adds). */
  get tx(): number {
    return st.tx;
  },
  get ty(): number {
    return st.ty;
  },
  transformPoint(x: number, y: number): [number, number] {
    return [x + st.tx, y + st.ty];
  },

  setColor(r: number | readonly number[], g?: number, b?: number, a = 1): void {
    if (Array.isArray(r)) st.colour = [r[0] ?? 1, r[1] ?? 1, r[2] ?? 1, r[3] ?? 1];
    else st.colour = [r as number, g ?? 0, b ?? 0, a];
  },
  getColor(): [number, number, number, number] {
    return [...st.colour] as [number, number, number, number];
  },

  setScissor(x?: number, y?: number, w?: number, h?: number): void {
    st.scissor = x === undefined ? null : [x, y!, w!, h!];
  },
  intersectScissor(x: number, y: number, w: number, h: number): void {
    if (!st.scissor) {
      st.scissor = [x, y, w, h];
      return;
    }
    const s = st.scissor;
    const x0 = Math.max(s[0], x);
    const y0 = Math.max(s[1], y);
    const x1 = Math.min(s[0] + s[2], x + w);
    const y1 = Math.min(s[1] + s[3], y + h);
    st.scissor = [x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)];
  },
  getScissor(): [number, number, number, number] | [] {
    return st.scissor ? [...st.scissor] : [];
  },

  /** The palette draws go through (GbcPalette sets it). */
  get palette(): Palette4 {
    return st.palette;
  },
  set palette(p: Palette4) {
    st.palette = p;
  },
  /** Cells drawn now keep their colours 1-3 over objects (GbcPalette.useKeyed). */
  get keyed(): boolean {
    return st.keyed;
  },
  set keyed(on: boolean) {
    st.keyed = on;
  },

  /**
   * Draw everything as objects, grid-aligned or not, until turned off or
   * popped: what the cart puts in OAM over the BG (a lifted pic band, a pic
   * riding over scrolling scanlines) must not scroll with the BG cells.
   */
  get objects(): boolean {
    return st.objects;
  },
  set objects(on: boolean) {
    st.objects = on;
  },

  /**
   * Which map grid-aligned draws land in, addressed in map space rather than
   * screen space: null (default) the screen, 0 the background map (scrolled by
   * SCX/SCY), 1 the window map (placed by WX/WY). Pair with lcd.regs.
   */
  get map(): number | null {
    return st.map;
  },
  set map(layer: number | null) {
    st.map = layer;
  },

  /** Hand the current palette a slot now, before anything is drawn with it. */
  claim(): void {
    lcd?.palette(st.palette);
  },

  newQuad(x: number, y: number, w: number, h: number, sw = 0, sh = 0): Quad {
    const q: Quad = {
      x, y, w, h, sw, sh,
      getViewport: () => [q.x, q.y, q.w, q.h],
      setViewport: (nx, ny, nw, nh) => {
        q.x = nx;
        q.y = ny;
        q.w = nw;
        q.h = nh;
      },
    };
    return q;
  },

  /**
   * love.graphics.draw(image, [quad,] x, y, r, sx, sy, ox, oy).
   */
  // Plain parameters, not `...rest` and a destructure: under QuickJS the
  // destructure walks the iterator protocol, and that was most of a one-tile
  // draw. (a..h are love.graphics.draw's [quad,] x, y, r, sx, sy, ox, oy.)
  draw(image: LcdImage, a?: unknown, b?: unknown, c?: unknown, d?: unknown, e?: unknown, f?: unknown, g?: unknown, h?: unknown): void {
    // a canvas (or anything not cooked) has no tiles to draw
    if (!image || !image.ids || !lcd || canvasDepth > 0) return;
    let quad: Quad | null = null;
    let ax = a, ay = b, ar = c, asx = d, asy = e, aox = f, aoy = g;
    if (typeof a === "object" && a !== null) {
      quad = a as Quad;
      ax = b; ay = c; ar = d; asx = e; asy = f; aox = g; aoy = h;
    }
    const x = ax === undefined ? 0 : (ax as number);
    const y = ay === undefined ? 0 : (ay as number);
    const r = ar === undefined ? 0 : (ar as number);
    const sx = asx === undefined ? 1 : (asx as number);
    const sy = asy === undefined ? sx : (asy as number);
    const ox = aox === undefined ? 0 : (aox as number);
    const oy = aoy === undefined ? 0 : (aoy as number);
    const qx = quad ? quad.x : 0;
    const qy = quad ? quad.y : 0;
    const qw = quad ? quad.w : image.w;
    const qh = quad ? quad.h : image.h;
    let flipX = (sx as number) < 0;
    let flipY = (sy as number) < 0;
    // a half turn is both flips
    if (Math.abs(Math.abs(r as number) - Math.PI) < 1e-3) {
      flipX = !flipX;
      flipY = !flipY;
    }
    const cols = Math.ceil(qw / 8);
    const rows = Math.ceil(qh / 8);
    // the drawn rect's top-left, with the origin and flips applied
    const left = st.tx + (x as number) - (flipX ? qw - (ox as number) : (ox as number));
    const top = st.ty + (y as number) - (flipY ? qh - (oy as number) : (oy as number));
    const x0 = Math.round(left);
    const y0 = Math.round(top);
    const tx0 = Math.floor(qx / 8);
    const ty0 = Math.floor(qy / 8);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const sxT = tx0 + i;
        const syT = ty0 + j;
        if (sxT >= image.tw || syT >= image.th) continue;
        const id = image.ids[syT * image.tw + sxT]!;
        const dx = flipX ? cols - 1 - i : i;
        const dy = flipY ? rows - 1 - j : j;
        putTile(id, x0 + dx * 8, y0 + dy * 8, flipX, flipY, image.obj);
      }
    }
  },

  /** love.graphics.rectangle(mode, x, y, w, h): "fill" in the current colour. */
  rectangle(mode: string, x: number, y: number, w: number, h: number): void {
    if (mode !== "fill" || !lcd || canvasDepth > 0 || w <= 0 || h <= 0) return;
    const c = rgb255(st.colour);
    const saved = st.palette;
    const savedKeyed = st.keyed;
    // a colour some palette on screen already has: its solid tile in that
    // palette, rather than a palette slot spent on one flat colour
    const hit = lcd.findColour(c);
    let cellTile: number = SOLID[0];
    let cellAttr = -1;
    if (hit >= 0) {
      cellTile = SOLID[hit & 3]!;
      cellAttr = hit >> 2;
    } else {
      st.palette = [c, c, c, c];
    }
    const X0 = Math.round(st.tx + x);
    const Y0 = Math.round(st.ty + y);
    const X1 = Math.round(st.tx + x + w);
    const Y1 = Math.round(st.ty + y + h);
    // whole cells inside the rect, then objects over the ragged edges
    const cx0 = Math.ceil(X0 / 8);
    const cy0 = Math.ceil(Y0 / 8);
    const cx1 = Math.floor(X1 / 8);
    const cy1 = Math.floor(Y1 / 8);
    if (cx1 > cx0 && cy1 > cy0) {
      // whole rows of cells at once: the screen's own clip (or the map's
      // bounds, drawing into a map), then the scissor, then a native fill
      const map = st.map;
      let fx0 = cx0;
      let fy0 = cy0;
      let fx1 = cx1;
      let fy1 = cy1;
      if (map === null) {
        fx0 = Math.max(fx0, 0);
        fy0 = Math.max(fy0, 0);
        fx1 = Math.min(fx1, LCD_W / 8);
        fy1 = Math.min(fy1, LCD_H / 8);
        const sc = st.scissor;
        if (sc !== null) {
          fx0 = Math.max(fx0, Math.floor(sc[0] / 8));
          fy0 = Math.max(fy0, Math.floor(sc[1] / 8));
          fx1 = Math.min(fx1, Math.ceil((sc[0] + sc[2]) / 8));
          fy1 = Math.min(fy1, Math.ceil((sc[1] + sc[3]) / 8));
        }
      }
      const tile = cellAttr >= 0 ? cellTile : SOLID[0];
      const attr = ((cellAttr >= 0 ? cellAttr : lcd.palette(st.palette)) | (st.keyed ? ATTR_PRIORITY : 0)) & 0xef;
      lcd.fillCells(fx0, fy0, fx1 - fx0, fy1 - fy0, tile, attr, map ?? 0);
    }
    st.palette = [c, c, c, c];
    if (cx0 * 8 !== X0 || cy0 * 8 !== Y0 || cx1 * 8 !== X1 || cy1 * 8 !== Y1) {
      for (let py = Y0; py < Y1; py += 8) {
        for (let px = X0; px < X1; px += 8) {
          const inside = px >= cx0 * 8 && px + 8 <= cx1 * 8 && py >= cy0 * 8 && py + 8 <= cy1 * 8;
          if (!inside) putTile(SOLID[3], px, py, false, false, true);
        }
      }
    }
    st.palette = saved;
    st.keyed = savedKeyed;
  },

  /** love.graphics.clear([r, g, b]): the whole screen in one colour. */
  clear(r?: number | readonly number[], g?: number, b?: number): void {
    if (!lcd || canvasDepth > 0) return;
    const colour: readonly number[] = Array.isArray(r) ? r : r === undefined ? [0, 0, 0] : [r as number, g ?? 0, b ?? 0];
    G.push();
    st.tx = 0;
    st.ty = 0;
    st.scissor = null;
    st.colour = [colour[0]!, colour[1]!, colour[2]!, 1];
    G.rectangle("fill", 0, 0, LCD_W, LCD_H);
    G.pop();
  },

  // circles, lines and blend modes have no Gold screen form; screens that
  // use them for effects draw those effects some other way
  circle(..._a: unknown[]): void {},
  line(..._a: unknown[]): void {},
  polygon(..._a: unknown[]): void {},
  setLineWidth(_w: number): void {},
  setBlendMode(..._a: unknown[]): void {},
  getBlendMode(): [string, string] {
    return ["alpha", "alphamultiply"];
  },
  setShader(_s?: unknown): void {},
  getShader(): null {
    return null;
  },
  setFont(_f?: unknown): void {},
  getFont(): null {
    return null;
  },

  newCanvas(w = LCD_W, h = LCD_H): { w: number; h: number; getDimensions(): [number, number]; getWidth(): number; getHeight(): number; release(): void; setFilter(): void } {
    return {
      w, h,
      getDimensions: () => [w, h],
      getWidth: () => w,
      getHeight: () => h,
      release: () => {},
      setFilter: () => {},
    };
  },
  /** Draws while a canvas is set are dropped (see the header). */
  setCanvas(canvas?: unknown): void {
    canvasDepth = canvas ? 1 : 0;
  },
  getCanvas(): null {
    return null;
  },
};

export default G;
