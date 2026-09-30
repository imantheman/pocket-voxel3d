// MAP: the composed TOWN MAP page, the marker on the player (or on a place
// tapped), and the place's name along the bottom.
import { ROWS, TILE_H, regionPx, sprite, text } from "../draw.ts";
import { bottomBar, type GearCtx } from "../ui.ts";

export interface TownMapLoc {
  name: string;
  x: number;
  y: number;
}

// The page is the GB screen's own 20x18 tiles, blitted whole and scaled to
// fit between the bars with its aspect kept.
const MAP_W = 160;
const MAP_H = 144;
const MAP_INSET = 4;
const MAP_AREA_Y = Math.round(TILE_H) + MAP_INSET;
const MAP_AREA_H = Math.round((ROWS - 1) * TILE_H) - MAP_AREA_Y - MAP_INSET;
const MAP_SCALE = Math.min(320 / MAP_W, MAP_AREA_H / MAP_H);
const MAP_DRAW_W = Math.round(MAP_W * MAP_SCALE);
const MAP_DRAW_H = Math.round(MAP_H * MAP_SCALE);
const MAP_X = Math.round((320 - MAP_DRAW_W) / 2);
const MAP_Y = MAP_AREA_Y + Math.round((MAP_AREA_H - MAP_DRAW_H) / 2);

/** TownMapCoordsToOAMCoords: a location's cell is at (x*8+16, y*8+8). */
function locPixel(loc: TownMapLoc): { x: number; y: number } {
  return { x: loc.x * 8 + 16, y: loc.y * 8 + 8 };
}

function mapToScreen(px: number, py: number): { x: number; y: number } {
  return { x: MAP_X + Math.round(px * MAP_SCALE), y: MAP_Y + Math.round(py * MAP_SCALE) };
}

/** The bottom-screen pixel at the centre of a location's square. */
export function gearMapPoint(loc: TownMapLoc): { x: number; y: number } {
  const p = locPixel(loc);
  return mapToScreen(p.x + 4, p.y + 4);
}

function locations(game: any): Record<string, TownMapLoc> {
  return game.data.field?.townMap?.locations ?? {};
}

/**
 * One entry per SQUARE: most locations are interiors filed under their
 * town's square, so the survivor is the map named after the place, else the
 * lowest id (TownMap.lua's own dedupe).
 */
function places(game: any): { id: string; loc: TownMapLoc }[] {
  const bySquare = new Map<string, { id: string; loc: TownMapLoc }>();
  const locs = locations(game);
  for (const id of Object.keys(locs).sort()) {
    const loc = locs[id]!;
    const key = `${loc.x},${loc.y}`;
    const held = bySquare.get(key);
    if (!held || (held.id.replace(/_/g, " ") !== held.loc.name && id.replace(/_/g, " ") === loc.name)) {
      bySquare.set(key, { id, loc });
    }
  }
  return [...bySquare.values()];
}

function focused(game: any): { id: string; loc: TownMapLoc } | null {
  const locs = locations(game);
  const picked = game.gearMapPick;
  if (picked && locs[picked]) return { id: picked, loc: locs[picked]! };
  const here = game.overworld?.mapId ?? game.overworld?.map?.id;
  if (here && locs[here]) return { id: here, loc: locs[here]! };
  return null;
}

export function drawMap(ctx: GearCtx): void {
  const { host, game } = ctx;
  const focus = focused(game);
  bottomBar(ctx, focus?.loc.name ?? "TOWN MAP");
  const page = game.data.atlas?.townMapPage;
  if (typeof page !== "number" || page < 0) {
    text(host, 2, 4, "NO MAP DATA");
    return;
  }
  sprite(host, page, MAP_X, MAP_Y, MAP_DRAW_W, MAP_DRAW_H);
  const cursorPage = game.data.atlas?.townMapCursorPage;
  if (focus && typeof cursorPage === "number" && cursorPage >= 0) {
    const p = locPixel(focus.loc);
    const at = mapToScreen(p.x - 4, p.y - 4);
    const size = Math.round(16 * MAP_SCALE);
    sprite(host, cursorPage, at.x, at.y, size, size);
  }
  regionPx("map:area", MAP_X, MAP_Y, MAP_DRAW_W, MAP_DRAW_H, () => {});
}

/** A tap on the map: the nearest place within two cells, else back to the
 * player. */
export function mapTouch(game: any, x: number, y: number): void {
  if (!game.setGearMapPick) return;
  const px = (x - MAP_X) / MAP_SCALE;
  const py = (y - MAP_Y) / MAP_SCALE;
  if (px < 0 || py < 0 || px >= MAP_W || py >= MAP_H) return;
  let bestId: string | null = null;
  let bestD = Infinity;
  for (const { id, loc } of places(game)) {
    const p = locPixel(loc);
    const d = (p.x + 4 - px) ** 2 + (p.y + 4 - py) ** 2;
    if (d < bestD) { bestD = d; bestId = id; }
  }
  game.setGearMapPick(bestD <= 16 * 16 ? bestId : null);
}
