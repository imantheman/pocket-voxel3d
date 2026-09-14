// Throwaway diagnostic: prove a repacked pak (tools/pak_share_atlas.py) plus
// the shared blob reads back exactly like the original that embedded every
// page — same page count, same per-page header, same texels byte for byte,
// and the same chunk/mesh totals.
//
//   cargo run -p pocketvoxel-core --example shared_atlas_check -- \
//       <orig.vxpak> <repacked.vxpak> <common.vxat>
use pocketvoxel_core::pak;
use std::env;
use std::fs;

fn main() {
    let a: Vec<String> = env::args().collect();
    let orig = fs::read(&a[1]).expect("orig");
    let newp = fs::read(&a[2]).expect("repacked");
    let shared = fs::read(&a[3]).expect("common.vxat");

    let p0 = pak::read(&orig).expect("original pak");
    let p1 = pak::read_with_shared(&newp, Some(&shared)).expect("repacked pak");

    assert_eq!(p0.atlases.len(), p1.atlases.len(), "page count");
    let mut shared_pages = 0;
    for i in 0..p0.atlases.len() {
        let (x, y) = (&p0.atlases[i], &p1.atlases[i]);
        assert_eq!((x.w, x.h, x.kind, x.frames), (y.w, y.h, y.kind, y.frames), "page {i} header");
        for f in 0..x.frames {
            assert_eq!(x.frame(f), y.frame(f), "page {i} frame {f} texels");
        }
        // texels outside the new pak's own bytes came from the shared blob
        let inside = y.frame(0).as_ptr() as usize;
        let lo = newp.as_ptr() as usize;
        if inside < lo || inside >= lo + newp.len() {
            shared_pages += 1;
        }
    }

    assert_eq!(p0.verts.len(), p1.verts.len(), "vertex pool");
    assert_eq!(p0.indices.len(), p1.indices.len(), "index pool");
    assert_eq!(p0.chunks.len(), p1.chunks.len(), "chunk count");
    assert_eq!(p0.maps.len(), p1.maps.len(), "map count");
    for i in 0..p0.chunks.len() {
        let (c0, c1) = (&p0.chunks[i], &p1.chunks[i]);
        assert_eq!(c0.cx, c1.cx);
        assert_eq!(c0.cy, c1.cy);
        assert_eq!(c0.bake_page, c1.bake_page, "chunk {i} bake page");
        for k in 0..c0.meshes.len() {
            assert_eq!(c0.meshes[k].index_count, c1.meshes[k].index_count, "chunk {i} kind {k}");
        }
    }
    // PakVert has no PartialEq, so compare the pool as raw bytes.
    let raw = |v: &[pak::PakVert]| -> Vec<u8> {
        v.iter()
            .flat_map(|p| {
                let mut b = Vec::with_capacity(16);
                b.extend_from_slice(&p.u.to_le_bytes());
                b.extend_from_slice(&p.v.to_le_bytes());
                b.extend_from_slice(&p.abgr.to_le_bytes());
                b.extend_from_slice(&p.x.to_le_bytes());
                b.extend_from_slice(&p.y.to_le_bytes());
                b.extend_from_slice(&p.z.to_le_bytes());
                b
            })
            .collect()
    };
    assert!(raw(p0.verts) == raw(p1.verts), "vertex bytes");
    assert!(p0.indices == p1.indices, "index bytes");

    println!(
        "OK  {} pages ({} from the shared blob), {} chunks, {} verts — identical.  {} KB -> {} KB",
        p0.atlases.len(),
        shared_pages,
        p0.chunks.len(),
        p0.verts.len(),
        orig.len() / 1024,
        newp.len() / 1024,
    );
}
