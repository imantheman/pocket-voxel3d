// Port of gen1recomp src/core/game3/m4a_seq.lua (GPLv3 + additional terms; see crates/pocketvoxel-core/src/gen3/LICENSE.md).

//! MP2K/M4A track bytecode interpreter (m4a_seq.lua). GOTO is a native
//! loop; the sequencer advances in GBA VBlank units (MPlayMain).
//! `Seq.snapshot`/`Seq.restore` are not ported: they serve the worker's
//! rewind-to-heard-position, which a pull-model host does not need (see
//! `engine::M4a::pause_song`).

use alloc::vec::Vec;

use super::m4a_mix::{self as mix, MAX_DS_CHANNELS, Voice, VoiceKind};
use super::{floor, lmod};

/// Lua: m4a_seq.lua:9 pret gClockTable (0-based).
const CLOCK: [f64; 49] = [
    0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0, 11.0, 12.0, 13.0, 14.0, 15.0, 16.0,
    17.0, 18.0, 19.0, 20.0, 21.0, 22.0, 23.0, 24.0, 28.0, 30.0, 32.0, 36.0, 40.0, 42.0, 44.0, 48.0,
    52.0, 54.0, 56.0, 60.0, 64.0, 66.0, 68.0, 72.0, 76.0, 78.0, 80.0, 84.0, 88.0, 90.0, 92.0, 96.0,
];

/// Lua: m4a_seq.lua:16
fn clock_at(idx: i32) -> f64 {
    let idx = if idx < 0 { 0 } else { idx };
    CLOCK.get(idx as usize).copied().unwrap_or(idx as f64)
}

fn u8_at(blob: &[u8], off: usize) -> Option<u32> {
    blob.get(off).map(|b| *b as u32)
}

/// Lua: m4a_seq.lua:27 (`nil` when the first byte is out of range).
fn u32le(blob: &[u8], off: usize) -> Option<f64> {
    let b0 = u8_at(blob, off)? as f64;
    Some(
        b0 + u8_at(blob, off + 1).unwrap_or(0) as f64 * 256.0
            + u8_at(blob, off + 2).unwrap_or(0) as f64 * 65536.0
            + u8_at(blob, off + 3).unwrap_or(0) as f64 * 16777216.0,
    )
}

/// `Seq.parseSongBin` result.
#[derive(Clone, Debug, Default)]
pub struct Song {
    pub tracks: usize,
    pub blocks: Option<f64>,
    pub priority: Option<f64>,
    pub reverb: Option<f64>,
    pub voicegroup: Option<f64>,
    pub track_data: Vec<Vec<u8>>,
    pub track_entries: Vec<Option<f64>>,
}

