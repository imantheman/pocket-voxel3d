// The Kanto games' 2D view (the OPTION screen's VIEW 2D): the overworld drawn
// as the Game Boy drew it, through the GB screen (gb/video.ts, gb.rs) --
// the map's tiles out of the pak's own terrain page in VRAM $9000, each
// person's sheet in $8000/$8800 and four OAM sprites a person, scrolled by
// SCX/SCY, all through the map's one SGB palette the way the Super Game Boy
// coloured it. The scene shows it over a black backdrop picture in place of
// the voxel world, and the tile layer (text boxes, menus) draws over it as
// always.
//
// The camera stands where pokered's does: the player's 16x16 sprite at
// screen (64, 60), its cell 4 px lower (sprites ride 4 px above the grid).
//
// The BG map is a ring, as vBGMap0 is on the cart: tile (tx, ty) lives at
// (tx & 31, ty & 31) and SCX/SCY scroll over it, so a step rewrites one new
// row or column and the frames between rewrite nothing (mapsDirty false,
// so the emitter does not even compare). The map's tiles are worked out
// once per map, from its blocks, into a padded array the rows copy out of.
//
// Past the map's edge the connected maps show, their blocks drawn in this
// map's tileset as the cart draws its connection strips; elsewhere the
// border block.
//
// A cut tree's block is drawn as the cart's swap leaves it
// (field.cutTreeSwaps, CutTreeBlockSwaps); this port keeps the cut as the
// cells it opened (map.ts markCut), so the swap is made here. The water and
// flowers move host-side (main.rs steps the terrain page's baked frames).
//
// Not the cart's: the OPTION screen's 2D SCREEN WIDE and 2D ZOOM OUT
// (viewmode.ts canvasSize) show more of the map round the same camera -- the
// GB screen's wide picture (gb.rs wide_on): the same tiles in a 64x32 ring,
// the people as its own objects, laid over the whole top screen or zoomed
// out into the box. The text boxes and menus stay the tile layer's, full size.

import { GbVideo, LCDC, OAM_ATTR, OAM_X_OFS, OAM_Y_OFS, WIDE_COLS, WIDE_COLS_MAX, WIDE_OBJS_MAX, WIDE_ROWS, WIDE_ROWS_MAX, type TileLoad } from "../gb/video.ts";
import { canvasSize } from "../viewmode.ts";
import type { Dir } from "./collision.ts";
import { DARK_MAPS } from "./overworld.ts";

/** The slot key of the emotion bubbles' sheet (the pak's emote page). */
const EMOTES = "@emotes";

/** STAND / WALK sheet frames per facing (scene.ts's, SpriteRenderer.lua's). */
const STAND: Record<string, number> = { down: 0, up: 1, left: 2, right: 2 };
const WALK: Record<string, number> = { down: 3, up: 4, left: 5, right: 5 };
/** VRAM tiles each sprite sheet gets: six 16x16 frames. */
const SHEET_TILES = 24;
/** Sheets at once: $8000-$8EFF (the map's tiles are at $9000). */
const SHEETS_MAX = 10;
/** A sprite page's row in tiles: cook/atlas.ts SPRITE_PAGE_W (64 px), the
 *  sheet itself the first 2 tiles of it. */
const SPRITE_PAGE_TILES = 8;
const COLS = 21;
const ROWS = 19;
/** Tiles of border kept round the map in the cache (the camera's reach
 *  past the edge is 8 left/up, 10 right/down, the seam step one cell more;
 *  the widest picture -- WIDE at 2D ZOOM OUT MAX -- reaches 30 tiles
 *  further each side). */
const PAD = 32;
/** Frames between checks that the map's blocks still match the cache (a
 *  door or barrier a script stamps mid-visit). */
const BLOCK_CHECK = 32;

interface MapTiles {
  map: any;
  /** The tileset's blocks the cache was built from. */
  tileset: unknown;
  /** Padded size in tiles. */
  w: number;
  h: number;
  ids: Uint8Array;
  /** The blocks the cache was built from. */
  blocks: number[];
  /** How many cut cells it was built with. */
  cuts: number;
}

