// Port of gen1recomp src/core/game3/pokecenter_heal.lua (GPLv3 + additional terms; see LICENSE.md).
// pret FLDEFF_POKECENTER_HEAL (field_effect.c FldEff_PokecenterHeal).
// 1:1 screen OAM: CreateSprite coords are sprite CENTER; Love draws top-left
// so we apply the same centerToCornerVec as pret sprite.c.
//
// Port notes:
// - Lazily required (field_view / field_effects getMod): registers as
//   G3Lazy["src.core.game3.pokecenter_heal"].
// - package.loaded / pcall(require) of runtime, field, party, profile, audio
//   and se_ids: those modules are in the bundle (static imports, loaded).
// - Cache bytes are byte strings: s:byte(i) is charCodeAt(i - 1).
// - ball_screen_tl / monitor_center / monitor_screen_tl return Lua's two
//   values as [x, y].

/* eslint-disable @typescript-eslint/no-explicit-any */
import { G } from "../platform/graphics.ts";
import type { Image, Quad } from "../platform/image.ts";
import { newImageData } from "../platform/image.ts";
import { ipairs, len, seq, type LuaTable } from "../platform/lt.ts";
import { mod, sub, tonumber, tostring } from "../../../import/gen3/lua.ts";
import { Profile } from "./profile.ts";
import { Runtime } from "./runtime.ts";
import { G3Lazy } from "./lazy_registry.ts";
import { Field } from "./field.ts";
import { Party } from "./party.ts";
import { Audio } from "./audio.ts";
import { SE } from "./se_ids.ts";

// pret FldEff_PokecenterHeal — absolute screen coords (coordOffsetEnabled = FALSE).
const BALL_CENTER_X = 93, BALL_CENTER_Y = 36;
const MONITOR_CENTER_X = 128, MONITOR_CENTER_Y = 24;

// pret sCenterToCornerVecTable: 8x8 square → (-4,-4); 32x16 h-rect size2 → (-16,-8).
const BALL_CORNER = seq(-4, -4);
const MONITOR_CORNER = seq(-16, -8);

interface MonitorSpec {
  sheet: string;
  w: number;
  h: number;
  corner?: LuaTable;
  seq: LuaTable;
  durs: LuaTable;
  loops?: number;
}

// pokefirered/src/field_effect.c:293
const MONITOR: MonitorSpec = {
  sheet: "pokemoncenter_monitor",
  w: 32,
  h: 16,
  corner: MONITOR_CORNER,
  seq: seq(1, 2, 3, 2, 1, 0),
  durs: seq(5, 5, 7, 5, 5, 5),
  loops: 3,
};

// pret sPokeballCoordOffsets: L→R, top→bottom on the 2×3 LED tray.
const BALL_OFFSETS = seq(
  seq(0, 0), seq(6, 0),
  seq(0, 4), seq(6, 4),
  seq(0, 8), seq(6, 8),
);

// pokefirered/src/field_effect.c:900
const GLOW_K = seq(16, 12, 8, 0);
// pokefirered/src/field_effect.c:949
const GLOW_INDICES = seq(8, 6, 2, 5, 3);
const GLOW_LEAD = seq(3, 2, 1, 0, 0);

const STATE = {
  PLACE: 0,
  WAIT_SE: 1,
  FLASH_A: 2,
  FLASH_B: 3,
  WAIT_AFTER: 4,
  DUMMY: 5,
  WAIT_SOUND: 6,
  IDLE: 7,
};

interface MonitorAnim { seq: LuaTable; durs: LuaTable; i: number; timer: number; loopsLeft: number }
interface HealFx {
  state: number;
  timer: number;
  counter: number;
  numFlashed: number;
  remaining: number;
  placed: number;
  monitorX: number;
  monitorY: number;
  balls: LuaTable;
  monitorVisible: boolean;
  monitorFrame: number;
  monitorAnim: MonitorAnim | undefined;
  waiters: LuaTable;
}

// Lua: pokecenter_heal.lua:63
function log(msg: unknown): void {
  if (PokecenterHeal._logged) return;
  PokecenterHeal._logged = true;
  console.log("[game3/pokecenter_heal] " + tostring(msg));
}

// Lua: pokecenter_heal.lua:69
function read_cache(rel: string): string | undefined {
  const cache = PokecenterHeal._cache;
  if (!(cache && cache.read)) return undefined;
  try {
    return cache.read(rel) ?? undefined;
  } catch {
    return undefined;
  }
}

