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
/// `lcdAlias` slots.
pub const LCD_ALIASES: usize = 16;
/// Objects the under canvas carries (`lcdUnderObjsBin`): the people on a
/// widened or zoomed-out 2D map.
pub const LCD_UNDER_OBJS_MAX: usize = 160;
/// The largest under canvas (`lcdUnderView`): what fits one 1024x512
/// texture (2D ZOOM OUT's farthest steps; the host keeps a 512x256 one for
/// a canvas that fits in it).
pub const LCD_VIEW_W_MAX: usize = 1024;
pub const LCD_VIEW_H_MAX: usize = 512;

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
    /// `lcdAlias`: the under layer's tile `.0` draws as `.1` (animation);
    /// `alias_n` slots from the front may be in use, u16::MAX marks empty.
    pub aliases: [(u16, u16); LCD_ALIASES],
    pub alias_n: usize,
    /// `lcdUnderView`: the under layer drawn as a canvas of its own,
    /// `view_w` x `view_h` pixels, rather than under the background's holes
    /// -- VIEW 2D widened to the screen's edges or zoomed out, the screen's
    /// own 160x144 centred in it. 0 x 0: off. `view_wide`: the canvas fills
    /// the whole top screen rather than the Gold screen's box.
    /// `lcdTall`: shown whole, 160x144 (the 3DS bottom screen otherwise
    /// shows its top 160x120 at 2x).
    pub tall: bool,
    pub view_w: u16,
    pub view_h: u16,
    pub view_wide: bool,
    /// The canvas's objects (the people), at screen coordinates -- the
    /// 160x144's own -- drawn over the canvas's map with its priority rules.
    pub under_objs: [LcdObj; LCD_UNDER_OBJS_MAX],
    pub under_obj_count: usize,
    /// Bumped when the under layer's cells change (a new map, rows sent):
    /// what the host's canvas caches has to be drawn again.
    pub under_serial: u32,
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
            aliases: [(u16::MAX, 0); LCD_ALIASES],
            alias_n: 0,
            tall: false,
            view_w: 0,
            view_h: 0,
            view_wide: false,
            under_objs: [LcdObj::default(); LCD_UNDER_OBJS_MAX],
            under_obj_count: 0,
            under_serial: 0,
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
                self.under_serial = self.under_serial.wrapping_add(1);
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
                self.under_serial = self.under_serial.wrapping_add(1);
            }
            op::LCD_TALL => {
                let on = a(0) != 0;
                if on == self.tall {
                    return true;
                }
                self.tall = on;
            }
            op::LCD_UNDER_VIEW => {
                let (w, h) = (a(0).clamp(0, LCD_VIEW_W_MAX as i32) as u16, a(1).clamp(0, LCD_VIEW_H_MAX as i32) as u16);
                let wide = a(2) != 0;
                if w == self.view_w && h == self.view_h && wide == self.view_wide {
                    return true;
                }
                self.view_w = w;
                self.view_h = h;
                self.view_wide = wide;
            }
            op::LCD_ALIAS => {
                let slot = a(0);
                if !(0..LCD_ALIASES as i32).contains(&slot) {
                    return false;
                }
                let want = if a(1) < 0 { (u16::MAX, 0) } else { (a(1).min(0xfffe) as u16, a(2).clamp(0, 0xffff) as u16) };
                if self.aliases[slot as usize] == want {
                    return true;
                }
                self.aliases[slot as usize] = want;
                self.alias_n = self.aliases.iter().rposition(|x| x.0 != u16::MAX).map_or(0, |i| i + 1);
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

    /// The whole cell map at once, as the guest holds it (`lcdCellsBin`, the
    /// 3DS shim's typed-array path): copied, and the serial bumped, only when
    /// it differs from what is here. The guest's own row diff and hex were
    /// most of sending a frame under QuickJS; a memcmp here is nothing.
    pub fn set_cells(&mut self, cells: &[u16], attrs: &[u8]) -> bool {
        let n = cells.len().min(attrs.len()).min(self.cells.len());
        if self.cells[..n] == cells[..n] && self.attrs[..n] == attrs[..n] {
            return false;
        }
        self.cells[..n].copy_from_slice(&cells[..n]);
        self.attrs[..n].copy_from_slice(&attrs[..n]);
        self.serial = self.serial.wrapping_add(1);
        true
    }

    /// The object list at once (`lcdObjsBin`): `count` objects packed four
    /// i16s each -- y, x, tile, attribute. Bumps the serial only on a change.
    pub fn set_objs(&mut self, packed: &[i16], count: usize) -> bool {
        let n = count.min(packed.len() / 4).min(LCD_OBJS_MAX);
        let mut changed = n != self.obj_count;
        for i in 0..n {
            let p = &packed[i * 4..i * 4 + 4];
            let o = LcdObj { y: p[0], x: p[1], tile: p[2] as u16, attr: p[3] as u8 };
            if self.objs[i] != o {
                self.objs[i] = o;
                changed = true;
            }
        }
        self.obj_count = n;
        if changed {
            self.serial = self.serial.wrapping_add(1);
        }
        changed
    }

    /// The per-line registers at once (`lcdLinesBin`): `target` as LCD_LINES
    /// takes it, the lines read only when it is 1 or 2.
    pub fn set_lines(&mut self, target: u8, lines: &[u8]) -> bool {
        let target = target.min(2);
        let mut changed = target != self.line_target;
        self.line_target = target;
        if target != 0 {
            let n = lines.len().min(LCD_H);
            if self.lines[..n] != lines[..n] {
                self.lines[..n].copy_from_slice(&lines[..n]);
                changed = true;
            }
        }
        if changed {
            self.serial = self.serial.wrapping_add(1);
        }
        changed
    }

    /// The under layer's cells at once (`lcdUnderBin`, after LCD_UNDER sized
    /// it): the tile ids and attributes as the guest holds them. As hex rows
    /// (LCD_UNDER_ROW) a Goldenrod-sized grid was ~7 ms of QuickJS on the PC
    /// -- most of a second on the console -- at every map change.
    pub fn set_under(&mut self, cells: &[u16], attrs: &[u8]) {
        let n = cells.len().min(attrs.len()).min(self.under.len()).min(self.under_attr.len());
        self.under[..n].copy_from_slice(&cells[..n]);
        self.under_attr[..n].copy_from_slice(&attrs[..n]);
        self.under_serial = self.under_serial.wrapping_add(1);
        self.serial = self.serial.wrapping_add(1);
    }

    /// The canvas's objects at once (`lcdUnderObjsBin`), as set_objs takes
    /// the screen's. Bumps the serial only on a change.
    pub fn set_under_objs(&mut self, packed: &[i16], count: usize) -> bool {
        let n = count.min(packed.len() / 4).min(LCD_UNDER_OBJS_MAX);
        let mut changed = n != self.under_obj_count;
        for i in 0..n {
            let p = &packed[i * 4..i * 4 + 4];
            let o = LcdObj { y: p[0], x: p[1], tile: p[2] as u16, attr: p[3] as u8 };
            if self.under_objs[i] != o {
                self.under_objs[i] = o;
                changed = true;
            }
        }
        self.under_obj_count = n;
        if changed {
            self.serial = self.serial.wrapping_add(1);
        }
        changed
    }

    /// The under layer drawn as its own canvas this frame (`lcdUnderView`):
    /// then render_rows leaves the background's holes clear, and the host
    /// draws the canvas behind the screen (canvas_tile, canvas_objects).
    pub fn canvas_on(&self) -> bool {
        self.under_on && self.view_w > 0 && self.view_h > 0
    }

    /// Where the screen's own 160x144 sits in the canvas: its top-left, in
    /// canvas pixels.
    pub fn canvas_origin(&self) -> (i32, i32) {
        ((self.view_w as i32 - LCD_W as i32) / 2, (self.view_h as i32 - LCD_H as i32) / 2)
    }

    /// The under layer's pixel at the canvas's top-left.
    pub fn canvas_under_xy(&self) -> (i32, i32) {
        let (ox, oy) = self.canvas_origin();
        (self.under_x - ox, self.under_y - oy)
    }

    /// Under cell (tx, ty)'s 8x8 pixels, row-major, slot*4+colour each (an
    /// alias applied), or None for a hole or a cell past the layer: what the
    /// canvas shows there. `row` is render_rows' tile-row source.
    pub fn canvas_tile(&self, row: &mut impl FnMut(u16, u16, u8) -> [u8; 8], tx: i32, ty: i32,
                       out: &mut [u8; 64]) -> bool {
        if tx < 0 || ty < 0 || tx as usize >= self.under_w || ty as usize >= self.under_h {
            return false;
        }
        let j = ty as usize * self.under_w + tx as usize;
        let ua = self.under_attr[j];
        if ua & ATTR_HOLE != 0 {
            return false;
        }
        let mut id = self.under[j];
        for al in &self.aliases[..self.alias_n] {
            if al.0 == id {
                id = al.1;
                break;
            }
        }
        let mut fetch = RowFetch {
            banks: &self.banks[..self.bank_count],
            row,
            hit: None,
            last_key: u32::MAX,
            last_row: [0; 8],
        };
        let base = (ua & ATTR_PAL) * 4;
        for y in 0..8u8 {
            let mut r = fetch.get(id, if ua & ATTR_Y_FLIP != 0 { 7 - y } else { y });
            if ua & ATTR_X_FLIP != 0 {
                r.reverse();
            }
            for x in 0..8 {
                out[y as usize * 8 + x] = base + r[x];
            }
        }
        true
    }

    /// The canvas's objects over its map: `put(cx, cy, pixel)` for every
    /// object pixel that shows, in canvas pixels (clipped to the canvas),
    /// pixel = (16 + palette) * 4 + colour -- render_rows' object rules
    /// against the under layer's colour and priority there, a lower index on
    /// top.
    pub fn canvas_objects(&self, row: &mut impl FnMut(u16, u16, u8) -> [u8; 8],
                          put: &mut impl FnMut(i32, i32, u8)) {
        let objs = &self.under_objs[..self.under_obj_count];
        if objs.is_empty() {
            return;
        }
        let (ox, oy) = self.canvas_origin();
        let (gx0, gy0) = self.canvas_under_xy();
        let (vw, vh) = (self.view_w as i32, self.view_h as i32);
        let tall = self.flags & FLAG_OBJ_TALL != 0;
        let h: i32 = if tall { 16 } else { 8 };
        let mut fetch = RowFetch {
            banks: &self.banks[..self.bank_count],
            row,
            hit: None,
            last_key: u32::MAX,
            last_row: [0; 8],
        };
        // the pixels already put this frame (a lower index wins): one bit each
        let mut taken = alloc::vec![0u32; (vw as usize * vh as usize).div_ceil(32)];
        for o in objs.iter() {
            for ty in 0..h {
                let cy = o.y as i32 + ty + oy;
                if !(0..vh).contains(&cy) {
                    continue;
                }
                let sy = if o.attr & ATTR_Y_FLIP != 0 { h - 1 - ty } else { ty };
                let tile = if tall { (o.tile & !1) + (sy >= 8) as u16 } else { o.tile };
                let r = fetch.get(tile, (sy & 7) as u8);
                for px in 0..8i32 {
                    let cx = o.x as i32 + px + ox;
                    if !(0..vw).contains(&cx) {
                        continue;
                    }
                    let c = r[if o.attr & ATTR_X_FLIP != 0 { 7 - px } else { px } as usize];
                    if c == 0 {
                        continue;
                    }
                    let k = (cy * vw + cx) as usize;
                    if taken[k >> 5] & (1 << (k & 31)) != 0 {
                        continue;
                    }
                    // the map's colour and priority under this pixel
                    let (gx, gy) = (gx0 + cx, gy0 + cy);
                    let (bg_c, bg_pri) = self.under_pixel(&mut fetch, gx, gy);
                    if bg_c != 0 && (bg_pri || o.attr & ATTR_PRIORITY != 0) {
                        continue;
                    }
                    taken[k >> 5] |= 1 << (k & 31);
                    put(cx, cy, (16 + (o.attr & ATTR_PAL)) * 4 + c);
                }
            }
        }
    }

    /// The under layer's raw colour (0-3) and priority at its pixel (gx, gy);
    /// (0, false) on a hole or past the layer.
    fn under_pixel<F: FnMut(u16, u16, u8) -> [u8; 8]>(&self, fetch: &mut RowFetch<'_, F>, gx: i32, gy: i32) -> (u8, bool) {
        if gx < 0 || gy < 0 || gx as usize >= self.under_w * 8 || gy as usize >= self.under_h * 8 {
            return (0, false);
        }
        let j = (gy >> 3) as usize * self.under_w + (gx >> 3) as usize;
        let ua = self.under_attr[j];
        if ua & ATTR_HOLE != 0 {
            return (0, false);
        }
        let mut id = self.under[j];
        for al in &self.aliases[..self.alias_n] {
            if al.0 == id {
                id = al.1;
                break;
            }
        }
        let y = (gy & 7) as u8;
        let r = fetch.get(id, if ua & ATTR_Y_FLIP != 0 { 7 - y } else { y });
        let x = (gx & 7) as usize;
        (r[if ua & ATTR_X_FLIP != 0 { 7 - x } else { x }], ua & ATTR_PRIORITY != 0)
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
        let mut fetch = RowFetch {
            banks: &self.banks[..self.bank_count],
            row,
            hit: None,
            last_key: u32::MAX,
            last_row: [0; 8],
        };
        // per pixel of the line: the map colour drawn, and whether that cell
        // keeps its colours above objects -- kept only on a line an object
        // touches (most lines of a menu or of VIEW 2D have none)
        let mut bg_col = [0u8; LCD_W];
        let mut bg_pri = [false; LCD_W];
        let objs = &self.objs[..self.obj_count];
        let obj_on = self.flags & FLAG_OBJ_ON != 0 && !objs.is_empty();
        let tall = self.flags & FLAG_OBJ_TALL != 0;
        let h: i32 = if tall { 16 } else { 8 };
        let mut win_line: usize = 0;
        // VIEW 2D: the under layer drawn first, a tile at a time, wherever
        // the screen shows it -- a line no object touches then draws only
        // the background's own cells over it, not the layer's row of each
        // of its holes (most of the screen, every frame the map scrolls)
        // (a canvas: the under layer is the host's to draw, behind the screen)
        let under = self.under_on && !self.canvas_on();
        let blocks = under && self.flags & FLAG_BG_ON != 0;
        // which of the layer's pixels keep their colours above objects, a
        // bit each (an object's line reads it back with the colours)
        let mut under_pri = [0u32; LCD_W * LCD_H / 32];
        if blocks {
            out[..LCD_W * LCD_H].fill(LCD_HOLE);
            self.under_blocks(&mut fetch, out, &mut under_pri);
        }
        for ly in 0..LCD_H {
            let line = &mut out[ly * LCD_W..(ly + 1) * LCD_W];
            let lyi = ly as i32;
            let keep = obj_on && objs.iter().any(|o| (0..h).contains(&(lyi - o.y as i32)));
            // the layer already on this line: its pixels stay under the
            // holes, and an object's line reads the colours under it back
            // (colour = the pixel's low two bits; a layer hole is colour 0)
            let laid = blocks;
            if !laid {
                line.fill(LCD_HOLE);
            }
            if keep {
                if laid {
                    for (x, &v) in line.iter().enumerate() {
                        bg_col[x] = if v == LCD_HOLE { 0 } else { v & 3 };
                        let k = ly * LCD_W + x;
                        bg_pri[x] = under_pri[k >> 5] & (1 << (k & 31)) != 0;
                    }
                } else {
                    bg_col.fill(0);
                    bg_pri.fill(false);
                }
            }
            let mut px = Line { line, bg_col: &mut bg_col, bg_pri: &mut bg_pri, keep };
            let scy = if self.line_target == 1 { self.lines[ly] } else { self.scy };
            let scx = if self.line_target == 2 { self.lines[ly] } else { self.scx };
            if self.flags & FLAG_BG_ON != 0 {
                let by = (ly as u8).wrapping_add(scy) as usize;
                let rowi = ((by >> 3) & 31) * 32;
                let py = (by & 7) as u8;
                let mut x = 0;
                while x < LCD_W {
                    let bx = (x as u8).wrapping_add(scx) as usize;
                    let px0 = bx & 7;
                    let n = (8 - px0).min(LCD_W - x);
                    let i = rowi + ((bx >> 3) & 31);
                    let attr = self.attrs[i];
                    if attr & ATTR_HOLE == 0 {
                        px.cell(&mut fetch, self.cells[i], attr, py, x, px0, n);
                    } else if under && !laid {
                        self.under_run(&mut fetch, &mut px, ly, x, n);
                    }
                    x += n;
                }
            }
            if self.flags & FLAG_WIN_ON != 0 && ly >= self.wy as usize && self.wx <= 166 {
                let x0 = (self.wx as usize).saturating_sub(7);
                let rowi = 1024 + ((win_line >> 3) & 31) * 32;
                let py = (win_line & 7) as u8;
                let mut x = x0;
                while x < LCD_W {
                    let wx = x + 7 - self.wx as usize;
                    let px0 = wx & 7;
                    let n = (8 - px0).min(LCD_W - x);
                    let i = rowi + ((wx >> 3) & 31);
                    let attr = self.attrs[i];
                    if attr & ATTR_HOLE == 0 {
                        px.cell(&mut fetch, self.cells[i], attr, py, x, px0, n);
                    } else {
                        // a window hole is a hole, not the background under it
                        px.line[x..x + n].fill(LCD_HOLE);
                        if px.keep {
                            px.bg_col[x..x + n].fill(0);
                            px.bg_pri[x..x + n].fill(false);
                        }
                    }
                    x += n;
                }
                win_line += 1;
            }
            if !keep {
                continue;
            }
            // a lower index on top (CGB): draw from the last one back
            for o in objs.iter().rev() {
                let mut ty = lyi - o.y as i32;
                if !(0..h).contains(&ty) {
                    continue;
                }
                if o.attr & ATTR_Y_FLIP != 0 {
                    ty = h - 1 - ty;
                }
                let tile = if tall { (o.tile & !1) + (ty >= 8) as u16 } else { o.tile };
                let r = fetch.get(tile, (ty & 7) as u8);
                for p in 0..8i32 {
                    let x = o.x as i32 + p;
                    if !(0..LCD_W as i32).contains(&x) {
                        continue;
                    }
                    let x = x as usize;
                    let tx = if o.attr & ATTR_X_FLIP != 0 { 7 - p } else { p };
                    let c = r[tx as usize];
                    if c == 0 {
                        continue;
                    }
                    if px.bg_col[x] != 0 && (px.bg_pri[x] || o.attr & ATTR_PRIORITY != 0) {
                        continue;
                    }
                    px.line[x] = (16 + (o.attr & ATTR_PAL)) * 4 + c;
                }
            }
        }
    }

    /// Screen pixels [x, x + n) of line `ly` from the under layer (the
    /// background is a hole there): an under cell's row at a time, a hole
    /// cell spanning at most two of them.
    fn under_run<F: FnMut(u16, u16, u8) -> [u8; 8]>(&self, fetch: &mut RowFetch<'_, F>, px: &mut Line<'_>,
                                                    ly: usize, x: usize, n: usize) {
        let gy = self.under_y + ly as i32;
        if gy < 0 || gy as usize >= self.under_h * 8 {
            return;
        }
        let (urow, upy) = ((gy >> 3) as usize * self.under_w, (gy & 7) as u8);
        let mut k = x;
        while k < x + n {
            let gx = self.under_x + k as i32;
            let px0 = (gx & 7) as usize;
            let run = (8 - px0).min(x + n - k);
            if gx >= 0 && (gx as usize) < self.under_w * 8 {
                let j = urow + (gx >> 3) as usize;
                let ua = self.under_attr[j];
                if ua & ATTR_HOLE == 0 {
                    let mut id = self.under[j];
                    for al in &self.aliases[..self.alias_n] {
                        if al.0 == id {
                            id = al.1;
                            break;
                        }
                    }
                    px.cell(fetch, id, ua, upy, k, px0, run);
                }
            }
            k += run;
        }
    }

    /// The under layer over the whole screen (`out` already all hole), an
    /// 8x8 cell at a time: what under_run draws under every background hole
    /// of every line, for render_rows to draw the background's own cells
    /// over.
    fn under_blocks<F: FnMut(u16, u16, u8) -> [u8; 8]>(&self, fetch: &mut RowFetch<'_, F>, out: &mut [u8],
                                                       pri: &mut [u32; LCD_W * LCD_H / 32]) {
        let (ux, uy) = (self.under_x, self.under_y);
        let r0 = (uy >> 3).max(0);
        let r1 = ((uy + LCD_H as i32 - 1) >> 3).min(self.under_h as i32 - 1);
        let c0 = (ux >> 3).max(0);
        let c1 = ((ux + LCD_W as i32 - 1) >> 3).min(self.under_w as i32 - 1);
        for r in r0..=r1 {
            // the screen lines this cell row covers
            let top = r * 8 - uy;
            let (y0, y1) = (top.max(0), (top + 8).min(LCD_H as i32));
            for c in c0..=c1 {
                let j = r as usize * self.under_w + c as usize;
                let ua = self.under_attr[j];
                if ua & ATTR_HOLE != 0 {
                    continue;
                }
                let mut id = self.under[j];
                for al in &self.aliases[..self.alias_n] {
                    if al.0 == id {
                        id = al.1;
                        break;
                    }
                }
                let left = c * 8 - ux;
                let (x0, x1) = (left.max(0) as usize, (left + 8).min(LCD_W as i32) as usize);
                let px0 = x0 - left as usize;
                let n = x1 - x0;
                let base = (ua & ATTR_PAL) * 4;
                for y in y0..y1 {
                    let ty = (y - top) as u8;
                    let mut row = fetch.get(id, if ua & ATTR_Y_FLIP != 0 { 7 - ty } else { ty });
                    if ua & ATTR_X_FLIP != 0 {
                        row.reverse();
                    }
                    let at = y as usize * LCD_W + x0;
                    for (d, &v) in out[at..at + n].iter_mut().zip(&row[px0..px0 + n]) {
                        *d = base + v;
                    }
                    if ua & ATTR_PRIORITY != 0 {
                        for k in at..at + n {
                            pri[k >> 5] |= 1 << (k & 31);
                        }
                    }
                }
            }
        }
    }
}

