// Port of gen1recomp src/import/gba/party_chrome_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// Bake FRLG party-menu chrome from ROM into extract/v1/pokemon/party/.
// BG tilemap + slot panels (slot_*.bin) + pokeball frames.
// Byte tables and pixel index tables are 0-based here (the Lua's 1-based);
// palette banks keyed from 0; slot/button tilemaps stay byte strings.

import { Versions } from "./versions.ts";
import { Lz77 } from "./lz77.ts";
import { CacheFs, type Cache } from "./cache.ts";
import { format, fromBytes, tonumber } from "./lua.ts";
import type { Rom } from "./rom.ts";

type Bytes = ArrayLike<number>;
type Pal = Record<number, number>;

// Lua: party_chrome_extract.lua:11 (extract_island1's CACHE_ROOT; callers pass cacheRoot)
function default_cache_root(): string {
  return "data/generated/gba";
}

// Lua: party_chrome_extract.lua:19
function bgr555_to_rgb8(c: unknown): [number, number, number] {
  const n = (tonumber(c) ?? 0) % 32768;
  const r5 = n % 32, g5 = Math.floor(n / 32) % 32, b5 = Math.floor(n / 1024) % 32;
  return [Math.floor((r5 * 255) / 31 + 0.5), Math.floor((g5 * 255) / 31 + 0.5), Math.floor((b5 * 255) / 31 + 0.5)];
}

// Lua: party_chrome_extract.lua:29
function byte_len(buf: unknown): number {
  if (typeof buf === "string") return buf.length;
  if (buf instanceof Uint8Array || Array.isArray(buf)) return buf.length;
  return 0;
}

// Lua: party_chrome_extract.lua:35
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

