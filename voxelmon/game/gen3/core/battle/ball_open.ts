// Port of gen1recomp src/core/game3/battle/ball_open.lua (GPLv3 + additional terms; see LICENSE.md).
// Poke Ball open particles + the mon / bg colour fade (pret pokeball.c,
// battle_anim_special.c).
//
// Port notes:
// - Particle `data` tables ({ [0] = 0, 0, ... }) are JS arrays indexed 0..7;
//   ANIMS / ANIM_NUMS / SPAWNERS keep their Lua keys ([0] and sequences).
//   Frame commands are seqs; `jump` is a property on the anim seq.
// - The ball-open shader is the `blend5_pre` effect; `send("target", ...)`
//   sends a plain [r, g, b] array (the effect's vec reader takes arrays as
//   0-based).
// - monBlend's multiple returns are a tuple: [0] or [coeff, r, g, b].
// - pcall(require, dataset / CacheFs / extract_island1): all are linked in;
//   a CacheFs stub reads as the failed require.
// - The load-time BallOpen.reset() is inlined without its
//   AnimCoords.idTable() call (no calls into the import cycle at load); _mon
//   is made on first use (mon_table) or by the next reset.
// - startParticles' ballItem is optional (new_game_scene passes nil).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tonumber, truthy } from "../../../../import/gen3/lua.ts";
import { seq, len, ipairs, pairs, type LuaTable } from "../../platform/lt.ts";
import { luaLoad } from "../../platform/luadata.ts";
import { G, type Shader } from "../../platform/graphics.ts";
import { newImageData, type Image, type Quad } from "../../platform/image.ts";
import { NotPortedError } from "../../notported.ts";
import Dataset from "../dataset.ts";
import CacheFs from "../../shared/import/CacheFs.ts";
import Extract from "../../../../import/gen3/extract_island1.ts";
import AnimCoords from "./anim_coords.ts";

type Fn = (...a: any[]) => any;

export interface BallOpenModule {
  CACHE_SUB: string;
  _data: any;
  _image: Image | false | null | undefined;
  _quads: Record<number, Quad>;
  _shader: Shader | false | null | undefined;
  _sprites: LuaTable;
  _particles: LuaTable;
  _tasks: LuaTable;
  _mon: any;
  _fade: any;
  reset(): void;
  ballIdForItem(item: any): number;
  setData(data: any, image: any): void;
  data(): any;
  sin(index: number, amp: number): number;
  cos(index: number, amp: number): number;
  blend5(c: number, target: number, coeff: number): number;
  beginFade(startY: number, targetY: number, opts?: any): boolean;
  animate(p: any): void;
  start(side: any, x: any, y: any, ballItem: any, unfadeLater?: any): number;
  startParticles(x: any, y: any, ballItem?: any): void;
  addSprite(s: any): any;
  spawnSprite(x: number, y: number, animNum: number, cb: Fn): any;
  tick(): void;
  active(): boolean;
  particleCount(): number;
  particles(): LuaTable;
  bgCoeff(): number;
  fadeActive(): boolean;
  monBlend(side: any): [number, number?, number?, number?];
  setBlendShader(coeff: any, r?: number, g?: number, b?: number): boolean;
  draw(): void;
}

export const BallOpen = {} as BallOpenModule;

BallOpen.CACHE_SUB = "pokemon/battle/ball_open";

// pokefirered/src/battle_anim_special.c:702
const ITEM_TO_BALL: Record<number, number> = {
  [1]: 4, [2]: 3, [3]: 1, [4]: 0, [5]: 2, [6]: 5,
  [7]: 6, [8]: 7, [9]: 8, [10]: 9, [11]: 10, [12]: 11,
};

/** A frame-command sequence with an optional `jump`. */
function cmds(jump: number | undefined, ...cs: LuaTable[]): LuaTable {
  const t: any = seq(...cs);
  if (jump !== undefined) t.jump = jump;
  return t;
}

// pokefirered/src/battle_anim_special.c:149
const ANIMS: Record<number, LuaTable> = {
  [0]: cmds(1, seq(0, 1), seq(1, 1), seq(2, 1), seq<any>(0, 1, true), seq(2, 1), seq(1, 1)),
  [1]: cmds(undefined, seq(3, 1)),
  [2]: cmds(undefined, seq(4, 1)),
  [3]: cmds(undefined, seq(5, 1)),
  [4]: cmds(1, seq(6, 4), seq(7, 4)),
  [5]: cmds(undefined, seq(7, 4)),
};

