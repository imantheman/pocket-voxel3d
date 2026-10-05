// Port of gen1recomp src/core/game3/field_view.lua (GPLv3 + additional terms; see LICENSE.md).
// Game3 native field renderer (FRLG 240×160, 1:1 world pixels).
// Owns tile palette blits + OW sprites. Does NOT call World:draw / Zoom / Chrome.
//
// Port notes:
// - getMod / package.loaded / require: modules this runtime has (ported or
//   still stubbed) are imported and treated as loaded, as in runtime.ts.
//   Brian's lazily required modules with no file here (field_weather,
//   pokecenter_heal, ss_anne_cutscene, field_weather_rse, field_effects_rse,
//   src.render.SpriteRenderer, src.render.GbcPalette, src.world.gen2.Palettes)
//   are looked up in G3Lazy (runtime.ts) by Lua module name and read as
//   absent until a port registers there: Brian's failed-require path.
// - Lua multiple returns are tuples: resolveTileset -> [tileset, tsId];
//   playerPixels -> [px, py, facing, walkPhase, stepFlip, p, yOff, xOff];
//   applyDrawOrder / collectGame3Actors -> [under, over]; screenAnchor -> [x, y].
// - Actor lists, free lists, dirty-cell lists, flash spans and Map.world are
//   Lua sequences (lt.ts). The native batch stores are plain objects keyed by
//   pair / "void|pair"; the visible-cell grid is an object keyed by cell y,
//   then x (integer keys, possibly negative).
// - Per-frame loops index sequences directly (`for i = 1; t[i] != null`) and
//   walk the stores with for...in rather than the ipairs/pairs generators, so
//   the frame does not allocate where Brian's does not.

import { G } from "../platform/graphics.ts";
import type { Image, Quad, SpriteBatch } from "../platform/image.ts";
import { len, pairs, remove, sort, type LuaTable } from "../platform/lt.ts";
import { mod, tonumber, tostring, truthy } from "../../../import/gen3/lua.ts";
import { Versions } from "../../../import/gen3/versions.ts";
import { GfxIds } from "./scripting/gfx_ids.ts";
import { FieldModules } from "./field_modules.ts";
import { Sem } from "./field_semantics.ts";
import { Objects as ObjectsMod } from "./objects.ts";
import { OwSprites as OwSpritesMod } from "./ow_sprites.ts";
import { NativeTileset as NativeTilesetMod } from "./tileset_native.ts";
import { FieldEffects as FieldEffectsMod } from "./field_effects.ts";
import { Flags as FlagsMod } from "./scripting/flags.ts";
import { Doors as DoorsMod } from "./doors.ts";
import { Assets as AssetsMod } from "../shared/render/Assets.ts";
import { Player as PlayerMod } from "./player.ts";
import { Seagallop as SeagallopMod } from "../ui/seagallop.ts";
import { ShopMenu as ShopMenuMod } from "../ui/shop_menu.ts";
import { Follower as FollowerMod } from "../world/Follower.ts";
import { Runtime as RuntimeMod } from "./runtime.ts";
import { G3Lazy } from "./lazy_registry.ts";
import { Space as SpaceMod } from "./scripting/space.ts";
import { Map as MapMod } from "./map.ts";
import { Ghosts as GhostsMod } from "./ghosts.ts";
import { Warp as WarpMod } from "./warp.ts";
import { SpecialFieldAnim as SpecialFieldAnimMod } from "./special_field_anim.ts";
import { Field as FieldMod } from "./field.ts";
import { VoidFill } from "./void_fill.ts";
import { Plan as CellPlanMod } from "./field_plan.ts";
import { TilesetAnim as TilesetAnimMod } from "./tileset_anim.ts";
import { Profile } from "./profile.ts";
import { Tilt as TiltMod } from "../shared/render/Tilt.ts";
import { Display } from "./display.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

interface NativeSprite { key: string; index: number; quad: Quad }
interface NativeCell { pair: string; draw: boolean; key?: string; under?: NativeSprite; over?: NativeSprite }
type BatchStore = Record<string, SpriteBatch>;
type CellGrid = Record<number, Record<number, NativeCell>>;
interface VoidFrom {
  under: BatchStore; over: BatchStore;
  bx: number; by: number; dx: number; dy: number; t: number;
}
interface FlashSpan { y: number; height: number; left: number; right: number }
/** [px, py, facing, walkPhase, stepFlip, playerObj, yOff, xOff] */
type PlayerPix = [number, number, string, any, boolean, any, number, number];

export interface DrawOpts {
  billboard?: boolean;
  actorsOnly?: boolean;
  skipActors?: boolean;
  exchangeCanvas?: any;
  /** pocket-voxel: the 3DS host draws the field as its voxel world (display.ts
   *  WORLD3D_OPTS): keep the bookkeeping, collect the actors into
   *  FieldView._worldActors, draw nothing. */
  world3d?: boolean;
}

/** pocket-voxel: what FieldView.draw left for the voxel world (platform/worldview.ts). */
export interface WorldFrame {
  /** The frame's actors, under then over, as drawSingleActor would get them. */
  actors: any[];
  /** The view's centre in map px (the camera, pans included). */
  camX: number;
  camY: number;
  /** The player's map px (cell origin) and the map drawn. */
  px: number;
  py: number;
  mapId: any;
}

export interface FieldViewModule {
  _atlas: Image | undefined;
  _atlasPath: string | undefined;
  _quads: Record<number, Quad>;
  _tilesPerRow: number;
  _blockTiles: LuaTable | undefined;
  _tilePalettes: LuaTable | undefined; // [tileId+1] = BG slot 1..8
  _spriteCache: Record<string, any>; // key → SpriteRenderer
  _logged: boolean;
  _loggedPal: boolean;
  _nativeBatch: any;
  _nativeBatches: BatchStore | undefined;
  _nativeOverBatches: BatchStore | undefined;
  _nativeBx: number | undefined;
  _nativeBy: number | undefined;
  _nativeBaseBx: number | undefined;
  _nativeBaseBy: number | undefined;
  _nativeViewCols: number | undefined;
  _nativeViewRows: number | undefined;
  _nativeVisibleCells: CellGrid | undefined;
  _nativeVisiblePairs: Record<string, boolean> | undefined;
  _nativeFreeUnder: Record<string, LuaTable> | undefined;
  _nativeFreeOver: Record<string, LuaTable> | undefined;
  _nativeSpriteSlots: number;
  _nativePair: string | undefined;
  _nativeDirty: boolean;
  _nativeDirtyCells: LuaTable | undefined;
  _nativeLayout: any;
  _nativeVoid: string | undefined;
  _nativeSwap: boolean | undefined;
  _nativeResetting: boolean | undefined;
  _nativeOverOx: number;
  _nativeOverOy: number;
  _nativeOverPair: string | undefined;
  _nativeCamX: number | undefined;
  _nativeCamY: number | undefined;
  _cellPreparationRoute: string | undefined;
  _loggedNative: boolean;
  _loggedNativeFallback: boolean;
  _voidMapDef: any;
  _voidFrom: VoidFrom | undefined;
  _lastCamX: number | undefined;
  _lastCamY: number | undefined;
  _billboard: { vw: number; vh: number } | undefined;
  _viewW: number | undefined;
  _viewH: number | undefined;
  _bgPalOverride: { pair: string; slot: any } | undefined;
  hideActors: boolean | undefined;
  /** pocket-voxel: the last world3d draw's frame (DrawOpts.world3d). */
  _worldFrame: WorldFrame | undefined;

  MAX_FLASH_LEVEL: number;
  flashLevel: number;
  cameraPanX: number;
  cameraPanY: number;
  _flashRadius: number | undefined;
  _flashMapId: any;
  _flashSpans: LuaTable | undefined;
  _flashSpanR: number | undefined;
  _flashSpanCX: number | undefined;
  _flashSpanCY: number | undefined;
  _flashSpanW: number | undefined;
  _flashSpanH: number | undefined;
  VOID_FADE_FRAMES: number;

  applyDrawOrder(actors: LuaTable, underActors?: LuaTable, overActors?: LuaTable, camY?: number): [LuaTable, LuaTable];
  flashRadii(): Record<number, number>;
  invalidateCell(x: unknown, y: unknown, layout?: unknown): void;
  invalidateLayoutCell(layout: unknown, x: unknown, y: unknown): void;
  maxFlashLevel(): number;
  radiusForLevel(level: unknown): number;
  setFlashLevel(level: unknown): void;
  getFlashLevel(): number;
  setFlashRadius(radius: unknown): void;
  animateFlashLevel(fromLevel: unknown, toLevel: unknown): any;
  flashRadius(): number | undefined;
  setCameraPanning(x: unknown, y: unknown): void;
  defaultFlashLevel(game: any, mapId: any): number;
  setPyramidLightRadius(radius: unknown): void;
  setBgPaletteOverride(slot: any, pal16: any): boolean;
  setDefaultFlashLevel(game: any, mapId: any): number;
  flashSpans(radius: number, w?: number, h?: number, centerX?: number, centerY?: number): LuaTable;
  flashSpansFor(radius: number, w: number, h: number, cx: number, cy: number): LuaTable;
  draw(game: any, canvasW?: number, canvasH?: number, opts?: DrawOpts): void;
  invalidate(): void;

  [k: string]: any;
}

// port helper: Lua `a or b` (nil and false are false; 0 and "" are true)
function lor(a: any, b: any): any {
  return a != null && a !== false ? a : b;
}

// port helper: type(v) == "table"
function isTable(v: unknown): boolean {
  return v != null && typeof v === "object";
}

// port helper: next(t) == nil, for the plain-object stores and grids (no generator)
function emptyObj(o: object): boolean {
  for (const _ in o) return false;
  return true;
}

// port helper: for i = #t, 1, -1 do t[i] = nil end (an array sequence is truncated
// to its unused slot 0, so the next len() is O(1))
function clearSeq(t: LuaTable): void {
  if (Array.isArray(t)) {
    t.length = 1;
    t[0] = null;
    return;
  }
  for (let i = len(t); i >= 1; i--) t[i] = null;
}

export const FieldView = {
  _atlas: undefined,
  _atlasPath: undefined,
  _quads: {},
  _tilesPerRow: 16,
  _blockTiles: undefined,
  _tilePalettes: undefined,
  _spriteCache: {},
  _logged: false,
  _loggedPal: false,
  _nativeBatch: undefined,
  _nativeBatches: undefined,
  _nativeOverBatches: undefined,
  _nativeBx: undefined,
  _nativeBy: undefined,
  _nativeBaseBx: undefined,
  _nativeBaseBy: undefined,
  _nativeViewCols: undefined,
  _nativeViewRows: undefined,
  _nativeVisibleCells: undefined,
  _nativeFreeUnder: undefined,
  _nativeFreeOver: undefined,
  _nativeSpriteSlots: 0,
  _nativePair: undefined,
  _nativeDirty: true,
  _nativeOverOx: 0,
  _nativeOverOy: 0,
  _nativeOverPair: undefined,
  _loggedNative: false,
  _loggedNativeFallback: false,
} as unknown as FieldViewModule;

// pokefirered/src/field_screen_effect.c:18
const FLASH_LEVEL_RADIUS: Record<number, number> = { 0: 200, 1: 72, 2: 56, 3: 40, 4: 24 };

FieldView.MAX_FLASH_LEVEL = 4;
FieldView.flashLevel = 0;
FieldView.cameraPanX = 0;
FieldView.cameraPanY = 0;
FieldView._flashRadius = undefined;
FieldView._flashMapId = undefined;
FieldView._flashSpans = undefined;
FieldView._flashSpanR = undefined;
FieldView._flashSpanCX = undefined;
FieldView._flashSpanCY = undefined;
FieldView._flashSpanW = undefined;
FieldView._flashSpanH = undefined;

const CELL = 16;
const BLOCK = 32;

