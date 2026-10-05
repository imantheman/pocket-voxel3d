// Port of gen1recomp src/ui/game3/egg_hatch.lua (GPLv3 + additional terms; see LICENSE.md).
// pokefirered/src/daycare.c:1749 EggHatch
//
// `package.loaded["src.ui.game3.choice"]` reads are the static import (always loaded).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tonumber, tostring } from "../../../import/gen3/lua.ts";
import { Extract } from "../../../import/gen3/extract_island1.ts";
import { Stack } from "./stack.ts";
import { Display } from "../core/display.ts";
import { Message } from "./message.ts";
import { Pokemon } from "../core/pokemon.ts";
import { Audio } from "../core/audio.ts";
import { Oam } from "../core/oam.ts";
import { SE } from "../core/se_ids.ts";
import { RomText } from "../core/rom_text.ts";
import { BattleChrome } from "./battle_chrome.ts";
import { Breeding } from "../core/breeding.ts";
import { Song } from "../core/song_ids.ts";
import { Rng } from "../core/rng.ts";
import { MonAnim, type MonSprite } from "../core/mon_anim.ts";
import { Choice } from "./choice.ts";
import { Naming } from "./naming.ts";
import { Profile } from "../core/profile.ts";
import { G } from "../platform/graphics.ts";
import { Fs } from "../platform/fs.ts";
import { newImageData, type Image, type Quad } from "../platform/image.ts";
import { ipairs, len, seq } from "../platform/lt.ts";

interface ShakePhase { wait: number; length: number; crackAt: number; amp: number; frame: number; shards?: number; secondAt?: number }
interface Shard { frame: number; vx: number; vy: number; gravity: number; ax: number; ay: number }
interface Sheet { image: Image; quads: Record<number, Quad> }

export interface EggHatchModule {
  open: boolean;
  _mon: any;
  _species: number | null | undefined;
  _slot: unknown;
  _session: any;
  _onDone: ((result: string) => void) | null | undefined;
  _savedSong: any;
  _state: string;
  _timer: number;
  _bgmTimer: number;
  _shake: number;
  _eggFrame: number;
  _eggShown: boolean;
  _flashAlpha: number;
  _fade: number;
  _headless: boolean;
  _name?: string;
  _shards?: (Shard | null)[];
  _shardVelocityId?: number;
  _monAnim?: MonSprite | null;
  _eggOffset?: number;
  _sheets: Record<string, Sheet | false>;
  SHAKE_PHASES: (ShakePhase | null)[];
  SHARD_VELOCITIES: (number[] | null)[];
  _finish: () => void;
  reloadAssets(): void;
  isOpen(): boolean;
  displayName(mon: any): string;
  start(mon: any, opts?: any): boolean;
  update(dt?: number): void;
  handleInput(input: any): void;
  draw(): void;
}

const STACK_ID = "egg_hatch";

// pokefirered/src/daycare.c:2008 PlaySE(SE_BALL)
const SHAKE_PHASES: (ShakePhase | null)[] = seq<ShakePhase>(
  { wait: 0, length: 20, crackAt: 15, amp: 1, frame: 1, shards: 1 },
  { wait: 30, length: 20, crackAt: 15, amp: 2, frame: 2 },
  { wait: 30, length: 38, crackAt: 15, amp: 2, frame: 2, secondAt: 30, shards: 2 },
);

// pokefirered/src/daycare.c:329 sEggShardVelocities
const SHARD_VELOCITIES = seq(
  seq(-1.5, -3.75), seq(-5, -3), seq(3.5, -3), seq(-4, -3.75),
  seq(2, -1.5), seq(-0.5, -6.75), seq(5, -2.25), seq(-1.5, -3.75),
  seq(4.5, -1.5), seq(-1, -6.75), seq(4, -2.25), seq(-3.5, -3.75),
  seq(1, -1.5), seq(-3.515625, -6.75), seq(4.5, -2.25), seq(-0.5, -7.5),
  seq(1, -4.5), seq(-2.5, -2.25), seq(2.5, -7.5),
) as (number[] | null)[];