// pokefirered/src/battle_anim_special.c:201
const ANIM_NUMS: number[] = [0, 0, 0, 5, 1, 2, 2, 3, 5, 5, 4, 4];

BallOpen._data = undefined;
BallOpen._image = undefined;
BallOpen._quads = {};
BallOpen._shader = undefined;

// Lua: ball_open.lua:31
function new_fade(): any {
  return {
    active: false, y: 0, target: 0, yDec: false, toggle: 0,
    finishing: false, counter: 0, selected: false, bgY: 0,
    objSel: undefined, color: undefined, delay: 0, delayCounter: 0,
  };
}

// Lua: ball_open.lua:37
BallOpen.reset = function (): void {
  BallOpen._sprites = [null];
  BallOpen._particles = [null];
  BallOpen._tasks = [null];
  BallOpen._mon = AnimCoords.idTable();
  BallOpen._fade = new_fade();
};

// Lua: ball_open.lua:45 BallOpen.reset() at load: the same fields, except
// that _mon (AnimCoords.idTable()) is made on first use (mon_table), since a
// module must not call into the import cycle while loading.
BallOpen._sprites = [null];
BallOpen._particles = [null];
BallOpen._tasks = [null];
BallOpen._mon = undefined;
BallOpen._fade = new_fade();

/** BallOpen._mon, made by the load-time reset in Lua. */
function mon_table(): any {
  if (BallOpen._mon == null) BallOpen._mon = AnimCoords.idTable();
  return BallOpen._mon;
}

// Lua: ball_open.lua:47
BallOpen.ballIdForItem = function (item: any): number {
  return ITEM_TO_BALL[tonumber(item) ?? 0] ?? 0;
};

// Lua: ball_open.lua:51
function read_cache(rel: string): string | undefined {
  if (truthy(Dataset) && truthy(Dataset.cache)) {
    const c = Dataset.cache();
    const d = truthy(c) && truthy(c.read) ? c.read(rel) : undefined;
    if (typeof d === "string" && d.length > 0) return d;
  }
  if (truthy(CacheFs) && truthy(CacheFs.readActive)) {
    let d: string | undefined;
    try { d = CacheFs.readActive(rel); } catch (e) { if (!(e instanceof NotPortedError)) throw e; d = undefined; }
    if (typeof d === "string" && d.length > 0) return d;
  }
  return undefined;
}

// Lua: ball_open.lua:66
function cache_root(): string {
  return (truthy(Extract) && truthy(Extract.CACHE_ROOT) ? Extract.CACHE_ROOT : "data/generated/gba") + "/" + BallOpen.CACHE_SUB;
}

// Lua: ball_open.lua:71
BallOpen.setData = function (data: any, image: any): void {
  BallOpen._data = data;
  BallOpen._image = image;
  BallOpen._quads = {};
};

// Lua: ball_open.lua:77
BallOpen.data = function (): any {
  if (BallOpen._data == null) {
    BallOpen._data = false;
    const src = read_cache(cache_root() + "/manifest.lua");
    const chunk = truthy(src) ? luaLoad(src!, "=ball_open")[0] : undefined;
    let ok = false, t: any;
    if (truthy(chunk)) {
      try { t = (chunk as () => any)(); ok = true; } catch { ok = false; }
    }
    if (ok && t !== null && typeof t === "object") BallOpen._data = t;
  }
  return truthy(BallOpen._data) ? BallOpen._data : undefined;
};

// Lua: ball_open.lua:89
function image(): Image | undefined {
  if (BallOpen._image == null) {
    BallOpen._image = false;
    const d = BallOpen.data();
    if (truthy(d)) {
      const rgba = read_cache(cache_root() + "/" + (d.sheet ?? "particles.rgba"));
      const w = d.sheetW ?? 64, h = d.sheetH ?? 8;
      if (truthy(rgba) && rgba!.length >= w * h * 4) {
        let id;
        try { id = newImageData(w, h, "rgba8", rgba); } catch { id = undefined; }
        if (id) {
          let img: Image | undefined;
          try { img = G.newImage(id); } catch { img = undefined; }
          if (img) {
            img.setFilter("nearest", "nearest");
            BallOpen._image = img;
          }
        }
      }
    }
  }
  return truthy(BallOpen._image) ? BallOpen._image as Image : undefined;
}

