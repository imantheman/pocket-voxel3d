// Port tooling: the device bench's long session (platform/bench_leak.ts)
// under the 3DS's QuickJS on the desktop (tools/gen3/qjs_run.c), for the
// QuickJS heap: at each step of the session its line gives the heap in use
// as it stands and after a full cycle collection (what is garbage the
// collector has not reached yet, and what is held). The host keeps no
// textures (qjs_boot_host.ts), so this is the guest's own heap alone.
// QJS_SIZES="a,b,c": at those steps also the modules' reachable data by
// path (js_sizes.ts), and what grew since the last of them.
//   bun build tools/gen3/qjs_leak.ts --outfile /tmp/qjs_leak.js --target browser --minify-syntax [--define QJS_SIZES='"3,40"']
//   qjs_run /tmp/qjs_leak.js <cache root>
// Never shipped.
import { arrayTracking, liveArrays } from "./track_arrays.ts";
import { closeRead } from "./qjs_boot_host.ts";
import { G } from "../../voxelmon/game/gen3/platform/graphics.ts";
import { Game3 } from "../../voxelmon/game/gen3/core/Game3.ts";
import { Input } from "../../voxelmon/game/gen3/shared/core/Input.ts";
import { BenchLeak } from "../../voxelmon/game/gen3/platform/bench_leak.ts";
import { sizeByPath, sizeDiff } from "./js_sizes.ts";
import { setImageDataTrack, setImageTrack, pixelDrop, type ImageData as ImageDataT, type Image as ImageT } from "../../voxelmon/game/gen3/platform/image.ts";
import { variantCacheStats } from "../../voxelmon/game/gen3/platform/graphics.ts";
import { saveStore } from "../../voxelmon/game/gen3/platform/savefs.ts";
import { WorldView, parseWorldJson } from "../../voxelmon/game/gen3/platform/worldview.ts";
import { Game3World } from "../../voxelmon/game/gen3/platform/game3_world.ts";

declare const print: (s: string) => void;
declare const nowUs: () => number;
declare const memUsage: () => [number, number];
declare const gc: () => void;
declare const gcHold: (hold: boolean) => void;
declare const QJS_SIZES: string;
declare const QJS_NOWALK: number;
declare const memDetail: undefined | (() => Record<string, number>);
declare const texBytes: undefined | (() => number);
declare const QJS_WORLD3D: number;
declare const QJS_NOGC: number;
declare const QJS_IMG_DIMS: number;
declare const gcThreshold: undefined | (() => number);
declare const gcClamp: undefined | (() => number);
/** Collections QuickJS ran on its own (seen by gcClamp; the first is g3Gc's re-arm after load). */
let autoGcs = 0;
declare const readFile: (p: string) => string | undefined;

