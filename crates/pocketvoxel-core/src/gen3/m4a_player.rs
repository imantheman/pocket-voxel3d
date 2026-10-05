// Port of gen1recomp src/core/game3/m4a_player.lua (GPLv3 + additional terms; see crates/pocketvoxel-core/src/gen3/LICENSE.md).

//! Player slots + voice resolution (m4a_player.lua). A [`Slot`] is the
//! Lua's slot table; [`Bake`] is the loop of `Player.bakeSlot` /
//! `Player.bakeSong` turned inside out so it can be driven a chunk at a
//! time from an audio callback.
//! Not ported: `Player.startCry` (audio.lua only uses it to find the cry's
//! sample — see `engine::M4a::play_cry`), `snapshotSlot`/`stopAt` (the
//! worker's rewind; see `engine::M4a::pause_song`) and the LÖVE SoundData
//! wrapping of the bake results.

use alloc::vec::Vec;

use super::m4a_mix::{self as mix, CgbOpts, DsOpts, Reverb, Voice, VoiceKind};
use super::m4a_seq::{self as seq, SeqPlayer, Track, VoiceResolver};
use super::pack::{AudioPack, SongInfo, Tone};
use super::{floor, lmod};

/// Lua: m4a_player.lua:12
pub const BUFFER_SAMPLES: usize = 8192;

/// Lua: m4a_player.lua:20 `Player.mixQuantum` — output samples per vblank.
pub fn mix_quantum(rate: f64) -> usize {
    let spv = mix::samples_per_vblank(rate);
    let mut n = floor(spv + 0.5);
    if n < 256.0 {
        n = 256.0;
    }
    if n > 2048.0 {
        n = 2048.0;
    }
    n as usize
}

/// Lua: m4a_player.lua:83
fn tone_at(vg: &[Option<Tone>], idx: f64) -> Option<Tone> {
    if idx >= 0.0 && idx < vg.len() as f64 && idx == floor(idx) {
        vg[idx as usize]
    } else {
        None
    }
}

/// Lua: m4a_player.lua:89 `resolve_tone` — through SPL/RHY to a concrete tone.
fn resolve_tone(
    pack: &AudioPack,
    vg_id: Option<f64>,
    voice_id: f64,
    raw_key: f64,
    depth: u32,
) -> Option<Tone> {
    if depth > 6 {
        return None;
    }
    let vg = pack.voicegroup(vg_id?);
    let tone = tone_at(vg?, voice_id)?;
    let typ = tone.typ.unwrap_or(0.0);
    let spl = lmod(floor(typ / 64.0), 2.0) == 1.0;
    let rhy = typ >= 128.0;
    if spl {
        let mut idx = 0.0;
        if tone.key_split.is_some() {
            idx = pack.key_split(&tone, raw_key).unwrap_or(0.0);
        }
        if let Some(sub_vg) = tone.sub_vg_id.and_then(|id| pack.voicegroup(id)) {
            if tone_at(sub_vg, idx).is_none() {
                idx = 0.0;
            }
        }
        return resolve_tone(pack, tone.sub_vg_id, idx, raw_key, depth + 1);
    }
    if rhy {
        let sub = resolve_tone(pack, tone.sub_vg_id, raw_key, raw_key, depth + 1)?;
        return Some(Tone {
            typ: sub.typ,
            key: sub.key,
            length: sub.length,
            pan: sub.pan,
            sample_id: sub.sample_id,
            attack: sub.attack,
            decay: sub.decay,
            sustain: sub.sustain,
            release: sub.release,
            wav_param: sub.wav_param,
            sub_vg_id: None,
            key_split: None,
            wave: sub.wave,
            is_rhy: true,
        });
    }
    Some(tone)
}

