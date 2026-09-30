#![feature(allocator_api)]
mod voxel;

use citro3d::macros::include_shader;
use citro3d::math::{FVec4, ScreenOrientation, StereoDisplacement, AspectRatio, ClipPlanes, CoordinateOrientation, FVec3, Matrix4, Projection};
use citro3d::render::effect::CullMode;
use citro3d::render::{ClearFlags, DepthFormat, Frame, ScreenTarget, Target};
use citro3d::{attrib, buffer, shader, texenv, texture};
use ctru::prelude::*;
use ctru::services::gfx::{RawFrameBuffer, Screen, Swap, TopScreen3D};
use ctru::services::gspgpu::FramebufferFormat;
use ctru::services::romfs::RomFS;
use pocketvoxel_core::draw::{self, resolve_pal, Item};
use pocketvoxel_core::pak::{self, AlignedBlob, Pak};
use pocketvoxel_core::scene::UI_B_SPRITES_MAX;
use pocketvoxel_core::mapplan::{
    build_order, plan_build, planned_ranges, FILLER_KINDS, GROUND_KINDS, TREE_KINDS,
};
use pocketvoxel_core::pakcompact;
use pocketvoxel_core::spec::{
    atlas_kind, CHUNK_PX, COLOR_PAL_NONE, TREE_MID_PX, TREE_NEAR_PX, TREE_SHAPE_NONE, UI_COLS,
    UI_ROWS, WORLD_VIEW_H,
};

#[repr(C)] pub struct JSRuntime { _p: [u8; 0] }
#[repr(C)] pub struct JSContext { _p: [u8; 0] }
extern "C" {
    fn osSetSpeedupEnable(enable: bool);
    fn JS_NewRuntime() -> *mut JSRuntime;
    fn qjs_new_runtime_logged() -> *mut JSRuntime;
    fn qjs_new_runtime_plain() -> *mut JSRuntime;
    fn qjs_new_runtime_limited(mb: i32) -> *mut JSRuntime;
    fn JS_NewContext(rt: *mut JSRuntime) -> *mut JSContext;
    fn JS_FreeContext(ctx: *mut JSContext);
    fn JS_FreeRuntime(rt: *mut JSRuntime);
    fn qjs_eval(ctx: *mut JSContext, src: *const u8, len: i32,
                errbuf: *mut u8, errlen: i32) -> i32;
    fn qjs_has_global_fn(ctx: *mut JSContext, name: *const u8) -> i32;
    fn qjs_run_bytecode(ctx: *mut JSContext, errbuf: *mut u8, errlen: i32) -> i32;
    fn qjs_register_voxel(ctx: *mut JSContext) -> i32;
    fn c3d_depth_test(on: i32);
    /// Blocks until the GPU has finished the frame it is drawing
    /// (citro3d renderqueue.h). See the rebuild below for why.
    fn C3D_FrameSync();
    fn gsp_flush(p: *const u8, len: u32);
    fn audio3ds_init(rate: i32, frames_per_buf: i32) -> i32;
    fn audio3ds_free_frames() -> i32;
    fn audio3ds_queue(pcm: *const i16, frames: i32) -> i32;
    fn c3d_alpha_test(on: i32, r: i32);
    fn c3d_early_depth(on: i32);
    fn qjs_call_frame(ctx: *mut JSContext, buttons: i32, errbuf: *mut u8, errlen: i32) -> i32;
}

// Override libctru's default heap split (weak symbols). The app heap is
// what malloc/QuickJS use; linear is GPU-visible memory.
// (heap defaults restored)



/// Resident pak cache: front is the current map; the rest are recently-visited
/// maps kept so backtracking skips the SD re-read. Total stays under
/// PAK_CACHE_BUDGET_KB, which is below the largest single pak — so the cache
/// never raises peak pak memory past what already loads today, and a map
/// bigger than the budget evicts everything and loads alone, exactly as the
/// single-pak design did. Bump the budget on hardware if there's headroom.
struct CachedPak {
    pak: pak::Pak<'static>, // borrows buf; declared first so it drops first
    buf: Box<[u8]>,
    name: String,
    kb: usize,
    /// The plan this copy was read under, or None when it was read whole.
    ///
    /// A planned read holds only the geometry that plan will draw, so a
    /// later build wanting a DIFFERENT plan -- a huge map re-sorting its
    /// chunks as the player walks into a new one -- cannot be served from
    /// it. Mismatch means re-read, which is the same moment the rebuild was
    /// going to happen anyway.
    plan: Option<PlanKey>,
}

/// The plan a build at `px` will want. Only huge maps sort by position, but
/// that is not known until the records are read, so the key is always built
/// with a centre and `load_map_pak` downgrades it to None once it finds the
/// map is not huge -- after which any centre matches.
fn plan_key(map_id: u32, px: (f32, f32)) -> PlanKey {
    PlanKey {
        map_id,
        center: Some((
            (px.0 / CHUNK_PX as f32).floor() as i32,
            (px.1 / CHUNK_PX as f32).floor() as i32,
        )),
    }
}

/// Identifies the geometry a planned read kept: the map, and the chunk the
/// nearest-first sort was centred on (None when the map is not huge, where
/// the order is file order and position does not enter into it).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct PlanKey {
    map_id: u32,
    center: Option<(i32, i32)>,
}
/// The resident paks, most recently used first.
///
/// BOXED, and that is the point: `cur_pak` hands out a `&'static Pak` that
/// points INTO the entry, and it is held across frames. A `Vec<CachedPak>`
/// moves its elements whenever it grows, promotes an entry to the front or
/// removes one -- and every such move left that reference pointing at a Pak
/// that had been moved out from under it: chunk records, vertex and index
/// pools all read from stale memory, which draws as geometry stretched
/// across the screen. The box keeps each entry at a fixed address for as
/// long as it is in the cache, whatever the Vec does.
static mut PAK_CACHE: Vec<Box<CachedPak>> = Vec::new();
/// The entry `cur_pak` last handed out, by address. Nothing may evict it,
/// and a front that is not this is a stale `pak_static` (see `pak_moved`).
static mut PAK_IN_USE: *const CachedPak = core::ptr::null();
/// How many times the backstop has had to re-take it. Anything but 0 means
/// a cache path changed the front without telling the frame loop.
static mut PAK_RETAKEN: u32 = 0;
/// Set once at boot from the heap actually available (`size_pak_cache`).
/// Backtracking is free when the map you came from is still resident, and
/// after the loader stopped reading dead weight the thing standing between
/// two neighbouring cities being resident at once was this number, not RAM.
static mut PAK_CACHE_BUDGET_KB: usize = 24 * 1024;

/// Never below this: one ordinary city has to fit with room beside it.
const PAK_CACHE_FLOOR_KB: usize = 24 * 1024;
/// Never above this. Past a point the cache is just holding maps the player
/// has walked well away from, and the memory is better left for geometry.
const PAK_CACHE_CEIL_KB: usize = 72 * 1024;

/// How much of the free heap the pak cache may claim. The rest has to carry
/// the built geometry (up to ~14 MB of vertices), its texture, and QuickJS.
const PAK_CACHE_HEAP_SHARE: usize = 2; // i.e. a half

/// Largest block the allocator will still hand out, by halving from `start`.
/// One allocation rather than a hundred 1 MB ones, so probing cannot leave
/// the heap fragmented behind it.
fn probe_free_kb(start_mb: usize) -> usize {
    let mut mb = start_mb;
    while mb > 0 {
        let mut v: Vec<u8> = Vec::new();
        if v.try_reserve_exact(mb * 1024 * 1024).is_ok() {
            drop(v);
            return mb * 1024;
        }
        mb /= 2;
    }
    0
}

/// Size the cache against the heap this console actually has free.
fn size_pak_cache() {
    let free_kb = probe_free_kb(96);
    let want = (free_kb / PAK_CACHE_HEAP_SHARE).clamp(PAK_CACHE_FLOOR_KB, PAK_CACHE_CEIL_KB);
    unsafe { PAK_CACHE_BUDGET_KB = want };
    dlog(&format!(
        "[pv] pak cache {} MB (heap probe found {} MB free)",
        want / 1024,
        free_kb / 1024,
    ));
}

/// The shared atlas texels (paks/common.vxat), loaded once at boot.
///
/// 635 atlas pages are carried by two or more maps -- the sprites, the font,
/// the UI, the battle furniture, and the tilesets a region has in common.
/// tools/pak_share_atlas.py hoists them here and points each pak's page
/// directory at this blob, which is most of what a small map used to spend
/// its load reading. None when the file is absent: paks that embed every
/// page still read exactly as before.
static mut SHARED_ATLAS: Option<&'static [u8]> = None;

/// Which game this build is. Red and Blue read one shared set of map paks
/// (the maps and every graphic but the title ribbon are the same data in
/// both ROMs); each has its own dataset and a small atlas overlay.
#[cfg(not(any(feature = "blue", feature = "yellow")))]
const GAME: &str = "red";
#[cfg(feature = "blue")]
const GAME: &str = "blue";
#[cfg(feature = "yellow")]
const GAME: &str = "yellow";
/// The pak set this game reads. Red and Blue share one; Yellow has its own
/// (its Pokemon are redrawn and its atlas pages do not line up with theirs).
#[cfg(not(feature = "yellow"))]
const PAKS_DIR: &str = "sdmc:/3ds/voxelmon/paks";
#[cfg(feature = "yellow")]
const PAKS_DIR: &str = "sdmc:/3ds/voxelmon/paks_yellow";
#[cfg(not(any(feature = "blue", feature = "yellow")))]
const GAMEDATA_PATH: &str = "sdmc:/3ds/voxelmon/paks/gamedata.json";
#[cfg(feature = "blue")]
const GAMEDATA_PATH: &str = "sdmc:/3ds/voxelmon/paks/gamedata_blue.json";
#[cfg(feature = "yellow")]
const GAMEDATA_PATH: &str = "sdmc:/3ds/voxelmon/paks_yellow/gamedata.json";
#[cfg(not(any(feature = "blue", feature = "yellow")))]
const OVERLAY_PATH: &str = "sdmc:/3ds/voxelmon/paks/version_red.vxat";
#[cfg(feature = "blue")]
const OVERLAY_PATH: &str = "sdmc:/3ds/voxelmon/paks/version_blue.vxat";
#[cfg(feature = "yellow")]
const OVERLAY_PATH: &str = "sdmc:/3ds/voxelmon/paks_yellow/version_yellow.vxat";

/// This game's own overlay (paks/version_<game>.vxat, written by
/// tools/cook3ds.ts writeOverlay): the atlas pages, palette table and sound
/// whose bytes differ between Red and Blue. Whatever the shared set holds --
/// the other game's, if it was cooked last -- this game uses its own.
static mut OVERLAY: Vec<(usize, pak::AtlasPage<'static>)> = Vec::new();
static mut OVERLAY_PALETTES: Vec<[u32; 256]> = Vec::new();
static mut OVERLAY_AUDIO: Option<&'static [u8]> = None;

/// Parse the overlay file: "VXVO" u16 format u16 count, and for format 2
/// u32 vpal_len u32 audi_len; then count x 16-byte entries {page, w, h,
/// kind, frames, 0: u16; frame_len: u32}; then each page's texels, then the
/// VPAL section, then AUDI -- each 16-aligned.
#[allow(static_mut_refs)]
fn parse_overlay(d: &'static [u8]) {
    if d.len() < 8 || &d[0..4] != b"VXVO" { return; }
    let u16_at = |o: usize| u16::from_le_bytes([d[o], d[o + 1]]);
    let u32_at = |o: usize| u32::from_le_bytes([d[o], d[o + 1], d[o + 2], d[o + 3]]);
    let format = u16_at(4);
    let count = u16_at(6) as usize;
    let head = if format >= 2 { 16 } else { 8 };
    if d.len() < head + count * 16 { return; }
    let (vpal_len, audi_len) = if format >= 2 { (u32_at(8) as usize, u32_at(12) as usize) } else { (0, 0) };
    let mut at = head + count * 16;
    let mut pages = Vec::new();
    for i in 0..count {
        let e = head + i * 16;
        let (page, w, h, kind, frames) = (u16_at(e), u16_at(e + 2), u16_at(e + 4), u16_at(e + 6), u16_at(e + 8));
        let frame_len = u32_at(e + 12);
        at += (16 - at % 16) % 16;
        let total = frame_len as usize * frames.max(1) as usize;
        if at + total > d.len() { return; }
        pages.push((page as usize, pak::AtlasPage::from_parts(w, h, kind, frames, frame_len, &d[at..at + total])));
        at += total;
    }
    let mut palettes = Vec::new();
    if vpal_len >= 2 {
        at += (16 - at % 16) % 16;
        if at + vpal_len > d.len() { return; }
        let v = &d[at..at + vpal_len];
        let n = u16::from_le_bytes([v[0], v[1]]) as usize;
        if 2 + n * 1024 <= v.len() {
            for k in 0..n {
                let mut pal = [0u32; 256];
                for (j, entry) in pal.iter_mut().enumerate() {
                    let o = 2 + k * 1024 + j * 4;
                    *entry = u32::from_le_bytes([v[o], v[o + 1], v[o + 2], v[o + 3]]);
                }
                palettes.push(pal);
            }
        }
        at += vpal_len;
    }
    let mut audio = None;
    if audi_len > 0 {
        at += (16 - at % 16) % 16;
        if at + audi_len <= d.len() { audio = Some(&d[at..at + audi_len]); }
    }
    unsafe {
        OVERLAY = pages;
        OVERLAY_PALETTES = palettes;
        OVERLAY_AUDIO = audio;
    }
}

/// Swap this game's own pages and palettes in over whatever the shared set
/// carried. Only like for like: a page of the same shape, a palette table of
/// the same length -- so an overlay from some other cook can never hand the
/// renderer something it cannot use.
#[allow(static_mut_refs)]
fn apply_overlay(p: &mut pak::Pak<'static>) {
    for (i, page) in unsafe { OVERLAY.iter() } {
        if let Some(slot) = p.atlases.get_mut(*i) {
            if slot.w == page.w && slot.h == page.h && slot.kind == page.kind {
                *slot = *page;
            }
        }
    }
    let pals = unsafe { &OVERLAY_PALETTES };
    if !pals.is_empty() && pals.len() == p.palettes.len() {
        p.palettes.clone_from(pals);
    }
}

#[allow(static_mut_refs)]
unsafe fn cache_total_kb() -> usize {
    PAK_CACHE.iter().map(|c| c.kb).sum()
}

#[allow(static_mut_refs)]
unsafe fn load_map_pak(name: &str, want: Option<PlanKey>) -> bool {
    // A cached copy serves only if it holds at least what is wanted: read
    // whole (plan None) covers anything, and a planned copy covers exactly
    // its own plan.
    let t_start = {
        extern "C" { fn osGetTime() -> u64; }
        osGetTime()
    };
    let serves = |c: &CachedPak| {
        c.name == name
            && match (c.plan, want) {
                (None, _) => true, // read whole: covers anything
                (Some(_), None) => false, // a planned copy cannot serve a full read
                (Some(a), Some(b)) => {
                    a.map_id == b.map_id && (a.center.is_none() || a.center == b.center)
                }
            }
    };
    if PAK_CACHE.first().map(|c| serves(c)).unwrap_or(false) {
        return true;
    }
    // resident in the cache -> promote to front, no SD read
    if let Some(i) = PAK_CACHE.iter().position(|c| serves(c)) {
        let hit = PAK_CACHE.remove(i);
        PAK_CACHE.insert(0, hit);
        dlog(&format!("[pv] pak {} cached (0 ms)", name));
        return true;
    }
    // A read-ahead already in flight for THIS map: finish it rather than
    // throw away the megabytes it has and start the file again. Crossing a
    // seam before it completed used to cost the whole read twice over.
    let adopted = match PREFETCH.as_ref() {
        Some(pf) if pf.name == name => PREFETCH.take(),
        _ => None,
    };
    if let Some(mut pf) = adopted {
        use std::io::Read;
        let had = pf.pos;
        let ok = pf.pos >= pf.buf.len()
            || pf.file.read_exact(&mut pf.buf[pf.pos..]).is_ok();
        if ok {
            let kb = pf.buf.len() / 1024;
            let ms = {
                extern "C" { fn osGetTime() -> u64; }
                osGetTime().wrapping_sub(t_start)
            };
            let buf: Box<[u8]> = pf.buf.into_boxed_slice();
            let bytes: &'static [u8] = core::mem::transmute(buf.as_ref());
            if let Ok(mut p) = pak::read_with_shared(bytes, SHARED_ATLAS) {
                apply_overlay(&mut p);
                while cache_total_kb() + kb > PAK_CACHE_BUDGET_KB && evict_lru(false) {}
                PAK_CACHE.retain(|c| c.name != name);
                PAK_CACHE.insert(0, Box::new(CachedPak {
                    pak: p, buf, name: name.to_string(), kb, plan: None,
                }));
                dlog(&format!(
                    "[pv] pak {} {} KB in {} ms ({} KB was read ahead)",
                    name, kb, ms, had / 1024,
                ));
                return true;
            }
        }
        // Fall through and read it properly; the partial buffer is dropped.
    }
    let _ = t_start;
    // must read from SD. Stat the size first so we can evict to fit WITHOUT a
    // transient over-budget spike; a map larger than the whole budget evicts
    // everything and loads alone (peak == the old single-pak peak).
    let t0 = {
        extern "C" { fn osGetTime() -> u64; }
        osGetTime()
    };
    let path = format!("{}/{}.vxpak", PAKS_DIR, name);
    let new_kb = std::fs::metadata(&path)
        .map(|m| (m.len() / 1024) as usize)
        .unwrap_or(usize::MAX);
    // A read-ahead in flight for a DIFFERENT map is still holding its whole
    // buffer -- up to 10 MB of heap for a route -- and nothing counts it
    // against the cache budget, so the eviction below cannot free it. Walking
    // into Viridian Forest asks for 57 MB on top of exactly that, and the
    // console faulted on the GPU thread's own stack, 2 MB into the heap: the
    // heap had grown past what it could hold. Whatever cannot fit beside the
    // incoming map goes first.
    let pf_kb = PREFETCH.as_ref().map(|p| p.buf.len() / 1024).unwrap_or(0);
    if pf_kb > 0 && cache_total_kb() + new_kb + pf_kb > PAK_CACHE_BUDGET_KB {
        dlog(&format!("[pv] read-ahead dropped ({} KB) to make room for {}", pf_kb, name));
        PREFETCH = None;
    }
    while cache_total_kb() + new_kb > PAK_CACHE_BUDGET_KB && evict_lru(false) {}
    // Back to a position at the centre of the planned chunk: build_order
    // only ever divides it back down to a chunk index, so this round-trips.
    let plan_for = want.map(|k| {
        let px = k.center.map(|(cx, cy)| (
            (cx as f32 + 0.5) * CHUNK_PX as f32,
            (cy as f32 + 0.5) * CHUNK_PX as f32,
        ));
        (k.map_id, px)
    });
    let Some(v) = map_pak(&path, plan_for) else {
        println!("pak missing: {}", name);
        return false;
    };
    let kb = v.len() / 1024;
    let read_ms = {
        extern "C" { fn osGetTime() -> u64; }
        osGetTime().wrapping_sub(t0)
    };
    dlog(&format!(
        "[pv] pak {} {} KB in {} ms (cache {} KB)", name, kb, read_ms, cache_total_kb()
    ));
    let buf: Box<[u8]> = v.into_boxed_slice();
    let bytes: &'static [u8] = core::mem::transmute(buf.as_ref());
    match pak::read_with_shared(bytes, unsafe { SHARED_ATLAS }) {
        Ok(mut p) => {
            apply_overlay(&mut p);
            // A map under HUGE_MAP_THRESHOLD builds in file order, so its
            // plan does not depend on where the player stands: drop the
            // centre and the copy then serves every later position, instead
            // of being re-read every time they cross a chunk line.
            let mut plan = want;
            if let (Some(k), Some(map)) =
                (want, p.maps.iter().find(|m| Some(m.map_id) == want.map(|k| k.map_id)))
            {
                let chunks = &p.chunks[map.first as usize..(map.first + map.count) as usize];
                let (_, huge, _) = build_order(chunks, None);
                if !huge {
                    plan = Some(PlanKey { map_id: k.map_id, center: None });
                }
            }
            // Only now drop a stale copy of the SAME map -- one read under
            // a plan that no longer covers what is wanted. Dropping it
            // earlier would have freed the buffer `pak_static` still points
            // at, with no guarantee this read was going to replace it.
            PAK_CACHE.retain(|c| c.name != name);
            PAK_CACHE.insert(0, Box::new(CachedPak {
                pak: p, buf, name: name.to_string(), kb, plan,
            }));
            true
        }
        Err(e) => {
            println!("pak parse failed: {}", e);
            false
        }
    }
}

/// One camera mode. `rig` is what scene.cam_rig takes: 0 the orbit this port
/// has always used, 1 first person, 2 third person.
struct CamMode {
    name: &'static str,
    rig: u8,
    /// A fixed-angle rung pins the orbit to one PITCH_RUNGS entry and locks
    /// the stick out, as the mod's angle rungs do. None is a camera the stick
    /// moves: ours, or a free rig.
    rung: Option<usize>,
}

/// The ladder, cycled with ZL and ZR.
///
/// ORBIT is this port's own camera, unchanged and first so it stays the
/// default. 3RD and 1ST are DramaticShapeVoxelMod's two free rungs, where the
/// camera leaves the orbit and stands with the player -- on a boom off the
/// back of their head, or in it.
///
/// ZL/ZR and not L/R: L and R are the Kantogear's tabs.
const CAM_MODES: [CamMode; 8] = [
    CamMode { name: "ours (free swing)", rig: 0, rung: None },
    CamMode { name: "OFF (flat)", rig: 0, rung: Some(0) },
    CamMode { name: "15", rig: 0, rung: Some(1) },
    CamMode { name: "35", rig: 0, rung: Some(2) },
    CamMode { name: "50", rig: 0, rung: Some(3) },
    CamMode { name: "75", rig: 0, rung: Some(4) },
    CamMode { name: "1st person", rig: 1, rung: None },
    CamMode { name: "3rd person", rig: 2, rung: None },
];

/// The rung ours sits on: 35 degrees, what the guest asks for at boot.
const OURS_RUNG: usize = 2;

/// C-stick rates per frame at 60 Hz, from the mod's per-second figures.
const RIG_YAW_RATE: f32 = pocketvoxel_core::cam::FREE_STICK_YAW / 60.0;
const RIG_PITCH_RATE: f32 = pocketvoxel_core::cam::FREE_STICK_PITCH / 60.0;

/// A map being read ahead, a slice at a time, while the player walks.
///
/// Crossing a seam has no fade to hide behind -- the original walks you
/// straight from one route into the next -- so the only way the read can go
/// unnoticed is for it to have happened already. The host knows which maps
/// are connected long before you reach the edge: it is drawing their seam
/// strips. This reads the whole of one of them in the time left over each
/// frame, so arriving is a cache hit.
///
/// Read WHOLE, not planned: the plan depends on where you will be standing
/// when you arrive, which is not known yet, and a copy read whole serves any
/// plan. The extra bytes cost nothing here -- the point of this path is that
/// the time is already being spent idle.
struct Prefetch {
    name: String,
    file: std::fs::File,
    buf: Vec<u8>,
    pos: usize,
    /// The GAME section, which every pak carries and this host never looks
    /// at (map_pak cuts it too): ~1.1 MB of the 8-10 MB of a route, skipped
    /// rather than read. The buffer is already zero there.
    skip: Option<(usize, usize)>,
}

static mut PREFETCH: Option<Prefetch> = None;

/// Maps already attempted while standing on the current one, so a read-ahead
/// that cannot be kept is not started again on the very next frame.
///
/// Without this every failure path re-read the whole map immediately: seconds
/// of SD traffic and a 10-24 MB allocate-and-discard, over and over, for as
/// long as the player stood on a map with neighbours. That is an outdoor-only
/// drag that gets worse the longer you stand there, as the repeated large
/// allocations fragment the heap.
static mut PREFETCH_TRIED: Vec<String> = Vec::new();
/// Which map PREFETCH_TRIED belongs to; walking somewhere new clears it.
static mut PREFETCH_FOR: u32 = u32::MAX;

/// Forget the attempt list when the player changes map.
#[allow(static_mut_refs)]
unsafe fn prefetch_retarget(map_id: u32) {
    if PREFETCH_FOR != map_id {
        PREFETCH_FOR = map_id;
        PREFETCH_TRIED.clear();
    }
}

/// Give up this much of a frame to reading ahead.
///
/// Measured on hardware the card does ~11 MB/s (13,338 KB in 1,225 ms), and
/// the first version of this spent 3 ms of every frame on 32 KB slices --
/// about 1.9 MB/s, a sixth of what the card can do, so a 13 MB route needed
/// seven seconds of walking to arrive in time. The loop below stops before a
/// slice it predicts will overrun, so this is a ceiling rather than a
/// quantum: a slower card takes fewer slices rather than a longer frame.
const PREFETCH_MS: u64 = 12;
/// Near a seam the read is about to be needed, so it takes most of the
/// frame: a few dropped frames walking up to the edge buy an arrival with
/// the map already in hand, which is the whole point of reading ahead.
const PREFETCH_MS_NEAR: u64 = 24;
/// "Near" is within this many world px of the map's edge (3 chunks).
const PREFETCH_NEAR_PX: f32 = 3.0 * CHUNK_PX as f32;
/// Bytes per read. At ~11 MB/s this is ~6 ms, comfortably inside the budget
/// while being big enough that per-read overhead is not the limit.
const PREFETCH_SLICE: usize = 64 * 1024;

/// Begin reading `name` ahead, unless it is already resident, already in
/// progress, or would not fit beside what is cached.
#[allow(static_mut_refs)]
unsafe fn prefetch_start(name: &str) -> bool {
    // Viridian Forest is not read ahead into, and nothing is read ahead while
    // standing in it or its gates (the call site checks that half).
    //
    // Its pak is 56 MB, against a heap probe that finds 48 MB free on real
    // hardware. The log caught a 10 MB read-ahead of Pewter City still
    // resident when the forest was asked for, and the console rebooted
    // between the read finishing and the build starting. This is the one map
    // where reading ahead cannot pay for itself, so it does not happen.
    if name.starts_with("VIRIDIAN_FOREST") {
        return false;
    }
    if PREFETCH.is_some()
        || PAK_CACHE.iter().any(|c| c.name == name)
        || PREFETCH_TRIED.iter().any(|n| n == name)
    {
        return false;
    }
    // Counted as attempted the moment it starts, so every exit below --
    // finished, refused, or failed -- costs one try and not a loop.
    PREFETCH_TRIED.push(name.to_string());
    let path = format!("{}/{}.vxpak", PAKS_DIR, name);
    let Ok(file) = std::fs::File::open(&path) else { return false };
    let Ok(md) = file.metadata() else { return false };
    let len = md.len() as usize;
    // Only if it can live alongside the map being played without pushing it
    // out: a prefetch that evicts the ground under your feet is a loss.
    if cache_total_kb() + len / 1024 > PAK_CACHE_BUDGET_KB {
        return false;
    }
    let mut buf: Vec<u8> = Vec::new();
    if buf.try_reserve_exact(len).is_err() {
        return false;
    }
    buf.resize(len, 0);
    // Header and section table first, to find the GAME section to skip.
    let mut file = file;
    let mut skip = None;
    {
        use std::io::Read;
        if file.read_exact(&mut buf[..16]).is_ok() {
            let secs = u16::from_le_bytes([buf[6], buf[7]]) as usize;
            let table_end = 16 + secs * 16;
            if table_end <= len && file.read_exact(&mut buf[16..table_end]).is_ok() {
                for i in 0..secs {
                    let e = 16 + i * 16;
                    if u32::from_le_bytes([buf[e], buf[e + 1], buf[e + 2], buf[e + 3]]) == TAG_GAME {
                        let off = u32::from_le_bytes([buf[e + 4], buf[e + 5], buf[e + 6], buf[e + 7]]) as usize;
                        let slen = u32::from_le_bytes([buf[e + 8], buf[e + 9], buf[e + 10], buf[e + 11]]) as usize;
                        if off >= table_end && off + slen <= len {
                            skip = Some((off, off + slen));
                        }
                    }
                }
                PREFETCH = Some(Prefetch {
                    name: name.to_string(), file, buf, pos: table_end, skip,
                });
                return true;
            }
        }
    }
    false
}

/// Read the next slices of the map in flight. Called once a frame; returns
/// true when one just finished and went into the cache.
#[allow(static_mut_refs)]
unsafe fn prefetch_step(budget_ms: u64) -> bool {
    use std::io::{Read, Seek, SeekFrom};
    extern "C" { fn osGetTime() -> u64; }
    let Some(pf) = PREFETCH.as_mut() else { return false };
    let start = osGetTime();
    while pf.pos < pf.buf.len() {
        // Past the section this host never reads: seek over it.
        if let Some((a, b)) = pf.skip {
            if pf.pos >= a && pf.pos < b {
                if pf.file.seek(SeekFrom::Start(b as u64)).is_err() {
                    PREFETCH = None;
                    return false;
                }
                pf.pos = b;
                continue;
            }
        }
        let t0 = osGetTime();
        let mut end = (pf.pos + PREFETCH_SLICE).min(pf.buf.len());
        if let Some((a, _)) = pf.skip {
            if pf.pos < a && end > a {
                end = a; // stop the slice where the skipped section starts
            }
        }
        if pf.file.read_exact(&mut pf.buf[pf.pos..end]).is_err() {
            PREFETCH = None; // the card said no; the normal path will retry
            return false;
        }
        pf.pos = end;
        // Stop before a slice that would overrun rather than after one that
        // already has: the last one took `dt`, so the next probably will too.
        let dt = osGetTime().wrapping_sub(t0);
        if osGetTime().wrapping_sub(start) + dt > budget_ms {
            break;
        }
    }
    if pf.pos < pf.buf.len() {
        return false;
    }

    let Some(pf) = PREFETCH.take() else { return false };
    let kb = pf.buf.len() / 1024;
    // Room is checked again: the cache has moved on since this started.
    let cur = PAK_CACHE.first().map(|c| c.kb).unwrap_or(0);
    if cur + kb > PAK_CACHE_BUDGET_KB {
        return false;
    }
    while PAK_CACHE.len() > 1 && cache_total_kb() + kb > PAK_CACHE_BUDGET_KB && evict_lru(true) {}
    if cache_total_kb() + kb > PAK_CACHE_BUDGET_KB {
        return false;
    }
    let buf: Box<[u8]> = pf.buf.into_boxed_slice();
    let bytes: &'static [u8] = core::mem::transmute(buf.as_ref());
    match pak::read_with_shared(bytes, SHARED_ATLAS) {
        Ok(mut p) => {
            apply_overlay(&mut p);
            // Behind the current map, so it is the first thing dropped if
            // the player walks somewhere else entirely.
            let at = PAK_CACHE.len().min(1);
            PAK_CACHE.insert(at, Box::new(CachedPak {
                pak: p, buf, name: pf.name.clone(), kb, plan: None,
            }));
            dlog(&format!("[pv] read ahead {} ({} KB)", pf.name, kb));
            true
        }
        Err(_) => false,
    }
}

#[allow(static_mut_refs)]
unsafe fn cur_pak() -> &'static pak::Pak<'static> {
    let entry: &CachedPak = PAK_CACHE.first().expect("no pak loaded");
    PAK_IN_USE = entry as *const CachedPak;
    core::mem::transmute::<&pak::Pak<'static>, &'static pak::Pak<'static>>(&entry.pak)
}

/// Has the cache put a different pak at the front since `cur_pak` last ran?
///
/// The call sites that mutate the cache re-take `pak_static` when they
/// report a change, but one that returns "nothing to do" after promoting,
/// evicting or adopting a read-ahead would leave the old one in hand. This
/// is the backstop: it is exact (an address compare), it costs nothing, and
/// it turns a whole class of "the world drew as streaks for a second" into
/// a line in the log.
#[allow(static_mut_refs)]
unsafe fn pak_moved() -> bool {
    match PAK_CACHE.first() {
        Some(front) => !core::ptr::eq(&**front as *const CachedPak, PAK_IN_USE),
        None => false,
    }
}

/// Drop the least-recently-used entry. Returns false when there is nothing
/// left it may take.
///
/// `protect_in_use` keeps the map being drawn from: a read-ahead that
/// evicted the ground under the player's feet would leave `pak_static`
/// pointing at freed memory for as long as it took the next build to
/// notice. A cold read passes false -- it is about to put a new pak at the
/// front and its caller re-takes the pointer on the same line -- and that
/// is what lets a map larger than the rest of the cache still load.
#[allow(static_mut_refs)]
unsafe fn evict_lru(protect_in_use: bool) -> bool {
    match PAK_CACHE.last() {
        Some(last)
            if protect_in_use && core::ptr::eq(&**last as *const CachedPak, PAK_IN_USE) =>
        {
            false
        }
        Some(_) => {
            PAK_CACHE.pop();
            true
        }
        None => false,
    }
}

/// The GAME section's tag, the one payload this host never looks at.
const TAG_GAME: u32 = u32::from_le_bytes(*b"GAME");
/// The geometry section: chunk records first, then the vertex/index pools.
const TAG_CHNK: u32 = u32::from_le_bytes(*b"CHNK");

/**
 * Read a pak, skipping the payloads this host has no use for.
 *
 * Every map's pak carries a full copy of gamedata.json in its GAME section —
 * 1.18 MB of it, the same bytes in all 219 of them. Nothing reads it: the
 * guest is handed gamedata.json from its own file on the card at boot, and
 * `pak::read` only ever slices GAME, never looks inside. It was still being
 * pulled off the SD card on every single map change, which for a house or a
 * gate (2.8 MB on disk, 0.14 MB of actual geometry) was most of the wait.
 *
 * The buffer is still allocated full-length and the section table is read
 * intact, so every offset in it stays true and the parser's
 * `total_len == data.len()` check still holds — the skipped range is simply
 * left as zeros. Sections sit in ascending offset order, so dropping one
 * leaves two runs to read instead of one.
 */
/// Files at least this big are packed rather than read in place. Only
/// Viridian Forest is anywhere near it; a route is 8-10 MB.
const COMPACT_MIN_KB: usize = 16 * 1024;

/// The STMP section's tag -- read only for its stamp count, which decides
/// whether this pak can be packed at all.
const TAG_STMP: u32 = u32::from_le_bytes(*b"STMP");

/// Read a pak PACKED: only the planned geometry, laid end to end in a buffer
/// sized to it, with the offsets that point at it rewritten to match
/// (pocketvoxel_core::pakcompact).
///
/// The in-place read below allocates the whole file because every offset in
/// a pak is a position in that image. Viridian Forest is 56 MB of which the
/// 400,000-vertex budget can draw ~13 MB, and asking a 3DS heap for 56 MB is
/// what unmapped the GPU thread's own stack and took the console down on
/// every entry. Returns None if anything is not as expected, and the caller
/// falls back to reading in place.
fn map_pak_packed(
    path: &str,
    len: usize,
    map_id: u32,
    player_px: Option<(f32, f32)>,
) -> Option<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).ok()?;
    let mut head = [0u8; 16];
    f.read_exact(&mut head).ok()?;
    // v9 carries TINS, whose shape ranges point into the same pools and are
    // not rewritten here: those paks are read as they are (they are small,
    // which is the whole point of instancing them).
    if u16::from_le_bytes([head[4], head[5]]) != pocketvoxel_core::spec::VXPK_VERSION {
        return None;
    }
    let n = u16::from_le_bytes([head[6], head[7]]) as usize;
    if n != 9 {
        return None;
    }
    let mut table = vec![0u8; n * 16];
    f.read_exact(&mut table).ok()?;
    let rd32 = |b: &[u8], o: usize| {
        u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]) as usize
    };
    let mut sections = [(0usize, 0usize); 9];
    let mut chnk_idx = usize::MAX;
    let mut game = (0usize, 0usize);
    let mut stmp = (0usize, 0usize);
    for i in 0..9 {
        let e = i * 16;
        let tag = rd32(&table, e) as u32;
        let (off, slen) = (rd32(&table, e + 4), rd32(&table, e + 8));
        if off + slen > len {
            return None;
        }
        sections[i] = (off, slen);
        if tag == TAG_CHNK {
            chnk_idx = i;
        } else if tag == TAG_GAME {
            game = (off, off + slen);
        } else if tag == TAG_STMP {
            stmp = (off, slen);
        }
    }
    if chnk_idx == usize::MAX || game.1 == 0 {
        return None;
    }
    // Stamps ride the same pools and nothing rewrites them, so a pak with
    // any is read in place.
    let mut stamp_total = 1usize;
    if stmp.1 >= 8 {
        let mut sh = [0u8; 8];
        f.seek(SeekFrom::Start(stmp.0 as u64)).ok()?;
        f.read_exact(&mut sh).ok()?;
        stamp_total = rd32(&sh, 4);
    }

    let (chnk_off, _) = sections[chnk_idx];
    let mut ch = [0u8; 32];
    f.seek(SeekFrom::Start(chnk_off as u64)).ok()?;
    f.read_exact(&mut ch).ok()?;
    let map_count = u16::from_le_bytes([ch[0], ch[1]]) as usize;
    let chunk_total = rd32(&ch, 4);
    let payload_len = 32 + map_count * 12 + chunk_total * 128;
    if chnk_off + payload_len > len {
        return None;
    }
    let mut payload = vec![0u8; payload_len];
    payload[..32].copy_from_slice(&ch);
    f.read_exact(&mut payload[32..]).ok()?;

    let chunks = pakcompact::parse_records(&payload, map_count, chunk_total)?;
    let (first, count) = pakcompact::map_dir(&payload, map_count, map_id)?;
    if first + count > chunks.len() {
        return None;
    }
    // The same plan build_map will make when handed this map.
    let mine = &chunks[first..first + count];
    let (order, huge, budget) = build_order(mine, player_px);
    let bp = plan_build(mine, &order, huge, budget, 0);
    let planned: Vec<(usize, usize)> =
        bp.items.iter().map(|it| (first + it.chunk, it.kind)).collect();

    let src = pakcompact::Source {
        file_len: len,
        sections,
        chnk_idx,
        map_count,
        chunk_total,
        verts_at: chnk_off + rd32(&ch, 8),
        verts_len: rd32(&ch, 12),
        indices_at: chnk_off + rd32(&ch, 16),
        indices_len: rd32(&ch, 20),
        chunks: &chunks,
        planned: &planned,
        stamp_total,
        // header, table and META, then AUDI and the chunk records: GAME is
        // left as the zeros the in-place read leaves too
        prefix: &[(0, game.0), (game.1, chnk_off + payload_len)],
    };
    let c = pakcompact::plan(&src)?;

    let mut v: Vec<u8> = Vec::new();
    if v.try_reserve_exact(c.len).is_err() {
        println!("pak: cannot reserve {} KB packed", c.len / 1024);
        return None;
    }
    v.resize(c.len, 0);
    for cp in c.copies.iter() {
        if cp.dst + cp.len > c.len || cp.src + cp.len > len {
            return None;
        }
        if f.seek(SeekFrom::Start(cp.src as u64)).is_err()
            || f.read_exact(&mut v[cp.dst..cp.dst + cp.len]).is_err()
        {
            println!("pak: short read (packed)");
            return None;
        }
    }
    pakcompact::patch(&mut v, &c);
    dlog(&format!(
        "[pv] packed {} KB -> {} KB ({} reads)",
        len / 1024,
        c.len / 1024,
        c.copies.len(),
    ));
    Some(v)
}

