//! pocket-voxel 3DS host for the gen3 (FireRed) port (GPLv3 + additional
//! terms; see LICENSE.md). FireRed runs in the shared world loop (main.rs's
//! `main`, the one Red..Crystal run): the paks, the terrain, the seam strips,
//! the tree instances, the camera, stereo and the perf lines are all that
//! loop's. What is FireRed's own comes in through the hooks below, each
//! called from main.rs as a `#[cfg(feature = "gen3")]` statement added at
//! the END of an existing line, so no line of main.rs moves and Red..Crystal
//! build byte-identical:
//!
//! - **The 2D layer.** The guest (game-firered.js) records a draw list per
//!   shown frame (g3Draw). [`offscreen_pass`] -- first thing in the frame --
//!   draws it into the 240x160 frame texture (g3_render.c, as before), and
//!   [`composite`] -- last thing in each eye's pass -- lays that texture over
//!   the top screen at 1.5x, as Gold lays its lcd: where the guest drew (text
//!   boxes, menus, battles, VIEW 2D's whole field) it covers the world, and
//!   where it left the frame clear the world shows (worldview.ts clears the
//!   frame to alpha 0 while the field is the world).
//! - **The people.** The guest's billboards (g3Ents: sprite frames of the
//!   2D layer's own textures, standing in their cells) are turned into quads
//!   facing the scene's camera ([`prepare_billboards`], once a frame) and
//!   drawn in each eye's world pass, depth-tested against the terrain
//!   ([`world_pass`]). Two more kinds ride the same records: decals flat on
//!   the floor (the ground's field effects) and decals on a facade leaned
//!   back as the cook leans it (the door animations).
//! - **The lean.** The cook stores buildings and prop cards upright and
//!   lean-coded (voxelmon/cook/gen3terrain.ts, "the lean code");
//!   [`lean_on`] swaps in g3_world.pica around main.rs's terrain and tree
//!   loops, which leans the facades back for the camera's pitch (as much as
//!   the camera faces them) and turns the cards to face it, with this
//!   frame's numbers ([`lean_frame`]). [`lean_vert`] hands a coded vertex to
//!   it untinted, as main.rs builds each pak vertex.
//! - **Sound** is the M4A engine (audio.rs) on its own thread, started
//!   before the guest boots ([`before_guest`]); the Kanto synth stays off
//!   (main.rs's `audio3ds_init` is replaced for this build and says so).
//! - **The pace.** 60 frames a second on a New 3DS while a frame fits in a
//!   vblank, else 30, the game ticking at 60 either way (pace.rs).
//! - **Memory.** The 2D layer's textures live in linear memory beside the
//!   map's vertices, so the map plans for less ([`map_cap`]); FireRed's paks
//!   are small, so its pak cache is too, leaving the heap to QuickJS
//!   ([`size_pak_cache`]).

use citro3d::macros::include_shader;
use citro3d::math::Matrix4;
use pocketvoxel_core::{cam, draw};

use super::{dlog, JSContext};

/// This game's folder on the card: FireRed's and LeafGreen's data and saves
/// sit side by side (they share paks_firered, as Red and Blue share paks).
#[cfg(not(feature = "leafgreen"))]
macro_rules! g3_root { () => { "sdmc:/3ds/voxelmon/firered/" } }
#[cfg(feature = "leafgreen")]
macro_rules! g3_root { () => { "sdmc:/3ds/voxelmon/leafgreen/" } }

mod audio;
mod pace;
mod shared;
mod watch;
pub use shared::{pak_bytes, pak_vec, shared_attach, shared_plan, shared_release};
pub use pace::{after_render, borrow_tick, frame_top, mark, step_begin};
pub use watch::{make_room, note_upload, squeeze_heap};

extern "C" {
    fn g3_gpu_init_shared(shbin: *const u8, len: u32) -> i32;
    fn g3_frame_offscreen();
    fn g3_perf(out: *mut f32);
    fn g3_shot(path: *const u8) -> i32;
    fn g3_ents_get(n: *mut i32) -> *const f32;
    fn g3_bb_reset();
    fn g3_bb_quad(tex: i32, xyz: *const f32, u0: f32, v0: f32, u1: f32, v1: f32, alpha: f32);
    fn g3_bb_draw(mvp: *const core::ffi::c_void);
    fn g3_composite();
    fn qjs_register_g3(ctx: *mut JSContext) -> i32;
    fn g3_set_bytecode(p: *const u8, n: usize);
    fn g3_files_root(root: *const u8);
    fn g3_save_root(root: *const u8);
    fn g3_heap_info(asked_kb: *mut u32, got_kb: *mut u32, steps: *mut u32);
    fn g3_flush_dead_targets();
    fn g3_host_keys_get() -> u32;
    fn g3_cmd_used(size: *mut i32) -> i32;
    fn g3_world_init(wsh: *const u8, wlen: u32, msh: *const u8, mlen: u32) -> i32;
    fn g3_world_params(p: *const f32);
    fn g3_world_on();
    fn g3_world_off();
}

