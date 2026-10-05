// Port of gen1recomp src/core/game3/battle/anim_vm.lua (GPLv3 + additional terms; see LICENSE.md).
// Pret-shaped battle anim script VM over portable IR (not live ROM pointers).
// Opcodes mirror battle_anim_script.inc; createsprite/createvisualtask use named IDs.

import { tonumber, tostring } from "../../../../import/gen3/lua.ts";
import { G, type Shader } from "../../platform/graphics.ts";
import { Fs } from "../../platform/fs.ts";
import { newImageData, type Image } from "../../platform/image.ts";
import { gsub } from "../../platform/lpattern.ts";
import { ipairs, isEmpty, len, pairs, remove, seq, type LuaTable } from "../../platform/lt.ts";
import { G3Lazy } from "../lazy_registry.ts";
import { Audio } from "../audio.ts";
import { Dataset } from "../dataset.ts";
import { AnimSprites, type AnimSprite } from "./anim_sprites.ts";
import { AnimTasks } from "./anim_tasks.ts";
import { AnimPal } from "./anim_pal.ts";
import { AnimCoords } from "./anim_coords.ts";
import { AnimTemplates } from "./anim_templates.ts";
import { AnimCallbacks } from "./anim_callbacks.ts";
import { Anim } from "./anim.ts";
import { BattleProfile } from "./profile.ts";

const _blendOpts: Record<string, any> = {};

// Lua: anim_vm.lua:14
function fallback_prefix(): string | null {
  return BattleProfile.get().animCacheFallback ?? null;
}

const ARG_COUNT = 8;
const WAIT_CAP = 900;

const SOUND_PAN_ATTACKER = -64;
const SOUND_PAN_TARGET = 63;

// Lua: anim_vm.lua:37
function s16(vIn: unknown): number {
  let v = Math.floor(tonumber(vIn) ?? 0) & 0xFFFF;
  if (v >= 0x8000) v = v - 0x10000;
  return v;
}

// Lua: anim_vm.lua:43
function resolve_pan_token(pan: unknown): number {
  if (pan == null) return 0;
  if (typeof pan === "number") return pan;
  const s = tostring(pan);
  if (s === "SOUND_PAN_TARGET" || s === "TARGET") return SOUND_PAN_TARGET;
  if (s === "SOUND_PAN_ATTACKER" || s === "ATTACKER") return SOUND_PAN_ATTACKER;
  return tonumber(s) ?? 0;
}

// Lua: anim_vm.lua:53 -- pokefirered/src/battle_anim.c:1160
function adjust_panning(vm: AnimVm | null | undefined, panIn: unknown): number {
  let pan = resolve_pan_token(panIn);
  const atk = vm ? vm.attackerSide() : "player";
  const tgt = vm ? vm.targetSide() : "enemy";
  if (vm && vm.statusAnimActive) {
    if (atk !== "player") pan = SOUND_PAN_TARGET; else pan = SOUND_PAN_ATTACKER;
  } else if (atk === "player") {
    if (tgt === "player") {
      if (pan === SOUND_PAN_TARGET) {
        pan = SOUND_PAN_ATTACKER;
      } else if (pan !== SOUND_PAN_ATTACKER) {
        pan = -pan;
      }
    }
  } else if (tgt === "enemy") {
    if (pan === SOUND_PAN_ATTACKER) {
      pan = SOUND_PAN_TARGET;
    }
  } else {
    pan = -pan;
  }
  if (pan > SOUND_PAN_TARGET) pan = SOUND_PAN_TARGET;
  if (pan < SOUND_PAN_ATTACKER) pan = SOUND_PAN_ATTACKER;
  return pan;
}

// Lua: anim_vm.lua:80 -- pokefirered/src/battle_anim.c:1197
function adjust_panning2(vm: AnimVm | null | undefined, panIn: unknown): number {
  let pan = resolve_pan_token(panIn);
  const atk = vm ? vm.attackerSide() : "player";
  if (vm && vm.statusAnimActive) {
    if (atk !== "player") pan = SOUND_PAN_TARGET; else pan = SOUND_PAN_ATTACKER;
  } else if (atk !== "player") {
    pan = -pan;
  }
  return pan;
}

// Lua: anim_vm.lua:92 -- pokefirered/src/battle_anim.c:1214
function keep_pan_in_range(pan: number): number {
  if (pan > SOUND_PAN_TARGET) return SOUND_PAN_TARGET;
  if (pan < SOUND_PAN_ATTACKER) return SOUND_PAN_ATTACKER;
  return pan;
}

// Lua: anim_vm.lua:99 -- pokefirered/src/battle_anim.c:1226
function calc_pan_increment(src: number, tgt: number, inc: number): number {
  inc = Math.abs(inc);
  if (src < tgt) return inc;
  if (src > tgt) return -inc;
  return 0;
}

// Lua: anim_vm.lua:109
function play_se12(se: unknown, pan: unknown): void {
  if (se == null) return;
  if (Audio && Audio.playSe) {
    try { Audio.playSe(se, { pan }); } catch { /* pcall */ }
  }
}

// Lua: anim_vm.lua:116 -- pokefirered/src/sound.c:606
function se12_panpot(pan: number): void {
  if (Audio && Audio.setSePan) {
    try { Audio.setSePan(pan); } catch { /* pcall */ }
  }
}

// Lua: anim_vm.lua:123
function default_pal(): Record<number, number[]> {
  const p: Record<number, number[]> = {};
  p[0] = [0, 0, 0, 0];
  for (let i = 1; i <= 15; i++) {
    const g = i / 15;
    p[i] = [g, g, g, 1];
  }
  p[1] = [1, 1, 1, 1];
  p[2] = [1, 0.9, 0.2, 1];
  p[3] = [1, 0.4, 0.1, 1];
  return p;
}

// Lua: anim_vm.lua:208
function key_to_id(key: unknown, cur: number | null | undefined): number | null {
  if (typeof key === "number") return AnimCoords.idOf(key);
  if (key === "player" || key === "enemy") {
    if (cur != null && AnimCoords.sideOf(cur) === key) return cur;
    return AnimCoords.idOf(key);
  }
  return null;
}

// Lua: anim_vm.lua:289
function live_species(id: number): any {
  const b = AnimCoords.battler(null, id);
  if (b == null || typeof b !== "object") return null;
  if (b.expTransform && b.expTransform.species != null) return b.expTransform.species;
  return b.species ?? (b.mon ? (b.mon.species ?? b.mon.speciesId) : null);
}

let vmTasksRegistered = false;

export class AnimVm {
  [key: string]: any;
  static [key: string]: any;

  static Z = {
    BG: 0,
    BEHIND: 10,
    ENEMY: 20,
    MID: 30,
    PLAYER: 40,
    FRONT: 50,
    HEALTHBOX: 60,
    UI: 70,
  };

  static keepPanInRange = keep_pan_in_range;
  static calcPanIncrement = calc_pan_increment;
  static se12PanpotControl = se12_panpot;
  static _sendBlend: (sh: Shader, coeff: number, r: number, g: number, b: number) => void;
  static spawnTask: (vm: AnimVm, name: string, priority: unknown, args: LuaTable, kind?: string) => any;
  static animateSprite: (s: AnimSprite) => void;
  static _blendShader: Shader | false | null = null;

  // Lua: anim_vm.lua:136
  static new(): AnimVm {
    register_vm_tasks();
    const vm = new AnimVm();
    vm.active = false;
    vm.isReversed = false;
    vm._attackerSide = "player";
    vm._targetSide = "enemy";
    vm._atkId = 0;
    vm._tgtId = 1;
    vm.pc = 1;
    vm.script = null;
    vm.callStack = seq();
    vm.args = [] as number[];
    vm.framesToWait = 0;
    vm.waitingVisual = false;
    vm.headless = false;
    vm.pals = { 0: default_pal() };
    vm.loadedTags = {};
    vm.visualTaskCount = 0;
    vm.ctx = {};
    vm.bg3 = { x: 0, y: 0 };
    vm._drawList = [null];
    vm._onEnd = null;
    vm._pack = null;
    vm._shader = null;
    vm._cbMode = "run";
    vm._phase = "cb1";
    vm._monbg = AnimCoords.idTable();
    vm._bgPrio = { 1: 2, 2: 2 };
    vm._tagBlend = {};
    for (let i = 0; i <= ARG_COUNT - 1; i++) vm.args[i] = 0;
    return vm;
  }

  // Lua: anim_vm.lua:170
  attackerSide(): string {
    return this._attackerSide ?? "player";
  }

  // Lua: anim_vm.lua:174
  targetSide(): string {
    return this._targetSide ?? (this._attackerSide === "player" ? "enemy" : "player");
  }

  // Lua: anim_vm.lua:178
  attackerId(): number {
    const id = this._atkId;
    if (id != null && AnimCoords.sideOf(id) === this.attackerSide()) return id;
    return AnimCoords.fixedId(this.attackerSide()) ?? 0;
  }

  // Lua: anim_vm.lua:184
  targetId(): number {
    const id = this._tgtId;
    if (id != null && AnimCoords.sideOf(id) === this.targetSide()) return id;
    return AnimCoords.fixedId(this.targetSide()) ?? 1;
  }

  // Lua: anim_vm.lua:190
  allyPair(): boolean {
    const a = this.attackerId(), t = this.targetId();
    return a !== t && AnimCoords.sideOf(a) === AnimCoords.sideOf(t);
  }

  // Lua: anim_vm.lua:196 -- pokefirered/src/battle_anim_mons.c:860
  isDouble(): boolean {
    return AnimCoords.isDouble();
  }

