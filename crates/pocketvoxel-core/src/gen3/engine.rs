// Port of gen1recomp src/core/game3/m4a_worker.lua (GPLv3 + additional terms; see crates/pocketvoxel-core/src/gen3/LICENSE.md).

//! The host-side engine: what gen1recomp's BGM worker (`m4a_worker.lua`)
//! and the playback half of `audio.lua` do with the M4A players, as one
//! pull-model mixer the host's audio callback drives with
//! [`M4a::render`]. `audio.lua`'s policy (song ids by name, map music,
//! fades, cry ducking, the fanfare countdown, help dimming, cry timers)
//! stays in the guest, which calls the methods here.
//!
//! What each player outputs, sample for sample:
//!
//! * **BGM** — the worker's stream (m4a_worker.lua:159-222):
//!   `Player.renderBuffered(bgm, 8192)` blocks from a slot started with
//!   `Player.start(..., {forceSeq = true})`; once the song is done with no
//!   voices and a quiet reverb, every rendered block is followed by the
//!   worker's 8192-sample silent "ended" block. The slot keeps its
//!   `reverb` across songs (`bgm = {..., reverb = bgm.reverb}`). The mono
//!   option is read per block, as the worker reads `bgm.mono`. Played at
//!   the volume the guest sets ([`M4a::set_song_volume`] = audio.lua's
//!   `bgm_gain()` incl. fades and ducks).
//! * **SE** — audio.lua `playSe` (:915): the bake of `Player.bakeSlot` with
//!   the same loop/loopBody/cut/maxSec rules, the master gain and the
//!   `_seGains` pan, played once, looped whole (static looping Source) or
//!   as intro + repeating body (`_newIntroLoopSource`). One SE per M4A
//!   player (`_stopSePlayer`), player = `index.songs[id].player or 1`.
//! * **Fanfare** — `start_fanfare_source` (:1217): the bake of
//!   `Player.bakeSong` (maxSec = frames/60 + 4), on player
//!   `info.player or 2`, at the volume given (audio.lua passes
//!   `_bgmVolume`). At most one.
//! * **Cry** — `Audio.playCry` (:1325): `Sample.renderCry` of the cry's
//!   sample at `Mix.waveRate(meta.freq)`, mono, or panned with
//!   (127-pan)/191 and (128+pan)/191 when `pan ~= 0`; at the volume given
//!   (`_sfxVolume`). A new cry does not stop the previous one (audio.lua
//!   only drops its reference); [`M4a::stop_cry`] stops the current one.
//!
//! Each player's float output is clipped to [-1, 1] and quantised to s16
//! as its LÖVE SoundData is (`trunc(x * 32767)`), scaled by its Source
//! volume, and the players are summed and clamped to s16.
//!
//! NOT FAITHFUL (host side, by design):
//! * OpenAL's mixing is not modelled: its resampling to the device rate,
//!   the gain ramp it applies on a volume change, and its panning law for
//!   mono Sources (here a mono player feeds both channels at full gain).
//! * `pauseBgm` → worker `stopAt` rewinds the sequencer to the *heard*
//!   position (snapshots every 8192 samples, voices re-triggered from the
//!   snapshot). With no queue between this mixer and the speaker the
//!   heard position is the rendered one, for which `Player.stopAt` only
//!   resets the DC blocker and reverb — which is what
//!   [`M4a::pause_song`] does.
//! * A looping SE's pan is locked while its bake is still running in
//!   loop-body mode (in Lua the bake finishes before playback, so an
//!   intro+body Source — whose pan `setSePan` never changes — is known up
//!   front); if that bake ends without closing the body, later pan
//!   changes apply again.

use alloc::vec;
use alloc::vec::Vec;

use super::m4a_mix as mix;
use super::m4a_player::{BUFFER_SAMPLES, Bake, Slot};
use super::m4a_sample::CryMix;
pub use super::m4a_sample::CryParams;
use super::pack::AudioPack;

/// se_ids.lua: SE_SELECT / SE_EXP / SE_LOW_HEALTH.
pub const SE_SELECT: f64 = 5.0;
pub const SE_EXP: f64 = 27.0;
pub const SE_LOW_HEALTH: f64 = 83.0;
/// audio.lua:809-810
pub const SE_LOOP_MAX_SEC: f64 = 2.5;
pub const SE_ONESHOT_MAX_SEC: f64 = 30.0;

