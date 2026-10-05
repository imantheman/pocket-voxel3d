// Port of gen1recomp src/ui/game3/summary_chrome.lua (GPLv3 + additional terms; see LICENSE.md).
// Pokémon Summary Screen Chrome (ROM-baked textures, bars, icons, and layout).
// Handles Love2D texture creation and quad rendering with fallbacks.

import { tonumber, tostring } from "../../../import/gen3/lua.ts";
import { Extract } from "../../../import/gen3/extract_island1.ts";
import { G } from "../platform/graphics.ts";
import { Fs } from "../platform/fs.ts";
import { newImageData, type Image, type ImageData, type Quad } from "../platform/image.ts";
import { luaLoad } from "../platform/luadata.ts";
import { gsub } from "../platform/lpattern.ts";
import { Dataset } from "../core/dataset.ts";
import { CacheFs } from "../shared/import/CacheFs.ts";

interface ChromeCache { read(rel: string): string | undefined }

export const SummaryChrome = {
  _cache: undefined as ChromeCache | undefined,
  _pages: {} as Record<string, Image | false>,
  _hpBars: {} as Record<string, Image | undefined>,
  _expBar: undefined as Image | undefined,
  _statusIcons: undefined as Image | undefined,
  _cursorLeft: undefined as Image | undefined,
  _cursorRight: undefined as Image | undefined,
  _shinyStar: undefined as Image | undefined,
  _pokerus: undefined as Image | undefined,
  _menuInfo: undefined as Image | undefined,
  _manifest: undefined as any,
  _quads: {} as Record<string, Quad>,
  _logged: false,

  // Lua: summary_chrome.lua:113
  install(cache?: any): void {
    if (!cache || !cache.read) {
      // pcall(require, "src.core.game3.dataset"): the module is always there.
      if (Dataset && Dataset.cache) {
        cache = Dataset.cache();
      }
    }
    SummaryChrome._cache = cache;
    SummaryChrome._pages = {};
    SummaryChrome._hpBars = {};
    SummaryChrome._expBar = undefined;
    SummaryChrome._statusIcons = undefined;
    SummaryChrome._cursorLeft = undefined;
    SummaryChrome._cursorRight = undefined;
    SummaryChrome._shinyStar = undefined;
    SummaryChrome._pokerus = undefined;
    SummaryChrome._menuInfo = undefined;
    SummaryChrome._manifest = undefined;
    SummaryChrome._quads = {};
  },

  // Lua: summary_chrome.lua:134
  manifest(): any {
    if (SummaryChrome._manifest) return SummaryChrome._manifest;
    SummaryChrome._manifest = load_lua(summary_root() + "/manifest.lua");
    return SummaryChrome._manifest;
  },

  // pokefirered/src/pokemon_summary_screen.c:1862
  // Lua: summary_chrome.lua:154
  drawBg3(kind: string, shiny?: unknown): boolean {
    const img = cached_image(variant("bg3_" + kind, shiny), 240, 160);
    if (!img) return false;
    G.setColor(1, 1, 1, 1);
    G.draw(img, 0, 0);
    return true;
  },

  // pokefirered/src/pokemon_summary_screen.c:3276
  // Lua: summary_chrome.lua:163
  drawProgress(kind: string, shiny?: unknown): boolean {
    const img = cached_image(variant("progress_" + kind, !!shiny && kind !== "egg"), 48, 16);
    if (!img) return false;
    G.setColor(1, 1, 1, 1);
    G.draw(img, 104, 0);
    return true;
  },

  // Lua: summary_chrome.lua:171
  drawLayer(kind: string, xOffset?: number, shiny?: unknown): boolean {
    const img = cached_image(variant("layer_" + kind, !!shiny && kind !== "egg"), 240, 160);
    if (!img) return false;
    G.setColor(1, 1, 1, 1);
    G.draw(img, xOffset ?? 0, 0);
    return true;
  },

  // Lua: summary_chrome.lua:179
  hpBarImage(color?: string): Image | undefined {
    color = color ?? "green";
    if (SummaryChrome._hpBars[color]) return SummaryChrome._hpBars[color];
    const raw = read_bytes(summary_root() + "/hp_bar_" + color + ".rgba");
    if (raw) {
      const img = rgba_to_image(raw, 96, 8);
      SummaryChrome._hpBars[color] = img;
      return img;
    }
    return undefined;
  },

  // Lua: summary_chrome.lua:191
  expBarImage(): Image | undefined {
    if (SummaryChrome._expBar) return SummaryChrome._expBar;
    const raw = read_bytes(summary_root() + "/exp_bar.rgba");
    if (raw) {
      const img = rgba_to_image(raw, 96, 8);
      SummaryChrome._expBar = img;
      return img;
    }
    return undefined;
  },

  // Lua: summary_chrome.lua:202
  statusIconsImage(): Image | undefined {
    if (SummaryChrome._statusIcons) return SummaryChrome._statusIcons;
    const raw = read_bytes(summary_root() + "/status_icons.rgba");
    if (raw) {
      const img = rgba_to_image(raw, 32, 64);
      SummaryChrome._statusIcons = img;
      return img;
    }
    return undefined;
  },

  // Lua: summary_chrome.lua:213
  menuInfoImage(): Image | undefined {
    if (SummaryChrome._menuInfo) return SummaryChrome._menuInfo;
    const raw = read_bytes(summary_root() + "/menu_info.rgba");
    const img = raw ? rgba_to_image(raw, 128, 128) : undefined;
    SummaryChrome._menuInfo = img;
    return img;
  },

  // Lua: summary_chrome.lua:221
  cursorImages(): [Image | undefined, Image | undefined] {
    if (SummaryChrome._cursorLeft && SummaryChrome._cursorRight) {
      return [SummaryChrome._cursorLeft, SummaryChrome._cursorRight];
    }
    const rawL = read_bytes(summary_root() + "/cursor_left.rgba");
    const rawR = read_bytes(summary_root() + "/cursor_right.rgba");
    if (rawL) SummaryChrome._cursorLeft = rgba_to_image(rawL, 64, 64);
    if (rawR) SummaryChrome._cursorRight = rgba_to_image(rawR, 64, 64);
    return [SummaryChrome._cursorLeft, SummaryChrome._cursorRight];
  },

  // Lua: summary_chrome.lua:232
  shinyStarImage(): Image | undefined {
    if (SummaryChrome._shinyStar) return SummaryChrome._shinyStar;
    const raw = read_bytes(summary_root() + "/shiny_star.rgba");
    if (raw) {
      const img = rgba_to_image(raw, 8, 16);
      SummaryChrome._shinyStar = img;
      return img;
    }
    return undefined;
  },

  // Lua: summary_chrome.lua:243
  pokerusImage(): Image | undefined {
    if (SummaryChrome._pokerus) return SummaryChrome._pokerus;
    const raw = read_bytes(summary_root() + "/pokerus.rgba");
    if (raw) {
      const img = rgba_to_image(raw, 8, 8);
      SummaryChrome._pokerus = img;
      return img;
    }
    return undefined;
  },

  // Lua: summary_chrome.lua:301
  drawHpBar(x: number, y: number, curHpIn: unknown, maxHpIn: unknown): void {
    const curHp = Math.max(0, tonumber(curHpIn) ?? 0);
    const maxHp = Math.max(1, tonumber(maxHpIn) ?? 1);
    const ratio = curHp / maxHp;
    let color = "green";
    if (ratio <= 0.20) {
      color = "red";
    } else if (ratio <= 0.50) {
      color = "yellow";
    }

    const img = SummaryChrome.hpBarImage(color);
    if (!img) {
      G.setColor(0.1, 0.1, 0.1, 1);
      G.rectangle("fill", x + 16, y + 2, 48, 4);
      if (color === "green") G.setColor(0.2, 0.8, 0.2, 1);
      else if (color === "yellow") G.setColor(0.9, 0.8, 0.1, 1);
      else G.setColor(0.9, 0.2, 0.2, 1);
      G.rectangle("fill", x + 16, y + 2, Math.floor(48 * ratio), 4);
      return;
    }

    G.setColor(1, 1, 1, 1);
    const fills = bar_fill_anims(curHp, maxHp, 6);
    // sprites[0]=HP, [1]=cap, [2..7]=fill, [8]=end  (pret CreateHpBarObjs)
    draw_bar_tile(img, "hp_t", 9, x + 0 * 8, y);
    draw_bar_tile(img, "hp_t", 10, x + 1 * 8, y);
    for (let i = 0; i <= 5; i++) {
      draw_bar_tile(img, "hp_t", fills[i + 1] ?? 0, x + (2 + i) * 8, y);
    }
    draw_bar_tile(img, "hp_t", 11, x + 8 * 8, y);
  },

  /** Pret UpdateExpBarObjs: 11 sprites at (x + i*8, y).
   * anim 9=EXP label, 10=left cap, 0..8=fill, 11=right cap. Fill = sprites[2..9]. */
  // Lua: summary_chrome.lua:337
  drawExpBar(x: number, y: number, progressPercentIn: unknown): void {
    const progressPercent = Math.max(0.0, Math.min(1.0, tonumber(progressPercentIn) ?? 0.0));
    const img = SummaryChrome.expBarImage();
    if (!img) {
      G.setColor(0.1, 0.1, 0.1, 1);
      G.rectangle("fill", x + 16, y + 2, 64, 4);
      G.setColor(0.2, 0.5, 0.9, 1);
      G.rectangle("fill", x + 16, y + 2, Math.floor(64 * progressPercent), 4);
      return;
    }

    G.setColor(1, 1, 1, 1);
    // progressPercent is already cur/needed within the level; fake a 100-unit bar.
    const fills = bar_fill_anims(Math.floor(progressPercent * 100 + 0.5), 100, 8);
    draw_bar_tile(img, "exp_t", 9, x + 0 * 8, y);
    draw_bar_tile(img, "exp_t", 10, x + 1 * 8, y);
    for (let i = 0; i <= 7; i++) {
      draw_bar_tile(img, "exp_t", fills[i + 1] ?? 0, x + (2 + i) * 8, y);
    }
    draw_bar_tile(img, "exp_t", 11, x + 10 * 8, y);
  },

  /** Draw Status Ailment Icon (32x8 px)
   * 1: PSN, 2: PRZ, 3: SLP, 4: FRZ, 5: BRN, 6: PKRS, 7: FNT */
  // Lua: summary_chrome.lua:362
  drawStatusIcon(x: number, y: number, ailmentCodeIn: unknown): void {
    const ailmentCode = tonumber(ailmentCodeIn) ?? 0;
    if (ailmentCode < 1 || ailmentCode > 7) return;
    const img = SummaryChrome.statusIconsImage();
    if (!img) return;
    const frame = ailmentCode - 1;
    const q = get_quad("status_" + tostring(frame), 0, frame * 8, 32, 8, 32, 64);
    G.setColor(1, 1, 1, 1);
    G.draw(img, q, x, y);
  },

  /** Draw Type Badge (32x12) */
  // Lua: summary_chrome.lua:404
  drawTypeBadge(typeIdIn: unknown, x: number, y: number): void {
    let typeId: unknown = typeIdIn;
    if (typeof typeId === "string") {
      typeId = TYPE_NAMES[typeId.toUpperCase()] ?? 0;
    }
    const tid = tonumber(typeId) ?? 0;
    const rect = TYPE_RECTS[tid] ?? TYPE_RECTS[0]!;
    const img = SummaryChrome.menuInfoImage();
    if (!img) {
      G.setColor(0.4, 0.4, 0.4, 1);
      G.rectangle("fill", x, y, 32, 12);
      return;
    }
    const q = get_quad("type_" + tostring(tid), rect.x, rect.y, rect.w, rect.h, 128, 128);
    G.setColor(1, 1, 1, 1);
    G.draw(img, q, x, y);
  },

  /** Draw Move Selection Cursor (Red for selecting, Blue for swap target)
   * 1:1 pret PokeSum_CreateMoveSelectionCursorObjs (two 64x32 sprites at x, x+64) */
  // Lua: summary_chrome.lua:424
  drawMoveSelectionCursor(x: number, y: number, w?: number | boolean, h?: number, isBlue?: boolean): void {
    if (typeof w === "boolean") {
      isBlue = w;
      w = 128;
      h = 32;
    }
    const [curL, curR] = SummaryChrome.cursorImages();
    if (curL && curR) {
      // Frame 0 is Red (selecting: 0..31), Frame 1 is Blue (swapping: 32..63)
      const vOffset = isBlue ? 32 : 0;
      const qL = get_quad("cur_l_" + (isBlue ? "b" : "r"), 0, vOffset, 64, 32, 64, 64);
      const qR = get_quad("cur_r_" + (isBlue ? "b" : "r"), 0, vOffset, 64, 32, 64, 64);
      G.setColor(1, 1, 1, 1);
      G.draw(curL, qL, x, y);
      G.draw(curR, qR, x + 64, y);
    } else {
      // Fallback outline
      G.setColor(isBlue ? [0.2, 0.4, 0.9, 1] : [0.9, 0.2, 0.2, 1]);
      G.rectangle("line", x, y, (w as number | undefined) ?? 128, h ?? 32);
    }
  },

  /** Draw Shiny Star (8x8) */
  // Lua: summary_chrome.lua:447
  drawShinyStar(x: number, y: number): void {
    const img = SummaryChrome.shinyStarImage();
    if (!img) return;
    // pokefirered/src/pokemon_summary_screen.c:610
    const q = get_quad("shiny_star", 0, 8, 8, 8, 8, 16);
    G.setColor(1, 1, 1, 1);
    G.draw(img, q, x, y);
  },

  /** Draw Cured Pokérus icon (8x8) */
  // Lua: summary_chrome.lua:458
  drawPokerus(x: number, y: number): void {
    const img = SummaryChrome.pokerusImage();
    if (!img) return;
    G.setColor(1, 1, 1, 1);
    G.draw(img, x, y);
  },

  // pokefirered/src/mon_markings.c:558
  // Lua: summary_chrome.lua:467
  drawMarkings(markingsIn: unknown, x: number, y: number): void {
    const markings = tonumber(markingsIn) ?? 0;
    if (markings <= 0 || markings > 15) return;
    const img = cached_image("markings", 32, 128);
    if (!img) return;
    const q = get_quad("markings_" + tostring(markings), 0, markings * 8, 32, 8, 32, 128);
    G.setColor(1, 1, 1, 1);
    G.draw(img, q, x, y);
  },
};

