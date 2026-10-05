// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). Effect 'silhouette': the shader at gen1recomp src/ui/game3/evolution_scene.lua:45, in JS.

import { glsl, registerEffect, type Rgba } from "../effects.ts";

registerEffect({
  name: "silhouette",
  pack: () => [],
  pixel: (t, c) => (t[3] < 0.05 ? undefined : [c[0], c[1], c[2], t[3] * c[3]]),
});
