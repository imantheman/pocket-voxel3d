//! pocket-voxel 3DS host for the gen3 (FireRed) port (GPLv3 + additional
//! terms; see LICENSE.md). FireRed's sound: the core's M4A engine
//! (pocketvoxel-core/src/gen3, a sample-identical port of gen1recomp's Lua)
//! rendered by an audio thread into NDSP, and the guest's G3Audio natives
//! (g3_shim.c) that drive it.
//!
//! - **Boot.** The engine reads one `M4AP` blob. It is built from the
//!   importer's audio cache on the card (`data/generated/gba/audio/`:
//!   index.lua + samples.bin + songs/*.bin) with the core's reference
//!   builder (`build_blob`, Lua literals through `lualit`), once: the result
//!   is kept as `audio.m4ap` beside a key (meta.json's bytes and the sizes of
//!   the files it was built from) and reused while the cache is unchanged.
//! - **Output.** 22050 Hz stereo s16, as the Kanto host (main.rs
//!   AUDIO_RATE), through the same NDSP wrapper (vendor/quickjs/audio_3ds.c:
//!   channel 0, eight wave buffers of one 60 Hz tick each). Instead of the
//!   Kanto host's per-sim-tick pump, a thread keeps QUEUED buffers in flight,
//!   so a long frame on the main thread does not starve the DSP. The thread
//!   runs one priority above the main thread, on core 2 of a New 3DS and on
//!   the application core otherwise.
//! - **Lock.** The engine sits behind one LightLock: the thread holds it for
//!   one buffer's render, the guest's natives for one call.

use core::ffi::c_void;
use core::sync::atomic::{AtomicBool, AtomicU32, Ordering};

use pocketvoxel_core::gen3::{build_blob, AudioPack, CryParams, M4a, SeOptions};

use super::dlog;

const AUDIO_DIR: &str = concat!(g3_root!(), "data/generated/gba/audio/");
const BLOB_PATH: &str = concat!(g3_root!(), "audio.m4ap");
const KEY_PATH: &str = concat!(g3_root!(), "audio.m4ap.key");
/// The start of the key the card cook writes beside its blob (gen3data.ts CARD_AUDIO_KEY).
const CARD_KEY: &[u8] = b"M4AP1 card\n";

/// Output rate: the Kanto host's (and one the M4A oracle tests cover).
pub const RATE: i32 = 22050;
/// Frames per wave buffer: one 60 Hz tick, rounded up (main.rs AUDIO_BUF).
const CHUNK: usize = ((RATE + 59) / 60) as usize;
/// audio_3ds.c NBUF.
const NBUF: i32 = 8;
/// Buffers kept in flight: 4 x 16.7 ms = 67 ms of slack (and of latency).
const QUEUED: i32 = 4;

extern "C" {
    fn audio3ds_init(rate: i32, frames_per_buf: i32) -> i32;
    fn audio3ds_free_frames() -> i32;
    fn audio3ds_queue(pcm: *const i16, frames: i32) -> i32;
    fn audio3ds_exit();
    fn LightLock_Init(lock: *mut i32);
    fn LightLock_Lock(lock: *mut i32);
    fn LightLock_Unlock(lock: *mut i32);
    fn threadCreate(
        entry: extern "C" fn(*mut c_void),
        arg: *mut c_void,
        stack_size: usize,
        prio: i32,
        core_id: i32,
        detached: bool,
    ) -> *mut c_void;
    fn threadJoin(thread: *mut c_void, timeout_ns: u64) -> i32;
    fn threadFree(thread: *mut c_void);
    fn svcSleepThread(ns: i64);
    fn svcGetThreadPriority(out: *mut i32, handle: u32) -> i32;
    fn svcGetSystemTick() -> u64;
    fn APT_CheckNew3DS(out: *mut bool) -> i32;
}

static mut LOCK: i32 = 0;
static mut ENGINE: Option<M4a> = None;
static mut THREAD: *mut c_void = core::ptr::null_mut();
static QUIT: AtomicBool = AtomicBool::new(false);
static NDSP_ON: AtomicBool = AtomicBool::new(false);

