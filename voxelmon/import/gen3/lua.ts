// Port support for gen1recomp's FireRed engine (GPLv3 + additional terms; see
// LICENSE.md). LuaJIT's string and number semantics, exactly, for the gen3
// port -- the importer's cache files are byte-compared with LuaJIT's.
//
// THE STRING RULE of the gen3 port: a Lua string is a JS "byte string",
// one char per Lua byte (char codes 0..255). Source literals write any
// non-ASCII byte as \xNN; files are read and written as latin1. Then length,
// sub, byte, %q and padding all count bytes as Lua does, and text written
// out is byte-identical.

/** Lua truthiness: only nil and false are false (0 and "" are TRUE). */
export function truthy(v: unknown): boolean {
  return v !== undefined && v !== null && v !== false;
}

// ------------------------------------------------------------ numbers

const TWO52 = 2n ** 52n;

/** The exact decimal digits of a finite positive double: value = digits * 10^exp10. */
function exactDecimal(x: number): { digits: string; exp10: number } {
  // x = m * 2^e exactly
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, x);
  const hi = buf.getUint32(0), lo = buf.getUint32(4);
  const expBits = (hi >>> 20) & 0x7ff;
  let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e: number;
  if (expBits === 0) e = -1074;
  else { m += TWO52; e = expBits - 1075; }
  if (m === 0n) return { digits: "0", exp10: 0 };
  if (e >= 0) return { digits: (m << BigInt(e)).toString(), exp10: 0 };
  // m / 2^-e = m * 5^-e / 10^-e
  const k = -e;
  return { digits: (m * 5n ** BigInt(k)).toString(), exp10: -k };
}

/**
 * Round the exact decimal (digits * 10^exp10) to `keep` digits after the
 * decimal point, an exact tie away from zero (LuaJIT's own formatter,
 * lj_strfmt_num -- not glibc's half-even), returning an integer string of the
 * scaled value (value * 10^keep).
 */
function roundAt(digits: string, exp10: number, keep: number): string {
  // scaled = digits * 10^(exp10 + keep)
  const shift = exp10 + keep;
  if (shift >= 0) return digits + "0".repeat(shift);
  const cut = -shift;
  if (cut > digits.length) {
    // all digits fall below the cut: value < 10^-keep/... -> 0 or 1 by half-even
    const padded = "0".repeat(cut - digits.length) + digits;
    return roundStr(padded, cut);
  }
  return roundStr(digits, cut);
}

function roundStr(digits: string, cut: number): string {
  const headLen = digits.length - cut;
  const head = headLen > 0 ? digits.slice(0, headLen) : "0";
  const tail = digits.slice(Math.max(headLen, 0));
  const first = tail.charCodeAt(0) - 48;
  // values are positive here, so "away from zero" is up: 5 and above rounds up
  const up = first >= 5;
  if (!up) return head.replace(/^0+(?=\d)/, "");
  return (BigInt(head) + 1n).toString();
}

function fmtF(x: number, prec: number): string {
  if (x === 0) return prec > 0 ? "0." + "0".repeat(prec) : "0";
  const { digits, exp10 } = exactDecimal(x);
  const s = roundAt(digits, exp10, prec);
  if (prec === 0) return s;
  const padded = s.padStart(prec + 1, "0");
  return padded.slice(0, padded.length - prec) + "." + padded.slice(padded.length - prec);
}

/** Mantissa digits (prec+1 significant) and decimal exponent for %e. */
function sigDigits(x: number, sig: number): { mant: string; exp: number } {
  if (x === 0) return { mant: "0".repeat(sig), exp: 0 };
  const { digits, exp10 } = exactDecimal(x);
  // value = 0.digits... ; first digit's power = digits.length - 1 + exp10
  let exp = digits.length - 1 + exp10;
  let s = roundStr(digits, Math.max(digits.length - sig, 0));
  if (digits.length < sig) s = digits + "0".repeat(sig - digits.length);
  if (s.length > sig) { s = s.slice(0, sig); exp += 1; } // 9.99 -> 10.0
  return { mant: s, exp };
}

function fmtE(x: number, prec: number, upper: boolean, alt = false): string {
  const { mant, exp } = sigDigits(x, prec + 1);
  const body = mant[0] + (prec > 0 || alt ? "." + mant.slice(1) : "");
  const es = (exp < 0 ? "-" : "+") + String(Math.abs(exp)).padStart(2, "0");
  return body + (upper ? "E" : "e") + es;
}

function fmtG(x: number, prec: number, upper: boolean, alt = false): string {
  const p = prec === 0 ? 1 : prec;
  if (x === 0) return alt ? "0." + "0".repeat(p - 1) : "0";
  const { exp } = sigDigits(x, p);
  let out: string;
  if (exp < -4 || exp >= p) {
    out = fmtE(x, p - 1, upper, alt);
    if (!alt) out = out.replace(/\.?0+(?=[eE])/, "");
  } else {
    out = fmtF(x, p - 1 - exp);
    if (!alt && out.includes(".")) out = out.replace(/\.?0+$/, "");
  }
  return out;
}

