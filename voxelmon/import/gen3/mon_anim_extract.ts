// Port of gen1recomp src/import/gba/mon_anim_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// Front/back battle animation tables (pokemon/front_anims.lua, back_anims.lua).
// Only the RSE plans run it (FRLG has no MON_FRONT_ANIMS_PTR_TABLE).
// NOT FAITHFUL: with no Versions.SYMS the Lua requires src.import.gba.syms
// (the Emerald symbol tables, out of scope); here that throws.
// Lists the Lua builds as 1-based sequences (lists, per-species ids) are
// 0-based arrays; byte tables keep the Lua's first key (0 or 1).

import { Versions } from "./versions.ts";
import { format, tonumber, tostring } from "./lua.ts";
import type { Cache } from "./cache.ts";
import type { Rom } from "./rom.ts";

export interface MonAnimSyms {
  namesAt(off: number): string[];
  has(name: string): boolean;
  off(name: string): number;
  size(name: string): number;
  funcAt?(addr: number): string | string[] | undefined;
}
export interface MonAnimCmd { op?: string; target?: number; count?: number; frame?: number; duration?: number; hFlip?: boolean; vFlip?: boolean }
export interface MonAnimPack {
  lists: { name: string; cmds: MonAnimCmd[] }[];
  species: Record<number, number[]>;
  count: number;
  animIds: Record<number, number>;
  animDelays: Record<number, number>;
  functions: Record<number, string>;
  backSets: Record<number, number>;
  backIds: Record<number, number>;
  backNatureMods: Record<number, number>;
}

// Lua: mon_anim_extract.lua:11
function need(key: string): any {
  const v = Versions[key];
  if (v === undefined || v === null) {
    throw new Error("mon_anim_extract: Versions." + key + " is not set for " + tostring(Versions.active()));
  }
  return v;
}

// Lua: mon_anim_extract.lua:19
function syms(): MonAnimSyms {
  const S = Versions.SYMS;
  if (S === undefined || S === null) {
    throw new Error("mon_anim_extract: src.import.gba.syms is not ported (" + tostring(Versions.active()) + ")");
  }
  return S;
}

// Lua: mon_anim_extract.lua:27 -- [bare, key] or undefined
function named(S: MonAnimSyms, off: number, prefix: string, obj?: string): [string, string] | undefined {
  for (const n of S.namesAt(off)) {
    const bare = /[^:]+$/.exec(n)![0];
    if (bare.slice(0, prefix.length) === prefix) {
      const key = S.has(bare) ? bare : obj ? obj + ":" + bare : undefined;
      if (key && S.has(key) && S.off(key) === off) return [bare, key];
    }
  }
  return undefined;
}

// Lua: mon_anim_extract.lua:64
function bytes(rom: Rom, base: number, count: number, first = 0): Record<number, number> {
  const out: Record<number, number> = {};
  for (let i = 0; i <= count - 1; i++) out[first + i] = rom.get(base + i);
  return out;
}

// Lua: mon_anim_extract.lua:128
function cmd_lua(c: MonAnimCmd): string {
  if (c.op === "end") return '{ op = "end" }';
  if (c.op === "jump") return format('{ op = "jump", target = %d }', c.target);
  if (c.op === "loop") return format('{ op = "loop", count = %d }', c.count);
  let flags = "";
  if (c.hFlip) flags += ", hFlip = true";
  if (c.vFlip) flags += ", vFlip = true";
  return format("{ frame = %d, duration = %d%s }", c.frame, c.duration, flags);
}

// Lua: mon_anim_extract.lua:138
function byte_list(lines: string[], key: string, t: Record<number, number>, n: number, first = 0): void {
  const row: string[] = [];
  for (let i = first; i <= first + n - 1; i++) row.push(tostring(t[i] ?? 0));
  const head = first === 1 ? "" : format("[%d] = ", first);
  lines.push(format("  %s = { %s%s },", key, head, row.join(", ")));
}

