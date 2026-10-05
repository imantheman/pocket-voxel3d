// Port of gen1recomp src/ui/game3/pokedex_chrome.lua (GPLv3 + additional terms; see LICENSE.md).
// Pokédex Chrome loader and authentic rendering engine for FRLG Pokédex.
// Implements the authentic diamond paper background, header/footer bars,
// orange section headings, type badges, 2-page cards, and pulsing habitat spotlights.

import { byte, format, mod as luaMod, tonumber, tostring } from "../../../import/gen3/lua.ts";
import { seq, type LuaTable } from "../platform/lt.ts";
import { gsub } from "../platform/lpattern.ts";
import { G, type Shader } from "../platform/graphics.ts";
import { newImageData, type Image, type Quad } from "../platform/image.ts";
import { Fs } from "../platform/fs.ts";
import { luaLoad } from "../platform/luadata.ts";
import { NotPortedError } from "../notported.ts";
// required at load by Brian's module; nothing here calls it (a bare import:
// no binding is read while the import cycle loads)
import "../core/display.ts";
import { Extract } from "../../../import/gen3/extract_island1.ts";
import { PokedexData } from "../core/pokedex_data.ts";
import { Dataset } from "../core/dataset.ts";
import { CacheFs } from "../shared/import/CacheFs.ts";
import { FrlgFont, type Colors } from "./frlg_font.ts";
import { SummaryChrome } from "./summary_chrome.ts";
import { Pokemon } from "../core/pokemon.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Lua's `pcall(require, X)` followed by a call into it: while X is still a
 * stub it stands for a failed require.
 */
function viaStub<T>(f: () => T): T | undefined {
  try {
    return f();
  } catch (e) {
    if (e instanceof NotPortedError) return undefined;
    throw e;
  }
}

// Lua: pokedex_chrome.lua:17
function cache_root(): string {
  if (Dataset && Dataset.mountExtractRoots) {
    viaStub(() => Dataset.mountExtractRoots());
  }
  return Extract.CACHE_ROOT || "data/generated/gba";
}

// Lua: pokedex_chrome.lua:25
function pokedex_root(): string {
  return cache_root() + "/pokemon/pokedex";
}

// Lua: pokedex_chrome.lua:29
function read_bytes(rel: string): string | undefined {
  if (Dataset && Dataset.cache) {
    const d = viaStub(() => Dataset.cache().read(rel));
    if (typeof d === "string" && d.length > 0) return d;
  }
  if (CacheFs && CacheFs.readActive) {
    const d = viaStub(() => CacheFs.readActive(rel));
    if (typeof d === "string" && d.length > 0) return d;
  }
  let d = Fs.read(rel);
  if (typeof d === "string" && d.length > 0) return d;
  const alt = "data/generated/gba/" + gsub(rel, "^data/generated/gba/", "")[0];
  d = Fs.read(alt);
  if (typeof d === "string" && d.length > 0) return d;
  // NOT FAITHFUL: the io.open candidates -- no stdio on the 3DS; Fs above
  // reads the same two paths.
  return undefined;
}

type TransparentKey = (r: number, g: number, b: number) => boolean;

// Lua: pokedex_chrome.lua:62
function rgba_to_image(rgba: string | undefined, w: number, h: number, transparentKey?: TransparentKey): Image | undefined {
  if (!rgba || rgba.length < w * h * 4) return undefined;

  let imageData;
  if (!transparentKey) {
    // the same pixels as Brian's per-pixel setPixel loop, in one copy
    imageData = newImageData(w, h, "rgba8", rgba.length === w * h * 4 ? rgba : rgba.slice(0, w * h * 4));
  } else {
    imageData = newImageData(w, h);
    let i = 1;
    for (let y = 0; y <= h - 1; y++) {
      for (let x = 0; x <= w - 1; x++) {
        const r = (byte(rgba, i) ?? 0) / 255;
        const g = (byte(rgba, i + 1) ?? 0) / 255;
        const b = (byte(rgba, i + 2) ?? 0) / 255;
        let a = (byte(rgba, i + 3) ?? 0) / 255;
        if (transparentKey(byte(rgba, i) ?? 0, byte(rgba, i + 1) ?? 0, byte(rgba, i + 2) ?? 0)) {
          a = 0;
        }
        imageData.setPixel(x, y, r, g, b, a);
        i = i + 4;
      }
    }
  }

  const image = G.newImage(imageData);
  if (image.setFilter) image.setFilter("nearest", "nearest");
  return image;
}

interface TexSpec { key: string; file: string; w: number; h: number; trans?: TransparentKey }

const CARD_SHEET_COLS = 8;

interface CardLayout {
  left: number; top: number; width: number; height: number; divTile?: number;
  x: number; y: number; w: number; h: number;
  borderLeft: number; borderRight: number; borderTop: number; borderBottom: number; borderThickness: number;
  dividerY?: number; upperY: number; upperH: number; lowerY?: number; lowerH?: number;
}

