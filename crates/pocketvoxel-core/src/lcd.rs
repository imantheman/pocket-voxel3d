//! The Gold screen: a Game Boy Color's picture model without the hardware's
//! budgets, laid over the 3D world.
//!
//! Every Gen 2 screen gen1recomp draws is transcribed from pokegold, and
//! pokegold draws with a CGB: two 32x32 tile maps (background and window)
//! whose cells each carry a tile and an attribute byte, a list of 8x8
//! objects, and sixteen four-colour palettes. The guest ports those screens
//! onto the same model (voxelmon/game/gen2/platform/lcd.ts, whose
//! `renderLcd` is this renderer in TypeScript) and mirrors it here through
//! the `lcd*` ops.
//!
//! What differs from the hardware, on purpose:
//! - A tile is a 16-bit id into banks of cooked atlas pages (`lcdBank`)
//!   rather than a VRAM slot, so a screen never juggles VRAM: every Gold
//!   graphic has a fixed id for the whole run. Tile pixels are never sent.
//! - Up to `LCD_OBJS_MAX` objects at signed screen coordinates, with no
//!   ten-per-line limit.
//! - A background or window cell can be a HOLE (attribute bit 4): nothing
//!   of the map is drawn there and the 3D world shows through, which is how
//!   a text box sits over the overworld.
//! - Under the background's holes there can be an UNDER layer instead of the
//!   world (VIEW 2D): a whole map's cells, sent once, shown at a camera
//!   position -- the hardware's scrolling BG without its 32x32 ring, so a
//!   step sends a position rather than a screen of cells.
//!
//! The frame comes out as one byte per pixel: palette slot * 4 + colour
//! (slots 0-15 background, 16-31 objects), or `LCD_HOLE`. The host colours
//! it through `colours`, 128 RGB555 entries.

use crate::spec::op;
use alloc::vec::Vec;

pub const LCD_W: usize = 160;
pub const LCD_H: usize = 144;
pub const LCD_BANKS_MAX: usize = 64;
pub const LCD_OBJS_MAX: usize = 128;
/// 16 background + 16 object palettes of four colours.
pub const LCD_COLOURS: usize = 128;
/// A pixel no layer covers: the host leaves it transparent.
pub const LCD_HOLE: u8 = 0xff;

/// Cell attribute bits (the CGB BG attribute byte, bank bit reused as
/// palette bit 3 and the unused bit 4 as the hole).
pub const ATTR_PAL: u8 = 0x0f;
pub const ATTR_HOLE: u8 = 0x10;
pub const ATTR_X_FLIP: u8 = 0x20;
pub const ATTR_Y_FLIP: u8 = 0x40;
/// On a cell: its colours 1-3 draw over objects. On an object: it draws
/// only over background colour 0 (or a hole).
pub const ATTR_PRIORITY: u8 = 0x80;

/// `lcdRegs` flags.
pub const FLAG_BG_ON: u8 = 0x01;
pub const FLAG_WIN_ON: u8 = 0x02;
pub const FLAG_OBJ_ON: u8 = 0x04;
pub const FLAG_OBJ_TALL: u8 = 0x08;

/// Tile ids `base..base+count` are tiles `0..count` of atlas page `page`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct LcdBank {
    pub base: u16,
    pub page: u16,
    pub count: u16,
}

/// One object: its top-left in screen pixels.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct LcdObj {
    pub x: i16,
    pub y: i16,
    pub tile: u16,
    pub attr: u8,
}

#[derive(Clone, Debug)]
pub struct LcdScreen {
    pub shown: bool,
    /// Background map then window map, 32x32 each: tile ids.
    pub cells: [u16; 2048],
    pub attrs: [u8; 2048],
    pub objs: [LcdObj; LCD_OBJS_MAX],
    pub obj_count: usize,
    /// RGB555, slot * 4 + colour.
    pub colours: [u16; LCD_COLOURS],
    pub scx: u8,
    pub scy: u8,
    pub wx: u8,
    pub wy: u8,
    pub flags: u8,
    /// Per-line overrides for `line_target` (0 none, 1 SCY, 2 SCX).
    pub lines: [u8; LCD_H],
    pub line_target: u8,
    pub banks: [LcdBank; LCD_BANKS_MAX],
    pub bank_count: usize,
    /// The under layer (`lcdUnder*`): `under_w` x `under_h` cells, tile ids
    /// and attributes; shown while `under_on`, its pixel (under_x, under_y)
    /// at the screen's top-left.
    pub under: Vec<u16>,
    pub under_attr: Vec<u8>,
    pub under_w: usize,
    pub under_h: usize,
    pub under_on: bool,
    pub under_x: i32,
    pub under_y: i32,
    /// Bumped by every op that changes what is drawn.
    pub serial: u32,
}

