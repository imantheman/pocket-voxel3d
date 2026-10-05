// Port of gen1recomp src/core/game3/m4a_mix.lua (GPLv3 + additional terms; see crates/pocketvoxel-core/src/gen3/LICENSE.md).

//! DirectSound + lightweight CGB mix (m4a_mix.lua). Voices are the Lua's
//! voice tables as one struct; the sample rate the Lua keeps in the global
//! `Mix.SAMPLE_RATE` is passed in (`rate`).

use alloc::vec;
use alloc::vec::Vec;

use super::pack::{SampleMeta, Tone};
use super::{ceil, exp, floor, lmod, pow2i};

// Lua: m4a_mix.lua:7-11
pub const GBA_CLOCK: f64 = 16777216.0;
pub const GBA_FRAME_CYCLES: f64 = 280896.0;
pub const GBA_SAMPLES_PER_VBLANK: f64 = 224.0;
pub const GBA_VBLANK_HZ: f64 = GBA_CLOCK / GBA_FRAME_CYCLES;
pub const GBA_MIX_RATE: f64 = GBA_VBLANK_HZ * GBA_SAMPLES_PER_VBLANK;

/// ChipSynth.SAMPLE_RATE default (ChipSynth.lua:21-25).
pub const DEFAULT_SAMPLE_RATE: f64 = 44100.0;

/// Lua: m4a_mix.lua:31 `Mix.setSampleRate` — invalid rates keep `current`.
pub fn set_sample_rate(current: f64, rate: f64) -> f64 {
    if !(8000.0..=48000.0).contains(&rate) {
        return current;
    }
    floor(rate)
}

/// Lua: m4a_mix.lua:39
pub fn samples_per_vblank(rate: f64) -> f64 {
    rate * GBA_SAMPLES_PER_VBLANK / GBA_MIX_RATE
}

// Lua: m4a_mix.lua:50 DUTY (threshold; hi = 1, lo = -1)
const DUTY: [f64; 4] = [0.125, 0.25, 0.5, 0.75];

// Lua: m4a_mix.lua:58 gCgbScaleTable
const CGB_SCALE: [u8; 132] = [
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, //
    0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1A, 0x1B, //
    0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2A, 0x2B, //
    0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3A, 0x3B, //
    0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4A, 0x4B, //
    0x50, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5A, 0x5B, //
    0x60, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6A, 0x6B, //
    0x70, 0x71, 0x72, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7A, 0x7B, //
    0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8A, 0x8B, //
    0x90, 0x91, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9A, 0x9B, //
    0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0xA6, 0xA7, 0xA8, 0xA9, 0xAA, 0xAB, //
];

// Lua: m4a_mix.lua:72 gCgbFreqTable
const CGB_FREQ: [f64; 12] = [
    -2004.0, -1891.0, -1785.0, -1685.0, -1591.0, -1501.0, -1417.0, -1337.0, -1262.0, -1192.0,
    -1125.0, -1062.0,
];

// Lua: m4a_mix.lua:76 gNoiseTable
const NOISE_TABLE: [u8; 60] = [
    0xD7, 0xD6, 0xD5, 0xD4, 0xC7, 0xC6, 0xC5, 0xC4, //
    0xB7, 0xB6, 0xB5, 0xB4, 0xA7, 0xA6, 0xA5, 0xA4, //
    0x97, 0x96, 0x95, 0x94, 0x87, 0x86, 0x85, 0x84, //
    0x77, 0x76, 0x75, 0x74, 0x67, 0x66, 0x65, 0x64, //
    0x57, 0x56, 0x55, 0x54, 0x47, 0x46, 0x45, 0x44, //
    0x37, 0x36, 0x35, 0x34, 0x27, 0x26, 0x25, 0x24, //
    0x17, 0x16, 0x15, 0x14, 0x07, 0x06, 0x05, 0x04, //
    0x03, 0x02, 0x01, 0x00,
];

// Lua: m4a_mix.lua:87
const NOISE_DIV: [f64; 8] = [8.0, 16.0, 32.0, 48.0, 64.0, 80.0, 96.0, 112.0];

// Lua: m4a_mix.lua:90 gScaleTable
const DS_SCALE: [u8; 180] = [
    0xE0, 0xE1, 0xE2, 0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0xEA, 0xEB, //
    0xD0, 0xD1, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6, 0xD7, 0xD8, 0xD9, 0xDA, 0xDB, //
    0xC0, 0xC1, 0xC2, 0xC3, 0xC4, 0xC5, 0xC6, 0xC7, 0xC8, 0xC9, 0xCA, 0xCB, //
    0xB0, 0xB1, 0xB2, 0xB3, 0xB4, 0xB5, 0xB6, 0xB7, 0xB8, 0xB9, 0xBA, 0xBB, //
    0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0xA6, 0xA7, 0xA8, 0xA9, 0xAA, 0xAB, //
    0x90, 0x91, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9A, 0x9B, //
    0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8A, 0x8B, //
    0x70, 0x71, 0x72, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7A, 0x7B, //
    0x60, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6A, 0x6B, //
    0x50, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5A, 0x5B, //
    0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4A, 0x4B, //
    0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3A, 0x3B, //
    0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2A, 0x2B, //
    0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1A, 0x1B, //
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, //
];

