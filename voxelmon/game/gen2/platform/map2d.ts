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
// of day or the roof change), and a frame copies the 21x19 visible window
// out of them; sprites keep their sheet and palette per sprite and time of
// day.
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
const COLS = 21;
const ROWS = 19;

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

/** One map's screen tiles, worked out once. */
interface MapTiles {
  key: string;
  map: unknown;
  version: number;
  /** tile columns and rows (blocks x 4) */
  tw: number;
  th: number;
  ids: Uint16Array;
  pal: Uint8Array;
  /** the border block's 16 tiles, for the cells off the map */
  borderIds: Uint16Array;
  borderPal: Uint8Array;
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
  const tw = (map.width ?? 0) * 4;
  const th = (map.height ?? 0) * 4;
  const ids = new Uint16Array(tw * th);
  const pal = new Uint8Array(tw * th);
  for (let ty = 0; ty < th; ty++) {
    for (let tx = 0; tx < tw; tx++) {
      const tile = map.tileAt(tx, ty) ?? 0;
      ids[ty * tw + tx] = idOf(tile);
      pal[ty * tw + tx] = palOf(tile);
    }
  }
  // tileAt off the map reads the border block: its 4x4 tiles, once
  const borderIds = new Uint16Array(16);
  const borderPal = new Uint8Array(16);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const tile = map.tileAt(-4 + c, -4 + r) ?? 0;
      borderIds[r * 4 + c] = idOf(tile);
      borderPal[r * 4 + c] = palOf(tile);
    }
  }
  cached = { key, map, version: map.version ?? 0, tw, th, ids, pal, borderIds, borderPal };
  return cached;
}

const spriteCache = new Map<string, { sheet: LcdImage; colours: Palette4 | null } | null>();
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

  // the eight BG palettes, each matched to a screen slot once a frame
  const slots = [0, 0, 0, 0, 0, 0, 0, 0];
  for (let s = 0; s < 8; s++) {
    const p = bgSet?.[s] ?? bgSet?.[0];
    slots[s] = p ? lcd.palette(p) & 0xef : 0;
  }

  const cells = lcd.s.cells;
  const attrs = lcd.s.attrs;
  const tx0 = Math.floor(camX / 8);
  const ty0 = Math.floor(camY / 8);
  for (let r = 0; r < ROWS; r++) {
    const ty = ty0 + r;
    const inRow = ty >= 0 && ty < t.th;
    const base = ty * t.tw;
    const br = (((ty % 4) + 4) % 4) * 4;
    for (let c = 0; c < COLS; c++) {
      const tx = tx0 + c;
      const i = r * 32 + c;
      if (inRow && tx >= 0 && tx < t.tw) {
        cells[i] = t.ids[base + tx]!;
        attrs[i] = slots[t.pal[base + tx]!]!;
      } else {
        const b = br + (((tx % 4) + 4) % 4);
        cells[i] = t.borderIds[b]!;
        attrs[i] = slots[t.borderPal[b]!]!;
      }
    }
  }
  lcd.regs({ scx: camX & 7, scy: camY & 7 });

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
    const gfx = v.gfx ?? sprites[v.spriteId]?.image;
    const ck = `${gfx}|${v.spriteId}|${v.palette}|${daytime}`;
    let s = spriteCache.get(ck);
    if (s === undefined) {
      const sheet = image(gfx);
      if (sheet) {
        const def = sprites[v.spriteId] ?? { paletteId: v.palette };
        const colours = Palettes.spritePalette(world.palettes, daytime, def) as unknown as Palette4 | undefined;
        s = { sheet, colours: colours ?? null };
      } else {
        s = null;
      }
      spriteCache.set(ck, s);
    }
    if (!s) continue;
    const sheet = s.sheet;
    const pal = s.colours ? lcd.palette(s.colours, true) : 0;
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