// every ImageData made, with where (the first callers outside image.ts), while it lives
const tracked: { r: WeakRef<ImageDataT>; site: string }[] = [];
setImageDataTrack((d) => {
  const st = (new Error().stack ?? "").split("\n").map((l) => l.trim().replace(/^at /, "").replace(/ \(.*$/, ""));
  const keep = st.filter((f) => f && !/^(Error|ImageData|newImageData|ImageData2|<anonymous>|\[native code\])$/.test(f)).slice(1, 4);
  tracked.push({ r: new WeakRef(d), site: keep.join(" < ") });
});
// every Image made, with where, while it lives: the textures the host holds
// for them, sized as the 3DS allocates (power-of-two sides, RGBA8 at most)
const trackedImg: { r: WeakRef<ImageT>; site: string }[] = [];
setImageTrack((img) => {
  const st = (new Error().stack ?? "").split("\n").map((l) => l.trim().replace(/^at /, "").replace(/ \(.*$/, ""));
  const keep = st.filter((f) => f && !/^(Error|Image|newImage|Canvas|<anonymous>|\[native code\])$/.test(f)).slice(1, 4);
  trackedImg.push({ r: new WeakRef(img), site: keep.join(" < ") });
});
const po2 = (n: number): number => { let p = 8; while (p < n) p <<= 1; return p; };
function liveImages(): [number, number, Map<string, [number, number]>] {
  let total = 0, n = 0, j = 0;
  const by = new Map<string, [number, number]>();
  for (let i = 0; i < trackedImg.length; i++) {
    const t = trackedImg[i]!;
    const img = t.r.deref();
    if (!img) continue;
    trackedImg[j++] = t;
    if (!img.watched || img.id < 0) continue;
    const b = img.h > 1024 ? po2(img.w * 2) * po2(img.h - 512) * 4 : po2(img.w) * po2(img.h) * 4;
    total += b; n++;
    const k = typeof QJS_IMG_DIMS === "number" && QJS_IMG_DIMS ? `${t.site} [${img.w}x${img.h}]` : t.site;
    const e = by.get(k) ?? [0, 0];
    e[0]++; e[1] += b;
    by.set(k, e);
  }
  trackedImg.length = j;
  return [n, total, by];
}
function liveImageData(): [number, Map<string, [number, number]>] {
  let total = 0, j = 0;
  const by = new Map<string, [number, number]>();
  for (let i = 0; i < tracked.length; i++) {
    const t = tracked[i]!;
    const d = t.r.deref();
    if (!d) continue;
    tracked[j++] = t;
    total += d.px.length;
    const e = by.get(t.site) ?? [0, 0];
    e[0]++; e[1] += d.px.length;
    by.set(t.site, e);
  }
  tracked.length = j;
  return [total, by];
}
const sizeSteps = new Set((typeof QJS_SIZES === "string" ? QJS_SIZES : "").split(",").filter((s) => s !== "").map(Number));
const mb = (b: number): string => (b / 1048576).toFixed(1);
const t0 = nowUs();
gcHold(true);
const game: any = Game3.new();
game.load({});
closeRead();
gcHold(false);
print(`[qleak] load ${((nowUs() - t0) / 1000).toFixed(0)} ms, heap ${mb(memUsage()[0])} MB`);
game._handleBootAction({ action: "new_game", name: "RED", rivalName: "BLUE", gender: 0, start: { map: "FR_PALLET_TOWN", x: 6, y: 8, facing: "down" } });

let lastDetail: Record<string, number> | undefined;
let lastSizes: Map<string, number> | undefined;
let step = 0;
const bench = new BenchLeak(game, () => {
  const s = step++;
  const before = memUsage()[0];
  const tg = nowUs();
  // QJS_NOGC=1: no collection here, as the console's bench (only QuickJS's own threshold)
  if (!(typeof QJS_NOGC === "number" && QJS_NOGC)) gc();
  const after = memUsage()[0];
  let detail = "";
  if (typeof memDetail === "function") {
    // what grew since the last step, by kind
    const d = memDetail();
    if (lastDetail) {
      const kb = (k: string): string => `${k} ${(((d[k] ?? 0) - (lastDetail![k] ?? 0)) / 1024).toFixed(0)}`;
      detail = ` | grew KB: ${["str", "obj", "prop", "shape", "func", "code", "binary"].map(kb).join(" ")}; ` +
        `objects ${d.objN! - lastDetail.objN!}, arrays ${d.arrayN! - lastDetail.arrayN!}, buffers ${d.binaryN! - lastDetail.binaryN!}`;
    }
    lastDetail = d;
  }
  const [idBytes, idBy] = liveImageData();
  const [imN, imBytes, imBy] = liveImages();
  if (sizeSteps.has(s)) {
    print(`[images] step ${s}: ${imN} images with textures, ${mb(imBytes)} MB as the 3DS allocates them, by where made:`);
    for (const [site, [c, b]] of [...imBy].sort((x, y) => y[1][1] - x[1][1]).slice(0, 40)) print(`[images]   ${(b / 1024).toFixed(0).padStart(6)} KB ${String(c).padStart(4)}  ${site}`);
  }
  const [vn, vb] = variantCacheStats();
  if (sizeSteps.has(s) && typeof memDetail === "function") print(`[detail] step ${s}: ${JSON.stringify(memDetail())}`);
  let arrText = "";
  if (arrayTracking) {
    const [at, aby] = liveArrays();
    arrText = `; typed arrays ${mb(at)} MB`;
    if (sizeSteps.has(s)) {
      print(`[arrays] step ${s}: ${mb(at)} MB of typed arrays (1 KB+) alive, by where made:`);
      for (const [site, [n, b]] of [...aby].sort((x, y) => y[1][1] - x[1][1]).slice(0, 30)) print(`[arrays]   ${(b / 1024).toFixed(0).padStart(6)} KB ${String(n).padStart(5)}  ${site}`);
    }
  }
  if (sizeSteps.has(s) && !(typeof QJS_NOWALK === "number" && QJS_NOWALK)) {
    // the bundle (an ES module run as a global script) leaves every module's
    // top-level var on the global object, exported or not: walk those
    const roots: Record<string, any> = { g: {} };
    for (const k of Object.getOwnPropertyNames(globalThis)) {
      if (/^(globalThis|tracked|trackedArrays|lastSizes|lastDetail)$/.test(k)) continue;
      try { roots.g[k] = (globalThis as any)[k]; } catch { /* a getter that throws */ }
    }
    const sz = sizeByPath(roots, 4);
    if (lastSizes) for (const l of sizeDiff(lastSizes, sz, 40)) print(l);
    else print(`[size] step ${s}: the modules' reachable data measured`);
    lastSizes = sz;
    print(`[pixels] step ${s}: ${mb(idBytes)} MB of ImageData alive, by where made:`);
    for (const [site, [n, b]] of [...idBy].sort((x, y) => y[1][1] - x[1][1]).slice(0, 25)) print(`[pixels]   ${(b / 1024).toFixed(0).padStart(6)} KB ${String(n).padStart(4)}  ${site}`);
  }
  return `step ${s}: js heap ${mb(before)} MB, ${mb(after)} MB after a collection${typeof gcThreshold === "function" ? ` (gc at ${mb(gcThreshold())}, ${autoGcs} re-armed)` : ""} (${((nowUs() - tg) / 1000).toFixed(0)} ms); ImageData ${mb(idBytes)} MB; variants ${vn} ${mb(vb)} MB; pixels dropped ${pixelDrop.dropped} (${mb(pixelDrop.droppedBytes)} MB), remade ${pixelDrop.remade}; textures ${typeof texBytes === "function" ? mb(texBytes()) : "?"} MB, ${imN} images ${mb(imBytes)} MB at 3DS sizes${arrText}${detail}`;
});
// QJS_WORLD3D=1: the field as the console runs it in 3D (Game3World + WorldView, ops stubbed)
let view: WorldView | undefined, field: Game3World | undefined;
if (typeof QJS_WORLD3D === "number" && QJS_WORLD3D > 0) {
  const ops = { mapShow() {}, mapHide() {}, cam() {}, pitch() {}, tint() {}, flatWorld() {}, g3Ents() {}, strips() {} };
  view = new WorldView(ops as any, parseWorldJson(readFile("world.json")!));
  field = new Game3World(view);
}
let tick = 0;
try {
  while (!bench.done && tick < 300000) {
    tick++;
    (Input as any).hostButtons(bench.at(tick, game));
    game.update(1 / 60);
    if (field) field.begin(game);
    G.beginFrame();
    game.draw();
    G.endFrame();
    if (field && view) view.emit(field.state(game));
    // the console's hold on the collector (g3Draw's g3_gc_clamp), each frame
    if (typeof gcClamp === "function") autoGcs += gcClamp();
  }
} catch (e) {
  print(`[qleak] stopped at tick ${tick}: ${(e as Error)?.stack ?? e}`);
}
print(`[qleak] ${tick} ticks, ${((nowUs() - t0) / 1000).toFixed(0)} ms`);
{
  // what the game wrote through love.filesystem this session
  const st: any = saveStore();
  let n = 0, b = 0;
  const by = new Map<string, [number, number]>();
  for (const name of st.list ? st.list() : []) {
    const len = (st.read(name) ?? "").length;
    n++; b += len;
    const k = name.replace(/[0-9a-f]{6,}/g, "#").replace(/\/[^/]*\//, "/*/");
    const e = by.get(k) ?? [0, 0];
    e[0]++; e[1] += len;
    by.set(k, e);
  }
  print(`[store] ${n} files, ${mb(b)} MB written this session:`);
  for (const [k, [c, s]] of [...by].sort((x, y) => y[1][1] - x[1][1]).slice(0, 20)) print(`[store]   ${(s / 1024).toFixed(0).padStart(6)} KB ${String(c).padStart(4)}  ${k}`);
}
