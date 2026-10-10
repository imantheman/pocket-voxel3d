//! pocket-voxel 3DS host for the gen3 (FireRed) port (GPLv3 + additional
//! terms; see LICENSE.md). FireRed's shared atlas pages read from the card
//! when a pak needs one, instead of the whole of common.vxat kept for the
//! session.
//!
//! A FireRed pak has one atlas page, its terrain, and 412 of the 425 paks
//! point it into common.vxat (tools/pak_share_atlas.py: 47 distinct pages,
//! 5.6 MB). main.rs read all of it at boot and kept it (SHARED_ATLAS) --
//! 5.8 MB of the app heap for the whole session, where a map build needs
//! one page. Here (same-line hooks in main.rs, around each place a pak is
//! parsed):
//! - at boot the blob main.rs read is let go ([`shared_release`]);
//! - when a pak is read, its shared pages are read from the card -- or taken
//!   from the last few read -- and appended to the pak's own buffer, so they
//!   live and go with that pak; the page directory points at the copy and
//!   SHARED_ATLAS points at the appended tail for the parse that follows
//!   ([`shared_attach`]; [`pak_bytes`] gives the parse the pak without it);
//! - map_pak's planning parse, before the pools are read, gets its pages the
//!   same way, from a buffer of its own ([`shared_plan`]).
//! The pages' bytes are the file's, so every texel is what it was.

use super::dlog;
use std::io::{Read, Seek, SeekFrom};

const SHARED_BIT: u32 = 1 << 31;
const TAG_ATLS: u32 = u32::from_le_bytes(*b"ATLS");
/// Pages kept after they are read, for the next pak that wants one: a
/// route and the town beside it mostly share their tileset's page.
const KEEP_PAGES: usize = 2;

/// The pages read lately, most recent first: (offset in common.vxat, bytes).
static mut PAGES: Vec<(u32, Box<[u8]>)> = Vec::new();
/// shared_plan's pages for the planning parse, and what it changed in the
/// pak's directory (the pak's length, then each patched field's place and
/// its value before and after), for shared_attach to put back.
static mut PLAN_PAGES: Vec<u8> = Vec::new();
static mut PLAN_PATCH: Option<(u32, Vec<(usize, u32, u32)>)> = None;
/// Pages read from the card, and from the kept ones (the perf picture).
static mut READS: u32 = 0;
static mut HITS: u32 = 0;

