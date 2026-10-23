//! One open SYNC screen: discovery, offers, serving our save and pulling a
//! peer's, all non-blocking and driven by [`Session::tick`] once a frame.
//!
//! The sockets sit behind [`Net`] / [`Conn`], so the same state machine runs
//! over std::net on the 3DS and on a desktop (net.rs) and over anything a
//! test wants.

use crate::proto::{self, Hello, Msg, HELLO_EVERY, IO_TIMEOUT, MAX_SAVE, PEER_TTL};
use std::collections::VecDeque;
use std::io;
use std::net::SocketAddrV4;
use std::rc::Rc;

/// Datagrams read per tick, at most.
pub const UDP_PER_TICK: usize = 64;
/// TCP bytes read per tick, at most (and as much again written).
pub const TCP_BYTES_PER_TICK: usize = 64 * 1024;
/// New connections taken per tick.
pub const ACCEPT_PER_TICK: usize = 4;
/// Transfers served at once; more are turned away.
pub const MAX_SERVING: usize = 4;
/// The largest single write a transfer makes, and where it starts.
///
/// A real 3DS's SOC is not a desktop stack: its TCP send buffer is small,
/// and a non-blocking send that does not fit may be refused whole (would
/// block) rather than taken in part -- so one big write, retried every
/// frame, never goes. Writes stay under libctru's small-send path (8 KB),
/// halve on every refusal down to [`MIN_CHUNK`] (retried at once, up to
/// [`REFUSALS_PER_FRAME`]), and grow back fourfold whenever one is taken.
pub const MAX_CHUNK: usize = 4096;
pub const MIN_CHUNK: usize = 256;
/// Refused writes a transfer takes in one frame (each retried smaller)
/// before it waits for the next.
pub const REFUSALS_PER_FRAME: u32 = 8;

/// A TCP connection.
pub trait Conn {
    /// True once connected; false while a connect is still in flight.
    fn poll_connected(&mut self) -> io::Result<bool>;
    /// Bytes read; `Ok(0)` is the end of the stream; `WouldBlock` is "none yet".
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize>;
    /// Bytes written; `WouldBlock` is "not now".
    fn write(&mut self, buf: &[u8]) -> io::Result<usize>;
}

/// The sockets: one UDP socket (sends come from it, so its port is our
/// HELLO source port) and one TCP listener.
pub trait Net {
    fn send_to(&mut self, data: &[u8], to: SocketAddrV4) -> io::Result<()>;
    /// One datagram, or None when there is none waiting.
    fn recv_from(&mut self, buf: &mut [u8]) -> io::Result<Option<(usize, SocketAddrV4)>>;
    /// One waiting connection, or None.
    fn accept(&mut self) -> io::Result<Option<Box<dyn Conn>>>;
    /// Start a connect; it completes later ([`Conn::poll_connected`]).
    fn connect(&mut self, to: SocketAddrV4) -> io::Result<Box<dyn Conn>>;
}

/// Who we are.
#[derive(Clone, Debug)]
pub struct Config {
    /// The session id ([`proto::make_id`]).
    pub id: String,
    /// `3ds`, `pc`, ...
    pub platform: String,
    /// The running game's token.
    pub game: String,
    /// The player's name (sanitized on the way out).
    pub name: String,
    /// The TCP port we listen on, as HELLO advertises it.
    pub tcp_port: u16,
    /// Where every HELLO goes besides the known peers: the broadcast
    /// addresses (and, in tests, a peer's port on 127.0.0.1).
    pub targets: Vec<SocketAddrV4>,
}

/// A peer we have heard from in the last [`PEER_TTL`] seconds.
#[derive(Clone, Debug)]
pub struct Peer {
    pub id: String,
    /// Its IP and UDP (HELLO source) port.
    pub addr: SocketAddrV4,
    pub tcp_port: u16,
    pub platform: String,
    pub game: String,
    /// What it would serve now.
    pub size: usize,
    pub crc: u32,
    /// Sanitized; may be empty.
    pub name: String,
    /// It sent us an OFFER we have not acted on.
    pub offered: bool,
    seen: f64,
}

impl Peer {
    /// The name to show: its own, else its platform.
    pub fn label(&self) -> String {
        if self.name.is_empty() { proto::sanitize_name(&self.platform) } else { self.name.clone() }
    }
}

/// Something the screen should hear about, once.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    /// A peer asked us to pull its save.
    Offer { id: String, name: String },
    /// A pull finished and the CRC matched: the bytes, exactly as sent.
    Pulled { id: String, name: String, body: Vec<u8> },
    /// A pull failed; nothing was received.
    PullFailed { id: String, name: String, reason: String },
}

