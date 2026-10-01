// voxelmon/game/psp-main.ts — the QuickJS entry for the PSP EBOOT.
//
// Bundled by `bun tools/voxel.ts psp` (iife, browser target, no Bun/node in
// the import graph — data.ts only touches Bun inside fromGenDir, which this
// entry never calls) and evaled once at boot by pocketvoxel-psp. The host
// side registers `globalThis.voxel` (crates/
// pocketvoxel-psp/src/voxel.rs), one function per VOX_OP.
//
// Boot: one cold JSON.parse of the pak's GAME section (docs/VOXEL.md §4),
// then the game runs entirely guest-side; per tick the host calls
// `globalThis.frame(buttons)` exactly once (§3). The Bun sim loads the SAME
// cooked gamedata (data.ts loadRuntimeData prefers dist/voxelmon/
// gamedata.json — the GAME section verbatim), so a Bun run records exactly
// what this entry replays on device.

import { fromObject } from "./data.ts";
import { VoxelmonGame } from "./game.ts";
import { native, QuickJsHost, STICK_RANGE } from "./quickjs-host.ts";
import { drawKantoGear, gearTouchDown, gearTouchMove, gearTouchUp } from "./ui/kantogear.ts";

/** The story seed — voxelmon/tapes/story.tape is plotted against it
 * (tools/voxel.ts STORY_SEED). A save system picks its own seed later. */
const SEED = 17;


// ---- boot: one cold parse, then the guest owns the game ----
const host = new QuickJsHost();
const source = JSON.parse(native.gamedata()) as Record<string, unknown>;
const game = new VoxelmonGame(fromObject(source), host, SEED);
// AUDIO ON. This loads the pak's AUDI manifest, which is what lets the
// director resolve a song name to (bank, address, engine) and emit the audio
// ops; the ROM's channel programs stay in the pak and the chip synth that
// interprets them is the core's (crates/.../audio.rs), compiled.
// The EBOOT pumps `Scene::render_audio` into the audio module's ring once
// per tick (pocketvoxel-psp/src/main.rs `audio_pump`).
//
// The cost is why this can be on. The synth was TypeScript here until it
// moved into the core, and interpreted it cost ~0.21 ms per PCM frame on
// this MIPS part — 11.025 kHz wanted ~2.3 seconds of CPU per second of
// audio, so the guest could never reach the ring's lead and the frame
// collapsed to ~9 fps. The compiled synth costs ~6.5 us per tick's worth of
// frames on desktop, which extrapolates to 0.2-0.4 ms on the 333 MHz part:
// 1-2.5% of the 16.7 ms frame.
//
// THE SWITCH: put `game.setAudio(null);` back here and the run goes silent
// end to end — no manifest, so no audio op, so the EBOOT never opens a
// hardware stream (main.rs gates the pump on the first op). The `audiodata`
// op fires either way, so the op stream still matches the recorded .vtrace.
game.setAudioFromPak();
game.boot();

// Autopilot-only guest profiling: the perf-runbook EBOOT alone registers
// `voxel.now`/`voxel.perf`; everywhere else the hook stays undefined and
// tick() pays four dead branches.
const nat = native as unknown as { now?: () => number; perf?: (s: string) => void };
if (nat.now && nat.perf) {
  game.prof = {
    now: nat.now,
    line: nat.perf,
    upd: 0,
    emit: 0,
    aud: 0,
    maps: 0,
    ents: 0,
    ui: 0,
  };
}

// Touch state is packed into the high bits of the button word by the 3DS host
// (main.rs): bit 8 = touching, bits 9..16 = x/2, bits 17..23 = y/2. We act on the
// two EDGES only (a held touch is one tap: the down edge aims, the up edge
// fires), and hand game.tick just the low 8 physical-button bits so nothing
// downstream sees the touch payload.
let prevTouch = false;
// L/R edge flags (bits 26/27 of the button word — outside VOX_BTN/Input on
// purpose: the shoulder buttons have no Game Boy equivalent, so they have no
// business in the ported input model). A rendered frame can call frame() more
// than once (main.rs's sim-catch-up loop resends the same word for every
// step), so this collapses those repeats into one trigger per physical press
// the same way prevTouch does for a held tap.
let prevGearNext = false;
let prevGearPrev = false;
(globalThis as unknown as { frame: (buttons: number) => void }).frame = (
  buttons: number,
): void => {
  const phys = buttons & 0xff;
  const touching = ((buttons >> 8) & 1) !== 0;
  if (touching && !prevTouch) {
    const tx = ((buttons >> 9) & 0xff) * 2;
    const ty = ((buttons >> 17) & 0x7f) * 2;
    // Tap-to-confirm on the bottom-screen battle menus; a no-op outside battle.
    gearTouchDown(game as unknown as Parameters<typeof gearTouchDown>[0], tx, ty);
  } else if (!touching && prevTouch) {
    gearTouchUp(game as unknown as Parameters<typeof gearTouchUp>[0]);
  } else if (touching) {
    // held: the finger's path, for the NOTES sketch pad
    gearTouchMove(game as unknown as Parameters<typeof gearTouchMove>[0],
      ((buttons >> 9) & 0xff) * 2, ((buttons >> 17) & 0x7f) * 2);
  }
  prevTouch = touching;
  // Bits 24-25: quarter turns the camera has been swung, so the overworld
  // can keep "up" meaning away-from-the-camera.
  game.setCamTurns((buttons >> 24) & 3);
  // And the other way: how fast the stick may swing it, from the OPTION
  // screen. Stated every frame -- one small number -- so a scene reset on
  // the host side never leaves it at the default while the save says
  // otherwise. Optional on the native surface: an older shim has no such
  // op and the host keeps its tuned rate.
  native.camSpeed?.(game.cameraSpeedQ8());
  // TILT SHIFT, the same way.
  native.tiltShift?.(game.tiltShiftLevel());
  // The circle pad itself, for the free walk: the button word only ever
  // carried it quantised to the four d-pad bits.
  const st = native.stick?.();
  if (st !== undefined) {
    const sx = (st >> 16) << 16 >> 16; // sign-extend the two halves
    const sy = (st << 16) >> 16;
    game.setStick(sx, sy, STICK_RANGE);
  }
  // Bits 28-31 carry the low four bits of the camera's yaw in 64ths of a
  // turn; bits 24-25 are its top two (offset half a quadrant, which is what
  // makes them the rounded quarter turns the grid walk has always read).
  // Together they give free movement a 5.6-degree yaw.
  {
    const e = (((buttons >> 24) & 3) << 4) | ((buttons >>> 28) & 15);
    game.setCamYaw((((e - 8) % 64 + 64) % 64) * ((Math.PI * 2) / 64));
  }
  const gearNext = ((buttons >> 26) & 1) !== 0;
  const gearPrev = ((buttons >> 27) & 1) !== 0;
  // L/R step the Kanto Gear's view (PARTY / MAP / ...). They used to cycle
  // the overworld map for debugging; the DEV menu's WARP picker replaced that.
  if (gearNext && !prevGearNext) game.cycleGearView(1);
  if (gearPrev && !prevGearPrev) game.cycleGearView(-1);
  prevGearNext = gearNext;
  prevGearPrev = gearPrev;
  game.tick(phys);
  // Kanto Gear companion: redraw the bottom-screen surface from current game
  // state. A host without a second screen ignores the UI_*_BOTTOM ops.
  drawKantoGear(host, game as unknown as Parameters<typeof drawKantoGear>[1]);
};
