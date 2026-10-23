//! [`Net`] over std::net: the 3DS (horizon's std, once SOC is up) and a
//! desktop alike. Everything is non-blocking; the one call std has no
//! non-blocking form of -- a TCP connect -- is made with libc and handed to
//! std as a `TcpStream`.

use crate::session::{Conn, Net};
use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpListener, TcpStream, UdpSocket};

pub struct StdNet {
    udp: UdpSocket,
    tcp: TcpListener,
}

impl StdNet {
    /// UDP and TCP bound on `ip` (0.0.0.0 for every interface), with
    /// broadcast on. Port 0 picks a free one (tests).
    pub fn bind(ip: Ipv4Addr, udp_port: u16, tcp_port: u16) -> io::Result<StdNet> {
        let udp = UdpSocket::bind(SocketAddrV4::new(ip, udp_port))?;
        udp.set_broadcast(true)?;
        udp.set_nonblocking(true)?;
        let tcp = TcpListener::bind(SocketAddrV4::new(ip, tcp_port))?;
        tcp.set_nonblocking(true)?;
        Ok(StdNet { udp, tcp })
    }
    pub fn udp_port(&self) -> u16 {
        self.udp.local_addr().map(|a| a.port()).unwrap_or(0)
    }
    pub fn tcp_port(&self) -> u16 {
        self.tcp.local_addr().map(|a| a.port()).unwrap_or(0)
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
                s.set_nonblocking(true)?;
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
    use std::os::fd::FromRawFd;
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
