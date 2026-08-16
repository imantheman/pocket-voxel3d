#![feature(allocator_api)]
mod voxel;

use citro3d::macros::include_shader;
use citro3d::math::{FVec4, ScreenOrientation, StereoDisplacement, AspectRatio, ClipPlanes, CoordinateOrientation, FVec3, Matrix4, Projection};
use citro3d::render::effect::CullMode;
use citro3d::render::{ClearFlags, DepthFormat, Frame, ScreenTarget, Target};
use citro3d::{attrib, buffer, shader, texenv, texture};
use ctru::prelude::*;
use ctru::services::gfx::{RawFrameBuffer, Screen, TopScreen3D};
use ctru::services::romfs::RomFS;
use pocketvoxel_core::draw::{self, resolve_pal, Item};
use pocketvoxel_core::pak::{self, AlignedBlob, Pak};
use pocketvoxel_core::spec::{atlas_kind, COLOR_PAL_NONE};

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
    fn audio3ds_init(rate: i32, frames_per_buf: i32) -> i32;
    fn audio3ds_free_frames() -> i32;
    fn audio3ds_queue(pcm: *const i16, frames: i32) -> i32;
    fn c3d_alpha_test(on: i32, r: i32);
    fn qjs_call_frame(ctx: *mut JSContext, buttons: i32, errbuf: *mut u8, errlen: i32) -> i32;
}

// Override libctru's default heap split (weak symbols). The app heap is
// what malloc/QuickJS use; linear is GPU-visible memory.
// (heap defaults restored)



