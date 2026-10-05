// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). Effect 'affine_color': the shader at gen1recomp src/core/game3/battle/ui.lua:1903, in JS.

import { glsl, registerEffect, type Rgba } from "../effects.ts";

// params: m, off r g b
registerEffect({
  name: "affine_color",
  pack: (u) => [glsl.num(u.m, 1), ...glsl.vec(u.off)],
  pixel: (t, c, _u, _v, _x, _y, p) => [
    glsl.clamp(t[0] * c[0] * p[0]! + p[1]!), glsl.clamp(t[1] * c[1] * p[0]! + p[2]!), glsl.clamp(t[2] * c[2] * p[0]! + p[3]!), t[3] * c[3],
  ],
});
