// Port of gen1recomp src/import/gba/region_map_tables.lua (GPLv3 + additional terms; see LICENSE.md).
// FireRed region map / location preview ROM tables.
// Source: pokefirered src/region_map.c (sDungeonInfo, sMapsecName_*,
// sRegionMapSectionIdToName) and include/map_preview_screen.h
// (sMapPreviewScreenData).
//
// Locating is verify-then-scan: the pinned offset is authoritative for every
// supported dump (the extractor only runs for SHA-1s in Versions.BY_SHA1), so a
// bounded window scan around it is only a belt-and-braces guard.

import { Versions } from "./versions.ts";
import { TextIR } from "../../game/gen3/core/scripting/text_ir.ts";
import { format } from "./lua.ts";
import type { Rom } from "./rom.ts";

export type Get = (i: number) => number;
export interface PreviewEntry {
  mapsec: number; type: number; flagId: number; tilesOffset: number; tilemapOffset: number; paletteOffset: number;
}
export interface DungeonInfo { mapsec: number; name: string; desc: string }
export interface RegionMapTablesResult {
  previewBase: number; previews: PreviewEntry[]; names: Record<number, string>; namesVerified: boolean; dungeonInfo: DungeonInfo[];
}

// Bounded re-scan window (bytes) around the pinned offset.
const SCAN_WINDOW = 0x8000;
const SCAN_STEP = 4;

const CHARMAP = TextIR.CHARMAP;
const CTRL = TextIR.CTRL;

// Lua: region_map_tables.lua:24
function u16le(get: Get, o: number): number {
  return get(o) + get(o + 1) * 256;
}

// Lua: region_map_tables.lua:28
function u32le(get: Get, o: number): number {
  return get(o) + get(o + 1) * 256 + get(o + 2) * 65536 + get(o + 3) * 16777216;
}

// Lua: region_map_tables.lua:32
function romPtrToOffset(addr: number, romSize: number): number | undefined {
  if (addr < 0x08000000 || addr >= 0x08000000 + romSize) return undefined;
  return addr - 0x08000000;
}

// struct MapPreviewScreen { u8 mapsec; u8 type; u16 flagId;
//                          const void *tilesptr, *tilemapptr, *palptr; }
// Lua: region_map_tables.lua:60 (read when the module loads, as the Lua does)
const PREVIEW_ENTRY_SIZE: number = Versions.MAP_PREVIEW_ENTRY_SIZE;
const PREVIEW_COUNT: number = Versions.MAP_PREVIEW_COUNT;

// Lua: region_map_tables.lua:64 -- validate one 16-byte sMapPreviewScreenData entry
function readPreviewEntry(get: Get, romSize: number, off: number): PreviewEntry | undefined {
  const mapsec = get(off);
  const typ = get(off + 1);
  if (mapsec === undefined || typ === undefined) return undefined;
  if (mapsec < Versions.MAPSEC_FIRST || mapsec > Versions.MAPSEC_LAST) return undefined;
  if (typ !== Versions.MAP_PREVIEW_TYPE_CAVE && typ !== Versions.MAP_PREVIEW_TYPE_FOREST) return undefined;
  const flagId = u16le(get, off + 2);
  const tilesPtr = u32le(get, off + 4);
  const tilemapPtr = u32le(get, off + 8);
  const palPtr = u32le(get, off + 12);
  const tiles = romPtrToOffset(tilesPtr, romSize);
  const tilemap = romPtrToOffset(tilemapPtr, romSize);
  const pal = romPtrToOffset(palPtr, romSize);
  if (tiles === undefined || tilemap === undefined || pal === undefined) return undefined;
  // Structural invariant of the shipped table: the palette is physically the
  // first 32 colours of the tile block (holds for all 28 entries).
  if (pal + 0x40 !== tiles) return undefined;
  return { mapsec, type: typ, flagId, tilesOffset: tiles, tilemapOffset: tilemap, paletteOffset: pal };
}

// Lua: region_map_tables.lua:94 -- true when `off` starts a full, valid sMapPreviewScreenData table
function isPreviewTable(get: Get, romSize: number, off: number): boolean {
  for (let i = 0; i <= PREVIEW_COUNT - 1; i++) {
    if (!readPreviewEntry(get, romSize, off + i * PREVIEW_ENTRY_SIZE)) return false;
  }
  return true;
}

