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
//!   ([`world_pass`]).
//! - **Sound** is the M4A engine (audio.rs) on its own thread, started
//!   before the guest boots ([`before_guest`]); the Kanto synth stays off
//!   (main.rs's `audio3ds_init` is replaced for this build and says so).
//! - **Memory.** The 2D layer's textures live in linear memory beside the
//!   map's vertices, so the map plans for less ([`map_cap`]); FireRed's paks
//!   are small, so its pak cache is too, leaving the heap to QuickJS
//!   ([`size_pak_cache`]).

use citro3d::math::Matrix4;
use pocketvoxel_core::{cam, draw};

use super::{dlog, JSContext};

mod audio;

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
}

/// Linear memory kept back from the map's vertex plan for the 2D layer:
/// the frame texture and canvases are VRAM, but every guest texture (fonts,
/// window frames, sprite sheets, battle pictures) is a linear RGBA8 copy,
/// and two 590 KB vertex buffers ride there too.
const G3_LINEAR_KB: usize = 8 * 1024;

/// FireRed's pak cache. Its paks are small (the largest, Route 23, is 733
/// KB: one tile page of 256x848, shared through common.vxat), and the heap
/// is wanted by the Gen 3 runtime's QuickJS heap far more than by maps the
/// player has walked away from.
const G3_PAK_CACHE_KB: usize = 6 * 1024;

static mut GPU_OK: bool = false;
static mut SOUND_ON: bool = false;

/// The map vertex cap with the 2D layer's linear share taken off (main.rs
/// hands the result to mapplan on its next line).
pub fn map_cap(free_kb: usize, cap: usize) -> usize {
    let side = (super::MAP_LINEAR_SIDE_KB + G3_LINEAR_KB) * 1024;
    let c = ((free_kb * 1024).saturating_sub(side) / core::mem::size_of::<super::Vertex>()).max(super::MAP_CAP_FLOOR_VERTS);
    dlog(&format!("[pv] g3: map vertex cap {} (the Kanto sizing said {}; {} KB kept for the 2D layer)", c, cap, G3_LINEAR_KB));
    c
}

/// FireRed's own (small) pak cache budget, after the shared sizing.
pub fn size_pak_cache() {
    unsafe { super::PAK_CACHE_BUDGET_KB = G3_PAK_CACHE_KB };
    dlog(&format!("[pv] g3: pak cache {} MB (FireRed's paks are small)", G3_PAK_CACHE_KB / 1024));
}

/// Before the guest is evaluated: the 2D layer's GPU side, the sound (so
/// the guest finds it at load) and the gen3 natives.
pub fn before_guest() {
    let _ = std::fs::create_dir_all("sdmc:/3ds/voxelmon/firered");
    let lin0 = super::unsafe_free_kb();
    let gi = unsafe { g3_gpu_init_shared(super::SHADER_BYTES.as_ptr(), super::SHADER_BYTES.len() as u32) };
    unsafe { GPU_OK = gi == 1 };
    if gi != 1 {
        dlog(&format!("[pv] g3: 2D layer GPU init FAILED (step {})", -gi));
    }
    let sound = audio::init();
    unsafe { SOUND_ON = sound };
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
pub fn offscreen_pass() {
    if !unsafe { GPU_OK } {
        return;
    }
    unsafe { g3_frame_offscreen() };
    prepare_billboards();
}

/// The guest's billboards as quads facing the scene's camera: each stands
/// on the floor of its cell (the same floor the Kanto cards stand on),
/// leaned back to face the eye as draw::card_verts leans them, and pulled
/// toward it the way main.rs pulls the cards, so a wall behind does not cut
/// into it.
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
        let (x, z) = (r[1], r[2]);
        let ground = sc.floor.height_at(x - sox, z - soy);
        let feet = pocketvoxel_core::math::vec3(x - sox, ground + r[3], z - soy);
        let v = draw::card_verts(feet, r[4], r[5], camera.a, fx, fz);
        let mut xyz = [0f32; 12];
        for (i, q) in v.iter().enumerate() {
            let (dx, dy, dz) = (e.x - q[0], e.y - q[1], e.z - q[2]);
            let l = (dx * dx + dy * dy + dz * dz).sqrt().max(1e-6);
            xyz[i * 3] = q[0] + dx / l * pull;
            xyz[i * 3 + 1] = q[1] + dy / l * pull;
            xyz[i * 3 + 2] = q[2] + dz / l * pull;
        }
        unsafe { g3_bb_quad(r[0] as i32, xyz.as_ptr(), r[6], r[7], r[8], r[9], r[10]) };
    }
}

/// A billboard record's floats (worldview.ts ENT_FLOATS).
const ENT_FLOATS: usize = 11;

/// In each eye's world pass, after the terrain and the trees: the people.
pub fn world_pass(mvp: &Matrix4) {
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
}

/// The perf block's extra lines (every 5 s): the 2D layer's and the sound's.
pub fn perf_line() {
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
    let path = format!("sdmc:/3ds/voxelmon/firered/g3shot_{}.ppm\0", n);
    let ok = unsafe { g3_shot(path.as_ptr()) } != 0;
    dlog(&format!("[pv] g3: shot {} {}", &path[..path.len() - 1], if ok { "written" } else { "FAILED" }));
}

/// After the loop: the sound thread down and NDSP closed.
pub fn exit() {
    audio::exit();
}
