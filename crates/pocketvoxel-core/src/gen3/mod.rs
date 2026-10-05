// Port of gen1recomp src/core/game3/m4a_*.lua (GPLv3 + additional terms; see crates/pocketvoxel-core/src/gen3/LICENSE.md).

//! The FireRed/LeafGreen M4A (MP2K) sound engine, ported from gen1recomp's
//! Lua (pinned worktree `~/gen1recomp-latest`) module for module:
//!
//! | Lua                                 | Rust                 |
//! |-------------------------------------|----------------------|
//! | `src/core/game3/m4a_seq.lua`        | [`m4a_seq`]          |
//! | `src/core/game3/m4a_mix.lua`        | [`m4a_mix`]          |
//! | `src/core/game3/m4a_player.lua`     | [`m4a_player`]       |
//! | `src/core/game3/m4a_sample.lua`     | [`m4a_sample`]       |
//! | `m4a_worker.lua` + the playback half of `audio.lua` | [`engine`] |
//! | the audio pack `m4a_player.loadPack` reads | [`pack`] (blob + builder) |
//!
//! `src/core/ChipSynth.lua` contributes only `SAMPLE_RATE` to `m4a_mix`
//! (the CGB oscillators live in `m4a_mix.lua` itself), so it has no module
//! here: the rate is the engine's constructor argument.
//!
//! This whole folder is GPLv3 with Brian's Additional Terms and compiles only
//! under the crate's `gen3` feature, so the MIT games' binaries never
//! contain it (docs/firered-engine.md §Source and licence).
//!
//! # Threading model
//!
//! The Lua runs the BGM sequencer in a `love.thread` worker that fills
//! 8192-sample QueueableSource buffers, and bakes SEs/fanfares/cries into
//! static Sources on demand. Here there are no threads: the host calls
//! [`engine::M4a::render`] from its audio callback and every player is
//! rendered lazily, sample-exact with what the Lua's bake or worker would
//! have put in the buffer (see [`engine`] for the exact correspondences).
//! `audio.lua` itself (song policy, fades, ducking, fanfare countdown,
//! cry timers) stays in the guest; the engine exposes what it needs.
//!
//! # Numbers
//!
//! Lua numbers are doubles; this port keeps every value that reaches the
//! output in `f64` and repeats the Lua's operations in the Lua's order,
//! with Lua's `%` ([`lmod`]) and `math.floor` ([`floor`]). On desktop
//! (glibc `exp`/`pow` on both sides) the result is bit-identical to the Lua:
//! `tests.rs` compares against a luajit oracle written by
//! `tools/gen3/m4a_oracle.sh` (every song, SE bake and cry).
//!
//! # The audio pack blob (`M4AP`, version 1)
//!
//! The importer writes Brian's cache tree (`data/generated/gba/audio/`:
//! `index.lua`, `samples.bin`, `songs/<id>.bin`, ...). For the 3DS the cook
//! serialises the parts the engine reads into ONE little-endian blob;
//! [`pack::build_blob`] is the reference builder (from the cache files) and
//! [`pack::AudioPack::from_blob`] the reader. All integers are LE; all
//! offsets are absolute from the start of the blob; every block starts on a
//! 4-byte boundary (zero padding).
//!
//! ```text
//! Header (64 bytes, u32 each)
//!   0x00 magic "M4AP"            0x04 version = 1
//!   0x08 songCount               0x0C songsOff    -> songCount   x SongRec   (index = song id)
//!   0x10 sampleCount             0x14 samplesOff  -> sampleCount x SampleRec (index = sample id)
//!   0x18 vgCount                 0x1C vgOff       -> vgCount     x u32 ToneBlock offset, 0 = absent
//!                                                    (index = voicegroup id)
//!   0x20 cryCount                0x24 criesOff    -> cryCount    x i32 sampleId, -1 = no cry / no
//!                                                    sampleId (index = cry index, index.cries)
//!   0x28 cryIdCount              0x2C cryIdsOff   -> cryIdCount  x i32 cry index, -1 = absent
//!                                                    (index = species, index.cryIds)
//!   0x30 pcmOff                  0x34 pcmLen      -> samples.bin verbatim
//!   0x38 0                       0x3C 0
//!
//! SongRec (40 bytes): u32 flags, i32 voicegroupId, i32 reverb, i32 sampleId,
//!   i32 player, i32 fanfareFrames, u32 binOff, u32 binLen, u32 0, u32 0
//!   flags: bit0 index.songs[id] present   bit1 voicegroupId  bit2 reverb
//!          bit3 sampleId   bit4 player   bit5 hasGoto present   bit6 hasGoto true
//!          bit7 fanfareFrames present (index.fanfares[id].frames)
//!          bit8 songs/<id>.bin present (binOff/binLen; the file verbatim)
//!   (a field whose bit is clear is Lua nil; its i32 slot is 0)
//!
//! SampleRec (24 bytes): u32 present (0/1), u32 offset, u32 size, u32 freq,
//!   u32 loopStart, u32 status        (index.samples[id]; a missing field is 0,
//!                                     which is what every Lua read defaults to)
//!
//! ToneBlock: 128 x ToneRec (index = voice number 0..127)
//! ToneRec (56 bytes): u32 flags, i32 type, key, length, pan, sampleId, attack,
//!   decay, sustain, release, wavParam, subVgId, u32 keySplitOff, u32 waveOff
//!   flags: bit0 tone present; bits 1..11 the eleven i32 fields above, in order
//!          (clear = Lua nil); bit12 keySplit -> 128 bytes, byte k = keySplit[k]
//!          (a missing key is 0, as the Lua's `or 0`); bit13 wave -> u8 n, then
//!          n bytes wave[1..n] (the CGB wave nibbles)
//! ```
//!
//! Every value in the reference cache is an integer that fits these widths;
//! the builder refuses anything else. Lua-literal files are parsed by the
//! restricted reader in [`lualit`] (the TypeScript cook does the same
//! with its own Lua-literal reader and writes this exact layout).

pub mod engine;
pub mod lualit;
pub mod m4a_mix;
pub mod m4a_player;
pub mod m4a_sample;
pub mod m4a_seq;
pub mod pack;

pub use engine::{CryParams, M4a, SeOptions};
pub use pack::{AudioPack, build_blob};

/// f64 libm shim: std on desktop/3DS, libm on no_std targets.
#[cfg(feature = "std")]
mod fm {
    #[inline]
    pub fn floor(x: f64) -> f64 {
        x.floor()
    }
    #[inline]
    pub fn ceil(x: f64) -> f64 {
        x.ceil()
    }
    #[inline]
    pub fn exp(x: f64) -> f64 {
        x.exp()
    }
    #[inline]
    pub fn pow(x: f64, y: f64) -> f64 {
        x.powf(y)
    }
}

#[cfg(not(feature = "std"))]
mod fm {
    pub use libm::{ceil, exp, floor, pow};
}

pub(crate) use fm::{ceil, exp, floor, pow};

/// Lua's `a % b` for numbers (LuaJIT `vm_mod`: `a - floor(a/b)*b`), which
/// differs from Rust's `%` for negative operands and in rounding.
#[inline]
pub(crate) fn lmod(a: f64, b: f64) -> f64 {
    a - floor(a / b) * b
}

/// `2 ^ k` for a small non-negative integer `k`, exact (the Lua divides by
/// `2 ^ math.floor(s / 16)`).
#[inline]
pub(crate) fn pow2i(k: f64) -> f64 {
    let mut r = 1.0;
    let mut i = 0.0;
    while i < k {
        r *= 2.0;
        i += 1.0;
    }
    r
}

#[cfg(test)]
mod tests;