/// Where a pull is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PullPhase {
    Connecting,
    Requesting,
    Header,
    Body { got: usize, size: usize },
}

struct Pull {
    id: String,
    name: String,
    conn: Box<dyn Conn>,
    phase: PullPhase,
    started: f64,
    request: Vec<u8>,
    sent: usize,
    line: Vec<u8>,
    body: Vec<u8>,
    crc: u32,
}

struct Serve {
    /// For the log: the n-th connection taken this visit.
    n: u32,
    conn: Box<dyn Conn>,
    started: f64,
    line: Vec<u8>,
    /// The reply once the request is read: header, then (for OK) the body.
    head: Vec<u8>,
    body: Option<Rc<[u8]>>,
    sent: usize,
    replied: bool,
    /// The next write's size ([`MAX_CHUNK`]).
    chunk: usize,
    /// Writes refused (would block), and frames that sent something.
    blocked: u32,
    frames: u32,
    /// When progress was last logged.
    logged: f64,
}

pub struct Session<N: Net> {
    net: N,
    cfg: Config,
    /// The save we serve, exactly as stored, and its CRC.
    body: Option<Rc<[u8]>>,
    crc: u32,
    peers: Vec<Peer>,
    serving: Vec<Serve>,
    pull: Option<Pull>,
    events: VecDeque<Event>,
    next_hello: f64,
    now: f64,
    /// What the log should hear: each target's first send result and any
    /// change in it, and each kind of socket error once.
    notes: Vec<String>,
    sent_to: Vec<(SocketAddrV4, String)>,
    errors_seen: Vec<String>,
    accepted: u32,
}

fn would_block(e: &io::Error) -> bool {
    matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted)
}

impl<N: Net> Session<N> {
    pub fn new(net: N, cfg: Config) -> Self {
        Session {
            net,
            cfg,
            body: None,
            crc: 0,
            peers: Vec::new(),
            serving: Vec::new(),
            pull: None,
            events: VecDeque::new(),
            next_hello: 0.0,
            now: 0.0,
            notes: Vec::new(),
            sent_to: Vec::new(),
            errors_seen: Vec::new(),
            accepted: 0,
        }
    }

    pub fn id(&self) -> &str {
        &self.cfg.id
    }
    pub fn net(&self) -> &N {
        &self.net
    }
    pub fn net_mut(&mut self) -> &mut N {
        &mut self.net
    }

    /// The save to serve (None: we have none). Kept byte for byte; a
    /// transfer already under way keeps the bytes it started with.
    pub fn set_body(&mut self, body: Option<Vec<u8>>) {
        self.crc = body.as_deref().map(proto::crc32).unwrap_or(0);
        self.body = body.map(Rc::from);
    }
    pub fn has_body(&self) -> bool {
        self.body.is_some()
    }
    pub fn set_name(&mut self, name: &str) {
        self.cfg.name = name.to_string();
    }

    /// The peers heard from lately, in the order they were first heard.
    pub fn peers(&self) -> &[Peer] {
        &self.peers
    }
    pub fn peer(&self, id: &str) -> Option<&Peer> {
        self.peers.iter().find(|p| p.id == id)
    }

    /// Log lines since the last call (see the `notes` field).
    pub fn take_notes(&mut self) -> Vec<String> {
        std::mem::take(&mut self.notes)
    }

    fn note_error(&mut self, what: &str, e: &io::Error) {
        let line = format!("{}: {}", what, crate::net::describe(e));
        if !self.errors_seen.contains(&line) && self.errors_seen.len() < 32 {
            self.errors_seen.push(line.clone());
            self.notes.push(line);
        }
    }

    /// The next event, if any.
    pub fn poll_event(&mut self) -> Option<Event> {
        self.events.pop_front()
    }

    /// The pull under way: (peer name, phase).
    pub fn pulling(&self) -> Option<(&str, &PullPhase)> {
        self.pull.as_ref().map(|p| (p.name.as_str(), &p.phase))
    }

    fn hello(&self) -> String {
        proto::hello_line(&Hello {
            id: self.cfg.id.clone(),
            tcp_port: self.cfg.tcp_port,
            platform: self.cfg.platform.clone(),
            game: self.cfg.game.clone(),
            size: self.body.as_ref().map(|b| b.len()).unwrap_or(0),
            crc: self.crc,
            name: self.cfg.name.clone(),
        })
    }

