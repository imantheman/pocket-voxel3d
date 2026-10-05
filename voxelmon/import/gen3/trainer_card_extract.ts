// Port of gen1recomp src/import/gba/trainer_card_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// Trainer card chrome extractor for Game 3 (FRLG).
// Bakes card backgrounds (male & female) and badge sheet from ROM into CacheFS (data/generated/gba/trainer_card/).
// Byte tables (LZ77 output, palette bytes) and pixel index buffers are
// 0-based here (the Lua's 1-based); palette banks keyed from 0 as the Lua's.

import { Versions } from "./versions.ts";
import { Lz77 } from "./lz77.ts";
import { RseTrainerCardExtract } from "./rse/trainer_card_extract.ts";
import { CacheFs, type Cache } from "./cache.ts";
import { format, fromBytes, tonumber } from "./lua.ts";
import type { Rom } from "./rom.ts";

type Bytes = ArrayLike<number>;
type Bank = Record<number, number>;

// Lua: trainer_card_extract.lua:19 (extract_island1's CACHE_ROOT; callers pass cacheRoot)
function default_cache_root(): string {
  return "data/generated/gba";
}

// Lua: trainer_card_extract.lua:27
function bgr555_to_rgb8(c: unknown): [number, number, number] {
  const n = (tonumber(c) ?? 0) % 32768;
  const r5 = n % 32, g5 = Math.floor(n / 32) % 32, b5 = Math.floor(n / 1024) % 32;
  return [Math.floor((r5 * 255) / 31 + 0.5), Math.floor((g5 * 255) / 31 + 0.5), Math.floor((b5 * 255) / 31 + 0.5)];
}

// Lua: trainer_card_extract.lua:37
function byte_len(buf: unknown): number {
  if (typeof buf === "string") return buf.length;
  if (buf instanceof Uint8Array || Array.isArray(buf)) return buf.length;
  return 0;
}

// Lua: trainer_card_extract.lua:43 -- tileBytes and out 0-based
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

// Lua: trainer_card_extract.lua:61
function load_pal_banks(bytes: Bytes, count?: number): Bank[] {
  const banks: Bank[] = [];
  const n = count ?? Math.max(1, Math.floor(byte_len(bytes) / 32));
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

// Lua: trainer_card_extract.lua:76
function bake_card_composite_rgba(gfx: Bytes, banks: Bank[], mapFront: Bytes | undefined, mapBg: Bytes | undefined, W: number, H: number): string {
  const tileCount = Math.floor(byte_len(gfx) / 32);
  const mapW = 30, mapH = 20;
  const indices = new Array<number>(W * H).fill(0);
  const pals = new Array<number>(W * H).fill(0);

  const render_layer = (map: Bytes): void => {
    const tilesH = Math.min(mapH, Math.floor(H / 8));
    const tilesW = Math.min(mapW, Math.floor(W / 8));
    for (let ty = 0; ty <= tilesH - 1; ty++) {
      for (let tx = 0; tx <= tilesW - 1; tx++) {
        const mi = (ty * mapW + tx) * 2;
        const entry = (map[mi] ?? 0) + (map[mi + 1] ?? 0) * 256;
        const tileId = entry % 1024;
        const hflip = Math.floor(entry / 1024) % 2 === 1;
        const vflip = Math.floor(entry / 2048) % 2 === 1;
        const palNum = Math.floor(entry / 4096) % 16;
        if (tileId < tileCount) {
          const tile = tileAt(gfx, tileId);
          const tmp = new Array<number>(64).fill(0);
          decode_tile_4bpp(tile, tmp, 0, 0, 8, hflip, vflip);
          for (let row = 0; row <= 7; row++) {
            for (let col = 0; col <= 7; col++) {
              const px = tx * 8 + col, py = ty * 8 + row;
              if (px < W && py < H) {
                const idx = tmp[row * 8 + col] ?? 0;
                if (idx !== 0 || indices[py * W + px] === 0) {
                  const di = py * W + px;
                  indices[di] = idx;
                  pals[di] = palNum;
                }
              }
            }
          }
        }
      }
    }
  };

  if (mapBg) render_layer(mapBg);
  if (mapFront) render_layer(mapFront);

  const out = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const idx = indices[i] ?? 0;
    const bank = banks[pals[i] ?? 0] ?? banks[0];
    const c = bank ? bank[idx] ?? 0 : 0;
    const [r, g, b] = bgr555_to_rgb8(c);
    out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = 255;
  }
  return fromBytes(out);
}

