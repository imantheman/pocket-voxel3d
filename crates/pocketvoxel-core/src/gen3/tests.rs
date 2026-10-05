// Port of gen1recomp src/core/game3/m4a_player.lua (GPLv3 + additional terms; see crates/pocketvoxel-core/src/gen3/LICENSE.md).

//! The M4A port against gen1recomp's Lua: `tools/gen3/m4a_oracle.sh`
//! renders reference PCM with luajit into `~/gen3ref/m4a_oracle/<rate>/`
//! from the reference cache `~/gen3ref/frfull`; these tests build the
//! `M4AP` blob from that cache, render the same things and compare sample
//! by sample. Absent cache/oracle = the tests pass vacuously (printing
//! why). `cargo test --features gen3 gen3 -- --nocapture` shows the stats.

extern crate std;

use std::format;
use std::path::PathBuf;
use std::println;
use std::string::String;
use std::sync::OnceLock;
use std::vec::Vec;

use super::engine::{self, CryParams, M4a, SeOptions, raw};
use super::pack::{AudioPack, build_blob};

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default())
}

fn cache_dir() -> PathBuf {
    match std::env::var("M4A_CACHE") {
        Ok(p) => PathBuf::from(p),
        Err(_) => home().join("gen3ref/frfull"),
    }
    .join("data/generated/gba/audio")
}

fn oracle_dir(rate: u32) -> PathBuf {
    match std::env::var("M4A_ORACLE") {
        Ok(p) => PathBuf::from(p),
        Err(_) => home().join("gen3ref/m4a_oracle"),
    }
    .join(format!("{}", rate))
}

fn build_pack_blob() -> Option<Vec<u8>> {
    let dir = cache_dir();
    let index = std::fs::read(dir.join("index.lua")).ok()?;
    let samples_bin = std::fs::read(dir.join("samples.bin")).unwrap_or_default();
    let samples_lua = std::fs::read(dir.join("samples.lua")).ok();
    let vgs_lua = std::fs::read(dir.join("voicegroups.lua")).ok();
    let mut bins: Vec<(u32, Vec<u8>)> = Vec::new();
    for e in std::fs::read_dir(dir.join("songs")).ok()?.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if let Some(id) = name
            .strip_suffix(".bin")
            .and_then(|s| s.parse::<u32>().ok())
        {
            bins.push((id, std::fs::read(e.path()).ok()?));
        }
    }
    bins.sort_by_key(|b| b.0);
    let refs: Vec<(u32, &[u8])> = bins.iter().map(|(i, b)| (*i, &b[..])).collect();
    Some(
        build_blob(
            &index,
            samples_lua.as_deref(),
            vgs_lua.as_deref(),
            &samples_bin,
            &refs,
        )
        .expect("build_blob"),
    )
}

fn blob() -> Option<&'static Vec<u8>> {
    static BLOB: OnceLock<Option<Vec<u8>>> = OnceLock::new();
    BLOB.get_or_init(build_pack_blob).as_ref()
}

fn pack() -> Option<&'static AudioPack> {
    static PACK: OnceLock<Option<AudioPack>> = OnceLock::new();
    PACK.get_or_init(|| blob().map(|b| AudioPack::from_blob(b.clone()).expect("from_blob")))
        .as_ref()
}

fn read_f64(path: &PathBuf) -> Vec<f64> {
    let b = std::fs::read(path).unwrap_or_else(|e| panic!("{}: {}", path.display(), e));
    b.chunks_exact(8)
        .map(|c| f64::from_le_bytes(c.try_into().unwrap()))
        .collect()
}

/// Per-sample comparison of an interleaved oracle with (L, R).
struct Stats {
    n: usize,
    differing: usize,
    max_abs: f64,
    sum_sq: f64,
}