  // Lua: anim_vm.lua:201 -- pokefirered/src/battle_anim_mons.c:831
  battlerAtPosition(position: unknown): number | null {
    const id = tonumber(position);
    if (id == null || id < 0 || id > 3) return null;
    if (id >= 2 && !AnimCoords.isDouble()) return null;
    return id;
  }

  // Lua: anim_vm.lua:217
  applyBind(): void {
    if (this.active) AnimCoords.bind(this.attackerId(), this.targetId());
  }

  // Lua: anim_vm.lua:221
  setBattlers(atk: unknown, tgt: unknown): void {
    const a = key_to_id(atk, this._atkId);
    const t = key_to_id(tgt, this._tgtId);
    if (a != null) {
      this._atkId = a;
      this._attackerSide = AnimCoords.sideOf(a);
    } else if (atk != null && atk !== false) {
      this._attackerSide = atk;
    }
    if (t != null) {
      this._tgtId = t;
      this._targetSide = AnimCoords.sideOf(t);
    } else if (tgt != null && tgt !== false) {
      this._targetSide = tgt;
    }
    this.isReversed = (this._attackerSide === "enemy");
    this.applyBind();
  }

  // Lua: anim_vm.lua:241 -- pokefirered/src/battle_anim_mons.c:333
  battlerId(token: unknown): number | null {
    if (token == null) return this.targetId();
    const n = tonumber(token);
    const s = typeof token === "string" ? token.toLowerCase() : null;
    if (n === 0 || s === "attacker" || s === "anim_attacker") return this.attackerId();
    if (n === 1 || s === "target" || s === "anim_target") return this.targetId();
    let id: number;
    if (n === 2 || s === "atk_partner" || s === "anim_atk_partner") {
      id = AnimCoords.partner(this.attackerId());
    } else if (n === 3 || s === "def_partner" || s === "anim_def_partner") {
      id = AnimCoords.partner(this.targetId());
    } else if (s === "player" || s === "enemy") {
      return AnimCoords.idOf(s);
    } else {
      return this.targetId();
    }
    if (AnimCoords.spritePresent(null, id)) return id;
    return null;
  }

  // Lua: anim_vm.lua:261
  resolveBattlerSide(token: unknown): any {
    if (token == null) return this.targetSide();
    if (typeof token === "number") {
      if (token === 0) return this.attackerSide();
      else if (token === 1) return this.targetSide();
      else if (token === 2 || token === 3) return this.battlerId(token);
      else return null;
    }
    const s = tostring(token).toLowerCase();
    if (s === "attacker" || s === "anim_attacker" || s === "0") {
      return this.attackerSide();
    }
    if (s === "target" || s === "anim_target" || s === "1") {
      return this.targetSide();
    }
    if (s === "player" || s === "enemy") return s;
    if (s === "atk_partner" || s === "anim_atk_partner" || s === "def_partner" || s === "anim_def_partner") {
      return this.battlerId(s);
    }
    return this.targetSide();
  }

  // Lua: anim_vm.lua:283
  x(vIn: unknown): number {
    const v = tonumber(vIn) ?? 0;
    if (this.isReversed) return -v;
    return v;
  }

  // Lua: anim_vm.lua:296
  speciesForSide(side: unknown): any {
    if (side == null) return null;
    const id = AnimCoords.idOf(side);
    if (this._speciesBySide && this._speciesBySide[side as any] != null) return this._speciesBySide[side as any];
    if (id != null && id === this.attackerId() && this._attackerSpecies != null) return this._attackerSpecies;
    if (id != null && id === this.targetId() && this._targetSpecies != null) return this._targetSpecies;
    if (id == null) {
      if (side === this.attackerSide()) return this._attackerSpecies;
      if (side === this.targetSide()) return this._targetSpecies;
      return null;
    }
    if (id >= 2) return live_species(id);
    return null;
  }

  // Lua: anim_vm.lua:312 -- pokefirered/src/battle_anim.c:1160
  adjustPanning(pan: unknown): number {
    return adjust_panning(this, pan);
  }

  // Lua: anim_vm.lua:317 -- pokefirered/src/battle_anim.c:1197
  adjustPanning2(pan: unknown): number {
    return adjust_panning2(this, pan);
  }

  // Lua: anim_vm.lua:321
  playSe12(se: unknown, pan: unknown): void {
    play_se12(se, pan);
  }

  // Lua: anim_vm.lua:325 -- returns [cx, cy]
  battlerCenter(side: unknown): [number, number] {
    if (side === "attacker") side = this.attackerId();
    else if (side === "target") side = this.targetId();
    return Anim.battlerCenter(side);
  }

  // Lua: anim_vm.lua:332
  setPack(pack: LuaTable): void {
    this._pack = pack;
    AnimPal.setPack(pack);
  }

  // Lua: anim_vm.lua:337
  idle(): boolean {
    return !this.active;
  }

  // Lua: anim_vm.lua:341
  busy(): boolean {
    return this.active === true;
  }

  // Lua: anim_vm.lua:345
  visualCount(): number {
    let n = 0;
    AnimTasks.init();
    for (let i = 1; i <= AnimTasks.MAX; i++) {
      const t = AnimTasks._pool[i];
      if (t.active && t._g4kind !== "sound" && t._g4kind !== "aux" && !t._uncounted) n = n + 1;
    }
    // pokefirered/src/battle_anim.c:400
    AnimSprites.init();
    for (let i = 1; i <= AnimSprites.MAX; i++) {
      const s = AnimSprites._pool[i];
      if (s.active && s._g4counted) n = n + 1;
    }
    return n;
  }

  // Lua: anim_vm.lua:361
  soundCount(): number {
    let n = 0;
    AnimTasks.init();
    for (let i = 1; i <= AnimTasks.MAX; i++) {
      const t = AnimTasks._pool[i];
      if (t.active && t._g4kind === "sound") n = n + 1;
    }
    return n;
  }

  // Lua: anim_vm.lua:371
  reset(): void {
    if (this._hasCoordinateOverrides) {
      AnimCoords.setCoordinateOverrides(this._previousCoordinateOverrides);
      this._previousCoordinateOverrides = null;
      this._hasCoordinateOverrides = null;
    }
    this.active = false;
    this.pc = 1;
    this.script = null;
    this.callStack = seq();
    this._retScript = null; this._retPc = null;
    this.framesToWait = 0;
    this._cbMode = "run";
    this.waitingVisual = false;
    this.waitingSprites = false;
    this._waitFrames = 0;
    this._endWait = 0;
    this._soundWait = 0;
    this.loadedTags = {};
    AnimPal.reset();
    this._onEnd = null;
    this._attackerSpecies = null;
    this._targetSpecies = null;
    this._speciesBySide = null;
    this._monbg = AnimCoords.idTable();
    this._bgPrio = { 1: 2, 2: 2 };
    AnimCoords.bind(null);
    this._tagBlend = {};
    this.bldAlpha = null;
    this.statusAnimActive = false;
    this.ctx = {};
    this.animArg = 0;
    this.bg3 = { x: 0, y: 0 };
    this._bgFade = null;
    this._bgFadeState = 0;
    this._animBgId = null;
    this._animBgBlend = null;
    this.animCustomPanning = 0;
    this._spriteHooks = null;
    for (let i = 0; i <= 15; i++) this.args[i] = 0;
    AnimSprites.reset();
    AnimTasks.reset();
  }

  // Lua: anim_vm.lua:497
  launch(script: LuaTable, opts?: Record<string, any>): boolean {
    opts = opts || {};
    if (this.headless || opts.headless) {
      if (opts.onEnd) { try { opts.onEnd(); } catch { /* pcall */ } }
      return true;
    }
    if (script == null || typeof script !== "object" || len(script) === 0) {
      if (opts.onEnd) { try { opts.onEnd(); } catch { /* pcall */ } }
      return false;
    }
    return begin(this, script, opts);
  }

  // Lua: anim_vm.lua:510
  launchScript(ops: LuaTable, opts?: Record<string, any>): boolean {
    opts = opts || {};
    if (opts.phase == null) {
      const o: Record<string, any> = {};
      for (const [k, v] of pairs(opts)) o[k] = v;
      o.phase = "task";
      opts = o;
    }
    return this.launch(ops, opts);
  }

  // Lua: anim_vm.lua:521
  launchTable(kind: string, index: unknown, opts?: Record<string, any>): boolean {
    const pack = this._pack;
    const tbl = pack ? pack[kind] : null;
    const ops = tbl ? tbl[index as any] : null;
    opts = opts || {};
    if (kind === "moves" && opts.phase == null) {
      const o: Record<string, any> = {};
      for (const [k, v] of pairs(opts)) o[k] = v;
      o.phase = "cb1";
      opts = o;
    }
    if (kind === "status" && opts.statusAnim == null) {
      const o: Record<string, any> = {};
      for (const [k, v] of pairs(opts)) o[k] = v;
      o.statusAnim = true;
      opts = o;
    }
    return this.launchScript(ops, opts);
  }

  // Lua: anim_vm.lua:541
  ensureShader(): null {
    return null;
  }

  // Lua: anim_vm.lua:545
  uploadPal(_slot: unknown): boolean {
    return false;
  }

  // Lua: anim_vm.lua:587
  setTagBlend(tagIn: unknown, coeff: number | null | undefined, color?: number): void {
    const tag = gsub(tostring(tagIn ?? "").toUpperCase(), "^ANIM_TAG_", "")[0];
    if (coeff == null || coeff <= 0) {
      delete this._tagBlend[tag];
    } else {
      this._tagBlend[tag] = { coeff, color: color ?? 0 };
    }
  }

  // Lua: anim_vm.lua:769 -- Bracket the z-band draws of one frame (battle ui).
  beginDrawFrame(): void {
    this._inDrawFrame = true;
    this._frameSorted = false;
    this._frameTasks = null;
  }

