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
//   bench     Game3 boots, then a new game is put straight on FR_PALLET_TOWN
//             (6,8), skipping the intro; PV_G3_BENCH_SCRIPT ("tick:KEYS,..."
//             as tools/gen3/boot_harness.ts, keys held until the next entry)
//             walks it, and the screen is photographed at PV_G3_BENCH_SHOTS
//             (shown frames, comma list).
//   hosttest  the old host test card (hosttest.ts), one picture per frame;
//             frame HOSTTEST_SHOT_FRAME goes to sdmc:/3ds/voxelmon/firered/g3shot_0.ppm.
// (worldbench.ts is a separate entry: the world without the runtime.)

// FIRST: the host and the sound, before any runtime module is evaluated.
import { clock, drawProf } from "./platform/qjs_host.ts";
import { BenchScript, errText, loadWorld, nat as n, padBits, setFrame, shotSet, worldOps } from "./platform/qjs_world.ts";
import { G } from "./platform/graphics.ts";
import { HostTest, HOSTTEST_SHOT_FRAME, hostTestSound } from "./hosttest.ts";
import { Game3 } from "./core/Game3.ts";
import { Input } from "./shared/core/Input.ts";
import { WorldView } from "./platform/worldview.ts";
import { Game3World } from "./platform/game3_world.ts";

declare const PV_G3_MODE: string;
declare const PV_G3_BENCH_SCRIPT: string;
declare const PV_G3_BENCH_SHOTS: string;

const MODE = typeof PV_G3_MODE === "string" ? PV_G3_MODE : "game";

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
  const t0 = clock();
  const game: any = Game3.new();
  let ok = true;
  try {
    game.load({});
  } catch (e) {
    ok = false;
    console.log(`[pv] g3: Game3 load failed: ${errText(e)}`);
  }
  console.log(`[pv] g3: Game3 loaded in ${((clock() - t0) / 1000).toFixed(0)} ms (phase ${game.phase})`);
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
  const script = new BenchScript(bench && typeof PV_G3_BENCH_SCRIPT === "string" ? PV_G3_BENCH_SCRIPT : "");
  const shots = shotSet(bench ? (typeof PV_G3_BENCH_SHOTS === "string" ? PV_G3_BENCH_SHOTS : "90,300") : "");
  let tick = 0;
  let shown = 0;
  let failedUpdate = false, failedDraw = false;
  const prof = { frames: 0, update: 0, draw: 0, emit: 0, ticks: 0 };

  setFrame((buttons: number): void => {
    if (!ok) return;
    tick++;
    const t1 = clock();
    try {
      Input.hostButtons(padBits(buttons) | script.at(tick));
      game.update(1 / 60);
    } catch (e) {
      if (!failedUpdate) console.log(`[pv] g3: update failed: ${errText(e)}`);
      failedUpdate = true;
    }
    prof.update += clock() - t1;
    prof.ticks++;
    // one picture per shown frame (the host runs several steps to catch up)
    if (n.lastStep && !n.lastStep()) return;
    const t2 = clock();
    field.begin(game);
    G.beginFrame();
    try {
      game.draw();
    } catch (e) {
      if (!failedDraw) console.log(`[pv] g3: draw failed: ${errText(e)}`);
      failedDraw = true;
    }
    G.endFrame();
    const t3 = clock();
    view.emit(field.state(game));
    const t4 = clock();
    prof.draw += t3 - t2;
    prof.emit += t4 - t3;
    shown++;
    if (shots.has(shown)) {
      n.screenshot?.();
      console.log(`[pv] g3 bench: shot at shown frame ${shown} (tick ${tick}) 3d=${field.world3d} ents=${view.entCount}`);
    }
    if (++prof.frames === 150) {
      const f = prof.frames;
      console.log(`[pv] g3 guest: update ${(prof.update / prof.ticks / 1000).toFixed(2)} ms/tick (${prof.ticks} ticks), ` +
        `draw ${(prof.draw / f / 1000).toFixed(2)} ms (g3Draw ${(drawProf.conv / f / 1000).toFixed(2)}, ` +
        `${Math.round(drawProf.len / f)} floats), world ${(prof.emit / f / 1000).toFixed(2)} ms, ` +
        `3d=${field.world3d} ents=${view.entCount} phase=${game.phase}`);
      prof.frames = prof.update = prof.draw = prof.emit = prof.ticks = 0;
      drawProf.conv = drawProf.len = 0;
    }
  });
}

if (MODE === "hosttest") hostTestMain();
else gameMain(MODE === "bench");