// Lua: pokecenter_heal.lua:77
function heal_block(): any {
  // pcall(require, "src.core.game3.profile")
  if (!(Profile && Profile.forSession)) return undefined;
  let row: any;
  try { row = Profile.forSession(); } catch { return undefined; }
  return (row && row.heal) || undefined;
}

// Lua: pokecenter_heal.lua:84
function monitor_spec(): MonitorSpec {
  const b = heal_block();
  return (b && b.monitor) || MONITOR;
}

// Lua: pokecenter_heal.lua:89
function monitor_center(): [number, number] {
  const b = heal_block();
  const c = b && b.monitorCenter;
  if (c) return [c[1], c[2]];
  return [MONITOR_CENTER_X, MONITOR_CENTER_Y];
}

// Lua: pokecenter_heal.lua:96
function read_field_effect(name: string, ext: string): string | undefined {
  return read_cache("data/generated/gba/field_effects/" + name + ext)
    || read_cache("field_effects/" + name + ext);
}

// Lua: pokecenter_heal.lua:116
function ensure_gfx(): boolean {
  const spec = monitor_spec();
  if (PokecenterHeal._monSheet !== spec.sheet) {
    PokecenterHeal._monImg = undefined;
    PokecenterHeal._monQuads = undefined;
  }
  if (PokecenterHeal._ballIdx && PokecenterHeal._monImg) return true;
  // `love and love.image and love.graphics`: always present here.

  if (!PokecenterHeal._ballIdx) {
    const idx = read_field_effect("pokeball_glow", ".idx");
    const pal = read_field_effect("pokeball_glow", ".pal");
    if (idx && pal && idx.length >= 64 && pal.length >= 48) {
      const px: LuaTable = seq();
      for (let i = 1; i <= 64; i++) px[i] = mod(idx.charCodeAt(i - 1), 16);
      const colors: Record<number, LuaTable> = {};
      for (let i = 0; i <= 15; i++) {
        const o = i * 3;
        colors[i] = seq(pal.charCodeAt(o), pal.charCodeAt(o + 1), pal.charCodeAt(o + 2));
      }
      PokecenterHeal._ballIdx = px;
      PokecenterHeal._ballPal = colors;
      PokecenterHeal._ballImgs = {};
    }
  }

  if (!PokecenterHeal._monImg) {
    const monRaw = read_field_effect(spec.sheet, ".rgba");
    const mw = spec.w, mh = spec.h;
    const frames = monRaw ? Math.floor(monRaw.length / (mw * mh * 4)) : 0;
    if (frames > 0) {
      const sheetH = mh * frames;
      let id: any;
      let ok = true;
      try { id = newImageData(mw, sheetH, "rgba8", sub(monRaw!, 1, mw * sheetH * 4)); } catch { ok = false; }
      if (ok && id) {
        const img = G.newImage(id);
        if (img.setFilter) img.setFilter("nearest", "nearest");
        const quads: Record<number, Quad> = {};
        for (let i = 0; i <= frames - 1; i++) {
          quads[i] = G.newQuad(0, i * mh, mw, mh, mw, sheetH);
        }
        PokecenterHeal._monImg = img;
        PokecenterHeal._monQuads = quads;
        PokecenterHeal._monSheet = spec.sheet;
      }
    }
  }

  if (!(PokecenterHeal._ballIdx && PokecenterHeal._monImg)) {
    log("field_effects/pokeball_glow + " + spec.sheet + " missing; re-import the ROM cache");
    return false;
  }
  return true;
}

// Lua: pokecenter_heal.lua:171
// pokefirered/src/field_effect.c:640
function multiply_inverted(c8: number, k: number): number {
  let c5 = Math.floor(c8 * 31 / 255 + 0.5);
  c5 = c5 + Math.floor(((31 - c5) * k) / 16);
  if (c5 > 31) c5 = 31;
  return Math.floor(c5 * 255 / 31 + 0.5);
}

// Lua: pokecenter_heal.lua:179
// pokefirered/src/field_effect.c:949
function glow_key(fx: HealFx | undefined): string {
  if (!fx) return "n";
  if (fx.state !== STATE.FLASH_A && fx.state !== STATE.FLASH_B) return "n";
  return (fx.state === STATE.FLASH_A ? "a" : "b") + tostring(mod(fx.counter || 0, 4));
}

