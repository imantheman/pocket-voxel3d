//! The GB UI tile layer → screen-space [`Item::UiQuad`]s.
//!
//! The 160x144 GB frame scales to fit 480x272 by height: **scale = VIEW_H /
//! GB_H = 272/144 ≈ 1.8889**, centered horizontally (the scaled UI is
//! ~302 px wide, leaving ~89 px pillars either side that show the diorama).
//! No integer scale fits, and shrinking to an integer would waste the
//! screen; the sim and GE both sample nearest-neighbour at this scale, so
//! the two hosts stay pixel-identical.
//!
//! Glyph resolution (`uiText`): each char resolves through the pak's CMAP
//! (cooked GB charmap → UI atlas tile). Characters the pak has no glyph for
//! draw nothing but still advance the pen and count toward the reveal cap —
//! spaces work without a CMAP entry. `\n` returns the pen to the starting
//! column one row down and is free (it does not count toward `uiReveal`).
//! Text draws after the tile grid, so it composites over box art at the
//! same cells.

use alloc::vec::Vec;

use crate::draw::Item;
use crate::pak::Pak;
use crate::scene::Scene;
use crate::scene::UiPanel;
use crate::spec::{GB_H, GB_W, TILE_PX, UI_COLS, UI_PANELS, UI_ROWS, VIEW_H, VIEW_W, atlas_kind};

/// GB → screen scale, pinned (see module docs).
pub const UI_SCALE: f32 = VIEW_H as f32 / GB_H as f32;

/// Left edge of the centered, scaled GB frame on screen.
pub const UI_ORIGIN_X: f32 = (VIEW_W as f32 - GB_W as f32 * UI_SCALE) / 2.0;

/// Screen size of one 8x8 GB tile.
pub const UI_TILE_PX: f32 = TILE_PX as f32 * UI_SCALE;

fn quad(page: u16, cx: i32, cy: i32, tile: u16) -> Item {
    Item::UiQuad {
        x: UI_ORIGIN_X + cx as f32 * UI_TILE_PX,
        y: cy as f32 * UI_TILE_PX,
        w: UI_TILE_PX,
        h: UI_TILE_PX,
        page,
        tile,
    }
}

/// Where the GB drew the two battlers: the enemy's front pic at tile
/// (12, 0) and the player's back pic at tile (1, 5), both 7x7 tiles. The
/// move animations were authored against these two boxes -- a beam leaves
/// one and lands on the other -- so they are what an animation has to be
/// mapped FROM.
const GB_ENEMY_PIC: (f32, f32) = (96.0 + 28.0, 0.0 + 28.0);
const GB_PLAYER_PIC: (f32, f32) = (8.0 + 28.0, 40.0 + 28.0);
/// How far the animation may be scaled from the GB's own size. A camera
/// looking down the arena's axis puts the two mons almost on top of each
/// other; without a floor the whole effect would collapse into a dot.
const ANIM_SCALE_MIN: f32 = 0.5;
const ANIM_SCALE_MAX: f32 = 2.5;

/// How to put a Game Boy screen coordinate where the battle actually is.
///
/// Returns (x offset, y offset, px per GB px, mirrored). With no cards on
/// screen this is the UI's own letterboxed frame, which is where the
/// animations used to land unconditionally -- and that was the bug: the
/// mons are cards in a diorama, several dozen pixels from where the flat
/// game drew them, so every attack went off beside its target. The two pic
/// boxes are mapped onto the two cards instead: same midpoint, same
/// separation, so a beam still leaves one mon and lands on the other
/// whatever the camera is doing.
///
/// `mirrored` is the other half of that. The animations were authored for
/// a layout with the enemy on the RIGHT; swing the camera past the arena's
/// axis and the two mons trade sides on screen, so the GB x axis is
/// reflected (and each tile with it) to keep an attack leaving the mon
/// that threw it.
fn anim_frame(cards: &[Option<Rect>; UI_PANELS]) -> (f32, f32, f32, bool) {
    let home = (UI_ORIGIN_X, 0.0, UI_SCALE, false);
    let (Some(p), Some(e)) = (cards[0], cards[1]) else { return home };
    let mid = |r: Rect| ((r.x0 + r.x1) * 0.5, (r.y0 + r.y1) * 0.5);
    let (px, py) = mid(p);
    let (ex, ey) = mid(e);
    let gap = crate::math::sqrtf((ex - px) * (ex - px) + (ey - py) * (ey - py));
    let gb_gap = {
        let dx = GB_ENEMY_PIC.0 - GB_PLAYER_PIC.0;
        let dy = GB_ENEMY_PIC.1 - GB_PLAYER_PIC.1;
        crate::math::sqrtf(dx * dx + dy * dy)
    };
    if gb_gap < 1.0 {
        return home;
    }
    let scale = (gap / gb_gap).clamp(UI_SCALE * ANIM_SCALE_MIN, UI_SCALE * ANIM_SCALE_MAX);
    let gb_mid = (
        (GB_ENEMY_PIC.0 + GB_PLAYER_PIC.0) * 0.5,
        (GB_ENEMY_PIC.1 + GB_PLAYER_PIC.1) * 0.5,
    );
    let screen_mid = ((px + ex) * 0.5, (py + ey) * 0.5);
    (
        screen_mid.0 - gb_mid.0 * scale,
        screen_mid.1 - gb_mid.1 * scale,
        scale,
        ex < px,
    )
}