/** Palette indices through one 16-colour palette, index 0 transparent. */
function indexed_rgba(pixels: number[], pal: Bank, n: number): string {
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

function pal16(palBytes: Bytes): Bank {
  const pal: Bank = {};
  for (let c = 0; c <= 15; c++) pal[c] = (palBytes[c * 2] ?? 0) + (palBytes[c * 2 + 1] ?? 0) * 256;
  return pal;
}

// Lua: trainer_card_extract.lua:133 -- 8 gym badges (16x16 each, TL TR BL BR tiles) into a 128x16 strip; [rgba, W, H]
function bake_badges_rgba(badgeTiles: Bytes, palBytes: Bytes): [string, number, number] {
  const W = 128, H = 16;
  const pal = pal16(palBytes);
  const pixels = new Array<number>(W * H).fill(0);
  for (let badge = 0; badge <= 7; badge++) {
    // 4 tiles per badge: TL (badge*2), TR (badge*2+1), BL (16+badge*2), BR (16+badge*2+1)
    const tiles: [number, number, number][] = [
      [badge * 2, 0, 0],
      [badge * 2 + 1, 8, 0],
      [16 + badge * 2, 0, 8],
      [16 + badge * 2 + 1, 8, 8],
    ];
    for (const [tileNum, ox, oy] of tiles) {
      decode_tile_4bpp(tileAt(badgeTiles, tileNum), pixels, badge * 16 + ox, oy, W, false, false);
    }
  }
  return [indexed_rgba(pixels, pal, W * H), W, H];
}

// Lua: trainer_card_extract.lua:174
function bake_tile_rgba(gfx: Bytes, palBytes: Bytes, tileNum: number): string {
  const pal = pal16(palBytes);
  const pixels = new Array<number>(64).fill(0);
  decode_tile_4bpp(tileAt(gfx, tileNum), pixels, 0, 0, 8, false, false);
  return indexed_rgba(pixels, pal, 64);
}

// Lua: trainer_card_extract.lua:200 (src/trainer_card.c:1450) -- [rgba, W, H]
function bake_stickers_rgba(stickerTiles: Bytes, palBytesList: Bytes[]): [string, number, number] {
  const cell = TrainerCardExtract.STICKER_SIZE;
  const slots = TrainerCardExtract.STICKER_SLOTS;
  const palCount = TrainerCardExtract.STICKER_PALETTES;
  const W = cell * slots, H = cell * palCount;
  const pixels = new Array<number>(W * H).fill(0);
  for (let slot = 0; slot <= slots - 1; slot++) {
    for (let row = 0; row <= 1; row++) {
      for (let col = 0; col <= 1; col++) {
        const tile = tileAt(stickerTiles, slot * 4 + row * 2 + col);
        for (let p = 0; p <= palCount - 1; p++) {
          decode_tile_4bpp(tile, pixels, slot * cell + col * 8, p * cell + row * 8, W, false, false);
        }
      }
    }
  }
  const pals: Bank[] = [];
  for (let p = 0; p <= palCount - 1; p++) pals[p] = pal16(palBytesList[p] ?? []);
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y <= H - 1; y++) {
    for (let x = 0; x <= W - 1; x++) {
      const idx = pixels[y * W + x] ?? 0;
      if (idx !== 0) {
        const bank = pals[Math.floor(y / cell)] ?? pals[0]!;
        const [r, g, b] = bgr555_to_rgb8(bank[idx] ?? 0);
        const o = (y * W + x) * 4;
        out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
      }
    }
  }
  return [fromBytes(out), W, H];
}

export interface TrainerCardResult { ok: boolean; root: string; width: number; height: number }