// pokefirered/src/trig.c:514
// Lua: ball_open.lua:112
function sin(index: number, amp: number): number {
  const d = BallOpen.data();
  const v = (truthy(d) && truthy(d.sine) ? d.sine[index + 1] : undefined) ?? 0;
  return Math.floor(amp * v / 256);
}

// pokefirered/src/trig.c:520
// Lua: ball_open.lua:119
function cos(index: number, amp: number): number {
  return sin(index + 64, amp);
}

BallOpen.sin = sin;
BallOpen.cos = cos;

// pokefirered/src/blend_palette.c:16
// Lua: ball_open.lua:127
BallOpen.blend5 = function (c: number, target: number, coeff: number): number {
  return c + Math.floor((target - c) * coeff / 16);
};

// pokefirered/src/palette.c:393
// Lua: ball_open.lua:132
function update_fade(): void {
  const f = BallOpen._fade;
  if (!f.active) return;
  if (f.finishing) {
    if (f.counter === 4) {
      f.active = false;
      f.finishing = false;
      f.counter = 0;
    } else {
      f.counter = f.counter + 1;
    }
    return;
  }
  if (f.toggle === 0) {
    if (f.delayCounter < f.delay) {
      f.delayCounter = f.delayCounter + 1;
      return;
    }
    f.delayCounter = 0;
    if (f.selected) f.bgY = f.y;
  } else if (truthy(f.objSel)) {
    f.objSel.coeff = f.y;
    f.objSel.r = f.color[1]; f.objSel.g = f.color[2]; f.objSel.b = f.color[3];
  }
  f.toggle = 1 - f.toggle;
  if (f.toggle === 0) {
    if (f.y === f.target) {
      f.selected = false;
      f.objSel = undefined;
      f.finishing = true;
    } else if (!f.yDec) {
      f.y = Math.min(f.target, f.y + 2);
    } else {
      f.y = Math.max(f.target, f.y - 2);
    }
  }
}

// pokefirered/src/palette.c:151
// Lua: ball_open.lua:171
function begin_fade(startY: number, targetY: number, opts?: any): boolean {
  const f = BallOpen._fade;
  if (f.active) return false;
  opts = opts ?? {};
  f.y = startY;
  f.target = targetY;
  f.active = true;
  f.selected = opts.obj == null;
  f.objSel = opts.obj;
  f.color = opts.color ?? seq(31, 31, 31);
  f.delay = opts.delay ?? 0;
  f.delayCounter = f.delay;
  f.yDec = !(startY < targetY);
  update_fade();
  return true;
}

BallOpen.beginFade = begin_fade;

// pokefirered/src/sprite.c:905
// Lua: ball_open.lua:191
function animate(p: any): void {
  const cmdsT = (p.anims ?? ANIMS)[p.animNum] ?? ANIMS[0];
  let c: any;
  if (p.animBeginning) {
    p.animBeginning = false;
    p.animEnded = false;
    p.cmd = 1;
    c = cmdsT[1];
  } else if (p.delay > 0) {
    if (!truthy(p.animPaused)) p.delay = p.delay - 1;
    return;
  } else if (truthy(p.animPaused)) {
    return;
  } else {
    const nextI = p.cmd + 1;
    if (truthy(cmdsT[nextI])) {
      p.cmd = nextI;
    } else if (truthy(cmdsT.jump)) {
      p.cmd = cmdsT.jump;
    } else {
      p.animEnded = true;
      return;
    }
    c = cmdsT[p.cmd];
  }
  p.frame = c[1];
  p.hFlip = c[3] === true;
  p.delay = Math.max(0, c[2] - 1);
}

BallOpen.animate = animate;

// Lua: ball_open.lua:223
function spawn(task: any, cb: Fn | undefined, d?: Record<number, number> | null, animNum?: number): any {
  const p: any = {
    x: task.x, y: task.y, x2: 0, y2: 0,
    animNum: animNum ?? ANIM_NUMS[task.ballId] ?? 0, animBeginning: true,
    frame: 0, hFlip: false, delay: 0, cmd: 1,
    cb, data: [0, 0, 0, 0, 0, 0, 0, 0],
  };
  for (const [k, v] of pairs(d ?? {})) p.data[k] = v;
  const list = BallOpen._particles;
  list[len(list) + 1] = p;
  return p;
}

