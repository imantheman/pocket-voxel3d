// Port of gen1recomp src/import/gba/tileset_anim_pack.lua (GPLv3 + additional terms; see LICENSE.md).
// Extract pret General tileset anim frames and per-mid RGBA banks.
// FireRed: TilesetAnim_General — water@416, sand@464, flower@508.
// NOT FAITHFUL: the RSE writer (writeRse and its helpers: lcm, serialize,
// tile_sheet_copy, ptr_table, vram_tile, resolve_bank, frame_ptr,
// affected_mids, idx_bytes, bake_tile_bank) is Emerald-only and not ported;
// writeExtract on a non-frlg family throws instead.

import { format, tostring } from "./lua.ts";
import { Versions } from "./versions.ts";
import { Family } from "./family.ts";
import { Tileset, type BundleLike, type Tiles } from "./tileset.ts";
import { Metatile } from "./metatile.ts";
import { NativePack } from "./native_pack.ts";
import type { Cache } from "./cache.ts";
import type { Rom } from "./rom.ts";
import FrAnims from "./data/tileset_anims_firered.ts";

interface FrameCfg { base: number; bytes: number; count: number; stride: number }

const TILE_BYTES = 32;

const DEFAULT_FRAMES = FrAnims.DEFAULT_FRAMES as Record<string, FrameCfg>;

// Lua: tileset_anim_pack.lua:25
function pairs_using_general(version?: any): string[] {
  const catalog = (version && version.tileset_pairs) || Versions.TILESET_PAIRS;
  const tilesets = (version && version.tilesets) || Versions.TILESETS;
  const out: string[] = [];
  for (const name of Object.keys(catalog ?? {})) {
    const pair = catalog[name];
    const pri = tilesets[pair.primary];
    // general primary is the animating one
    if (pair.primary === "general" || (pri && pri.tiles === Versions.TILESETS.general.tiles)) {
      out.push(name);
    }
  }
  out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return out;
}

// Lua: tileset_anim_pack.lua:40
function mid_uses_range(bundle: BundleLike, mid: number, t0: number, t1: number): boolean {
  const entries = Tileset.metatileEntries(bundle.primaryMt, bundle.secondaryMt, mid);
  if (!entries) return false;
  for (let i = 0; i < 8; i++) {
    const tid = (entries[i] ?? 0) % 1024;
    if (tid >= t0 && tid < t1) return true;
  }
  return false;
}

// Lua: tileset_anim_pack.lua:50
function classify_mid(bundle: BundleLike, mid: number): string | undefined {
  const water = mid_uses_range(bundle, mid, AnimPack.WATER_TILE, AnimPack.WATER_TILE + AnimPack.WATER_COUNT);
  const sand = mid_uses_range(bundle, mid, AnimPack.SAND_TILE, AnimPack.SAND_TILE + AnimPack.SAND_COUNT);
  const flower = mid_uses_range(bundle, mid, AnimPack.FLOWER_TILE, AnimPack.FLOWER_TILE + AnimPack.FLOWER_COUNT);
  if (water) return "water";
  if (sand) return "sand";
  if (flower) return "flower";
  return undefined;
}

// Lua: tileset_anim_pack.lua:61 -- copy primary tiles raw into a mutable
// byte array (0-based here; tid → 32 bytes)
function mutable_primary(bundle: BundleLike): Tiles {
  const tiles = bundle.primaryTiles;
  const raw = tiles.raw;
  const count = tiles.count ?? 0;
  const bytes: number[] = [];
  const nbytes = count * TILE_BYTES;
  if (typeof raw === "string") {
    const n = Math.min(nbytes, raw.length);
    for (let i = 0; i < n; i++) bytes[i] = raw.charCodeAt(i);
  } else {
    for (let i = 0; i < nbytes; i++) bytes[i] = raw[i] ?? 0;
  }
  return {
    count,
    raw: bytes,
    _mutable: true,
  };
}