  // Lua: anim_vm.lua:775
  endDrawFrame(): void {
    this._inDrawFrame = false;
    this._frameSorted = false;
    this._frameTasks = null;
  }

  // Lua: anim_vm.lua:781
  draw(minZ?: number | null, maxZ?: number | null): void {
    // (`if not (love and love.graphics)`: the platform always has graphics.)
    if ((minZ ?? 0) <= 0) draw_anim_bg(this);

    if (AnimTasks && AnimTasks.draw) {
      let hasTasks = true;
      if (this._inDrawFrame) {
        if (this._frameTasks == null) this._frameTasks = any_task_draw();
        hasTasks = this._frameTasks;
      }
      if (hasTasks) AnimTasks.draw(minZ, maxZ, this);
    }

    const sorted = this._drawList;
    if (!(this._inDrawFrame && this._frameSorted)) {
      build_sorted_sprites(this, sorted);
      this._frameSorted = !!this._inDrawFrame;
    }
    const nSorted = len(sorted);
    if (nSorted === 0) {
      G.setColor(1, 1, 1, 1);
      return;
    }
    let list = sorted;
    if (minZ != null || maxZ != null) {
      list = this._bandList;
      if (!list) {
        list = [null];
        this._bandList = list;
      }
      for (let i = len(list); i >= 1; i--) list[i] = null;
      let n = 0;
      for (let i = 1; i <= nSorted; i++) {
        const s = sorted[i];
        const z = s._drawZ;
        if ((minZ == null || z >= minZ) && (maxZ == null || z <= maxZ)) {
          n = n + 1;
          list[n] = s;
        }
      }
      if (n === 0) {
        G.setColor(1, 1, 1, 1);
        return;
      }
    }

    _activeBlend = "alpha";
    const bld = this.bldAlpha;
    const nList = len(list);
    for (let i = 1; i <= nList; i++) {
      const s = list[i];
      let a = s.alpha ?? 1;
      let eva: number | null = null, evb: number | null = null;
      if (s.objBlend && bld) {
        eva = Math.max(0, Math.min(16, tonumber(bld.eva ?? bld[1]) ?? 16));
        evb = Math.max(0, Math.min(16, tonumber(bld.evb ?? bld[2]) ?? 0));
      }
      if (eva != null && eva + evb! !== 16 && s.image && AnimPal.indexImage(s.image)[0]) {
        // pokefirered/src/battle_anim.c:630
        set_blend_mode("alpha");
        AnimPal.blackPass = true;
        s._drawAlpha = a * (1 - evb! / 16);
        draw_sprite(this, s, s._drawAlpha);
        AnimPal.blackPass = null;
        set_blend_mode("add");
        s._drawAlpha = a * eva / 16;
        draw_sprite(this, s, s._drawAlpha);
      } else {
        let desiredBlend = s.blendMode ?? "alpha";
        if (eva != null) {
          if (evb! >= 16 && eva < 16) desiredBlend = "add";
          a = a * eva / 16;
        }
        set_blend_mode(desiredBlend);
        s._drawAlpha = a;
        draw_sprite(this, s, a);
      }
    }

    if (_activeBlend !== "alpha") {
      G.setBlendMode("alpha", "alphamultiply");
      _activeBlend = "alpha";
    }
    G.setColor(1, 1, 1, 1);
  }

  // Lua: anim_vm.lua:882 -- returns [image, width]
  static sheetImage(vm: AnimVm, tagIn: unknown, wIn: unknown): [Image | null, number | null] {
    const tag = gsub(tostring(tagIn ?? "").toUpperCase(), "^ANIM_TAG_", "")[0];
    const [img, info] = tag_image(vm, tag);
    if (!img || !info) return [img, info ? info.w : null];
    const iw = img.getWidth();
    const w = tonumber(wIn);
    if (w == null || w <= 0 || w === iw) return [img, iw];
    info._relaid = info._relaid ?? {};
    const cached = info._relaid[w];
    if (cached != null) {
      if (cached) return [cached, w];
      return [img, iw];
    }
    info._relaid[w] = false;
    const bytes = info.file ? read_pack_bytes(info.file) : undefined;
    if (typeof bytes !== "string") return [img, iw];
    let fd;
    try { fd = Fs.newFileData(bytes, info.file); } catch { return [img, iw]; }
    let src;
    try { src = newImageData(fd); } catch { return [img, iw]; }
    if (!src) return [img, iw];
    const sw = src.getWidth(), sh = src.getHeight();
    const srcTilesWide = Math.floor(sw / 8);
    const tiles = srcTilesWide * Math.floor(sh / 8);
    const dstTilesWide = Math.max(1, Math.floor(w / 8));
    const dh = Math.max(8, Math.ceil(tiles / dstTilesWide) * 8);
    const dst = newImageData(dstTilesWide * 8, dh);
    for (let t = 0; t <= tiles - 1; t++) {
      const sx = (t % srcTilesWide) * 8, sy = Math.floor(t / srcTilesWide) * 8;
      const dx = (t % dstTilesWide) * 8, dy = Math.floor(t / dstTilesWide) * 8;
      dst.paste(src, dx, dy, sx, sy, 8, 8);
    }
    let out: Image;
    try { out = G.newImage(dst); } catch { return [img, iw]; }
    out.setFilter("nearest", "nearest");
    info._relaid[w] = out;
    AnimPal.relayIndex(info, tag, out, w);
    return [out, dstTilesWide * 8];
  }

  // Lua: anim_vm.lua:921
  static animBgImage(vm: AnimVm, id: unknown): Image | null {
    const pack = vm._pack;
    const bgs = pack ? pack.animBgs : null;
    const info = bgs ? bgs[id as any] : null;
    if (!info) return null;
    if (info.image != null) return info.image || null;
    info.image = false;
    if (!info.file) return null;
    let cache: any = null;
    try { cache = Dataset.cache(); } catch { cache = null; }
    const rel = "data/generated/gba/pokemon/battle_anims/" + info.file;
    const fp = fallback_prefix();
    const bytes = cache && cache.read ? (cache.read(rel) ?? (fp != null ? cache.read(fp + rel) : undefined)) : undefined;
    if (typeof bytes !== "string" || bytes.length === 0) return null;
    let fd;
    try { fd = Fs.newFileData(bytes, info.file); } catch { return null; }
    let img: Image;
    try { img = G.newImage(fd); } catch { return null; }
    img.setFilter("nearest", "nearest");
    info.image = img;
    return img;
  }

  // Lua: anim_vm.lua:1804
  update(_dt?: number): void {
    if (!this.active) return;
    if (this.headless) {
      finish(this);
      return;
    }
    if (this._phase !== "task") script_step(this);
    if (!this.active) return;
    run_sprites(this);
    tick_bg_fade(this);
    AnimTasks.update(this);
    if (this._phase === "task") script_step(this);
  }

  // Lua: anim_vm.lua:1818
  addSpriteHook(fn: (vm: AnimVm) => unknown): void {
    this._spriteHooks = this._spriteHooks ?? [null];
    this._spriteHooks[len(this._spriteHooks) + 1] = fn;
  }

  // Lua: anim_vm.lua:1823
  tickFrames(n?: number): void {
    for (let i = 1; i <= (n ?? 1); i++) {
      if (!this.active) return;
      this.update(1 / 60);
    }
  }
}

// Lua: anim_vm.lua:415
function finish(self: AnimVm): void {
  self.active = false;
  self.waitingVisual = false;
  self.waitingSprites = false;
  self.framesToWait = 0;
  self._cbMode = "run";
  const cb = self._onEnd;
  self._onEnd = null;
  AnimSprites.reset();
  AnimTasks.reset();
  self._monbg = AnimCoords.idTable();
  AnimCoords.bind(null);
  if (self._hasCoordinateOverrides) {
    AnimCoords.setCoordinateOverrides(self._previousCoordinateOverrides);
    self._previousCoordinateOverrides = null;
    self._hasCoordinateOverrides = null;
  }
  if (cb) { try { cb(); } catch { /* pcall */ } }
}

// Lua: anim_vm.lua:435 -- args are pret's 0-based gBattleAnimArgs
function normalize_args(src: LuaTable): number[] {
  const out: number[] = [];
  for (let i = 0; i <= ARG_COUNT - 1; i++) out[i] = 0;
  if (src == null || typeof src !== "object") return out;
  if (src[0] != null) {
    for (let i = 0; i <= ARG_COUNT - 1; i++) out[i] = s16(src[i] ?? 0);
  } else {
    for (let i = 1; i <= ARG_COUNT; i++) out[i - 1] = s16(src[i] ?? 0);
  }
  return out;
}