// pokefirered/src/daycare.c:1891 CreateSprite(&sSpriteTemplate_EggHatch, 120, 75, 5)
const EGG_X = 120, EGG_Y = 75;
// pokefirered/src/daycare.c:1734 CreateSprite(&gMultiuseSpriteTemplate, 120, 70, 6)
const MON_X = 120, MON_Y = 70;
// pokefirered/src/daycare.c:2136 CreateEggShardSprite(120, 60, ...)
const SHARD_X = 120, SHARD_Y = 60;

// pokefirered/src/daycare.c:137 sEggPalette
const ART_SUB = "pokemon/egg";
const HATCH_W = 32, HATCH_H = 32, HATCH_FRAMES = 4;
const SHARD_W = 8, SHARD_H = 8, SHARD_FRAMES = 4;

// Lua: egg_hatch.lua:64
function cache_root(): string {
  return Extract.CACHE_ROOT || "data/generated/gba";
}

// Lua: egg_hatch.lua:69
function read_bytes(path: string): string | null {
  const info = Fs.getInfo(path);
  if (info) {
    const data = Fs.read(path);
    if (data && data.length > 0) return data;
  }
  // NOT FAITHFUL: no io.open fallback on the 3DS (the cache is read through love.filesystem only).
  return null;
}

// Lua: egg_hatch.lua:86
function rgba_to_image(rgba: string | null, w: number, h: number): Image | null {
  if (!rgba || rgba.length < w * h * 4) return null;
  let data;
  try { data = newImageData(w, h, "rgba8", rgba); } catch { return null; }
  let img: Image;
  try { img = G.newImage(data); } catch { return null; }
  if (img.setFilter) img.setFilter("nearest", "nearest");
  return img;
}

// Lua: egg_hatch.lua:99
function sheet(key: string, rel: string, w: number, h: number, frames: number, across: boolean): Sheet | null {
  if (EggHatch._sheets[key] == null) {
    const bytes = read_bytes(cache_root() + "/" + ART_SUB + "/" + rel);
    const sw = across ? (w * frames) : w;
    const sh = across ? h : (h * frames);
    const img = bytes ? rgba_to_image(bytes, sw, sh) : null;
    if (img) {
      const quads: Record<number, Quad> = {};
      for (let i = 0; i <= frames - 1; i++) {
        const [iw, ih] = img.getDimensions();
        quads[i] = G.newQuad(across ? i * w : 0, across ? 0 : i * h, w, h, iw, ih);
      }
      EggHatch._sheets[key] = { image: img, quads };
    } else {
      EggHatch._sheets[key] = false;
    }
  }
  return EggHatch._sheets[key] || null;
}

// Lua: egg_hatch.lua:123
function se(id: number): void {
  try { if (Audio.playSe) Audio.playSe(id); } catch { /* pcall */ }
}

// Lua: egg_hatch.lua:127
function song(id: unknown, opts?: any): void {
  try { if (Audio.playSong) Audio.playSong(id, opts); } catch { /* pcall */ }
}

// Lua: egg_hatch.lua:142
function finish_scene(): void {
  EggHatch.open = false;
  Stack.pop(STACK_ID);
  const cb = EggHatch._onDone;
  EggHatch._onDone = null;
  EggHatch._mon = null;
  if (Message.close) Message.close();
  // pokefirered/src/daycare.c:1781 gSpecialVar_0x8005 = GetCurrentMapMusic
  const saved = EggHatch._savedSong ?? Audio._mapSong;
  if (saved != null) song(saved);
  if (cb) cb("hatched");
}

// pokefirered/src/daycare.c:1705
// Lua: egg_hatch.lua:157
function hatched_pic(): { image: Image } | null {
  const mon = EggHatch._mon;
  return Pokemon.frontPic(Pokemon.picSpecies(EggHatch._species, mon && mon.personality), null,
    Pokemon.isShiny(mon), mon && mon.personality);
}

