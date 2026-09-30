//! The chip synthesizer: the ROM's own channel programs, interpreted and
//! rendered to PCM inside the core.
//!
//! A port of gen1recomp `src/core/ChipSynth.lua` (MIT), which is the
//! executable spec — every non-obvious rule below cites the line it ports.
//! The ROM stores music, sound effects and cries as CHANNEL PROGRAMS: short
//! bytecode streams, one per hardware channel, that the GB's sound driver
//! interprets a frame at a time. This module runs that interpreter and
//! renders the result straight to PCM, so no register-level emulation is
//! needed — the same trick the reference uses.
//!
//! # Why this lives in Rust
//!
//! It used to be TypeScript in the guest. Measured on a real PSP, ONE PCM
//! frame of the four-channel interpreter cost **~0.21 ms**, so 11.025 kHz
//! wanted ~2.3 seconds of CPU per second of audio and the guest could never
//! reach the ring's lead. The same interpreter compiled costs tens of
//! microseconds for a whole tick's worth of frames.
//!
//! # Integer arithmetic
//!
//! The reference is doubles throughout; most of it is integer math wearing a
//! double, and this port states the integers. What that buys is not only
//! speed on a part whose FPU is single-precision: it is that the mix is
//! **provably** the same s16 the reference's doubles quantize to. Each
//! channel's value is exact in units of 1/[`spec::AUDIO_MIX_UNIT`]
//! (480 = lcm(15, 32) covers both a pulse at volume/15 and a wave nibble at
//! output level 1/4), four channels sum to at most 4*480, and the quantized
//! result `round(sum * 32767 / 1920)` can only disagree with the double path
//! where the true value sits within 1e-10 of a half-integer — impossible,
//! because a rational with denominator 1920 is either exactly on a
//! half-integer (where both paths are exact) or at least 1/3840 away.
//!
//! Two places are deliberately not integers, both documented at their site:
//! the 60 Hz frame index ([`frame_at`], where the reference's double
//! disagrees with the exact rational and the reference wins), and the
//! oscillator phase, which is a 64-bit fixed-point accumulator rather than a
//! double (a rounding difference of ~5e-20 per sample against the
//! reference's ~1e-16).
//!
//! # What is deliberately not ported
//!
//! The def-local ChipAsm program shape (`ChipSynth.lua:164-173, :709-726`) —
//! a mod-authoring feature with no ROM content behind it — and the per-hardware
//! runtime volume/pitch mix (`:36-95`), whose shipped values are all 1
//! (`ChipAudio.lua:39-52`). Both are noted where their branch would have been.
//!
//! # The Gen 2 driver (Pokemon Gold)
//!
//! Engine id [`AUDIO_ENGINE_GEN2`] runs Gold's driver: a port of the
//! `generation == 2` paths of ChipSynth.lua **at gen1recomp bdfac727** (its
//! last MIT commit). Those citations read `ChipSynth.lua@bdfac727:N`; the
//! bare `ChipSynth.lua:N` ones above are the older revision the Gen 1 port
//! was made from, whose line numbers differ. Gen 1 is untouched: every Gen 2
//! difference sits behind `Channel::gen2` / `Program::gen2`.
//!
//! What Gen 2 changes: the command set ($d0-$ff, @bdfac727:680-900), the
//! note clock (SetNoteDuration's two truncating multiplies, :414-424), the
//! frequency table with transpose and pitch_offset (:373-387), per-channel
//! NR51 tracks and the stereo option (:436-459, :806-845), drum kits
//! (:1155-1188), ten wave instruments (:1215-1230), the drum tail that rings
//! on through rests (:1008-1054), a cry's length used as the tempo itself
//! (:1312-1320) and a 12 s one-shot cap (:1444). The low-health siren
//! (ChipAudio.lua@bdfac727:667) is here too, since only Gold's port plays it.
//!
//! Deliberately kept on the Gen 1 port's model rather than bdfac727's: the
//! bipolar integer mix. bdfac727 renders unipolar channels through a DC
//! high-pass, a one-pole low-pass (alpha 0.8) and a 0.5 gain
//! (@bdfac727:150-152, :1357-1365); applying that to Gold alone would make
//! the two generations mix differently on one host.

use alloc::vec::Vec;

use crate::spec::{
    AUDIO_BANK_SIZE, AUDIO_DRUMS, AUDIO_EFFECT_MAX_SECONDS, AUDIO_ENGINE_GEN2, AUDIO_ENGINES,
    AUDIO_FADE_LEVELS, AUDIO_FRAME_TICKS, AUDIO_GB_CLOCK, AUDIO_GEN2_DRUMKITS,
    AUDIO_GEN2_EFFECT_MAX_SECONDS, AUDIO_GEN2_WAVES, AUDIO_MIX_UNIT, AUDIO_SFX_TEMPO,
    AUDIO_TICKS_PER_SECOND, AUDIO_WAVES, music_flag, op, sfx_flag,
};

// ---------------------------------------------------------------------------
// Tables (ChipSynth.lua:97-112)
// ---------------------------------------------------------------------------

/// Note -> 11-bit frequency register seed, octave 1 (ChipSynth.lua:97-100).
const PITCHES: [u16; 12] = [
    0xf82c, 0xf89d, 0xf907, 0xf96b, 0xf9ca, 0xfa23, 0xfa77, 0xfac7, 0xfb12, 0xfb58, 0xfb9b, 0xfbda,
];

/// Gen 2 FrequencyTable (ChipSynth.lua@bdfac727:127-135, audio/notes.asm):
/// index 0 = rest, then C_..B_ twice, so a transpose can walk into the next
/// octave without an octave command.
const GEN2_FREQUENCY: [u16; 25] = [
    0x0000, //
    0xf82c, 0xf89d, 0xf907, 0xf96b, 0xf9ca, 0xfa23, 0xfa77, 0xfac7, 0xfb12, 0xfb58, 0xfb9b, 0xfbda,
    0xfc16, 0xfc4e, 0xfc83, 0xfcb5, 0xfce5, 0xfd11, 0xfd3b, 0xfd63, 0xfd89, 0xfdac, 0xfdcd, 0xfded,
];

/// Wave-instrument slots an engine table holds: Gen 1's nine (the tenth only
/// ever repeats the shared sixth) and Gen 2's ten.
const WAVE_SLOTS: usize = if AUDIO_GEN2_WAVES > AUDIO_WAVES {
    AUDIO_GEN2_WAVES
} else {
    AUDIO_WAVES
};

/// Drums per Gen 2 kit, by note pitch: 1..12 name a drum, 0 is the rest the
/// Lua never looks up (`pitch > 0`, ChipSynth.lua@bdfac727:1161).
const GEN2_KIT_DRUMS: usize = 13;

/// LuaGB / DMG 8-step duty tables, index 0-3 (ChipSynth.lua:102-107).
const DUTY_PATTERNS: [[u8; 8]; 4] = [
    [0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 1, 1, 1],
    [0, 1, 1, 1, 1, 1, 1, 0],
];

/// Wave-channel output level, NR32 nibble (ChipSynth.lua:108) — {0, 1, ½, ¼}
/// expressed in mix units per nibble step, so `(nibble - 8) * LEVEL` is the
/// channel's exact value. 480/8 = 60 is level 1.
const WAVE_LEVEL_UNITS: [i32; 4] = [0, 60, 30, 15];

/// NR43 divisor codes (ChipSynth.lua:109-112).
const NOISE_DIVISORS: [u64; 8] = [8, 16, 32, 48, 64, 80, 96, 112];

/// One channel at volume v contributes `v * VOLUME_UNIT` mix units (v/15).
const VOLUME_UNIT: i32 = AUDIO_MIX_UNIT / 15;

/// The engine mix clamps `sum / 4` to -1..1 (ChipSynth.lua:786), which in mix
/// units is a clamp of the undivided sum to +/- 4 * AUDIO_MIX_UNIT.
const MIX_CLAMP: i32 = 4 * AUDIO_MIX_UNIT;

/// A walk that produces no sample ends the channel. DEVIATION from
/// ChipSynth.lua:352 / :572: the Lua can spin forever on a program whose
/// events are all zero-length, and a guest tick may not wedge the console.
const WALK_GUARD: u32 = 100_000;
const EVENT_GUARD: u32 = 4096;

// ---------------------------------------------------------------------------
// Bank access (ChipSynth.lua:175-187)
// ---------------------------------------------------------------------------

/// One byte of a program bank. `bank` is a SLOT: the index of a 0x4000-byte
/// window inside the pak's AUDI programs half, which is the ROM banks
/// concatenated in the manifest's `bankOrder` (voxel-spec.ts §audio). The
/// guest resolves ROM bank numbers to slots; the core never sees a name or a
/// JSON byte.
///
/// The Lua errors on a read outside the window (:179). Here the op stream is
/// untrusted, so a bad read is `None` and ends the channel instead.
fn rom_byte(programs: &[u8], bank: u8, address: u16) -> Option<u8> {
    let within = (address as usize).checked_sub(AUDIO_BANK_SIZE)?;
    if within >= AUDIO_BANK_SIZE {
        return None;
    }
    programs.get(bank as usize * AUDIO_BANK_SIZE + within).copied()
}

fn rom_word(programs: &[u8], bank: u8, address: u16) -> Option<u16> {
    let lo = rom_byte(programs, bank, address)? as u16;
    let hi = rom_byte(programs, bank, address.wrapping_add(1))? as u16;
    Some(lo | (hi << 8))
}

/// ChipSynth.lua:189-203 — the header's first byte carries the channel count
/// in bits 6-7; each 3-byte row is a channel descriptor (low nibble =
/// hardware channel - 1) plus a program pointer.
fn header_channels(programs: &[u8], bank: u8, address: u16) -> Vec<(u8, u16)> {
    let mut out = Vec::new();
    let Some(first) = rom_byte(programs, bank, address) else {
        return out;
    };
    let count = ((first & 0xf0) >> 6) + 1;
    let mut at = address;
    for _ in 0..count {
        let (Some(descriptor), Some(target)) = (
            rom_byte(programs, bank, at),
            rom_word(programs, bank, at.wrapping_add(1)),
        ) else {
            break;
        };
        out.push(((descriptor & 0x0f) + 1, target));
        at = at.wrapping_add(3);
    }
    out
}

/// ChipSynth.lua:205-208 — bit 3 of the fade nibble is the sign.
fn fade_value(nibble: u8) -> i8 {
    if nibble & 8 != 0 {
        -((nibble & 7) as i8)
    } else {
        nibble as i8
    }
}

// ---------------------------------------------------------------------------
// The clocks
// ---------------------------------------------------------------------------

/// ChipSynth.lua:114-116 — program ticks to output samples, rounded half up.
/// The Lua hardcodes 44100 as `(ticks * 1470 + 256) / 512`; that is the same
/// rational as this, since 1470/512 = 44100/15360.
fn snap_ticks(ticks: u64, rate: u32) -> u64 {
    (ticks * rate as u64 + AUDIO_TICKS_PER_SECOND / 2) / AUDIO_TICKS_PER_SECOND
}

/// ChipSynth.lua:596 `math.floor(event.elapsed * 60)`, the 60 Hz index the
/// duty cycle, the pitch slide and the vibrato all step on.
///
/// THIS ONE IS NOT INTEGER, on purpose. The reference computes it in doubles,
/// and the double is not always the exact rational: at rate 44100, sample
/// 90405 is frame 123 exactly, and `(90405/44100)*60` evaluates to
/// 122.99999999999999 — the reference says 122. The ROM's music is timed
/// against the reference's answer, so this reproduces the double. It is not
/// in the per-sample path: [`Channel::frame_next`] caches the crossing and
/// this runs twice per 60 Hz boundary.
fn frame_at(sample: u32, rate: u32) -> u32 {
    ((sample as f64 / rate as f64) * 60.0) as u32
}

/// The first sample index whose [`frame_at`] is past `frame`. Starts from the
/// exact rational and walks the one-sample disagreement out.
fn frame_boundary(frame: u32, rate: u32) -> u32 {
    let mut s = (((frame as u64 + 1) * rate as u64).div_ceil(60)) as u32;
    while s > 0 && frame_at(s - 1, rate) > frame {
        s -= 1;
    }
    while frame_at(s, rate) <= frame {
        s += 1;
    }
    s
}

/// ChipSynth.lua:483-488 — NR12-style envelope: `fade` is the period in
/// 1/64 s per step, its sign the direction. Positive fades DOWN from `volume`
/// toward 0, negative fades UP toward 15; both clamp and hold.
///
/// The reference divides doubles (`elapsed / (|fade| / 64)`); the exact
/// rational below agrees at every sample, because `|fade|/64` is a dyadic and
/// every integer boundary of the quotient lands on a sample index where
/// `sample/rate` is itself exact — so the double division returns the integer
/// exactly. (Checked exhaustively over 8 s at all three AUDIO_RATES.)
fn envelope_volume(volume: u8, fade: i8, sample: u32, rate: u32) -> u8 {
    if fade == 0 {
        return volume;
    }
    let steps = (sample as u64 * 64) / (fade.unsigned_abs() as u64 * rate as u64);
    if fade > 0 {
        volume.saturating_sub(steps.min(255) as u8)
    } else {
        (volume as u64 + steps).min(15) as u8
    }
}

/// ChipSynth.lua:495-507 — one step of the noise LFSR: feed back the XOR of
/// the low two bits into bit 14, and in 7-bit mode into bit 6 as well.
fn clock_lfsr(lfsr: u16, width7: bool) -> u16 {
    let feedback = (lfsr & 1) ^ ((lfsr >> 1) & 1);
    let mut next = (lfsr >> 1) | (feedback << 14);
    if width7 {
        next = (next & !0x40) | (feedback << 6);
    }
    next
}

/// ChipSynth.lua:533-537 — NR10 sweep step: register +/- (register >> shift).
fn sweep_step(register: u16, sweep: Sweep) -> i32 {
    let delta = (register >> sweep.shift) as i32;
    if sweep.subtract {
        register as i32 - delta
    } else {
        register as i32 + delta
    }
}

/// The Q64 phase increment for a tone register (ChipSynth.lua:617-621:
/// `131072 / (2048 - min(register, 2047))`, halved for the wave channel, over
/// the sample rate).
///
/// The frequency is computed as the reference's own DOUBLE, and this is the
/// one place that matters. The exact rational would be more accurate — and
/// measurably wrong: a register like 1920 is 1024 Hz exactly, so the exact
/// phase lands ON a duty boundary every 11025 samples at 44.1 kHz, and there
/// the answer is decided entirely by which side of the true value the step
/// sits. Sharing the reference's step means sharing which side. (Measured:
/// three of Red's 154 programs flipped one sample each without this.)
///
/// The double is then dropped into Q64 with NO rounding — a fraction below 1
/// carries at most 53 significant bits and scaling by a power of two is
/// exact — so the per-sample path stays integer: `phase += step`, wrapping at
/// 1.0, which is the reference's `% 1`.
fn phase_step(register: f64, rate: u32, wave: bool) -> u64 {
    let mut frequency = 131_072.0 / (2048.0 - register.min(2047.0));
    if wave {
        frequency *= 0.5;
    }
    let step = frequency / rate as f64;
    // A whole cycle or more per sample is far above Nyquist; only the
    // fraction is observable, and the reference's own double loses its low
    // bits there anyway.
    ((step % 1.0) * 18_446_744_073_709_551_616.0) as u64
}

/// Advance the Q64 phase by `step`, rounding exactly the way the reference's
/// double does.
///
/// ChipSynth.lua:621 is `self.phase = (phase + frequency / SAMPLE_RATE) % 1`,
/// and both halves of that matter. The sum is rounded to a double BEFORE the
/// wrap, so a sum that crossed 1.0 keeps only 52 fractional bits; and the
/// rounding is what decides the sample where the exact phase lands ON a duty
/// boundary, which for a register like 1920 (1024 Hz exactly) happens on a
/// schedule, not by accident.
///
/// Q64 holds the exact sum, so reproducing the double is a normalize and a
/// round-to-nearest-even — a handful of integer ops. The alternative, a
/// double accumulator, would put soft-float in the per-sample path of a part
/// whose FPU is single-precision.
fn advance_phase(phase: u64, step: u64) -> u64 {
    let (sum, carry) = phase.overflowing_add(step);
    if carry {
        // In [1, 2): 52 fractional bits survive, then `% 1` takes the rest.
        // A round that carries out is the double reaching 2.0, whose `% 1` is
        // 0 — which is exactly what wrapping to 0 gives.
        return round_even(sum, 12);
    }
    if sum == 0 {
        return 0;
    }
    // In [0, 1): the leading one sets the exponent and 52 bits follow it.
    round_even(sum, 64u32.saturating_sub(sum.leading_zeros() + 53))
}

/// Round `v` to nearest, ties to even, dropping its low `drop` bits.
fn round_even(v: u64, drop: u32) -> u64 {
    if drop == 0 {
        return v;
    }
    let mask = (1u64 << drop) - 1;
    let rest = v & mask;
    let half = 1u64 << (drop - 1);
    let kept = v & !mask;
    if rest > half || (rest == half && (kept >> drop) & 1 == 1) {
        return kept.wrapping_add(1u64 << drop);
    }
    kept
}

/// The register the reference's doubles hold for this modulation state — the
/// `key` [`Channel::sample`] computed, unpacked. A non-negative key is the
/// register itself (plain, vibrato, sweep); a negative one is the 60 Hz frame
/// of a running pitch slide, whose register is fractional
/// (ChipSynth.lua:601-602).
fn register_of(key: i64, event: &Event) -> f64 {
    if key >= 0 {
        return key as f64;
    }
    let Some(slide) = event.slide else {
        return event.register as f64;
    };
    let frame = (-1 - key) as f64;
    let amount = (frame / slide.frames).min(1.0);
    let base = event.register as f64;
    base + (slide.target as f64 - base) * amount
}