// Lua: m4a_mix.lua:108 gFreqTable
const DS_FREQ: [f64; 12] = [
    2147483648.0,
    2275179671.0,
    2410468894.0,
    2553802834.0,
    2705659852.0,
    2866546760.0,
    3037000500.0,
    3217589947.0,
    3408917802.0,
    3611622603.0,
    3826380858.0,
    4053909305.0,
];

// Lua: m4a_mix.lua:115
const GB_CLOCK: f64 = 4194304.0;

/// Lua: m4a_mix.lua:116
fn hpf_charge(rate: f64) -> f64 {
    exp(-2.0 * core::f64::consts::PI * 5.0 / rate)
}

/// Lua: m4a_mix.lua:125 — high 32 bits of a*b, computed in doubles.
fn umul_hi32(mut a: f64, mut b: f64) -> f64 {
    if a < 0.0 {
        a += 4294967296.0;
    }
    if b < 0.0 {
        b += 4294967296.0;
    }
    floor(a * b / 4294967296.0)
}

/// Lua: m4a_mix.lua:134
fn ds_scale_freq(key: f64) -> f64 {
    let mut key = floor(key);
    if key < 0.0 {
        key = 0.0;
    }
    if key > 179.0 {
        key = 179.0;
    }
    let s = DS_SCALE[key as usize] as f64;
    floor(DS_FREQ[lmod(s, 16.0) as usize] / pow2i(floor(s / 16.0)))
}

/// Lua: m4a_mix.lua:143 `Mix.midiKeyToFreq` — playback Hz.
pub fn midi_key_to_freq(wav_freq: f64, key: f64, fine: f64) -> f64 {
    let mut key = floor(key);
    let mut fine = floor(fine);
    if fine < 0.0 {
        fine = 0.0;
    }
    if fine > 255.0 {
        fine = 255.0;
    }
    if key > 178.0 {
        key = 178.0;
        fine = 255.0;
    }
    if key < 0.0 {
        key = 0.0;
    }
    let val1 = ds_scale_freq(key);
    let val2 = ds_scale_freq(key + 1.0);
    let delta = val2 - val1;
    let interp = umul_hi32(delta, fine * 16777216.0);
    umul_hi32(wav_freq, val1 + interp)
}

/// Lua: m4a_mix.lua:163 `Mix.cgbPeriod`.
pub fn cgb_period(key: f64, fine: f64, fixed: bool) -> f64 {
    let mut key = key;
    let mut fine = floor(fine);
    if fine < 0.0 {
        fine = 0.0;
    }
    if fine > 255.0 {
        fine = 255.0;
    }
    if key <= 35.0 {
        fine = 0.0;
        key = 0.0;
    } else {
        key -= 36.0;
        if key > 130.0 {
            key = 130.0;
            fine = 255.0;
        }
    }
    // CGB_SCALE[key] or 0 (keys are integers here; a fractional key is nil)
    let at = |k: f64| -> Option<f64> {
        if k >= 0.0 && k < CGB_SCALE.len() as f64 && k == floor(k) {
            Some(CGB_SCALE[k as usize] as f64)
        } else {
            None
        }
    };
    let s1 = at(key).unwrap_or(0.0);
    let val1 = floor(CGB_FREQ[lmod(s1, 16.0) as usize] / pow2i(floor(s1 / 16.0)));
    let s2 = at(key + 1.0).unwrap_or(s1);
    let val2 = floor(CGB_FREQ[lmod(s2, 16.0) as usize] / pow2i(floor(s2 / 16.0)));
    let mut period = val1 + floor((fine * (val2 - val1)) / 256.0) + 2048.0;
    if fixed {
        period = lmod(floor((period + 1.0) / 2.0) * 2.0, 2048.0);
    }
    period
}

/// Lua: m4a_mix.lua:188
pub fn cgb_pulse_hz(key: f64, fine: f64, fixed: bool) -> f64 {
    let p = cgb_period(key, fine, fixed);
    let mut denom = 2048.0 - p;
    if denom < 1.0 {
        denom = 1.0;
    }
    131072.0 / denom
}

/// Lua: m4a_mix.lua:196
pub fn cgb_wave_hz(key: f64, fine: f64, fixed: bool) -> f64 {
    cgb_pulse_hz(key, fine, fixed) * 0.5
}

