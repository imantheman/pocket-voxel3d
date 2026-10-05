// Port of gen1recomp src/import/gba/bag_chrome_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// Bake FRLG bag chrome + item icons into CacheFS (data/generated/gba/items/bag/).
// BG tilemap, male/female bag sprites, 24x24 item icons from sItemIconTable.
// The Lua's lz() gives a binary string and rom:readBytes a 1-based table;
// both are 0-based Uint8Arrays here (the bytes read are the same).

import { Versions } from "./versions.ts";
import { Lz77 } from "./lz77.ts";
import { format, fromBytes, tonumber, tostring } from "./lua.ts";
import type { Cache } from "./cache.ts";
import type { Rom } from "./rom.ts";

type Bytes = ArrayLike<number>;
type Pal = Record<number, number>;

// Lua: bag_chrome_extract.lua:13 (extract_island1's CACHE_ROOT; callers pass cacheRoot)
function default_cache_root(): string {
  return "data/generated/gba";
}

// Lua: bag_chrome_extract.lua:21
function bgr555_to_rgb8(c: unknown): [number, number, number] {
  const n = (tonumber(c) ?? 0) % 32768;
  const r5 = n % 32, g5 = Math.floor(n / 32) % 32, b5 = Math.floor(n / 1024) % 32;
  return [Math.floor((r5 * 255) / 31 + 0.5), Math.floor((g5 * 255) / 31 + 0.5), Math.floor((b5 * 255) / 31 + 0.5)];
}

// Lua: bag_chrome_extract.lua:52
function byte_len(buf: unknown): number {
  if (typeof buf === "string") return buf.length;
  if (buf instanceof Uint8Array || Array.isArray(buf)) return buf.length;
  return 0;
}

// Lua: bag_chrome_extract.lua:58
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