// Lua: pokecenter_heal.lua:185
function phases_for(key: string): Record<number, number> | undefined {
  if (key === "n") return undefined;
  const rolling = (sub(key, 1, 1) === "a");
  const counter = tonumber(sub(key, 2)) ?? 0;
  const phases: Record<number, number> = {};
  for (let i = 1; i <= len(GLOW_INDICES); i++) {
    const lead = rolling ? GLOW_LEAD[i]! : 0;
    phases[GLOW_INDICES[i]!] = mod(counter + lead, 4);
  }
  return phases;
}

// Lua: pokecenter_heal.lua:197
function ball_image(key: string): Image | undefined {
  const imgs = PokecenterHeal._ballImgs;
  const px = PokecenterHeal._ballIdx;
  const pal = PokecenterHeal._ballPal;
  if (!(imgs && px && pal)) return undefined;
  if (imgs[key]) return imgs[key];

  const phases = phases_for(key);
  const shaded: Record<number, LuaTable> = {};
  for (let i = 0; i <= 15; i++) {
    const c = pal[i] || seq(0, 0, 0);
    const phase = phases && phases[i];
    if (phase != null) {
      const k = GLOW_K[phase + 1] || 0;
      shaded[i] = seq(multiply_inverted(c[1]!, k), multiply_inverted(c[2]!, k), c[3]!);
    } else {
      shaded[i] = c;
    }
  }

  const id = newImageData(8, 8);
  id.mapPixel((x, y) => {
    const idx = px[y * 8 + x + 1] || 0;
    if (idx === 0) return [0, 0, 0, 0];
    const c = shaded[idx] || seq(0, 0, 0);
    return [c[1]! / 255, c[2]! / 255, c[3]! / 255, 1];
  });
  const img = G.newImage(id);
  if (img.setFilter) img.setFilter("nearest", "nearest");
  imgs[key] = img;
  return img;
}

// Lua: pokecenter_heal.lua:230
function party_count(): number {
  // package.loaded["src.core.game3.runtime"]
  const R: any = Runtime;
  let session = (R && R.getSession && R.getSession()) || (R && R.session);
  // package.loaded["src.core.game3.field"]
  const F: any = Field;
  if (!session && F && F._session) {
    session = F._session;
  }
  const P: any = Party;
  if (session && session.party && P.size) {
    return Math.max(1, Math.min(6, P.size(session.party)));
  }
  if (session && typeof session.party === "object" && session.party != null) {
    return Math.max(1, Math.min(6, len(session.party)));
  }
  return 1;
}

// Lua: pokecenter_heal.lua:249
function play_se_ball(): void {
  try {
    const A: any = Audio;
    const S: any = SE;
    if (A.playSe && S.SE_BALL) A.playSe(S.SE_BALL);
  } catch { /* pcall */ }
}

// Lua: pokecenter_heal.lua:257
function play_heal_fanfare(): void {
  try {
    const A: any = Audio;
    const id = (A.role && A.role("heal")) || 256;
    if (A.playFanfare) A.playFanfare(id);
  } catch { /* pcall */ }
}

// Lua: pokecenter_heal.lua:265
function fanfare_done(): boolean {
  // pcall(require, "src.core.game3.audio")
  const A: any = Audio;
  if (!A) return true;
  if (A.isFanfareFinished) return A.isFanfareFinished();
  if (A._fanfareActive != null) return !A._fanfareActive;
  return true;
}

// Lua: pokecenter_heal.lua:273
function finish_waiters(fx: HealFx | undefined): void {
  const waiters = fx && fx.waiters;
  if (!waiters) return;
  fx!.waiters = seq();
  for (let i = 1; i <= len(waiters); i++) {
    const cb = waiters[i];
    if (cb) { try { cb(); } catch { /* pcall */ } }
  }
}

// Lua: pokecenter_heal.lua:283
function destroy_fx(): void {
  const fx = PokecenterHeal._fx;
  PokecenterHeal._fx = undefined;
  if (fx) finish_waiters(fx);
}

// Lua: pokecenter_heal.lua:290
/** Screen top-left for ball slot i (0-based), matching pret OAM after centerToCorner. */
function ball_screen_tl(slot: number): [number, number] {
  const off = BALL_OFFSETS[slot + 1] || BALL_OFFSETS[1]!;
  return [BALL_CENTER_X + off[1]! + BALL_CORNER[1]!,
    BALL_CENTER_Y + off[2]! + BALL_CORNER[2]!];
}

// Lua: pokecenter_heal.lua:296
function monitor_screen_tl(): [number, number] {
  const [cx, cy] = monitor_center();
  const corner = monitor_spec().corner || MONITOR_CORNER;
  return [cx + corner[1]!, cy + corner[2]!];
}

