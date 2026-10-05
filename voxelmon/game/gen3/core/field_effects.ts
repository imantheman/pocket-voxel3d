// Port of gen1recomp src/core/game3/field_effects.lua (GPLv3 + additional terms; see LICENSE.md).
// FRLG field effects engine (pret fldeff_*.c).
// Handles pure ROM-extracted field effect sprites and animations:
// Tall grass, Cut grass leaves, Rock smash rubble, Surf blob, Fly bird, Ripples,
// Flash screen flash, Dig / Teleport warp spin, Sweet scent aroma.
//
// Port notes:
// - FieldEffects is a plain module table whose members are assigned in
//   Brian's order (functions as `FieldEffects.x = function`), so it is typed
//   Record<string, any>.
// - A sheet's `quads` / `quadsFront` keep Brian's 0-based frame keys (JS array
//   indices 0..frames-1), as ow_sprites does.
// - src.core.game3.field_effects_rse and fldeff_misc are Emerald only (no
//   port): rse() is nil for FireRed's manifest and throws for an "rse" one.
// - `love` is always present here (try_load_rgba's love.image guard is constant true).

import { mod, tonumber, tostring, truthy } from "../../../import/gen3/lua.ts";
import { insert, ipairs, len, pairs, seq, type LuaTable } from "../platform/lt.ts";
import { luaLoad } from "../platform/luadata.ts";
import { random } from "../platform/rng.ts";
import { G } from "../platform/graphics.ts";
import { newImageData, type Image, type Quad } from "../platform/image.ts";
import { Extract } from "../../../import/gen3/extract_island1.ts";
import { GameVersion } from "../shared/core/GameVersion.ts";
import { Logger } from "../shared/core/Logger.ts";
import { Renderer } from "../shared/render/Renderer.ts";
import { MB } from "./mb.ts";
import { Collision as CollisionMod } from "./collision.ts";
import { OwSprites as OwSpritesMod } from "./ow_sprites.ts";
import { Objects as ObjectsMod } from "./objects.ts";
import { Player as PlayerMod } from "./player.ts";
import { Runtime as RuntimeMod } from "./runtime.ts";
import { Map as MapMod } from "./map.ts";
import { Ghosts as GhostsMod } from "./ghosts.ts";
import { FieldView as FieldViewMod } from "./field_view.ts";
import { Display } from "./display.ts";
import { PokecenterHeal } from "./pokecenter_heal.ts";
import { ShowMon } from "./field_move_show_mon.ts";
import { Itemfinder } from "./itemfinder.ts";
import { Audio as AudioMod } from "./audio.ts";
import { Profile } from "./profile.ts";
import { SE } from "./se_ids.ts";
import { Trig } from "./trig.ts";
import { WarpArrow } from "./warp_arrow.ts";
import { Constants } from "./constants.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

// Lua: field_effects.lua:14
export const FieldEffects: Record<string, any> = {};

FieldEffects._cache = null;
FieldEffects._sheets = {} as Record<string, FxSheet | false>; // [name] = { image, quads, fw, fh, frames }
FieldEffects._fx = null;    // tall grass
FieldEffects._anims = [null] as LuaTable;  // transient active field animations
FieldEffects._ground = null; // pokefirered/src/event_object_movement.c:8721
FieldEffects._surfClock = 0;
FieldEffects._logged = false;
// pokefirered/src/scrcmd.c:2051 -- gFieldEffectArguments
FieldEffects._fieldEffectArguments = {} as Record<number, any>;
// waitfieldeffect callers parked until isFieldEffectActive(id) goes false.
FieldEffects._waiters = [null] as LuaTable;

// pokefirered/include/constants/field_effects.h:71-72
FieldEffects.FLDEFF_MOVE_DEOXYS_ROCK = 67;
FieldEffects.FLDEFF_DESTROY_DEOXYS_ROCK = 68;

// Lua: field_effects.lua:34 -- pokefirered/include/constants/songs.h:81,80
const SE_THUNDER2 = 81;
const SE_THUNDER = 80;

// Lua: field_effects.lua:41
const FRAG_TRAVEL_X = 260;
const FRAG_TRAVEL_Y = 200;

// Lua: field_effects.lua:44
const CELL = 16;
const FEET_H = 8;
const RUSTLE = seq(1, 2, 3, 4, 0) as (number | null)[];
const FRAME_DUR = 10;
// pokefirered/src/data/field_effects/field_effect_objects.h:1099
const FLY_BIRD_W = 64, FLY_BIRD_H = 64, FLY_BIRD_FRAMES = 5;

// Lua: field_effects.lua:52
let frlgReflective: Record<number, boolean> | null = null;
let frlgReflectionQuad: Quad | null = null;
let frlgModules: any = null;
const FRLG_REFL_CULL = 64;
const objectPoseOpts: any = {};
const playerPoseOpts: any = {};

// Lua: field_effects.lua:58
function isFrlgReflective(behavior: any): boolean {
  if (!frlgReflective) {
    frlgReflective = {};
    for (const [, name] of ipairs<string>(seq("POND_WATER", "PUDDLE", "UNUSED_WATER", "CYCLING_ROAD_WATER", "ICE"))) {
      const id = MB.id(name);
      if (id != null) frlgReflective[id] = true;
    }
  }
  return frlgReflective[behavior] === true;
}
FieldEffects.isFrlgReflective = isFrlgReflective;

// Lua: field_effects.lua:71
function frlgReflectionType(cx: number, cy: number, pcx: number, pcy: number, w: number | undefined, h: number | undefined,
  behaviorAt: (x: number, y: number) => any): boolean {
  const width = Math.floor(((w ?? 16) + 8) / 16);
  const height = Math.floor(((h ?? 32) + 8) / 16);
  for (let row = 0; row <= height - 1; row++) {
    const y = cy + 1 + row;
    const prevY = pcy + 1 + row;
    for (let dx = 1 - width; dx <= width - 1; dx++) {
      if (isFrlgReflective(behaviorAt(cx + dx, y))
        || isFrlgReflective(behaviorAt(pcx + dx, prevY))) return true;
    }
  }
  return false;
}
FieldEffects.frlgReflectionType = frlgReflectionType;

// Lua: field_effects.lua:87
function getFrlgModules(): any {
  if (frlgModules) return frlgModules;
  const Collision: any = CollisionMod, Ow: any = OwSpritesMod, Objects: any = ObjectsMod;
  const Player: any = PlayerMod, Runtime: any = RuntimeMod;
  if (!(Collision && Collision.behavior && Ow && Ow.getDraw && Ow.pose
    && Objects && Player && Runtime)) return null;
  frlgModules = {
    Collision, Ow, Objects,
    Player, Runtime,
  };
  return frlgModules;
}

// Lua: field_effects.lua:103
function drawFrlgReflections(camX: number, camY: number): void {
  if (GameVersion.layout(GameVersion.get()) !== "frlg") return;
  const modules = getFrlgModules();
  if (!modules) return;
  const Collision = modules.Collision, Ow = modules.Ow;
  const Objects = modules.Objects, P = modules.Player, Runtime = modules.Runtime;
  const behaviorAt = Collision.worldBehavior ?? Collision.behavior;
  let drawn = 0;
  if (Objects.forDraw) {
    for (const [, obj] of ipairs<any>(Objects.forDraw())) {
      if (!truthy(obj.hideReflection) && obj.graphicsId != null) {
        const spr = Ow.getDraw(obj.graphicsId);
        if (spr) {
          objectPoseOpts.frame = obj.customFrame;
          const [frame, flip] = Ow.pose(spr, obj.facing, Objects.walkPhase(obj), obj.stepFlip,
            objectPoseOpts);
          if (drawFrlgReflection(obj, obj.graphicsId, frame, flip, camX, camY,
            behaviorAt, Ow)) drawn = drawn + 1;
        }
      }
    }
  }
  const M: any = MapMod;
  const Ghosts: any = GhostsMod;
  const world = M ? M.world : null;
  if (Ghosts && Ghosts.forDraw && world != null && typeof world === "object") {
    const host = Collision._mapDef;
    const FV: any = FieldViewMod;
    const D: any = Display;
    const vw = (FV && FV._viewW) || D.W;
    const vh = (FV && FV._viewH) || D.H;
    const x0 = camX - FRLG_REFL_CULL, y0 = camY - FRLG_REFL_CULL;
    const x1 = camX + vw + FRLG_REFL_CULL, y1 = camY + vh + FRLG_REFL_CULL;
    for (let i = 1; i <= len(world); i++) {
      const entry = world[i];
      const ox = entry.ox ?? 0, oy = entry.oy ?? 0;
      const L = entry.def ? entry.def.midLayout : null;
      const ex = ox * CELL, ey = oy * CELL;
      if (entry.def !== host && L
        && ex + (L.width ?? 0) * CELL > x0 && ex < x1
        && ey + (L.height ?? 0) * CELL > y0 && ey < y1) {
        const live = Ghosts.forDraw(entry.id);
        if (live) {
          for (let j = 1; j <= len(live); j++) {
            const obj = live[j];
            if (!truthy(obj.hideReflection) && obj.graphicsId != null && obj.virtualId == null) {
              const spr = Ow.getDraw(obj.graphicsId);
              if (spr) {
                objectPoseOpts.frame = obj.customFrame;
                const [frame, flip] = Ow.pose(spr, obj.facing, Objects.walkPhase(obj), obj.stepFlip,
                  objectPoseOpts);
                if (drawFrlgReflection(obj, obj.graphicsId, frame, flip, camX, camY,
                  behaviorAt, Ow, ox, oy)) drawn = drawn + 1;
              }
            }
          }
        }
      }
    }
  }
  if (P && P.isVisible && P.isVisible() && !truthy(P.hideReflection)) {
    const gid = Ow.playerGraphicsId(Runtime._game, P);
    const spr = gid != null ? Ow.getDraw(gid) : null;
    if (spr) {
      playerPoseOpts.running = P.runPose ? P.runPose() : undefined;
      const [frame, flip] = Ow.pose(spr, P.facing, P.walkPhase ? P.walkPhase() : 0,
        P.drawFlip ? P.drawFlip() : false, playerPoseOpts);
      if (drawFrlgReflection(P, gid, frame, flip, camX, camY,
        behaviorAt, Ow)) drawn = drawn + 1;
    }
  }
  FieldEffects.lastFrlgReflections = drawn;
}

// Lua: field_effects.lua:177
function drawFrlgReflection(obj: any, graphicsId: any, frame: number, hflip: boolean, camX: number, camY: number,
  behaviorAt: (x: number, y: number) => any, Ow: any, ox?: number, oy?: number): boolean {
  const spr = Ow.getReflectionDraw ? Ow.getReflectionDraw(graphicsId) : null;
  if (!(spr && spr.quads && spr.quads[frame])) return false;
  ox = ox ?? 0; oy = oy ?? 0;
  const cx = (truthy(obj.moving) && obj.targetX != null ? obj.targetX : obj.cellX) + ox;
  const cy = (truthy(obj.moving) && obj.targetY != null ? obj.targetY : obj.cellY) + oy;
  const pcx = obj.cellX + ox, pcy = obj.cellY + oy;
  if (!frlgReflectionType(cx, cy, pcx, pcy, spr.width, spr.height, behaviorAt)) return false;
  const w = spr.width, h = spr.height;
  const left = (obj.px ?? (cx - ox) * CELL) + ox * CELL + (16 - w) / 2;
  const top = (obj.py ?? (cy - oy) * CELL) + oy * CELL + 14;
  const x0 = Math.floor(left / CELL), x1 = Math.floor((left + w - 1) / CELL);
  const y0 = Math.floor(top / CELL), y1 = Math.floor((top + h - 1) / CELL);
  const q = frlgReflectionQuad ?? G.newQuad(0, 0, 1, 1, spr.width, spr.height * spr.frameCount);
  frlgReflectionQuad = q;
  G.setColor(1, 1, 1, 1);
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      if (isFrlgReflective(behaviorAt(tx, ty))) {
        const ix0 = Math.max(left, tx * CELL), ix1 = Math.min(left + w, tx * CELL + CELL);
        const iy0 = Math.max(top, ty * CELL), iy1 = Math.min(top + h, ty * CELL + CELL);
        const dw = ix1 - ix0, dh = iy1 - iy0;
        if (dw > 0 && dh > 0) {
          const sx = hflip ? (w - (ix0 - left + dw)) : ix0 - left;
          const sy = h - (iy0 - top + dh);
          q.setViewport(sx, frame * h + sy, dw, dh, w, h * spr.frameCount);
          G.draw(spr.image, q, ix0 + (hflip ? dw : 0) - camX, iy0 + dh - camY,
            0, hflip ? -1 : 1, -1);
        }
      }
    }
  }
  G.setColor(1, 1, 1, 1);
  return true;
}