// Lua: summary_chrome.lua:24
function cache_root(): string {
  // pcall(require, "src.core.game3.dataset"): the module is always there.
  if (Dataset && Dataset.mountExtractRoots) {
    Dataset.mountExtractRoots();
  }
  return Extract.CACHE_ROOT || "data/generated/gba";
}

// Lua: summary_chrome.lua:32
function summary_root(): string {
  return cache_root() + "/pokemon/summary";
}

// Lua: summary_chrome.lua:36
function log(msg: unknown): void {
  if (SummaryChrome._logged) return;
  SummaryChrome._logged = true;
  console.log("[game3/summary_chrome] " + tostring(msg));
}

// Lua: summary_chrome.lua:42
function read_bytes(rel: string): string | undefined {
  const cache = SummaryChrome._cache;
  if (cache && cache.read) {
    const d = cache.read(rel);
    if (typeof d === "string" && d.length > 0) return d;
  }
  // pcall(require, "src.core.game3.dataset"): the module is always there.
  if (Dataset && Dataset.cache) {
    const d = Dataset.cache().read(rel);
    if (typeof d === "string" && d.length > 0) return d;
  }
  // pcall(require, "src.import.CacheFs"): the module is always there.
  if (CacheFs && CacheFs.readActive) {
    const d = CacheFs.readActive(rel);
    if (typeof d === "string" && d.length > 0) return d;
  }
  {
    let d = Fs.read(rel);
    if (typeof d === "string" && d.length > 0) return d;
    const alt = "data/generated/gba/" + gsub(rel, "^data/generated/gba/", "")[0];
    d = Fs.read(alt);
    if (typeof d === "string" && d.length > 0) return d;
  }
  // NOT FAITHFUL: the io.open(rel / "data/generated/gba/"..rel) fallback
  // (a file beside the executable) has no 3DS equivalent.
  return undefined;
}

