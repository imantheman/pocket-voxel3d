// Port of gen1recomp src/ui/game3/intro_movie.lua (GPLv3 + additional terms; see LICENSE.md).
// The copyright screen and the opening movie (Game Freak star, scenes 1-3),
// a frame-exact port of pokefirered's intro.c.

import { Display } from "../core/display.ts";
import { Audio } from "../core/audio.ts";
import { Bg } from "../core/bg.ts";
import { Oam } from "../core/oam.ts";
import { Pal } from "../core/pal_fade.ts";
import { Trig } from "../core/trig.ts";
import { Song } from "../core/song_ids.ts";
import { G } from "../platform/graphics.ts";
import type { Canvas, Image, Quad } from "../platform/image.ts";
import { seq, len, ipairs, insert } from "../platform/lt.ts";
import { mod, truthy } from "../../../import/gen3/lua.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** An Oam sprite (core/oam.ts; its shape is that module's). */
type Sprite = any;
type TaskFn = (self: IntroMovie, t: Task) => void;
interface Task { fn: TaskFn; priority: number; data: any; alive: boolean }
/** The intro callback state (pokefirered's struct IntroSequenceData, the parts Brian keeps). */
interface Ptr { cb: string; state: number; timer: number; gengarAttackLanded?: boolean }
type IntroCB = (self: IntroMovie, p: Ptr, t: Task) => void;
interface Win1 { y0: number; y1: number }
interface Win0 { x0: number; x1: number; y0: number; y1: number }
interface Clip { x: number; y: number; w: number; h: number }
interface BldAlpha { eva: number; evb: number }
type QuadSet = Record<number, Quad> | null;

const SPECIES_NIDORINO = 33;

const BG_GF_TEXT_LOGO = 2;
const BG_GF_BACKGROUND = 3;
const BG_SCENE1_GRASS = 0;
const BG_SCENE1_BACKGROUND = 1;
const BG_SCENE2_PLANTS = 0;
const BG_SCENE2_NIDORINO = 1;
const BG_SCENE2_GENGAR = 2;
const BG_SCENE2_BACKGROUND = 3;
const BG_SCENE3_GENGAR = 0;
const BG_SCENE3_BACKGROUND = 1;

const OBJ_STAR = 0, OBJ_SPARKLES = 1, OBJ_GF = 2;
const OBJ_GENGAR = 0, OBJ_NIDORINO = 1, OBJ_GRASS = 2, OBJ_SWIPE = 3, OBJ_DUST = 4;

const ALL_BUT_0 = Pal.ALL - 1;

// Lua: intro_movie.lua:32
function idiv(a: number, b: number): number {
  const q = a / b;
  return q >= 0 ? Math.floor(q) : Math.ceil(q);
}

// Lua: intro_movie.lua:37
function s16(v: number): number {
  v = mod(v, 65536);
  if (v >= 32768) v = v - 65536;
  return v;
}

// Lua: intro_movie.lua:43
function mulU32(a: number, b: number): number {
  const aL = mod(a, 65536), aH = mod(Math.floor(a / 65536), 65536);
  const bL = mod(b, 65536), bH = mod(Math.floor(b / 65536), 65536);
  return mod(aL * bL + mod(aL * bH + aH * bL, 65536) * 65536, 4294967296);
}

const RAND_MULT = 1103515245;

// Lua: intro_movie.lua:51
function isoRandomize1(v: number): number {
  return mod(mulU32(v, RAND_MULT) + 24691, 4294967296);
}

// ----------------------------------------------------------------------
// Sprite anim tables (pokefirered/src/intro.c:474)
// The outer tables are Lua's `{ [0] = ... }`: JS arrays with index 0 used.
// ----------------------------------------------------------------------

const ANIM_SPARKLE_LOOP = 0, ANIM_SPARKLE_ONCE = 1;
const ANIMS_SPARKLES_SMALL: any[] = [
  seq<any>({ img: 0, dur: 4 }, { img: 1, dur: 4 }, { img: 2, dur: 4 }, { img: 3, dur: 4 }, { jump: 0 }),
  seq<any>({ img: 0, dur: 4 }, { img: 1, dur: 4 }, { img: 2, dur: 4 }, { img: 3, dur: 4 }, "end"),
];
// pokefirered/src/intro.c:528
const ANIMS_SPARKLES_BIG: any[] = [
  seq<any>({ img: 0, dur: 8 }, { img: 16, dur: 8 }, { img: 32, dur: 8 }, { img: 48, dur: 8 }, "end"),
];
const ANIM_NIDORINO_NORMAL = 0, ANIM_NIDORINO_CRY = 1, ANIM_NIDORINO_CROUCH = 2, ANIM_NIDORINO_HOP = 3,
  ANIM_NIDORINO_ATTACK = 4;
// pokefirered/src/intro.c:609
const ANIMS_NIDORINO: any[] = [
  seq<any>({ img: 0, dur: 1 }, "end"),
  seq<any>({ img: 64, dur: 1 }, "end"),
  seq<any>({ img: 128, dur: 1 }, "end"),
  seq<any>({ img: 192, dur: 1 }, "end"),
  seq<any>({ img: 256, dur: 1 }, "end"),
];
// pokefirered/src/intro.c:803
const ANIMS_SWIPE: any[] = [
  seq<any>({ img: 0, dur: 8 }, { img: 32, dur: 4 }, "end"),
  seq<any>({ img: 64, dur: 8 }, { img: 72, dur: 4 }, "end"),
];
// pokefirered/src/intro.c:843
const ANIMS_RECOIL_DUST: any[] = [
  seq<any>({ img: 0, dur: 10 }, { img: 4, dur: 10 }, { img: 8, dur: 10 }, { img: 12, dur: 8 }, "end"),
];
// pokefirered/src/intro.c:647
const AFFINE_ZOOM = seq<any>({ v: 256, dur: 0 }, { v: 32, dur: 8 }, "end");

// pokefirered/src/intro.c:436
const TEXT_SPARKLE_COORDS = seq(
  seq(72, 80), seq(136, 74), seq(168, 80), seq(120, 80), seq(104, 86),
  seq(88, 74), seq(184, 74), seq(56, 86), seq(152, 86),
) as number[][];

// pokefirered/src/intro.c:414
const GENGAR_ZOOM_ANCHORS = seq(seq(63, 63), seq(0, 63), seq(63, 0), seq(0, 0)) as number[][];

// ----------------------------------------------------------------------
// Asset helpers
// ----------------------------------------------------------------------

// Lua: intro_movie.lua:102
function tileQuads(img: Image | null | undefined, tileW: number, tileH: number, frameTiles: number, count: number,
  startTile?: number): QuadSet {
  // (love.graphics.newQuad always exists here)
  if (img == null) return null;
  const [iw, ih] = img.getDimensions();
  const sheetCols = iw / 8;
  const quads: Record<number, Quad> = {};
  for (let i = 0; i <= count - 1; i++) {
    const t = (startTile ?? 0) + i * frameTiles;
    const x = mod(t, sheetCols) * 8;
    const y = Math.floor(t / sheetCols) * 8;
    quads[t] = G.newQuad(x, y, tileW * 8, tileH * 8, iw, ih);
  }
  return quads;
}

// Lua: intro_movie.lua:116
function relayoutTiles(img: Image | null | undefined, startTile: number, wTiles: number, hTiles: number): Canvas | null {
  // (love.graphics.newCanvas always exists here)
  if (img == null) return null;
  const [iw, ih] = img.getDimensions();
  const sheetCols = iw / 8;
  const canvas = G.newCanvas(wTiles * 8, hTiles * 8);
  canvas.setFilter("nearest", "nearest");
  G.push("all");
  G.setCanvas(canvas);
  G.origin();
  G.setScissor();
  G.setShader();
  G.setBlendMode("replace", "premultiplied");
  G.clear(0, 0, 0, 0);
  G.setColor(1, 1, 1, 1);
  const q = G.newQuad(0, 0, 8, 8, iw, ih);
  for (let ty = 0; ty <= hTiles - 1; ty++) {
    for (let tx = 0; tx <= wTiles - 1; tx++) {
      const t = startTile + ty * wTiles + tx;
      q.setViewport(mod(t, sheetCols) * 8, Math.floor(t / sheetCols) * 8, 8, 8, iw, ih);
      G.draw(img, q, tx * 8, ty * 8);
    }
  }
  G.pop();
  return canvas;
}

// Lua: intro_movie.lua:142
function composeGfWindow(text: Image | null | undefined, logo: Image | null | undefined): Canvas | null {
  // (love.graphics.newCanvas always exists here)
  const canvas = G.newCanvas(Display.W, Display.H);
  canvas.setFilter("nearest", "nearest");
  G.push("all");
  G.setCanvas(canvas);
  G.origin();
  G.setScissor();
  G.setShader();
  G.clear(0, 0, 0, 0);
  G.setColor(1, 1, 1, 1);
  // pokefirered/src/intro.c:1251
  if (logo != null) G.draw(logo, 104, 38);
  // pokefirered/src/intro.c:1127
  if (text != null) G.draw(text, 48, 72);
  G.pop();
  return canvas;
}

