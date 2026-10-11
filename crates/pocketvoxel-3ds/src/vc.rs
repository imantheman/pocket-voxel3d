//! VC saves on the console: the re-release titles' save data through
//! libctru's AM (title list) and FS (save archive) calls, behind
//! pocketvoxel_core::vcsave's VcFs, plus the guest's natives
//! (`voxel.vcData()`, `voxel.vcWrite(bytes)`, `voxel.vcInfo()`).
//!
//! Red, Blue and Yellow only. Every other build still links the natives
//! (the shim is shared) and they report nothing found.
//!
//! The archive is the other title's user save data (ARCHIVE_USER_SAVEDATA
//! with a binary path of media type and title ID), the way any save manager
//! reaches it; libctru's documented calls only. A CIA needs the rights in
//! tools/pocketvoxel.rsf; under the Homebrew Launcher the process has its
//! launcher's. Without them the open fails, the log says so, and the guest
//! is told there is no VC save.
//!
//! The archive is never held across frames: the boot read opens, reads and
//! closes it in one call, and so does every save. CONTINUE itself touches
//! no file at all -- the guest converts the bytes read at boot.

#[cfg(not(any(feature = "gen2", feature = "gen3")))]
mod imp {
    use core::ffi::c_void;
    use pocketvoxel_core::vcsave::{self, Found, Game, StdCard, VcFs};

    #[cfg(feature = "blue")]
    pub const GAME: Game = Game::Blue;
    #[cfg(feature = "yellow")]
    pub const GAME: Game = Game::Yellow;
    #[cfg(not(any(feature = "blue", feature = "yellow")))]
    pub const GAME: Game = Game::Red;

    pub const BACKUP_DIR: &str = "sdmc:/3ds/voxelmon/vc_backup";
    const OVERRIDE_PATH: &str = "sdmc:/3ds/voxelmon/vc_titles.txt";

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct FsPath {
        kind: u32,
        size: u32,
        data: *const c_void,
    }
    const PATH_BINARY: u32 = 2;
    const PATH_ASCII: u32 = 3;
    const ARCHIVE_USER_SAVEDATA: u32 = 0x5678_90B2;
    const MEDIATYPE_SD: u32 = 1;
    const FS_OPEN_READ: u32 = 1;
    const FS_OPEN_WRITE: u32 = 2;
    const FS_WRITE_FLUSH: u32 = 1;
    const ARCHIVE_ACTION_COMMIT_SAVE_DATA: u32 = 0;
    const ATTR_DIRECTORY: u32 = 1;

    /// libctru's FS_DirectoryEntry (0x228 bytes).
    #[repr(C)]
    struct DirEntry {
        name: [u16; 0x106],
        short_name: [u8; 0x0a],
        short_ext: [u8; 0x04],
        valid: u8,
        reserved: u8,
        attributes: u32,
        file_size: u64,
    }

    extern "C" {
        fn amInit() -> i32;
        fn amExit();
        fn AM_GetTitleCount(media: u32, count: *mut u32) -> i32;
        fn AM_GetTitleList(read: *mut u32, media: u32, count: u32, ids: *mut u64) -> i32;
        fn fsInit() -> i32;
        fn FSUSER_OpenArchive(archive: *mut u64, id: u32, path: FsPath) -> i32;
        fn FSUSER_CloseArchive(archive: u64) -> i32;
        fn FSUSER_ControlArchive(archive: u64, action: u32, input: *const c_void, in_size: u32, output: *mut c_void, out_size: u32) -> i32;
        fn FSUSER_OpenFile(out: *mut u32, archive: u64, path: FsPath, flags: u32, attributes: u32) -> i32;
        fn FSUSER_OpenDirectory(out: *mut u32, archive: u64, path: FsPath) -> i32;
        fn FSFILE_Read(h: u32, read: *mut u32, offset: u64, buf: *mut c_void, size: u32) -> i32;
        fn FSFILE_Write(h: u32, written: *mut u32, offset: u64, buf: *const c_void, size: u32, flags: u32) -> i32;
        fn FSFILE_GetSize(h: u32, size: *mut u64) -> i32;
        fn FSFILE_Close(h: u32) -> i32;
        fn FSDIR_Read(h: u32, read: *mut u32, count: u32, entries: *mut DirEntry) -> i32;
        fn FSDIR_Close(h: u32) -> i32;
    }

    /// Every FS and AM call is logged before and after, straight to pvlog,
    /// so a call that never returns is the last line there.
    fn fslog(s: &str) {
        crate::dlog(&format!("[pv] vc: fs {}", s));
    }