/// Lua: m4a_player.lua:133 `make_voice_from_tone`.
#[allow(clippy::too_many_arguments)]
fn make_voice_from_tone(
    pack: &AudioPack,
    tone: &Tone,
    raw_key: f64,
    abs_key: f64,
    vol_l: f64,
    vol_r: f64,
    fine: f64,
    tr: Option<&Track>,
    rate: f64,
) -> Option<Voice> {
    let typ = tone.typ.unwrap_or(0.0);
    let kind = lmod(typ, 8.0);
    let mut base_key = raw_key;
    let mut note_key = abs_key;
    if tone.is_rhy {
        if let Some(k) = tone.key {
            let key_m = tr.map_or(0.0, |t| seq::track_pitch(t).0);
            base_key = k;
            note_key = k + key_m;
        }
    }
    if note_key < 0.0 {
        note_key = 0.0;
    }
    if note_key > 178.0 {
        note_key = 178.0;
    }

    let mut rhythm_pan = 0.0;
    if tone.is_rhy {
        if let Some(p) = tone.pan {
            if p >= 128.0 {
                rhythm_pan = (p - 192.0) * 2.0;
            }
        }
    }
    let (vol_l, vol_r) = match tr {
        Some(t) => seq::track_volume(t, t.vel, rhythm_pan),
        None => (vol_l, vol_r),
    };

    let mut v;
    if kind == 0.0 && tone.sample_id.is_some() {
        let meta = pack.sample(tone.sample_id.unwrap());
        let pcm = meta.and_then(|m| pack.pcm_range(m));
        let (meta, pcm) = match (meta, pcm) {
            (Some(m), Some(p)) => (m, p),
            _ => return None,
        };
        let fixed = lmod(floor(typ / 8.0), 2.0) == 1.0;
        // pret MidiKeyToFreq(wav, noteKey, fine) — returns playback Hz.
        let r = if fixed {
            mix::GBA_MIX_RATE
        } else {
            mix::midi_key_to_freq(meta.freq, note_key, fine)
        };
        // WaveData.flags is the high byte of cached status; loops may start at zero.
        let looping = lmod(floor(meta.status / 16384.0), 4.0) != 0.0 && meta.loop_start < meta.size;
        v = mix::new_ds_voice(
            pcm,
            meta,
            DsOpts {
                rate: Some(r),
                looping,
                vol_l: Some(vol_l),
                vol_r: Some(vol_r),
                tone: Some(tone),
            },
            rate,
        );
        v.wav_freq = Some(meta.freq);
        v.fixed_freq = fixed;
    } else if (1.0..=4.0).contains(&kind) {
        let mut opts = CgbOpts {
            key: note_key,
            fine,
            duty: 2,
            cgb_chan: kind as u8,
            vol_l,
            vol_r,
            tone: Some(tone),
            wave: [8.0; 32],
            period: None,
        };
        if kind == 1.0 || kind == 2.0 {
            let wp = tone.wav_param.unwrap_or(0.0);
            if wp <= 3.0 && wp >= 0.0 && wp == floor(wp) {
                opts.duty = wp as usize;
            } else if wp <= 3.0 {
                // DUTY[v.duty] or DUTY[2]: a non-index duty plays as 50%.
                opts.duty = 2;
            }
            v = mix::new_cgb_pulse(&opts);
        } else if kind == 3.0 {
            match pack.wave(tone) {
                Some(w) if w.len() >= 32 => {
                    for i in 0..32 {
                        opts.wave[i] = w[i] as f64;
                    }
                }
                _ => {
                    for i in 0..32 {
                        opts.wave[i] = ((i + 1) % 16) as f64;
                    }
                }
            }
            v = mix::new_cgb_wave(&opts);
        } else {
            opts.period = Some(mix::cgb_noise_period(note_key, rate));
            v = mix::new_cgb_noise(&opts, rate);
        }
    } else {
        return None;
    }

    v.note_key = Some(base_key);
    v.rhythm_pan = Some(rhythm_pan);
    if let (Some(a), Some(t)) = (v.adsr.as_mut(), tr) {
        a.pseudo_echo_volume = t.pseudo_echo_volume;
        a.pseudo_echo_length = t.pseudo_echo_length;
    }
    if v.kind == VoiceKind::Ds {
        v.pos = tr.and_then(|t| t.sample_start).unwrap_or(0.0);
    } else if tone.length.unwrap_or(0.0) > 0.0 {
        let max_length = if kind == 3.0 { 256.0 } else { 64.0 };
        v.length_remaining =
            Some((max_length - lmod(tone.length.unwrap(), max_length)) * rate / 256.0);
    }
    Some(v)
}

/// The resolver closure of `Player.start` (m4a_player.lua:281).
pub struct Resolver<'a> {
    pub pack: &'a AudioPack,
    pub vg_id: Option<f64>,
    pub rate: f64,
}

impl VoiceResolver for Resolver<'_> {
    fn resolve(
        &self,
        voice_id: f64,
        raw_key: f64,
        _vel: f64,
        tr: &Track,
        vol_l: f64,
        vol_r: f64,
        fine: f64,
        abs_key: f64,
    ) -> Option<Voice> {
        let mut tone = resolve_tone(self.pack, self.vg_id, voice_id, raw_key, 0)?;
        if let Some(o) = tr.tone_overrides {
            if let Some(x) = o.typ {
                tone.typ = Some(x);
            }
            if let Some(x) = o.attack {
                tone.attack = Some(x);
            }
            if let Some(x) = o.decay {
                tone.decay = Some(x);
            }
            if let Some(x) = o.sustain {
                tone.sustain = Some(x);
            }
            if let Some(x) = o.release {
                tone.release = Some(x);
            }
            if let Some(x) = o.length {
                tone.length = Some(x);
            }
            if let Some(x) = o.pan {
                tone.pan = Some(x);
            }
        }
        make_voice_from_tone(
            self.pack,
            &tone,
            raw_key,
            abs_key,
            vol_l,
            vol_r,
            fine,
            Some(tr),
            self.rate,
        )
    }
}

