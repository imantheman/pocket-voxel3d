// Port of gen1recomp src/core/Strings.lua (GPLv3 + additional terms; see LICENSE.md).
// The engine's own player-facing text, made overridable: literals are
// wrapped in S(...) and the English source doubles as the catalog key. With
// no mod loaded the catalog is empty and S is the identity (formatting
// aside), so a vanilla boot draws byte-identical text.
//
// The Lua module is callable (`Strings("...", ...)` = Strings.get): here
// `Strings` is a function carrying the module's fields.

import { Logger } from "./Logger.ts";
import { find, gmatch, matchAll } from "../../platform/lpattern.ts";
import { format, sub, tonumber } from "../../../../import/gen3/lua.ts";
import { concat, ipairs, len, pairs, unpack } from "../../platform/lt.ts";

// Lua: Strings.lua:51
let catalog: Record<string, unknown> | undefined;   // Data.strings once a mod has put something in it
const missing: Record<string, boolean> = {};         // format-arity complaints, reported once each

// Lua: Strings.lua:87
function specifiers(s: string): number {
  let n = 0;
  for (const [spec] of gmatch(s, "%%(.)")) {
    if (spec !== "%") n = n + 1;
  }
  return n;
}

// Lua: Strings.lua:98 -- [plain, order] | [undefined] | [false]
function positional(text: string): [string | false | undefined, (number | null)[]?] {
  if (!find(text, "%%%d+%$")) return [undefined];
  const out: (string | null)[] = [null], order: (number | null)[] = [null];
  let i = 1;
  const n = text.length;
  while (i <= n) {
    const c = sub(text, i, i);
    if (c !== "%") {
      out[len(out) + 1] = c;
      i = i + 1;
    } else if (sub(text, i + 1, i + 1) === "%") {
      out[len(out) + 1] = "%%";
      i = i + 2;
    } else {
      const caps = matchAll(text, "^%%(%d+)%$([-+ #0]*%d*%.?%d*%a)()", i);
      if (!caps) return [false];
      const [index, spec, stop] = caps;
      order[len(order) + 1] = tonumber(index)!;
      out[len(out) + 1] = "%" + spec;
      i = stop as number;
    }
  }
  if (len(order) === 0) return [undefined];
  return [concat(out), order];
}

// Lua: Strings.lua:123
function withinArguments(order: (number | null)[], wants: number): boolean {
  for (const [, index] of ipairs<number>(order)) {
    if (index < 1 || index > wants) return false;
  }
  return true;
}

// Lua: Strings.lua:130
function complain(source: string, fmt: string, ...args: unknown[]): void {
  if (missing[source]) return;
  missing[source] = true;
  Logger.warn(fmt, ...args);
}

function tryFormat(fmt: string, args: unknown[]): [boolean, string] {
  try {
    return [true, format(fmt, ...args)];
  } catch {
    return [false, ""];
  }
}

// Lua: Strings.lua:136
function render(source: string, textIn: string, args: unknown[]): string {
  let text = textIn;
  const wants = specifiers(source);
  let [plain, order] = positional(text);
  if (plain === false || (plain && !withinArguments(order!, wants))) {
    complain(source, "strings: translation of %q numbers its format directives"
      + " wrongly for %d argument(s) -- using the source", source, wants);
    plain = undefined;
    text = source;
  } else if (!plain && specifiers(text) !== wants) {
    complain(source, "strings: translation of %q has %d format directives, source has %d"
      + " -- using the source", source, specifiers(text), wants);
    text = source;
  }
  let ok: boolean, out: string;
  if (plain) {
    const picked: unknown[] = [null];
    for (const [k, index] of ipairs<number>(order!)) picked[k] = args[index - 1];
    [ok, out] = tryFormat(plain, unpack(picked, 1, len(order!)));
  } else {
    [ok, out] = tryFormat(text, args);
  }
  if (ok) return out;
  [ok, out] = tryFormat(source, args);
  if (ok) return out;
  return source;
}

// Lua: Strings.lua:174
function get(source: string, ...args: unknown[]): string {
  const argc = args.length;
  if (argc === 0) return lookup(source);

  const wants = specifiers(source);
  if (wants === 0 && argc === 1 && typeof args[0] === "string") {
    return lookup(source, args[0]);
  }

  return render(source, lookup(source), args);
}

// Lua: Strings.lua:74
function lookup(source: string, context?: string): string {
  if (!catalog) return source;
  if (context) {
    const hit = catalog[context + "|" + source];
    if (typeof hit === "string") return hit;
  }
  const hit = catalog[source];
  if (typeof hit === "string") return hit;
  return source;
}

export interface StringsModule {
  (source: string, ...args: unknown[]): string;
  load(data: any): void;
  active(): boolean;
  lookup(source: string, context?: string): string;
  get(source: string, ...args: unknown[]): string;
  translate(source: string, context?: string, ...args: unknown[]): string | undefined;
  translateLabel(label: string, source: string, ...args: unknown[]): string | undefined;
  source(text: string): string;
}

// Lua: Strings.lua:215 (setmetatable(Strings, { __call = ... }))
export const Strings: StringsModule = Object.assign(
  (source: string, ...args: unknown[]): string => get(source, ...args),
  {
    // Lua: Strings.lua:57
    load(data: any): void {
      const t = data ? data.strings : undefined;
      catalog = undefined;
      if (t == null || typeof t !== "object") return;
      for (const _ of pairs(t)) {
        catalog = t;
        return;
      }
    },

    // Lua: Strings.lua:67
    active(): boolean {
      return catalog !== undefined;
    },

    lookup,
    get,

    // Lua: Strings.lua:186
    translate(source: string, context?: string, ...args: unknown[]): string | undefined {
      if (!catalog) return undefined;
      const text = lookup(source, context);
      if (text === source) return undefined;
      return render(source, text, args);
    },

    // Lua: Strings.lua:193
    translateLabel(label: string, source: string, ...args: unknown[]): string | undefined {
      if (!catalog) return undefined;
      const text = catalog[label];
      if (typeof text !== "string" || text === "") return undefined;
      return render(source, text, args);
    },

    // Lua: Strings.lua:211
    source(text: string): string {
      return text;
    },
  },
);

export default Strings;
