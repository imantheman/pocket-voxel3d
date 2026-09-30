// gen1recomp src/core/Music.lua at bdfac727 (MIT): what plays where, the
// Gen 2 paths.
//
// The Lua starts a chip song through ChipAudio.playMusic and then steers the
// Source it gets back: volume ramps, pause for a fanfare, "has the jingle
// ended". Here the core's synth plays the song (audio.rs, engine
// AUDIO_ENGINE_GEN2) and the guest emits one op per state change through
// Sound's host (`Sound.setHost`):
//
//   Music.play      -> music(bank, addr, engine, loop | stereo)
//   same song while a queued fade runs -> music(... | resume): no restart,
//                      the fade is cancelled back to full (:242-250)
//   Music.fadeOut   -> musicFade(control): the synth walks rAUDVOL 7 -> 0 on
//                      its tick clock, exactly FadeOutAudio's steps; this
//                      module walks the same count in update() to know when
//                      to start the queued song (:589-615)
//   a fanfare       -> the synth holds the song itself (the sfx op's `duck`
//                      flag, ChipAudio.holdMusic); state.fanfare only tracks
//                      when it ends
//   Music.stop      -> musicStop()
//
// A song's "Source" is a MusicHandle whose length is the cook's measured
// one-pass length for a playOnce jingle (cook/gen2audio.ts) and endless for
// a looping song.
//
// Dropped as desktop-only: file-backed songs and intro/loop chaining
// (:183-206, :629-634 -- every Gold song is a chip program), the volume and
// low-pass filter (stored for the options menu, not applied: the synth has
// no bus volume), setPitch, the mod hooks (Runtime's null bus runs vanilla),
// Gen 1's alternate tempo / rival start (:208-212, :267-286; Gold has
// neither) and the threaded worker's first-buffer race (:465-468).

import { AUDIO_MUSIC_FLAG } from "../../../../../contracts/spec/voxel-spec.ts";
import { Runtime } from "../mods/Runtime.ts";
import { Logger } from "./Logger.ts";
import { Sound, type AudioDef, type SoundData, type SoundHandle, audioOf, programRef } from "./Sound.ts";

/** A playing song. `frames` is undefined for a looping song. */
class MusicHandle {
  /** Frames the song has actually advanced (a fanfare holds it). */
  played = 0;
  constructor(readonly frames: number | undefined) {}
  /** Source:isPlaying — a one-pass song stops after its last channel. */
  isPlaying(): boolean {
    return this.frames === undefined || this.played <= this.frames;
  }
}

interface Pending {
  data: SoundData;
  song: string;
  loop?: boolean;
  ctx: PlayCtx;
}

interface Fade {
  control: number;
  counter: number;
  level: number;
  pending?: Pending;
}

export interface PlayCtx {
  reason?: string;
  mapId?: string;
  fade?: number;
  kind?: string;
  trainerId?: unknown;
  tempo?: number;
  start?: string;
  selected?: boolean;
}

const state = {
  current: null as string | null,
  source: null as MusicHandle | null,
  mapSong: null as string | null,
  onBike: false,
  surfing: false,
  pendingRestore: false,
  restoreLeft: null as number | null,
  fanfare: null as SoundHandle | null,
  fanfareResume: false,
  fade: null as Fade | null,
  tempo: undefined as number | undefined,
  start: undefined as string | undefined,
  data: null as SoundData | null,
  loop: undefined as boolean | undefined,
  /** The program the synth is playing (for `resume`). */
  ref: null as { bank: number; address: number; engine: number; flags: number } | null,
  failed: new Set<string>(),
};

/** :6-10 — port additions, stored only. */
let volumeScale = 1;
let filterLevel = 0;
/** engine/menus/options_menu.asm SOUND: STEREO (ChipAudio.setStereo). */
let stereo = false;

/** :74-82 fanfareActive — the synth resumes the song by itself. */
function fanfareActive(): boolean {
  const src = state.fanfare;
  if (!src) return false;
  if (src.isPlaying()) return true;
  state.fanfare = null;
  return false;
}

