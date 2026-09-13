// voxelmon/cook/atlas.ts — CLUT8 atlas pages + palettes.
//
// Pages are pre-swizzled (16-byte x 8-row blocks, engine pak.rs
// swizzle_stride/swizzle_rows — mirrored byte-for-byte from
// pocketvoxel-core/src/pak/builder.rs swizzle()). Palettes: one per
// ATLAS_KIND; entries 0..3 are the GB shades, 0xff transparent, rest black.
//
// TERRAIN is ONE combined page: every tileset sheet the cooked maps use,
// stacked vertically — the core binds `page_of_kind(TERRAIN)` for every
// chunk mesh (draw.rs), so all chunk UVs must live in one page. Animated
// tilesets bake the full 8-step water/flower cycle as whole-page frame
// variants (gen1recomp TileRenderer.lua:74-92): water tile rows rotate by
// WATER_OFFSETS per step, the flower tile cycles flower1-3.

import {
  ATLAS_KIND,
  UI_PAGE_COLS,
  UI_PAGE_ROWS,
  UI_PAGE_TILES,
  UI_TILE,
} from "../../contracts/spec/voxel-spec.ts";
import { ANIM_STEPS, FLOWER_FRAMES, WATER_OFFSETS, defaultAnimatedTiles } from "./classify.ts";
import { type Art, artOf, type GenData, PX_CLEAR, sheetKeyOf, type TilesetDef } from "./data.ts";
import { type Redpp, SHADES } from "./redpp.ts";

// ---------------------------------------------------------------------------
// swizzle (builder.rs:27 — the exact transform the reader inverts)
// ---------------------------------------------------------------------------

export const swizzleStride = (w: number): number => Math.ceil(w / 16) * 16;
export const swizzleRows = (h: number): number => Math.ceil(h / 8) * 8;
export const swizzledLen = (w: number, h: number): number => swizzleStride(w) * swizzleRows(h);