/// The world shader (g3_world.pica): main.rs's vshader.pica plus the lean.
static G3_WORLD_SHADER: &[u8] = include_shader!("g3_world.pica");

/// The guest as QuickJS bytecode (cc_build_firered.sh: the bundle compiled on
/// the PC with its source stripped; empty when the build boots the source,
/// build.rs). With it, what main.rs evaluates is only
/// `voxel.g3RunBytecode()` (g3_shim.c), so the console never parses the
/// bundle nor keeps each function's source.
static G3_BYTECODE: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/g3.qbc"));

/// Linear memory kept back from the map's vertex plan for the 2D layer:
/// the frame texture and canvases are VRAM, but every guest texture (fonts,
/// window frames, sprite sheets, battle pictures) is a linear RGBA8 copy,
/// and two 590 KB vertex buffers ride there too.
const G3_LINEAR_KB: usize = 8 * 1024;

/// FireRed's pak cache. Its paks are small (with the DramaticShapes world a
/// town is ~1.6 MB, a route ~2.3), and the heap is wanted by the Gen 3
/// runtime's QuickJS heap far more than by maps the player has walked away
/// from: room for the map in use, the one before it and the neighbour being
/// read ahead. (It was 6 MB, but every build let the cache go then:
/// BUILD_HEAP_MB below; kept now, it counts, and the app heap's high water
/// came within 4 MB of its end.)
const G3_PAK_CACHE_KB: usize = 5 * 1024;

static mut GPU_OK: bool = false;
static mut LEAN_OK: bool = false;
/// This frame's facade lean (radians back from upright), for the door decals.
static mut LEAN_F: f32 = 0.0;
static mut SOUND_ON: bool = false;

/// Linear memory a hidden world (flatWorld: a battle) may be kept in when it
/// hides: the battle's own pictures still to come take about 2.5 MB more.
const KEEP_MIN_KB: usize = 4608;
/// Kept, and linear has run this low meanwhile: the world goes (the flat
/// rebuild, as before), so the 2D layer's next textures have room.
const KEEP_LOW_KB: usize = 2048;
static mut KEEPING: bool = false;

/// Just before main.rs's rebuild (a same-line hook clears its `reload`
/// when this says so). The world hidden for a battle used to be rebuilt
/// flat at once -- its vertex buffers, seam strips, trees and terrain
/// texture freed -- and rebuilt in full the frame the battle ended: the
/// rebuild was 320 ms of host time (most of it the seam strips, re-read
/// from the card) on the first frame back on the field. Now the built world
/// is kept while hidden, undrawn, when linear memory allows, and coming back
/// costs nothing; the rebuild still runs when the map itself changed
/// (`same_map` false), when the world was already flat, or when linear
/// memory is short (then exactly as before).
pub fn hold_rebuild(hidden: bool, built_flat: bool, same_map: bool, free_kb: usize) -> bool {
    let keeping = unsafe { KEEPING };
    if !hidden || built_flat || !same_map {
        if keeping {
            unsafe { KEEPING = false };
            if !hidden { dlog("[pv] g3 world: shown again as kept (no rebuild)"); }
        }
        return false;
    }
    if !keeping {
        if free_kb < KEEP_MIN_KB {
            dlog(&format!("[pv] g3 world: hidden, let go (linear {} KB)", free_kb));
            return false;
        }
        unsafe { KEEPING = true };
        dlog(&format!("[pv] g3 world: hidden, kept (linear {} KB)", free_kb));
    }
    if free_kb < KEEP_LOW_KB {
        unsafe { KEEPING = false };
        dlog(&format!("[pv] g3 world: hidden, linear down to {} KB: let go", free_kb));
        return false;
    }
    true
}

extern "C" {
    fn linearAlloc(size: usize) -> *mut core::ffi::c_void;
    fn linearFree(p: *mut core::ffi::c_void);
}

/// The terrain texture's slot in linear memory: every FireRed map's terrain
/// texture is made 256 x 1024 RGBA8 (tex_dims; the shader's UV scale is
/// aw/tw, ah/th, so the picture is the same), and when no terrain texture
/// holds the slot -- a build's upload in progress, a flat build -- this
/// block does. main.rs makes the texture with expect("tex"), and the 2D
/// layer's textures, made and let go all session, leave linear memory in
/// pieces: the leak bench's tour died there twice ("tex:
/// FailedToInitialize"), once with 1 MB of linear free and once with 6 MB
/// free but no single block of 1 MB. One block of the one size, handed from
/// texture to texture, is always there.
const TEX_SLOT_W: u32 = 256;
const TEX_SLOT_H: u32 = 1024;
const TEX_SLOT_BYTES: usize = (TEX_SLOT_W * TEX_SLOT_H * 4) as usize;
static mut TEX_HOLD: *mut core::ffi::c_void = core::ptr::null_mut();