fn compare(exp: &[f64], l: &[f64], r: &[f64]) -> Stats {
    let mut s = Stats {
        n: exp.len() / 2,
        differing: 0,
        max_abs: 0.0,
        sum_sq: 0.0,
    };
    for i in 0..s.n.min(l.len()) {
        for (e, g) in [(exp[i * 2], l[i]), (exp[i * 2 + 1], r[i])] {
            let d = (e - g).abs();
            if d != 0.0 {
                s.differing += 1;
            }
            s.max_abs = s.max_abs.max(d);
            s.sum_sq += d * d;
        }
    }
    s
}

/// Lua doubles vs Rust f64 doing the same operations in the same order:
/// bit-identical on desktop. The tolerance only absorbs a libm whose
/// exp/pow differ from glibc's in the last ulp (HPF charge, cry rate).
const TOL: f64 = 1e-9;

fn check(name: &str, exp: &[f64], l: &[f64], r: &[f64]) -> Result<(), String> {
    if exp.len() / 2 != l.len() {
        return Err(format!(
            "{}: sample count {} vs oracle {}",
            name,
            l.len(),
            exp.len() / 2
        ));
    }
    let s = compare(exp, l, r);
    let rms = if s.n > 0 {
        (s.sum_sq / (2 * s.n) as f64).sqrt()
    } else {
        0.0
    };
    println!(
        "  {:<22} n={:>7}  differing={:>7}  max|d|={:.3e}  rms={:.3e}",
        name, s.n, s.differing, s.max_abs, rms
    );
    if s.max_abs > TOL {
        return Err(format!("{}: max |d| {:e} > {:e}", name, s.max_abs, TOL));
    }
    Ok(())
}

fn manifest(rate: u32) -> Option<Vec<Vec<String>>> {
    let txt = std::fs::read_to_string(oracle_dir(rate).join("manifest.txt")).ok()?;
    Some(
        txt.lines()
            .map(|l| l.split_whitespace().map(String::from).collect())
            .collect(),
    )
}

fn run_oracle(rate: u32) {
    let (Some(pack), Some(lines)) = (pack(), manifest(rate)) else {
        println!(
            "gen3 m4a oracle @{}: cache or oracle absent (run tools/gen3/m4a_oracle.sh) — skipped",
            rate
        );
        return;
    };
    println!("gen3 m4a oracle @{} Hz:", rate);
    let dir = oracle_dir(rate);
    let mut errors = Vec::new();
    for f in &lines {
        let num = |i: usize| f[i].parse::<f64>().unwrap();
        let res = match f[0].as_str() {
            "bgm" => {
                let id = num(1) as u16;
                let exp = read_f64(&dir.join(format!("bgm_{}.f64", id)));
                let (l, r) = raw::bgm(pack, id, rate, num(2) as usize);
                check(&format!("bgm {}", id), &exp, &l, &r)
            }
            "se" => {
                let id = num(1) as u16;
                let exp = read_f64(&dir.join(format!("se_{}.f64", id)));
                let (l, r, ls, looping) =
                    raw::se(pack, id, rate, SeOptions::default()).expect("se");
                let want_ls = num(3);
                let got_ls = ls.map_or(-1.0, |v| v as f64);
                if got_ls != want_ls || looping != (num(4) == 1.0) {
                    Err(format!(
                        "se {}: loopStart/loop {}/{} vs oracle {}/{}",
                        id, got_ls, looping, want_ls, f[4]
                    ))
                } else {
                    check(&format!("se {}", id), &exp, &l, &r)
                }
            }
            "fanfare" => {
                let id = num(1) as u16;
                let exp = read_f64(&dir.join(format!("fanfare_{}.f64", id)));
                let (l, r) = raw::fanfare(pack, id, rate).expect("fanfare");
                check(&format!("fanfare {}", id), &exp, &l, &r)
            }
            "cry" => {
                let (sp, mode) = (num(1) as u16, num(2) as i32);
                let exp = read_f64(&dir.join(format!("cry_{}_{}.f64", sp, mode)));
                let (out, frames) =
                    raw::cry(pack, sp, &CryParams::from_mode(mode, None), rate).expect("cry");
                if frames != num(4) {
                    Err(format!(
                        "cry {} {}: frames {} vs oracle {}",
                        sp, mode, frames, f[4]
                    ))
                } else {
                    check(&format!("cry {} mode {}", sp, mode), &exp, &out, &out)
                }
            }
            k => Err(format!("unknown manifest kind {}", k)),
        };
        if let Err(e) = res {
            errors.push(e);
        }
    }
    assert!(errors.is_empty(), "{:#?}", errors);
}

