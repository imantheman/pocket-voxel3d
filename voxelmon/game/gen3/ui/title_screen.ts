// Port of gen1recomp src/ui/game3/title_screen.lua (GPLv3 + additional terms; see LICENSE.md).
// The FRLG title screen (pokefirered/src/title_screen.c): the scene state
// machine, its task list, the flame / leaf / slash sprites and the per-frame
// palette effects, stepped at the GBA's 59.7275 Hz.
//
// The `love and love.graphics...` guards always hold under LÖVE, so only that
// branch is ported (platform G).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { Display } from "../core/display.ts";
import { Bg } from "../core/bg.ts";
import { Oam } from "../core/oam.ts";
import { Pal } from "../core/pal_fade.ts";
import { Audio } from "../core/audio.ts";
import { Song } from "../core/song_ids.ts";
import { Rng } from "../core/rng.ts";
// src.core.GameVersion: its Gen 3 port lives with the importer (as profile.ts uses it)
import { GameVersion } from "../../../import/gen3/game_version.ts";
import { G } from "../platform/graphics.ts";
import type { Image, Quad } from "../platform/image.ts";
import { insert, ipairs, len, seq } from "../platform/lt.ts";
import { mod } from "../../../import/gen3/lua.ts";

type TaskFn = (T: TitleState, t: Task) => void;
interface Task { fn: TaskFn; priority: number; data: any; alive: boolean }
export interface TitleState {
  leafgreen: boolean;
  assets: any;
  flameQuads: Record<number, Quad> | undefined;
  pal: any;
  tasks: (Task | null)[];
  accum: number;
  initState: number;
  vblanks: number;
  input: Record<string, boolean>;
  pending?: Record<string, boolean> | null;
  runIdx?: number | null;
  scene?: number;
  sceneState?: number;
  result?: string;
  running?: boolean;
  copyWithPress?: any;
  copyNoPress?: any;
  slashImage?: any;
  win0?: { mode: string; x: number } | null;
  slashWin?: boolean;
  slash?: any;
  band?: number | null;
  bandStop?: boolean | null;
  d2?: number;
  pressStartHidden?: boolean;
}

const GBA_HZ = 16777216 / 280896;

const SPECIES_CHARIZARD = 6;

const BG_LOGO = 0;
const BG_MON = 1;
const BG_COPYRIGHT = 2;
const BG_BORDER = 3;

const PAL_MON = 13;
const PAL_BORDER = 14;
const PAL_COPYRIGHT = 15;
const OBJ_FLAME = 0;
const OBJ_SLASH = 1;

const FLASH_WHITE = seq(30, 30, 31);

const SCENE = { INIT: 0, FLASHSPRITE: 1, FADEIN: 2, RUN: 3, RESTART: 4, CRY: 5 };
const S = SCENE;

// pokefirered/src/title_screen.c:303
const FLAME_X = seq(4, 16, 26, 32, 48, 200, 216, 224, 232, 60, 76, 92, 108, 128, 144);

// pokefirered/src/title_screen.c:106
const ANIMS_FLAME: Record<number, any> = {
  0: seq<any>(
    { img: 0, dur: 3 }, { img: 4, dur: 6 }, { img: 8, dur: 6 }, { img: 12, dur: 6 },
    { img: 16, dur: 6 }, { img: 20, dur: 6 }, { img: 24, dur: 6 }, { img: 28, dur: 6 },
    { img: 32, dur: 6 }, { img: 36, dur: 6 }, "end",
  ),
};

// Lua: title_screen.lua:42
function mulU32(a: number, b: number): number {
  const aL = mod(a, 65536), aH = mod(Math.floor(a / 65536), 65536);
  const bL = mod(b, 65536), bH = mod(Math.floor(b / 65536), 65536);
  return mod(aL * bL + mod(aL * bH + aH * bL, 65536) * 65536, 4294967296);
}