/// build_map's terrain texture size (a same-line hook after main.rs's po2
/// sizing): the slot's, for any page that fits it.
pub fn tex_dims(tw: u32, th: u32) -> (u32, u32) {
    if tw <= TEX_SLOT_W && th <= TEX_SLOT_H { (TEX_SLOT_W, TEX_SLOT_H) } else { (tw, th) }
}

/// Before a build's upload (a same-line hook in main.rs, after the last
/// map's buffers, its trees and -- earlier in the rebuild -- its terrain
/// texture are let go): the slot is taken, so the spans, strips and trees
/// that go up before the texture give way when linear runs short (a far
/// span or a tree shape left out, as they already are) and the texture has
/// its block.
pub fn tex_reserve() {
    unsafe {
        if !TEX_HOLD.is_null() {
            return; // (still held since a flat build)
        }
        TEX_HOLD = linearAlloc(TEX_SLOT_BYTES);
        if TEX_HOLD.is_null() {
            dlog(&format!(
                "[pv] g3 build: WARNING no linear block of {} KB for the terrain texture (linear free {} KB)",
                TEX_SLOT_BYTES / 1024,
                super::unsafe_free_kb(),
            ));
        }
    }
}

/// Just before main.rs makes the terrain texture (tw x th): the slot goes
/// back for it to take -- unless the texture is a flat build's 8 x 8, which
/// goes elsewhere while the slot stays held for the next real one.
pub fn tex_release(tw: u32, th: u32) {
    unsafe {
        if !TEX_HOLD.is_null() && (tw as usize * th as usize * 4) > TEX_SLOT_BYTES / 2 {
            linearFree(TEX_HOLD);
            TEX_HOLD = core::ptr::null_mut();
        }
    }
}

/// Whether the built world is being kept, undrawn, through a battle (watch.rs).
pub fn keeping() -> bool {
    unsafe { KEEPING }
}

/// The map build's vertex segments (main.rs VertStore) for FireRed: 16K
/// vertices (320 KB) where the Kanto builds take two GPU slices (2.6 MB).
/// try_reserve takes the plan's vertices in whole segments plus one, so even
/// a house of a few hundred vertices asked for two 2.6 MB blocks; a long
/// session's app heap (the leak bench's tour: 95 of 96 MB at its high
/// water, in pieces) could not give them, the plan halved to nothing and the
/// map came out empty -- bare sky, only the billboards drawn. FireRed's
/// meshes are small; one bigger than a segment still gets a block of its own
/// size (begin_span).
pub const SEG_VERTS: usize = 16384;

/// The heap a map build wants free in one block before it starts (main.rs
/// BUILD_HEAP_MB, 16 for Kanto and Johto, whose builds staged a route's
/// vertices in one ~6 MB block). FireRed's build stages its vertices in
/// segments (the segmented VertStore) and asks for each fallibly; the largest
/// single ask is its terrain texture's pixels, 1 MB at most. With 16 -- or 8
/// -- a QuickJS heap of 60 MB or more never left such a block (the log: 2 to
/// 4 MB), so every build let the whole pak cache go first and every door back
/// out of a house read the town's pak from the card again (320 ms on Citra).
pub const BUILD_HEAP_MB: usize = 2;
/// The headroom a read-ahead must leave behind it (main.rs PREFETCH_HEAP_MB,
/// 16): with that, FireRed's heap refused nearly every read-ahead, and the
/// map across a seam was read in the crossing frame (440 ms for a route).
pub const PREFETCH_HEAP_MB: usize = 4;
/// A read-ahead's slice (main.rs PREFETCH_SLICE, 64 KB: ~6 ms of the card on
/// hardware, which a 60 fps frame has no room for).
pub const PREFETCH_SLICE: usize = 16 * 1024;

/// The time a frame gives the read-ahead (main.rs's 12 ms, 24 near the
/// map's edge, sized for Kanto's 30 fps): what a 60 fps frame has left over
/// -- at the 30 fps pace too, where a frame's two ticks already take most of
/// its 33 ms (6 ms there made the frames after a door miss their beat) -- a
/// little more near the edge, more while a warp's door and fade play.
pub fn prefetch_budget(kanto_ms: u64) -> u64 {
    if warp_read_in_flight() {
        return 6;
    }
    if kanto_ms > 12 { 3 } else { 2 }
}

extern "C" {
    fn g3_read_ahead_take() -> *const core::ffi::c_char;
}

/// The map a warp is going to, while its read-ahead is in flight.
static mut WARP_TARGET: Option<String> = None;

