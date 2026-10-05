// Port of gen1recomp src/import/CacheFs.lua (GPLv3 + additional terms; see LICENSE.md).
// Routes ROM-derived cache I/O (data/generated, assets/generated) to the
// right place. This is the RUNTIME's CacheFs; the importer has its own
// (voxelmon/import/gen3/cache.ts).
//
// Brian's portable mode (a raw io.* cache next to the executable, mounted
// through PhysFS via FFI) does not exist on the 3DS: CacheFs.root() is
// always nil, so every call takes his love.filesystem path, which here is
// platform/fs.ts (reads: the save store, then the cooked cache via the host;
// writes: the save store). The path logic -- CacheFs.prefix, the
// GameVersion cachePrefix tried first by readActive, the ".." guard -- is
// his.
//
// Ported: root, portableError, write, readAt, read, readActive, loadActive,
// existsAt, exists, remove, the surface the FireRed runtime calls. Left out
// (importer / launcher / mod-installer only, none called from gen3):
// openWrite, removeDir, removeTree, migrateLegacyRedCache, mountVersion,
// unmountVersion, withMounted, _resetPortableForTests. Brian's CacheFs has
// no writeActive (core/trainer_pic.lua guards on it); neither has this one.

import { Fs } from "../../platform/fs.ts";
import { luaLoad } from "../../platform/luadata.ts";
import { GameVersion } from "../core/GameVersion.ts";

// Lua: CacheFs.lua:46
function withPrefix(rel: string): string {
  const p = CacheFs.prefix;
  if (p == null || p === "") return rel;
  return p + rel;
}

// Lua: CacheFs.lua:52
function unsafe_rel(rel: unknown): boolean {
  return typeof rel !== "string" || rel.includes("..");
}

// Lua: CacheFs.lua:306 (the love.filesystem branch: directories are implicit in the save store)
function ensureDirectory(_parent: string): [boolean, string?] {
  return [true];
}

export const CacheFs = {
  // Lua: CacheFs.lua:44
  prefix: "",

  // Lua: CacheFs.lua:243 -- NOT FAITHFUL (by construction): no portable mode, always nil
  root(): string | undefined {
    return undefined;
  },

  // Lua: CacheFs.lua:247
  portableError(): string | undefined {
    return undefined;
  },

  // Lua: CacheFs.lua:324 -- [ok, err]
  write(relIn: string, data: string | Uint8Array): [boolean, string?] {
    const rel = withPrefix(relIn);
    if (unsafe_rel(rel)) return [false, "unsafe cache path"];
    const parent = /^(.*)\/[^/]+$/.exec(rel);
    if (parent) {
      const [okDir, dirErr] = ensureDirectory(parent[1]!);
      if (!okDir) return [false, dirErr];
    }
    return [Fs.write(rel, data)];
  },

  // Lua: CacheFs.lua:384
  readAt(rel: string): string | undefined {
    if (unsafe_rel(rel)) return undefined;
    return Fs.read(rel);
  },

  // Lua: CacheFs.lua:401
  read(rel: string): string | undefined {
    return CacheFs.readAt(withPrefix(rel));
  },

  // Lua: CacheFs.lua:409
  readActive(rel: string): string | undefined {
    const prefix = GameVersion.cachePrefix();
    const saved = CacheFs.prefix;
    CacheFs.prefix = "";
    let bytes = CacheFs.read(prefix + rel);
    CacheFs.prefix = saved;
    if (typeof bytes !== "string") {
      bytes = CacheFs.read(rel);
    }
    if (typeof bytes === "string") return bytes;
    return undefined;
  },

  // Lua: CacheFs.lua:428 -- [value] or [undefined, err]
  loadActive(rel: string): [unknown, string?] {
    const bytes = CacheFs.readActive(rel);
    if (typeof bytes === "string") {
      const [chunk, err] = luaLoad(bytes, "@" + GameVersion.cachePrefix() + rel);
      if (!chunk) return [undefined, err];
      try {
        return [chunk()];
      } catch (e) {
        return [undefined, String((e as Error).message ?? e)];
      }
    }
    const [chunk, err] = Fs.load(rel);
    if (!chunk) return [undefined, err];
    try {
      return [chunk()];
    } catch (e) {
      return [undefined, String((e as Error).message ?? e)];
    }
  },

  // Lua: CacheFs.lua:450
  existsAt(rel: string): boolean {
    if (unsafe_rel(rel)) return false;
    return Fs.getInfo(rel, "file") !== undefined;
  },

  // Lua: CacheFs.lua:466
  exists(rel: string): boolean {
    return CacheFs.existsAt(withPrefix(rel));
  },

  // Lua: CacheFs.lua:471
  remove(relIn: string): boolean | undefined {
    const rel = withPrefix(relIn);
    if (unsafe_rel(rel)) return false;
    Fs.remove(rel);
    return undefined;
  },
};

export default CacheFs;
