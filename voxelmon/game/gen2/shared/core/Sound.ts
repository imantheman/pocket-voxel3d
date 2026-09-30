// gen1recomp src/core/Sound.lua at bdfac727 (MIT): sound effects and cries,
// the Gen 2 paths.
//
// The Lua renders each chip program into a LÖVE Source and plays that. Here
// the core's synth plays it (crates/pocketvoxel-core audio.rs, engine
// AUDIO_ENGINE_GEN2): this module resolves a name to (bank slot, address,
// engine) and emits the `sfx` / `cry` op through the host the entry installs
// with `Sound.setHost(host)`. Nothing here computes a sample.
//
// What a Source answered -- isPlaying, getDuration, tell -- a SoundHandle
// answers from the program's measured length (cook/gen2audio.ts writes
// `frames` into the audio table) against a 60 Hz clock that Music.update
// ticks, the same VBlank cadence _UpdateSound runs on (Game2.lua:1290-1296).
// So WaitSFX, WaitPlaySFX and the priority gate behave the same on a host
// that never renders a sample.
//
// The synth has ONE one-shot voice, as in Gen 1's port: a new sfx or cry
// replaces whatever one-shot was sounding, and the handle it replaced reads
// as stopped. On the cart Gen 2's gated path never layers sfx anyway
// (:330-346); what is lost is a cry or a battle-animation sound overlapping
// another one-shot.
//
// Dropped, as desktop-only or Gen 1-only: file defs and widenMono (:86-144,
// every Gold def is a chip program), the per-source volume and rate
// (:16-43, :162-185 -- stored, not applied), mod ownership logging beyond a
// Logger line (:67-80), Yellow's Pikachu clips (:712-745; Gold has none),
// and pokered's MoveSoundTable channel gate (:482-674), which Gen 2 never
// calls -- playMove here plays the row's sound with its modifiers, ungated.

import {
  AUDIO_ENGINE_GEN2,
  AUDIO_SFX_FLAG,
  AUDIO_SFX_TEMPO,
} from "../../../../../contracts/spec/voxel-spec.ts";
import { loadGenerated } from "../../platform/data.ts";
import { Logger } from "./Logger.ts";
import { Music } from "./Music.ts";

// ---------------------------------------------------------------------------
// The audio table (import/gen2/audio.ts + cook/gen2audio.ts)
// ---------------------------------------------------------------------------

/** A program header: Brian's {bank, address, generation} plus the cook's
 * measured length. `engine` is a Gen 1 def's own engine id. */
export interface AudioDef {
  bank: number;
  address: number;
  generation?: number;
  engine?: number;
  fanfare?: boolean;
  /** 60 Hz frames the program sounds for (cook/gen2audio.ts). */
  frames?: number;
  /** Channels its header claims (cook/gen2audio.ts). */
  channelCount?: number;
}

export interface CryDef {
  header?: AudioDef;
  /** A derived cry borrowing another species' program (:676-697). */
  base?: string;
  pitch?: number;
  length?: number;
  frames?: number;
}

export interface AudioTable {
  generation?: number;
  bankOrder?: number[];
  songs?: Record<string, AudioDef>;
  sfx?: Record<string, AudioDef>;
  sfxOrder?: string[];
  fanfares?: Record<string, boolean>;
  cries?: Record<string, CryDef>;
  mapSongs?: Record<string, string>;
  waveBanks?: Record<string, { bank: number; address: number }>;
  drumkits?: { bank: number; address: number };
  special?: Record<string, string>;
  battle?: Record<string, string>;
  outdoorSongs?: Record<string, boolean>;
  pikaCries?: number;
}

/** Game2's `self.data`: `data.audio` is `loadGenerated("audio")`
 * (Game2.lua:1026). Absent, the generated table is read directly. */
export interface SoundData {
  audio?: AudioTable;
  [k: string]: unknown;
}

export function audioOf(data: SoundData | null | undefined): AudioTable {
  if (data && data.audio !== undefined) return data.audio ?? {};
  return loadGenerated<AudioTable>("audio") ?? {};
}

// ---------------------------------------------------------------------------
// The host seam
// ---------------------------------------------------------------------------

/**
 * The audio ops (contracts/spec/voxel-spec.ts §audio). VoxelHost has all of
 * them; the Gold entry hands its host to `Sound.setHost`.
 */
