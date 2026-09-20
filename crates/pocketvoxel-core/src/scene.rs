//! The retained scene the guest drives through `voxel` surface ops
//! (contracts/spec/voxel-spec.ts §Ops). Presentation state only — zero
//! gameplay: map slots, camera, pitch tween, tint, stamp toggles, entity
//! billboards, the GB UI tile layer, and the battle stage.
//!
//! Dispatch is defensive by contract: an unknown op code, a malformed arg
//! list, or an out-of-range slot is a **no-op, never a panic** — the op
//! stream crosses a trust boundary (the QuickJS guest) and the core must
//! survive anything it says.

use alloc::string::String;
use alloc::vec::Vec;
use core::cell::Cell;

use crate::audio::Audio;
use crate::pak::Pak;
use crate::spec::{
    self, ANIM_SPRITES_MAX, ENTS_MAX, PITCH_RUNGS, PITCH_TWEEN_TICKS, Q8, QUALITY, QUALITY_TIER_DEFAULT,
    QualityDials, RIG_ZOOM_MAX, RIG_ZOOM_MIN, UI_COLS, UI_PANELS, UI_ROWS, op,
};

/// Map slots: slot 0 is the current map, 1..4 the connected neighbours at
/// their seam offsets (voxel-spec.ts `mapShow`).
pub const MAP_SLOTS: usize = 5;

/// Packed [`OpResult::Stats`] layout: `u32 tick | u32 ops_applied`.
/// Debug-only counters, not part of the contract.
pub const STATS_LEN: usize = 8;

/// What an op call hands back to the host.
#[derive(Clone, Debug, PartialEq)]
pub enum OpResult {
    /// Nothing to return (the overwhelmingly common case).
    None,
    /// `gamedata()`: the host must answer with the pak's GAME section — the
    /// scene deliberately does not hold the pak, so it signals instead of
    /// carrying the bytes.
    Gamedata,
    /// `stats()`: packed frame counters ([`STATS_LEN`]).
    Stats([u8; STATS_LEN]),
}

