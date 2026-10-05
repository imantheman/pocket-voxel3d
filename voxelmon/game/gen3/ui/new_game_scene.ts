// Port of gen1recomp src/ui/game3/new_game_scene.lua (GPLv3 + additional terms; see LICENSE.md).
//
// The new game scene: the controls guide, the Pikachu intro and Oak's speech
// (pokefirered/src/oak_speech.c), run as a small task list at the GBA's frame
// rate, with the naming screen handed off to ui/naming.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { Display } from "../core/display.ts";
import { Audio } from "../core/audio.ts";
import { RomText } from "../core/rom_text.ts";
import { Oam } from "../core/oam.ts";
import { Pal } from "../core/pal_fade.ts";
import { Fx } from "../core/gba_fx.ts";
import { Trig } from "../core/trig.ts";
import { MapIds } from "../core/map_ids.ts";
import { FrlgFont } from "./frlg_font.ts";
import { Chrome } from "./chrome.ts";
import { Window } from "./window.ts";
import { Naming } from "./naming.ts";
import { BallOpen } from "../core/battle/ball_open.ts";
import { Runtime as ModRuntime } from "../shared/mods/Runtime.ts";
import { Song } from "../core/song_ids.ts";
import { Rng } from "../core/rng.ts";
import { PokedexChrome } from "./pokedex_chrome.ts";
import { G } from "../platform/graphics.ts";
import type { Canvas, Image, Quad } from "../platform/image.ts";
import { seq, len, ipairs, insert } from "../platform/lt.ts";
import { gmatch, gsub, matchAll } from "../platform/lpattern.ts";
import { tonumber, tostring, truthy, mod } from "../../../import/gen3/lua.ts";

type Rgb = (number | null)[];

/** A task in the scene's own list (Brian's stand-in for gTasks). */
export interface Task {
  func: TaskFn;
  priority: number;
  data: any;
  alive: boolean;
  state: number;
}
export type TaskFn = (self: Scene, t: Task) => void;

/** The keys update() latches for a frame (`self.pending` / `self.input`). */
type Pressed = Partial<Record<string, boolean>>;

// Lua: new_game_scene.lua:21
let proxyPressed: Pressed | null = null;
let proxyInput: any = null;
const INPUT_PROXY = {
  wasPressed(k: string): boolean { return proxyPressed != null && proxyPressed[k] === true; },
  isDown(k: string): boolean { return (proxyInput != null && proxyInput.isDown && proxyInput.isDown(k)) || false; },
};

const SPECIES_NIDORAN_F = 29;

// Lua: new_game_scene.lua:30
const GUIDE_BLUE: Rgb = seq(0, 15, 24);
// Lua: new_game_scene.lua:31. Computed on first use rather than at load:
// pal_fade's constants are not there while the modules are still loading.
let GUIDE_FADE_MASK_: number | null = null;
function GUIDE_FADE_MASK(): number {
  if (GUIDE_FADE_MASK_ == null) GUIDE_FADE_MASK_ = Pal.OBJ + (Pal.BG - Pal.mask(seq(13)));
  return GUIDE_FADE_MASK_!;
}

const SLOT_BACKDROP = 0;
const SLOT_BG1 = 0;
const SLOT_TOPBAR = 13;
const SLOT_TEXT = 15;
const SLOT_PLAYER_PIC = 4;
const SLOT_OAK_PIC = 6;
const OBJ_MON = 0, OBJ_BALL = 1, OBJ_PARTICLES = 2, OBJ_PLATFORM = 3, OBJ_PIKACHU = 4, OBJ_CURSOR = 5;

const MALE = 0, FEMALE = 1;

const HINT_NEXT = "gText_ABUTTONNext";
const HINT_NEXT_BACK = "gText_ABUTTONNext_BBUTTONBack";

// pokefirered/src/text.c:36
const ARROW_FRAMES = seq(0, 1, 2, 1);
const CURSOR_DELAY = 8;

// Animation tables keep their Lua keys: `{ [0] = ... }` is an object keyed 0.
// pokefirered/src/oak_speech.c:412
const ANIMS_PLATFORM = seq(
  { 0: seq<any>({ img: 0, dur: 0 }, "end") },
  { 0: seq<any>({ img: 16, dur: 0 }, "end") },
  { 0: seq<any>({ img: 32, dur: 0 }, "end") },
);
// pokefirered/src/oak_speech.c:479
const ANIMS_PIKA_BODY = { 0: seq<any>({ img: 0, dur: 30 }, { img: 16, dur: 30 }, { jump: 0 }) };
// pokefirered/src/oak_speech.c:486
const ANIMS_PIKA_EARS = { 0: seq<any>(
  { img: 0, dur: 60 }, { img: 0, dur: 60 }, { img: 0, dur: 60 }, { img: 0, dur: 60 },
  { img: 0, dur: 60 }, { img: 0, dur: 60 }, { img: 8, dur: 12 }, { img: 0, dur: 12 },
  { img: 8, dur: 12 }, { img: 0, dur: 60 }, { img: 0, dur: 60 }, { img: 0, dur: 60 },
  { img: 8, dur: 12 }, { img: 0, dur: 12 }, { img: 8, dur: 12 }, { jump: 0 },
) };
// pokefirered/src/oak_speech.c:506
const ANIMS_PIKA_EYES = { 0: seq<any>(
  { img: 0, dur: 60 }, { img: 0, dur: 60 }, { img: 0, dur: 60 }, { img: 0, dur: 60 },
  { img: 0, dur: 60 }, { img: 2, dur: 8 }, { img: 0, dur: 8 }, { img: 2, dur: 8 },
  { img: 0, dur: 60 }, { img: 0, dur: 60 }, { img: 0, dur: 60 }, { img: 2, dur: 8 },
  { img: 0, dur: 8 }, { img: 2, dur: 8 }, { jump: 0 },
) };
// pokefirered/src/pokeball.c:132
const ANIMS_BALL = {
  0: seq<any>({ img: 0, dur: 1 }, "end"),
  1: seq<any>({ img: 4, dur: 5 }, { img: 8, dur: 5 }, "end"),
  2: seq<any>({ img: 4, dur: 5 }, { img: 0, dur: 5 }, "end"),
};
// pokefirered/src/data.c:124
const AFFINE_EMERGE = seq<any>({ v: 0x28, dur: 0 }, { v: 0x12, dur: 12 }, "end");
// pokefirered/src/data.c:131
const AFFINE_RETURN = seq<any>({ v: -0x2, dur: 18 }, { v: -0x10, dur: 15 }, "end");
const AFFINE_NORMAL = seq<any>({ v: 0x100, dur: 0 }, "end");

// pokefirered/src/oak_speech.c:201
const CONTROLS_WINDOWS: Record<number, any> = {
  2: seq(seq(6, 3), seq(6, 10), seq(6, 15)),
  3: seq(seq(6, 3), seq(6, 8), seq(6, 13)),
};
// pokefirered/src/oak_speech.c:576
const CONTROLS_PAGES = "sControlsGuide_Pages2And3_Strings";
// pokefirered/src/oak_speech.c:342
const PIKA_PAGES = "sPikachuIntro_Strings";
const OAK_TEXT: Record<string, string> = {
  welcome: "gOakSpeech_Text_WelcomeToTheWorld",
  this_world: "gOakSpeech_Text_ThisWorld",
  inhabited: "gOakSpeech_Text_IsInhabitedFarAndWide",
  study: "gOakSpeech_Text_IStudyPokemon",
  tell_me: "gOakSpeech_Text_TellMeALittleAboutYourself",
  ask_gender: "gOakSpeech_Text_AskPlayerGender",
  your_name: "gOakSpeech_Text_YourNameWhatIsIt",
  confirm_player: "gOakSpeech_Text_SoYourNameIsPlayer",
  rival_intro: "gOakSpeech_Text_WhatWasHisName",
  rival_name_ask: "gOakSpeech_Text_YourRivalsNameWhatWasIt",
  confirm_rival: "gOakSpeech_Text_ConfirmRivalName",
  remember_rival: "gOakSpeech_Text_RememberRivalsName",
  lets_go: "gOakSpeech_Text_LetsGo",
};

// Lua: new_game_scene.lua:109
// pokefirered/src/oak_speech.c:2128
function nameChoices(gender: number, rival: boolean): any {
  if (rival) return RomText.list("sRivalNameChoices");
  return RomText.list(gender === MALE ? "sMaleNameChoices" : "sFemaleNameChoices");
}

// Lua: new_game_scene.lua:115 (truncating division, Brian's own)
function idiv(a: number, b: number): number {
  const q = a / b;
  return q >= 0 ? Math.floor(q) : Math.ceil(q);
}

// Lua: new_game_scene.lua:120
// The quads are keyed by the frame's first tile (0, 16, 32, ...), as Brian's.
function tileQuads(img: any, tileW: number, tileH: number, frameTiles: number, count: number): Record<number, Quad> | null {
  if (!truthy(img)) return null;
  const [iw, ih] = (img as Image).getDimensions();
  const cols = iw / 8;
  const quads: Record<number, Quad> = {};
  for (let i = 0; i <= count - 1; i++) {
    const t = i * frameTiles;
    quads[t] = G.newQuad(mod(t, cols) * 8, Math.floor(t / cols) * 8, tileW * 8, tileH * 8, iw, ih);
  }
  return quads;
}

// Lua: new_game_scene.lua:132
function utf8Chars(s: string): (string | null)[] {
  const out: (string | null)[] = seq();
  for (const [ch] of gmatch(s, "[%z\x01-\x7F\xC2-\xF4][\x80-\xBF]*")) out[len(out) + 1] = ch as string;
  return out;
}

// ----------------------------------------------------------------------
// Text printer (pokefirered/src/text.c:629)
// ----------------------------------------------------------------------

type PrinterToken = "C" | "N" | "P" | "E";

