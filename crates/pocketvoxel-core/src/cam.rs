//! The diorama cameras, ported from the upstream mod (docs/VOXEL.md §6):
//! the orbit pitch ladder for free roam and the two solved over-the-shoulder
//! rigs for battle staging. All constants come from `spec`.
//!
//! World conventions (voxel-spec.ts WORLD_AXES): world px, +X east, +Y up,
//! +Z south, right-handed. The orbit camera sits south of its focus and
//! looks north as pitch rises; at rung 0 it is straight overhead and frames
//! exactly like the flat 2D game.

use crate::math::{Frustum, Mat4, Vec3, atan2f, atanf, cosf, sinf, sqrtf, vec3};
use crate::spec::{
    ARENA_GAP_CELLS, CAM_FOCAL, CELL_PX, RIG_DOLLY, RIG_DOLLY_TICKS, RIG_PAN_TICKS,
    RIG_PAN_YAW_DEG, RIG_PITCH_MAX_DEG, RIG_ZOOM_MAX, RIG_ZOOM_MIN, VIEW_H, VIEW_W, WORLD_VIEW_H,
    rig_tele, rig_wide,
};

const PI: f32 = core::f32::consts::PI;
const TAU: f32 = core::f32::consts::TAU;

/// A solved camera: everything a backend needs to draw one frame.
#[derive(Clone, Copy, Debug)]
pub struct Camera {
    pub eye: Vec3,
    pub focus: Vec3,
    pub up: Vec3,
    /// View direction's angle from straight down, radians — the billboard
    /// lean angle and the argument of the camera-ward pull.
    pub a: f32,
    pub fov_y: f32,
    pub aspect: f32,
    pub near: f32,
    pub far: f32,
    /// perspective(fov, aspect, near, far) * lookAt(eye, focus, up).
    pub vp: Mat4,
}

impl Camera {
    pub fn frustum(&self) -> Frustum {
        Frustum::from_clip(&self.vp)
    }
}

fn finish(eye: Vec3, focus: Vec3, up: Vec3, a: f32, fov_y: f32, dist: f32) -> Camera {
    // Near/far bracket the diorama: near hugs the eye (the map is small),
    // far leaves room for neighbour maps behind the horizon.
    let near = (dist * 0.05).max(1.0);
    let far = dist * 4.0 + 4096.0;
    let aspect = VIEW_W as f32 / VIEW_H as f32;
    let vp = Mat4::perspective_gl(fov_y, aspect, near, far).mul(&Mat4::look_at(eye, focus, up));
    Camera {
        eye,
        focus,
        up,
        a,
        fov_y,
        aspect,
        near,
        far,
        vp,
    }
}

/// The free-roam orbit camera at view centre `(cx, cy)` (world px) and
/// `pitch_deg` from straight down (the tweened rung pitch).
///
/// Ported from the upstream mod: dist = CAM_FOCAL * WORLD_VIEW_H and
/// fov = 2*atan(1/(2*CAM_FOCAL)), so a rung-0 (straight-down) camera frames
/// exactly WORLD_VIEW_H world px vertically — framing-identical to the flat
/// 2D game. Screen-up is north (-Z) at every pitch.
pub fn orbit(cx: f32, cy: f32, pitch_deg: f32) -> Camera {
    orbit_at(cx, cy, pitch_deg, CAM_FOCAL * WORLD_VIEW_H as f32)
}

/// The default distance an orbit sits at: one view height, which is what
/// makes a straight-down camera frame exactly the flat game's screen.
pub fn orbit_dist() -> f32 {
    CAM_FOCAL * WORLD_VIEW_H as f32
}

/// [`orbit`], but at a chosen distance.
///
/// The framing distance used to be welded in, because there was one camera
/// and it wanted the one distance. A third-person camera wants to sit closer
/// than the whole screen height; passing the distance is all that takes.
pub fn orbit_at(cx: f32, cy: f32, pitch_deg: f32, dist: f32) -> Camera {
    let a = pitch_deg.to_radians();
    let fov = 2.0 * atanf(1.0 / (2.0 * CAM_FOCAL));
    let focus = vec3(cx, 0.0, cy);
    let eye = vec3(cx, dist * cosf(a), cy + dist * sinf(a));
    let up = vec3(0.0, sinf(a), -cosf(a));
    finish(eye, focus, up, a, fov, dist)
}

/// Lowest and highest the swung camera may sit above its focus, radians.
/// Level with the ground is deliberately reachable -- a card billboards
/// upright there, which is the point of allowing it -- but not below, where
/// the ground goes edge-on and there is nothing to see. The top stops short
/// of straight down, where the look-at up vector degenerates.
pub const SWING_PITCH_MIN: f32 = 0.05;
pub const SWING_PITCH_MAX: f32 = 1.50;