/// Lua: m4a_seq.lua:35 `Seq.parseSongBin`.
pub fn parse_song_bin(blob: &[u8]) -> Option<Song> {
    if blob.len() < 8 {
        return None;
    }
    let mut tracks = u8_at(blob, 0).unwrap_or(0) as usize;
    if tracks > 16 {
        tracks = 0;
    }
    let mut out = Song {
        tracks,
        blocks: u8_at(blob, 1).map(|v| v as f64),
        priority: u8_at(blob, 2).map(|v| v as f64),
        reverb: u8_at(blob, 3).map(|v| v as f64),
        voicegroup: u32le(blob, 4),
        track_data: Vec::new(),
        track_entries: Vec::new(),
    };
    if tracks == 0 {
        return Some(out);
    }
    let len = blob.len() as f64;
    let first = u32le(blob, 8).unwrap_or(0.0);
    let packed = first > 0.0 && first < len && first < 16777216.0;

    if packed {
        let stride = if out.blocks.unwrap_or(0.0) >= 128.0 {
            12
        } else {
            8
        };
        out.blocks = Some(lmod(out.blocks.unwrap_or(0.0), 128.0));
        for t in 0..tracks {
            let base = 8 + t * stride;
            let off = u32le(blob, base).unwrap_or(0.0);
            let l = u32le(blob, base + 4).unwrap_or(0.0);
            if off > 0.0 && l > 0.0 && off + l <= len {
                out.track_data
                    .push(blob[off as usize..(off + l) as usize].to_vec());
                out.track_entries.push(Some(if stride == 12 {
                    u32le(blob, base + 8).unwrap_or(0.0)
                } else {
                    0.0
                }));
            } else {
                out.track_data.push(Vec::new());
                out.track_entries.push(None);
            }
        }
        return Some(out);
    }

    let header_size = 8 + tracks * 4;
    let mut ptrs: Vec<(usize, f64)> = (0..tracks)
        .map(|t| (t, u32le(blob, 8 + t * 4).unwrap_or(0.0)))
        .collect();
    // table.sort is not stable; equal pointers keep an unspecified order in
    // the Lua. NOT FAITHFUL only if two tracks share a pointer (never in the
    // cache: every song bin is packed).
    ptrs.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(core::cmp::Ordering::Equal));
    let mut cursor = header_size as f64;
    let mut packed_off: Vec<Option<(f64, f64)>> = alloc::vec![None; tracks];
    let n = ptrs.len();
    for i in 0..n {
        let p = ptrs[i];
        let remain_tracks = (n - i) as f64;
        let remain_bytes = len - cursor;
        let mut approx = floor(remain_bytes / remain_tracks);
        if i + 1 < n && p.1 > 0.0 && ptrs[i + 1].1 > p.1 {
            approx = approx.min(ptrs[i + 1].1 - p.1);
        }
        approx = 16.0f64.max(approx.min(remain_bytes));
        packed_off[p.0] = Some((cursor, approx));
        cursor += approx;
    }
    for t in 0..tracks {
        match packed_off[t] {
            // blob:sub(off + 1, off + len), clamped like string.sub
            Some((o, l)) => {
                let s = (o as usize).min(blob.len());
                let e = ((o + l) as usize).min(blob.len()).max(s);
                out.track_data.push(blob[s..e].to_vec());
            }
            None => out.track_data.push(Vec::new()),
        }
        out.track_entries.push(None);
    }
    Some(out)
}

/// `tr.toneOverrides` (XCMD fields).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ToneOverrides {
    pub typ: Option<f64>,
    pub attack: Option<f64>,
    pub decay: Option<f64>,
    pub sustain: Option<f64>,
    pub release: Option<f64>,
    pub length: Option<f64>,
    pub pan: Option<f64>,
}

/// A track table (m4a_seq.lua:100 `new_track`).
#[derive(Clone, Debug)]
pub struct Track {
    pub data: Vec<u8>,
    pub pc: usize,
    pub wait: f64,
    pub done: bool,
    pub key: f64,
    pub vel: f64,
    pub voice: f64,
    pub volume: f64,
    pub pan: f64,
    pub bend: f64,
    pub bend_range: f64,
    pub tune: f64,
    pub key_shift: f64,
    pub lfo_speed: f64,
    pub lfo_delay: f64,
    pub lfo_delay_c: f64,
    pub lfo_speed_c: f64,
    pub mod_: f64,
    pub mod_t: f64,
    pub mod_m: f64,
    pub call_stack: Vec<usize>,
    pub running_status: Option<u8>,
    /// 1-based, as `tr.index`.
    pub index: usize,
    pub priority: f64,
    pub tone_overrides: Option<ToneOverrides>,
    pub pseudo_echo_volume: f64,
    pub pseudo_echo_length: f64,
    pub sample_start: Option<f64>,
    pub loop_count: u32,
    pub rep_n: f64,
    pub pitch_dirty: bool,
    pub vol_dirty: bool,
}

