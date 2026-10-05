// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). Effect 'mix_target': the shader at gen1recomp src/ui/game3/hall_of_fame.lua:187 (and hall_of_fame_pc.lua:50), in JS.

import { glsl, registerEffect, type Rgba } from "../effects.ts";

// params: target r g b, coeff
registerEffect({
  name: "mix_target",
  pack: (u) => [...glsl.vec(u.target), glsl.num(u.coeff)],
  pixel: (t, c, _u, _v, _x, _y, p) => {
    const k = p[3]!;
    return [glsl.mix(t[0], p[0]!, k) * c[0], glsl.mix(t[1], p[1]!, k) * c[1], glsl.mix(t[2], p[2]!, k) * c[2], t[3] * c[3]];
  },
});
