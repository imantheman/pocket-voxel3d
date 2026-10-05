// Port of gen1recomp src/import/gba/berry_pouch_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// Bake FRLG Berry Pouch chrome from ROM into CacheFS (data/generated/gba/items/berry_pouch/).
// Source: pret graphics/berry_pouch/ (background.4bpp.lz, background.bin.lz, background.gbapal.lz, background_female.gbapal.lz, berry_pouch.4bpp.lz, berry_pouch.gbapal.lz).
// LZ77 output is a 0-based Uint8Array here (the Lua's 1-based table).

import { Versions } from "./versions.ts";
import { Lz77 } from "./lz77.ts";
import { BgBake, type Bytes } from "./bg_bake.ts";
import { format, fromBytes } from "./lua.ts";
import type { Cache } from "./cache.ts";
import type { Rom } from "./rom.ts";

// Lua: berry_pouch_extract.lua:13 (extract_island1's CACHE_ROOT; callers pass cacheRoot)
function default_cache_root(): string {
  return "data/generated/gba";
}

const bgr555_to_rgb8 = BgBake.bgr555ToRgb8;
const byte_len = BgBake.byteLen;
const decode_tile_4bpp = BgBake.decodeTile4bpp;
const load_pal_banks = BgBake.loadPalBanks;
const bake_bg_rgba = BgBake.bakeBgRgba;

// Lua: berry_pouch_extract.lua:28 -- Render 64x64 Berry Pouch animated sprite.
function bake_pouch_sprite_rgba(gfx: Bytes, palBytes: Bytes): string {
  const W = 64, H = 64;
  const banks = load_pal_banks(palBytes, 1);
  const pal = banks[0] ?? [];
  const tileCount = Math.floor(byte_len(gfx) / 32);
  const pixels = new Array<number>(W * H).fill(0);
  let ti = 0;
  for (let ty = 0; ty <= 7; ty++) {
    for (let tx = 0; tx <= 7; tx++) {
      if (ti < tileCount) {
        const tile: number[] = [];
        const base = ti * 32;
        for (let i = 0; i < 32; i++) tile[i] = gfx[base + i] ?? 0;
        decode_tile_4bpp(tile, pixels, tx * 8, ty * 8, W, false, false);
      }
      ti = ti + 1;
    }
  }
  const out = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const idx = pixels[i] ?? 0;
    if (idx !== 0) {
      const [r, g, b] = bgr555_to_rgb8(pal[idx] ?? 0);
      out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = 255;
    }
  }
  return fromBytes(out);
}

export interface BerryPouchOpts { cacheRoot?: string; width?: number; height?: number }

export const BerryPouchExtract = {
  CACHE_SUB: "items/berry_pouch",
  FORMAT_VERSION: 1,

  // Lua: berry_pouch_extract.lua:62
  run(rom: Rom, cache: Cache, opts: BerryPouchOpts = {}): { root: string; width: number; height: number } {
    const cacheRoot = opts.cacheRoot ?? default_cache_root();
    const root = cacheRoot + "/" + BerryPouchExtract.CACHE_SUB;
    const W = opts.width ?? 240;
    const H = opts.height ?? 160;

    const get = (i: number): number => rom.get(i);

    const [gfx] = Lz77.decompress(get, Versions.BERRY_POUCH_BG_GFX);
    const [map] = Lz77.decompress(get, Versions.BERRY_POUCH_BG_TILEMAP);
    const [palMale] = Lz77.decompress(get, Versions.BERRY_POUCH_BG_PAL);
    const [palFemaleOverride] = Lz77.decompress(get, Versions.BERRY_POUCH_BG_PAL_FEMALE);

    const maleBanks = load_pal_banks(palMale, 3);
    const femaleBanks = load_pal_banks(palMale, 3);
    const overrideBank = load_pal_banks(palFemaleOverride, 1)[0];
    if (overrideBank) femaleBanks[0] = overrideBank;

    // 1. Backgrounds
    const rgbaMale = bake_bg_rgba(gfx, maleBanks, map, W, H);
    const rgbaFemale = bake_bg_rgba(gfx, femaleBanks, map, W, H);
    cache.write(root + "/bg_male.rgba", rgbaMale);
    cache.write(root + "/bg_female.rgba", rgbaFemale);

    // 2. Berry Pouch Sprite (64x64)
    const [spriteGfx] = Lz77.decompress(get, Versions.BERRY_POUCH_SPRITE_GFX);
    const [spritePal] = Lz77.decompress(get, Versions.BERRY_POUCH_SPRITE_PAL);
    const pouchRgba = bake_pouch_sprite_rgba(spriteGfx, spritePal);
    cache.write(root + "/pouch.rgba", pouchRgba);

    const manifest = format(`return {
  format_version = %d,
  width = %d,
  height = %d,
  pouchW = 64,
  pouchH = 64,
}
`, BerryPouchExtract.FORMAT_VERSION, W, H);
    cache.write(root + "/manifest.lua", manifest);

    console.log(`[berry_pouch_extract] Berry Pouch chrome baked (2 backgrounds, 64x64 pouch sprite) -> ${root}`);
    return { root, width: W, height: H };
  },

  // Lua: berry_pouch_extract.lua:114
  ready(cache: Cache | undefined, cacheRoot?: string): boolean {
    const root = (cacheRoot ?? default_cache_root()) + "/" + BerryPouchExtract.CACHE_SUB;
    if (cache && cache.exists) return cache.exists(root + "/bg_male.rgba") && cache.exists(root + "/pouch.rgba");
    return false;
  },
};

export default BerryPouchExtract;
