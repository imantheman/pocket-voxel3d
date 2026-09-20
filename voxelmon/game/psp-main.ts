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
import type { VoxelHost } from "./host.ts";
import { drawKantoGear, gearTouchDown } from "./ui/kantogear.ts";

/** The story seed — voxelmon/tapes/story.tape is plotted against it
 * (tools/voxel.ts STORY_SEED). A save system picks its own seed later. */
const SEED = 17;

/** The native surface pocketvoxel-psp registers before evaling this file. */
interface VoxelNative {
  gamedata(): string;
  audiodata(): ArrayBuffer | undefined;
  stats(): void;
  reset(): void;
  mapShow(slot: number, mapId: number, ox: number, oy: number): void;
  mapHide(slot: number): void;
  cam(x: number, y: number): void;
  pitch(rung: number): void;
  tint(abgr: number): void;
  stamp(mapId: number, cx: number, cy: number, on: number): void;
  palette(index: number): void;
  ent(
    slot: number,
    sheet: number,
    frame: number,
    x: number,
    y: number,
    lift: number,
    flags: number,
  ): void;
  entHide(slot: number): void;
  emote(slot: number, kind: number): void;
  pic(slot: number, page: number, x: number, y: number, w: number, h: number): void;
  picHide(slot: number): void;
  saveWrite(text: string): boolean | void;
  saveData(): string | undefined;
  writeTest?(): boolean;
  writeErr?(): string | undefined;
  viewer?(): void;
  uiTile(x: number, y: number, tile: number): void;
  uiFill(x: number, y: number, w: number, h: number, tile: number): void;
  uiText(x: number, y: number, str: string): void;
  uiReveal(n: number): void;
  uiClear(): void;
  uiTileBottom(x: number, y: number, tile: number): void;
  uiFillBottom(x: number, y: number, w: number, h: number, tile: number): void;
  uiClearBottom(): void;
  uiSpriteBottom(page: number, x: number, y: number, w: number, h: number): void;
  animSprite(page: number, tile: number, x: number, y: number, flags: number): void;
  animClear(): void;
  uiPanel(side: number, x: number, y: number, w: number, h: number): void;
  fieldFx(x: number, z: number, frame: number): void;
  arena(mapId: number, x: number, y: number, shape: number, rig: number): void;
  card(
    side: number,
    pic: number,
    x: number,
    y: number,
    dx?: number,
    dy?: number,
    dz?: number,
  ): void;
  cardHide(side: number): void;
  battleCam(orbit: number, pitch: number, zoom: number): void;
  arenaEnd(): void;
  // audio — optional on the binding: an EBOOT built before the ops existed
  // simply has no such function, and the guest must not crash on it.
  music?(bank: number, addr: number, engine: number, flags: number): void;
  musicStop?(): void;
  musicFade?(ticks: number): void;
  sfx?(
    bank: number,
    addr: number,
    engine: number,
    pitch: number,
    tempo: number,
    flags: number,
  ): void;
  cry?(bank: number, addr: number, engine: number, pitch: number, length: number): void;
  audioWaves?(engine: number, bank: number, addr: number): void;
  audioDrum?(engine: number, drum: number, bank: number, addr: number): void;
}

const native = (globalThis as unknown as { voxel: VoxelNative }).voxel;

/**
 * VoxelHost over the native surface: every op forwards 1:1. `frameDone` is
 * a no-op — the host advances the core Scene's tick clock itself, after
 * `frame(buttons)` returns (one guest turn per host tick).
 */
class QuickJsHost implements VoxelHost {
  saveWrite(text: string): boolean | void {
    return native.saveWrite(text);
  }

  viewer(): void {
    (native as any).viewer?.();
  }

  writeTest(): boolean {
    return native.writeTest ? native.writeTest() === true : true;
  }

  writeErr(): string | undefined {
    return native.writeErr ? native.writeErr() : undefined;
  }

  saveData(): string | undefined {
    return native.saveData();
  }