impl Track {
    fn new(data: Vec<u8>) -> Track {
        Track {
            data,
            pc: 0,
            wait: 0.0,
            done: false,
            key: 60.0,
            vel: 127.0,
            voice: 0.0,
            volume: 100.0,
            pan: 64.0,
            bend: 0.0,
            bend_range: 2.0,
            tune: 0.0,
            key_shift: 0.0,
            lfo_speed: 22.0,
            lfo_delay: 0.0,
            lfo_delay_c: 0.0,
            lfo_speed_c: 0.0,
            mod_: 0.0,
            mod_t: 0.0,
            mod_m: 0.0,
            call_stack: Vec::new(),
            running_status: None,
            index: 0,
            priority: 0.0,
            tone_overrides: None,
            pseudo_echo_volume: 0.0,
            pseudo_echo_length: 0.0,
            sample_start: None,
            loop_count: 0,
            rep_n: 0.0,
            pitch_dirty: false,
            vol_dirty: false,
        }
    }

    /// Lua: m4a_seq.lua:183
    fn read(&mut self) -> Option<u8> {
        if self.pc >= self.data.len() {
            self.done = true;
            return None;
        }
        let b = self.data[self.pc];
        self.pc += 1;
        Some(b)
    }

    /// Lua: m4a_seq.lua:193
    fn unread(&mut self) {
        if self.pc > 0 {
            self.pc -= 1;
        }
    }

    /// Lua: m4a_seq.lua:197
    fn read32(&mut self) -> f64 {
        let b0 = self.read().unwrap_or(0) as f64;
        let b1 = self.read().unwrap_or(0) as f64;
        let b2 = self.read().unwrap_or(0) as f64;
        let b3 = self.read().unwrap_or(0) as f64;
        b0 + b1 * 256.0 + b2 * 65536.0 + b3 * 16777216.0
    }

    fn len(&self) -> f64 {
        self.data.len() as f64
    }
}

/// Lua: m4a_seq.lua:129 `Seq.trackPitch` → (keyM, fine).
pub fn track_pitch(tr: &Track) -> (f64, f64) {
    let bend = tr.bend * tr.bend_range;
    let mut x = (tr.tune + bend) * 4.0 + (tr.key_shift * 256.0);
    if tr.mod_t == 0.0 && tr.mod_ > 0.0 {
        x += 16.0 * tr.mod_m;
    }
    (floor(x / 256.0), lmod(x, 256.0))
}

/// Lua: m4a_seq.lua:142 `Seq.trackVolume` → (l, r) gains.
pub fn track_volume(tr: &Track, vel: f64, rhythm_pan: f64) -> (f64, f64) {
    let mut x = floor(tr.volume * 64.0 / 32.0);
    if tr.mod_t == 1.0 {
        x = floor(x * (tr.mod_m + 128.0) / 128.0);
    }
    let mut pan = 2.0 * (tr.pan - 64.0);
    if tr.mod_t == 2.0 {
        pan += tr.mod_m;
    }
    pan = (-128.0f64).max(127.0f64.min(pan));
    let ml = lmod(floor((127.0 - pan) * x / 256.0), 256.0);
    let mr = lmod(floor((128.0 + pan) * x / 256.0), 256.0);
    let rp = rhythm_pan;
    let l = 255.0f64.min(floor((127.0 - rp) * vel * ml / 16384.0));
    let r = 255.0f64.min(floor((128.0 + rp) * vel * mr / 16384.0));
    (l / 256.0, r / 256.0)
}

/// The `voiceResolver` callback `Player.start` installs (m4a_player.lua:281).
pub trait VoiceResolver {
    #[allow(clippy::too_many_arguments)]
    fn resolve(
        &self,
        voice_id: f64,
        raw_key: f64,
        vel: f64,
        tr: &Track,
        vol_l: f64,
        vol_r: f64,
        fine: f64,
        abs_key: f64,
    ) -> Option<Voice>;
}