    /// HELLO now, to the targets and every known peer.
    pub fn send_hello(&mut self) {
        let line = self.hello();
        let mut to: Vec<SocketAddrV4> = self.cfg.targets.clone();
        for p in &self.peers {
            if !to.contains(&p.addr) {
                to.push(p.addr);
            }
        }
        let targets = self.cfg.targets.clone();
        for a in to {
            // a target that cannot be reached (no route for a broadcast)
            // must not stop the others
            let r = self.net.send_to(line.as_bytes(), a);
            if targets.contains(&a) {
                let said = match &r {
                    Ok(()) => "ok".to_string(),
                    Err(e) => crate::net::describe(e),
                };
                match self.sent_to.iter_mut().find(|(t, _)| *t == a) {
                    Some((_, last)) if *last == said => {}
                    Some((_, last)) => {
                        *last = said.clone();
                        self.notes.push(format!("HELLO to {}: {}", a, said));
                    }
                    None => {
                        self.sent_to.push((a, said.clone()));
                        self.notes.push(format!("HELLO to {}: {}", a, said));
                    }
                }
            }
        }
    }

    /// Ask a peer to pull our save.
    pub fn offer(&mut self, id: &str) -> Result<(), String> {
        let addr = self.peer(id).ok_or("peer gone")?.addr;
        let line = proto::offer_line(&self.cfg.id, id, &self.cfg.game);
        self.net.send_to(line.as_bytes(), addr).map_err(|e| e.to_string())
    }

    /// Start pulling a peer's save of our game.
    pub fn pull(&mut self, id: &str) -> Result<(), String> {
        if self.pull.is_some() {
            return Err("busy".into());
        }
        let p = self.peer(id).ok_or("peer gone")?.clone();
        if p.game != self.cfg.game {
            return Err("different game".into());
        }
        let to = SocketAddrV4::new(*p.addr.ip(), p.tcp_port);
        let conn = self.net.connect(to).map_err(|e| e.to_string())?;
        self.pull = Some(Pull {
            id: p.id.clone(),
            name: p.label(),
            conn,
            phase: PullPhase::Connecting,
            started: self.now,
            request: proto::get_line(&self.cfg.game).into_bytes(),
            sent: 0,
            line: Vec::new(),
            body: Vec::new(),
            crc: 0,
        });
        Ok(())
    }

    /// One frame's work. `now` is seconds on any steady clock.
    pub fn tick(&mut self, now: f64) {
        self.now = now;
        if now >= self.next_hello {
            self.next_hello = now + HELLO_EVERY;
            self.send_hello();
        }
        self.tick_udp();
        self.tick_serve();
        self.tick_pull();
    }

    fn tick_udp(&mut self) {
        let mut buf = [0u8; 1024];
        for _ in 0..UDP_PER_TICK {
            let (n, from) = match self.net.recv_from(&mut buf) {
                Ok(Some(x)) => x,
                Ok(None) => break,
                Err(e) => {
                    self.note_error("udp receive", &e);
                    break;
                }
            };
            match proto::parse_line(&buf[..n]) {
                Some(Msg::Hello(h)) if h.id != self.cfg.id => {
                    let now = self.now;
                    match self.peers.iter_mut().find(|p| p.id == h.id) {
                        Some(p) => {
                            p.addr = from;
                            p.tcp_port = h.tcp_port;
                            p.platform = h.platform;
                            p.game = h.game;
                            p.size = h.size;
                            p.crc = h.crc;
                            p.name = h.name;
                            p.seen = now;
                        }
                        None => self.peers.push(Peer {
                            id: h.id,
                            addr: from,
                            tcp_port: h.tcp_port,
                            platform: h.platform,
                            game: h.game,
                            size: h.size,
                            crc: h.crc,
                            name: h.name,
                            offered: false,
                            seen: now,
                        }),
                    }
                }
                Some(Msg::Offer { from: fid, to, .. }) if to == self.cfg.id => {
                    if let Some(p) = self.peers.iter_mut().find(|p| p.id == fid) {
                        if !p.offered {
                            p.offered = true;
                            let name = p.label();
                            self.events.push_back(Event::Offer { id: fid, name });
                        }
                    }
                }
                _ => {}
            }
        }
        let now = self.now;
        self.peers.retain(|p| now - p.seen <= PEER_TTL);
    }

