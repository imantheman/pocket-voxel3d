// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). Effect 'tint_alpha': the shader at gen1recomp src/core/game3/mon_anim.lua:3480, in JS.

import { glsl, registerEffect, type Rgba } from "../effects.ts";

registerEffect({
  name: "tint_alpha",
  pack: () => [],
  pixel: (t, c) => [c[0], c[1], c[2], t[3] * c[3]],
});
