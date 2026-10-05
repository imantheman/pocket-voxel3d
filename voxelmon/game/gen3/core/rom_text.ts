// Port of gen1recomp src/core/game3/rom_text.lua (GPLv3 + additional terms; see LICENSE.md).
// The ROM's text by label, from the script cache's text bundle.
//
// A text IR is TextIR's own shape (a 0-based Seg[]; see scripting/text_ir.ts),
// so the loops over an IR's segments here are 0-based at that seam.

import { TextIR, type Seg, type SourceOpts } from "./scripting/text_ir.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Space } from "./scripting/space.ts";
import { Profile } from "./profile.ts";
import { format, tostring, truthy } from "../../../import/gen3/lua.ts";
import { match } from "../platform/lpattern.ts";
import { seq, len, type LuaTable } from "../platform/lt.ts";

type IR = Seg[];

interface SourceForm extends SourceOpts {
  named: boolean; nl: string; para: string; digits: boolean; trim: boolean; scroll?: string;
}

export interface SourceRow { source: string; args: any[]; suffix: string }

// Lua: rom_text.lua:8
function bundle(): any {
  return Space.ensureBundle();
}

// Lua: rom_text.lua:12
function alias(key: string): string | null {
  let ok: boolean, row: any;
  try {
    row = Profile.forSession();
    ok = true;
  } catch {
    ok = false;
  }
  const aliases = ok && row != null && typeof row === "object" && row.ui != null && typeof row.ui === "object"
    ? row.ui.textAliases : null;
  return truthy(aliases) ? (aliases[key] ?? null) : null;
}

// Lua: rom_text.lua:18
function ir(key: string): IR {
  const over = RomText.overrides[key];
  if (over != null) return over;
  const b = bundle();
  let r = truthy(b) && truthy(b.text) ? b.text[key] : undefined;
  if (r == null) {
    const to = alias(key);
    r = truthy(to) && truthy(b) && truthy(b.text) ? b.text[to!] : undefined;
  }
  if (!truthy(r)) throw new Error("ROM text " + tostring(key) + " is not in the script cache");
  return r;
}

// Lua: rom_text.lua:30
function has(key: string): boolean {
  if (RomText.overrides[key] != null) return true;
  const b = bundle();
  return (truthy(b) && truthy(b.text) ? b.text[key] : undefined) != null;
}

// Lua: rom_text.lua:36
const SOURCE_FORMS: LuaTable = seq();
for (const named of [false, true]) {
  for (const nl of ["\n", "\\n"]) {
    for (const para of ["\\p", "\n", "\f"]) {
      for (const digits of [false, true]) {
        for (const trim of [false, true]) {
          SOURCE_FORMS[len(SOURCE_FORMS) + 1] = {
            named, nl, para, digits,
            trim, scroll: (nl !== "\n") ? "\\l" : undefined,
          } as SourceForm;
        }
      }
    }
  }
}

// Lua: rom_text.lua:50
// `args` is TextIR.toSource's 0-based array.
function hasDigits(args: any[]): boolean {
  for (const v of args) {
    if (v == null) break; // ipairs stops at the first nil
    if (match(tostring(v), "^%d+$") != null) return true;
  }
  return false;
}

type SourceFn<T> = (source: string, args: any[], suffix: string) => T | undefined;

// Lua: rom_text.lua:57
function eachSource<T>(r: IR, ctx: any, fn: SourceFn<T>): T | undefined {
  const seen: Record<string, boolean> = {};
  let numeric: boolean | undefined;
  for (let i = 1; i <= len(SOURCE_FORMS); i++) {
    const form = SOURCE_FORMS[i] as SourceForm;
    let source: string | undefined, args: any[] | undefined, suffix: string | undefined;
    if (form.digits) {
      if (numeric == null) numeric = hasDigits(TextIR.toSource(r, ctx)[1]);
      if (numeric) [source, args, suffix] = TextIR.toSource(r, ctx, form);
    } else {
      [source, args, suffix] = TextIR.toSource(r, ctx, form);
    }
    if (source != null && !seen[source]) {
      seen[source] = true;
      const done = fn(source, args!, suffix!);
      if (done != null) return done;
    }
  }
  return undefined;
}

// Lua: rom_text.lua:76
function sources(r: IR, ctx?: any): LuaTable {
  const out: LuaTable = seq();
  eachSource(r, ctx, (source, args, suffix) => {
    out[len(out) + 1] = { source, args, suffix } as SourceRow;
    return undefined;
  });
  return out;
}

