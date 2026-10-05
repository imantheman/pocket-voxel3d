// Port of gen1recomp src/ui/game3/hall_of_fame_gfx.lua (GPLv3 + additional terms; see LICENSE.md).
// The Hall of Fame's cached art: the striped background, the band overlay and
// the confetti sheet (pokefirered/src/hall_of_fame.c).

import { Extract } from "../../../import/gen3/extract_island1.ts";
import { Dataset } from "../core/dataset.ts";
import { G } from "../platform/graphics.ts";
import { newImageData, type Image, type Quad } from "../platform/image.ts";

export interface HofImage { image: Image; w: number; h: number; quads?: Record<number, Quad> }

const W = 240, H = 160;
let images: Record<string, HofImage> = {};

// Lua: hall_of_fame_gfx.lua:8
function image(name: string, w: number, h: number): HofImage | undefined {
  if (images[name]) return images[name];
  // `love and love.image and love.graphics and love.graphics.newImage`: always here
  const rel = (Extract.CACHE_ROOT || "data/generated/gba") + "/hall_of_fame/" + name + ".rgba";
  const bytes = Dataset.cache().read(rel);
  if (!(bytes && bytes.length === w * h * 4)) throw new Error("hall of fame art missing from the cache: " + rel);
  const img = G.newImage(newImageData(w, h, "rgba8", bytes));
  img.setFilter("nearest", "nearest");
  const entry: HofImage = { image: img, w, h };
  images[name] = entry;
  return entry;
}

export const HofGfx = {
  // pokefirered/src/hall_of_fame.c:1181
  // Lua: hall_of_fame_gfx.lua:22
  drawStripes(): void {
    const stripes = image("stripes", W, H);
    if (!stripes) return;
    G.setColor(1, 1, 1, 1);
    G.draw(stripes.image, 0, 0);
  },

  // pokefirered/src/hall_of_fame.c:333, :611
  // Lua: hall_of_fame_gfx.lua:30
  drawBands(eva: number, evb: number): void {
    const entry = image("bands", W, H);
    if (!entry) return;
    const bands = entry.image;
    const [mode, alphaMode] = G.getBlendMode();
    G.setColor(0, 0, 0, 1 - Math.min(16, evb) / 16);
    G.draw(bands, 0, 0);
    if (eva > 0) {
      const k = Math.min(16, eva) / 16;
      G.setBlendMode("add");
      G.setColor(k, k, k, 1);
      G.draw(bands, 0, 0);
    }
    G.setBlendMode(mode, alphaMode);
    G.setColor(1, 1, 1, 1);
  },

  // pokefirered/src/hall_of_fame.c:142, :169
  // Lua: hall_of_fame_gfx.lua:48
  confetti(): HofImage | undefined {
    const entry = image("confetti", 8, 8 * 17);
    if (entry && !entry.quads) {
      entry.quads = {};
      for (let f = 0; f <= 16; f++) {
        entry.quads[f] = G.newQuad(0, f * 8, 8, 8, entry.w, entry.h);
      }
    }
    return entry;
  },

  // Lua: hall_of_fame_gfx.lua:59
  reset(): void {
    images = {};
  },
};

export default HofGfx;