#[derive(Clone, Copy, Debug, Default)]
pub struct MapSlot {
    pub shown: bool,
    pub map_id: u32,
    /// Seam offset in world px (applied to x / z).
    pub ox: i32,
    pub oy: i32,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Ent {
    pub shown: bool,
    /// Atlas page index of the walk sheet (16x16 frames stacked vertically).
    pub sheet: i32,
    pub frame: i32,
    /// World px, Q4 fixed (value = px * 16).
    pub x: i32,
    pub y: i32,
    /// World px above ground (the card's feet height).
    pub lift: i32,
    pub flags: u32,
    /// `spec::emote` kind; 0 = none.
    pub emote: u8,
}

#[derive(Clone, Debug)]
pub struct UiText {
    /// Grid cell of the first glyph.
    pub x: i32,
    pub y: i32,
    pub text: String,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct BattleCard {
    pub shown: bool,
    /// Atlas page index of the pic (one page per battle sprite).
    pub pic: i32,
    /// Cell coords on the current map.
    pub x: i32,
    pub y: i32,
    /// Animation offset from the cell centre, Q4 px (the same fixed point
    /// `Ent` positions use). Cells are 16 px, far too coarse for an attack
    /// lunge or a faint slide, so the battle animations (guest side:
    /// voxelmon/game/battle/anim.ts) ride here instead of moving the card
    /// between cells. `dy` lifts: negative sinks the card into the ground,
    /// which is how the faint slide reads.
    pub dx: i32,
    pub dy: i32,
    pub dz: i32,
}

#[derive(Clone, Copy, Debug)]
pub struct Battle {
    pub active: bool,
    pub map_id: u32,
    /// Arena anchor cell.
    pub x: i32,
    pub y: i32,
    /// `spec::arena_shape`.
    pub shape: u8,
    /// 0 = tele, 1 = wide.
    pub rig: u8,
    /// Player (0) / enemy (1).
    pub cards: [BattleCard; 2],
    /// Q8 turn fraction (wraps).
    pub orbit: i32,
    /// Q8 fraction of RIG_PITCH_MAX_DEG (clamped at use).
    pub pitch: i32,
    /// Q8 zoom multiplier (clamped to RIG_ZOOM_MIN..MAX at use).
    pub zoom: i32,
}

impl Default for Battle {
    fn default() -> Self {
        Self {
            active: false,
            map_id: 0,
            x: 0,
            y: 0,
            shape: 0,
            rig: 0,
            cards: [BattleCard::default(); 2],
            orbit: 0,
            pitch: 0,
            zoom: Q8, // 1.0x
        }
    }
}

pub struct Scene {
    pub maps: [MapSlot; MAP_SLOTS],
    /// Camera view centre in world px, Q4 fixed.
    pub cam_x: i32,
    pub cam_y: i32,
    /// Current pitch rung (PITCH_RUNGS index) the tween heads toward.
    pub pitch_rung: usize,
    /// Pitch in degrees the running tween left from.
    pub pitch_from_deg: f32,
    /// Ticks since the tween started (saturates; >= PITCH_TWEEN_TICKS = settled).
    pub pitch_t: u32,
    /// Global day tint, ABGR (0xffffffff = neutral).
    pub tint: u32,
    /// The player's own camera swing, radians, on top of whatever camera the
    /// scene asks for: yaw around the focus, and elevation.
    ///
    /// Here rather than in the host so ONE camera carries it. The billboard
    /// lean, the card facing, the frustum and the projection all read the
    /// camera; a host that swung only the matrix would leave every one of
    /// them oriented to a camera that is no longer being drawn from -- cards
    /// edge-on to the viewer, chunks culled out of a view they are inside.
    pub cam_yaw_off: f32,
    pub cam_pitch_off: f32,
    /// How far the overworld camera sits from its focus, as a multiple of the
    /// default (one view height). 1.0 is the framing everything was built
    /// against, so a host that never touches this gets exactly the camera it
    /// had before camera modes existed -- goldens included.
    pub cam_dist_scale: f32,
    /// Which camera rig is in charge: 0 the orbit this port has always used,
    /// 1 first person, 2 third person (cam::free_cam). The orbit is 0 so a
    /// zeroed scene is the old camera.
    pub cam_rig: u8,
    /// Where the free rig is looking, radians. Yaw 0 looks north, the way an
    /// unswung orbit looks; pitch is positive looking down.
    pub cam_rig_yaw: f32,
    pub cam_rig_pitch: f32,
    /// Boom length as a multiple of cam::FREE_BOOM (third person only).
    pub cam_rig_zoom: f32,
    /// Selected SGB palette: index into the pak's SGB set (VPAL[4 + i]) for
    /// the non-ui atlas kinds; -1 = the GB grayscale ramp (voxel-spec.ts
    /// `palette`).
    pub palette: i32,
    /// Stamps toggled OFF: (map_id, cx, cy). Stamps default to shown.
    pub stamps_off: Vec<(u32, i16, i16)>,
    /// A field effect billboard: world px x, z and an emote-page frame.
    /// `None` when nothing is showing. See spec's `fieldFx`.
    pub field_fx: Option<(f32, f32, u16)>,
    pub ents: [Ent; ENTS_MAX],
    /// Screen-space pictures (intro portraits, title art). Logical 480x272.
    pub pics: [Pic; PICS_MAX],
    /// The GB UI tile grid, row-major. Tile 0 = empty (not drawn).
    pub ui: [u16; UI_COLS * UI_ROWS],
    /// Kanto Gear companion (bottom screen) tile grid — same 20x18 layout as
    /// `ui`, filled by the UI_*_BOTTOM ops and rendered to the 3DS bottom
    /// screen. Retained like `ui`; a host without a second screen ignores it.
    pub ui_b: [u16; UI_COLS * UI_ROWS],
    /// Sprites stacked on the companion surface this frame — see
    /// [`BottomSprite`]. Reset by `uiClearBottom`, like `ui_b`.
    /// The battle HUD panels, by side (`uiPanel`).
    pub ui_panels: [UiPanel; UI_PANELS],
    /// Where each panel is actually drawn, in UI px, eased toward the place
    /// the camera leaves room for so a swing slides it instead of snapping.
    ///
    /// A `Cell` because the draw pass is the only thing that knows where the
    /// sprites landed and it takes the scene by shared reference; nothing
    /// else reads or writes these.
    pub ui_panel_off: [Cell<[f32; 2]>; UI_PANELS],
    /// Where each panel is heading. Held separately from where it IS so a
    /// placement is judged on the clearance it was chosen for, not on the
    /// clearance it happens to have partway through easing into it.
    pub ui_panel_target: [Cell<[f32; 2]>; UI_PANELS],
    /// The last screen rect each side's card was drawn at (x0, y0, x1, y1),
    /// empty when that side has not been seen. The hit flicker blinks a
    /// card off every other frame; without this the HUD read those frames
    /// as the sprite having left and hopped back to its GB cells.
    pub ui_card_seen: [Cell<[f32; 4]>; UI_PANELS],
    /// This frame's move-animation sprites (`animSprite`/`animClear`).
    pub anim_sprites: [AnimSprite; ANIM_SPRITES_MAX],
    pub anim_sprite_n: u8,
    pub ui_b_sprites: [BottomSprite; UI_B_SPRITES_MAX],
    /// Sprites written so far this frame (`uiSpriteBottom` calls since the
    /// last `uiClearBottom`).
    pub ui_b_sprite_n: u8,
    /// The last `uiText` run; drawn over the grid, capped by `ui_reveal`.
    pub ui_text: Option<UiText>,
    /// Glyphs of `ui_text` shown. `uiText` resets it to "all".
    pub ui_reveal: u32,
    pub battle: Battle,
    /// The quality rung this host climbed to (`spec::quality_tier`), always a
    /// valid index into [`spec::QUALITY`]. HOST configuration, not guest
    /// state: the host knows the machine, so `reset()` keeps this exactly as
    /// it keeps the synth's rate (voxel-spec.ts `quality`).
    pub quality: u8,
    /// The chip synth. Presentation like everything else here: the guest says
    /// what to play in numbers, the core interprets the ROM's channel
    /// programs, and the host pumps [`Scene::render_audio`] for the frames
    /// its ring wants. A host that mounts no audio module never pumps, and
    /// the identical op stream runs silent.
    pub audio: Audio,
    /// The tick index — the only clock (tile animation, cursors, rig drift).
    pub tick: u32,
    /// Total ops dispatched (debug counter for `stats()`).
    pub ops: u32,
}

/// One screen-space picture: a whole atlas page scaled into a rect.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Pic {
    pub shown: bool,
    pub page: u16,
    pub x: i16,
    pub y: i16,
    pub w: i16,
    pub h: i16,
}

pub const PICS_MAX: usize = 4;

/// One sprite drawn on the Kanto Gear companion (bottom screen) surface: a
/// whole atlas `page` scaled into a rect, in the bottom screen's native
/// 320x240 pixel space (the same ortho main.rs renders the panel with — no
/// squish, unlike the top-screen `Pic`'s 480x272 logical space).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct BottomSprite {
    pub page: u16,
    pub x: i16,
    pub y: i16,
    pub w: i16,
    pub h: i16,
}

