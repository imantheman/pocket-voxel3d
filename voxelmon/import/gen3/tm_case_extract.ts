// Port of gen1recomp src/import/gba/tm_case_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// Bake FRLG TM Case chrome from ROM into CacheFS (data/generated/gba/items/tm_case/).
// Source: pret graphics/tm_case/ (tm_case.4bpp.lz, menu.bin.lz, tm_case.bin.lz, menu_male.gbapal.lz, menu_female.gbapal.lz, disc.4bpp.lz, disc_types_1.gbapal.lz, disc_types_2.gbapal.lz, hm.4bpp).
// Byte tables are 0-based here (the Lua's are 1-based); palette banks keyed from 0.

import { Versions } from "./versions.ts";
import { Lz77 } from "./lz77.ts";
import { format, fromBytes, tonumber } from "./lua.ts";
import type { Cache } from "./cache.ts";
import type { Rom } from "./rom.ts";

type Bytes = ArrayLike<number>;
type Bank = Record<number, number>;

// Lua: tm_case_extract.lua:12 (extract_island1's CACHE_ROOT; callers pass cacheRoot)
function default_cache_root(): string {
  return "data/generated/gba";
}

// Lua: tm_case_extract.lua:20
function bgr555_to_rgb8(c: unknown): [number, number, number] {
  const n = (tonumber(c) ?? 0) % 32768;
  const r5 = n % 32, g5 = Math.floor(n / 32) % 32, b5 = Math.floor(n / 1024) % 32;
  return [Math.floor((r5 * 255) / 31 + 0.5), Math.floor((g5 * 255) / 31 + 0.5), Math.floor((b5 * 255) / 31 + 0.5)];
}

// Lua: tm_case_extract.lua:30
function byte_len(buf: unknown): number {
  if (buf instanceof Uint8Array || Array.isArray(buf)) return buf.length;
  return 0;
}

// Lua: tm_case_extract.lua:35 -- tileBytes and out 0-based
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

// Lua: tm_case_extract.lua:53
function load_pal_banks(bytes: Bytes, count?: number): Bank[] {
  const banks: Bank[] = [];
  const n = count ?? Math.floor(byte_len(bytes) / 32);
  for (let b = 0; b <= n - 1; b++) {
    const colors: Bank = {};
    const off = b * 32;
    for (let c = 0; c <= 15; c++) {
      const i = off + c * 2;
      colors[c] = (bytes[i] ?? 0) + (bytes[i + 1] ?? 0) * 256;
    }
    banks[b] = colors;
  }
  return banks;
}

function tileAt(gfx: Bytes, tileId: number): number[] {
  const tile: number[] = [];
  const base = tileId * 32;
  for (let i = 0; i < 32; i++) tile[i] = gfx[base + i] ?? 0;
  return tile;
}

// Lua: tm_case_extract.lua:69 -- Render BG2 base background (menu tilemap).
function bake_tm_case_bg_rgba(gfx: Bytes, palBytes: Bytes, mapMenu: Bytes, W: number, H: number): string {
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
      const entry = (mapMenu[mi] ?? 0) + (mapMenu[mi + 1] ?? 0) * 256;
      const tileId = entry % 1024;
      const hflip = Math.floor(entry / 1024) % 2 === 1;
      const vflip = Math.floor(entry / 2048) % 2 === 1;
      const palNum = Math.floor(entry / 4096) % 16;
      if (tileId < tileCount) {
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
  }
  const out = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const bank = banks[pals[i]!] ?? banks[0] ?? {};
    const col = bank[indices[i]!] ?? 0;
    const [r, g, b] = bgr555_to_rgb8(col);
    out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = 255;
  }
  return fromBytes(out);
}