/// main.rs's read-ahead step (a same-line hook at its top): a warp the guest
/// has just begun (core/warp.ts announce -> g3ReadAhead) has its map's pak
/// read during the door and the fade, a slice a frame, instead of in the
/// first frame of the new map (320 ms for a town on Citra, every visit the
/// cache did not keep it). The neighbour being read ahead gives way -- the
/// warp leaves this map -- and so do cached maps other than the one in use,
/// if the cache has no room. main.rs's load adopts the read where it got to.
#[allow(static_mut_refs)]
pub fn warp_read_ahead() {
    let p = unsafe { g3_read_ahead_take() };
    if p.is_null() {
        return;
    }
    let name = unsafe { core::ffi::CStr::from_ptr(p) }.to_string_lossy().into_owned();
    unsafe {
        if super::PAK_CACHE.iter().any(|c| c.name == name) {
            dlog(&format!("[pv] g3 warp to {}: its pak is cached", name));
            return;
        }
        if super::PREFETCH.as_ref().is_some_and(|pf| pf.name == name) {
            WARP_TARGET = Some(name);
            return;
        }
        super::PREFETCH = None;
        let path = format!("{}/{}.vxpak", super::PAKS_DIR, name);
        let kb = std::fs::metadata(&path).map(|m| (m.len() / 1024) as usize).unwrap_or(0);
        if kb == 0 {
            return;
        }
        while super::cache_total_kb() + kb > super::PAK_CACHE_BUDGET_KB && super::evict_lru(true) {}
        super::PREFETCH_TRIED.retain(|n| n != &name);
        let ok = super::prefetch_start(&name);
        dlog(&format!("[pv] g3 warp to {}: read ahead {} ({} KB)", name, if ok { "begun" } else { "refused" }, kb));
        if ok {
            WARP_TARGET = Some(name);
        }
    }
}

/// The map the cache was last trimmed for, and the one before it.
static mut ROOM_FOR: u32 = u32::MAX;
static mut ROOM_PREV: u32 = u32::MAX;

/// main.rs's read-ahead step (the same hook line): once on each map, the
/// cached maps that are neither it, the map just left, nor one of its
/// neighbours are let go. main.rs's read-ahead refuses a map that does not
/// fit beside what is cached rather than push anything out (Kanto's rule,
/// for the map underfoot), so a cache full of maps walked away from -- the
/// town before the last warp, its routes -- read nothing ahead again: in
/// Viridian the route south was read in the crossing frame, 440 ms, every
/// time. (The map in use is never let go.)
#[allow(static_mut_refs)]
pub fn prefetch_room(map_index: &[(u32, String)], cur: u32) {
    unsafe {
        if ROOM_FOR == cur {
            return;
        }
        ROOM_PREV = ROOM_FOR;
        ROOM_FOR = cur;
    }
    pak_budget_refresh();
    let sc = unsafe { super::voxel::scene() };
    let name_of = |id: u32| map_index.iter().find(|(m, _)| *m == id).map(|(_, n)| n.as_str());
    let mut keep: Vec<&str> = Vec::new();
    for id in [cur, unsafe { ROOM_PREV }] {
        if let Some(n) = name_of(id) { keep.push(n); }
    }
    for i in 1..sc.maps.len() {
        if sc.maps[i].shown {
            if let Some(n) = name_of(sc.maps[i].map_id) { keep.push(n); }
        }
    }
    unsafe {
        let before = super::cache_total_kb();
        let in_use = super::PAK_IN_USE;
        super::PAK_CACHE.retain(|c| keep.contains(&c.name.as_str()) || core::ptr::eq(&**c as *const super::CachedPak, in_use));
        let after = super::cache_total_kb();
        if after < before {
            dlog(&format!("[pv] g3 pak cache: {} KB of maps walked away from let go ({} KB kept)", before - after, after));
        }
    }
}

/// Whether the read in flight is a warp's (its frames are a door and a
/// fade: the read may take more of them).
#[allow(static_mut_refs)]
fn warp_read_in_flight() -> bool {
    unsafe {
        let hit = match (&WARP_TARGET, super::PREFETCH.as_ref()) {
            (Some(t), Some(pf)) => &pf.name == t,
            _ => false,
        };
        if !hit {
            WARP_TARGET = None;
        }
        hit
    }
}

/// A map id no connection has: given as the map a crossing came from, it
/// makes main.rs defer every seam strip.
const NO_MAP: u32 = u32::MAX;

/// main.rs's seam strips after a map change: a crossing builds the strip
/// behind the player at once and defers the rest; a warp (a door, the
/// first frame back on the field) built all of them in its one frame --
/// 257 ms for Viridian's three, read from the card. In FireRed a warp
/// defers them all too (they are at the map's far edges, and arrive a
/// slice a frame during the fade-in): `crossing_from` None becomes a map no
/// strip belongs to.
pub fn strips_later(crossing_from: Option<u32>) -> Option<u32> {
    crossing_from.or(Some(NO_MAP))
}