// Lua: field_effects.lua:216 -- getMod: every module is in the bundle.
function modFieldView(): any { return FieldViewMod; }
function modHeal(): any { return PokecenterHeal; }
function modShowMon(): any { return ShowMon; }
function modItemfinder(): any { return Itemfinder; }
function modAudio(): any { return AudioMod; }
function modOwSprites(): any { return OwSpritesMod; }
function modRenderer(): any { return Renderer; }

// Lua: field_effects.lua:238
function log(msg: unknown): void {
  if (FieldEffects._logged) return;
  FieldEffects._logged = true;
  Logger.info("%s", "[game3/field_effects] " + tostring(msg));
}

// Lua: field_effects.lua:244
function cache_root(): string {
  return Extract.CACHE_ROOT || "data/generated/gba";
}

// Lua: field_effects.lua:248
const EMPTY: any = {};

// Lua: field_effects.lua:250
function fieldBlock(): any {
  let row: any;
  try { row = Profile.forSession(); } catch { return EMPTY; }
  return (row && row.field) || EMPTY;
}

// Lua: field_effects.lua:256
function se_id(name: string, fallback?: number): number | undefined {
  const S: any = SE;
  return (S && S[name]) || fallback;
}

// Lua: field_effects.lua:261
function fx_manifest(): any {
  const m = FieldEffects._manifest;
  if (m != null) return m || null;
  const cache = FieldEffects._cache;
  const src = cache && cache.read ? cache.read(cache_root() + "/field_effects/objects.lua") : null;
  let t: any = null;
  if (src) {
    const [chunk] = luaLoad(src, "@field_effects/objects.lua");
    let ok = false;
    let res: any = null;
    if (chunk) {
      try { res = chunk(); ok = true; } catch { ok = false; }
    }
    if (ok && res != null && typeof res === "object") t = res;
  }
  if (t) {
    const byName: Record<string, any> = {};
    for (const [, list] of ipairs<any>(seq(t.objects ?? {}, t.extras ?? {}))) {
      for (const [, o] of pairs<any>(list)) {
        if (o != null && typeof o === "object" && o.name) byName[o.name] = o;
      }
    }
    t._byName = byName;
  }
  FieldEffects._manifest = t || false;
  return t;
}

// Lua: field_effects.lua:286
FieldEffects.manifest = function (): any {
  return fx_manifest();
};

// Lua: field_effects.lua:290
function rse(): any {
  const m = fx_manifest();
  if (m && m.family === "rse") {
    // NOT FAITHFUL: Emerald only -- src.core.game3.field_effects_rse is not ported.
    throw new Error("NOT FAITHFUL: Emerald only: src.core.game3.field_effects_rse");
  }
  return null;
}
FieldEffects.rse = rse;

// Lua: field_effects.lua:298 -- pokeemerald/src/field_effect_helpers.c:926
FieldEffects.startAsh = function (cx: number, cy: number): any {
  const R = rse();
  if (R) return R.startAsh(cx, cy, null, 1);
};

// Lua: field_effects.lua:304 -- pokeemerald/src/field_effect.c:2220
FieldEffects.startAshPuff = function (cx: number, cy: number, onDone?: () => void): any {
  const R = rse();
  if (R) return R.startAshPuff(cx, cy, onDone);
};

// Lua: field_effects.lua:310 -- pokeemerald/src/field_effect.c:2127
FieldEffects.startAshLaunch = function (cx: number, cy: number, onDone?: () => void): any {
  const R = rse();
  if (R) return R.startAshLaunch(cx, cy, onDone);
};

// Lua: field_effects.lua:315
FieldEffects.manifestObject = function (name: string): any {
  const m = fx_manifest();
  if (!m) return null;
  name = (m.aliases && m.aliases[name]) || name;
  return m._byName[name];
};

// Lua: field_effects.lua:322
function try_load_rgba(cache: any, rel: string, w: number, h: number): Image | null {
  if (!cache || !cache.read) return null;
  const rgba = cache.read(rel);
  if (!rgba || rgba.length !== w * h * 4) return null;
  let id: any;
  try { id = newImageData(w, h, "rgba8", rgba); } catch { return null; }
  if (!id) return null;
  const img = G.newImage(id);
  if ((img as any).setFilter) (img as any).setFilter("nearest", "nearest");
  return img;
}

export interface FxSheet { image: Image; quads: Quad[]; quadsFront: Quad[]; fw: number; fh: number; frames: number }

// Lua: field_effects.lua:334 -- quads / quadsFront keep Brian's 0-based frame keys
function load_sheet(name: string, fw?: number, fh?: number, frames?: number): FxSheet | null {
  const memo = FieldEffects._sheets[name];
  if (memo != null) return memo || null;
  let file = name + ".rgba";
  if (fx_manifest()) {
    const o = FieldEffects.manifestObject(name);
    if (!(o && o.rgba && o.fw && o.fh && (o.frames ?? 0) > 0)) {
      FieldEffects._sheets[name] = false;
      return null;
    }
    fw = o.fw; fh = o.fh; frames = o.frames; file = o.rgba;
  }
  if (!(fw && fh && frames)) return null;
  const totalH = fh * frames;
  const root = cache_root() + "/field_effects/";
  const img = try_load_rgba(FieldEffects._cache, root + file, fw, totalH);
  if (!img) {
    FieldEffects._sheets[name] = false;
    return null;
  }

  const quads: Quad[] = [];
  const quadsFront: Quad[] = [];
  const [iw, ih] = img.getDimensions();
  for (let i = 0; i <= frames - 1; i++) {
    const y = i * fh;
    if (y + fh <= ih) {
      quads[i] = G.newQuad(0, y, fw, fh, iw, ih);
      if (fh >= FEET_H) {
        quadsFront[i] = G.newQuad(0, y + (fh - FEET_H), fw, FEET_H, iw, ih);
      }
    }
  }

  const sheet: FxSheet = {
    image: img,
    quads,
    quadsFront,
    fw,
    fh,
    frames,
  };
  FieldEffects._sheets[name] = sheet;
  return sheet;
}
FieldEffects.loadSheet = load_sheet;

// Lua: field_effects.lua:381
FieldEffects.install = function (cache: any): void {
  // package.loaded["src.core.game3.field_effects_rse"] is never loaded here.
  FieldEffects._cache = cache;
  FieldEffects._manifest = null;
  FieldEffects._sheets = {};
  FieldEffects._fx = null;
  FieldEffects._anims = [null];
  FieldEffects._ground = null;
  FieldEffects._surfClock = 0;
  FieldEffects._logged = false;
  const FieldView = modFieldView();
  if (FieldView && FieldView.setCameraPanning) {
    FieldView.setCameraPanning(0, 0);
    FieldView.setFlashRadius(null);
  }
  const Heal = modHeal();
  if (Heal && Heal.install) Heal.install(cache);
  const SM = modShowMon();
  if (SM && SM.invalidate) SM.invalidate();
};

// Lua: field_effects.lua:403
FieldEffects.invalidate = function (): void {
  // package.loaded["src.core.game3.field_effects_rse"] is never loaded here.
  FieldEffects._manifest = null;
  FieldEffects._sheets = {};
  FieldEffects._fx = null;
  FieldEffects._anims = [null];
  FieldEffects._ground = null;
  const FieldView = modFieldView();
  if (FieldView && FieldView.setCameraPanning) {
    FieldView.setCameraPanning(0, 0);
    FieldView.setFlashRadius(null);
  }
  const Heal = modHeal();
  if (Heal && Heal.invalidate) Heal.invalidate();
  const SM = modShowMon();
  if (SM && SM.invalidate) SM.invalidate();
};

// ---------------------------------------------------------------- Tall Grass
// Lua: field_effects.lua:423
function manifest_seq(o: any): LuaTable | null {
  const sq: LuaTable = [null];
  for (const [, cmd] of ipairs<any>(o && o.anims && o.anims[1] ? o.anims[1] : {})) {
    if (cmd[1] === "frame") sq[len(sq) + 1] = seq(cmd[2], Math.max(1, tonumber(cmd[3]) ?? 1));
  }
  return len(sq) > 0 ? sq : null;
}

// Lua: field_effects.lua:432 -- pokeemerald/src/event_object_movement.c:7839 -- [name, seq] or []
function grass_sheet_for(cx: number, cy: number): [string?, LuaTable?] {
  if (!fx_manifest()) return [];
  const Collision: any = CollisionMod;
  const beh = Collision && Collision.behavior ? Collision.behavior(cx, cy) : null;
  const name = (beh != null && beh === MB.id("LONG_GRASS")) ? "long_grass" : "tall_grass";
  return [name, manifest_seq(FieldEffects.manifestObject(name)) ?? undefined];
}

// Lua: field_effects.lua:441
FieldEffects.tallGrassAt = function (cxIn: unknown, cyIn: unknown, seekEnd?: boolean): void {
  const cx = tonumber(cxIn) ?? 0, cy = tonumber(cyIn) ?? 0;
  const [name, sq] = grass_sheet_for(cx, cy);
  const sheet = name ? load_sheet(name) : load_sheet("tall_grass", 16, 16, 5);
  if (!sheet) return;
  const fx = FieldEffects._fx;
  if (fx && fx.cx === cx && fx.cy === cy && !fx.leaving) return;
  FieldEffects._fx = {
    cx,
    cy,
    timer: 0,
    step: seekEnd ? (len(RUSTLE) - 1) : 0,
    leaving: false,
    done: false,
    sheet: sq ? name : null,
    seq: sq ?? null,
  };
  if (sq) {
    const nw = FieldEffects._fx;
    nw.step = seekEnd ? len(sq) : 1;
    nw.frame = sq[seekEnd ? len(sq) : 1][1];
  }
};

// Lua: field_effects.lua:465
function grass_frame(fx: any): number {
  if (fx.seq) return fx.frame ?? 0;
  return RUSTLE[fx.step + 1] ?? 0;
}

// Lua: field_effects.lua:470
FieldEffects.clearTallGrass = function (): void {
  FieldEffects._fx = null;
};

// Lua: field_effects.lua:474
FieldEffects.leaveTallGrass = function (): void {
  const fx = FieldEffects._fx;
  if (!fx) return;
  fx.leaving = true;
};

// ---------------------------------------------------------------- Transient Animations

// Lua: field_effects.lua:483 -- pret EventScript_CutTreeDown / Movement_CutTreeDown
FieldEffects.startCutTree = function (targetObj: any, cxIn: unknown, cyIn: unknown, onDone?: () => void): void {
  const cx = tonumber(cxIn) ?? 0, cy = tonumber(cyIn) ?? 0;
  const anim = {
    kind: "cut_tree",
    targetObj,
    cx,
    cy,
    timer: 0,
    maxDur: 24, // 4 frames (0, 1, 2, 3) at 6 ticks per frame
    onDone,
  };
  insert(FieldEffects._anims, anim);
};

// Lua: field_effects.lua:498 -- pret FldEff_CutGrass
FieldEffects.startCutGrass = function (cxIn: unknown, cyIn: unknown, onDone?: () => void): void {
  load_sheet("cut_grass", 8, 8, 1);
  const cx = tonumber(cxIn) ?? 0, cy = tonumber(cyIn) ?? 0;
  const px = cx * CELL;
  const py = cy * CELL;

  const particles: LuaTable = [null];
  for (let i = 1; i <= 8; i++) {
    const angle = (i - 1) * (Math.PI / 4);
    const spd = 1.2 + random() * 1.0;
    particles[len(particles) + 1] = {
      x: px + 4,
      y: py + 4,
      vx: Math.cos(angle) * spd,
      vy: Math.sin(angle) * spd - 1.0,
      frame: 0,
    };
  }

  const anim = {
    kind: "cut_grass_scatter",
    cx,
    cy,
    timer: 0,
    maxDur: 24,
    particles,
    onDone,
  };
  insert(FieldEffects._anims, anim);
};

// Lua: field_effects.lua:530
FieldEffects.startRockSmash = function (targetObj: any, cxIn: unknown, cyIn: unknown, onDone?: () => void): void {
  load_sheet("rock_smash", 16, 16, 4);
  const cx = tonumber(cxIn) ?? 0, cy = tonumber(cyIn) ?? 0;
  const px = cx * CELL;
  const py = cy * CELL;

  const particles: LuaTable = [null];
  for (let i = 1; i <= 8; i++) {
    const angle = (i - 1) * (Math.PI / 4) + (random() * 0.3 - 0.15);
    const spd = 1.2 + random() * 1.6;
    particles[len(particles) + 1] = {
      x: px + 4,
      y: py + 4,
      vx: Math.cos(angle) * spd,
      vy: Math.sin(angle) * spd - 1.5,
      frame: random(0, 3),
    };
  }

  const anim = {
    kind: "rock_smash",
    targetObj,
    cx,
    cy,
    timer: 0,
    maxDur: 24,
    particles,
    onDone,
  };
  insert(FieldEffects._anims, anim);
};

