//! Packing one map's planned geometry into a small pak image.
//!
//! A pak is read in place: the loader allocates a buffer the size of the
//! whole file and reads only the byte ranges the build will draw into it,
//! because every offset inside the file -- section table, pool offsets, mesh
//! bases -- is a position in that image. For a route that is fine (8-10 MB
//! for ~6 MB of use). For Viridian Forest it is not: 56 MB, of which 37.5 MB
//! is fine tree hulls the 400,000-vertex budget can never all draw, for
//! ~13 MB of actual use. Asking a 3DS heap for 56 MB is what left the GPU
//! thread's own stack unmapped, 2 MB into the heap, and took the console
//! down on every entry.
//!
//! This plans the same read into a buffer that holds only what is wanted:
//! everything up to the pools verbatim (so every offset before them still
//! points where it did), then the planned vertex and index runs packed
//! end to end, then the sections after CHNK shifted down to meet them. The
//! mesh bases, pool offsets, section table and header length are rewritten
//! to match, so the result parses as an ordinary pak -- with exactly the
//! geometry the plan asked for, and nothing else.
//!
//! What comes out is byte-identical geometry: the same vertices and the same
//! indices, at new positions. Meshes the plan did not ask for read as empty,
//! which is what the in-place loader leaves behind for them anyway.

use alloc::vec::Vec;

use crate::pak::Chunk;
use crate::spec::{VERTEX_STRIDE, VXPK_ALIGN, VXPK_CHUNK_RECORD_SIZE};

/// Runs this far apart are read (and copied) as one: a seek plus a read on
/// SD costs far more than the few unwanted bytes in the gap.
pub const COMPACT_SLOP: usize = 16 * 1024;

/// One run of bytes copied from the file into the compact image.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Copy {
    pub src: usize,
    pub len: usize,
    pub dst: usize,
}

/// The compact image: what to read, and what to rewrite once it is read.
#[derive(Clone, Debug, Default)]
pub struct Compact {
    /// Size of the buffer to allocate.
    pub len: usize,
    /// File -> buffer copies, in ascending file order.
    pub copies: Vec<Copy>,
    /// Little-endian u32 writes into the buffer, applied after the copies.
    pub u32_patches: Vec<(usize, u32)>,
    /// Little-endian u16 writes into the buffer.
    pub u16_patches: Vec<(usize, u16)>,
}

/// What the planner needs to know about the file it is packing.
pub struct Source<'a> {
    pub file_len: usize,
    /// (offset, length) of the nine sections, in table order.
    pub sections: [(usize, usize); 9],
    /// Index of CHNK in that table (3 in every pak this cooks).
    pub chnk_idx: usize,
    pub map_count: usize,
    pub chunk_total: usize,
    /// Absolute file offsets and byte lengths of the two pools.
    pub verts_at: usize,
    pub verts_len: usize,
    pub indices_at: usize,
    pub indices_len: usize,
    /// Every chunk record in the file, in file order.
    pub chunks: &'a [Chunk],
    /// The meshes to keep, as (index into `chunks`, mesh kind).
    pub planned: &'a [(usize, usize)],
    /// Stamps in the file. Their ranges point into the same pools and this
    /// planner does not rewrite them, so a pak with any is left alone.
    pub stamp_total: usize,
    /// Byte ranges of the file to copy verbatim before the pools -- the
    /// header, table, the sections ahead of CHNK, and the chunk records.
    /// Anything left out (GAME) stays zero, as the in-place loader leaves it.
    pub prefix: &'a [(usize, usize)],
}

fn align_up(v: usize, a: usize) -> usize {
    v.div_ceil(a) * a
}

/// Merge sorted runs that are touching or within `slop`.
fn merge(mut runs: Vec<(usize, usize)>, slop: usize) -> Vec<(usize, usize)> {
    runs.sort_unstable();
    let mut out: Vec<(usize, usize)> = Vec::with_capacity(runs.len());
    for (a, b) in runs {
        match out.last_mut() {
            Some(last) if a <= last.1 + slop => last.1 = last.1.max(b),
            _ => out.push((a, b)),
        }
    }
    out
}

/// Where a file offset inside merged runs landed in the compact image.
fn dst_of(runs: &[(usize, usize, usize)], src: usize) -> Option<usize> {
    let r = runs.iter().find(|(a, b, _)| src >= *a && src < *b)?;
    Some(r.2 + (src - r.0))
}

