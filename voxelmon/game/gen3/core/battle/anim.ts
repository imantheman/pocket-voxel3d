// Port of gen1recomp src/core/game3/battle/anim.lua (GPLv3 + additional terms; see LICENSE.md).
// Battle animation host: present state, HP tween, busy gate, VM launch facade.
// Engine stays pure; this layer owns display offsets and pacing.

import { tonumber, tostring } from "../../../../import/gen3/lua.ts";
import { G, type Shader } from "../../platform/graphics.ts";
import { Fs } from "../../platform/fs.ts";
import { newImageData, type Image, type ImageData } from "../../platform/image.ts";
import { luaLoad } from "../../platform/luadata.ts";
import { ipairs, len, pairs, remove, type LuaTable } from "../../platform/lt.ts";
import { G3Lazy } from "../lazy_registry.ts";
import { Task } from "../task.ts";
import { SE } from "../se_ids.ts";
import { Audio } from "../audio.ts";
import { Dataset } from "../dataset.ts";
import { Display } from "../display.ts";
import { AnimVm } from "./anim_vm.ts";
import { AnimSprites } from "./anim_sprites.ts";
import { BallOpen } from "./ball_open.ts";
import { AnimPal } from "./anim_pal.ts";
import { AnimCoords } from "./anim_coords.ts";
import { BattleProfile } from "./profile.ts";
import { Pokedude } from "./pokedude.ts";
import { Experience } from "./experience.ts";
import { Moves } from "./moves.ts";
import { Battle } from "./init.ts";

// A sequence ({a, b}); local so module-scope tables never call an import.
const lseq = (...xs: any[]): any[] => [null, ...xs];


// Lua: anim.lua:12
function fallback_prefix(): string | null {
  return BattleProfile.get().animCacheFallback ?? null;
}

const SCREEN_EFFECT = "screen_fx"; // Lua: anim.lua:44 (SCREEN_SHADER_SRC)

// Lua: anim.lua:120
function default_present(id: number): Record<string, any> {
  const side = AnimCoords.sideOf(id);
  const z = (side === "player") ? Anim.Z.PLAYER : Anim.Z.ENEMY;
  return {
    id,
    side,
    ox: 0,
    oy: 0,
    alpha: 1,
    visible: true,
    z,
    hFlip: false,
    darken: 0,
    scale: 1,
    sx: 1,
    sy: 1,
    rotation: 0,
    displayHp: null,
    displayMaxHp: null,
    displayExp: null,
    displayLevel: null,
    flash: 0,
  };
}

// Lua: anim.lua:145
function default_stage(headless: boolean): Record<string, any> {
  return {
    slide: headless ? 1 : 0,
    slideDone: !!headless,
    trainer: {
      player: { visible: false, ox: 0, oy: 0, frame: 0, gender: 0 },
      enemy: { visible: false, ox: 0, oy: 0, picId: null },
    },
    ball: { visible: false, x: 0, y: 0, frame: 0, side: null },
    balls: {},
    healthbox: AnimCoords.idTable({
      0: { visible: !!headless, ox: 0 },
      1: { visible: !!headless, ox: 0 },
      2: { visible: !!headless, ox: 0 },
      3: { visible: !!headless, ox: 0 },
    }),
    partyBar: {
      player: { visible: false, ox: 0, balls: {} },
      enemy: { visible: false, ox: 0, balls: {} },
    },
    bgSlide: {
      enemyOx: 0,
      playerOx: 0,
    },
  };
}

// Lua: anim.lua:301
function play_se(name: string, pan: number): void {
  try {
    Audio.playSe((SE as any)[name], { pan });
  } catch { /* pcall */ }
}

// Lua: anim.lua:636 -- GBA indexed sheets store transparent as palette index 0
// (often magenta #6229FF). Love2D expands that to opaque pixels — punch them to alpha 0.
function punch_gba_transparent(imageData: ImageData): ImageData {
  if (!imageData || !imageData.mapPixel) return imageData;
  // Exact pret key color and near-matches (98/255, 41/255, 1)
  const kr = 98 / 255, kg = 41 / 255, kb = 1;
  const px = (imageData as { px?: Uint8Array }).px;
  if (px) {
    // NOT FAITHFUL (performance, same pixels): mapPixel's test below, run
    // over the bytes in place (no closure call and arrays per pixel); a
    // pixel it keeps is left as it is, which is what mapPixel writes back
    for (let o = 0; o < px.length; o += 4) {
      const r = px[o]! / 255, g = px[o + 1]! / 255, b = px[o + 2]! / 255, a = px[o + 3]! / 255;
      if (a < 0.01
        || (Math.abs(r - kr) < 0.004 && Math.abs(g - kg) < 0.004 && Math.abs(b - kb) < 0.004)
        || (b > 0.95 && r > 0.30 && r < 0.50 && g < 0.25)) {
        px[o] = 0; px[o + 1] = 0; px[o + 2] = 0; px[o + 3] = 0;
      }
    }
    imageData.version++;
    return imageData;
  }
  imageData.mapPixel((_x, _y, r, g, b, a) => {
    if (a < 0.01) return [0, 0, 0, 0];
    // Exact key
    if (Math.abs(r - kr) < 0.004 && Math.abs(g - kg) < 0.004 && Math.abs(b - kb) < 0.004) {
      return [0, 0, 0, 0];
    }
    // Generic bright magenta/blue key used across pret sheets (high B, mid R, low G)
    if (b > 0.95 && r > 0.30 && r < 0.50 && g < 0.25) {
      return [0, 0, 0, 0];
    }
    return [r, g, b, a];
  });
  return imageData;
}

function dataset_cache(): any {
  try { return Dataset.cache(); } catch { return null; }
}

