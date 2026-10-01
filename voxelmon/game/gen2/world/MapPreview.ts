// gen1recomp src/world/gen2/MapPreview.lua at bdfac727 (MIT).
//
// Bake a Gen 2 map canvas without a World instance -- in the Lua, for the
// save editor's map tab (no engine module calls it).  The bake itself is
// tile-canvas drawing (PixelCanvas, love.image roof overlay, quads), which
// the voxel world replaces, so it is dropped here.  What remains:
//   - baker(data): the tables a bake reads (tilesets, roofs, palettes) and
//     its caches, exactly as the Lua gathers them;
//   - atlasFor(baker, mapDef): which tileset and roof a map's atlas is built
//     from, as gfx KEYS (the Lua built the image) plus the cache key;
//   - bake/imageFor/renderer keep their names and caching, and answer "no
//     image" (the Lua's own answer when love.graphics has no canvas).

import { Assets } from "../shared/render/Assets.ts";
import { loadGenerated } from "../platform/data.ts";

// Lua: MapPreview.lua:16 -- home/map.asm:1739-1748 LoadTilesetGFX
const ROOF_TILESETS: Record<string, boolean> = {
  TILESET_JOHTO: true,
  TILESET_JOHTO_MODERN: true,
};

/** What the Lua's atlas image was built from (gfx keys, not pixels). */
export interface PreviewAtlas {
  /** atlasCache key: the tileset name, plus "|roof" when a roof applies. */
  cacheKey: string;
  /** The tileset sheet's gfx key. */
  image: string;
  /** The roof sheet's gfx key whose nine tiles overlay tiles $0a-$12. */
  roofImage?: string;
  tilesPerRow: number;
}

export interface PreviewBaker {
  tilesets: Record<string, any>;
  roofs: any;
  palettes: any;
  atlasCache: Record<string, PreviewAtlas>;
  mapImages: Record<string, unknown>;
}

// Lua: MapPreview.lua:21-39 applyRoofOverlay: pixel copy into the atlas
// ImageData (drawing), replaced by PreviewAtlas.roofImage.

// Lua: MapPreview.lua:41
function optionalTable(data: any, gen2Key: string, plainKey: string, generated: string): any {
  if (data[gen2Key]) return data[gen2Key];
  if (data[plainKey]) return data[plainKey];
  // Lua: pcall(require, "data.generated." .. generated)
  const mod = loadGenerated(generated);
  if (mod != null && typeof mod === "object") return mod;
  return undefined;
}

export const MapPreview = {
  // Lua: MapPreview.lua:49
  baker(data?: any): PreviewBaker {
    data = data || {};
    return {
      tilesets: data.gen2Tilesets || data.tilesets || {},
      // Data:load does not pull roofs.lua; the Gold cache still has it.
      roofs: optionalTable(data, "gen2Roofs", "roofs", "roofs"),
      palettes: optionalTable(data, "gen2Palettes", "palettes", "palettes"),
      atlasCache: {},
      mapImages: {},
    };
  },

  // Lua: MapPreview.lua:61 -- returns a TUPLE [atlas, tileset] (the Lua's two
  // values); atlas is a PreviewAtlas of keys instead of an image.
  atlasFor(baker: PreviewBaker | null | undefined, mapDef: any): [PreviewAtlas | undefined, any] {
    if (!(baker && mapDef)) return [undefined, undefined];
    const tileset = baker.tilesets ? baker.tilesets[mapDef.tileset] : undefined;
    if (!tileset) return [undefined, undefined];
    let cacheKey: string = mapDef.tileset;
    let roofName: string | undefined;
    const roofs = baker.roofs;
    if (ROOF_TILESETS[mapDef.tileset]) {
      roofName = roofs && roofs.mapGroupRoofs ? roofs.mapGroupRoofs[mapDef.group] : undefined;
    }
    if (roofName) cacheKey = cacheKey + "|" + roofName;
    const cached = baker.atlasCache[cacheKey];
    if (cached) return [cached, tileset];

    const tilesPerRow: number = tileset.tilesPerRow ?? 16;
    let atlas: PreviewAtlas | undefined;
    const roofSpec = roofName && roofs && roofs.roofs ? roofs.roofs[roofName] : undefined;
    // Lua: the overlay also needs love.image; the pixel copy is drawing, so
    // the atlas records both keys instead.
    if (roofSpec && roofSpec.image && tileset.image && Assets.exists(tileset.image)) {
      atlas = { cacheKey, image: tileset.image, roofImage: roofSpec.image, tilesPerRow };
    }
    if (!atlas) {
      if (!tileset.image) return [undefined, tileset];
      // Lua: pcall(Assets.image, tileset.image) -- a missing sheet fails it
      if (!Assets.exists(tileset.image)) return [undefined, tileset];
      atlas = { cacheKey, image: tileset.image, tilesPerRow };
    }
    baker.atlasCache[cacheKey] = atlas;
    return [atlas, tileset];
  },

  // Lua: MapPreview.lua:95-178 bake: tile-canvas drawing (PixelCanvas,
  // bgSet-tinted blits), replaced by the voxel world.  Answers "no image",
  // the Lua's own answer when love.graphics.newCanvas is unavailable.
  bake(_baker?: PreviewBaker, _map?: any, _daytime?: string): undefined {
    return undefined;
  },

  // Lua: MapPreview.lua:180 -- the per-map cache around bake (false = tried).
  imageFor(baker: PreviewBaker | null | undefined, map: any): unknown {
    if (!(baker && map && map.id)) return undefined;
    const cached = baker.mapImages[map.id];
    if (cached) return cached;
    const img = MapPreview.bake(baker, map, "DAY");
    baker.mapImages[map.id] = img || false;
    return img;
  },

  // Lua: MapPreview.lua:189 -- a { draw(camX, camY) } around imageFor; its
  // draw is drawing, and with no baked image the Lua returns nil too.
  renderer(baker: PreviewBaker | null | undefined, map: any): undefined {
    const img = MapPreview.imageFor(baker, map);
    if (!img) return undefined;
    return undefined;
  },
};

export default MapPreview;
