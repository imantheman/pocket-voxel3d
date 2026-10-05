// Port of gen1recomp src/import/gba/summary_chrome_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// Bake FRLG Pokemon Summary Screen chrome from ROM into data/generated/gba/pokemon/summary/.
// Backgrounds, HP/EXP bars, status ailment icons, cursors, shiny star, Pokerus, and layout manifest.
// Byte tables are 0-based Uint8Arrays / arrays here (the Lua's 1-based
// tables); byte strings stay byte strings; palette banks keyed from 0.

import { Versions } from "./versions.ts";
import { Lz77 } from "./lz77.ts";
import { CacheFs, type Cache } from "./cache.ts";
import { format, fromBytes, sub, tonumber, tostring } from "./lua.ts";
import type { Rom } from "./rom.ts";

type ByteSrc = string | ArrayLike<number>;
type Pal = Record<number, number>;

// Lua: summary_chrome_extract.lua:11 (extract_island1's CACHE_ROOT; callers pass cacheRoot)
function default_cache_root(): string {
  return "data/generated/gba";
}

// Lua: summary_chrome_extract.lua:19 -- idx is 0-based here (the Lua's 1-based)
function get_byte(t: ByteSrc | undefined, idx: number): number {
  if (typeof t === "string") return idx >= 0 && idx < t.length ? t.charCodeAt(idx) : 0;
  if (t) return t[idx] ?? 0;
  return 0;
}

// Lua: summary_chrome_extract.lua:28
function bgr555_to_rgb8(c: unknown): [number, number, number] {
  const n = (tonumber(c) ?? 0) % 32768;
  const r5 = n % 32, g5 = Math.floor(n / 32) % 32, b5 = Math.floor(n / 1024) % 32;
  return [Math.floor((r5 * 255) / 31 + 0.5), Math.floor((g5 * 255) / 31 + 0.5), Math.floor((b5 * 255) / 31 + 0.5)];
}

// Lua: summary_chrome_extract.lua:38
function byte_len(buf: unknown): number {
  if (typeof buf === "string") return buf.length;
  if (buf instanceof Uint8Array || Array.isArray(buf)) return buf.length;
  return 0;
}

// Lua: summary_chrome_extract.lua:44
function decode_tile_4bpp(tileBytes: ByteSrc, out: number[], baseX: number, baseY: number, stride: number, hflip: boolean, vflip: boolean): void {
  for (let row = 0; row <= 7; row++) {
    const srcRow = vflip ? 7 - row : row;
    for (let bx = 0; bx <= 3; bx++) {
      const byte = get_byte(tileBytes, srcRow * 4 + bx);
      const p0 = byte % 16, p1 = Math.floor(byte / 16) % 16;
      let x0 = bx * 2, x1 = x0 + 1;
      if (hflip) { x0 = 7 - x0; x1 = 7 - x1; }
      out[(baseY + row) * stride + (baseX + x0)] = p0;
      out[(baseY + row) * stride + (baseX + x1)] = p1;
    }
  }
}

// Lua: summary_chrome_extract.lua:62
function load_pal_banks(bytes: ByteSrc | undefined, count?: number): Pal[] {
  const banks: Pal[] = [];
  const n = count ?? Math.max(1, Math.floor(byte_len(bytes) / 32));
  for (let b = 0; b <= n - 1; b++) {
    const colors: Pal = {};
    const off = b * 32;
    for (let c = 0; c <= 15; c++) {
      const i = off + c * 2;
      colors[c] = get_byte(bytes, i) + get_byte(bytes, i + 1) * 256;
    }
    banks[b] = colors;
  }
  return banks;
}

// Lua: summary_chrome_extract.lua:77
// NOT FAITHFUL: only the active cache is consulted (CacheFs.readActive); the
// love.filesystem / io.open fallbacks read files beside his source tree.
function read_bin(candidates: string[]): string | undefined {
  for (const p of candidates) {
    try {
      const d = CacheFs.readActive(p);
      if (d !== undefined && d.length > 0) return d;
    } catch { /* no bound cache */ }
  }
  return undefined;
}

function tileAt(gfx: ByteSrc, tileId: number): number[] {
  const tile: number[] = [];
  const base = tileId * 32;
  for (let i = 0; i < 32; i++) tile[i] = get_byte(gfx, base + i);
  return tile;
}

