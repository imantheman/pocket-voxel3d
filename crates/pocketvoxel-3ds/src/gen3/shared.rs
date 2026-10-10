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
//! - when a pak is about to be parsed, its shared page is read from the card
//!   into a store of pages (or found there), the pak's page directory is
//!   pointed at offset 0 and SHARED_ATLAS at that page for the parse
//!   ([`shared_attach`], [`shared_plan`] for map_pak's planning parse); the
//!   pak's atlas page then borrows the stored page;
//! - a stored page no cached pak borrows any more is let go (the two used
//!   last are kept for the next map, which mostly shares its tileset's).
//! A page is its own small block (a few hundred KB), never grown onto a
//! pak's buffer: late in a long session the app heap had no second block of
//! a pak's size to grow one into. The bytes are the file's, so every texel
//! is what it was.

use super::dlog;
use std::io::{Read, Seek, SeekFrom};

const SHARED_BIT: u32 = 1 << 31;
const TAG_ATLS: u32 = u32::from_le_bytes(*b"ATLS");
/// Stored pages no cached pak borrows that are kept anyway, the last used.
const SPARE_PAGES: usize = 2;

/// The stored pages, most recently used first: (offset in common.vxat --
/// or u32::MAX for a pak's several pages put together -- and the bytes).
static mut STORE: Vec<(u32, Box<[u8]>)> = Vec::new();
/// What shared_plan changed in a pak's directory (the pak's length, then
/// each field's place and its value before and after), for shared_attach.
static mut PLAN_PATCH: Option<(u32, Vec<(usize, u32, u32)>)> = None;

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

/// Read `len` bytes of common.vxat at `off`.
fn read_page(off: u32, len: usize) -> Option<Box<[u8]>> {
    let path = format!("{}/common.vxat", super::super::PAKS_DIR);
    let mut f = std::fs::File::open(&path).ok()?;
    f.seek(SeekFrom::Start(off as u64)).ok()?;
    let mut v: Vec<u8> = Vec::new();
    if v.try_reserve_exact(len).is_err() {
        super::make_room(len, "a shared atlas page");
        v.try_reserve_exact(len).ok()?;
    }
    v.resize(len, 0);
    f.read_exact(&mut v).ok()?;
    Some(v.into_boxed_slice())
}

/// The stored pages no cached pak borrows let go, but for the SPARE_PAGES
/// used last.
#[allow(static_mut_refs)]
fn reclaim() {
    unsafe {
        let mut live: Vec<usize> = Vec::new();
        for c in super::super::PAK_CACHE.iter() {
            for pg in c.pak.atlases.iter() {
                if pg.frame_len > 0 { live.push(pg.frame(0).as_ptr() as usize); }
            }
        }
        let mut spare = 0;
        STORE.retain(|(_, b)| {
            let (lo, hi) = (b.as_ptr() as usize, b.as_ptr() as usize + b.len());
            if live.iter().any(|&p| p >= lo && p < hi) { return true; }
            spare += 1;
            spare <= SPARE_PAGES
        });
    }
}

/// The pak's shared pages as one stored block, the directory pointed at it
/// (each field's place, value before, value after), and SHARED_ATLAS at it.
/// None: the pak has no shared page, or one could not be read (SHARED_ATLAS
/// is then None, and the parse says so).
#[allow(static_mut_refs)]
fn pages_for(v: &mut [u8]) -> Option<Vec<(usize, u32, u32)>> {
    unsafe {
        // (never a stale page: one that cannot be read fails the parse)
        super::super::SHARED_ATLAS = None;
        let n0 = total_len(v).unwrap_or(v.len()).min(v.len());
        let entries = shared_entries(&v[..n0]);
        if entries.is_empty() { return None; }
        let key = if entries.len() == 1 { entries[0].1 } else { u32::MAX };
        let want: usize = entries.iter().map(|e| e.2.next_multiple_of(16)).sum();
        let hit = if key != u32::MAX { STORE.iter().position(|(o, b)| *o == key && b.len() >= entries[0].2) } else { None };
        let i = match hit {
            Some(i) => i,
            None => {
                let b = if entries.len() == 1 {
                    read_page(entries[0].1, entries[0].2)?
                } else {
                    let mut all: Vec<u8> = Vec::new();
                    all.try_reserve_exact(want).ok()?;
                    for &(_, off, len) in &entries {
                        all.extend_from_slice(&read_page(off, len)?);
                        all.resize(all.len().next_multiple_of(16), 0);
                    }
                    all.into_boxed_slice()
                };
                STORE.push((key, b));
                STORE.len() - 1
            }
        };
        let e = STORE.remove(i);
        STORE.insert(0, e);
        reclaim();
        let mut patched = Vec::new();
        let mut pos = 0usize;
        for &(at, _, len) in &entries {
            let old = u32_at(v, at).unwrap_or(0);
            let new = SHARED_BIT | pos as u32;
            v[at..at + 4].copy_from_slice(&new.to_le_bytes());
            patched.push((at, old, new));
            pos += len.next_multiple_of(16);
        }
        super::super::SHARED_ATLAS = Some(core::mem::transmute::<&[u8], &'static [u8]>(&STORE[0].1[..]));
        Some(patched)
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
/// page stored and SHARED_ATLAS pointed at it, the directory patched;
/// shared_attach puts the directory back before doing the same.
#[allow(static_mut_refs)]
pub fn shared_plan(v: &mut Vec<u8>) {
    unsafe {
        PLAN_PATCH = None;
        if let Some(p) = pages_for(v) {
            PLAN_PATCH = Some((total_len(v).unwrap_or(0) as u32, p));
        }
    }
}

/// A pak just read, before it is parsed: its shared page stored (or found
/// there), its directory pointed at it, SHARED_ATLAS at it for the parse.
#[allow(static_mut_refs)]
pub fn shared_attach(buf: Box<[u8]>) -> Box<[u8]> {
    unsafe {
        let mut v = buf;
        let n0 = total_len(&v).unwrap_or(v.len()).min(v.len());
        // shared_plan's changes to this pak's directory, put back
        if let Some((len, patched)) = PLAN_PATCH.take() {
            if len as usize == n0 {
                for (at, old, new) in patched {
                    if u32_at(&v, at) == Some(new) { v[at..at + 4].copy_from_slice(&old.to_le_bytes()); }
                }
            }
        }
        let _ = pages_for(&mut v);
        v
    }
}

/// Room for a pak's read buffer (same-line hooks in main.rs's map_pak and
/// prefetch_start, which then reserve `len` as before): `room`, between
/// frames, makes room first when one block of `len` would not be given.
pub fn pak_vec(len: usize, room: bool) -> Vec<u8> {
    if room {
        super::make_room(len, "a pak's read");
    }
    Vec::new()
}

/// The pak alone, for its parse (its length is its header's).
pub fn pak_bytes(b: &'static [u8]) -> &'static [u8] {
    match total_len(b) {
        Some(n) if n <= b.len() => &b[..n],
        _ => b,
    }
}