/// Lua: m4a_mix.lua:200
pub fn period_to_pulse_hz(period_reg: f64) -> f64 {
    let mut denom = 2048.0 - period_reg;
    if denom < 1.0 {
        denom = 1.0;
    }
    131072.0 / denom
}

/// Lua: m4a_mix.lua:206
pub fn cgb_noise_nr43(key: f64) -> f64 {
    let mut key = key;
    if key <= 20.0 {
        key = 0.0;
    } else {
        key -= 21.0;
        if key > 59.0 {
            key = 59.0;
        }
    }
    if key >= 0.0 && key == floor(key) && (key as usize) < NOISE_TABLE.len() {
        NOISE_TABLE[key as usize] as f64
    } else {
        0.0
    }
}

/// Lua: m4a_mix.lua:218 — LFSR step period in output samples.
pub fn cgb_noise_period(key: f64, rate: f64) -> f64 {
    let nr43 = cgb_noise_nr43(key);
    let shift = lmod(floor(nr43 / 16.0), 16.0);
    let div = NOISE_DIV[lmod(nr43, 8.0) as usize];
    rate * div * pow2i(shift) / GB_CLOCK
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VoiceKind {
    Ds,
    CgbPulse,
    CgbWave,
    CgbNoise,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EnvPhase {
    Attack,
    Decay,
    Sustain,
    Release,
    Echo,
}

/// `voice.adsr` (m4a_mix.lua:231).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Adsr {
    pub attack: f64,
    pub decay: f64,
    pub sustain: f64,
    pub release: f64,
    pub is_cgb: bool,
    pub pseudo_echo_volume: f64,
    pub pseudo_echo_length: f64,
}

/// A voice table. Fields a given kind never sets keep their defaults; the
/// Lua's `x or default` reads are spelled out where they matter.
#[derive(Clone, Debug)]
pub struct Voice {
    pub kind: VoiceKind,
    pub alive: bool,
    pub released: bool,
    pub gate_ticks: Option<f64>,
    /// `v.track` as an index into the sequencer's tracks.
    pub track: Option<usize>,
    pub note_key: Option<f64>,
    pub note_vel: Option<f64>,
    pub midi_key: Option<f64>,
    pub priority: Option<f64>,
    pub rhythm_pan: Option<f64>,
    pub vol_l: f64,
    pub vol_r: f64,
    pub adsr: Option<Adsr>,
    pub env_phase: EnvPhase,
    pub env_vol: Option<f64>,
    pub env_started: bool,
    pub env_counter: Option<f64>,
    pub env_goal: Option<f64>,
    pub sustain_goal: f64,
    pub route_l: bool,
    pub route_r: bool,
    pub length_remaining: Option<f64>,
    // DirectSound
    pub pcm_off: usize,
    pub pcm_len: usize,
    pub pos: f64,
    pub size: f64,
    pub loop_start: f64,
    pub looping: bool,
    pub step: f64,
    pub wav_freq: Option<f64>,
    pub fixed_freq: bool,
    // CGB
    pub cgb_chan: Option<u8>,
    pub cgb_fixed: bool,
    pub duty: usize,
    pub phase: f64,
    pub period_reg: f64,
    pub freq: f64,
    pub sweep_enabled: bool,
    pub sweep_nr10: f64,
    pub sweep_shadow: f64,
    pub sweep_timer: f64,
    pub sweep_acc: f64,
    pub wave: [f64; 32],
    pub lfsr: u32,
    pub short_noise: bool,
    pub clock: f64,
    pub period: f64,
}

impl Voice {
    fn blank(kind: VoiceKind) -> Voice {
        Voice {
            kind,
            alive: true,
            released: false,
            gate_ticks: None,
            track: None,
            note_key: None,
            note_vel: None,
            midi_key: None,
            priority: None,
            rhythm_pan: None,
            vol_l: 0.0,
            vol_r: 0.0,
            adsr: None,
            env_phase: EnvPhase::Attack,
            env_vol: None,
            env_started: false,
            env_counter: None,
            env_goal: None,
            sustain_goal: 0.0,
            route_l: true,
            route_r: true,
            length_remaining: None,
            pcm_off: 0,
            pcm_len: 0,
            pos: 0.0,
            size: 0.0,
            loop_start: 0.0,
            looping: false,
            step: 1.0,
            wav_freq: None,
            fixed_freq: false,
            cgb_chan: None,
            cgb_fixed: false,
            duty: 2,
            phase: 0.0,
            period_reg: 0.0,
            freq: 0.0,
            sweep_enabled: false,
            sweep_nr10: 0.0,
            sweep_shadow: 0.0,
            sweep_timer: 0.0,
            sweep_acc: 0.0,
            wave: [8.0; 32],
            lfsr: 0x7FFF,
            short_noise: false,
            clock: 0.0,
            period: 1.0,
        }
    }
}

/// Lua: m4a_mix.lua:227 `Mix.attachAdsr` (opts never carries echo fields
/// on the paths ported here; `tone.pseudoEcho*` are never set either).
pub fn attach_adsr(v: &mut Voice, tone: &Tone, is_cgb: bool) {
    v.adsr = Some(Adsr {
        attack: tone.attack.unwrap_or(if is_cgb { 0.0 } else { 255.0 }),
        decay: tone.decay.unwrap_or(0.0),
        sustain: tone.sustain.unwrap_or(if is_cgb { 15.0 } else { 255.0 }),
        release: tone.release.unwrap_or(0.0),
        is_cgb,
        pseudo_echo_volume: 0.0,
        pseudo_echo_length: 0.0,
    });
    v.env_phase = EnvPhase::Attack;
    v.env_vol = Some(0.0);
}

/// Lua: m4a_mix.lua:246
fn finish_envelope(v: &mut Voice, cgb: bool) {
    let a = v.adsr.as_ref().unwrap();
    let mut echo = a.pseudo_echo_volume;
    if cgb {
        echo = floor((v.env_goal.unwrap_or(0.0) * echo + 255.0) / 256.0);
    }
    v.env_vol = Some(echo);
    if echo > 0.0 {
        v.env_phase = EnvPhase::Echo;
    } else {
        v.alive = false;
    }
}

/// Lua: m4a_mix.lua:260 `Mix.cgbVolume`.
pub fn cgb_volume(v: &mut Voice) {
    let l = floor(v.vol_l * 256.0);
    let r = floor(v.vol_r * 256.0);
    v.route_l = true;
    v.route_r = true;
    if r >= l && floor(r / 2.0) >= l {
        v.route_l = false;
    } else if l > r && floor(l / 2.0) >= r {
        v.route_r = false;
    }
    let goal = 15.0f64.min(floor((l + r) / 16.0));
    v.env_goal = Some(goal);
    v.sustain_goal = floor((goal * v.adsr.as_ref().unwrap().sustain + 15.0) / 16.0);
}

/// Lua: m4a_mix.lua:273
fn cgb_decay(v: &mut Voice) {
    let a = *v.adsr.as_ref().unwrap();
    v.env_vol = v.env_goal;
    v.env_phase = EnvPhase::Decay;
    v.env_counter = Some(a.decay);
    if a.decay == 0.0 {
        v.env_vol = Some(v.sustain_goal);
        v.env_phase = EnvPhase::Sustain;
        v.env_counter = Some(7.0);
        if a.sustain == 0.0 {
            finish_envelope(v, true);
        }
    }
}

/// Lua: m4a_mix.lua:286
fn tick_cgb_envelope(v: &mut Voice, extra_clock: bool) {
    cgb_volume(v);
    let a = *v.adsr.as_ref().unwrap();
    if !v.env_started {
        v.env_started = true;
        if v.released {
            v.alive = false;
            return;
        }
        v.env_counter = Some(a.attack);
        if a.attack == 0.0 {
            cgb_decay(v);
        }
    } else if v.env_phase == EnvPhase::Echo {
        let ad = v.adsr.as_mut().unwrap();
        ad.pseudo_echo_length -= 1.0;
        if ad.pseudo_echo_length <= 0.0 {
            v.alive = false;
        }
        return;
    } else if v.released && v.env_phase != EnvPhase::Release {
        v.env_phase = EnvPhase::Release;
        v.env_counter = Some(a.release);
        if a.release == 0.0 {
            finish_envelope(v, true);
        }
    } else if v.env_counter.unwrap_or(0.0) == 0.0 {
        // CgbSound counts down once per VBlank and twice every fifteenth frame.
        let ev = v.env_vol.unwrap_or(0.0);
        match v.env_phase {
            EnvPhase::Attack => {
                v.env_vol = Some(ev + 1.0);
                v.env_counter = Some(a.attack);
                if ev + 1.0 >= v.env_goal.unwrap_or(0.0) {
                    cgb_decay(v);
                }
            }
            EnvPhase::Decay => {
                v.env_vol = Some(ev - 1.0);
                v.env_counter = Some(a.decay);
                if ev - 1.0 <= v.sustain_goal {
                    v.env_vol = Some(v.sustain_goal);
                    v.env_phase = EnvPhase::Sustain;
                    v.env_counter = Some(7.0);
                    if a.sustain == 0.0 {
                        finish_envelope(v, true);
                    }
                }
            }
            EnvPhase::Sustain => {
                v.env_vol = Some(v.sustain_goal);
                v.env_counter = Some(7.0);
            }
            EnvPhase::Release => {
                v.env_vol = Some(ev - 1.0);
                v.env_counter = Some(a.release);
                if ev - 1.0 <= 0.0 {
                    finish_envelope(v, true);
                }
            }
            EnvPhase::Echo => {}
        }
    }
    if v.alive && v.env_phase != EnvPhase::Echo {
        v.env_counter = Some(0.0f64.max(v.env_counter.unwrap_or(0.0) - 1.0));
        if extra_clock {
            tick_cgb_envelope(v, false);
        }
    }
}

/// Lua: m4a_mix.lua:335 `Mix.tickEnvelope` — once per GBA frame.
pub fn tick_envelope(v: &mut Voice, extra_cgb_clock: bool) {
    if !v.alive {
        return;
    }
    let a = match v.adsr {
        Some(a) => a,
        None => return, // v.env = 1 (unused by the render)
    };
    if a.is_cgb {
        tick_cgb_envelope(v, extra_cgb_clock);
        return;
    }
    if !v.env_started {
        v.env_started = true;
        if v.released {
            v.alive = false;
            return;
        }
    }
    let ev = v.env_vol.unwrap_or(0.0);
    let phase = v.env_phase;
    if phase == EnvPhase::Echo {
        let ad = v.adsr.as_mut().unwrap();
        ad.pseudo_echo_length -= 1.0;
        if ad.pseudo_echo_length <= 0.0 {
            v.alive = false;
        }
    } else if v.released {
        v.env_phase = EnvPhase::Release;
        let nv = floor(ev * a.release / 256.0);
        v.env_vol = Some(nv);
        if nv <= a.pseudo_echo_volume {
            finish_envelope(v, false);
        }
    } else if phase == EnvPhase::Attack {
        let nv = 255.0f64.min(ev + a.attack);
        v.env_vol = Some(nv);
        if nv == 255.0 {
            v.env_phase = EnvPhase::Decay;
        }
    } else if phase == EnvPhase::Decay {
        let nv = floor(ev * a.decay / 256.0);
        v.env_vol = Some(nv);
        if nv <= a.sustain {
            v.env_vol = Some(a.sustain);
            v.env_phase = EnvPhase::Sustain;
            if a.sustain == 0.0 {
                finish_envelope(v, false);
            }
        }
    }
}

/// Lua: m4a_mix.lua:370 `Mix.releaseVoice`.
pub fn release_voice(v: &mut Voice) {
    if v.released {
        return;
    }
    v.released = true;
    v.gate_ticks = None;
    if v.adsr.is_none() {
        v.alive = false;
    }
}

/// `opts` of `Mix.newDsVoice`.
pub struct DsOpts<'a> {
    pub rate: Option<f64>,
    pub looping: bool,
    pub vol_l: Option<f64>,
    pub vol_r: Option<f64>,
    pub tone: Option<&'a Tone>,
}