// Stats the main loop reads and resets every 5 s (perf line).
static PEAK: AtomicU32 = AtomicU32::new(0);
static RENDER_US: AtomicU32 = AtomicU32::new(0);
static RENDER_MAX_US: AtomicU32 = AtomicU32::new(0);
static BUFFERS: AtomicU32 = AtomicU32::new(0);
static UNDERRUNS: AtomicU32 = AtomicU32::new(0);

fn us_since(t0: u64) -> u32 {
    ((unsafe { svcGetSystemTick() }.wrapping_sub(t0)) as f64 / 268.111856) as u32
}

/// The engine under the lock (None until boot built it).
fn with<R>(f: impl FnOnce(&mut M4a) -> R) -> Option<R> {
    unsafe {
        LightLock_Lock(&raw mut LOCK);
        let r = (*(&raw mut ENGINE)).as_mut().map(f);
        LightLock_Unlock(&raw mut LOCK);
        r
    }
}

fn file_len(path: &str) -> i64 {
    std::fs::metadata(path).map(|m| m.len() as i64).unwrap_or(-1)
}

/// What the cached blob was built from: meta.json (the ROM's sha1, the
/// importer's version and counts) and the sizes of every file read.
fn cache_key(song_files: usize) -> Option<String> {
    let meta = std::fs::read(format!("{AUDIO_DIR}meta.json")).ok()?;
    let mut k = String::from("M4AP1\n");
    k.push_str(&String::from_utf8_lossy(&meta));
    for f in ["index.lua", "samples.bin", "samples.lua", "voicegroups.lua"] {
        k.push_str(&format!("\n{} {}", f, file_len(&format!("{AUDIO_DIR}{f}"))));
    }
    k.push_str(&format!("\nsongs {}\n", song_files));
    Some(k)
}

fn song_files() -> Vec<(u32, String)> {
    let mut v: Vec<(u32, String)> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(format!("{AUDIO_DIR}songs")) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if let Some(id) = name.strip_suffix(".bin").and_then(|s| s.parse::<u32>().ok()) {
                v.push((id, format!("{AUDIO_DIR}songs/{name}")));
            }
        }
    }
    v.sort_by_key(|s| s.0);
    v
}

