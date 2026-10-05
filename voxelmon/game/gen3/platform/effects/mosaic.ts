// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). Effect 'mosaic': the shader at gen1recomp src/core/game3/battle/ui.lua:1876, in JS.

import { glsl, registerEffect, type Rgba } from "../effects.ts";

// params: texSize w h, block
registerEffect({
  name: "mosaic",
  pack: (u) => [...glsl.vec(u.texSize, 2), glsl.num(u.block, 1)],
  pixel: (t, c, tu, tv, _x, _y, p, ctx) => {
    const [w, h, b] = p as [number, number, number];
    const px = Math.floor(tu * w / b) * b, py = Math.floor(tv * h / b) * b;
    const s = ctx.self ? ctx.self((px + 0.5) / w, (py + 0.5) / h) : t;
    return [s[0] * c[0], s[1] * c[1], s[2] * c[2], s[3] * c[3]];
  },
});
