//! [`Net`] over std::net: the 3DS (horizon's std, once SOC is up) and a
//! desktop alike. Everything is non-blocking.
//!
//! The sockets are made with libc and handed to std, because two things std
//! does on its own fail on a real 3DS's SOC (Citra's stand-in lets both
//! through, which is how they got past it):
//! - `set_broadcast` sends SO_BROADCAST with the BSD value 0x20; SOC has no
//!   such option (libctru defines SO_BROADCAST as 0, "unrequired": a 3DS
//!   sends broadcast without asking), so the console refuses the call and
//!   std gives up. Here it is still asked for (Citra needs it) and a refusal
//!   is only noted;
//! - `set_nonblocking` is an FIONBIO ioctl, where fcntl(O_NONBLOCK) is the
//!   form libctru's own examples use.
//! Each step's result is written down ([`Bound::notes`]) for the log.
//! The same goes for the one call std has no non-blocking form of, a TCP
//! connect.

use crate::session::{Conn, Net};
use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpListener, TcpStream, UdpSocket};
use std::os::fd::FromRawFd;

pub struct StdNet {
    udp: UdpSocket,
    tcp: TcpListener,
    /// The ports bound (from the bind itself; getsockname only for port 0).
    udp_port: u16,
    tcp_port: u16,
    /// SO_SNDBUF for accepted connections (tests: a stingy send buffer).
    sndbuf: Option<i32>,
}

/// The port a socket is on: the one asked for, or getsockname's for 0.
fn port_of(asked: u16, local: io::Result<SocketAddr>) -> u16 {
    if asked != 0 {
        return asked;
    }
    local.map(|a| a.port()).unwrap_or(0)
}

/// How [`StdNet::bind_lenient`] went.
pub struct Bound {
    pub net: StdNet,
    /// Every step that did not simply work, and the ports taken, for the log.
    pub notes: Vec<String>,
    /// The UDP port asked for was not to be had; a free one was taken.
    pub udp_fell_back: bool,
    /// Likewise TCP (the port is in HELLO, so any port does).
    pub tcp_fell_back: bool,
    /// The raw errno the asked-for UDP port's bind failed with.
    pub udp_errno: Option<i32>,
}

/// A failed [`StdNet::bind_lenient`]: what to log, and a few words for the
/// screen with the raw errno (`UDP BIND E112`).
#[derive(Clone, Debug)]
pub struct BindError {
    pub log: String,
    pub short: String,
}

fn short_err(what: &str, e: &io::Error) -> String {
    match e.raw_os_error() {
        Some(n) => format!("{} BIND E{}", what, n),
        None => format!("{} BIND FAILED", what),
    }
}

/// TCP ports tried after the one asked for, before any free one.
pub const TCP_TRIES: u16 = 8;

/// An io::Error as text with its raw errno, for the log.
pub fn describe(e: &io::Error) -> String {
    match e.raw_os_error() {
        Some(n) => format!("{} (errno {})", e, n),
        None => e.to_string(),
    }
}

fn errno() -> io::Error {
    io::Error::last_os_error()
}

fn sockaddr(a: SocketAddrV4) -> libc::sockaddr_in {
    let mut sa: libc::sockaddr_in = unsafe { core::mem::zeroed() };
    sa.sin_family = libc::AF_INET as libc::sa_family_t;
    sa.sin_port = a.port().to_be();
    sa.sin_addr = libc::in_addr { s_addr: u32::from_ne_bytes(a.ip().octets()) };
    sa
}

/// fcntl(O_NONBLOCK) on a raw socket.
fn nonblocking_fd(fd: libc::c_int) -> io::Result<()> {
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL, 0);
        if flags < 0 || libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) < 0 {
            return Err(errno());
        }
    }
    Ok(())
}

fn set_int(fd: libc::c_int, level: libc::c_int, opt: libc::c_int, v: libc::c_int) -> io::Result<()> {
    let r = unsafe { libc::setsockopt(fd, level, opt, &v as *const libc::c_int as *const libc::c_void, core::mem::size_of::<libc::c_int>() as libc::socklen_t) };
    if r < 0 { Err(errno()) } else { Ok(()) }
}