fn map_pak(
    path: &str,
    plan_for: Option<(u32, Option<(f32, f32)>)>,
) -> Option<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len() as usize;
    // A map too big to hold whole is packed down to what it will draw.
    if len / 1024 >= COMPACT_MIN_KB {
        if let Some((map_id, px)) = plan_for {
            if let Some(v) = map_pak_packed(path, len, map_id, px) {
                return Some(v);
            }
            dlog("[pv] packing declined; reading in place");
        }
    }
    // fs::read grows by doubling, so a 45 MB pak can transiently want ~90 MB
    // and blow the heap even though the final size fits. Size it exactly
    // from the file length and read straight in.
    let mut v: Vec<u8> = Vec::new();
    if v.try_reserve_exact(len).is_err() {
        println!("pak: cannot reserve {} KB", len / 1024);
        return None;
    }
    v.resize(len, 0);

    // Header (16B) + one 16B entry per section. Read it first: it says where
    // everything lives, and it has to reach the buffer verbatim either way.
    const HDR: usize = 16;
    const ENTRY: usize = 16;
    if len < HDR {
        println!("pak: too short");
        return None;
    }
    if f.read_exact(&mut v[..HDR]).is_err() {
        println!("pak: short read (header)");
        return None;
    }
    let n_sections = u16::from_le_bytes([v[6], v[7]]) as usize;
    let table_end = HDR + n_sections * ENTRY;
    if table_end > len {
        println!("pak: bad section table");
        return None;
    }
    if f.read_exact(&mut v[HDR..table_end]).is_err() {
        println!("pak: short read (table)");
        return None;
    }

    let section = |tag: u32| -> Option<(usize, usize)> {
        for s in 0..n_sections {
            let e = HDR + s * ENTRY;
            let t = u32::from_le_bytes([v[e], v[e + 1], v[e + 2], v[e + 3]]);
            if t != tag {
                continue;
            }
            let off = u32::from_le_bytes([v[e + 4], v[e + 5], v[e + 6], v[e + 7]]) as usize;
            let slen = u32::from_le_bytes([v[e + 8], v[e + 9], v[e + 10], v[e + 11]]) as usize;
            return off.checked_add(slen).filter(|&x| x <= len).map(|end| (off, end));
        }
        None
    };

    // Everything after the table, minus GAME, minus -- when we are going to
    // plan -- the vertex and index pools. The pools sit at the tail of CHNK
    // (chunk records come first), so cutting them still leaves the records,
    // which are all the plan needs.
    let mut keep: Vec<(usize, usize)> = vec![(table_end, len)];
    fn cut_out(keep: &mut Vec<(usize, usize)>, off: usize, end: usize) {
        let mut next: Vec<(usize, usize)> = Vec::new();
        for &(a, b) in keep.iter() {
            if end <= a || off >= b {
                next.push((a, b));
                continue;
            }
            if a < off { next.push((a, off)); }
            if end < b { next.push((end, b)); }
        }
        *keep = next;
    }
    if let Some((off, end)) = section(TAG_GAME) {
        cut_out(&mut keep, off, end);
    }
    // CHNK header word 8 is verts_off, relative to the payload start; the two
    // pools run from there to the end of the section.
    // (verts_at, indices_at, section end) -- header words 8 and 16 are the
    // two pool offsets, relative to the payload start.
    let mut pools: Option<(usize, usize, usize)> = None;
    if plan_for.is_some() {
        if let Some((c_off, c_end)) = section(TAG_CHNK) {
            let mut h = [0u8; 32];
            if f.seek(SeekFrom::Start(c_off as u64)).is_ok() && f.read_exact(&mut h).is_ok() {
                let vo = c_off + u32::from_le_bytes([h[8], h[9], h[10], h[11]]) as usize;
                let io_ = c_off + u32::from_le_bytes([h[16], h[17], h[18], h[19]]) as usize;
                if vo < c_end && io_ <= c_end {
                    pools = Some((vo, io_, c_end));
                }
            }
        }
    }
    if let Some((a, _, b)) = pools {
        cut_out(&mut keep, a, b);
    }

    fn read_runs(f: &mut std::fs::File, v: &mut [u8], runs: &[(usize, usize)]) -> bool {
        use std::io::{Read, Seek, SeekFrom};
        for &(a, b) in runs {
            if b <= a {
                continue;
            }
            if f.seek(SeekFrom::Start(a as u64)).is_err() || f.read_exact(&mut v[a..b]).is_err() {
                println!("pak: short read");
                return false;
            }
        }
        true
    }
    if !read_runs(&mut f, &mut v, &keep) {
        return None;
    }

    // Nothing to plan: the pools were read above along with everything else.
    let (pools_at, i_at, pools_end) = match pools {
        Some(x) => x,
        None => return Some(v),
    };
    let (map_id, player_px) = match plan_for {
        Some(x) => x,
        None => return Some(v),
    };

    // Parse what we have -- records present, pools still zeros -- and replay
    // the allocation over it. Going through the real structures rather than
    // hand-reading the records is what stops this drifting away from what
    // build_map will decide when handed the same pak.
    let merged: Vec<(usize, usize)> = {
        let p = match pak::read_with_shared(&v, unsafe { SHARED_ATLAS }) {
            Ok(p) => p,
            Err(e) => {
                println!("pak: plan parse failed ({}), reading it whole", e);
                return read_runs(&mut f, &mut v, &[(pools_at, pools_end)]).then_some(v);
            }
        };
        let map = match p.maps.iter().find(|m| m.map_id == map_id) {
            Some(m) => *m,
            None => return read_runs(&mut f, &mut v, &[(pools_at, pools_end)]).then_some(v),
        };
        let chunks = &p.chunks[map.first as usize..(map.first + map.count) as usize];
        let (order, huge, budget) = build_order(chunks, player_px);
        // Stamps are read whole (there are a handful per map) rather than
        // tracked against which are currently hidden, so the plan is given
        // their full cost -- the same conservative direction as everything
        // else here: read at least what will be drawn, never less.
        let stamp_verts: usize =
            p.stamps_of(map_id).iter().map(|st| st.mesh.index_count as usize).sum();
        let plan = plan_build(chunks, &order, huge, budget, stamp_verts);
        planned_ranges(
            chunks,
            &plan,
            p.stamps_of(map_id),
            // every shape, not just this map's: they are shared by id
            &p.tree_shapes,
            pools_at,
            i_at,
            MERGE_SLOP,
        )
            .into_iter()
            .map(|(a, b)| (a.min(len), b.min(len)))
            .collect()
    };

    if !read_runs(&mut f, &mut v, &merged) {
        return None;
    }
    Some(v)
}

/// Two pool runs closer than this are read as one. A seek on SD costs far
/// more than a few hundred wasted bytes.
const MERGE_SLOP: usize = 8 * 1024;

fn app_heap_probe_mb() -> usize {
    let mut keep: Vec<Vec<u8>> = Vec::new();
    let mut mb = 0usize;
    loop {
        let mut v: Vec<u8> = Vec::new();
        if v.try_reserve_exact(1024 * 1024).is_err() { break; }
        v.resize(1024 * 1024, 1);
        keep.push(v);
        mb += 1;
        if mb >= 96 { break; }
    }
    mb
}

fn unsafe_free_kb() -> u32 {
    extern "C" { fn linearSpaceFree() -> u32; }
    (unsafe { linearSpaceFree() }) / 1024
}

/// Linear headroom kept free of vertex buffers, in KB. NDSP's audio buffers,
/// the page textures and citro3d's own command lists all live in the same
/// pool, so the last megabyte is not ours to spend.
const LINEAR_RESERVE_KB: u32 = 1024;

/// Can `verts` vertices be uploaded without exhausting linear memory?
///
/// citro3d-rs's `Buffer::new` allocates with `Vec::with_capacity_in(..,
/// LinearAllocator)`, which is INFALLIBLE: out of memory calls Rust's
/// handle_alloc_error, which aborts the process. On hardware that is the
/// game closing and the console rebooting, with no chance for the
/// `bi.add(..).is_ok()` below to report anything — the abort happens inside
/// the constructor, before `add` is ever called.
///
/// So the check has to happen BEFORE the allocation. A span that does not fit
/// is dropped, which costs a hole in the terrain and a line in the log
/// instead of the session.
fn linear_fits(verts: usize) -> bool {
    let need_kb = ((verts * core::mem::size_of::<Vertex>()) / 1024) as u32;
    unsafe_free_kb() > need_kb + LINEAR_RESERVE_KB
}

/// Sampling for the sprite pages: entity cards, battle mons, screen pics
/// and the UI tile sheet.
///
/// None of these lands on a whole number of device pixels. The guest draws
/// into the PSP's 480x272 and the top screen is 400x240, which is 5/6 across
/// and 15/17 down -- and the UI arrives already stretched, since the GB's
/// 8-px tile is drawn at VIEW_H / GB_H = 1.889 guest px per texel and ends
/// up covering 12.59 x 13.33 device pixels.
///
/// Nearest has to resolve those ratios by duplicating some rows of texels
/// and not others. An 8-px glyph comes out with a two-pixel stem beside a
/// one-pixel stem; UI_ORIGIN_X is fractional, so neighbouring tiles do not
/// even duplicate the same columns, and a sprite changes which row it drops
/// as it walks. That unevenness is the distortion. Linear weights the texels
/// it lands between instead: softer, but the shape survives and stops
/// crawling.
///
/// ClampToEdge matters because the page is uploaded into a power-of-two
/// surface: without it a tap in the padding wraps to the opposite edge of
/// the sprite. `build_page_tex` handles the rest of what linear exposes.
fn sprite_filter(t: &mut texture::Texture, pak: &Pak, page: u16) {
    let linear = pak.atlases.get(page as usize).is_some_and(page_linear);
    let f = if linear { texture::Filter::Linear } else { texture::Filter::Nearest };
    t.set_filter(f, f);
    t.set_wrap(texture::Wrap::ClampToEdge, texture::Wrap::ClampToEdge);
}

/// Whether a page is sampled with a linear filter rather than nearest.
///
/// The rule is whether `page_prescale` has already turned that page's
/// magnification into a minification. A linear tap is worth having when it
/// MINIFIES -- it averages real pixels, which evens out a fractional ratio.
/// Asked to magnify it invents colours between them, which is blur.
///
/// The UI sheet qualifies: at x2 its cell is 16 texels against 12.59 x 13.33
/// device pixels on the top screen and 16 x 13.33 on the companion, so every
/// axis is at or below 1:1. The companion's horizontal is exactly 1:1, where
/// a linear tap lands on texel centres and degenerates to nearest -- it stays
/// pixel-perfect for free.
///
/// Sprite and pic pages do not, and stay on nearest. An entity card is
/// magnified 1.67x, so linear alone is the blur it looked like; making it
/// minify needs x2, and examples/tex_budget.rs puts that at +5 MB of the
/// 24 MB linear heap, which would drop free memory under STRIP_MIN_FREE_KB
/// and silently stop the neighbour maps from loading. Affording it means
/// bounding what gets uploaded, which is its own change.
fn page_linear(page: &pak::AtlasPage) -> bool {
    page.kind == atlas_kind::UI
}

/// Rounds of `dilate_rgb` run over a sprite page before upload.
///
/// One. Only opaque texels are sources, so a second round has nothing new to
/// read and is pure load-time cost -- and one is all that is needed, because
/// a linear tap reaches exactly one texel past the silhouette.
const DILATE_PASSES: u32 = 1;

/// The UI sheet's cell grid, and the gutter this renderer repacks it with.
///
/// It is the only page drawn cell by cell rather than as one picture, and
/// the only page the game magnifies: the GB's 8-px tile covers 12.59 x 13.33
/// device pixels on the top screen and 16 x 13.33 on the companion. Under a
/// linear filter that magnification is what makes the packing a problem. A
/// tile's first device pixel lands at texel 0.5/M, which for any M > 1 is
/// less than half a texel in, so the tap straddles the cell boundary and
/// mixes in whichever glyph happens to sit beside this one in the sheet.
/// Drawn over a whole text box that reads as a faint dotted grid.
///
/// Repacking each cell with a one-texel border, filled by replicating the
/// cell's own edge, gives the sampler something to reach into that is a copy
/// of the cell. One texel is always enough: the tap centre is never negative,
/// so it can never reach further than the texel before the cell.
///
/// The alternative -- pulling the UVs in by half a texel -- needs no repack
/// but fits 7 texels into the space of 8, scaling every glyph up by a
/// seventh. That is far more visible than the bleed it fixes.
const UI_CELL: u32 = 8;

/// Whole-number factor each texel of a page is replicated by before upload.
///
/// This is the integer-scaling half of the fix, and it is what actually keeps
/// pixel art crisp. Filtering alone cannot: a linear tap asked to MAGNIFY
/// invents intermediate colours, which is blur. The way to avoid being asked
/// is to hand the GPU a texture that is already big enough, point-replicated
/// so every source pixel stays a hard-edged block, and let the remaining
/// fraction be a slight minification instead -- which a linear tap handles
/// well, because it is averaging real pixels rather than inventing them.
///
/// At x2 the GB's 8-px tile becomes 16 texels, and the companion screen draws
/// it across 320/20 = 16 device pixels: exactly 1:1, so the filter is a no-op
/// and the tiles are pixel-perfect. The top screen draws it at 12.59 x 13.33,
/// a 0.79x minification of hard 2x2 blocks -- near-crisp.
///
/// Only the UI sheet gets it. The sprite sheets would cost +5 MB of the 24 MB
/// linear heap (examples/tex_budget.rs), because every SPRITES page of a map
/// is pre-warmed at load and uploads live in the same pool as the terrain
/// vertex buffers -- which is exactly the pressure that used to freeze map
/// transitions. See the note on entity cards in `sprite_filter`.
fn page_prescale(page: &pak::AtlasPage) -> u32 {
    if page.kind == atlas_kind::UI { 2 } else { 1 }
}

/// Border replicated around each UI cell so a linear tap that leaves the cell
/// reads a copy of it rather than the neighbouring glyph.
///
/// One, and the argument for dropping it was wrong. It went: at x2 the UI
/// cannot magnify, because the tile would have to exceed 16 device pixels,
/// meaning a GB overlay larger than 320x288, and neither screen is 288 tall.
/// That assumes the framebuffer IS 400x240. Citra renders at an integer
/// multiple of it, so at 5x the same tile covers 63 device pixels and every
/// cell magnifies 4x -- the dotted grid across every text box came straight
/// back. A gutter does not care what resolution it is sampled at, which is
/// the whole point of having one.
///
/// Costs 750 KB: the repacked sheet goes from 256x256 to 288x288, which
/// rounds up to 512x512. examples/ui_bleed.rs is the check.
const UI_GUTTER: u32 = 1;

fn ui_cell_px(scale: u32) -> u32 { UI_CELL * scale }
fn ui_pitch(scale: u32) -> u32 { ui_cell_px(scale) + UI_GUTTER * 2 }

/// Dimensions `build_page_tex` lays a page out at, before power-of-two
/// padding: the source scaled up, and for the UI sheet repacked cell by cell.
fn page_layout_dims(page: &pak::AtlasPage) -> (u32, u32) {
    let (aw, ah) = (page.w as u32, page.h as u32);
    let s = page_prescale(page);
    if page.kind == atlas_kind::UI {
        (aw.div_ceil(UI_CELL) * ui_pitch(s), ah.div_ceil(UI_CELL) * ui_pitch(s))
    } else {
        (aw * s, ah * s)
    }
}

/// The texture dimensions `build_page_tex` produces, which is what UVs
/// divide by.
fn page_tex_size(page: &pak::AtlasPage) -> (f32, f32) {
    let (gw, gh) = page_layout_dims(page);
    (po2(gw) as f32, po2(gh) as f32)
}

/// Repacked column/row -> the source column/row it copies: which cell it
/// falls in, then which of that cell's eight texels, with the edge replicated
/// through any gutter.
fn ui_cell_src(e: u32, scale: u32, limit: u32) -> u32 {
    let cell = e / ui_pitch(scale);
    let within = (e % ui_pitch(scale))
        .saturating_sub(UI_GUTTER)
        .min(ui_cell_px(scale) - 1);
    (cell * UI_CELL + within / scale).min(limit - 1)
}

/// UV rect of one tile in the repacked sheet, V already flipped (texture
/// rows are stored inverted relative to the UV convention, as uv mode 5).
/// Spans the cell's real texels exactly, so the glyph keeps its size.
fn ui_tile_uv(tile: u16, cols: u16, pw: f32, ph: f32, scale: u32) -> (f32, f32, f32, f32) {
    let (pitch, c, g) = (ui_pitch(scale) as f32, ui_cell_px(scale) as f32, UI_GUTTER as f32);
    let x0 = (tile % cols) as f32 * pitch + g;
    let y0 = (tile / cols) as f32 * pitch + g;
    (x0 / pw, (x0 + c) / pw, 1.0 - y0 / ph, 1.0 - (y0 + c) / ph)
}

/// Byte offsets within one uploaded texel.
///
/// `build_page_tex` writes a palette entry out most-significant byte first,
/// and the entries are stored alpha-high -- so the four bytes on the way to
/// the GPU are ALPHA, then the three colour channels. The locals there are
/// spelled r/g/b/a, which is a lie worth naming: reading byte 3 as the alpha
/// treats opaque black ink (alpha 255, colour 0,0,0) as transparent and
/// reads a fully transparent texel as opaque. Every page in the game has
/// exactly those two values, so nothing about it is a corner case.
///
/// Which of bytes 1..3 is red does not matter here -- the dilation averages
/// each channel independently -- so they are just COLOR.
const ALPHA: usize = 0;
const COLOR: [usize; 3] = [1, 2, 3];

/// Push opaque colour outward into the transparent texels touching it,
/// leaving alpha untouched.
///
/// Sprite pages are CLUT8, and their transparent palette entries carry a
/// real colour: index 3 is (255, 0, 0, 0) and index 255 is (0, 0, 0, 0).
/// Nearest sampling never sees those texels -- alpha 0 means the blender
/// discards them whatever the RGB. A bilinear tap does see them, and
/// interpolating a sprite's edge against stored red or black rings every
/// silhouette with a halo. Bleeding the neighbouring opaque colour into the
/// dead texels first means the blend crosses a colour that matches the
/// sprite, so the edge just softens.
fn dilate_rgb(texels: &mut [u8], w: u32, h: u32) {
    if w == 0 || h == 0 { return; }
    let src = texels.to_vec();
    for y in 0..h {
        for x in 0..w {
            let o = ((y * w + x) * 4) as usize;
            if src[o + ALPHA] != 0 { continue; }
            let (mut c, mut n) = ([0u32; 3], 0u32);
            for dy in -1i32..=1 {
                for dx in -1i32..=1 {
                    let (nx, ny) = (x as i32 + dx, y as i32 + dy);
                    if nx < 0 || ny < 0 || nx >= w as i32 || ny >= h as i32 { continue; }
                    let p = ((ny as u32 * w + nx as u32) * 4) as usize;
                    if src[p + ALPHA] == 0 { continue; }
                    for (k, acc) in c.iter_mut().enumerate() {
                        *acc += src[p + COLOR[k]] as u32;
                    }
                    n += 1;
                }
            }
            if n == 0 { continue; }
            for (k, acc) in c.iter().enumerate() {
                texels[o + COLOR[k]] = (acc / n) as u8;
            }
            // alpha stays 0: this texel is still invisible, it just no
            // longer poisons the taps that straddle it.
        }
    }
}

fn build_page_tex(pak: &Pak, pidx: u16, pal_sel: i32) -> (Vec<u8>, u32, u32) {
    let page = pak.atlases[pidx as usize];
    let lin = pak::unswizzle(page.w as usize, page.h as usize, page.frame(0))
        .unwrap_or_else(|_| vec![0u8; (page.w as usize) * (page.h as usize)]);
    let palv = &pak.palettes[resolve_pal(pak, pidx, page.kind, COLOR_PAL_NONE, pal_sel)];
    let (aw, ah) = (page.w as u32, page.h as u32);
    let (gw, gh) = page_layout_dims(&page);
    let (tw, th) = (po2(gw), po2(gh));
    if aw == 0 || ah == 0 {
        return (vec![0u8; (tw * th * 4) as usize], tw, th);
    }
    // Expand to a linear scratch before swizzling: dilation needs neighbour
    // access, which the GPU's tiled layout does not give cheaply.
    //
    // A palette entry goes out most-significant byte first, which puts ALPHA
    // in byte 0 and the colour in bytes 1..3 -- see ALPHA / COLOR above. Do
    // not rename these to r/g/b/a.
    let mut flat = vec![0u8; (aw * ah * 4) as usize];
    for i in 0..(aw * ah) as usize {
        let c = palv[lin[i] as usize];
        flat[i * 4] = ((c >> 24) & 0xff) as u8;
        flat[i * 4 + 1] = ((c >> 16) & 0xff) as u8;
        flat[i * 4 + 2] = ((c >> 8) & 0xff) as u8;
        flat[i * 4 + 3] = (c & 0xff) as u8;
    }
    // Only a linear tap can ever read a transparent texel's colour, so on a
    // nearest page this is pure load-time cost.
    if page_linear(&page) {
        for _ in 0..DILATE_PASSES {
            dilate_rgb(&mut flat, aw, ah);
        }
    }
    let is_ui = page.kind == atlas_kind::UI;
    let scale = page_prescale(&page);
    let mut out = vec![0u8; (tw * th * 4) as usize];
    for y in 0..th {
        for x in 0..tw {
            // Two clamps, outermost first.
            //
            // Pages are uploaded into a power-of-two surface, so a 40x40
            // page sits in 64x64 with 24 dead rows and columns pressed
            // against live sprite texels. Clamping into the laid-out area
            // (rather than leaving the padding zeroed) turns that margin
            // into an extension of the edge, so a bilinear tap straying off
            // the page reads the page instead of a hole.
            let (ex, ey) = (x.min(gw - 1), y.min(gh - 1));
            // Then the point replication -- every source texel repeated
            // `scale` times each way, so it stays a hard-edged block. The UI
            // sheet goes cell by cell, since its cells are repacked on their
            // own pitch. See page_prescale / UI_GUTTER.
            let (sx, sy) = if is_ui {
                (ui_cell_src(ex, scale, aw), ui_cell_src(ey, scale, ah))
            } else {
                ((ex / scale).min(aw - 1), (ey / scale).min(ah - 1))
            };
            let s = ((sy * aw + sx) * 4) as usize;
            let o = tiled_off(x, y, tw);
            out[o] = flat[s];
            out[o + 1] = flat[s + 1];
            out[o + 2] = flat[s + 2];
            out[o + 3] = flat[s + 3];
        }
    }
    (out, tw, th)
}

static mut DRAWN: u32 = 0;

// libctru's default split leaves the app heap small and the linear heap
// larger than this renderer needs. The pak (a single contiguous read) lives
// on the app heap, so give it the room.
#[no_mangle]
// Hardware grants far less than the emulator: 100+20 MB aborts at startup
// under the Homebrew Launcher. 64+24 leaves room for libctru's own needs.
// The forest pak alone is 58 MB; at a 64 MB app heap the read left nothing
// for QuickJS or the geometry staging Vec.
#[no_mangle]
pub static __ctru_heap_size: u32 = 92 * 1024 * 1024;
#[no_mangle]
pub static __ctru_linear_heap_size: u32 = 24 * 1024 * 1024;

fn po2(n: u32) -> u32 { let mut p = 8u32; while p < n { p <<= 1; } p }

/// The guest's screen, which is the PSP's: every ScreenPic and UiQuad
/// arrives in these coordinates.
const UI_VIEW_W: f32 = 480.0;
const UI_VIEW_H: f32 = 272.0;

/// Sub-pixel resolution of the screen-space vertex grid.
///
/// `Vertex::pos` is four i16s -- the attribute layout the terrain shares,
/// where integer world units are the natural grid. Screen-space quads used
/// to be converted into 400x240 device pixels and truncated into it, which
/// rounded every edge to a whole device pixel: an 8-px UI tile landed on
/// 8 * 400/480 = 6.67 pixels and so came out 6 wide or 7 wide depending on
/// where it fell, and a text box's tiles visibly disagreed about their size.
///
/// Keeping the guest's own coordinates and scaling by Q instead leaves the
/// 480->400 mapping to the ortho below, where the GPU does it at full
/// rasteriser precision. Q = 4 puts the remaining rounding at a quarter of
/// a guest pixel, well under a device pixel. 480 * 4 fits i16 with room to
/// spare.
const UI_Q: f32 = 4.0;
/// How far a fully popped picture (`picDepth` 256) stands out of the screen,
/// in the 480-wide ortho's pixels, with the 3D slider all the way up. Out-of
/// -screen parallax past about this much stops fusing and starts hurting,
/// which is the whole reason it is a small number.
const POP_PX: f32 = 10.0;

