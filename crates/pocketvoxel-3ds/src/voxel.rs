//! The `voxel` surface: ops from the JS guest applied to the shared Scene.
//! JSValue handling lives in vendor/quickjs/voxel_shim.c; this side only ever
//! sees plain integers and byte slices.
use pocketvoxel_core::scene::Scene;

static mut SCENE: Option<Scene> = None;
static mut GAME: &[u8] = &[];
static mut AUDIO: &[u8] = &[];
/// Host camera-pitch rung, or -1 to let the guest decide. The guest re-issues
/// PITCH every tick, so overriding here is the only way it sticks.
static mut PITCH_RUNG: i32 = -1;
/// Host-only op (90): the title's MAP VIEWER entry. Never reaches the Scene.
static mut VIEWER_REQ: bool = false;
pub unsafe fn take_viewer_request() -> bool {
    let v = VIEWER_REQ;
    VIEWER_REQ = false;
    v
}
static mut OP_LOG: bool = false;
pub unsafe fn set_op_log(on: bool) { OP_LOG = on; }

pub unsafe fn set_pitch(rung: i32) { PITCH_RUNG = rung; }
pub unsafe fn get_pitch() -> i32 { PITCH_RUNG }

pub unsafe fn init(game: &'static [u8], audio: &'static [u8]) {
    SCENE = Some(Scene::new());
    GAME = game;
    AUDIO = audio;
}

#[allow(static_mut_refs)]
pub unsafe fn scene() -> &'static mut Scene {
    SCENE.as_mut().expect("voxel::init not called")
}

// GameVersion.saveSuffix("red") is "", so the recomp's file is save.lua.
const SAVE_PATH: &str = "sdmc:/3ds/voxelmon/save.lua";
static mut SAVE_BUF: Vec<u8> = Vec::new();

/// Read whatever is on the card at boot so CONTINUE has something to load.
#[allow(static_mut_refs)]
pub unsafe fn load_save_file() {
    SAVE_BUF = std::fs::read(SAVE_PATH).unwrap_or_default();
    println!("save: {} bytes", SAVE_BUF.len());
}

/// Why the last card write failed, for the game to show the player. Empty
/// when it worked.
///
/// A write that fails silently is the worst case for a save: the player is
/// told the game saved, the card took nothing, and they find out hours later.
/// It also turns out to be the only practical way to tell from inside the
/// game whether the SD card is writable at all.
static mut LAST_WRITE_ERR: String = String::new();

/// Write `b` to the card, remembering why if it does not take.
#[allow(static_mut_refs)]
unsafe fn card_write(path: &str, b: &[u8]) -> bool {
    match std::fs::write(path, b) {
        Ok(()) => true,
        Err(e) => {
            LAST_WRITE_ERR = format!("{}", e);
            println!("write FAILED {}: {}", path, e);
            false
        }
    }
}

/// Prove the card is writable by writing a file and reading it back.
///
/// Reading it back matters: a card can accept a write, report success, and
/// still not have it -- which is exactly the failure being chased here.
#[no_mangle]
#[allow(static_mut_refs)]
pub unsafe extern "C" fn voxel_write_test() -> i32 {
    const P: &str = "sdmc:/3ds/voxelmon/writetest.txt";
    let want = b"pocketvoxel write test";
    LAST_WRITE_ERR = String::new();
    if !card_write(P, want) {
        return 0;
    }
    match std::fs::read(P) {
        Ok(got) if got == want => 1,
        Ok(got) => {
            LAST_WRITE_ERR = format!("read back {} of {} bytes", got.len(), want.len());
            0
        }
        Err(e) => {
            LAST_WRITE_ERR = format!("wrote but cannot read back: {}", e);
            0
        }
    }
}

#[no_mangle]
#[allow(static_mut_refs)]
pub unsafe extern "C" fn voxel_write_err_ptr() -> *const u8 { LAST_WRITE_ERR.as_ptr() }

#[no_mangle]
#[allow(static_mut_refs)]
pub unsafe extern "C" fn voxel_write_err_len() -> u32 { LAST_WRITE_ERR.len() as u32 }

/// Returns 1 when the save reached the card, 0 when it did not.
#[no_mangle]
#[allow(static_mut_refs)]
pub unsafe extern "C" fn voxel_save_write(s: *const u8, len: i32) -> i32 {
    if s.is_null() || len <= 0 { return 0; }
    let b = core::slice::from_raw_parts(s, len as usize);
    LAST_WRITE_ERR = String::new();
    if card_write(SAVE_PATH, b) {
        println!("save: wrote {} bytes", b.len());
        1
    } else {
        0
    }
}

#[no_mangle]
#[allow(static_mut_refs)]
pub unsafe extern "C" fn voxel_save_ptr() -> *const u8 { SAVE_BUF.as_ptr() }

#[no_mangle]
#[allow(static_mut_refs)]
pub unsafe extern "C" fn voxel_save_len() -> u32 { SAVE_BUF.len() as u32 }

#[no_mangle]
pub unsafe extern "C" fn voxel_log(s: *const u8, len: i32) {
    if s.is_null() || len <= 0 { return; }
    let b = core::slice::from_raw_parts(s, len as usize);
    let t = String::from_utf8_lossy(b);
    // NPC dumps drown the console; keep the rest.
    if !t.starts_with("NPCS") { println!("js: {}", t); }
}

#[no_mangle]
pub unsafe extern "C" fn voxel_op(code: u32, args: *const i32, n: i32) {
    // The guest re-issues PITCH every tick, which resets the tween timer and
    // freezes the camera mid-move. Once the host picks a rung, swallow them.
    if OP_LOG && (code == 30 || code == 10 || code == 52 || code == 3) {
        // ent / mapShow / uiText / reset - the ops scripted events drive
        extern "C" { fn printf(f: *const u8, ...) -> i32; }
        printf(b"op%u\n\0".as_ptr(), code);
    }
    if code == 90 {
        VIEWER_REQ = true;
        return;
    }
    if code == 13 && PITCH_RUNG >= 0 {
        return;
    }
    if args.is_null() || n <= 0 { scene().op(code, &[], None); return; }
    let a = core::slice::from_raw_parts(args, n as usize);
    scene().op(code, a, None);
}

#[no_mangle]
pub unsafe extern "C" fn voxel_op_text(code: u32, args: *const i32, n: i32,
                                       s: *const u8, len: i32) {
    let a = if args.is_null() || n <= 0 { &[][..] }
            else { core::slice::from_raw_parts(args, n as usize) };
    if s.is_null() || len <= 0 { scene().op(code, a, None); return; }
    let bytes = core::slice::from_raw_parts(s, len as usize);
    match core::str::from_utf8(bytes) {
        Ok(t) => { scene().op(code, a, Some(t)); }
        Err(_) => { scene().op(code, a, None); }
    }
}

#[no_mangle] pub unsafe extern "C" fn voxel_game_ptr() -> *const u8 { GAME.as_ptr() }
#[no_mangle] pub unsafe extern "C" fn voxel_game_len() -> u32 { GAME.len() as u32 }
#[no_mangle] pub unsafe extern "C" fn voxel_audio_ptr() -> *const u8 { AUDIO.as_ptr() }
#[no_mangle] pub unsafe extern "C" fn voxel_audio_len() -> u32 { AUDIO.len() as u32 }