// pokefirered/src/title_screen.c:1212
// Lua: title_screen.lua:49
function titleRand(t: any): number {
  t.seed = mod(mulU32(t.seed, 1103515245) + 24691, 4294967296);
  return Math.floor(t.seed / 65536);
}

// Lua: title_screen.lua:54
function cmod(a: number, n: number): number {
  return a % n; // math.fmod: truncated, like JS %
}

// Lua: title_screen.lua:58
function composite(images: any): any {
  const canvas = G.newCanvas(Display.W, Display.H);
  canvas.setFilter("nearest", "nearest");
  G.push("all");
  G.setCanvas(canvas);
  G.origin();
  G.setScissor();
  G.setShader();
  G.clear(0, 0, 0, 0);
  G.setColor(1, 1, 1, 1);
  for (const [, img] of ipairs<Image>(images)) {
    if (img) G.draw(img, 0, 0);
  }
  G.pop();
  return canvas;
}

// ----------------------------------------------------------------------
// Tasks
// ----------------------------------------------------------------------

// Lua: title_screen.lua:80
function createTask(T: TitleState, fn: TaskFn, priority: number): Task {
  const t: Task = { fn, priority, data: {}, alive: true };
  let pos = len(T.tasks) + 1;
  for (const [i, other] of ipairs<Task>(T.tasks)) {
    if (other.priority > priority) {
      pos = i;
      break;
    }
  }
  insert(T.tasks, pos, t);
  if (T.runIdx != null && pos <= T.runIdx) T.runIdx = T.runIdx + 1;
  return t;
}

// Lua: title_screen.lua:94
function findTask(T: TitleState, fn: TaskFn): Task | null {
  for (const [, t] of ipairs<Task>(T.tasks)) {
    if (t.alive && t.fn === fn) return t;
  }
  return null;
}

// Lua: title_screen.lua:101
function destroyTask(t: Task | null): void {
  if (t) t.alive = false;
}

// Lua: title_screen.lua:105
function runTasks(T: TitleState): void {
  T.runIdx = 1;
  while (T.runIdx <= len(T.tasks)) {
    const t = T.tasks[T.runIdx]!;
    if (t.alive) t.fn(T, t);
    T.runIdx = T.runIdx + 1;
  }
  T.runIdx = null;
  const keep: (Task | null)[] = [null];
  for (const [, t] of ipairs<Task>(T.tasks)) {
    if (t.alive) keep[len(keep) + 1] = t;
  }
  T.tasks = keep;
}

// ----------------------------------------------------------------------
// Sprites
// ----------------------------------------------------------------------

// Lua: title_screen.lua:124
function SpriteCallback_TitleScreenFlame(sprite: any): void {
  // pokefirered/src/title_screen.c:956
  const d = sprite.data;
  d[1] = d[1] - d[2];
  sprite.x = Math.floor(d[1] / 16);
  if (sprite.x < -8) {
    Oam.destroySprite(sprite._id);
    return;
  }
  d[3] = d[3] + d[4];
  sprite.y = Math.floor(d[3] / 16);
  if (sprite.y < 16 || sprite.y > 200) {
    Oam.destroySprite(sprite._id);
    return;
  }
  if (sprite.animEnded) {
    Oam.destroySprite(sprite._id);
  }
}

// Lua: title_screen.lua:144
function createFlameSprite(T: TitleState, x: number, y: number, xspeed: number, yspeed: number, visible: boolean): boolean {
  // pokefirered/src/title_screen.c:985
  const [, spr] = Oam.createSprite({
    dims: Oam.SQUARE_16, priority: 3,
    image: visible ? T.assets.titleFlames : null,
    anims: ANIMS_FLAME, animQuads: T.flameQuads,
    callback: SpriteCallback_TitleScreenFlame,
  }, x, y, 0);
  if (!spr) return false;
  spr.palSlot = Pal.objSlot(OBJ_FLAME);
  spr.data[1] = x * 16;
  spr.data[2] = xspeed;
  spr.data[3] = y * 16;
  spr.data[4] = yspeed;
  return true;
}