/// A sequencer player (m4a_seq.lua:161 `Seq.newPlayer`).
#[derive(Clone, Debug)]
pub struct SeqPlayer {
    pub song_priority: f64,
    pub tracks: Vec<Track>,
    pub tempo: f64,
    pub tempo_c: f64,
    pub frame_c: f64,
    pub c15: f64,
    pub voices: Vec<Voice>,
    pub muted: bool,
    mem: [f64; 256],
    /// `Mix.SAMPLE_RATE`.
    pub rate: f64,
}

impl SeqPlayer {
    /// Lua: m4a_seq.lua:161
    pub fn new(song: &Song, rate: f64) -> SeqPlayer {
        let mut tracks = Vec::with_capacity(song.tracks);
        for i in 0..song.tracks {
            let mut tr = Track::new(song.track_data.get(i).cloned().unwrap_or_default());
            tr.pc = song.track_entries.get(i).copied().flatten().unwrap_or(0.0) as usize;
            tr.index = i + 1;
            tracks.push(tr);
        }
        SeqPlayer {
            song_priority: song.priority.unwrap_or(0.0),
            tracks,
            tempo: 150.0,
            tempo_c: 0.0,
            frame_c: 0.0,
            c15: 0.0,
            voices: Vec::new(),
            muted: false,
            mem: [0.0; 256],
            rate,
        }
    }

    /// Lua: m4a_seq.lua:208 `refresh_track_voices`.
    fn refresh_track_voices(&mut self, ti: usize) {
        let rate = self.rate;
        let tr = &mut self.tracks[ti];
        let (key_m, fine) = track_pitch(tr);
        for v in self.voices.iter_mut() {
            if v.track == Some(ti) && v.alive {
                if tr.vol_dirty {
                    let nvel = v.note_vel.unwrap_or(tr.vel);
                    let (l, r) = track_volume(tr, nvel, v.rhythm_pan.unwrap_or(0.0));
                    v.vol_l = l;
                    v.vol_r = r;
                }
                if tr.pitch_dirty && !v.fixed_freq {
                    let note_key = v.note_key.unwrap_or(60.0);
                    let mut abs_key = note_key + key_m;
                    if abs_key < 0.0 {
                        abs_key = 0.0;
                    }
                    if abs_key > 178.0 {
                        abs_key = 178.0;
                    }
                    match v.kind {
                        VoiceKind::Ds => {
                            if let Some(wf) = v.wav_freq {
                                let r = mix::midi_key_to_freq(wf, abs_key, fine);
                                v.step = r / rate;
                            }
                        }
                        VoiceKind::CgbPulse => {
                            let period = mix::cgb_period(abs_key, fine, v.cgb_fixed);
                            v.period_reg = period;
                            if !v.sweep_enabled {
                                v.freq = mix::period_to_pulse_hz(period);
                            }
                        }
                        VoiceKind::CgbWave => v.freq = mix::cgb_wave_hz(abs_key, fine, v.cgb_fixed),
                        VoiceKind::CgbNoise => v.period = mix::cgb_noise_period(abs_key, rate),
                    }
                }
            }
        }
        tr.pitch_dirty = false;
        tr.vol_dirty = false;
    }