// Lua: rom_text.lua:84
function translate(r: IR, ctx: any, key?: string): IR {
  if (!Strings.active()) return r;
  if (key != null) {
    const [source, args] = TextIR.toSource(r, ctx);
    const out = Strings.translateLabel(key, source, ...args);
    if (out != null) return TextIR.fromAscii(out);
  }
  return eachSource(r, ctx, (source, args, suffix) => {
    const out = Strings.translate(source, key, ...args);
    if (out != null) return TextIR.fromAscii(out + suffix);
    return undefined;
  }) ?? r;
}

// Lua: rom_text.lua:97
function box(key: string, ctx?: any): string {
  ctx = ctx ?? {};
  return TextIR.toTextBox(RomText.translate(RomText.ir(key), ctx, key), ctx);
}

// Segment types whose expansion reads nothing but the segment itself.  An IR
// made only of these expands to the same plain string every time.
// Lua: rom_text.lua:104
const PURE_SEG: Record<string, boolean> = { text: true, tag: true, nl: true, para: true, scroll: true, eos: true, ext: true };

// plain() results for pure IRs, keyed by the IR table itself (false = not
// pure).  Keying on the IR follows overrides, profile aliases and bundle
// reloads for free: each resolves to a different table.
// Lua: rom_text.lua:109 (a weak-keyed table: a WeakMap; an IR that is not an
// object -- never the case for bundle IRs -- just is not cached, which gives
// the same strings.)
const plainCache = new WeakMap<object, string | false>();

// Lua: rom_text.lua:111
function pure_ir(r: unknown): boolean {
  if (!Array.isArray(r)) return false;
  for (let i = 0; i < r.length; i++) {
    const seg = r[i];
    if (seg == null || typeof seg !== "object" || !PURE_SEG[seg.t]) return false;
  }
  return true;
}

// Lua: rom_text.lua:120
function plain(key: string, ctx?: any): string {
  if (ctx == null && !Strings.active()) {
    const r = RomText.ir(key);
    const cacheable = r != null && typeof r === "object";
    const hit = cacheable ? plainCache.get(r) : false;
    if (hit) return hit;
    if (hit == null) {
      const pure = pure_ir(r);
      const out = TextIR.toPlain(r, {});
      plainCache.set(r, pure ? out : false);
      return out;
    }
    return TextIR.toPlain(r, {});
  }
  ctx = ctx ?? {};
  return TextIR.toPlain(RomText.translate(RomText.ir(key), ctx, key), ctx);
}

// Lua: rom_text.lua:137
function ascii(key: string, ctx?: any): string {
  ctx = ctx ?? {};
  return TextIR.toAscii(RomText.translate(RomText.ir(key), ctx, key), ctx);
}

// Lua: rom_text.lua:142
function key(nm: string, i: number, j?: number): string {
  if (j != null) return format("%s[%d][%d]", nm, i, j);
  return format("%s[%d]", nm, i);
}

/** The table's size: the Lua's one or two values, as [n] or [n1, n2]. */
// Lua: rom_text.lua:147
function count(nm: string): [number, number?] {
  const b = bundle();
  const tables = truthy(b) ? b.textTables : undefined;
  if (!truthy(tables)) throw new Error("scripts/text_tables.lua is not in the script cache");
  const n = tables[nm];
  if (!truthy(n)) throw new Error("ROM text table " + tostring(nm) + " is not in the script cache");
  if (n != null && typeof n === "object") return [n[1], n[2]];
  return [n];
}

// Lua: rom_text.lua:155
function at(nm: string, i: number, j?: number, ctx?: any): string {
  return RomText.plain(RomText.key(nm, i, j), ctx);
}

// Lua: rom_text.lua:159
function list(nm: string, ctx?: any): LuaTable {
  const out: LuaTable = seq();
  for (let i = 0; i <= RomText.count(nm)[0] - 1; i++) {
    const k = RomText.key(nm, i);
    out[i + 1] = RomText.has(k) ? RomText.plain(k, ctx) : null;
  }
  return out;
}

// Lua: rom_text.lua:168
function lazy(map: Record<string, string>, ctx?: any): Record<string, string | undefined> {
  return new Proxy({} as Record<string, string | undefined>, {
    get(t, k) {
      // Brian's __index metatable: raw fields stored on the table win
      if (k in t) return (t as Record<string | symbol, unknown>)[k] as string | undefined;
      if (typeof k !== "string") return undefined;
      const k2 = map[k];
      if (k2 == null) return undefined;
      return RomText.plain(k2, ctx);
    },
  });
}

// Lua: rom_text.lua:4-6, then the functions in order.
export const RomText = {
  overrides: {} as Record<string, IR | undefined>,
  ir,
  has,
  sources,
  translate,
  box,
  plain,
  ascii,
  key,
  count,
  at,
  list,
  lazy,
};

export default RomText;