// pokefirered/src/event_object_movement.c:4992
const PLAYER_SCREEN_X = 112;
// pokefirered/src/field_camera.c:527
const PLAYER_SCREEN_Y = 72;

// Lua: field_view.lua:66 -- [x, y]
function screenAnchor(px: number, py: number, camX: number, camY: number): [number, number] {
  return [(px - camX) - PLAYER_SCREEN_X, (py - camY) - PLAYER_SCREEN_Y];
}

// Lua: field_view.lua:71
// Brian's package.loaded / pcall(require) cache, for the modules with no file
// here: G3Lazy[path] (runtime.ts), absent until a port registers there. The
// modules the runtime has are imported (the mod* functions below).
const _M: Record<string, any> = {};
function getMod(key: string, path: string): any {
  let m = _M[key];
  if (!m) {
    m = G3Lazy[path];
    _M[key] = m;
  }
  return m;
}

// Lua: field_view.lua:84
function modObjects(): any { return ObjectsMod; }
// Lua: field_view.lua:85
function modOwSprites(): any { return OwSpritesMod; }
// Lua: field_view.lua:86
function modNativeTileset(): any { return NativeTilesetMod; }
// Lua: field_view.lua:87
function modFieldEffects(): any { return FieldEffectsMod; }
// Lua: field_view.lua:88 (no SpriteRenderer module in the gen3 runtime)
function modSpriteRenderer(): any { return getMod("SpriteRenderer", "src.render.SpriteRenderer"); }
// Lua: field_view.lua:89 (no Gen 2 Palettes module in the gen3 runtime)
function modPalettes(): any { return getMod("Palettes", "src.world.gen2.Palettes"); }
// Lua: field_view.lua:90
function modFlags(): any { return FlagsMod; }
// Lua: field_view.lua:91
function modDoors(): any { return DoorsMod; }
// Lua: field_view.lua:92 (no pokecenter_heal module here yet)
function modHeal(): any { return getMod("Heal", "src.core.game3.pokecenter_heal"); }
// Lua: field_view.lua:93 (no ss_anne_cutscene module here yet)
function modSSAnne(): any {
  if (!FieldModules.enabled("ssAnne")) return undefined;
  return getMod("SSAnne", "src.core.game3.ss_anne_cutscene");
}
// Lua: field_view.lua:97 (no field_weather module here yet)
function modFieldWeather(): any { return getMod("FieldWeather", "src.core.game3.field_weather"); }
// Lua: field_view.lua:98
function modAssets(): any { return AssetsMod; }
// Lua: field_view.lua:99
function modPlayer(): any { return PlayerMod; }
// Lua: field_view.lua:100 (no GbcPalette module in the gen3 runtime)
function modGbcPalette(): any { return getMod("GbcPalette", "src.render.GbcPalette"); }
// Lua: field_view.lua:101
function modSeagallop(): any { return SeagallopMod; }
// Lua: field_view.lua:102
function modShopMenu(): any { return ShopMenuMod; }
// Lua: field_view.lua:103
function modFollower(): any { return FollowerMod; }

// Lua: field_view.lua:105
function log(msg: unknown): void {
  console.log("[game3/field] " + tostring(msg));
}

// Lua: field_view.lua:109
function resolveMapDef(game: any, mapId: any): any {
  if (!truthy(mapId)) return undefined;
  const data = game && game.data;
  return data && data.maps && data.maps[mapId];
}

// Lua: field_view.lua:115 -- [tileset, tsId]
function resolveTileset(game: any, mapDef: any): [any, any] {
  if (!mapDef) return [undefined, undefined];
  const V: any = Versions;
  let tsId = mapDef.tileset;
  if (!truthy(tsId) && truthy(mapDef.pair) && V.PAIR_TILESET) {
    tsId = V.PAIR_TILESET[mapDef.pair];
  }
  const data = game && game.data;
  const sets = data && lor(data.tilesets, data.gen2Tilesets);
  return [truthy(tsId) && sets ? sets[tsId] : undefined, tsId];
}

// Lua: field_view.lua:126
function loadAtlas(tileset: any): Image | undefined {
  if (!tileset || !truthy(tileset.image)) return undefined;
  const path = tileset.image;
  if (FieldView._atlas && FieldView._atlasPath === path) {
    FieldView._blockTiles = tileset.blocks;
    FieldView._tilePalettes = tileset.tilePalettes;
    FieldView._tilesPerRow = lor(tileset.tilesPerRow, FieldView._tilesPerRow);
    return FieldView._atlas;
  }
  let img: any;
  const Assets = modAssets();
  if (Assets && Assets.image) {
    try {
      img = Assets.image(path);
    } catch {
      img = undefined;
    }
  }
  if (!img) {
    try {
      img = G.newImage(path);
    } catch {
      img = undefined;
    }
  }
  if (!img) {
    log("atlas load failed: " + tostring(path));
    return undefined;
  }
  if (img.setFilter) img.setFilter("nearest", "nearest");
  FieldView._atlas = img;
  FieldView._atlasPath = path;
  FieldView._quads = {};
  FieldView._tilesPerRow = lor(tileset.tilesPerRow, 16);
  FieldView._blockTiles = tileset.blocks;
  FieldView._tilePalettes = tileset.tilePalettes;
  if (!FieldView._logged) {
    log("native atlas ready path=" + tostring(path)
      + " tilesPerRow=" + tostring(FieldView._tilesPerRow)
      + " hasTilePalettes=" + tostring(FieldView._tilePalettes != null));
    FieldView._logged = true;
  }
  return img;
}

// Lua: field_view.lua:165
function quadFor(tile: number): Quad | undefined {
  let q = FieldView._quads[tile];
  if (q) return q;
  const atlas = FieldView._atlas;
  if (!atlas) return undefined;
  const per = FieldView._tilesPerRow;
  const sx = mod(tile, per) * 8;
  const sy = Math.floor(tile / per) * 8;
  const [aw, ah] = atlas.getDimensions();
  q = G.newQuad(sx, sy, 8, 8, aw, ah);
  FieldView._quads[tile] = q;
  return q;
}

// Lua: field_view.lua:178
function blockIdAt(mapDef: any, bx: number, by: number): number {
  const w = lor(mapDef.width, 0);
  const h = lor(mapDef.height, 0);
  const blocks = mapDef.blocks;
  if (!blocks || w < 1) return lor(mapDef.borderBlock, 0);
  if (bx < 0 || by < 0 || bx >= w || by >= h) {
    return lor(mapDef.borderBlock, 0);
  }
  return lor(blocks[by * w + bx + 1], 0);
}

// Lua: field_view.lua:190
/** Resolve Sevii special BG palette set (8 slots × 4 RGB). */
function resolveBgSet(game: any, mapDef: any, daytime: any): any {
  const Palettes = modPalettes();
  if (!Palettes) return undefined;
  const data = game && game.data;
  const pals = data && lor(data.gen2Palettes, data.palettes);
  if (!pals) return undefined;
  // Sevii uses specialTilesets[SEVII_*]; prefer specialSet (does not need bg pool).
  if (Palettes.specialSet) {
    const set = Palettes.specialSet(pals, mapDef);
    if (set) return set;
  }
  if (Palettes.bgSet) {
    return Palettes.bgSet(pals, mapDef, lor(daytime, "DAY"));
  }
  return undefined;
}

// Lua: field_view.lua:207
function currentMapId(game: any): any {
  const Runtime: any = RuntimeMod; // package.loaded["src.core.game3.runtime"]
  const session = Runtime && Runtime.getSession && Runtime.getSession();
  if (session && truthy(session.map)) return session.map;
  const world = game && lor(game.overworld, game.world);
  if (world && world.map && truthy(world.map.id)) return world.map.id;
  const pos = game && game.save && game.save.position;
  return pos ? pos.map : undefined;
}

// Lua: field_view.lua:217 -- [px, py, facing, walkPhase, stepFlip, p, yOff, xOff]
function playerPixels(game: any): PlayerPix {
  // Game3 avatar is source of truth while Runtime is active.
  const G3Player = modPlayer();
  const Runtime: any = RuntimeMod; // package.loaded["src.core.game3.runtime"]
  if (G3Player && Runtime && Runtime.isActive && Runtime.isActive()) {
    const xOff = lor(G3Player.spriteXOffset, 0);
    let yOff = lor(G3Player.spriteYOffset, 0);
    if (yOff === 0 && G3Player.jumpSpriteY) {
      yOff = lor(G3Player.jumpSpriteY(), 0);
    }
    return [G3Player.px, G3Player.py, lor(G3Player.facing, "down"),
      G3Player.walkPhase(), G3Player.drawFlip(), G3Player, yOff, xOff];
  }
  const session = Runtime && Runtime.getSession && Runtime.getSession();
  const world = game && lor(game.overworld, game.world);
  const p = world && world.player;
  if (p) {
    let px = tonumber(p.px);
    let py = tonumber(p.py);
    if (px == null) px = lor(tonumber(lor(p.cellX, p.x)), 0) * CELL;
    if (py == null) py = lor(tonumber(lor(p.cellY, p.y)), 0) * CELL;
    const facing = lor(p.facing, "down");
    let walkPhase: any = 0;
    if (typeof p.walkPhase === "function") {
      walkPhase = lor(p.walkPhase(), 0);
    } else {
      walkPhase = lor(p.movePhase, lor(p.walkPhase, 0));
    }
    let stepFlip = false;
    if (typeof p.drawFlip === "function") {
      stepFlip = truthy(p.drawFlip());
    } else {
      stepFlip = truthy(p.stepFlip);
    }
    return [px!, py!, facing, walkPhase, stepFlip, p, lor(p.spriteYOffset, 0), lor(p.spriteXOffset, 0)];
  }
  if (session) {
    const cx = lor(session.x, 0), cy = lor(session.y, 0);
    return [cx * CELL, cy * CELL, lor(session.facing, "down"), 0, false, undefined, 0, 0];
  }
  return [0, 0, "down", 0, false, undefined, 0, 0];
}

// Lua: field_view.lua:260
function facingFromObj(obj: any): string {
  const r = tostring(lor(obj.facing, lor(obj.range, "DOWN"))).toLowerCase();
  if (r === "up" || r === "down" || r === "left" || r === "right") {
    return r;
  }
  return "down";
}

// Lua: field_view.lua:268
function spriteNameForObj(obj: any): any {
  if (typeof obj.sprite === "string" && obj.sprite !== "") {
    return obj.sprite;
  }
  const g = lor(obj.graphics, obj.graphicsId);
  return GfxIds.spriteFor(g);
}

// Lua: field_view.lua:276
function playerSpriteName(game: any): string {
  const save = game && game.save;
  const session = game && game.session;
  const gender = lor(session && session.gender,
    save && lor(save.gender, save.player && save.player.gender));
  if (gender === "female" || gender === "F" || gender === 1) {
    return "SPRITE_KRIS";
  }
  return "SPRITE_CHRIS";
}

// Lua: field_view.lua:287
function palettes(): any {
  return modPalettes();
}

// Lua: field_view.lua:291
function daytimeFor(game: any, mapDef: any): any {
  const world = game && lor(game.overworld, game.world);
  if (world && truthy(world.daytime)) return world.daytime;
  const Palettes = palettes();
  if (Palettes && Palettes.daytimeFor && world && truthy(world.hour)) {
    const hour = typeof world.hour === "function" ? lor(world.hour(), 12) : 12;
    return Palettes.daytimeFor(mapDef, hour, world.flashUsed);
  }
  return "DAY";
}