/// Lua: m4a_mix.lua:377 `Mix.newDsVoice` (`pcm` as its range in samples.bin).
pub fn new_ds_voice(
    pcm: (usize, usize),
    meta: &SampleMeta,
    opts: DsOpts,
    sample_rate: f64,
) -> Voice {
    let rate = opts.rate.unwrap_or_else(|| wave_rate(meta.freq));
    let mut v = Voice::blank(VoiceKind::Ds);
    v.pcm_off = pcm.0;
    v.pcm_len = pcm.1;
    v.pos = 0.0;
    v.size = meta.size;
    v.loop_start = meta.loop_start;
    v.looping = opts.looping;
    v.step = rate / sample_rate;
    v.vol_l = opts.vol_l.unwrap_or(0.5);
    v.vol_r = opts.vol_r.unwrap_or(0.5);
    if let Some(t) = opts.tone {
        attach_adsr(&mut v, t, false);
    }
    v
}

/// Lua: m4a_mix.lua:397 `Mix.waveRate`.
pub fn wave_rate(freq_field: f64) -> f64 {
    if freq_field <= 0.0 {
        return GBA_MIX_RATE;
    }
    let mut rate = floor(freq_field / 1024.0 + 0.5);
    if rate < 500.0 {
        rate = GBA_MIX_RATE;
    }
    if rate > 48000.0 {
        rate = 48000.0;
    }
    rate
}

