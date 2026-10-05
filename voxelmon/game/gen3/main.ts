// pocket-voxel host entry for the gen3 (FireRed) port (GPLv3 + additional terms; see LICENSE.md).
//
// The QuickJS entry for FireRed, bundled into crates/pocketvoxel-3ds/game-firered.js
// (cc_build_firered.sh; the `firered` feature embeds it). The host runs it
// inside the shared world loop (crates/pocketvoxel-3ds/src/main.rs, with the
// gen3 pieces in src/gen3/): the guest's draw list is the 2D layer over the
// voxel world, and the field becomes scene ops (platform/game3_world.ts ->
// platform/worldview.ts).
//
// Modes, chosen when the bundle is built (bun --define PV_G3_MODE='"..."'):
//   game      (default) Game3 boots as on the desktop: title, menus, field.
//             PV_G3_BENCH_SCRIPT / PV_G3_BENCH_SHOTS work here too when given.
//   bench     Game3 boots, then a new game is put straight on FR_PALLET_TOWN
//             (6,8), skipping the intro; PV_G3_BENCH_SCRIPT ("tick:KEYS,..."
//             as tools/gen3/boot_harness.ts, keys held until the next entry)
//             walks it, and the screen is photographed at PV_G3_BENCH_SHOTS
//             (shown frames, comma list). PV_G3_BENCH_SCRIPT="suite" runs
//             platform/bench_suite.ts instead: each kind of screen in turn,
//             with a cost line per phase.
//   hosttest  the old host test card (hosttest.ts), one picture per frame;
//             frame HOSTTEST_SHOT_FRAME goes to sdmc:/3ds/voxelmon/firered/g3shot_0.ppm.
// (worldbench.ts is a separate entry: the world without the runtime.)
//
// BUNDLE IT AS AN IIFE (bun build --format iife, as cc_build_firered.sh
// does). The host evaluates the bundle as a global script, where every
// module's top-level function would become a global, and setFrame's
// globalThis.frame would replace the title screen's `frame` (the title then
// re-ran the whole game tick each step: a black screen at 1 fps).

// FIRST: the host and the sound, before any runtime module is evaluated.
import { clock, drawProf, nativeProf, readProf } from "./platform/qjs_host.ts";
import { BenchScript, errText, loadWorld, nat as n, padBits, setFrame, shotSet, worldOps } from "./platform/qjs_world.ts";
import { G } from "./platform/graphics.ts";
import { HostTest, HOSTTEST_SHOT_FRAME, hostTestSound } from "./hosttest.ts";
import { Game3 } from "./core/Game3.ts";
import { Input } from "./shared/core/Input.ts";
import { WorldView } from "./platform/worldview.ts";
import { Game3World } from "./platform/game3_world.ts";
import { BenchSuite } from "./platform/bench_suite.ts";

declare const PV_G3_MODE: string;
declare const PV_G3_BENCH_SCRIPT: string;
declare const PV_G3_BENCH_SHOTS: string;

const MODE = typeof PV_G3_MODE === "string" ? PV_G3_MODE : "game";

// The runtime's own log lines (Logger, its "[game3] ... failed" notes) go to
// pvlog.txt too: the host files only lines that start "[pv]" (voxel.rs).
{
  const raw = console.log;
  // a line the runtime repeats (every frame, say) is filed 3 times, then every
  // 1000th time with its count: each filed line is an SD write
  const seen = new Map<string, number>();
  const fwd = (...a: unknown[]): void => {
    const s = a.map((x) => (typeof x === "string" ? x : String(x))).join(" ");
    if (s.startsWith("[pv]")) { raw(s); return; }
    const k = (seen.get(s) ?? 0) + 1;
    if (seen.size < 4096 || k > 1) seen.set(s, k);
    if (k <= 3) raw("[pv] js: " + s);
    else if (k % 1000 === 0) raw(`[pv] js: (x${k}) ${s}`);
  };
  console.log = fwd; console.warn = fwd; console.error = fwd;
}

/** The boot natives some binaries have (g3_shim.c). */
const g3n = n as unknown as { g3Mem?(cheap?: boolean): number[]; g3Gc?(hold: boolean): void };

/** The heaps (g3_shim.c g3Mem): QuickJS, the app heap, linear memory. A
 *  cheap reading (the perf lines') leaves out the QuickJS heap, whose count
 *  walks every object (a hitch of over 100 ms on the console). */
function memText(cheap = false): string {
  const m = g3n.g3Mem?.(cheap);
  if (!m) return "mem n/a";
  const mb = (b: number): string => (b / 1048576).toFixed(1);
  return `${m[0]! >= 0 ? `js heap ${mb(m[0]!)} MB, ` : ""}app heap ${mb(m[1]!)} of ${mb(m[2]!)} MB used (high water ${mb(m[4] ?? 0)}), gc at ${mb(m[5] ?? 0)} MB, linear free ${Math.round(m[3]! / 1024)} KB`;
}

