// Throwaway diagnostic: print per-chunk mesh_kind index counts for one map
// in a cooked .vxpak, replicating exactly what pocketvoxel-3ds main.rs's
// build_map() sees, to find out how the 400,000-vert runtime budget is
// actually being spent on a given map.
use pocketvoxel_core::pak;
use std::env;
use std::fs;

fn main() {
    let args: Vec<String> = env::args().collect();
    let path = &args[1];
    let map_id: u32 = args[2].parse().unwrap();
    let data = fs::read(path).unwrap();
    let p = pak::read(&data).unwrap();
    let map = p.maps.iter().find(|m| m.map_id == map_id).expect("map not found");
    let chunks = &p.chunks[map.first as usize..(map.first + map.count) as usize];
    println!("map_id {} chunks {}", map_id, chunks.len());

    const NAMES: [&str; 8] = [
        "terrain", "ground_bake", "terrain_keep", "tree_hull", "tree_coarse", "tree_box", "water",
        "grass",
    ];
    // spec::MESH_KINDS is 9 (terrain..flower); NAMES above covers 0..7, add flower.
    let mut totals = [0u64; 9];
    for c in chunks {
        for (k, m) in c.meshes.iter().enumerate() {
            totals[k] += m.index_count as u64;
        }
    }
    let all_names = [
        "terrain", "ground_bake", "terrain_keep", "tree_hull", "tree_coarse", "tree_box", "water",
        "grass", "flower",
    ];
    for (k, name) in all_names.iter().enumerate() {
        println!("  kind {} ({:>12}): {} indices", k, name, totals[k]);
    }
    let ground: u64 = totals[0] + totals[2] + totals[6]; // + water
    let filler: u64 = totals[7] + totals[8]; // grass + flower only now
    println!("ground (terrain+terrain_keep): {}", ground);
    println!("tree_hull total: {}", totals[3]);
    println!("tree_box total: {}", totals[5]);
    println!("filler (water+grass+flower): {}", filler);
    println!("ground+hull+filler (if ALL hulls used): {}", ground + totals[3] + filler);
    println!("budget: 400000");
    let _ = NAMES;

    // Simulate the 3-tier per-chunk cascade (hull -> coarse -> box) exactly
    // as build_map's new logic picks it, then see what's left for filler.
    println!("\n3-tier cascade simulation (hull -> coarse -> box):");
    let mut running = ground;
    let mut tiers = [0u32; 3]; // hull, coarse, box counts
    for c in chunks.iter() {
        let hull = c.meshes[3].index_count as u64;
        let coarse = c.meshes[4].index_count as u64;
        let boxc = c.meshes[5].index_count as u64;
        if hull == 0 && coarse == 0 && boxc == 0 {
            continue;
        }
        let (add, tier) = if hull > 0 && running + hull <= 400_000 {
            (hull, 0)
        } else if coarse > 0 && running + coarse <= 400_000 {
            (coarse, 1)
        } else {
            (boxc, 2)
        };
        running += add;
        tiers[tier] += 1;
    }
    println!(
        "  chunks: {} hull, {} coarse, {} box",
        tiers[0], tiers[1], tiers[2]
    );
    println!("  running total after trees: {}", running);
    let remaining_for_filler = 400_000i64 - running as i64;
    println!(
        "  remaining budget for filler (need {}): {}",
        filler, remaining_for_filler
    );
}
