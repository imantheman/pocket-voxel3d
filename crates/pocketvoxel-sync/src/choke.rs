//! Test aid: a [`Net`] whose TCP connections behave like a small, stingy
//! socket -- the way a real 3DS's SOC can, and a desktop stack never does --
//! so the transfer code is tested against it on the host (tests/, and
//! pvsync-peer's `--choke`). UDP passes straight through.

use crate::session::{Conn, Net};
use std::cell::RefCell;
use std::io;
use std::net::SocketAddrV4;
use std::rc::Rc;
use std::time::Instant;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// Nothing changed.
    Off,
    /// A write longer than `cap` is refused whole (would block), and so is
    /// every other write that would fit: one buffer's worth a frame.
    AllOrNothing(usize),
    /// Every write takes at most `max` bytes (and often fewer); reads too.
    Short(usize),
    /// Half the calls would block; the rest are short. Reads too.
    Flaky,
    /// A send buffer of `cap` bytes shared by every connection, drained to
    /// the wire at `rate` bytes a second (wall clock). A connection closed
    /// with bytes still in it keeps sending them, but the buffer they held
    /// is never given back -- the way a console's stack might leak it --
    /// so a later transfer finds less room, or none. A connection shut down
    /// (`shutdown_write`) and kept until the bytes are gone leaks nothing.
    Buffered { cap: usize, rate: usize },
}

impl Mode {
    /// `off`, `allornothing:<n>`, `short:<n>`, `flaky`, `buffered:<cap>:<rate>`.
    pub fn parse(s: &str) -> Option<Mode> {
        let mut it = s.split(':');
        let k = it.next()?;
        let a = it.next();
        let b = it.next();
        match k {
            "off" => Some(Mode::Off),
            "allornothing" => a?.parse().ok().map(Mode::AllOrNothing),
            "short" => a?.parse().ok().map(Mode::Short),
            "flaky" => Some(Mode::Flaky),
            "buffered" => Some(Mode::Buffered { cap: a?.parse().ok()?, rate: b?.parse().ok()? }),
            _ => None,
        }
    }
}

/// The shared send buffer of [`Mode::Buffered`].
struct Pool {
    cap: usize,
    rate: usize,
    /// Bytes waiting in live connections.
    used: usize,
    /// Bytes of buffer lost to connections closed with data in them.
    leaked: usize,
    /// Wire time not yet spent, in bytes.
    allowance: f64,
    last: Instant,
    /// Closed connections still sending what they had.
    orphans: Vec<(Box<dyn Conn>, Vec<u8>)>,
}

impl Pool {
    fn tick(&mut self) {
        let now = Instant::now();
        self.allowance = (self.allowance + now.duration_since(self.last).as_secs_f64() * self.rate as f64).min(self.cap.max(1) as f64);
        self.last = now;
        // the orphans first: their bytes still go out (the buffer they held
        // stays lost)
        let mut i = 0;
        while i < self.orphans.len() {
            let (c, pending) = &mut self.orphans[i];
            let k = pending.len().min(self.allowance as usize);
            if k > 0 {
                if let Ok(n) = c.write(&pending[..k]) {
                    pending.drain(..n);
                    self.allowance -= n as f64;
                }
            }
            if pending.is_empty() {
                let (mut c, _) = self.orphans.remove(i);
                let _ = c.shutdown_write();
            } else {
                i += 1;
            }
        }
    }
    fn room(&self) -> usize {
        self.cap.saturating_sub(self.used + self.leaked)
    }
}

pub struct ChokeNet<N: Net> {
    pub inner: N,
    pub mode: Mode,
    seed: u32,
    pool: Option<Rc<RefCell<Pool>>>,
}

impl<N: Net> ChokeNet<N> {
    pub fn new(inner: N, mode: Mode) -> Self {
        let pool = match mode {
            Mode::Buffered { cap, rate } => Some(Rc::new(RefCell::new(Pool { cap, rate, used: 0, leaked: 0, allowance: 0.0, last: Instant::now(), orphans: Vec::new() }))),
            _ => None,
        };
        ChokeNet { inner, mode, seed: 0x1234_5678, pool }
    }
    /// Buffer lost to unclean closes so far ([`Mode::Buffered`]).
    pub fn leaked(&self) -> usize {
        self.pool.as_ref().map(|p| p.borrow().leaked).unwrap_or(0)
    }
    fn wrap(&mut self, c: Box<dyn Conn>) -> Box<dyn Conn> {
        if self.mode == Mode::Off {
            return c;
        }
        self.seed = self.seed.wrapping_mul(1_103_515_245).wrapping_add(12345);
        Box::new(ChokeConn { inner: Some(c), mode: self.mode, rng: self.seed | 1, calls: 0, pool: self.pool.clone(), pending: Vec::new(), shut: false, shut_done: false })
    }
}

