// Port of gen1recomp src/import/gba/storage_chrome_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// Pokemon Storage System chrome extractor: PC UI sheets and the 16 box
// wallpapers, decoded straight out of the FRLG ROM into CacheFS.
// Byte tables, tilemap entry lists and RGBA pixel arrays are 0-based here
// (the Lua's 1-based); palettes keyed from 0 as the Lua keys them. Lua's
// lfs directory creation (ensure_dir) has no counterpart: directories are
// implicit in the cache.

import { Versions } from "./versions.ts";
import { Lz77 } from "./lz77.ts";
import { BattleAnimExtract } from "./battle_anim_extract.ts";
import { CacheFs, type Cache } from "./cache.ts";
import { format, fromBytes, tonumber } from "./lua.ts";
import type { Rom } from "./rom.ts";

type Bytes = ArrayLike<number>;
type Rgba4 = [number, number, number, number];
type Pal = Record<number, Rgba4>;
interface SheetSpec { off: number; size?: number; lz?: boolean }
interface MapSpec { off: number; w: number; h: number; lz?: boolean }

const WALLPAPER_NAMES = [
  "forest", "city", "desert", "savanna",
  "crag", "volcano", "snow", "cave",
  "beach", "seafloor", "river", "sky",
  "stars", "pokecenter", "tiles", "simple",
];

// Lua: storage_chrome_extract.lua:43 (extract_island1's CACHE_ROOT; callers pass cacheRoot)
function default_cache_root(): string {
  return "data/generated/gba";
}

// Lua: storage_chrome_extract.lua:51
function get_byte(rom: Rom, off: number): number {
  return rom.get(off);
}

// Lua: storage_chrome_extract.lua:57
function get_u16(rom: Rom, off: number): number {
  return get_byte(rom, off) + get_byte(rom, off + 1) * 256;
}

// Lua: storage_chrome_extract.lua:61
function get_u32(rom: Rom, off: number): number {
  return get_byte(rom, off) + get_byte(rom, off + 1) * 256 + get_byte(rom, off + 2) * 65536 + get_byte(rom, off + 3) * 16777216;
}

// Lua: storage_chrome_extract.lua:68
function ptr_to_offset(addr: number | undefined): number | undefined {
  if (addr === undefined || addr < 0x08000000 || addr >= 0x0a000000) return undefined;
  return addr - 0x08000000;
}

// Lua: storage_chrome_extract.lua:73 -- lfs.mkdir of each path part: nothing
// to do here (cache directories are implicit).
function ensure_dir(_dir: string): void {}

// Lua: storage_chrome_extract.lua:84
// NOT FAITHFUL: without a cache, only CacheFs is tried (no love.filesystem / io.open).
function write_file(cache: Cache | undefined, path: string, data: string): boolean {
  if (cache && cache.write) {
    cache.write(path, data);
    return true;
  }
  try {
    CacheFs.write(path, data);
    return true;
  } catch { /* no bound cache */ }
  return false;
}

// Lua: storage_chrome_extract.lua:109
function read_palette(rom: Rom, off: number, count: number): Pal {
  const pal: Pal = {};
  for (let i = 0; i <= count - 1; i++) {
    const c = get_u16(rom, off + i * 2) % 32768;
    const r = Math.floor(((c % 32) * 255) / 31 + 0.5);
    const g = Math.floor(((Math.floor(c / 32) % 32) * 255) / 31 + 0.5);
    const b = Math.floor(((Math.floor(c / 1024) % 32) * 255) / 31 + 0.5);
    pal[i] = [r, g, b, 255];
  }
  return pal;
}

// Lua: storage_chrome_extract.lua:121 -- [bytes, len] or []
function read_sheet(rom: Rom, spec: SheetSpec | undefined): [Bytes?, number?] {
  if (!spec) return [];
  if (spec.lz) {
    try {
      const [bytes] = Lz77.decompress((i: number) => get_byte(rom, i), spec.off);
      return [bytes, bytes.length];
    } catch {
      return [];
    }
  }
  const bytes: number[] = [];
  for (let i = 1; i <= spec.size!; i++) bytes[i - 1] = get_byte(rom, spec.off + i - 1);
  return [bytes, spec.size];
}

