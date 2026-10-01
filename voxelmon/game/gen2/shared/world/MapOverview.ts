// gen1recomp src/world/MapOverview.lua at bdfac727 (MIT).
//
// Generation-neutral minimap rasterization.  WorldAPI arms own semantic
// markers because object/event visibility differs; terrain and tile shading
// share one output contract.
//
// The tile shading reads the tileset sheet's pixels (Assets.imageData).
// Gold graphics here are cooked tile-id grids with no pixels, so that read
// takes the Lua's failed-pcall arm (no tile rows) unless the image handed
// back can answer getPixel; the terrain rows are unaffected.

import { Assets } from "../render/Assets.ts";
import { tostring } from "../../platform/lua.ts";

export interface MapMarker {
  kind: string;
  x: number;
  y: number;
}

export interface MapOverviewResult {
  mapId: string;
  width: number;
  height: number;
  rows: string[];
  markers: MapMarker[] | undefined;
  tileRows: string[] | undefined;
  tileWidth: number | undefined;
  tileHeight: number | undefined;
  tileDetailRows: string[] | undefined;
  tileDetailWidth: number | undefined;
  tileDetailHeight: number | undefined;
}

/** What an image needs for the shading pass (LÖVE ImageData's getPixel). */
interface PixelSource {
  getPixel(x: number, y: number): [number, number, number, number?];
}

interface ShadeCache {
  pixels: PixelSource;
  shades: Record<number, string[]>;
}

let overviewShades: Record<string, ShadeCache> = {};

// Lua: MapOverview.lua:10
Assets.register(() => {
  overviewShades = {};
});

// Lua: MapOverview.lua:12
function shadeDigit(sum: number, pixelCount: number): string {
  return tostring(Math.max(0, Math.min(3,
    Math.floor((1 - sum / pixelCount) * 3 + 0.5))));
}

// Lua: MapOverview.lua:17 -- returns a TUPLE [rows, detailRows], or
// undefined (the Lua's nil).
function tileRows(map: any): [string[], string[]] | undefined {
  const tileset = map.tileset;
  if (!(tileset && tileset.image && tileset.tilesPerRow)) return undefined;
  let cached = overviewShades[tileset.image];
  if (!cached) {
    // Lua: pcall(Assets.imageData, tileset.image) -- a sheet with no pixels
    // (every cooked Gold graphic) fails the same way a missing one does.
    let pixels: PixelSource | undefined;
    try {
      const img: any = Assets.imageData(tileset.image);
      pixels = img && typeof img.getPixel === "function" ? img as PixelSource : undefined;
    } catch {
      pixels = undefined;
    }
    if (!pixels) return undefined;
    cached = { pixels, shades: {} };
    overviewShades[tileset.image] = cached;
  }
  const rows: string[] = [];
  const detailRows: string[] = [];
  const perRow: number = tileset.tilesPerRow;
  for (let ty = 0; ty <= map.heightCells * 2 - 1; ty++) {
    const row: string[] = [];
    const detailTop: string[] = [];
    const detailBottom: string[] = [];
    for (let tx = 0; tx <= map.widthCells * 2 - 1; tx++) {
      const tile: number = map.tileAt(tx, ty);
      let shades = cached.shades[tile];
      if (shades == null) {
        const sums = [0, 0, 0, 0];
        const ox = (tile % perRow) * 8;
        const oy = Math.floor(tile / perRow) * 8;
        for (let py = 0; py <= 7; py++) {
          for (let px = 0; px <= 7; px++) {
            const [r, g, b] = cached.pixels.getPixel(ox + px, oy + py);
            const quadrant = Math.floor(py / 4) * 2 + Math.floor(px / 4);
            sums[quadrant] = sums[quadrant]! + r * 0.2126 + g * 0.7152 + b * 0.0722;
          }
        }
        shades = [
          shadeDigit(sums[0]! + sums[1]! + sums[2]! + sums[3]!, 64),
          shadeDigit(sums[0]!, 16), shadeDigit(sums[1]!, 16),
          shadeDigit(sums[2]!, 16), shadeDigit(sums[3]!, 16),
        ];
        cached.shades[tile] = shades;
      }
      row.push(shades[0]!);
      detailTop.push(shades[1]! + shades[2]!);
      detailBottom.push(shades[3]! + shades[4]!);
    }
    rows.push(row.join(""));
    detailRows.push(detailTop.join(""));
    detailRows.push(detailBottom.join(""));
  }
  return [rows, detailRows];
}

export const MapOverview = {
  // Lua: MapOverview.lua:62
  build(map: any, markers?: MapMarker[]): MapOverviewResult {
    const rows: string[] = [];
    for (let y = 0; y <= map.heightCells - 1; y++) {
      const row: string[] = [];
      for (let x = 0; x <= map.widthCells - 1; x++) {
        row.push(map.isWarpTileCell(x, y) ? "+"
          : map.isWaterCell(x, y) ? "~"
          : map.isWalkableCell(x, y) ? "." : " ");
      }
      rows.push(row.join(""));
    }
    const shaded = tileRows(map);
    const tiles = shaded ? shaded[0] : undefined;
    const detail = shaded ? shaded[1] : undefined;
    return {
      mapId: map.id, width: map.widthCells,
      height: map.heightCells, rows, markers,
      tileRows: tiles,
      tileWidth: tiles ? map.widthCells * 2 : undefined,
      tileHeight: tiles ? map.heightCells * 2 : undefined,
      tileDetailRows: detail,
      tileDetailWidth: detail ? map.widthCells * 4 : undefined,
      tileDetailHeight: detail ? map.heightCells * 4 : undefined,
    };
  },
};

export default MapOverview;