// Lua: pokedex_chrome.lua:236
function card_layout(left: number, top: number, width: number, height: number, divTile?: number): CardLayout {
  const L: CardLayout = {
    left, top, width, height,
    divTile,
    x: left * 8,
    y: top * 8,
    w: (width + 2) * 8,
    h: (height + 2) * 8,
    borderLeft: left * 8 + 1,
    borderRight: (left + 1 + width) * 8 + 5,
    borderTop: top * 8 + 1,
    borderBottom: (top + 1 + height) * 8 + 5,
    borderThickness: 2,
    upperY: 0, upperH: 0,
  };
  if (divTile != null) {
    L.dividerY = divTile * 8;
    L.upperY = L.borderTop + 2;
    L.upperH = L.dividerY - L.upperY;
    L.lowerY = L.dividerY + 8;
    L.lowerH = L.borderBottom - L.lowerY;
  } else {
    L.upperY = L.borderTop + 2;
    L.upperH = L.borderBottom - L.upperY;
  }
  return L;
}

// Lua: pokedex_chrome.lua:367
function draw_card(keyIn: string, layoutFn: () => CardLayout): void {
  const [sheet, variant] = PokedexChrome.cardSheet();
  let key = keyIn;
  let img: Image | undefined;
  if (sheet) {
    key = key + "_" + variant;
    img = PokedexChrome._images[key] || undefined;
    if (!img) {
      img = rgba_to_image(PokedexChrome.composeCard(layoutFn(), sheet), 240, 160);
      PokedexChrome._images[key] = img;
    }
  }
  if (!img) {
    throw new Error("PokedexChrome: dex_tiles_" + tostring(variant || "kanto") + ".rgba is not in the cache");
  }
  G.setColor(1, 1, 1, 1);
  G.draw(img, 0, 0);
  PokedexChrome.drawBars();
}

/** Texture quads cache for pokedex */
// Lua: pokedex_chrome.lua:465
function get_pokedex_quad(key: string, x: number, y: number, w: number, h: number, sw: number, sh: number): Quad {
  if (!PokedexChrome._quads) PokedexChrome._quads = {};
  if (!PokedexChrome._quads[key]) {
    PokedexChrome._quads[key] = G.newQuad(x, y, w, h, sw, sh);
  }
  return PokedexChrome._quads[key]!;
}

/** Type badge mapping in menu_info.png (128x128) */
const TYPE_RECTS: Record<number, { x: number; y: number; w: number; h: number }> = {
  0: { x: 0, y: 16, w: 32, h: 12 }, // NORMAL
  1: { x: 32, y: 48, w: 32, h: 12 }, // FIGHTING
  2: { x: 0, y: 48, w: 32, h: 12 }, // FLYING
  3: { x: 0, y: 64, w: 32, h: 12 }, // POISON
  4: { x: 64, y: 32, w: 32, h: 12 }, // GROUND
  5: { x: 32, y: 32, w: 32, h: 12 }, // ROCK
  6: { x: 96, y: 48, w: 32, h: 12 }, // BUG
  7: { x: 64, y: 48, w: 32, h: 12 }, // GHOST
  8: { x: 64, y: 64, w: 32, h: 12 }, // STEEL
  9: { x: 32, y: 80, w: 32, h: 12 }, // MYSTERY
  10: { x: 32, y: 16, w: 32, h: 12 }, // FIRE
  11: { x: 64, y: 16, w: 32, h: 12 }, // WATER
  12: { x: 96, y: 16, w: 32, h: 12 }, // GRASS
  13: { x: 0, y: 32, w: 32, h: 12 }, // ELECTRIC
  14: { x: 32, y: 64, w: 32, h: 12 }, // PSYCHIC
  15: { x: 96, y: 32, w: 32, h: 12 }, // ICE
  16: { x: 0, y: 80, w: 32, h: 12 }, // DRAGON
  17: { x: 96, y: 64, w: 32, h: 12 }, // DARK
};

const AREA_MARKER_KEYS: Record<string, string> = {
  MARKER_CIRCULAR: "marker_0",
  MARKER_SMALL_H: "marker_1",
  MARKER_SMALL_V: "marker_2",
  MARKER_MED_H: "marker_3",
  MARKER_MED_V: "marker_4",
  MARKER_LARGE_H: "marker_5",
  MARKER_LARGE_V: "marker_6",
};

// Lua: pokedex_chrome.lua:635
function paint_area_marker(img: Image | undefined, x: number, y: number): void {
  if (img) {
    G.draw(img, x, y);
  } else {
    G.ellipse("fill", x + 4, y + 4, 4, 4);
  }
}

const CONTROL_INFO_COLORS = { fg: seq(1, 1, 1, 1), shadow: seq(98 / 255, 98 / 255, 98 / 255, 1), bg: undefined } as Colors;