// Lua: field_effects.lua:563 -- pokefirered/src/field_screen_effect.c:194
FieldEffects.animateFlashLevel = function (fromLevel: unknown, toLevel: unknown): any {
  const FieldView = modFieldView();
  if (!FieldView) return null;
  const from = FieldView.radiusForLevel(fromLevel);
  const to = FieldView.radiusForLevel(toLevel);
  if (from === to) {
    FieldView.setFlashLevel(toLevel);
    return null;
  }
  FieldView.setFlashRadius(from);
  // pokeemerald/src/field_screen_effect.c:980
  const step = rse() ? 1 : 2;
  const anim = {
    kind: "flash_level",
    radius: from,
    dest: to,
    delta: (from < to) ? step : -step,
    level: tonumber(toLevel) ?? 0,
    clear: (tonumber(toLevel) ?? 0) === 0,
    state: 0,
    timer: 0,
  };
  insert(FieldEffects._anims, anim);
  return anim;
};

// Lua: field_effects.lua:590 -- Screen flash animation (Flash HM)
FieldEffects.startFlash = function (onDone?: () => void): any {
  const anim: any = {
    kind: "flash",
    alpha: 1.0,
    timer: 0,
    maxDur: 30,
  };
  insert(FieldEffects._anims, anim);
  // pokefirered/data/scripts/flash.inc:2
  const FieldView = modFieldView();
  let levelAnim: any = null;
  if (FieldView && FieldView.getFlashLevel && FieldView.getFlashLevel() !== 0) {
    levelAnim = FieldEffects.animateFlashLevel(FieldView.getFlashLevel(), 0);
  }
  // pokefirered/src/field_screen_effect.c:202
  if (levelAnim) {
    levelAnim.onDone = onDone;
  } else {
    anim.onDone = onDone;
  }
  return levelAnim ?? anim;
};

// Lua: field_effects.lua:614 -- pokefirered/src/field_effect.c:1258
FieldEffects.startLandingShake = function (onDone?: () => void): any {
  const anim = {
    kind: "camera_shake",
    amp: 4,
    ticks: 0,
    timer: 0,
    onDone,
  };
  insert(FieldEffects._anims, anim);
  return anim;
};

// Lua: field_effects.lua:626
function player_gender(): number {
  const R: any = RuntimeMod;
  const s = R && R.getSession ? R.getSession() : null;
  return (s ? tonumber(s.gender) : undefined) ?? 0;
}

// Lua: field_effects.lua:632 (SINE is a sequence: SINE[1] is gSineTable[0])
// (Trig.SINE is read at call time: no top-level reads of imports)
function gba_sin(i: number, a: number): number { return Math.floor(a * Trig.SINE[i + 1]! / 256); }
function gba_cos(i: number, a: number): number { return Math.floor(a * Trig.SINE[i + 64 + 1]! / 256); }

// Lua: field_effects.lua:636
const PLAYER_SPRITE_X = 120, PLAYER_SPRITE_Y = 72;
// pokefirered/src/event_object_movement.c:9051
const JUMP_Y_HIGH = seq(-4, -6, -8, -10, -11, -12, -12, -12, -11, -10, -9, -8, -6, -4, 0, 0) as (number | null)[];
// pokefirered/src/field_effect.c:3577
const JUMP_OFF_Y = seq(-2, -4, -5, -6, -7, -8, -8, -8, -7, -7, -6, -5, -3, -2, 0, 2, 4, 8) as (number | null)[];
// pokefirered/src/field_effect.c:2373
const SPIN_NEXT: Record<string, string> = { down: "left", left: "up", up: "right", right: "down" };

// Lua: field_effects.lua:644
function fly_player(): any {
  return PlayerMod;
}

// Lua: field_effects.lua:649 -- pokefirered/src/field_effect.c:3338 CreateFlyBirdSprite
function new_bird(): any {
  return {
    x: 255, y: 180, x2: 0, y2: 0, anim: 0, cb: null, attached: false,
    init: false, d1: 0, d2: 0, d3: 0, d4: 0, done: false,
  };
}

// Lua: field_effects.lua:655 -- pokefirered/src/field_effect.c:3360 StartFlyBirdSwoopDown
function bird_start_swoop(b: any): void {
  b.cb = "swoop";
  b.x = 120; b.y = 0; b.x2 = 0; b.y2 = 0;
  b.init = false; b.d1 = 0; b.d2 = 0; b.d3 = 0; b.d4 = 0; b.done = false;
  b.attached = false;
}

// Lua: field_effects.lua:662
function bird_attach_player(b: any): void {
  if (!b.attached) return;
  const P = fly_player();
  if (!P) return;
  P.spriteXOffset = b.x + b.x2 - PLAYER_SPRITE_X;
  P.spriteYOffset = b.y + b.y2 - 8 - PLAYER_SPRITE_Y;
}

// Lua: field_effects.lua:670
function bird_affine_step(b: any): void {
  const a = b.aff;
  if (!a) return;
  if (a.kind === "leave") {
    // pokefirered/src/field_effect.c:3378 sAffineAnim_FlyBirdLeaveBall
    if (a.k === 0) { a.scale = 8; a.rot = -30 * 256; }
    else if (a.k <= 30) a.scale = a.scale + 28;
  } else if (a.kind === "return") {
    // pokefirered/src/field_effect.c:3385 sAffineAnim_FlyBirdReturnToBall
    if (a.k === 0) { a.scale = 256; a.rot = 64 * 256; }
    else if (a.k <= 22) a.scale = a.scale - 10;
  } else if (a.kind === "out") {
    // pokefirered/src/field_effect.c:3650 sAffineAnim_FlyBirdOutOfMap
    a.scale = a.scale + 24;
  } else if (a.kind === "in") {
    // pokefirered/src/field_effect.c:3656 sAffineAnim_FlyBirdIntoMap
    if (a.k === 0) a.scale = a.scale + 512; else a.scale = a.scale - 16;
  }
  a.k = a.k + 1;
}

// Lua: field_effects.lua:691
function bird_step(b: any, gender: number): void {
  if (b.cb === "leave") {
    // pokefirered/src/field_effect.c:3398 SpriteCB_FlyBirdLeaveBall
    if (!b.done) {
      if (!b.init) {
        b.aff = { kind: "leave", k: 0, scale: 256, rot: 0 };
        b.x = (gender === 0) ? 128 : 118;
        b.y = -48;
        b.init = true;
        b.d1 = 64; b.d2 = 256;
      }
      b.d1 = b.d1 + Math.floor(b.d2 / 256);
      b.x2 = gba_cos(b.d1, 120);
      b.y2 = gba_sin(b.d1, 120);
      if (b.d2 < 2048) b.d2 = b.d2 + 96;
      if (b.d1 > 129) {
        b.done = true;
        b.aff = null;
      }
    }
  } else if (b.cb === "swoop") {
    // pokefirered/src/field_effect.c:3432 SpriteCB_FlyBirdSwoopDown
    b.x2 = gba_cos(b.d2, 140);
    b.y2 = gba_sin(b.d2, 72);
    b.d2 = mod(b.d2 + 4, 256);
    bird_attach_player(b);
    if (b.d2 >= 128) b.done = true;
  } else if (b.cb === "with_player") {
    // pokefirered/src/field_effect.c:3677 SpriteCB_FlyBirdWithPlayer
    b.x2 = gba_cos(b.d2, 180);
    b.y2 = gba_sin(b.d2, 72);
    b.d2 = mod(b.d2 + 2, 256);
    bird_attach_player(b);
    if (b.d2 >= 128) {
      b.done = true;
      b.aff = null;
    }
  } else if (b.cb === "return") {
    // pokefirered/src/field_effect.c:3450 SpriteCB_FlyBirdReturnToBall
    if (!b.done) {
      if (!b.init) {
        b.aff = { kind: "return", k: 0, scale: 256, rot: 0 };
        b.x = (gender === 0) ? 112 : 100;
        b.y = -32;
        b.init = true;
        b.d1 = 240; b.d2 = 2048; b.d4 = 128;
      }
      const step = Math.floor(b.d2 / 256);
      b.d1 = mod(b.d1 + step, 256);
      b.d3 = b.d3 + step;
      b.x2 = gba_cos(b.d1, 32);
      b.y2 = gba_sin(b.d1, 120);
      if (b.d2 > 256) b.d2 = b.d2 - b.d4;
      if (b.d4 < 256) b.d4 = b.d4 + 24;
      if (b.d2 < 256) b.d2 = 256;
      if (b.d3 >= 60) {
        b.done = true;
        b.aff = null;
        b.invisible = true;
      }
    }
  }
  bird_affine_step(b);
}

// Lua: field_effects.lua:756
function fly_clear_player(P: any): void {
  P.spriteXOffset = 0;
  P.spriteYOffset = 0;
  P.flyRide = false;
}

// Lua: field_effects.lua:763 -- pokefirered/src/field_effect.c:3252 FlyOutFieldEffect_BirdLeaveBall
FieldEffects.startFlyOut = function (onFlownOff?: () => void): any {
  load_sheet("fly_bird", FLY_BIRD_W, FLY_BIRD_H, FLY_BIRD_FRAMES);
  const anim = {
    kind: "fly_out",
    state: "leave_ball",
    timer: 0,
    tTimer: 0,
    gender: player_gender(),
    onDone: onFlownOff,
  };
  insert(FieldEffects._anims, anim);
  return anim;
};

// Lua: field_effects.lua:777
function step_fly_out(a: any): boolean {
  const P = fly_player();
  if (!P) return true;
  const st = a.state;
  if (st === "leave_ball") {
    // pokefirered/src/field_effect.c:3252 FlyOutFieldEffect_BirdLeaveBall
    P.fieldMoveAnim = 1;
    a.bird = new_bird();
    a.bird.cb = "leave";
    a.state = "wait_leave";
  } else if (st === "wait_leave") {
    // pokefirered/src/field_effect.c:3267 FlyOutFieldEffect_WaitBirdLeave
    if (a.bird.done) {
      a.state = "swoop";
      a.tTimer = 16;
      P.fieldMoveAnim = 0;
      P.facing = "left";
    } else {
      P.fieldMoveAnim = 1;
    }
  } else if (st === "swoop") {
    // pokefirered/src/field_effect.c:3278 FlyOutFieldEffect_BirdSwoopDown
    if (a.tTimer !== 0) a.tTimer = a.tTimer - 1;
    if (a.tTimer === 0) {
      a.state = "jump_on";
      play_se(se_id("SE_M_FLY", 151));
      bird_start_swoop(a.bird);
    }
  } else if (st === "jump_on") {
    // pokefirered/src/field_effect.c:3289 FlyOutFieldEffect_JumpOnBird
    a.tTimer = a.tTimer + 1;
    if (a.tTimer >= 8) {
      P.flyRide = true;
      P.facing = "left";
      a.jump = 0;
      a.state = "fly_off";
      a.tTimer = 0;
    }
  } else if (st === "fly_off") {
    // pokefirered/src/field_effect.c:3303 FlyOutFieldEffect_FlyOffWithBird
    a.tTimer = a.tTimer + 1;
    if (a.tTimer >= 10) {
      a.jump = null;
      const b = a.bird;
      b.attached = true;
      b.anim = a.gender * 2 + 1;
      b.aff = { kind: "out", k: 0, scale: 256, rot: 0 };
      b.cb = "with_player";
      a.state = "wait_off";
    }
  } else if (st === "wait_off") {
    // pokefirered/src/field_effect.c:3320 FlyOutFieldEffect_WaitFlyOff
    if (a.bird.done) {
      fly_clear_player(P);
      P.setVisible(false);
      return true;
    }
  }
  if (a.bird) bird_step(a.bird, a.gender);
  if (a.jump != null) {
    P.spriteYOffset = JUMP_Y_HIGH[a.jump + 1] ?? 0;
    a.jump = a.jump + 1;
    if (a.jump >= len(JUMP_Y_HIGH)) a.jump = null;
  }
  return false;
}

// Lua: field_effects.lua:845 -- pokefirered/src/field_effect.c:3518 FldEff_FlyIn
FieldEffects.startFlyIn = function (onDone?: () => void): any {
  load_sheet("fly_bird", FLY_BIRD_W, FLY_BIRD_H, FLY_BIRD_FRAMES);
  const anim = {
    kind: "fly_in",
    state: "swoop",
    timer: 0,
    tTimer: 0,
    gender: player_gender(),
    onDone,
  };
  insert(FieldEffects._anims, anim);
  return anim;
};

