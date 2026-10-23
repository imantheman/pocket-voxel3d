//! SYNC's host side: the title-screen save transfer with the PC/phone games
//! on the same wifi (PVS1; crates/pocketvoxel-sync is the protocol). The
//! guest's screen (voxelmon/game/sync/model.ts) reaches this through the
//! `voxel.sync*` natives (vendor/quickjs/voxel_shim.c):
//!
//! - `syncOpen()` starts SOC (the IP stack) and binds UDP 47610 / TCP 47611;
//!   0 when there is no network ("ERROR: NO WIFI").
//! - `syncPoll()` runs one frame of the session and reports, one record a
//!   line, tab-separated: `S open|nowifi|error <why>`, `H <0|1>` (we have a
//!   save to serve), `P <id> <platform> <game> <offered> <name>` per peer,
//!   `G <got> <size> <name>` while pulling, and the events once each:
//!   `O <name>` (an offer), `R <name> <size>` (a save arrived),
//!   `F <name> <why>` (a pull failed).
//! - `syncReceived()` / `syncInstall()` / `syncDiscard()`: the arrived save
//!   for the guest's own reader, then written (or dropped).
//! - `syncClose()` closes every socket and stops SOC.
//!
//! The save served is the file on the card, byte for byte, read when the
//! screen opens and after an install. Nothing here runs unless the screen is
//! open, and nothing is ever written without the player's two A presses.

