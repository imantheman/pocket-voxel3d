// Port of gen1recomp src/core/game3/ow_sprites.lua (GPLv3 + additional terms; see LICENSE.md).
// Runtime FRLG overworld sprites (extracted 4bpp -> RGBA sheets).
//
// Port notes:
// - require / package.loaded / pcall(require) become static imports (every
//   module is in the bundle); pcall(require, "src.core.game3.deoxys") reads
//   the module's ROCK_PALS as Brian's does.
// - The upload coroutine is a generator (asset_stream.ts): coroutine.yield is
//   `yield`. A sheet's `quads` keeps Brian's keys 0..frameCount-1 as array
//   indices, so `spr.quads[frame]` is unchanged.
// - Multiple returns are 0-based tuples: pose -> [frame, flip],
//   fishingFrame -> [frameInGroup, ended], fishingOffset -> [x2, y2].
// - love.image / love.graphics are always present here, so recolour_sprite's
//   "headless" bail-out never fires.

import { G } from "../platform/graphics.ts";
import type { Image, Quad, ImageData } from "../platform/image.ts";
import { luaLoad } from "../platform/luadata.ts";
import { seq, len, ipairs, pairs, isEmpty, type LuaTable } from "../platform/lt.ts";
import { tonumber, tostring, format } from "../../../import/gen3/lua.ts";
import Extract from "../../../import/gen3/extract_island1.ts";
import OwExtract from "../../../import/gen3/ow_extract.ts";
import Versions from "../../../import/gen3/versions.ts";
import Stream, { type AssetStream } from "./asset_stream.ts";
import Profile from "./profile.ts";
import Deoxys from "./deoxys.ts";
import PlayerMod from "./player.ts";

/** A loaded overworld sheet: the decoded meta plus its texture and quads. */
export interface OwSheet {
  graphicsId: number;
  width: number;
  height: number;
  frameCount: number;
  inanimate?: boolean;
  image?: Image;
  quads?: Quad[];
  imageData?: ImageData;
  bytes?: number;
  palette?: LuaTable;
  reflectionPaletteMappedTag?: number;
  mappedReflectionPalette?: LuaTable;
  [k: string]: any;
}

export interface OwPaletteOverride {
  key: string;
  spr?: OwSheet;
  colours: LuaTable;
  sourceColours: LuaTable;
}

export interface OwPoseOpts {
  bow?: boolean;
  fieldMove?: boolean;
  fieldMoveFrame?: number;
  frame?: number;
  fishing?: boolean;
  fishFrame?: number;
  running?: number;
  alpha?: number;
  [k: string]: any;
}

// pret ANIM_STD: stand S/N/W; walk uses frames 3-8; east = west + hflip
const STAND: Record<string, number> = { down: 0, up: 1, left: 2, right: 2 };
const WALK_A: Record<string, number> = { down: 3, up: 5, left: 7, right: 7 };
const WALK_B: Record<string, number> = { down: 4, up: 6, left: 8, right: 8 };
// src/data/object_events/object_event_anims.h:601
const RUN_BASE: Record<string, number> = { down: 9, up: 12, left: 15, right: 15 };
const RUN_A: Record<string, number> = { down: 10, up: 13, left: 16, right: 16 };
const RUN_B: Record<string, number> = { down: 11, up: 14, left: 17, right: 17 };

const EMPTY: Record<string, any> = {};

/** Lua's `a or b` for values where 0 / "" must count as present. */
function present(v: unknown): boolean {
  return v != null && v !== false;
}

// Lua: ow_sprites.lua:10
function resetStream(): void {
  if (OwSprites._stream) OwSprites._stream.cancel();
  OwSprites._stream = OwSprites._cache ? makeStream() : undefined;
}

// Lua: ow_sprites.lua:32
function fieldBlock(): Record<string, any> {
  let row: any;
  try { row = Profile.forSession(); } catch { return EMPTY; }
  return (row && row.field) || EMPTY;
}

// Lua: ow_sprites.lua:38
function owRoot(): string {
  // Must follow Dataset.mountExtractRoots() — do not bake CACHE_ROOT at require.
  return (Extract.CACHE_ROOT || "data/generated/gba") + "/ow";
}