// ---------------------------------------------------------------------------
// The free-roam rig: 1ST and 3RD
// ---------------------------------------------------------------------------
//
// Ported from DramaticShapeVoxelMod's two free-cam rungs (lib/FirstPerson.lua,
// lib/ThirdPerson.lua). The orbit rungs 0/15/35/50/75 this port already has
// swing the camera around the VIEW CENTRE; these two stand it with the player
// instead -- in their eyes, or on a boom off the back of their head.
//
// The numbers are the mod's, not invented: the eye sits near the top of a
// 16px sprite, the lens opens out because you are inside the world rather
// than looking at a diorama of it, and the boom stands three cells back.

/// Eye height above the player's feet, world px (FirstPerson.EYE_HEIGHT).
pub const FREE_EYE_HEIGHT: f32 = 13.0;
/// Vertical FOV inside the world -- wider than the diorama's ~53 degrees.
pub const FREE_FOV: f32 = 65.0 * core::f32::consts::PI / 180.0;
/// How far ahead the rig looks (FirstPerson.FOCUS_DIST).
pub const FREE_FOCUS_DIST: f32 = 24.0;
/// Pitch limits, radians, positive looking DOWN.
pub const FREE_PITCH_DOWN: f32 = 70.0 * core::f32::consts::PI / 180.0;
pub const FREE_PITCH_UP: f32 = -50.0 * core::f32::consts::PI / 180.0;
pub const FREE_PITCH_DEFAULT: f32 = 10.0 * core::f32::consts::PI / 180.0;
/// Boom length at full extension, world px -- three 16px cells back.
pub const FREE_BOOM: f32 = 48.0;
/// Raises the boom's pivot above the eye so it looks down across the
/// shoulder rather than through the back of the head.
pub const FREE_PIVOT_LIFT: f32 = 4.0;
/// Lateral rail offset, positive to the camera's right, so the player sits
/// left of centre and the larger half of the frame is what they face.
pub const FREE_SHOULDER: f32 = 4.0;
/// Zoom range on the boom, as a multiple of [`FREE_BOOM`].
pub const FREE_ZOOM_MIN: f32 = 0.45;
pub const FREE_ZOOM_MAX: f32 = 2.4;
pub const FREE_ZOOM_STEP: f32 = 1.18;
/// Stick rates, radians per second (FirstPerson.STICK_YAW / STICK_PITCH).
pub const FREE_STICK_YAW: f32 = 3.5;
pub const FREE_STICK_PITCH: f32 = 2.4;

/// The rig standing with the player at `(px, pz)`.
///
/// `boom` 0 is first person -- the eye IS the head. Any boom pulls it back
/// along the view line and adds the shoulder rail, which is third person.
/// `yaw` 0 looks north (toward -z), the direction an unswung [`orbit`] looks,
/// so the two ladders agree about which way is forward. `pitch` is positive
/// looking down.
///
/// `a` comes out as the view direction's angle from straight down, same as
/// every other camera here, so the billboard lean and the camera-ward pull
/// keep working without knowing which rig made the camera -- which is what
/// stands the character cards upright when the eye is level with them.
pub fn free_cam(px: f32, pz: f32, yaw: f32, pitch: f32, boom: f32, shoulder: f32) -> Camera {
    let lift = if boom > 0.0 { FREE_PIVOT_LIFT } else { 0.0 };
    let pivot = vec3(px, FREE_EYE_HEIGHT + lift, pz);
    let (sy, cy) = (sinf(yaw), cosf(yaw));
    let (sp, cp) = (sinf(pitch), cosf(pitch));
    let fwd = vec3(sy * cp, -sp, -cy * cp);
    let right = vec3(cy, 0.0, sy);
    let eye = vec3(
        pivot.x - fwd.x * boom + right.x * shoulder,
        pivot.y - fwd.y * boom,
        pivot.z - fwd.z * boom + right.z * shoulder,
    );
    let focus = vec3(
        pivot.x + fwd.x * FREE_FOCUS_DIST,
        pivot.y + fwd.y * FREE_FOCUS_DIST,
        pivot.z + fwd.z * FREE_FOCUS_DIST,
    );
    // `a` is the view direction's angle from straight down. For this rig that
    // is exactly a quarter turn less the pitch -- cos a = -fwd.y = sin pitch,
    // sin a = the horizontal part = cos pitch -- so there is no need for an
    // arccos the math module does not carry.
    let a = core::f32::consts::FRAC_PI_2 - pitch;
    let dist = if boom > FREE_FOCUS_DIST { boom } else { FREE_FOCUS_DIST };
    finish(eye, focus, vec3(0.0, 1.0, 0.0), a, FREE_FOV, dist)
}