/// A rectangle of the UI grid the core may slide as a block (`uiPanel`).
///
/// The battle HUDs are drawn in the GB's fixed cells, but what they used to
/// sit beside is a 3D card now: it moves with the camera and would end up
/// under the name and the HP bar. The guest keeps drawing GB tiles and
/// declares which cells belong to which side; the draw pass slides the rect
/// to keep it clear of the sprites (ui::panel_shift).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct UiPanel {
    pub x: u8,
    pub y: u8,
    pub w: u8,
    pub h: u8,
}

impl UiPanel {
    /// Whether a grid cell is part of this panel (an empty panel holds none).
    pub fn holds(&self, cx: i32, cy: i32) -> bool {
        self.w > 0
            && cx >= self.x as i32
            && cx < self.x as i32 + self.w as i32
            && cy >= self.y as i32
            && cy < self.y as i32 + self.h as i32
    }
}

/// One 8x8 move-animation tile (`animSprite`), in GAME BOY pixels: the
/// guest has already taken OAM space off (x - 8, y - 16). `tile` indexes
/// the sheet sixteen to a row; `flags` bit 0 is x-flip, bit 1 y-flip.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct AnimSprite {
    pub page: u16,
    pub tile: u16,
    pub x: i16,
    pub y: i16,
    pub flags: u8,
}

/// `uiSpriteBottom` calls per frame are append-only like the tile grid: the
/// guest re-emits every sprite each frame and `uiClearBottom` resets the
/// count. 8 covers the party grid's 6 mons plus headroom.
pub const UI_B_SPRITES_MAX: usize = 8;