export function swizzle(w: number, h: number, linear: Uint8Array): Uint8Array {
  if (linear.length !== w * h) throw new Error("linear texel size mismatch");
  const stride = swizzleStride(w);
  const rows = swizzleRows(h);
  const out = new Uint8Array(stride * rows);
  let dst = 0;
  for (let blockY = 0; blockY < rows / 8; blockY++) {
    for (let blockX = 0; blockX < stride / 16; blockX++) {
      for (let row = 0; row < 8; row++) {
        const y = blockY * 8 + row;
        for (let column = 0; column < 16; column++) {
          const x = blockX * 16 + column;
          if (x < w && y < h) out[dst + column] = linear[y * w + x];
        }
        dst += 16;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// palettes
// ---------------------------------------------------------------------------

/** GB shade -> opaque ABGR gray (0 lightest). */
const SHADE_ABGR = [0xffffffff, 0xffaaaaaa, 0xff555555, 0xff000000];

export function gbPalette(): Uint32Array {
  const pal = new Uint32Array(256).fill(0xff000000);
  for (let i = 0; i < 4; i++) pal[i] = SHADE_ABGR[i];
  pal[PX_CLEAR] = 0x00000000; // transparent
  return pal;
}

/** One SGB SuperPalette as a 256-entry CLUT: entries 0..3 are its 4 colors
 * (palettes.json stores lightest first, so color i lands on GB shade i),
 * PX_CLEAR transparent, the rest black — the gbPalette shape recolored. */
export function sgbPalette(rgb: [number, number, number][]): Uint32Array {
  const pal = new Uint32Array(256).fill(0xff000000);
  for (let i = 0; i < 4; i++) {
    const [r, g, b] = rgb[i];
    pal[i] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
  }
  pal[PX_CLEAR] = 0x00000000; // transparent
  return pal;
}

/**
 * The VPAL list (voxel-spec.ts §VXPK_TAG.palette): one GB grayscale default
 * per ATLAS_KIND, then every SGB SuperPalette in the ROM's own order — the
 * `palette` op's index i selects VPAL[4 + i], and gamedata's `mapPalette`
 * values index the same order. That PREFIX is a compatibility guarantee:
 * `draw::SGB_PAL_BASE` is 4 and the `mapPalette` contract stays valid
 * whatever the tail carries.
 *
 * `extra` appends the RED++ color CLUTs (world, OBJ, pic — cook/redpp.ts),
 * whose absolute VPAL indices the VCOL section names; the base length is
 * what turns a tail position into that index.
 */
export function buildPalettes(gen: GenData, extra: Uint32Array[] = []): Uint32Array[] {
  const defaults = Object.keys(ATLAS_KIND).map(() => gbPalette());
  const sgb = gen.palettes.order.map((name) => {
    const rgb = gen.palettes.palettes[name];
    if (!rgb) throw new Error(`palettes.json order names a missing palette: ${name}`);
    return sgbPalette(rgb);
  });
  return [...defaults, ...sgb, ...extra];
}

/** The VPAL index the RED++ tail starts at (= 4 kind defaults + the SGB set). */
export function paletteBase(gen: GenData): number {
  return Object.keys(ATLAS_KIND).length + gen.palettes.order.length;
}

// ---------------------------------------------------------------------------
// pages
// ---------------------------------------------------------------------------

export interface PageDef {
  w: number;
  h: number;
  kind: number;
  /** LINEAR frames (swizzled at pack time). */
  frames: Uint8Array[];
  /** Debug name (not packed). */
  name: string;
}

export interface TerrainLayout {
  page: PageDef;
  /** sheet gfx key -> y offset of that sheet inside the combined page. */
  baseY: Map<string, number>;
  /**
   * Sheet gfx keys whose texels carry RED++ group indices (`group*4+shade`)
   * instead of raw GB shades. A map drawn from one of these MUST bind a
   * world palette (cook/redpp.ts); a sheet the pack has no data for stays
   * byte-identical to a cook without the pack.
   */
  bakedSheets: Set<string>;
}

function blitArt(dst: Uint8Array, dstW: number, art: Art, dx: number, dy: number): void {
  for (let y = 0; y < art.h; y++) {
    for (let x = 0; x < art.w; x++) {
      dst[(dy + y) * dstW + (dx + x)] = art.px(x, y);
    }
  }
}

/**
 * The combined terrain page over the tilesets the cooked maps use.
 *
 * With a RED++ pack, every tile's texels are rewritten to `group*4+shade`
 * AFTER the water-rotate / flower-frame substitutions, so an animated tile
 * picks up its DESTINATION tile's group — matching the reference, whose
 * `buildAnim` recolors through the same `gbc` context
 * (gen1recomp TileRenderer.lua:343-353).
 */
export function buildTerrainPage(
  gen: GenData,
  tilesets: TilesetDef[],
  redpp?: Redpp | null,
): TerrainLayout {
  // distinct sheets, sorted by key for determinism
  const sheets = [...new Set(tilesets.map(sheetKeyOf))].sort();
  const baseY = new Map<string, number>();
  let h = 0;
  for (const key of sheets) {
    const e = gen.gfx[key];
    if (!e) throw new Error(`missing tileset sheet: ${key}`);
    baseY.set(key, h);
    h += e.h;
  }
  const w = 128;

  // which sheets animate (any using tileset declares water/flower cycles)
  const animated = new Map<string, TilesetDef>();
  for (const ts of tilesets) {
    if (defaultAnimatedTiles(ts.animation).length > 0) animated.set(sheetKeyOf(ts), ts);
  }
  const frameCount = animated.size > 0 ? ANIM_STEPS : 1;

  const frames: Uint8Array[] = [];
  for (let step = 0; step < frameCount; step++) {
    const linear = new Uint8Array(w * h).fill(PX_CLEAR);
    for (const key of sheets) {
      const art = artOf(gen, key)!;
      const y0 = baseY.get(key)!;
      blitArt(linear, w, art, 0, y0);
      const ts = animated.get(key);
      if (!ts) continue;
      const perRow = ts.tilesPerRow || 16;
      for (const spec of defaultAnimatedTiles(ts.animation)) {
        const tx = (spec.tile % perRow) * 8;
        const ty = Math.floor(spec.tile / perRow) * 8 + y0;
        if (spec.kind === "hshift") {
          // rotate the tile's rows right by the step's cumulative offset
          // (TileRenderer.lua:201-208: setPixel((x + o) % 8, y, src[x]))
          const o = WATER_OFFSETS[step % WATER_OFFSETS.length];
          for (let yy = 0; yy < 8; yy++) {
            for (let xx = 0; xx < 8; xx++) {
              linear[(ty + yy) * w + tx + ((xx + o) % 8)] = art.px(tx + xx, ty - y0 + yy);
            }
          }
        } else {
          const n = FLOWER_FRAMES[step % FLOWER_FRAMES.length];
          const frame = artOf(gen, `tilesets/flower${n}`);
          if (frame) {
            for (let yy = 0; yy < 8; yy++) {
              for (let xx = 0; xx < 8; xx++) {
                linear[(ty + yy) * w + tx + xx] = frame.px(xx, yy);
              }
            }
          }
        }
      }
    }
    frames.push(linear);
  }

  const bakedSheets = bakeGroups(gen, tilesets, redpp, frames, w, baseY);

  return {
    page: { w, h, kind: ATLAS_KIND.terrain, frames, name: "terrain" },
    baseY,
    bakedSheets,
  };
}

/**
 * Rewrite every tile region's texels from a GB shade to `group*4+shade`.
 * `PX_CLEAR` survives untouched (it is the alpha-test cutout, not a shade).
 *
 * v1 keeps ONE terrain page, so two tilesets sharing a sheet must agree
 * tile-for-tile: measured 0 of the 4 v1 sheets disagree (2 of 19 whole-game
 * — `gate.png`, `pokecenter.png`). A disagreement is a hard cook error, not
 * a silent mis-bake; the VCOL record reserves a `terrain_page` field so the
 * page splitter can land later without a format change.
 */
function bakeGroups(
  gen: GenData,
  tilesets: TilesetDef[],
  redpp: Redpp | null | undefined,
  frames: Uint8Array[],
  w: number,
  baseY: Map<string, number>,
): Set<string> {
  const baked = new Set<string>();
  if (!redpp) return baked;

  const bySheet = new Map<string, TilesetDef[]>();
  for (const ts of tilesets) {
    const key = sheetKeyOf(ts);
    const list = bySheet.get(key);
    if (list) {
      if (!list.some((t) => t.id === ts.id)) list.push(ts);
    } else {
      bySheet.set(key, [ts]);
    }
  }

  for (const [key, list] of bySheet) {
    const known = list.filter((ts) => redpp.hasTileset(ts.id));
    if (known.length === 0) continue; // a tileset the pack has no data for
    if (known.length !== list.length) {
      const missing = list.filter((ts) => !redpp.hasTileset(ts.id)).map((t) => t.id);
      throw new Error(
        `RED++ color: sheet ${key} mixes tilesets with and without pack data ` +
          `(missing: ${missing.join(", ")}) — split the page or extend the pack`,
      );
    }
    const vectors = new Set(known.map((ts) => redpp.groupVectorKey(ts.id)));
    if (vectors.size > 1) {
      throw new Error(
        `RED++ color: tilesets ${known.map((t) => t.id).join(", ")} share sheet ` +
          `${key} but resolve DIFFERENT tile groups — v1 bakes one terrain page, ` +
          `so this sheet needs a per-tileset page copy (see cook/redpp.ts)`,
      );
    }

    const ts = known[0];
    const e = gen.gfx[key];
    if (!e) throw new Error(`missing tileset sheet: ${key}`);
    const y0 = baseY.get(key)!;
    const perRow = ts.tilesPerRow || 16;
    const cols = Math.floor(e.w / 8);
    const rows = Math.floor(e.h / 8);
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const tileId = row * perRow + col;
        // The page is shared across maps, so the per-MAP exception table
        // cannot apply here — cli.ts refuses to cook a map that needs one.
        const group = redpp.groupOf(ts.id, null, tileId);
        if (group === null) continue;
        const shift = group * SHADES;
        for (const frame of frames) {
          for (let y = 0; y < 8; y++) {
            const dst = (y0 + row * 8 + y) * w + col * 8;
            for (let x = 0; x < 8; x++) {
              const px = frame[dst + x];
              if (px === PX_CLEAR) continue;
              frame[dst + x] = shift + (px & 3);
            }
          }
        }
      }
    }
    baked.add(key);
  }
  return baked;
}

/**
 * One sprite page per walk sheet (16x16 cells stacked vertically), padded to
 * 64 px wide: the GE missamples 16-px-wide pages (bisected on device and
 * under PPSSPPHeadless — a 128-wide page through the same card draw renders
 * perfectly). Content stays at x in [0, 16); draw.rs normalizes card U by
 * CELL_PX / page.w, so the pad is never sampled.
 */
export const SPRITE_PAGE_W = 64;
export function buildSpritePage(gen: GenData, key: string): PageDef {
  const art = artOf(gen, key);
  if (!art) throw new Error(`missing sprite sheet: ${key}`);
  const w = Math.max(art.w, SPRITE_PAGE_W);
  const linear = new Uint8Array(w * art.h).fill(PX_CLEAR);
  for (let y = 0; y < art.h; y++)
    for (let x = 0; x < art.w; x++) linear[y * w + x] = art.px(x, y);
  return { w, h: art.h, kind: ATLAS_KIND.sprites, frames: [linear], name: key };
}

/** The emote page: gen's 48x16 horizontal strip restacked 16x48 vertical
 *  (the core's sheet_uv stacks 16x16 cells vertically). */
export function buildEmotePage(gen: GenData): PageDef | null {
  const art = artOf(gen, "emotes");
  if (!art) return null;
  const bubbles = Math.floor(art.w / 16);
  // The overworld 16x16 sheet. The GB emotion bubbles come first, then any
  // field effect that needs to be drawn at a world position — currently just
  // HM Cut's tree sprite, which pokered flickers over the tree it fells
  // (AnimateCutTree). They share this page because it is the one 16x16 sheet
  // every pak already carries, so an effect costs a cell rather than a new
  // page and a new META field to find it by.
  //
  // Order is the contract: spec's FX_FRAME_CUT_TREE indexes past the
  // bubbles, so extras must only ever be APPENDED.
  const extras = ["fx/cut_tree"];
  const extraArt = extras.map((k) => artOf(gen, k));
  const cells = bubbles + extraArt.filter((a) => a).length;
  // Same 64-wide pad as buildSpritePage (the GE missamples 16-px pages).
  const linear = new Uint8Array(SPRITE_PAGE_W * cells * 16).fill(PX_CLEAR);
  const blit = (cell: number, src: Art, sx: number): void => {
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        linear[(cell * 16 + y) * SPRITE_PAGE_W + x] = src.px(sx + x, y);
      }
    }
  };
  for (let i = 0; i < bubbles; i++) blit(i, art, i * 16);
  let cell = bubbles;
  for (const a of extraArt) {
    if (a) blit(cell++, a, 0);
  }
  return {
    w: SPRITE_PAGE_W,
    h: cells * 16,
    kind: ATLAS_KIND.sprites,
    frames: [linear],
    name: "emotes",
  };
}