const CB: Record<string, Fn> = {};

// pokefirered/src/battle_anim_special.c:1492
// Lua: ball_open.lua:239
CB.poke1 = function (p: any): void {
  if (p.data[1] === 0) {
    p.cb = CB.poke2;
  } else {
    p.data[1] = p.data[1] - 1;
  }
};

// pokefirered/src/battle_anim_special.c:1500
// Lua: ball_open.lua:248
CB.poke2 = function (p: any): void {
  const d = p.data;
  p.x2 = sin(d[0], d[1]);
  p.y2 = cos(d[0], d[1]);
  d[1] = d[1] + 2;
  if (d[1] === 50) p.dead = true;
};

// pokefirered/src/battle_anim_special.c:1693
// Lua: ball_open.lua:257
CB.fan = function (p: any): void {
  const d = p.data;
  p.x2 = sin(d[0], d[1]);
  p.y2 = cos(d[0], d[2]);
  d[0] = (d[0] + d[4]) % 256;
  d[1] = d[1] + d[5];
  d[2] = d[2] + d[6];
  d[3] = d[3] + 1;
  if (d[3] === 51) p.dead = true;
};

// pokefirered/src/battle_anim_special.c:1735
// Lua: ball_open.lua:269
CB.repeat_ = function (p: any): void {
  const d = p.data;
  p.x2 = sin(d[0], d[1]);
  p.y2 = cos(d[0], sin(d[0], d[2]));
  d[0] = (d[0] + 6) % 256;
  d[1] = d[1] + 1;
  d[2] = d[2] + 1;
  d[3] = d[3] + 1;
  if (d[3] === 51) p.dead = true;
};

// pokefirered/src/battle_anim_special.c:1823
// Lua: ball_open.lua:281
CB.premier = function (p: any): void {
  const d = p.data;
  p.x2 = sin(d[0], d[1]);
  p.y2 = cos(d[0], sin(d[0] % 64, d[2]));
  d[0] = (d[0] + 10) % 256;
  d[1] = d[1] + 1;
  d[2] = d[2] + 1;
  d[3] = d[3] + 1;
  if (d[3] === 51) p.dead = true;
};

// Lua: ball_open.lua:292
function fan_burst(task: any, count: number, step: number, d4: number, d5: number, d6: number): void {
  for (let i = 0; i <= count - 1; i++) {
    spawn(task, CB.fan, { [0]: i * step, [4]: d4, [5]: d5, [6]: d6 });
  }
}

const SPAWN: Record<string, (task: any) => boolean> = {};

// pokefirered/src/battle_anim_special.c:1448
// Lua: ball_open.lua:301
SPAWN.poke = function (task: any): boolean {
  if (task.data0 < 16) {
    let var0 = task.data0;
    if (var0 >= 8) var0 = var0 - 8;
    spawn(task, CB.poke1, { [0]: var0 * 32 });
    if (task.data0 === 15) return true;
  }
  task.data0 = task.data0 + 1;
  return false;
};

// pokefirered/src/battle_anim_special.c:1648
// Lua: ball_open.lua:313
SPAWN.great = function (task: any): boolean {
  if (task.data7 !== 0) {
    task.data7 = task.data7 - 1;
    return false;
  }
  fan_burst(task, 8, 32, 8, 2, 2);
  task.data7 = 8;
  task.data0 = task.data0 + 1;
  return task.data0 === 2;
};

// pokefirered/src/battle_anim_special.c:1578
// Lua: ball_open.lua:325
SPAWN.safari = function (task: any): boolean {
  fan_burst(task, 8, 32, 4, 1, 1);
  return true;
};

// pokefirered/src/battle_anim_special.c:1613
// Lua: ball_open.lua:331
SPAWN.ultra = function (task: any): boolean {
  fan_burst(task, 10, 25, 5, 1, 1);
  return true;
};

// pokefirered/src/battle_anim_special.c:1746
// Lua: ball_open.lua:337
SPAWN.master = function (task: any): boolean {
  fan_burst(task, 8, 32, 8, 2, 1);
  fan_burst(task, 8, 32, 8, 1, 2);
  return true;
};

// pokefirered/src/battle_anim_special.c:1543
// Lua: ball_open.lua:344
SPAWN.dive = function (task: any): boolean {
  fan_burst(task, 8, 32, 10, 1, 2);
  return true;
};