#[test]
fn gen3_m4a_oracle_44100() {
    run_oracle(44100);
}

#[test]
fn gen3_m4a_oracle_22050() {
    run_oracle(22050);
}

/// FNV-1a over the doubles' 32-bit words, as the oracle's `fnv`.
fn fnv(l: &[f64], r: &[f64]) -> String {
    let mut h: u32 = 2166136261;
    for i in 0..l.len() {
        for x in [l[i], r[i]] {
            let b = x.to_bits();
            for w in [b as u32, (b >> 32) as u32] {
                h ^= w;
                h = h.wrapping_mul(16777619);
            }
        }
    }
    format!("{:08x}", h)
}

/// Every song (2 s as BGM), every SE's bake and every cry, by hash.
#[test]
fn gen3_m4a_sweep_22050() {
    let rate = 22050;
    let path = oracle_dir(rate)
        .with_file_name("sweep22050")
        .join("sweep.txt");
    let (Some(pack), Ok(txt)) = (pack(), std::fs::read_to_string(&path)) else {
        println!(
            "gen3 m4a sweep: cache or {} absent — skipped",
            path.display()
        );
        return;
    };
    let mut errors = Vec::new();
    let (mut nb, mut ns, mut nc) = (0, 0, 0);
    for line in txt.lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        let num = |i: usize| f[i].parse::<f64>().unwrap();
        match f[0] {
            "hbgm" => {
                let (l, r) = raw::bgm(pack, num(1) as u16, rate, num(2) as usize);
                if fnv(&l, &r) != f[3] {
                    errors.push(format!("bgm {}", f[1]));
                }
                nb += 1;
            }
            "hse" => {
                let (l, r, ls, looping) =
                    raw::se(pack, num(1) as u16, rate, SeOptions::default()).expect("se");
                let meta_ok = l.len() == num(2) as usize
                    && ls.map_or(-1.0, |v| v as f64) == num(3)
                    && looping == (num(4) == 1.0);
                if !meta_ok || fnv(&l, &r) != f[5] {
                    errors.push(format!("se {}", f[1]));
                }
                ns += 1;
            }
            "hcry" => {
                let (out, frames) =
                    raw::cry(pack, num(1) as u16, &CryParams::from_mode(0, None), rate)
                        .expect("cry");
                if out.len() != num(2) as usize || frames != num(3) || fnv(&out, &out) != f[4] {
                    errors.push(format!("cry {}", f[1]));
                }
                nc += 1;
            }
            _ => {}
        }
    }
    println!(
        "gen3 m4a sweep @{} Hz: {} songs, {} SE bakes, {} cries; {} mismatches",
        rate,
        nb,
        ns,
        nc,
        errors.len()
    );
    assert!(errors.is_empty(), "{:?}", errors);
}

/// `trunc(clip(x) * 32767)`, the SoundData a single player fills.
fn q(x: f64) -> i16 {
    (x.clamp(-1.0, 1.0) * 32767.0) as i32 as i16
}

fn engine_render(e: &mut M4a, frames: usize) -> Vec<i16> {
    let mut out = std::vec![0i16; frames * 2];
    // Odd callback sizes, as a host's would be.
    let mut at = 0;
    let mut k = 0;
    while at < frames {
        let n = [441usize, 1024, 37, 4096][k % 4].min(frames - at);
        e.render(&mut out[at * 2..(at + n) * 2]);
        at += n;
        k += 1;
    }
    out
}