// Lua: summary_chrome_extract.lua:101 -- Bake a BG tilemap to RGBA.
// On GBA, palette index 0 is transparent (shows lower BGs / backdrop).
// When transparent0 is true, index 0 is written with alpha 0.
function bake_bg_rgba(gfx: ByteSrc, palBytes: ByteSrc, map: ByteSrc | undefined, W: number, H: number, transparent0: boolean, slots?: Record<number, number>): string {
  const tileCount = Math.floor(byte_len(gfx) / 32);
  let banks: (Pal | undefined)[] = load_pal_banks(palBytes, Math.max(1, Math.floor(byte_len(palBytes) / 32)));
  if (slots) {
    const src = banks;
    banks = [];
    for (let k = 0; k < src.length; k++) banks[k] = src[k];
    for (const key of Object.keys(slots)) {
      const slot = Number(key), bank = slots[slot]!;
      banks[slot] = src[bank] ?? src[slot];
    }
  }
  const mapW = 32;
  const indices = new Array<number>(W * H).fill(0);
  const pals = new Array<number>(W * H).fill(0);
  const tilesH = Math.min(32, Math.floor(H / 8));
  const tilesW = Math.min(32, Math.floor(W / 8));
  for (let ty = 0; ty <= tilesH - 1; ty++) {
    for (let tx = 0; tx <= tilesW - 1; tx++) {
      const mi = (ty * mapW + tx) * 2;
      const entry = get_byte(map, mi) + get_byte(map, mi + 1) * 256;
      let tileId = entry % 1024;
      const hflip = Math.floor(entry / 1024) % 2 === 1;
      const vflip = Math.floor(entry / 2048) % 2 === 1;
      const palNum = Math.floor(entry / 4096) % 16;
      if (tileId >= tileCount) tileId = 0;
      const tmp = new Array<number>(64).fill(0);
      decode_tile_4bpp(tileAt(gfx, tileId), tmp, 0, 0, 8, hflip, vflip);
      for (let row = 0; row <= 7; row++) {
        for (let col = 0; col <= 7; col++) {
          const px = tx * 8 + col, py = ty * 8 + row;
          if (px < W && py < H) {
            const di = py * W + px;
            indices[di] = tmp[row * 8 + col] ?? 0;
            pals[di] = palNum;
          }
        }
      }
    }
  }
  const out = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const idx = indices[i] ?? 0;
    if (!(transparent0 && idx === 0)) {
      const bank = banks[pals[i] ?? 0] ?? banks[0];
      const c = bank ? bank[idx] ?? 0 : 0;
      const [r, g, b] = bgr555_to_rgb8(c);
      out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = 255;
    }
  }
  return fromBytes(out);
}

// Lua: summary_chrome_extract.lua:160 -- Overlay `top` onto `bottom` where top alpha > 0 (both raw RGBA strings).
function composite_rgba(bottom: string | undefined, top: string | undefined): string | undefined {
  if (!bottom || bottom === "") return top;
  if (!top || top === "") return bottom;
  const n = Math.min(bottom.length, top.length);
  const out: string[] = [];
  let i = 0;
  while (i < n) {
    const a = i + 3 < top.length ? top.charCodeAt(i + 3) : 0;
    if (a > 0) out.push(top.slice(i, i + 4));
    else out.push(bottom.slice(i, i + 4));
    i = i + 4;
  }
  if (bottom.length > n) out.push(bottom.slice(n));
  return out.join("");
}

// Lua: summary_chrome_extract.lua:180 -- pokefirered/src/pokemon_summary_screen.c:1862
function load_base_tilemap(kind: string, get?: (i: number) => number): ByteSrc | undefined {
  // ROM path (always works on Android, iOS, etc.)
  if (get) {
    const off = kind === "moves" ? (Versions.SUMMARY_PAGE_MOVES_BASE_TILEMAP ?? 0x463c80)
      : (Versions.SUMMARY_PAGE_MOVES_INFO_BASE_TILEMAP ?? 0x463b88);
    const [dec] = Lz77.decompress(get, off);
    if (dec && byte_len(dec) > 0) return dec;
  }
  // Fallback: pret source tree or pre-extracted cache
  const names: Record<string, string[]> = {
    info: ["moves_info_page.bin"],
    moves: ["moves_page.bin"],
  };
  const list = names[kind] ?? names.info!;
  const candidates: string[] = [];
  for (const n of list) {
    candidates.push("pokefirered/graphics/summary_screen/" + n);
    candidates.push("data/generated/gba/pokemon/summary/" + n);
  }
  return read_bin(candidates);
}