// Lua: field_effects.lua:859
function step_fly_in(a: any): boolean {
  const P = fly_player();
  if (!P) return true;
  const st = a.state;
  if (st === "swoop") {
    // pokefirered/src/field_effect.c:3529 FlyInFieldEffect_BirdSwoopDown
    a.state = "with_bird";
    a.tTimer = 33;
    P.flyRide = true;
    P.facing = "left";
    P.setVisible(true);
    const b = new_bird();
    bird_start_swoop(b);
    b.attached = true;
    b.anim = a.gender * 2 + 2;
    b.aff = { kind: "in", k: 0, scale: 256, rot: 0 };
    b.cb = "with_player";
    a.bird = b;
  } else if (st === "with_bird") {
    // pokefirered/src/field_effect.c:3556 FlyInFieldEffect_FlyInWithBird
    const b = a.bird;
    // pokefirered/src/field_effect.c:3705 TryChangeBirdSprite
    if (b.aff && b.aff.scale === 256) {
      b.aff = null;
      b.anim = 0;
      b.cb = "swoop";
    }
    if (a.tTimer !== 0) a.tTimer = a.tTimer - 1;
    if (a.tTimer === 0) {
      b.attached = false;
      a.baseY = P.spriteYOffset;
      a.state = "jump_off";
      a.tTimer = 0;
    }
  } else if (st === "jump_off") {
    // pokefirered/src/field_effect.c:3575 FlyInFieldEffect_JumpOffBird
    P.spriteYOffset = a.baseY + JUMP_OFF_Y[a.tTimer + 1]!;
    a.tTimer = a.tTimer + 1;
    if (a.tTimer >= len(JUMP_OFF_Y)) a.state = "pose";
  } else if (st === "pose") {
    // pokefirered/src/field_effect.c:3584 FlyInFieldEffect_FieldMovePose
    if (a.bird.done) {
      fly_clear_player(P);
      P.startFieldMove(24);
      a.poseWait = 24;
      a.state = "return";
    }
  } else if (st === "return") {
    // pokefirered/src/field_effect.c:3603 FlyInFieldEffect_BirdReturnToBall
    a.poseWait = a.poseWait - 1;
    if (a.poseWait <= 0) {
      P.fieldMoveAnim = 1;
      bird_start_swoop(a.bird);
      a.bird.cb = "return";
      a.state = "wait_return";
    }
  } else if (st === "wait_return") {
    // pokefirered/src/field_effect.c:3612 FlyInFieldEffect_WaitBirdReturn
    P.fieldMoveAnim = 1;
    if (a.bird.done) {
      a.bird = null;
      a.state = "end";
      a.d1 = 16;
    }
  } else if (st === "end") {
    // pokefirered/src/field_effect.c:3622 FlyInFieldEffect_End
    a.d1 = a.d1 - 1;
    if (a.d1 === 0) {
      P.fieldMoveAnim = 0;
      P.facing = "down";
      return true;
    }
    P.fieldMoveAnim = 1;
  }
  if (a.bird) bird_step(a.bird, a.gender);
  return false;
}

// Lua: field_effects.lua:938 -- pokefirered/src/field_effect.c:2352 CreateTeleportFieldEffectTask
FieldEffects.startTeleportOut = function (onRisen?: () => void): any {
  const P = fly_player();
  const anim = {
    kind: "teleport_out",
    state: 2,
    timer: 0,
    orig: P ? P.facing ?? "down" : "down",
    d1: 0, d2: 0, d3: 0, d4: 0,
    onDone: onRisen,
  };
  insert(FieldEffects._anims, anim);
  return anim;
};

// Lua: field_effects.lua:952
function step_teleport_out(a: any): boolean {
  const P = fly_player();
  if (!P) return true;
  if (a.state === 2) {
    // pokefirered/src/field_effect.c:2371 TeleportFieldEffectTask2
    let turn = a.d1 === 0;
    if (!turn) {
      a.d1 = a.d1 - 1;
      turn = a.d1 === 0;
    }
    if (turn) {
      P.facing = SPIN_NEXT[P.facing] ?? "down";
      a.d1 = 8;
      a.d2 = a.d2 + 1;
    }
    if (a.d2 > 7 && a.orig === P.facing) {
      a.state = 3;
      a.d1 = 4; a.d2 = 8; a.d3 = 1;
      play_se(se_id("SE_WARP_IN", 39));
    }
  } else {
    // pokefirered/src/field_effect.c:2397 TeleportFieldEffectTask3
    a.d1 = a.d1 - 1;
    if (a.d1 <= 0) {
      a.d1 = 4;
      P.facing = SPIN_NEXT[P.facing] ?? "down";
    }
    a.d4 = a.d4 + a.d3;
    P.spriteYOffset = -a.d4;
    a.d2 = a.d2 - 1;
    if (a.d2 <= 0) {
      a.d2 = 4;
      if (a.d3 < 8) a.d3 = a.d3 * 2;
    }
    if (a.d4 > 8) P.oamPriority = 1;
    if (a.d4 >= 0xa8) {
      P.spriteYOffset = 0;
      P.oamPriority = null;
      P.setVisible(false);
      return true;
    }
  }
  return false;
}

// Lua: field_effects.lua:998 -- pokefirered/src/field_effect.c:2446 FieldCallback_TeleportIn
FieldEffects.startTeleportIn = function (onDone?: () => void): any {
  const P = fly_player();
  // pokefirered/src/field_effect.c:2464 TeleportInFieldEffectTask1
  const anim = {
    kind: "teleport_in",
    state: 2,
    timer: 0,
    y2: -(PLAYER_SPRITE_Y + 16),
    d1: 8, d2: 1,
    onDone,
  };
  if (P) {
    P.spriteYOffset = anim.y2;
    P.oamPriority = 1;
    P.setVisible(true);
  }
  play_se(se_id("SE_WARP_IN", 39));
  insert(FieldEffects._anims, anim);
  return anim;
};

// Lua: field_effects.lua:1019
function step_teleport_in(a: any): boolean {
  const P = fly_player();
  if (!P) return true;
  if (a.state === 2) {
    // pokefirered/src/field_effect.c:2483 TeleportInFieldEffectTask2
    a.y2 = a.y2 + a.d1;
    if (a.y2 >= -8) P.oamPriority = null; else P.oamPriority = 1;
    if (a.y2 >= -0x30 && a.d1 > 1 && mod(a.y2, 2) === 0) a.d1 = a.d1 - 1;
    a.d2 = a.d2 - 1;
    if (a.d2 === 0) {
      a.d2 = 4;
      P.facing = SPIN_NEXT[P.facing] ?? "down";
    }
    if (a.y2 >= 0) {
      a.y2 = 0;
      a.state = 3;
      a.d1 = 1; a.d2 = 0;
    }
    P.spriteYOffset = a.y2;
  } else {
    // pokefirered/src/field_effect.c:2522 TeleportInFieldEffectTask3
    P.spriteYOffset = 0;
    a.d1 = a.d1 - 1;
    if (a.d1 === 0) {
      P.facing = SPIN_NEXT[P.facing] ?? "down";
      a.d1 = 8;
      a.d2 = a.d2 + 1;
      // pokefirered/src/field_effect.c:2530
      if (a.d2 > 4 && P.facing === "down") return true;
    }
  }
  return false;
}

// Lua: field_effects.lua:1053
function draw_bird(b: any, camX: number, camY: number): void {
  if (b.invisible) return;
  const sheet = load_sheet("fly_bird", FLY_BIRD_W, FLY_BIRD_H, FLY_BIRD_FRAMES);
  const q = sheet ? sheet.quads[b.anim] : null;
  const P = fly_player();
  if (!(q && P)) return;
  const cx = P.px - camX - PLAYER_SPRITE_X + 8 + b.x + b.x2;
  const cy = P.py - camY - PLAYER_SPRITE_Y + b.y + b.y2;
  G.setColor(1, 1, 1, 1);
  const a = b.aff;
  if (!a) {
    G.draw(sheet!.image, q, cx - FLY_BIRD_W / 2, cy - FLY_BIRD_H / 2);
    return;
  }
  const s = a.scale / 256;
  const rot = mod(a.rot, 65536);
  if (rot === 0 && s > 2) {
    const half = FLY_BIRD_W / s;
    const u0 = FLY_BIRD_W / 2 - half;
    const [iw, ih] = sheet!.image.getDimensions();
    FieldEffects._birdQuad = FieldEffects._birdQuad ?? G.newQuad(0, 0, 1, 1, iw, ih);
    FieldEffects._birdQuad.setViewport(u0, b.anim * FLY_BIRD_H + u0, half * 2, half * 2, iw, ih);
    G.draw(sheet!.image, FieldEffects._birdQuad, cx, cy, 0, s, s, half, half);
  } else {
    G.draw(sheet!.image, q, cx, cy, -rot * 2 * Math.PI / 65536, s, s,
      FLY_BIRD_W / 2, FLY_BIRD_H / 2);
  }
}

// Lua: field_effects.lua:1083 -- Sweet scent aroma waves
FieldEffects.startSweetScent = function (onDone?: () => void): void {
  const anim = {
    kind: "sweet_scent",
    timer: 0,
    maxDur: 50,
    radius: 0,
    onDone,
  };
  insert(FieldEffects._anims, anim);
};

// Lua: field_effects.lua:1103 -- pokefirered/src/field_effect.c:3946 (gPaletteFade.y steps by 2)
const BG_FLASH_FRAMES = 8;

// Lua: field_effects.lua:1105
FieldEffects.startBgFlash = function (duration?: unknown): any {
  const anim = {
    kind: "bg_flash",
    timer: 0,
    maxDur: Math.max(1, Math.floor(tonumber(duration) ?? BG_FLASH_FRAMES)),
  };
  insert(FieldEffects._anims, anim);
  return anim;
};

// Lua: field_effects.lua:1117
FieldEffects.bgFlashAlpha = function (): number {
  for (const [, anim] of ipairs<any>(FieldEffects._anims)) {
    if (anim.kind === "bg_flash") {
      return Math.max(0, 1.0 - (anim.timer / anim.maxDur));
    }
  }
  return 0;
};

// ------------------------------------------------- Birth Island Deoxys effects

// Lua: field_effects.lua:1132 -- pokefirered/src/field_effect.c:3722
FieldEffects.startMoveDeoxysRock = function (localId: any, x: unknown, y: unknown, framesIn?: unknown): any {
  const Objects: any = ObjectsMod;
  if (!(Objects && Objects.find)) return null;
  const eo = Objects.find(localId);
  if (!eo) return null;
  const fromX = eo.px ?? 0, fromY = eo.py ?? 0;
  const toX = (tonumber(x) ?? 0) * CELL, toY = (tonumber(y) ?? 0) * CELL;
  // Snap the home/template coords immediately, exactly like SetObjEventTemplateCoords.
  Objects.setObjectXY(localId, x, y);
  // setObjectXY snaps px/py to the destination; keep the sprite drawn where it was.
  eo.px = fromX; eo.py = fromY;
  const frames = Math.max(1, Math.floor(tonumber(framesIn) ?? 5));
  const anim = {
    kind: "deoxys_rock_move",
    localId,
    fromX,
    fromY,
    toX,
    toY,
    timer: 0,
    maxDur: frames,
    effectName: "FLDEFF_MOVE_DEOXYS_ROCK",
  };
  insert(FieldEffects._anims, anim);
  return anim;
};

// Lua: field_effects.lua:1164 -- pokefirered/src/field_effect.c:3840
FieldEffects.startDestroyDeoxysRock = function (localId: any, graphicsId?: any): any {
  const Objects: any = ObjectsMod;
  const eo = Objects && Objects.find ? Objects.find(localId) : null;
  if (!eo) return null;
  const x = eo.px ?? 0, y = eo.py ?? 0;
  graphicsId = graphicsId ?? eo.graphicsId;

  // pokefirered/src/field_effect.c:3975 CreateDeoxysRockFragments
  let originX = x - 8, originY = y - 20;
  const OwSprites = modOwSprites();
  if (OwSprites && OwSprites.getDraw) {
    const spr = OwSprites.getDraw(graphicsId);
    if (spr && spr.width && spr.height) {
      originX = x + (16 - spr.width) / 2;
      originY = y + 16 - spr.height - 4;
    }
  }

  // pokefirered/src/field_effect.c:3993 SpriteCB_DeoxysRockFragment
  const frags: LuaTable = [null];
  const dirs = seq(seq(-1, -1), seq(1, -1), seq(-1, 1), seq(1, 1)) as any[];
  for (let i = 1; i <= 4; i++) {
    frags[i] = {
      frame: i - 1,
      x: originX,
      y: originY,
      ox: originX,
      oy: originY,
      dx: dirs[i][1] * 16,
      dy: dirs[i][2] * 12,
      off: false,
    };
  }
  const anim = {
    kind: "deoxys_rock_destroy",
    localId,
    graphicsId,
    x,
    y,
    px: x,
    py: y,
    timer: 0,
    state: "shake",
    frags,
    effectName: "FLDEFF_DESTROY_DEOXYS_ROCK",
  };
  insert(FieldEffects._anims, anim);
  play_se(se_id("SE_THUNDER2", SE_THUNDER2));
  return anim;
};

