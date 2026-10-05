// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). Effect 'gray5': the shader at gen1recomp src/core/game3/battle/anim_port/g2_pret.lua:808, in JS.

import { glsl, registerEffect, type Rgba } from "../effects.ts";

function gray5(t: Rgba): number {
  return Math.floor((glsl.c5(t[0]) + glsl.c5(t[1]) + glsl.c5(t[2])) / 3) / 31;
}

// the vertex colour applies AFTER
registerEffect({
  name: "gray5",
  pack: () => [],
  pixel: (t, c) => { const g = gray5(t); return [g * c[0], g * c[1], g * c[2], t[3] * c[3]]; },
});
