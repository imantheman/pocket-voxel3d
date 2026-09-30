// gen1recomp src/core/SaveSerializer.lua at bdfac727 (MIT): the save-file
// format. A deterministic Lua-source writer ("return {...}\n", keys sorted,
// %q strings) and a restricted-grammar reader, so a save is data only.
//
// Lua has one table type; JS has two. The mapping, which makes a JS save
// round-trip exactly through Brian's format:
//   * a JS array is a Lua sequence: element i is key [i + 1] (holes are
//     skipped, as nil is in Lua); any non-index own property is a string key;
//   * a JS object's keys are all STRINGS in Lua (["12"] when the key is not an
//     identifier) -- JS cannot tell 12 from "12", so it never claims a number;
//   * reading back, a table holding any positive-integer NUMBER key is an
//     array (key k at index k - 1, holes allowed), and one holding no keys at
//     all is an empty array (it answers `.length`, `push` AND keyed writes);
//     every other table is an object, number keys becoming their string form.
// Brian's own writer puts number keys on sparse maps (wEventFlags byte index,
// scriptMem addresses); a file of his decodes those as arrays with holes,
// which core/Save.ts reshapes on load.

export interface DecodeLimits {
  maxBytes?: number;
  maxNodes?: number;
  maxDepth?: number;
  maxStringBytes?: number;
  maxTableEntries?: number;
  allowComments?: boolean;
  allowArray?: boolean;
  rootName?: string;
}

// ------- writer

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Lua's tostring for a number: integers plain, others %.14g. */
function numberText(v: number): string {
  if (Number.isNaN(v)) return "nan";
  if (v === Infinity) return "inf";
  if (v === -Infinity) return "-inf";
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v);
  const g = Number(v.toPrecision(14));
  let s = String(g);
  // %g writes the exponent with a sign and at least two digits
  s = s.replace(/e([+-])(\d)$/, "e$10$2");
  return s;
}

/** string.format("%q", s) as LuaJIT writes it. */
function quote(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const ch = s[i]!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\\n";
    else if (ch === "\r") out += "\\r";
    else if (c === 0 || c < 32 || c === 127) {
      const next = s.charCodeAt(i + 1);
      const digitNext = next >= 48 && next <= 57;
      out += digitNext ? `\\${String(c).padStart(3, "0")}` : `\\${c}`;
    } else out += ch;
  }
  return `${out}"`;
}

type Key = { k: number | string; v: unknown };

function tableEntries(v: object): Key[] {
  const out: Key[] = [];
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      if (!(i in v)) continue;
      const e = v[i];
      if (e === undefined || e === null) continue;
      out.push({ k: i + 1, v: e });
    }
    for (const k of Object.keys(v)) {
      if (/^(0|[1-9]\d*)$/.test(k) && Number(k) < v.length) continue;
      const e = (v as unknown as Record<string, unknown>)[k];
      if (e === undefined || e === null) continue;
      out.push({ k, v: e });
    }
  } else {
    for (const k of Object.keys(v)) {
      const e = (v as Record<string, unknown>)[k];
      if (e === undefined || e === null) continue;
      out.push({ k, v: e });
    }
  }
  // Lua: SaveSerializer.lua:23-27 -- by type name ("number" < "string"),
  // then by value.
  out.sort((a, b) => {
    const ta = typeof a.k;
    const tb = typeof b.k;
    if (ta !== tb) return ta < tb ? -1 : 1;
    if (ta === "number") return (a.k as number) - (b.k as number);
    return a.k < b.k ? -1 : a.k > b.k ? 1 : 0;
  });
  return out;
}

// Lua: SaveSerializer.lua:12-42
function serialize(v: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  const t = typeof v;
  if (t === "number") return numberText(v as number);
  if (t === "boolean") return String(v);
  if (t === "string") return quote(v as string);
  if (v !== null && t === "object") {
    const entries = tableEntries(v as object);
    if (entries.length === 0) return "{}";
    const parts: string[] = [];
    for (const { k, v: e } of entries) {
      const key = typeof k === "string" && IDENT.test(k) ? k : `[${serialize(k)}]`;
      parts.push(`${pad}  ${key} = ${serialize(e, indent + 1)}`);
    }
    return `{\n${parts.join(",\n")},\n${pad}}`;
  }
  throw new Error(`cannot serialize ${t}`);
}

// ------- reader

// Lua: SaveSerializer.lua:59-63
const ESCAPES: Record<string, string> = {
  '"': '"', "\\": "\\", n: "\n", r: "\r", t: "\t",
  a: "\x07", b: "\b", f: "\f", v: "\v",
  "\n": "\n", "\r": "\n",
};