/// Guest screen coordinate -> the quantised grid `Vertex::pos` stores.
fn qpx(v: f32) -> i16 { (v * UI_Q) as i16 }

/// Top screen height in device pixels.
const SCREEN_H: f32 = 240.0;

/// Device pixels per world pixel at the camera's focus plane. Two, exactly,
/// and the exactness is the entire point.
///
/// Art in this game is 16 world pixels to the cell and 16 texels to the
/// sprite, so one world pixel is one texel. Fixing that ratio at a whole
/// number is what integer scaling means here: every source pixel becomes a
/// 2x2 block of device pixels, all of them the same size. At the 2.13 this
/// used to be, a sprite's pixels came out two device pixels wide or three
/// depending on where they fell, which is what wrecked the player's eyes.
const WORLD_PX_SCALE: f32 = 2.0;

/// Vertical field of view that puts exactly `WORLD_PX_SCALE` device pixels
/// on a world pixel at the overworld camera's distance.
///
/// `cam::orbit` always sits WORLD_VIEW_H from its focus whatever the pitch
/// rung, and the camera focus IS the player, so the player's card is always
/// at this distance and always dead centre. It therefore lands on an exact
/// 2x at every moment, walking included -- and at a whole-number ratio a
/// sub-pixel offset only shifts the phase, it cannot make one source pixel
/// wider than its neighbour.
///
/// It works out to 47.6 degrees against the 45 that was here, so the view
/// pulls back about 6%: 120 world pixels of height instead of 112.7. That
/// direction is free -- the view-cone cull's TAN_HHALF is 0.958 and the new
/// horizontal half-angle is 0.735, so it stays conservative.
///
/// Only the focus plane is exact. Perspective means an entity out at the
/// screen edge is further from the eye and lands near 1.6x, so NPCs are
/// approximate; nothing short of an orthographic projection fixes that, and
/// ortho would flatten the voxel world and break the 3D slider.
fn world_fov() -> f32 {
    let half = (SCREEN_H / (2.0 * WORLD_VIEW_H as f32 * WORLD_PX_SCALE)).atan();
    half * 2.0
}

/// A card vertex. Same layout as `Vertex` except the position is three
/// floats instead of four i16s, and `card_attr` is the matching attribute
/// info.
///
/// Cards get their own format because they are the one thing that must land
/// on an exact number of device pixels. `world_fov` puts precisely 2.0 device
/// pixels on a world pixel at the camera's focus, so the player's card is
/// exactly 32 device pixels across 16 texels -- but only if its corners
/// arrive unrounded. Quantising them, at any step size, rounds each corner
/// independently AFTER the eye-ray pull has moved it, so the card's width
/// wobbles by a fraction of a pixel and re-rounds every frame as the player
/// walks. That is a pixel of the hat growing and shrinking. Floats cost 8
/// more bytes on a handful of vertices per frame and remove the question.
#[repr(C)]
#[derive(Copy, Clone)]
struct CardVertex { pos: [f32; 3], color: [u8; 4], uv: [f32; 2] }

fn tiled_off(x: u32, y: u32, tw: u32) -> usize {
    let (tx, ty) = (x / 8, y / 8);
    let (px, py) = (x % 8, y % 8);
    let m = (px & 1) | ((py & 1) << 1) | ((px & 2) << 1)
          | ((py & 2) << 2) | ((px & 4) << 2) | ((py & 4) << 3);
    (((ty * (tw / 8) + tx) * 64 + m) * 4) as usize
}

#[repr(C)]
#[derive(Copy, Clone)]
struct Vertex { pos: [i16; 4], color: [u8; 4], uv: [f32; 2] }

static SHADER_BYTES: &[u8] = include_shader!("vshader.pica");
static GAME_JS: &[u8] = include_bytes!("../game.js");
const SKY: u32 = 0x68_B0_D8_FF;
extern "C" {
    fn svcOutputDebugString(s: *const u8, len: i32) -> u32;
}

/// Past this, the circle pad counts as pushed. It rests a few units off
/// centre and drifts with age, so the dead zone has to clear that without
/// eating the first part of the throw. Full deflection is about 156.
const STICK_DEAD: i16 = 40;

/// Read the circle pad as a d-pad press, dominant axis only.
///
/// One direction at a time on purpose: the world is a tile grid and the
/// walker takes a single direction per step, so turning a diagonal push into
/// two presses would leave the choice to whichever the guest happens to test
/// first. The dominant axis is what the player meant.
///
/// dy is positive upwards.
fn stick_as_dpad(dx: i16, dy: i16) -> i32 {
    if dx.abs() <= STICK_DEAD && dy.abs() <= STICK_DEAD {
        return 0;
    }
    if dx.abs() > dy.abs() {
        if dx > 0 { 1 << 3 } else { 1 << 2 } // right / left
    } else if dy > 0 {
        1 << 0 // up
    } else {
        1 << 1 // down
    }
}


/// Log files, best first.
///
/// pvlog.txt is FIRST and stays: it is the one that has actually been seen
/// working on hardware. newlog.txt beside it is truncated at boot so it holds
/// one run. The SD root copy is there because a file at the root cannot be
/// missed, and if the game folder is not writable it is the one place that
/// still is.
const LOG_PATHS: [&str; 3] = [
    "sdmc:/3ds/voxelmon/pvlog.txt",
    "sdmc:/3ds/voxelmon/newlog.txt",
    "sdmc:/newlog.txt",
];
/// Which of those are truncated at boot (the two "this run only" ones).
const LOG_FRESH: [bool; 3] = [false, true, true];

/// Prepare the log files for this run.
unsafe fn log_open() {
    // The folder may not exist on a fresh card, and create(true) will not
    // make it.
    let _ = std::fs::create_dir_all("sdmc:/3ds/voxelmon");
    for (i, path) in LOG_PATHS.iter().enumerate() {
        if LOG_FRESH[i] {
            // Truncate by writing empty, the same call the save uses.
            if let Err(e) = std::fs::write(path, "") {
                println!("log: cannot write {} ({})", path, e);
            }
        } else if std::fs::metadata(path).map(|m| m.len() > 512 * 1024).unwrap_or(false) {
            // The accumulating one, trimmed only when it has grown large: a
            // freeze is investigated by relaunching, and wiping it on boot
            // would destroy the run being investigated.
            let _ = std::fs::write(path, "");
        }
    }
}

/// Diagnostics that survive to a log file. `println!` goes to the ctru
/// Console, which this build hands to the Kanto Gear right after boot, so
/// nothing printed during play is ever readable. svcOutputDebugString is
/// picked up by emulators (Citra writes it to citra_log.txt as
/// Debug_Emulated) and by 3dslink on hardware.
///
/// Opened and CLOSED per line, deliberately. Holding the handle open for the
/// session was tried and produced no file at all on hardware: HOME takes the
/// process without running destructors, so a handle that is never closed
/// leaves the directory entry uncommitted and the file simply is not there.
/// Closing every line is what commits it. Called about once a second, so the
/// cost is not worth the risk of losing the whole log.
///
/// Outside the forest zone (see `forest_zone`) the cost is cut two ways: one
/// file instead of three, and the dozen lines a map load writes are gathered
/// (`dlog_batch_begin`) and committed in ONE open/close when it ends
/// (`dlog_batch_end`) instead of thirty-odd, each of which is an SD round
/// trip in the frame the player is waiting on. Inside the zone every line
/// still goes to all three files the moment it is written, as it always has.
#[allow(static_mut_refs)]
fn dlog(s: &str) {
    unsafe {
        svcOutputDebugString(s.as_ptr(), s.len() as i32);
        if !LEGACY_ZONE {
            if let Some(b) = DLOG_BATCH.as_mut() {
                b.push_str(s);
                b.push('\n');
                return;
            }
        }
    }
    use std::io::Write;
    let paths: &[&str] = if unsafe { LEGACY_ZONE } { &LOG_PATHS } else { &LOG_PATHS[..1] };
    for path in paths {
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(f, "{}", s);
        }
    }
}

/// Write a panic to the log before the process dies.
///
/// A Rust panic on this console aborts, and an aborted 3dsx drops the
/// player straight back to the homebrew menu -- no message, no dump,
/// nothing to go on but "it crashed". The default hook prints to stderr,
/// which nobody can read on hardware. This puts the same line where every
/// other diagnostic already goes, and writes it STRAIGHT to the file
/// rather than the batch, which is about to be lost with everything else.
fn install_panic_log() {
    std::panic::set_hook(Box::new(|info| {
        let where_ = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "?".to_string());
        let msg = format!("[pv] PANIC at {where_}: {}", info);
        unsafe {
            svcOutputDebugString(msg.as_ptr(), msg.len() as i32);
        }
        use std::io::Write;
        for path in LOG_PATHS.iter() {
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
                let _ = writeln!(f, "{}", msg);
                let _ = f.flush();
            }
        }
    }));
}

/// osGetTime, for the load timings.
fn now_ms() -> u64 {
    extern "C" { fn osGetTime() -> u64; }
    unsafe { osGetTime() }
}

/// Where the last map load's time went, ms: the guest's frame that asked
/// for it, the pak read, then the host's stages. Logged as one line.
static mut LOAD_JS_MS: u64 = 0;
static mut LOAD_PAK_MS: u64 = 0;

/// True while the player is in or beside Viridian Forest: every load path
/// there stays exactly as it was (logging, seam strips, the build).
static mut LEGACY_ZONE: bool = false;
/// Lines held for one write at the end of a map load (outside the zone).
static mut DLOG_BATCH: Option<String> = None;

/// Viridian Forest and its two gates. Route 2 was in this list too, which
/// put Route 2, Pewter and Viridian City (Route 2's neighbours) all on the
/// slow path; none of them is where the forest has ever failed.
fn forest_zone(name: &str) -> bool {
    name.starts_with("VIRIDIAN_FOREST")
}

#[allow(static_mut_refs)]
fn dlog_batch_begin() {
    unsafe {
        if !LEGACY_ZONE && DLOG_BATCH.is_none() {
            DLOG_BATCH = Some(String::new());
        }
    }
}

#[allow(static_mut_refs)]
fn dlog_batch_end() {
    let Some(b) = (unsafe { DLOG_BATCH.take() }) else { return };
    if b.is_empty() {
        return;
    }
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(LOG_PATHS[0]) {
        let _ = f.write_all(b.as_bytes());
    }
}

/// Per-frame cull accounting, so a hole in the world can be attributed to a
/// specific test instead of guessed at. MIN_CULLED_D is the distance of the
/// NEAREST span any cull threw away: if that is small, something close
/// enough to be on screen is being dropped.
static mut CULL_RADIUS_N: u32 = 0;
/// Tree instances drawn last frame (the cull log line).
static mut TREES_DRAWN: u32 = 0;
/// Why the rest were not: no shape, radius, view cone, failed draw.
static mut TREES_CULLED: [u32; 4] = [0; 4];
static mut CULL_CONE_N: u32 = 0;
static mut CULL_OCCL_N: u32 = 0;
static mut MIN_CULLED_D: f32 = 0.0;

/// Modulate an RGBA8 colour (0xRRGGBBAA — what `target.clear` takes, and the
/// byte order `SKY` is written in) by a scene tint (0xAABBGGRR, the order
/// `draw::modulate_rgb` works in). Alpha is kept. Without this the sky stays
/// bright blue while `build_map` bakes the tint into the ground, so HM
/// Flash's dark cave reads as a lit horizon over a black floor.
fn tint_rgba8(color: u32, tint: u32) -> u32 {
    let ch = |c: u32, t: u32| ((c * t + 127) / 255) & 0xff;
    let (tr, tg, tb) = (tint & 0xff, (tint >> 8) & 0xff, (tint >> 16) & 0xff);
    (ch((color >> 24) & 0xff, tr) << 24)
        | (ch((color >> 16) & 0xff, tg) << 16)
        | (ch((color >> 8) & 0xff, tb) << 8)
        | (color & 0xff)
}

/// The battle camera's own no-clip: a chunk gets skipped, not just culled
/// by the ordinary view cone, if the straight line from the camera's eye to
/// the arena it's framing (`focus`) actually passes through the chunk's
/// AABB. This is a real 3D test, not an XZ radius — a flat-ground chunk
/// whose top sits below where the sightline is at that point does NOT
/// intersect it and stays drawn (so the arena keeps a floor under it), but
/// a wall, roof, or tree hull tall enough to cross the sightline does, and
/// gets skipped instead of eating the whole screen the way a building
/// planted between the camera and the arena otherwise would.
///
/// `margin_px` shortens the segment at the arena end (world px) so the
/// chunk the arena is actually standing on — which the sightline also
/// technically "hits" once it reaches the target — is never treated as an
/// occluder of itself.
fn segment_hits_box(
    eye: FVec3,
    focus: FVec3,
    seg_len: f32,
    margin_px: f32,
    bmin: [f32; 3],
    bmax: [f32; 3],
) -> bool {
    let origin = [eye.x(), eye.y(), eye.z()];
    let dir = [focus.x() - eye.x(), focus.y() - eye.y(), focus.z() - eye.z()];
    let t_limit = ((seg_len - margin_px) / seg_len).clamp(0.0, 1.0);
    let mut tmin = 0.0f32;
    let mut tmax = t_limit;
    for i in 0..3 {
        if dir[i].abs() < 1e-6 {
            if origin[i] < bmin[i] || origin[i] > bmax[i] {
                return false;
            }
            continue;
        }
        let inv_d = 1.0 / dir[i];
        let (mut t1, mut t2) = ((bmin[i] - origin[i]) * inv_d, (bmax[i] - origin[i]) * inv_d);
        if t1 > t2 {
            core::mem::swap(&mut t1, &mut t2);
        }
        if t1 > tmin { tmin = t1; }
        if t2 < tmax { tmax = t2; }
        if tmin > tmax {
            return false;
        }
    }
    true
}
/// How far back from the arena the no-clip segment stops (world px, ~2
/// cells) — see segment_hits_box's `margin_px` doc.
const BATTLE_OCCLUDE_MARGIN_PX: f32 = 32.0;
// The generous cap: Cerulean City needs 758,508 to draw everything at full
// detail (terrain 250,128 + terrain_keep 90,636 + water 3,672 + ALL tree
// hulls 274,200 + flower 139,872 — measured straight from the cooked pak).
// 900,000 clears that with room. Cost: `geom.verts` is a flat Vec<Vertex>
// (20 bytes/vertex) sized to whatever a map actually uses, capped here — so
// a map allowed to reach this ceiling can claim up to ~18 MB on the app heap
// (92 MB total, shared with the pak read and QuickJS) at map-load time,
// instead of ~8 MB at the old 400,000 cap. Confirmed on hardware: fine for
// Cerulean, but a CRASH on Continue into a Viridian Forest save — its own
// pak alone is already 58 MB (PAK_CACHE_BUDGET_KB comment above), so an
// 18 MB vertex buffer on top of that overflows where Cerulean's doesn't.
// Forest-scale maps use MAX_VERTS_SAFE instead — see `budget_for` below.
// The original conservative cap ("Routes and towns sit just under it,
// Viridian City 396k, Route 2 383k"), kept for maps whose content is so far
// past even the generous cap that reaching for it is what crashes — not
// maps that merely exceed it a bit, like Cerulean. Viridian Forest's tree
// hulls alone run ~4.4M indices; even letting it climb toward MAX_VERTS
// before falling back to boxes still means allocating a much larger buffer
// than this, which is the actual hardware failure, not the boxes.
/// Above this measured total (ground + full tree hulls + filler), a map is
/// "wildly" oversized rather than moderately over budget, and gets the safe
/// cap instead of the generous one. 3x MAX_VERTS_SAFE cleanly separates the
/// two known data points: Cerulean City (758,508) stays under it and gets
/// the generous cap; Viridian Forest (~4.4M) is far over and gets the safe
/// one.
/// terrain, terrain_keep, water (spec::mesh_kind): the walkable ground and
/// the water surface it borders, always first and always in full. Water
/// rides with ground rather than with grass/flower below despite being
/// cheap in practice (Cerulean City: 3,672 indices total) — a missing lake
/// reads as broken in a way a few missing flowers don't, so it isn't worth
/// leaving to "whatever's left".
/// grass, flower: no cheaper LOD exists for these, but they're the least
/// noticeable thing to lose a few of, so they're processed LAST — whatever
/// survives ground + trees. On a big, dense map (Cerulean City: ground+water
/// alone is 344,436 of the 400,000 budget) this can mean some flowers don't
/// make it in; that's the intended trade against boxy/missing trees, not a
/// bug. This matches the original single-pass order (terrain, terrain_keep,
/// tree, water, grass, flower) for grass/flower's position relative to
/// trees; only water moved (see above) and the tree step below changed.
/// Round tree/rock cells cook THREE representations of the same cell: the
/// fine per-pixel hull (~700 quads), a 2x2-px coarse carve (still round,
/// ~1/4 the hull's cost), and a plain box (~10 quads) — spec.rs
/// QualityDials, the same ladder the PSP rung climbs down by camera
/// distance. Here (map-load time, no camera yet) the choice is made per
/// CHUNK against the remaining vertex budget instead: see the tree loop in
/// `build_map`.
const TREE_HULL_KIND: usize = 3;
const TREE_COARSE_KIND: usize = 4;
const TREE_BOX_KIND: usize = 5;
/// Mesh kinds per chunk record (spec::mesh_kind).
const MESH_KINDS_N: usize = 9;
/// For a "huge" map (over HUGE_MAP_THRESHOLD — currently just Viridian
/// Forest), `build_map` always stays at MAX_VERTS_SAFE and, once the
/// player's position is known, sorts every one of the map's chunks nearest-
/// first before building them, re-sorting each time they cross into a new
/// chunk (see the chunk-crossing check in `main()`) — so the limited budget
/// is spent on whatever's actually close, not whatever came first in file
/// order, and that follows them as they walk. Every other map never takes
/// this path at all: the prescan only diverges from "build everything once,
/// full budget" when a map is classified huge to begin with.

/// One draw range of the flat terrain buffer, carrying BOTH boxes the culls
/// need. `bmin/bmax` is the chunk's own AABB — what the view-cone and radius
/// culls have always used, left alone so their tuning still holds.
/// `gmin/gmax` is the tight bound of the geometry this span actually pushed,
/// which the battle sightline test needs instead: every kind in a chunk
/// shares the chunk AABB, so a tree's chunk box spans the full 128 px cell
/// block floor-to-canopy and would answer "blocks the view" almost anywhere.
#[derive(Clone, Copy)]
struct Span {
    bmin: [f32; 3],
    bmax: [f32; 3],
    gmin: [f32; 3],
    gmax: [f32; 3],
    /// Safe to drop out of the battle camera's line of sight, because
    /// removing it leaves no hole: trees and stamps. Terrain is NOT — a
    /// chunk's floor and its buildings' walls are one mesh stream (cook's
    /// runGeometry emits both as `terrain`), so dropping a wall drops the
    /// ground with it and opens sky under the arena.
    occludable: bool,
    start: usize,
    end: usize,
}

struct MapGeom {
    /// The floor under each cell, measured off the terrain (floor_map_of).
    floor: pocketvoxel_core::scene::FloorMap,
    chunk_spans: Vec<Span>,
    verts: Vec<Vertex>,
    center: [f32; 3],
    size: f32,
    tex_rgba: Vec<u8>,
    tw: u32,
    th: u32,
    aw: u32,
    ah: u32,
    /// True when this map was classified "huge" (over HUGE_MAP_THRESHOLD) —
    /// the caller uses this to know whether to watch for chunk-crossing and
    /// re-stream, rather than re-deriving the same classification itself.
    is_huge: bool,
    /// The map's FULL world bounds in XZ, over every chunk it has — not
    /// just the ones the vertex budget built. Neighbour strips key off this
    /// to find the shared seam (see load_neighbor_strip).
    map_min: [f32; 2],
    map_max: [f32; 2],
}

/// Push one chunk's mesh range for `kind` into the flat vertex buffer and
/// record its span; a no-op when that chunk has no geometry for `kind`.
/// Is this triangle the INNER side of a border-ring block? Those faces lie
/// exactly on the real map's edge -- centroid on the clip line, so the
/// past-the-edge test keeps them -- and face into the map, which is what
/// stood as a hedge wall across every path at a seam. Faces of the real
/// map's own edge blocks face outward and are left alone.
fn ring_inner_face(p: [[f32; 3]; 3], clip_min: [f32; 2], clip_max: [f32; 2]) -> bool {
    const ON: f32 = 0.01;
    let mx = (p[0][0] + p[1][0] + p[2][0]) / 3.0;
    let mz = (p[0][2] + p[1][2] + p[2][2]) / 3.0;
    // Nearly every triangle is nowhere near an edge: answer those before
    // the cross product, which is the per-triangle cost of this test.
    let on_x = (mx - clip_min[0]).abs() < ON || (mx - clip_max[0]).abs() < ON;
    let on_z = (mz - clip_min[1]).abs() < ON || (mz - clip_max[1]).abs() < ON;
    if !on_x && !on_z {
        return false;
    }
    let a =[p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
    let b = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
    let nx = a[1] * b[2] - a[2] * b[1];
    let nz = a[0] * b[1] - a[1] * b[0];
    ((mx - clip_min[0]).abs() < ON && nx > 0.0)
        || ((mx - clip_max[0]).abs() < ON && nx < 0.0)
        || ((mz - clip_min[1]).abs() < ON && nz > 0.0)
        || ((mz - clip_max[1]).abs() < ON && nz < 0.0)
}

/// Stops (silent, last-resort backstop) if `verts` is already at `budget` —
/// callers that care about it check `verts.len()` before choosing `kind`.
fn push_chunk_mesh(
    pak: &Pak,
    chunk: &pak::Chunk,
    kind: usize,
    budget: usize,
    tint: u32,
    clip_min: [f32; 2],
    clip_max: [f32; 2],
    verts: &mut Vec<Vertex>,
    chunk_spans: &mut Vec<Span>,
    cmin: &mut [f32; 3],
    cmax: &mut [f32; 3],
) {
    let m = chunk.meshes[kind];
    if m.index_count == 0 {
        return;
    }
    let span_start = verts.len();
    let bmin = [chunk.aabb_min[0] as f32, chunk.aabb_min[1] as f32, chunk.aabb_min[2] as f32];
    let bmax = [chunk.aabb_max[0] as f32, chunk.aabb_max[1] as f32, chunk.aabb_max[2] as f32];
    let vbase = m.vert_base as usize;
    let mut gmin = [f32::MAX; 3];
    let mut gmax = [f32::MIN; 3];
    // Walk TRIANGLES, not loose indices, so the border ring can be dropped
    // whole-primitive: `clip` is the real map box on any side that has a
    // connected neighbour drawn behind it (see build_map), and ±huge on the
    // sides that do not, where the ring is still the only thing standing
    // between the player and empty sky.
    let tri_count = m.index_count as usize / 3;
    for t in 0..tri_count {
        if verts.len() + 3 > budget {
            break;
        }
        let b = m.index_base as usize + t * 3;
        let (Some(p0), Some(p1), Some(p2)) = (
            pool_vert(pak, vbase, b),
            pool_vert(pak, vbase, b + 1),
            pool_vert(pak, vbase, b + 2),
        ) else {
            break;
        };
        let mid_x = (p0.x as f32 + p1.x as f32 + p2.x as f32) / 3.0;
        let mid_z = (p0.z as f32 + p1.z as f32 + p2.z as f32) / 3.0;
        if mid_x < clip_min[0] || mid_x > clip_max[0]
            || mid_z < clip_min[1] || mid_z > clip_max[1]
        {
            continue;
        }
        let pos = |v: &pak::PakVert| [v.x as f32, v.y as f32, v.z as f32];
        if ring_inner_face([pos(&p0), pos(&p1), pos(&p2)], clip_min, clip_max) {
            continue;
        }
        for pv in [p0, p1, p2] {
            let a = draw::modulate_rgb(pv.abgr, tint);
            let p = [pv.x as f32, pv.y as f32, pv.z as f32];
            for c in 0..3 {
                if p[c] < cmin[c] { cmin[c] = p[c]; }
                if p[c] > cmax[c] { cmax[c] = p[c]; }
                if p[c] < gmin[c] { gmin[c] = p[c]; }
                if p[c] > gmax[c] { gmax[c] = p[c]; }
            }
            verts.push(Vertex {
                pos: [pv.x, pv.y, pv.z, 0],
                color: [(a & 0xff) as u8, ((a >> 8) & 0xff) as u8, ((a >> 16) & 0xff) as u8, 255],
                uv: [pv.uf(), pv.vf()],
            });
        }
    }
    if verts.len() > span_start {
        chunk_spans.push(Span {
            bmin,
            bmax,
            gmin,
            gmax,
            occludable: kind == TREE_HULL_KIND
                || kind == TREE_COARSE_KIND
                || kind == TREE_BOX_KIND,
            start: span_start,
            end: verts.len(),
        });
    }
}

/// Push one removable stamp's mesh (cut tree, the S.S. Anne hull — cooked
/// into the pak's STMP section, not CHNK) into the flat vertex buffer.
/// Stamps carry no `pak::Chunk`-style AABB of their own, so the span's
/// bounding box is derived from its own vertices instead.
/// How many mesh reads have been refused for pointing outside the pools.
/// Anything but 0 means a pak whose records and pools disagree.
static mut POOL_OOB: u32 = 0;

/// One vertex of a mesh, or None when the range reaches past the pools.
///
/// A record that disagrees with its pools is a broken pak either way, but
/// on a console the difference between a missing mesh and an INDEX PANIC
/// is the whole session: a panic aborts, and an aborted 3dsx drops the
/// player back to the homebrew menu with nothing said. Every read of the
/// two pools goes through here so a bad range costs a hole and a line in
/// the log instead.
#[inline]
fn pool_vert(pak: &Pak, vbase: usize, index_at: usize) -> Option<pak::PakVert> {
    let idx = *pak.indices.get(index_at)? as usize;
    let v = pak.verts.get(vbase + idx).copied();
    if v.is_none() {
        unsafe { POOL_OOB += 1 };
    }
    v
}

fn push_stamp_mesh(
    pak: &Pak,
    stamp: &pak::Stamp,
    budget: usize,
    tint: u32,
    verts: &mut Vec<Vertex>,
    chunk_spans: &mut Vec<Span>,
    cmin: &mut [f32; 3],
    cmax: &mut [f32; 3],
) {
    let m = stamp.mesh;
    if m.index_count == 0 {
        return;
    }
    let span_start = verts.len();
    let vbase = m.vert_base as usize;
    let mut smin = [f32::MAX; 3];
    let mut smax = [f32::MIN; 3];
    for k in 0..m.index_count as usize {
        if verts.len() >= budget {
            break;
        }
        let Some(pv) = pool_vert(pak, vbase, m.index_base as usize + k) else {
            break;
        };
        let a = draw::modulate_rgb(pv.abgr, tint);
        let p = [pv.x as f32, pv.y as f32, pv.z as f32];
        for c in 0..3 {
            if p[c] < cmin[c] { cmin[c] = p[c]; }
            if p[c] > cmax[c] { cmax[c] = p[c]; }
            if p[c] < smin[c] { smin[c] = p[c]; }
            if p[c] > smax[c] { smax[c] = p[c]; }
        }
        verts.push(Vertex {
            pos: [pv.x, pv.y, pv.z, 0],
            color: [(a & 0xff) as u8, ((a >> 8) & 0xff) as u8, ((a >> 16) & 0xff) as u8, 255],
            uv: [pv.uf(), pv.vf()],
        });
    }
    if verts.len() > span_start {
        chunk_spans.push(Span {
            // A stamp has no chunk AABB of its own, so both boxes are its
            // own vertex bounds — already tight.
            bmin: smin,
            bmax: smax,
            gmin: smin,
            gmax: smax,
            occludable: true,
            start: span_start,
            end: verts.len(),
        });
    }
}

/// How far past the shared seam a neighbour map is drawn, world px. The
/// view only reaches ~233 px, so three chunks is already more than can be
/// seen from the boundary.
const STRIP_DEPTH_PX: f32 = 2.0 * CHUNK_PX as f32;
/// Ceiling on one neighbour's strip, in vertices (~20 bytes each, so ~1 MB).
/// Most strips land near 20k; a short dense route like ROUTE_5 sits wholly
/// inside the band and measured 85k, which is more than the seam needs.
/// Chunks are read nearest-the-seam first, so the cap sheds the far ones.
const STRIP_MAX_VERTS: usize = 48_000;
/// Linear memory that must remain free after the map is built before any
/// neighbour strip is loaded. Vertex buffers come out of linear, and a full
/// map can already claim 18 MB of it; running it dry mid-load is how a map
/// transition dies.
const STRIP_MIN_FREE_KB: u32 = 6 * 1024;

/// One connected map's seam strip: geometry only, drawn with the CURRENT
/// map's terrain texture.
struct NeighborStrip {
    map_id: u32,
    verts: Vec<Vertex>,
    spans: Vec<Span>,
}

/// The neighbour's real map box in its OWN coords, read cheaply: header,
/// section table and chunk records only, no geometry (~10 KB).
///
/// Needed because a connection offset carries TWO things at once — which
/// side the neighbour is on, and how it slides along that side — and the
/// sign alone cannot tell them apart. ROUTE_2's neighbours both arrive at
/// ox=-160 while connecting north and south; -160 is the lateral slide,
/// not a west connection. Knowing the neighbour's size settles it.
fn neighbor_bounds(path: &str, map_id: u32) -> Option<([f32; 2], [f32; 2])> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).ok()?;
    let mut hdr = [0u8; 16];
    f.read_exact(&mut hdr).ok()?;
    let sec_count = u16::from_le_bytes([hdr[6], hdr[7]]) as usize;
    let mut table = vec![0u8; sec_count * 16];
    f.read_exact(&mut table).ok()?;
    let rd32 =
        |b: &[u8], o: usize| u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]) as usize;
    let mut chnk_off = 0usize;
    for i in 0..sec_count {
        let e = i * 16;
        if &table[e..e + 4] == b"CHNK" {
            chnk_off = rd32(&table, e + 4);
        }
    }
    if chnk_off == 0 {
        return None;
    }
    let mut ch = [0u8; 32];
    f.seek(SeekFrom::Start(chnk_off as u64)).ok()?;
    f.read_exact(&mut ch).ok()?;
    let map_count = u16::from_le_bytes([ch[0], ch[1]]) as usize;
    let mut dir = vec![0u8; map_count * 12];
    f.read_exact(&mut dir).ok()?;
    let (mut first, mut count) = (0usize, 0usize);
    for i in 0..map_count {
        let e = i * 12;
        if rd32(&dir, e) as u32 == map_id {
            first = rd32(&dir, e + 4);
            count = rd32(&dir, e + 8);
        }
    }
    if count == 0 {
        return None;
    }
    const REC: usize = 128;
    let mut recs = vec![0u8; count * REC];
    f.seek(SeekFrom::Start((chnk_off + 32 + map_count * 12 + first * REC) as u64)).ok()?;
    f.read_exact(&mut recs).ok()?;
    let (mut mn, mut mx) = ([f32::MAX; 2], [f32::MIN; 2]);
    for ci in 0..count {
        let r = &recs[ci * REC..(ci + 1) * REC];
        let g = |o: usize| i16::from_le_bytes([r[o], r[o + 1]]) as f32;
        mn[0] = mn[0].min(g(4));
        mn[1] = mn[1].min(g(8));
        mx[0] = mx[0].max(g(10));
        mx[1] = mx[1].max(g(14));
    }
    let ring = [(-mn[0]).max(0.0), (-mn[1]).max(0.0)];
    Some((
        [mn[0] + ring[0], mn[1] + ring[1]],
        [mx[0] - ring[0], mx[1] - ring[1]],
    ))
}