    fn err(what: &str, rc: i32) -> String {
        format!("{} {:08x}", what, rc as u32)
    }

    /// One title's save archive at a time.
    pub struct CtrFs {
        archive: Option<u64>,
    }

    impl CtrFs {
        pub fn new() -> Self {
            unsafe { fsInit() };
            CtrFs { archive: None }
        }
        fn path(name: &str) -> (Vec<u8>, FsPath) {
            let mut s = String::from("/");
            s.push_str(name.trim_start_matches('/'));
            let mut b = s.into_bytes();
            b.push(0);
            let p = FsPath { kind: PATH_ASCII, size: b.len() as u32, data: b.as_ptr() as *const c_void };
            (b, p)
        }
        fn open_file(&mut self, name: &str, flags: u32) -> Result<u32, String> {
            let a = self.archive.ok_or("no archive open")?;
            let (_keep, p) = Self::path(name);
            let mut h = 0u32;
            fslog(&format!("open file {} (flags {})...", name, flags));
            let rc = unsafe { FSUSER_OpenFile(&mut h, a, p, flags, 0) };
            fslog(&format!("open file -> {:08x}", rc as u32));
            if rc < 0 { Err(err("FSUSER_OpenFile", rc)) } else { Ok(h) }
        }
    }

    impl VcFs for CtrFs {
        fn titles(&mut self) -> Result<Vec<u64>, String> {
            fslog("title list: amInit...");
            unsafe {
                let rc = amInit();
                fslog(&format!("amInit -> {:08x}", rc as u32));
                if rc < 0 {
                    return Err(err("amInit", rc));
                }
                let mut n = 0u32;
                let rc = AM_GetTitleCount(MEDIATYPE_SD, &mut n);
                if rc < 0 {
                    amExit();
                    return Err(err("AM_GetTitleCount", rc));
                }
                let mut ids = vec![0u64; n as usize];
                let mut read = 0u32;
                let rc = AM_GetTitleList(&mut read, MEDIATYPE_SD, n, ids.as_mut_ptr());
                amExit();
                fslog(&format!("title list -> {:08x}, {} of {}; amExit", rc as u32, read, n));
                if rc < 0 {
                    return Err(err("AM_GetTitleList", rc));
                }
                ids.truncate(read as usize);
                Ok(ids)
            }
        }
        fn open(&mut self, tid: u64) -> Result<(), String> {
            self.close();
            let bin: [u32; 3] = [MEDIATYPE_SD, tid as u32, (tid >> 32) as u32];
            let p = FsPath { kind: PATH_BINARY, size: 12, data: bin.as_ptr() as *const c_void };
            let mut a = 0u64;
            fslog(&format!("open archive {:016x}...", tid));
            let rc = unsafe { FSUSER_OpenArchive(&mut a, ARCHIVE_USER_SAVEDATA, p) };
            fslog(&format!("open archive -> {:08x}", rc as u32));
            if rc < 0 {
                return Err(err("FSUSER_OpenArchive", rc));
            }
            self.archive = Some(a);
            Ok(())
        }
        fn files(&mut self) -> Result<Vec<(String, u64)>, String> {
            let a = self.archive.ok_or("no archive open")?;
            let root = b"/\0";
            let p = FsPath { kind: PATH_ASCII, size: 2, data: root.as_ptr() as *const c_void };
            let mut h = 0u32;
            fslog("open dir /...");
            let rc = unsafe { FSUSER_OpenDirectory(&mut h, a, p) };
            fslog(&format!("open dir -> {:08x}", rc as u32));
            if rc < 0 {
                return Err(err("FSUSER_OpenDirectory", rc));
            }
            let mut out = Vec::new();
            loop {
                let mut e: DirEntry = unsafe { core::mem::zeroed() };
                let mut n = 0u32;
                let rc = unsafe { FSDIR_Read(h, &mut n, 1, &mut e) };
                if rc < 0 || n == 0 {
                    break;
                }
                let len = e.name.iter().position(|&c| c == 0).unwrap_or(e.name.len());
                let name = String::from_utf16_lossy(&e.name[..len]);
                if e.attributes & ATTR_DIRECTORY == 0 {
                    out.push((name, e.file_size));
                }
                if out.len() > 64 {
                    break;
                }
            }
            unsafe { FSDIR_Close(h) };
            fslog(&format!("dir closed ({} files)", out.len()));
            Ok(out)
        }
        fn read(&mut self, name: &str) -> Result<Vec<u8>, String> {
            let h = self.open_file(name, FS_OPEN_READ)?;
            let mut size = 0u64;
            let rc = unsafe { FSFILE_GetSize(h, &mut size) };
            if rc < 0 || size > 1 << 20 {
                unsafe { FSFILE_Close(h) };
                return Err(if rc < 0 { err("FSFILE_GetSize", rc) } else { format!("{} is {} bytes", name, size) });
            }
            let mut buf = vec![0u8; size as usize];
            let mut got = 0u32;
            fslog(&format!("read {} bytes...", size));
            let rc = unsafe { FSFILE_Read(h, &mut got, 0, buf.as_mut_ptr() as *mut c_void, size as u32) };
            unsafe { FSFILE_Close(h) };
            fslog(&format!("read -> {:08x}, {} bytes; file closed", rc as u32, got));
            if rc < 0 {
                return Err(err("FSFILE_Read", rc));
            }
            buf.truncate(got as usize);
            Ok(buf)
        }
        fn write(&mut self, name: &str, data: &[u8]) -> Result<(), String> {
            let h = self.open_file(name, FS_OPEN_WRITE)?;
            let mut put = 0u32;
            fslog(&format!("write {} bytes...", data.len()));
            let rc = unsafe { FSFILE_Write(h, &mut put, 0, data.as_ptr() as *const c_void, data.len() as u32, FS_WRITE_FLUSH) };
            unsafe { FSFILE_Close(h) };
            fslog(&format!("write -> {:08x}, {} bytes; file closed", rc as u32, put));
            if rc < 0 {
                return Err(err("FSFILE_Write", rc));
            }
            if put as usize != data.len() {
                return Err(format!("wrote {} of {} bytes", put, data.len()));
            }
            Ok(())
        }
        fn commit(&mut self) -> Result<(), String> {
            let a = self.archive.ok_or("no archive open")?;
            fslog("commit...");
            let rc = unsafe { FSUSER_ControlArchive(a, ARCHIVE_ACTION_COMMIT_SAVE_DATA, core::ptr::null(), 0, core::ptr::null_mut(), 0) };
            fslog(&format!("commit -> {:08x}", rc as u32));
            if rc < 0 { Err(err("FSUSER_ControlArchive", rc)) } else { Ok(()) }
        }
        fn close(&mut self) {
            if let Some(a) = self.archive.take() {
                fslog("close archive...");
                let rc = unsafe { FSUSER_CloseArchive(a) };
                fslog(&format!("close archive -> {:08x}", rc as u32));
            }
        }
    }

