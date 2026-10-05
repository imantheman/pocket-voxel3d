// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). Effect 'level_flash': the shader at gen1recomp src/core/game3/battle/healthbox.lua:251, in JS.

import { glsl, registerEffect, type Rgba } from "../effects.ts";

// params: k1 r g b, k2 r g b, target r g b, coeff
registerEffect({
  name: "level_flash",
  pack: (u) => [...glsl.vec(u.k1), ...glsl.vec(u.k2), ...glsl.vec(u.target), glsl.num(u.coeff)],
  pixel: (t, c, _u, _v, _x, _y, p) => {
    const o: Rgba = [t[0] * c[0], t[1] * c[1], t[2] * c[2], t[3] * c[3]];
    const dist = (b: number) => Math.hypot(o[0] - p[b]!, o[1] - p[b + 1]!, o[2] - p[b + 2]!);
    if (dist(0) < 0.04 || dist(3) < 0.04) {
      const k = p[9]!;
      return [glsl.mix(o[0], p[6]!, k), glsl.mix(o[1], p[7]!, k), glsl.mix(o[2], p[8]!, k), o[3]];
    }
    return o;
  },
});