class Printer {
  pages: (string | null)[] = seq();
  page = 1;
  revealed = 0;
  tokens: (PrinterToken | null)[] = seq();
  pos = 1;
  active = true;
  state: "char" | "clear" = "char";
  delay = 0;
  spedUp = false;
  canSpeedUp: boolean;
  arrowIdx = 0;
  arrowDelay = 0;
  arrowFrame: number | null = null;
  textSpeed = 0;

  constructor(canSpeedUp: boolean) {
    this.canSpeedUp = canSpeedUp;
  }

  // Lua: new_game_scene.lua:181
  render(newAB: any, heldAB: any): "update" | "repeat" | "finish" | "print" {
    if (this.state === "char") {
      if (truthy(heldAB) && this.spedUp) this.delay = 0;
      if (this.delay > 0 && this.textSpeed > 0) {
        this.delay = this.delay - 1;
        if (this.canSpeedUp && truthy(newAB)) {
          this.spedUp = true;
          this.delay = 0;
        }
        return "update";
      }
      this.delay = this.textSpeed;
      const tok = this.tokens[this.pos];
      this.pos = this.pos + 1;
      if (tok === "N") {
        this.revealed = this.revealed + 1;
        return "repeat";
      }
      if (tok === "P") {
        this.state = "clear";
        this.arrowIdx = 0;
        this.arrowDelay = 0;
        return "update";
      }
      if (tok === "E" || tok == null) {
        this.active = false;
        return "finish";
      }
      this.revealed = this.revealed + 1;
      return "print";
    } else {
      // pokefirered/src/text.c:471
      if (this.arrowDelay !== 0) {
        this.arrowDelay = this.arrowDelay - 1;
      } else {
        this.arrowFrame = ARROW_FRAMES[this.arrowIdx + 1] ?? null;
        this.arrowDelay = CURSOR_DELAY;
        this.arrowIdx = mod(this.arrowIdx + 1, 4);
      }
      if (truthy(newAB)) {
        Audio.playSe(Song.SE_SELECT);
        this.page = this.page + 1;
        this.revealed = 0;
        this.arrowFrame = null;
        this.state = "char";
      }
      return "update";
    }
  }

  // Lua: new_game_scene.lua:230
  run(newAB: any, heldAB: any): void {
    if (!this.active) return;
    for (let i = 1; i <= 64; i++) {
      if (this.render(newAB, heldAB) !== "repeat") return;
    }
  }

  // Lua: new_game_scene.lua:237
  draw(x: number, y: number, opts: { maxWidth?: number; colors?: any; linePitch?: number }): void {
    const text = this.pages[this.page] ?? "";
    const [, endX, endY] = FrlgFont.draw(text, x, y, {
      maxWidth: opts.maxWidth ?? 240,
      limitChars: this.revealed,
      colors: opts.colors ?? FrlgFont.COLOR.NORMAL,
      linePitch: opts.linePitch,
    });
    if (this.state === "clear" && this.arrowFrame != null && endX != null) {
      Chrome.promptArrow(endX, endY as number, this.arrowFrame);
    }
  }
}

// Lua: new_game_scene.lua:145
function newPrinter(text: string, speed: number, canSpeedUp: boolean): Printer {
  const p = new Printer(canSpeedUp);
  let pageText = "";
  for (const [, ch] of ipairs<string>(utf8Chars(text))) {
    if (ch === "\f") {
      p.pages[len(p.pages) + 1] = pageText;
      pageText = "";
      p.tokens[len(p.tokens) + 1] = "P";
    } else if (ch === "\n") {
      pageText = pageText + ch;
      p.tokens[len(p.tokens) + 1] = "N";
    } else {
      pageText = pageText + ch;
      p.tokens[len(p.tokens) + 1] = "C";
    }
  }
  p.pages[len(p.pages) + 1] = pageText;
  p.tokens[len(p.tokens) + 1] = "E";
  if (speed === 0) {
    p.textSpeed = 0;
    while (p.active) {
      const tok = p.tokens[p.pos];
      p.pos = p.pos + 1;
      if (tok === "C" || tok === "N") p.revealed = p.revealed + 1;
      else if (tok === "E" || tok == null) p.active = false;
    }
  } else {
    p.textSpeed = speed - 1;
  }
  return p;
}

// ----------------------------------------------------------------------
// Local helpers. In the Lua these sit between the Scene methods that use
// them; each keeps its line.
// ----------------------------------------------------------------------

// Lua: new_game_scene.lua:327
function destroyTask(t: Task | null | undefined): void {
  if (t) t.alive = false;
}

// Lua: new_game_scene.lua:346
function createSprite(_self: Scene, tmpl: any, x: number, y: number, sub: number): any {
  const [id, spr] = Oam.createSprite(tmpl, x, y, sub);
  if (spr == null) return null;
  spr._id = id!;
  spr.palSlot = Pal.objSlot(tmpl.palSlot ?? 0);
  spr.objBlend = tmpl.objBlend;
  spr.coordOffset = tmpl.coordOffset;
  if (truthy(tmpl.affine)) {
    spr.oam.affineMode = Oam.AFFINE_NORMAL;
    spr.affineScale = 1;
  }
  return spr;
}

// Lua: new_game_scene.lua:360
function destroySprite(spr: any): void {
  if (truthy(spr) && truthy(spr.inUse)) Oam.destroySprite(spr._id);
}

// Lua: new_game_scene.lua:405
function SpriteCB_TextCursor(s: any): void {
  // pokefirered/src/text.c:1284
  const d = s.data;
  if (d[1] !== 0) {
    d[1] = d[1] - 1;
  } else {
    d[1] = CURSOR_DELAY;
    if (d[2] === 0) s.y2 = 0;
    else if (d[2] === 1) s.y2 = 1;
    else if (d[2] === 2) s.y2 = 2;
    else {
      s.y2 = 1;
      d[2] = 0;
      return;
    }
    d[2] = d[2] + 1;
  }
}

// Lua: new_game_scene.lua:477
// Pic fade tasks (pokefirered/src/oak_speech.c:2014)
function Task_SlowFadeIn(self: Scene, t: Task): void {
  const d = t.data;
  if (d.bt1 === 0) {
    d.parent.data.picFadeState = 1;
    destroyTask(t);
    for (const [, spr] of ipairs(d.platform ?? seq())) spr.invisible = true;
  } else if (d.fadeTimer !== 0) {
    d.fadeTimer = d.fadeTimer - 1;
  } else {
    d.fadeTimer = d.delay;
    d.bt1 = d.bt1 - 1;
    d.bt2 = d.bt2 + 1;
    if (d.bt1 === 8) {
      for (const [, spr] of ipairs(d.platform ?? seq())) spr.invisible = !truthy(spr.invisible);
    }
    self.bldAlpha = { eva: d.bt1, evb: d.bt2 };
  }
}

// Lua: new_game_scene.lua:496
function Task_SlowFadeOut(self: Scene, t: Task): void {
  const d = t.data;
  if (d.bt1 === 16) {
    if (!self.fadeActive()) {
      d.parent.data.picFadeState = 1;
      destroyTask(t);
    }
  } else if (d.fadeTimer !== 0) {
    d.fadeTimer = d.fadeTimer - 1;
  } else {
    d.fadeTimer = d.delay;
    d.bt1 = d.bt1 + 2;
    d.bt2 = d.bt2 - 2;
    if (d.bt1 === 8) {
      for (const [, spr] of ipairs(d.platform ?? seq())) spr.invisible = !truthy(spr.invisible);
    }
    self.bldAlpha = { eva: d.bt1, evb: d.bt2 };
  }
}

// Lua: new_game_scene.lua:568
function Task_FadeMon_ToNormal_Step(self: Scene, t: Task): void {
  // pokefirered/src/battle_anim_special.c:1920
  const d = t.data;
  if (d.d2 <= 16) {
    self.pal.blend(Pal.mask(null, seq(OBJ_MON)), d.d0, self.ballFadeColor());
    d.d0 = d.d0 + d.d1;
    d.d2 = d.d2 + 1;
  } else {
    destroyTask(t);
  }
}

// Lua: new_game_scene.lua:580
function Task_FadeMon_ToNormal(self: Scene, t: Task): void {
  // pokefirered/src/battle_anim_special.c:1910
  if (!self.fadeActive()) {
    self.pal.beginFade(t.data.mask, 0, 16, 0, Pal.WHITE);
    t.func = Task_FadeMon_ToNormal_Step;
  }
}

// Lua: new_game_scene.lua:1414
function Task_OakSpeech_DestroyPlatformSprites(self: Scene, t: Task): void {
  // pokefirered/src/oak_speech.c:1685
  if (self.fadeActive()) return;
  if (t.data.bgFadeStarted) {
    destroyTask(t);
    const first = Oam.get(0);
    if (truthy(first)) destroySprite(first);
  } else {
    t.data.bgFadeStarted = true;
    self.pal.beginFade(0xF000, 0, 0, 16, Pal.BLACK);
  }
}

// Lua: new_game_scene.lua:1427
function Task_OakSpeech_FadePlayerPicWhite(self: Scene, t: Task): void {
  // pokefirered/src/oak_speech.c:1729
  const d = t.data;
  if (d.timer !== 0) {
    d.timer = d.timer - 1;
  } else {
    if (d.under <= 0 && d.secondary !== 0) d.secondary = d.secondary - 1;
    self.pal.blend(Pal.mask(seq(4, 5)), d.coeff, Pal.WHITE);
    d.coeff = d.coeff + 1;
    d.under = d.under - 1;
    d.timer = d.secondary;
    if (d.coeff > 14) {
      self.pal.setBase(4, Pal.WHITE);
      self.pal.setBase(5, Pal.WHITE);
      self.pal.blend(Pal.mask(seq(4, 5)), 0, Pal.WHITE);
      destroyTask(t);
    }
  }
}

// Lua: new_game_scene.lua:1521
const KEYS = seq("a", "b", "up", "down", "left", "right", "start", "select");

