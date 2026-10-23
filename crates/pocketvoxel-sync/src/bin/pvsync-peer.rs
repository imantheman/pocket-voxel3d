//! A PVS1 peer on a desktop, for testing against other implementations
//! (tools/pvsync/ drives it against the PC mod's transport).
//!
//!   pvsync-peer --game red [--name NAME] [--platform 3ds] [--udp PORT] [--tcp PORT]
//!               [--target IP:PORT]... [--serve FILE]
//!               [--pull | --accept] [--offer] [--out FILE]
//!               [--install SAVEPATH --backups DIR] [--seconds N]
//!
//! --pull     pull the first same-game peer heard, then exit
//! --accept   pull the first peer that OFFERs, then exit
//! --offer    OFFER our save to the first same-game peer heard (once)
//! Without --pull/--accept it serves until --seconds run out (exit 0).
//! Every event is printed as one line on stdout.

use pocketvoxel_sync::install::{self, Paths, StdStore};
use pocketvoxel_sync::net::StdNet;
use pocketvoxel_sync::proto;
use pocketvoxel_sync::session::{Config, Event, Session};
use std::io::Write;
use std::net::{Ipv4Addr, SocketAddrV4};
use std::time::{Duration, Instant};

fn main() {
    let mut game = String::from("red");
    let mut name = String::from("RUST PEER");
    let mut platform = String::from("3ds");
    let mut udp = proto::UDP_PORT;
    let mut tcp = proto::TCP_PORT;
    let mut targets: Vec<SocketAddrV4> = Vec::new();
    let mut serve: Option<String> = None;
    let mut out: Option<String> = None;
    let mut install_to: Option<String> = None;
    let mut backups: Option<String> = None;
    let (mut pull, mut accept, mut offer) = (false, false, false);
    let mut seconds = 20.0f64;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        let mut val = || args.next().unwrap_or_else(|| panic!("{} needs a value", a));
        match a.as_str() {
            "--game" => game = val(),
            "--name" => name = val(),
            "--platform" => platform = val(),
            "--udp" => udp = val().parse().expect("--udp"),
            "--tcp" => tcp = val().parse().expect("--tcp"),
            "--target" => targets.push(val().parse().expect("--target IP:PORT")),
            "--serve" => serve = Some(val()),
            "--out" => out = Some(val()),
            "--install" => install_to = Some(val()),
            "--backups" => backups = Some(val()),
            "--seconds" => seconds = val().parse().expect("--seconds"),
            "--pull" => pull = true,
            "--accept" => accept = true,
            "--offer" => offer = true,
            other => panic!("unknown argument {}", other),
        }
    }
    if targets.is_empty() {
        targets.push(SocketAddrV4::new(Ipv4Addr::BROADCAST, proto::UDP_PORT));
    }
    let net = StdNet::bind(Ipv4Addr::UNSPECIFIED, udp, tcp).unwrap_or_else(|e| {
        println!("ERROR bind: {}", e);
        std::process::exit(2)
    });
    let seed = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(1) ^ std::process::id() as u64;
    let cfg = Config { id: proto::make_id(seed), platform, game: game.clone(), name, tcp_port: net.tcp_port(), targets };
    let mut s = Session::new(net, cfg);
    if let Some(f) = &serve {
        s.set_body(Some(std::fs::read(f).expect("--serve file")));
    }
    println!("READY id={} udp={} tcp={}", s.id(), s.net().udp_port(), s.net().tcp_port());
    let t0 = Instant::now();
    let mut known: Vec<String> = Vec::new();
    let mut offered = false;
    loop {
        let now = t0.elapsed().as_secs_f64();
        if now > seconds {
            if pull || accept {
                println!("FAILED timeout");
                std::process::exit(1);
            }
            println!("DONE");
            return;
        }
        s.tick(now);
        let peers: Vec<_> = s.peers().to_vec();
        for p in &peers {
            if !known.contains(&p.id) {
                known.push(p.id.clone());
                println!("PEER {} {} {} {} {} {:08x} {}", p.id, p.platform, p.game, p.addr, p.size, p.crc, p.label());
            }
            if p.game == game {
                if offer && !offered {
                    offered = true;
                    match s.offer(&p.id) {
                        Ok(()) => println!("OFFERED {}", p.label()),
                        Err(e) => println!("ERROR offer {}", e),
                    }
                }
                if pull && s.pulling().is_none() {
                    pull = false; // once
                    match s.pull(&p.id) {
                        Ok(()) => println!("PULLING {}", p.label()),
                        Err(e) => {
                            println!("FAILED {} {}", p.label(), e);
                            std::process::exit(1)
                        }
                    }
                }
            }
        }
        while let Some(ev) = s.poll_event() {
            match ev {
                Event::Offer { id, name } => {
                    println!("OFFER {}", name);
                    if accept {
                        accept = false;
                        if let Err(e) = s.pull(&id) {
                            println!("FAILED {} {}", name, e);
                            std::process::exit(1);
                        }
                        println!("PULLING {}", name);
                    }
                }
                Event::Pulled { name, body, .. } => {
                    println!("PULLED {} {} {:08x}", name, body.len(), proto::crc32(&body));
                    if let Some(f) = &out {
                        std::fs::write(f, &body).expect("--out");
                    }
                    if let Some(save) = &install_to {
                        let paths = Paths { save: save.clone(), backups: backups.clone().unwrap_or_else(|| "sync_backups".into()) };
                        match install::install(&mut StdStore, &paths, &body, &game, "test") {
                            Ok(info) => println!("INSTALLED version={} name={}", info.version.unwrap_or_default(), info.player_name.unwrap_or_default()),
                            Err(r) => {
                                println!("REFUSED {}", r.reason());
                                std::process::exit(1);
                            }
                        }
                    }
                    let _ = std::io::stdout().flush();
                    std::process::exit(0);
                }
                Event::PullFailed { name, reason, .. } => {
                    println!("FAILED {} {}", name, reason);
                    std::process::exit(1);
                }
            }
        }
        let _ = std::io::stdout().flush();
        std::thread::sleep(Duration::from_millis(16));
    }
}
