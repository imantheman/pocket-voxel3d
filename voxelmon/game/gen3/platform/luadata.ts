// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). Lua `load(src, name, "t", {})()` for the importer cache's
// data chunks.
//
// gen1recomp's runtime reads ~100 cache files that way. They are data: most
// are `return { ... }`, a few build a table in steps (`local M = {...}`,
// `M.machines[0] = 264`, `return M`). This evaluates exactly that subset --
// local declarations, assignments to name/field/index paths, `return`, table
// constructors, literals, names, field/index reads, unary minus, `..` and
// arithmetic on numbers -- and throws, with a line number, on anything else
// (functions, loops, conditionals). It is not a Lua interpreter.
//
// The result is in the runtime port's table shape (lt.ts): a table whose
// keys are all non-negative integers is a JS array (slot 0 empty unless key
// 0 is set; nil holes are null); any other table is a plain object (integer
// keys allowed). Shared references stay shared. NOT FAITHFUL: a Lua table
// can hold 5 and "5" as two keys; a JS object holds one (the later). The
// cache does that only to file equal records under both (scripts/marts.lua),
// and the luadata test checks every such pair is equal.
//
// On the 3DS the cook converts each cache .lua file once into the same shape
// as JSON behind COOKED_TAG, and luaLoad JSON.parses that instead -- the same
// call sites, a fraction of the time. Strings are byte strings throughout.

/** The prefix of a cooked (pre-converted) data chunk. */
export const COOKED_TAG = "\x00PVJ1\n";

type Val = number | string | boolean | null | Tbl;
class Tbl {
  /** keys in insertion order; integer keys as numbers */
  keys: (number | string)[] = [];
  vals = new Map<number | string, Val>();
  set(k: number | string, v: Val): void {
    if (typeof k === "number" && !Number.isFinite(k)) throw new Error("table index is NaN/inf");
    if (!this.vals.has(k)) this.keys.push(k);
    this.vals.set(k, v);
  }
  get(k: number | string): Val { return this.vals.get(k) ?? null; }
  border(): number { let n = 0; while (this.vals.get(n + 1) != null) n++; return n; }
}

// ------------------------------------------------------------ lexer
type Tok = { t: string; v?: string | number; line: number };

function lex(src: string, name: string): Tok[] {
  const out: Tok[] = [];
  let i = 0, line = 1;
  const n = src.length;
  const err = (m: string): never => { throw new Error(`${name}:${line}: ${m}`); };
  const longBracket = (): string | undefined => {
    // at '[': [=*[
    let j = i + 1, lvl = 0;
    while (src[j] === "=") { lvl++; j++; }
    if (src[j] !== "[") return undefined;
    const close = "]" + "=".repeat(lvl) + "]";
    const end = src.indexOf(close, j + 1);
    if (end < 0) err("unfinished long string");
    let s = src.slice(j + 1, end);
    if (s.startsWith("\r\n")) s = s.slice(2); else if (s[0] === "\n" || s[0] === "\r") s = s.slice(1);
    for (const ch of src.slice(i, end + close.length)) if (ch === "\n") line++;
    i = end + close.length;
    return s;
  };
  while (i < n) {
    const c = src[i]!;
    if (c === "\n") { line++; i++; continue; }
    if (c === " " || c === "\t" || c === "\r" || c === "\f" || c === "\v") { i++; continue; }
    if (c === "-" && src[i + 1] === "-") {
      i += 2;
      if (src[i] === "[") { const s = longBracket(); if (s !== undefined) continue; }
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "[" && (src[i + 1] === "[" || src[i + 1] === "=")) {
      const s = longBracket();
      if (s !== undefined) { out.push({ t: "str", v: s, line }); continue; }
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(src[j]!)) j++;
      const w = src.slice(i, j);
      i = j;
      if (["local", "return", "nil", "true", "false", "and", "or", "not"].includes(w)) out.push({ t: w, line });
      else if (["function", "for", "while", "if", "repeat", "do", "end", "goto", "break", "then", "else", "elseif", "until", "in"].includes(w)) err(`'${w}' is not supported in a data chunk`);
      else out.push({ t: "name", v: w, line });
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      let j = i;
      let v: number;
      if (c === "0" && (src[i + 1] === "x" || src[i + 1] === "X")) {
        j = i + 2;
        while (j < n && /[0-9A-Fa-f]/.test(src[j]!)) j++;
        v = parseInt(src.slice(i + 2, j), 16);
      } else {
        while (j < n && /[0-9.]/.test(src[j]!)) j++;
        if (src[j] === "e" || src[j] === "E") { j++; if (src[j] === "+" || src[j] === "-") j++; while (j < n && /[0-9]/.test(src[j]!)) j++; }
        v = Number(src.slice(i, j));
      }
      if (Number.isNaN(v)) err(`bad number '${src.slice(i, j)}'`);
      out.push({ t: "num", v, line });
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1, s = "";
      while (j < n && src[j] !== c) {
        let ch = src[j]!;
        if (ch === "\n") err("unfinished string");
        if (ch === "\\") {
          j++;
          ch = src[j]!;
          const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", f: "\f", v: "\v", "\\": "\\", '"': '"', "'": "'", "\n": "\n" };
          if (map[ch] !== undefined) { if (ch === "\n") line++; s += map[ch]; j++; continue; }
          if (ch === "x") { s += String.fromCharCode(parseInt(src.slice(j + 1, j + 3), 16)); j += 3; continue; }
          if (/[0-9]/.test(ch)) {
            let k = j;
            while (k < j + 3 && /[0-9]/.test(src[k]!)) k++;
            const code = Number(src.slice(j, k));
            if (code > 255) err("escape too large");
            s += String.fromCharCode(code);
            j = k;
            continue;
          }
          if (ch === "z") { j++; while (/\s/.test(src[j]!)) { if (src[j] === "\n") line++; j++; } continue; }
          err(`bad escape \\${ch}`);
        }
        s += ch;
        j++;
      }
      if (j >= n) err("unfinished string");
      out.push({ t: "str", v: s, line });
      i = j + 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "==" || two === "~=" || two === "<=" || two === ">=" || two === "..") {
      if (src.slice(i, i + 3) === "...") err("'...' is not supported");
      out.push({ t: two, line }); i += 2; continue;
    }
    if ("{}[]()=,;.+-*/%^#<>:".includes(c)) { out.push({ t: c, line }); i++; continue; }
    err(`unexpected character '${c}'`);
  }
  out.push({ t: "eof", line });
  return out;
}