/// `opts` of `Audio.playSe`, resolved: `gain` is the master gain
/// (`_sfxVolume * (opts.volume or 1)`), `pan` the panpot (-64..63, as
/// `Audio.normalizePan` returns it).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SeOptions {
    pub looping: Option<bool>,
    pub max_sec: Option<f64>,
    pub pan: f64,
    pub gain: f64,
}

impl Default for SeOptions {
    fn default() -> Self {
        SeOptions {
            looping: None,
            max_sec: None,
            pan: 0.0,
            gain: 1.0,
        }
    }
}

/// audio.lua:1009 `Audio.normalizePan` for numbers.
pub fn normalize_pan(pan: f64) -> f64 {
    pan.clamp(-64.0, 63.0)
}

/// audio.lua:1024 `Audio._seGains`.
pub fn se_gains(pan: f64) -> (f64, f64) {
    let pan = pan.clamp(-64.0, 63.0);
    let pan_n = pan / 64.0;
    (1.0 - 0.0f64.max(pan_n), 1.0 - 0.0f64.max(-pan_n))
}

#[inline]
fn clip1(x: f64) -> f64 {
    if x > 1.0 {
        1.0
    } else if x < -1.0 {
        -1.0
    } else {
        x
    }
}

/// SoundData quantisation of a clipped sample.
#[inline]
fn q16(x: f64) -> f64 {
    // |x| <= 1, so the cast truncates toward zero exactly as C's would.
    (x * 32767.0) as i32 as f64
}

/// audio.lua:1132 `Audio._songHasGoto`.
fn song_has_goto(slot: &Slot) -> bool {
    if let Some(g) = slot.info.and_then(|i| i.has_goto) {
        return g;
    }
    match &slot.seq {
        Some(s) => s.tracks.iter().any(|t| t.data.contains(&0xB2)),
        None => false,
    }
}

/// The bake parameters of audio.lua `playSe` (:928-963) → (player, slot,
/// bake, looping, loopBody), or `None` when the song is missing.
fn prepare_se(
    pack: &AudioPack,
    rate: f64,
    id: f64,
    opts: &SeOptions,
) -> Option<(usize, Slot, Bake, bool, bool)> {
    let info = pack.song_info(id).copied();
    let mplay = info.and_then(|i| i.player).unwrap_or(1.0);
    let mut slot = Slot::new(rate);
    if !slot.start(pack, id) {
        return None;
    }
    let looping = opts
        .looping
        .unwrap_or(id == SE_LOW_HEALTH || song_has_goto(&slot));
    let loop_body = looping && opts.looping.is_none() && id != SE_LOW_HEALTH;
    let cut = (looping && !loop_body) || id == SE_EXP;
    let max_sec = opts.max_sec.unwrap_or(if cut {
        SE_LOOP_MAX_SEC
    } else {
        SE_ONESHOT_MAX_SEC
    });
    let bake = Bake::slot(rate, max_sec, looping, loop_body);
    let mplay = if (0.0..4.0).contains(&mplay) {
        mplay as usize
    } else {
        1
    };
    Some((mplay, slot, bake, looping, loop_body))
}

/// A baked SE or fanfare, rendered lazily.
struct OneShot {
    id: f64,
    is_fanfare: bool,
    slot: Slot,
    bake: Bake,
    looping: bool,
    /// The bake runs in loop-body mode (`loopBody` in audio.lua).
    loop_body: bool,
    rec_l: Vec<f64>,
    rec_r: Vec<f64>,
    chunk_l: Vec<f64>,
    chunk_r: Vec<f64>,
    chunk_pos: usize,
    /// After the bake: replay position in the recording and its loop start.
    replay: Option<(usize, usize)>,
    done: bool,
    master: f64,
    pan: f64,
    gains: (f64, f64),
    mono: bool,
    volume: f64,
}