fn first_mismatch(name: &str, want: &[i16], got: &[i16]) -> Result<(), String> {
    match want.iter().zip(got).position(|(a, b)| a != b) {
        None => {
            println!("  {:<22} {} frames identical (s16)", name, want.len() / 2);
            Ok(())
        }
        Some(i) => Err(format!(
            "{}: s16 mismatch at {} ({} vs {})",
            name, i, got[i], want[i]
        )),
    }
}

/// The engine end to end (lazy bakes, BGM blocks, loops, callback-sized
/// renders) against the oracle quantised the way one LÖVE SoundData is.
#[test]
fn gen3_m4a_engine_44100() {
    let rate = 44100;
    let (Some(_), Some(lines)) = (pack(), manifest(rate)) else {
        println!("gen3 m4a engine: cache or oracle absent — skipped");
        return;
    };
    let dir = oracle_dir(rate);
    let fresh = || M4a::new(AudioPack::from_blob(blob().unwrap().clone()).unwrap(), rate);
    let mut errors = Vec::new();
    println!("gen3 m4a engine @{} Hz:", rate);

    // BGM: MUS_PALLET, and MUS_LEVEL_UP (which ends: "ended" blocks).
    for id in [300u16, 257] {
        let exp = read_f64(&dir.join(format!("bgm_{}.f64", id)));
        let n = exp.len() / 2;
        let mut e = fresh();
        assert!(e.play_song(id));
        let got = engine_render(&mut e, n);
        let want: Vec<i16> = exp.iter().map(|&x| q(x)).collect();
        if let Err(m) = first_mismatch(&format!("engine bgm {}", id), &want, &got) {
            errors.push(m);
        }
    }

    // SEs, including the loop-body SE 43 (intro + repeating body) and the
    // cut loop 83 (whole bake loops), rendered for 1.6x their bake.
    for f in lines.iter().filter(|f| f[0] == "se") {
        let id: u16 = f[1].parse().unwrap();
        let exp = read_f64(&dir.join(format!("se_{}.f64", id)));
        let n = exp.len() / 2;
        let ls: i64 = f[3].parse().unwrap();
        let looping = f[4] == "1";
        let total = n + n * 3 / 5;
        let mut want = Vec::with_capacity(total * 2);
        for i in 0..total {
            let j = if i < n {
                Some(i)
            } else if looping {
                let start = if ls > 0 && (ls as usize) < n {
                    ls as usize
                } else {
                    0
                };
                Some(start + (i - n) % (n - start))
            } else {
                None
            };
            match j {
                Some(j) => {
                    want.push(q(exp[j * 2]));
                    want.push(q(exp[j * 2 + 1]));
                }
                None => {
                    want.push(0);
                    want.push(0);
                }
            }
        }
        let mut e = fresh();
        assert!(e.play_se(id, SeOptions::default()));
        let got = engine_render(&mut e, total);
        if let Err(m) = first_mismatch(&format!("engine se {}", id), &want, &got) {
            errors.push(m);
        }
        if e.se_playing(Some(id)) != looping {
            errors.push(format!(
                "engine se {}: playing={} after its bake",
                id, !looping
            ));
        }
    }

    // Fanfare at volume 1, cry mono and panned.
    {
        let exp = read_f64(&dir.join("fanfare_257.f64"));
        let mut e = fresh();
        assert!(e.play_fanfare(257, 1.0));
        let got = engine_render(&mut e, exp.len() / 2 + 100);
        let mut want: Vec<i16> = exp.iter().map(|&x| q(x)).collect();
        want.resize(got.len(), 0);
        if let Err(m) = first_mismatch("engine fanfare 257", &want, &got) {
            errors.push(m);
        }
        if e.fanfare_playing() {
            errors.push(String::from("fanfare still playing after its bake"));
        }
    }
    for pan in [0.0f64, -40.0] {
        let exp = read_f64(&dir.join("cry_25_2.f64"));
        let mut e = fresh();
        let frames = e
            .play_cry(25, &CryParams::from_mode(2, None), pan, 1.0)
            .unwrap();
        assert_eq!(frames, 45.0);
        let got = engine_render(&mut e, exp.len() / 2);
        let (gl, gr) = if pan != 0.0 {
            ((127.0 - pan) / 191.0, (128.0 + pan) / 191.0)
        } else {
            (1.0, 1.0)
        };
        let want: Vec<i16> = (0..exp.len() / 2)
            .flat_map(|i| [q(exp[i * 2] * gl), q(exp[i * 2] * gr)])
            .collect();
        if let Err(m) = first_mismatch(&format!("engine cry 25 pan {}", pan), &want, &got) {
            errors.push(m);
        }
        if e.cry_playing() {
            errors.push(String::from("cry still playing after its end"));
        }
    }
    assert!(errors.is_empty(), "{:#?}", errors);
}