/// Plan the compact image, or None when this pak is not a candidate (it
/// carries stamps, its pools are not where the format says, nothing planned).
pub fn plan(src: &Source) -> Option<Compact> {
    if src.stamp_total != 0 || src.planned.is_empty() {
        return None;
    }
    let (chnk_off, chnk_len) = src.sections[src.chnk_idx];
    let chnk_end = chnk_off + chnk_len;
    if src.verts_at < chnk_off || src.indices_at + src.indices_len > chnk_end {
        return None;
    }

    // The runs each pool actually needs.
    let mut vruns: Vec<(usize, usize)> = Vec::new();
    let mut iruns: Vec<(usize, usize)> = Vec::new();
    for &(ci, kind) in src.planned {
        let m = *src.chunks.get(ci)?.meshes.get(kind)?;
        if m.index_count == 0 {
            continue;
        }
        let vb = src.verts_at + m.vert_base as usize * VERTEX_STRIDE;
        vruns.push((vb, vb + m.vert_count as usize * VERTEX_STRIDE));
        let ib = src.indices_at + m.index_base as usize * 2;
        iruns.push((ib, ib + m.index_count as usize * 2));
    }
    if vruns.is_empty() {
        return None;
    }
    let vruns = merge(vruns, COMPACT_SLOP);
    let iruns = merge(iruns, COMPACT_SLOP);

    // Laid out where the file's own pools start, so every offset before them
    // is still valid and only the two pools (and what follows) move.
    let mut copies: Vec<Copy> = Vec::new();
    for &(a, b) in src.prefix {
        if b > a {
            copies.push(Copy { src: a, len: b - a, dst: a });
        }
    }
    let new_verts_at = src.verts_at;
    let mut cur = new_verts_at;
    let mut vplaced: Vec<(usize, usize, usize)> = Vec::with_capacity(vruns.len());
    for (a, b) in vruns {
        copies.push(Copy { src: a, len: b - a, dst: cur });
        vplaced.push((a, b, cur));
        cur += b - a;
    }
    let new_verts_len = cur - new_verts_at;
    let new_indices_at = align_up(cur, VXPK_ALIGN);
    cur = new_indices_at;
    let mut iplaced: Vec<(usize, usize, usize)> = Vec::with_capacity(iruns.len());
    for (a, b) in iruns {
        copies.push(Copy { src: a, len: b - a, dst: cur });
        iplaced.push((a, b, cur));
        cur += b - a;
    }
    let new_indices_len = cur - new_indices_at;
    let new_chnk_end = align_up(cur, VXPK_ALIGN);

    // Everything after CHNK slides down by the same amount, so it stays
    // 16-aligned and in ascending order.
    if new_chnk_end > chnk_end {
        return None; // nothing to gain
    }
    let shift = chnk_end - new_chnk_end;
    if src.file_len > chnk_end {
        copies.push(Copy {
            src: chnk_end,
            len: src.file_len - chnk_end,
            dst: chnk_end - shift,
        });
    }

    let mut u32_patches: Vec<(usize, u32)> = Vec::new();
    let mut u16_patches: Vec<(usize, u16)> = Vec::new();
    let new_len = src.file_len - shift;
    // Header: total length (magic u32, version u16, count u16, THEN length).
    u32_patches.push((8, new_len as u32));
    // Section table: CHNK's new length, and the offset of everything after.
    for (i, &(off, len)) in src.sections.iter().enumerate() {
        let e = 16 + i * 16;
        if i == src.chnk_idx {
            u32_patches.push((e + 8, (new_chnk_end - chnk_off) as u32));
        } else if off > chnk_off {
            u32_patches.push((e + 4, (off - shift) as u32));
            let _ = len;
        }
    }
    // CHNK header: both pools, as offsets from the payload start.
    u32_patches.push((chnk_off + 8, (new_verts_at - chnk_off) as u32));
    u32_patches.push((chnk_off + 12, new_verts_len as u32));
    u32_patches.push((chnk_off + 16, (new_indices_at - chnk_off) as u32));
    u32_patches.push((chnk_off + 20, new_indices_len as u32));

    // Every mesh range in the file: rebased when it was kept, zeroed when it
    // was not -- a stale base would point past the packed pools, and the
    // reader checks every one of them.
    let rec0 = chnk_off + 32 + src.map_count * 12;
    for ci in 0..src.chunk_total {
        let rec = rec0 + ci * VXPK_CHUNK_RECORD_SIZE;
        let chunk = src.chunks.get(ci)?;
        for kind in 0..chunk.meshes.len() {
            let at = rec + 20 + kind * 12;
            let m = chunk.meshes[kind];
            let keep = m.index_count > 0 && src.planned.contains(&(ci, kind));
            if !keep {
                u32_patches.push((at, 0));
                u16_patches.push((at + 4, 0));
                u16_patches.push((at + 6, 0));
                u32_patches.push((at + 8, 0));
                continue;
            }
            let vsrc = src.verts_at + m.vert_base as usize * VERTEX_STRIDE;
            let isrc = src.indices_at + m.index_base as usize * 2;
            let vdst = dst_of(&vplaced, vsrc)?;
            let idst = dst_of(&iplaced, isrc)?;
            u32_patches.push((at, ((vdst - new_verts_at) / VERTEX_STRIDE) as u32));
            u32_patches.push((at + 8, ((idst - new_indices_at) / 2) as u32));
        }
    }

    copies.sort_unstable_by_key(|c| c.src);
    Some(Compact { len: new_len, copies, u32_patches, u16_patches })
}

