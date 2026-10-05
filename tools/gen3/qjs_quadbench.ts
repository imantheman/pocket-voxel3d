// QuickJS micro-benchmark of the gen3 love.graphics stand-in: N image draws,
// rectangles and glyph-sized quads per frame through G, with a host whose
// draw does nothing -- the guest-side cost per primitive, under the 3DS's own
// QuickJS on the desktop (cc_g3_qjsbench.sh). Port tooling; never shipped.
import { G } from "../../voxelmon/game/gen3/platform/graphics.ts";
import { setHost, type G3Host } from "../../voxelmon/game/gen3/platform/host.ts";
import { ImageData } from "../../voxelmon/game/gen3/platform/image.ts";

declare const print: (s: string) => void;
const out = typeof print === "function" ? print : console.log;
let floats = 0;
const host: G3Host = {
  texUpload() {}, texFromCache: () => [8, 8], canvasNew() {}, texFree() {},
  draw(list) { floats += list.length; }, read: () => undefined, exists: () => false, now: () => Date.now() / 1000,
};
setHost(host);
const d = new ImageData(64, 64);
const img = G.newImage(d);
const quads = Array.from({ length: 16 }, (_, i) => G.newQuad((i % 8) * 8, Math.floor(i / 8) * 8, 8, 8, 64, 64));

function frame(f: number, n: number): void {
  G.beginFrame();
  G.clear(0, 0, 0, 1);
  for (let i = 0; i < n; i++) {
    G.setColor(1, 1, 1, 1);
    G.draw(img, quads[i & 15]!, (i * 7) % 232, (i * 13) % 152);
  }
  G.endFrame();
}
for (const n of [100, 400]) {
  for (let f = 0; f < 20; f++) frame(f, n);
  const t0 = Date.now();
  const F = 100;
  for (let f = 0; f < F; f++) frame(f, n);
  const ms = (Date.now() - t0) / F;
  out(`${n} quads/frame: ${ms.toFixed(2)} ms/frame, ${((ms * 1000) / n).toFixed(2)} us/quad`);
}