// pokefirered/src/title_screen.c:1074-1202 (LEAFGREEN).
// Lua: title_screen.lua:162
const LEAF_ANIM: Record<number, any> = { 0: seq<any>() };
for (let frame = 0; frame <= 10; frame++) {
  LEAF_ANIM[0][len(LEAF_ANIM[0]) + 1] = { img: frame * 4, dur: 8 };
}
LEAF_ANIM[0][12] = { jump: 0 };
const STREAK_Y = seq(40, 80, 110, 60, 90, 70, 100, 50);

// Lua: title_screen.lua:168
function Task_LeafSpawner(T: TitleState, t: Task): void {
  const d = t.data;
  if (!d.started) {
    d.started = true; d.seed = 30840; d.timer = 0; d.delay = 0;
    for (let i = 0; i <= 3; i++) {
      const [, spr] = Oam.createSprite({
        dims: { shape: 1, size: 2, w: 32, h: 16 }, priority: 3,
        image: T.assets.titleStreak,
        callback: (sprite: any) => {
          sprite.x = sprite.x - 7;
          if (sprite.x < -16) {
            sprite.x = 256;
            sprite.data[7] = mod(sprite.data[7] + 1, len(STREAK_Y));
            sprite.y = STREAK_Y[sprite.data[7] + 1];
          }
        },
      }, 256 + 40 * i, STREAK_Y[i + 1], 255);
      if (spr) { spr.data[7] = i; spr.palSlot = Pal.objSlot(OBJ_FLAME); }
    }
    return;
  }
  d.timer = d.timer + 1;
  if (d.timer < d.delay) return;
  d.timer = 0; d.delay = mod(titleRand(d), 6) + 6;
  const r = mod(titleRand(d), 30);
  const xspeed = r < 6 ? 16 : (r < 12 ? 24 : 48);
  const yspeed = mod(titleRand(d), 4) - 2, y = mod(titleRand(d), 88) + 32;
  const [, spr] = Oam.createSprite({
    dims: Oam.SQUARE_16, priority: 3, image: T.assets.titleFlames,
    anims: LEAF_ANIM, animQuads: T.flameQuads,
    callback: SpriteCallback_TitleScreenFlame,
  }, 240, y, 0);
  if (spr) {
    spr.palSlot = Pal.objSlot(OBJ_FLAME);
    spr.data[1] = 240 * 16; spr.data[2] = xspeed; spr.data[3] = y * 16; spr.data[4] = yspeed;
  }
}

// Lua: title_screen.lua:206
function Task_FlameSpawner(T: TitleState, t: Task): void {
  // pokefirered/src/title_screen.c:1019
  const d = t.data;
  if (!d.started) {
    d.seed = 30840;
    d.timer = 0;
    d.delay = 0;
    d.offsetX = 0;
    d.started = true;
    return;
  }
  d.timer = d.timer + 1;
  if (d.timer >= d.delay) {
    d.timer = 0;
    titleRand(d);
    d.delay = 18;
    let xspeed = cmod(titleRand(d), 4) - 2;
    let yspeed = cmod(titleRand(d), 8) - 16;
    const y = cmod(titleRand(d), 3) + 116;
    const x = cmod(titleRand(d), Display.W);
    createFlameSprite(T, x, y, xspeed, yspeed, cmod(titleRand(d), 16) >= 8);
    for (let i = 1; i <= 15; i++) {
      createFlameSprite(T, d.offsetX + FLAME_X[i]!, y, xspeed, yspeed, true);
      xspeed = cmod(titleRand(d), 4) - 2;
      yspeed = cmod(titleRand(d), 8) - 16;
    }
    d.offsetX = d.offsetX + 1;
    if (d.offsetX > 3) d.offsetX = 0;
  }
}