function special(x: number, upper: boolean): string | undefined {
  if (Number.isNaN(x)) return upper ? "NAN" : "nan";
  if (x === Infinity) return upper ? "INF" : "inf";
  if (x === -Infinity) return upper ? "-INF" : "-inf";
  return undefined;
}

/** tostring(n) as LuaJIT prints it ("%.14g"). */
export function numberToString(n: number): string {
  if (Number.isNaN(n)) return "nan";
  if (n === Infinity) return "inf";
  if (n === -Infinity) return "-inf";
  if (Number.isInteger(n) && Math.abs(n) < 1e14) return Object.is(n, -0) ? "-0" : String(n);
  const neg = n < 0 || Object.is(n, -0);
  return (neg ? "-" : "") + fmtG(Math.abs(n), 14, false);
}

/** tostring for any value. */
export function tostring(v: unknown): string {
  if (v === undefined || v === null) return "nil";
  if (typeof v === "number") return numberToString(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

/** tonumber(s[, base]); undefined where Lua gives nil. */
export function tonumber(v: unknown, base?: number): number | undefined {
  if (typeof v === "number") return base === undefined ? v : undefined;
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (s === "") return undefined;
  if (base !== undefined && base !== 10) {
    if (!new RegExp(`^-?[0-9a-z]+$`, "i").test(s)) return undefined;
    const n = parseInt(s, base);
    return Number.isNaN(n) ? undefined : n;
  }
  if (/^-?0[xX][0-9a-fA-F]+$/.test(s)) return (s.startsWith("-") ? -1 : 1) * parseInt(s.replace(/^-?0[xX]/, ""), 16);
  if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s) && !/^[-+]?(inf|nan)$/i.test(s)) return undefined;
  const n = Number(s);
  return Number.isNaN(n) && !/nan/i.test(s) ? undefined : n;
}

/** Lua's `%` (the result takes the divisor's sign). */
export function mod(a: number, b: number): number {
  return a - Math.floor(a / b) * b;
}

/** math.floor(a / b). */
export function idiv(a: number, b: number): number {
  return Math.floor(a / b);
}

// ------------------------------------------------------------ string.format

const INT64_MIN = -(2n ** 63n);
/** The number as LuaJIT converts it for %d/%x: to int64, out of range saturating to INT64_MIN. */
function toInt(v: unknown, conv: string): bigint {
  const n = typeof v === "number" ? v : tonumber(v);
  if (n === undefined) throw new Error(`bad argument to format ('%${conv}' expects a number)`);
  if (!Number.isFinite(n) || n >= 2 ** 63 || n < -(2 ** 63)) return INT64_MIN;
  return BigInt(Math.trunc(n));
}

function pad(s: string, width: number, left: boolean, zero: boolean): string {
  if (s.length >= width) return s;
  if (left) return s + " ".repeat(width - s.length);
  if (zero) {
    const sign = /^[-+ ]/.test(s) ? s[0]! : "";
    const pre = /^[-+ ]?0[xX]/.test(s) ? s.slice(0, sign.length + 2) : sign;
    return pre + "0".repeat(width - s.length) + s.slice(pre.length);
  }
  return " ".repeat(width - s.length) + s;
}

function quoteLua(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 34) out += '\\"';
    else if (c === 92) out += "\\\\";
    else if (c === 10) out += "\\\n";
    else if (c === 0) out += nextDigit(s, i) ? "\\000" : "\\0";
    else if (c < 32 || c === 127) out += nextDigit(s, i) ? "\\" + String(c).padStart(3, "0") : "\\" + c;
    else out += s[i];
  }
  return out + '"';
}

function nextDigit(s: string, i: number): boolean {
  const n = s.charCodeAt(i + 1);
  return n >= 48 && n <= 57;
}

