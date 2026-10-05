// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). Effect 'g1_remap': the shader at gen1recomp src/core/game3/battle/anim_port/g1_sprite.lua:316, in JS.

import { glsl, registerEffect, type Rgba } from "../effects.ts";

// A CPU variant effect. Uniforms: blendColor, blendCoeff (unused by the shader), blendM, nRemap, remapSrc[16], remapDst[16].
registerEffect({
  name: "g1_remap",
  pixel: (t, c, _u, _v, _x, _y, _p, ctx) => {
    let rgb: number[] = [t[0], t[1], t[2]];
    const n = glsl.num(ctx.u.nRemap);
    const src = glsl.arr(ctx.u.remapSrc, 16), dst = glsl.arr(ctx.u.remapDst, 16);
    for (let i = 0; i < 16; i++) {
      if (i < n) {
        const s = src[i]!;
        if (Math.abs(rgb[0]! - s[0]!) < 0.01 && Math.abs(rgb[1]! - s[1]!) < 0.01 && Math.abs(rgb[2]! - s[2]!) < 0.01) rgb = dst[i]!;
      }
    }
    const m = glsl.num(ctx.u.blendM, 1), bc = glsl.vec(ctx.u.blendColor);
    rgb = rgb.map((v, i) => v * m + bc[i]!);
    return [rgb[0]! * c[0], rgb[1]! * c[1], rgb[2]! * c[2], t[3] * c[3]];
  },
});