// Lua: field_view.lua:302
function getSpriteRenderer(game: any, spriteName: any, seed: any, objDef: any, daytime: any): any {
  const palKey = tostring(lor(daytime, "DAY"));
  const key = tostring(spriteName) + ":" + tostring(seed) + ":" + palKey;
  const cached = FieldView._spriteCache[key];
  if (cached) return cached;

  const data = game && game.data;
  const sprites = data && lor(data.gen2Sprites, data.sprites);
  const def = sprites && sprites[spriteName];
  if (!def || !truthy(def.image)) {
    return undefined;
  }

  const SpriteRenderer = modSpriteRenderer();
  if (!SpriteRenderer) return undefined;
  const sr = SpriteRenderer.new(def, lor(seed, spriteName));

  const Palettes = modPalettes();
  const pals = data && lor(data.gen2Palettes, data.palettes);
  if (Palettes && pals && sr.setObjPalette) {
    const colors = Palettes.spritePalette(pals, lor(daytime, "DAY"), def, objDef);
    if (colors) {
      const id = lor(lor(Palettes.objectPaletteId && Palettes.objectPaletteId(objDef), def.paletteId), spriteName);
      sr.setObjPalette(colors, "game3:" + palKey + ":" + tostring(id));
    }
  }

  FieldView._spriteCache[key] = sr;
  return sr;
}

// Lua: field_view.lua:334
function objectVisible(obj: any): boolean {
  const flag = obj.flag;
  if (!truthy(flag) || flag === 0) return true;
  const Space: any = SpaceMod; // package.loaded["src.core.game3.scripting.space"]
  if (Space && Space.objectVisible) {
    return Space.objectVisible(obj);
  }
  return true;
}

// Lua: field_view.lua:344
function neighborActorDefs(mapId: any, def: any): LuaTable | undefined {
  const Space: any = SpaceMod; // package.loaded["src.core.game3.scripting.space"]
  const ev = Space && Space.bundle && Space.bundle.events
    && Space.bundle.events[mapId];
  let defs = ev && lor(ev.objects, ev.objectEvents);
  if (!isTable(defs)) defs = def && def.objects;
  return isTable(defs) ? defs : undefined;
}

// setmetatable({}, { __mode = "k" })
const ghostActors = new WeakMap<object, any>();
const ACTOR_CULL_MARGIN = 64;

// Lua: field_view.lua:356
function entryInView(entry: any, x0: number, y0: number, x1: number, y1: number): boolean {
  const L = entry.def && entry.def.midLayout;
  const w = lor(L && L.width, lor(tonumber(entry.def && entry.def.width), 0) * 2);
  const h = lor(L && L.height, lor(tonumber(entry.def && entry.def.height), 0) * 2);
  const ex = entry.ox * CELL, ey = entry.oy * CELL;
  return ex + w * CELL > x0 && ex < x1 && ey + h * CELL > y0 && ey < y1;
}

// Lua: field_view.lua:364
function collectNeighborActors(actors: LuaTable, baseIndex: number, hostMapId: any, hostDef: any,
  camX?: number, camY?: number): number {
  const Map: any = MapMod; // package.loaded["src.core.game3.map"]
  if (!(Map && isTable(Map.world))) return baseIndex;
  const Ghosts: any = GhostsMod; // package.loaded["src.core.game3.ghosts"]
  const Objects: any = ObjectsMod; // package.loaded["src.core.game3.objects"]
  const vw = lor(FieldView._viewW, Display.W);
  const vh = lor(FieldView._viewH, Display.H);
  const cull = camX != null && camY != null;
  const x0 = (camX ?? 0) - ACTOR_CULL_MARGIN, y0 = (camY ?? 0) - ACTOR_CULL_MARGIN;
  const x1 = (camX ?? 0) + vw + ACTOR_CULL_MARGIN, y1 = (camY ?? 0) + vh + ACTOR_CULL_MARGIN;
  const world = Map.world;
  for (let wi = 1; world[wi] != null; wi++) {
    const entry = world[wi];
    if (entry.id !== hostMapId && entry.def !== hostDef
        && (!cull || entryInView(entry, x0, y0, x1, y1))) {
      const live = Ghosts && Ghosts.forDraw && Ghosts.forDraw(entry.id);
      if (live) {
        for (let li = 1; live[li] != null; li++) {
          const eo = live[li];
          const x = lor(eo.px, lor(eo.cellX, 0) * CELL) + entry.ox * CELL;
          const y = lor(eo.py, lor(eo.cellY, 0) * CELL) + entry.oy * CELL;
          if (!cull || (x > x0 && x < x1 && y > y0 && y < y1)) {
            baseIndex = baseIndex + 1;
            let a = ghostActors.get(eo);
            if (!a) {
              a = { kind: "npc", eventObject: eo };
              ghostActors.set(eo, a);
            }
            a.i = baseIndex;
            a.obj = eo.def;
            a.ghost = entry.id;
            a.x = x;
            a.y = y;
            a.facing = lor(eo.facing, "down");
            a.walkPhase = lor(Objects && Objects.walkPhase && Objects.walkPhase(eo), 0);
            a.stepFlip = truthy(eo.stepFlip);
            a.sprite = lor(eo.sprite, spriteNameForObj(lor(eo.def, {})));
            a.graphicsId = lor(eo.graphicsId,
              eo.def && lor(eo.def.graphicsId, eo.def.graphics));
            a.alpha = lor(Objects && Objects.fadeAlpha && Objects.fadeAlpha(eo), undefined);
            a.elevation = undefined;
            a.priority = undefined;
            a.subpriority = undefined;
            actors[len(actors) + 1] = a;
          }
        }
      } else {
        const defs = neighborActorDefs(entry.id, entry.def);
        const bounds = lor(Objects && Objects.layoutBounds
          && Objects.layoutBounds(entry.def), undefined);
        const Space: any = SpaceMod; // package.loaded["src.core.game3.scripting.space"]
        const nb = lor(Space && Space.neighborObjectState
          && Space.neighborObjectState(entry.id),
        { store: { flags: {}, vars: {} }, perm: {}, movementType: {} });
        if (defs) {
          for (let di = 1; defs[di] != null; di++) {
            const obj = defs[di];
            const lid = lor(tonumber(lor(obj.localId, obj.index)), 0);
            const p = nb.perm[lid];
            const ox = lor(p && p.x, lor(tonumber(obj.x), 0));
            const oy = lor(p && p.y, lor(tonumber(obj.y), 0));
            let out = bounds && (ox < 0 || oy < 0
              || ox >= bounds.w || oy >= bounds.h);
            // src/event_object_movement.c:8014
            if (tonumber(obj.movementType) === 0x4C) out = true;
            let gid = lor(obj.graphicsId, obj.graphics);
            if (Space && Space.resolveObjectGraphicsId) {
              gid = Space.resolveObjectGraphicsId(obj, nb);
            }
            if (objectVisible(obj) && !truthy(out) && truthy(gid)) {
              const mt = nb.movementType[lid];
              baseIndex = baseIndex + 1;
              actors[len(actors) + 1] = {
                kind: "npc",
                i: baseIndex,
                obj,
                ghost: entry.id,
                x: (entry.ox + ox) * CELL,
                y: (entry.oy + oy) * CELL,
                facing: lor(lor(truthy(mt) ? GfxIds.initialFacing(mt) : mt,
                  obj.movementType != null ? GfxIds.initialFacing(obj.movementType) : false),
                facingFromObj(obj)),
                sprite: spriteNameForObj(obj),
                graphicsId: gid,
              };
            }
          }
        }
      }
    }
  }
  return baseIndex;
}

// Lua: field_view.lua:454
function pushBillboard(x: number, y: number, camX: number, camY: number): boolean {
  const bb = FieldView._billboard;
  if (!bb) return false;
  const Tilt: any = TiltMod; // require("src.render.Tilt")
  const fx = (x - camX) + CELL / 2;
  const fy = (y - camY) + CELL;
  const [sx, sy] = Tilt.groundPoint(fx, fy, bb.vw, bb.vh);
  G.push();
  G.translate(sx - fx, sy - fy);
  return true;
}

// pokefirered/src/event_object_movement.c:8368 sElevationToPriority
const ELEVATION_TO_PRIORITY: Record<number, number> = {
  0: 2, 1: 2, 2: 2, 3: 2,
  4: 1, 5: 2, 6: 1, 7: 2,
  8: 1, 9: 2, 10: 1, 11: 2,
  12: 1, 13: 0, 14: 0, 15: 2,
};

// Lua: field_view.lua:474
function actorPriority(a: any): number {
  if (truthy(a.oamPriority)) return a.oamPriority;
  if (a.kind === "player") {
    const Player: any = PlayerMod; // package.loaded["src.core.game3.player"]
    if (Player && (truthy(Player.jumping) || truthy(Player.surfHopping))) {
      return 1;
    }
    // pokefirered/src/field_effect.c:2413
    if (Player && truthy(Player.oamPriority)) return Player.oamPriority;
    const Warp: any = WarpMod; // package.loaded["src.core.game3.warp"]
    if (Warp && Warp.isEscalatorActive && Warp.isEscalatorActive()) {
      return 1;
    }
    const SpecialAnim: any = SpecialFieldAnimMod; // package.loaded["src.core.game3.special_field_anim"]
    if (SpecialAnim && SpecialAnim.isActive && SpecialAnim.isActive()) {
      return 1;
    }
    const elev = lor(a.elevation, lor(Player && Player.elevation, 3));
    return ELEVATION_TO_PRIORITY[elev] ?? 2;
  } else {
    const elev = lor(a.elevation, lor(a.obj && lor(a.obj.elevation, a.obj.def && a.obj.def.elevation), 3));
    return ELEVATION_TO_PRIORITY[elev] ?? 2;
  }
}

// pokeemerald/src/event_object_movement.c:7691
const ELEV_TO_SUBPRIORITY: Record<number, number> = {
  0: 115, 1: 115, 2: 83, 3: 115, 4: 83, 5: 115,
  6: 83, 7: 115, 8: 83, 9: 115, 10: 83, 11: 115,
  12: 83, 13: 0, 14: 0, 15: 115,
};

// Lua: field_view.lua:506
function sortActors(a: any, b: any): boolean {
  if (a.subpriority === b.subpriority) {
    const ay = lor(a.sortY, lor(a.y, 0));
    const by = lor(b.sortY, lor(b.y, 0));
    if (ay === by) return lor(a.i, 0) < lor(b.i, 0);
    return ay < by;
  }
  return a.subpriority > b.subpriority;
}

// Lua: field_view.lua:517
// event_object_movement.c:7739-7754, scrcmd.c:1130 -- [under, over]
function applyDrawOrder(actors: LuaTable, underActors?: LuaTable, overActors?: LuaTable, camY?: number): [LuaTable, LuaTable] {
  const under: LuaTable = underActors ?? [null];
  const over: LuaTable = overActors ?? [null];
  clearSeq(under);
  clearSeq(over);
  for (let i = 1; actors[i] != null; i++) {
    const a = actors[i];
    const obj = a.eventObject;
    if ((obj && truthy(obj.fixedPriority)) || truthy(a.fixedPriority)) {
      a.fixedPriority = true;
      if (obj && obj.fixedClass == null) obj.fixedClass = truthy(a.priority) ? a.priority : actorPriority(a);
      a.subpriority = lor(lor(obj && obj.subpriority, a.subpriority), 83);
      const pr = lor(obj && obj.fixedClass, a.priority);
      a.priority = truthy(pr) ? pr : actorPriority(a);
    } else {
      if (obj) obj.fixedClass = undefined;
      a.fixedPriority = false;
      a.priority = actorPriority(a);
      const screenY = Math.floor(lor(a.y, 0) - lor(camY, 0));
      const gridY = Math.floor(screenY / 16);
      const y = (16 - gridY) * 2;
      const base = ELEV_TO_SUBPRIORITY[lor(a.elevation, 3)] ?? 115;
      a.subpriority = base + y + 1;
    }
    if (lor(a.priority, 2) < 2) {
      over[len(over) + 1] = a;
    } else {
      under[len(under) + 1] = a;
    }
  }
  sort(under, sortActors);
  sort(over, sortActors);
  return [under, over];
}
FieldView.applyDrawOrder = applyDrawOrder;

const owOpts: Record<string, any> = {};

