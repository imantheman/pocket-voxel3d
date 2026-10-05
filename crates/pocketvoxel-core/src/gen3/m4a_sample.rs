// Port of gen1recomp src/core/game3/m4a_sample.lua (GPLv3 + additional terms; see crates/pocketvoxel-core/src/gen3/LICENSE.md).

//! DirectSound sample helpers (m4a_sample.lua): s8 PCM, the cry modes and
//! `Sample.renderCryMix` as a lazy per-sample generator ([`CryMix`]).
//! `Sample.loadPcm` is [`AudioPack::pcm_range`](super::pack::AudioPack::pcm_range).
//! Not ported: `s8ToSoundData`/`makeSource` (LÖVE Source builders the game3
//! path no longer calls) and `decodeGfdpcm` (the importer decodes DPCM;
//! the cache holds linear s8).

use alloc::vec::Vec;

use super::{ceil, floor, lmod, pow};

/// Lua: m4a_sample.lua:7 (`ffi.cast("const int8_t *")[i] / 128`).
#[inline]
pub fn s8_at(pcm: &[u8], idx: f64) -> f64 {
    let i = floor(idx);
    if i < 0.0 || i >= pcm.len() as f64 {
        return 0.0;
    }
    (pcm[i as usize] as i8) as f64 / 128.0
}

/// Lua: m4a_sample.lua:70
pub const GBA_FRAME_RATE: f64 = 16777216.0 / 280896.0;
/// Lua: m4a_sample.lua:71
pub const CRY_VOLUME: f64 = 120.0;

/// One row of `Sample.CRY_MODES` / the result of `Sample.cryParams`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CryParams {
    pub mode: u32,
    pub length: f64,
    pub release: f64,
    pub pitch: f64,
    pub chorus: f64,
    pub reverse: bool,
    pub volume: f64,
}

/// Lua: m4a_sample.lua:74 `Sample.CRY_MODES` (pokefirered/src/sound.c:374):
/// (length, release, pitch, chorus, reverse, volume or nil).
const CRY_MODES: [(f64, f64, f64, f64, bool, Option<f64>); 13] = [
    (140.0, 0.0, 15360.0, 0.0, false, None),
    (20.0, 225.0, 15360.0, 0.0, false, None),
    (140.0, 225.0, 15600.0, 20.0, false, Some(90.0)),
    (50.0, 200.0, 15800.0, 20.0, false, Some(90.0)),
    (25.0, 100.0, 15600.0, 192.0, true, Some(90.0)),
    (140.0, 200.0, 14440.0, 0.0, false, None),
    (140.0, 220.0, 15555.0, 192.0, false, Some(90.0)),
    (10.0, 100.0, 14848.0, 0.0, false, None),
    (60.0, 225.0, 15616.0, 0.0, false, None),
    (15.0, 125.0, 15200.0, 0.0, true, None),
    (100.0, 225.0, 15200.0, 0.0, false, None),
    (140.0, 0.0, 15000.0, 0.0, false, None),
    (20.0, 225.0, 15000.0, 0.0, false, None),
];

impl CryParams {
    /// Lua: m4a_sample.lua:90 `Sample.cryParams(mode, volume)` without the
    /// profile's per-mode overrides (a caller with overrides edits the
    /// returned fields, which is what `pick` does).
    pub fn from_mode(mode: i32, volume: Option<f64>) -> CryParams {
        let mode = if mode >= 0 && (mode as usize) < CRY_MODES.len() {
            mode as usize
        } else {
            0
        };
        let m = CRY_MODES[mode];
        CryParams {
            mode: mode as u32,
            length: m.0,
            release: m.1,
            pitch: m.2,
            chorus: m.3,
            reverse: m.4,
            volume: m.5.or(volume).unwrap_or(CRY_VOLUME),
        }
    }
}

/// Lua: m4a_sample.lua:112 `Sample.cryKeyTune` → (key, tune).
pub fn cry_key_tune(pitch: f64) -> (f64, f64) {
    let mut b = pitch + 128.0;
    b = lmod(b, 65536.0);
    if b >= 32768.0 {
        b -= 65536.0;
    }
    let key = lmod(floor(b / 256.0), 128.0);
    let tune = lmod(floor(b / 2.0), 128.0);
    (key, tune)
}

/// Lua: m4a_sample.lua:122 `Sample.cryChorusTune`.
pub fn cry_chorus_tune(chorus: f64, tune: f64) -> f64 {
    let mut chorus = lmod(chorus, 256.0);
    if chorus >= 128.0 {
        chorus -= 256.0;
    }
    lmod(chorus + tune, 128.0)
}

/// Lua: m4a_sample.lua:128 `Sample.cryRateMul`.
pub fn cry_rate_mul(key: f64, tune: f64) -> f64 {
    pow(2.0, ((key - 60.0) * 64.0 + (tune - 64.0)) / (64.0 * 12.0))
}