    fn tick_serve(&mut self) {
        for _ in 0..ACCEPT_PER_TICK {
            match self.net.accept() {
                Ok(Some(conn)) => {
                    self.accepted += 1;
                    if self.serving.len() >= MAX_SERVING {
                        self.notes.push(format!("serve #{}: turned away ({} already)", self.accepted, MAX_SERVING));
                        continue; // dropped: closes it
                    }
                    self.serving.push(Serve {
                        n: self.accepted,
                        conn,
                        started: self.now,
                        line: Vec::new(),
                        head: Vec::new(),
                        body: None,
                        sent: 0,
                        replied: false,
                        chunk: MAX_CHUNK,
                        blocked: 0,
                        frames: 0,
                        logged: self.now,
                    });
                }
                Ok(None) => break,
                Err(e) => {
                    self.note_error("tcp accept", &e);
                    break;
                }
            }
        }
        let mut budget = TCP_BYTES_PER_TICK;
        let now = self.now;
        let game = self.cfg.game.clone();
        let mine = self.body.clone();
        let crc = self.crc;
        let mut notes: Vec<String> = Vec::new();
        self.serving.retain_mut(|s| {
            let total = s.head.len() + s.body.as_ref().map(|b| b.len()).unwrap_or(0);
            if now - s.started > IO_TIMEOUT {
                notes.push(format!("serve #{}: timed out at {} of {} bytes ({} frames, {} refused writes, chunk {})", s.n, s.sent, total, s.frames, s.blocked, s.chunk));
                return false;
            }
            if !s.replied {
                let mut b = [0u8; 256];
                loop {
                    match s.conn.read(&mut b) {
                        Ok(0) => {
                            notes.push(format!("serve #{}: closed before a request", s.n));
                            return false;
                        }
                        Ok(n) => {
                            s.line.extend_from_slice(&b[..n]);
                            if s.line.contains(&b'\n') || s.line.len() > proto::MAX_LINE {
                                break;
                            }
                        }
                        Err(e) if would_block(&e) => break,
                        Err(e) => {
                            notes.push(format!("serve #{}: read: {}", s.n, crate::net::describe(&e)));
                            return false;
                        }
                    }
                }
                let Some(nl) = s.line.iter().position(|&c| c == b'\n') else {
                    // no sane request is this long
                    return s.line.len() <= proto::MAX_LINE;
                };
                let req = String::from_utf8_lossy(&s.line[..nl]).trim_end().to_string();
                s.head = match proto::parse_line(&s.line[..=nl]) {
                    Some(Msg::Get { game: g }) if g == game => match &mine {
                        Some(body) => {
                            s.body = Some(body.clone());
                            proto::ok_line(&game, body.len(), crc).into_bytes()
                        }
                        None => proto::err_line("no save").into_bytes(),
                    },
                    Some(Msg::Get { .. }) => proto::err_line("wrong game").into_bytes(),
                    _ => proto::err_line("bad request").into_bytes(),
                };
                s.replied = true;
                notes.push(format!("serve #{}: \"{}\" -> {}", s.n, req.chars().take(40).collect::<String>(), String::from_utf8_lossy(&s.head).trim_end()));
            }
            // Header, then body, a chunk at a time, for as long as the
            // socket takes them this frame; a refused write halves the
            // chunk and waits for the next frame (MAX_CHUNK).
            let total = s.head.len() + s.body.as_ref().map(|b| b.len()).unwrap_or(0);
            let before = s.sent;
            let mut refused = 0;
            while s.sent < total && budget > 0 {
                let (src, off) = if s.sent < s.head.len() { (&s.head[..], s.sent) } else { (s.body.as_deref().unwrap(), s.sent - s.head.len()) };
                let end = (off + s.chunk.min(budget)).min(src.len());
                match s.conn.write(&src[off..end]) {
                    Ok(0) => {
                        notes.push(format!("serve #{}: the peer stopped taking bytes at {} of {}", s.n, s.sent, total));
                        return false;
                    }
                    Ok(n) => {
                        s.sent += n;
                        budget -= n.min(budget);
                        // taken: the next may be bigger (back up fast: a refusal
                        // may be a full buffer for a moment, not a small one)
                        s.chunk = (s.chunk * 4).min(MAX_CHUNK);
                    }
                    Err(e) if would_block(&e) => {
                        s.blocked += 1;
                        s.chunk = (s.chunk / 2).max(MIN_CHUNK);
                        refused += 1;
                        if refused >= REFUSALS_PER_FRAME {
                            break;
                        }
                    }
                    Err(e) => {
                        notes.push(format!("serve #{}: write at {} of {}: {}", s.n, s.sent, total, crate::net::describe(&e)));
                        return false;
                    }
                }
            }
            if s.sent > before {
                s.frames += 1;
            }
            if s.sent >= total {
                notes.push(format!("serve #{}: sent all {} bytes in {:.2} s ({} frames, {} refused writes)", s.n, total, now - s.started, s.frames, s.blocked));
                // all written: dropping the connection closes it
                return false;
            }
            if now - s.logged >= 1.0 {
                s.logged = now;
                notes.push(format!("serve #{}: {} of {} bytes, +{} this frame, {} refused writes, chunk {}", s.n, s.sent, total, s.sent - before, s.blocked, s.chunk));
            }
            true
        });
        self.notes.extend(notes);
    }
    fn tick_pull(&mut self) {
        let Some(mut p) = self.pull.take() else { return };
        let outcome = self.step_pull(&mut p);
        match outcome {
            None => {
                if self.now - p.started > IO_TIMEOUT {
                    self.events.push_back(Event::PullFailed { id: p.id, name: p.name, reason: "timed out".into() });
                } else {
                    self.pull = Some(p);
                }
            }
            Some(Ok(body)) => {
                if let Some(peer) = self.peers.iter_mut().find(|x| x.id == p.id) {
                    peer.offered = false;
                }
                self.events.push_back(Event::Pulled { id: p.id, name: p.name, body });
            }
            Some(Err(reason)) => self.events.push_back(Event::PullFailed { id: p.id, name: p.name, reason }),
        }
    }

