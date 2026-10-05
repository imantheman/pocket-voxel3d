// Port of gen1recomp src/link/Json.lua (GPLv3 + additional terms; see LICENSE.md).
// Minimal JSON encoder/decoder (objects, arrays, strings, numbers, booleans,
// null). Strings are byte strings; \uXXXX above 0x7F decodes to its UTF-8
// bytes, as the Lua does. Tables come back in the lt.ts shape: a JSON array
// is a sequence (slot 0 unused), an object a plain object. JSON null in an
// array leaves a hole (Lua's arr[#arr + 1] = nil appends nothing).

import { find, gsub, match } from "../../platform/lpattern.ts";
import { char, format, sub, tonumber, tostring } from "../../../../import/gen3/lua.ts";
import { concat, isEmpty, len, pairs } from "../../platform/lt.ts";

// Lua: Json.lua:9
function encodeValue(v: unknown, out: (string | null)[]): void {
  const t = typeof v;
  if (v == null) {
    out[len(out) + 1] = "null";
  } else if (t === "boolean") {
    out[len(out) + 1] = v ? "true" : "false";
  } else if (t === "number") {
    out[len(out) + 1] = format("%.17g", v);
  } else if (t === "string") {
    out[len(out) + 1] = '"' + gsub(v as string, '[%c"\\]', (c) => {
      if (c === '"') return '\\"';
      if (c === "\\") return "\\\\";
      if (c === "\n") return "\\n";
      if (c === "\r") return "\\r";
      if (c === "\t") return "\\t";
      return format("\\u%04x", (c as string).charCodeAt(0));
    })[0] + '"';
  } else if (t === "object") {
    const n = len(v);
    let isArray = n > 0;
    if (!isArray) {
      isArray = isEmpty(v); // empty table -> []
    }
    if (isArray) {
      out[len(out) + 1] = "[";
      for (let i = 1; i <= n; i++) {
        if (i > 1) out[len(out) + 1] = ",";
        encodeValue((v as any)[i], out);
      }
      out[len(out) + 1] = "]";
    } else {
      out[len(out) + 1] = "{";
      let first = true;
      for (const [k, val] of pairs(v)) {
        if (!first) out[len(out) + 1] = ",";
        first = false;
        encodeValue(tostring(k), out);
        out[len(out) + 1] = ":";
        encodeValue(val, out);
      }
      out[len(out) + 1] = "}";
    }
  } else {
    throw new Error("cannot encode " + t);
  }
}

// Lua: Json.lua:65
function skipWs(s: string, i: number): number {
  const r = find(s, "[^ \t\r\n]", i);
  return r ? r[0] : (s.length + 1);
}

function check(v: unknown, msg = "assertion failed!"): void {
  if (!v) throw new Error(msg);
}

// Lua: Json.lua:71 -- [string, nextIndex]
function decodeString(s: string, iIn: number): [string, number] {
  const out: string[] = [];
  let i = iIn + 1;
  while (i <= s.length) {
    const c = sub(s, i, i);
    if (c === '"') {
      return [out.join(""), i + 1];
    } else if (c === "\\") {
      const esc = sub(s, i + 1, i + 1);
      if (esc === "n") out.push("\n");
      else if (esc === "r") out.push("\r");
      else if (esc === "t") out.push("\t");
      else if (esc === "b") out.push(char(8));
      else if (esc === "f") out.push(char(12));
      else if (esc === "u") {
        const hex = sub(s, i + 2, i + 5);
        const code = tonumber(hex, 16) ?? 32;
        if (code < 128) {
          out.push(char(code));
        } else {
          if (code < 0x800) {
            out.push(char(0xC0 + Math.floor(code / 0x40), 0x80 + code % 0x40));
          } else {
            out.push(char(0xE0 + Math.floor(code / 0x1000),
              0x80 + Math.floor(code / 0x40) % 0x40,
              0x80 + code % 0x40));
          }
        }
        i = i + 4;
      } else {
        out.push(esc);
      }
      i = i + 2;
    } else {
      out.push(c);
      i = i + 1;
    }
  }
  throw new Error("unterminated string");
}