    /// Lua: m4a_seq.lua:245 `start_note`.
    fn start_note(&mut self, ti: usize, key: f64, vel: f64, gate: f64, res: &dyn VoiceResolver) {
        let song_priority = self.song_priority;
        let tr = &mut self.tracks[ti];
        if tr.lfo_delay > 0.0 {
            tr.lfo_delay_c = tr.lfo_delay;
            tr.mod_m = 0.0;
            tr.pitch_dirty = true;
            tr.vol_dirty = true;
        }
        let (vol_l, vol_r) = track_volume(tr, vel, 0.0);
        let raw_key = key;
        let (key_m, fine) = track_pitch(tr);
        let mut abs_key = raw_key + key_m;
        if abs_key < 0.0 {
            abs_key = 0.0;
        }
        if abs_key > 178.0 {
            abs_key = 178.0;
        }
        let tr = &self.tracks[ti];
        let mut voice = match res.resolve(tr.voice, raw_key, vel, tr, vol_l, vol_r, fine, abs_key) {
            Some(v) => v,
            None => return,
        };
        voice.gate_ticks = if gate > 0.0 { Some(gate) } else { None };
        voice.track = Some(ti);
        if voice.note_key.is_none() {
            voice.note_key = Some(raw_key);
        }
        voice.note_vel = Some(vel);
        voice.midi_key = Some(raw_key);
        let new_prio = 255.0f64.min(song_priority + tr.priority);
        voice.priority = Some(new_prio);
        let tr_index = tr.index;

        if let Some(chan) = voice.cgb_chan {
            // pret MP2K (m4a_1.s lines 1648-1668): exactly one voice per CGB channel.
            let tracks = &self.tracks;
            if let Some(active) = self
                .voices
                .iter_mut()
                .find(|v| v.alive && v.cgb_chan == Some(chan))
            {
                let old_prio = active.priority.unwrap_or(0.0);
                if active.released || new_prio > old_prio {
                    active.alive = false;
                } else if new_prio < old_prio {
                    return;
                } else {
                    let old_idx = active.track.map_or(999, |t| tracks[t].index);
                    if tr_index <= old_idx {
                        active.alive = false;
                    } else {
                        return;
                    }
                }
            }
        } else if voice.kind == VoiceKind::Ds {
            // ply_note prefers a released voice, then the lowest priority and
            // latest track. A lower-priority note cannot evict a higher one.
            let tracks = &self.tracks;
            let tix = |v: &Voice| v.track.map_or(0, |t| tracks[t].index);
            let mut count = 0usize;
            let mut victim: Option<usize> = None;
            for (vi, v) in self.voices.iter().enumerate() {
                if v.alive && v.kind == VoiceKind::Ds {
                    count += 1;
                    let vp = v.priority.unwrap_or(0.0);
                    let eligible =
                        v.released || vp < new_prio || (vp == new_prio && tix(v) >= tr_index);
                    if eligible {
                        let take = match victim {
                            None => true,
                            Some(b) => {
                                let bv = &self.voices[b];
                                let bp = bv.priority.unwrap_or(0.0);
                                (v.released && !bv.released)
                                    || (v.released == bv.released
                                        && (vp < bp || (vp == bp && tix(v) >= tix(bv))))
                            }
                        };
                        if take {
                            victim = Some(vi);
                        }
                    }
                }
            }
            if count >= MAX_DS_CHANNELS {
                match victim {
                    None => return,
                    Some(b) => self.voices[b].alive = false,
                }
            }
        }
        self.voices.push(voice);
    }

    /// Lua: m4a_seq.lua:338 `ply_note`.
    fn ply_note(&mut self, ti: usize, cmd: u8, res: &dyn VoiceResolver) {
        let mut gate = clock_at(cmd as i32 - 0xCF);
        let tr = &mut self.tracks[ti];
        let key = match tr.read() {
            Some(k) => k,
            None => return,
        };
        if key >= 0x80 {
            tr.unread();
        } else {
            tr.key = key as f64;
            let vel = match tr.read() {
                Some(v) => v,
                None => {
                    let v = tr.vel;
                    self.start_note(ti, key as f64, v, gate, res);
                    return;
                }
            };
            if vel >= 0x80 {
                tr.unread();
            } else {
                tr.vel = vel as f64;
                let add = match tr.read() {
                    Some(a) => a,
                    None => {
                        self.start_note(ti, key as f64, vel as f64, gate, res);
                        return;
                    }
                };
                if add >= 0x80 {
                    tr.unread();
                } else {
                    gate += add as f64;
                }
            }
        }
        let tr = &self.tracks[ti];
        let (k, v) = (tr.key, tr.vel);
        self.start_note(ti, k, v, gate, res);
    }

