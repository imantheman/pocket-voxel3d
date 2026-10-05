// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). Effect 'remap_nearest': the shader at gen1recomp src/core/game3/battle/anim_port/g2_pret.lua:817, in JS.

import { ctxMemo, glsl, registerEffect, type Rgba } from "../effects.ts";

// A CPU variant effect. Uniforms: src[16], dst[16].
registerEffect({
  name: "remap_nearest",
  pixel: (t, c, _u, _v, _x, _y, _p, ctx) => {
    let o: number[] = [t[0], t[1], t[2]];
    if (t[3] >= 0.01) {
      const src = ctxMemo(ctx, "src", () => glsl.arr(ctx.u.src, 16)), dst = ctxMemo(ctx, "dst", () => glsl.arr(ctx.u.dst, 16));
      let best = 1e9;
      for (let i = 1; i < 16; i++) {
        const d = [t[0] - src[i]![0]!, t[1] - src[i]![1]!, t[2] - src[i]![2]!];
        const e = d[0]! * d[0]! + d[1]! * d[1]! + d[2]! * d[2]!;
        if (e < best) { best = e; o = dst[i]!; }
      }
      if (best > 0.002) o = [t[0], t[1], t[2]];
    }
    return [o[0]! * c[0], o[1]! * c[1], o[2]! * c[2], t[3] * c[3]];
  },
});