impl OneShot {
    #[allow(clippy::too_many_arguments)]
    fn new(
        id: f64,
        is_fanfare: bool,
        slot: Slot,
        bake: Bake,
        looping: bool,
        loop_body: bool,
        master: f64,
        pan: f64,
        mono: bool,
        volume: f64,
    ) -> OneShot {
        let g = se_gains(pan);
        OneShot {
            id,
            is_fanfare,
            slot,
            bake,
            looping,
            loop_body,
            rec_l: Vec::new(),
            rec_r: Vec::new(),
            chunk_l: Vec::new(),
            chunk_r: Vec::new(),
            chunk_pos: 0,
            replay: None,
            done: false,
            master,
            pan,
            gains: if is_fanfare {
                (1.0, 1.0)
            } else {
                (master * g.0, master * g.1)
            },
            mono,
            volume,
        }
    }

    /// `setSePan` never changes an intro+body Source.
    fn pan_locked(&self) -> bool {
        if !self.loop_body {
            return false;
        }
        !self.bake.finished || self.intro_loop_start().is_some()
    }

    /// `_newIntroLoopSource` applies (loopStart in 1..n-1).
    fn intro_loop_start(&self) -> Option<usize> {
        let ls = self.bake.result_loop_start()?;
        if ls > 0 && ls < self.bake.total {
            Some(ls)
        } else {
            None
        }
    }

    /// The next raw (pre-gain) bake sample.
    fn next_raw(&mut self, pack: &AudioPack) -> Option<(f64, f64)> {
        if self.done {
            return None;
        }
        if let Some((pos, start)) = self.replay {
            if self.rec_l.is_empty() {
                self.done = true;
                return None;
            }
            let p = if pos >= self.rec_l.len() { start } else { pos };
            self.replay = Some((p + 1, start));
            return Some((self.rec_l[p], self.rec_r[p]));
        }
        while self.chunk_pos >= self.chunk_l.len() {
            let n = self
                .bake
                .step(&mut self.slot, pack, &mut self.chunk_l, &mut self.chunk_r);
            self.chunk_pos = 0;
            if n == 0 {
                self.chunk_l.clear();
                self.chunk_r.clear();
                if self.bake.empty_result() && !self.looping {
                    // `if #L == 0 then L[1] = 0`: one silent sample.
                    self.done = true;
                    return Some((0.0, 0.0));
                }
                if self.looping {
                    let start = self.intro_loop_start().unwrap_or(0);
                    if self.rec_l.is_empty() {
                        self.rec_l.push(0.0);
                        self.rec_r.push(0.0);
                    }
                    self.replay = Some((start, start));
                    return self.next_raw(pack);
                }
                self.done = true;
                return None;
            }
            if self.looping {
                self.rec_l.extend_from_slice(&self.chunk_l);
                self.rec_r.extend_from_slice(&self.chunk_r);
            }
        }
        let i = self.chunk_pos;
        self.chunk_pos += 1;
        Some((self.chunk_l[i], self.chunk_r[i]))
    }

    /// Next output sample pair (s16-valued, before the Source volume).
    fn next(&mut self, pack: &AudioPack) -> Option<(f64, f64)> {
        let (l, r) = self.next_raw(pack)?;
        let l = clip1(l * self.gains.0);
        let r = clip1(r * self.gains.1);
        if self.mono {
            let m = q16((l + r) * 0.5);
            Some((m, m))
        } else {
            Some((q16(l), q16(r)))
        }
    }
}

struct CryStream {
    serial: u32,
    mix: CryMix,
    i: usize,
    gains: Option<(f64, f64)>,
    volume: f64,
}

struct Bgm {
    slot: Slot,
    song_id: Option<f64>,
    muted: bool,
    block_left: usize,
    block_silent: bool,
    pending_silent: bool,
    mono: bool,
    volume: f64,
}

/// The engine (see the module docs).
pub struct M4a {
    pack: AudioPack,
    rate: f64,
    bgm: Bgm,
    players: [Option<OneShot>; 4],
    cries: Vec<CryStream>,
    current_cry: Option<u32>,
    cry_serial: u32,
    mono: bool,
    scratch_l: Vec<f64>,
    scratch_r: Vec<f64>,
    acc: Vec<f64>,
}

