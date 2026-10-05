// Port of gen1recomp src/import/gba/flags_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// Extract FRLG flag and var constants, new game reset states, and badge mappings
// from pret pokefirered headers into Lua tables.
// NOT FAITHFUL: the Lua reads the pret headers with io.open (relative to the
// working directory). Importer modules have no file system here, so a
// reader is passed in opts.readFile (path -> text or undefined); without one
// every header reads as absent, exactly as when no pret checkout is present,
// and write() keeps the bundled definitions (flags_table) -- which is what a
// release import does in the Lua too.
// NOT FAITHFUL: the Lua evaluates #define values with loadstring("return
// "..expr); here a small evaluator accepts what that Lua expression grammar
// accepts for these headers (numbers incl. hex, + - * / % ^, parentheses)
// and returns undefined for anything else (e.g. C's << or casts), where
// loadstring would also fail.

import { format, tonumber, tostring } from "./lua.ts";
import { luaGet, luaLen } from "./luatable.ts";
import type { Cache } from "./cache.ts";
import flagsTable from "../../game/gen3/core/scripting/flags_table.ts";

type Tbl = Record<string, any>;
export type ReadFile = (path: string) => string | undefined;

export interface FlagsData {
  flags: Record<string, number>;
  flagsById: Record<number, string>;
  vars: Record<string, number>;
  varsById: Record<number, string>;
  newGameHideFlags: unknown;
  newGameResetList?: unknown;
  newGameResetVars: unknown;
  badges: unknown;
}

// Lua: flags_extract.lua:6
function strip_comments(val: string): string {
  return val.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/, "").replace(/[ \t\n\v\f\r]+$/, "");
}