/// Clamp a free-rig pitch to what the rung allows.
pub fn clamp_free_pitch(pitch: f32) -> f32 {
    if pitch < FREE_PITCH_UP {
        FREE_PITCH_UP
    } else if pitch > FREE_PITCH_DOWN {
        FREE_PITCH_DOWN
    } else {
        pitch
    }
}

/// The yaw offset that puts the camera BEHIND a player travelling `(dx, dz)`.
///
/// [`swing`] measures yaw as `atan2(v.z, v.x)`, and an unswung [`orbit`] sits
/// at +z of its focus -- yaw pi/2. Behind means the opposite of travel, so the
/// offset is the angle of `-travel` less that pi/2.
///
/// Zero travel returns zero rather than snapping somewhere arbitrary: standing
/// still, a follow camera should stay where it is.
pub fn follow_yaw(dx: f32, dz: f32) -> f32 {
    if dx == 0.0 && dz == 0.0 {
        return 0.0;
    }
    atan2f(-dz, -dx) - core::f32::consts::FRAC_PI_2
}

/// Step `yaw` toward `target` by at most `rate`, the short way round.
///
/// A follow camera that snapped would whip round every time the player turned
/// a corner. Turning at a rate, and taking the shorter arc, is what makes it
/// read as following rather than cutting.
pub fn approach_yaw(yaw: f32, target: f32, rate: f32) -> f32 {
    let tau = core::f32::consts::PI * 2.0;
    let mut d = (target - yaw).rem_euclid(tau);
    if d > core::f32::consts::PI {
        d -= tau;
    }
    if d.abs() <= rate {
        return target.rem_euclid(tau);
    }
    (yaw + if d > 0.0 { rate } else { -rate }).rem_euclid(tau)
}

/// Swing a camera about its focus by the player's offsets.
///
/// Zero offsets return the camera untouched, so the scene's own framing is
/// the default and this only ever departs from it. `a` is recomputed from
/// the moved eye, which is what keeps billboards leaning correctly.
pub fn swing(cam: Camera, dyaw: f32, dpitch: f32) -> Camera {
    if dyaw == 0.0 && dpitch == 0.0 {
        return cam;
    }
    let v = vec3(
        cam.eye.x - cam.focus.x,
        cam.eye.y - cam.focus.y,
        cam.eye.z - cam.focus.z,
    );
    let dist = sqrtf(v.x * v.x + v.y * v.y + v.z * v.z);
    if dist < 1e-4 {
        return cam;
    }
    let horiz = sqrtf(v.x * v.x + v.z * v.z);
    let yaw = atan2f(v.z, v.x) + dyaw;
    let raw = atan2f(v.y, horiz) + dpitch;
    let pitch = if raw < SWING_PITCH_MIN {
        SWING_PITCH_MIN
    } else if raw > SWING_PITCH_MAX {
        SWING_PITCH_MAX
    } else {
        raw
    };
    let ch = dist * cosf(pitch);
    let eye = vec3(
        cam.focus.x + ch * cosf(yaw),
        cam.focus.y + dist * sinf(pitch),
        cam.focus.z + ch * sinf(yaw),
    );
    // The view direction's angle from straight down, the billboard lean.
    let view = vec3(cam.focus.x - eye.x, cam.focus.y - eye.y, cam.focus.z - eye.z);
    let view_h = sqrtf(view.x * view.x + view.z * view.z);
    let a = atan2f(view_h, -view.y);
    finish(eye, cam.focus, Vec3::Y, a, cam.fov_y, dist)
}

/// The pitch offset that will actually survive [`swing`]'s clamp, given the
/// camera it is being applied to.
///
/// `swing` clamps the RESULT, so an offset accumulated past the clamp keeps
/// growing while nothing on screen moves -- and then the player has to push
/// the other way for a second, through all the slack they wound up, before
/// the camera stirs. It feels exactly like being stuck against the ground.
/// Clamping the offset itself instead means the stick stops having any
/// effect at the limit and reverses the instant it is pushed back.
pub fn clamp_pitch_off(cam: &Camera, dpitch: f32) -> f32 {
    let (vx, vy, vz) = (
        cam.eye.x - cam.focus.x,
        cam.eye.y - cam.focus.y,
        cam.eye.z - cam.focus.z,
    );
    let horiz = sqrtf(vx * vx + vz * vz);
    if horiz < 1e-4 && vy.abs() < 1e-4 {
        return dpitch;
    }
    let base = atan2f(vy, horiz);
    let lo = SWING_PITCH_MIN - base;
    let hi = SWING_PITCH_MAX - base;
    if dpitch < lo {
        lo
    } else if dpitch > hi {
        hi
    } else {
        dpitch
    }
}