// Lua: anim_vm.lua:447
function begin(self: AnimVm, script: LuaTable, opts: Record<string, any>): boolean {
  self.reset();
  self.active = true;
  self.script = script;
  self.pc = 1;
  self.isReversed = !!opts.isReversed;
  let atk = opts.attackerSide, tgt = opts.targetSide;
  const atkId = tonumber(opts.attackerId) ?? AnimCoords.fixedId(atk);
  const tgtId = tonumber(opts.targetId) ?? AnimCoords.fixedId(tgt);
  if (typeof atk !== "string") atk = atkId != null ? AnimCoords.sideOf(atkId) : null;
  if (typeof tgt !== "string") tgt = tgtId != null ? AnimCoords.sideOf(tgtId) : null;
  self._attackerSide = atk ?? (self.isReversed ? "enemy" : "player");
  self._targetSide = tgt ?? (self.isReversed ? "player" : "enemy");
  if (atk != null && opts.isReversed == null) {
    self.isReversed = (self._attackerSide === "enemy");
  }
  self._atkId = atkId ?? AnimCoords.fixedId(self._attackerSide);
  self._tgtId = tgtId ?? AnimCoords.fixedId(self._targetSide);
  AnimCoords.bind(self._atkId, self._tgtId);
  self._attackerSpecies = opts.attackerSpecies;
  self._targetSpecies = opts.targetSpecies;
  self._speciesBySide = AnimCoords.idTable();
  if (opts.speciesById) {
    for (const [k, v] of pairs(opts.speciesById)) self._speciesBySide[k] = v;
  }
  if (opts.speciesBySide) {
    for (const [k, v] of pairs(opts.speciesBySide)) self._speciesBySide[k] = v;
  }
  if (opts.attackerSpecies != null && self._speciesBySide[self._atkId] == null) {
    self._speciesBySide[self._atkId] = opts.attackerSpecies;
  }
  if (opts.targetSpecies != null && self._speciesBySide[self._tgtId] == null) {
    self._speciesBySide[self._tgtId] = opts.targetSpecies;
  }
  self._onEnd = opts.onEnd;
  if (opts.coordinateOverrides) {
    self._previousCoordinateOverrides = AnimCoords.setCoordinateOverrides(opts.coordinateOverrides);
    self._hasCoordinateOverrides = true;
  }
  self._turn = tonumber(opts.moveTurn ?? opts.turn) ?? 0;
  self.statusAnimActive = !!opts.statusAnim;
  self._phase = opts.phase ?? "cb1";
  const a = normalize_args(opts.args);
  for (let i = 0; i <= ARG_COUNT - 1; i++) self.args[i] = a[i];
  self.ctx = opts.ctx ?? {};
  self.animArg = tonumber(opts.animArg ?? self.ctx.animArg) ?? 0;
  if (self.ctx.animArg == null) self.ctx.animArg = self.animArg;
  return true;
}

// Lua: anim_vm.lua:549
function sprite_source_quad(s: AnimSprite, bw: number, bh: number): any {
  const qx = s.quadX ?? 0;
  const qy = s.quadY ?? 0;
  if (s.quad && s._quadX === qx && s._quadY === qy && s._quadW === bw && s._quadH === bh) {
    return s.quad;
  }
  if (!(s.image && s.image.getDimensions)) return null;
  const [iw, ih] = s.image.getDimensions();
  if (iw === bw && ih === bh && qx === 0 && qy === 0) {
    s.quad = null;
    return null;
  }
  let q;
  try { q = G.newQuad(qx, qy, bw, bh, iw, ih); } catch { return null; }
  if (!q) return null;
  s.quad = q;
  s._quadX = qx; s._quadY = qy; s._quadW = bw; s._quadH = bh;
  return q;
}

const BLEND_EFFECT = "blend5"; // Lua: anim_vm.lua:568 (BLEND_SHADER_SRC)

// Lua: anim_vm.lua:579
function blend_shader(): Shader | null {
  if (AnimVm._blendShader == null) {
    try { AnimVm._blendShader = G.newShader(BLEND_EFFECT); } catch { AnimVm._blendShader = false; }
  }
  return AnimVm._blendShader || null;
}

// Lua: anim_vm.lua:596
function sprite_blend(vm: AnimVm, s: AnimSprite): any {
  const b = s.palBlend;
  if (b && (b.coeff ?? 0) > 0) return b;
  if (s.tag != null && vm._tagBlend) {
    const tb = vm._tagBlend[s.tag];
    if (tb) return tb;
  }
  return null;
}

// Lua: anim_vm.lua:607 -- pokefirered/src/battle_anim.c:630
function effective_z(vm: AnimVm, s: AnimSprite): number {
  if (!s._pz) return s.z ?? AnimSprites.Z.MID_FIELD;
  const pri = s.oamPriority ?? 2;
  const sub = tonumber(s.subpriority) ?? 0;
  if (pri <= 1) return 900 + ((((255 - sub) % 99) + 99) % 99);
  if (pri >= 3) return Math.max(1, Math.min(98, 98 - sub));
  return AnimCoords.layerZ(sub, vm._monbg, vm._bgPrio);
}

// Last uniforms sent to the shared blend shader. Every send goes through
// send_blend so the cache always matches what the shader holds (the anim bg
// and sprites share one shader).
let _lastBlendShader: Shader | null = null;
let _lastBlendCoeff: number | null = null;
let _lastBlendR: number | null = null;
let _lastBlendG: number | null = null;
let _lastBlendB: number | null = null;

// Lua: anim_vm.lua:625
function send_blend(sh: Shader, coeff: number, r: number, g: number, b: number): void {
  if (sh !== _lastBlendShader || coeff !== _lastBlendCoeff || r !== _lastBlendR
      || g !== _lastBlendG || b !== _lastBlendB) {
    _lastBlendShader = sh;
    _lastBlendCoeff = coeff; _lastBlendR = r; _lastBlendG = g; _lastBlendB = b;
    try { sh.send("coeff", coeff); } catch { /* pcall */ }
    try { sh.send("target", [r, g, b]); } catch { /* pcall */ }
  }
}
AnimVm._sendBlend = send_blend;

// Lua: anim_vm.lua:636
function draw_anim_bg(vm: AnimVm): void {
  let id = vm._animBgId;
  const tintBg = vm._animBgBlend;
  if (id != null && id >= 0 && AnimPal.bgColors("bg") && AnimPal.drawBg(id, "bg",
      Math.floor(vm.bg3.x ?? 0) & 0x1FF, Math.floor(vm.bg3.y ?? 0) & 0xFF,
      tintBg ? { coeff: tintBg.coeff, color: tintBg.color } : null)) {
    id = null;
  }
  if (id != null && id >= 0) {
    const img = AnimVm.animBgImage(vm, id);
    if (img) {
      const [iw, ih] = img.getDimensions();
      if (!vm._bgQuad || vm._bgQuadImg !== img) {
        try { img.setWrap("repeat", "repeat"); } catch { /* pcall */ }
        vm._bgQuad = G.newQuad(0, 0, 240, 160, iw, ih);
        vm._bgQuadImg = img;
      }
      const x = (Math.floor(vm.bg3.x ?? 0) & 0x1FF) % iw;
      const y = (Math.floor(vm.bg3.y ?? 0) & 0xFF) % ih;
      vm._bgQuad.setViewport(x, y, 240, 160, iw, ih);
      G.setColor(1, 1, 1, 1);
      const tint = vm._animBgBlend;
      const sh = tint && (tint.coeff ?? 0) > 0 ? blend_shader() : null;
      if (sh) {
        const c = tonumber(tint.color) ?? 0;
        send_blend(sh, tint.coeff, c & 31, (c >>> 5) & 31, (c >>> 10) & 31);
        G.setShader(sh);
      }
      G.draw(img, vm._bgQuad, 0, 0);
      if (sh) G.setShader();
    }
  }
  const f = vm._bgFade;
  const y = f ? (f.y ?? 0) : 0;
  if (y > 0) {
    G.setColor(0, 0, 0, Math.min(16, y) / 16);
    G.rectangle("fill", 0, 0, 240, 160);
  }
  G.setColor(1, 1, 1, 1);
}

// Lua: anim_vm.lua:677
function particle_sort_cmp(a: AnimSprite, b: AnimSprite): boolean {
  if (a._drawZ !== b._drawZ) return a._drawZ < b._drawZ;
  return (a._poolIndex ?? 0) > (b._poolIndex ?? 0);
}

// Lua: anim_vm.lua:682
function draw_sprite(self: AnimVm, s: AnimSprite, a: number): void {
  if (s.customDraw) {
    s.customDraw(s, self);
  } else if (s.image && a > 0) {
    const drawX = Math.floor(s.x + (s.ox ?? 0) + 0.5);
    const drawY = Math.floor(s.y + (s.oy ?? 0) + 0.5);
    G.setColor(1, 1, 1, a);
    const flipX = s.hFlip ? -1 : 1;
    const flipY = s.vFlip ? -1 : 1;
    const bw = s._baseW ?? s.w ?? 32;
    const bh = s._baseH ?? s.h ?? 32;
    const scaleX = (s.scaleX ?? 1) * flipX;
    const scaleY = (s.scaleY ?? 1) * flipY;
    const rot = s.rotation ?? 0;
    const pivX = s.originX ?? (bw / 2);
    const pivY = s.originY ?? (bh / 2);
    const tint = sprite_blend(self, s);
    let pimg: Image | null;
    if (tint) {
      _blendOpts.coeff = tint.coeff; _blendOpts.color = tint.color;
      pimg = AnimPal.begin(s, s.image, _blendOpts);
    } else {
      pimg = AnimPal.begin(s, s.image, null);
    }
    const sh = (!pimg && tint) ? blend_shader() : null;
    if (sh) {
      const r = tint.color & 31, g = (tint.color >>> 5) & 31, b = (tint.color >>> 10) & 31;
      send_blend(sh, tint.coeff, r, g, b);
      G.setShader(sh);
    }
    const q = sprite_source_quad(s, bw, bh);
    if (q) {
      G.draw(pimg ?? s.image, q, drawX, drawY, rot, scaleX, scaleY, pivX, pivY);
    } else {
      G.draw(pimg ?? s.image, drawX, drawY, rot, scaleX, scaleY, pivX, pivY);
    }
    if (sh || pimg) G.setShader();
  }
}

// Blend mode currently set by AnimVm:draw (reset to "alpha" per call).
let _activeBlend = "alpha";
// Lua: anim_vm.lua:724
function set_blend_mode(mode: string): void {
  if (mode !== _activeBlend) {
    if (mode === "add") {
      G.setBlendMode("add", "alphamultiply");
    } else {
      G.setBlendMode("alpha", "alphamultiply");
    }
    _activeBlend = mode;
  }
}