// Lua: Json.lua:114 -- [value, nextIndex]
function decodeValue(s: string, iIn: number, depthIn: number): [unknown, number] {
  const depth = depthIn + 1;
  check(depth <= Json.MAX_DEPTH, "json nested too deeply");
  let i = skipWs(s, iIn);
  const c = sub(s, i, i);
  if (c === '"') {
    return decodeString(s, i);
  } else if (c === "{") {
    const obj: Record<string, unknown> = {};
    i = skipWs(s, i + 1);
    if (sub(s, i, i) === "}") return [obj, i + 1];
    for (;;) {
      let key: string, val: unknown;
      [key, i] = decodeString(s, skipWs(s, i));
      i = skipWs(s, i);
      check(sub(s, i, i) === ":", "expected :");
      [val, i] = decodeValue(s, i + 1, depth);
      if (val != null) obj[key] = val;
      else delete obj[key];
      i = skipWs(s, i);
      const d = sub(s, i, i);
      if (d === "}") return [obj, i + 1];
      check(d === ",", "expected , or }");
      i = i + 1;
    }
  } else if (c === "[") {
    const arr: unknown[] = [null];
    i = skipWs(s, i + 1);
    if (sub(s, i, i) === "]") return [arr, i + 1];
    for (;;) {
      let val: unknown;
      [val, i] = decodeValue(s, i, depth);
      arr[len(arr) + 1] = val;
      i = skipWs(s, i);
      const d = sub(s, i, i);
      if (d === "]") return [arr, i + 1];
      check(d === ",", "expected , or ]");
      i = i + 1;
    }
  } else if (c === "t") {
    check(sub(s, i, i + 3) === "true");
    return [true, i + 4];
  } else if (c === "f") {
    check(sub(s, i, i + 4) === "false");
    return [false, i + 5];
  } else if (c === "n") {
    check(sub(s, i, i + 3) === "null");
    return [undefined, i + 4];
  } else {
    const numStr = match(s, "^-?%d+%.?%d*[eE]?[-+]?%d*", i) as string | undefined;
    check(numStr && numStr.length > 0, "unexpected character '" + c + "'");
    return [tonumber(numStr), i + numStr!.length];
  }
}

const FAST_NO: unique symbol = Symbol("no fast path");

/**
 * decodeValue's result for `s` by JSON.parse, or FAST_NO. Taken only where
 * the two agree: no \u escapes (decodeString turns one above 0x7F into UTF-8
 * bytes), no "__proto__" key (a plain object assignment there sets the
 * prototype), nesting well inside MAX_DEPTH. JSON.parse refuses everything
 * decodeValue reads differently (raw control characters, unknown escapes,
 * "01" or "1." numbers, trailing text) and the port reads those. The shape:
 * an array is a sequence that skips nulls (arr[#arr + 1] = nil appends
 * nothing), an object drops null members.
 */
function fastDecode(s: string): unknown {
  if (s.includes("\\u") || s.includes("__proto__")) return FAST_NO;
  let v: unknown;
  try { v = JSON.parse(s); } catch { return FAST_NO; }
  const shape = (x: unknown, depth: number): unknown => {
    if (x === null || typeof x !== "object") return x;
    if (depth > Json.MAX_DEPTH - 4) throw FAST_NO;
    if (Array.isArray(x)) {
      const arr: unknown[] = [null];
      for (const e of x) if (e !== null) arr.push(shape(e, depth + 1));
      return arr;
    }
    const o = x as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      const e = o[k];
      if (e === null) delete o[k];
      else if (typeof e === "object") o[k] = shape(e, depth + 1);
    }
    return o;
  };
  if (v === null) return undefined; // decodeValue's nil
  try { return shape(v, 1); } catch (e) { if (e === FAST_NO) return FAST_NO; throw e; }
}

export const Json = {
  MAX_DEPTH: 64,

  // Lua: Json.lua:57
  encode(v: unknown): string {
    const out: (string | null)[] = [null];
    encodeValue(v, out);
    return concat(out);
  },

  // Lua: Json.lua:169 -- [value] or [undefined, err]
  decode(s: unknown, maxLength?: number): [unknown, string?] {
    if (typeof s !== "string") return [undefined, "json input is not a string"];
    if (maxLength && s.length > maxLength) {
      return [undefined, format("json input is %d bytes (max %d)", s.length, maxLength)];
    }
    // NOT FAITHFUL (speed): plain JSON goes through the engine's JSON.parse,
    // shaped as decodeValue shapes it (fastDecode); anything the fast path
    // cannot vouch for takes the port below. 425 map headers at boot took
    // ~1 ms each on the desktop and ~28 s in all on the 3DS this way.
    const fast = fastDecode(s);
    if (fast !== FAST_NO) return [fast];
    try {
      return [decodeValue(s, 1, 0)[0]];
    } catch (e) {
      return [undefined, String((e as Error).message ?? e)];
    }
  },

  // Lua: Json.lua:189
  describeUnexpected(s: unknown): string | undefined {
    if (typeof s !== "string") {
      return "the response had no body to decode";
    }
    const first = match(s, "^%s*(.)");
    if (first === "{" || first === "[") return undefined;
    let preview = gsub(gsub(gsub(s, "%s+", " ")[0], "^%s+", "")[0], "%s+$", "")[0];
    if (preview === "") {
      return "the response was empty, not JSON";
    }
    if (preview.length > 60) preview = sub(preview, 1, 57) + "...";
    const kind = (first === "<") ? "an HTML page" : "plain text";
    return format("the response was %s, not JSON (it starts with %q)", kind, preview);
  },
};

export default Json;