impl Scene {
    pub fn new() -> Self {
        Self {
            maps: [MapSlot::default(); MAP_SLOTS],
            cam_x: 0,
            cam_y: 0,
            pitch_rung: 0,
            pitch_from_deg: PITCH_RUNGS[0],
            pitch_t: PITCH_TWEEN_TICKS, // settled at rung 0
            tint: 0xffff_ffff,
            cam_yaw_off: 0.0,
            cam_pitch_off: 0.0,
            cam_dist_scale: 1.0,
            cam_rig: 0,
            cam_rig_yaw: 0.0,
            cam_rig_pitch: crate::cam::FREE_PITCH_DEFAULT,
            cam_rig_zoom: 1.0,
            palette: -1,
            stamps_off: Vec::new(),
            field_fx: None,
            ents: [Ent::default(); ENTS_MAX],
            pics: [Pic::default(); PICS_MAX],
            ui: [0u16; UI_COLS * UI_ROWS],
            ui_b: [0u16; UI_COLS * UI_ROWS],
            ui_panels: [UiPanel::default(); UI_PANELS],
            ui_panel_off: [const { Cell::new([0.0, 0.0]) }; UI_PANELS],
            ui_panel_target: [const { Cell::new([0.0, 0.0]) }; UI_PANELS],
            ui_card_seen: [const { Cell::new([0.0; 4]) }; UI_PANELS],
            anim_sprites: [AnimSprite::default(); ANIM_SPRITES_MAX],
            anim_sprite_n: 0,
            ui_b_sprites: [BottomSprite::default(); UI_B_SPRITES_MAX],
            ui_b_sprite_n: 0,
            ui_text: None,
            ui_reveal: u32::MAX,
            battle: Battle::default(),
            quality: QUALITY_TIER_DEFAULT,
            audio: Audio::new(),
            tick: 0,
            ops: 0,
        }
    }