    fn release_track_voices(&mut self, ti: usize) {
        for v in self.voices.iter_mut() {
            if v.track == Some(ti) {
                mix::release_voice(v);
            }
        }
    }

    /// Lua: m4a_seq.lua:371 `exec_cmd`.
    fn exec_cmd(&mut self, ti: usize, cmd: u8, res: &dyn VoiceResolver) {
        let tr = &mut self.tracks[ti];
        match cmd {
            0xB1 => {
                tr.done = true;
                self.release_track_voices(ti);
            }
            0xB2 => {
                let addr = tr.read32();
                if addr < tr.len() {
                    if addr < tr.pc as f64 {
                        tr.loop_count += 1;
                    }
                    tr.pc = addr as usize;
                } else {
                    self.exec_cmd(ti, 0xB1, res);
                }
            }
            0xB3 => {
                let addr = tr.read32();
                if addr < tr.len() && tr.call_stack.len() < 3 {
                    tr.call_stack.push(tr.pc);
                    tr.pc = addr as usize;
                } else {
                    self.exec_cmd(ti, 0xB1, res);
                }
            }
            0xB4 => {
                if let Some(pc) = tr.call_stack.pop() {
                    tr.pc = pc;
                }
            }
            0xB5 => {
                let count = tr.read().unwrap_or(0) as f64;
                let addr = tr.read32();
                tr.rep_n += 1.0;
                if count == 0.0 || tr.rep_n < count {
                    if addr < tr.len() {
                        tr.pc = addr as usize;
                    }
                } else {
                    tr.rep_n = 0.0;
                }
            }
            0xBA => tr.priority = tr.read().unwrap_or(0) as f64,
            0xBB => {
                let t = tr.read().map_or(75.0, |v| v as f64);
                self.tempo = t * 2.0;
            }
            0xBC => {
                let mut ks = tr.read().unwrap_or(0) as f64;
                if ks > 127.0 {
                    ks -= 256.0;
                }
                tr.key_shift = ks;
                tr.pitch_dirty = true;
            }
            0xBD => {
                tr.voice = tr.read().unwrap_or(0) as f64;
                tr.tone_overrides = None;
            }
            0xBE => {
                tr.volume = tr.read().map_or(100.0, |v| v as f64);
                tr.vol_dirty = true;
            }
            0xBF => {
                tr.pan = tr.read().map_or(64.0, |v| v as f64);
                tr.vol_dirty = true;
            }
            0xC0 => {
                tr.bend = tr.read().map_or(64.0, |v| v as f64) - 64.0;
                tr.pitch_dirty = true;
            }
            0xC1 => {
                tr.bend_range = tr.read().map_or(2.0, |v| v as f64);
                tr.pitch_dirty = true;
            }
            0xC2 => {
                tr.lfo_speed = tr.read().map_or(22.0, |v| v as f64);
                if tr.lfo_speed == 0.0 && tr.mod_m != 0.0 {
                    tr.mod_m = 0.0;
                    if tr.mod_t == 0.0 {
                        tr.pitch_dirty = true;
                    } else {
                        tr.vol_dirty = true;
                    }
                }
            }
            0xC3 => {
                tr.lfo_delay = tr.read().unwrap_or(0) as f64;
                tr.lfo_delay_c = tr.lfo_delay;
            }
            0xC4 => {
                tr.mod_ = tr.read().unwrap_or(0) as f64;
                if tr.mod_ == 0.0 && tr.mod_m != 0.0 {
                    tr.mod_m = 0.0;
                    if tr.mod_t == 0.0 {
                        tr.pitch_dirty = true;
                    } else {
                        tr.vol_dirty = true;
                    }
                }
            }
            0xC5 => {
                let old_t = tr.mod_t;
                tr.mod_t = tr.read().unwrap_or(0) as f64;
                if old_t != tr.mod_t {
                    tr.pitch_dirty = true;
                    tr.vol_dirty = true;
                }
            }
            0xC8 => {
                // TUNE: signed around 0x40 (C_V)
                tr.tune = tr.read().map_or(64.0, |v| v as f64) - 64.0;
                tr.pitch_dirty = true;
            }
            0xCD => {
                let xop = tr.read().unwrap_or(0);
                match xop {
                    2 | 4 | 5 | 6 | 7 | 10 | 11 => {
                        let v = Some(tr.read().unwrap_or(0) as f64);
                        let o = tr.tone_overrides.get_or_insert_with(ToneOverrides::default);
                        match xop {
                            2 => o.typ = v,
                            4 => o.attack = v,
                            5 => o.decay = v,
                            6 => o.sustain = v,
                            7 => o.release = v,
                            10 => o.length = v,
                            _ => o.pan = v,
                        }
                    }
                    8 => tr.pseudo_echo_volume = tr.read().unwrap_or(0) as f64,
                    9 => tr.pseudo_echo_length = tr.read().unwrap_or(0) as f64,
                    12 => {
                        let low = tr.read().unwrap_or(0) as f64;
                        let high = tr.read().unwrap_or(0) as f64;
                        tr.wait = low + high * 256.0;
                    }
                    13 => tr.sample_start = Some(tr.read32()),
                    1 => {
                        // Raw ROM pointer is not represented by the existing sample cache.
                        tr.read32();
                    }
                    _ => self.exec_cmd(ti, 0xB1, res),
                }
            }
            0xCE => {
                let key = match tr.data.get(tr.pc) {
                    Some(&k) if k < 0x80 => {
                        tr.pc += 1;
                        tr.key = k as f64;
                        k as f64
                    }
                    _ => tr.key,
                };
                // ply_endtie releases the newest matching MIDI key, not the whole track.
                for v in self.voices.iter_mut().rev() {
                    if v.track == Some(ti) && v.midi_key == Some(key) && v.alive && !v.released {
                        mix::release_voice(v);
                        break;
                    }
                }
            }
            0xCF..=0xFF => self.ply_note(ti, cmd, res),
            0x80..=0xB0 => tr.wait = clock_at(cmd as i32 - 0x80),
            0xCC => {
                // PORT register offset and value
                tr.read();
                tr.read();
            }
            0xB9 => {
                let op = tr.read().unwrap_or(0) as i32;
                let addr = tr.read().unwrap_or(0) as usize;
                let data = tr.read().unwrap_or(0) as usize;
                let mut value = self.mem[addr];
                let operand_from_mem = (op >= 3 && op <= 5) || op >= 12;
                let operand = if operand_from_mem {
                    self.mem[data]
                } else {
                    data as f64
                };
                if op <= 5 {
                    let action = op % 3;
                    if action == 0 {
                        value = operand;
                    } else if action == 1 {
                        value += operand;
                    } else {
                        value -= operand;
                    }
                    self.mem[addr] = lmod(value, 256.0);
                } else if op <= 17 {
                    let target = tr.read32();
                    let cond = (op - 6) % 6;
                    let take = (cond == 0 && value == operand)
                        || (cond == 1 && value != operand)
                        || (cond == 2 && value > operand)
                        || (cond == 3 && value >= operand)
                        || (cond == 4 && value <= operand)
                        || (cond == 5 && value < operand);
                    if take && target < tr.len() {
                        tr.pc = target as usize;
                    }
                }
            }
            _ => self.exec_cmd(ti, 0xB1, res),
        }
    }