/// The GB x a tile is drawn at, reflected about the two pics' midpoint
/// when the camera has the mons the other way round. The tile's own width
/// comes off it: `x` is its LEFT edge, and a mirrored left edge is the
/// right one.
fn anim_x(x: i16, mirrored: bool) -> f32 {
    let gb_mid_x = (GB_ENEMY_PIC.0 + GB_PLAYER_PIC.0) * 0.5;
    if mirrored {
        2.0 * gb_mid_x - (x as f32 + TILE_PX as f32)
    } else {
        x as f32
    }
}

/// Append this frame's move-animation sprites.
///
/// They arrive in Game Boy pixels and are put where the battle is drawn
/// (see [`anim_frame`]); `page` is the sheet the guest read out of its own
/// data.
pub fn append_anim(scene: &Scene, cards: &[Option<Rect>; UI_PANELS], items: &mut Vec<Item>) {
    if scene.anim_sprite_n == 0 {
        return;
    }
    let (ox, oy, scale, mirrored) = anim_frame(cards);
    let tile = TILE_PX as f32 * scale;
    for i in 0..scene.anim_sprite_n as usize {
        let s = scene.anim_sprites[i];
        items.push(Item::AnimQuad {
            x: ox + anim_x(s.x, mirrored) * scale,
            y: oy + s.y as f32 * scale,
            w: tile,
            h: tile,
            page: s.page,
            tile: s.tile,
            flip_x: (s.flags & 1 != 0) != mirrored,
            flip_y: s.flags & 2 != 0,
        });
    }
}


// ---------------------------------------------------------------------------
// HUD panels
// ---------------------------------------------------------------------------

/// Clear space kept between a HUD panel and a sprite, in UI px.
pub const PANEL_GAP: f32 = 8.0;
/// A panel that is already placed only moves once a sprite comes THIS
/// close to it, and only goes back to its GB cells once they are clear by
/// `PANEL_GAP * PANEL_HOME_MARGIN`. Two different thresholds on purpose:
/// with one, a mon drifting along the edge of the gap would have the HUD
/// stepping in and out on every frame it crossed.
const PANEL_HOLD_GAP: f32 = 2.0;
const PANEL_HOME_MARGIN: f32 = 1.5;
/// How much of the way a panel travels toward its target each frame. A
/// camera swing moves the sprites smoothly; the panel follows the same way
/// rather than teleporting when the answer changes side.
const PANEL_EASE: f32 = 0.2;
/// Closer than this and the ease just lands, so a panel comes to rest.
const PANEL_SNAP: f32 = 0.5;

/// A screen-space rectangle in UI px (the 480x272 frame the UI is laid out
/// in), used for both the panels and the projected sprites.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Rect {
    pub x0: f32,
    pub y0: f32,
    pub x1: f32,
    pub y1: f32,
}

impl Rect {
    pub fn of(x0: f32, y0: f32, x1: f32, y1: f32) -> Self {
        Rect {
            x0: x0.min(x1),
            y0: y0.min(y1),
            x1: x0.max(x1),
            y1: y0.max(y1),
        }
    }

    pub fn width(&self) -> f32 {
        self.x1 - self.x0
    }

    pub fn shifted(&self, dx: f32, dy: f32) -> Rect {
        Rect {
            x0: self.x0 + dx,
            y0: self.y0 + dy,
            x1: self.x1 + dx,
            y1: self.y1 + dy,
        }
    }

    pub fn grown(&self, by: f32) -> Rect {
        Rect {
            x0: self.x0 - by,
            y0: self.y0 - by,
            x1: self.x1 + by,
            y1: self.y1 + by,
        }
    }

    pub fn overlaps(&self, o: &Rect) -> bool {
        self.x0 < o.x1 && o.x0 < self.x1 && self.y0 < o.y1 && o.y0 < self.y1
    }

    /// How much area the two share -- the tiebreak when nothing fits.
    fn overlap_area(&self, o: &Rect) -> f32 {
        let w = (self.x1.min(o.x1) - self.x0.max(o.x0)).max(0.0);
        let h = (self.y1.min(o.y1) - self.y0.max(o.y0)).max(0.0);
        w * h
    }
}

/// Where a panel sits when nothing has moved it: its cells, in UI px.
pub fn panel_home(p: &UiPanel) -> Rect {
    Rect::of(
        UI_ORIGIN_X + p.x as f32 * UI_TILE_PX,
        p.y as f32 * UI_TILE_PX,
        UI_ORIGIN_X + (p.x as f32 + p.w as f32) * UI_TILE_PX,
        (p.y as f32 + p.h as f32) * UI_TILE_PX,
    )
}