/**
 * The UI page: ONE 128x128 page, tile id = GB tile code (SCHEMA.md §UI):
 * font_extra tiles at extraBase (0x60..0x7f), font glyphs at mainBase
 * (0x80..0xff), 16 tiles per row, 8x8 tiles, tile 0 transparent.
 */
/**
 * The six slot symbols, cut out of SlotMachineTiles2 and laid into the UI
 * page as 2x2 tiles each (UI_TILE.slotSymbol).
 *
 * They are not laid out in that sheet — they are assembled from it. Each
 * symbol's `tiles` value in field.slotSymbols is a 16-bit pair: the HIGH byte
 * names the sheet tile its top half starts at, the LOW byte its bottom half,
 * and each half is a 16-WIDE strip spanning two of the sheet's four columns
 * (build_rom_data.py's crop). So one symbol reads two 16x8 strips from
 * anywhere in the sheet and stacks them.
 */
function placeSlotSymbols(
  gen: GenData,
  put: (read: (x: number, y: number) => number, tile: number) => void,
): void {
  const art = artOf(gen, "slots/wheel");
  const cfg = (gen.field as {
    slotSymbols?: { order?: string[]; symbols?: Record<string, { tiles?: number }> };
  }).slotSymbols;
  const order = cfg?.order;
  if (!art || !Array.isArray(order) || !cfg?.symbols) return;
  const cols = Math.floor(art.w / 8); // 4
  order.forEach((name, i) => {
    const tiles = cfg.symbols?.[name]?.tiles;
    if (typeof tiles !== "number") return;
    const halves = [tiles >> 8, tiles & 0xff]; // top, bottom
    const base = UI_TILE.slotSymbol + i * UI_TILE.slotSymbolStride;
    halves.forEach((strip, half) => {
      const sx = (strip % cols) * 8;
      const sy = Math.floor(strip / cols) * 8;
      // the strip is 16 wide: its left 8 go in the symbol's left column, its
      // right 8 in the right one
      put((x, y) => art.px(sx + x, sy + y), base + half * 2);
      put((x, y) => art.px(sx + 8 + x, sy + y), base + half * 2 + 1);
    });
  });
}