export interface AudioHost {
  music(bank: number, addr: number, engine: number, flags: number): void;
  musicStop(): void;
  musicFade(ticks: number): void;
  sfx(bank: number, addr: number, engine: number, pitch: number, tempo: number, flags: number): void;
  cry(bank: number, addr: number, engine: number, pitch: number, length: number): void;
  audioWaves(engine: number, bank: number, addr: number): void;
  audioDrum(engine: number, drum: number, bank: number, addr: number): void;
}

let host: AudioHost | null = null;
/** The table whose engine tables were pinned on `host`. */
let pinnedFor: AudioTable | null = null;

/** A resolved program, in the numbers an audio op carries. */
export interface ProgramRef {
  bank: number;
  address: number;
  engine: number;
}

/** A def's op arguments, or null when its bank is not in programs.bin. */
export function programRef(audio: AudioTable, def: AudioDef | undefined): ProgramRef | null {
  if (!def || typeof def.address !== "number") return null;
  const slot = (audio.bankOrder ?? []).indexOf(def.bank);
  if (slot < 0) return null;
  const engine = def.generation === 2 || audio.generation === 2 ? AUDIO_ENGINE_GEN2 : (def.engine ?? 1);
  return { bank: slot, address: def.address, engine };
}

/**
 * The host, with Gold's engine tables pinned on it first: the ten wave
 * instruments and the Drumkits table (voxel-spec.ts AUDIO_ENGINE_GEN2) --
 * what ChipSynth.newEngine reads out of `audio.waveBanks` / `audio.drumkits`
 * for every song (ChipSynth.lua@bdfac727:1251-1290). Boot-time facts, sent
 * once per host and table.
 */
function liveHost(audio: AudioTable): AudioHost | null {
  if (!host) return null;
  if (pinnedFor !== audio) {
    pinnedFor = audio;
    const order = audio.bankOrder ?? [];
    const wave = audio.waveBanks?.["1"];
    if (wave && order.includes(wave.bank)) {
      host.audioWaves(AUDIO_ENGINE_GEN2, order.indexOf(wave.bank), wave.address);
    }
    const kits = audio.drumkits;
    if (kits && order.includes(kits.bank)) {
      host.audioDrum(AUDIO_ENGINE_GEN2, 0, order.indexOf(kits.bank), kits.address);
    }
  }
  return host;
}

// ---------------------------------------------------------------------------
// Handles: what a Source answered
// ---------------------------------------------------------------------------

/** The 60 Hz audio clock (Music.update ticks it). */
let clock = 0;
/** The handle that owns the synth's one-shot voice. */
let voice: SoundHandle | null = null;

/**
 * A playing one-shot. `frames` is its measured length; undefined when the
 * table carries none (the Lua's unknown duration, :191-193).
 */
export class SoundHandle {
  readonly start = clock;
  private stopped = false;
  constructor(
    readonly key: string,
    readonly frames: number | undefined,
    readonly loop = false,
  ) {}

  /** Frames since it started. */
  elapsed(): number {
    return clock - this.start;
  }

  /** Source:isPlaying — it has the voice and has not run out. The Source
   * holds F frames of audio and the one sample in which the synth finds the
   * program over, so it is still playing on the F-th tick. */
  isPlaying(): boolean {
    if (this.stopped) return false;
    if (this.loop) return true; // the siren is its own voice
    if (voice !== this) return false;
    return this.elapsed() <= (this.frames ?? 0);
  }

  /** Source:stop — cut it if it is still what the synth is playing. */
  stop(): void {
    if (this.isPlaying() && host) {
      const flags = this.loop ? AUDIO_SFX_FLAG.alarm | AUDIO_SFX_FLAG.stop : AUDIO_SFX_FLAG.stop;
      host.sfx(0, 0, 0, 0, 0, flags);
    }
    this.stopped = true;
    if (voice === this) voice = null;
  }

  /** Source:getDuration, in seconds; undefined when unknown. */
  getDuration(): number | undefined {
    return this.frames === undefined ? undefined : (this.frames * 735 + 1) / 44100;
  }

  /** Source:tell, in seconds. */
  tell(): number {
    return this.elapsed() / 60;
  }
}

