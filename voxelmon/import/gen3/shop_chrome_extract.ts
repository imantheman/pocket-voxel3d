// Port of gen1recomp src/import/gba/shop_chrome_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// Bake FRLG Poke Mart shop/buy menu chrome into CacheFS (data/generated/gba/items/shop/).
// Source: pret graphics/shop_menu/ (shop_menu.4bpp.lz, shop_tilemap.bin.lz, shop_tm_hm_tilemap.bin.lz, shop_menu.gbapal.lz).
// Byte tables (the Lua's 1-based LZ77 output) are 0-based Uint8Arrays here;
// pixel index tables are 0-based arrays.

import { Versions } from "./versions.ts";
import { Lz77 } from "./lz77.ts";
import { CacheFs, type Cache } from "./cache.ts";
import { format, fromBytes, tonumber } from "./lua.ts";
import type { Rom } from "./rom.ts";

type Bytes = ArrayLike<number>;

// Lua: shop_chrome_extract.lua:12 (extract_island1's CACHE_ROOT; callers pass cacheRoot)
function default_cache_root(): string {
  return "data/generated/gba";
}

// Lua: shop_chrome_extract.lua:20
function bgr555_to_rgb8(c: unknown): [number, number, number] {
  const n = (tonumber(c) ?? 0) % 32768;
  const r5 = n % 32, g5 = Math.floor(n / 32) % 32, b5 = Math.floor(n / 1024) % 32;
  return [Math.floor((r5 * 255) / 31 + 0.5), Math.floor((g5 * 255) / 31 + 0.5), Math.floor((b5 * 255) / 31 + 0.5)];
}

// Lua: shop_chrome_extract.lua:30
function byte_len(buf: unknown): number {
  if (buf instanceof Uint8Array || Array.isArray(buf)) return buf.length;
  return 0;
}

// Lua: shop_chrome_extract.lua:35 -- tileBytes and out 0-based
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

// Lua: shop_chrome_extract.lua:53 -- banks keyed from 0
function load_pal_banks(bytes: Bytes, count?: number): number[][] {
  const banks: number[][] = [];
  const n = count ?? Math.floor(byte_len(bytes) / 32);
  for (let b = 0; b <= n - 1; b++) {
    const colors: number[] = [];
    const off = b * 32;
    for (let c = 0; c <= 15; c++) {
      const i = off + c * 2;
      colors[c] = (bytes[i] ?? 0) + (bytes[i + 1] ?? 0) * 256;
    }
    banks[b] = colors;
  }
  return banks;
}

// Lua: shop_chrome_extract.lua:68
function bake_bg_rgba(gfx: Bytes, palBytes: Bytes, map: Bytes, W: number, H: number): string {
  const tileCount = Math.floor(byte_len(gfx) / 32);
  const banks = load_pal_banks(palBytes);
  const mapW = 32;
  const indices = new Array<number>(W * H).fill(0);
  const pals = new Array<number>(W * H).fill(0);
  const tilesH = Math.min(32, Math.floor(H / 8));
  const tilesW = Math.min(32, Math.floor(W / 8));
  for (let ty = 0; ty <= tilesH - 1; ty++) {
    for (let tx = 0; tx <= tilesW - 1; tx++) {
      const mi = (ty * mapW + tx) * 2;
      const entry = (map[mi] ?? 0) + (map[mi + 1] ?? 0) * 256;
      let tileId = entry % 1024;
      const hflip = Math.floor(entry / 1024) % 2 === 1;
      const vflip = Math.floor(entry / 2048) % 2 === 1;
      const palNum = Math.floor(entry / 4096) % 16;
      if (tileId >= tileCount) tileId = 0;
      const tile: number[] = [];
      const base = tileId * 32;
      for (let i = 0; i < 32; i++) tile[i] = gfx[base + i] ?? 0;
      const tmp = new Array<number>(64).fill(0);
      decode_tile_4bpp(tile, tmp, 0, 0, 8, hflip, vflip);
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
    const bank = banks[pals[i] ?? 0] ?? banks[0];
    const c = bank ? bank[idx] ?? 0 : 0;
    const [r, g, b] = bgr555_to_rgb8(c);
    out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = idx === 0 ? 0 : 255;
  }
  return fromBytes(out);
}

export interface ShopChromeOpts { cacheRoot?: string; width?: number; height?: number }

export const ShopChromeExtract = {
  CACHE_SUB: "items/shop",
  FORMAT_VERSION: 1,

  // Lua: shop_chrome_extract.lua:115
  run(rom: Rom, cache: Cache, opts: ShopChromeOpts = {}): { root: string; width: number; height: number } {
    const cacheRoot = opts.cacheRoot ?? default_cache_root();
    const root = cacheRoot + "/" + ShopChromeExtract.CACHE_SUB;
    const W = opts.width ?? 240;
    const H = opts.height ?? 160;

    const get = (i: number): number => rom.get(i);
    const [gfx] = Lz77.decompress(get, Versions.SHOP_BG_GFX);
    const [pal] = Lz77.decompress(get, Versions.SHOP_BG_PAL);
    const [map] = Lz77.decompress(get, Versions.SHOP_BG_TILEMAP);
    const [tmMap] = Lz77.decompress(get, Versions.SHOP_BG_TM_TILEMAP);

    cache.write(root + "/bg.rgba", bake_bg_rgba(gfx, pal, map, W, H));
    cache.write(root + "/bg_tm.rgba", bake_bg_rgba(gfx, pal, tmMap, W, H));

    const manifest = format(`return {
  format_version = %d,
  width = %d,
  height = %d,
  bg = "bg.rgba",
  bgTm = "bg_tm.rgba",
}
`, ShopChromeExtract.FORMAT_VERSION, W, H);
    cache.write(root + "/manifest.lua", manifest);

    console.log(`[shop_chrome] bg + bg_tm baked → ${root}`);
    return { root, width: W, height: H };
  },

  // Lua: shop_chrome_extract.lua:150
  // NOT FAITHFUL: without a cache, only CacheFs is consulted (no love.filesystem / io.open).
  ready(cache: Cache | undefined, cacheRoot?: string): boolean {
    const root = (cacheRoot ?? default_cache_root()) + "/" + ShopChromeExtract.CACHE_SUB;
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
    return valid_file(root + "/bg.rgba", 240 * 160 * 4);
  },
};

export default ShopChromeExtract;