/// render_rows' tile-row source: the bank a tile id falls in, remembered
/// (neighbouring cells almost always share one, so the search runs once per
/// change of bank rather than once per pixel), and the last row fetched.
struct RowFetch<'a, F> {
    banks: &'a [LcdBank],
    row: &'a mut F,
    hit: Option<LcdBank>,
    last_key: u32,
    last_row: [u8; 8],
}

impl<F: FnMut(u16, u16, u8) -> [u8; 8]> RowFetch<'_, F> {
    /// Tile `id`'s row `y`: eight raw colours, masked to 0-3.
    fn get(&mut self, id: u16, y: u8) -> [u8; 8] {
        let key = ((id as u32) << 3) | (y as u32 & 7);
        if key != self.last_key {
            let inside = |b: &LcdBank| id >= b.base && (id as u32) < b.base as u32 + b.count as u32;
            if !self.hit.as_ref().is_some_and(inside) {
                self.hit = self.banks.iter().rev().find(|b| inside(b)).copied();
            }
            self.last_row = match self.hit {
                Some(b) => (self.row)(b.page, id - b.base, y),
                None => [0; 8],
            };
            for c in self.last_row.iter_mut() {
                *c &= 3;
            }
            self.last_key = key;
        }
        self.last_row
    }
}

/// One line being drawn: its pixels, and (when an object touches it) the map
/// colour and priority under each.
struct Line<'a> {
    line: &'a mut [u8],
    bg_col: &'a mut [u8; LCD_W],
    bg_pri: &'a mut [bool; LCD_W],
    keep: bool,
}

