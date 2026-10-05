// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). Effect 'screen_fx': the shader at gen1recomp src/core/game3/battle/anim.lua:44, in JS.

import { glsl, registerEffect, type Rgba } from "../effects.ts";

// params: effectType, coeff, targetColor r g b
registerEffect({
  name: "screen_fx",
  pack: (u) => [glsl.num(u.effectType), glsl.num(u.coeff), ...glsl.vec(u.targetColor)],
  pixel: (t, col, _u, _v, _x, _y, p) => {
    const c: Rgba = [t[0] * col[0], t[1] * col[1], t[2] * col[2], t[3] * col[3]];
    const type = p[0]!, k = p[1]!;
    const mixTo = (r: number, g: number, b: number): Rgba => [glsl.mix(c[0], r, k), glsl.mix(c[1], g, k), glsl.mix(c[2], b, k), c[3]];
    if (type === 1) return [1 - c[0], 1 - c[1], 1 - c[2], c[3]];
    if (type === 2) return mixTo(1, 1, 1);
    if (type === 3) return mixTo(0, 0, 0);
    if (type === 4) { const l = c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114; return mixTo(l, l, l); }
    if (type === 5) return mixTo(p[2]!, p[3]!, p[4]!);
    return c;
  },
});