// ----------------------------------------------------------------------
// Sprites
// ----------------------------------------------------------------------

// Lua: intro_movie.lua:264
function createSprite(_self: IntroMovie, tmpl: any, x: number, y: number, sub: number): Sprite | null {
  const [id, spr] = Oam.createSprite(tmpl, x, y, sub);
  if (!truthy(spr)) return null;
  spr._id = id;
  spr.palSlot = Pal.objSlot(tmpl.palSlot ?? 0);
  spr.objBlend = tmpl.objBlend;
  if (truthy(tmpl.double)) {
    spr.oam.affineMode = Oam.AFFINE_DOUBLE;
    Oam.applyCenterToCorner(spr);
    spr.affineScale = 1;
  }
  return spr;
}

// Lua: intro_movie.lua:278
function destroySprite(spr: Sprite | null | undefined): void {
  if (spr != null && truthy(spr.inUse)) Oam.destroySprite(spr._id);
}

// ----------------------------------------------------------------------
// Blend task (pokefirered/src/menu2.c:591)
// ----------------------------------------------------------------------

// Lua: intro_movie.lua:286
function Task_SmoothBlendLayers(self: IntroMovie, t: Task): void {
  const d = t.data;
  if (d.steps !== 0) {
    if (d.which === 0) {
      d.evA = d.evA + d.dA;
      d.which = 1;
    } else {
      d.steps = d.steps - 1;
      if (d.steps !== 0) {
        d.evB = d.evB + d.dB;
      } else {
        d.evA = d.endA * 256;
        d.evB = d.endB * 256;
      }
      d.which = 0;
    }
    self.bldAlpha = { eva: Math.floor(mod(s16(d.evA), 65536) / 256), evb: Math.floor(d.evB / 256) };
    if (d.steps === 0) self.destroyTask(t);
  }
}

// ----------------------------------------------------------------------
// Game Freak scene sprites
// ----------------------------------------------------------------------

// Lua: intro_movie.lua:429
function SpriteCB_SparklesSmall_Star(sprite: Sprite): void {
  const d = sprite.data;
  // pokefirered/src/intro.c:2305
  d[1] = s16(d[1] + d[3]);
  d[2] = s16(d[2] + d[4]);
  d[5] = d[5] + 1;
  d[6] = s16(d[6] + d[5]);
  d[8] = d[8] + 1;
  sprite.x = Math.floor(mod(d[1], 65536) / 32);
  sprite.y = Math.floor(d[2] / 32);
  if (d[8] > 90) {
    sprite.invisible = !truthy(sprite.invisible);
    if (d[8] > 120) {
      Oam.destroySprite(sprite._id);
      return;
    }
  }
  if (sprite.y + sprite.y2 < 0 || sprite.y + sprite.y2 > Display.H) {
    Oam.destroySprite(sprite._id);
  }
}

// Lua: intro_movie.lua:504
function SpriteCB_SparklesSmall_Name(sprite: Sprite): void {
  // pokefirered/src/intro.c:2326
  const d = sprite.data;
  if (d[3] !== 0) {
    d[3] = d[3] - 1;
    d[2] = d[2] + 1;
    sprite.y = Math.floor(d[2] / 16);
    if (sprite.y > 86) {
      sprite.y = 74;
      d[2] = 74 * 16;
    }
    if (truthy(sprite.animEnded)) {
      if (d[1] === 0) {
        sprite.x = sprite.x + 26;
        if (sprite.x > 188) {
          sprite.x = 188 * 2 - sprite.x;
          d[1] = 1;
        }
      } else {
        sprite.x = sprite.x - 26;
        if (sprite.x < 52) {
          sprite.x = 52 * 2 - sprite.x;
          d[1] = 0;
        }
      }
      Oam.startAnim(sprite, ANIM_SPARKLE_ONCE);
    }
  } else {
    if (d[4] !== 0) {
      Oam.destroySprite(sprite._id);
      return;
    }
    if (truthy(sprite.animEnded)) Oam.startAnim(sprite, ANIM_SPARKLE_LOOP);
    d[2] = d[2] + 4;
    sprite.y = Math.floor(d[2] / 16);
    d[5] = d[5] + 1;
    if (d[5] > 50) Oam.destroySprite(sprite._id);
  }
}

// Lua: intro_movie.lua:544
function GFScene_Task_NameSparklesSmall(self: IntroMovie, t: Task): void {
  // pokefirered/src/intro.c:2035
  const d = t.data;
  d.timer = (d.timer ?? 0) + 1;
  d.idx = d.idx ?? 0;
  d.loops = d.loops ?? 0;
  if (d.timer > 6) {
    d.timer = 0;
    const c = TEXT_SPARKLE_COORDS[d.idx + 1]!;
    const spr = createSprite(self, {
      dims: Oam.SQUARE_8, priority: 2, image: self.assets.introSparklesSmall,
      anims: ANIMS_SPARKLES_SMALL, animQuads: self.q.sparkSmall,
      callback: SpriteCB_SparklesSmall_Name, palSlot: OBJ_SPARKLES,
    }, c[1]!, c[2]!, 2);
    if (spr != null) {
      Oam.startAnim(spr, ANIM_SPARKLE_ONCE);
      spr.data[2] = c[2]! * 16;
      spr.data[3] = 120;
      spr.data[4] = d.loops;
    }
    d.idx = d.idx + 1;
    if (d.idx >= len(TEXT_SPARKLE_COORDS)) {
      d.loops = d.loops + 1;
      if (d.loops > 1) {
        self.destroyTask(t);
      } else {
        d.idx = 0;
      }
    }
  }
}

// Lua: intro_movie.lua:576
function GFScene_Task_NameSparklesBig(self: IntroMovie, t: Task): void {
  // pokefirered/src/intro.c:2078
  const d = t.data;
  d.timer = d.timer ?? 0;
  d.idx = d.idx ?? 0;
  d.count = d.count ?? 0;
  if (d.timer === 0) {
    const c = TEXT_SPARKLE_COORDS[d.idx + 1]!;
    d.idx = d.idx + 4;
    if (d.idx >= len(TEXT_SPARKLE_COORDS)) d.idx = d.idx - len(TEXT_SPARKLE_COORDS);
    createSprite(self, {
      dims: Oam.SQUARE_32, priority: 2, image: self.assets.introSparklesBig,
      anims: ANIMS_SPARKLES_BIG, animQuads: self.q.sparkBig, palSlot: OBJ_SPARKLES,
      callback: (sprite: Sprite) => {
        if (truthy(sprite.animEnded)) Oam.destroySprite(sprite._id);
      },
    }, c[1]!, c[2]!, 3);
    d.count = d.count + 1;
    if (d.count >= len(TEXT_SPARKLE_COORDS)) self.destroyTask(t);
  }
  d.timer = d.timer + 1;
  if (d.timer > 9) d.timer = 0;
}

// ----------------------------------------------------------------------
// Scene 1 (pokefirered/src/intro.c:1299)
// ----------------------------------------------------------------------

// Lua: intro_movie.lua:709
function Scene1_Task_AnimateGrass(_self: IntroMovie, t: Task): void {
  // pokefirered/src/intro.c:1379
  const d = t.data;
  d.timer = (d.timer ?? 0) + 1;
  d.frame = d.frame ?? 0;
  d.scroll = d.scroll ?? 0;
  if (d.timer > 5) {
    d.timer = 0;
    d.frame = d.frame + 1;
    if (d.frame >= 3) d.frame = 0;
    Bg.changeBgY(BG_SCENE1_GRASS, d.frame * 0x8000, Bg.COORD_SET);
  }
  if (truthy(d.exiting)) {
    d.scroll = s16(d.scroll + 0x120);
    Bg.changeBgY(BG_SCENE1_GRASS, d.scroll, Bg.COORD_SUB);
  }
}

// Lua: intro_movie.lua:727
function Scene1_Task_BgZoom(_self: IntroMovie, t: Task): void {
  // pokefirered/src/intro.c:1419
  const d = t.data;
  d.timer = (d.timer ?? 0) + 1;
  d.frame = d.frame ?? 0;
  if (d.timer > 3) {
    d.timer = 0;
    if (d.frame < 2) d.frame = d.frame + 1;
    Bg.changeBgY(BG_SCENE1_BACKGROUND, d.frame * 0x8000, Bg.COORD_SET);
  }
}

// ----------------------------------------------------------------------
// Scene 2 (pokefirered/src/intro.c:1435)
// ----------------------------------------------------------------------

// Lua: intro_movie.lua:798
function Scene2_Task_PanForest(_self: IntroMovie): void {
  Bg.changeBgX(BG_SCENE2_BACKGROUND, 0x0E0, Bg.COORD_SUB);
  Bg.changeBgX(BG_SCENE2_PLANTS, 0x110, Bg.COORD_ADD);
}