// Lua: title_screen.lua:237
function SpriteCallback_Slash(sprite: any): void {
  // pokefirered/src/title_screen.c:1270
  const d = sprite.data;
  if (d[1] === 0) {
    if (d[3] !== 0) {
      sprite.invisible = true;
      d[1] = 2;
    }
    d[2] = d[2] - 1;
    if (d[2] === 0) {
      sprite.invisible = false;
      d[1] = 1;
    }
  } else if (d[1] === 1) {
    sprite.x = sprite.x + 9;
    if (sprite.x === 67) sprite.y = sprite.y - 7;
    if (sprite.x === 148) sprite.y = sprite.y + 7;
    if (sprite.x > Display.W + 32) {
      sprite.invisible = true;
      if (d[3] !== 0) {
        d[1] = 2;
      } else {
        sprite.x = -32;
        d[2] = 540;
        d[1] = 0;
      }
    }
  }
}

// Lua: title_screen.lua:267
function createSlashSprite(_T: TitleState): any {
  // pokefirered/src/title_screen.c:1245
  const [, spr] = Oam.createSprite({
    dims: Oam.SQUARE_64, priority: 0, callback: SpriteCallback_Slash,
  }, -32, 27, 1);
  if (spr) {
    spr.data[2] = 540;
    spr.objWindow = true;
  }
  return spr;
}

// Lua: title_screen.lua:279
function slashDeactivated(spr: any): boolean {
  return spr != null && !!spr.inUse && spr.data[1] === 2;
}

// Lua: title_screen.lua:283
function deactivateSlash(spr: any): void {
  if (spr && spr.inUse) spr.data[3] = 1;
}

// ----------------------------------------------------------------------
// Window slide / press start blink
// ----------------------------------------------------------------------

// Lua: title_screen.lua:291
function Task_TitleScreen_SlideWin0(T: TitleState, t: Task): void {
  // pokefirered/src/title_screen.c:756
  const d = t.data;
  d.state = d.state ?? 0;
  d.pos = d.pos ?? 0;
  if (d.state === 0) {
    T.win0 = { mode: "border", x: 0 };
    T.pal.blend(Pal.mask(seq(PAL_BORDER)), 0, Pal.BLACK);
    d.state = 1;
  } else if (d.state === 1) {
    d.pos = d.pos + 24 * 16;
    let x = Math.floor(d.pos / 16);
    if (x >= Display.W) {
      x = Display.W;
      d.state = 2;
    }
    T.win0!.x = x;
  } else if (d.state === 2) {
    d.wait = (d.wait ?? 0) + 1;
    if (d.wait >= 10) {
      d.wait = 0;
      d.state = 3;
    }
  } else if (d.state === 3) {
    T.win0 = { mode: "copyright", x: Display.W };
    T.pal.blend(Pal.mask(seq(PAL_COPYRIGHT)), 0, Pal.BLACK);
    d.pos = 10 * 24 * 16;
    d.state = 4;
  } else if (d.state === 4) {
    d.pos = d.pos - 24 * 16;
    let x = Math.floor(d.pos / 16);
    if (x <= 0) {
      x = 0;
      d.state = 5;
    }
    T.win0!.x = x;
  } else {
    T.win0 = null;
    destroyTask(t);
  }
}

// Lua: title_screen.lua:333
function Task_TitleScreen_BlinkPressStart(T: TitleState, t: Task): void {
  // pokefirered/src/title_screen.c:815
  const d = t.data;
  d.timer = d.timer ?? 0;
  d.hidden = d.hidden ?? false;
  if (d.signal && T.pal.fadeActive()) d.fading = true;
  if (d.fading && !T.pal.fadeActive()) {
    destroyTask(t);
    return;
  }
  const limit = d.hidden ? 30 : 60;
  d.timer = d.timer + 1;
  if (d.timer >= limit) {
    d.timer = 0;
    d.hidden = !d.hidden;
    T.pressStartHidden = d.hidden;
    if (d.fading && T.pal.fade) {
      T.pal.blend(Pal.mask(seq(PAL_COPYRIGHT)), T.pal.fade.y, T.pal.fade.color);
    }
  }
}

