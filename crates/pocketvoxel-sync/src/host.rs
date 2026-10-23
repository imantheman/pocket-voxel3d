//! One SYNC screen's worth of host state: the sockets, the session, the
//! save that arrived, and the text records the game's screen reads. The
//! 3DS host (crates/pocketvoxel-3ds/src/sync.rs) adds only SOC and the FFI
//! around this, so the open/close life cycle runs in host tests.
//!
//! - [`SyncHost::open`] binds once per visit: a second open while open
//!   keeps the sockets it has. A port that cannot be had falls back
//!   ([`StdNet::bind_lenient`]); the screen gets a note, not an error.
//! - [`SyncHost::close`] drops every socket, once; open again afterwards
//!   binds afresh.
//! - [`SyncHost::poll`] runs one frame and reports, one record a line,
//!   tab-separated: `S open|nowifi|error <why>`, `N <note>` (a port fell
//!   back), `H <0|1>` (a save to serve), `P <id> <platform> <game>
//!   <offered> <name>` per peer, `G <got> <size> <name>` while pulling, and
//!   the events once each: `O <name>`, `R <name> <size>`, `F <name> <why>`.

use crate::install::{self, Paths, Store};
use crate::luadata;
use crate::net::StdNet;
use crate::proto;
use crate::session::{Config, Event, PullPhase, Session};
use std::fmt::Write as _;
use std::net::{Ipv4Addr, SocketAddrV4};

