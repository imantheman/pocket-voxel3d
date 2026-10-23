//! Two sessions over real sockets on 127.0.0.1, HELLO targets pointed at
//! each other (no broadcast needed), plus hand-rolled peers for the error
//! cases.

use pocketvoxel_sync::choke::{ChokeNet, Mode};
use pocketvoxel_sync::net::StdNet;
use pocketvoxel_sync::proto;
use pocketvoxel_sync::session::{Config, Event, PullPhase, Session};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream, UdpSocket};
use std::time::Duration;

const LO: Ipv4Addr = Ipv4Addr::LOCALHOST;

fn session(id: &str, game: &str, name: &str) -> Session<StdNet> {
    let net = StdNet::bind(LO, 0, 0).unwrap();
    let cfg = Config { id: id.into(), platform: "3ds".into(), game: game.into(), name: name.into(), tcp_port: net.tcp_port(), targets: vec![] };
    Session::new(net, cfg)
}

fn udp_addr(s: &Session<StdNet>) -> SocketAddrV4 {
    SocketAddrV4::new(LO, s.net().udp_port())
}

/// A pair whose HELLOs reach each other. `b_broadcasts`: false gives B no
/// HELLO targets at all, as a peer whose broadcasts never arrive -- B is
/// then found only through its unicast echo to A.
fn pair(game_a: &str, game_b: &str, b_broadcasts: bool) -> (Session<StdNet>, Session<StdNet>) {
    let na = StdNet::bind(LO, 0, 0).unwrap();
    let nb = StdNet::bind(LO, 0, 0).unwrap();
    let ua = SocketAddrV4::new(LO, na.udp_port());
    let ub = SocketAddrV4::new(LO, nb.udp_port());
    let (ta, tb) = (na.tcp_port(), nb.tcp_port());
    let a = Session::new(na, Config { id: "aaaa0001".into(), platform: "3ds".into(), game: game_a.into(), name: "Alpha".into(), tcp_port: ta, targets: vec![ub] });
    let b = Session::new(nb, Config { id: "bbbb0002".into(), platform: "pc".into(), game: game_b.into(), name: "Bravo".into(), tcp_port: tb, targets: if b_broadcasts { vec![ua] } else { vec![] } });
    (a, b)
}

struct Clock(f64);
impl Clock {
    fn step(&mut self) -> f64 {
        self.0 += 1.0 / 60.0;
        std::thread::sleep(Duration::from_millis(2));
        self.0
    }
}

fn run_until<F: FnMut(&mut Session<StdNet>, &mut Session<StdNet>) -> bool>(a: &mut Session<StdNet>, b: &mut Session<StdNet>, clock: &mut Clock, secs: f64, mut done: F) -> bool {
    let end = clock.0 + secs;
    while clock.0 < end {
        let t = clock.step();
        a.tick(t);
        b.tick(t);
        if done(a, b) {
            return true;
        }
    }
    false
}

fn big_save(n: usize) -> Vec<u8> {
    // a 300 KB "save" with every byte value somewhere in it
    let mut v = b"return {\n  version = \"red\",\n  blob = \"".to_vec();
    let mut x: u32 = 12345;
    while v.len() < n - 4 {
        x = x.wrapping_mul(1103515245).wrapping_add(12345);
        v.push((x >> 16) as u8);
    }
    v.extend_from_slice(b"\",}\n");
    v
}

#[test]
fn discovery_both_ways_and_a_300k_pull() {
    let (mut a, mut b) = pair("red", "red", true);
    let save = big_save(300 * 1024);
    a.set_body(Some(save.clone()));
    let mut c = Clock(0.0);
    assert!(run_until(&mut a, &mut b, &mut c, 3.0, |a, b| !a.peers().is_empty() && !b.peers().is_empty()), "peers not found");
    let pa = &b.peers()[0];
    assert_eq!(pa.id, "aaaa0001");
    assert_eq!(pa.name, "ALPHA");
    assert_eq!(pa.platform, "3ds");
    assert_eq!(pa.size, save.len());
    assert_eq!(pa.crc, proto::crc32(&save));
    assert_eq!(a.peers()[0].size, 0, "B has no save: 0 00000000");
    assert_eq!(a.peers()[0].crc, 0);
    b.pull("aaaa0001").unwrap();
    assert_eq!(b.pull("aaaa0001"), Err("busy".into()));
    let mut got = None;
    let mut saw_body = false;
    assert!(run_until(&mut a, &mut b, &mut c, 10.0, |_, b| {
        if let Some((_, PullPhase::Body { .. })) = b.pulling() {
            saw_body = true;
        }
        got = b.poll_event();
        got.is_some()
    }));
    match got.unwrap() {
        Event::Pulled { id, name, body } => {
            assert_eq!(id, "aaaa0001");
            assert_eq!(name, "ALPHA");
            assert_eq!(body.len(), 300 * 1024);
            assert_eq!(proto::crc32(&body), proto::crc32(&save));
            assert!(body == save);
        }
        e => panic!("{:?}", e),
    }
    assert!(saw_body, "the body should take more than one frame (64 KB a frame)");
}

