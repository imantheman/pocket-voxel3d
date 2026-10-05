// Port of gen1recomp src/import/gba/marts_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// Bake pokemart item and decoration lists (u16[] → ITEM_NONE) into CacheFS.
// Keys: raw GBA ptr number, decimal string, and Opcodes.key (g3:%08x).
// Lua differences: the marts map is a Map, so the number key 135678392 and
// the string key "135678392" stay two keys as in the Lua table. Item lists
// are 0-based arrays. NOT FAITHFUL: run() reads scripts.lua with
// readLuaLiteral (the Lua load()s it).

import { format, tonumber, tostring, rep } from "./lua.ts";
import { luaGet, luaKeys, luaLen, type LuaKey } from "./luatable.ts";
import { Versions } from "./versions.ts";
import type { Cache } from "./cache.ts";
import type { Rom } from "./rom.ts";
import { readLuaLiteral } from "./asset_pack.ts";
import { Opcodes } from "../../game/gen3/core/scripting/opcodes.ts";

type Tbl = Record<string, any>;
export type MartMap = Map<number | string, Tbl>;

// Lua: marts_extract.lua:13 (extract_island1's CACHE_ROOT; callers pass cacheRoot)
function default_cache_root(): string {
  return "data/generated/gba";
}

// Lua: marts_extract.lua:21
function is_rom_ptr(pv: unknown): boolean {
  const p = tonumber(pv);
  return p !== undefined && p >= 0x08000000 && p < 0x0A000000;
}

// pokeemerald/asm/macros/event.inc:1152
const OPS: Record<string, { kind: string; martType?: string }> = {
  pokemart: { kind: "items" },
  pokemartdecoration: { kind: "decorations", martType: "DECOR" },
  pokemartdecoration2: { kind: "decorations", martType: "DECOR2" },
};

// Lua: marts_extract.lua:33
function tag_entry(entry: Tbl, op: string | undefined): Tbl {
  const spec = op !== undefined ? OPS[op] : undefined;
  if (spec && spec.kind !== "items") {
    entry.kind = spec.kind;
    entry.martType = spec.martType;
  }
  return entry;
}

/** Lua's pairs() over a JS stand-in for a table. */
function pairsOf(val: object): [LuaKey, unknown][] {
  if (val instanceof Map) return Array.from(val.entries()) as [LuaKey, unknown][];
  return luaKeys(val).map((k) => [k, luaGet(val, k)]);
}

// Lua: marts_extract.lua:101
function serialize_lua(val: unknown, indent?: number): string {
  indent = indent ?? 0;
  const sp = rep("  ", indent);
  const sp1 = rep("  ", indent + 1);
  if (val === undefined || val === null) return "nil";
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "number") return tostring(val);
  if (typeof val === "string") return format("%q", val);
  if (typeof val !== "object") return "nil";
  const entries = pairsOf(val as object);
  entries.sort((x, y) => {
    const a = x[0], b = y[0];
    const ta = typeof a, tb = typeof b;
    if (ta === tb) {
      if (ta === "number") return (a as number) - (b as number);
      const sa = tostring(a), sb = tostring(b);
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    }
    return ta < tb ? -1 : 1;
  });
  const parts = ["{\n"];
  for (const [k, v] of entries) {
    let keyRepr: string;
    if (typeof k === "number") {
      keyRepr = format("[%d]", k);
    } else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
      keyRepr = k;
    } else {
      keyRepr = format("[%q]", tostring(k));
    }
    parts.push(sp1 + keyRepr + " = " + serialize_lua(v, indent + 1) + ",\n");
  }
  parts.push(sp + "}");
  return parts.join("");
}

