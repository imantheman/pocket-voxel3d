// Port of gen1recomp src/core/game3/mon_anim.lua (GPLv3 + additional terms; see LICENSE.md).
// The front/back pic animations: pret's pokemon_animation.c sprite callbacks
// (affine scale/rotate, x2/y2 offsets, palette blends) plus sprite.c's frame
// anim commands and a tiny per-sprite task list, run on a plain sprite table.
// The anim functions (F.*) are a mechanical port of Brian's, line for line.

import { Trig } from "./trig.ts";
import { MonAnimData as Data, type MonAnimCmd } from "./mon_anim_data.ts";
import { Constants } from "./constants.ts";
import { Audio } from "./audio.ts";
import { Task } from "./task.ts";
import { GameVersion } from "../shared/core/GameVersion.ts";
import { G, type Shader } from "../platform/graphics.ts";
import { newImageData, type Image } from "../platform/image.ts";
import { insert, ipairs, len, pairs, remove, seq } from "../platform/lt.ts";
import { format, mod as luaMod, tonumber, tostring, truthy } from "../../../import/gen3/lua.ts";

export type SpriteCallback = (sprite: MonSprite) => void;

export interface MonTask {
  fn: (sprite: MonSprite, task: MonTask) => void;
  priority: number;
  data: Record<string, unknown>;
  active: boolean;
  state?: number;
  animId?: number;
  battlerId?: number;
  speciesId?: number;
  delay?: number;
}

export interface MonSprite {
  species: number;
  /** pret's sprite->data[0..7] (Lua keys 0..7). */
  data: number[];
  x2: number;
  y2: number;
  invisible: boolean;
  hFlip: boolean;
  affineMode: string;
  affineAnimNum: number;
  affineAnimBeginning: boolean;
  matrix: { xScale: number; yScale: number; rotation: number };
  centerToCornerVecX: number;
  paletteNum: number;
  blendCoeff: number;
  blendColor: number;
  /** anim number (0..) -> a sequence of commands */
  anims: Record<number, (MonAnimCmd | null)[]>;
  animNum: number;
  animCmdIndex: number;
  animDelayCounter: number;
  animLoopCounter: number;
  animBeginning: boolean;
  animEnded: boolean;
  animPaused: boolean;
  frame: number;
  callback: SpriteCallback;
  /** a sequence (lt.ts) */
  tasks: (MonTask | null)[];
  frames: number;
  animId?: number;
  summary?: boolean;
  task?: unknown;
  stopped?: boolean;
}

export interface MonSpriteOpts {
  hFlip?: boolean;
  affineMode?: string;
  paletteNum?: number;
  data?: Record<number, number> | number[];
}

export interface MonAnimOpts {
  cry?: (species: unknown, pan: number) => unknown;
  noAnimations?: boolean;
}

export interface MonRunOpts {
  limit?: number;
  tasksFirst?: boolean;
  onStep?: (sprite: MonSprite) => void;
  onDone?: (sprite: MonSprite) => void;
}

export interface MonTransform {
  x2: number;
  y2: number;
  invisible: boolean;
  frame: number;
  blendCoeff: number;
  blendColor: number;
  sx: number;
  sy: number;
  rotation: number;
}

interface AnimState { delay: number; speed: number; runs: number; rotation: number; data: number }

// bit.band / bit.arshift (LuaJIT: 32-bit)
const band = (a: number, b: number): number => a & b;
const arshift = (a: number, n: number): number => a >> n;
const floor = Math.floor;

// Lua: mon_anim.lua:13
function s16(v: number): number {
  v = band(floor(v), 0xFFFF);
  if (v >= 0x8000) v = v - 0x10000;
  return v;
}

// Lua: mon_anim.lua:19
function u16(v: number): number { return band(floor(v), 0xFFFF); }
// Lua: mon_anim.lua:20
function u8(v: number): number { return band(floor(v), 0xFF); }

// Lua: mon_anim.lua:22
function s8(v: number): number {
  v = band(floor(v), 0xFF);
  if (v >= 0x80) v = v - 0x100;
  return v;
}

// Lua: mon_anim.lua:28
function div(a: number, b: number): number {
  if (b === 0) return 0;
  const q = a / b;
  if (q >= 0) return floor(q);
  return -floor(-q);
}

// Lua: mon_anim.lua:35
function mod(a: number, b: number): number {
  if (b === 0) return 0;
  return a - div(a, b) * b;
}

// Lua: mon_anim.lua:42
function sine(i: number): number {
  let v = Trig.SINE[i + 1];
  if (v == null) {
    MonAnim.oob = MonAnim.oob + 1;
    v = Trig.SINE[band(i, 0xFF) + 1];
  }
  return v!;
}

// pokeemerald/src/trig.c:515
// Lua: mon_anim.lua:52
function Sin(index: number, amplitude: number): number {
  return s16(arshift(s16(amplitude) * sine(s16(index)), 8));
}

// pokeemerald/src/trig.c:521
// Lua: mon_anim.lua:57
function Cos(index: number, amplitude: number): number {
  return s16(arshift(s16(amplitude) * sine(s16(index) + 64), 8));
}

// Lua: mon_anim.lua:63
function rgb(r: number, g: number, b: number): number { return r + g * 32 + b * 1024; }
// pokeemerald/include/constants/rgb.h:15
const RGB_BLACK = rgb(0, 0, 0);
const RGB_RED = rgb(31, 0, 0);
const RGB_GREEN = rgb(0, 31, 0);
const RGB_BLUE = rgb(0, 0, 31);
const RGB_YELLOW = rgb(31, 31, 0);

const MAX_BATTLERS_COUNT = 4;

// pokeemerald/src/pokemon_animation.c:209
const sAnims: AnimState[] = [];
for (let i = 0; i <= MAX_BATTLERS_COUNT - 1; i++) sAnims[i] = { delay: 0, speed: 0, runs: 1, rotation: 0, data: 0 };
let sAnimIdx = 0;
let sIsSummaryAnim = false;

const F: Record<string, SpriteCallback> = {};

// Lua: mon_anim.lua:82
function SpriteCallbackDummy(_sprite: MonSprite): void {}
// Lua: mon_anim.lua:83
function SpriteCallbackDummy_2(_sprite: MonSprite): void {}
// Lua: mon_anim.lua:84
function MonAnimDummySpriteCallback(_sprite: MonSprite): void {}

// pokeemerald/src/pokemon_animation.c:207
// Lua: mon_anim.lua:89
function WaitAnimEnd(sprite: MonSprite): void {
  if (sprite.animEnded) { sprite.callback = SpriteCallbackDummy; }
}
F.WaitAnimEnd = WaitAnimEnd;

// pokeemerald/src/pokemon_animation.c:868
// Lua: mon_anim.lua:95
function SetPosForRotation(sprite: MonSprite, index: number, amplitudeX: number, amplitudeY: number): void {
  amplitudeX = s16(-amplitudeX);
  amplitudeY = s16(-amplitudeY);
  let xAdder = s16(Cos(index, amplitudeX) - Sin(index, amplitudeY));
  let yAdder = s16(Cos(index, amplitudeY) + Sin(index, amplitudeX));
  amplitudeX = s16(-amplitudeX);
  amplitudeY = s16(-amplitudeY);
  sprite.x2 = s16(xAdder + amplitudeX);
  sprite.y2 = s16(yAdder + amplitudeY);
}

// pokeemerald/src/pokemon_animation.c:984
// Lua: mon_anim.lua:107
function SetAffineData(sprite: MonSprite, xScale: number, yScale: number, rotation: number): void {
  const m = sprite.matrix;
  m.xScale = s16(xScale); m.yScale = s16(yScale); m.rotation = u16(rotation);
}

// Lua: mon_anim.lua:112
function calcCenterToCornerVec(sprite: MonSprite): void {
  sprite.centerToCornerVecX = sprite.affineMode === "double" ? -64 : -32;
}

// pokeemerald/src/pokemon_animation.c:1003
// Lua: mon_anim.lua:117
function HandleStartAffineAnim(sprite: MonSprite): void {
  sprite.affineMode = "double";
  sprite.affineAnimNum = (sprite.data[1] === 0) ? 1 : 0;
  sprite.affineAnimBeginning = true;
  calcCenterToCornerVec(sprite);
}

// pokeemerald/src/pokemon_animation.c:1020
// Lua: mon_anim.lua:125
function HandleSetAffineData(sprite: MonSprite, xScale: number, yScale: number, rotation: number): void {
  xScale = s16(xScale); rotation = u16(rotation);
  if (sprite.data[1] === 0) {
    xScale = s16(-xScale);
    rotation = u16(-rotation);
  }
  SetAffineData(sprite, xScale, yScale, rotation);
}

// pokeemerald/src/pokemon_animation.c:1031
// Lua: mon_anim.lua:135
function TryFlipX(sprite: MonSprite): void {
  if (sprite.data[1] === 0) { sprite.x2 = s16(-sprite.x2); }
}

// pokeemerald/src/pokemon_animation.c:1037
// Lua: mon_anim.lua:140
function InitAnimData(id: number): boolean {
  if (id >= MAX_BATTLERS_COUNT) { return false; }
  let a = sAnims[id];
  a.rotation = 0; a.delay = 0; a.runs = 1; a.speed = 0; a.data = 0;
  return true;
}

// pokeemerald/src/pokemon_animation.c:1054
// Lua: mon_anim.lua:148
function AddNewAnim(): number {
  sAnimIdx = (sAnimIdx + 1) % MAX_BATTLERS_COUNT;
  InitAnimData(sAnimIdx);
  return sAnimIdx;
}

// pokeemerald/src/pokemon_animation.c:1061
// Lua: mon_anim.lua:155
function ResetSpriteAfterAnim(sprite: MonSprite): void {
  sprite.affineMode = "normal";
  calcCenterToCornerVec(sprite);
  if (sIsSummaryAnim) {
    sprite.hFlip = sprite.data[1] === 0;
    sprite.affineMode = "off";
  }
}

// Lua: mon_anim.lua:164
function blend(sprite: MonSprite, coeff: number, color: number): void {
  sprite.blendCoeff = u8(coeff);
  sprite.blendColor = color;
}

// Lua: mon_anim.lua:169
function S(v: number): AnimState { return sAnims[v]!; }

// pokeemerald/src/pokemon_animation.c:56
// Lua: mon_anim.lua:172
F.Anim_CircularStretchTwice = (sprite: MonSprite): void => {
  const d = sprite.data;
  if (d[2] === 0) { HandleStartAffineAnim(sprite); }
  if (d[2] > 40) {
    HandleSetAffineData(sprite, 256, 256, 0);
    ResetSpriteAfterAnim(sprite);
    sprite.callback = WaitAnimEnd;
  } else {
    let var_ = s16(mod(div(d[2] * 512, 40), 256));
    d[4] = Sin(var_, 32) + 256;
    d[5] = Cos(var_, 32) + 256;
    HandleSetAffineData(sprite, d[4], d[5], 0);
  }
  d[2] = d[2] + 1;
}

// Lua: mon_anim.lua:188
function hVibrate(sprite: MonSprite, amp: number): void {
  const d = sprite.data;
  if (d[2] > 40) {
    sprite.callback = WaitAnimEnd;
    sprite.x2 = 0;
  } else {
    let sign = (band(d[2], 1) === 0) ? 1 : -1;
    sprite.x2 = s16(Sin(mod(div(d[2] * 128, 40), 256), amp) * sign);
  }
  d[2] = d[2] + 1;
}

// pokeemerald/src/pokemon_animation.c:57
// Lua: mon_anim.lua:201
F.Anim_HorizontalVibrate = (sprite: MonSprite): void => { hVibrate(sprite, 6); };

// pokeemerald/src/pokemon_animation.c:1131
// Lua: mon_anim.lua:204
F.HorizontalSlide = (sprite: MonSprite): void => {
  const d = sprite.data;
  TryFlipX(sprite);
  if (d[2] > d[0]) {
    sprite.callback = WaitAnimEnd;
    sprite.x2 = 0;
  } else {
    sprite.x2 = Sin(mod(div(d[2] * 384, d[0]), 256), 6);
  }
  d[2] = d[2] + 1;
  TryFlipX(sprite);
}

// Lua: mon_anim.lua:217
F.Anim_HorizontalSlide = (sprite: MonSprite): void => {
  sprite.data[0] = 40;
  F.HorizontalSlide(sprite);
  sprite.callback = F.HorizontalSlide;
}

// pokeemerald/src/pokemon_animation.c:1156
// Lua: mon_anim.lua:224
F.VerticalSlide = (sprite: MonSprite): void => {
  const d = sprite.data;
  TryFlipX(sprite);
  if (d[2] > d[0]) {
    sprite.callback = WaitAnimEnd;
    sprite.y2 = 0;
  } else {
    sprite.y2 = s16(-Sin(mod(div(d[2] * 384, d[0]), 256), 6));
  }
  d[2] = d[2] + 1;
  TryFlipX(sprite);
}

// Lua: mon_anim.lua:237
F.Anim_VerticalSlide = (sprite: MonSprite): void => {
  sprite.data[0] = 40;
  F.VerticalSlide(sprite);
  sprite.callback = F.VerticalSlide;
}

// pokeemerald/src/pokemon_animation.c:1181
// Lua: mon_anim.lua:244
F.VerticalJumps = (sprite: MonSprite): void => {
  const d = sprite.data;
  let counter = d[2];
  if (counter > 384) {
    sprite.callback = WaitAnimEnd;
    sprite.x2 = 0;
    sprite.y2 = 0;
  } else {
    let divCounter = div(counter, 128);
    if (divCounter === 0 || divCounter === 1) {
      sprite.y2 = s16(-Sin(mod(counter, 128), d[0] * 2));
    } else if (divCounter === 2 || divCounter === 3) {
      counter = counter - 256;
      sprite.y2 = s16(-Sin(counter, d[0] * 3));
    }
  }
  d[2] = d[2] + 12;
}

// Lua: mon_anim.lua:263
F.Anim_VerticalJumps_Big = (sprite: MonSprite): void => {
  sprite.data[0] = 4;
  F.VerticalJumps(sprite);
  sprite.callback = F.VerticalJumps;
}

// pokeemerald/src/pokemon_animation.c:61
// Lua: mon_anim.lua:270
F.Anim_VerticalJumpsHorizontalJumps = (sprite: MonSprite): void => {
  const d = sprite.data;
  let counter = d[2];
  if (counter > 768) {
    sprite.callback = WaitAnimEnd;
    sprite.x2 = 0;
    sprite.y2 = 0;
  } else {
    let divCounter = div(counter, 128);
    if (divCounter === 0 || divCounter === 1) {
      sprite.x2 = 0;
    } else if (divCounter === 2) {
      counter = 0;
    } else if (divCounter === 3) {
      sprite.x2 = s16(div(-(mod(counter, 128) * 8), 128));
    } else if (divCounter === 4) {
      sprite.x2 = s16(div(mod(counter, 128), 8) - 8);
    } else if (divCounter === 5) {
      sprite.x2 = s16(div(-(mod(counter, 128) * 8), 128) + 8);
    }
    sprite.y2 = s16(-Sin(mod(counter, 128), 8));
  }
  d[2] = d[2] + 12;
}

// pokeemerald/src/pokemon_animation.c:64
// Lua: mon_anim.lua:296
F.Anim_GrowVibrate = (sprite: MonSprite): void => {
  const d = sprite.data;
  if (d[2] === 0) { HandleStartAffineAnim(sprite); }
  if (d[2] > 40) {
    HandleSetAffineData(sprite, 256, 256, 0);
    ResetSpriteAfterAnim(sprite);
    sprite.callback = WaitAnimEnd;
  } else {
    let index = s16(mod(div(d[2] * 256, 40), 256));
    if (mod(d[2], 2) === 0) {
      d[4] = Sin(index, 32) + 256;
      d[5] = Sin(index, 32) + 256;
    } else {
      d[4] = Sin(index, 8) + 256;
      d[5] = Sin(index, 8) + 256;
    }
    HandleSetAffineData(sprite, d[4], d[5], 0);
  }
  d[2] = d[2] + 1;
}

// pokeemerald/src/pokemon_animation.c:1290
const sZigzagData = [
  seq(-1, -1, 6), seq(2, 0, 6), seq(-2, 2, 6), seq(2, 0, 6), seq(-2, -2, 6),
  seq(2, 0, 6), seq(-2, 2, 6), seq(2, 0, 6), seq(-1, -1, 6), seq(0, 0, 0),
] as number[][];

// pokeemerald/src/pokemon_animation.c:1304
// Lua: mon_anim.lua:324
F.Zigzag = (sprite: MonSprite): void => {
  const d = sprite.data;
  TryFlipX(sprite);
  if (d[2] === 0) { d[3] = 0; }
  if (sZigzagData[d[3]][3] === d[2]) {
    if (sZigzagData[d[3]][3] === 0) {
      sprite.callback = WaitAnimEnd;
    } else {
      d[3] = d[3] + 1;
      d[2] = 0;
    }
  }
  if (sZigzagData[d[3]][3] === 0) {
    sprite.callback = WaitAnimEnd;
  } else {
    sprite.x2 = s16(sprite.x2 + sZigzagData[d[3]][1]);
    sprite.y2 = s16(sprite.y2 + sZigzagData[d[3]][2]);
    d[2] = d[2] + 1;
    TryFlipX(sprite);
  }
}

// Lua: mon_anim.lua:346
F.Anim_ZigzagFast = (sprite: MonSprite): void => {
  F.Zigzag(sprite);
  sprite.callback = F.Zigzag;
}

// pokeemerald/src/pokemon_animation.c:1343
// Lua: mon_anim.lua:352
F.HorizontalShake = (sprite: MonSprite): void => {
  const d = sprite.data;
  let counter = d[2];
  if (counter > 2304) {
    sprite.callback = WaitAnimEnd;
    sprite.x2 = 0;
  } else {
    sprite.x2 = Sin(mod(counter, 256), d[7]);
  }
  d[2] = d[2] + d[0];
}

// Lua: mon_anim.lua:364
F.Anim_HorizontalShake = (sprite: MonSprite): void => {
  sprite.data[0] = 60;
  sprite.data[7] = 3;
  F.HorizontalShake(sprite);
  sprite.callback = F.HorizontalShake;
}

// pokeemerald/src/pokemon_animation.c:1368
// Lua: mon_anim.lua:372
F.VerticalShake = (sprite: MonSprite): void => {
  const d = sprite.data;
  let counter = d[2];
  if (counter > 2304) {
    sprite.callback = WaitAnimEnd;
    sprite.y2 = 0;
  } else {
    sprite.y2 = Sin(mod(counter, 256), 3);
  }
  d[2] = d[2] + d[0];
}

