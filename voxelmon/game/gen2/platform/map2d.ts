// Gold's 2D view (the OPTION screen's VIEW 2D): the overworld drawn on the
// Gold screen itself, the way the cart draws it, instead of as the voxel
// world under it -- the map's tiles in their PalMap palettes for the time of
// day, the people as OBJ sprites, and everything the screens draw (text
// boxes, menus) over them as before.
//
// What the cart's renderer kept and the voxel port dropped (World's baked map
// canvas) comes back from the same sources the bake read: Map.tileAt for each
// 8px tile, the tileset image and its roof (atlasFor), and the palette set
// the map's environment loads (World.bgSets).
//
// Cheap per frame, which is the point: a map's screen tile ids and palette
// slots are worked out once (again only when the map, its blocks, the time
// of day or the roof change) and sent to the core once as the screen's
// UNDER layer (lcd.ts under, lcd.rs), which the background's holes show at
// the camera -- so a frame sends a position, and the text boxes and menus
// drawn over it are the only cells. (Copying the window into the cells each
// frame meant every 8 px of walking re-sent the whole screen.) Sprites keep
// their sheet and palette per sprite and time of day.
// Past the map's edge the connected maps show, their blocks in this map's
// tileset as the cart draws its connection strips (placed as
// World.computeNeighbors places them); the border block elsewhere.
// The water and flowers move: each animated tile's under cells are aliased
// (lcd.ts alias, lcd.rs) to its frame strip's row for the step, as
// World.animRow says -- one op a step, not a re-upload. (Not the "scroll"
// kind, which rotates pixels a tile id cannot.)
// In tall grass a person's lower half goes behind the background (the OBJ
// priority bit), so the grass tile's colours cover its feet as on the cart.
// Not the cart's: the OPTION screen's 2D SCREEN WIDE and 2D ZOOM OUT
// (viewmode.ts canvasSize)
// show more of the map round the same camera -- the under layer drawn by the
// host as a canvas of its own (lcd.ts underView), out to the top screen's
// edges or zoomed out in the Gold screen's box, the people on it with it
// (underObj). The text boxes and menus stay the Gold screen's, full size.

import { Assets } from "../shared/render/Assets.ts";
import { Palettes } from "../world/Palettes.ts";
import { peopleView_W6 } from "../world/World.ts";
import { currentLcd, type LcdImage } from "./screen.ts";
import { canvasSize } from "../../viewmode.ts";
import type { Palette4 } from "./lcd.ts";

/** pokegold LoadMapGroupRoof: nine roof tiles over vTiles2 tile $0a. */
const ROOF_FIRST = 0x0a;
const ROOF_COUNT = 9;
/** Border tiles kept round a map's grid: the camera never sees further off
 *  (the widest canvas reaches 132 px past the screen's sides). A whole
 *  number of blocks, so every block's rows land on word boundaries
 *  (buildTiles). */
const PAD = 32;


const images = new Map<string, LcdImage | null>();
function image(path: string | undefined): LcdImage | null {
  if (!path) return null;
  let img = images.get(path);
  if (img === undefined) {
    try {
      img = (Assets.image(path) as LcdImage) ?? null;
    } catch {
      img = null;
    }
    images.set(path, img);
  }
  return img;
}

/** One map's screen tiles, worked out once, with PAD tiles of border round them. */
interface MapTiles {
  key: string;
  map: unknown;
  version: number;
  /** padded columns and rows: (blocks x 4) + 2 * PAD */
  pw: number;
  ph: number;
  ids: Uint16Array;
  pal: Uint8Array;
  /** tileset tile -> screen tile id, as the cells were built */
  idOf: (tile: number) => number;
  /** The map's blocks the grid was built from (a later visit's map may
   *  have had a door or a barrier stamped on entry). */
  blocks: number[];
}

let cached: MapTiles | null = null;
/** Grids worked out lately, by cache key (map, time of day, roof):
 *  walking back over a seam, or out of a door and in again, finds them. */
const recent = new Map<string, MapTiles>();
const RECENT_MAX = 6;