// Lua: anim_vm.lua:738 -- Every active, visible sprite with its effective z, sorted once.
function build_sorted_sprites(self: AnimVm, list: LuaTable): LuaTable {
  for (let i = len(list); i >= 1; i--) list[i] = null;
  AnimSprites.init();
  const pool = AnimSprites._pool;
  let n = 0;
  for (let i = 1; i <= AnimSprites.MAX; i++) {
    const s = pool[i];
    s._poolIndex = i;
    if (s.active && s.visible !== false) {
      s._drawZ = effective_z(self, s);
      n = n + 1;
      list[n] = s;
    }
  }
  // table.sort(list, particle_sort_cmp): the order is strict and total, so an
  // in-place insertion sort (no per-frame allocation) gives the same result.
  for (let i = 2; i <= n; i++) {
    const v = list[i];
    let j = i - 1;
    while (j >= 1 && particle_sort_cmp(v, list[j])) {
      list[j + 1] = list[j];
      j--;
    }
    list[j + 1] = v;
  }
  return list;
}

// Lua: anim_vm.lua:756
function any_task_draw(): boolean {
  if (!(AnimTasks && AnimTasks._pool)) return false;
  const pool = AnimTasks._pool;
  for (let i = 1; i <= AnimTasks.MAX; i++) {
    const t = pool[i];
    if (t && t.active && t.draw) return true;
  }
  return false;
}

// Lua: anim_vm.lua:866 -- returns [image, info]
function tag_image(vm: AnimVm, tagIn: unknown): [Image | null, any] {
  const tag = gsub(tostring(tagIn ?? "").toUpperCase(), "^ANIM_TAG_", "")[0];
  const pack = vm._pack;
  if (pack && pack.tags && pack.tags[tag] && pack.tags[tag].image) {
    return [pack.tags[tag].image, pack.tags[tag]];
  }
  return [null, pack && pack.tags ? pack.tags[tag] : null];
}

// Lua: anim_vm.lua:875
function read_pack_bytes(file: string): string | undefined {
  let cache: any = null;
  try { cache = Dataset.cache(); } catch { cache = null; }
  const rel = "data/generated/gba/pokemon/battle_anims/" + file;
  if (!(cache && cache.read)) return undefined;
  const fp = fallback_prefix();
  return cache.read(rel) ?? (fp != null ? cache.read(fp + rel) : undefined);
}

const LEGACY_TASK_CB: Record<string, string> = {
  HorizontalLunge: "HorizontalLunge", DoHorizontalLunge: "HorizontalLunge",
  ReverseHorizontalLungeDirection: "HorizontalLunge",
  VerticalDip: "VerticalDip", DoVerticalDip: "VerticalDip", ReverseVerticalDipDirection: "VerticalDip",
  SlideMonToOffset: "SlideMonToOffset", SlideMonToOriginalPos: "SlideMonToOriginalPos",
  SlideMonToOffsetAndBack: "SlideMonToOffsetAndBack",
  BowMon: "BowMon", AnimBowMon: "BowMon",
  ShakeMonOrBattleTerrain: "ShakeMonOrBattleTerrain", AnimShakeMonOrBattleTerrain: "ShakeMonOrBattleTerrain",
  SimplePaletteBlend: "BlendBattleAnimPal", AnimSimplePaletteBlend: "BlendBattleAnimPal",
  ComplexPaletteBlend: "ComplexPaletteBlend", AnimComplexPaletteBlend: "ComplexPaletteBlend",
};

// Lua: anim_vm.lua:956
function set_args(vm: AnimVm, args: LuaTable): void {
  if (args == null || typeof args !== "object") return;
  for (const [i, v] of ipairs(args)) {
    if (i > ARG_COUNT) break;
    if (typeof v === "number") vm.args[i - 1] = s16(v);
  }
}

// Lua: anim_vm.lua:964
function spawn_task(vm: AnimVm, name: string, priority: unknown, args: LuaTable, kind?: string): any {
  const t = AnimTasks.spawn(name, priority, args ?? seq(), vm);
  if (!t) return null;
  t._g4kind = kind;
  const fn = t.func;
  if (fn) {
    try {
      fn(t, vm);
    } catch (err) {
      console.log("[battle.anim] task " + tostring(name) + ": " + tostring(err));
      AnimTasks.destroy(t);
    }
  }
  return t;
}
AnimVm.spawnTask = spawn_task;

// Lua: anim_vm.lua:981 -- pokefirered/src/battle_anim.c:349
function pret_subpriority(vm: AnimVm, op: any): number {
  const raw = tonumber(op.subpriority) ?? 0;
  let argVar = raw & 0x7F;
  if (argVar >= 64) argVar = argVar - 64; else argVar = -argVar;
  const id = (op.animBattler === "target") ? vm.targetId() : vm.attackerId();
  let sub = AnimCoords.SUBPRIORITY[id] + argVar;
  if (sub < 3) sub = 3;
  return sub;
}

// Lua: anim_vm.lua:991
function animate_sprite(s: AnimSprite): void {
  if (s.active && s._g4anim) {
    // pcall(require, "src.core.game3.battle.anim_port.g4_pret")
    const P = G3Lazy["src.core.game3.battle.anim_port.g4_pret"];
    if (P) P.animate(s);
  }
}
AnimVm.animateSprite = animate_sprite;