#[cfg(not(feature = "gen3"))]
mod imp {
    use crate::voxel;
    use ctru::services::soc::Soc;
    use pocketvoxel_core::vcsave;
    use pocketvoxel_sync::install::{self, Paths, StdStore};
    use pocketvoxel_sync::luadata;
    use pocketvoxel_sync::net::{self, StdNet};
    use pocketvoxel_sync::proto;
    use pocketvoxel_sync::session::{Config, Event, PullPhase, Session};
    use std::fmt::Write as _;
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
        // (dropped in this order: the sockets before SOC)
        session: Option<Session<StdNet>>,
        soc: Option<Soc>,
        nowifi: bool,
        error: Option<String>,
        received: Option<(String, Vec<u8>)>,
        out: String,
        reply: String,
    }

    static mut ST: Option<State> = None;

    fn log(s: &str) {
        crate::dlog(&format!("[pv] sync: {}", s));
    }

    fn now() -> f64 {
        unsafe { voxel::voxel_now_us() / 1e6 }
    }

    fn card_save() -> Option<Vec<u8>> {
        std::fs::read(voxel::SAVE_PATH).ok().filter(|b| !b.is_empty())
    }

    /// The name HELLO carries: the save's player, else "3DS".
    fn name_of(body: Option<&[u8]>) -> String {
        body.and_then(|b| luadata::check(b).ok())
            .and_then(|i| i.player_name)
            .map(|n| proto::sanitize_name(&n))
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| "3DS".into())
    }

    /// No tab or newline gets into a record.
    fn field(s: &str) -> String {
        s.chars().map(|c| if c == '\t' || c == '\n' || c == '\r' { ' ' } else { c }).collect()
    }

    #[allow(static_mut_refs)]
    unsafe fn st() -> Option<&'static mut State> {
        ST.as_mut()
    }

    unsafe fn arg(p: *const u8, len: i32) -> String {
        if p.is_null() || len <= 0 {
            return String::new();
        }
        String::from_utf8_lossy(core::slice::from_raw_parts(p, len as usize)).into_owned()
    }

    #[no_mangle]
    pub unsafe extern "C" fn voxel_sync_open() -> i32 {
        voxel_sync_close();
        let mut st = State { session: None, soc: None, nowifi: false, error: None, received: None, out: String::new(), reply: String::new() };
        let soc = match Soc::new() {
            Ok(s) => s,
            Err(e) => {
                log(&format!("SOC would not start ({:?}): no wifi", e));
                st.nowifi = true;
                ST = Some(st);
                return 0;
            }
        };
        let ip = soc.host_address();
        if ip.is_unspecified() {
            log("no IP address: wifi is off or not connected");
            drop(soc);
            st.nowifi = true;
            ST = Some(st);
            return 0;
        }
        let net = match StdNet::bind(Ipv4Addr::UNSPECIFIED, proto::UDP_PORT, proto::TCP_PORT) {
            Ok(n) => n,
            Err(e) => {
                log(&format!("bind {}/{} failed: {}", proto::UDP_PORT, proto::TCP_PORT, e));
                st.error = Some(format!("PORT {} IN USE", proto::UDP_PORT));
                st.soc = Some(soc);
                ST = Some(st);
                return -1;
            }
        };
        let mut targets = vec![SocketAddrV4::new(Ipv4Addr::BROADCAST, proto::UDP_PORT)];
        if let Some(b) = net::subnet_broadcast(ip) {
            targets.push(SocketAddrV4::new(b, proto::UDP_PORT));
        }
        extern "C" {
            fn svcGetSystemTick() -> u64;
        }
        let seed = svcGetSystemTick() ^ ((u32::from(ip) as u64) << 21);
        let body = card_save();
        let name = name_of(body.as_deref());
        let cfg = Config { id: proto::make_id(seed), platform: "3ds".into(), game: GAME.into(), name: name.clone(), tcp_port: net.tcp_port(), targets };
        let mut session = Session::new(net, cfg);
        log(&format!(
            "open: {} as {} ({}, {}), serving {} bytes",
            ip,
            session.id(),
            GAME,
            name,
            body.as_ref().map(|b| b.len()).unwrap_or(0)
        ));
        session.set_body(body);
        st.session = Some(session);
        st.soc = Some(soc);
        ST = Some(st);
        1
    }

    #[no_mangle]
    pub unsafe extern "C" fn voxel_sync_poll(len: *mut u32) -> *const u8 {
        let Some(st) = st() else {
            if !len.is_null() {
                *len = 0;
            }
            return core::ptr::null();
        };
        let State { session, nowifi, error, received, out, .. } = st;
        out.clear();
        if *nowifi {
            out.push_str("S\tnowifi\n");
        } else if let Some(e) = error {
            let _ = writeln!(out, "S\terror\t{}", field(e));
        } else if let Some(s) = session.as_mut() {
            s.tick(now());
            out.push_str("S\topen\n");
            let _ = writeln!(out, "H\t{}", if s.has_body() { 1 } else { 0 });
            for p in s.peers() {
                let _ = writeln!(out, "P\t{}\t{}\t{}\t{}\t{}", p.id, field(&p.platform), field(&p.game), if p.offered { 1 } else { 0 }, field(&p.label()));
            }
            if let Some((name, phase)) = s.pulling() {
                let (got, size) = match phase {
                    PullPhase::Body { got, size } => (*got, *size),
                    _ => (0, 0),
                };
                let _ = writeln!(out, "G\t{}\t{}\t{}", got, size, field(name));
            }
            while let Some(ev) = s.poll_event() {
                match ev {
                    Event::Offer { name, .. } => {
                        log(&format!("{} offers its save", name));
                        let _ = writeln!(out, "O\t{}", field(&name));
                    }
                    Event::Pulled { name, body, .. } => {
                        log(&format!("got {} bytes from {} (crc {:08x})", body.len(), name, proto::crc32(&body)));
                        let _ = writeln!(out, "R\t{}\t{}", field(&name), body.len());
                        *received = Some((name, body));
                    }
                    Event::PullFailed { name, reason, .. } => {
                        log(&format!("pull from {} failed: {}", name, reason));
                        let _ = writeln!(out, "F\t{}\t{}", field(&name), field(&reason));
                    }
                }
            }
        }
        if !len.is_null() {
            *len = out.len() as u32;
        }
        out.as_ptr()
    }

    #[no_mangle]
    pub unsafe extern "C" fn voxel_sync_offer(id: *const u8, len: i32) -> i32 {
        let id = arg(id, len);
        let Some(s) = st().and_then(|st| st.session.as_mut()) else { return 0 };
        match s.offer(&id) {
            Ok(()) => {
                log(&format!("offered our save to {}", id));
                1
            }
            Err(e) => {
                log(&format!("offer to {} failed: {}", id, e));
                0
            }
        }
    }

    #[no_mangle]
    pub unsafe extern "C" fn voxel_sync_pull(id: *const u8, len: i32) -> i32 {
        let id = arg(id, len);
        let Some(s) = st().and_then(|st| st.session.as_mut()) else { return 0 };
        match s.pull(&id) {
            Ok(()) => {
                log(&format!("pulling from {}", id));
                1
            }
            Err(e) => {
                log(&format!("pull from {} not started: {}", id, e));
                0
            }
        }
    }

    #[no_mangle]
    pub unsafe extern "C" fn voxel_sync_received(len: *mut u32) -> *const u8 {
        match st().and_then(|st| st.received.as_ref()) {
            Some((_, body)) => {
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
        let Some(st) = st() else {
            *len = 0;
            return core::ptr::null();
        };
        st.reply = match st.received.take() {
            None => "E:NOTHING RECEIVED".into(),
            Some((from, body)) => {
                let paths = Paths { save: voxel::SAVE_PATH.into(), backups: BACKUP_DIR.into() };
                let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
                match install::install(&mut StdStore, &paths, &body, GAME, &vcsave::stamp(secs)) {
                    Ok(info) => {
                        log(&format!("installed {} bytes from {} over {} (player {})", body.len(), from, voxel::SAVE_PATH, info.player_name.as_deref().unwrap_or("?")));
                        // CONTINUE reads this; HELLO now offers it
                        voxel::set_save_buf(body.clone());
                        if let Some(s) = st.session.as_mut() {
                            s.set_name(&name_of(Some(&body)));
                            s.set_body(Some(body));
                        }
                        String::new()
                    }
                    Err(r) => {
                        log(&format!("install refused: {:?}", r));
                        format!("{}:{}", if r.is_error() { "E" } else { "R" }, r.reason())
                    }
                }
            }
        };
        *len = st.reply.len() as u32;
        st.reply.as_ptr()
    }

    #[no_mangle]
    pub unsafe extern "C" fn voxel_sync_discard() {
        if let Some(st) = st() {
            st.received = None;
        }
    }

    #[no_mangle]
    #[allow(static_mut_refs)]
    pub unsafe extern "C" fn voxel_sync_close() {
        if ST.take().is_some() {
            log("closed");
        }
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