const ALARM = "Low_Health_Alarm";

// ---------------------------------------------------------------------------
// Sound.lua state
// ---------------------------------------------------------------------------

/** Last handle per cache key (:15 `cache`); false = a def that failed. */
const cache = new Map<string, SoundHandle | false>();
/** :16-26 — port additions, kept for the options menu; not applied. */
let volumeScale = 1;
let pikaScale = 1;
/** :167-168 */
const FF_PITCH_MAX = 4;
let rate = 1;

/** :56-65 — Gen 1's fallback fanfare names; Gold's table has its own. */
const FANFARES: Record<string, boolean> = {
  Level_Up: true,
  Caught_Mon: true,
  Get_Item1: true,
  Get_Item2: true,
  Get_Key_Item: true,
  Pokedex_Rating: true,
  Dex_Page_Added: true,
  Pokeflute: true,
};

/** :235-238 — three-channel jingles that still silence the song. */
const GEN2_JINGLES: Record<string, boolean> = {
  Sfx_Fanfare: true,
  Sfx_Fanfare2: true,
  Sfx_3rdPlace: true,
  Sfx_TrainArrived: true,
};
/** :239 */
const FULL_BAND = 4;

/** :306 — the hop resolve() took for a raw name. */
const aliased = new Map<string, string>();
/** :347-348 — label -> SFX id, and wCurSFX. */
let sfxIds: Map<string, number> | null = null;
let curSfx: { src: SoundHandle; id: number; press?: boolean } | null = null;

const looping = new Map<string, SoundHandle>();

function reportBadDef(kind: string, key: string, err: string): void {
  // :76-80 — one line; there are no mods to attribute it to
  Logger.warn("audio: bad %s def %q (mod %s): %s", kind, key, "base", err);
}

/** :242-263 claimsEveryChannel — a Gen 2 sfx whose header claims all four
 * channels replaces the song. The count comes from the cook; a table
 * without it answers "not knowable here", i.e. no. */
function claimsEveryChannel(def: AudioDef | undefined): boolean {
  if (!def || typeof def.address !== "number") return false;
  if (def.generation !== 2) return false;
  return (def.channelCount ?? 0) >= FULL_BAND;
}

/** :265-271 */
function ducks(data: SoundData, name: string, def: AudioDef | undefined): boolean {
  if (def?.fanfare) return true;
  const fanfares = audioOf(data).fanfares ?? FANFARES;
  if (fanfares[name]) return true;
  if (GEN2_JINGLES[name]) return true;
  return claimsEveryChannel(def);
}

/** :350-360 — sfxOrder is audio/sfx_pointers.asm in order: id = index. */
function sfxIdFor(data: SoundData, name: string): number | undefined {
  const order = audioOf(data).sfxOrder;
  if (!order) return undefined;
  if (!sfxIds) {
    sfxIds = new Map();
    order.forEach((label, index) => sfxIds!.set(label, index));
  }
  return sfxIds.get(name);
}

/** :366-384 sfxPriorityGate — home/audio.asm PlaySFX: a lower id already
 * sounding drops the new one; otherwise _PlaySFX silences ch5-ch8 first. */
function sfxPriorityGate(data: SoundData, name: string, def: AudioDef | undefined): [boolean, number?] {
  if (!def || def.generation !== 2) return [true];
  const id = sfxIdFor(data, name);
  if (id === undefined) return [true];
  if (curSfx) {
    if (!curSfx.src.isPlaying()) {
      curSfx = null;
    } else if (curSfx.id < id) {
      return [false];
    } else {
      curSfx.src.stop();
      curSfx = null;
    }
  }
  return [true, id];
}

/**
 * :199-219 playPath — start `def` on the synth under cache key `key`.
 * `pitch` / `tempo` are newSfx's modifiers (ChipAudio.lua:637-644).
 */