/// A player slot table (`slot` in m4a_player.lua).
#[derive(Clone, Debug)]
pub struct Slot {
    pub song_id: Option<f64>,
    pub info: Option<SongInfo>,
    pub seq: Option<SeqPlayer>,
    /// `slot.voices` when there is no sequencer (with one, `seq.voices`
    /// is the same list).
    voices: Vec<Voice>,
    pub sample_only: bool,
    pub done: bool,
    frame_samples_left: f64,
    frame_sample_carry: f64,
    hpf: (f64, f64),
    /// `slot.reverb`: set by `start` only when the song's reverb byte has
    /// bit 7, otherwise whatever the slot already held.
    pub reverb: Option<f64>,
    pub reverb_state: Reverb,
    pub rate: f64,
}

impl Slot {
    /// `{ voices = {} }` (plus the slot's reverb when the caller carries it).
    pub fn new(rate: f64) -> Slot {
        Slot {
            song_id: None,
            info: None,
            seq: None,
            voices: Vec::new(),
            sample_only: false,
            done: false,
            frame_samples_left: 0.0,
            frame_sample_carry: 0.0,
            hpf: (0.0, 0.0),
            reverb: None,
            reverb_state: Reverb::new(0.0, rate),
            rate,
        }
    }

    /// The slot's live voice list.
    pub fn voices(&self) -> &[Voice] {
        match &self.seq {
            Some(s) => &s.voices,
            None => &self.voices,
        }
    }

    pub fn any_alive(&self) -> bool {
        self.voices().iter().any(|v| v.alive)
    }

    /// Lua: m4a_player.lua:231 `Player.start(pack, cache, slot, songId)`
    /// (the `sampleOnly` option is cries-only and unused by audio.lua).
    pub fn start(&mut self, pack: &AudioPack, song_id: f64) -> bool {
        let rate = self.rate;
        let info = pack.song_info(song_id).copied();
        self.song_id = Some(song_id);
        self.info = info;
        self.seq = None;
        self.voices = Vec::new();
        self.sample_only = false;
        self.done = false;
        self.frame_samples_left = 0.0;
        self.frame_sample_carry = 0.0;
        self.hpf = (0.0, 0.0);
        let reverb = info.and_then(|i| i.reverb).unwrap_or(0.0);
        if reverb >= 128.0 {
            self.reverb = Some(lmod(reverb, 128.0));
        }
        self.reverb_state = Reverb::new(self.reverb.unwrap_or(0.0), rate);

        let song = pack.song_bin(song_id).and_then(seq::parse_song_bin);
        let song = match song {
            Some(s) => s,
            None => {
                if let Some(sid) = info.and_then(|i| i.sample_id) {
                    if let Some(meta) = pack.sample(sid) {
                        if let Some(pcm) = pack.pcm_range(meta) {
                            self.sample_only = true;
                            self.voices.push(mix::new_ds_voice(
                                pcm,
                                meta,
                                DsOpts {
                                    rate: None,
                                    looping: false,
                                    vol_l: Some(0.7),
                                    vol_r: Some(0.7),
                                    tone: None,
                                },
                                rate,
                            ));
                            return true;
                        }
                    }
                }
                return false;
            }
        };
        self.seq = Some(SeqPlayer::new(&song, rate));
        true
    }

    /// Lua: m4a_player.lua:325 `Player.updateSlot(slot, 1)`.
    pub fn update(&mut self, pack: &AudioPack, vblanks: f64) {
        let vblanks = if vblanks < 0.0 { 0.0 } else { vblanks };
        let rate = self.rate;
        let vg_id = self.info.and_then(|i| i.voicegroup_id);
        if let Some(s) = &mut self.seq {
            s.update(vblanks, &Resolver { pack, vg_id, rate });
            if s.all_done() {
                self.done = true;
            }
        } else if !self.voices.iter().any(|v| v.alive) {
            self.done = true;
        }
    }

    /// Lua: m4a_player.lua:358 `Player.renderBuffered(slot, n, {raw = true})`
    /// with master 1: fills `out_l`/`out_r` (same length), interleaving one
    /// MPlayMain/SoundMain step per GBA vblank with the mix.
    pub fn render_buffered(&mut self, pack: &AudioPack, out_l: &mut [f64], out_r: &mut [f64]) {
        let n = out_l.len();
        let rate = self.rate;
        let mut produced = 0usize;
        while produced < n {
            if self.frame_samples_left <= 0.0 {
                self.update(pack, 1.0);
                let exact = rate / mix::GBA_VBLANK_HZ + self.frame_sample_carry;
                self.frame_samples_left = floor(exact);
                self.frame_sample_carry = exact - self.frame_samples_left;
            }
            let chunk = (self.frame_samples_left as usize).min(n - produced);
            let voices = match &mut self.seq {
                Some(s) => &mut s.voices,
                None => &mut self.voices,
            };
            mix::render(
                voices,
                &mut out_l[produced..produced + chunk],
                &mut out_r[produced..produced + chunk],
                pack.samples_bin(),
                rate,
                1.0,
                &mut self.reverb_state,
                &mut self.hpf,
            );
            self.frame_samples_left -= chunk as f64;
            produced += chunk;
        }
    }