// Lua: mon_anim.lua:384
F.Anim_VerticalShake = (sprite: MonSprite): void => {
  sprite.data[0] = 60;
  F.VerticalShake(sprite);
  sprite.callback = F.VerticalShake;
}

// pokeemerald/src/pokemon_animation.c:72
// Lua: mon_anim.lua:391
F.Anim_CircularVibrate = (sprite: MonSprite): void => {
  const d = sprite.data;
  if (d[2] > 512) {
    sprite.callback = WaitAnimEnd;
    sprite.x2 = 0;
    sprite.y2 = 0;
  } else {
    let sign = (band(d[2], 1) === 0) ? 1 : -1;
    let amplitude = Sin(div(d[2], 4), 8);
    let index = mod(d[2], 256);
    sprite.y2 = s16(Sin(index, amplitude) * sign);
    sprite.x2 = s16(Cos(index, amplitude) * sign);
  }
  d[2] = d[2] + 9;
}

// pokeemerald/src/pokemon_animation.c:1420
// Lua: mon_anim.lua:408
F.Twist = (sprite: MonSprite): void => {
  const d = sprite.data;
  const a = S(d[0]);
  if (a.delay !== 0) {
    a.delay = a.delay - 1;
  } else {
    if (d[2] === 0 && a.data === 0) {
      HandleStartAffineAnim(sprite);
      a.data = a.data + 1;
    }
    if (d[2] > a.rotation) {
      HandleSetAffineData(sprite, 256, 256, 0);
      if (a.runs > 1) {
        a.runs = a.runs - 1;
        a.delay = 10;
        d[2] = 0;
      } else {
        ResetSpriteAfterAnim(sprite);
        sprite.callback = WaitAnimEnd;
      }
    } else {
      d[6] = Sin(mod(d[2], 256), 4096);
      HandleSetAffineData(sprite, 256, 256, d[6]);
    }
    d[2] = d[2] + 16;
  }
}

// Lua: mon_anim.lua:436
F.Anim_Twist = (sprite: MonSprite): void => {
  let id = AddNewAnim();
  sprite.data[0] = id;
  sAnims[id].rotation = 512;
  sAnims[id].delay = 0;
  F.Twist(sprite);
  sprite.callback = F.Twist;
}

// pokeemerald/src/pokemon_animation.c:1472
// Lua: mon_anim.lua:446
F.Spin = (sprite: MonSprite): void => {
  const d = sprite.data;
  const a = S(u8(d[0]));
  if (d[2] === 0) { HandleStartAffineAnim(sprite); }
  if (d[2] > a.delay) {
    HandleSetAffineData(sprite, 256, 256, 0);
    ResetSpriteAfterAnim(sprite);
    sprite.callback = WaitAnimEnd;
  } else {
    d[6] = s16(div(65536, a.data) * d[2]);
    HandleSetAffineData(sprite, 256, 256, d[6]);
  }
  d[2] = d[2] + 1;
}

// Lua: mon_anim.lua:461
F.Anim_Spin_Long = (sprite: MonSprite): void => {
  let id = AddNewAnim();
  sprite.data[0] = id;
  sAnims[id].delay = 60;
  sAnims[id].data = 20;
  F.Spin(sprite);
  sprite.callback = F.Spin;
}

// pokeemerald/src/pokemon_animation.c:1504
// Lua: mon_anim.lua:471
F.CircleCounterclockwise = (sprite: MonSprite): void => {
  const d = sprite.data;
  const a = S(u8(d[0]));
  TryFlipX(sprite);
  if (d[2] > a.rotation) {
    sprite.x2 = 0;
    sprite.y2 = 0;
    sprite.callback = WaitAnimEnd;
  } else {
    let index = s16(mod(d[2] + 192, 256));
    sprite.x2 = s16(-Cos(index, a.data * 2));
    sprite.y2 = s16(Sin(index, a.data) + a.data);
  }
  d[2] = d[2] + a.speed;
  TryFlipX(sprite);
}

// Lua: mon_anim.lua:488
F.Anim_CircleCounterclockwise = (sprite: MonSprite): void => {
  let id = AddNewAnim();
  sprite.data[0] = id;
  sAnims[id].rotation = 512;
  sAnims[id].data = 6;
  sAnims[id].speed = 24;
  F.CircleCounterclockwise(sprite);
  sprite.callback = F.CircleCounterclockwise;
}

// pokeemerald/src/pokemon_animation.c:1539
// Lua: mon_anim.lua:499
function GlowColor(sprite: MonSprite, color: number, colorIncrement: number, speed: number): void {
  const d = sprite.data;
  if (d[2] === 0) { d[7] = 0x100 + (sprite.paletteNum || 0) * 16; }
  if (d[2] > 128) {
    blend(sprite, 0, color);
    sprite.callback = WaitAnimEnd;
  } else {
    d[6] = Sin(d[2], colorIncrement);
    blend(sprite, d[6], color);
  }
  d[2] = d[2] + speed;
}

// Lua: mon_anim.lua:512
F.Anim_GlowBlack = (sprite: MonSprite): void => { GlowColor(sprite, RGB_BLACK, 16, 1); };

// pokeemerald/src/pokemon_animation.c:77
// Lua: mon_anim.lua:515
F.Anim_HorizontalStretch = (sprite: MonSprite): void => {
  const d = sprite.data;
  let index1 = 0, index2 = 0;
  if (d[2] === 0) { HandleStartAffineAnim(sprite); }
  if (d[2] > 40) {
    HandleSetAffineData(sprite, 256, 256, 0);
    ResetSpriteAfterAnim(sprite);
    sprite.callback = WaitAnimEnd;
  } else {
    index2 = div(d[2] * 128, 40);
    if (d[2] >= 10 && d[2] <= 29) {
      d[7] = s16(d[7] + 51);
      index1 = band(0xFF, d[7]);
    }
    if (d[1] === 0) {
      d[4] = (Sin(index2, 40) - 256) + Sin(index1, 16);
    } else {
      d[4] = (256 - Sin(index2, 40)) - Sin(index1, 16);
    }
    d[5] = Sin(index2, 16) + 256;
    SetAffineData(sprite, d[4], d[5], 0);
  }
  d[2] = d[2] + 1;
}

// pokeemerald/src/pokemon_animation.c:78
// Lua: mon_anim.lua:541
F.Anim_VerticalStretch = (sprite: MonSprite): void => {
  const d = sprite.data;
  let posY = 0, index1 = 0, index2 = 0;
  if (d[2] === 0) { HandleStartAffineAnim(sprite); }
  if (d[2] > 40) {
    HandleSetAffineData(sprite, 256, 256, 0);
    ResetSpriteAfterAnim(sprite);
    sprite.callback = WaitAnimEnd;
    sprite.y2 = posY;
  } else {
    index2 = div(d[2] * 128, 40);
    if (d[2] >= 10 && d[2] <= 29) {
      d[7] = s16(d[7] + 51);
      index1 = band(0xFF, d[7]);
    }
    if (d[1] === 0) {
      d[4] = -Sin(index2, 16) - 256;
    } else {
      d[4] = Sin(index2, 16) + 256;
    }
    d[5] = (256 - Sin(index2, 40)) - Sin(index1, 8);
    if (d[5] !== 256) { posY = div(256 - d[5], 8); }
    sprite.y2 = s16(-posY);
    SetAffineData(sprite, d[4], d[5], 0);
  }
  d[2] = d[2] + 1;
}

// pokeemerald/src/pokemon_animation.c:622
const sVerticalShakeData = [ seq(6, 30), seq(254, 15), seq(6, 30), seq(255, 0) ] as number[][];

// pokeemerald/src/pokemon_animation.c:1638
// Lua: mon_anim.lua:573
F.VerticalShakeTwice = (sprite: MonSprite): void => {
  const d = sprite.data;
  let index = u8(d[2]);
  let var7 = u8(d[6]);
  let var5 = sVerticalShakeData[d[5]][1];
  let var6 = sVerticalShakeData[d[5]][2];
  let amplitude: number;
  if (var5 !== 254) {
    amplitude = u8(div((var6 - var7) * var5, var6));
  } else {
    amplitude = 0;
  }
  if (var5 === 255) {
    sprite.callback = WaitAnimEnd;
    sprite.y2 = 0;
  } else {
    sprite.y2 = Sin(index, amplitude);
    if (var7 === var6) {
      d[5] = d[5] + 1;
      d[6] = 0;
    } else {
      d[2] = d[2] + d[0];
      d[6] = d[6] + 1;
    }
  }
}

// Lua: mon_anim.lua:600
F.Anim_VerticalShakeTwice = (sprite: MonSprite): void => {
  sprite.data[0] = 48;
  F.VerticalShakeTwice(sprite);
  sprite.callback = F.VerticalShakeTwice;
}

// pokeemerald/src/pokemon_animation.c:81
// Lua: mon_anim.lua:607
F.Anim_TipMoveForward = (sprite: MonSprite): void => {
  const d = sprite.data;
  TryFlipX(sprite);
  let counter = u8(d[2]);
  if (d[2] === 0) { HandleStartAffineAnim(sprite); }
  if (d[2] > 35) {
    HandleSetAffineData(sprite, 256, 256, 0);
    ResetSpriteAfterAnim(sprite);
    sprite.callback = WaitAnimEnd;
    sprite.x2 = 0;
  } else {
    let index = s16(div((counter - 10) * 128, 20));
    if (counter < 10) {
      HandleSetAffineData(sprite, 256, 256, div(counter, 2) * 512);
    } else if (counter >= 10 && counter <= 29) {
      sprite.x2 = s16(-Sin(index, 5));
    } else {
      HandleSetAffineData(sprite, 256, 256, div(35 - counter, 2) * 1024);
    }
  }
  d[2] = d[2] + 1;
  TryFlipX(sprite);
}

// pokeemerald/src/pokemon_animation.c:82
// Lua: mon_anim.lua:632
F.Anim_HorizontalPivot = (sprite: MonSprite): void => {
  const d = sprite.data;
  if (d[2] === 0) { HandleStartAffineAnim(sprite); }
  if (d[2] > 100) {
    HandleSetAffineData(sprite, 256, 256, 0);
    sprite.y2 = 0;
    ResetSpriteAfterAnim(sprite);
    sprite.callback = WaitAnimEnd;
  } else {
    let index = s16(div(d[2] * 256, 100));
    sprite.y2 = Sin(index, 10);
    HandleSetAffineData(sprite, 256, 256, Sin(index, 3276));
  }
  d[2] = d[2] + 1;
}

// pokeemerald/src/pokemon_animation.c:1735
// Lua: mon_anim.lua:649
F.VerticalSlideWobble = (sprite: MonSprite): void => {
  const d = sprite.data;
  if (d[2] === 0) { HandleStartAffineAnim(sprite); }
  if (d[2] > 100) {
    HandleSetAffineData(sprite, 256, 256, 0);
    sprite.y2 = 0;
    ResetSpriteAfterAnim(sprite);
    sprite.callback = WaitAnimEnd;
  } else {
    let index = s16(div(d[2] * 256, 100));
    let var_ = band(div(d[2] * 512, 100), 0xFF);
    sprite.y2 = Sin(index, d[0]);
    HandleSetAffineData(sprite, 256, 256, Sin(var_, 3276));
  }
  d[2] = d[2] + 1;
}

// Lua: mon_anim.lua:666
F.Anim_VerticalSlideWobble = (sprite: MonSprite): void => {
  sprite.data[0] = 10;
  F.VerticalSlideWobble(sprite);
  sprite.callback = F.VerticalSlideWobble;
}

// pokeemerald/src/pokemon_animation.c:1769
// Lua: mon_anim.lua:673
F.RisingWobble = (sprite: MonSprite): void => {
  const d = sprite.data;
  if (d[2] === 0) { HandleStartAffineAnim(sprite); }
  if (d[2] > 100) {
    HandleSetAffineData(sprite, 256, 256, 0);
    sprite.y2 = 0;
    ResetSpriteAfterAnim(sprite);
    sprite.callback = WaitAnimEnd;
  } else {
    let index = s16(div(d[2] * 256, 100));
    let var_ = band(div(d[2] * 512, 100), 0xFF);
    sprite.y2 = s16(-Sin(div(index, 2), d[0] * 2));
    HandleSetAffineData(sprite, 256, 256, Sin(var_, 3276));
  }
  d[2] = d[2] + 1;
}

// Lua: mon_anim.lua:690
F.Anim_RisingWobble = (sprite: MonSprite): void => {
  sprite.data[0] = 5;
  F.RisingWobble(sprite);
  sprite.callback = F.RisingWobble;
}

// pokeemerald/src/pokemon_animation.c:84
// Lua: mon_anim.lua:697
F.Anim_HorizontalSlideWobble = (sprite: MonSprite): void => {
  const d = sprite.data;
  TryFlipX(sprite);
  if (d[2] === 0) { HandleStartAffineAnim(sprite); }
  if (d[2] > 100) {
    HandleSetAffineData(sprite, 256, 256, 0);
    sprite.x2 = 0;
    ResetSpriteAfterAnim(sprite);
    sprite.callback = WaitAnimEnd;
  } else {
    let index = s16(div(d[2] * 256, 100));
    let var_ = band(div(d[2] * 512, 100), 0xFF);
    sprite.x2 = Sin(index, 8);
    HandleSetAffineData(sprite, 256, 256, Sin(var_, 3276));
  }
  d[2] = d[2] + 1;
  TryFlipX(sprite);
}

// pokeemerald/src/pokemon_animation.c:1834
// Lua: mon_anim.lua:717
F.VerticalSquishBounce = (sprite: MonSprite): void => {
  const d = sprite.data;
  let posY = 0;
  if (d[2] === 0) {
    HandleStartAffineAnim(sprite);
    d[3] = 0;
  }
  TryFlipX(sprite);
  if (d[2] > d[0] * 3) {
    HandleSetAffineData(sprite, 256, 256, 0);
    sprite.y2 = 0;
    ResetSpriteAfterAnim(sprite);
    sprite.callback = WaitAnimEnd;
  } else {
    let yScale = s16(Sin(d[4], 32) + 256);
    if (d[2] > d[0] && d[2] < d[0] * 2) { d[3] = s16(d[3] + div(128, d[0])); }
    if (yScale > 256) { posY = div(256 - yScale, 8); }
    sprite.y2 = s16(-Sin(d[3], 10) - posY);
    HandleSetAffineData(sprite, 256 - Sin(d[4], 32), yScale, 0);
    d[2] = d[2] + 1;
    d[4] = band(d[4] + div(128, d[0]), 0xFF);
  }
  TryFlipX(sprite);
}

// Lua: mon_anim.lua:742
F.Anim_VerticalSquishBounce = (sprite: MonSprite): void => {
  sprite.data[0] = 16;
  F.VerticalSquishBounce(sprite);
  sprite.callback = F.VerticalSquishBounce;
}

// pokeemerald/src/pokemon_animation.c:1878
// Lua: mon_anim.lua:749
F.ShrinkGrow = (sprite: MonSprite): void => {
  const d = sprite.data;
  let posY = 0;
  if (d[2] > div(128, d[6]) * d[7]) {
    HandleSetAffineData(sprite, 256, 256, 0);
    sprite.y2 = 0;
    ResetSpriteAfterAnim(sprite);
    sprite.callback = WaitAnimEnd;
  } else {
    let yScale = s16(Sin(d[4], 32) + 256);
    if (yScale > 256) { posY = div(256 - yScale, 8); }
    sprite.y2 = s16(-posY);
    HandleSetAffineData(sprite, Sin(d[4], 48) + 256, yScale, 0);
    d[2] = d[2] + 1;
    d[4] = band(d[4] + d[6], 0xFF);
  }
}

// Lua: mon_anim.lua:767
F.Anim_ShrinkGrow = (sprite: MonSprite): void => {
  const d = sprite.data;
  if (d[2] === 0) {
    HandleStartAffineAnim(sprite);
    d[7] = 3;
    d[6] = 8;
  }
  F.ShrinkGrow(sprite);
}

// pokeemerald/src/pokemon_animation.c:1915
const sBounceRotateToSidesData = [
  [
    seq(0, 8, 8), seq(8, -8, 12), seq(-8, 8, 12), seq(8, -8, 12),
    seq(-8, 8, 12), seq(8, -8, 12), seq(-8, 0, 12), seq(0, 0, 0),
  ],
  [
    seq(0, 8, 16), seq(8, -8, 24), seq(-8, 8, 24), seq(8, -8, 24),
    seq(-8, 8, 24), seq(8, -8, 24), seq(-8, 0, 24), seq(0, 0, 0),
  ],
] as number[][][];

// pokeemerald/src/pokemon_animation.c:1939
// Lua: mon_anim.lua:790
F.BounceRotateToSides = (sprite: MonSprite): void => {
  const d = sprite.data;
  TryFlipX(sprite);
  const a = S(u8(d[0]));
  let var_ = a.rotation;
  let tbl = sBounceRotateToSidesData[a.data];
  let r9 = s8(tbl[d[4]][1]);
  let r10 = s16(tbl[d[4]][2] - r9);
  let r7 = d[3];
  if (d[2] === 0) {
    HandleStartAffineAnim(sprite);
    d[2] = d[2] + 1;
  }
  let time = tbl[d[4]][3];
  if (time === 0) {
    HandleSetAffineData(sprite, 256, 256, 0);
    sprite.x2 = 0;
    sprite.y2 = 0;
    ResetSpriteAfterAnim(sprite);
    sprite.callback = WaitAnimEnd;
  } else {
    sprite.y2 = s16(-Sin(div(r7 * 128, time), 10));
    sprite.x2 = s16(div(r10 * r7, time) + r9);
    let rotation = u16(div(-(var_ * sprite.x2), 8));
    HandleSetAffineData(sprite, 256, 256, rotation);
    if (r7 === time) {
      d[4] = d[4] + 1;
      d[3] = 0;
    } else {
      d[3] = d[3] + 1;
    }
  }
  TryFlipX(sprite);
}

// Lua: mon_anim.lua:825
F.Anim_BounceRotateToSides = (sprite: MonSprite): void => {
  let id = AddNewAnim();
  sprite.data[0] = id;
  sAnims[id].rotation = 4096;
  sAnims[id].data = sprite.data[6];
  F.BounceRotateToSides(sprite);
  sprite.callback = F.BounceRotateToSides;
}