/// Lua: m4a_mix.lua:407
pub const MAX_DS_CHANNELS: usize = 5;

/// `opts` of the CGB constructors.
pub struct CgbOpts<'a> {
    pub key: f64,
    pub fine: f64,
    pub duty: usize,
    pub cgb_chan: u8,
    pub vol_l: f64,
    pub vol_r: f64,
    pub tone: Option<&'a Tone>,
    pub wave: [f64; 32],
    pub period: Option<f64>,
}

fn tone_fixed(tone: Option<&Tone>) -> bool {
    tone.map_or(false, |t| {
        lmod(floor(t.typ.unwrap_or(0.0) / 8.0), 2.0) == 1.0
    })
}

/// Lua: m4a_mix.lua:409 `Mix.newCgbPulse`.
pub fn new_cgb_pulse(opts: &CgbOpts) -> Voice {
    let fixed = tone_fixed(opts.tone);
    let period_reg = cgb_period(opts.key, opts.fine, fixed);
    let mut v = Voice::blank(VoiceKind::CgbPulse);
    v.cgb_chan = Some(opts.cgb_chan);
    v.cgb_fixed = fixed;
    v.duty = opts.duty;
    v.period_reg = period_reg;
    v.freq = period_to_pulse_hz(period_reg);
    v.vol_l = opts.vol_l;
    v.vol_r = opts.vol_r;
    let pan_sweep = opts.tone.and_then(|t| t.pan).unwrap_or(0.0);
    if opts.cgb_chan == 1 && pan_sweep > 0.0 && lmod(floor(pan_sweep / 128.0), 2.0) == 0.0 {
        let time = lmod(floor(pan_sweep / 16.0), 8.0);
        let shift = lmod(pan_sweep, 8.0);
        if time > 0.0 || shift > 0.0 {
            v.sweep_nr10 = lmod(pan_sweep, 128.0);
            v.sweep_shadow = period_reg;
            v.sweep_timer = if time == 0.0 { 8.0 } else { time };
            v.sweep_acc = 0.0;
            v.sweep_enabled = true;
        }
    }
    if let Some(t) = opts.tone {
        attach_adsr(&mut v, t, true);
    }
    v
}