// Lua: summary_chrome.lua:80
function load_lua(rel: string): any {
  const src = read_bytes(rel);
  if (!src) return undefined;
  const [chunk] = luaLoad(src, "@" + rel);
  if (!chunk) return undefined;
  try {
    return chunk();
  } catch {
    return undefined;
  }
}

// Lua: summary_chrome.lua:90
function rgba_to_image(rgba: string, w: number, h: number): Image | undefined {
  if (!rgba || rgba.length < w * h * 4) return undefined;
  let imageData: ImageData | undefined;
  try { imageData = newImageData(w, h, "rgba8", rgba); } catch { imageData = undefined; }
  if (!imageData) {
    imageData = newImageData(w, h);
    let i = 0;
    for (let y = 0; y <= h - 1; y++) {
      for (let x = 0; x <= w - 1; x++) {
        imageData.setPixel(x, y,
          (rgba.charCodeAt(i) || 0) / 255,
          (rgba.charCodeAt(i + 1) || 0) / 255,
          (rgba.charCodeAt(i + 2) || 0) / 255,
          (rgba.charCodeAt(i + 3) || 0) / 255);
        i += 4;
      }
    }
  }
  const image = G.newImage(imageData);
  if (image.setFilter) image.setFilter("nearest", "nearest");
  return image;
}

