// Port of gen1recomp src/import/gba/tileset.lua (GPLv3 + additional terms; see LICENSE.md).
// GBA tileset load: LZ tiles (4bpp), uncompressed palettes (BGR555), metatiles, attrs.
// Palettes are 0-based arrays, as the Lua's [0]-keyed tables. A tile sheet's
// raw is a byte string or a 0-based byte array (the Lua's 1-based table);
// metatileEntries returns a 0-based array (entries[i] is the Lua's entries[i + 1]).

import { Lz77 } from "./lz77.ts";
import { Family } from "./family.ts";
import { Versions } from "./versions.ts";
import type { Rom } from "./rom.ts";

export type Palette = number[];
export interface Tiles { count: number; raw: string | Uint8Array | number[]; _mutable?: boolean }
export interface Metatiles { data: string; count: number }
export interface Attributes { data: string; count: number }

export interface TilesetBundle {
  pairName: string;
  primaryTiles: Tiles;
  secondaryTiles: Tiles;
  mapPals: Palette[];
  primaryMt: Metatiles;
  secondaryMt: Metatiles;
  primaryAttr: Attributes;
  secondaryAttr: Attributes;
}

/** A bundle-like work table (tileset_anim_pack swaps tile sheets in). */
export interface BundleLike {
  primaryTiles: Tiles;
  secondaryTiles: Tiles;
  mapPals?: Palette[];
  primaryMt: Metatiles;
  secondaryMt: Metatiles;
  primaryAttr?: Attributes;
  secondaryAttr?: Attributes;
}

interface LoadedTileset { tiles: Tiles; pals: Palette[]; mt: Metatiles; attr: Attributes; secondary: boolean }