/// Where a HUD panel has to move so nothing readable ends up underneath
/// it: an offset from its GB cells, in UI px.
///
/// The GB could draw the name and the HP bar in fixed cells because what
/// they sat beside was a flat pic at a fixed place. Here the sprites are
/// cards in a diorama the player can spin, so the panel gets out of the
/// way instead -- of its own mon, of the other one, and of the other panel.
///
/// It looks at the positions that sit flush against each of those, above,
/// below, left and right, and takes the one that costs the least movement:
/// staying put is free, so the classic GB placement is what a camera with
/// room for it still gets. Sideways is cheaper than up or down (a HUD reads
/// as a row), and a tie goes to where the panel already is (`now`), so a mon
/// drifting across it cannot set it flip-flopping.
pub fn panel_shift(
    home: Rect,
    own: Option<Rect>,
    other: Option<Rect>,
    avoid: Option<Rect>,
    view: (f32, f32),
    now: [f32; 2],
) -> [f32; 2] {
    // A comfortable gap first; if the sprites leave no room for one, a
    // touching fit still beats sitting on top of a mon.
    for gap in [PANEL_GAP, 1.0] {
        if let Some(d) = panel_fit(home, own, other, avoid, view, now, gap) {
            return d;
        }
    }
    panel_least_bad(home, own, other, avoid, view, now)
}

/// A placement with `gap` px to spare on every side, or None.
fn panel_fit(
    home: Rect,
    own: Option<Rect>,
    other: Option<Rect>,
    avoid: Option<Rect>,
    view: (f32, f32),
    now: [f32; 2],
    gap: f32,
) -> Option<[f32; 2]> {
    let (view_w, view_h) = view;
    let blockers: [Option<Rect>; 3] = [
        own.map(|r| r.grown(gap)),
        other.map(|r| r.grown(gap)),
        avoid.map(|r| r.grown(gap * 0.5)),
    ];
    if blockers.iter().flatten().count() == 0 {
        return Some([0.0, 0.0]);
    }
    let at = |d: [f32; 2]| home.shifted(d[0], d[1]);
    let on_screen = |d: [f32; 2]| {
        let p = at(d);
        p.x0 >= 0.0 && p.y0 >= 0.0 && p.x1 <= view_w && p.y1 <= view_h
    };
    let clear = |d: [f32; 2]| blockers.iter().flatten().all(|b| !at(d).overlaps(b));
    // Flush against each edge of each thing to dodge, plus staying put.
    let mut xs = [0.0f32; 7];
    let mut ys = [0.0f32; 7];
    let mut n = 1;
    for b in blockers.iter().flatten() {
        xs[n] = b.x0 - home.x1;
        ys[n] = b.y0 - home.y1;
        xs[n + 1] = b.x1 - home.x0;
        ys[n + 1] = b.y1 - home.y0;
        n += 2;
    }
    // Sideways first, then up or down, then the diagonals; ties to where it
    // already is.
    let cost = |d: [f32; 2]| {
        d[0].abs()
            + d[1].abs() * 1.4
            + ((d[0] - now[0]).abs() + (d[1] - now[1]).abs()) * 0.3
    };
    let mut best: Option<([f32; 2], f32)> = None;
    for dx in xs.iter().take(n) {
        for dy in ys.iter().take(n) {
            let d = [*dx, *dy];
            if !on_screen(d) || !clear(d) {
                continue;
            }
            let c = cost(d);
            if best.is_none_or(|(_, bc)| c < bc) {
                best = Some((d, c));
            }
        }
    }
    best.map(|(d, _)| d)
}

/// Nothing fits: stay on screen and cover as little as possible, so the mon
/// is still readable through even the worst angle.
fn panel_least_bad(
    home: Rect,
    own: Option<Rect>,
    other: Option<Rect>,
    avoid: Option<Rect>,
    view: (f32, f32),
    now: [f32; 2],
) -> [f32; 2] {
    let (view_w, view_h) = view;
    let blockers: [Option<Rect>; 3] = [own, other, avoid];
    let at = |d: [f32; 2]| home.shifted(d[0], d[1]);
    let cost = |d: [f32; 2]| {
        d[0].abs()
            + d[1].abs() * 1.4
            + ((d[0] - now[0]).abs() + (d[1] - now[1]).abs()) * 0.3
    };
    let mut xs = [0.0f32; 7];
    let mut ys = [0.0f32; 7];
    let mut n = 1;
    for b in blockers.iter().flatten() {
        xs[n] = b.x0 - home.x1;
        ys[n] = b.y0 - home.y1;
        xs[n + 1] = b.x1 - home.x0;
        ys[n + 1] = b.y1 - home.y0;
        n += 2;
    }
    let clamp = |d: [f32; 2]| {
        [
            d[0].clamp(-home.x0, view_w - home.x1),
            d[1].clamp(-home.y0, view_h - home.y1),
        ]
    };
    let overlap = |d: [f32; 2]| {
        blockers
            .iter()
            .flatten()
            .map(|b| at(d).overlap_area(b))
            .sum::<f32>()
    };
    let mut fallback = ([0.0f32, 0.0], f32::MAX);
    for dx in xs.iter().take(n) {
        for dy in ys.iter().take(n) {
            let d = clamp([*dx, *dy]);
            let c = overlap(d) + cost(d) * 0.01;
            if c < fallback.1 {
                fallback = (d, c);
            }
        }
    }
    fallback.0
}