#[test]
fn one_way_broadcast_still_finds_both() {
    let (mut a, mut b) = pair("gold", "gold", false);
    let sb = b"return { version = \"gold\", player = { name = \"B\" } }".to_vec();
    a.set_body(Some(b"return { version = \"gold\" }".to_vec()));
    b.set_body(Some(sb.clone()));
    let mut c = Clock(0.0);
    // A's HELLOs reach B; B's reach A only once B has heard A
    assert!(run_until(&mut a, &mut b, &mut c, 3.5, |a, b| !a.peers().is_empty() && !b.peers().is_empty()), "the echo did not find B");
    // and a pull works from the side that only heard the echo
    a.pull("bbbb0002").unwrap();
    let mut got = None;
    assert!(run_until(&mut a, &mut b, &mut c, 10.0, |a, _| {
        got = a.poll_event();
        got.is_some()
    }));
    assert!(matches!(got, Some(Event::Pulled { ref body, .. }) if *body == sb), "{:?}", got);
}

#[test]
fn offer_then_accept() {
    let (mut a, mut b) = pair("crystal", "crystal", true);
    a.set_body(Some(b"return { version = \"crystal\" }".to_vec()));
    let mut c = Clock(0.0);
    assert!(run_until(&mut a, &mut b, &mut c, 3.0, |a, b| !a.peers().is_empty() && !b.peers().is_empty()));
    a.offer("bbbb0002").unwrap();
    let mut ev = None;
    assert!(run_until(&mut a, &mut b, &mut c, 2.0, |_, b| {
        ev = b.poll_event();
        ev.is_some()
    }));
    assert_eq!(ev, Some(Event::Offer { id: "aaaa0001".into(), name: "ALPHA".into() }));
    assert!(b.peer("aaaa0001").unwrap().offered);
    // a second OFFER is not a second event
    a.offer("bbbb0002").unwrap();
    run_until(&mut a, &mut b, &mut c, 0.3, |_, _| false);
    assert_eq!(b.poll_event(), None);
    // accepting is a plain pull; the offer clears when it lands
    b.pull("aaaa0001").unwrap();
    let mut got = None;
    assert!(run_until(&mut a, &mut b, &mut c, 10.0, |_, b| {
        got = b.poll_event();
        got.is_some()
    }));
    assert!(matches!(got, Some(Event::Pulled { .. })), "{:?}", got);
    assert!(!b.peer("aaaa0001").unwrap().offered);
}

#[test]
fn different_games_see_each_other_but_do_not_pull() {
    let (mut a, mut b) = pair("red", "blue", true);
    a.set_body(Some(b"return {}".to_vec()));
    let mut c = Clock(0.0);
    assert!(run_until(&mut a, &mut b, &mut c, 3.0, |a, b| !a.peers().is_empty() && !b.peers().is_empty()));
    assert_eq!(b.peers()[0].game, "red");
    assert_eq!(b.pull("aaaa0001"), Err("different game".into()));
}

#[test]
fn own_hellos_are_ignored_and_peers_forgotten_after_four_seconds() {
    let (mut a, mut b) = pair("red", "red", true);
    let mut c = Clock(0.0);
    assert!(run_until(&mut a, &mut b, &mut c, 3.0, |_, b| !b.peers().is_empty()));
    // our own HELLO coming back (a broadcast loops back) is not a peer
    let mine = format!("PVS1 HELLO bbbb0002 1 pc red 0 00000000 ME\n");
    UdpSocket::bind(SocketAddrV4::new(LO, 0)).unwrap().send_to(mine.as_bytes(), udp_addr(&b)).unwrap();
    run_until(&mut a, &mut b, &mut c, 0.2, |_, _| false);
    assert_eq!(b.peers().len(), 1);
    // A goes quiet
    let t = c.0 + 4.5;
    b.tick(t);
    assert!(b.peers().is_empty());
}

