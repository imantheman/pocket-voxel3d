//! A Game Boy screen: tile maps, scroll and window registers, a per-scanline
//! override table, OAM and the three palette registers, drawn the way the
//! hardware draws them.
//!
//! For the few screens ported straight off the hardware (Yellow's Surfing
//! Pikachu first): the guest runs the ROM's logic against the same state
//! (voxelmon/game/gb/video.ts, whose `renderGb` is this renderer in
//! TypeScript) and mirrors it here through the `gb*` ops. Tile pixels are
//! never sent: a VRAM range names an atlas page and the tile it starts at,
//! and the host reads the page (`render`'s `pixel`).
//!
//! The frame comes out as one byte per pixel -- palette slot * 4 + shade
//! shown (slot 0 BG/window, 1 OBP0, 2 OBP1) -- which the host colours
//! through the three SGB palettes `colours` names.

use crate::spec::op;

pub const GB_W: usize = 160;
pub const GB_H: usize = 144;
/// VRAM tile ranges at once (the minigame loads three).
pub const GB_LOADS_MAX: usize = 16;
/// Decoded VRAM: 384 tiles x 64 shades (`GbScreen::decode_vram`).
pub const VRAM_BYTES: usize = 384 * 64;

const LCDC_WIN_MAP_9C00: u8 = 0x40;
const LCDC_WIN_ON: u8 = 0x20;
const LCDC_TILES_8000: u8 = 0x10;
const LCDC_BG_MAP_9C00: u8 = 0x08;
const LCDC_OBJ_ON: u8 = 0x02;
const LCDC_BG_ON: u8 = 0x01;
const ATTR_BEHIND_BG: u8 = 0x80;
const ATTR_Y_FLIP: u8 = 0x40;
const ATTR_X_FLIP: u8 = 0x20;
const ATTR_OBP1: u8 = 0x10;

/// `page` for "map `map`'s own terrain page" (the guest's -2): the host
/// resolves it, as the pak names one per map (`Pak::map_terrain_page`).
pub const GB_PAGE_MAP_TERRAIN: u16 = 0xfffe;

/// `count` tiles of atlas page `page` from its tile `first`, at VRAM tile
/// `dest` (0..127 $8000, 128..255 $8800, 256..383 $9000).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct GbLoad {
    pub dest: u16,
    pub page: u16,
    /// The map whose terrain `GB_PAGE_MAP_TERRAIN` means.
    pub map: u32,
    /// Tiles taken a row (0: the load runs straight on through the page).
    pub wide: u16,
    /// The source rows' length in tiles, when `wide` is set.
    pub stride: u16,
    pub first: u16,
    pub count: u16,
}

#[derive(Clone, Debug)]
pub struct GbScreen {
    pub shown: bool,
    /// vBGMap0 then vBGMap1, 32x32 each.
    pub maps: [u8; 2048],
    /// 40 x (y, x, tile, attr), hardware OAM coordinates.
    pub oam: [u8; 160],
    /// wLYOverrides, for `line_target` (0 none, 1 SCY, 2 SCX).
    pub lines: [u8; GB_H],
    pub line_target: u8,
    pub lcdc: u8,
    pub scx: u8,
    pub scy: u8,
    pub wx: u8,
    pub wy: u8,
    pub bgp: u8,
    pub obp0: u8,
    pub obp1: u8,
    /// SGB palette indices (the `palette` op's) for BG, OBP0, OBP1; -1 grey.
    pub colours: [i16; 3],
    pub loads: [GbLoad; GB_LOADS_MAX],
    pub load_count: usize,
    /// Bumped by every op that changes what is drawn, so a host can skip
    /// redrawing an unchanged frame.
    pub serial: u32,
}

impl Default for GbScreen {
    fn default() -> Self {
        GbScreen {
            shown: false,
            maps: [0; 2048],
            oam: [0; 160],
            lines: [0; GB_H],
            line_target: 0,
            lcdc: 0,
            scx: 0,
            scy: 0,
            wx: 7,
            wy: GB_H as u8,
            bgp: 0xe4,
            obp0: 0xe4,
            obp1: 0xe4,
            colours: [-1; 3],
            loads: [GbLoad::default(); GB_LOADS_MAX],
            load_count: 0,
            serial: 0,
        }
    }
}

