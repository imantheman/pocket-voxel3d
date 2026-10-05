// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). Effect 'region_map': the shader at gen1recomp src/ui/game3/region_map_gpu.lua:138, in JS.

import { glsl, registerEffect, type Rgba } from "../effects.ts";

// params: tintOn, tone r g b, fadeY, fx, amt
registerEffect({
  name: "region_map",
  pack: (u) => [glsl.num(u.tintOn), ...glsl.vec(u.tone), glsl.num(u.fadeY), glsl.num(u.fx), glsl.num(u.amt)],
  pixel: (t, col, _u, _v, _x, _y, p) => {
    const [tintOn, tr, tg, tb, fadeY, fx, amt] = p as [number, number, number, number, number, number, number];
    let c = [glsl.c5(t[0] * col[0]), glsl.c5(t[1] * col[1]), glsl.c5(t[2] * col[2])];
    if (tintOn > 0.5) {
      const gray = Math.floor((c[0]! * 76 + c[1]! * 151 + c[2]! * 29) / 256);
      c = [tr, tg, tb].map((k) => Math.min(Math.floor(k * gray / 256), 31));
    }
    if (fadeY > 0) c = c.map((v) => v + Math.floor((0 - v) * fadeY / 16));
    if (fx > 2.5) c = c.map((v) => v - Math.floor(v * amt / 16));
    else if (fx > 1.5) c = c.map((v) => v + Math.floor((31 - v) * amt / 16));
    return [c[0]! / 31, c[1]! / 31, c[2]! / 31, t[3] * col[3]];
  },
});