function sameBlocks(a: number[], b: number[] | undefined): boolean {
  if (!b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function tilesFor(world: any, map: any, key: string): MapTiles | null {
  if (cached && cached.key === key && cached.map === map && cached.version === (map.version ?? 0)) return cached;
  const hit = recent.get(key);
  if (hit && sameBlocks(hit.blocks, map.blocks)) {
    hit.map = map;
    hit.version = map.version ?? 0;
    recent.delete(key);
    recent.set(key, hit);
    return (cached = hit);
  }
  const t = buildTiles(world, map, key);
  if (t) {
    recent.delete(key);
    recent.set(key, t);
    if (recent.size > RECENT_MAX) recent.delete(recent.keys().next().value!);
  }
  return (cached = t);
}

/**
 * The map's grid: screen tile ids and palette slots, PAD tiles of margin
 * round it. Blocks first, on a block grid -- the border block, each
 * connected map painted over its side (east, west, south, north: blockPast's
 * order, the later winning a corner), the map's own -- then each block's
 * sixteen tiles through per-tile tables. Worked out a tile at a time
 * through mapTileAt this was ~13-41 ms under QuickJS on the PC, a second
 * and more on the console, at every map change in VIEW 2D.
 */
function buildTiles(world: any, map: any, key: string): MapTiles | null {
  const [atlas, tileset] = world.atlasFor(map.def);
  const img = image(atlas?.image);
  if (!img || !tileset) return null;
  const roof = image(atlas.roofImage);
  const tilePal: number[] = tileset.tilePalettes ?? [];
  const idOf = (tile: number): number =>
    ((roof && tile >= ROOF_FIRST && tile < ROOF_FIRST + ROOF_COUNT ? roof.ids[tile - ROOF_FIRST] : img.ids[tile]) ?? 0) & 0xffff;
  const palOf = (tile: number): number => ((tilePal[tile] ?? 1) - 1) & 7;
  const TILES = 512;
  const idT = new Uint16Array(TILES);
  const palT = new Uint8Array(TILES);
  for (let k = 0; k < TILES; k++) {
    idT[k] = idOf(k);
    palT[k] = palOf(k);
  }
  const mw = map.width ?? 0;
  const mh = map.height ?? 0;
  const pw = mw * 4 + 2 * PAD;
  const ph = mh * 4 + 2 * PAD;
  // the block grid: every block a padded tile can fall in
  const pb = Math.ceil(PAD / 4);
  const gw = mw + 2 * pb;
  const gh = mh + 2 * pb;
  const grid = new Int32Array(gw * gh).fill(map.blockId(-1, -1));
  const maps: Record<string, any> | undefined = world?.maps;
  const conns = map.connections as Record<string, { map?: string; mapId?: string; offset?: number }> | undefined;
  // a connected map's blocks onto the grid where they fall inside its side
  const paint = (dir: string, place: (d: any, off: number, x: number, y: number) => [number, number], side: (bx: number, by: number) => boolean): void => {
    const c = conns?.[dir];
    if (!c || !maps) return;
    const d = maps[(c.mapId ?? c.map) as string];
    if (!d || !Array.isArray(d.blocks)) return;
    const off = c.offset ?? 0;
    for (let y = 0; y < d.height; y++) {
      for (let x = 0; x < d.width; x++) {
        const [bx, by] = place(d, off, x, y);
        const gx = bx + pb;
        const gy = by + pb;
        if (gx < 0 || gy < 0 || gx >= gw || gy >= gh || !side(bx, by)) continue;
        const b = d.blocks[y * d.width + x];
        if (b !== undefined) grid[gy * gw + gx] = b;
      }
    }
  };
  paint("east", (_d, off, x, y) => [x + mw, y + off], (bx) => bx >= mw);
  paint("west", (d, off, x, y) => [x - d.width, y + off], (bx) => bx < 0);
  paint("south", (_d, off, x, y) => [x + off, y + mh], (_bx, by) => by >= mh);
  paint("north", (d, off, x, y) => [x + off, y - d.height], (_bx, by) => by < 0);
  const blocks: number[] = map.blocks ?? [];
  for (let by = 0; by < mh; by++) {
    const g0 = (by + pb) * gw + pb;
    for (let bx = 0; bx < mw; bx++) grid[g0 + bx] = blocks[by * mw + bx] ?? 0;
  }
  // the grid out to tiles (no block: tile 0, as mapTileAt answers). PAD
  // is whole blocks, so the block grid is the padded grid exactly and each
  // block row is two words of ids and one of palettes, from per-block rows
  // worked out the first time a block is met.
  const ids = new Uint16Array(pw * ph).fill(idT[0]!);
  const pal = new Uint8Array(pw * ph).fill(palT[0]!);
  const ids32 = new Uint32Array(ids.buffer);
  const pal32 = new Uint32Array(pal.buffer);
  const tsBlocks: number[][] = map.tileset?.blocks ?? [];
  const nb = tsBlocks.length;
  const bIds = new Uint32Array(nb * 8);
  const bPal = new Uint32Array(nb * 4);
  const ready = new Uint8Array(nb);
  const tid = (tile: number): number => (tile < TILES ? idT[tile]! : idOf(tile));
  const tpal = (tile: number): number => (tile < TILES ? palT[tile]! : palOf(tile));
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const b = grid[gy * gw + gx]!;
      if (b < 0 || b >= nb) continue;
      if (!ready[b]) {
        const block = tsBlocks[b];
        if (!block) continue;
        ready[b] = 1;
        for (let r = 0; r < 4; r++) {
          const t0 = block[r * 4] ?? 0, t1 = block[r * 4 + 1] ?? 0, t2 = block[r * 4 + 2] ?? 0, t3 = block[r * 4 + 3] ?? 0;
          bIds[b * 8 + r * 2] = (tid(t0) | (tid(t1) << 16)) >>> 0;
          bIds[b * 8 + r * 2 + 1] = (tid(t2) | (tid(t3) << 16)) >>> 0;
          bPal[b * 4 + r] = (tpal(t0) | (tpal(t1) << 8) | (tpal(t2) << 16) | (tpal(t3) << 24)) >>> 0;
        }
      }
      const at = gy * 4 * pw + gx * 4; // the block's top-left cell
      for (let r = 0; r < 4; r++) {
        const cell = at + r * pw;
        ids32[cell >> 1] = bIds[b * 8 + r * 2]!;
        ids32[(cell >> 1) + 1] = bIds[b * 8 + r * 2 + 1]!;
        pal32[cell >> 2] = bPal[b * 4 + r]!;
      }
    }
  }
  return { key, map, version: map.version ?? 0, pw, ph, ids, pal, idOf, blocks: blocks.slice() };
}