fn raw_request(port: u16, line: &str) -> String {
    let mut s = TcpStream::connect(SocketAddrV4::new(LO, port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    s.write_all(line.as_bytes()).unwrap();
    let mut out = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        match s.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => out.extend_from_slice(&buf[..n]),
            Err(_) => break,
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Serve requests from another thread while this one ticks.
fn serve_raw(mut s: Session<StdNet>, reqs: Vec<&'static str>) -> Vec<String> {
    let port = s.net().tcp_port();
    let h = std::thread::spawn(move || reqs.into_iter().map(|r| raw_request(port, r)).collect::<Vec<_>>());
    let mut t = 0.0;
    while !h.is_finished() {
        t += 0.016;
        s.tick(t);
        std::thread::sleep(Duration::from_millis(2));
    }
    h.join().unwrap()
}

#[test]
fn the_server_answers_errors_and_exact_bytes() {
    let s = session("cccc0003", "silver", "S");
    assert_eq!(serve_raw(s, vec!["PVS1 GET silver\n"]), vec!["PVS1 ERR no save\n"]);
    let mut s = session("cccc0003", "silver", "S");
    let body = b"return {\r\n version = \"silver\" }  ".to_vec();
    s.set_body(Some(body.clone()));
    let r = serve_raw(s, vec!["PVS1 GET silver\r\n", "PVS1 GET gold\n", "GET silver\n", "PVS1 HELLO x\n"]);
    let want = format!("PVS1 OK silver {} {}\n{}", body.len(), proto::crc_hex(proto::crc32(&body)), String::from_utf8_lossy(&body));
    assert_eq!(r[0], want);
    assert_eq!(r[1], "PVS1 ERR wrong game\n");
    assert_eq!(r[2], "PVS1 ERR bad request\n");
    assert_eq!(r[3], "PVS1 ERR bad request\n");
}

/// A fake peer: one HELLO into a session, then a TCP server that answers
/// the GET with `reply` and hangs up. The session pulls; its outcome.
fn fake_peer_pull(game: &str, reply: Vec<u8>) -> Event {
    let mut s = session("dddd0004", game, "D");
    let lis = TcpListener::bind(SocketAddrV4::new(LO, 0)).unwrap();
    let tport = lis.local_addr().unwrap().port();
    let u = UdpSocket::bind(SocketAddrV4::new(LO, 0)).unwrap();
    let hello = format!("PVS1 HELLO eeee0005 {} pc {} 10 00000000 FAKE\n", tport, game);
    u.send_to(hello.as_bytes(), udp_addr(&s)).unwrap();
    let mut t = 0.0;
    while s.peers().is_empty() {
        t += 0.016;
        s.tick(t);
        std::thread::sleep(Duration::from_millis(2));
        assert!(t < 3.0);
    }
    let h = std::thread::spawn(move || {
        let (mut c, _) = lis.accept().unwrap();
        let mut req = [0u8; 64];
        let _ = c.read(&mut req);
        let _ = c.write_all(&reply);
    });
    s.pull("eeee0005").unwrap();
    loop {
        t += 0.016;
        s.tick(t);
        if let Some(e) = s.poll_event() {
            h.join().unwrap();
            return e;
        }
        std::thread::sleep(Duration::from_millis(2));
        assert!(t < 15.0, "no outcome");
    }
}

fn reason(e: Event) -> String {
    match e {
        Event::PullFailed { reason, .. } => reason,
        e => panic!("expected a failure, got {:?}", e),
    }
}

#[test]
fn pull_failures() {
    // the sender goes away part-way
    assert_eq!(reason(fake_peer_pull("red", b"PVS1 OK red 1000 00000000\nonly ten..".to_vec())), "connection dropped");
    // bytes that do not match the CRC
    assert_eq!(reason(fake_peer_pull("red", b"PVS1 OK red 5 00000000\nhello".to_vec())), "checksum mismatch");
    // the right bytes do arrive
    let ok = format!("PVS1 OK red 5 {}\nhello", proto::crc_hex(proto::crc32(b"hello")));
    assert!(matches!(fake_peer_pull("red", ok.into_bytes()), Event::Pulled { ref body, .. } if body == b"hello"));
    // OK for another game, an oversize save, an ERR, junk
    assert_eq!(reason(fake_peer_pull("red", b"PVS1 OK blue 5 00000000\nhello".to_vec())), "wrong game");
    assert_eq!(reason(fake_peer_pull("red", format!("PVS1 OK red {} 00000000\n", proto::MAX_SAVE + 1).into_bytes())), "save too big");
    assert_eq!(reason(fake_peer_pull("red", b"PVS1 ERR no save\n".to_vec())), "no save");
    assert_eq!(reason(fake_peer_pull("red", b"HTTP/1.1 200 OK\r\n\r\n".to_vec())), "bad reply");
}

#[test]
fn a_refused_connect_fails_fast() {
    let mut s = session("ffff0006", "red", "F");
    // a port nobody listens on
    let dead = TcpListener::bind(SocketAddrV4::new(LO, 0)).unwrap();
    let port = dead.local_addr().unwrap().port();
    drop(dead);
    let u = UdpSocket::bind(SocketAddrV4::new(LO, 0)).unwrap();
    u.send_to(format!("PVS1 HELLO 0f0f0f0f {} pc red 1 00000000 GONE\n", port).as_bytes(), udp_addr(&s)).unwrap();
    let mut t = 0.0;
    while s.peers().is_empty() {
        t += 0.016;
        s.tick(t);
        std::thread::sleep(Duration::from_millis(2));
    }
    s.pull("0f0f0f0f").unwrap();
    let start = t;
    loop {
        t += 0.016;
        s.tick(t);
        if let Some(e) = s.poll_event() {
            assert_eq!(reason(e), "connection refused");
            assert!(t - start < 2.0);
            break;
        }
        std::thread::sleep(Duration::from_millis(2));
        assert!(t - start < 12.0);
    }
}

/// A server whose socket is stingy (choke.rs) serving a 300 KB save to a
/// plain client, and a stingy client pulling from a plain server: every
/// byte arrives, inside the 10 s, whatever the socket does.
fn stingy_pull(server_mode: Mode, client_mode: Mode, sndbuf: Option<i32>) -> (Vec<u8>, Vec<u8>, Vec<String>) {
    let mut na = StdNet::bind(LO, 0, 0).unwrap();
    na.set_send_buffer(sndbuf);
    let nb = StdNet::bind(LO, 0, 0).unwrap();
    let ua = SocketAddrV4::new(LO, na.udp_port());
    let ub = SocketAddrV4::new(LO, nb.udp_port());
    let (ta, tb) = (na.tcp_port(), nb.tcp_port());
    let mut a = Session::new(ChokeNet::new(na, server_mode), Config { id: "aaaa0001".into(), platform: "3ds".into(), game: "yellow".into(), name: "Server".into(), tcp_port: ta, targets: vec![ub] });
    let mut b = Session::new(ChokeNet::new(nb, client_mode), Config { id: "bbbb0002".into(), platform: "pc".into(), game: "yellow".into(), name: "Client".into(), tcp_port: tb, targets: vec![ua] });
    let save = big_save(300 * 1024);
    a.set_body(Some(save.clone()));
    let mut t = 0.0;
    while b.peers().is_empty() {
        t += 1.0 / 30.0;
        a.tick(t);
        b.tick(t);
        std::thread::sleep(Duration::from_millis(1));
        assert!(t < 3.0, "no discovery");
    }
    b.pull("aaaa0001").unwrap();
    let start = t;
    loop {
        // 30 frames a second, as the title screen runs
        t += 1.0 / 30.0;
        a.tick(t);
        b.tick(t);
        match b.poll_event() {
            Some(Event::Pulled { body, .. }) => {
                assert!(t - start < 10.0, "took {:.1} s", t - start);
                let mut notes = a.take_notes();
                for _ in 0..3 {
                    a.tick(t);
                    notes.extend(a.take_notes());
                }
                return (save, body, notes);
            }
            Some(Event::PullFailed { reason, .. }) => panic!("pull failed: {} ({:?})", reason, a.take_notes()),
            _ => {}
        }
        std::thread::sleep(Duration::from_millis(1));
        assert!(t - start < 12.0, "stalled: {:?}", a.take_notes());
    }
}

#[test]
fn a_server_whose_socket_refuses_big_writes_still_sends_it_all() {
    let (save, got, notes) = stingy_pull(Mode::AllOrNothing(2048), Mode::Off, None);
    assert!(got == save);
    let log = notes.join("\n");
    assert!(log.contains("sent all"), "{}", log);
    assert!(log.contains("refused writes"), "{}", log);
}

#[test]
fn short_writes_and_a_small_send_buffer() {
    let (save, got, _) = stingy_pull(Mode::Short(700), Mode::Off, Some(2048));
    assert!(got == save);
}

#[test]
fn a_flaky_server() {
    let (save, got, _) = stingy_pull(Mode::Flaky, Mode::Off, None);
    assert!(got == save);
}

#[test]
fn a_flaky_client() {
    let (save, got, _) = stingy_pull(Mode::Off, Mode::Flaky, None);
    assert!(got == save);
}

#[test]
fn short_both_ends() {
    // (no tiny SO_SNDBUF here: with 300-byte writes Linux spends most of a
    // 2 KB buffer on per-segment overhead, a desktop artefact)
    let (save, got, _) = stingy_pull(Mode::Short(300), Mode::Short(500), None);
    assert!(got == save);
}