function playPath(
  data: SoundData,
  key: string,
  def: AudioDef | undefined,
  duck: boolean,
  pitch = 0,
  tempo = AUDIO_SFX_TEMPO,
): SoundHandle | null {
  const audio = audioOf(data);
  const h = liveHost(audio);
  if (!h || !def) return null;
  if (cache.get(key) === false) return null; // known bad, already logged
  const ref = programRef(audio, def);
  if (!ref) {
    cache.set(key, false);
    reportBadDef("sfx", key, "no chip program in programs.bin");
    return null;
  }
  const prior = cache.get(key);
  if (prior) prior.stop(); // :215 src:stop before src:play
  h.sfx(ref.bank, ref.address, ref.engine, pitch, tempo, duck ? AUDIO_SFX_FLAG.duck : 0);
  const src = new SoundHandle(key, def.frames);
  voice = src;
  cache.set(key, src);
  return src;
}

/** :447-455 startSfx */
function startSfx(data: SoundData, name: string, def: AudioDef | undefined): SoundHandle | null {
  const duck = def !== undefined && ducks(data, name, def);
  const src = playPath(data, name, def, duck);
  if (!src) return null;
  if (duck) Music.duckForFanfare(src);
  return src;
}

/** :321-328 — the handle a raw name plays through, whichever key it has. */
function cached(name: string): SoundHandle | null {
  let src = cache.get(name);
  if (src === undefined) {
    const key = aliased.get(name);
    if (key) src = cache.get(key);
  }
  return src || null;
}

/** :679-697 resolveCry — follow `base` chains; nearest modifiers win. */
function resolveCry(data: SoundData, def: CryDef | undefined, depth: number): [CryDef | null, string?] {
  if (!def || !def.base) return [def ?? null];
  if (depth > 8) return [null, "cry base chain too deep"];
  const baseDef = audioOf(data).cries?.[def.base];
  if (!baseDef) return [null, `unknown base cry ${def.base}`];
  const [resolved, err] = resolveCry(data, baseDef, depth + 1);
  if (!resolved) return [null, err];
  if (!resolved.header) return [null, `base cry ${def.base} is not a chip program`];
  return [
    {
      header: resolved.header,
      pitch: def.pitch ?? resolved.pitch,
      length: def.length ?? resolved.length,
      frames: def.length === undefined ? resolved.frames : def.frames,
    },
  ];
}