// Lua: title_screen.lua:355
function signalEndBlink(T: TitleState): void {
  const t = findTask(T, Task_TitleScreen_BlinkPressStart);
  if (t) t.data.signal = true;
}

// ----------------------------------------------------------------------
// Scenes (pokefirered/src/title_screen.c:472)
// ----------------------------------------------------------------------

// Lua: title_screen.lua:364
function setScene(T: TitleState, scene: number): void {
  T.sceneState = 0;
  T.scene = scene;
}

// Lua: title_screen.lua:369
function loadMainPalsAndResetBgs(T: TitleState): void {
  // pokefirered/src/title_screen.c:903
  destroyTask(findTask(T, Task_TitleScreen_SlideWin0));
  T.pal.clearGradual();
  T.pal.resetFade();
  for (let i = 0; i <= 15; i++) T.pal.restore(i);
  T.win0 = null;
  T.slashWin = false;
  for (let i = 0; i <= 3; i++) Bg.show(i);
}

// Lua: title_screen.lua:380
function sceneInit(T: TitleState): void {
  Bg.hide(BG_LOGO);
  Bg.show(BG_MON);
  Bg.show(BG_COPYRIGHT);
  Bg.show(BG_BORDER);
  setScene(T, S.FLASHSPRITE);
}

// Lua: title_screen.lua:388
function sceneFlashSprite(T: TitleState): void {
  // pokefirered/src/title_screen.c:494
  if (T.sceneState === 0) {
    T.band = 128;
    T.sceneState = 1;
  } else if (T.sceneState === 1) {
    T.band = T.band! - 4;
    if (T.band < 0) {
      T.bandStop = true;
      T.sceneState = 2;
    }
  } else {
    T.band = null;
    T.bandStop = null;
    setScene(T, S.FADEIN);
  }
}

// Lua: title_screen.lua:406
function sceneFadeIn(T: TitleState): void {
  // pokefirered/src/title_screen.c:521
  const st = T.sceneState;
  const pal = T.pal;
  const monMask = Pal.mask(seq(PAL_MON));
  if (st === 0) {
    T.d2 = 0;
    T.sceneState = 1;
  } else if (st === 1) {
    T.d2 = T.d2! + 1;
    if (T.d2 > 10) {
      pal.setGray(PAL_MON, true);
      pal.beginFade(monMask, 9, 16, 0, Pal.BLACK);
      T.sceneState = 2;
    }
  } else if (st === 2) {
    if (!pal.fadeActive()) {
      T.d2 = 0;
      T.sceneState = 3;
    }
  } else if (st === 3) {
    T.d2 = T.d2! + 1;
    if (T.d2 > 36) {
      createTask(T, Task_TitleScreen_SlideWin0, 3);
      pal.blendGradually(monMask, -4, 1, 16, FLASH_WHITE);
      T.d2 = 0;
      T.sceneState = 4;
    }
  } else if (st === 4) {
    if (!pal.gradualActive()) {
      pal.blendGradually(monMask, -4, 15, 0, FLASH_WHITE);
      T.sceneState = 5;
    }
  } else if (st === 5) {
    T.d2 = T.d2! + 1;
    if (T.d2 > 20) {
      T.d2 = 0;
      pal.blendGradually(monMask, -4, 1, 16, FLASH_WHITE);
      T.sceneState = 6;
    }
  } else if (st === 6) {
    if (!pal.gradualActive()) {
      pal.blendGradually(monMask, -4, 15, 0, FLASH_WHITE);
      T.sceneState = 7;
    }
  } else if (st === 7) {
    T.d2 = T.d2! + 1;
    if (T.d2 > 20) {
      T.d2 = 0;
      pal.blendGradually(monMask, -3, 0, 16, FLASH_WHITE);
      T.sceneState = 8;
    }
  } else if (st === 8) {
    if (!pal.gradualActive()) {
      const logoMask = Pal.mask(seq(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12), seq(OBJ_SLASH));
      pal.blend(logoMask, 16, FLASH_WHITE);
      pal.beginFade(logoMask, 1, 16, 0, FLASH_WHITE);
      Bg.show(BG_LOGO);
      pal.setGray(PAL_MON, false);
      pal.blendGradually(monMask, 1, 15, 0, FLASH_WHITE);
      T.sceneState = 9;
    }
  } else {
    if (!pal.gradualActive() && !pal.fadeActive()) {
      setScene(T, S.RUN);
    }
  }
}