impl M4a {
    /// Load the pack and fix the output rate (`Mix.setSampleRate`: 8000..
    /// 48000 Hz, anything else falls back to ChipSynth's 44100).
    pub fn new(pack: AudioPack, rate: u32) -> M4a {
        let rate = mix::set_sample_rate(mix::DEFAULT_SAMPLE_RATE, rate as f64);
        M4a {
            pack,
            rate,
            bgm: Bgm {
                slot: Slot::new(rate),
                song_id: None,
                muted: false,
                block_left: 0,
                block_silent: false,
                pending_silent: false,
                mono: false,
                volume: 1.0,
            },
            players: [None, None, None, None],
            cries: Vec::new(),
            current_cry: None,
            cry_serial: 0,
            mono: false,
            scratch_l: Vec::new(),
            scratch_r: Vec::new(),
            acc: Vec::new(),
        }
    }

    pub fn rate(&self) -> u32 {
        self.rate as u32
    }

    pub fn pack(&self) -> &AudioPack {
        &self.pack
    }

    /// Worker `play` (m4a_worker.lua:111): start `id` on the BGM player.
    pub fn play_song(&mut self, id: u16) -> bool {
        let reverb = self.bgm.slot.reverb;
        self.bgm.slot = Slot::new(self.rate);
        self.bgm.slot.reverb = reverb;
        self.bgm.song_id = Some(id as f64);
        self.bgm.muted = false;
        self.bgm.block_left = 0;
        self.bgm.block_silent = false;
        self.bgm.pending_silent = false;
        self.bgm.slot.start(&self.pack, id as f64)
    }

    /// Worker `stop` (m4a_worker.lua:117).
    pub fn stop_song(&mut self) {
        self.bgm.slot.seq = None;
        self.bgm.slot.done = true;
        self.bgm.song_id = None;
        self.bgm.block_left = 0;
        self.bgm.pending_silent = false;
    }

    /// Worker `stopAt` at the heard position (m4a_worker.lua:123) — see the
    /// module docs for why that is the rendered position here.
    pub fn pause_song(&mut self) {
        self.bgm.slot.reset_filters();
        self.bgm.muted = true;
    }

    /// Worker `resume` (m4a_worker.lua:130).
    pub fn resume_song(&mut self) {
        self.bgm.muted = false;
    }

    /// The BGM Source volume (audio.lua `bgm_gain()` with fades applied).
    pub fn set_song_volume(&mut self, gain: f64) {
        self.bgm.volume = gain;
    }

    /// The song id on the BGM player (until [`stop_song`](Self::stop_song)).
    pub fn song(&self) -> Option<u16> {
        self.bgm.song_id.map(|s| s as u16)
    }

    pub fn song_paused(&self) -> bool {
        self.bgm.muted
    }

    /// Worker `mix` / audio.lua `_mono`: mono output for BGM (per block),
    /// and for SEs and fanfares started from now on.
    pub fn set_mono(&mut self, mono: bool) {
        self.mono = mono;
    }

    /// audio.lua `Audio.playSe(id, opts)` (the part after id resolution and
    /// fanfare routing, which the guest does). Replaces the SE on the
    /// song's M4A player. `false` = the song is missing.
    pub fn play_se(&mut self, id: u16, opts: SeOptions) -> bool {
        let id = id as f64;
        let (mplay, slot, bake, looping, loop_body) =
            match prepare_se(&self.pack, self.rate, id, &opts) {
                Some(p) => p,
                None => return false,
            };
        let pan = normalize_pan(opts.pan);
        self.players[mplay] = Some(OneShot::new(
            id, false, slot, bake, looping, loop_body, opts.gain, pan, self.mono, 1.0,
        ));
        true
    }

    /// audio.lua `_stopSePlayer(mplay)`.
    pub fn stop_se_player(&mut self, mplay: usize) {
        if mplay < 4 {
            self.players[mplay] = None;
        }
    }

    /// audio.lua `Audio.stopSe(id)` (`None` = all, fanfare included).
    pub fn stop_se(&mut self, id: Option<u16>) {
        for p in self.players.iter_mut() {
            if p.as_ref()
                .map_or(false, |o| id.map_or(true, |i| o.id == i as f64))
            {
                *p = None;
            }
        }
    }