impl<N: Net> Net for ChokeNet<N> {
    fn send_to(&mut self, data: &[u8], to: SocketAddrV4) -> io::Result<()> {
        self.inner.send_to(data, to)
    }
    fn recv_from(&mut self, buf: &mut [u8]) -> io::Result<Option<(usize, SocketAddrV4)>> {
        self.inner.recv_from(buf)
    }
    fn accept(&mut self) -> io::Result<Option<Box<dyn Conn>>> {
        if let Some(p) = &self.pool {
            p.borrow_mut().tick();
        }
        Ok(match self.inner.accept()? {
            Some(c) => Some(self.wrap(c)),
            None => None,
        })
    }
    fn connect(&mut self, to: SocketAddrV4) -> io::Result<Box<dyn Conn>> {
        let c = self.inner.connect(to)?;
        Ok(self.wrap(c))
    }
    fn refresh_listener(&mut self) -> io::Result<u16> {
        self.inner.refresh_listener()
    }
}

struct ChokeConn {
    inner: Option<Box<dyn Conn>>,
    mode: Mode,
    rng: u32,
    calls: u64,
    pool: Option<Rc<RefCell<Pool>>>,
    /// Bytes in the shared buffer, not yet on the wire (Buffered).
    pending: Vec<u8>,
    shut: bool,
    shut_done: bool,
}

fn blocked() -> io::Error {
    io::Error::from(io::ErrorKind::WouldBlock)
}

impl ChokeConn {
    fn roll(&mut self) -> u32 {
        // xorshift32
        let mut x = self.rng;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.rng = x;
        x
    }
    fn conn(&mut self) -> &mut Box<dyn Conn> {
        self.inner.as_mut().expect("live connection")
    }
    /// Buffered: put what the wire time allows from this buffer on the wire.
    fn pump(&mut self) {
        let Some(pool) = self.pool.clone() else { return };
        let mut p = pool.borrow_mut();
        p.tick();
        let k = self.pending.len().min(p.allowance as usize);
        if k > 0 {
            let inner = self.inner.as_mut().unwrap();
            if let Ok(n) = inner.write(&self.pending[..k]) {
                self.pending.drain(..n);
                p.allowance -= n as f64;
                p.used -= n;
            }
        }
        if self.shut && !self.shut_done && self.pending.is_empty() {
            self.shut_done = true;
            let _ = self.inner.as_mut().unwrap().shutdown_write();
        }
    }
}

impl Drop for ChokeConn {
    fn drop(&mut self) {
        let Some(pool) = self.pool.clone() else { return };
        if self.pending.is_empty() {
            return;
        }
        // closed with bytes in the buffer: they still go out, but the room
        // they held is lost for good
        let mut p = pool.borrow_mut();
        p.used -= self.pending.len();
        p.leaked += self.pending.len();
        let c = self.inner.take().unwrap();
        p.orphans.push((c, std::mem::take(&mut self.pending)));
    }
}

impl Conn for ChokeConn {
    fn poll_connected(&mut self) -> io::Result<bool> {
        self.conn().poll_connected()
    }
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.pump();
        if buf.is_empty() {
            return self.conn().read(buf);
        }
        match self.mode {
            Mode::Short(max) => {
                let n = 1 + (self.roll() as usize % max.max(1)).min(buf.len() - 1);
                self.conn().read(&mut buf[..n])
            }
            Mode::Flaky => {
                if self.roll() % 2 == 0 {
                    return Err(blocked());
                }
                let n = 1 + (self.roll() as usize % buf.len());
                self.conn().read(&mut buf[..n])
            }
            _ => self.conn().read(buf),
        }
    }
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.calls += 1;
        match self.mode {
            Mode::Off => self.conn().write(buf),
            Mode::AllOrNothing(cap) => {
                if buf.len() > cap || self.calls % 2 == 0 {
                    return Err(blocked());
                }
                self.conn().write(buf)
            }
            Mode::Short(max) => {
                let n = 1 + (self.roll() as usize % max.max(1)).min(buf.len().saturating_sub(1));
                let n = n.min(buf.len());
                self.conn().write(&buf[..n])
            }
            Mode::Flaky => {
                if self.roll() % 2 == 0 {
                    return Err(blocked());
                }
                let n = 1 + (self.roll() as usize % buf.len().max(1));
                let n = n.min(buf.len());
                self.conn().write(&buf[..n])
            }
            Mode::Buffered { .. } => {
                self.pump();
                let pool = self.pool.clone().unwrap();
                let room = pool.borrow().room();
                if room == 0 {
                    return Err(blocked());
                }
                let k = room.min(buf.len());
                self.pending.extend_from_slice(&buf[..k]);
                pool.borrow_mut().used += k;
                self.pump();
                Ok(k)
            }
        }
    }
    fn shutdown_write(&mut self) -> io::Result<()> {
        if self.pool.is_some() {
            // the shutdown goes out after the buffered bytes
            self.shut = true;
            self.pump();
            return Ok(());
        }
        self.conn().shutdown_write()
    }
}