// Lua: anim_vm.lua:999
function run_createsprite(vm: AnimVm, op: any): void {
  // NOT FAITHFUL (ES module order): the anim_port groups merge into
  // AnimCallbacks / AnimTasks on first use, so make sure they have before
  // reading those tables directly.
  if (AnimCallbacks._loadGroups) AnimCallbacks._loadGroups();
  AnimTasks.init();

  const template = tostring(op.template ?? "");
  const info = AnimTemplates.get(template);
  const args = op.args ?? seq();
  set_args(vm, args);
  const cbName: string | null = op.callback ?? (info ? info.callback : null) ?? null;
  const noGfx = op.noGfx ?? (info ? info.noGfx : null);

  if (noGfx && cbName != null && cbName !== "" && AnimTasks.REGISTRY["_noGfx_" + cbName]) {
    spawn_task(vm, "_noGfx_" + cbName, 2, args, "visual");
    return;
  }
  let legacyTask: string | null = cbName != null ? (LEGACY_TASK_CB[cbName] ?? null) : null;
  if (template === "gSimplePaletteBlendSpriteTemplate") legacyTask = "BlendBattleAnimPal";
  if (template === "gComplexPaletteBlendSpriteTemplate") legacyTask = "ComplexPaletteBlend";
  if (noGfx && legacyTask == null && cbName != null && cbName !== "") {
    const cb = AnimCallbacks[cbName];
    if (!cb) legacyTask = cbName;
  }
  if (legacyTask != null && !(AnimCallbacks._pretNoGfx && AnimCallbacks._pretNoGfx[cbName as string])) {
    if (legacyTask === "HorizontalLunge") {
      spawn_task(vm, "HorizontalLunge", 2, seq(args[1] ?? 4, args[2] ?? 4), "visual");
    } else if (legacyTask === "VerticalDip") {
      spawn_task(vm, "VerticalDip", 2, seq(args[1] ?? 4, args[2] ?? 4, args[3] ?? 0), "visual");
    } else {
      spawn_task(vm, legacyTask, 2, args, "visual");
    }
    return;
  }

  const tag = op.tag ?? (info ? info.tag : null) ?? "IMPACT";
  let [img, tagInfo] = tag_image(vm, tag);
  if (!img && vm.getImpactFallback && !noGfx) {
    img = vm.getImpactFallback();
  }

  const isCutting = (cbName === "CuttingSlice" || cbName === "AirCutterSlice");
  const isSlash = (cbName === "SlashSlice" || cbName === "FalseSwipeSlice" || cbName === "ClawSlash" || cbName === "FurySwipes");
  const isBite = (cbName === "Bite" || cbName === "Fang" || cbName === "SuperFang");
  const isProjectile = (
    cbName === "ThrowProjectile" || cbName === "BulletSeed"
    || cbName === "WaterBubbleProjectile" || cbName === "SludgeProjectile"
    || cbName === "BoneHitProjectile" || cbName === "TranslateAnimSpriteToTargetMonLocation"
    || cbName === "TranslateLinearSingleSineWave" || cbName === "PainSplitProjectile"
    || cbName === "RedHeartProjectile" || cbName === "ThrowMistBall"
  );
  const isTravelDiagonally = (
    cbName === "AnimTravelDiagonally" || cbName === "TravelDiagonally"
    || cbName === "AnimEmberFlare" || cbName === "EmberFlare"
    || cbName === "AnimBurnFlame" || cbName === "BurnFlame"
  );
  const isAttackerAlways = (
    isProjectile || cbName === "RoarNoiseLine" || cbName === "AnimFireRing"
    || cbName === "FireRing" || cbName === "AnimFireSpiralOutward"
    || cbName === "FireSpiralOutward" || cbName === "AnimFirePlume"
    || cbName === "FirePlume" || cbName === "AnimLargeFlame" || cbName === "LargeFlame"
    || cbName === "AnimEruptionLaunchRock" || cbName === "EruptionLaunchRock"
    || cbName === "AnimWillOWispOrb" || cbName === "WillOWispOrb"
  );
  const isTargetAlways = (
    isCutting || isBite || cbName === "AbsorptionOrb" || cbName === "BubbleEffect"
    || cbName === "ConfuseRayBallSpiral" || cbName === "ConstrictBinding"
    || cbName === "CrossChopHand" || cbName === "DizzyPunchDuck"
    || cbName === "Electricity" || cbName === "EllipticalGust"
    || cbName === "FlatterSpotlight" || cbName === "IceEffectParticle"
    || cbName === "InitIceBallParticle" || cbName === "ItemSteal"
    || cbName === "Lick" || cbName === "PresentHealParticle"
    || cbName === "SlidingKick" || cbName === "SmallDriftingBubbles"
    || cbName === "SpinningKickOrPunch" || cbName === "SporeParticle"
    || cbName === "Spotlight" || cbName === "StompFoot"
    || cbName === "TealAlert" || cbName === "WaterGunDroplet"
    || cbName === "WaveFromCenterOfTarget"
    || cbName === "AnimFireCross" || cbName === "FireCross"
    || cbName === "AnimFireSpread" || cbName === "FireSpread"
    || cbName === "AnimFireSpiralInward" || cbName === "FireSpiralInward"
    || cbName === "AnimSunlight" || cbName === "Sunlight"
    || cbName === "AnimWeatherBallDown" || cbName === "WeatherBallDown"
    || cbName === "AnimEruptionFallingRock" || cbName === "EruptionFallingRock"
    || cbName === "AnimWillOWispFire" || cbName === "WillOWispFire"
  );
  const isDynamicArg3 = (
    cbName === "SpriteOnMonPos" || cbName === "SpinningSparkle"
    || cbName === "HitSplatBasic" || cbName === "HitSplatPersistent"
    || cbName === "HitSplatRandom" || cbName === "CrossImpact"
    || cbName === "FlashingHitSplat" || cbName === "BasicFistOrFoot"
    || cbName === "RevengeScratch" || cbName === "ParticleInVortex"
    || cbName === "SmallBubblePair" || cbName === "WhirlwindLine"
  );
  const isDynamicArg1 = (isSlash || cbName === "EndureEnergy");

  let role = (op.animBattler === "target") ? "target" : "attacker";
  let hFlip = false;
  if (isAttackerAlways) {
    role = "attacker";
  } else if (isTravelDiagonally) {
    const battlerArg = args[6];
    if (battlerArg === 1 || battlerArg === "target") {
      role = "target";
    } else {
      role = "attacker";
    }
  } else if (isTargetAlways) {
    role = "target";
  } else if (isDynamicArg3) {
    const which = args[3];
    if (which === 0 || which === "attacker") {
      role = "attacker";
    } else if (which === 1 || which === 2 || which === "target" || (which != null && which !== false && which !== 0)) {
      role = "target";
    }
  } else if (isDynamicArg1) {
    if (args[1] === 0 || args[1] === "attacker") {
      role = "attacker";
    } else {
      role = "target";
    }
  }
  const anchorId = (role === "attacker") ? vm.attackerId() : vm.targetId();
  const anchorSide = (role === "attacker") ? vm.attackerSide() : vm.targetSide();

  let [cx, cy] = vm.battlerCenter(anchorId);
  if (isCutting && anchorSide === "player") cy = cy + 8;

  let ox = 0, oy = 0, dir = 0;
  if (isCutting) {
    dir = tonumber(args[3]) ?? 0;
    ox = (dir === 0 ? 40 : -40);
    oy = tonumber(args[2]) ?? -32;
    hFlip = (dir === 1);
  } else if (isSlash) {
    ox = vm.x(tonumber(args[2]) ?? 0);
    oy = tonumber(args[3]) ?? 0;
  } else if (cbName === "RoarNoiseLine") {
    let argX = tonumber(args[1]) ?? 24;
    if (vm.isReversed) argX = -argX;
    ox = argX;
    oy = tonumber(args[2]) ?? 0;
    dir = tonumber(args[3]) ?? 0;
  } else {
    ox = vm.x(tonumber(args[1]) ?? 0);
    oy = tonumber(args[2]) ?? 0;
  }

  let bw = op.w ?? (info ? info.w : null) ?? 32;
  let bh = op.h ?? (info ? info.h : null) ?? 32;
  if (tag === "NOISE_LINE" || isCutting || isSlash || isBite) {
    bw = 32; bh = 32;
  }

  const subpri = pret_subpriority(vm, op);
  let sheetW = tagInfo ? tagInfo.w : null;
  if (img && tagInfo && tagInfo.image === img) {
    [img, sheetW] = AnimVm.sheetImage(vm, tag, bw);
  }

  const spr = AnimSprites.acquire({
    x: cx + ox,
    y: cy + oy,
    z: AnimSprites.Z.MID_FIELD,
    priority: 2,
    subpriority: subpri,
    hostId: anchorId,
    blendMode: "alpha",
    image: (!noGfx) ? img : null,
    w: bw,
    h: bh,
    hFlip,
    template,
    tag,
    callback: AnimCallbacks.get(cbName),
    palSlot: 0,
  });
  if (!spr) return;
  spr._op = op;
  spr._vm = vm;
  spr._g4counted = true;
  spr._pz = true;
  spr.oamPriority = 2;
  spr.subpriority = subpri;
  spr._baseW = bw;
  spr._baseH = bh;
  spr._sheetW = sheetW;
  spr._reversed = vm.isReversed;
  spr._args = args;
  spr._anchorSide = anchorSide;
  spr._anchorId = anchorId;
  spr._cbName = cbName;
  if (op.z != null || op.depth != null) {
    spr._pz = null;
    spr.z = tonumber(op.z ?? op.depth);
  }
  for (const [k, v] of ipairs(args)) {
    if (k <= 8) spr.data[k - 1] = v;
  }
  spr.data[0] = 0;
  spr.data[1] = 0;
  spr.data[2] = isCutting ? dir : (cbName === "RoarNoiseLine" ? dir : (tonumber(args[3]) ?? 0));
  const [tx, ty] = vm.battlerCenter(vm.targetId());
  const [ax, ay] = vm.battlerCenter(vm.attackerId());
  spr._attackerX = ax; spr._attackerY = ay;
  if (isProjectile) {
    spr._targetX = tx + vm.x(tonumber(args[3]) ?? 0);
    spr._targetY = ty + (tonumber(args[4]) ?? 0);
  } else if (isTravelDiagonally) {
    spr._targetX = cx + vm.x(tonumber(args[3]) ?? 0);
    spr._targetY = cy + (tonumber(args[4]) ?? 0);
  } else {
    spr._targetX = tx;
    spr._targetY = ty;
  }
  spr._dx = spr._targetX - spr.x;
  spr._dy = spr._targetY - spr.y;

  spr.palTag = op.palTag;
  if (spr.callback) {
    try {
      spr.callback(spr);
    } catch (err) {
      console.log("[battle.anim] sprite cb: " + tostring(err));
      AnimSprites.release(spr);
      return;
    }
  }
  animate_sprite(spr);
}

// Lua: anim_vm.lua:1227
function jump_label(vm: AnimVm, label: unknown): boolean {
  const sub = vm._pack && vm._pack.labels ? vm._pack.labels[label as any] : null;
  if (sub) {
    vm.script = sub;
    vm.pc = 1;
    return true;
  }
  return false;
}

// Lua: anim_vm.lua:1238 -- pokefirered/src/battle_anim.c:1438
function task_loop_and_play_se(t: any, _vm: AnimVm): void {
  const cnt = t._counter;
  t._counter = cnt + 1;
  if (cnt >= t._wait) {
    t._counter = 0;
    t._plays = (t._plays - 1) & 0xFF;
    play_se12(t._se, t._pan);
    if (t._plays === 0) AnimTasks.destroy(t);
  }
}

// Lua: anim_vm.lua:1250 -- pokefirered/src/battle_anim.c:1491
function task_wait_and_play_se(t: any, _vm: AnimVm): void {
  const w = t._wait;
  t._wait = w - 1;
  if (w <= 0) {
    play_se12(t._se, t._pan);
    AnimTasks.destroy(t);
  }
}

// Lua: anim_vm.lua:1260 -- pokefirered/src/battle_anim.c:1299
function task_pan_to_target(t: any, _vm: AnimVm): void {
  const cnt = t._counter;
  t._counter = cnt + 1;
  if (cnt >= t._wait) {
    t._counter = 0;
    let pan = t._cur + t._inc;
    t._cur = pan;
    let done = false;
    if (t._inc === 0) {
      done = true;
    } else if (t._init < t._target) {
      done = pan >= t._target;
    } else {
      done = pan <= t._target;
    }
    if (done) {
      pan = t._target;
      AnimTasks.destroy(t);
    }
    se12_panpot(pan);
  }
}

// Lua: anim_vm.lua:1287
function sound_task(vm: AnimVm, fnName: string, fields: Record<string, any>, callNow: boolean): any {
  const t = AnimTasks.spawn(fnName, 1, seq(), vm);
  if (!t) return null;
  t._g4kind = "sound";
  for (const [k, v] of pairs(fields)) t[k] = v;
  if (callNow) { try { t.func(t, vm); } catch { /* pcall */ } }
  return t;
}

// Lua: anim_vm.lua:1297 -- pokefirered/src/battle_anim.c:1065
function task_fade_to_bg(t: any, vm: AnimVm): void {
  const f = vm._bgFade;
  if (!f || f.task !== t) {
    AnimTasks.destroy(t);
    return;
  }
  if (f.state === 0) {
    f.from = 0; f.to = 16; f.y = 0;
    f.fading = true;
    f.state = 1;
    return;
  }
  if (f.fading) return;
  if (f.state === 1) {
    f.state = 2;
    vm._bgFadeState = 2;
  } else if (f.state === 2) {
    if (f.bgId === -1) {
      vm._animBgId = null;
      vm.bg3.x = 0; vm.bg3.y = 0;
    } else {
      vm._animBgId = f.bgId;
      AnimPal.bgLoad("bg", f.bgId);
    }
    f.from = 16; f.to = 0; f.y = 16;
    f.fading = true;
    f.state = 3;
    return;
  }
  if (f.fading) return;
  if (f.state === 3) {
    AnimTasks.destroy(t);
    vm._bgFade = null;
    vm._bgFadeState = 0;
  }
}

