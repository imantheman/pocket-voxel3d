// Gold's 2D view (the OPTION screen's VIEW 2D): the overworld drawn on the
// Gold screen itself, the way the cart draws it, instead of as the voxel
// world under it -- the map's tiles in their PalMap palettes for the time of
// day, the people as OBJ sprites, and everything the screens draw (text
// boxes, menus) over them as before.
//
// What the cart's renderer kept and the voxel port dropped (World's baked map
// canvas) comes back from the same sources the bake read: Map.tileAt for each
// 8px tile (border included), the tileset image and its roof (atlasFor), and
// the palette set the map's environment loads (World.bgSets).
// Not yet: animated tiles (water, flowers) stand still, and the grass does
// not cover a sprite's feet.

import { Assets } from "../shared/render/Assets.ts";
import { Palettes } from "../world/Palettes.ts";
import { currentLcd, type LcdImage } from "./screen.ts";
import type { Palette4 } from "./lcd.ts";

/** pokegold LoadMapGroupRoof: nine roof tiles over vTiles2 tile $0a. */
const ROOF_FIRST = 0x0a;
const ROOF_COUNT = 9;
const COLS = 21;
const ROWS = 19;

function image(path: string | undefined): LcdImage | null {
  if (!path) return null;
  try {
    return (Assets.image(path) as LcdImage) ?? null;
  } catch {
    return null;
  }
}

/** Draw the 2D overworld for this frame; false when there is nothing to draw. */
export function drawMap2D(world: any, data: any): boolean {
  const lcd = currentLcd();
  const map = world?.map;
  if (!lcd || !map || typeof world.viewState !== "function") return false;
  const vs = world.viewState();
  if (vs.ready === false) return false;
  const [atlas, tileset] = world.atlasFor(map.def);
  const img = image(atlas?.image);
  if (!img || !tileset) return false;
  const roof = image(atlas.roofImage);
  const bgSet = world.bgSets?.[world.mapCacheKey(map.id)] as Palette4[] | undefined;
  const camX = Math.floor(vs.camera?.x ?? world.camera?.x ?? 0);
  const camY = Math.floor(vs.camera?.y ?? world.camera?.y ?? 0);

  // the eight BG palettes, each matched to a screen slot once
  const slotOf: number[] = [];
  const slot = (s: number): number => {
    let v = slotOf[s];
    if (v === undefined) {
      const pal = bgSet?.[s] ?? bgSet?.[0];
      v = pal ? lcd.palette(pal) : 0;
      slotOf[s] = v;
    }
    return v;
  };

  const cells = lcd.s.cells;
  const attrs = lcd.s.attrs;
  const tilePal: number[] = tileset.tilePalettes ?? [];
  const tx0 = Math.floor(camX / 8);
  const ty0 = Math.floor(camY / 8);
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const tile = map.tileAt(tx0 + c, ty0 + r) ?? 0;
      const id = roof && tile >= ROOF_FIRST && tile < ROOF_FIRST + ROOF_COUNT
        ? roof.ids[tile - ROOF_FIRST]
        : img.ids[tile];
      const i = r * 32 + c;
      cells[i] = (id ?? 0) & 0xffff;
      attrs[i] = slot(((tilePal[tile] ?? 1) - 1) & 7) & 0xef;
    }
  }
  lcd.regs({ scx: camX & 7, scy: camY & 7 });

  // The people: OBJ sprites, the Y-sorted list's later entries on top (the
  // screen draws a lower object index over a higher one, so they go in from
  // the top of the list down).
  const actors: any[] = vs.actors ?? [];
  const sprites = data?.sprites ?? {};
  for (let k = actors.length - 1; k >= 0; k--) {
    const e = actors[k];
    const v = e?.view;
    if (!v || v.visible === false || vs.hideAll) continue;
    const sheet = image(v.gfx ?? sprites[v.spriteId]?.image);
    if (!sheet) continue;
    const def = sprites[v.spriteId] ?? { paletteId: v.palette };
    const colours = Palettes.spritePalette(world.palettes, world.daytime ?? "DAY", def);
    const pal = colours ? lcd.palette(colours as unknown as Palette4, true) : 0;
    const frames = Math.max(1, Math.floor(sheet.th / 2));
    const f = Math.min(frames - 1, Math.max(0, v.frame ?? 0));
    const x0 = Math.round(v.px + (e.ox ?? 0) - camX);
    const y0 = Math.round(v.py + (e.oy ?? 0) - camY);
    const mirror = !!v.mirror;
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 2; c++) {
        const id = sheet.ids[(f * 2 + r) * sheet.tw + c];
        if (id === undefined) continue;
        const x = x0 + (mirror ? (1 - c) * 8 : c * 8);
        lcd.obj(x, y0 + r * 8, id, pal | (mirror ? 0x20 : 0));
      }
    }
  }
  return true;
}