// Lua: SaveSerializer.lua:67
const MAX_DEPTH = 128;

interface State {
  src: string;
  pos: number; // 1-based, as the Lua's
  depth: number;
  nodes: number;
  limits?: DecodeLimits;
}

class ParseError extends Error {}

// Lua: SaveSerializer.lua:69-71
function fail(state: State, why: string): never {
  throw new ParseError(`parse error at byte ${state.pos}: ${why}`);
}

function limit(state: State, name: keyof DecodeLimits): any {
  return state.limits ? state.limits[name] : undefined;
}

// Lua: SaveSerializer.lua:77-81
function bumpNode(state: State): void {
  state.nodes += 1;
  const maximum = limit(state, "maxNodes");
  if (maximum != null && state.nodes > maximum) fail(state, "too many values");
}

// Lua: SaveSerializer.lua:83-94
function skip(state: State): void {
  for (;;) {
    const src = state.src;
    let p = state.pos;
    while (p <= src.length && " \t\r\n".includes(src[p - 1]!)) p++;
    state.pos = p;
    if (!(state.limits && state.limits.allowComments && src.slice(state.pos - 1, state.pos + 1) === "--")) return;
    const nl = src.indexOf("\n", state.pos + 1);
    state.pos = nl >= 0 ? nl + 2 : src.length + 1;
  }
}

function peek(state: State): string {
  return state.src.charAt(state.pos - 1);
}

// Lua: SaveSerializer.lua:100-138
function readString(state: State): string {
  const src = state.src;
  const out: string[] = [];
  let i = state.pos + 1;
  for (;;) {
    const c = src.charAt(i - 1);
    if (c === "") {
      state.pos = i;
      fail(state, "unterminated string");
    } else if (c === '"') {
      state.pos = i + 1;
      const value = out.join("");
      const maximum = limit(state, "maxStringBytes");
      if (maximum != null && value.length > maximum) fail(state, "string too long");
      return value;
    } else if (c === "\\") {
      const nxt = src.charAt(i);
      if (/\d/.test(nxt)) {
        const digits = /^\d{1,3}/.exec(src.slice(i))![0];
        const code = Number(digits);
        if (code > 255) {
          state.pos = i;
          fail(state, "escape out of range");
        }
        out.push(String.fromCharCode(code));
        i = i + 1 + digits.length;
      } else if (Object.prototype.hasOwnProperty.call(ESCAPES, nxt) && nxt !== "") {
        out.push(ESCAPES[nxt]!);
        i += 2;
      } else {
        state.pos = i;
        fail(state, "bad string escape");
      }
    } else {
      out.push(c);
      i += 1;
    }
  }
}

// what Lua's tonumber accepts from the writer's tostring ("0.1", "-2",
// "1e+300", hex)
const NUMBER = /^-?(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)$/;

// Lua: SaveSerializer.lua:142-148
function readNumber(state: State): number {
  const m = /^[^,\]}\s]+/.exec(state.src.slice(state.pos - 1));
  const token = m ? m[0] : undefined;
  let value: number | undefined;
  if (token !== undefined && NUMBER.test(token)) {
    value = /0[xX]/.test(token) ? (token.startsWith("-") ? -parseInt(token.slice(1), 16) : parseInt(token, 16)) : Number(token);
  }
  if (value === undefined || Number.isNaN(value)) fail(state, "malformed number");
  state.pos += token!.length;
  return value;
}

// Lua: SaveSerializer.lua:150-155
function readIdent(state: State): string {
  const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(state.src.slice(state.pos - 1));
  if (!m) fail(state, "expected name");
  state.pos += m[0].length;
  return m[0];
}

/** The JS value for a Lua table, per the mapping in the header. */
function shapeTable(keys: Array<number | string>, values: unknown[]): unknown {
  let anyIndex = false;
  let otherNumber = false;
  for (const k of keys) {
    if (typeof k === "number") {
      if (Number.isInteger(k) && k >= 1) anyIndex = true;
      else otherNumber = true;
    }
  }
  if (keys.length === 0) return [];
  if (anyIndex && !otherNumber) {
    const arr: unknown[] = [];
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]!;
      if (typeof k === "number") arr[k - 1] = values[i];
      else (arr as unknown as Record<string, unknown>)[k] = values[i];
    }
    return arr;
  }
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < keys.length; i++) obj[String(keys[i])] = values[i];
  return obj;
}