// Lua: pokecenter_heal.lua:346
function start_monitor_anim(fx: HealFx): void {
  const spec = monitor_spec();
  fx.monitorVisible = true;
  fx.monitorAnim = {
    seq: spec.seq,
    durs: spec.durs,
    i: 1,
    timer: 0,
    loopsLeft: spec.loops || 0,
  };
  fx.monitorFrame = spec.seq[1]!;
}

// Lua: pokecenter_heal.lua:359
function step_monitor(fx: HealFx): void {
  const a = fx.monitorAnim;
  if (!a) return;
  a.timer = a.timer + 1;
  const dur = a.durs[a.i] || 5;
  if (a.timer < dur) return;
  a.timer = 0;
  a.i = a.i + 1;
  if (a.i > len(a.seq)) {
    if (a.loopsLeft > 0) {
      a.loopsLeft = a.loopsLeft - 1;
      a.i = 1;
    } else {
      fx.monitorFrame = 0;
      fx.monitorAnim = undefined;
      fx.monitorVisible = false;
      return;
    }
  }
  fx.monitorFrame = a.seq[a.i] || 0;
}

// Lua: pokecenter_heal.lua:381
function place_ball(fx: HealFx): void {
  const i = fx.placed;
  const [sx, sy] = ball_screen_tl(i);
  fx.balls[len(fx.balls) + 1] = { x: sx, y: sy };
  fx.placed = i + 1;
  fx.remaining = fx.remaining - 1;
  play_se_ball();
}

// Lua: pokecenter_heal.lua:466
// pokefirered/src/field_effect.c:910
function draw_balls(fx: HealFx): void {
  if (fx.state >= STATE.DUMMY) return;
  const img = ball_image(glow_key(fx));
  if (!img) return;
  G.setColor(1, 1, 1, 1);
  for (const [, b] of ipairs(fx.balls)) {
    G.draw(img, b.x, b.y);
  }
}

// Lua: pokecenter_heal.lua:476
function draw_monitor(fx: HealFx): void {
  if (!(fx.monitorVisible && PokecenterHeal._monQuads)) return;
  const q = PokecenterHeal._monQuads[fx.monitorFrame || 0];
  if (!q) return;
  G.setColor(1, 1, 1, 1);
  G.draw(PokecenterHeal._monImg!, q, fx.monitorX || 0, fx.monitorY || 0);
}