/// A resident copy of `name`, if the cache holds one. Chunk records are in
/// every copy, planned or whole, so this serves `bounds_from_pak`.
#[allow(static_mut_refs)]
unsafe fn resident_pak(name: &str) -> Option<&'static Pak<'static>> {
    PAK_CACHE
        .iter()
        .find(|c| c.name == name)
        .map(|c| core::mem::transmute::<&Pak<'static>, &'static Pak<'static>>(&c.pak))
}

/// Every neighbour box read so far, by map id. A map's box never changes,
/// so after the first time a crossing pays nothing for it.
static mut BOUNDS_SEEN: Vec<(u32, [f32; 2], [f32; 2])> = Vec::new();

/// `neighbor_bounds`, from a pak already in memory: no file opened.
fn bounds_from_pak(pak: &Pak, map_id: u32) -> Option<([f32; 2], [f32; 2])> {
    let map = pak.maps.iter().find(|m| m.map_id == map_id)?;
    if map.count == 0 {
        return None;
    }
    let (mut mn, mut mx) = ([f32::MAX; 2], [f32::MIN; 2]);
    for c in &pak.chunks[map.first as usize..(map.first + map.count) as usize] {
        mn[0] = mn[0].min(c.aabb_min[0] as f32);
        mn[1] = mn[1].min(c.aabb_min[2] as f32);
        mx[0] = mx[0].max(c.aabb_max[0] as f32);
        mx[1] = mx[1].max(c.aabb_max[2] as f32);
    }
    let ring = [(-mn[0]).max(0.0), (-mn[1]).max(0.0)];
    Some((
        [mn[0] + ring[0], mn[1] + ring[1]],
        [mx[0] - ring[0], mx[1] - ring[1]],
    ))
}

/// Whether a mesh's data is really in this copy of the pak. A planned read
/// leaves what it skipped zero-filled (map_pak resizes with 0), and no real
/// triangle is (0, 0, 0).
fn mesh_loaded(pak: &Pak, m: pak::MeshRange) -> bool {
    if m.index_count < 3 {
        return false;
    }
    let b = m.index_base as usize;
    let Some(t) = pak.indices.get(b..b + 3) else { return false };
    !(t[0] == t[1] && t[1] == t[2])
}

/// `load_neighbor_strip`, from a pak already in memory (a read-ahead copy):
/// the same chunks, the same order, the same cap, the same clip -- and no
/// SD traffic, where the file path costs a seek and two reads per chunk and
/// mesh kind, in the frame the player is crossing the seam.
fn strip_from_pak(
    pak: &Pak,
    map_id: u32,
    ox: f32,
    oy: f32,
    cur_min: [f32; 2],
    cur_max: [f32; 2],
    tint: u32,
) -> Option<NeighborStrip> {
    let map = pak.maps.iter().find(|m| m.map_id == map_id)?;
    if map.count == 0 {
        return None;
    }
    let chunks = &pak.chunks[map.first as usize..(map.first + map.count) as usize];
    let (nb_real_min, nb_real_max) = bounds_from_pak(pak, map_id)?;

    let mut cand: Vec<(usize, f32)> = Vec::new();
    for (ci, c) in chunks.iter().enumerate() {
        let (x0, z0) = (c.aabb_min[0] as f32 + ox, c.aabb_min[2] as f32 + oy);
        let (x1, z1) = (c.aabb_max[0] as f32 + ox, c.aabb_max[2] as f32 + oy);
        let dx = (cur_min[0] - x1).max(x0 - cur_max[0]).max(0.0);
        let dz = (cur_min[1] - z1).max(z0 - cur_max[1]).max(0.0);
        if dx > STRIP_DEPTH_PX || dz > STRIP_DEPTH_PX {
            continue;
        }
        cand.push((ci, dx.max(dz)));
    }
    cand.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(core::cmp::Ordering::Equal));

    let mut verts: Vec<Vertex> = Vec::new();
    let mut spans: Vec<Span> = Vec::new();
    for (ci, _) in cand {
        if verts.len() >= STRIP_MAX_VERTS {
            break;
        }
        let c = &chunks[ci];
        let (x0, z0) = (c.aabb_min[0] as f32 + ox, c.aabb_min[2] as f32 + oy);
        let (x1, z1) = (c.aabb_max[0] as f32 + ox, c.aabb_max[2] as f32 + oy);
        let (y0, y1) = (c.aabb_min[1] as f32, c.aabb_max[1] as f32);
        // The BOX tier only, exactly what the file path reads.
        //
        // Substituting a finer tier when a planned copy had not read the box
        // was a mistake: a hull is several times the vertices, so the strip
        // hit STRIP_MAX_VERTS partway along and the chunks past it were
        // dropped -- seams with holes in them. A copy without the box is
        // simply not usable here, and the file path takes over.
        if c.meshes[TREE_BOX_KIND].index_count > 0 && !mesh_loaded(pak, c.meshes[TREE_BOX_KIND]) {
            return None;
        }
        for kind in 0..MESH_KINDS_N {
            if !(GROUND_KINDS.contains(&kind) || kind == TREE_BOX_KIND) {
                continue;
            }
            let m = c.meshes[kind];
            if m.index_count == 0 {
                continue;
            }
            if !mesh_loaded(pak, m) {
                return None; // geometry this copy never read: use the file
            }
            let span_start = verts.len();
            let mut gmin = [f32::MAX; 3];
            let mut gmax = [f32::MIN; 3];
            let vbase = m.vert_base as usize;
            for t in 0..m.index_count as usize / 3 {
                let b = m.index_base as usize + t * 3;
                let (Some(v0), Some(v1), Some(v2)) = (
                    pool_vert(pak, vbase, b),
                    pool_vert(pak, vbase, b + 1),
                    pool_vert(pak, vbase, b + 2),
                ) else {
                    break;
                };
                let p = [v0, v1, v2];
                let mid_x = (p[0].x as f32 + p[1].x as f32 + p[2].x as f32) / 3.0;
                let mid_z = (p[0].z as f32 + p[1].z as f32 + p[2].z as f32) / 3.0;
                if mid_x < nb_real_min[0] || mid_x > nb_real_max[0]
                    || mid_z < nb_real_min[1] || mid_z > nb_real_max[1]
                {
                    continue;
                }
                let tri = [
                    [p[0].x as f32, p[0].y as f32, p[0].z as f32],
                    [p[1].x as f32, p[1].y as f32, p[1].z as f32],
                    [p[2].x as f32, p[2].y as f32, p[2].z as f32],
                ];
                if ring_inner_face(tri, nb_real_min, nb_real_max) {
                    continue;
                }
                for pv in p {
                    let (px, py, pz) = (pv.x as f32 + ox, pv.y as f32, pv.z as f32 + oy);
                    let a = draw::modulate_rgb(pv.abgr, tint);
                    let q = [px, py, pz];
                    for k in 0..3 {
                        if q[k] < gmin[k] { gmin[k] = q[k]; }
                        if q[k] > gmax[k] { gmax[k] = q[k]; }
                    }
                    verts.push(Vertex {
                        pos: [px as i16, py as i16, pz as i16, 0],
                        color: [
                            (a & 0xff) as u8,
                            ((a >> 8) & 0xff) as u8,
                            ((a >> 16) & 0xff) as u8,
                            255,
                        ],
                        uv: [pv.uf(), pv.vf()],
                    });
                }
            }
            if verts.len() > span_start {
                spans.push(Span {
                    bmin: [x0, y0, z0],
                    bmax: [x1, y1, z1],
                    gmin,
                    gmax,
                    occludable: kind == TREE_BOX_KIND,
                    start: span_start,
                    end: verts.len(),
                });
            }
        }
    }
    if spans.is_empty() {
        return None;
    }
    Some(NeighborStrip { map_id, verts, spans })
}

/// Reject hidden fragments before they are textured, rather than after.
///
/// OFF, because the hardware answered and the answer was no (a6ce1c5, tried
/// in build 224111 and reverted in the next). It drew holes in the ground,
/// so the coarse buffer was not clearing per pass the way enabling it each
/// eye was supposed to arrange -- AND it was slower even where it drew:
///
///   224111, early depth ON   16 fps  gpu 65.4 ms  spans 29/87  trees  9/26
///   223346, early depth OFF  16 fps  gpu 62.4 ms  spans 28/87  trees 17/26
///
/// worse, with half the trees on screen. Whatever the PICA spends setting
/// the coarse buffer up costs more here than the fragments it saved.
///
/// The reasoning that led here still holds and is worth keeping, because it
/// is the obvious thing to try again: the frame IS fill-bound. Build 223346
/// showed GPU time tracking how much SCREEN the world covered rather than
/// how much world there was -- 20 chunks cost 48.6 ms against 24 chunks at
/// 44.2, while the town's 26 trees, a few hundred verts that cover a great
/// deal of screen, cost 20 to 45. That is why the geometry diet did nothing
/// and why demoting a tree to its coarse tier does nothing either: a coarse
/// tree covers the same pixels. Anyone picking this up again needs the
/// early buffer's clear to actually happen, and should expect to prove it
/// with the perf line before trusting it.
const EARLY_DEPTH: bool = false;

/// A map whose trees are instanced (TINS) carries no box tier in its
/// chunks, so a seam strip built from it would be bare ground where its
/// trees are. Those keep to the file path until strips place instances too.
fn strip_has_trees(pak: &Pak, map_id: u32) -> bool {
    pak.trees_of(map_id).is_empty()
}

/// Read ONLY the seam-side chunks of a neighbour map's pak.
///
/// Loading a neighbour whole is not an option: paks run 3-59 MB against a
/// 24 MB cache budget, and 34 of the 36 connected outdoor maps would blow
/// it with the current map plus two neighbours — which would thrash the
/// cache at every seam. But the sliver you can actually see is a few
/// hundred KB of geometry, so this seeks to just the chunk records and the
/// vertex/index ranges of the chunks near the shared edge.
///
/// It reads no atlas and no palette, because it does not need them: every
/// connected outdoor map was measured to use terrain page 0 and world
/// palette 41, with at most 2 of 256 palette entries differing, so the
/// strip draws correctly with the texture already bound for the current
/// map. That is what makes this cheap enough to be worth doing.
fn load_neighbor_strip(
    path: &str,
    map_id: u32,
    ox: f32,
    oy: f32,
    cur_min: [f32; 2],
    cur_max: [f32; 2],
    tint: u32,
) -> Option<NeighborStrip> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).ok()?;

    let mut hdr = [0u8; 16];
    f.read_exact(&mut hdr).ok()?;
    let sec_count = u16::from_le_bytes([hdr[6], hdr[7]]) as usize;
    let mut table = vec![0u8; sec_count * 16];
    f.read_exact(&mut table).ok()?;
    let rd32 = |b: &[u8], o: usize| {
        u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]) as usize
    };
    let mut chnk_off = 0usize;
    for i in 0..sec_count {
        let e = i * 16;
        if &table[e..e + 4] == b"CHNK" {
            chnk_off = rd32(&table, e + 4);
        }
    }
    if chnk_off == 0 {
        return None;
    }

    // CHNK header: map_count, then chunk_total + the pool offsets.
    let mut ch = [0u8; 32];
    f.seek(SeekFrom::Start(chnk_off as u64)).ok()?;
    f.read_exact(&mut ch).ok()?;
    let map_count = u16::from_le_bytes([ch[0], ch[1]]) as usize;
    let chunk_total = rd32(&ch, 4);
    let verts_off = chnk_off + rd32(&ch, 8);
    let indices_off = chnk_off + rd32(&ch, 16);

    // Map directory, then this map's chunk records.
    let mut dir = vec![0u8; map_count * 12];
    f.read_exact(&mut dir).ok()?;
    let (mut first, mut count) = (0usize, 0usize);
    for i in 0..map_count {
        let e = i * 12;
        if rd32(&dir, e) as u32 == map_id {
            first = rd32(&dir, e + 4);
            count = rd32(&dir, e + 8);
        }
    }
    if count == 0 {
        return None;
    }
    const REC: usize = 128;
    let rec0 = chnk_off + 32 + map_count * 12;
    let mut recs = vec![0u8; count * REC];
    f.seek(SeekFrom::Start((rec0 + first * REC) as u64)).ok()?;
    f.read_exact(&mut recs).ok()?;
    let _ = chunk_total;

    let mut verts: Vec<Vertex> = Vec::new();
    let mut spans: Vec<Span> = Vec::new();
    // Pick the seam-side chunks first and order them by how far OUTSIDE the
    // current map they sit, so if the vertex cap bites it sheds the chunks
    // furthest from the seam — the ones least likely to be on screen.
    // The neighbour has a border ring of its own, and it points back over
    // the map the player is standing on — that ring is the wall of bushes
    // sitting across the pathway between two connected maps. Derive its
    // real box the same way build_map does (bounds are symmetric about the
    // ring) and clip the strip to it, in the neighbour's LOCAL coords,
    // before the connection offset is applied.
    let mut nb_min = [f32::MAX; 2];
    let mut nb_max = [f32::MIN; 2];
    for ci in 0..count {
        let r = &recs[ci * REC..(ci + 1) * REC];
        let g = |o: usize| i16::from_le_bytes([r[o], r[o + 1]]) as f32;
        nb_min[0] = nb_min[0].min(g(4));
        nb_min[1] = nb_min[1].min(g(8));
        nb_max[0] = nb_max[0].max(g(10));
        nb_max[1] = nb_max[1].max(g(14));
    }
    let nb_ring = [(-nb_min[0]).max(0.0), (-nb_min[1]).max(0.0)];
    let nb_real_min = [nb_min[0] + nb_ring[0], nb_min[1] + nb_ring[1]];
    let nb_real_max = [nb_max[0] - nb_ring[0], nb_max[1] - nb_ring[1]];

    let mut cand: Vec<(usize, f32)> = Vec::new();
    for ci in 0..count {
        let r = &recs[ci * REC..(ci + 1) * REC];
        let i16at = |o: usize| i16::from_le_bytes([r[o], r[o + 1]]) as f32;
        let (x0, z0) = (i16at(4) + ox, i16at(8) + oy);
        let (x1, z1) = (i16at(10) + ox, i16at(14) + oy);
        let dx = (cur_min[0] - x1).max(x0 - cur_max[0]).max(0.0);
        let dz = (cur_min[1] - z1).max(z0 - cur_max[1]).max(0.0);
        if dx > STRIP_DEPTH_PX || dz > STRIP_DEPTH_PX {
            continue;
        }
        cand.push((ci, dx.max(dz)));
    }
    cand.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(core::cmp::Ordering::Equal));

    for (ci, _) in cand {
        if verts.len() >= STRIP_MAX_VERTS {
            break;
        }
        let r = &recs[ci * REC..(ci + 1) * REC];
        let i16at = |o: usize| i16::from_le_bytes([r[o], r[o + 1]]) as f32;
        // AABB in the neighbour's own space, shifted by the connection
        // offset the guest already computed (scene.maps[slot].ox/oy).
        let (x0, z0) = (i16at(4) + ox, i16at(8) + oy);
        let (x1, z1) = (i16at(10) + ox, i16at(14) + oy);
        let (y0, y1) = (i16at(6), i16at(12));
        for kind in 0..MESH_KINDS_N {
            let m = 20 + kind * 12;
            let vert_base = rd32(r, m);
            let index_count = u16::from_le_bytes([r[m + 6], r[m + 7]]) as usize;
            let index_base = rd32(r, m + 8);
            if index_count == 0 {
                continue;
            }
            // A seam strip only has to stop the wall of border bushes, and
            // it is always at the far end of the view: ground, water and
            // BOXED trees give the silhouette. The fine/coarse tree hulls
            // are the bulk of any map's geometry and would dominate the
            // read for detail nobody can resolve at that distance; grass
            // and flowers are ankle-height and invisible out there. Kind 1
            // (groundBake) is skipped because build_map does not use it
            // either, and drawing both would double up the ground.
            let want = GROUND_KINDS.contains(&kind) || kind == TREE_BOX_KIND;
            if !want {
                continue;
            }
            let mut idx = vec![0u8; index_count * 2];
            f.seek(SeekFrom::Start((indices_off + index_base * 2) as u64)).ok()?;
            f.read_exact(&mut idx).ok()?;
            let span_start = verts.len();
            let mut gmin = [f32::MAX; 3];
            let mut gmax = [f32::MIN; 3];
            // One contiguous read of the chunk's vertex pool beats a seek
            // per index by a wide margin on SD.
            let vmax = (0..index_count)
                .map(|k| u16::from_le_bytes([idx[k * 2], idx[k * 2 + 1]]) as usize)
                .max()
                .unwrap_or(0);
            let mut vbuf = vec![0u8; (vmax + 1) * 16];
            f.seek(SeekFrom::Start((verts_off + vert_base * 16) as u64)).ok()?;
            if f.read_exact(&mut vbuf).is_err() {
                continue;
            }
            let at = |vi: usize| -> (f32, f32, f32, f32, f32, u32) {
                let b = &vbuf[vi * 16..vi * 16 + 16];
                (
                    u16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0,
                    u16::from_le_bytes([b[2], b[3]]) as f32 / 32768.0,
                    i16::from_le_bytes([b[8], b[9]]) as f32,
                    i16::from_le_bytes([b[10], b[11]]) as f32,
                    i16::from_le_bytes([b[12], b[13]]) as f32,
                    u32::from_le_bytes([b[4], b[5], b[6], b[7]]),
                )
            };
            for t in 0..index_count / 3 {
                let i0 = u16::from_le_bytes([idx[t * 6], idx[t * 6 + 1]]) as usize;
                let i1 = u16::from_le_bytes([idx[t * 6 + 2], idx[t * 6 + 3]]) as usize;
                let i2 = u16::from_le_bytes([idx[t * 6 + 4], idx[t * 6 + 5]]) as usize;
                let (t0, t1, t2) = (at(i0), at(i1), at(i2));
                // Drop the neighbour's own border ring — in LOCAL coords,
                // before the offset — so it cannot spill back across the
                // seam onto the map the player is walking on.
                let mid_x = (t0.2 + t1.2 + t2.2) / 3.0;
                let mid_z = (t0.4 + t1.4 + t2.4) / 3.0;
                if mid_x < nb_real_min[0] || mid_x > nb_real_max[0]
                    || mid_z < nb_real_min[1] || mid_z > nb_real_max[1]
                {
                    continue;
                }
                let tri = [[t0.2, t0.3, t0.4], [t1.2, t1.3, t1.4], [t2.2, t2.3, t2.4]];
                if ring_inner_face(tri, nb_real_min, nb_real_max) {
                    continue;
                }
                for vt in [t0, t1, t2] {
                    let (u, v, lx, ly, lz, abgr) = vt;
                    let (px, py, pz) = (lx + ox, ly, lz + oy);
                    let a = draw::modulate_rgb(abgr, tint);
                    let p = [px, py, pz];
                    for c in 0..3 {
                        if p[c] < gmin[c] { gmin[c] = p[c]; }
                        if p[c] > gmax[c] { gmax[c] = p[c]; }
                    }
                    verts.push(Vertex {
                        pos: [px as i16, py as i16, pz as i16, 0],
                        color: [
                            (a & 0xff) as u8,
                            ((a >> 8) & 0xff) as u8,
                            ((a >> 16) & 0xff) as u8,
                            255,
                        ],
                        uv: [u, v],
                    });
                }
            }
            if verts.len() > span_start {
                spans.push(Span {
                    bmin: [x0, y0, z0],
                    bmax: [x1, y1, z1],
                    gmin,
                    gmax,
                    occludable: kind == TREE_BOX_KIND,
                    start: span_start,
                    end: verts.len(),
                });
            }
        }
    }
    if spans.is_empty() {
        return None;
    }
    Some(NeighborStrip { map_id, verts, spans })
}

fn build_map(
    pak: &Pak,
    map_id: u32,
    player_px: Option<(f32, f32)>,
    stamps_off: &[(u32, i16, i16)],
    // scene.tint (voxel `tint` op, host.tint), baked into vertex colour at
    // build time rather than applied per-frame: this flat-buffer terrain
    // path has no per-frame shader uniform for it (unlike draw::build()'s
    // sky-band modulate, which PSP/Vita's renderer already applies). HM
    // Flash (voxelmon/game/world/overworld.ts setMap) is the first caller —
    // a dark-cave map's baked colours come out dim until Flash brightens
    // scene.tint back to white and a reload rebakes them.
    tint: u32,
    // Which sides have a connected map drawn behind them: west, east,
    // north, south. The border ring is dropped on those sides only — the
    // neighbour's own ground replaces it — and kept everywhere else, where
    // removing it would leave the map ending in open sky.
    seam_sides: [bool; 4],
) -> MapGeom {
    let pidx = pak.map_terrain_page(map_id)
        .or_else(|| pak.page_of_kind(atlas_kind::TERRAIN))
        .expect("terrain page");
    let page = pak.atlases[pidx as usize];
    let lin = pak::unswizzle(page.w as usize, page.h as usize, page.frame(0)).expect("unswizzle");
    let wp = pak.map_world_pal(map_id).unwrap_or(COLOR_PAL_NONE);
    let palv = &pak.palettes[resolve_pal(pak, pidx, page.kind, wp, -1)];
    let (aw, ah) = (page.w as u32, page.h as u32);
    let (tw, th) = (po2(aw), po2(ah));
    let mut tex_rgba = vec![0u8; (tw * th * 4) as usize];
    for y in 0..ah {
        for x in 0..aw {
            let c = palv[lin[(y * aw + x) as usize] as usize];
            let o = tiled_off(x, y, tw);
            tex_rgba[o]     = ((c >> 24) & 0xff) as u8;
            tex_rgba[o + 1] = ((c >> 16) & 0xff) as u8;
            tex_rgba[o + 2] = ((c >> 8) & 0xff) as u8;
            tex_rgba[o + 3] = (c & 0xff) as u8;
        }
    }

    let mut verts: Vec<Vertex> = Vec::new();
    let mut chunk_spans: Vec<Span> = Vec::new();
    let mut cmin = [f32::MAX; 3];
    let mut cmax = [f32::MIN; 3];
    let map = pak.maps.iter().find(|m| m.map_id == map_id).expect("map");
    let all_chunks = &pak.chunks[map.first as usize..(map.first + map.count) as usize];

    // Which chunks, in which order, at which tree tier — decided once by
    // plan_build/build_order from the chunk records, so the LOADER could
    // read exactly these and nothing else (see map_pak). Re-deriving the
    // cascade here instead of following the plan would be a bug: the clip
    // test below drops border-ring triangles, so the real vertex count runs
    // lower than the plan's and the cascade could pick a fine hull the
    // loader never read, drawing zeros.
    //
    // Past HUGE_MAP_THRESHOLD (Viridian Forest-scale, ~3.65M indices against
    // a 400,000 budget) the order is nearest-the-player-first, so the limited
    // budget is spent on what is actually close rather than whatever came
    // first in file order, and it re-sorts as they walk (the chunk-crossing
    // check lives in main()'s loop, driving `reload`). A radius filter was
    // tried here once and made things worse: the forest is only ~6x8 chunks,
    // smaller than any reasonable draw distance, so windowing included every
    // chunk anyway while switching the budget up to the generous cap.
    let (order, is_huge, budget) = build_order(all_chunks, player_px);
    // Ask for the whole budget UP FRONT, and fallibly.
    //
    // A Vec growing by doubling asks the allocator for the new block while
    // still holding the old one, and a refusal is not an error it can
    // return -- Rust calls handle_alloc_error, which aborts, which on this
    // console is the homebrew menu with nothing said. Reserving once says
    // whether the memory is there before a single vertex is written, and a
    // no is answered by building a smaller map rather than by dying.
    let mut budget = budget;
    while budget > 0 && verts.try_reserve_exact(budget).is_err() {
        dlog(&format!(
            "[pv] no room for {} verts ({} KB); halving the budget",
            budget,
            budget * core::mem::size_of::<Vertex>() / 1024,
        ));
        budget /= 2;
    }
    // Stamps are pushed between the ground and tree passes at ground
    // priority, so the cascade has to see their share already spent.
    let stamp_verts: usize = pak
        .stamps_of(map_id)
        .iter()
        .filter(|st| !stamps_off.iter().any(|&(m, x, y)| m == map_id && x == st.cx && y == st.cy))
        .map(|st| st.mesh.index_count as usize)
        .sum();
    let plan = plan_build(all_chunks, &order, is_huge, budget, stamp_verts);
    let chunks: Vec<pak::Chunk> = all_chunks.to_vec();
    // Size the buffer once from the plan, instead of letting it double its
    // way up: each doubling copies everything pushed so far, which on a
    // 300k-vertex route is several full copies in the frame being waited on.
    // The clip only ever removes, so this is an upper bound.
    //
    // NOT for a huge map -- Viridian Forest. It re-builds every time the
    // player crosses a chunk, and a reservation there asks for one 8 MB block
    // per rebuild while the outgoing build still holds its own; on a heap its
    // 57 MB pak has nearly filled, that eventually cannot be met and the
    // allocator aborts. Growing by doubling reuses what it already has. The
    // forest gets the path it has always had.
    if !is_huge {
        let want: usize = plan
            .items
            .iter()
            .map(|it| all_chunks[it.chunk].meshes[it.kind].index_count as usize)
            .sum::<usize>()
            + stamp_verts;
        let _ = verts.try_reserve_exact(want.min(budget));
    }

    // The border ring the cook fills beyond the map proper — bushes
    // outdoors, filler indoors. It sits OUTSIDE the real map box, and the
    // chunk extent is symmetric (-border .. size+border), so the ring's
    // thickness reads straight off the bounds without needing the map's
    // width/height: 32 px on outdoor maps, 96 px indoors (measured across
    // all 219 paks). Clipping to the real box on a seam side deletes the
    // ring exactly where a neighbour strip now supplies real ground.
    let mut ring = [0.0f32; 2];
    let mut real_min = [0.0f32; 2];
    let mut real_max = [0.0f32; 2];
    {
        let mut mn = [f32::MAX; 2];
        let mut mx = [f32::MIN; 2];
        for c in all_chunks {
            mn[0] = mn[0].min(c.aabb_min[0] as f32);
            mn[1] = mn[1].min(c.aabb_min[2] as f32);
            mx[0] = mx[0].max(c.aabb_max[0] as f32);
            mx[1] = mx[1].max(c.aabb_max[2] as f32);
        }
        for i in 0..2 {
            ring[i] = (-mn[i]).max(0.0);
            real_min[i] = mn[i] + ring[i];
            real_max[i] = mx[i] - ring[i];
        }
    }
    const NO_CLIP: f32 = 1.0e9;
    let clip_min = [
        if seam_sides[0] { real_min[0] } else { -NO_CLIP },
        if seam_sides[2] { real_min[1] } else { -NO_CLIP },
    ];
    let clip_max = [
        if seam_sides[1] { real_max[0] } else { NO_CLIP },
        if seam_sides[3] { real_max[1] } else { NO_CLIP },
    ];

    // Ground first — always in full.
    for it in plan.items.iter().filter(|i| GROUND_KINDS.contains(&i.kind)) {
        push_chunk_mesh(pak, &chunks[it.chunk], it.kind, budget, tint, clip_min, clip_max, &mut verts, &mut chunk_spans, &mut cmin, &mut cmax);
    }
    // Removable stamps (cut trees, the S.S. Anne hull) next, at ground
    // priority: these are cooked into the pak's separate STMP section, not
    // any of the CHNK mesh_kinds the loops above/below already cover, so on
    // their own they'd never be pulled into this flat buffer at all — on
    // the other renderers (PSP/Vita) they ride pocketvoxel-core's shared
    // draw::build() item list, which this bespoke terrain path doesn't
    // consume. They're landmark geometry, not filler, so they get ground's
    // priority rather than competing with trees/grass for budget. Gated by
    // `stamps_off` (a snapshot of Scene.stamps_off taken by the caller) so a
    // cut tree or a sailed-off ship actually disappears once toggled.
    for stamp in pak.stamps_of(map_id) {
        if stamps_off.iter().any(|&(m, x, y)| m == map_id && x == stamp.cx && y == stamp.cy) {
            continue;
        }
        push_stamp_mesh(pak, stamp, budget, tint, &mut verts, &mut chunk_spans, &mut cmin, &mut cmax);
    }
    // Round tree/rock cells next, BEFORE water/grass/flower: per chunk, use
    // the fine hull while it still fits the remaining budget, else the
    // cheaper coarse carve if THAT fits, else the plain box — a per-chunk
    // cascade, not a whole-map switch. (Previously this picked ONE mesh set
    // for the entire map from a prescanned total, which either truncated a
    // busy map's tail silently (gate too high) or, once that was fixed,
    // downgraded every tree in the map to boxes even where there was room
    // for hulls (gate too coarse) — Cerulean City hit both in turn. A first
    // attempt at this per-chunk fix also moved water/grass/flower ahead of
    // trees, which let them spend the whole budget before trees got a turn
    // at all, and skipped the coarse tier entirely, boxing every chunk that
    // couldn't fit a full hull — Cerulean's ground alone is 340,764 of the
    // 400,000 budget, so most of its trees fell straight to boxes even
    // though coarse, at ~1/4 the hull's cost, would have fit plenty of
    // them.) A cook with no separate tree streams at all (old/VOXEL_TREE_
    // BOXES=1 pak, hulls folded into terrain) leaves every tier empty here
    // and just keeps what TERRAIN already carried above.
    for it in plan.items.iter().filter(|i| TREE_KINDS.contains(&i.kind)) {
        push_chunk_mesh(pak, &chunks[it.chunk], it.kind, budget, tint, clip_min, clip_max, &mut verts, &mut chunk_spans, &mut cmin, &mut cmax);
    }
    // Water, grass, flower last — whatever budget survives the above.
    for it in plan.items.iter().filter(|i| FILLER_KINDS.contains(&i.kind)) {
        push_chunk_mesh(pak, &chunks[it.chunk], it.kind, budget, tint, clip_min, clip_max, &mut verts, &mut chunk_spans, &mut cmin, &mut cmax);
    }
    if verts.is_empty() { cmin = [0.0; 3]; cmax = [16.0; 3]; }
    let center = [
        (cmin[0] + cmax[0]) * 0.5,
        (cmin[1] + cmax[1]) * 0.5,
        (cmin[2] + cmax[2]) * 0.5,
    ];
    let size = (cmax[0]-cmin[0]).max(cmax[1]-cmin[1]).max(cmax[2]-cmin[2]).max(16.0);
    // Full map bounds over EVERY chunk, budget or not — a neighbour strip
    // attaches to the map's real edge, not to however much of it got built.
    let mut map_min = [f32::MAX; 2];
    let mut map_max = [f32::MIN; 2];
    for c in all_chunks {
        map_min[0] = map_min[0].min(c.aabb_min[0] as f32);
        map_min[1] = map_min[1].min(c.aabb_min[2] as f32);
        map_max[0] = map_max[0].max(c.aabb_max[0] as f32);
        map_max[1] = map_max[1].max(c.aabb_max[2] as f32);
    }
    if all_chunks.is_empty() {
        map_min = [0.0; 2];
        map_max = [0.0; 2];
    }
    let floor = floor_map_of(pak, all_chunks, map_min, map_max);
    MapGeom { floor, chunk_spans, verts, center, size, tex_rgba, tw, th, aw, ah, is_huge, map_min, map_max }
}