// ---------------------------------------------------------------------------
// Events (what one channel-program command turns into)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Vibrato {
    delay: u32,
    above: u16,
    below: u16,
    rate: u32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Slide {
    target: u16,
    /// `max(1, duration*60 - length)`, the reference's own double
    /// (ChipSynth.lua:305) — it divides the interpolation, so it is kept in
    /// the arithmetic that produced it.
    frames: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Sweep {
    pace: u8,
    subtract: bool,
    shift: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DrumSeg {
    start: u32,
    end: u32,
    volume: u8,
    fade: i8,
    parameter: u8,
}

/// ChipSynth.lua:406 sets one duty; :416-423 `duty_cycle` sets four, cycled
/// one per 60 Hz frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Duty {
    One(u8),
    Cycle([u8; 4]),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Silence,
    Tone,
    Noise,
    Drum,
}

/// `Copy` on purpose: the event holds no heap data, so the sampling path can
/// take it by value and keep mutating the channel underneath.
#[derive(Clone, Copy, Debug)]
struct Event {
    kind: Kind,
    /// Output samples this event owns, and how many have been consumed.
    samples: u32,
    sample: u32,
    register: u16,
    volume: u8,
    fade: i8,
    duty: Duty,
    wave: bool,
    wave_instrument: u8,
    /// Index into [`WAVE_LEVEL_UNITS`], not the level itself.
    wave_level: u8,
    noise_parameter: u8,
    /// Drum instrument id (`Kind::Drum`), resolved against the engine tables.
    /// Gen 2: the note's pitch inside `drum_kit`.
    drum: u8,
    /// Gen 2 only: the channel's toggle_noise kit when the drum was struck.
    drum_kit: u8,
    /// Lua's `event.drumSegmentIndex`, which starts unset (:555).
    drum_seg: Option<usize>,
    vibrato: Option<Vibrato>,
    slide: Option<Slide>,
    sweep: Option<Sweep>,
    pan_left: bool,
    pan_right: bool,
}

impl Event {
    fn blank(kind: Kind) -> Self {
        Event {
            kind,
            samples: 0,
            sample: 0,
            register: 0,
            volume: 0,
            fade: 0,
            duty: Duty::One(2),
            wave: false,
            wave_instrument: 0,
            wave_level: 1,
            noise_parameter: 0,
            drum: 0,
            drum_kit: 0,
            drum_seg: None,
            vibrato: None,
            slide: None,
            sweep: None,
            // ChipSynth.lua:794 tests `panLeft ~= false`, so an event that
            // states no pan (silence) counts as on — and contributes 0 anyway.
            pan_left: true,
            pan_right: true,
        }
    }
}

// ---------------------------------------------------------------------------
// Engine tables — the wave instruments and drum programs of one sound engine
// ---------------------------------------------------------------------------

/// Where a sound engine's tables live, as the guest resolved them out of the
/// manifest (`audioWaves` / `audioDrum`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Pin {
    set: bool,
    bank: u8,
    address: u16,
}

/// One sound engine's decoded tables (ChipSynth.lua:645-707). Built once per
/// engine and reused; the reference rebuilds them per song (:728-774).
#[derive(Clone, Debug)]
struct EngineTables {
    built: bool,
    has_waves: bool,
    /// 32 four-bit samples per instrument, stored as the reference's
    /// `(nibble - 8)` in -8..7 rather than its -1..1 double. Gen 1 reads
    /// the first AUDIO_WAVES, Gen 2 all AUDIO_GEN2_WAVES.
    waves: [[i8; 32]; WAVE_SLOTS],
    drums: Vec<Vec<DrumSeg>>,
    /// Gen 2: every kit's drums, `kit * GEN2_KIT_DRUMS + pitch`, decoded up
    /// front (ChipSynth.lua@bdfac727:1155 decodes them on first use).
    kits: Vec<Vec<DrumSeg>>,
}

impl Default for EngineTables {
    fn default() -> Self {
        EngineTables {
            built: false,
            has_waves: false,
            waves: [[0i8; 32]; WAVE_SLOTS],
            drums: Vec::new(),
            kits: Vec::new(),
        }
    }
}

impl EngineTables {
    /// A Gen 2 drum. A kit past the six the ROM has is silence; the Lua
    /// would read whatever follows the kit table.
    fn kit_drum(&self, kit: u8, pitch: u8) -> &[DrumSeg] {
        if kit as usize >= AUDIO_GEN2_DRUMKITS || pitch as usize >= GEN2_KIT_DRUMS {
            return &[];
        }
        self.kits
            .get(kit as usize * GEN2_KIT_DRUMS + pitch as usize)
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }
}

/// ChipSynth.lua@bdfac727:1215-1230 readWavesGen2 — Gen 2 WaveSamples: ten
/// 16-byte instruments, no shared tail.
fn read_waves_gen2(programs: &[u8], pin: Pin) -> Option<[[i8; 32]; WAVE_SLOTS]> {
    let mut out = [[0i8; 32]; WAVE_SLOTS];
    for (wave, into) in out.iter_mut().enumerate().take(AUDIO_GEN2_WAVES) {
        for byte_index in 0..16u16 {
            let at = pin
                .address
                .wrapping_add(wave as u16 * 16)
                .wrapping_add(byte_index);
            let packed = rom_byte(programs, pin.bank, at)?;
            into[byte_index as usize * 2] = ((packed >> 4) & 0x0f) as i8 - 8;
            into[byte_index as usize * 2 + 1] = (packed & 0x0f) as i8 - 8;
        }
    }
    Some(out)
}

/// ChipSynth.lua@bdfac727:910-921 — a drum's last segment rings on past its
/// own length for as long as its envelope takes to reach zero:
/// `floor(volume * (fade / 64) * rate + 0.5)` samples, which is exact in
/// integers because fade/64 is a dyadic.
fn extend_drum_envelope(segments: &mut [DrumSeg], rate: u32) {
    let Some(last) = segments.last_mut() else {
        return;
    };
    if last.fade <= 0 || last.volume == 0 {
        return;
    }
    let ring = (last.volume as u64 * last.fade as u64 * rate as u64 + 32) / 64;
    let ring_end = last.start as u64 + ring;
    if ring_end > last.end as u64 {
        last.end = ring_end as u32;
    }
}

/// ChipSynth.lua@bdfac727:1155-1188 drumInstrumentGen2 — Drumkits -> the
/// kit's pointer table -> the drum's noise_note script (ReadNoiseSample):
/// rows of (length, envelope, NR43) until $ff, each lasting
/// `(length & $f) + 1` frames. Unlike Gen 1 no command is rejected.
fn read_drum_gen2(programs: &[u8], pin: Pin, kit: u8, pitch: u8, rate: u32) -> Vec<DrumSeg> {
    let mut segments = Vec::new();
    if pitch == 0 {
        return segments;
    }
    let Some(kit_addr) = rom_word(programs, pin.bank, pin.address.wrapping_add(kit as u16 * 2))
    else {
        return segments;
    };
    let Some(mut address) = rom_word(programs, pin.bank, kit_addr.wrapping_add(pitch as u16 * 2))
    else {
        return segments;
    };
    let mut ticks = 0u64;
    for _ in 0..64 {
        let Some(command) = rom_byte(programs, pin.bank, address) else {
            break;
        };
        address = address.wrapping_add(1);
        if command == 0xff {
            break;
        }
        let (Some(packed), Some(parameter)) = (
            rom_byte(programs, pin.bank, address),
            rom_byte(programs, pin.bank, address.wrapping_add(1)),
        ) else {
            break;
        };
        address = address.wrapping_add(2);
        let duration = ((command & 0x0f) as u64 + 1) * AUDIO_FRAME_TICKS as u64;
        segments.push(DrumSeg {
            start: snap_ticks(ticks, rate) as u32,
            end: snap_ticks(ticks + duration, rate) as u32,
            volume: packed >> 4,
            fade: fade_value(packed & 0x0f),
            parameter,
        });
        ticks += duration;
    }
    extend_drum_envelope(&mut segments, rate);
    segments
}

/// ChipSynth.lua@bdfac727:923-926 drumAudioEnd — the sample the drum's
/// sound stops at (its last segment's end, ring included).
fn drum_audio_end(segments: &[DrumSeg]) -> u32 {
    segments.last().map_or(0, |s| s.end)
}

/// ChipSynth.lua:685-707 — five 16-byte wave instruments, then a sixth that
/// fills slots 6..9 (the ROM's table is short and the driver clamps).
fn read_waves(programs: &[u8], pin: Pin) -> Option<[[i8; 32]; WAVE_SLOTS]> {
    let mut out = [[0i8; 32]; WAVE_SLOTS];
    let read_one = |slot: u16, into: &mut [i8; 32]| -> Option<()> {
        for byte_index in 0..16u16 {
            let at = pin.address.wrapping_add(slot * 16).wrapping_add(byte_index);
            let packed = rom_byte(programs, pin.bank, at)?;
            into[byte_index as usize * 2] = ((packed >> 4) & 0x0f) as i8 - 8;
            into[byte_index as usize * 2 + 1] = (packed & 0x0f) as i8 - 8;
        }
        Some(())
    };
    for wave in 0..5u16 {
        let mut values = [0i8; 32];
        read_one(wave, &mut values)?;
        out[wave as usize] = values;
    }
    let mut shared = [0i8; 32];
    read_one(5, &mut shared)?;
    for slot in out.iter_mut().skip(5) {
        *slot = shared;
    }
    Some(out)
}

/// ChipSynth.lua:645-683 — a drum instrument is its own tiny program of
/// 0x20..0x2F noise commands; decode it once into absolute sample spans.
fn read_drum(programs: &[u8], pin: Pin, rate: u32) -> Vec<DrumSeg> {
    let mut segments = Vec::new();
    let channels = header_channels(programs, pin.bank, pin.address);
    let Some(&(_, first)) = channels.first() else {
        return segments;
    };
    let mut address = first;
    let mut ticks = 0u64;
    for _ in 0..64 {
        let Some(command) = rom_byte(programs, pin.bank, address) else {
            break;
        };
        address = address.wrapping_add(1);
        if command == 0xff {
            break;
        }
        // The Lua errors on any other command (:663); an untrusted pointer
        // stops the instrument instead.
        if !(0x20..0x30).contains(&command) {
            break;
        }
        let (Some(packed), Some(parameter)) = (
            rom_byte(programs, pin.bank, address),
            rom_byte(programs, pin.bank, address.wrapping_add(1)),
        ) else {
            break;
        };
        address = address.wrapping_add(2);
        let duration = ((command & 0x0f) as u64 + 1) * AUDIO_FRAME_TICKS as u64;
        segments.push(DrumSeg {
            start: snap_ticks(ticks, rate) as u32,
            end: snap_ticks(ticks + duration, rate) as u32,
            volume: packed >> 4,
            fade: fade_value(packed & 0x0f),
            parameter,
        });
        ticks += duration;
    }
    segments
}

// ---------------------------------------------------------------------------
// Channel (ChipSynth.lua:210-640)
// ---------------------------------------------------------------------------

/// The engine state a channel command can reach (`tempo`, NR51 `pan`), split
/// out of [`Program`] so one channel can be sampled while it writes them.
#[derive(Clone, Copy, Debug)]
struct EngineState {
    /// :746 — the tempo command's live value; 0x100 is the driver default.
    tempo: u32,
    /// :747 — NR51; 0xFF is "every channel on both sides".
    pan: u8,
    /// Gen 2 SOUND option STEREO (ChipSynth.lua@bdfac727:42 stereoEnabled),
    /// per program: `music_flag::STEREO`. One-shots render mono regardless.
    stereo: bool,
}

#[derive(Clone, Debug)]
struct Channel {
    bank: u8,
    address: u16,
    /// 1..4. The program's own channel index (1..8) only decides this and
    /// `sfx` (:215-216), so it is not kept.
    hardware: u8,
    is_wave: bool,
    is_noise: bool,
    sfx: bool,
    execute_music: bool,
    allow_loops: bool,
    frequency_offset: i32,
    frame_ticks: u32,

    speed: u32,
    volume: u8,
    fade: i8,
    duty: Duty,
    octave: u8,
    wave_instrument: u8,
    wave_level: u8,
    perfect_pitch: bool,
    vibrato: Option<Vibrato>,
    pending_slide: Option<(u8, u16)>,
    sweep: Option<Sweep>,
    call_stack: Vec<u16>,
    /// `sound_loop n`: command address -> iterations left (:437-445).
    loop_counts: Vec<(u16, u8)>,
    event: Option<Event>,
    ended: bool,
    time_ticks: u64,

    /// Oscillator phase, Q64 (wraps at 1.0 — the reference's `% 1`).
    phase: u64,
    /// Phase increment for `step_key`, cached until the register moves. The
    /// register only ever changes on a 60 Hz (slide, vibrato) or 128 Hz
    /// (sweep) boundary, so the frequency is computed ~128 times a second,
    /// never once a sample.
    step: u64,
    step_key: i64,

    noise_lfsr: u16,
    /// The reference's fractional `noiseClock`, as an exact rational
    /// numerator over `divisor * 2^shift * rate`.
    noise_acc: u64,

    /// The 60 Hz frame index of the running event, and the sample it changes.
    frame: u32,
    frame_next: u32,

    /// NR10 sweep, walked incrementally. ChipSynth.lua:539-552 re-runs the
    /// whole iteration from the event's own register on EVERY sample; the
    /// walk is deterministic and monotone in `iterations`, so stepping it
    /// once per new iteration is the same sequence at O(1) per sample.
    sweep_reg: u16,
    sweep_next: i32,
    sweep_iters: u64,
    sweep_seeded: bool,
    sweep_dead: bool,

    /// Gen 2 driver (ChipSynth.lua@bdfac727:316-333). Everything below is
    /// only read when this is set.
    gen2: bool,
    /// CHANNEL_NOTE_LENGTH (note_type / drum_speed), default 1.
    note_length: u8,
    /// SetNoteDuration's fractional-frame carry.
    duration_modifier: u8,
    /// transpose: high nibble octaves, low nibble pitches.
    transposition: u8,
    /// pitch_offset, a signed word added to every note's register.
    pitch_offset: i32,
    /// toggle_noise: the drum kit, and whether noise notes strike drums.
    noise_kit: u8,
    noise_sampling: bool,
    /// set_condition / sound_jump_if.
    condition: u8,
    /// CHANNEL_TRACKS: this channel's NR51 bits.
    tracks: u8,
    /// The last stereo_panning byte, kept while MONO (:329-331).
    stereo_panning: Option<u8>,
    /// force_stereo_panning ($e4) pans whatever the SOUND option says.
    force_panning: bool,
    /// The drum still ringing after its note ended (:1017-1019).
    drum_tail: Option<Event>,
}

impl Channel {
    /// ChipSynth.lua:213-250 Channel.new.
    fn new(bank: u8, number: u8, address: u16, opts: &ProgramOpts, frame_ticks: u32) -> Self {
        let hardware = (number - 1) % 4 + 1;
        let sfx = number > 4;
        Channel {
            bank,
            address,
            hardware,
            is_wave: hardware == 3,
            is_noise: hardware == 4,
            sfx,
            execute_music: !sfx,
            allow_loops: opts.allow_loops,
            frequency_offset: opts.frequency_offset,
            frame_ticks,
            speed: 12,
            volume: 12,
            fade: 0,
            duty: Duty::One(2),
            octave: 4,
            wave_instrument: 0,
            wave_level: 1,
            perfect_pitch: false,
            vibrato: None,
            pending_slide: None,
            sweep: None,
            call_stack: Vec::new(),
            loop_counts: Vec::new(),
            event: None,
            ended: false,
            time_ticks: 0,
            phase: 0,
            step: 0,
            step_key: i64::MIN,
            noise_lfsr: 0x7fff,
            noise_acc: 0,
            frame: 0,
            frame_next: 0,
            sweep_reg: 0,
            sweep_next: 0,
            sweep_iters: 0,
            sweep_seeded: false,
            sweep_dead: false,
            gen2: opts.gen2,
            note_length: 1,
            duration_modifier: 0,
            transposition: 0,
            pitch_offset: 0,
            noise_kit: 0,
            noise_sampling: false,
            condition: 0,
            // ChipSynth.lua@bdfac727:299-301 — MonoTracks: $11/$22/$44/$88
            tracks: Self::default_tracks(hardware),
            stereo_panning: None,
            force_panning: false,
            drum_tail: None,
        }
    }

    /// This hardware channel's bit on both sides of NR51.
    fn default_tracks(hardware: u8) -> u8 {
        let mask = 1u8 << (hardware - 1);
        (mask << 4) | mask
    }

    fn byte(&mut self, programs: &[u8]) -> Option<u8> {
        let value = rom_byte(programs, self.bank, self.address)?;
        self.address = self.address.wrapping_add(1);
        Some(value)
    }

    fn word(&mut self, programs: &[u8]) -> Option<u16> {
        let value = rom_word(programs, self.bank, self.address)?;
        self.address = self.address.wrapping_add(2);
        Some(value)
    }

    /// ChipSynth.lua:264-270 — the pitch table holds 16-bit two's-complement
    /// seeds; the octave shifts them arithmetically right.
    ///
    /// The note is clamped to the table's 12 entries: the reference indexes it
    /// raw and a `pitch_slide` naming note 12..15 would be a Lua error, which
    /// is not an answer an untrusted op stream may get.
    fn frequency(&self, note: u8, octave: Option<i32>) -> u16 {
        let signed = PITCHES[(note & 0x0f).min(11) as usize] as i32 - 0x10000;
        let shift = (octave.unwrap_or(self.octave as i32) - 1).clamp(0, 31);
        let mut register = ((signed >> shift) & 0x7ff) as u16;
        if self.perfect_pitch {
            register = (register + 1) & 0x7ff;
        }
        ((register as i32 + self.frequency_offset) & 0x7ff) as u16
    }

