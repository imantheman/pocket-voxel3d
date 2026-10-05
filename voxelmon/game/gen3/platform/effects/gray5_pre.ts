// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). Effect 'gray5_pre': the shader at gen1recomp src/core/game3/battle/ui.lua:1783, in JS.

import { glsl, registerEffect, type Rgba } from "../effects.ts";

function gray5(t: Rgba): number {
  return Math.floor((glsl.c5(t[0]) + glsl.c5(t[1]) + glsl.c5(t[2])) / 3) / 31;
}

// the vertex colour applies BEFORE
registerEffect({
  name: "gray5_pre",
  pack: () => [],
  pixel: (t, c) => { const m: Rgba = [t[0] * c[0], t[1] * c[1], t[2] * c[2], t[3] * c[3]]; const g = gray5(m); return [g, g, g, m[3]]; },
});