// Lua: anim.lua:655
function hydrate_tag_images(pack: LuaTable): void {
  if (!pack || !pack.tags) return;
  // (`love.image and love.graphics` always exist here.)
  const cache = dataset_cache();
  const root = "data/generated/gba/pokemon/battle_anims/";
  for (const [tag, info] of pairs<any>(pack.tags)) {
    if (info != null && typeof info === "object" && !info.image && info.file) {
      // NOT FAITHFUL (performance and memory): each tag's sheet is
      // hydrated the first time anything reads it (lazy_tag), not all ~580
      // at once -- that was over a minute of decoding at the first move on
      // a New 3DS, and every sheet's texture in linear memory
      lazy_tag(info, () => hydrate_tag(cache, root, tag, info));
    }
  }
}

/** The fields hydrate_tag sets on a tag's info. */
const LAZY_TAG_KEYS = ["image", "w", "h", "idxImage", "idxData"];

/**
 * Stand-ins for hydrate_tag's fields on `info`: the first read or write of
 * any of them takes them off and hydrates the tag, so every reader sees
 * what an eager hydration would have left.
 */
function lazy_tag(info: any, hydrate: () => void): void {
  let done = false;
  const run = (): void => {
    if (done) return;
    done = true;
    for (const k of LAZY_TAG_KEYS) delete info[k];
    hydrate();
  };
  for (const k of LAZY_TAG_KEYS) {
    Object.defineProperty(info, k, {
      configurable: true,
      enumerable: false,
      get(): unknown { run(); return info[k]; },
      set(v: unknown): void { run(); info[k] = v; },
    });
  }
}

// One tag of Lua anim.lua:655's loop.
function hydrate_tag(cache: any, root: string, tag: unknown, info: any): void {
  {
    {
      let bytes: string | undefined;
      const rel = root + info.file;
      if (cache && cache.read) {
        bytes = cache.read(rel);
        const fp = fallback_prefix();
        if (!bytes && fp != null) bytes = cache.read(fp + rel);
      }
      if (typeof bytes === "string" && bytes.length > 0) {
        let fileData;
        try { fileData = Fs.newFileData(bytes, info.file); } catch { fileData = null; }
        if (fileData) {
          let imageData: ImageData | null;
          try { imageData = newImageData(fileData); } catch { imageData = null; }
          if (imageData) {
            punch_gba_transparent(imageData);
            let image: Image | null;
            try { image = G.newImage(imageData); } catch { image = null; }
            if (image) {
              image.setFilter("nearest", "nearest");
              info.image = image;
              info.w = image.getWidth();
              info.h = image.getHeight();
              AnimPal.hydrateIndex(info, tag, image, (f: string) => {
                if (!(cache && cache.read)) return undefined;
                const fp = fallback_prefix();
                return cache.read(root + f) ?? (fp != null ? cache.read(fp + root + f) : undefined);
              });
            }
          }
        }
      }
    }
  }
}

// Lua: anim.lua:693
function load_pack(): LuaTable {
  if (Anim._packLoaded) return Anim._pack;
  Anim._packLoaded = true;
  let chunk: LuaTable = null;
  const cache = dataset_cache();
  const rels = lseq("data/generated/gba/pokemon/battle_anims/pack.lua");
  const fp = fallback_prefix();
  if (fp != null) {
    rels[2] = fp + "data/generated/gba/pokemon/battle_anims/pack.lua";
  }
  if (cache && cache.read) {
    for (const [, rel] of ipairs<string>(rels)) {
      const src = cache.read(rel);
      if (typeof src === "string" && src.length > 0) {
        const [fn, err] = luaLoad(src, "@" + rel);
        if (fn) {
          let result: unknown;
          let ok2 = true;
          try { result = fn(); } catch { ok2 = false; }
          if (ok2 && result != null && typeof result === "object") {
            chunk = result;
            break;
          }
        } else {
          console.log("[battle.anim] pack load error: " + tostring(err));
        }
      }
    }
  }
  if (!chunk && fp == null && cache && cache.read) {
    throw new Error("battle anims: data/generated/gba/pokemon/battle_anims/pack.lua is missing from the cache");
  }
  if (!chunk) {
    // pcall(require, "src.core.game3.battle.anim_pack_fallback")
    const mod = G3Lazy["src.core.game3.battle.anim_pack_fallback"];
    if (mod) chunk = mod;
  }
  if (chunk) {
    hydrate_tag_images(chunk);
  }
  Anim._pack = chunk;
  if (Anim._vm && chunk) Anim._vm.setPack(chunk);
  return chunk;
}

const GENERIC_HIT = lseq(
  { op: "loadspritegfx", tag: "IMPACT" },
  { op: "monbg", battler: "target" },
  { op: "createsprite", template: "gHorizontalLungeSpriteTemplate", animBattler: "attacker", subpriority: 2, args: lseq(4, 4) },
  { op: "delay", frames: 6 },
  { op: "createsprite", template: "gBasicHitSplatSpriteTemplate", animBattler: "attacker", subpriority: 2, tag: "IMPACT", args: lseq(0, 0, "target", 2) },
  { op: "createvisualtask", task: "AnimTask_ShakeMon", priority: 2, args: lseq("target", 3, 0, 6, 1) },
  { op: "waitforvisualfinish" },
  { op: "clearmonbg", battler: "target" },
  { op: "end" },
);

const GENERIC_STATUS = lseq(
  { op: "createvisualtask", task: "AnimTask_ShakeMon", priority: 2, args: lseq("attacker", 1, 0, 8, 1) },
  { op: "waitforvisualfinish" },
  { op: "end" },
);

const GENERIC_MISS = lseq(
  { op: "delay", frames: 8 },
  { op: "end" },
);

// Lua: anim.lua:766
function shiny_sprite(template: string, callback: string, w: number, h: number, imageValue: number, role: string): Record<string, any> {
  return {
    op: "createsprite", template, tag: "GOLD_STARS",
    animBattler: role ?? "attacker", subpriority: 5, callback, w, h,
    // The portable VM copies args[3] to the sprite's image value. FireRed uses
    // tile offsets +4 and +5 for the two mini-star frames.
    args: lseq(0, 0, imageValue ?? 0),
  };
}