/**
 * The block at (bx, by), map block coordinates, past the edge too: a
 * connected map's (north at x + offset, y - its height, and so on round),
 * else the map's own answer (its border block).
 */
function blockPast(map: any, maps: Record<string, any> | undefined, bx: number, by: number): number {
  const w = map.width ?? 0;
  const h = map.height ?? 0;
  if (bx >= 0 && by >= 0 && bx < w && by < h) return map.blockId(bx, by);
  const conns = map.connections as Record<string, { map?: string; mapId?: string; offset?: number }> | undefined;
  if (conns && maps) {
    const at = (dir: string, nbx: (d: any, off: number) => number, nby: (d: any, off: number) => number): number => {
      const c = conns[dir];
      if (!c) return -1;
      const d = maps[(c.mapId ?? c.map) as string];
      if (!d || !Array.isArray(d.blocks)) return -1;
      const off = c.offset ?? 0;
      const x = nbx(d, off);
      const y = nby(d, off);
      if (x < 0 || y < 0 || x >= d.width || y >= d.height) return -1;
      return d.blocks[y * d.width + x] ?? -1;
    };
    let b = -1;
    if (by < 0) b = at("north", (_d, off) => bx - off, (d) => by + d.height);
    if (b < 0 && by >= h) b = at("south", (_d, off) => bx - off, () => by - h);
    if (b < 0 && bx < 0) b = at("west", (d) => bx + d.width, (_d, off) => by - off);
    if (b < 0 && bx >= w) b = at("east", () => bx - w, (_d, off) => by - off);
    if (b >= 0) return b;
  }
  return map.blockId(bx, by);
}

/** The tileset tile at 8 px tile (tx, ty) of `map`, past its edge too
 *  (blockPast): what the 2D view draws there. */
export function mapTileAt(world: any, map: any, tx: number, ty: number): number {
  const block = map.tileset?.blocks?.[blockPast(map, world?.maps, Math.floor(tx / 4), Math.floor(ty / 4))];
  return block ? block[(ty & 3) * 4 + (tx & 3)] ?? 0 : 0;
}

// per sheet path: the sheet, and its palette per OBJ palette id and time of day
const spriteCache = new Map<string, { sheet: LcdImage | null; pals: Map<string, Palette4 | null> }>();
const actors: any[] = [];