fn map_pak(path: &str) -> Option<Vec<u8>> {
    std::fs::read(path).ok()
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
const MAX_VERTS: usize = 400_000;
const KINDS: [usize; 6] = [0, 2, 3, 6, 7, 8];

struct MapGeom {
    chunk_spans: Vec<([f32; 3], [f32; 3], usize, usize)>,
    verts: Vec<Vertex>,
    center: [f32; 3],
    size: f32,
    tex_rgba: Vec<u8>,
    tw: u32,
    th: u32,
    aw: u32,
    ah: u32,
}

fn build_map(pak: &Pak, map_id: u32) -> MapGeom {
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
    let mut chunk_spans: Vec<([f32; 3], [f32; 3], usize, usize)> = Vec::new();
    let mut cmin = [f32::MAX; 3];
    let mut cmax = [f32::MIN; 3];
    let map = pak.maps.iter().find(|m| m.map_id == map_id).expect("map");
    let chunks = &pak.chunks[map.first as usize..(map.first + map.count) as usize];
    'outer: for &kind in KINDS.iter() {
        for chunk in chunks {
            let m = chunk.meshes[kind];
            if m.index_count == 0 { continue; }
            let span_start = verts.len();
            let bmin = [chunk.aabb_min[0] as f32, chunk.aabb_min[1] as f32, chunk.aabb_min[2] as f32];
            let bmax = [chunk.aabb_max[0] as f32, chunk.aabb_max[1] as f32, chunk.aabb_max[2] as f32];
            let vbase = m.vert_base as usize;
            for k in 0..m.index_count as usize {
                if verts.len() >= MAX_VERTS { break 'outer; }
                let idx = pak.indices[m.index_base as usize + k] as usize;
                let pv = pak.verts[vbase + idx];
                let a = pv.abgr;
                let p = [pv.x as f32, pv.y as f32, pv.z as f32];
                for c in 0..3 {
                    if p[c] < cmin[c] { cmin[c] = p[c]; }
                    if p[c] > cmax[c] { cmax[c] = p[c]; }
                }
                verts.push(Vertex {
                    pos: [pv.x, pv.y, pv.z, 0],
                    color: [(a & 0xff) as u8, ((a >> 8) & 0xff) as u8, ((a >> 16) & 0xff) as u8, 255],
                    uv: [pv.uf(), pv.vf()],
                });
            }
            if verts.len() > span_start {
                chunk_spans.push((bmin, bmax, span_start, verts.len()));
            }
        }
    }
    if verts.is_empty() { cmin = [0.0; 3]; cmax = [16.0; 3]; }
    let center = [
        (cmin[0] + cmax[0]) * 0.5,
        (cmin[1] + cmax[1]) * 0.5,
        (cmin[2] + cmax[2]) * 0.5,
    ];
    let size = (cmax[0]-cmin[0]).max(cmax[1]-cmin[1]).max(cmax[2]-cmin[2]).max(16.0);
    MapGeom { chunk_spans, verts, center, size, tex_rgba, tw, th, aw, ah }
}

static mut RT: *mut JSRuntime = core::ptr::null_mut();
static mut CTX: *mut JSContext = core::ptr::null_mut();

fn main() {
    let gfx = Gfx::new().expect("gfx");
    let mut hid = Hid::new().expect("hid");
    let apt = Apt::new().expect("apt");
    let _console = Console::new(gfx.bottom_screen.borrow_mut());
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

    // GAME + AUDI outlive the pak: the guest reads them at boot.
    {
        let raw = map_pak("sdmc:/3ds/voxelmon/voxelmon.vxpak").unwrap_or_default();
        if !raw.is_empty() {
            let pk = pak::read(&raw).expect("parse pak");
            let g: &'static [u8] = Box::leak(pk.game.to_vec().into_boxed_slice());
            let a: &'static [u8] = Box::leak(pk.audio.to_vec().into_boxed_slice());
            println!("game {} KB  audi {} KB", g.len()/1024, a.len()/1024);
            unsafe { voxel::init(g, a); }
            unsafe { voxel::load_save_file(); }
        }
    }

    // Hold the pak resident, as the live scene renderer will need.
    println!("loading pak...");
    let pak_bytes: &'static [u8] = {
        let mut v = match std::fs::read("sdmc:/3ds/voxelmon/voxelmon.vxpak") {
            Ok(v) => v,
            Err(e) => {
                println!("PAK READ FAILED: {}", e);
                println!("press START to exit");
                loop {
                    hid.scan_input();
                    if hid.keys_down().contains(KeyPad::START) { return; }
                    gfx.wait_for_vblank();
                }
            }
        };
        v.shrink_to_fit();
        println!("pak resident {} KB", v.len() / 1024);
        Box::leak(v.into_boxed_slice())
    };

    let pak_static: &'static Pak<'static> =
        Box::leak(Box::new(pak::read(pak_bytes).expect("parse pak")));

    let map_ids: Vec<u32> = {
        let pak = pak::read(pak_bytes).expect("parse pak");
        pak.maps.iter().map(|m| m.map_id).collect()
    };
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

    let mut map_i = 0usize;
    let mut geom = MapGeom {
        chunk_spans: Vec::new(), verts: Vec::new(), center: [0.0; 3], size: 16.0,
        tex_rgba: Vec::new(), tw: 8, th: 8, aw: 8, ah: 8,
    };
    let mut chunk_infos: Vec<([f32; 3], [f32; 3], buffer::Info)> = Vec::new();
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
    const AUDIO_RATE: i32 = 11025;
    // audio.rs: the synth advances by exactly the frames you ask for, so a
    // tick must render one tick's worth (11025/60, rounded up) or the music
    // stretches.
    const AUDIO_FRAMES_PER_TICK: i32 = 184;
    const AUDIO_BUF: i32 = AUDIO_FRAMES_PER_TICK * 3;
    let audio_on = unsafe { audio3ds_init(AUDIO_RATE, AUDIO_BUF) } != 0;
    let mut pcm: Vec<i16> = vec![0; (AUDIO_BUF * 2) as usize];
    println!("audio: {}", if audio_on { "ndsp open" } else { "unavailable" });

    let mut guest_drive = true;   // boot into the game; the title state runs there
    let mut dbg_tick: u32 = 0;
    let mut frame_start: u64 = 0;
    let mut sim_acc: f32 = 0.0;
    let mut sim_last: u64 = 0;
    let mut fps_frames: u32 = 0;
    let mut fps_last: u64 = 0;
    let pitches: [i32; 5] = [0, 1, 2, 3, 4];
    let mut pitch_i = 0usize;
    let mut page_tex: Vec<Option<texture::Texture>> = Vec::new();

    let mut yaw: f32 = 0.7;
    let mut pitch: f32 = 0.6;
    let mut dist: f32 = geom.size * 1.4;

    while apt.main_loop() {
        hid.scan_input();
        let k = hid.keys_held();
        let d = hid.keys_down();
        // START belongs to the game (menu). Exit with START+SELECT.
        {
            extern "C" { fn osGetTime() -> u64; }
            fps_frames += 1;
            let now = unsafe { osGetTime() };
            if fps_last == 0 { fps_last = now; }
            if now.wrapping_sub(fps_last) >= 1000 {
                fps_frames = 0;
                fps_last = now;
            }
        }
        unsafe {
            extern "C" { fn osGetTime() -> u64; }
            frame_start = osGetTime();
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
                        println!("pic {} {}x{}", pic_idx, pg.w, pg.h);
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
                println!("pic {} {}x{}", pic_idx, pg.w, pg.h);
                unsafe { voxel::scene().op(33, &[0, pic_idx, 80, 20, 320, 230], None); }
            }
            if pic_on && d.contains(KeyPad::Y) && step == 0 {
                let pg = pak_static.atlases[pic_idx as usize];
                println!("pic {} {}x{}", pic_idx, pg.w, pg.h);
                unsafe { voxel::scene().op(33, &[0, pic_idx, 80, 20, 320, 230], None); }
            }
        }
        if d.contains(KeyPad::SELECT) && pic_on {
            pic_on = false;
            unsafe { voxel::scene().op(34, &[0], None); }
            println!("pic off");
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
            unsafe {
                let mut e2 = [0u8; 256];
                let mut failed = false;
                for _ in 0..steps {
                    if qjs_call_frame(CTX, b, e2.as_mut_ptr(), 255) != 0 { failed = true; break; }
                }
                if failed {
                    let n = e2.iter().position(|&c| c == 0).unwrap_or(0);
                    println!("frame ERR: {}", String::from_utf8_lossy(&e2[..n]));
                    guest_drive = false;
                } else {
                    // Advance scene tweens (camera pitch, fades) once per turn.
                    voxel::scene().tick();
                    if audio_on && audio3ds_free_frames() > 0 {
                        let want = AUDIO_FRAMES_PER_TICK as usize;
                        voxel::scene().render_audio(pak_static, want, &mut pcm);
                        audio3ds_queue(pcm.as_ptr(), want as i32);
                    }
                    let sc = voxel::scene();
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
                    let (gx, gy) = sc.cam_px();
                    if (gx - center[0]).abs() > 0.5 || (gy - center[2]).abs() > 0.5 {
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
            tex = None;
            geom = {
                let pak = pak::read(pak_bytes).expect("parse pak");
                build_map(&pak, map_ids[map_i])
            };
            chunk_infos.clear();
            for (bmin, bmax, a0, b0) in geom.chunk_spans.iter() {
                let n = (b0 - a0).min(65535);
                if n == 0 { continue; }
                let mut bi = buffer::Info::new();
                if bi.add(buffer::Buffer::new(&geom.verts[*a0..*a0 + n]), attr_info.permutation()).is_ok() {
                    chunk_infos.push((*bmin, *bmax, bi));
                }
            }
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
            // GPU has its own copies now; free the CPU-side staging memory
            // so QuickJS has room for its heap.
            geom.verts = Vec::new();
            geom.verts.shrink_to_fit();
            geom.tex_rgba = Vec::new();
            geom.tex_rgba.shrink_to_fit();
            dist = geom.size * 1.4;
            center = geom.center;
            println!("map {} (id {})  verts {}", map_i, map_ids[map_i], geom.verts.len());
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
                        color: [255, 255, 255, 255],
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
        let page_tex_ref = &page_tex;
        let (focus_x, focus_z) = if guest_drive { (center[0], center[2]) } else { (center[0], center[2]) };
        let cull_r2: f32 = if guest_drive { 240.0 * 240.0 } else { 1.0e12 };
        let pic_active = !pic_groups.is_empty();        // View-cone cull: the radius test draws a full circle, but at this
        // pitch most of it is behind or outside the frustum.
        let (eye_x, eye_z) = (eye.x(), eye.z());
        let (mut fx, mut fz) = (center[0] - eye.x(), center[2] - eye.z());
        let fl = (fx * fx + fz * fz).sqrt().max(1e-6);
        fx /= fl; fz /= fl;
        let tex_ref = tex.as_ref().unwrap();
        let infos_ref = &chunk_infos;

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
                target.clear(ClearFlags::ALL, if pic_active { 0xFFFF_FFFFu32 } else { SKY }, 0);
                frame.select_render_target(target).expect("select");
                frame.bind_vertex_uniform(projection_idx, mvp);
                frame.bind_vertex_uniform(uvx_idx, uvx);
                frame.set_cull_face(CullMode::None);
                frame.bind_texture(texture::Index::Texture0, tex_ref);
                frame.set_texenvs(&[stage0]);
                frame.set_attr_info(&attr_info);
                if !pic_active {
                let mut drawn = 0u32;
                for (bmin, bmax, bi) in infos_ref.iter() {
                    let cx = (bmin[0] + bmax[0]) * 0.5;
                    let cz = (bmin[2] + bmax[2]) * 0.5;
                    let dx = cx - focus_x;
                    let dz = cz - focus_z;
                    if dx * dx + dz * dz > cull_r2 { continue; }
                    if guest_drive {
                        let hx = (bmax[0] - bmin[0]) * 0.5;
                        let hz = (bmax[2] - bmin[2]) * 0.5;
                        let r = (hx * hx + hz * hz).sqrt() + 24.0;
                        let vx = cx - eye_x;
                        let vz = cz - eye_z;
                        let along = vx * fx + vz * fz;
                        let side = (vx * fz - vz * fx).abs();
                        if along < -r || side > along.max(0.0) * 1.35 + r { continue; }
                    }
                    drawn += 1;
                    frame.draw_arrays(buffer::Primitive::Triangles, bi, None).unwrap();
                }
                unsafe { DRAWN = drawn; }
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
            frame
        });
    }
}