    /// ChipSynth.lua:272-277 — an SFX counts its own frameTicks and only
    /// honors `speed` while executeMusic is on; music multiplies by the
    /// engine tempo.
    fn duration_ticks(&self, length: u32, st: &EngineState) -> u64 {
        let tempo = if self.sfx { self.frame_ticks } else { st.tempo };
        let speed = if self.sfx && !self.execute_music {
            1
        } else {
            self.speed
        };
        length as u64 * speed as u64 * tempo as u64
    }

    /// ChipSynth.lua:279-287 — the event's sample span is the DIFFERENCE of
    /// two snapped tick totals, so rounding never accumulates across a song.
    fn timed(&mut self, mut event: Event, ticks: u64, rate: u32) -> Event {
        let first = snap_ticks(self.time_ticks, rate);
        self.time_ticks += ticks;
        event.samples = (snap_ticks(self.time_ticks, rate) - first) as u32;
        event.sample = 0;
        event
    }

    /// ChipSynth.lua:289-293 — NR51: high nibble left, low nibble right.
    /// Gen 2 (ChipSynth.lua@bdfac727:438-442) reads the channel's own
    /// CHANNEL_TRACKS instead of one engine-wide NR51.
    fn pan(&self, st: &EngineState) -> (bool, bool) {
        let mask = 1u8 << (self.hardware - 1);
        if self.gen2 {
            return ((self.tracks >> 4) & mask != 0, self.tracks & mask != 0);
        }
        ((st.pan >> 4) & mask != 0, st.pan & mask != 0)
    }

    /// ChipSynth.lua@bdfac727:449-459 applyStereoMix — recompute the tracks
    /// from the remembered panning byte and the live STEREO flag;
    /// force_stereo_panning stays put.
    fn apply_stereo_mix(&mut self, stereo: bool) {
        let default = Self::default_tracks(self.hardware);
        if self.force_panning {
            return;
        }
        self.tracks = match self.stereo_panning {
            Some(packed) if stereo => packed & default,
            _ => default,
        };
    }

    /// ChipSynth.lua@bdfac727:373-387 frequencyGen2 (pokegold GetFrequency):
    /// FrequencyTable[pitch + transpose], shifted right arithmetically once
    /// per octave below 7, then pitch_offset and the caller's modifier, each
    /// wrapped to 11 bits. A pitch past the table reads 0, as `or 0` does.
    fn frequency_gen2(&self, note: u8, octave: Option<i32>) -> u16 {
        let trans = self.transposition as i32;
        let pitch = note as i32 + (trans & 0x0f);
        let oct = octave.unwrap_or(self.octave as i32) + (trans >> 4);
        let table = GEN2_FREQUENCY.get(pitch as usize).copied().unwrap_or(0) as i32;
        let signed = table - 0x10000;
        let shifts = (7 - oct).max(0);
        let mut register = (signed >> shifts) & 0x7ff;
        register = (register + self.pitch_offset) & 0x7ff;
        ((register + self.frequency_offset) & 0x7ff) as u16
    }

    /// ChipSynth.lua@bdfac727:397-424 durationTicksGen2 — SetNoteDuration's
    /// two eight-bit multiplies, both throwing their overflow away:
    ///   low     = LOW((length + 1) * NoteLength)
    ///   product = LOW16(tempo * low + DurationModifier)
    ///   frames  = HIGH(product), at least 1; the low byte carries over.
    /// An SFX or cry channel (not toggled into music mode) counts its own
    /// frame tempo; everything else the engine's tempo command.
    fn duration_ticks_gen2(&mut self, length: u32, st: &EngineState) -> u64 {
        let tempo = if self.sfx && !self.execute_music {
            self.frame_ticks
        } else {
            st.tempo
        };
        let low = ((length + 1) * self.note_length as u32) & 0xff;
        let product = (tempo.wrapping_mul(low) + self.duration_modifier as u32) & 0xffff;
        self.duration_modifier = (product & 0xff) as u8;
        let frames = (product >> 8).max(1);
        frames as u64 * AUDIO_FRAME_TICKS as u64
    }

    /// ChipSynth.lua@bdfac727:491-500 noiseEvent.
    fn noise_event(&mut self, ticks: u64, volume: u8, fade: i8, parameter: u8, st: &EngineState, rate: u32) -> Event {
        let mut event = Event::blank(Kind::Noise);
        event.volume = volume;
        event.fade = fade;
        event.noise_parameter = parameter;
        let (l, r) = self.pan(st);
        event.pan_left = l;
        event.pan_right = r;
        self.timed(event, ticks, rate)
    }

    /// ChipSynth.lua@bdfac727:680-900 nextEventGen2 — Gold's channel-program
    /// interpreter (pokegold macros/scripts/audio.asm, FIRST_MUSIC_CMD $d0).
    /// Notes pack like Gen 1's but pitch 0 is the rest; call and loop are
    /// swapped against Gen 1 ($fe call, $fd loop) and $fc is sound_jump.
    fn next_event_gen2(&mut self, st: &mut EngineState, programs: &[u8], rate: u32) -> Option<Event> {
        if self.ended {
            return None;
        }
        for _ in 0..WALK_GUARD {
            let command_address = self.address;
            let Some(command) = self.byte(programs) else {
                self.ended = true;
                return None;
            };

            if command < 0xd0 && self.sfx && !self.execute_music {
                // :686-711 ParseSFXOrCry — a square_note / noise_note row: the
                // WHOLE byte is the length handed to SetNoteDuration, then the
                // envelope, then the raw register (two bytes) or NR43 (one).
                let ticks = self.duration_ticks_gen2(command as u32, st);
                let packed = self.byte(programs)?;
                let volume = packed >> 4;
                let fade = fade_value(packed & 0x0f);
                if self.is_noise {
                    let parameter = ((self.byte(programs)? as i32 + self.frequency_offset) & 0xff) as u8;
                    return Some(self.noise_event(ticks, volume, fade, parameter, st, rate));
                }
                // :706-710 — the cry pitch / SFX modifier is a 16-bit add of
                // which 11 bits reach the register.
                let word = self.word(programs)? as i32;
                let register = ((word + self.frequency_offset) & 0x7ff) as u16;
                return Some(self.tone(ticks, register, Some(volume), Some(fade), st, rate));
            } else if command < 0xd0 {
                // :712-725 — a note: pitch (0 = rest) and length - 1
                let note = command >> 4;
                let length = (command & 0x0f) as u32;
                let ticks = self.duration_ticks_gen2(length, st);
                if note == 0 || (self.is_noise && !self.noise_sampling) {
                    let e = Event::blank(Kind::Silence);
                    return Some(self.timed(e, ticks, rate));
                }
                if self.is_noise {
                    // :502-516 drumEvent — the note names a drum of the kit
                    let mut event = Event::blank(Kind::Drum);
                    event.drum = note;
                    event.drum_kit = self.noise_kit;
                    let (l, r) = self.pan(st);
                    event.pan_left = l;
                    event.pan_right = r;
                    return Some(self.timed(event, ticks, rate));
                }
                let register = self.frequency_gen2(note, None);
                return Some(self.tone(ticks, register, None, None, st, rate));
            }
            match command {
                // :726-728 octave: $d0 = octave 8 (stored 0) .. $d7 = 1 (7)
                0xd0..=0xd7 => self.octave = command & 7,
                0xd8 => {
                    // :729-740 note_type / drum_speed
                    self.note_length = self.byte(programs)?;
                    if !self.is_noise {
                        let packed = self.byte(programs)?;
                        self.set_envelope(packed);
                    }
                }
                0xd9 => self.transposition = self.byte(programs)?, // :741-742
                0xda => {
                    // :743-748 tempo, big-endian; resets this channel's carry
                    let hi = self.byte(programs)? as u32;
                    let lo = self.byte(programs)? as u32;
                    st.tempo = hi * 0x100 + lo;
                    self.duration_modifier = 0;
                }
                0xdb => self.duty = Duty::One(self.byte(programs)? & 3), // :749-750
                0xdc => {
                    let packed = self.byte(programs)?; // :751-759 volume_envelope
                    self.set_envelope(packed);
                }
                0xdd => {
                    // :760-766 pitch_sweep
                    let packed = self.byte(programs)?;
                    self.sweep = Some(Sweep {
                        pace: (packed >> 4) & 7,
                        subtract: packed & 8 != 0,
                        shift: packed & 7,
                    });
                }
                0xde => {
                    // :767-774 duty_cycle_pattern: one duty per 60 Hz frame
                    let packed = self.byte(programs)?;
                    self.duty = Duty::Cycle([
                        (packed >> 6) & 3,
                        (packed >> 4) & 3,
                        (packed >> 2) & 3,
                        packed & 3,
                    ]);
                }
                0xdf => self.execute_music = !self.execute_music, // :775-776 toggle_sfx
                0xe0 => {
                    // :777-783 pitch_slide: lead-in length, then octave + note
                    let length = self.byte(programs)?;
                    let packed = self.byte(programs)?;
                    let target = self.frequency_gen2(packed & 0x0f, Some((packed >> 4) as i32));
                    self.pending_slide = Some((length, target));
                }
                0xe1 => {
                    // :784-796 vibrato
                    let delay = self.byte(programs)?;
                    let packed = self.byte(programs)?;
                    let depth = (packed >> 4) as u16;
                    self.vibrato = if depth == 0 {
                        None
                    } else {
                        Some(Vibrato {
                            delay: delay as u32,
                            above: (depth >> 1) + (depth & 1),
                            below: depth >> 1,
                            rate: (packed & 0x0f) as u32,
                        })
                    };
                }
                // :797-798 unknownmusic0xe2; :813-814 volume (master, not
                // mixed); :820-821 unused
                0xe2 | 0xe5 | 0xe7 | 0xe8 => {
                    self.byte(programs)?;
                }
                // :799-805 toggle_noise, :846-852 sfx_toggle_noise — turning
                // it ON reads the kit; turning it off reads nothing
                0xe3 | 0xf0 => {
                    if self.noise_sampling {
                        self.noise_sampling = false;
                    } else {
                        self.noise_sampling = true;
                        self.noise_kit = self.byte(programs)?;
                    }
                }
                0xe4 => {
                    // :806-812 force_stereo_panning
                    let packed = self.byte(programs)?;
                    self.tracks = packed & Self::default_tracks(self.hardware);
                    self.force_panning = true;
                }
                0xe6 => {
                    // :815-819 pitch_offset, a signed big-endian word
                    let hi = self.byte(programs)? as i32;
                    let lo = self.byte(programs)? as i32;
                    let value = hi * 0x100 + lo;
                    self.pitch_offset = if value >= 0x8000 { value - 0x10000 } else { value };
                }
                0xe9 => {
                    // :822-825 tempo_relative
                    let adj = self.byte(programs)? as i8 as i32;
                    st.tempo = ((st.tempo as i32 + adj) & 0xffff) as u32;
                }
                0xea => self.address = self.word(programs)?, // :826-827 restart_channel
                // :828-829 new_song, :832-833 unknownmusic0xee
                0xeb | 0xee => {
                    self.word(programs)?;
                }
                // :830-831 sfx_priority_on/off; :853-854 $f1-$f9: no params
                0xec | 0xed | 0xf1..=0xf9 => {}
                0xef => {
                    // :834-845 stereo_panning: applied only under STEREO, the
                    // byte kept either way
                    let packed = self.byte(programs)?;
                    self.stereo_panning = Some(packed);
                    self.force_panning = false;
                    if st.stereo {
                        self.tracks = packed & Self::default_tracks(self.hardware);
                    }
                }
                0xfa => self.condition = self.byte(programs)?, // :855-856 set_condition
                0xfb => {
                    // :857-859 sound_jump_if
                    let want = self.byte(programs)?;
                    let target = self.word(programs)?;
                    if self.condition == want {
                        self.address = target;
                    }
                }
                0xfc => self.address = self.word(programs)?, // :860-861 sound_jump
                0xfd => {
                    // :862-881 sound_loop: count 0 = forever, else n-1 more
                    let count = self.byte(programs)?;
                    let target = self.word(programs)?;
                    if !self.sound_loop(command_address, count, target) {
                        return None;
                    }
                }
                0xfe => {
                    // :882-884 sound_call — the return address is past the
                    // pointer
                    let ret = self.address.wrapping_add(2);
                    self.call_stack.push(ret);
                    self.address = self.word(programs)?;
                }
                _ => {
                    // 0xff, :885-892 sound_ret — an empty stack ends the channel
                    match self.call_stack.pop() {
                        Some(ret) => self.address = ret,
                        None => {
                            self.ended = true;
                            return None;
                        }
                    }
                }
            }
        }
        self.ended = true; // :898-899
        None
    }

    /// note_type / volume_envelope's packed byte: the wave channel's output
    /// level + instrument, or a pulse's volume + fade
    /// (ChipSynth.lua@bdfac727:733-739, :753-758).
    fn set_envelope(&mut self, packed: u8) {
        if self.is_wave {
            self.wave_level = (packed >> 4) & 3;
            self.wave_instrument = packed & 0x0f;
        } else {
            self.volume = packed >> 4;
            self.fade = fade_value(packed & 0x0f);
        }
    }

    /// sound_loop's bookkeeping (ChipSynth.lua@bdfac727:862-881, the same
    /// rule as Gen 1's :427-446). False when a `sound_loop 0` ended a
    /// channel that may not loop.
    fn sound_loop(&mut self, command_address: u16, count: u8, target: u16) -> bool {
        if count == 0 {
            if self.allow_loops {
                self.address = target;
                return true;
            }
            self.ended = true;
            return false;
        }
        let slot = self.loop_counts.iter().position(|&(a, _)| a == command_address);
        let remaining = match slot {
            Some(i) => self.loop_counts[i].1,
            None => count,
        }
        .saturating_sub(1);
        if remaining > 0 {
            match slot {
                Some(i) => self.loop_counts[i].1 = remaining,
                None => self.loop_counts.push((command_address, remaining)),
            }
            self.address = target;
        } else if let Some(i) = slot {
            self.loop_counts.swap_remove(i);
        }
        true
    }

    /// ChipSynth.lua:295-323 tone.
    fn tone(
        &mut self,
        ticks: u64,
        register: u16,
        volume: Option<u8>,
        fade: Option<i8>,
        st: &EngineState,
        rate: u32,
    ) -> Event {
        if register >= 0x800 {
            let e = Event::blank(Kind::Silence);
            return self.timed(e, ticks, rate);
        }
        let mut event = Event::blank(Kind::Tone);
        if let Some((length, target)) = self.pending_slide.take() {
            // :303-307 — the slide spans the event minus its lead-in frames.
            let duration = ticks as f64 / AUDIO_TICKS_PER_SECOND as f64;
            event.slide = Some(Slide {
                target,
                frames: (duration * 60.0 - length as f64).max(1.0),
            });
        }
        event.register = register;
        event.volume = volume.unwrap_or(self.volume);
        event.fade = fade.unwrap_or(self.fade);
        event.duty = self.duty;
        event.wave = self.is_wave;
        event.wave_instrument = self.wave_instrument;
        event.wave_level = self.wave_level;
        // :317 reads `slide and nil or self.vibrato`, which in Lua collapses
        // to self.vibrato either way; the slide branch already wins at sample
        // time (:600 elseif), so this states that behavior plainly.
        event.vibrato = self.vibrato;
        // :319 — only an SFX on hardware channel 1 carries a sweep.
        event.sweep = if self.sfx && self.hardware == 1 {
            self.sweep
        } else {
            None
        };
        let (l, r) = self.pan(st);
        event.pan_left = l;
        event.pan_right = r;
        self.timed(event, ticks, rate)
    }