/// The chunk records of a pak, parsed straight from the CHNK section's own
/// bytes.
///
/// The loader normally gets these by parsing a whole pak image, which is the
/// very allocation this module exists to avoid: the planner has to know every
/// mesh range BEFORE the buffer is sized. `bytes` is the CHNK payload from
/// its start through the end of the records; nothing after is touched.
pub fn parse_records(bytes: &[u8], map_count: usize, chunk_total: usize) -> Option<Vec<Chunk>> {
    let rec0 = 32 + map_count * 12;
    if bytes.len() < rec0 + chunk_total * VXPK_CHUNK_RECORD_SIZE {
        return None;
    }
    let i16at = |o: usize| i16::from_le_bytes([bytes[o], bytes[o + 1]]);
    let u16at = |o: usize| u16::from_le_bytes([bytes[o], bytes[o + 1]]);
    let u32at = |o: usize| u32::from_le_bytes([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]]);
    let mut out = Vec::with_capacity(chunk_total);
    for ci in 0..chunk_total {
        let r = rec0 + ci * VXPK_CHUNK_RECORD_SIZE;
        let mut meshes = [crate::pak::MeshRange::default(); crate::spec::MESH_KINDS];
        for (k, mesh) in meshes.iter_mut().enumerate() {
            let m = r + 20 + k * 12;
            *mesh = crate::pak::MeshRange {
                vert_base: u32at(m),
                vert_count: u16at(m + 4),
                index_count: u16at(m + 6),
                index_base: u32at(m + 8),
            };
        }
        out.push(Chunk {
            cx: i16at(r),
            cy: i16at(r + 2),
            aabb_min: [i16at(r + 4), i16at(r + 6), i16at(r + 8)],
            aabb_max: [i16at(r + 10), i16at(r + 12), i16at(r + 14)],
            bake_page: u16at(r + 16),
            meshes,
        });
    }
    Some(out)
}

/// One map's run of chunk records, from the CHNK map directory.
pub fn map_dir(bytes: &[u8], map_count: usize, map_id: u32) -> Option<(usize, usize)> {
    let u32at = |o: usize| u32::from_le_bytes([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]]);
    for i in 0..map_count {
        let e = 32 + i * 12;
        if e + 12 > bytes.len() {
            return None;
        }
        if u32at(e) == map_id {
            return Some((u32at(e + 4) as usize, u32at(e + 8) as usize));
        }
    }
    None
}

/// Apply the planned rewrites to a buffer the copies have been read into.
pub fn patch(buf: &mut [u8], c: &Compact) {
    for &(at, v) in c.u32_patches.iter() {
        if at + 4 <= buf.len() {
            buf[at..at + 4].copy_from_slice(&v.to_le_bytes());
        }
    }
    for &(at, v) in c.u16_patches.iter() {
        if at + 2 <= buf.len() {
            buf[at..at + 2].copy_from_slice(&v.to_le_bytes());
        }
    }
}