// Lua: tm_case_extract.lua:118 -- Render BG1 pocket cover overlay (foreground layer with alpha transparency).
function bake_tm_case_cover_rgba(gfx: Bytes, palBytes: Bytes, mapBg: Bytes, W: number, H: number): string {
  const tileCount = Math.floor(byte_len(gfx) / 32);
  const banks = load_pal_banks(palBytes);
  const mapW = 32;
  const indices = new Array<number>(W * H).fill(0);
  const pals = new Array<number>(W * H).fill(0);
  const hasTile = new Array<boolean>(W * H).fill(false);
  const tilesH = Math.min(32, Math.floor(H / 8));
  const tilesW = Math.min(32, Math.floor(W / 8));
  for (let ty = 0; ty <= tilesH - 1; ty++) {
    for (let tx = 0; tx <= tilesW - 1; tx++) {
      const mi = (ty * mapW + tx) * 2;
      const entry = (mapBg[mi] ?? 0) + (mapBg[mi + 1] ?? 0) * 256;
      const tileId = entry % 1024;
      const hflip = Math.floor(entry / 1024) % 2 === 1;
      const vflip = Math.floor(entry / 2048) % 2 === 1;
      const palNum = Math.floor(entry / 4096) % 16;
      if (tileId > 0 && tileId < tileCount) {
        const tmp = new Array<number>(64).fill(0);
        decode_tile_4bpp(tileAt(gfx, tileId), tmp, 0, 0, 8, hflip, vflip);
        for (let row = 0; row <= 7; row++) {
          for (let col = 0; col <= 7; col++) {
            const px = tx * 8 + col, py = ty * 8 + row;
            if (px < W && py < H) {
              const di = py * W + px;
              const idx = tmp[row * 8 + col] ?? 0;
              if (idx !== 0) {
                indices[di] = idx;
                pals[di] = palNum;
                hasTile[di] = true;
              }
            }
          }
        }
      }
    }
  }
  const out = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    if (hasTile[i]) {
      const bank = banks[pals[i]!] ?? banks[0] ?? {};
      const col = bank[indices[i]!] ?? 0;
      const [r, g, b] = bgr555_to_rgb8(col);
      out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = 255;
    }
  }
  return fromBytes(out);
}

// Lua: tm_case_extract.lua:175 -- Render 32x32 disc sprite with a given type palette (TM or HM).
function bake_disc_rgba(discGfx: Bytes, palBank: Bank, isHm: boolean): string {
  const W = 32, H = 32;
  const tileCount = Math.floor(byte_len(discGfx) / 32);
  const tileOffset = isHm ? 16 : 0;
  const pixels = new Array<number>(W * H).fill(0);
  let ti = 0;
  for (let ty = 0; ty <= 3; ty++) {
    for (let tx = 0; tx <= 3; tx++) {
      const tileIndex = tileOffset + ti;
      if (tileIndex < tileCount) decode_tile_4bpp(tileAt(discGfx, tileIndex), pixels, tx * 8, ty * 8, W, false, false);
      ti = ti + 1;
    }
  }
  const out = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const idx = pixels[i] ?? 0;
    if (idx !== 0) {
      const [r, g, b] = bgr555_to_rgb8(palBank[idx] ?? 0);
      out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = 255;
    }
  }
  return fromBytes(out);
}

// Lua: tm_case_extract.lua:209 -- Render 16x12 raw HM icon (2x2 8x8 tiles cropped).
function bake_hm_icon_rgba(hmGfx: Bytes, palBank: Bank): string {
  const W = 16, H = 12;
  const pixels = new Array<number>(16 * 16).fill(0);
  let ti = 0;
  for (let ty = 0; ty <= 1; ty++) {
    for (let tx = 0; tx <= 1; tx++) {
      decode_tile_4bpp(tileAt(hmGfx, ti), pixels, tx * 8, ty * 8, 16, false, false);
      ti = ti + 1;
    }
  }
  const out = new Uint8Array(W * H * 4);
  let o = 0;
  for (let y = 0; y <= H - 1; y++) {
    for (let x = 0; x <= W - 1; x++) {
      const idx = pixels[y * 16 + x] ?? 0;
      if (idx !== 0) {
        const [r, g, b] = bgr555_to_rgb8(palBank[idx] ?? 0);
        out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
      }
      o += 4;
    }
  }
  return fromBytes(out);
}

export interface TmCaseOpts { cacheRoot?: string; width?: number; height?: number }