    /// ChipSynth.lua:350-481 nextEvent — the channel-program interpreter.
    /// Runs state-only commands until one produces an event, or the program
    /// ends.
    fn next_event(&mut self, st: &mut EngineState, programs: &[u8], rate: u32) -> Option<Event> {
        if self.gen2 {
            // ChipSynth.lua@bdfac727:523-525
            return self.next_event_gen2(st, programs, rate);
        }
        if self.ended {
            return None;
        }
        for _ in 0..WALK_GUARD {
            let command_address = self.address;
            let Some(command) = self.byte(programs) else {
                self.ended = true;
                return None;
            };

            if (self.execute_music || !self.sfx) && command < 0xc0 {
                // :356-364 — note: high nibble = pitch, low nibble = length-1
                let note = command >> 4;
                let length = (command & 0x0f) as u32 + 1;
                let ticks = self.duration_ticks(length, st);
                if self.is_noise {
                    let mut instrument = note;
                    if command >= 0xb0 {
                        instrument = self.byte(programs)?;
                    }
                    // :336-344 drumEvent — a music noise note names a kit.
                    let mut event = Event::blank(Kind::Drum);
                    event.drum = instrument;
                    let (l, r) = self.pan(st);
                    event.pan_left = l;
                    event.pan_right = r;
                    return Some(self.timed(event, ticks, rate));
                }
                let register = self.frequency(note, None);
                return Some(self.tone(ticks, register, None, None, st, rate));
            } else if (0xc0..0xd0).contains(&command) {
                // :365-367
                let ticks = self.duration_ticks((command & 0x0f) as u32 + 1, st);
                let e = Event::blank(Kind::Silence);
                return Some(self.timed(e, ticks, rate));
            } else if (0xd0..0xe0).contains(&command) {
                // :368-379 note_type: speed, then a packed volume/fade (or the
                // wave channel's output level + instrument)
                self.speed = (command & 0x0f) as u32;
                if !self.is_noise {
                    let packed = self.byte(programs)?;
                    if self.is_wave {
                        self.wave_level = (packed >> 4) & 3;
                        self.wave_instrument = packed & 0x0f;
                    } else {
                        self.volume = packed >> 4;
                        self.fade = fade_value(packed & 0x0f);
                    }
                }
            } else if (0xe0..=0xe7).contains(&command) {
                self.octave = 8 - (command & 7); // :380-381
            } else if command == 0xe8 {
                self.perfect_pitch = !self.perfect_pitch; // :382-383
            } else if command == 0xe9 {
                // :384-385 unused command
            } else if command == 0xea {
                // :386-398 vibrato: delay frames, then depth (split
                // above/below) + rate
                let delay = self.byte(programs)?;
                let packed = self.byte(programs)?;
                let depth = (packed >> 4) as u16;
                self.vibrato = if depth == 0 {
                    None
                } else {
                    Some(Vibrato {
                        delay: delay as u32,
                        above: (depth >> 1) + (depth & 1),
                        below: depth >> 1,
                        rate: (packed & 0x0f) as u32,
                    })
                };
            } else if command == 0xeb {
                // :399-405 pitch slide: lead-in length, then target octave+note
                let length = self.byte(programs)?;
                let packed = self.byte(programs)?;
                let octave = 8 - (packed >> 4) as i32;
                let target = self.frequency(packed & 0x0f, Some(octave));
                self.pending_slide = Some((length, target));
            } else if command == 0xec {
                self.duty = Duty::One(self.byte(programs)? & 3); // :406-407
            } else if command == 0xed {
                // :408-409
                let hi = self.byte(programs)? as u32;
                let lo = self.byte(programs)? as u32;
                st.tempo = hi * 0x100 + lo;
            } else if command == 0xee {
                st.pan = self.byte(programs)?; // :410-411
            } else if command == 0xef || command == 0xf0 {
                self.byte(programs)?; // :412-413 one-arg commands this ignores
            } else if command == 0xf8 {
                self.execute_music = !self.execute_music; // :414-415
            } else if command == 0xfc {
                // :416-423 duty_cycle: four 2-bit duties, one per frame
                let packed = self.byte(programs)?;
                self.duty = Duty::Cycle([
                    (packed >> 6) & 3,
                    (packed >> 4) & 3,
                    (packed >> 2) & 3,
                    packed & 3,
                ]);
            } else if command == 0xfd {
                // :424-426 sound_call — the return address is past the pointer
                let ret = self.address.wrapping_add(2);
                self.call_stack.push(ret);
                self.address = self.word(programs)?;
            } else if command == 0xfe {
                // :427-446 sound_loop: count 0 = forever, else n-1 more passes
                let count = self.byte(programs)?;
                let target = self.word(programs)?;
                if count == 0 {
                    if self.allow_loops {
                        self.address = target;
                    } else {
                        self.ended = true;
                        return None;
                    }
                } else {
                    let slot = self.loop_counts.iter().position(|&(a, _)| a == command_address);
                    let remaining = match slot {
                        Some(i) => self.loop_counts[i].1,
                        None => count,
                    }
                    .saturating_sub(1);
                    if remaining > 0 {
                        match slot {
                            Some(i) => self.loop_counts[i].1 = remaining,
                            None => self.loop_counts.push((command_address, remaining)),
                        }
                        self.address = target;
                    } else if let Some(i) = slot {
                        self.loop_counts.swap_remove(i);
                    }
                }
            } else if command == 0xff {
                // :447-454 sound_ret — an empty call stack ends the channel
                match self.call_stack.pop() {
                    Some(ret) => self.address = ret,
                    None => {
                        self.ended = true;
                        return None;
                    }
                }
            } else if self.sfx && (0x20..0x30).contains(&command) {
                // :455-466 — the SFX note form: length, packed volume/fade,
                // then a noise parameter or a literal 11-bit frequency word
                let length = (command & 0x0f) as u32 + 1;
                let packed = self.byte(programs)?;
                let volume = packed >> 4;
                let fade = fade_value(packed & 0x0f);
                let ticks = self.duration_ticks(length, st);
                if self.is_noise {
                    let parameter = self.byte(programs)?;
                    // :325-334 noiseEvent
                    let mut event = Event::blank(Kind::Noise);
                    event.volume = volume;
                    event.fade = fade;
                    event.noise_parameter = parameter;
                    let (l, r) = self.pan(st);
                    event.pan_left = l;
                    event.pan_right = r;
                    return Some(self.timed(event, ticks, rate));
                }
                let word = self.word(programs)? as i32;
                let register = ((word + self.frequency_offset) & 0x7ff) as u16;
                return Some(self.tone(ticks, register, Some(volume), Some(fade), st, rate));
            } else if command == 0x10 {
                // :467-473 execute_music-off sweep (NR10)
                let packed = self.byte(programs)?;
                self.sweep = Some(Sweep {
                    pace: (packed >> 4) & 7,
                    subtract: packed & 8 != 0,
                    shift: packed & 7,
                });
            } else {
                self.ended = true; // :474-477 unknown command ends the channel
                return None;
            }
        }
        self.ended = true; // :479-480
        None
    }

    /// ChipSynth.lua:490-493.
    fn reset_noise(&mut self) {
        self.noise_lfsr = 0x7fff;
        self.noise_acc = 0;
    }

    /// ChipSynth.lua:509-531 — advance the LFSR by however many of its clocks
    /// fit in one output sample, then read it. The reference carries the
    /// fraction in a double; this carries the same fraction as an exact
    /// numerator over `divisor * 2^shift * rate`, so the clock rate is exact
    /// forever instead of nearly exact. shift >= 14 is the hardware's
    /// "stopped" encoding: the register holds.
    fn sample_noise(&mut self, parameter: u8, rate: u32) -> i32 {
        let shift = parameter >> 4;
        if shift < 14 {
            let divisor = NOISE_DIVISORS[(parameter & 7) as usize];
            let period = (divisor << shift) * rate as u64;
            let width7 = parameter & 8 != 0;
            self.noise_acc += AUDIO_GB_CLOCK;
            while self.noise_acc >= period {
                self.noise_acc -= period;
                self.noise_lfsr = clock_lfsr(self.noise_lfsr, width7);
            }
        }
        // :529-530 LuaGB: instantaneous inverted LFSR LSB (high when bit0 = 0)
        if self.noise_lfsr & 1 == 0 { 1 } else { -1 }
    }

    /// ChipSynth.lua:554-569 — a drum instrument is a list of noise segments
    /// with their own envelopes; the LFSR resets at every segment boundary.
    fn sample_drum(&mut self, sample_index: u32, segments: &[DrumSeg], rate: u32) -> i32 {
        // :555 — the stored index starts UNSET, so the first segment is a
        // change and resets the noise register too.
        let stored = self.event.and_then(|e| e.drum_seg);
        let mut index = stored.unwrap_or(0);
        while segments.get(index).is_some_and(|s| sample_index >= s.end) {
            index += 1;
        }
        let Some(segment) = segments.get(index).copied() else {
            return 0;
        };
        if sample_index < segment.start {
            return 0;
        }
        if stored != Some(index) {
            if let Some(event) = self.event.as_mut() {
                event.drum_seg = Some(index);
            }
            self.reset_noise();
        }
        let volume = envelope_volume(
            segment.volume,
            segment.fade,
            sample_index - segment.start,
            rate,
        );
        self.sample_noise(segment.parameter, rate) * volume as i32 * VOLUME_UNIT
    }

    /// The running event's swept register, or `None` when the sweep
    /// overflowed (ChipSynth.lua:539-552: the hardware kills the channel).
    fn swept(&mut self, register: u16, sweep: Sweep, sample: u32, rate: u32) -> Option<u16> {
        if sweep.shift == 0 {
            return Some(register);
        }
        if self.sweep_dead {
            return None;
        }
        if !self.sweep_seeded {
            // First look at this event: seed the walk (:541-542).
            self.sweep_seeded = true;
            self.sweep_reg = register;
            self.sweep_next = sweep_step(register, sweep);
            if !(0..=0x7ff).contains(&self.sweep_next) {
                self.sweep_dead = true;
                return None;
            }
        }
        if sweep.pace == 0 {
            return Some(register); // :543 — loaded but never stepped
        }
        let want = (sample as u64 * 128) / (rate as u64 * sweep.pace as u64);
        while self.sweep_iters < want {
            self.sweep_iters += 1;
            self.sweep_reg = self.sweep_next as u16;
            self.sweep_next = sweep_step(self.sweep_reg, sweep);
            if !(0..=0x7ff).contains(&self.sweep_next) {
                self.sweep_dead = true;
                return None;
            }
        }
        Some(self.sweep_reg)
    }

    /// ChipSynth.lua:571-640 — one output sample from this channel, in mix
    /// units (`AUDIO_MIX_UNIT` = full scale).
    fn sample(
        &mut self,
        st: &mut EngineState,
        tables: &EngineTables,
        programs: &[u8],
        rate: u32,
    ) -> i32 {
        if self.gen2 {
            return self.sample_gen2(st, tables, programs, rate);
        }
        // :572-577, bounded (see WALK_GUARD).
        let mut guard = 0;
        while !self.ended
            && self
                .event
                .as_ref()
                .is_none_or(|e| e.sample >= e.samples)
        {
            self.event = self.next_event(st, programs, rate);
            self.phase = 0;
            self.step_key = i64::MIN;
            self.frame = 0;
            self.frame_next = frame_boundary(0, rate);
            self.sweep_reg = 0;
            self.sweep_next = 0;
            self.sweep_iters = 0;
            self.sweep_seeded = false;
            self.sweep_dead = false;
            self.reset_noise();
            guard += 1;
            if guard >= EVENT_GUARD {
                self.ended = true;
            }
        }
        let Some(event) = self.event else {
            return 0;
        };
        let sample_index = event.sample;
        if let Some(live) = self.event.as_mut() {
            live.sample = sample_index + 1;
        }

        match event.kind {
            Kind::Silence => return 0,
            Kind::Drum => {
                let segments = tables
                    .drums
                    .get(event.drum as usize)
                    .map(Vec::as_slice)
                    .unwrap_or(&[]);
                return self.sample_drum(sample_index, segments, rate);
            }
            Kind::Noise => {
                let volume = envelope_volume(event.volume, event.fade, sample_index, rate);
                return self.sample_noise(event.noise_parameter, rate)
                    * volume as i32
                    * VOLUME_UNIT;
            }
            Kind::Tone => {}
        }
        self.sample_tone(event, sample_index, tables, rate)
    }

    /// Reset what a new event starts from (ChipSynth.lua:573-576 and the
    /// Rust port's cached modulation state) — everything but the noise
    /// register, which the two drivers treat differently.
    fn start_event(&mut self, rate: u32) {
        self.phase = 0;
        self.step_key = i64::MIN;
        self.frame = 0;
        self.frame_next = frame_boundary(0, rate);
        self.sweep_reg = 0;
        self.sweep_next = 0;
        self.sweep_iters = 0;
        self.sweep_seeded = false;
        self.sweep_dead = false;
    }

    /// ChipSynth.lua@bdfac727:1008-1108 sample(), as the Gen 2 driver runs
    /// it: the Gen 1 port's sample plus the drum tail. A drum whose sound
    /// outlasts its note keeps ringing through the rests after it, with its
    /// noise register running on, until another note or its own end.
    fn sample_gen2(
        &mut self,
        st: &mut EngineState,
        tables: &EngineTables,
        programs: &[u8],
        rate: u32,
    ) -> i32 {
        // :1009-1024, bounded (see WALK_GUARD).
        let mut guard = 0;
        while !self.ended
            && self
                .event
                .as_ref()
                .is_none_or(|e| e.sample >= e.samples)
        {
            let prev = self.event;
            self.event = self.next_event(st, programs, rate);
            self.start_event(rate);
            let next = self.event.map(|e| e.kind);
            if next == Some(Kind::Drum) {
                // :1014-1016
                self.drum_tail = None;
                self.reset_noise();
            } else if let Some(p) = prev.filter(|p| {
                p.kind == Kind::Drum && p.sample < drum_audio_end(tables.kit_drum(p.drum_kit, p.drum))
            }) {
                // :1017-1019 — the drum outlasted its note
                self.drum_tail = Some(p);
            } else if !(next == Some(Kind::Silence) && self.drum_tail.is_some()) {
                // :1020-1022
                self.drum_tail = None;
                self.reset_noise();
            }
            guard += 1;
            if guard >= EVENT_GUARD {
                self.ended = true;
            }
        }
        let Some(event) = self.event else {
            return self.sample_tail(tables, rate); // :1027-1037
        };
        let sample_index = event.sample;
        if let Some(live) = self.event.as_mut() {
            live.sample = sample_index + 1;
        }
        match event.kind {
            Kind::Silence => return self.sample_tail(tables, rate), // :1041-1051
            Kind::Drum => {
                // :1052-1054
                let segments = tables.kit_drum(event.drum_kit, event.drum);
                let mut seg = event.drum_seg;
                let v = self.sample_drum_at(&mut seg, sample_index, segments, rate);
                if let Some(live) = self.event.as_mut() {
                    live.drum_seg = seg;
                }
                return v;
            }
            Kind::Noise | Kind::Tone => {}
        }
        self.drum_tail = None; // :1055
        if event.kind == Kind::Noise {
            let volume = envelope_volume(event.volume, event.fade, sample_index, rate);
            return self.sample_noise(event.noise_parameter, rate) * volume as i32 * VOLUME_UNIT;
        }
        self.sample_tone(event, sample_index, tables, rate)
    }

    /// One sample of the ringing drum tail, if any (ChipSynth.lua@bdfac727
    /// :1028-1036): the tail keeps its own sample counter and segment.
    fn sample_tail(&mut self, tables: &EngineTables, rate: u32) -> i32 {
        let Some(mut tail) = self.drum_tail.take() else {
            return 0;
        };
        let segments = tables.kit_drum(tail.drum_kit, tail.drum);
        let index = tail.sample;
        tail.sample = index + 1;
        if index >= drum_audio_end(segments) {
            return 0; // the tail is done and stays dropped
        }
        let mut seg = tail.drum_seg;
        let v = self.sample_drum_at(&mut seg, index, segments, rate);
        tail.drum_seg = seg;
        self.drum_tail = Some(tail);
        v
    }

    /// ChipSynth.lua@bdfac727:991-1006 sampleDrum, over an explicit segment
    /// cursor so the running event and the ringing tail can each keep one.
    fn sample_drum_at(
        &mut self,
        cursor: &mut Option<usize>,
        sample_index: u32,
        segments: &[DrumSeg],
        rate: u32,
    ) -> i32 {
        let mut index = cursor.unwrap_or(0);
        while segments.get(index).is_some_and(|s| sample_index >= s.end) {
            index += 1;
        }
        let Some(segment) = segments.get(index).copied() else {
            return 0;
        };
        if sample_index < segment.start {
            return 0;
        }
        if *cursor != Some(index) {
            *cursor = Some(index);
            self.reset_noise();
        }
        let volume = envelope_volume(segment.volume, segment.fade, sample_index - segment.start, rate);
        self.sample_noise(segment.parameter, rate) * volume as i32 * VOLUME_UNIT
    }

    /// ChipSynth.lua:584-640 (@bdfac727:1056-1107) — the tone half of a
    /// sample: envelope, sweep / slide / vibrato, then the pulse duty or the
    /// wave instrument. The same for both drivers but for how many wave
    /// instruments the engine has.
    fn sample_tone(&mut self, event: Event, sample_index: u32, tables: &EngineTables, rate: u32) -> i32 {
        let volume = envelope_volume(event.volume, event.fade, sample_index, rate);

        // The 60 Hz frame index (:596). Monotone in sample_index, so walking
        // it forward is the same value the reference computes outright.
        while sample_index >= self.frame_next {
            self.frame += 1;
            self.frame_next = frame_boundary(self.frame, rate);
        }
        let frame = self.frame;

        // :595-616 — the register's per-sample modulation: sweep, then slide,
        // then vibrato (the hardware only ever runs one of the three). Each
        // moves the register on a 60 Hz (slide, vibrato) or 128 Hz (sweep)
        // boundary and never per sample, so what is computed here is a KEY —
        // the register itself, or the slide's frame, whose register is
        // fractional — and the frequency is recomputed only when it changes.
        let key: i64 = if let Some(sweep) = event.sweep {
            match self.swept(event.register, sweep, sample_index, rate) {
                Some(r) => r as i64,
                None => return 0,
            }
        } else if event.slide.is_some() {
            -1 - frame as i64
        } else if let Some(vibrato) = event.vibrato
            && frame >= vibrato.delay
        {
            // :605-614 — vibrato swings the LOW byte only; the 3 high bits hold
            let toggles = (frame - vibrato.delay + 1) / (vibrato.rate + 1);
            let mut register = event.register;
            if toggles > 0 {
                let low = register & 0xff;
                let high = register & 0x700;
                register = if toggles & 1 != 0 {
                    high + (low + vibrato.above).min(0xff)
                } else {
                    high + low.saturating_sub(vibrato.below)
                };
            }
            register as i64
        } else {
            event.register as i64
        };

        if key != self.step_key {
            self.step_key = key;
            self.step = phase_step(register_of(key, &event), rate, event.wave);
        }
        // :620-621 — the reference reads the phase BEFORE advancing it.
        let phase = self.phase;
        self.phase = advance_phase(phase, self.step);

        if event.wave {
            if !tables.has_waves {
                return 0; // :626 — a program may have no wave table at all
            }
            // :622-629 — 32 four-bit samples; floor(phase * 32) is the top 5
            // bits of the Q64 phase.
            // @bdfac727:1090-1091 clamps to #waves: nine for Gen 1, ten for
            // Gen 2.
            let slots = if self.gen2 { AUDIO_GEN2_WAVES } else { AUDIO_WAVES };
            let wave = &tables.waves[(event.wave_instrument as usize).min(slots - 1)];
            let index = (phase >> 59) as usize;
            return wave[index] as i32 * WAVE_LEVEL_UNITS[(event.wave_level & 3) as usize];
        }
        // :630-639 — the pulse channels: a duty-gated square at +/- volume/15
        let duty = match event.duty {
            Duty::One(d) => d,
            Duty::Cycle(c) => c[(frame % 4) as usize],
        };
        let pattern = DUTY_PATTERNS[(duty & 3) as usize];
        let step = (phase >> 61) as usize;
        if pattern[step] == 0 {
            -(volume as i32) * VOLUME_UNIT
        } else {
            volume as i32 * VOLUME_UNIT
        }
    }
}

