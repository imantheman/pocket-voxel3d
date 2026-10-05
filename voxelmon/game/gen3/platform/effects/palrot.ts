// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). Effect 'palrot': the shader at gen1recomp src/core/game3/battle/anim_port/g2_pret.lua:779, in JS.

import { glsl, registerEffect, type Rgba } from "../effects.ts";

// A CPU variant effect (a 16-colour array uniform). Uniforms: rot, lo, hi, count, cols[16].
registerEffect({
  name: "palrot",
  pixel: (t, c, _u, _v, _x, _y, _p, ctx) => {
    const mul = (o: number[]): Rgba => [o[0]! * c[0], o[1]! * c[1], o[2]! * c[2], t[3] * c[3]];
    if (t[3] < 0.01) return mul(t);
    const rot = glsl.num(ctx.u.rot), lo = glsl.num(ctx.u.lo), hi = glsl.num(ctx.u.hi), count = glsl.num(ctx.u.count);
    const cols = glsl.arr(ctx.u.cols, 16);
    let best = 1e9, bi = -1;
    for (let i = 1; i < 16; i++) {
      if (i >= lo && i <= hi) {
        const d = [t[0] - cols[i]![0]!, t[1] - cols[i]![1]!, t[2] - cols[i]![2]!];
        const e = d[0]! * d[0]! + d[1]! * d[1]! + d[2]! * d[2]!;
        if (e < best) { best = e; bi = i; }
      }
    }
    if (bi < 0 || best > 0.002) return mul(t);
    const x = bi - lo - rot;
    const src = x - count * Math.floor(x / count) + lo; // GLSL mod
    let o: number[] = [t[0], t[1], t[2]];
    for (let j = 1; j < 16; j++) if (j === src) o = cols[j]!;
    return mul(o);
  },
});
