// Port of gen1recomp src/import/gba/alt_layouts.lua (GPLv3 + additional terms; see LICENSE.md).
// pokefirered/src/overworld.c:490 -- layouts a script swaps in at runtime
// (setmaplayoutindex), packed as extra grids keyed alt_<layout id>.

import { tostring } from "./lua.ts";
import { Versions } from "./versions.ts";
import { Family } from "./family.ts";
import { MapTree, type Census, type MapLayout } from "./map_tree.ts";
import { MapCatalog } from "./map_catalog.ts";
import { Maps, type Border, type Grid } from "./maps.ts";
import type { Rom } from "./rom.ts";

export interface AltRow { id: number; map: string; width: number; height: number }

type PadEven = (grid: Grid) => Grid;

// Lua: alt_layouts.lua:37
function read_border(rom: Rom, layout: MapLayout): Border {
  const bw = layout.borderWidth ?? 0;
  const bh = layout.borderHeight ?? 0;
  const off = rom.ptrOffset(layout.borderPtr);
  if (off === undefined || bw < 1 || bh < 1 || bw > 16 || bh > 16) {
    return { width: 1, height: 1, mids: [0] };
  }
  const mids: number[] = [];
  for (let i = 0; i <= bw * bh - 1; i++) {
    mids[i] = rom.u16(off + i * 2) % 1024;
  }
  return { width: bw, height: bh, mids };
}

// Lua: alt_layouts.lua:87
// NOT FAITHFUL (order): pairs() over byPret; the longest match wins and ties
// need two pret names of equal length both prefixing `name`, which cannot
// both pass the boundary check unless equal.
function owner_for(name: string, byPret: Record<string, string>): string | undefined {
  let best: string | undefined, bestLen = 0;
  for (const pret of Object.keys(byPret)) {
    const engineId = byPret[pret]!;
    const n = pret.length;
    if (n > bestLen && name.slice(0, n) === pret) {
      const nextCh = name.slice(n, n + 1);
      if (nextCh === "" || nextCh === "_" || /^[A-Z]$/.test(nextCh)) {
        best = engineId; bestLen = n;
      }
    }
  }
  return best;
}

const ROWS: AltRow[] = [
  // pokefirered/include/constants/layouts.h:253,267,268,308
  { id: 264, map: "SevenIsland_House_Room1", width: 11, height: 9 },
  { id: 278, map: "SeafoamIslands_B3F", width: 38, height: 24 },
  { id: 279, map: "SeafoamIslands_B4F", width: 38, height: 24 },
  { id: 319, map: "ThreeIsland_DunsparceTunnel", width: 30, height: 7 },
];

// pokefirered/src/trainer_tower.c:554, include/constants/layouts.h:355, :363
const TOWER_ROWS: AltRow[] = [];
for (let floor = 1; floor <= 8; floor++) {
  const map = "TrainerTower_" + floor + "F";
  TOWER_ROWS.push({ id: 365 + floor, map, width: 18, height: 17 });
  TOWER_ROWS.push({ id: 373 + floor, map, width: 18, height: 17 });
}