// Lua: ow_sprites.lua:43
function loadManifest(): void {
  OwSprites._manifestAttempted = true;
  const src = OwSprites._cache && OwSprites._cache.read(owRoot() + "/manifest.lua");
  const chunk = src != null ? luaLoad(src, "@ow/manifest.lua")[0] : undefined;
  OwSprites._manifest = (chunk && (chunk() as LuaTable)) || undefined;
}

// Lua: ow_sprites.lua:50
function resetPalettes(changed: boolean): void {
  if (changed) OwSprites._overrides = {};
  for (const [, o] of pairs<OwPaletteOverride>(OwSprites._overrides || {})) o.spr = undefined;
}

// Lua: ow_sprites.lua:84
function* uploadSprite(meta: any): Generator<unknown, any, unknown> {
  const image = G.newImage(meta.imageData);
  image.setFilter("nearest", "nearest");
  yield "texture";
  const w = meta.width, h = meta.height, n = meta.frameCount;
  const quads: Quad[] = [];
  for (let fi = 0; fi <= n - 1; fi++) {
    quads[fi] = G.newQuad(0, fi * h, w, h, w, h * n);
    if (fi % 32 === 31) yield "quads";
  }
  meta.image = image; meta.quads = quads;
  meta.bytes = undefined;
  return meta;
}

// Lua: ow_sprites.lua:98
function makeStream(): AssetStream {
  return Stream.new("sprite", OwSprites._cache, owRoot(), uploadSprite, (gid: any, spr: any) => {
    OwSprites._loaded[gid] = spr;
    if (!OwSprites._logged) {
      console.log(format("[game3/ow] sprites ready (%s sheets)",
        tostring((OwSprites._manifest && OwSprites._manifest.count) ?? "?")));
      OwSprites._logged = true;
    }
  });
}

// src/data/object_events/object_event_anims.h:633
const FIELD_MOVE_SEQ: LuaTable = seq(0, 4, 1, 4, 2, 4, 3, 4, 4, 8);
// src/data/object_events/object_event_anims.h:642
const VS_SEEKER_SEQ: LuaTable = seq(0, 4, 1, 4, 5, 4, 6, 4);
for (let _ = 1; _ <= 7; _++) {
  VS_SEEKER_SEQ[len(VS_SEEKER_SEQ) + 1] = 7; VS_SEEKER_SEQ[len(VS_SEEKER_SEQ) + 1] = 4;
  VS_SEEKER_SEQ[len(VS_SEEKER_SEQ) + 1] = 8; VS_SEEKER_SEQ[len(VS_SEEKER_SEQ) + 1] = 4;
}
for (const [, v] of ipairs<number>(seq(6, 4, 1, 4, 0, 4))) VS_SEEKER_SEQ[len(VS_SEEKER_SEQ) + 1] = v;
// src/data/object_events/object_event_anims.h:657
const VS_SEEKER_BIKE_SEQ: LuaTable = seq(0, 4, 1, 4, 2, 4, 3, 4);
for (let _ = 1; _ <= 7; _++) {
  VS_SEEKER_BIKE_SEQ[len(VS_SEEKER_BIKE_SEQ) + 1] = 4; VS_SEEKER_BIKE_SEQ[len(VS_SEEKER_BIKE_SEQ) + 1] = 4;
  VS_SEEKER_BIKE_SEQ[len(VS_SEEKER_BIKE_SEQ) + 1] = 5; VS_SEEKER_BIKE_SEQ[len(VS_SEEKER_BIKE_SEQ) + 1] = 4;
}
for (const [, v] of ipairs<number>(seq(3, 4, 2, 4, 1, 4, 0, 4))) VS_SEEKER_BIKE_SEQ[len(VS_SEEKER_BIKE_SEQ) + 1] = v;

// src/data/object_events/object_event_anims.h:877
const FISH_BASE: Record<string, number> = { down: 8, up: 4, left: 0, right: 0 };
const FISH_TAKE_OUT: LuaTable = seq(0, 4, 1, 4, 2, 4, 3, 4);
// src/data/object_events/object_event_anims.h:909
const FISH_PUT_AWAY_SN: LuaTable = seq(3, 4, 2, 6, 1, 6, 0, 6);
const FISH_PUT_AWAY_WE: LuaTable = seq(3, 4, 2, 4, 1, 4, 0, 4);
// src/data/object_events/object_event_anims.h:941
const FISH_HOOKED: LuaTable = seq(2, 6, 3, 6, 2, 6, 3, 6, 3, 30);

