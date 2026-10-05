// Port of gen1recomp src/import/LuaWriter.lua (GPLv3 + additional terms; see LICENSE.md).
// Deterministic `return {...}` Lua source for a value.

import { format, tostring } from "./lua.ts";
import { CacheFs } from "./cache.ts";
import { luaGet, luaIsArray, luaKeys, luaWriterOrder, type LuaKey } from "./luatable.ts";

const KEYWORDS = new Set(["and", "break", "do", "else", "elseif", "end", "false", "for", "function", "goto", "if",
  "in", "local", "nil", "not", "or", "repeat", "return", "then", "true", "until", "while"]);

// Lua: LuaWriter.lua:11
function quote(value: string): string {
  return '"' + value.replace(/[\x00-\x1f\\"]/g, (c) => {
    if (c === "\\") return "\\\\";
    if (c === '"') return '\\"';
    if (c === "\n") return "\\n";
    if (c === "\r") return "\\r";
    if (c === "\t") return "\\t";
    return format("\\%03d", c.charCodeAt(0));
  }) + '"';
}

function keyText(key: LuaKey): string {
  if (typeof key === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !KEYWORDS.has(key)) return key;
  return "[" + (typeof key === "string" ? quote(key) : tostring(key)) + "]";
}

function encode(value: unknown, indent: number, seen: Set<object>): string {
  if (value === undefined || value === null) return "nil";
  if (typeof value === "boolean" || typeof value === "number") return tostring(value);
  if (typeof value === "string") return quote(value);
  if (typeof value !== "object") throw new Error("cannot serialize " + typeof value);
  if (seen.has(value)) throw new Error("cannot serialize a cyclic table");
  seen.add(value);
  const pad = "  ".repeat(indent);
  const childPad = "  ".repeat(indent + 1);
  const out: string[] = [];
  const [array, length] = luaIsArray(value);
  if (array) {
    for (let i = 1; i <= length; i++) out.push(childPad + encode(luaGet(value, i), indent + 1, seen) + ",");
  } else {
    for (const key of luaWriterOrder(luaKeys(value))) {
      out.push(childPad + keyText(key) + " = " + encode(luaGet(value, key), indent + 1, seen) + ",");
    }
  }
  seen.delete(value);
  if (out.length === 0) return "{}";
  return "{\n" + out.join("\n") + "\n" + pad + "}";
}

export const LuaWriter = {
  // Lua: LuaWriter.lua:85
  encode(value: unknown): string {
    return "return " + encode(value, 0, new Set()) + "\n";
  },
  // Lua: LuaWriter.lua:89
  write(path: string, value: unknown): void {
    const [ok, err] = CacheFs.write(path, LuaWriter.encode(value));
    if (!ok) throw new Error("could not write " + path + ": " + String(err));
  },
};

export default LuaWriter;