    /// audio.lua `Audio.isSePlaying(id)` (`None` = any, fanfare included).
    pub fn se_playing(&self, id: Option<u16>) -> bool {
        self.players
            .iter()
            .flatten()
            .any(|o| !o.done && id.map_or(true, |i| o.id == i as f64))
    }

    /// The song id playing on M4A player `mplay`, if any.
    pub fn player_song(&self, mplay: usize) -> Option<u16> {
        self.players
            .get(mplay)?
            .as_ref()
            .filter(|o| !o.done)
            .map(|o| o.id as u16)
    }

    /// audio.lua `Audio.setSePan(pan)` (:1069): re-pans the SEs on players
    /// 1 and 2 (not fanfares, not intro+body loops, not mono ones).
    pub fn set_se_pan(&mut self, pan: f64) -> f64 {
        let pan = normalize_pan(pan);
        for mplay in [1usize, 2] {
            if let Some(o) = self.players[mplay].as_mut() {
                if !o.is_fanfare && !o.pan_locked() && o.pan != pan {
                    o.pan = pan;
                    if !o.done && !o.mono {
                        let g = se_gains(pan);
                        o.gains = (o.master * g.0, o.master * g.1);
                    }
                }
            }
        }
        pan
    }

    /// audio.lua `start_fanfare_source` (:1217) with the worker's bake
    /// (m4a_worker.lua:141): plays fanfare `id` once at `volume`.
    pub fn play_fanfare(&mut self, id: u16, volume: f64) -> bool {
        let id = id as f64;
        for p in self.players.iter_mut() {
            if p.as_ref().map_or(false, |o| o.is_fanfare) {
                *p = None;
            }
        }
        let info = self.pack.song_info(id).copied();
        let mplay = info.and_then(|i| i.player).unwrap_or(2.0);
        let mplay = if mplay >= 0.0 && mplay < 4.0 {
            mplay as usize
        } else {
            2
        };
        self.players[mplay] = None;
        let frames = info.and_then(|i| i.fanfare_frames).unwrap_or(160.0);
        let mut slot = Slot::new(self.rate);
        if !slot.start(&self.pack, id) {
            return false;
        }
        let bake = Bake::song(self.rate, frames / 60.0 + 4.0);
        self.players[mplay] = Some(OneShot::new(
            id, true, slot, bake, false, false, 1.0, 0.0, self.mono, volume,
        ));
        true
    }

    /// Whether a fanfare is still sounding.
    pub fn fanfare_playing(&self) -> bool {
        self.players
            .iter()
            .flatten()
            .any(|o| o.is_fanfare && !o.done)
    }

    /// Stop the fanfare (audio.lua stops `_fanfareSource`).
    pub fn stop_fanfare(&mut self) {
        for p in self.players.iter_mut() {
            if p.as_ref().map_or(false, |o| o.is_fanfare) {
                *p = None;
            }
        }
    }

    /// audio.lua `Audio.playCry(species, mode, pan)` (:1325) after the
    /// params are resolved: plays the cry at `volume` (`_sfxVolume`).
    /// Returns `info.frames` (the length the guest's cry timer waits), or
    /// `None` when the cry or its sample is missing.
    pub fn play_cry(
        &mut self,
        species: u16,
        params: &CryParams,
        pan: f64,
        volume: f64,
    ) -> Option<f64> {
        // Player.startCry (m4a_player.lua:299)
        let sp = species as f64;
        let idx = self.pack.cry_id(sp).unwrap_or_else(|| 0.0f64.max(sp - 1.0));
        let sid = self.pack.cry_sample_id(idx)?;
        let meta = *self.pack.sample(sid)?;
        let pcm = self.pack.pcm_range(&meta)?;
        let m = CryMix::new(pcm, mix::wave_rate(meta.freq), params, self.rate)?;
        let frames = m.frames;
        let gains = if pan != 0.0 {
            let p = normalize_pan(pan);
            Some(((127.0 - p) / 191.0, (128.0 + p) / 191.0))
        } else {
            None
        };
        self.cry_serial = self.cry_serial.wrapping_add(1);
        self.cries.push(CryStream {
            serial: self.cry_serial,
            mix: m,
            i: 0,
            gains,
            volume,
        });
        self.current_cry = Some(self.cry_serial);
        Some(frames)
    }

