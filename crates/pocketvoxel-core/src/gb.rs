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
/// The wide picture's largest size (`gbWide`): what one 1024x512 texture
/// holds (2D ZOOM OUT's farthest steps).
pub const GB_WIDE_W_MAX: usize = 1024;
pub const GB_WIDE_H_MAX: usize = 512;
/// The wide BG ring (`gbMap` from 0x800): 64x32 tiles (512x256 pixels),
/// or 128x64 (1024x512) for a picture that does not fit in that -- the
/// guest says which (`gbWide`'s last two arguments).
pub const GB_WIDE_COLS: usize = 64;
pub const GB_WIDE_ROWS: usize = 32;
pub const GB_WIDE_COLS_MAX: usize = 128;
pub const GB_WIDE_ROWS_MAX: usize = 64;
/// The wide picture's objects at most (`gbWideObjs`).
pub const GB_WIDE_OBJS_MAX: usize = 160;

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
    /// `gbWide`: the 2D overworld wider than the Game Boy's 160x144 (the
    /// OPTION screen's 2D SCREEN WIDE / 2D ZOOM) -- a `wide_w` x `wide_h`
    /// picture of the wide ring (`wide_map`, 64x32 tiles) from pixel
    /// (`wide_scx`, `wide_scy`), with `wide_objs` over it in its own pixels.
    /// 0 x 0: off, the hardware screen as ever. `wide_full`: the host lays
    /// it over the whole top screen rather than the Game Boy's rect.
    pub wide_w: u16,
    pub wide_h: u16,
    pub wide_scx: u16,
    pub wide_scy: u16,
    pub wide_full: bool,
    /// The ring, `wide_cols` x `wide_rows` tiles of it in use.
    pub wide_map: [u8; GB_WIDE_COLS_MAX * GB_WIDE_ROWS_MAX],
    pub wide_cols: u16,
    pub wide_rows: u16,
    /// (y, x, tile, attr): a lower index on top, no ten-a-line limit.
    pub wide_objs: [(i16, i16, u8, u8); GB_WIDE_OBJS_MAX],
    pub wide_obj_count: usize,
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
            wide_w: 0,
            wide_h: 0,
            wide_scx: 0,
            wide_scy: 0,
            wide_full: false,
            wide_map: [0; GB_WIDE_COLS_MAX * GB_WIDE_ROWS_MAX],
            wide_cols: GB_WIDE_COLS as u16,
            wide_rows: GB_WIDE_ROWS as u16,
            wide_objs: [(0, 0, 0, 0); GB_WIDE_OBJS_MAX],
            wide_obj_count: 0,
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
                    // from 0x800: the wide ring
                    let at = a(0).clamp(0, (2048 + GB_WIDE_COLS_MAX * GB_WIDE_ROWS_MAX - 1) as i32) as usize;
                    if at >= 2048 {
                        unhex(t, &mut self.wide_map, at - 2048);
                    } else {
                        unhex(t, &mut self.maps, at);
                    }
                }
            }
            op::GB_WIDE => {
                self.wide_w = a(0).clamp(0, GB_WIDE_W_MAX as i32) as u16;
                self.wide_h = a(1).clamp(0, GB_WIDE_H_MAX as i32) as u16;
                // the ring's size: the big one only when asked for
                self.wide_cols = if a(5) == GB_WIDE_COLS_MAX as i32 { GB_WIDE_COLS_MAX } else { GB_WIDE_COLS } as u16;
                self.wide_rows = if a(6) == GB_WIDE_ROWS_MAX as i32 { GB_WIDE_ROWS_MAX } else { GB_WIDE_ROWS } as u16;
                self.wide_scx = (a(2) & (self.wide_cols as i32 * 8 - 1)) as u16;
                self.wide_scy = (a(3) & (self.wide_rows as i32 * 8 - 1)) as u16;
                self.wide_full = a(4) != 0;
            }
            op::GB_WIDE_OBJS => {
                // twelve digits each: y, x (16-bit two's complement), tile, attr
                let t = text.unwrap_or("");
                let mut bytes = [0u8; GB_WIDE_OBJS_MAX * 6];
                let n = (t.len() / 12).min(GB_WIDE_OBJS_MAX);
                unhex(&t[..n * 12], &mut bytes, 0);
                for i in 0..n {
                    let b = &bytes[i * 6..i * 6 + 6];
                    self.wide_objs[i] = (i16::from_be_bytes([b[0], b[1]]), i16::from_be_bytes([b[2], b[3]]), b[4], b[5]);
                }
                self.wide_obj_count = n;
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
        self.decode_vram_range(pixel, out, 0, 384);
    }

    /// `decode_vram` for VRAM tiles `from..to` only (a page that animates
    /// re-read without the rest).
    pub fn decode_vram_range(&self, pixel: &mut impl FnMut(u16, u16, u8, u8) -> u8, out: &mut [u8], from: u16, to: u16) {
        if out.len() < VRAM_BYTES {
            return;
        }
        for v in from..to.min(384) {
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

    /// The wide picture is on (`gbWide`): `frame_size` is its size then.
    pub fn wide_on(&self) -> bool {
        self.wide_w > 0 && self.wide_h > 0
    }

    /// The picture `render_any` draws, w x h: the wide one's width rounded
    /// up to whole tiles (the host's texture is laid out by 8x8 tiles), or
    /// the hardware's 160x144.
    pub fn frame_size(&self) -> (usize, usize) {
        if self.wide_on() {
            ((self.wide_w as usize).div_ceil(8) * 8, self.wide_h as usize)
        } else {
            (GB_W, GB_H)
        }
    }

    /// `render_decoded`, or the wide picture while it is on, into `out`
    /// (`frame_size`).
    pub fn render_any(&self, vram: &[u8], out: &mut [u8]) {
        if self.wide_on() {
            self.render_wide(vram, out);
        } else {
            self.render_decoded(vram, out);
        }
    }

    /// Wide ring tile (tx, ty)'s 64 pixels, slot 0 * 4 + shade as
    /// `render_wide` puts them (the host keeps the ring as a texture and
    /// draws only the tiles that change), and its raw colours.
    pub fn wide_tile(&self, vram: &[u8], tx: usize, ty: usize, out: &mut [u8; 64]) {
        let shade = |p: u8, s: u8| (p >> (s * 2)) & 3;
        let (cols, rows) = (self.wide_cols as usize, self.wide_rows as usize);
        let id = self.wide_map[(ty & (rows - 1)) * cols + (tx & (cols - 1))];
        let t = (self.bg_tile(id) as usize).min(383);
        for (k, o) in out.iter_mut().enumerate() {
            *o = shade(self.bgp, vram[t * 64 + k] & 3);
        }
    }

    /// The wide picture's objects alone, as `render_wide` lays them over the
    /// ring: `put(x, y, pixel)` per object pixel that shows (picture pixels,
    /// a lower index winning), pixel = slot * 4 + shade.
    pub fn wide_objects(&self, vram: &[u8], put: &mut impl FnMut(i32, i32, u8)) {
        let (w, h) = (self.wide_w as i32, self.wide_h as i32);
        let shade = |p: u8, s: u8| (p >> (s * 2)) & 3;
        let cols = self.wide_cols as usize;
        let (ring_w, ring_h) = (cols * 8, self.wide_rows as usize * 8);
        // the ring's raw colour under a picture pixel, for OBJ priority
        let raw_at = |x: i32, y: i32| -> u8 {
            let bx = (x as usize + self.wide_scx as usize) & (ring_w - 1);
            let by = (y as usize + self.wide_scy as usize) & (ring_h - 1);
            let id = self.wide_map[(by >> 3) * cols + (bx >> 3)];
            let t = (self.bg_tile(id) as usize).min(383);
            vram[t * 64 + (by & 7) * 8 + (bx & 7)]
        };
        let objs = &self.wide_objs[..self.wide_obj_count];
        let mut taken: alloc::vec::Vec<u32> = alloc::vec::Vec::new();
        if objs.len() > 1 {
            taken = alloc::vec![0u32; (w as usize * h as usize).div_ceil(32)];
        }
        for &(y, x0, tile, attr) in objs.iter() {
            let (slot, pal) = if attr & ATTR_OBP1 != 0 { (8, self.obp1) } else { (4, self.obp0) };
            for r in 0..8i32 {
                let ly = y as i32 + r;
                if ly < 0 || ly >= h {
                    continue;
                }
                let ty = if attr & ATTR_Y_FLIP != 0 { 7 - r } else { r };
                for px in 0..8i32 {
                    let lx = x0 as i32 + px;
                    if lx < 0 || lx >= w {
                        continue;
                    }
                    let tx = if attr & ATTR_X_FLIP != 0 { 7 - px } else { px };
                    let s = vram[(tile as usize) * 64 + ty as usize * 8 + tx as usize];
                    if s == 0 || (attr & ATTR_BEHIND_BG != 0 && raw_at(lx, ly) != 0) {
                        continue;
                    }
                    if !taken.is_empty() {
                        let k = (ly * w + lx) as usize;
                        if taken[k >> 5] & (1 << (k & 31)) != 0 {
                            continue;
                        }
                        taken[k >> 5] |= 1 << (k & 31);
                    }
                    put(lx, ly, slot + shade(pal, s));
                }
            }
        }
    }

    /// The wide picture from decoded VRAM: the wide ring under the BG
    /// palette, the objects over it (OBJ priority against the ring's raw
    /// colour, as on the hardware), a lower index on top.
    pub fn render_wide(&self, vram: &[u8], out: &mut [u8]) {
        let (w, h) = self.frame_size();
        if out.len() < w * h || vram.len() < VRAM_BYTES {
            return;
        }
        let shade = |p: u8, s: u8| (p >> (s * 2)) & 3;
        let bgp = [shade(self.bgp, 0), shade(self.bgp, 1), shade(self.bgp, 2), shade(self.bgp, 3)];
        let cols = self.wide_cols as usize;
        let (ring_w, ring_h) = (cols * 8, self.wide_rows as usize * 8);
        // the ring's raw colours, kept for the objects' priority
        let mut raw = alloc::vec![0u8; w * h];
        for ly in 0..h {
            let by = (ly + self.wide_scy as usize) & (ring_h - 1);
            let (map_row, ty) = ((by >> 3) * cols, (by & 7) * 8);
            let row = &mut out[ly * w..(ly + 1) * w];
            let rrow = &mut raw[ly * w..(ly + 1) * w];
            let mut x = 0;
            while x < w {
                let bx = (x + self.wide_scx as usize) & (ring_w - 1);
                let px0 = bx & 7;
                let n = (8 - px0).min(w - x);
                let t = (self.bg_tile(self.wide_map[map_row + (bx >> 3)]) as usize).min(383);
                let src = &vram[t * 64 + ty + px0..t * 64 + ty + px0 + n];
                for (k, &v) in src.iter().enumerate() {
                    rrow[x + k] = v;
                    row[x + k] = bgp[v as usize & 3];
                }
                x += n;
            }
        }
        // the objects, last first, so a lower index lands on top
        for &(y, x0, tile, attr) in self.wide_objs[..self.wide_obj_count].iter().rev() {
            let (slot, pal) = if attr & ATTR_OBP1 != 0 { (8, self.obp1) } else { (4, self.obp0) };
            for r in 0..8i32 {
                let ly = y as i32 + r;
                if ly < 0 || ly >= h as i32 {
                    continue;
                }
                let ty = if attr & ATTR_Y_FLIP != 0 { 7 - r } else { r };
                for px in 0..8i32 {
                    let lx = x0 as i32 + px;
                    if lx < 0 || lx >= w as i32 {
                        continue;
                    }
                    let tx = if attr & ATTR_X_FLIP != 0 { 7 - px } else { px };
                    let s = vram[(tile as usize) * 64 + ty as usize * 8 + tx as usize];
                    let k = ly as usize * w + lx as usize;
                    if s == 0 || (attr & ATTR_BEHIND_BG != 0 && raw[k] != 0) {
                        continue;
                    }
                    out[k] = slot + shade(pal, s);
                }
            }
        }
    }

    /// `render` from decoded VRAM (`decode_vram`).
    pub fn render_decoded(&self, vram: &[u8], out: &mut [u8]) {
        if out.len() < GB_W * GB_H || vram.len() < VRAM_BYTES {
            return;
        }
        let raw = |t: u16, x: u8, y: u8| -> u8 {
            // (a clamp, not `% 384`: the 3DS's ARM11 has no divide, and this
            // runs for every pixel; a tile id is under 384 already)
            vram[(t as usize).min(383) * 64 + y as usize * 8 + x as usize]
        };
        let shade = |p: u8, s: u8| (p >> (s * 2)) & 3;
        let mut bg_raw = [0u8; GB_W];
        let mut win_line: usize = 0;
        for ly in 0..GB_H {
            let row = &mut out[ly * GB_W..(ly + 1) * GB_W];
            let scy = if self.line_target == 1 { self.lines[ly] } else { self.scy };
            let scx = if self.line_target == 2 { self.lines[ly] } else { self.scx };
            let bg_map = if self.lcdc & LCDC_BG_MAP_9C00 != 0 { 0x400 } else { 0 };
            let bgp = [shade(self.bgp, 0), shade(self.bgp, 1), shade(self.bgp, 2), shade(self.bgp, 3)];
            if self.lcdc & LCDC_BG_ON != 0 {
                // a tile's row at a time: the line crosses 20 or 21 of them
                let by = (ly as u8).wrapping_add(scy) as usize;
                let (map_row, ty) = (bg_map + (by >> 3) * 32, (by & 7) * 8);
                let mut x = 0;
                while x < GB_W {
                    let bx = (x as u8).wrapping_add(scx) as usize;
                    let px0 = bx & 7;
                    let n = (8 - px0).min(GB_W - x);
                    let t = (self.bg_tile(self.maps[map_row + (bx >> 3)]) as usize).min(383);
                    let src = &vram[t * 64 + ty + px0..t * 64 + ty + px0 + n];
                    for (k, &s) in src.iter().enumerate() {
                        bg_raw[x + k] = s;
                        row[x + k] = bgp[s as usize & 3];
                    }
                    x += n;
                }
            } else {
                bg_raw.fill(0);
                row.fill(bgp[0]);
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

    #[test]
    fn the_wide_picture_reads_the_wide_ring_and_its_own_objects() {
        let mut gb = GbScreen::default();
        // VRAM decoded by hand: tile 257 ($9000 + 1) all shade 1, tile 3 all 2
        let mut vram = vec![0u8; VRAM_BYTES];
        vram[257 * 64..258 * 64].fill(1);
        vram[3 * 64..4 * 64].fill(2);
        gb.op(op::GB_REGS, &[0x83, 0, 0, 7, 144, 0xe4, 0xe4, 0xe4], None);
        assert!(!gb.wide_on());
        assert_eq!(gb.frame_size(), (GB_W, GB_H));
        // ring tile (40, 2) is tile 1; a 254x144 picture from pixel (300, 0)
        gb.op(op::GB_MAP, &[0x800 + 2 * 64 + 40], Some("01"));
        assert!(gb.op(op::GB_WIDE, &[254, 144, 300, 0, 1], None));
        assert!(gb.wide_on() && gb.wide_full);
        assert_eq!(gb.frame_size(), (256, 144), "rounded up to whole tiles");
        let mut out = vec![0u8; 256 * 144];
        gb.render_any(&vram, &mut out);
        // ring x 320..328 is picture x 20..28, rows 16..24
        assert_eq!(out[16 * 256 + 20], 1);
        assert_eq!(out[16 * 256 + 19], 0);
        assert_eq!(out[15 * 256 + 20], 0);
        // an object at x 250, y -4 (16-bit two's complement): its rows 4..8
        // show at y 0..4, its first six columns before the frame's edge
        assert!(gb.op(op::GB_WIDE_OBJS, &[], Some("fffc00fa0300")));
        gb.render_any(&vram, &mut out);
        assert_eq!(out[250], 4 + 2, "OBP0 slot, shade 2");
        assert_eq!(out[3 * 256 + 255], 4 + 2);
        assert_eq!(out[4 * 256 + 250], 0, "below its last row");
        // behind the BG: hidden where the ring's colour is not 0
        assert!(gb.op(op::GB_WIDE_OBJS, &[], Some("001000180380")));
        gb.render_any(&vram, &mut out);
        assert_eq!(out[16 * 256 + 24], 1, "the ring's tile wins");
        assert_eq!(out[16 * 256 + 28], 4 + 2, "the object over colour 0");
        // the host's way -- the ring's tiles and the objects apart -- makes
        // the same picture
        let mut parts = vec![0u8; 256 * 144];
        for y in 0..144usize {
            for x in 0..256usize {
                let (bx, by) = ((x + 300) & 511, y);
                let mut t = [0u8; 64];
                gb.wide_tile(&vram, bx >> 3, by >> 3, &mut t);
                parts[y * 256 + x] = t[(by & 7) * 8 + (bx & 7)];
            }
        }
        gb.wide_objects(&vram, &mut |x, y, p| parts[y as usize * 256 + x as usize] = p);
        for y in 0..144usize {
            for x in 0..254usize {
                assert_eq!(parts[y * 256 + x], out[y * 256 + x], "pixel {x},{y}");
            }
        }
        // off: the hardware screen again
        gb.op(op::GB_WIDE, &[0, 0, 0, 0, 0], None);
        assert_eq!(gb.frame_size(), (GB_W, GB_H));
    }

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

    #[test]
    fn the_big_ring_is_taken_only_when_asked_and_gb_map_reaches_all_of_it() {
        let mut gb = GbScreen::default();
        // no ring size: the 64x32 one
        assert!(gb.op(op::GB_WIDE, &[424, 240, 600, 300, 1], None));
        assert_eq!((gb.wide_cols, gb.wide_rows), (64, 32));
        assert_eq!(gb.wide_scx, 600 & 511);
        // 2D ZOOM OUT MAX: 128x64, the scroll wrapped at 1024 x 512
        assert!(gb.op(op::GB_WIDE, &[635, 360, 1500, 700, 1, 128, 64], None));
        assert_eq!((gb.wide_cols, gb.wide_rows), (128, 64));
        assert_eq!((gb.wide_w, gb.wide_h), (635, 360));
        assert_eq!((gb.wide_scx, gb.wide_scy), (1500 & 1023, 700 & 511));
        // the ring's last row, past where the small ring ended
        let at = 63 * 128 + 127;
        gb.op(op::GB_MAP, &[0x800 + at as i32], Some("5a"));
        assert_eq!(gb.wide_map[at], 0x5a);
        // anything else is the small ring again
        assert!(gb.op(op::GB_WIDE, &[400, 240, 0, 0, 1, 100, 50], None));
        assert_eq!((gb.wide_cols, gb.wide_rows), (64, 32));
    }
}
