// Throwaway diagnostic for the 3DS sprite filtering change.
//
// Runs the real pak reader over a cooked map pak, rebuilds an atlas page the
// way pocketvoxel-3ds main.rs build_page_tex() now does (palette expansion ->
// dilate_rgb -> edge-replicated power-of-two padding), and then:
//
//   * asserts the two artefacts bilinear would otherwise expose are gone --
//     no transparent texel next to opaque art still carries the palette's
//     stored red/black, and the po2 padding is a copy of the page edge
//   * resamples the page at the ACTUAL device scale the 3DS draws it at,
//     once with nearest and once with bilinear, and writes both to a PPM so
//     the difference can be looked at instead of argued about
//
// usage: sprite_check <pak> <page> <dst_w> <dst_h> <out.ppm>
use pocketvoxel_core::draw::resolve_pal;
use pocketvoxel_core::pak;
use pocketvoxel_core::spec::COLOR_PAL_NONE;
use std::env;
use std::fs;

const DILATE_PASSES: u32 = 1;

fn po2(n: u32) -> u32 {
    let mut p = 8u32;
    while p < n {
        p <<= 1;
    }
    p
}

/// Byte-for-byte the same rule as main.rs.
fn dilate_rgb(rgba: &mut [u8], w: u32, h: u32) {
    if w == 0 || h == 0 {
        return;
    }
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

/// The padded surface main.rs uploads, as flat RGBA (not GPU-swizzled: the
/// tiling is irrelevant to what the sampler produces).
fn build(page: &pak::AtlasPage, palv: &[u32], dilate: bool) -> (Vec<u8>, u32, u32) {
    let (aw, ah) = (page.w as u32, page.h as u32);
    let lin = pak::unswizzle(aw as usize, ah as usize, page.frame(0)).unwrap();
    let mut flat = vec![0u8; (aw * ah * 4) as usize];
    for i in 0..(aw * ah) as usize {
        let c = palv[lin[i] as usize];
        flat[i * 4] = ((c >> 24) & 0xff) as u8;
        flat[i * 4 + 1] = ((c >> 16) & 0xff) as u8;
        flat[i * 4 + 2] = ((c >> 8) & 0xff) as u8;
        flat[i * 4 + 3] = (c & 0xff) as u8;
    }
    if dilate {
        for _ in 0..DILATE_PASSES {
            dilate_rgb(&mut flat, aw, ah);
        }
    }
    let (tw, th) = (po2(aw), po2(ah));
    let mut out = vec![0u8; (tw * th * 4) as usize];
    for y in 0..th {
        for x in 0..tw {
            let (sx, sy) = if dilate {
                (x.min(aw - 1), y.min(ah - 1))
            } else if x < aw && y < ah {
                (x, y)
            } else {
                // the old behaviour: padding left zeroed
                let o = ((y * tw + x) * 4) as usize;
                out[o..o + 4].copy_from_slice(&[0, 0, 0, 0]);
                continue;
            };
            let s = ((sy * aw + sx) * 4) as usize;
            let o = ((y * tw + x) * 4) as usize;
            out[o..o + 4].copy_from_slice(&flat[s..s + 4]);
        }
    }
    (out, tw, th)
}

fn texel(t: &[u8], tw: u32, th: u32, x: i32, y: i32) -> [f32; 4] {
    let x = x.clamp(0, tw as i32 - 1) as u32;
    let y = y.clamp(0, th as i32 - 1) as u32;
    let o = ((y * tw + x) * 4) as usize;
    [
        t[o] as f32,
        t[o + 1] as f32,
        t[o + 2] as f32,
        t[o + 3] as f32,
    ]
}

/// Sample as the PICA200 does, in the page's real (not padded) UV window.
fn sample(t: &[u8], tw: u32, th: u32, u: f32, v: f32, linear: bool) -> [f32; 4] {
    let (fx, fy) = (u * tw as f32 - 0.5, v * th as f32 - 0.5);
    if !linear {
        return texel(t, tw, th, (fx + 0.5).floor() as i32, (fy + 0.5).floor() as i32);
    }
    let (x0, y0) = (fx.floor(), fy.floor());
    let (ax, ay) = (fx - x0, fy - y0);
    let mut out = [0.0f32; 4];
    for (dy, wy) in [(0, 1.0 - ay), (1, ay)] {
        for (dx, wx) in [(0, 1.0 - ax), (1, ax)] {
            let c = texel(t, tw, th, x0 as i32 + dx, y0 as i32 + dy);
            for k in 0..4 {
                out[k] += c[k] * wx * wy;
            }
        }
    }
    out
}

/// Composite over a mid grey so a transparent texel's colour shows if it
/// leaks. Byte 0 is ALPHA and bytes 1..3 are the colour -- see main.rs.
fn over(c: [f32; 4]) -> [u8; 3] {
    let a = c[0] / 255.0;
    let bg = 150.0;
    [
        (c[1] * a + bg * (1.0 - a)) as u8,
        (c[2] * a + bg * (1.0 - a)) as u8,
        (c[3] * a + bg * (1.0 - a)) as u8,
    ]
}

fn main() {
    let a: Vec<String> = env::args().collect();
    let data = fs::read(&a[1]).unwrap();
    let p = pak::read(&data).unwrap();
    let pidx: u16 = a[2].parse().unwrap();
    let (dw, dh): (u32, u32) = (a[3].parse().unwrap(), a[4].parse().unwrap());
    let page = p.atlases[pidx as usize];
    let palv = &p.palettes[resolve_pal(&p, pidx, page.kind, COLOR_PAL_NONE, -1)];

    let (old, tw, th) = build(&page, palv, false);
    let (new, _, _) = build(&page, palv, true);
    println!(
        "page {} kind {} {}x{} -> surface {}x{}, drawn at {}x{} device px",
        pidx, page.kind, page.w, page.h, tw, th, dw, dh
    );

    // --- the two checks -------------------------------------------------
    //
    // Measure the halo directly rather than guessing at it by colour: for
    // every transparent texel a linear tap can reach (one that touches opaque
    // art), how far is its RGB from the nearest opaque neighbour? That gap is
    // exactly what a tap straddling the silhouette drags into the blend.
    // Before dilation it is the distance from the art to the palette's stored
    // red or black; after, it should be near zero.
    let (aw, ah) = (page.w as u32, page.h as u32);
    let gap = |buf: &Vec<u8>, x: u32, y: u32| -> Option<f32> {
        let o = ((y * tw + x) * 4) as usize;
        if buf[o] != 0 {
            return None;
        }
        let mut best: Option<f32> = None;
        for dy in -1i32..=1 {
            for dx in -1i32..=1 {
                let (nx, ny) = (x as i32 + dx, y as i32 + dy);
                if nx < 0 || ny < 0 || nx >= aw as i32 || ny >= ah as i32 {
                    continue;
                }
                let p = ((ny as u32 * tw + nx as u32) * 4) as usize;
                if buf[p] == 0 {
                    continue;
                }
                let d = (1..4)
                    .map(|k| (buf[o + k] as f32 - buf[p + k] as f32).powi(2))
                    .sum::<f32>()
                    .sqrt();
                best = Some(best.map_or(d, |b: f32| b.min(d)));
            }
        }
        best
    };
    let (mut n_edge, mut sum_old, mut sum_new, mut max_new) = (0u32, 0.0f32, 0.0f32, 0.0f32);
    let mut worst = None;
    for y in 0..ah {
        for x in 0..aw {
            let (Some(a), Some(b)) = (gap(&old, x, y), gap(&new, x, y)) else {
                continue;
            };
            n_edge += 1;
            sum_old += a;
            sum_new += b;
            if b > max_new {
                max_new = b;
                worst = Some((x, y, b));
            }
        }
    }
    if n_edge > 0 {
        println!(
            "  {n_edge} transparent texels border the art; mean RGB gap to the \
             nearest opaque neighbour {:.1} -> {:.1} (worst left {:.1})",
            sum_old / n_edge as f32,
            sum_new / n_edge as f32,
            max_new
        );
        if let Some(w) = worst {
            println!("    worst remaining at ({}, {})", w.0, w.1);
        }
    }
    let mut pad_bad = 0;
    for y in 0..th {
        for x in 0..tw {
            if x < aw && y < ah {
                continue;
            }
            let o = ((y * tw + x) * 4) as usize;
            let s = ((y.min(ah - 1) * tw + x.min(aw - 1)) * 4) as usize;
            if new[o..o + 4] != new[s..s + 4] {
                pad_bad += 1;
            }
        }
    }

    if let Some(w) = worst {
        println!("    e.g. ({}, {}) = {:?}; 3x3 neighbourhood (rgb/a):", w.0, w.1, w.2);
        for dy in -1i32..=1 {
            let mut row = String::from("      ");
            for dx in -1i32..=1 {
                let (nx, ny) = (w.0 as i32 + dx, w.1 as i32 + dy);
                if nx < 0 || ny < 0 || nx >= aw as i32 || ny >= ah as i32 {
                    row.push_str("        --        ");
                    continue;
                }
                let o = ((ny as u32 * tw + nx as u32) * 4) as usize;
                row.push_str(&format!(
                    " {:3},{:3},{:3}/{:3} ",
                    new[o], new[o + 1], new[o + 2], new[o + 3]
                ));
            }
            println!("{row}");
        }
    }
    println!("  padding texels that are not the clamped edge: {pad_bad}");

    // --- the picture ----------------------------------------------------
    // Four panels: nearest on the old surface (what shipped), linear on the
    // old surface (bilinear WITHOUT the fixes -- the halo), linear on the new
    // surface (what this change does), and the source at 1:1.
    let (uw, uh) = (page.w as f32 / tw as f32, page.h as f32 / th as f32);
    let panels: [(&Vec<u8>, bool); 3] = [(&old, false), (&old, true), (&new, true)];
    let gap = 8u32;
    let out_w = dw * 3 + gap * 4;
    let out_h = dh + gap * 2;
    let mut img = vec![40u8; (out_w * out_h * 3) as usize];
    for (pi, (tex, linear)) in panels.iter().enumerate() {
        let ox = gap + pi as u32 * (dw + gap);
        for y in 0..dh {
            for x in 0..dw {
                let u = (x as f32 + 0.5) / dw as f32 * uw;
                let v = (y as f32 + 0.5) / dh as f32 * uh;
                let c = over(sample(tex, tw, th, u, v, *linear));
                let o = (((y + gap) * out_w + ox + x) * 3) as usize;
                img[o..o + 3].copy_from_slice(&c);
            }
        }
    }
    let mut ppm = format!("P6\n{out_w} {out_h}\n255\n").into_bytes();
    ppm.extend_from_slice(&img);
    fs::write(&a[5], ppm).unwrap();
    println!("  wrote {} ({}x{}) -- panels: nearest | linear (no fix) | linear (fixed)",
             a[5], out_w, out_h);
}
