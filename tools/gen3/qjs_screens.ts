// Time real gen3 screens under the 3DS's own QuickJS on the desktop
// (cc_g3_qjsbench.sh tools/gen3/qjs_screens.ts): the guest-side cost per
// frame of drawing a text box with frlg_font, and of the title screen, with
// a host whose draw does nothing (sprite batches kept host-side). Multiply by
// ~20-30 for a 3DS. Port tooling; never shipped.
import { setHost, type G3Host } from "../../voxelmon/game/gen3/platform/host.ts";
import { G } from "../../voxelmon/game/gen3/platform/graphics.ts";
import { decodePngBytes } from "../../voxelmon/game/gen3/platform/pngdecode.ts";
import { FrlgFont } from "../../voxelmon/game/gen3/ui/frlg_font.ts";
import { Window } from "../../voxelmon/game/gen3/ui/window.ts";

declare const print: (s: string) => void;
declare const readFile: (p: string) => string | undefined;
declare const nowUs: () => number;

let floats = 0;
const host: G3Host = {
  texUpload() {}, canvasNew() {}, texFree() {},
  texFromCache(_id, path) {
    const s = readFile(path);
    if (!s) return undefined;
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    const png = decodePngBytes(b);
    return [png.w, png.h];
  },
  draw(list) { floats += list.length; },
  batchUpload() {}, batchFree() {},
  read: (p) => readFile(p), exists: (p) => readFile(p) !== undefined, now: () => nowUs() / 1e6,
};
setHost(host);

function time(name: string, frames: number, frame: (f: number) => void): void {
  for (let f = 0; f < 10; f++) frame(f);
  floats = 0;
  const t0 = nowUs();
  for (let f = 0; f < frames; f++) frame(f);
  const ms = (nowUs() - t0) / 1000 / frames;
  print(`${name}: ${ms.toFixed(3)} ms/frame (desktop QuickJS), ${Math.round(floats / frames)} floats/frame`);
}

const TEXT = "Hello there!\nWelcome to the world of\nmonsters and adventure!";
time("text box (frame + 3 lines)", 200, () => {
  G.beginFrame();
  G.clear(0, 0, 0, 1);
  (Window as any).drawDialogueFrame?.(0, 112, 240, 48);
  (FrlgFont as any).draw(TEXT, 16, 118, {});
  G.endFrame();
});
time("text only (3 lines)", 200, () => {
  G.beginFrame();
  (FrlgFont as any).draw(TEXT, 16, 118, {});
  G.endFrame();
});
