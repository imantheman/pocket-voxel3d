// Port of gen1recomp src/import/gba/maps.lua (GPLv3 + additional terms; see LICENSE.md).
// Load FRLG map grids (metatile id + collision) from ROM. Grid cells and
// border mids are 0-based arrays (cells[i] is the Lua's cells[i + 1]).

import { Versions } from "./versions.ts";
import { Family } from "./family.ts";
import { ExtractMapEvents } from "./extract_map_events.ts";
import type { Rom } from "./rom.ts";

export interface Cell { mid: number; coll: number; elev: number }

export interface Grid {
  width: number;
  height: number;
  cells: Cell[];
  map_id?: string;
  kind?: string;
  pair?: string;
  environment?: string;
  padded_from?: { width: number; height: number };
  altLayoutId?: number;
  altOwner?: string;
  layoutName?: string;
  [k: string]: unknown;
}

export interface Border { width: number; height: number; mids: number[] }

export interface LayoutSpec { offset: number; width: number; height: number }

export const Maps = {
  // Lua: maps.lua:6 -- map.bin: u16 per cell = metatileId | (collision << 10) | (elevation << 12)
  loadGrid(rom: Rom, layoutSpec: LayoutSpec): Grid {
    const w = layoutSpec.width, h = layoutSpec.height;
    const n = w * h;
    const cells: Cell[] = new Array(n);
    const offset = layoutSpec.offset;
    for (let i = 0; i <= n - 1; i++) {
      const v = rom.u16(offset + i * 2);
      const mid = v % 1024;
      const coll = Math.floor(v / 1024) % 4;
      const elev = Math.floor(v / 4096) % 16;
      cells[i] = { mid, coll, elev };
    }
    return { width: w, height: h, cells };
  },

  // Lua: maps.lua:21
  loadIsland1(rom: Rom, version: any): Record<string, Grid> {
    const out: Record<string, Grid> = {};
    const maps = Versions.MAPS as Record<string, any>;
    for (const mapId of Object.keys(maps)) {
      const spec = maps[mapId];
      const layoutName = spec.layout;
      const layoutSpec = version.layouts[layoutName];
      if (layoutSpec) {
        const grid = Maps.loadGrid(rom, layoutSpec);
        grid.map_id = mapId;
        grid.kind = spec.kind;
        grid.pair = spec.pair;
        grid.environment = spec.environment;
        out[mapId] = grid;
      }
    }
    return out;
  },

  // Lua: maps.lua:41 -- MapLayout border block (pret map.json border), or a
  // 1×1 mid-0 fallback
  loadBorder(rom: Rom, version: any, mapId: string): Border {
    const headers = (version && version.map_headers) || Versions.MAP_HEADERS;
    const headerOff = headers ? headers[mapId] : undefined;
    if (headerOff === undefined || headerOff === null) {
      return { width: 1, height: 1, mids: [0] };
    }
    const hdr = ExtractMapEvents.parseHeader(rom, headerOff);
    const layoutOff = Versions.gbaToFile(hdr && hdr.layout);
    if (layoutOff === undefined) {
      return { width: 1, height: 1, mids: [0] };
    }
    const borderPtr = rom.u32(layoutOff + 8);
    let [bw, bh] = Family.active().borderDims(rom, layoutOff);
    bw = bw ?? 0; bh = bh ?? 0;
    const borderOff = Versions.gbaToFile(borderPtr);
    if (borderOff === undefined || bw < 1 || bh < 1 || bw > 16 || bh > 16) {
      return { width: 1, height: 1, mids: [0] };
    }
    const mids: number[] = [];
    for (let i = 0; i <= bw * bh - 1; i++) {
      const v = rom.u16(borderOff + i * 2);
      mids[i] = v % 1024;
    }
    return { width: bw, height: bh, mids };
  },

  // Lua: maps.lua:69
  loadBordersIsland1(rom: Rom, version: any): Record<string, Border> {
    const out: Record<string, Border> = {};
    for (const mapId of Object.keys(Versions.MAPS)) {
      out[mapId] = Maps.loadBorder(rom, version, mapId);
    }
    return out;
  },
};

export default Maps;