impl Default for LcdScreen {
    fn default() -> Self {
        LcdScreen {
            shown: false,
            cells: [0; 2048],
            // a fresh screen is all hole: nothing covers the world
            attrs: [ATTR_HOLE; 2048],
            objs: [LcdObj::default(); LCD_OBJS_MAX],
            obj_count: 0,
            colours: [0; LCD_COLOURS],
            scx: 0,
            scy: 0,
            wx: 7,
            wy: LCD_H as u8,
            flags: FLAG_BG_ON | FLAG_OBJ_ON,
            lines: [0; LCD_H],
            line_target: 0,
            banks: [LcdBank::default(); LCD_BANKS_MAX],
            bank_count: 0,
            under: Vec::new(),
            under_attr: Vec::new(),
            under_w: 0,
            under_h: 0,
            under_on: false,
            under_x: 0,
            under_y: 0,
            serial: 0,
        }
    }
}

fn nib(c: u8) -> Option<u32> {
    match c {
        b'0'..=b'9' => Some((c - b'0') as u32),
        b'a'..=b'f' => Some((c - b'a' + 10) as u32),
        b'A'..=b'F' => Some((c - b'A' + 10) as u32),
        _ => None,
    }
}

/// Fixed-width hex fields: `width` digits each, as many as `text` holds.
fn fields(text: &str, width: usize) -> impl Iterator<Item = Option<u32>> + '_ {
    text.as_bytes().chunks_exact(width).map(|c| {
        c.iter().try_fold(0u32, |acc, &d| nib(d).map(|n| (acc << 4) | n))
    })
}