// Lua: new_game_scene.lua:1548
function drawImageFx(img: any, x: number, y: number, fx: any, blend?: any, clip?: any, sx?: number, sy?: number, ox?: number, oy?: number): void {
  if (!truthy(img)) return;
  Fx.withClip(clip, () => {
    Fx.draw(() => {
      G.draw(img, x, y, 0, sx ?? 1, sy ?? 1, ox ?? 0, oy ?? 0);
    }, fx, blend);
  });
}

// ----------------------------------------------------------------------
// The scene
// ----------------------------------------------------------------------

interface Menu {
  kind: string;
  left: number;
  top: number;
  width: number;
  height: number;
  items: any;
  cursorX: number;
  cursorY: number;
  pitch: number;
  cursor: number;
  wrap?: boolean;
}

interface Win {
  dialog?: boolean;
  topbar?: { title: string | null; hint: string | null } | null;
  guide?: { page: number } | null;
  pika?: { text: any } | null;
  menu?: Menu | null;
}

interface Naming_ {
  rival: boolean;
  stage: "setup" | "fade_in" | "input" | "fade_out" | "return";
  timer: number;
  pal: any;
}

export interface NewGameResult {
  action: "new_game";
  gender: number;
  name: string;
  rivalName: string;
  start: any;
}

export class Scene {
  // Lua: new_game_scene.lua:19
  static GBA_HZ = 16777216 / 280896;
  // Lua: new_game_scene.lua:113
  static nameChoices = nameChoices;

  assets: any;
  pal: any;
  tasks: (Task | null)[] = seq();
  accum = 0;
  pending: Pressed = {};
  frames = 0;
  section = "controls";
  textSpeedOption = 1;
  gender = MALE;
  playerName: any;
  rivalName: any;
  hasPlayerBeenNamed = false;
  coordOffsetX = 0;
  bg2X = 0;
  bld: { pic?: boolean; bg0?: boolean } | null = null;
  bldAlpha: { eva: number; evb: number } = { eva: 0, evb: 0 };
  backdrop: Rgb = Pal.BLACK;
  bg1: { image: any; topbarSplit?: boolean } | null = null;
  pic: { image: any; slot: number; hidden?: boolean } | null = null;
  win: Win = {};
  // `{ [0] = false, false, false }`: keys 0..2
  bgVisible: boolean[] = [false, false, false];
  namingFade: any = null;
  result: NewGameResult | null = null;
  q: { platform?: any; body?: any; ears?: any; eyes?: any; ball?: any } = {};
  textSpeed = 4;
  runIdx: number | null = null;
  printer: Printer | null = null;
  _oakStep: number | null = null;
  currentPage = 0;
  naming: Naming_ | null = null;
  input: Pressed = {};
  held = false;
  inputProxy: typeof INPUT_PROXY | null = null;
  shrinkTimer = 0;
  bg2Affine: { pa: number; pd: number } | null = null;
  win0Pika = false;
  _canvases: Record<string, Canvas> | null = null;

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  // Lua: new_game_scene.lua:254
  static new(assets?: any, opts?: any): Scene {
    opts = opts ?? {};
    const A = assets ?? {};
    const self = new Scene();
    self.assets = A;
    self.pal = Pal.new();
    self.tasks = seq();
    self.accum = 0;
    self.pending = {};
    self.frames = 0;
    self.section = "controls";
    self.textSpeedOption = tonumber(opts.textSpeed) ?? 1;
    self.gender = MALE;
    self.playerName = nameChoices(MALE, false)[1];
    self.rivalName = nameChoices(MALE, true)[1];
    self.hasPlayerBeenNamed = false;
    self.coordOffsetX = 0;
    self.bg2X = 0;
    self.bld = null;
    self.bldAlpha = { eva: 0, evb: 0 };
    self.backdrop = Pal.BLACK;
    self.bg1 = null;
    self.pic = null;
    self.win = {};
    self.bgVisible = [false, false, false];
    self.namingFade = null;
    self.result = null;
    // `if love and love.graphics and love.graphics.newQuad`: always true here
    self.q = {
      platform: tileQuads(A.platform, 4, 4, 16, 3),
      body: tileQuads(A.pikachuBody, 4, 4, 16, 2),
      ears: tileQuads(A.pikachuEars, 4, 2, 8, 2),
      eyes: tileQuads(A.pikachuEyes, 2, 1, 2, 2),
      ball: tileQuads(A.ballPoke, 2, 2, 4, 3),
    };
    self.textSpeed = ({ 0: 8, 1: 4, 2: 1 } as Record<number, number>)[self.textSpeedOption] ?? 4;
    Oam.destroyAll();
    BallOpen.reset();
    self.createTask(Scene.Task_NewGameScene, 0);
    return self;
  }

  // Lua: new_game_scene.lua:300
  destroy(): void {
    Oam.destroyAll();
    BallOpen.reset();
    this.tasks = seq();
  }

  // Lua: new_game_scene.lua:306
  createTask(fn: TaskFn, priority: number): Task {
    const t: Task = { func: fn, priority, data: {}, alive: true, state: 0 };
    let pos = len(this.tasks) + 1;
    for (const [i, other] of ipairs<Task>(this.tasks)) {
      if (other.priority > priority) {
        pos = i;
        break;
      }
    }
    insert(this.tasks, pos, t);
    if (this.runIdx != null && pos <= this.runIdx) this.runIdx = this.runIdx + 1;
    return t;
  }

  // Lua: new_game_scene.lua:320
  findTask(fn: TaskFn): Task | null {
    for (const [, t] of ipairs<Task>(this.tasks)) {
      if (t.alive && t.func === fn) return t;
    }
    return null;
  }

  // Lua: new_game_scene.lua:331
  runTasks(): void {
    this.runIdx = 1;
    while (this.runIdx <= len(this.tasks)) {
      const t = this.tasks[this.runIdx]!;
      if (t.alive) t.func(this, t);
      this.runIdx = this.runIdx + 1;
    }
    this.runIdx = null;
    const keep: (Task | null)[] = seq();
    for (let i = 1; this.tasks[i] != null; i++) {
      const t = this.tasks[i]!;
      if (t.alive) keep[len(keep) + 1] = t;
    }
    this.tasks = keep;
  }

  // Lua: new_game_scene.lua:364
  fadeActive(): boolean {
    return truthy(this.pal.fadeActive());
  }

  // Lua: new_game_scene.lua:368
  printerActive(): boolean {
    return this.printer != null && this.printer.active;
  }

  // Lua: new_game_scene.lua:373
  // pokefirered/src/oak_speech.c:1124
  _answered(label: string, value: any, saveKey: string): void {
    if (!truthy(ModRuntime.wants("intro.oak_speech.answered"))) return;
    ModRuntime.emit("intro.oak_speech.answered", {
      speech: this, step: { id: label }, index: this._oakStep ?? 0,
      label, value, saveKey,
    });
  }

  // Lua: new_game_scene.lua:381
  oakPrint(key: string, speed?: number): void {
    const textKey = OAK_TEXT[key];
    if (!truthy(textKey)) throw new Error(key);
    let text: string = RomText.ascii(textKey, { playerName: this.playerName, rivalName: this.rivalName });
    text = gsub(gsub(text, "\\p", "\f")[0], "\\l", "\n")[0];
    if (this.section === "oak") {
      this._oakStep = (this._oakStep ?? 0) + 1;
      if (truthy(ModRuntime.wants("intro.oak_speech.step"))) {
        ModRuntime.emit("intro.oak_speech.step", {
          speech: this, step: { id: key, text }, index: this._oakStep,
        });
      }
    }
    this.win.dialog = true;
    this.printer = newPrinter(text, speed == null ? this.textSpeed : speed, true);
  }

  // Lua: new_game_scene.lua:396
  clearDialog(): void {
    this.win.dialog = false;
    this.printer = null;
  }

  // ------------------------------------------------------------------
  // Sprites
  // ------------------------------------------------------------------

  // Lua: new_game_scene.lua:424
  createTextCursor(x: number, y: number, priority: number): any {
    // pokefirered/src/text.c:1313
    const spr = createSprite(this, {
      dims: Oam.SQUARE_16, priority, image: Chrome.textCursorImage(),
      callback: SpriteCB_TextCursor, palSlot: OBJ_CURSOR,
    }, x + 3, y + 4, 0);
    if (spr) spr.data[1] = CURSOR_DELAY;
    return spr;
  }

  // Lua: new_game_scene.lua:434
  createPikachuOrPlatform(t: Task, kind: string): void {
    // pokefirered/src/oak_speech.c:1904
    const A = this.assets;
    let ids: any[] = seq();
    if (kind === "pikachu") {
      const body = createSprite(this, {
        dims: Oam.SQUARE_32, priority: 0, image: A.pikachuBody,
        anims: ANIMS_PIKA_BODY, animQuads: this.q.body, palSlot: OBJ_PIKACHU,
      }, 16, 17, 2);
      // Lua: new_game_scene.lua:443
      const follow = (s: any): void => {
        s.y2 = body != null ? (body.animCmdIndex ?? 1) - 1 : 0;
      };
      const ears = createSprite(this, {
        dims: Oam.HRECT_32x16, priority: 0, image: A.pikachuEars,
        anims: ANIMS_PIKA_EARS, animQuads: this.q.ears, palSlot: OBJ_PIKACHU, callback: follow,
      }, 16, 9, 3);
      const eyes = createSprite(this, {
        dims: Oam.HRECT_16x8, priority: 0, image: A.pikachuEyes,
        anims: ANIMS_PIKA_EYES, animQuads: this.q.eyes, palSlot: OBJ_PIKACHU, callback: follow,
      }, 24, 13, 1);
      ids = seq(body, ears, eyes);
    } else {
      for (let i = 0; i <= 2; i++) {
        const spr = createSprite(this, {
          dims: Oam.SQUARE_32, priority: 2, image: A.platform,
          anims: ANIMS_PLATFORM[i + 1], animQuads: this.q.platform,
          palSlot: OBJ_PLATFORM, objBlend: true, coordOffset: true,
        }, i * 32 + 88, 112, 1);
        if (spr) spr.animPaused = true;
        ids[i + 1] = spr;
      }
    }
    t.data.platform = ids;
  }