// Lua: intro_movie.lua:803
function Scene2_Task_PanMons(_self: IntroMovie): void {
  Bg.changeBgY(BG_SCENE2_GENGAR, 0x020, Bg.COORD_ADD);
  Bg.changeBgY(BG_SCENE2_NIDORINO, 0x024, Bg.COORD_SUB);
}

// Lua: intro_movie.lua:808
function wrapWidth(img: Image | null | undefined): number {
  const w = img != null ? img.getWidth() : 256;
  return w;
}

// ----------------------------------------------------------------------
// Scene 3 (pokefirered/src/intro.c:1560)
// ----------------------------------------------------------------------

// Lua: intro_movie.lua:904
function Scene3_Task_BgScroll(_self: IntroMovie, t: Task): void {
  // pokefirered/src/intro.c:1623
  if (!truthy(t.data.slow)) {
    Bg.changeBgX(BG_SCENE3_BACKGROUND, 0x400, Bg.COORD_SUB);
  } else {
    Bg.changeBgX(BG_SCENE3_BACKGROUND, 0x020, Bg.COORD_SUB);
  }
}

// Lua: intro_movie.lua:913
function Scene3_Task_GengarBounce(_self: IntroMovie, t: Task): void {
  // pokefirered/src/intro.c:1649
  const d = t.data;
  d.timer = d.timer ?? 0;
  d.state = d.state ?? 0;
  if (!truthy(d.paused)) {
    d.timer = d.timer + 1;
    if (d.timer >= 30) {
      d.timer = 0;
      d.state = 1 - d.state;
      Bg.changeBgY(BG_SCENE3_GENGAR, d.state * 0x8000 + 0x1F000, Bg.COORD_SET);
    }
  }
}

// Lua: intro_movie.lua:928
function Scene3_Task_GengarEnter(self: IntroMovie, t: Task): void {
  // pokefirered/src/intro.c:2249
  const d = t.data;
  if (d.speed == null) d.speed = 0x400;
  d.moves = (d.moves ?? 0) + 1;
  if (d.moves >= 40 && d.speed > 16) d.speed = d.speed - 16;
  Bg.changeBgX(BG_SCENE3_GENGAR, d.speed, Bg.COORD_ADD);
  const scroll = Bg.get(BG_SCENE3_GENGAR).scrollX * 256;
  if (scroll >= 0x8000) self.win0 = null;
  if (scroll >= 0xEF00) {
    Bg.changeBgX(BG_SCENE3_GENGAR, 0xEF00, Bg.COORD_SET);
    self.destroyTask(t);
  }
}

// Lua: intro_movie.lua:943
function SpriteCB_Grass(movie: IntroMovie): (sprite: Sprite) => void {
  return (sprite: Sprite): void => {
    // pokefirered/src/intro.c:1702
    const d = sprite.data;
    if (d[1] === 0) {
      d[2] = sprite.x * 32;
      d[3] = 160;
      d[1] = 1;
    }
    if (d[1] === 1) {
      d[2] = d[2] - d[3];
      sprite.x = Math.floor(d[2] / 32);
      if (sprite.x <= 52) {
        const t = movie.findTask(Scene3_Task_BgScroll);
        if (t != null) t.data.slow = true;
        d[1] = 2;
      }
    } else if (d[1] === 2) {
      d[2] = d[2] - 32;
      sprite.x = Math.floor(d[2] / 32);
      if (sprite.x <= -32) {
        sprite.invisible = true;
        Oam.destroySprite(sprite._id);
      }
    }
  };
}

// Lua: intro_movie.lua:971
function Scene3_SpriteCB_NidorinoEnter(sprite: Sprite): void {
  // pokefirered/src/intro.c:2405
  const d = sprite.data;
  d[5] = d[5] + 1;
  if (d[5] >= 40 && d[2] > 1) d[2] = d[2] - 1;
  d[1] = d[1] + d[2];
  sprite.x = Math.floor(d[1] / 16);
  if (sprite.x >= d[4]) {
    sprite.x = d[4];
    sprite.callback = Oam.DUMMY_CALLBACK;
  }
}

// Lua: intro_movie.lua:984
function nidoRunning(self: IntroMovie): boolean {
  const s = self.nido;
  return s != null && s.callback !== Oam.DUMMY_CALLBACK;
}

// Lua: intro_movie.lua:989
let SpriteCB_NidorinoHop: (sprite: Sprite) => void;

// Lua: intro_movie.lua:991
function startNidorinoHop(sprite: Sprite, time: number, targetX: number, heightShift: number): void {
  // pokefirered/src/intro.c:2655
  const d = sprite.data;
  d[1] = 0;
  d[2] = time;
  d[3] = s16(sprite.x2 * 16);
  d[4] = idiv(targetX * 16, time);
  d[5] = 0;
  d[6] = idiv(0x800, time);
  d[7] = 0;
  d[8] = heightShift;
  Oam.startAnim(sprite, ANIM_NIDORINO_CROUCH);
  sprite.callback = SpriteCB_NidorinoHop;
}

// Lua: intro_movie.lua:1006
SpriteCB_NidorinoHop = (sprite: Sprite): void => {
  // pokefirered/src/intro.c:2669
  const d = sprite.data;
  if (d[1] === 0) {
    d[7] = d[7] + 1;
    if (d[7] > 4) {
      Oam.startAnim(sprite, ANIM_NIDORINO_HOP);
      d[7] = 0;
      d[1] = 1;
    }
  } else if (d[1] === 1) {
    d[2] = mod(d[2] - 1, 65536);
    if (d[2] !== 0) {
      d[3] = s16(d[3] + d[4]);
      d[5] = s16(d[5] + d[6]);
      sprite.x2 = Math.floor(d[3] / 16);
      sprite.y2 = -Math.floor((Trig.SINE as number[])[Math.floor(d[5] / 16) + 1] / 2 ** d[8]);
    } else {
      sprite.x2 = s16(Math.floor(mod(d[3], 65536) / 16));
      sprite.y2 = 0;
      Oam.startAnim(sprite, ANIM_NIDORINO_CROUCH);
      if (d[8] === 5) {
        sprite.callback = Oam.DUMMY_CALLBACK;
      } else {
        d[7] = 0;
        d[1] = 2;
      }
    }
  } else {
    d[7] = d[7] + 1;
    if (d[7] > 4) {
      Oam.startAnim(sprite, ANIM_NIDORINO_NORMAL);
      sprite.callback = Oam.DUMMY_CALLBACK;
    }
  }
};

// Lua: intro_movie.lua:1043
function startNidorinoCry(self: IntroMovie): void {
  // pokefirered/src/intro.c:2438
  const sprite = self.nido;
  Oam.startAnim(sprite, ANIM_NIDORINO_CROUCH);
  sprite.data[1] = 0;
  sprite.data[2] = 0;
  sprite.y2 = 3;
  sprite.callback = (s: Sprite): void => {
    const d = s.data;
    if (d[1] === 0) {
      d[2] = d[2] + 1;
      if (d[2] > 8) {
        Oam.startAnim(s, ANIM_NIDORINO_CRY);
        s.y2 = 0;
        d[1] = 1;
      }
    } else if (d[1] === 1) {
      Audio.playCry(SPECIES_NIDORINO, 1, 0x3F);
      d[2] = 0;
      d[1] = 2;
    } else {
      d[3] = d[3] + 1;
      if (d[3] > 1) {
        d[3] = 0;
        s.y2 = s.y2 === 0 ? 1 : 0;
      }
      d[2] = d[2] + 1;
      if (d[2] > 48) {
        Oam.startAnim(s, ANIM_NIDORINO_NORMAL);
        s.y2 = 0;
        s.callback = Oam.DUMMY_CALLBACK;
      }
    }
  };
}

// Lua: intro_movie.lua:1118
function startNidorinoRecoil(self: IntroMovie): void {
  // pokefirered/src/intro.c:2494
  const sprite = self.nido;
  const movie = self;
  Oam.startAnim(sprite, ANIM_NIDORINO_CROUCH);
  const d = sprite.data;
  d[1] = 0; d[2] = 0; d[3] = 0; d[4] = 0; d[5] = 0;
  d[8] = 40;
  sprite.callback = (s: Sprite): void => {
    const dd = s.data;
    if (dd[1] === 0) {
      dd[2] = dd[2] + 1;
      if (dd[2] > 4) {
        Oam.startAnim(s, ANIM_NIDORINO_HOP);
        dd[1] = 1;
      }
    } else if (dd[1] === 1) {
      dd[3] = s16(dd[3] + dd[8]);
      dd[4] = dd[4] + 8;
      s.x2 = Math.floor(dd[3] / 16);
      s.y2 = -Math.floor(((Trig.SINE as number[])[dd[4] + 1] * 3) / 32);
      dd[6] = dd[6] + 1;
      if (dd[6] > 0) {
        dd[6] = 0;
        dd[8] = dd[8] - 1;
      }
      dd[5] = dd[5] + 1;
      if (dd[5] > 15) {
        Oam.startAnim(s, ANIM_NIDORINO_CROUCH);
        dd[2] = 0;
        dd[7] = 0x4757;
        dd[8] = 28;
        dd[1] = 2;
      }
    } else if (dd[1] === 2) {
      dd[3] = s16(dd[3] + dd[8]);
      s.x2 = Math.floor(dd[3] / 16);
      dd[2] = dd[2] + 1;
      if (dd[2] > 6) {
        movie.createRecoilDust(s.x + s.x2, s.y + s.y2, dd[7]);
        dd[7] = s16(mulU32(mod(dd[7], 65536), RAND_MULT));
      }
      if (dd[2] > 12) {
        Oam.startAnim(s, ANIM_NIDORINO_NORMAL);
        dd[2] = 0;
        dd[1] = 3;
      }
    } else {
      dd[2] = dd[2] + 1;
      if (dd[2] > 16) {
        startNidorinoHop(s, 16, -s.x2, 4);
      }
    }
  };
}