// Lua: field_effects.lua:1218
const EMOTE_BASES: Record<string | number, number> = {
  [0]: 0,
  [1]: 6,
  [2]: 3,
  [3]: 9,
  [4]: 12,
  exclamation: 0,
  double_exclamation: 6,
  x: 3,
  smile: 9,
  question: 12,
  question_mark: 12,
  [0x62]: 0,
  [0x63]: 12,
  [0x64]: 3,
  [0x65]: 6,
  [0x66]: 9,
};

// Lua: field_effects.lua:1238
const RSE_EMOTE_KEYS: Record<string | number, string> = {
  [0]: "exclamation", [1]: "exclamation", [2]: "exclamation", [3]: "exclamation", [4]: "question",
  exclamation: "exclamation", double_exclamation: "exclamation", x: "exclamation", smile: "exclamation",
  question: "question", question_mark: "question", heart: "heart",
  [0x62]: "exclamation", [0x63]: "question", [0x64]: "exclamation", [0x65]: "exclamation", [0x66]: "exclamation",
};

// Lua: field_effects.lua:1246 -- pokeemerald/src/trainer_see.c:731
function start_rse_emote(spec: any, targetObj: any, emoteType: any, onDone?: () => void): any {
  const key = RSE_EMOTE_KEYS[emoteType] ?? "exclamation";
  const e = spec[key] ?? spec.exclamation;
  load_sheet(e.sheet);
  const anim = {
    kind: "emote",
    targetObj,
    timer: 0,
    maxDur: spec.frames ?? 60,
    sheet: e.sheet,
    baseFrame: e.frame ?? 0,
    frame: e.frame ?? 0,
    yOffset: 0,
    yVelocity: spec.yVelocity ?? -5,
    rse: true,
    effectName: key === "question" ? "FLDEFF_QUESTION_MARK_ICON"
      : key === "heart" ? "FLDEFF_HEART_ICON" : "FLDEFF_EXCLAMATION_MARK_ICON",
    onDone,
  };
  insert(FieldEffects._anims, anim);
  return anim;
}

// Lua: field_effects.lua:1269 -- pret FLDEFF_*_ICON / sSpriteAnimTable_Emoticons
FieldEffects.startEmote = function (targetObj: any, emoteType: any, onDone?: () => void): any {
  const rseSpec = fieldBlock().emotes;
  if (rseSpec) return start_rse_emote(rseSpec, targetObj, emoteType, onDone);
  load_sheet("emoticons", 16, 16, 15);
  const baseFrame = EMOTE_BASES[emoteType] ?? 0;
  const anim = {
    kind: "emote",
    targetObj,
    timer: 0,
    maxDur: 60, // 4 + 4 + 52 frames matching pokefirered
    baseFrame,
    frame: baseFrame,
    onDone,
  };
  insert(FieldEffects._anims, anim);
  if (emoteType === "exclamation" || emoteType === 0 || emoteType === 0x62
    || emoteType === "double_exclamation" || emoteType === 1 || emoteType === 0x65) {
    const Audio = modAudio();
    if (Audio && Audio.playSe) {
      Audio.playSe(se_id("SE_PIN", 21));
    }
  }
  return anim;
};

// Lua: field_effects.lua:1295 -- pret FLDEFF_EXCLAMATION_MARK_ICON / sAnim_ExclamationMark
FieldEffects.startExclamation = function (targetObj: any, onDone?: () => void): any {
  return FieldEffects.startEmote(targetObj, "exclamation", onDone);
};

// Lua: field_effects.lua:1300 -- Alias for vs_seeker and other callers
FieldEffects.spawnEmoticon = function (targetObj: any, emoteType: any, onDone?: () => void): any {
  return FieldEffects.startEmote(targetObj, emoteType, onDone);
};

// Lua: field_effects.lua:1305 -- pokefirered/include/constants/metatile_behaviors.h:14
const MB_POND_WATER = 0x10;
// pokefirered/include/constants/metatile_behaviors.h:20
const MB_PUDDLE = 0x16;
const MB_SHALLOW_WATER = 0x17;

// Lua: field_effects.lua:1311 -- sAnim_Splash_0
const ANIM_SPLASH: LuaTable = seq(seq(0, 4), seq(1, 4));
// sAnim_Splash_1
const ANIM_FEET_IN_FLOWING_WATER: LuaTable = seq(
  seq(0, 4), seq(1, 4), seq(0, 6), seq(1, 6), seq(0, 8), seq(1, 8), seq(0, 6), seq(1, 6),
);
// sAnim_Ripple
const ANIM_RIPPLE: LuaTable = seq(
  seq(0, 12), seq(1, 9), seq(2, 9), seq(3, 9), seq(0, 9), seq(1, 9), seq(2, 11), seq(4, 11),
);
// pokefirered/src/data/field_effects/field_effect_objects.h:295
const ANIM_GROUND_IMPACT_DUST: LuaTable = seq(seq(0, 8), seq(1, 8), seq(2, 8));

// Lua: field_effects.lua:1323
const SE_PUDDLE = 63;

// Lua: field_effects.lua:1325
function anim_frame(sq: LuaTable, t: number, loop?: boolean): number | null {
  let total = 0;
  for (let i = 1; i <= len(sq); i++) total = total + sq[i][2];
  if (total <= 0) return null;
  if (loop) {
    t = mod(t, total);
  } else if (t >= total) {
    return null;
  }
  let acc = 0;
  for (let i = 1; i <= len(sq); i++) {
    acc = acc + sq[i][2];
    if (t < acc) return sq[i][1];
  }
  return sq[len(sq)][1];
}

// Lua: field_effects.lua:1342
function play_se(id: any): void {
  const Audio = modAudio();
  if (Audio && Audio.playSe) Audio.playSe(id);
}

// ------------------------------------------------- setfieldeffectargument plumbing
// Lua: field_effects.lua:1350 -- pokefirered/src/scrcmd.c:2051
FieldEffects.setFieldEffectArgument = function (argNumIn: unknown, value: unknown): boolean {
  const argNum = Math.floor(tonumber(argNumIn) ?? -1);
  if (argNum < 0 || argNum > 15) return false;
  FieldEffects._fieldEffectArguments[argNum] = Math.floor(tonumber(value) ?? 0);
  return true;
};

// Lua: field_effects.lua:1357
FieldEffects.fieldEffectArgument = function (argNum: number, dflt?: any): any {
  const v = FieldEffects._fieldEffectArguments[argNum];
  if (v == null) return dflt;
  return v;
};

// Lua: field_effects.lua:1363
FieldEffects.clearFieldEffectArguments = function (): void {
  FieldEffects._fieldEffectArguments = {};
};

// Lua: field_effects.lua:1367
function resolve_waiters(): void {
  const pending = FieldEffects._waiters;
  if (len(pending) === 0) return;
  const keep: LuaTable = [null];
  for (let i = 1; i <= len(pending); i++) {
    const w = pending[i];
    if (FieldEffects.isFieldEffectActive(w.id)) {
      keep[len(keep) + 1] = w;
    } else if (w.done) {
      w.done();
    }
  }
  FieldEffects._waiters = keep;
}

// Lua: field_effects.lua:1382
function ground_state(): any {
  let g = FieldEffects._ground;
  if (!g) {
    g = { inShallowFlowingWater: false, inHotSprings: false, moving: false };
    FieldEffects._ground = g;
  }
  return g;
}

// Lua: field_effects.lua:1391
function behavior_at(cx: number, cy: number): any {
  const Collision: any = CollisionMod;
  if (!(Collision && Collision.behavior)) return null;
  return Collision.behavior(cx, cy);
}

// Lua: field_effects.lua:1397
function is_hot_springs(beh: any): boolean {
  const Collision: any = CollisionMod;
  if (Collision && Collision.isHotSprings) return Collision.isHotSprings(beh);
  return false;
}

// Lua: field_effects.lua:1404 -- pokefirered/src/event_object_movement.c:8143
function flag_shallow_flowing_water(g: any, cur: any, prev: any): boolean {
  if (cur === MB_SHALLOW_WATER && prev === MB_SHALLOW_WATER) {
    if (!g.inShallowFlowingWater) {
      g.inShallowFlowingWater = true;
      return true;
    }
  } else {
    g.inShallowFlowingWater = false;
  }
  return false;
}

// Lua: field_effects.lua:1417 -- pokefirered/src/event_object_movement.c:8163
function flag_puddle(cur: any, prev: any): boolean {
  return cur === MB_PUDDLE && prev === MB_PUDDLE;
}

// Lua: field_effects.lua:1422 -- pokefirered/src/event_object_movement.c:8172
function flag_ripple(cur: any): boolean {
  return cur === MB_POND_WATER || cur === MB_PUDDLE;
}

// Lua: field_effects.lua:1427 -- pokefirered/src/event_object_movement.c:8196
function flag_hot_springs(g: any, cur: any, prev: any): boolean {
  if (is_hot_springs(cur) && is_hot_springs(prev)) {
    if (!g.inHotSprings) {
      g.inHotSprings = true;
      return true;
    }
  } else {
    g.inHotSprings = false;
  }
  return false;
}

// Lua: field_effects.lua:1439
function has_anim(kind: string): boolean {
  for (const [, anim] of ipairs<any>(FieldEffects._anims)) {
    if (anim.kind === kind) return true;
  }
  return false;
}

// Lua: field_effects.lua:1446
const GROUND_KINDS: Record<string, boolean> = { splash: true, feet_water: true, hot_springs: true, ripple: true };

// Lua: field_effects.lua:1448
function clear_ground_anims(): void {
  const keep: LuaTable = [null];
  for (const [, anim] of ipairs<any>(FieldEffects._anims)) {
    if (!GROUND_KINDS[anim.kind]) keep[len(keep) + 1] = anim;
  }
  FieldEffects._anims = keep;
}

// Lua: field_effects.lua:1457 -- GroundEffect_StepOnPuddle
function start_splash(): void {
  load_sheet("splash", 16, 8, 2);
  insert(FieldEffects._anims, { kind: "splash", timer: 0, frame: 0 });
  play_se(se_id("SE_PUDDLE", SE_PUDDLE));
}

// Lua: field_effects.lua:1464 -- GroundEffect_FlowingWater
function start_feet_in_flowing_water(): void {
  if (has_anim("feet_water")) return;
  load_sheet("splash", 16, 8, 2);
  insert(FieldEffects._anims, { kind: "feet_water", timer: 0, frame: 0 });
}

// Lua: field_effects.lua:1471 -- GroundEffect_Ripple
function start_ripple(cx: number, cy: number): void {
  load_sheet("ripple", 16, 16, 5);
  insert(FieldEffects._anims,
    { kind: "ripple", timer: 0, frame: 0, cx, cy });
}
FieldEffects.startRipple = start_ripple;

// Lua: field_effects.lua:1479 -- GroundEffect_HotSprings
function start_hot_springs(): void {
  if (has_anim("hot_springs")) return;
  load_sheet("hot_springs_water", 16, 16, 1);
  insert(FieldEffects._anims, { kind: "hot_springs", timer: 0, frame: 0 });
}

// Lua: field_effects.lua:1486 -- pokefirered/src/field_effect_helpers.c:1112
FieldEffects.startDust = function (cx: number, cy: number): void {
  load_sheet("ground_impact_dust", 16, 8, 3);
  insert(FieldEffects._anims, { kind: "dust", timer: 0, frame: 0, cx, cy });
};

// Lua: field_effects.lua:1492 -- pokefirered/src/event_object_movement.c:8220
function flag_land_on_normal_ground(g: any, cur: any): boolean {
  const Collision: any = CollisionMod;
  if (Collision && Collision.isGrass && Collision.isGrass(g.cx, g.cy)) return false;
  if (cur === MB_PUDDLE || cur === MB_SHALLOW_WATER) return false;
  if (Collision && Collision.isSurfable && Collision.isSurfable(cur)) return false;
  return true;
}

// Lua: field_effects.lua:1501 -- GetAllGroundEffectFlags_OnSpawn
function ground_effects_on_spawn(g: any, cur: any, prev: any): void {
  if (flag_shallow_flowing_water(g, cur, prev)) start_feet_in_flowing_water();
  if (flag_hot_springs(g, cur, prev)) start_hot_springs();
  const R = rse();
  if (R) R.onSpawn(g, cur, prev);
}

// Lua: field_effects.lua:1508
const TRACK_DIRS: Record<string, number> = { down: 1, up: 2, left: 3, right: 4 };