export const AltLayouts = {
  ROWS,
  TOWER_ROWS,
  KEY_PREFIX: "alt_",

  // Lua: alt_layouts.lua:27
  key(id: number): string {
    return AltLayouts.KEY_PREFIX + tostring(id);
  },

  // Lua: alt_layouts.lua:31
  layoutOffset(rom: Rom, version: any, id: number | undefined): number | undefined {
    const base = (version && version.g_map_layouts) || Versions.G_MAP_LAYOUTS;
    if (!base || id === undefined || id === null || id < 1) return undefined;
    return rom.ptrOffset(rom.u32(base + (id - 1) * 4));
  },

  // Lua: alt_layouts.lua:52 -- pokefirered/src/scrcmd.c:711
  build(rom: Rom, version: any, grids: Record<string, Grid> | undefined, borders: Record<string, Border> | undefined,
    padEven?: PadEven): string[] {
    const added: string[] = [];
    const rows: AltRow[] = [];
    for (const row of AltLayouts.ROWS) rows.push(row);
    for (const row of AltLayouts.TOWER_ROWS) rows.push(row);
    for (const row of rows) {
      const ownerId = MapCatalog.resolve(row.map);
      const owner = ownerId && grids ? grids[ownerId] : undefined;
      const layoutOff = AltLayouts.layoutOffset(rom, version, row.id);
      const layout = layoutOff !== undefined ? MapTree.parseLayout(rom, layoutOff) : undefined;
      const mapOff = layout ? rom.ptrOffset(layout.mapPtr) : undefined;
      if (owner && layout && mapOff !== undefined
        && layout.width === row.width && layout.height === row.height) {
        let grid = Maps.loadGrid(rom, {
          offset: mapOff, width: layout.width, height: layout.height,
        });
        grid.map_id = ownerId;
        grid.kind = owner.kind;
        grid.pair = owner.pair;
        grid.environment = owner.environment;
        if (padEven) grid = padEven(grid);
        grid.altLayoutId = row.id;
        grid.altOwner = ownerId;
        const key = AltLayouts.key(row.id);
        grids![key] = grid;
        if (borders) borders[key] = read_border(rom, layout);
        added.push(key);
      }
    }
    return added;
  },

  // Lua: alt_layouts.lua:102 -- pokeemerald/src/overworld.c:993. Needs the
  // family's symbol table (F:syms(), RSE only); a family without it fails
  // there, as the Lua does. [added, skipped]
  buildUnreferenced(rom: Rom, version: any, grids: Record<string, Grid> | undefined,
    borders: Record<string, Border> | undefined, padEven: PadEven | undefined, census: Census | undefined): [string[], string[]] {
    const F = Family.active() as any;
    if (typeof F.syms !== "function") throw new Error("attempt to call method 'syms' (a nil value)");
    const S = F.syms();
    const base = (version && version.g_map_layouts) || Versions.G_MAP_LAYOUTS;
    const count: number = Versions.NUM_MAP_LAYOUTS ?? 0;
    const referenced = new Set<number>();
    const byPret: Record<string, string> = {};
    for (const entry of (census && census.maps) || []) {
      if (entry.layout && entry.layout.layoutOff !== undefined) referenced.add(entry.layout.layoutOff);
      if (entry.pretName && entry.engineId) byPret[entry.pretName] = entry.engineId;
    }
    const added: string[] = [], skipped: string[] = [];
    for (let id = 1; id <= count; id++) {
      const layoutOff = rom.ptrOffset(rom.u32(base + (id - 1) * 4));
      if (layoutOff !== undefined && !referenced.has(layoutOff)) {
        const layout = MapTree.parseLayout(rom, layoutOff);
        const mapOff = layout ? rom.ptrOffset(layout.mapPtr) : undefined;
        const pair = layout && mapOff !== undefined ? MapCatalog.pairForLayout(rom, layout) : undefined;
        const key = AltLayouts.key(id);
        if (pair) {
          let name: string | undefined;
          for (const n of S.namesAt(layoutOff) as string[]) {
            const m = /^(.+)_Layout$/.exec(n);
            name = (m ? m[1] : undefined) ?? name;
          }
          const ownerId = name ? owner_for(name, byPret) : undefined;
          const owner = ownerId && grids ? grids[ownerId] : undefined;
          let grid = Maps.loadGrid(rom, { offset: mapOff!, width: layout!.width, height: layout!.height });
          grid.map_id = key;
          grid.pair = pair;
          grid.kind = owner ? owner.kind : undefined;
          grid.environment = owner ? owner.environment : undefined;
          if (padEven) grid = padEven(grid);
          grid.altLayoutId = id;
          grid.layoutName = name;
          if (owner && owner.width === grid.width && owner.height === grid.height) {
            grid.altOwner = ownerId;
          }
          grids![key] = grid;
          if (borders) borders[key] = read_border(rom, layout!);
          added.push(key);
        } else {
          skipped.push(key);
        }
      }
    }
    return [added, skipped];
  },
};

export default AltLayouts;