// Lua: anim_vm.lua:1335
function tick_bg_fade(vm: AnimVm): void {
  const f = vm._bgFade;
  if (!(f && f.fading)) return;
  if (f.to > f.from) {
    if (f.y >= f.to) f.fading = false; else f.y = f.y + 1;
  } else {
    if (f.y <= f.to) f.fading = false; else f.y = f.y - 1;
  }
}

// Lua: anim_vm.lua:1345
function start_bg_fade(vm: AnimVm, bgId: number): void {
  const t = AnimTasks.spawn("_G4FadeToBg", 5, seq(), vm);
  if (!t) return;
  t._g4kind = "aux";
  vm._bgFade = { task: t, state: 0, bgId, y: (vm._bgFade ? vm._bgFade.y : null) ?? 0 };
  vm._bgFadeState = 1;
}

// Lua: anim_vm.lua:1354 -- pokefirered/src/battle_anim.c:786
function task_clear_monbg(t: any, vm: AnimVm): void {
  t._n = (t._n ?? 0) + 1;
  if (t._n !== 1) {
    for (const [, e] of ipairs<any>(t._ids ?? seq())) {
      vm._monbg[e.id] = null;
      const p = Anim.present(e.id);
      if (p && e.origZ != null) p.z = e.origZ;
      if (p) p.monbg = false;
    }
    AnimTasks.destroy(t);
  }
}

// Lua: anim_vm.lua:1283/1333/1367 -- NOT FAITHFUL (ES module order): Brian
// registers these four tasks in AnimTasks.REGISTRY when anim_vm loads; here
// on the first AnimVm.new(), before any VM can spawn them.
function register_vm_tasks(): void {
  if (vmTasksRegistered) return;
  vmTasksRegistered = true;
  AnimTasks.REGISTRY._G4LoopAndPlaySE = task_loop_and_play_se;
  AnimTasks.REGISTRY._G4WaitAndPlaySE = task_wait_and_play_se;
  AnimTasks.REGISTRY._G4PanFromInitialToTarget = task_pan_to_target;
  AnimTasks.REGISTRY._G4FadeToBg = task_fade_to_bg;
  AnimTasks.REGISTRY._G4ClearMonBg = task_clear_monbg;
}

// Lua: anim_vm.lua:1369
function battler_from_monbg_token(vm: AnimVm, token: unknown): number {
  const s = tostring(token ?? "target");
  if (s === "attacker" || s === "atk_partner") return vm.attackerId();
  return vm.targetId();
}

// Lua: anim_vm.lua:1375
function monbg_ids(vm: AnimVm, token: unknown): LuaTable {
  const id = battler_from_monbg_token(vm, token);
  const out = seq(id);
  const partner = AnimCoords.partner(id);
  if (AnimCoords.spritePresent(null, partner)) out[2] = partner;
  return out;
}

type OpResult = boolean | "jump" | "end";
type OpFn = (vm: AnimVm, op: any) => OpResult;
const OPS: Record<string, OpFn> = {};

// Lua: anim_vm.lua:1385
OPS.loadspritegfx = (vm, op) => {
  const key = tostring(op.tag ?? "");
  if (!vm.loadedTags[key]) {
    AnimPal.markLoaded(op.tag, false);
    AnimPal.markLoaded(op.tag, true);
  }
  vm.loadedTags[key] = true;
  vm.framesToWait = 1;
  vm._cbMode = "wait";
  return true;
};

// Lua: anim_vm.lua:1396
OPS.unloadspritegfx = (vm, op) => {
  delete vm.loadedTags[tostring(op.tag ?? "")];
  AnimPal.free(op.tag);
  return true;
};

// Lua: anim_vm.lua:1402
OPS.createsprite = (vm, op) => {
  run_createsprite(vm, op);
  return true;
};

// Lua: anim_vm.lua:1407
OPS.createvisualtask = (vm, op) => {
  set_args(vm, op.args);
  spawn_task(vm, op.task ?? op.name ?? "stub", op.priority ?? 2, op.args ?? seq(), "visual");
  return true;
};

// Lua: anim_vm.lua:1413
OPS.createsoundtask = (vm, op) => {
  set_args(vm, op.args);
  spawn_task(vm, op.task ?? op.name ?? "stub", 1, op.args ?? seq(), "sound");
  return true;
};

// Lua: anim_vm.lua:1420 -- pokefirered/src/battle_anim.c:433
OPS.delay = (vm, op) => {
  let n = tonumber(op.frames) ?? 0;
  if (n === 0) n = -1;
  vm.framesToWait = n;
  vm._cbMode = "wait";
  return true;
};

// Lua: anim_vm.lua:1429 -- pokefirered/src/battle_anim.c:443
OPS.waitforvisualfinish = (vm) => {
  vm._waitFrames = (vm._waitFrames ?? 0) + 1;
  if (vm.visualCount() === 0 || vm._waitFrames > WAIT_CAP) {
    if (vm._waitFrames > WAIT_CAP) console.log("[battle.anim] waitforvisualfinish cap");
    vm._waitFrames = 0;
    vm.framesToWait = 0;
    return true;
  }
  vm.framesToWait = 1;
  return false;
};

// Lua: anim_vm.lua:1442 -- pokefirered/src/battle_anim.c:1526
OPS.waitsound = (vm) => {
  if (vm.soundCount() !== 0) {
    vm.framesToWait = 1;
    return false;
  }
  vm.framesToWait = 0;
  return true;
};

// Lua: anim_vm.lua:1451
OPS.waitanimation = (vm) => {
  vm._waitFrames = (vm._waitFrames ?? 0) + 1;
  if (AnimSprites.activeCount() === 0 || vm._waitFrames > WAIT_CAP) {
    vm._waitFrames = 0;
    return true;
  }
  vm.framesToWait = 1;
  return false;
};
OPS.waitsprites = OPS.waitanimation;
OPS.waitforsprites = OPS.waitanimation;

OPS.nop = () => true;
OPS.nop2 = OPS.nop;
// Lua: anim_vm.lua:1466 -- pokeemerald/src/battle_anim.c:1678
OPS.jumpifcontest = (vm, op) => {
  if (vm.ctx && vm.ctx.isContest && jump_label(vm, op.label)) return "jump";
  return true;
};
// Lua: anim_vm.lua:1470
OPS.stopsound = () => {
  if (Audio && Audio.stopSe) { try { Audio.stopSe(); } catch { /* pcall */ } }
  return true;
};
OPS.teamattack_moveback = OPS.nop;
OPS.teamattack_movefwd = OPS.nop;

// Lua: anim_vm.lua:1479 -- pokefirered/src/battle_anim.c:464
OPS["end"] = (vm) => {
  vm._endWait = (vm._endWait ?? 0) + 1;
  const capped = vm._endWait > WAIT_CAP;
  if (!capped && (vm.visualCount() !== 0 || vm.soundCount() !== 0 || !isEmpty(vm._monbg))) {
    vm.framesToWait = 1;
    return false;
  }
  if (capped) console.log("[battle.anim] end wait cap");
  vm._endWait = 0;
  finish(vm);
  return "end";
};

// Lua: anim_vm.lua:1492
OPS.playse = (_vm, op) => {
  play_se12(op.song ?? op.se ?? op.id ?? op[1], null);
  return true;
};

// Lua: anim_vm.lua:1498 -- pokefirered/src/battle_anim.c:1240
OPS.playsewithpan = (vm, op) => {
  play_se12(op.song ?? op.se ?? op.id ?? op[1], adjust_panning(vm, op.pan));
  return true;
};

// Lua: anim_vm.lua:1504 -- pokefirered/src/battle_anim.c:1252
OPS.setpan = (vm, op) => {
  se12_panpot(adjust_panning(vm, op.pan));
  return true;
};

// Lua: anim_vm.lua:1510 -- pokefirered/src/battle_anim.c:1412
OPS.loopsewithpan = (vm, op) => {
  const wait = (tonumber(op.wait ?? op.frames) ?? 0) & 0xFF;
  sound_task(vm, "_G4LoopAndPlaySE", {
    _se: op.song ?? op.se ?? op.id ?? op[1],
    _pan: adjust_panning(vm, op.pan),
    _wait: wait,
    _plays: (tonumber(op.times ?? op.plays ?? op.count) ?? 1) & 0xFF,
    _counter: wait,
  }, true);
  return true;
};

// Lua: anim_vm.lua:1523 -- pokefirered/src/battle_anim.c:1469
OPS.waitplaysewithpan = (vm, op) => {
  sound_task(vm, "_G4WaitAndPlaySE", {
    _se: op.song ?? op.se ?? op.id ?? op[1],
    _pan: adjust_panning(vm, op.pan),
    _wait: (tonumber(op.wait ?? op.frames) ?? 0) & 0xFF,
  }, false);
  return true;
};

// Lua: anim_vm.lua:1533 -- pokefirered/src/battle_anim.c:1269
function panse(vm: AnimVm, op: any, mode: unknown): OpResult {
  let cur: number, target: number, inc: number;
  const curArg = tonumber(op.pan) ?? 0;
  const targetArg = tonumber(op.targetPan) ?? 0;
  const incArg = tonumber(op.step) ?? 0;
  if (mode === "adjustnone") {
    cur = curArg; target = targetArg; inc = incArg;
  } else if (mode === "adjustall") {
    cur = adjust_panning2(vm, curArg); target = adjust_panning2(vm, targetArg); inc = adjust_panning2(vm, incArg);
  } else {
    cur = adjust_panning(vm, curArg);
    target = adjust_panning(vm, targetArg);
    inc = calc_pan_increment(cur, target, incArg);
  }
  sound_task(vm, "_G4PanFromInitialToTarget", {
    _init: cur, _target: target, _inc: inc,
    _wait: (tonumber(op.wait) ?? 0) & 0xFF, _cur: cur, _counter: 0,
  }, false);
  play_se12(op.song ?? op.se ?? op.id ?? op[1], cur);
  return true;
}

