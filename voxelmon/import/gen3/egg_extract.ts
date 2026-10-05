// Port of gen1recomp src/import/gba/egg_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// src/daycare.c:137 sEggPalette, :138 sEggHatchTiles, :139 sEggShardTiles
// Byte tables are 0-based Uint8Arrays here (the Lua's 1-based with _len).

import { Versions } from "./versions.ts";
import { Lz77 } from "./lz77.ts";
import { BgBake, type PalBank } from "./bg_bake.ts";
import { PokemonExtract } from "./pokemon_extract.ts";
import { Constants } from "../../game/gen3/core/constants.ts";
import { Plans } from "./plans.ts";
import { format, tostring } from "./lua.ts";
import type { Cache } from "./cache.ts";
import type { Rom } from "./rom.ts";

// Lua: egg_extract.lua:26
function need(key: string): any {
  const v = Versions[key];
  if (v === undefined || v === null) {
    throw new Error("egg_extract: Versions." + key + " is not set for " + tostring(Versions.active()));
  }
  return v;
}

// Lua: egg_extract.lua:34
function pic_table(key: string, introKey: string): number {
  const v = Versions[key] ?? (Versions.INTRO ? Versions.INTRO[introKey] : undefined);
  if (v === undefined || v === null) {
    throw new Error("egg_extract: Versions." + key + " is not set for " + tostring(Versions.active()));
  }
  return v;
}

// src/daycare.c:141 sOamData_EggHatch is SPRITE_SIZE(32x32), :158 four frames 16 tiles apart
const HATCH_W = 32, HATCH_H = 32, HATCH_FRAMES = 4;
// src/daycare.c:221 sOamData_EggShard is SPRITE_SIZE(8x8), :243 four frames one tile apart
const SHARD_W = 8, SHARD_H = 8, SHARD_FRAMES = 4;
const PIC_W = 64, PIC_H = 64;

// Lua: egg_extract.lua:48 (extract_island1's CACHE_ROOT; callers pass cacheRoot)
function default_cache_root(): string {
  return "data/generated/gba";
}

// Lua: egg_extract.lua:56
function raw_bytes(rom: Rom, off: number, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = rom.get(off + i);
  return out;
}

// Lua: egg_extract.lua:64 (src/daycare.c:138)
function stack_frames(gfx: Uint8Array, bank: PalBank | undefined, frames: number, tilesPerFrame: number, w: number, h: number, acrossRow?: boolean): string {
  const parts: string[] = [];
  for (let f = 0; f <= frames - 1; f++) parts[f] = BgBake.bakeSpriteRgba(gfx, bank, f * tilesPerFrame, w, h, false, false);
  if (!acrossRow) return parts.join("");
  const rows: string[] = [];
  for (let y = 0; y <= h - 1; y++) {
    for (let f = 1; f <= frames; f++) rows.push(parts[f - 1]!.slice(y * w * 4, (y + 1) * w * 4));
  }
  return rows.join("");
}

