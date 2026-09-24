// Throwaway diagnostic: why does a raised floor not lift what stands on it?
//
// pocketvoxel-3ds floor_map_of() builds the per-cell floor from the highest
// UP-FACING triangle of the TERRAIN mesh alone. Two things about that could
// be wrong, and this says which:
//
//   1. "up-facing" is decided by the winding of the cross product, and
//      cook/geom.ts states the cooked streams do not share one winding.
//   2. the ground may not be in the TERRAIN mesh at all -- ground_bake and
//      terrain_keep are their own kinds.
//
// So: per mesh kind, how many triangles are horizontal, and of those how many
// the winding calls up. Then the floor map under each rule, and how they
// differ.
use pocketvoxel_core::pak;
use std::env;
use std::fs;

const NAMES: [&str; 9] = [
    "terrain", "ground_bake", "terrain_keep", "tree_hull", "tree_coarse", "tree_box", "water",
    "grass", "flower",
];

fn main() {
    let args: Vec<String> = env::args().collect();
    let path = &args[1];
    let map_id: u32 = args[2].parse().unwrap();
    let data = fs::read(path).unwrap();
    // the paks point at common.vxat for every shared atlas page
    let dir = std::path::Path::new(path).parent().unwrap().to_path_buf();
    let shared = fs::read(dir.join("common.vxat")).ok();
    let p = pak::read_with_shared(&data, shared.as_deref()).unwrap();
    let map = p.maps.iter().find(|m| m.map_id == map_id).expect("map not found");
    let chunks = &p.chunks[map.first as usize..(map.first + map.count) as usize];
    println!("map_id {} chunks {}", map_id, chunks.len());

    let vert = |vbase: usize, at: usize| -> Option<pak::PakVert> {
        let idx = *p.indices.get(at)? as usize;
        p.verts.get(vbase + idx).copied()
    };

    // per kind: triangles, horizontal, up-by-winding, and the max top seen
    for kind in 0..9usize {
        let (mut tris, mut horiz, mut up, mut top_max) = (0u64, 0u64, 0u64, i16::MIN);
        for c in chunks {
            let m = c.meshes[kind];
            let vbase = m.vert_base as usize;
            for t in 0..(m.index_count as usize / 3) {
                let b = m.index_base as usize + t * 3;
                let (Some(p0), Some(p1), Some(p2)) = (vert(vbase, b), vert(vbase, b + 1), vert(vbase, b + 2))
                else {
                    break;
                };
                tris += 1;
                let (ax, ay, az) = ((p1.x - p0.x) as f32, (p1.y - p0.y) as f32, (p1.z - p0.z) as f32);
                let (bx, by, bz) = ((p2.x - p0.x) as f32, (p2.y - p0.y) as f32, (p2.z - p0.z) as f32);
                let ny = az * bx - ax * bz;
                let nx = ay * bz - az * by;
                let nz = ax * by - ay * bx;
                let flat = ny.abs() >= nx.abs() && ny.abs() >= nz.abs() && ny != 0.0;
                if flat {
                    horiz += 1;
                    let top = p0.y.max(p1.y).max(p2.y);
                    if top > top_max {
                        top_max = top;
                    }
                    if ny > 0.0 {
                        up += 1;
                    }
                }
            }
        }
        if tris > 0 {
            println!(
                "  kind {} {:>13}: {:>7} tris  {:>7} horizontal  {:>7} up-by-winding  topmax {}",
                kind, NAMES[kind], tris, horiz, up, top_max
            );
        }
    }

    // the floor map, built the shipped way (terrain + up-only) and the
    // winding-blind way over the ground kinds, and where they disagree
    let cell = pocketvoxel_core::spec::CELL_PX as f32;
    let build = |kinds: &[usize], up_only: bool| -> std::collections::HashMap<(i32, i32), i16> {
        let mut out = std::collections::HashMap::new();
        let mut passed = 0u64;
        for c in chunks {
            for &kind in kinds {
                let m = c.meshes[kind];
                let vbase = m.vert_base as usize;
                for t in 0..(m.index_count as usize / 3) {
                    let b = m.index_base as usize + t * 3;
                    let (Some(p0), Some(p1), Some(p2)) =
                        (vert(vbase, b), vert(vbase, b + 1), vert(vbase, b + 2))
                    else {
                        break;
                    };
                    let (ax, ay, az) =
                        ((p1.x - p0.x) as f32, (p1.y - p0.y) as f32, (p1.z - p0.z) as f32);
                    let (bx, by, bz) =
                        ((p2.x - p0.x) as f32, (p2.y - p0.y) as f32, (p2.z - p0.z) as f32);
                    let ny = az * bx - ax * bz;
                    let nx = ay * bz - az * by;
                    let nz = ax * by - ay * bx;
                    if up_only {
                        if ny <= 0.0 || ny.abs() < nx.abs() || ny.abs() < nz.abs() {
                            continue;
                        }
                    } else if ny == 0.0 || ny.abs() < nx.abs() || ny.abs() < nz.abs() {
                        continue;
                    }
                    passed += 1;
                    let top = p0.y.max(p1.y).max(p2.y);
                    let (lo_x, hi_x) = (p0.x.min(p1.x).min(p2.x), p0.x.max(p1.x).max(p2.x));
                    let (lo_z, hi_z) = (p0.z.min(p1.z).min(p2.z), p0.z.max(p1.z).max(p2.z));
                    let cx0 = ((lo_x as f32 - cell / 2.0) / cell).ceil() as i32;
                    let cx1 = ((hi_x as f32 - cell / 2.0) / cell).floor() as i32;
                    let cz0 = ((lo_z as f32 - cell / 2.0) / cell).ceil() as i32;
                    let cz1 = ((hi_z as f32 - cell / 2.0) / cell).floor() as i32;
                    for cz in cz0..=cz1 {
                        for cx in cx0..=cx1 {
                            let e = out.entry((cx, cz)).or_insert(0i16);
                            if top > *e {
                                *e = top;
                            }
                        }
                    }
                }
            }
        }
        eprintln!("    (rule kinds={:?} up_only={} passed {} tris)", kinds, up_only, passed);
        out
    };

    // the same sweep, but keeping the LOWEST horizontal surface in a cell
    let build_min = |kinds: &[usize]| -> std::collections::HashMap<(i32, i32), i16> {
        let mut out: std::collections::HashMap<(i32, i32), i16> = std::collections::HashMap::new();
        for c in chunks {
            for &kind in kinds {
                let m = c.meshes[kind];
                let vbase = m.vert_base as usize;
                for t in 0..(m.index_count as usize / 3) {
                    let b = m.index_base as usize + t * 3;
                    let (Some(p0), Some(p1), Some(p2)) =
                        (vert(vbase, b), vert(vbase, b + 1), vert(vbase, b + 2))
                    else { break; };
                    let (ax, ay, az) = ((p1.x - p0.x) as f32, (p1.y - p0.y) as f32, (p1.z - p0.z) as f32);
                    let (bx, by, bz) = ((p2.x - p0.x) as f32, (p2.y - p0.y) as f32, (p2.z - p0.z) as f32);
                    let ny = az * bx - ax * bz;
                    let nx = ay * bz - az * by;
                    let nz = ax * by - ay * bx;
                    if ny == 0.0 || ny.abs() < nx.abs() || ny.abs() < nz.abs() { continue; }
                    let top = p0.y.max(p1.y).max(p2.y);
                    let (lo_x, hi_x) = (p0.x.min(p1.x).min(p2.x), p0.x.max(p1.x).max(p2.x));
                    let (lo_z, hi_z) = (p0.z.min(p1.z).min(p2.z), p0.z.max(p1.z).max(p2.z));
                    let cx0 = ((lo_x as f32 - cell / 2.0) / cell).ceil() as i32;
                    let cx1 = ((hi_x as f32 - cell / 2.0) / cell).floor() as i32;
                    let cz0 = ((lo_z as f32 - cell / 2.0) / cell).ceil() as i32;
                    let cz1 = ((hi_z as f32 - cell / 2.0) / cell).floor() as i32;
                    for cz in cz0..=cz1 {
                        for cx in cx0..=cx1 {
                            out.entry((cx, cz)).and_modify(|e| { if top < *e { *e = top; } }).or_insert(top);
                        }
                    }
                }
            }
        }
        out
    };

    let shipped = build(&[0], true);
    let blind_terrain = build(&[0], false);
    let all_ground = build(&[0, 1, 2], false);
    let bake_only = build(&[1], false);
    let bake_keep = build(&[1, 2], false);

    let hist = |name: &str, m: &std::collections::HashMap<(i32, i32), i16>| {
        let mut counts: std::collections::BTreeMap<i16, usize> = Default::default();
        for v in m.values() {
            *counts.entry(*v).or_insert(0) += 1;
        }
        println!("  {:<28} cells {:>5}  heights {:?}", name, m.len(), counts);
    };
    println!("floor maps:");
    hist("shipped (terrain, up only)", &shipped);
    hist("terrain, winding-blind", &blind_terrain);
    hist("terrain+bake+keep, blind", &all_ground);
    hist("ground_bake ONLY, blind", &bake_only);
    hist("bake+keep, blind", &bake_keep);
    let min_terrain = build_min(&[0, 2]);
    hist("terrain+keep, MIN", &min_terrain);

    // ground_bake is the baked ground surface itself: the answer key. How
    // well does each candidate agree with it, cell for cell?
    let agree = |name: &str, m: &std::collections::HashMap<(i32, i32), i16>| {
        let (mut same, mut diff, mut only) = (0, 0, 0);
        for (k, want) in &bake_only {
            match m.get(k) {
                Some(got) if got == want => same += 1,
                Some(_) => diff += 1,
                None => only += 1,
            }
        }
        // which way, and by how much, for the ones that differ
        let mut over: std::collections::BTreeMap<i16, usize> = Default::default();
        let mut under: std::collections::BTreeMap<i16, usize> = Default::default();
        for (k, want) in &bake_only {
            if let Some(got) = m.get(k) {
                if got > want { *over.entry(got - want).or_insert(0) += 1; }
                else if got < want { *under.entry(want - got).or_insert(0) += 1; }
            }
        }
        println!("  {:<26} agrees {:>5}  differs {:>5}  missing {:>5}", name, same, diff, only);
        if !over.is_empty() || !under.is_empty() {
            println!("      too HIGH by {:?}   too LOW by {:?}", over, under);
        }
    };
    println!("against ground_bake (the baked ground itself):");
    agree("terrain+keep MAX", &all_ground);
    agree("terrain+keep MIN", &min_terrain);
    agree("terrain MAX", &blind_terrain);

    let mut lifted = 0;
    for (k, v) in &all_ground {
        if *v > *shipped.get(k).unwrap_or(&0) {
            lifted += 1;
        }
    }
    println!("cells the shipped rule reads LOWER than the blind one: {}", lifted);
}