/// Blob round trip details that do not need the reference cache.
#[test]
fn gen3_m4a_blob_minimal() {
    let index = br#"return {
  ["songs"] = { [0] = { ["voicegroupId"] = 1, ["reverb"] = 128, ["player"] = 1, ["hasGoto"] = false } },
  ["samples"] = { [1] = { ["offset"] = 0, ["size"] = 4, ["freq"] = 13700096, ["loopStart"] = 0, ["status"] = 0 } },
  ["voicegroups"] = { [1] = { [0] = { ["type"] = 0, ["key"] = 60, ["sampleId"] = 1, ["attack"] = 255,
      ["decay"] = 0, ["sustain"] = 255, ["release"] = 0, ["pan"] = 0, ["length"] = 0 },
    [1] = { ["type"] = 3, ["wave"] = { 1, 2, 3 }, ["keySplit"] = { [0] = 7, [127] = 9 } } } },
  ["cries"] = { [0] = { ["sampleId"] = 1 } },
  ["cryIds"] = { [1] = 0 },
}"#;
    // song 0: one track: VOICE 0, N08 Cn3 v127, W24, FINE
    let song: &[u8] = &[
        1, 0x80, 0, 128, 1, 0, 0, 0, 20, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0, 0xBD, 0, 0xD6, 60, 127,
        0x98, 0xB1,
    ];
    let blob = build_blob(index, None, None, &[0, 64, 0x80, 0xC0], &[(0, song)]).unwrap();
    let p = AudioPack::from_blob(blob).unwrap();
    let info = p.song_info(0.0).unwrap();
    assert_eq!(info.voicegroup_id, Some(1.0));
    assert_eq!(info.has_goto, Some(false));
    assert_eq!(info.sample_id, None);
    let vg = p.voicegroup(1.0).unwrap();
    let t1 = vg[1].unwrap();
    assert_eq!(p.wave(&t1).unwrap(), &[1, 2, 3]);
    assert_eq!(p.key_split(&t1, 127.0), Some(9.0));
    assert_eq!(p.key_split(&t1, 5.0), Some(0.0));
    assert_eq!(t1.attack, None);
    assert_eq!(p.cry_id(1.0), Some(0.0));
    assert_eq!(p.cry_sample_id(0.0), Some(1.0));
    let mut e = M4a::new(p, 22050);
    assert!(e.play_song(0));
    let mut out = std::vec![0i16; 2048];
    e.render(&mut out);
    assert!(out.iter().any(|&s| s != 0));
    assert_eq!(engine::normalize_pan(99.0), 63.0);
}