/// The camera's horizontal facing, normalised. `(0, -1)` -- north, screen-up
/// on an unswung camera -- when the view is too near vertical to have one.
pub fn forward_h(cam: &Camera) -> (f32, f32) {
    let (dx, dz) = (cam.focus.x - cam.eye.x, cam.focus.z - cam.eye.z);
    let len = sqrtf(dx * dx + dz * dz);
    if len < 1e-4 {
        return (0.0, -1.0);
    }
    (dx / len, dz / len)
}

/// Quarter turns the camera has been swung through, for mapping a press to
/// the world direction it looks like on screen.
pub fn quarter_turns(dyaw: f32) -> i32 {
    const HALF_PI: f32 = core::f32::consts::FRAC_PI_2;
    let q = (dyaw / HALF_PI + if dyaw >= 0.0 { 0.5 } else { -0.5 }) as i32;
    q.rem_euclid(4)
}


/// The screen row of the horizon at infinity for a frame `h` rows tall,
/// clamped to `[0, h]` (0 = no sky in frame).
///
/// Derivation (docs/VOXEL.md §6): the horizon is the image of the flattened
/// forward direction, so push `d = normalize(focus.xz - eye.xz)` through the
/// VP **as a direction** (w = 0) and perspective-divide. With our column-
/// major [`Mat4`] and GL clip conventions NDC +y is screen-up, so the row
/// from the top is `(1 - (y/w * 0.5 + 0.5)) * h`. A straight-down camera has
/// no flattened forward (and no horizon): row 0.
pub fn horizon_row(cam: &Camera, h: i32) -> i32 {
    let dx = cam.focus.x - cam.eye.x;
    let dz = cam.focus.z - cam.eye.z;
    let len = sqrtf(dx * dx + dz * dz);
    if len < 1e-4 {
        return 0; // straight down: all diorama, no sky
    }
    let clip = cam.vp.transform(vec3(dx / len, 0.0, dz / len), 0.0);
    if clip.w <= 1e-6 {
        return 0; // horizon behind the camera
    }
    let ndc_y = clip.y / clip.w;
    let row = (1.0 - (ndc_y * 0.5 + 0.5)) * h as f32;
    (row as i32).clamp(0, h)
}

/// Battle-rig inputs, straight from the scene's battle state.
#[derive(Clone, Copy, Debug)]
pub struct RigInput {
    /// 0 = tele, 1 = wide (anything else falls back to tele).
    pub rig: u8,
    /// Q8 turn fraction around the arena (wraps).
    pub orbit_q8: i32,
    /// Q8 fraction of RIG_PITCH_MAX_DEG, clamped to 0..=1.
    pub pitch_q8: i32,
    /// Q8 zoom multiplier, clamped to RIG_ZOOM_MIN..=RIG_ZOOM_MAX.
    pub zoom_q8: i32,
    /// The tick clock (idle yaw pan + dolly drift derive from it).
    pub tick: u32,
    /// Arena midpoint between the two mons, world px.
    pub mid: Vec3,
    /// Yaw of the player->enemy axis around +Y; 0 = north (-Z), positive
    /// CCW seen from above. Both authored ARENA_SHAPEs stage north (yaw 0).
    pub axis_yaw: f32,
}

/// The mod's spread correction: how much of the mon-axis separation the
/// current view actually sees. `beta` = yaw angle between the (flattened)
/// view direction and the mon axis, `e` = camera elevation. 0 when sighting
/// straight down the axis at ground level, 1 side-on or top-down.
pub fn axis_span(beta: f32, e: f32) -> f32 {
    let s = sinf(beta) * cosf(e);
    sqrtf(s * s + sinf(e) * sinf(e))
}

/// One solved rig constant set.
struct RigConsts {
    side: f32,
    back: f32,
    height: f32,
    look_x: f32,
    look_y: f32,
    frame_h: f32,
}

const TELE: RigConsts = RigConsts {
    side: rig_tele::SIDE,
    back: rig_tele::BACK,
    height: rig_tele::HEIGHT,
    look_x: rig_tele::LOOK_X,
    look_y: rig_tele::LOOK_Y,
    frame_h: rig_tele::FRAME_H,
};
const WIDE: RigConsts = RigConsts {
    side: rig_wide::SIDE,
    back: rig_wide::BACK,
    height: rig_wide::HEIGHT,
    look_x: rig_wide::LOOK_X,
    look_y: rig_wide::LOOK_Y,
    frame_h: rig_wide::FRAME_H,
};

fn rotate_y(v: Vec3, ang: f32) -> Vec3 {
    let (s, c) = (sinf(ang), cosf(ang));
    vec3(v.x * c + v.z * s, v.y, -v.x * s + v.z * c)
}

