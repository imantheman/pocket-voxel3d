// Per 8x8 cell tile id + GBC attributes, mirroring pret wSurroundingTiles +
// wAttrmap as built by LoadOverworldAttrmapPals
// (engine/tilesets/map_palettes.asm).
// A port of gen1recomp src/world/gen2/MapAttrGrid.lua at bdfac727 (MIT).
//
// Retail Crystal derives palette (+ VRAM bank in the palmap nybble) from the
// tileset PalMap indexed by the metatile byte; bit 7 of the tile id is
// cleared into the attr bank bit and the normalized id is what VRAM fetches.

import { BorderFill } from "./BorderFill.ts";
import { TileAttrs, type TileAttr } from "./TileAttrs.ts";

export interface AttrCell {
  tileId: number;
  rawTileId: number;
  attr: TileAttr;
}

export const MapAttrGrid = {
  // Lua: MapAttrGrid.lua:13-42 -- pret _LoadOverworldAttrmapPals: srl a /
  // carry picks upper vs lower nybble; res 7,[hl] clears tile bit 7 after the
  // lookup. Returns [normId, attr], or [] for no tile.
  normalizeTile(rawTileId: number | null | undefined, tileset: any): [number, TileAttr] | [] {
    if (rawTileId == null) return [];
    const bankFromTile = (rawTileId >= 0x80) ? 1 : 0;
    const normId = rawTileId % 0x80;

    const attrs = tileset ? tileset.tileAttrs : undefined;
    let attr: any;
    if (attrs) {
      if (bankFromTile === 1) {
        attr = attrs[0x80 + normId] ?? attrs[normId];
      } else {
        attr = attrs[normId] ?? attrs[0x80 + normId];
      }
    }
    if (!attr) {
      attr = TileAttrs.forTile(tileset, rawTileId);
    }

    const out: TileAttr = {
      palette: attr.palette,
      vramBank: (attr.vramBank !== 0 ? attr.vramBank : bankFromTile),
      priority: attr.priority,
      xFlip: attr.xFlip,
      yFlip: attr.yFlip,
    };
    return [normId, out];
  },

  // Lua: MapAttrGrid.lua:44-53 -- the raw tile id under map pixel (mx, my).
  tileAt(map: any, tileset: any, mx: number, my: number): number | undefined {
    const bx = Math.floor(mx / 32);
    const by = Math.floor(my / 32);
    if (bx < 0 || by < 0 || bx >= map.width || by >= map.height) return undefined;
    const blockId = BorderFill.blockFor(
      map.blocks[by * map.width + bx], map.borderBlock);
    const block = tileset.blocks ? tileset.blocks[blockId ?? 0] : undefined;
    if (!block) return undefined;
    const i = Math.floor((my % 32) / 8) * 4 + Math.floor((mx % 32) / 8);
    return block[i];
  },

  // Lua: MapAttrGrid.lua:55-60
  cellAt(map: any, tileset: any, mx: number, my: number): AttrCell | undefined {
    const raw = MapAttrGrid.tileAt(map, tileset, mx, my);
    if (raw == null) return undefined;
    const [tileId, attr] = MapAttrGrid.normalizeTile(raw, tileset) as [number, TileAttr];
    return { tileId, rawTileId: raw, attr };
  },

  // Lua: MapAttrGrid.lua:62-74 -- full map grid keyed by "mx,my".
  build(map: any, tileset: any): Record<string, AttrCell> {
    const grid: Record<string, AttrCell> = {};
    if (!(map && tileset)) return grid;
    const pw = map.width * 32;
    const ph = map.height * 32;
    for (let my = 0; my <= ph - 1; my += 8) {
      for (let mx = 0; mx <= pw - 1; mx += 8) {
        const cell = MapAttrGrid.cellAt(map, tileset, mx, my);
        if (cell) grid[mx + "," + my] = cell;
      }
    }
    return grid;
  },

  // Lua: MapAttrGrid.lua:76-81
  lookup(grid: Record<string, AttrCell> | null | undefined, mx: number, my: number): AttrCell | undefined {
    if (!grid) return undefined;
    const tx = Math.floor(mx / 8) * 8;
    const ty = Math.floor(my / 8) * 8;
    return grid[tx + "," + ty];
  },
};

export default MapAttrGrid;
