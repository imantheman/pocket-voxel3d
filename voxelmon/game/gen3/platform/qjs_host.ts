// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). The gen3 guest's host and sound over the 3DS's QuickJS
// natives (crates/pocketvoxel-3ds/src/gen3/g3_shim.c, audio.rs), bound when
// this module is evaluated. The entry (main.ts) imports it FIRST, so the
// host is in place before any runtime module that reads the cache at load
// is evaluated (ES modules run in import order; tools/gen3/boot_harness.ts
// gets the same by importing Game3 dynamically after setHost).

import { native } from "../../quickjs-host.ts";
import { setHost, type G3Host } from "./host.ts";
import { setAudio, type CryParams, type G3Audio, type SeOptions } from "./audio.ts";

const n = native;
export const clock = (): number => (n.now ? n.now() : Date.now() * 1000);

/** Draw-list timing, summed until read (main.ts's perf lines). */
export const drawProf = { conv: 0, len: 0 };

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
    drawProf.conv += clock() - t;
    drawProf.len += list.length;
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
