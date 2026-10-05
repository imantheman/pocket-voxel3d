// Port tooling: the gen3 host for tools/gen3/qjs_boot.ts under the desktop
// QuickJS runner (tools/gen3/qjs_run.c). Imported FIRST, so the host is bound
// before any runtime module is evaluated (as main.ts does with qjs_host.ts).
// Every cache read is recorded with its size, the time until the next read
// and the heap in use then. Never shipped.
import { setHost, type G3Host } from "../../voxelmon/game/gen3/platform/host.ts";
import { setSaveStore, memorySaveStore } from "../../voxelmon/game/gen3/platform/savefs.ts";
import { setAudio, silentAudio } from "../../voxelmon/game/gen3/platform/audio.ts";

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
// tools/gen3/perf_check.ts runs qjs_perf.ts under Bun on its own host
setHost((globalThis as { __perfHost?: G3Host }).__perfHost ?? host);
setSaveStore(memorySaveStore());
setAudio(silentAudio());