/// A socket of `ty` bound to `at`, non-blocking; listening when TCP. Steps
/// that may fail without harm (reuse, broadcast) are noted, not fatal.
fn bound_fd(ty: libc::c_int, at: SocketAddrV4, notes: &mut Vec<String>) -> io::Result<libc::c_int> {
    let what = if ty == libc::SOCK_DGRAM { "udp" } else { "tcp" };
    let fd = unsafe { libc::socket(libc::AF_INET, ty, 0) };
    if fd < 0 {
        return Err(errno());
    }
    let fail = |fd: libc::c_int, e: io::Error| -> io::Error {
        unsafe { libc::close(fd) };
        e
    };
    // SO_REUSEADDR: a port the last visit held is taken again at once. Not
    // on a desktop's UDP socket, where it would let two peers share one
    // port (both hear a broadcast; unicast reaches only one).
    if ty == libc::SOCK_STREAM || cfg!(target_os = "horizon") {
        if let Err(e) = set_int(fd, libc::SOL_SOCKET, libc::SO_REUSEADDR, 1) {
            notes.push(format!("{} SO_REUSEADDR: {}", what, describe(&e)));
        }
    }
    let sa = sockaddr(at);
    let r = unsafe { libc::bind(fd, &sa as *const libc::sockaddr_in as *const libc::sockaddr, core::mem::size_of::<libc::sockaddr_in>() as libc::socklen_t) };
    if r < 0 {
        return Err(fail(fd, errno()));
    }
    if ty == libc::SOCK_STREAM {
        // the 3DS takes a small backlog only (std uses 20 there)
        if unsafe { libc::listen(fd, 4) } < 0 {
            return Err(fail(fd, errno()));
        }
    } else if let Err(e) = set_int(fd, libc::SOL_SOCKET, libc::SO_BROADCAST, 1) {
        // Asked for, never required: a real 3DS has no such option and
        // broadcasts without it (module notes), while Citra's stand-in for
        // SOC passes it on to the PC, which will not broadcast without it.
        notes.push(format!("udp SO_BROADCAST (not needed on a console): {}", describe(&e)));
    }
    if let Err(e) = nonblocking_fd(fd) {
        return Err(fail(fd, e));
    }
    Ok(fd)
}

fn udp_at(at: SocketAddrV4, notes: &mut Vec<String>) -> io::Result<UdpSocket> {
    bound_fd(libc::SOCK_DGRAM, at, notes).map(|fd| unsafe { UdpSocket::from_raw_fd(fd) })
}

fn tcp_at(at: SocketAddrV4, notes: &mut Vec<String>) -> io::Result<TcpListener> {
    bound_fd(libc::SOCK_STREAM, at, notes).map(|fd| unsafe { TcpListener::from_raw_fd(fd) })
}

impl StdNet {
    /// UDP and TCP bound on `ip` (0.0.0.0 for every interface) at exactly
    /// these ports (0 picks a free one).
    pub fn bind(ip: Ipv4Addr, udp_port: u16, tcp_port: u16) -> io::Result<StdNet> {
        let mut notes = Vec::new();
        let udp = udp_at(SocketAddrV4::new(ip, udp_port), &mut notes)?;
        let tcp = tcp_at(SocketAddrV4::new(ip, tcp_port), &mut notes)?;
        Ok(StdNet::new(udp, udp_port, tcp, tcp_port))
    }

    fn new(udp: UdpSocket, udp_asked: u16, tcp: TcpListener, tcp_asked: u16) -> StdNet {
        let udp_port = port_of(udp_asked, udp.local_addr());
        let tcp_port = port_of(tcp_asked, tcp.local_addr());
        StdNet { udp, tcp, udp_port, tcp_port, sndbuf: None }
    }

    /// As [`bind`](Self::bind), but a port that cannot be had is not the
    /// end: UDP falls back to a free port (HELLO still goes to the standard
    /// port from it, and peers answer by unicast to whatever port it came
    /// from), TCP to the next few ports and then a free one (HELLO says
    /// which). Err only when no socket can be made at all.
    pub fn bind_lenient(ip: Ipv4Addr, udp_port: u16, tcp_port: u16) -> Result<Bound, BindError> {
        let mut notes = Vec::new();
        let mut udp_errno = None;
        let (udp, udp_fell_back) = match udp_at(SocketAddrV4::new(ip, udp_port), &mut notes) {
            Ok(s) => ((s, udp_port), false),
            Err(e) => {
                notes.push(format!("udp bind {}:{}: {}", ip, udp_port, describe(&e)));
                udp_errno = e.raw_os_error();
                match udp_at(SocketAddrV4::new(ip, 0), &mut notes) {
                    Ok(s) => ((s, 0), true),
                    Err(e2) => {
                        return Err(BindError {
                            log: format!("udp bind {}:{}: {}; any port: {}", ip, udp_port, describe(&e), describe(&e2)),
                            short: short_err("UDP", &e),
                        })
                    }
                }
            }
        };
        let mut tcp = None;
        let mut first_err = String::new();
        let mut first_short = String::new();
        for k in 0..=TCP_TRIES {
            let port = if k == TCP_TRIES { 0 } else { tcp_port.wrapping_add(k) };
            if port == 0 && k != TCP_TRIES {
                continue;
            }
            match tcp_at(SocketAddrV4::new(ip, port), &mut notes) {
                Ok(s) => {
                    tcp = Some(((s, port), k != 0));
                    break;
                }
                Err(e) => {
                    if first_err.is_empty() {
                        first_err = describe(&e);
                        first_short = short_err("TCP", &e);
                        notes.push(format!("tcp bind {}:{}: {}", ip, port, first_err));
                    }
                }
            }
        }
        let Some((tcp, tcp_fell_back)) = tcp else {
            return Err(BindError { log: format!("tcp bind {}:{}..: {}", ip, tcp_port, first_err), short: first_short });
        };
        let net = StdNet::new(udp.0, udp.1, tcp.0, tcp.1);
        notes.push(format!("bound udp {} tcp {}", net.udp_port(), net.tcp_port()));
        Ok(Bound { net, notes, udp_fell_back, tcp_fell_back, udp_errno })
    }
    /// Give every connection accepted from now on this SO_SNDBUF (tests).
    pub fn set_send_buffer(&mut self, bytes: Option<i32>) {
        self.sndbuf = bytes;
    }
    pub fn udp_port(&self) -> u16 {
        self.udp_port
    }
    pub fn tcp_port(&self) -> u16 {
        self.tcp_port
    }
}
/// The broadcast address of `ip`'s /24 (the 3DS has no netmask call; a home
/// network is a /24 nearly always, and the limited broadcast goes too).
pub fn subnet_broadcast(ip: Ipv4Addr) -> Option<Ipv4Addr> {
    if ip.is_unspecified() || ip.is_loopback() {
        return None;
    }
    let o = ip.octets();
    Some(Ipv4Addr::new(o[0], o[1], o[2], 255))
}