// Lua: title_screen.lua:475
function sceneRun(T: TitleState, pressed: Record<string, boolean>): void {
  // pokefirered/src/title_screen.c:613
  if (T.sceneState === 0) {
    createTask(T, Task_TitleScreen_BlinkPressStart, 0);
    T.pressStartHidden = false;
    createTask(T, T.leafgreen ? Task_LeafSpawner : Task_FlameSpawner, 5);
    T.slashWin = true;
    T.slash = createSlashSprite(T);
    T.sceneState = 1;
  }
  if (pressed.a || pressed.start) {
    // pcall(require, "src.core.game3.rng") and Rng.seedNewGame: ported, so the guard always holds
    // pokefirered/src/title_screen.c:632: SetTitleScreenScene_Cry → SeedRngAndSetTrainerId
    Rng.seedNewGame();
    setScene(T, S.CRY);
  } else if (!findTask(T, Title.Task_TitleScreenTimer)) {
    setScene(T, S.RESTART);
  }
}

// Lua: title_screen.lua:497
function sceneRestart(T: TitleState): void {
  // pokefirered/src/title_screen.c:667
  const st = T.sceneState;
  if (st === 0) {
    deactivateSlash(T.slash);
    T.sceneState = 1;
  } else if (st === 1) {
    if (!T.pal.fadeActive() && slashDeactivated(T.slash)) {
      Audio.fadeOutBgm(10);
      T.pal.beginFade(Pal.ALL, 3, 0, 16, Pal.BLACK);
      signalEndBlink(T);
      T.sceneState = 2;
    }
  } else if (st === 2) {
    if (Audio.isBgmStopped() && !T.pal.fadeActive()) {
      destroyTask(findTask(T, Task_TitleScreen_BlinkPressStart));
      T.d2 = 0;
      T.sceneState = 3;
    }
  } else if (st === 3) {
    T.d2 = T.d2! + 1;
    if (T.d2 >= 20) {
      destroyTask(findTask(T, Task_TitleScreen_BlinkPressStart));
      T.sceneState = 4;
    }
  } else {
    T.result = "restart";
  }
}

// Lua: title_screen.lua:527
function sceneCry(T: TitleState): void {
  // pokefirered/src/title_screen.c:708
  const st = T.sceneState;
  if (st === 0) {
    if (!T.pal.fadeActive()) {
      Audio.playCry(T.leafgreen ? 3 : SPECIES_CHARIZARD, 0);
      deactivateSlash(T.slash);
      T.d2 = 0;
      T.sceneState = 1;
    }
  } else if (st === 1) {
    if (T.d2! < 90) {
      T.d2 = T.d2! + 1;
    } else if (slashDeactivated(T.slash)) {
      T.pal.beginFade(Pal.ALL - Pal.mask(null, seq(12, 13, 14, 15)), 0, 0, 16, Pal.WHITE);
      signalEndBlink(T);
      Audio.fadeOutBgm(4);
      T.sceneState = 2;
    }
  } else {
    if (!T.pal.fadeActive()) {
      T.result = "menu";
    }
  }
}

// pokefirered/src/title_screen.c:431
// Lua: title_screen.lua:554
function Task_TitleScreenTimer(T: TitleState, t: Task): void {
  if (T.vblanks >= 2700) destroyTask(t);
}