/** Draw the 2D overworld for this frame; false when there is nothing to draw. */
export function drawMap2D(world: any, data: any, options?: any): boolean {
  const lcd = currentLcd();
  const map = world?.map;
  if (!lcd || !map || typeof world.updateView !== "function") return false;
  world.updateView();
  const key = world.mapCacheKey(map.id);
  const t = tilesFor(world, map, key);
  if (!t) return false;
  const bgSet = world.bgSets?.[key] as Palette4[] | undefined;
  const camX = Math.floor(world.camera?.x ?? 0);
  const camY = Math.floor(world.camera?.y ?? 0);

  // the eight BG palettes in screen slots 0-7, so the grid's palette bytes
  // ARE the attribute bytes (drawn first in the frame, nothing holds a slot yet)
  for (let s = 0; s < 8; s++) {
    const p = bgSet?.[s] ?? bgSet?.[0];
    if (p) lcd.setPalette(s, p);
  }

  // the map: the under layer (sent once per cache), at the camera
  lcd.under(t, t.ids, t.pal, t.pw, t.ph);
  lcd.underAt(camX + PAD * 8, camY + PAD * 8);
  const canvas = lcd.canvasSupported() ? canvasSize(options) : null;
  if (canvas) lcd.underView(canvas.w, canvas.h, canvas.wide);
  // the water and flowers: each animated tile drawn as this step's frame
  let slot = 0;
  const anim = world.animCells?.[key];
  if (anim) {
    for (const k in anim) {
      const list = anim[k];
      const layer = list?.layer;
      if (!layer?.sheet || layer.kind === "scroll" || slot >= 16) continue;
      const strip = image(layer.sheet);
      if (!strip) continue;
      const row = (world.animRow(layer) ?? 1) - 1;
      const to = strip.ids[row * strip.tw];
      if (to === undefined) continue;
      lcd.alias(slot++, t.idOf(list.tile), to);
    }
  }
  for (; slot < 16; slot++) lcd.alias(slot, -1, 0);

  // The people, from the same list the voxel view stands up (World's
  // peopleView): OBJ sprites, the Y-sorted list's later entries on top (a
  // lower object index draws over a higher one, so they go in top-down).
  actors.length = 0;
  if (!world.peopleHidden) {
    const [hideAll, hidePlayer] = world.flyHides?.() ?? [false, false];
    // only the people near the player (the screen is ten cells wide)
    peopleView_W6(world, actors, hideAll, hidePlayer, false, true);
  }
  const sprites = data?.sprites ?? {};
  const daytime = world.daytime ?? "DAY";
  for (let k = actors.length - 1; k >= 0; k--) {
    const e = actors[k];
    const v = e?.view;
    if (!v || v.visible === false) continue;
    const gfx: string | undefined = v.gfx ?? sprites[v.spriteId]?.image;
    if (!gfx) continue;
    let s = spriteCache.get(gfx);
    if (!s) {
      s = { sheet: image(gfx), pals: new Map() };
      spriteCache.set(gfx, s);
    }
    const sheet = s.sheet;
    if (!sheet) continue;
    const pk = daytime + (v.palette ?? sprites[v.spriteId]?.paletteId ?? "");
    let colours = s.pals.get(pk);
    if (colours === undefined) {
      const def = sprites[v.spriteId] ?? { paletteId: v.palette };
      colours = (Palettes.spritePalette(world.palettes, daytime, def) as unknown as Palette4 | undefined) ?? null;
      s.pals.set(pk, colours);
    }
    const pal = colours ? lcd.palette(colours, true) : 0;
    const frames = Math.max(1, sheet.th >> 1);
    const f = Math.min(frames - 1, Math.max(0, v.frame ?? 0));
    const x0 = Math.round(v.px + (e.ox ?? 0) - camX);
    const y0 = Math.round(v.py + (e.oy ?? 0) - camY);
    const mirror = !!v.mirror;
    const flip = mirror ? 0x20 : 0;
    const grass = e.grassOver ? 0x80 : 0;
    for (let r = 0; r < 2; r++) {
      const row = (f * 2 + r) * sheet.tw;
      const y = y0 + r * 8;
      const a = sheet.ids[row];
      const b = sheet.ids[row + 1];
      const attr = pal | flip | (r === 1 ? grass : 0);
      if (canvas) {
        if (a !== undefined) lcd.underObj(mirror ? x0 + 8 : x0, y, a, attr);
        if (b !== undefined) lcd.underObj(mirror ? x0 : x0 + 8, y, b, attr);
      } else {
        if (a !== undefined) lcd.obj(mirror ? x0 + 8 : x0, y, a, attr);
        if (b !== undefined) lcd.obj(mirror ? x0 : x0 + 8, y, b, attr);
      }
    }
  }
  return true;
}
