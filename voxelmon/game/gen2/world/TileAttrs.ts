// Per-tile GBC attribute lookup for Crystal tilesets (palette, VRAM bank,
// flips, BG priority). Gold and Silver keep tilePalettes only; missing
// tileAttrs entries fall back to palette slot 1 with no bank or flags.
// A port of gen1recomp src/world/gen2/TileAttrs.lua at bdfac727 (MIT).
//
// `tileset.tileAttrs` / `tileset.tilePalettes` are 0-based JSON arrays of
// what the Lua indexed from 1 (`attrs[tileId + 1]` reads `attrs[tileId]`).

export interface TileAttr {
  palette: number;
  vramBank: number;
  priority: boolean;
  xFlip: boolean;
  yFlip: boolean;
}

export const TileAttrs = {
  // Lua: TileAttrs.lua:15-41
  forTile(tileset: any, tileId: number): TileAttr {
    const attrs = tileset ? tileset.tileAttrs : undefined;
    if (attrs) {
      let a = attrs[tileId];
      if (a) return a;
      // Metatile bytes are often 0-95 with bank 1 in the attr nybble; pret
      // stores those attrs at $80+ on the PalMap
      // (RomExtractorGen2.readCrystalPalMap).
      if (tileId < 0x80) {
        a = attrs[0x80 + tileId];
        if (a && a.vramBank === 1) return a;
      }
    }
    const bankFromId = (tileId >= 0x80 && tileId < 0xe0) ? 1 : 0;
    const normId = tileId % 0x80;
    let slot: any = 1;
    if (tileset && tileset.tilePalettes) {
      const tp = tileset.tilePalettes;
      slot = tp[tileId] ?? (bankFromId === 1 ? tp[0x80 + normId] : undefined) ?? tp[normId] ?? 1;
      // Lua `a or (b and c) or d or 1`: a `false` from `bankFromId == 1` falls
      // through to the next arm exactly as `?? undefined` does here.
    }
    return {
      palette: slot,
      vramBank: bankFromId,
      priority: false,
      xFlip: false,
      yFlip: false,
    };
  },

  // Lua: TileAttrs.lua:43
  paletteSlot(tileset: any, tileId: number): number {
    return TileAttrs.forTile(tileset, tileId).palette;
  },

  // Lua: TileAttrs.lua:47-54 -- VRAM tile index in the baked 256-tile sheet
  // (Crystal bank 0 at 0-127, bank 1 at 128-255 per crystalTilesetSheet).
  sheetTileId(tileId: number, attr?: { vramBank?: number } | null): number {
    if (tileId >= 0x80) return tileId;
    if (attr && attr.vramBank === 1) return 0x80 + tileId;
    return tileId;
  },

  // Lua: TileAttrs.lua:56-69 quadFor, :71-78 quadSize and :80-93
  // drawFlippedTile: LÖVE quads and tile drawing, not ported (the voxel
  // renderer and the cook own tile pixels). `sheetTileId` above is the part
  // of quadFor that is logic: the sheet cell is (sheetId % tilesPerRow,
  // floor(sheetId / tilesPerRow)).
};

export default TileAttrs;
