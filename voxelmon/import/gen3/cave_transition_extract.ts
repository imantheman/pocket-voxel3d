// Port of gen1recomp src/import/gba/cave_transition_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// src/fldeff_flash.c:157-162, :361-414
// Lua differences: decompressed byte tables are 0-based Uint8Arrays;
// palettes keep the Lua's 0-based integer keys (objects).

import { Versions } from "./versions.ts";
import { Lz77 } from "./lz77.ts";
import { serialize_lua } from "./extract_scripts.ts";
import type { Cache } from "./cache.ts";
import type { Rom } from "./rom.ts";

const SCREEN_W = 240, SCREEN_H = 160;
const MAP_W = 32;

// Lua: cave_transition_extract.lua:15
function palette(rom: Rom, off: number): Record<number, number> {
  const out: Record<number, number> = {};
  for (let c = 0; c <= 15; c++) out[c] = rom.u16(off + c * 2);
  return out;
}

export const CaveTransitionExtract = {
  CACHE_SUB: "cave_transition",
  FILES: ["screen.bin", "palettes.lua"],
  REQUIRED: ["cave_transition/screen.bin", "cave_transition/palettes.lua"],

  // Lua: cave_transition_extract.lua:21
  run(rom: Rom, cache: Cache, opts?: { cacheRoot?: string }): { ok: boolean; root: string } {
    const A = Versions.CAVE_TRANSITION;
    const get = (i: number): number => rom.get(i);
    const [tiles] = Lz77.decompress(get, A.tiles);
    if (!tiles) throw new Error("sCaveTransitionTiles did not decompress");
    const [map] = Lz77.decompress(get, A.tilemap);
    if (!map) throw new Error("sCaveTransitionTilemap did not decompress");
    if (!(map.length >= MAP_W * 20 * 2)) throw new Error("sCaveTransitionTilemap is too short");
    const tileCount = Math.floor(tiles.length / 32);
    const screen: string[] = [];
    for (let y = 0; y <= SCREEN_H - 1; y++) {
      for (let x = 0; x <= SCREEN_W - 1; x++) {
        const ty = Math.floor(y / 8), tx = Math.floor(x / 8);
        const mi = (ty * MAP_W + tx) * 2; // the Lua's mi - 1
        const entry = map[mi]! + map[mi + 1]! * 256;
        const tile = entry % 1024;
        const hflip = Math.floor(entry / 1024) % 2 === 1;
        const vflip = Math.floor(entry / 2048) % 2 === 1;
        const bank = Math.floor(entry / 4096) % 16;
        if (!(tile < tileCount)) throw new Error("sCaveTransitionTilemap names a missing tile");
        let px = x % 8, py = y % 8;
        if (hflip) px = 7 - px;
        if (vflip) py = 7 - py;
        const byte = tiles[tile * 32 + py * 4 + Math.floor(px / 2)]!;
        const index = (px % 2 === 0) ? (byte % 16) : Math.floor(byte / 16);
        screen.push(String.fromCharCode(bank * 16 + index));
      }
    }
    const root = ((opts && opts.cacheRoot) || "data/generated/gba") + "/" + CaveTransitionExtract.CACHE_SUB;
    if (!cache.write(root + "/screen.bin", screen.join(""))) throw new Error("could not write cave_transition/screen.bin");
    if (!cache.write(root + "/palettes.lua", "return " + serialize_lua({
      width: SCREEN_W,
      height: SCREEN_H,
      white: palette(rom, A.white_pal),
      black: palette(rom, A.black_pal),
      tiles: palette(rom, A.pal),
    }) + "\n")) throw new Error("could not write cave_transition/palettes.lua");
    return { ok: true, root };
  },
};

export default CaveTransitionExtract;