/// The map vertex cap with the 2D layer's linear share taken off (main.rs
/// hands the result to mapplan on its next line).
pub fn map_cap(free_kb: usize, cap: usize) -> usize {
    let side = (super::MAP_LINEAR_SIDE_KB + G3_LINEAR_KB) * 1024;
    let c = ((free_kb * 1024).saturating_sub(side) / core::mem::size_of::<super::Vertex>()).max(super::MAP_CAP_FLOOR_VERTS);
    dlog(&format!("[pv] g3: map vertex cap {} (the Kanto sizing said {}; {} KB kept for the 2D layer)", c, cap, G3_LINEAR_KB));
    c
}

/// FireRed's own (small) pak cache budget, after the shared sizing: its
/// opening figure, sized again from the app heap on every map
/// ([`pak_budget_refresh`]).
pub fn size_pak_cache() {
    unsafe { super::PAK_CACHE_BUDGET_KB = G3_PAK_CACHE_KB };
    dlog(&format!("[pv] g3: pak cache {} MB (FireRed's paks are small)", G3_PAK_CACHE_KB / 1024));
}

extern "C" {
    fn g3_heap_use(size: *mut u32, used: *mut u32);
}

/// The app heap the pak cache leaves to everything else: QuickJS's garbage
/// between collections (g3_shim.c g3_gc_arm, up to 6 MB), a map build's
/// staging (a few MB) and a margin.
const PAK_HEADROOM_KB: usize = 14 * 1024;
/// The pak cache's bounds: room for a town and the house beside it at the
/// least; past the most, the cache holds maps the player has walked away from.
const PAK_MIN_KB: usize = 1536;
const PAK_MAX_KB: usize = 6 * 1024;

/// The pak cache sized from the app heap this console granted and what is in
/// use now (once a map, prefetch_room): half of what is free beyond
/// PAK_HEADROOM_KB -- counting what the cache and a read-ahead already hold
/// as free, so the figure does not swing with the cache itself -- between
/// PAK_MIN_KB and PAK_MAX_KB. Early in a session that is the most; as the
/// session's heap grows (a console that granted less, or a long play) the
/// cache gives way. A fixed 5 MB took the app heap's high water within 4 MB
/// of its end.
#[allow(static_mut_refs)]
fn pak_budget_refresh() {
    let (mut size, mut used) = (0u32, 0u32);
    unsafe { g3_heap_use(&mut size, &mut used) };
    let held = unsafe { super::cache_total_kb() + super::PREFETCH.as_ref().map(|p| p.buf.len() / 1024).unwrap_or(0) };
    let avail = (size.saturating_sub(used) / 1024) as usize + held;
    let want = (avail.saturating_sub(PAK_HEADROOM_KB) / 2).clamp(PAK_MIN_KB, PAK_MAX_KB);
    let was = unsafe { super::PAK_CACHE_BUDGET_KB };
    unsafe { super::PAK_CACHE_BUDGET_KB = want };
    if want.abs_diff(was) >= 512 {
        dlog(&format!("[pv] g3 pak cache: {} KB (was {}; app heap {} KB free beside {} KB the cache holds)", want, was, avail - held, held));
    }
    // over the new budget: the least recent maps go now (never the one in use)
    unsafe {
        while super::cache_total_kb() > want && super::PAK_CACHE.len() > 1 && super::evict_lru(true) {}
    }
}

/// Before the guest is evaluated: the 2D layer's GPU side, the sound (so
/// the guest finds it at load) and the gen3 natives.
pub fn before_guest() {
    let _ = std::fs::create_dir_all(g3_root!());
    // the app heap g3_heap.c's start asked for and got (the kernel can grant
    // less than the resource limit reports; the start steps down until it fits)
    {
        let (mut a, mut g, mut s) = (0u32, 0u32, 0u32);
        unsafe { g3_heap_info(&mut a, &mut g, &mut s) };
        dlog(&format!("[pv] g3 heap: asked {} KB, got {} KB ({} step(s) down)", a, g, s));
    }
    // the cache/pack reader's folder (g3_files.c defaults to FireRed's)
    unsafe { g3_files_root(concat!(g3_root!(), "\0").as_ptr()) };
    // the save store (g3_save.c): the game's saves and options, under save/
    let _ = std::fs::create_dir_all(concat!(g3_root!(), "save"));
    unsafe { g3_save_root(concat!(g3_root!(), "save/\0").as_ptr()) };
    let lin0 = super::unsafe_free_kb();
    let gi = unsafe { g3_gpu_init_shared(super::SHADER_BYTES.as_ptr(), super::SHADER_BYTES.len() as u32) };
    unsafe { GPU_OK = gi == 1 };
    if gi != 1 {
        dlog(&format!("[pv] g3: 2D layer GPU init FAILED (step {})", -gi));
    }
    let wi = unsafe {
        g3_world_init(
            G3_WORLD_SHADER.as_ptr(),
            G3_WORLD_SHADER.len() as u32,
            super::SHADER_BYTES.as_ptr(),
            super::SHADER_BYTES.len() as u32,
        )
    };
    unsafe { LEAN_OK = wi == 1 };
    dlog(&format!("[pv] g3: world lean shader {}", if wi == 1 { "ready" } else { "FAILED (buildings and cards stand upright)" }));
    let sound = audio::init();
    unsafe { SOUND_ON = sound };
    unsafe { g3_set_bytecode(G3_BYTECODE.as_ptr(), G3_BYTECODE.len()) };
    unsafe { qjs_register_g3(super::CTX) };
    dlog(&format!(
        "[pv] g3: 2D layer {}, sound {}, linear {} KB -> {} KB",
        if gi == 1 { "ready" } else { "off" },
        if sound { "on" } else { "off" },
        lin0,
        super::unsafe_free_kb(),
    ));
}