fn v4(a: SocketAddr) -> Option<SocketAddrV4> {
    match a {
        SocketAddr::V4(a) => Some(a),
        SocketAddr::V6(a) => a.ip().to_ipv4_mapped().map(|ip| SocketAddrV4::new(ip, a.port())),
    }
}

impl Net for StdNet {
    fn send_to(&mut self, data: &[u8], to: SocketAddrV4) -> io::Result<()> {
        self.udp.send_to(data, to).map(|_| ())
    }
    fn recv_from(&mut self, buf: &mut [u8]) -> io::Result<Option<(usize, SocketAddrV4)>> {
        loop {
            match self.udp.recv_from(buf) {
                Ok((n, from)) => match v4(from) {
                    Some(f) => return Ok(Some((n, f))),
                    None => continue,
                },
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => return Ok(None),
                // a refused send can surface here as an error on the next
                // receive (ICMP port unreachable): not ours to stop on
                Err(e) if matches!(e.kind(), io::ErrorKind::ConnectionRefused | io::ErrorKind::ConnectionReset | io::ErrorKind::Interrupted) => continue,
                Err(e) => return Err(e),
            }
        }
    }
    fn accept(&mut self) -> io::Result<Option<Box<dyn Conn>>> {
        match self.tcp.accept() {
            Ok((s, _)) => {
                use std::os::fd::AsRawFd;
                if nonblocking_fd(s.as_raw_fd()).is_err() {
                    s.set_nonblocking(true)?;
                }
                if let Some(n) = self.sndbuf {
                    set_int(s.as_raw_fd(), libc::SOL_SOCKET, libc::SO_SNDBUF, n)?;
                }
                let _ = s.set_nodelay(true);
                Ok(Some(Box::new(StdConn { s, connected: true })))
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => Ok(None),
            Err(e) => Err(e),
        }
    }
    fn connect(&mut self, to: SocketAddrV4) -> io::Result<Box<dyn Conn>> {
        let s = connect_nonblocking(to)?;
        Ok(Box::new(StdConn { s, connected: false }))
    }
}

pub struct StdConn {
    s: TcpStream,
    connected: bool,
}

impl Conn for StdConn {
    fn poll_connected(&mut self) -> io::Result<bool> {
        if self.connected {
            return Ok(true);
        }
        // a failed connect leaves its reason in SO_ERROR
        if let Some(e) = self.s.take_error()? {
            return Err(e);
        }
        match self.s.peer_addr() {
            Ok(_) => {
                self.connected = true;
                Ok(true)
            }
            Err(e) if e.kind() == io::ErrorKind::NotConnected => Ok(false),
            Err(e) => Err(e),
        }
    }
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.s.read(buf)
    }
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.s.write(buf)
    }
}

/// socket + O_NONBLOCK + connect, returning with the connect in flight.
fn connect_nonblocking(to: SocketAddrV4) -> io::Result<TcpStream> {
    unsafe {
        let fd = libc::socket(libc::AF_INET, libc::SOCK_STREAM, 0);
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        let flags = libc::fcntl(fd, libc::F_GETFL, 0);
        if flags < 0 || libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) < 0 {
            let e = io::Error::last_os_error();
            libc::close(fd);
            return Err(e);
        }
        let mut sa: libc::sockaddr_in = core::mem::zeroed();
        sa.sin_family = libc::AF_INET as libc::sa_family_t;
        sa.sin_port = to.port().to_be();
        sa.sin_addr = libc::in_addr { s_addr: u32::from_ne_bytes(to.ip().octets()) };
        let r = libc::connect(fd, &sa as *const libc::sockaddr_in as *const libc::sockaddr, core::mem::size_of::<libc::sockaddr_in>() as libc::socklen_t);
        if r < 0 {
            let e = io::Error::last_os_error();
            let raw = e.raw_os_error();
            if raw != Some(libc::EINPROGRESS) && raw != Some(libc::EWOULDBLOCK) && raw != Some(libc::EALREADY) {
                libc::close(fd);
                return Err(e);
            }
        }
        let s = TcpStream::from_raw_fd(fd);
        let _ = s.set_nodelay(true);
        Ok(s)
    }
}