/// Lua: m4a_mix.lua:445 `Mix.newCgbWave`.
pub fn new_cgb_wave(opts: &CgbOpts) -> Voice {
    let fixed = tone_fixed(opts.tone);
    let mut v = Voice::blank(VoiceKind::CgbWave);
    v.cgb_chan = Some(3);
    v.cgb_fixed = fixed;
    v.wave = opts.wave;
    v.freq = cgb_wave_hz(opts.key, opts.fine, fixed);
    v.vol_l = opts.vol_l;
    v.vol_r = opts.vol_r;
    if let Some(t) = opts.tone {
        attach_adsr(&mut v, t, true);
    }
    v
}

/// Lua: m4a_mix.lua:467 `Mix.newCgbNoise`.
pub fn new_cgb_noise(opts: &CgbOpts, rate: f64) -> Voice {
    let mut v = Voice::blank(VoiceKind::CgbNoise);
    v.cgb_chan = Some(4);
    v.lfsr = 0x7FFF;
    v.short_noise = opts
        .tone
        .map_or(false, |t| lmod(t.wav_param.unwrap_or(0.0), 2.0) == 1.0);
    v.clock = 0.0;
    v.period = opts
        .period
        .unwrap_or_else(|| cgb_noise_period(opts.key, rate));
    v.vol_l = opts.vol_l;
    v.vol_r = opts.vol_r;
    if let Some(t) = opts.tone {
        attach_adsr(&mut v, t, true);
    }
    v
}

/// Lua: m4a_mix.lua:491
#[inline]
fn s8_at(pcm: &[u8], idx: f64) -> f64 {
    let i = floor(idx);
    if i < 0.0 || i >= pcm.len() as f64 {
        return 0.0;
    }
    (pcm[i as usize] as i8) as f64 / 128.0
}

/// Lua: m4a_mix.lua:499
#[inline]
fn s8_lerp(pcm: &[u8], pos: f64, size: f64, looping: bool, loop_start: f64) -> f64 {
    if pos < 0.0 {
        return 0.0;
    }
    let i0 = floor(pos);
    if i0 >= size {
        return 0.0;
    }
    let frac = pos - i0;
    let s0 = s8_at(pcm, i0);
    if frac < 1e-6 {
        return s0;
    }
    let mut i1 = i0 + 1.0;
    if i1 >= size {
        if looping && loop_start < size {
            i1 = loop_start;
        } else {
            return s0;
        }
    }
    let s1 = s8_at(pcm, i1);
    s0 + (s1 - s0) * frac
}