/// First thing in the frame (inside citro3d's frame, before the eyes): the
/// guest's newest draw list into the frame texture, and the people's quads
/// for this frame's camera.
/// The command buffer's high water, logged when a frame passes three
/// quarters of it (CMDBUF_BYTES), so a heavier view shows up long before
/// it can overflow.
static mut CMD_HW: i32 = 0;
fn cmd_check() {
    let mut size = 0i32;
    let used = unsafe { g3_cmd_used(&mut size) };
    if used > unsafe { CMD_HW } {
        unsafe { CMD_HW = used };
        if used * 4 > size * 3 {
            dlog(&format!("[pv] g3 cmdbuf: WARNING {} words of {}", used, size));
        }
    }
}
/// Just before the render call (main.rs), outside C3D_FrameBegin..End:
/// the canvases due to go are deleted here, the one place citro3d allows it
/// (g3_flush_dead_targets), then the pace's timing mark.
pub fn before_render() {
    watch::frame(unsafe { super::DRAWN });
    if unsafe { GPU_OK } {
        unsafe { g3_flush_dead_targets() };
    }
    pace::before_render();
}

pub fn offscreen_pass() {
    pace::render_start();
    lean_frame();
    if !unsafe { GPU_OK } {
        return;
    }
    unsafe { g3_frame_offscreen() };
    prepare_billboards();
}

/// The roof's rise toward its back edge (gen3terrain.ts ROOF_RISE_DEG).
const G3_ROOF_RISE_DEG: f32 = 12.0;

/// The mod's card lean for a view `a` radians from straight down:
/// main.lua:109's (90 - tilt) * 0.8 degrees, none for a view level or above.
fn card_lean(a: f32) -> f32 {
    let deg = (90.0 - a.to_degrees()) * 0.8;
    deg.clamp(0.0, 72.0).to_radians()
}

