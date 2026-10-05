// Port of gen1recomp src/import/gba/move_relearner_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// src/learn_move.c:384 MoveRelearnerLoadBgGfx

import { Versions } from "./versions.ts";
import { Lz77 } from "./lz77.ts";
import { BgBake } from "./bg_bake.ts";
import { format } from "./lua.ts";
import type { Cache } from "./cache.ts";
import type { Rom } from "./rom.ts";

const W = 240, H = 160;

// Lua: move_relearner_extract.lua:15 (extract_island1's CACHE_ROOT; callers pass cacheRoot)
function default_cache_root(): string {
  return "data/generated/gba";
}

export const MoveRelearnerExtract = {
  CACHE_SUB: "move_relearner",
  MANIFEST_VERSION: 1,
  FILES: ["bg.rgba", "manifest.lua"],

  // Lua: move_relearner_extract.lua:23
  run(rom: Rom, cache: Cache, opts: { cacheRoot?: string } = {}): { root: string; width: number; height: number } {
    const cacheRoot = opts.cacheRoot ?? default_cache_root();
    const root = cacheRoot + "/" + MoveRelearnerExtract.CACHE_SUB;
    const get = (i: number): number => rom.get(i);

    const [gfx] = Lz77.decompress(get, Versions.MOVE_RELEARNER_GFX);
    const [map] = Lz77.decompress(get, Versions.MOVE_RELEARNER_TILEMAP);
    const palBytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) palBytes[i] = rom.get(Versions.MOVE_RELEARNER_PAL + i);
    const banks = BgBake.loadPalBanks(palBytes, 1);

    cache.write(root + "/bg.rgba", BgBake.bakeBgRgba(gfx, banks, map, W, H));
    cache.write(root + "/manifest.lua", format(`return {
  format_version = %d,
  width = %d,
  height = %d,
  tiles = %d,
}
`, MoveRelearnerExtract.MANIFEST_VERSION, W, H, Math.floor(BgBake.byteLen(gfx) / 32)));

    console.log(format("[move_relearner_extract] bg %dx%d -> %s", W, H, root));
    return { root, width: W, height: H };
  },

  // Lua: move_relearner_extract.lua:50
  ready(cache: Cache | undefined, cacheRoot?: string): boolean {
    const root = (cacheRoot ?? default_cache_root()) + "/" + MoveRelearnerExtract.CACHE_SUB;
    if (!(cache && cache.exists)) return false;
    for (const rel of MoveRelearnerExtract.FILES) {
      if (!cache.exists(root + "/" + rel)) return false;
    }
    return true;
  },
};

export default MoveRelearnerExtract;
