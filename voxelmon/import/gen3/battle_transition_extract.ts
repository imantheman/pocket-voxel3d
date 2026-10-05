// Port of gen1recomp src/import/gba/battle_transition_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// Bake FRLG field->battle transition gfx from ROM -> data/generated/gba/pokemon/battle_transition/.
// Source: pret battle_transition.c INCBINs (uncompressed 4bpp + pals + tilemaps).
// Byte tables and pixel index tables are 0-based here (the Lua's 1-based);
// palettes keyed from 0 as the Lua keys them.

import { Versions } from "./versions.ts";
import { CacheFs, type Cache } from "./cache.ts";
import { format, fromBytes, tonumber } from "./lua.ts";
import type { Rom } from "./rom.ts";

type Bytes = ArrayLike<number>;
type Pal = Record<number, number>;

const MUGSHOT_KEYS = ["lorelei", "bruno", "agatha", "lance", "blue"];
const GENDER_KEYS = ["male", "female"];

// Lua: battle_transition_extract.lua:18 (extract_island1's CACHE_ROOT; callers pass cacheRoot)
function default_cache_root(): string {
  return "data/generated/gba";
}

// Lua: battle_transition_extract.lua:26
function log(msg: string): void {
  console.log("[gba/battle_transition] " + msg);
}

// Lua: battle_transition_extract.lua:30
function bgr555_to_rgb8(c: unknown): [number, number, number] {
  const n = (tonumber(c) ?? 0) % 32768;
  const r5 = n % 32, g5 = Math.floor(n / 32) % 32, b5 = Math.floor(n / 1024) % 32;
  return [Math.floor((r5 * 255) / 31 + 0.5), Math.floor((g5 * 255) / 31 + 0.5), Math.floor((b5 * 255) / 31 + 0.5)];
}

// Lua: battle_transition_extract.lua:40
function read_raw(rom: Rom, off: number, n: number): number[] {
  const t: number[] = [];
  for (let i = 0; i <= n - 1; i++) t[i] = rom.get(off + i);
  return t;
}

// Lua: battle_transition_extract.lua:46
function load_pal(rom: Rom, off: number): Pal {
  const pal: Pal = {};
  for (let c = 0; c <= 15; c++) pal[c] = rom.u16(off + c * 2);
  return pal;
}

// Lua: battle_transition_extract.lua:54
function decode_tile_4bpp(tileBytes: Bytes, out: number[], baseX: number, baseY: number, stride: number, hflip: boolean, vflip: boolean): void {
  for (let row = 0; row <= 7; row++) {
    const srcRow = vflip ? 7 - row : row;
    for (let bx = 0; bx <= 3; bx++) {
      const byte = tileBytes[srcRow * 4 + bx] ?? 0;
      const p0 = byte % 16, p1 = Math.floor(byte / 16) % 16;
      let x0 = bx * 2, x1 = x0 + 1;
      if (hflip) { x0 = 7 - x0; x1 = 7 - x1; }
      out[(baseY + row) * stride + (baseX + x0)] = p0;
      out[(baseY + row) * stride + (baseX + x1)] = p1;
    }
  }
}

// Lua: battle_transition_extract.lua:72
function byte_len(buf: unknown): number {
  if (typeof buf === "string") return buf.length;
  if (buf instanceof Uint8Array || Array.isArray(buf)) return buf.length;
  return 0;
}

function tileAt(gfx: Bytes, tileNum: number): number[] {
  const tile: number[] = [];
  const base = tileNum * 32;
  for (let i = 0; i < 32; i++) tile[i] = gfx[base + i] ?? 0;
  return tile;
}

// Lua: battle_transition_extract.lua:78 -- [indices, w, h]
function sheet_indices(gfx: Bytes, tilesW: number, tilesH: number): [number[], number, number] {
  const w = tilesW * 8, h = tilesH * 8;
  const indices = new Array<number>(w * h).fill(0);
  const tileCount = Math.floor(byte_len(gfx) / 32);
  for (let ty = 0; ty <= tilesH - 1; ty++) {
    for (let tx = 0; tx <= tilesW - 1; tx++) {
      const ti = ty * tilesW + tx;
      if (ti < tileCount) decode_tile_4bpp(tileAt(gfx, ti), indices, tx * 8, ty * 8, w, false, false);
    }
  }
  return [indices, w, h];
}