export const MartsExtract = {
  CACHE_SUB: "scripts",
  FORMAT_VERSION: 1,
  MAX_ITEMS: 64,
  OPS,

  /** Read one mart list from ROM (halfwords until ITEM_NONE / 0); 0-based. */
  // Lua: marts_extract.lua:43
  readList(rom: Rom, gbaPtr: unknown): number[] | undefined {
    let off = rom.ptrOffset(tonumber(gbaPtr) ?? 0);
    if (off === undefined) return undefined;
    const items: number[] = [];
    for (let n = 1; n <= MartsExtract.MAX_ITEMS; n++) {
      const id = rom.u16(off);
      off = off + 2;
      if (id === 0) break;
      items.push(id);
    }
    return items;
  },

  /** Collect unique pokemart pointers from a scripts table (extract IR). [list, seen] */
  // Lua: marts_extract.lua:57
  collectPtrs(scripts: unknown): [number[], Record<number, string>] {
    const seen: Record<number, string> = {}, list: number[] = [];
    for (const [, rows] of pairsOf((scripts ?? {}) as object)) {
      if (rows !== null && typeof rows === "object") {
        for (let i = 1; i <= luaLen(rows as object); i++) {
          const row = luaGet(rows as object, i) as Tbl | undefined;
          if (row && OPS[row.op]) {
            const r1 = luaGet(row, 1);
            let ptr = tonumber(r1 ?? row.ptr ?? row.items);
            if (ptr === undefined && typeof r1 === "string") {
              const m = /^g3:([0-9A-Fa-f]+)$/.exec(r1);
              if (m) ptr = tonumber(m[1], 16);
            }
            if (is_rom_ptr(ptr) && seen[ptr!] === undefined) {
              seen[ptr!] = row.op;
              list.push(ptr!);
            }
          }
        }
      }
    }
    list.sort((a, b) => a - b);
    return [list, seen];
  },

  /** Build marts map from ROM + script IR. [marts, ptrCount] */
  // Lua: marts_extract.lua:81
  build(rom: Rom, scripts: unknown): [MartMap, number] {
    const marts: MartMap = new Map();
    const [ptrs, ops] = MartsExtract.collectPtrs(scripts);
    for (const ptr of ptrs) {
      const items = MartsExtract.readList(rom, ptr);
      if (items && items.length > 0) {
        const key = Opcodes.key(ptr);
        const entry = tag_entry({ ptr, key, items }, ops[ptr]);
        marts.set(ptr, entry);
        marts.set(tostring(ptr), entry);
        marts.set(key, entry);
      }
    }
    return [marts, ptrs.length];
  },

  /** Write data/generated/gba/scripts/marts.lua */
  // Lua: marts_extract.lua:138
  write(cache: Cache, root: string | undefined, marts: MartMap | undefined, meta?: { count?: number }): string {
    root = root ?? default_cache_root();
    const rel = root + "/" + MartsExtract.CACHE_SUB + "/marts.lua";
    const pack = {
      format_version: MartsExtract.FORMAT_VERSION,
      cache_version: Versions.CACHE_VERSION,
      count: (meta && meta.count) || 0,
      marts: marts ?? new Map(),
    };
    cache.write(rel, "return " + serialize_lua(pack) + "\n");
    return rel;
  },

  /** Full extract: scripts IR + ROM → marts.lua. [detail] or [undefined, err] */
  // Lua: marts_extract.lua:152
  run(rom: Rom, cache: Cache, opts: { cacheRoot?: string; scripts?: unknown } = {}): [Tbl | undefined, string?] {
    const root = opts.cacheRoot ?? default_cache_root();
    let scripts = opts.scripts;
    if (!scripts) {
      const src = cache.read(root + "/" + MartsExtract.CACHE_SUB + "/scripts.lua");
      if (src !== undefined) {
        try {
          scripts = readLuaLiteral(src);
        } catch {
          scripts = undefined;
        }
      }
    }
    if (scripts === null || typeof scripts !== "object") {
      return [undefined, "scripts.lua missing — run script extract first"];
    }
    const [marts, nPtr] = MartsExtract.build(rom, scripts);
    let nLists = 0;
    const seen = new Set<unknown>();
    for (const [k, e] of marts) {
      if (typeof k === "number" && e && e.items && !seen.has(e.ptr)) {
        seen.add(e.ptr);
        nLists = nLists + 1;
      }
    }
    const rel = MartsExtract.write(cache, root, marts, { count: nLists });
    return [{
      path: rel,
      ptrCount: nPtr,
      listCount: nLists,
      marts,
    }];
  },

  /**
   * Remap pokemart word operands in-place during script BFS (ptr → g3:key).
   * Also fills `outMarts` keyed like MartsExtract.build.
   */
  // Lua: marts_extract.lua:186
  remapRow(rom: Rom, row: Tbl | undefined, outMarts?: MartMap): void {
    if (!row) return;
    if (!OPS[row.op]) {
      return;
    }
    const ptr = tonumber(row[1] ?? row.ptr);
    if (!is_rom_ptr(ptr)) return;
    const key = Opcodes.key(ptr);
    if (outMarts && !outMarts.get(ptr!)) {
      const items = MartsExtract.readList(rom, ptr);
      if (items && items.length > 0) {
        const entry = tag_entry({ ptr, key, items }, row.op);
        outMarts.set(ptr!, entry);
        outMarts.set(tostring(ptr), entry);
        outMarts.set(key, entry);
      }
    }
    row[1] = key;
    row.ptr = key;
    row.items = key;
  },
};

export default MartsExtract;