export const TmCaseExtract = {
  CACHE_SUB: "items/tm_case",
  FORMAT_VERSION: 1,

  // Lua: tm_case_extract.lua:239
  run(rom: Rom, cache: Cache, opts: TmCaseOpts = {}): { root: string; width: number; height: number; discCount: number } {
    const cacheRoot = opts.cacheRoot ?? default_cache_root();
    const root = cacheRoot + "/" + TmCaseExtract.CACHE_SUB;
    const W = opts.width ?? 240;
    const H = opts.height ?? 160;

    const get = (i: number): number => rom.get(i);

    const [gfx] = Lz77.decompress(get, Versions.TM_CASE_BG_GFX);
    const [mapBg] = Lz77.decompress(get, Versions.TM_CASE_BG_TILEMAP);
    const [mapMenu] = Lz77.decompress(get, Versions.TM_CASE_MENU_TILEMAP);
    const [palMale] = Lz77.decompress(get, Versions.TM_CASE_MENU_MALE_PAL);
    const [palFemale] = Lz77.decompress(get, Versions.TM_CASE_MENU_FEMALE_PAL);

    // 1. BG2 Base Backgrounds
    cache.write(root + "/bg_male.rgba", bake_tm_case_bg_rgba(gfx, palMale, mapMenu, W, H));
    cache.write(root + "/bg_female.rgba", bake_tm_case_bg_rgba(gfx, palFemale, mapMenu, W, H));

    // 2. BG1 Foreground Pocket Covers (Priority 0 over sprites)
    cache.write(root + "/cover_male.rgba", bake_tm_case_cover_rgba(gfx, palMale, mapBg, W, H));
    cache.write(root + "/cover_female.rgba", bake_tm_case_cover_rgba(gfx, palFemale, mapBg, W, H));

    // 3. Discs (TM + HM for each type 0..16)
    const [discGfx] = Lz77.decompress(get, Versions.TM_CASE_DISC_GFX);
    const [discPal1] = Lz77.decompress(get, Versions.TM_CASE_DISC_TYPES1_PAL);
    const [discPal2] = Lz77.decompress(get, Versions.TM_CASE_DISC_TYPES2_PAL);
    const banks1 = load_pal_banks(discPal1, 16);
    const banks2 = load_pal_banks(discPal2, 1);

    const discBanks: (Bank | undefined)[] = [];
    for (let b = 0; b <= 15; b++) discBanks[b] = banks1[b];
    discBanks[16] = banks2[0]; // Dragon type

    for (let typeIdx = 0; typeIdx <= 16; typeIdx++) {
      const bank = discBanks[typeIdx] ?? {};
      cache.write(format("%s/disc_%d.rgba", root, typeIdx), bake_disc_rgba(discGfx, bank, false));
      cache.write(format("%s/disc_hm_%d.rgba", root, typeIdx), bake_disc_rgba(discGfx, bank, true));
    }

    // 4. HM Icon (16x16 tiled bitmap in ROM, 16x12 visible; FRLG tm_case.c:1491,1589)
    const hmGfx: number[] = [];
    for (let i = 1; i <= 128; i++) hmGfx[i - 1] = rom.get(Versions.TM_CASE_HM_GFX + i - 1);
    // FRLG sPal3Override on WIN_LIST palette 15: color 6 = RGB(8,8,8), color 7 = RGB(30,16,6)
    const hmPal: Bank = {
      0: 0,
      6: 8 + 8 * 32 + 8 * 1024, // RGB(8, 8, 8) = 0x2108 (dark grey)
      7: 30 + 16 * 32 + 6 * 1024, // RGB(30, 16, 6) = 0x1A1E (orange)
    };
    cache.write(root + "/hm_icon.rgba", bake_hm_icon_rgba(hmGfx, hmPal));

    const manifest = format(`return {
  format_version = %d,
  width = %d,
  height = %d,
  discW = 32,
  discH = 32,
  discCount = 17,
  hmW = 16,
  hmH = 12,
}
`, TmCaseExtract.FORMAT_VERSION, W, H);
    cache.write(root + "/manifest.lua", manifest);

    console.log(`[tm_case_extract] TM Case chrome baked (2 BGs, 2 Covers, 17 TM discs, 17 HM discs, HM icon) -> ${root}`);
    return { root, width: W, height: H, discCount: 17 };
  },

  // Lua: tm_case_extract.lua:320
  ready(cache: Cache | undefined, cacheRoot?: string): boolean {
    const root = (cacheRoot ?? default_cache_root()) + "/" + TmCaseExtract.CACHE_SUB;
    if (cache && cache.exists) {
      return cache.exists(root + "/bg_male.rgba") && cache.exists(root + "/cover_male.rgba") && cache.exists(root + "/disc_0.rgba");
    }
    return false;
  },
};

export default TmCaseExtract;
