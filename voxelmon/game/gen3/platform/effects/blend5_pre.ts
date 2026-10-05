// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). Effect 'blend5_pre': the shader at gen1recomp src/core/game3/battle/ball_open.lua:519, in JS.

import { glsl, registerEffect, type Rgba } from "../effects.ts";

function blend5(t: Rgba, p: number[]): [number, number, number] {
  const k = p[0]!;
  return [0, 1, 2].map((i) => { const v = glsl.c5(t[i]!); return (v + Math.floor((p[i + 1]! - v) * k / 16)) / 31; }) as [number, number, number];
}

// params: coeff, target r g b (0..31); the vertex colour applies BEFORE
registerEffect({
  name: "blend5_pre",
  pack: (u) => [glsl.num(u.coeff), ...glsl.vec(u.target)],
  pixel: (t, c, _u, _v, _x, _y, p) => {
    const m: Rgba = [t[0] * c[0], t[1] * c[1], t[2] * c[2], t[3] * c[3]];
    const o = blend5(m, p);
    return [o[0], o[1], o[2], m[3]];
  },
});