    /// The dials of the rung this scene is on — the ONE place the ladder is
    /// read. `quality` is range-checked on the way in, so this cannot fail;
    /// the fallback keeps an impossible value rendering the default rung
    /// rather than panicking on untrusted state.
    pub fn dials(&self) -> &'static QualityDials {
        QUALITY
            .get(self.quality as usize)
            .unwrap_or(&QUALITY[QUALITY_TIER_DEFAULT as usize])
    }

    /// Advance the tick clock. The host calls this exactly once per frame,
    /// after the tick's ops.
    pub fn tick(&mut self) {
        self.tick = self.tick.wrapping_add(1);
        self.pitch_t = self.pitch_t.saturating_add(1);
        self.audio.tick();
    }

    /// Render `frames` interleaved stereo frames of the chip synth into `out`
    /// (which must hold `frames * 2` samples; a short buffer renders what
    /// fits). The host calls this once per tick with exactly the frames its
    /// ring wants — `audioFramesForTick` on a virtual clock, whatever the
    /// device's credit says on a real one.
    ///
    /// Pure in (the ops applied so far, the frames asked for): no clock is
    /// read, so splitting one tick's frames across two calls writes the same
    /// bytes as asking for them at once.
    pub fn render_audio(&mut self, pak: &Pak<'_>, frames: usize, out: &mut [i16]) {
        let want = frames.min(out.len() / 2) * 2;
        self.audio.render(pak.audio_programs(), &mut out[..want]);
    }

    /// The tweened camera pitch in degrees (smoothstep between the tween's
    /// start pitch and the target rung over PITCH_TWEEN_TICKS).
    pub fn pitch_deg(&self) -> f32 {
        let target = PITCH_RUNGS[self.pitch_rung];
        let t = (self.pitch_t as f32 / PITCH_TWEEN_TICKS as f32).min(1.0);
        let s = t * t * (3.0 - 2.0 * t);
        self.pitch_from_deg + (target - self.pitch_from_deg) * s
    }

    /// Camera view centre in world px (Q4 -> f32).
    pub fn cam_px(&self) -> (f32, f32) {
        (
            self.cam_x as f32 / spec::Q4 as f32,
            self.cam_y as f32 / spec::Q4 as f32,
        )
    }

    /// True when the stamp at (map_id, cx, cy) is currently shown.
    pub fn stamp_shown(&self, map_id: u32, cx: i16, cy: i16) -> bool {
        !self
            .stamps_off
            .iter()
            .any(|&(m, x, y)| m == map_id && x == cx && y == cy)
    }

    /// The battle zoom as a clamped multiplier.
    pub fn battle_zoom(&self) -> f32 {
        (self.battle.zoom as f32 / Q8 as f32).clamp(RIG_ZOOM_MIN, RIG_ZOOM_MAX)
    }

    /// Dispatch one op (voxel-spec.ts §Ops). `args` are the numeric args in
    /// order; `s` carries the string for the string-bearing ops (`uiText`).
    /// Unknown codes and malformed calls are no-ops.
    pub fn op(&mut self, code: u32, args: &[i32], s: Option<&str>) -> OpResult {
        self.ops = self.ops.wrapping_add(1);
        let a = |i: usize| args.get(i).copied().unwrap_or(0);
        // The audio group owns its own codes (voxel-spec.ts §audio).
        if self.audio.op(code, args) {
            return OpResult::None;
        }
        match code {
            op::GAMEDATA => return OpResult::Gamedata,
            op::STATS => {
                let mut out = [0u8; STATS_LEN];
                out[0..4].copy_from_slice(&self.tick.to_le_bytes());
                out[4..8].copy_from_slice(&self.ops.to_le_bytes());
                return OpResult::Stats(out);
            }
            op::RESET => {
                // The synth's pinned engine tables and output rate are boot
                // configuration, not scene state; carry them across. So is
                // the quality rung: the machine did not change.
                let audio = core::mem::take(&mut self.audio).into_reset();
                let quality = self.quality;
                *self = Scene::new();
                self.audio = audio;
                self.quality = quality;
            }
            op::QUALITY => {
                // Out of range is a no-op, never a clamp: a host naming a rung
                // this core does not carry keeps the rung it had rather than
                // silently landing on a neighbour's dials.
                let tier = a(0);
                if !args.is_empty() && (0..QUALITY.len() as i32).contains(&tier) {
                    self.quality = tier as u8;
                }
            }

            op::MAP_SHOW => {
                if args.len() >= 4
                    && let Some(slot) = self.maps.get_mut(a(0) as usize)
                {
                    *slot = MapSlot {
                        shown: true,
                        map_id: a(1) as u32,
                        ox: a(2),
                        oy: a(3),
                    };
                }
            }
            op::MAP_HIDE => {
                if let Some(slot) = self.maps.get_mut(a(0) as usize) {
                    slot.shown = false;
                }
            }
            op::CAM => {
                if args.len() >= 2 {
                    self.cam_x = a(0);
                    self.cam_y = a(1);
                }
            }
            op::PITCH => {
                let rung = a(0);
                if (0..PITCH_RUNGS.len() as i32).contains(&rung) {
                    // Restart the tween from wherever the camera is now, so
                    // a mid-tween rung change never snaps.
                    self.pitch_from_deg = self.pitch_deg();
                    self.pitch_rung = rung as usize;
                    self.pitch_t = 0;
                }
            }
            op::TINT => self.tint = a(0) as u32,
            op::PALETTE => {
                if !args.is_empty() {
                    self.palette = a(0);
                }
            }
            op::FIELD_FX => {
                // x, z in Q4 world px, then the frame; a negative frame
                // clears. The guest re-sends this every frame it wants the
                // sprite up, so there is no timer to keep here.
                if args.len() >= 3 && a(2) >= 0 {
                    self.field_fx = Some((
                        a(0) as f32 / spec::Q4 as f32,
                        a(1) as f32 / spec::Q4 as f32,
                        a(2) as u16,
                    ));
                } else {
                    self.field_fx = None;
                }
            }
            op::STAMP => {
                if args.len() >= 4 {
                    let key = (a(0) as u32, a(1) as i16, a(2) as i16);
                    self.stamps_off.retain(|&k| k != key);
                    if a(3) == 0 {
                        self.stamps_off.push(key);
                    }
                }
            }

            op::ENT => {
                if args.len() >= 7
                    && let Some(ent) = self.ents.get_mut(a(0) as usize)
                {
                    let emote = ent.emote; // pose updates keep the bubble
                    *ent = Ent {
                        shown: true,
                        sheet: a(1),
                        frame: a(2),
                        x: a(3),
                        y: a(4),
                        lift: a(5),
                        flags: a(6) as u32,
                        emote,
                    };
                }
            }
            op::PIC => {
                if let Some(pic) = self.pics.get_mut(a(0) as usize) {
                    pic.shown = true;
                    pic.page = a(1) as u16;
                    pic.x = a(2) as i16;
                    pic.y = a(3) as i16;
                    pic.w = a(4) as i16;
                    pic.h = a(5) as i16;
                }
            }
            op::PIC_HIDE => {
                if let Some(pic) = self.pics.get_mut(a(0) as usize) {
                    pic.shown = false;
                }
            }
            op::ENT_HIDE => {
                if let Some(ent) = self.ents.get_mut(a(0) as usize) {
                    ent.shown = false;
                    ent.emote = spec::emote::NONE;
                }
            }
            op::EMOTE => {
                if args.len() >= 2
                    && let Some(ent) = self.ents.get_mut(a(0) as usize)
                {
                    ent.emote = a(1) as u8;
                }
            }

            op::UI_TILE => {
                if args.len() >= 3 {
                    let (x, y) = (a(0), a(1));
                    if (0..UI_COLS as i32).contains(&x) && (0..UI_ROWS as i32).contains(&y) {
                        self.ui[y as usize * UI_COLS + x as usize] = a(2) as u16;
                    }
                }
            }
            op::UI_FILL => {
                if args.len() >= 5 {
                    let x0 = a(0).clamp(0, UI_COLS as i32);
                    let y0 = a(1).clamp(0, UI_ROWS as i32);
                    let x1 = a(0).saturating_add(a(2).max(0)).clamp(0, UI_COLS as i32);
                    let y1 = a(1).saturating_add(a(3).max(0)).clamp(0, UI_ROWS as i32);
                    for y in y0..y1 {
                        for x in x0..x1 {
                            self.ui[y as usize * UI_COLS + x as usize] = a(4) as u16;
                        }
                    }
                }
            }
            op::UI_TEXT => {
                if args.len() >= 2
                    && let Some(text) = s
                {
                    self.ui_text = Some(UiText {
                        x: a(0),
                        y: a(1),
                        text: String::from(text),
                    });
                    // New text shows fully until the guest starts a reveal.
                    self.ui_reveal = u32::MAX;
                }
            }
            op::UI_REVEAL => self.ui_reveal = a(0).max(0) as u32,
            op::UI_CLEAR => {
                self.ui = [0u16; UI_COLS * UI_ROWS];
                self.ui_panels = [UiPanel::default(); UI_PANELS];
                for (off, target) in self.ui_panel_off.iter().zip(self.ui_panel_target.iter()) {
                    off.set([0.0, 0.0]);
                    target.set([0.0, 0.0]);
                }
                self.ui_text = None;
                self.ui_reveal = u32::MAX;
            }

            // Kanto Gear companion surface (bottom screen): the UI_TILE/FILL/
            // CLEAR logic, written into `ui_b` instead of `ui`. No text run —
            // the companion draws every glyph as a tile (like the guest's
            // stamp()), so ui_b needs only the grid.
            op::UI_TILE_BOTTOM => {
                if args.len() >= 3 {
                    let (x, y) = (a(0), a(1));
                    if (0..UI_COLS as i32).contains(&x) && (0..UI_ROWS as i32).contains(&y) {
                        self.ui_b[y as usize * UI_COLS + x as usize] = a(2) as u16;
                    }
                }
            }
            op::UI_FILL_BOTTOM => {
                if args.len() >= 5 {
                    let x0 = a(0).clamp(0, UI_COLS as i32);
                    let y0 = a(1).clamp(0, UI_ROWS as i32);
                    let x1 = a(0).saturating_add(a(2).max(0)).clamp(0, UI_COLS as i32);
                    let y1 = a(1).saturating_add(a(3).max(0)).clamp(0, UI_ROWS as i32);
                    for y in y0..y1 {
                        for x in x0..x1 {
                            self.ui_b[y as usize * UI_COLS + x as usize] = a(4) as u16;
                        }
                    }
                }
            }
            op::UI_CLEAR_BOTTOM => {
                self.ui_b = [0u16; UI_COLS * UI_ROWS];
                self.ui_b_sprite_n = 0;
            }
            op::UI_SPRITE_BOTTOM => {
                if args.len() >= 5 {
                    let n = self.ui_b_sprite_n as usize;
                    if n < UI_B_SPRITES_MAX {
                        self.ui_b_sprites[n] = BottomSprite {
                            page: a(0) as u16,
                            x: a(1) as i16,
                            y: a(2) as i16,
                            w: a(3) as i16,
                            h: a(4) as i16,
                        };
                        self.ui_b_sprite_n = n as u8 + 1;
                    }
                }
            }

            op::ANIM_SPRITE => {
                if args.len() >= 5 {
                    let n = self.anim_sprite_n as usize;
                    if n < ANIM_SPRITES_MAX {
                        self.anim_sprites[n] = AnimSprite {
                            page: a(0) as u16,
                            tile: a(1) as u16,
                            x: a(2) as i16,
                            y: a(3) as i16,
                            flags: a(4) as u8,
                        };
                        self.anim_sprite_n = n as u8 + 1;
                    }
                }
            }
            op::ANIM_CLEAR => {
                self.anim_sprite_n = 0;
            }
            op::UI_PANEL => {
                if args.len() >= 5 {
                    let i = a(0) as usize;
                    if i < UI_PANELS {
                        let panel = UiPanel {
                            x: a(1).clamp(0, 255) as u8,
                            y: a(2).clamp(0, 255) as u8,
                            w: a(3).clamp(0, 255) as u8,
                            h: a(4).clamp(0, 255) as u8,
                        };
                        // Only a panel that actually CHANGED goes back to
                        // where the GB puts it. The battle HUD re-declares
                        // its rects on every repaint -- which is every time
                        // a press moves the phase on -- and resetting there
                        // made the bar jump home and slide out again on each
                        // A press, which is what it looked like.
                        if panel != self.ui_panels[i] {
                            self.ui_panels[i] = panel;
                            self.ui_panel_off[i].set([0.0, 0.0]);
                            self.ui_panel_target[i].set([0.0, 0.0]);
                        }
                    }
                }
            }

            op::ARENA => {
                if args.len() >= 5 {
                    // Entering the arena resets the staging camera; cards
                    // arrive through their own ops.
                    self.battle = Battle {
                        active: true,
                        map_id: a(0) as u32,
                        x: a(1),
                        y: a(2),
                        shape: a(3) as u8,
                        rig: a(4) as u8,
                        ..Battle::default()
                    };
                }
            }
            op::CARD => {
                if args.len() >= 4
                    && let Some(card) = self.battle.cards.get_mut(a(0) as usize)
                {
                    // args 4..6 (the animation offset) are optional: a guest
                    // that predates battle animations sends four and gets
                    // a still card, exactly as before.
                    *card = BattleCard {
                        shown: true,
                        pic: a(1),
                        x: a(2),
                        y: a(3),
                        dx: if args.len() > 4 { a(4) } else { 0 },
                        dy: if args.len() > 5 { a(5) } else { 0 },
                        dz: if args.len() > 6 { a(6) } else { 0 },
                    };
                }
            }
            op::CARD_HIDE => {
                if let Some(card) = self.battle.cards.get_mut(a(0) as usize) {
                    card.shown = false;
                }
            }
            op::BATTLE_CAM => {
                if args.len() >= 3 {
                    self.battle.orbit = a(0);
                    self.battle.pitch = a(1);
                    self.battle.zoom = a(2);
                }
            }
            op::ARENA_END => self.battle = Battle::default(),

            _ => {} // unknown op: no-op by contract (append-only op space)
        }
        OpResult::None
    }
}