/// Ease every declared panel toward where the sprites leave room, and
/// report where they are now (UI px). `cards[side]` is that side's sprite
/// on screen, if it is being drawn.
pub fn ease_panels(scene: &Scene, cards: &[Option<Rect>; UI_PANELS]) -> [[f32; 2]; UI_PANELS] {
    let mut out = [[0.0f32; 2]; UI_PANELS];
    // A card missing from THIS frame is not "no sprite there": the hit
    // flicker blinks the defender off every other frame. Remember where
    // each one was, and go on dodging that until it is drawn again --
    // reading a blink as open ground sent the HUD home and straight back
    // out, once per hit, which is the hop on every A press.
    let mut seen: [Option<Rect>; UI_PANELS] = [None; UI_PANELS];
    for i in 0..UI_PANELS {
        if !scene.battle.active {
            scene.ui_card_seen[i].set([0.0; 4]);
            continue;
        }
        match cards[i] {
            Some(r) => {
                scene.ui_card_seen[i].set([r.x0, r.y0, r.x1, r.y1]);
                seen[i] = Some(r);
            }
            None => {
                let v = scene.ui_card_seen[i].get();
                if v[2] > v[0] {
                    seen[i] = Some(Rect::of(v[0], v[1], v[2], v[3]));
                }
            }
        }
    }
    let cards = &seen;
    // Where each panel is drawn now, so one also dodges the other rather
    // than the two of them stacking in the same corner.
    let mut taken: [Option<Rect>; UI_PANELS] = [None; UI_PANELS];
    for i in 0..UI_PANELS {
        let p = scene.ui_panels[i];
        if p.w > 0 {
            let o = scene.ui_panel_off[i].get();
            taken[i] = Some(panel_home(&p).shifted(o[0], o[1]));
        }
    }
    for i in 0..UI_PANELS {
        let panel = scene.ui_panels[i];
        let now = scene.ui_panel_off[i].get();
        if panel.w == 0 || !scene.battle.active {
            scene.ui_panel_off[i].set([0.0, 0.0]);
            scene.ui_panel_target[i].set([0.0, 0.0]);
            taken[i] = None;
            continue;
        }
        let home = panel_home(&panel);
        let blockers = [
            cards[i],
            cards[UI_PANELS - 1 - i],
            taken[UI_PANELS - 1 - i],
        ];
        let clear_by = |r: Rect, gap: f32| {
            blockers
                .iter()
                .flatten()
                .all(|b| !r.overlaps(&b.grown(gap)))
        };
        let was = scene.ui_panel_target[i].get();
        let going = home.shifted(was[0], was[1]);
        let target = if clear_by(home, PANEL_GAP * PANEL_HOME_MARGIN) {
            // Nothing near its own cells any more: that is where it belongs.
            [0.0, 0.0]
        } else if was != [0.0, 0.0] && clear_by(going, PANEL_HOLD_GAP) {
            // Where it was already heading still works: keep going there.
            // Re-solving every frame is what had the HUD drifting whenever
            // a sprite so much as leaned.
            was
        } else {
            panel_shift(
                home,
                cards[i],
                cards[UI_PANELS - 1 - i],
                taken[UI_PANELS - 1 - i],
                (VIEW_W as f32, VIEW_H as f32),
                now,
            )
        };
        scene.ui_panel_target[i].set(target);
        let mut at = [0.0f32; 2];
        for k in 0..2 {
            at[k] = now[k] + (target[k] - now[k]) * PANEL_EASE;
            if (target[k] - at[k]).abs() < PANEL_SNAP {
                at[k] = target[k];
            }
        }
        scene.ui_panel_off[i].set(at);
        out[i] = at;
        // What the NEXT panel has to keep clear of is everywhere this one
        // passes through: where it is now and where it is heading. Handing
        // on only its current rect let the two cross while both were still
        // sliding, which is the overlap that survived the first pass.
        let here = home.shifted(at[0], at[1]);
        let going = home.shifted(target[0], target[1]);
        taken[i] = Some(Rect::of(
            here.x0.min(going.x0),
            here.y0.min(going.y0),
            here.x1.max(going.x1),
            here.y1.max(going.y1),
        ));
    }
    out
}

