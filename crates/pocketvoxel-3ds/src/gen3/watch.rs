//! pocket-voxel 3DS host for the gen3 (FireRed) port (GPLv3 + additional
//! terms; see LICENSE.md). The world's own watch: whether the map underfoot
//! was built with something to draw, and whether the shown world drew any
//! of it -- a map built with no spans is the bare sky Isaac saw (only the
//! billboards on it). And the build's last resort when the app heap cannot
//! give its vertices: everything else that can go goes first.

use super::dlog;

extern "C" {
    /// QuickJS's cycle collector run now (g3_shim.c); ms taken, or -1 while
    /// it is held off (the load).
    fn g3_gc_now() -> i32;
}

/// The last build: its map, whether it was flat (no world: a battle, VIEW
/// 2D), the spans uploaded and the spans built.
static mut BUILT_MAP: u32 = u32::MAX;
static mut BUILT_FLAT: bool = true;
static mut UPLOADED: u32 = 0;
static mut SPANS: u32 = 0;
/// Shown frames in a row, and in the session, whose world drew no span.
static mut EMPTY_RUN: u32 = 0;
static mut EMPTY_TOTAL: u32 = 0;
/// Builds that came out with nothing to draw, this session.
static mut EMPTY_BUILDS: u32 = 0;
/// The last frame's span count (main.rs DRAWN).
static mut DRAWN_LAST: u32 = 0;
/// squeeze_heap has run for the build in progress (once a build).
static mut SQUEEZED: bool = false;

/// After each build's upload (a same-line hook in main.rs).
pub fn note_upload(map: u32, uploaded: usize, spans: usize, flat: bool) {
    unsafe {
        BUILT_MAP = map;
        BUILT_FLAT = flat;
        UPLOADED = uploaded as u32;
        SPANS = spans as u32;
        SQUEEZED = false;
        EMPTY_RUN = 0;
        if !flat && uploaded == 0 {
            EMPTY_BUILDS += 1;
            dlog(&format!(
                "[pv] g3 world: WARNING map#{} built with nothing to draw ({} spans built, {} uploaded; {} such builds)",
                map, spans, uploaded, EMPTY_BUILDS,
            ));
        }
    }
}

/// Once a frame, after the cull (mod.rs before_render): a shown world that
/// draws no span for a second is said in the log, once a run.
pub fn frame(drawn: u32) {
    let sc = unsafe { super::super::voxel::scene() };
    let shown = !sc.flat_world && sc.maps.first().is_some_and(|m| m.shown);
    unsafe {
        DRAWN_LAST = drawn;
        if !shown || drawn > 0 {
            EMPTY_RUN = 0;
            return;
        }
        EMPTY_RUN += 1;
        EMPTY_TOTAL += 1;
        if EMPTY_RUN == 60 {
            dlog(&format!(
                "[pv] g3 world: WARNING nothing drawn for 60 shown frames (map#{} shown, map#{} built{}, {} of {} spans uploaded, kept through a battle {})",
                sc.maps[0].map_id, BUILT_MAP, if BUILT_FLAT { " flat" } else { "" }, UPLOADED, SPANS, super::keeping(),
            ));
        }
    }
}

/// The bench's view (g3_shim.c g3WorldStat): [spans drawn last frame, spans
/// uploaded, spans built, built map, built flat, kept through a battle,
/// empty shown frames in a row, empty shown frames in all, empty builds].
#[no_mangle]
pub extern "C" fn g3_world_stat(out: *mut u32, n: i32) -> i32 {
    let v = unsafe {
        [DRAWN_LAST, UPLOADED, SPANS, BUILT_MAP, BUILT_FLAT as u32, super::keeping() as u32, EMPTY_RUN, EMPTY_TOTAL, EMPTY_BUILDS]
    };
    let k = (n.max(0) as usize).min(v.len());
    for (i, x) in v.iter().take(k).enumerate() {
        unsafe { *out.add(i) = *x };
    }
    k as i32
}

/// Room for one block of `bytes` before a big ask the host makes between
/// frames (same-line hooks in main.rs: a pak's read buffer, a map build's
/// staging): when the app heap would not give it -- a long session leaves
/// the free part in pieces -- the read-ahead and every cached pak but the
/// one in use are let go and QuickJS's cycles collected first. A pak read
/// that cannot have its buffer leaves the old map's geometry standing on
/// the new map; a build's staging that cannot be had aborts.
#[allow(static_mut_refs)]
pub fn make_room(bytes: usize, why: &str) {
    let fits = |n: usize| -> bool {
        let mut v: Vec<u8> = Vec::new();
        v.try_reserve_exact(n).is_ok()
    };
    if fits(bytes) {
        return;
    }
    unsafe {
        let cache0 = super::super::cache_total_kb();
        let pf = super::super::PREFETCH.take().map(|p| p.buf.len() / 1024).unwrap_or(0);
        let front = super::super::PAK_CACHE.first().map(|c| &**c as *const super::super::CachedPak);
        let in_use = super::super::PAK_IN_USE;
        super::super::PAK_CACHE.retain(|c| {
            let p = &**c as *const super::super::CachedPak;
            Some(p) == front || core::ptr::eq(p, in_use)
        });
        let cache1 = super::super::cache_total_kb();
        let gc_ms = if fits(bytes) { -1 } else { g3_gc_now() };
        dlog(&format!(
            "[pv] g3 heap: no block of {} KB for {}: read-ahead {} KB and {} KB of cached paks let go, a cycle collection ({} ms); {}",
            bytes / 1024, why, pf, cache0 - cache1, gc_ms, if fits(bytes) { "it fits now" } else { "STILL no block" },
        ));
    }
}

/// The map build's vertices could not be had (main.rs build_map, a
/// same-line hook before it plans smaller): once a build, everything the
/// heap holds that can go goes -- the read-ahead, every cached pak but the
/// one being built from, QuickJS's garbage cycles -- and the build asks
/// again. Before this a long session's heap (the leak bench's tour: 95 of
/// 96 MB at its high water, in pieces) could not give even a house's few
/// hundred KB, the plan halved to nothing, and the map came out empty: the
/// bare sky. True when anything was let go.
#[allow(static_mut_refs)]
pub fn squeeze_heap(want_bytes: usize) -> bool {
    unsafe {
        if SQUEEZED {
            return false;
        }
        SQUEEZED = true;
        let cache0 = super::super::cache_total_kb();
        let pf = super::super::PREFETCH.take().map(|p| p.buf.len() / 1024).unwrap_or(0);
        let front = super::super::PAK_CACHE.first().map(|c| &**c as *const super::super::CachedPak);
        let in_use = super::super::PAK_IN_USE;
        super::super::PAK_CACHE.retain(|c| {
            let p = &**c as *const super::super::CachedPak;
            Some(p) == front || core::ptr::eq(p, in_use)
        });
        let cache1 = super::super::cache_total_kb();
        let gc_ms = g3_gc_now();
        dlog(&format!(
            "[pv] g3 build: no room for {} KB of vertices: read-ahead {} KB and {} KB of cached paks let go, a cycle collection ({} ms); asking again",
            want_bytes / 1024, pf, cache0 - cache1, gc_ms,
        ));
        pf > 0 || cache1 < cache0 || gc_ms >= 0
    }
}
