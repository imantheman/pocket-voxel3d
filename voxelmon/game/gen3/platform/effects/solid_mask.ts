// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). Effect 'solid_mask': the shader at gen1recomp src/ui/game3/pokedex_chrome.lua:414, in JS.

import { glsl, registerEffect, type Rgba } from "../effects.ts";

registerEffect({
  name: "solid_mask",
  pack: () => [],
  pixel: (t, c) => (t[3] > 0 ? [c[0], c[1], c[2], c[3]] : [0, 0, 0, 0]),
});