export const Sound = {
  /** :299-301 — shared-module pokered names -> what Gold plays there. */
  GEN2_ALIASES: { Press_AB: "Sfx_ReadText2" } as Record<string, string>,

  // --- the seam (ours) -----------------------------------------------------

  /** Install the host the audio ops go to (the Gold entry), or null for
   * headless -- the Lua's `not love.audio`, where every play is a no-op. */
  setHost(h: AudioHost | null): void {
    host = h;
    pinnedFor = null;
  },

  host(): AudioHost | null {
    return host;
  },

  /** The host with this table's engine tables pinned on it (Music plays
   * through this). */
  hostFor(data: SoundData | null | undefined): AudioHost | null {
    return liveHost(audioOf(data));
  },

  /** One 60 Hz audio frame. Music.update calls it (Game2.lua:1295). */
  tick(): void {
    clock += 1;
  },

  /** The audio clock, in frames. */
  now(): number {
    return clock;
  },

  // --- Sound.lua -------------------------------------------------------------

  /** :170-177 */
  setRate(n: unknown): void {
    const v = Number(n);
    rate = Number.isFinite(v) && v > 0 ? Math.min(v, FF_PITCH_MAX) : 1;
  },

  rate(): number {
    return rate;
  },

  /** :188-197 WaitForSoundToFinish budget (home/delay.asm:14). */
  waitFrames(src: SoundHandle | null | undefined, fallback?: number): number {
    if (!src) return 0;
    const dur = src.getDuration();
    if (dur === undefined || !(dur > 0)) return fallback ?? 180;
    return Math.ceil(dur * 60 * rate) + 2;
  },

  /** :275-279 */
  ducksMusic(data: SoundData, name: string): boolean {
    const sfx = audioOf(data).sfx;
    name = Sound.resolve(data, name);
    return ducks(data ?? {}, name, sfx?.[name]);
  },

  /** :308-318 */
  resolve(data: SoundData, name: string): string {
    const sfx = audioOf(data).sfx;
    if (!sfx) return name;
    if (sfx[name]) return name;
    const alias = Sound.GEN2_ALIASES[name];
    if (alias && sfx[alias]) {
      aliased.set(name, alias);
      return alias;
    }
    return name;
  },

  /** :394-402 CheckSFX */
  sfxBusy(): boolean {
    if (!curSfx) return false;
    if (!curSfx.src.isPlaying()) {
      curSfx = null;
      return false;
    }
    return true;
  },

  /** :405-417, in seconds */
  sfxRemaining(): number | undefined {
    if (!curSfx) return 0;
    if (!curSfx.src.isPlaying()) {
      curSfx = null;
      return 0;
    }
    const dur = curSfx.src.getDuration();
    if (dur === undefined) return undefined;
    return Math.max(0, dur - curSfx.src.tell());
  },

  /** :420-424 */
  playPress(data: SoundData): SoundHandle | null {
    const src = Sound.play(data, "Press_AB");
    if (src && curSfx && curSfx.src === src) curSfx.press = true;
    return src;
  },

  /** :426-430 */
  dropPressSfx(): void {
    if (!(curSfx && curSfx.press)) return;
    curSfx.src.stop();
    curSfx = null;
  },

  /** :434-438 WaitSFX's drain */
  waitSfxDone(): void {
    if (!curSfx) return;
    curSfx.src.stop();
    curSfx = null;
  },

  /** :441-445 SFXChannelsOff */
  sfxChannelsOff(): void {
    if (!curSfx) return;
    curSfx.src.stop();
    curSfx = null;
  },

  /** :461-470 — PlaySFX, behind the priority gate. */
  play(data: SoundData, name: string): SoundHandle | null {
    const sfx = audioOf(data).sfx;
    name = Sound.resolve(data, name);
    const def = sfx?.[name];
    const [allowed, id] = sfxPriorityGate(data, name, def);
    if (!allowed) return null;
    const src = startSfx(data, name, def);
    if (src && id !== undefined) curSfx = { src, id };
    return src;
  },

  /** :476-480 PlayStereoSFX — no gate, never becomes wCurSFX. */
  playStereo(data: SoundData, name: string): SoundHandle | null {
    const sfx = audioOf(data).sfx;
    name = Sound.resolve(data, name);
    return startSfx(data, name, sfx?.[name]);
  },

  /** :575-579 */
  moveSfxBusy(): boolean {
    return moveSfx !== null && moveSfx.isPlaying();
  },

  /** :581-598 */
  moveSfxWaitFrames(): number {
    if (!moveSfx || !moveSfx.isPlaying()) return 0;
    const left = Math.max(0, (moveSfx.frames ?? 0) - moveSfx.elapsed());
    return Math.ceil(left * rate) + 2;
  },

  /** :635-674, without pokered's channel gate (see the top). */
  playMove(data: SoundData, anim: { sound?: string; pitch?: number; tempo?: number } | null | undefined): void {
    if (!anim || !anim.sound) return;
    const sfx = audioOf(data).sfx;
    if (!sfx) return;
    const name = anim.sound;
    const pitch = anim.pitch ?? 0;
    const tempo = anim.tempo ?? 0x80;
    const key = `${name}@${pitch.toString(16).padStart(2, "0")}${tempo.toString(16).padStart(2, "0")}`;
    const src = playPath(data, key, sfx[name], false, pitch, tempo);
    if (src) moveSfx = src;
  },

  /** :716-745 — Yellow's voiced clips; Gold has none. */
  playPikaCry(_data: SoundData, _n?: number): SoundHandle | null {
    return null;
  },

  /** :749-787 — the species cry with its pitch and length. */
  playCry(data: SoundData, species: string, pikaClip?: number): SoundHandle | null {
    if (species === "PIKACHU") {
      const src = Sound.playPikaCry(data, pikaClip ?? 1);
      if (src) return src;
    }
    const audio = audioOf(data);
    const h = liveHost(audio);
    if (!h) return null;
    const def = audio.cries?.[species];
    if (!def) return null;
    const key = `cry:${species}`;
    if (cache.get(key) === false) return null;
    const [resolved, err] = resolveCry(data, def, 0);
    const ref = resolved && programRef(audio, resolved.header);
    if (!resolved || !ref) {
      cache.set(key, false);
      reportBadDef("cry", species, err ?? "no chip program in programs.bin");
      return null;
    }
    const prior = cache.get(key);
    if (prior) prior.stop();
    // ChipAudio.lua@bdfac727:649-656 newCry: frequencyOffset = pitch,
    // cryLength = length (the tempo word itself in Gen 2)
    h.cry(ref.bank, ref.address, ref.engine, resolved.pitch ?? 0, resolved.length ?? 0);
    const src = new SoundHandle(key, resolved.frames);
    voice = src;
    cache.set(key, src);
    return src;
  },

  /** :799-805 — DEVIATION: the move's extra tempo shift was a Source rate
   * change; the synth has no such knob, so the cry plays as the species'. */
  playMoveCry(data: SoundData, species: string, _tempoMod?: number): SoundHandle | null {
    return Sound.playCry(data, species);
  },

  /** :810-815 */
  isPlaying(name: string): boolean {
    const src = cached(name);
    return src ? src.isPlaying() : false;
  },

  /** :818-822 */
  waitFramesFor(name: string, fallback?: number): number {
    const src = cached(name);
    if (!src) return 0;
    return Sound.waitFrames(src, fallback);
  },

  /** :826-829 */
  stop(name: string): void {
    const src = cached(name);
    if (src) src.stop();
  },

  /** :837-868 — the low-health siren is the core's own voice
   * (AUDIO_SFX_FLAG.alarm). DEVIATION: any other def cannot loop on the
   * synth and plays once. */
  startLoop(data: SoundData, name: string): void {
    if (looping.has(name)) return;
    const audio = audioOf(data);
    const h = liveHost(audio);
    if (!h) return;
    const def = audio.sfx?.[name];
    const alarm = !def && name === ALARM;
    if (!def && !alarm) return;
    if (alarm) {
      h.sfx(0, 0, 0, 0, 0, AUDIO_SFX_FLAG.alarm);
      looping.set(name, new SoundHandle(ALARM, undefined, true));
      return;
    }
    const src = playPath(data, name, def, false);
    if (src) looping.set(name, src);
  },

  /** :870-876 */
  stopLoop(name: string): void {
    const src = looping.get(name);
    if (!src) return;
    looping.delete(name);
    if (src.key === ALARM) {
      host?.sfx(0, 0, 0, 0, 0, AUDIO_SFX_FLAG.alarm | AUDIO_SFX_FLAG.stop);
    } else {
      src.stop();
    }
  },

  /** :879-881 */
  isLooping(name: string): boolean {
    return looping.has(name);
  },

  /** :895-898 — kept; the synth has no per-bus volume. */
  setVolumeLevel(level?: number): void {
    volumeScale = Math.max(0, Math.min(7, level ?? 7)) / 7;
  },

  /** :903-906 */
  setPikaVolumeLevel(level?: number): void {
    pikaScale = Math.max(0, Math.min(7, level ?? 7)) / 7;
  },

  /** The stored 0..1 scales (the options menu reads them back). */
  volumeLevels(): { sfx: number; pika: number } {
    return { sfx: volumeScale, pika: pikaScale };
  },

  /** :910-938 */
  invalidate(name?: string): void {
    moveSfx = null;
    curSfx = null;
    sfxIds = null;
    if (name) aliased.delete(name);
    else aliased.clear();
    for (const key of [...cache.keys()]) {
      if (!name || key === name || key.startsWith(`${name}@`)) {
        const src = cache.get(key);
        if (src) src.stop();
        cache.delete(key);
      }
    }
    for (const [key] of [...looping]) {
      if (!name || key === name) Sound.stopLoop(key);
    }
  },

  /** :944-946 */
  onDeviceReset(): void {
    Sound.invalidate();
  },

  /** :950-953 */
  applyOptions(opts?: { sfxVol?: number; pikaVol?: number } | null): void {
    Sound.setVolumeLevel(opts?.sfxVol ?? 7);
    Sound.setPikaVolumeLevel(opts?.pikaVol ?? 7);
  },

  /** Tests: forget every handle, the clock and the host. */
  _resetForTest(): void {
    cache.clear();
    aliased.clear();
    looping.clear();
    sfxIds = null;
    curSfx = null;
    moveSfx = null;
    voice = null;
    clock = 0;
    host = null;
    pinnedFor = null;
    rate = 1;
  },
};

/** The last move row that sounded (:504's table, collapsed to one voice). */
let moveSfx: SoundHandle | null = null;

export default Sound;