// Lua: field_view.lua:553
function drawSingleActor(game: any, mapDef: any, a: any, camX: number, camY: number): void {
  const daytime = daytimeFor(game, mapDef);
  const OwSprites = modOwSprites();
  const useOw = OwSprites && OwSprites.ready && OwSprites.ready();
  G.setColor(1, 1, 1, 1);
  const billboarded = pushBillboard(a.x, a.y, camX, camY);
  let drew = false;
  if (a.draw) {
    a.draw(camX, camY);
    drew = true;
  }
  if (!drew && a.renderer) {
    a.renderer.draw(a.x, a.y, camX, camY, a.facing, lor(a.walkPhase, 0), false);
    drew = true;
  }
  if (!drew && truthy(useOw) && a.graphicsId != null) {
    const opts = owOpts;
    opts.bow = a.bow;
    opts.fieldMove = a.fieldMove;
    opts.fieldMoveFrame = a.fieldMoveFrame;
    opts.fishing = a.fishing;
    opts.fishFrame = a.fishFrame;
    opts.frame = a.frame;
    opts.running = a.running;
    opts.alpha = a.alpha;
    drew = truthy(OwSprites.draw(
      a.graphicsId, a.x, a.y, camX, camY, a.facing, a.walkPhase, a.stepFlip, opts));
  }
  if (!drew) {
    const sr = getSpriteRenderer(
      game, a.sprite, a.kind + ":" + tostring(lor(a.i, "p")), a.obj, daytime);
    if (sr) {
      sr.draw(a.x, a.y, camX, camY, a.facing, lor(a.walkPhase, 0), a.stepFlip);
    } else {
      const sx = a.x - camX, sy = a.y - camY;
      if (a.kind === "player") {
        G.setColor(0.95, 0.25, 0.25, 1);
      } else {
        G.setColor(0.3, 0.55, 0.95, 1);
      }
      G.rectangle("fill", sx + 4, sy + 2, 8, 12);
      G.setColor(1, 1, 1, 1);
    }
  }
  if (billboarded) G.pop();
}

const frameActors: LuaTable = [null], frameUnder: LuaTable = [null], frameOver: LuaTable = [null];
// setmetatable({}, { __mode = "k" })
const npcActors = new WeakMap<object, any>();
const playerActor: any = {};

// Lua: field_view.lua:604 -- [under, over]
function collectGame3Actors(game: any, mapDef: any, camX: number, camY: number, px: number, py: number,
  facing: any, walkPhase: any, stepFlip: any, playerYOff: number, playerXOff: number): [LuaTable, LuaTable] {
  const Objects = modObjects();
  const OwSprites = modOwSprites();
  const useOw = OwSprites && OwSprites.ready && OwSprites.ready();
  const actors = frameActors;
  clearSeq(actors);
  const hasObjects = Objects && Objects.hasMap && Objects.hasMap();

  if (truthy(hasObjects)) {
    const list = Objects.forDraw();
    for (let oi = 1; list[oi] != null; oi++) {
      const eo = list[oi];
      let sortY = lor(eo.py, eo.cellY * CELL);
      if (truthy(eo.moving) && truthy(eo.targetY) && eo.targetY > lor(eo.cellY, 0)) {
        sortY = Math.max(sortY, eo.targetY * CELL);
      }
      let a = npcActors.get(eo);
      if (!a) {
        a = { kind: "npc", eventObject: eo };
        npcActors.set(eo, a);
      }
      a.i = eo.localId;
      a.obj = eo.def;
      a.elevation = lor(lor(eo.elevation, eo.def && eo.def.elevation), 0);
      a.x = lor(eo.px, eo.cellX * CELL) + lor(eo.raiseX, 0);
      a.y = lor(eo.py, eo.cellY * CELL) + lor(eo.raiseY, 0);
      a.sortY = sortY;
      a.facing = lor(eo.facing, "down");
      a.walkPhase = Objects.walkPhase(eo);
      a.stepFlip = truthy(eo.stepFlip);
      // pokeemerald/src/data/object_events/object_event_anims.h:602
      a.bow = (truthy(eo.bowFrames) && eo.bowFrames > 8 && eo.bowFrames <= 40) || eo.raiseHand === true;
      a.frame = eo.customFrame;
      a.sprite = lor(eo.sprite, spriteNameForObj(lor(eo.def, {})));
      a.graphicsId = lor(eo.graphicsId, eo.def && lor(eo.def.graphicsId, eo.def.graphics));
      a.alpha = Objects.fadeAlpha(eo);
      a.priority = undefined;
      a.subpriority = undefined;
      actors[len(actors) + 1] = a;
    }
    collectNeighborActors(actors, 10000, currentMapId(game),
      resolveMapDef(game, currentMapId(game)), camX, camY);
    const Space: any = SpaceMod; // package.loaded["src.core.game3.scripting.space"]
    if (Space && Space.resolveObjectGraphicsId) {
      for (let i = 1; actors[i] != null; i++) {
        const a = actors[i];
        if (a.obj && !truthy(a.ghost) && !(a.eventObject && a.eventObject.graphicsId != null)) {
          const gid = Space.resolveObjectGraphicsId(a.obj);
          if (truthy(gid)) a.graphicsId = gid;
        }
      }
    }
  } else {
    const world = game && lor(game.overworld, game.world);
    if (world && world.npcs) {
      for (let i = 1; world.npcs[i] != null; i++) {
        const npc = world.npcs[i];
        actors[len(actors) + 1] = {
          kind: "npc",
          i,
          obj: npc.def,
          elevation: lor(lor(npc.elevation, npc.def && npc.def.elevation), 0),
          x: lor(npc.px, lor(npc.cellX, 0) * CELL),
          y: lor(npc.py, lor(npc.cellY, 0) * CELL),
          sortY: lor(npc.py, lor(npc.cellY, 0) * CELL),
          facing: lor(npc.facing, "down"),
          sprite: spriteNameForObj(lor(npc.def, {})),
          graphicsId: lor(truthy(useOw) && OwSprites.playerGraphicsId && npc.graphicsId, undefined),
        };
      }
    } else if (isTable(mapDef.objects)) {
      for (let i = 1; mapDef.objects[i] != null; i++) {
        const obj = mapDef.objects[i];
        if (objectVisible(obj)) {
          actors[len(actors) + 1] = {
            kind: "npc",
            i,
            obj,
            elevation: lor(obj.elevation, 0),
            x: lor(tonumber(obj.x), 0) * CELL,
            y: lor(tonumber(obj.y), 0) * CELL,
            sortY: lor(tonumber(obj.y), 0) * CELL,
            facing: facingFromObj(obj),
            sprite: spriteNameForObj(obj),
            graphicsId: lor(obj.graphicsId, obj.graphics),
          };
        }
      }
    }
  }

  const Player: any = PlayerMod; // package.loaded["src.core.game3.player"]
  if (!Player || (Player.isVisible && Player.isVisible())) {
    let playerSortY = py;
    if (Player && truthy(Player.moving) && truthy(Player.targetY) && Player.targetY > lor(Player.cellY, 0)) {
      playerSortY = Math.max(playerSortY, Player.targetY * CELL);
    }
    const fieldMove = (Player && truthy(Player.fieldMoveAnim) && Player.fieldMoveAnim > 0) || false;
    let fieldMoveFrame: any;
    if (fieldMove && truthy(useOw) && OwSprites.fieldMoveFrame) {
      fieldMoveFrame = OwSprites.fieldMoveFrame(
        lor(Player.fieldMoveTotal, Player.fieldMoveAnim) - Player.fieldMoveAnim,
        Player.fieldMoveKind);
    }
    const Field: any = FieldMod; // package.loaded["src.core.game3.field"]
    let fishFrame: any, fishX2: any, fishY2: any;
    if (!fieldMove && Field && Field.fishingPose) {
      const pose = Field.fishingPose();
      fishFrame = pose[0]; fishX2 = pose[1]; fishY2 = pose[2];
    }
    const a = playerActor;
    a.kind = "player";
    a.elevation = lor(Player && Player.elevation, 3);
    a.x = px + lor(playerXOff, 0) + lor(fishX2, 0);
    a.y = py + lor(playerYOff, 0) + lor(fishY2, 0);
    a.sortY = playerSortY;
    a.facing = lor(facing, "down");
    a.walkPhase = (walkPhase === 1 || walkPhase === true) ? 1 : 0;
    a.stepFlip = truthy(stepFlip);
    a.fieldMove = fieldMove;
    a.fieldMoveFrame = fieldMoveFrame;
    a.fishing = fishFrame != null;
    a.fishFrame = fishFrame;
    a.running = lor(Player && Player.runPose && Player.runPose(), undefined);
    a.frame = lor(Player && Player.acroFrame && Player.acroFrame(), undefined);
    a.sprite = playerSpriteName(game);
    a.graphicsId = lor(truthy(useOw) && OwSprites.playerGraphicsId(game), undefined);
    a.priority = undefined;
    a.fixedPriority = Player ? Player.fixedPriority : undefined;
    a.subpriority = Player ? Player.subpriority : undefined;
    actors[len(actors) + 1] = a;
  }

  const Follower = modFollower();
  const follower = Follower && Follower.actor && Follower.actor();
  if (truthy(follower)) actors[len(actors) + 1] = follower;

  const FieldEffects = modFieldEffects();
  if (FieldEffects && FieldEffects.collectActors) {
    FieldEffects.collectActors(actors);
  }

  return applyDrawOrder(actors, frameUnder, frameOver, camY);
}

/** Collect visible tile draws grouped by palette slot for batched GbcPalette.with. */
interface TileDraw { q: Quad | false; x: number; y: number }
const tile_draw_pool: LuaTable = [null];
let tile_draw_count = 0;
const tile_draw_slots: Record<number, LuaTable> = {};

// Lua: field_view.lua:746
function collectTileDraws(mapDef: any, camX: number, camY: number, canvasW: number, canvasH: number): Record<number, LuaTable> {
  const bySlot = tile_draw_slots;
  for (const slot in bySlot) {
    clearSeq(bySlot[slot]);
    delete bySlot[slot];
  }
  tile_draw_count = 0;
  const blocksTbl = FieldView._blockTiles;
  const tilePals = FieldView._tilePalettes;
  const bx0 = Math.floor(camX / BLOCK) - 1;
  const by0 = Math.floor(camY / BLOCK) - 1;
  const bx1 = Math.floor((camX + canvasW) / BLOCK) + 1;
  const by1 = Math.floor((camY + canvasH) / BLOCK) + 1;

  for (let by = by0; by <= by1; by++) {
    for (let bx = bx0; bx <= bx1; bx++) {
      const blockId = blockIdAt(mapDef, bx, by);
      const block = blocksTbl[lor(blockId, 0) + 1];
      if (isTable(block)) {
        const tiles = lor(block.tiles, block);
        const originX = bx * BLOCK - camX;
        const originY = by * BLOCK - camY;
        for (let i = 0; i <= 15; i++) {
          const tile = lor(tiles[i + 1], 0);
          const q = quadFor(tile);
          if (q) {
            const slot = lor(tilePals && tilePals[tile + 1], 1);
            let list = bySlot[slot];
            if (!list) {
              list = [null];
              bySlot[slot] = list;
            }
            let d: TileDraw = tile_draw_pool[tile_draw_count + 1];
            if (!d) {
              d = { q: false, x: 0, y: 0 };
              tile_draw_pool[tile_draw_count + 1] = d;
            }
            tile_draw_count = tile_draw_count + 1;
            d.q = q;
            d.x = originX + mod(i, 4) * 8;
            d.y = originY + Math.floor(i / 4) * 8;
            list[len(list) + 1] = d;
          }
        }
      }
    }
  }
  return bySlot;
}

let palAtlas: Image | undefined, palList: LuaTable;
// Lua: field_view.lua:797
function draw_pal_list(): void {
  for (let i = 1; palList[i] != null; i++) {
    const d = palList[i];
    G.draw(palAtlas!, d.q, d.x, d.y);
  }
}

