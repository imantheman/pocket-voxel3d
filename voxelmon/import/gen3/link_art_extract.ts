// Port of gen1recomp src/import/gba/link_art_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// src/link_rfu_3.c:34, src/union_room_chat_objects.c:30
// src/wireless_communication_status_screen.c:50
// Lua differences: byte tables (raw_bytes, LZ77 output) are 0-based
// Uint8Arrays; palette banks are 0-based arrays (the Lua keys them from 0).

import { Versions } from "./versions.ts";
import { Lz77 } from "./lz77.ts";
import { BgBake, type PalBank } from "./bg_bake.ts";
import { Plans } from "./plans.ts";
import { format, char } from "./lua.ts";
import { readLuaLiteral } from "./asset_pack.ts";
import type { Cache } from "./cache.ts";
import type { Rom } from "./rom.ts";

const SCREEN_W = 240, SCREEN_H = 160;
// src/link_rfu_3.c:434
const ICON_SIZE = 16, ICON_FRAMES = 7;
// src/union_room_chat_objects.c:68
const SELECTOR_W = 64, SELECTOR_H = 32, SELECTOR_FRAMES = 4;
// src/union_room_chat_objects.c:140
const ICONS_W = 32, ICONS_H = 16, ICONS_FRAMES = 4;
// src/union_room_chat_objects.c:110
const CURSOR_W = 8, CURSOR_H = 16;
// src/union_room_chat_objects.c:172
const RBUTTON_SIZE = 16;
// src/wireless_communication_status_screen.c:50
const STATUS_PAL_BANKS = 16;

// Lua: link_art_extract.lua:28 (extract_island1's CACHE_ROOT; callers pass cacheRoot)
function default_cache_root(): string {
  return "data/generated/gba";
}

// Lua: link_art_extract.lua:36
function raw_bytes(rom: Rom, off: number, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = rom.get(off + i);
  return out;
}

// Lua: link_art_extract.lua:42
function pal_banks(rom: Rom, off: number, count: number): PalBank[] {
  return BgBake.loadPalBanks(raw_bytes(rom, off, count * 32), count);
}

// Lua: link_art_extract.lua:46
function frames_rgba(gfx: Uint8Array, bank: PalBank | undefined, tileStep: number, fw: number, fh: number, frames: number): string {
  const parts: string[] = [];
  for (let f = 0; f <= frames - 1; f++) {
    parts.push(BgBake.bakeSpriteRgba(gfx, bank, f * tileStep, fw, fh, false, false));
  }
  return parts.join("");
}