/// Hex pairs into `out` from `at`, as far as both go.
fn unhex(text: &str, out: &mut [u8], at: usize) {
    let b = text.as_bytes();
    let nib = |c: u8| match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    };
    for (i, pair) in b.chunks_exact(2).enumerate() {
        let Some(slot) = out.get_mut(at + i) else { return };
        if let (Some(h), Some(l)) = (nib(pair[0]), nib(pair[1])) {
            *slot = (h << 4) | l;
        }
    }
}

impl GbScreen {
    /// Dispatch one `gb*` op (voxel-spec.ts). False for a code it does not
    /// own; malformed args are no-ops.
    pub fn op(&mut self, code: u32, args: &[i32], text: Option<&str>) -> bool {
        let a = |i: usize| args.get(i).copied().unwrap_or(0);
        match code {
            op::GB_SHOW => self.shown = a(0) != 0,
            op::GB_RESET => {
                let shown = self.shown;
                *self = GbScreen { shown, serial: self.serial, ..GbScreen::default() };
            }
            op::GB_TILES => {
                let load = GbLoad {
                    dest: a(0).clamp(0, 383) as u16,
                    page: if a(1) == -2 { GB_PAGE_MAP_TERRAIN } else { a(1).max(0) as u16 },
                    map: a(6).max(0) as u32,
                    first: a(2).max(0) as u16,
                    count: a(3).clamp(0, 384) as u16,
                    wide: a(4).clamp(0, 256) as u16,
                    stride: a(5).clamp(0, 256) as u16,
                };
                // a later load over the same tiles replaces what was there
                let mut kept = [GbLoad::default(); GB_LOADS_MAX];
                let mut n = 0;
                for l in &self.loads[..self.load_count] {
                    let overlaps = l.dest < load.dest + load.count && load.dest < l.dest + l.count;
                    if !overlaps && n < GB_LOADS_MAX - 1 {
                        kept[n] = *l;
                        n += 1;
                    }
                }
                kept[n] = load;
                self.loads = kept;
                self.load_count = n + 1;
            }
            op::GB_MAP => {
                if let Some(t) = text {
                    unhex(t, &mut self.maps, a(0).clamp(0, 2047) as usize);
                }
            }
            op::GB_REGS => {
                self.lcdc = a(0) as u8;
                self.scx = a(1) as u8;
                self.scy = a(2) as u8;
                self.wx = a(3) as u8;
                self.wy = a(4) as u8;
                self.bgp = a(5) as u8;
                self.obp0 = a(6) as u8;
                self.obp1 = a(7) as u8;
            }
            op::GB_LINES => {
                self.line_target = a(0).clamp(0, 2) as u8;
                if let Some(t) = text {
                    unhex(t, &mut self.lines, 0);
                }
            }
            op::GB_OAM => {
                if let Some(t) = text {
                    unhex(t, &mut self.oam, 0);
                }
            }
            op::GB_COLOURS => {
                for (i, c) in self.colours.iter_mut().enumerate() {
                    *c = a(i).clamp(-1, 255) as i16;
                }
            }
            _ => return false,
        }
        self.serial = self.serial.wrapping_add(1);
        true
    }

    /// The page and tile a VRAM tile holds, or None when nothing is loaded.
    pub fn tile_source(&self, vram: u16) -> Option<(u16, u16)> {
        self.loads[..self.load_count]
            .iter()
            .rev()
            .find(|l| vram >= l.dest && vram < l.dest + l.count)
            .map(|l| {
                let k = vram - l.dest;
                if l.wide > 0 {
                    (l.page, l.first + (k / l.wide) * l.stride + k % l.wide)
                } else {
                    (l.page, l.first + k)
                }
            })
    }

    fn bg_tile(&self, id: u8) -> u16 {
        if self.lcdc & LCDC_TILES_8000 != 0 || id >= 0x80 {
            id as u16
        } else {
            256 + id as u16
        }
    }

    /// Draw the frame into `out` (GB_W * GB_H). `pixel(page, tile, x, y)`
    /// is a sheet tile's raw shade 0-3.
    pub fn render(&self, pixel: &mut impl FnMut(u16, u16, u8, u8) -> u8, out: &mut [u8]) {
        let mut vram = alloc::vec![0u8; VRAM_BYTES];
        self.decode_vram(pixel, &mut vram);
        self.render_decoded(&vram, out);
    }