// Lua: field_view.lua:803
function drawTilesColored(atlas: Image, bySlot: Record<number, LuaTable>, bgSet: any): void {
  const GbcPalette = modGbcPalette();
  const usePal = GbcPalette && GbcPalette.available && GbcPalette.available()
    && bgSet && GbcPalette.with;

  G.setColor(1, 1, 1, 1);
  if (usePal) {
    if (!FieldView._loggedPal) {
      log("tile palettes ON (GbcPalette.with per BG slot)");
      FieldView._loggedPal = true;
    }
    for (const k in bySlot) {
      const slot = Number(k);
      const list = bySlot[slot]!;
      const colors = lor(bgSet[slot], bgSet[1]);
      if (colors) {
        palAtlas = atlas; palList = list;
        GbcPalette.with(colors, draw_pal_list);
      } else {
        for (let i = 1; list[i] != null; i++) {
          const d = list[i];
          G.draw(atlas, d.q, d.x, d.y);
        }
      }
    }
  } else {
    if (!FieldView._loggedPal) {
      log("tile palettes OFF (unshaded atlas blit)");
      FieldView._loggedPal = true;
    }
    for (const k in bySlot) {
      const list = bySlot[Number(k)]!;
      for (let i = 1; list[i] != null; i++) {
        const d = list[i];
        G.draw(atlas, d.q, d.x, d.y);
      }
    }
  }
}

// Lua: field_view.lua:838 -- [r, g, b]
function washColor(bgSet: any): [number, number, number] {
  if (bgSet && bgSet[1] && bgSet[1][1]) {
    const c = bgSet[1][1];
    return [lor(c[1], 40) / 255, lor(c[2], 80) / 255, lor(c[3], 60) / 255];
  }
  return [0.12, 0.28, 0.22];
}

// Lua: field_view.lua:846
function releaseBatch(batch: any): void {
  if (batch && batch.release) {
    try {
      batch.release();
    } catch {
      // pcall
    }
  }
}

// Lua: field_view.lua:854
// Outside a full reset, visible cells hold sprite indices into the batch
// stored under `srcPair`, so a texture swap cannot replace it in place (the
// next releaseNativeSprite would index a smaller batch).  Report the swap and
// let drawNativeTiles rebuild everything this frame instead.
function ensure_batch(store: BatchStore, srcPair: string, texture: Image, capacity: number): SpriteBatch | undefined {
  let batch: SpriteBatch | undefined = store[srcPair];
  if (batch && batch.getTexture && batch.getTexture() !== texture) {
    if (!FieldView._nativeResetting) {
      FieldView._nativeSwap = true;
      return undefined;
    }
    releaseBatch(batch);
    batch = undefined;
  }
  if (!batch) {
    batch = G.newSpriteBatch(texture, capacity);
    store[srcPair] = batch;
  }
  return batch;
}

let nativeAtlasByPair: Record<string, any> = {};
const HIDDEN_SPRITE_X = -1000000, HIDDEN_SPRITE_Y = -1000000;

// Lua: field_view.lua:874
function nativeAtlas(NativeTileset: any, pair: string): any {
  let ts = nativeAtlasByPair[pair];
  if (!ts || (NativeTileset._pairs && NativeTileset._pairs[pair] !== ts)) {
    ts = NativeTileset.get(pair);
    if (ts) nativeAtlasByPair[pair] = ts;
  }
  return ts;
}

// Physical sprite slots per layer (free-list reuse does not grow them).
const nativeSlots: Record<string, number> = { under: 0, over: 0 };

// Lua: field_view.lua:886
function acquireNativeSprite(store: BatchStore, free: Record<string, LuaTable>, key: string, texture: Image,
  capacity: number, quad: Quad, x: number, y: number, layer: string): NativeSprite | undefined {
  const batch = ensure_batch(store, key, texture, capacity);
  if (!batch) return undefined;
  const available = free[key];
  let index: number;
  if (available && len(available) > 0) {
    index = remove<number>(available)!;
    batch.set(index, quad, x, y);
  } else {
    index = batch.add(quad, x, y);
    const n = nativeSlots[layer]! + 1;
    nativeSlots[layer] = n;
    if (n > FieldView._nativeSpriteSlots) FieldView._nativeSpriteSlots = n;
  }
  return { key, index, quad };
}

// Lua: field_view.lua:904
function releaseNativeSprite(store: BatchStore, free: Record<string, LuaTable>, sprite: NativeSprite | undefined): boolean {
  if (!sprite) return true;
  const batch = store[sprite.key];
  if (!(batch && batch.set)) return false;
  if (batch.getCount && sprite.index > batch.getCount()) return false;
  batch.set(sprite.index, sprite.quad, HIDDEN_SPRITE_X, HIDDEN_SPRITE_Y);
  let available = free[sprite.key];
  if (!available) {
    available = [null];
    free[sprite.key] = available;
  }
  available[len(available) + 1] = sprite.index;
  return true;
}

// Lua: field_view.lua:922
// Clear every native batch for a full rebuild, keeping the SpriteBatch
// objects (and their GPU buffers) for reuse.  Batches that cannot be cleared
// (test doubles) are dropped.
function clearNativeStore(store: BatchStore): void {
  for (const k in store) {
    const batch = store[k]!;
    if (batch.clear) {
      batch.clear();
    } else {
      releaseBatch(batch);
      delete store[k];
    }
  }
}

// Lua: field_view.lua:934
// After a rebuild, release batches no visible cell uses any more.
function pruneNativeStore(store: BatchStore): void {
  for (const k in store) {
    const batch = store[k]!;
    if (batch.getCount && batch.getCount() === 0) {
      releaseBatch(batch);
      delete store[k];
    }
  }
}

// Lua: field_view.lua:943
function releaseVoidFrom(from: VoidFrom | undefined): void {
  if (!from) return;
  // ipairs({ from.under, from.over }): stops at the first nil, as Brian's
  const lists = [from.under, from.over];
  for (const t of lists) {
    if (t == null) break;
    for (const k in t) releaseBatch(t[k]);
  }
}

// Lua: field_view.lua:953
/**
 * Mark one cell of the drawn map's layout for re-sampling on the next draw
 * (metatile writes).  x, y are layout (current-map) cell coordinates.  Cells
 * that are not visible need nothing: they are sampled when they scroll in.
 */
FieldView.invalidateCell = function (xIn: unknown, yIn: unknown, layout?: unknown): void {
  if (FieldView._nativeDirty || !isTable(FieldView._nativeVisibleCells)) return;
  const x = tonumber(xIn), y = tonumber(yIn);
  if (!(x != null && y != null) || (layout != null && layout !== FieldView._nativeLayout)) {
    FieldView._nativeDirty = true;
    return;
  }
  let cells = FieldView._nativeDirtyCells;
  if (!cells) {
    cells = [null];
    FieldView._nativeDirtyCells = cells;
  }
  const n = len(cells);
  if (n >= 1024) {
    FieldView._nativeDirty = true;
    return;
  }
  cells[n + 1] = x;
  cells[n + 2] = y;
};

// Lua: field_view.lua:977
/**
 * Metatile write on `layout` at its own (x, y).  Only the drawn map's own
 * layout maps 1:1 onto view cells; anything else (neighbour maps, a layout
 * shared with a neighbour) falls back to a full rebuild.
 */
FieldView.invalidateLayoutCell = function (layout: unknown, x: unknown, y: unknown): void {
  if (FieldView._nativeDirty) return;
  if (layout == null || layout !== FieldView._nativeLayout) {
    FieldView._nativeDirty = true;
    return;
  }
  const Map: any = MapMod; // package.loaded["src.core.game3.map"]
  const world = (Map && Map.world) || [null];
  for (let i = 1; world[i] != null; i++) {
    const entry = world[i];
    if (entry.def && entry.def.midLayout === layout) {
      FieldView._nativeDirty = true;
      return;
    }
  }
  FieldView.invalidateCell(x, y, layout);
};

FieldView.VOID_FADE_FRAMES = 20;
// setmetatable({}, { __index = memoised "void|" .. pair })
const voidKeyCache: Record<string, string> = {};
function voidKey(pair: string): string {
  let k = voidKeyCache[pair];
  if (k === undefined) {
    k = "void|" + pair;
    voidKeyCache[pair] = k;
  }
  return k;
}

// Lua: field_view.lua:1000
function isVoidKey(k: unknown): boolean {
  return typeof k === "string" && k.substring(0, 5) === "void|";
}

// Lua: field_view.lua:1004
function connectedTo(Map: any, def: any): boolean {
  const list = Map.neighborList || [null];
  for (let i = 1; list[i] != null; i++) {
    if (list[i].def === def) return true;
  }
  return false;
}

// Lua: field_view.lua:1011
function beginVoidFade(Map: any, mapDef: any, camX: number, camY: number, voidMode: string): void {
  const prev = FieldView._voidMapDef;
  if (prev === mapDef) return;
  FieldView._voidMapDef = mapDef;
  FieldView._voidFrom = undefined;
  if (!(prev && voidMode === "map" && FieldView._lastCamX != null && connectedTo(Map, prev))) return;
  const from: VoidFrom = {
    under: {}, over: {}, bx: lor(FieldView._nativeBaseBx, lor(FieldView._nativeBx, 0)),
    by: lor(FieldView._nativeBaseBy, lor(FieldView._nativeBy, 0)),
    dx: FieldView._lastCamX - camX, dy: FieldView._lastCamY! - camY, t: 0,
  };
  const stores: [BatchStore | undefined, BatchStore][] = [
    [FieldView._nativeBatches, from.under], [FieldView._nativeOverBatches, from.over]];
  for (const store of stores) {
    const src = store[0] || {};
    for (const k in src) {
      if (isVoidKey(k)) {
        store[1][k] = src[k]!;
        delete src[k];
      }
    }
  }
  if (!emptyObj(from.under)) FieldView._voidFrom = from;
  FieldView._nativeDirty = true;
}

// Lua: field_view.lua:1032
function drawVoidFrom(batches: BatchStore, camX: number, camY: number): void {
  const f = FieldView._voidFrom;
  if (!f) return;
  G.setColor(1, 1, 1, 1 - f.t / FieldView.VOID_FADE_FRAMES);
  const x = f.bx * CELL - (camX + f.dx), y = f.by * CELL - (camY + f.dy);
  for (const k in batches) G.draw(batches[k]!, x, y);
  G.setColor(1, 1, 1, 1);
}

// Lua: field_view.lua:1041
function drawLayer(batches: BatchStore, pair: string | undefined, ox: number, oy: number,
  fromBatches: BatchStore | undefined, camX: number, camY: number): void {
  for (const k in batches) {
    if (isVoidKey(k)) G.draw(batches[k]!, ox, oy);
  }
  if (fromBatches) drawVoidFrom(fromBatches, camX, camY);
  if (pair != null && batches[pair]) G.draw(batches[pair]!, ox, oy);
  for (const k in batches) {
    if (k !== pair && !isVoidKey(k)) G.draw(batches[k]!, ox, oy);
  }
}

// Lua: field_view.lua:1055
/**
 * Prefer native mid atlas when ready. Supports cross-pair connection seams
 * (e.g. Route1 pallet_outdoor → Viridian viridian_outdoor) by batching per pair.
 * Draws under-layer (BG3/BG1) only; call drawNativeOverTiles after sprites for BG2.
 */