export const LinkArtExtract = {
  UNION_SUB: "union_room",
  STATUS_SUB: "wireless_status",
  FORMAT_VERSION: 2,

  // Lua: link_art_extract.lua:54
  run(rom: Rom, cache: Cache, opts: { cacheRoot?: string } = {}): { union: string; status: string } {
    const cacheRoot = opts.cacheRoot ?? default_cache_root();
    const union = cacheRoot + "/" + LinkArtExtract.UNION_SUB;
    const status = cacheRoot + "/" + LinkArtExtract.STATUS_SUB;
    const get = (i: number): number => rom.get(i);
    const lz = (off: number): Uint8Array => Lz77.decompress(get, off)[0];

    const iconGfx = lz(Versions.WIRELESS_ICON_GFX);
    const iconBank = pal_banks(rom, Versions.WIRELESS_ICON_PAL, 1)[0];
    cache.write(union + "/wireless_icon.rgba",
      frames_rgba(iconGfx, iconBank, 4, ICON_SIZE, ICON_SIZE, ICON_FRAMES));

    const bgGfx = lz(Versions.UR_CHAT_BG_GFX);
    const bgMap = lz(Versions.UR_CHAT_BG_TILEMAP);
    const bgBank = pal_banks(rom, Versions.UR_CHAT_BG_PAL, 1);
    cache.write(union + "/chat_bg.rgba",
      BgBake.bakeRegionRgba(bgGfx, bgBank, bgMap, SCREEN_W, SCREEN_H, {}));

    const panelGfx = lz(Versions.UR_CHAT_PANEL_GFX);
    const panelMap = lz(Versions.UR_CHAT_PANEL_TILEMAP);
    const panelBank = pal_banks(rom, Versions.UR_CHAT_PANEL_PAL, 1);
    cache.write(union + "/chat_panel.rgba", BgBake.bakeRegionRgba(panelGfx, panelBank,
      panelMap, SCREEN_W, SCREEN_H, { bankOffset: 7, alpha0: true }));

    const objBank = pal_banks(rom, Versions.UR_CHAT_OBJECTS_PAL, 1)[0];
    cache.write(union + "/chat_icons.rgba",
      frames_rgba(lz(Versions.UR_CHAT_ICONS_GFX), objBank, 8,
        ICONS_W, ICONS_H, ICONS_FRAMES));
    cache.write(union + "/chat_selector_cursor.rgba",
      frames_rgba(lz(Versions.UR_CHAT_SELECTOR_GFX), objBank, 32,
        SELECTOR_W, SELECTOR_H, SELECTOR_FRAMES));
    cache.write(union + "/chat_text_entry_cursor.rgba",
      frames_rgba(lz(Versions.UR_CHAT_TEXT_CURSOR_GFX), objBank, 2,
        CURSOR_W, CURSOR_H, 1));
    cache.write(union + "/chat_char_select_cursor.rgba",
      frames_rgba(lz(Versions.UR_CHAT_CHAR_CURSOR_GFX), objBank, 2,
        CURSOR_W, CURSOR_H, 1));
    cache.write(union + "/chat_r_button.rgba",
      frames_rgba(lz(Versions.UR_CHAT_R_BUTTON_GFX), objBank, 4,
        RBUTTON_SIZE, RBUTTON_SIZE, 1));

    cache.write(union + "/manifest.lua", format(
      "return {\n"
      + "  format_version = %d,\n"
      + "  wireless_icon = { width = %d, height = %d, frames = %d, frame_h = %d },\n"
      + "  chat_bg = { width = %d, height = %d },\n"
      + "  chat_panel = { width = %d, height = %d },\n"
      + "  chat_icons = { width = %d, height = %d, frames = %d, frame_h = %d },\n"
      + "  chat_selector_cursor = { width = %d, height = %d, frames = %d, frame_h = %d },\n"
      + "  chat_text_entry_cursor = { width = %d, height = %d },\n"
      + "  chat_char_select_cursor = { width = %d, height = %d },\n"
      + "  chat_r_button = { width = %d, height = %d },\n"
      + "}\n",
      LinkArtExtract.FORMAT_VERSION,
      ICON_SIZE, ICON_SIZE * ICON_FRAMES, ICON_FRAMES, ICON_SIZE,
      SCREEN_W, SCREEN_H,
      SCREEN_W, SCREEN_H,
      ICONS_W, ICONS_H * ICONS_FRAMES, ICONS_FRAMES, ICONS_H,
      SELECTOR_W, SELECTOR_H * SELECTOR_FRAMES, SELECTOR_FRAMES, SELECTOR_H,
      CURSOR_W, CURSOR_H,
      CURSOR_W, CURSOR_H,
      RBUTTON_SIZE, RBUTTON_SIZE));

    const statusGfx = lz(Versions.WIRELESS_STATUS_GFX);
    const statusMap = lz(Versions.WIRELESS_STATUS_TILEMAP);
    const statusBanks = pal_banks(rom, Versions.WIRELESS_STATUS_PALS, STATUS_PAL_BANKS);
    // src/wireless_communication_status_screen.c:226
    cache.write(status + "/bg.rgba", BgBake.bakeRegionRgba(statusGfx,
      [statusBanks[0]!], statusMap, SCREEN_W, SCREEN_H, {}));
    // src/wireless_communication_status_screen.c:251
    cache.write(status + "/bg_index.bin",
      BgBake.bakeRegionIndices(statusGfx, statusMap, SCREEN_W, SCREEN_H, {}));

    const palParts: string[] = [];
    for (let b = 0; b <= STATUS_PAL_BANKS - 1; b++) {
      const bank = statusBanks[b] ?? [];
      for (let c = 0; c <= 15; c++) {
        const [r, g, bl] = BgBake.bgr555ToRgb8(bank[c] ?? 0);
        palParts.push(char(r, g, bl));
      }
    }
    cache.write(status + "/palettes.pal", palParts.join(""));

    const L = Versions.WIRELESS_STATUS_LAYOUT;
    cache.write(status + "/manifest.lua", format(
      "return {\n"
      + "  format_version = %d,\n"
      + "  bg = { width = %d, height = %d, index = \"bg_index.bin\" },\n"
      + "  palettes = { banks = %d, colors = 16, bytes_per_color = 3, anim_first = 2, anim_count = 14 },\n"
      + "  layout = { title_y = %d, label_x = %d, label_y = %d, row_step = %d, count_x = %d, total_y = %d },\n"
      + "}\n", LinkArtExtract.FORMAT_VERSION, SCREEN_W, SCREEN_H, STATUS_PAL_BANKS,
      L.title_y, L.label_x, L.label_y, L.row_step, L.count_x, L.total_y));

    console.log(format(
      "[link_art_extract] %d wireless icon frames, chat screen %dx%d, status screen %dx%d -> %s",
      ICON_FRAMES, SCREEN_W, SCREEN_H, SCREEN_W, SCREEN_H, cacheRoot));
    return { union, status };
  },

  /**
   * Lua: link_art_extract.lua:155
   * The Lua load()s union_room/manifest.lua in an empty environment;
   * readLuaLiteral stands in (it throws where load/pcall would fail).
   */
  ready(cache: Cache | undefined, cacheRoot?: string): boolean {
    const root = cacheRoot ?? default_cache_root();
    if (!(cache && typeof cache.exists === "function" && typeof cache.read === "function")) return false;
    const union = root + "/" + LinkArtExtract.UNION_SUB;
    const status = root + "/" + LinkArtExtract.STATUS_SUB;
    const body = cache.exists(union + "/manifest.lua") ? cache.read(union + "/manifest.lua") : undefined;
    if (typeof body !== "string") return false;
    let man: any;
    try { man = readLuaLiteral(body); } catch { return false; }
    if (!man || typeof man !== "object") return false;
    if (man.format_version !== LinkArtExtract.FORMAT_VERSION) return false;
    const icon = cache.read(union + "/wireless_icon.rgba");
    if (typeof icon !== "string" || icon.length !== ICON_SIZE * ICON_SIZE * 4 * ICON_FRAMES) {
      return false;
    }
    const bg = cache.read(status + "/bg.rgba");
    if (typeof bg !== "string" || bg.length !== SCREEN_W * SCREEN_H * 4) return false;
    const idx = cache.exists(status + "/bg_index.bin") ? cache.read(status + "/bg_index.bin") : undefined;
    return typeof idx === "string" && idx.length === SCREEN_W * SCREEN_H;
  },
};

Plans.register("link_art_extract", LinkArtExtract as unknown as Record<string, unknown>);

export default LinkArtExtract;