// Lua: bag_chrome_extract.lua:82
function load_pal_banks(bytes: Bytes, count?: number): Pal[] {
  const banks: Pal[] = [];
  const n = count ?? Math.floor(byte_len(bytes) / 32);
  for (let b = 0; b <= n - 1; b++) {
    const colors: Pal = {};
    const off = b * 32;
    for (let c = 0; c <= 15; c++) colors[c] = (bytes[off + c * 2] ?? 0) + (bytes[off + c * 2 + 1] ?? 0) * 256;
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

// Lua: bag_chrome_extract.lua:105
function bake_tiles_rgba(gfx: Bytes, banks: Pal[], W: number, H: number, entryAt: (tx: number, ty: number) => number | undefined): string {
  const tileCount = Math.floor(byte_len(gfx) / 32);
  const out = new Uint8Array(W * H * 4);
  const tmp = new Array<number>(64);
  for (let ty = 0; ty <= Math.floor(H / 8) - 1; ty++) {
    for (let tx = 0; tx <= Math.floor(W / 8) - 1; tx++) {
      const entry = entryAt(tx, ty) ?? 0;
      let tileId = entry % 1024;
      const hflip = Math.floor(entry / 1024) % 2 === 1;
      const vflip = Math.floor(entry / 2048) % 2 === 1;
      const bank = banks[Math.floor(entry / 4096) % 16] ?? banks[0];
      if (tileId >= tileCount) tileId = 0;
      tmp.fill(0);
      decode_tile_4bpp(tileAt(gfx, tileId), tmp, 0, 0, 8, hflip, vflip);
      for (let row = 0; row <= 7; row++) {
        for (let col = 0; col <= 7; col++) {
          const c = bank ? bank[tmp[row * 8 + col] ?? 0] ?? 0 : 0;
          const [r, g, b] = bgr555_to_rgb8(c);
          const o = ((ty * 8 + row) * W + tx * 8 + col) * 4;
          out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
        }
      }
    }
  }
  // NOTE: the Lua concatenates a sparse chunk table; W and H are always
  // multiples of 8 here, so every pixel is set, as in the Lua.
  return fromBytes(out);
}

// Lua: bag_chrome_extract.lua:137
function map_entry(map: Bytes, tx: number, ty: number): number {
  const mi = (ty * 32 + tx) * 2;
  return (map[mi] ?? 0) + (map[mi + 1] ?? 0) * 256;
}

// Lua: bag_chrome_extract.lua:145
function bake_bg_rgba(gfx: Bytes, banks: Pal[], map: Bytes, W: number, H: number): string {
  return bake_tiles_rgba(gfx, banks, W, H, (tx, ty) => map_entry(map, tx, ty));
}

// Lua: bag_chrome_extract.lua:151
function female_banks(palBytes: Bytes, femaleBytes: Bytes): Pal[] {
  const banks = load_pal_banks(palBytes);
  const over = load_pal_banks(femaleBytes, 1);
  if (over[0]) banks[0] = over[0];
  return banks;
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

// Lua: bag_chrome_extract.lua:158
function bake_red_arrow(gfx: Bytes, palBytes: Bytes): string {
  const W = 16, H = 32;
  const pal = load_pal_banks(palBytes, 1)[0] ?? {};
  const pixels = new Array<number>(W * H).fill(0);
  let ti = 0;
  for (let ty = 0; ty <= 3; ty++) {
    for (let tx = 0; tx <= 1; tx++) {
      decode_tile_4bpp(tileAt(gfx, ti), pixels, tx * 8, ty * 8, W, false, false);
      ti = ti + 1;
    }
  }
  return indexed_rgba(pixels, pal, W * H);
}

// Lua: bag_chrome_extract.lua:190 -- 64x256 sheet: 4 pocket frames x 64x64 (8x8 tiles each). Color0 transparent.
function bake_bag_sprite(gfx: Bytes, palBytes: Bytes): [string, number, number, number] {
  const W = 64, H = 256;
  const banks = load_pal_banks(palBytes, 1);
  const pal = banks[0] ?? {};
  const tileCount = Math.floor(byte_len(gfx) / 32);
  const pixels = new Array<number>(W * H).fill(0);
  let ti = 0;
  for (let frame = 0; frame <= 3; frame++) {
    for (let ty = 0; ty <= 7; ty++) {
      for (let tx = 0; tx <= 7; tx++) {
        if (ti < tileCount) decode_tile_4bpp(tileAt(gfx, ti), pixels, tx * 8, frame * 64 + ty * 8, W, false, false);
        ti = ti + 1;
      }
    }
  }
  return [indexed_rgba(pixels, pal, W * H), W, H, 4];
}

// Lua: bag_chrome_extract.lua:228 -- 24x24 item icon (3x3 tiles). Color0 transparent.
// (The Lua's FFI fast path and its table fallback produce the same bytes;
// this is the fallback.)
function bake_icon_rgba(gfx: Bytes, palBytes: Bytes): string {
  const W = 24, H = 24;
  const banks = load_pal_banks(palBytes, 1);
  const pal = banks[0] ?? {};
  const tileCount = Math.floor(byte_len(gfx) / 32);
  const pixels = new Array<number>(W * H).fill(0);
  let ti = 0;
  for (let ty = 0; ty <= 2; ty++) {
    for (let tx = 0; tx <= 2; tx++) {
      if (ti < tileCount) decode_tile_4bpp(tileAt(gfx, ti), pixels, tx * 8, ty * 8, W, false, false);
      ti = ti + 1;
    }
  }
  return indexed_rgba(pixels, pal, W * H);
}

// Lua: bag_chrome_extract.lua:319 -- src/item_menu_icons.c:121 sOamData_SwapLine, :129 sAnims_SwapLine
function bake_swap_line(gfx: Bytes, palBytes: Bytes): string {
  const W = 32, H = 16;
  const pal = load_pal_banks(palBytes, 1)[0] ?? {};
  const pixels = new Array<number>(W * H).fill(0);
  for (let frame = 0; frame <= 1; frame++) {
    for (let t = 0; t <= 3; t++) {
      decode_tile_4bpp(tileAt(gfx, frame * 4 + t), pixels, frame * 16 + (t % 2) * 8, Math.floor(t / 2) * 8, W, false, false);
    }
  }
  return indexed_rgba(pixels, pal, W * H);
}

// Lua: bag_chrome_extract.lua:348
function gba_to_file(ptr: unknown): number | undefined {
  const p = tonumber(ptr) ?? 0;
  if (p < 0x08000000 || p >= 0x0a000000) return undefined;
  return p - 0x08000000;
}

export interface BagChromeOpts {
  cacheRoot?: string; width?: number; height?: number;
  progress?: (stage: string, done: number, total: number) => void;
}

export const BagChromeExtract = {
  CACHE_SUB: "items/bag",
  FORMAT_VERSION: 4,
  ITEM_PC_SUB: "items/item_pc",

  // Lua: bag_chrome_extract.lua:354
  run(rom: Rom, cache: Cache, opts: BagChromeOpts = {}): { root: string; width: number; height: number; iconsBaked: number; iconsFailed: number } {
    const cacheRoot = opts.cacheRoot ?? default_cache_root();
    const root = cacheRoot + "/" + BagChromeExtract.CACHE_SUB;
    const W = opts.width ?? 240;
    const H = opts.height ?? 160;
    const progress = opts.progress;

    const get = (i: number): number => rom.get(i);
    // Lua: pcall(Lz77.decompressString, rom, off), falling back to Lz77.decompress
    // (which fails the same way); both give the same bytes.
    const lz = (off: number): Uint8Array => Lz77.decompress(get, off)[0];
    const readBytes = (off: number, len: number): Uint8Array => rom.readBytes(off, len);
    const u32 = (off: number): number => rom.u32(off);

    const gfx = lz(Versions.BAG_BG_GFX);
    const pal = lz(Versions.BAG_BG_PAL);
    const map = lz(Versions.BAG_BG_TILEMAP);
    const femalePal = lz(Versions.BAG_BG_PAL_FEMALE);
    const maleBanks = load_pal_banks(pal);
    const femaleBanks = female_banks(pal, femalePal);
    cache.write(root + "/bg.rgba", bake_bg_rgba(gfx, maleBanks, map, W, H));
    cache.write(root + "/bg_female.rgba", bake_bg_rgba(gfx, femaleBanks, map, W, H));

    const LW: number = Versions.BAG_LIST_TILES_W, LH: number = Versions.BAG_LIST_TILES_H;
    const listMap = readBytes(Versions.BAG_LIST_TILEMAP, LW * LH * 2);
    const list_entry = (tx: number, ty: number): number => {
      const i = (ty * LW + tx) * 2;
      return (listMap[i] ?? 0) + (listMap[i + 1] ?? 0) * 256;
    };
    const blank_entry = (): number => Versions.BAG_LIST_BLANK_TILE;
    cache.write(root + "/list.rgba", bake_tiles_rgba(gfx, maleBanks, LW * 8, LH * 8, list_entry));
    cache.write(root + "/list_female.rgba", bake_tiles_rgba(gfx, femaleBanks, LW * 8, LH * 8, list_entry));
    cache.write(root + "/list_blank.rgba", bake_tiles_rgba(gfx, maleBanks, LW * 8, LH * 8, blank_entry));
    cache.write(root + "/list_blank_female.rgba", bake_tiles_rgba(gfx, femaleBanks, LW * 8, LH * 8, blank_entry));
    // src/item_menu.c:1118
    cache.write(root + "/desc_sel.rgba", bake_tiles_rgba(gfx, maleBanks, W, 48,
      (tx, ty) => (map_entry(map, tx, ty + 14) % 4096) + 2 * 4096));

    // src/item_menu.c:569
    const pcMap = lz(Versions.BAG_BG_ITEM_PC_TILEMAP);
    cache.write(root + "/bg_itempc.rgba", bake_bg_rgba(gfx, maleBanks, pcMap, W, H));
    cache.write(root + "/bg_itempc_female.rgba", bake_bg_rgba(gfx, femaleBanks, pcMap, W, H));

    // src/item_pc.c:435 ItemPc_LoadGraphics, :748 ItemPc_SetMessageWindowPalette
    const pcRoot = cacheRoot + "/" + BagChromeExtract.ITEM_PC_SUB;
    const ipcGfx = lz(Versions.ITEM_PC_TILES);
    const ipcBanks = load_pal_banks(lz(Versions.ITEM_PC_BG_PALS), 3);
    const ipcMap = lz(Versions.ITEM_PC_TILEMAP);
    // (pairs order only orders the two writes)
    for (const [name, msgPal] of [["bg", 1], ["bg_submenu", 2]] as [string, number][]) {
      cache.write(pcRoot + "/" + name + ".rgba", bake_tiles_rgba(ipcGfx, ipcBanks, W, H, (tx, ty) => {
        let e = map_entry(ipcMap, tx, ty);
        if (ty >= 14) e = (e % 4096) + msgPal * 4096;
        return e;
      }));
    }

    cache.write(root + "/swap_line.rgba", bake_swap_line(lz(Versions.BAG_SWAP_GFX), lz(Versions.BAG_SWAP_PAL)));

    const arrowGfx = lz(Versions.RED_ARROW_OTHER_GFX);
    const arrowPal = readBytes(Versions.RED_ARROW_PAL, 32);
    cache.write(root + "/red_arrow.rgba", bake_red_arrow(arrowGfx, arrowPal));

    const maleGfx = lz(Versions.BAG_MALE_GFX);
    const femaleGfx = lz(Versions.BAG_FEMALE_GFX);
    const sprPal = lz(Versions.BAG_SPRITE_PAL);
    const [maleRgba, bw, bh, frames] = bake_bag_sprite(maleGfx, sprPal);
    const [femaleRgba] = bake_bag_sprite(femaleGfx, sprPal);
    cache.write(root + "/bag_male.rgba", maleRgba);
    cache.write(root + "/bag_female.rgba", femaleRgba);

    const itemCount: number = Versions.ITEMS_COUNT ?? 375;
    const tableOff: number = Versions.ITEM_ICON_TABLE;
    const iconDir = root + "/icons";
    let baked = 0, failed = 0;
    const uniqGfx: Record<string, string> = {};

    for (let id = 0; id <= itemCount; id++) {
      if (progress && id % 50 === 0) progress("icons", id, itemCount + 1);
      const entryOff = tableOff + id * 8;
      const gfxPtr = u32(entryOff);
      const palPtr = u32(entryOff + 4);
      const gfxOff = gba_to_file(gfxPtr);
      const palOff = gba_to_file(palPtr);
      if (gfxOff !== undefined && palOff !== undefined) {
        try {
          const key = format("%08x:%08x", gfxPtr, palPtr);
          let rgba = uniqGfx[key];
          if (rgba === undefined) {
            const igfx = lz(gfxOff);
            const ipal = lz(palOff);
            rgba = bake_icon_rgba(igfx, ipal);
            uniqGfx[key] = rgba;
          }
          cache.write(format("%s/%d.rgba", iconDir, id), rgba);
          baked = baked + 1;
        } catch (err) {
          failed = failed + 1;
          if (failed <= 3) console.log("[bag_chrome] icon " + tostring(id) + " fail: " + String((err as Error)?.message ?? err));
        }
      } else {
        failed = failed + 1;
      }
    }
    if (progress) progress("icons", itemCount + 1, itemCount + 1);

    const manifest = format(`return {
  format_version = %d,
  width = %d,
  height = %d,
  bagW = %d,
  bagH = %d,
  bagFrames = %d,
  listW = %d,
  listH = %d,
  iconW = 24,
  iconH = 24,
  itemCount = %d,
  iconsBaked = %d,
  iconsFailed = %d,
}
`, BagChromeExtract.FORMAT_VERSION, W, H, bw, bh, frames ?? 4,
      LW * 8, LH * 8, itemCount, baked, failed);
    cache.write(root + "/manifest.lua", manifest);

    console.log(`[bag_chrome] bg + bag sprites + ${baked} icons (${failed} fail) → ${root}`);
    return { root, width: W, height: H, iconsBaked: baked, iconsFailed: failed };
  },

  // Lua: bag_chrome_extract.lua:515
  ready(cache: Cache | undefined, cacheRoot?: string): boolean {
    const root = (cacheRoot ?? default_cache_root()) + "/" + BagChromeExtract.CACHE_SUB;
    const need = root + "/bg.rgba";
    if (cache && cache.exists && cache.exists(need)) return cache.exists(root + "/icons/4.rgba");
    return false;
  },
};

export default BagChromeExtract;