impl Line<'_> {
    /// Pixels [x, x + n) from one map cell (tile `id`, attribute `attr`), its
    /// row `py` before the cell's flip, from column px0 on.
    #[allow(clippy::too_many_arguments)]
    #[inline]
    fn cell<F: FnMut(u16, u16, u8) -> [u8; 8]>(&mut self, fetch: &mut RowFetch<'_, F>, id: u16, attr: u8,
                                               py: u8, x: usize, px0: usize, n: usize) {
        let ty = if attr & ATTR_Y_FLIP != 0 { 7 - py } else { py };
        let mut r = fetch.get(id, ty);
        if attr & ATTR_X_FLIP != 0 {
            r.reverse();
        }
        let base = (attr & ATTR_PAL) * 4;
        let src = &r[px0..px0 + n];
        for (d, &c) in self.line[x..x + n].iter_mut().zip(src) {
            *d = base + c;
        }
        if self.keep {
            self.bg_col[x..x + n].copy_from_slice(src);
            self.bg_pri[x..x + n].fill(attr & ATTR_PRIORITY != 0);
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

    /// render_rows as it was before RowFetch/Line (2026-10-01): the new one
    /// must draw exactly what this drew.
    fn reference_render_rows(lcd: &LcdScreen, row: &mut impl FnMut(u16, u16, u8) -> [u8; 8], out: &mut [u8]) {
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
                    hit = lcd.banks[..lcd.bank_count].iter().rev().find(|b| inside(b)).copied();
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
            let scy = if lcd.line_target == 1 { lcd.lines[ly] } else { lcd.scy };
            let scx = if lcd.line_target == 2 { lcd.lines[ly] } else { lcd.scx };
            // Screen pixels [x, x + n) from one cell of a map: the cell's
            // row fetched once, its pixels from column px0 on. A hole cell
            // leaves them as they are, unless `hole_clears` (the window: a
            // window hole is a hole, not the background under it).
            let mut span = |line: &mut [u8], bg_col: &mut [u8; LCD_W], bg_pri: &mut [bool; LCD_W],
                            i: usize, py: usize, x: usize, px0: usize, n: usize, hole_clears: bool| {
                let attr = lcd.attrs[i];
                if attr & ATTR_HOLE != 0 {
                    if hole_clears {
                        for k in x..x + n {
                            line[k] = LCD_HOLE;
                            bg_col[k] = 0;
                            bg_pri[k] = false;
                        }
                    } else if lcd.under_on {
                        // the under layer's pixels for [x, x + n) of line ly
                        let gy = lcd.under_y + ly as i32;
                        if gy < 0 || gy as usize >= lcd.under_h * 8 {
                            return;
                        }
                        let (urow, upy) = ((gy >> 3) as usize * lcd.under_w, (gy & 7) as u8);
                        // an under cell's row at a time (a hole cell spans at
                        // most two of them)
                        let mut k = x;
                        while k < x + n {
                            let gx = lcd.under_x + k as i32;
                            let px0 = (gx & 7) as usize;
                            let run = (8 - px0).min(x + n - k);
                            if gx < 0 || gx as usize >= lcd.under_w * 8 {
                                k += run;
                                continue;
                            }
                            let j = urow + (gx >> 3) as usize;
                            let ua = lcd.under_attr[j];
                            if ua & ATTR_HOLE == 0 {
                                let ty = if ua & ATTR_Y_FLIP != 0 { 7 - upy } else { upy };
                                let mut id = lcd.under[j];
                                for al in &lcd.aliases[..lcd.alias_n] {
                                    if al.0 == id {
                                        id = al.1;
                                        break;
                                    }
                                }
                                let r = fetch(id, ty);
                                let (base, pri, flip) = ((ua & ATTR_PAL) * 4, ua & ATTR_PRIORITY != 0, ua & ATTR_X_FLIP != 0);
                                for q in 0..run {
                                    let px = px0 + q;
                                    let c = r[if flip { 7 - px } else { px }];
                                    line[k + q] = base + c;
                                    bg_col[k + q] = c;
                                    bg_pri[k + q] = pri;
                                }
                            }
                            k += run;
                        }
                    }
                    return;
                }
                let ty = if attr & ATTR_Y_FLIP != 0 { 7 - py } else { py };
                let r = fetch(lcd.cells[i], ty as u8);
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
            if lcd.flags & FLAG_BG_ON != 0 {
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
            if lcd.flags & FLAG_WIN_ON != 0 && ly >= lcd.wy as usize && lcd.wx <= 166 {
                let x0 = (lcd.wx as usize).saturating_sub(7);
                let rowi = 1024 + ((win_line >> 3) & 31) * 32;
                let mut x = x0;
                while x < LCD_W {
                    let wx = x + 7 - lcd.wx as usize;
                    let px0 = wx & 7;
                    let n = (8 - px0).min(LCD_W - x);
                    span(line, &mut bg_col, &mut bg_pri, rowi + ((wx >> 3) & 31), win_line & 7, x, px0, n, true);
                    x += n;
                }
                win_line += 1;
            }
            if lcd.flags & FLAG_OBJ_ON == 0 {
                continue;
            }
            let tall = lcd.flags & FLAG_OBJ_TALL != 0;
            let h: i32 = if tall { 16 } else { 8 };
            // a lower index on top (CGB): draw from the last one back
            for o in lcd.objs[..lcd.obj_count].iter().rev() {
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

    /// xorshift32: the random screens' source, the same run every time.
    struct Rng(u32);
    impl Rng {
        fn next(&mut self) -> u32 {
            let mut x = self.0;
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            self.0 = x;
            x
        }
        fn below(&mut self, n: u32) -> u32 {
            self.next() % n
        }
    }

    /// A tile row with colours past 3 too (the renderer masks them).
    fn pattern(page: u16, tile: u16, y: u8) -> [u8; 8] {
        let mut r = [0u8; 8];
        for (x, c) in r.iter_mut().enumerate() {
            *c = ((tile as u32 * 7 + page as u32 * 3 + y as u32 * 5 + x as u32 * 11) % 7) as u8;
        }
        r
    }

    fn random_screen(rng: &mut Rng) -> LcdScreen {
        let mut lcd = LcdScreen::default();
        lcd.op(op::LCD_BANK, &[0, 1, 512], None);
        lcd.op(op::LCD_BANK, &[600, 2, 300], None);
        for i in 0..2048 {
            lcd.cells[i] = rng.below(1000) as u16;
            let mut a = rng.below(256) as u8;
            if rng.below(3) == 0 {
                a |= ATTR_HOLE;
            }
            lcd.attrs[i] = a;
        }
        lcd.scx = rng.below(256) as u8;
        lcd.scy = rng.below(256) as u8;
        lcd.wx = rng.below(180) as u8;
        lcd.wy = rng.below(160) as u8;
        lcd.flags = rng.below(16) as u8;
        lcd.line_target = rng.below(3) as u8;
        for l in lcd.lines.iter_mut() {
            *l = rng.below(256) as u8;
        }
        let n = rng.below(48) as usize;
        for k in 0..n {
            lcd.objs[k] = LcdObj {
                x: rng.below(200) as i16 - 20,
                y: rng.below(190) as i16 - 24,
                tile: rng.below(1000) as u16,
                attr: rng.below(256) as u8,
            };
        }
        lcd.obj_count = n;
        if rng.below(2) == 0 {
            let (w, h) = (20 + rng.below(30) as i32, 15 + rng.below(30) as i32);
            lcd.op(op::LCD_UNDER, &[w, h], None);
            for j in 0..(w * h) as usize {
                lcd.under[j] = rng.below(1000) as u16;
                let mut a = rng.below(256) as u8 & !ATTR_HOLE;
                if rng.below(5) == 0 {
                    a |= ATTR_HOLE;
                }
                lcd.under_attr[j] = a;
            }
            lcd.under_on = true;
            lcd.under_x = rng.below(400) as i32 - 60;
            lcd.under_y = rng.below(400) as i32 - 60;
            lcd.aliases[0] = (rng.below(1000) as u16, rng.below(1000) as u16);
            lcd.aliases[1] = (lcd.under[0], 7);
            lcd.alias_n = 2;
        }
        lcd
    }

    #[test]
    fn render_rows_draws_what_the_reference_drew() {
        let mut rng = Rng(0x2545_f491);
        let mut a = vec![0u8; LCD_W * LCD_H];
        let mut b = vec![0u8; LCD_W * LCD_H];
        for case in 0..3000 {
            let lcd = random_screen(&mut rng);
            lcd.render_rows(&mut pattern, &mut a);
            reference_render_rows(&lcd, &mut pattern, &mut b);
            assert!(a == b, "case {case} differs");
        }
    }

    /// cargo test --release lcd_render_bench -- --ignored --nocapture
    #[test]
    #[ignore]
    fn lcd_render_bench() {
        extern crate std;
        // VIEW 2D's shape: an under layer behind an all-hole background, a
        // text row at the bottom, a few people as objects
        let mut lcd = LcdScreen::default();
        lcd.op(op::LCD_BANK, &[0, 1, 1024], None);
        lcd.op(op::LCD_UNDER, &[40, 36], None);
        let mut rng = Rng(7);
        for j in 0..40 * 36 {
            lcd.under[j] = rng.below(900) as u16;
            lcd.under_attr[j] = rng.below(8) as u8;
        }
        lcd.under_on = true;
        lcd.under_x = 37;
        lcd.under_y = 21;
        for i in 0..2048 {
            lcd.attrs[i] = if (16..18).contains(&(i / 32)) && i % 32 < 20 { 1 } else { ATTR_HOLE };
        }
        for k in 0..8 {
            lcd.objs[k] = LcdObj { x: 40 + k as i16 * 12, y: 50 + (k as i16 % 3) * 16, tile: 10 + k as u16, attr: 2 };
        }
        lcd.obj_count = 8;
        let mut out = vec![0u8; LCD_W * LCD_H];
        // rows from a table, as the 3DS host reads its unswizzled pages
        let table: alloc::vec::Vec<[u8; 8]> = (0..1024u16 * 8).map(|k| pattern(1, k >> 3, (k & 7) as u8)).collect();
        let mut pattern = |_page: u16, tile: u16, y: u8| table[((tile as usize) << 3 | y as usize) & (1024 * 8 - 1)];
        for (name, new) in [("reference", false), ("render_rows", true), ("reference", false), ("render_rows", true)] {
            let t = std::time::Instant::now();
            for _ in 0..3000 {
                if new {
                    lcd.render_rows(&mut pattern, &mut out);
                } else {
                    reference_render_rows(&lcd, &mut pattern, &mut out);
                }
            }
            std::println!("{name}: {:.1} us a frame", t.elapsed().as_secs_f64() * 1e6 / 3000.0);
        }
    }

    #[test]
    fn the_under_canvas_takes_the_layer_off_the_screen_and_draws_it_itself() {
        let mut lcd = LcdScreen::default();
        lcd.op(op::LCD_BANK, &[0, 1, 256], None);
        // a 40x30-cell layer, tile 1 in palette 2, cell (5,5) tile 2 palette 0
        lcd.op(op::LCD_UNDER, &[40, 30], None);
        for r in 0..30 {
            let row: String = (0..40).map(|c| if r == 5 && c == 5 { "000200" } else { "000102" }).collect();
            lcd.op(op::LCD_UNDER_ROW, &[r, 0], Some(&row));
        }
        lcd.op(op::LCD_UNDER_AT, &[1, 64, 48], None);
        let mut pattern = |_p: u16, tile: u16, y: u8| [(tile as u8 + y) & 3; 8];
        let mut out = vec![0u8; LCD_W * LCD_H];
        lcd.render_rows(&mut pattern, &mut out);
        assert_ne!(out[0], LCD_HOLE, "no canvas: the layer under the holes");
        // a canvas 254x144, wide: the screen keeps its holes clear
        lcd.op(op::LCD_UNDER_VIEW, &[254, 144, 1], None);
        assert!(lcd.canvas_on());
        lcd.render_rows(&mut pattern, &mut out);
        assert!(out.iter().all(|&p| p == LCD_HOLE));
        // the screen's 160x144 is centred: 47 canvas pixels in
        assert_eq!(lcd.canvas_origin(), (47, 0));
        assert_eq!(lcd.canvas_under_xy(), (64 - 47, 48));
        // a cell's pixels as the screen drew them, and none past the layer
        let mut t = [0u8; 64];
        assert!(lcd.canvas_tile(&mut pattern, 5, 5, &mut t));
        assert_eq!(t[0], 2); // palette 0, tile 2 row 0: colour 2
        assert!(lcd.canvas_tile(&mut pattern, 6, 5, &mut t));
        assert_eq!(t[8], 2 * 4 + ((1 + 1) & 3)); // palette 2, tile 1 row 1
        assert!(!lcd.canvas_tile(&mut pattern, 40, 5, &mut t));
        assert!(!lcd.canvas_tile(&mut pattern, -1, 0, &mut t));
        // an object at screen (0, 0) lands at canvas (47, 0); a priority
        // object hides behind a non-zero map colour
        assert!(lcd.set_under_objs(&[0, 0, 3, 0, 0, 0, 3, 0x80], 2));
        let mut put = alloc::vec::Vec::new();
        lcd.canvas_objects(&mut pattern, &mut |x, y, p| put.push((x, y, p)));
        assert!(put.iter().all(|&(x, y, _)| (47..55).contains(&x) && (0..8).contains(&y)));
        assert!(put.iter().all(|&(_, _, p)| p >= 64), "object palettes are slots 16 up");
        assert_eq!(put.iter().filter(|&&(x, y, _)| x == 47 && y == 0).count(), 1, "the lower index alone");
        // off: back to the holes
        lcd.op(op::LCD_UNDER_VIEW, &[0, 0, 0], None);
        assert!(!lcd.canvas_on());
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
        // an alias draws the layer's tile 2 as tile 3 (an animation's frame)
        lcd.op(op::LCD_CELLS, &[0], Some("000010"));
        lcd.op(op::LCD_ALIAS, &[5, 2, 3], None);
        assert_eq!(frame(&lcd)[0], 3);
        lcd.op(op::LCD_ALIAS, &[5, -1, 0], None);
        assert_eq!(frame(&lcd)[0], 2);
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
    fn the_typed_array_ops_match_the_text_ones_and_bump_only_on_change() {
        let mut a = LcdScreen::default();
        let mut b = LcdScreen::default();
        a.op(op::LCD_CELLS, &[33], Some("01230500ab07"));
        let mut cells = b.cells;
        let mut attrs = b.attrs;
        cells[33] = 0x0123;
        attrs[33] = 0x05;
        cells[34] = 0x00ab;
        attrs[34] = 0x07;
        assert!(b.set_cells(&cells, &attrs));
        assert_eq!(a.cells, b.cells);
        assert_eq!(a.attrs, b.attrs);
        let s = b.serial;
        assert!(!b.set_cells(&cells, &attrs));
        assert_eq!(b.serial, s);

        a.op(op::LCD_OBJS, &[], Some("0010fff8abcd03"));
        assert!(b.set_objs(&[0x10, -8, 0xabcdu16 as i16, 3], 1));
        assert_eq!(a.objs[0], b.objs[0]);
        assert_eq!(b.obj_count, 1);
        let s = b.serial;
        assert!(!b.set_objs(&[0x10, -8, 0xabcdu16 as i16, 3], 1));
        assert_eq!(b.serial, s);
        assert!(b.set_objs(&[], 0));
        assert_eq!(b.obj_count, 0);

        let mut lines = [0u8; LCD_H];
        lines[5] = 3;
        assert!(b.set_lines(2, &lines));
        assert_eq!((b.line_target, b.lines[5]), (2, 3));
        assert!(!b.set_lines(2, &lines));
        assert!(b.set_lines(0, &lines));
        assert_eq!(b.line_target, 0);
    }

    #[test]
    fn palettes_expand_to_abgr() {
        let mut lcd = LcdScreen::default();
        lcd.op(op::LCD_PALS, &[4], Some("7fff001f"));
        assert_eq!(lcd.colours[4], 0x7fff);
        assert_eq!(LcdScreen::abgr(lcd.colours[4]), 0xffff_ffff);
        assert_eq!(LcdScreen::abgr(lcd.colours[5]), 0xff00_00ff);
    }

    #[test]
    fn the_under_layer_takes_its_cells_whole_as_hex_rows_would_set_them() {
        let (w, h) = (6i32, 3i32);
        let ids: alloc::vec::Vec<u16> = (0..(w * h) as u16).map(|i| 0x100 + i * 7).collect();
        let attrs: alloc::vec::Vec<u8> = (0..(w * h) as u8).map(|i| i * 3).collect();
        // the hex rows (LCD_UNDER_ROW), as the PC host sends them
        let mut a = LcdScreen::default();
        a.op(op::LCD_UNDER, &[w, h], None);
        for y in 0..h {
            let mut row = String::new();
            for x in 0..w {
                let j = (y * w + x) as usize;
                row.push_str(&format!("{:04x}{:02x}", ids[j], attrs[j]));
            }
            a.op(op::LCD_UNDER_ROW, &[y, 0], Some(&row));
        }
        // the arrays at once (lcdUnderBin), as the 3DS shim sends them
        let mut b = LcdScreen::default();
        b.op(op::LCD_UNDER, &[w, h], None);
        let (s0, u0) = (b.serial, b.under_serial);
        b.set_under(&ids, &attrs);
        assert_eq!(a.under, b.under);
        assert_eq!(a.under_attr, b.under_attr);
        assert_ne!(b.serial, s0);
        assert_ne!(b.under_serial, u0);
    }
}
