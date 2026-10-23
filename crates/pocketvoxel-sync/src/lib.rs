//! PVS1: moving a `.lua` save between this port and the PC/phone games
//! (gen1recomp with the "pvsync" mod) on one wifi network.
//!
//! Written from the protocol description alone (PROTOCOL.md in the pvsync
//! mod); no code from the mod or from gen1recomp is in here.
//!
//! - [`proto`]: the lines, the CRC, the name rules.
//! - [`session`]: discovery, offers, serving and pulling, ticked once a
//!   frame over the [`session::Net`] trait.
//! - [`net`]: that trait over std::net (the 3DS and a desktop).
//! - [`luadata`]: a received save checked as data, never run.
//! - [`install`]: the version check, the backup ring, the atomic write.
//! - [`host`]: one SYNC screen's sockets and records, opened once a visit.

pub mod choke;
pub mod host;
pub mod install;
pub mod luadata;
pub mod net;
pub mod proto;
pub mod session;
