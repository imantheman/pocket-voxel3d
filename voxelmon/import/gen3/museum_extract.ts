// Port of gen1recomp src/import/gba/museum_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// src/script_menu.c:1149 OpenMuseumFossilPic, :647 sMuseumAerodactylSprTiles

import { Versions } from "./versions.ts";
import { BgBake } from "./bg_bake.ts";
import { format } from "./lua.ts";
import type { Cache } from "./cache.ts";
import type { Rom } from "./rom.ts";

// Lua: museum_extract.lua:16 (extract_island1's CACHE_ROOT; callers pass cacheRoot)
function default_cache_root(): string {
  return "data/generated/gba";
}

// Lua: museum_extract.lua:24 -- n ROM bytes (0-based here)
function raw_bytes(rom: Rom, off: number, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = rom.get(off + i);
  return out;
}

export const MuseumExtract = {
  CACHE_SUB: "museum",
  MANIFEST_VERSION: 1,

  SPECIES_KABUTOPS: 141,
  SPECIES_AERODACTYL: 142,

  FILES: ["kabutops.rgba", "aerodactyl.rgba", "manifest.lua"],

  // Lua: museum_extract.lua:31
  run(rom: Rom, cache: Cache, opts: { cacheRoot?: string } = {}): { root: string; width: number; height: number } {
    const cacheRoot = opts.cacheRoot ?? default_cache_root();
    const root = cacheRoot + "/" + MuseumExtract.CACHE_SUB;
    const size: number = Versions.MUSEUM_FOSSIL_SIZE ?? 64;
    const tileBytes = size * size / 2;

    const rows = [
      { name: "kabutops", gfx: Versions.MUSEUM_KABUTOPS_GFX as number, pal: Versions.MUSEUM_KABUTOPS_PAL as number },
      { name: "aerodactyl", gfx: Versions.MUSEUM_AERODACTYL_GFX as number, pal: Versions.MUSEUM_AERODACTYL_PAL as number },
    ];
    for (const row of rows) {
      const gfx = raw_bytes(rom, row.gfx, tileBytes);
      const bank = BgBake.loadPalBanks(raw_bytes(rom, row.pal, 32), 1)[0];
      cache.write(root + "/" + row.name + ".rgba", BgBake.bakeSpriteRgba(gfx, bank, 0, size, size, false, false));
    }

    cache.write(root + "/manifest.lua", format(`return {
  format_version = %d,
  width = %d,
  height = %d,
  species = { kabutops = %d, aerodactyl = %d },
}
`, MuseumExtract.MANIFEST_VERSION, size, size,
    MuseumExtract.SPECIES_KABUTOPS, MuseumExtract.SPECIES_AERODACTYL));

    console.log(format("[museum_extract] kabutops and aerodactyl fossil pics %dx%d -> %s", size, size, root));
    return { root, width: size, height: size };
  },

  // Lua: museum_extract.lua:64
  ready(cache: Cache | undefined, cacheRoot?: string): boolean {
    const root = (cacheRoot ?? default_cache_root()) + "/" + MuseumExtract.CACHE_SUB;
    if (!(cache && cache.exists)) return false;
    for (const rel of MuseumExtract.FILES) {
      if (!cache.exists(root + "/" + rel)) return false;
    }
    return true;
  },
};

export default MuseumExtract;