// pokefirered/src/daycare.c:1864 Task_EggHatchPlayBGM
// Lua: egg_hatch.lua:201
function bgm_tick(): void {
  const t = EggHatch._bgmTimer;
  if (t === 0) {
    song(0);
  } else if (t === 1) {
    song(Song.MUS_EVOLUTION_INTRO, { loop: false });
  } else if (t === 61) {
    song(Song.MUS_EVOLUTION, { restart: true, loop: true });
  }
  if (t <= 61) EggHatch._bgmTimer = t + 1;
}

// pokefirered/src/daycare.c:2128 CreateRandomEggShardSprite
// Lua: egg_hatch.lua:214
function spawn_shard(): void {
  const id = (EggHatch._shardVelocityId || 0) % len(SHARD_VELOCITIES);
  const v = SHARD_VELOCITIES[id + 1]!;
  EggHatch._shardVelocityId = (EggHatch._shardVelocityId || 0) + 1;
  EggHatch._shards![len(EggHatch._shards) + 1] = {
    // pokefirered/src/daycare.c:2141 CreateSprite(&sSpriteTemplate_EggShard, x, y, 4)
    frame: Rng.Random() % SHARD_FRAMES,
    vx: v[1]! * 256, vy: v[2]! * 256, gravity: 100, ax: 0, ay: 0,
  };
}

// pokefirered/src/daycare.c:2114 SpriteCB_EggShard
// Lua: egg_hatch.lua:227
function shards_tick(): void {
  const live: (Shard | null)[] = [null];
  for (const [, s] of ipairs<Shard>(EggHatch._shards)) {
    s.ax = s.ax + s.vx;
    s.ay = s.ay + s.vy;
    s.vy = s.vy + s.gravity;
    if (!(s.ay / 256 > 20 && s.vy > 0)) live[len(live) + 1] = s;
  }
  EggHatch._shards = live;
}

// pokefirered/src/daycare.c:1995 SpriteCB_Egg_0 through SpriteCB_Egg_4
// Lua: egg_hatch.lua:239
function shake_tick(): void {
  const phase = SHAKE_PHASES[EggHatch._shake + 1];
  if (!phase) {
    // pokefirered/src/daycare.c:2069 SpriteCB_Egg_3
    EggHatch._timer = EggHatch._timer + 1;
    if (EggHatch._timer === 51) {
      // pokefirered/src/daycare.c:2078 SpriteCB_Egg_4
      EggHatch._eggShown = false;
      EggHatch._flashAlpha = 1;
      // pokefirered/src/daycare.c:2085 four shards a frame for the first four
      for (let k = 1; k <= 16; k++) spawn_shard();
    } else if (EggHatch._timer > 51) {
      EggHatch._flashAlpha = Math.max(0, 1 - (EggHatch._timer - 51) / 16);
      if (EggHatch._timer >= 67) {
        // pokefirered/src/daycare.c:2091 PlaySE(SE_EGG_HATCH)
        se(SE.SE_EGG_HATCH ?? 106);
        EggHatch._state = "cry";
        EggHatch._timer = 0;
        if (MonAnim.enabled()) {
          // pokeemerald/src/egg_hatch.c:643
          const sp = tonumber(EggHatch._species) ?? 0;
          EggHatch._monAnim = MonAnim.run(MonAnim.newSprite(sp, { data: { 2: sp } }), { tasksFirst: true });
          MonAnim.doFront(EggHatch._monAnim, sp, false, 1, {
            cry: (s, pan) => { try { (Audio as any).playCry(s, 0, pan); } catch { /* pcall */ } } });
        } else {
          try { Audio.playCry(EggHatch._species); } catch { /* pcall */ }
        }
      }
    }
    return;
  }
  EggHatch._timer = EggHatch._timer + 1;
  if (EggHatch._timer <= phase.wait) return;
  const t = EggHatch._timer - phase.wait;
  if (t > phase.length) {
    EggHatch._shake = EggHatch._shake + 1;
    EggHatch._timer = 0;
    return;
  }
  EggHatch._eggOffset = Math.sin(t * 20 * Math.PI / 128) * phase.amp;
  if (t === phase.crackAt) {
    se(SE.SE_BALL ?? 23);
    // pokefirered/src/daycare.c:2009 StartSpriteAnim(sprite, 1)
    EggHatch._eggFrame = phase.frame;
    for (let k = 1; k <= (phase.shards || 0); k++) spawn_shard();
  } else if (phase.secondAt != null && t === phase.secondAt) {
    se(SE.SE_BALL ?? 23);
  }
}