export class OverworldView2d {
  private readonly video = new GbVideo();
  private slots = new Map<string, number>();
  private tiles: MapTiles | null = null;
  private winX = NaN;
  private winY = NaN;
  private frame = 0;

  /** This frame's GB screen, or null when there is no overworld to draw. */
  build(game: any): GbVideo | null {
    const ow = game.overworld;
    const map = ow?.map;
    const p = ow?.player;
    if (!map || !p) return null;
    const v = this.video;
    let t = this.tiles;
    if (!t || t.map !== map || t.cuts !== (map.cutCells?.().size ?? 0) ||
        (++this.frame % BLOCK_CHECK === 0 && !sameBlocks(t.blocks, map.def.blocks))) {
      if (!t || t.map !== map) {
        this.slots.clear();
        this.loadsSize = -1;
      }
      t = this.tiles = tilesFor(map, game.data.maps, game.data.field?.cutTreeSwaps);
      this.winX = NaN;
    }
    const camX = Math.round(p.px) - 64;
    const camY = Math.round(p.py) - 64;

    v.lcdc = LCDC.on | LCDC.bgOn | LCDC.objOn; // BG tiles from $9000, signed
    // the wide picture (2D SCREEN WIDE / 2D ZOOM OUT), where the host has it
    const canvas = game.host?.gbWide ? canvasSize(game.save?.options) : null;
    if (canvas) {
      // the 160x144 centred in it: its top-left that much up and left
      const vx = camX - ((canvas.w - 160) >> 1);
      const vy = camY - ((canvas.h - 144) >> 1);
      const tx0 = Math.floor(vx / 8);
      const ty0 = Math.floor(vy / 8);
      const cols = Math.ceil(canvas.w / 8) + 1;
      const rows = Math.ceil(canvas.h / 8) + 1;
      // the ring: 64x32 tiles while the window fits in it, else 128x64 (2D
      // ZOOM OUT's FAR and MAX); a change of size writes the window afresh
      const big = cols > WIDE_COLS || rows > WIDE_ROWS;
      const rc = big ? WIDE_COLS_MAX : WIDE_COLS;
      const rr = big ? WIDE_ROWS_MAX : WIDE_ROWS;
      if (rc !== v.wideCols || rr !== v.wideRows) {
        v.wideCols = rc;
        v.wideRows = rr;
        this.wideX = NaN;
      }
      if (tx0 !== this.wideX || ty0 !== this.wideY || cols !== this.wideCols || rows !== this.wideRows || t !== this.wideTiles) {
        // one tile over with the same window and tiles: only the row or
        // column it brought in (the rest of the ring is where it was)
        const dx = tx0 - this.wideX;
        const dy = ty0 - this.wideY;
        const step = cols === this.wideCols && rows === this.wideRows && t === this.wideTiles && Math.abs(dx) + Math.abs(dy) === 1;
        if (step && dx === 1) writeWideRect(v, t, map, tx0 + cols - 1, ty0, 1, rows);
        else if (step && dx === -1) writeWideRect(v, t, map, tx0, ty0, 1, rows);
        else if (step && dy === 1) writeWideRect(v, t, map, tx0, ty0 + rows - 1, cols, 1);
        else if (step) writeWideRect(v, t, map, tx0, ty0, cols, 1);
        else writeWideRect(v, t, map, tx0, ty0, cols, rows);
        this.wideX = tx0;
        this.wideY = ty0;
        this.wideCols = cols;
        this.wideRows = rows;
        this.wideTiles = t;
        v.wideMapDirty = true;
      } else v.wideMapDirty = false;
      v.wideW = canvas.w;
      v.wideH = canvas.h;
      v.wideScx = vx & (rc * 8 - 1);
      v.wideScy = vy & (rr * 8 - 1);
      v.wideFull = canvas.wide;
      this.viewW = canvas.w;
      this.viewH = canvas.h;
      this.camX = vx;
      this.camY = vy;
      // the hardware window is written afresh when the picture goes back
      this.winX = NaN;
      v.mapsDirty = false;
    } else {
      v.wideW = v.wideH = 0;
      this.wideX = NaN;
      this.viewW = 160;
      this.viewH = 144;
      this.camX = camX;
      this.camY = camY;
      // the map: the 21x19 window from (camX, camY) into the ring
      const tx0 = Math.floor(camX / 8);
      const ty0 = Math.floor(camY / 8);
      if (tx0 !== this.winX || ty0 !== this.winY) {
        this.winX = tx0;
        this.winY = ty0;
        writeWindow(v.maps, t, map, tx0, ty0);
        v.mapsDirty = true;
      } else v.mapsDirty = false;
      v.scx = camX & 255;
      v.scy = camY & 255;
    }
    this.wide = canvas !== null;

    // the people, straight into OAM (the player first: on top) -- or the
    // wide picture's objects
    const oam = v.oam;
    oam.fill(0);
    this.oamN = 0;
    v.wideObjCount = 0;
    const gold = (game.data as { version?: string }).version === "gold";
    // an emotion bubble first, so it sits on top: 16 px over its person
    // (ShowEmotionBubble), frame kind - 1 of the emote page as scene.ts's
    // emote op draws it in 3D
    const emote = ow.emote;
    if (emote && emote.kind >= 1 && emote.kind <= 3 && emote.entity) {
      this.put(EMOTES, emote.entity.px, emote.entity.py - 16, emote.kind - 1, false);
    }
    {
      const phase = p.walkPhase();
      const f: Dir = p.facing;
      this.put(
        p.surfing ? (gold ? "SPRITE_SURF" : "SPRITE_SEEL") : p.onBike ? (gold ? "SPRITE_CHRIS_BIKE" : "SPRITE_RED_BIKE") : (gold ? "SPRITE_CHRIS" : "SPRITE_RED"),
        p.px,
        p.py - (p.hopLift?.() ?? 0),
        phase === 1 ? WALK[f]! : STAND[f]!,
        f === "right" || ((f === "down" || f === "up") && phase === 1 && p.animFlip()),
      );
    }
    const sprites = game.data.sprites;
    for (const npc of ow.npcs ?? []) {
      if (npc.hidden) continue;
      const def = sprites?.[npc.def.sprite];
      const frames = def?.frames ?? 6;
      const walker = def?.walker ?? frames > 1;
      const phase = npc.walkPhase();
      const f: Dir = npc.facing;
      this.put(
        npc.def.sprite,
        npc.px,
        npc.py - (npc.lift ?? 0),
        frames <= 1 ? 0 : phase === 1 && walker ? WALK[f]! : STAND[f]!,
        frames > 1 && (f === "right" || ((f === "down" || f === "up") && phase === 1 && npc.stepFlip)),
      );
    }

    // VRAM: the terrain page, then each sheet in its slot -- a new array
    // only when a sheet joins, so the emitter can tell by identity
    if (this.slots.size !== this.loadsSize) {
      this.loadsSize = this.slots.size;
      const loads: TileLoad[] = [{ dest: 256, sheet: "terrain", first: 0, count: 128, map: map.def.index }];
      for (const [sheet, slot] of this.slots) {
        loads.push({ dest: slot * SHEET_TILES, sheet: sheet === EMOTES ? "emotes" : `sprite:${sheet}`, first: 0, count: SHEET_TILES, wide: 2, stride: SPRITE_PAGE_TILES });
      }
      v.loads = loads;
    }

    // the map's SGB palette for all three registers, as the SGB coloured it
    const pal = game.data.mapPalette?.[map.id];
    const name = typeof pal === "number" && pal >= 0 ? `#${pal}` : "grey";
    const c = v.colours;
    if (c.bg !== name) v.colours = { bg: name, obj0: name, obj1: name };
    // Rock Tunnel unlit: wMapPalOffset 6, LoadGBPal two steps down the fade
    // table (FadePal2) -- the lightest shade dark grey, the rest black
    const dark = DARK_MAPS.has(map.id) && !(game.save as { flashLit?: boolean } | undefined)?.flashLit;
    v.bgp = dark ? 0xfe : 0xe4;
    v.obp0 = dark ? 0xfe : 0xe4;
    v.obp1 = dark ? 0xf8 : 0xe4;
    return v;
  }
  /** Sheets the current loads array was built for (-1: build it). */
  private loadsSize = -1;
  private oamN = 0;
  /** The picture's top-left in map pixels, and its size. */
  private camX = 0;
  private camY = 0;
  private viewW = 160;
  private viewH = 144;
  /** The wide picture is drawn this frame; its window in the ring. */
  private wide = false;
  private wideX = NaN;
  private wideY = NaN;
  private wideCols = 0;
  private wideRows = 0;
  /** The tiles the ring was written from (a rebuilt cache -- a cut, a
   *  stamped block -- writes the window again). */
  private wideTiles: MapTiles | null = null;

