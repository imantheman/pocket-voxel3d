// What does one map's planned load actually cost, and does it depend on where
// you walk in?
//
// Viridian Forest crashes on hardware when entered from the SOUTH gate and
// loads fine from the NORTH, which says the cost is position-dependent. A
// "huge" map sorts its chunks nearest-the-player-first and spends a smaller
// vertex budget on them, so the plan really is a different plan per entrance.
// This prints the per-entrance numbers so the two can be compared.
//
//   cargo run -p pocketvoxel-core --example plan_one -- VIRIDIAN_FOREST
use pocketvoxel_core::mapplan::{build_order, plan_build, planned_ranges};
use pocketvoxel_core::pak;
use pocketvoxel_core::spec::CHUNK_PX;
use std::env;
use std::fs;

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
    let name = env::args().nth(1).unwrap_or_else(|| "VIRIDIAN_FOREST".into());
    let dir = env::args().nth(2).unwrap_or_else(|| "dist/voxelmon/paks".into());
    let shared = fs::read(format!("{dir}/common.vxat")).ok();
    let data = fs::read(format!("{dir}/{name}.vxpak")).expect("read pak");
    let p = pak::read_with_shared(&data, shared.as_deref()).expect("parse");
    let (v_at, i_at, chnk_end) = pool_offsets(&data).expect("pools");
    let map = p.maps.iter().max_by_key(|m| m.count).expect("map");
    let chunks = &p.chunks[map.first as usize..(map.first + map.count) as usize];
    let stamps: Vec<pak::Stamp> = Vec::new();

    let (_, huge, budget) = build_order(chunks, None);
    println!(
        "{name}: {} chunks, pool {:.1} MB, huge={huge}, budget={budget} verts",
        chunks.len(),
        (chnk_end - v_at) as f64 / 1048576.0,
    );
    let (min_cy, max_cy) = chunks.iter().fold((i16::MAX, i16::MIN), |(a, b), c| {
        (a.min(c.cy), b.max(c.cy))
    });
    println!("  chunk rows cy {min_cy}..{max_cy}");

    // Where do the verts actually go? Per mesh kind, over every chunk.
    let mut per_kind = vec![0usize; chunks[0].meshes.len()];
    for c in chunks {
        for (k, m) in c.meshes.iter().enumerate() {
            per_kind[k] += m.vert_count as usize;
        }
    }
    let grand: usize = per_kind.iter().sum();
    println!("  {grand} verts in total, by mesh kind:");
    let mut order: Vec<usize> = (0..per_kind.len()).collect();
    order.sort_by_key(|&k| std::cmp::Reverse(per_kind[k]));
    for k in order {
        if per_kind[k] > 0 {
            println!(
                "    kind {k:2}: {:9} verts  {:5.1}%",
                per_kind[k],
                100.0 * per_kind[k] as f64 / grand as f64,
            );
        }
    }

    let mut worst = (0u64, 0i16, 0i16);
    for c in chunks {
        let centre = Some((
            (c.cx as f32 + 0.5) * CHUNK_PX as f32,
            (c.cy as f32 + 0.5) * CHUNK_PX as f32,
        ));
        let (order, huge, budget) = build_order(chunks, centre);
        let plan = plan_build(chunks, &order, huge, budget, 0);
        let ranges = planned_ranges(chunks, &plan, &stamps, v_at, i_at, 4096);
        let bytes: u64 = ranges.iter().map(|r| (r.1 - r.0) as u64).sum();
        let mut verts = 0usize;
        let mut idx = 0usize;
        for it in &plan.items {
            let m = &chunks[it.chunk].meshes[it.kind];
            verts += m.vert_count as usize;
            idx += m.index_count as usize;
        }
        if bytes > worst.0 {
            worst = (bytes, c.cx, c.cy);
        }
        // the two gates: the north edge and the south edge of the map
        if c.cy == min_cy || c.cy == max_cy {
            println!(
                "  at chunk ({:2},{:2}) {}: verts {:7} idx {:7} -> read {:5.1} MB in {} ranges",
                c.cx,
                c.cy,
                if c.cy == min_cy { "NORTH" } else { "SOUTH" },
                verts,
                idx,
                bytes as f64 / 1048576.0,
                ranges.len(),
            );
        }
    }
    println!(
        "  worst read anywhere: {:.1} MB at chunk ({},{})",
        worst.0 as f64 / 1048576.0,
        worst.1,
        worst.2
    );
}