// Lua: intro_movie.lua:1174
function startNidorinoAttack(self: IntroMovie): void {
  // pokefirered/src/intro.c:2733
  const sprite = self.nido;
  const d = sprite.data;
  d[1] = 0; d[2] = 0; d[3] = 0; d[4] = 0; d[5] = 0; d[6] = 0;
  sprite.x = sprite.x + sprite.x2;
  sprite.x2 = 0;
  d[8] = 36;
  Oam.startAnim(sprite, ANIM_NIDORINO_CROUCH);
  sprite.callback = (s: Sprite): void => {
    const dd = s.data;
    if (dd[1] === 0) {
      dd[2] = dd[2] + 1;
      if (mod(dd[2], 2) === 1) {
        dd[3] = dd[3] + 1;
        if (mod(dd[3], 2) === 1) s.x2 = s.x2 + 1; else s.x2 = s.x2 - 1;
      }
      if (dd[2] > 17) {
        dd[2] = 0;
        dd[1] = 1;
      }
    } else if (dd[1] === 1) {
      dd[2] = dd[2] + 1;
      if (dd[2] >= 40) {
        Oam.startAnim(s, ANIM_NIDORINO_ATTACK);
        dd[2] = 0;
        dd[3] = 0;
        dd[1] = 2;
      }
    } else {
      dd[2] = dd[2] + dd[8];
      s.x2 = -Math.floor(dd[2] / 16);
      s.y2 = -Math.floor(((Trig.SINE as number[])[Math.floor(dd[2] / 16) + 1] * 3) / 16);
      dd[3] = dd[3] + 1;
      if (dd[8] > 12) dd[8] = dd[8] - 1;
      if (Math.floor(dd[2] / 16) > 63) s.callback = Oam.DUMMY_CALLBACK;
    }
  };
}

// Lua: intro_movie.lua:1214
function applyGengarAnim(frame: number, xSub: number, ySub: number, xBase: number): void {
  // pokefirered/src/intro.c:2135
  Bg.changeBgY(BG_SCENE3_GENGAR, frame * 0x8000 + 0x1F000, Bg.COORD_SET);
  Bg.changeBgX(BG_SCENE3_GENGAR, xBase, Bg.COORD_SET);
  Bg.changeBgX(BG_SCENE3_GENGAR, xSub * 256, Bg.COORD_SUB);
  Bg.changeBgY(BG_SCENE3_GENGAR, ySub * 256, Bg.COORD_SUB);
}

// Lua: intro_movie.lua:1222
function Scene3_Task_GengarAttack(self: IntroMovie, t: Task): void {
  // pokefirered/src/intro.c:2143
  const d = t.data;
  const st = d.state;
  if (st === 0) {
    d.frame = 2;
    d.timer = 0;
    d.multY = 6;
    d.multX = 32;
    d.state = 1;
  } else if (st === 1) {
    d.sinIdx = d.sinIdx - 2;
    d.timer = d.timer + 1;
    if (d.timer > 15) {
      d.timer = 0;
      d.state = 2;
    }
  } else if (st === 2) {
    d.timer = d.timer + 1;
    if (d.timer === 14) self.ptr!.gengarAttackLanded = true;
    if (d.timer > 15) {
      d.timer = 0;
      d.state = 3;
    }
  } else if (st === 3) {
    d.sinIdx = d.sinIdx + 8;
    d.timer = d.timer + 1;
    if (d.timer === 4) {
      self.createGengarSwipeSprites();
      d.multY = 32;
      d.multX = 48;
      d.frame = 3;
    }
    if (d.timer > 7) {
      d.timer = 0;
      d.state = 4;
    }
  } else if (st === 4) {
    d.sinIdx = d.sinIdx - 8;
    d.timer = d.timer + 1;
    if (d.timer > 3) {
      d.frame = 0;
      d.sinIdx = 64;
      d.timer = 0;
      d.state = 5;
    }
  } else {
    self.destroyTask(t);
    return;
  }
  const xSub = -Math.floor(((Trig.SINE as number[])[d.sinIdx + 64 + 1] * d.multX) / 256);
  const ySub = d.multY - Math.floor(((Trig.SINE as number[])[d.sinIdx + 1] * d.multY) / 256);
  applyGengarAnim(d.frame, xSub, ySub, d.baseX);
}

// ----------------------------------------------------------------------
// Lifecycle
// ----------------------------------------------------------------------

export class IntroMovie {
  static GBA_HZ = 16777216 / 280896;

  assets: Record<string, any> = {};
  pal: any = null;
  tasks: (Task | null)[] = seq<Task>();
  accum = 0;
  pendingSkip = false;
  /** "copyright" | "wait_fade" | "setup" | "intro" | "done" */
  phase = "copyright";
  state = 0;
  isDone = false;
  bgPal: Record<number, number> = {};
  win1: Win1 | null = null;
  win0: Win0 | null = null;
  bld: Record<string, boolean> | null = null;
  frames = 0;

  q: Record<string, QuadSet> = {};
  gengarTR: Canvas | null = null;
  gengarBR: Canvas | null = null;
  gfText: Canvas | null = null;
  gfTextLogo: Canvas | null = null;
  _runIdx: number | null = null;
  bldAlpha: BldAlpha | null = null;
  ptr: Ptr | null = null;
  _skipThisFrame = false;
  sparkleYMod: number | null = null;
  starSeed = 0;
  logoSprite: Sprite | null = null;
  s2Nidorino: Sprite | null = null;
  s2Gengar: Sprite | null = null;
  nido: Sprite | null = null;
  gengarSprites: (Sprite | null)[] | null = null;
  blackout = false;

  // Lua: intro_movie.lua:165
  static new(assets?: Record<string, any> | null): IntroMovie {
    const self = new IntroMovie();
    self.assets = assets ?? {};
    self.pal = Pal.new();
    self.tasks = seq<Task>();
    self.accum = 0;
    self.pendingSkip = false;
    self.phase = "copyright";
    self.state = 0;
    self.isDone = false;
    self.bgPal = {};
    self.win1 = null;
    self.win0 = null;
    self.bld = null;
    self.frames = 0;
    const A = self.assets;
    if (G.newQuad != null) {
      self.q = {
        sparkSmall: tileQuads(A.introSparklesSmall, 1, 1, 1, 4),
        sparkBig: tileQuads(A.introSparklesBig, 4, 4, 16, 4),
        nidorino: tileQuads(A.introScene3Nidorino, 8, 8, 64, 5),
        swipeTop: tileQuads(A.introScene3Swipe, 4, 8, 32, 2),
        swipeBottom: tileQuads(A.introScene3Swipe, 4, 2, 8, 2, 64),
        dust: tileQuads(A.introScene3RecoilDust, 2, 2, 4, 4),
        grass: tileQuads(A.introScene3Grass, 8, 4, 32, 1),
        presents: tileQuads(A.introPresents, 4, 1, 4, 2),
        gengarTL: tileQuads(A.introScene3GengarStatic, 8, 8, 64, 1),
        gengarBL: tileQuads(A.introScene3GengarStatic, 8, 8, 64, 1, 96),
      };
      self.gengarTR = relayoutTiles(A.introScene3GengarStatic, 64, 4, 8);
      self.gengarBR = relayoutTiles(A.introScene3GengarStatic, 160, 4, 8);
      self.gfText = composeGfWindow(A.introGfText, null);
      self.gfTextLogo = composeGfWindow(A.introGfText, A.introGfLogo);
    } else {
      self.q = {};
    }
    Oam.destroyAll();
    Bg.reset();
    return self;
  }

  // Lua: intro_movie.lua:207
  destroy(): void {
    Oam.destroyAll();
    Bg.reset();
    this.tasks = seq<Task>();
  }

  // --------------------------------------------------------------------
  // Task runner (pokefirered/src/task.c)
  // --------------------------------------------------------------------

