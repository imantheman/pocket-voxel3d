// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). Effect 'anim_pal': the shader at gen1recomp src/core/game3/battle/anim_pal.lua:182, in JS.

import { glsl, registerEffect, type Rgba } from "../effects.ts";

// A CPU variant effect. Uniforms: pal[16] (rgba). The texture's red channel holds the colour index.
registerEffect({
  name: "anim_pal",
  pixel: (t, c, _u, _v, _x, _y, _p, ctx) => {
    const pal = glsl.arr(ctx.u.pal, 16, 4);
    const fi = Math.floor(t[0] * 15 + 0.5);
    let o = [0, 0, 0, 0];
    for (let k = 0; k < 16; k++) if (Math.abs(k - fi) < 0.5) o = pal[k]!;
    if (t[3] < 0.5) o = [0, 0, 0, 0];
    return [o[0]! * c[0], o[1]! * c[1], o[2]! * c[2], o[3]! * c[3]];
  },
});
