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
use pocketvoxel_core::spec::{atlas_kind, CHUNK_PX, COLOR_PAL_NONE, UI_COLS, UI_ROWS, WORLD_VIEW_H};

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
    fn gsp_flush(p: *const u8, len: u32);
    fn audio3ds_init(rate: i32, frames_per_buf: i32) -> i32;
    fn audio3ds_free_frames() -> i32;
    fn audio3ds_queue(pcm: *const i16, frames: i32) -> i32;
    fn c3d_alpha_test(on: i32, r: i32);
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
static mut PAK_CACHE: Vec<CachedPak> = Vec::new();
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
    if PAK_CACHE.first().map(&serves).unwrap_or(false) {
        return true;
    }
    // resident in the cache -> promote to front, no SD read
    if let Some(i) = PAK_CACHE.iter().position(&serves) {
        let hit = PAK_CACHE.remove(i);
        PAK_CACHE.insert(0, hit);
        dlog(&format!("[pv] pak {} cached (0 ms)", name));
        return true;
    }
    let _ = t_start;
    // must read from SD. Stat the size first so we can evict to fit WITHOUT a
    // transient over-budget spike; a map larger than the whole budget evicts
    // everything and loads alone (peak == the old single-pak peak).
    let t0 = {
        extern "C" { fn osGetTime() -> u64; }
        osGetTime()
    };
    let path = format!("sdmc:/3ds/voxelmon/paks/{}.vxpak", name);
    let new_kb = std::fs::metadata(&path)
        .map(|m| (m.len() / 1024) as usize)
        .unwrap_or(usize::MAX);
    while !PAK_CACHE.is_empty() && cache_total_kb() + new_kb > PAK_CACHE_BUDGET_KB {
        PAK_CACHE.pop(); // drop the least-recently-used entry
    }
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
        Ok(p) => {
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
            PAK_CACHE.insert(0, CachedPak {
                pak: p, buf, name: name.to_string(), kb, plan,
            });
            true
        }
        Err(e) => {
            println!("pak parse failed: {}", e);
            false
        }
    }
}

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

/// Give up this much of a frame to reading ahead. The slice loop stops at the
/// first read that crosses it, so a slow card costs one slice, not a stall.
const PREFETCH_MS: u64 = 3;
/// Bytes per read within that window. Small enough that one cannot itself
/// blow the frame on a slow card.
const PREFETCH_SLICE: usize = 32 * 1024;

/// Begin reading `name` ahead, unless it is already resident, already in
/// progress, or would not fit beside what is cached.
#[allow(static_mut_refs)]
unsafe fn prefetch_start(name: &str) -> bool {
    if PREFETCH.is_some()
        || PAK_CACHE.iter().any(|c| c.name == name)
        || PREFETCH_TRIED.iter().any(|n| n == name)
    {
        return false;
    }
    // Counted as attempted the moment it starts, so every exit below --
    // finished, refused, or failed -- costs one try and not a loop.
    PREFETCH_TRIED.push(name.to_string());
    let path = format!("sdmc:/3ds/voxelmon/paks/{}.vxpak", name);
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
    PREFETCH = Some(Prefetch { name: name.to_string(), file, buf, pos: 0 });
    true
}