  // Lua: intro_movie.lua:217
  createTask(fn: TaskFn, priority: number): Task {
    const t: Task = { fn, priority, data: {}, alive: true };
    const list = this.tasks;
    let pos = len(list) + 1;
    for (const [i, other] of ipairs<Task>(list)) {
      if (other.priority > priority) {
        pos = i;
        break;
      }
    }
    insert(list, pos, t);
    if (this._runIdx != null && pos <= this._runIdx) {
      this._runIdx = this._runIdx + 1;
    }
    return t;
  }

  // Lua: intro_movie.lua:234
  findTask(fn: TaskFn): Task | null {
    // (ipairs as a plain loop: this runs every frame in some states)
    const list = this.tasks;
    for (let i = 1; list[i] != null; i++) {
      const t = list[i]!;
      if (t.alive && t.fn === fn) return t;
    }
    return null;
  }

  // Lua: intro_movie.lua:241
  destroyTask(t: Task | null | undefined): void {
    if (t != null) t.alive = false;
  }

  // Lua: intro_movie.lua:245
  runTasks(): void {
    this._runIdx = 1;
    while (this._runIdx <= len(this.tasks)) {
      const t = this.tasks[this._runIdx]!;
      if (t.alive) t.fn(this, t);
      this._runIdx = this._runIdx! + 1;
    }
    this._runIdx = null;
    const keep = seq<Task>();
    const list = this.tasks;
    for (let i = 1; list[i] != null; i++) {
      const t = list[i]!;
      if (t.alive) keep[len(keep) + 1] = t;
    }
    this.tasks = keep;
  }

  // Lua: intro_movie.lua:307
  startBlendTask(evaStart: number, evbStart: number, evaEnd: number, evbEnd: number, step: number): void {
    const t = this.createTask(Task_SmoothBlendLayers, 0);
    t.data = {
      evA: evaStart * 256, evB: evbStart * 256, endA: evaEnd, endB: evbEnd,
      dA: idiv((evaEnd - evaStart) * 256, step), dB: idiv((evbEnd - evbStart) * 256, step),
      steps: step, which: 0,
    };
    this.bldAlpha = { eva: evaStart, evb: evbStart };
  }

  // Lua: intro_movie.lua:317
  isBlendTaskActive(): boolean {
    return this.findTask(Task_SmoothBlendLayers) != null;
  }

  // --------------------------------------------------------------------
  // Copyright (pokefirered/src/intro.c:916)
  // --------------------------------------------------------------------

  // Lua: intro_movie.lua:325
  copyrightFrame(): void {
    const st = this.state;
    if (st === 0) {
      Oam.destroyAll();
      Bg.reset();
      this.pal.reset();
      Bg.initFromTemplates(seq({ bg: 0, priority: 0 }));
      if (truthy(this.assets.introCopyright)) {
        Bg.setImage(0, this.assets.introCopyright, null);
        Bg.show(0);
      }
      this.bgPal = { 0: 0 };
      this.pal.beginFade(Pal.ALL, 0, 16, 0, Pal.WHITE);
    }
    if (st < 140) {
      this.pal.updateFade();
      this.state = st + 1;
    } else if (st === 140) {
      this.pal.beginFade(Pal.ALL, 0, 0, 16, Pal.BLACK);
      this.state = 141;
    } else if (st === 141) {
      if (!truthy(this.pal.updateFade())) {
        this.state = 142;
      }
    } else if (st === 142) {
      this.phase = "wait_fade";
      this.state = 0;
    }
  }

  // --------------------------------------------------------------------
  // CB2_SetUpIntro (pokefirered/src/intro.c:1018)
  // --------------------------------------------------------------------

  // Lua: intro_movie.lua:359
  setupFrame(): void {
    const st = this.state;
    if (st === 0) {
      Oam.destroyAll();
      Bg.reset();
      this.tasks = seq<Task>();
      this.pal.reset();
      Bg.initFromTemplates(seq(
        { bg: BG_GF_BACKGROUND, priority: 3 },
        { bg: BG_GF_TEXT_LOGO, priority: 2 },
      ));
      if (truthy(this.assets.introGfBg)) Bg.setImage(BG_GF_BACKGROUND, this.assets.introGfBg, null);
      if (this.gfText != null) Bg.setImage(BG_GF_TEXT_LOGO, this.gfText, null);
      this.bgPal = { [BG_GF_BACKGROUND]: 0, [BG_GF_TEXT_LOGO]: 13 };
      this.state = 1;
    } else if (st === 1) {
      this.state = 2;
    } else {
      this.ptr = { cb: "Init", state: 0, timer: 0 };
      this.createTask(IntroMovie.Task_CallIntroCallback, 3);
      this.pal.blend(Pal.ALL, 16, Pal.BLACK);
      this.phase = "intro";
      this.state = 0;
    }
  }

  // Lua: intro_movie.lua:385
  setCB(name: string): void {
    this.ptr!.cb = name;
    this.ptr!.state = 0;
  }

  // Lua: intro_movie.lua:391
  // pokefirered/src/intro.c:1106
  static Task_CallIntroCallback(self: IntroMovie, t: Task): void {
    const ptr = self.ptr!;
    if (self._skipThisFrame && ptr.cb !== "ExitToTitleScreen") {
      self.setCB("ExitToTitleScreen");
    }
    (IntroMovie as unknown as Record<string, IntroCB>)["IntroCB_" + ptr.cb]!(self, ptr, t);
  }

  // Lua: intro_movie.lua:400
  // pokefirered/src/intro.c:1117
  static IntroCB_Init(self: IntroMovie, p: Ptr): void {
    if (p.state === 0) {
      p.state = 1;
    } else {
      self.setCB("GF_OpenWindow");
    }
  }

  // Lua: intro_movie.lua:409
  // pokefirered/src/intro.c:1139
  static IntroCB_GF_OpenWindow(self: IntroMovie, p: Ptr): void {
    if (p.state === 0) {
      self.win1 = { y0: 0, y1: 0 };
      p.timer = 0;
      p.state = 1;
    } else if (p.state === 1) {
      Bg.show(BG_GF_BACKGROUND);
      self.pal.blend(Pal.ALL, 0, Pal.BLACK);
      p.state = 2;
    } else {
      p.timer = Math.min(48, p.timer + 8);
      self.win1 = { y0: 80 - p.timer, y1: 80 + p.timer };
      if (p.timer === 48) self.setCB("GF_Star");
    }
  }

  // Lua: intro_movie.lua:451
  createStarSparkle(x: number, y: number, random: number): void {
    // pokefirered/src/intro.c:1995
    const xMod = mod(random, 8) + 2;
    const yMod = this.sparkleYMod!;
    this.sparkleYMod = this.sparkleYMod! + 1;
    if (this.sparkleYMod > 3) this.sparkleYMod = -3;
    x = x + xMod;
    y = y + yMod;
    if (x > 0 && x < Display.W) {
      const spr = createSprite(this, {
        dims: Oam.SQUARE_8, priority: 2, image: this.assets.introSparklesSmall,
        anims: ANIMS_SPARKLES_SMALL, animQuads: this.q.sparkSmall,
        callback: SpriteCB_SparklesSmall_Star, palSlot: OBJ_SPARKLES,
      }, x, y, 1);
      if (spr != null) {
        spr.data[1] = s16(x * 32);
        spr.data[2] = s16(y * 32);
        spr.data[3] = xMod;
        spr.data[4] = yMod;
      }
    }
  }

  // Lua: intro_movie.lua:474
  loadGfxCreateStar(): void {
    // pokefirered/src/intro.c:1953
    const movie = this;
    this.sparkleYMod = this.sparkleYMod ?? 0;
    const spr = createSprite(this, {
      dims: Oam.SQUARE_16, priority: 2, image: this.assets.introStar, palSlot: OBJ_STAR,
      callback: (sprite: Sprite): void => {
        // pokefirered/src/intro.c:2282
        const d = sprite.data;
        d[1] = s16(d[1] - 96);
        d[2] = s16(d[2] + 16);
        d[5] = s16(d[5] + 48);
        sprite.x = Math.floor(d[1] / 16);
        sprite.y = Math.floor(d[2] / 16);
        sprite.y2 = Math.floor((Trig.SINE as number[])[Math.floor(d[5] / 16) + 64 + 1] / 32);
        d[6] = s16(d[6] + 1);
        if (mod(d[6], 8) !== 0) {
          movie.starSeed = isoRandomize1(movie.starSeed);
          movie.createStarSparkle(sprite.x, sprite.y + sprite.y2, Math.floor(movie.starSeed / 65536));
        }
        if (sprite.x < -8) Oam.destroySprite(sprite._id);
      },
    }, 248, 55, 0);
    if (spr != null) {
      spr.data[1] = 248 * 16;
      spr.data[2] = 55 * 16;
    }
    this.starSeed = 354128453;
  }