// pokefirered/src/battle_anim_special.c:1704
// Lua: ball_open.lua:350
SPAWN.repeat_ = function (task: any): boolean {
  for (let i = 0; i <= 11; i++) {
    spawn(task, CB.repeat_, { [0]: i * 21 });
  }
  return true;
};

// pokefirered/src/battle_anim_special.c:1509
// Lua: ball_open.lua:358
SPAWN.timer = function (task: any): boolean {
  fan_burst(task, 8, 32, 10, 2, 1);
  return true;
};

// pokefirered/src/battle_anim_special.c:1792
// Lua: ball_open.lua:364
SPAWN.premier = function (task: any): boolean {
  for (let i = 0; i <= 7; i++) {
    spawn(task, CB.premier, { [0]: i * 32 });
  }
  return true;
};

// pokefirered/src/battle_anim_special.c:217
const SPAWNERS: ((task: any) => boolean)[] = [
  SPAWN.poke!, SPAWN.great!, SPAWN.safari!, SPAWN.ultra!, SPAWN.master!, SPAWN.safari!,
  SPAWN.dive!, SPAWN.ultra!, SPAWN.repeat_!, SPAWN.timer!, SPAWN.great!, SPAWN.premier!,
];

// pokefirered/src/battle_anim_special.c:1910
// Lua: ball_open.lua:378
function run_mon_fade(m: any): boolean {
  if (m.state === "wait") {
    if (!BallOpen._fade.active) {
      begin_fade(16, 0);
      m.state = "step";
    }
    return false;
  }
  if (m.d2 <= 16) {
    m.coeff = m.d0;
    m.d0 = m.d0 + m.d1;
    m.d2 = m.d2 + 1;
    return false;
  }
  if (m.state === "to") {
    // pokefirered/src/battle_anim_special.c:1902
    if (BallOpen._fade.active) return false;
    begin_fade(16, 0);
    m.hold = true;
  }
  return true;
}

// pokefirered/src/pokeball.c:763
// Lua: ball_open.lua:402
BallOpen.start = function (side: any, x: any, y: any, ballItem: any, unfadeLater?: any): number {
  side = AnimCoords.fixedId(side) ?? side;
  const ballId = BallOpen.ballIdForItem(ballItem);
  // pokefirered/src/battle_anim_special.c:1427
  const tasks = BallOpen._tasks;
  tasks[len(tasks) + 1] = {
    kind: "particles", ballId,
    x: lmod256(Math.floor(tonumber(x) ?? 0)),
    y: lmod256(Math.floor(tonumber(y) ?? 0) - 5),
    data0: 0, data7: 0,
  };
  // pokefirered/src/battle_anim_special.c:1865
  let m: any;
  if (unfadeLater === false) {
    m = { kind: "mon", side, ballId, coeff: 0, d0: 0, d1: 1, d2: 0, state: "to" };
  } else {
    m = { kind: "mon", side, ballId, coeff: 16, d0: 16, d1: -1, d2: 0, state: "wait" };
  }
  mon_table()[side] = m;
  tasks[len(tasks) + 1] = m;
  begin_fade(0, 16);
  return ballId;
};

/** Lua `n % 256` (floored). */
function lmod256(n: number): number {
  return ((n % 256) + 256) % 256;
}

// pokefirered/src/pokeball.c:1006
// Lua: ball_open.lua:427
BallOpen.startParticles = function (x: any, y: any, ballItem?: any): void {
  const tasks = BallOpen._tasks;
  tasks[len(tasks) + 1] = {
    kind: "particles", ballId: BallOpen.ballIdForItem(ballItem),
    x: lmod256(Math.floor(tonumber(x) ?? 0)),
    y: lmod256(Math.floor(tonumber(y) ?? 0) - 5),
    data0: 0, data7: 0,
  };
};

// Lua: ball_open.lua:437
BallOpen.addSprite = function (s: any): any {
  const list = BallOpen._sprites;
  list[len(list) + 1] = s;
  return s;
};

// Lua: ball_open.lua:443
BallOpen.spawnSprite = function (x: number, y: number, animNum: number, cb: Fn): any {
  return spawn({ x, y, ballId: 0 }, cb, undefined, animNum);
};