impl Default for Scene {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn op_dispatch_mutates_state() {
        let mut s = Scene::new();
        s.op(op::MAP_SHOW, &[0, 7, 0, 0], None);
        s.op(op::MAP_SHOW, &[1, 8, -128, 0], None);
        assert!(s.maps[0].shown && s.maps[1].shown);
        assert_eq!(s.maps[1].ox, -128);
        s.op(op::MAP_HIDE, &[1], None);
        assert!(!s.maps[1].shown);

        s.op(op::ENT, &[0, 2, 1, 160, 320, 0, 3], None);
        assert!(s.ents[0].shown);
        assert_eq!(s.ents[0].flags, 3);
        s.op(op::EMOTE, &[0, 2], None);
        assert_eq!(s.ents[0].emote, 2);
        s.op(op::ENT, &[0, 2, 2, 176, 320, 0, 3], None);
        assert_eq!(s.ents[0].emote, 2, "pose update keeps the emote");
        s.op(op::ENT_HIDE, &[0], None);
        assert!(!s.ents[0].shown);

        s.op(op::TINT, &[0x40ff8040u32 as i32], None);
        assert_eq!(s.tint, 0x40ff8040);

        assert_eq!(s.palette, -1, "boot palette is the GB grayscale ramp");
        s.op(op::PALETTE, &[3], None);
        assert_eq!(s.palette, 3);
        s.op(op::PALETTE, &[-1], None);
        assert_eq!(s.palette, -1);
        s.op(op::PALETTE, &[5], None);
        s.op(op::PALETTE, &[], None);
        assert_eq!(s.palette, 5, "malformed palette op is a no-op");

