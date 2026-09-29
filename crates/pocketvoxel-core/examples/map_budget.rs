// Where a map's vertex budget goes, and whether it streams.
//
// A map whose full-detail index count passes HUGE_MAP_THRESHOLD is "huge":
// it gets the smaller MAX_VERTS_SAFE budget, builds nearest-the-player-first,
// and REBUILDS (re-reading the pak ranges) every time the player crosses a
// chunk -- the stall Saffron shows every few steps. This prints, per map,
// the per-kind totals, the classification, and what a single whole-map
// build at MAX_VERTS would keep.
//
//   cargo run --release -p pocketvoxel-core --example map_budget -- dist/voxelmon/paks SAFFRON_CITY CELADON_CITY
use pocketvoxel_core::mapplan::{build_order, plan_build, HUGE_MAP_THRESHOLD, MAX_VERTS};
use pocketvoxel_core::pak;
use std::collections::HashMap;
use std::env;
use std::fs;

const NAMES: [&str; 9] = [
    "terrain", "ground_bake", "terrain_keep", "tree_hull", "tree_coarse", "tree_box", "water",
    "grass", "flower",
];

fn main() {
    let args: Vec<String> = env::args().collect();
    let dir = &args[1];
    let shared = fs::read(format!("{dir}/common.vxat")).ok();
    let index = fs::read_to_string(format!("{dir}/index.txt")).unwrap_or_default();
    let ids: HashMap<String, u32> = index
        .lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            let id = it.next()?.parse().ok()?;
            Some((it.next()?.to_string(), id))
        })
        .collect();
    for name in &args[2..] {
        // a bare .vxpak path is a single-map cook (no shared atlas, one map)
        let single = name.ends_with(".vxpak");
        let data = if single { fs::read(name).unwrap() } else { fs::read(format!("{dir}/{name}.vxpak")).unwrap() };
        let p = if single { pak::read(&data).unwrap() } else { pak::read_with_shared(&data, shared.as_deref()).unwrap() };
        let id = if single { p.maps[0].map_id } else { ids[name] };
        let map = p.maps.iter().find(|m| m.map_id == id).unwrap();
        let chunks = &p.chunks[map.first as usize..(map.first + map.count) as usize];
        let mut totals = [0usize; 9];
        let (mut maxx, mut maxy) = (0i32, 0i32);
        for c in chunks {
            for (k, m) in c.meshes.iter().enumerate() {
                totals[k] += m.index_count as usize;
            }
            maxx = maxx.max(c.cx as i32);
            maxy = maxy.max(c.cy as i32);
        }
        let stamps: usize = p.stamps_of(id).iter().map(|s| s.mesh.index_count as usize).sum();
        let (order, huge, budget) = build_order(chunks, Some((0.0, 0.0)));
        let full = totals[0] + totals[2] + totals[6] + totals[3] + totals[7] + totals[8];
        println!(
            "{name}: {} chunks ({}x{}), full detail {} vs threshold {} -> {}",
            chunks.len(), maxx + 1, maxy + 1, full, HUGE_MAP_THRESHOLD,
            if huge { format!("HUGE, streams at {budget}") } else { format!("built once at {budget}") },
        );
        for (k, n) in NAMES.iter().enumerate() {
            if totals[k] > 0 {
                println!("    {:>12}: {:>9}", n, totals[k]);
            }
        }
        println!("    {:>12}: {:>9}", "stamps", stamps);
        // what one whole-map build at the ordinary cap would keep
        let order_all: Vec<usize> = (0..chunks.len()).collect();
        let plan = plan_build(chunks, &order_all, false, MAX_VERTS, stamps);
        let mut kept = [0usize; 9];
        for it in &plan.items {
            kept[it.kind] += chunks[it.chunk].meshes[it.kind].index_count as usize;
        }
        let kept_total: usize = kept.iter().sum::<usize>() + stamps;
        let trees = |k: usize| plan.items.iter().filter(|i| i.kind == k).count();
        println!(
            "    built once at {MAX_VERTS}: keeps {} verts ({} KB); tree chunks hull/coarse/box = {}/{}/{}",
            kept_total.min(MAX_VERTS),
            kept_total.min(MAX_VERTS) * 16 / 1024,
            trees(3), trees(4), trees(5),
        );
        let _ = order;
    }
}
