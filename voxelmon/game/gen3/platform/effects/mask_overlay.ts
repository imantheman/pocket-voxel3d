// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). Effect 'mask_overlay': the shader at gen1recomp src/core/game3/battle/anim_port/g3_pret.lua:1391, in JS.

import { glsl, registerEffect, type Rgba } from "../effects.ts";

// params: fx r g b, amount (the texture's red channel is the mask)
registerEffect({
  name: "mask_overlay",
  pack: (u) => [...glsl.vec(u.fx), glsl.num(u.amount)],
  pixel: (t, _c, _u, _v, _x, _y, p) => [p[0]!, p[1]!, p[2]!, p[3]! * t[0]],
});