    /// Advance a pull: None while it is still going.
    fn step_pull(&mut self, p: &mut Pull) -> Option<Result<Vec<u8>, String>> {
        if p.phase == PullPhase::Connecting {
            match p.conn.poll_connected() {
                Ok(true) => p.phase = PullPhase::Requesting,
                Ok(false) => return None,
                Err(e) => return Some(Err(conn_reason(&e))),
            }
        }
        if p.phase == PullPhase::Requesting {
            while p.sent < p.request.len() {
                match p.conn.write(&p.request[p.sent..]) {
                    Ok(0) => return Some(Err("connection dropped".into())),
                    Ok(n) => p.sent += n,
                    Err(e) if would_block(&e) => return None,
                    Err(e) => return Some(Err(conn_reason(&e))),
                }
            }
            p.phase = PullPhase::Header;
        }
        let mut budget = TCP_BYTES_PER_TICK;
        let mut buf = vec![0u8; 16 * 1024];
        while budget > 0 {
            let want = match &p.phase {
                PullPhase::Header => 1, // byte at a time up to the newline: the body is not ours to over-read
                PullPhase::Body { got, size } => (size - got).min(buf.len()).min(budget),
                _ => unreachable!(),
            };
            if want == 0 {
                break;
            }
            let n = match p.conn.read(&mut buf[..want]) {
                Ok(0) => return Some(Err("connection dropped".into())),
                Ok(n) => n,
                Err(e) if would_block(&e) => return None,
                Err(e) => return Some(Err(conn_reason(&e))),
            };
            budget -= n;
            match p.phase {
                PullPhase::Header => {
                    p.line.push(buf[0]);
                    if buf[0] != b'\n' {
                        if p.line.len() > proto::MAX_LINE {
                            return Some(Err("bad reply".into()));
                        }
                        continue;
                    }
                    match proto::parse_line(&p.line) {
                        Some(Msg::Ok { game, size, crc }) => {
                            if game != self.cfg.game {
                                return Some(Err("wrong game".into()));
                            }
                            if size > MAX_SAVE {
                                return Some(Err("save too big".into()));
                            }
                            p.crc = crc;
                            p.body = Vec::with_capacity(size);
                            p.phase = PullPhase::Body { got: 0, size };
                        }
                        Some(Msg::Err { reason }) => return Some(Err(reason)),
                        _ => return Some(Err("bad reply".into())),
                    }
                }
                PullPhase::Body { ref mut got, size } => {
                    p.body.extend_from_slice(&buf[..n]);
                    *got += n;
                    let _ = size;
                }
                _ => unreachable!(),
            }
            if let PullPhase::Body { got, size } = p.phase {
                if got >= size {
                    let body = std::mem::take(&mut p.body);
                    if proto::crc32(&body) != p.crc {
                        return Some(Err("checksum mismatch".into()));
                    }
                    return Some(Ok(body));
                }
            }
        }
        None
    }
}

fn conn_reason(e: &io::Error) -> String {
    match e.kind() {
        io::ErrorKind::ConnectionRefused => "connection refused".into(),
        io::ErrorKind::ConnectionReset | io::ErrorKind::ConnectionAborted | io::ErrorKind::BrokenPipe => "connection dropped".into(),
        io::ErrorKind::TimedOut => "timed out".into(),
        _ => e.to_string(),
    }
}