fn u16_at(b: &[u8], o: usize) -> Option<u16> {
    b.get(o..o + 2).map(|s| u16::from_le_bytes([s[0], s[1]]))
}
fn u32_at(b: &[u8], o: usize) -> Option<u32> {
    b.get(o..o + 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}

/// The pak's own length (its header's).
fn total_len(b: &[u8]) -> Option<usize> {
    if b.len() < 16 { return None; }
    u32_at(b, 8).map(|n| n as usize)
}

/// The shared pages in a pak's directory: (place of its offset field, its
/// offset in common.vxat, its bytes).
fn shared_entries(b: &[u8]) -> Vec<(usize, u32, usize)> {
    let mut out = Vec::new();
    let Some(n) = u16_at(b, 6) else { return out };
    for s in 0..n as usize {
        let e = 16 + s * 16;
        if u32_at(b, e) != Some(TAG_ATLS) { continue; }
        let (Some(off), Some(len)) = (u32_at(b, e + 4), u32_at(b, e + 8)) else { return out };
        let sect = off as usize;
        if sect + len as usize > b.len() { return out; }
        let Some(pages) = u16_at(b, sect) else { return out };
        for p in 0..pages as usize {
            let d = sect + 2 + p * 16;
            let (Some(frames), Some(o), Some(l)) = (u16_at(b, d + 6), u32_at(b, d + 8), u32_at(b, d + 12)) else { return out };
            if o & SHARED_BIT != 0 {
                out.push((d + 8, o & !SHARED_BIT, l as usize * frames.max(1) as usize));
            }
        }
    }
    out
}

/// A shared page's bytes: from the ones kept, else read from the card.
#[allow(static_mut_refs)]
fn page(off: u32, len: usize) -> Option<&'static [u8]> {
    unsafe {
        if let Some(i) = PAGES.iter().position(|(o, b)| *o == off && b.len() == len) {
            let hit = PAGES.remove(i);
            PAGES.insert(0, hit);
            HITS += 1;
            return Some(core::mem::transmute::<&[u8], &'static [u8]>(&PAGES[0].1[..]));
        }
        let path = format!("{}/common.vxat", super::super::PAKS_DIR);
        let mut f = std::fs::File::open(&path).ok()?;
        f.seek(SeekFrom::Start(off as u64)).ok()?;
        let mut v: Vec<u8> = Vec::new();
        v.try_reserve_exact(len).ok()?;
        v.resize(len, 0);
        f.read_exact(&mut v).ok()?;
        READS += 1;
        PAGES.insert(0, (off, v.into_boxed_slice()));
        PAGES.truncate(KEEP_PAGES);
        Some(core::mem::transmute::<&[u8], &'static [u8]>(&PAGES[0].1[..]))
    }
}

/// At boot, right after main.rs read common.vxat into SHARED_ATLAS: let it go.
#[allow(static_mut_refs)]
pub fn shared_release() {
    unsafe {
        if let Some(s) = super::super::SHARED_ATLAS.take() {
            let kb = s.len() / 1024;
            // main.rs leaked it from a Box<[u8]>: given back the same way
            drop(Box::from_raw(s as *const [u8] as *mut [u8]));
            dlog(&format!("[pv] g3: shared atlas ({} KB) let go: each pak's shared page is read when the pak is", kb));
        }
    }
}

/// map_pak's planning parse (before the pools are read): the pak's shared
/// pages put in a buffer of their own, the directory pointed at it, and
/// SHARED_ATLAS at the buffer; shared_attach puts the directory back.
#[allow(static_mut_refs)]
pub fn shared_plan(v: &mut Vec<u8>) {
    unsafe {
        // (never a stale tail: a page that cannot be read fails the parse)
        super::super::SHARED_ATLAS = None;
        PLAN_PATCH = None;
        PLAN_PAGES = Vec::new();
        let entries = shared_entries(v);
        if entries.is_empty() { return; }
        let mut patched = Vec::new();
        for (at, off, len) in entries {
            let Some(p) = page(off, len) else { continue };
            let pos = PLAN_PAGES.len();
            PLAN_PAGES.extend_from_slice(p);
            PLAN_PAGES.resize(PLAN_PAGES.len().next_multiple_of(16), 0);
            let old = u32_at(v, at).unwrap_or(0);
            let new = SHARED_BIT | pos as u32;
            v[at..at + 4].copy_from_slice(&new.to_le_bytes());
            patched.push((at, old, new));
        }
        PLAN_PATCH = Some((total_len(v).unwrap_or(0) as u32, patched));
        super::super::SHARED_ATLAS = Some(core::mem::transmute::<&[u8], &'static [u8]>(&PLAN_PAGES[..]));
    }
}

/// A pak just read, before it is parsed: its shared pages appended to its
/// own buffer and its directory pointed at them; SHARED_ATLAS points at
/// that tail for the parse (pak_bytes gives the parse the pak alone). A pak
/// with no shared page, or one whose page cannot be read, comes back as it
/// was (the parse then says so, as before without the blob).
#[allow(static_mut_refs)]
pub fn shared_attach(buf: Box<[u8]>) -> Box<[u8]> {
    unsafe {
        // (never a stale tail: a page that cannot be read fails the parse)
        super::super::SHARED_ATLAS = None;
        let mut v = buf.into_vec();
        let n0 = total_len(&v).unwrap_or(v.len()).min(v.len());
        // shared_plan's changes to this pak's directory, put back
        if let Some((len, patched)) = PLAN_PATCH.take() {
            if len as usize == n0 {
                for (at, old, new) in patched {
                    if u32_at(&v, at) == Some(new) { v[at..at + 4].copy_from_slice(&old.to_le_bytes()); }
                }
            }
        }
        PLAN_PAGES = Vec::new();
        let entries = shared_entries(&v[..n0]);
        if entries.is_empty() {
            return v.into_boxed_slice();
        }
        let base = n0.next_multiple_of(16);
        let need: usize = entries.iter().map(|e| e.2.next_multiple_of(16)).sum();
        if v.try_reserve_exact(base + need - v.len()).is_err() {
            return v.into_boxed_slice();
        }
        v.resize(base, 0);
        for (at, off, len) in entries {
            let Some(p) = page(off, len) else { continue };
            let pos = v.len() - base;
            v.extend_from_slice(p);
            v.resize(v.len().next_multiple_of(16), 0);
            v[at..at + 4].copy_from_slice(&(SHARED_BIT | pos as u32).to_le_bytes());
        }
        let b = v.into_boxed_slice();
        super::super::SHARED_ATLAS = Some(core::mem::transmute::<&[u8], &'static [u8]>(&b[base..]));
        b
    }
}

/// The pak alone, for its parse (its length is its header's, the pages
/// shared_attach appended past it).
pub fn pak_bytes(b: &'static [u8]) -> &'static [u8] {
    match total_len(b) {
        Some(n) if n <= b.len() => &b[..n],
        _ => b,
    }
}

/// For the perf picture: pages read from the card and taken from the kept ones.
pub fn shared_stats() -> (u32, u32) {
    unsafe { (READS, HITS) }
}