// Lua: anim.lua:776
function shiny_script(ids: LuaTable): LuaTable {
  const streams: LuaTable = [null];
  for (const [i, id] of ipairs<number>(ids)) {
    const role = (i === 1) ? "attacker" : "target";
    const side = AnimCoords.sideOf(id);
    streams[len(streams) + 1] = { role, callback: "ShinySparkleOrbit", pan: side === "player"
      ? "SOUND_PAN_ATTACKER" : "SOUND_PAN_TARGET" };
    streams[len(streams) + 1] = { role, callback: "ShinySparkle", pan: side === "player"
      ? "SOUND_PAN_ATTACKER" : "SOUND_PAN_TARGET" };
  }

  const script: LuaTable = lseq(
    { op: "loadspritegfx", tag: "GOLD_STARS" },
    // pokefirered/src/battle_anim_special.c:2088-2092
    { op: "delay", frames: 60 },
  );

  // Each FireRed task emits one wish star and four mini stars. In a double
  // battle, run both battlers' task pairs through the same VM so their first
  // stars and four-frame bursts stay synchronized.
  for (let burst = 0; burst <= 4; burst++) {
    if (burst > 0) {
      // Each createsprite consumes one VM frame. With two streams per
      // battler, this preserves the four-frame task cadence between bursts.
      script[len(script) + 1] = { op: "delay", frames: 2 };
    }
    const template = (burst === 0) ? "gWishStarSpriteTemplate" : "gMiniTwinklingStarSpriteTemplate";
    const size = (burst === 0) ? 16 : 8;
    const imageValue = (burst === 0) ? 0 : ((burst <= 3) ? 4 : 5);
    for (const [, stream] of ipairs<any>(streams)) {
      script[len(script) + 1] = shiny_sprite(template, stream.callback, size, size, imageValue, stream.role);
    }
    // pokefirered/src/battle_anim_special.c:2120-2137
    for (const [, stream] of ipairs<any>(streams)) {
      if (burst === 0 && stream.callback === "ShinySparkle") {
        script[len(script) + 1] = { op: "playsewithpan", se: SE.SE_SHINY, pan: stream.pan };
      }
    }
  }

  // pokefirered/src/battle_anim_special.c:2150-2164
  script[len(script) + 1] = { op: "waitforvisualfinish" };
  script[len(script) + 1] = { op: "unloadspritegfx", tag: "GOLD_STARS" };
  script[len(script) + 1] = { op: "end" };
  return script;
}

const STATUS_PACK_NAME: Record<string, string> = {
  POISON: "STATUS_PSN", BURN: "STATUS_BRN", SLEEP: "STATUS_SLP", PARALYSIS: "STATUS_PRZ",
  FREEZE: "STATUS_FRZ", CONFUSION: "STATUS_CONFUSION", INFATUATION: "STATUS_INFATUATION",
  CURSED: "STATUS_CURSED", NIGHTMARE: "STATUS_NIGHTMARE",
};

// Lua: anim.lua:910
function launch_table(kind: string, name: unknown, optsIn?: Record<string, any>): boolean {
  const opts = optsIn || {};
  if (!Anim._vm) Anim.reset({ headless: Anim._headless });
  const script = Anim.tableScript(kind, name)[0];
  if (!script) {
    if (opts.onEnd) opts.onEnd();
    return false;
  }
  const o: Record<string, any> = {};
  for (const [k, v] of pairs(opts)) o[k] = v;
  if (o.targetSide == null) o.targetSide = o.attackerSide;
  if (o.targetId == null) o.targetId = o.attackerId;
  if (kind === "status" && o.statusAnim == null) o.statusAnim = true;
  if (Anim._vm.launchScript) return Anim._vm.launchScript(script, o);
  return Anim._vm.launch(script, o);
}

// Lua: anim.lua:1041
function pump_status_queue(): void {
  if (Anim._vm && Anim._vm.busy()) return;
  const next = remove<any>(Anim._statusQueue, 1);
  if (next) {
    Anim.launchStatus(next.statusId, next.opts);
  }
}

let _present: LuaTable = null;

