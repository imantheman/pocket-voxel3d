//! FireRed's sound blob for the card, built on the PC (GPLv3 + additional
//! terms, as src/gen3; only with the `gen3` feature):
//!   cargo run --release --features gen3 --example g3_m4ap -- <audio cache dir> <out.m4ap>
//! The same `build_blob` the 3DS host runs on first boot
//! (pocketvoxel-3ds/src/gen3/audio.rs), from the importer's audio cache
//! (index.lua, samples.bin, samples.lua, voicegroups.lua, songs/*.bin). The
//! card cook (voxelmon/cook/gen3data.ts) writes it as `audio.m4ap` with the
//! key the host checks, so the console never parses index.lua.

use pocketvoxel_core::gen3::build_blob;
use std::path::Path;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: g3_m4ap <audio cache dir> <out.m4ap>");
        std::process::exit(2);
    }
    let dir = Path::new(&args[1]);
    let read = |n: &str| std::fs::read(dir.join(n));
    let index = read("index.lua").unwrap_or_else(|e| panic!("index.lua: {e}"));
    let samples_bin = read("samples.bin").unwrap_or_default();
    let samples_lua = read("samples.lua").ok();
    let vgs_lua = read("voicegroups.lua").ok();
    let mut bins: Vec<(u32, Vec<u8>)> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir.join("songs")) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if let Some(id) = name.strip_suffix(".bin").and_then(|s| s.parse::<u32>().ok()) {
                bins.push((id, std::fs::read(e.path()).unwrap_or_else(|e| panic!("{name}: {e}"))));
            }
        }
    }
    bins.sort_by_key(|b| b.0);
    let refs: Vec<(u32, &[u8])> = bins.iter().map(|(i, b)| (*i, &b[..])).collect();
    let blob = build_blob(&index, samples_lua.as_deref(), vgs_lua.as_deref(), &samples_bin, &refs)
        .unwrap_or_else(|e| panic!("build_blob: {e}"));
    std::fs::write(&args[2], &blob).unwrap_or_else(|e| panic!("{}: {e}", args[2]));
    println!("g3_m4ap: {} songs, {} KB -> {}", refs.len(), blob.len() / 1024, args[2]);
}
