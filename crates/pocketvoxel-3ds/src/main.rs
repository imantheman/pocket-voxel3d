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
use pocketvoxel_core::spec::{atlas_kind, CHUNK_PX, COLOR_PAL_NONE, UI_COLS, UI_ROWS};

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
}
static mut PAK_CACHE: Vec<CachedPak> = Vec::new();
const PAK_CACHE_BUDGET_KB: usize = 24 * 1024;

#[allow(static_mut_refs)]
unsafe fn cache_total_kb() -> usize {
    PAK_CACHE.iter().map(|c| c.kb).sum()
}

#[allow(static_mut_refs)]
unsafe fn load_map_pak(name: &str) -> bool {
    // already the current map
    if PAK_CACHE.first().map(|c| c.name == name).unwrap_or(false) {
        return true;
    }
    // resident in the cache -> promote to front, no SD read
    if let Some(i) = PAK_CACHE.iter().position(|c| c.name == name) {
        let hit = PAK_CACHE.remove(i);
        PAK_CACHE.insert(0, hit);
        return true;
    }
    // must read from SD. Stat the size first so we can evict to fit WITHOUT a
    // transient over-budget spike; a map larger than the whole budget evicts
    // everything and loads alone (peak == the old single-pak peak).
    let path = format!("sdmc:/3ds/voxelmon/paks/{}.vxpak", name);
    let new_kb = std::fs::metadata(&path)
        .map(|m| (m.len() / 1024) as usize)
        .unwrap_or(usize::MAX);
    while !PAK_CACHE.is_empty() && cache_total_kb() + new_kb > PAK_CACHE_BUDGET_KB {
        PAK_CACHE.pop(); // drop the least-recently-used entry
    }
    let Some(v) = map_pak(&path) else {
        println!("pak missing: {}", name);
        return false;
    };
    let kb = v.len() / 1024;
    println!("pak {} {} KB (cache {} KB)", name, kb, cache_total_kb());
    let buf: Box<[u8]> = v.into_boxed_slice();
    let bytes: &'static [u8] = core::mem::transmute(buf.as_ref());
    match pak::read(bytes) {
        Ok(p) => {
            PAK_CACHE.insert(0, CachedPak { pak: p, buf, name: name.to_string(), kb });
            true
        }
        Err(e) => {
            println!("pak parse failed: {}", e);
            false
        }
    }
}

#[allow(static_mut_refs)]
unsafe fn cur_pak() -> &'static pak::Pak<'static> {
    core::mem::transmute::<&pak::Pak<'static>, &'static pak::Pak<'static>>(
        &PAK_CACHE.first().expect("no pak loaded").pak,
    )
}

fn map_pak(path: &str) -> Option<Vec<u8>> {
    // fs::read grows by doubling, so a 45 MB pak can transiently want ~90 MB
    // and blow the heap even though the final size fits. Size it exactly
    // from the file length and read straight in.
    use std::io::Read;
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len() as usize;
    let mut v: Vec<u8> = Vec::new();
    if v.try_reserve_exact(len).is_err() {
        println!("pak: cannot reserve {} KB", len / 1024);
        return None;
    }
    v.resize(len, 0);
    if f.read_exact(&mut v).is_err() {
        println!("pak: short read");
        return None;
    }
    Some(v)
}

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

