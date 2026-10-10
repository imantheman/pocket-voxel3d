// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). love.filesystem as gen1recomp's FRLG runtime uses it.
//
// Reads: a file the game wrote this run or earlier (the save store) wins,
// else the cooked cache (host.read). Writes go to the save store. Paths are
// Brian's ("data/generated/gba/...", "saves/firered/slot1.lua"); the host
// maps cache paths onto the cooked dataset.

import { getHost } from "./host.ts";
import { FileData } from "./image.ts";
import { luaLoad } from "./luadata.ts";
import { saveStore } from "./savefs.ts";
import { cacheCap } from "./membudget.ts";

function norm(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

export interface FileInfo { type: "file" | "directory"; size?: number; modtime?: number }

// NOT FAITHFUL (memory): the runtime writes derived pixel caches back
// through love.filesystem -- a tileset pair's baked atlas layers
// (data/generated/gba/native/<pair>/atlas_*.rgba), up to 1.4 MB a pair --
// so the next boot need not bake them. On the 3DS there is no next boot to
// spare (the card holds the cooked cache) and the save store kept them in
// memory: a tour of the region kept 22 MB of them. They are held here
// instead, the last used up to DERIVED_CAP bytes (less when the app heap
// runs short: membudget.ts); one let go is baked again when its pair is
// next decoded, as on a first visit.
const DERIVED_CAP = 3 * 1024 * 1024;
const DERIVED_LEAST = 768 * 1024;
const derived = new Map<string, string>();
let derivedBytes = 0;
const isDerived = (p: string): boolean => p.startsWith("data/") && p.endsWith(".rgba");

function derivedPut(p: string, text: string): void {
  const old = derived.get(p);
  if (old !== undefined) { derivedBytes -= old.length; derived.delete(p); }
  const cap = cacheCap(DERIVED_CAP, DERIVED_LEAST, derivedBytes);
  if (text.length > cap) return;
  derived.set(p, text);
  derivedBytes += text.length;
  // a Map iterates in insertion order: the first is the least recently used
  for (const [k, v] of derived) {
    if (derivedBytes <= cap) break;
    derived.delete(k);
    derivedBytes -= v.length;
  }
}

/** love.filesystem.read(path) -> contents (byte string), or undefined (Lua nil). */
export function read(path: string): string | undefined {
  const p = norm(path);
  if (isDerived(p)) {
    const d = derived.get(p);
    if (d !== undefined) { derived.delete(p); derived.set(p, d); return d; }
  }
  const saved = saveStore().read(p);
  if (saved !== undefined) return saved;
  return getHost().read(p);
}

/** love.filesystem.getInfo(path [, filtertype]) */
export function getInfo(path: string, filter?: "file" | "directory"): FileInfo | undefined {
  const p = norm(path);
  const saved = (isDerived(p) ? derived.get(p) : undefined) ?? saveStore().read(p);
  if (saved !== undefined) return filter === "directory" ? undefined : { type: "file", size: saved.length };
  const st = saveStore();
  if (filter !== "file" && st.list && st.list().some((n) => n.startsWith(p + "/"))) return { type: "directory" };
  if (!getHost().exists(p)) return undefined;
  // NOT FAITHFUL: the host does not tell files from directories; a path
  // with an extension is taken for a file
  const isFile = /\.[A-Za-z0-9]+$/.test(p);
  if (filter && filter !== (isFile ? "file" : "directory")) return undefined;
  return { type: isFile ? "file" : "directory" };
}

/** love.filesystem.write(path, data) -> success */
export function write(path: string, data: string | Uint8Array): boolean {
  const text = typeof data === "string" ? data : bytesToString(data);
  const p = norm(path);
  if (isDerived(p)) { derivedPut(p, text); return true; }
  return saveStore().write(p, text);
}

/** love.filesystem.remove(path) */
export function remove(path: string): boolean {
  const st = saveStore();
  return st.remove ? st.remove(norm(path)) : false;
}

/** love.filesystem.createDirectory: directories are implicit. */
export function createDirectory(_path: string): boolean { return true; }

/** love.filesystem.getDirectoryItems(dir): what the save store holds under dir. */
export function getDirectoryItems(dir: string): string[] {
  const d = norm(dir).replace(/\/$/, "") + "/";
  const st = saveStore();
  const names = new Set<string>();
  for (const n of st.list ? st.list() : []) if (n.startsWith(d)) names.add(n.slice(d.length).split("/")[0]!);
  return [...names].sort();
}

/** love.filesystem.load(path) -> [chunk, err] (data chunks only; luadata.ts). */
export function load(path: string): [(() => unknown) | undefined, string | undefined] {
  const src = read(path);
  if (src === undefined) return [undefined, `${path}: not found`];
  return luaLoad(src, "@" + path);
}

/** love.filesystem.newFileData(contents, name) / newFileData(path). */
export function newFileData(a: string, name?: string): FileData {
  if (name !== undefined) return new FileData(a, name);
  const src = read(a);
  if (src === undefined) throw new Error(`newFileData: ${a} not found`);
  return new FileData(src, a);
}

export function getSaveDirectory(): string { return "save"; }
export function getIdentity(): string { return "pocket-voxel-firered"; }

function bytesToString(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return s;
}

export const Fs = { read, getInfo, write, remove, createDirectory, getDirectoryItems, load, newFileData, getSaveDirectory, getIdentity };
export default Fs;