#[cfg(all(test, feature = "std"))]
mod tests {
    use super::*;
    use crate::mapplan::{build_order, plan_build};
    use crate::pak;
    use std::path::PathBuf;

    fn paks() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../dist/voxelmon/paks")
    }

    /// Read the section table the way the loader does.
    fn sections(blob: &[u8]) -> ([(usize, usize); 9], usize) {
        let n = u16::from_le_bytes([blob[6], blob[7]]) as usize;
        let mut out = [(0usize, 0usize); 9];
        let mut chnk = 0;
        for i in 0..n.min(9) {
            let e = 16 + i * 16;
            let off = u32::from_le_bytes([blob[e + 4], blob[e + 5], blob[e + 6], blob[e + 7]]) as usize;
            let len = u32::from_le_bytes([blob[e + 8], blob[e + 9], blob[e + 10], blob[e + 11]]) as usize;
            out[i] = (off, len);
            if &blob[e..e + 4] == b"CHNK" {
                chnk = i;
            }
        }
        (out, chnk)
    }

    /// The triangles of one mesh, as (position, uv, colour) per corner.
    fn tris(p: &pak::Pak, m: pak::MeshRange) -> Vec<([i16; 3], u16, u16, u32)> {
        let mut out = Vec::new();
        for i in 0..m.index_count as usize {
            let vi = m.vert_base as usize + p.indices[m.index_base as usize + i] as usize;
            let v = p.verts[vi];
            out.push(([v.x, v.y, v.z], v.u, v.v, v.abgr));
        }
        out
    }

    /// Pack a big map's planned geometry and check it comes out the same,
    /// from a buffer a fraction of the size. Route 23 is the largest map
    /// still read in place: 47 MB, of which a build draws a fraction.
    #[test]
    fn packs_a_big_map_without_changing_a_triangle() {
        let dir = paks();
        // The biggest map still read in place: 47 MB, no stamps, v8.
        let path = dir.join("ROUTE_23.vxpak");
        if !path.exists() {
            eprintln!("no cooked paks; skipped");
            return;
        }
        let blob = std::fs::read(&path).unwrap();
        let shared = std::fs::read(dir.join("common.vxat")).ok();
        let orig = pak::read_with_shared(&blob, shared.as_deref()).expect("read original");

        let (secs, chnk_idx) = sections(&blob);
        let (chnk_off, _) = secs[chnk_idx];
        let rd32 = |o: usize| u32::from_le_bytes([blob[o], blob[o + 1], blob[o + 2], blob[o + 3]]) as usize;
        let map_count = u16::from_le_bytes([blob[chnk_off], blob[chnk_off + 1]]) as usize;
        let chunk_total = rd32(chnk_off + 4);
        let verts_at = chnk_off + rd32(chnk_off + 8);
        let verts_len = rd32(chnk_off + 12);
        let indices_at = chnk_off + rd32(chnk_off + 16);
        let indices_len = rd32(chnk_off + 20);
        let rec0 = chnk_off + 32 + map_count * 12;
        let recs_end = rec0 + chunk_total * VXPK_CHUNK_RECORD_SIZE;

        // The plan the build would make, standing where the north gate drops
        // the player in.
        let map = orig.maps[0];
        let chunks = &orig.chunks[map.first as usize..(map.first + map.count) as usize];
        let (order, huge, budget) = build_order(chunks, Some((160.0, 1400.0)));
        assert!(huge, "this is the map size packing is for");
        let bp = plan_build(chunks, &order, huge, budget, 0);
        let planned: Vec<(usize, usize)> = bp
            .items
            .iter()
            .map(|it| (map.first as usize + it.chunk, it.kind))
            .collect();

        let src = Source {
            file_len: blob.len(),
            sections: secs,
            chnk_idx,
            map_count,
            chunk_total,
            verts_at,
            verts_len,
            indices_at,
            indices_len,
            chunks: &orig.chunks,
            planned: &planned,
            stamp_total: orig.stamps.len(),
            // everything up to the pools except GAME, which the loader never
            // reads either
            prefix: &[(0, secs[1].0), (secs[1].0 + secs[1].1, recs_end)],
        };
        let c = super::plan(&src).expect("a plan");

        // Well under the file, and under what a 3DS heap will hand out.
        eprintln!(
            "packed: {} MB file -> {} MB, {} reads",
            blob.len() / 1048576,
            c.len / 1048576,
            c.copies.len()
        );
        assert!(c.len < blob.len() / 3, "packed {} of {}", c.len, blob.len());

        let mut out = vec![0u8; c.len];
        for cp in c.copies.iter() {
            out[cp.dst..cp.dst + cp.len].copy_from_slice(&blob[cp.src..cp.src + cp.len]);
        }
        patch(&mut out, &c);

        let packed = pak::read_with_shared(&out, shared.as_deref()).expect("read packed");
        assert_eq!(packed.chunks.len(), orig.chunks.len());
        assert_eq!(packed.maps.len(), orig.maps.len());
        assert_eq!(packed.atlases.len(), orig.atlases.len());

        let mut checked = 0usize;
        for &(ci, kind) in planned.iter() {
            let a = tris(&orig, orig.chunks[ci].meshes[kind]);
            let b = tris(&packed, packed.chunks[ci].meshes[kind]);
            assert_eq!(a, b, "chunk {} kind {} changed", ci, kind);
            checked += a.len();
        }
        assert!(checked > 100_000, "only {} corners checked", checked);

        // What the plan did not ask for reads as empty, the way the
        // in-place loader leaves it.
        for ci in 0..orig.chunks.len() {
            for kind in 0..orig.chunks[ci].meshes.len() {
                if !planned.contains(&(ci, kind)) {
                    assert_eq!(packed.chunks[ci].meshes[kind].index_count, 0);
                }
            }
        }
    }

    /// The hand parser and the real reader agree, record for record.
    #[test]
    fn parses_the_same_records_the_reader_does() {
        let dir = paks();
        let path = dir.join("ROUTE_2.vxpak");
        if !path.exists() {
            eprintln!("no cooked paks; skipped");
            return;
        }
        let blob = std::fs::read(&path).unwrap();
        let shared = std::fs::read(dir.join("common.vxat")).ok();
        let orig = pak::read_with_shared(&blob, shared.as_deref()).expect("read");
        let (secs, chnk_idx) = sections(&blob);
        let (chnk_off, chnk_len) = secs[chnk_idx];
        let rd32 = |o: usize| u32::from_le_bytes([blob[o], blob[o + 1], blob[o + 2], blob[o + 3]]) as usize;
        let map_count = u16::from_le_bytes([blob[chnk_off], blob[chnk_off + 1]]) as usize;
        let chunk_total = rd32(chnk_off + 4);
        let payload = &blob[chnk_off..chnk_off + chnk_len];
        let mine = parse_records(payload, map_count, chunk_total).expect("records");
        assert_eq!(mine.len(), orig.chunks.len());
        for (a, b) in mine.iter().zip(orig.chunks.iter()) {
            assert_eq!(a.cx, b.cx);
            assert_eq!(a.cy, b.cy);
            assert_eq!(a.aabb_min, b.aabb_min);
            assert_eq!(a.aabb_max, b.aabb_max);
            assert_eq!(a.bake_page, b.bake_page);
            for (x, y) in a.meshes.iter().zip(b.meshes.iter()) {
                assert_eq!((x.vert_base, x.vert_count, x.index_count, x.index_base),
                           (y.vert_base, y.vert_count, y.index_count, y.index_base));
            }
        }
        let m = orig.maps.iter().find(|m| m.map_id == orig.maps[0].map_id).unwrap();
        assert_eq!(map_dir(payload, map_count, m.map_id), Some((m.first as usize, m.count as usize)));
    }

    /// A pak carrying stamps is left alone: their ranges point into the same
    /// pools and nothing here rewrites them.
    #[test]
    fn refuses_a_pak_with_stamps() {
        let chunks: Vec<pak::Chunk> = Vec::new();
        let src = Source {
            file_len: 1024,
            sections: [(0, 0); 9],
            chnk_idx: 3,
            map_count: 1,
            chunk_total: 0,
            verts_at: 0,
            verts_len: 0,
            indices_at: 0,
            indices_len: 0,
            chunks: &chunks,
            planned: &[(0, 0)],
            stamp_total: 1,
            prefix: &[],
        };
        assert!(super::plan(&src).is_none());
    }
}