// Lua: mon_anim_extract.lua:180
function count_of(t: object): number {
  return Object.keys(t).length;
}

export const MonAnimExtract = {
  FORMAT_VERSION: 1,
  FRONT_FILE: "pokemon/front_anims.lua",
  BACK_FILE: "pokemon/back_anims.lua",
  REQUIRED: ["pokemon/front_anims.lua", "pokemon/back_anims.lua"],
  MAX_CMDS: 64,

  // Lua: mon_anim_extract.lua:39 (pokeemerald/include/sprite.h:74)
  decodeCmds(rom: Rom, off: number, maxCmds?: number): MonAnimCmd[] {
    const cmds: MonAnimCmd[] = [];
    for (let i = 0; i <= (maxCmds ?? MonAnimExtract.MAX_CMDS) - 1; i++) {
      const lo = rom.u16(off + i * 4);
      const hi = rom.u16(off + i * 4 + 2);
      if (lo === 0xffff) {
        cmds.push({ op: "end" });
        return cmds;
      } else if (lo === 0xfffe) {
        cmds.push({ op: "jump", target: hi % 64 });
        return cmds;
      } else if (lo === 0xfffd) {
        cmds.push({ op: "loop", count: hi % 64 });
      } else {
        cmds.push({
          frame: lo,
          duration: hi % 64,
          hFlip: Math.floor(hi / 64) % 2 === 1,
          vFlip: Math.floor(hi / 128) % 2 === 1,
        });
      }
    }
    throw new Error(format("mon_anim_extract: anim cmd list at 0x%X has no END/JUMP", off));
  },

  // Lua: mon_anim_extract.lua:71
  extract(rom: Rom): MonAnimPack {
    const S = syms();
    const tableOff: number = need("MON_FRONT_ANIMS_PTR_TABLE");
    const tableObj: string | undefined = Versions.MON_FRONT_ANIMS_OBJ;
    const count: number = need("MON_FRONT_ANIMS_COUNT");
    const lists: MonAnimPack["lists"] = [];
    const listIndex: Record<number, number> = {};
    const species: Record<number, number[]> = {};

    const listId = (off: number): number => {
      const hit = listIndex[off];
      if (hit !== undefined) return hit;
      const id = lists.length + 1;
      listIndex[off] = id;
      const nm = named(S, off, "sAnim_", tableObj);
      lists[id - 1] = { name: nm ? nm[0] : format("anim_%X", off), cmds: MonAnimExtract.decodeCmds(rom, off) };
      return id;
    };

    for (let sp = 0; sp <= count - 1; sp++) {
      const arr = Versions.gbaToFile(rom.u32(tableOff + sp * 4));
      if (arr !== undefined) {
        const nm = named(S, arr, "sAnims_", tableObj);
        if (!nm) throw new Error(format("mon_anim_extract: species %d anim table at 0x%X has no sAnims_ symbol", sp, arr));
        const n = S.size(nm[1]) / 4;
        const ids: number[] = [];
        for (let i = 0; i <= n - 1; i++) {
          const cmdOff = Versions.gbaToFile(rom.u32(arr + i * 4));
          ids[i] = cmdOff !== undefined ? listId(cmdOff) : 0;
        }
        species[sp] = ids;
      }
    }

    const fnCount: number = need("MON_ANIM_FUNCTIONS_COUNT");
    const fnBase: number = need("MON_ANIM_FUNCTIONS");
    const functions: Record<number, string> = {};
    for (let i = 0; i <= fnCount - 1; i++) {
      const ptr = rom.u32(fnBase + i * 4);
      const names = S.funcAt ? S.funcAt(ptr) : undefined;
      const fname = Array.isArray(names) ? names[0] : names;
      functions[i] = fname ?? format("func_%X", ptr);
    }

    return {
      lists,
      species,
      count,
      animIds: bytes(rom, need("MON_FRONT_ANIM_IDS"), need("MON_FRONT_ANIM_IDS_COUNT"), 1),
      animDelays: bytes(rom, need("MON_ANIMATION_DELAYS"), need("MON_ANIMATION_DELAYS_COUNT"), 1),
      functions,
      backSets: bytes(rom, need("MON_BACK_ANIM_SETS"), need("MON_BACK_ANIM_SETS_COUNT")),
      backIds: bytes(rom, need("MON_BACK_ANIM_IDS"), need("MON_BACK_ANIM_IDS_COUNT")),
      backNatureMods: bytes(rom, need("MON_BACK_NATURE_MODS"), need("MON_BACK_NATURE_MODS_COUNT")),
    };
  },

  // Lua: mon_anim_extract.lua:146
  frontLua(pack: MonAnimPack): string {
    const lines = [
      "return {",
      format("  format = %d,", MonAnimExtract.FORMAT_VERSION),
      format("  count = %d,", pack.count),
      "  lists = {",
    ];
    pack.lists.forEach((l, i) => {
      const cmds = l.cmds.map(cmd_lua);
      lines.push(format("    [%d] = { name = %q, cmds = { %s } },", i + 1, l.name, cmds.join(", ")));
    });
    lines.push("  },");
    lines.push("  species = {");
    for (let sp = 0; sp <= pack.count - 1; sp++) {
      if (pack.species[sp]) lines.push(format("    [%d] = { %s },", sp, pack.species[sp]!.join(", ")));
    }
    lines.push("  },");
    const n = count_of(pack.animIds);
    byte_list(lines, "animIds", pack.animIds, n, 1);
    byte_list(lines, "animDelays", pack.animDelays, n, 1);
    lines.push("  functions = {");
    // #pack.functions: keys 0..fnCount-1, so the border is fnCount - 1
    let maxFn = 0;
    while (pack.functions[maxFn + 1] !== undefined) maxFn++;
    for (let i = 0; i <= maxFn; i++) lines.push(format("    [%d] = %q,", i, pack.functions[i]));
    lines.push("  },");
    lines.push("}");
    lines.push("");
    return lines.join("\n");
  },

  // Lua: mon_anim_extract.lua:186
  backLua(pack: MonAnimPack): string {
    const lines = [
      "return {",
      format("  format = %d,", MonAnimExtract.FORMAT_VERSION),
    ];
    byte_list(lines, "sets", pack.backSets, count_of(pack.backSets));
    byte_list(lines, "ids", pack.backIds, count_of(pack.backIds));
    byte_list(lines, "natureMods", pack.backNatureMods, count_of(pack.backNatureMods));
    lines.push("}");
    lines.push("");
    return lines.join("\n");
  },

  // Lua: mon_anim_extract.lua:199
  run(rom: Rom, cache: Cache, opts: { cacheRoot?: string } = {}): { lists: number; count: number } {
    const root = opts.cacheRoot ?? "data/generated/gba";
    const pack = MonAnimExtract.extract(rom);
    const files: [string, string][] = [
      [MonAnimExtract.FRONT_FILE, MonAnimExtract.frontLua(pack)],
      [MonAnimExtract.BACK_FILE, MonAnimExtract.backLua(pack)],
    ];
    for (const [rel, body] of files) {
      const ok = cache.write(root + "/" + rel, body);
      if (ok === false) throw new Error("mon_anim_extract: could not write " + rel + ": nil");
    }
    return { lists: pack.lists.length, count: pack.count };
  },

  // Lua: mon_anim_extract.lua:211
  ready(cache: Cache | undefined, cacheRoot?: string): boolean {
    if (!(cache && cache.read)) return false;
    const root = cacheRoot ?? "data/generated/gba";
    for (const rel of MonAnimExtract.REQUIRED) {
      const body = cache.read(root + "/" + rel);
      const m = typeof body === "string" ? /format = (\d+)/.exec(body) : null;
      if (typeof body !== "string" || tonumber(m ? m[1] : undefined) !== MonAnimExtract.FORMAT_VERSION) return false;
    }
    return true;
  },
};

export default MonAnimExtract;
