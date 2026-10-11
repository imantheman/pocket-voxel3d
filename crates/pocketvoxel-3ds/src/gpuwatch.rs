//! The GPU watch: a frame the GPU never finishes, said on the log.
//!
//! citro3d-rs begins each frame with C3D_FrameBegin(C3D_FRAME_SYNCDRAW),
//! which waits, with no limit, for the GPU to finish the frame before. When
//! the GPU never does -- a command list it cannot complete -- that wait is
//! the whole console stopping, HOME and all, with nothing on the log past
//! the last line written. On Red, Blue and Yellow the main loop begins the
//! frame here instead (citro3d-rs's own begin then finds the frame already
//! begun and does nothing): the same vblank pacing, then a poll, and after
//! two seconds a line naming the frame still running.
//!
//! A traced frame (vc::tracing, the frames after a VC continue) is also cut
//! at each pass -- world, trees, cards, the tilt blur, the rest of the eye,
//! the bottom screen -- and each part is run and waited for alone, so the
//! log names the pass the GPU stopped in.
//!
//! And a vertex or index buffer is checked before the GPU is handed it: in
//! the linear heap or VRAM, with a physical address, and an index list that
//! stays inside its vertices. One that fails is left out and said once.
//! (Textures need no check of their own: C3D_TexInit refuses a size the GPU
//! cannot take and allocates the data in linear memory or VRAM itself.)

extern "C" {
    fn C3D_FrameSync();
    fn c3d_frame_begin_nb() -> i32;
    fn c3d_split_and_run(keep: i32) -> i32;
    fn c3d_queue_done() -> i32;
    fn c3d_queue_stop();
    fn c3d_queue_room() -> i32;
    fn c3d_gpu_readable(p: *const core::ffi::c_void, len: u32) -> i32;
    fn svcSleepThread(ns: i64);
}

/// Frames begun through begin_frame_watched.
static mut FRAME_NO: u32 = 0;
/// A pass or a frame was given up on: later passes are not waited for.
static mut STUCK: bool = false;

/// How long a frame, or a pass of a traced one, may take before it is said.
const STUCK_MS: f32 = 2000.0;

/// Whether the watch runs: Red, Blue and Yellow (the other games begin
/// their frames as they always have).
pub const ON: bool = !cfg!(any(feature = "gen2", feature = "gen3"));

/// Begin the frame (C3D_FrameBegin), waiting for the GPU to finish the last
/// one as citro3d-rs would, but saying so when it has not after two seconds,
/// and again after ten. It keeps waiting: a GPU that is stuck cannot be
/// taken back from here, but the log now says which frame, and (traced) which
/// pass, it stopped in.
pub unsafe fn begin_frame_watched() {
    FRAME_NO = FRAME_NO.wrapping_add(1);
    let frame_no = FRAME_NO;
    C3D_FrameSync();
    if c3d_frame_begin_nb() != 0 {
        // the GPU is idle: whatever was stuck before has finished
        STUCK = false;
        return;
    }
    let t0 = crate::sys_tick();
    let mut said = 0u8;
    loop {
        svcSleepThread(250_000);
        if c3d_frame_begin_nb() != 0 {
            STUCK = false;
            if said > 0 {
                let late = crate::us_since(t0) / 1000.0;
                if crate::vc::tracing() {
                    crate::dlog_now(&format!(
                        "[pv] vc: trace GPU finished frame {} after all, {:.0} ms late",
                        crate::vc::trace_n() as i64 - 1, late));
                } else {
                    crate::dlog_now(&format!(
                        "[pv] gpu: the frame before {} finished after all, {:.0} ms late", frame_no, late));
                }
            }
            return;
        }
        let ms = crate::us_since(t0) / 1000.0;
        if said == 0 && ms >= STUCK_MS {
            said = 1;
            STUCK = true;
            if crate::vc::tracing() {
                crate::dlog_now(&format!(
                    "[pv] vc: trace GPU still busy with frame {} after 2 s",
                    crate::vc::trace_n() as i64 - 1
                ));
            } else {
                crate::dlog_now(&format!(
                    "[pv] gpu: still busy with the frame before {} after 2 s",
                    frame_no
                ));
            }
        } else if said == 1 && ms >= 10_000.0 {
            said = 2;
            crate::dlog_now("[pv] gpu: still busy after 10 s; waiting on it (HOME cannot answer while it is)");
        }
    }
}

/// Wait for the GPU to finish everything submitted, before memory it may
/// still be reading is freed (a map load between frames). C3D_FrameSync,
/// which the load called for this, only paces to the vblank: it does not
/// look at the GPU at all. Said after two seconds, as a frame is.
pub unsafe fn wait_idle(why: &str) {
    let t0 = crate::sys_tick();
    let mut said = false;
    while c3d_queue_done() == 0 {
        if !said && crate::us_since(t0) / 1000.0 >= STUCK_MS {
            said = true;
            STUCK = true;
            crate::dlog_now(&format!("[pv] gpu: still busy after 2 s, before {}", why));
        }
        svcSleepThread(250_000);
    }
    if said {
        STUCK = false;
        crate::dlog_now(&format!("[pv] gpu: finished after {:.0} ms, before {}", crate::us_since(t0) / 1000.0, why));
    }
}

/// The end of one pass of a traced frame: what was built so far goes to the
/// GPU and is waited for, up to two seconds, and the log says which.
/// Nothing at all outside traced frames, or on a game the watch is off for.
pub fn pass(name: &str) {
    if !ON || !crate::vc::tracing() {
        return;
    }
    unsafe {
        if STUCK {
            crate::vc::trace(&format!("pass {}: not run alone (the GPU is stuck)", name));
            return;
        }
        // Room for the rest of the frame: its other passes, its clears and
        // its display transfers.
        if c3d_split_and_run(14) == 0 {
            crate::vc::trace(&format!("pass {}: not run alone (queue room {})", name, c3d_queue_room()));
            return;
        }
        let t0 = crate::sys_tick();
        loop {
            if c3d_queue_done() != 0 {
                c3d_queue_stop();
                crate::vc::trace(&format!("pass {} done ({:.1} ms)", name, crate::us_since(t0) / 1000.0));
                return;
            }
            if crate::us_since(t0) / 1000.0 >= STUCK_MS {
                STUCK = true;
                crate::vc::trace(&format!("pass {}: GPU stuck", name));
                return;
            }
            svcSleepThread(250_000);
        }
    }
}

/// The said-once bits of `say_once`.
static mut SAID: u32 = 0;

/// A line for the log, said the first time for each `bit` only.
pub fn say_once(bit: u32, line: &str) {
    unsafe {
        if SAID & bit != 0 {
            return;
        }
        SAID |= bit;
    }
    crate::dlog_now(line);
}

/// A buffer left out: said the first time for each `bit`.
pub fn refuse(bit: u32, what: &str) {
    say_once(bit, &format!("[pv] gpu: left out {}", what));
}

/// Whether every value is finite and in reach (the world is a few thousand
/// units across; a corner a million out is a broken position, not a far one).
pub fn sane(v: &[f32]) -> bool {
    v.iter().all(|f| f.is_finite() && f.abs() < 1.0e6)
}

/// Whether the GPU can read `len` bytes at `p`: in the linear heap or VRAM,
/// with a physical address (osConvertVirtToPhys). An empty buffer reads as
/// readable (nothing is fetched from it).
pub fn readable(p: *const core::ffi::c_void, len: usize) -> bool {
    len == 0 || unsafe { c3d_gpu_readable(p, len as u32) } != 0
}