/// Append the UI layer: the retained tile grid (tile 0 = empty), then the
/// last `uiText` run capped by `uiReveal`.
///
/// `panel_off` slides the declared HUD panels (see [`ease_panels`]); every
/// other cell is drawn where the GB puts it.
pub fn append_ui(
    scene: &Scene,
    pak: &Pak,
    panel_off: [[f32; 2]; UI_PANELS],
    items: &mut Vec<Item>,
) {
    let Some(page) = pak.page_of_kind(atlas_kind::UI) else {
        return; // a pak without UI art draws no UI
    };
    for cy in 0..UI_ROWS as i32 {
        for cx in 0..UI_COLS as i32 {
            let tile = scene.ui[cy as usize * UI_COLS + cx as usize];
            if tile != 0 {
                let mut q = quad(page, cx, cy, tile);
                if let Some(i) = (0..UI_PANELS).find(|&i| scene.ui_panels[i].holds(cx, cy))
                    && let Item::UiQuad { x, y, .. } = &mut q
                {
                    *x += panel_off[i][0];
                    *y += panel_off[i][1];
                }
                items.push(q);
            }
        }
    }
    let Some(text) = &scene.ui_text else { return };
    let mut pen_x = text.x;
    let mut pen_y = text.y;
    let mut shown = 0u32;
    for ch in text.text.chars() {
        if ch == '\n' {
            pen_x = text.x;
            pen_y += 1;
            continue;
        }
        if shown >= scene.ui_reveal {
            break;
        }
        shown += 1;
        let code = ch as u32;
        let in_grid = (0..UI_COLS as i32).contains(&pen_x) && (0..UI_ROWS as i32).contains(&pen_y);
        if code <= u16::MAX as u32
            && in_grid
            && let Some(tile) = pak.glyph(code as u16)
        {
            items.push(quad(page, pen_x, pen_y, tile));
        }
        pen_x += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pak;
    use crate::spec::op;

    #[test]
    fn scale_is_the_pinned_letterbox() {
        assert!((UI_SCALE - 272.0 / 144.0).abs() < 1e-6);
        assert!((UI_ORIGIN_X - (480.0 - 160.0 * UI_SCALE) / 2.0).abs() < 1e-6);
        // The scaled frame fits the screen exactly in height.
        assert!((UI_TILE_PX * UI_ROWS as f32 - VIEW_H as f32).abs() < 1e-3);
    }


    /// A panel and a sprite, in the UI's own pixels.
    fn rect(x0: f32, y0: f32, x1: f32, y1: f32) -> Rect {
        Rect::of(x0, y0, x1, y1)
    }

    const VIEW: (f32, f32) = (VIEW_W as f32, VIEW_H as f32);

    /// Where a panel ends up, and whether that is a place it may be.
    fn placed(home: Rect, own: Rect, other: Option<Rect>, now: [f32; 2]) -> Rect {
        let d = panel_shift(home, Some(own), other, None, VIEW, now);
        let p = home.shifted(d[0], d[1]);
        assert!(!p.overlaps(&own.grown(PANEL_GAP)), "{p:?} is on its own mon");
        if let Some(o) = other {
            assert!(!p.overlaps(&o.grown(PANEL_GAP)), "{p:?} is on the other mon");
        }
        assert!(p.x0 >= 0.0 && p.y0 >= 0.0, "{p:?} left the screen");
        assert!(p.x1 <= VIEW.0 && p.y1 <= VIEW.1, "{p:?} left the screen");
        p
    }

    #[test]
    fn a_panel_sits_beside_its_own_mon() {
        let home = rect(90.0, 0.0, 240.0, 60.0);
        // A mon left of the panel puts it on the mon's right, and the other
        // way round when the camera has swung it across.
        let p = placed(home, rect(60.0, 10.0, 140.0, 90.0), None, [0.0, 0.0]);
        assert!(p.x0 >= 140.0, "should have gone to the mon's right");
        let p = placed(home, rect(200.0, 10.0, 280.0, 90.0), None, [0.0, 0.0]);
        assert!(p.x1 <= 200.0, "should have gone to the mon's left");
    }

    #[test]
    fn a_panel_dodges_the_other_mon_too() {
        // Its own mon is centred on it and the other one covers the left,
        // so the placement has to clear BOTH -- whichever way it goes.
        let home = rect(90.0, 100.0, 240.0, 180.0);
        placed(
            home,
            rect(150.0, 90.0, 240.0, 200.0),
            Some(rect(0.0, 90.0, 120.0, 200.0)),
            [0.0, 0.0],
        );
    }

    #[test]
    fn a_panel_dodges_the_other_panel() {
        // Both panels pushed the same way would stack; the second one is
        // told where the first is drawing and goes somewhere else.
        let home = rect(90.0, 100.0, 240.0, 180.0);
        let own = rect(150.0, 90.0, 240.0, 200.0);
        let occupied = home.shifted(0.0, -98.0);
        let d = panel_shift(home, Some(own), None, Some(occupied), VIEW, [0.0, 0.0]);
        let p = home.shifted(d[0], d[1]);
        assert!(!p.overlaps(&own.grown(PANEL_GAP)), "{p:?} is on its mon");
        assert!(!p.overlaps(&occupied), "{p:?} is on the other panel");
    }

    #[test]
    fn a_panel_that_has_room_stays_where_the_gb_put_it() {
        // Nothing near it: the classic placement costs nothing to keep.
        let home = rect(90.0, 0.0, 240.0, 60.0);
        let far = rect(300.0, 150.0, 400.0, 250.0);
        assert_eq!(
            panel_shift(home, Some(far), None, None, VIEW, [0.0, 0.0]),
            [0.0, 0.0],
        );
    }

    #[test]
    fn a_boxed_in_panel_goes_over_or_under_the_sprite() {
        // Sprites across the whole width: nothing fits beside them, but the
        // panel's own mon leaves the bottom of the screen free.
        let home = rect(90.0, 100.0, 240.0, 160.0);
        let own = rect(20.0, 40.0, 300.0, 140.0);
        let other = rect(300.0, 40.0, 460.0, 140.0);
        let p = placed(home, own, Some(other), [0.0, 0.0]);
        assert!(p.y0 >= own.y1, "the room left was below the sprite");
    }

    #[test]
    fn a_panel_keeps_the_side_it_is_on() {
        // A home rect with room on both sides and a mon over its middle:
        // the sides are equally far, so the one the panel is already on
        // wins and a drifting camera cannot flip it end to end.
        let home = rect(165.0, 0.0, 315.0, 60.0);
        let own = rect(215.0, 10.0, 265.0, 90.0);
        let left = placed(home, own, None, [-100.0, 0.0]);
        let right = placed(home, own, None, [100.0, 0.0]);
        assert!(left.x1 <= own.x0, "was on the left, stayed left");
        assert!(right.x0 >= own.x1, "was on the right, stayed right");
    }

    #[test]
    fn nothing_moves_without_a_sprite_to_dodge() {
        let home = rect(90.0, 0.0, 240.0, 60.0);
        assert_eq!(panel_shift(home, None, None, None, VIEW, [0.0, 0.0]), [0.0, 0.0]);
    }

    #[test]
    fn the_panel_takes_its_tiles_with_it() {
        let blob = pak::AlignedBlob::from_bytes(&pak::tests::tiny_pak_bytes());
        let pak = pak::read(blob.bytes()).unwrap();
        let mut s = Scene::new();
        s.op(op::UI_TILE, &[0, 0, 9], None); // inside the enemy panel
        s.op(op::UI_TILE, &[19, 17, 9], None); // outside every panel
        s.op(op::UI_PANEL, &[1, 0, 0, 10, 4], None);
        let xy_of = |items: &Vec<Item>, i: usize| match items[i] {
            Item::UiQuad { x, y, .. } => (x, y),
            _ => panic!("expected a UiQuad"),
        };
        let mut home = Vec::new();
        append_ui(&s, &pak, [[0.0; 2]; UI_PANELS], &mut home);
        let mut slid = Vec::new();
        append_ui(&s, &pak, [[0.0, 0.0], [-40.0, 12.0]], &mut slid);
        assert_eq!(home.len(), 2);
        let (hx, hy) = xy_of(&home, 0);
        assert_eq!(xy_of(&slid, 0), (hx - 40.0, hy + 12.0), "the HUD tile moved");
        assert_eq!(xy_of(&slid, 1), xy_of(&home, 1), "the rest of the UI did not");
    }

    #[test]
    fn panels_rest_at_home_out_of_battle() {
        let mut s = Scene::new();
        s.op(op::UI_PANEL, &[1, 0, 0, 10, 4], None);
        let card = Rect::of(0.0, 0.0, 100.0, 100.0);
        // No arena staged: nothing to dodge, so nothing moves.
        assert_eq!(ease_panels(&s, &[None, Some(card)]), [[0.0; 2]; UI_PANELS]);
    }

    #[test]
    fn re_declaring_the_same_panel_does_not_move_it() {
        let mut s = Scene::new();
        s.op(op::ARENA, &[0, 4, 4, 0, 0], None);
        s.op(op::UI_PANEL, &[1, 0, 0, 10, 4], None);
        let own = Rect::of(60.0, 0.0, 160.0, 90.0);
        for _ in 0..200 {
            ease_panels(&s, &[None, Some(own)]);
        }
        let settled = s.ui_panel_off[1].get();
        assert!(settled[0] != 0.0, "it should have moved off the GB cells");
        // The battle HUD re-declares its rects on every repaint, which is
        // every A press -- and a repaint is uiClear FIRST, then the rects.
        // Neither may send it home again.
        s.op(op::UI_PANEL, &[1, 0, 0, 10, 4], None);
        assert_eq!(s.ui_panel_off[1].get(), settled, "an A press moved the HUD");
        s.op(op::UI_CLEAR, &[], None);
        s.op(op::UI_PANEL, &[1, 0, 0, 10, 4], None);
        s.op(op::UI_PANEL, &[0, 10, 7, 10, 5], None);
        assert_eq!(s.ui_panel_off[1].get(), settled, "a repaint moved the HUD");
        // A rect that really changed starts over.
        s.op(op::UI_PANEL, &[1, 0, 0, 9, 4], None);
        assert_eq!(s.ui_panel_off[1].get(), [0.0, 0.0]);
    }

    #[test]
    fn two_panels_do_not_land_on_each_other() {
        let mut s = Scene::new();
        s.op(op::ARENA, &[0, 4, 4, 0, 0], None);
        s.op(op::UI_PANEL, &[1, 0, 0, 10, 4], None);
        s.op(op::UI_PANEL, &[0, 10, 7, 10, 5], None);
        // Both mons crowded into the middle: the panels have to take
        // different ways out, not the same one.
        let cards = [
            Some(Rect::of(150.0, 60.0, 260.0, 170.0)),
            Some(Rect::of(170.0, 20.0, 280.0, 130.0)),
        ];
        let mut rects = [Rect::default(); UI_PANELS];
        for _ in 0..200 {
            let off = ease_panels(&s, &cards);
            for i in 0..UI_PANELS {
                rects[i] = panel_home(&s.ui_panels[i]).shifted(off[i][0], off[i][1]);
            }
        }
        assert!(!rects[0].overlaps(&rects[1]), "{:?} over {:?}", rects[0], rects[1]);
    }

    #[test]
    fn a_panel_eases_clear_and_then_stops() {
        let mut s = Scene::new();
        s.op(op::ARENA, &[0, 4, 4, 0, 0], None);
        s.op(op::UI_PANEL, &[1, 0, 0, 10, 4], None);
        let own = Rect::of(60.0, 0.0, 160.0, 90.0);
        // It gets there gradually rather than snapping.
        let first = ease_panels(&s, &[None, Some(own)])[1];
        assert!(first[0] != 0.0 && first[0].abs() < 40.0, "snapped: {first:?}");
        let mut last = first;
        for _ in 0..200 {
            last = ease_panels(&s, &[None, Some(own)])[1];
        }
        // ... lands clear of the sprite ...
        let placed = panel_home(&s.ui_panels[1]).shifted(last[0], last[1]);
        assert!(!placed.overlaps(&own), "{placed:?} is on the sprite");
        // ... and then holds still: a panel that keeps re-solving drifts
        // under the camera and reads as the HUD twitching.
        let settled = ease_panels(&s, &[None, Some(own)])[1];
        assert_eq!(settled, last, "it never came to rest");
    }

    #[test]
    fn a_blinking_sprite_leaves_the_panel_alone() {
        let mut s = Scene::new();
        s.op(op::ARENA, &[0, 4, 4, 0, 0], None);
        s.op(op::UI_PANEL, &[1, 0, 0, 10, 4], None);
        let own = Rect::of(60.0, 0.0, 160.0, 90.0);
        for _ in 0..200 {
            ease_panels(&s, &[None, Some(own)]);
        }
        let settled = s.ui_panel_off[1].get();
        assert!(settled[0] != 0.0);
        // The hit flicker: drawn, gone, drawn, gone. The panel has to hold
        // its ground through it rather than treating a blink as open space.
        for f in 0..40 {
            let cards = if f % 2 == 0 { [None, None] } else { [None, Some(own)] };
            ease_panels(&s, &cards);
        }
        assert_eq!(s.ui_panel_off[1].get(), settled, "the HUD hopped on a blink");
    }

    #[test]
    fn a_sprite_that_moves_a_little_leaves_the_panel_alone() {
        let mut s = Scene::new();
        s.op(op::ARENA, &[0, 4, 4, 0, 0], None);
        s.op(op::UI_PANEL, &[1, 0, 0, 10, 4], None);
        let own = Rect::of(60.0, 0.0, 160.0, 90.0);
        for _ in 0..200 {
            ease_panels(&s, &[None, Some(own)]);
        }
        let settled = s.ui_panel_off[1].get();
        // A lunge's worth of movement, toward the panel but not into it.
        let lunged = Rect::of(64.0, 2.0, 164.0, 92.0);
        for _ in 0..30 {
            ease_panels(&s, &[None, Some(lunged)]);
        }
        assert_eq!(s.ui_panel_off[1].get(), settled, "the HUD chased the lunge");
    }

    #[test]
    fn an_animation_lands_on_the_mons_wherever_they_are() {
        let mut s = Scene::new();
        s.op(op::ARENA, &[0, 4, 4, 0, 0], None);
        // Two cards a long way from where the flat game drew its pics.
        let player = Rect::of(120.0, 150.0, 200.0, 230.0);
        let enemy = Rect::of(300.0, 40.0, 380.0, 120.0);
        let cards = [Some(player), Some(enemy)];
        // The GB pic centres: what the animations were authored against.
        for (gb, card) in [(GB_PLAYER_PIC, player), (GB_ENEMY_PIC, enemy)] {
            s.op(op::ANIM_CLEAR, &[], None);
            s.op(op::ANIM_SPRITE, &[3, 0, gb.0 as i32 - 4, gb.1 as i32 - 4, 0], None);
            let mut items = Vec::new();
            append_anim(&s, &cards, &mut items);
            let Item::AnimQuad { x, y, w, h, .. } = items[0] else { panic!("no quad") };
            // A tile drawn at a pic's centre lands on that mon's card.
            let (cx, cy) = (x + w * 0.5, y + h * 0.5);
            let (mx, my) = ((card.x0 + card.x1) * 0.5, (card.y0 + card.y1) * 0.5);
            assert!(
                (cx - mx).abs() < 12.0 && (cy - my).abs() < 12.0,
                "tile at {cx},{cy} but the mon is at {mx},{my}",
            );
        }
    }

    #[test]
    fn a_reversed_camera_reverses_the_animation() {
        let mut s = Scene::new();
        s.op(op::ARENA, &[0, 4, 4, 0, 0], None);
        // The camera swung round: the ENEMY is now the left-hand mon.
        let player = Rect::of(300.0, 150.0, 380.0, 230.0);
        let enemy = Rect::of(120.0, 40.0, 200.0, 120.0);
        let cards = [Some(player), Some(enemy)];
        for (gb, card) in [(GB_PLAYER_PIC, player), (GB_ENEMY_PIC, enemy)] {
            s.op(op::ANIM_CLEAR, &[], None);
            // flags 0: the tile is not flipped in the GB's own layout
            s.op(op::ANIM_SPRITE, &[3, 0, gb.0 as i32 - 4, gb.1 as i32 - 4, 0], None);
            let mut items = Vec::new();
            append_anim(&s, &cards, &mut items);
            let Item::AnimQuad { x, y, w, h, flip_x, .. } = items[0] else {
                panic!("no quad")
            };
            let (cx, cy) = (x + w * 0.5, y + h * 0.5);
            let (mx, my) = ((card.x0 + card.x1) * 0.5, (card.y0 + card.y1) * 0.5);
            assert!(
                (cx - mx).abs() < 12.0 && (cy - my).abs() < 12.0,
                "tile at {cx},{cy} but the mon is at {mx},{my}",
            );
            // the drawing is mirrored with the layout
            assert!(flip_x, "a reversed animation has to mirror its tiles");
        }
    }

    #[test]
    fn without_cards_an_animation_keeps_the_gb_frame() {
        let mut s = Scene::new();
        s.op(op::ANIM_SPRITE, &[3, 7, 0, 16, 0], None);
        let mut items = Vec::new();
        append_anim(&s, &[None; UI_PANELS], &mut items);
        match items[0] {
            Item::AnimQuad { x, y, w, .. } => {
                assert!((x - UI_ORIGIN_X).abs() < 1e-3);
                assert!((y - 16.0 * UI_SCALE).abs() < 1e-3);
                assert!((w - UI_TILE_PX).abs() < 1e-3);
            }
            _ => panic!("expected an AnimQuad"),
        }
    }

    #[test]
    fn anim_sprites_land_in_the_ui_frame_and_flip() {
        let mut s = Scene::new();
        let mut items = Vec::new();
        append_anim(&s, &[None; UI_PANELS], &mut items);
        assert!(items.is_empty());
        // a tile at the top-left of the GB screen, x-flipped
        s.op(op::ANIM_SPRITE, &[3, 7, 0, 16, 1], None);
        s.op(op::ANIM_SPRITE, &[3, 8, 8, 16, 2], None);
        append_anim(&s, &[None; UI_PANELS], &mut items);
        assert_eq!(items.len(), 2);
        match items[0] {
            Item::AnimQuad { x, y, w, h, page, tile, flip_x, flip_y } => {
                assert!((x - UI_ORIGIN_X).abs() < 1e-3);
                assert!((y - 16.0 * UI_SCALE).abs() < 1e-3);
                assert!((w - UI_TILE_PX).abs() < 1e-3 && (h - UI_TILE_PX).abs() < 1e-3);
                assert_eq!((page, tile), (3, 7));
                assert!(flip_x && !flip_y);
            }
            _ => panic!("expected an AnimQuad"),
        }
        match items[1] {
            Item::AnimQuad { x, flip_x, flip_y, .. } => {
                assert!((x - (UI_ORIGIN_X + 8.0 * UI_SCALE)).abs() < 1e-3);
                assert!(!flip_x && flip_y);
            }
            _ => panic!("expected an AnimQuad"),
        }
        // the animation ends: the list empties, the UI keeps its own tiles
        s.op(op::ANIM_CLEAR, &[], None);
        let mut after = Vec::new();
        append_anim(&s, &[None; UI_PANELS], &mut after);
        assert!(after.is_empty());
    }

    #[test]
    fn grid_text_and_reveal_emit_quads() {
        let blob = pak::AlignedBlob::from_bytes(&pak::tests::tiny_pak_bytes());
        let pak = pak::read(blob.bytes()).unwrap();
        let mut s = Scene::new();
        let count = |s: &Scene| {
            let mut items = Vec::new();
            append_ui(s, &pak, [[0.0; 2]; UI_PANELS], &mut items);
            items.len()
        };
        assert_eq!(count(&s), 0);
        s.op(op::UI_TILE, &[0, 0, 9], None);
        assert_eq!(count(&s), 1);
        // "AB A" has glyphs for A and B; the space misses the CMAP but
        // still advances and counts toward the reveal.
        s.op(op::UI_TEXT, &[1, 1], Some("AB A"));
        assert_eq!(count(&s), 1 + 3);
        s.op(op::UI_REVEAL, &[0], None);
        assert_eq!(count(&s), 1);
        s.op(op::UI_REVEAL, &[3], None);
        assert_eq!(count(&s), 1 + 2, "reveal 3 = A, B, space");
        s.op(op::UI_REVEAL, &[4], None);
        assert_eq!(count(&s), 1 + 3);
        s.op(op::UI_CLEAR, &[], None);
        assert_eq!(count(&s), 0);
    }
}