export const TrainerCardExtract = {
  CACHE_SUB: "trainer_card",
  FORMAT_VERSION: 3,
  // src/trainer_card.c:265 sKantoTrainerCardPals
  STAR_COUNT: 5,
  // src/trainer_card.c:1454, :1456 LoadStickerGfx
  STICKER_SLOTS: 4,
  STICKER_PALETTES: 4,
  STICKER_SIZE: 16,

  // Lua: trainer_card_extract.lua:246
  run(rom: Rom, cache: Cache, opts: { cacheRoot?: string; width?: number; height?: number } = {}): TrainerCardResult {
    const root = (opts.cacheRoot ?? default_cache_root()) + "/" + TrainerCardExtract.CACHE_SUB;
    const W = opts.width ?? 240;
    const H = opts.height ?? 160;

    const get = (i: number): number => (rom && rom.get ? rom.get(i) : 0) || 0;
    const read_bytes = (off: number, len: number): Uint8Array => {
      const t = new Uint8Array(len);
      for (let i = 0; i < len; i++) t[i] = get(off + i);
      return t;
    };
    const lz = (off: number): Uint8Array => Lz77.decompress(get, off)[0];

    const bgTiles = lz(Versions.TRAINER_CARD_BG_TILES ?? 0xe991f8);
    const mapFront = lz(Versions.TRAINER_CARD_FRONT_MAP ?? 0x3cc6f0);
    const mapBack = lz(Versions.TRAINER_CARD_BACK_MAP ?? 0x3cc984);
    const mapBg = lz(Versions.TRAINER_CARD_BG_MAP ?? 0x3ccec8);
    const palBytes = read_bytes(Versions.TRAINER_CARD_PAL ?? 0xe99198, 96);
    const femalePalBytes = read_bytes(Versions.TRAINER_CARD_FEMALE_PAL ?? 0x3cd2a0, 32);
    const badgePalBytes = read_bytes(Versions.TRAINER_CARD_BADGES_PAL ?? 0x3cd2e0, 32);
    const badgeTiles = lz(Versions.TRAINER_CARD_BADGES_TILES ?? 0x3cd5e8);

    // src/trainer_card.c:265 sKantoTrainerCardPals, index 0..4 by star count
    const starPalOffsets: Record<number, number> = {
      0: Versions.TRAINER_CARD_PAL ?? 0xe99198,
      1: Versions.TRAINER_CARD_GREEN_PAL ?? 0x3ccfe0,
      2: Versions.TRAINER_CARD_BRONZE_PAL ?? 0x3cd0a0,
      3: Versions.TRAINER_CARD_SILVER_PAL ?? 0x3cd160,
      4: Versions.TRAINER_CARD_GOLD_PAL ?? 0x3cd220,
    };

    const banks_for = (starPalBytes: Bytes, female: boolean): Bank[] => {
      const banks = load_pal_banks(starPalBytes, 3);
      // src/trainer_card.c:1494 sKantoTrainerCardFemaleBg_Pal overrides BG_PLTT_ID(1)
      if (female) banks[1] = pal16(femalePalBytes);
      return banks;
    };

    const maleBanks = banks_for(palBytes, false);
    const femaleBanks = banks_for(palBytes, true);

    if (bgTiles && mapFront && mapBg) {
      cache.write(root + "/bg.rgba", bake_card_composite_rgba(bgTiles, maleBanks, mapFront, mapBg, W, H));
      cache.write(root + "/bg_female.rgba", bake_card_composite_rgba(bgTiles, femaleBanks, mapFront, mapBg, W, H));

      for (let stars = 0; stars <= TrainerCardExtract.STAR_COUNT - 1; stars++) {
        const starBytes = read_bytes(starPalOffsets[stars]!, 96);
        for (const female of [false, true]) {
          const banks = banks_for(starBytes, female);
          const suffix = female ? "_female" : "";
          cache.write(format("%s/front_%d%s.rgba", root, stars, suffix),
            bake_card_composite_rgba(bgTiles, banks, mapFront, mapBg, W, H));
          if (mapBack) {
            cache.write(format("%s/back_%d%s.rgba", root, stars, suffix),
              bake_card_composite_rgba(bgTiles, banks, mapBack, mapBg, W, H));
          }
          cache.write(format("%s/screen_%d%s.rgba", root, stars, suffix),
            bake_card_composite_rgba(bgTiles, banks, undefined, mapBg, W, H));
        }
      }
    }

    if (badgeTiles && badgePalBytes) {
      cache.write(root + "/badges.rgba", bake_badges_rgba(badgeTiles, badgePalBytes)[0]);
    }

    // src/trainer_card.c:1560 FillBgTilemapBufferRect(3, 143, ..., 4)
    if (bgTiles) {
      const starPalBytes = read_bytes(Versions.TRAINER_CARD_STAR_PAL ?? 0x3cd300, 32);
      cache.write(root + "/star.rgba", bake_tile_rgba(bgTiles, starPalBytes, Versions.TRAINER_CARD_STAR_TILE ?? 143));
    }

    const stickerTiles = lz(Versions.TRAINER_CARD_STICKERS_TILES ?? 0x3cc368);
    if (stickerTiles) {
      const stickerPals = [
        read_bytes(Versions.TRAINER_CARD_STICKER_PAL1 ?? 0x3cd320, 32),
        read_bytes(Versions.TRAINER_CARD_STICKER_PAL2 ?? 0x3cd340, 32),
        read_bytes(Versions.TRAINER_CARD_STICKER_PAL3 ?? 0x3cd360, 32),
        read_bytes(Versions.TRAINER_CARD_STICKER_PAL4 ?? 0x3cd380, 32),
      ];
      cache.write(root + "/stickers.rgba", bake_stickers_rgba(stickerTiles, stickerPals)[0]);
    }

    const manifest = format(
      "return {\n"
      + "  version = %d,\n"
      + "  width = %d,\n"
      + "  height = %d,\n"
      + "  badgeWidth = 16,\n"
      + "  badgeHeight = 16,\n"
      + "  badgeCount = 8,\n"
      + "  starCount = %d,\n"
      + "  starWidth = 8,\n"
      + "  starHeight = 8,\n"
      + "  stickerWidth = %d,\n"
      + "  stickerHeight = %d,\n"
      + "  stickerSlots = %d,\n"
      + "  stickerPalettes = %d,\n"
      + "  pics = { male = %d, female = %d },\n"
      + "}\n",
      TrainerCardExtract.FORMAT_VERSION, W, H, TrainerCardExtract.STAR_COUNT,
      TrainerCardExtract.STICKER_SIZE, TrainerCardExtract.STICKER_SIZE,
      TrainerCardExtract.STICKER_SLOTS, TrainerCardExtract.STICKER_PALETTES,
      get(Versions.FACILITY_CLASS_TO_PIC_INDEX + Versions.TRAINER_CARD_PIC_CLASSES.male),
      get(Versions.FACILITY_CLASS_TO_PIC_INDEX + Versions.TRAINER_CARD_PIC_CLASSES.female));
    cache.write(root + "/manifest.lua", manifest);

    // src/trainer_card.c:155
    if (typeof Versions.HOENN_CARD === "object" && Versions.HOENN_CARD !== null) {
      RseTrainerCardExtract.run(rom, cache, { cacheRoot: opts.cacheRoot });
    }

    return { ok: true, root, width: W, height: H };
  },

  // Lua: trainer_card_extract.lua:377
  // NOT FAITHFUL: the no-cache fallbacks (love.filesystem / io.open) read CacheFs only.
  ready(cache: Cache | undefined, cacheRoot?: string): boolean {
    const root = (cacheRoot ?? default_cache_root()) + "/" + TrainerCardExtract.CACHE_SUB;
    const needRel = root + "/bg.rgba";
    const extra: [string, number][] = [
      [root + "/back_0.rgba", 240 * 160 * 4],
      [root + "/star.rgba", 8 * 8 * 4],
      [root + "/stickers.rgba", 64 * 64 * 4],
    ];
    if (cache) {
      if (cache.read) {
        const d = cache.read(needRel);
        if (!(d !== undefined && d.length >= 240 * 160 * 4)) return false;
        for (const row of extra) {
          const e = cache.read(row[0]);
          if (!(e !== undefined && e.length >= row[1])) return false;
        }
        return true;
      } else if (cache.exists) {
        if (!cache.exists(needRel)) return false;
        for (const row of extra) if (!cache.exists(row[0])) return false;
        return true;
      }
      return false;
    }
    try {
      const d = CacheFs.readActive(needRel);
      if (d !== undefined && d.length >= 240 * 160 * 4) return true;
    } catch { /* no cache bound */ }
    return false;
  },

  // Lua: trainer_card_extract.lua:421
  extract(rom: Rom, opts?: { cache?: Cache; cacheRoot?: string; width?: number; height?: number }): TrainerCardResult {
    return TrainerCardExtract.run(rom, opts?.cache as Cache, opts);
  },
};

export default TrainerCardExtract;