// pokefirered/src/battle_main.c:1447
// Lua: ball_open.lua:448
BallOpen.tick = function (): void {
  const sprites = BallOpen._sprites;
  if (len(sprites) > 0) {
    const keepS: LuaTable = [null];
    for (const [, s] of ipairs<any>(sprites)) {
      s.update(s);
      if (!truthy(s.dead)) keepS[len(keepS) + 1] = s;
    }
    BallOpen._sprites = keepS;
  }
  const list = BallOpen._particles;
  if (len(list) > 0) {
    const keep: LuaTable = [null];
    for (const [, p] of ipairs<any>(list)) {
      p.cb(p);
      if (!truthy(p.dead)) {
        animate(p);
        keep[len(keep) + 1] = p;
      }
    }
    BallOpen._particles = keep;
  }
  update_fade();
  const tasks = BallOpen._tasks;
  if (len(tasks) > 0) {
    const keep: LuaTable = [null];
    for (const [, t] of ipairs<any>(tasks)) {
      let done: boolean;
      if (t.kind === "particles") {
        done = SPAWNERS[t.ballId]!(t);
      } else {
        done = run_mon_fade(t);
        if (done && !truthy(t.hold) && mon_table()[t.side] === t) mon_table()[t.side] = undefined;
      }
      if (!done) keep[len(keep) + 1] = t;
    }
    const added = BallOpen._tasks;
    for (let i = len(tasks) + 1; i <= len(added); i++) keep[len(keep) + 1] = added[i];
    BallOpen._tasks = keep;
  }
};

// Lua: ball_open.lua:490
BallOpen.active = function (): boolean {
  return len(BallOpen._sprites) > 0 || len(BallOpen._particles) > 0 || len(BallOpen._tasks) > 0 || BallOpen._fade.active;
};

// Lua: ball_open.lua:494
BallOpen.particleCount = function (): number {
  return len(BallOpen._particles);
};

// Lua: ball_open.lua:498
BallOpen.particles = function (): LuaTable {
  return BallOpen._particles;
};

// Lua: ball_open.lua:502
BallOpen.bgCoeff = function (): number {
  return BallOpen._fade.bgY ?? 0;
};

// Lua: ball_open.lua:506
BallOpen.fadeActive = function (): boolean {
  return BallOpen._fade.active;
};

// Lua: ball_open.lua:510
BallOpen.monBlend = function (side: any): [number, number?, number?, number?] {
  const m = mon_table()[AnimCoords.fixedId(side) ?? side];
  if (!truthy(m) || m.coeff <= 0) return [0];
  const d = BallOpen.data();
  const c = truthy(d) && truthy(d.fadeColors) ? d.fadeColors[m.ballId + 1] : undefined;
  if (!truthy(c)) return [0];
  return [m.coeff, c[1], c[2], c[3]];
};

// Lua: ball_open.lua:519 (SHADER_SRC): the blend5_pre effect.
const SHADER_SRC = "blend5_pre";

// Lua: ball_open.lua:530
BallOpen.setBlendShader = function (coeff: any, r?: number, g?: number, b?: number): boolean {
  if (!(truthy(coeff) && coeff > 0)) {
    return false;
  }
  if (BallOpen._shader == null) {
    let sh: Shader | false;
    try { sh = G.newShader(SHADER_SRC); } catch { sh = false; }
    BallOpen._shader = sh;
  }
  const sh = BallOpen._shader;
  if (!sh) return false;
  sh.send("coeff", coeff);
  sh.send("target", [r, g, b]);
  G.setShader(sh);
  return true;
};

// Lua: ball_open.lua:546
BallOpen.draw = function (): void {
  const list = BallOpen._particles;
  if (len(list) === 0) return;
  const img = image();
  if (!img) return;
  G.setColor(1, 1, 1, 1);
  for (let i = len(list); i >= 1; i--) {
    const p = list[i];
    if (!p.animBeginning && !truthy(p.invisible)) {
      let q = BallOpen._quads[p.frame];
      if (!q) {
        const [iw, ih] = img.getDimensions();
        q = G.newQuad(p.frame * 8, 0, 8, 8, iw, ih);
        BallOpen._quads[p.frame] = q;
      }
      const px = p.x + p.x2 - 4, py = p.y + p.y2 - 4;
      if (p.hFlip) {
        G.draw(img, q, px + 8, py, 0, -1, 1);
      } else {
        G.draw(img, q, px, py);
      }
    }
  }
};

export default BallOpen;
