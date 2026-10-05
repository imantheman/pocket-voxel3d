// Port of gen1recomp src/import/gba/door_anim_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// FRLG door animation sheets (sDoorGraphics, src/field_door.c) -> doors/*.rgba
// + doors/manifest.lua.
// Lua differences: the RGBA byte table is 0-based here (the Lua's 1-based,
// then string.char(unpack(...))).
// NOT FAITHFUL: runRse (reached only when Versions.FAMILY == "rse") throws;
// Emerald is not ported.

import { Versions } from "./versions.ts";
import { Plans } from "./plans.ts";
import { format, fromBytes } from "./lua.ts";
import { readLuaLiteral } from "./asset_pack.ts";
import type { Cache } from "./cache.ts";
import type { Rom } from "./rom.ts";

type Rgba = [number, number, number, number];

interface DoorEntry {
  index: number; mid: number; tile: string; sound: string; sound_type: number;
  size: string; size_type: number; tileset: string;
}

// sDoorGraphics table (see versions.lua for offset documentation).
const SDOOR_GRAPHICS_OFFSET = 0x035B5D8;
const ENTRY_COUNT: number = Versions.DOOR_GRAPHICS_COUNT ?? 32;
const ENTRY_STRIDE = 12; // bytes per entry: u16 mid, u8 sound, u8 size | u32 ptr_tiles | u32 ptr_pal

// Human-readable names in table order (matches sDoorGraphics[] from field_door.c).
const ENTRY_NAMES = [
  "General", "SlidingSingle", "SlidingDouble", "Pallet",
  "OaksLab", "Viridian", "Pewter", "Saffron",
  "SilphCo", "Cerulean", "Lavender", "Vermilion",
  "PokemonFanClub", "DeptStore", "Fuchsia", "SafariZone",
  "CinnabarLab", "Sevii123", "JoyfulGameCorner", "OneIslandPokeCenter",
  "Sevii45", "FourIslandDayCare", "RocketWarehouse", "Sevii67",
  "DeptStoreElevator", "CableClub", "HideoutElevator", "SSAnne",
  "SilphCoElevator", "Teleporter", "TrainerTowerLobbyElevator", "TrainerTowerRoofElevator",
];

// src/field_door.c:10
const SOUND_NAMES: Record<number, string> = { 0: "normal", 1: "sliding" };
// src/field_door.c:15
const SIZE_NAMES: Record<number, string> = { 0: "1x1", 1: "1x2" };

// src/field_door.c:250
const DOOR_TILESETS: Record<number, string> = {
  0: "primary",
  1: "primary",
  2: "primary",
  3: "pallet",
  4: "pallet",
  5: "viridian",
  6: "pewter",
  7: "saffron",
  8: "saffron",
  9: "cerulean",
  10: "lavender",
  11: "vermilion",
  12: "vermilion",
  13: "celadon",
  14: "fuchsia",
  15: "fuchsia",
  16: "cinnabar",
  17: "sevii_123",
  18: "sevii_123",
  19: "sevii_123",
  20: "sevii_45",
  21: "sevii_45",
  22: "sevii_45",
  23: "sevii_67",
  24: "dept_store",
  25: "cable_club",
  26: "silph_co",
  27: "ss_anne",
  28: "silph_co",
  29: "sea_cottage",
  30: "trainer_tower",
  31: "trainer_tower",
};

// Primary tileset (gTileset_General) palette offset in FireRed USA 1.0 ROM.
const PRIMARY_PALETTES_OFFSET = 0x0EA1B68;

