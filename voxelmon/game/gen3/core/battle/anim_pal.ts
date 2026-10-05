// Port of gen1recomp src/core/game3/battle/anim_pal.lua (GPLv3 + additional terms; see LICENSE.md).
// Battle-anim palettes: pret's unfaded/faded OBJ palette buffers by anim tag,
// palette blends (BlendPalette), and the indexed-sheet draw path (the
// `anim_pal` effect: the sheet's red channel holds the colour index).

import { tonumber, tostring } from "../../../../import/gen3/lua.ts";
import { Versions } from "../../../../import/gen3/versions.ts";
import { G } from "../../platform/graphics.ts";
import type { Shader } from "../../platform/graphics.ts";
import type { Image, Quad } from "../../platform/image.ts";
import { Fs } from "../../platform/fs.ts";
import { newImageData, type ImageData } from "../../platform/image.ts";
import { gsub } from "../../platform/lpattern.ts";
import { type LuaTable } from "../../platform/lt.ts";
import { Dataset } from "../dataset.ts";
import { BattleProfile } from "./profile.ts";

/** A 16-colour palette, keyed 0..15 (Brian's `out[i]` for i = 0, 15). */
export type Pal16 = Record<number, number>;

// Lua: anim_pal.lua:5
function fallback_prefix(): string | null {
  return BattleProfile.get().animCacheFallback ?? null;
}

let _lastSentPal: Pal16 = {};
let _lastOpaque0: boolean | null = null;

// Normalised tags by raw tag (strings and numbers only); tags come from a
// fixed set, and norm runs for every sprite drawn.
const _normCache = new Map<unknown, string>();
// Lua: anim_pal.lua:23
function norm(tag: unknown): string | null {
  if (tag == null) return null;
  const hit = _normCache.get(tag);
  if (hit != null) return hit;
  const out = gsub(tostring(tag).toUpperCase(), "^ANIM_TAG_", "")[0];
  const t = typeof tag;
  if (t === "string" || t === "number") _normCache.set(tag, out);
  return out;
}

// Lua: anim_pal.lua:51
function base_ints(tag: string | null): LuaTable {
  const pack = AnimPal._pack;
  if (!pack) return null;
  const info = pack.tags && tag != null ? pack.tags[tag] : null;
  let p = info ? info.pal : null;
  if (p == null && pack.tagPals) p = tag != null ? pack.tagPals[tag] : null;
  return p ?? null;
}

// Lua: anim_pal.lua:60 -- a 1-based sequence -> a palette keyed 0..15
function copy0(src: LuaTable): Pal16 {
  const out: Pal16 = {};
  for (let i = 0; i <= 15; i++) out[i] = src ? (src[i + 1] ?? 0) : 0;
  return out;
}

const SHADER_EFFECT = "anim_pal"; // Lua: anim_pal.lua:182 (SHADER_SRC)

let shader: Shader | null = null;
let shaderFailed = false;

// vec4 uniforms, as LÖVE tables (JS arrays [r, g, b, a])
const vecs: number[][] = [];
for (let i = 1; i <= 16; i++) vecs[i] = [0, 0, 0, 0];

// Lua: anim_pal.lua:212 -- pokefirered/src/battle_anim_mons.c:1287
function gray5(r: number, g: number, b: number): [number, number, number] {
  const v = Math.floor((r + g + b) / 3);
  return [v, v, v];
}

const resolved: Pal16 = {};
const _spriteBlendOpts: Record<string, any> = {};

// Lua: anim_pal.lua:347
function load_image(bytes: unknown, name: string): ImageData | null {
  if (typeof bytes !== "string" || bytes.length === 0) return null;
  let fd;
  try { fd = Fs.newFileData(bytes, name); } catch { return null; }
  try { return newImageData(fd) ?? null; } catch { return null; }
}

function newImageSafe(data: ImageData): Image | null {
  try { return G.newImage(data); } catch { return null; }
}

const bgQuads = new WeakMap<Image, Quad>();