// pokeemerald/src/pokemon_animation.c:87
// Lua: mon_anim.lua:835
F.Anim_GlowOrange = (sprite: MonSprite): void => { GlowColor(sprite, rgb(31, 22, 0), 12, 2); };
// Lua: mon_anim.lua:836
F.Anim_GlowRed = (sprite: MonSprite): void => { GlowColor(sprite, RGB_RED, 12, 2); };
// Lua: mon_anim.lua:837
F.Anim_GlowBlue = (sprite: MonSprite): void => { GlowColor(sprite, RGB_BLUE, 12, 2); };
// Lua: mon_anim.lua:838
F.Anim_GlowYellow = (sprite: MonSprite): void => { GlowColor(sprite, RGB_YELLOW, 12, 2); };
// Lua: mon_anim.lua:839
F.Anim_GlowPurple = (sprite: MonSprite): void => { GlowColor(sprite, rgb(24, 0, 24), 12, 2); };

// pokeemerald/src/pokemon_animation.c:92
// Lua: mon_anim.lua:842
F.Anim_BackAndLunge = (sprite: MonSprite): void => {
  HandleStartAffineAnim(sprite);
  sprite.callback = F.BackAndLunge_0;
}

// Lua: mon_anim.lua:847
F.BackAndLunge_0 = (sprite: MonSprite): void => {
  TryFlipX(sprite);
  sprite.x2 = s16(sprite.x2 + 1);
  if (sprite.x2 > 7) {
    sprite.x2 = 8;
    sprite.data[7] = 2;
    sprite.callback = F.BackAndLunge_1;
  }
  TryFlipX(sprite);
}

// Lua: mon_anim.lua:858
F.BackAndLunge_1 = (sprite: MonSprite): void => {
  const d = sprite.data;
  TryFlipX(sprite);
  sprite.x2 = s16(sprite.x2 - d[7]);
  d[7] = d[7] + 1;
  if (sprite.x2 <= 0) {
    let var_ = u8(d[7]);
    d[6] = 0;
    let subResult = sprite.x2;
    do {
      subResult = s16(subResult - var_);
      d[6] = d[6] + 1;
      var_ = u8(var_ + 1);
    } while (subResult > -8); // until not (subResult > -8)
    d[5] = 1;
    sprite.callback = F.BackAndLunge_2;
  }
  TryFlipX(sprite);
}

// Lua: mon_anim.lua:878
F.BackAndLunge_2 = (sprite: MonSprite): void => {
  const d = sprite.data;
  TryFlipX(sprite);
  sprite.x2 = s16(sprite.x2 - d[7]);
  d[7] = d[7] + 1;
  let rotation = u8(div(d[5] * 6, d[6]));
  d[5] = d[5] + 1;
  if (d[5] > d[6]) { d[5] = d[6]; }
  HandleSetAffineData(sprite, 256, 256, rotation * 256);
  if (sprite.x2 < -8) {
    sprite.x2 = -8;
    d[4] = 2;
    d[3] = 0;
    d[2] = rotation;
    sprite.callback = F.BackAndLunge_3;
  }
  TryFlipX(sprite);
}

// Lua: mon_anim.lua:897
F.BackAndLunge_3 = (sprite: MonSprite): void => {
  const d = sprite.data;
  TryFlipX(sprite);
  if (d[3] > 11) {
    d[2] = d[2] - 2;
    if (d[2] < 0) { d[2] = 0; }
    HandleSetAffineData(sprite, 256, 256, d[2] * 256);
    if (d[2] === 0) { sprite.callback = F.BackAndLunge_4; }
  } else {
    sprite.x2 = s16(sprite.x2 + d[4]);
    d[4] = -d[4];
    d[3] = d[3] + 1;
  }
  TryFlipX(sprite);
}

// Lua: mon_anim.lua:913
F.BackAndLunge_4 = (sprite: MonSprite): void => {
  TryFlipX(sprite);
  sprite.x2 = s16(sprite.x2 + 2);
  if (sprite.x2 > 0) {
    sprite.x2 = 0;
    ResetSpriteAfterAnim(sprite);
    sprite.callback = WaitAnimEnd;
  }
  TryFlipX(sprite);
}

// pokeemerald/src/pokemon_animation.c:93
// Lua: mon_anim.lua:925
F.Anim_BackFlip = (sprite: MonSprite): void => {
  HandleStartAffineAnim(sprite);
  sprite.data[3] = 0;
  sprite.callback = F.BackFlip_0;
}

// Lua: mon_anim.lua:931
F.BackFlip_0 = (sprite: MonSprite): void => {
  const d = sprite.data;
  TryFlipX(sprite);
  sprite.x2 = s16(sprite.x2 + 1);
  sprite.y2 = s16(sprite.y2 - 1);
  if (mod(sprite.x2, 2) === 0 && d[3] <= 0) { d[3] = 10; }
  if (sprite.x2 > 7) {
    sprite.x2 = 8;
    sprite.y2 = -8;
    d[4] = 0;
    sprite.callback = F.BackFlip_1;
  }
  TryFlipX(sprite);
}

// Lua: mon_anim.lua:946
F.BackFlip_1 = (sprite: MonSprite): void => {
  const d = sprite.data;
  TryFlipX(sprite);
  sprite.x2 = s16(Cos(d[4], 16) - 8);
  sprite.y2 = s16(Sin(d[4], 16) - 8);
  if (d[4] > 63) {
    d[2] = 160;
    d[3] = 10;
    sprite.callback = F.BackFlip_2;
  }
  d[4] = d[4] + 8;
  if (d[4] > 64) { d[4] = 64; }
  TryFlipX(sprite);
}

// Lua: mon_anim.lua:961
F.BackFlip_2 = (sprite: MonSprite): void => {
  const d = sprite.data;
  TryFlipX(sprite);
  if (d[3] > 0) {
    d[3] = d[3] - 1;
  } else {
    sprite.x2 = s16(Cos(d[2], 5) - 4);
    sprite.y2 = s16(-Sin(d[2], 5) + 4);
    d[2] = d[2] - 4;
    let rotation = d[2] - 32;
    HandleSetAffineData(sprite, 256, 256, rotation * 512);
    if (d[2] <= 32) {
      sprite.x2 = 0;
      sprite.y2 = 0;
      ResetSpriteAfterAnim(sprite);
      sprite.callback = WaitAnimEnd;
    }
  }
  TryFlipX(sprite);
}

// pokeemerald/src/pokemon_animation.c:94
// Lua: mon_anim.lua:983
F.Anim_Flicker = (sprite: MonSprite): void => {
  const d = sprite.data;
  if (d[3] > 0) {
    d[3] = d[3] - 1;
  } else {
    d[4] = (d[4] === 0) ? 1 : 0;
    sprite.invisible = d[4] !== 0;
    d[2] = d[2] + 1;
    if (d[2] > 19) {
      sprite.invisible = false;
      sprite.callback = WaitAnimEnd;
    }
    d[3] = 2;
  }
}

// pokeemerald/src/pokemon_animation.c:95
// Lua: mon_anim.lua:1000
F.Anim_BackFlipBig = (sprite: MonSprite): void => {
  HandleStartAffineAnim(sprite);
  sprite.callback = F.BackFlipBig_0;
}

// Lua: mon_anim.lua:1005
F.BackFlipBig_0 = (sprite: MonSprite): void => {
  TryFlipX(sprite);
  sprite.x2 = s16(sprite.x2 - 1);
  sprite.y2 = s16(sprite.y2 + 1);
  if (sprite.x2 <= -16) {
    sprite.x2 = -16;
    sprite.y2 = 16;
    sprite.callback = F.BackFlipBig_1;
    sprite.data[2] = 160;
  }
  TryFlipX(sprite);
}

// Lua: mon_anim.lua:1018
F.BackFlipBig_1 = (sprite: MonSprite): void => {
  const d = sprite.data;
  TryFlipX(sprite);
  d[2] = d[2] - 4;
  sprite.x2 = Cos(d[2], 22);
  sprite.y2 = s16(-Sin(d[2], 22));
  let rotation = d[2] - 32;
  HandleSetAffineData(sprite, 256, 256, rotation * 512);
  if (d[2] <= 32) { sprite.callback = F.BackFlipBig_2; }
  TryFlipX(sprite);
}

// Lua: mon_anim.lua:1030
F.BackFlipBig_2 = (sprite: MonSprite): void => {
  TryFlipX(sprite);
  sprite.x2 = s16(sprite.x2 - 1);
  sprite.y2 = s16(sprite.y2 + 1);
  if (sprite.x2 <= 0) {
    ResetSpriteAfterAnim(sprite);
    sprite.callback = WaitAnimEnd;
  }
  TryFlipX(sprite);
}

// pokeemerald/src/pokemon_animation.c:96
// Lua: mon_anim.lua:1042
F.Anim_FrontFlip = (sprite: MonSprite): void => {
  HandleStartAffineAnim(sprite);
  sprite.callback = F.FrontFlip_0;
}

// Lua: mon_anim.lua:1047
F.FrontFlip_0 = (sprite: MonSprite): void => {
  TryFlipX(sprite);
  sprite.x2 = s16(sprite.x2 + 1);
  sprite.y2 = s16(sprite.y2 - 1);
  if (sprite.x2 > 15) {
    sprite.data[2] = 0;
    sprite.callback = F.FrontFlip_1;
  }
  TryFlipX(sprite);
}

// Lua: mon_anim.lua:1058
F.FrontFlip_1 = (sprite: MonSprite): void => {
  const d = sprite.data;
  TryFlipX(sprite);
  d[2] = d[2] + 16;
  if (sprite.x2 <= -16) {
    sprite.x2 = -16;
    sprite.y2 = 16;
    d[2] = 0;
    sprite.callback = F.FrontFlip_2;
  } else {
    sprite.x2 = s16(sprite.x2 - 2);
    sprite.y2 = s16(sprite.y2 + 2);
  }
  HandleSetAffineData(sprite, 256, 256, d[2] * 256);
  TryFlipX(sprite);
}

// Lua: mon_anim.lua:1075
F.FrontFlip_2 = (sprite: MonSprite): void => {
  TryFlipX(sprite);
  sprite.x2 = s16(sprite.x2 + 1);
  sprite.y2 = s16(sprite.y2 - 1);
  if (sprite.x2 >= 0) {
    sprite.x2 = 0;
    sprite.y2 = 0;
    ResetSpriteAfterAnim(sprite);
    sprite.callback = WaitAnimEnd;
  }
  TryFlipX(sprite);
}

// pokeemerald/src/pokemon_animation.c:97
// Lua: mon_anim.lua:1089
F.Anim_TumblingFrontFlip = (sprite: MonSprite): void => {
  let id = AddNewAnim();
  sprite.data[0] = id;
  sAnims[id].speed = 2;
  F.TumblingFrontFlip(sprite);
  sprite.callback = F.TumblingFrontFlip;
}

// Lua: mon_anim.lua:1097
F.TumblingFrontFlip = (sprite: MonSprite): void => {
  const d = sprite.data;
  const a = S(d[0]);
  if (a.delay !== 0) {
    a.delay = a.delay - 1;
  } else {
    TryFlipX(sprite);
    if (d[2] === 0) {
      d[2] = d[2] + 1;
      HandleStartAffineAnim(sprite);
      d[7] = a.speed;
      d[3] = -1;
      d[4] = -1;
      d[5] = 0;
      d[6] = 0;
    }
    sprite.x2 = s16(sprite.x2 + d[7] * 2 * d[3]);
    sprite.y2 = s16(sprite.y2 + d[7] * d[4]);
    d[6] = d[6] + 8;
    if (sprite.x2 <= -16 || sprite.x2 >= 16) {
      sprite.x2 = s16(d[3] * 16);
      d[3] = -d[3];
      d[5] = d[5] + 1;
    } else if (sprite.y2 <= -16 || sprite.y2 >= 16) {
      sprite.y2 = s16(d[4] * 16);
      d[4] = -d[4];
      d[5] = d[5] + 1;
    }
    if (d[5] > 5 && sprite.x2 <= 0) {
      sprite.x2 = 0;
      sprite.y2 = 0;
      if (a.runs > 1) {
        a.runs = a.runs - 1;
        d[5] = 0;
        d[6] = 0;
        a.delay = 10;
      } else {
        ResetSpriteAfterAnim(sprite);
        sprite.callback = WaitAnimEnd;
      }
    }
    HandleSetAffineData(sprite, 256, 256, d[6] * 256);
    TryFlipX(sprite);
  }
}

// pokeemerald/src/pokemon_animation.c:98
// Lua: mon_anim.lua:1144
F.Anim_Figure8 = (sprite: MonSprite): void => {
  HandleStartAffineAnim(sprite);
  sprite.data[6] = 0;
  sprite.data[7] = 0;
  sprite.callback = F.Figure8;
}

// Lua: mon_anim.lua:1151
F.Figure8 = (sprite: MonSprite): void => {
  const d = sprite.data;
  TryFlipX(sprite);
  d[6] = d[6] + 4;
  sprite.x2 = s16(-Sin(d[6], 16));
  sprite.y2 = s16(-Sin(band(d[6] * 2, 0xFF), 8));
  if (d[6] > 192 && d[7] === 1) {
    HandleSetAffineData(sprite, 256, 256, 0);
    d[7] = d[7] + 1;
  } else if (d[6] > 64 && d[7] === 0) {
    HandleSetAffineData(sprite, -256, 256, 0);
    d[7] = d[7] + 1;
  }
  if (d[6] > 255) {
    sprite.x2 = 0;
    sprite.y2 = 0;
    HandleSetAffineData(sprite, 256, 256, 0);
    ResetSpriteAfterAnim(sprite);
    sprite.callback = WaitAnimEnd;
  }
  TryFlipX(sprite);
}

// pokeemerald/src/pokemon_animation.c:604
const sYellowFlashData = [
  seq(0, 5), seq(1, 1), seq(0, 15), seq(1, 4), seq(0, 2), seq(1, 2), seq(0, 2),
  seq(1, 2), seq(0, 2), seq(1, 2), seq(0, 2), seq(1, 2), seq(0, 2), seq(0, 255),
] as number[][];

// pokeemerald/src/pokemon_animation.c:99
// Lua: mon_anim.lua:1181
F.Anim_FlashYellow = (sprite: MonSprite): void => {
  const d = sprite.data;
  d[2] = d[2] + 1;
  if (d[2] === 1) {
    d[7] = 0x100 + (sprite.paletteNum || 0) * 16;
    d[6] = 0;
    d[5] = 0;
    d[4] = 0;
  }
  if (sYellowFlashData[d[6]][2] === 255) {
    sprite.callback = WaitAnimEnd;
  } else {
    if (d[4] === 1) {
      if (sYellowFlashData[d[6]][1] !== 0) {
        blend(sprite, 16, RGB_YELLOW);
      } else {
        blend(sprite, 0, RGB_YELLOW);
      }
      d[4] = 0;
    }
    if (sYellowFlashData[d[6]][2] === d[5]) {
      d[4] = 1;
      d[5] = 0;
      d[6] = d[6] + 1;
    } else {
      d[5] = d[5] + 1;
    }
  }
}

// pokeemerald/src/pokemon_animation.c:2512
// Lua: mon_anim.lua:1212
F.SwingConcave = (sprite: MonSprite): void => {
  const d = sprite.data;
  const a = S(d[0]);
  if (d[2] === 0) { HandleStartAffineAnim(sprite); }
  TryFlipX(sprite);
  if (d[2] > a.data) {
    HandleSetAffineData(sprite, 256, 256, 0);
    sprite.x2 = 0;
    if (a.runs > 1) {
      a.runs = a.runs - 1;
      d[2] = 0;
    } else {
      ResetSpriteAfterAnim(sprite);
      sprite.callback = WaitAnimEnd;
    }
  } else {
    let index = s16(div(d[2] * 256, a.data));
    sprite.x2 = s16(-Sin(index, 10));
    HandleSetAffineData(sprite, 256, 256, Sin(index, 3276));
  }
  d[2] = d[2] + 1;
  TryFlipX(sprite);
}

// Lua: mon_anim.lua:1236
F.Anim_SwingConcave_FastShort = (sprite: MonSprite): void => {
  let id = AddNewAnim();
  sprite.data[0] = id;
  sAnims[id].data = 50;
  F.SwingConcave(sprite);
  sprite.callback = F.SwingConcave;
}

// pokeemerald/src/pokemon_animation.c:2552
// Lua: mon_anim.lua:1245
F.SwingConvex = (sprite: MonSprite): void => {
  const d = sprite.data;
  const a = S(d[0]);
  if (d[2] === 0) { HandleStartAffineAnim(sprite); }
  TryFlipX(sprite);
  if (d[2] > a.data) {
    HandleSetAffineData(sprite, 256, 256, 0);
    sprite.x2 = 0;
    if (a.runs > 1) {
      a.runs = a.runs - 1;
      d[2] = 0;
    } else {
      ResetSpriteAfterAnim(sprite);
      sprite.callback = WaitAnimEnd;
    }
  } else {
    let index = s16(div(d[2] * 256, a.data));
    sprite.x2 = s16(-Sin(index, 10));
    HandleSetAffineData(sprite, 256, 256, -Sin(index, 3276));
  }
  d[2] = d[2] + 1;
  TryFlipX(sprite);
}

// Lua: mon_anim.lua:1269
F.Anim_SwingConvex_FastShort = (sprite: MonSprite): void => {
  let id = AddNewAnim();
  sprite.data[0] = id;
  sAnims[id].data = 50;
  F.SwingConvex(sprite);
  sprite.callback = F.SwingConvex;
}

// pokeemerald/src/pokemon_animation.c:102
// Lua: mon_anim.lua:1278
F.Anim_RotateUpSlamDown = (sprite: MonSprite): void => {
  HandleStartAffineAnim(sprite);
  sprite.data[6] = s16(-div(14 * sprite.centerToCornerVecX, 10));
  sprite.data[7] = 128;
  sprite.callback = F.RotateUpSlamDown_0;
}

// Lua: mon_anim.lua:1285
F.RotateUpSlamDown_0 = (sprite: MonSprite): void => {
  const d = sprite.data;
  TryFlipX(sprite);
  d[7] = d[7] - 1;
  sprite.x2 = s16(d[6] + Cos(d[7], d[6]));
  sprite.y2 = s16(-Sin(d[7], d[6]));
  HandleSetAffineData(sprite, 256, 256, (d[7] - 128) * 256);
  if (d[7] <= 120) {
    d[7] = 120;
    d[3] = 0;
    sprite.callback = F.RotateUpSlamDown_1;
  }
  TryFlipX(sprite);
}

// Lua: mon_anim.lua:1300
F.RotateUpSlamDown_1 = (sprite: MonSprite): void => {
  const d = sprite.data;
  if (d[3] === 20) {
    sprite.callback = F.RotateUpSlamDown_2;
    d[3] = 0;
  }
  d[3] = d[3] + 1;
}

