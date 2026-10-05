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

/** The other natives' calls and time (us), summed until main.ts's perf line reads them. */
export const nativeProf = { up: 0, upUs: 0, upKB: 0, cache: 0, cacheUs: 0, rd: 0, rdUs: 0, ex: 0, exUs: 0, au: 0, auUs: 0, auTop: {} as Record<string, number> };

/**
 * Cache reads while `on` (main.ts turns it on for Game3.load): each read's
 * path, size, the host's time for it, and the time until the next read (the
 * guest's work on that file), in microseconds.
 */
export const readProf = {
  on: false,
  list: [] as { path: string; size: number; host: number; after: number; t: number }[],
  /** Close the last read's `after` now. */
  close(): void {
    const l = readProf.list[readProf.list.length - 1];
    if (l && l.after < 0) l.after = clock() - l.t;
  },
};

class QuickJsG3Host implements G3Host {
  texUpload(id: number, w: number, h: number, rgba: Uint8Array, repeat: boolean): void {
    const t = clock();
    n.g3TexUpload!(id, w, h, rgba, repeat);
    nativeProf.up++; nativeProf.upUs += clock() - t; nativeProf.upKB += (w * h * 4) / 1024;
  }
  texFromCache(id: number, path: string): [number, number] | undefined {
    const t = clock();
    const r = n.g3TexFromCache!(id, path);
    nativeProf.cache++; nativeProf.cacheUs += clock() - t;
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
  read(path: string): string | undefined {
    if (!readProf.on) {
      const t = clock();
      const s = n.g3Read!(path);
      nativeProf.rd++; nativeProf.rdUs += clock() - t;
      return s;
    }
    readProf.close();
    const t = clock();
    const s = n.g3Read!(path);
    const t2 = clock();
    readProf.list.push({ path, size: s?.length ?? -1, host: t2 - t, after: -1, t: t2 });
    return s;
  }
  exists(path: string): boolean {
    const t = clock();
    const r = n.g3Exists!(path);
    nativeProf.ex++; nativeProf.exUs += clock() - t;
    return r;
  }
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
if (n.g3SongPlay && n.g3AudioReady?.()) {
  const a = new QuickJsG3Audio() as unknown as Record<string, (...x: unknown[]) => unknown>;
  // every sound native call counted and timed (main.ts's perf lines)
  for (const k of Object.getOwnPropertyNames(QuickJsG3Audio.prototype)) {
    if (k === "constructor") continue;
    const f = a[k]!;
    a[k] = (...x: unknown[]): unknown => {
      const t = clock();
      try { return f.apply(a, x); } finally {
        nativeProf.au++; nativeProf.auUs += clock() - t;
        nativeProf.auTop[k] = (nativeProf.auTop[k] ?? 0) + 1;
      }
    };
  }
  setAudio(a as unknown as G3Audio);
}
console.log(`[pv] g3 sound: guest audio ${n.g3SongPlay ? (n.g3AudioReady?.() ? "on the host engine" : "silent (host has no pack)") : "silent (no natives)"}`);
