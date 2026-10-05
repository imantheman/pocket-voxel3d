// Port of gen1recomp src/import/gba/map_tree.lua (GPLv3 + additional terms; see LICENSE.md).
// Walk gMapGroups -> MapHeader -> MapLayout -> Tileset (pret map tree).
// One ROM pin (gMapGroups) + pret group lengths/names; no per-map header offsets.
// The groups data (map_groups_firered.ts) keeps Lua's integer keys as object
// keys (groups[gi], maps[mi + 1]); census lists are 0-based JS arrays.

import { format } from "./lua.ts";
import { luaGet, luaLen } from "./luatable.ts";
import { Versions } from "./versions.ts";
import { Family } from "./family.ts";
import { ExtractMapEvents, type MapEvents, type MapHeader } from "./extract_map_events.ts";
import type { Rom } from "./rom.ts";

export interface MapLayout {
  layoutOff: number;
  width: number;
  height: number;
  borderPtr: number;
  mapPtr: number;
  primaryTilesetPtr: number;
  secondaryTilesetPtr: number;
  borderWidth: number;
  borderHeight: number;
}

export interface TilesetStruct {
  ptr: number;
  id: string;
  structOff: number;
  compressed: boolean;
  secondary: boolean;
  tilesPtr: number;
  palettesPtr: number;
  metatilesPtr: number;
  callbackPtr: number;
  attributesPtr: number;
  metatile_bytes: number;
  attr_bytes: number;
  mid_count: number;
  palette_count: number;
}

export interface CensusConnection {
  dir: string;
  mapGroup: number;
  mapNum: number;
  offset: number;
  map: string;
}

export interface CensusEntry {
  group: number;
  num: number;
  slot: string;
  id: string;
  pretName: string | undefined;
  groupName: string | undefined;
  header: MapHeader & Record<string, any>;
  layout: MapLayout;
  connections: CensusConnection[];
  events: MapEvents | undefined;
  primaryTileset: string;
  secondaryTileset: string;
  engineId?: string;
}

export interface Census {
  maps: CensusEntry[];
  tilesets: Record<number, TilesetStruct>;
  groups: { group: number; name: string | undefined; count: number; maps: { slot: string; id: string; num: number }[] }[];
  g_map_groups: number;
  map_count: number;
  tileset_count: number;
}

function gba_off(rom: Rom, ptr: number | undefined): number | undefined {
  return rom.ptrOffset(ptr);
}

// Lua: map_tree.lua:14
function s32(rom: Rom, offset: number): number {
  const v = rom.u32(offset);
  if (v >= 0x80000000) return v - 0x100000000;
  return v;
}

