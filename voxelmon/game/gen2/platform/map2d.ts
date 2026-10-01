// Gold's 2D view (the OPTION screen's VIEW 2D): the overworld drawn on the
// Gold screen itself, the way the cart draws it, instead of as the voxel
// world under it -- the map's tiles in their PalMap palettes for the time of
// day, the people as OBJ sprites, and everything the screens draw (text
// boxes, menus) over them as before.
//
// What the cart's renderer kept and the voxel port dropped (World's baked map
// canvas) comes back from the same sources the bake read: Map.tileAt for each
// 8px tile, the tileset image and its roof (atlasFor), and the palette set
// the map's environment loads (World.bgSets).
//
// Cheap per frame, which is the point: a map's screen tile ids and palette
// slots are worked out once (again only when the map, its blocks, the time
// of day or the roof change) and sent to the core once as the screen's
// UNDER layer (lcd.ts under, lcd.rs), which the background's holes show at
// the camera -- so a frame sends a position, and the text boxes and menus
// drawn over it are the only cells. (Copying the window into the cells each
// frame meant every 8 px of walking re-sent the whole screen.) Sprites keep
// their sheet and palette per sprite and time of day.
// Not yet: animated tiles (water, flowers) stand still, tall grass does not
// cover a sprite's feet, and past the map's edge the border block shows
// where the cart would show the connected map.

import { Assets } from "../shared/render/Assets.ts";
import { Palettes } from "../world/Palettes.ts";
import { peopleView_W6 } from "../world/World.ts";
import { currentLcd, type LcdImage } from "./screen.ts";
import type { Palette4 } from "./lcd.ts";

/** pokegold LoadMapGroupRoof: nine roof tiles over vTiles2 tile $0a. */
const ROOF_FIRST = 0x0a;
const ROOF_COUNT = 9;
/** Border tiles kept round a map's grid: the camera never sees further off. */
const PAD = 12;

const images = new Map<string, LcdImage | null>();
function image(path: string | undefined): LcdImage | null {
  if (!path) return null;
  let img = images.get(path);
  if (img === undefined) {
    try {
      img = (Assets.image(path) as LcdImage) ?? null;
    } catch {
      img = null;
    }
    images.set(path, img);
  }
  return img;
}

/** One map's screen tiles, worked out once, with PAD tiles of border round them. */
interface MapTiles {
  key: string;
  map: unknown;
  version: number;
  /** padded columns and rows: (blocks x 4) + 2 * PAD */
  pw: number;
  ph: number;
  ids: Uint16Array;
  pal: Uint8Array;
}

let cached: MapTiles | null = null;

function tilesFor(world: any, map: any, key: string): MapTiles | null {
  if (cached && cached.key === key && cached.map === map && cached.version === (map.version ?? 0)) return cached;
  const [atlas, tileset] = world.atlasFor(map.def);
  const img = image(atlas?.image);
  if (!img || !tileset) return null;
  const roof = image(atlas.roofImage);
  const tilePal: number[] = tileset.tilePalettes ?? [];
  const idOf = (tile: number): number =>
    ((roof && tile >= ROOF_FIRST && tile < ROOF_FIRST + ROOF_COUNT ? roof.ids[tile - ROOF_FIRST] : img.ids[tile]) ?? 0) & 0xffff;
  const palOf = (tile: number): number => ((tilePal[tile] ?? 1) - 1) & 7;
  // tileAt reads the border block off the map, so the margin fills itself
  const pw = (map.width ?? 0) * 4 + 2 * PAD;
  const ph = (map.height ?? 0) * 4 + 2 * PAD;
  const ids = new Uint16Array(pw * ph);
  const pal = new Uint8Array(pw * ph);
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      const tile = map.tileAt(x - PAD, y - PAD) ?? 0;
      ids[y * pw + x] = idOf(tile);
      pal[y * pw + x] = palOf(tile);
    }
  }
  cached = { key, map, version: map.version ?? 0, pw, ph, ids, pal };
  return cached;
}

// per sheet path: the sheet, and its palette per OBJ palette id and time of day
const spriteCache = new Map<string, { sheet: LcdImage | null; pals: Map<string, Palette4 | null> }>();
const actors: any[] = [];

/** Draw the 2D overworld for this frame; false when there is nothing to draw. */
export function drawMap2D(world: any, data: any): boolean {
  const lcd = currentLcd();
  const map = world?.map;
  if (!lcd || !map || typeof world.updateView !== "function") return false;
  world.updateView();
  const key = world.mapCacheKey(map.id);
  const t = tilesFor(world, map, key);
  if (!t) return false;
  const bgSet = world.bgSets?.[key] as Palette4[] | undefined;
  const camX = Math.floor(world.camera?.x ?? 0);
  const camY = Math.floor(world.camera?.y ?? 0);

  // the eight BG palettes in screen slots 0-7, so the grid's palette bytes
  // ARE the attribute bytes (drawn first in the frame, nothing holds a slot yet)
  for (let s = 0; s < 8; s++) {
    const p = bgSet?.[s] ?? bgSet?.[0];
    if (p) lcd.setPalette(s, p);
  }

  // the map: the under layer (sent once per cache), at the camera
  lcd.under(t, t.ids, t.pal, t.pw, t.ph);
  lcd.underAt(camX + PAD * 8, camY + PAD * 8);

  // The people, from the same list the voxel view stands up (World's
  // peopleView): OBJ sprites, the Y-sorted list's later entries on top (a
  // lower object index draws over a higher one, so they go in top-down).
  actors.length = 0;
  if (!world.peopleHidden) {
    const [hideAll, hidePlayer] = world.flyHides?.() ?? [false, false];
    peopleView_W6(world, actors, hideAll, hidePlayer, false);
  }
  const sprites = data?.sprites ?? {};
  const daytime = world.daytime ?? "DAY";
  for (let k = actors.length - 1; k >= 0; k--) {
    const e = actors[k];
    const v = e?.view;
    if (!v || v.visible === false) continue;
    const gfx: string | undefined = v.gfx ?? sprites[v.spriteId]?.image;
    if (!gfx) continue;
    let s = spriteCache.get(gfx);
    if (!s) {
      s = { sheet: image(gfx), pals: new Map() };
      spriteCache.set(gfx, s);
    }
    const sheet = s.sheet;
    if (!sheet) continue;
    const pk = daytime + (v.palette ?? sprites[v.spriteId]?.paletteId ?? "");
    let colours = s.pals.get(pk);
    if (colours === undefined) {
      const def = sprites[v.spriteId] ?? { paletteId: v.palette };
      colours = (Palettes.spritePalette(world.palettes, daytime, def) as unknown as Palette4 | undefined) ?? null;
      s.pals.set(pk, colours);
    }
    const pal = colours ? lcd.palette(colours, true) : 0;
    const frames = Math.max(1, sheet.th >> 1);
    const f = Math.min(frames - 1, Math.max(0, v.frame ?? 0));
    const x0 = Math.round(v.px + (e.ox ?? 0) - camX);
    const y0 = Math.round(v.py + (e.oy ?? 0) - camY);
    const mirror = !!v.mirror;
    const flip = mirror ? 0x20 : 0;
    for (let r = 0; r < 2; r++) {
      const row = (f * 2 + r) * sheet.tw;
      const y = y0 + r * 8;
      const a = sheet.ids[row];
      const b = sheet.ids[row + 1];
      if (a !== undefined) lcd.obj(mirror ? x0 + 8 : x0, y, a, pal | flip);
      if (b !== undefined) lcd.obj(mirror ? x0 : x0 + 8, y, b, pal | flip);
    }
  }
  return true;
}