  gamedata(): ArrayBuffer | null {
    // The boot path below reads the GAME string directly; the game never
    // crosses for data again after construction.
    return null;
  }
  audiodata(): ArrayBuffer | null {
    // One cold read at boot, like gamedata(): setAudioFromPak() parses the
    // manifest half and leaves the programs in the pak, where the core reads
    // them. undefined = a pak cooked without audio, and the director then
    // resolves nothing and emits no op.
    return native.audiodata ? (native.audiodata() ?? null) : null;
  }
  stats(): ArrayBuffer | null {
    native.stats();
    return null;
  }
  reset(): void {
    native.reset();
  }
  mapShow(slot: number, mapId: number, ox: number, oy: number): void {
    native.mapShow(slot, mapId, ox, oy);
  }
  mapHide(slot: number): void {
    native.mapHide(slot);
  }
  cam(x: number, y: number): void {
    native.cam(x, y);
  }
  pitch(rung: number): void {
    native.pitch(rung);
  }
  tint(abgr: number): void {
    native.tint(abgr);
  }
  stamp(mapId: number, cx: number, cy: number, on: number): void {
    native.stamp(mapId, cx, cy, on);
  }
  palette(index: number): void {
    native.palette(index);
  }
  ent(
    slot: number,
    sheet: number,
    frame: number,
    x: number,
    y: number,
    lift: number,
    flags: number,
  ): void {
    native.ent(slot, sheet, frame, x, y, lift, flags);
  }
  pic(slot: number, page: number, x: number, y: number, w: number, h: number): void {
    native.pic(slot, page, x, y, w, h);
  }
  picHide(slot: number): void {
    native.picHide(slot);
  }
  entHide(slot: number): void {
    native.entHide(slot);
  }
  emote(slot: number, kind: number): void {
    native.emote(slot, kind);
  }
  uiTile(x: number, y: number, tile: number): void {
    native.uiTile(x, y, tile);
  }
  uiFill(x: number, y: number, w: number, h: number, tile: number): void {
    native.uiFill(x, y, w, h, tile);
  }
  uiText(x: number, y: number, str: string): void {
    native.uiText(x, y, str);
  }
  uiReveal(n: number): void {
    native.uiReveal(n);
  }
  uiClear(): void {
    native.uiClear();
  }
  uiTileBottom(x: number, y: number, tile: number): void {
    native.uiTileBottom(x, y, tile);
  }
  uiFillBottom(x: number, y: number, w: number, h: number, tile: number): void {
    native.uiFillBottom(x, y, w, h, tile);
  }
  uiClearBottom(): void {
    native.uiClearBottom();
  }
  uiSpriteBottom(page: number, x: number, y: number, w: number, h: number): void {
    native.uiSpriteBottom(page, x, y, w, h);
  }
  animSprite(page: number, tile: number, x: number, y: number, flags: number): void {
    native.animSprite(page, tile, x, y, flags);
  }
  animClear(): void {
    native.animClear();
  }
  uiPanel(side: number, x: number, y: number, w: number, h: number): void {
    native.uiPanel(side, x, y, w, h);
  }
  fieldFx(x: number, z: number, frame: number): void {
    native.fieldFx(x, z, frame);
  }
  arena(mapId: number, x: number, y: number, shape: number, rig: number): void {
    native.arena(mapId, x, y, shape, rig);
  }
  card(side: number, pic: number, x: number, y: number, dx = 0, dy = 0, dz = 0): void {
    native.card(side, pic, x, y, dx, dy, dz);
  }
  cardHide(side: number): void {
    native.cardHide(side);
  }
  battleCam(orbit: number, pitch: number, zoom: number): void {
    native.battleCam(orbit, pitch, zoom);
  }
  arenaEnd(): void {
    native.arenaEnd();
  }
  music(bank: number, addr: number, engine: number, flags: number): void {
    native.music?.(bank, addr, engine, flags);
  }
  musicStop(): void {
    native.musicStop?.();
  }
  musicFade(ticks: number): void {
    native.musicFade?.(ticks);
  }
  sfx(
    bank: number,
    addr: number,
    engine: number,
    pitch: number,
    tempo: number,
    flags: number,
  ): void {
    native.sfx?.(bank, addr, engine, pitch, tempo, flags);
  }
  cry(bank: number, addr: number, engine: number, pitch: number, length: number): void {
    native.cry?.(bank, addr, engine, pitch, length);
  }
  audioWaves(engine: number, bank: number, addr: number): void {
    native.audioWaves?.(engine, bank, addr);
  }
  audioDrum(engine: number, drum: number, bank: number, addr: number): void {
    native.audioDrum?.(engine, drum, bank, addr);
  }
  frameDone(_tick: number, _buttons: number): void {
    // host-side: the EBOOT ticks the scene after frame() returns
  }
}

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
game.newGame();

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
// (main.rs): bit 8 = touching, bits 9..17 = x, bits 18..25 = y. We act on the
// DOWN edge only (a held touch is one tap), and hand game.tick just the low 8
// physical-button bits so nothing downstream sees the touch payload.
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
    const tx = (buttons >> 9) & 0x1ff;
    const ty = (buttons >> 18) & 0xff;
    // Tap-to-confirm on the bottom-screen battle menus; a no-op outside battle.
    gearTouchDown(game as unknown as Parameters<typeof gearTouchDown>[0], tx, ty);
  }
  prevTouch = touching;
  // Bits 24-25: quarter turns the camera has been swung, so the overworld
  // can keep "up" meaning away-from-the-camera.
  game.setCamTurns((buttons >> 24) & 3);
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