    /// Lua: m4a_seq.lua:527 `tick_track`.
    fn tick_track(&mut self, ti: usize, res: &dyn VoiceResolver) {
        {
            let tr = &mut self.tracks[ti];
            if tr.done {
                return;
            }
            if tr.wait > 0.0 {
                tr.wait -= 1.0;
                return;
            }
        }
        let mut guard = 0;
        loop {
            let tr = &mut self.tracks[ti];
            if !(!tr.done && tr.wait <= 0.0 && guard < 64) {
                break;
            }
            guard += 1;
            if tr.pc >= tr.data.len() {
                tr.done = true;
                break;
            }
            let b = tr.data[tr.pc];
            let cmd;
            if b < 0x80 {
                // Running status: data byte stays for the command handler.
                match tr.running_status {
                    Some(rs) if rs >= 0x80 => cmd = rs,
                    _ => {
                        // No status yet — skip orphan data byte.
                        tr.pc += 1;
                        break;
                    }
                }
            } else {
                tr.pc += 1;
                cmd = b;
                // pret: only cmds >= 0xBD update runningStatus
                if cmd >= 0xBD {
                    tr.running_status = Some(cmd);
                }
            }
            self.exec_cmd(ti, cmd, res);
            if self.tracks[ti].pitch_dirty || self.tracks[ti].vol_dirty {
                self.refresh_track_voices(ti);
            }
            let tr = &mut self.tracks[ti];
            if tr.wait > 0.0 {
                tr.wait -= 1.0;
                break;
            }
        }
    }