impl LcdScreen {
    /// Dispatch one `lcd*` op (voxel-spec.ts). False for a code it does not
    /// own; malformed args are no-ops.
    pub fn op(&mut self, code: u32, args: &[i32], text: Option<&str>) -> bool {
        let a = |i: usize| args.get(i).copied().unwrap_or(0);
        match code {
            op::LCD_SHOW => self.shown = a(0) != 0,
            op::LCD_RESET => {
                // banks survive: they are the run's fixed tile ids
                let (shown, serial, banks, n) = (self.shown, self.serial, self.banks, self.bank_count);
                *self = LcdScreen { shown, serial, banks, bank_count: n, ..LcdScreen::default() };
            }
            op::LCD_BANK => {
                let bank = LcdBank {
                    base: a(0).clamp(0, 0xffff) as u16,
                    page: a(1).max(0) as u16,
                    count: a(2).clamp(0, 0x10000 - a(0).clamp(0, 0xffff)) as u16,
                };
                let mut kept = [LcdBank::default(); LCD_BANKS_MAX];
                let mut n = 0;
                for b in &self.banks[..self.bank_count] {
                    let overlaps = (b.base as u32) < bank.base as u32 + bank.count as u32
                        && (bank.base as u32) < b.base as u32 + b.count as u32;
                    if !overlaps && n < LCD_BANKS_MAX - 1 {
                        kept[n] = *b;
                        n += 1;
                    }
                }
                kept[n] = bank;
                self.banks = kept;
                self.bank_count = n + 1;
            }
            op::LCD_CELLS => {
                // six digits a cell: tile (4) then attribute (2)
                let Some(t) = text else { return false };
                let at = a(0).clamp(0, 2047) as usize;
                for (i, f) in fields(t, 6).enumerate() {
                    let Some(v) = f else { continue };
                    if at + i >= 2048 {
                        break;
                    }
                    self.cells[at + i] = (v >> 8) as u16;
                    self.attrs[at + i] = v as u8;
                }
            }
            op::LCD_REGS => {
                self.scx = a(0) as u8;
                self.scy = a(1) as u8;
                self.wx = a(2) as u8;
                self.wy = a(3) as u8;
                self.flags = a(4) as u8;
            }
            op::LCD_OBJS => {
                // fourteen digits an object: y, x (signed 16), tile, attribute.
                // No text is no objects: the guest sends "" when the last one
                // goes, and the shim can hand an empty string over as none --
                // ignoring it left the title's Ho-Oh over the main menu.
                let t = text.unwrap_or("");
                let mut n = 0;
                for chunk in t.as_bytes().chunks_exact(14) {
                    if n == LCD_OBJS_MAX {
                        break;
                    }
                    let Ok(s) = core::str::from_utf8(chunk) else { continue };
                    let mut f = fields(s, 4);
                    let (Some(Some(y)), Some(Some(x)), Some(Some(tile))) = (f.next(), f.next(), f.next()) else {
                        continue;
                    };
                    let attr = fields(&s[12..], 2).next().flatten().unwrap_or(0);
                    self.objs[n] = LcdObj { y: y as u16 as i16, x: x as u16 as i16, tile: tile as u16, attr: attr as u8 };
                    n += 1;
                }
                self.obj_count = n;
            }
            op::LCD_PALS => {
                let Some(t) = text else { return false };
                let at = a(0).clamp(0, LCD_COLOURS as i32 - 1) as usize;
                for (i, f) in fields(t, 4).enumerate() {
                    if at + i >= LCD_COLOURS {
                        break;
                    }
                    if let Some(v) = f {
                        self.colours[at + i] = v as u16 & 0x7fff;
                    }
                }
            }
            op::LCD_UNDER => {
                // a map's worth at most (a 255x255-block map is far past any)
                let (w, h) = (a(0).clamp(0, 1024) as usize, a(1).clamp(0, 1024) as usize);
                self.under_w = w;
                self.under_h = h;
                self.under = alloc::vec![0; w * h];
                self.under_attr = alloc::vec![ATTR_HOLE; w * h];
                if w * h == 0 {
                    self.under_on = false;
                }
            }
            op::LCD_UNDER_ROW => {
                let Some(t) = text else { return false };
                let (row, x0) = (a(0), a(1));
                if row < 0 || row as usize >= self.under_h || x0 < 0 {
                    return false;
                }
                let base = row as usize * self.under_w;
                for (i, f) in fields(t, 6).enumerate() {
                    let x = x0 as usize + i;
                    if x >= self.under_w {
                        break;
                    }
                    let Some(v) = f else { continue };
                    self.under[base + x] = (v >> 8) as u16;
                    self.under_attr[base + x] = v as u8;
                }
            }
            op::LCD_UNDER_AT => {
                let (on, x, y) = (a(0) != 0 && self.under_w > 0, a(1), a(2));
                if on == self.under_on && x == self.under_x && y == self.under_y {
                    return true;
                }
                self.under_on = on;
                self.under_x = x;
                self.under_y = y;
            }
            op::LCD_LINES => {
                self.line_target = a(0).clamp(0, 2) as u8;
                if let Some(t) = text {
                    for (i, f) in fields(t, 2).enumerate().take(LCD_H) {
                        if let Some(v) = f {
                            self.lines[i] = v as u8;
                        }
                    }
                }
            }
            _ => return false,
        }
        self.serial = self.serial.wrapping_add(1);
        true
    }

    /// The page and tile a tile id holds, or None outside every bank.
    pub fn tile_source(&self, id: u16) -> Option<(u16, u16)> {
        self.banks[..self.bank_count]
            .iter()
            .rev()
            .find(|b| id >= b.base && (id as u32) < b.base as u32 + b.count as u32)
            .map(|b| (b.page, id - b.base))
    }

    /// An RGB555 colour as the host's 0xAABBGGRR.
    pub fn abgr(c555: u16) -> u32 {
        let e = |v: u16| {
            let v = (v & 31) as u32;
            (v << 3) | (v >> 2)
        };
        0xff00_0000 | (e(c555 >> 10) << 16) | (e(c555 >> 5) << 8) | e(c555)
    }

    /// Draw the frame into `out` (LCD_W * LCD_H). `pixel(page, tile, x, y)`
    /// is a sheet tile's raw colour 0-3.
    pub fn render(&self, pixel: &mut impl FnMut(u16, u16, u8, u8) -> u8, out: &mut [u8]) {
        self.render_rows(
            &mut |page, tile, y| {
                let mut r = [0u8; 8];
                for (x, c) in r.iter_mut().enumerate() {
                    *c = pixel(page, tile, x as u8, y);
                }
                r
            },
            out,
        );
    }