// Lua: field_effects.lua:1511 -- pokeemerald/src/event_object_movement.c:7480
function start_tracks(g: any, prev: any): void {
  if (!fx_manifest() || prev == null) return;
  const P: any = PlayerMod;
  if (!P || truthy(P.biking)) return;
  let name: string;
  if (prev === MB.id("DEEP_SAND")) {
    name = "deep_sand_footprints";
  } else if (prev === MB.id("SAND") || prev === MB.id("FOOTPRINTS")) {
    name = "sand_footprints";
  } else {
    return;
  }
  const o = FieldEffects.manifestObject(name);
  if (!(o && load_sheet(name))) return;
  // pokeemerald/src/event_object_movement.c:7889
  const sq = o.anims ? o.anims[(TRACK_DIRS[P.facing] ?? 1) + 1] : null;
  const cmd = (sq && sq[1]) || seq<any>("frame", 0, 1, false, false);
  insert(FieldEffects._anims, {
    kind: "tracks", sheet: name, timer: 0, cx: g.px, cy: g.py,
    frame: cmd[2] ?? 0, hflip: cmd[4] === true, vflip: cmd[5] === true, visible: true,
  });
}

// Lua: field_effects.lua:1536 -- GetAllGroundEffectFlags_OnBeginStep
function ground_effects_on_begin_step(g: any, cur: any, prev: any): void {
  start_tracks(g, prev);
  if (flag_shallow_flowing_water(g, cur, prev)) start_feet_in_flowing_water();
  if (flag_puddle(cur, prev)) start_splash();
  if (flag_hot_springs(g, cur, prev)) start_hot_springs();
  const R = rse();
  if (R) R.onBeginStep(g, cur, prev);
}

// Lua: field_effects.lua:1546 -- GetAllGroundEffectFlags_OnFinishStep
function ground_effects_on_finish_step(g: any, cur: any, jumped: any, landingJump: any): void {
  // pokefirered/src/event_object_movement.c:5343 ShiftStillObjectEventCoords (previous := current)
  const prev = cur;
  if (flag_shallow_flowing_water(g, cur, prev)) start_feet_in_flowing_water();
  // pokefirered/src/event_object_movement.c:8715 FilterOutStepOnPuddleGroundEffectIfJumping
  if (flag_puddle(cur, prev) && !jumped) start_splash();
  if (flag_ripple(cur)) start_ripple(g.cx, g.cy);
  if (flag_hot_springs(g, cur, prev)) start_hot_springs();
  const R = rse();
  if (R) {
    R.onFinishStep(g, cur, jumped, landingJump);
    return;
  }
  // pokefirered/src/event_object_movement.c:8638
  if (landingJump && flag_land_on_normal_ground(g, cur)) FieldEffects.startDust(g.cx, g.cy);
}

// Lua: field_effects.lua:1564 -- DoGroundEffects_OnSpawn / OnBeginStep / OnFinishStep
FieldEffects.groundEffects = function (): void {
  const P: any = PlayerMod;
  if (!P) return;
  const moving = truthy(P.moving) ? true : false;
  let cx: any, cy: any;
  if (moving) {
    cx = P.targetX ?? P.cellX; cy = P.targetY ?? P.cellY;
  } else {
    cx = P.cellX; cy = P.cellY;
  }
  if (cx == null || cy == null) return;
  const g = ground_state();
  const mapId = MapMod ? MapMod.current : undefined;
  if (mapId !== g.mapId) {
    // pokefirered/src/event_object_movement.c:1934 ResetObjectEventFldEffData
    g.mapId = mapId;
    g.inShallowFlowingWater = false;
    g.inHotSprings = false;
    g.cx = null; g.cy = null; g.px = null; g.py = null;
    g.moving = false;
    clear_ground_anims();
    const R = rse();
    if (R) R.clearGround();
  }
  if (moving === g.moving && cx === g.cx && cy === g.cy) return;

  let px = cx, py = cy;
  if (moving || g.moving) { px = P.prevCellX ?? cx; py = P.prevCellY ?? cy; }
  const wasMoving = g.moving;
  const wasPx = g.px;
  const wasJump = g.jumped;
  const wasLanding = g.landingJump;
  g.moving = moving;
  g.cx = cx; g.cy = cy;
  g.px = px; g.py = py;
  g.jumped = moving ? (truthy(P.jumping) ? true : false) : false;
  // pokefirered/src/event_object_movement.c:6646
  g.landingJump = (g.jumped && !(truthy(P.surfHopping) || truthy(P.dismounting))) || false;

  if (wasMoving && moving && wasPx != null) {
    g.cx = px; g.cy = py;
    ground_effects_on_finish_step(g, behavior_at(px, py), wasJump, wasLanding);
    g.cx = cx; g.cy = cy;
  }

  // pokefirered/src/event_object_movement.c:8062 ObjectEventUpdateMetatileBehaviors
  const cur = behavior_at(cx, cy);
  const prev = behavior_at(px, py);

  if (moving && !wasMoving) {
    ground_effects_on_begin_step(g, cur, prev);
  } else if (wasMoving && !moving) {
    ground_effects_on_finish_step(g, cur, wasJump, wasLanding);
  } else if (wasMoving && moving) {
    ground_effects_on_begin_step(g, cur, prev);
  } else {
    // pokefirered/src/event_object_movement.c:1934 ResetObjectEventFldEffData
    g.inShallowFlowingWater = false;
    g.inHotSprings = false;
    clear_ground_anims();
    ground_effects_on_spawn(g, cur, prev);
  }
};

// ---------------------------------------------------------------- Step & Update
// Lua: field_effects.lua:1630
FieldEffects.step = function (): void {
  FieldEffects.groundEffects();
  WarpArrow.step();
  // Tall grass update
  const fx = FieldEffects._fx;
  if (fx && !fx.done && fx.seq) {
    // pokeemerald/src/field_effect_helpers.c:420
    fx.timer = fx.timer + 1;
    const cur = fx.seq[fx.step];
    if (cur && fx.timer >= cur[2]) {
      fx.timer = 0;
      if (fx.step < len(fx.seq)) {
        fx.step = fx.step + 1;
        fx.frame = fx.seq[fx.step][1];
      } else if (fx.leaving) {
        fx.done = true;
        FieldEffects._fx = null;
      }
    }
  } else if (fx && !fx.done) {
    fx.timer = fx.timer + 1;
    if (fx.timer >= FRAME_DUR) {
      fx.timer = 0;
      fx.step = fx.step + 1;
      if (fx.step >= len(RUSTLE)) {
        if (fx.leaving) {
          fx.done = true;
          FieldEffects._fx = null;
        } else {
          fx.step = len(RUSTLE) - 1;
        }
      }
    }
  }

  // Surfing blob clock (48 ticks per frame * 2 frames = 96 ticks per loop)
  FieldEffects._surfClock = mod(FieldEffects._surfClock + 1, 96);

  // Update active transient animations
  const active: LuaTable = [null];
  for (const [, anim] of ipairs<any>(FieldEffects._anims)) {
    anim.timer = anim.timer + 1;
    let finished = false;

    if (anim.kind === "cut_tree") {
      // Animate tree object through frames 0..3 (6 ticks per frame)
      const frame = Math.min(3, Math.floor(anim.timer / 6));
      if (anim.targetObj) {
        anim.targetObj.customFrame = frame;
      }
      // Update scattering leaf particles with gravity
      for (const [, p] of ipairs<any>(anim.particles ?? {})) {
        p.x = p.x + p.vx;
        p.y = p.y + p.vy;
        p.vy = p.vy + 0.12; // gravity
        p.frame = mod(Math.floor(anim.timer / 4), 4);
      }
      if (anim.timer >= anim.maxDur) {
        finished = true;
      }
    } else if (anim.kind === "cut_grass_scatter") {
      for (const [, p] of ipairs<any>(anim.particles ?? {})) {
        p.x = p.x + p.vx;
        p.y = p.y + p.vy;
        p.vy = p.vy + 0.12;
        p.frame = mod(Math.floor(anim.timer / 4), 4);
      }
      if (anim.timer >= anim.maxDur) {
        finished = true;
      }
    } else if (anim.kind === "rock_smash") {
      const frame = Math.min(3, Math.floor(anim.timer / 6));
      if (anim.targetObj) {
        anim.targetObj.customFrame = frame;
      }
      for (const [, p] of ipairs<any>(anim.particles ?? {})) {
        p.x = p.x + p.vx;
        p.y = p.y + p.vy;
        p.vy = p.vy + 0.15; // gravity
        p.frame = mod(Math.floor(anim.timer / 4), 4);
      }
      if (anim.timer >= anim.maxDur) {
        finished = true;
      }
    } else if (anim.kind === "flash" || anim.kind === "bg_flash") {
      anim.alpha = Math.max(0, 1.0 - (anim.timer / anim.maxDur));
      if (anim.timer >= anim.maxDur) {
        finished = true;
      }
    } else if (anim.kind === "flash_level") {
      // pokefirered/src/field_screen_effect.c:119
      const FieldView = modFieldView();
      if (!FieldView) {
        finished = true;
      } else if (anim.state === 2) {
        FieldView.setFlashLevel(anim.level);
        finished = true;
      } else {
        FieldView.setFlashRadius(anim.radius);
        if (anim.state === 0) {
          anim.state = 1;
        } else {
          anim.state = 0;
          anim.radius = anim.radius + anim.delta;
          if (anim.radius > anim.dest) {
            if (anim.clear) {
              anim.state = 2;
            } else {
              FieldView.setFlashLevel(anim.level);
              finished = true;
            }
          }
        }
      }
    } else if (anim.kind === "camera_shake") {
      const FieldView = modFieldView();
      if (!FieldView) {
        finished = true;
      } else if (anim.amp === 0) {
        // pokefirered/src/field_camera.c:513
        FieldView.setCameraPanning(0, 0);
        finished = true;
      } else {
        FieldView.setCameraPanning(0, anim.amp);
        anim.amp = -anim.amp;
        anim.ticks = anim.ticks + 1;
        if (mod(anim.ticks, 4) === 0) {
          anim.amp = Math.floor(anim.amp / 2);
        }
      }
    } else if (anim.kind === "fly_out") {
      finished = step_fly_out(anim);
    } else if (anim.kind === "fly_in") {
      finished = step_fly_in(anim);
    } else if (anim.kind === "teleport_out") {
      finished = step_teleport_out(anim);
    } else if (anim.kind === "teleport_in") {
      finished = step_teleport_in(anim);
    } else if (anim.kind === "sweet_scent") {
      anim.radius = (anim.timer / anim.maxDur) * 120;
      if (anim.timer >= anim.maxDur) {
        finished = true;
      }
    } else if (anim.rse && anim.kind === "emote") {
      // pokeemerald/src/trainer_see.c:757
      anim.yOffset = anim.yOffset + anim.yVelocity;
      if (anim.yOffset !== 0) {
        anim.yVelocity = anim.yVelocity + 1;
      } else {
        anim.yVelocity = 0;
      }
      if (anim.timer >= anim.maxDur) {
        finished = true;
      }
    } else if (anim.kind === "emote" || anim.kind === "exclamation") {
      const base = anim.baseFrame ?? 0;
      if (anim.timer < 4) {
        anim.frame = base;
      } else if (anim.timer < 8) {
        anim.frame = base + 1;
      } else {
        anim.frame = base + 2;
      }
      if (anim.timer >= anim.maxDur) {
        finished = true;
      }
    } else if (anim.kind === "splash") {
      // pokefirered/src/field_effect_helpers.c:626 UpdateSplashFieldEffect
      const frame = anim_frame(ANIM_SPLASH, anim.timer - 1, false);
      if (frame != null) anim.frame = frame; else finished = true;
    } else if (anim.kind === "dust") {
      // pokefirered/src/field_effect_helpers.c:1369
      const frame = anim_frame(ANIM_GROUND_IMPACT_DUST, anim.timer - 1, false);
      if (frame != null) anim.frame = frame; else finished = true;
    } else if (anim.kind === "feet_water") {
      // pokefirered/src/field_effect_helpers.c:707 UpdateFeetInFlowingWaterFieldEffect
      const g = FieldEffects._ground;
      if (!(g && g.inShallowFlowingWater)) {
        finished = true;
      } else {
        anim.frame = anim_frame(ANIM_FEET_IN_FLOWING_WATER, anim.timer - 1, true) ?? 0;
        if (g.cx != null && (g.cx !== anim.cx || g.cy !== anim.cy)) {
          anim.cx = g.cx; anim.cy = g.cy;
          play_se(se_id("SE_PUDDLE", SE_PUDDLE));
        }
      }
    } else if (anim.kind === "hot_springs") {
      // pokefirered/src/field_effect_helpers.c:777 UpdateHotSpringsWaterFieldEffect
      const g = FieldEffects._ground;
      if (!(g && g.inHotSprings)) finished = true;
    } else if (anim.kind === "deoxys_rock_move") {
      // pokefirered/src/field_effect.c:3745 -- linear sprite lerp over maxDur frames.
      const t = Math.min(1, anim.timer / anim.maxDur);
      const Objects: any = ObjectsMod;
      const eo = Objects && Objects.find ? Objects.find(anim.localId) : null;
      if (eo) {
        eo.px = anim.fromX + (anim.toX - anim.fromX) * t;
        eo.py = anim.fromY + (anim.toY - anim.fromY) * t;
      }
      if (anim.timer >= anim.maxDur) {
        if (eo) {
          eo.px = anim.toX; eo.py = anim.toY;
          // pret ShiftStillObjectEventCoords + triggerGroundEffectsOnStop.
          if (Objects.copyObjectXYToPerm) Objects.copyObjectXYToPerm(anim.localId);
        }
        finished = true;
      }
    } else if (anim.kind === "deoxys_rock_destroy") {
      // pokefirered/src/field_effect.c:3860 DestroyDeoxysRockEffect_*
      const FieldView = modFieldView();
      if (anim.state === "shake") {
        // Task_DeoxysRockCameraShake (data[7]==0): full amplitude, sign flips every other frame.
        if (FieldView && FieldView.setCameraPanning) {
          FieldView.setCameraPanning(0, (mod(Math.floor(anim.timer / 2), 2) === 0) ? 4 : -4);
        }
        // DestroyDeoxysRockEffect_RockFragments: `if (++tTimer > 120)`.
        if (anim.timer > 120) {
          const Objects: any = ObjectsMod;
          const eo = Objects && Objects.find ? Objects.find(anim.localId) : null;
          if (eo) {
            eo.px = anim.x; eo.py = anim.y;
            eo.invisible = true;
            eo.hidden = true;
            eo.visible = false;
          }
          FieldEffects.startBgFlash();
          play_se(se_id("SE_THUNDER", SE_THUNDER));
          anim.state = "shatter";
          anim.timer = 0;
          anim.amp = 4;
        }
      } else if (anim.state === "shatter") {
        // The shards fly out while the shake decays.
        for (const [, f] of ipairs<any>(anim.frags)) {
          if (!f.off) {
            f.x = f.x + f.dx;
            f.y = f.y + f.dy;
            if (Math.abs(f.x - f.ox) > FRAG_TRAVEL_X
              || Math.abs(f.y - f.oy) > FRAG_TRAVEL_Y) {
              f.off = true;
            }
          }
        }
        if (anim.timer > 0 && mod(anim.timer, 21) === 0 && anim.amp > 0) {
          anim.amp = anim.amp - 1;
        }
        if (FieldView && FieldView.setCameraPanning) {
          FieldView.setCameraPanning(0,
            (mod(anim.timer, 2) === 0) ? anim.amp : -anim.amp);
        }
        if (anim.amp <= 0) {
          if (FieldView && FieldView.setCameraPanning) {
            FieldView.setCameraPanning(0, 0);
          }
          const Objects: any = ObjectsMod;
          if (Objects && Objects.removeObject) Objects.removeObject(anim.localId);
          finished = true;
        }
      }
    } else if (anim.kind === "tracks") {
      // pokeemerald/src/field_effect_helpers.c:615
      if (anim.timer > 41) anim.visible = !anim.visible;
      if (anim.timer >= 57) finished = true;
    } else if (anim.kind === "ripple") {
      // pokefirered/src/field_effect_helpers.c:737 FldEff_Ripple
      const frame = anim_frame(ANIM_RIPPLE, anim.timer - 1, false);
      if (frame != null) anim.frame = frame; else finished = true;
    }

    if (finished) {
      if (anim.onDone) anim.onDone();
    } else {
      insert(active, anim);
    }
  }
  FieldEffects._anims = active;

  const R = rse();
  if (R) R.step();

  resolve_waiters();

  const Heal = modHeal();
  if (Heal && Heal.step) Heal.step();
  const SM = modShowMon();
  if (SM && SM.step) SM.step();
};