// Lua: summary_chrome_extract.lua:202
function bake_page_composited(gfx: ByteSrc, palBytes: ByteSrc, pageMap: ByteSrc, baseMap: ByteSrc | undefined, W: number, H: number): string {
  let baseRgba: string | undefined;
  if (baseMap !== undefined) {
    // Base layer keeps opaque color0 only where tiles actually use it; page overlay
    // punches through with transparent index 0 (GBA BG transparency).
    baseRgba = bake_bg_rgba(gfx, palBytes, baseMap, W, H, false);
  }
  const pageRgba = bake_bg_rgba(gfx, palBytes, pageMap, W, H, true);
  if (baseRgba !== undefined) return composite_rgba(baseRgba, pageRgba)!;
  // No base: replace chromakey with opaque so Love does not clear to magenta.
  return bake_bg_rgba(gfx, palBytes, pageMap, W, H, false);
}

const PROGRESS_X = 104, PROGRESS_Y = 0, PROGRESS_W = 48, PROGRESS_H = 16;

// Lua: summary_chrome_extract.lua:219
function crop_rgba(rgba: string, W: number, x: number, y: number, w: number, h: number): string {
  const rows: string[] = [];
  for (let row = 0; row <= h - 1; row++) {
    const start = ((y + row) * W + x) * 4 + 1;
    rows.push(sub(rgba, start, start + w * 4 - 1));
  }
  return rows.join("");
}

function indexed_rgba(pixels: number[], pal: Pal, n: number): string {
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const idx = pixels[i] ?? 0;
    if (idx !== 0) {
      const [r, g, b] = bgr555_to_rgb8(pal[idx] ?? 0);
      out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = 255;
    }
  }
  return fromBytes(out);
}

// Lua: summary_chrome_extract.lua:229 -- Bake tile strip (e.g. 12 tiles in a horizontal line: 96x8 px).
function bake_strip_rgba(gfx: ByteSrc, palBytes: ByteSrc | undefined, numTiles: number, palBank?: number): [string, number, number] {
  const W = numTiles * 8, H = 8;
  const banks = load_pal_banks(palBytes, Math.max(1, Math.floor(byte_len(palBytes) / 32)));
  const pal = banks[palBank ?? 0] ?? banks[0] ?? {};
  const tileCount = Math.floor(byte_len(gfx) / 32);
  const pixels = new Array<number>(W * H).fill(0);
  for (let ti = 0; ti <= numTiles - 1; ti++) {
    if (ti < tileCount) decode_tile_4bpp(tileAt(gfx, ti), pixels, ti * 8, 0, W, false, false);
  }
  return [indexed_rgba(pixels, pal, W * H), W, H];
}

// Lua: summary_chrome_extract.lua:261 -- Bake multi-tile sprite sheet (e.g. status icons: 4 tiles wide x 8 frames = 32x64).
function bake_sheet_rgba(gfx: ByteSrc, palBytes: ByteSrc, tilesX: number, tilesY: number, palBank?: number): [string, number, number] {
  const W = tilesX * 8, H = tilesY * 8;
  const banks = load_pal_banks(palBytes, Math.max(1, Math.floor(byte_len(palBytes) / 32)));
  const pal = banks[palBank ?? 0] ?? banks[0] ?? {};
  const tileCount = Math.floor(byte_len(gfx) / 32);
  const pixels = new Array<number>(W * H).fill(0);
  let ti = 0;
  for (let ty = 0; ty <= tilesY - 1; ty++) {
    for (let tx = 0; tx <= tilesX - 1; tx++) {
      if (ti < tileCount) decode_tile_4bpp(tileAt(gfx, ti), pixels, tx * 8, ty * 8, W, false, false);
      ti = ti + 1;
    }
  }
  return [indexed_rgba(pixels, pal, W * H), W, H];
}

// Lua: summary_chrome_extract.lua:297 -- Set a tile (or rectangle of tiles) in a 32-wide GBA tilemap (0-based map).
function set_tilemap_rect(map: number[], tileNum: number, tx: number, ty: number, tw = 1, th = 1): void {
  const lo = tileNum % 256;
  const hi = Math.floor(tileNum / 256);
  for (let dy = 0; dy <= th - 1; dy++) {
    for (let dx = 0; dx <= tw - 1; dx++) {
      const idx = ((ty + dy) * 32 + (tx + dx)) * 2;
      map[idx] = lo;
      map[idx + 1] = hi;
    }
  }
}

