// Port of gen1recomp src/import/gba/syms.lua (GPLv3 + additional terms; see LICENSE.md).
// Symbol tables (name -> ROM offset / size / object) generated from a game's
// ELF, parsed lazily per game.
// NOT FAITHFUL: Emerald only -- the only symbol data gen1recomp ships
// (src/import/gba/syms/emerald.lua, emerald_funcs.lua, 2.7 MB) is Emerald's
// and is not ported. Syms.register() takes a source table of the same shape
// ({ objs, collide, data } strings); a game with no registered source throws
// as the Lua does for a missing syms module.

import { format, tonumber, tostring } from "./lua.ts";

export interface SymsSource { objs: string; collide: string; data: string; [k: string]: unknown }
interface SymRow { name: string; off: number; size: number; span: boolean; obj?: string }
interface Parsed { byName: Record<string, SymRow>; byOff: Record<number, string[]>; collide: Record<string, boolean> }

export interface SymsInstance {
  game: string;
  has(name: string): boolean;
  off(name: string): number;
  addr(name: string): number;
  size(name: string): number;
  sizeKind(name: string): string;
  obj(name: string): string | undefined;
  count(name: string, stride: number): number;
  namesAt(off: number): string[];
  hasFunc(name: string): boolean;
  funcOff(name: string): number;
  funcAt(ptr: unknown): string | undefined;
}

/** The src.import.gba.syms.<key> modules that exist (none are ported). */
const SOURCES: Record<string, SymsSource> = {};

let loaded: Record<string, Parsed> = {};

// Lua: syms.lua:5
function parse(src: SymsSource): Parsed {
  const objs: string[] = [];
  for (const m of src.objs.matchAll(/[^\n]+/g)) objs.push(m[0]);
  const collide: Record<string, boolean> = {};
  for (const m of src.collide.matchAll(/[^\n]+/g)) collide[m[0]] = true;
  const byName: Record<string, SymRow> = {}, byOff: Record<number, string[]> = {};
  for (const m of src.data.matchAll(/([^ \n]+) ([0-9A-Fa-f]+) (~?[0-9A-Fa-f]+) ?(\d*)/g)) {
    const name = m[1]!, off = m[2]!, size = m[3]!, obj = m[4]!;
    const span = size.substring(0, 1) === "~";
    const row: SymRow = {
      name,
      off: tonumber(off, 16)!,
      size: tonumber(span ? size.substring(1) : size, 16)!,
      span,
      obj: obj !== "" ? objs[tonumber(obj)! - 1] : undefined,
    };
    if (collide[name]) {
      byName[(row.obj ?? "") + ":" + name] = row;
    } else {
      byName[name] = row;
      if (row.obj) byName[row.obj + ":" + name] = row;
    }
    let at = byOff[row.off];
    if (!at) { at = []; byOff[row.off] = at; }
    at.push(name);
  }
  return { byName, byOff, collide };
}

// Lua: syms.lua:35
function lazy(game: string, suffix: string): Parsed {
  const key = game + suffix;
  const t = loaded[key];
  if (t) return t;
  const src = SOURCES[key];
  if (src === null || typeof src !== "object") {
    throw new Error("syms: no symbol table for '" + tostring(game) + "' (NOT FAITHFUL: Emerald only, not ported)");
  }
  const p = parse(src);
  delete SOURCES[key];
  loaded[key] = p;
  return p;
}

// Lua: syms.lua:48
function row(t: Parsed, game: string, name: string, what: string): SymRow {
  const r = t.byName[name];
  if (r) return r;
  if (t.collide[name]) {
    throw new Error(format("syms(%s): %s '%s' is defined in several objects; use 'file.o:%s'",
      game, what, name, name));
  }
  throw new Error(format("syms(%s): unknown %s '%s'", game, what, tostring(name)));
}

let instances: Record<string, SymsInstance> = {};

export const Syms = {
  /** Register a src.import.gba.syms.<key> source (e.g. "emerald", "emerald_funcs"). */
  register(key: string, src: SymsSource): void {
    SOURCES[key] = src;
    delete loaded[key];
  },

  // Lua: syms.lua:60
  of(game: string): SymsInstance {
    if (!(typeof game === "string" && game !== "")) throw new Error("Syms.of needs a game id");
    const hit = instances[game];
    if (hit) return hit;
    const data = (): Parsed => lazy(game, "");
    const funcs = (): Parsed => lazy(game, "_funcs");
    const S: SymsInstance = {
      game,
      has(name) {
        return data().byName[name] !== undefined;
      },
      off(name) {
        return row(data(), game, name, "symbol").off;
      },
      addr(name) {
        return 0x08000000 + row(data(), game, name, "symbol").off;
      },
      size(name) {
        return row(data(), game, name, "symbol").size;
      },
      sizeKind(name) {
        return row(data(), game, name, "symbol").span ? "span" : "elf";
      },
      obj(name) {
        return row(data(), game, name, "symbol").obj;
      },
      count(name, stride) {
        if (!(typeof stride === "number" && stride > 0)) throw new Error("Syms.count needs a positive stride");
        const size = row(data(), game, name, "symbol").size;
        if (size % stride !== 0) {
          throw new Error(format("syms(%s): %s size %d is not a multiple of %d", game, name, size, stride));
        }
        return size / stride;
      },
      namesAt(off) {
        const at = data().byOff[off];
        if (!at) return [];
        return at.slice();
      },
      hasFunc(name) {
        return funcs().byName[name] !== undefined;
      },
      funcOff(name) {
        return row(funcs(), game, name, "function").off;
      },
      funcAt(ptr) {
        let off = tonumber(ptr);
        if (off === undefined) return undefined;
        if (off >= 0x08000000) off = off - 0x08000000;
        if (off % 2 === 1) off = off - 1;
        const at = funcs().byOff[off];
        return at ? at[0] : undefined;
      },
    };
    instances[game] = S;
    return S;
  },

  // Lua: syms.lua:130
  reset(): void {
    loaded = {};
    instances = {};
  },
};

export default Syms;