// ---------------------------------------------------------------- Drawing

// Lua: field_effects.lua:1923 -- Draw behind player (Surf blob, tall grass bottom, etc.)
FieldEffects.drawBehind = function (camXIn?: number, camYIn?: number): void {
  const camX = camXIn ?? 0, camY = camYIn ?? 0;
  const R = rse();
  if (R) R.drawBehind(camX, camY);
  if (!R) drawFrlgReflections(camX, camY);

  // 1) Surfing water mount (pret FLDEFF_SURF_BLOB)
  const P: any = PlayerMod;
  if (P && (truthy(P.surfing) || truthy(P.surfHopping) || truthy(P.dismounting))) {
    const surfSheet = load_sheet("surf_blob", 32, 32, 6);
    if (surfSheet) {
      const facing = P.facing ?? "down";
      const step = mod(Math.floor(FieldEffects._surfClock / 48), 2);
      let frameIdx = 0;
      let flip = false;

      const blob = surfSheet.frames < 6 && FieldEffects.manifestObject("surf_blob");
      if (blob && blob.anims) {
        // pokeemerald/src/data/field_effects/field_effect_objects.h:203
        const sq = blob.anims[({ down: 1, up: 2, left: 3, right: 4 } as Record<string, number>)[facing] ?? 1];
        const cmd = sq ? sq[1] : null;
        frameIdx = (cmd && cmd[2]) ?? 0;
        flip = (cmd && cmd[4] === true) || false;
      } else if (facing === "down") {
        frameIdx = 0 + step;
      } else if (facing === "up") {
        frameIdx = 2 + step;
      } else if (facing === "left") {
        frameIdx = 4 + step;
      } else if (facing === "right") {
        frameIdx = 4 + step;
        flip = true;
      }

      const q = surfSheet.quads[frameIdx];
      if (q) {
        let sx: number, sy: number;
        if (truthy(P.surfHopping)) {
          // Player is hopping onto water: blob is in position on the destination tile
          sx = (P.targetX ?? P.cellX) * CELL - camX - 8;
          sy = (P.targetY ?? P.cellY) * CELL - camY - 8;
        } else if (truthy(P.dismounting)) {
          // Player is hopping off water to land: blob remains at origin tile
          sx = P.cellX * CELL - camX - 8;
          sy = P.cellY * CELL - camY - 8;
        } else {
          const bob = (!truthy(P.moving) && !truthy(P.jumping)) ? ((step === 1) ? -1 : 0) : 0;
          sx = P.px - camX - 8;
          sy = P.py - camY - 8 + bob;
        }

        G.setColor(1, 1, 1, 1);
        if (flip) {
          G.draw(surfSheet.image, q, sx + 32, sy, 0, -1, 1);
        } else {
          G.draw(surfSheet.image, q, sx, sy);
        }
      }
    }
  }

  // 2) Tall grass base pad
  const fx = FieldEffects._fx;
  if (fx) {
    const sheet = fx.sheet ? load_sheet(fx.sheet) : load_sheet("tall_grass", 16, 16, 5);
    if (sheet) {
      const frameIdx = grass_frame(fx);
      const q = sheet.quads[frameIdx];
      if (q) {
        const sx = fx.cx * CELL - camX;
        const sy = fx.cy * CELL - camY;
        G.setColor(1, 1, 1, 1);
        G.draw(sheet.image, q, sx, sy);
      }
    }
  }

  // pokefirered/src/event_object_movement.c:9404 DoRippleFieldEffect
  for (const [, anim] of ipairs<any>(FieldEffects._anims)) {
    if (anim.kind === "tracks" && anim.visible) {
      const sheet = load_sheet(anim.sheet);
      const q = sheet ? sheet.quads[anim.frame ?? 0] : null;
      if (q && anim.cx != null && anim.cy != null) {
        const sx = anim.cx * CELL - camX;
        const sy = anim.cy * CELL - camY;
        G.setColor(1, 1, 1, 1);
        G.draw(sheet!.image, q, sx + (anim.hflip ? CELL : 0), sy + (anim.vflip ? CELL : 0), 0,
          anim.hflip ? -1 : 1, anim.vflip ? -1 : 1);
      }
    } else if (anim.kind === "ripple") {
      const sheet = load_sheet("ripple", 16, 16, 5);
      const q = sheet ? sheet.quads[anim.frame ?? 0] : null;
      if (q) {
        const sx = anim.cx * CELL - camX;
        const sy = anim.cy * CELL + 6 - camY;
        G.setColor(1, 1, 1, 1);
        G.draw(sheet!.image, q, sx, sy);
      }
    }
  }
};