/// Read the next slices of the map in flight. Called once a frame; returns
/// true when one just finished and went into the cache.
#[allow(static_mut_refs)]
unsafe fn prefetch_step() -> bool {
    use std::io::Read;
    extern "C" { fn osGetTime() -> u64; }
    let Some(pf) = PREFETCH.as_mut() else { return false };
    let deadline = osGetTime() + PREFETCH_MS;
    while pf.pos < pf.buf.len() {
        let end = (pf.pos + PREFETCH_SLICE).min(pf.buf.len());
        if pf.file.read_exact(&mut pf.buf[pf.pos..end]).is_err() {
            PREFETCH = None; // the card said no; the normal path will retry
            return false;
        }
        pf.pos = end;
        if osGetTime() >= deadline {
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
    while PAK_CACHE.len() > 1 && cache_total_kb() + kb > PAK_CACHE_BUDGET_KB {
        PAK_CACHE.pop(); // never the front: that is the map being played
    }
    if cache_total_kb() + kb > PAK_CACHE_BUDGET_KB {
        return false;
    }
    let buf: Box<[u8]> = pf.buf.into_boxed_slice();
    let bytes: &'static [u8] = core::mem::transmute(buf.as_ref());
    match pak::read_with_shared(bytes, SHARED_ATLAS) {
        Ok(p) => {
            // Behind the current map, so it is the first thing dropped if
            // the player walks somewhere else entirely.
            let at = PAK_CACHE.len().min(1);
            PAK_CACHE.insert(at, CachedPak {
                pak: p, buf, name: pf.name.clone(), kb, plan: None,
            });
            dlog(&format!("[pv] read ahead {} ({} KB)", pf.name, kb));
            true
        }
        Err(_) => false,
    }
}

#[allow(static_mut_refs)]
unsafe fn cur_pak() -> &'static pak::Pak<'static> {
    core::mem::transmute::<&pak::Pak<'static>, &'static pak::Pak<'static>>(
        &PAK_CACHE.first().expect("no pak loaded").pak,
    )
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
fn map_pak(
    path: &str,
    plan_for: Option<(u32, Option<(f32, f32)>)>,
) -> Option<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len() as usize;
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
        planned_ranges(chunks, &plan, p.stamps_of(map_id), pools_at, i_at, MERGE_SLOP)
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


/// Diagnostics that survive to a log file. `println!` goes to the ctru
/// Console, which this build hands to the Kanto Gear right after boot, so
/// nothing printed during play is ever readable. svcOutputDebugString is
/// picked up by emulators (Citra writes it to citra_log.txt as
/// Debug_Emulated) and by 3dslink on hardware, which makes it the only way
/// to see what the renderer actually did on a map that came up wrong.
fn dlog(s: &str) {
    unsafe {
        svcOutputDebugString(s.as_ptr(), s.len() as i32);
    }
    // Also to the SD card: an emulator only surfaces OutputDebugString at a
    // log level its config may not have on, and on hardware there is no log
    // at all. A file next to the paks is readable either way. Called about
    // once a second, so re-opening per line is not worth avoiding.
    use std::io::Write;
    for path in [
        "sdmc:/3ds/voxelmon/pvlog.txt",   // every run, for a freeze post-mortem
        "sdmc:/3ds/voxelmon/newlog.txt",  // this run only, emptied at boot
    ] {
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(f, "{}", s);
        }
    }
}

/// Per-frame cull accounting, so a hole in the world can be attributed to a
/// specific test instead of guessed at. MIN_CULLED_D is the distance of the
/// NEAREST span any cull threw away: if that is small, something close
/// enough to be on screen is being dropped.
static mut CULL_RADIUS_N: u32 = 0;
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
        let p0 = pak.verts[vbase + pak.indices[b] as usize];
        let p1 = pak.verts[vbase + pak.indices[b + 1] as usize];
        let p2 = pak.verts[vbase + pak.indices[b + 2] as usize];
        let mid_x = (p0.x as f32 + p1.x as f32 + p2.x as f32) / 3.0;
        let mid_z = (p0.z as f32 + p1.z as f32 + p2.z as f32) / 3.0;
        if mid_x < clip_min[0] || mid_x > clip_max[0]
            || mid_z < clip_min[1] || mid_z > clip_max[1]
        {
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
        let idx = pak.indices[m.index_base as usize + k] as usize;
        let pv = pak.verts[vbase + idx];
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
    MapGeom { chunk_spans, verts, center, size, tex_rgba, tw, th, aw, ah, is_huge, map_min, map_max }
}

static mut RT: *mut JSRuntime = core::ptr::null_mut();
static mut CTX: *mut JSContext = core::ptr::null_mut();

fn main() {
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


    // pvlog.txt ACCUMULATES: a freeze is investigated by relaunching, and
    // wiping it on boot would destroy the very run being investigated. Trim
    // only when it has grown large.
    if std::fs::metadata("sdmc:/3ds/voxelmon/pvlog.txt")
        .map(|m| m.len() > 512 * 1024)
        .unwrap_or(false)
    {
        let _ = std::fs::write("sdmc:/3ds/voxelmon/pvlog.txt", "");
    }
    // newlog.txt holds THIS RUN and nothing else, emptied right here. The
    // accumulating one is genuinely hard to read: several boots deep, the
    // newest run is at the bottom and looks exactly like the others, so a
    // stale copy and a fresh one are indistinguishable at a glance. If
    // newlog.txt has more than one boot line in it, it did not come from
    // this build.
    let _ = std::fs::write("sdmc:/3ds/voxelmon/newlog.txt", "");
    dlog("[pv] ---------------- boot ----------------");
    // Stamp the build so a log can never be mistaken for one from a
    // different binary — the Desktop copy lives in OneDrive, and a sync
    // lag once made a stale .3dsx look like a code path that "did nothing".
    dlog(&format!(
        "[pv] boot build={}",
        option_env!("PV_BUILD_ID").unwrap_or("dev"),
    ));

    // Hold the pak resident, as the live scene renderer will need.
    println!("loading pak...");
    // Per-map paks: memory scales with the biggest map, not the map count.
    let gd = std::fs::read("sdmc:/3ds/voxelmon/paks/gamedata.json").unwrap_or_default();
    println!("gamedata {} KB", gd.len() / 1024);
    let gd_static: &'static [u8] = Box::leak(gd.into_boxed_slice());

    size_pak_cache();

    // The shared atlas pages, before any pak is read — every pak's page
    // directory resolves against this. Absent is fine and means the card
    // holds original paks that embed every page.
    match std::fs::read("sdmc:/3ds/voxelmon/paks/common.vxat") {
        Ok(v) if !v.is_empty() => {
            println!("shared atlas {} KB", v.len() / 1024);
            unsafe { SHARED_ATLAS = Some(Box::leak(v.into_boxed_slice())); }
        }
        _ => println!("shared atlas: absent (paks carry their own pages)"),
    }

    let index_txt = std::fs::read_to_string("sdmc:/3ds/voxelmon/paks/index.txt")
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
    let audi: &'static [u8] = Box::leak(pak_static.audio.to_vec().into_boxed_slice());
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
    type BuiltKey = (u32, Option<(i32, i32)>, u32, usize, [bool; 4]);
    let mut built_key: Option<BuiltKey> = None;
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
    let pics_page: i32 = pak_static.atlases.iter()
        .position(|p| p.kind == atlas_kind::PICS)
        .map(|i| i as i32).unwrap_or(-1);
    {
        let n = pak_static.atlases.iter().filter(|p| p.kind == atlas_kind::PICS).count();
        println!("PICS pages: {}  first: {}", n, pics_page);
        if pics_page >= 0 {
            let pg = pak_static.atlases[pics_page as usize];
            println!("  page {}x{} frames {}", pg.w, pg.h, pg.frames);
        }
        let mut sizes: Vec<(u16, u16, usize)> = Vec::new();
        for pg2 in pak_static.atlases.iter().filter(|p| p.kind == atlas_kind::PICS) {
            match sizes.iter_mut().find(|s| s.0 == pg2.w && s.1 == pg2.h) {
                Some(e) => e.2 += 1,
                None => sizes.push((pg2.w, pg2.h, 1)),
            }
        }
        for (w, h, n) in sizes.iter() {
            println!("  {}x{}: {} pages", w, h, n);
        }
    }
    let mut pic_on = false;
    let mut pic_idx: i32 = 0;
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
    let mut pcm: Vec<i16> = vec![0; (AUDIO_BUF * 2) as usize];
    println!("audio: {}", if audio_on { "ndsp open" } else { "unavailable" });

    let mut guest_drive = true;   // boot into the game; the title state runs there
    let mut dbg_tick: u32 = 0;
    let mut frame_start: u64 = 0;
    let mut aud_ticks: u32 = 0;
    let mut aud_queued: u32 = 0;
    let mut aud_dropped: u32 = 0;
    /// Leftover sixtieths of a frame, so the long-run rate is exact.
    let mut aud_rem: i32 = 0;
    let mut sim_acc: f32 = 0.0;
    let mut sim_last: u64 = 0;
    let mut fps_frames: u32 = 0;
    let mut fps_last: u64 = 0;
    let pitches: [i32; 5] = [0, 1, 2, 3, 4];
    let mut pitch_i = 0usize;
    let mut page_tex: Vec<Option<texture::Texture>> = Vec::new();
    // Card/pic vertex buffers are rebuilt every frame. Freeing them the
    // instant the frame ends lets the GPU read memory that's already gone —
    // on hardware that tears the walking sprite. Keep one frame alive.
    let mut card_hold: Vec<(usize, buffer::Info)> = Vec::new();
    let mut pic_hold: Vec<(usize, buffer::Info)> = Vec::new();
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
    let mut dist: f32 = geom.size * 1.4;

    while apt.main_loop() {
        hid.scan_input();
        let k = hid.keys_held();
        let d = hid.keys_down();
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
        if guest_drive && pics_page >= 0 {
            let held = hid.keys_held();
            let mut step = 0i32;
            if d.contains(KeyPad::Y) { if !pic_on { pic_on = true; pic_idx = pics_page; } else { step = 1; } }
            if d.contains(KeyPad::L) { step = -10; }
            if d.contains(KeyPad::R) { step = 10; }
            // hold ZL/ZR to fly
            if held.contains(KeyPad::ZL) { step = -25; }
            if held.contains(KeyPad::ZR) { step = 25; }
            if d.contains(KeyPad::SELECT) && pic_on {
                pic_on = false;
                unsafe { voxel::scene().op(34, &[0], None); }
            }
            // Touch the bottom screen to scrub: x maps across the whole
            // PICS range, so any page is one tap away.
            if pic_on {
                let t = hid.touch_position();
                if t.0 != 0 || t.1 != 0 {
                    let first = pics_page.max(0);
                    let last = pak_static.atlases.iter().rposition(|p| p.kind == atlas_kind::PICS)
                        .map(|i| i as i32).unwrap_or(first);
                    let span = (last - first).max(1) as f32;
                    let want = first + ((t.0 as f32 / 320.0) * span) as i32;
                    if want != pic_idx {
                        pic_idx = want.clamp(first, last);
                        let pg = pak_static.atlases[pic_idx as usize];
                        unsafe { voxel::scene().op(33, &[0, pic_idx, 80, 20, 320, 230], None); }
                    }
                }
            }
            if pic_on && step != 0 {
                let n = pak_static.atlases.len() as i32;
                pic_idx = (pic_idx + step).rem_euclid(n);
                let dir = if step > 0 { 1 } else { -1 };
                let mut guard = 0;
                while pak_static.atlases[pic_idx as usize].kind != atlas_kind::PICS && guard < n {
                    pic_idx = (pic_idx + dir).rem_euclid(n);
                    guard += 1;
                }
                let pg = pak_static.atlases[pic_idx as usize];
                unsafe { voxel::scene().op(33, &[0, pic_idx, 80, 20, 320, 230], None); }
            }
            if pic_on && d.contains(KeyPad::Y) && step == 0 {
                let pg = pak_static.atlases[pic_idx as usize];
                unsafe { voxel::scene().op(33, &[0, pic_idx, 80, 20, 320, 230], None); }
            }
        }
        if d.contains(KeyPad::SELECT) && pic_on {
            pic_on = false;
            unsafe { voxel::scene().op(34, &[0], None); }
        }
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
            let browsing = pic_on;
            if k.contains(KeyPad::DPAD_UP)    { b |= 1 << 0; }
            if k.contains(KeyPad::DPAD_DOWN)  { b |= 1 << 1; }
            if k.contains(KeyPad::DPAD_LEFT)  { b |= 1 << 2; }
            if k.contains(KeyPad::DPAD_RIGHT) { b |= 1 << 3; }
            // The circle pad walks exactly as the d-pad does -- same bits,
            // so menus, the bag and the naming screen all take it too.
            {
                let (cx, cy) = hid.circlepad_position();
                b |= stick_as_dpad(cx, cy);
            }
            if k.contains(KeyPad::A)          { b |= 1 << 4; }
            if k.contains(KeyPad::B)          { b |= 1 << 5; }
            if k.contains(KeyPad::START)      { b |= 1 << 6; }
            if k.contains(KeyPad::SELECT)     { b |= 1 << 7; }
            if browsing { b = 0; }
            // Bottom-screen touch rides the free high bits of the button word,
            // so the guest can react without changing the qjs_call_frame ABI
            // (the C shim, and its `buttons: i32`, are unchanged):
            //   bit 8      = touching
            //   bits 9..17 = x (0..319)  bits 18..25 = y (0..239)
            // The guest reads a touch-DOWN edge, so holding is one tap; the
            // sim-step catch-up loop re-sends the same word harmlessly.
            if !browsing {
                let t = hid.touch_position();
                if t.0 != 0 || t.1 != 0 {
                    b |= 1 << 8;
                    b |= ((t.0 as i32) & 0x1ff) << 9;
                    b |= ((t.1 as i32) & 0xff) << 18;
                }
            }
            // DEBUG map-cycle: L/R ride bits 26/27 the same way touch rides
            // 8-25 — no GB equivalent, so this stays out of VOX_BTN/Input and
            // is read directly by psp-main.ts's frame() (game.debugCycleMap).
            // `d` (this-frame press), not `held`, so one tap is one cycle;
            // the pics-browser above already claims L/R when `browsing`.
            if !browsing {
                if d.contains(KeyPad::L) { b |= 1 << 27; }
                if d.contains(KeyPad::R) { b |= 1 << 26; }
            }
            // Bits 24-25: how far the view has been swung, in quarter turns.
            // The guest rotates its WALK by this and nothing else -- a menu
            // is drawn flat on the screen and its cursor has to keep moving
            // the way the player pushed.
            {
                let q = pocketvoxel_core::cam::quarter_turns(cam_yaw_off);
                b |= (q & 3) << 24;
            }
            unsafe {
                let mut e2 = [0u8; 256];
                let mut failed = false;
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
                        voxel::scene().render_audio(pak_static, want, &mut pcm);
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
                            if let Some((_, nm)) = map_index.iter().find(|(id, _)| *id == want) {
                                // cam_px is already the NEW map's position on
                                // this frame -- the same value `center` is
                                // assigned a few lines below, and the same one
                                // the build will plan against.
                                let key = plan_key(want, sc.cam_px());
                                if unsafe { load_map_pak(nm, Some(key)) } {
                                    pak_static = unsafe { cur_pak() };
                                }
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
                        if unsafe { prefetch_step() } {
                            // Inserting into PAK_CACHE can reallocate it and
                            // move the Pak structs with it, and pak_static
                            // points straight at the front one. Re-take it.
                            pak_static = unsafe { cur_pak() };
                        } else if unsafe { PREFETCH.is_none() } {
                            for i in 1..sc.maps.len() {
                                if !sc.maps[i].shown {
                                    continue;
                                }
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
                    let path = format!("sdmc:/3ds/voxelmon/paks/{}.vxpak", nname);
                    let Some((nmn, nmx)) = neighbor_bounds(&path, nid) else {
                        continue;
                    };
                    let (lo, hi) = ([nmn[0] + ox, nmn[1] + oy], [nmx[0] + ox, nmx[1] + oy]);
                    if hi[0] <= cmn[0] + 1.0 { seam_sides[0] = true; }
                    if lo[0] >= cmx[0] - 1.0 { seam_sides[1] = true; }
                    if hi[1] <= cmn[1] + 1.0 { seam_sides[2] = true; }
                    if lo[1] >= cmx[1] - 1.0 { seam_sides[3] = true; }
                }
            }
            let want_key: BuiltKey = (
                map_ids[map_i],
                if cur_map_huge { stream_center_chunk } else { None },
                last_tint,
                stamps_off_snapshot.len(),
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
                dlog(&format!(
                    "[pv] seams W={} E={} N={} S={} nbrs={}",
                    seam_sides[0], seam_sides[1], seam_sides[2], seam_sides[3],
                    neighbor_slots.len(),
                ));
            }
            dlog(&format!("[pv] linear free {} KB before build", unsafe_free_kb()));
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
                    let path = format!("sdmc:/3ds/voxelmon/paks/{}.vxpak", nname);
                    let Some(strip) = load_neighbor_strip(
                        &path, nid, ox, oy, geom.map_min, geom.map_max, last_tint,
                    ) else {
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
            dlog(&format!(
                "[pv] strips total spans={} ~{}KB",
                strip_infos.len(),
                strip_verts_kb,
            ));
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
            center = geom.center;
        }

        if guest_drive {
            // C-stick swings the view. Rate, not position: holding it keeps
            // turning, which is what a nub with no absolute reference wants.
            // The C-stick's four directions are ordinary keypad bits, so no
            // extra service to start; the analog read would be irrstCstick-
            // Read, which hidCstickRead is only a macro for.
            if k.contains(KeyPad::CSTICK_LEFT)  { cam_yaw_off -= 0.035; }
            if k.contains(KeyPad::CSTICK_RIGHT) { cam_yaw_off += 0.035; }
            if k.contains(KeyPad::CSTICK_UP)    { cam_pitch_off += 0.025; }
            if k.contains(KeyPad::CSTICK_DOWN)  { cam_pitch_off -= 0.025; }
            if k.contains(KeyPad::ZL) && k.contains(KeyPad::ZR) {
                cam_yaw_off = 0.0;
                cam_pitch_off = 0.0;
            }
            // Held against the limit, the offset must not keep winding: the
            // swing clamps its RESULT, so the slack would all have to be
            // pushed back out before the camera moved again. Clamped to what
            // this camera can actually take, the stick simply stops at the
            // ground and reverses the moment it is pushed the other way.
            cam_pitch_off =
                draw::clamp_pitch_off(unsafe { voxel::scene() }, cam_pitch_off);
            // Yaw has no limit, it just goes round; keep it in one turn so
            // it cannot drift off into imprecision over a long session.
            let tau = core::f32::consts::PI * 2.0;
            cam_yaw_off = cam_yaw_off.rem_euclid(tau);
            // Handed to the scene rather than applied here: draw::camera
            // swings the ONE camera everything reads, so the billboard lean,
            // the card facing, the frustum and the projection cannot end up
            // describing different eyes. Battles included -- the rig is a
            // camera like any other, and the arena is worth walking around.
            let sc = unsafe { voxel::scene() };
            sc.cam_yaw_off = cam_yaw_off;
            sc.cam_pitch_off = cam_pitch_off;
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
        let mut pic_groups: Vec<(u16, Vec<Vertex>)> = Vec::new();
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
                if let Item::ScreenPic { x, y, w, h, page } = it {
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
                    let gi = match pic_groups.iter().position(|g| g.0 == *page) {
                        Some(i) => i,
                        None => { pic_groups.push((*page, Vec::new())); pic_groups.len() - 1 }
                    };
                    let gv = &mut pic_groups[gi].1;
                    gv.push(mp(x0, y0, 0.0, 1.0));
                    gv.push(mp(x1, y0, u1, 1.0));
                    gv.push(mp(x1, y1, u1, 1.0 - v1));
                    gv.push(mp(x0, y0, 0.0, 1.0));
                    gv.push(mp(x1, y1, u1, 1.0 - v1));
                    gv.push(mp(x0, y1, 0.0, 1.0 - v1));
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
        if guest_drive && pic_on && dbg_tick % 30 == 0 {
            let sp = unsafe {
                voxel::scene().pics.iter().filter(|p| p.shown).count()
            };
        }
        if page_tex.len() < pak_static.atlases.len() {
            page_tex.resize_with(pak_static.atlases.len(), || None);
        }
        for (pg, _) in pic_groups.iter() {
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
        let pic_bufs: Vec<(usize, buffer::Info)> = pic_groups.iter().filter_map(|(pg, v)| {
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
        // Once a second: how many spans exist, how many survived the cull
        // last frame, and where the cull thinks the camera is. A map that
        // comes up as bare sky is either spans=0 (nothing built or nothing
        // uploaded) or drawn=0 (everything culled) — these two numbers say
        // which, which is otherwise unknowable on a device with no console.
        if dbg_tick % 60 == 0 {
            dlog(&format!(
                "[pv] spans={} drawn={} cull(r={} cone={} occl={}) nearestCulled={:.0} focus=({:.0},{:.0}) eye=({:.0},{:.0}) fwd=({:.2},{:.2}) battle={} huge={}",
                infos_ref.len(),
                unsafe { DRAWN },
                unsafe { CULL_RADIUS_N },
                unsafe { CULL_CONE_N },
                unsafe { CULL_OCCL_N },
                unsafe { MIN_CULLED_D },
                focus_x, focus_z, cull_eye_x, cull_eye_z, fx, fz,
                in_battle, cur_map_huge,
            ));
        }

        // Lock to 30 Hz: a steady cadence reads smoother than swinging
        // between 37 and 60. The guest still simulates at 60 (sim_acc), so
        // this changes smoothness, not game speed.
        unsafe {
            extern "C" { fn osGetTime() -> u64; fn svcSleepThread(ns: i64); }
            let spent = osGetTime().wrapping_sub(frame_start);
            if spent < 33 {
                svcSleepThread(((33 - spent) as i64) * 1_000_000);
            }
        }
        instance.render_frame_with(|mut frame| {
            fn cast_lifetime_to_closure<'frame, T>(x: T) -> T
            where
                T: Fn(&mut Frame<'frame>, &'frame mut ScreenTarget<'_>, &Matrix4),
            { x }

            let render_to = cast_lifetime_to_closure(|frame, target, mvp| {
                target.clear(
                    ClearFlags::ALL,
                    if pic_active { 0xFFFF_FFFFu32 } else { tint_rgba8(SKY, scene_tint) },
                    0,
                );
                frame.select_render_target(target).expect("select");
                frame.bind_vertex_uniform(projection_idx, mvp);
                frame.bind_vertex_uniform(uvx_idx, uvx);
                frame.set_cull_face(CullMode::None);
                frame.bind_texture(texture::Index::Texture0, tex_ref);
                frame.set_texenvs(&[stage0]);
                frame.set_attr_info(&attr_info);
                if !pic_active {
                let mut drawn = 0u32;
                let (mut cull_r_n, mut cull_c_n, mut cull_o_n) = (0u32, 0u32, 0u32);
                let mut min_culled = f32::MAX;
                for (span, bi) in infos_ref.iter().chain(strips_ref.iter()) {
                    let (bmin, bmax) = (&span.bmin, &span.bmax);
                    let cx = (bmin[0] + bmax[0]) * 0.5;
                    let cz = (bmin[2] + bmax[2]) * 0.5;
                    let dx = cx - focus_x;
                    let dz = cz - focus_z;
                    // Measure to the chunk's nearest point, not its centre:
                    // a 128 px chunk reaches ~90 px past its own centre, and
                    // culling on the centre alone throws away chunks that
                    // are still half on screen.
                    let hx = (bmax[0] - bmin[0]) * 0.5;
                    let hz = (bmax[2] - bmin[2]) * 0.5;
                    let extent = (hx * hx + hz * hz).sqrt();
                    let near = (dx * dx + dz * dz).sqrt() - extent;
                    if near > cull_radius {
                        cull_r_n += 1;
                        if near < min_culled { min_culled = near; }
                        continue;
                    }
                    if guest_drive {
                        let vx = cx - eye_x;
                        let vz = cz - eye_z;
                        let along = vx * fx + vz * fz;
                        let side = (vx * fz - vz * fx).abs();
                        // Project the box onto the view axes instead of
                        // using its diagonal as a blanket pad: how far it
                        // reaches FORWARD sets how wide the wedge is across
                        // it, how far it reaches SIDEWAYS sets how much of
                        // that width it needs.
                        let fwd_half = (hx * fx).abs() + (hz * fz).abs();
                        let lat_half = (hx * fz).abs() + (hz * fx).abs();
                        let far = along + fwd_half;
                        // The view does NOT converge to a point at the eye:
                        // the camera sits cam_h above the ground, so the
                        // wedge is already cam_h*TAN_HHALF wide at the
                        // camera's own ground position and widens from
                        // there. Measuring at the box's FAR edge against
                        // its NEAREST side is what keeps a chunk whose
                        // inner edge is still on screen — evaluating at the
                        // centre with a radius pad dropped those, which is
                        // the pop-out along the bottom of the frame.
                        let half = (far * far + cam_h * cam_h).sqrt() * TAN_HHALF;
                        if far < -CONE_PAD || side - lat_half > half + CONE_PAD {
                            cull_c_n += 1;
                            if near < min_culled { min_culled = near; }
                            continue;
                        }
                    }
                    // The battle camera's no-clip, against this span's OWN
                    // bounds and only for spans that leave no hole behind
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
                                continue;
                            }
                        }
                    }
                    drawn += 1;
                    frame.draw_arrays(buffer::Primitive::Triangles, bi, None).unwrap();
                }
                unsafe {
                    DRAWN = drawn;
                    CULL_RADIUS_N = cull_r_n;
                    CULL_CONE_N = cull_c_n;
                    CULL_OCCL_N = cull_o_n;
                    MIN_CULLED_D = if min_culled == f32::MAX { -1.0 } else { min_culled };
                }
                }
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
                    for (pg, pb) in pic_bufs.iter() {
                        if let Some(t) = page_tex_ref.get(*pg).and_then(|o| o.as_ref()) {
                            frame.bind_texture(texture::Index::Texture0, t);
                        }
                        frame.draw_arrays(buffer::Primitive::Triangles, pb, None).unwrap();
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
            render_to(&mut frame, &mut left_target, &mvp_l);
            // Right eye costs a full second pass; only pay it when the
            // 3D slider is actually up.
            if !guest_drive || slider > 0.05 {
                render_to(&mut frame, &mut right_target, &mvp_r);
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

        // Previous frame's buffers drop here, a full frame after the GPU
        // last touched them.
        card_hold = card_bufs;
        pic_hold = pic_bufs;
        ui_b_hold = ui_b_buf;
        ui_b_bar_hold = ui_b_bar_buf;
        ui_b_light_hold = ui_b_light_buf;
        ui_b_dim_hold = ui_b_dim_buf;
        ui_b_sprite_hold = ui_b_sprite_bufs;
        let _ = (&card_hold, &pic_hold, &ui_b_hold, &ui_b_bar_hold, &ui_b_light_hold, &ui_b_dim_hold, &ui_b_sprite_hold);
    }
}
