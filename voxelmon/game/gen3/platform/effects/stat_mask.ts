// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). Effect 'stat_mask': the shader at gen1recomp src/core/game3/battle/ui.lua:1804, in JS.

import { glsl, registerEffect, type Rgba } from "../effects.ts";
import { Image } from "../image.ts";

// params: maskTex (texture id), origin x y, size w h, scroll x y, flip, eva, darken
registerEffect({
  name: "stat_mask",
  pack: (u) => {
    const m = u.maskTex instanceof Image ? u.maskTex : undefined;
    m?.sync();
    return [m ? m.id : 0, ...glsl.vec(u.origin, 2), ...glsl.vec(u.size, 2), ...glsl.vec(u.scroll, 2),
      glsl.num(u.flip), glsl.num(u.eva), glsl.num(u.darken)];
  },
  pixel: (t, _c, tu, tv, _x, _y, p, ctx) => {
    if (t[3] < 0.01) return undefined;
    const tx = p[9]! > 0.5 ? 1 - tu : tu;
    const px = Math.floor(p[1]! + tx * p[3]!), py = Math.floor(p[2]! + tv * p[4]!);
    const k = ctx.sample ? ctx.sample(p[0]!, (px + p[5]! + 0.5) / 256, (py + p[6]! + 0.5) / 256) : ([0, 0, 0, 0] as Rgba);
    if (k[3] < 0.01) return undefined;
    if (p[11]! > 0.5) return [0, 0, 0, p[10]!];
    return [k[0], k[1], k[2], p[10]!];
  },
});