/** string.format with LuaJIT's results (flags, width, precision; d i u c x X o e E f g G q s a %). */
export function format(fmt: string, ...args: unknown[]): string {
  let out = "";
  let ai = 0;
  for (let i = 0; i < fmt.length; i++) {
    const ch = fmt[i];
    if (ch !== "%") { out += ch; continue; }
    if (fmt[i + 1] === "%") { out += "%"; i++; continue; }
    const m = /^([-+ #0]*)(\d*)(?:\.(\d*))?([diucxXoeEfgGqsa])/.exec(fmt.slice(i + 1));
    if (!m) throw new Error(`invalid option in format '${fmt}'`);
    i += m[0].length;
    const flags = m[1]!, width = m[2] ? Number(m[2]) : 0, prec = m[3] !== undefined ? Number(m[3] || "0") : undefined;
    const conv = m[4]!;
    const left = flags.includes("-"), zero = flags.includes("0") && !left;
    const plus = flags.includes("+"), space = flags.includes(" "), alt = flags.includes("#");
    const arg = args[ai++];
    let s: string;
    switch (conv) {
      case "d": case "i": {
        const n = toInt(arg, conv);
        let body = (n < 0n ? -n : n).toString();
        if (prec !== undefined) body = body.padStart(prec, "0");
        s = (n < 0n ? "-" : plus ? "+" : space ? " " : "") + body;
        s = pad(s, width, left, zero && prec === undefined);
        break;
      }
      case "u": case "x": case "X": case "o": {
        let n = toInt(arg, conv);
        if (n < 0n) n += 2n ** 64n;
        let body = n.toString(conv === "o" ? 8 : conv === "u" ? 10 : 16);
        if (conv === "X") body = body.toUpperCase();
        if (prec !== undefined) body = body.padStart(prec, "0");
        if (alt && n !== 0n && (conv === "x" || conv === "X")) body = (conv === "x" ? "0x" : "0X") + body;
        if (alt && conv === "o" && !body.startsWith("0")) body = "0" + body;
        s = pad(body, width, left, zero && prec === undefined);
        break;
      }
      case "c":
        s = pad(String.fromCharCode(Number(toInt(arg, conv) & 255n)), width, left, false);
        break;
      case "e": case "E": case "f": case "g": case "G": case "a": {
        const n = typeof arg === "number" ? arg : tonumber(arg);
        if (n === undefined) throw new Error(`bad argument to format ('%${conv}' expects a number)`);
        const neg = n < 0 || Object.is(n, -0);
        const x = Math.abs(n);
        const upper = conv === "E" || conv === "G";
        let body = special(x, upper);
        if (body === undefined) {
          const p = prec ?? 6;
          if (conv === "f") body = fmtF(x, p) + (alt && p === 0 ? "." : "");
          else if (conv === "e" || conv === "E") body = fmtE(x, p, upper, alt);
          else if (conv === "a") body = x.toString(16);
          else body = fmtG(x, p, upper, alt);
        }
        s = (neg && !Number.isNaN(n) ? "-" : plus ? "+" : space ? " " : "") + body;
        s = pad(s, width, left, zero && Number.isFinite(n));
        break;
      }
      case "q":
        s = quoteLua(tostring(arg));
        break;
      case "s": {
        let str = tostring(arg);
        if (prec !== undefined) str = str.slice(0, prec);
        s = pad(str, width, left, false);
        break;
      }
      default:
        throw new Error(`invalid conversion '%${conv}'`);
    }
    out += s;
  }
  return out;
}

// ------------------------------------------------------------ byte strings

/** string.sub(s, i, j) with Lua's 1-based, inclusive, negative-from-end rules. */
export function sub(s: string, i = 1, j = -1): string {
  const n = s.length;
  const a = i < 0 ? Math.max(n + i + 1, 1) : i === 0 ? 1 : i;
  const b = j < 0 ? n + j + 1 : Math.min(j, n);
  if (a > b) return "";
  return s.slice(a - 1, b);
}

/** s:byte(i) for one byte (undefined past the end, like nil). */
export function byte(s: string, i = 1): number | undefined {
  const k = i < 0 ? s.length + i : i - 1;
  if (k < 0 || k >= s.length) return undefined;
  return s.charCodeAt(k);
}

/** string.char(...) */
export function char(...codes: number[]): string {
  return String.fromCharCode(...codes.map((c) => c & 255));
}

/** string.rep(s, n[, sep]) */
export function rep(s: string, n: number, sep = ""): string {
  if (n <= 0) return "";
  return sep === "" ? s.repeat(n) : Array(n).fill(s).join(sep);
}

/** A byte string's bytes. */
export function toBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Bytes as a byte string (chunked so big buffers don't overflow the stack). */
export function fromBytes(b: Uint8Array, start = 0, end = b.length): string {
  let out = "";
  for (let i = start; i < end; i += 0x2000) {
    out += String.fromCharCode.apply(null, b.subarray(i, Math.min(end, i + 0x2000)) as unknown as number[]);
  }
  return out;
}

/** table.insert(t, pos, v) at a 1-based position. */
export function insertAt<T>(t: T[], pos: number, v: T): void {
  t.splice(pos - 1, 0, v);
}

/** table.remove(t[, pos]) at a 1-based position. */
export function removeAt<T>(t: T[], pos?: number): T | undefined {
  if (t.length === 0) return undefined;
  return t.splice(pos === undefined ? t.length - 1 : pos - 1, 1)[0];
}

/** Keys sorted the way the port sorts Lua `pairs` output where order matters. */
export function sortedKeys(o: Record<string | number, unknown>): string[] {
  return Object.keys(o).sort((a, b) => {
    const na = Number(a), nb = Number(b);
    const ia = a !== "" && Number.isFinite(na), ib = b !== "" && Number.isFinite(nb);
    if (ia && ib) return na - nb;
    if (ia) return -1;
    if (ib) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
