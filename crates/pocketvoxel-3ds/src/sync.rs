//! SYNC's host side: the title-screen save transfer with the PC/phone games
//! on the same wifi (PVS1). The protocol, the sockets and the records the
//! guest reads are crates/pocketvoxel-sync (`host::SyncHost`); this adds SOC
//! and the `voxel.sync*` natives (vendor/quickjs/voxel_shim.c) that the
//! guest's screen (voxelmon/game/sync/model.ts) calls:
//!
//! - `syncOpen()` starts SOC (the IP stack) and binds UDP 47610 / TCP 47611
//!   (another port if one cannot be had); 0 when there is no network
//!   ("ERROR: NO WIFI"). Open already: nothing is bound again.
//! - `syncPoll()` runs one frame and returns the records (host.rs).
//! - `syncReceived()` / `syncInstall()` / `syncDiscard()`: the arrived save
//!   for the guest's own reader, then written (or dropped).
//! - `syncClose()` drops every socket, then stops SOC; once.
//!
//! Every step's result goes to pvlog ("[pv] sync: ..."). The save served is
//! the file on the card, byte for byte, read when the screen opens and after
//! an install. Nothing is written without the player's two A presses.
#[cfg(not(feature = "gen3"))]
mod imp {
    use crate::voxel;
    use ctru::services::soc::Soc;
    use pocketvoxel_core::vcsave;
    use pocketvoxel_sync::host::{HostConfig, SyncHost};
    use pocketvoxel_sync::install::{Paths, StdStore};
    use pocketvoxel_sync::net;
    use pocketvoxel_sync::proto;
    use std::net::{Ipv4Addr, SocketAddrV4};

    #[cfg(not(any(feature = "blue", feature = "yellow", feature = "gen2")))]
    const GAME: &str = "red";
    #[cfg(feature = "blue")]
    const GAME: &str = "blue";
    #[cfg(feature = "yellow")]
    const GAME: &str = "yellow";
    #[cfg(feature = "gold")]
    const GAME: &str = "gold";
    #[cfg(feature = "silver")]
    const GAME: &str = "silver";
    #[cfg(feature = "crystal")]
    const GAME: &str = "crystal";

    /// Replaced saves, the newest ten per save file.
    const BACKUP_DIR: &str = "sdmc:/3ds/voxelmon/sync_backups";

    struct State {
        host: SyncHost,
        soc: Option<Soc>,
    }

    static mut ST: Option<State> = None;

    fn log(s: &str) {
        crate::dlog(&format!("[pv] sync: {}", s));
    }

    fn now() -> f64 {
        unsafe { voxel::voxel_now_us() / 1e6 }
    }