/// The blob: the cached one when its key matches, else built from the cache
/// (and written for next time).
fn load_blob() -> Result<Vec<u8>, String> {
    let t0 = unsafe { svcGetSystemTick() };
    // a blob the card cook built on the PC (voxelmon/cook/gen3data.ts) comes
    // with a card key: taken as is (the cache is in data.pvpk, where this
    // thread does not look, and its audio sources are not on the card)
    if let Ok(k) = std::fs::read(KEY_PATH) {
        if k.starts_with(CARD_KEY) {
            if let Ok(b) = std::fs::read(BLOB_PATH) {
                if b.len() >= 64 && &b[0..4] == b"M4AP" {
                    dlog(&format!("[pv] g3 sound: the card's audio.m4ap ({} KB) in {:.0} ms",
                        b.len() / 1024, us_since(t0) as f32 / 1000.0));
                    return Ok(b);
                }
            }
        }
    }
    let songs = song_files();
    let key = cache_key(songs.len()).ok_or_else(|| format!("no {AUDIO_DIR}meta.json"))?;
    let t_key = us_since(t0);
    if std::fs::read(KEY_PATH).ok().as_deref() == Some(key.as_bytes()) {
        if let Ok(b) = std::fs::read(BLOB_PATH) {
            if b.len() >= 64 && &b[0..4] == b"M4AP" {
                dlog(&format!(
                    "[pv] g3 sound: audio.m4ap reused ({} KB) in {:.0} ms (key {:.0} ms)",
                    b.len() / 1024, us_since(t0) as f32 / 1000.0, t_key as f32 / 1000.0
                ));
                return Ok(b);
            }
        }
    }
    let t1 = unsafe { svcGetSystemTick() };
    let index = std::fs::read(format!("{AUDIO_DIR}index.lua")).map_err(|e| format!("index.lua: {e}"))?;
    let samples_bin = std::fs::read(format!("{AUDIO_DIR}samples.bin")).unwrap_or_default();
    let samples_lua = std::fs::read(format!("{AUDIO_DIR}samples.lua")).ok();
    let vgs_lua = std::fs::read(format!("{AUDIO_DIR}voicegroups.lua")).ok();
    let mut bins: Vec<(u32, Vec<u8>)> = Vec::with_capacity(songs.len());
    for (id, p) in &songs {
        bins.push((*id, std::fs::read(p).map_err(|e| format!("{p}: {e}"))?));
    }
    let t_read = us_since(t1);
    let t2 = unsafe { svcGetSystemTick() };
    let refs: Vec<(u32, &[u8])> = bins.iter().map(|(i, b)| (*i, &b[..])).collect();
    let blob = build_blob(&index, samples_lua.as_deref(), vgs_lua.as_deref(), &samples_bin, &refs)?;
    let t_build = us_since(t2);
    drop(refs);
    drop(bins);
    drop(index);
    drop(samples_bin);
    let t3 = unsafe { svcGetSystemTick() };
    // the key goes last, so a blob cut short by a power-off is never trusted
    let _ = std::fs::remove_file(KEY_PATH);
    let wrote = std::fs::write(BLOB_PATH, &blob).is_ok() && std::fs::write(KEY_PATH, key.as_bytes()).is_ok();
    dlog(&format!(
        "[pv] g3 sound: blob built from the cache in {:.0} ms (read {} files {:.0} ms, build_blob {:.0} ms), {} KB; audio.m4ap {} in {:.0} ms",
        us_since(t0) as f32 / 1000.0, songs.len() + 4, t_read as f32 / 1000.0, t_build as f32 / 1000.0,
        blob.len() / 1024, if wrote { "written" } else { "NOT written" }, us_since(t3) as f32 / 1000.0
    ));
    Ok(blob)
}

/// One buffer: render under the lock, account, return the peak.
fn render_one(buf: &mut [i16]) {
    let t0 = unsafe { svcGetSystemTick() };
    if with(|m| m.render(buf)).is_none() {
        buf.fill(0);
    }
    let us = us_since(t0);
    RENDER_US.fetch_add(us, Ordering::Relaxed);
    RENDER_MAX_US.fetch_max(us, Ordering::Relaxed);
    let peak = buf.iter().map(|s| s.unsigned_abs() as u32).max().unwrap_or(0);
    PEAK.fetch_max(peak, Ordering::Relaxed);
    BUFFERS.fetch_add(1, Ordering::Relaxed);
    if DUMP_SECS > 0 {
        dump(buf, peak);
    }
}

/// PV_G3_AUDIO_DUMP=<seconds> at build time: the output from the first
/// buffer that is not silent, for that long, written to the card as
/// g3audio_dump.wav (compared with a desktop render of the same calls).
const DUMP_SECS: usize = match option_env!("PV_G3_AUDIO_DUMP") {
    Some(s) => {
        let b = s.as_bytes();
        let mut n = 0usize;
        let mut i = 0;
        while i < b.len() {
            n = n * 10 + (b[i] - b'0') as usize;
            i += 1;
        }
        n
    }
    None => 0,
};
static mut DUMP: Vec<i16> = Vec::new();
static mut DUMP_DONE: bool = false;