    /// `render`, with the sheet read a tile row at a time: `row(page, tile,
    /// y)` is that tile's row `y`, eight raw colours 0-3. This is the one the
    /// 3DS host calls: a map row reads each tile's row eight pixels running,
    /// so the host's page lookup runs once per tile per line.
    pub fn render_rows(&self, row: &mut impl FnMut(u16, u16, u8) -> [u8; 8], out: &mut [u8]) {
        if out.len() < LCD_W * LCD_H {
            return;
        }
        // The bank a tile id falls in, remembered: neighbouring cells almost
        // always share one, so the search runs once per change of bank
        // rather than once per pixel.
        let mut hit: Option<LcdBank> = None;
        let mut last_key: u32 = u32::MAX;
        let mut last_row = [0u8; 8];
        // A tile's row `y`, eight raw colours (masked to 0-3), the last one
        // remembered.
        let mut fetch = |id: u16, y: u8| -> [u8; 8] {
            let key = ((id as u32) << 3) | (y as u32 & 7);
            if key != last_key {
                let inside = |b: &LcdBank| id >= b.base && (id as u32) < b.base as u32 + b.count as u32;
                if !hit.as_ref().is_some_and(inside) {
                    hit = self.banks[..self.bank_count].iter().rev().find(|b| inside(b)).copied();
                }
                last_row = match hit {
                    Some(b) => row(b.page, id - b.base, y),
                    None => [0; 8],
                };
                for c in last_row.iter_mut() {
                    *c &= 3;
                }
                last_key = key;
            }
            last_row
        };
        // per pixel of the line: the map colour drawn, and whether that cell
        // keeps its colours above objects
        let mut bg_col = [0u8; LCD_W];
        let mut bg_pri = [false; LCD_W];
        let mut win_line: usize = 0;
        for ly in 0..LCD_H {
            let line = &mut out[ly * LCD_W..(ly + 1) * LCD_W];
            line.fill(LCD_HOLE);
            bg_col.fill(0);
            bg_pri.fill(false);
            let scy = if self.line_target == 1 { self.lines[ly] } else { self.scy };
            let scx = if self.line_target == 2 { self.lines[ly] } else { self.scx };
            // Screen pixels [x, x + n) from one cell of a map: the cell's
            // row fetched once, its pixels from column px0 on. A hole cell
            // leaves them as they are, unless `hole_clears` (the window: a
            // window hole is a hole, not the background under it).
            let mut span = |line: &mut [u8], bg_col: &mut [u8; LCD_W], bg_pri: &mut [bool; LCD_W],
                            i: usize, py: usize, x: usize, px0: usize, n: usize, hole_clears: bool| {
                let attr = self.attrs[i];
                if attr & ATTR_HOLE != 0 {
                    if hole_clears {
                        for k in x..x + n {
                            line[k] = LCD_HOLE;
                            bg_col[k] = 0;
                            bg_pri[k] = false;
                        }
                    } else if self.under_on {
                        // the under layer's pixels for [x, x + n) of line ly
                        let gy = self.under_y + ly as i32;
                        if gy < 0 || gy as usize >= self.under_h * 8 {
                            return;
                        }
                        let (urow, upy) = ((gy >> 3) as usize * self.under_w, (gy & 7) as u8);
                        for k in x..x + n {
                            let gx = self.under_x + k as i32;
                            if gx < 0 || gx as usize >= self.under_w * 8 {
                                continue;
                            }
                            let j = urow + (gx >> 3) as usize;
                            let ua = self.under_attr[j];
                            if ua & ATTR_HOLE != 0 {
                                continue;
                            }
                            let ty = if ua & ATTR_Y_FLIP != 0 { 7 - upy } else { upy };
                            let r = fetch(self.under[j], ty);
                            let px = (gx & 7) as usize;
                            let c = r[if ua & ATTR_X_FLIP != 0 { 7 - px } else { px }];
                            line[k] = (ua & ATTR_PAL) * 4 + c;
                            bg_col[k] = c;
                            bg_pri[k] = ua & ATTR_PRIORITY != 0;
                        }
                    }
                    return;
                }
                let ty = if attr & ATTR_Y_FLIP != 0 { 7 - py } else { py };
                let r = fetch(self.cells[i], ty as u8);
                let base = (attr & ATTR_PAL) * 4;
                let pri = attr & ATTR_PRIORITY != 0;
                let flip = attr & ATTR_X_FLIP != 0;
                for k in 0..n {
                    let px = px0 + k;
                    let c = r[if flip { 7 - px } else { px }];
                    line[x + k] = base + c;
                    bg_col[x + k] = c;
                    bg_pri[x + k] = pri;
                }
            };
            if self.flags & FLAG_BG_ON != 0 {
                let by = (ly as u8).wrapping_add(scy) as usize;
                let rowi = ((by >> 3) & 31) * 32;
                let mut x = 0;
                while x < LCD_W {
                    let bx = (x as u8).wrapping_add(scx) as usize;
                    let px0 = bx & 7;
                    let n = (8 - px0).min(LCD_W - x);
                    span(line, &mut bg_col, &mut bg_pri, rowi + ((bx >> 3) & 31), by & 7, x, px0, n, false);
                    x += n;
                }
            }
            if self.flags & FLAG_WIN_ON != 0 && ly >= self.wy as usize && self.wx <= 166 {
                let x0 = (self.wx as usize).saturating_sub(7);
                let rowi = 1024 + ((win_line >> 3) & 31) * 32;
                let mut x = x0;
                while x < LCD_W {
                    let wx = x + 7 - self.wx as usize;
                    let px0 = wx & 7;
                    let n = (8 - px0).min(LCD_W - x);
                    span(line, &mut bg_col, &mut bg_pri, rowi + ((wx >> 3) & 31), win_line & 7, x, px0, n, true);
                    x += n;
                }
                win_line += 1;
            }
            if self.flags & FLAG_OBJ_ON == 0 {
                continue;
            }
            let tall = self.flags & FLAG_OBJ_TALL != 0;
            let h: i32 = if tall { 16 } else { 8 };
            // a lower index on top (CGB): draw from the last one back
            for o in self.objs[..self.obj_count].iter().rev() {
                let mut ty = ly as i32 - o.y as i32;
                if !(0..h).contains(&ty) {
                    continue;
                }
                if o.attr & ATTR_Y_FLIP != 0 {
                    ty = h - 1 - ty;
                }
                let tile = if tall { (o.tile & !1) + (ty >= 8) as u16 } else { o.tile };
                let r = fetch(tile, (ty & 7) as u8);
                for px in 0..8i32 {
                    let x = o.x as i32 + px;
                    if !(0..LCD_W as i32).contains(&x) {
                        continue;
                    }
                    let x = x as usize;
                    let tx = if o.attr & ATTR_X_FLIP != 0 { 7 - px } else { px };
                    let c = r[tx as usize];
                    if c == 0 {
                        continue;
                    }
                    if bg_col[x] != 0 && (bg_pri[x] || o.attr & ATTR_PRIORITY != 0) {
                        continue;
                    }
                    line[x] = (16 + (o.attr & ATTR_PAL)) * 4 + c;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::format;
    use alloc::string::String;
    use alloc::vec;

    /// Tile t's pixels are all colour t % 4.
    fn flat(_page: u16, tile: u16, _x: u8, _y: u8) -> u8 {
        (tile % 4) as u8
    }

    fn frame(lcd: &LcdScreen) -> alloc::vec::Vec<u8> {
        let mut out = vec![0u8; LCD_W * LCD_H];
        lcd.render(&mut flat, &mut out);
        out
    }

    #[test]
    fn an_empty_object_list_clears_the_objects() {
        let mut lcd = LcdScreen::default();
        assert!(lcd.op(op::LCD_OBJS, &[], Some("00100020000500")));
        assert_eq!(lcd.obj_count, 1);
        // the last object gone: "" or no text at all
        assert!(lcd.op(op::LCD_OBJS, &[], Some("")));
        assert_eq!(lcd.obj_count, 0);
        assert!(lcd.op(op::LCD_OBJS, &[], Some("00100020000500")));
        assert!(lcd.op(op::LCD_OBJS, &[], None));
        assert_eq!(lcd.obj_count, 0);
    }

    #[test]
    fn the_under_layer_shows_through_background_holes_at_its_camera() {
        let mut lcd = LcdScreen::default();
        lcd.op(op::LCD_BANK, &[0, 1, 256], None);
        // a 4x2-cell layer: tile 1 in palette 2 everywhere but cell (0, 0),
        // tile 2 there
        lcd.op(op::LCD_UNDER, &[4, 2], None);
        lcd.op(op::LCD_UNDER_ROW, &[0, 0], Some("000200000102000102000102"));
        lcd.op(op::LCD_UNDER_ROW, &[1, 0], Some("000102000102000102000102"));
        assert!(frame(&lcd).iter().all(|&p| p == LCD_HOLE), "off until lcdUnderAt");
        lcd.op(op::LCD_UNDER_AT, &[1, 4, 0], None);
        let f = frame(&lcd);
        // screen x 0..4 is the layer's x 4..8: cell (0, 0), tile 2, palette 0
        assert_eq!(f[0], 2);
        assert_eq!(f[4], 2 * 4 + 1);
        // past the layer's right edge (x 28 on): a hole
        assert_eq!(f[28], LCD_HOLE);
        // a cell over it covers it
        lcd.op(op::LCD_CELLS, &[0], Some("000303"));
        assert_eq!(frame(&lcd)[0], 3 * 4 + 3);
        // and lcdReset drops it
        lcd.op(op::LCD_RESET, &[], None);
        assert!(frame(&lcd).iter().all(|&p| p == LCD_HOLE));
    }

    #[test]
    fn a_fresh_screen_is_all_hole() {
        let lcd = LcdScreen::default();
        assert!(frame(&lcd).iter().all(|&p| p == LCD_HOLE));
    }

    #[test]
    fn cells_draw_through_their_palette_and_banks() {
        let mut lcd = LcdScreen::default();
        assert!(lcd.op(op::LCD_BANK, &[1000, 5, 64], None));
        assert_eq!(lcd.tile_source(1003), Some((5, 3)));
        assert_eq!(lcd.tile_source(999), None);
        // cell (1,0): tile 1003 (colour 3), palette 2
        assert!(lcd.op(op::LCD_CELLS, &[1], Some("03eb02")));
        let f = frame(&lcd);
        assert_eq!(f[8], 2 * 4 + 3);
        assert_eq!(f[0], LCD_HOLE);
        // a reset keeps the banks
        lcd.op(op::LCD_RESET, &[], None);
        assert_eq!(lcd.tile_source(1003), Some((5, 3)));
    }

    #[test]
    fn objects_sit_over_the_map_unless_it_has_priority() {
        let mut lcd = LcdScreen::default();
        lcd.op(op::LCD_BANK, &[0, 1, 256], None);
        // the whole first row: tile 1 (colour 1), palette 0
        let row: String = (0..32).map(|_| "000100").collect();
        lcd.op(op::LCD_CELLS, &[0], Some(&row));
        // object at (4, 2), tile 2, palette 3
        lcd.op(op::LCD_OBJS, &[], Some("00020004000203"));
        let f = frame(&lcd);
        assert_eq!(f[2 * LCD_W + 4], (16 + 3) * 4 + 2);
        assert_eq!(f[2 * LCD_W + 3], 1);
        // negative coordinates clip
        lcd.op(op::LCD_OBJS, &[], Some(&format!("{:04x}{:04x}000200", 0u16, (-4i16) as u16)));
        let f = frame(&lcd);
        assert_eq!(f[3], (16) * 4 + 2);
        assert_eq!(f[4], 1);
        // priority on the cell hides the object where the map has colour
        let row: String = (0..32).map(|_| "000180").collect();
        lcd.op(op::LCD_CELLS, &[0], Some(&row));
        let f = frame(&lcd);
        assert_eq!(f[3], 1);
    }

    #[test]
    fn the_window_covers_and_its_holes_uncover() {
        let mut lcd = LcdScreen::default();
        lcd.op(op::LCD_BANK, &[0, 1, 256], None);
        let row: String = (0..32).map(|_| "000100").collect();
        for r in 0..18 {
            lcd.op(op::LCD_CELLS, &[r * 32], Some(&row));
        }
        // window from line 16, its first row a hole, its second tile 3
        let hole: String = (0..32).map(|_| "000010").collect();
        let three: String = (0..32).map(|_| "000301").collect();
        lcd.op(op::LCD_CELLS, &[1024], Some(&hole));
        lcd.op(op::LCD_CELLS, &[1024 + 32], Some(&three));
        lcd.op(op::LCD_REGS, &[0, 0, 7, 16, (FLAG_BG_ON | FLAG_WIN_ON) as i32], None);
        let f = frame(&lcd);
        assert_eq!(f[0], 1);
        assert_eq!(f[16 * LCD_W], LCD_HOLE);
        assert_eq!(f[24 * LCD_W], 4 + 3);
    }

    #[test]
    fn palettes_expand_to_abgr() {
        let mut lcd = LcdScreen::default();
        lcd.op(op::LCD_PALS, &[4], Some("7fff001f"));
        assert_eq!(lcd.colours[4], 0x7fff);
        assert_eq!(LcdScreen::abgr(lcd.colours[4]), 0xffff_ffff);
        assert_eq!(LcdScreen::abgr(lcd.colours[5]), 0xff00_00ff);
    }
}