// Lua: storage_chrome_extract.lua:133 -- u16 entries, 0-based
function read_tilemap(rom: Rom, spec: MapSpec | undefined): number[] | undefined {
  if (!spec) return undefined;
  const entries: number[] = [];
  if (spec.lz) {
    let bytes: Uint8Array;
    try {
      bytes = Lz77.decompress((i: number) => get_byte(rom, i), spec.off)[0];
    } catch {
      return undefined;
    }
    const n = Math.floor(bytes.length / 2);
    for (let i = 1; i <= n; i++) entries[i - 1] = (bytes[i * 2 - 2] ?? 0) + (bytes[i * 2 - 1] ?? 0) * 256;
  } else {
    for (let i = 1; i <= spec.w * spec.h; i++) entries[i - 1] = get_u16(rom, spec.off + (i - 1) * 2);
  }
  return entries;
}

// Lua: storage_chrome_extract.lua:151 -- px is a 0-based RGBA byte array
function blit_tile(px: Uint8Array, imgW: number, tiles: Bytes, tileIndex: number, pal: Pal | undefined, dx: number, dy: number, hflip: boolean, vflip: boolean): void {
  const base = tileIndex * 32;
  for (let row = 0; row <= 7; row++) {
    const srcRow = vflip ? 7 - row : row;
    for (let col = 0; col <= 7; col++) {
      const srcCol = hflip ? 7 - col : col;
      const byte = tiles[base + srcRow * 4 + Math.floor(srcCol / 2)] ?? 0;
      const idx = srcCol % 2 === 0 ? byte % 16 : Math.floor(byte / 16);
      const o = ((dy + row) * imgW + (dx + col)) * 4;
      if (idx === 0) {
        px[o] = 0; px[o + 1] = 0; px[o + 2] = 0; px[o + 3] = 0;
      } else {
        // (the Lua indexes pal[idx] directly; a nil pal there would raise)
        const c = pal![idx] ?? [0, 0, 0, 255];
        px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255;
      }
    }
  }
}

// Lua: storage_chrome_extract.lua:205 -- src/pokemon_storage_system_tasks.c:2484
function fill_party_slots(drawer: number[], slotTiles: number[]): number[] {
  const out = drawer.slice();
  for (let pos = 1; pos <= 5; pos++) {
    const index = 3 * (3 * (pos - 1) + 1) * 4 + 7; // Lua 1-based offset base
    let src = 0;
    for (let i = 0; i <= 2; i++) {
      for (let j = 0; j <= 3; j++) {
        // Lua: out[index + i*12 + j + 1] = slotTiles[src + j + 1] or out[...]
        const o = index + i * 12 + j;
        out[o] = slotTiles[src + j] ?? out[o]!;
      }
      src = src + 4;
    }
  }
  return out;
}

// Lua: storage_chrome_extract.lua:453
function raw_bytes(bytes: Bytes | undefined, len: number | undefined): string {
  const out = new Uint8Array(len ?? 0);
  for (let i = 0; i < (len ?? 0); i++) out[i] = bytes ? bytes[i] ?? 0 : 0;
  return fromBytes(out);
}

// Lua: storage_chrome_extract.lua:459
function palette_list(rom: Rom, off: number, count: number): string {
  const out: string[] = [];
  for (let i = 0; i <= count - 1; i++) out.push(format("0x%04X", get_u16(rom, off + i * 2)));
  return "{ " + out.join(", ") + " }";
}

export interface StorageChromeOpts { cacheRoot?: string; force?: boolean; cache?: Cache }
export interface StorageChromeResult { ok: boolean; root: string; count?: number; skipped?: boolean; err?: string }