// Lua: mon_anim.lua:1309
F.RotateUpSlamDown_2 = (sprite: MonSprite): void => {
  const d = sprite.data;
  TryFlipX(sprite);
  d[7] = d[7] + 2;
  sprite.x2 = s16(d[6] + Cos(d[7], d[6]));
  sprite.y2 = s16(-Sin(d[7], d[6]));
  HandleSetAffineData(sprite, 256, 256, (d[7] - 128) * 256);
  if (d[7] >= 128) {
    sprite.x2 = 0;
    sprite.y2 = 0;
    HandleSetAffineData(sprite, 256, 256, 0);
    d[2] = 0;
    ResetSpriteAfterAnim(sprite);
    sprite.callback = F.Anim_VerticalShake;
  }
  TryFlipX(sprite);
}

// pokeemerald/src/pokemon_animation.c:2656
// Lua: mon_anim.lua:1328
F.DeepVerticalSquishBounce = (sprite: MonSprite): void => {
  const d = sprite.data;
  const a = S(d[0]);
  if (a.delay !== 0) {
    a.delay = a.delay - 1;
  } else {
    if (d[2] === 0) {
      HandleStartAffineAnim(sprite);
      d[4] = 0;
      d[5] = 0;
      d[2] = 1;
    }
    if (d[5] === 0) {
      d[7] = Sin(d[4], 256);
      sprite.y2 = Sin(d[4], 16);
      d[6] = Sin(d[4], 32);
      HandleSetAffineData(sprite, 256 - d[6], 256 + d[7], 0);
      if (d[4] === 128) {
        d[4] = 0;
        d[5] = 1;
      }
    } else if (d[5] === 1) {
      d[7] = Sin(d[4], 32);
      sprite.y2 = s16(-Sin(d[4], 8));
      d[6] = Sin(d[4], 128);
      HandleSetAffineData(sprite, 256 + d[6], 256 - d[7], 0);
      if (d[4] === 128) {
        if (a.runs > 1) {
          a.runs = a.runs - 1;
          a.delay = 10;
          d[4] = 0;
          d[5] = 0;
        } else {
          HandleSetAffineData(sprite, 256, 256, 0);
          ResetSpriteAfterAnim(sprite);
          sprite.callback = WaitAnimEnd;
        }
      }
    }
    d[4] = d[4] + a.rotation;
  }
}

// Lua: mon_anim.lua:1371
F.Anim_DeepVerticalSquishBounce = (sprite: MonSprite): void => {
  let id = AddNewAnim();
  sprite.data[0] = id;
  sAnims[id].rotation = 4;
  F.DeepVerticalSquishBounce(sprite);
  sprite.callback = F.DeepVerticalSquishBounce;
}

// pokeemerald/src/pokemon_animation.c:104
// Lua: mon_anim.lua:1380
F.Anim_HorizontalJumps = (sprite: MonSprite): void => {
  const d = sprite.data;
  let counter = d[2];
  TryFlipX(sprite);
  if (counter > 512) {
    sprite.callback = WaitAnimEnd;
    sprite.x2 = 0;
    sprite.y2 = 0;
  } else {
    let c = div(d[2], 128);
    if (c === 0) {
      sprite.x2 = s16(div(-(mod(counter, 128) * 8), 128));
    } else if (c === 1) {
      sprite.x2 = s16(div(mod(counter, 128), 16) - 8);
    } else if (c === 2) {
      sprite.x2 = s16(div(mod(counter, 128), 16));
    } else if (c === 3) {
      sprite.x2 = s16(div(-(mod(counter, 128) * 8), 128) + 8);
    }
    sprite.y2 = s16(-Sin(mod(counter, 128), 8));
  }
  d[2] = d[2] + 12;
  TryFlipX(sprite);
}

// pokeemerald/src/pokemon_animation.c:105
// Lua: mon_anim.lua:1406
F.Anim_HorizontalJumpsVerticalStretch = (sprite: MonSprite): void => {
  let id = AddNewAnim();
  sprite.data[0] = id;
  sAnims[id].data = -1;
  HandleStartAffineAnim(sprite);
  sprite.data[3] = 0;
  F.HorizontalJumpsVerticalStretch_0(sprite);
  sprite.callback = F.HorizontalJumpsVerticalStretch_0;
}

// Lua: mon_anim.lua:1416
F.HorizontalJumpsVerticalStretch_0 = (sprite: MonSprite): void => {
  const d = sprite.data;
  const a = S(d[0]);
  if (a.delay !== 0) {
    a.delay = a.delay - 1;
  } else {
    TryFlipX(sprite);
    let counter = d[2];
    if (d[2] > 128) {
      d[2] = 0;
      sprite.callback = F.HorizontalJumpsVerticalStretch_1;
    } else {
      let var_ = 8 * a.data;
      sprite.x2 = s16(div(var_ * mod(counter, 128), 128));
      sprite.y2 = s16(-Sin(mod(counter, 128), 8));
      d[2] = d[2] + 12;
    }
    TryFlipX(sprite);
  }
}

// Lua: mon_anim.lua:1437
F.HorizontalJumpsVerticalStretch_1 = (sprite: MonSprite): void => {
  const d = sprite.data;
  const a = S(d[0]);
  TryFlipX(sprite);
  if (d[2] > 48) {
    HandleSetAffineData(sprite, 256, 256, 0);
    sprite.y2 = 0;
    d[2] = 0;
    sprite.callback = F.HorizontalJumpsVerticalStretch_2;
  } else {
    let yScale = s16(Sin(d[4], 64) + 256);
    if (d[2] >= 16 && d[2] <= 31) {
      d[3] = d[3] + 8;
      sprite.x2 = s16(sprite.x2 - a.data);
    }
    let yDelta = 0;
    if (yScale > 256) { yDelta = div(256 - yScale, 8); }
    sprite.y2 = s16(-Sin(d[3], 20) - yDelta);
    HandleSetAffineData(sprite, 256 - Sin(d[4], 32), yScale, 0);
    d[2] = d[2] + 1;
    d[4] = band(d[4] + 8, 0xFF);
  }
  TryFlipX(sprite);
}

// Lua: mon_anim.lua:1462
F.HorizontalJumpsVerticalStretch_2 = (sprite: MonSprite): void => {
  const d = sprite.data;
  const a = S(d[0]);
  TryFlipX(sprite);
  let counter = d[2];
  if (counter > 128) {
    if (a.runs > 1) {
      a.runs = a.runs - 1;
      a.delay = 10;
      d[3] = 0;
      d[2] = 0;
      d[4] = 0;
      sprite.callback = F.HorizontalJumpsVerticalStretch_0;
    } else {
      ResetSpriteAfterAnim(sprite);
      sprite.callback = WaitAnimEnd;
    }
    sprite.x2 = 0;
    sprite.y2 = 0;
  } else {
    let var_ = a.data;
    sprite.x2 = s16(div(var_ * (mod(counter, 128) * 8), 128) + 8 * -var_);
    sprite.y2 = s16(-Sin(mod(counter, 128), 8));
  }
  d[2] = d[2] + 12;
  TryFlipX(sprite);
}

// pokeemerald/src/pokemon_animation.c:2870
// Lua: mon_anim.lua:1491
F.RotateToSides = (sprite: MonSprite): void => {
  const d = sprite.data;
  const a = S(d[0]);
  if (d[2] === 0) {
    HandleStartAffineAnim(sprite);
    d[2] = d[2] + 1;
  }
  TryFlipX(sprite);
  if (d[7] > 254) {
    sprite.x2 = 0;
    sprite.y2 = 0;
    HandleSetAffineData(sprite, 256, 256, 0);
    if (a.runs > 1) {
      a.runs = a.runs - 1;
      d[2] = 0;
      d[7] = 0;
    } else {
      ResetSpriteAfterAnim(sprite);
      sprite.callback = WaitAnimEnd;
    }
    TryFlipX(sprite);
  } else {
    sprite.x2 = s16(-Sin(d[7], 16));
    let rotation = u16(Sin(d[7], 32));
    HandleSetAffineData(sprite, 256, 256, rotation * 256);
    d[7] = d[7] + a.rotation;
    TryFlipX(sprite);
  }
}

// Lua: mon_anim.lua:1521
F.Anim_RotateToSides_Fast = (sprite: MonSprite): void => {
  let id = AddNewAnim();
  sprite.data[0] = id;
  sAnims[id].rotation = 4;
  F.RotateToSides(sprite);
  sprite.callback = F.RotateToSides;
}

// pokeemerald/src/pokemon_animation.c:107
// Lua: mon_anim.lua:1530
F.Anim_RotateUpToSides = (sprite: MonSprite): void => {
  const d = sprite.data;
  if (d[2] === 0) {
    HandleStartAffineAnim(sprite);
    d[2] = d[2] + 1;
  }
  TryFlipX(sprite);
  if (d[7] > 254) {
    sprite.x2 = 0;
    sprite.y2 = 0;
    HandleSetAffineData(sprite, 256, 256, 0);
    ResetSpriteAfterAnim(sprite);
    sprite.callback = WaitAnimEnd;
    TryFlipX(sprite);
  } else {
    sprite.x2 = s16(-Sin(d[7], 16));
    sprite.y2 = s16(-Sin(mod(d[7], 128), 16));
    let rotation = u16(Sin(d[7], 32));
    HandleSetAffineData(sprite, 256, 256, rotation * 256);
    d[7] = d[7] + 8;
    TryFlipX(sprite);
  }
}

// pokeemerald/src/pokemon_animation.c:108
// Lua: mon_anim.lua:1555
F.Anim_FlickerIncreasing = (sprite: MonSprite): void => {
  const d = sprite.data;
  if (d[2] === 0) { d[7] = 0; }
  if (d[2] === d[7]) {
    d[7] = 0;
    d[2] = d[2] + 1;
    sprite.invisible = false;
  } else {
    d[7] = d[7] + 1;
    sprite.invisible = true;
  }
  if (d[2] > 10) {
    sprite.invisible = false;
    sprite.callback = WaitAnimEnd;
  }
}

// pokeemerald/src/pokemon_animation.c:109
// Lua: mon_anim.lua:1573
F.Anim_TipHopForward = (sprite: MonSprite): void => {
  HandleStartAffineAnim(sprite);
  sprite.data[7] = 0;
  sprite.callback = F.TipHopForward_0;
}

// Lua: mon_anim.lua:1579
F.TipHopForward_0 = (sprite: MonSprite): void => {
  const d = sprite.data;
  if (d[7] > 31) {
    d[7] = 32;
    d[2] = 0;
    sprite.callback = F.TipHopForward_1;
  } else {
    d[7] = d[7] + 4;
  }
  HandleSetAffineData(sprite, 256, 256, d[7] * 256);
}

// Lua: mon_anim.lua:1591
F.TipHopForward_1 = (sprite: MonSprite): void => {
  const d = sprite.data;
  TryFlipX(sprite);
  if (d[2] > 512) {
    sprite.callback = F.TipHopForward_2;
    d[6] = 0;
  } else {
    sprite.x2 = s16(div(-(d[2] * 16), 512));
    sprite.y2 = s16(-Sin(mod(d[2], 128), 4));
    d[2] = d[2] + 12;
  }
  TryFlipX(sprite);
}

// Lua: mon_anim.lua:1605
F.TipHopForward_2 = (sprite: MonSprite): void => {
  const d = sprite.data;
  TryFlipX(sprite);
  d[7] = d[7] - 2;
  if (d[7] < 0) {
    d[7] = 0;
    sprite.x2 = 0;
    ResetSpriteAfterAnim(sprite);
    sprite.callback = WaitAnimEnd;
  } else {
    sprite.x2 = s16(-Sin(d[7] * 2, 16));
  }
  HandleSetAffineData(sprite, 256, 256, d[7] * 256);
  TryFlipX(sprite);
}

// pokeemerald/src/pokemon_animation.c:110
// Lua: mon_anim.lua:1622
F.Anim_PivotShake = (sprite: MonSprite): void => {
  const d = sprite.data;
  if (d[2] === 0) {
    HandleStartAffineAnim(sprite);
    d[2] = d[2] + 1;
    d[7] = 0;
  }
  TryFlipX(sprite);
  if (d[7] > 255) {
    sprite.x2 = 0;
    sprite.y2 = 0;
    d[7] = 0;
    ResetSpriteAfterAnim(sprite);
    sprite.callback = WaitAnimEnd;
  } else {
    d[7] = d[7] + 16;
    sprite.x2 = s16(-Sin(mod(d[7], 128), 8));
    sprite.y2 = s16(-Sin(mod(d[7], 128), 8));
  }
  let rotation = u16(Sin(mod(d[7], 128), 16));
  HandleSetAffineData(sprite, 256, 256, rotation * 256);
  TryFlipX(sprite);
}

// pokeemerald/src/pokemon_animation.c:111
// Lua: mon_anim.lua:1647
F.Anim_TipAndShake = (sprite: MonSprite): void => {
  HandleStartAffineAnim(sprite);
  sprite.data[7] = 0;
  sprite.data[4] = 0;
  sprite.callback = F.TipAndShake_0;
}

// Lua: mon_anim.lua:1654
F.TipAndShake_0 = (sprite: MonSprite): void => {
  const d = sprite.data;
  TryFlipX(sprite);
  if (d[7] > 24) {
    d[4] = d[4] + 1;
    if (d[4] > 4) {
      d[4] = 0;
      sprite.callback = F.TipAndShake_1;
    }
  } else {
    d[7] = d[7] + 2;
    sprite.x2 = Sin(d[7], 8);
    sprite.y2 = s16(-Sin(d[7], 8));
  }
  HandleSetAffineData(sprite, 256, 256, -d[7] * 256);
  TryFlipX(sprite);
}

// Lua: mon_anim.lua:1672
F.TipAndShake_1 = (sprite: MonSprite): void => {
  const d = sprite.data;
  TryFlipX(sprite);
  if (d[7] > 32) {
    d[6] = 1;
    sprite.callback = F.TipAndShake_2;
  } else {
    d[7] = d[7] + 2;
    sprite.x2 = Sin(d[7], 8);
    sprite.y2 = s16(-Sin(d[7], 8));
  }
  HandleSetAffineData(sprite, 256, 256, -d[7] * 256);
  TryFlipX(sprite);
}

// Lua: mon_anim.lua:1687
F.TipAndShake_2 = (sprite: MonSprite): void => {
  const d = sprite.data;
  TryFlipX(sprite);
  d[7] = d[7] + d[6] * 4;
  if (d[5] > 9) {
    d[7] = 32;
    sprite.callback = F.TipAndShake_3;
  }
  sprite.x2 = Sin(d[7], 8);
  sprite.y2 = s16(-Sin(d[7], 8));
  if (d[7] <= 28 || d[7] >= 36) {
    d[6] = -d[6];
    d[5] = d[5] + 1;
  }
  HandleSetAffineData(sprite, 256, 256, -d[7] * 256);
  TryFlipX(sprite);
}

// Lua: mon_anim.lua:1705
F.TipAndShake_3 = (sprite: MonSprite): void => {
  const d = sprite.data;
  TryFlipX(sprite);
  if (d[7] <= 0) {
    d[7] = 0;
    ResetSpriteAfterAnim(sprite);
    sprite.callback = WaitAnimEnd;
  } else {
    d[7] = d[7] - 2;
    sprite.x2 = Sin(d[7], 8);
    sprite.y2 = s16(-Sin(d[7], 8));
  }
  HandleSetAffineData(sprite, 256, 256, -d[7] * 256);
  TryFlipX(sprite);
}

// pokeemerald/src/pokemon_animation.c:112
// Lua: mon_anim.lua:1722
F.Anim_VibrateToCorners = (sprite: MonSprite): void => {
  const d = sprite.data;
  TryFlipX(sprite);
  if (d[2] > 40) {
    sprite.callback = WaitAnimEnd;
    sprite.x2 = 0;
  } else {
    let sign = (band(d[2], 1) === 0) ? 1 : -1;
    if (div(mod(d[2], 4), 2) === 0) {
      sprite.x2 = s16(Sin(mod(div(d[2] * 128, 40), 256), 16) * sign);
      sprite.y2 = s16(-sprite.x2);
    } else {
      sprite.x2 = s16(-Sin(mod(div(d[2] * 128, 40), 256), 16) * sign);
      sprite.y2 = sprite.x2;
    }
  }
  d[2] = d[2] + 1;
  TryFlipX(sprite);
}

// pokeemerald/src/pokemon_animation.c:113
// Lua: mon_anim.lua:1743
F.Anim_GrowInStages = (sprite: MonSprite): void => {
  const d = sprite.data;
  TryFlipX(sprite);
  if (d[2] === 0) {
    HandleStartAffineAnim(sprite);
    d[5] = 0;
    d[6] = 0;
    d[7] = 0;
    d[2] = d[2] + 1;
  }
  if (d[6] > 0) {
    d[6] = d[6] - 1;
    if (d[5] !== 3) {
      let scale = s16(div(8 * d[6], 20));
      scale = Sin(d[7] - scale, 64);
      HandleSetAffineData(sprite, 256 - scale, 256 - scale, 0);
    }
  } else {
    let var_: number;
    if (d[5] === 3) {
      if (d[7] > 63) {
        d[7] = 64;
        HandleSetAffineData(sprite, 256, 256, 0);
        ResetSpriteAfterAnim(sprite);
        sprite.callback = WaitAnimEnd;
      }
      var_ = Cos(d[7], 64);
    } else {
      var_ = Sin(d[7], 64);
      if (d[7] > 63) {
        d[5] = 3;
        d[6] = 10;
        d[7] = 0;
      } else {
        if (var_ > 48 && d[5] === 1) {
          d[5] = 2;
          d[6] = 20;
        } else if (var_ > 16 && d[5] === 0) {
          d[5] = 1;
          d[6] = 20;
        }
      }
    }
    d[7] = d[7] + 2;
    HandleSetAffineData(sprite, 256 - var_, 256 - var_, 0);
  }
  TryFlipX(sprite);
}

// pokeemerald/src/pokemon_animation.c:114
// Lua: mon_anim.lua:1793
F.Anim_VerticalSpring = (sprite: MonSprite): void => {
  const d = sprite.data;
  if (d[2] === 0) {
    HandleStartAffineAnim(sprite);
    d[2] = d[2] + 1;
    d[7] = 0;
  }
  if (d[7] > 512) {
    sprite.y2 = 0;
    HandleSetAffineData(sprite, 256, 256, 0);
    ResetSpriteAfterAnim(sprite);
    sprite.callback = WaitAnimEnd;
  } else {
    sprite.y2 = Sin(mod(d[7], 256), 8);
    d[7] = d[7] + 8;
    let yScale = Sin(mod(d[7], 128), 96);
    HandleSetAffineData(sprite, 256, yScale + 256, 0);
  }
}