export const RegionMapTables = {
  NOT_FOUND: "location preview data not found in this ROM revision",

  /**
   * Lua: region_map_tables.lua:40 -- decode a 0xFF-terminated FRLG string at
   * `offset`. 0xFE (\n) and 0xFA (\l) both become "\n"; unknown control bytes
   * are dropped. Returns [string, offset of the terminator].
   */
  decodeString(get: Get, offset: number, limit?: number): [string, number] {
    let out = "";
    let o = offset;
    const last = limit ?? offset + 512;
    while (o < last) {
      const b = get(o);
      if (b === undefined || b === CTRL.EOS) break;
      if (b === CTRL.NL || b === CTRL.SCROLL) out += "\n";
      else {
        const ch = Object.prototype.hasOwnProperty.call(CHARMAP, b) ? CHARMAP[b] : undefined;
        if (ch !== undefined) out += ch;
      }
      o++;
    }
    return [out, o];
  },

  // Lua: region_map_tables.lua:104 -- the file offset of sMapPreviewScreenData, or undefined
  locatePreviewTable(get: Get, romSize: number, hint?: number): number | undefined {
    hint = hint ?? Versions.MAP_PREVIEW_SCREEN_DATA;
    if (hint !== undefined && hint >= 0 && hint + PREVIEW_COUNT * PREVIEW_ENTRY_SIZE <= romSize) {
      if (isPreviewTable(get, romSize, hint)) return hint;
    }
    const lo = Math.max(0, (hint ?? 0) - SCAN_WINDOW);
    const hi = Math.min(romSize - PREVIEW_COUNT * PREVIEW_ENTRY_SIZE, (hint ?? 0) + SCAN_WINDOW);
    for (let off = lo; off <= hi; off += SCAN_STEP) {
      if (off !== hint && isPreviewTable(get, romSize, off)) return off;
    }
    return undefined;
  },

  // Lua: region_map_tables.lua:118 -- all 28 sMapPreviewScreenData entries, in table order
  readPreviews(get: Get, romSize: number, base: number): PreviewEntry[] {
    const out: PreviewEntry[] = [];
    for (let i = 0; i <= PREVIEW_COUNT - 1; i++) {
      const e = readPreviewEntry(get, romSize, base + i * PREVIEW_ENTRY_SIZE);
      if (!e) throw new Error(format("map preview entry %d invalid at 0x%X", i, base + i * PREVIEW_ENTRY_SIZE));
      out.push(e);
    }
    return out;
  },

  // Lua: region_map_tables.lua:132 -- sMapsecName_*: mapsec 88..196 -> display name; [names, order]
  readMapsecNames(get: Get, _romSize: number, base?: number): [Record<number, string>, number[]] {
    base = base ?? Versions.MAPSEC_NAMES;
    const names: Record<number, string> = {};
    const order: number[] = [];
    let o = base!;
    for (let sec = Versions.MAPSEC_FIRST; sec <= Versions.MAPSEC_LAST; sec++) {
      const [name, next0] = RegionMapTables.decodeString(get, o);
      names[sec] = name;
      order.push(o);
      o = next0 + 1;
    }
    return [names, order];
  },

  // Lua: region_map_tables.lua:148 -- verify sMapsecName_* against sRegionMapSectionIdToName[]
  verifyNamePointers(get: Get, romSize: number, order: number[], tableBase?: number): boolean {
    tableBase = tableBase ?? Versions.MAPSEC_NAME_POINTERS;
    if (order.length !== Versions.MAPSEC_COUNT) return false;
    for (let i = 1; i <= order.length; i++) {
      const ptr = u32le(get, tableBase! + (i - 1) * 4);
      const off = romPtrToOffset(ptr, romSize);
      if (off !== order[i - 1]) return false;
    }
    return true;
  },

  // Lua: region_map_tables.lua:160 -- sDungeonInfo[]: { mapsec, name, desc }
  readDungeonInfo(get: Get, romSize: number, base?: number): DungeonInfo[] {
    base = base ?? Versions.DUNGEON_INFO;
    const out: DungeonInfo[] = [];
    let off = base!;
    for (let n = 1; n <= Versions.DUNGEON_INFO_COUNT; n++) {
      const mapsec = u32le(get, off);
      const nameOff = romPtrToOffset(u32le(get, off + 4), romSize);
      const descOff = romPtrToOffset(u32le(get, off + 8), romSize);
      if (nameOff === undefined || descOff === undefined) break;
      const [name] = RegionMapTables.decodeString(get, nameOff);
      const [desc] = RegionMapTables.decodeString(get, descOff);
      out.push({ mapsec, name, desc });
      off += Versions.DUNGEON_INFO_ENTRY_SIZE;
    }
    return out;
  },

  // Lua: region_map_tables.lua:179 -- every region-map table: [tables] or [undefined, err]
  load(rom: Rom): [RegionMapTablesResult | undefined, string?] {
    const romSize = rom.size;
    const get: Get = (i) => rom.get(i);

    const previewBase = RegionMapTables.locatePreviewTable(get, romSize);
    if (previewBase === undefined) return [undefined, RegionMapTables.NOT_FOUND];

    const [names, order] = RegionMapTables.readMapsecNames(get, romSize);
    const namesVerified = RegionMapTables.verifyNamePointers(get, romSize, order);

    return [{
      previewBase,
      previews: RegionMapTables.readPreviews(get, romSize, previewBase),
      names,
      namesVerified,
      dungeonInfo: RegionMapTables.readDungeonInfo(get, romSize),
    }];
  },
};

export default RegionMapTables;