/// Lua: m4a_mix.lua:519 — GB channel-1 sweep (~128 Hz clock).
fn tick_sweep_sample(v: &mut Voice, rate: f64) {
    if !v.sweep_enabled {
        return;
    }
    let clocks_per_sec = 128.0;
    v.sweep_acc += clocks_per_sec / rate;
    while v.sweep_acc >= 1.0 {
        v.sweep_acc -= 1.0;
        let nr10 = v.sweep_nr10;
        let time = lmod(floor(nr10 / 16.0), 8.0);
        if time == 0.0 {
            return;
        }
        v.sweep_timer -= 1.0;
        if v.sweep_timer > 0.0 {
            // wait
        } else {
            v.sweep_timer = time;
            let shift = lmod(nr10, 8.0);
            if shift == 0.0 {
                return;
            }
            let shadow = v.sweep_shadow;
            let delta = floor(shadow / pow2i(shift));
            let negate = lmod(floor(nr10 / 8.0), 2.0);
            let newf = if negate == 1.0 {
                shadow - delta
            } else {
                shadow + delta
            };
            if newf > 2047.0 || newf < 0.0 {
                v.alive = false;
                return;
            }
            v.sweep_shadow = newf;
            v.period_reg = newf;
            v.freq = period_to_pulse_hz(newf);
        }
    }
}

/// Lua: m4a_mix.lua:550 `render_voice` — adds `n` samples into out_l/out_r.
fn render_voice(
    v: &mut Voice,
    n: usize,
    out_l: &mut [f64],
    out_r: &mut [f64],
    samples_bin: &[u8],
    rate: f64,
) {
    if !v.alive {
        return;
    }
    let mut n = n;
    if let Some(lr) = v.length_remaining {
        n = n.min(0.0f64.max(ceil(lr)) as usize);
        v.length_remaining = Some(lr - n as f64);
    }
    match v.kind {
        VoiceKind::Ds => {
            let pcm = &samples_bin[v.pcm_off..v.pcm_off + v.pcm_len];
            let size = v.size;
            let looping = v.looping;
            let loop_start = if v.loop_start >= 0.0 && v.loop_start < size {
                v.loop_start
            } else {
                0.0
            };
            let loop_len = size - loop_start;
            let step = v.step;
            let mut pos = v.pos;
            // SoundMain: masterVolume = 12, envelope gain = ((12 + 1) * env) >> 4.
            let e = floor(13.0 * v.env_vol.unwrap_or(255.0) / 16.0);
            let vol_l = floor(v.vol_l * e) / 256.0;
            let vol_r = floor(v.vol_r * e) / 256.0;
            for i in 0..n {
                if pos >= size {
                    if looping && loop_len > 0.0 {
                        pos = loop_start + lmod(pos - loop_start, loop_len);
                    } else {
                        v.alive = false;
                        break;
                    }
                }
                let s = s8_lerp(pcm, pos, size, looping, loop_start);
                out_l[i] += s * vol_l;
                out_r[i] += s * vol_r;
                pos += step;
            }
            v.pos = pos;
        }
        VoiceKind::CgbPulse => {
            let thresh = DUTY[if v.duty < 4 { v.duty } else { 2 }];
            for i in 0..n {
                tick_sweep_sample(v, rate);
                if !v.alive {
                    break;
                }
                let inc = v.freq / rate;
                let s = if v.phase < thresh { 1.0 } else { -1.0 };
                // SOUNDCNT_L=0x77, PSG ratio=100%: one envelope unit is 16/512.
                let s = (s + 1.0) * v.env_vol.unwrap_or(15.0) / 64.0;
                if v.route_l {
                    out_l[i] += s;
                }
                if v.route_r {
                    out_r[i] += s;
                }
                v.phase += inc;
                v.phase = lmod(v.phase, 1.0);
            }
        }
        VoiceKind::CgbWave => {
            let inc = v.freq / rate;
            for i in 0..n {
                let idx = lmod(floor(v.phase * 32.0), 32.0) as usize;
                let nibble = v.wave[idx];
                // gCgb3Vol: mute, 25%, 50%, 75%, 100% (hardware truncates nibbles).
                let level = v.env_vol.unwrap_or(15.0);
                let mut sample = 0.0;
                if level >= 14.0 {
                    sample = nibble;
                } else if level >= 10.0 {
                    sample = floor(nibble * 3.0 / 4.0);
                } else if level >= 6.0 {
                    sample = floor(nibble / 2.0);
                } else if level >= 2.0 {
                    sample = floor(nibble / 4.0);
                }
                let s = sample / 32.0;
                if v.route_l {
                    out_l[i] += s;
                }
                if v.route_r {
                    out_r[i] += s;
                }
                v.phase += inc;
                v.phase = lmod(v.phase, 1.0);
            }
        }
        VoiceKind::CgbNoise => {
            for i in 0..n {
                v.clock += 1.0;
                while v.clock >= v.period {
                    v.clock -= v.period;
                    let lo = v.lfsr & 1;
                    let hi = (v.lfsr >> 1) & 1;
                    let bit = if lo == hi { 0 } else { 1 };
                    v.lfsr = (v.lfsr >> 1) + bit * 0x4000;
                    if v.short_noise {
                        v.lfsr = v.lfsr - ((v.lfsr >> 6) & 1) * 64 + bit * 64;
                    }
                }
                let s = if v.lfsr & 1 == 0 {
                    v.env_vol.unwrap_or(15.0) / 32.0
                } else {
                    0.0
                };
                if v.route_l {
                    out_l[i] += s;
                }
                if v.route_r {
                    out_r[i] += s;
                }
            }
        }
    }
    if let Some(lr) = v.length_remaining {
        if lr <= 0.0 {
            v.alive = false;
        }
    }
}