function drawNativeTiles(mapDef: any, camX: number, camY: number, canvasW: number, canvasH: number): boolean {
  const V: any = Versions;
  if (!truthy(V.NATIVE_RENDER)) return false;
  const layout = mapDef.midLayout;
  const pair: string = lor(mapDef.pair, layout && layout.pair);
  if (!truthy(layout) || !truthy(pair)) return false;

  const NativeTileset = modNativeTileset();
  if (!(NativeTileset && NativeTileset.ready && NativeTileset.ready(pair))) {
    if (!FieldView._loggedNativeFallback) {
      log("native unavailable for " + tostring(pair) + " \xE2\x80\x94 Gen2 atlas fallback");
      FieldView._loggedNativeFallback = true;
    }
    return false;
  }
  const mainTs = nativeAtlas(NativeTileset, pair);
  if (!mainTs) return false;

  G.setColor(0, 0, 0, 1);
  G.rectangle("fill", 0, 0, canvasW, canvasH);

  const cols = Math.ceil(canvasW / CELL) + 3;
  const rows = Math.ceil(canvasH / CELL) + 3;
  const cx0 = Math.floor(camX / CELL) - 1;
  const cy0 = Math.floor(camY / CELL) - 1;
  const capacity = cols * rows;

  const Map: any = MapMod; // package.loaded["src.core.game3.map"] or require(...)
  // require("src.core.game3.void_fill"): imported
  const voidMode = VoidFill.normalize(VoidFill.mode);
  beginVoidFade(Map, mapDef, camX, camY, voidMode);

  let underStore = FieldView._nativeBatches;
  if (!underStore) {
    underStore = {};
    FieldView._nativeBatches = underStore;
  }
  let overStore = FieldView._nativeOverBatches;
  if (!overStore) {
    overStore = {};
    FieldView._nativeOverBatches = overStore;
  }
  const uStore: BatchStore = underStore, oStore: BatchStore = overStore;
  const mainBatch = uStore[pair];

  const moved = FieldView._nativeBx !== cx0 || FieldView._nativeBy !== cy0;
  let reset = FieldView._nativeDirty
    || FieldView._nativeVoid !== voidMode
    || FieldView._nativePair !== pair
    || FieldView._nativeLayout !== layout
    || FieldView._nativeViewCols !== cols
    || FieldView._nativeViewRows !== rows
    || !isTable(FieldView._nativeVisibleCells)
    || !isTable(FieldView._nativeFreeUnder)
    || !isTable(FieldView._nativeFreeOver)
    || lor(FieldView._nativeSpriteSlots, 0) > capacity * 4
    // primary atlas reloaded (tileset reinstall): cells index the old texture
    || (mainBatch != null && mainBatch.getTexture != null && mainBatch.getTexture() !== mainTs.image);
  if (!reset && moved) {
    const dx = Math.abs(cx0 - lor(FieldView._nativeBx, cx0));
    const dy = Math.abs(cy0 - lor(FieldView._nativeBy, cy0));
    if (dx >= cols || dy >= rows) {
      reset = true;
    } else {
      for (const store of [uStore, oStore]) {
        for (const k in store) {
          if (typeof (store[k] as any).set !== "function") { reset = true; break; }
        }
        if (reset) break;
      }
    }
  }

  let visibleCells: CellGrid = FieldView._nativeVisibleCells!;
  let visiblePairs: Record<string, boolean> = FieldView._nativeVisiblePairs!;
  let baseBx = FieldView._nativeBaseBx!, baseBy = FieldView._nativeBaseBy!;
  const CellPlan: any = CellPlanMod; // require("src.core.game3.field_plan")
  // A same-layout bulk invalidation can come from a mod editing its cells
  // directly. Resnapshot it rather than reuse an older planned window.
  if (FieldView._nativeDirty && FieldView._nativeLayout === layout) CellPlan.invalidate();
  const preparedCells = CellPlan.get(mapDef, cx0, cy0, cols, rows, voidMode);
  FieldView._cellPreparationRoute = preparedCells ? "worker" : "sync";
  const addCell = (wx: number, wy: number): NativeCell => {
    let mid: any, srcPair: any, isVoid: any;
    let skip: any = false;
    if (preparedCells) {
      const c = CellPlan.cell(preparedCells, wx, wy);
      mid = c[0]; srcPair = c[1]; isVoid = c[2]; skip = c[3];
    } else if (Map.worldMidAt) {
      const s = Map.worldMidAt(wx, wy, mapDef); // shared sample: read at once
      mid = s[0]; srcPair = s[1]; isVoid = s[2];
      srcPair = lor(srcPair, pair);
    } else {
      mid = layout.midAt(wx, wy); srcPair = pair; isVoid = false;
    }
    if (!preparedCells && truthy(isVoid) && voidMode !== "map") {
      const fill = VoidFill.fillAt(voidMode, wx, wy,
        (m: number) => NativeTileset.hasMid(pair, m), VoidFill.primaryFor(pair));
      if (fill === false) {
        skip = true;
      } else if (fill != null) {
        mid = fill; srcPair = pair;
      }
    }
    if (!NativeTileset.ready(srcPair)) srcPair = pair;
    const info: NativeCell = { pair: srcPair, draw: !truthy(skip) };
    if (!truthy(skip)) {
      const key = (truthy(isVoid) && voidMode === "map") ? voidKey(srcPair) : srcPair;
      info.key = key;
      const ts = nativeAtlas(NativeTileset, srcPair);
      if (ts && ts.image) {
        const slot = NativeTileset.slotFor(ts, mid);
        const q = NativeTileset.quad(ts, slot);
        if (q) {
          info.under = acquireNativeSprite(uStore,
            FieldView._nativeFreeUnder!, key, ts.image, capacity, q,
            (wx - baseBx) * CELL, (wy - baseBy) * CELL, "under");
        }
        if (ts.layered && ts.overImage) {
          const oq = NativeTileset.overQuad(ts, slot);
          if (oq) {
            info.over = acquireNativeSprite(oStore,
              FieldView._nativeFreeOver!, key, ts.overImage, capacity, oq,
              (wx - baseBx) * CELL, (wy - baseBy) * CELL, "over");
          }
        }
      }
    }
    return info;
  };

  const releaseCell = (info: NativeCell): boolean => {
    return releaseNativeSprite(uStore, FieldView._nativeFreeUnder!, info.under)
      && releaseNativeSprite(oStore, FieldView._nativeFreeOver!, info.over);
  };

  if (!reset && moved) {
    for (const ky in visibleCells) {
      const wy = Number(ky);
      const row = visibleCells[wy]!;
      for (const kx in row) {
        const wx = Number(kx);
        if (wx < cx0 || wx >= cx0 + cols || wy < cy0 || wy >= cy0 + rows) {
          if (!releaseCell(row[wx]!)) {
            reset = true;
            break;
          }
          delete row[wx];
        }
      }
      if (emptyObj(row)) delete visibleCells[wy];
      if (reset) break;
    }
  }

  // Metatile writes since the last draw: drop just those cells so the fill
  // loop below re-samples them (FieldView.invalidateCell).
  const dirtyCells = FieldView._nativeDirtyCells;
  if (dirtyCells) {
    FieldView._nativeDirtyCells = undefined;
    if (!reset) {
      const n = len(dirtyCells);
      for (let i = 1; i <= n - 1; i += 2) {
        const wx = dirtyCells[i], wy = dirtyCells[i + 1];
        const row = visibleCells[wy];
        const info = row && row[wx];
        if (info) {
          if (!releaseCell(info)) {
            reset = true;
            break;
          }
          delete row[wx];
        }
      }
    }
  }

  const resetNative = (): void => {
    clearNativeStore(uStore);
    clearNativeStore(oStore);
    FieldView._nativeFreeUnder = {};
    FieldView._nativeFreeOver = {};
    visibleCells = {};
    FieldView._nativeVisibleCells = visibleCells;
    visiblePairs = {};
    FieldView._nativeVisiblePairs = visiblePairs;
    nativeSlots.under = 0; nativeSlots.over = 0;
    FieldView._nativeSpriteSlots = 0;
    FieldView._nativeBaseBx = cx0; FieldView._nativeBaseBy = cy0;
    FieldView._nativeViewCols = cols; FieldView._nativeViewRows = rows;
    baseBx = cx0; baseBy = cy0;
  };

  if (reset) {
    resetNative();
  } else if (moved) {
    for (const k in visiblePairs) delete visiblePairs[k];
  }

  const fill = (): boolean => {
    for (let wy = cy0; wy <= cy0 + rows - 1; wy++) {
      let row = visibleCells[wy];
      if (!row) {
        row = {};
        visibleCells[wy] = row;
      }
      for (let wx = cx0; wx <= cx0 + cols - 1; wx++) {
        let info = row[wx];
        if (!info) {
          info = addCell(wx, wy);
          if (FieldView._nativeSwap) return false;
          row[wx] = info;
        }
        if (info.draw) visiblePairs[info.pair] = true;
      }
    }
    return true;
  };

  FieldView._nativeSwap = false;
  FieldView._nativeResetting = !!reset;
  if (!fill()) {
    // An atlas was reloaded while its cells were live: rebuild everything
    // this frame rather than swap the batch under their sprite indices.
    FieldView._nativeSwap = false;
    reset = true;
    resetNative();
    FieldView._nativeResetting = true;
    fill();
  }
  FieldView._nativeResetting = false;
  FieldView._nativeSwap = false;
  if (reset) {
    pruneNativeStore(uStore);
    pruneNativeStore(oStore);
  }

  FieldView._nativeBx = cx0; FieldView._nativeBy = cy0;
  FieldView._nativePair = pair;
  FieldView._nativeLayout = layout;
  FieldView._nativeVoid = voidMode;
  FieldView._nativeDirty = false;
  if (reset || moved) {
    // package.loaded["src.core.game3.tileset_anim"] or require(...): imported
    const TilesetAnim: any = TilesetAnimMod;
    if (TilesetAnim && TilesetAnim.setVisiblePairs) {
      TilesetAnim.setVisiblePairs(visiblePairs);
    }
  }

  G.setColor(1, 1, 1, 1);
  const ox = baseBx * CELL - camX;
  const oy = baseBy * CELL - camY;
  FieldView._nativeOverOx = ox;
  FieldView._nativeOverOy = oy;
  FieldView._nativeOverPair = pair;
  FieldView._nativeCamX = camX; FieldView._nativeCamY = camY;
  const from = FieldView._voidFrom;
  drawLayer(FieldView._nativeBatches!, pair, ox, oy, from && from.under, camX, camY);
  if (from) {
    from.t = from.t + 1;
    if (from.t >= FieldView.VOID_FADE_FRAMES) {
      releaseVoidFrom(from);
      FieldView._voidFrom = undefined;
    }
  }
  FieldView._lastCamX = camX; FieldView._lastCamY = camY;

  if (!FieldView._loggedNative) {
    log("native mid atlas ON pair=" + tostring(pair));
    FieldView._loggedNative = true;
  }
  return true;
}

// Lua: field_view.lua:1323
/** BG2 overhead (building eaves, desk tops) — draw after OW sprites. */
function drawNativeOverTiles(): void {
  const batches = FieldView._nativeOverBatches;
  if (!batches) return;
  const pair = FieldView._nativeOverPair;
  const ox = lor(FieldView._nativeOverOx, 0);
  const oy = lor(FieldView._nativeOverOy, 0);
  G.setColor(1, 1, 1, 1);
  const from = FieldView._voidFrom;
  drawLayer(batches, pair, ox, oy, from && from.over,
    lor(FieldView._nativeCamX, 0), lor(FieldView._nativeCamY, 0));
}

// Lua: field_view.lua:1335
function rseFamily(): boolean {
  // package.loaded["src.core.game3.profile"] or require(...): imported
  let ok = true, row: any;
  try {
    row = Profile.forSession();
  } catch {
    ok = false;
  }
  return ok && row != null && row.family === "rse";
}

// Lua: field_view.lua:1342
// pokeemerald/src/field_screen_effect.c:53
function flashRadii(): Record<number, number> {
  if (!rseFamily()) return FLASH_LEVEL_RADIUS;
  // pcall(require, "src.core.game3.field_effects_rse"): Emerald only, no
  // module here, so the require fails (G3Lazy) and the FRLG radii stand.
  const FxRse = G3Lazy["src.core.game3.field_effects_rse"];
  const m = FxRse && FxRse.fc();
  return (m && m.flashRadii) || FLASH_LEVEL_RADIUS;
}
FieldView.flashRadii = flashRadii;