export const EggExtract = {
  CACHE_SUB: "pokemon/egg",
  MANIFEST_VERSION: 1,
  REQUIRED: [
    "pokemon/egg/hatch.rgba", "pokemon/egg/shard.rgba", "pokemon/egg/manifest.lua",
    "pokemon/front/412.rgba", "pokemon/icons/412.rgba",
  ],

  // Lua: egg_extract.lua:17 (the metatable's __index)
  get SPECIES_EGG(): number {
    return Constants.of(Versions.active()).require("species", "SPECIES_EGG");
  },

  // Lua: egg_extract.lua:79
  run(rom: Rom, cache: Cache, opts: { cacheRoot?: string } = {}): { root: string; frames: number } {
    const cacheRoot = opts.cacheRoot ?? default_cache_root();
    const root = cacheRoot + "/" + EggExtract.CACHE_SUB;
    const get = (i: number): number => rom.get(i);

    const palBytes = raw_bytes(rom, need("EGG_PALETTE"), 32);
    const bank = BgBake.loadPalBanks(palBytes, 1)[0];

    const hatch = raw_bytes(rom, need("EGG_HATCH_GFX"), (HATCH_W * HATCH_H) / 2 * HATCH_FRAMES);
    cache.write(root + "/hatch.rgba",
      stack_frames(hatch, bank, HATCH_FRAMES, (HATCH_W / 8) * (HATCH_H / 8), HATCH_W, HATCH_H));

    const shard = raw_bytes(rom, need("EGG_SHARD_GFX"), (SHARD_W * SHARD_H) / 2 * SHARD_FRAMES);
    cache.write(root + "/shard.rgba",
      stack_frames(shard, bank, SHARD_FRAMES, 1, SHARD_W, SHARD_H, true));

    const picTable = pic_table("MON_FRONT_PIC_TABLE", "mon_front_pic_table");
    const palTable = pic_table("MON_PALETTE_TABLE", "mon_palette_table");
    const picOff = rom.ptrOffset(rom.u32(picTable + EggExtract.SPECIES_EGG * 8));
    const picPalOff = rom.ptrOffset(rom.u32(palTable + EggExtract.SPECIES_EGG * 8));
    if (!(picOff !== undefined && picPalOff !== undefined)) throw new Error("egg_extract: no SPECIES_EGG pic entry");
    const [tiles] = Lz77.decompress(get, picOff);
    const [picPal] = Lz77.decompress(get, picPalOff);
    if (!(tiles && picPal)) throw new Error("egg_extract: the SPECIES_EGG pic did not decompress");
    const picBank = BgBake.loadPalBanks(picPal, 1)[0];
    cache.write(cacheRoot + "/pokemon/front/" + EggExtract.SPECIES_EGG + ".rgba",
      BgBake.bakeSpriteRgba(tiles, picBank, 0, PIC_W, PIC_H, false, false));

    // src/party_menu.c:2655 draws an egg's icon from MON_DATA_SPECIES_OR_EGG
    cache.write(cacheRoot + "/pokemon/icons/" + EggExtract.SPECIES_EGG + ".rgba",
      PokemonExtract.iconRgba(rom, EggExtract.SPECIES_EGG));

    cache.write(root + "/manifest.lua", format(
      "return {\n"
      + "  format_version = %d,\n"
      + "  species = %d,\n"
      + "  pic = { width = %d, height = %d },\n"
      + "  hatch = { width = %d, height = %d, frames = %d, sheetWidth = %d, sheetHeight = %d },\n"
      + "  shard = { width = %d, height = %d, frames = %d, sheetWidth = %d, sheetHeight = %d },\n"
      + "}\n",
      EggExtract.MANIFEST_VERSION, EggExtract.SPECIES_EGG, PIC_W, PIC_H,
      HATCH_W, HATCH_H, HATCH_FRAMES, HATCH_W, HATCH_H * HATCH_FRAMES,
      SHARD_W, SHARD_H, SHARD_FRAMES, SHARD_W * SHARD_FRAMES, SHARD_H));

    console.log(format(
      "[egg_extract] EGG front pic %dx%d, %d hatch frames, %d shard frames -> %s",
      PIC_W, PIC_H, HATCH_FRAMES, SHARD_FRAMES, root));
    return { root, frames: HATCH_FRAMES };
  },

  // Lua: egg_extract.lua:130
  ready(cache: Cache | undefined, cacheRoot?: string): boolean {
    cacheRoot = cacheRoot ?? default_cache_root();
    if (!(cache && cache.exists)) return false;
    const root = cacheRoot + "/" + EggExtract.CACHE_SUB;
    for (const rel of ["hatch.rgba", "shard.rgba", "manifest.lua"]) {
      if (!cache.exists(root + "/" + rel)) return false;
    }
    for (const sub of ["front", "icons"]) {
      if (!cache.exists(cacheRoot + "/pokemon/" + sub + "/" + EggExtract.SPECIES_EGG + ".rgba")) return false;
    }
    return true;
  },
};

Plans.register("egg_extract", EggExtract as unknown as Record<string, unknown>);

export default EggExtract;