  // Lua: new_game_scene.lua:469
  destroyPikachuOrPlatform(t: Task): void {
    for (const [, spr] of ipairs(t.data.platform ?? seq())) destroySprite(spr);
  }

  // Lua: new_game_scene.lua:516
  createFadeInTask(t: Task, delay: number): void {
    // pokefirered/src/oak_speech.c:2045
    this.bld = { pic: true };
    this.bldAlpha = { eva: 16, evb: 0 };
    t.data.picFadeState = 0;
    const t2 = this.createTask(Task_SlowFadeIn, 0);
    t2.data = { parent: t, bt1: 16, bt2: 0, delay, fadeTimer: delay, platform: t.data.platform };
  }

  // Lua: new_game_scene.lua:525
  createFadeOutTask(t: Task, delay: number): void {
    // pokefirered/src/oak_speech.c:2097
    this.bld = { pic: true };
    this.bldAlpha = { eva: 0, evb: 16 };
    t.data.picFadeState = 0;
    const t2 = this.createTask(Task_SlowFadeOut, 0);
    t2.data = { parent: t, bt1: 0, bt2: 16, delay, fadeTimer: delay, platform: t.data.platform };
  }

  // Lua: new_game_scene.lua:535
  // pokefirered/src/oak_speech.c:1966
  loadTrainerPic(which: string): void {
    const A = this.assets;
    if (which === "male") {
      this.pic = { image: A.boySprite, slot: SLOT_PLAYER_PIC };
    } else if (which === "female") {
      this.pic = { image: A.girlSprite, slot: SLOT_PLAYER_PIC };
    } else if (which === "rival") {
      this.pic = { image: A.rivalSprite, slot: SLOT_OAK_PIC };
    } else {
      this.pic = { image: A.oakSprite, slot: SLOT_OAK_PIC };
    }
    this.pal.restore(this.pic.slot);
    this.pal.restore(this.pic.slot + 1);
  }

  // Lua: new_game_scene.lua:550
  loadPlayerPic(): void {
    this.loadTrainerPic(this.gender === MALE ? "male" : "female");
  }

  // Lua: new_game_scene.lua:554
  clearTrainerPic(): void {
    if (this.pic) this.pic.hidden = true;
  }

  // ------------------------------------------------------------------
  // Poke Ball (pokefirered/src/pokeball.c:1026)
  // ------------------------------------------------------------------

  // Lua: new_game_scene.lua:562
  ballFadeColor(): any {
    const d = BallOpen.data();
    const c = truthy(d) && truthy(d.fadeColors) ? d.fadeColors[1] : null;
    return truthy(c) ? c : seq(31, 31, 31);
  }

  // Lua: new_game_scene.lua:588
  launchBallFadeMon(mask: number): void {
    // pokefirered/src/battle_anim_special.c:1865
    const t = this.createTask(Task_FadeMon_ToNormal, 5);
    t.data = { mask, d0: 16, d1: -1, d2: 0 };
    this.pal.blend(Pal.mask(null, seq(OBJ_MON)), 16, this.ballFadeColor());
    this.pal.beginFade(mask, 0, 0, 16, Pal.WHITE);
  }

  // Lua: new_game_scene.lua:596
  ballOpen(ball: any, mask: number): void {
    Oam.startAnim(ball, 1);
    BallOpen.startParticles(ball.x, ball.y, undefined); // Brian passes no ball item (nil)
    this.launchBallFadeMon(mask);
  }

  // Lua: new_game_scene.lua:602
  createReleaseBall(mon: any, x: number, y: number, delay: number, mask: number): any {
    // pokefirered/src/pokeball.c:1026
    const ball = createSprite(this, {
      dims: Oam.SQUARE_16, priority: 0, image: this.assets.ballPoke,
      anims: ANIMS_BALL, animQuads: this.q.ball, palSlot: OBJ_BALL,
    }, x, y, 0);
    if (!ball) return undefined;
    const finalX = mon.x, finalY = mon.y;
    mon.x = x;
    mon.y = y;
    mon.invisible = true;
    const scene = this;
    let trig = 0;
    // Lua: new_game_scene.lua:614
    const flyOut = (s: any): void => {
      // pokefirered/src/pokeball.c:1076
      let emerged = false, atFinal = false;
      if (truthy(s.animEnded)) s.invisible = true;
      if (truthy(mon.affineAnimEnded)) {
        Oam.startAffineAnim(mon, AFFINE_NORMAL);
        emerged = true;
      }
      mon.x = idiv((finalX - s.x) * trig, 128) + s.x;
      mon.y = idiv((finalY - s.y) * trig, 128) + s.y;
      if (trig < 128) {
        const sine = -idiv((Trig.SINE as number[])[mod(trig, 256) + 1], 8);
        trig = trig + 4;
        mon.x2 = sine;
        mon.y2 = sine;
      } else {
        mon.x = finalX;
        mon.y = finalY;
        mon.x2 = 0;
        mon.y2 = 0;
        atFinal = true;
      }
      if (truthy(s.animEnded) && emerged && atFinal) destroySprite(s);
    };
    // Lua: new_game_scene.lua:635
    ball.callback = (s: any): void => {
      if (delay === 0) {
        scene.ballOpen(s, mask);
        s.callback = flyOut;
        mon.invisible = false;
        Oam.startAffineAnim(mon, AFFINE_EMERGE);
        Oam.animateSprite(mon);
        trig = 0;
      } else {
        delay = delay - 1;
      }
    };
    return ball;
  }

  // Lua: new_game_scene.lua:650
  createTradeBall(mon: any, x: number, y: number, delay: number, mask: number): any {
    // pokefirered/src/pokeball.c:1138
    const ball = createSprite(this, {
      dims: Oam.SQUARE_16, priority: 0, image: this.assets.ballPoke,
      anims: ANIMS_BALL, animQuads: this.q.ball, palSlot: OBJ_BALL,
    }, x, y, 0);
    if (!ball) return null;
    const scene = this;
    let timer = 0, rise = 0;
    // Lua: new_game_scene.lua:659
    const ending = (s: any): void => {
      if (truthy(s.animEnded)) s.callback = Oam.DUMMY_CALLBACK;
    };
    // Lua: new_game_scene.lua:662
    const sendOff = (s: any): void => {
      // pokefirered/src/pokeball.c:1180
      timer = timer + 1;
      if (timer === 11) Audio.playSe(Song.SE_BALL_TRADE);
      if (truthy(mon.affineAnimEnded)) {
        Oam.startAnim(s, 2);
        mon.invisible = true;
        timer = 0;
        s.callback = ending;
      } else {
        rise = rise + 96;
        mon.y2 = Math.floor(-rise / 256);
      }
    };
    // Lua: new_game_scene.lua:676
    ball.callback = (s: any): void => {
      if (delay === 0) {
        scene.ballOpen(s, mask);
        s.callback = sendOff;
        Oam.startAffineAnim(mon, AFFINE_RETURN);
        Oam.animateSprite(mon);
        rise = 0;
      } else {
        delay = delay - 1;
      }
    };
    return ball;
  }

  // ------------------------------------------------------------------
  // Controls guide (pokefirered/src/oak_speech.c:708)
  // ------------------------------------------------------------------

  // Lua: new_game_scene.lua:694
  setTopBar(title: string | null, hint: string | null): void {
    this.win.topbar = { title, hint };
  }

  // Lua: new_game_scene.lua:698
  controlsLoadPage1(): void {
    // pokefirered/src/oak_speech.c:797
    this.setTopBar("gText_Controls", HINT_NEXT);
    this.win.guide = { page: 1 };
    this.bg1 = { image: this.assets.controlsPage1, topbarSplit: true };
  }

  // Lua: new_game_scene.lua:705
  static Task_NewGameScene(self: Scene, t: Task): void {
    const st = t.state;
    if (st === 0) {
      Oam.destroyAll();
      self.pal.reset();
      self.backdrop = Pal.BLACK;
    } else if (st === 7) {
      self.backdrop = GUIDE_BLUE;
      self.currentPage = 1;
      self.controlsLoadPage1();
      t.data.cursor = self.createTextCursor(230, 149, 0);
      self.pal.blend(Pal.ALL, 16, Pal.BLACK);
    } else if (st === 10) {
      self.pal.beginFade(Pal.ALL, 0, 16, 0, Pal.BLACK);
      self.bgVisible[0] = true;
      self.bgVisible[1] = true;
      Audio.playSong(Song.MUS_NEW_GAME_INSTRUCT, { restart: true });
      t.func = Scene.Task_ControlsGuide_HandleInput;
      t.state = 0;
      return;
    }
    t.state = st + 1;
  }

  // Lua: new_game_scene.lua:728
  static Task_ControlsGuide_LoadPage(self: Scene, t: Task): void {
    // pokefirered/src/oak_speech.c:809
    if (self.currentPage === 1) {
      self.controlsLoadPage1();
    } else {
      self.setTopBar(null, HINT_NEXT_BACK);
      self.win.guide = { page: self.currentPage };
      self.bg1 = { image: self.assets["controlsPage" + tostring(self.currentPage)], topbarSplit: true };
    }
    self.pal.beginFade(GUIDE_FADE_MASK(), -1, 16, 0, GUIDE_BLUE);
    t.func = Scene.Task_ControlsGuide_HandleInput;
  }

  // Lua: new_game_scene.lua:741
  static Task_ControlsGuide_HandleInput(self: Scene, t: Task): void {
    // pokefirered/src/oak_speech.c:839
    if (self.fadeActive()) return;
    const p = self.input;
    if (p.a || p.b) {
      if (p.a) {
        t.data.delta = 1;
        if (self.currentPage < 3) {
          self.pal.beginFade(GUIDE_FADE_MASK(), -1, 0, 16, GUIDE_BLUE);
        }
      } else {
        if (self.currentPage === 1) return;
        t.data.delta = -1;
        self.pal.beginFade(GUIDE_FADE_MASK(), -1, 0, 16, GUIDE_BLUE);
      }
      Audio.playSe(Song.SE_SELECT);
      t.func = Scene.Task_ControlsGuide_ChangePage;
    }
  }