// pokeemerald/src/pokemon_animation.c:115
// Lua: mon_anim.lua:1814
F.Anim_VerticalRepeatedSpring = (sprite: MonSprite): void => {
  const d = sprite.data;
  if (d[2] === 0) {
    HandleStartAffineAnim(sprite);
    d[2] = d[2] + 1;
    d[7] = 0;
  }
  if (d[7] > 256) {
    sprite.y2 = 0;
    HandleSetAffineData(sprite, 256, 256, 0);
    ResetSpriteAfterAnim(sprite);
    sprite.callback = WaitAnimEnd;
  } else {
    sprite.y2 = Sin(d[7], 16);
    d[7] = d[7] + 4;
    let yScale = Sin(mod(d[7], 64) * 2, 128);
    HandleSetAffineData(sprite, 256, yScale + 256, 0);
  }
}

// pokeemerald/src/pokemon_animation.c:116
// Lua: mon_anim.lua:1835
F.Anim_SpringRising = (sprite: MonSprite): void => {
  HandleStartAffineAnim(sprite);
  sprite.callback = F.SpringRising_0;
  sprite.data[7] = 0;
}

// Lua: mon_anim.lua:1841
F.SpringRising_0 = (sprite: MonSprite): void => {
  const d = sprite.data;
  let yScale: number;
  d[7] = d[7] + 8;
  if (d[7] > 63) {
    d[7] = 0;
    d[6] = 0;
    sprite.callback = F.SpringRising_1;
    yScale = Sin(64, 128);
  } else {
    yScale = Sin(d[7], 128);
  }
  HandleSetAffineData(sprite, 256, 256 + yScale, 0);
}

// Lua: mon_anim.lua:1856
F.SpringRising_1 = (sprite: MonSprite): void => {
  const d = sprite.data;
  let yScale: number;
  d[7] = d[7] + 4;
  if (d[7] > 95) {
    yScale = Cos(0, 128);
    d[7] = 0;
    d[6] = d[6] + 1;
  } else {
    sprite.y2 = s16(-(d[6] * 4) - Sin(d[7], 8));
    let sign: number, index: number;
    if (d[7] > 63) {
      sign = -1;
      index = d[7] - 64;
    } else {
      sign = 1;
      index = 0;
    }
    yScale = s16(Cos((index * 2) + d[7], 128) * sign);
  }
  HandleSetAffineData(sprite, 256, 256 + yScale, 0);
  if (d[6] === 3) {
    d[7] = 0;
    sprite.callback = F.SpringRising_2;
  }
}

// Lua: mon_anim.lua:1883
F.SpringRising_2 = (sprite: MonSprite): void => {
  const d = sprite.data;
  d[7] = d[7] + 8;
  let yScale = Cos(d[7], 128);
  sprite.y2 = s16(-Cos(d[7], 12));
  if (d[7] > 63) {
    ResetSpriteAfterAnim(sprite);
    sprite.callback = WaitAnimEnd;
    sprite.y2 = 0;
    HandleSetAffineData(sprite, 256, 256, 0);
  }
  HandleSetAffineData(sprite, 256, 256 + yScale, 0);
}

// pokeemerald/src/pokemon_animation.c:3407
// Lua: mon_anim.lua:1898
F.HorizontalSpring = (sprite: MonSprite): void => {
  const d = sprite.data;
  if (d[7] > d[5]) {
    sprite.x2 = 0;
    ResetSpriteAfterAnim(sprite);
    sprite.callback = WaitAnimEnd;
    HandleSetAffineData(sprite, 256, 256, 0);
  } else {
    sprite.x2 = Sin(mod(d[7], 256), d[4]);
    d[7] = d[7] + d[6];
    let xScale = Sin(mod(d[7], 128), 96);
    HandleSetAffineData(sprite, 256 + xScale, 256, 0);
  }
}

// Lua: mon_anim.lua:1913
function springInit(sprite: MonSprite, d6: number, d5: number, d4: number): void {
  const d = sprite.data;
  if (d[2] === 0) {
    HandleStartAffineAnim(sprite);
    d[2] = d[2] + 1;
    d[7] = 0;
    d[6] = d6;
    d[5] = d5;
    d[4] = d4;
  }
}

// Lua: mon_anim.lua:1925
F.Anim_HorizontalSpring = (sprite: MonSprite): void => {
  springInit(sprite, 8, 512, 8);
  F.HorizontalSpring(sprite);
}

// pokeemerald/src/pokemon_animation.c:3442
// Lua: mon_anim.lua:1931
F.HorizontalRepeatedSpring = (sprite: MonSprite): void => {
  const d = sprite.data;
  if (d[7] > d[5]) {
    sprite.x2 = 0;
    ResetSpriteAfterAnim(sprite);
    sprite.callback = WaitAnimEnd;
    HandleSetAffineData(sprite, 256, 256, 0);
  } else {
    sprite.x2 = Sin(mod(d[7], 256), d[4]);
    d[7] = d[7] + d[6];
    let xScale = Sin(mod(d[7], 64) * 2, 128);
    HandleSetAffineData(sprite, 256 + xScale, 256, 0);
  }
}

// Lua: mon_anim.lua:1946
F.Anim_HorizontalRepeatedSpring_Slow = (sprite: MonSprite): void => {
  springInit(sprite, 4, 256, 16);
  F.HorizontalRepeatedSpring(sprite);
}

// pokeemerald/src/pokemon_animation.c:119
// Lua: mon_anim.lua:1952
F.Anim_HorizontalSlideShrink = (sprite: MonSprite): void => {
  const d = sprite.data;
  TryFlipX(sprite);
  if (d[2] === 0) {
    HandleStartAffineAnim(sprite);
    d[2] = d[2] + 1;
    d[7] = 0;
  }
  if (d[7] > 512) {
    sprite.x2 = 0;
    ResetSpriteAfterAnim(sprite);
    HandleSetAffineData(sprite, 256, 256, 0);
    sprite.callback = WaitAnimEnd;
  } else {
    sprite.x2 = Sin(mod(d[7], 256), 8);
    d[7] = d[7] + 8;
    let scale = Sin(mod(d[7], 128), 96);
    HandleSetAffineData(sprite, 256 + scale, 256 + scale, 0);
  }
  TryFlipX(sprite);
}

// pokeemerald/src/pokemon_animation.c:120
// Lua: mon_anim.lua:1975
F.Anim_LungeGrow = (sprite: MonSprite): void => {
  const d = sprite.data;
  TryFlipX(sprite);
  if (d[2] === 0) {
    HandleStartAffineAnim(sprite);
    d[2] = d[2] + 1;
    d[7] = 0;
  }
  if (d[7] > 512) {
    sprite.x2 = 0;
    ResetSpriteAfterAnim(sprite);
    HandleSetAffineData(sprite, 256, 256, 0);
    sprite.callback = WaitAnimEnd;
  } else {
    sprite.x2 = s16(-Sin(div(mod(d[7], 256), 2), 16));
    d[7] = d[7] + 8;
    let scale = s16(-Sin(div(mod(d[7], 256), 2), 64));
    HandleSetAffineData(sprite, 256 + scale, 256 + scale, 0);
  }
  TryFlipX(sprite);
}

// pokeemerald/src/pokemon_animation.c:121
// Lua: mon_anim.lua:1998
F.Anim_CircleIntoBackground = (sprite: MonSprite): void => {
  const d = sprite.data;
  TryFlipX(sprite);
  if (d[2] === 0) {
    HandleStartAffineAnim(sprite);
    d[2] = d[2] + 1;
    d[7] = 0;
  }
  if (d[7] > 512) {
    sprite.x2 = 0;
    ResetSpriteAfterAnim(sprite);
    HandleSetAffineData(sprite, 256, 256, 0);
    sprite.callback = WaitAnimEnd;
  } else {
    sprite.x2 = s16(-Sin(mod(d[7], 256), 8));
    d[7] = d[7] + 8;
    let scale = Sin(div(mod(d[7], 256), 2), 96);
    HandleSetAffineData(sprite, 256 + scale, 256 + scale, 0);
  }
  TryFlipX(sprite);
}

// pokeemerald/src/pokemon_animation.c:122
// Lua: mon_anim.lua:2021
F.Anim_RapidHorizontalHops = (sprite: MonSprite): void => {
  const d = sprite.data;
  TryFlipX(sprite);
  if (d[2] > 2048) {
    sprite.callback = WaitAnimEnd;
    d[6] = 0;
  } else {
    let caseVar = mod(div(d[2], 512), 4);
    if (caseVar === 0) {
      sprite.x2 = s16(div(-(mod(d[2], 512) * 16), 512));
    } else if (caseVar === 1) {
      sprite.x2 = s16(div(mod(d[2], 512), 32) - 16);
    } else if (caseVar === 2) {
      sprite.x2 = s16(div(mod(d[2], 512), 32));
    } else if (caseVar === 3) {
      sprite.x2 = s16(div(-(mod(d[2], 512) * 16), 512) + 16);
    }
    sprite.y2 = s16(-Sin(mod(d[2], 128), 4));
    d[2] = d[2] + 24;
  }
  TryFlipX(sprite);
}

// pokeemerald/src/pokemon_animation.c:123
// Lua: mon_anim.lua:2045
F.Anim_FourPetal = (sprite: MonSprite): void => {
  const d = sprite.data;
  TryFlipX(sprite);
  if (d[2] === 0) {
    d[6] = 0;
    d[7] = 64;
    d[2] = d[2] + 1;
  }
  d[7] = d[7] + 8;
  if (d[6] === 4) {
    if (d[7] > 63) {
      d[7] = 0;
      d[6] = d[6] + 1;
    }
  } else {
    if (d[7] > 127) {
      d[7] = 0;
      d[6] = d[6] + 1;
    }
  }
  let c = d[6];
  if (c === 1) {
    sprite.x2 = s16(-Cos(d[7], 8));
    sprite.y2 = s16(Sin(d[7], 8) - 8);
  } else if (c === 2) {
    sprite.x2 = s16(Sin(d[7] + 128, 8) + 8);
    sprite.y2 = s16(-Cos(d[7], 8));
  } else if (c === 3) {
    sprite.x2 = Cos(d[7], 8);
    sprite.y2 = s16(Sin(d[7] + 128, 8) + 8);
  } else if (c === 0 || c === 4) {
    sprite.x2 = s16(Sin(d[7], 8) - 8);
    sprite.y2 = Cos(d[7], 8);
  } else {
    sprite.x2 = 0;
    sprite.y2 = 0;
    sprite.callback = WaitAnimEnd;
  }
  TryFlipX(sprite);
}

// pokeemerald/src/pokemon_animation.c:124
// Lua: mon_anim.lua:2087
F.Anim_VerticalSquishBounce_Slow = (sprite: MonSprite): void => {
  sprite.data[0] = 32;
  F.VerticalSquishBounce(sprite);
  sprite.callback = F.VerticalSquishBounce;
}

// Lua: mon_anim.lua:2093
F.Anim_HorizontalSlide_Slow = (sprite: MonSprite): void => {
  sprite.data[0] = 80;
  F.HorizontalSlide(sprite);
  sprite.callback = F.HorizontalSlide;
}

// Lua: mon_anim.lua:2099
F.Anim_VerticalSlide_Slow = (sprite: MonSprite): void => {
  sprite.data[0] = 80;
  F.VerticalSlide(sprite);
  sprite.callback = F.VerticalSlide;
}

// pokeemerald/src/pokemon_animation.c:127
// Lua: mon_anim.lua:2106
F.Anim_BounceRotateToSides_Small = (sprite: MonSprite): void => {
  let id = AddNewAnim();
  sprite.data[0] = id;
  sAnims[id].rotation = 2048;
  sAnims[id].data = sprite.data[6];
  F.BounceRotateToSides(sprite);
  sprite.callback = F.BounceRotateToSides;
}

// Lua: mon_anim.lua:2115
F.Anim_BounceRotateToSides_Slow = (sprite: MonSprite): void => {
  sprite.data[6] = 1;
  F.Anim_BounceRotateToSides(sprite);
}

// Lua: mon_anim.lua:2120
F.Anim_BounceRotateToSides_SmallSlow = (sprite: MonSprite): void => {
  sprite.data[6] = 1;
  F.Anim_BounceRotateToSides_Small(sprite);
}

// pokeemerald/src/pokemon_animation.c:130
// Lua: mon_anim.lua:2126
F.Anim_ZigzagSlow = (sprite: MonSprite): void => {
  const d = sprite.data;
  if (d[2] === 0) { d[0] = 0; }
  if (d[0] <= 0) {
    F.Zigzag(sprite);
    d[0] = 1;
  } else {
    d[0] = d[0] - 1;
  }
}

// Lua: mon_anim.lua:2137
F.Anim_HorizontalShake_Slow = (sprite: MonSprite): void => {
  sprite.data[0] = 30;
  sprite.data[7] = 3;
  F.HorizontalShake(sprite);
  sprite.callback = F.HorizontalShake;
}

// Lua: mon_anim.lua:2144
F.Anim_VertialShake_Slow = (sprite: MonSprite): void => {
  sprite.data[0] = 30;
  F.VerticalShake(sprite);
  sprite.callback = F.VerticalShake;
}

// Lua: mon_anim.lua:2150
F.Anim_Twist_Twice = (sprite: MonSprite): void => {
  let id = AddNewAnim();
  sprite.data[0] = id;
  sAnims[id].rotation = 1024;
  sAnims[id].delay = 0;
  sAnims[id].runs = 2;
  F.Twist(sprite);
  sprite.callback = F.Twist;
}

// Lua: mon_anim.lua:2160
F.Anim_CircleCounterclockwise_Slow = (sprite: MonSprite): void => {
  let id = AddNewAnim();
  sprite.data[0] = id;
  sAnims[id].rotation = 512;
  sAnims[id].data = 3;
  sAnims[id].speed = 12;
  F.CircleCounterclockwise(sprite);
  sprite.callback = F.CircleCounterclockwise;
}

// Lua: mon_anim.lua:2170
F.Anim_VerticalShakeTwice_Slow = (sprite: MonSprite): void => {
  sprite.data[0] = 24;
  F.VerticalShakeTwice(sprite);
  sprite.callback = F.VerticalShakeTwice;
}

// Lua: mon_anim.lua:2176
F.Anim_VerticalSlideWobble_Small = (sprite: MonSprite): void => {
  sprite.data[0] = 5;
  F.VerticalSlideWobble(sprite);
  sprite.callback = F.VerticalSlideWobble;
}

// Lua: mon_anim.lua:2182
F.Anim_VerticalJumps_Small = (sprite: MonSprite): void => {
  sprite.data[0] = 3;
  F.VerticalJumps(sprite);
  sprite.callback = F.VerticalJumps;
}

// Lua: mon_anim.lua:2188
F.Anim_Spin = (sprite: MonSprite): void => {
  let id = AddNewAnim();
  sprite.data[0] = id;
  sAnims[id].delay = 60;
  sAnims[id].data = 30;
  F.Spin(sprite);
  sprite.callback = F.Spin;
}

// Lua: mon_anim.lua:2197
F.Anim_TumblingFrontFlip_Twice = (sprite: MonSprite): void => {
  let id = AddNewAnim();
  sprite.data[0] = id;
  sAnims[id].speed = 1;
  sAnims[id].runs = 2;
  F.TumblingFrontFlip(sprite);
  sprite.callback = F.TumblingFrontFlip;
}

// Lua: mon_anim.lua:2206
F.Anim_DeepVerticalSquishBounce_Twice = (sprite: MonSprite): void => {
  let id = AddNewAnim();
  sprite.data[0] = id;
  sAnims[id].rotation = 4;
  sAnims[id].runs = 2;
  F.DeepVerticalSquishBounce(sprite);
  sprite.callback = F.DeepVerticalSquishBounce;
}

// Lua: mon_anim.lua:2215
F.Anim_HorizontalJumpsVerticalStretch_Twice = (sprite: MonSprite): void => {
  let id = AddNewAnim();
  sprite.data[0] = id;
  sAnims[id].data = 1;
  sAnims[id].runs = 2;
  HandleStartAffineAnim(sprite);
  sprite.data[3] = 0;
  F.HorizontalJumpsVerticalStretch_0(sprite);
  sprite.callback = F.HorizontalJumpsVerticalStretch_0;
}

// Lua: mon_anim.lua:2226
F.Anim_RotateToSides = (sprite: MonSprite): void => {
  let id = AddNewAnim();
  sprite.data[0] = id;
  sAnims[id].rotation = 2;
  F.RotateToSides(sprite);
  sprite.callback = F.RotateToSides;
}

// Lua: mon_anim.lua:2234
F.Anim_RotateToSides_Twice = (sprite: MonSprite): void => {
  let id = AddNewAnim();
  sprite.data[0] = id;
  sAnims[id].rotation = 4;
  sAnims[id].runs = 2;
  F.RotateToSides(sprite);
  sprite.callback = F.RotateToSides;
}

// Lua: mon_anim.lua:2243
F.Anim_SwingConcave = (sprite: MonSprite): void => {
  let id = AddNewAnim();
  sprite.data[0] = id;
  sAnims[id].data = 100;
  F.SwingConcave(sprite);
  sprite.callback = F.SwingConcave;
}

// Lua: mon_anim.lua:2251
F.Anim_SwingConcave_Fast = (sprite: MonSprite): void => {
  let id = AddNewAnim();
  sprite.data[0] = id;
  sAnims[id].data = 50;
  sAnims[id].runs = 2;
  F.SwingConcave(sprite);
  sprite.callback = F.SwingConcave;
}

// Lua: mon_anim.lua:2260
F.Anim_SwingConvex = (sprite: MonSprite): void => {
  let id = AddNewAnim();
  sprite.data[0] = id;
  sAnims[id].data = 100;
  F.SwingConvex(sprite);
  sprite.callback = F.SwingConvex;
}

// Lua: mon_anim.lua:2268
F.Anim_SwingConvex_Fast = (sprite: MonSprite): void => {
  let id = AddNewAnim();
  sprite.data[0] = id;
  sAnims[id].data = 50;
  sAnims[id].runs = 2;
  F.SwingConvex(sprite);
  sprite.callback = F.SwingConvex;
}

// pokeemerald/src/pokemon_animation.c:3875
// Lua: mon_anim.lua:2278
F.VerticalShakeBack = (sprite: MonSprite): void => {
  const d = sprite.data;
  let counter = d[2];
  if (counter > 2304) {
    sprite.callback = WaitAnimEnd;
    sprite.y2 = 0;
  } else {
    sprite.y2 = s16(Sin(mod(counter + 192, 256), d[7]) + d[7]);
  }
  d[2] = d[2] + d[0];
}

