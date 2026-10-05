//! pocket-voxel 3DS host for the gen3 (FireRed) port (GPLv3 + additional
//! terms; see LICENSE.md). The FireRed build's main loop: the Gen 3 guest
//! (game-firered.js) runs at 60 steps a second and hands the host a draw list
//! per shown frame (g3Draw); the renderer (g3_render.c) draws it on the GPU at
//! 30 frames a second. No voxel world, no paks: the display only, for now.
//! The bottom screen keeps the boot console (guest console.log lands there).

use ctru::prelude::*;

use super::{dlog, JSContext};

static GAME_JS: &[u8] = include_bytes!("../../game-firered.js");

extern "C" {
    fn g3_gpu_init(shbin: *const u8, len: u32) -> i32;
    fn g3_render_frame();
    fn g3_perf(out: *mut f32);
    fn g3_shot(path: *const u8) -> i32;
    fn qjs_register_g3(ctx: *mut JSContext) -> i32;
    fn osGetTime() -> u64;
}

pub fn run() {
    super::install_panic_log();
    let gfx = Gfx::new().expect("gfx");
    let mut hid = Hid::new().expect("hid");
    let apt = Apt::new().expect("apt");
    let _console = Console::new(gfx.bottom_screen.borrow_mut());
    unsafe {
        super::RT = super::JS_NewRuntime();
        super::CTX = if super::RT.is_null() { core::ptr::null_mut() } else { super::JS_NewContext(super::RT) };
        super::osSetSpeedupEnable(true);
        super::log_open();
        super::voxel::init(&[], &[]);
    }
    let _ = std::fs::create_dir_all("sdmc:/3ds/voxelmon/firered");
    dlog("[pv] ---------------- boot ----------------");
    dlog(&format!("[pv] boot build={} game=firered (gen3 host test)", option_env!("PV_BUILD_ID").unwrap_or("dev")));
    println!("FireRed host: build {}", option_env!("PV_BUILD_ID").unwrap_or("dev"));
    let gi = unsafe { g3_gpu_init(super::SHADER_BYTES.as_ptr(), super::SHADER_BYTES.len() as u32) };
    if gi != 1 {
        dlog(&format!("[pv] g3: GPU init FAILED (step {})", -gi));
        println!("GPU init failed");
        while apt.main_loop() {
            hid.scan_input();
            if hid.keys_down().contains(KeyPad::START) { break; }
            gfx.wait_for_vblank();
        }
        return;
    }
    let mut guest_ok = false;
    unsafe {
        let mut err = [0u8; 256];
        super::qjs_register_voxel(super::CTX);
        qjs_register_g3(super::CTX);
        let mut src = GAME_JS.to_vec();
        src.push(0);
        let t0 = super::now_us();
        if super::qjs_eval(super::CTX, src.as_ptr(), GAME_JS.len() as i32, err.as_mut_ptr(), 255) != 0 {
            let n = err.iter().position(|&c| c == 0).unwrap_or(0);
            let m = String::from_utf8_lossy(&err[..n]).to_string();
            println!("boot ERR: {}", m);
            dlog(&format!("[pv] g3: boot ERR: {}", m));
        } else {
            guest_ok = true;
            dlog(&format!("[pv] g3: guest booted in {:.0} ms", (super::now_us() - t0) / 1000.0));
        }
    }

    let mut sim_last: u64 = 0;
    let mut sim_acc: f32 = 0.0;
    let mut shot_n: u32 = 0;
    let mut perf_last: u64 = 0;
    let mut js_us: f32 = 0.0;
    let mut ticks: u32 = 0;
    let mut failed_once = false;
    while apt.main_loop() {
        hid.scan_input();
        let k = hid.keys_held();
        let d = hid.keys_down();
        if (d.contains(KeyPad::START) && k.contains(KeyPad::SELECT)) || (d.contains(KeyPad::SELECT) && k.contains(KeyPad::START)) {
            break;
        }
        // 60 Hz steps, as main.rs: catch up on whole ticks, capped at four
        let steps = unsafe {
            let now = osGetTime();
            if sim_last == 0 { sim_last = now; }
            sim_acc += (now.wrapping_sub(sim_last) as f32).min(100.0);
            sim_last = now;
            let mut n = 0;
            while sim_acc >= 16.667 && n < 4 { sim_acc -= 16.667; n += 1; }
            if sim_acc > 16.667 { sim_acc = 16.667; }
            n.max(1)
        };
        let mut b = 0i32;
        if k.contains(KeyPad::DPAD_UP) { b |= 1 << 0; }
        if k.contains(KeyPad::DPAD_DOWN) { b |= 1 << 1; }
        if k.contains(KeyPad::DPAD_LEFT) { b |= 1 << 2; }
        if k.contains(KeyPad::DPAD_RIGHT) { b |= 1 << 3; }
        {
            let (cx, cy) = hid.circlepad_position();
            b |= super::stick_as_dpad(cx, cy);
            unsafe { super::voxel::set_stick(cx, cy); }
        }
        if k.contains(KeyPad::A) { b |= 1 << 4; }
        if k.contains(KeyPad::B) { b |= 1 << 5; }
        if k.contains(KeyPad::START) || k.contains(KeyPad::X) { b |= 1 << 6; }
        if k.contains(KeyPad::SELECT) { b |= 1 << 7; }
        if d.contains(KeyPad::L) { b |= 1 << 27; }
        if d.contains(KeyPad::R) { b |= 1 << 26; }
        if guest_ok {
            let t = super::now_us();
            for step in 0..steps {
                unsafe { super::voxel::set_last_step(step + 1 == steps); }
                let mut e2 = [0u8; 256];
                if unsafe { super::qjs_call_frame(super::CTX, b, e2.as_mut_ptr(), 255) } != 0 {
                    if !failed_once {
                        let n = e2.iter().position(|&c| c == 0).unwrap_or(0);
                        let m = String::from_utf8_lossy(&e2[..n]).to_string();
                        println!("frame ERR: {}", m);
                        dlog(&format!("[pv] g3: frame ERR: {}", m));
                        failed_once = true;
                    }
                    break;
                }
                ticks += 1;
            }
            js_us += super::now_us() - t;
        }
        unsafe { g3_render_frame(); }
        if unsafe { super::voxel::take_shot_request() } {
            let path = format!("sdmc:/3ds/voxelmon/firered/g3shot_{}.ppm\0", shot_n);
            let ok = unsafe { g3_shot(path.as_ptr()) } != 0;
            dlog(&format!("[pv] g3: shot {} {}", &path[..path.len() - 1], if ok { "written" } else { "FAILED" }));
            shot_n += 1;
        }
        let now = unsafe { osGetTime() };
        if perf_last == 0 { perf_last = now; }
        if now.wrapping_sub(perf_last) >= 5000 {
            let mut p = [0f32; 10];
            unsafe { g3_perf(p.as_mut_ptr()); }
            let fr = p[0].max(1.0);
            dlog(&format!(
                "[pv] g3 perf: {:.1} fps  js {:.1} ms/frame ({} ticks)  build {:.2} ms  gpu {:.2} ms  per list: {:.0} quads {:.0} tris {:.0} calls {:.0} verts  variants {:.0}  dropped {:.0}",
                p[0] / (now.wrapping_sub(perf_last) as f32 / 1000.0),
                js_us / 1000.0 / fr, ticks, p[7], p[8],
                p[2] / p[1].max(1.0), p[3] / p[1].max(1.0), p[4] / fr, p[5] / fr, p[6], p[9],
            ));
            js_us = 0.0;
            ticks = 0;
            perf_last = now;
        }
    }
}
