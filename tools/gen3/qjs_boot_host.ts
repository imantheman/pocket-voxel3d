// Port tooling: the gen3 host for tools/gen3/qjs_boot.ts under the desktop
// QuickJS runner (tools/gen3/qjs_run.c). Imported FIRST, so the host is bound
// before any runtime module is evaluated (as main.ts does with qjs_host.ts).
// Every cache read is recorded with its size, the time until the next read
// and the heap in use then. Never shipped.
import { setHost, type G3Host } from "../../voxelmon/game/gen3/platform/host.ts";
import { setSaveStore, memorySaveStore } from "../../voxelmon/game/gen3/platform/savefs.ts";
import { setAudio, silentAudio } from "../../voxelmon/game/gen3/platform/audio.ts";
import { setNativeBytes } from "../../voxelmon/import/gen3/lua.ts";
import { setNativeBlit } from "../../voxelmon/game/gen3/platform/image.ts";

type Blit = (dst: Uint8Array, dw: number, dx: number, dy: number, src: Uint8Array, sw: number, sx: number, sy: number, w: number, h: number) => boolean;

declare const readFile: (p: string) => string | undefined;
declare const print: (s: string) => void;
declare const nowUs: () => number;
declare const memUsage: () => [number, number];
declare const QJS_TIME_SCALE: number;

export interface ReadRec { path: string; size: number; t: number; ms: number; heapAfter: number; peak: number }
export const reads: ReadRec[] = [];
let last: ReadRec | undefined;

/** Close the open read's timing (and heap) now. */
export function closeRead(): void {
  if (!last) return;
  last.ms = (nowUs() - last.t) / 1000;
  const [use, peak] = memUsage();
  last.heapAfter = use;
  last.peak = peak;
  last = undefined;
}

const host: G3Host = {
  texUpload(id, w, h) { if (w > 1024 || h > 1024) print(`[boot] texUpload ${id} is ${w}x${h} (over the 3DS's 1024): ${new Error().stack}`); },
  canvasNew() {}, texFree() {},
  // the PNG's real size (IHDR), as the 3DS host decodes it
  texFromCache(_id, path) {
    const s = readFile(path);
    if (s === undefined || s.length < 24) return undefined;
    const be = (i: number): number => ((s.charCodeAt(i) << 24) | (s.charCodeAt(i + 1) << 16) | (s.charCodeAt(i + 2) << 8) | s.charCodeAt(i + 3)) >>> 0;
    return [be(16), be(20)];
  },
  draw() {}, batchUpload() {}, batchFree() {},
  read(p) {
    closeRead();
    const s = readFile(p);
    last = { path: p, size: s?.length ?? -1, t: nowUs(), ms: 0, heapAfter: 0, peak: 0 };
    reads.push(last);
    return s;
  },
  exists: (p) => readFile(p) !== undefined,
  // QJS_TIME_SCALE > 1 runs the clock fast, as a console sees it (the guest
  // is that many times slower there): catch-up-to-the-clock code shows up
  now: () => (nowUs() / 1e6) * (typeof QJS_TIME_SCALE === "number" ? QJS_TIME_SCALE : 1),
};
// the 3DS host's C helpers, where qjs_run.c has them (its nativeBytes /
// nativeBlit / pngDecode), so a profile here pays for what the console pays
// for: byte strings to bytes, ImageData:paste's rect copies, PNG decoding
{
  const g = globalThis as { nativeBytes?: (s: string) => Uint8Array | undefined; nativeBlit?: Blit; pngDecode?: (s: string) => [number, number, Uint8Array] | undefined };
  if (g.nativeBytes) setNativeBytes(g.nativeBytes);
  if (g.nativeBlit) setNativeBlit(g.nativeBlit);
  if (g.pngDecode) host.pngDecode = (s) => g.pngDecode!(s);
}
// tools/gen3/perf_check.ts runs qjs_perf.ts under Bun on its own host
setHost((globalThis as { __perfHost?: G3Host }).__perfHost ?? host);
setSaveStore(memorySaveStore());
setAudio(silentAudio());