/** :102-119 — Gen 1's outdoor themes (Gen 2 has no outdoor gate). */
const OUTDOOR: Record<string, boolean> = {
  Music_PalletTown: true,
  Music_Cities1: true,
  Music_Cities2: true,
  Music_Celadon: true,
  Music_Cinnabar: true,
  Music_Vermilion: true,
  Music_Lavender: true,
  Music_Routes1: true,
  Music_Routes2: true,
  Music_Routes3: true,
  Music_Routes4: true,
  Music_IndigoPlateau: true,
  Music_SafariZone: true,
  Music_Dungeon1: true,
  Music_Dungeon2: true,
  Music_Dungeon3: true,
};

/** :123-133 */
const SPECIAL: Record<string, string> = {
  heal: "Music_PkmnHealed",
  title: "Music_TitleScreen",
  credits: "Music_Credits",
  hallOfFame: "Music_HallOfFame",
  introBattle: "Music_IntroBattle",
  oakRoute: "Music_Routes2",
  bike: "Music_BikeRiding",
  surf: "Music_Surfing",
  evolution: "Music_SafariZone",
};

/** :136-140 SpecialMapMusic (pokegold home/audio.asm:397) */
const SPECIAL_GEN2: Record<string, string> = {
  surf: "Music_Surf",
  bike: "Music_Bicycle",
  evolution: "Music_Evolution",
};

function songDef(data: SoundData | null | undefined, song: string | null | undefined): AudioDef | undefined {
  return song ? audioOf(data).songs?.[song] : undefined;
}

/** :216-229 selectSong — the mod hook's null bus. */
function selectSong(song: string, ctx: PlayCtx): string {
  if (ctx.selected) return song;
  if (!Runtime.wantsHook("music.select")) return song;
  return Runtime.call("music.select", (chosen: string) => chosen, song);
}

function musicFlags(loop: boolean): number {
  return (loop ? AUDIO_MUSIC_FLAG.loop : 0) | (stereo ? AUDIO_MUSIC_FLAG.stereo : 0);
}

/** :379-392 effectiveMapSong — Gen 2 has no outdoor gate. */
function effectiveMapSong(data: SoundData | null | undefined, song: string | null | undefined): string | null {
  if (!song) return song ?? null;
  const gen2 = audioOf(data).generation === 2;
  const outdoor = audioOf(data).outdoorSongs ?? OUTDOOR;
  if (!gen2 && !outdoor[song]) return song;
  if (state.onBike) {
    const bike = Music.special(data, "bike");
    if (bike && songDef(data, bike)) return bike;
  }
  if (state.surfing) {
    const surf = Music.special(data, "surf");
    if (surf && songDef(data, surf)) return surf;
  }
  return song;
}

/** :448 scripts/RedsHouse1F.asm:35-38 */
const ONE_SHOT_CEILING = 600;