export const AnimPal: Record<string, any> = {
  unfaded: {} as Record<string, Pal16>,
  faded: {} as Record<string, Pal16>,
  loaded: {} as Record<string, boolean>,
  idxOf: new WeakMap<Image, { img: Image; tag: string | null }>(),
  _pack: null as LuaTable,
  blackPass: null as boolean | null,
  _zero: null as Pal16 | null,

  norm,

  // Lua: anim_pal.lua:34
  reset(pack?: LuaTable): void {
    if (pack != null) AnimPal._pack = pack;
    AnimPal.unfaded = {};
    AnimPal.faded = {};
    AnimPal.loaded = {};
    _lastSentPal = {};
    _lastOpaque0 = null;
  },

  // Lua: anim_pal.lua:43
  setPack(pack: LuaTable): void {
    if (AnimPal._pack !== pack) {
      AnimPal._pack = pack;
      AnimPal.unfaded = {};
      AnimPal.faded = {};
    }
  },

  // Lua: anim_pal.lua:66
  tagName(idIn: unknown): string | null {
    let id = tonumber(idIn);
    if (id == null) return null;
    if (id < 0) id = id + 65536;
    let names: any = null;
    try { names = Versions.ANIM_TAG_NAMES; } catch { names = null; }
    return (names && names[id - 10000]) ?? null;
  },

  // Lua: anim_pal.lua:75
  hasBase(tag: unknown): boolean {
    return base_ints(norm(tag)) != null;
  },

  // Lua: anim_pal.lua:79
  unfadedOf(tagIn: unknown): Pal16 | null {
    const tag = norm(tagIn);
    if (tag == null) return null;
    let u = AnimPal.unfaded[tag];
    if (u) return u;
    const b = base_ints(tag);
    if (b == null) return null;
    u = copy0(b);
    AnimPal.unfaded[tag] = u;
    return u;
  },

  // Lua: anim_pal.lua:91
  fadedOf(tagIn: unknown): Pal16 | null {
    const tag = norm(tagIn);
    if (tag == null) return null;
    return AnimPal.faded[tag] ?? AnimPal.unfadedOf(tag);
  },

  // Lua: anim_pal.lua:97
  writeFaded(tagIn: unknown): Pal16 | null {
    const tag = norm(tagIn);
    let f = tag != null ? AnimPal.faded[tag] : null;
    if (f) return f;
    const u = AnimPal.unfadedOf(tag);
    if (!u) return null;
    f = {};
    for (let i = 0; i <= 15; i++) f[i] = u[i]!;
    AnimPal.faded[tag as string] = f;
    return f;
  },

  // Lua: anim_pal.lua:109
  resetFaded(tag: unknown): void {
    const k = norm(tag);
    if (k != null) delete AnimPal.faded[k];
  },

  // Lua: anim_pal.lua:114 -- pokefirered/src/sprite.c:1638
  markLoaded(tagIn: unknown, on: unknown): void {
    const tag = norm(tagIn);
    if (tag == null) return;
    if (on != null && on !== false) {
      AnimPal.loaded[tag] = true;
    } else {
      delete AnimPal.loaded[tag];
      delete AnimPal.unfaded[tag];
      delete AnimPal.faded[tag];
    }
  },

  // Lua: anim_pal.lua:126
  isLoaded(tag: unknown): boolean {
    const k = norm(tag);
    return k != null && AnimPal.loaded[k] === true;
  },

  // Lua: anim_pal.lua:131 -- pokefirered/src/sprite.c:1609
  alloc(tagIn: unknown): Pal16 | null {
    const tag = norm(tagIn);
    if (tag == null) return null;
    if (AnimPal.loaded[tag] && AnimPal.unfaded[tag]) return AnimPal.unfaded[tag];
    const u: Pal16 = {};
    for (let i = 0; i <= 15; i++) u[i] = 0;
    AnimPal.unfaded[tag] = u;
    delete AnimPal.faded[tag];
    AnimPal.loaded[tag] = true;
    return u;
  },

  // Lua: anim_pal.lua:143
  free(tag: unknown): void {
    AnimPal.markLoaded(tag, false);
  },

  // Lua: anim_pal.lua:148 -- pokefirered/src/palette.c:88
  load(tagIn: unknown, colors: Pal16, dst: number, count: number): void {
    const tag = norm(tagIn);
    const u = AnimPal.unfadedOf(tag) ?? AnimPal.alloc(tag);
    const f = AnimPal.writeFaded(tag);
    for (let i = 0; i <= count - 1; i++) {
      const c = colors[i] ?? 0;
      u[dst + i] = c;
      f[dst + i] = c;
    }
  },

  // Lua: anim_pal.lua:159
  rgb(c: number): [number, number, number] {
    return [c & 31, (c >>> 5) & 31, (c >>> 10) & 31];
  },

  // Lua: anim_pal.lua:163
  pack(r: number, g: number, b: number): number {
    return (r & 31) | ((g & 31) << 5) | ((b & 31) << 10);
  },

  // Lua: anim_pal.lua:171 (asr4 = floor(v / 16))
  blend5(r: number, g: number, b: number, coeff: number, tr: number, tg: number, tb: number): [number, number, number] {
    return [r + Math.floor(((tr - r) * coeff) / 16), g + Math.floor(((tg - g) * coeff) / 16), b + Math.floor(((tb - b) * coeff) / 16)];
  },

  // Lua: anim_pal.lua:176 -- pokefirered/src/palette.c:779
  blendColor(c: number, coeff: number, target: number): number {
    const [r, g, b] = AnimPal.rgb(c);
    const [tr, tg, tb] = AnimPal.rgb(target);
    return AnimPal.pack(...AnimPal.blend5(r, g, b, coeff, tr, tg, tb));
  },

  // Lua: anim_pal.lua:197
  shader(): Shader | null {
    if (shader || shaderFailed) return shader;
    // (`love.graphics.newShader` always exists here.)
    try {
      shader = G.newShader(SHADER_EFFECT);
    } catch (sh) {
      shaderFailed = true;
      console.log("[battle.anim] pal shader: " + tostring(sh));
    }
    return shader;
  },

  gray5,

  // Lua: anim_pal.lua:219 -- pokefirered/src/battle_anim_mons.c:1287
  greyscale(tag: unknown, restore?: unknown): void {
    const u = AnimPal.unfadedOf(tag);
    const f = AnimPal.writeFaded(tag);
    if (!(u && f)) return;
    for (let i = 0; i <= 15; i++) {
      if (restore != null && restore !== false) {
        f[i] = u[i]!;
      } else {
        const [r, g, b] = AnimPal.rgb(u[i]!);
        f[i] = AnimPal.pack(...gray5(r, g, b));
      }
    }
  },

  // Lua: anim_pal.lua:233
  resolve(colors: Pal16 | null, opts: Record<string, any> | null, out?: Pal16): Pal16 {
    out = out ?? {};
    opts = opts ?? {};
    const coeff = tonumber(opts.coeff) ?? 0;
    let tr = 0, tg = 0, tb = 0;
    if (coeff > 0) [tr, tg, tb] = AnimPal.rgb(tonumber(opts.color) ?? 0);
    const aff = opts.affine;
    for (let i = 0; i <= 15; i++) {
      const c = colors ? (colors[i] ?? 0) : 0;
      let [r, g, b] = AnimPal.rgb(c);
      if (coeff > 0) [r, g, b] = AnimPal.blend5(r, g, b, coeff, tr, tg, tb);
      const k = aff ? (1 - aff.m) : 0;
      if (aff && aff.m >= 0 && k > 0.0001) {
        const cf = Math.floor(k * 16 + 0.5);
        const ar = Math.max(0, Math.min(31, Math.floor(aff.r / k * 31 + 0.5)));
        const ag = Math.max(0, Math.min(31, Math.floor(aff.g / k * 31 + 0.5)));
        const ab = Math.max(0, Math.min(31, Math.floor(aff.b / k * 31 + 0.5)));
        [r, g, b] = AnimPal.blend5(r, g, b, cf, ar, ag, ab);
      } else if (aff && aff.m < 0) {
        r = Math.floor((r / 31 * aff.m + aff.r) * 31 + 0.5);
        g = Math.floor((g / 31 * aff.m + aff.g) * 31 + 0.5);
        b = Math.floor((b / 31 * aff.m + aff.b) * 31 + 0.5);
        r = Math.max(0, Math.min(31, r));
        g = Math.max(0, Math.min(31, g));
        b = Math.max(0, Math.min(31, b));
      }
      if (opts.gray != null && opts.gray !== false) [r, g, b] = gray5(r, g, b);
      out[i] = AnimPal.pack(r, g, b);
    }
    return out;
  },

  // Lua: anim_pal.lua:267
  send(colors: Pal16 | null, opts?: Record<string, any> | null): Shader | null {
    const sh = AnimPal.shader();
    if (!sh) return null;
    const fin = AnimPal.resolve(colors, opts ?? null, resolved);
    if (AnimPal.blackPass) {
      for (let i = 0; i <= 15; i++) fin[i] = 0;
    }
    const opaque0 = !!(opts && opts.opaque0);
    let changed = opaque0 !== _lastOpaque0;
    if (!changed) {
      for (let i = 0; i <= 15; i++) {
        if (fin[i] !== _lastSentPal[i]) {
          changed = true;
          break;
        }
      }
    }
    if (changed) {
      _lastOpaque0 = opaque0;
      for (let i = 0; i <= 15; i++) {
        _lastSentPal[i] = fin[i]!;
        const [r, g, b] = AnimPal.rgb(fin[i]!);
        const v = vecs[i + 1]!;
        v[0] = r / 31; v[1] = g / 31; v[2] = b / 31;
        v[3] = (i === 0 && !opaque0) ? 0 : 1;
      }
      try {
        // NOTE: send keeps the values array; copy the vec4s so a later resend
        // cannot change uniforms a draw already used (the CPU variant keys on them).
        sh.send("pal", ...vecs.slice(1).map((v) => v.slice()));
      } catch {
        return null;
      }
    }
    return sh;
  },

  // Lua: anim_pal.lua:299
  register(rgbaImg: Image | null | undefined, idxImg: Image | null | undefined, tag: unknown): void {
    if (rgbaImg && idxImg) AnimPal.idxOf.set(rgbaImg, { img: idxImg, tag: norm(tag) });
  },

  // Lua: anim_pal.lua:303 -- returns [idxImage, tag]
  indexImage(img: Image | null | undefined): [Image | null, string | null] {
    const e = img ? AnimPal.idxOf.get(img) : null;
    return [e ? e.img : null, e ? e.tag : null];
  },

  // Lua: anim_pal.lua:308
  spriteTag(s: any, fallback?: string | null): string | null {
    return norm(s ? (s._palTag ?? s.palTag ?? s.tag) : null) ?? fallback ?? null;
  },

  // Lua: anim_pal.lua:312
  begin(s: any, img: Image, opts?: Record<string, any> | null): Image | null {
    const [idx, sheetTag] = AnimPal.indexImage(img);
    if (!idx) return null;
    const tag = AnimPal.spriteTag(s, sheetTag);
    let colors = AnimPal.fadedOf(tag);
    if (!colors && tag !== sheetTag) colors = AnimPal.fadedOf(sheetTag);
    if (!colors) return null;
    const sh = AnimPal.send(colors, opts);
    if (!sh) return null;
    G.setShader(sh);
    return idx;
  },

  // Lua: anim_pal.lua:327
  beginSprite(s: any, img: Image, vm?: any): Image | null {
    const b = s && s.palBlend;
    let tint: any = null;
    if (b && (tonumber(b.coeff) ?? 0) > 0) {
      tint = b;
    } else if (vm && vm._tagBlend && s && s.tag != null) {
      tint = vm._tagBlend[s.tag];
    }
    let opts: Record<string, any> | undefined;
    if (tint) {
      _spriteBlendOpts.coeff = tint.coeff;
      _spriteBlendOpts.color = tint.color;
      opts = _spriteBlendOpts;
    }
    return AnimPal.begin(s, img, opts);
  },

  // Lua: anim_pal.lua:343
  finish(): void {
    G.setShader();
  },

  loadImageData: load_image,

  // Lua: anim_pal.lua:357
  readPackFile(file: unknown): string | undefined {
    let cache: any = null;
    try { cache = Dataset.cache(); } catch { cache = null; }
    const rel = "data/generated/gba/pokemon/battle_anims/" + tostring(file);
    if (!(cache && cache.read)) return undefined;
    const fp = fallback_prefix();
    return cache.read(rel) ?? (fp != null ? cache.read(fp + rel) : undefined);
  },

  // Lua: anim_pal.lua:364
  hydrateIndex(info: any, tag: unknown, rgbaImg: Image, reader?: (f: string) => string | undefined): Image | null {
    if (!(info && info.idxFile && rgbaImg)) return null;
    if (info.idxImage == null) {
      info.idxImage = false;
      const data = load_image((reader ?? AnimPal.readPackFile)(info.idxFile), info.idxFile);
      if (data) {
        info.idxData = data;
        const img = newImageSafe(data);
        if (img) {
          img.setFilter("nearest", "nearest");
          info.idxImage = img;
        }
      }
    }
    if (info.idxImage) AnimPal.register(rgbaImg, info.idxImage, tag);
    return info.idxImage || null;
  },

  // Lua: anim_pal.lua:382
  relayIndex(info: any, tag: unknown, rgbaOut: Image, w: number): Image | null {
    const src: ImageData | undefined = info && info.idxData;
    if (!(src && rgbaOut)) return null;
    const [sw, sh] = [src.getWidth(), src.getHeight()];
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
    const out = newImageSafe(dst);
    if (!out) return null;
    out.setFilter("nearest", "nearest");
    AnimPal.register(rgbaOut, out, tag);
    return out;
  },

  bgUnfaded: {} as Record<string, Pal16 | undefined>,
  bgFaded: {} as Record<string, Pal16 | undefined>,

  // Lua: anim_pal.lua:406
  bgInfo(key: unknown): any {
    const pack = AnimPal._pack;
    return pack && pack.animBgs ? pack.animBgs[key as any] : null;
  },

  // Lua: anim_pal.lua:411
  bgLoad(slot: string, key: unknown, palOverride?: LuaTable): Pal16 | null {
    const info = AnimPal.bgInfo(key);
    const src = palOverride ?? (info ? info.pal : null);
    if (src == null) {
      delete AnimPal.bgUnfaded[slot];
      delete AnimPal.bgFaded[slot];
      return null;
    }
    const u = copy0(src);
    AnimPal.bgUnfaded[slot] = u;
    delete AnimPal.bgFaded[slot];
    return u;
  },

  // Lua: anim_pal.lua:425
  bgColors(slot: string): Pal16 | undefined {
    return AnimPal.bgFaded[slot] ?? AnimPal.bgUnfaded[slot];
  },

  // Lua: anim_pal.lua:429
  bgWriteFaded(slot: string): Pal16 | null {
    let f = AnimPal.bgFaded[slot];
    if (f) return f;
    const u = AnimPal.bgUnfaded[slot];
    if (!u) return null;
    f = {};
    for (let i = 0; i <= 15; i++) f[i] = u[i]!;
    AnimPal.bgFaded[slot] = f;
    return f;
  },

  // Lua: anim_pal.lua:440 -- returns [image, idxImage, info]
  bgImages(key: unknown): [Image | null, Image | null, any] {
    const info = AnimPal.bgInfo(key);
    if (!info) return [null, null, null];
    if (info.image == null) {
      info.image = false;
      if (info.file) {
        const data = load_image(AnimPal.readPackFile(info.file), info.file);
        if (data) {
          const img = newImageSafe(data);
          if (img) {
            img.setFilter("nearest", "nearest");
            try { img.setWrap("repeat", "repeat"); } catch { /* pcall */ }
            info.image = img;
          }
        }
      }
    }
    if (info.image && info.idxImage == null) {
      info.idxImage = false;
      if (info.idxFile) {
        const data = load_image(AnimPal.readPackFile(info.idxFile), info.idxFile);
        if (data) {
          const img = newImageSafe(data);
          if (img) {
            img.setFilter("nearest", "nearest");
            try { img.setWrap("repeat", "repeat"); } catch { /* pcall */ }
            info.idxImage = img;
          }
        }
      }
    }
    return [info.image || null, info.idxImage || null, info];
  },

  // Lua: anim_pal.lua:477 -- pokefirered/src/battle_anim_mons.c:939
  drawBg(key: unknown, slot: string | null, scrollX: unknown, scrollY: unknown, optsIn?: Record<string, any> | null): boolean {
    const opts = optsIn ?? {};
    const r = AnimPal.bgImages(key);
    const img = r[0];
    if (!img) return false;
    const idx = r[1], info = r[2];
    const [iw, ih] = img.getDimensions();
    const sx = (((Math.floor(tonumber(scrollX) ?? 0)) % iw) + iw) % iw;
    const sy = (((Math.floor(tonumber(scrollY) ?? 0)) % ih) + ih) % ih;
    const vw = opts.w ?? 240, vh = opts.h ?? 160;
    let draw = img;
    let sh: Shader | null = null;
    const colors = slot ? AnimPal.bgColors(slot) : null;
    if (idx && colors) {
      sh = AnimPal.send(colors, { coeff: opts.coeff, color: opts.color, affine: opts.affine, opaque0: info.opaque0 });
      if (sh) draw = idx;
    }
    let q = bgQuads.get(draw);
    if (!q) {
      q = G.newQuad(0, 0, vw, vh, iw, ih);
      bgQuads.set(draw, q);
    }
    q.setViewport(sx, sy, vw, vh, iw, ih);
    const eva = opts.eva, evb = opts.evb;
    if (eva != null && evb != null && eva + evb !== 16 && sh) {
      let zero = AnimPal._zero;
      if (!zero) {
        zero = {};
        for (let i = 0; i <= 15; i++) zero[i] = 0;
        AnimPal._zero = zero;
      }
      const blk = AnimPal.send(zero, { opaque0: info.opaque0 });
      G.setShader(blk);
      G.setColor(1, 1, 1, 1 - Math.min(16, evb) / 16);
      G.draw(draw, q, opts.x ?? 0, opts.y ?? 0);
      sh = AnimPal.send(colors!, { coeff: opts.coeff, color: opts.color, affine: opts.affine, opaque0: info.opaque0 });
      G.setShader(sh);
      G.setBlendMode("add", "alphamultiply");
      G.setColor(1, 1, 1, Math.min(16, eva) / 16);
      G.draw(draw, q, opts.x ?? 0, opts.y ?? 0);
      G.setBlendMode("alpha", "alphamultiply");
    } else {
      if (sh) G.setShader(sh);
      let a = opts.alpha;
      if (a == null && eva != null) a = Math.min(16, eva) / 16;
      G.setColor(1, 1, 1, a ?? 1);
      G.draw(draw, q, opts.x ?? 0, opts.y ?? 0);
    }
    G.setColor(1, 1, 1, 1);
    if (sh) G.setShader();
    return true;
  },

  // Lua: anim_pal.lua:529
  bgLayerDraw(key: unknown, slot: string | null, x: unknown, y: unknown, vm?: any, optsIn?: Record<string, any> | null): boolean {
    const opts = optsIn ?? {};
    const b = vm && vm.bldAlpha;
    if (b && !opts.noBlend) {
      opts.eva = tonumber(b.eva ?? b[1]) ?? 16;
      opts.evb = tonumber(b.evb ?? b[2]) ?? 0;
      if (opts.eva <= 0) return true;
    }
    return AnimPal.drawBg(key, slot, x, y, opts);
  },
};

export default AnimPal;