// Lua: ow_sprites.lua:148 -- [frame, ended]
function seqFrame(sq: LuaTable, tIn: unknown, loop?: boolean): [number, boolean] {
  let t = Math.max(0, Math.floor(tonumber(tIn) ?? 0));
  const n = len(sq);
  let total = 0;
  for (let i = 2; i <= n; i += 2) total = total + sq[i];
  if (loop && total > 0) t = t % total;
  let acc = 0;
  for (let i = 1; i <= n; i += 2) {
    acc = acc + sq[i + 1];
    if (t < acc) return [sq[i], false];
  }
  return [sq[n - 1], true];
}

// ------------------------------------------------ runtime palette substitution
// pret recolours field objects by loading a new palette into their OBJ palette
// slot (LoadPalette + ApplyGlobalFieldPaletteTint). The engine bakes palettes to
// RGBA at extract time, so an alternate palette is reproduced by substituting the
// sprite's opaque colours. Used by the Birth Island Deoxys rock.

// Lua: ow_sprites.lua:201
function to8(vIn: unknown): number {
  const v = Math.floor((tonumber(vIn) ?? 0) * 255 + 0.5);
  if (v < 0) return 0;
  if (v > 255) return 255;
  return v;
}

// How far (per channel) a baked sprite colour may sit from the palette entry it
// is meant to match before the swap gives up.  The rock ramp's entries are
// always tens of units apart, so this can never select the wrong colour.
const NEAREST_TOL = 4;

// Lua: ow_sprites.lua:216
/** Build a copy of `spr` with the colours in `from` replaced by `to`.
 *  Returns undefined when image data is unavailable or when not a single
 *  pixel matched (a silent no-op swap is always a bug). */
function recolour_sprite(spr: OwSheet | undefined, from: LuaTable, to: LuaTable): OwSheet | undefined {
  // love.image / love.graphics are always present here (see header).
  if (!(spr && spr.image)) return undefined;
  // LOVE 11 exposes no Image:newImageData, so recolour from the ImageData the
  // sheet was decoded from.  Clone it: mapPixel mutates in place and the cached
  // sprite has to keep its own colours for the next swap.
  let data: ImageData | undefined;
  if (spr.imageData) {
    try { data = spr.imageData.clone(); } catch { /* pcall */ }
  }
  if (!data) {
    try { data = (spr.image as any).newImageData(); } catch { /* pcall */ }
  }
  if (!data) return undefined;

  // Colour-keyed LUT so the per-pixel work stays a single table lookup.
  const lut: Record<number, LuaTable> = {};
  const sources: LuaTable = [null];
  const nFrom = len(from);
  for (let i = 1; i <= nFrom; i++) {
    const a = from[i], b = to[i];
    if (a && b) {
      lut[(a[1] * 65536) + (a[2] * 256) + a[3]] = b;
      sources[len(sources) + 1] = seq(a[1], a[2], a[3], b);
    }
  }
  if (isEmpty(lut)) return undefined;

  // Sprites are baked from 5-bit GBA channels, so a stored colour can sit a
  // unit or two away from the palette it was authored with.  Fall back to the
  // nearest source within NEAREST_TOL: the palette entries we swap between are
  // tens of units apart, so this cannot pick the wrong one.
  let replaced = 0;
  let okMap = true;
  try {
    data.mapPixel((_x, _y, r, g, b, a) => {
      if (a <= 0) return [r, g, b, a];
      const r8 = to8(r), g8 = to8(g), b8 = to8(b);
      let c = lut[(r8 * 65536) + (g8 * 256) + b8];
      if (!c) {
        let best: LuaTable, bestD: number | undefined;
        for (const [, e] of ipairs<LuaTable>(sources)) {
          const d = (e[1] - r8) ** 2 + (e[2] - g8) ** 2 + (e[3] - b8) ** 2;
          if (d <= NEAREST_TOL * NEAREST_TOL * 3 && (bestD == null || d < bestD)) {
            best = e[4]; bestD = d;
          }
        }
        c = best;
      }
      if (!c) return [r, g, b, a];
      replaced = replaced + 1;
      return [c[1] / 255, c[2] / 255, c[3] / 255, a];
    });
  } catch { okMap = false; }
  if (!okMap) return undefined;
  if (replaced === 0) {
    console.log(format(
      "[game3/ow] palette swap matched no pixels against %d source colour(s)",
      len(sources)));
    return undefined;
  }

  let img: Image | undefined;
  try { img = G.newImage(data); } catch { return undefined; }
  if (!img) return undefined;
  if (img.setFilter) img.setFilter("nearest", "nearest");

  const copy: OwSheet = Object.assign({}, spr);
  copy.image = img;
  copy.imageData = data;
  return copy;
}