  // Lua: new_game_scene.lua:761
  static Task_ControlsGuide_ChangePage(self: Scene, t: Task): void {
    // pokefirered/src/oak_speech.c:867
    if (self.fadeActive()) return;
    self.currentPage = self.currentPage + t.data.delta;
    if (self.currentPage <= 3) {
      self.win.guide = null;
      t.func = Scene.Task_ControlsGuide_LoadPage;
    } else {
      self.pal.beginFade(Pal.ALL, 2, 0, 16, Pal.BLACK);
      t.func = Scene.Task_ControlsGuide_Clear;
    }
  }

  // Lua: new_game_scene.lua:774
  static Task_ControlsGuide_Clear(self: Scene, t: Task): void {
    // pokefirered/src/oak_speech.c:907
    if (self.fadeActive()) return;
    self.win.guide = null;
    self.bg1 = null;
    destroySprite(t.data.cursor);
    t.data.cursor = null;
    self.backdrop = Pal.BLACK;
    t.data.timer = 32;
    t.func = Scene.Task_PikachuIntro_LoadPage1;
  }

  // ------------------------------------------------------------------
  // Pikachu intro (pokefirered/src/oak_speech.c:941)
  // ------------------------------------------------------------------

  // Lua: new_game_scene.lua:790
  static Task_PikachuIntro_LoadPage1(self: Scene, t: Task): void {
    const d = t.data;
    if (d.timer !== 0) {
      d.timer = d.timer - 1;
      return;
    }
    self.section = "pikachu";
    Audio.playSong(Song.MUS_NEW_GAME_INTRO, { restart: true });
    self.setTopBar(null, HINT_NEXT);
    self.bg1 = { image: self.assets.pikachuBg ?? self.assets.pikachuIntroBg };
    self.currentPage = 1;
    t.state = 0;
    d.blendTarget = 16;
    self.win.pika = { text: RomText.at(PIKA_PAGES, 0) };
    d.cursor = self.createTextCursor(226, 145, 0);
    if (d.cursor) d.cursor.objBlend = true;
    self.createPikachuOrPlatform(t, "pikachu");
    self.pal.beginFade(Pal.ALL, 2, 16, 0, Pal.BLACK);
    t.func = Scene.Task_PikachuIntro_HandleInput;
  }

  // Lua: new_game_scene.lua:811
  static Task_PikachuIntro_HandleInput(self: Scene, t: Task): void {
    // pokefirered/src/oak_speech.c:977
    const d = t.data;
    const st = t.state;
    const p = self.input;
    if (st === 0) {
      if (!self.fadeActive()) {
        self.win0Pika = true;
        t.state = 1;
      }
    } else if (st === 1) {
      if (p.a || p.b) {
        if (p.a) {
          self.currentPage = self.currentPage + 1;
        } else {
          if (self.currentPage === 1) return;
          self.currentPage = self.currentPage - 1;
        }
        Audio.playSe(Song.SE_SELECT);
        if (self.currentPage === 4) {
          t.state = 4;
        } else {
          self.bld = { bg0: true };
          self.bldAlpha = { eva: 16, evb: 0 };
          t.state = 2;
        }
      }
    } else if (st === 2) {
      d.blendTarget = d.blendTarget - 2;
      self.bldAlpha = { eva: d.blendTarget, evb: 16 - d.blendTarget };
      if (d.blendTarget <= 0) {
        self.win.pika = { text: RomText.at(PIKA_PAGES, self.currentPage - 1) };
        if (self.currentPage === 1) {
          self.setTopBar(null, HINT_NEXT);
        } else {
          self.setTopBar(null, HINT_NEXT_BACK);
        }
        t.state = 3;
      }
    } else if (st === 3) {
      d.blendTarget = d.blendTarget + 2;
      self.bldAlpha = { eva: d.blendTarget, evb: 16 - d.blendTarget };
      if (d.blendTarget >= 16) {
        d.blendTarget = 16;
        self.bld = null;
        t.state = 1;
      }
    } else if (st === 4) {
      destroySprite(d.cursor);
      d.cursor = null;
      Audio.playSong(Song.MUS_NEW_GAME_EXIT, { restart: true });
      d.blendTarget = 24;
      t.state = 5;
    } else {
      if (d.blendTarget !== 0) {
        d.blendTarget = d.blendTarget - 1;
      } else {
        t.state = 0;
        self.currentPage = 0;
        self.win0Pika = false;
        self.pal.beginFade(Pal.ALL, 2, 0, 16, Pal.BLACK);
        t.func = Scene.Task_PikachuIntro_Clear;
      }
    }
  }

  // Lua: new_game_scene.lua:877
  static Task_PikachuIntro_Clear(self: Scene, t: Task): void {
    // pokefirered/src/oak_speech.c:1080
    if (self.fadeActive()) return;
    self.win.topbar = null;
    self.win.pika = null;
    self.bg1 = null;
    self.destroyPikachuOrPlatform(t);
    t.data.timer = 80;
    t.func = Scene.Task_OakSpeech_Init;
  }

  // ------------------------------------------------------------------
  // Oak speech (pokefirered/src/oak_speech.c:1099)
  // ------------------------------------------------------------------

  // Lua: new_game_scene.lua:892
  static Task_OakSpeech_Init(self: Scene, t: Task): void {
    const d = t.data;
    if (d.timer !== 0) {
      d.timer = d.timer - 1;
      return;
    }
    self.section = "oak";
    self._oakStep = 0;
    if (truthy(ModRuntime.wants("intro.oak_speech.started"))) {
      ModRuntime.emit("intro.oak_speech.started", { speech: self, steps: seq() });
    }
    self.bg1 = { image: self.assets.oakSpeechBg };
    d.nidoran = createSprite(self, {
      dims: Oam.SQUARE_64, priority: 1, image: self.assets.nidoranFront,
      palSlot: OBJ_MON, affine: true,
    }, 96, 96, 1);
    if (d.nidoran) d.nidoran.invisible = true;
    self.loadTrainerPic("oak");
    self.createPikachuOrPlatform(t, "platform");
    Audio.playSong(Song.MUS_ROUTE24, { restart: true });
    self.pal.beginFade(Pal.ALL, 5, 16, 0, Pal.BLACK);
    d.timer = 80;
    self.bgVisible[2] = true;
    t.func = Scene.Task_OakSpeech_WelcomeToTheWorld;
  }

  // Lua: new_game_scene.lua:918
  static Task_OakSpeech_WelcomeToTheWorld(self: Scene, t: Task): void {
    const d = t.data;
    if (self.fadeActive()) return;
    if (d.timer !== 0) {
      d.timer = d.timer - 1;
    } else {
      self.oakPrint("welcome");
      t.func = Scene.Task_OakSpeech_ThisWorld;
    }
  }

  // Lua: new_game_scene.lua:929
  static Task_OakSpeech_ThisWorld(self: Scene, t: Task): void {
    if (self.printerActive()) return;
    self.oakPrint("this_world");
    t.data.timer = 30;
    t.func = Scene.Task_OakSpeech_ReleaseNidoranFFromPokeBall;
  }

  // Lua: new_game_scene.lua:936
  static Task_OakSpeech_ReleaseNidoranFFromPokeBall(self: Scene, t: Task): void {
    // pokefirered/src/oak_speech.c:1165
    const d = t.data;
    if (self.printerActive()) return;
    if (d.timer !== 0) d.timer = d.timer - 1;
    const mon = d.nidoran;
    if (mon) {
      mon.invisible = false;
      self.createReleaseBall(mon, 100, 66, 32, Pal.OBJ + 0x1FFF);
    }
    t.func = Scene.Task_OakSpeech_IsInhabitedFarAndWide;
    d.timer = 0;
  }

  // Lua: new_game_scene.lua:950
  static Task_OakSpeech_IsInhabitedFarAndWide(self: Scene, t: Task): void {
    // pokefirered/src/oak_speech.c:1183
    const d = t.data;
    if (truthy(Audio.isCryFinished())) {
      if (d.timer >= 96) t.func = Scene.Task_OakSpeech_IStudyPokemon;
    }
    if (d.timer < 0x4000) {
      d.timer = d.timer + 1;
      if (d.timer === 32) {
        self.oakPrint("inhabited");
        Audio.playCry(SPECIES_NIDORAN_F, 0);
      }
    }
  }

  // Lua: new_game_scene.lua:965
  static Task_OakSpeech_IStudyPokemon(self: Scene, t: Task): void {
    if (self.printerActive()) return;
    self.oakPrint("study");
    t.func = Scene.Task_OakSpeech_ReturnNidoranFToPokeBall;
  }

  // Lua: new_game_scene.lua:971
  static Task_OakSpeech_ReturnNidoranFToPokeBall(self: Scene, t: Task): void {
    // pokefirered/src/oak_speech.c:1210
    const d = t.data;
    if (self.printerActive()) return;
    self.clearDialog();
    if (d.nidoran) {
      d.ball = self.createTradeBall(d.nidoran, 100, 66, 32, Pal.OBJ + 0x1F3F);
    }
    d.timer = 48;
    d.spriteTimer = 64;
    t.func = Scene.Task_OakSpeech_TellMeALittleAboutYourself;
  }

  // Lua: new_game_scene.lua:984
  static Task_OakSpeech_TellMeALittleAboutYourself(self: Scene, t: Task): void {
    // pokefirered/src/oak_speech.c:1225
    const d = t.data;
    if (d.spriteTimer !== 0) {
      if (d.spriteTimer < 24 && d.nidoran) d.nidoran.y = d.nidoran.y - 1;
      d.spriteTimer = d.spriteTimer - 1;
    } else {
      if (d.timer === 48) {
        destroySprite(d.nidoran);
        destroySprite(d.ball);
        d.nidoran = null;
        d.ball = null;
      }
      if (d.timer !== 0) {
        d.timer = d.timer - 1;
      } else {
        self.oakPrint("tell_me");
        t.func = Scene.Task_OakSpeech_FadeOutOak;
      }
    }
  }