// Lua: field_view.lua:1351
// pokeemerald/src/field_screen_effect.c:54
FieldView.maxFlashLevel = function (): number {
  const t = flashRadii();
  if (t === FLASH_LEVEL_RADIUS) return FieldView.MAX_FLASH_LEVEL;
  let n = 0;
  for (const [k] of pairs(t)) if ((k as number) > n) n = k as number;
  return n;
};

// Lua: field_view.lua:1359
FieldView.radiusForLevel = function (levelIn: unknown): number {
  const level = tonumber(levelIn) ?? 0;
  const t = flashRadii();
  return lor(t[level], t[0]);
};

// Lua: field_view.lua:1366
// pokefirered/src/overworld.c:966
FieldView.setFlashLevel = function (levelIn: unknown): void {
  let level = tonumber(levelIn) ?? 0;
  if (level < 0 || level > FieldView.maxFlashLevel()) level = 0;
  FieldView.flashLevel = level;
  FieldView._flashRadius = undefined;
  // pokefirered/include/global.h:770 gSaveBlock1Ptr->flashLevel
  const Runtime: any = RuntimeMod; // package.loaded["src.core.game3.runtime"]
  const session = Runtime && Runtime.getSession && Runtime.getSession();
  if (session) session.flashLevel = level;
};

// Lua: field_view.lua:1378
// pokefirered/src/overworld.c:973
FieldView.getFlashLevel = function (): number {
  return FieldView.flashLevel;
};

// Lua: field_view.lua:1382
FieldView.setFlashRadius = function (radius: unknown): void {
  FieldView._flashRadius = tonumber(radius);
};

// Lua: field_view.lua:1387
// pokefirered/src/field_screen_effect.c:194
FieldView.animateFlashLevel = function (fromLevel: unknown, toLevel: unknown): any {
  const FieldEffects = modFieldEffects();
  if (FieldEffects && FieldEffects.animateFlashLevel) {
    return FieldEffects.animateFlashLevel(fromLevel, toLevel);
  }
  FieldView.setFlashLevel(toLevel);
  return undefined;
};

// Lua: field_view.lua:1397
// pokefirered/src/overworld.c:1756
FieldView.flashRadius = function (): number | undefined {
  if (FieldView._flashRadius != null) return FieldView._flashRadius;
  if (FieldView.flashLevel === 0) return undefined;
  return FieldView.radiusForLevel(FieldView.flashLevel);
};

// Lua: field_view.lua:1404
// pokefirered/src/field_camera.c:507
FieldView.setCameraPanning = function (x: unknown, y: unknown): void {
  FieldView.cameraPanX = tonumber(x) ?? 0;
  FieldView.cameraPanY = tonumber(y) ?? 0;
};

// Lua: field_view.lua:1409
function flashActive(): boolean {
  const Runtime: any = RuntimeMod; // package.loaded["src.core.game3.runtime"]
  const session = Runtime && Runtime.getSession && Runtime.getSession();
  const flashFlag = Sem.flag(session, "flashActive");
  const Space: any = SpaceMod; // package.loaded["src.core.game3.scripting.space"]
  if (Space && Space.store) {
    const Flags = modFlags();
    if (Flags && Flags.getFlag
        && truthy(Flags.getFlag(Space.store, null, flashFlag))) {
      return true;
    }
  }
  const flags = session && session.flags;
  return truthy(flags && flashFlag != null ? flags[flashFlag] : undefined);
}

// Lua: field_view.lua:1426
// pokefirered/src/overworld.c:958
function mapIsCave(def: any): boolean {
  if (def && def.cave != null) return (tonumber(def.cave) ?? 0) !== 0;
  return false;
}

// Lua: field_view.lua:1432
// pokefirered/src/overworld.c:956
FieldView.defaultFlashLevel = function (game: any, mapId: any): number {
  if (!mapIsCave(resolveMapDef(game, mapId))) return 0;
  if (rseFamily()) {
    // pokeemerald/src/overworld.c:971
    if (flashActive()) return 1;
    return FieldView.maxFlashLevel() - 1;
  }
  if (flashActive()) return 0;
  return FieldView.MAX_FLASH_LEVEL;
};

// Lua: field_view.lua:1444
// pokeemerald/src/field_screen_effect.c:994
FieldView.setPyramidLightRadius = function (radius: unknown): void {
  FieldView.setFlashRadius(radius);
};

// Lua: field_view.lua:1449
// pokeemerald/src/battle_pyramid.c:1187
FieldView.setBgPaletteOverride = function (slot: any, pal16: any): boolean {
  const NativeTileset: any = NativeTilesetMod; // require("src.core.game3.tileset_native")
  const prev = FieldView._bgPalOverride;
  if (prev && (pal16 == null || prev.slot !== slot)) {
    NativeTileset.resetSlotPalette(prev.pair, prev.slot);
    FieldView._bgPalOverride = undefined;
  }
  if (pal16 == null) return true;
  const Map: any = MapMod; // package.loaded["src.core.game3.map"]
  const def = Map && Map.currentDef && Map.currentDef();
  const pair = def && lor(def.pair, def.midLayout && def.midLayout.pair);
  if (!truthy(pair)) return false;
  if (!NativeTileset.setSlotPalette(pair, slot, pal16)) return false;
  FieldView._bgPalOverride = { pair, slot };
  return true;
};

// Lua: field_view.lua:1466
FieldView.setDefaultFlashLevel = function (game: any, mapId: any): number {
  FieldView._flashMapId = mapId;
  FieldView.setFlashLevel(FieldView.defaultFlashLevel(game, mapId));
  return FieldView.flashLevel;
};

// Lua: field_view.lua:1473
// pokefirered/src/field_screen_effect.c:90 -- rows[y] = { left, right } (a sequence)
function flashWindowRows(centerX: number, centerY: number, radius: number, w: number, h: number): Record<number, LuaTable> {
  const rows: Record<number, LuaTable> = {};
  let maxX = 255;
  if (w > maxX) maxX = w;
  const put = (y: number, left: number, right: number): void => {
    if (y >= 0 && y <= h) {
      if (left < 0) left = 0; else if (left > maxX) left = maxX;
      if (right < 0) right = 0; else if (right > maxX) right = maxX;
      rows[y] = [null, left, right];
    }
  };
  let xy = radius, err = radius, yx = 0;
  while (xy >= yx) {
    put(centerY - yx, centerX - xy, centerX + xy);
    put(centerY + yx, centerX - xy, centerX + xy);
    put(centerY - xy, centerX - yx, centerX + yx);
    put(centerY + xy, centerX - yx, centerX + yx);
    err = err - ((yx * 2) - 1);
    yx = yx + 1;
    if (err < 0) {
      err = err + 2 * (xy - 1);
      xy = xy - 1;
    }
  }
  return rows;
}

// Lua: field_view.lua:1501
// pokefirered/src/field_screen_effect.c:37 -- a sequence of { y, height, left, right }
FieldView.flashSpans = function (radius: number, wIn?: number, hIn?: number, centerXIn?: number, centerYIn?: number): LuaTable {
  const w = Math.floor(tonumber(wIn) ?? Display.W);
  const h = Math.floor(tonumber(hIn) ?? Display.H);
  const centerX = Math.floor(centerXIn ?? (w / 2));
  const centerY = Math.floor(centerYIn ?? (h / 2));
  const rows = flashWindowRows(centerX, centerY, Math.floor(radius), w, h);
  const spans: LuaTable = [null];
  let y = 0;
  while (y < h) {
    const r = rows[y];
    const left = r ? lor(r[1], 0) : 0;
    const right = r ? lor(r[2], 0) : 0;
    let y2 = y + 1;
    while (y2 < h) {
      const n = rows[y2];
      if ((n ? lor(n[1], 0) : 0) !== left || (n ? lor(n[2], 0) : 0) !== right) break;
      y2 = y2 + 1;
    }
    const span: FlashSpan = { y, height: y2 - y, left, right };
    spans[len(spans) + 1] = span;
    y = y2;
  }
  return spans;
};

// Lua: field_view.lua:1525
FieldView.flashSpansFor = function (radius: number, w: number, h: number, cx: number, cy: number): LuaTable {
  let spans = FieldView._flashSpans;
  if (spans
      && FieldView._flashSpanR === radius
      && FieldView._flashSpanCX === cx && FieldView._flashSpanCY === cy
      && FieldView._flashSpanW === w && FieldView._flashSpanH === h) {
    return spans;
  }
  spans = FieldView.flashSpans(radius, w, h, cx, cy);
  FieldView._flashSpans = spans;
  FieldView._flashSpanR = radius;
  FieldView._flashSpanCX = cx;
  FieldView._flashSpanCY = cy;
  FieldView._flashSpanW = w;
  FieldView._flashSpanH = h;
  return spans;
};

// Lua: field_view.lua:1544
// pokefirered/src/overworld.c:2077
function drawFlashMask(w: number, h: number): void {
  const radius = FieldView.flashRadius();
  if (radius == null) return;
  const cx = Math.floor(w / 2), cy = Math.floor(h / 2);
  const spans = FieldView.flashSpansFor(radius, w, h, cx, cy);
  G.setColor(0, 0, 0, 1);
  const n = len(spans);
  for (let i = 1; i <= n; i++) {
    const s: FlashSpan = spans[i];
    if (s.left > 0) {
      G.rectangle("fill", 0, s.y, s.left, s.height);
    }
    if (s.right < w) {
      G.rectangle("fill", s.right, s.y, w - s.right, s.height);
    }
  }
  G.setColor(1, 1, 1, 1);
}

const NO_OPTS: DrawOpts = {};