    #[allow(static_mut_refs)]
    unsafe fn st() -> &'static mut State {
        ST.get_or_insert_with(|| {
            let mut host = SyncHost::new();
            host.set_clock(now);
            State { host, soc: None }
        })
    }

    /// The host's log lines, to pvlog.
    fn flush(st: &mut State) {
        for l in st.host.take_log() {
            log(&l);
        }
    }

    unsafe fn arg(p: *const u8, len: i32) -> String {
        if p.is_null() || len <= 0 {
            return String::new();
        }
        String::from_utf8_lossy(core::slice::from_raw_parts(p, len as usize)).into_owned()
    }

    fn libc_gethostid() -> i64 {
        extern "C" {
            fn gethostid() -> core::ffi::c_long;
        }
        unsafe { gethostid() as i64 }
    }

    /// Sockets first, then SOC.
    fn shut(st: &mut State) {
        st.host.close();
        flush(st);
        if st.soc.take().is_some() {
            log("socExit");
        }
    }

    #[no_mangle]
    pub unsafe extern "C" fn voxel_sync_open() -> i32 {
        let st = st();
        if st.host.is_open() {
            log("open: already open (one bind a visit)");
            return 1;
        }
        extern "C" {
            fn pv_net_soc_up() -> i32;
        }
        // the link (vendor/quickjs/net_link.c) already holds SOC: use it as
        // it is; it is the link's to stop, not ours
        let shared = st.soc.is_none() && pv_net_soc_up() != 0;
        if shared {
            log("SOC is already up (the link holds it): using it");
        }
        if st.soc.is_none() && !shared {
            match Soc::new() {
                Ok(s) => {
                    log("socInit ok (1 MB buffer)");
                    st.soc = Some(s);
                }
                Err(e) => {
                    log(&format!("socInit failed: {:?}: no wifi", e));
                    st.host.set_nowifi();
                    flush(st);
                    return 0;
                }
            }
        }
        let ip = match st.soc.as_ref() {
            Some(s) => s.host_address(),
            None => Ipv4Addr::from(u32::from_be(libc_gethostid() as u32)),
        };
        log(&format!("gethostid: {}", ip));
        if ip.is_unspecified() {
            log("no IP address: wifi is off or not connected");
            shut(st);
            st.host.set_nowifi();
            return 0;
        }
        let mut targets = vec![SocketAddrV4::new(Ipv4Addr::BROADCAST, proto::UDP_PORT)];
        if let Some(b) = net::subnet_broadcast(ip) {
            targets.push(SocketAddrV4::new(b, proto::UDP_PORT));
        }
        extern "C" {
            fn svcGetSystemTick() -> u64;
        }
        let seed = svcGetSystemTick() ^ ((u32::from(ip) as u64) << 21);
        let cfg = HostConfig {
            id: proto::make_id(seed),
            platform: "3ds".into(),
            game: GAME.into(),
            bind_ip: Ipv4Addr::UNSPECIFIED,
            udp_port: proto::UDP_PORT,
            tcp_port: proto::TCP_PORT,
            targets,
            // the file itself: read at open, at every GET, and when it changes
            save: None,
            save_path: Some(voxel::SAVE_PATH.into()),
        };
        let r = st.host.open(cfg);
        flush(st);
        if r.is_ok() { 1 } else { -1 }
    }

    #[no_mangle]
    pub unsafe extern "C" fn voxel_sync_poll(len: *mut u32) -> *const u8 {
        let st = st();
        let out = st.host.poll(now());
        let (p, n) = (out.as_ptr(), out.len());
        flush(st);
        if !len.is_null() {
            *len = n as u32;
        }
        p
    }

    #[no_mangle]
    pub unsafe extern "C" fn voxel_sync_offer(id: *const u8, len: i32) -> i32 {
        let id = arg(id, len);
        let st = st();
        let r = st.host.offer(&id);
        flush(st);
        r as i32
    }

    #[no_mangle]
    pub unsafe extern "C" fn voxel_sync_pull(id: *const u8, len: i32) -> i32 {
        let id = arg(id, len);
        let st = st();
        let r = st.host.pull(&id);
        flush(st);
        r as i32
    }

    #[no_mangle]
    pub unsafe extern "C" fn voxel_sync_received(len: *mut u32) -> *const u8 {
        match st().host.received() {
            Some(body) => {
                *len = body.len() as u32;
                body.as_ptr()
            }
            None => {
                *len = 0;
                core::ptr::null()
            }
        }
    }

    /// "" when the save is on the card; "R:<why>" refused; "E:<why>" failed.
    #[no_mangle]
    pub unsafe extern "C" fn voxel_sync_install(len: *mut u32) -> *const u8 {
        let st = st();
        let paths = Paths { save: voxel::SAVE_PATH.into(), backups: BACKUP_DIR.into() };
        let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let (reply, wrote) = st.host.install(&mut StdStore, &paths, GAME, &vcsave::stamp(secs));
        let (p, n) = (reply.as_ptr(), reply.len());
        if let Some(body) = wrote {
            // what CONTINUE reads from now on
            voxel::set_save_buf(body);
        }
        flush(st);
        *len = n as u32;
        p
    }

    #[no_mangle]
    pub unsafe extern "C" fn voxel_sync_discard() {
        st().host.discard();
    }

    #[no_mangle]
    pub unsafe extern "C" fn voxel_sync_close() {
        shut(st());
    }
}
/// The Gen 3 builds have no SYNC: the natives answer "not here".
#[cfg(feature = "gen3")]
mod imp {
    #[no_mangle]
    pub unsafe extern "C" fn voxel_sync_open() -> i32 {
        -2
    }
    #[no_mangle]
    pub unsafe extern "C" fn voxel_sync_poll(len: *mut u32) -> *const u8 {
        static S: &[u8] = b"S\terror\tnot in this game\n";
        *len = S.len() as u32;
        S.as_ptr()
    }
    #[no_mangle]
    pub unsafe extern "C" fn voxel_sync_offer(_id: *const u8, _len: i32) -> i32 {
        0
    }
    #[no_mangle]
    pub unsafe extern "C" fn voxel_sync_pull(_id: *const u8, _len: i32) -> i32 {
        0
    }
    #[no_mangle]
    pub unsafe extern "C" fn voxel_sync_received(len: *mut u32) -> *const u8 {
        *len = 0;
        core::ptr::null()
    }
    #[no_mangle]
    pub unsafe extern "C" fn voxel_sync_install(len: *mut u32) -> *const u8 {
        static S: &[u8] = b"E:NOT IN THIS GAME";
        *len = S.len() as u32;
        S.as_ptr()
    }
    #[no_mangle]
    pub unsafe extern "C" fn voxel_sync_discard() {}
    #[no_mangle]
    pub unsafe extern "C" fn voxel_sync_close() {}
}