/// How much of the card lean the facades (and built props) take for a
/// camera `yaw` radians from looking north: all of it within 10 degrees,
/// none past 28, a smoothstep between -- so a building is a true box as soon
/// as the camera has turned from its front, not a slanted one.
fn facade_weight(yaw: f32) -> f32 {
    let (full, none) = (10f32.to_radians(), 28f32.to_radians());
    let t = ((none - yaw.abs()) / (none - full)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// This frame's lean (g3_world.pica's uniforms), from the camera the world
/// is drawn with: the facade lean is the card lean times facade_weight of
/// the camera's yaw; the foliage cards face the camera's yaw and take the
/// card lean whole.
fn lean_frame() {
    let sc = unsafe { super::voxel::scene() };
    let camera = draw::camera(sc);
    let (e, f) = (camera.eye, camera.focus);
    let (dx, dy, dz) = (f.x - e.x, f.y - e.y, f.z - e.z);
    let a = (dx * dx + dz * dz).sqrt().atan2(-dy);
    let (fx, fz) = cam::forward_h(&camera);
    let lean = card_lean(a);
    let fw = facade_weight(fx.atan2(-fz));
    let lf = lean * fw;
    // the lying props (north-south fences): the card lean at the default
    // view, down to flat as the facade lean fades
    let lie = lean * fw + core::f32::consts::FRAC_PI_2 * (1.0 - fw);
    unsafe { LEAN_F = lf };
    let t = G3_ROOF_RISE_DEG.to_radians().tan();
    // the rest lean every coded vertex is stored at (gen3terrain.ts CARD_LEAN)
    let l0 = ((90.0f32 - 35.0) * 0.8).to_radians();
    let (s0, c0) = (l0.sin(), l0.cos());
    let tint = super::geometry_tint(sc.tint);
    let ch = |s: u32| ((tint >> s) & 0xff) as f32 / 255.0;
    let p: [f32; 16] = [
        lf.sin() - s0, lf.cos() - c0, t * (lf.sin() - s0), 1.0 - fw,
        -fz, fx, fx * lean.sin(), fz * lean.sin(),
        lean.cos() - c0, lie.sin() - s0, lie.cos() - c0, s0,
        ch(0), ch(8), ch(16), 1.0,
    ];
    unsafe { g3_world_params(p.as_ptr()) };
}

/// Before main.rs's terrain spans and tree instances (each eye): the world
/// shader in. [`world_pass`], right after them, puts main.rs's back.
pub fn lean_on() {
    if unsafe { LEAN_OK } {
        unsafe { g3_world_on() };
    }
}

/// A pak vertex as main.rs just built it, fixed up for the world shader: a
/// lean-coded one (alpha below 255) keeps its colour bytes untinted -- they
/// are its numbers -- and its spare i16. Others are left as they are.
#[inline]
pub fn lean_vert(v: &mut super::Vertex, abgr: u32, w: i16) {
    if abgr >> 24 != 0xff {
        v.color = [abgr as u8, (abgr >> 8) as u8, (abgr >> 16) as u8, (abgr >> 24) as u8];
        v.pos[3] = w;
    }
}

/// The spare i16 of vertex `i` of a raw pak vertex pool (16-byte records).
#[inline]
pub fn pool_w(vbuf: &[u8], i: usize) -> i16 {
    vbuf.get(i * 16 + 14..i * 16 + 16).map(|b| i16::from_le_bytes([b[0], b[1]])).unwrap_or(0)
}

/// The guest's billboards as quads: a card stands on the floor of its cell
/// (the same floor the Kanto cards stand on), leaned back to face the eye as
/// draw::card_verts leans them; a ground decal lies on that floor; a wall
/// decal stands on it leaned back by its own angle, facing south as the
/// cook's facades do (voxelmon/cook/gen3terrain.ts). All are pulled toward
/// the eye the way main.rs pulls the cards (a card by its record's extra
/// pull too, so grass over the feet or a balloon over a head wins against
/// the person it sits on), so a wall behind does not cut into them.
fn prepare_billboards() {
    unsafe { g3_bb_reset() };
    let mut n = 0i32;
    let recs = unsafe { g3_ents_get(&mut n) };
    if recs.is_null() || n <= 0 {
        return;
    }
    let recs = unsafe { core::slice::from_raw_parts(recs, n as usize * ENT_FLOATS) };
    let sc = unsafe { super::voxel::scene() };
    let slot = &sc.maps[0];
    if !slot.shown || sc.flat_world {
        return;
    }
    let (sox, soy) = (slot.ox as f32, slot.oy as f32);
    let camera = draw::camera(sc);
    let (fx, fz) = cam::forward_h(&camera);
    let pull = draw::card_pull(camera.a);
    let e = camera.eye;
    for r in recs.chunks_exact(ENT_FLOATS) {
        let (x, z) = (r[1] - sox, r[2] - soy);
        let (w, h) = (r[4], r[5]);
        let kind = r[11] as i32;
        let (v, pull_here) = match kind {
            ENT_GROUND => {
                // flat on the floor of its middle, a hair above it
                let y = sc.floor.height_at(x, z) + r[3] + 0.25;
                let (x0, x1, z0, z1) = (x - w * 0.5, x + w * 0.5, z - h * 0.5, z + h * 0.5);
                ([[x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0]], 1.0)
            }
            ENT_WALL => {
                // the floor in front of the foot (the foot is a cell's south
                // edge), leaned back as the facades are this frame (the
                // record's lean is the cook's rest lean)
                let y = sc.floor.height_at(x, z + 1.0) + r[3];
                let lean = if unsafe { LEAN_OK } { unsafe { LEAN_F } } else { r[12] };
                let (sl, cl) = (lean.sin(), lean.cos());
                let (x0, x1) = (x - w * 0.5, x + w * 0.5);
                let (yt, zt) = (y + h * cl, z - h * sl);
                ([[x0, y, z], [x1, y, z], [x1, yt, zt], [x0, yt, zt]], 0.75)
            }
            _ => {
                let ground = sc.floor.height_at(x, z);
                let feet = pocketvoxel_core::math::vec3(x, ground + r[3], z);
                (draw::card_verts(feet, w, h, camera.a, fx, fz), pull + r[12])
            }
        };
        let mut xyz = [0f32; 12];
        for (i, q) in v.iter().enumerate() {
            let (dx, dy, dz) = (e.x - q[0], e.y - q[1], e.z - q[2]);
            let l = (dx * dx + dy * dy + dz * dz).sqrt().max(1e-6);
            xyz[i * 3] = q[0] + dx / l * pull_here;
            xyz[i * 3 + 1] = q[1] + dy / l * pull_here;
            xyz[i * 3 + 2] = q[2] + dz / l * pull_here;
        }
        unsafe { g3_bb_quad(r[0] as i32, xyz.as_ptr(), r[6], r[7], r[8], r[9], r[10]) };
    }
}

/// A billboard record's floats (worldview.ts ENT_FLOATS).
const ENT_FLOATS: usize = 13;
/// A record's kinds (worldview.ts ENT_*): a card is anything else.
const ENT_GROUND: i32 = 1;
const ENT_WALL: i32 = 2;

/// In each eye's world pass, after the terrain and the trees: the people.
pub fn world_pass(mvp: &Matrix4) {
    unsafe { g3_world_off() };
    if !unsafe { GPU_OK } {
        return;
    }
    unsafe { g3_bb_draw(mvp.as_raw() as *const _ as *const core::ffi::c_void) };
}

/// Last in each eye's pass: the 2D layer over everything.
pub fn composite() {
    if !unsafe { GPU_OK } {
        return;
    }
    unsafe { g3_composite() };
    cmd_check();
}

/// The perf block's extra lines (every 5 s): the 2D layer's and the sound's.
pub fn perf_line() {
    pace::perf_line();
    if unsafe { GPU_OK } {
        let mut p = [0f32; 10];
        unsafe { g3_perf(p.as_mut_ptr()) };
        let fr = p[0].max(1.0);
        dlog(&format!(
            "[pv] g3 2D layer: {:.0} frames, {:.0} lists  build {:.2} ms  per list: {:.0} quads {:.0} tris {:.0} calls {:.0} verts  variants {:.0}  dropped {:.0}",
            p[0], p[1], p[7],
            p[2] / p[1].max(1.0), p[3] / p[1].max(1.0), p[4] / fr, p[5] / fr, p[6], p[9],
        ));
    }
    if unsafe { SOUND_ON } {
        dlog(&format!("[pv] g3 {}", audio::take_stats(5.0)));
    }
}

/// With main.rs's screenshot: the 2D layer alone too (g3shot_N.ppm).
pub fn shot(n: u32) {
    if !unsafe { GPU_OK } {
        return;
    }
    let path = format!(concat!(g3_root!(), "g3shot_{}.ppm\0"), n);
    let ok = unsafe { g3_shot(path.as_ptr()) } != 0;
    dlog(&format!("[pv] g3: shot {} {}", &path[..path.len() - 1], if ok { "written" } else { "FAILED" }));
}

/// The guest's log lines (g3_shim.c g3Log): to the log file as voxel_log
/// files them, without its println to stdout (~20 ms a line on Citra).
#[no_mangle]
pub unsafe extern "C" fn g3_dlog(s: *const u8, len: i32) {
    if s.is_null() || len <= 0 {
        return;
    }
    let b = core::slice::from_raw_parts(s, len as usize);
    let t = String::from_utf8_lossy(b);
    if t.starts_with("[pv]") {
        dlog(&t);
    }
}

/// After the loop: the sound thread down and NDSP closed.
pub fn exit() {
    audio::exit();
}

/// A bench's host buttons (g3HostKeys) laid over the console's: held is the
/// union, down is what the bench newly pressed this frame. The console's own
/// keys are untouched when no bench is pressing anything.
static mut HOST_KEYS_PREV: u32 = 0;
pub fn inject_keys(k: ctru::services::hid::KeyPad, d: ctru::services::hid::KeyPad)
    -> (ctru::services::hid::KeyPad, ctru::services::hid::KeyPad) {
    use ctru::services::hid::KeyPad;
    let m = unsafe { g3_host_keys_get() };
    let prev = unsafe { HOST_KEYS_PREV };
    unsafe { HOST_KEYS_PREV = m };
    if m == 0 && prev == 0 {
        return (k, d);
    }
    let map = |m: u32| -> KeyPad {
        let mut out = KeyPad::empty();
        if m & 1 != 0 { out |= KeyPad::ZL; }
        if m & 2 != 0 { out |= KeyPad::ZR; }
        if m & 4 != 0 { out |= KeyPad::CSTICK_LEFT; }
        if m & 8 != 0 { out |= KeyPad::CSTICK_RIGHT; }
        if m & 16 != 0 { out |= KeyPad::CSTICK_UP; }
        if m & 32 != 0 { out |= KeyPad::CSTICK_DOWN; }
        out
    };
    (k | map(m), d | map(m & !prev))
}

/// The GPU command buffer (C3D_Init) for FireRed: the default 256 KB is 64K
/// words, and a normal stereo field frame already takes ~42K (the world
/// draw, ~18K per eye, with up to four neighbouring maps around the current
/// one). The flat (top-down) camera took it past the end -- GPUCMD_Add's
/// svcBreak, the R/ZR crash on hardware. Measured peaks: 78.9K words
/// (FR_PALLET_TOWN, flat), 64.5K (FR_CELADON_CITY, flat); 768 KB = 196K
/// words, 2.5x the worst seen. It is linear memory, so no bigger than that.
pub const CMDBUF_BYTES: usize = 0xC0000;