// Lua: ow_sprites.lua:408
function paletteRgb(colors: unknown): LuaTable | undefined {
  if (colors == null || typeof colors !== "object") return undefined;
  const cs = colors as LuaTable;
  const out: LuaTable = [null];
  for (let i = 1; i <= 15; i++) {
    let c = cs[i];
    if (c == null) return undefined;
    c = tonumber(c) ?? 0;
    const r = c % 32;
    const g = Math.floor(c / 32) % 32;
    const b = Math.floor(c / 1024) % 32;
    out[len(out) + 1] = seq(
      Math.floor(r * 255 / 31 + 0.5),
      Math.floor(g * 255 / 31 + 0.5),
      Math.floor(b * 255 / 31 + 0.5),
    );
  }
  return out;
}

export const OwSprites = {
  _cache: undefined as any,
  _manifest: undefined as LuaTable | undefined,
  _manifestAttempted: false,
  _root: undefined as string | undefined,
  _stream: undefined as AssetStream | undefined,
  _loaded: {} as Record<number, OwSheet>, // [graphicsId] = { image, quads, w, h, frameCount, inanimate }
  _reflectionLoaded: {} as Record<number, OwSheet | false>,
  _logged: false,
  _overrides: {} as Record<number, OwPaletteOverride>, // [graphicsId] = { key = string, spr = sprite }

  // Lua: ow_sprites.lua:55
  install(cache: any): void {
    resetPalettes(OwSprites._cache !== cache || OwSprites._root !== owRoot());
    OwSprites._root = owRoot();
    OwSprites._cache = cache;
    OwSprites._loaded = {};
    resetStream();
    OwSprites._reflectionLoaded = {};
    OwSprites._manifest = undefined;
    OwSprites._logged = false;
    loadManifest();
  },

  // Lua: ow_sprites.lua:67
  invalidate(): void {
    resetPalettes(false);
    OwSprites._manifestAttempted = false;
    OwSprites._loaded = {};
    resetStream();
    OwSprites._reflectionLoaded = {};
    OwSprites._manifest = undefined;
    OwSprites._logged = false;
  },

  // Lua: ow_sprites.lua:77
  ready(): boolean {
    if (!Versions.OW_RENDER) return false;
    if (OwSprites._manifest) return true;
    const cache = OwSprites._cache;
    return OwExtract.ready(cache, Extract.CACHE_ROOT || "data/generated/gba");
  },

  // Lua: ow_sprites.lua:108
  prefetch(gidIn: unknown, priority?: number): void {
    const gid = tonumber(gidIn);
    if (gid != null && !OwSprites._loaded[gid] && OwSprites._stream) OwSprites._stream.prefetch(gid, priority);
  },

  // Lua: ow_sprites.lua:113
  get(graphicsIdIn: unknown): OwSheet | undefined {
    const graphicsId = tonumber(graphicsIdIn);
    if (graphicsId == null) return undefined;
    const cached = OwSprites._loaded[graphicsId];
    if (cached) return cached;
    if (!OwSprites._manifestAttempted) loadManifest();
    // s:get returns [value, err]; the Lua keeps the first value
    return (OwSprites._stream && OwSprites._stream.get(graphicsId)[0]) || undefined;
  },

  // Lua: ow_sprites.lua:161
  fieldMoveFrame(elapsed: unknown, kind?: string): number {
    let sq = FIELD_MOVE_SEQ;
    if (kind === "vs_seeker") sq = VS_SEEKER_SEQ;
    else if (kind === "vs_seeker_bike") sq = VS_SEEKER_BIKE_SEQ;
    return seqFrame(sq, elapsed)[0];
  },

  // Lua: ow_sprites.lua:168 -- [frameInGroup, ended]
  fishingFrame(facing: string, anim: string | undefined, t: unknown): [number, boolean] {
    if (anim === "hooked") {
      return seqFrame(FISH_HOOKED, t, true);
    } else if (anim === "putaway") {
      const sq = (facing === "left" || facing === "right") ? FISH_PUT_AWAY_WE : FISH_PUT_AWAY_SN;
      return seqFrame(sq, t);
    }
    return seqFrame(FISH_TAKE_OUT, t);
  },

  // Lua: ow_sprites.lua:178
  fishingAbsFrame(facing: string, frameInGroup: unknown): number {
    return (FISH_BASE[facing] ?? 8) + (tonumber(frameInGroup) ?? 3);
  },

  // Lua: ow_sprites.lua:183 -- [x2, y2]
  // src/field_player_avatar.c:1954 AlignFishingAnimationFrames
  fishingOffset(absFrame: number, facing: string): [number, number] {
    let x2 = 0, y2 = 0;
    if (absFrame === 1 || absFrame === 2 || absFrame === 3) {
      x2 = (facing === "left") ? -8 : 8;
    }
    if (absFrame === 5) y2 = -8;
    if (absFrame === 10 || absFrame === 11) y2 = 8;
    return [x2, y2];
  },

  // Lua: ow_sprites.lua:295
  /** Apply an alternate palette to every draw of `graphicsId`.
   *  `colours` are the new {r,g,b} values; `sourceColours` the ones they replace
   *  (defaults to the first rock palette, which is byte-identical to the
   *  meteorite's own palette). */
  setObjectPalette(graphicsIdIn: unknown, key: unknown, colours: LuaTable, sourceColours?: LuaTable): boolean {
    const graphicsId = tonumber(graphicsIdIn);
    if (graphicsId == null || typeof key !== "string") return false;
    const current = OwSprites._overrides[graphicsId];
    if (current && current.key === key && current.spr) return true;
    if (colours == null || typeof colours !== "object" || len(colours) === 0) return false;

    const base = OwSprites.get(graphicsId);
    if (!base) return false;
    let from = sourceColours;
    if (from == null || typeof from !== "object" || len(from) !== len(colours)) {
      // pcall(require, "src.core.game3.deoxys")
      const D: any = Deoxys;
      from = (D && D.ROCK_PALS && D.ROCK_PALS[1]) || undefined;
    }
    const spr = recolour_sprite(base, from, colours);
    if (!spr) return false;
    OwSprites._overrides[graphicsId] = { key, spr, colours, sourceColours: from };
    return true;
  },

  // Lua: ow_sprites.lua:315
  clearObjectPalette(graphicsIdIn: unknown): boolean {
    const graphicsId = tonumber(graphicsIdIn);
    if (graphicsId == null) return false;
    if (OwSprites._overrides[graphicsId] == null) return false;
    delete OwSprites._overrides[graphicsId];
    return true;
  },

  // Lua: ow_sprites.lua:323
  objectPaletteKey(graphicsId: unknown): string | undefined {
    const o = OwSprites._overrides[tonumber(graphicsId) ?? -1];
    return o ? o.key : undefined;
  },

  // Lua: ow_sprites.lua:331 -- [frame, flip]
  /** Resolve frame index + hflip for facing / walk.
   *  opts: { bow = bool, fieldMove = bool, frame = number } */
  pose(spr: OwSheet | undefined, facingIn: string | undefined, walkPhase: unknown, stepFlip: unknown,
    opts?: OwPoseOpts | null): [number, boolean] {
    const facing = facingIn ?? "down";
    if (!spr) return [0, false];

    const flip = (facing === "right");
    if (opts && opts.frame != null) {
      let f = tonumber(opts.frame) ?? 0;
      if (f < 0) f = 0;
      if (f >= spr.frameCount) f = spr.frameCount - 1;
      return [f, flip];
    }

    if (spr.frameCount <= 1 || spr.inanimate) {
      return [0, false];
    }

    if (opts && opts.bow && spr.frameCount > 9) {
      return [9, false];
    }

    if (opts && opts.fishing && spr.frameCount >= 12) {
      const g = Math.max(0, Math.min(3, tonumber(opts.fishFrame) ?? 3));
      return [OwSprites.fishingAbsFrame(facing, g), flip];
    }

    if (opts && opts.fieldMove && spr.frameCount >= 6) {
      let f = tonumber(opts.fieldMoveFrame) ?? 4;
      if (f >= spr.frameCount) f = 0;
      return [f, false];
    }

    if (opts && opts.running != null && spr.frameCount >= 18) {
      const runFrames = fieldBlock().runFrames;
      if (runFrames) {
        const phase = runFrames[opts.running === 1 ? 2 : 1];
        const set = phase && (present(stepFlip) ? phase.a : phase.b);
        const f = set && set[facing];
        if (f != null && f !== false) return [f, flip];
      }
      if (opts.running === 1) {
        return [(present(stepFlip) ? RUN_A[facing] : RUN_B[facing]) ?? RUN_BASE[facing] ?? 9, flip];
      }
      return [RUN_BASE[facing] ?? 9, flip];
    }

    if (spr.frameCount === 3) {
      // Surfing mount pose (0 = down, 1 = up, 2 = left, 2 + hflip = right)
      let f = STAND[facing] ?? 0;
      if (f >= spr.frameCount) f = 0;
      return [f, flip];
    }

    const walking = walkPhase === 1 || walkPhase === true;
    let frame: number;
    if (walking && spr.frameCount >= 9) {
      frame = (present(stepFlip) ? WALK_A[facing] : WALK_B[facing]) ?? STAND[facing] ?? 0;
    } else {
      frame = STAND[facing] ?? 0;
    }
    if (frame >= spr.frameCount) frame = Math.min(STAND[facing] ?? 0, spr.frameCount - 1);
    return [frame, flip];
  },

  // Lua: ow_sprites.lua:396
  /** The sprite actually drawn for `graphicsId`: the palette override when one is
   *  active, otherwise the base sprite. */
  getDraw(graphicsIdIn: unknown): OwSheet | undefined {
    const graphicsId = tonumber(graphicsIdIn);
    if (graphicsId == null) return undefined;
    let ov = OwSprites._overrides && OwSprites._overrides[graphicsId];
    if (ov && !ov.spr) {
      OwSprites.setObjectPalette(graphicsId, ov.key, ov.colours, ov.sourceColours);
      ov = OwSprites._overrides[graphicsId];
    }
    if (ov && ov.spr) return ov.spr;
    return OwSprites.get(graphicsId);
  },

  // Lua: ow_sprites.lua:427
  getReflectionDraw(graphicsIdIn: unknown): OwSheet | undefined {
    const graphicsId = tonumber(graphicsIdIn);
    if (graphicsId == null) return undefined;
    const cached = OwSprites._reflectionLoaded[graphicsId];
    if (cached != null) return cached || undefined;
    const base = OwSprites.get(graphicsId);
    if (!base || !present(base.reflectionPaletteMappedTag)) {
      OwSprites._reflectionLoaded[graphicsId] = false;
      return undefined;
    }
    const from = paletteRgb(base.palette);
    const to = paletteRgb(base.mappedReflectionPalette);
    if (!(from && to)) {
      OwSprites._reflectionLoaded[graphicsId] = false;
      return undefined;
    }
    const reflected = recolour_sprite(base, from, to);
    OwSprites._reflectionLoaded[graphicsId] = reflected || false;
    return reflected;
  },

  // Lua: ow_sprites.lua:452
  /** Draw at world pixel position (cell top-left). Feet at bottom of sprite.
   *  opts.bow: use nurse bow frame (ANIM_NURSE_BOW).
   *  opts.fieldMove: use the arm-raise field move frame (opts.fieldMoveFrame).
   *  opts.frame: explicit frame index override. */
  draw(graphicsId: unknown, px: number, py: number, camX: number, camY: number, facing: string | undefined,
    walkPhase: unknown, stepFlip: unknown, opts?: OwPoseOpts | null): boolean {
    const spr = OwSprites.getDraw(graphicsId);
    if (!spr) return false;
    const [frame, flip] = OwSprites.pose(spr, facing, walkPhase, stepFlip, opts);
    const q = spr.quads![frame];
    if (!q) return false;
    const sx = px - camX + (16 - spr.width) / 2;
    const sy = py - camY + 16 - spr.height;
    const hasAlpha = !!opts && present(opts.alpha);
    G.setColor(1, 1, 1, hasAlpha ? opts!.alpha! : 1);
    if (flip) {
      G.draw(spr.image!, q, sx + spr.width, sy, 0, -1, 1);
    } else {
      G.draw(spr.image!, q, sx, sy);
    }
    if (hasAlpha) G.setColor(1, 1, 1, 1);
    return true;
  },

  // Lua: ow_sprites.lua:470
  avatars(): LuaTable | undefined {
    if (!OwSprites._manifestAttempted && OwSprites._cache) loadManifest();
    const m = OwSprites._manifest;
    return m ? (m.avatars ?? undefined) : undefined;
  },

  // Lua: ow_sprites.lua:477
  // pokeemerald/src/field_player_avatar.c:1256
  avatarState(P: any): string {
    if (!P) return "NORMAL";
    if (P.fieldMoveAnim && P.fieldMoveAnim > 0) return "FIELD_MOVE";
    if (present(P.underwater)) return "UNDERWATER";
    if ((present(P.surfing) && !present(P.dismounting)) || present(P.flyRide)) return "SURFING";
    if (present(P.biking)) return P.bikeType === "acro" ? "ACRO_BIKE" : "MACH_BIKE";
    if (present(P.fishing)) return "FISHING";
    if (present(P.watering)) return "WATERING";
    return "NORMAL";
  },

  // Lua: ow_sprites.lua:489
  // pokeemerald/src/field_player_avatar.c:1241
  avatarGraphicsId(state: string, isFemale: unknown, avatarsIn?: LuaTable, who?: string): number | undefined {
    const avatars = avatarsIn || OwSprites.avatars();
    const rows = avatars && avatars[who || "player"];
    if (rows == null || typeof rows !== "object") return undefined;
    const key = present(isFemale) ? "female" : "male";
    let normal: number | undefined;
    for (const [, row] of ipairs<any>(rows)) {
      if (row.state === state) return row[key];
      if (row.state === "NORMAL") normal = row[key];
    }
    return normal;
  },

  // Lua: ow_sprites.lua:502
  playerGraphicsId(game: any, player?: any): number | undefined {
    // package.loaded["src.core.game3.player"]
    const P: any = player || PlayerMod;
    const save = game && game.save;
    const session = game && game.session;
    let gender: any = session ? session.gender : undefined;
    if (!present(gender) && save) {
      gender = present(save.gender) ? save.gender : (save.player ? save.player.gender : undefined);
    }
    const isFemale = (gender === "female" || gender === "F" || gender === 1);

    const avatars = OwSprites.avatars();
    if (avatars) {
      return OwSprites.avatarGraphicsId(OwSprites.avatarState(P), isFemale, avatars);
    }

    if (P) {
      if (P.fieldMoveAnim && P.fieldMoveAnim > 0) {
        if (P.fieldMoveKind === "vs_seeker_bike") {
          // src/field_player_avatar.c:1331
          return isFemale ? (Versions.OW_PLAYER_FEMALE_VS_SEEKER_BIKE ?? 13)
            : (Versions.OW_PLAYER_MALE_VS_SEEKER_BIKE ?? 6);
        }
        return isFemale ? (Versions.OW_PLAYER_FEMALE_FIELD_MOVE ?? 10)
          : (Versions.OW_PLAYER_MALE_FIELD_MOVE ?? 3);
      }
      // If jumping / hop onto/off water, maintain normal or surfing sprite during arc
      // pokefirered/src/field_effect.c:3294
      if ((present(P.surfing) && !present(P.dismounting)) || present(P.flyRide)) {
        return isFemale ? (Versions.OW_PLAYER_FEMALE_SURF ?? 9)
          : (Versions.OW_PLAYER_MALE_SURF ?? 2);
      }
      if (present(P.biking)) {
        return isFemale ? (Versions.OW_PLAYER_FEMALE_BIKE ?? 8)
          : (Versions.OW_PLAYER_MALE_BIKE ?? 1);
      }
      if (present(P.fishing)) {
        return isFemale ? (Versions.OW_PLAYER_FEMALE_FISH ?? 11)
          : (Versions.OW_PLAYER_MALE_FISH ?? 4);
      }
    }

    if (isFemale) {
      return Versions.OW_PLAYER_FEMALE ?? 7;
    }
    return Versions.OW_PLAYER_MALE ?? 0;
  },
};

export default OwSprites;