// Lua: summary_chrome.lua:140
function cached_image(name: string, w: number, h: number): Image | undefined {
  const key = name;
  if (SummaryChrome._pages[key] !== undefined) return SummaryChrome._pages[key] || undefined;
  const raw = read_bytes(summary_root() + "/" + name + ".rgba");
  const img = raw ? rgba_to_image(raw, w, h) : undefined;
  SummaryChrome._pages[key] = img || false;
  return img;
}

// Lua: summary_chrome.lua:149
function variant(name: string, shiny: unknown): string {
  return shiny ? (name + "_shiny") : name;
}

// Lua: summary_chrome.lua:254
function get_quad(key: string, x: number, y: number, w: number, h: number, sw: number, sh: number): Quad {
  if (!SummaryChrome._quads[key]) {
    SummaryChrome._quads[key] = G.newQuad(x, y, w, h, sw, sh);
  }
  return SummaryChrome._quads[key]!;
}

/** Pret UpdateHpBarObjs: 9 sprites at (x + i*8, y).
 * anim 9=HP label, 10=left cap, 0..8=fill (0 empty..8 full), 11=right cap.
 * Fill spans sprites[2..7] (6 tiles); `x` is sprite[0] left edge (pret: 172). */
// Lua: summary_chrome.lua:266
function bar_fill_anims(curIn: unknown, maxIn: unknown, fillSlots: number): (number | null)[] {
  // Mirror pret: pointsPerTile = (max<<2)/slots; accumulate whole tiles from sprite index 2.
  const anims: (number | null)[] = [null];
  for (let i = 1; i <= fillSlots; i++) anims[i] = 0;
  const cur = Math.max(0, tonumber(curIn) ?? 0);
  const max = Math.max(1, tonumber(maxIn) ?? 1);
  if (cur >= max) {
    for (let i = 1; i <= fillSlots; i++) anims[i] = 8;
    return anims;
  }
  const pointsPerTile = (max * 4) / fillSlots;
  if (pointsPerTile <= 0) return anims;
  let totalPoints = cur * 4;
  let whole = 0;
  while (totalPoints > pointsPerTile) {
    totalPoints = totalPoints - pointsPerTile;
    whole = whole + 1;
  }
  for (let i = 1; i <= Math.min(whole, fillSlots); i++) {
    anims[i] = 8;
  }
  if (whole < fillSlots) {
    let partial = Math.floor((totalPoints * fillSlots) / pointsPerTile);
    if (partial < 0) partial = 0;
    if (partial > 7) partial = 7;
    anims[whole + 1] = partial;
  }
  return anims;
}

// Lua: summary_chrome.lua:296
function draw_bar_tile(img: Image, quadKey: string, tileIndex: number, dx: number, dy: number): void {
  const q = get_quad(quadKey + tostring(tileIndex), tileIndex * 8, 0, 8, 8, 96, 8);
  G.draw(img, q, dx, dy);
}

/** Type badge mapping in menu_info.png (128x128) */
// Lua: summary_chrome.lua:375
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

// Lua: summary_chrome.lua:396
const TYPE_NAMES: Record<string, number> = {
  NORMAL: 0, FIGHTING: 1, FLYING: 2, POISON: 3, GROUND: 4,
  ROCK: 5, BUG: 6, GHOST: 7, STEEL: 8, MYSTERY: 9,
  FIRE: 10, WATER: 11, GRASS: 12, ELECTRIC: 13, PSYCHIC: 14,
  ICE: 15, DRAGON: 16, DARK: 17,
};

export default SummaryChrome;
