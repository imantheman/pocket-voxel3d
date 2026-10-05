// pocket-voxel host entry for the gen3 (FireRed) port (GPLv3 + additional terms; see LICENSE.md).
//
// The QuickJS entry for FireRed, bundled into crates/pocketvoxel-3ds/game-firered.js
// (cc_build_firered.sh; the `firered` feature embeds it). For now it is the
// HOST TEST CARD (hosttest.ts): the game runtime is still being ported. It
// binds G3Host over the gen3 natives (crates/pocketvoxel-3ds/src/gen3/g3_shim.c)
// and draws one test frame per shown frame; frame HOSTTEST_SHOT_FRAME is
// photographed to the card (sdmc:/3ds/voxelmon/firered/g3shot_0.ppm) for the
// comparison with the desktop rasteriser (tools/gen3/hosttest_shot.ts).

import { native } from "../quickjs-host.ts";
import { setHost, type G3Host } from "./platform/host.ts";
import { setAudio, type CryParams, type G3Audio, type SeOptions } from "./platform/audio.ts";
import { HostTest, HOSTTEST_SHOT_FRAME, hostTestSound } from "./hosttest.ts";

const n = native;
const clock = (): number => (n.now ? n.now() : Date.now() * 1000);

/** Bytes to a byte string (one char per byte), in chunks. */
function bytesToString(b: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < b.length; i += 8192) {
    parts.push(String.fromCharCode.apply(null, b.subarray(i, i + 8192) as unknown as number[]));
  }
  return parts.join("");
}

const prof = { frames: 0, scene: 0, conv: 0, len: 0 };

class QuickJsG3Host implements G3Host {
  texUpload(id: number, w: number, h: number, rgba: Uint8Array, repeat: boolean): void {
    n.g3TexUpload!(id, w, h, rgba, repeat);
  }
  texFromCache(id: number, path: string): [number, number] | undefined {
    const r = n.g3TexFromCache!(id, path);
    return r ? [r[0], r[1]] : undefined;
  }
  canvasNew(id: number, w: number, h: number): void { n.g3Canvas!(id, w, h); }
  texFree(id: number): void { n.g3TexFree!(id); }
  // sprite batches kept host-side, where the binary has them (an older one
  // without the natives is sent the quads every frame instead)
  batchUpload = n.g3BatchUpload
    ? (id: number, tex: number, quads: Float32Array, count: number): void => n.g3BatchUpload!(id, tex, quads, count)
    : undefined;
  batchFree = n.g3BatchFree ? (id: number): void => n.g3BatchFree!(id) : undefined;
  draw(list: Float32Array): void {
    const t = clock();
    // the draw list is already f32 storage (drawlist.ts): handed over as is
    n.g3Draw!(list);
    prof.conv += clock() - t;
    prof.len += list.length;
  }
  read(path: string): string | undefined { return n.g3Read!(path); }
  exists(path: string): boolean { return n.g3Exists!(path); }
  now(): number { return clock() / 1e6; }
}

setHost(new QuickJsG3Host());

/** G3Audio over the host's M4A engine (crates/pocketvoxel-3ds/src/gen3/audio.rs). */
class QuickJsG3Audio implements G3Audio {
  playSong(id: number): void { n.g3SongPlay!(id); }
  stopSong(): void { n.g3SongStop!(); }
  pauseSong(): void { n.g3SongPause!(); }
  resumeSong(): void { n.g3SongResume!(); }
  setSongVolume(gain: number): void { n.g3SongVolume!(gain); }
  song(): number { return n.g3Song!(); }
  songPaused(): boolean { return n.g3SongPaused!(); }
  setMono(mono: boolean): void { n.g3SeMono!(mono); }
  playSe(id: number, opts: SeOptions): void {
    n.g3SePlay!(id, opts.looping, opts.maxSec, opts.pan ?? 0, opts.gain ?? 1);
  }
  stopSe(id?: number): void { n.g3SeStop!(id ?? -1); }
  sePlaying(id?: number): boolean { return n.g3SePlaying!(id ?? -1); }
  setSePan(pan: number): void { n.g3SePan!(pan); }
  playFanfare(id: number, volume: number): void { n.g3FanfarePlay!(id, volume); }
  fanfarePlaying(): boolean { return n.g3FanfarePlaying!(); }
  stopFanfare(): void { n.g3FanfareStop!(); }
  playCry(species: number, params: CryParams, pan: number, volume: number): number | undefined {
    // the fields the profile overrode (or the volume the caller gave); the host fills in the rest
    return n.g3CryPlay!(species, params.mode, pan, volume,
      params.length, params.release, params.pitch, params.chorus, params.reverse, params.volume);
  }
  stopCry(): void { n.g3CryStop!(); }
  cryPlaying(): boolean { return n.g3CryPlaying!(); }
  stopAll(): void { n.g3AudioStopAll!(); }
}

// a binary without the natives (or without an audio pack) keeps the silent engine
if (n.g3SongPlay && n.g3AudioReady?.()) setAudio(new QuickJsG3Audio());
console.log(`[pv] g3 sound: guest audio ${n.g3SongPlay ? (n.g3AudioReady?.() ? "on the host engine" : "silent (host has no pack)") : "silent (no natives)"}`);

// Which read is faster on a big file: the C side re-encoding to UTF-8 for an
// 8-bit string, or an ArrayBuffer turned into a string here.
{
  const big = "data/generated/gba/scripts/text.lua";
  if (n.g3Exists!(big)) {
    const t0 = clock();
    const a = n.g3Read!(big);
    const t1 = clock();
    const buf = n.g3ReadBuf!(big);
    const t2 = clock();
    const b = buf ? bytesToString(new Uint8Array(buf)) : undefined;
    const t3 = clock();
    console.log(`[pv] g3 read ${big}: ${a?.length ?? -1} chars: g3Read ${((t1 - t0) / 1000).toFixed(1)} ms; ` +
      `g3ReadBuf ${((t2 - t1) / 1000).toFixed(1)} ms + to string ${((t3 - t2) / 1000).toFixed(1)} ms; same ${a === b}`);
  } else {
    console.log(`[pv] g3 read test: ${big} not on the card`);
  }
}

let test: HostTest | undefined;
try {
  test = new HostTest();
} catch (e) {
  console.log(`[pv] g3 host test: setup failed: ${String((e as Error)?.stack ?? e)}`);
}

let frameNo = 0;
(globalThis as unknown as { frame: (buttons: number) => void }).frame = (_buttons: number): void => {
  // one picture per shown frame (the host runs several steps to catch up)
  if (n.lastStep && !n.lastStep()) return;
  hostTestSound(frameNo);
  if (!test) { frameNo++; return; }
  const t = clock();
  test.frame(frameNo);
  prof.scene += clock() - t;
  if (frameNo === HOSTTEST_SHOT_FRAME) n.screenshot?.();
  frameNo++;
  if (++prof.frames === 150) {
    console.log(`[pv] g3 host test: frame ${frameNo}: scene ${(prof.scene / prof.frames / 1000).toFixed(2)} ms ` +
      `(of which list to f32 + g3Draw ${(prof.conv / prof.frames / 1000).toFixed(2)} ms, ${Math.round(prof.len / prof.frames)} floats)`);
    prof.frames = prof.scene = prof.conv = prof.len = 0;
  }
};