    // Written at runtime: `static mut` (the console enforces what the
    // emulator lets slide).
    pub static mut FOUND: Option<Found> = None;
    pub static mut INFO: String = String::new();
    pub static mut LAST_ERR: String = String::new();

    fn log(s: &str) {
        crate::dlog(&format!("[pv] {}", s));
        println!("{}", s);
    }

    /// At boot: find the title and read its save (the guest asks for it
    /// at CONTINUE). Quiet when nothing is there beyond one log line.
    #[allow(static_mut_refs)]
    pub unsafe fn probe() {
        let over = std::fs::read_to_string(OVERRIDE_PATH).ok().and_then(|t| vcsave::title_override(&t, GAME));
        let mut fs = CtrFs::new();
        FOUND = vcsave::probe(&mut fs, GAME, over, &mut |l| log(l));
        // a copy of exactly what the game is handed, for a save that only
        // misbehaves on one console
        if let Some(f) = FOUND.as_ref() {
            let mut card = StdCard;
            match vcsave::dump_read(&mut card, BACKUP_DIR, GAME, &now_stamp(), &f.raw) {
                Ok(Some(p)) => log(&format!("vc: copy of the save as read: {}", p)),
                Ok(None) => log("vc: the save as read is already copied (unchanged)"),
                Err(e) => log(&format!("vc: could not copy the save as read: {}", e)),
            }
        }
        INFO = match &FOUND {
            Some(f) => format!("{} {:016x} {} {}", GAME.label(), f.tid, f.file, f.raw.len()),
            None => String::new(),
        };
    }

    fn now_stamp() -> String {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        vcsave::stamp(secs)
    }

    /// The guest's save, into the title: backup, write, read back, commit.
    #[allow(static_mut_refs)]
    pub unsafe fn write(sram: &[u8]) -> bool {
        LAST_ERR = String::new();
        let Some(found) = FOUND.as_mut() else {
            LAST_ERR = String::from("no VC title");
            log("vc: save asked for, but no VC title was found at boot");
            return false;
        };
        log(&format!("vc: saving {} bytes to the {} title", sram.len(), GAME.label()));
        let mut fs = CtrFs::new();
        let mut card = StdCard;
        match vcsave::write_save(&mut fs, &mut card, found, GAME, sram, BACKUP_DIR, &now_stamp(), &mut |l| log(l)) {
            Ok(()) => true,
            Err(e) => {
                LAST_ERR = e;
                false
            }
        }
    }
}

