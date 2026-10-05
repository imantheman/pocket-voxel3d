// Port of gen1recomp src/link/Json.lua + src/import/canonical_json.lua (GPLv3 +
// additional terms; see LICENSE.md). Byte strings in and out.

import { format, tostring } from "./lua.ts";
import { luaEmpty, luaGet, luaKeys, luaLen, type LuaKey } from "./luatable.ts";

function encodeString(s: string): string {
  // Lua pattern [%c"\\]: %c is iscntrl (0-31 and 127)
  return '"' + s.replace(/[\x00-\x1f\x7f"\\]/g, (c) => {
    if (c === '"') return '\\"';
    if (c === "\\") return "\\\\";
    if (c === "\n") return "\\n";
    if (c === "\r") return "\\r";
    if (c === "\t") return "\\t";
    return format("\\u%04x", c.charCodeAt(0));
  }) + '"';
}

// Lua: Json.lua:9 encodeValue
function encodeValue(v: unknown, out: string[]): void {
  if (v === undefined || v === null) out.push("null");
  else if (typeof v === "boolean") out.push(v ? "true" : "false");
  else if (typeof v === "number") out.push(format("%.17g", v));
  else if (typeof v === "string") out.push(encodeString(v));
  else if (typeof v === "object") {
    const n = luaLen(v);
    const isArray = n > 0 || luaEmpty(v);
    if (isArray) {
      out.push("[");
      for (let i = 1; i <= n; i++) {
        if (i > 1) out.push(",");
        encodeValue(luaGet(v, i), out);
      }
      out.push("]");
    } else {
      // NOT FAITHFUL (order): Lua pairs() order; here insertion order
      out.push("{");
      let first = true;
      for (const k of luaKeys(v)) {
        if (!first) out.push(",");
        first = false;
        encodeValue(tostring(k), out);
        out.push(":");
        encodeValue(luaGet(v, k), out);
      }
      out.push("}");
    }
  } else throw new Error("cannot encode " + typeof v);
}

export const Json = {
  MAX_DEPTH: 64,
  encode(v: unknown): string {
    const out: string[] = [];
    encodeValue(v, out);
    return out.join("");
  },
  // decode: JSON text (byte string) -> values; objects/arrays as JS (arrays 0-based)
  decode(s: string): unknown {
    return decodeBytes(s);
  },
};

/** JSON text in a byte string -> value, \u escapes UTF-8-encoded as Json.lua does. */
function decodeBytes(s: string): unknown {
  let i = 0;
  const ws = (): void => { while (i < s.length && " \t\r\n".includes(s[i]!)) i++; };
  const value = (): unknown => {
    ws();
    const c = s[i];
    if (c === "{") {
      i++;
      const o: Record<string, unknown> = {};
      ws();
      if (s[i] === "}") { i++; return o; }
      for (;;) {
        ws();
        const k = value() as string;
        ws();
        if (s[i] !== ":") throw new Error("json: expected ':'");
        i++;
        o[k] = value();
        ws();
        if (s[i] === ",") { i++; continue; }
        if (s[i] === "}") { i++; return o; }
        throw new Error("json: expected ',' or '}'");
      }
    }
    if (c === "[") {
      i++;
      const a: unknown[] = [];
      ws();
      if (s[i] === "]") { i++; return a; }
      for (;;) {
        a.push(value());
        ws();
        if (s[i] === ",") { i++; continue; }
        if (s[i] === "]") { i++; return a; }
        throw new Error("json: expected ',' or ']'");
      }
    }
    if (c === '"') {
      i++;
      let out = "";
      while (i < s.length) {
        const ch = s[i]!;
        if (ch === '"') { i++; return out; }
        if (ch === "\\") {
          const e = s[i + 1];
          if (e === "n") out += "\n";
          else if (e === "r") out += "\r";
          else if (e === "t") out += "\t";
          else if (e === "b") out += "\b";
          else if (e === "f") out += "\f";
          else if (e === "u") {
            const code = parseInt(s.slice(i + 2, i + 6), 16) || 32;
            if (code < 128) out += String.fromCharCode(code);
            else if (code < 0x800) out += String.fromCharCode(0xc0 + (code >> 6), 0x80 + (code & 0x3f));
            else out += String.fromCharCode(0xe0 + (code >> 12), 0x80 + ((code >> 6) & 0x3f), 0x80 + (code & 0x3f));
            i += 4;
          } else out += e ?? "";
          i += 2;
        } else { out += ch; i++; }
      }
      throw new Error("json: unterminated string");
    }
    if (s.startsWith("true", i)) { i += 4; return true; }
    if (s.startsWith("false", i)) { i += 5; return false; }
    if (s.startsWith("null", i)) { i += 4; return undefined; }
    const m = /^-?\d+(\.\d+)?([eE][-+]?\d+)?/.exec(s.slice(i, i + 40));
    if (!m) throw new Error(`json: unexpected '${c}' at ${i}`);
    i += m[0].length;
    return Number(m[0]);
  };
  return value();
}

// Lua: canonical_json.lua:5
function canon(v: unknown, out: string[]): void {
  if (v === null || typeof v !== "object") { out.push(Json.encode(v)); return; }
  const n = luaLen(v);
  const isArray = n > 0 || luaEmpty(v);
  if (isArray) {
    out.push("[");
    for (let i = 1; i <= n; i++) {
      if (i > 1) out.push(",");
      canon(luaGet(v, i), out);
    }
    out.push("]");
    return;
  }
  const keys: LuaKey[] = luaKeys(v).sort((a, b) => {
    const sa = tostring(a), sb = tostring(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });
  out.push("{");
  keys.forEach((k, idx) => {
    if (idx > 0) out.push(",");
    out.push(Json.encode(tostring(k)));
    out.push(":");
    canon(luaGet(v, k), out);
  });
  out.push("}");
}

export const CanonicalJson = {
  encode(v: unknown): string {
    const out: string[] = [];
    canon(v, out);
    return out.join("");
  },
};

export default Json;