fn dump(buf: &[i16], peak: u32) {
    unsafe {
        let d = &mut *(&raw mut DUMP);
        if DUMP_DONE || (d.is_empty() && peak == 0) {
            return;
        }
        d.extend_from_slice(buf);
        if d.len() / 2 < DUMP_SECS * RATE as usize {
            return;
        }
        DUMP_DONE = true;
        let data = d.len() * 2;
        let mut w: Vec<u8> = Vec::with_capacity(44 + data);
        w.extend_from_slice(b"RIFF");
        w.extend_from_slice(&((36 + data) as u32).to_le_bytes());
        w.extend_from_slice(b"WAVEfmt ");
        for v in [16u32, 1 | (2 << 16), RATE as u32, RATE as u32 * 4, 4 | (16 << 16)] {
            w.extend_from_slice(&v.to_le_bytes());
        }
        w.extend_from_slice(b"data");
        w.extend_from_slice(&(data as u32).to_le_bytes());
        for s in d.iter() {
            w.extend_from_slice(&s.to_le_bytes());
        }
        let _ = std::fs::write(concat!(g3_root!(), "g3audio_dump.wav"), &w);
        *d = Vec::new();
    }
}

extern "C" fn audio_thread(_: *mut c_void) {
    let mut buf = vec![0i16; CHUNK * 2];
    let mut primed = false;
    // without NDSP: the same renders on the wall clock, thrown away, so the
    // guest sees SEs, fanfares and cries end when they would on a console
    let mut clock_frames: u64 = 0;
    let t_start = unsafe { svcGetSystemTick() };
    while !QUIT.load(Ordering::Relaxed) {
        if NDSP_ON.load(Ordering::Relaxed) {
            loop {
                let in_flight = NBUF - unsafe { audio3ds_free_frames() } / CHUNK as i32;
                if in_flight >= QUEUED {
                    break;
                }
                if in_flight == 0 && primed {
                    UNDERRUNS.fetch_add(1, Ordering::Relaxed);
                }
                render_one(&mut buf);
                if unsafe { audio3ds_queue(buf.as_ptr(), CHUNK as i32) } == 0 {
                    break;
                }
                primed = true;
            }
        } else {
            let due = (unsafe { svcGetSystemTick() }.wrapping_sub(t_start) as f64 / 268_111_856.0 * RATE as f64) as u64;
            let mut n = 0;
            while clock_frames + CHUNK as u64 <= due && n < NBUF {
                render_one(&mut buf);
                clock_frames += CHUNK as u64;
                n += 1;
            }
            if n == NBUF {
                clock_frames = due; // too far behind: skip ahead
            }
        }
        // a buffer lasts 16.7 ms; look four times per buffer
        unsafe { svcSleepThread(4_000_000) };
    }
}

/// Boot: load or build the blob, make the engine, open NDSP and start the
/// thread. Returns whether sound is on.
pub fn init() -> bool {
    unsafe { LightLock_Init(&raw mut LOCK) };
    let t0 = unsafe { svcGetSystemTick() };
    let blob = match load_blob() {
        Ok(b) => b,
        Err(e) => {
            dlog(&format!("[pv] g3 sound: OFF, no audio pack: {e}"));
            return false;
        }
    };
    let t1 = unsafe { svcGetSystemTick() };
    let pack = match AudioPack::from_blob(blob) {
        Ok(p) => p,
        Err(e) => {
            dlog(&format!("[pv] g3 sound: OFF, bad audio pack: {e}"));
            let _ = std::fs::remove_file(KEY_PATH);
            return false;
        }
    };
    let engine = M4a::new(pack, RATE as u32);
    let t_pack = us_since(t1);
    unsafe {
        LightLock_Lock(&raw mut LOCK);
        ENGINE = Some(engine);
        LightLock_Unlock(&raw mut LOCK);
    }
    dlog(&format!(
        "[pv] g3 sound: engine ready in {:.0} ms (from_blob + M4a::new {:.0} ms), {} Hz",
        us_since(t0) as f32 / 1000.0, t_pack as f32 / 1000.0, RATE
    ));
    // NDSP needs sdmc:/3ds/dspfirm.cdc (a console dumps it once with DSP1)
    let ndsp = unsafe { audio3ds_init(RATE, CHUNK as i32) } != 0;
    NDSP_ON.store(ndsp, Ordering::Relaxed);
    let mut prio = 0x30i32;
    unsafe { svcGetThreadPriority(&mut prio, 0xFFFF_8000) };
    let prio = (prio - 1).clamp(0x18, 0x3F);
    let mut n3ds = false;
    unsafe { APT_CheckNew3DS(&mut n3ds) };
    // PV_G3_AUDIO_CORE=app at build time keeps the thread on the
    // application core on a New 3DS too (to measure the Old 3DS's case)
    let mut core = if n3ds && option_env!("PV_G3_AUDIO_CORE") != Some("app") { 2 } else { -2 };
    let mut t = unsafe { threadCreate(audio_thread, core::ptr::null_mut(), 64 * 1024, prio, core, false) };
    if t.is_null() && core != -2 {
        core = -2;
        t = unsafe { threadCreate(audio_thread, core::ptr::null_mut(), 64 * 1024, prio, core, false) };
    }
    if t.is_null() {
        dlog("[pv] g3 sound: OFF, the audio thread did not start");
        return false;
    }
    unsafe { THREAD = t };
    let core = if core == -2 { String::from("app") } else { format!("{core}") };
    let model = if n3ds { "New 3DS" } else { "Old 3DS" };
    if ndsp {
        dlog(&format!(
            "[pv] g3 sound: on: NDSP {RATE} Hz, {QUEUED} buffers of {CHUNK} frames in flight, thread prio 0x{prio:x} core {core} ({model})"
        ));
    } else {
        dlog(&format!(
            "[pv] g3 sound: NDSP OFF (no sdmc:/3ds/dspfirm.cdc?): the engine runs on the wall clock, unheard; thread prio 0x{prio:x} core {core} ({model})"
        ));
    }
    ndsp
}