// Lua: party_chrome_extract.lua:53
function load_pal_banks(bytes: Bytes, count?: number): Pal[] {
  const banks: Pal[] = [];
  const n = count ?? Math.max(1, Math.floor(byte_len(bytes) / 32));
  for (let b = 0; b <= n - 1; b++) {
    const colors: Pal = {};
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

/** Indices through one palette, colour 0 transparent (the Lua's repeated chunk loop). */
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

// Lua: party_chrome_extract.lua:68 -- [rgba, W, H]
function bake_status_icons_rgba(gfx: Bytes, palBytes: Bytes): [string, number, number] {
  const W = 32, H = 64; // 4 tiles wide x 8 frames
  const banks = load_pal_banks(palBytes, Math.max(1, Math.floor(byte_len(palBytes) / 32)));
  const pal = banks[0] ?? {};
  const tileCount = Math.floor(byte_len(gfx) / 32);
  const pixels = new Array<number>(W * H).fill(0);
  let ti = 0;
  for (let ty = 0; ty <= 7; ty++) {
    for (let tx = 0; tx <= 3; tx++) {
      if (ti < tileCount) decode_tile_4bpp(tileAt(gfx, ti), pixels, tx * 8, ty * 8, W, false, false);
      ti = ti + 1;
    }
  }
  return [indexed_rgba(pixels, pal, W * H), W, H];
}

// Lua: party_chrome_extract.lua:102
function bake_bg_rgba(gfx: Bytes, palBytes: Bytes, map: Bytes, W: number, H: number): string {
  const tileCount = Math.floor(byte_len(gfx) / 32);
  const banks = load_pal_banks(palBytes, Math.floor(byte_len(palBytes) / 32));
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
    const bank = banks[pals[i] ?? 0] ?? banks[0];
    const c = bank ? bank[idx] ?? 0 : 0;
    const [r, g, b] = bgr555_to_rgb8(c);
    out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = 255;
  }
  return fromBytes(out);
}

// Lua: party_chrome_extract.lua:150
function build_party_box_pal(palBytes: Bytes, selected: boolean, multi?: boolean): Pal {
  const banks = load_pal_banks(palBytes, Math.floor(byte_len(palBytes) / 32));
  const base = banks[3] ?? banks[0] ?? {};
  const pal: Pal = {};
  for (let i = 0; i <= 15; i++) pal[i] = base[i] ?? 0;
  const get_pal_color = (id: number): number => {
    const b = Math.floor(id / 16), c = id % 16;
    return (banks[b] && banks[b]![c]) ?? 0;
  };
  // src/party_menu.c:2273
  if (multi && selected) {
    pal[4] = get_pal_color(132); pal[5] = get_pal_color(133); pal[6] = get_pal_color(134);
    pal[1] = get_pal_color(97); pal[7] = get_pal_color(103); pal[8] = get_pal_color(104);
  } else if (multi) {
    pal[4] = get_pal_color(68); pal[5] = get_pal_color(69); pal[6] = get_pal_color(70);
    pal[1] = get_pal_color(65); pal[7] = get_pal_color(71); pal[8] = get_pal_color(72);
  } else if (selected) {
    // LOAD_PARTY_BOX_PAL(sPartyBoxCurrSelectionPalIds1, sPartyBoxPalOffsets1)
    // sPartyBoxCurrSelectionPalIds1 = {116, 117, 118}, sPartyBoxPalOffsets1 = {4, 5, 6}
    pal[4] = get_pal_color(116); pal[5] = get_pal_color(117); pal[6] = get_pal_color(118);
    // LOAD_PARTY_BOX_PAL(sPartyBoxCurrSelectionPalIds2, sPartyBoxPalOffsets2)
    // sPartyBoxCurrSelectionPalIds2 = {97, 103, 104}, sPartyBoxPalOffsets2 = {1, 7, 8}
    pal[1] = get_pal_color(97); pal[7] = get_pal_color(103); pal[8] = get_pal_color(104);
  } else {
    // sPartyBoxEmptySlotPalIds1 = {52, 53, 54}, sPartyBoxPalOffsets1 = {4, 5, 6}
    pal[4] = get_pal_color(52); pal[5] = get_pal_color(53); pal[6] = get_pal_color(54);
    // sPartyBoxEmptySlotPalIds2 = {49, 55, 56}, sPartyBoxPalOffsets2 = {1, 7, 8}
    pal[1] = get_pal_color(49); pal[7] = get_pal_color(55); pal[8] = get_pal_color(56);
  }
  return pal;
}

// Lua: party_chrome_extract.lua:201 -- Blit slot tilemap (u8 tile ids, a byte
// string) using party BG gfx + custom pal or pal bank. Color 0 -> transparent.
function bake_slot_rgba(gfx: Bytes, palBytes: Bytes, tilemap: string, tilesW: number, tilesH: number, customPalOrBank: Pal | number): [string, number, number] {
  const W = tilesW * 8, H = tilesH * 8;
  let pal: Pal;
  if (typeof customPalOrBank === "object") pal = customPalOrBank;
  else {
    const banks = load_pal_banks(palBytes, Math.floor(byte_len(palBytes) / 32));
    pal = banks[customPalOrBank] ?? banks[0] ?? {};
  }
  const tileCount = Math.floor(byte_len(gfx) / 32);
  const pixels = new Array<number>(W * H).fill(0);
  for (let ty = 0; ty <= tilesH - 1; ty++) {
    for (let tx = 0; tx <= tilesW - 1; tx++) {
      const k = ty * tilesW + tx;
      let tileId = k < tilemap.length ? tilemap.charCodeAt(k) : 0;
      if (tileId >= tileCount) tileId = 0;
      decode_tile_4bpp(tileAt(gfx, tileId), pixels, tx * 8, ty * 8, W, false, false);
    }
  }
  return [indexed_rgba(pixels, pal, W * H), W, H];
}

// Lua: party_chrome_extract.lua:240 -- Blit button tilemap (16-bit tile entries,
// a byte string) using party BG gfx + pal bank. Color 0 -> transparent.
function bake_button_rgba(gfx: Bytes, palBytes: Bytes, tilemap16Bytes: string, tilesW: number, tilesH: number, palBank?: number): [string, number, number] {
  const W = tilesW * 8, H = tilesH * 8;
  const banks = load_pal_banks(palBytes, Math.floor(byte_len(palBytes) / 32));
  const pal = (palBank !== undefined && banks[palBank]) || banks[1] || {};
  const tileCount = Math.floor(byte_len(gfx) / 32);
  const pixels = new Array<number>(W * H).fill(0);
  const at = (k: number): number => (k < tilemap16Bytes.length ? tilemap16Bytes.charCodeAt(k) : 0);
  for (let ty = 0; ty <= tilesH - 1; ty++) {
    for (let tx = 0; tx <= tilesW - 1; tx++) {
      const idx = (ty * tilesW + tx) * 2;
      const entry = at(idx) + at(idx + 1) * 256;
      let tileId = entry % 1024;
      const hflip = Math.floor(entry / 1024) % 2 === 1;
      const vflip = Math.floor(entry / 2048) % 2 === 1;
      if (tileId >= tileCount) tileId = 0;
      decode_tile_4bpp(tileAt(gfx, tileId), pixels, tx * 8, ty * 8, W, hflip, vflip);
    }
  }
  return [indexed_rgba(pixels, pal, W * H), W, H];
}

// Lua: party_chrome_extract.lua:277 -- Two 32x32 frames (closed / open) stacked vertically.
function bake_ball_sheet(gfx: Bytes, palBytes: Bytes): [string, number, number, number] {
  const fw = 32, fh = 32;
  const banks = load_pal_banks(palBytes, Math.max(1, Math.floor(byte_len(palBytes) / 32)));
  const pal = banks[0] ?? {};
  const tileCount = Math.floor(byte_len(gfx) / 32);
  const sheetH = fh * 2;
  const pixels = new Array<number>(fw * sheetH).fill(0);
  for (let frame = 0; frame <= 1; frame++) {
    let ti = frame * 16; // 16 tiles per 32x32
    for (let ty = 0; ty <= 3; ty++) {
      for (let tx = 0; tx <= 3; tx++) {
        if (ti < tileCount) decode_tile_4bpp(tileAt(gfx, ti), pixels, tx * 8, frame * fh + ty * 8, fw, false, false);
        ti = ti + 1;
      }
    }
  }
  return [indexed_rgba(pixels, pal, fw * sheetH), fw, sheetH, 2];
}

// Lua: party_chrome_extract.lua:314 -- [rgba, W, H, frames]
function bake_hold_icons(gfx: Bytes, palBytes: Bytes): [string, number, number, number] {
  const W = 8, frames = Math.floor(byte_len(gfx) / 32);
  const H = 8 * frames;
  const pal = load_pal_banks(palBytes, 1)[0] ?? {};
  const pixels = new Array<number>(W * H).fill(0);
  for (let f = 0; f <= frames - 1; f++) decode_tile_4bpp(tileAt(gfx, f), pixels, 0, f * 8, W, false, false);
  return [indexed_rgba(pixels, pal, W * H), W, H, frames];
}

export interface PartyChromeOpts { cacheRoot?: string; width?: number; height?: number; keys?: Record<string, any>; game?: string }

export const PartyChromeExtract = {
  CACHE_SUB: "pokemon/party",
  bakeHoldIcons: bake_hold_icons,
  REQUIRED: [
    "pokemon/party/manifest.lua", "pokemon/party/bg.rgba", "pokemon/party/slot_main.rgba",
    "pokemon/party/slot_wide.rgba", "pokemon/party/slot_wide_empty.rgba", "pokemon/party/cancel_button.rgba",
    "pokemon/party/confirm_button.rgba", "pokemon/party/status_balls.rgba", "pokemon/party/hold_icons.rgba",
    "pokemon/party/status_icons.rgba",
  ],

  // Lua: party_chrome_extract.lua:348 -- NOT PORTED: Emerald symbol keys
  // (src.import.gba.syms); Emerald is outside the FireRed port.
  keysFor(_game: string): never {
    throw new Error("party_chrome_extract: keysFor (Emerald syms) is not ported");
  },

  // Lua: party_chrome_extract.lua:369
  run(rom: Rom, cache: Cache, opts: PartyChromeOpts = {}): Record<string, unknown> {
    const K: Record<string, any> = opts.keys ?? (opts.game ? PartyChromeExtract.keysFor(opts.game) : Versions);
    const root = (opts.cacheRoot ?? default_cache_root()) + "/" + PartyChromeExtract.CACHE_SUB;
    const W = opts.width ?? 240;
    const H = opts.height ?? 160;

    const get = (i: number): number => rom.get(i);
    const [gfx] = Lz77.decompress(get, K.PARTY_MENU_BG_GFX);
    const [pal] = Lz77.decompress(get, K.PARTY_MENU_BG_PAL);
    const [map] = Lz77.decompress(get, K.PARTY_MENU_BG_TILEMAP);
    cache.write(root + "/bg.rgba", bake_bg_rgba(gfx, pal, map, W, H));

    const palUnsel = build_party_box_pal(pal, false);
    const palSel = build_party_box_pal(pal, true);
    const palMulti = build_party_box_pal(pal, false, true);
    const palMultiSel = build_party_box_pal(pal, true, true);

    const raw = (off: number, len: number): string => {
      let s = "";
      for (let i = 1; i <= len; i++) s += String.fromCharCode(get(off + i - 1));
      return s;
    };
    const mainBin = raw(K.PARTY_MENU_SLOT_MAIN_TILEMAP, 70);
    const wideBin = raw(K.PARTY_MENU_SLOT_WIDE_TILEMAP, 54);
    const emptyBin = raw(K.PARTY_MENU_SLOT_WIDE_EMPTY_TILEMAP, 54);
    {
      cache.write(root + "/slot_main.rgba", bake_slot_rgba(gfx, pal, mainBin, 10, 7, palUnsel)[0]);
      cache.write(root + "/slot_main_selected.rgba", bake_slot_rgba(gfx, pal, mainBin, 10, 7, palSel)[0]);
      cache.write(root + "/slot_main_multi.rgba", bake_slot_rgba(gfx, pal, mainBin, 10, 7, palMulti)[0]);
      cache.write(root + "/slot_main_multi_selected.rgba", bake_slot_rgba(gfx, pal, mainBin, 10, 7, palMultiSel)[0]);
    }
    {
      cache.write(root + "/slot_wide.rgba", bake_slot_rgba(gfx, pal, wideBin, 18, 3, palUnsel)[0]);
      cache.write(root + "/slot_wide_selected.rgba", bake_slot_rgba(gfx, pal, wideBin, 18, 3, palSel)[0]);
      cache.write(root + "/slot_wide_multi.rgba", bake_slot_rgba(gfx, pal, wideBin, 18, 3, palMulti)[0]);
      cache.write(root + "/slot_wide_multi_selected.rgba", bake_slot_rgba(gfx, pal, wideBin, 18, 3, palMultiSel)[0]);
    }
    cache.write(root + "/slot_wide_empty.rgba", bake_slot_rgba(gfx, pal, emptyBin, 18, 3, palUnsel)[0]);

    const cancelBin = raw(K.PARTY_MENU_CANCEL_BUTTON_TILEMAP, 28);
    cache.write(root + "/cancel_button.rgba", bake_button_rgba(gfx, pal, cancelBin, 7, 2, 1)[0]);
    cache.write(root + "/cancel_button_selected.rgba", bake_button_rgba(gfx, pal, cancelBin, 7, 2, 2)[0]);

    const confirmBin = raw(K.PARTY_MENU_CONFIRM_BUTTON_TILEMAP, 28);
    cache.write(root + "/confirm_button.rgba", bake_button_rgba(gfx, pal, confirmBin, 7, 2, 1)[0]);
    cache.write(root + "/confirm_button_selected.rgba", bake_button_rgba(gfx, pal, confirmBin, 7, 2, 2)[0]);

    const [ballGfx] = Lz77.decompress(get, K.PARTY_MENU_BALL_GFX);
    const [ballPal] = Lz77.decompress(get, K.PARTY_MENU_BALL_PAL);
    const [ballRgba, bw, bh, frames] = bake_ball_sheet(ballGfx, ballPal);
    cache.write(root + "/status_balls.rgba", ballRgba);

    // src/data/party_menu.h:664
    const holdGfx: number[] = [], holdPal: number[] = [];
    for (let i = 1; i <= 64; i++) holdGfx[i - 1] = get(K.PARTY_MENU_HOLD_ICONS_GFX + i - 1);
    for (let i = 1; i <= 32; i++) holdPal[i - 1] = get(K.PARTY_MENU_HOLD_ICONS_PAL + i - 1);
    const [holdRgba, holdW, holdH, holdFrames] = bake_hold_icons(holdGfx, holdPal);
    cache.write(root + "/hold_icons.rgba", holdRgba);

    if (K.SUMMARY_STATUS_ICONS_GFX && K.SUMMARY_STATUS_ICONS_PAL) {
      const [statusGfx] = Lz77.decompress(get, K.SUMMARY_STATUS_ICONS_GFX);
      const read_pal_bytes = (off: number, len: number): number[] => {
        const t: number[] = [];
        for (let i = 1; i <= len; i++) t[i - 1] = get(off + i - 1);
        return t;
      };
      const statusPal: Bytes = K.SUMMARY_STATUS_ICONS_PAL_LZ ? Lz77.decompress(get, K.SUMMARY_STATUS_ICONS_PAL)[0]
        : read_pal_bytes(K.SUMMARY_STATUS_ICONS_PAL, 32);
      if (statusGfx && statusPal) {
        const [statusRgba] = bake_status_icons_rgba(statusGfx, statusPal);
        cache.write(root + "/status_icons.rgba", statusRgba);
        const summaryRoot = (opts.cacheRoot ?? default_cache_root()) + "/pokemon/summary";
        cache.write(summaryRoot + "/status_icons.rgba", statusRgba);
      }
    }

    const manifest = format(
      "return {\n  width = %d, height = %d,\n  ballW = %d, ballSheetH = %d, ballFrames = %d,\n  slotMainW = 80, slotMainH = 56,\n  slotWideW = 144, slotWideH = 24,\n  cancelButtonW = 56, cancelButtonH = 16,\n  holdIconW = %d, holdIconSheetH = %d, holdIconFrames = %d,\n  pokemonVersion = %d,\n}\n",
      W, H, bw, bh, frames ?? 2, holdW, holdH, holdFrames, K.POKEMON_VERSION ?? 1);
    cache.write(root + "/manifest.lua", manifest);

    return {
      root, width: W, height: H,
      ballW: bw, ballSheetH: bh, ballFrames: frames,
      holdIconW: holdW, holdIconSheetH: holdH, holdIconFrames: holdFrames,
    };
  },

  // Lua: party_chrome_extract.lua:473
  // NOT FAITHFUL: without a cache, only CacheFs is consulted (no love.filesystem / io.open).
  ready(cache: Cache | undefined, cacheRoot?: string): boolean {
    const root = (cacheRoot ?? default_cache_root()) + "/" + PartyChromeExtract.CACHE_SUB;
    const need = root + "/slot_main.rgba";
    if (cache) {
      if (cache.read) {
        const d = cache.read(need);
        return (d !== undefined && d.length >= 80 * 56 * 4) || false;
      } else if (cache.exists) {
        return cache.exists(need) || false;
      }
      return false;
    }
    try {
      const d = CacheFs.readActive(need);
      if (d !== undefined && d.length >= 80 * 56 * 4) return true;
    } catch { /* no bound cache */ }
    return false;
  },
};

export default PartyChromeExtract;