/** Bench builds: the host's byte-string conversion (g3Bytes) against lua.ts's own, on the files the load read. */
function benchBytesCheck(paths: string[]): void {
  const nb = (n as unknown as { g3Bytes?(s: string): Uint8Array | undefined }).g3Bytes;
  if (!nb) return;
  let files = 0, bytes = 0, bad = 0, left = 0;
  for (const p of paths.slice(0, 300)) {
    const s = n.g3Read?.(p);
    if (typeof s !== "string") continue;
    const a = nb(s);
    if (!a) { left++; continue; }
    files++; bytes += s.length;
    let same = a.length === s.length;
    for (let i = 0; same && i < s.length; i++) if (a[i] !== (s.charCodeAt(i) & 255)) same = false;
    if (!same) bad++;
  }
  console.log(`[pv] g3 bench: g3Bytes against toBytes on ${files} files (${(bytes / 1048576).toFixed(1)} MB): ${bad} differ, ${left} left to toBytes`);
}

function hostTestMain(): void {
  let test: HostTest | undefined;
  try {
    test = new HostTest();
  } catch (e) {
    console.log(`[pv] g3 host test: setup failed: ${errText(e)}`);
  }
  let frameNo = 0;
  setFrame((_buttons: number): void => {
    // one picture per shown frame (the host runs several steps to catch up)
    if (n.lastStep && !n.lastStep()) return;
    hostTestSound(frameNo);
    if (test) test.frame(frameNo);
    if (frameNo === HOSTTEST_SHOT_FRAME) n.screenshot?.();
    frameNo++;
  });
}