// Secondary tileset palette offset for each door index (0..31).
const DOOR_SECONDARY_PALS: Record<number, number> = {
  0: 0xEA1B68, // General (Door)
  1: 0xEA1B68, // General (SlidingSingle)
  2: 0xEA1B68, // General (SlidingDouble)
  3: 0x26D7C0, // PalletTown (Door)
  4: 0x26D7C0, // PalletTown (OaksLabDoor)
  5: 0x26DFC0, // ViridianCity (Door)
  6: 0x26EAB8, // PewterCity (Door)
  7: 0x275094, // SaffronCity (Door)
  8: 0x275094, // SaffronCity (SilphCoDoor)
  9: 0x26F4B8, // CeruleanCity (Door)
  10: 0x270438, // LavenderTown (Door)
  11: 0x270DA0, // VermilionCity (Door)
  12: 0x270DA0, // VermilionCity (SSAnneWarp / FanClub)
  13: 0x271C74, // CeladonCity (DeptStoreDoor)
  14: 0x272A5C, // FuchsiaCity (Door)
  15: 0x272A5C, // FuchsiaCity (SafariZoneDoor)
  16: 0x273358, // CinnabarIsland (LabDoor)
  17: 0x299AA4, // SeviiIslands123 (Door)
  18: 0x299AA4, // SeviiIslands123 (GameCornerDoor)
  19: 0x299AA4, // SeviiIslands123 (PokeCenterDoor)
  20: 0x29AB04, // SeviiIslands45 (Door)
  21: 0x29AB04, // SeviiIslands45 (DayCareDoor)
  22: 0x29AB04, // SeviiIslands45 (RocketWarehouseDoor)
  23: 0x29BD64, // SeviiIslands67 (Door)
  24: 0xEA9D88, // DepartmentStore (ElevatorDoor)
  25: 0x278CC4, // PokemonCenter (CableClubDoor)
  26: 0x290DD0, // SilphCo (HideoutElevatorDoor)
  27: 0x287B80, // SSAnne (Door)
  28: 0x290DD0, // SilphCo (ElevatorDoor)
  29: 0x28F9D8, // SeaCottage (Teleporter)
  30: 0x29CEE4, // TrainerTower (LobbyElevatorDoor)
  31: 0x29CEE4, // TrainerTower (RoofElevatorDoor)
};

// ─────────────────────────── 4bpp → RGBA decode ──────────────────────────────

// Lua: door_anim_extract.lua:110 -- 16-colour BGR555 palette from the tileset palette bank (keys 0..15)
function decode_palette(rom: Rom, pal_slot: number, door_idx: number): Rgba[] {
  let pal_base: number;
  if (pal_slot < 7) {
    pal_base = Versions.address(PRIMARY_PALETTES_OFFSET) + pal_slot * 32;
  } else {
    const sec_base: number = Versions.address(DOOR_SECONDARY_PALS[door_idx] ?? PRIMARY_PALETTES_OFFSET);
    pal_base = sec_base + pal_slot * 32;
  }

  const pal: Rgba[] = [];
  pal[0] = [0, 0, 0, 0]; // color 0 is transparent on GBA
  for (let c = 1; c <= 15; c++) {
    const lo = rom.get(pal_base + c * 2);
    const hi = rom.get(pal_base + c * 2 + 1);
    const bgr = lo + hi * 256;
    const r = (bgr & 0x1F) * 8;
    const g = ((bgr >>> 5) & 0x1F) * 8;
    const b = ((bgr >>> 10) & 0x1F) * 8;
    pal[c] = [r, g, b, 255];
  }
  return pal;
}

// Lua: door_anim_extract.lua:137 -- door tiles -> [rgba, W, H, frame_h]
// GBA doors have 3 animation frames (half-open 1, half-open 2, fully-open).
// 1x1 doors: 4 tiles per frame (TL, TR, BL, BR) -> 16x16 px per frame, total 16x48 px.
// 1x2 doors: 8 tiles per frame (4 top metatile, 4 bottom metatile) -> 16x32 px per frame, total 16x96 px.
// pal_nums is the Lua's 1-based list, 0-based here.
function decode_door_sheet_rgba(rom: Rom, tiles_off: number, pal_nums: number[], is_large: boolean, door_idx: number): [string, number, number, number] {
  const W = 16;
  const frame_h = is_large ? 32 : 16;
  const H = frame_h * 3;
  const tiles_per_frame = is_large ? 8 : 4;

  // Pre-decode palettes for each subtile slot
  const tile_pals: Rgba[][] = [];
  for (let t = 0; t <= tiles_per_frame - 1; t++) {
    const pal_slot = pal_nums[t] ?? 0;
    tile_pals[t] = decode_palette(rom, pal_slot, door_idx);
  }

  const pixels = new Uint8Array(W * H * 4);

  for (let f = 0; f <= 2; f++) {
    for (let t_idx = 0; t_idx <= tiles_per_frame - 1; t_idx++) {
      let tx: number, ty: number;
      if (is_large) {
        const meta_row = Math.floor(t_idx / 4); // 0: top metatile, 1: bottom metatile
        const sub_t = t_idx % 4;
        tx = (sub_t % 2) * 8;
        ty = f * 32 + meta_row * 16 + Math.floor(sub_t / 2) * 8;
      } else {
        tx = (t_idx % 2) * 8;
        ty = f * 16 + Math.floor(t_idx / 2) * 8;
      }

      const pal = tile_pals[t_idx]!;
      const global_t = f * tiles_per_frame + t_idx;
      const t_base = tiles_off + global_t * 32;

      for (let row = 0; row <= 7; row++) {
        for (let col = 0; col <= 3; col++) {
          const b = rom.get(t_base + row * 4 + col);
          const lo = b & 0xF;
          const hi = (b >>> 4) & 0xF;

          const c_lo = pal[lo] ?? [0, 0, 0, 0];
          const base_lo = ((ty + row) * W + (tx + col * 2)) * 4;
          pixels[base_lo] = c_lo[0];
          pixels[base_lo + 1] = c_lo[1];
          pixels[base_lo + 2] = c_lo[2];
          pixels[base_lo + 3] = c_lo[3];

          const c_hi = pal[hi] ?? [0, 0, 0, 0];
          const base_hi = ((ty + row) * W + (tx + col * 2 + 1)) * 4;
          pixels[base_hi] = c_hi[0];
          pixels[base_hi + 1] = c_hi[1];
          pixels[base_hi + 2] = c_hi[2];
          pixels[base_hi + 3] = c_hi[3];
        }
      }
    }
  }

  return [fromBytes(pixels), W, H, frame_h];
}

