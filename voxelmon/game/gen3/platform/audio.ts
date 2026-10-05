// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). The sound seam. gen1recomp's core/game3/audio.lua runs
// its M4A engine in a worker thread and plays the PCM through LÖVE sources;
// here the engine is the host's (crates/pocketvoxel-core/src/gen3, the same
// engine ported to Rust, sample-identical), and the guest's audio.ts keeps
// Brian's policy -- what plays when, fades, ducking, the fanfare countdown --
// and calls these. Method names follow the Rust `M4a` API.

export interface CryParams {
  mode: number;
  /** Fields as the engine's CryParams::from_mode returns them; the profile may override any. */
  [field: string]: number;
}

export interface SeOptions { looping?: boolean; maxSec?: number; pan?: number; gain?: number }

export interface G3Audio {
  playSong(id: number): void;
  stopSong(): void;
  pauseSong(): void;
  resumeSong(): void;
  /** The BGM gain (audio.lua's bgm_gain(): volume x fade x duck). */
  setSongVolume(gain: number): void;
  /** The song now playing, or -1. */
  song(): number;
  songPaused(): boolean;
  setMono(mono: boolean): void;

  playSe(id: number, opts: SeOptions): void;
  /** Stop one SE id, or every SE when id is undefined. */
  stopSe(id?: number): void;
  sePlaying(id?: number): boolean;
  setSePan(pan: number): void;

  /** Play a fanfare; it pauses the song as the engine does. */
  playFanfare(id: number, volume: number): void;
  fanfarePlaying(): boolean;
  stopFanfare(): void;

  /** Play a cry; the frames the guest's cry timer should wait, or undefined. */
  playCry(species: number, params: CryParams, pan: number, volume: number): number | undefined;
  stopCry(): void;
  cryPlaying(): boolean;

  stopAll(): void;
}

/** A silent engine that keeps state (tests, and a host without sound). */
export function silentAudio(): G3Audio & { log: string[] } {
  let song = -1, paused = false;
  const log: string[] = [];
  return {
    log,
    playSong: (id) => { song = id; paused = false; log.push(`song ${id}`); },
    stopSong: () => { song = -1; log.push("stop song"); },
    pauseSong: () => { paused = true; },
    resumeSong: () => { paused = false; },
    setSongVolume: () => {},
    song: () => song,
    songPaused: () => paused,
    setMono: () => {},
    playSe: (id) => { log.push(`se ${id}`); },
    stopSe: () => {},
    sePlaying: () => false,
    setSePan: () => {},
    playFanfare: (id) => { log.push(`fanfare ${id}`); },
    fanfarePlaying: () => false,
    stopFanfare: () => {},
    playCry: (species) => { log.push(`cry ${species}`); return 0; },
    stopCry: () => {},
    cryPlaying: () => false,
    stopAll: () => { song = -1; },
  };
}

let audio: G3Audio = silentAudio();

export function setAudio(a: G3Audio | undefined): void { audio = a ?? silentAudio(); }
export function getAudio(): G3Audio { return audio; }

export const AudioSeam = { setAudio, getAudio, silentAudio };
export default AudioSeam;
