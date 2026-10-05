// A contact sheet of same-size PNGs: bun tools/gen3/montage.ts out.png cols a.png b.png ...
import { readFileSync, writeFileSync } from "node:fs";
import { decodePngBytes } from "../../voxelmon/game/gen3/platform/pngdecode.ts";
import { encodePng } from "../../voxelmon/import/gen3/png.ts";

const [out, colsArg, ...files] = process.argv.slice(2);
const imgs = files.map((f) => decodePngBytes(new Uint8Array(readFileSync(f))));
const w = imgs[0]!.w, h = imgs[0]!.h, cols = Number(colsArg);
const rows = Math.ceil(imgs.length / cols);
const W = w * cols, H = h * rows;
const px = new Uint8Array(W * H * 4);
imgs.forEach((im, i) => {
  const ox = (i % cols) * w, oy = Math.floor(i / cols) * h;
  for (let y = 0; y < Math.min(h, im.h); y++) {
    px.set(im.rgba.subarray(y * im.w * 4, y * im.w * 4 + Math.min(w, im.w) * 4), ((oy + y) * W + ox) * 4);
  }
});
writeFileSync(out!, encodePng(W, H, px));
console.log(`${out}: ${imgs.length} images, ${W}x${H}`);