export const StorageChromeExtract = {
  CACHE_SUB: "pokemon/storage",
  FORMAT_VERSION: 3,
  WALLPAPER_NAMES,

  // Lua: storage_chrome_extract.lua:20
  wallpaperNames(): string[] {
    return Versions.STORAGE_WALLPAPER_NAMES ?? StorageChromeExtract.WALLPAPER_NAMES;
  },

  FRIENDS_SUB: "wallpapers/friends",

  TEXTURE_FILES: [
    { key: "cursor", file: "cursor.png" },
    { key: "cursor_shadow", file: "cursor_shadow.png" },
    { key: "arrow", file: "box_scroll_arrow.png" },
    { key: "menu", file: "menu.png" },
    { key: "menu_pal0", file: "menu_pal0.png" },
    { key: "scrolling_bg", file: "scrolling_bg.png" },
    { key: "waveform", file: "waveform.png" },
    { key: "frame", file: "interface_frame.png" },
    { key: "button_party", file: "button_party.png" },
    { key: "button_close", file: "button_close.png" },
    { key: "party_drawer_bg", file: "party_drawer_bg.png" },
    { key: "party_drawer_full", file: "party_drawer_full.png" },
    { key: "party_slot_filled", file: "party_slot_filled.png" },
    { key: "party_slot_empty", file: "party_slot_empty.png" },
  ],

  REQUIRED: ["pokemon/storage/manifest.lua"],

  // Lua: storage_chrome_extract.lua:170 -- [png, w, h] or []
  bakeSheet(tiles: Bytes | undefined, byteLen: number | undefined, pal: Pal | undefined, cols: number): [string?, number?, number?] {
    const tileCount = Math.floor((byteLen as number) / 32);
    if (!(tileCount >= 1)) return [];
    const rows = Math.ceil(tileCount / cols);
    const w = cols * 8, h = rows * 8;
    const px = new Uint8Array(w * h * 4);
    for (let t = 0; t <= tileCount - 1; t++) blit_tile(px, w, tiles!, t, pal, (t % cols) * 8, Math.floor(t / cols) * 8, false, false);
    return [BattleAnimExtract.encodePng(px, w, h), w, h];
  },

  // Lua: storage_chrome_extract.lua:183 -- [png, w, h] or []; pals is a sequence (0-based here)
  bakeTilemap(entries: number[] | undefined, w: number, h: number, tiles: Bytes | undefined, pals: (Pal | undefined)[], palBase?: number, tileBase?: number): [string?, number?, number?] {
    if (!(entries && tiles)) return [];
    const imgW = w * 8, imgH = h * 8;
    const px = new Uint8Array(imgW * imgH * 4);
    // Lua `#pals`: the border of { a, b, c, d } (nil entries end it)
    let bankCount = 0;
    while (pals[bankCount] !== undefined) bankCount++;
    for (let i = 0; i <= w * h - 1; i++) {
      const e = entries[i] ?? 0;
      const tile = (e % 1024) - (tileBase ?? 0);
      const hflip = Math.floor(e / 1024) % 2 === 1;
      const vflip = Math.floor(e / 2048) % 2 === 1;
      let bank = Math.floor(e / 4096) - (palBase ?? 0);
      if (bank < 0) bank = 0;
      if (bank >= bankCount) bank = bankCount - 1;
      if (tile >= 0) blit_tile(px, imgW, tiles, tile, pals[bank], (i % w) * 8, Math.floor(i / w) * 8, hflip, vflip);
    }
    return [BattleAnimExtract.encodePng(px, imgW, imgH), imgW, imgH];
  },

  // Lua: storage_chrome_extract.lua:221
  // NOT FAITHFUL: without a cache, only CacheFs is consulted (no love.filesystem / io.open).
  ready(cache: Cache | undefined, root?: string): boolean {
    root = root ?? default_cache_root();
    const outDir = root + "/" + StorageChromeExtract.CACHE_SUB;
    const readAny = (rel: string): string | undefined => {
      if (cache && cache.read) return cache.read(rel);
      try { return CacheFs.readActive(rel); } catch { return undefined; }
    };
    const valid_file = (rel: string, minSize = 1): boolean => {
      const data = readAny(rel);
      return (data !== undefined && data.length >= minSize) || false;
    };

    let manifestData: string | undefined;
    if (cache && cache.read) manifestData = cache.read(outDir + "/manifest.lua");
    if (manifestData === undefined) {
      try { manifestData = CacheFs.readActive(outDir + "/manifest.lua"); } catch { /* no bound cache */ }
    }
    if (manifestData === undefined) return false;
    const m = /version\s*=\s*(\d+)/.exec(manifestData);
    const v = m ? tonumber(m[1]) : undefined;
    if (v !== StorageChromeExtract.FORMAT_VERSION) return false;

    for (const tex of StorageChromeExtract.TEXTURE_FILES) {
      if (!valid_file(outDir + "/" + tex.file, 30)) return false;
    }
    for (const wp of StorageChromeExtract.wallpaperNames()) {
      if (!valid_file(outDir + "/wallpapers/" + wp + ".png", 50)) return false;
    }
    if (Versions.STORAGE_FRIENDS && !valid_file(outDir + "/" + StorageChromeExtract.FRIENDS_SUB + "/manifest.lua", 10)) return false;
    return true;
  },

  // Lua: storage_chrome_extract.lua:282
  run(rom: Rom | undefined, cache: Cache | undefined, opts: StorageChromeOpts = {}): StorageChromeResult {
    opts.cache = cache ?? opts.cache;
    return StorageChromeExtract.extract(rom, opts);
  },

  // Lua: storage_chrome_extract.lua:288
  extract(rom: Rom | undefined, opts: StorageChromeOpts = {}): StorageChromeResult {
    const cache = opts.cache;
    const cacheRoot = opts.cacheRoot ?? default_cache_root();
    const outDir = cacheRoot + "/" + StorageChromeExtract.CACHE_SUB;

    if (!opts.force && StorageChromeExtract.ready(cache, cacheRoot)) return { ok: true, root: outDir, skipped: true };
    if (!rom) return { ok: false, root: outDir, count: 0, err: "storage chrome needs a ROM" };

    ensure_dir(outDir);
    ensure_dir(outDir + "/wallpapers");

    const palOff: Record<string, number> = Versions.STORAGE_PALETTES ?? {};
    const sheetOff: Record<string, SheetSpec> = Versions.STORAGE_SHEETS ?? {};
    const mapOff: Record<string, MapSpec> = Versions.STORAGE_TILEMAPS ?? {};

    const pal: Record<string, Pal> = {};
    for (const name of Object.keys(palOff)) pal[name] = read_palette(rom, palOff[name]!, 16);

    const sheet: Record<string, Bytes | undefined> = {}, sheetLen: Record<string, number | undefined> = {};
    for (const name of Object.keys(sheetOff)) {
      const [bytes, len] = read_sheet(rom, sheetOff[name]);
      sheet[name] = bytes;
      sheetLen[name] = len;
    }

    let written = 0;
    const manifestTextures: Record<string, string> = {};
    const emit = (key: string, file: string, png: string | undefined): void => {
      if (!png) return;
      if (write_file(cache, outDir + "/" + file, png)) {
        manifestTextures[key] = file;
        written = written + 1;
      }
    };

    emit("cursor", "cursor.png", StorageChromeExtract.bakeSheet(sheet.handCursor, sheetLen.handCursor, pal.misc2, 4)[0]);
    emit("cursor_shadow", "cursor_shadow.png", StorageChromeExtract.bakeSheet(sheet.handCursorShadow, sheetLen.handCursorShadow, pal.misc2, 2)[0]);
    emit("arrow", "box_scroll_arrow.png", StorageChromeExtract.bakeSheet(sheet.boxScrollArrow, sheetLen.boxScrollArrow, pal.misc2, 1)[0]);
    emit("waveform", "waveform.png", StorageChromeExtract.bakeSheet(sheet.waveform, sheetLen.waveform, pal.misc2, 2)[0]);
    emit("scrolling_bg", "scrolling_bg.png", StorageChromeExtract.bakeSheet(sheet.scrollingBg, sheetLen.scrollingBg, pal.scrollingBg, 4)[0]);
    emit("menu", "menu.png", StorageChromeExtract.bakeSheet(sheet.menu, sheetLen.menu, pal.interface, 16)[0]);
    emit("menu_pal0", "menu_pal0.png", StorageChromeExtract.bakeSheet(sheet.menu, sheetLen.menu, pal.menu, 16)[0]);

    // src/pokemon_storage_system_tasks.c:2126
    const menuTiles = sheet.menu;
    const bgPals = [pal.interface, pal.partyMenu, pal.interfaceNoMon, pal.scrollingBg];
    const bgBase: number = Versions.STORAGE_BG1_BASE_TILE ?? 0x100;
    const bakeBg1 = (spec: MapSpec, entries?: number[]): string | undefined =>
      StorageChromeExtract.bakeTilemap(entries ?? read_tilemap(rom, spec), spec.w, spec.h, menuTiles, bgPals, 0, bgBase)[0];
    if (mapOff.menu) emit("frame", "interface_frame.png", bakeBg1(mapOff.menu));
    if (mapOff.partyMenu) {
      const s = mapOff.partyMenu;
      const drawer = read_tilemap(rom, s);
      if (drawer) {
        // Party tab button is the bottom 2 rows (rows 20..21, 12x2 tiles) of party_menu
        const buttonPartyEntries: number[] = [];
        for (let r = 0; r <= 1; r++) {
          for (let c = 0; c <= 11; c++) buttonPartyEntries[r * 12 + c] = drawer[(20 + r) * 12 + c] ?? 0;
        }
        emit("button_party", "button_party.png",
          StorageChromeExtract.bakeTilemap(buttonPartyEntries, 12, 2, menuTiles, bgPals, 0, bgBase)[0]);

        emit("party_drawer_bg", "party_drawer_bg.png", bakeBg1(s, drawer));
        const filled = mapOff.partySlotFilled ? read_tilemap(rom, mapOff.partySlotFilled) : undefined;
        if (filled) emit("party_drawer_full", "party_drawer_full.png", bakeBg1(s, fill_party_slots(drawer, filled)));
      }
    }
    if (mapOff.closeBoxButton) {
      const closeEntries = read_tilemap(rom, mapOff.closeBoxButton);
      if (closeEntries) {
        // Normal CLOSE BOX button is the top 2 rows (9x2 tiles)
        const normalClose: number[] = [];
        for (let i = 0; i < 18; i++) normalClose[i] = closeEntries[i] ?? 0;
        emit("button_close", "button_close.png",
          StorageChromeExtract.bakeTilemap(normalClose, 9, 2, menuTiles, bgPals, 0, bgBase)[0]);
      }
    }
    if (mapOff.partySlotFilled) emit("party_slot_filled", "party_slot_filled.png", bakeBg1(mapOff.partySlotFilled));
    if (mapOff.partySlotEmpty) emit("party_slot_empty", "party_slot_empty.png", bakeBg1(mapOff.partySlotEmpty));

    const manifestWallpapers: Record<string, string> = {};
    const wpBase: number | undefined = Versions.STORAGE_WALLPAPERS;
    const wpW: number = Versions.STORAGE_WALLPAPER_W ?? 20;
    const wpH: number = Versions.STORAGE_WALLPAPER_H ?? 18;
    if (wpBase) {
      StorageChromeExtract.wallpaperNames().forEach((name, i) => {
        const entry = wpBase + i * 12;
        const tilesOff = ptr_to_offset(get_u32(rom, entry));
        const mapPtr = ptr_to_offset(get_u32(rom, entry + 4));
        const palPtr = ptr_to_offset(get_u32(rom, entry + 8));
        if (tilesOff !== undefined && mapPtr !== undefined && palPtr !== undefined) {
          const [tiles] = read_sheet(rom, { off: tilesOff, lz: true });
          const entries = read_tilemap(rom, { off: mapPtr, lz: true, w: wpW, h: wpH });
          const pals = [read_palette(rom, palPtr, 16), read_palette(rom, palPtr + 32, 16)];
          // src/pokemon_storage_system_graphics.c:1226
          const [png] = StorageChromeExtract.bakeTilemap(entries, wpW, wpH, tiles, pals, 1);
          const rel = "wallpapers/" + name + ".png";
          if (png && write_file(cache, outDir + "/" + rel, png)) {
            manifestWallpapers[name] = rel;
            written = written + 1;
          }
        }
      });
    }

    const lines = [
      "-- Auto-generated FRLG storage chrome manifest from ROM. DO NOT EDIT DIRECTLY.",
      "return {",
      format("  version = %d,", StorageChromeExtract.FORMAT_VERSION),
      "  textures = {",
    ];
    for (const tex of StorageChromeExtract.TEXTURE_FILES) {
      if (manifestTextures[tex.key]) lines.push(format('    %s = "%s",', tex.key, manifestTextures[tex.key]));
    }
    lines.push("  },");
    lines.push("  wallpapers = {");
    for (const name of StorageChromeExtract.wallpaperNames()) {
      if (manifestWallpapers[name]) lines.push(format('    %s = "%s",', name, manifestWallpapers[name]));
    }
    lines.push("  },");
    if (Versions.STORAGE_WALLPAPER_NAMES) {
      lines.push("  wallpaperOrder = {");
      for (const name of Versions.STORAGE_WALLPAPER_NAMES as string[]) lines.push(format('    "%s",', name));
      lines.push("  },");
    }
    if (Versions.STORAGE_FRIENDS) {
      written = written + StorageChromeExtract.extractFriends(rom, cache, outDir);
      lines.push(format('  friends = "%s/manifest.lua",', StorageChromeExtract.FRIENDS_SUB));
    }
    lines.push("}");
    lines.push("");

    write_file(cache, outDir + "/manifest.lua", lines.join("\n"));
    console.log("[game3/storage_chrome_extract] storage chrome ready (" + outDir + ", " + String(written) + " assets)");
    return { ok: written > 0, root: outDir, count: written };
  },

  // Lua: storage_chrome_extract.lua:466 -- pokeemerald/src/pokemon_storage_system.c:5390
  extractFriends(rom: Rom, cache: Cache | undefined, outDir: string): number {
    const F = Versions.STORAGE_FRIENDS;
    const dir = outDir + "/" + StorageChromeExtract.FRIENDS_SUB;
    ensure_dir(dir);
    let written = 0;
    const lines = ["return {", "  patterns = {"];
    for (let i = 0; i <= F.patternCount - 1; i++) {
      const entry = F.patterns + i * 12;
      const tilesOff = ptr_to_offset(get_u32(rom, entry));
      const mapOff = ptr_to_offset(get_u32(rom, entry + 4));
      const palOff = ptr_to_offset(get_u32(rom, entry + 8));
      const [tiles, tlen] = read_sheet(rom, { off: tilesOff!, lz: true });
      const [map, mlen] = read_sheet(rom, { off: mapOff!, lz: true });
      const tfile = format("pattern_%02d.4bpp", i), mfile = format("pattern_%02d.map", i);
      write_file(cache, dir + "/" + tfile, raw_bytes(tiles, tlen));
      write_file(cache, dir + "/" + mfile, raw_bytes(map, mlen));
      written = written + 2;
      lines.push(format('    [%d] = { tiles = "%s", map = "%s", palette = %s },', i, tfile, mfile, palette_list(rom, palOff!, 32)));
    }
    lines.push("  },");
    lines.push("  icons = {");
    for (let i = 0; i <= F.iconCount - 1; i++) {
      const off = ptr_to_offset(get_u32(rom, F.icons + i * 4));
      const [tiles, tlen] = read_sheet(rom, { off: off!, lz: true });
      const file = format("icon_%02d.4bpp", i);
      write_file(cache, dir + "/" + file, raw_bytes(tiles, tlen));
      written = written + 1;
      lines.push(format('    [%d] = "%s",', i, file));
    }
    lines.push("  },");
    lines.push(format("  width = %d,", Versions.STORAGE_WALLPAPER_W));
    lines.push(format("  height = %d,", Versions.STORAGE_WALLPAPER_H));
    lines.push("  iconTileOffset = 0x800,");
    lines.push("}");
    lines.push("");
    write_file(cache, dir + "/manifest.lua", lines.join("\n"));
    return written + 1;
  },
};

export default StorageChromeExtract;