// Lua: summary_chrome_extract.lua:313 -- Apply FRLG PokeSum_DrawPageProgressTiles dynamically to the base BG3 tilemap.
// Base tile number offset is 345 (0x159).
function apply_page_progress_tiles(baseMapBytes: ByteSrc | undefined, pageKind: string): string | undefined {
  if (baseMapBytes === undefined) return undefined;
  const map: number[] = [];
  const blen = byte_len(baseMapBytes);
  for (let i = 0; i < blen; i++) map[i] = get_byte(baseMapBytes, i);
  const BASE = 345;
  const s = (t: number, x: number, y: number, w?: number, h?: number): void => set_tilemap_rect(map, t + BASE, x, y, w, h);

  if (pageKind === "info") {
    s(17, 13, 0, 1, 1); s(33, 13, 1, 1, 1); s(16, 14, 0, 1, 1); s(32, 14, 1, 1, 1);
    s(18, 15, 0, 1, 1); s(34, 15, 1, 1, 1); s(20, 16, 0, 1, 1); s(36, 16, 1, 1, 1);
    s(18, 17, 0, 1, 1); s(34, 17, 1, 1, 1); s(21, 18, 0, 1, 1); s(37, 18, 1, 1, 1);
  } else if (pageKind === "skills") {
    s(49, 13, 0, 1, 1); s(65, 13, 1, 1, 1); s(1, 14, 0, 1, 1); s(19, 14, 1, 1, 1);
    s(17, 15, 0, 1, 1); s(33, 15, 1, 1, 1); s(16, 16, 0, 1, 1); s(32, 16, 1, 1, 1);
    s(18, 17, 0, 1, 1); s(34, 17, 1, 1, 1); s(21, 18, 0, 1, 1); s(37, 18, 1, 1, 1);
  } else if (pageKind === "moves") {
    s(49, 13, 0, 1, 1); s(65, 13, 1, 1, 1); s(1, 14, 0, 1, 1); s(19, 14, 1, 1, 1);
    s(49, 15, 0, 1, 1); s(65, 15, 1, 1, 1); s(1, 16, 0, 1, 1); s(19, 16, 1, 1, 1);
    s(17, 17, 0, 1, 1); s(33, 17, 1, 1, 1); s(48, 18, 0, 1, 1); s(64, 18, 1, 1, 1);
  } else if (pageKind === "moves_info") {
    s(49, 13, 0, 1, 1); s(65, 13, 1, 1, 1); s(1, 14, 0, 1, 1); s(19, 14, 1, 1, 1);
    s(49, 15, 0, 1, 1); s(65, 15, 1, 1, 1); s(1, 16, 0, 1, 1); s(19, 16, 1, 1, 1);
    s(50, 17, 0, 1, 1); s(66, 17, 1, 1, 1); s(48, 18, 0, 1, 1); s(64, 18, 1, 1, 1);
  } else if (pageKind === "moves_info_select") {
    // pokefirered/src/pokemon_summary_screen.c:3334
    s(1, 13, 0, 4, 1); s(19, 13, 1, 4, 1);
    s(50, 17, 0, 1, 1); s(66, 17, 1, 1, 1); s(48, 18, 0, 1, 1); s(64, 18, 1, 1, 1);
  } else if (pageKind === "egg") {
    s(17, 13, 0, 1, 1); s(33, 13, 1, 1, 1); s(48, 14, 0, 1, 1); s(64, 14, 1, 1, 1);
    s(2, 15, 0, 4, 2);
  }

  // Lua: `for i = 1, #map` -- the border of a sequence written 1..blen
  // (set_tilemap_rect stays inside the 32x32 map, so it adds no holes)
  let out = "";
  for (let i = 0; i < map.length; i++) out += String.fromCharCode(map[i]!);
  return out;
}

export interface SummaryChromeOpts { cacheRoot?: string; width?: number; height?: number }