/// The battle staging camera (upstream BattleCam, solved constants).
///
/// The rig hangs its authored offset (side / back / height, world px) off
/// the arena midpoint in the mon-axis frame, then applies, in order: the
/// player's orbit plus the idle yaw pan (±RIG_PAN_YAW_DEG over
/// RIG_PAN_TICKS), the player's pitch steer (0..RIG_PITCH_MAX_DEG of extra
/// elevation), and the idle dolly (±RIG_DOLLY over RIG_DOLLY_TICKS). Zoom
/// divides the framed height. The framed height is frameH plus the mon gap
/// scaled by [`axis_span`] — the spread correction: a view down the axis
/// needs only frameH, a side-on view must also cover the projected gap.
pub fn battle(inp: &RigInput) -> Camera {
    let r = if inp.rig == 1 { &WIDE } else { &TELE };

    // Mon-axis frame: f = player->enemy, s = its starboard perpendicular.
    let f = vec3(sinf(inp.axis_yaw), 0.0, -cosf(inp.axis_yaw));
    let s = vec3(-f.z, 0.0, f.x);

    // Authored offset, behind the player looking up the axis.
    let base = s
        .scale(r.side)
        .add(vec3(0.0, r.height, 0.0))
        .sub(f.scale(r.back));

    // Orbit + idle pan (yaw around the midpoint).
    let orbit_frac = (inp.orbit_q8.rem_euclid(256)) as f32 / 256.0;
    let pan = RIG_PAN_YAW_DEG.to_radians()
        * sinf(TAU * (inp.tick % RIG_PAN_TICKS) as f32 / RIG_PAN_TICKS as f32);
    let o = rotate_y(base, orbit_frac * TAU + pan);

    // Pitch steer: extra elevation, then the idle dolly on the total length.
    let pitch = (inp.pitch_q8 as f32 / 256.0).clamp(0.0, 1.0) * RIG_PITCH_MAX_DEG.to_radians();
    let h_len = sqrtf(o.x * o.x + o.z * o.z).max(1e-3);
    let e0 = atan2f(o.y, h_len);
    let e = (e0 + pitch).min(0.49 * PI);
    let dolly =
        1.0 + RIG_DOLLY * sinf(TAU * (inp.tick % RIG_DOLLY_TICKS) as f32 / RIG_DOLLY_TICKS as f32);
    let len = o.length() * dolly;
    let h_dir = vec3(o.x / h_len, 0.0, o.z / h_len);
    let off = h_dir
        .scale(len * cosf(e))
        .add(vec3(0.0, len * sinf(e), 0.0));

    let eye = inp.mid.add(off);
    let look = inp
        .mid
        .add(rotate_y(s, orbit_frac * TAU + pan).scale(r.look_x))
        .add(vec3(0.0, r.look_y, 0.0));

    // Spread-corrected framed height -> fov at the look distance.
    let view = look.sub(eye);
    let dist = view.length().max(1e-3);
    let view_h = sqrtf(view.x * view.x + view.z * view.z).max(1e-6);
    let beta = {
        let vh = vec3(view.x / view_h, 0.0, view.z / view_h);
        // |sin| of the yaw angle between flattened view and the mon axis.
        let cross = vh.x * f.z - vh.z * f.x;
        let dot = (vh.x * f.x + vh.z * f.z).clamp(-1.0, 1.0);
        atan2f(
            if cross < 0.0 { -cross } else { cross },
            if dot < 0.0 { -dot } else { dot },
        )
    };
    let elev = atan2f(if view.y < 0.0 { -view.y } else { view.y }, view_h);
    let zoom = (inp.zoom_q8 as f32 / 256.0).clamp(RIG_ZOOM_MIN, RIG_ZOOM_MAX);
    let gap_px = (ARENA_GAP_CELLS * CELL_PX) as f32;
    let frame_h = (r.frame_h + gap_px * axis_span(beta, elev)) / zoom;
    let fov = 2.0 * atanf(frame_h * 0.5 / dist);

    // Billboard lean angle: the view direction's angle from straight down.
    let dirn = view.scale(1.0 / dist);
    let a = atan2f(view_h / dist, -dirn.y);

    finish(eye, look, Vec3::Y, a, fov, dist)
}

#[cfg(test)]
mod free_rig_tests {
    use super::*;

    /// First person puts the eye IN the head: at the player, at eye height,
    /// with no boom and no shoulder rail.
    #[test]
    fn first_person_stands_in_the_players_head() {
        let c = free_cam(100.0, 200.0, 0.0, FREE_PITCH_DEFAULT, 0.0, 0.0);
        assert!((c.eye.x - 100.0).abs() < 1e-3, "eye moved off the player: {}", c.eye.x);
        assert!((c.eye.z - 200.0).abs() < 1e-3, "eye moved off the player: {}", c.eye.z);
        assert!((c.eye.y - FREE_EYE_HEIGHT).abs() < 1e-3, "wrong eye height: {}", c.eye.y);
    }