/// The floor under each cell of the map: the highest up-facing TERRAIN
/// triangle in it. Whoever stands on the cell is drawn that high (core
/// draw.rs ent_feet / cell_centre).
///
/// In practice this finds NOTHING and every cell reads 0, which is why the
/// player walks along the foot of MT. MOON's shelves instead of on top of
/// them. That is deliberate for now, and the story is worth keeping because
/// the obvious repair makes things worse:
///
/// "Up-facing" is the sign of the cross product, i.e. the winding, and
/// cook/geom.ts states the cooked streams do not share one -- every quad
/// names the direction its front points in precisely because that cannot be
/// derived from its corners. MT_MOON_1F has 19,968 horizontal terrain
/// triangles and not one is wound the way this asks for, so the map comes
/// out empty. ROCK_TUNNEL_1F and SEAFOAM_ISLANDS_B3F are the same.
///
/// Dropping the sign (84c735c) did lift the shelves, and also lifted the
/// player onto wall tops at ladders and cave mouths, because the highest
/// horizontal surface in a cell beside a wall IS the wall. Reading
/// TERRAIN_KEEP too (ad65563) cut that a long way -- scored against
/// GROUND_BAKE, which is the baked ground surface and so the answer key,
/// MT_MOON_1F went from 1982 cells agreeing to 3104 of 3136 -- but a
/// building roof still claimed the cell under it in CELADON, and an NPC
/// floating over a town reads worse than a flat cave. Both are reverted.
///
/// The repair that would actually work is to read GROUND_BAKE and use it
/// directly: it agrees with itself by construction, gives caves a clean two
/// levels, and leaves VIRIDIAN_FOREST flat. mapplan does not fetch it today
/// because it is not in the draw plan, so that is a loader change (about
/// 300 KB a map, ~27 ms at the card's measured 11 MB/s) rather than a rule
/// change. examples/floor_check.rs is the harness that measured all of it.
fn floor_map_of(pak: &Pak, chunks: &[pak::Chunk], map_min: [f32; 2], map_max: [f32; 2]) -> pocketvoxel_core::scene::FloorMap {
    use pocketvoxel_core::scene::FloorMap;
    let cell = pocketvoxel_core::spec::CELL_PX as f32;
    let x0 = (map_min[0] / cell).floor() as i32;
    let z0 = (map_min[1] / cell).floor() as i32;
    let x1 = (map_max[0] / cell).ceil() as i32;
    let z1 = (map_max[1] / cell).ceil() as i32;
    let (w, h) = ((x1 - x0).max(0) as usize, (z1 - z0).max(0) as usize);
    if w == 0 || h == 0 || w * h > 65536 {
        return FloorMap::default();
    }
    let mut cells = vec![0i16; w * h];
    for chunk in chunks {
        let m = chunk.meshes[pocketvoxel_core::spec::mesh_kind::TERRAIN as usize];
        let vbase = m.vert_base as usize;
        for t in 0..(m.index_count as usize / 3) {
            let b = m.index_base as usize + t * 3;
            let (Some(p0), Some(p1), Some(p2)) = (
                pool_vert(pak, vbase, b),
                pool_vert(pak, vbase, b + 1),
                pool_vert(pak, vbase, b + 2),
            ) else {
                break;
            };
            // up-facing: the normal's y dominates and points up
            let (ax, ay, az) = ((p1.x - p0.x) as f32, (p1.y - p0.y) as f32, (p1.z - p0.z) as f32);
            let (bx, by, bz) = ((p2.x - p0.x) as f32, (p2.y - p0.y) as f32, (p2.z - p0.z) as f32);
            let ny = az * bx - ax * bz;
            let nx = ay * bz - az * by;
            let nz = ax * by - ay * bx;
            if ny <= 0.0 || ny.abs() < nx.abs() || ny.abs() < nz.abs() {
                continue;
            }
            let top = p0.y.max(p1.y).max(p2.y);
            let (lo_x, hi_x) = (p0.x.min(p1.x).min(p2.x), p0.x.max(p1.x).max(p2.x));
            let (lo_z, hi_z) = (p0.z.min(p1.z).min(p2.z), p0.z.max(p1.z).max(p2.z));
            // the cells whose CENTRES the box covers
            let cx0 = ((lo_x as f32 - cell / 2.0) / cell).ceil() as i32;
            let cx1 = ((hi_x as f32 - cell / 2.0) / cell).floor() as i32;
            let cz0 = ((lo_z as f32 - cell / 2.0) / cell).ceil() as i32;
            let cz1 = ((hi_z as f32 - cell / 2.0) / cell).floor() as i32;
            for cz in cz0.max(z0)..=cz1.min(z1 - 1) {
                for cx in cx0.max(x0)..=cx1.min(x1 - 1) {
                    let i = (cz - z0) as usize * w + (cx - x0) as usize;
                    if top > cells[i] { cells[i] = top; }
                }
            }
        }
    }
    FloorMap { x0, z0, w: w as u16, h: h as u16, cells }
}

static mut RT: *mut JSRuntime = core::ptr::null_mut();
static mut CTX: *mut JSContext = core::ptr::null_mut();