export const PokedexChrome: any = {
  _cache: undefined as unknown,
  _images: {} as Record<string, Image | false | undefined>,
  _footprints: {} as Record<number, Image>,
  _installed: false,
  _animTimer: 0,
  _sheets: undefined as Record<string, string | undefined> | undefined,
  _colors: undefined as LuaTable,
  _quads: undefined as Record<string, Quad> | undefined,
  _menuInfo: undefined as Image | undefined,
  _silhouetteShader: undefined as Shader | undefined,

  // Lua: pokedex_chrome.lua:87
  install(cache?: unknown): boolean {
    if (PokedexChrome._installed && !cache) return true;
    PokedexData.init();

    const root = pokedex_root();

    const textures: TexSpec[] = [
      { key: "paper_bg", file: "paper_bg.rgba", w: 240, h: 160 },
      { key: "caught_marker", file: "caught_marker.rgba", w: 8, h: 8 },
      { key: "mini_page", file: "mini_page.rgba", w: 64, h: 40 },
      { key: "blit_wide_ellipse", file: "blit_wide_ellipse.rgba", w: 88, h: 16 },
      { key: "map_kanto", file: "map_kanto.rgba", w: 96, h: 72 },
      { key: "map_one_island", file: "map_one_island.rgba", w: 32, h: 24 },
      { key: "map_two_island", file: "map_two_island.rgba", w: 32, h: 24 },
      { key: "map_three_island", file: "map_three_island.rgba", w: 32, h: 24 },
      { key: "map_four_island", file: "map_four_island.rgba", w: 32, h: 32 },
      { key: "map_five_island", file: "map_five_island.rgba", w: 32, h: 32 },
      { key: "map_six_island", file: "map_six_island.rgba", w: 32, h: 32 },
      { key: "map_seven_island", file: "map_seven_island.rgba", w: 32, h: 32 },
      { key: "cat_grassland", file: "cat_icon_grassland.rgba", w: 64, h: 48 },
      { key: "cat_forest", file: "cat_icon_forest.rgba", w: 64, h: 48 },
      { key: "cat_waters_edge", file: "cat_icon_waters_edge.rgba", w: 64, h: 48 },
      { key: "cat_sea", file: "cat_icon_sea.rgba", w: 64, h: 48 },
      { key: "cat_cave", file: "cat_icon_cave.rgba", w: 64, h: 48 },
      { key: "cat_mountain", file: "cat_icon_mountain.rgba", w: 64, h: 48 },
      { key: "cat_rough_terrain", file: "cat_icon_rough_terrain.rgba", w: 64, h: 48 },
      { key: "cat_urban", file: "cat_icon_urban.rgba", w: 64, h: 48 },
      { key: "cat_rare", file: "cat_icon_rare.rgba", w: 64, h: 48 },
      { key: "cat_numerical", file: "cat_icon_numerical.rgba", w: 64, h: 48 },
      { key: "cat_atoz", file: "cat_icon_abc.rgba", w: 64, h: 48 },
      { key: "cat_type", file: "cat_icon_type.rgba", w: 64, h: 48 },
      { key: "cat_lightest", file: "cat_icon_lightest.rgba", w: 64, h: 48 },
      { key: "cat_smallest", file: "cat_icon_smallest.rgba", w: 64, h: 48 },
      { key: "cat_cancel", file: "cat_icon_cancel.rgba", w: 64, h: 48 },
      { key: "cat_qmark", file: "cat_icon_qmark.rgba", w: 64, h: 48 },
      { key: "marker_0", file: "marker_0.rgba", w: 8, h: 8 },
      { key: "marker_1", file: "marker_1.rgba", w: 16, h: 8 },
      { key: "marker_2", file: "marker_2.rgba", w: 8, h: 16 },
      { key: "marker_3", file: "marker_3.rgba", w: 32, h: 16 },
      { key: "marker_4", file: "marker_4.rgba", w: 16, h: 32 },
      { key: "marker_5", file: "marker_5.rgba", w: 32, h: 16 },
      { key: "marker_6", file: "marker_6.rgba", w: 16, h: 32 },
    ];

    for (const t of textures) {
      const bytes = read_bytes(root + "/" + t.file);
      if (bytes) {
        PokedexChrome._images[t.key] = rgba_to_image(bytes, t.w, t.h, t.trans);
      }
    }

    const sheets = [
      { key: "kanto", file: "dex_tiles_kanto.rgba" },
      { key: "national", file: "dex_tiles_national.rgba" },
    ];
    PokedexChrome._sheets = {};
    for (const s of sheets) {
      PokedexChrome._sheets![s.key] = read_bytes(root + "/" + s.file);
      PokedexChrome._images["dex_data_bg_" + s.key] = undefined;
      PokedexChrome._images["dex_area_bg_" + s.key] = undefined;
    }

    PokedexChrome._images.trainer_red = undefined;
    PokedexChrome._images.trainer_leaf = undefined;
    PokedexChrome._colors = undefined;
    const colorBytes = read_bytes(root + "/chrome.lua");
    if (colorBytes) {
      const chunk = luaLoad(colorBytes, "=pokedex/chrome.lua")[0];
      if (chunk) {
        let ok = true, tbl: unknown;
        try { tbl = chunk(); } catch { ok = false; }
        if (ok && tbl != null && typeof tbl === "object") PokedexChrome._colors = tbl;
      }
    }

    PokedexChrome._installed = true;
    return true;
  },

  // Lua: pokedex_chrome.lua:169
  getImage(key: string): Image | undefined {
    if (!PokedexChrome._installed) PokedexChrome.install();
    return PokedexChrome._images[key] || undefined;
  },

  /** -> [r, g, b, a] (0..1), or undefined */
  // Lua: pokedex_chrome.lua:174
  getColor(key: string): [number, number, number, number] | undefined {
    if (!PokedexChrome._installed) PokedexChrome.install();
    const c = PokedexChrome._colors ? PokedexChrome._colors[key] : undefined;
    if (c == null || typeof c !== "object" || c[3] == null) return undefined;
    return [c[1] / 255, c[2] / 255, c[3] / 255, (c[4] ?? 255) / 255];
  },

  // src/pokedex_area_markers.c:219
  // Lua: pokedex_chrome.lua:182
  getMarkerBlend(): [number, number] | undefined {
    if (!PokedexChrome._installed) PokedexChrome.install();
    const c = PokedexChrome._colors ? PokedexChrome._colors.marker_blend : undefined;
    if (c == null || typeof c !== "object" || c[2] == null) return undefined;
    return [c[1] / 16, c[2] / 16];
  },

  // Lua: pokedex_chrome.lua:189
  measureControlInfo(str: string): number {
    return FrlgFont.measure(str, { small: true });
  },

  /** Draw control info text right-aligned ending at rightX (default 236), at y (default 146) */
  // Lua: pokedex_chrome.lua:194
  drawControlInfo(str: string, rightX?: number, y?: number): void {
    rightX = rightX ?? 236;
    y = y ?? 146;
    const totalW = PokedexChrome.measureControlInfo(str);
    const startX = rightX - totalW;
    PokedexChrome.drawControlInfoLeft(str, startX, y);
  },

  /** Draw control info text left-aligned starting at startX, at y (default 146) */
  // Lua: pokedex_chrome.lua:205
  drawControlInfoLeft(str: string, startX: number, y?: number): void {
    FrlgFont.draw(str, startX, y ?? 146, {
      small: true,
      colors: CONTROL_INFO_COLORS,
    });
  },

  // Lua: pokedex_chrome.lua:212
  getEntry(speciesId: unknown): any {
    return PokedexData.getEntry(speciesId);
  },

  // src/pokedex_screen.c:924 natDex palette, :1161 FillWindowPixelBuffer(0, PIXEL_FILL(15))
  // Lua: pokedex_chrome.lua:217
  drawBars(): void {
    const variant = PokedexData.isNationalUnlocked() ? "national" : "kanto";
    const c = PokedexChrome.getColor("bar_" + variant);
    if (!c) {
      throw new Error("PokedexChrome: chrome.lua has no bar_" + variant + " color");
    }
    G.setColor(c[0], c[1], c[2], 1);
    G.rectangle("fill", 0, 0, 240, 16);
    G.rectangle("fill", 0, 144, 240, 16);
    G.setColor(1, 1, 1, 1);
  },

  // Lua: pokedex_chrome.lua:229
  drawPaperBg(): void {
    const img = PokedexChrome.getImage("paper_bg");
    if (!img) {
      throw new Error("PokedexChrome: paper_bg.rgba is not in the cache");
    }
    G.setColor(1, 1, 1, 1);
    G.draw(img, 0, 0);
    PokedexChrome.drawBars();
  },

  // pokefirered/src/pokedex_screen.c:2926
  // Lua: pokedex_chrome.lua:266
  dataCardLayout(): CardLayout {
    const left = 0, top = 2, width = 28, height = 14;
    return card_layout(left, top, width, height, (top + 1) + (Math.floor(height / 2) + 1));
  },

  // pokefirered/src/pokedex_screen.c:2999
  // Lua: pokedex_chrome.lua:272
  areaCardLayout(): CardLayout {
    return card_layout(0, 2, 28, 14, undefined);
  },

  // pokefirered/src/pokedex_screen.c:2641
  // Lua: pokedex_chrome.lua:277
  cardTilemap(L: CardLayout): Record<number, Record<number, { tile: number; flipH: boolean; flipV: boolean }>> {
    const grid: Record<number, Record<number, { tile: number; flipH: boolean; flipV: boolean }>> = {};
    const put = (tile: number, col: number, row: number, w: number, h: number, flipH?: boolean, flipV?: boolean): void => {
      if (w <= 0 || h <= 0) return;
      for (let r = row; r <= row + h - 1; r++) {
        grid[r] = grid[r] || {};
        for (let c = col; c <= col + w - 1; c++) {
          grid[r]![c] = { tile, flipH: flipH || false, flipV: flipV || false };
        }
      }
    };

    const left = L.left, top = L.top, width = L.width, height = L.height;
    const right = left + 1 + width;
    const bottom = top + 1 + height;

    if (L.divTile != null) {
      const divY = L.divTile;
      put(4, left, top, 1, 1);
      put(5, left + 1, top, width, 1);
      put(4, right, top, 1, 1, true, false);
      put(10, left, bottom, 1, 1);
      put(11, left + 1, bottom, width, 1);
      put(10, right, bottom, 1, 1, true, false);
      put(6, left, top + 1, 1, divY - top - 1);
      put(7, left, divY, 1, 1);
      put(9, left, divY + 1, 1, top + height - divY);
      put(6, right, top + 1, 1, divY - top - 1, true, false);
      put(7, right, divY, 1, 1, true, false);
      put(9, right, divY + 1, 1, top + height - divY, true, false);
      put(1, left + 1, top + 1, width, divY - top - 1);
      put(8, left + 1, divY, width, 1);
      put(2, left + 1, divY + 1, width, top + height - divY);
    } else {
      put(4, left, top, 1, 1);
      put(4, right, top, 1, 1, true, false);
      put(4, left, bottom, 1, 1, false, true);
      put(4, right, bottom, 1, 1, true, true);
      put(5, left + 1, top, width, 1);
      put(5, left + 1, bottom, width, 1, false, true);
      put(6, left, top + 1, 1, height);
      put(6, right, top + 1, 1, height, true, false);
      put(1, left + 1, top + 1, width, height);
    }

    return grid;
  },

  // Lua: pokedex_chrome.lua:327
  composeCard(L: CardLayout, sheet: unknown, w?: number, h?: number): string | undefined {
    w = w ?? 240;
    h = h ?? 160;
    const sheetW = CARD_SHEET_COLS * 8;
    if (typeof sheet !== "string" || sheet.length < sheetW * 8 * 4) return undefined;
    const sheetTiles = Math.floor(sheet.length / (sheetW * 8 * 4)) * CARD_SHEET_COLS;
    const grid = PokedexChrome.cardTilemap(L);
    const blank = { tile: 0, flipH: false, flipV: false };
    const out: string[] = [];
    for (let py = 0; py <= h - 1; py++) {
      const cols = grid[Math.floor(py / 8)];
      const ty = luaMod(py, 8);
      for (let px = 0; px <= w - 1; px++) {
        const cell = (cols && cols[Math.floor(px / 8)]) || blank;
        let tile = cell.tile;
        if (tile >= sheetTiles) tile = 0;
        const tx = luaMod(px, 8);
        const sx = luaMod(tile, CARD_SHEET_COLS) * 8 + (cell.flipH ? (7 - tx) : tx);
        const sy = Math.floor(tile / CARD_SHEET_COLS) * 8 + (cell.flipV ? (7 - ty) : ty);
        const o = (sy * sheetW + sx) * 4;
        out.push(sheet.substring(o, o + 4));
      }
    }
    return out.join("");
  },

  /** -> [sheet, variant] */
  // pokefirered/src/pokedex_screen.c:896
  // Lua: pokedex_chrome.lua:356
  cardSheet(): [string | undefined, string | undefined] {
    if (!PokedexChrome._installed) PokedexChrome.install();
    const sheets = PokedexChrome._sheets || {};
    if (PokedexData.isNationalUnlocked() && sheets.national) {
      return [sheets.national, "national"];
    }
    if (sheets.kanto) return [sheets.kanto, "kanto"];
    return [undefined, undefined];
  },

  // Lua: pokedex_chrome.lua:387
  drawDataCardBg(): void {
    draw_card("dex_data_bg", PokedexChrome.dataCardLayout);
  },

  // Lua: pokedex_chrome.lua:391
  drawAreaCardBg(): void {
    draw_card("dex_area_bg", PokedexChrome.areaCardLayout);
  },

  // src/trainer_pokemon_sprites.c:276, include/constants/trainers.h:156
  TRAINER_PIC_IDS: { male: 135, female: 136 },

  /** Load trainer front sprite (Red/Leaf) for Size Comparison */
  // Lua: pokedex_chrome.lua:399
  getTrainerPic(gender?: string): Image | undefined {
    const key = (gender === "female") ? "trainer_leaf" : "trainer_red";
    if (PokedexChrome._images[key] == null) {
      const picId = (gender === "female") ? PokedexChrome.TRAINER_PIC_IDS.female : PokedexChrome.TRAINER_PIC_IDS.male;
      const bytes = read_bytes(cache_root() + "/trainers/front/" + tostring(picId) + ".rgba")
        || read_bytes("data/generated/gba/trainers/front/" + tostring(picId) + ".rgba");
      PokedexChrome._images[key] = (bytes && rgba_to_image(bytes, 64, 64)) || false;
    }
    return PokedexChrome._images[key] || undefined;
  },

  /** Draw sprite as solid silhouette with authentic charcoal palette (#4A4A4A) */
  // Lua: pokedex_chrome.lua:411
  drawSilhouette(img: Image | undefined, x: number, y: number, scaleX?: number, scaleY?: number, originX?: number, originY?: number): void {
    if (!img) return;
    scaleX = scaleX ?? 1;
    scaleY = scaleY ?? scaleX;
    originX = originX ?? 0;
    originY = originY ?? 0;

    if (!PokedexChrome._silhouetteShader) {
      // love.graphics.newShader(<solid mask GLSL>) -> the "solid_mask" effect
      let shader: Shader | undefined;
      try { shader = G.newShader("solid_mask"); } catch { shader = undefined; }
      if (shader) {
        PokedexChrome._silhouetteShader = shader;
      }
    }

    if (PokedexChrome._silhouetteShader) {
      G.setShader(PokedexChrome._silhouetteShader);
    }
    const c = PokedexChrome.getColor("silhouette");
    G.setColor(c ? c[0] : 74 / 255, c ? c[1] : 74 / 255, c ? c[2] : 74 / 255, 1);
    G.draw(img, x, y, 0, scaleX, scaleY, originX, originY);
    if (PokedexChrome._silhouetteShader) {
      G.setShader();
    }
    G.setColor(1, 1, 1, 1);
  },

  /** Draw Top Header title with white text and gray shadow (at y=2, centered if x is nil) */
  // Lua: pokedex_chrome.lua:441
  drawHeader(title: string, x?: number, y?: number): void {
    y = y ?? 2;
    if (x == null) {
      const w = FrlgFont.measure(title);
      x = Math.floor((240 - w) / 2);
    }
    FrlgFont.draw(title, x, y, {
      colors: { fg: seq(1, 1, 1, 1), shadow: seq(98 / 255, 98 / 255, 98 / 255, 1), bg: undefined } as Colors,
    });
  },

  /** Draw Footer controls text with white text and gray shadow */
  // Lua: pokedex_chrome.lua:454
  drawFooter(text: string, x?: number, y?: number): void {
    x = x ?? 8;
    y = y ?? 146;
    FrlgFont.draw(text, x, y, {
      colors: { fg: seq(1, 1, 1, 1), shadow: seq(98 / 255, 98 / 255, 98 / 255, 1), bg: undefined } as Colors,
    });
  },

  /** Load authentic GBA menu_info texture containing all 18 type badges & caught ball */
  // Lua: pokedex_chrome.lua:474
  menuInfoImage(): Image | undefined {
    if (PokedexChrome._menuInfo) return PokedexChrome._menuInfo;
    if (SummaryChrome && SummaryChrome.menuInfoImage) {
      PokedexChrome._menuInfo = viaStub(() => SummaryChrome.menuInfoImage());
      if (PokedexChrome._menuInfo) return PokedexChrome._menuInfo;
    }
    return undefined;
  },

  /** Draw authentic flat orange down scroll arrow (secondArrowType in pret) */
  // Lua: pokedex_chrome.lua:507
  drawDownArrow(x?: number, y?: number): void {
    x = x ?? 200;
    y = y ?? 141;
    const bob = Math.floor(Math.sin(PokedexChrome._animTimer * 4) * 1.5 + 0.5);

    // Dark coral/red outline
    G.setColor(205 / 255, 65 / 255, 57 / 255, 1);
    G.polygon("fill",
      x - 6, y + bob - 1,
      x + 6, y + bob - 1,
      x, y + 6 + bob + 1);
    // Warm vibrant orange fill
    G.setColor(255 / 255, 139 / 255, 57 / 255, 1);
    G.polygon("fill",
      x - 5, y + bob,
      x + 5, y + bob,
      x, y + 6 + bob);
    G.setColor(1, 1, 1, 1);
  },

  /** Draw authentic flat orange up scroll arrow (firstArrowType in pret) */
  // Lua: pokedex_chrome.lua:531
  drawUpArrow(x?: number, y?: number): void {
    x = x ?? 200;
    y = y ?? 19;
    const bob = Math.floor(Math.sin(PokedexChrome._animTimer * 4) * 1.5 + 0.5);

    // Dark coral/red outline
    G.setColor(205 / 255, 65 / 255, 57 / 255, 1);
    G.polygon("fill",
      x - 6, y - bob + 1,
      x + 6, y - bob + 1,
      x, y - 6 - bob - 1);
    // Warm vibrant orange fill
    G.setColor(255 / 255, 139 / 255, 57 / 255, 1);
    G.polygon("fill",
      x - 5, y - bob,
      x + 5, y - bob,
      x, y - 6 - bob);
    G.setColor(1, 1, 1, 1);
  },

  /** Draw bouncing horizontal side arrow (left or right) */
  // Lua: pokedex_chrome.lua:555
  drawSideArrow(dir: string | number, x: number, y: number): void {
    const bob = Math.floor(Math.sin(PokedexChrome._animTimer * 4) * 1.5 + 0.5);

    G.setColor(232 / 255, 72 / 255, 32 / 255, 1);
    if (dir === "right" || dir === 1) {
      G.polygon("fill",
        x + bob, y,
        x + 6 + bob, y + 5,
        x + bob, y + 10);
    } else {
      G.polygon("fill",
        x + 6 - bob, y,
        x - bob, y + 5,
        x + 6 - bob, y + 10);
    }
    G.setColor(1, 1, 1, 1);
  },

  /** Draw authentic caught Poké Ball marker icon at (x, y) (8x8 from caught_marker.rgba) */
  // Lua: pokedex_chrome.lua:576
  drawCaughtMarker(x: number, y: number): void {
    const img = PokedexChrome.getImage("caught_marker");
    if (img) {
      G.setColor(1, 1, 1, 1);
      G.draw(img, x, y);
      return;
    }
    const mi = PokedexChrome.menuInfoImage();
    if (mi) {
      const q = get_pokedex_quad("caught_ball", 0, 0, 12, 12, 128, 128);
      G.setColor(1, 1, 1, 1);
      G.draw(mi, q, x - 2, y - 2);
    }
  },

  /** Draw authentic Type Badge (32x12 from ROM menu_info) */
  // Lua: pokedex_chrome.lua:594
  drawTypeBadge(typeIdIn: unknown, x: number, y: number): void {
    if (typeIdIn == null) return;
    const typeId = tonumber(typeIdIn)!;
    const rect = TYPE_RECTS[typeId];
    if (!rect) throw new Error("type id");
    const img = PokedexChrome.menuInfoImage();
    if (!img) throw new Error("menu_info");
    const q = get_pokedex_quad("type_" + tostring(typeId), rect.x, rect.y, rect.w, rect.h, 128, 128);
    G.setColor(1, 1, 1, 1);
    G.draw(img, q, x, y);
  },

  /** Draw category icon (64x48) */
  // Lua: pokedex_chrome.lua:605
  drawCategoryIcon(catKey: unknown, x: number, y: number, scale?: number): void {
    scale = scale ?? 1;
    const key = "cat_" + tostring(catKey || "qmark");
    const img = PokedexChrome.getImage(key) || PokedexChrome.getImage("cat_qmark");
    if (img) {
      G.setColor(1, 1, 1, 1);
      G.draw(img, x, y, 0, scale, scale);
    }
  },

  /** Draw Town Map (96x72) */
  // Lua: pokedex_chrome.lua:616
  drawMap(mapKey: unknown, x: number, y: number, scale?: number): void {
    scale = scale ?? 1;
    const key = "map_" + tostring(mapKey || "kanto");
    const img = PokedexChrome.getImage(key) || PokedexChrome.getImage("map_kanto");
    if (img) {
      G.setColor(1, 1, 1, 1);
      G.draw(img, x, y, 0, scale, scale);
    }
  },

  /** Draw Area Route Marker (Steady slightly transparent red overlay) */
  // Lua: pokedex_chrome.lua:644
  drawAreaMarker(shape: string, x: number, y: number): void {
    const img = PokedexChrome.getImage(AREA_MARKER_KEYS[shape] || "marker_0");
    const m = PokedexChrome.getColor("marker");
    const ev = PokedexChrome.getMarkerBlend();
    if (m && ev) {
      const [mr, mg, mb] = m;
      const [eva, evb] = ev;
      // src/pokedex_area_markers.c:219
      const [mode, alphaMode] = G.getBlendMode();
      G.setColor(0, 0, 0, 1 - evb);
      paint_area_marker(img, x, y);
      G.setBlendMode("add", "alphamultiply");
      G.setColor(mr * eva, mg * eva, mb * eva, 1);
      paint_area_marker(img, x, y);
      G.setBlendMode(mode, alphaMode);
    } else {
      G.setColor(m ? m[0] : 1, m ? m[1] : 0.3, m ? m[2] : 0.3, m ? m[3] : 0.75);
      paint_area_marker(img, x, y);
    }
    G.setColor(1, 1, 1, 1);
  },

  /** -> [bytes, rel] */
  // pokefirered/src/pokedex_screen.c:2901
  // Lua: pokedex_chrome.lua:667
  footprintSource(speciesId: unknown): [string | undefined, string | undefined] {
    const rel = pokedex_root() + "/footprints/" + tostring(tonumber(speciesId)) + ".rgba";
    const bytes = read_bytes(rel);
    if (bytes) return [bytes, rel];
    return [undefined, undefined];
  },

  /** Draw Footprint (16x16, black footprint on transparent background) */
  // Lua: pokedex_chrome.lua:675
  drawFootprint(speciesId: unknown, x: number, y: number, scale?: number): void {
    scale = scale ?? 1;
    const sp = tonumber(speciesId) ?? 1;

    if (!PokedexChrome._footprints[sp]) {
      const bytes = PokedexChrome.footprintSource(sp)[0];
      if (bytes) {
        const img = rgba_to_image(bytes, 16, 16);
        if (img) {
          PokedexChrome._footprints[sp] = img;
        }
      }
    }

    const img = PokedexChrome._footprints[sp];
    if (img) {
      G.setColor(1, 1, 1, 1);
      G.draw(img, x, y, 0, scale, scale);
    }
  },

  /** Draw Authentic Fixed-Radius Spotlight Disc with Pret Palette Pulsing Animation */
  // Lua: pokedex_chrome.lua:698
  drawHabitatSpotlight(cx: number, cy: number, radius?: number, timer?: number, isSelected?: boolean): void {
    radius = radius ?? 32;
    timer = timer ?? 0;
    if (isSelected == null) isSelected = true;

    let mainCol: number[], rimCol: number[];
    if (!isSelected) {
      mainCol = [197 / 255, 181 / 255, 140 / 255, 1];
      rimCol = [214 / 255, 197 / 255, 165 / 255, 1];
    } else {
      // Fades between darkish warm brown (#C5B58C / #D6A57B) and authentic vibrant red/coral (#F7846B)
      // Matching pret sDexScreen_CategoryCursorPals
      const t = (Math.sin(timer * 4) + 1) * 0.5; // 0.0 to 1.0
      const r = (197 + (247 - 197) * t) / 255;
      const g = (181 + (132 - 181) * t) / 255;
      const b = (140 + (107 - 140) * t) / 255;
      mainCol = [r, g, b, 1];

      const rRim = (214 + (239 - 214) * t) / 255;
      const gRim = (197 + (173 - 197) * t) / 255;
      const bRim = (165 + (148 - 165) * t) / 255;
      rimCol = [rRim, gRim, bRim, 1];
    }

    // Fixed radius circle with subtle shaded rim (no growing/shrinking)
    G.setColor(rimCol);
    G.circle("fill", cx, cy, radius);
    G.setColor(mainCol);
    G.circle("fill", cx, cy, radius - 2);
    G.setColor(1, 1, 1, 1);
  },

  /** Draw Authentic Mini Page Card for Habitat View (64x40) */
  // Lua: pokedex_chrome.lua:734
  drawMiniCard(speciesId: unknown, x: number, y: number, isCaught?: boolean, isSeen?: boolean, isSelected?: boolean): void {
    const sp = tonumber(speciesId) ?? 1;
    const natId = Pokemon.national(sp) || 0;
    const name = isSeen ? Pokemon.name(sp) : "----------";

    // Draw authentic 64x40 mini page background (white top, brown dividing line, beige bottom with simulated text)
    const bg = PokedexChrome.getImage("mini_page");
    if (bg) {
      G.setColor(1, 1, 1, 1);
      G.draw(bg, x, y);
    } else {
      // Fallback card chassis
      G.setColor(1, 1, 1, 1);
      G.rectangle("fill", x, y, 64, 40, 2, 2);
      G.setColor(200 / 255, 136 / 255, 112 / 255, 1);
      G.rectangle("line", x, y, 64, 40, 2, 2);
    }

    // Selection highlight outline
    if (isSelected) {
      G.setColor(247 / 255, 132 / 255, 107 / 255, 1);
      G.rectangle("line", x, y, 64, 40, 2, 2);
    }

    // Top Row: Caught Pokéball (8x8) at (x + 2, y + 3)
    if (isCaught) {
      PokedexChrome.drawCaughtMarker(x + 2, y + 3);
    }

    // Top Row: №xxx at (x + 12, y + 0) in FONT_SMALL
    const textColors = { fg: seq(0x18 / 255, 0x18 / 255, 0x18 / 255, 1), shadow: seq(0xD0 / 255, 0xC8 / 255, 0xB0 / 255, 1), bg: undefined } as Colors;
    FrlgFont.draw(format("\xE2\x84\x96%03d", natId), x + 12, y, { // № (UTF-8 bytes)
      small: true,
      colors: textColors,
    });

    // Mid Row: Species Name at (x + 2, y + 13) in FONT_NORMAL
    FrlgFont.draw(name, x + 2, y + 13, {
      colors: textColors,
    });

    G.setColor(1, 1, 1, 1);
  },
};

export default PokedexChrome;