    /// Third person pulls it back along the view line, so the player ends up
    /// between the eye and what it is looking at.
    #[test]
    fn third_person_puts_the_player_between_the_eye_and_the_focus() {
        let c = free_cam(100.0, 200.0, 0.0, FREE_PITCH_DEFAULT, FREE_BOOM, FREE_SHOULDER);
        let along = |x: f32, z: f32| {
            let fx = c.focus.x - c.eye.x;
            let fz = c.focus.z - c.eye.z;
            ((x - c.eye.x) * fx + (z - c.eye.z) * fz) / (fx * fx + fz * fz)
        };
        let t = along(100.0, 200.0);
        assert!(t > 0.0 && t < 1.0, "player is not in front of the eye (t = {t})");
        // and roughly the boom away, not on top of them
        let dx = c.eye.x - 100.0;
        let dz = c.eye.z - 200.0;
        let back = (dx * dx + dz * dz).sqrt();
        assert!(back > FREE_BOOM * 0.7, "boom too short: {back}");
    }

    /// Yaw 0 looks north, the way an unswung orbit looks -- so the camera
    /// stands SOUTH of the player. Getting this backwards would put the
    /// camera in front of them, facing the wrong way, on every rung.
    #[test]
    fn yaw_zero_looks_the_same_way_the_orbit_does() {
        let c = free_cam(0.0, 0.0, 0.0, 0.0, FREE_BOOM, 0.0);
        assert!(c.eye.z > 0.0, "eye should sit south of the player: {}", c.eye.z);
        assert!(c.focus.z < c.eye.z, "camera is looking the wrong way");
        let o = orbit(0.0, 0.0, 45.0);
        assert!(o.eye.z > 0.0, "the orbit's own convention moved");
    }

    /// Turning right walks the eye round the player rather than sideways.
    #[test]
    fn yaw_swings_the_eye_around_the_player() {
        let east = free_cam(0.0, 0.0, core::f32::consts::FRAC_PI_2, 0.0, FREE_BOOM, 0.0);
        // looking east, the camera stands to the west
        assert!(east.eye.x < -FREE_BOOM * 0.7, "eye did not swing west: {}", east.eye.x);
        assert!(east.focus.x > east.eye.x, "not looking east");
    }

    /// A level camera stands the character cards upright -- the whole reason
    /// `a` exists. Pitched down, they lean.
    #[test]
    fn the_lean_angle_tracks_the_pitch() {
        let level = free_cam(0.0, 0.0, 0.0, 0.0, FREE_BOOM, 0.0);
        assert!((level.a - core::f32::consts::FRAC_PI_2).abs() < 1e-4, "{}", level.a);
        let down = free_cam(0.0, 0.0, 0.0, FREE_PITCH_DOWN, FREE_BOOM, 0.0);
        assert!(down.a < level.a, "looking down should lean the cards");
    }

    #[test]
    fn the_pitch_clamps_to_the_rungs_limits() {
        assert_eq!(clamp_free_pitch(10.0), FREE_PITCH_DOWN);
        assert_eq!(clamp_free_pitch(-10.0), FREE_PITCH_UP);
        assert_eq!(clamp_free_pitch(0.2), 0.2);
    }

    /// The lens opens out inside the world; the diorama's does not move.
    #[test]
    fn the_free_rig_uses_its_own_wider_lens() {
        let free = free_cam(0.0, 0.0, 0.0, 0.0, FREE_BOOM, 0.0);
        let dio = orbit(0.0, 0.0, 45.0);
        assert!(free.fov_y > dio.fov_y, "free rig should be wider: {} vs {}",
                free.fov_y, dio.fov_y);
        assert!((free.fov_y - FREE_FOV).abs() < 1e-5);
    }
}

#[cfg(test)]
mod follow_tests {
    use super::*;

    /// Walk each way and check the eye lands on the far side of the focus.
    /// Asserting the camera's POSITION rather than the angle is the point:
    /// the sign convention in swing is exactly what a hand-derived yaw gets
    /// wrong, and a wrong one would have the camera lead the player instead.
    #[test]
    fn the_follow_camera_sits_behind_travel() {
        for (dx, dz, name) in [
            (0.0f32, -1.0f32, "north"),
            (0.0, 1.0, "south"),
            (1.0, 0.0, "east"),
            (-1.0, 0.0, "west"),
        ] {
            let base = orbit(0.0, 0.0, 45.0);
            let cam = swing(base, follow_yaw(dx, dz), 0.0);
            let ox = cam.eye.x - cam.focus.x;
            let oz = cam.eye.z - cam.focus.z;
            // behind travel: the offset points against the direction of travel
            let dot = ox * dx + oz * dz;
            assert!(dot < 0.0, "{name}: camera is not behind travel (dot {dot})");
            // and it is BEHIND, not merely off to one side
            let along = (ox * ox + oz * oz).sqrt() * (dx * dx + dz * dz).sqrt();
            assert!(dot < -0.9 * along, "{name}: camera is off to the side");
        }
    }

