// pocket-voxel host test for the gen3 (FireRed) port (GPLv3 + additional terms; see LICENSE.md).
//
// The host test card (voxelmon/game/gen3/hosttest.ts) on the desktop
// rasteriser: frames 0..N drawn against DesktopHost and frame N written as a
// PNG, to set beside the 3DS's photograph of the same frame
// (sdmc:/3ds/voxelmon/firered/g3shot_0.ppm).
//
//   bun tools/gen3/hosttest_shot.ts [cacheRoot] [frame] [out.png]
//
// cacheRoot holds data/generated/gba (default ~/gen3ref/frfull).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DesktopHost } from "../../voxelmon/game/gen3/platform/desktop.ts";
import { setHost } from "../../voxelmon/game/gen3/platform/host.ts";
import { HostTest, HOSTTEST_SHOT_FRAME } from "../../voxelmon/game/gen3/hosttest.ts";
import { encodePng } from "../../voxelmon/import/gen3/png.ts";

const root = process.argv[2] ?? `${process.env.HOME}/gen3ref/frfull`;
const frame = Number(process.argv[3] ?? HOSTTEST_SHOT_FRAME);
const out = process.argv[4] ?? "/tmp/g3shots/hosttest.png";

const host = new DesktopHost(root);
setHost(host);
const test = new HostTest();
const t0 = performance.now();
for (let f = 0; f <= frame; f++) test.frame(f);
const ms = (performance.now() - t0) / (frame + 1);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, encodePng(240, 160, host.pixels()));
console.log(`frame ${frame}: ${host.lastList.length} floats, ${ms.toFixed(1)} ms/frame -> ${out}`);