/// At boot: look for this game's VC title and read its save. Nothing in the
/// Gen 2 and Gen 3 builds.
pub unsafe fn boot() {
    #[cfg(not(any(feature = "gen2", feature = "gen3")))]
    {
        // Every guest frame under a 30 s watchdog (voxel_shim.c): a frame
        // that never returns is cut off and logged, and the console keeps
        // answering HOME -- a VC save is data this game did not make.
        extern "C" { static mut pv_frame_watchdog_ms: i32; }
        pv_frame_watchdog_ms = 30_000;
        imp::probe();
    }
}

/// `voxel.vcData()`: the VC title's 32 KB save as it was read at boot (or
/// last written), or nothing (length 0) when there is no title.
#[no_mangle]
#[allow(static_mut_refs)]
pub unsafe extern "C" fn voxel_vc_ptr() -> *const u8 {
    #[cfg(not(any(feature = "gen2", feature = "gen3")))]
    if let Some(f) = imp::FOUND.as_ref() {
        return f.raw.as_ptr();
    }
    core::ptr::null()
}

#[no_mangle]
#[allow(static_mut_refs)]
pub unsafe extern "C" fn voxel_vc_len() -> u32 {
    #[cfg(not(any(feature = "gen2", feature = "gen3")))]
    if imp::FOUND.is_some() {
        return pocketvoxel_core::vcsave::SRAM_SIZE as u32;
    }
    0
}

/// `voxel.vcWrite(bytes)`: 1 when the save is in the title and committed.
#[no_mangle]
pub unsafe extern "C" fn voxel_vc_write(p: *const u8, len: u32) -> i32 {
    if p.is_null() {
        return 0;
    }
    #[cfg(not(any(feature = "gen2", feature = "gen3")))]
    {
        return imp::write(core::slice::from_raw_parts(p, len as usize)) as i32;
    }
    #[allow(unreachable_code)]
    {
        let _ = len;
        0
    }
}

/// `voxel.vcInfo()`: what was found (game, title, file, size), else empty;
/// `voxel.vcErr()`: why the last write failed, else empty.
#[no_mangle]
#[allow(static_mut_refs)]
pub unsafe extern "C" fn voxel_vc_info(which: u32, len: *mut u32) -> *const u8 {
    #[cfg(not(any(feature = "gen2", feature = "gen3")))]
    {
        let s: &String = if which == 0 { &imp::INFO } else { &imp::LAST_ERR };
        *len = s.len() as u32;
        return s.as_ptr();
    }
    #[allow(unreachable_code)]
    {
        let _ = which;
        *len = 0;
        core::ptr::null()
    }
}

/// After a VC continue the next map loads log every line straight to pvlog
/// (no batching), so a load that never finishes is pinned there.
/// `voxel.traceLoads(n)` asks for the next `n`.
static mut TRACE_LOADS: u32 = 0;
/// And the frames after it: each stage of each frame (guest done, scene
/// built, each eye, the bottom screen, submitted, frame end) goes straight
/// to pvlog, so a frame that never finishes -- a GPU that never answers --
/// shows the stage it stopped in.
static mut TRACE_FRAMES: u32 = 0;
static mut TRACE_N: u32 = 0;

#[no_mangle]
pub unsafe extern "C" fn voxel_vc_trace_loads(n: i32) {
    TRACE_LOADS = n.max(0) as u32;
    TRACE_FRAMES = if n > 0 { 12 } else { 0 };
    TRACE_N = 0;
}

/// Whether frames are being traced.
pub fn tracing() -> bool {
    unsafe { TRACE_FRAMES > 0 }
}

/// One stage of a traced frame, written to the log at once (not batched).
pub fn trace(stage: &str) {
    unsafe {
        if TRACE_FRAMES == 0 {
            return;
        }
        let line = format!("[pv] vc: trace frame {} {}", TRACE_N, stage);
        crate::dlog_now(&line);
    }
}

/// The end of a traced frame.
pub fn trace_frame_end() {
    unsafe {
        if TRACE_FRAMES == 0 {
            return;
        }
        trace("end");
        TRACE_FRAMES -= 1;
        TRACE_N += 1;
    }
}

/// Whether this map load is a traced one (and count it).
pub unsafe fn take_trace_load() -> bool {
    if TRACE_LOADS > 0 {
        TRACE_LOADS -= 1;
        true
    } else {
        false
    }
}
