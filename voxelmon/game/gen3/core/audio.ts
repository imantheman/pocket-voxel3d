// Port of gen1recomp src/core/game3/audio.lua (GPLv3 + additional terms; see LICENSE.md).
// FRLG sound POLICY: what plays when -- songs and map music, fades, cry
// ducking, SE ducking, the frame-exact fanfare countdown that pauses and
// resumes the song, the per-player SE rule, cries, the saved (bike/surf)
// song. Every sound goes to the host's M4A engine through getAudio()
// (platform/audio.ts), whose methods follow the Rust engine; Brian's
// worker thread, Channels, QueueableSources and SoundData baking are the
// engine's business and are gone:
//
// - the BGM "source" (_bgmSource) is the engine's song channel, opened by
//   the first playSong once a pack is installed; its volume is
//   setSongVolume(bgm_gain() [x fade]); stop/pause/resume map 1:1.
// - an SE "source" is a token {id, player, ...meta} in _seSources (and
//   _seMeta); it is playing while getAudio().sePlaying(id) says so (the
//   fanfare's token: fanfarePlaying()). playSe hands the engine the policy's
//   loop decision, bake ceiling, pan and gain.
// - the fanfare plays through playFanfare(id, bgm volume); the countdown
//   (info.fanfareFrames / fanfares[id].frames / 160) stays here.
// - playCry hands the engine Brian's mode plus the profile's per-mode
//   overrides and the volume; the frames it returns drive _cryUntil (the
//   cry timer), as Sample.renderCry's info.frames did.
//
// The pack (Player.loadPack) is read here only for the policy's tables:
// index.songs (kind, player, loop, hasGoto, fanfareFrames), index.fanfares,
// index.roles, index.cryIds. NOT FAITHFUL: samples / voicegroups / cries
// (the engine's synthesis data, megabytes) are dropped from the guest's
// copy; samples.bin is not read.
//
// NOT FAITHFUL, by the seam: the musicFilter lowpass (no filter in the
// engine), bgmHeardPosition (the engine keeps the song position; this
// answers the last pause point), Audio.rebuildPlayback (no device reset on
// the 3DS), and the worker plumbing (pumpBgm / pumpFanfares /
// check_worker_status drain nothing). The PCM helpers (_seRaw*, _seSource*,
// _buildSeSoundData, _newIntroLoopSource, _pumpSeLoops) keep their state
// resets only. RSE (Emerald) map-music policy is not ported: rse_policy()
// answers nil unless a profile asks for "rse", which throws.

import { SE } from "./se_ids.ts";
import { Song } from "./song_ids.ts";
import { Profile } from "./profile.ts";
import { Constants } from "./constants.ts";
import { Options } from "./options.ts";
import { Map as G3Map } from "./map.ts";
import { Player as G3Player } from "./player.ts";
import { getAudio, type CryParams } from "../platform/audio.ts";
import { Fs } from "../platform/fs.ts";
import { luaLoad } from "../platform/luadata.ts";
import { getTime } from "../platform/timer.ts";
import { hasHost } from "../platform/host.ts";
import { SessionLifecycle } from "../shared/core/SessionLifecycle.ts";
import { format, tonumber, tostring } from "../../../import/gen3/lua.ts";
import { ipairs, len, pairs, remove as tremove } from "../platform/lt.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface AudioCache {
  read(rel: string): string | undefined;
  write?(rel: string, data: string): boolean;
  exists?(rel: string): boolean;
}

/** An SE (or the fanfare) the policy is tracking. */
export interface SeSource { id: number; fanfare?: boolean; cry?: boolean }

interface SeMeta {
  id: number; player: number; duckBgm?: boolean; master?: number; pan?: number;
  mono?: boolean; loop?: boolean; body?: unknown; rawL?: unknown;
}

// os.clock (process seconds)
function osClock(): number {
  return hasHost() ? getTime() : 0;
}

// Lua: audio.lua:16
function audio_profile(): any {
  try {
    const row = Profile.forSession(undefined);
    if (row != null && typeof row === "object") return row;
  } catch { /* pcall */ }
  return undefined;
}

// Lua: audio.lua:46
function rse_policy(): any {
  if (Audio.mapMusicPolicy() !== "rse") return undefined;
  throw new Error("NOT FAITHFUL: Emerald only (audio_policy_rse is not ported)");
}

// Lua: audio.lua:51
const RIDE_SONG_KEYS: Record<string, string> = { MUS_CYCLING: "cycling", MUS_SURF: "surf", MUS_UNDERWATER: "underwater" };

// Lua: audio.lua:106 -- [entry, haveTable]
function fanfare_entry(id: number): [any, boolean] {
  const ff = Audio._pack && Audio._pack.index && Audio._pack.index.fanfares;
  if (!ff) return [undefined, false];
  return [ff[id] ?? ff[tostring(id)], true];
}

// Lua: audio.lua:112
function log(msg: unknown): void {
  if (Audio._log) {
    console.log("[game3.audio] " + tostring(msg));
  }
}

// Lua: audio.lua:118
function warn_once(id: string, msg: string): void {
  if (Audio._warned[id]) return;
  Audio._warned[id] = true;
  console.log("[game3.audio] " + msg);
}

// Lua: audio.lua:124
function filesystem_cache(): AudioCache {
  return {
    read: (rel) => Fs.read(rel),
    write: (rel, data) => Fs.write(rel, data),
    exists: (rel) => Fs.getInfo(rel) !== undefined,
  };
}

// Lua: m4a_player.lua:28 (cache_read) and :46 (loadPack), the index only
function loadPack(cache: AudioCache, root: string): [any, string?] {
  const src = cache.read(root + "/index.lua");
  if (typeof src !== "string") return [undefined, "missing index.lua"];
  const [chunk, err] = luaLoad(src, "@" + root + "/index.lua");
  if (!chunk) return [undefined, "missing index.lua"];
  let index: any;
  try { index = chunk(); } catch (e) { return [undefined, String((e as Error).message ?? e)]; }
  if (index == null || typeof index !== "object") return [undefined, "missing index.lua"];
  const slim: any = {};
  for (const k of Object.keys(index)) {
    if (k !== "samples" && k !== "voicegroups" && k !== "cries") slim[k] = index[k];
  }
  return [{ root, index: slim, songCache: {} }];
}