// Lua: mon_anim.lua:2290
F.Anim_VerticalShakeBack = (sprite: MonSprite): void => {
  sprite.data[0] = 60;
  sprite.data[7] = 3;
  F.VerticalShakeBack(sprite);
  sprite.callback = F.VerticalShakeBack;
}

// Lua: mon_anim.lua:2297
F.Anim_VerticalShakeBack_Slow = (sprite: MonSprite): void => {
  sprite.data[0] = 30;
  sprite.data[7] = 3;
  F.VerticalShakeBack(sprite);
  sprite.callback = F.VerticalShakeBack;
}

// Lua: mon_anim.lua:2304
function vShakeHSlide(sprite: MonSprite, step: number, ymod: number): void {
  const d = sprite.data;
  TryFlipX(sprite);
  if (d[2] > 2048) {
    sprite.callback = WaitAnimEnd;
    d[6] = 0;
  } else {
    let divCase = mod(div(d[2], 512), 4);
    if (divCase === 0) {
      sprite.x2 = s16(div(mod(d[2], 512), 32));
    } else if (divCase === 2) {
      sprite.x2 = s16(div(-(mod(d[2], 512) * 16), 512));
    } else if (divCase === 1) {
      sprite.x2 = s16(div(-(mod(d[2], 512) * 16), 512) + 16);
    } else if (divCase === 3) {
      sprite.x2 = s16(div(mod(d[2], 512), 32) - 16);
    }
    sprite.y2 = Sin(mod(d[2], ymod), 4);
    d[2] = d[2] + step;
  }
  TryFlipX(sprite);
}

// pokeemerald/src/pokemon_animation.c:144
// Lua: mon_anim.lua:2328
F.Anim_VerticalShakeHorizontalSlide_Slow = (sprite: MonSprite): void => { vShakeHSlide(sprite, 24, 128); };

// pokeemerald/src/pokemon_animation.c:3941
// Lua: mon_anim.lua:2331
F.VerticalStretchBothEnds = (sprite: MonSprite): void => {
  const d = sprite.data;
  let index1 = 0, index2 = 0;
  if (d[5] > d[6]) {
    sprite.y2 = 0;
    d[5] = 0;
    HandleSetAffineData(sprite, 256, 256, 0);
    if (d[4] <= 1) {
      ResetSpriteAfterAnim(sprite);
      sprite.callback = WaitAnimEnd;
    } else {
      d[4] = d[4] - 1;
      d[7] = 0;
    }
  } else {
    index2 = s16(div(d[5] * 128, d[6]));
    let cmpVal1 = u8(div(d[6], 4));
    let cmpVal2 = u8(cmpVal1 * 3);
    if (d[5] >= cmpVal1 && d[5] < cmpVal2) {
      d[7] = s16(d[7] + 51);
      index1 = band(d[7], 0xFF);
    }
    let xScale: number;
    if (d[1] === 0) {
      xScale = -256 - Sin(index2, 16);
    } else {
      xScale = 256 + Sin(index2, 16);
    }
    let amplitude = u8(d[3]);
    let yScale = 256 - Sin(index2, amplitude) - Sin(index1, div(amplitude, 5));
    SetAffineData(sprite, xScale, yScale, 0);
    d[5] = d[5] + 1;
  }
}

// Lua: mon_anim.lua:2366
function stretchInit(sprite: MonSprite, d4: number, d6: number, d3: number, with5: boolean): void {
  const d = sprite.data;
  if (d[2] === 0) {
    d[2] = 1;
    HandleStartAffineAnim(sprite);
    d[4] = d4;
    d[6] = d6;
    d[3] = d3;
    if (with5) { d[5] = 0; }
    d[7] = 0;
  }
}

// Lua: mon_anim.lua:2379
F.Anim_VerticalStretchBothEnds_Slow = (sprite: MonSprite): void => {
  stretchInit(sprite, 1, 40, 40, true);
  F.VerticalStretchBothEnds(sprite);
}

// pokeemerald/src/pokemon_animation.c:4003
// Lua: mon_anim.lua:2385
F.HorizontalStretchFar = (sprite: MonSprite): void => {
  const d = sprite.data;
  let index1 = 0, index2 = 0;
  if (d[5] > d[6]) {
    d[5] = 0;
    HandleSetAffineData(sprite, 256, 256, 0);
    if (d[4] <= 1) {
      ResetSpriteAfterAnim(sprite);
      sprite.callback = WaitAnimEnd;
    } else {
      d[4] = d[4] - 1;
      d[7] = 0;
    }
  } else {
    index2 = s16(div(d[5] * 128, d[6]));
    let cmpVal1 = u8(div(d[6], 4));
    let cmpVal2 = u8(cmpVal1 * 3);
    if (d[5] >= cmpVal1 && d[5] < cmpVal2) {
      d[7] = s16(d[7] + 51);
      index1 = band(d[7], 0xFF);
    }
    let amplitude = u8(d[3]);
    let xScale: number;
    if (d[1] === 0) {
      xScale = -256 + Sin(index2, amplitude) + Sin(index1, div(amplitude, 5) * 2);
    } else {
      xScale = 256 - Sin(index2, amplitude) - Sin(index1, div(amplitude, 5) * 2);
    }
    SetAffineData(sprite, xScale, 256, 0);
    d[5] = d[5] + 1;
  }
}

// Lua: mon_anim.lua:2418
F.Anim_HorizontalStretchFar_Slow = (sprite: MonSprite): void => {
  stretchInit(sprite, 1, 40, 40, true);
  F.HorizontalStretchFar(sprite);
}

// pokeemerald/src/pokemon_animation.c:4064
// Lua: mon_anim.lua:2424
F.VerticalShakeLowTwice = (sprite: MonSprite): void => {
  const d = sprite.data;
  let var8 = u8(d[2]);
  let var9 = u8(d[6]);
  let row = sVerticalShakeData[d[5]];
  let var5 = row[1];
  if (var5 !== 255) { var5 = u8(d[7]); }
  let var6 = row[2];
  let var7: number;
  if (row[1] !== 254) {
    var7 = u8(div((var6 - var9) * var5, var6));
  } else {
    var7 = 0;
  }
  if (var5 === 255) {
    sprite.callback = WaitAnimEnd;
    sprite.y2 = 0;
  } else {
    sprite.y2 = s16(Sin(mod(var8 + 192, 256), var7) + var7);
    if (var9 === var6) {
      d[5] = d[5] + 1;
      d[6] = 0;
    } else {
      d[2] = d[2] + d[0];
      d[6] = d[6] + 1;
    }
  }
}

// Lua: mon_anim.lua:2453
F.Anim_VerticalShakeLowTwice = (sprite: MonSprite): void => {
  sprite.data[0] = 40;
  sprite.data[7] = 6;
  F.VerticalShakeLowTwice(sprite);
  sprite.callback = F.VerticalShakeLowTwice;
}

// Lua: mon_anim.lua:2460
F.Anim_HorizontalShake_Fast = (sprite: MonSprite): void => {
  sprite.data[0] = 70;
  sprite.data[7] = 6;
  F.HorizontalShake(sprite);
  sprite.callback = F.HorizontalShake;
}

// Lua: mon_anim.lua:2467
F.Anim_HorizontalSlide_Fast = (sprite: MonSprite): void => {
  sprite.data[0] = 20;
  F.HorizontalSlide(sprite);
  sprite.callback = F.HorizontalSlide;
}

// pokeemerald/src/pokemon_animation.c:150
// Lua: mon_anim.lua:2474
F.Anim_HorizontalVibrate_Fast = (sprite: MonSprite): void => { hVibrate(sprite, 9); };
// Lua: mon_anim.lua:2475
F.Anim_HorizontalVibrate_Fastest = (sprite: MonSprite): void => { hVibrate(sprite, 12); };

// Lua: mon_anim.lua:2477
F.Anim_VerticalShakeBack_Fast = (sprite: MonSprite): void => {
  sprite.data[0] = 70;
  sprite.data[7] = 6;
  F.VerticalShakeBack(sprite);
  sprite.callback = F.VerticalShakeBack;
}

// Lua: mon_anim.lua:2484
F.Anim_VerticalShakeLowTwice_Slow = (sprite: MonSprite): void => {
  sprite.data[0] = 24;
  sprite.data[7] = 6;
  F.VerticalShakeLowTwice(sprite);
  sprite.callback = F.VerticalShakeLowTwice;
}

// Lua: mon_anim.lua:2491
F.Anim_VerticalShakeLowTwice_Fast = (sprite: MonSprite): void => {
  sprite.data[0] = 56;
  sprite.data[7] = 9;
  F.VerticalShakeLowTwice(sprite);
  sprite.callback = F.VerticalShakeLowTwice;
}

// Lua: mon_anim.lua:2498
F.Anim_CircleCounterclockwise_Long = (sprite: MonSprite): void => {
  let id = AddNewAnim();
  sprite.data[0] = id;
  sAnims[id].rotation = 1024;
  sAnims[id].data = 6;
  sAnims[id].speed = 24;
  F.CircleCounterclockwise(sprite);
  sprite.callback = F.CircleCounterclockwise;
}

// pokeemerald/src/pokemon_animation.c:4202
// Lua: mon_anim.lua:2509
F.GrowStutter = (sprite: MonSprite): void => {
  const d = sprite.data;
  let index1 = 0, index2 = 0;
  if (d[5] > d[6]) {
    sprite.y2 = 0;
    d[5] = 0;
    HandleSetAffineData(sprite, 256, 256, 0);
    if (d[4] <= 1) {
      ResetSpriteAfterAnim(sprite);
      sprite.callback = WaitAnimEnd;
    } else {
      d[4] = d[4] - 1;
      d[7] = 0;
    }
  } else {
    index2 = s16(div(d[5] * 128, d[6]));
    let cmpVal1 = u8(div(d[6], 4));
    let cmpVal2 = u8(cmpVal1 * 3);
    if (d[5] >= cmpVal1 && d[5] < cmpVal2) {
      d[7] = s16(d[7] + 51);
      index1 = band(d[7], 0xFF);
    }
    let amplitude = u8(d[3]);
    let xScale: number;
    if (d[1] === 0) {
      xScale = Sin(index2, amplitude) + (Sin(index1, div(amplitude, 5) * 2) - 256);
    } else {
      xScale = 256 - Sin(index1, div(amplitude, 5) * 2) - Sin(index2, amplitude);
    }
    let yScale = 256 - Sin(index1, div(amplitude, 5)) - Sin(index2, amplitude);
    SetAffineData(sprite, xScale, yScale, 0);
    d[5] = d[5] + 1;
  }
}

// Lua: mon_anim.lua:2544
F.Anim_GrowStutter_Slow = (sprite: MonSprite): void => {
  stretchInit(sprite, 1, 40, 40, true);
  F.GrowStutter(sprite);
}

// pokeemerald/src/pokemon_animation.c:157
// Lua: mon_anim.lua:2550
F.Anim_VerticalShakeHorizontalSlide = (sprite: MonSprite): void => { vShakeHSlide(sprite, 48, 128); };
// Lua: mon_anim.lua:2551
F.Anim_VerticalShakeHorizontalSlide_Fast = (sprite: MonSprite): void => { vShakeHSlide(sprite, 64, 96); };

// pokeemerald/src/pokemon_animation.c:4332
const sTriangleDownData = [ seq(1, 1, 12), seq(-2, 0, 12), seq(1, -1, 12), seq(0, 0, 0) ] as number[][];

// pokeemerald/src/pokemon_animation.c:4341
// Lua: mon_anim.lua:2557
F.TriangleDown = (sprite: MonSprite): void => {
  const d = sprite.data;
  TryFlipX(sprite);
  if (d[2] === 0) { d[3] = 0; }
  if (div(sTriangleDownData[d[3]][3], d[5]) === d[2]) {
    d[3] = d[3] + 1;
    d[2] = 0;
  }
  if (div(sTriangleDownData[d[3]][3], d[5]) === 0) {
    d[6] = d[6] - 1;
    if (d[6] === 0) {
      sprite.callback = WaitAnimEnd;
    } else {
      d[2] = 0;
    }
  } else {
    let amplitude = d[5];
    sprite.x2 = s16(sprite.x2 + sTriangleDownData[d[3]][1] * amplitude);
    sprite.y2 = s16(sprite.y2 + sTriangleDownData[d[3]][2] * d[5]);
    d[2] = d[2] + 1;
    TryFlipX(sprite);
  }
}

// Lua: mon_anim.lua:2581
function triangleInit(sprite: MonSprite, d5: number, d6: number): void {
  sprite.data[5] = d5;
  sprite.data[6] = d6;
  F.TriangleDown(sprite);
  sprite.callback = F.TriangleDown;
}

// Lua: mon_anim.lua:2588
F.Anim_TriangleDown_Slow = (sprite: MonSprite): void => { triangleInit(sprite, 1, 1); };
// Lua: mon_anim.lua:2589
F.Anim_TriangleDown = (sprite: MonSprite): void => { triangleInit(sprite, 2, 1); };
// Lua: mon_anim.lua:2590
F.Anim_TriangleDown_Fast = (sprite: MonSprite): void => { triangleInit(sprite, 2, 2); };

// pokeemerald/src/pokemon_animation.c:4394
// Lua: mon_anim.lua:2593
F.Grow = (sprite: MonSprite): void => {
  const d = sprite.data;
  if (d[7] > 255) {
    if (d[5] <= 1) {
      ResetSpriteAfterAnim(sprite);
      sprite.callback = WaitAnimEnd;
      HandleSetAffineData(sprite, 256, 256, 0);
    } else {
      d[5] = d[5] - 1;
      d[7] = 0;
    }
  } else {
    d[7] = d[7] + d[6];
    if (d[7] > 256) { d[7] = 256; }
    let scale = Sin(div(d[7], 2), 64);
    HandleSetAffineData(sprite, 256 - scale, 256 - scale, 0);
  }
}

// Lua: mon_anim.lua:2612
function growInit(sprite: MonSprite, d6: number, d5: number): void {
  const d = sprite.data;
  TryFlipX(sprite);
  if (d[2] === 0) {
    HandleStartAffineAnim(sprite);
    d[2] = d[2] + 1;
    d[7] = 0;
    d[6] = d6;
    d[5] = d5;
  }
  F.Grow(sprite);
  TryFlipX(sprite);
}

// Lua: mon_anim.lua:2626
F.Anim_Grow = (sprite: MonSprite): void => { growInit(sprite, 4, 1); };
// Lua: mon_anim.lua:2627
F.Anim_Grow_Twice = (sprite: MonSprite): void => { growInit(sprite, 8, 2); };

// pokeemerald/src/pokemon_animation.c:164
// Lua: mon_anim.lua:2630
F.Anim_HorizontalSpring_Fast = (sprite: MonSprite): void => {
  springInit(sprite, 8, 512, 16);
  F.HorizontalSpring(sprite);
}

// Lua: mon_anim.lua:2635
F.Anim_HorizontalSpring_Slow = (sprite: MonSprite): void => {
  springInit(sprite, 4, 256, 16);
  F.HorizontalSpring(sprite);
}

// Lua: mon_anim.lua:2640
F.Anim_HorizontalRepeatedSpring_Fast = (sprite: MonSprite): void => {
  springInit(sprite, 8, 512, 16);
  F.HorizontalRepeatedSpring(sprite);
}

// Lua: mon_anim.lua:2645
F.Anim_HorizontalRepeatedSpring = (sprite: MonSprite): void => {
  springInit(sprite, 8, 512, 8);
  F.HorizontalRepeatedSpring(sprite);
}

// pokeemerald/src/pokemon_animation.c:168
// Lua: mon_anim.lua:2651
F.Anim_ShrinkGrow_Fast = (sprite: MonSprite): void => {
  const d = sprite.data;
  if (d[2] === 0) {
    HandleStartAffineAnim(sprite);
    d[7] = 5;
    d[6] = 8;
  }
  F.ShrinkGrow(sprite);
}

// Lua: mon_anim.lua:2661
F.Anim_ShrinkGrow_Slow = (sprite: MonSprite): void => {
  const d = sprite.data;
  if (d[2] === 0) {
    HandleStartAffineAnim(sprite);
    d[7] = 3;
    d[6] = 4;
  }
  F.ShrinkGrow(sprite);
}

// pokeemerald/src/pokemon_animation.c:170
// Lua: mon_anim.lua:2672
F.Anim_VerticalStretchBothEnds = (sprite: MonSprite): void => {
  stretchInit(sprite, 1, 30, 60, false);
  F.VerticalStretchBothEnds(sprite);
}

// Lua: mon_anim.lua:2677
F.Anim_VerticalStretchBothEnds_Twice = (sprite: MonSprite): void => {
  stretchInit(sprite, 2, 20, 70, false);
  F.VerticalStretchBothEnds(sprite);
}

// Lua: mon_anim.lua:2682
F.Anim_HorizontalStretchFar_Twice = (sprite: MonSprite): void => {
  stretchInit(sprite, 2, 20, 70, true);
  F.HorizontalStretchFar(sprite);
}

// Lua: mon_anim.lua:2687
F.Anim_HorizontalStretchFar = (sprite: MonSprite): void => {
  stretchInit(sprite, 1, 30, 60, true);
  F.HorizontalStretchFar(sprite);
}

// Lua: mon_anim.lua:2692
F.Anim_GrowStutter_Twice = (sprite: MonSprite): void => {
  stretchInit(sprite, 2, 20, 70, true);
  F.GrowStutter(sprite);
}

// Lua: mon_anim.lua:2697
F.Anim_GrowStutter = (sprite: MonSprite): void => {
  stretchInit(sprite, 1, 30, 60, true);
  F.GrowStutter(sprite);
}

// pokeemerald/src/pokemon_animation.c:4633
// Lua: mon_anim.lua:2703
F.ConcaveArc = (sprite: MonSprite): void => {
  const d = sprite.data;
  if (d[7] > 255) {
    if (d[6] <= 1) {
      sprite.callback = WaitAnimEnd;
      sprite.x2 = 0;
      sprite.y2 = 0;
    } else {
      d[7] = mod(d[7], 256);
      d[6] = d[6] - 1;
    }
  } else {
    sprite.x2 = s16(-Sin(d[7], d[5]));
    sprite.y2 = Sin(mod(d[7] + 192, 256), d[4]);
    if (sprite.y2 > 0) { sprite.y2 = s16(-sprite.y2); }
    sprite.y2 = s16(sprite.y2 + d[4]);
    d[7] = d[7] + d[3];
  }
}