  // Lua: new_game_scene.lua:1005
  static Task_OakSpeech_FadeOutOak(self: Scene, t: Task): void {
    if (self.printerActive()) return;
    self.clearDialog();
    self.createFadeInTask(t, 2);
    t.data.timer = 48;
    t.func = Scene.Task_OakSpeech_AskPlayerGender;
  }

  // Lua: new_game_scene.lua:1013
  static Task_OakSpeech_AskPlayerGender(self: Scene, t: Task): void {
    // pokefirered/src/oak_speech.c:1267
    const d = t.data;
    if (d.picFadeState === 0) return;
    if (d.timer !== 0) {
      d.timer = d.timer - 1;
    } else {
      d.picPosX = -60;
      self.clearTrainerPic();
      self.oakPrint("ask_gender");
      t.func = Scene.Task_OakSpeech_ShowGenderOptions;
    }
  }

  // Lua: new_game_scene.lua:1027
  static Task_OakSpeech_ShowGenderOptions(self: Scene, t: Task): void {
    if (self.printerActive()) return;
    // pokefirered/src/oak_speech.c:1291
    self.win.menu = {
      kind: "gender", left: 18, top: 9, width: 9, height: 4,
      items: seq<any>(seq<any>(RomText.plain("gText_Boy"), 8, 1), seq<any>(RomText.plain("gText_Girl"), 8, 17)),
      cursorX: 0, cursorY: 1, pitch: 16, cursor: 0, wrap: false,
    };
    t.func = Scene.Task_OakSpeech_HandleGenderInput;
  }

  // Lua: new_game_scene.lua:1038
  menuInput(wrap: boolean): number | "none" | "b" {
    // pokefirered/src/menu.c:342
    const m = this.win.menu;
    const p = this.input;
    if (!m) return "none";
    if (p.a) {
      Audio.playSe(Song.SE_SELECT);
      return m.cursor;
    }
    if (p.b) return "b";
    const n = len(m.items);
    const delta = p.up ? -1 : (p.down ? 1 : 0);
    if (delta !== 0) {
      const old = m.cursor;
      let pos = m.cursor + delta;
      if (wrap) {
        if (pos < 0) pos = n - 1; else if (pos > n - 1) pos = 0;
        Audio.playSe(Song.SE_SELECT);
      } else {
        pos = Math.max(0, Math.min(n - 1, pos));
        if (pos !== old) Audio.playSe(Song.SE_SELECT);
      }
      m.cursor = pos;
    }
    return "none";
  }

  // Lua: new_game_scene.lua:1065
  static Task_OakSpeech_HandleGenderInput(self: Scene, t: Task): void {
    // pokefirered/src/oak_speech.c:1309
    const r = self.menuInput(false);
    if (r === 0) {
      self.gender = MALE;
    } else if (r === 1) {
      self.gender = FEMALE;
    } else {
      return;
    }
    self._answered("gender", self.gender, "gender");
    t.func = Scene.Task_OakSpeech_ClearGenderWindows;
  }

  // Lua: new_game_scene.lua:1079
  static Task_OakSpeech_ClearGenderWindows(self: Scene, t: Task): void {
    self.win.menu = null;
    self.clearDialog();
    t.func = Scene.Task_OakSpeech_LoadPlayerPic;
  }

  // Lua: new_game_scene.lua:1085
  static Task_OakSpeech_LoadPlayerPic(self: Scene, t: Task): void {
    // pokefirered/src/oak_speech.c:1340
    self.loadPlayerPic();
    self.createFadeOutTask(t, 2);
    t.data.timer = 32;
    t.func = Scene.Task_OakSpeech_YourNameWhatIsIt;
  }

  // Lua: new_game_scene.lua:1093
  static Task_OakSpeech_YourNameWhatIsIt(self: Scene, t: Task): void {
    const d = t.data;
    if (d.picFadeState === 0) return;
    if (d.timer !== 0) {
      d.timer = d.timer - 1;
    } else {
      d.picPosX = 0;
      self.oakPrint("your_name");
      t.func = Scene.Task_OakSpeech_FadeOutForPlayerNamingScreen;
    }
  }

  // Lua: new_game_scene.lua:1105
  static Task_OakSpeech_FadeOutForPlayerNamingScreen(self: Scene, t: Task): void {
    // pokefirered/src/oak_speech.c:1370
    if (self.printerActive()) return;
    self.pal.beginFade(Pal.ALL, 0, 0, 16, Pal.BLACK);
    self.hasPlayerBeenNamed = false;
    t.func = Scene.Task_OakSpeech_DoNamingScreen;
  }

  // Lua: new_game_scene.lua:1113
  static Task_OakSpeech_MoveRivalDisplayNameOptions(self: Scene, t: Task): void {
    // pokefirered/src/oak_speech.c:1380
    const d = t.data;
    if (self.printerActive()) return;
    if (d.picPosX > -60) {
      d.picPosX = d.picPosX - 2;
      self.coordOffsetX = self.coordOffsetX + 2;
      self.bg2X = self.bg2X - 2;
    } else {
      d.picPosX = -60;
      self.printNameChoices();
      t.func = Scene.Task_OakSpeech_HandleRivalNameInput;
    }
  }

  // Lua: new_game_scene.lua:1128
  printNameChoices(): void {
    // pokefirered/src/oak_speech.c:2117
    let names: any;
    if (!this.hasPlayerBeenNamed) {
      names = nameChoices(this.gender, false);
    } else {
      names = nameChoices(this.gender, true);
    }
    const items: any[] = seq<any>(seq<any>(RomText.plain("gOtherText_NewName"), 8, 1));
    const n = RomText.count("sRivalNameChoices")[0];
    for (let i = 1; i <= n; i++) items[len(items) + 1] = seq<any>(names[i], 8, 16 * i + 1);
    this.win.menu = {
      kind: "names", left: 2, top: 2, width: 12, height: 10,
      items, cursorX: 0, cursorY: 1, pitch: 16, cursor: 0,
    };
  }

  // Lua: new_game_scene.lua:1144
  static Task_OakSpeech_RepeatNameQuestion(self: Scene, t: Task): void {
    // pokefirered/src/oak_speech.c:1401
    self.printNameChoices();
    if (!self.hasPlayerBeenNamed) {
      self.oakPrint("your_name", 0);
    } else {
      self.oakPrint("rival_name_ask", 0);
    }
    t.func = Scene.Task_OakSpeech_HandleRivalNameInput;
  }

  // Lua: new_game_scene.lua:1155
  getDefaultName(choice: number): void {
    // pokefirered/src/oak_speech.c:2138
    if (!this.hasPlayerBeenNamed) {
      const list = nameChoices(this.gender, false);
      const r = Rng.Random();
      this.playerName = list[mod(r, len(list)) + 1];
      this._answered("name", this.playerName, "name");
    } else {
      this.rivalName = nameChoices(this.gender, true)[choice + 1];
      this._answered("rivalName", this.rivalName, "rivalName");
    }
  }

  // Lua: new_game_scene.lua:1168
  static Task_OakSpeech_HandleRivalNameInput(self: Scene, t: Task): void {
    // pokefirered/src/oak_speech.c:1413
    const r = self.menuInput(true);
    if (r === 0) {
      Audio.playSe(Song.SE_SELECT);
      self.pal.beginFade(Pal.ALL, 0, 0, 16, Pal.BLACK);
      t.func = Scene.Task_OakSpeech_DoNamingScreen;
    } else if (typeof r === "number" && r >= 1 && r <= 4) {
      Audio.playSe(Song.SE_SELECT);
      self.win.menu = null;
      self.getDefaultName(r - 1);
      t.data.nameNotConfirmed = true;
      t.func = Scene.Task_OakSpeech_ConfirmName;
    }
  }

  // Lua: new_game_scene.lua:1184
  static Task_OakSpeech_DoNamingScreen(self: Scene, t: Task): void {
    // pokefirered/src/oak_speech.c:1440
    if (self.fadeActive()) return;
    self.getDefaultName(0);
    const rival = self.hasPlayerBeenNamed;
    if (rival) self.win.menu = null;
    self.destroyPikachuOrPlatform(t);
    self.enterNaming(rival);
    destroyTask(t);
  }

  // ------------------------------------------------------------------
  // Naming screen hand-off (pokefirered/src/naming_screen.c)
  // ------------------------------------------------------------------

  // Lua: new_game_scene.lua:1199
  enterNaming(rival: boolean): void {
    this.naming = { rival, stage: "setup", timer: 8, pal: Pal.new() };
    this.naming.pal.blend(Pal.ALL, 16, Pal.BLACK);
    const scene = this;
    Naming.open({
      title: RomText.plain(rival ? "gText_RivalsName" : "gText_YourName"),
      maxLen: 7,
      seed: rival ? this.rivalName : this.playerName,
      template: rival ? "RIVAL" : "PLAYER",
      gender: this.gender,
      hold: true,
      // Lua: new_game_scene.lua:1210
      onDone: (name: any): void => {
        if (truthy(name) && name !== "") {
          if (rival) scene.rivalName = name; else scene.playerName = name;
          if (rival) {
            scene._answered("rivalName", name, "rivalName");
          } else {
            scene._answered("name", name, "name");
          }
        }
        scene.naming!.stage = "fade_out";
        scene.naming!.pal.beginFade(Pal.ALL, 0, 0, 16, Pal.BLACK);
      },
    });
  }