fn main() {
    // Before anything that can fail: a crash has to leave a line.
    install_panic_log();
    let gfx = Gfx::new().expect("gfx");
    let mut hid = Hid::new().expect("hid");
    let apt = Apt::new().expect("apt");
    // Kanto Gear: keep the boot text console until we reclaim the bottom
    // screen for the companion display (just before the render loop below).
    let console = Console::new(gfx.bottom_screen.borrow_mut());
    // Claim the JS heap FIRST: newlib never returns freed memory to the OS,
    // so a 32 MB pak read-and-free fragments the arena beyond QuickJS's reach.
    unsafe {
        RT = JS_NewRuntime();
        CTX = if RT.is_null() { core::ptr::null_mut() } else { JS_NewContext(RT) };
        println!("qjs ready: {}", !CTX.is_null());
    }
    unsafe { osSetSpeedupEnable(true); }   // New 3DS: 804MHz + L2 cache
    let _romfs = RomFS::new().ok();

    println!("linear free {} KB", unsafe_free_kb());


    unsafe { log_open() };
    dlog("[pv] ---------------- boot ----------------");
    dlog(&format!("[pv] log -> {}", LOG_PATHS.join(", ")));
    // Stamp the build so a log can never be mistaken for one from a
    // different binary — the Desktop copy lives in OneDrive, and a sync
    // lag once made a stale .3dsx look like a code path that "did nothing".
    dlog(&format!(
        "[pv] boot build={} game={}",
        option_env!("PV_BUILD_ID").unwrap_or("dev"),
        GAME,
    ));

    // Hold the pak resident, as the live scene renderer will need.
    println!("loading pak...");
    // Per-map paks: memory scales with the biggest map, not the map count.
    let gd = std::fs::read(GAMEDATA_PATH).unwrap_or_default();
    if gd.is_empty() {
        dlog(&format!("[pv] no dataset at {} -- cook this game's ROM", GAMEDATA_PATH));
        let label = if GAME == "blue" { "Blue" } else { "Red" };
        println!();
        println!("Pokemon {} has not been cooked", label);
        println!("onto this SD card yet.");
        println!();
        println!("On your PC, drag your own US");
        println!("Pokemon {} ROM onto the cooker,", label);
        println!("then copy its voxelmon folder");
        println!("into the card's 3ds folder.");
        println!();
    }
    println!("gamedata {} KB", gd.len() / 1024);
    let gd_static: &'static [u8] = Box::leak(gd.into_boxed_slice());

    size_pak_cache();

    // The shared atlas pages, before any pak is read — every pak's page
    // directory resolves against this. Absent is fine and means the card
    // holds original paks that embed every page.
    match std::fs::read(format!("{}/common.vxat", PAKS_DIR)) {
        Ok(v) if !v.is_empty() => {
            println!("shared atlas {} KB", v.len() / 1024);
            unsafe { SHARED_ATLAS = Some(Box::leak(v.into_boxed_slice())); }
        }
        _ => println!("shared atlas: absent (paks carry their own pages)"),
    }
    // This game's own pages over the shared set, before any pak is read.
    match std::fs::read(OVERLAY_PATH) {
        Ok(v) if !v.is_empty() => {
            let d: &'static [u8] = Box::leak(v.into_boxed_slice());
            parse_overlay(d);
            dlog(&format!(
                "[pv] overlay {} page(s), {} palette(s), {} KB sound from {}",
                unsafe { OVERLAY.len() },
                unsafe { OVERLAY_PALETTES.len() },
                unsafe { OVERLAY_AUDIO.map(|a| a.len() / 1024).unwrap_or(0) },
                OVERLAY_PATH,
            ));
        }
        _ => dlog(&format!("[pv] overlay: none at {}", OVERLAY_PATH)),
    }

    let index_txt = std::fs::read_to_string(format!("{}/index.txt", PAKS_DIR))
        .unwrap_or_default();
    let map_index: Vec<(u32, String)> = index_txt
        .lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            Some((it.next()?.parse().ok()?, it.next()?.to_string()))
        })
        .collect();
    println!("maps on card: {}", map_index.len());

    // Boot: read whole. The player position is not known yet, and a copy
    // read whole serves any plan a later build asks for.
    if !unsafe { load_map_pak("REDS_HOUSE_2F", None) } {
        unsafe { load_map_pak("PALLET_TOWN", None); }
    }
    let mut pak_static: &'static pak::Pak<'static> = unsafe { cur_pak() };
    // This game's own sound programs when its overlay carries them (Red's
    // and Blue's differ in a few bytes); else the boot pak's.
    let audi: &'static [u8] = match unsafe { OVERLAY_AUDIO } {
        Some(a) => a,
        None => Box::leak(pak_static.audio.to_vec().into_boxed_slice()),
    };
    // What the synth renders from, every tick, whatever map is loaded: the
    // same programs the guest was handed. The map paks carry no sound (the
    // cook strips it), so rendering off the current pak played silence the
    // moment the player left the boot map.
    let audio_programs: &'static [u8] = pak::audio_programs_of(audi);
    dlog(&format!("[pv] sound: {} KB of programs", audio_programs.len() / 1024));
    unsafe { voxel::init(gd_static, audi); voxel::load_save_file(); }


    let map_ids: Vec<u32> = map_index.iter().map(|(id, _)| *id).collect();
    println!("{} maps.  L/R = switch map", map_ids.len());
    println!("D-pad orbit  A/B zoom  START exit");
    let mut instance = citro3d::Instance::new().expect("citro3d");
    let top3d = TopScreen3D::from(&gfx.top_screen);
    let (mut top_left, mut top_right) = top3d.split_mut();
    let RawFrameBuffer { width, height, .. } = top_left.raw_framebuffer();
    let mut left_target = instance
        .render_target(width, height, top_left, Some(DepthFormat::Depth24Stencil8))
        .expect("left target");
    let RawFrameBuffer { width, height, .. } = top_right.raw_framebuffer();
    let mut right_target = instance
        .render_target(width, height, top_right, Some(DepthFormat::Depth24Stencil8))
        .expect("right target");

    let shader = shader::Library::from_bytes(SHADER_BYTES).unwrap();
    let program = shader::Program::new(shader.get(0).unwrap()).unwrap();
    let projection_idx = program.get_vertex_uniform("projection").unwrap();
    let uvx_idx = program.get_vertex_uniform("uvx").unwrap();
    // Tree instances ride on this; every other draw leaves it zero.
    let toff_idx = program.get_vertex_uniform("toff").unwrap();

    let mut attr_info = attrib::Info::new();
    attr_info.add_loader(attrib::Register::V0, attrib::Format::Short, 4).unwrap();
    attr_info.add_loader(attrib::Register::V1, attrib::Format::UnsignedByte, 4).unwrap();
    attr_info.add_loader(attrib::Register::V2, attrib::Format::Float, 2).unwrap();

    // Cards only -- see CardVertex. Same registers, float position. The
    // shader reads inpos.xyz and supplies w itself, so three components is
    // all it needs.
    let mut card_attr = attrib::Info::new();
    card_attr.add_loader(attrib::Register::V0, attrib::Format::Float, 3).unwrap();
    card_attr.add_loader(attrib::Register::V1, attrib::Format::UnsignedByte, 4).unwrap();
    card_attr.add_loader(attrib::Register::V2, attrib::Format::Float, 2).unwrap();

    let stage0 = texenv::TexEnv::new()
        .src(texenv::Mode::BOTH, texenv::Source::Texture0, Some(texenv::Source::PrimaryColor), None)
        .func(texenv::Mode::BOTH, texenv::CombineFunc::Modulate);
    // Flat-colour stage for the companion's header bar: output the vertex
    // (primary) colour directly, ignoring the texture — a guaranteed-solid fill
    // that doesn't depend on any atlas texel being opaque-white.
    let stage_flat = texenv::TexEnv::new()
        .src(texenv::Mode::BOTH, texenv::Source::PrimaryColor, None, None)
        .func(texenv::Mode::BOTH, texenv::CombineFunc::Replace);
    // Light-on-dark text stage. The UI atlas stores glyphs as BLACK strokes on
    // a WHITE cell (opaque; the bottom target isn't alpha-blended), so a flat
    // tint can't work. Instead INTERPOLATE by the texel: out = Constant*tex +
    // PrimaryColor*(1-tex). Strokes (tex~=0) become the vertex colour (LIGHT);
    // the cell (tex~=1, white) becomes the Constant (DARK 0x0F380F), matching
    // the header bar so the text reads as light strokes on the dark strip.
    let stage_text = texenv::TexEnv::new()
        .src(
            texenv::Mode::RGB,
            texenv::Source::Constant,
            Some(texenv::Source::PrimaryColor),
            Some(texenv::Source::Texture0),
        )
        .func(texenv::Mode::RGB, texenv::CombineFunc::Interpolate)
        .src(texenv::Mode::ALPHA, texenv::Source::PrimaryColor, None, None)
        .func(texenv::Mode::ALPHA, texenv::CombineFunc::Replace)
        .color(0xFF0F380F); // 0xAABBGGRR = DARK (matches the bar / cell fill)
    // Dark-on-light text stage — the mirror of stage_text, for dark glyphs that
    // must sit on the light clear WITHOUT the opaque dark-green cell that plain
    // Modulate would paint (that "highlight" is what made unselected labels and
    // borders look boxed). out = Constant*tex + PrimaryColor*(1-tex): strokes
    // (tex~=0) take the vertex colour (DARK); the cell (tex~=1) becomes the
    // Constant (LIGHT 0x9BBC0F = clear), so it vanishes into the background.
    let stage_on_light = texenv::TexEnv::new()
        .src(
            texenv::Mode::RGB,
            texenv::Source::Constant,
            Some(texenv::Source::PrimaryColor),
            Some(texenv::Source::Texture0),
        )
        .func(texenv::Mode::RGB, texenv::CombineFunc::Interpolate)
        .src(texenv::Mode::ALPHA, texenv::Source::PrimaryColor, None, None)
        .func(texenv::Mode::ALPHA, texenv::CombineFunc::Replace)
        .color(0xFF0FBC9B); // 0xAABBGGRR = LIGHT / clear

    let mut map_i = 0usize;
    let mut geom = MapGeom {
        floor: Default::default(),
        chunk_spans: Vec::new(), verts: Vec::new(), center: [0.0; 3], size: 16.0,
        tex_rgba: Vec::new(), tw: 8, th: 8, aw: 8, ah: 8, is_huge: false,
        map_min: [0.0; 2], map_max: [0.0; 2],
    };
    let mut chunk_infos: Vec<(Span, buffer::Info)> = Vec::new();
    // Seam strips of the connected maps, so the world does not stop at a
    // wall of border bushes. Rebuilt with the map, never mid-walk: the
    // strip covers the whole shared edge, so walking along it needs no
    // reload and costs no hitch.
    let mut strip_infos: Vec<(Span, buffer::Info)> = Vec::new();
    let mut strip_hold: Vec<(Span, buffer::Info)> = Vec::new();
    let mut strip_verts_kb = 0usize;
    // A "huge" map (build_map's is_huge) streams a window of chunks instead
    // of building the whole thing, and re-streams whenever the player
    // crosses into a new chunk. chunk_infos_prev holds the outgoing window
    // one reload past its replacement: unlike a normal map transition
    // (always masked by pushWarpFade's fade-out), crossing a chunk boundary
    // mid-walk has no fade to hide a frame where the GPU is still reading
    // buffers this same tick just dropped (the bottom-screen tearing bug
    // this session already fixed once, for the same non-blocking-
    // C3D_FrameEnd reason).
    let mut chunk_infos_prev: Vec<(Span, buffer::Info)> = Vec::new();
    let mut cur_map_huge = false;
    /// The map the last build was for, so a huge-map STREAM (same map, new
    /// chunk window) can be told from a map CHANGE into a huge map. Starts
    /// deliberately unequal to map_i's initial 0 so the first build frees
    /// rather than holds.
    let mut prev_map_i = usize::MAX;
    let mut stream_center_chunk: Option<(i32, i32)> = None;
    // Snapshot of Scene.stamps_off as of the last build_map — a cut tree or
    // the S.S. Anne hull toggling a stamp only mutates Scene state; nothing
    // else would ever tell this flat-buffer terrain path to rebuild.
    //
    // The whole list, not its length: re-entering a map replays its cuts,
    // and the op handler removes-then-reappends each key, so the length is
    // an unreliable witness (see the comparison below).
    let mut stamps_off_seen: Vec<(u32, i16, i16)> = Vec::new();
    // Snapshot of scene.tint as of the last build_map — see build_map's
    // `tint` param doc: HM Flash changes this mid-visit and needs the same
    // kind of externally-triggered rebuild as a stamp toggle.
    let mut last_tint: u32 = 0xffff_ffff;
    /// What the geometry in hand was built from. A `reload` whose inputs are
    /// all identical to this rebuilds the same vertices to the same values,
    /// and a map like Route 8 is 651,000 of them -- the logs show maps built
    /// two and three times over with no frame drawn in between.
    ///
    /// (map id, stream centre, tint, stamp count, seam sides)
    type BuiltKey = (u32, Option<(i32, i32)>, u32, u64, [bool; 4]);
    let mut built_key: Option<BuiltKey> = None;
    /// The connected-map slots (id, offset) the built geometry and its seam
    /// strips were made for. The guest publishes these a frame or two AFTER
    /// the map itself when the player crosses a seam -- a warp arrives with
    /// them already set, which is why warping in showed the neighbours and
    /// walking across never did.
    let mut built_slots: Vec<(u32, i32, i32)> = Vec::new();
    let mut tex: Option<texture::Texture> = None;
    let mut reload = true;

    let mut center: [f32; 3] = [0.0, 0.0, 0.0];

    // Boot the gameplay guest once.
    let mut guest_ok = false;
    unsafe {
        let mut err = [0u8; 256];
        qjs_register_voxel(CTX);
        let mut src = GAME_JS.to_vec();
        src.push(0);
        if qjs_eval(CTX, src.as_ptr(), GAME_JS.len() as i32, err.as_mut_ptr(), 255) != 0 {
            let n = err.iter().position(|&c| c == 0).unwrap_or(0);
            println!("boot ERR: {}", String::from_utf8_lossy(&err[..n]));
        } else {
            guest_ok = true;
            println!("guest live - X toggles guest/orbit");
        }
    }
    {
        let n = pak_static.atlases.iter().filter(|p| p.kind == atlas_kind::PICS).count();
        println!("PICS pages: {}", n);
    }
    // 11025 Hz stereo, ~3 ticks per buffer (the core renders 183.75
    // frames per 60 Hz tick).
    // The synth renders at 11025, but the pump feeds fewer ticks than
    // wall-clock 60 Hz, so playback drags. Telling ndsp the samples are
    // 1.5x faster makes the song run at the right tempo.
    // Measured on hardware: the pump delivers ~11,224 frames/sec, so the
    // channel must consume at the rate we actually render.
    // 22050, the next rate up that audio.rs accepts (it interprets every
    // program's sample spans against this, and requires a divisor of 44100 —
    // AUDIO_RATES is [44100, 22050, 11025]).
    //
    // 11025 was the reason the whole game sounded muffled: Nyquist at 5.5kHz
    // cuts into the range a GB square wave actually occupies, so its
    // harmonics fold back as grit instead of ringing. 22050 doubles that
    // headroom. Not 44100: NDSP's own channel runs at 32728Hz, so 44100 has
    // to be resampled DOWN to reach it (aliasing again, at four times the
    // synth cost), while 22050 is resampled up, which linear interpolation
    // handles cleanly.
    const AUDIO_RATE: i32 = 22050;
    // 22050/60 is 367.5, so no whole number of frames is a tick. Rounding up
    // every tick over-produces by 0.14%, which is what made the queue creep
    // ahead of the DSP until something had to be dropped; the loop carries
    // the half-frame instead and alternates 367/368.
    const AUDIO_FRAMES_PER_TICK: i32 = (AUDIO_RATE + 59) / 60;
    // Each wave buffer holds exactly one tick (audio_3ds.c sizes NBUF of
    // them), so the queue depth is counted in ticks of slack, not samples.
    const AUDIO_BUF: i32 = AUDIO_FRAMES_PER_TICK;
    // pocketvoxel-psp/src/main.rs:289 — the synth has its own output rate
    // and defaults high; without this it renders a fraction of a tick's
    // song per call and the music drags.
    let _ = unsafe { voxel::scene().audio.set_rate(AUDIO_RATE as u32) };
    let audio_on = unsafe { audio3ds_init(AUDIO_RATE, AUDIO_BUF) } != 0;
    // Whether the DSP came up at all: it needs sdmc:/3ds/dspfirm.cdc, which a
    // real console has (dumped once by DSP1) and an emulator usually lacks, so
    // "off" here explains a silent game before anything else is suspected.
    dlog(&format!("[pv] sound: audio {}", if audio_on { "on" } else { "OFF (no DSP firmware?)" }));
    let mut pcm: Vec<i16> = vec![0; (AUDIO_BUF * 2) as usize];
    println!("audio: {}", if audio_on { "ndsp open" } else { "unavailable" });

    let mut guest_drive = true;   // boot into the game; the title state runs there
    let mut dbg_tick: u32 = 0;
    let mut frame_start: u64 = 0;
    let mut aud_ticks: u32 = 0;
    let mut aud_queued: u32 = 0;
    let mut aud_dropped: u32 = 0;
    // loudest sample since the last perf line: 0 there means the synth is
    // rendering silence, which is otherwise invisible in a log
    let mut aud_peak: u16 = 0;
    /// Leftover sixtieths of a frame, so the long-run rate is exact.
    let mut aud_rem: i32 = 0;
    let mut sim_acc: f32 = 0.0;
    let mut sim_last: u64 = 0;
    let mut fps_frames: u32 = 0;
    // The frame's cost, averaged over each second and printed every fifth:
    // CPU ms (sim, build, cull, submit), the GPU's own drawing time for the
    // last frame it finished, what survived the cull, and the 3D slider.
    let mut perf_n: u32 = 0;
    let mut perf_secs: u32 = 0;
    let mut perf_cpu_sum: f32 = 0.0;
    let mut perf_cpu_max: f32 = 0.0;
    let mut perf_gpu_sum: f32 = 0.0;
    let mut perf_gpu_max: f32 = 0.0;
    let mut perf_proc_sum: f32 = 0.0;
    let mut perf_slider: f32 = 0.0;
    let mut perf_radius: f32 = 0.0;
    let mut perf_spans: usize = 0;
    let mut perf_trees: usize = 0;
    let mut fps_last: u64 = 0;
    let pitches: [i32; 5] = [0, 1, 2, 3, 4];
    let mut pitch_i = 0usize;
    let mut page_tex: Vec<Option<texture::Texture>> = Vec::new();
    // TINS: one buffer per carved shape, and the placements that draw them.
    // A forest is the same few drawings thousands of times, so the geometry
    // is uploaded once and the instances only say where and how detailed.
    let mut tree_bufs: Vec<Option<(buffer::Info, [f32; 3], [f32; 3])>> = Vec::new();
    let mut tree_insts: Vec<pak::TreeInst> = Vec::new();
    // Card/pic vertex buffers are rebuilt every frame. Freeing them the
    // instant the frame ends lets the GPU read memory that's already gone —
    // on hardware that tears the walking sprite. Keep one frame alive.
    //
    // EVERY per-frame buffer needs this, and two were missing it: the top
    // screen's UI (the text box and its glyphs) and the move-animation
    // tiles. C3D_FrameEnd only SUBMITS the frame; the wait is in the next
    // C3D_FrameBegin, and these buffers are built BEFORE that. So the
    // allocator handed the new text box the linear memory the GPU was
    // still reading the old one out of, and it drew as the box smeared
    // across the map for a frame -- which is exactly when it was seen:
    // talking to someone, where the box is rebuilt on every letter.
    let mut card_hold: Vec<(usize, buffer::Info)> = Vec::new();
    let mut ui_hold: Option<buffer::Info> = None;
    let mut anim_hold: Vec<(usize, buffer::Info)> = Vec::new();
    let mut pic_hold: Vec<(usize, i16, buffer::Info)> = Vec::new();
    // Same hazard for the Kanto Gear (bottom) surface: its per-frame vertex
    // buffers were freed the instant the frame closure returned, but C3D_FrameEnd
    // is non-blocking, so under load (3D's second eye, larger maps) the GPU was
    // still reading them when the memory got reused — the bottom-screen
    // static/rippling tear on hardware. Hold each one a frame, like the sprites.
    let mut ui_b_hold: Option<buffer::Info> = None;
    let mut ui_b_bar_hold: Option<buffer::Info> = None;
    let mut ui_b_sprite_hold: Vec<(usize, buffer::Info)> = Vec::new();
    let mut ui_b_light_hold: Option<buffer::Info> = None;
    let mut ui_b_dim_hold: Option<buffer::Info> = None;
    // Title art uploaded mid-frame can be sampled by the GPU before the
    // cache is flushed; on hardware the right eye then reads half-written
    // bytes and the pic strobes. Warm and flush them up front.
    page_tex.resize_with(pak_static.atlases.len(), || None);
    for pg in [408usize, 421, 422, 423, 424] {
        if pg >= page_tex.len() { continue; }
        let (data, ptw, pth) = build_page_tex(pak_static, pg as u16, -1);
        if let Ok(mut t) = texture::Texture::new(
            texture::TextureParameters::new_2d(ptw as u16, pth as u16, texture::ColorFormat::Rgba8)) {
            if t.load_image(&data, texture::Face::default()).is_ok() {
                unsafe { gsp_flush(data.as_ptr(), data.len() as u32); }
                sprite_filter(&mut t, pak_static, pg as u16);
                page_tex[pg] = Some(t);
            }
        }
    }

    // ---- Kanto Gear companion (bottom screen), increment 1 ----------------
    // Reclaim the bottom screen from the boot text console and stand up a
    // citro3d target on it. Every boot diagnostic above went to `console`;
    // dropping it releases the RefCell borrow so this borrow_mut() can't panic.
    // NOTE (version-sensitive, citro3d c86c611): the shape of render_target's
    // screen argument is the one line most likely to need a tweak — if it
    // won't compile, the error names the expected type and I'll match it.
    drop(console);
    let mut bottom_screen = gfx.bottom_screen.borrow_mut();
    // Match the top screen's pixel order (Rgba8). The text console left the
    // bottom framebuffer in a different format, so the clear/atlas colours came
    // out with R/B swapped (the green fill read as blue). NOTE (version-
    // sensitive): if set_framebuffer_format / FramebufferFormat don't match
    // this ctru rev, the compile error names the right path and I'll fix it.
    bottom_screen.set_framebuffer_format(FramebufferFormat::Rgba8);
    // The boot-diagnostics Console (consoleInit, now dropped) turned OFF double
    // buffering on the bottom screen, and libctru never restores it on drop.
    // Left single-buffered, citro3d's per-frame transfer writes into the buffer
    // the LCD is actively scanning out -> the tearing/rippling seen on hardware
    // whenever the companion redraws (Citra doesn't emulate the scanout race, so
    // it only shows on device). Re-enable it and swap once to commit the change
    // (set_framebuffer_format / set_double_buffering only take effect on a swap)
    // before the render target binds the screen.
    bottom_screen.set_double_buffering(true);
    bottom_screen.swap_buffers();
    let RawFrameBuffer { width: bw, height: bh, .. } = bottom_screen.raw_framebuffer();
    let mut bottom_target = instance
        .render_target(bw, bh, bottom_screen, Some(DepthFormat::Depth24Stencil8))
        .expect("bottom target");
    // Kanto Gear: the UI atlas page carries the font/border glyphs the
    // companion surface (scene.ui_b) draws with — the same page the top UI uses.
    let ui_b_page = pak_static.atlases.iter()
        .position(|p| p.kind == atlas_kind::UI).unwrap_or(0);

    let mut yaw: f32 = 0.7;
    let mut pitch: f32 = 0.6;
    // The player's own camera offsets, on top of whatever camera the game
    // asks for. Zero is the game's own framing; the C-stick swings away from
    // it and ZL+ZR together puts it back.
    let mut cam_yaw_off: f32 = 0.0;
    let mut cam_pitch_off: f32 = 0.0;
    // Camera modes, cycled with the shoulder buttons. Mode 0 is the camera
    // this game has always had, unchanged and still the default -- everything
    // else is an addition, so nothing that reads the camera today moves.
    let mut cam_mode: usize = 0;
    // Travel direction, remembered between frames. Taken from how the CAMERA
    // moved rather than from the player's facing: the camera follows the
    // player, so its motion IS their heading, and standing still leaves the
    // last heading in place instead of snapping to a default.
    let mut cam_rig_yaw: f32 = 0.0;
    let mut cam_rig_pitch: f32 = pocketvoxel_core::cam::FREE_PITCH_DEFAULT;
    // The battle camera's own swing. Kept apart from the overworld's so that
    // walking round an arena never leaves the overworld camera somewhere else
    // when the fight ends: it resets the moment the battle does.
    let mut btl_yaw_off: f32 = 0.0;
    let mut btl_pitch_off: f32 = 0.0;
    let mut was_in_battle = false;
    // The yaw the WALK is rotated by, whichever camera produced it. Read by
    // the input packer above on the next frame.
    let mut walk_yaw: f32 = 0.0;
    let mut dist: f32 = geom.size * 1.4;

    while apt.main_loop() {
        hid.scan_input();
        let k = hid.keys_held();
        let d = hid.keys_down();
        // Commit whatever the last map load logged, in one write.
        dlog_batch_end();
        // START belongs to the game (menu). Exit with START+SELECT.
        unsafe {
            extern "C" { fn osGetTime() -> u64; }
            frame_start = osGetTime();
        }
        {
            extern "C" { fn osGetTime() -> u64; }
            fps_frames += 1;
            let now = unsafe { osGetTime() };
            if fps_last == 0 { fps_last = now; }
            if now.wrapping_sub(fps_last) >= 1000 {
                // Silent while the audio is keeping up; one line a second
                // the moment it is not, so a click has a number behind it
                // rather than being reported as "it sounds weird".
                if aud_dropped > 0 {
                    println!(
                        "audio: {} tick(s) dropped of {} ({} frames queued), {} fps",
                        aud_dropped, aud_ticks, aud_queued, fps_frames,
                    );
                }
                // The perf line: which side of the frame is full decides the
                // lever for a slow map, so it is measured rather than guessed.
                perf_secs += 1;
                if perf_n > 0 && perf_secs % 5 == 0 {
                    // dlog, not println: println goes to a debug console this
                    // build has no window for, which is why the first run of
                    // this line left no trace in pvlog.txt at all.
                    dlog(&format!(
                        "[pv] perf: {} fps  cpu {:.1} avg {:.0} max ms  gpu {:.1} avg {:.0} max ms  proc {:.1} ms  spans {}/{}  trees {}/{}  3d {:.2} r{:.0}",
                        fps_frames,
                        perf_cpu_sum / perf_n as f32, perf_cpu_max,
                        perf_gpu_sum / perf_n as f32, perf_gpu_max,
                        perf_proc_sum / perf_n as f32,
                        unsafe { DRAWN }, perf_spans, unsafe { TREES_DRAWN }, perf_trees,
                        perf_slider, perf_radius,
                    ));
                    dlog(&format!("[pv] sound: peak {} over the last 5 s", aud_peak));
                    aud_peak = 0;
                }
                perf_n = 0;
                perf_cpu_sum = 0.0; perf_cpu_max = 0.0;
                perf_gpu_sum = 0.0; perf_gpu_max = 0.0; perf_proc_sum = 0.0;
                fps_frames = 0; aud_ticks = 0; aud_queued = 0; aud_dropped = 0;
                fps_last = now;
            }
        }
        if d.contains(KeyPad::START) && k.contains(KeyPad::SELECT) { break; }
        if d.contains(KeyPad::SELECT) && k.contains(KeyPad::START) { break; }
        // The viewer is reachable only from the title menu now; START
        // leaves it and hands control back to the game.
        if unsafe { voxel::take_viewer_request() } { guest_drive = false; }
        if !guest_drive && guest_ok && d.contains(KeyPad::START) { guest_drive = true; }
        if guest_drive {
            // The guest is a 60 Hz simulation; render rate must not change
            // game speed. Catch up on whole ticks, capped so a hitch can't
            // spiral.
            let steps = unsafe {
                extern "C" { fn osGetTime() -> u64; }
                let now = osGetTime();
                if sim_last == 0 { sim_last = now; }
                let dt = now.wrapping_sub(sim_last) as f32;
                sim_last = now;
                sim_acc += dt.min(100.0);
                let mut n = 0;
                while sim_acc >= 16.667 && n < 3 { sim_acc -= 16.667; n += 1; }
                n.max(1)
            };
            let mut b = 0i32;
            if k.contains(KeyPad::DPAD_UP)    { b |= 1 << 0; }
            if k.contains(KeyPad::DPAD_DOWN)  { b |= 1 << 1; }
            if k.contains(KeyPad::DPAD_LEFT)  { b |= 1 << 2; }
            if k.contains(KeyPad::DPAD_RIGHT) { b |= 1 << 3; }
            // The circle pad walks exactly as the d-pad does -- same bits,
            // so menus, the bag and the naming screen all take it too.
            {
                let (cx, cy) = hid.circlepad_position();
                b |= stick_as_dpad(cx, cy);
                // ...and the pad itself, whole, for the free walk.
                unsafe { voxel::set_stick(cx, cy); }
            }
            if k.contains(KeyPad::A)          { b |= 1 << 4; }
            if k.contains(KeyPad::B)          { b |= 1 << 5; }
            if k.contains(KeyPad::START)      { b |= 1 << 6; }
            if k.contains(KeyPad::SELECT)     { b |= 1 << 7; }
            // Bottom-screen touch rides the free high bits of the button word,
            // so the guest can react without changing the qjs_call_frame ABI
            // (the C shim, and its `buttons: i32`, are unchanged):
            //   bit 8      = touching
            //   bits 9..16 = x / 2 (0..159)  bits 17..23 = y / 2 (0..119)
            // Halved so they end at bit 23: bits 24-25 carry the camera's
            // quarter turns below, and a full-size y (bits 18..25) overlapped
            // them -- a touch with the camera turned landed up to 192 px
            // lower than the finger, and touching disturbed the turn count.
            // Two-pixel steps are finer than anything the gear draws.
            {
                let t = hid.touch_position();
                if t.0 != 0 || t.1 != 0 {
                    b |= 1 << 8;
                    b |= (((t.0 as i32) >> 1) & 0xff) << 9;
                    b |= (((t.1 as i32) >> 1) & 0x7f) << 17;
                }
            }
            // DEBUG map-cycle: L/R ride bits 26/27 the same way touch rides
            // 8-25 — no GB equivalent, so this stays out of VOX_BTN/Input and
            // is read directly by psp-main.ts's frame() (game.debugCycleMap).
            // `d` (this-frame press), not `held`, so one tap is one cycle.
            if d.contains(KeyPad::L) { b |= 1 << 27; }
            if d.contains(KeyPad::R) { b |= 1 << 26; }
            // Bits 24-25: how far the view has been swung, in quarter turns.
            // The guest rotates its WALK by this and nothing else -- a menu
            // is drawn flat on the screen and its cursor has to keep moving
            // the way the player pushed.
            {
                // On a free rung the walk is relative to the RIG's yaw,
                // or pushing forward sends the player off in the orbit's old
                // direction instead of the way the camera is looking.
                // The camera's yaw in 64ths of a turn, offset half a
                // quadrant: the top two bits are then exactly the rounded
                // quarter turns the grid walk reads from 24-25, and the low
                // four ride in 28-31 for free movement.
                let tau = core::f32::consts::PI * 2.0;
                let fine = ((walk_yaw.rem_euclid(tau) / tau * 64.0).round() as i32) & 63;
                let e = (fine + 8) & 63;
                b |= ((e >> 4) & 3) << 24;
                b |= (e & 15) << 28;
            }
            unsafe {
                let mut e2 = [0u8; 256];
                let mut failed = false;
                // Before the frame reads a single vertex: if anything put a
                // different entry at the front of the pak cache without
                // saying so, take the new one. A stale `pak_static` reads
                // chunk records and vertex pools out of memory that has
                // moved, which draws as geometry stretched across the
                // screen -- and then rights itself on the next map build,
                // which is exactly how it was reported.
                if pak_moved() {
                    pak_static = cur_pak();
                    PAK_RETAKEN += 1;
                    dlog(&format!("[pv] pak_static re-taken ({PAK_RETAKEN} so far)"));
                }
                let t_js = now_ms();
                for _ in 0..steps {
                    if qjs_call_frame(CTX, b, e2.as_mut_ptr(), 255) != 0 { failed = true; break; }
                    // Scene time and audio belong to the SIM tick, not the
                    // rendered frame: at the 30 Hz render cap they were
                    // advancing at half speed.
                    voxel::scene().tick();
                    if audio_on {
                        // Exactly rate/60 frames per tick on average: carry
                        // the leftover sixtieths rather than rounding up
                        // every time (see AUDIO_FRAMES_PER_TICK).
                        aud_rem += AUDIO_RATE % 60;
                        let mut want = (AUDIO_RATE / 60) as usize;
                        if aud_rem >= 60 { aud_rem -= 60; want += 1; }
                        voxel::scene().render_audio_with(audio_programs, want, &mut pcm);
                        for s in &pcm[..want * 2] { aud_peak = aud_peak.max(s.unsigned_abs()); }
                        let got = audio3ds_queue(pcm.as_ptr(), want as i32);
                        aud_ticks += 1;
                        aud_queued += got as u32;
                        // A tick the synth rendered and the queue refused is
                        // a hole in the music. Counted so the HUD line says
                        // so instead of it being a mystery click.
                        if got == 0 { aud_dropped += 1; }
                    }
                }
                if failed {
                    let n = e2.iter().position(|&c| c == 0).unwrap_or(0);
                    println!("frame ERR: {}", String::from_utf8_lossy(&e2[..n]));
                    guest_drive = false;
                } else {
                    let sc = voxel::scene();
                    // The guest owns which map you're standing in (mapShow).
                    let slot = &sc.maps[0];
                    if slot.shown {
                        let want = slot.map_id;
                        if map_ids.get(map_i).copied() != Some(want) {
                            // In or beside the forest, everything below runs
                            // the way it always has. Decided before the read,
                            // from the map and every neighbour it shows.
                            {
                                let name_of = |id: u32| {
                                    map_index.iter().find(|(m, _)| *m == id).map(|(_, n)| n.as_str())
                                };
                                let mut zone = name_of(want).is_some_and(forest_zone);
                                for i in 1..sc.maps.len() {
                                    if sc.maps[i].shown && name_of(sc.maps[i].map_id).is_some_and(forest_zone) {
                                        zone = true;
                                    }
                                }
                                unsafe { LEGACY_ZONE = zone };
                            }
                            dlog_batch_begin();
                            if let Some((_, nm)) = map_index.iter().find(|(id, _)| *id == want) {
                                // cam_px is already the NEW map's position on
                                // this frame -- the same value `center` is
                                // assigned a few lines below, and the same one
                                // the build will plan against.
                                let key = plan_key(want, sc.cam_px());
                                LOAD_JS_MS = now_ms().wrapping_sub(t_js);
                                let t_pak = now_ms();
                                if unsafe { load_map_pak(nm, Some(key)) } {
                                    pak_static = unsafe { cur_pak() };
                                }
                                LOAD_PAK_MS = now_ms().wrapping_sub(t_pak);
                            }
                            if let Some(ix) = map_ids.iter().position(|&m| m == want) {
                                map_i = ix;
                                reload = true;
                            }
                        }
                    }
                    // (a second, identical map-switch block used to sit here;
                    // it could never fire, the one above having already moved
                    // map_i to `want`.)
                    // Stamps: compare the SET, not its size. Re-entering a
                    // map replays every cut this save recorded, and the op
                    // handler removes-then-reappends each key — so the list
                    // comes out the same length with different contents, and
                    // a length check calls that "no change". Any rebuild the
                    // map switch itself did not already force would be
                    // skipped and the chopped trees would grow back.
                    //
                    // Not consumed here either: the build below can bail out
                    // (a pak that would not load), and eating the change on
                    // the way past would leave nothing to re-trigger it.
                    // build_map's own snapshot is what marks it done.
                    if sc.stamps_off != stamps_off_seen {
                        reload = true;
                    }
                    if sc.tint != last_tint {
                        last_tint = sc.tint;
                        reload = true;
                    }
                    let (gx, gy) = sc.cam_px();
                    // Streaming maps (build_map's is_huge — currently just
                    // Viridian Forest): re-stream the moment the player's
                    // world position rounds to a new chunk, so the window
                    // of loaded geometry follows them through the map
                    // instead of being fixed at whatever it was on arrival.
                    if cur_map_huge {
                        let pcx = (gx / CHUNK_PX as f32).floor() as i32;
                        let pcz = (gy / CHUNK_PX as f32).floor() as i32;
                        if stream_center_chunk != Some((pcx, pcz)) {
                            stream_center_chunk = Some((pcx, pcz));
                            reload = true;
                        }
                    }
                    center[0] = gx;
                    center[2] = gy;

                    // The neighbours the guest is showing right now. When
                    // they differ from what was built, the strips on screen
                    // are for the wrong map (or for none at all) and the
                    // border ring is clipped for the wrong sides: rebuild.
                    {
                        let cur: Vec<(u32, i32, i32)> = (1..sc.maps.len())
                            .filter(|&i| sc.maps[i].shown)
                            .map(|i| (sc.maps[i].map_id, sc.maps[i].ox as i32, sc.maps[i].oy as i32))
                            .collect();
                        if cur != built_slots {
                            reload = true;
                        }
                    }

                    // Read the connected maps ahead, in whatever time is
                    // left over. The guest publishes them as extra map slots
                    // (it is already drawing their seam strips), so by the
                    // time the player reaches the edge the pak they are
                    // walking into is usually already in hand -- and a seam
                    // crossing, unlike a door, has no fade to hide a read
                    // behind.
                    //
                    // Never while a script is mid-warp: the loader is about
                    // to want the card for the map actually being entered,
                    // and competing with it would make the visible wait
                    // longer, not shorter.
                    if !reload {
                        unsafe { prefetch_retarget(map_ids.get(map_i).copied().unwrap_or(0)) };
                        // How close the player is to leaving this map at all:
                        // the read in flight is for a neighbour, and near the
                        // edge it is about to be wanted.
                        let edge = (center[0] - geom.map_min[0])
                            .min(geom.map_max[0] - center[0])
                            .min(center[2] - geom.map_min[1])
                            .min(geom.map_max[1] - center[2]);
                        let budget = if edge < PREFETCH_NEAR_PX { PREFETCH_MS_NEAR } else { PREFETCH_MS };
                        if unsafe { prefetch_step(budget) } {
                            // Inserting into PAK_CACHE can reallocate it and
                            // move the Pak structs with it, and pak_static
                            // points straight at the front one. Re-take it.
                            pak_static = unsafe { cur_pak() };
                        } else if unsafe { PREFETCH.is_none() } {
                            // NEAREST SEAM FIRST. There is one read-ahead in
                            // flight at a time and a map can have three or
                            // four neighbours, so slot order is a one-in-N
                            // guess -- and it guessed wrong on the run that
                            // was logged: standing in Lavender Town it read
                            // Route 10 while the player walked west into
                            // Route 8, which then had to be read from cold.
                            //
                            // A neighbour's offset says which side it is on,
                            // so the distance to the seam it lies across is
                            // the distance to that edge of this map.
                            let (px, pz) = (center[0], center[2]);
                            let mut cand: Vec<(f32, usize)> = Vec::new();
                            for i in 1..sc.maps.len() {
                                if !sc.maps[i].shown {
                                    continue;
                                }
                                let (ox, oy) = (sc.maps[i].ox as f32, sc.maps[i].oy as f32);
                                // Distance to the edge this neighbour is over.
                                let dx = if ox < 0.0 {
                                    px - geom.map_min[0]
                                } else if ox > 0.0 {
                                    geom.map_max[0] - px
                                } else {
                                    f32::MAX
                                };
                                let dz = if oy < 0.0 {
                                    pz - geom.map_min[1]
                                } else if oy > 0.0 {
                                    geom.map_max[1] - pz
                                } else {
                                    f32::MAX
                                };
                                cand.push((dx.min(dz), i));
                            }
                            cand.sort_by(|a, b| {
                                a.0.partial_cmp(&b.0).unwrap_or(core::cmp::Ordering::Equal)
                            });
                            // The other half: standing in the forest or one
                            // of its gates, the next map is very likely the
                            // forest itself, and whatever gets read ahead is
                            // still holding its buffer when that 56 MB load
                            // arrives. Nothing is read ahead from here.
                            let in_forest = map_ids
                                .get(map_i)
                                .and_then(|id| {
                                    map_index.iter().find(|(mid, _)| mid == id)
                                })
                                .is_some_and(|(_, nm)| nm.starts_with("VIRIDIAN_FOREST"));
                            if !in_forest {
                                for (_, i) in cand {
                                    let nid = sc.maps[i].map_id;
                                    if let Some((_, nm)) =
                                        map_index.iter().find(|(id, _)| *id == nid)
                                    {
                                        if unsafe { prefetch_start(nm) } {
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        // L/R step the map, but ONLY in the standalone viewer. While the
        // guest drives, the map is its business and L/R belong to the Kanto
        // Gear's view switcher (psp-main.ts frame -> game.cycleGearView).
        // Unguarded this fired underneath the running game: it swapped the
        // loaded pak, then the guest's next mapShow was found to disagree and
        // the real map was reloaded — a visible flick to another map and back
        // on every press.
        if !guest_drive {
            if d.contains(KeyPad::R) {
                map_i = (map_i + 1) % map_ids.len();
                reload = true;
            }
            if d.contains(KeyPad::L) {
                map_i = (map_i + map_ids.len() - 1) % map_ids.len();
                reload = true;
            }
        }

        if reload {
            reload = false;
            // WAIT FOR THE GPU FIRST. Everything below frees the vertex
            // buffers the last frame was drawn from and allocates new ones
            // in their place, and it runs BETWEEN frames -- after
            // C3D_FrameEnd submitted that frame and before the next
            // C3D_FrameBegin, whose SYNCDRAW is what normally guarantees
            // the GPU is done. So a rebuild could hand the linear
            // allocator memory the GPU was still reading vertices out of,
            // and it drew as geometry stretched across the screen: a
            // rebuild is triggered by a stamp, a tint or the guest
            // publishing different connected maps, which is why it showed
            // up while standing still talking to someone.
            unsafe { C3D_FrameSync() };
            dlog_batch_begin();
            let t_load = now_ms();
            // Load this map's own pak, then build from it.
            if let Some((id, nm)) = map_index.get(map_i) {
                // The same position build_map is about to be handed, so the
                // geometry read is exactly the geometry built.
                let key = guest_drive.then(|| plan_key(*id, (center[0], center[2])));
                if unsafe { load_map_pak(nm, key) } {
                    pak_static = unsafe { cur_pak() };
                }
            }
            // A pak that did NOT load (missing or unreadable on the SD card
            // — load_map_pak prints "pak missing") leaves pak_static on the
            // PREVIOUS map, whose directory has no entry for the map we are
            // switching to. build_map's `pak.maps.iter().find(..).expect()`
            // would panic on that, killing the process the instant you step
            // through a warp or a seam — which is indistinguishable from a
            // freeze. Hold the old geometry up instead and say so: the map
            // is wrong until the card is fixed, but the game keeps running
            // and the log names the file to copy.
            let want_id = map_ids[map_i];
            if !pak_static.maps.iter().any(|m| m.map_id == want_id) {
                println!(
                    "map #{} has no pak loaded ({}); keeping previous geometry",
                    want_id,
                    map_index.get(map_i).map(|(_, n)| n.as_str()).unwrap_or("?"),
                );
                continue;
            }
            tex = None;
            // guest_drive's own position (center[]) is already current for
            // this tick by the time we get here (the cam_px() read and any
            // map-change reload both happen earlier in this same iteration,
            // above); in orbit/debug mode (R/L map browsing, !guest_drive)
            // there's no player position to window around, so build_map
            // falls back to its own no-position behavior (whole map, safe
            // cap) for a huge map there — the debug browser never streams,
            // which is fine, it's not the play path this fixes.
            let player_px = if guest_drive { Some((center[0], center[2])) } else { None };
            let scene_now = unsafe { voxel::scene() };
            let stamps_off_snapshot: Vec<(u32, i16, i16)> = scene_now.stamps_off.clone();
            stamps_off_seen = stamps_off_snapshot.clone();
            last_tint = scene_now.tint;
            // Which sides a neighbour will be drawn on, read from the slots
            // the guest already publishes. Needed BEFORE build_map so the
            // border ring can be clipped away on exactly those sides.
            let neighbor_slots: Vec<(u32, f32, f32)> = (1..scene_now.maps.len())
                .filter(|&i| scene_now.maps[i].shown)
                .map(|i| {
                    (
                        scene_now.maps[i].map_id,
                        scene_now.maps[i].ox as f32,
                        scene_now.maps[i].oy as f32,
                    )
                })
                .collect();
            // The current map's own real box, from the pak already loaded.
            let cur_box = {
                let m = pak_static
                    .maps
                    .iter()
                    .find(|m| m.map_id == map_ids[map_i]);
                m.map(|m| {
                    let cs = &pak_static.chunks
                        [m.first as usize..(m.first + m.count) as usize];
                    let (mut mn, mut mx) = ([f32::MAX; 2], [f32::MIN; 2]);
                    for c in cs {
                        mn[0] = mn[0].min(c.aabb_min[0] as f32);
                        mn[1] = mn[1].min(c.aabb_min[2] as f32);
                        mx[0] = mx[0].max(c.aabb_max[0] as f32);
                        mx[1] = mx[1].max(c.aabb_max[2] as f32);
                    }
                    let ring = [(-mn[0]).max(0.0), (-mn[1]).max(0.0)];
                    (
                        [mn[0] + ring[0], mn[1] + ring[1]],
                        [mx[0] - ring[0], mx[1] - ring[1]],
                    )
                })
            };
            // Which side each neighbour is REALLY on: the axis on which its
            // box lies wholly outside ours. Deciding from the offset's sign
            // instead mistakes a lateral slide along a seam for a second
            // connection, and clips a border ring off an edge that has
            // nothing behind it.
            let mut seam_sides = [false; 4]; // west, east, north, south
            if let Some((cmn, cmx)) = cur_box {
                for &(nid, ox, oy) in neighbor_slots.iter() {
                    let Some((_, nname)) = map_index.iter().find(|(id, _)| *id == nid) else {
                        continue;
                    };
                    // A resident copy answers without opening the file;
                    // the forest zone keeps the file read it always did.
                    let legacy = unsafe { LEGACY_ZONE };
                    #[allow(static_mut_refs)]
                    let seen = if legacy {
                        None
                    } else {
                        unsafe { BOUNDS_SEEN.iter().find(|b| b.0 == nid).map(|b| (b.1, b.2)) }
                    };
                    let resident = if legacy || seen.is_some() { None } else { unsafe { resident_pak(nname) } };
                    let bounds = if seen.is_some() {
                        seen
                    } else {
                        match resident {
                            Some(p) => bounds_from_pak(p, nid),
                            None => {
                                let path = format!("{}/{}.vxpak", PAKS_DIR, nname);
                                neighbor_bounds(&path, nid)
                            }
                        }
                    };
                    if let (false, None, Some((a, b))) = (legacy, seen, bounds) {
                        #[allow(static_mut_refs)]
                        unsafe { BOUNDS_SEEN.push((nid, a, b)) };
                    }
                    let Some((nmn, nmx)) = bounds else {
                        continue;
                    };
                    let (lo, hi) = ([nmn[0] + ox, nmn[1] + oy], [nmx[0] + ox, nmx[1] + oy]);
                    if hi[0] <= cmn[0] + 1.0 { seam_sides[0] = true; }
                    if lo[0] >= cmx[0] - 1.0 { seam_sides[1] = true; }
                    if hi[1] <= cmn[1] + 1.0 { seam_sides[2] = true; }
                    if lo[1] >= cmx[1] - 1.0 { seam_sides[3] = true; }
                }
            }
            let bounds_ms = now_ms().wrapping_sub(t_load);
            built_slots = neighbor_slots
                .iter()
                .map(|&(id, ox, oy)| (id, ox as i32, oy as i32))
                .collect();
            // Which stamps are hidden, not HOW MANY: a mansion switch
            // opens one door and closes another, so the count comes back the
            // same and the map would keep the doors it already had. The
            // reload itself already fires on the list's contents (it is
            // compared whole, above); this is the same question asked the
            // same way.
            let stamps_key = {
                let mut h: u64 = 0xcbf2_9ce4_8422_2325;
                for &(id, x, y) in stamps_off_snapshot.iter() {
                    for b in id
                        .to_le_bytes()
                        .iter()
                        .chain(x.to_le_bytes().iter())
                        .chain(y.to_le_bytes().iter())
                    {
                        h ^= *b as u64;
                        h = h.wrapping_mul(0x100_0000_01b3);
                    }
                }
                h
            };
            let want_key: BuiltKey = (
                map_ids[map_i],
                if cur_map_huge { stream_center_chunk } else { None },
                last_tint,
                stamps_key,
                seam_sides,
            );
            // Same map, same everything: what is on screen is already it.
            // Skipping only the BUILD, not the frame -- a `continue` here
            // would drop the frame, and if a reload ever fired every frame
            // that would be a freeze rather than a stutter.
            let skip_build = built_key.as_ref() == Some(&want_key);
            if skip_build {
                dlog("[pv] rebuild skipped (inputs unchanged)");
            }
            let t_build = { extern "C" { fn osGetTime() -> u64; } unsafe { osGetTime() } };
            if !skip_build {
                geom = build_map(
                    pak_static,
                    map_ids[map_i],
                    player_px,
                    &stamps_off_snapshot,
                    last_tint,
                    seam_sides,
                );
                cur_map_huge = geom.is_huge;
                built_key = Some(want_key);
                // The floor the cards stand on, for the draw pass.
                unsafe { voxel::scene().floor = geom.floor.clone(); }
            }
            {
                let build_ms = {
                    extern "C" { fn osGetTime() -> u64; }
                    unsafe { osGetTime() }.wrapping_sub(t_build)
                };
                let tot: usize = geom.chunk_spans.iter().map(|s| s.end - s.start).sum();
                let over = geom.chunk_spans.iter().filter(|s| s.end - s.start > 65535).count();
                // Paired with the loader's "pak ... in N ms": together these
                // two numbers say whether a slow map change is the card or
                // the mesh build, which is not guessable from the outside.
                println!(
                    "built in {} ms: chunks {} verts {} clipped {} huge {}",
                    build_ms, geom.chunk_spans.len(), tot, over, cur_map_huge
                );
                dlog(&format!("[pv] built in {} ms", build_ms));
                dlog(&format!(
                    "[pv] built map#{} name={} spans={} verts={} huge={} tint={:08x}",
                    map_ids[map_i],
                    map_index.get(map_i).map(|(_, n)| n.as_str()).unwrap_or("?"),
                    geom.chunk_spans.len(),
                    tot,
                    cur_map_huge,
                    last_tint,
                ));
                // What the floor map came out as, so a map that draws a shelf
                // but stands nothing on it says so in the log rather than in
                // a photograph. `raised` is the count of cells above the base.
                {
                    let f = &geom.floor;
                    let raised = f.cells.iter().filter(|h| **h > 0).count();
                    let top = f.cells.iter().copied().max().unwrap_or(0);
                    dlog(&format!(
                        "[pv] floor cells={}x{} raised={} top={}",
                        f.w, f.h, raised, top,
                    ));
                }
                dlog(&format!(
                    "[pv] seams W={} E={} N={} S={} nbrs={}",
                    seam_sides[0], seam_sides[1], seam_sides[2], seam_sides[3],
                    neighbor_slots.len(),
                ));
            }
            // Nothing was built, so there is nothing to upload -- and
            // nothing TO upload from: the CPU-side vertices are freed the
            // moment the GPU has them (see the end of this block), so the
            // spans that describe them now index an empty vector. Running
            // the upload again sliced that vector and panicked, which on
            // hardware is an abort to the homebrew menu; the mansion's
            // switches are a rebuild request, so flipping a second one was
            // where it showed. The buffers the GPU already holds ARE this
            // geometry, and they are still bound. Leave them alone.
            if !skip_build {
                // Both halves of the memory picture, not just the GPU's: the
                // pak cache and the built geometry live on the APP heap, and a
                // rebuild that cannot get its vertices there is the one that
                // used to abort. Plus anything refused for pointing outside the
                // pools, which should always read 0.
                dlog(&format!(
                    "[pv] linear free {} KB, heap block {} KB, cache {} KB, oob {} before build",
                    unsafe_free_kb(),
                    probe_free_kb(16),
                    unsafe { cache_total_kb() },
                    unsafe { POOL_OOB },
                ));
                // The upload is where a load has died before (linear running
                // dry): what led up to it is on the card before it starts.
                dlog_batch_end();
                dlog_batch_begin();
                // Holding the outgoing buffers while the new ones allocate
                // DOUBLES peak linear memory, and the vertex buffers are the
                // biggest thing in it (a full map can be 18 MB). That hold only
                // exists for the huge-map STREAM — a re-build of the map the
                // player is already standing in, crossing a chunk boundary
                // mid-walk, which has no fade to hide a freed buffer the GPU is
                // still reading. An ordinary map CHANGE is masked by
                // pushWarpFade, so there we free first and allocate second,
                // which halves the peak.
                //
                // The test is "same map", not "the new map is huge". Those differ
                // exactly when walking INTO a huge map, and that case crashed:
                // entering SAFFRON_CITY off ROUTE_6 held Route 6's 8.5 MB of
                // terrain plus 2.3 MB of seam strips while Saffron's own 6.4 MB
                // (399,999 verts x 16 B) tried to allocate against 6.35 MB free,
                // and the upload died mid-loop — twice in the same log, each time
                // between "linear free ... before build" and the upload summary.
                let streaming_same_map = cur_map_huge && map_i == prev_map_i;
                if streaming_same_map {
                    chunk_infos_prev = core::mem::take(&mut chunk_infos);
                } else {
                    chunk_infos_prev.clear();
                    chunk_infos.clear();
                    strip_hold.clear();
                    strip_infos.clear();
                    strip_verts_kb = 0;
                }
                prev_map_i = map_i;
                let mut upload_fail = 0u32;
                for s in geom.chunk_spans.iter() {
                    let n = (s.end - s.start).min(65535);
                    if n == 0 { continue; }
                    if s.start + n > geom.verts.len() { upload_fail += 1; continue; }
                    if !linear_fits(n) { upload_fail += 1; continue; }
                    let mut bi = buffer::Info::new();
                    if bi.add(buffer::Buffer::new(&geom.verts[s.start..s.start + n]), attr_info.permutation()).is_ok() {
                        chunk_infos.push((*s, bi));
                    } else {
                        // Silently dropping these is how a map ends up as bare
                        // sky: the geometry built fine, the GPU buffer just
                        // never took it.
                        upload_fail += 1;
                    }
                }
                dlog(&format!(
                    "[pv] uploaded {}/{} spans (failed {})",
                    chunk_infos.len(),
                    geom.chunk_spans.len(),
                    upload_fail,
                ));
                // Land it. A rebuild dying past this point used to leave the
                // whole batch unwritten, so the log stopped at "before build"
                // and said nothing about which of the four things after it --
                // upload, strips, trees, texture -- was the one that died.
                dlog_batch_end();
                dlog_batch_begin();

                let t_strips = now_ms();
                // --- connected-map seam strips -------------------------------
                // Skipped entirely on a huge map: those already spend their
                // whole vertex budget on the map underfoot, and that path is
                // the one that has crashed before. Everywhere else, the guest
                // has already worked out which maps adjoin and at what offset
                // (computeNeighbors -> mapShow), so slots 1..4 carry exactly
                // what to load and where to put it.
                strip_hold = core::mem::take(&mut strip_infos);
                strip_verts_kb = 0;
                // Strips are a luxury; the map underfoot is not. If linear
                // memory is already tight after building it, skip them rather
                // than fail an allocation mid-load.
                let free_kb = unsafe_free_kb();
                dlog(&format!("[pv] linear free {} KB after build", free_kb));
                if !cur_map_huge && free_kb >= STRIP_MIN_FREE_KB {
                    for &(nid, ox, oy) in neighbor_slots.iter() {
                        dlog(&format!("[pv] strip loading id={} free={}KB", nid, unsafe_free_kb()));
                        let Some((_, nname)) = map_index.iter().find(|(id, _)| *id == nid) else {
                            continue;
                        };
                        // From memory when the read-ahead already has it whole;
                        // off the card otherwise, and always in the forest zone.
                        let resident = if unsafe { LEGACY_ZONE } {
                            None
                        } else {
                            unsafe { resident_pak(nname) }.filter(|p| strip_has_trees(p, nid))
                        };
                        // A resident copy that cannot supply the strip (read
                        // under a plan that skipped the tier it wants) must fall
                        // THROUGH to the file, not drop the neighbour: skipping
                        // it left a map with no connected map drawn at all, and
                        // its border ring already clipped off for one.
                        let strip = resident
                            .and_then(|p| {
                                strip_from_pak(p, nid, ox, oy, geom.map_min, geom.map_max, last_tint)
                            })
                            .or_else(|| {
                                let path = format!("{}/{}.vxpak", PAKS_DIR, nname);
                                load_neighbor_strip(
                                    &path, nid, ox, oy, geom.map_min, geom.map_max, last_tint,
                                )
                            });
                        let Some(strip) = strip else {
                            continue;
                        };
                        strip_verts_kb += strip.verts.len() * 20 / 1024;
                        for s in strip.spans.iter() {
                            let n = (s.end - s.start).min(65535);
                            if n == 0 { continue; }
                            // Same infallible-allocation trap as the terrain
                            // upload above — see linear_fits. A neighbour strip is
                            // scenery, so dropping one is cheap.
                            if !linear_fits(n) { continue; }
                            let mut bi = buffer::Info::new();
                            if bi
                                .add(
                                    buffer::Buffer::new(&strip.verts[s.start..s.start + n]),
                                    attr_info.permutation(),
                                )
                                .is_ok()
                            {
                                strip_infos.push((*s, bi));
                            }
                        }
                        dlog(&format!(
                            "[pv] strip {} spans={} verts={} off=({:.0},{:.0})",
                            nname,
                            strip.spans.len(),
                            strip.verts.len(),
                            ox,
                            oy,
                        ));
                    }
                }
                // --- tree instances (TINS) ----------------------------------
                tree_bufs.clear();
                tree_insts.clear();
                {
                    let insts = pak_static.trees_of(map_ids[map_i]);
                    if !insts.is_empty() {
                        tree_insts.extend_from_slice(insts);
                        let mut shape_verts = 0usize;
                        for m in pak_static.tree_shapes.iter() {
                            let n = m.index_count as usize;
                            if n == 0 || !linear_fits(n) {
                                tree_bufs.push(None);
                                continue;
                            }
                            let mut v: Vec<Vertex> = Vec::with_capacity(n);
                            let mut gmin = [f32::MAX; 3];
                            let mut gmax = [f32::MIN; 3];
                            let vbase = m.vert_base as usize;
                            for i in 0..n {
                                let Some(pv) =
                                    pool_vert(pak_static, vbase, m.index_base as usize + i)
                                else {
                                    break;
                                };
                                let a = draw::modulate_rgb(pv.abgr, last_tint);
                                let p = [pv.x as f32, pv.y as f32, pv.z as f32];
                                for c in 0..3 {
                                    if p[c] < gmin[c] { gmin[c] = p[c]; }
                                    if p[c] > gmax[c] { gmax[c] = p[c]; }
                                }
                                v.push(Vertex {
                                    pos: [pv.x, pv.y, pv.z, 0],
                                    color: [
                                        (a & 0xff) as u8,
                                        ((a >> 8) & 0xff) as u8,
                                        ((a >> 16) & 0xff) as u8,
                                        255,
                                    ],
                                    uv: [pv.uf(), pv.vf()],
                                });
                            }
                            let mut bi = buffer::Info::new();
                            if bi.add(buffer::Buffer::new(&v), attr_info.permutation()).is_ok() {
                                shape_verts += v.len();
                                tree_bufs.push(Some((bi, gmin, gmax)));
                            } else {
                                tree_bufs.push(None);
                            }
                        }
                        let ok = tree_bufs.iter().filter(|b| b.is_some()).count();
                        let first = tree_insts.first();
                        dlog_batch_end();
                        dlog_batch_begin();
                        dlog(&format!(
                            "[pv] trees {}/{} shapes uploaded ({} verts) x {} placements; first=({},{}) near={} mid={} far={}",
                            ok,
                            tree_bufs.len(),
                            shape_verts,
                            tree_insts.len(),
                            first.map(|i| i.x).unwrap_or(-1),
                            first.map(|i| i.z).unwrap_or(-1),
                            first.map(|i| i.near).unwrap_or(0),
                            first.map(|i| i.mid).unwrap_or(0),
                            first.map(|i| i.far).unwrap_or(0),
                        ));
                    }
                }
                dlog(&format!(
                    "[pv] strips total spans={} ~{}KB",
                    strip_infos.len(),
                    strip_verts_kb,
                ));
                let strips_ms = now_ms().wrapping_sub(t_strips);
                let t_tex = now_ms();
                // Pre-warm the pages this map will ask for: decoding + uploading
                // mid-frame is what causes the hitch the first time a sprite or
                // the dialogue box appears.
                if page_tex.len() < pak_static.atlases.len() {
                    page_tex.resize_with(pak_static.atlases.len(), || None);
                }
                let mut warmed = 0;
                for (pi, pg) in pak_static.atlases.iter().enumerate() {
                    if pg.kind != atlas_kind::UI && pg.kind != atlas_kind::SPRITES { continue; }
                    if page_tex[pi].is_some() { continue; }
                    let (data, ptw, pth) = build_page_tex(pak_static, pi as u16, -1);
                    if let Ok(mut t) = texture::Texture::new(
                        texture::TextureParameters::new_2d(ptw as u16, pth as u16, texture::ColorFormat::Rgba8)) {
                        if t.load_image(&data, texture::Face::default()).is_ok() {
                            unsafe { gsp_flush(data.as_ptr(), data.len() as u32); }
                            sprite_filter(&mut t, pak_static, pi as u16);
                            page_tex[pi] = Some(t);
                            warmed += 1;
                        }
                    }
                }
                let mut t = texture::Texture::new(
                    texture::TextureParameters::new_2d(geom.tw as u16, geom.th as u16, texture::ColorFormat::Rgba8),
                ).expect("tex");
                t.load_image(&geom.tex_rgba, texture::Face::default()).expect("upload");
                t.set_filter(texture::Filter::Nearest, texture::Filter::Nearest);
                tex = Some(t);
                // GPU has its own copies now; free the CPU-side staging memory
                // so QuickJS has room for its heap.
                geom.tex_rgba = Vec::new();
                geom.tex_rgba.shrink_to_fit();
                geom.verts = Vec::new();
                geom.verts.shrink_to_fit();
                dist = geom.size * 1.4;
                {
                    let tex_ms = now_ms().wrapping_sub(t_tex);
                    let total = now_ms().wrapping_sub(t_load);
                    let (js, pk) = unsafe { (LOAD_JS_MS, LOAD_PAK_MS) };
                    dlog(&format!(
                        "[pv] load {}: js {} pak {} | bounds {} build+upload {} strips {} tex {} | host {} ms{}",
                        map_index.get(map_i).map(|(_, n)| n.as_str()).unwrap_or("?"),
                        js, pk, bounds_ms,
                        t_strips.wrapping_sub(t_load).wrapping_sub(bounds_ms),
                        strips_ms, tex_ms, total,
                        if unsafe { LEGACY_ZONE } { " (forest zone: unchanged path)" } else { "" },
                    ));
                    unsafe {
                        LOAD_JS_MS = 0;
                        LOAD_PAK_MS = 0;
                    }
                }
            }
            center = geom.center;
        }

        if guest_drive {
            // The C-stick's four directions are ordinary keypad bits, so no
            // extra service to start; the analog read would be irrstCstick-
            // Read, which hidCstickRead is only a macro for. Rate, not
            // position: holding it keeps turning.
            let sc = unsafe { voxel::scene() };
            let in_battle = sc.battle.active;
            let tau = core::f32::consts::PI * 2.0;
            // The OPTION screen's CAMERA SPEED (spec `camSpeed`), a Q8
            // multiplier on every rate the stick drives below.
            let sens = sc.cam_speed_q8 as f32 / 256.0;

            if in_battle {
                // The battle camera always swings, whatever the overworld
                // mode -- a staged arena is worth walking round. Its offset
                // is its own and does not survive the fight.
                if k.contains(KeyPad::CSTICK_LEFT)  { btl_yaw_off -= 0.035 * sens; }
                if k.contains(KeyPad::CSTICK_RIGHT) { btl_yaw_off += 0.035 * sens; }
                if k.contains(KeyPad::CSTICK_UP)    { btl_pitch_off += 0.025 * sens; }
                if k.contains(KeyPad::CSTICK_DOWN)  { btl_pitch_off -= 0.025 * sens; }
                if k.contains(KeyPad::ZL) && k.contains(KeyPad::ZR) {
                    btl_yaw_off = 0.0;
                    btl_pitch_off = 0.0;
                }
                btl_pitch_off = draw::clamp_pitch_off(sc, btl_pitch_off);
                btl_yaw_off = btl_yaw_off.rem_euclid(tau);
                sc.cam_yaw_off = btl_yaw_off;
                sc.cam_pitch_off = btl_pitch_off;
                was_in_battle = true;
            } else {
                if was_in_battle {
                    // Back on the map: the arena's swing goes, the
                    // overworld's own camera comes back exactly as it was.
                    btl_yaw_off = 0.0;
                    btl_pitch_off = 0.0;
                    was_in_battle = false;
                }

                // ZL/ZR cycle the mode (L and R are the Kantogear's tabs);
                // both together recentre whichever camera is up.
                if k.contains(KeyPad::ZL) && k.contains(KeyPad::ZR) {
                    cam_yaw_off = 0.0;
                    cam_pitch_off = 0.0;
                    cam_rig_pitch = pocketvoxel_core::cam::FREE_PITCH_DEFAULT;
                } else if d.contains(KeyPad::ZR) || d.contains(KeyPad::ZL) {
                    let n = CAM_MODES.len();
                    cam_mode = if d.contains(KeyPad::ZR) {
                        (cam_mode + 1) % n
                    } else {
                        (cam_mode + n - 1) % n
                    };
                    let m = &CAM_MODES[cam_mode];
                    // Onto a free rung: start looking the way the camera was,
                    // so the world does not spin round under the switch.
                    if m.rig != 0 {
                        cam_rig_yaw = walk_yaw;
                        cam_rig_pitch = pocketvoxel_core::cam::FREE_PITCH_DEFAULT;
                    }
                    // The orbit's pitch rung: the mode's own, or ours for
                    // ours. Tweened from wherever it is, so it never snaps.
                    let want = m.rung.unwrap_or(OURS_RUNG);
                    if m.rig == 0 && sc.pitch_rung != want {
                        sc.pitch_from_deg = sc.pitch_deg();
                        sc.pitch_rung = want;
                        sc.pitch_t = 0;
                    }
                    dlog(&format!("[pv] camera mode {}", m.name));
                }

                let m = &CAM_MODES[cam_mode];
                if m.rig != 0 {
                    // 1ST / 3RD steer their own attitude at the mod's rates,
                    // about twice the orbit's. Pushing up looks up.
                    if k.contains(KeyPad::CSTICK_LEFT)  { cam_rig_yaw -= RIG_YAW_RATE * sens; }
                    if k.contains(KeyPad::CSTICK_RIGHT) { cam_rig_yaw += RIG_YAW_RATE * sens; }
                    if k.contains(KeyPad::CSTICK_UP)    { cam_rig_pitch -= RIG_PITCH_RATE * sens; }
                    if k.contains(KeyPad::CSTICK_DOWN)  { cam_rig_pitch += RIG_PITCH_RATE * sens; }
                    cam_rig_pitch = pocketvoxel_core::cam::clamp_free_pitch(cam_rig_pitch);
                    cam_rig_yaw = cam_rig_yaw.rem_euclid(tau);
                    // The rig is the camera; the orbit's swing must not be
                    // laid on top of it, or it gets spun about its focus.
                    sc.cam_yaw_off = 0.0;
                    sc.cam_pitch_off = 0.0;
                    // Forward is where the camera looks.
                    walk_yaw = cam_rig_yaw;
                } else if m.rung.is_some() {
                    // A fixed angle is fixed: no swing, the stick does
                    // nothing, and forward is straight up the screen.
                    sc.cam_yaw_off = 0.0;
                    sc.cam_pitch_off = 0.0;
                    walk_yaw = 0.0;
                } else {
                    // Ours, exactly as it was.
                    if k.contains(KeyPad::CSTICK_LEFT)  { cam_yaw_off -= 0.035 * sens; }
                    if k.contains(KeyPad::CSTICK_RIGHT) { cam_yaw_off += 0.035 * sens; }
                    if k.contains(KeyPad::CSTICK_UP)    { cam_pitch_off += 0.025 * sens; }
                    if k.contains(KeyPad::CSTICK_DOWN)  { cam_pitch_off -= 0.025 * sens; }
                    // Held against the limit, the offset must not keep
                    // winding: clamp to what this camera can take, so the
                    // stick stops at the ground and reverses at once.
                    cam_pitch_off = draw::clamp_pitch_off(sc, cam_pitch_off);
                    cam_yaw_off = cam_yaw_off.rem_euclid(tau);
                    sc.cam_yaw_off = cam_yaw_off;
                    sc.cam_pitch_off = cam_pitch_off;
                    walk_yaw = cam_yaw_off;
                }
                sc.cam_rig = m.rig;
                sc.cam_rig_yaw = cam_rig_yaw;
                sc.cam_rig_pitch = cam_rig_pitch;
                sc.cam_rig_zoom = 1.0;
            }
        }
        if !guest_drive {
        if k.contains(KeyPad::DPAD_LEFT)  { yaw -= 0.04; }
        if k.contains(KeyPad::DPAD_RIGHT) { yaw += 0.04; }
        if k.contains(KeyPad::DPAD_UP)    { pitch += 0.03; }
        if k.contains(KeyPad::DPAD_DOWN)  { pitch -= 0.03; }
        if k.contains(KeyPad::A) { dist *= 0.97; }
        if k.contains(KeyPad::B) { dist *= 1.03; }
        }
        pitch = pitch.clamp(0.05, 1.5);

        let c = center;
        let eye = FVec3::new(
            c[0] + dist * yaw.sin() * pitch.cos(),
            c[1] + dist * pitch.sin(),
            c[2] + dist * yaw.cos() * pitch.cos(),
        );
        let camera = Matrix4::looking_at(
            eye,
            FVec3::new(c[0], c[1], c[2]),
            FVec3::new(0.0, 1.0, 0.0),
            CoordinateOrientation::RightHanded,
        );
        let slider = ctru::os::current_3d_slider_state();
        perf_slider = slider;
        let (sl, sr) = StereoDisplacement::new(slider * dist * 0.03, dist);
        let (pl, pr) = Projection::perspective(
            world_fov(),
            AspectRatio::TopScreen,
            ClipPlanes { near: 1.0, far: 100000.0 },
        ).stereo_matrices(sl, sr);
        let mut mvp_l = pl * camera;
        let mut mvp_r = pr * camera;
        let mut card_groups: Vec<(u16, Vec<CardVertex>)> = Vec::new();
        let mut ui_verts: Vec<Vertex> = Vec::new();
        let mut pic_groups: Vec<(u16, i16, Vec<Vertex>)> = Vec::new();
        // Move animation tiles, grouped by the sheet they come from.
        let mut anim_groups: Vec<(u16, Vec<Vertex>)> = Vec::new();
        let mut ui_page: u16 = 0;
        // The guest camera's real eye/focus (list.cam below) — captured here
        // so the chunk-visibility cull further down can use it instead of
        // `center`/the debug-orbit `eye` above. During overworld play those
        // two roughly coincide (both ultimately come from the player's own
        // position), so the mismatch went unnoticed; a battle's camera
        // frames the ARENA instead, which the staging search can place
        // several cells from where the player was standing, and cull/view-
        // cone tests still keyed on the player's spot could exclude the
        // very chunk the battle camera is looking at — the reported void
        // under the battling Pokémon.
        let mut guest_eye_focus: Option<(FVec3, FVec3)> = None;
        // The live scene tint, for the two things build_map's baked-in copy
        // can't reach: the sky clear below and the entity cards built in
        // this same block. All three have to agree or a dark cave only
        // half-darkens.
        let scene_tint = unsafe { voxel::scene() }.tint;
        // A battle's camera sits back from a fixed arena and can't dodge
        // whatever's in between the way the free-roam camera dodges by
        // following the player — a house or a tall tree between the eye and
        // the arena just sits there blocking it every frame. Below (the
        // chunk draw loop), `in_battle` gates an extra real line-of-sight
        // cull against segment_hits_box, on top of the ordinary view-cone
        // cull every camera gets.
        let in_battle = unsafe { voxel::scene() }.battle.active;
        // Slot 0's strip offset, to put the sightline back in the terrain
        // buffer's frame — see occlude_seg below.
        let (slot_ox, slot_oy) = {
            let sl = unsafe { &voxel::scene().maps[0] };
            if sl.shown { (sl.ox as f32, sl.oy as f32) } else { (0.0, 0.0) }
        };
        let tint_b = [
            (scene_tint & 0xff) as u8,
            ((scene_tint >> 8) & 0xff) as u8,
            ((scene_tint >> 16) & 0xff) as u8,
            255,
        ];
        if guest_drive {
            let list = unsafe { draw::build(voxel::scene(), pak_static) };
            // Use the game's eye/focus with OUR projection: importing the
            // PSP VP directly clips (different depth range + screen tilt).
            let (sox, soy) = {
                let sl = unsafe { &voxel::scene().maps[0] };
                if sl.shown { (sl.ox as f32, sl.oy as f32) } else { (0.0, 0.0) }
            };
            // Already swung: draw::camera applied the scene's offsets, so
            // this is the eye actually being drawn from, and the cull can be
            // handed the very same one.
            let e = list.cam.eye;
            let f = list.cam.focus;
            guest_eye_focus = Some((FVec3::new(e.x, e.y, e.z), FVec3::new(f.x, f.y, f.z)));
            // A top-down eye makes up=(0,1,0) degenerate (cross product -> 0),
            // which yields a garbage matrix and an empty screen. Use -Z as up
            // when the view is near-vertical.
            let dx = f.x - e.x; let dy = f.y - e.y; let dz = f.z - e.z;
            let horiz = (dx * dx + dz * dz).sqrt();
            let up = if horiz < 0.001 * dy.abs() {
                FVec3::new(0.0, 0.0, -1.0)
            } else {
                FVec3::new(0.0, 1.0, 0.0)
            };
            let gcam = Matrix4::looking_at(
                FVec3::new(e.x, e.y, e.z),
                FVec3::new(f.x, f.y, f.z),
                up,
                CoordinateOrientation::RightHanded,
            );
            dbg_tick += 1;
            mvp_l = pl * gcam;
            mvp_r = pr * gcam;
            // Title screen and Oak's speech own the whole frame; the guest
            // still emits the player's overworld card, so drop it there.
            let pic_active_scan = list.items.iter().any(|i| matches!(i, Item::ScreenPic { .. }));
            for it in list.items.iter() {
                if let Item::ScreenPic { x, y, w, h, page, depth_q8 } = it {
                    let pg = &pak_static.atlases[*page as usize];
                    // Via page_tex_size / page_prescale rather than po2 of the
                    // source: the content fills w * prescale texels of the
                    // uploaded surface, not w. A no-op while pics are not
                    // prescaled, and correct if they ever are.
                    let (pw, ph) = page_tex_size(pg);
                    let s = page_prescale(pg) as f32;
                    let (u1, v1) = (pg.w as f32 * s / pw, pg.h as f32 * s / ph);
                    let (x0, y0) = (qpx(*x), qpx(*y));
                    let (x1, y1) = (qpx(*x + *w), qpx(*y + *h));
                    let mp = |px: i16, py: i16, u: f32, v: f32| Vertex {
                        pos: [px, py, 0, 0], color: [255, 255, 255, 255], uv: [u, v] };
                    // Grouped by page AND by pop: a picture standing out
                    // of the screen is drawn in its own pass, shifted the
                    // other way for each eye.
                    let gi = match pic_groups.iter().position(|g| g.0 == *page && g.1 == *depth_q8) {
                        Some(i) => i,
                        None => {
                            pic_groups.push((*page, *depth_q8, Vec::new()));
                            pic_groups.len() - 1
                        }
                    };
                    let gv = &mut pic_groups[gi].2;
                    gv.push(mp(x0, y0, 0.0, 1.0));
                    gv.push(mp(x1, y0, u1, 1.0));
                    gv.push(mp(x1, y1, u1, 1.0 - v1));
                    gv.push(mp(x0, y0, 0.0, 1.0));
                    gv.push(mp(x1, y1, u1, 1.0 - v1));
                    gv.push(mp(x0, y1, 0.0, 1.0 - v1));
                }
                if let Item::AnimQuad { x, y, w, h, page, tile, flip_x, flip_y } = it {
                    // Same placement as a UI tile, with the flips the
                    // original animations spend half their time doing.
                    //
                    // NOT ui_tile_uv: that reads the UI sheet's repacked
                    // cell-with-a-gutter layout, and an animation sheet is a
                    // sprite page, uploaded as-is (page_layout_dims) and
                    // padded to a power of two at the bottom right. So the
                    // tiles are a plain 8x8 grid, and v counts down from 1
                    // the way a pic's does.
                    let pg = &pak_static.atlases[*page as usize];
                    let cols = (pg.w as u32 / UI_CELL).max(1) as u16;
                    let (pw, ph) = page_tex_size(pg);
                    let sc = page_prescale(pg) as f32;
                    let cell = UI_CELL as f32 * sc;
                    let tx = (*tile % cols) as f32 * cell;
                    let ty = (*tile / cols) as f32 * cell;
                    let (mut u0, mut u1) = (tx / pw, (tx + cell) / pw);
                    let (mut v0, mut v1) = (1.0 - ty / ph, 1.0 - (ty + cell) / ph);
                    if *flip_x {
                        core::mem::swap(&mut u0, &mut u1);
                    }
                    if *flip_y {
                        core::mem::swap(&mut v0, &mut v1);
                    }
                    let (x0, y0) = (qpx(*x), qpx(*y));
                    let (x1, y1) = (qpx(*x + *w), qpx(*y + *h));
                    let ma = |px: i16, py: i16, u: f32, v: f32| Vertex {
                        pos: [px, py, 0, 0], color: [255, 255, 255, 255], uv: [u, v] };
                    let gi = match anim_groups.iter().position(|g| g.0 == *page) {
                        Some(i) => i,
                        None => { anim_groups.push((*page, Vec::new())); anim_groups.len() - 1 }
                    };
                    let gv = &mut anim_groups[gi].1;
                    gv.push(ma(x0, y0, u0, v0));
                    gv.push(ma(x1, y0, u1, v0));
                    gv.push(ma(x1, y1, u1, v1));
                    gv.push(ma(x0, y0, u0, v0));
                    gv.push(ma(x1, y1, u1, v1));
                    gv.push(ma(x0, y1, u0, v1));
                }
                if let Item::UiQuad { x, y, w, h, page, tile } = it {
                    ui_page = *page;
                    let pg = &pak_static.atlases[*page as usize];
                    // Tile indices count cells in the atlas's real width; the
                    // UVs address the gutter-repacked surface.
                    let cols = ((pg.w as u32 / UI_CELL) as u16).max(1);
                    let (pw, ph) = page_tex_size(pg);
                    let (u0, u1, v0, v1) = ui_tile_uv(*tile, cols, pw, ph, page_prescale(pg));
                    let (x0, y0) = (qpx(*x), qpx(*y));
                    let (x1, y1) = (qpx(*x + *w), qpx(*y + *h));
                    let m2 = |px: i16, py: i16, u: f32, v: f32| Vertex {
                        pos: [px, py, 0, 0], color: [255, 255, 255, 255], uv: [u, v] };
                    ui_verts.push(m2(x0, y0, u0, v0));
                    ui_verts.push(m2(x1, y0, u1, v0));
                    ui_verts.push(m2(x1, y1, u1, v1));
                    ui_verts.push(m2(x0, y0, u0, v0));
                    ui_verts.push(m2(x1, y1, u1, v1));
                    ui_verts.push(m2(x0, y1, u0, v1));
                }
                if pic_active_scan { continue; }
                if let Item::Card { verts, page, uv, mirror, pull } = it {
                    let pg = &pak_static.atlases[*page as usize];
                    // As ScreenPic above: the content fills w * prescale of
                    // the uploaded surface.
                    let (pw, ph) = page_tex_size(pg);
                    let s = page_prescale(pg) as f32;
                    let (sx, sy) = (pg.w as f32 * s / pw, pg.h as f32 * s / ph);
                    let (mut u0, v0, mut u1, v1) = (uv[0], uv[1], uv[2], uv[3]);
                    if *mirror { core::mem::swap(&mut u0, &mut u1); }
                    let q = [(verts[0], u0, v1), (verts[1], u1, v1),
                             (verts[2], u1, v0), (verts[3], u0, v0)];
                    let pv = *pull;
                    let disp = |q: [f32; 3]| -> [f32; 3] {
                        let (dx, dy, dz) = (e.x - q[0], e.y - q[1], e.z - q[2]);
                        let l = (dx * dx + dy * dy + dz * dz).sqrt().max(1e-6);
                        [q[0] + dx / l * pv, q[1] + dy / l * pv, q[2] + dz / l * pv]
                    };
                    let mk = |pt: ([f32; 3], f32, f32)| CardVertex {
                        // Unrounded, on purpose -- see CardVertex.
                        pos: { let d = disp(pt.0);
                               [d[0] - sox + 8.0, d[1], d[2] - soy + 8.0] },
                        // tint_b, not opaque white: a card standing on
                        // terrain build_map dimmed has to dim with it.
                        color: tint_b,
                        uv: [pt.1 * sx, 1.0 - pt.2 * sy],
                    };
                    let gi = match card_groups.iter().position(|g| g.0 == *page) {
                        Some(i) => i,
                        None => { card_groups.push((*page, Vec::new())); card_groups.len() - 1 }
                    };
                    let gv = &mut card_groups[gi].1;
                    gv.push(mk(q[0])); gv.push(mk(q[1])); gv.push(mk(q[2]));
                    gv.push(mk(q[0])); gv.push(mk(q[2])); gv.push(mk(q[3]));
                }
            }
        }
        let vs = geom.ah as f32 / geom.th as f32;
        let us = geom.aw as f32 / geom.tw as f32;
        let uvx = FVec4::new(us, -vs, 0.0, 1.0);
if page_tex.len() < pak_static.atlases.len() {
            page_tex.resize_with(pak_static.atlases.len(), || None);
        }
        for (pg, _) in card_groups.iter() {
            let i = *pg as usize;
            if i < page_tex.len() && page_tex[i].is_none() {
                let (data, ptw, pth) = build_page_tex(pak_static, *pg, -1);
                if let Ok(mut t) = texture::Texture::new(
                    texture::TextureParameters::new_2d(ptw as u16, pth as u16, texture::ColorFormat::Rgba8)) {
                    if t.load_image(&data, texture::Face::default()).is_ok() {
                        unsafe { gsp_flush(data.as_ptr(), data.len() as u32); }
                        sprite_filter(&mut t, pak_static, *pg);
                        page_tex[i] = Some(t);
                    }
                }
            }
        }
        let card_bufs: Vec<(usize, buffer::Info)> = card_groups.iter().filter_map(|(pg, v)| {
            if v.is_empty() { return None; }
            let mut bi = buffer::Info::new();
            let n = v.len().min(65535);
            bi.add(buffer::Buffer::new(&v[..n]), card_attr.permutation()).ok()?;
            Some((*pg as usize, bi))
        }).collect();
        if guest_drive && dbg_tick % 60 == 0 {
            let pgx = &pak_static.atlases[ui_page as usize];
        }
        if guest_drive && dbg_tick % 30 == 0 {
            let sc3 = unsafe { voxel::scene() };
            let n = sc3.ents.iter().filter(|e| e.shown).count();
        }
        let ui_pg = ui_page as usize;
        if !ui_verts.is_empty() && ui_pg < page_tex.len() && page_tex[ui_pg].is_none() {
            let (data, ptw, pth) = build_page_tex(pak_static, ui_page, -1);
            if let Ok(mut t) = texture::Texture::new(
                texture::TextureParameters::new_2d(ptw as u16, pth as u16, texture::ColorFormat::Rgba8)) {
                if t.load_image(&data, texture::Face::default()).is_ok() {
                    sprite_filter(&mut t, pak_static, ui_page);
                    page_tex[ui_pg] = Some(t);
                }
            }
        }
        if page_tex.len() < pak_static.atlases.len() {
            page_tex.resize_with(pak_static.atlases.len(), || None);
        }
        for pg in pic_groups.iter().map(|g| &g.0).chain(anim_groups.iter().map(|g| &g.0)) {
            let i = *pg as usize;
            if i < page_tex.len() && page_tex[i].is_none() {
                let (data, ptw, pth) = build_page_tex(pak_static, *pg, -1);
                if let Ok(mut t) = texture::Texture::new(
                    texture::TextureParameters::new_2d(ptw as u16, pth as u16, texture::ColorFormat::Rgba8)) {
                    if t.load_image(&data, texture::Face::default()).is_ok() {
                        unsafe { gsp_flush(data.as_ptr(), data.len() as u32); }
                        sprite_filter(&mut t, pak_static, *pg);
                        page_tex[i] = Some(t);
                    }
                }
            }
        }
        let pic_bufs: Vec<(usize, i16, buffer::Info)> = pic_groups.iter()
            .filter_map(|(pg, depth, v)| {
                if v.is_empty() { return None; }
                let mut bi = buffer::Info::new();
                let n = v.len().min(65535);
                bi.add(buffer::Buffer::new(&v[..n]), attr_info.permutation()).ok()?;
                Some((*pg as usize, *depth, bi))
            }).collect();
        let anim_bufs: Vec<(usize, buffer::Info)> = anim_groups.iter().filter_map(|(pg, v)| {
            if v.is_empty() { return None; }
            let mut bi = buffer::Info::new();
            let n = v.len().min(65535);
            bi.add(buffer::Buffer::new(&v[..n]), attr_info.permutation()).ok()?;
            Some((*pg as usize, bi))
        }).collect();
        let ui_buf: Option<buffer::Info> = if ui_verts.is_empty() { None } else {
            let mut bi = buffer::Info::new();
            let n = ui_verts.len().min(65535);
            bi.add(buffer::Buffer::new(&ui_verts[..n]), attr_info.permutation()).ok();
            Some(bi)
        };
        // Kanto Gear: build the companion (bottom) UI verts from scene.ui_b.
        // Same glyph atlas as the top UI, but laid out in true bottom-screen
        // space — the 20x18 grid stretched to fill the whole 320x240 panel.
        // Rendered with a 0..320 ortho in the frame closure below.
        let mut ui_b_verts: Vec<Vertex> = Vec::new();
        let mut ui_b_light_verts: Vec<Vertex> = Vec::new();
        let mut ui_b_dim_verts: Vec<Vertex> = Vec::new();
        let mut ui_b_bar_verts: Vec<Vertex> = Vec::new();
        // Companion sprites (party mon icons etc), grouped by atlas page like
        // pic_groups/card_groups — see scene.ui_b_sprites.
        let mut ui_b_sprite_groups: Vec<(u16, Vec<Vertex>)> = Vec::new();
        {
            let sc = unsafe { voxel::scene() };
            let pg = &pak_static.atlases[ui_b_page];
            let cols = ((pg.w as u32 / UI_CELL) as u16).max(1);
            let (pw, ph) = page_tex_size(pg);
            // Fill the full 320x240 bottom screen — 20 cols across 320 and 18
            // rows down 240. The GB source is 10:9 and the panel 4:3, so this is
            // the same horizontal stretch the real mod gets on a 4:3 screen; the
            // bar and content now reach both edges instead of sitting centred.
            let tpxx = 320.0 / UI_COLS as f32;
            let tpxy = 240.0 / UI_ROWS as f32;
            // Kanto Gear palette: dark glyphs on the light clear. Two per-cell
            // high bits change that:
            //   LIGHT_BIT (0x8000) -> glyph drawn LIGHT (light strokes, no fill);
            //                         for text on the dark header bar.
            //   FILL_BIT  (0x4000) -> the cell gets a solid DARK quad AND its
            //                         glyph is drawn LIGHT; i.e. an inverted cell
            //                         (dark box, light text) like the mod's
            //                         selected battle option.
            //   DARKTEXT_BIT (0x2000) -> dark glyph on the light clear with NO
            //                         opaque cell (via stage_on_light), so
            //                         unselected labels/borders don't get a
            //                         dark-green "highlight" box behind them.
            // Light glyphs go to their own buffer (drawn with stage_text so the
            // colour is flat-tinted); dark glyphs keep the modulate path.
            const DARK: [u8; 4] = [15, 56, 15, 255]; //  0x0F380F
            const LIGHT: [u8; 4] = [155, 188, 15, 255]; // 0x9BBC0F (= clear)
            const LIGHT_BIT: u16 = 0x8000;
            const FILL_BIT: u16 = 0x4000;
            const DARKTEXT_BIT: u16 = 0x2000;
            // Solid top-bar fill. Emitted into its OWN buffer (ui_b_bar_verts)
            // and drawn with a REPLACE -> PrimaryColor texenv below, so the strip
            // is a flat DARK quad that doesn't depend on any atlas texel being
            // opaque-white (the old HUD_BAR_FULL centre-sample read too dark).
            // Rows 0..bar_rows get the bar behind the header; UVs are ignored.
            let bar_rows: usize = 1;
            {
                let (bx0, by0) = (0i16, 0i16);
                let (bx1, by1) = (320i16, (tpxy * bar_rows as f32) as i16);
                let bar = |px: i16, py: i16| Vertex { pos: [px, py, 0, 0], color: DARK, uv: [0.0, 0.0] };
                ui_b_bar_verts.push(bar(bx0, by0)); ui_b_bar_verts.push(bar(bx1, by0)); ui_b_bar_verts.push(bar(bx1, by1));
                ui_b_bar_verts.push(bar(bx0, by0)); ui_b_bar_verts.push(bar(bx1, by1)); ui_b_bar_verts.push(bar(bx0, by1));
            }
            for cy in 0..UI_ROWS {
                for cx in 0..UI_COLS {
                    let raw = sc.ui_b[cy * UI_COLS + cx];
                    if raw == 0 { continue; }
                    let is_light = raw & (LIGHT_BIT | FILL_BIT) != 0;
                    let is_fill = raw & FILL_BIT != 0;
                    let is_dim = raw & DARKTEXT_BIT != 0;
                    let color = if is_light { LIGHT } else { DARK };
                    let tile = raw & !(LIGHT_BIT | FILL_BIT | DARKTEXT_BIT);
                    let (u0, u1, v0, v1) = ui_tile_uv(tile, cols, pw, ph, page_prescale(pg));
                    let x0 = (cx as f32 * tpxx) as i16;
                    let y0 = (cy as f32 * tpxy) as i16;
                    let x1 = ((cx + 1) as f32 * tpxx) as i16;
                    let y1 = ((cy + 1) as f32 * tpxy) as i16;
                    // Inverted cell: a solid DARK quad behind the glyph, drawn on
                    // the flat (REPLACE) path with the bar so it's atlas-proof.
                    if is_fill {
                        let f = |px: i16, py: i16| Vertex { pos: [px, py, 0, 0], color: DARK, uv: [0.0, 0.0] };
                        ui_b_bar_verts.push(f(x0, y0)); ui_b_bar_verts.push(f(x1, y0)); ui_b_bar_verts.push(f(x1, y1));
                        ui_b_bar_verts.push(f(x0, y0)); ui_b_bar_verts.push(f(x1, y1)); ui_b_bar_verts.push(f(x0, y1));
                    }
                    let m = |px: i16, py: i16, u: f32, v: f32| Vertex {
                        pos: [px, py, 0, 0], color, uv: [u, v] };
                    let dst = if is_light {
                        &mut ui_b_light_verts
                    } else if is_dim {
                        &mut ui_b_dim_verts
                    } else {
                        &mut ui_b_verts
                    };
                    dst.push(m(x0, y0, u0, v0));
                    dst.push(m(x1, y0, u1, v0));
                    dst.push(m(x1, y1, u1, v1));
                    dst.push(m(x0, y0, u0, v0));
                    dst.push(m(x1, y1, u1, v1));
                    dst.push(m(x0, y1, u0, v1));
                }
            }
            // Companion sprites: whole atlas pages scaled into a rect, native
            // 320x240 bottom-screen pixel space (the ortho below matches it
            // exactly, so no 480->400/272->240 rescale like ScreenPic needs).
            // UV/winding copied from Item::ScreenPic — same V-flip, so pages
            // render upright — but grouped by page here (not by Item) since
            // ui_b_sprites is a flat Scene array, not a DrawList.
            for i in 0..(sc.ui_b_sprite_n as usize).min(UI_B_SPRITES_MAX) {
                let spr = &sc.ui_b_sprites[i];
                if spr.w <= 0 || spr.h <= 0 { continue; }
                let spg = &pak_static.atlases[spr.page as usize];
                let (spw, sph) = (po2(spg.w as u32) as f32, po2(spg.h as u32) as f32);
                let (su1, sv1) = (spg.w as f32 / spw, spg.h as f32 / sph);
                let (sx0, sy0) = (spr.x, spr.y);
                let (sx1, sy1) = (spr.x + spr.w, spr.y + spr.h);
                let sm = |px: i16, py: i16, u: f32, v: f32| Vertex {
                    pos: [px, py, 0, 0], color: [255, 255, 255, 255], uv: [u, v] };
                let gi = match ui_b_sprite_groups.iter().position(|g| g.0 == spr.page) {
                    Some(gi) => gi,
                    None => { ui_b_sprite_groups.push((spr.page, Vec::new())); ui_b_sprite_groups.len() - 1 }
                };
                let gv = &mut ui_b_sprite_groups[gi].1;
                gv.push(sm(sx0, sy0, 0.0, 1.0));
                gv.push(sm(sx1, sy0, su1, 1.0));
                gv.push(sm(sx1, sy1, su1, 1.0 - sv1));
                gv.push(sm(sx0, sy0, 0.0, 1.0));
                gv.push(sm(sx1, sy1, su1, 1.0 - sv1));
                gv.push(sm(sx0, sy1, 0.0, 1.0 - sv1));
            }
        }
        let ui_b_dim_buf: Option<buffer::Info> = if ui_b_dim_verts.is_empty() { None } else {
            let mut bi = buffer::Info::new();
            let n = ui_b_dim_verts.len().min(65535);
            bi.add(buffer::Buffer::new(&ui_b_dim_verts[..n]), attr_info.permutation()).ok();
            Some(bi)
        };
        let ui_b_buf: Option<buffer::Info> = if ui_b_verts.is_empty() { None } else {
            let mut bi = buffer::Info::new();
            let n = ui_b_verts.len().min(65535);
            bi.add(buffer::Buffer::new(&ui_b_verts[..n]), attr_info.permutation()).ok();
            Some(bi)
        };
        let ui_b_light_buf: Option<buffer::Info> = if ui_b_light_verts.is_empty() { None } else {
            let mut bi = buffer::Info::new();
            let n = ui_b_light_verts.len().min(65535);
            bi.add(buffer::Buffer::new(&ui_b_light_verts[..n]), attr_info.permutation()).ok();
            Some(bi)
        };
        let ui_b_bar_buf: Option<buffer::Info> = if ui_b_bar_verts.is_empty() { None } else {
            let mut bi = buffer::Info::new();
            let n = ui_b_bar_verts.len().min(65535);
            bi.add(buffer::Buffer::new(&ui_b_bar_verts[..n]), attr_info.permutation()).ok();
            Some(bi)
        };
        // Companion sprite pages load through the same lazy page_tex cache as
        // cards/pics (GB-green palette via build_page_tex(.., -1), matching
        // the battle cards).
        for (pg, _) in ui_b_sprite_groups.iter() {
            let i = *pg as usize;
            if i < page_tex.len() && page_tex[i].is_none() {
                let (data, ptw, pth) = build_page_tex(pak_static, *pg, -1);
                if let Ok(mut t) = texture::Texture::new(
                    texture::TextureParameters::new_2d(ptw as u16, pth as u16, texture::ColorFormat::Rgba8)) {
                    if t.load_image(&data, texture::Face::default()).is_ok() {
                        unsafe { gsp_flush(data.as_ptr(), data.len() as u32); }
                        sprite_filter(&mut t, pak_static, *pg);
                        page_tex[i] = Some(t);
                    }
                }
            }
        }
        let ui_b_sprite_bufs: Vec<(usize, buffer::Info)> = ui_b_sprite_groups.iter().filter_map(|(pg, v)| {
            if v.is_empty() { return None; }
            let mut bi = buffer::Info::new();
            let n = v.len().min(65535);
            bi.add(buffer::Buffer::new(&v[..n]), attr_info.permutation()).ok()?;
            Some((*pg as usize, bi))
        }).collect();
        let page_tex_ref = &page_tex;
        // Cull/view-cone focus: the guest camera's real focus/eye
        // (guest_eye_focus, captured above) when we have one, not `center`/
        // the debug-orbit `eye` — those are the player's walking position,
        // which a battle camera framing the arena can sit well away from.
        let (focus_x, focus_z) = match guest_eye_focus {
            Some((_, f)) => (f.x(), f.z()),
            None => (center[0], center[2]),
        };
        // How far from the player terrain is still kept, measured to the
        // chunk's NEAREST point (see the loop). Derived, not guessed: play
        // pitch is rung 2 = 35 deg (scene.ts host.pitch(2)), camera dist
        // WORLD_VIEW_H = 136, vertical FOV 2*atan(1/(2*CAM_FOCAL)) = 53.1
        // deg, top screen 400x240. That puts the eye 111 px up and 78 px
        // behind the player, and the far corners of the visible ground land
        // ~233 px out. 288 clears that with headroom for the camera leading
        // the player and for a pitch tween passing through.
        //
        // The old value was 240 compared against the chunk CENTRE with no
        // allowance for the chunk's own size, so a 128 px chunk whose
        // centre sat just past 240 was dropped while most of it was still
        // on screen — that is the pop-out. Huge maps are unaffected in
        // practice: their vertex budget already stops building geometry
        // well inside this radius, so widening it draws no more of them.
        // A stereo geometry diet lived here for one build (e3ef511) and is
        // gone because the hardware said it did nothing. Cutting the radius
        // to 0.8 and the tree ladder with it moved the GPU not at all:
        // across build 222452's CELADON frames the number sat at 53-64 ms
        // whether 18 chunks were drawn or 29, and whether 0 trees were drawn
        // or 26. Frame 61.1 ms at spans 18/87 trees 0/26 against frame
        // 53.3 ms at spans 29/87 trees 26/26 is the whole argument: MORE
        // geometry, LESS time. The cost is not the geometry, so a geometry
        // diet buys nothing and the draw distance was spent for free.
        const CULL_RADIUS_PX: f32 = 288.0;
        let cull_radius: f32 = if guest_drive { CULL_RADIUS_PX } else { 1.0e6 };
        // Tangent of the HORIZONTAL half-FOV: tan(atan(1/(2*CAM_FOCAL)))
        // scaled by the top screen's 400x240 aspect = 0.5 * 1.667 = 0.833,
        // plus 15% slack so the wedge test is generous rather than exact.
        const TAN_HHALF: f32 = 0.8333 * 1.15;
        const CONE_PAD: f32 = 24.0;
        // Camera height above the ground plane, which sets how wide the
        // view already is at the camera's own ground position.
        let cam_h: f32 = match guest_eye_focus {
            Some((e, f)) => (e.y() - f.y()).abs().max(1.0),
            None => 136.0,
        };
        let pic_active = !pic_groups.is_empty();        // View-cone cull: the radius test draws a full circle, but at this
        // pitch most of it is behind or outside the frustum.
        let (cull_eye_x, cull_eye_z) = match guest_eye_focus {
            Some((e, _)) => (e.x(), e.z()),
            None => (eye.x(), eye.z()),
        };
        let (eye_x, eye_z) = (cull_eye_x, cull_eye_z);
        let (mut fx, mut fz) = (focus_x - cull_eye_x, focus_z - cull_eye_z);
        let fl = (fx * fx + fz * fz).sqrt().max(1e-6);
        fx /= fl; fz /= fl;
        // The battle no-clip segment (segment_hits_box): the real 3D eye and
        // focus, not the XZ-flattened cull_eye/focus_x/z above, and only
        // when there's an actual battle camera to protect — the free-roam
        // camera already dodges obstructions by following the player.
        // draw::build works in world space WITH the map slot's strip offset
        // folded in (cell_centre adds slot0_offset); the terrain buffer's
        // vertices — and so the span bounds tested against — do not carry
        // it. main.rs already undoes this for the battle cards further up
        // (`d[0] - sox`); the segment has to be in the same frame or it
        // tests the sightline against the wrong chunks whenever slot 0 sits
        // at a nonzero offset.
        let occlude_seg: Option<(FVec3, FVec3, f32)> = if in_battle {
            guest_eye_focus.map(|(e, f)| {
                let e = FVec3::new(e.x() - slot_ox, e.y(), e.z() - slot_oy);
                let f = FVec3::new(f.x() - slot_ox, f.y(), f.z() - slot_oy);
                let (dx, dy, dz) = (f.x() - e.x(), f.y() - e.y(), f.z() - e.z());
                (e, f, (dx * dx + dy * dy + dz * dz).sqrt().max(1e-6))
            })
        } else {
            None
        };
        // No terrain texture means no map was ever built successfully (see
        // the "has no pak loaded" skip above). Sit the frame out rather
        // than unwrap into a panic: a still screen the HOME button can
        // escape beats a dead process.
        let Some(tex_ref) = tex.as_ref() else { continue };
        let infos_ref = &chunk_infos;
        let strips_ref = &strip_infos;
        let anim_ref = &anim_bufs;
        let tree_bufs_ref = &tree_bufs;
        let tree_insts_ref = &tree_insts;
        // Once a second: how many spans exist, how many survived the cull
        // last frame, and where the cull thinks the camera is. A map that
        // comes up as bare sky is either spans=0 (nothing built or nothing
        // uploaded) or drawn=0 (everything culled) — these two numbers say
        // which, which is otherwise unknowable on a device with no console.
        // Every second in the forest zone, as always; every ten elsewhere,
        // where it was three SD writes a second of nothing new.
        if dbg_tick % (if unsafe { LEGACY_ZONE } { 60 } else { 600 }) == 0 {
            dlog(&format!(
                "[pv] spans={} drawn={} trees={}/{} treecull(shape={} r={} cone={} err={}) cull(r={} cone={} occl={}) nearestCulled={:.0} focus=({:.0},{:.0}) eye=({:.0},{:.0}) fwd=({:.2},{:.2}) battle={} huge={}",
                infos_ref.len(),
                unsafe { DRAWN },
                unsafe { TREES_DRAWN },
                tree_insts_ref.len(),
                unsafe { TREES_CULLED[0] },
                unsafe { TREES_CULLED[1] },
                unsafe { TREES_CULLED[2] },
                unsafe { TREES_CULLED[3] },
                unsafe { CULL_RADIUS_N },
                unsafe { CULL_CONE_N },
                unsafe { CULL_OCCL_N },
                unsafe { MIN_CULLED_D },
                focus_x, focus_z, cull_eye_x, cull_eye_z, fx, fz,
                in_battle, cur_map_huge,
            ));
        }

        unsafe {
            extern "C" { fn osGetTime() -> u64; }
            // citro3d's own clocks: drawing is the GPU's time on the last
            // finished frame, processing the command-list build.
            extern "C" { fn C3D_GetDrawingTime() -> f32; fn C3D_GetProcessingTime() -> f32; }
            let (gd, gp) = (C3D_GetDrawingTime(), C3D_GetProcessingTime());
            let cpu = osGetTime().wrapping_sub(frame_start) as f32;
            perf_cpu_sum += cpu;
            if cpu > perf_cpu_max { perf_cpu_max = cpu; }
            perf_gpu_sum += gd;
            if gd > perf_gpu_max { perf_gpu_max = gd; }
            perf_proc_sum += gp;
            perf_n += 1;
        }
        // Culling is per FRAME, not per eye. Every test here reads the guest
        // camera's focus, eye and forward, which both eyes share, so the
        // right-eye pass used to re-run the identical loop over every span
        // and every tree instance and reach the identical answer. Decide
        // once, draw the survivors in each pass. (With the slider down this
        // is the same work in a different place; with it up it is half.)
        let (mut cull_r_n, mut cull_c_n, mut cull_o_n) = (0u32, 0u32, 0u32);
        let mut min_culled = f32::MAX;
        let vis_spans: Vec<_> = if pic_active {
            Vec::new()
        } else {
            infos_ref.iter().chain(strips_ref.iter()).filter_map(|(span, bi)| {
                let (bmin, bmax) = (&span.bmin, &span.bmax);
                let cx = (bmin[0] + bmax[0]) * 0.5;
                let cz = (bmin[2] + bmax[2]) * 0.5;
                let dx = cx - focus_x;
                let dz = cz - focus_z;
                // Measure to the chunk's nearest point, not its centre: a
                // 128 px chunk reaches ~90 px past its own centre, and
                // culling on the centre alone throws away chunks that are
                // still half on screen.
                let hx = (bmax[0] - bmin[0]) * 0.5;
                let hz = (bmax[2] - bmin[2]) * 0.5;
                let extent = (hx * hx + hz * hz).sqrt();
                let near = (dx * dx + dz * dz).sqrt() - extent;
                if near > cull_radius {
                    cull_r_n += 1;
                    if near < min_culled { min_culled = near; }
                    return None;
                }
                if guest_drive {
                    let vx = cx - eye_x;
                    let vz = cz - eye_z;
                    let along = vx * fx + vz * fz;
                    let side = (vx * fz - vz * fx).abs();
                    // Project the box onto the view axes instead of using
                    // its diagonal as a blanket pad: how far it reaches
                    // FORWARD sets how wide the wedge is across it, how far
                    // it reaches SIDEWAYS sets how much of that width it
                    // needs.
                    let fwd_half = (hx * fx).abs() + (hz * fz).abs();
                    let lat_half = (hx * fz).abs() + (hz * fx).abs();
                    let far = along + fwd_half;
                    // The view does NOT converge to a point at the eye: the
                    // camera sits cam_h above the ground, so the wedge is
                    // already cam_h*TAN_HHALF wide at the camera's own
                    // ground position and widens from there. Measuring at
                    // the box's FAR edge against its NEAREST side is what
                    // keeps a chunk whose inner edge is still on screen.
                    let half = (far * far + cam_h * cam_h).sqrt() * TAN_HHALF;
                    if far < -CONE_PAD || side - lat_half > half + CONE_PAD {
                        cull_c_n += 1;
                        if near < min_culled { min_culled = near; }
                        return None;
                    }
                }
                // The battle camera's no-clip, against this span's OWN bounds
                // and only for spans that leave no hole behind
                // (Span::occludable).
                if span.occludable {
                    if let Some((eye3, focus3, seg_len)) = occlude_seg {
                        if segment_hits_box(
                            eye3,
                            focus3,
                            seg_len,
                            BATTLE_OCCLUDE_MARGIN_PX,
                            span.gmin,
                            span.gmax,
                        ) {
                            cull_o_n += 1;
                            if near < min_culled { min_culled = near; }
                            return None;
                        }
                    }
                }
                Some((near, bi))
            }).collect()
        };
        // Near chunks first. The terrain pass has the depth test on and no
        // alpha test, so a fragment already covered by something closer is
        // rejected on depth instead of being textured and combined -- but
        // only if the closer thing was drawn first, and the pak's chunk
        // order has nothing to do with where the player is standing. A
        // sort of ~50 floats a frame buys whatever the overdraw is worth.
        // Nothing about WHAT is drawn changes: these are solid,
        // non-overlapping chunks, so no pixel depends on the order.
        let mut vis_spans = vis_spans;
        vis_spans.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(core::cmp::Ordering::Equal));
        // The same shape drawn where each placement says, at the level of
        // detail its distance earns: near ones carved, far ones coarse, and
        // nothing dropped for want of budget the way a baked-in chunk mesh
        // had to be.
        let (mut t_noshape, mut t_radius, mut t_cone) = (0u32, 0u32, 0u32);
        let vis_trees: Vec<_> = if pic_active {
            Vec::new()
        } else {
            tree_insts_ref.iter().filter_map(|it| {
                let (ix, iz) = (it.x as f32, it.z as f32);
                // near/far by distance to the focus, the same measure the
                // spans above cull on
                let dx = ix + 8.0 - focus_x;
                let dz = iz + 8.0 - focus_z;
                let dist = (dx * dx + dz * dz).sqrt();
                // Carved close up, coarse a bit further, a box beyond that
                // -- and each tree decides for itself as the player moves.
                let ladder = if dist <= TREE_NEAR_PX {
                    [it.near, it.mid, it.far]
                } else if dist <= TREE_MID_PX {
                    [it.mid, it.far, it.near]
                } else {
                    [it.far, it.mid, it.near]
                };
                let id = *ladder.iter().find(|&&id| id != TREE_SHAPE_NONE)?;
                let Some(Some((bi, gmin, gmax))) = tree_bufs_ref.get(id as usize) else {
                    t_noshape += 1;
                    return None;
                };
                // the shape's own box, put where this copy stands
                let cx = ix + (gmin[0] + gmax[0]) * 0.5;
                let cz = iz + (gmin[2] + gmax[2]) * 0.5;
                let hx = (gmax[0] - gmin[0]) * 0.5;
                let hz = (gmax[2] - gmin[2]) * 0.5;
                let ddx = cx - focus_x;
                let ddz = cz - focus_z;
                let extent = (hx * hx + hz * hz).sqrt();
                if (ddx * ddx + ddz * ddz).sqrt() - extent > cull_radius {
                    t_radius += 1;
                    return None;
                }
                if guest_drive {
                    let vx = cx - eye_x;
                    let vz = cz - eye_z;
                    let along = vx * fx + vz * fz;
                    let side = (vx * fz - vz * fx).abs();
                    let fwd_half = (hx * fx).abs() + (hz * fz).abs();
                    let lat_half = (hx * fz).abs() + (hz * fx).abs();
                    let far_edge = along + fwd_half;
                    let half = (far_edge * far_edge + cam_h * cam_h).sqrt() * TAN_HHALF;
                    if far_edge < -CONE_PAD || side - lat_half > half + CONE_PAD {
                        t_cone += 1;
                        return None;
                    }
                }
                Some((it, bi))
            }).collect()
        };
        unsafe {
            DRAWN = vis_spans.len() as u32;
            CULL_RADIUS_N = cull_r_n;
            CULL_CONE_N = cull_c_n;
            CULL_OCCL_N = cull_o_n;
            MIN_CULLED_D = if min_culled == f32::MAX { -1.0 } else { min_culled };
            TREES_DRAWN = vis_trees.len() as u32;
            TREES_CULLED = [t_noshape, t_radius, t_cone, 0];
        }
        perf_radius = cull_radius.min(9999.0);
        perf_spans = infos_ref.len() + strips_ref.len();
        perf_trees = tree_insts_ref.len();
        instance.render_frame_with(|mut frame| {
            fn cast_lifetime_to_closure<'frame, T>(x: T) -> T
            where
                T: Fn(&mut Frame<'frame>, &'frame mut ScreenTarget<'_>, &Matrix4, f32),
            { x }

            // `eye` is -1 for the left pass and +1 for the right: the pic
            // pass is the one thing here that has to know, because a
            // picture that stands out of the screen is the same picture
            // shifted the other way for each eye.
            let render_to = cast_lifetime_to_closure(|frame, target, mvp, eye: f32| {
                target.clear(
                    ClearFlags::ALL,
                    if pic_active { 0xFFFF_FFFFu32 } else { tint_rgba8(SKY, scene_tint) },
                    0,
                );
                frame.select_render_target(target).expect("select");
                frame.bind_vertex_uniform(projection_idx, mvp);
                frame.bind_vertex_uniform(uvx_idx, uvx);
                frame.bind_vertex_uniform(toff_idx, FVec4::new(0.0, 0.0, 0.0, 0.0));
                frame.set_cull_face(CullMode::None);
                // Per eye, not once at boot: enabling is also what flags the
                // coarse buffer for its clear.
                if EARLY_DEPTH { unsafe { c3d_early_depth(1); } }
                frame.bind_texture(texture::Index::Texture0, tex_ref);
                frame.set_texenvs(&[stage0]);
                frame.set_attr_info(&attr_info);
                if !pic_active {
                // The survivors of this frame's cull (decided once, above the
                // frame, for both eyes).
                for e in vis_spans.iter() {
                    frame.draw_arrays(buffer::Primitive::Triangles, e.1, None).unwrap();
                }
                // --- tree instances -------------------------------------
                // The same shape drawn where each placement says, at the
                // level of detail its distance earns: near ones carved,
                // far ones coarse, and nothing dropped for want of budget
                // the way a baked-in chunk mesh had to be.
                if !vis_trees.is_empty() {
                    let mut t_err = 0u32;
                    for (it, bi) in vis_trees.iter() {
                        // Where this copy stands, handed to the shader, which
                        // adds it to the vertex before the projection (a
                        // matrix edit moved the trees somewhere invisible).
                        frame.bind_vertex_uniform(
                            toff_idx,
                            FVec4::new(it.x as f32, it.y as f32, it.z as f32, 0.0),
                        );
                        if frame.draw_arrays(buffer::Primitive::Triangles, bi, None).is_err() {
                            t_err += 1;
                        }
                    }
                    frame.bind_vertex_uniform(toff_idx, FVec4::new(0.0, 0.0, 0.0, 0.0));
                    unsafe { TREES_CULLED[3] = t_err; }
                }
                }
                // Off before the ortho passes: the cards, pics, anims and UI
                // run with the depth test disabled and must not be answered
                // by a depth buffer they never wrote to.
                if EARLY_DEPTH { unsafe { c3d_early_depth(0); } }
                // Card UVs are already atlas-scaled here, so the shader's
                // terrain uvx transform must not apply again.
                frame.bind_vertex_uniform(uvx_idx, FVec4::new(1.0, 1.0, 0.0, 0.0));
                if !pic_bufs.is_empty() {
                    unsafe { c3d_depth_test(0); }
                    let po: Matrix4 = Projection::orthographic(
                        0.0..(UI_VIEW_W * UI_Q), (UI_VIEW_H * UI_Q)..0.0,
                        ClipPlanes { near: -1.0, far: 1.0 })
                        .screen(ScreenOrientation::Rotated).into();
                    frame.bind_vertex_uniform(projection_idx, &po);
                    frame.bind_vertex_uniform(uvx_idx, FVec4::new(1.0, 1.0, 0.0, 0.0));
                    for (pg, depth, pb) in pic_bufs.iter() {
                        if let Some(t) = page_tex_ref.get(*pg).and_then(|o| o.as_ref()) {
                            frame.bind_texture(texture::Index::Texture0, t);
                        }
                        // The pop, in the ortho's own units. Scaled by the
                        // slider so the 3D control still means something,
                        // and applied through toff (vshader.pica) rather
                        // than baked into the verts, which would mean a
                        // second copy of every one of them.
                        if *depth != 0 {
                            let px = -eye * (*depth as f32 / 256.0) * POP_PX * slider * UI_Q;
                            frame.bind_vertex_uniform(toff_idx, FVec4::new(px, 0.0, 0.0, 0.0));
                        }
                        frame.draw_arrays(buffer::Primitive::Triangles, pb, None).unwrap();
                        if *depth != 0 {
                            frame.bind_vertex_uniform(toff_idx, FVec4::new(0.0, 0.0, 0.0, 0.0));
                        }
                    }
                    frame.bind_vertex_uniform(projection_idx, mvp);
                    unsafe { c3d_depth_test(1); }
                }
                if !anim_ref.is_empty() {
                    // Over the battle, under the UI: these are OAM sprites,
                    // which sit above the background a text box is drawn in.
                    unsafe { c3d_depth_test(0); }
                    let ortho: Matrix4 = Projection::orthographic(
                        0.0..(UI_VIEW_W * UI_Q), (UI_VIEW_H * UI_Q)..0.0,
                        ClipPlanes { near: -1.0, far: 1.0 })
                        .screen(ScreenOrientation::Rotated).into();
                    frame.bind_vertex_uniform(projection_idx, &ortho);
                    frame.bind_vertex_uniform(uvx_idx, FVec4::new(1.0, 1.0, 0.0, 0.0));
                    for (pg, ab) in anim_ref.iter() {
                        if let Some(t) = page_tex_ref.get(*pg).and_then(|o| o.as_ref()) {
                            frame.bind_texture(texture::Index::Texture0, t);
                            let _ = frame.draw_arrays(buffer::Primitive::Triangles, ab, None);
                        }
                    }
                    frame.bind_vertex_uniform(projection_idx, mvp);
                    unsafe { c3d_depth_test(1); }
                }
                if let Some(ub) = ui_buf.as_ref() {
                    unsafe { c3d_depth_test(0); }
                    let ortho: Matrix4 = Projection::orthographic(
                        0.0..(UI_VIEW_W * UI_Q), (UI_VIEW_H * UI_Q)..0.0,
                        ClipPlanes { near: -1.0, far: 1.0 })
                        .screen(ScreenOrientation::Rotated).into();
                    if let Some(t) = page_tex_ref.get(ui_pg).and_then(|o| o.as_ref()) {
                        frame.bind_texture(texture::Index::Texture0, t);
                    }
                    frame.bind_vertex_uniform(projection_idx, &ortho);
                    frame.bind_vertex_uniform(uvx_idx, FVec4::new(1.0, 1.0, 0.0, 0.0));
                    frame.draw_arrays(buffer::Primitive::Triangles, ub, None).unwrap();
                    frame.bind_vertex_uniform(projection_idx, mvp);
                    unsafe { c3d_depth_test(1); }
                }
                if !card_bufs.is_empty() {
                    // Cards carry unrounded world coordinates in a float
                    // position attribute, so they need their own layout for
                    // the pass. The mvp is the plain one -- there is no
                    // longer a quantisation scale to divide back out.
                    frame.set_attr_info(&card_attr);
                    for (pg, ci) in card_bufs.iter() {
                        if let Some(t) = page_tex_ref.get(*pg).and_then(|o| o.as_ref()) {
                            frame.bind_texture(texture::Index::Texture0, t);
                        }
                        frame.draw_arrays(buffer::Primitive::Triangles, ci, None).unwrap();
                    }
                    // Restore: render_to runs again for the right eye, and
                    // the companion screen's passes follow, both on i16.
                    frame.set_attr_info(&attr_info);
                }
            });

            frame.bind_program(&program);
            render_to(&mut frame, &mut left_target, &mvp_l, -1.0);
            // Right eye costs a full second pass; only pay it when the
            // 3D slider is actually up.
            if !guest_drive || slider > 0.05 {
                render_to(&mut frame, &mut right_target, &mvp_r, 1.0);
            }
            // Kanto Gear increment 3: the companion (bottom) screen draws its
            // own UI surface (scene.ui_b) in true 320-wide space via a 0..320
            // ortho — no squish — driven by the guest's KantoGear module.
            // Kanto Gear: GB-green companion palette — clear to the DMG light
            // green; glyphs are tinted the darkest green in the ui_b vert build
            // above, giving the dark-on-light-green look of the real mod.
            bottom_target.clear(ClearFlags::ALL, 0x9BBC0FFFu32, 0);
            frame.select_render_target(&mut bottom_target).expect("select bottom");
            {
                let ortho: Matrix4 = Projection::orthographic(
                    0.0..320.0, 240.0..0.0,
                    ClipPlanes { near: -1.0, far: 1.0 })
                    .screen(ScreenOrientation::Rotated).into();
                frame.bind_vertex_uniform(projection_idx, &ortho);
                frame.bind_vertex_uniform(uvx_idx, FVec4::new(1.0, 1.0, 0.0, 0.0));
                if let Some(t) = page_tex_ref.get(ui_b_page).and_then(|o| o.as_ref()) {
                    frame.bind_texture(texture::Index::Texture0, t);
                }
                // Header bar: flat PrimaryColor (REPLACE) -> a clean solid strip
                // regardless of the atlas; restore the glyph texenv afterwards.
                if let Some(bb) = ui_b_bar_buf.as_ref() {
                    unsafe { c3d_depth_test(0); }
                    frame.set_texenvs(&[stage_flat]);
                    frame.draw_arrays(buffer::Primitive::Triangles, bb, None).unwrap();
                    frame.set_texenvs(&[stage0]);
                    unsafe { c3d_depth_test(1); }
                }
                if let Some(bb) = ui_b_buf.as_ref() {
                    unsafe { c3d_depth_test(0); }
                    frame.draw_arrays(buffer::Primitive::Triangles, bb, None).unwrap();
                    unsafe { c3d_depth_test(1); }
                }
                // Dark-on-light glyphs (unselected labels/borders): interpolate
                // via stage_on_light so they're dark STROKES on the clear, with
                // no opaque dark-green cell behind them.
                if let Some(bb) = ui_b_dim_buf.as_ref() {
                    unsafe { c3d_depth_test(0); }
                    frame.set_texenvs(&[stage_on_light]);
                    frame.draw_arrays(buffer::Primitive::Triangles, bb, None).unwrap();
                    frame.set_texenvs(&[stage0]);
                    unsafe { c3d_depth_test(1); }
                }
                // Light glyphs (header bar + inverted/selected cells): flat-tint
                // via stage_text so they're light STROKES, not a light cell.
                if let Some(bb) = ui_b_light_buf.as_ref() {
                    unsafe { c3d_depth_test(0); }
                    frame.set_texenvs(&[stage_text]);
                    frame.draw_arrays(buffer::Primitive::Triangles, bb, None).unwrap();
                    frame.set_texenvs(&[stage0]);
                    unsafe { c3d_depth_test(1); }
                }
                // Companion sprites: plain stage0 (Modulate x white vertex),
                // each group re-binding its own page's texture.
                if !ui_b_sprite_bufs.is_empty() {
                    unsafe { c3d_depth_test(0); }
                    for (pg, sb) in ui_b_sprite_bufs.iter() {
                        if let Some(t) = page_tex_ref.get(*pg).and_then(|o| o.as_ref()) {
                            frame.bind_texture(texture::Index::Texture0, t);
                        }
                        frame.draw_arrays(buffer::Primitive::Triangles, sb, None).unwrap();
                    }
                    unsafe { c3d_depth_test(1); }
                }
            }
            frame
        });

        // Lock to 30 Hz: a steady cadence reads smoother than swinging
        // between 37 and 60. The guest still simulates at 60 (sim_acc), so
        // this changes smoothness, not game speed.
        //
        // AFTER the present, not before it. Before, the sleep ran to 33 ms
        // and only THEN submitted, and the submit waits for a vblank of its
        // own -- so a frame that had finished its work at 9 ms slept to 33,
        // presented, and waited to the vblank at 50. Indoors, where the GPU
        // draws in 2.6 ms and the CPU takes 6.6, build 222452 logged 23 fps
        // for want of anything to do: a 30 Hz lock that cost 10 fps against
        // no lock at all. Measuring the whole iteration instead puts the
        // present and its vblank inside the 33 ms rather than after it.
        //
        // A frame already over budget sleeps not at all, so nothing about
        // the GPU-bound maps changes.
        unsafe {
            extern "C" { fn osGetTime() -> u64; fn svcSleepThread(ns: i64); }
            let spent = osGetTime().wrapping_sub(frame_start);
            if spent < 33 {
                svcSleepThread(((33 - spent) as i64) * 1_000_000);
            }
        }

        // Previous frame's buffers drop here, a full frame after the GPU
        // last touched them.
        card_hold = card_bufs;
        pic_hold = pic_bufs;
        ui_hold = ui_buf;
        anim_hold = anim_bufs;
        ui_b_hold = ui_b_buf;
        ui_b_bar_hold = ui_b_bar_buf;
        ui_b_light_hold = ui_b_light_buf;
        ui_b_dim_hold = ui_b_dim_buf;
        ui_b_sprite_hold = ui_b_sprite_bufs;
        let _ = (
            &card_hold, &pic_hold, &ui_hold, &anim_hold, &ui_b_hold,
            &ui_b_bar_hold, &ui_b_light_hold, &ui_b_dim_hold, &ui_b_sprite_hold,
        );
    }
}