export const Anim: Record<string, any> = {
  // NOT FAITHFUL (ES module order): Brian copies these at require time
  // (`Anim.Z = AnimVm.Z`, `Anim.Coords = AnimCoords`, `Anim._present =
  // AnimCoords.idTable()`); here they are read on first use, so a module cycle
  // through anim.ts cannot see them half-built.
  get Z() { return AnimVm.Z; },
  get Coords() { return AnimCoords; },
  get _present() {
    if (_present == null) _present = AnimCoords.idTable();
    return _present;
  },
  set _present(v: LuaTable) { _present = v; },

  // pret sBattlerCoords (singles) — CreateSprite CENTER
  ENEMY_MON: { x: 176, y: 40 },
  PLAYER_MON: { x: 72, y: 80 },

  _vm: null as AnimVm | null,
  _headless: false,
  _pack: null as LuaTable,
  _packLoaded: false,
  _hpTweening: false,
  _expTweening: false,
  _introTweening: 0,
  _stageTasks: {} as Record<number, boolean>,
  _seqBusy: false,
  _statusQueue: [null] as LuaTable,
  _stage: null as LuaTable,
  _screenEffect: {
    type: "none",
    coeff: 0,
    targetColor: lseq(1, 1, 1),
  } as Record<string, any>,
  _screenShader: null as Shader | false | null,
  _statMaskImgs: {} as Record<number, Image | false>,

  // Lua: anim.lua:67
  setScreenEffect(opts?: Record<string, any> | null): void {
    if (!opts || opts.type === "none" || opts.type === false) {
      Anim._screenEffect = { type: "none", coeff: 0, targetColor: lseq(1, 1, 1) };
      return;
    }
    Anim._screenEffect = {
      type: opts.type ?? "invert",
      coeff: opts.coeff ?? 1,
      targetColor: opts.targetColor ?? lseq(1, 1, 1),
    };
  },

  // Lua: anim.lua:79
  screenEffect(): Record<string, any> {
    return Anim._screenEffect;
  },

  // Lua: anim.lua:83
  beginScreenEffect(): boolean {
    const fx = Anim._screenEffect;
    if (!fx || fx.type === "none") return false;
    // (`love.graphics.newShader` always exists here.)

    if (Anim._screenShader == null) {
      try { Anim._screenShader = G.newShader(SCREEN_EFFECT); } catch { Anim._screenShader = false; }
    }
    const sh = Anim._screenShader;
    if (!sh) return false;

    let typeCode = 0;
    if (fx.type === "invert") typeCode = 1;
    else if (fx.type === "fade_white") typeCode = 2;
    else if (fx.type === "fade_black" || fx.type === "darken") typeCode = 3;
    else if (fx.type === "grayscale") typeCode = 4;
    else if (fx.type === "custom_blend") typeCode = 5;

    if (typeCode === 0) return false;

    try {
      sh.send("effectType", typeCode);
      sh.send("coeff", fx.coeff ?? 1.0);
      sh.send("targetColor", fx.targetColor ?? lseq(1, 1, 1));
      G.setShader(sh);
    } catch { /* pcall */ }
    return true;
  },

  // Lua: anim.lua:114
  endScreenEffect(): void {
    G.setShader();
  },

  // Lua: anim.lua:172
  x(v: unknown): number {
    const vm = Anim._vm;
    if (vm && vm.isReversed) return -(tonumber(v) ?? 0);
    return tonumber(v) ?? 0;
  },

  // Lua: anim.lua:178
  idOf(key: unknown): number | null {
    if (key === "attacker_side") {
      const vm = Anim._vm;
      return vm && vm.attackerId ? vm.attackerId() : 0;
    }
    return AnimCoords.idOf(key);
  },

  // Lua: anim.lua:186
  sideOf(id: unknown): string {
    return AnimCoords.sideOf(id);
  },

  // Lua: anim.lua:190
  isDouble(st?: any): boolean {
    return AnimCoords.isDouble(st);
  },

  // Lua: anim.lua:194
  setDouble(v: unknown): void {
    AnimCoords.setDouble(v);
  },

  // Lua: anim.lua:198
  present(key: unknown): Record<string, any> | null {
    const id = Anim.idOf(key);
    if (id == null) return null;
    let p = Anim._present[id];
    if (!p) {
      if (id >= 2 && !AnimCoords.isDouble()) return null;
      p = default_present(id);
      if (id >= 2 && !Anim._headless) p.visible = false;
      Anim._present[id] = p;
    }
    return p;
  },

  // Lua: anim.lua:212 -- pokefirered/src/battle_anim_mons.c:105
  coords(st: any, key: unknown): any {
    return AnimCoords.coords(st, key);
  },

  // Lua: anim.lua:217 -- pokefirered/src/battle_anim_mons.c:1908
  subpriority(key: unknown): number {
    return AnimCoords.subpriority(key);
  },

  // Lua: anim.lua:222 -- pokefirered/src/battle_anim_mons.c:1934
  bgPriorityRank(key: unknown): number {
    return AnimCoords.bgPriorityRank(key);
  },

  // Lua: anim.lua:226
  monDrawOrder(st?: any): LuaTable {
    return AnimCoords.monDrawOrder(st);
  },

  // Lua: anim.lua:230 -- returns [lo, hi]
  particleBand(k: number, st?: any): [number, number] {
    return AnimCoords.particleBand(k, st);
  },

  // Lua: anim.lua:234
  battlerIds(st?: any): LuaTable {
    return AnimCoords.ids(st);
  },

  // Lua: anim.lua:238 -- returns [cx, cy]
  battlerCenter(key: unknown): [number, number] {
    const base = Anim.coords(null, key) ?? Anim.ENEMY_MON;
    const p = Anim.present(key);
    const cx = base.x + (p ? (p.ox ?? 0) : 0);
    const cy = base.y + (p ? (p.oy ?? 0) : 0);
    return [cx, cy];
  },

  // Lua: anim.lua:246
  reset(optsIn?: Record<string, any>): void {
    const opts = optsIn || {};
    for (const [id] of pairs(Anim._stageTasks)) Task.cancel(id as number);
    Anim._stageTasks = {};
    Anim._headless = !!opts.headless;
    Anim._hpTweening = false;
    Anim._hpTweenTask = null;
    Anim._expTweening = false;
    Anim._expTweenTask = null;
    Anim._introTweening = 0;
    Anim._seqBusy = false;
    Anim._statusQueue = [null];
    AnimCoords.setDouble(opts.double);
    AnimCoords.bind(null);
    for (let id = 0; id <= 3; id++) Anim._present[id] = null;
    for (let id = 0; id <= (AnimCoords.isDouble() ? 3 : 1); id++) {
      const p = default_present(id);
      if (!Anim._headless) p.visible = false;
      Anim._present[id] = p;
    }
    Anim._stage = default_stage(Anim._headless);
    if (!Anim._vm) {
      Anim._vm = AnimVm.new();
    }
    Anim._vm.headless = Anim._headless;
    Anim._vm.reset();
    if (Anim._pack) {
      Anim._vm.setPack(Anim._pack);
    }
    Anim._screenEffect = { type: "none", coeff: 0, targetColor: lseq(1, 1, 1) };
    Anim._bgPalAffine = null;
    Anim._bgBlend = null;
    Anim._g1BgBlend = null;
    Anim._bg3Scroll = null;
    // (love.graphics.setDefaultFilter("nearest", "nearest"): the platform's images are nearest.)
    AnimSprites.reset();
    BallOpen.reset();
  },

  // Lua: anim.lua:288 -- pokefirered/src/pokeball.c:769
  ballOpen(key: unknown, x: number, y: number): any {
    if (Anim._headless) return null;
    const id = Anim.idOf(key) ?? 1;
    const b = AnimCoords.battler(null, id);
    return BallOpen.start(id, x, y, b && b.mon && b.mon.pokeball);
  },

  // Lua: anim.lua:296 -- pokefirered/src/pokeball.c:373
  ballIdOf(key: unknown): any {
    const b = AnimCoords.battler(null, Anim.idOf(key) ?? 1);
    return BallOpen.ballIdForItem(b && b.mon && b.mon.pokeball);
  },

  // Lua: anim.lua:309 -- pokefirered/src/pokeball.c:349
  sendOutMon(key: unknown, optsIn?: Record<string, any>): any {
    const opts = optsIn || {};
    const id = Anim.idOf(key) ?? 1;
    const side = AnimCoords.sideOf(id);
    const p = Anim.present(id);
    const done = opts.onComplete;
    if (Anim._headless || !p) {
      if (p) {
        p.visible = true;
        p.ox = 0; p.oy = 0; p.scale = 1;
      }
      if (done) done();
      return null;
    }
    const base = Anim.coords(null, id) ?? Anim.ENEMY_MON;
    const stage = Anim.stage();
    stage.balls = stage.balls ?? {};
    const ball: Record<string, any> = { visible: true, frame: 0, rot: 0, side, battler: id, x: 0, y: 0,
      ballId: Anim.ballIdOf(id) };
    stage.balls[id] = ball;
    const pan = (side === "player") ? -64 : 63;
    const reveal = (): void => {
      ball.frame = 1;
      ball.rot = 0;
      play_se("SE_BALL_OPEN", pan);
      Anim.ballOpen(id, ball.x, ball.y);
      p.visible = true;
      p.ox = 0;
      p.oy = 16;
      p.scale = 0.16;
      p.darken = 0;
      Anim.tweenStage(12, (u: number) => {
        p.oy = 16 * (1 - u);
        p.scale = 0.16 + 0.84 * u;
        ball.frame = (u < 0.5) ? 1 : 2;
      }, () => {
        p.oy = 0;
        p.scale = 1;
        ball.visible = false;
        if (stage.balls[id] === ball) stage.balls[id] = null;
        if (done) done();
      });
    };
    if (side === "player") {
      // pokefirered/src/pokeball.c:912
      const B: any = Battle; // package.loaded["src.core.game3.battle"]
      const [sx, sy] = Pokedude.sendOutOrigin(B ? B._st : null);
      const tx = base.x, ty = base.y + 24;
      ball.x = sx; ball.y = sy;
      play_se("SE_BALL_THROW", pan);
      Anim.tweenStage(25, (u: number, t: any) => {
        const f = t ? t.frames : (u * 25);
        ball.x = sx + (tx - sx) * u;
        ball.y = sy + (ty - sy) * u + (-30 * 4 * u * (1 - u));
        ball.rot = f * ((25 / 256) * Math.PI * 2);
      }, reveal);
    } else {
      // pokefirered/src/pokeball.c:406
      ball.x = base.x; ball.y = base.y + 24;
      Anim.tweenStage(16, () => { /* nothing */ }, reveal);
    }
    return ball;
  },

  // Lua: anim.lua:373
  setSeqBusy(v: unknown): void {
    Anim._seqBusy = v != null && v !== false;
  },

  // Lua: anim.lua:377
  hpTweening(): boolean {
    return Anim._hpTweening === true;
  },

  // Lua: anim.lua:383 -- True while a clip or HP bar is mid-flight (NOT while the host sequencer merely has steps left).
  busy(): boolean {
    if (Anim._headless) return false;
    if (Anim._hpTweening) return true;
    if (Anim._expTweening) return true;
    if ((Anim._introTweening ?? 0) > 0) return true;
    if (Anim._vm && Anim._vm.busy()) return true;
    return false;
  },

  // Lua: anim.lua:392
  stage(): Record<string, any> {
    if (!Anim._stage) {
      Anim._stage = default_stage(Anim._headless);
    }
    return Anim._stage;
  },

  // Lua: anim.lua:399
  introSlideDone(): boolean {
    const s = Anim.stage();
    return !!s && s.slideDone === true;
  },

  // Lua: anim.lua:407 -- Pret faint presentation: SE_FAINT + sink/slide off, then hide mon + healthbox.
  faintMon(key: unknown, optsIn?: Record<string, any>): void {
    const opts = optsIn || {};
    const id = Anim.idOf(key ?? "enemy") ?? 1;
    const side = AnimCoords.sideOf(id);
    const p = Anim.present(id);
    const stage = Anim.stage();
    const hb = stage && stage.healthbox && stage.healthbox[id];
    AnimSprites.clearHost(id);

    const hide_all = (): void => {
      if (p) {
        p.visible = false;
        p.oy = 0;
      }
      if (hb) hb.visible = false;
    };

    if (Anim._headless || !p) {
      hide_all();
      if (opts.onComplete) opts.onComplete();
      return;
    }

    if (opts.playSe !== false) {
      if (Audio.playSe && SE && SE.SE_FAINT != null) {
        Audio.playSe(SE.SE_FAINT);
      }
    }

    const fromOy = p.oy ?? 0;
    if (side === "enemy") {
      // data[3] ≈ 8 − yOffset/8 → ~8 steps; 2 frames each → 16 frames, +64px.
      const steps = 8;
      const frames = steps * 2;
      Anim.tweenStage(frames, (u: number) => {
        const step = Math.min(steps, Math.floor(u * steps + 1e-9));
        p.oy = fromOy + step * 8;
      }, () => {
        hide_all();
        if (opts.onComplete) opts.onComplete();
      });
    } else {
      // Player back sprite center y=80; +5/frame until below 160.
      let screenH = 160;
      {
        const D: any = Display;
        if (D && D.H != null) screenH = D.H;
      }
      const base = Anim.coords(null, id) ?? Anim.PLAYER_MON;
      const need = Math.max(1, Math.ceil((screenH - (base.y ?? 80) + 32) / 5));
      const frames = Math.max(16, need + 2);
      Anim.tweenStage(frames, (_u: number, t: any) => {
        p.oy = fromOy + 5 * (t.frames ?? 1);
      }, () => {
        hide_all();
        if (opts.onComplete) opts.onComplete();
      });
    }
  },

  // Lua: anim.lua:471 -- Tween helper that raises Anim.busy via _introTweening (in-flight only).
  tweenStage(frames: number, onStep?: (u: number, t?: any) => void, onComplete?: () => void): any {
    if (Anim._headless) {
      if (onStep) onStep(1);
      if (onComplete) onComplete();
      return null;
    }
    Anim._introTweening = (Anim._introTweening ?? 0) + 1;
    const t = Task.tween(frames, onStep, () => {
      delete Anim._stageTasks[t.id];
      Anim._introTweening = Math.max(0, (Anim._introTweening ?? 1) - 1);
      if (onComplete) onComplete();
    });
    Anim._stageTasks[t.id] = true;
    return t;
  },

  // Lua: anim.lua:488
  seqBusy(): boolean {
    return Anim._seqBusy === true;
  },

  // Lua: anim.lua:492
  vm(): AnimVm | null {
    return Anim._vm;
  },

  // Lua: anim.lua:497 -- Sync display HP from logical battler (instant).
  syncDisplayFromState(st: any): void {
    if (!st) return;
    for (const [, id] of ipairs<number>(AnimCoords.ids(st))) {
      const b = AnimCoords.battler(st, id);
      const p = Anim.present(id);
      if (b && b.mon && p) {
        p.displayHp = tonumber(b.mon.hp) ?? 0;
        p.displayMaxHp = tonumber(b.mon.maxHp) ?? 1;
        p.displayLevel = tonumber(b.mon.level) ?? 1;
        const prog: any = Experience.progress(b.mon);
        p.displayExp = prog.progressPercent ?? 0;
      }
    }
  },

  // Lua: anim.lua:514 -- Lerp display HP; onComplete when done. frames ≈ pret healthbar speed.
  tweenHp(side: unknown, fromHpIn: unknown, toHpIn: unknown, maxHpIn: unknown, optsIn?: Record<string, any>): void {
    const opts = optsIn || {};
    const p = Anim.present(side);
    if (!p) {
      if (opts.onComplete) opts.onComplete();
      return;
    }
    const maxHp = Math.max(1, tonumber(maxHpIn) ?? p.displayMaxHp ?? 1);
    let fromHp = tonumber(fromHpIn);
    let toHp = tonumber(toHpIn);
    if (fromHp == null) fromHp = p.displayHp ?? toHp ?? 0;
    if (toHp == null) toHp = fromHp;
    const f0 = fromHp as number, t0 = toHp as number;
    p.displayMaxHp = maxHp;
    if (Anim._headless || opts.instant) {
      p.displayHp = t0;
      if (opts.onComplete) opts.onComplete();
      return;
    }
    const delta = Math.abs(t0 - f0);
    // pret-ish: ~1 HP per frame-ish for small, cap duration
    let frames = Math.max(4, Math.min(40, Math.floor(delta / Math.max(1, maxHp / 48)) + 4));
    if (opts.frames != null) frames = opts.frames;
    Anim._hpTweening = true;
    p.displayHp = f0;
    const t = Task.tween(frames, (u: number) => {
      p.displayHp = f0 + (t0 - f0) * u;
    }, () => {
      delete Anim._stageTasks[t.id];
      p.displayHp = t0;
      if (Anim._hpTweenTask === t.id) {
        Anim._hpTweening = false;
        Anim._hpTweenTask = null;
      }
      if (opts.onComplete) opts.onComplete();
    });
    Anim._hpTweenTask = t.id;
    Anim._stageTasks[t.id] = true;
  },

  // Lua: anim.lua:555 -- Lerp player EXP bar ratio 0..1 within current level band.
  tweenExp(sideIn: unknown, fromRatioIn: unknown, toRatioIn: unknown, optsIn?: Record<string, any>): void {
    const opts = optsIn || {};
    const side = sideIn ?? "player";
    const p = Anim.present(side);
    if (!p) {
      if (opts.onComplete) opts.onComplete();
      return;
    }
    const fromRatio = Math.max(0, Math.min(1, tonumber(fromRatioIn) ?? p.displayExp ?? 0));
    const toRatio = Math.max(0, Math.min(1, tonumber(toRatioIn) ?? fromRatio));
    if (opts.level != null) p.displayLevel = opts.level;
    if (Anim._headless || opts.instant) {
      p.displayExp = toRatio;
      if (opts.onComplete) opts.onComplete();
      return;
    }
    const delta = Math.abs(toRatio - fromRatio);
    let fillFrames = Math.max(1, Math.floor(delta * 64 + 0.5));
    let leadIn = 13; // pokefirered Task_GiveExpWithExpBar 13-frame sound pre-roll
    let totalFrames = leadIn + fillFrames;
    if (opts.frames != null) {
      totalFrames = opts.frames;
      leadIn = Math.min(13, Math.floor(totalFrames * 0.2));
      fillFrames = Math.max(1, totalFrames - leadIn);
    }
    Anim._expTweening = true;
    p.displayExp = fromRatio;
    const task = Task.tween(totalFrames, (_u: number, t: any) => {
      const curFrame = t.frames ?? 0;
      if (curFrame <= leadIn) {
        p.displayExp = fromRatio;
      } else {
        const u = Math.min(1, (curFrame - leadIn) / fillFrames);
        p.displayExp = fromRatio + (toRatio - fromRatio) * u;
      }
    }, () => {
      delete Anim._stageTasks[task.id];
      p.displayExp = toRatio;
      if (Anim._expTweenTask === task.id) {
        Anim._expTweening = false;
        Anim._expTweenTask = null;
      }
      if (opts.onComplete) opts.onComplete();
    });
    Anim._expTweenTask = task.id;
    Anim._stageTasks[task.id] = true;
  },

  // Lua: anim.lua:604 -- returns [ratio, level]
  displayExpRatio(side: unknown, battler?: any): [number, number] {
    const p = Anim.present(side ?? "player");
    if (p && p.displayExp != null) {
      return [Math.max(0, Math.min(1, p.displayExp)), p.displayLevel];
    }
    if (battler && battler.mon) {
      const prog: any = Experience.progress(battler.mon);
      return [prog.progressPercent ?? 0, tonumber(battler.mon.level) ?? 1];
    }
    return [0, 1];
  },

  // Lua: anim.lua:617 -- returns [ratio, hp, maxHp]
  displayHpRatio(side: unknown, battler?: any): [number, number, number] {
    const p = Anim.present(side);
    let hp: any, maxHp: any;
    if (p && p.displayHp != null) {
      hp = p.displayHp;
      maxHp = p.displayMaxHp ?? (battler && battler.mon && battler.mon.maxHp) ?? 1;
    } else if (battler && battler.mon) {
      hp = tonumber(battler.mon.hp) ?? 0;
      maxHp = tonumber(battler.mon.maxHp) ?? 1;
    } else {
      return [0, 0, 1];
    }
    maxHp = Math.max(1, tonumber(maxHp) ?? 1);
    hp = Math.max(0, tonumber(hp) ?? 0);
    return [Math.max(0, Math.min(1, hp / maxHp)), hp, maxHp];
  },

  // Lua: anim.lua:736
  loadPack(pack: LuaTable): void {
    Anim._pack = pack;
    Anim._packLoaded = true;
    AnimPal.setPack(pack);
    if (Anim._vm) Anim._vm.setPack(pack);
  },

  // Lua: anim.lua:824
  launchShiny(key: unknown, optsIn?: Record<string, any>): boolean {
    const opts = optsIn || {};
    if (!Anim._vm) Anim.reset({ headless: Anim._headless });
    load_pack();
    const ids: LuaTable = [null];
    for (const [, candidate] of ipairs<any>(opts.keys ?? lseq(key))) {
      const id = Anim.idOf(candidate) ?? AnimCoords.fixedId(candidate);
      if (id != null && len(ids) < 2) ids[len(ids) + 1] = id;
    }
    if (len(ids) === 0) ids[1] = Anim.idOf(key) ?? AnimCoords.fixedId(key) ?? 0;
    const side = AnimCoords.sideOf(ids[1]);
    const targetSide = AnimCoords.sideOf(ids[2] ?? ids[1]);
    const o: Record<string, any> = {};
    for (const [k, v] of pairs(opts)) o[k] = v;
    o.attackerSide = o.attackerSide ?? side;
    o.targetSide = o.targetSide ?? targetSide;
    o.attackerId = o.attackerId ?? ids[1];
    o.targetId = o.targetId ?? ids[2] ?? ids[1];
    if (o.isReversed == null) o.isReversed = side === "enemy";
    return Anim._vm!.launch(shiny_script(ids), o);
  },

  // Lua: anim.lua:846
  scriptForMove(moveId: unknown): LuaTable {
    const pack = load_pack();
    let numId: any = tonumber(moveId);
    if (numId == null) {
      const M: any = Moves;
      if (M && M.numForName) {
        numId = M.numForName(moveId);
      }
    }
    numId = numId ?? tonumber(moveId) ?? moveId;
    if (pack && pack.moves) {
      const s = pack.moves[numId] ?? pack.moves[tostring(numId)] ?? pack.moves[moveId as any];
      if (s) return s;
    }
    return GENERIC_HIT;
  },

  // Lua: anim.lua:863
  scriptForStatus(statusId: unknown): LuaTable {
    const pack = load_pack();
    if (pack && pack.status && pack.status[statusId as any]) {
      return pack.status[statusId as any];
    }
    return GENERIC_STATUS;
  },

  // Lua: anim.lua:872 -- Launch move anim. opts: { attackerSide, targetSide, attackerSpecies, targetSpecies, isReversed, onEnd, miss }
  launchMove(moveId: unknown, optsIn?: Record<string, any>): boolean {
    const opts = optsIn || {};
    if (!Anim._vm) Anim.reset({ headless: Anim._headless });
    if (opts.miss) {
      return Anim._vm!.launch(GENERIC_MISS, opts);
    }
    const script = Anim.scriptForMove(moveId);
    return Anim._vm!.launch(script, opts);
  },

  // Lua: anim.lua:888
  tableIndex(kind: string, name: unknown): number | null {
    if (typeof name === "number") return name;
    const pack = load_pack();
    const names = pack ? pack[kind + "Names"] : null;
    if (!names) return null;
    let want = tostring(name ?? "");
    if (kind === "status") want = STATUS_PACK_NAME[want] ?? want;
    for (let i = 0; i <= 63; i++) {
      const n = names[i];
      if (n == null && i > 0 && names[i + 1] == null) break;
      if (n === want || n === "B_ANIM_" + want) return i;
    }
    return null;
  },

  // Lua: anim.lua:903 -- returns [script, idx]
  tableScript(kind: string, name: unknown): [LuaTable, number | null] {
    const pack = load_pack();
    const idx = Anim.tableIndex(kind, name);
    const tbl = pack ? pack[kind] : null;
    return [(idx != null && tbl) ? (tbl[idx] ?? null) : null, idx];
  },

  // Lua: anim.lua:928 -- pokefirered/src/battle_gfx_sfx_util.c:208
  launchGeneral(name: unknown, opts?: Record<string, any>): boolean {
    return launch_table("general", name, opts);
  },

  // Lua: anim.lua:933 -- pokefirered/src/battle_gfx_sfx_util.c:266
  launchSpecial(name: unknown, opts?: Record<string, any>): boolean {
    return launch_table("special", name, opts);
  },

  // Lua: anim.lua:938 -- pokefirered/src/battle_gfx_sfx_util.c:171
  launchStatus(statusId: unknown, optsIn?: Record<string, any>): boolean {
    const opts = optsIn || {};
    if (!Anim._vm) Anim.reset({ headless: Anim._headless });
    if (Anim._vm!.busy() && !opts.force) {
      Anim._statusQueue[len(Anim._statusQueue) + 1] = { statusId, opts };
      return false;
    }
    return launch_table("status", statusId, opts);
  },

  // Lua: anim.lua:949 -- pokefirered/src/battle_controller_player.c:1351
  blinkMon(side: unknown, optsIn?: Record<string, any>): void {
    const opts = optsIn || {};
    const p = Anim.present(side);
    if (Anim._headless || !p || p.visible === false) {
      if (opts.onComplete) opts.onComplete();
      return;
    }
    Anim.tweenStage(32, (_u: number, t: any) => {
      const f = (t ? t.frames : 1) - 1;
      p.blinkHidden = (Math.floor(f / 4) % 2) === 0;
    }, () => {
      p.blinkHidden = false;
      if (opts.onComplete) opts.onComplete();
    });
  },

  // Lua: anim.lua:965
  setShown(side: unknown, battler: any): void {
    const p = Anim.present(side);
    if (p) p.shown = battler;
  },

  // Lua: anim.lua:970
  shownBattler(side: unknown, battler: any): any {
    const p = Anim._present[side as any];
    if (p && p.shown) return p.shown;
    return battler;
  },

  // Lua: anim.lua:977 -- pokefirered/src/battle_anim_mons.c:286
  substituteY(key: unknown): number {
    const id = Anim.idOf(key) ?? 1;
    const base = Anim.coords(null, id) ?? Anim.ENEMY_MON;
    if (AnimCoords.sideOf(id) === "player") return base.y + 17;
    return base.y + 16;
  },

  // Lua: anim.lua:985 -- pokefirered/src/battle_gfx_sfx_util.c:762
  substituteImage(key: unknown): Image | null {
    const pack = load_pack();
    const tags = pack && pack.tags;
    const id = Anim.idOf(key) ?? 1;
    const info = tags && tags[(AnimCoords.sideOf(id) === "player") ? "SUBSTITUTE_DOLL_BACK" : "SUBSTITUTE_DOLL_FRONT"];
    return (info && info.image) || null;
  },

  // Lua: anim.lua:993
  setSubstitute(side: unknown, on: unknown): void {
    const p = Anim.present(side);
    if (!p) return;
    p.substitute = on != null && on !== false;
    p.substituteY = p.substitute ? Anim.substituteY(side) : null;
  },

  // Lua: anim.lua:1003 -- pokefirered/src/battle_anim_utility_funcs.c:464
  statMaskImage(tilemap: unknown, pal: unknown): Image | null {
    if (typeof tilemap === "string" && tonumber(tilemap) == null) {
      load_pack();
      const img = AnimPal.bgImages(tilemap)[0];
      return img;
    }
    const key = (tonumber(tilemap) ?? 1) * 16 + (tonumber(pal) ?? 5);
    const hit = Anim._statMaskImgs[key];
    if (hit != null) return hit || null;
    Anim._statMaskImgs[key] = false;
    const pack = load_pack();
    const sm = pack && pack.statMask;
    const rel = sm && sm.files && sm.files[tonumber(tilemap) ?? 1];
    const row = sm && sm.pals && sm.pals[tonumber(pal) ?? 5];
    if (!(rel && row)) return null;
    const cache = dataset_cache();
    const path = "data/generated/gba/pokemon/battle_anims/" + rel;
    const fp = fallback_prefix();
    const bytes = cache && cache.read ? (cache.read(path) ?? (fp != null ? cache.read(fp + path) : undefined)) : undefined;
    if (typeof bytes !== "string" || bytes.length === 0) return null;
    let data: ImageData | null;
    try { data = newImageData(Fs.newFileData(bytes, rel)); } catch { data = null; }
    if (!data) return null;
    data.mapPixel((_x, _y, r, _g, _b, a) => {
      if (a < 0.5) return [0, 0, 0, 0];
      const c = row[Math.floor(r * 255 / 16 + 0.5) + 1] ?? row[1];
      return [c[1] / 255, c[2] / 255, c[3] / 255, 1];
    });
    const img = G.newImage(data);
    img.setFilter("nearest", "nearest");
    img.setWrap("repeat", "repeat");
    Anim._statMaskImgs[key] = img;
    return img;
  },

  // Lua: anim.lua:1049
  update(dt?: number): void {
    if (Anim._headless) return;
    // HP tweens live on shared Task list
    if (Anim._vm) {
      Anim._vm.update(dt);
      if (!Anim._vm.active) {
        for (const [, p] of pairs<any>(Anim._present)) {
          if (p) p.statMask = null;
        }
      }
    }
    BallOpen.tick();
    pump_status_queue();
  },

  // Lua: anim.lua:1064
  drawParticles(minZ?: number | null, maxZ?: number | null): void {
    if (Anim._headless) return;
    if (Anim._vm) Anim._vm.draw(minZ, maxZ);
  },

  // Lua: anim.lua:1071 -- Bracket one frame's z-band drawParticles calls so the VM sorts its
  // sprites once per frame instead of once per band.
  beginParticleFrame(): void {
    const vm = Anim._vm;
    if (vm && vm.beginDrawFrame) vm.beginDrawFrame();
  },

  // Lua: anim.lua:1076
  endParticleFrame(): void {
    const vm = Anim._vm;
    if (vm && vm.endDrawFrame) vm.endDrawFrame();
  },
};

export default Anim;