// ---------------------------------------------------------------------------
// Program (ChipSynth.lua's Engine — one playing song / effect / cry)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
struct ProgramOpts {
    /// false ends the channel at `sound_loop 0` instead of looping (:429-435).
    allow_loops: bool,
    /// wFrequencyModifier: added to every tone register (:269).
    frequency_offset: i32,
    /// wTempoModifier-derived SFX tempo (:229, ChipAudio.lua:418).
    frame_ticks: Option<u32>,
    /// ChipAudio.lua:425-432 — a cry's length byte becomes its frame tempo.
    cry_length: Option<u32>,
    /// Sum one value per frame into both outputs instead of honoring NR51
    /// (ChipSynth.lua:843-864 renderEffectData: SFX and cries render mono).
    mono: bool,
    /// Run the Gen 2 driver (the program's engine is AUDIO_ENGINE_GEN2).
    gen2: bool,
    /// Gen 2 STEREO option (`music_flag::STEREO`).
    stereo: bool,
}

#[derive(Clone, Debug)]
struct Program {
    channels: Vec<Channel>,
    state: EngineState,
    engine: usize,
    mono: bool,
    /// Frames rendered, against the one-shot cap (ChipSynth.lua:849).
    frames: u32,
    /// The frame just rendered, per channel: its mix units and its NR51 pan.
    /// Kept so a quantization TIE can be resolved the reference's way — see
    /// [`Program::exact`]. Written with two integers per channel per frame;
    /// no arithmetic rides on it.
    mix: Vec<(i32, bool, bool)>,
    /// Gen 2 driver.
    gen2: bool,
    /// The header this program was built from (bank slot, address), for
    /// `music_flag::RESUME`.
    origin: (u8, u16),
}

impl Program {
    /// ChipSynth.lua:728-774 Engine.new.
    fn build(programs: &[u8], bank: u8, address: u16, engine: usize, opts: &ProgramOpts) -> Option<Program> {
        let specs = header_channels(programs, bank, address);
        if specs.is_empty() {
            return None;
        }
        let mut channels = Vec::with_capacity(specs.len());
        for (number, target) in specs {
            // :758-764 — the noise channel always counts real frames; a cry
            // stretches every OTHER channel's frame by its length byte.
            let hardware = (number - 1) % 4 + 1;
            let frame_ticks = if hardware == 4 {
                AUDIO_FRAME_TICKS
            } else if let Some(length) = opts.cry_length {
                if opts.gen2 {
                    // ChipSynth.lua@bdfac727:1312-1319 — _PlayCry writes
                    // wCryLength, a full word, straight into CHANNEL_TEMPO:
                    // no $80 base in Gen 2.
                    length
                } else {
                    0x80 + length
                }
            } else {
                opts.frame_ticks.unwrap_or(AUDIO_FRAME_TICKS)
            };
            channels.push(Channel::new(bank, number, target, opts, frame_ticks));
        }
        Some(Program {
            mix: alloc::vec![(0, true, true); channels.len()],
            channels,
            state: EngineState {
                tempo: 0x100,
                pan: 0xff,
                stereo: opts.stereo,
            },
            engine,
            mono: opts.mono,
            frames: 0,
            gen2: opts.gen2,
            origin: (bank, address),
        })
    }

    /// ChipSynth.lua@bdfac727:1402-1408 applyStereo — a live SOUND toggle.
    fn apply_stereo(&mut self, stereo: bool) {
        self.state.stereo = stereo;
        if !self.gen2 {
            return;
        }
        for channel in self.channels.iter_mut() {
            channel.apply_stereo_mix(stereo);
        }
    }

    /// The one-shot cap in frames (ChipSynth.lua:849; @bdfac727:1444 for
    /// Gen 2).
    fn cap(&self, rate: u32) -> u32 {
        let seconds = if self.gen2 {
            AUDIO_GEN2_EFFECT_MAX_SECONDS
        } else {
            AUDIO_EFFECT_MAX_SECONDS
        };
        rate.saturating_mul(seconds)
    }

    /// ChipSynth.lua:776-781 — every channel ended and drained.
    fn finished(&self) -> bool {
        self.channels
            .iter()
            .all(|c| c.ended && c.event.is_none())
    }

    /// One frame, in mix units. ChipSynth.lua:789-799 sampleStereo honors each
    /// event's NR51 pan; :783-787 sample() is the mono sum a one-shot renders
    /// through. Both clamp `sum / 4` to -1..1.
    fn frame(&mut self, tables: &EngineTables, programs: &[u8], rate: u32) -> (i32, i32) {
        let mono = self.mono;
        self.frames = self.frames.saturating_add(1);
        let Program {
            channels,
            state,
            mix,
            ..
        } = self;
        let (mut left, mut right) = (0i32, 0i32);
        for (channel, slot) in channels.iter_mut().zip(mix.iter_mut()) {
            let value = channel.sample(state, tables, programs, rate);
            // :794-795 — an event that states no pan counts as on, and a
            // channel with no event contributes 0 either way. Gen 2 reads
            // the channel's live tracks instead (@bdfac727:1386-1389), which
            // also pans a drum tail ringing past the channel's last note.
            let (l, r) = if channel.gen2 {
                channel.pan(state)
            } else {
                match channel.event.as_ref() {
                    Some(e) => (e.pan_left, e.pan_right),
                    None => (true, true),
                }
            };
            *slot = (value, l, r);
            if mono {
                left += value;
                continue;
            }
            if l {
                left += value;
            }
            if r {
                right += value;
            }
        }
        if mono {
            let v = left.clamp(-MIX_CLAMP, MIX_CLAMP);
            return (v, v);
        }
        (
            left.clamp(-MIX_CLAMP, MIX_CLAMP),
            right.clamp(-MIX_CLAMP, MIX_CLAMP),
        )
    }

    /// The reference's OWN double for the frame just rendered: each channel's
    /// value summed in channel order, divided by four and clamped
    /// (ChipSynth.lua:783-799).
    ///
    /// Every channel value is exactly `units / AUDIO_MIX_UNIT` as a double —
    /// a pulse at volume v is `v*32/480`, which IEEE division rounds to the
    /// same double as the reference's `v/15`, and a wave nibble is a dyadic
    /// either way. So this reconstructs the reference's accumulation bit for
    /// bit without carrying a second running sum through the render loop.
    ///
    /// Only [`quantize`] calls it, and only on a tie.
    fn exact(&self, right: bool) -> f64 {
        let mut acc = 0.0f64;
        for &(units, l, r) in &self.mix {
            if self.mono || if right { r } else { l } {
                acc += units as f64 / AUDIO_MIX_UNIT as f64;
            }
        }
        (acc / 4.0).clamp(-1.0, 1.0)
    }
}

// ---------------------------------------------------------------------------
// Audio — the surface the scene drives and the host pumps
// ---------------------------------------------------------------------------

/// Music.lua:312-321 fadeOut — rAUDVOL steps AUDIO_FADE_LEVELS -> 0, one
/// level every `control` ticks, and the song stops at 0.
#[derive(Clone, Copy, Debug)]
struct Fade {
    control: u32,
    counter: u32,
}

/// A queued audio op.
///
/// Ops arrive during the guest's tick, where the pak's program bytes are not
/// in hand — [`crate::scene::Scene::op`] takes numbers and nothing else, on
/// every host. Everything that has to READ a program is therefore applied at
/// the next [`Audio::render`], which the host pumps in the same tick with the
/// bytes. The pins need no bytes and apply immediately.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Cmd {
    Music {
        bank: u32,
        address: u32,
        engine: u32,
        flags: u32,
    },
    MusicStop,
    MusicFade(i32),
    Sfx {
        bank: u32,
        address: u32,
        engine: u32,
        pitch: i32,
        tempo: u32,
        flags: u32,
    },
    Cry {
        bank: u32,
        address: u32,
        engine: u32,
        pitch: i32,
        length: u32,
    },
    Pcm(u32),
}

/// Yellow's voiced Pikachu clips as the host hands them over (the overlay's
/// PIKA chunk body, tools/cook3ds.ts writeOverlay):
///
///   u16 count  u16 rate  count x { u32 offset, u32 bytes }  then the bits
///
/// offsets from the start of the body. Each clip is the ROM's 1-bit PCM,
/// MSB first (audio/pikachu_pcm.asm LoadNextSoundClipSample `and $80`).
#[derive(Clone, Debug, Default)]
struct PcmBank {
    bytes: Vec<u8>,
    count: usize,
    rate: u32,
}

impl PcmBank {
    /// Clip `n` (1-based): its bits, or None past the table or the body.
    fn clip(&self, n: u32) -> Option<(usize, usize)> {
        let i = (n as usize).checked_sub(1)?;
        if i >= self.count {
            return None;
        }
        let e = 4 + i * 8;
        let b = &self.bytes;
        let off = u32::from_le_bytes([b[e], b[e + 1], b[e + 2], b[e + 3]]) as usize;
        let len = u32::from_le_bytes([b[e + 4], b[e + 5], b[e + 6], b[e + 7]]) as usize;
        (off.checked_add(len)? <= b.len() && len > 0).then_some((off, len))
    }
}

/// The clip playing: its bits in the bank, and where the read head is in
/// source samples, Q16.
#[derive(Clone, Copy, Debug)]
struct PcmVoice {
    start: usize,
    samples: u64,
    pos: u64,
}

/// A clip bit's level in mix units at full rAUDVOL: +/- half of full scale.
/// The Game Boy toggles channel 3's level per bit with everything else off,
/// so the clip is a lone channel at max swing; the reference plays it at
/// 0.75 of a -1..1 output (RomExtractor.lua:2156), louder than any one chip
/// channel ever gets. Half splits the two.
const PCM_LEVEL: i32 = MIX_CLAMP / 2;

/// A tick emits a handful of audio ops at most. A host that never renders
/// never sounds, and its queue must not grow without bound, so the oldest
/// intent is dropped once this many are pending — the most recent one, the
/// one that would still be audible, always survives.
const CMD_CAP: usize = 16;

/// The chip synth's whole state: the pinned engine tables, the song, the
/// one-shot over it, and the fade.
///
/// Rendering is a pure function of (the ops applied so far, the frames asked
/// for). No clock is read, nothing is allocated per frame, and asking for the
/// same frames from the same op history always writes the same bytes.
#[derive(Clone, Debug)]
pub struct Audio {
    rate: u32,
    wave_pins: [Pin; AUDIO_ENGINES],
    drum_pins: [[Pin; AUDIO_DRUMS]; AUDIO_ENGINES],
    tables: [EngineTables; AUDIO_ENGINES],
    music: Option<Program>,
    effect: Option<Program>,
    /// A fanfare PAUSES the song and it resumes after (Music.lua:102-115).
    ducked: bool,
    fade: Option<Fade>,
    /// rAUDVOL level, AUDIO_FADE_LEVELS = full.
    level: u32,
    pending: Vec<Cmd>,
    /// Yellow's Pikachu clips (empty for Red and Blue) and the one playing.
    pcm_bank: PcmBank,
    pcm: Option<PcmVoice>,
    /// Gold's low-health siren, while it loops.
    alarm: Option<Alarm>,
}

/// ChipAudio.lua@bdfac727:662-682 newLowHealthAlarm — a looping one-second
/// buffer of two PlayDanger cycles (audio/engine.asm:531): frames 0..15 of
/// each 30 at register $750, 16..29 at $6ee, a 50% square at a quarter of
/// full scale on both sides. The buffer is built with its phase at zero, so
/// every loop restarts the oscillator exactly as replaying it does.
#[derive(Clone, Copy, Debug)]
struct Alarm {
    /// Sample index inside the one-second buffer.
    pos: u32,
    phase: u64,
}

impl Alarm {
    /// The next sample: +1 or -1 (times a quarter of full scale).
    fn next(&mut self, rate: u32) -> i32 {
        if self.pos >= rate {
            self.pos = 0;
            self.phase = 0;
        }
        let frame = frame_at(self.pos, rate) % 30;
        let register = if frame < 16 { 0x750 } else { 0x6ee };
        // :675-677 — the phase advances BEFORE it is read
        self.phase = advance_phase(self.phase, phase_step(register as f64, rate, false));
        self.pos += 1;
        if self.phase < 1u64 << 63 { 1 } else { -1 }
    }
}

impl Default for Audio {
    fn default() -> Self {
        Audio::new()
    }
}

impl Audio {
    pub fn new() -> Self {
        Audio {
            rate: 44100,
            wave_pins: [Pin::default(); AUDIO_ENGINES],
            drum_pins: [[Pin::default(); AUDIO_DRUMS]; AUDIO_ENGINES],
            tables: core::array::from_fn(|_| EngineTables::default()),
            music: None,
            effect: None,
            ducked: false,
            fade: None,
            level: AUDIO_FADE_LEVELS,
            pending: Vec::new(),
            pcm_bank: PcmBank::default(),
            pcm: None,
            alarm: None,
        }
    }

    /// Whether the low-health siren is looping.
    pub fn alarm_playing(&self) -> bool {
        self.alarm.is_some()
    }

    /// Hand over Yellow's Pikachu clips (see [`PcmBank`]). Boot-time host
    /// configuration, like the rate: a reset keeps it. A malformed table is
    /// refused whole and `pikaPcm` stays a no-op.
    pub fn set_pcm_bank(&mut self, body: &[u8]) -> bool {
        self.pcm = None;
        self.pcm_bank = PcmBank::default();
        if body.len() < 4 {
            return false;
        }
        let count = u16::from_le_bytes([body[0], body[1]]) as usize;
        let rate = u16::from_le_bytes([body[2], body[3]]) as u32;
        if count == 0 || rate == 0 || body.len() < 4 + count * 8 {
            return false;
        }
        self.pcm_bank = PcmBank { bytes: body.to_vec(), count, rate };
        true
    }

    /// How many clips `pikaPcm` can name (0 without a bank).
    pub fn pcm_clips(&self) -> usize {
        self.pcm_bank.count
    }

    /// Whether a clip is sounding.
    pub fn pcm_playing(&self) -> bool {
        self.pcm.is_some()
    }

    fn play_pcm(&mut self, n: u32) {
        if let Some((start, len)) = self.pcm_bank.clip(n) {
            self.pcm = Some(PcmVoice { start, samples: len as u64 * 8, pos: 0 });
        }
    }

    /// Dispatch one audio op (voxel-spec.ts §audio). Returns false for a code
    /// this module does not own, so the scene can fall through. Malformed arg
    /// lists are no-ops, like every other op on this surface.
    pub fn op(&mut self, code: u32, args: &[i32]) -> bool {
        let a = |i: usize| args.get(i).copied().unwrap_or(0);
        match code {
            op::MUSIC => {
                if args.len() >= 4 {
                    self.queue(Cmd::Music {
                        bank: a(0) as u32,
                        address: a(1) as u32,
                        engine: a(2) as u32,
                        flags: a(3) as u32,
                    });
                }
            }
            op::MUSIC_STOP => self.queue(Cmd::MusicStop),
            op::MUSIC_FADE => {
                if !args.is_empty() {
                    self.queue(Cmd::MusicFade(a(0)));
                }
            }
            op::SFX => {
                if args.len() >= 6 {
                    self.queue(Cmd::Sfx {
                        bank: a(0) as u32,
                        address: a(1) as u32,
                        engine: a(2) as u32,
                        pitch: a(3),
                        tempo: a(4).max(0) as u32,
                        flags: a(5) as u32,
                    });
                }
            }
            op::CRY => {
                if args.len() >= 5 {
                    self.queue(Cmd::Cry {
                        bank: a(0) as u32,
                        address: a(1) as u32,
                        engine: a(2) as u32,
                        pitch: a(3),
                        length: a(4).max(0) as u32,
                    });
                }
            }
            op::AUDIO_WAVES => {
                if args.len() >= 3 {
                    self.pin_waves(a(0) as u32, a(1) as u32, a(2) as u32);
                }
            }
            op::AUDIO_DRUM => {
                if args.len() >= 4 {
                    self.pin_drum(a(0) as u32, a(1) as u32, a(2) as u32, a(3) as u32);
                }
            }
            op::PIKA_PCM => {
                if !args.is_empty() && a(0) > 0 {
                    self.queue(Cmd::Pcm(a(0) as u32));
                }
            }
            _ => return false,
        }
        true
    }

    fn queue(&mut self, cmd: Cmd) {
        if self.pending.len() >= CMD_CAP {
            self.pending.remove(0);
        }
        self.pending.push(cmd);
    }

    fn apply_queued(&mut self, programs: &[u8]) {
        if self.pending.is_empty() {
            return;
        }
        let queued = core::mem::take(&mut self.pending);
        for cmd in queued {
            match cmd {
                Cmd::Music {
                    bank,
                    address,
                    engine,
                    flags,
                } => self.play_music(programs, bank, address, engine, flags),
                Cmd::MusicStop => self.stop_music(),
                Cmd::MusicFade(ticks) => self.fade_music(ticks),
                Cmd::Sfx {
                    bank,
                    address,
                    engine,
                    pitch,
                    tempo,
                    flags,
                } => self.play_sfx(programs, bank, address, engine, pitch, tempo, flags),
                Cmd::Cry {
                    bank,
                    address,
                    engine,
                    pitch,
                    length,
                } => self.play_cry(programs, bank, address, engine, pitch, length),
                Cmd::Pcm(n) => self.play_pcm(n),
            }
        }
    }