export const SummaryChromeExtract = {
  CACHE_SUB: "pokemon/summary",

  // Lua: summary_chrome_extract.lua:397
  run(rom: Rom, cache: Cache, opts: SummaryChromeOpts = {}): { root: string; width: number; height: number } {
    const root = (opts.cacheRoot ?? default_cache_root()) + "/" + SummaryChromeExtract.CACHE_SUB;
    const W = opts.width ?? 240;
    const H = opts.height ?? 160;

    const get = (i: number): number => (rom && rom.get ? rom.get(i) : 0);
    const read_bytes = (off: number, len: number): number[] => {
      const t: number[] = [];
      for (let i = 1; i <= len; i++) t[i - 1] = get(off + i - 1);
      return t;
    };

    // Background tiles & palettes
    const bgGfx = rom ? Lz77.decompress(get, Versions.SUMMARY_BG_GFX)[0] : undefined;
    const bgPal = rom ? read_bytes(Versions.SUMMARY_BG_PAL, 7 * 32) : undefined;

    // Tilemaps for each page
    const mapInfo = rom ? Lz77.decompress(get, Versions.SUMMARY_PAGE_INFO_TILEMAP)[0] : undefined;
    const mapSkills = rom ? Lz77.decompress(get, Versions.SUMMARY_PAGE_SKILLS_TILEMAP)[0] : undefined;
    const mapMoves = rom ? Lz77.decompress(get, Versions.SUMMARY_PAGE_MOVES_TILEMAP)[0] : undefined;
    const mapMovesInfo = rom ? Lz77.decompress(get, Versions.SUMMARY_PAGE_MOVES_INFO_TILEMAP)[0] : undefined;
    const mapEgg = rom ? Lz77.decompress(get, Versions.SUMMARY_PAGE_EGG_TILEMAP)[0] : undefined;

    // Pret stacks BG3 base (moves_info_page / moves_page) under page overlays.
    // ROM decompression is tried first so Android never needs the pokefirered/ source tree.
    const baseInfo = load_base_tilemap("info", get);
    const baseMoves = load_base_tilemap("moves", get);

    if (bgGfx && bgPal && mapInfo) {
      cache.write(root + "/page_info.rgba",
        bake_page_composited(bgGfx, bgPal, mapInfo, apply_page_progress_tiles(baseInfo, "info"), W, H));

      // pokefirered/src/pokemon_summary_screen.c:2009
      const variants: { suffix: string; slots?: Record<number, number> }[] = [
        { suffix: "", slots: undefined }, { suffix: "_shiny", slots: { 0: 6, 1: 5 } }];
      const bases: Record<string, ByteSrc | undefined> = { info: baseInfo, moves: baseMoves };
      const progress: Record<string, ByteSrc | undefined> = {
        info: baseInfo, skills: baseInfo, moves: baseInfo, egg: baseInfo,
        moves_info: baseMoves, moves_info_select: baseMoves,
      };
      const layers: Record<string, ByteSrc | undefined> = { info: mapInfo, skills: mapSkills, moves: mapMoves, moves_info: mapMovesInfo, egg: mapEgg };
      // (pairs order only orders the writes, not their contents)
      for (const v of variants) {
        const shiny = v.slots !== undefined;
        for (const kind of Object.keys(bases)) {
          cache.write(root + "/bg3_" + kind + v.suffix + ".rgba", bake_bg_rgba(bgGfx, bgPal, bases[kind], W, H, false, v.slots));
        }
        for (const kind of Object.keys(progress)) {
          if (!(shiny && kind === "egg")) {
            const full = bake_bg_rgba(bgGfx, bgPal, apply_page_progress_tiles(progress[kind], kind), W, H, false, v.slots);
            cache.write(root + "/progress_" + kind + v.suffix + ".rgba",
              crop_rgba(full, W, PROGRESS_X, PROGRESS_Y, PROGRESS_W, PROGRESS_H));
          }
        }
        for (const kind of Object.keys(layers)) {
          const map = layers[kind];
          if (map && !(shiny && kind === "egg")) {
            cache.write(root + "/layer_" + kind + v.suffix + ".rgba", bake_bg_rgba(bgGfx, bgPal, map, W, H, true, v.slots));
          }
        }
      }
    }

    const markGfx = rom && Versions.MON_MARKINGS_GFX ? read_bytes(Versions.MON_MARKINGS_GFX, 2048) : undefined;
    const markPal = rom && Versions.SUMMARY_MARKING_PAL ? read_bytes(Versions.SUMMARY_MARKING_PAL, 32) : undefined;
    if (markGfx && markPal) cache.write(root + "/markings.rgba", bake_sheet_rgba(markGfx, markPal, 4, 16, 0)[0]);

    const rgb_of = (bank: Pal, idx: number): string => {
      const [r, g, b] = bgr555_to_rgb8(bank[idx] ?? 0);
      return format("{ %d, %d, %d }", r, g, b);
    };
    let moveTextColors = "{}";
    if (rom && Versions.SUMMARY_TEXT_MOVES_PAL) {
      const bank = load_pal_banks(read_bytes(Versions.SUMMARY_TEXT_MOVES_PAL, 32), 1)[0]!;
      // pokefirered/src/pokemon_summary_screen.c:645
      const pairsIdx = [[7, 8], [1, 2], [3, 4], [5, 6]];
      const rows: string[] = [];
      pairsIdx.forEach((p, i) => {
        rows[i] = format("[%d] = { fg = %s, shadow = %s }", i, rgb_of(bank, p[0]!), rgb_of(bank, p[1]!));
      });
      moveTextColors = "{ " + rows.join(", ") + " }";
    }

    const sbyte = (b: number): string => tostring(b >= 128 ? b - 256 : b);
    let monPicBounce = "{}";
    if (rom && Versions.SUMMARY_MON_PIC_BOUNCE) {
      const lens = [3, 5, 7, 7];
      let off = Versions.SUMMARY_MON_PIC_BOUNCE;
      const rows: string[] = [];
      for (const n of lens) {
        const vals: string[] = [];
        for (let j = 1; j <= n; j++) vals.push(sbyte(get(off + j - 1)));
        rows.push("{ " + vals.join(", ") + " }");
        off = off + n;
      }
      monPicBounce = "{ " + rows.join(", ") + " }";
    }

    let eggPicShake = "{}";
    if (rom && Versions.SUMMARY_MON_PIC_BOUNCE) {
      // pokefirered/src/pokemon_summary_screen.c:944
      let off = Versions.SUMMARY_MON_PIC_BOUNCE + 3 + 5 + 7 + 7;
      const rows: string[] = [];
      for (const n of [11, 11, 15]) {
        const vals: string[] = [];
        for (let j = 1; j <= n; j++) vals.push(sbyte(get(off + j - 1)));
        rows.push("{ " + vals.join(", ") + " }");
        off = off + n;
      }
      eggPicShake = "{ " + rows.join(", ") + " }";
    }

    let noFlip = "{}";
    if (rom && Versions.SPECIES_INFO && Versions.SPECIES_INFO_SIZE && Versions.NUM_SPECIES) {
      const ids: string[] = [];
      for (let sp = 1; sp <= Versions.NUM_SPECIES - 1; sp++) {
        // pokefirered/include/pokemon.h:235
        if (get(Versions.SPECIES_INFO + sp * Versions.SPECIES_INFO_SIZE + 0x19) >= 128) ids.push("[" + tostring(sp) + "] = true");
      }
      noFlip = "{ " + ids.join(", ") + " }";
    }

    // HP Bar & EXP Bar
    const hpGfx = rom ? Lz77.decompress(get, Versions.SUMMARY_HP_BAR_GFX)[0] : undefined;
    const expGfx = rom ? Lz77.decompress(get, Versions.SUMMARY_EXP_BAR_GFX)[0] : undefined;
    const hpExpPal = rom ? read_bytes(Versions.SUMMARY_HP_EXP_PAL, 32) : undefined;
    const hpYellowPal = rom ? read_bytes(Versions.SUMMARY_HP_BAR_YELLOW_PAL, 32) : undefined;
    const hpRedPal = rom ? read_bytes(Versions.SUMMARY_HP_BAR_RED_PAL, 32) : undefined;

    if (hpGfx && hpExpPal) {
      cache.write(root + "/hp_bar_green.rgba", bake_strip_rgba(hpGfx, hpExpPal, 12, 0)[0]);
      cache.write(root + "/hp_bar_yellow.rgba", bake_strip_rgba(hpGfx, hpYellowPal, 12, 0)[0]);
      cache.write(root + "/hp_bar_red.rgba", bake_strip_rgba(hpGfx, hpRedPal, 12, 0)[0]);
    }
    if (expGfx && hpExpPal) cache.write(root + "/exp_bar.rgba", bake_strip_rgba(expGfx, hpExpPal, 12, 0)[0]);

    // Status Ailment Icons (LZ 4bpp, 1024 bytes = 32 tiles = 4 tiles wide x 8 frames = 32x64)
    const statusGfx = rom ? Lz77.decompress(get, Versions.SUMMARY_STATUS_ICONS_GFX)[0] : undefined;
    const statusPal = rom ? read_bytes(Versions.SUMMARY_STATUS_ICONS_PAL, 32) : undefined;
    if (statusGfx && statusPal) cache.write(root + "/status_icons.rgba", bake_sheet_rgba(statusGfx, statusPal, 4, 8, 0)[0]);

    // Cursors (LZ 4bpp, 64x64 = 8 tiles wide x 8 tiles high)
    const curLeftGfx = rom ? Lz77.decompress(get, Versions.SUMMARY_CURSOR_LEFT_GFX)[0] : undefined;
    const curRightGfx = rom ? Lz77.decompress(get, Versions.SUMMARY_CURSOR_RIGHT_GFX)[0] : undefined;
    const curPal = rom ? read_bytes(Versions.SUMMARY_CURSOR_PAL, 32) : undefined;
    if (curLeftGfx && curPal) cache.write(root + "/cursor_left.rgba", bake_sheet_rgba(curLeftGfx, curPal, 8, 8, 0)[0]);
    if (curRightGfx && curPal) cache.write(root + "/cursor_right.rgba", bake_sheet_rgba(curRightGfx, curPal, 8, 8, 0)[0]);

    // Shiny star (8x16) & Pokerus (8x8)
    const starGfx = rom ? Lz77.decompress(get, Versions.SUMMARY_SHINY_STAR_GFX)[0] : undefined;
    const starPal = rom ? read_bytes(Versions.SUMMARY_SHINY_STAR_PAL, 32) : undefined;
    if (starGfx && starPal) cache.write(root + "/shiny_star.rgba", bake_sheet_rgba(starGfx, starPal, 1, 2, 0)[0]);

    const pkrsGfx = rom ? Lz77.decompress(get, Versions.SUMMARY_POKERUS_GFX)[0] : undefined;
    const pkrsPal = rom ? read_bytes(Versions.SUMMARY_POKERUS_PAL, 32) : undefined;
    if (pkrsGfx && pkrsPal) cache.write(root + "/pokerus.rgba", bake_sheet_rgba(pkrsGfx, pkrsPal, 1, 1, 0)[0]);

    // pokefirered/src/list_menu.c:738
    if (rom && Versions.MENU_INFO_GFX && Versions.MENU_INFO_PAL) {
      const miGfx = read_bytes(Versions.MENU_INFO_GFX, (128 * 128) / 2);
      const miPal = read_bytes(Versions.MENU_INFO_PAL, 64);
      const [caught] = bake_sheet_rgba(miGfx, miPal, 16, 16, 0);
      const [types] = bake_sheet_rgba(miGfx, miPal, 16, 16, 1);
      const split = 16 * 128 * 4;
      cache.write(root + "/menu_info.rgba", sub(caught, 1, split) + sub(types, split + 1));
    }

    const menuInfoBin = read_bin([
      "src/import/gba/chrome/menus/menu_info.png",
      "data/generated/gba/pokemon/summary/menu_info.png",
    ]);
    if (menuInfoBin) cache.write(root + "/menu_info.png", menuInfoBin);

    // Manifest: absolute screen coords derived from pret window templates + printers
    // (pokemon_summary_screen.c PrintInfoPage / PrintSkillsPage / PrintMovesPage / etc.).
    const manifest = format(`
return {
  width = %d,
  height = %d,
  pages = {
    INFO = 0,
    SKILLS = 1,
    MOVES = 2,
    MOVES_INFO = 3,
    EGG = 4,
  },
  coords = {
    -- CreateMonPicSprite(..., 60, 65) \xe2\x80\x94 CreateSprite center of 64x64 (draw at cx-32,cy-32)
    monPic = { x = 60, y = 65, w = 64, h = 64 },
    ball = { x = 106, y = 88, w = 16, h = 16 },
    -- WIN_LVL_NICK at (0,16): Lv(4,2) Nick(40,2) Gender(105,2)
    level = { x = 4, y = 18 },
    name = { x = 40, y = 18 },
    gender = { x = 105, y = 18 },
    -- WIN_INFO_3 at (120,16): dex/species/OT/ID/item + type blit
    dexNo = { x = 167, y = 21 },
    species = { x = 167, y = 35 },
    type1 = { x = 167, y = 51, w = 32, h = 12 },
    type2 = { x = 203, y = 51, w = 32, h = 12 },
    otName = { x = 167, y = 65 },
    otId = { x = 167, y = 80 },
    item = { x = 167, y = 95 },
    -- WIN_INFO_4 trainer memo at (8,112)
    memo = { x = 8, y = 115, w = 224, h = 40 },
    -- WIN_SKILLS_3 at (160,16) + HP/EXP bar sprites
    hpText = { x = 174, y = 20 },
    hpBar = { x = 168, y = 32, w = 48, h = 8 },
    atk = { x = 210, y = 38 },
    def = { x = 210, y = 51 },
    spAtk = { x = 210, y = 64 },
    spDef = { x = 210, y = 77 },
    spd = { x = 210, y = 90 },
    expPointsLabel = { x = 74, y = 103 },
    nextLvLabel = { x = 74, y = 116 },
    expTotal = { x = 175, y = 103 },
    expNext = { x = 175, y = 116 },
    expBar = { x = 152, y = 128, w = 64, h = 8 },
    -- WIN_SKILLS_5 ability pane at (8,128)
    abilityName = { x = 74, y = 129 },
    abilityDesc = { x = 10, y = 143, w = 232, h = 16 },
    -- src/pokemon_summary_screen.c:4387
    status = { x = 0, y = 34 },
    statusMovesInfo = { x = 0, y = 41 },
    -- src/pokemon_summary_screen.c:4800, :4830, :4716
    shinyStar = { x = 102, y = 36 },
    shinyStarMovesInfo = { x = 4, y = 20 },
    pokerus = { x = 110, y = 88 },
    -- src/pokemon_summary_screen.c:4888
    markings = { x = 4, y = 87 },
    -- src/pokemon_summary_screen.c:4152
    monIcon = { x = 8, y = 16 },
    -- src/pokemon_summary_screen.c:3377
    movesInfoType1 = { x = 48, y = 35 },
    movesInfoType2 = { x = 84, y = 35 },
  },
  moveTextColors = %s,
  monPicBounce = %s,
  eggPicShake = %s,
  noFlip = %s,
  -- WIN_MOVES_5 types at (120,16); WIN_MOVES_3 names/PP at (160,16)
  -- GetMoveNamePrinterYpos(i)=i*28+5, GetMovePpPrinterYpos(i)=i*28+16
  moveSlots = {
    { nameX = 163, nameY = 21, typeX = 123, typeY = 21, ppX = 196, ppY = 32 },
    { nameX = 163, nameY = 49, typeX = 123, typeY = 49, ppX = 196, ppY = 60 },
    { nameX = 163, nameY = 77, typeX = 123, typeY = 77, ppX = 196, ppY = 88 },
    { nameX = 163, nameY = 105, typeX = 123, typeY = 105, ppX = 196, ppY = 116 },
  },
  -- WIN_MOVES_4 move stats at (0,56)
  movesInfo = {
    power = { x = 57, y = 57 },
    accuracy = { x = 57, y = 71 },
    desc = { x = 7, y = 98, w = 112, h = 48 },
  },
}
`.slice(1), W, H, moveTextColors, monPicBounce, eggPicShake, noFlip);
    cache.write(root + "/manifest.lua", manifest);

    return { root, width: W, height: H };
  },

  // Lua: summary_chrome_extract.lua:694
  // NOT FAITHFUL: without a cache, only CacheFs is consulted (no love.filesystem / io.open).
  ready(cache: Cache | undefined, cacheRoot?: string): boolean {
    const root = (cacheRoot ?? default_cache_root()) + "/" + SummaryChromeExtract.CACHE_SUB;
    const need = root + "/page_info.rgba";
    if (cache) {
      if (cache.read) {
        const d = cache.read(need);
        return (d !== undefined && d.length >= 240 * 160 * 4) || false;
      } else if (cache.exists) {
        return cache.exists(need) || false;
      }
      return false;
    }
    try {
      const d = CacheFs.readActive(need);
      if (d !== undefined && d.length >= 240 * 160 * 4) return true;
    } catch { /* no bound cache */ }
    return false;
  },
};

export default SummaryChromeExtract;