// Lua: audio.lua:300
function bgm_gain(volume?: number): number {
  return (volume ?? Audio._bgmVolume ?? 1)
    * Math.min(Audio._duck ?? 1, Audio._seDuck ?? 1)
    * (Audio._helpActive ? 0.5 : 1);
}

// Lua: audio.lua:306
function apply_bgm_gain(): void {
  if (!Audio._bgmSource) return;
  let gain = bgm_gain();
  let f = Audio._fadeOut;
  if (f && (f.gen == null || f.gen === Audio._bgmGen)
    && (f.songId == null || (Audio._currentSong && f.songId === Audio._currentSong.id))) {
    gain = bgm_gain(f.start) * (1 - Math.min(1, f.t / Math.max(f.dur, 0.01)));
  } else if (Audio._fadeIn) {
    f = Audio._fadeIn;
    gain = gain * Math.min(1, f.t / Math.max(f.dur, 0.01));
  }
  getAudio().setSongVolume(gain);
}

// Lua: audio.lua:320
function level_gain(level: unknown, def: number): number {
  let n = tonumber(level);
  if (n === undefined) n = def;
  if (n < 0) n = 0;
  if (n > 7) n = 7;
  return n / 7;
}

function isPlaying(src: SeSource): boolean {
  if (src.fanfare) return getAudio().fanfarePlaying();
  return getAudio().sePlaying(src.id);
}

function stopSrc(src: SeSource): void {
  try {
    if (src.fanfare) getAudio().stopFanfare();
    else getAudio().stopSe(src.id);
  } catch { /* pcall */ }
}

// Lua: audio.lua:382
function update_se_duck(startingSource?: SeSource): void {
  let active = false;
  for (const [, src] of ipairs<SeSource>(Audio._seSources)) {
    const meta = Audio._seMeta.get(src);
    if (meta && meta.duckBgm && (src === startingSource || isPlaying(src))) {
      active = true;
      break;
    }
  }
  const target = active ? 0.6 : 1;
  const old = Audio._seDuck ?? 1;
  Audio._seDuck = target;
  if (target !== old) apply_bgm_gain();
}

// Lua: audio.lua:405
function stop_bgm_source(): void {
  if (Audio._bgmSource) {
    try { getAudio().stopSong(); } catch { /* pcall */ }
  }
  Audio._bgmLocal = undefined;
  Audio._bgmGen = undefined;
  Audio._pendingBgm = undefined;
  Audio._bgmQueuedAt = [null];
  Audio._bgmBaseAt = 0;
}

// Lua: audio.lua:507
function play_policy_song(id: any, fadeOut?: number, fadeIn?: number): boolean {
  if (id == null) return true;
  if (Audio._fanfareActive) {
    Audio._fanfareDeferred = id;
    return true;
  }
  if (fadeOut) return Audio.fadeOutAndPlay(id, fadeOut, fadeIn);
  return Audio.playSong(id);
}

// Lua: audio.lua:577
const NO_RIDE_MUSIC_SECTIONS: Record<number, boolean> = { 97: true, 123: true, 132: true };

// Lua: audio.lua:579
function current_section(): any {
  const M: any = G3Map;
  const def = M && M.currentDef ? M.currentDef() : undefined;
  return def ? def.regionMapSectionId : undefined;
}

// Lua: audio.lua:1217
function start_fanfare_source(id: number, mplay: number): boolean {
  Audio._fanfarePending = undefined;
  const old = Audio._fanfareSource;
  if (old) {
    Audio._fanfareSource = undefined;
    stopSrc(old);
    Audio._forgetSeSource(old);
    for (let i = len(Audio._seSources); i >= 1; i--) {
      if (Audio._seSources[i] === old) tremove(Audio._seSources, i);
    }
  }
  Audio._stopSePlayer(mplay);
  const src: SeSource = { id, fanfare: true };
  try {
    getAudio().playFanfare(id, Audio._bgmVolume ?? 1);
  } catch {
    return false;
  }
  Audio._fanfareSource = src;
  Audio._seSources[len(Audio._seSources) + 1] = src;
  Audio._seByPlayer[mplay] = src;
  Audio._seMeta.set(src, { id, player: mplay });
  return true;
}

// Lua: m4a_sample.lua:74 -- the modes Sample.CRY_MODES defines (the engine holds their fields)
const CRY_MODE_COUNT = 13;