/// Who we are and where to bind.
#[derive(Clone, Debug)]
pub struct HostConfig {
    pub id: String,
    pub platform: String,
    pub game: String,
    /// 0.0.0.0 on the console; 127.0.0.1 in tests.
    pub bind_ip: Ipv4Addr,
    /// The ports asked for ([`proto::UDP_PORT`], [`proto::TCP_PORT`]).
    pub udp_port: u16,
    pub tcp_port: u16,
    pub targets: Vec<SocketAddrV4>,
    /// The save to serve, byte for byte.
    pub save: Option<Vec<u8>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum State {
    Closed,
    NoWifi,
    Error(String),
    Open,
}

pub struct SyncHost {
    state: State,
    session: Option<Session<StdNet>>,
    received: Option<(String, Vec<u8>)>,
    note: Option<String>,
    out: String,
    reply: String,
    log: Vec<String>,
    /// How many times sockets were bound (tests: one per visit).
    pub binds: u32,
}

impl Default for SyncHost {
    fn default() -> Self {
        Self::new()
    }
}

/// The name HELLO carries: the save's player, else `fallback`.
pub fn name_of(body: Option<&[u8]>, fallback: &str) -> String {
    body.and_then(|b| luadata::check(b).ok())
        .and_then(|i| i.player_name)
        .map(|n| proto::sanitize_name(&n))
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

/// No tab or newline gets into a record.
fn field(s: &str) -> String {
    s.chars().map(|c| if c == '\t' || c == '\n' || c == '\r' { ' ' } else { c }).collect()
}

impl SyncHost {
    pub fn new() -> Self {
        SyncHost { state: State::Closed, session: None, received: None, note: None, out: String::new(), reply: String::new(), log: Vec::new(), binds: 0 }
    }

    pub fn is_open(&self) -> bool {
        self.state == State::Open && self.session.is_some()
    }

    /// The session, while open (tests).
    pub fn session(&self) -> Option<&Session<StdNet>> {
        self.session.as_ref()
    }

    /// The note shown under the status, if any.
    pub fn note(&self) -> Option<&str> {
        self.note.as_deref()
    }

    /// Lines for the log since the last call.
    pub fn take_log(&mut self) -> Vec<String> {
        if let Some(s) = self.session.as_mut() {
            for n in s.take_notes() {
                self.log.push(n);
            }
        }
        std::mem::take(&mut self.log)
    }

    /// No network: the screen says so and offers BACK.
    pub fn set_nowifi(&mut self) {
        self.close();
        self.state = State::NoWifi;
    }

    /// Bind and start the session. Already open: nothing is bound again.
    /// Err (and the screen shows it) only when no socket could be made.
    pub fn open(&mut self, cfg: HostConfig) -> Result<(), String> {
        if self.is_open() {
            self.log.push("open: already open; keeping the sockets".into());
            return Ok(());
        }
        self.close();
        self.binds += 1;
        let bound = match StdNet::bind_lenient(cfg.bind_ip, cfg.udp_port, cfg.tcp_port) {
            Ok(b) => b,
            Err(e) => {
                self.log.push(format!("open failed: {}", e.log));
                self.state = State::Error(e.short.clone());
                return Err(e.log);
            }
        };
        for n in &bound.notes {
            self.log.push(n.clone());
        }
        let udp = bound.net.udp_port();
        let tcp = bound.net.tcp_port();
        // the note says where we are and why (the raw errno, until every
        // console's reasons are known)
        self.note = if bound.udp_fell_back {
            Some(match bound.udp_errno {
                Some(n) => format!("UDP PORT {} E{}", udp, n),
                None => format!("UDP PORT {}", udp),
            })
        } else {
            None
        };
        if bound.udp_fell_back {
            self.log.push(format!("udp {} was not to be had: on {} (HELLO still to {}, peers answer by unicast)", cfg.udp_port, udp, cfg.udp_port));
        }
        if bound.tcp_fell_back {
            self.log.push(format!("tcp {} was not to be had: on {} (HELLO says so)", cfg.tcp_port, tcp));
        }
        let name = name_of(cfg.save.as_deref(), &proto::sanitize_name(&cfg.platform));
        let size = cfg.save.as_ref().map(|b| b.len()).unwrap_or(0);
        let config = Config { id: cfg.id.clone(), platform: cfg.platform, game: cfg.game.clone(), name: name.clone(), tcp_port: tcp, targets: cfg.targets };
        let mut session = Session::new(bound.net, config);
        session.set_body(cfg.save);
        self.log.push(format!("open: {} ({}, {}) udp {} tcp {}, serving {} bytes", cfg.id, cfg.game, name, udp, tcp, size));
        self.session = Some(session);
        self.state = State::Open;
        Ok(())
    }

    /// Drop every socket (once) and anything received.
    pub fn close(&mut self) {
        if self.session.take().is_some() {
            self.log.push("closed: sockets released".into());
        }
        self.received = None;
        self.note = None;
        self.state = State::Closed;
    }

    /// One frame of networking, then the records (module notes).
    pub fn poll(&mut self, now: f64) -> &str {
        self.out.clear();
        match &self.state {
            State::Closed => {}
            State::NoWifi => self.out.push_str("S\tnowifi\n"),
            State::Error(e) => {
                let _ = writeln!(self.out, "S\terror\t{}", field(e));
            }
            State::Open => {
                let Some(s) = self.session.as_mut() else { return &self.out };
                s.tick(now);
                self.out.push_str("S\topen\n");
                if let Some(n) = &self.note {
                    let _ = writeln!(self.out, "N\t{}", field(n));
                }
                let _ = writeln!(self.out, "H\t{}", if s.has_body() { 1 } else { 0 });
                for p in s.peers() {
                    let _ = writeln!(self.out, "P\t{}\t{}\t{}\t{}\t{}", p.id, field(&p.platform), field(&p.game), if p.offered { 1 } else { 0 }, field(&p.label()));
                }
                if let Some((name, phase)) = s.pulling() {
                    let (got, size) = match phase {
                        PullPhase::Body { got, size } => (*got, *size),
                        _ => (0, 0),
                    };
                    let _ = writeln!(self.out, "G\t{}\t{}\t{}", got, size, field(name));
                }
                while let Some(ev) = s.poll_event() {
                    match ev {
                        Event::Offer { name, .. } => {
                            self.log.push(format!("{} offers its save", name));
                            let _ = writeln!(self.out, "O\t{}", field(&name));
                        }
                        Event::Pulled { name, body, .. } => {
                            self.log.push(format!("got {} bytes from {} (crc {:08x})", body.len(), name, proto::crc32(&body)));
                            let _ = writeln!(self.out, "R\t{}\t{}", field(&name), body.len());
                            self.received = Some((name, body));
                        }
                        Event::PullFailed { name, reason, .. } => {
                            self.log.push(format!("pull from {} failed: {}", name, reason));
                            let _ = writeln!(self.out, "F\t{}\t{}", field(&name), field(&reason));
                        }
                    }
                }
            }
        }
        &self.out
    }

    pub fn offer(&mut self, id: &str) -> bool {
        let Some(s) = self.session.as_mut() else { return false };
        match s.offer(id) {
            Ok(()) => {
                self.log.push(format!("offered our save to {}", id));
                true
            }
            Err(e) => {
                self.log.push(format!("offer to {} failed: {}", id, e));
                false
            }
        }
    }

    pub fn pull(&mut self, id: &str) -> bool {
        let Some(s) = self.session.as_mut() else { return false };
        match s.pull(id) {
            Ok(()) => {
                self.log.push(format!("pulling from {}", id));
                true
            }
            Err(e) => {
                self.log.push(format!("pull from {} not started: {}", id, e));
                false
            }
        }
    }

    /// The save a finished pull brought, as received.
    pub fn received(&self) -> Option<&[u8]> {
        self.received.as_ref().map(|(_, b)| b.as_slice())
    }

    pub fn discard(&mut self) {
        self.received = None;
    }

    /// Install the received save ([`install::install`]). The reply is ""
    /// when it is on the card, "R:<why>" refused, "E:<why>" failed; on
    /// success also the bytes now on the card (for the save CONTINUE reads).
    pub fn install(&mut self, store: &mut dyn Store, paths: &Paths, game: &str, stamp: &str) -> (&str, Option<Vec<u8>>) {
        let mut wrote = None;
        self.reply = match self.received.take() {
            None => "E:NOTHING RECEIVED".into(),
            Some((from, body)) => match install::install(store, paths, &body, game, stamp) {
                Ok(info) => {
                    self.log.push(format!("installed {} bytes from {} over {} (player {})", body.len(), from, paths.save, info.player_name.as_deref().unwrap_or("?")));
                    if let Some(s) = self.session.as_mut() {
                        s.set_name(&name_of(Some(&body), "3DS"));
                        s.set_body(Some(body.clone()));
                    }
                    wrote = Some(body);
                    String::new()
                }
                Err(r) => {
                    self.log.push(format!("install refused: {:?}", r));
                    format!("{}:{}", if r.is_error() { "E" } else { "R" }, r.reason())
                }
            },
        };
        (&self.reply, wrote)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::UdpSocket;
    use std::time::Duration;

    const LO: Ipv4Addr = Ipv4Addr::LOCALHOST;

    fn free_port() -> u16 {
        // a port nothing holds right now (closed again at once)
        UdpSocket::bind((LO, 0)).unwrap().local_addr().unwrap().port()
    }

    fn cfg(id: &str, udp: u16, tcp: u16, targets: Vec<SocketAddrV4>, save: Option<&[u8]>) -> HostConfig {
        HostConfig { id: id.into(), platform: "3ds".into(), game: "gold".into(), bind_ip: LO, udp_port: udp, tcp_port: tcp, targets, save: save.map(|b| b.to_vec()) }
    }

    #[test]
    fn open_twice_binds_once_and_close_releases() {
        let (u, t) = (free_port(), free_port());
        let mut h = SyncHost::new();
        h.open(cfg("a1", u, t, vec![], None)).unwrap();
        assert!(h.is_open());
        assert_eq!(h.binds, 1);
        assert_eq!(h.session().unwrap().net().udp_port(), u);
        // a second open in the same visit keeps the sockets
        h.open(cfg("a1", u, t, vec![], None)).unwrap();
        assert_eq!(h.binds, 1);
        assert_eq!(h.note(), None);
        assert!(h.take_log().iter().any(|l| l.contains("already open")));
        // close lets go of both ports: anyone may bind them now
        h.close();
        assert!(!h.is_open());
        assert!(h.take_log().iter().any(|l| l.contains("sockets released")));
        drop(UdpSocket::bind((LO, u)).expect("udp port released"));
        drop(std::net::TcpListener::bind((LO, t)).expect("tcp port released"));
        // and closing again is nothing
        h.close();
        assert!(h.take_log().is_empty());
    }

    #[test]
    fn open_close_open_gets_the_same_ports_again() {
        let (u, t) = (free_port(), free_port());
        let mut h = SyncHost::new();
        for visit in 0..3 {
            h.open(cfg("b2", u, t, vec![], None)).unwrap();
            let s = h.session().unwrap();
            assert_eq!(s.net().udp_port(), u, "visit {}", visit);
            assert_eq!(s.net().tcp_port(), t, "visit {}", visit);
            assert_eq!(h.note(), None);
            assert!(h.poll(0.0).starts_with("S\topen\n"));
            h.close();
        }
        assert_eq!(h.binds, 3);
    }

    #[test]
    fn a_taken_port_falls_back_with_a_note_not_an_error() {
        let (u, t) = (free_port(), free_port());
        let _udp_holder = UdpSocket::bind((LO, u)).unwrap();
        let _tcp_holder = std::net::TcpListener::bind((LO, t)).unwrap();
        let mut h = SyncHost::new();
        h.open(cfg("c3", u, t, vec![], None)).unwrap();
        let s = h.session().unwrap();
        assert_ne!(s.net().udp_port(), u);
        assert_ne!(s.net().tcp_port(), t);
        let note = h.note().unwrap().to_string();
        assert!(note.starts_with(&format!("UDP PORT {} E", s.net().udp_port())), "{}", note);
        let out = h.poll(0.0).to_string();
        assert!(out.starts_with("S\topen\n"), "{}", out);
        assert!(out.contains(&format!("N\t{}\n", note)), "{}", out);
        let log = h.take_log().join("\n");
        assert!(log.contains("udp bind 127.0.0.1"), "{}", log);
        assert!(log.contains("errno"), "{}", log);
        assert!(log.contains("was not to be had"), "{}", log);
    }

    /// The other side's broadcasts never reach us (our standard port is
    /// someone else's): we still find it -- our HELLO reaches it, its echo
    /// reaches our fallback port -- and pull its save.
    #[test]
    fn with_the_standard_port_taken_discovery_and_a_pull_still_work() {
        let std_port = free_port();
        let _holder = UdpSocket::bind((LO, std_port)).unwrap();
        let (bu, bt) = (free_port(), free_port());
        let save = b"return {\n  player = {\n    name = \"KRIS\",\n  },\n  version = \"gold\",\n}\n".to_vec();
        // B: on its own ports; its HELLOs go to the standard port (lost)
        let mut b = SyncHost::new();
        b.open(cfg("b0b0b0b0", bu, bt, vec![SocketAddrV4::new(LO, std_port)], Some(&save))).unwrap();
        // A: asks for the standard port, falls back, HELLOs to B
        let mut a = SyncHost::new();
        a.open(cfg("a0a0a0a0", std_port, free_port(), vec![SocketAddrV4::new(LO, bu)], None)).unwrap();
        assert!(a.note().is_some());
        let mut t = 0.0;
        let mut found = false;
        while t < 4.0 {
            t += 1.0 / 60.0;
            let ra = a.poll(t).to_string();
            b.poll(t);
            if ra.contains("P\tb0b0b0b0\t") {
                found = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        assert!(found, "A never heard B");
        assert!(a.pull("b0b0b0b0"));
        let mut got = false;
        while t < 15.0 {
            t += 1.0 / 60.0;
            let ra = a.poll(t).to_string();
            b.poll(t);
            if ra.contains("R\tKRIS\t") {
                got = true;
                break;
            }
            assert!(!ra.contains("\nF\t"), "{}", ra);
            std::thread::sleep(Duration::from_millis(2));
        }
        assert!(got, "no save");
        assert_eq!(a.received(), Some(save.as_slice()));
        let log = a.take_log().join("\n");
        assert!(log.contains(&format!("HELLO to 127.0.0.1:{}: ok", bu)), "{}", log);
    }

    #[test]
    fn records_for_nowifi_and_closed() {
        let mut h = SyncHost::new();
        assert_eq!(h.poll(0.0), "");
        h.set_nowifi();
        assert_eq!(h.poll(0.0), "S\tnowifi\n");
    }

    #[test]
    fn hello_names() {
        assert_eq!(name_of(Some(b"return { player = { name = \"Kris\" }, version = \"gold\" }"), "3DS"), "KRIS");
        assert_eq!(name_of(Some(b"not a save"), "3DS"), "3DS");
        assert_eq!(name_of(None, "3DS"), "3DS");
    }
}
