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
// Not yet: animated tiles (water, flowers) stand still, a cut tree still
// shows, and past the map's edge the border block shows where the cart
// would show the connected map.

import { GbVideo, LCDC, OAM_ATTR, OAM_X_OFS, OAM_Y_OFS, type TileLoad } from "../gb/video.ts";
import type { Dir } from "./collision.ts";

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
 *  past the edge is 8 left/up, 10 right/down; the seam step one cell more). */
const PAD = 12;
/** Frames between checks that the map's blocks still match the cache (a
 *  door or barrier a script stamps mid-visit). */
const BLOCK_CHECK = 32;

interface MapTiles {
  map: any;
  /** Padded size in tiles. */
  w: number;
  h: number;
  ids: Uint8Array;
  /** The blocks the cache was built from. */
  blocks: number[];
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
    if (!t || t.map !== map || (++this.frame % BLOCK_CHECK === 0 && !sameBlocks(t.blocks, map.def.blocks))) {
      if (!t || t.map !== map) {
        this.slots.clear();
        this.loadsSize = -1;
      }
      t = this.tiles = buildTiles(map);
      this.winX = NaN;
    }
    const camX = Math.round(p.px) - 64;
    const camY = Math.round(p.py) - 64;

    // the map: the 21x19 window from (camX, camY) into the ring
    v.lcdc = LCDC.on | LCDC.bgOn | LCDC.objOn; // BG tiles from $9000, signed
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

    // the people, straight into OAM (the player first: on top)
    const oam = v.oam;
    oam.fill(0);
    this.oamN = 0;
    this.camX = camX;
    this.camY = camY;
    const gold = (game.data as { version?: string }).version === "gold";
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
        loads.push({ dest: slot * SHEET_TILES, sheet: `sprite:${sheet}`, first: 0, count: SHEET_TILES, wide: 2, stride: SPRITE_PAGE_TILES });
      }
      v.loads = loads;
    }

    // the map's SGB palette for all three registers, as the SGB coloured it
    const pal = game.data.mapPalette?.[map.id];
    const name = typeof pal === "number" && pal >= 0 ? `#${pal}` : "grey";
    const c = v.colours;
    if (c.bg !== name) v.colours = { bg: name, obj0: name, obj1: name };
    v.bgp = 0xe4;
    v.obp0 = 0xe4;
    v.obp1 = 0xe4;
    return v;
  }
  /** Sheets the current loads array was built for (-1: build it). */
  private loadsSize = -1;
  private oamN = 0;
  private camX = 0;
  private camY = 0;

  /** One person's four OAM entries (a 16x16 frame of its sheet). */
  private put(sheet: string, px: number, py: number, frame: number, mirror: boolean): void {
    const sx = Math.round(px) - this.camX;
    const sy = Math.round(py) - this.camY - 4;
    if (sx <= -16 || sy <= -16 || sx >= 160 || sy >= 144) return;
    let slot = this.slots.get(sheet);
    if (slot === undefined) {
      if (this.slots.size >= SHEETS_MAX) return;
      slot = this.slots.size;
      this.slots.set(sheet, slot);
    }
    const oam = this.video.oam;
    const base = slot * SHEET_TILES + frame * 4;
    const attr = mirror ? OAM_ATTR.xFlip : 0;
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

/** The map's tiles, PAD tiles of border round them, block by block. */
function buildTiles(map: any): MapTiles {
  const def = map.def;
  const w = def.width * 4 + PAD * 2;
  const h = def.height * 4 + PAD * 2;
  const ids = new Uint8Array(w * h);
  const tsBlocks: number[][] = map.tileset.blocks;
  const pb = PAD / 4; // padding in blocks
  for (let by = -pb; by < def.height + pb; by++) {
    for (let bx = -pb; bx < def.width + pb; bx++) {
      const block = tsBlocks[map.blockAt(bx, by)];
      if (!block) continue;
      const x0 = (bx + pb) * 4;
      const y0 = (by + pb) * 4;
      for (let r = 0; r < 4; r++) {
        const o = (y0 + r) * w + x0;
        ids[o] = block[r * 4]! & 0x7f;
        ids[o + 1] = block[r * 4 + 1]! & 0x7f;
        ids[o + 2] = block[r * 4 + 2]! & 0x7f;
        ids[o + 3] = block[r * 4 + 3]! & 0x7f;
      }
    }
  }
  return { map, w, h, ids, blocks: [...(def.blocks ?? [])] };
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