  // Lua: new_game_scene.lua:1225
  namingFrame(): void {
    const n = this.naming!;
    if (n.stage === "setup") {
      n.timer = n.timer - 1;
      if (n.timer <= 0) {
        n.stage = "fade_in";
        n.pal.beginFade(Pal.ALL, 0, 16, 0, Pal.BLACK);
      }
    } else if (n.stage === "fade_in") {
      n.pal.updateFade();
      if (!truthy(n.pal.fadeActive())) n.stage = "input";
    } else if (n.stage === "input") {
      Naming.handleInput(this.inputProxy);
      Naming.update(1 / Scene.GBA_HZ);
    } else if (n.stage === "fade_out") {
      n.pal.updateFade();
      if (!truthy(n.pal.fadeActive())) {
        Naming.dismiss();
        n.stage = "return";
        n.timer = 0;
      }
    } else if (n.stage === "return") {
      this.returnFromNamingFrame();
    }
  }

  // Lua: new_game_scene.lua:1251
  returnFromNamingFrame(): void {
    // pokefirered/src/oak_speech.c:1788
    const n = this.naming!;
    const st = n.timer;
    if (st === 0) {
      this.tasks = seq();
      Oam.destroyAll();
      BallOpen.reset();
      this.pal.reset();
      this.pal.blend(Pal.ALL, 16, Pal.BLACK);
      this.bld = null;
      this.clearDialog();
      this.win.menu = null;
      this.bg2X = 0;
    } else if (st === 6) {
      const t = this.createTask(Scene.Task_OakSpeech_ConfirmName, 0);
      if (!this.hasPlayerBeenNamed) {
        this.loadPlayerPic();
      } else {
        this.loadTrainerPic("rival");
      }
      t.data.picPosX = -60;
      this.coordOffsetX = 60;
      this.bg2X = -60;
      this.createPikachuOrPlatform(t, "platform");
      t.data.nameNotConfirmed = true;
    } else if (st === 7) {
      this.pal.beginFade(Pal.ALL, 0, 16, 0, Pal.BLACK);
      this.bgVisible[0] = true;
      this.bgVisible[1] = true;
      this.bgVisible[2] = true;
      this.naming = null;
      return;
    }
    n.timer = st + 1;
  }

  // ------------------------------------------------------------------
  // Name confirmation and rival
  // ------------------------------------------------------------------

  // Lua: new_game_scene.lua:1290
  static Task_OakSpeech_ConfirmName(self: Scene, t: Task): void {
    // pokefirered/src/oak_speech.c:1460
    const d = t.data;
    if (self.fadeActive()) return;
    if (d.nameNotConfirmed) {
      self.oakPrint(self.hasPlayerBeenNamed ? "confirm_rival" : "confirm_player");
      d.nameNotConfirmed = false;
      d.timer = 25;
    } else if (!self.printerActive()) {
      if (d.timer !== 0) {
        d.timer = d.timer - 1;
      } else {
        // pokefirered/src/menu.c:531
        const [yes, no] = matchAll(RomText.plain("gText_YesNo"), "^(.-)\n(.*)$") ?? [];
        self.win.menu = {
          kind: "yesno", left: 2, top: 2, width: 6, height: 4,
          items: seq(seq(yes, 8, 2), seq(no, 8, 2 + FrlgFont.LINE_PITCH)),
          cursorX: 0, cursorY: 2, pitch: 16, cursor: 0,
        };
        t.func = Scene.Task_OakSpeech_HandleConfirmNameInput;
      }
    }
  }

  // Lua: new_game_scene.lua:1314
  static Task_OakSpeech_HandleConfirmNameInput(self: Scene, t: Task): void {
    // pokefirered/src/oak_speech.c:1490
    const r = self.menuInput(false);
    if (r === "none") return;
    self.win.menu = null;
    if (r === 0) {
      Audio.playSe(Song.SE_SELECT);
      t.data.timer = 40;
      if (!self.hasPlayerBeenNamed) {
        self.clearDialog();
        self.createFadeInTask(t, 2);
        t.func = Scene.Task_OakSpeech_FadeOutPlayerPic;
      } else {
        self.oakPrint("remember_rival");
        t.func = Scene.Task_OakSpeech_FadeOutRivalPic;
      }
    } else {
      Audio.playSe(Song.SE_SELECT);
      if (!self.hasPlayerBeenNamed) {
        t.func = Scene.Task_OakSpeech_FadeOutForPlayerNamingScreen;
      } else {
        t.func = Scene.Task_OakSpeech_RepeatNameQuestion;
      }
    }
  }

  // Lua: new_game_scene.lua:1340
  static Task_OakSpeech_FadeOutPlayerPic(self: Scene, t: Task): void {
    const d = t.data;
    if (d.picFadeState === 0) return;
    self.clearTrainerPic();
    if (d.timer !== 0) {
      d.timer = d.timer - 1;
    } else {
      t.func = Scene.Task_OakSpeech_FadeInRivalPic;
    }
  }

  // Lua: new_game_scene.lua:1351
  static Task_OakSpeech_FadeOutRivalPic(self: Scene, t: Task): void {
    if (self.printerActive()) return;
    self.clearDialog();
    self.createFadeInTask(t, 2);
    t.func = Scene.Task_OakSpeech_ReshowPlayersPic;
  }

  // Lua: new_game_scene.lua:1358
  static Task_OakSpeech_FadeInRivalPic(self: Scene, t: Task): void {
    // pokefirered/src/oak_speech.c:1546
    self.bg2X = 0;
    t.data.picPosX = 0;
    self.coordOffsetX = 0;
    self.loadTrainerPic("rival");
    self.createFadeOutTask(t, 2);
    t.func = Scene.Task_OakSpeech_AskRivalsName;
  }

  // Lua: new_game_scene.lua:1368
  static Task_OakSpeech_AskRivalsName(self: Scene, t: Task): void {
    if (t.data.picFadeState === 0) return;
    self.oakPrint("rival_intro");
    self.hasPlayerBeenNamed = true;
    t.func = Scene.Task_OakSpeech_MoveRivalDisplayNameOptions;
  }

  // Lua: new_game_scene.lua:1375
  static Task_OakSpeech_ReshowPlayersPic(self: Scene, t: Task): void {
    // pokefirered/src/oak_speech.c:1568
    const d = t.data;
    if (d.picFadeState === 0) return;
    self.clearTrainerPic();
    if (d.timer !== 0) {
      d.timer = d.timer - 1;
    } else {
      self.loadPlayerPic();
      d.picPosX = 0;
      self.coordOffsetX = 0;
      self.bg2X = 0;
      self.createFadeOutTask(t, 2);
      t.func = Scene.Task_OakSpeech_LetsGo;
    }
  }

  // Lua: new_game_scene.lua:1392
  static Task_OakSpeech_LetsGo(self: Scene, t: Task): void {
    if (t.data.picFadeState === 0) return;
    self.oakPrint("lets_go");
    t.data.timer = 30;
    t.func = Scene.Task_OakSpeech_FadeOutBGM;
  }

  // Lua: new_game_scene.lua:1399
  static Task_OakSpeech_FadeOutBGM(self: Scene, t: Task): void {
    // pokefirered/src/oak_speech.c:1605
    if (self.printerActive()) return;
    if (t.data.timer !== 0) {
      t.data.timer = t.data.timer - 1;
    } else {
      Audio.fadeOutBgm(4);
      t.func = Scene.Task_OakSpeech_SetUpExitAnimation;
    }
  }

  // ------------------------------------------------------------------
  // Exit (pokefirered/src/oak_speech.c:1624)
  // ------------------------------------------------------------------

  // Lua: new_game_scene.lua:1447
  static Task_OakSpeech_SetUpExitAnimation(self: Scene, t: Task): void {
    self.shrinkTimer = 0;
    const t2 = self.createTask(Task_OakSpeech_DestroyPlatformSprites, 1);
    t2.data.bgFadeStarted = false;
    self.pal.beginFade(Pal.OBJ + 0x0FCF, 4, 0, 16, Pal.BLACK);
    const t3 = self.createTask(Task_OakSpeech_FadePlayerPicWhite, 2);
    t3.data = { timer: 8, under: 0, secondary: 8, coeff: 0 };
    t.data.scaleDelta = 256;
    t.func = Scene.Task_OakSpeech_ShrinkPlayerPic;
  }

  // Lua: new_game_scene.lua:1458
  static Task_OakSpeech_ShrinkPlayerPic(self: Scene, t: Task): void {
    // pokefirered/src/oak_speech.c:1647
    const d = t.data;
    self.shrinkTimer = self.shrinkTimer + 1;
    if (mod(self.shrinkTimer, 20) === 0) {
      if (self.shrinkTimer === 40) Audio.playSe(Song.SE_WARP_IN);
      const old = d.scaleDelta;
      d.scaleDelta = d.scaleDelta - 32;
      self.bg2Affine = { pa: idiv(0x10000, old - 8), pd: idiv(0x10000, d.scaleDelta - 16) };
      if (d.scaleDelta <= 96) {
        d.fadeOutTimer = 36;
        t.func = Scene.Task_OakSpeech_FadePlayerPicToBlack;
      }
    }
  }

  // Lua: new_game_scene.lua:1474
  static Task_OakSpeech_FadePlayerPicToBlack(self: Scene, t: Task): void {
    if (t.data.fadeOutTimer !== 0) {
      t.data.fadeOutTimer = t.data.fadeOutTimer - 1;
    } else {
      self.pal.beginFade(0x0030, 2, 0, 16, Pal.BLACK);
      t.func = Scene.Task_OakSpeech_WaitForFade;
    }
  }

  // Lua: new_game_scene.lua:1483
  static Task_OakSpeech_WaitForFade(self: Scene, t: Task): void {
    if (!self.fadeActive()) t.func = Scene.Task_OakSpeech_FreeResources;
  }

  // Lua: new_game_scene.lua:1487
  static Task_OakSpeech_FreeResources(self: Scene, t: Task): void {
    // pokefirered/src/oak_speech.c:1777
    destroyTask(t);
    const answers: any = { gender: self.gender, name: self.playerName, rivalName: self.rivalName };
    if (truthy(ModRuntime.wants("intro.oak_speech.finished"))) {
      ModRuntime.emit("intro.oak_speech.finished", { speech: self, answers });
    }
    self.result = {
      action: "new_game",
      gender: tonumber(answers.gender) ?? self.gender,
      name: typeof answers.name === "string" && answers.name !== "" ? answers.name : self.playerName,
      rivalName: typeof answers.rivalName === "string" && answers.rivalName !== "" ? answers.rivalName : self.rivalName,
      start: MapIds.NEW_GAME_START,
    };
  }