        s.op(op::STAMP, &[7, 3, 4, 0], None);
        assert!(!s.stamp_shown(7, 3, 4));
        assert!(s.stamp_shown(7, 3, 5));
        s.op(op::STAMP, &[7, 3, 4, 1], None);
        assert!(s.stamp_shown(7, 3, 4));

        s.op(op::ARENA, &[7, 10, 12, 0, 1], None);
        assert!(s.battle.active);
        assert_eq!(s.battle.rig, 1);
        s.op(op::CARD, &[1, 5, 11, 13], None);
        assert!(s.battle.cards[1].shown);
        s.op(op::ARENA_END, &[], None);
        assert!(!s.battle.active);
    }

    /// The `quality` op is HOST configuration: it survives `reset`, refuses
    /// a rung this core does not carry, and boots at the weakest rung.
    #[test]
    fn quality_is_host_configuration() {
        let mut s = Scene::new();
        assert_eq!(s.quality, spec::quality_tier::PSP, "boots at the weakest");
        assert_eq!(s.dials(), &spec::QUALITY[spec::quality_tier::PSP as usize]);

        s.op(op::QUALITY, &[spec::quality_tier::DESKTOP as i32], None);
        assert_eq!(s.quality, spec::quality_tier::DESKTOP);
        assert_eq!(
            s.dials(),
            &spec::QUALITY[spec::quality_tier::DESKTOP as usize]
        );

        // Out of range and malformed are no-ops, not clamps: a host naming a
        // rung this core is older than keeps the rung it had.
        s.op(op::QUALITY, &[spec::QUALITY.len() as i32], None);
        s.op(op::QUALITY, &[-1], None);
        s.op(op::QUALITY, &[], None);
        assert_eq!(s.quality, spec::quality_tier::DESKTOP);

        // The machine did not change, so neither does the rung.
        s.op(op::CAM, &[99, 99], None);
        s.op(op::RESET, &[], None);
        assert_eq!(s.cam_x, 0, "reset still drops scene state");
        assert_eq!(
            s.quality,
            spec::quality_tier::DESKTOP,
            "reset keeps the rung, like the synth's rate"
        );
    }