  /** One person's four OAM entries (a 16x16 frame of its sheet). */
  private put(sheet: string, px: number, py: number, frame: number, mirror: boolean): void {
    const sx = Math.round(px) - this.camX;
    const sy = Math.round(py) - this.camY - 4;
    if (sx <= -16 || sy <= -16 || sx >= this.viewW || sy >= this.viewH) return;
    let slot = this.slots.get(sheet);
    if (slot === undefined) {
      if (this.slots.size >= SHEETS_MAX) return;
      slot = this.slots.size;
      this.slots.set(sheet, slot);
    }
    const base = slot * SHEET_TILES + frame * 4;
    const attr = mirror ? OAM_ATTR.xFlip : 0;
    if (this.wide) {
      const v = this.video;
      const objs = v.wideObjs;
      for (let r = 0; r < 2; r++) {
        for (let c = 0; c < 2; c++) {
          if (v.wideObjCount >= WIDE_OBJS_MAX) return;
          const o = v.wideObjCount++ * 4;
          objs[o] = sy + r * 8;
          objs[o + 1] = sx + c * 8;
          objs[o + 2] = base + r * 2 + (mirror ? 1 - c : c);
          objs[o + 3] = attr;
        }
      }
      return;
    }
    const oam = this.video.oam;
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 2; c++) {
        if (this.oamN >= 40) return;
        const o = this.oamN++ * 4;
        oam[o] = (sy + r * 8 + OAM_Y_OFS) & 0xff;
        oam[o + 1] = (sx + c * 8 + OAM_X_OFS) & 0xff;
        oam[o + 2] = base + r * 2 + (mirror ? 1 - c : c);
        oam[o + 3] = attr;
      }
    }
  }
}