function gameMain(bench: boolean): void {
  console.log(`[pv] g3: before load: ${memText()}`);
  readProf.on = true;
  // no cycle collections while the tables are built (g3_shim.c g3Gc); one after
  g3n.g3Gc?.(true);
  const t0 = clock();
  const game: any = Game3.new();
  let ok = true;
  try {
    game.load({});
  } catch (e) {
    ok = false;
    console.log(`[pv] g3: Game3 load failed: ${errText(e)}`);
  }
  readProf.close();
  readProf.on = false;
  const tGc = clock();
  g3n.g3Gc?.(false);
  console.log(`[pv] g3: after load: cycle collection ${((clock() - tGc) / 1000).toFixed(0)} ms`);
  console.log(`[pv] g3: Game3 loaded in ${((clock() - t0) / 1000).toFixed(0)} ms (phase ${game.phase}); ${memText()}`);
  {
    const l = readProf.list;
    let host = 0, bytes = 0;
    for (const r of l) { host += r.host; bytes += Math.max(0, r.size); }
    console.log(`[pv] g3 load: ${l.length} cache reads, ${(bytes / 1048576).toFixed(1)} MB, host read time ${(host / 1000).toFixed(0)} ms`);
    for (const r of [...l].sort((a, b) => b.host + b.after - a.host - a.after).slice(0, 16)) {
      console.log(`[pv] g3 load:   ${((r.host + r.after) / 1000).toFixed(0)} ms (read ${(r.host / 1000).toFixed(0)}) ${r.size} B ${r.path}`);
    }
    const by = new Map<string, [number, number, number]>();
    for (const r of l) {
      const k = r.path.replace(/^data\/generated\/gba\//, "").replace(/\/[^/]*$/, "/*").replace(/^[^/]*\.(\w+)$/, "*.$1");
      const e = by.get(k) ?? [0, 0, 0];
      e[0]++; e[1] += r.host; e[2] += r.after;
      by.set(k, e);
    }
    for (const [k, e] of [...by].sort((a, b) => b[1][1] + b[1][2] - a[1][1] - a[1][2]).slice(0, 10)) {
      console.log(`[pv] g3 load:   ${((e[1] + e[2]) / 1000).toFixed(0)} ms (read ${(e[1] / 1000).toFixed(0)}) in ${e[0]} reads of ${k}`);
    }
    if (bench) benchBytesCheck(l.map((r) => r.path));
    readProf.list = [];
  }
  if (ok && bench) {
    try {
      game._handleBootAction({
        action: "new_game", name: "RED", rivalName: "BLUE", gender: 0,
        start: { map: "FR_PALLET_TOWN", x: 6, y: 8, facing: "down" },
      });
      console.log(`[pv] g3 bench: new game on FR_PALLET_TOWN (6,8), phase ${game.phase}`);
    } catch (e) {
      console.log(`[pv] g3 bench: new game failed: ${errText(e)}`);
    }
  }

  const view = new WorldView(worldOps(), loadWorld());
  const field = new Game3World(view);
  // game mode takes a script and shots too when the build gives them (a
  // title/new-game check that presses the game's own buttons)
  const scriptText = typeof PV_G3_BENCH_SCRIPT === "string" ? PV_G3_BENCH_SCRIPT : "";
  // bench mode's screen suite (platform/bench_suite.ts) instead of a key script
  const suite = bench && scriptText === "suite" ? new BenchSuite() : null;
  const script = new BenchScript(suite ? "" : scriptText);
  const shots = shotSet(typeof PV_G3_BENCH_SHOTS === "string" ? PV_G3_BENCH_SHOTS : bench ? "90,300" : "");
  let tick = 0;
  let shown = 0;
  let failedUpdate = false, failedDraw = false;
  const prof = { frames: 0, update: 0, draw: 0, emit: 0, ticks: 0, memEvery: 0, game: 0, updateMax: 0, drawMax: 0 };

  setFrame((buttons: number): void => {
    if (!ok) return;
    tick++;
    const t1 = clock();
    try {
      Input.hostButtons(padBits(buttons) | (suite ? suite.at(tick, game) : script.at(tick)));
      game.update(1 / 60);
    } catch (e) {
      if (!failedUpdate) console.log(`[pv] g3: update failed: ${errText(e)}`);
      failedUpdate = true;
    }
    const tu = clock() - t1;
    if (suite) suite.noteUpdate(tu);
    prof.update += tu;
    if (tu > prof.updateMax) prof.updateMax = tu;
    prof.ticks++;
    // one picture per shown frame (the host runs several steps to catch up)
    if (n.lastStep && !n.lastStep()) return;
    const t2 = clock();
    field.begin(game);
    G.beginFrame();
    const t2b = clock();
    try {
      game.draw();
    } catch (e) {
      if (!failedDraw) console.log(`[pv] g3: draw failed: ${errText(e)}`);
      failedDraw = true;
    }
    const t2c = clock();
    G.endFrame();
    const t3 = clock();
    view.emit(field.state(game));
    const t4 = clock();
    prof.draw += t3 - t2;
    prof.game += t2c - t2b;
    if (t3 - t2 > prof.drawMax) prof.drawMax = t3 - t2;
    prof.emit += t4 - t3;
    if (suite) suite.noteDraw(t4 - t2);
    shown++;
    if (shots.has(shown)) {
      n.screenshot?.();
      console.log(`[pv] g3 bench: shot at shown frame ${shown} (tick ${tick}) 3d=${field.world3d} ents=${view.entCount}`);
    }
    if (++prof.frames === 150) {
      const f = prof.frames;
      console.log(`[pv] g3 guest: update ${(prof.update / prof.ticks / 1000).toFixed(2)} ms/tick (max ${(prof.updateMax / 1000).toFixed(1)}, ${prof.ticks} ticks), ` +
        `draw ${(prof.draw / f / 1000).toFixed(2)} ms (max ${(prof.drawMax / 1000).toFixed(1)}; game.draw ${(prof.game / f / 1000).toFixed(2)}, g3Draw ${(drawProf.conv / f / 1000).toFixed(2)}, ` +
        `${Math.round(drawProf.len / f)} floats), world ${(prof.emit / f / 1000).toFixed(2)} ms, ` +
        `3d=${field.world3d} ents=${view.entCount} phase=${game.phase}${++prof.memEvery % 4 === 1 ? "; " + memText(true) : ""}`);
      const np = nativeProf;
      if (np.up + np.cache + np.rd + np.ex + np.au + np.png > 0) {
        console.log(`[pv] g3 natives over ${f} frames: texUpload ${np.up} (${Math.round(np.upKB)} KB, ${(np.upUs / 1000).toFixed(0)} ms), ` +
          `texFromCache ${np.cache} (${(np.cacheUs / 1000).toFixed(0)} ms), pngDecode ${np.png} (${(np.pngUs / 1000).toFixed(0)} ms), read ${np.rd} (${(np.rdUs / 1000).toFixed(0)} ms), exists ${np.ex} (${(np.exUs / 1000).toFixed(0)} ms), ` +
          `sound ${np.au} (${(np.auUs / 1000).toFixed(0)} ms: ${Object.entries(np.auTop).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => k + " " + v).join(", ")})`);
        np.up = np.upUs = np.upKB = np.cache = np.cacheUs = np.rd = np.rdUs = np.ex = np.exUs = np.au = np.auUs = np.png = np.pngUs = 0;
        np.auTop = {};
      }
      (globalThis as { __g3ProfDump?: () => void }).__g3ProfDump?.(); // tools/gen3/qjs_loadprof_gen.ts --device builds only
      prof.frames = prof.update = prof.draw = prof.emit = prof.ticks = prof.game = prof.updateMax = prof.drawMax = 0;
      drawProf.conv = drawProf.len = 0;
    }
  });
}

if (MODE === "hosttest") hostTestMain();
else gameMain(MODE === "bench");