export const PokecenterHeal = {
  FLDEFF: 25, // FLDEFF_POKECENTER_HEAL

  _fx: undefined as HealFx | undefined,
  _ballIdx: undefined as LuaTable | undefined,
  _ballPal: undefined as Record<number, LuaTable> | undefined,
  _ballImgs: undefined as Record<string, Image> | undefined,
  _monImg: undefined as Image | undefined,
  _monQuads: undefined as Record<number, Quad> | undefined,
  _monSheet: undefined as string | undefined,
  _cache: undefined as any,
  _logged: false,
  _claimed: false,

  // Lua: pokecenter_heal.lua:101
  install(cache: any): void {
    PokecenterHeal._cache = cache;
    PokecenterHeal.invalidate();
    PokecenterHeal._logged = false;
  },

  // Lua: pokecenter_heal.lua:107
  invalidate(): void {
    PokecenterHeal._ballIdx = undefined;
    PokecenterHeal._ballPal = undefined;
    PokecenterHeal._ballImgs = undefined;
    PokecenterHeal._monImg = undefined;
    PokecenterHeal._monQuads = undefined;
    PokecenterHeal._monSheet = undefined;
  },

  // Lua: pokecenter_heal.lua:302
  start(): boolean {
    // Always reload art so a prior opaque load cannot stick across hot reload.
    PokecenterHeal.invalidate();
    ensure_gfx();
    if (PokecenterHeal._fx) {
      destroy_fx();
    }
    const n = party_count();
    const [mx, my] = monitor_screen_tl();
    PokecenterHeal._fx = {
      state: STATE.PLACE,
      timer: 0,
      counter: 0,
      numFlashed: 0,
      remaining: n,
      placed: 0,
      monitorX: mx,
      monitorY: my,
      balls: seq(), // screen top-left pixels
      monitorVisible: false,
      monitorFrame: 0,
      monitorAnim: undefined,
      waiters: seq(),
    };
    return true;
  },

  // Lua: pokecenter_heal.lua:329
  isActive(): boolean {
    return PokecenterHeal._fx != null;
  },

  // Lua: pokecenter_heal.lua:333
  wait(done?: () => void): void {
    const fx = PokecenterHeal._fx;
    if (!fx) {
      if (done) done();
      return;
    }
    if (fx.state >= STATE.IDLE) {
      if (done) done();
      return;
    }
    fx.waiters[len(fx.waiters) + 1] = done;
  },

  // Lua: pokecenter_heal.lua:390
  step(): void {
    const fx = PokecenterHeal._fx;
    if (!fx) return;

    if (fx.monitorAnim) step_monitor(fx);

    const st = fx.state;
    if (st === STATE.PLACE) {
      if (fx.timer === 0) {
        place_ball(fx);
        fx.timer = 25;
        if (fx.remaining <= 0) {
          fx.timer = 32;
          fx.state = STATE.WAIT_SE;
        }
      } else {
        fx.timer = fx.timer - 1;
        if (fx.timer === 0 && fx.remaining > 0) {
          place_ball(fx);
          fx.timer = 25;
          if (fx.remaining <= 0) {
            fx.timer = 32;
            fx.state = STATE.WAIT_SE;
          }
        }
      }
    } else if (st === STATE.WAIT_SE) {
      fx.timer = fx.timer - 1;
      if (fx.timer <= 0) {
        start_monitor_anim(fx);
        play_heal_fanfare();
        fx.state = STATE.FLASH_A;
        fx.timer = 8;
        fx.counter = 0;
        fx.numFlashed = 0;
      }
    } else if (st === STATE.FLASH_A) {
      fx.timer = fx.timer - 1;
      if (fx.timer <= 0) {
        fx.timer = 8;
        fx.counter = mod(fx.counter + 1, 4);
        if (fx.counter === 0) {
          fx.numFlashed = fx.numFlashed + 1;
        }
      }
      if (fx.numFlashed >= 3) {
        fx.state = STATE.FLASH_B;
        fx.timer = 8;
        fx.counter = 0;
      }
    } else if (st === STATE.FLASH_B) {
      fx.timer = fx.timer - 1;
      if (fx.timer <= 0) {
        fx.timer = 8;
        fx.counter = mod(fx.counter + 1, 4);
        if (fx.counter === 3) {
          fx.state = STATE.WAIT_AFTER;
          fx.timer = 30;
        }
      }
    } else if (st === STATE.WAIT_AFTER) {
      fx.timer = fx.timer - 1;
      if (fx.timer <= 0) {
        fx.state = STATE.DUMMY;
      }
    } else if (st === STATE.DUMMY) {
      fx.state = STATE.WAIT_SOUND;
    } else if (st === STATE.WAIT_SOUND) {
      if (fanfare_done()) {
        fx.state = STATE.IDLE;
        destroy_fx();
      }
    }
  },

  // Lua: pokecenter_heal.lua:485
  // pokefirered/src/field_effect.c:912
  drawBalls(_camX?: number, _camY?: number): void {
    const fx = PokecenterHeal._fx;
    if (!fx) return;
    PokecenterHeal._claimed = true;
    if (!ensure_gfx()) return;
    draw_balls(fx);
    G.setColor(1, 1, 1, 1);
  },

  // Lua: pokecenter_heal.lua:495
  // pokefirered/src/field_effect.c:1024
  drawMonitor(_camX?: number, _camY?: number): void {
    const fx = PokecenterHeal._fx;
    if (!fx) return;
    PokecenterHeal._claimed = true;
    if (!ensure_gfx()) return;
    draw_monitor(fx);
    G.setColor(1, 1, 1, 1);
  },

  // Lua: pokecenter_heal.lua:505
  /** Draw in absolute screen space (pret OAM; ignore camera). */
  draw(_camX?: number, _camY?: number): void {
    if (PokecenterHeal._claimed) {
      PokecenterHeal._claimed = false;
      return;
    }
    const fx = PokecenterHeal._fx;
    if (!fx) return;
    if (!ensure_gfx()) return;
    draw_balls(fx);
    draw_monitor(fx);
    G.setColor(1, 1, 1, 1);
  },

  // Lua: pokecenter_heal.lua:519
  // Exported for tests: pret OAM top-left after centerToCorner.
  _ballScreenTl: ball_screen_tl,
  _monitorScreenTl: monitor_screen_tl,
};

G3Lazy["src.core.game3.pokecenter_heal"] = PokecenterHeal;

export default PokecenterHeal;