// ------------------------------------------------------------ evaluator
function evaluate(src: string, name: string): Val {
  const toks = lex(src, name);
  let p = 0;
  const env = new Map<string, Val>();
  const peek = () => toks[p]!;
  const err = (m: string): never => { throw new Error(`${name}:${peek().line}: ${m}`); };
  const take = (t: string) => { if (peek().t !== t) err(`expected '${t}' near '${peek().t}'`); return toks[p++]!; };
  const accept = (t: string) => { if (peek().t === t) { p++; return true; } return false; };

  const index = (o: Val, k: Val): Val => {
    if (!(o instanceof Tbl)) return err("attempt to index a non-table value");
    if (k === null) return null;
    return o.get(k as number | string);
  };

  function primary(): Val {
    const tk = peek();
    if (tk.t === "name") {
      p++;
      if (!env.has(tk.v as string)) {
        if (tk.v === "math") { take("."); const f = take("name").v; if (f === "huge") return Infinity; if (f === "pi") return Math.PI; err(`math.${f} is not supported`); }
        err(`unknown name '${tk.v}' (globals are not supported)`);
      }
      return env.get(tk.v as string)!;
    }
    if (tk.t === "(") { p++; const v = expr(); take(")"); return v; }
    return err(`unexpected '${tk.t}'`);
  }
  function suffixed(): Val {
    let v = primary();
    for (;;) {
      if (accept(".")) v = index(v, take("name").v as string);
      else if (accept("[")) { const k = expr(); take("]"); v = index(v, k); }
      else if (peek().t === "(" || peek().t === ":" || peek().t === "{" || peek().t === "str") err("function calls are not supported");
      else return v;
    }
  }
  function simple(): Val {
    const tk = peek();
    switch (tk.t) {
      case "num": p++; return tk.v as number;
      case "str": p++; return tk.v as string;
      case "nil": p++; return null;
      case "true": p++; return true;
      case "false": p++; return false;
      case "{": return ctor();
      default: return suffixed();
    }
  }
  const PRI: Record<string, [number, number]> = { "+": [6, 6], "-": [6, 6], "*": [7, 7], "/": [7, 7], "%": [7, 7], "^": [10, 9], "..": [5, 4] };
  function unary(): Val {
    if (accept("-")) { const v = sub(8); if (typeof v !== "number") err("unary minus on a non-number"); return -(v as number); }
    if (accept("#")) { const v = sub(8); if (typeof v === "string") return v.length; if (v instanceof Tbl) return v.border(); return err("length of a non-table"); }
    return simple();
  }
  function sub(limit: number): Val {
    let v = unary();
    for (;;) {
      const op = peek().t;
      const pr = PRI[op];
      if (!pr || pr[0] <= limit) return v;
      p++;
      const r = sub(pr[1]);
      if (op === "..") {
        const s = (x: Val) => (typeof x === "string" ? x : typeof x === "number" ? String(x) : err("concatenating a non-string"));
        v = s(v) + s(r);
      } else {
        if (typeof v !== "number" || typeof r !== "number") err("arithmetic on a non-number");
        const a = v as number, b = r as number;
        v = op === "+" ? a + b : op === "-" ? a - b : op === "*" ? a * b : op === "/" ? a / b : op === "%" ? a - Math.floor(a / b) * b : Math.pow(a, b);
      }
    }
  }
  function expr(): Val { return sub(0); }
  function ctor(): Tbl {
    take("{");
    const t = new Tbl();
    let n = 0;
    while (peek().t !== "}") {
      if (peek().t === "[") {
        p++; const k = expr(); take("]"); take("=");
        if (k === null) err("table index is nil");
        const v = expr();
        if (v !== null) t.set(k as number | string, v);
      } else if (peek().t === "name" && toks[p + 1]!.t === "=") {
        const k = toks[p]!.v as string; p += 2;
        const v = expr();
        if (v !== null) t.set(k, v);
      } else {
        n++;
        const v = expr();
        if (v !== null) t.set(n, v);
      }
      if (!accept(",") && !accept(";")) break;
    }
    take("}");
    return t;
  }

  // statements
  for (;;) {
    while (accept(";"));
    const tk = peek();
    if (tk.t === "eof") return null;
    if (tk.t === "return") {
      p++;
      const v = peek().t === "eof" || peek().t === ";" ? null : expr();
      accept(";");
      if (peek().t !== "eof") err("'return' must be the last statement");
      return v;
    }
    if (tk.t === "local") {
      p++;
      const names = [take("name").v as string];
      while (accept(",")) names.push(take("name").v as string);
      const vals: Val[] = [];
      if (accept("=")) { vals.push(expr()); while (accept(",")) vals.push(expr()); }
      names.forEach((nm, k) => env.set(nm, vals[k] ?? null));
      continue;
    }
    // assignment: name { .f | [k] } = expr
    const nm = take("name").v as string;
    if (!env.has(nm)) err(`assignment to unknown name '${nm}' (globals are not supported)`);
    let target: Val = env.get(nm)!;
    let key: number | string | undefined;
    for (;;) {
      let k: Val | undefined;
      if (accept(".")) k = take("name").v as string;
      else if (accept("[")) { k = expr(); take("]"); }
      else break;
      if (key !== undefined) target = index(target, key);
      if (k === null) err("table index is nil");
      key = k as number | string;
    }
    take("=");
    const v = expr();
    if (key === undefined) env.set(nm, v);
    else {
      if (!(target instanceof Tbl)) err("attempt to index a non-table value");
      const tt = target as Tbl;
      if (v === null) tt.vals.delete(key); else tt.set(key, v);
    }
  }
}