    /// Every VRAM tile's 64 shades (0-3), row by row, into `out`
    /// (`VRAM_BYTES`): what the loads put there, read once -- a host keeps
    /// it while the loads stand and renders from it every frame.
    pub fn decode_vram(&self, pixel: &mut impl FnMut(u16, u16, u8, u8) -> u8, out: &mut [u8]) {
        if out.len() < VRAM_BYTES {
            return;
        }
        for v in 0..384u16 {
            let dst = &mut out[v as usize * 64..v as usize * 64 + 64];
            match self.tile_source(v) {
                Some((page, tile)) => {
                    for y in 0..8u8 {
                        for x in 0..8u8 {
                            dst[y as usize * 8 + x as usize] = pixel(page, tile, x, y) & 3;
                        }
                    }
                }
                None => dst.fill(0),
            }
        }
    }

    /// The loads standing now (a host compares them to know when its
    /// decoded VRAM is stale).
    pub fn current_loads(&self) -> &[GbLoad] {
        &self.loads[..self.load_count]
    }

    /// `render` from decoded VRAM (`decode_vram`).
    pub fn render_decoded(&self, vram: &[u8], out: &mut [u8]) {
        if out.len() < GB_W * GB_H || vram.len() < VRAM_BYTES {
            return;
        }
        let raw = |t: u16, x: u8, y: u8| -> u8 {
            vram[(t as usize % 384) * 64 + y as usize * 8 + x as usize]
        };
        let shade = |p: u8, s: u8| (p >> (s * 2)) & 3;
        let mut bg_raw = [0u8; GB_W];
        let mut win_line: usize = 0;
        for ly in 0..GB_H {
            let row = &mut out[ly * GB_W..(ly + 1) * GB_W];
            let scy = if self.line_target == 1 { self.lines[ly] } else { self.scy };
            let scx = if self.line_target == 2 { self.lines[ly] } else { self.scx };
            bg_raw.fill(0);
            let bg_map = if self.lcdc & LCDC_BG_MAP_9C00 != 0 { 0x400 } else { 0 };
            for x in 0..GB_W {
                let mut s = 0;
                if self.lcdc & LCDC_BG_ON != 0 {
                    let bx = (x as u8).wrapping_add(scx) as usize;
                    let by = (ly as u8).wrapping_add(scy) as usize;
                    let id = self.maps[bg_map + (by >> 3) * 32 + (bx >> 3)];
                    s = raw(self.bg_tile(id), (bx & 7) as u8, (by & 7) as u8);
                }
                bg_raw[x] = s;
                row[x] = shade(self.bgp, s);
            }
            if self.lcdc & LCDC_WIN_ON != 0 && ly >= self.wy as usize && self.wx <= 166 {
                let map = if self.lcdc & LCDC_WIN_MAP_9C00 != 0 { 0x400 } else { 0 };
                let x0 = (self.wx as usize).saturating_sub(7);
                for x in x0..GB_W {
                    let wx = x + 7 - self.wx as usize;
                    let id = self.maps[map + (win_line >> 3) * 32 + (wx >> 3)];
                    let s = raw(self.bg_tile(id), (wx & 7) as u8, (win_line & 7) as u8);
                    bg_raw[x] = s;
                    row[x] = shade(self.bgp, s);
                }
                win_line += 1;
            }
            if self.lcdc & LCDC_OBJ_ON == 0 {
                continue;
            }
            // the first ten on the line; a lower X, then a lower index, on top
            let mut hits = [0usize; 10];
            let mut n = 0;
            for i in 0..40 {
                let y = self.oam[i * 4] as i32 - 16;
                if (ly as i32) >= y && (ly as i32) < y + 8 {
                    hits[n] = i;
                    n += 1;
                    if n == 10 {
                        break;
                    }
                }
            }
            let hits = &mut hits[..n];
            hits.sort_by_key(|&i| (self.oam[i * 4 + 1], i));
            for &i in hits.iter().rev() {
                let e = &self.oam[i * 4..i * 4 + 4];
                let (y, x0, tile, attr) = (e[0] as i32 - 16, e[1] as i32 - 8, e[2], e[3]);
                let mut ty = ly as i32 - y;
                if attr & ATTR_Y_FLIP != 0 {
                    ty = 7 - ty;
                }
                for px in 0..8 {
                    let x = x0 + px;
                    if !(0..GB_W as i32).contains(&x) {
                        continue;
                    }
                    let tx = if attr & ATTR_X_FLIP != 0 { 7 - px } else { px };
                    let s = raw(tile as u16, tx as u8, ty as u8);
                    if s == 0 || (attr & ATTR_BEHIND_BG != 0 && bg_raw[x as usize] != 0) {
                        continue;
                    }
                    let (slot, pal) = if attr & ATTR_OBP1 != 0 { (8, self.obp1) } else { (4, self.obp0) };
                    row[x as usize] = slot + shade(pal, s);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    /// Tile t's pixels are all shade t % 4.
    fn flat(_page: u16, tile: u16, _x: u8, _y: u8) -> u8 {
        (tile % 4) as u8
    }

    #[test]
    fn a_strided_load_reads_a_sheets_column_and_terrain_names_its_map() {
        let mut gb = GbScreen::default();
        // a walk sheet: 2 tiles a row out of a page 8 tiles wide
        assert!(gb.op(op::GB_TILES, &[0, 9, 0, 24, 2, 8], None));
        assert_eq!(gb.tile_source(0), Some((9, 0)));
        assert_eq!(gb.tile_source(1), Some((9, 1)));
        assert_eq!(gb.tile_source(2), Some((9, 8)));
        assert_eq!(gb.tile_source(5), Some((9, 17)));
        // page -2: the map's own terrain page, for the host to find
        assert!(gb.op(op::GB_TILES, &[256, -2, 0, 128, 0, 0, 41], None));
        assert_eq!(gb.tile_source(259), Some((GB_PAGE_MAP_TERRAIN, 3)));
        assert_eq!(gb.current_loads().last().map(|l| l.map), Some(41));
    }

    #[test]
    fn the_bg_scrolls_wraps_and_takes_the_palette() {
        let mut gb = GbScreen::default();
        assert!(gb.op(op::GB_TILES, &[256, 7, 0, 128], None));
        // tile id 2 at map cell (1, 0); tiles at $9000 signed
        assert!(gb.op(op::GB_MAP, &[1], Some("02")));
        gb.op(op::GB_REGS, &[0x81, 0, 0, 7, 144, 0xe4, 0xe4, 0xe4], None);
        let mut out = vec![0u8; GB_W * GB_H];
        gb.render(&mut flat, &mut out);
        assert_eq!(out[7], 0);
        assert_eq!(out[8], 2);
        // scrolled 8 left, the cell arrives at x 0; BGP remaps shade 2 to 1
        gb.op(op::GB_REGS, &[0x81, 8, 0, 7, 144, 0b11_01_01_00, 0xe4, 0xe4], None);
        gb.render(&mut flat, &mut out);
        assert_eq!(out[0], 1);
        // a per-line SCX override moves only its own line
        let mut lines = [0u8; GB_H];
        lines[1] = 8;
        let hex: alloc::string::String = lines.iter().map(|b| alloc::format!("{:02x}", b)).collect();
        gb.op(op::GB_REGS, &[0x81, 0, 0, 7, 144, 0xe4, 0xe4, 0xe4], None);
        gb.op(op::GB_LINES, &[2], Some(&hex));
        gb.render(&mut flat, &mut out);
        assert_eq!((out[0], out[GB_W]), (0, 2));
    }

    #[test]
    fn sprites_sit_over_the_bg_window_covers_it() {
        let mut gb = GbScreen::default();
        gb.op(op::GB_TILES, &[0, 7, 0, 256], None);
        gb.op(op::GB_TILES, &[256, 7, 0, 128], None);
        // sprite tile 3 at the top-left pixel, OBP1
        gb.op(op::GB_OAM, &[], Some("10080310"));
        gb.op(op::GB_REGS, &[0x83, 0, 0, 7, 144, 0xe4, 0xe4, 0xe4], None);
        let mut out = vec![0u8; GB_W * GB_H];
        gb.render(&mut flat, &mut out);
        assert_eq!(out[0], 8 + 3);
        assert_eq!(out[8], 0);
        // the window from line 100, reading map 1 (tile 1)
        gb.op(op::GB_MAP, &[0x400], Some("01"));
        gb.op(op::GB_REGS, &[0xe1, 0, 0, 7, 100, 0xe4, 0xe4, 0xe4], None);
        gb.render(&mut flat, &mut out);
        assert_eq!(out[100 * GB_W], 1);
        assert_eq!(out[99 * GB_W], 0);
        assert!(gb.serial > 0);
    }
}