// Lua: title_screen.lua:558
function Task_TitleScreenMain(T: TitleState, _t: Task): void {
  // pokefirered/src/title_screen.c:448
  const pressed = T.input;
  if ((pressed.a || pressed.b || pressed.start)
      && T.scene !== S.RUN && T.scene !== S.RESTART && T.scene !== S.CRY) {
    // pcall(require, "src.core.game3.rng") and Rng.perturb: ported, so the guard always holds
    Rng.perturb();
    T.band = null;
    loadMainPalsAndResetBgs(T);
    setScene(T, S.RUN);
    return;
  }
  if (T.scene === S.INIT) {
    sceneInit(T);
  } else if (T.scene === S.FLASHSPRITE) {
    sceneFlashSprite(T);
  } else if (T.scene === S.FADEIN) {
    sceneFadeIn(T);
  } else if (T.scene === S.RUN) {
    sceneRun(T, pressed);
  } else if (T.scene === S.RESTART) {
    sceneRestart(T);
  } else if (T.scene === S.CRY) {
    sceneCry(T);
  }
}

// ----------------------------------------------------------------------
// Lifecycle
// ----------------------------------------------------------------------

// Lua: title_screen.lua:589
function buildQuads(state: any): void {
  const img = state.assets && state.assets.titleFlames;
  if (!img) return;
  const [iw, ih] = img.getDimensions();
  state.flameQuads = {};
  for (let f = 0; f <= Math.floor(ih / 16) - 1; f++) {
    state.flameQuads[f * 4] = G.newQuad(0, f * 16, 16, 16, iw, ih);
  }
}

// Lua: title_screen.lua:599
function enter(state: any): TitleState {
  Oam.destroyAll();
  Bg.reset();
  Title.buildQuads(state);
  const T: TitleState = {
    leafgreen: GameVersion.get() === "leafgreen",
    assets: state.assets ?? {},
    flameQuads: state.flameQuads,
    pal: Pal.new(),
    tasks: seq<Task>(),
    accum: 0,
    initState: 0,
    vblanks: 0,
    input: {},
  };
  if (!state._titleCanvases) {
    state._titleCanvases = {
      withPress: composite(seq(state.copyrightLayer, state.pressStart)),
      noPress: state.copyrightLayer,
    };
  }
  T.copyWithPress = state._titleCanvases.withPress;
  T.copyNoPress = state._titleCanvases.noPress;
  T.slashImage = T.assets.titleSlash;
  state.title = T;
  state._titleActive = true;
  return T;
}

// Lua: title_screen.lua:628
function leave(state: any): void {
  state._titleActive = false;
  state.title = null;
  Oam.destroyAll();
  Bg.reset();
}

// Lua: title_screen.lua:635
function initFrame(T: TitleState, state: any): void {
  // pokefirered/src/title_screen.c:342
  if (T.initState === 0) {
    Oam.destroyAll();
    Bg.reset();
    Bg.initFromTemplates(seq(
      { bg: BG_LOGO, priority: 0 },
      { bg: BG_MON, priority: 1 },
      { bg: BG_COPYRIGHT, priority: 2 },
      { bg: BG_BORDER, priority: 3 },
    ));
    T.initState = 1;
  } else if (T.initState === 1) {
    if (state.titleLogo) Bg.setImage(BG_LOGO, state.titleLogo, null);
    if (state.titleMon) Bg.setImage(BG_MON, state.titleMon, null);
    if (T.copyWithPress) Bg.setImage(BG_COPYRIGHT, T.copyWithPress, null);
    if (state.titleBorder) Bg.setImage(BG_BORDER, state.titleBorder, null);
    T.initState = 2;
  } else {
    T.pal.blend(Pal.BG, 16, Pal.BLACK);
    setScene(T, S.INIT);
    createTask(T, Task_TitleScreenMain, 4);
    createTask(T, Title.Task_TitleScreenTimer, 2);
    Audio.playSong(Song.MUS_TITLE, { restart: true });
    T.running = true;
  }
}