// ------------------------------------------------------------ shape
function shape(v: Val, memo: Map<Tbl, unknown>): unknown {
  if (!(v instanceof Tbl)) return v;
  const hit = memo.get(v);
  if (hit !== undefined) return hit;
  let allInt = true, max = 0;
  for (const k of v.vals.keys()) {
    if (typeof k !== "number" || !Number.isInteger(k) || k < 0) { allInt = false; break; }
    if (k > max) max = k;
  }
  // a sparse integer table with huge keys stays an object (a 1e9-slot array is not a table)
  if (allInt && v.vals.size > 0 && max > 4 * v.vals.size + 64) allInt = false;
  if (allInt && v.vals.size > 0) {
    const arr: unknown[] = new Array(max + 1).fill(null);
    memo.set(v, arr);
    for (const [k, x] of v.vals) arr[k as number] = shape(x, memo);
    return arr;
  }
  if (v.vals.size === 0) { const empty = {}; memo.set(v, empty); return empty; }
  const obj: Record<string, unknown> = {};
  memo.set(v, obj);
  for (const k of v.keys) if (v.vals.has(k)) obj[String(k)] = shape(v.vals.get(k)!, memo);
  return obj;
}

/** Evaluate a data chunk's source (Lua, or cooked) to the runtime table shape. */
export function evalData(src: string, name = "=data"): unknown {
  if (src.startsWith(COOKED_TAG)) return JSON.parse(src.slice(COOKED_TAG.length));
  return shape(evaluate(src, name), new Map());
}

/**
 * Lua `load(src, name, "t", {})`: a chunk to call, or [undefined, err] when
 * it does not parse (Lua's nil, message). The call evaluates.
 */
export function luaLoad(src: string | null | undefined, name = "=data"): [(() => unknown) | undefined, string | undefined] {
  if (src == null) return [undefined, "no source"];
  try {
    const v = evalData(src, name);
    return [() => v, undefined];
  } catch (e) {
    return [undefined, String((e as Error).message ?? e)];
  }
}

/** The cook's conversion: a data chunk's Lua source -> its cooked form. */
export function cookData(src: string, name = "=data"): string {
  return COOKED_TAG + JSON.stringify(evalData(src, name));
}

export const LuaData = { evalData, luaLoad, cookData, COOKED_TAG };
export default LuaData;