OPS.panse = (vm, op) => panse(vm, op, op.mode);
OPS.panse_adjustnone = (vm, op) => panse(vm, op, "adjustnone");
OPS.panse_adjustall = (vm, op) => panse(vm, op, "adjustall");

// Lua: anim_vm.lua:1560 -- pokefirered/src/battle_anim.c:531
OPS.monbg = (vm, op) => {
  for (const [, id] of ipairs<number>(monbg_ids(vm, op.battler))) {
    const p = Anim.present(id);
    if (p && p.visible !== false) {
      vm._monbg[id] = true;
      vm._bgPrio[AnimCoords.BG_PRIORITY_RANK[id]] = 2;
      if (p._g4OrigZ == null) p._g4OrigZ = p.z;
      p.z = AnimVm.Z.BEHIND;
      p.monbg = true;
    }
  }
  return true;
};
// Lua: anim_vm.lua:1574
OPS.monbg_static = (vm, op) => {
  const id = battler_from_monbg_token(vm, op.battler);
  vm._bgPrio[AnimCoords.BG_PRIORITY_RANK[id]] = 2;
  return true;
};

// Lua: anim_vm.lua:1581 -- pokefirered/src/battle_anim.c:754
OPS.clearmonbg = (vm, op) => {
  const ids: LuaTable = [null];
  for (const [, id] of ipairs<number>(monbg_ids(vm, op.battler))) {
    const p = Anim.present(id);
    const e: any = { id };
    e.origZ = (p && p._g4OrigZ) ?? ((AnimCoords.sideOf(id) === "player") ? AnimVm.Z.PLAYER : AnimVm.Z.ENEMY);
    if (vm._monbg[id]) ids[len(ids) + 1] = e;
    if (p) p._g4OrigZ = null;
  }
  const t = AnimTasks.spawn("_G4ClearMonBg", 5, seq(), vm);
  if (t) {
    t._g4kind = "aux";
    t._ids = ids;
  } else {
    for (const [, e] of ipairs<any>(ids)) vm._monbg[e.id] = null;
  }
  return true;
};
OPS.clearmonbg_static = OPS.nop;

// Lua: anim_vm.lua:1603 -- pokefirered/src/battle_anim.c:933
OPS.setalpha = (vm, op) => {
  vm.bldAlpha = { eva: tonumber(op.eva) ?? 16, evb: tonumber(op.evb) ?? 0 };
  return true;
};

OPS.setbldcnt = OPS.nop;

// Lua: anim_vm.lua:1610
OPS.blendoff = (vm) => {
  vm.bldAlpha = null;
  return true;
};

// Lua: anim_vm.lua:1616 -- pokefirered/src/battle_anim.c:961
OPS.call = (vm, op) => {
  const label = op.label ?? op.target;
  const sub = vm._pack && vm._pack.labels ? vm._pack.labels[label] : null;
  if (sub) {
    vm._retScript = vm.script; vm._retPc = vm.pc + 1;
    vm.script = sub;
    vm.pc = 1;
    return "jump";
  }
  return true;
};

// Lua: anim_vm.lua:1628
OPS["return"] = (vm) => {
  if (vm._retScript) {
    vm.script = vm._retScript;
    vm.pc = vm._retPc;
    return "jump";
  }
  return true;
};

// Lua: anim_vm.lua:1637
OPS["goto"] = (vm, op) => {
  if (jump_label(vm, op.label ?? op.target)) return "jump";
  return true;
};

// Lua: anim_vm.lua:1643 -- pokefirered/src/battle_anim.c:973
OPS.setarg = (vm, op) => {
  const id = tonumber(op.argId) ?? 0;
  if (id >= 0 && id < ARG_COUNT) vm.args[id] = s16(tonumber(op.value) ?? 0);
  return true;
};

// Lua: anim_vm.lua:1650 -- pokefirered/src/battle_anim.c:987
OPS.choosetwoturnanim = (vm, op) => {
  const label = ((vm._turn ?? 0) & 1) === 1 ? op.label2 : op.label1;
  if (jump_label(vm, label)) return "jump";
  return true;
};

// Lua: anim_vm.lua:1657 -- pokefirered/src/battle_anim.c:995
OPS.jumpifmoveturn = (vm, op) => {
  if ((tonumber(op.turn) ?? 0) === (vm._turn ?? 0)) {
    if (jump_label(vm, op.label)) return "jump";
  }
  return true;
};

// Lua: anim_vm.lua:1665 -- pokefirered/src/battle_anim.c:1554
OPS.jumpargeq = (vm, op) => {
  const id = tonumber(op.argId) ?? 0;
  if (s16(tonumber(op.value) ?? 0) === (vm.args[id] ?? 0)) {
    if (jump_label(vm, op.label)) return "jump";
  }
  return true;
};

// Lua: anim_vm.lua:1674 -- pokefirered/src/battle_anim.c:1032
OPS.fadetobg = (vm, op) => {
  start_bg_fade(vm, tonumber(op.bg ?? op.bg1) ?? 0);
  return true;
};

// Lua: anim_vm.lua:1680 -- pokefirered/src/battle_anim.c:1045
OPS.fadetobgfromset = (vm, op) => {
  const id = (vm.targetSide() === "player") ? op.bg2 : op.bg1;
  start_bg_fade(vm, tonumber(id) ?? 0);
  return true;
};

// Lua: anim_vm.lua:1687 -- pokefirered/src/battle_anim.c:1114
OPS.restorebg = (vm) => {
  vm.args[7] = -1;
  start_bg_fade(vm, -1);
  return true;
};

// Lua: anim_vm.lua:1694 -- pokefirered/src/battle_anim.c:1127
OPS.waitbgfadeout = (vm) => {
  if (vm._bgFadeState === 2) {
    vm.framesToWait = 0;
    return true;
  }
  vm.framesToWait = 1;
  return false;
};

// Lua: anim_vm.lua:1703
OPS.waitbgfadein = (vm) => {
  if ((vm._bgFadeState ?? 0) === 0) {
    vm.framesToWait = 0;
    return true;
  }
  vm.framesToWait = 1;
  return false;
};

// Lua: anim_vm.lua:1713 -- pokefirered/src/battle_anim.c:1153
OPS.changebg = (vm, op) => {
  vm._animBgId = tonumber(op.bg) ?? 0;
  AnimPal.bgLoad("bg", vm._animBgId);
  return true;
};

// Lua: anim_vm.lua:1720 -- pokefirered/src/battle_anim.c:1574
OPS.splitbgprio = (vm, op) => {
  const id = (op.battler === "attacker") ? vm.attackerId() : vm.targetId();
  if (op.mode === "foes" && vm.attackerSide() === vm.targetSide()) return true;
  if (op.mode === "all" || AnimCoords.BG_PRIORITY_RANK[id] === 2) {
    vm._bgPrio[1] = 1;
    vm._bgPrio[2] = 2;
  }
  return true;
};
// Lua: anim_vm.lua:1729
OPS.splitbgprio_all = (vm) => {
  vm._bgPrio[1] = 1;
  vm._bgPrio[2] = 2;
  return true;
};
// Lua: anim_vm.lua:1734
OPS.splitbgprio_foes = (vm, op) => {
  if (vm.attackerSide() !== vm.targetSide()) {
    return OPS.splitbgprio!(vm, { battler: op.battler });
  }
  return true;
};

// Lua: anim_vm.lua:1742 -- pokefirered/src/battle_anim.c:1631
function set_visible(vm: AnimVm, op: any, visible: boolean): OpResult {
  const id = vm.battlerId(op.battler ?? "attacker");
  const p = id != null ? Anim.present(id) : null;
  if (p) p.visible = visible;
  return true;
}
OPS.invisible = (vm, op) => set_visible(vm, op, false);
OPS.visible = (vm, op) => set_visible(vm, op, true);

// Lua: anim_vm.lua:1752
function run_op(vm: AnimVm, op: any): OpResult {
  if (op == null || typeof op !== "object") return true;
  const code = op.op ?? op[1];
  const fn = OPS[code];
  if (!fn) return true;
  return fn(vm, op);
}

// Lua: anim_vm.lua:1761 -- pokefirered/src/battle_anim.c:310
function script_step(self: AnimVm): void {
  if (!self.active) return;
  if (self._cbMode === "wait") {
    // pokefirered/src/battle_anim.c:297
    if (self.framesToWait <= 0) {
      self._cbMode = "run";
      self.framesToWait = 0;
    } else {
      self.framesToWait = self.framesToWait - 1;
    }
    return;
  }
  let guard = 0;
  do {
    guard = guard + 1;
    const op = self.script ? self.script[self.pc] : null;
    if (op == null) {
      finish(self);
      return;
    }
    self.framesToWait = 0;
    const r = run_op(self, op);
    if (r === "end") return;
    if (r === true) {
      self.pc = self.pc + 1;
    } else if (r === false) {
      return;
    }
  } while (!(self.framesToWait !== 0 || !self.active || guard >= 2048));
}

// Lua: anim_vm.lua:1792
function run_sprites(self: AnimVm): void {
  AnimSprites.init();
  const hooks = self._spriteHooks;
  if (hooks) {
    for (let i = len(hooks); i >= 1; i--) {
      let ok = true, keep: unknown;
      try { keep = hooks[i](self); } catch { ok = false; }
      if (!ok || keep === false) remove(hooks, i);
    }
  }
  AnimSprites.update();
}

export default AnimVm;
