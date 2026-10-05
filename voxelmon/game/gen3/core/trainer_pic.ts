// Port of gen1recomp src/core/game3/trainer_pic.lua (GPLv3 + additional terms; see LICENSE.md).
// Trainer front / player back pics (cache only).

import { CachePaths } from "./cache_paths.ts";
import { Dataset } from "./dataset.ts";
import { CacheFs } from "../shared/import/CacheFs.ts";
import { Profile } from "./profile.ts";
import { G } from "../platform/graphics.ts";
import { newImageData, type Image, type ImageData } from "../platform/image.ts";
import { tostring, tonumber, truthy } from "../../../import/gen3/lua.ts";

/** A cache handle as Brian's modules take it: `cache:read(rel)`. */
export interface TrainerPicCache {
  read(rel: string): string | null | undefined;
  [k: string]: any;
}

export interface TrainerFront { image: Image; w: number; h: number }
export interface TrainerBack { image: Image; w: number; h: number; frames: number }

// Lua: trainer_pic.lua:3 (require("src.import.gba.extract_island1"))
// NOT FAITHFUL (module only): extract_island1 is not ported (no TS module, no
// stub). Its CACHE_ROOT reads through to CachePaths.CACHE_ROOT
// (extract_island1.lua:21), so that is read here directly; same value.
const Extract = {
  get CACHE_ROOT(): string { return CachePaths.CACHE_ROOT; },
};

// Lua: trainer_pic.lua:11
function cache_root(): string {
  return (Extract.CACHE_ROOT ?? "data/generated/gba") + "/trainers";
}

// Lua: trainer_pic.lua:15
function resolve_cache(cache: any): TrainerPicCache {
  if (truthy(cache) && truthy(cache.read)) return cache;
  // pcall(require, "src.core.game3.dataset"): the module is always there.
  if (Dataset && Dataset.cache) {
    return Dataset.cache();
  }
  return {
    // pcall(require, "src.import.CacheFs"): the module is always there.
    read: (rel: string): string | undefined => {
      if (CacheFs && CacheFs.readActive) {
        return CacheFs.readActive(rel);
      }
      return undefined;
    },
    // CacheFs has no writeActive (in Brian's either), so this returns nil.
    write: (rel: string, bytes: string | Uint8Array): unknown => {
      const fs = CacheFs as Record<string, any>;
      if (fs && fs.writeActive) {
        return fs.writeActive(rel, bytes);
      }
      return undefined;
    },
  };
}

// Lua: trainer_pic.lua:38
// (`love and love.image and love.graphics` always holds here.)
function image_from_rgba(rgba: string | null | undefined, w: number, h: number): Image | null {
  if (rgba == null || rgba.length < w * h * 4) return null;
  let ok: boolean, imageData: ImageData | undefined;
  try {
    imageData = newImageData(w, h, "rgba8", rgba);
    ok = true;
  } catch {
    ok = false;
  }
  if (!ok || !imageData) return null;
  const image = G.newImage(imageData);
  if (image.setFilter) image.setFilter("nearest", "nearest");
  return image;
}

// Lua: trainer_pic.lua:48
function read_pic_rgba(cacheRel: string, frames: number): string | null {
  const cache = TrainerPic._cache;
  if (!(truthy(cache) && truthy(cache!.read))) return null;
  const d = cache!.read(cacheRel);
  if (truthy(d) && d!.length >= 64 * 64 * frames * 4) return d!;
  return null;
}

// Lua: trainer_pic.lua:56
function install(cache?: any): void {
  TrainerPic._cache = resolve_cache(cache);
  TrainerPic._front = {};
  TrainerPic._back = {};
}

/** Opponent trainer front pic (64x64). Returns nil if unavailable (no placeholder). */
// Lua: trainer_pic.lua:63
function front(picIdIn: unknown): TrainerFront | null {
  const picId = tonumber(picIdIn);
  if (picId == null || picId < 0) return null;
  if (truthy(TrainerPic._front[picId])) return TrainerPic._front[picId]!;
  if (!truthy(TrainerPic._cache)) TrainerPic.install(null);
  const rel = cache_root() + "/front/" + tostring(picId) + ".rgba";
  const rgba = read_pic_rgba(rel, 1);
  const image = image_from_rgba(rgba, 64, 64);
  if (!image) return null;
  const entry: TrainerFront = { image, w: 64, h: 64 };
  TrainerPic._front[picId] = entry;
  return entry;
}

/** Player back pic strip (64x320, 5 frames). gender 0=boy, 1=girl. */
// Lua: trainer_pic.lua:78
function back(genderIn?: unknown): TrainerBack | null {
  let gender = tonumber(genderIn) ?? 0;
  if (gender < 0) return null;
  // pokefirered/src/data/trainer_graphics/back_pic_tables.h:2
  if (gender > 5 && Profile.family() !== "rse") gender = 0;
  if (truthy(TrainerPic._back[gender])) return TrainerPic._back[gender]!;
  if (!truthy(TrainerPic._cache)) TrainerPic.install(null);
  const rel = cache_root() + "/back_" + tostring(gender) + ".rgba";
  const rgba = read_pic_rgba(rel, 1);
  if (rgba == null) return null;
  const actualFrames = Math.floor(rgba.length / (64 * 64 * 4));
  if (actualFrames <= 0) return null;
  const image = image_from_rgba(rgba, 64, 64 * actualFrames);
  if (!image) return null;
  const entry: TrainerBack = { image, w: 64, h: 64 * actualFrames, frames: actualFrames };
  TrainerPic._back[gender] = entry;
  return entry;
}

// Lua: trainer_pic.lua:5-9, then the functions in order.
export const TrainerPic = {
  _front: {} as Record<number, TrainerFront | undefined>,
  _back: {} as Record<number, TrainerBack | undefined>,
  _cache: null as TrainerPicCache | null,
  install,
  front,
  back,
};

export default TrainerPic;