    /// audio.lua `Audio.stopCry` (the current cry only).
    pub fn stop_cry(&mut self) {
        if let Some(s) = self.current_cry.take() {
            self.cries.retain(|c| c.serial != s);
        }
    }

    /// `_crySource:isPlaying()`.
    pub fn cry_playing(&self) -> bool {
        self.current_cry
            .map_or(false, |s| self.cries.iter().any(|c| c.serial == s))
    }

    /// audio.lua `Audio.stopAll`.
    pub fn stop_all(&mut self) {
        self.stop_song();
        self.stop_se(None);
        self.stop_cry();
    }

    /// Render `out.len() / 2` stereo frames (interleaved L, R) at
    /// [`rate`](Self::rate).
    pub fn render(&mut self, out: &mut [i16]) {
        let frames = out.len() / 2;
        if self.acc.len() < frames * 2 {
            self.acc.resize(frames * 2, 0.0);
        }
        for a in self.acc[..frames * 2].iter_mut() {
            *a = 0.0;
        }
        self.render_bgm(frames);
        let pack = &self.pack;
        for p in self.players.iter_mut() {
            if let Some(o) = p.as_mut() {
                let vol = o.volume;
                for f in 0..frames {
                    match o.next(pack) {
                        Some((l, r)) => {
                            self.acc[f * 2] += l * vol;
                            self.acc[f * 2 + 1] += r * vol;
                        }
                        None => break,
                    }
                }
            }
        }
        let bin = pack.samples_bin();
        for c in self.cries.iter_mut() {
            for f in 0..frames {
                if c.i >= c.mix.n_out {
                    break;
                }
                let v = c.mix.sample(bin, c.i);
                c.i += 1;
                let (l, r) = match c.gains {
                    Some((gl, gr)) => (q16(v * gl), q16(v * gr)),
                    None => (q16(v), q16(v)),
                };
                self.acc[f * 2] += l * c.volume;
                self.acc[f * 2 + 1] += r * c.volume;
            }
        }
        self.cries.retain(|c| c.i < c.mix.n_out);
        if let Some(s) = self.current_cry {
            if !self.cries.iter().any(|c| c.serial == s) {
                self.current_cry = None;
            }
        }
        for (o, a) in out[..frames * 2].iter_mut().zip(self.acc.iter()) {
            *o = a.clamp(-32768.0, 32767.0) as i16;
        }
    }

    fn render_bgm(&mut self, frames: usize) {
        if self.bgm.song_id.is_none() || self.bgm.muted {
            return;
        }
        if self.scratch_l.len() < frames {
            self.scratch_l.resize(frames, 0.0);
            self.scratch_r.resize(frames, 0.0);
        }
        let mut f = 0;
        while f < frames {
            if self.bgm.block_left == 0 {
                self.bgm.block_left = BUFFER_SAMPLES;
                self.bgm.block_silent = self.bgm.pending_silent;
                self.bgm.pending_silent = false;
                self.bgm.mono = self.mono;
            }
            let n = self.bgm.block_left.min(frames - f);
            if !self.bgm.block_silent {
                let (l, r) = (&mut self.scratch_l[f..f + n], &mut self.scratch_r[f..f + n]);
                self.bgm.slot.render_buffered(&self.pack, l, r);
                let vol = self.bgm.volume;
                for i in f..f + n {
                    let cl = clip1(self.scratch_l[i]);
                    let cr = clip1(self.scratch_r[i]);
                    let (ql, qr) = if self.bgm.mono {
                        let m = q16((cl + cr) * 0.5);
                        (m, m)
                    } else {
                        (q16(cl), q16(cr))
                    };
                    self.acc[i * 2] += ql * vol;
                    self.acc[i * 2 + 1] += qr * vol;
                }
            }
            self.bgm.block_left -= n;
            f += n;
            if self.bgm.block_left == 0 && !self.bgm.block_silent {
                // m4a_worker.lua:197 — the "ended" block after a finished song.
                let s = &self.bgm.slot;
                if s.done && s.voices().is_empty() && !s.reverb_state.active() {
                    self.bgm.pending_silent = true;
                }
            }
        }
    }
}