fn build_page_tex(pak: &Pak, pidx: u16, pal_sel: i32) -> (Vec<u8>, u32, u32) {
    let page = pak.atlases[pidx as usize];
    let lin = pak::unswizzle(page.w as usize, page.h as usize, page.frame(0))
        .unwrap_or_else(|_| vec![0u8; (page.w as usize) * (page.h as usize)]);
    let palv = &pak.palettes[resolve_pal(pak, pidx, page.kind, COLOR_PAL_NONE, pal_sel)];
    let (aw, ah) = (page.w as u32, page.h as u32);
    let (tw, th) = (po2(aw), po2(ah));
    let mut out = vec![0u8; (tw * th * 4) as usize];
    for y in 0..ah {
        for x in 0..aw {
            let c = palv[lin[(y * aw + x) as usize] as usize];
            let o = tiled_off(x, y, tw);
            out[o]     = ((c >> 24) & 0xff) as u8;
            out[o + 1] = ((c >> 16) & 0xff) as u8;
            out[o + 2] = ((c >> 8) & 0xff) as u8;
            out[o + 3] = (c & 0xff) as u8;
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
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("sdmc:/3ds/voxelmon/pvlog.txt")
    {
        let _ = writeln!(f, "{}", s);
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
const MAX_VERTS: usize = 900_000;
// The original conservative cap ("Routes and towns sit just under it,
// Viridian City 396k, Route 2 383k"), kept for maps whose content is so far
// past even the generous cap that reaching for it is what crashes — not
// maps that merely exceed it a bit, like Cerulean. Viridian Forest's tree
// hulls alone run ~4.4M indices; even letting it climb toward MAX_VERTS
// before falling back to boxes still means allocating a much larger buffer
// than this, which is the actual hardware failure, not the boxes.
const MAX_VERTS_SAFE: usize = 400_000;
/// Above this measured total (ground + full tree hulls + filler), a map is
/// "wildly" oversized rather than moderately over budget, and gets the safe
/// cap instead of the generous one. 3x MAX_VERTS_SAFE cleanly separates the
/// two known data points: Cerulean City (758,508) stays under it and gets
/// the generous cap; Viridian Forest (~4.4M) is far over and gets the safe
/// one.
const HUGE_MAP_THRESHOLD: usize = MAX_VERTS_SAFE * 3;
/// terrain, terrain_keep, water (spec::mesh_kind): the walkable ground and
/// the water surface it borders, always first and always in full. Water
/// rides with ground rather than with grass/flower below despite being
/// cheap in practice (Cerulean City: 3,672 indices total) — a missing lake
/// reads as broken in a way a few missing flowers don't, so it isn't worth
/// leaving to "whatever's left".
const GROUND_KINDS: [usize; 3] = [0, 2, 6];
/// grass, flower: no cheaper LOD exists for these, but they're the least
/// noticeable thing to lose a few of, so they're processed LAST — whatever
/// survives ground + trees. On a big, dense map (Cerulean City: ground+water
/// alone is 344,436 of the 400,000 budget) this can mean some flowers don't
/// make it in; that's the intended trade against boxy/missing trees, not a
/// bug. This matches the original single-pass order (terrain, terrain_keep,
/// tree, water, grass, flower) for grass/flower's position relative to
/// trees; only water moved (see above) and the tree step below changed.
const FILLER_KINDS: [usize; 2] = [7, 8];
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
            if p[c] < gmin[c] { gmin[c] = p[c]; }
            if p[c] > gmax[c] { gmax[c] = p[c]; }
        }
        verts.push(Vertex {
            pos: [pv.x, pv.y, pv.z, 0],
            color: [(a & 0xff) as u8, ((a >> 8) & 0xff) as u8, ((a >> 16) & 0xff) as u8, 255],
            uv: [pv.uf(), pv.vf()],
        });
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

    // Prescan over the WHOLE map: ground + ALL tree hulls + filler, i.e.
    // what it would cost at full detail. Below HUGE_MAP_THRESHOLD (Cerulean
    // City-scale — over MAX_VERTS_SAFE but by a normal amount) it builds
    // every chunk once, same as any other map, just with the generous cap
    // so the per-chunk tree cascade below can use real hulls where it fits.
    // Past it (Viridian Forest-scale, ~3.65M here against a 400,000-900,000
    // budget either way) no single flat buffer holding every chunk at once
    // is going to look right OR fit safely — so instead of building the
    // whole map, stream a WINDOW of chunks around the player once we know
    // where they are, and rebuild it as they cross into a new chunk (the
    // check for that lives in main()'s loop, driving `reload`).
    let is_huge = {
        let mut total = 0usize;
        for c in all_chunks {
            for &k in GROUND_KINDS.iter() { total += c.meshes[k].index_count as usize; }
            total += c.meshes[TREE_HULL_KIND].index_count as usize;
            for &k in FILLER_KINDS.iter() { total += c.meshes[k].index_count as usize; }
        }
        total > HUGE_MAP_THRESHOLD
    };
    // A radius filter was tried here first and made things WORSE: Viridian
    // Forest's entire map is only ~5x6 chunks, smaller than any reasonable
    // draw-distance radius, so "windowing" it included every chunk anyway —
    // while still switching the budget up to the generous cap, an even
    // bigger allocation than the one that already crashed once. The forest
    // isn't large-and-sparse (where skipping far chunks saves memory), it's
    // small-and-extremely-dense (trees packed everywhere); no radius
    // shrinks that. So: always the safe cap for a huge map, no filtering —
    // just reorder ALL its chunks nearest-the-player-first once we know
    // where they are, so the limited budget is spent on what's actually
    // close instead of whatever came first in file order, and re-sort
    // (via the chunk-crossing check in main()) as they walk. Ground is
    // cheap enough to always fit regardless of order; the tree cascade and
    // the filler pass both benefit from nearest-first the same way.
    let mut chunks: Vec<pak::Chunk> = all_chunks.to_vec();
    let budget = if is_huge {
        if let Some((px, pz)) = player_px {
            let pcx = (px / CHUNK_PX as f32).floor() as i32;
            let pcz = (pz / CHUNK_PX as f32).floor() as i32;
            chunks.sort_by_key(|c| {
                let dx = c.cx as i32 - pcx;
                let dy = c.cy as i32 - pcz;
                dx * dx + dy * dy
            });
        }
        MAX_VERTS_SAFE
    } else {
        MAX_VERTS
    };

    // Ground first — always in full.
    for &kind in GROUND_KINDS.iter() {
        for chunk in &chunks {
            push_chunk_mesh(pak, chunk, kind, budget, tint, &mut verts, &mut chunk_spans, &mut cmin, &mut cmax);
        }
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
    for chunk in &chunks {
        let hull = chunk.meshes[TREE_HULL_KIND];
        let coarse = chunk.meshes[TREE_COARSE_KIND];
        let kind = if hull.index_count > 0 && verts.len() + hull.index_count as usize <= budget {
            TREE_HULL_KIND
        } else if coarse.index_count > 0 && verts.len() + coarse.index_count as usize <= budget {
            TREE_COARSE_KIND
        } else {
            TREE_BOX_KIND
        };
        push_chunk_mesh(pak, chunk, kind, budget, tint, &mut verts, &mut chunk_spans, &mut cmin, &mut cmax);
    }
    // Water, grass, flower last — whatever budget survives the above.
    for &kind in FILLER_KINDS.iter() {
        for chunk in &chunks {
            push_chunk_mesh(pak, chunk, kind, budget, tint, &mut verts, &mut chunk_spans, &mut cmin, &mut cmax);
        }
    }
    if verts.is_empty() { cmin = [0.0; 3]; cmax = [16.0; 3]; }
    let center = [
        (cmin[0] + cmax[0]) * 0.5,
        (cmin[1] + cmax[1]) * 0.5,
        (cmin[2] + cmax[2]) * 0.5,
    ];
    let size = (cmax[0]-cmin[0]).max(cmax[1]-cmin[1]).max(cmax[2]-cmin[2]).max(16.0);
    MapGeom { chunk_spans, verts, center, size, tex_rgba, tw, th, aw, ah, is_huge }
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


    // Fresh diagnostics file per run (see dlog).
    let _ = std::fs::write("sdmc:/3ds/voxelmon/pvlog.txt", "");
    dlog("[pv] boot");

    // Hold the pak resident, as the live scene renderer will need.
    println!("loading pak...");
    // Per-map paks: memory scales with the biggest map, not the map count.
    let gd = std::fs::read("sdmc:/3ds/voxelmon/paks/gamedata.json").unwrap_or_default();
    println!("gamedata {} KB", gd.len() / 1024);
    let gd_static: &'static [u8] = Box::leak(gd.into_boxed_slice());

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

    if !unsafe { load_map_pak("REDS_HOUSE_2F") } {
        unsafe { load_map_pak("PALLET_TOWN"); }
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
    };
    let mut chunk_infos: Vec<(Span, buffer::Info)> = Vec::new();
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
    let mut stream_center_chunk: Option<(i32, i32)> = None;
    // Snapshot of Scene.stamps_off.len() as of the last build_map — a cut
    // tree or the S.S. Anne hull toggling a stamp only mutates Scene state;
    // nothing else would ever tell this flat-buffer terrain path to rebuild.
    // Length-only is enough for every current caller (mapscripts.ts only
    // ever turns stamps OFF, never back on, within one map visit).
    let mut stamps_off_n: usize = 0;
    // Snapshot of scene.tint as of the last build_map — see build_map's
    // `tint` param doc: HM Flash changes this mid-visit and needs the same
    // kind of externally-triggered rebuild as a stamp toggle.
    let mut last_tint: u32 = 0xffff_ffff;
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
    const AUDIO_RATE: i32 = 11025;
    // audio.rs: the synth advances by exactly the frames you ask for, so a
    // tick must render one tick's worth (11025/60, rounded up) or the music
    // stretches.
    const AUDIO_FRAMES_PER_TICK: i32 = 184;
    const AUDIO_BUF: i32 = AUDIO_FRAMES_PER_TICK * 3;
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
                t.set_filter(texture::Filter::Nearest, texture::Filter::Nearest);
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
                fps_frames = 0; aud_ticks = 0; aud_queued = 0; fps_last = now;
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
                        let want = AUDIO_FRAMES_PER_TICK as usize;
                        voxel::scene().render_audio(pak_static, want, &mut pcm);
                        let got = audio3ds_queue(pcm.as_ptr(), want as i32);
                        aud_ticks += 1;
                        aud_queued += got as u32;
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
                                if unsafe { load_map_pak(nm) } {
                                    pak_static = unsafe { cur_pak() };
                                }
                            }
                            if let Some(ix) = map_ids.iter().position(|&m| m == want) {
                                map_i = ix;
                                reload = true;
                            }
                        }
                    }
                    // The guest owns which map you're standing in (mapShow).
                    let slot = &sc.maps[0];
                    if slot.shown {
                        let want = slot.map_id;
                        if map_ids.get(map_i).copied() != Some(want) {
                            if let Some(ix) = map_ids.iter().position(|&m| m == want) {
                                map_i = ix;
                                reload = true;
                            }
                        }
                    }
                    if sc.stamps_off.len() != stamps_off_n {
                        stamps_off_n = sc.stamps_off.len();
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
                }
            }
        }
        if d.contains(KeyPad::R) {
            map_i = (map_i + 1) % map_ids.len();
            reload = true;
        }
        if d.contains(KeyPad::L) {
            map_i = (map_i + map_ids.len() - 1) % map_ids.len();
            reload = true;
        }

        if reload {
            reload = false;
            // Load this map's own pak, then build from it.
            if let Some((_, nm)) = map_index.get(map_i) {
                if unsafe { load_map_pak(nm) } {
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
            stamps_off_n = stamps_off_snapshot.len();
            last_tint = scene_now.tint;
            geom = build_map(pak_static, map_ids[map_i], player_px, &stamps_off_snapshot, last_tint);
            cur_map_huge = geom.is_huge;
            {
                let tot: usize = geom.chunk_spans.iter().map(|s| s.end - s.start).sum();
                let over = geom.chunk_spans.iter().filter(|s| s.end - s.start > 65535).count();
                println!(
                    "chunks {} verts {} clipped {} huge {}",
                    geom.chunk_spans.len(), tot, over, cur_map_huge
                );
                dlog(&format!(
                    "[pv] built map#{} name={} spans={} verts={} huge={} tint={:08x}",
                    map_ids[map_i],
                    map_index.get(map_i).map(|(_, n)| n.as_str()).unwrap_or("?"),
                    geom.chunk_spans.len(),
                    tot,
                    cur_map_huge,
                    last_tint,
                ));
            }
            // Hold the outgoing window one reload past its replacement — see
            // chunk_infos_prev's declaration for why this matters here and
            // didn't for the old build-once-per-map-load behavior.
            chunk_infos_prev = core::mem::take(&mut chunk_infos);
            let mut upload_fail = 0u32;
            for s in geom.chunk_spans.iter() {
                let n = (s.end - s.start).min(65535);
                if n == 0 { continue; }
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
                        t.set_filter(texture::Filter::Nearest, texture::Filter::Nearest);
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
            45.0_f32.to_radians(),
            AspectRatio::TopScreen,
            ClipPlanes { near: 1.0, far: 100000.0 },
        ).stereo_matrices(sl, sr);
        let mut mvp_l = pl * camera;
        let mut mvp_r = pr * camera;
        let mut card_groups: Vec<(u16, Vec<Vertex>)> = Vec::new();
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
                    let (pw, ph) = (po2(pg.w as u32) as f32, po2(pg.h as u32) as f32);
                    let (u1, v1) = (pg.w as f32 / pw, pg.h as f32 / ph);
                    let sx = |v: f32| ((v / 480.0) * 400.0) as i16;
                    let sy = |v: f32| ((v / 272.0) * 240.0) as i16;
                    let (x0, y0) = (sx(*x), sy(*y));
                    let (x1, y1) = (sx(*x + *w), sy(*y + *h));
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
                    // Tile rows use the atlas's real width; UVs then divide
                    // by the po2 padded width.
                    let cols = ((pg.w as u32 / 8) as u16).max(1);
                    let tx0 = (*tile % cols) as f32 * 8.0;
                    let ty0 = (*tile / cols) as f32 * 8.0;
                    let (pw, ph) = (po2(pg.w as u32) as f32, po2(pg.h as u32) as f32);
                    // Same V flip the world uses (uv mode 5): texture rows
                    // are stored inverted relative to the UV convention.
                    let (u0, u1) = (tx0 / pw, (tx0 + 8.0) / pw);
                    let (v0, v1) = (1.0 - ty0 / ph, 1.0 - (ty0 + 8.0) / ph);
                    let sx = |v: f32| ((v / 480.0) * 400.0) as i16;
                    let sy = |v: f32| ((v / 272.0) * 240.0) as i16;
                    let (x0, y0) = (sx(*x), sy(*y));
                    let (x1, y1) = (sx(*x + *w), sy(*y + *h));
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
                    let sx = pg.w as f32 / po2(pg.w as u32) as f32;
                    let sy = pg.h as f32 / po2(pg.h as u32) as f32;
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
                    let mk = |pt: ([f32; 3], f32, f32)| Vertex {
                        pos: { let d = disp(pt.0);
                               [(d[0] - sox + 8.0) as i16, d[1] as i16,
                                (d[2] - soy + 8.0) as i16, 0] },
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
                        t.set_filter(texture::Filter::Nearest, texture::Filter::Nearest);
                        page_tex[i] = Some(t);
                    }
                }
            }
        }
        let card_bufs: Vec<(usize, buffer::Info)> = card_groups.iter().filter_map(|(pg, v)| {
            if v.is_empty() { return None; }
            let mut bi = buffer::Info::new();
            let n = v.len().min(65535);
            bi.add(buffer::Buffer::new(&v[..n]), attr_info.permutation()).ok()?;
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
                    t.set_filter(texture::Filter::Nearest, texture::Filter::Nearest);
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
                        t.set_filter(texture::Filter::Nearest, texture::Filter::Nearest);
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
            let cols = ((pg.w as u32 / 8) as u16).max(1);
            let (pw, ph) = (po2(pg.w as u32) as f32, po2(pg.h as u32) as f32);
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
                    let tx0 = (tile % cols) as f32 * 8.0;
                    let ty0 = (tile / cols) as f32 * 8.0;
                    let (u0, u1) = (tx0 / pw, (tx0 + 8.0) / pw);
                    let (v0, v1) = (1.0 - ty0 / ph, 1.0 - (ty0 + 8.0) / ph);
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
                        t.set_filter(texture::Filter::Nearest, texture::Filter::Nearest);
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
                for (span, bi) in infos_ref.iter() {
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
                        0.0..400.0, 240.0..0.0,
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
                        0.0..400.0, 240.0..0.0,
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
                for (pg, ci) in card_bufs.iter() {
                    if let Some(t) = page_tex_ref.get(*pg).and_then(|o| o.as_ref()) {
                        frame.bind_texture(texture::Index::Texture0, t);
                    }
                    frame.draw_arrays(buffer::Primitive::Triangles, ci, None).unwrap();
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