  // ------------------------------------------------------------------
  // Frame driver (pokefirered/src/oak_speech.c:677)
  // ------------------------------------------------------------------

  // Lua: new_game_scene.lua:1507
  frame(): void {
    this.frames = this.frames + 1;
    if (this.naming) {
      this.namingFrame();
      if (this.naming) return;
      return;
    }
    this.runTasks();
    if (this.printer) this.printer.run(this.input.a || this.input.b, this.held);
    BallOpen.tick();
    Oam.animateSprites();
    this.pal.updateFade();
  }

  // Lua: new_game_scene.lua:1523
  // `input` is Brian's Input object (colon methods wasPressed/isDown); dt in seconds.
  update(input: any, dt?: number): NewGameResult | null {
    if (input != null && input.wasPressed) {
      for (let i = 1; KEYS[i] != null; i++) { // ipairs(KEYS), without the generator
        const k = KEYS[i]!;
        if (truthy(input.wasPressed(k))) this.pending[k] = true;
      }
    }
    const held = (input != null && input.isDown && (truthy(input.isDown("a")) || truthy(input.isDown("b")))) || false;
    this.accum = this.accum + (dt ?? 1 / 60);
    const step = 1 / Scene.GBA_HZ;
    while (this.accum >= step && !this.result) {
      this.accum = this.accum - step;
      this.input = this.pending;
      this.pending = {};
      this.held = held;
      proxyPressed = this.input;
      proxyInput = input;
      this.inputProxy = INPUT_PROXY;
      this.frame();
    }
    return this.result;
  }

  // ------------------------------------------------------------------
  // Draw
  // ------------------------------------------------------------------

  // Lua: new_game_scene.lua:1557
  drawTopBar(): void {
    // pokefirered/src/menu.c:187
    const tb = this.win.topbar;
    if (!tb) return;
    const white = FrlgFont.COLOR.WHITE;
    if (tb.title != null) {
      FrlgFont.draw(RomText.plain(tb.title), 4, 1, { colors: white, maxWidth: 120 });
    }
    if (tb.hint != null) {
      PokedexChrome.drawControlInfo(RomText.plain(tb.hint), 236, 1);
    }
  }

  // Lua: new_game_scene.lua:1570
  drawBg0Text(): void {
    const win = this.win;
    const white = FrlgFont.COLOR.WHITE;
    if (win.guide) {
      // pokefirered/src/oak_speech.c:803
      if (win.guide.page === 1) {
        FrlgFont.draw(RomText.plain("gControlsGuide_Text_Intro"), 2, 7 * 8, { colors: white, maxWidth: 238 });
      } else {
        const base = (win.guide.page - 2) * 3;
        for (const [i, w] of ipairs<any>(CONTROLS_WINDOWS[win.guide.page])) {
          FrlgFont.draw(RomText.at(CONTROLS_PAGES, base + i - 1), w[1] * 8 + 6, w[2] * 8, { colors: white, maxWidth: 192 });
        }
      }
    }
    if (win.pika) {
      // pokefirered/src/oak_speech.c:967
      FrlgFont.draw(win.pika.text, 8 + 3, 32 + 5, {
        colors: FrlgFont.COLOR.DARK_GRAY, maxWidth: 221, linePitch: FrlgFont.GLYPH_HEIGHT,
      });
    }
    if (win.dialog) {
      Chrome.dialogueFrame();
      if (this.printer) {
        this.printer.draw(Chrome.DLG_LEFT * 8, Chrome.DLG_TOP * 8 + 1, { maxWidth: Chrome.DLG_W * 8 });
      }
    }
    const m = win.menu;
    if (m) {
      const tpl = Window.template(m.left, m.top, m.width, m.height);
      Window.stdFrame(tpl);
      Window.fill(tpl, 1, 1, 1, 1);
      const ox = m.left * 8, oy = m.top * 8;
      for (let i = 1; m.items[i] != null; i++) {
        const it = m.items[i];
        Window.printPx(it[1], ox + it[2], oy + it[3]);
      }
      Window.cursorPx(ox + m.cursorX, oy + m.cursorY + m.cursor * m.pitch);
    }
  }

  // Lua: new_game_scene.lua:1609
  layerCanvas(key: string): Canvas {
    this._canvases = this._canvases ?? {};
    let c = this._canvases[key];
    if (!c) {
      c = G.newCanvas(Display.W, Display.H);
      c.setFilter("nearest", "nearest");
      this._canvases[key] = c;
    }
    return c;
  }

  // Lua: new_game_scene.lua:1620
  renderToCanvas(key: string, fn: () => void): Canvas {
    const c = this.layerCanvas(key);
    G.push("all");
    G.setCanvas(c);
    G.origin();
    G.setScissor();
    G.setShader();
    G.clear(0, 0, 0, 0);
    G.setColor(1, 1, 1, 1);
    fn();
    G.pop();
    return c;
  }

  // Lua: new_game_scene.lua:1634
  drawSprites(priority: number): void {
    const buf = Oam._buffer ?? seq();
    for (let i = 1; buf[i] != null; i++) {
      const s = buf[i];
      if ((s.oam.priority ?? 0) === priority) {
        Oam.flushOne(s);
      }
    }
  }

  // Lua: new_game_scene.lua:1642
  prepareSprites(): void {
    const blend = this.bld && this.bld.pic ? this.bldAlpha : null;
    const pikaBlend = this.bld && this.bld.bg0 ? this.bldAlpha : null;
    for (let i = 0; i <= Oam.MAX_SPRITES - 1; i++) {
      const s = Oam._sprites![i]!;
      if (truthy(s.inUse)) {
        let fx: any = null;
        if (s.palSlot != null) fx = this.pal.fx(s.palSlot);
        s.fx = truthy(fx) ? fx : null;
        s.blend = null;
        if (truthy(s.objBlend)) {
          if (truthy(s.coordOffset)) {
            s.blend = blend;
          } else {
            s.blend = pikaBlend;
          }
        }
        if (truthy(s.coordOffset)) s.x2 = this.coordOffsetX;
      }
    }
    Oam.buildOamBuffer(true);
  }

  // Lua: new_game_scene.lua:1663
  drawPic(): void {
    const pic = this.pic;
    if (!(pic && truthy(pic.image) && !pic.hidden && this.bgVisible[2])) return;
    const fx = this.pal.fx(pic.slot);
    const blend = this.bld && this.bld.pic ? this.bldAlpha : null;
    const aff = this.bg2Affine;
    if (aff) {
      // pokefirered/src/oak_speech.c:1662
      const mx = 256 / aff.pa, my = 256 / aff.pd;
      drawImageFx(pic.image, 120 + (88 - 120) * mx, 84 + (16 - 84) * my, fx, blend, null, mx, my);
    } else {
      drawImageFx(pic.image, 88 - this.bg2X, 16, fx, blend);
    }
  }

  // Lua: new_game_scene.lua:1678
  draw(): void {
    if (this.naming) {
      if (this.naming.stage !== "return" && truthy(Naming.isOpen())) Naming.draw();
      let y = this.naming.pal.slots[0].y;
      if (this.naming.stage === "return") y = 16;
      if (y > 0) {
        G.setColor(0, 0, 0, y / 16);
        G.rectangle("fill", 0, 0, Display.W, Display.H);
        G.setColor(1, 1, 1, 1);
      }
      return;
    }
    const W = Display.W, H = Display.H;
    const bd = this.backdrop ?? Pal.BLACK;
    const fxBd = this.pal.fx(SLOT_BACKDROP);
    let c = bd;
    if (truthy(fxBd)) {
      const y = fxBd.y ?? 0;
      const col = fxBd.color ?? Pal.BLACK;
      c = seq(bd[1]! + Math.floor((col[1] - bd[1]!) * y / 16), bd[2]! + Math.floor((col[2] - bd[2]!) * y / 16),
        bd[3]! + Math.floor((col[3] - bd[3]!) * y / 16));
    }
    G.clear(c[1]! / 31, c[2]! / 31, c[3]! / 31, 1);

    this.prepareSprites();

    if (this.bg1 && truthy(this.bg1.image) && this.bgVisible[1]) {
      const img = this.bg1.image;
      if (this.bg1.topbarSplit) {
        drawImageFx(img, 0, 0, this.pal.fx(SLOT_TOPBAR), null, { x: 0, y: 0, w: W, h: 24 });
        drawImageFx(img, 0, 0, this.pal.fx(SLOT_TOPBAR), null, { x: 0, y: 152, w: W, h: 8 });
        drawImageFx(img, 0, 0, this.pal.fx(SLOT_BG1), null, { x: 0, y: 24, w: W, h: 128 });
      } else {
        drawImageFx(img, 0, 0, this.pal.fx(SLOT_BG1));
      }
    }
    this.drawSprites(3);
    this.drawSprites(2);
    this.drawPic();
    this.drawSprites(1);
    if (this.bgVisible[0]) {
      if (this.win.topbar) {
        const tb = this.renderToCanvas("topbar", () => { this.drawTopBar(); });
        drawImageFx(tb, 0, 0, this.pal.fx(SLOT_TOPBAR));
      }
      const text = this.renderToCanvas("bg0", () => { this.drawBg0Text(); });
      const blend = this.bld && this.bld.bg0 ? this.bldAlpha : null;
      const clip = blend ? { x: 0, y: 16, w: W, h: H - 16 } : null;
      drawImageFx(text, 0, 0, this.pal.fx(SLOT_TEXT), blend, clip);
    }
    this.drawSprites(0);
    Fx.draw(() => { BallOpen.draw(); }, this.pal.fx(Pal.objSlot(OBJ_PARTICLES)));
  }
}

export default Scene;
