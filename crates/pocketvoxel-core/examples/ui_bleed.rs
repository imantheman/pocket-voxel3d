// Throwaway: does a linear tap inside one UI tile reach a neighbouring cell?
//
// The test is airtight rather than visual: render a tile at the real device
// scale, then render it again from a sheet where every OTHER cell has been
// overwritten with a marker value, and diff. If the tile's pixels depend in
// any way on what sits beside it in the atlas, the diff is non-zero.
//
// Run for the flush packing (what shipped, expected to bleed) and the
// gutter repacking (expected to be identical).
//
// usage: ui_bleed <pak>
use pocketvoxel_core::draw::resolve_pal;
use pocketvoxel_core::pak;
use pocketvoxel_core::spec::{COLOR_PAL_NONE, atlas_kind};
use std::env;
use std::fs;

const UI_CELL: u32 = 8;
const UI_GUTTER: u32 = 0;
/// Point-replication factor, matching main.rs page_prescale for the UI sheet.
const UI_SCALE: u32 = 2;
fn cell_px() -> u32 { UI_CELL * UI_SCALE }
fn pitch() -> u32 { cell_px() + UI_GUTTER * 2 }

// The top screen's real tile footprint: UI_TILE_PX = 8 * VIEW_H / GB_H guest
// px, then 400/480 across and 240/272 down.
// Overridable, because the companion screen magnifies harder: 320/20 = 16
// across and 240/18 = 13.33 down.


fn po2(n: u32) -> u32 {
    let mut p = 8u32;
    while p < n {
        p <<= 1;
    }
    p
}

fn ui_cell_src(e: u32, limit: u32) -> u32 {
    let cell = e / pitch();
    let within = (e % pitch()).saturating_sub(UI_GUTTER).min(cell_px() - 1);
    (cell * UI_CELL + within / UI_SCALE).min(limit - 1)
}

/// The uploaded surface, flat (swizzling is irrelevant to the sampler).
fn build(flat: &[u8], aw: u32, ah: u32, gutter: bool) -> (Vec<u8>, u32, u32) {
    let (gw, gh) = if gutter {
        (aw.div_ceil(UI_CELL) * pitch(), ah.div_ceil(UI_CELL) * pitch())
    } else {
        (aw, ah)
    };
    let (tw, th) = (po2(gw), po2(gh));
    let mut out = vec![0u8; (tw * th * 4) as usize];
    for y in 0..th {
        for x in 0..tw {
            let (ex, ey) = (x.min(gw - 1), y.min(gh - 1));
            let (sx, sy) = if gutter {
                (ui_cell_src(ex, aw), ui_cell_src(ey, ah))
            } else {
                (ex.min(aw - 1), ey.min(ah - 1))
            };
            let s = ((sy * aw + sx) * 4) as usize;
            let o = ((y * tw + x) * 4) as usize;
            out[o..o + 4].copy_from_slice(&flat[s..s + 4]);
        }
    }
    (out, tw, th)
}

fn uv(tile: u16, cols: u16, pw: f32, ph: f32, gutter: bool) -> (f32, f32, f32, f32) {
    let (p, c, g) = if gutter {
        (pitch() as f32, cell_px() as f32, UI_GUTTER as f32)
    } else {
        (UI_CELL as f32, UI_CELL as f32, 0.0)
    };
    let x0 = (tile % cols) as f32 * p + g;
    let y0 = (tile / cols) as f32 * p + g;
    (x0 / pw, (x0 + c) / pw, 1.0 - y0 / ph, 1.0 - (y0 + c) / ph)
}

fn texel(t: &[u8], tw: u32, th: u32, x: i32, y: i32) -> [f32; 4] {
    let x = x.clamp(0, tw as i32 - 1) as u32;
    let y = y.clamp(0, th as i32 - 1) as u32;
    let o = ((y * tw + x) * 4) as usize;
    [t[o] as f32, t[o + 1] as f32, t[o + 2] as f32, t[o + 3] as f32]
}

fn sample(t: &[u8], tw: u32, th: u32, u: f32, v: f32) -> [f32; 4] {
    // V is flipped against memory order: the pipeline addresses content row r
    // as v = 1 - r/th (the terrain path binds uvx.y = -ah/th with +1.0 for
    // exactly this), so a sample at v reads memory row (1 - v) * th.
    let (fx, fy) = (u * tw as f32 - 0.5, (1.0 - v) * th as f32 - 0.5);
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

/// Largest per-channel difference between drawing `tile` from the real sheet
/// and from one whose every other cell is a marker.
fn worst_bleed(flat: &[u8], aw: u32, ah: u32, cols: u16, tile: u16, gutter: bool,
               dev_w: u32, dev_h: u32) -> f32 {
    let mut poisoned = flat.to_vec();
    let (cx, cy) = ((tile % cols) as u32, (tile / cols) as u32);
    for y in 0..ah {
        for x in 0..aw {
            if x / UI_CELL == cx && y / UI_CELL == cy {
                continue;
            }
            let o = ((y * aw + x) * 4) as usize;
            // alpha byte first, then colour -- a loud opaque marker
            poisoned[o..o + 4].copy_from_slice(&[255, 255, 0, 255]);
        }
    }
    let (a, tw, th) = build(flat, aw, ah, gutter);
    let (b, _, _) = build(&poisoned, aw, ah, gutter);
    let (u0, u1, v0, v1) = uv(tile, cols, tw as f32, th as f32, gutter);
    let mut worst = 0.0f32;
    for py in 0..dev_h {
        for px in 0..dev_w {
            let fu = u0 + (u1 - u0) * (px as f32 + 0.5) / dev_w as f32;
            let fv = v0 + (v1 - v0) * (py as f32 + 0.5) / dev_h as f32;
            let ca = sample(&a, tw, th, fu, fv);
            let cb = sample(&b, tw, th, fu, fv);
            for k in 0..4 {
                worst = worst.max((ca[k] - cb[k]).abs());
            }
        }
    }
    worst
}

fn main() {
    let a: Vec<String> = env::args().collect();
    let data = fs::read(&a[1]).unwrap();
    let p = pak::read(&data).unwrap();
    let pidx = p
        .atlases
        .iter()
        .position(|q| q.kind == atlas_kind::UI)
        .expect("no UI page") as u16;
    let page = p.atlases[pidx as usize];
    let palv = &p.palettes[resolve_pal(&p, pidx, page.kind, COLOR_PAL_NONE, -1)];
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
    let dev_w: u32 = a.get(2).and_then(|v| v.parse().ok()).unwrap_or(13);
    let dev_h: u32 = a.get(3).and_then(|v| v.parse().ok()).unwrap_or(14);
    let cols = ((aw / UI_CELL) as u16).max(1);
    let rows = (ah / UI_CELL) as u16;
    println!(
        "UI page {pidx}: {aw}x{ah} = {cols}x{rows} cells, tile drawn at \
         {dev_w}x{dev_h} device px"
    );
    for &gutter in &[false, true] {
        let (mut worst, mut n_bad, mut worst_tile) = (0.0f32, 0u32, 0u16);
        for tile in 0..cols * rows {
            let w = worst_bleed(&flat, aw, ah, cols, tile, gutter, dev_w, dev_h);
            if w > 0.5 {
                n_bad += 1;
            }
            if w > worst {
                worst = w;
                worst_tile = tile;
            }
        }
        println!(
            "  {:<16} {n_bad}/{} tiles change when their sheet neighbours do; \
             worst delta {worst:.1} (tile {worst_tile})",
            if gutter { "x2 prescale" } else { "flush 1:1" },
            cols * rows
        );
    }
}