  // Lua: intro_movie.lua:601
  // pokefirered/src/intro.c:1169
  static IntroCB_GF_Star(self: IntroMovie, p: Ptr): void {
    if (p.state === 0) {
      Audio.playSong(Song.MUS_GAME_FREAK, { restart: true });
      self.loadGfxCreateStar();
      p.timer = 0;
      p.state = 1;
    } else if (p.state === 1) {
      p.timer = p.timer + 1;
      if (p.timer === 30) {
        self.createTask(GFScene_Task_NameSparklesSmall, 1);
        p.timer = 0;
        p.state = 2;
      }
    } else {
      p.timer = p.timer + 1;
      if (p.timer === 90) self.setCB("GF_RevealName");
    }
  }

  // Lua: intro_movie.lua:621
  // pokefirered/src/intro.c:1195
  static IntroCB_GF_RevealName(self: IntroMovie, p: Ptr): void {
    const st = p.state;
    if (st === 0) {
      self.createTask(GFScene_Task_NameSparklesBig, 2);
      p.timer = 0;
      p.state = 1;
    } else if (st === 1) {
      p.timer = p.timer + 1;
      if (p.timer >= 40) p.state = 2;
    } else if (st === 2) {
      self.bld = { bg2: true };
      self.startBlendTask(0, 16, 16, 0, 48);
      p.state = 3;
    } else if (st === 3) {
      Bg.show(BG_GF_TEXT_LOGO);
      p.state = 4;
    } else if (st === 4) {
      if (!self.isBlendTaskActive()) {
        self.bld = null;
        p.timer = 0;
        p.state = 5;
      }
    } else {
      p.timer = p.timer + 1;
      if (p.timer > 50) self.setCB("GF_RevealLogo");
    }
  }

  // Lua: intro_movie.lua:650
  // pokefirered/src/intro.c:1232
  static IntroCB_GF_RevealLogo(self: IntroMovie, p: Ptr): void {
    const st = p.state;
    if (st === 0) {
      self.bld = { obj: true };
      self.startBlendTask(0, 16, 16, 0, 16);
      p.timer = 0;
      p.state = 1;
    } else if (st === 1) {
      self.logoSprite = createSprite(self, {
        dims: Oam.VRECT_32x64, priority: 3, image: self.assets.introGfLogo,
        palSlot: OBJ_GF, objBlend: true,
      }, 120, 70, 4);
      p.state = 2;
    } else if (st === 2) {
      if (!self.isBlendTaskActive()) {
        if (self.gfTextLogo != null) Bg.setImage(BG_GF_TEXT_LOGO, self.gfTextLogo, null);
        p.state = 3;
      }
    } else if (st === 3) {
      destroySprite(self.logoSprite);
      self.logoSprite = null;
      // pokefirered/src/intro.c:2108
      for (let i = 0; i <= 1; i++) {
        createSprite(self, {
          dims: Oam.HRECT_32x8, priority: 3, image: self.assets.introPresents,
          quad: self.q.presents != null ? (self.q.presents[i * 4] ?? null) : null, palSlot: OBJ_GF, objBlend: true,
        }, 104 + 32 * i, 108, 5);
      }
      p.timer = 0;
      p.state = 4;
    } else if (st === 4) {
      p.timer = p.timer + 1;
      if (p.timer > 90) {
        self.bld = { obj: true, bg2: true };
        self.startBlendTask(16, 0, 0, 16, 20);
        p.state = 5;
      }
    } else if (st === 5) {
      if (!self.isBlendTaskActive()) {
        Bg.hide(BG_GF_TEXT_LOGO);
        p.state = 6;
      }
    } else if (st === 6) {
      Oam.destroyAll();
      p.timer = 0;
      p.state = 7;
    } else {
      p.timer = p.timer + 1;
      if (p.timer > 20) {
        self.bld = null;
        self.setCB("Scene1");
      }
    }
  }

  // Lua: intro_movie.lua:739
  static IntroCB_Scene1(self: IntroMovie, p: Ptr): void {
    const A = self.assets;
    const st = p.state;
    if (st === 0) {
      self.pal.blend(Pal.mask(seq(1, 2)), 16, Pal.WHITE);
      Bg.initFromTemplates(seq(
        { bg: BG_SCENE1_GRASS, priority: 0 },
        { bg: BG_SCENE1_BACKGROUND, priority: 0 },
      ));
      if (truthy(A.introScene1Bg)) {
        Bg.setImage(BG_SCENE1_BACKGROUND, A.introScene1Bg, null);
        Bg.setWrap(BG_SCENE1_BACKGROUND, 256, 512);
      }
      if (truthy(A.introScene1Grass)) {
        Bg.setImage(BG_SCENE1_GRASS, A.introScene1Grass, null);
        Bg.setWrap(BG_SCENE1_GRASS, 256, 512);
      }
      self.bgPal = { [BG_SCENE1_GRASS]: 1, [BG_SCENE1_BACKGROUND]: 2 };
      Bg.show(BG_SCENE1_BACKGROUND);
      Bg.hide(BG_SCENE1_GRASS);
      p.state = 1;
    } else if (st === 1) {
      Bg.changeBgX(BG_SCENE1_GRASS, 0, Bg.COORD_SET);
      Bg.changeBgY(BG_SCENE1_GRASS, 0, Bg.COORD_SET);
      Bg.changeBgX(BG_SCENE1_BACKGROUND, 0, Bg.COORD_SET);
      Bg.changeBgY(BG_SCENE1_BACKGROUND, 0, Bg.COORD_SET);
      Bg.show(BG_SCENE1_BACKGROUND);
      p.state = 2;
    } else if (st === 2) {
      Bg.show(BG_SCENE1_GRASS);
      self.createTask(Scene1_Task_AnimateGrass, 0);
      self.pal.beginFade(Pal.mask(seq(1, 2)), -2, 16, 0, Pal.WHITE);
      p.state = 3;
    } else if (st === 3) {
      if (!truthy(self.pal.fadeActive())) {
        Audio.playSong(Song.MUS_INTRO_FIGHT, { restart: true });
        p.timer = 0;
        p.state = 4;
      }
    } else if (st === 4) {
      p.timer = p.timer + 1;
      if (p.timer === 20) {
        self.createTask(Scene1_Task_BgZoom, 0);
        const g = self.findTask(Scene1_Task_AnimateGrass);
        if (g != null) g.data.exiting = true;
      }
      if (p.timer >= 30) {
        self.pal.blend(ALL_BUT_0, 16, Pal.WHITE);
        self.destroyTask(self.findTask(Scene1_Task_AnimateGrass));
        self.destroyTask(self.findTask(Scene1_Task_BgZoom));
        self.setCB("Scene2");
      }
    }
  }

  // Lua: intro_movie.lua:813
  static IntroCB_Scene2(self: IntroMovie, p: Ptr): void {
    const A = self.assets;
    const st = p.state;
    if (st === 0) {
      self.pal.blend(ALL_BUT_0, 16, Pal.WHITE);
      Bg.initFromTemplates(seq(
        { bg: BG_SCENE2_BACKGROUND, priority: 3 },
        { bg: BG_SCENE2_PLANTS, priority: 0 },
        { bg: BG_SCENE2_GENGAR, priority: 2 },
        { bg: BG_SCENE2_NIDORINO, priority: 1 },
      ));
      if (truthy(A.introScene2Bg)) {
        Bg.setImage(BG_SCENE2_BACKGROUND, A.introScene2Bg, null);
        Bg.setWrap(BG_SCENE2_BACKGROUND, 256, 512);
      }
      self.bgPal = {
        [BG_SCENE2_BACKGROUND]: 1, [BG_SCENE2_PLANTS]: 1,
        [BG_SCENE2_GENGAR]: 5, [BG_SCENE2_NIDORINO]: 6,
      };
      Bg.show(BG_SCENE2_BACKGROUND);
      p.state = 1;
    } else if (st === 1) {
      self.pal.blend(ALL_BUT_0, 16, Pal.WHITE);
      if (truthy(A.introScene2Plants)) {
        Bg.setImage(BG_SCENE2_PLANTS, A.introScene2Plants, null);
        Bg.setWrap(BG_SCENE2_PLANTS, wrapWidth(A.introScene2Plants), null);
      }
      if (truthy(A.introScene2NidorinoClose)) {
        Bg.setImage(BG_SCENE2_NIDORINO, A.introScene2NidorinoClose, null);
        Bg.setWrap(BG_SCENE2_NIDORINO, 256, 256);
      }
      if (truthy(A.introScene2GengarClose)) {
        Bg.setImage(BG_SCENE2_GENGAR, A.introScene2GengarClose, null);
        Bg.setWrap(BG_SCENE2_GENGAR, 256, 256);
      }
      for (let i = 0; i <= 3; i++) {
        Bg.changeBgX(i, 0, Bg.COORD_SET);
        Bg.changeBgY(i, 0, Bg.COORD_SET);
      }
      Bg.show(BG_SCENE2_PLANTS);
      Bg.hide(BG_SCENE2_NIDORINO);
      Bg.hide(BG_SCENE2_GENGAR);
      Bg.changeBgY(BG_SCENE2_GENGAR, 0x0001CE00, Bg.COORD_SET);
      Bg.changeBgY(BG_SCENE2_NIDORINO, 0x00002800, Bg.COORD_SET);
      self.createTask(Scene2_Task_PanForest, 0);
      // pokefirered/src/intro.c:1535
      self.s2Nidorino = createSprite(self, {
        dims: Oam.SQUARE_64, priority: 1, image: A.introScene2Nidorino, palSlot: OBJ_NIDORINO,
      }, 168, 80, 11);
      self.s2Gengar = createSprite(self, {
        dims: Oam.SQUARE_64, priority: 1, image: A.introScene2Gengar, palSlot: OBJ_GENGAR,
      }, 72, 80, 12);
      self.pal.blend(ALL_BUT_0, 16, Pal.WHITE);
      p.state = 2;
    } else if (st === 2) {
      self.pal.beginFade(ALL_BUT_0, -2, 16, 0, Pal.WHITE);
      p.state = 3;
    } else if (st === 3) {
      if (!truthy(self.pal.fadeActive())) {
        p.timer = 0;
        p.state = 4;
      }
    } else if (st === 4) {
      p.timer = p.timer + 1;
      if (p.timer >= 60) {
        p.timer = 0;
        self.destroyTask(self.findTask(Scene2_Task_PanForest));
        destroySprite(self.s2Gengar);
        destroySprite(self.s2Nidorino);
        self.createTask(Scene2_Task_PanMons, 0);
        Bg.changeBgY(BG_SCENE2_BACKGROUND, 0x00010000, Bg.COORD_SET);
        Bg.hide(BG_SCENE2_PLANTS);
        Bg.show(BG_SCENE2_BACKGROUND);
        Bg.show(BG_SCENE2_NIDORINO);
        Bg.show(BG_SCENE2_GENGAR);
        p.state = 5;
      }
    } else if (st === 5) {
      p.timer = 0;
      p.state = 6;
    } else {
      p.timer = p.timer + 1;
      if (p.timer >= 60) {
        self.destroyTask(self.findTask(Scene2_Task_PanMons));
        self.setCB("Scene3_Entrance");
      }
    }
  }