    /// `reset()` drops scene state to boot. The pinned engine tables and the
    /// output rate are host/boot configuration, not scene state, so they
    /// survive — a reset must not leave the guest silently unable to sound.
    pub fn into_reset(mut self) -> Audio {
        self.stop_all();
        self.pending.clear();
        self
    }

    /// The output rate every program is interpreted at. Must divide 44100
    /// (contracts/spec/audio.ts AUDIO_RATES); a host sets it once at boot,
    /// before any audio op, and changing it drops what is playing because
    /// every event's sample span is measured in the old rate.
    pub fn set_rate(&mut self, rate: u32) -> bool {
        if rate == 0 || 44100 % rate != 0 {
            return false;
        }
        if rate != self.rate {
            self.rate = rate;
            self.music = None;
            self.effect = None;
            self.ducked = false;
            self.fade = None;
            self.level = AUDIO_FADE_LEVELS;
            if let Some(alarm) = self.alarm.as_mut() {
                *alarm = Alarm { pos: 0, phase: 0 }; // rebuilt at the new rate
            }
            for t in self.tables.iter_mut() {
                t.built = false; // drum spans are in samples
            }
        }
        true
    }

    pub fn rate(&self) -> u32 {
        self.rate
    }

    pub fn music_playing(&self) -> bool {
        self.music.is_some()
    }

    pub fn effect_playing(&self) -> bool {
        self.effect.is_some()
    }

    /// rAUDVOL level, AUDIO_FADE_LEVELS = full volume.
    pub fn level(&self) -> u32 {
        self.level
    }

    /// `audioWaves(engine, bank, addr)`.
    pub fn pin_waves(&mut self, engine: u32, bank: u32, address: u32) {
        let engine = engine as usize;
        if engine >= AUDIO_ENGINES {
            return;
        }
        self.wave_pins[engine] = Pin {
            set: true,
            bank: bank as u8,
            address: address as u16,
        };
        self.tables[engine].built = false;
    }

    /// `audioDrum(engine, drum, bank, addr)`.
    pub fn pin_drum(&mut self, engine: u32, drum: u32, bank: u32, address: u32) {
        if engine as usize >= AUDIO_ENGINES || drum as usize >= AUDIO_DRUMS {
            return;
        }
        self.drum_pins[engine as usize][drum as usize] = Pin {
            set: true,
            bank: bank as u8,
            address: address as u16,
        };
        self.tables[engine as usize].built = false;
    }

    /// Decode one engine's tables if a pin changed since they were last built.
    fn ensure_tables(&mut self, engine: usize, programs: &[u8]) {
        if engine >= AUDIO_ENGINES || self.tables[engine].built {
            return;
        }
        let rate = self.rate;
        let wave_pin = self.wave_pins[engine];
        if engine == AUDIO_ENGINE_GEN2 {
            // ChipSynth.lua@bdfac727:1263-1268 readWavesGen2, and every drum
            // of every kit behind the Drumkits pin (drum slot 0).
            let kit_pin = self.drum_pins[engine][0];
            let mut kits = Vec::with_capacity(AUDIO_GEN2_DRUMKITS * GEN2_KIT_DRUMS);
            for kit in 0..AUDIO_GEN2_DRUMKITS as u8 {
                for pitch in 0..GEN2_KIT_DRUMS as u8 {
                    kits.push(if kit_pin.set {
                        read_drum_gen2(programs, kit_pin, kit, pitch, rate)
                    } else {
                        Vec::new()
                    });
                }
            }
            let table = &mut self.tables[engine];
            table.kits = kits;
            table.drums = Vec::new();
            match wave_pin.set.then(|| read_waves_gen2(programs, wave_pin)).flatten() {
                Some(waves) => {
                    table.waves = waves;
                    table.has_waves = true;
                }
                None => table.has_waves = false,
            }
            table.built = true;
            return;
        }
        let drums: Vec<Vec<DrumSeg>> = (0..AUDIO_DRUMS)
            .map(|d| {
                let pin = self.drum_pins[engine][d];
                if pin.set {
                    read_drum(programs, pin, rate)
                } else {
                    Vec::new()
                }
            })
            .collect();
        let table = &mut self.tables[engine];
        table.drums = drums;
        match wave_pin.set.then(|| read_waves(programs, wave_pin)).flatten() {
            Some(waves) => {
                table.waves = waves;
                table.has_waves = true;
            }
            None => table.has_waves = false,
        }
        table.built = true;
    }

    /// `music(bank, addr, engine, flags)` — Music.lua:233 play. A program that
    /// fails to decode leaves the outgoing song sounding (:243-248).
    pub fn play_music(&mut self, programs: &[u8], bank: u32, address: u32, engine: u32, flags: u32) {
        let engine = engine as usize;
        if engine >= AUDIO_ENGINES {
            return;
        }
        let stereo = flags & music_flag::STEREO != 0;
        if flags & music_flag::RESUME != 0
            && let Some(song) = self.music.as_mut()
            && song.engine == engine
            && song.origin == (bank as u8, address as u16)
        {
            // Music.lua:242-250 — the same song again: keep it, drop the
            // fade back to full; and re-apply the SOUND option live
            // (ChipSynth.lua@bdfac727:1402 applyStereo).
            song.apply_stereo(stereo);
            self.fade = None;
            self.level = AUDIO_FADE_LEVELS;
            return;
        }
        self.ensure_tables(engine, programs);
        let opts = ProgramOpts {
            allow_loops: flags & music_flag::LOOP != 0,
            frequency_offset: 0,
            frame_ticks: None,
            cry_length: None,
            mono: false,
            gen2: engine == AUDIO_ENGINE_GEN2,
            stereo,
        };
        if let Some(program) = Program::build(programs, bank as u8, address as u16, engine, &opts) {
            self.music = Some(program);
            self.fade = None;
            self.level = AUDIO_FADE_LEVELS;
        }
    }

    /// `musicStop()` — Music.lua:285 stop.
    pub fn stop_music(&mut self) {
        self.music = None;
        self.fade = None;
        self.level = AUDIO_FADE_LEVELS;
    }

    /// `musicFade(ticks)` — Music.lua:312 fadeOut.
    pub fn fade_music(&mut self, ticks: i32) {
        if self.music.is_none() || ticks <= 0 {
            self.stop_music();
            return;
        }
        let control = ticks as u32;
        self.fade = Some(Fade {
            control,
            counter: control,
        });
        self.level = AUDIO_FADE_LEVELS;
    }

    /// `sfx(bank, addr, engine, pitch, tempo, flags)` — Sound.lua:190 play
    /// through ChipAudio.lua:414 newSfx. The argument list is the op's, and
    /// the op's is the reference's newSfx: pitch and tempo are modifiers a
    /// caller supplies, not defaults to hide in a struct.
    #[allow(clippy::too_many_arguments)]
    pub fn play_sfx(
        &mut self,
        programs: &[u8],
        bank: u32,
        address: u32,
        engine: u32,
        pitch: i32,
        tempo: u32,
        flags: u32,
    ) {
        if flags & sfx_flag::ALARM != 0 {
            // ChipAudio.lua@bdfac727:667 via Sound.lua@bdfac727:837
            // startLoop / :870 stopLoop — idempotent both ways.
            if flags & sfx_flag::STOP != 0 {
                self.alarm = None;
            } else if self.alarm.is_none() {
                self.alarm = Some(Alarm { pos: 0, phase: 0 });
            }
            return;
        }
        if flags & sfx_flag::STOP != 0 {
            // Sound.lua@bdfac727:436 / :443 / :828 — Source:stop on the
            // running one-shot, which also ends a fanfare's hold on the song
            // (Music.lua:74-82).
            self.effect = None;
            self.ducked = false;
            return;
        }
        let opts = ProgramOpts {
            allow_loops: false,
            frequency_offset: pitch,
            frame_ticks: Some(AUDIO_SFX_TEMPO + tempo),
            cry_length: None,
            mono: true,
            gen2: engine as usize == AUDIO_ENGINE_GEN2,
            stereo: false,
        };
        if self.start_effect(programs, bank, address, engine, &opts) {
            self.ducked = flags & sfx_flag::DUCK != 0;
        }
    }

    /// `cry(bank, addr, engine, pitch, length)` — Sound.lua:307 playCry
    /// through ChipAudio.lua:425 newCry.
    pub fn play_cry(
        &mut self,
        programs: &[u8],
        bank: u32,
        address: u32,
        engine: u32,
        pitch: i32,
        length: u32,
    ) {
        let opts = ProgramOpts {
            allow_loops: false,
            frequency_offset: pitch,
            frame_ticks: None,
            cry_length: Some(length),
            mono: true,
            gen2: engine as usize == AUDIO_ENGINE_GEN2,
            stereo: false,
        };
        if self.start_effect(programs, bank, address, engine, &opts) {
            self.ducked = false;
        }
    }

    fn start_effect(
        &mut self,
        programs: &[u8],
        bank: u32,
        address: u32,
        engine: u32,
        opts: &ProgramOpts,
    ) -> bool {
        let engine = engine as usize;
        if engine >= AUDIO_ENGINES {
            return false;
        }
        self.ensure_tables(engine, programs);
        match Program::build(programs, bank as u8, address as u16, engine, opts) {
            Some(program) => {
                self.effect = Some(program);
                true
            }
            None => false,
        }
    }

    /// Drop everything (a hard scene cut).
    pub fn stop_all(&mut self) {
        self.music = None;
        self.effect = None;
        self.pcm = None;
        self.alarm = None;
        self.ducked = false;
        self.fade = None;
        self.level = AUDIO_FADE_LEVELS;
    }

    /// One tick of the fade clock. The scene calls this once per frame, on the
    /// tick clock — the only clock (Music.lua:455-473).
    pub fn tick(&mut self) {
        let Some(fade) = self.fade.as_mut() else {
            return;
        };
        fade.counter -= 1;
        if fade.counter > 0 {
            return;
        }
        fade.counter = fade.control;
        self.level = self.level.saturating_sub(1);
        if self.level == 0 {
            self.stop_music();
        }
    }

    /// Render `out.len() / 2` interleaved stereo frames.
    ///
    /// `programs` is the pak's AUDI program half — the ROM sound banks
    /// concatenated in `bankOrder`, which every op's `bank` argument indexes
    /// as a 0x4000-byte window.
    // `chunks_exact_mut(2)` over `as_chunks_mut::<2>()`: the PSP toolchain is
    // pinned (hosts/psp) and this crate must build there unchanged.
    #[allow(clippy::chunks_exact_to_as_chunks)]
    pub fn render(&mut self, programs: &[u8], out: &mut [i16]) {
        self.apply_queued(programs);
        let rate = self.rate;
        // Split borrows: the tables are read while the programs are stepped.
        // Source samples per output frame, Q16 (22050 over 11025 = 2.0).
        let pcm_step = if rate > 0 {
            ((self.pcm_bank.rate as u64) << 16) / rate as u64
        } else {
            0
        };
        let Audio {
            tables,
            music,
            effect,
            ducked,
            level,
            pcm_bank,
            pcm,
            alarm,
            ..
        } = self;

        // One iteration per output FRAME: [left, right].
        for frame in out.chunks_exact_mut(2) {
            // A Pikachu clip plays alone: PlayPikachuSoundClip runs with
            // interrupts off, so the sound engine does not step and the song
            // and any effect pick up where they were once it ends. Each output
            // frame is the mean of the source bits it spans.
            if let Some(voice) = pcm.as_mut() {
                let from = voice.pos >> 16;
                let to = ((voice.pos + pcm_step) >> 16).clamp(from + 1, voice.samples);
                let mut ones = 0i64;
                for s in from..to {
                    let byte = pcm_bank.bytes[voice.start + (s >> 3) as usize];
                    ones += ((byte >> (7 - (s & 7))) & 1) as i64;
                }
                let n = (to - from) as i64;
                let value = ((2 * ones - n) * (PCM_LEVEL * AUDIO_FADE_LEVELS as i32) as i64 / n) as i32;
                let exact = value as f64 / (MIX_CLAMP as f64 * AUDIO_FADE_LEVELS as f64);
                let sample = quantize(value, || exact);
                frame[0] = sample;
                frame[1] = sample;
                voice.pos += pcm_step;
                if to >= voice.samples {
                    *pcm = None;
                }
                continue;
            }
            let (mut left, mut right) = (0i32, 0i32);

            // A fanfare pauses the song rather than mixing under it, so the
            // music engine does not advance while `ducked` (Music.lua:110).
            let mut music_live = false;
            if !*ducked && let Some(program) = music.as_mut() {
                let (l, r) = program.frame(&tables[program.engine], programs, rate);
                // The fade rides the music bus only; the common denominator
                // keeps the effect at full level in the same quantization.
                left += l * *level as i32;
                right += r * *level as i32;
                music_live = true;
            }
            let effect_live = effect.is_some();
            if let Some(program) = effect.as_mut() {
                let (l, r) = program.frame(&tables[program.engine], programs, rate);
                left += l * AUDIO_FADE_LEVELS as i32;
                right += r * AUDIO_FADE_LEVELS as i32;
            }
            // Gold's siren, over everything at a quarter of full scale
            // (ChipAudio.lua@bdfac727:677), which is one channel's worth.
            let siren = alarm.as_mut().map_or(0, |a| a.next(rate));
            left += siren * AUDIO_MIX_UNIT * AUDIO_FADE_LEVELS as i32;
            right += siren * AUDIO_MIX_UNIT * AUDIO_FADE_LEVELS as i32;

            // The tie-break needs the reference's own double for the frame,
            // and only on a tie — see `quantize`.
            let exact = |right: bool| -> f64 {
                let m = if music_live {
                    music.as_ref().map_or(0.0, |p| p.exact(right))
                } else {
                    0.0
                };
                let e = if effect_live {
                    effect.as_ref().map_or(0.0, |p| p.exact(right))
                } else {
                    0.0
                };
                m * *level as f64 / AUDIO_FADE_LEVELS as f64 + e + siren as f64 * 0.25
            };
            frame[0] = quantize(left, || exact(false));
            frame[1] = quantize(right, || exact(true));

            if let Some(program) = effect.as_ref()
                && (program.finished() || program.frames >= program.cap(rate))
            {
                *effect = None;
                *ducked = false;
            }
        }
    }

    /// Render into a fresh buffer — what offline renders and tests want.
    pub fn render_vec(&mut self, programs: &[u8], frames: usize) -> Vec<i16> {
        let mut out = alloc::vec![0i16; frames * 2];
        self.render(programs, &mut out);
        out
    }
}