export const Audio: Record<string, any> = {
  _pack: undefined as any,
  _cache: undefined as AudioCache | undefined,
  _root: "data/generated/gba/audio",
  _meta: undefined as any,
  _currentSong: undefined as any,
  _mapSong: undefined as any,
  _savedSong: undefined as any,
  _log: false,
  _ready: false,
  _seSources: [null] as (SeSource | null)[],
  _seByPlayer: {} as Record<number, SeSource | undefined>,
  _seMeta: new Map<SeSource, SeMeta>(),
  _crySlot: undefined as any,
  _cryClock: 0,
  _cryUntil: undefined as number | undefined,
  _fanfareFrames: 0,
  _fanfareActive: false,
  _fanfareSd: {} as Record<number, unknown>,
  _fanfareSrc: {} as Record<number, unknown>,
  _fanfareRoot: undefined as string | undefined,
  _fanfareRestore: undefined as any,
  _fanfareDeferred: undefined as any,
  _fanfarePending: undefined as any,
  _fanfareSource: undefined as SeSource | undefined,
  _bgmPaused: false,
  _bgmEpoch: 0,
  _bgmQueuedAt: [null] as any[],
  _bgmBaseAt: 0,
  _bgmVolume: 1,
  _sfxVolume: 1,
  _duck: 1,
  _duckHold: 0,
  _seDuck: 1,
  _mono: false,
  _warned: {} as Record<string, boolean>,
  _worker: false,
  _cmdCh: undefined,
  _outCh: undefined,
  _bgmSource: undefined as boolean | undefined,
  _bgmGen: undefined as any,
  _bgmLocal: undefined as any,

  // Lua: audio.lua:24
  config(): any {
    const row = audio_profile();
    return (row && row.audio) || {};
  },

  // Lua: audio.lua:29
  songs(): any {
    const row = audio_profile();
    if (row && row.id) {
      try {
        const t = Song.forVersion(row.id);
        if (t) return t;
      } catch { /* pcall */ }
    }
    return Song;
  },

  // Lua: audio.lua:38
  mapMusicPolicy(): string {
    return Audio.config().mapMusicPolicy || "frlg";
  },

  // Lua: audio.lua:42
  questLogGating(): boolean {
    return Audio.config().questLogGating !== false;
  },

  // Lua: audio.lua:191 -- [ok, err]
  install(cache?: AudioCache, opts?: { root?: string }): [boolean, string?] {
    const o = opts || {};
    Audio._root = o.root || "data/generated/gba/audio";
    Audio._cache = cache || filesystem_cache();
    const [pack, err] = loadPack(Audio._cache!, Audio._root);
    if (!pack) {
      Audio._ready = false;
      Audio._pack = undefined;
      warn_once("install", "audio pack unavailable: " + tostring(err));
      return [false, err];
    }
    Audio._pack = pack;
    Audio._meta = pack.index;
    Audio._ready = true;
    Audio._seRawClear();
    if (Audio._fanfareRoot !== Audio._root) {
      Audio._fanfareSd = {};
      Audio._fanfareSrc = {};
      Audio._fanfareRoot = Audio._root;
    }
    log("installed root=" + Audio._root);
    return [true];
  },

  // Lua: audio.lua:218
  isReady(): boolean {
    return Audio._ready && Audio._pack != null;
  },

  // Lua: audio.lua:222
  loadMeta(meta: any): void {
    Audio._meta = meta != null && typeof meta === "object" ? meta : {};
  },

  // Lua: audio.lua:227 (+ m4a_player.lua:65 songInfo)
  songInfo(idIn: any): any {
    const id = tonumber(idIn) ?? idIn;
    if (Audio._pack) {
      const songs = Audio._pack.index && Audio._pack.index.songs;
      if (!songs) return undefined;
      return songs[id] ?? songs[tostring(id)];
    }
    const meta = Audio._meta || {};
    const songs = meta.songs || meta;
    if (songs != null && typeof songs === "object") {
      return songs[id] ?? songs[tostring(id)];
    }
    return undefined;
  },

  // Lua: audio.lua:240
  role(name: string): any {
    const roles = Audio._pack && Audio._pack.index && Audio._pack.index.roles;
    if (roles && roles[name]) return roles[name];
    return undefined;
  },

  // Lua: audio.lua:249
  LEGENDARY_BATTLE_SONGS: {
    SPECIES_MEWTWO: [null, "battleMewtwo", "MUS_VS_MEWTWO"],
    SPECIES_DEOXYS: [null, "battleDeoxys", "MUS_VS_DEOXYS"],
    SPECIES_ARTICUNO: [null, "battleLegend", "MUS_VS_LEGEND"],
    SPECIES_ZAPDOS: [null, "battleLegend", "MUS_VS_LEGEND"],
    SPECIES_MOLTRES: [null, "battleLegend", "MUS_VS_LEGEND"],
    SPECIES_RAIKOU: [null, "battleDeoxys", "MUS_VS_DEOXYS"],
    SPECIES_ENTEI: [null, "battleDeoxys", "MUS_VS_DEOXYS"],
    SPECIES_SUICUNE: [null, "battleDeoxys", "MUS_VS_DEOXYS"],
    SPECIES_LUGIA: [null, "battleLegend", "MUS_VS_LEGEND"],
    SPECIES_HO_OH: [null, "battleLegend", "MUS_VS_LEGEND"],
  } as Record<string, (string | null)[]>,

  // Lua: audio.lua:274
  legendaryBattleSong(species: unknown, opts?: any): any {
    const cfg = Audio.config();
    const tbl = cfg.legendaryBattleSongs || Audio.LEGENDARY_BATTLE_SONGS;
    const n = tonumber(species);
    const entry = n !== undefined ? tbl[species_name(n) as string] : undefined;
    const songs = Audio.songs();
    if (!entry) {
      const def = opts != null && typeof opts === "object" && opts.legendary && cfg.legendaryBattleDefault;
      return def ? songs[def] : undefined;
    }
    if (entry != null && typeof entry === "object") {
      return Audio.role(entry[1]) || songs[entry[2]];
    }
    return songs[entry];
  },

  // Lua: audio.lua:290
  applyOptions(session: any): void {
    const o = Options.ensure(session);
    const mono = (tonumber(o.sound) ?? 0) === 0;
    if (mono !== Audio._mono) {
      Audio._mono = mono;
      Audio.pushMixOptions();
    }
  },

  // Lua: audio.lua:328
  pushMixOptions(): void {
    if (Audio._mixMono !== Audio._mono) {
      Audio._mixMono = Audio._mono;
      Audio._fanfareSd = {};
      Audio._fanfareSrc = {};
    }
    getAudio().setMono(Audio._mono ? true : false);
    Audio.applyBgmFilter();
    Audio.applyGain();
  },

  // Lua: audio.lua:356 -- NOT FAITHFUL: the engine has no lowpass; musicFilter is kept, unheard
  applyBgmFilter(): void {},

  // Lua: audio.lua:361
  applyEngineOptions(opts: any): void {
    if (opts == null || typeof opts !== "object") return;
    Audio._bgmVolume = level_gain(opts.musicVol, 7);
    Audio._sfxVolume = level_gain(opts.sfxVol, 7);
    let filter = tonumber(opts.musicFilter) ?? 0;
    if (filter < 0) filter = 0;
    if (filter > 3) filter = 3;
    Audio._filterLevel = filter > 0 ? filter : undefined;
    Audio.pushMixOptions();
  },

  // Lua: audio.lua:372
  applyGain(): void {
    apply_bgm_gain();
  },

  // Lua: audio.lua:398
  setHelpActive(active: unknown): void {
    Audio._helpActive = active === true;
    const volume = bgm_gain();
    if (Audio._bgmSource) getAudio().setSongVolume(volume);
  },

  // Lua: audio.lua:419
  resolveSong(id: any): any {
    if (typeof id === "string" && tonumber(id) === undefined) {
      return Audio.songs()[id] ?? Song.resolve(id) ?? id;
    }
    return tonumber(id) ?? id;
  },

  // Lua: audio.lua:426
  playSong(idIn: any, opts?: any): boolean {
    const o = opts || {};
    const id = Audio.resolveSong(idIn);
    if (id == null || id === 0 || id === 0xFFFF) {
      Audio._fadeOut = undefined;
      Audio._fadeIn = undefined;
      Audio._fanfareRestore = undefined;
      Audio._fanfareDeferred = undefined;
      stop_bgm_source();
      Audio._currentSong = undefined;
      return true;
    }
    if (o.fanfare || (Audio.songInfo(id) && Audio.songInfo(id).kind === "fanfare") || (fanfare_entry(id)[0] != null)) {
      return Audio.playFanfare(id);
    }
    if (!o.restart && !Audio._fadeOut && Audio._currentSong && Audio._currentSong.id === id) {
      if (Audio._fanfareActive) Audio._fanfareDeferred = undefined;
      return true;
    }
    const info = Audio.songInfo(id) || {};
    Audio._currentSong = {
      id,
      duration: info.duration,
      loop: info.loop !== false,
      startedAt: osClock(),
    };
    Audio._mapSong = Audio._mapSong ?? id;

    Audio._fadeOut = undefined;
    Audio._fadeIn = undefined;
    Audio._fanfareActive = false;
    Audio._fanfareFrames = 0;
    Audio._fanfareRestore = undefined;
    Audio._fanfareDeferred = undefined;
    Audio._fanfarePending = undefined;
    Audio._bgmPaused = false;

    if (!Audio.isReady()) {
      log(format("playsong id=%s (no pack)", tostring(id)));
      return true;
    }

    // the worker path: the engine plays the song
    Audio._pendingBgm = undefined;
    Audio._bgmEpoch = (Audio._bgmEpoch ?? 0) + 1;
    Audio._bgmQueuedAt = [null];
    Audio._bgmBaseAt = 0;
    getAudio().playSong(id);
    Audio._bgmGen = id;
    Audio._bgmSource = true;
    try { getAudio().setSongVolume(bgm_gain()); } catch { /* pcall */ }
    log(format("playsong id=%s", tostring(id)));
    return true;
  },

  // Lua: audio.lua:499
  currentMapMusic(): any {
    if (Audio._fanfareActive && Audio._fanfareDeferred != null) {
      return Audio._fanfareDeferred;
    }
    if (Audio._fadeOut) return Audio._fadeOut.nextSong ?? 0;
    return (Audio._currentSong && Audio._currentSong.id) || 0;
  },

  // Lua: audio.lua:518
  mapLoadMusic(info?: any): boolean {
    const i = info || {};
    const P = rse_policy();
    if (!P) {
      return Audio.playMapSong(i.song ?? i.music, { mapSong: i.music });
    }
    return true;
  },

  // Lua: audio.lua:539
  tryFadeOutOldMapMusic(_destMapId?: unknown, _x?: unknown, _y?: unknown): number | undefined {
    const P = rse_policy();
    if (!P) return undefined;
    return 0;
  },

  // Lua: audio.lua:549
  playMapSong(idIn: any, opts?: any): boolean {
    const o = opts || {};
    const id = Audio.resolveSong(idIn);
    if (o.mapSong != null && !o.exact && rse_policy()) {
      return Audio.mapLoadMusic({ music: o.mapSong });
    }
    if (id == null || id === 0xFFFF) return true;
    Audio._mapSong = o.mapSong ?? id;
    if (Audio._fanfareActive) {
      Audio._fanfareDeferred = id;
      return true;
    }
    if (o.fadeOut) {
      Audio.fadeOutBgm(o.fadeOut);
    }
    return Audio.playSong(id, o);
  },

  // Lua: audio.lua:567
  setMapSong(id: any): void {
    rse_policy();
    Audio._mapSong = tonumber(id) ?? id;
  },

  // Lua: audio.lua:586
  canOverrideMapMusic(song: any, sectionIdIn?: any): boolean {
    if (rse_policy()) return true;
    let sectionId = sectionIdIn;
    if (song === Audio.MUS_CYCLING || song === Audio.MUS_SURF) {
      if (sectionId == null) sectionId = current_section();
      return !NO_RIDE_MUSIC_SECTIONS[tonumber(sectionId) ?? -1];
    }
    return true;
  },

  // Lua: audio.lua:596
  specialMapSong(sectionId?: any): any {
    rse_policy();
    if (Audio._savedSong) return Audio._savedSong;
    const P: any = G3Player;
    if (P && (P.surfing || P.surfHopping) && !P.dismounting
      && Audio.canOverrideMapMusic(Audio.MUS_SURF, sectionId)) {
      return Audio.MUS_SURF;
    }
    if (P && P.biking && Audio.canOverrideMapMusic(Audio.MUS_CYCLING, sectionId)) {
      return Audio.MUS_CYCLING;
    }
    return Audio._mapSong;
  },

  // Lua: audio.lua:612
  restoreMapSong(opts?: any): boolean {
    const id = Audio.specialMapSong();
    if (id) return Audio.playSong(id, opts);
    return true;
  },

  // Lua: audio.lua:619
  fadeOutAndPlay(idIn: any, speed?: number, fadeInSpeed?: number): boolean {
    const id = Audio.resolveSong(idIn);
    if (Audio._fanfareActive) {
      Audio._fanfareDeferred = id;
      return true;
    }
    if (!(Audio._currentSong && Audio._bgmSource)) {
      return Audio.playSong(id);
    }
    Audio.fadeOutBgm(speed);
    if (Audio._fadeOut) {
      Audio._fadeOut.nextSong = id;
      Audio._fadeOut.fadeIn = fadeInSpeed;
    }
    return true;
  },

  // Lua: audio.lua:637
  changeMusicTo(idIn: any): boolean {
    const id = Audio.resolveSong(idIn);
    rse_policy();
    if (Audio.currentMapMusic() === id) return true;
    return Audio.fadeOutAndPlay(id, 8);
  },

  // Lua: audio.lua:650
  changeMusicToDefault(): boolean {
    rse_policy();
    if (Audio._mapSong) return Audio.changeMusicTo(Audio._mapSong);
    return true;
  },

  // Lua: audio.lua:662
  startSurfMusic(): void {
    Audio.setSavedSong(undefined);
    if (Audio.canOverrideMapMusic(Audio.MUS_SURF)) Audio.changeMusicTo(Audio.MUS_SURF);
  },

  // Lua: audio.lua:668
  stopSurfMusic(): void {
    Audio.setSavedSong(undefined);
    Audio.changeMusicToDefault();
  },

  // Lua: audio.lua:674
  bikeMusic(on: unknown, forced?: unknown): void {
    if (on) {
      if (forced || Audio.canOverrideMapMusic(Audio.MUS_CYCLING)) {
        Audio.setSavedSong(Audio.MUS_CYCLING);
        Audio.changeMusicTo(Audio.MUS_CYCLING);
      }
      return;
    }
    Audio.setSavedSong(undefined);
    const id = Audio.specialMapSong();
    if (id && id !== Audio.currentMapMusic()) {
      play_policy_song(id);
    }
  },

  // Lua: audio.lua:690
  setSavedSong(idIn: any): void {
    let id = Audio.resolveSong(idIn);
    if (id === 0 || id === 0xFFFF) id = undefined;
    Audio._savedSong = id;
  },

  // Lua: audio.lua:697
  clearSavedSong(): void {
    Audio._savedSong = undefined;
  },

  // Lua: audio.lua:702
  fadeDefaultBgm(speed?: number): boolean {
    if (rse_policy()) return Audio.changeMusicToDefault();
    const id = Audio._mapSong;
    if (id && Audio.currentMapMusic() === id) return true;
    if (Audio._fanfareActive) return play_policy_song(id);
    Audio.fadeOutBgm(speed);
    if (id) return Audio.playSong(id);
    return true;
  },

  // Lua: audio.lua:712
  fadeOutBgm(speedIn?: unknown): boolean {
    const speed = tonumber(speedIn) ?? 4;
    const seconds = 16 * speed / 60;
    const songId = Audio._currentSong && Audio._currentSong.id;
    if (Audio._bgmSource && songId) {
      Audio._fadeOut = {
        t: 0,
        dur: seconds,
        start: Audio._bgmVolume ?? 1,
        songId,
        gen: Audio._bgmGen,
      };
    } else {
      stop_bgm_source();
      Audio._currentSong = undefined;
    }
    log(format("fadeOutBgm speed=%s", tostring(speed)));
    return true;
  },

  // Lua: audio.lua:734
  fadeInBgm(id: any, speedIn?: unknown): boolean {
    Audio.playSong(id);
    const speed = tonumber(speedIn) ?? 4;
    const seconds = 16 * speed / 60;
    Audio._fadeIn = { t: 0, dur: seconds };
    if (Audio._bgmSource) getAudio().setSongVolume(0);
    return true;
  },

  // Lua: audio.lua:743 -- NOT FAITHFUL: the engine owns the song position
  bgmHeardPosition(): number | undefined {
    return Audio._bgmBaseAt;
  },

  // Lua: audio.lua:764
  pauseBgm(): void {
    if (Audio._bgmPaused) return;
    const at = Audio.bgmHeardPosition() ?? Audio._bgmBaseAt ?? 0;
    Audio._bgmPaused = true;
    Audio._bgmEpoch = (Audio._bgmEpoch ?? 0) + 1;
    if (Audio._bgmSource) {
      try { getAudio().pauseSong(); } catch { /* pcall */ }
    }
    Audio._pendingBgm = undefined;
    Audio._bgmQueuedAt = [null];
    Audio._bgmBaseAt = at;
  },

  // Lua: audio.lua:785
  resumeBgm(): void {
    Audio._bgmPaused = false;
    if (Audio._bgmSource) {
      try {
        getAudio().setSongVolume(bgm_gain());
        getAudio().resumeSong();
      } catch { /* pcall */ }
    }
    Audio.pumpBgm();
  },

  // Lua: audio.lua:799
  isBgmStopped(): boolean {
    if (Audio._bgmPaused) return true;
    if (Audio._bgmSource) {
      return getAudio().song() < 0 || getAudio().songPaused();
    }
    return Audio._currentSong == null;
  },

  // Lua: audio.lua:807
  SE_RAW_MAX_FRAMES: 1500000,
  SE_LOOP_MAX_SEC: 2.5,
  SE_ONESHOT_MAX_SEC: 30,

  // Lua: audio.lua:812 -- the engine bakes SEs; only the state reset remains
  _seRawClear(): void {
    Audio._seRaw = {};
    Audio._seRawFrames = 0;
    Audio._seRawTick = 0;
    Audio._seSourceClear();
  },

  // Lua: audio.lua:819 -- no guest-side PCM memo
  _seRawGet(_id: number): undefined {
    return undefined;
  },

  // Lua: audio.lua:827 -- no guest-side PCM memo
  _seRawPut(): void {},

  // Lua: audio.lua:856
  SE_SOURCE_CACHE_MAX: 32,

  // Lua: audio.lua:858
  _seSourceClear(): void {
    Audio._seSrcCache = {};
    Audio._seSrcCount = 0;
    Audio._seSrcTick = 0;
  },

  // Lua: audio.lua:864 -- the engine owns the sources
  _seSourceFor(): undefined {
    return undefined;
  },

  // Lua: audio.lua:915
  playSe(idIn: any, opts?: any): boolean {
    const o = opts || {};
    const id = SE.resolve(idIn);
    if (id == null) {
      return false;
    }
    if (o.fanfare || (Audio.songInfo(id) && Audio.songInfo(id).kind === "fanfare")) {
      return Audio.playFanfare(id);
    }
    if (!Audio.isReady()) {
      log(format("playse id=%s (no pack)", tostring(id)));
      return true;
    }
    const info = Audio.songInfo(id) || {};
    const mplay = tonumber(info.player) ?? 1;
    Audio._stopSePlayer(mplay);

    // Lua: Player.start fails when the pack has no such song (the engine plays it here)
    if (Audio.songInfo(id) == null) {
      warn_once("se:" + tostring(id), "SE " + tostring(id) + " missing");
      return false;
    }
    let loop = o.loop;
    if (loop == null) {
      // SE_LOW_HEALTH and any track with GOTO before FINE are hardware loops.
      loop = (id === SE.SE_LOW_HEALTH) || Audio._songHasGoto({ info });
    }
    const loopBody = loop && o.loop == null && id !== SE.SE_LOW_HEALTH;
    // pokefirered/src/battle_anim_special.c:1200
    const cut = ((loop && !loopBody) || id === SE.SE_EXP);
    const maxSec = o.maxSec ?? (cut ? Audio.SE_LOOP_MAX_SEC : Audio.SE_ONESHOT_MAX_SEC);

    const pan = Audio.normalizePan(o.pan);
    const master = (Audio._sfxVolume ?? 1) * (o.volume ?? 1);
    const src: SeSource = { id };
    getAudio().playSe(id, { looping: loop ? true : false, maxSec, pan, gain: master });
    Audio._seSources[len(Audio._seSources) + 1] = src;
    Audio._seByPlayer[mplay] = src;
    Audio._seMeta.set(src, {
      id, player: mplay,
      duckBgm: !loop && id !== SE.SE_SELECT
        && (Audio._sfxVolume ?? 1) * (o.volume ?? 1) > 0,
      master, pan, mono: Audio._mono, loop: loop ? true : false,
    });
    update_se_duck(src);
    update_se_duck();
    while (len(Audio._seSources) > 8) {
      let idx = 1;
      if (Audio._seSources[idx] === Audio._fanfareSource) idx = 2;
      const old = tremove<SeSource>(Audio._seSources, idx);
      if (!old) break;
      Audio._forgetSeSource(old);
      stopSrc(old);
    }
    log(format("playse id=%s player=%s pan=%s loop=%s", tostring(id), tostring(mplay), tostring(pan), tostring(loop)));
    return true;
  },

  // Lua: audio.lua:1009
  normalizePan(pan: unknown): number {
    if (pan == null) return 0;
    if (typeof pan === "number") {
      if (pan > 63) return 63;
      if (pan < -64) return -64;
      return pan;
    }
    const s = tostring(pan);
    if (s === "SOUND_PAN_TARGET" || s === "TARGET") return 63;
    if (s === "SOUND_PAN_ATTACKER" || s === "ATTACKER") return -64;
    const n = tonumber(s);
    if (n !== undefined) return Audio.normalizePan(n);
    return 0;
  },

  // Lua: audio.lua:1024 -- [gainL, gainR]
  _seGains(panIn: unknown): [number, number] {
    let pan = tonumber(panIn) ?? 0;
    if (pan > 63) pan = 63;
    if (pan < -64) pan = -64;
    const panN = pan / 64;
    return [1 - Math.max(0, panN), 1 - Math.max(0, -panN)];
  },

  // Lua: audio.lua:1032 -- the engine renders SE PCM
  _buildSeSoundData(): undefined {
    return undefined;
  },

  // Lua: audio.lua:1069
  setSePan(panIn: unknown): number {
    const pan = Audio.normalizePan(panIn);
    for (const mplay of [1, 2]) {
      const old = Audio._seByPlayer[mplay];
      const meta = old ? Audio._seMeta.get(old) : undefined;
      if (meta && !meta.body && !old!.fanfare && meta.pan !== pan) {
        let playing = false;
        try { playing = isPlaying(old!); } catch { playing = false; }
        meta.pan = pan;
        if (playing && !meta.mono) {
          getAudio().setSePan(pan);
        }
      }
    }
    return pan;
  },

  // Lua: audio.lua:1110 -- the engine loops intro+body itself
  _newIntroLoopSource(): undefined {
    return undefined;
  },

  // Lua: audio.lua:1123 -- the engine requeues loop bodies
  _pumpSeLoops(): void {},

  // Lua: audio.lua:1132
  _songHasGoto(slot: any): boolean {
    if (slot && slot.info && slot.info.hasGoto != null) return slot.info.hasGoto;
    // NOT FAITHFUL: the sequence scan (0xB2 GOTO in the track data) is the engine's
    return false;
  },

  // Lua: audio.lua:1145
  _forgetSeSource(src: SeSource | undefined): void {
    if (!src) return;
    const meta = Audio._seMeta.get(src);
    if (meta && Audio._seByPlayer[meta.player] === src) {
      delete Audio._seByPlayer[meta.player];
    }
    Audio._seMeta.delete(src);
    update_se_duck();
  },

  // Lua: audio.lua:1155
  _stopSePlayer(mplayIn: unknown): void {
    const mplay = tonumber(mplayIn);
    if (mplay === undefined) return;
    const src = Audio._seByPlayer[mplay];
    if (!src) return;
    stopSrc(src);
    Audio._forgetSeSource(src);
    for (let i = len(Audio._seSources); i >= 1; i--) {
      if (Audio._seSources[i] === src) {
        tremove(Audio._seSources, i);
      }
    }
  },

  // Lua: audio.lua:1169
  stopSe(idIn?: unknown): void {
    if (idIn == null) {
      for (const [, src] of ipairs<SeSource>(Audio._seSources)) {
        stopSrc(src);
        Audio._forgetSeSource(src);
      }
      Audio._seSources = [null];
      Audio._seByPlayer = {};
      return;
    }
    const id = SE.resolve(idIn);
    for (let i = len(Audio._seSources); i >= 1; i--) {
      const src = Audio._seSources[i]!;
      const meta = Audio._seMeta.get(src);
      if (meta && meta.id === id) {
        stopSrc(src);
        Audio._forgetSeSource(src);
        tremove(Audio._seSources, i);
      }
    }
  },

  // Lua: audio.lua:1192
  isSePlaying(idIn?: unknown): boolean {
    if (idIn == null) {
      const rse = rse_policy() != null;
      for (const [, src] of ipairs<SeSource>(Audio._seSources)) {
        const meta = Audio._seMeta.get(src);
        if (isPlaying(src) && !(rse && meta && meta.player === 3)) return true;
      }
      return false;
    }
    const id = SE.resolve(idIn);
    for (const [, src] of ipairs<SeSource>(Audio._seSources)) {
      const meta = Audio._seMeta.get(src);
      if (meta && meta.id === id && isPlaying(src)) return true;
    }
    return false;
  },

  // Lua: audio.lua:1211
  waitSe(id: unknown, cb?: () => void): void {
    Audio._waitSe = Audio._waitSe || [null];
    Audio._waitSe[len(Audio._waitSe) + 1] = { id, cb };
  },

  // Lua: audio.lua:1268
  playFanfare(idIn: any): boolean {
    let id = SE.resolve(idIn) ?? Audio.resolveSong(idIn);
    if (typeof id !== "number") return false;
    let [entry, haveTable] = fanfare_entry(id);
    if (haveTable && !entry) {
      // pokefirered/src/sound.c:245
      id = Audio.songs()[Audio.config().fanfareFallback || "MUS_LEVEL_UP"];
      [entry] = fanfare_entry(id);
    }
    const info = Audio.songInfo(id) || {};
    // pokefirered/src/sound.c:50
    const frames = info.fanfareFrames ?? (entry && entry.frames) ?? 160;
    // pokefirered/src/sound.c:199
    if (!Audio._fanfareActive) {
      Audio._fanfareRestore = Audio._bgmGen ?? (Audio._currentSong && Audio._currentSong.id);
      Audio._fanfareDeferred = undefined;
      Audio.pauseBgm();
    }
    Audio._fanfareActive = true;
    Audio._fanfareFrames = frames;
    Audio.stopCry();
    if (Audio.isReady()) {
      start_fanfare_source(id, tonumber(info.player) ?? 2);
    }
    log(format("playFanfare id=%s frames=%s", tostring(id), tostring(frames)));
    return true;
  },

  // Lua: audio.lua:1297 -- the worker's baked-fanfare channel: nothing to drain
  pumpFanfares(): void {},

  // Lua: audio.lua:1315
  isFanfareFinished(): boolean {
    return !Audio._fanfareActive;
  },

  // Lua: audio.lua:1319
  waitFanfare(cb?: () => void): void {
    Audio._waitFanfareCb = cb;
    if (!Audio._fanfareActive && cb) cb();
  },

  // Lua: audio.lua:1325
  playCry(speciesIn: any, modeIn?: any, panIn?: any): boolean {
    const species = tonumber(speciesIn) ?? speciesIn;
    let mode = modeIn, pan = panIn;
    let volume: unknown, noDuck = false;
    if (mode != null && typeof mode === "object") {
      const o = mode;
      mode = o.mode;
      if (pan == null) pan = o.pan;
      volume = o.volume;
      noDuck = o.noDuck === true;
    }
    let m = tonumber(mode) ?? 0;
    // Lua: m4a_sample.lua:90 Sample.cryParams (mode check + the profile's per-mode overrides)
    if (!(Number.isInteger(m) && m >= 0 && m < CRY_MODE_COUNT)) m = 0;
    const params: CryParams = { mode: m };
    const overrides = Audio.config().cryModeOverrides;
    const ov = overrides != null && typeof overrides === "object" ? overrides[m] : undefined;
    if (ov != null && typeof ov === "object") {
      for (const [k, v] of pairs(ov)) {
        if (typeof v === "number") params[k as string] = v;
        else if (typeof v === "boolean") params[k as string] = v ? 1 : 0;
      }
    }
    if (params.volume == null && tonumber(volume) !== undefined) params.volume = tonumber(volume)!;
    const doubles = params.mode === 1 || noDuck;
    Audio._cryParams = params;
    log(format("playCry species=%s mode=%d", tostring(species), params.mode));
    if (!Audio.isReady()) {
      Audio._cryUntil = (Audio._cryClock ?? 0) + 64;
      return true;
    }
    const frames = getAudio().playCry(species, params,
      pan != null && pan !== 0 ? Audio.normalizePan(pan) : 0, Audio._sfxVolume ?? 1);
    if (frames === undefined) {
      Audio._cryUntil = (Audio._cryClock ?? 0) + 64;
      return false;
    }
    Audio._crySlot = { info: { kind: "cry" } };
    Audio._crySource = undefined;
    if (!doubles) {
      Audio._duck = 85 / 256;
      Audio._duckHold = 2;
      apply_bgm_gain();
    }
    Audio._cryUntil = (Audio._cryClock ?? 0) + frames;
    Audio._crySource = { id: -1, cry: true } as SeSource;
    return true;
  },

  // Lua: audio.lua:1381
  tickCry(dt?: number): void {
    Audio._cryClock = (Audio._cryClock ?? 0) + (dt ?? 1 / 60) * 60;
  },

  // Lua: audio.lua:1385
  isCryFinished(): boolean {
    if (Audio._cryUntil != null && (Audio._cryClock ?? 0) >= Audio._cryUntil) {
      return true;
    }
    if (Audio._crySource) return !getAudio().cryPlaying();
    if (Audio._cryUntil == null) return true;
    return (Audio._cryClock ?? 0) >= Audio._cryUntil;
  },

  // Lua: audio.lua:1395
  stopCry(): void {
    if (Audio._crySource) {
      try { getAudio().stopCry(); } catch { /* pcall */ }
    }
    Audio._crySource = undefined;
    Audio._cryUntil = undefined;
    Audio._duck = 1;
    Audio._duckHold = 0;
    apply_bgm_gain();
  },

  // Lua: audio.lua:1404
  currentSong(): any {
    return Audio._currentSong;
  },

  // Lua: audio.lua:1408
  stopAll(): void {
    stop_bgm_source();
    Audio.stopSe();
    Audio.stopCry();
    Audio._seDuck = 1;
    Audio._currentSong = undefined;
    Audio._fanfareActive = false;
  },

  // Lua: audio.lua:1417
  update(dtIn?: number): void {
    const dt = dtIn ?? 1 / 60;
    Audio.tickCry(dt);
    Audio._pumpSeLoops();
    update_se_duck();

    Audio.pumpFanfares();

    // Fanfare countdown (frame-exact)
    if (Audio._fanfareActive) {
      Audio._fanfareFrames = (Audio._fanfareFrames ?? 0) - dt * 60;
      if (Audio._fanfareFrames <= 0) {
        Audio._fanfareActive = false;
        Audio._fanfarePending = undefined;
        const deferred = Audio._fanfareDeferred, restore = Audio._fanfareRestore;
        Audio._fanfareDeferred = undefined;
        Audio._fanfareRestore = undefined;
        // pokefirered/src/sound.c:264
        if (deferred != null && deferred !== Audio._bgmGen) {
          Audio.playSong(deferred, { restart: true });
        } else if (Audio._bgmGen != null || Audio._bgmLocal) {
          Audio.resumeBgm();
        } else if (restore != null) {
          Audio.playSong(restore, { restart: true });
        } else {
          Audio._bgmPaused = false;
        }
        const cb = Audio._waitFanfareCb;
        Audio._waitFanfareCb = undefined;
        if (cb) cb();
      }
    }

    // Cry duck restore
    if (Audio._duckHold && Audio._duckHold > 0) {
      Audio._duckHold = Audio._duckHold - dt * 60;
    } else if (Audio._duck && Audio._duck < 1 && Audio.isCryFinished()) {
      Audio._duck = 1;
      apply_bgm_gain();
    }

    // Fade out/in
    if (Audio._fadeOut) {
      const f = Audio._fadeOut;
      f.t = f.t + dt;
      const u = Math.min(1, f.t / Math.max(f.dur, 0.01));
      const stillSame = (f.gen == null || f.gen === Audio._bgmGen)
        && (f.songId == null || (Audio._currentSong && Audio._currentSong.id === f.songId));
      if (stillSame && Audio._bgmSource) {
        const vol = bgm_gain(f.start) * (1 - u);
        getAudio().setSongVolume(vol);
      }
      if (u >= 1) {
        if (stillSame) {
          stop_bgm_source();
          Audio._currentSong = undefined;
        }
        Audio._fadeOut = undefined;
        if (stillSame && f.nextSong != null) {
          if (f.fadeIn) {
            // pokeemerald/src/sound.c:151
            Audio.fadeInBgm(f.nextSong, f.fadeIn);
          } else {
            Audio.playSong(f.nextSong);
          }
        }
      }
    }
    if (Audio._fadeIn && Audio._bgmSource) {
      const f = Audio._fadeIn;
      f.t = f.t + dt;
      const u = Math.min(1, f.t / Math.max(f.dur, 0.01));
      getAudio().setSongVolume(bgm_gain() * u);
      if (u >= 1) Audio._fadeIn = undefined;
    }

    Audio.pumpBgm();

    // waitSe callbacks
    if (Audio._waitSe) {
      const pending: any[] = [null];
      for (const [, w] of ipairs<any>(Audio._waitSe)) {
        if (Audio.isSePlaying(w.id)) {
          pending[len(pending) + 1] = w;
        } else if (w.cb) {
          w.cb();
        }
      }
      Audio._waitSe = pending;
    }
  },

  // Lua: audio.lua:1567 -- the engine streams the song itself; nothing to drain
  pumpBgm(): void {
    if (Audio._suspended) return;
  },

  // Lua: audio.lua:1616
  setSuspended(flag: unknown): void {
    Audio._suspended = !!flag;
  },

  // Lua: audio.lua:1621
  onFocusGained(): void {
    Audio._suspended = false;
    if (Audio._bgmGen == null || Audio._bgmPaused) return;
    for (let n = 1; n <= 16; n++) Audio.pumpBgm();
    if (Audio._bgmSource) {
      try {
        getAudio().setSongVolume(bgm_gain());
        if (getAudio().songPaused()) getAudio().resumeSong();
      } catch { /* pcall */ }
    }
  },

  // Lua: audio.lua:1638 -- NOT FAITHFUL: no audio device to rebuild on the 3DS
  rebuildPlayback(): boolean {
    Audio._suspended = false;
    return true;
  },

  // Lua: audio.lua:1664
  endSession(): void {
    Audio.stopAll();
    if (Audio._fanfareSource) {
      stopSrc(Audio._fanfareSource);
      Audio._fanfareSource = undefined;
    }
    Audio._fanfareSrc = {};
    Audio._fanfareSd = {};
    Audio._seRawClear();
    Audio._fanfareRoot = undefined;
    Audio._fanfareRestore = undefined;
    Audio._fanfareDeferred = undefined;
    Audio._fanfarePending = undefined;
    Audio._fanfareFrames = 0;
    Audio._fanfareActive = false;
    if (Audio._bgmSource) {
      try { getAudio().stopSong(); } catch { /* pcall */ }
      Audio._bgmSource = undefined;
    }
    Audio._pack = undefined;
    Audio._meta = undefined;
    Audio._cache = undefined;
    Audio._ready = false;
    Audio._currentSong = undefined;
    Audio._mapSong = undefined;
    Audio._savedSong = undefined;
    Audio._bgmPaused = false;
    Audio._suspended = false;
    Audio._pendingBgm = undefined;
    Audio._bgmQueuedAt = [null];
    Audio._bgmBaseAt = 0;
    Audio._bgmGen = undefined;
    Audio._bgmLocal = undefined;
    Audio._duck = 1;
    Audio._duckHold = 0;
    Audio._seDuck = 1;
  },

  // Lua: audio.lua:1712
  shutdown(): void {
    try { Audio.endSession(); } catch { /* pcall */ }
    try { getAudio().stopAll(); } catch { /* pcall */ }
  },
};

// Lua: audio.lua:262
function species_name(species: number): string | undefined {
  const row = audio_profile();
  let C: any;
  try {
    C = Constants.of((row && row.id) || "firered");
  } catch {
    return undefined;
  }
  if (!C) return undefined;
  const byId = C.species.byId;
  const rev = byId && (byId.SPECIES_ || byId);
  return rev != null && typeof rev === "object" ? rev[species] : undefined;
}

// Lua: audio.lua:53 (the metatable __index: MUS_CYCLING / MUS_SURF / MUS_UNDERWATER per profile)
for (const k of Object.keys(RIDE_SONG_KEYS)) {
  Object.defineProperty(Audio, k, {
    get() {
      const role = RIDE_SONG_KEYS[k]!;
      const names = Audio.config().rideSongs;
      return Audio.songs()[(names && names[role]) || k];
    },
    enumerable: false,
    configurable: true,
  });
}

// Lua: audio.lua:1727
try {
  SessionLifecycle.registerProcessShutdown(Audio.shutdown);
} catch { /* pcall */ }

export default Audio;
