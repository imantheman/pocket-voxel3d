//! FireRed's frame pace (GPLv3 + additional terms; see LICENSE.md): 60
//! frames a second on a New 3DS whenever a frame fits in one vblank, 30
//! otherwise, the game still ticking 60 times a second either way.
//!
//! The shared loop (main.rs) paces every game at 30: `C3D_FrameRate(30)` at
//! boot, so `C3D_FrameBegin` waits for every second vblank (citro3d counts
//! frames on a fixed every-other-vblank beat), and the guest runs as many
//! 60 Hz ticks as the time since the last frame holds (two a frame); a
//! frame of 25 ms or more switches to `C3D_FrameRate(60)` for the next one,
//! so it is shown at the next vblank rather than the next beat. For
//! FireRed, main.rs's own switch is held at 30 (its `want30`) and this
//! module sets `C3D_FrameRate` instead:
//!
//! - **What a frame costs at 60.** The loop's CPU time is measured from its
//!   top ([`frame_top`]) to the render call ([`before_render`]) and from the
//!   frame's start inside the render call -- after `C3D_FrameBegin`'s waits
//!   for the vblank and the GPU -- to its end ([`after_render`]). At 30 a
//!   frame runs two ticks; the time before the last one ([`step_begin`]) is
//!   taken off, which leaves what the frame would cost with one tick: the
//!   frame at 60. The GPU's own time for the last frame counts too (real
//!   hardware; an emulator reports next to nothing).
//! - **Up to 60** once 45 frames in a row would have fitted (`FIT_MS`, a
//!   vblank less a margin): a second and a half of headroom.
//! - **Down to 30** when frames stop fitting: a frame over `MISS_MS`, or one
//!   shown a vblank late for a reason the cost does not see (the GPU), adds
//!   to a strain that fades by a tenth a frame; past 1.5 (two misses close
//!   together) the pace drops to 30 and stays there at least a second. One
//!   hitch -- a map loading -- does not flip it.
//! - **At 30**, main.rs's rule stands: after a frame of `HEAVY_MS` or more,
//!   the next is shown at the next vblank (rate 60 for that frame).
//! - **Game speed** is the ticks' business, not the pace's: main.rs runs
//!   the ticks the clock owes. At 60 a frame often comes a hair under a tick
//!   (the clock is in whole ms), and main.rs then runs one anyway; that tick
//!   is borrowed from the next frame ([`borrow_tick`]) so the game does not
//!   run fast.
//! - An Old 3DS stays at 30 (with the heavy-frame rule), as before.

use super::dlog;

extern "C" {
    fn svcGetSystemTick() -> u64;
    fn C3D_FrameRate(fps: f32) -> f32;
    fn C3D_GetDrawingTime() -> f32;
    fn APT_CheckNew3DS(out: *mut bool) -> i32;
}

/// A frame that fits at 60: a vblank (16.7 ms) less a margin for jitter.
const FIT_MS: f32 = 15.0;
/// A frame that cannot be shown at 60.
const MISS_MS: f32 = 16.4;
/// Frames in a row that must fit before the pace goes up to 60.
const UP_AFTER: u32 = 45;
/// Frames the pace stays at 30 after dropping, at least.
const HOLD_30: u32 = 30;
/// A frame shown this long after the last at 60 was a vblank late.
const LATE_MS: f32 = 25.0;
/// At 30, a frame this long has the next shown at the next vblank (main.rs's 25 ms).
const HEAVY_MS: f32 = 25.0;

struct Pace {
    new3ds: Option<bool>,
    /// The pace: 60 when frames fit, else 30.
    at60: bool,
    /// What C3D_FrameRate was last set to.
    rate: u32,
    t_top: f64,
    prev_top: f64,
    t_pre: f64,
    t_in: f64,
    t_step0: f64,
    t_last_step: f64,
    fits: u32,
    hold: u32,
    /// Frames since the last switch: the first two are timed across it.
    since: u32,
    /// The last frame cost more than a vblank (its own miss).
    prev_over: bool,
    strain: f32,
    // the perf line's sums (every 5 s)
    n60: u32,
    n30: u32,
    work_sum: f32,
    work_max: f32,
    est_sum: f32,
    est_max: f32,
    ups: u32,
    downs: u32,
    late: u32,
}

static mut P: Pace = Pace {
    new3ds: None, at60: false, rate: 30, t_top: 0.0, prev_top: 0.0, t_pre: 0.0, t_in: 0.0, t_step0: 0.0,
    t_last_step: 0.0, fits: 0, hold: 0, since: 0, prev_over: false, strain: 0.0, n60: 0, n30: 0,
    work_sum: 0.0, work_max: 0.0, est_sum: 0.0, est_max: 0.0, ups: 0, downs: 0, late: 0,
};

