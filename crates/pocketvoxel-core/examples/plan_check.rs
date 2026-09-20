// Prove a planned read gives the renderer byte-identical geometry to reading
// the pak whole, over every cooked map.
//
// The renderer only ever touches, for each mesh in the plan, that mesh's
// index range and the vertices those indices name. So: take a real pak, work
// out the plan, and check that every byte the renderer would read is inside
// a planned range — that a selective read leaves nothing it needs behind. If
// that holds, what gets drawn cannot differ.
//
//   cargo run -p pocketvoxel-core --example plan_check -- dist/voxelmon/paks
use pocketvoxel_core::mapplan::{build_order, plan_build, planned_ranges};
use pocketvoxel_core::pak;
use pocketvoxel_core::spec::CHUNK_PX;
use std::env;
use std::fs;

/// Where the two pools start in the file, from the CHNK section header.
fn pool_offsets(data: &[u8]) -> Option<(usize, usize, usize)> {
    let n = u16::from_le_bytes([data[6], data[7]]) as usize;
    for s in 0..n {
        let e = 16 + s * 16;
        if &data[e..e + 4] != b"CHNK" {
            continue;
        }
        let off = u32::from_le_bytes([data[e + 4], data[e + 5], data[e + 6], data[e + 7]]) as usize;
        let len = u32::from_le_bytes([data[e + 8], data[e + 9], data[e + 10], data[e + 11]]) as usize;
        let h = &data[off..off + 32];
        let v = off + u32::from_le_bytes([h[8], h[9], h[10], h[11]]) as usize;
        let i = off + u32::from_le_bytes([h[16], h[17], h[18], h[19]]) as usize;
        return Some((v, i, off + len));
    }
    None
}

fn main() {
    let dir = env::args().nth(1).unwrap_or_else(|| "dist/voxelmon/paks".into());
    let shared = fs::read(format!("{dir}/common.vxat")).ok();
    let mut files: Vec<_> = fs::read_dir(&dir)
        .expect("paks dir")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "vxpak"))
        .collect();
    files.sort();

    let (mut checked, mut bad, mut before, mut after) = (0usize, 0usize, 0u64, 0u64);
    let mut wins: Vec<(f64, String, u64, u64)> = Vec::new();

    for path in &files {
        let name = path.file_stem().unwrap().to_string_lossy().to_string();
        let data = fs::read(path).expect("read");
        let p = match pak::read_with_shared(&data, shared.as_deref()) {
            Ok(p) => p,
            Err(e) => {
                println!("{name}: parse failed: {e}");
                bad += 1;
                continue;
            }
        };
        let Some((v_at, i_at, chnk_end)) = pool_offsets(&data) else { continue };
        // The map this pak is for: the one with the most chunks.
        let Some(map) = p.maps.iter().max_by_key(|m| m.count) else { continue };
        let map_id = map.map_id;
        let chunks = &p.chunks[map.first as usize..(map.first + map.count) as usize];
        if chunks.is_empty() {
            continue;
        }

        // Every chunk is somewhere the player could be standing when the map
        // loads, and a huge map's plan turns on that. Check them all.
        let mut centres: Vec<Option<(f32, f32)>> = vec![None];
        for c in chunks {
            centres.push(Some((
                (c.cx as f32 + 0.5) * CHUNK_PX as f32,
                (c.cy as f32 + 0.5) * CHUNK_PX as f32,
            )));
        }

        let full_pool = (chnk_end - v_at) as u64;
        let mut worst_read = 0u64;
        let mut ok = true;
        'centres: for centre in centres {
            let (order, huge, budget) = build_order(chunks, centre);
            let stamp_verts: usize =
                p.stamps_of(map_id).iter().map(|s| s.mesh.index_count as usize).sum();
            let plan = plan_build(chunks, &order, huge, budget, stamp_verts);
            let runs = planned_ranges(chunks, &plan, p.stamps_of(map_id), &p.tree_shapes, v_at, i_at, 8 * 1024);
            worst_read = worst_read.max(runs.iter().map(|(a, b)| (b - a) as u64).sum::<u64>());
            let covered = |a: usize, b: usize| runs.iter().any(|&(x, y)| x <= a && b <= y);

            for it in plan.items.iter() {
                let m = chunks[it.chunk].meshes[it.kind];
                if m.index_count == 0 {
                    continue;
                }
                let ia = i_at + m.index_base as usize * 2;
                if !covered(ia, ia + m.index_count as usize * 2) {
                    println!("{name}: indices for chunk {} kind {} NOT read", it.chunk, it.kind);
                    ok = false;
                    break 'centres;
                }
                let va = v_at + m.vert_base as usize * 16;
                if !covered(va, va + m.vert_count as usize * 16) {
                    println!("{name}: verts for chunk {} kind {} NOT read", it.chunk, it.kind);
                    ok = false;
                    break 'centres;
                }
                // and the indices really do stay inside that vertex block,
                // which is what makes reading the block whole sufficient
                let (lo, hi) = (m.vert_base as usize, m.vert_base as usize + m.vert_count as usize);
                let base = m.index_base as usize;
                for k in 0..m.index_count as usize {
                    if lo + p.indices[base + k] as usize >= hi {
                        println!("{name}: an index leaves its own vertex block");
                        ok = false;
                        break 'centres;
                    }
                }
            }
            for st in p.stamps_of(map_id) {
                let m = st.mesh;
                if m.index_count == 0 {
                    continue;
                }
                let ia = i_at + m.index_base as usize * 2;
                let va = v_at + m.vert_base as usize * 16;
                if !covered(ia, ia + m.index_count as usize * 2)
                    || !covered(va, va + m.vert_count as usize * 16)
                {
                    println!("{name}: stamp geometry NOT read");
                    ok = false;
                    break 'centres;
                }
            }
        }

        checked += 1;
        if !ok {
            bad += 1;
        }
        before += full_pool;
        after += worst_read;
        wins.push((
            full_pool as f64 / worst_read.max(1) as f64,
            name,
            full_pool,
            worst_read,
        ));
    }

    wins.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
    println!("\nbiggest wins (worst-case player position):");
    for (r, n, f, w) in wins.iter().take(10) {
        println!(
            "  {n:26} {:7.1} MB -> {:5.1} MB  {r:5.1}x",
            *f as f64 / 1048576.0,
            *w as f64 / 1048576.0
        );
    }
    println!(
        "\n{checked} maps checked, {bad} failed.  geometry pools {:.0} MB -> {:.0} MB read ({:.1}x)",
        before as f64 / 1048576.0,
        after as f64 / 1048576.0,
        before as f64 / after.max(1) as f64,
    );
    if bad > 0 {
        std::process::exit(1);
    }
}