// Lua: tileset_anim_pack.lua:81
function paste_tiles(dstTiles: Tiles, startTid: number, frameBytes: string): void {
  const base = startTid * TILE_BYTES;
  const raw = dstTiles.raw as number[];
  for (let i = 0; i < frameBytes.length; i++) {
    raw[base + i] = frameBytes.charCodeAt(i);
  }
}

// Lua: tileset_anim_pack.lua:88
function read_frame(rom: Rom, off: number, nbytes: number): string {
  return rom.readString(off, nbytes);
}

// Lua: tileset_anim_pack.lua:109
function bake_mid_rgba(bundle: BundleLike, mid: number, rgbPals: ReturnType<typeof NativePack.palsToRgb8>): string {
  // Animate under-layer atlas (sprites sit above this).
  const idx = Metatile.compositeIndexedUnder(bundle, mid);
  const fake = {
    midCount: 1,
    atlasCols: 1,
    atlasRows: 1,
    midIds: [mid],
    pixels: idx,
  };
  const [rgba] = NativePack.bakeRgba(fake, rgbPals);
  return rgba!;
}

export const AnimPack = {
  // Destination tile ranges (primary tileset ids).
  WATER_TILE: FrAnims.TILES.water.tile,
  WATER_COUNT: FrAnims.TILES.water.count,
  SAND_TILE: FrAnims.TILES.sand.tile,
  SAND_COUNT: FrAnims.TILES.sand.count,
  FLOWER_TILE: FrAnims.TILES.flower.tile,
  FLOWER_COUNT: FrAnims.TILES.flower.count,

  INDEX_FILE: "native/anim_index.lua",

  DEFAULT_FRAMES,
  pairsUsingGeneral: pairs_using_general,
  classifyMid: classify_mid,

  // Lua: tileset_anim_pack.lua:95 -- { [name]: frame blobs (0-based list) }
  loadFramesFromRom(rom: Rom, version?: any): Record<string, string[]> {
    const spec: Record<string, FrameCfg> = (version && version.tileset_anim_general)
      || Versions.TILESET_ANIM_GENERAL || DEFAULT_FRAMES;
    const frames: Record<string, string[]> = {};
    for (const name of Object.keys(spec)) {
      const cfg = spec[name]!;
      const list: string[] = [];
      for (let i = 0; i <= cfg.count - 1; i++) {
        const off = (cfg === DEFAULT_FRAMES[name] ? Versions.address(cfg.base) : cfg.base) + i * cfg.stride;
        list[i] = read_frame(rom, off, cfg.bytes);
      }
      frames[name] = list;
    }
    return frames;
  },

  // Lua: tileset_anim_pack.lua:125 -- write anim frame banks for pairs that
  // use General primary. midLists: [pair] = sorted mid ids used on that pair's maps
  writeExtract(rom: Rom, cache: Cache, root: string | undefined, bundles: Record<string, BundleLike>,
    midLists: Record<string, number[]> | undefined, version?: any, opts?: unknown): { anim_version: number; pairs: Record<string, any> } {
    root = root ?? "data/generated/gba";
    if (Family.active().name !== "frlg") {
      return AnimPack.writeRse(rom, cache, root, bundles, midLists, version, opts);
    }
    const frames = AnimPack.loadFramesFromRom(rom, version);
    const generalPairs = pairs_using_general(version);
    const rgbCache: Record<string, ReturnType<typeof NativePack.palsToRgb8>> = {};

    // Shared raw anim dumps (for debugging / alternate runtimes).
    const animRoot = root + "/native/general/anim";
    for (const name of Object.keys(frames)) {
      frames[name]!.forEach((blob, i) => {
        cache.write(animRoot + "/" + name + "_" + tostring(i) + ".4bpp", blob);
      });
    }

    const globalManifest = { anim_version: (Versions.ANIM_VERSION ?? 1) as number, pairs: {} as Record<string, any> };

    for (const pairName of generalPairs) {
      const bundle = bundles[pairName];
      if (bundle) {
        const mids = (midLists && midLists[pairName]) || [];
        const byKind: Record<string, number[]> = { water: [], sand: [], flower: [] };
        for (const mid of mids) {
          const kind = classify_mid(bundle, mid);
          if (kind) {
            byKind[kind]!.push(mid);
          }
        }

        let rgbPals = rgbCache[pairName];
        if (!rgbPals) {
          rgbPals = NativePack.palsToRgb8(bundle.mapPals!);
          rgbCache[pairName] = rgbPals;
        }

        const pairDir = root + "/native/" + pairName;
        const pairManifest = {
          water: { mids: byKind.water, frames: frames.water!.length },
          sand: { mids: byKind.sand, frames: frames.sand!.length },
          flower: { mids: byKind.flower, frames: frames.flower!.length },
        };

        const write_bank = (kind: string, startTid: number, frameList: string[]): void => {
          const midList = byKind[kind]!;
          if (midList.length < 1) return;
          const chunks: string[] = [];
          for (const frameBlob of frameList) {
            const baseTiles = mutable_primary(bundle);
            paste_tiles(baseTiles, startTid, frameBlob);
            const work: BundleLike = {
              primaryTiles: baseTiles,
              secondaryTiles: bundle.secondaryTiles,
              mapPals: bundle.mapPals,
              primaryMt: bundle.primaryMt,
              secondaryMt: bundle.secondaryMt,
              primaryAttr: bundle.primaryAttr,
              secondaryAttr: bundle.secondaryAttr,
            };
            for (const mid of midList) {
              chunks.push(bake_mid_rgba(work, mid, rgbPals!));
            }
          }
          // Layout: frame-major: frame0[all mids], frame1[all mids], ...
          // offset = (frame * #mids + midIndex) * 1024
          cache.write(pairDir + "/anim_" + kind + ".rgba", chunks.join(""));
        };

        write_bank("water", AnimPack.WATER_TILE, frames.water!);
        write_bank("sand", AnimPack.SAND_TILE, frames.sand!);
        write_bank("flower", AnimPack.FLOWER_TILE, frames.flower!);

        const lines: string[] = [
          "return {\n",
          format("  anim_version = %d,\n", Versions.ANIM_VERSION ?? 1),
          "  water = { frames = " + tostring(frames.water!.length) + ", mids = {",
        ];
        byKind.water!.forEach((mid, i) => {
          lines.push((i > 0 ? ", " : "") + tostring(mid));
        });
        lines.push("} },\n  sand = { frames = " + tostring(frames.sand!.length) + ", mids = {");
        byKind.sand!.forEach((mid, i) => {
          lines.push((i > 0 ? ", " : "") + tostring(mid));
        });
        lines.push("} },\n  flower = { frames = " + tostring(frames.flower!.length) + ", mids = {");
        byKind.flower!.forEach((mid, i) => {
          lines.push((i > 0 ? ", " : "") + tostring(mid));
        });
        lines.push("} },\n}\n");
        cache.write(pairDir + "/anim_manifest.lua", lines.join(""));
        globalManifest.pairs[pairName] = pairManifest;
        console.log(format("[anim] %s water=%d sand=%d flower=%d",
          pairName, byKind.water!.length, byKind.sand!.length, byKind.flower!.length));
      }
    }

    return globalManifest;
  },

  // Lua: tileset_anim_pack.lua:420 -- pokeemerald/src/tileset_anims.c:574
  // NOT FAITHFUL: Emerald-only, not ported.
  writeRse(_rom: Rom, _cache: Cache, _root: string, _bundles: Record<string, BundleLike>,
    _midLists: Record<string, number[]> | undefined, _version?: any, _opts?: unknown): never {
    throw new Error("tileset_anim_pack: the RSE writer (Emerald) is not ported");
  },

  // Lua: tileset_anim_pack.lua:510
  ready(cache: Cache | undefined, root?: string, pair?: string): boolean {
    root = root ?? "data/generated/gba";
    if (!pair) {
      if (Family.active().name !== "frlg") {
        return !!cache && cache.exists(root + "/" + AnimPack.INDEX_FILE);
      }
      return !!cache && cache.exists(root + "/native/general/anim/water_0.4bpp");
    }
    return !!cache && cache.exists(root + "/native/" + pair + "/anim_manifest.lua");
  },
};

export default AnimPack;