function sameBlocks(a: number[], b: number[] | undefined): boolean {
  if (!b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

interface ConnDef {
  map: string;
  offset: number;
}

/**
 * The block at (bx, by), map block coordinates, past the edge too: a
 * connected map's (overworld.ts places them -- north at x + offset, y -
 * its height, and so on round), else the border block.
 */
function blockPast(map: any, maps: Record<string, any> | undefined, bx: number, by: number): number {
  const def = map.def;
  const w = def.width;
  const h = def.height;
  if (bx >= 0 && by >= 0 && bx < w && by < h) return def.blocks[by * w + bx];
  const conns: Record<string, ConnDef> | undefined = def.connections;
  if (conns && maps) {
    const at = (c: ConnDef | undefined, nbx: number, nby: number): number => {
      const d = c ? maps[c.map] : undefined;
      if (!d || nbx < 0 || nby < 0 || nbx >= d.width || nby >= d.height) return -1;
      return d.blocks[nby * d.width + nbx] ?? -1;
    };
    let b = -1;
    if (by < 0 && conns.north) b = at(conns.north, bx - conns.north.offset, by + (maps[conns.north.map]?.height ?? 0));
    if (b < 0 && by >= h && conns.south) b = at(conns.south, bx - conns.south.offset, by - h);
    if (b < 0 && bx < 0 && conns.west) b = at(conns.west, bx + (maps[conns.west.map]?.width ?? 0), by - conns.west.offset);
    if (b < 0 && bx >= w && conns.east) b = at(conns.east, bx - w, by - conns.east.offset);
    if (b >= 0) return b;
  }
  return def.borderBlock;
}

/** Maps whose tiles were worked out lately, by id: walking back over a
 *  seam (or out of a door and in again) finds its map's tiles here. */
const recent = new Map<string, MapTiles>();
const RECENT_MAX = 6;

/** The map's tiles: the recent copy while its blocks, tileset and cuts
 *  still match, else worked out afresh. */
function tilesFor(map: any, maps?: Record<string, any>, swaps?: { before: number; after: number }[]): MapTiles {
  const cuts = map.cutCells?.().size ?? 0;
  const hit = recent.get(map.id);
  if (hit && cuts === 0 && hit.cuts === 0 && hit.tileset === map.tileset.blocks && sameBlocks(hit.blocks, map.def.blocks)) {
    hit.map = map;
    recent.delete(map.id); // to the back: most recent
    recent.set(map.id, hit);
    return hit;
  }
  const t = buildTiles(map, maps, swaps);
  if (cuts === 0) {
    recent.delete(map.id);
    recent.set(map.id, t);
    if (recent.size > RECENT_MAX) recent.delete(recent.keys().next().value!);
  }
  return t;
}

/** Each tileset's blocks as rows of four tile ids, one 32-bit word a row
 *  (tile 0 in the low byte: the little-endian order a Uint8Array reads
 *  back over the same buffer, on the 3DS and the PC alike). */
const blockRows = new WeakMap<object, Uint32Array>();
function rowsOf(tsBlocks: number[][]): Uint32Array {
  let rows = blockRows.get(tsBlocks);
  if (!rows) {
    rows = new Uint32Array(tsBlocks.length * 4);
    for (let b = 0; b < tsBlocks.length; b++) {
      const bl = tsBlocks[b];
      if (!bl) continue;
      for (let r = 0; r < 4; r++) {
        rows[b * 4 + r] = ((bl[r * 4]! & 0x7f) | ((bl[r * 4 + 1]! & 0x7f) << 8) |
          ((bl[r * 4 + 2]! & 0x7f) << 16) | ((bl[r * 4 + 3]! & 0x7f) << 24)) >>> 0;
      }
    }
    blockRows.set(tsBlocks, rows);
  }
  return rows;
}

/**
 * The map's tiles, PAD tiles of border round them. The blocks are laid out
 * first on a padded block grid -- the border block, then each connected
 * map's blocks painted over its side (east, west, south, north: blockPast's
 * order, the later winning a corner), then the map's own, then CUT's swaps
 * -- and each block's four tile rows written as one word apiece. Worked out
 * a block (or a tile) at a time this took ~130-430 ms on the console at a
 * map switch, a freeze at every seam the cart crosses without a pause.
 */
export function buildTiles(map: any, maps?: Record<string, any>, swaps?: { before: number; after: number }[]): MapTiles {
  const def = map.def;
  const mw = def.width;
  const mh = def.height;
  const pb = PAD / 4; // padding in blocks
  const gw = mw + pb * 2;
  const gh = mh + pb * 2;
  const grid = new Int32Array(gw * gh).fill(def.borderBlock ?? 0);
  // a connected map's blocks onto the grid, where they fall inside `side`
  const paint = (c: ConnDef | undefined, ox: number, oy: number, side: (gx: number, gy: number) => boolean): void => {
    const d = c && maps ? maps[c.map] : undefined;
    if (!d?.blocks) return;
    for (let y = 0; y < d.height; y++) {
      const gy = y + oy + pb;
      if (gy < 0 || gy >= gh) continue;
      for (let x = 0; x < d.width; x++) {
        const gx = x + ox + pb;
        if (gx < 0 || gx >= gw || !side(gx - pb, gy - pb)) continue;
        const b = d.blocks[y * d.width + x];
        if (b !== undefined) grid[gy * gw + gx] = b;
      }
    }
  };
  const conns: Record<string, ConnDef> | undefined = def.connections;
  if (conns && maps) {
    const east = conns.east, west = conns.west, south = conns.south, north = conns.north;
    if (east) paint(east, mw, east.offset, (bx) => bx >= mw);
    if (west) paint(west, -(maps[west.map]?.width ?? 0), west.offset, (bx) => bx < 0);
    if (south) paint(south, south.offset, mh, (_bx, by) => by >= mh);
    if (north) paint(north, north.offset, -(maps[north.map]?.height ?? 0), (_bx, by) => by < 0);
  }
  const blocks: number[] = def.blocks ?? [];
  for (let by = 0; by < mh; by++) {
    const g0 = (by + pb) * gw + pb;
    for (let bx = 0; bx < mw; bx++) grid[g0 + bx] = blocks[by * mw + bx]!;
  }
  // the blocks holding a cut cell, as CUT left them
  const cut: ReadonlySet<number> = map.cutCells?.() ?? new Set();
  for (const i of cut) {
    const cx = i % map.widthCells;
    const cy = Math.floor(i / map.widthCells);
    const bi = (cy >> 1) * mw + (cx >> 1);
    const sw = swaps?.find((s) => s.before === blocks[bi]);
    if (sw) grid[((cy >> 1) + pb) * gw + (cx >> 1) + pb] = sw.after;
  }
  // the grid out to tiles: four words a block
  const w = gw * 4;
  const h = gh * 4;
  const ids = new Uint8Array(w * h);
  const ids32 = new Uint32Array(ids.buffer);
  const rows = rowsOf(map.tileset.blocks);
  const nBlocks = rows.length >> 2;
  const wq = w >> 2; // a tile row in words: one word per block column
  for (let gy = 0; gy < gh; gy++) {
    const o = gy * 4 * wq;
    for (let gx = 0; gx < gw; gx++) {
      const b = grid[gy * gw + gx]!;
      if (b < 0 || b >= nBlocks) continue;
      const s = b * 4;
      const at = o + gx;
      ids32[at] = rows[s]!;
      ids32[at + wq] = rows[s + 1]!;
      ids32[at + 2 * wq] = rows[s + 2]!;
      ids32[at + 3 * wq] = rows[s + 3]!;
    }
  }
  return { map, tileset: map.tileset.blocks, w, h, ids, blocks: blocks.slice(), cuts: cut.size };
}

/** The wide picture's `cols` x `rows` tiles from tile (tx0, ty0) into its
 *  ring (writeWindow's, wider; the ring v.wideCols x v.wideRows), each row
 *  marked written for the emitter. */
function writeWideRect(v: GbVideo, t: MapTiles, map: any, tx0: number, ty0: number, cols: number, rows: number): void {
  const maps = v.wideMap;
  const rc = v.wideCols;
  const rr = v.wideRows;
  const x = tx0 + PAD;
  const y = ty0 + PAD;
  const inside = x >= 0 && y >= 0 && x + cols <= t.w && y + rows <= t.h;
  const col = tx0 & (rc - 1);
  const first = Math.min(cols, rc - col);
  for (let r = 0; r < rows; r++) {
    const row = ((ty0 + r) & (rr - 1)) * rc;
    if (inside) {
      const src = (y + r) * t.w + x;
      if (cols === 1) maps[row + col] = t.ids[src]!;
      else {
        maps.set(t.ids.subarray(src, src + first), row + col);
        if (first < cols) maps.set(t.ids.subarray(src + first, src + cols), row);
      }
    } else {
      for (let c = 0; c < cols; c++) maps[row + ((tx0 + c) & (rc - 1))] = map.tileAt(tx0 + c, ty0 + r) & 0x7f;
    }
    v.markWide(row + col, row + col + first);
    if (first < cols) v.markWide(row, row + cols - first);
  }
}

/** The 21x19 window from tile (tx0, ty0) into the 32x32 ring. */
function writeWindow(maps: Uint8Array, t: MapTiles, map: any, tx0: number, ty0: number): void {
  const x = tx0 + PAD;
  const y = ty0 + PAD;
  const inside = x >= 0 && y >= 0 && x + COLS <= t.w && y + ROWS <= t.h;
  const col = tx0 & 31;
  const first = Math.min(COLS, 32 - col);
  for (let r = 0; r < ROWS; r++) {
    const row = ((ty0 + r) & 31) * 32;
    if (inside) {
      const src = (y + r) * t.w + x;
      maps.set(t.ids.subarray(src, src + first), row + col);
      if (first < COLS) maps.set(t.ids.subarray(src + first, src + COLS), row);
    } else {
      // past the cache (a seam step's far reach): tile by tile
      for (let c = 0; c < COLS; c++) maps[row + ((tx0 + c) & 31)] = map.tileAt(tx0 + c, ty0 + r) & 0x7f;
    }
  }
}
