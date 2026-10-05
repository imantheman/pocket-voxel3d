// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). Effect 'gba_fx': the shader at gen1recomp src/core/game3/gba_fx.lua:3, in JS.

import { glsl, registerEffect, type Rgba } from "../effects.ts";
import { Image } from "../image.ts";

// params: fadeY, fadeColor r g b, gray, bldy, mode, k, bandOn, bandY,
//         winTex (texture id, 0 = winOn off), winRect x y w h, winBldy -- 16
registerEffect({
  name: "gba_fx",
  pack: (u) => {
    const win = glsl.num(u.winOn) > 0.5 && u.winTex instanceof Image ? u.winTex : undefined;
    win?.sync();
    const fc = glsl.vec(u.fadeColor);
    return [glsl.num(u.fadeY), fc[0]!, fc[1]!, fc[2]!, glsl.num(u.gray), glsl.num(u.bldy), glsl.num(u.mode), glsl.num(u.k, 1),
      glsl.num(u.bandOn), glsl.num(u.bandY), win ? win.id : 0, ...(win ? glsl.vec(u.winRect, 4) : [0, 0, 1, 1]), glsl.num(u.winBldy)].slice(0, 16);
  },
  pixel: (t, col, _u, _v, sx, sy, p, ctx) => {
    if (t[3] < 0.5) return undefined;
    let c = [glsl.c5(t[0]), glsl.c5(t[1]), glsl.c5(t[2])];
    if (p[4]! > 0.5) {
      let g = Math.min(Math.floor((c[0]! * 76 + c[1]! * 151 + c[2]! * 29) / 256), 31);
      if (g >= 30) g = 31; else if (g >= 25) g = 27; else if (g >= 20) g = 21;
      else if (g >= 15) g = 16; else if (g >= 10) g = 11; else if (g >= 5) g = 5; else g = 0;
      c = [g, g, g];
    }
    const fadeY = p[0]!;
    c = c.map((v, i) => v + Math.floor((p[1 + i]! - v) * fadeY / 16));
    let b = p[5]!;
    if (p[8]! > 0.5) {
      const d = Math.abs(Math.floor(sy + 0.5) - p[9]!); // sc is the pixel centre
      b = d <= 15 ? 15 - d : 0;
    }
    if (p[10]! > 0) {
      const wx = (sx + 0.5 - p[11]!) / p[13]!, wy = (sy + 0.5 - p[12]!) / p[14]!;
      if (wx >= 0 && wy >= 0 && wx < 1 && wy < 1 && ctx.sample && ctx.sample(p[10]!, wx, wy)[3] > 0.5) b = p[15]!;
    }
    c = c.map((v) => v + Math.floor((31 - v) * b / 16));
    const mode = p[6]!, k = p[7]!;
    if (mode > 1.5) return [c[0]! / 31 * k, c[1]! / 31 * k, c[2]! / 31 * k, 1];
    if (mode > 0.5) return [k, k, k, 1];
    return [c[0]! / 31, c[1]! / 31, c[2]! / 31, col[3]];
  },
});