export const Music = {
  /** :375 */
  MAP_FADE: 10,
  ONE_SHOT_CEILING,

  /** :87-100 — a fanfare owns the music channels; the synth holds the song
   * (the sfx op carried `duck`) and this remembers when to let go. */
  duckForFanfare(src: SoundHandle | null): void {
    if (!src) return;
    state.fanfare = src;
    if (state.source && state.source.isPlaying()) state.fanfareResume = true;
  },

  /** :144-153 */
  special(data: SoundData | null | undefined, key: string): string | undefined {
    const audio = audioOf(data);
    const label = audio.special?.[key];
    if (label !== undefined) return label;
    if (audio.generation === 2 && SPECIAL_GEN2[key] !== undefined) return SPECIAL_GEN2[key];
    return SPECIAL[key];
  },

  /** :231-332 */
  play(data: SoundData, song: string | null | undefined, loop?: boolean, ctx?: PlayCtx): void {
    if (!song) return;
    const host = Sound.hostFor(data);
    if (!host) return; // headless test stub (:233)
    ctx = ctx ?? {};
    song = selectSong(song, ctx);
    const tempo = ctx.tempo;
    const start = ctx.start;
    if (!song) return;
    if (song === state.current && tempo === state.tempo && start === state.start) {
      // ..(home/audio.asm ln 65) — a queued fade is called off
      if (state.fade && state.fade.pending) {
        state.fade = null;
        if (state.ref) {
          const r = state.ref;
          host.music(r.bank, r.address, r.engine, r.flags | AUDIO_MUSIC_FLAG.resume);
        }
      }
      return;
    }
    const def = songDef(data, song);
    if (!def || state.failed.has(song)) return;

    if (ctx.fade && state.source) {
      const queued: PlayCtx = { ...ctx, fade: undefined, selected: true };
      const pending: Pending = { data, song, loop, ctx: queued };
      if (state.fade) state.fade.pending = pending;
      else Music.fadeOut(ctx.fade, pending);
      return;
    }
    const wantLoop = loop !== false;
    // :192-206 startSong — a chip program is the only kind Gold has
    const ref = programRef(audioOf(data), def);
    if (!ref) {
      state.failed.add(song);
      Logger.warn("audio: bad song def %q (mod %s): %s", song, "base", "no chip program in programs.bin");
      return;
    }
    const flags = musicFlags(wantLoop);
    host.music(ref.bank, ref.address, ref.engine, flags);
    state.fade = null;
    // :314-315 — under a fanfare the synth holds the new song until it ends
    if (fanfareActive()) state.fanfareResume = true;
    state.source = new MusicHandle(wantLoop ? undefined : def.frames ?? 0);
    state.ref = { ...ref, flags };
    state.current = song;
    state.tempo = tempo;
    state.start = start;
    state.data = data;
    state.loop = loop;
  },

  /** :334-348 */
  stop(): void {
    Sound.host()?.musicStop();
    state.current = null;
    state.source = null;
    state.fade = null;
    state.tempo = undefined;
    state.start = undefined;
    state.data = null;
    state.loop = undefined;
    state.ref = null;
    state.pendingRestore = false;
    state.restoreLeft = null;
  },

  /** :352-355 */
  reload(): void {
    state.failed = new Set();
    Music.stop();
  },

  /** :357-373 — rAUDVOL 7 -> 0, one level every `control` frames. */
  fadeOut(control?: number, pending?: Pending): void {
    if (!state.source) {
      Music.stop();
      if (pending) Music.play(pending.data, pending.song, pending.loop, pending.ctx);
      return;
    }
    const c = Math.max(1, control ?? 10);
    state.fade = { control: c, counter: c, level: 7, pending };
    Sound.host()?.musicFade(c);
  },

  /** :396-407 */
  playMap(
    data: SoundData,
    mapId?: string | null,
    onBike?: boolean,
    surfing?: boolean,
    fade?: number,
    song?: string | null,
  ): void {
    const s = song ?? (mapId ? audioOf(data).mapSongs?.[mapId] : undefined) ?? null;
    state.mapSong = s;
    state.onBike = !!onBike;
    state.surfing = !!surfing;
    const play = effectiveMapSong(data, s);
    if (play) Music.play(data, play, undefined, { reason: "map", mapId: mapId ?? undefined, fade });
  },

  /** :410-414 */
  setSurfing(data: SoundData, surfing: boolean): void {
    state.surfing = !!surfing;
    const play = effectiveMapSong(data, state.mapSong);
    if (play) Music.play(data, play, undefined, { reason: "map" });
  },

  /** :418-424 */
  playBattle(data: SoundData, kind: string, trainerId?: unknown, song?: string): void {
    const b = audioOf(data).battle;
    if (b) Music.play(data, song ?? b[kind] ?? b.wild, undefined, { reason: "battle", kind, trainerId });
  },

  /** :431-440 */
  playVictory(data: SoundData, kind: string, trainerId?: unknown): boolean {
    const jingle = audioOf(data).battle?.[`${kind}Win`];
    if (jingle && songDef(data, jingle)) {
      Music.play(data, jingle, undefined, { reason: "victory", kind, trainerId });
      return true;
    }
    return false;
  },

  /** :453-463 — a jingle; the map theme comes back when it ends. */
  playOnce(data: SoundData, song: string): boolean {
    if (!songDef(data, song)) return false;
    Music.play(data, song, false, { reason: "once" });
    if (state.current !== song) return false;
    state.pendingRestore = true;
    state.restoreLeft = ONE_SHOT_CEILING;
    return true;
  },

  /** :475-477 */
  oneShotPlaying(): boolean {
    return state.pendingRestore === true;
  },

  /** :481-483 */
  current(): string | null {
    return state.current;
  },

  /** :487-489 wMapMusic */
  mapSong(): string | null {
    return state.mapSong;
  },

  /** :491-497 */
  restoreMap(data: SoundData, reason?: string): void {
    state.current = null;
    state.pendingRestore = false;
    state.restoreLeft = null;
    const play = effectiveMapSong(data, state.mapSong);
    if (play) Music.play(data, play, undefined, { reason: reason ?? "map" });
  },

  /** :503-505 RadioMusicRestartDE's wMapMusic write */
  setMapSong(song: string | null): void {
    state.mapSong = song;
  },

  /** :509-513 — stored; the synth has no music bus volume. */
  setVolumeLevel(level?: number): void {
    volumeScale = Math.max(0, Math.min(7, level ?? 7)) / 7;
  },

  /** :516-520 — stored; no low-pass on the synth. */
  setFilterLevel(level?: number): void {
    filterLevel = Math.max(0, Math.min(3, level ?? 0));
  },

  /** The stored option levels (the options menu reads them back). */
  levels(): { volume: number; filter: number; stereo: boolean } {
    return { volume: volumeScale, filter: filterLevel, stereo };
  },

  /** :522-526 — no playback-rate knob on the synth. */
  setPitch(_pitch?: number): void {},

  /** :530-553 — the SOUND row reaches the playing song live
   * (ChipAudio.setStereo -> applyStereo), as a `resume` of it. */
  applyOptions(opts?: { musicVol?: number; musicFilter?: number; sound?: string } | null): void {
    Music.setVolumeLevel(opts?.musicVol ?? 7);
    Music.setFilterLevel(opts?.musicFilter ?? 0);
    const want = opts?.sound === "STEREO";
    if (want === stereo) return;
    stereo = want;
    const host = Sound.host();
    if (host && state.ref && !state.fade) {
      const r = state.ref;
      r.flags = (r.flags & ~AUDIO_MUSIC_FLAG.stereo) | (stereo ? AUDIO_MUSIC_FLAG.stereo : 0);
      host.music(r.bank, r.address, r.engine, r.flags | AUDIO_MUSIC_FLAG.resume);
    }
  },

  /** :555-571 — the synth survives a device reset. */
  onDeviceReset(): void {},

  /** :581-650 — once per 60 Hz frame (Game2.lua:1295). */
  update(data: SoundData): void {
    Sound.tick();
    // :592-615 — the fade: hold `control` frames, drop a level, stop at 0
    if (state.fade) {
      const f = state.fade;
      f.counter -= 1;
      if (f.counter <= 0) {
        f.counter = f.control;
        f.level -= 1;
        if (f.level <= 0) {
          // ..(home/fade_audio.asm ln 36)
          state.fade = null;
          const pending = f.pending;
          Music.stop();
          if (pending) Music.play(pending.data, pending.song, pending.loop, pending.ctx);
          return;
        }
      }
      if (state.source) state.source.played += 1;
      return;
    }
    // :619-625 — while a fanfare plays the song stays held
    if (state.fanfare) {
      if (fanfareActive()) return;
      state.fanfareResume = false;
    }
    if (state.source) state.source.played += 1;
    // :637-649
    if (state.pendingRestore) {
      state.restoreLeft = (state.restoreLeft ?? ONE_SHOT_CEILING) - 1;
      const ended = state.source !== null && !state.source.isPlaying();
      if (ended) {
        Music.restoreMap(data);
      } else if (state.restoreLeft <= 0) {
        Logger.warn("music: one-shot %s never finished; restoring map theme", String(state.current));
        Music.restoreMap(data);
      }
    }
  },

  /** Tests: back to boot. */
  _resetForTest(): void {
    state.current = null;
    state.source = null;
    state.mapSong = null;
    state.onBike = false;
    state.surfing = false;
    state.pendingRestore = false;
    state.restoreLeft = null;
    state.fanfare = null;
    state.fanfareResume = false;
    state.fade = null;
    state.tempo = undefined;
    state.start = undefined;
    state.data = null;
    state.loop = undefined;
    state.ref = null;
    state.failed = new Set();
    stereo = false;
  },
};

export default Music;