/// Lua: m4a_mix.lua:641 `Mix.newReverb` state. The delay lines are
/// allocated on first use (a level-0 reverb never touches them).
#[derive(Clone, Debug)]
pub struct Reverb {
    pub level: f64,
    short_delay: f64,
    long_delay: f64,
    size: usize,
    cursor: usize,
    left: Vec<f64>,
    right: Vec<f64>,
    energy: f64,
}

impl Reverb {
    /// Lua: m4a_mix.lua:641
    pub fn new(level: f64, rate: f64) -> Reverb {
        let frame = rate / GBA_VBLANK_HZ;
        Reverb {
            level: 0.0f64.max(127.0f64.min(level)),
            short_delay: frame * 6.0,
            long_delay: frame * 7.0,
            size: ceil(frame * 7.0) as usize + 1,
            cursor: 0,
            left: Vec::new(),
            right: Vec::new(),
            energy: 0.0,
        }
    }

    /// Lua: m4a_mix.lua:652 `Mix.reverbActive`.
    pub fn active(&self) -> bool {
        self.level > 0.0 && self.energy > 1e-8
    }

    /// Lua: m4a_mix.lua:656
    #[inline]
    fn tap(&self, delay: f64) -> f64 {
        let size = self.size as f64;
        let at = lmod(self.cursor as f64 - delay, size);
        let i = floor(at);
        let frac = at - i;
        let iu = i as usize;
        let j = (iu + 1) % self.size;
        let a =
            self.left.get(iu).copied().unwrap_or(0.0) + self.right.get(iu).copied().unwrap_or(0.0);
        let b =
            self.left.get(j).copied().unwrap_or(0.0) + self.right.get(j).copied().unwrap_or(0.0);
        a + (b - a) * frac
    }

    /// Lua: m4a_mix.lua:666 `apply_reverb`.
    fn apply(&mut self, left: &mut [f64], right: &mut [f64], n: usize) {
        if self.level <= 0.0 {
            return;
        }
        if self.left.is_empty() {
            self.left = vec![0.0; self.size];
            self.right = vec![0.0; self.size];
        }
        let gain = self.level / 512.0;
        for i in 0..n {
            let echo = (self.tap(self.short_delay) + self.tap(self.long_delay)) * gain;
            let (l, r) = (left[i] + echo, right[i] + echo);
            let at = self.cursor;
            let (old_l, old_r) = (self.left[at], self.right[at]);
            self.energy = 0.0f64.max(self.energy + l * l + r * r - old_l * old_l - old_r * old_r);
            self.left[at] = l;
            self.right[at] = r;
            self.cursor = (at + 1) % self.size;
            left[i] = l;
            right[i] = r;
        }
    }
}

/// Lua: m4a_mix.lua:682 `Mix.render` with `raw = true`, as renderBuffered
/// calls it: writes `out_l.len()` samples (master gain, reverb, the DC
/// blocker with state `hpf`), then drops dead voices.
pub fn render(
    voices: &mut Vec<Voice>,
    out_l: &mut [f64],
    out_r: &mut [f64],
    samples_bin: &[u8],
    rate: f64,
    master: f64,
    reverb: &mut Reverb,
    hpf: &mut (f64, f64),
) {
    let n = out_l.len();
    for i in 0..n {
        out_l[i] = 0.0;
        out_r[i] = 0.0;
    }
    for v in voices.iter_mut() {
        if v.kind == VoiceKind::Ds {
            render_voice(v, n, out_l, out_r, samples_bin, rate);
        }
    }
    reverb.apply(out_l, out_r, n);
    for v in voices.iter_mut() {
        if v.kind != VoiceKind::Ds {
            render_voice(v, n, out_l, out_r, samples_bin, rate);
        }
    }
    voices.retain(|v| v.alive);

    // DC blocker; state belongs to the rendered player slot.
    let charge = hpf_charge(rate);
    let (mut cap_l, mut cap_r) = *hpf;
    for i in 0..n {
        let inl = out_l[i] * master;
        let inr = out_r[i] * master;
        let hp_l = inl - cap_l;
        cap_l = inl - hp_l * charge;
        let hp_r = inr - cap_r;
        cap_r = inr - hp_r * charge;
        out_l[i] = hp_l;
        out_r[i] = hp_r;
    }
    *hpf = (cap_l, cap_r);
}