  // Lua: intro_movie.lua:1079
  createRecoilDust(x: number, y: number, seed: number): void {
    // pokefirered/src/intro.c:2590
    for (let i = 0; i <= 1; i++) {
      const spr = createSprite(this, {
        dims: Oam.SQUARE_16, priority: 1, image: this.assets.introScene3RecoilDust,
        anims: ANIMS_RECOIL_DUST, animQuads: this.q.dust, palSlot: OBJ_DUST,
        callback: (sprite: Sprite): void => {
          // pokefirered/src/intro.c:2610
          const d = sprite.data;
          if (d[1] === 0) {
            d[2] = sprite.x * 16;
            d[3] = sprite.y * 16;
            d[1] = 1;
          }
          d[2] = d[2] - d[4];
          d[3] = d[3] + d[5];
          sprite.x = Math.floor(d[2] / 16);
          sprite.y = Math.floor(d[3] / 16);
          if (truthy(sprite.animEnded)) {
            Oam.destroySprite(sprite._id);
            return;
          }
          d[8] = d[8] + 1;
          if (d[8] > 1) {
            d[8] = 0;
            sprite.invisible = !truthy(sprite.invisible);
          }
        },
      }, x - 22, y + 24, 10);
      if (spr != null) {
        const cs = s16(seed);
        spr.data[4] = (cs % 13) + 8; // math.fmod
        spr.data[5] = cs % 3; // math.fmod
        spr.data[8] = i;
        seed = s16(mulU32(mod(seed, 65536), RAND_MULT));
      }
    }
  }

  // Lua: intro_movie.lua:1277
  createGengarSwipeSprites(): void {
    // pokefirered/src/intro.c:2224
    const A = this.assets;
    const cb = (sprite: Sprite): void => {
      sprite.invisible = !truthy(sprite.invisible);
      if (truthy(sprite.animEnded)) Oam.destroySprite(sprite._id);
    };
    createSprite(this, {
      dims: Oam.VRECT_32x64, priority: 1, image: A.introScene3Swipe,
      anims: ANIMS_SWIPE, animQuads: this.q.swipeTop, callback: cb, palSlot: OBJ_SWIPE,
    }, 132, 78, 6);
    const spr = createSprite(this, {
      dims: Oam.VRECT_32x64, priority: 1, image: A.introScene3Swipe,
      anims: ANIMS_SWIPE, animQuads: this.q.swipeBottom, callback: cb, palSlot: OBJ_SWIPE,
    }, 132, 118, 6);
    if (spr != null) {
      spr.oam.shape = Oam.HRECT_32x16.shape;
      spr.oam.size = Oam.HRECT_32x16.size;
      Oam.applyCenterToCorner(spr);
      Oam.startAnim(spr, 1);
    }
  }

  // Lua: intro_movie.lua:1300
  static IntroCB_Scene3_Entrance(self: IntroMovie, p: Ptr): void {
    const A = self.assets;
    const st = p.state;
    if (st === 0) {
      self.pal.blend(ALL_BUT_0, 16, Pal.WHITE);
      Bg.initFromTemplates(seq(
        { bg: BG_SCENE3_BACKGROUND, priority: 1 },
        { bg: BG_SCENE3_GENGAR, priority: 0 },
      ));
      if (truthy(A.introScene3Bg)) {
        Bg.setImage(BG_SCENE3_BACKGROUND, A.introScene3Bg, null);
        Bg.setWrap(BG_SCENE3_BACKGROUND, wrapWidth(A.introScene3Bg), null);
      }
      self.bgPal = { [BG_SCENE3_BACKGROUND]: 1, [BG_SCENE3_GENGAR]: 5 };
      Bg.show(BG_SCENE3_BACKGROUND);
      Bg.hide(BG_SCENE3_GENGAR);
      p.state = 1;
      self.win0 = { x0: 0, x1: 120, y0: 32, y1: 128 };
    } else if (st === 1) {
      if (truthy(A.introScene3GengarAnim)) {
        Bg.setImage(BG_SCENE3_GENGAR, A.introScene3GengarAnim, null);
        Bg.setWrap(BG_SCENE3_GENGAR, 256, 512);
      }
      Bg.changeBgX(BG_SCENE3_GENGAR, 0x00001800, Bg.COORD_SET);
      Bg.changeBgY(BG_SCENE3_GENGAR, 0x0001F000, Bg.COORD_SET);
      p.state = 2;
    } else if (st === 2) {
      self.pal.blend(ALL_BUT_0, 0, Pal.WHITE);
      Bg.show(BG_SCENE3_GENGAR);
      self.createTask(Scene3_Task_GengarBounce, 0);
      // pokefirered/src/intro.c:2381
      self.nido = createSprite(self, {
        dims: Oam.SQUARE_64, priority: 1, image: A.introScene3Nidorino,
        anims: ANIMS_NIDORINO, animQuads: self.q.nidorino, palSlot: OBJ_NIDORINO, double: true,
      }, 0, 0, 9);
      if (self.nido != null) {
        const d = self.nido.data;
        d[1] = 0;
        d[2] = idiv((180 - 0) * 16, 52);
        d[3] = 52;
        d[4] = 180;
        d[5] = 0;
        self.nido.x = 0;
        self.nido.y = 100;
        self.nido.callback = Scene3_SpriteCB_NidorinoEnter;
      }
      self.createTask(Scene3_Task_GengarEnter, 0);
      self.createTask(Scene3_Task_BgScroll, 0);
      p.timer = 0;
      p.state = 3;
    } else {
      p.timer = p.timer + 1;
      if (p.timer === 16) {
        const spr = createSprite(self, {
          dims: Oam.HRECT_64x32, priority: 0, image: A.introScene3Grass,
          animQuads: self.q.grass, palSlot: OBJ_GRASS,
        }, 296, 112, 7);
        if (spr != null) {
          spr.quad = self.q.grass != null ? (self.q.grass[0] ?? null) : null;
          spr.callback = SpriteCB_Grass(self);
        }
      }
      const entering = self.nido != null && self.nido.callback === Scene3_SpriteCB_NidorinoEnter;
      if (!entering && self.findTask(Scene3_Task_GengarEnter) == null) {
        self.setCB("Scene3_Fight");
      }
    }
  }