export const MapTree = {
  // Lua: map_tree.lua:20
  loadGroups(): any {
    return Family.active().groups();
  },

  // Lua: map_tree.lua:26 -- stable id for a (group, map) tuple. Prefer pret
  // name; else g{G}_m{N}. Engine FR_* aliases are intentionally not preferred
  // here -- map_tree is census-first.
  mapId(group: number, num: number, pretName: unknown): string {
    if (typeof pretName === "string" && pretName !== "") {
      return pretName;
    }
    return format("g%d_m%d", group, num);
  },

  // Lua: map_tree.lua:33
  slotKey(group: number, num: number): string {
    return format("%d_%d", group, num);
  },

  // Lua: map_tree.lua:37
  tilesetId(gbaPtr: number | undefined): string {
    return format("ts_%08x", gbaPtr ?? 0);
  },

  // Lua: map_tree.lua:42 -- full MapHeader (pret global.fieldmap.h)
  parseHeader(rom: Rom, headerOff: number): MapHeader & Record<string, any> {
    const base: MapHeader & Record<string, any> = ExtractMapEvents.parseHeader(rom, headerOff);
    base.regionMapSectionId = rom.get(headerOff + 20);
    base.cave = rom.get(headerOff + 21);
    base.weather = rom.get(headerOff + 22);
    base.mapType = rom.get(headerOff + 23);
    Family.active().decodeHeaderFlags(rom, headerOff, base);
    base.headerOff = headerOff;
    return base;
  },

  // Lua: map_tree.lua:54 -- MapLayout at file offset
  parseLayout(rom: Rom, layoutOff: number | undefined): MapLayout | undefined {
    if (layoutOff === undefined || layoutOff === null) return undefined;
    const width = s32(rom, layoutOff);
    const height = s32(rom, layoutOff + 4);
    if (width < 1 || height < 1 || width > 512 || height > 512) {
      return undefined;
    }
    const [bw, bh] = Family.active().borderDims(rom, layoutOff);
    return {
      layoutOff,
      width,
      height,
      borderPtr: rom.u32(layoutOff + 8),
      mapPtr: rom.u32(layoutOff + 12),
      primaryTilesetPtr: rom.u32(layoutOff + 16),
      secondaryTilesetPtr: rom.u32(layoutOff + 20),
      borderWidth: bw,
      borderHeight: bh,
    };
  },

  // Lua: map_tree.lua:76 -- struct Tileset; metatile/attr sizes inferred from
  // pointer gap (valid for FR 1.0)
  parseTileset(rom: Rom, tilesetPtr: number): TilesetStruct | undefined {
    const off = gba_off(rom, tilesetPtr);
    if (off === undefined) return undefined;
    const F = Family.active();
    const o = F.tilesetOffsets;
    const isCompressed = rom.get(off) !== 0;
    const isSecondary = rom.get(off + 1) !== 0;
    const tilesPtr = rom.u32(off + o.tiles);
    const palsPtr = rom.u32(off + o.palettes);
    const mtPtr = rom.u32(off + o.metatiles);
    const callbackPtr = rom.u32(off + o.callback);
    const attrPtr = rom.u32(off + o.attributes);
    const mtOff = gba_off(rom, mtPtr);
    const attrOff = gba_off(rom, attrPtr);
    let metatileBytes = 0;
    if (mtOff !== undefined && attrOff !== undefined && attrOff > mtOff) {
      metatileBytes = attrOff - mtOff;
    } else if (!isSecondary) {
      metatileBytes = F.numPrimaryMetatiles * F.metatileBytes;
    }
    if (metatileBytes % 16 !== 0) {
      metatileBytes = metatileBytes - (metatileBytes % 16);
    }
    const midCount = Math.floor(metatileBytes / 16);
    const attrBytes = midCount * F.attrBytes;
    return {
      ptr: tilesetPtr,
      id: MapTree.tilesetId(tilesetPtr),
      structOff: off,
      compressed: isCompressed,
      secondary: isSecondary,
      tilesPtr,
      palettesPtr: palsPtr,
      metatilesPtr: mtPtr,
      callbackPtr,
      attributesPtr: attrPtr,
      metatile_bytes: metatileBytes,
      attr_bytes: attrBytes,
      mid_count: midCount,
      palette_count: 16,
    };
  },

  // Lua: map_tree.lua:119
  parseConnections(rom: Rom, connectionsPtr: number, groupsData?: any): CensusConnection[] {
    const off = gba_off(rom, connectionsPtr);
    if (off === undefined) return [];
    const count = rom.u32(off);
    if (count >= 0x80000000 || count > 8) return [];
    const listOff = gba_off(rom, rom.u32(off + 4));
    if (listOff === undefined || count < 1) return [];
    const out: CensusConnection[] = [];
    const dirs = Family.active().connDirs;
    for (let i = 0; i <= count - 1; i++) {
      const base = listOff + i * 12;
      const direction = rom.get(base);
      let offset = rom.u32(base + 4);
      if (offset >= 0x80000000) offset = offset - 0x100000000;
      const mapGroup = rom.get(base + 8);
      const mapNum = rom.get(base + 9);
      const dirName = dirs[direction];
      if (dirName) {
        let pretName: string | undefined;
        if (groupsData && groupsData.groups && groupsData.groups[mapGroup]) {
          const maps = groupsData.groups[mapGroup].maps;
          pretName = maps ? (luaGet(maps, mapNum + 1) as string | undefined) : undefined;
        }
        out.push({
          dir: dirName,
          mapGroup,
          mapNum,
          offset,
          map: MapTree.mapId(mapGroup, mapNum, pretName),
        });
      }
    }
    return out;
  },

  // Lua: map_tree.lua:155 -- raw map.bin u16 cells (metatile | coll<<10 | elev<<12)
  readGridBytes(rom: Rom, layout: MapLayout): string | undefined {
    const mapOff = gba_off(rom, layout.mapPtr);
    if (mapOff === undefined) return undefined;
    const nbytes = layout.width * layout.height * 2;
    return rom.readString(mapOff, nbytes);
  },

  // Lua: map_tree.lua:167
  readBorderBytes(rom: Rom, layout: MapLayout): string | undefined {
    const borderOff = gba_off(rom, layout.borderPtr);
    const bw = layout.borderWidth ?? 2;
    const bh = layout.borderHeight ?? 2;
    if (borderOff === undefined || bw < 1 || bh < 1) return undefined;
    const nbytes = bw * bh * 2;
    return rom.readString(borderOff, nbytes);
  },

  // Lua: map_tree.lua:183 -- census every map under gMapGroups; dedupes
  // tileset structs by pointer. [census] or [undefined, err]
  walk(rom: Rom, version?: any, opts?: { groups?: number[] } & Record<string, any>): [Census | undefined, string?] {
    opts = opts ?? {};
    version = version ?? Versions.lookup((rom as any).sha1 ?? rom.md5)[0];
    const groupsData = MapTree.loadGroups();
    const gMapGroups: number | undefined = (version && version.g_map_groups) || Versions.G_MAP_GROUPS;
    if (!gMapGroups) {
      return [undefined, "version missing g_map_groups"];
    }

    const allowGroups = opts.groups; // optional list of group indices
    let allowSet: Set<number> | undefined;
    if (allowGroups) {
      allowSet = new Set();
      for (const g of allowGroups) allowSet.add(g);
    }

    const maps: CensusEntry[] = [];
    const tilesets: Record<number, TilesetStruct> = {};
    const groupSummaries: Census["groups"] = [];
    const order = groupsData.group_order ?? {};
    const numGroups = luaLen(order);

    for (let gi = 0; gi <= numGroups - 1; gi++) {
      if (allowSet && !allowSet.has(gi)) continue;
      const groupInfo = groupsData.groups[gi];
      if (!groupInfo) continue;
      const groupPtr = rom.u32(gMapGroups + gi * 4);
      const groupOff = gba_off(rom, groupPtr);
      if (groupOff === undefined) continue;
      const mapNames = groupInfo.maps ?? {};
      const groupMaps: { slot: string; id: string; num: number }[] = [];
      const nMaps = luaLen(mapNames);
      for (let mi = 0; mi <= nMaps - 1; mi++) {
        const headerPtr = rom.u32(groupOff + mi * 4);
        const headerOff = gba_off(rom, headerPtr);
        if (headerOff === undefined) continue;
        const header = MapTree.parseHeader(rom, headerOff);
        const layoutOff = gba_off(rom, header.layout);
        const layout = MapTree.parseLayout(rom, layoutOff);
        if (!layout) continue;

        const pretName = luaGet(mapNames, mi + 1) as string | undefined;
        const mapId = MapTree.mapId(gi, mi, pretName);
        const slot = MapTree.slotKey(gi, mi);

        for (const tsPtr of [layout.primaryTilesetPtr, layout.secondaryTilesetPtr]) {
          if (tsPtr !== undefined && tsPtr !== 0 && !tilesets[tsPtr]) {
            const ts = MapTree.parseTileset(rom, tsPtr);
            if (ts) tilesets[tsPtr] = ts;
          }
        }

        const connections = MapTree.parseConnections(rom, header.connections, groupsData);
        const events = ExtractMapEvents.parseMapEvents(rom, header.events);

        // Resolve warp dest names with pret census (not only hand FRLG_MAP_TO_FR).
        if (events && events.warps) {
          for (const w of events.warps) {
            const ginfo = groupsData.groups[w.mapGroup];
            const n = ginfo && ginfo.maps ? luaGet(ginfo.maps, (w.mapNum ?? 0) + 1) : undefined;
            w.destMap = MapTree.mapId(w.mapGroup, w.mapNum, n);
          }
        }

        const entry: CensusEntry = {
          group: gi,
          num: mi,
          slot,
          id: mapId,
          pretName,
          groupName: groupInfo.name,
          header,
          layout,
          connections,
          events,
          primaryTileset: MapTree.tilesetId(layout.primaryTilesetPtr),
          secondaryTileset: MapTree.tilesetId(layout.secondaryTilesetPtr),
        };
        maps.push(entry);
        groupMaps.push({ slot, id: mapId, num: mi });
      }
      groupSummaries.push({
        group: gi,
        name: groupInfo.name,
        count: groupMaps.length,
        maps: groupMaps,
      });
    }

    maps.sort((a, b) => {
      if (a.group !== b.group) return a.group - b.group;
      return a.num - b.num;
    });

    return [{
      maps,
      tilesets,
      groups: groupSummaries,
      g_map_groups: gMapGroups,
      map_count: maps.length,
      tileset_count: Object.keys(tilesets).length,
    }];
  },
};

export default MapTree;