// Lua: SaveSerializer.lua:159-234
function readTable(state: State): unknown {
  bumpNode(state);
  state.depth += 1;
  if (state.depth > (limit(state, "maxDepth") ?? MAX_DEPTH)) fail(state, "table nesting too deep");
  state.pos += 1;
  const keys: Array<number | string> = [];
  const values: unknown[] = [];
  const seen = new Set<string>();
  let entries = 0;
  let nextArray = 1;
  skip(state);
  if (peek(state) === "}") {
    state.pos += 1;
    state.depth -= 1;
    return shapeTable(keys, values);
  }
  for (;;) {
    skip(state);
    let key: unknown;
    let value: unknown;
    const c = peek(state);
    if (c === "[") {
      state.pos += 1;
      key = readValue(state);
      skip(state);
      if (peek(state) !== "]") fail(state, "expected ]");
      state.pos += 1;
      skip(state);
      if (peek(state) !== "=") fail(state, "expected =");
      state.pos += 1;
      value = readValue(state);
    } else if (/[A-Za-z_]/.test(c)) {
      const start = state.pos;
      const ident = readIdent(state);
      skip(state);
      if (peek(state) === "=") {
        key = ident;
        state.pos += 1;
        value = readValue(state);
      } else if (state.limits && state.limits.allowArray) {
        state.pos = start;
        key = nextArray;
        value = readValue(state);
      } else {
        fail(state, "expected =");
      }
    } else if (state.limits && state.limits.allowArray) {
      key = nextArray;
      value = readValue(state);
    } else {
      fail(state, "expected key");
    }
    if (key === undefined || key === null) fail(state, "nil table key");
    if (typeof key !== "number" && typeof key !== "string") fail(state, "bad table key");
    const id = `${typeof key}:${String(key)}`;
    if (seen.has(id)) fail(state, "duplicate table key");
    seen.add(id);
    entries += 1;
    const maximum = limit(state, "maxTableEntries");
    if (maximum != null && entries > maximum) fail(state, "too many table entries");
    keys.push(key as number | string);
    values.push(value);
    if (typeof key === "number" && key === nextArray) nextArray += 1;
    skip(state);
    const sep = peek(state);
    if (sep === ",") {
      state.pos += 1;
      skip(state);
      if (peek(state) === "}") {
        state.pos += 1;
        break;
      }
    } else if (sep === "}") {
      state.pos += 1;
      break;
    } else {
      fail(state, "expected , or }");
    }
  }
  state.depth -= 1;
  return shapeTable(keys, values);
}

// Lua: SaveSerializer.lua:236-256
function readValue(state: State): unknown {
  skip(state);
  const c = peek(state);
  if (c === '"') {
    bumpNode(state);
    return readString(state);
  } else if (c === "{") {
    return readTable(state);
  } else if (/[A-Za-z_]/.test(c)) {
    // the only bare words in the grammar are the boolean literals
    const word = readIdent(state);
    if (word === "true") {
      bumpNode(state);
      return true;
    }
    if (word === "false") {
      bumpNode(state);
      return false;
    }
    state.pos -= word.length;
    fail(state, `unexpected name '${word}'`);
  } else if (/[-\d.]/.test(c)) {
    bumpNode(state);
    return readNumber(state);
  }
  fail(state, c === "" ? "unexpected end of input" : "unexpected character");
}

export const SaveSerializer = {
  // Lua: SaveSerializer.lua:51-53
  encode(data: unknown): string {
    return `return ${serialize(data)}\n`;
  },

  /**
   * Lua: SaveSerializer.lua:258-279. The Lua returns `result` or
   * `nil, err`; this is the first value (undefined on failure). The error
   * text is `decodeWithError`'s second element.
   */
  decode(str: unknown, limits?: DecodeLimits): any {
    return SaveSerializer.decodeWithError(str, limits)[0];
  },

  /** Both of the Lua's returns: [table] or [undefined, err]. */
  decodeWithError(str: unknown, limits?: DecodeLimits): [any, string?] {
    if (typeof str !== "string") return [undefined, "save must be a string"];
    if (limits && limits.maxBytes != null && str.length > limits.maxBytes) {
      return [undefined, `input is ${str.length} bytes (max ${limits.maxBytes})`];
    }
    const state: State = { src: str, pos: 1, depth: 0, nodes: 0, limits };
    let result: unknown;
    try {
      skip(state);
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(state.src.slice(state.pos - 1));
      const word = m ? m[0] : undefined;
      if (word !== "return") fail(state, "expected return");
      state.pos += word.length;
      result = readValue(state);
      skip(state);
      if (state.pos <= state.src.length) fail(state, "trailing content");
    } catch (e) {
      if (e instanceof ParseError) return [undefined, e.message];
      if (e instanceof RangeError) return [undefined, "parse error: too deep"];
      throw e;
    }
    if (result === null || typeof result !== "object") {
      return [undefined, `${(limits && limits.rootName) || "save"} root must be a table`];
    }
    return [result];
  },
};

export default SaveSerializer;