  // Lua: intro_movie.lua:1369
  createGengarSprites(): void {
    // pokefirered/src/intro.c:1877
    const A = this.assets;
    const q = this.q;
    const imgs = seq<any>(
      seq<any>(A.introScene3GengarStatic, q.gengarTL != null ? (q.gengarTL[0] ?? null) : null),
      seq<any>(this.gengarTR, null),
      seq<any>(A.introScene3GengarStatic, q.gengarBL != null ? (q.gengarBL[96] ?? null) : null),
      seq<any>(this.gengarBR, null),
    );
    this.gengarSprites = seq<Sprite>();
    for (let i = 0; i <= 3; i++) {
      const x = (i % 2) * 48 + 49;
      const y = Math.floor(i / 2) * 64 + 72;
      const spr = createSprite(this, {
        dims: Oam.SQUARE_64, priority: 1, image: imgs[i + 1][1], quad: imgs[i + 1][2],
        palSlot: OBJ_GENGAR, double: true,
      }, x, y, 8);
      if (spr != null) {
        if (i % 2 === 1) {
          spr.oam.shape = Oam.SHAPE_V_RECT;
          Oam.applyCenterToCorner(spr);
        }
        this.gengarSprites[i + 1] = spr;
      }
    }
  }

  // Lua: intro_movie.lua:1396
  static IntroCB_Scene3_Fight(self: IntroMovie, p: Ptr): void {
    // pokefirered/src/intro.c:1739
    const st = p.state;
    if (st === 0) {
      p.timer = 0;
      p.state = 1;
    } else if (st === 1) {
      p.timer = p.timer + 1;
      if (p.timer > 30) {
        startNidorinoCry(self);
        p.state = 2;
      }
    } else if (st === 2) {
      if (!nidoRunning(self)) {
        p.timer = 0;
        p.state = 3;
      }
    } else if (st === 3) {
      p.timer = p.timer + 1;
      if (p.timer > 30) {
        const b = self.findTask(Scene3_Task_GengarBounce);
        if (b != null) b.data.paused = true;
        p.gengarAttackLanded = false;
        const t = self.createTask(Scene3_Task_GengarAttack, 4);
        t.data = { state: 0, sinIdx: 64, baseX: Bg.get(BG_SCENE3_GENGAR).scrollX * 256 };
        p.timer = 0;
        p.state = 4;
      }
    } else if (st === 4) {
      if (truthy(p.gengarAttackLanded)) {
        startNidorinoRecoil(self);
        p.state = 5;
      }
    } else if (st === 5) {
      if (!nidoRunning(self)) {
        const b = self.findTask(Scene3_Task_GengarBounce);
        if (b != null) b.data.paused = false;
        p.timer = 0;
        p.state = 6;
      }
    } else if (st === 6) {
      p.timer = p.timer + 1;
      if (p.timer > 16) {
        startNidorinoHop(self.nido, 8, 12, 5);
        p.state = 7;
      }
    } else if (st === 7) {
      if (!nidoRunning(self)) {
        startNidorinoHop(self.nido, 8, 12, 5);
        p.state = 8;
      }
    } else if (st === 8) {
      if (!nidoRunning(self)) {
        p.timer = 0;
        p.state = 9;
      }
    } else if (st === 9) {
      p.timer = p.timer + 1;
      if (p.timer > 20) {
        startNidorinoAttack(self);
        p.timer = 0;
        p.state = 10;
      }
    } else if (st === 10) {
      const b = self.findTask(Scene3_Task_GengarBounce);
      if (b == null || (b.data.state ?? 0) === 0) {
        if (b != null) b.data.paused = true;
        self.createGengarSprites();
        p.state = 11;
      }
    } else if (st === 11) {
      Bg.hide(BG_SCENE3_GENGAR);
      p.timer = 0;
      p.state = 12;
    } else if (st === 12) {
      p.timer = p.timer + 1;
      if (p.timer === 48) {
        self.pal.beginFade(Pal.mask(seq(1, 2)), 2, 0, 16, Pal.WHITE);
      }
      if (p.timer > 120) {
        // pokefirered/src/intro.c:1898
        const n = self.nido;
        if (n != null) {
          n.x = n.x + n.x2;
          n.y = n.y + n.y2;
          Oam.setMatrixAnchor(n, 0, 42);
          n.callback = Oam.DUMMY_CALLBACK;
          Oam.startAffineAnim(n, AFFINE_ZOOM);
        }
        for (const [i, spr] of ipairs<Sprite>(self.gengarSprites ?? {})) {
          Oam.startAffineAnim(spr, AFFINE_ZOOM);
          spr.callback = Oam.DUMMY_CALLBACK;
          Oam.setMatrixAnchor(spr, GENGAR_ZOOM_ANCHORS[i]![1], GENGAR_ZOOM_ANCHORS[i]![2]);
        }
        p.state = 13;
        p.timer = 0;
      }
    } else if (st === 13) {
      p.timer = p.timer + 1;
      if (p.timer > 8) {
        self.pal.setBase(1, Pal.WHITE);
        self.pal.setBase(2, Pal.WHITE);
        self.pal.beginFade(ALL_BUT_0, -2, 0, 16, Pal.BLACK);
        p.state = 14;
      }
    } else if (st === 14) {
      if (!truthy(self.pal.fadeActive())) {
        p.timer = 0;
        p.state = 15;
      }
    } else if (st === 15) {
      p.timer = p.timer + 1;
      if (p.timer > 60) self.setCB("ExitToTitleScreen");
    }
  }

  // Lua: intro_movie.lua:1513
  // pokefirered/src/intro.c:1923
  static IntroCB_ExitToTitleScreen(self: IntroMovie, p: Ptr, t: Task): void {
    if (p.state === 0) {
      self.blackout = true;
      p.state = 1;
    } else {
      self.destroyTask(t);
      self.tasks = seq<Task>();
      Oam.destroyAll();
      Bg.reset();
      self.isDone = true;
      self.phase = "done";
    }
  }

  // --------------------------------------------------------------------
  // Frame driver
  // --------------------------------------------------------------------

  // Lua: intro_movie.lua:1531
  frame(): void {
    this.frames = this.frames + 1;
    if (this.phase === "copyright") {
      this.copyrightFrame();
      return;
    } else if (this.phase === "wait_fade") {
      if (!truthy(this.pal.updateFade())) {
        this.phase = "setup";
        this.state = 0;
      }
      return;
    } else if (this.phase === "setup") {
      this.setupFrame();
      return;
    } else if (this.phase !== "intro") {
      return;
    }
    // pokefirered/src/intro.c:1060
    this.runTasks();
    if (this.isDone) return;
    Oam.animateSprites();
    this.pal.updateFade();
  }

  // Lua: intro_movie.lua:1555
  update(input?: any, dt?: number | null): boolean {
    if (input != null && truthy(input.wasPressed)
      && (truthy(input.wasPressed("a")) || truthy(input.wasPressed("start")) || truthy(input.wasPressed("select")))) {
      this.pendingSkip = true;
    }
    this.accum = this.accum + (dt ?? 1 / 60);
    const step = 1 / IntroMovie.GBA_HZ;
    while (this.accum >= step && !this.isDone) {
      this.accum = this.accum - step;
      this._skipThisFrame = this.pendingSkip && this.phase === "intro";
      if (this._skipThisFrame) this.pendingSkip = false;
      if (this.phase !== "intro") this.pendingSkip = false;
      this.frame();
    }
    return this.isDone;
  }

  // --------------------------------------------------------------------
  // Draw
  // --------------------------------------------------------------------

  // Lua: intro_movie.lua:1576
  applyFx(): void {
    const pal = this.pal;
    const bld = this.bld;
    const alpha = this.bldAlpha ?? { eva: 0, evb: 16 };
    for (let bg = 0; bg <= 3; bg++) {
      const L = Bg.get(bg);
      const slot = this.bgPal[bg];
      const fx = slot != null ? pal.fx(slot) : null;
      L.fx = truthy(fx) ? fx : null;
      L.blend = (bld != null && truthy(bld["bg" + bg])) ? alpha : null;
      L.clip = this.bgClip(bg);
    }
    const objClip = this.bgClip("obj");
    for (let i = 0; i <= Oam.MAX_SPRITES - 1; i++) {
      const s = Oam._sprites[i];
      if (truthy(s.inUse)) {
        const fx = truthy(s.palSlot) ? pal.fx(s.palSlot) : null;
        s.fx = truthy(fx) ? fx : null;
        s.blend = ((bld != null && truthy(bld.obj)) || truthy(s.objBlend)) ? alpha : null;
        s.clip = objClip;
      }
    }
  }

  // Lua: intro_movie.lua:1598
  bgClip(layer: number | string): Clip | null {
    if (this.win1 == null) return null;
    const y0 = this.win1.y0, y1 = this.win1.y1;
    let clip: Clip = { x: 0, y: y0, w: Display.W, h: Math.max(0, y1 - y0) };
    if (layer === BG_SCENE3_GENGAR && this.win0 != null) {
      clip = { x: this.win0.x1, y: y0, w: Display.W - this.win0.x1, h: clip.h };
    }
    return clip;
  }

  // Lua: intro_movie.lua:1608
  draw(): void {
    if (this.blackout || this.isDone) {
      G.clear(0, 0, 0, 1);
      return;
    }
    this.applyFx();
    Display.composeHardware({
      clear: seq(0, 0, 0, 1),
      animate: false,
      build: true,
      pretOrder: true,
    });
  }
}

export default IntroMovie;