    #[test]
    fn standing_still_leaves_the_camera_alone() {
        assert_eq!(follow_yaw(0.0, 0.0), 0.0);
    }

    #[test]
    fn the_turn_takes_the_short_way_round() {
        let tau = core::f32::consts::PI * 2.0;
        // just past the wrap: the short way is forward, not all the way back
        let y = approach_yaw(tau - 0.05, 0.05, 0.02);
        assert!(y > tau - 0.05 || y < 0.05, "went the long way: {y}");
        // and it arrives rather than orbiting forever
        let mut y = 0.0f32;
        for _ in 0..200 {
            y = approach_yaw(y, 1.0, 0.02);
        }
        assert!((y - 1.0).abs() < 1e-4, "did not arrive: {y}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HALF_PI: f32 = core::f32::consts::FRAC_PI_2;

    fn base() -> Camera {
        // Looking north (-Z) from the south and above: the unswung framing.
        orbit(0.0, 0.0, 45.0)
    }

    #[test]
    fn no_swing_leaves_the_camera_exactly_alone() {
        let c = base();
        let d = swing(c, 0.0, 0.0);
        assert_eq!(d.eye.x, c.eye.x);
        assert_eq!(d.eye.y, c.eye.y);
        assert_eq!(d.eye.z, c.eye.z);
        assert_eq!(d.a, c.a);
    }

    #[test]
    fn a_half_turn_puts_the_eye_on_the_far_side() {
        let c = base();
        let d = swing(c, core::f32::consts::PI, 0.0);
        // same distance, opposite side, same height
        let r0 = ((c.eye.x - c.focus.x).powi(2) + (c.eye.z - c.focus.z).powi(2)).sqrt();
        let r1 = ((d.eye.x - d.focus.x).powi(2) + (d.eye.z - d.focus.z).powi(2)).sqrt();
        assert!((r0 - r1).abs() < 0.5, "{r0} vs {r1}");
        assert!((d.eye.z - d.focus.z).signum() != (c.eye.z - c.focus.z).signum());
        assert!((d.eye.y - c.eye.y).abs() < 0.5);
    }

    #[test]
    fn swinging_level_with_the_ground_stands_a_card_upright() {
        // Pitched all the way down to the floor, `a` reaches a quarter turn,
        // which is what makes card_verts vertical.
        let d = swing(base(), 0.0, -10.0);
        assert!((d.a - HALF_PI).abs() < 0.1, "a = {}", d.a);
        assert!(d.eye.y > 0.0, "the eye must stay above the ground");
    }

    #[test]
    fn pitch_is_clamped_off_both_ends() {
        let up = swing(base(), 0.0, 10.0);
        let horiz = ((up.eye.x - up.focus.x).powi(2) + (up.eye.z - up.focus.z).powi(2)).sqrt();
        // never exactly overhead: look_at needs a horizontal component
        assert!(horiz > 0.01, "degenerate straight-down eye");
        let down = swing(base(), 0.0, -10.0);
        assert!(down.eye.y > 0.0);
    }

    #[test]
    fn a_pitch_offset_is_clamped_to_what_the_camera_can_take() {
        let c = base(); // 45 degrees from straight down
        // Pushing far past the floor gives back only the distance to it, so
        // the accumulator never winds up slack the player has to unwind.
        let down = clamp_pitch_off(&c, -10.0);
        assert!(down > -10.0, "clamped: {down}");
        let landed = swing(c, 0.0, down);
        assert!((landed.a - HALF_PI).abs() < 0.1, "should reach the floor: {}", landed.a);

        // And the clamped value is a fixed point: applying it again changes
        // nothing, which is what makes the stick stop dead at the limit.
        assert!((clamp_pitch_off(&c, down) - down).abs() < 1e-4);
    }

    #[test]
    fn a_clamped_offset_reverses_the_instant_it_is_pushed_back() {
        let c = base();
        let floored = clamp_pitch_off(&c, -10.0);
        // one step back up from the limit must actually move the camera
        let stepped = clamp_pitch_off(&c, floored + 0.025);
        assert!(stepped > floored, "{stepped} should exceed {floored}");
        let a0 = swing(c, 0.0, floored).a;
        let a1 = swing(c, 0.0, stepped).a;
        assert!(a1 < a0, "pushing back up must tilt the view back: {a1} vs {a0}");
    }

    #[test]
    fn an_offset_inside_the_range_is_left_alone() {
        let c = base();
        assert!((clamp_pitch_off(&c, 0.1) - 0.1).abs() < 1e-6);
        assert!((clamp_pitch_off(&c, -0.1) + 0.1).abs() < 1e-6);
    }

    #[test]
    fn forward_h_is_north_on_an_unswung_camera() {
        let (fx, fz) = forward_h(&base());
        assert!(fx.abs() < 1e-3, "fx = {fx}");
        assert!((fz + 1.0).abs() < 1e-3, "fz = {fz}");
    }

    #[test]
    fn forward_h_turns_with_the_swing() {
        let (fx, fz) = forward_h(&swing(base(), HALF_PI, 0.0));
        // a quarter turn puts the camera west of the focus, looking east
        assert!((fx - 1.0).abs() < 1e-2, "fx = {fx}");
        assert!(fz.abs() < 1e-2, "fz = {fz}");
    }

    #[test]
    fn quarter_turns_rounds_to_the_nearest_face() {
        assert_eq!(quarter_turns(0.0), 0);
        assert_eq!(quarter_turns(0.1), 0);
        assert_eq!(quarter_turns(HALF_PI - 0.1), 1);
        assert_eq!(quarter_turns(HALF_PI + 0.1), 1);
        assert_eq!(quarter_turns(core::f32::consts::PI), 2);
        assert_eq!(quarter_turns(-HALF_PI), 3);
        assert_eq!(quarter_turns(2.0 * core::f32::consts::PI), 0);
    }


    use crate::spec::{PITCH_RUNGS, VIEW_H, WORLD_VIEW_H};

    #[test]
    fn rung0_frames_exactly_world_view_h() {
        // Project (cx, 0, cy ± WORLD_VIEW_H/2) at rung 0: clip y = ±1.
        let (cx, cy) = (120.0, 68.0);
        let cam = orbit(cx, cy, PITCH_RUNGS[0]);
        let half = WORLD_VIEW_H as f32 / 2.0;
        let north = cam.vp.transform(vec3(cx, 0.0, cy - half), 1.0);
        let south = cam.vp.transform(vec3(cx, 0.0, cy + half), 1.0);
        assert!((north.y / north.w - 1.0).abs() < 1e-4, "north edge at +1");
        assert!((south.y / south.w + 1.0).abs() < 1e-4, "south edge at -1");
    }

    #[test]
    fn fov_is_the_focal_constant() {
        let cam = orbit(0.0, 0.0, 35.0);
        let want = 2.0 * atanf(1.0 / (2.0 * CAM_FOCAL));
        assert_eq!(cam.fov_y, want);
        assert!((want.to_degrees() - 53.130).abs() < 1e-2);
    }

    #[test]
    fn horizon_only_at_the_high_rungs() {
        for (i, &deg) in PITCH_RUNGS.iter().enumerate() {
            let cam = orbit(0.0, 0.0, deg);
            let row = horizon_row(&cam, VIEW_H);
            if i < 4 {
                assert_eq!(row, 0, "rung {i} keeps the horizon out of frame");
            } else {
                assert!(
                    row > 0 && row < VIEW_H,
                    "rung 4 horizon row {row} must be inside the frame"
                );
            }
        }
    }

    #[test]
    fn battle_rig_is_deterministic_and_sane() {
        let inp = RigInput {
            rig: 0,
            orbit_q8: 0,
            pitch_q8: 0,
            zoom_q8: 256,
            tick: 0,
            mid: vec3(160.0, 0.0, 200.0),
            axis_yaw: 0.0,
        };
        let a = battle(&inp);
        let b = battle(&inp);
        assert_eq!(a.vp.m, b.vp.m, "same inputs, same camera");
        // Tele is a long lens; wide is wide.
        let wide = battle(&RigInput { rig: 1, ..inp });
        assert!(a.fov_y < wide.fov_y);
        assert!(a.fov_y > 0.05 && wide.fov_y < PI * 0.75);
        // The eye stands off the midpoint and above the ground.
        assert!(a.eye.y > 0.0);
        assert!(a.eye.sub(inp.mid).length() > rig_tele::BACK * 0.5);
        // Drift moves the camera over time.
        let later = battle(&RigInput { tick: 400, ..inp });
        assert!(a.eye.sub(later.eye).length() > 1e-3);
        // axis_span endpoints.
        assert!(axis_span(0.0, 0.0).abs() < 1e-6);
        assert!((axis_span(PI / 2.0, 0.0) - 1.0).abs() < 1e-6);
        assert!((axis_span(0.0, PI / 2.0) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn tanf_shim_matches() {
        // Keep the shim honest on the one fn tests don't otherwise touch.
        use crate::math::tanf;
        assert!((tanf(0.5) - sinf(0.5) / cosf(0.5)).abs() < 1e-6);
    }
}
