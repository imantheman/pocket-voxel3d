//! pocket-voxel 3DS host for the gen3 (FireRed) port (GPLv3 + additional
//! terms; see LICENSE.md). The world's own watch: whether the map underfoot
//! was built with something to draw, and whether the shown world drew any
//! of it -- a map built with no spans is the bare sky Isaac saw (only the
//! billboards on it).

use super::dlog;

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

/// After each build's upload (a same-line hook in main.rs).
pub fn note_upload(map: u32, uploaded: usize, spans: usize, flat: bool) {
    unsafe {
        BUILT_MAP = map;
        BUILT_FLAT = flat;
        UPLOADED = uploaded as u32;
        SPANS = spans as u32;
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