// Lua: battle_transition_extract.lua:98
function indices_to_rgba(indices: number[], pal: Pal, w: number, h: number, opts: { opaque0?: boolean } = {}): string {
  const opaque0 = opts.opaque0 === true;
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const idx = indices[i] ?? 0;
    if (!(idx === 0 && !opaque0)) {
      const [r, g, b] = bgr555_to_rgb8(pal[idx] ?? 0);
      out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = 255;
    }
  }
  return fromBytes(out);
}

// Lua: battle_transition_extract.lua:115 -- Bake a BG tilemap (cols x rows of u16) using a flat tile sheet + single pal.
function bake_tilemap_rgba(gfx: Bytes, pal: Pal, map: Bytes, cols: number, rows: number, opts: { opaque0?: boolean } = {}): [string, number, number] {
  const opaque0 = opts.opaque0 === true;
  const w = cols * 8, h = rows * 8;
  const indices = new Array<number>(w * h).fill(0);
  const tileCount = Math.floor(gfx.length / 32);
  for (let row = 0; row <= rows - 1; row++) {
    for (let col = 0; col <= cols - 1; col++) {
      const mi = (row * cols + col) * 2;
      const entry = (map[mi] ?? 0) + (map[mi + 1] ?? 0) * 256;
      const tileNum = entry % 1024;
      const hflip = Math.floor(entry / 1024) % 2 === 1;
      const vflip = Math.floor(entry / 2048) % 2 === 1;
      if (tileNum < tileCount) {
        const tmp = new Array<number>(64).fill(0);
        decode_tile_4bpp(tileAt(gfx, tileNum), tmp, 0, 0, 8, hflip, vflip);
        for (let ty = 0; ty <= 7; ty++) {
          for (let tx = 0; tx <= 7; tx++) {
            indices[(row * 8 + ty) * w + (col * 8 + tx)] = tmp[ty * 8 + tx] ?? 0;
          }
        }
      }
    }
  }
  return [indices_to_rgba(indices, pal, w, h, { opaque0 }), w, h];
}

// Lua: battle_transition_extract.lua:149
function merge_player_strip(oppPal: Pal, playerPal: Pal): Pal {
  const pal: Pal = {};
  for (let i = 0; i <= 15; i++) pal[i] = oppPal[i] ?? 0;
  // pret LoadPalette(playerPal, BG_PLTT_ID(15)+10, 6 colors)
  for (let i = 0; i <= 5; i++) pal[10 + i] = playerPal[i] ?? 0;
  return pal;
}

export interface BattleTransitionResult {
  root: string; bigW: number; bigH: number; slideW: number; slideH: number; gridW: number; gridH: number;
}