/// Lua: m4a_sample.lua:143 `Sample.cryEnvelope` (length, tail gains).
pub fn cry_envelope(length: f64, release: f64) -> (f64, Vec<f64>) {
    let length = 0.0f64.max(floor(length));
    let release = 0.0f64.max(floor(release));
    let mut tail = Vec::new();
    let mut env = 255.0;
    loop {
        env = floor(env * release / 256.0);
        if env <= 0.0 {
            break;
        }
        tail.push(env / 255.0);
    }
    (length, tail)
}

#[derive(Clone, Copy, Debug)]
struct CryVoice {
    step: f64,
    out_n: f64,
}

/// `Sample.renderCryMix(pcm, sampleRate, params, {outRate})` evaluated one
/// sample at a time: [`sample`](Self::sample)`(i)` is the Lua's `out[i + 1]`.
#[derive(Clone, Debug)]
pub struct CryMix {
    /// The cry's PCM as its range in samples.bin.
    pub pcm: (usize, usize),
    length: f64,
    tail: Vec<f64>,
    voices: [CryVoice; 2],
    nvoices: usize,
    gain: f64,
    reverse: bool,
    out_rate: f64,
    /// `#out`.
    pub n_out: usize,
    /// `info.frames` (the cry's length in GBA frames, for isCryFinished).
    pub frames: f64,
}

impl CryMix {
    /// Lua: m4a_sample.lua:164 `Sample.renderCryMix` (setup half). `None`
    /// when the Lua returns nil (empty PCM).
    pub fn new(
        pcm: (usize, usize),
        sample_rate: f64,
        params: &CryParams,
        out_rate: f64,
    ) -> Option<CryMix> {
        if pcm.1 == 0 {
            return None;
        }
        let n_in = pcm.1 as f64;
        let (length, tail) = cry_envelope(params.length, params.release);
        let end_frame = length + tail.len() as f64;
        let (key, tune) = cry_key_tune(params.pitch);
        let mut voices = [CryVoice {
            step: 0.0,
            out_n: 0.0,
        }; 2];
        let mut muls = [cry_rate_mul(key, tune), 0.0];
        let mut nvoices = 1;
        if lmod(params.chorus, 256.0) != 0.0 {
            let tune2 = cry_chorus_tune(params.chorus, tune);
            muls[1] = cry_rate_mul(key, tune2);
            nvoices = 2;
        }
        let frame_rate = GBA_FRAME_RATE;
        let env_samples = ceil(end_frame * out_rate / frame_rate);
        let mut n_out = 0.0;
        let mut v1_samples = 0.0;
        for i in 0..nvoices {
            let step = sample_rate * muls[i] / out_rate;
            let samples = ceil(n_in / step);
            let out_n = samples.min(env_samples);
            if out_n > n_out {
                n_out = out_n;
            }
            if i == 0 {
                v1_samples = samples;
            }
            voices[i] = CryVoice { step, out_n };
        }
        let gain = params.volume / 127.0;
        let sample_frames = v1_samples * frame_rate / out_rate;
        let frames = end_frame.min(ceil(sample_frames));
        Some(CryMix {
            pcm,
            length,
            tail,
            voices,
            nvoices,
            gain,
            reverse: params.reverse,
            out_rate,
            n_out: n_out as usize,
            frames,
        })
    }

    /// `env.gain(frame)` (m4a_sample.lua:157).
    #[inline]
    fn env_gain(&self, frame: f64) -> f64 {
        if frame < self.length {
            return 1.0;
        }
        let k = frame - self.length; // tail[frame - length + 1], 1-based
        self.tail.get(k as usize).copied().unwrap_or(0.0)
    }

    /// Lua: m4a_sample.lua:184-199 — output sample `i` (0-based).
    #[inline]
    pub fn sample(&self, samples_bin: &[u8], i: usize) -> f64 {
        let pcm = &samples_bin[self.pcm.0..self.pcm.0 + self.pcm.1];
        let n_in = self.pcm.1 as f64;
        let fi = i as f64;
        let g = self.env_gain(floor(fi * GBA_FRAME_RATE / self.out_rate)) * self.gain;
        let mut acc = 0.0;
        if g > 0.0 {
            for v in &self.voices[..self.nvoices] {
                if fi < v.out_n {
                    let mut idx = floor(fi * v.step);
                    if self.reverse {
                        idx = n_in - 1.0 - idx;
                    }
                    acc += s8_at(pcm, idx);
                }
            }
            acc *= g;
            if acc > 1.0 {
                acc = 1.0;
            } else if acc < -1.0 {
                acc = -1.0;
            }
        }
        acc
    }
}