    /// Sum of the tracks' `loopCount`s (GOTO-backwards counters).
    fn loop_counts(&self) -> Option<Vec<u32>> {
        self.seq
            .as_ref()
            .map(|s| s.tracks.iter().map(|t| t.loop_count).collect())
    }

    /// Reset the DC blocker and reverb (end of `Player.stopAt`).
    pub fn reset_filters(&mut self) {
        self.hpf = (0.0, 0.0);
        self.reverb_state = Reverb::new(self.reverb.unwrap_or(0.0), self.rate);
    }
}

/// The body of `Player.bakeSlot` (m4a_player.lua:534) — and of
/// `Player.bakeSong` (:475), which is the same loop without the GOTO
/// options — one chunk per [`step`](Self::step).
#[derive(Clone, Debug)]
pub struct Bake {
    pub max_n: usize,
    pub chunk: usize,
    pub total: usize,
    idle: u32,
    stop_on_goto: bool,
    loop_body: bool,
    saw_goto: bool,
    /// `loopStart` (set by the first GOTO in loop-body mode).
    pub loop_start: Option<usize>,
    /// The loop body closed (second GOTO).
    pub closed: bool,
    pub finished: bool,
}

impl Bake {
    /// `bakeSlot(slot, {maxSec, stopOnGoto, loopBody})` at `rate`.
    pub fn slot(rate: f64, max_sec: f64, stop_on_goto: bool, loop_body: bool) -> Bake {
        Bake {
            max_n: floor(rate * max_sec) as usize,
            chunk: mix_quantum(rate),
            total: 0,
            idle: 0,
            stop_on_goto,
            loop_body: stop_on_goto && loop_body,
            saw_goto: false,
            loop_start: None,
            closed: false,
            finished: false,
        }
    }

    /// `bakeSong(pack, cache, songId, {maxSec})` at `rate`.
    pub fn song(rate: f64, max_sec: f64) -> Bake {
        Bake::slot(rate, max_sec, false, false)
    }

    /// The bake's result when it renders nothing (`if #L == 0 then L[1] = 0`).
    pub fn empty_result(&self) -> bool {
        self.finished && self.total == 0
    }

    /// One iteration of the bake loop: renders the next chunk into
    /// `out_l`/`out_r` (resized to the chunk) and returns its length, or 0
    /// when the bake has ended.
    pub fn step(
        &mut self,
        slot: &mut Slot,
        pack: &AudioPack,
        out_l: &mut Vec<f64>,
        out_r: &mut Vec<f64>,
    ) -> usize {
        if self.finished || self.total >= self.max_n {
            self.finished = true;
            return 0;
        }
        let n = self.chunk.min(self.max_n - self.total);
        let pcs = if self.stop_on_goto {
            slot.loop_counts()
        } else {
            None
        };
        out_l.resize(n, 0.0);
        out_r.resize(n, 0.0);
        slot.render_buffered(pack, &mut out_l[..n], &mut out_r[..n]);
        if let (Some(pcs), Some(s)) = (pcs, &slot.seq) {
            for (i, tr) in s.tracks.iter().enumerate() {
                if tr.loop_count > pcs.get(i).copied().unwrap_or(0) {
                    self.saw_goto = true;
                }
            }
        }
        self.total += n;
        if self.loop_body {
            if self.saw_goto {
                self.saw_goto = false;
                if self.loop_start.is_none() {
                    self.loop_start = Some(self.total);
                } else {
                    self.closed = true;
                    self.finished = true;
                    return n;
                }
            }
        } else if self.stop_on_goto && self.saw_goto && self.total > self.chunk {
            self.finished = true;
            return n;
        }
        if slot.done && !slot.any_alive() && !slot.reverb_state.active() {
            self.idle += 1;
            if self.idle >= 2 {
                self.finished = true;
                return n;
            }
        } else {
            self.idle = 0;
        }
        if self.total >= self.max_n {
            self.finished = true;
        }
        n
    }

    /// The `loopStart` bakeSlot returns: only when the loop body closed.
    pub fn result_loop_start(&self) -> Option<usize> {
        if self.closed { self.loop_start } else { None }
    }
}