// Lua: mon_anim.lua:2723
function arcInit(sprite: MonSprite, d6: number, d5: number, d4: number, d3: number): void {
  const d = sprite.data;
  if (d[2] === 0) {
    d[2] = 1;
    d[6] = d6;
    d[7] = 0;
    d[5] = d5;
    d[4] = d4;
    d[3] = d3;
  }
}

// Lua: mon_anim.lua:2735
F.Anim_ConcaveArcLarge_Slow = (sprite: MonSprite): void => { arcInit(sprite, 1, 12, 12, 4); F.ConcaveArc(sprite); };
// Lua: mon_anim.lua:2736
F.Anim_ConcaveArcLarge = (sprite: MonSprite): void => { arcInit(sprite, 1, 12, 12, 6); F.ConcaveArc(sprite); };
// Lua: mon_anim.lua:2737
F.Anim_ConcaveArcLarge_Twice = (sprite: MonSprite): void => { arcInit(sprite, 2, 12, 12, 8); F.ConcaveArc(sprite); };

// pokeemerald/src/pokemon_animation.c:4706
// Lua: mon_anim.lua:2740
F.ConvexDoubleArc = (sprite: MonSprite): void => {
  const d = sprite.data;
  if (d[7] > 256) {
    if (d[6] <= d[4]) {
      sprite.callback = WaitAnimEnd;
    } else {
      d[4] = d[4] + 1;
      d[7] = 0;
    }
    sprite.x2 = 0;
    sprite.y2 = 0;
  } else {
    if (d[7] > 159) {
      if (d[7] > 256) { d[7] = 256; }
      sprite.y2 = s16(-Sin(mod(d[7], 256), 8));
    } else if (d[7] > 95) {
      sprite.y2 = s16(Sin(96, 6) - Sin((d[7] - 96) * 2, 4));
    } else {
      sprite.y2 = Sin(d[7], 6);
    }
    let posX = s16(-Sin(div(d[7], 2), d[5]));
    if (mod(d[4], 2) === 0) { posX = s16(-posX); }
    sprite.x2 = posX;
    d[7] = d[7] + d[3];
  }
}

// Lua: mon_anim.lua:2767
F.Anim_ConvexDoubleArc_Slow = (sprite: MonSprite): void => { arcInit(sprite, 2, 16, 1, 4); F.ConvexDoubleArc(sprite); };
// Lua: mon_anim.lua:2768
F.Anim_ConvexDoubleArc = (sprite: MonSprite): void => { arcInit(sprite, 2, 16, 1, 6); F.ConvexDoubleArc(sprite); };
// Lua: mon_anim.lua:2769
F.Anim_ConvexDoubleArc_Twice = (sprite: MonSprite): void => { arcInit(sprite, 3, 16, 1, 8); F.ConvexDoubleArc(sprite); };

// pokeemerald/src/pokemon_animation.c:182
// Lua: mon_anim.lua:2772
F.Anim_ConcaveArcSmall_Slow = (sprite: MonSprite): void => { arcInit(sprite, 1, 4, 6, 4); F.ConcaveArc(sprite); };
// Lua: mon_anim.lua:2773
F.Anim_ConcaveArcSmall = (sprite: MonSprite): void => { arcInit(sprite, 1, 4, 6, 6); F.ConcaveArc(sprite); };
// Lua: mon_anim.lua:2774
F.Anim_ConcaveArcSmall_Twice = (sprite: MonSprite): void => { arcInit(sprite, 2, 4, 6, 8); F.ConcaveArc(sprite); };

// pokeemerald/src/pokemon_animation.c:4842
// Lua: mon_anim.lua:2777
function SetHorizontalDip(sprite: MonSprite): void {
  const d = sprite.data;
  let index = u16(Sin(div(d[2] * 128, d[7]), d[5]));
  d[6] = s16(-(index * 256));
  SetPosForRotation(sprite, index, d[4], 0);
  HandleSetAffineData(sprite, 256, 256, d[6]);
}

// Lua: mon_anim.lua:2785
function horizontalDip(sprite: MonSprite, d7: number, d3: number): void {
  const d = sprite.data;
  if (d[2] === 0) {
    HandleStartAffineAnim(sprite);
    d[7] = d7;
    d[5] = 8;
    d[4] = -32;
    d[3] = d3;
    d[0] = 0;
  }
  if (d[2] > d[7]) {
    HandleSetAffineData(sprite, 256, 256, 0);
    sprite.x2 = 0;
    sprite.y2 = 0;
    d[0] = d[0] + 1;
    if (d[3] <= d[0]) {
      ResetSpriteAfterAnim(sprite);
      sprite.callback = WaitAnimEnd;
      return;
    } else {
      d[2] = 0;
    }
  } else {
    SetHorizontalDip(sprite);
  }
  d[2] = d[2] + 1;
}

// pokeemerald/src/pokemon_animation.c:185
// Lua: mon_anim.lua:2814
F.Anim_HorizontalDip = (sprite: MonSprite): void => { horizontalDip(sprite, 60, 1); };
// Lua: mon_anim.lua:2815
F.Anim_HorizontalDip_Fast = (sprite: MonSprite): void => { horizontalDip(sprite, 90, 1); };
// Lua: mon_anim.lua:2816
F.Anim_HorizontalDip_Twice = (sprite: MonSprite): void => { horizontalDip(sprite, 30, 2); };

// pokeemerald/src/pokemon_animation.c:4961
// Lua: mon_anim.lua:2819
F.ShrinkGrowVibrate = (sprite: MonSprite): void => {
  const d = sprite.data;
  if (d[2] > d[7]) {
    sprite.y2 = 0;
    HandleSetAffineData(sprite, 256, 256, 0);
    ResetSpriteAfterAnim(sprite);
    sprite.callback = WaitAnimEnd;
  } else {
    let index = s16(mod(div(u16(mod(d[2], d[6]) * 256), d[6]), 256));
    let sinY: number;
    if (mod(d[2], 2) === 0) {
      d[4] = Sin(index, 32) + 256;
      d[5] = Sin(index, 32) + 256;
      sinY = s8(Sin(index, 32));
    } else {
      d[4] = Sin(index, 8) + 256;
      d[5] = Sin(index, 8) + 256;
      sinY = s8(Sin(index, 8));
    }
    let y = u16(div(sinY, 8));
    sprite.y2 = s16(y);
    HandleSetAffineData(sprite, d[4], d[5], 0);
  }
  d[2] = d[2] + 1;
}

// Lua: mon_anim.lua:2845
function sgvInit(sprite: MonSprite, d6: number, d7: number): void {
  const d = sprite.data;
  if (d[2] === 0) {
    HandleStartAffineAnim(sprite);
    sprite.y2 = s16(sprite.y2 + 2);
    d[6] = d6;
    d[7] = d7;
  }
  F.ShrinkGrowVibrate(sprite);
}

// Lua: mon_anim.lua:2856
F.Anim_ShrinkGrowVibrate_Fast = (sprite: MonSprite): void => { sgvInit(sprite, 40, 80); };
// Lua: mon_anim.lua:2857
F.Anim_ShrinkGrowVibrate = (sprite: MonSprite): void => { sgvInit(sprite, 40, 40); };
// Lua: mon_anim.lua:2858
F.Anim_ShrinkGrowVibrate_Slow = (sprite: MonSprite): void => { sgvInit(sprite, 80, 80); };

// pokeemerald/src/pokemon_animation.c:5040
// Lua: mon_anim.lua:2861
F.JoltRight = (sprite: MonSprite): void => {
  const d = sprite.data;
  TryFlipX(sprite);
  sprite.x2 = s16(sprite.x2 - d[2]);
  if (sprite.x2 <= -d[6]) {
    sprite.x2 = s16(-d[6]);
    d[7] = 2;
    sprite.callback = F.JoltRight_0;
  }
  TryFlipX(sprite);
}

// Lua: mon_anim.lua:2873
F.JoltRight_0 = (sprite: MonSprite): void => {
  const d = sprite.data;
  TryFlipX(sprite);
  sprite.x2 = s16(sprite.x2 + d[7]);
  d[7] = d[7] + 1;
  if (sprite.x2 >= 0) { sprite.callback = F.JoltRight_1; }
  TryFlipX(sprite);
}

// Lua: mon_anim.lua:2882
F.JoltRight_1 = (sprite: MonSprite): void => {
  const d = sprite.data;
  TryFlipX(sprite);
  sprite.x2 = s16(sprite.x2 + d[7]);
  d[7] = d[7] + 1;
  if (sprite.x2 > d[6]) {
    sprite.x2 = d[6];
    sprite.callback = F.JoltRight_2;
  }
  TryFlipX(sprite);
}

// Lua: mon_anim.lua:2894
F.JoltRight_2 = (sprite: MonSprite): void => {
  const d = sprite.data;
  TryFlipX(sprite);
  if (d[3] >= d[5]) {
    sprite.callback = F.JoltRight_3;
  } else {
    sprite.x2 = s16(sprite.x2 + d[4]);
    d[4] = -d[4];
    d[3] = d[3] + 1;
  }
  TryFlipX(sprite);
}

// Lua: mon_anim.lua:2907
F.JoltRight_3 = (sprite: MonSprite): void => {
  TryFlipX(sprite);
  sprite.x2 = s16(sprite.x2 - 2);
  if (sprite.x2 <= 0) {
    sprite.x2 = 0;
    ResetSpriteAfterAnim(sprite);
    sprite.callback = WaitAnimEnd;
  }
  TryFlipX(sprite);
}

// Lua: mon_anim.lua:2918
function joltInit(sprite: MonSprite, d7: number, d6: number, d5: number, d4: number, d2: number): void {
  HandleStartAffineAnim(sprite);
  const d = sprite.data;
  d[7] = d7; d[6] = d6; d[5] = d5; d[4] = d4; d[3] = 0; d[2] = d2;
  sprite.callback = F.JoltRight;
}

// pokeemerald/src/pokemon_animation.c:191
// Lua: mon_anim.lua:2926
F.Anim_JoltRight_Fast = (sprite: MonSprite): void => { joltInit(sprite, 4, 12, 16, 4, 2); };
// Lua: mon_anim.lua:2927
F.Anim_JoltRight = (sprite: MonSprite): void => { joltInit(sprite, 2, 8, 12, 2, 1); };
// Lua: mon_anim.lua:2928
F.Anim_JoltRight_Slow = (sprite: MonSprite): void => { joltInit(sprite, 0, 6, 6, 2, 1); };

// pokeemerald/src/pokemon_animation.c:5146
// Lua: mon_anim.lua:2931
function SetShakeFlashYellowPos(sprite: MonSprite): void {
  const d = sprite.data;
  sprite.x2 = d[1];
  if (d[0] > 1) {
    d[1] = s16(-d[1]);
    d[0] = 0;
  } else {
    d[0] = d[0] + 1;
  }
}

// pokeemerald/src/pokemon_animation.c:5216
const sShakeYellowFlashData = [
  [
    seq(0, 1), seq(1, 2), seq(0, 15), seq(1, 1), seq(0, 15), seq(1, 1), seq(0, 15), seq(1, 1), seq(0, 1),
    seq(1, 1), seq(0, 1), seq(1, 1), seq(0, 1), seq(1, 1), seq(0, 1), seq(1, 1), seq(0, 1), seq(1, 1), seq(0, 1),
    seq(0, 255),
  ],
  [
    seq(0, 5), seq(1, 1), seq(0, 15), seq(1, 4), seq(0, 2), seq(1, 2), seq(0, 2), seq(1, 2), seq(0, 2),
    seq(1, 2), seq(0, 2), seq(1, 2), seq(0, 2), seq(0, 255),
  ],
  [
    seq(0, 1), seq(1, 1), seq(0, 20), seq(1, 1), seq(0, 20), seq(1, 1), seq(0, 20), seq(1, 1), seq(0, 1),
    seq(0, 255),
  ],
] as number[][][];

// pokeemerald/src/pokemon_animation.c:5223
// Lua: mon_anim.lua:2960
F.ShakeFlashYellow = (sprite: MonSprite): void => {
  const d = sprite.data;
  let array = sShakeYellowFlashData[d[3]];
  SetShakeFlashYellowPos(sprite);
  if (array[d[6]][2] === 255) {
    sprite.x2 = 0;
    sprite.callback = WaitAnimEnd;
  } else {
    if (d[4] === 1) {
      if (array[d[6]][1] !== 0) {
        blend(sprite, 16, RGB_YELLOW);
      } else {
        blend(sprite, 0, RGB_YELLOW);
      }
      d[4] = 0;
    }
    if (array[d[6]][2] === d[5]) {
      d[4] = 1;
      d[5] = 0;
      d[6] = d[6] + 1;
    } else {
      d[5] = d[5] + 1;
    }
  }
}

// Lua: mon_anim.lua:2986
function shakeFlashInit(sprite: MonSprite, which: number): void {
  const d = sprite.data;
  d[2] = d[2] + 1;
  if (d[2] === 1) {
    d[7] = 0x100 + (sprite.paletteNum || 0) * 16;
    d[6] = 0; d[5] = 0; d[4] = 0; d[3] = which;
  }
  F.ShakeFlashYellow(sprite);
}

// Lua: mon_anim.lua:2996
F.Anim_ShakeFlashYellow_Fast = (sprite: MonSprite): void => { shakeFlashInit(sprite, 0); };
// Lua: mon_anim.lua:2997
F.Anim_ShakeFlashYellow = (sprite: MonSprite): void => { shakeFlashInit(sprite, 1); };
// Lua: mon_anim.lua:2998
F.Anim_ShakeFlashYellow_Slow = (sprite: MonSprite): void => { shakeFlashInit(sprite, 2); };

// pokeemerald/src/pokemon_animation.c:5308
const sShakeGlowColors = [ RGB_RED, RGB_GREEN, RGB_BLUE, RGB_BLACK ] as number[];

// pokeemerald/src/pokemon_animation.c:5306
// Lua: mon_anim.lua:3004
function ShakeGlow_Blend(sprite: MonSprite): void {
  const d = sprite.data;
  if (d[2] > 127) {
    blend(sprite, 0, RGB_RED);
    sprite.callback = WaitAnimEnd;
  } else {
    d[6] = Sin(d[2], 12);
    blend(sprite, d[6], sShakeGlowColors[d[1]]);
  }
}

// pokeemerald/src/pokemon_animation.c:5328
// Lua: mon_anim.lua:3016
function ShakeGlow_Move(sprite: MonSprite): void {
  const d = sprite.data;
  if (d[3] < d[4]) {
    TryFlipX(sprite);
    if (d[5] > d[0]) {
      d[3] = d[3] + 1;
      if (d[3] < d[4]) { d[5] = 0; }
      sprite.x2 = 0;
    } else {
      let sign = s8(1 - (mod(d[3], 2) * 2));
      sprite.x2 = s16(sign * Sin(mod(div(d[5] * 384, d[0]), 256), 6));
      d[5] = d[5] + 1;
    }
    TryFlipX(sprite);
  }
}

// Lua: mon_anim.lua:3033
function shakeGlow(sprite: MonSprite, d0: number, d4: number, color: number): void {
  const d = sprite.data;
  if (d[2] === 0) {
    d[7] = 0x100 + (sprite.paletteNum || 0) * 16;
    d[0] = d0; d[5] = 0; d[4] = d4; d[3] = 0; d[1] = color;
  }
  if (mod(d[2], 2) === 0) { ShakeGlow_Blend(sprite); }
  if (d[2] >= div(128 - d[0] * d[4], 2)) { ShakeGlow_Move(sprite); }
  d[2] = d[2] + 1;
}

// pokeemerald/src/pokemon_animation.c:197
// Lua: mon_anim.lua:3045
F.Anim_ShakeGlowRed_Fast = (sprite: MonSprite): void => { shakeGlow(sprite, 10, 2, 0); };
// Lua: mon_anim.lua:3046
F.Anim_ShakeGlowRed = (sprite: MonSprite): void => { shakeGlow(sprite, 20, 1, 0); };
// Lua: mon_anim.lua:3047
F.Anim_ShakeGlowRed_Slow = (sprite: MonSprite): void => { shakeGlow(sprite, 80, 1, 0); };
// Lua: mon_anim.lua:3048
F.Anim_ShakeGlowGreen_Fast = (sprite: MonSprite): void => { shakeGlow(sprite, 10, 2, 1); };
// Lua: mon_anim.lua:3049
F.Anim_ShakeGlowGreen = (sprite: MonSprite): void => { shakeGlow(sprite, 20, 1, 1); };
// Lua: mon_anim.lua:3050
F.Anim_ShakeGlowGreen_Slow = (sprite: MonSprite): void => { shakeGlow(sprite, 80, 1, 1); };
// Lua: mon_anim.lua:3051
F.Anim_ShakeGlowBlue_Fast = (sprite: MonSprite): void => { shakeGlow(sprite, 10, 2, 2); };
// Lua: mon_anim.lua:3052
F.Anim_ShakeGlowBlue = (sprite: MonSprite): void => { shakeGlow(sprite, 20, 1, 2); };
// Lua: mon_anim.lua:3053
F.Anim_ShakeGlowBlue_Slow = (sprite: MonSprite): void => { shakeGlow(sprite, 80, 1, 2); };


// pokeemerald/src/sprite.c:62
// Lua: mon_anim.lua:3073
function setFrame(sprite: MonSprite, cmd: MonAnimCmd): void {
  let duration = cmd.duration ?? 0;
  if (duration > 0) duration = duration - 1;
  sprite.animDelayCounter = duration;
  sprite.frame = cmd.frame!;
}

// Lua: mon_anim.lua:3080
function beginAnim(sprite: MonSprite): void {
  sprite.animCmdIndex = 0;
  sprite.animEnded = false;
  sprite.animLoopCounter = 0;
  const cmd = sprite.anims[sprite.animNum]![sprite.animCmdIndex + 1];
  if (cmd && cmd.frame != null) {
    sprite.animBeginning = false;
    setFrame(sprite, cmd);
  }
}

// Lua: mon_anim.lua:3093
function jumpToTopOfAnimLoop(sprite: MonSprite): void {
  if (sprite.animLoopCounter !== 0) {
    const list = sprite.anims[sprite.animNum]!;
    sprite.animCmdIndex = sprite.animCmdIndex - 1;
    while (!(list[sprite.animCmdIndex] && list[sprite.animCmdIndex]!.op === "loop")) {
      if (sprite.animCmdIndex === 0) break;
      sprite.animCmdIndex = sprite.animCmdIndex - 1;
    }
    sprite.animCmdIndex = sprite.animCmdIndex - 1;
  }
}

