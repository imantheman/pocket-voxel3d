// Throwaway: list a pak's atlas pages, or dump the distinct RGBA texels of
// one page exactly as pocketvoxel-3ds build_page_tex() would write them,
// before and after the dilation pass -- to see what the sampler is actually
// being handed.
//
// usage: page_dump <pak> [page]
use pocketvoxel_core::draw::resolve_pal;
use pocketvoxel_core::pak;
use pocketvoxel_core::spec::COLOR_PAL_NONE;
use std::collections::BTreeMap;
use std::env;
use std::fs;

const KINDS: [&str; 4] = ["terrain", "sprites", "ui", "pics"];

fn dilate_rgb(rgba: &mut [u8], w: u32, h: u32) {
    let src = rgba.to_vec();
    for y in 0..h {
        for x in 0..w {
            let o = ((y * w + x) * 4) as usize;
            if src[o + 0] != 0 {
                continue;
            }
            let (mut r, mut g, mut b, mut n) = (0u32, 0u32, 0u32, 0u32);
            for dy in -1i32..=1 {
                for dx in -1i32..=1 {
                    let (nx, ny) = (x as i32 + dx, y as i32 + dy);
                    if nx < 0 || ny < 0 || nx >= w as i32 || ny >= h as i32 {
                        continue;
                    }
                    let p = ((ny as u32 * w + nx as u32) * 4) as usize;
                    if src[p + 0] == 0 {
                        continue;
                    }
                    r += src[p + 1] as u32;
                    g += src[p + 2] as u32;
                    b += src[p + 3] as u32;
                    n += 1;
                }
            }
            if n == 0 {
                continue;
            }
            rgba[o + 1] = (r / n) as u8;
            rgba[o + 2] = (g / n) as u8;
            rgba[o + 3] = (b / n) as u8;
        }
    }
}

fn main() {
    let a: Vec<String> = env::args().collect();
    let data = fs::read(&a[1]).unwrap();
    let p = pak::read(&data).unwrap();
    if a.len() < 3 {
        println!("{} atlas pages", p.atlases.len());
        for (i, pg) in p.atlases.iter().enumerate() {
            println!(
                "  {i:3} kind {} ({:7}) {:4}x{:<4} frames {}",
                pg.kind,
                KINDS.get(pg.kind as usize).unwrap_or(&"?"),
                pg.w,
                pg.h,
                pg.frames
            );
        }
        return;
    }
    let pidx: u16 = a[2].parse().unwrap();
    let page = p.atlases[pidx as usize];
    let pal_i = resolve_pal(&p, pidx, page.kind, COLOR_PAL_NONE, -1);
    let palv = &p.palettes[pal_i];
    let (aw, ah) = (page.w as u32, page.h as u32);
    println!(
        "page {pidx} kind {} ({}) {aw}x{ah} -> palette {pal_i}",
        page.kind,
        KINDS.get(page.kind as usize).unwrap_or(&"?")
    );

    let lin = pak::unswizzle(aw as usize, ah as usize, page.frame(0)).unwrap();
    let mut idx_hist: BTreeMap<u8, u32> = BTreeMap::new();
    for &v in lin.iter() {
        *idx_hist.entry(v).or_default() += 1;
    }
    println!("  palette indices in use (index -> count, RGBA as uploaded):");
    for (&i, &n) in idx_hist.iter() {
        let c = palv[i as usize];
        println!(
            "    {i:3} x{n:<7} R{:3} G{:3} B{:3} A{:3}",
            (c >> 24) & 0xff,
            (c >> 16) & 0xff,
            (c >> 8) & 0xff,
            c & 0xff
        );
    }

    let mut flat = vec![0u8; (aw * ah * 4) as usize];
    for i in 0..(aw * ah) as usize {
        let c = palv[lin[i] as usize];
        flat[i * 4] = ((c >> 24) & 0xff) as u8;
        flat[i * 4 + 1] = ((c >> 16) & 0xff) as u8;
        flat[i * 4 + 2] = ((c >> 8) & 0xff) as u8;
        flat[i * 4 + 3] = (c & 0xff) as u8;
    }
    let before = flat.clone();
    dilate_rgb(&mut flat, aw, ah);
    let mut changed: BTreeMap<([u8; 4], [u8; 4]), u32> = BTreeMap::new();
    for i in 0..(aw * ah) as usize {
        let (b, f) = (&before[i * 4..i * 4 + 4], &flat[i * 4..i * 4 + 4]);
        if b != f {
            *changed
                .entry((b.try_into().unwrap(), f.try_into().unwrap()))
                .or_default() += 1;
        }
    }
    println!("  texels the dilation rewrote ({} distinct):", changed.len());
    for ((b, f), n) in changed.iter().take(12) {
        println!(
            "    x{n:<7} R{:3} G{:3} B{:3} A{:3}  ->  R{:3} G{:3} B{:3} A{:3}",
            b[0], b[1], b[2], b[3], f[0], f[1], f[2], f[3]
        );
    }
}