export function buildUiPage(gen: GenData): PageDef {
  const w = UI_PAGE_COLS * 8;
  const h = UI_PAGE_ROWS * 8;
  const linear = new Uint8Array(w * h).fill(PX_CLEAR);
  /** Copy one 8x8 source cell into the page at `tile`. */
  const put = (read: (x: number, y: number) => number, tile: number): void => {
    if (tile >= UI_PAGE_TILES) return;
    const dx = (tile % UI_PAGE_COLS) * 8;
    const dy = Math.floor(tile / UI_PAGE_COLS) * 8;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        // GB UI tiles are opaque white-backed (the textbox interior must
        // cover the world); only the unset tile 0 stays transparent.
        const px = read(x, y);
        linear[(dy + y) * w + dx + x] = px === PX_CLEAR ? 0 : px;
      }
    }
  };
  const place = (art: Art, base: number): void => {
    // Source rows are the sheet's own width in tiles (font sheets are 16
    // wide, the battle HUD pages 15 and 3).
    const glyphsPerRow = Math.floor(art.w / 8);
    const count = Math.floor(art.w / 8) * Math.floor(art.h / 8);
    for (let g = 0; g < count; g++) {
      const sx = (g % glyphsPerRow) * 8;
      const sy = Math.floor(g / glyphsPerRow) * 8;
      const tile = base + g;
      if (tile >= UI_PAGE_TILES) break;
      const dx = (tile % UI_PAGE_COLS) * 8;
      const dy = Math.floor(tile / UI_PAGE_COLS) * 8;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          // GB UI tiles are opaque white-backed (the textbox interior must
          // cover the world); only the unset tile 0 stays transparent.
          const px = art.px(sx + x, sy + y);
          linear[(dy + y) * w + dx + x] = px === PX_CLEAR ? 0 : px;
        }
      }
    }
  };
  const extra = artOf(gen, "fonts/font_extra");
  if (extra) place(extra, gen.font.extraBase);
  const font = artOf(gen, "fonts/font");
  if (font) place(font, gen.font.mainBase);
  // The in-battle HUD overlay (gen1recomp HudTiles.lua PAGES): pokered
  // overlays the $62-$78 font area — font_battle_extra at $62, then the
  // three HUD line pages on top of its tail ($6D/$73/$76). The textbox
  // borders at $79-$7F survive; battle and overworld share one UI page.
  for (const [key, base] of [
    ["battle/font_battle_extra", 0x62],
    ["battle/battle_hud_1", 0x6d],
    ["battle/battle_hud_2", 0x73],
    ["battle/battle_hud_3", 0x76],
  ] as const) {
    const sheet = artOf(gen, key);
    if (sheet) place(sheet, base);
  }
  // A left-pointing arrow, mirrored from the font's own ▶ (charmap $ED) into
  // a free low code. Placed AFTER the font, which is where $ED comes from.
  {
    const src = 0xed;
    const dst = UI_TILE.arrowLeft;
    const sx = (src % UI_PAGE_COLS) * 8;
    const sy = Math.floor(src / UI_PAGE_COLS) * 8;
    const dx = (dst % UI_PAGE_COLS) * 8;
    const dy = Math.floor(dst / UI_PAGE_COLS) * 8;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        linear[(dy + y) * w + dx + x] = linear[(sy + y) * w + sx + (7 - x)]!;
      }
    }
  }
  // Trainer-card art (voxel-spec.ts UI_TILE) in the tiles below 0x60, which
  // the GB's own UI never uses. Each sheet's tile order IS the drawing
  // order the card wants, so `place` needs no special case: the badges strip
  // is 2 tiles wide, giving each gym its 4 face then 4 badge tiles in order.
  for (const [key, base] of [
    ["trainer_card/frame", UI_TILE.frame],
    ["trainer_card/circle", UI_TILE.circle],
    ["trainer_card/numbers", UI_TILE.number],
    ["trainer_card/badges", UI_TILE.badge],
  ] as const) {
    const sheet = artOf(gen, key);
    if (sheet) place(sheet, base);
  }
  placeSlotSymbols(gen, put);
  return { w, h, kind: ATLAS_KIND.ui, frames: [linear], name: "ui" };
}

