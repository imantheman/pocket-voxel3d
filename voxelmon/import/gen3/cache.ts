// Port support for gen1recomp's FireRed importer (GPLv3 + additional terms;
// see LICENSE.md). The `cache` handle extractors write through (mod.cache /
// CacheFs in the Lua): cache-relative paths, byte-string or Uint8Array bodies.
// Node-free, so runtime code can import modules that take a Cache; the file
// system implementation is in fsio.ts.

export interface Cache {
  write(rel: string, bytes: string | Uint8Array): boolean;
  read(rel: string): string | undefined;
  exists(rel: string): boolean;
  info(rel: string): { type: "file" } | undefined;
}

/** An in-memory cache (tests, and the cook's in-process import). */
export function memoryCache(): Cache & { files: Map<string, string | Uint8Array> } {
  const files = new Map<string, string | Uint8Array>();
  const asString = (v: string | Uint8Array): string => {
    if (typeof v === "string") return v;
    let s = "";
    for (let i = 0; i < v.length; i += 0x2000) s += String.fromCharCode.apply(null, v.subarray(i, i + 0x2000) as unknown as number[]);
    return s;
  };
  return {
    files,
    write(rel, bytes) { files.set(rel, bytes); return true; },
    read(rel) { const v = files.get(rel); return v === undefined ? undefined : asString(v); },
    exists(rel) { return files.has(rel); },
    info(rel) { return files.has(rel) ? { type: "file" } : undefined; },
  };
}

/**
 * CacheFs as the extractors call it statically (CacheFs.write(rel, ...),
 * CacheFs.read, CacheFs.exists): bound to one Cache for the run.
 */
let bound: Cache | undefined;
export const CacheFs = {
  prefix: "",
  bind(cache: Cache | undefined): void { bound = cache; },
  bound(): Cache {
    if (!bound) throw new Error("CacheFs: no cache bound for this import");
    return bound;
  },
  // Lua: CacheFs.lua:324 -- [ok, err]
  write(rel: string, data: string | Uint8Array): [boolean, string?] {
    rel = CacheFs.prefix + rel;
    if (rel.includes("..")) return [false, "unsafe cache path"];
    return [CacheFs.bound().write(rel, data)];
  },
  read(rel: string): string | undefined { return CacheFs.bound().read(CacheFs.prefix + rel); },
  readAt(rel: string): string | undefined { return CacheFs.bound().read(rel); },
  readActive(rel: string): string | undefined { return CacheFs.bound().read(rel); },
  exists(rel: string): boolean { return CacheFs.bound().exists(CacheFs.prefix + rel); },
  existsAt(rel: string): boolean { return CacheFs.bound().exists(rel); },
};

export default CacheFs;
