// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). Effect 'gray_luma': the shader at gen1recomp src/ui/game3/quest_log.lua:61, in JS.

import { glsl, registerEffect, type Rgba } from "../effects.ts";

registerEffect({
  name: "gray_luma",
  pack: () => [],
  pixel: (t, c) => {
    const r = t[0] * c[0], g = t[1] * c[1], b = t[2] * c[2];
    const y = r * 0.299 + g * 0.587 + b * 0.114;
    return [y, y, y, t[3] * c[3]];
  },
});