/** One pics page per battle pic gfx key. */
export function buildPicPage(gen: GenData, key: string): PageDef {
  const art = artOf(gen, key);
  if (!art) throw new Error(`missing pic: ${key}`);
  const linear = new Uint8Array(art.w * art.h);
  blitArt(linear, art.w, art, 0, 0);
  return { w: art.w, h: art.h, kind: ATLAS_KIND.pics, frames: [linear], name: key };
}

/**
 * The TOWN MAP background, composed into one 160x144 page.
 *
 * The layout is field.townMap.background.map — the 20x18 tile indices the
 * extractor decompressed out of LoadTownMap's RLE — indexing the 16-tile
 * WorldMapTileGraphics sheet. Composing it at cook time means the gear draws
 * the whole map with a single uiSpriteBottom instead of 360 tile writes, and
 * it needs no room in the UI page's tile codes, which the trainer card has
 * nearly filled.
 *
 * Returns null when either half is missing, so a dataset without the town map
 * cooks a pak with no map page rather than failing.
 */
export function buildTownMapPage(gen: GenData): PageDef | null {
  const art = artOf(gen, "townmap/tiles");
  const tm = (gen.field as { townMap?: { background?: { map?: number[] } } }).townMap;
  const layout = tm?.background?.map;
  if (!art || !Array.isArray(layout) || layout.length !== 20 * 18) return null;
  const w = 20 * 8;
  const h = 18 * 8;
  const linear = new Uint8Array(w * h);
  const perRow = Math.floor(art.w / 8); // the sheet is 4 tiles across
  for (let cell = 0; cell < layout.length; cell++) {
    const tile = layout[cell]!;
    const sx = (tile % perRow) * 8;
    const sy = Math.floor(tile / perRow) * 8;
    const dx = (cell % 20) * 8;
    const dy = Math.floor(cell / 20) * 8;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        // The map is opaque paper: its cut-out is the sea, which the GB
        // draws as shade 0. Same treatment buildUiPage gives a UI tile.
        const px = art.px(sx + x, sy + y);
        linear[(dy + y) * w + dx + x] = px === PX_CLEAR ? 0 : px;
      }
    }
  }
  return { w, h, kind: ATLAS_KIND.pics, frames: [linear], name: "townmap/background" };
}

/**
 * The same pic with its transparent pixels flooded to shade 0 (white) — the
 * treatment buildUiPage already gives UI tiles, for the same reason.
 *
 * A pic draws UNDER the ui layer (draw.rs ranks ScreenPic 8, UiQuad 9), so a
 * pic shown inside a menu has to bring its own background: 2271 of Red's
 * 3136 pixels are transparent, and left that way the diorama shows through
 * most of the trainer card's portrait. Cooked as its own page so the title
 * screen's copy keeps its transparency, where the art sits over the logo
 * screen and the cut-out is the point.
 */
export function buildOpaquePicPage(gen: GenData, key: string, name: string): PageDef {
  const art = artOf(gen, key);
  if (!art) throw new Error(`missing pic: ${key}`);
  const linear = new Uint8Array(art.w * art.h);
  for (let y = 0; y < art.h; y++) {
    for (let x = 0; x < art.w; x++) {
      const px = art.px(x, y);
      linear[y * art.w + x] = px === PX_CLEAR ? 0 : px;
    }
  }
  return { w: art.w, h: art.h, kind: ATLAS_KIND.pics, frames: [linear], name };
}