    /// Lua: m4a_seq.lua:569 `seq_tick`.
    fn seq_tick(&mut self, res: &dyn VoiceResolver) {
        // MPlayMain ages each track's gates immediately before its commands.
        for ti in 0..self.tracks.len() {
            for v in self.voices.iter_mut() {
                if v.track == Some(ti) {
                    if let Some(g) = v.gate_ticks {
                        v.gate_ticks = Some(g - 1.0);
                        if g - 1.0 <= 0.0 {
                            mix::release_voice(v);
                        }
                    }
                }
            }
            self.tick_track(ti, res);
        }

        // Tick LFO modulation per active track
        for tr in self.tracks.iter_mut() {
            if !tr.done && tr.lfo_speed > 0.0 && tr.mod_ > 0.0 {
                if tr.lfo_delay_c > 0.0 {
                    tr.lfo_delay_c -= 1.0;
                } else {
                    tr.lfo_speed_c = lmod(tr.lfo_speed_c + tr.lfo_speed, 256.0);
                    let phase = tr.lfo_speed_c;
                    let tri = if phase < 64.0 {
                        phase
                    } else if phase < 192.0 {
                        128.0 - phase
                    } else {
                        phase - 256.0
                    };
                    let new_mod_m = floor((tr.mod_ * tri) / 64.0);
                    if new_mod_m != tr.mod_m {
                        tr.mod_m = new_mod_m;
                        if tr.mod_t == 0.0 {
                            tr.pitch_dirty = true;
                        } else {
                            tr.vol_dirty = true;
                        }
                    }
                }
            }
        }

        for ti in 0..self.tracks.len() {
            if self.tracks[ti].pitch_dirty || self.tracks[ti].vol_dirty {
                self.refresh_track_voices(ti);
            }
        }
    }

    /// Lua: m4a_seq.lua:619 `Seq.update` — whole SoundMain frames; leaves
    /// only live voices in `self.voices`.
    pub fn update(&mut self, vblanks: f64, res: &dyn VoiceResolver) {
        if self.muted || vblanks <= 0.0 {
            return;
        }
        self.frame_c += vblanks;
        while self.frame_c >= 1.0 {
            self.frame_c -= 1.0;
            self.tempo_c += self.tempo;
            while self.tempo_c >= 150.0 {
                self.tempo_c -= 150.0;
                self.seq_tick(res);
            }
            self.c15 = if self.c15 == 0.0 {
                14.0
            } else {
                self.c15 - 1.0
            };
            let extra = self.c15 == 0.0;
            for v in self.voices.iter_mut() {
                mix::tick_envelope(v, extra);
            }
        }
        self.voices.retain(|v| v.alive);
    }

    /// Lua: m4a_seq.lua:698 `Seq.allDone`.
    pub fn all_done(&self) -> bool {
        self.tracks.iter().all(|t| t.done) && self.voices.is_empty()
    }
}