export const Tileset = {
  // Lua: tileset.lua:8-21 (the DYNAMIC __index fields)
  get NUM_PRIMARY_TILES(): number { return Family.active().numPrimaryTiles; },
  get NUM_PRIMARY_METATILES(): number { return Family.active().numPrimaryMetatiles; },
  get NUM_PALS_IN_PRIMARY(): number { return Family.active().numPalsInPrimary; },
  get NUM_PALS_TOTAL(): number { return Family.active().numPalsTotal; },

  // Lua: tileset.lua:23
  family() {
    return Family.active();
  },

  // Lua: tileset.lua:28 -- one BGR555 colour → r,g,b in 0..31 (5-bit) and 0..255
  bgr555(c: number): [number, number, number, number, number, number] {
    const r5 = c % 32;
    const g5 = Math.floor(c / 32) % 32;
    const b5 = Math.floor(c / 1024) % 32;
    return [r5, g5, b5, r5 * 255 / 31, g5 * 255 / 31, b5 * 255 / 31];
  },

  // Lua: tileset.lua:35
  loadPalettes(rom: Rom, offset: number, count?: number): Palette[] {
    count = count ?? 16;
    const pals: Palette[] = [];
    for (let p = 0; p <= count - 1; p++) {
      const colors: number[] = [];
      const base = offset + p * 32;
      for (let i = 0; i <= 15; i++) {
        colors[i] = rom.u16(base + i * 2); // 0-based index for GBA
      }
      pals[p] = colors;
    }
    return pals;
  },

  // Lua: tileset.lua:53 -- merge map BG palettes the way FRLG
  // LoadMapTilesetPalettes does. Primary: slots 0..6 from primaryPals[0..6]
  // (color 0 forced black). Secondary: slots 7..12 from secondaryPals[7..12]
  // (full array in ROM; LoadSecondaryTilesetPalette starts at
  // palettes[NUM_PALS_IN_PRIMARY]).
  mergeMapPalettes(primaryPals: Palette[], secondaryPals: Palette[]): Palette[] {
    const map: Palette[] = [];
    const nPri = Tileset.NUM_PALS_IN_PRIMARY;
    const nTot = Tileset.NUM_PALS_TOTAL;
    for (let i = 0; i <= nPri - 1; i++) {
      const src = primaryPals[i] ?? primaryPals[0];
      const copy: number[] = [];
      for (let c = 0; c <= 15; c++) copy[c] = src ? (src[c] ?? 0) : 0;
      copy[0] = 0; // LoadTilesetPalette forces slot0 colour0 to black
      map[i] = copy;
    }
    for (let i = nPri; i <= nTot - 1; i++) {
      const src = secondaryPals[i] ?? secondaryPals[nPri] ?? primaryPals[0];
      const copy: number[] = [];
      for (let c = 0; c <= 15; c++) copy[c] = src ? (src[c] ?? 0) : 0;
      map[i] = copy;
    }
    // Unused high slots: keep defined so a bad palSlot never nil-indexes.
    for (let i = nTot; i <= 15; i++) {
      map[i] = map[0]!;
    }
    return map;
  },

  // Lua: tileset.lua:78 -- decompress 4bpp tiles
  loadTiles4bpp(rom: Rom, lzOffset: number): Tiles {
    let raw: string | Uint8Array | undefined;
    try {
      raw = Lz77.decompressString(rom, lzOffset)[0];
    } catch {
      raw = undefined;
    }
    if (raw === undefined) {
      raw = Lz77.decompress((i: number) => rom.get(i), lzOffset)[0];
    }
    const nbytes = raw.length;
    const tileCount = Math.floor(nbytes / 32);
    return { count: tileCount, raw };
  },

  // Lua: tileset.lua:89 -- uncompressed 4bpp tile sheet (isCompressed=0
  // tilesets, e.g. cable club)
  loadTiles4bppRaw(rom: Rom, offset: number, nbytesIn: unknown): Tiles {
    const nbytes = typeof nbytesIn === "number" ? nbytesIn : 0;
    if (nbytes < 32) return { count: 0, raw: "" };
    const raw = rom.readString(offset, nbytes);
    return { count: Math.floor(nbytes / 32), raw };
  },

  // Lua: tileset.lua:97 -- 4bpp pixel index at (x,y) within tile `tid`
  // (0-based tile id in this sheet)
  tileIndex(tiles: Tiles, tid: number, x: number, y: number): number {
    const raw = tiles.raw;
    const tileOff = tid * 32; // bytes
    // GBA 4bpp: each row is 4 bytes (8 pixels); low nybble first
    const row = y;
    const byteIndex = tileOff + row * 4 + Math.floor(x / 2); // 0-based in raw
    let b: number;
    if (typeof raw === "string") {
      b = byteIndex < raw.length ? raw.charCodeAt(byteIndex) : 0;
    } else {
      b = raw[byteIndex] ?? 0;
    }
    if (x % 2 === 0) {
      return b % 16;
    }
    return Math.floor(b / 16) % 16;
  },

  // Lua: tileset.lua:117
  loadMetatiles(rom: Rom, offset: number, nbytes: number): Metatiles {
    const data = rom.readString(offset, nbytes);
    const count = Math.floor(nbytes / 16);
    return { data, count };
  },

  // Lua: tileset.lua:123
  loadAttributes(rom: Rom, offset: number, nbytes: number): Attributes {
    const data = rom.readString(offset, nbytes);
    const count = Math.floor(nbytes / Family.active().attrBytes);
    return { data, count };
  },

  // Lua: tileset.lua:130 -- [behavior, attrWord]
  // pokefirered/include/global.fieldmap.h:26, pokeemerald/include/global.fieldmap.h:39
  attrOf(attrs: Attributes, mid: number, primaryCount?: number): [number, number] {
    primaryCount = primaryCount ?? Tileset.NUM_PRIMARY_METATILES;
    let idx = mid;
    if (mid >= primaryCount) {
      idx = mid - primaryCount;
    }
    if (idx < 0 || idx >= attrs.count) {
      return [0, 0];
    }
    const F = Family.active();
    const d = attrs.data;
    const at = (i: number): number => (i < d.length ? d.charCodeAt(i) : 0);
    let w: number;
    if (F.attrBytes === 2) {
      const off = idx * 2;
      w = at(off) + at(off + 1) * 256;
      return [F.behaviorOf(w), w];
    }
    const off = idx * 4;
    w = at(off) + at(off + 1) * 256 + at(off + 2) * 65536 + at(off + 3) * 16777216;
    const behavior = F.behaviorOf(w);
    // Collision in map cells is separate; metatile attr also encodes layer type etc.
    // Use bit 0x200 area: pret stores collision in map grid, behavior here.
    return [behavior, w];
  },

  // Lua: tileset.lua:166 -- 8 tile entries (u16) for metatile mid across
  // primary+secondary blobs (0-based array), or undefined
  metatileEntries(primaryMt: Metatiles, secondaryMt: Metatiles, mid: number): number[] | undefined {
    let data: string, localMid: number;
    if (mid < Tileset.NUM_PRIMARY_METATILES) {
      data = primaryMt.data; localMid = mid;
    } else {
      data = secondaryMt.data;
      localMid = mid - Tileset.NUM_PRIMARY_METATILES;
    }
    const off = localMid * 16;
    const dataLen = data ? data.length : 0;
    if (off + 16 > dataLen) return undefined;
    const entries: number[] = new Array(8);
    for (let i = 0; i <= 7; i++) {
      const b = off + i * 2;
      entries[i] = data.charCodeAt(b) + data.charCodeAt(b + 1) * 256;
    }
    return entries;
  },

  // Lua: tileset.lua:193 -- [tileset] or [undefined, err]
  loadOne(rom: Rom, spec: any): [LoadedTileset?, string?] {
    if (!spec) return [undefined, "missing tileset spec"];
    let tiles: Tiles;
    if (spec.compressed === false) {
      let nbytes = spec.tiles_bytes;
      if ((nbytes === undefined || nbytes === null) && spec.palettes && spec.tiles && spec.palettes > spec.tiles) {
        nbytes = spec.palettes - spec.tiles;
      }
      tiles = Tileset.loadTiles4bppRaw(rom, spec.tiles, nbytes ?? 0);
    } else {
      tiles = Tileset.loadTiles4bpp(rom, spec.tiles);
    }
    const pals = Tileset.loadPalettes(rom, spec.palettes, spec.palette_count ?? 16);
    const mt = Tileset.loadMetatiles(rom, spec.metatiles, spec.metatile_bytes);
    const attr = Tileset.loadAttributes(rom, spec.attributes, spec.attr_bytes);
    return [{
      tiles,
      pals,
      mt,
      attr,
      secondary: spec.secondary === true,
    }];
  },

  // Lua: tileset.lua:218 -- load a primary+secondary pair by name from
  // Versions.TILESETS / TILESET_PAIRS. [bundle] or [undefined, err]
  loadPair(rom: Rom, version: any, pairName?: string): [TilesetBundle?, string?] {
    pairName = pairName ?? "sevii_outdoor";
    const pair = (version.tileset_pairs || Versions.TILESET_PAIRS)[pairName];
    const catalog = version.tilesets || Versions.TILESETS;
    if (!pair) return [undefined, "unknown tileset pair " + pairName];
    const [primary] = Tileset.loadOne(rom, catalog[pair.primary]);
    const [secondary] = Tileset.loadOne(rom, catalog[pair.secondary]);
    if (!primary || !secondary) {
      return [undefined, "failed loading tileset pair " + pairName];
    }
    const mapPals = Tileset.mergeMapPalettes(primary.pals, secondary.pals);
    return [{
      pairName,
      primaryTiles: primary.tiles,
      secondaryTiles: secondary.tiles,
      mapPals,
      primaryMt: primary.mt,
      secondaryMt: secondary.mt,
      primaryAttr: primary.attr,
      secondaryAttr: secondary.attr,
    }];
  },

  // Lua: tileset.lua:243 -- back-compat: outdoor Sevii pair
  loadOutdoorPair(rom: Rom, version: any): [TilesetBundle?, string?] {
    return Tileset.loadPair(rom, version, "sevii_outdoor");
  },

  // Lua: tileset.lua:247 -- the behavior (attrOf's first value; every caller
  // takes only that one)
  behaviorOf(bundle: BundleLike, mid: number): number {
    if (mid < Tileset.NUM_PRIMARY_METATILES) {
      return Tileset.attrOf(bundle.primaryAttr!, mid)[0];
    }
    return Tileset.attrOf(bundle.secondaryAttr!, mid, Tileset.NUM_PRIMARY_METATILES)[0];
  },
};

export default Tileset;