/// Lower-level access for tests and tools: the raw (pre-clip) streams the
/// Lua's bakes and worker produce.
pub mod raw {
    use super::*;

    /// `Player.renderBuffered` blocks exactly as the worker queues them
    /// (silent "ended" blocks included), raw. Returns (L, R).
    pub fn bgm(pack: &AudioPack, id: u16, rate: u32, n: usize) -> (Vec<f64>, Vec<f64>) {
        let rate = mix::set_sample_rate(mix::DEFAULT_SAMPLE_RATE, rate as f64);
        let mut slot = Slot::new(rate);
        slot.start(pack, id as f64);
        let mut l = vec![0.0; n];
        let mut r = vec![0.0; n];
        let mut at = 0;
        let mut silent = false;
        while at < n {
            let m = BUFFER_SAMPLES.min(n - at);
            if !silent {
                slot.render_buffered(pack, &mut l[at..at + m], &mut r[at..at + m]);
            }
            at += m;
            if silent {
                silent = false;
            } else if slot.done && slot.voices().is_empty() && !slot.reverb_state.active() {
                silent = true;
            }
        }
        (l, r)
    }

    /// audio.lua `playSe`'s bake (`Player.bakeSlot`), raw: (L, R,
    /// loopStart, looping).
    pub fn se(
        pack: &AudioPack,
        id: u16,
        rate: u32,
        opts: SeOptions,
    ) -> Option<(Vec<f64>, Vec<f64>, Option<usize>, bool)> {
        let rate = mix::set_sample_rate(mix::DEFAULT_SAMPLE_RATE, rate as f64);
        let (_, mut slot, mut bake, looping, _) = prepare_se(pack, rate, id as f64, &opts)?;
        let (mut l, mut r) = (Vec::new(), Vec::new());
        let (mut cl, mut cr) = (Vec::new(), Vec::new());
        while bake.step(&mut slot, pack, &mut cl, &mut cr) > 0 {
            l.extend_from_slice(&cl);
            r.extend_from_slice(&cr);
        }
        if l.is_empty() {
            l.push(0.0);
            r.push(0.0);
        }
        Some((l, r, bake.result_loop_start(), looping))
    }

    /// `Sample.renderCryMix` of a species' cry at `rate` (mono): (out, frames).
    pub fn cry(
        pack: &AudioPack,
        species: u16,
        params: &CryParams,
        rate: u32,
    ) -> Option<(Vec<f64>, f64)> {
        let rate = mix::set_sample_rate(mix::DEFAULT_SAMPLE_RATE, rate as f64);
        let sp = species as f64;
        let idx = pack.cry_id(sp).unwrap_or_else(|| 0.0f64.max(sp - 1.0));
        let meta = *pack.sample(pack.cry_sample_id(idx)?)?;
        let m = CryMix::new(
            pack.pcm_range(&meta)?,
            mix::wave_rate(meta.freq),
            params,
            rate,
        )?;
        let bin = pack.samples_bin();
        Some(((0..m.n_out).map(|i| m.sample(bin, i)).collect(), m.frames))
    }

    /// The fanfare bake (`Player.bakeSong`, maxSec = frames/60 + 4), raw.
    pub fn fanfare(pack: &AudioPack, id: u16, rate: u32) -> Option<(Vec<f64>, Vec<f64>)> {
        let rate = mix::set_sample_rate(mix::DEFAULT_SAMPLE_RATE, rate as f64);
        let frames = pack
            .song_info(id as f64)
            .and_then(|i| i.fanfare_frames)
            .unwrap_or(160.0);
        let mut slot = Slot::new(rate);
        if !slot.start(pack, id as f64) {
            return None;
        }
        let mut bake = Bake::song(rate, frames / 60.0 + 4.0);
        let (mut l, mut r) = (Vec::new(), Vec::new());
        let (mut cl, mut cr) = (Vec::new(), Vec::new());
        while bake.step(&mut slot, pack, &mut cl, &mut cr) > 0 {
            l.extend_from_slice(&cl);
            r.extend_from_slice(&cr);
        }
        if l.is_empty() {
            l.push(0.0);
            r.push(0.0);
        }
        Some((l, r))
    }
}