fn now_ms() -> f64 {
    (unsafe { svcGetSystemTick() }) as f64 / 268_111.856
}

#[allow(static_mut_refs)]
fn p() -> &'static mut Pace {
    unsafe { &mut P }
}

/// The loop's top (main.rs, where it reads the clock for the frame).
pub fn frame_top() {
    let p = p();
    p.prev_top = p.t_top;
    p.t_top = now_ms();
    p.t_step0 = 0.0;
    p.t_last_step = 0.0;
}

/// Before each guest tick (main.rs's step loop).
pub fn step_begin(step: u32, steps: u32) {
    let p = p();
    let t = now_ms();
    if step == 0 { p.t_step0 = t; }
    if step + 1 == steps { p.t_last_step = t; }
}

/// Just before the render call (whose `C3D_FrameBegin` waits for the vblank).
pub fn before_render() {
    p().t_pre = now_ms();
}

/// First thing inside the render call, after its waits.
pub fn render_start() {
    p().t_in = now_ms();
}

/// After the render call: this frame's cost, and the pace for the next.
pub fn after_render() {
    let p = p();
    let t_end = now_ms();
    if p.t_top == 0.0 || p.t_in == 0.0 { return; }
    let work = ((p.t_pre - p.t_top) + (t_end - p.t_in)) as f32;
    // the ticks before the last: what a frame at 60 would not run
    let extra = if p.t_last_step > p.t_step0 && p.t_step0 > 0.0 { (p.t_last_step - p.t_step0) as f32 } else { 0.0 };
    let gpu = unsafe { C3D_GetDrawingTime() };
    let est = (work - extra).max(gpu);
    let period = if p.prev_top > 0.0 { (p.t_top - p.prev_top) as f32 } else { 0.0 };
    if p.at60 { p.n60 += 1 } else { p.n30 += 1 }
    p.work_sum += work;
    p.work_max = p.work_max.max(work);
    p.est_sum += est;
    p.est_max = p.est_max.max(est);

    let new3ds = *p.new3ds.get_or_insert_with(|| {
        let mut n = false;
        unsafe { APT_CheckNew3DS(&mut n) };
        dlog(&format!("[pv] g3 pace: {}", if n { "New 3DS: 60 fps when a frame fits, else 30" } else { "Old 3DS: 30 fps" }));
        n
    });
    if new3ds {
        p.since = p.since.saturating_add(1);
        // A frame's period is the frame before it: the first two after a
        // switch are still timed at the old pace, and a frame that already
        // counted as a miss for its own cost is not counted again as the
        // next one's late.
        let late = p.at60 && p.since > 2 && period > LATE_MS && !p.prev_over;
        if late { p.late += 1; }
        let over = est > MISS_MS;
        p.prev_over = over;
        let miss = over || late;
        p.strain = p.strain * 0.9 + if miss { 1.0 } else { 0.0 };
        if p.at60 {
            if p.strain > 1.5 {
                p.at60 = false;
                p.hold = HOLD_30;
                p.fits = 0;
                p.downs += 1;
                p.since = 0;
            }
        } else {
            if p.hold > 0 { p.hold -= 1; }
            p.fits = if est < FIT_MS { p.fits + 1 } else { 0 };
            if p.hold == 0 && p.fits >= UP_AFTER {
                p.at60 = true;
                p.strain = 0.0;
                p.ups += 1;
                p.since = 0;
            }
        }
    }
    // 60 at the 60 pace; at 30, 60 for one frame after a heavy one
    let rate = if p.at60 || work >= HEAVY_MS { 60 } else { 30 };
    if rate != p.rate {
        p.rate = rate;
        unsafe { C3D_FrameRate(rate as f32) };
    }
}

/// main.rs runs at least one tick a frame; when the clock did not owe one
/// yet, the tick is borrowed from the next frame's time.
pub fn borrow_tick(n: u32, sim_acc: &mut f32) {
    if n == 0 { *sim_acc -= 16.667; }
}

/// The perf block's line (every 5 s), then a fresh sum.
pub fn perf_line() {
    let p = p();
    let n = (p.n60 + p.n30).max(1) as f32;
    dlog(&format!(
        "[pv] g3 pace: {} frames at 60, {} at 30 (now {})  cpu {:.1} avg {:.1} max ms  at-60 cost {:.1} avg {:.1} max ms  up {} down {} late {}",
        p.n60, p.n30, if p.at60 { 60 } else { 30 },
        p.work_sum / n, p.work_max, p.est_sum / n, p.est_max, p.ups, p.downs, p.late,
    ));
    p.n60 = 0; p.n30 = 0; p.work_sum = 0.0; p.work_max = 0.0; p.est_sum = 0.0; p.est_max = 0.0;
    p.ups = 0; p.downs = 0; p.late = 0;
}