// Lua: field_effects.lua:2026 -- ground/feet field effects as sorted actors
FieldEffects.collectActors = function (actors: LuaTable): void {
  if (!actors) return;

  // 1) Tall grass feet cover (player active effect)
  const fx = FieldEffects._fx;
  const sheetGrass = load_sheet("tall_grass", 16, 16, 5);
  const fxSheet = (fx && fx.sheet ? load_sheet(fx.sheet) : null) || sheetGrass;
  if (fx && fxSheet && fxSheet.quadsFront) {
    const P: any = PlayerMod;
    const playerPy = P ? P.py : null;
    let drawCover = true;
    if (playerPy != null) {
      const feetY = playerPy + CELL;
      const grassTop = fx.cy * CELL;
      const grassBot = grassTop + CELL;
      if (feetY < grassTop + FEET_H || feetY > grassBot + 2) {
        drawCover = false;
      }
    }
    if (drawCover) {
      const frameIdx = grass_frame(fx);
      const q = fxSheet.quadsFront[frameIdx];
      if (q) {
        const gx = fx.cx * CELL;
        const gy = fx.cy * CELL + (16 - FEET_H);
        actors[len(actors) + 1] = {
          kind: "field_effect_grass",
          elevation: P ? P.elevation ?? 3 : 3,
          sortY: fx.cy * CELL + 0.5,
          x: gx,
          y: gy,
          i: 90000,
          draw: (_s: any, camX: number, camY: number) => {
            G.setColor(1, 1, 1, 1);
            G.draw(fxSheet.image, q, gx - camX, gy - camY);
          },
        };
      }
    }
  }

  // 2) Grass feet cover for NPCs standing on grass
  const Objects: any = ObjectsMod;
  const Collision: any = CollisionMod;
  if (Objects && Objects.forDraw && Collision && Collision.isGrass && sheetGrass && sheetGrass.quadsFront) {
    const qStatic = sheetGrass.quadsFront[4];
    if (qStatic) {
      for (const [, eo] of ipairs<any>(Objects.forDraw())) {
        const cx = eo.cellX;
        const cy = eo.cellY;
        const isPlayerFx = fx && fx.cx === cx && fx.cy === cy;
        if (!isPlayerFx && cx != null && cy != null && Collision.isGrass(cx, cy)) {
          const npcPy = eo.py ?? (cy * CELL);
          const feetY = npcPy + CELL;
          const grassTop = cy * CELL;
          const grassBot = grassTop + CELL;
          if (feetY >= grassTop + FEET_H && feetY <= grassBot + 2) {
            const gx = cx * CELL;
            const gy = cy * CELL + (16 - FEET_H);
            actors[len(actors) + 1] = {
              kind: "field_effect_npc_grass",
              elevation: eo.elevation ?? (eo.def ? eo.def.elevation : undefined) ?? 3,
              sortY: npcPy + 0.5,
              x: gx,
              y: gy,
              i: 90000 + (tonumber(eo.localId) ?? 0),
              draw: (_s: any, camX: number, camY: number) => {
                G.setColor(1, 1, 1, 1);
                G.draw(sheetGrass.image, qStatic, gx - camX, gy - camY);
              },
            };
          }
        }
      }
    }
  }

  // 3) Ground / actor attached transient animations
  const P: any = PlayerMod;
  // pokeemerald/src/field_effect_helpers.c:249
  if (P && truthy(P.jumping) && !(truthy(P.surfHopping) || truthy(P.dismounting)) && P.isVisible && P.isVisible()) {
    const sheet = load_sheet("shadow_medium");
    const q = sheet ? sheet.quads[0] : null;
    if (q) {
      const sx = P.px, sy = P.py + CELL - sheet!.fh;
      actors[len(actors) + 1] = {
        kind: "field_effect_shadow",
        elevation: P.elevation ?? 3,
        sortY: P.py - 0.5,
        x: sx,
        y: sy,
        i: 90500,
        draw: (_s: any, camX: number, camY: number) => {
          G.setColor(1, 1, 1, 1);
          G.draw(sheet!.image, q, sx - camX, sy - camY);
        },
      };
    }
  }
  for (const [idx, anim] of ipairs<any>(FieldEffects._anims)) {
    if (anim.kind === "splash" || anim.kind === "feet_water") {
      const sheet = load_sheet("splash", 16, 8, 2);
      const q = sheet && P ? sheet.quads[anim.frame ?? 0] : null;
      if (q && P) {
        const px = P.px;
        const py = P.py + FEET_H;
        actors[len(actors) + 1] = {
          kind: "field_effect_splash",
          elevation: P.elevation ?? 3,
          sortY: P.py + 0.5,
          x: px,
          y: py,
          i: 91000 + idx,
          draw: (_s: any, camX: number, camY: number) => {
            G.setColor(1, 1, 1, 1);
            G.draw(sheet!.image, q, px - camX, py - camY);
          },
        };
      }
    } else if (anim.kind === "dust") {
      const sheet = load_sheet("ground_impact_dust", 16, 8, 3);
      const q = sheet ? sheet.quads[anim.frame ?? 0] : null;
      if (q) {
        const dx = anim.cx * CELL;
        const dy = anim.cy * CELL + 8;
        actors[len(actors) + 1] = {
          kind: "field_effect_dust",
          elevation: 3,
          sortY: anim.cy * CELL + 0.5,
          x: dx,
          y: dy,
          i: 91000 + idx,
          draw: (_s: any, camX: number, camY: number) => {
            G.setColor(1, 1, 1, 1);
            G.draw(sheet!.image, q, dx - camX, dy - camY);
          },
        };
      }
    } else if (anim.kind === "hot_springs") {
      const sheet = load_sheet("hot_springs_water", 16, 16, 1);
      const q = sheet && P ? sheet.quads[0] : null;
      if (q && P) {
        const px = P.px;
        const py = P.py;
        actors[len(actors) + 1] = {
          kind: "field_effect_hot_springs",
          elevation: P.elevation ?? 3,
          sortY: P.py + 0.5,
          x: px,
          y: py,
          i: 91000 + idx,
          draw: (_s: any, camX: number, camY: number) => {
            G.setColor(1, 1, 1, 1);
            G.draw(sheet!.image, q, px - camX, py - camY);
          },
        };
      }
    } else if (anim.kind === "cut_tree") {
      const sheet = load_sheet("cut_tree", 32, 32, 4);
      const f = Math.min(3, Math.floor((anim.timer ?? 0) / 6));
      const q = sheet ? sheet.quads[f] : null;
      if (q) {
        const tx = anim.cx * CELL - 8;
        const ty = anim.cy * CELL - 16;
        actors[len(actors) + 1] = {
          kind: "field_effect_cut_tree",
          elevation: 3,
          sortY: anim.cy * CELL,
          x: tx,
          y: ty,
          i: 91000 + idx,
          draw: (_s: any, camX: number, camY: number) => {
            G.setColor(1, 1, 1, 1);
            G.draw(sheet!.image, q, tx - camX, ty - camY);
          },
        };
      }
    } else if (anim.kind === "emote" || anim.kind === "exclamation") {
      const sheet = anim.sheet ? load_sheet(anim.sheet) : load_sheet("emoticons", 16, 16, 15);
      if (sheet && sheet.quads[anim.frame]) {
        const t = anim.targetObj;
        const ox = t ? (t.px ?? (t.cellX != null ? t.cellX * CELL : null) ?? (t.x != null ? t.x * CELL : null) ?? 0) : 0;
        const oy = t ? (t.py ?? (t.cellY != null ? t.cellY * CELL : null) ?? (t.y != null ? t.y * CELL : null) ?? 0) : 0;
        const sx = ox;
        let sy = oy - 16;
        if (anim.rse) {
          // pokeemerald/src/trainer_see.c:758
          const Ow = modOwSprites();
          const gid = t ? (t.graphicsId ?? (t.def ? t.def.graphicsId : undefined)) : undefined;
          const spr = Ow && gid != null && Ow.get ? Ow.get(gid) : null;
          const h = spr ? spr.height ?? 32 : 32;
          sy = oy - Math.floor(h / 2) - 8 + (anim.yOffset ?? 0);
        }
        actors[len(actors) + 1] = {
          kind: "field_effect_emote",
          elevation: t ? t.elevation ?? 3 : 3,
          // pokeemerald/src/trainer_see.c:733
          oamPriority: 1,
          sortY: oy + 0.5,
          x: sx,
          y: sy,
          i: 91000 + idx,
          draw: (_s: any, camX: number, camY: number) => {
            G.setColor(1, 1, 1, 1);
            G.draw(sheet.image, sheet.quads[anim.frame], sx - camX, sy - camY);
          },
        };
      }
    }
  }
  const R = rse();
  if (R) R.collectActors(actors);
};

// Lua: field_effects.lua:2241 -- Draw in front of all actors
FieldEffects.drawFront = function (camXIn?: number, camYIn?: number, _playerPy?: number): void {
  const camX = camXIn ?? 0, camY = camYIn ?? 0;
  const R = rse();
  if (R) R.drawFront(camX, camY);
  WarpArrow.draw(camX, camY);

  // Transient airborne particle animations
  for (const [, anim] of ipairs<any>(FieldEffects._anims)) {
    if (anim.kind === "cut_grass_scatter") {
      const sheet = load_sheet("cut_grass", 8, 8, 1);
      if (sheet) {
        for (const [, p] of ipairs<any>(anim.particles ?? {})) {
          const q = sheet.quads[0];
          if (q) {
            const sx = p.x - camX;
            const sy = p.y - camY;
            G.setColor(1, 1, 1, 1);
            G.draw(sheet.image, q, sx, sy);
          }
        }
      }
    } else if (anim.kind === "rock_smash") {
      const sheet = load_sheet("rock_smash", 16, 16, 4);
      if (sheet) {
        for (const [, p] of ipairs<any>(anim.particles ?? {})) {
          const q = sheet.quads[mod(p.frame, 4)];
          if (q) {
            const sx = p.x - camX;
            const sy = p.y - camY;
            G.setColor(1, 1, 1, 1);
            G.draw(sheet.image, q, sx, sy);
          }
        }
      }
    } else if (anim.kind === "deoxys_rock_destroy" && anim.state === "shatter") {
      // pokefirered/src/field_effect.c:3975 CreateDeoxysRockFragments (4x 8x8 sprites)
      const sheet = load_sheet("deoxys_rock_fragments", 8, 8, 4);
      if (sheet) {
        for (const [, f] of ipairs<any>(anim.frags ?? {})) {
          if (!f.off) {
            const q = sheet.quads[f.frame];
            if (q) {
              G.setColor(1, 1, 1, 1);
              G.draw(sheet.image, q, f.x - camX, f.y - camY);
            }
          }
        }
      }
    } else if ((anim.kind === "fly_out" || anim.kind === "fly_in") && anim.bird) {
      draw_bird(anim.bird, camX, camY);
    }
  }
};

// Lua: field_effects.lua:2295
FieldEffects.draw = function (camX?: number, camY?: number, playerPy?: number): void {
  FieldEffects.drawFront(camX, camY, playerPy);
};

// Lua: field_effects.lua:2300 -- Screen-space overlay
FieldEffects.drawOverlay = function (camX?: number, camY?: number): void {
  // 1) Flash screen illumination
  for (const [, anim] of ipairs<any>(FieldEffects._anims)) {
    if (anim.kind === "flash" && anim.alpha > 0) {
      const Rd = modRenderer();
      if (Rd && Rd.canvas) {
        Rd.screenVeil = seq(1, 1, 1, anim.alpha);
      } else {
        G.setColor(1, 1, 1, anim.alpha);
        let w = 240, h = 160;
        const curCanvas: any = G.getCanvas();
        if (curCanvas) {
          try {
            const cw = curCanvas.getWidth(), ch = curCanvas.getHeight();
            if (cw && ch) { w = cw; h = ch; }
          } catch { /* pcall */ }
        } else if (G.getDimensions) {
          const [gw, gh] = G.getDimensions();
          if (gw && gh && gw > 0 && gh > 0) { w = gw; h = gh; }
        }
        G.rectangle("fill", 0, 0, w, h);
        G.setColor(1, 1, 1, 1);
      }
    } else if (anim.kind === "sweet_scent") {
      G.setColor(1, 0.7, 0.9, 0.6 * (1.0 - (anim.timer / anim.maxDur)));
      G.circle("line", 120, 80, anim.radius);
      G.circle("line", 120, 80, Math.max(0, anim.radius - 20));
      G.setColor(1, 1, 1, 1);
    }
  }

  const R = rse();
  if (R) R.drawOverlay(camX, camY);
  const Heal = modHeal();
  if (Heal && Heal.draw) Heal.draw(camX, camY);
  const IF = modItemfinder();
  if (IF && IF.draw) IF.draw();
  const SM = modShowMon();
  if (SM && SM.draw) SM.draw();
};

// Lua: field_effects.lua:2339
FieldEffects.fldeffName = function (idIn: unknown): string | null {
  const id = tonumber(idIn);
  if (id == null) return null;
  try {
    const name = Constants.of((Profile.forSession() as any).id).name("field_effects", id, "FLDEFF_");
    return name ?? null;
  } catch {
    return null;
  }
};

// Lua: field_effects.lua:2349
function emote_target(): any {
  const Objects: any = ObjectsMod;
  return Objects.find(FieldEffects.fieldEffectArgument(0, 0));
}

// Lua: field_effects.lua:2354
const HANDLERS: Record<string, () => any> = {
  // pokefirered/src/field_effect.c:3722 FldEff_MoveDeoxysRock reads gFieldEffectArguments[0..5]
  FLDEFF_MOVE_DEOXYS_ROCK: () => {
    const localId = FieldEffects.fieldEffectArgument(0, 1);
    const x = FieldEffects.fieldEffectArgument(3, 15);
    const y = FieldEffects.fieldEffectArgument(4, 12);
    const frames = FieldEffects.fieldEffectArgument(5, 5);
    return FieldEffects.startMoveDeoxysRock(localId, x, y, frames) != null;
  },
  // pokefirered/src/field_effect.c:3860 FldEff_DestroyDeoxysRock
  FLDEFF_DESTROY_DEOXYS_ROCK: () => {
    const localId = FieldEffects.fieldEffectArgument(0, 1);
    return FieldEffects.startDestroyDeoxysRock(localId) != null;
  },
  FLDEFF_POKECENTER_HEAL: () => {
    const Heal = modHeal();
    return (Heal && Heal.start()) || false;
  },
  // pokeemerald/src/trainer_see.c:696
  FLDEFF_EXCLAMATION_MARK_ICON: () => {
    if (!fieldBlock().emotes) return false;
    return FieldEffects.startEmote(emote_target(), "exclamation") != null;
  },
  // pokeemerald/src/trainer_see.c:706
  FLDEFF_QUESTION_MARK_ICON: () => {
    if (!fieldBlock().emotes) return false;
    return FieldEffects.startEmote(emote_target(), "question") != null;
  },
  // pokeemerald/src/trainer_see.c:716
  FLDEFF_HEART_ICON: () => {
    if (!fieldBlock().emotes) return false;
    return FieldEffects.startEmote(emote_target(), "heart") != null;
  },
};

// Lua: field_effects.lua:2390
FieldEffects.HANDLERS = HANDLERS;

// Lua: field_effects.lua:2392
function handlerFor(name: string | null): (() => any) | undefined {
  const fn = HANDLERS[name ?? ""];
  if (fn || !rse()) return fn;
  // NOT FAITHFUL: Emerald only -- src.core.game3.fldeff_misc is not ported (rse() throws first).
  return undefined;
}
FieldEffects.handlerFor = handlerFor;

// Lua: field_effects.lua:2399
FieldEffects.doFieldEffect = function (id: unknown): any {
  const fn = handlerFor(FieldEffects.fldeffName(id));
  if (fn) return fn();
  return false;
};

// Lua: field_effects.lua:2405
FieldEffects.waitFieldEffect = function (id: unknown, done?: () => void): void {
  const name = FieldEffects.fldeffName(id);
  if (name === "FLDEFF_POKECENTER_HEAL") {
    const Heal = modHeal();
    if (Heal) {
      Heal.wait(done);
      return;
    }
  }
  if (name && FieldEffects.isFieldEffectActive(id)) {
    FieldEffects._waiters[len(FieldEffects._waiters) + 1] = { id, done };
    return;
  }
  if (done) done();
};

// Lua: field_effects.lua:2421
FieldEffects.isFieldEffectActive = function (id: unknown): boolean {
  const name = FieldEffects.fldeffName(id);
  if (!name) return false;
  if (name === "FLDEFF_POKECENTER_HEAL") {
    const Heal = modHeal();
    return (Heal && Heal.isActive()) || false;
  }
  for (const [, anim] of ipairs<any>(FieldEffects._anims)) {
    if (anim.effectName === name) return true;
  }
  const R = rse();
  if (R) {
    if (R.isActive(name)) return true;
    // package.loaded["src.core.game3.fldeff_misc"] is never loaded here.
  }
  return false;
};

export default FieldEffects;