/// Stop the thread and close NDSP (before the process exits).
pub fn exit() {
    unsafe {
        if THREAD.is_null() {
            return;
        }
        QUIT.store(true, Ordering::Relaxed);
        threadJoin(THREAD, u64::MAX);
        threadFree(THREAD);
        THREAD = core::ptr::null_mut();
        if NDSP_ON.load(Ordering::Relaxed) {
            audio3ds_exit();
        }
    }
}

/// The perf line's sound part over `secs` seconds, and reset.
pub fn take_stats(secs: f32) -> String {
    let peak = PEAK.swap(0, Ordering::Relaxed);
    let us = RENDER_US.swap(0, Ordering::Relaxed);
    let max = RENDER_MAX_US.swap(0, Ordering::Relaxed);
    let bufs = BUFFERS.swap(0, Ordering::Relaxed);
    let under = UNDERRUNS.swap(0, Ordering::Relaxed);
    format!(
        "sound: peak {} over the last 5 s  render {:.2} ms per 60 Hz tick ({:.1}% of a core, max {:.2} ms/buffer)  {} buffers  {} underruns",
        peak,
        us as f32 / 1000.0 / bufs.max(1) as f32,
        us as f32 / 10_000.0 / secs.max(0.001),
        max as f32 / 1000.0, bufs, under
    )
}

// ---------------------------------------------------------------- natives
// Called by g3_shim.c on the main thread. An id of -1 means "any"/"all";
// a NaN means "not given" (Lua nil).

fn opt(x: f64) -> Option<f64> {
    if x.is_nan() { None } else { Some(x) }
}

fn id_opt(id: i32) -> Option<u16> {
    if id < 0 { None } else { Some(id as u16) }
}

#[no_mangle]
pub extern "C" fn g3a_ready() -> i32 {
    with(|_| ()).is_some() as i32
}

#[no_mangle]
pub extern "C" fn g3a_song_play(id: i32) -> i32 {
    if id < 0 { return 0; }
    with(|m| m.play_song(id as u16)).unwrap_or(false) as i32
}

#[no_mangle]
pub extern "C" fn g3a_song_stop() {
    with(|m| m.stop_song());
}

#[no_mangle]
pub extern "C" fn g3a_song_pause() {
    with(|m| m.pause_song());
}

#[no_mangle]
pub extern "C" fn g3a_song_resume() {
    with(|m| m.resume_song());
}