export const BattleTransitionExtract = {
  FORMAT_VERSION: 1,
  CACHE_SUB: "pokemon/battle_transition",
  REQUIRED: [
    "pokemon/battle_transition/manifest.lua",
    "pokemon/battle_transition/big_pokeball.rgba",
  ],

  // Lua: battle_transition_extract.lua:230 -- NOT PORTED: the Emerald (rse)
  // layout; Emerald is outside the FireRed port (docs/firered-engine.md).
  runRse(): never {
    throw new Error("battle_transition_extract: the rse layout is not ported");
  },

  // Lua: battle_transition_extract.lua:335 -- [result] or [undefined, err]
  run(rom: Rom, cache: Cache, opts: { cacheRoot?: string } = {}): [BattleTransitionResult | undefined, string?] {
    const cacheRoot = opts.cacheRoot ?? default_cache_root();
    const root = cacheRoot + "/" + BattleTransitionExtract.CACHE_SUB;
    const cfg = Versions.BATTLE_TRANSITION;
    if (!rom || !cache) return [undefined, "rom and cache required"];
    if (!cfg) return [undefined, "Versions.BATTLE_TRANSITION missing"];
    if (cfg.layout === "rse") BattleTransitionExtract.runRse();

    const ballPal = load_pal(rom, cfg.sliding_pokeball_pal);
    const bigGfx = read_raw(rom, cfg.big_pokeball_gfx, 1408);
    const bigMap = read_raw(rom, cfg.big_pokeball_tilemap, 1200);
    const [bigRgba, bw, bh] = bake_tilemap_rgba(bigGfx, ballPal, bigMap, 30, 20, { opaque0: true });
    cache.write(root + "/big_pokeball.rgba", bigRgba);

    const slideGfx = read_raw(rom, cfg.sliding_pokeball_gfx, 512);
    const [slideIdx, sw, sh] = sheet_indices(slideGfx, 4, 4);
    cache.write(root + "/sliding_pokeball.rgba", indices_to_rgba(slideIdx, ballPal, sw, sh));

    const gridGfx = read_raw(rom, cfg.grid_square_gfx, 480);
    const [gridIdx, gw, gh] = sheet_indices(gridGfx, 1, 15);
    cache.write(root + "/grid_square.rgba", indices_to_rgba(gridIdx, ballPal, gw, gh, { opaque0: true }));

    const bannerGfx = read_raw(rom, cfg.mugshot_banner_gfx, 480);
    const vsMap = read_raw(rom, cfg.vsbar_tilemap, 1280);
    const mugPals = cfg.mugshot_pals;
    const playerPals: Record<string, Pal> = {
      male: load_pal(rom, mugPals.red),
      female: load_pal(rom, mugPals.green),
    };

    for (const key of MUGSHOT_KEYS) {
      const oppPal = load_pal(rom, mugPals[key]);
      for (const gender of GENDER_KEYS) {
        const pal = merge_player_strip(oppPal, playerPals[gender]!);
        const [rgba] = bake_tilemap_rgba(bannerGfx, pal, vsMap, 32, 20, { opaque0: true });
        cache.write(root + "/vsbar_" + key + "_" + gender + ".rgba", rgba);
        // banner strip alone (useful for debug / partial draws)
        if (gender === "male") {
          const [bIdx, bmw, bmh] = sheet_indices(bannerGfx, 15, 1);
          cache.write(root + "/banner_" + key + ".rgba", indices_to_rgba(bIdx, oppPal, bmw, bmh));
        }
      }
    }

    const bytes_to_str = (arr: number[]): string => fromBytes(Uint8Array.from(arr, (v) => v ?? 0));
    // Keep paint tile + raw pals for trail / runtime recolor if needed.
    cache.write(root + "/sliding_pokeball_paint.bin", bytes_to_str(read_raw(rom, cfg.sliding_pokeball_bin, 64)));
    cache.write(root + "/pokeball.pal", bytes_to_str(read_raw(rom, cfg.sliding_pokeball_pal, 32)));

    const manifest = format(`return {
  format = %d,
  bigPokeball = { file = "big_pokeball.rgba", w = %d, h = %d },
  slidingPokeball = { file = "sliding_pokeball.rgba", w = %d, h = %d },
  gridSquare = { file = "grid_square.rgba", w = %d, h = %d, frames = 15, fw = 8, fh = 8 },
  vsbar = { w = 256, h = 160 },
  mugshots = { "lorelei", "bruno", "agatha", "lance", "blue" },
  genders = { "male", "female" },
  ids = {
    BLUR = 0, SWIRL = 1, SHUFFLE = 2, BIG_POKEBALL = 3, POKEBALLS_TRAIL = 4,
    CLOCKWISE_WIPE = 5, RIPPLE = 6, WAVE = 7, SLICE = 8, WHITE_BARS_FADE = 9,
    GRID_SQUARES = 10, ANGLED_WIPES = 11, LORELEI = 12, BRUNO = 13, AGATHA = 14,
    LANCE = 15, BLUE = 16, SPIRAL = 17,
  },
}
`, BattleTransitionExtract.FORMAT_VERSION, bw, bh, sw, sh, gw, gh);
    cache.write(root + "/manifest.lua", manifest);
    log(format("baked big=%dx%d slide=%dx%d grid=%dx%d vsbar×%d → %s",
      bw, bh, sw, sh, gw, gh, MUGSHOT_KEYS.length * GENDER_KEYS.length, root));

    return [{ root, bigW: bw, bigH: bh, slideW: sw, slideH: sh, gridW: gw, gridH: gh }];
  },

  // Lua: battle_transition_extract.lua:419
  // NOT FAITHFUL: without a cache, only CacheFs is consulted (no love.filesystem / io.open).
  ready(cache: Cache | undefined, cacheRoot?: string): boolean {
    const root = (cacheRoot ?? default_cache_root()) + "/" + BattleTransitionExtract.CACHE_SUB;
    const valid_file = (rel: string, minSize = 1): boolean => {
      if (cache) {
        if (cache.read) {
          const data = cache.read(rel);
          return (data !== undefined && data.length >= minSize) || false;
        } else if (cache.exists) {
          return cache.exists(rel) || false;
        }
        return false;
      }
      try {
        const data = CacheFs.readActive(rel);
        if (data !== undefined && data.length >= minSize) return true;
      } catch { /* no bound cache */ }
      return false;
    };
    return valid_file(root + "/manifest.lua", 20)
      && valid_file(root + "/big_pokeball.rgba", 64 * 64 * 4)
      && valid_file(root + "/sliding_pokeball.rgba", 32 * 32 * 4);
  },
};

export default BattleTransitionExtract;