// Lua: field_view.lua:1562
FieldView.draw = function (game: any, canvasWIn?: number, canvasHIn?: number, optsIn?: DrawOpts): void {
  const canvasW = canvasWIn ?? Display.W;
  const canvasH = canvasHIn ?? Display.H;
  // `opts or {}`: a shared empty table (never written) instead of a new one
  const opts = optsIn ?? NO_OPTS;

  const SeagallopUi = modSeagallop();
  if (SeagallopUi && SeagallopUi.isActive && SeagallopUi.isActive()) {
    G.setColor(0, 0, 0, 1);
    G.rectangle("fill", 0, 0, canvasW, canvasH);
    G.setColor(1, 1, 1, 1);
    return;
  }

  const mapId = currentMapId(game);
  const mapDef = resolveMapDef(game, mapId);
  if (FieldView._flashMapId !== mapId) {
    FieldView.setDefaultFlashLevel(game, mapId);
  }
  if (!mapDef || (!truthy(mapDef.blocks) && !truthy(mapDef.midLayout)) || !truthy(mapDef.width)) {
    G.setColor(0.2, 0.35, 0.55, 1);
    G.rectangle("fill", 0, 0, canvasW, canvasH);
    // NOT FAITHFUL: love.graphics.print debug text; G.print draws nothing on the 3DS.
    G.print("game3: no layout " + tostring(mapId), 8, 8);
    G.setColor(1, 1, 1, 1);
    return;
  }

  const pp = playerPixels(game);
  const px = pp[0], py = pp[1], facing = pp[2], walkPhase = pp[3], stepFlip = pp[4];
  const playerYOff = lor(pp[6], 0);
  const playerXOff = lor(pp[7], 0);
  const Runtime: any = RuntimeMod; // package.loaded["src.core.game3.runtime"]
  const session = Runtime && Runtime.getSession && Runtime.getSession();
  if (session) {
    session.x = Math.floor(lor(px, 0) / CELL);
    session.y = Math.floor(lor(py, 0) / CELL);
    session.facing = facing;
    if (truthy(mapId)) session.map = mapId;
  }

  // pret CameraUpdate: always track the player. No map-rect clamp — edges
  // show connected neighbors (or border), same as walking mid-town.
  let camX = Math.floor(px + CELL / 2 - canvasW / 2);
  let camY = Math.floor(py + CELL / 2 - canvasH / 2);
  // pokefirered/src/field_camera.c:89
  camX = camX + lor(FieldView.cameraPanX, 0);
  camY = camY + lor(FieldView.cameraPanY, 0);

  const screenOx = Math.floor((canvasW - Display.W) / 2);
  const screenOy = Math.floor((canvasH - Display.H) / 2);

  // pret BuyMenuDrawMapBg (shop.c:731-734): Frame player & counter in left gap (X: 0..80, Y: 0..160)
  const ShopMenu = modShopMenu();
  if (ShopMenu && ShopMenu.isShopCamera && ShopMenu.isShopCamera()) {
    let fx = px, fy = py;
    if (facing === "up" || facing === "north") fy = fy - CELL;
    else if (facing === "down" || facing === "south") fy = fy + CELL;
    else if (facing === "left" || facing === "west") fx = fx - CELL;
    else if (facing === "right" || facing === "east") fx = fx + CELL;
    else fx = fx - CELL;
    const fTileX = Math.floor(fx / CELL);
    const fTileY = Math.floor(fy / CELL);
    const off = ShopMenu.shopCameraOffset && ShopMenu.shopCameraOffset();
    if (off) {
      camX = (fTileX + off.x) * CELL;
      camY = (fTileY + off.y) * CELL;
    } else {
      camX = (fTileX - 2) * CELL;
      camY = (fTileY - 4) * CELL;
    }
  }

  FieldView._billboard = truthy(opts.billboard)
    ? { vw: canvasW, vh: canvasH } : undefined;
  FieldView._viewW = canvasW; FieldView._viewH = canvasH;

  if (!truthy(opts.actorsOnly)) {
    const Map: any = MapMod; // package.loaded["src.core.game3.map"] or require(...)
    if (Map.refreshWorld) {
      Map.refreshWorld(game, Math.ceil(canvasW / CELL), Math.ceil(canvasH / CELL), mapId);
    }
  }

  // pocket-voxel seam (DrawOpts.world3d): the voxel world is the picture;
  // hand it this frame's actors and draw nothing.
  if (truthy(opts.world3d)) {
    const frame: WorldFrame = FieldView._worldFrame ?? { actors: [], camX: 0, camY: 0, px: 0, py: 0, mapId: undefined };
    frame.actors.length = 0;
    if (!truthy(FieldView.hideActors)) {
      const [under, over] = collectGame3Actors(
        game, mapDef, camX, camY, px, py, facing, walkPhase, stepFlip, playerYOff, playerXOff);
      for (let i = 1; under[i] != null; i++) frame.actors.push(under[i]);
      for (let i = 1; over[i] != null; i++) frame.actors.push(over[i]);
    }
    frame.camX = camX + canvasW / 2;
    frame.camY = camY + canvasH / 2;
    frame.px = px;
    frame.py = py;
    frame.mapId = mapId;
    FieldView._worldFrame = frame;
    return;
  }

  let usedNative = FieldView._nativeOverPair != null;
  if (!truthy(opts.actorsOnly)) {
    usedNative = drawNativeTiles(mapDef, camX, camY, canvasW, canvasH);
    if (usedNative) {
      // Native batch already covers viewport (+ overscan); wash skipped.
    } else {
      const tileset = resolveTileset(game, mapDef)[0];
      const atlas = loadAtlas(tileset);
      if (!atlas || !FieldView._blockTiles) {
        G.setColor(0.45, 0.2, 0.2, 1);
        G.rectangle("fill", 0, 0, canvasW, canvasH);
        // NOT FAITHFUL: love.graphics.print debug text; G.print draws nothing on the 3DS.
        G.print("game3: no tileset atlas", 8, 8);
        G.setColor(1, 1, 1, 1);
        return;
      }

      const bgSet = resolveBgSet(game, mapDef, daytimeFor(game, mapDef));
      const [wr, wg, wb] = washColor(bgSet);
      G.setColor(wr, wg, wb, 1);
      G.rectangle("fill", 0, 0, canvasW, canvasH);

      const bySlot = collectTileDraws(mapDef, camX, camY, canvasW, canvasH);
      drawTilesColored(atlas, bySlot, bgSet);
    }

    // Tall grass under body (pret lower OAM priority).
    {
      const FieldEffects = modFieldEffects();
      if (FieldEffects && FieldEffects.drawBehind) {
        FieldEffects.drawBehind(camX, camY);
      }
    }

    // Door opening/closing animation overlays (under actors).
    {
      const Doors = modDoors();
      if (Doors && Doors.draw) {
        Doors.draw(camX, camY, canvasW, canvasH);
      }
    }
    const FieldWeather = modFieldWeather();
    if (FieldWeather && FieldWeather.drawBelow) {
      // pokeemerald/src/field_weather_effect.c:1280
      FieldWeather.drawBelow(camX, camY, canvasW, canvasH);
    }
  }

  // pokefirered/src/field_effect.c:910
  if (!truthy(opts.actorsOnly)) {
    const Heal = modHeal();
    if (Heal && Heal.drawBalls) {
      const [sx, sy] = screenAnchor(px, py, camX, camY);
      G.push();
      G.translate(sx, sy);
      Heal.drawBalls(camX, camY);
      G.pop();
    }
  }

  // pokefirered/src/field_effect.c:3946: the Deoxys shatter blends only the BG
  // palettes to white, so the map washes out while the rock fragments (OBJ
  // sprites) keep their colours.  Painted here, between the last map layer and
  // the actors, for exactly that reason -- a Renderer.screenVeil would cover
  // the fragments too and the shatter would be invisible.
  if (!truthy(opts.actorsOnly)) {
    const FieldEffects = modFieldEffects();
    if (FieldEffects && FieldEffects.bgFlashAlpha) {
      const a = FieldEffects.bgFlashAlpha();
      if (truthy(a) && a > 0) {
        G.setColor(1, 1, 1, a);
        G.rectangle("fill", 0, 0, canvasW, canvasH);
        G.setColor(1, 1, 1, 1);
      }
    }
  }

  // S.S. Anne wake (pret oam.priority = 2, subpriority = 0xFF: under boat hull).
  if (!truthy(opts.actorsOnly)) {
    const SSAnne = modSSAnne();
    if (SSAnne && SSAnne.drawWake) {
      SSAnne.drawWake(camX, camY);
    }
  }

  // Collect Game3 actors partitioned by OAM priority.
  let underActors: LuaTable, overActors: LuaTable;
  // pokefirered/src/credits.c:717
  if (!(truthy(opts.skipActors) || truthy(FieldView.hideActors))) {
    [underActors, overActors] = collectGame3Actors(
      game, mapDef, camX, camY, px, py, facing, walkPhase, stepFlip, playerYOff, playerXOff);
  }

  // Draw Game3 actors with normal priority (under BG1 / overhead layer).
  if (underActors) {
    for (let i = 1; underActors[i] != null; i++) {
      drawSingleActor(game, mapDef, underActors[i], camX, camY);
    }
  }

  // pret BG1: metatile top layer covers normal OW sprites (roofs, desk counters, trees).
  if (usedNative && !truthy(opts.actorsOnly)) {
    drawNativeOverTiles();
  }

  // Draw Game3 actors with elevated priority (over BG1 / overhead layer, e.g. bridges/cliffs/jumping/escalators).
  if (overActors) {
    for (let i = 1; overActors[i] != null; i++) {
      drawSingleActor(game, mapDef, overActors[i], camX, camY);
    }
  }

  // Tall grass over feet (pret subpriority above avatar).
  if (!truthy(opts.actorsOnly)) {
    const FieldEffects = modFieldEffects();
    if (FieldEffects && FieldEffects.drawFront) {
      FieldEffects.drawFront(camX, camY, py);
    }
  }

  // pokefirered/src/field_effect.c:1024
  if (!truthy(opts.actorsOnly)) {
    const Heal = modHeal();
    if (Heal && Heal.drawMonitor) {
      const [sx, sy] = screenAnchor(px, py, camX, camY);
      G.push();
      G.translate(sx, sy);
      Heal.drawMonitor(camX, camY);
      G.pop();
    }
  }

  // Pokemon Center heal machine (screen-space OAM, pret FLDEFF_POKECENTER_HEAL).
  if (!truthy(opts.actorsOnly)) {
    const FieldEffects = modFieldEffects();
    if (FieldEffects && FieldEffects.drawOverlay) {
      G.push();
      G.translate(screenOx, screenOy);
      FieldEffects.drawOverlay(camX, camY);
      G.pop();
    }
    const SSAnne = modSSAnne();
    if (SSAnne && SSAnne.drawSmoke) {
      SSAnne.drawSmoke(camX, camY);
    }
    const FieldWeather = modFieldWeather();
    if (FieldWeather && FieldWeather.draw) {
      FieldWeather.draw(camX, camY, canvasW, canvasH, opts.exchangeCanvas);
    }
  }

  drawFlashMask(canvasW, canvasH);

  G.setColor(1, 1, 1, 1);
};

// Lua: field_view.lua:1801
/** Drop cached atlases/sprites (tileset hot-reload). */
FieldView.invalidate = function (): void {
  const Plan: any = CellPlanMod; // package.loaded["src.core.game3.field_plan"]
  if (Plan) Plan.invalidate();
  FieldView._atlas = undefined;
  FieldView._atlasPath = undefined;
  FieldView._quads = {};
  FieldView._blockTiles = undefined;
  FieldView._tilePalettes = undefined;
  FieldView._spriteCache = {};
  FieldView._logged = false;
  FieldView._loggedPal = false;
  FieldView._nativeBatch = undefined;
  FieldView._nativeBatches = undefined;
  FieldView._nativeOverBatches = undefined;
  FieldView._nativeVisibleCells = undefined;
  FieldView._nativeVisiblePairs = undefined;
  FieldView._nativeFreeUnder = undefined; FieldView._nativeFreeOver = undefined;
  FieldView._nativeSpriteSlots = 0;
  nativeSlots.under = 0; nativeSlots.over = 0;
  FieldView._nativeDirtyCells = undefined;
  FieldView._nativeLayout = undefined;
  FieldView._voidFrom = undefined; FieldView._voidMapDef = undefined;
  FieldView._lastCamX = undefined; FieldView._lastCamY = undefined;
  FieldView._nativeBx = undefined;
  FieldView._nativeBy = undefined;
  FieldView._nativeBaseBx = undefined;
  FieldView._nativeBaseBy = undefined;
  FieldView._nativeViewCols = undefined;
  FieldView._nativeViewRows = undefined;
  FieldView._nativePair = undefined;
  FieldView._nativeOverPair = undefined;
  FieldView._nativeDirty = true;
  nativeAtlasByPair = {};
  FieldView._loggedNative = false;
  FieldView._loggedNativeFallback = false;
  FieldView._flashSpans = undefined;
  FieldView._flashSpanR = undefined;
  const NativeTileset = modNativeTileset();
  if (NativeTileset && NativeTileset.invalidate) {
    NativeTileset.invalidate();
  }
  const OwSprites = modOwSprites();
  if (OwSprites && OwSprites.invalidate) {
    OwSprites.invalidate();
  }
  // package.loaded["src.core.game3.field_weather_rse"]: Emerald only, no module here (G3Lazy)
  const WeatherRse = G3Lazy["src.core.game3.field_weather_rse"];
  if (WeatherRse && WeatherRse.invalidate) WeatherRse.invalidate();
  const FieldEffects = modFieldEffects();
  if (FieldEffects && FieldEffects.invalidate) {
    FieldEffects.invalidate();
  }
};

// Lua: field_view.lua:1854
{
  const Assets: any = AssetsMod; // require("src.render.Assets")
  if (Assets.register && !Assets._game3FieldInvalidatorRegistered) {
    Assets._game3FieldInvalidatorRegistered = true;
    Assets.register(() => {
      // package.loaded["src.core.game3.field_view"]: this module
      const current = FieldView;
      if (current) current.invalidate();
    });
  }
}

// package.loaded["src.core.game3.field_view"] for void_fill (see its header)
VoidFill.loaded.fieldView = FieldView;

export default FieldView;