// Lua: egg_hatch.lua:290
function ask_nickname(): void {
  // pokefirered/src/daycare.c:1952 CreateYesNoMenu
  Choice.yesNo((yes) => {
    if (Message.isOpen && Message.isOpen() && Message.close) Message.close();
    if (!yes) {
      EggHatch._state = "fade_out";
      EggHatch._timer = 0;
      return;
    }
    // pokefirered/src/daycare.c:1964 DoNamingScreen NAMING_SCREEN_NICKNAME
    const mon = EggHatch._mon;
    const N: any = Naming;
    EggHatch._state = "naming";
    N.open({
      title: N.monTitle(EggHatch._name),
      maxLen: 10,
      seed: EggHatch._name,
      template: N.TEMPLATE.NICKNAME,
      species: EggHatch._species,
      gender: mon && mon.gender,
      personality: mon && mon.personality,
      session: EggHatch._session,
      onDone: (name: unknown) => {
        // pokefirered/src/daycare.c:1855 EggHatchSetMonNickname
        if (mon && typeof name === "string" && name !== "") {
          mon.nickname = name;
          mon.name = name;
        }
        EggHatch._state = "fade_out";
        EggHatch._timer = 0;
      },
    });
  }, { left: 21, top: 9 } as any);
}

export const EggHatch: EggHatchModule = {
  open: false,
  _mon: null,
  _species: null,
  _slot: null,
  _session: null,
  _onDone: null,
  _savedSong: null,
  _state: "fade_in",
  _timer: 0,
  _bgmTimer: 0,
  _shake: 0,
  _eggFrame: 0,
  _eggShown: true,
  _flashAlpha: 0,
  _fade: 1,
  _headless: false,
  SHAKE_PHASES,
  SHARD_VELOCITIES,
  _sheets: {},
  _finish: finish_scene,

  // Lua: egg_hatch.lua:119
  reloadAssets(): void {
    EggHatch._sheets = {};
  },

  // Lua: egg_hatch.lua:131
  isOpen(): boolean {
    return EggHatch.open === true;
  },

  // pokefirered/src/daycare.c:354 DayCare_GetMonNickname
  // Lua: egg_hatch.lua:136
  displayName(mon: any): string {
    const name = Pokemon.displayMonName && Pokemon.displayMonName(mon);
    if (typeof name === "string" && name !== "") return name;
    return tostring((Pokemon.name && Pokemon.name(Pokemon.speciesOf(mon))) || "POK\xC3\xA9MON");
  },

  // Lua: egg_hatch.lua:163
  start(mon: any, opts?: any): boolean {
    opts = opts || {};
    if (!mon) {
      if (opts.onDone) opts.onDone("error");
      return false;
    }
    EggHatch._mon = mon;
    EggHatch._slot = opts.slot;
    EggHatch._session = opts.session;
    EggHatch._onDone = opts.onDone;
    EggHatch._savedSong = opts.savedSong ?? Audio._mapSong;
    EggHatch._headless = opts.headless ? true : false;
    // pokefirered/src/daycare.c:1824 AddHatchedMonToParty
    Breeding.hatchMon(opts.session, mon);
    EggHatch._species = Pokemon.speciesOf(mon);
    EggHatch._name = EggHatch.displayName(mon);
    EggHatch._state = "fade_in";
    EggHatch._timer = 0;
    EggHatch._bgmTimer = 0;
    EggHatch._shake = 0;
    EggHatch._eggFrame = 0;
    EggHatch._eggShown = true;
    EggHatch._flashAlpha = 0;
    EggHatch._fade = 1;
    EggHatch._shards = [null];
    EggHatch._shardVelocityId = 0;
    EggHatch._monAnim = null;
    EggHatch.open = true;
    if (Oam && Oam.destroyAll) Oam.destroyAll();
    if (!(BattleChrome as any)._installed) BattleChrome.install(null);
    if (Message.setFrame) Message.setFrame("battle");
    try { hatched_pic(); } catch { /* pcall */ }
    try { Pokemon.frontPic(Pokemon.SPECIES_EGG); } catch { /* pcall */ }
    Stack.push(STACK_ID, EggHatch, { hideBelow: true, fullscreen: true });
    return true;
  },

  // Lua: egg_hatch.lua:326
  update(_dt?: number): void {
    if (!EggHatch.open) return;
    if (Message.isOpen && Message.isOpen()) Message.tick();
    // pokefirered/src/daycare.c:1990 AnimateSprites
    if (EggHatch._shards && len(EggHatch._shards) > 0) shards_tick();

    const st = EggHatch._state;
    if (st === "fade_in") {
      EggHatch._timer = EggHatch._timer + 1;
      EggHatch._fade = Math.max(0, 1 - EggHatch._timer / 16);
      bgm_tick();
      if (EggHatch._timer >= 16) {
        EggHatch._state = "wait";
        EggHatch._timer = 0;
      }
    } else if (st === "wait") {
      bgm_tick();
      // pokefirered/src/daycare.c:1906 ++CB2_PalCounter > 30
      EggHatch._timer = EggHatch._timer + 1;
      if (EggHatch._timer > 30) {
        EggHatch._state = "shake";
        EggHatch._timer = 0;
      }
    } else if (st === "shake") {
      bgm_tick();
      shake_tick();
    } else if (st === "cry") {
      bgm_tick();
      EggHatch._timer = EggHatch._timer + 1;
      // pokefirered/src/daycare.c:1920 IsCryFinished
      let done = Audio.isCryFinished && Audio.isCryFinished();
      if (EggHatch._monAnim) { done = MonAnim.done(EggHatch._monAnim); EggHatch._timer = 0; }
      if (EggHatch._timer >= 40 || done) {
        EggHatch._state = "hatched_msg";
        EggHatch._timer = 0;
        // pokefirered/src/daycare.c:1927 gText_HatchedFromEgg
        Message.show(RomText.box("gText_HatchedFromEgg", { stringVars: seq(EggHatch._name) }), { stay: true, frame: "battle" });
        if (Message.skipReveal) Message.skipReveal();
        // pokefirered/src/daycare.c:1929 PlayFanfare(MUS_EVOLVED)
        try { Audio.playFanfare(Song.MUS_EVOLVED); } catch { /* pcall */ }
      }
    } else if (st === "hatched_msg") {
      EggHatch._timer = EggHatch._timer + 1;
      // pokefirered/src/daycare.c:1935 IsFanfareTaskInactive
      const quiet = (!Audio.isFanfareFinished) || Audio.isFanfareFinished();
      if (quiet && EggHatch._timer > 1) {
        // pokefirered/src/daycare.c:1944 gText_NickHatchPrompt, pokeemerald/src/egg_hatch.c:673
        const key = Profile.family(EggHatch._session) === "rse"
          ? "gText_NicknameHatchPrompt" : "gText_NickHatchPrompt";
        const text = RomText.box(key, { stringVars: seq(EggHatch._name) });
        EggHatch._state = "nickname_msg";
        EggHatch._timer = 0;
        Message.show(text, { stay: true, frame: "battle" });
      }
    } else if (st === "nickname_msg") {
      // pokefirered/src/daycare.c:1949 IsTextPrinterActive
      if (!(Message.isTyping && Message.isTyping())) {
        EggHatch._state = "nickname_ask";
        ask_nickname();
      }
    } else if (st === "fade_out") {
      EggHatch._timer = EggHatch._timer + 1;
      EggHatch._fade = Math.min(1, EggHatch._timer / 16);
      // pokefirered/src/daycare.c:1972 BeginNormalPaletteFade
      if (EggHatch._timer >= 16) finish_scene();
    }
  },

  // Lua: egg_hatch.lua:401
  handleInput(input: any): void {
    if (!(EggHatch.open && input)) return;
    if (Choice && Choice.active) {
      if (input.wasPressed("up")) Choice.move(-1);
      else if (input.wasPressed("down")) Choice.move(1);
      else if (input.wasPressed("a")) Choice.confirm();
      else if (input.wasPressed("b")) Choice.cancel();
    }
  },

  // Lua: egg_hatch.lua:413
  draw(): void {
    if (!EggHatch.open) return;
    // pokefirered/src/daycare.c:1839 gTradeOrHatchMonShadowTilemap
    G.setColor(0.13, 0.16, 0.29, 1);
    G.rectangle("fill", 0, 0, Display.W, Display.H);
    G.setColor(0.07, 0.09, 0.18, 1);
    G.ellipse("fill", MON_X, MON_Y + 36, 40, 9);

    G.setColor(1, 1, 1, 1);
    if (EggHatch._eggShown) {
      // pokefirered/src/daycare.c:138 sEggHatchTiles
      const eggs = sheet("hatch", "hatch.rgba", HATCH_W, HATCH_H, HATCH_FRAMES, false);
      const x = EGG_X + (EggHatch._eggOffset || 0);
      if (eggs) {
        const quad = eggs.quads[EggHatch._eggFrame || 0] || eggs.quads[0];
        G.draw(eggs.image, quad, x, EGG_Y, 0, 1, 1, HATCH_W / 2, HATCH_H / 2);
      } else {
        const eggPic = Pokemon.frontPic(Pokemon.SPECIES_EGG);
        if (eggPic && eggPic.image) {
          G.draw(eggPic.image, x, EGG_Y, 0, 1, 1, 32, 32);
        }
      }
    } else {
      const pic = hatched_pic();
      const ma = EggHatch._monAnim;
      if (ma && pic && pic.image) {
        const mon = EggHatch._mon;
        const f = MonAnim.framePic(Pokemon.picSpecies(EggHatch._species, mon && mon.personality), (ma as any).frame,
          Pokemon.isShiny(mon)) || pic;
        MonAnim.draw(ma, f.image, MON_X, MON_Y);
      } else if (pic && pic.image) {
        G.draw(pic.image, MON_X, MON_Y, 0, 1, 1, 32, 32);
      }
    }

    // pokefirered/src/daycare.c:139 sEggShardTiles
    const shards = EggHatch._shards;
    if (shards && len(shards) > 0) {
      const art = sheet("shard", "shard.rgba", SHARD_W, SHARD_H, SHARD_FRAMES, true);
      if (art) {
        for (const [, s] of ipairs<Shard>(shards)) {
          const quad = art.quads[s.frame] || art.quads[0];
          G.draw(art.image, quad, SHARD_X + s.ax / 256, SHARD_Y + s.ay / 256,
            0, 1, 1, SHARD_W / 2, SHARD_H / 2);
        }
      }
    }

    if (EggHatch._flashAlpha > 0) {
      G.setColor(1, 1, 1, EggHatch._flashAlpha);
      G.rectangle("fill", 0, 0, Display.W, Display.H);
    }

    // pokefirered/src/daycare.c:1811
    BattleChrome.drawPanel("none");
    if (Message.isOpen && Message.isOpen()) Message.draw();
    if (Choice && Choice.active && Choice.draw) Choice.draw();

    if (EggHatch._fade > 0) {
      G.setColor(0, 0, 0, EggHatch._fade);
      G.rectangle("fill", 0, 0, Display.W, Display.H);
    }
    G.setColor(1, 1, 1, 1);
  },
};

export default EggHatch;
