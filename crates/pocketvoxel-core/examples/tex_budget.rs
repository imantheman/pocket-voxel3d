// Throwaway: what would point-replicating pages by an integer factor cost?
//
// pocketvoxel-3ds pre-warms every UI and SPRITES page of a map up front, and
// uploads live in the 24 MB linear heap alongside the terrain vertex buffers,
// so the total matters.
//
// usage: tex_budget <pak> [scale]
use pocketvoxel_core::pak;
use pocketvoxel_core::spec::atlas_kind;
use std::env;
use std::fs;

fn po2(n: u32) -> u32 {
    let mut p = 8u32;
    while p < n {
        p <<= 1;
    }
    p
}

fn main() {
    let a: Vec<String> = env::args().collect();
    let data = fs::read(&a[1]).unwrap();
    let p = pak::read(&data).unwrap();
    let scale: u32 = a.get(2).and_then(|v| v.parse().ok()).unwrap_or(2);

    let mut rows: Vec<(&str, u32, u64, u64)> = Vec::new();
    for (name, kind) in [
        ("ui (pre-warmed)", atlas_kind::UI),
        ("sprites (pre-warmed)", atlas_kind::SPRITES),
        ("pics (on demand)", atlas_kind::PICS),
    ] {
        let pages: Vec<_> = p.atlases.iter().filter(|q| q.kind == kind).collect();
        let now: u64 = pages
            .iter()
            .map(|q| (po2(q.w as u32) * po2(q.h as u32) * 4) as u64)
            .sum();
        let scaled: u64 = pages
            .iter()
            .map(|q| {
                (po2(q.w as u32 * scale) * po2(q.h as u32 * scale) * 4) as u64
            })
            .sum();
        rows.push((name, pages.len() as u32, now, scaled));
    }
    println!("{}  (x{scale} point-replicate)", a[1]);
    println!("{:<22} {:>5} {:>12} {:>12} {:>10}", "kind", "pages", "now", "scaled", "delta");
    for (name, n, now, scaled) in &rows {
        println!(
            "{name:<22} {n:>5} {:>10.2} MB {:>10.2} MB {:>+8.2} MB",
            *now as f64 / 1e6,
            *scaled as f64 / 1e6,
            (*scaled as f64 - *now as f64) / 1e6
        );
    }
    let warm_now: u64 = rows[0].2 + rows[1].2;
    let warm_new: u64 = rows[0].3 + rows[1].3;
    println!(
        "\npre-warmed at map load: {:.2} MB -> {:.2} MB ({:+.2} MB) of a 24 MB linear heap",
        warm_now as f64 / 1e6,
        warm_new as f64 / 1e6,
        (warm_new as f64 - warm_now as f64) / 1e6
    );
}
