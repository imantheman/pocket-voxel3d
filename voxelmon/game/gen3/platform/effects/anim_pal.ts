// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). Effect 'anim_pal': the shader at gen1recomp src/core/game3/battle/anim_pal.lua:182, in JS.

import { ctxMemo, glsl, registerEffect, toByte, type Rgba } from "../effects.ts";

// A CPU variant effect. Uniforms: pal[16] (rgba). The texture's red channel holds the colour index.
registerEffect({
  name: "anim_pal",
  pixel: (t, c, _u, _v, _x, _y, _p, ctx) => {
    const pal = ctxMemo(ctx, "pal", () => glsl.arr(ctx.u.pal, 16, 4));
    const fi = Math.floor(t[0] * 15 + 0.5);
    let o = [0, 0, 0, 0];
    for (let k = 0; k < 16; k++) if (Math.abs(k - fi) < 0.5) o = pal[k]!;
    if (t[3] < 0.5) o = [0, 0, 0, 0];
    return [o[0]! * c[0], o[1]! * c[1], o[2]! * c[2], o[3]! * c[3]];
  },
  // pixel's arithmetic over the bytes, the vertex colour white: an entry of
  // the palette (or nothing) per pixel, written as setPixel writes it
  variant: (src, w, h, ctx) => {
    const pal = ctxMemo(ctx, "pal", () => glsl.arr(ctx.u.pal, 16, 4));
    const bytes: number[][] = [];
    for (let k = 0; k < 16; k++) {
      const o = pal[k]!;
      bytes[k] = [toByte(o[0]! * 1), toByte(o[1]! * 1), toByte(o[2]! * 1), toByte(o[3]! * 1)];
    }
    const out = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h * 4; i += 4) {
      if (src[i + 3]! / 255 < 0.5) continue; // [0, 0, 0, 0]
      const fi = Math.floor((src[i]! / 255) * 15 + 0.5);
      let b: number[] | undefined;
      for (let k = 0; k < 16; k++) if (Math.abs(k - fi) < 0.5) b = bytes[k];
      if (b) { out[i] = b[0]!; out[i + 1] = b[1]!; out[i + 2] = b[2]!; out[i + 3] = b[3]!; }
    }
    return out;
  },
});
