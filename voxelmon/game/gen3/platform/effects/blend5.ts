// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). Effect 'blend5': the shader at gen1recomp src/core/game3/battle/anim_vm.lua:568 (and anim_port/g2_pret.lua:768), in JS.

import { glsl, registerEffect, type Rgba } from "../effects.ts";

function blend5(t: Rgba, p: number[]): [number, number, number] {
  const k = p[0]!;
  return [0, 1, 2].map((i) => { const v = glsl.c5(t[i]!); return (v + Math.floor((p[i + 1]! - v) * k / 16)) / 31; }) as [number, number, number];
}

// params: coeff, target r g b (0..31); the vertex colour applies AFTER
registerEffect({
  name: "blend5",
  pack: (u) => [glsl.num(u.coeff), ...glsl.vec(u.target)],
  pixel: (t, c, _u, _v, _x, _y, p) => {
    const o = blend5(t, p);
    return [o[0] * c[0], o[1] * c[1], o[2] * c[2], t[3] * c[3]];
  },
});