// pokeemerald/src/sprite.c:61
// Lua: mon_anim.lua:3106
function continueAnim(sprite: MonSprite): void {
  if (sprite.animDelayCounter !== 0) {
    if (!sprite.animPaused) sprite.animDelayCounter = sprite.animDelayCounter - 1;
  } else if (!sprite.animPaused) {
    sprite.animCmdIndex = sprite.animCmdIndex + 1;
    const list = sprite.anims[sprite.animNum]!;
    const cmd = list[sprite.animCmdIndex + 1];
    if (cmd == null || cmd.op === "end") {
      sprite.animCmdIndex = sprite.animCmdIndex - 1;
      sprite.animEnded = true;
    } else if (cmd.op === "jump") {
      sprite.animCmdIndex = cmd.target!;
      setFrame(sprite, list[cmd.target! + 1]!);
    } else if (cmd.op === "loop") {
      if (sprite.animLoopCounter !== 0) {
        sprite.animLoopCounter = sprite.animLoopCounter - 1;
      } else {
        sprite.animLoopCounter = cmd.count!;
      }
      jumpToTopOfAnimLoop(sprite);
      continueAnim(sprite);
    } else {
      setFrame(sprite, cmd);
    }
  }
}

// pokeemerald/src/sprite.c:901
// Lua: mon_anim.lua:3134
function animateSprite(sprite: MonSprite): void {
  if (sprite.animBeginning) beginAnim(sprite); else continueAnim(sprite);
  if (sprite.affineMode !== "off" && sprite.affineAnimBeginning) {
    sprite.affineAnimBeginning = false;
    const m = sprite.matrix;
    m.xScale = (sprite.affineAnimNum === 1) ? -256 : 256;
    m.yScale = 256;
    m.rotation = 0;
  }
}

// Lua: mon_anim.lua:3179
function createTask(sprite: MonSprite, fn: MonTask["fn"], priority: number): MonTask {
  const t: MonTask = { fn, priority, data: {}, active: true };
  const list = sprite.tasks;
  let at = len(list) + 1;
  for (const [i, other] of ipairs<MonTask>(list)) {
    if (other.priority > priority) { at = i; break; }
  }
  insert(list, at, t);
  return t;
}

// Lua: mon_anim.lua:3190
function destroyTask(sprite: MonSprite, task: MonTask): void {
  task.active = false;
  for (const [i, t] of ipairs<MonTask>(sprite.tasks)) {
    if (t === task) { remove(sprite.tasks, i); return; }
  }
}

// Lua: mon_anim.lua:3197
function runTasks(sprite: MonSprite): void {
  const snapshot = new Set<MonTask>();
  let i = 1;
  while (i <= len(sprite.tasks)) {
    const t = sprite.tasks[i]!;
    if (!snapshot.has(t)) {
      snapshot.add(t);
      if (t.active) t.fn(sprite, t);
      i = 1;
    } else {
      i = i + 1;
    }
  }
}

// pokeemerald/src/pokemon_animation.c:911
// Lua: mon_anim.lua:3213
function Task_HandleMonAnimation(sprite: MonSprite, task: MonTask): void {
  if (task.state === 0) {
    task.battlerId = sprite.data[0];
    task.speciesId = sprite.data[2];
    sprite.data[1] = 1;
    sprite.data[0] = 0;
    for (let i = 2; i <= 7; i++) sprite.data[i] = 0;
    sprite.callback = MonAnim.animFunction(task.animId)[0];
    sIsSummaryAnim = false;
    task.state = task.state + 1;
  }
  if (sprite.callback === SpriteCallbackDummy) {
    sprite.data[0] = task.battlerId!;
    sprite.data[2] = task.speciesId!;
    sprite.data[1] = 0;
    destroyTask(sprite, task);
  }
}

// Lua: mon_anim.lua:3256
function speciesConst(name: string): unknown {
  return Constants.of(GameVersion.get()).id("species", name);
}

// Lua: mon_anim.lua:3270
function playCry(opts: MonAnimOpts | undefined, species: unknown, pan: number): unknown {
  if (opts && opts.cry) return opts.cry(species, pan);
  try { Audio.playCry(species, 0, pan); } catch { /* pcall */ }
  return undefined;
}

// pokeemerald/src/pokemon.c:6784
// Lua: mon_anim.lua:3276
function Task_AnimateAfterDelay(sprite: MonSprite, task: MonTask): void {
  task.delay = task.delay! - 1;
  if (task.delay === 0) {
    MonAnim.launchFront(sprite, task.animId);
    destroyTask(sprite, task);
  }
}

// pokeemerald/src/pokemon.c:6793
// Lua: mon_anim.lua:3332
function Task_PokemonSummaryAnimateAfterDelay(sprite: MonSprite, task: MonTask): void {
  task.delay = task.delay! - 1;
  if (task.delay === 0) {
    MonAnim.startSummary(sprite, task.animId);
    destroyTask(sprite, task);
  }
}

// Lua: mon_anim.lua:3357
function wrap(sprite: MonSprite): void {
  const d = sprite.data;
  for (let i = 0; i <= 7; i++) d[i] = s16(d[i]!);
  sprite.x2 = s16(sprite.x2);
  sprite.y2 = s16(sprite.y2);
}

// Lua: mon_anim.lua:3443
const sheets: Record<string, { image: Image; w: number; h: number } | false> = {};

// Lua: mon_anim.lua:3468
let silhouette: Shader | false | undefined;

export const MonAnim = {
  // a getter: mon_anim_data imports this module (import cycle)
  get Data() { return Data; },
  oob: 0,
  F,
  s16, u16, u8, s8, div, mod,
  Sin, Cos,
  SpriteCallbackDummy: SpriteCallbackDummy as SpriteCallback,
  SpriteCallbackDummy_2: SpriteCallbackDummy_2 as SpriteCallback,

  // Lua: mon_anim.lua:3055
  /** [fn, name] */
  animFunction(id: number | undefined): [SpriteCallback, string] {
    const name = Data.functionName(id!);
    const fn = name != null ? F[name] : undefined;
    if (!fn) throw new Error("mon_anim: no port for anim function " + tostring(id) + " (" + tostring(name) + ")");
    return [fn, name!];
  },

  // Lua: mon_anim.lua:3062
  callbackName(sprite: MonSprite | undefined): string | undefined {
    const cb = sprite && sprite.callback;
    if (cb == null) return undefined;
    if (cb === SpriteCallbackDummy) return "SpriteCallbackDummy";
    if (cb === SpriteCallbackDummy_2) return "SpriteCallbackDummy_2";
    if (cb === MonAnimDummySpriteCallback) return "MonAnimDummySpriteCallback";
    for (const k of Object.keys(F)) if (F[k] === cb) return k;
    return "?";
  },

  // pokeemerald/src/sprite.c:1346
  // Lua: mon_anim.lua:3144
  startSpriteAnim(sprite: MonSprite, animNum: number): void {
    if (!sprite.anims[animNum]) return;
    sprite.animNum = animNum;
    sprite.animBeginning = true;
    sprite.animEnded = false;
  },

  // Lua: mon_anim.lua:3151
  newSprite(species: unknown, opts?: MonSpriteOpts): MonSprite {
    opts = opts ?? {};
    const sprite: MonSprite = {
      species: tonumber(species) ?? 0,
      data: [0, 0, 0, 0, 0, 0, 0, 0],
      x2: 0, y2: 0,
      invisible: false,
      hFlip: truthy(opts.hFlip), // `opts.hFlip and true or false`
      affineMode: opts.affineMode ?? "normal",
      affineAnimNum: 0,
      affineAnimBeginning: false,
      matrix: { xScale: 256, yScale: 256, rotation: 0 },
      centerToCornerVecX: -32,
      paletteNum: opts.paletteNum ?? 0,
      blendCoeff: 0, blendColor: 0,
      anims: Data.anims(species) ?? { 0: seq<MonAnimCmd>({ frame: 0, duration: 0 }, { op: "end" }) },
      animNum: 0, animCmdIndex: 0, animDelayCounter: 0, animLoopCounter: 0,
      animBeginning: true, animEnded: false, animPaused: false,
      frame: 0,
      callback: SpriteCallbackDummy,
      tasks: seq<MonTask>(),
      frames: 0,
    };
    for (const [i, v] of pairs<number>(opts.data ?? {})) sprite.data[i as number] = v;
    calcCenterToCornerVec(sprite);
    return sprite;
  },

  // pokeemerald/src/pokemon_animation.c:941
  // Lua: mon_anim.lua:3233
  launchFront(sprite: MonSprite, frontAnimId: number | undefined): void {
    const t = createTask(sprite, Task_HandleMonAnimation, 128);
    t.state = 0;
    t.animId = frontAnimId;
    sprite.animId = frontAnimId;
  },

  // pokeemerald/src/pokemon_animation.c:949
  // Lua: mon_anim.lua:3241
  startSummary(sprite: MonSprite, frontAnimId: number | undefined): void {
    sIsSummaryAnim = true;
    sprite.summary = true;
    sprite.animId = frontAnimId;
    sprite.callback = MonAnim.animFunction(frontAnimId)[0];
  },

  // pokeemerald/src/pokemon_animation.c:956
  // Lua: mon_anim.lua:3249
  launchBack(sprite: MonSprite, backAnimSet: number, nature: unknown): void {
    const t = createTask(sprite, Task_HandleMonAnimation, 128);
    t.state = 0;
    t.animId = Data.backAnimId(backAnimSet, nature);
    sprite.animId = t.animId;
  },

  // pokeemerald/src/pokemon.c:6988
  // Lua: mon_anim.lua:3262
  hasTwoFramesAnimation(speciesIn: unknown): boolean {
    const species = tonumber(speciesIn);
    return species !== speciesConst("SPECIES_CASTFORM")
      && species !== speciesConst("SPECIES_DEOXYS")
      && species !== speciesConst("SPECIES_SPINDA")
      && species !== speciesConst("SPECIES_UNOWN");
  },

  // pokeemerald/src/pokemon.c:6811
  // Lua: mon_anim.lua:3285
  doFront(sprite: MonSprite, species: unknown, noCry?: boolean, panModeAnimFlag?: number, opts?: MonAnimOpts): MonSprite {
    const flag = panModeAnimFlag ?? 0;
    const panMode = band(flag, 0x7F);
    const pan = panMode === 0 ? -25 : panMode === 1 ? 25 : 0;
    if (band(flag, 0x80) !== 0) {
      if (!noCry) playCry(opts, species, pan);
      sprite.callback = SpriteCallbackDummy;
      return sprite;
    }
    if (!noCry) {
      playCry(opts, species, pan);
      if (MonAnim.hasTwoFramesAnimation(species)) MonAnim.startSpriteAnim(sprite, 1);
    }
    const delay = Data.delay(species);
    const animId = Data.frontAnimId(species);
    if (delay !== 0) {
      const t = createTask(sprite, Task_AnimateAfterDelay, 0);
      t.animId = animId;
      t.delay = delay;
    } else {
      MonAnim.launchFront(sprite, animId);
    }
    sprite.callback = SpriteCallbackDummy_2;
    return sprite;
  },

  // Lua: mon_anim.lua:3311
  SKIP_FRONT_ANIM: 0x80,

  // pokeemerald/src/pokemon.c:6803
  // Lua: mon_anim.lua:3314
  battleFront(sprite: MonSprite, species: unknown, noCry?: boolean, panMode?: number, opts?: MonAnimOpts): MonSprite {
    let flag = panMode ?? 0;
    if (opts && opts.noAnimations) flag = flag + MonAnim.SKIP_FRONT_ANIM;
    return MonAnim.doFront(sprite, species, noCry, flag, opts);
  },

  // pokeemerald/src/pokemon.c:6886
  // Lua: mon_anim.lua:3321
  battleBack(sprite: MonSprite, species: unknown, nature: unknown, opts?: MonAnimOpts): MonSprite {
    if (opts && opts.noAnimations) {
      sprite.callback = SpriteCallbackDummy;
      return sprite;
    }
    MonAnim.launchBack(sprite, Data.backAnimSet(species), nature);
    sprite.callback = SpriteCallbackDummy_2;
    return sprite;
  },

  // pokeemerald/src/pokemon.c:6858
  // Lua: mon_anim.lua:3341
  summary(sprite: MonSprite, species: unknown, oneFrame?: boolean): MonSprite {
    if (!oneFrame && MonAnim.hasTwoFramesAnimation(species)) MonAnim.startSpriteAnim(sprite, 1);
    const delay = Data.delay(species);
    const animId = Data.frontAnimId(species);
    sprite.summary = true;
    if (delay !== 0) {
      const t = createTask(sprite, Task_PokemonSummaryAnimateAfterDelay, 0);
      t.animId = animId;
      t.delay = delay;
      sprite.callback = MonAnimDummySpriteCallback;
    } else {
      MonAnim.startSummary(sprite, animId);
    }
    return sprite;
  },

  // Lua: mon_anim.lua:3364
  animateSprites(sprite: MonSprite): void {
    sIsSummaryAnim = sprite.summary === true;
    sprite.callback(sprite);
    wrap(sprite);
    animateSprite(sprite);
  },

  // Lua: mon_anim.lua:3371
  runTasks(sprite: MonSprite): void {
    if (len(sprite.tasks) > 0) runTasks(sprite);
  },

  // Lua: mon_anim.lua:3375
  step(sprite: MonSprite | undefined, tasksFirst?: boolean): void {
    if (!sprite) return;
    if (tasksFirst) MonAnim.runTasks(sprite);
    MonAnim.animateSprites(sprite);
    if (!tasksFirst) MonAnim.runTasks(sprite);
    sprite.frames = sprite.frames + 1;
  },

  // Lua: mon_anim.lua:3383
  done(sprite: MonSprite | undefined): boolean {
    return sprite == null || (sprite.callback === SpriteCallbackDummy && len(sprite.tasks) === 0);
  },

  // Lua: mon_anim.lua:3387
  busy(sprite: MonSprite | undefined): boolean {
    return sprite != null && !MonAnim.done(sprite);
  },

  // Lua: mon_anim.lua:3391
  enabled(): boolean {
    return Data.available();
  },

  // Lua: mon_anim.lua:3395
  run(sprite: MonSprite, opts?: MonRunOpts): MonSprite {
    const o = opts ?? {};
    let limit = o.limit ?? 1200;
    sprite.task = Task.spawn(() => {
      if (sprite.stopped) return true;
      MonAnim.step(sprite, o.tasksFirst);
      if (o.onStep) o.onStep(sprite);
      if (MonAnim.done(sprite)) {
        if (o.onDone) o.onDone(sprite);
        return true;
      }
      limit = limit - 1;
      if (limit <= 0) {
        sprite.callback = SpriteCallbackDummy;
        if (o.onDone) o.onDone(sprite);
        return true;
      }
      return undefined;
    });
    return sprite;
  },

  // Lua: mon_anim.lua:3417
  stop(sprite: MonSprite | undefined): void {
    if (sprite) sprite.stopped = true;
  },

  // pokeemerald/src/pokemon_animation.c:984
  // Lua: mon_anim.lua:3422
  transform(sprite: MonSprite): MonTransform {
    const t = { x2: sprite.x2, y2: sprite.y2, invisible: sprite.invisible, frame: sprite.frame,
      blendCoeff: sprite.blendCoeff, blendColor: sprite.blendColor, sx: 0, sy: 0, rotation: 0 };
    if (sprite.affineMode === "off") {
      t.sx = sprite.hFlip ? -1 : 1;
      t.sy = 1;
      t.rotation = 0;
    } else {
      const m = sprite.matrix;
      const xs = m.xScale !== 0 ? m.xScale : 1;
      const ys = m.yScale !== 0 ? m.yScale : 1;
      t.sx = 256 / xs;
      t.sy = 256 / ys;
      t.rotation = -(floor(m.rotation / 256) * 2 * Math.PI / 256);
    }
    return t;
  },

  // pokeemerald/src/util.c:264
  // Lua: mon_anim.lua:3438
  /** [r, g, b, k] */
  blendRgb(sprite: MonSprite): [number, number, number, number] {
    const c = sprite.blendColor ?? 0;
    return [luaMod(c, 32) / 31, luaMod(floor(c / 32), 32) / 31, luaMod(floor(c / 1024), 32) / 31, (sprite.blendCoeff ?? 0) / 16];
  },

  // Lua: mon_anim.lua:3445
  framePic(speciesIn: unknown, frame: number, shiny?: boolean): { image: Image; w: number; h: number } | undefined {
    if ((tonumber(frame) ?? 0) === 0) return undefined;
    // `if not (love and love.graphics and love.image)`: the platform always has both.
    const species = tonumber(speciesIn);
    const key = GameVersion.get() + ":" + tostring(species) + ":" + tostring(frame)
      + (shiny ? ":s" : "");
    let hit = sheets[key];
    if (hit != null) return hit || undefined;
    const cache = Data.cache();
    const rgba = cache && cache.read(format(shiny ? Data.SHEET_SHINY : Data.SHEET, species));
    const size = 64 * 64 * 4;
    if (typeof rgba !== "string" || rgba.length < size * (frame + 1)) {
      sheets[key] = false;
      return undefined;
    }
    const img = newImageData(64, 64, "rgba8", rgba.substring(size * frame, size * (frame + 1)));
    const image = G.newImage(img);
    image.setFilter("nearest", "nearest");
    hit = { image, w: 64, h: 64 };
    sheets[key] = hit;
    return hit;
  },

  // Lua: mon_anim.lua:3470
  draw(sprite: MonSprite | undefined, image: Image | undefined, cx: number, cy: number, _opts?: unknown): void {
    if (!(sprite && image)) return;
    const t = MonAnim.transform(sprite);
    if (t.invisible) return;
    const x = cx + t.x2, y = cy + t.y2;
    const [r, g, b, a] = G.getColor();
    G.draw(image, x, y, t.rotation, t.sx, t.sy, 32, 32);
    if ((sprite.blendCoeff ?? 0) > 0) {
      if (silhouette === undefined) {
        // the "mon_anim colour + texture alpha" shader: effect tint_alpha
        try {
          silhouette = G.newShader("tint_alpha");
        } catch {
          silhouette = false;
        }
      }
      if (silhouette) {
        const [br, bg, bb, k] = MonAnim.blendRgb(sprite);
        G.setShader(silhouette);
        G.setColor(br, bg, bb, Math.min(1, k) * a);
        G.draw(image, x, y, t.rotation, t.sx, t.sy, 32, 32);
        G.setShader();
      }
    }
    G.setColor(r, g, b, a);
  },

  // Lua: mon_anim.lua:3498
  resetState(): void {
    for (let i = 0; i <= MAX_BATTLERS_COUNT - 1; i++) InitAnimData(i);
    sAnimIdx = 0;
    sIsSummaryAnim = false;
    MonAnim.oob = 0;
  },
};

export default MonAnim;