/// Boot and render cost on the desktop (the 3DS host's budget estimate):
/// `cargo test --release --features gen3 gen3_m4a_bench -- --ignored --nocapture`.
#[test]
#[ignore]
fn gen3_m4a_bench() {
    let t = std::time::Instant::now();
    let Some(b) = build_pack_blob() else {
        println!("no reference cache");
        return;
    };
    println!("build_blob (read + parse + build): {:.1} ms, {} KB", t.elapsed().as_secs_f64() * 1e3, b.len() / 1024);
    let dir = cache_dir();
    let index = std::fs::read(dir.join("index.lua")).unwrap();
    let t = std::time::Instant::now();
    let _ = super::lualit::parse(&index).unwrap();
    println!("  of which lualit::parse(index.lua, {} KB): {:.1} ms", index.len() / 1024, t.elapsed().as_secs_f64() * 1e3);
    let t = std::time::Instant::now();
    let p = AudioPack::from_blob(b.clone()).unwrap();
    println!("from_blob: {:.1} ms", t.elapsed().as_secs_f64() * 1e3);
    let mut e = M4a::new(p, 22050);
    let mut out = std::vec![0i16; 368 * 2];
    for song in [300u16, 296, 298, 299, 278] {
        let t0 = std::time::Instant::now();
        if !e.play_song(song) { println!("song {} missing", song); continue; }
        println!("  play_song {}: {:.3} ms", song, t0.elapsed().as_secs_f64() * 1e3);
        let t = std::time::Instant::now();
        let mut worst = 0f64;
        for tick in 0..600 {
            let t1 = std::time::Instant::now();
            if tick % 120 == 10 { e.play_se(5, SeOptions::default()); }
            if tick % 200 == 20 { e.play_cry(25, &CryParams::from_mode(0, None), 0.0, 1.0); }
            let tc = t1.elapsed().as_secs_f64();
            if tc > 0.0002 { println!("  tick {}: calls {:.3} ms", tick, tc * 1e3); }
            e.render(&mut out);
            worst = worst.max(t1.elapsed().as_secs_f64());
        }
        println!("song {}: 10 s rendered in {:.1} ms ({:.3} ms/tick avg, {:.3} worst)", song,
            t.elapsed().as_secs_f64() * 1e3, t.elapsed().as_secs_f64() * 1e3 / 600.0, worst * 1e3);
    }
}

/// A 3DS capture (the FireRed host built with PV_G3_AUDIO_DUMP; the test
/// card starts song 300 at volume 1) against the same song rendered here:
/// `M4A_DUMP=/tmp/g3audio_dump.wav cargo test --release --features gen3
/// gen3_m4a_3ds_dump -- --ignored --nocapture`.
#[test]
#[ignore]
fn gen3_m4a_3ds_dump() {
    let Ok(path) = std::env::var("M4A_DUMP") else { return };
    let Some(b) = blob() else { return };
    let w = std::fs::read(&path).unwrap();
    let got: Vec<i16> = w[44..].chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]])).collect();
    let mut e = M4a::new(AudioPack::from_blob(b.clone()).unwrap(), 22050);
    e.set_song_volume(1.0);
    e.play_song(300);
    let mut exp: Vec<i16> = Vec::new();
    let mut started = false;
    let mut buf = std::vec![0i16; 368 * 2];
    while exp.len() < got.len() {
        e.render(&mut buf);
        if !started && buf.iter().all(|&s| s == 0) { continue; }
        started = true;
        exp.extend_from_slice(&buf);
    }
    let n = got.len() / 2;
    let first = (0..got.len()).find(|&i| got[i] != exp[i]).map(|i| i / 2);
    let mut max = 0i32;
    let lim = first.unwrap_or(n).max(1);
    for i in 0..(lim * 2).min(got.len()) { max = max.max((got[i] as i32 - exp[i] as i32).abs()); }
    println!("3DS dump {} frames ({:.2} s); identical to the desktop render for the first {} frames ({:.3} s)",
        n, n as f64 / 22050.0, first.unwrap_or(n), first.unwrap_or(n) as f64 / 22050.0);
    // after the first difference (the test card's first SE), how far apart
    if let Some(f) = first {
        let mut m = 0i32;
        for i in f * 2..(f * 2 + 2000).min(got.len()) { m = m.max((got[i] as i32 - exp[i] as i32).abs()); }
        println!("  first difference at frame {} ({:.3} s): max |d| over the next 1000 frames {}", f, f as f64 / 22050.0, m);
    }
}
