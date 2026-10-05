// Port of gen1recomp src/import/gba/mystery_gift_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// src/mystery_gift_show_card.c:150, src/mystery_gift_show_news.c:99
// LZ77 output and ROM byte runs are 0-based Uint8Arrays here (the Lua's
// 1-based tables); RGBA results are byte strings, as the Lua's.

import { Versions } from "./versions.ts";
import { Lz77 } from "./lz77.ts";
import { BgBake } from "./bg_bake.ts";
import { OnlineUiExtract } from "./online_ui_extract.ts";
import { format } from "./lua.ts";
import type { Cache } from "./cache.ts";
import type { Rom } from "./rom.ts";

const W = 240, H = 160;
const MAP_W = 30;
const ENTRY_STRIDE = 16;

// Lua: mystery_gift_extract.lua:16 (extract_island1's CACHE_ROOT; callers pass cacheRoot)
function default_cache_root(): string {
  return "data/generated/gba";
}

// Lua: mystery_gift_extract.lua:24
function rom_bytes(rom: Rom, off: number, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = rom.get(off + i);
  return out;
}

interface GraphicsEntry {
  titleTextPal: number; bodyTextPal: number; footerTextPal: number; stampShadowPal: number;
  tiles?: number; map?: number; pal?: number;
}

// Lua: mystery_gift_extract.lua:32 -- include/mystery_gift.h:40
function graphics_entry(rom: Rom, base: number, index: number): GraphicsEntry {
  const off = base + index * ENTRY_STRIDE;
  const b0 = rom.get(off);
  const b1 = rom.get(off + 1);
  return {
    titleTextPal: b0 % 16,
    bodyTextPal: Math.floor(b0 / 16),
    footerTextPal: b1 % 16,
    stampShadowPal: Math.floor(b1 / 16),
    tiles: rom.ptrOffset(rom.u32(off + 4)),
    map: rom.ptrOffset(rom.u32(off + 8)),
    pal: rom.ptrOffset(rom.u32(off + 12)),
  };
}

// Lua: mystery_gift_extract.lua:48 -- src/mystery_gift_show_card.c:219
function bake_entry(rom: Rom, entry: GraphicsEntry): string {
  const get = (i: number): number => rom.get(i);
  const [gfx] = Lz77.decompress(get, entry.tiles!);
  const [map] = Lz77.decompress(get, entry.map!);
  const banks = BgBake.loadPalBanks(rom_bytes(rom, entry.pal!, 32), 1);
  return BgBake.bakeRegionRgba(gfx, banks, map, W, H, { mapW: MAP_W });
}

export const MysteryGiftExtract = {
  CACHE_SUB: "mystery_gift",
  MANIFEST_VERSION: 1,

  // Lua: mystery_gift_extract.lua:56
  run(rom: Rom, cache: Cache, opts: { cacheRoot?: string } = {}): { root: string; count: number } {
    const cacheRoot = opts.cacheRoot ?? default_cache_root();
    const root = cacheRoot + "/" + MysteryGiftExtract.CACHE_SUB;
    const count: number = Versions.WONDER_BG_COUNT;

    const groups = [
      { prefix: "card_bg", base: Versions.WONDER_CARD_GRAPHICS as number },
      { prefix: "news_bg", base: Versions.WONDER_NEWS_GRAPHICS as number },
    ];
    const rows: string[] = [];
    for (const group of groups) {
      for (let i = 0; i < count; i++) {
        const entry = graphics_entry(rom, group.base, i);
        if (!(entry.tiles !== undefined && entry.map !== undefined && entry.pal !== undefined)) {
          throw new Error(format("mystery_gift: %s%d has a bad pointer", group.prefix, i));
        }
        cache.write(format("%s/%s%d.rgba", root, group.prefix, i), bake_entry(rom, entry));
        rows.push(format(
          "  { key = \"%s%d\", titleTextPal = %d, bodyTextPal = %d, footerTextPal = %d, stampShadowPal = %d },",
          group.prefix, i, entry.titleTextPal, entry.bodyTextPal,
          entry.footerTextPal, entry.stampShadowPal));
      }
    }

    const stampRows = OnlineUiExtract.giftArt(rom, (path, data) => { cache.write(path, data); }, root);

    cache.write(root + "/manifest.lua", format(`return {
  format_version = %d,
  width = %d,
  height = %d,
  count = %d,
  entries = {
%s
  },
%s
}
`, MysteryGiftExtract.MANIFEST_VERSION, W, H, count, rows.join("\n"),
    OnlineUiExtract.manifestRows(stampRows)));

    console.log(format("[mystery_gift_extract] %d wonder card and %d wonder news backgrounds %dx%d -> %s",
      count, count, W, H, root));
    return { root, count };
  },

  // Lua: mystery_gift_extract.lua:103
  ready(cache: Cache | undefined, cacheRoot?: string): boolean {
    const root = (cacheRoot ?? default_cache_root()) + "/" + MysteryGiftExtract.CACHE_SUB;
    if (!(cache && cache.exists)) return false;
    if (!cache.exists(root + "/manifest.lua")) return false;
    const n: number = Versions.WONDER_BG_COUNT ?? 8;
    for (let i = 0; i < n; i++) {
      if (!cache.exists(format("%s/card_bg%d.rgba", root, i))) return false;
      if (!cache.exists(format("%s/news_bg%d.rgba", root, i))) return false;
    }
    return true;
  },
};

export default MysteryGiftExtract;