    #[test]
    fn unknown_and_malformed_ops_are_noops() {
        let mut s = Scene::new();
        let before_tint = s.tint;
        assert_eq!(s.op(9999, &[1, 2, 3], None), OpResult::None);
        assert_eq!(s.op(0, &[], None), OpResult::None);
        // Malformed: too few args, out-of-range slots.
        s.op(op::MAP_SHOW, &[0, 7], None);
        assert!(!s.maps[0].shown);
        s.op(op::ENT, &[99, 0, 0, 0, 0, 0, 0], None);
        s.op(op::UI_TILE, &[25, 3, 1], None);
        s.op(op::UI_TILE, &[3, -1, 1], None);
        assert!(s.ui.iter().all(|&t| t == 0));
        s.op(op::PITCH, &[99], None);
        assert_eq!(s.pitch_rung, 0);
        assert_eq!(s.tint, before_tint);
    }

    #[test]
    fn ui_text_and_reveal() {
        let mut s = Scene::new();
        s.op(op::UI_TEXT, &[1, 14], Some("HELLO"));
        assert_eq!(s.ui_text.as_ref().unwrap().text, "HELLO");
        assert_eq!(s.ui_reveal, u32::MAX, "fresh text shows fully");
        s.op(op::UI_REVEAL, &[0], None);
        assert_eq!(s.ui_reveal, 0);
        s.op(op::UI_REVEAL, &[3], None);
        assert_eq!(s.ui_reveal, 3);
        s.op(op::UI_TEXT, &[1, 16], Some("WORLD"));
        assert_eq!(s.ui_reveal, u32::MAX, "new text resets the cap");
        s.op(op::UI_CLEAR, &[], None);
        assert!(s.ui_text.is_none());

        s.op(op::UI_FILL, &[18, 16, 5, 5, 7], None);
        assert_eq!(s.ui[17 * UI_COLS + 19], 7, "fill clips to the grid");
        assert_eq!(s.ui[16 * UI_COLS + 17], 0);
    }

    #[test]
    fn q4_cam_and_pitch_tween() {
        let mut s = Scene::new();
        s.op(op::CAM, &[featured_px(120), featured_px(68)], None);
        assert_eq!(s.cam_px(), (120.0, 68.0));
        // Q4 gives sub-pixel scroll.
        s.op(op::CAM, &[featured_px(120) + 8, featured_px(68)], None);
        assert_eq!(s.cam_px().0, 120.5);

        assert_eq!(s.pitch_deg(), 0.0);
        s.op(op::PITCH, &[4], None);
        assert_eq!(s.pitch_deg(), 0.0, "tween starts at the old pitch");
        for _ in 0..PITCH_TWEEN_TICKS {
            s.tick();
        }
        assert_eq!(s.pitch_deg(), PITCH_RUNGS[4]);
        // Halfway is smoothstepped, not linear.
        s.op(op::PITCH, &[0], None);
        for _ in 0..7 {
            s.tick();
        }
        let mid = s.pitch_deg();
        assert!(mid < PITCH_RUNGS[4] && mid > 0.0);

        s.op(op::STATS, &[], None);
        let OpResult::Stats(stats) = s.op(op::STATS, &[], None) else {
            panic!("stats returns bytes");
        };
        assert_eq!(u32::from_le_bytes(stats[0..4].try_into().unwrap()), s.tick);
        assert_eq!(s.op(op::GAMEDATA, &[], None), OpResult::Gamedata);

        s.op(op::PALETTE, &[7], None);
        s.op(op::RESET, &[], None);
        assert_eq!(s.cam_x, 0);
        assert_eq!(s.tick, 0);
        assert_eq!(s.palette, -1, "reset restores the grayscale ramp");
    }

    fn featured_px(px: i32) -> i32 {
        px * spec::Q4
    }
}