// string.lower (C locale: ASCII only), for name:lower() at door_anim_extract.lua:480
const lower = (s: string): string => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());

export const DoorAnimExtract = {
  CACHE_SUB: "doors",
  MANIFEST_VERSION: 2,
  RSE_MANIFEST_VERSION: 1,
  REQUIRED: ["doors/manifest.lua"],

  /**
   * Lua: door_anim_extract.lua:307
   * NOT FAITHFUL: Emerald only (the RSE door path needs Versions.SYMS, the
   * RSE layout/door tables and core/game3 constants for pokeemerald).
   */
  runRse(_rom: Rom, _cache: Cache, _root: string): never {
    throw new Error("NOT FAITHFUL: Emerald only");
  },

  // Lua: door_anim_extract.lua:433
  run(rom: Rom | undefined, cache: Cache, opts: { cacheRoot?: string } = {}): boolean {
    const cacheRoot = opts.cacheRoot ?? "data/generated/gba";
    const root = cacheRoot + "/" + DoorAnimExtract.CACHE_SUB;

    if (rom && Versions.FAMILY === "rse") {
      return DoorAnimExtract.runRse(rom, cache, root);
    }

    if (!rom) {
      console.log("[door_extract] no ROM handle; writing stub manifest");
      return DoorAnimExtract._writeStub(cache, root);
    }

    const manifest_doors: Record<string, { file: string; width: number; height: number; frame_width: number; frame_height: number; frames: number }> = {};
    const manifest_by_mid: Record<number, DoorEntry> = {};
    const manifest_entries: DoorEntry[] = [];

    // src/field_door.c:396
    const limit = Math.max(ENTRY_COUNT, 0);
    for (let i = 0; i <= limit - 1; i++) {
      const base = Versions.address(SDOOR_GRAPHICS_OFFSET) + i * ENTRY_STRIDE;
      const mid_flags = rom.u32(base);
      const ptr_tiles = rom.u32(base + 4);
      const ptr_pal = rom.u32(base + 8);
      if (ptr_tiles === 0) break;

      const mid = mid_flags & 0xFFFF;
      const sound_id = (mid_flags >>> 16) & 0xFF;
      const size_id = (mid_flags >>> 24) & 0xFF;
      const is_large = size_id === 1;
      const name = ENTRY_NAMES[i] ?? "door_" + i;

      const tiles_off = rom.ptrOffset(ptr_tiles);
      const pal_off = rom.ptrOffset(ptr_pal);
      if (!(tiles_off !== undefined && pal_off !== undefined)) {
        console.log(format("[door_extract] bad ptr for entry %d (%s); skipping", i, name));
        continue;
      }

      const pal_nums: number[] = [];
      for (let p = 0; p <= 7; p++) {
        pal_nums[p] = rom.get(pal_off + p);
      }

      const [rgba_str, W, H, frame_h] = decode_door_sheet_rgba(rom, tiles_off, pal_nums, is_large, i);

      const fname = lower(name) + ".rgba";
      cache.write(root + "/" + fname, rgba_str);

      manifest_doors[name] = {
        file: fname,
        width: W,
        height: H,
        frame_width: W,
        frame_height: frame_h,
        frames: 3,
      };

      const entry: DoorEntry = {
        index: i,
        mid,
        tile: name,
        sound: SOUND_NAMES[sound_id] ?? "normal",
        sound_type: sound_id,
        size: SIZE_NAMES[size_id] ?? "1x1",
        size_type: size_id,
        tileset: DOOR_TILESETS[i] ?? "primary",
      };
      manifest_by_mid[mid] = entry;
      manifest_entries.push(entry);
    }

    rom.clearCache();

    const names = Object.keys(manifest_doors).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    // Build and write manifest.lua through the cache.
    const mlines = [
      "return {",
      format("  version = %d,", DoorAnimExtract.MANIFEST_VERSION),
      format("  count = %d,", manifest_entries.length),
      "  doors = {",
    ];
    for (const k of names) {
      const v = manifest_doors[k]!;
      mlines.push(format(
        "    [%q] = { file = %q, width = %d, height = %d, frame_width = %d, frame_height = %d, frames = %d },",
        k, v.file, v.width, v.height, v.frame_width, v.frame_height, v.frames));
    }
    mlines.push("  },");
    mlines.push("  entries = {");
    for (const v of manifest_entries) {
      mlines.push(format(
        "    { index = %d, mid = %d, tile = %q, sound = %q, sound_type = %d, size = %q, size_type = %d, tileset = %q },",
        v.index, v.mid, v.tile, v.sound, v.sound_type, v.size, v.size_type, v.tileset));
    }
    mlines.push("  },");
    mlines.push("  by_mid = {");
    for (const v of manifest_entries) {
      mlines.push(format(
        "    [%d] = { index = %d, mid = %d, tile = %q, sound = %q, sound_type = %d, size = %q, size_type = %d, tileset = %q },",
        v.mid, v.index, v.mid, v.tile, v.sound, v.sound_type, v.size, v.size_type, v.tileset));
    }
    mlines.push("  },");
    mlines.push("}");
    mlines.push("");
    cache.write(root + "/manifest.lua", mlines.join("\n"));

    console.log(format("[door_extract] wrote %d door sheets, %d metatile entries",
      names.length, manifest_entries.length));
    return true;
  },

  /**
   * Lua: door_anim_extract.lua:552 (src/field_door.c:250)
   * The Lua load()s manifest.lua in an empty environment; readLuaLiteral
   * stands in. NOT FAITHFUL: the RSE branch throws (Emerald only).
   */
  ready(cache: Cache | undefined, cacheRoot?: string): boolean {
    const root = (cacheRoot ?? "data/generated/gba") + "/" + DoorAnimExtract.CACHE_SUB;
    const body = cache && cache.read ? cache.read(root + "/manifest.lua") : undefined;
    if (typeof body !== "string" || body.length === 0) return false;
    let manifest: any;
    try { manifest = readLuaLiteral(body); } catch { return false; }
    if (!manifest || typeof manifest !== "object") return false;
    if (Versions.FAMILY === "rse") throw new Error("NOT FAITHFUL: Emerald only");
    if (manifest.version !== DoorAnimExtract.MANIFEST_VERSION) return false;
    if (!manifest.by_mid || typeof manifest.by_mid !== "object") return false;
    let n = 0;
    for (const k of Object.keys(manifest.by_mid)) {
      const entry = manifest.by_mid[k];
      if (entry === undefined || entry === null) continue;
      if (typeof entry !== "object" || typeof entry.sound_type !== "number") return false;
      n = n + 1;
    }
    return n >= ENTRY_COUNT;
  },

  // Lua: door_anim_extract.lua:576 -- a stub manifest + pallet.rgba so CacheContract is
  // satisfied even when no ROM handle is available.
  _writeStub(cache: Cache, root: string): boolean {
    const lines = [
      "return {",
      format("  version = %d,", DoorAnimExtract.MANIFEST_VERSION),
      "  count = 0,",
      "  doors = {},",
      "  entries = {},",
      "  by_mid = {},",
      "}",
      "",
    ];
    cache.write(root + "/manifest.lua", lines.join("\n"));
    cache.write(root + "/pallet.rgba", "\x00".repeat(16 * 16 * 4));
    return false;
  },
};

Plans.register("door_anim_extract", DoorAnimExtract as unknown as Record<string, unknown>);

export default DoorAnimExtract;
