// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). Effect 'mask_write': the shader at gen1recomp src/core/game3/battle/anim_port/g3_pret.lua:1383, in JS.

import { glsl, registerEffect, type Rgba } from "../effects.ts";

// params: value
registerEffect({
  name: "mask_write",
  pack: (u) => [glsl.num(u.value)],
  pixel: (t, _c, _u, _v, _x, _y, p) => (t[3] < 0.01 ? undefined : [p[0]!, 0, 0, 1]),
});