#[no_mangle]
pub extern "C" fn g3a_song_volume(gain: f64) {
    with(|m| m.set_song_volume(gain));
}

#[no_mangle]
pub extern "C" fn g3a_song() -> i32 {
    with(|m| m.song().map_or(-1, |s| s as i32)).unwrap_or(-1)
}

#[no_mangle]
pub extern "C" fn g3a_song_paused() -> i32 {
    with(|m| m.song_paused()).unwrap_or(false) as i32
}

#[no_mangle]
pub extern "C" fn g3a_mono(mono: i32) {
    with(|m| m.set_mono(mono != 0));
}

/// `looping`: -1 = not given, else 0/1.
#[no_mangle]
pub extern "C" fn g3a_se_play(id: i32, looping: i32, max_sec: f64, pan: f64, gain: f64) -> i32 {
    if id < 0 { return 0; }
    let opts = SeOptions {
        looping: if looping < 0 { None } else { Some(looping != 0) },
        max_sec: opt(max_sec),
        pan: opt(pan).unwrap_or(0.0),
        gain: opt(gain).unwrap_or(1.0),
    };
    with(|m| m.play_se(id as u16, opts)).unwrap_or(false) as i32
}

#[no_mangle]
pub extern "C" fn g3a_se_stop(id: i32) {
    with(|m| m.stop_se(id_opt(id)));
}

#[no_mangle]
pub extern "C" fn g3a_se_playing(id: i32) -> i32 {
    with(|m| m.se_playing(id_opt(id))).unwrap_or(false) as i32
}

#[no_mangle]
pub extern "C" fn g3a_se_pan(pan: f64) -> f64 {
    with(|m| m.set_se_pan(opt(pan).unwrap_or(0.0))).unwrap_or(0.0)
}

#[no_mangle]
pub extern "C" fn g3a_fanfare_play(id: i32, volume: f64) -> i32 {
    if id < 0 { return 0; }
    with(|m| m.play_fanfare(id as u16, opt(volume).unwrap_or(1.0))).unwrap_or(false) as i32
}

#[no_mangle]
pub extern "C" fn g3a_fanfare_playing() -> i32 {
    with(|m| m.fanfare_playing()).unwrap_or(false) as i32
}

#[no_mangle]
pub extern "C" fn g3a_fanfare_stop() {
    with(|m| m.stop_fanfare());
}

/// `ov`: length, release, pitch, chorus, reverse, volume (NaN = the mode's).
/// Returns the cry's frames, or NaN when there is no cry.
#[no_mangle]
pub extern "C" fn g3a_cry_play(species: i32, mode: i32, pan: f64, volume: f64, ov: *const f64) -> f64 {
    if species < 0 { return f64::NAN; }
    let o: [f64; 6] = if ov.is_null() { [f64::NAN; 6] } else { unsafe { *(ov as *const [f64; 6]) } };
    // Sample.cryParams: the mode's fields, the profile's overrides on top
    // (the guest has merged them), volume = mode's or the one given
    let mut p = CryParams::from_mode(mode, opt(o[5]));
    if let Some(v) = opt(o[0]) { p.length = v; }
    if let Some(v) = opt(o[1]) { p.release = v; }
    if let Some(v) = opt(o[2]) { p.pitch = v; }
    if let Some(v) = opt(o[3]) { p.chorus = v; }
    if let Some(v) = opt(o[4]) { p.reverse = v != 0.0; }
    with(|m| m.play_cry(species as u16, &p, opt(pan).unwrap_or(0.0), opt(volume).unwrap_or(1.0)))
        .flatten()
        .unwrap_or(f64::NAN)
}

#[no_mangle]
pub extern "C" fn g3a_cry_stop() {
    with(|m| m.stop_cry());
}

#[no_mangle]
pub extern "C" fn g3a_cry_playing() -> i32 {
    with(|m| m.cry_playing()).unwrap_or(false) as i32
}

#[no_mangle]
pub extern "C" fn g3a_stop_all() {
    with(|m| m.stop_all());
}