// Lua: title_screen.lua:663
function frame(T: TitleState, state: any): void {
  if (!T.running) {
    initFrame(T, state);
    return;
  }
  T.vblanks = T.vblanks + 1;
  // pokefirered/src/title_screen.c:412
  runTasks(T);
  T.pal.runGradual();
  Oam.animateSprites();
  T.pal.updateFade();
}

// The keys update() latches (Brian builds this table per call; hoisted, same keys).
const LATCH_KEYS = seq("a", "b", "start", "select");

// Lua: title_screen.lua:676
function update(state: any, input: any, dt?: number): string | undefined {
  const T: TitleState | null = state.title;
  if (!T) return undefined;
  if (input && input.wasPressed) {
    for (const [, k] of ipairs<string>(LATCH_KEYS)) {
      if (input.wasPressed(k)) { T.pending = T.pending ?? {}; T.pending[k] = true; }
    }
  }
  T.accum = T.accum + (dt ?? 1 / 60);
  const step = 1 / GBA_HZ;
  while (T.accum >= step && !T.result) {
    T.accum = T.accum - step;
    T.input = T.pending ?? {};
    T.pending = null;
    frame(T, state);
  }
  return T.result;
}

// Lua: title_screen.lua:695
function scene(state: any): number | undefined {
  return state.title ? state.title.scene : undefined;
}

// ----------------------------------------------------------------------
// Draw
// ----------------------------------------------------------------------

// Brian builds this table per draw; hoisted (same contents).
const FX_SLOT: Record<number, number> = { [BG_LOGO]: 0, [BG_MON]: PAL_MON, [BG_COPYRIGHT]: PAL_COPYRIGHT, [BG_BORDER]: PAL_BORDER };

// Lua: title_screen.lua:703
function applyFx(T: TitleState): void {
  const pal = T.pal;
  const slot = FX_SLOT;
  for (let bg = 0; bg <= 3; bg++) {
    const L = Bg.get(bg)!;
    L.fx = pal.fx(slot[bg]);
    L.clip = null;
    L.offsetX = 0;
  }
  const L = Bg.get(BG_COPYRIGHT)!;
  L.image = T.pressStartHidden ? T.copyNoPress : T.copyWithPress;
  if (T.band != null && !T.bandStop) {
    const mon = Bg.get(BG_MON)!;
    mon.fx = pal.fx(PAL_MON, { band: T.band }) || { band: T.band };
  }
  const s = T.slash;
  if (T.slashWin && s && s.inUse && !s.invisible && T.slashImage) {
    const logo = Bg.get(BG_LOGO)!;
    logo.fx = pal.fx(0, { objWin: { image: T.slashImage, x: s.x - 32, y: s.y - 32, w: 64, h: 64, bldy: 13 } });
  }
  const w = T.win0;
  if (w && w.mode === "border") {
    Bg.get(BG_BORDER)!.clip = { x: 0, y: 0, w: w.x, h: Display.H };
  } else if (w && w.mode === "copyright") {
    const c = Bg.get(BG_COPYRIGHT)!;
    c.clip = { x: w.x, y: 0, w: Display.W - w.x, h: Display.H };
    c.offsetX = w.x;
  }
  for (let i = 0; i <= Oam.MAX_SPRITES - 1; i++) {
    const spr = Oam._sprites![i]!;
    if (spr.inUse && spr.palSlot != null) spr.fx = pal.fx(spr.palSlot);
  }
}

// Lua: title_screen.lua:737
function draw(state: any): void {
  const T: TitleState | null = state.title;
  if (!T) {
    G.clear(0, 0, 0, 1);
    return;
  }
  if (!T.running) {
    G.clear(0, 0, 0, 1);
    return;
  }
  applyFx(T);
  Display.composeHardware({
    clear: seq(0, 0, 0, 1),
    animate: false,
    build: true,
    pretOrder: true,
  });
}

export const Title = {
  SCENE,
  Task_TitleScreenTimer,
  buildQuads,
  enter,
  leave,
  update,
  scene,
  draw,
};

export default Title;