/** Lines of a file the way f:lines() yields them. */
function lines(src: string): string[] {
  const out = src.split("\n");
  if (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

/** loadstring("return " .. expr) for an arithmetic expression; undefined when Lua could not run it. */
function evalExpr(expr: string): number | undefined {
  let pos = 0;
  const peek = (): string => expr[pos] ?? "";
  const fail = (): never => { throw new Error("bad expr"); };
  const primary = (): number => {
    const c = peek();
    if (c === "(") {
      pos++;
      const v = addSub();
      if (peek() !== ")") fail();
      pos++;
      return v;
    }
    if (c === "-") { pos++; return -power(); }
    const m = /^(0[xX][0-9A-Fa-f]+|[0-9]+(\.[0-9]*)?([eE][+-]?[0-9]+)?|\.[0-9]+([eE][+-]?[0-9]+)?)/.exec(expr.slice(pos));
    if (!m) fail();
    pos += m![0].length;
    return tonumber(m![0])!;
  };
  const power = (): number => {
    const base = primary();
    if (peek() === "^") { pos++; return Math.pow(base, unary()); }
    return base;
  };
  const unary = (): number => {
    if (peek() === "-") { pos++; return -unary(); }
    return power();
  };
  const mulDiv = (): number => {
    let v = unary();
    for (;;) {
      const c = peek();
      if (c === "*") { pos++; v = v * unary(); }
      else if (c === "/") { pos++; v = v / unary(); }
      else if (c === "%") { pos++; const b = unary(); v = v - Math.floor(v / b) * b; }
      else return v;
    }
  };
  const addSub = (): number => {
    let v = mulDiv();
    for (;;) {
      const c = peek();
      if (c === "+") { pos++; v = v + mulDiv(); }
      else if (c === "-") { pos++; v = v - mulDiv(); }
      else return v;
    }
  };
  try {
    const v = addSub();
    if (pos !== expr.length) return undefined;
    return v;
  } catch {
    return undefined;
  }
}

// Lua: flags_extract.lua:10 -- [evaluated, order]
function parse_header_files(files: string[], readFile?: ReadFile): [Record<string, number>, string[]] {
  const raw_defs: Record<string, string> = {};
  const order: string[] = [];
  for (const filepath of files) {
    const src = readFile ? readFile(filepath) : undefined;
    if (src !== undefined) {
      for (const line of lines(src)) {
        // Lua's greedy (.+)%s*$ keeps trailing spaces; strip_comments trims them.
        const m = /^[ \t\n\v\f\r]*#define[ \t\n\v\f\r]+([A-Za-z0-9_]+)[ \t\n\v\f\r]+(.+)$/.exec(line);
        if (m) {
          const name = m[1]!;
          const val = strip_comments(m[2]!);
          if (raw_defs[name] === undefined) {
            order.push(name);
          }
          raw_defs[name] = val;
        }
      }
    }
  }

  const evaluated: Record<string, number> = {};
  const eval_val = (valIn: string, depth?: number): number | undefined => {
    depth = depth ?? 0;
    if (depth > 30) return undefined;
    const val = valIn.replace(/[ \t\n\v\f\r]+/g, "");
    const n = tonumber(val);
    if (n !== undefined) return n;
    let changed = true;
    let expr = val;
    while (changed) {
      changed = false;
      expr = expr.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (id) => {
        if (evaluated[id] !== undefined) {
          changed = true;
          return tostring(evaluated[id]);
        } else if (raw_defs[id] !== undefined) {
          const v = eval_val(raw_defs[id]!, depth! + 1);
          if (v !== undefined) {
            evaluated[id] = v;
            changed = true;
            return tostring(v);
          }
        }
        return id;
      });
    }
    return evalExpr(expr);
  };

  for (const name of order) {
    const val = eval_val(raw_defs[name]!);
    if (val !== undefined) {
      evaluated[name] = val;
    }
  }
  return [evaluated, order];
}

// Lua: flags_extract.lua:75 -- [hide_flags, set_vars]
function parse_reset_script(filepath: string, flags_map: Record<string, number>, vars_map: Record<string, number>,
  readFile?: ReadFile): [Tbl[], Tbl[]] {
  const src = readFile ? readFile(filepath) : undefined;
  if (src === undefined) return [[], []];
  let in_reset = false;
  const hide_flags: Tbl[] = [];
  const set_vars: Tbl[] = [];
  for (const line of lines(src)) {
    if (/^EventScript_ResetAllMapFlags::/.test(line)) {
      in_reset = true;
    } else if (in_reset) {
      if (/^[ \t\n\v\f\r]*end/.test(line)) {
        break;
      }
      const fm = /^[ \t\n\v\f\r]*setflag[ \t\n\v\f\r]+([A-Za-z0-9_]+)/.exec(line);
      if (fm) {
        const id = flags_map[fm[1]!];
        if (id !== undefined) {
          hide_flags.push({ name: fm[1], id });
        }
      }
      const vm = /^[ \t\n\v\f\r]*setvar[ \t\n\v\f\r]+([A-Za-z0-9_]+)[ \t\n\v\f\r]*,[ \t\n\v\f\r]*(\d+)/.exec(line);
      if (vm) {
        const id = vars_map[vm[1]!];
        if (id !== undefined) {
          set_vars.push({ name: vm[1], id, value: tonumber(vm[2]) });
        }
      }
    }
  }
  return [hide_flags, set_vars];
}

/** ipairs over a JS array or a 1-based integer-keyed object. */
function ipairs(t: unknown): any[] {
  if (t === null || typeof t !== "object") return [];
  const out: any[] = [];
  for (let i = 1; i <= luaLen(t as object); i++) out.push(luaGet(t as object, i));
  return out;
}

/** Ascending numeric keys of an id-keyed object. */
function numericKeys(o: object): number[] {
  return Object.keys(o).map(Number).sort((a, b) => a - b);
}

export const FlagsExtract = {
  // Lua: flags_extract.lua:108
  extract(opts: { root?: string; readFile?: ReadFile } = {}): FlagsData {
    const root = opts.root ?? "pokefirered";

    const flag_headers = [
      root + "/include/constants/opponents.h",
      root + "/include/constants/trainers.h",
      root + "/include/constants/flags.h",
    ];
    const var_headers = [
      root + "/include/constants/vars.h",
    ];

    const [raw_flags_map, flag_names] = parse_header_files(flag_headers, opts.readFile);
    const [raw_vars_map, var_names] = parse_header_files(var_headers, opts.readFile);
    const [hide_flags, reset_vars] = parse_reset_script(root + "/data/event_scripts.s", raw_flags_map, raw_vars_map, opts.readFile);

    const flags_map: Record<string, number> = {};
    const flags_by_id: Record<number, string> = {};
    for (const name of flag_names) {
      const id = raw_flags_map[name];
      if (id !== undefined && (/^FLAG_/.test(name) || name.includes("FLAGS") || name === "NUM_BADGES")) {
        flags_map[name] = id;
        if (flags_by_id[id] === undefined && /^FLAG_/.test(name)) {
          flags_by_id[id] = name;
        }
      }
    }

    const vars_map: Record<string, number> = {};
    const vars_by_id: Record<number, string> = {};
    for (const name of var_names) {
      const id = raw_vars_map[name];
      if (id !== undefined && (/^VAR_/.test(name) || name.includes("VARS"))) {
        vars_map[name] = id;
        if (vars_by_id[id] === undefined && /^VAR_/.test(name)) {
          vars_by_id[id] = name;
        }
      }
    }

    const badges = [
      { num: 1, flag: flags_map.FLAG_BADGE01_GET ?? 0x820, name: "BOULDER", gym: "PEWTER", fieldMove: "FLASH" },
      { num: 2, flag: flags_map.FLAG_BADGE02_GET ?? 0x821, name: "CASCADE", gym: "CERULEAN", fieldMove: "CUT" },
      { num: 3, flag: flags_map.FLAG_BADGE03_GET ?? 0x822, name: "THUNDER", gym: "VERMILION", fieldMove: "FLY" },
      { num: 4, flag: flags_map.FLAG_BADGE04_GET ?? 0x823, name: "RAINBOW", gym: "CELADON", fieldMove: "STRENGTH" },
      { num: 5, flag: flags_map.FLAG_BADGE05_GET ?? 0x824, name: "SOUL", gym: "FUCHSIA", fieldMove: "SURF" },
      { num: 6, flag: flags_map.FLAG_BADGE06_GET ?? 0x825, name: "MARSH", gym: "SAFFRON", fieldMove: "ROCK_SMASH" },
      { num: 7, flag: flags_map.FLAG_BADGE07_GET ?? 0x826, name: "VOLCANO", gym: "CINNABAR", fieldMove: "WATERFALL" },
      { num: 8, flag: flags_map.FLAG_BADGE08_GET ?? 0x827, name: "EARTH", gym: "VIRIDIAN", fieldMove: "DIVE" },
    ];

    const new_game_hide_ids: number[] = [];
    for (const hf of hide_flags) {
      new_game_hide_ids.push(hf.id);
    }

    return {
      flags: flags_map,
      flagsById: flags_by_id,
      vars: vars_map,
      varsById: vars_by_id,
      newGameHideFlags: new_game_hide_ids,
      newGameResetList: hide_flags,
      newGameResetVars: reset_vars,
      badges,
    };
  },

  // Lua: flags_extract.lua:177
  generateLuaSource(data: FlagsData): string {
    const L: string[] = [];
    L.push("-- Auto-generated from pret/pokefirered constants. DO NOT EDIT DIRECTLY.");
    L.push("local FlagsTable = {}");
    L.push("");
    L.push("FlagsTable.FLAGS = {");

    const flag_keys = Object.keys(data.flags).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const k of flag_keys) {
      L.push(format("  %s = 0x%X,", k, data.flags[k]));
    }
    L.push("}");
    L.push("");

    L.push("FlagsTable.FLAGS_BY_ID = {");
    for (const id of numericKeys(data.flagsById)) {
      L.push(format("  [0x%X] = %q,", id, data.flagsById[id]));
    }
    L.push("}");
    L.push("");

    L.push("FlagsTable.VARS = {");
    const var_keys = Object.keys(data.vars).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const k of var_keys) {
      L.push(format("  %s = 0x%X,", k, data.vars[k]));
    }
    L.push("}");
    L.push("");

    L.push("FlagsTable.VARS_BY_ID = {");
    for (const id of numericKeys(data.varsById)) {
      L.push(format("  [0x%X] = %q,", id, data.varsById[id]));
    }
    L.push("}");
    L.push("");

    L.push("FlagsTable.NEW_GAME_HIDE_FLAGS = {");
    for (const id of ipairs(data.newGameHideFlags)) {
      const name = data.flagsById[id] ?? "UNKNOWN";
      L.push(format("  0x%03X, -- %s (%d)", id, name, id));
    }
    L.push("}");
    L.push("");

    L.push("FlagsTable.NEW_GAME_RESET_VARS = {");
    for (const v of ipairs(data.newGameResetVars)) {
      L.push(format("  { id = 0x%X, value = %d, name = %q },", v.id, v.value, v.name));
    }
    L.push("}");
    L.push("");

    L.push("FlagsTable.BADGES = {");
    for (const b of ipairs(data.badges)) {
      L.push(format(
        "  { num = %d, flag = 0x%X, name = %q, gym = %q, fieldMove = %q },",
        b.num, b.flag, b.name, b.gym, b.fieldMove,
      ));
    }
    L.push("}");
    L.push("");

    L.push("return FlagsTable");
    L.push("");
    return L.join("\n");
  },

  // Lua: flags_extract.lua:255
  write(cache: Cache | undefined, root?: string, data?: FlagsData, opts?: { readFile?: ReadFile }): boolean {
    data = data ?? FlagsExtract.extract({ readFile: opts && opts.readFile });
    // A release does not ship a pret checkout. Keep the bundled definitions
    // when optional headers are absent; never rewrite engine source on import.
    if (Object.keys(data.flags ?? {}).length === 0 || Object.keys(data.vars ?? {}).length === 0) {
      const bundled = flagsTable as unknown as Tbl;
      data = {
        flags: bundled.FLAGS, flagsById: bundled.FLAGS_BY_ID,
        vars: bundled.VARS, varsById: bundled.VARS_BY_ID,
        newGameHideFlags: bundled.NEW_GAME_HIDE_FLAGS,
        newGameResetVars: bundled.NEW_GAME_RESET_VARS, badges: bundled.BADGES,
      };
    }
    const src = FlagsExtract.generateLuaSource(data);
    if (cache && cache.write) {
      cache.write((root ?? "data/generated/gba") + "/flags_table.lua", src);
    }
    return true;
  },
};

export default FlagsExtract;
