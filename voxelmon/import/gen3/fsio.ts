// Port support for gen1recomp's FireRed importer (GPLv3 + additional terms;
// see LICENSE.md). The Node side: a file-backed Cache (gen1recomp
// src/import/gba/file_io.lua makeCache) and the ROM `imports` handle
// (file_io.lua makeImports / RomExtractorGen3 makeImports). Byte strings go to
// disk as latin1, i.e. byte for byte (lua.ts THE STRING RULE).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Cache } from "./cache.ts";
import type { Imports } from "./revision_view.ts";

// Lua: file_io.lua:31
export function makeCache(root: string): Cache {
  mkdirSync(root, { recursive: true });
  const made = new Set<string>();
  return {
    write(rel, bytes) {
      const path = join(root, rel);
      const dir = dirname(path);
      if (!made.has(dir)) { mkdirSync(dir, { recursive: true }); made.add(dir); }
      writeFileSync(path, typeof bytes === "string" ? Buffer.from(bytes, "latin1") : bytes);
      return true;
    },
    read(rel) {
      const path = join(root, rel);
      return existsSync(path) ? readFileSync(path).toString("latin1") : undefined;
    },
    exists(rel) { return existsSync(join(root, rel)); },
    info(rel) { return existsSync(join(root, rel)) ? { type: "file" } : undefined; },
  };
}

// Lua: RomExtractorGen3.lua:46 makeImports -- one ROM held in memory
export function makeImports(rom: Uint8Array, sha1: string, id: string): Imports {
  const canon = (x: string): string => (x === "leafgreen" ? "firered" : x);
  return {
    info(want) {
      if (canon(want) !== canon(id)) return undefined;
      return { id: canon(id), size: rom.length, md5: sha1, file: "memory" };
    },
    read(want, offset, length) {
      if (canon(want) !== canon(id)) return undefined;
      if (offset < 0 || length < 0 || offset + length > rom.length) return undefined;
      return Buffer.from(rom.subarray(offset, offset + length)).toString("latin1");
    },
    bytes() { return rom; },
  };
}

/** Read a ROM file. */
export function readRom(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}