/// Mix units (already scaled by AUDIO_FADE_LEVELS) to s16, rounding away from
/// zero — the quantization the reference's host applies to its -1..1 doubles.
///
/// The scale is `32767 / (4 * AUDIO_MIX_UNIT * AUDIO_FADE_LEVELS)`, done as
/// one integer division so nothing rounds twice.
///
/// # The tie
///
/// The exact mix is a rational with denominator `4 * AUDIO_MIX_UNIT`, so
/// scaled by 32767 it is either at least 1/3840 away from a half-integer — a
/// gap no accumulation error can cross — or exactly ON one. The reference
/// gets there by summing terms like `volume/15` that no double represents, so
/// on a tie it lands a hair either side of the boundary and `floor(x + 0.5)`
/// follows it, while exact arithmetic always rounds up. That is a real
/// disagreement and it is worth one lookup to settle: `exact` rebuilds the
/// reference's own double for this frame and answers with it.
///
/// A tie is `value == +/-960 * AUDIO_FADE_LEVELS` at full level (the channel
/// sum landing on exactly 2.0), which is ~1% of the samples in a cry and none
/// at all in most music. Everything else takes the integer path.
fn quantize(value: i32, exact: impl FnOnce() -> f64) -> i16 {
    const DEN: i64 = 2 * (MIX_CLAMP as i64) * (AUDIO_FADE_LEVELS as i64);
    let v = value as i64 * 32767 * 2;
    let magnitude = v.abs();
    if magnitude % DEN == DEN / 2 {
        // `floor`/`ceil` are std-only and this crate builds no_std for the
        // PSP, so the half-away-from-zero round is done with the cast's own
        // truncation-toward-zero: for x >= 0, `(x + 0.5) as i64` IS
        // floor(x + 0.5), and for x < 0 `(x - 0.5) as i64` IS ceil(x - 0.5).
        // |scaled| <= 32767 here, far inside i64.
        let scaled = exact() * 32767.0;
        let rounded = if scaled >= 0.0 {
            (scaled + 0.5) as i64
        } else {
            (scaled - 0.5) as i64
        };
        return rounded.clamp(-32768, 32767) as i16;
    }
    let rounded = if v >= 0 {
        (v + DEN / 2) / DEN
    } else {
        -((-v + DEN / 2) / DEN)
    };
    rounded.clamp(-32768, 32767) as i16
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    /// A PIKA body with one clip per entry of `clips`.
    fn pcm_body(rate: u16, clips: &[&[u8]]) -> Vec<u8> {
        let mut head = Vec::new();
        head.extend_from_slice(&(clips.len() as u16).to_le_bytes());
        head.extend_from_slice(&rate.to_le_bytes());
        let mut at = 4 + clips.len() * 8;
        let mut bits = Vec::new();
        for c in clips {
            head.extend_from_slice(&(at as u32).to_le_bytes());
            head.extend_from_slice(&(c.len() as u32).to_le_bytes());
            bits.extend_from_slice(c);
            at += c.len();
        }
        head.extend_from_slice(&bits);
        head
    }

    #[test]
    fn a_pikachu_clip_plays_its_bits_and_holds_the_song() {
        let programs = blank_programs();
        let mut audio = Audio::new();
        assert!(audio.set_rate(11025));
        // clip 1: all on then all off (16 bits = 8 frames at half rate);
        // clip 2: alternating bits, which average to silence
        assert!(audio.set_pcm_bank(&pcm_body(22050, &[&[0xff, 0x00], &[0xaa]])));
        assert_eq!(audio.pcm_clips(), 2);
        assert!(audio.op(op::PIKA_PCM, &[1]));
        let out = audio.render_vec(&programs, 10);
        let half = (32767 / 2) as i16;
        for f in 0..4 {
            assert!((out[f * 2] - half).abs() <= 1, "frame {f}: {}", out[f * 2]);
            assert_eq!(out[f * 2], out[f * 2 + 1]);
        }
        for f in 4..8 {
            assert!((out[f * 2] + half).abs() <= 1, "frame {f}: {}", out[f * 2]);
        }
        assert!(!audio.pcm_playing());
        assert_eq!(&out[16..], &[0, 0, 0, 0]);
        audio.op(op::PIKA_PCM, &[2]);
        assert!(audio.render_vec(&programs, 4).iter().all(|&s| s == 0));
        // past the table, or with no bank: nothing
        audio.op(op::PIKA_PCM, &[3]);
        audio.render_vec(&programs, 1);
        assert!(!audio.pcm_playing());
        assert!(!Audio::new().set_pcm_bank(&[1, 0]));
    }

    /// Two banks of program space: slot 0 and slot 1.
    fn blank_programs() -> Vec<u8> {
        vec![0u8; AUDIO_BANK_SIZE * 2]
    }

    fn put(programs: &mut [u8], bank: u8, address: u16, bytes: &[u8]) {
        let at = bank as usize * AUDIO_BANK_SIZE + address as usize - AUDIO_BANK_SIZE;
        programs[at..at + bytes.len()].copy_from_slice(bytes);
    }

    /// A one-channel header at `addr` pointing at `program`.
    fn header(programs: &mut [u8], bank: u8, addr: u16, program: u16) {
        put(
            programs,
            bank,
            addr,
            &[0x00, (program & 0xff) as u8, (program >> 8) as u8],
        );
    }

    #[test]
    fn snap_ticks_matches_the_reference_rational() {
        // ChipSynth.lua:115 is `(ticks * 1470 + 256) / 512` at 44100.
        for ticks in [0u64, 1, 255, 256, 4096, 15360, 1_000_000] {
            let lua = (ticks * 1470 + 256) / 512;
            assert_eq!(snap_ticks(ticks, 44100), lua, "ticks {ticks}");
        }
        // One second of program ticks is one second of samples.
        assert_eq!(snap_ticks(15360, 11025), 11025);
    }

    #[test]
    fn the_frame_clock_reproduces_the_references_double() {
        // The exact rational says 123; the double the reference computes says
        // 122, and the reference is what the ROM is timed against.
        assert_eq!(90405 * 60 / 44100, 123);
        assert_eq!(frame_at(90405, 44100), 122);
        // The boundary walk lands on the first sample of each frame.
        for frame in 0..600u32 {
            let s = frame_boundary(frame, 44100);
            assert!(frame_at(s, 44100) > frame);
            assert!(frame_at(s - 1, 44100) <= frame);
        }
    }

    #[test]
    fn the_envelope_clamps_and_holds() {
        // fade 0 holds; positive fades down to 0; negative fades up to 15.
        assert_eq!(envelope_volume(9, 0, 44100, 44100), 9);
        assert_eq!(envelope_volume(9, 1, 0, 44100), 9);
        // one step is |fade|/64 s, and the step lands on the first sample
        // at or past it — 44100/64 is 689.06, so 689 is still the old level
        assert_eq!(envelope_volume(9, 1, 689, 44100), 9);
        assert_eq!(envelope_volume(9, 1, 690, 44100), 8);
        assert_eq!(envelope_volume(9, 1, 44100, 44100), 0);
        assert_eq!(envelope_volume(9, -1, 44100, 44100), 15);
        assert_eq!(envelope_volume(9, 2, 690, 44100), 9);
        assert_eq!(envelope_volume(9, 2, 1379, 44100), 8);
    }

    #[test]
    fn the_lfsr_is_the_dmg_one() {
        // 15-bit: 0x7FFF folds to 0x3FFF (feedback 0), then walks.
        assert_eq!(clock_lfsr(0x7fff, false), 0x3fff);
        // 7-bit mode also writes bit 6.
        assert_eq!(clock_lfsr(0x7fff, true) & 0x40, 0);
        // The sequence never reaches zero and returns to the seed.
        let mut lfsr = 0x7fffu16;
        let mut steps = 0u32;
        loop {
            lfsr = clock_lfsr(lfsr, false);
            steps += 1;
            assert_ne!(lfsr, 0, "the LFSR must never lock at zero");
            if lfsr == 0x7fff {
                break;
            }
            assert!(steps < 40000);
        }
        assert_eq!(steps, 32767, "a maximal 15-bit sequence");
    }

    #[test]
    fn the_phase_step_is_the_gb_frequency_formula() {
        // register 0 -> 131072/2048 = 64 Hz; at 44100 that is 64/44100 of a
        // cycle per sample.
        let step = phase_step(0.0, 44100, false);
        let want = ((64.0f64 / 44100.0) * 2f64.powi(64)) as u64;
        assert!(step.abs_diff(want) < 1 << 20, "{step} vs {want}");
        // The wave channel runs an octave down.
        assert_eq!(phase_step(0.0, 44100, true), phase_step(0.0, 88200, false));
        // The register clamps at 2047, so the denominator never reaches zero.
        assert_eq!(phase_step(9999.0, 44100, false), phase_step(2047.0, 44100, false));
    }

    #[test]
    fn the_phase_accumulator_rounds_like_a_double() {
        // Adding a step small enough to fall off the end of the mantissa is a
        // no-op, exactly as it is in doubles.
        let half = 1u64 << 63;
        assert_eq!(advance_phase(half, 1), half);
        // ... and one ulp of that magnitude does land.
        assert_eq!(advance_phase(half, 1 << 11), half + (1 << 11));
        // Ties go to even.
        assert_eq!(advance_phase(half, 1 << 10), half);
        assert_eq!(advance_phase(half + (1 << 11), 1 << 10), half + (1 << 12));
        // Crossing 1.0 rounds at the coarser exponent, then wraps.
        assert_eq!(advance_phase(half, half), 0);
        assert_eq!(advance_phase(u64::MAX, 1), 0);
        // A small phase keeps its full precision.
        assert_eq!(advance_phase(0, 12345), 12345);
    }

    #[test]
    fn the_mix_quantizes_the_way_the_reference_does() {
        // Full scale on one side, and the exact half-step the double path
        // also lands on (two channels at volume 15 sum to 2.0 -> 0.5 after
        // the /4, which is 16383.5 * 2 -> rounds away from zero).
        let exact = |v: f64| move || v;
        assert_eq!(quantize(MIX_CLAMP * AUDIO_FADE_LEVELS as i32, exact(1.0)), 32767);
        assert_eq!(quantize(-MIX_CLAMP * AUDIO_FADE_LEVELS as i32, exact(-1.0)), -32767);
        assert_eq!(quantize(0, exact(0.0)), 0);
        // The one tie: two channels at volume 15 sum to 2.0, which is 0.5
        // after the /4 and 16383.5 at s16 scale. Exact arithmetic rounds away
        // from zero; a double that landed a hair low rounds down, and the
        // reference's double is the tiebreaker.
        let two_full = 2 * 15 * VOLUME_UNIT * AUDIO_FADE_LEVELS as i32;
        assert_eq!(quantize(two_full, exact(0.5)), 16384);
        assert_eq!(quantize(-two_full, exact(-0.5)), -16384);
        assert_eq!(quantize(two_full, exact(0.5 - 1e-15)), 16383);
        assert_eq!(quantize(-two_full, exact(-0.5 + 1e-15)), -16383);
    }

    #[test]
    fn a_tone_program_sounds_and_swings_both_ways() {
        let mut programs = blank_programs();
        // note_type speed 4 volume 15 fade 0, octave 4, note C length 16,
        // then end.
        header(&mut programs, 0, 0x4000, 0x4100);
        put(
            &mut programs,
            0,
            0x4100,
            &[0xd4, 0xf0, 0xe4, 0x0f, 0xff],
        );
        let mut audio = Audio::new();
        audio.play_music(&programs, 0, 0x4000, 1, music_flag::LOOP);
        assert!(audio.music_playing());
        let pcm = audio.render_vec(&programs, 4096);
        assert!(pcm.iter().any(|&v| v > 0), "no positive swing");
        assert!(pcm.iter().any(|&v| v < 0), "no negative swing");
        let peak = pcm.iter().map(|&v| (v as i32).abs()).max().unwrap();
        // One channel at volume 15 is a quarter of full scale.
        assert!(peak > 8000, "peak {peak}");
    }

    #[test]
    fn a_higher_octave_crosses_zero_more_often() {
        let crossings = |octave_cmd: u8| {
            let mut programs = blank_programs();
            header(&mut programs, 0, 0x4000, 0x4100);
            put(
                &mut programs,
                0,
                0x4100,
                &[0xd4, 0xf0, octave_cmd, 0x0f, 0xff],
            );
            let mut audio = Audio::new();
            audio.play_music(&programs, 0, 0x4000, 1, 0);
            let pcm = audio.render_vec(&programs, 8820); // 200 ms
            pcm.chunks_exact(2)
                .collect::<Vec<_>>()
                .windows(2)
                .filter(|w| (w[0][0] >= 0) != (w[1][0] >= 0))
                .count()
        };
        let low = crossings(0xe4); // octave 4
        let high = crossings(0xe2); // octave 6
        assert!(high > low * 3, "octave 6 {high} vs octave 4 {low}");
    }

    #[test]
    fn silence_renders_silence_and_an_ended_program_stops() {
        let mut programs = blank_programs();
        header(&mut programs, 0, 0x4000, 0x4100);
        put(&mut programs, 0, 0x4100, &[0xc4, 0xff]); // rest, end
        let mut audio = Audio::new();
        audio.play_music(&programs, 0, 0x4000, 1, 0);
        let pcm = audio.render_vec(&programs, 8192);
        assert!(pcm.iter().all(|&v| v == 0));
    }

    #[test]
    fn rendering_is_a_pure_function_of_the_ops() {
        let mut programs = blank_programs();
        header(&mut programs, 0, 0x4000, 0x4100);
        put(&mut programs, 0, 0x4100, &[0xd4, 0xf0, 0xe4, 0x0f, 0xff]);
        let run = || {
            let mut audio = Audio::new();
            audio.play_music(&programs, 0, 0x4000, 1, music_flag::LOOP);
            audio.render_vec(&programs, 3000)
        };
        assert_eq!(run(), run());
        // And splitting the request changes nothing.
        let mut audio = Audio::new();
        audio.play_music(&programs, 0, 0x4000, 1, music_flag::LOOP);
        let mut split = audio.render_vec(&programs, 1000);
        split.extend(audio.render_vec(&programs, 2000));
        assert_eq!(split, run());
    }

    #[test]
    fn a_garbage_program_is_silent_and_never_panics() {
        let programs = blank_programs();
        let mut audio = Audio::new();
        // Out-of-window address, bank past the end, engine past the table.
        audio.play_music(&programs, 0, 0x0000, 1, 0);
        audio.play_music(&programs, 99, 0x4000, 1, 0);
        audio.play_music(&programs, 0, 0x4000, 77, 0);
        audio.play_sfx(&programs, 0, 0xffff, 1, 0, AUDIO_SFX_TEMPO, 0);
        audio.play_cry(&programs, 0, 0x7fff, 1, 0, 4);
        assert!(audio.render_vec(&programs, 512).iter().all(|&v| v == 0));
    }

    #[test]
    fn a_fanfare_pauses_the_song_and_hands_it_back() {
        let mut programs = blank_programs();
        header(&mut programs, 0, 0x4000, 0x4100);
        put(&mut programs, 0, 0x4100, &[0xd4, 0xf0, 0xe4, 0x0f, 0xff]);
        // An SFX channel (descriptor 4 -> channel 5) with one short note.
        // Bits 6-7 of the first byte are the channel COUNT, so 0x04 is one
        // channel whose low nibble names hardware channel 1 as an SFX.
        put(&mut programs, 0, 0x4200, &[0x04, 0x00, 0x43]);
        put(&mut programs, 0, 0x4300, &[0x20, 0xf0, 0x00, 0x07, 0xff]);
        let mut audio = Audio::new();
        audio.play_music(&programs, 0, 0x4000, 1, music_flag::LOOP);
        let before = audio.render_vec(&programs, 256);
        assert!(before.iter().any(|&v| v != 0));
        audio.play_sfx(&programs, 0, 0x4200, 1, 0, AUDIO_SFX_TEMPO, sfx_flag::DUCK);
        audio.render_vec(&programs, 64);
        assert!(audio.music_playing(), "the fanfare must not stop the song");
        // Once the one-shot drains, the song is audible again.
        audio.render_vec(&programs, 44100);
        assert!(!audio.effect_playing());
        assert!(audio.render_vec(&programs, 512).iter().any(|&v| v != 0));
    }

    #[test]
    fn the_fade_walks_the_volume_down_and_stops_the_song() {
        let mut programs = blank_programs();
        header(&mut programs, 0, 0x4000, 0x4100);
        put(&mut programs, 0, 0x4100, &[0xd4, 0xf0, 0xe4, 0x0f, 0xff]);
        let mut audio = Audio::new();
        audio.play_music(&programs, 0, 0x4000, 1, music_flag::LOOP);
        audio.fade_music(2);
        assert_eq!(audio.level(), AUDIO_FADE_LEVELS);
        for _ in 0..2 {
            audio.tick();
        }
        assert_eq!(audio.level(), AUDIO_FADE_LEVELS - 1);
        let quiet = audio.render_vec(&programs, 512);
        for _ in 0..2 * (AUDIO_FADE_LEVELS - 1) {
            audio.tick();
        }
        assert!(!audio.music_playing(), "the fade must end the song");
        assert!(audio.render_vec(&programs, 512).iter().all(|&v| v == 0));
        assert!(quiet.iter().any(|&v| v != 0));
    }

    #[test]
    fn the_rate_must_divide_the_hardware_rate() {
        let mut audio = Audio::new();
        assert!(audio.set_rate(11025));
        assert_eq!(audio.rate(), 11025);
        assert!(!audio.set_rate(48000));
        assert!(!audio.set_rate(0));
        assert_eq!(audio.rate(), 11025);
    }

    // -----------------------------------------------------------------------
    // The Gen 2 driver (ChipSynth.lua@bdfac727)
    // -----------------------------------------------------------------------

    const G2: u32 = AUDIO_ENGINE_GEN2 as u32;

    fn gen2_opts() -> ProgramOpts {
        ProgramOpts {
            allow_loops: true,
            frequency_offset: 0,
            frame_ticks: None,
            cry_length: None,
            mono: false,
            gen2: true,
            stereo: false,
        }
    }

    fn gen2_state() -> EngineState {
        EngineState {
            tempo: 0x100,
            pan: 0xff,
            stereo: false,
        }
    }

    /// A Gen 2 music channel (hardware 1) reading `program` at 0x4100.
    fn gen2_channel(programs: &mut [u8], program: &[u8]) -> Channel {
        put(programs, 0, 0x4100, program);
        Channel::new(0, 1, 0x4100, &gen2_opts(), AUDIO_FRAME_TICKS)
    }

    /// Every event the channel yields until it ends: (kind, register,
    /// frames), at most `n`.
    fn gen2_events(ch: &mut Channel, st: &mut EngineState, programs: &[u8], n: usize) -> Vec<(Kind, u16, u32)> {
        let mut out = Vec::new();
        while out.len() < n {
            let before = ch.time_ticks;
            let Some(e) = ch.next_event(st, programs, 44100) else {
                break;
            };
            let frames = ((ch.time_ticks - before) / AUDIO_FRAME_TICKS as u64) as u32;
            out.push((e.kind, e.register, frames));
        }
        out
    }

    #[test]
    fn gen2_notes_use_the_gen2_frequency_table_octave_and_transpose() {
        let mut programs = blank_programs();
        // octave 4, note_type 12 / $f0, C len 1; transpose +1 octave +2
        // pitches, C len 1; rest len 1; end
        let mut ch = gen2_channel(
            &mut programs,
            &[0xd4, 0xd8, 0x0c, 0xf0, 0x10, 0xd9, 0x12, 0x10, 0x00, 0xff],
        );
        let mut st = gen2_state();
        let ev = gen2_events(&mut ch, &mut st, &programs, 8);
        // $f82c - $10000 = -2004; >> (7 - 4) = -251 -> 2048 - 251
        // length nibble 0: (0 + 1) * 12 frames at tempo $100
        assert_eq!(ev[0], (Kind::Tone, 1797, 12));
        // pitch 1 + 2 = D (table $f907 = -1785), octave 5: >> 2 = -447
        assert_eq!(ev[1], (Kind::Tone, 2048 - 447, 12));
        // pitch 0 is the rest, still timed by note_type
        assert_eq!(ev[2].0, Kind::Silence);
        assert_eq!(ev[2].2, 12);
        assert_eq!(ev.len(), 3);
        assert!(ch.ended);
    }

    #[test]
    fn gen2_note_duration_truncates_and_carries_like_set_note_duration() {
        let mut programs = blank_programs();
        // note_type 12, tempo $0085, then two C notes of length 4:
        // low = 4 * 12 = 48; 133 * 48 = 6384 -> 24 frames, carry 240;
        // 6384 + 240 = 6624 -> 25 frames, carry 224
        let mut ch = gen2_channel(
            &mut programs,
            &[0xd4, 0xd8, 0x0c, 0xf0, 0xda, 0x00, 0x85, 0x13, 0x13, 0xff],
        );
        let mut st = gen2_state();
        let ev = gen2_events(&mut ch, &mut st, &programs, 4);
        assert_eq!(st.tempo, 0x85);
        assert_eq!(ev[0].2, 24);
        assert_eq!(ev[1].2, 25);
        assert_eq!(ch.duration_modifier, 224);
        // tempo_relative -$05 on a fresh state
        let mut ch = gen2_channel(&mut programs, &[0xe9, 0xfb, 0xff]);
        let mut st = gen2_state();
        gen2_events(&mut ch, &mut st, &programs, 1);
        assert_eq!(st.tempo, 0x100 - 5);
    }

    #[test]
    fn gen2_call_loop_and_conditional_jump_follow_the_gen2_opcodes() {
        let mut programs = blank_programs();
        // $fe call sub; $fd loop 3 back to the call; $fa cond 1; $fb jump
        // if 1 past a D note; C; end. sub: E note, ret.
        let mut ch = gen2_channel(
            &mut programs,
            &[
                0xd4, 0xd8, 0x01, 0xf0, // 0x4100 octave, note_type 1
                0xfe, 0x00, 0x42, // 0x4104 call 0x4200
                0xfd, 0x03, 0x04, 0x41, // 0x4107 loop 3 -> 0x4104
                0xfa, 0x01, // 0x410b set_condition 1
                0xfb, 0x01, 0x12, 0x41, // 0x410d jump_if 1 -> 0x4112
                0x30, // 0x4111 D (skipped)
                0x10, // 0x4112 C
                0xff,
            ],
        );
        put(&mut programs, 0, 0x4200, &[0x50, 0xff]); // E, ret
        let mut st = gen2_state();
        let ev = gen2_events(&mut ch, &mut st, &programs, 10);
        let regs: Vec<u16> = ev.iter().map(|e| e.1).collect();
        let e = ch.frequency_gen2(5, Some(4));
        let c = ch.frequency_gen2(1, Some(4));
        assert_eq!(regs, vec![e, e, e, c]);
        // $fd 0 with loops refused ends the channel
        let mut programs = blank_programs();
        let mut ch = gen2_channel(&mut programs, &[0x10, 0xfd, 0x00, 0x00, 0x41]);
        ch.allow_loops = false;
        let mut st = gen2_state();
        assert_eq!(gen2_events(&mut ch, &mut st, &programs, 5).len(), 1);
    }

    #[test]
    fn gen2_sfx_rows_carry_their_own_length_envelope_and_register() {
        let mut programs = blank_programs();
        // square_note 3, $f0, $0700 on an sfx channel (5 = hardware 1)
        put(&mut programs, 0, 0x4100, &[0x03, 0xf1, 0x00, 0x07, 0xff]);
        let mut opts = gen2_opts();
        opts.frequency_offset = 0x10;
        let mut ch = Channel::new(0, 5, 0x4100, &opts, 0x100);
        let mut st = gen2_state();
        let e = ch.next_event(&mut st, &programs, 44100).unwrap();
        assert_eq!(e.kind, Kind::Tone);
        // the whole command byte is the length: (3 + 1) * 1 * $100 -> 4
        assert_eq!(ch.time_ticks, 4 * AUDIO_FRAME_TICKS as u64);
        assert_eq!((e.register, e.volume, e.fade), (0x710, 15, 1));
        // A cry's length is its tempo WORD: $200 * LOW((127 + 1) * 1) is
        // $10000, whose low 16 bits are 0 -> the one-frame floor. The
        // truncation is load bearing (@bdfac727:406-408).
        let mut programs = blank_programs();
        put(&mut programs, 0, 0x4100, &[0x7f, 0xf0, 0x00, 0x07, 0xff]);
        let mut ch = Channel::new(0, 5, 0x4100, &gen2_opts(), 0x200);
        let mut st = gen2_state();
        ch.next_event(&mut st, &programs, 44100).unwrap();
        assert_eq!(ch.time_ticks, AUDIO_FRAME_TICKS as u64);
        // and a Gen 2 cry program is built with that word, no $80 base
        let mut programs = blank_programs();
        put(&mut programs, 0, 0x4000, &[0x04, 0x00, 0x41]);
        let mut opts = gen2_opts();
        opts.cry_length = Some(0x200);
        let p = Program::build(&programs, 0, 0x4000, AUDIO_ENGINE_GEN2, &opts).unwrap();
        assert_eq!(p.channels[0].frame_ticks, 0x200);
    }

    /// A Drumkits table at 0x5000 whose kit 0 drum 1 is one two-frame
    /// segment at volume 10, fade 1 (so it rings ~9 frames past its end).
    fn gen2_drumkit(programs: &mut [u8]) {
        put(programs, 0, 0x5000, &[0x10, 0x50]); // kit 0 -> 0x5010
        put(programs, 0, 0x5010, &[0x00, 0x00, 0x40, 0x50]); // drum 1 -> 0x5040
        put(programs, 0, 0x5040, &[0x21, 0xa1, 0x33, 0xff]);
    }

    #[test]
    fn gen2_drums_come_from_the_kit_and_ring_through_the_rest() {
        let mut programs = blank_programs();
        gen2_drumkit(&mut programs);
        // noise channel (descriptor 3): toggle_noise kit 0, drum_speed 1,
        // drum 1 for one frame, rest for eight, end
        put(&mut programs, 0, 0x4000, &[0x03, 0x00, 0x41]);
        put(&mut programs, 0, 0x4100, &[0xe3, 0x00, 0xd8, 0x01, 0x10, 0x07, 0xff]);
        let mut audio = Audio::new();
        audio.pin_drum(G2, 0, 0, 0x5000);
        audio.play_music(&programs, 0, 0x4000, G2, 0);
        let pcm = audio.render_vec(&programs, 735 * 10);
        let at = |frame: usize| &pcm[frame * 735 * 2..(frame + 1) * 735 * 2];
        assert!(at(0).iter().any(|&v| v != 0), "the drum strikes");
        // frames 2..5 are the rest; the drum's segment ended at frame 2,
        // its envelope keeps it sounding
        assert!(at(3).iter().any(|&v| v != 0), "the tail rings through the rest");
        // without the kit pinned the same program is silent
        let mut audio = Audio::new();
        audio.play_music(&programs, 0, 0x4000, G2, 0);
        assert!(audio.render_vec(&programs, 735 * 4).iter().all(|&v| v == 0));
        // the decode: one segment, extended by volume * fade / 64 s
        let segs = read_drum_gen2(&programs, Pin { set: true, bank: 0, address: 0x5000 }, 0, 1, 44100);
        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0].start, 0);
        assert_eq!(segs[0].end, (10 * 44100 + 32) / 64);
        assert_eq!(segs[0].parameter, 0x33);
    }

    #[test]
    fn gen2_stereo_panning_needs_the_option_but_forced_panning_does_not() {
        let mut programs = blank_programs();
        header(&mut programs, 0, 0x4000, 0x4100);
        // stereo_panning $10 (channel 1 left only), a long note, end
        put(&mut programs, 0, 0x4100, &[0xd4, 0xd8, 0x0c, 0xf0, 0xef, 0x10, 0x1f, 0xff]);
        let sides = |programs: &[u8], flags: u32| {
            let mut audio = Audio::new();
            audio.play_music(programs, 0, 0x4000, G2, flags);
            let pcm = audio.render_vec(programs, 2000);
            let l = pcm.iter().step_by(2).any(|&v| v != 0);
            let r = pcm.iter().skip(1).step_by(2).any(|&v| v != 0);
            (l, r)
        };
        assert_eq!(sides(&programs, 0), (true, true), "MONO ignores stereo_panning");
        assert_eq!(sides(&programs, music_flag::STEREO), (true, false));
        // force_stereo_panning $01 (right only) pans under MONO too
        put(&mut programs, 0, 0x4104, &[0xe4, 0x01]);
        assert_eq!(sides(&programs, 0), (false, true));
    }

    #[test]
    fn resume_keeps_the_song_and_cancels_the_fade() {
        let mut programs = blank_programs();
        header(&mut programs, 0, 0x4000, 0x4100);
        put(&mut programs, 0, 0x4100, &[0xd4, 0xd8, 0x0c, 0xf0, 0x1f, 0xfd, 0x00, 0x04, 0x41]);
        let mut audio = Audio::new();
        audio.play_music(&programs, 0, 0x4000, G2, music_flag::LOOP);
        audio.render_vec(&programs, 1000);
        audio.fade_music(1);
        audio.tick();
        assert_eq!(audio.level(), AUDIO_FADE_LEVELS - 1);
        let frames = audio.music.as_ref().unwrap().frames;
        audio.play_music(&programs, 0, 0x4000, G2, music_flag::LOOP | music_flag::RESUME);
        assert_eq!(audio.level(), AUDIO_FADE_LEVELS);
        assert_eq!(audio.music.as_ref().unwrap().frames, frames, "not restarted");
        for _ in 0..20 {
            audio.tick();
        }
        assert!(audio.music_playing(), "the fade is gone");
    }

    #[test]
    fn the_stop_flag_cuts_the_one_shot_and_the_alarm_loops_until_stopped() {
        let mut programs = blank_programs();
        put(&mut programs, 0, 0x4200, &[0x04, 0x00, 0x43]);
        put(&mut programs, 0, 0x4300, &[0x7f, 0xf0, 0x00, 0x07, 0xff]);
        let mut audio = Audio::new();
        audio.play_sfx(&programs, 0, 0x4200, G2, 0, AUDIO_SFX_TEMPO, 0);
        audio.render_vec(&programs, 10);
        assert!(audio.effect_playing());
        audio.op(op::SFX, &[0, 0, 0, 0, 0, sfx_flag::STOP as i32]);
        audio.render_vec(&programs, 1);
        assert!(!audio.effect_playing());
        // the siren: two tones, a quarter of full scale, both sides
        audio.op(op::SFX, &[0, 0, 0, 0, 0, sfx_flag::ALARM as i32]);
        let pcm = audio.render_vec(&programs, 88200);
        assert!(audio.alarm_playing());
        let peak = pcm.iter().map(|&v| (v as i32).abs()).max().unwrap();
        assert_eq!(peak, (32767 + 2) / 4);
        assert!(pcm.iter().step_by(2).zip(pcm.iter().skip(1).step_by(2)).all(|(l, r)| l == r));
        // it loops on a one-second buffer
        assert_eq!(&pcm[..88200], &pcm[88200..]);
        audio.op(op::SFX, &[0, 0, 0, 0, 0, (sfx_flag::ALARM | sfx_flag::STOP) as i32]);
        assert!(audio.render_vec(&programs, 100).iter().all(|&v| v == 0));
    }

    // --- against the real Gold ROM, when it has been imported --------------

    /// dist/voxelmon/gold/gen: (programs.bin, audio.json), or None.
    fn gold_audio() -> Option<(Vec<u8>, String)> {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../dist/voxelmon/gold/gen");
        let programs = std::fs::read(dir.join("programs.bin")).ok()?;
        let json = std::fs::read_to_string(dir.join("audio.json")).ok()?;
        Some((programs, json))
    }

    /// The first integer after `field` following `key` in the importer's
    /// compact JSON. Enough for {bank, address} lookups in a test.
    fn json_int(json: &str, key: &str, field: &str) -> u32 {
        let from = json.find(key).unwrap_or_else(|| panic!("{key} not in audio.json"));
        let rest = &json[from..];
        let at = rest.find(field).unwrap() + field.len();
        let digits: String = rest[at..].chars().skip_while(|c| !c.is_ascii_digit()).take_while(|c| c.is_ascii_digit()).collect();
        digits.parse().unwrap()
    }

    fn gold_slot(json: &str, bank: u32) -> u32 {
        let from = json.find("\"bankOrder\":[").unwrap() + 13;
        let list = &json[from..from + json[from..].find(']').unwrap()];
        list.split(',').position(|b| b.trim().parse::<u32>().unwrap() == bank).unwrap() as u32
    }

    /// An Audio with Gold's wave and drum tables pinned, as the guest does.
    fn gold_synth(json: &str, rate: u32) -> Audio {
        let mut audio = Audio::new();
        assert!(audio.set_rate(rate));
        let wb = json_int(json, "\"waveBanks\"", "\"bank\"");
        let wa = json_int(json, "\"waveBanks\"", "\"address\"");
        audio.pin_waves(G2, gold_slot(json, wb), wa);
        let db = json_int(json, "\"drumkits\"", "\"bank\"");
        let da = json_int(json, "\"drumkits\"", "\"address\"");
        audio.pin_drum(G2, 0, gold_slot(json, db), da);
        audio
    }

    fn gold_song(json: &str, audio: &mut Audio, programs: &[u8], label: &str) {
        let key = format!("\"{label}\":");
        let bank = json_int(json, &key, "\"bank\"");
        let address = json_int(json, &key, "\"address\"");
        audio.play_music(programs, gold_slot(json, bank), address, G2, music_flag::LOOP);
        assert!(audio.music_playing(), "{label} did not build");
    }

    #[test]
    fn gold_new_bark_town_opens_audibly_and_deterministically() {
        let Some((programs, json)) = gold_audio() else {
            return; // Gold not imported on this machine
        };
        let render = |split: bool| {
            let mut audio = gold_synth(&json, 44100);
            gold_song(&json, &mut audio, &programs, "Music_NewBarkTown");
            if split {
                let mut v = audio.render_vec(&programs, 10000);
                v.extend(audio.render_vec(&programs, 34100));
                v
            } else {
                audio.render_vec(&programs, 44100)
            }
        };
        let first = render(false);
        let nonzero = first.iter().filter(|&&v| v != 0).count();
        assert!(nonzero > first.len() / 2, "only {nonzero} non-zero samples");
        let peak = first.iter().map(|&v| (v as i32).abs()).max().unwrap();
        assert!(peak > 4000, "peak {peak}");
        assert_eq!(first, render(false));
        assert_eq!(first, render(true));
        // New Bark Town is `channel_count 3` (two pulses and the wave);
        // Route 29 adds the drums. Every channel is still going after 2 s.
        let mut audio = gold_synth(&json, 44100);
        gold_song(&json, &mut audio, &programs, "Music_NewBarkTown");
        audio.render_vec(&programs, 88200);
        let song = audio.music.as_ref().unwrap();
        assert_eq!(song.channels.len(), 3);
        assert!(song.channels.iter().all(|c| !c.ended));
        assert!(audio.tables[AUDIO_ENGINE_GEN2].has_waves);
        let mut audio = gold_synth(&json, 44100);
        gold_song(&json, &mut audio, &programs, "Music_Route29");
        assert!(audio.render_vec(&programs, 88200).iter().any(|&v| v != 0));
        let song = audio.music.as_ref().unwrap();
        assert_eq!(song.channels.len(), 4);
        assert!(song.channels.iter().all(|c| !c.ended));
        assert!(song.channels[3].noise_sampling, "Route 29's drums are on");
        assert!(audio.tables[AUDIO_ENGINE_GEN2].kits.iter().any(|k| !k.is_empty()));
    }

    #[test]
    fn gold_cries_and_sfx_render_and_end() {
        let Some((programs, json)) = gold_audio() else {
            return;
        };
        let mut audio = gold_synth(&json, 44100);
        let key = "\"CHIKORITA\":";
        let bank = json_int(&json, key, "\"bank\"");
        let address = json_int(&json, key, "\"address\"");
        let pitch = json_int(&json, key, "\"pitch\"");
        let length = json_int(&json, key, "\"length\"");
        audio.play_cry(&programs, gold_slot(&json, bank), address, G2, pitch as i32, length);
        assert!(audio.effect_playing());
        let pcm = audio.render_vec(&programs, 44100 * 3);
        assert!(pcm.iter().any(|&v| v != 0));
        assert!(!audio.effect_playing(), "a cry is well under three seconds");
        let key = "\"Sfx_ReadText\":";
        let bank = json_int(&json, key, "\"bank\"");
        let address = json_int(&json, key, "\"address\"");
        audio.play_sfx(&programs, gold_slot(&json, bank), address, G2, 0, AUDIO_SFX_TEMPO, 0);
        let pcm = audio.render_vec(&programs, 44100);
        assert!(pcm.iter().any(|&v| v != 0));
        assert!(!audio.effect_playing());
    }

    /// Offline listening copies: with PV_GEN2_WAV_DIR set, 40 s of New Bark
    /// Town and of Route 29 as 44.1 kHz stereo WAVs.
    #[test]
    fn gold_offline_wavs_when_asked() {
        let Ok(dir) = std::env::var("PV_GEN2_WAV_DIR") else {
            return;
        };
        let Some((programs, json)) = gold_audio() else {
            return;
        };
        for (label, file) in [("Music_NewBarkTown", "new_bark_town.wav"), ("Music_Route29", "route_29.wav")] {
            let mut audio = gold_synth(&json, 44100);
            gold_song(&json, &mut audio, &programs, label);
            let pcm = audio.render_vec(&programs, 44100 * 40);
            let mut wav = Vec::new();
            let data = (pcm.len() * 2) as u32;
            wav.extend_from_slice(b"RIFF");
            wav.extend_from_slice(&(36 + data).to_le_bytes());
            wav.extend_from_slice(b"WAVEfmt ");
            wav.extend_from_slice(&16u32.to_le_bytes());
            wav.extend_from_slice(&1u16.to_le_bytes());
            wav.extend_from_slice(&2u16.to_le_bytes());
            wav.extend_from_slice(&44100u32.to_le_bytes());
            wav.extend_from_slice(&(44100u32 * 4).to_le_bytes());
            wav.extend_from_slice(&4u16.to_le_bytes());
            wav.extend_from_slice(&16u16.to_le_bytes());
            wav.extend_from_slice(b"data");
            wav.extend_from_slice(&data.to_le_bytes());
            for s in pcm {
                wav.extend_from_slice(&s.to_le_bytes());
            }
            std::fs::write(std::path::Path::new(&dir).join(file), wav).unwrap();
        }
    }
}
