//! Test aid: a [`Net`] whose TCP connections behave like a small, stingy
//! socket -- the way a real 3DS's SOC can, and a desktop stack never does --
//! so the transfer code is tested against it on the host (tests/, and
//! pvsync-peer's `--choke`). UDP passes straight through.

use crate::session::{Conn, Net};
use std::io;
use std::net::SocketAddrV4;

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
}

impl Mode {
    /// `off`, `allornothing:<n>`, `short:<n>`, `flaky`.
    pub fn parse(s: &str) -> Option<Mode> {
        let (k, v) = s.split_once(':').unwrap_or((s, ""));
        match k {
            "off" => Some(Mode::Off),
            "allornothing" => v.parse().ok().map(Mode::AllOrNothing),
            "short" => v.parse().ok().map(Mode::Short),
            "flaky" => Some(Mode::Flaky),
            _ => None,
        }
    }
}

pub struct ChokeNet<N: Net> {
    pub inner: N,
    pub mode: Mode,
    seed: u32,
}

impl<N: Net> ChokeNet<N> {
    pub fn new(inner: N, mode: Mode) -> Self {
        ChokeNet { inner, mode, seed: 0x1234_5678 }
    }
    fn wrap(&mut self, c: Box<dyn Conn>) -> Box<dyn Conn> {
        if self.mode == Mode::Off {
            return c;
        }
        self.seed = self.seed.wrapping_mul(1_103_515_245).wrapping_add(12345);
        Box::new(ChokeConn { inner: c, mode: self.mode, rng: self.seed | 1, calls: 0 })
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
        Ok(match self.inner.accept()? {
            Some(c) => Some(self.wrap(c)),
            None => None,
        })
    }
    fn connect(&mut self, to: SocketAddrV4) -> io::Result<Box<dyn Conn>> {
        let c = self.inner.connect(to)?;
        Ok(self.wrap(c))
    }
}

struct ChokeConn {
    inner: Box<dyn Conn>,
    mode: Mode,
    rng: u32,
    calls: u64,
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
}

impl Conn for ChokeConn {
    fn poll_connected(&mut self) -> io::Result<bool> {
        self.inner.poll_connected()
    }
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return self.inner.read(buf);
        }
        match self.mode {
            Mode::Short(max) => {
                let n = 1 + (self.roll() as usize % max.max(1)).min(buf.len() - 1);
                self.inner.read(&mut buf[..n])
            }
            Mode::Flaky => {
                if self.roll() % 2 == 0 {
                    return Err(blocked());
                }
                let n = 1 + (self.roll() as usize % buf.len());
                self.inner.read(&mut buf[..n])
            }
            _ => self.inner.read(buf),
        }
    }
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.calls += 1;
        match self.mode {
            Mode::Off => self.inner.write(buf),
            Mode::AllOrNothing(cap) => {
                if buf.len() > cap || self.calls % 2 == 0 {
                    return Err(blocked());
                }
                self.inner.write(buf)
            }
            Mode::Short(max) => {
                let n = 1 + (self.roll() as usize % max.max(1)).min(buf.len().saturating_sub(1));
                self.inner.write(&buf[..n.min(buf.len())])
            }
            Mode::Flaky => {
                if self.roll() % 2 == 0 {
                    return Err(blocked());
                }
                let n = 1 + (self.roll() as usize % buf.len().max(1));
                self.inner.write(&buf[..n.min(buf.len())])
            }
        }
    }
}
