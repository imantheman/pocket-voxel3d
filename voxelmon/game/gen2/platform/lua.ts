// Small Lua standard-library equivalents for the Gen 2 port, so a ported
// line can stay close to the gen1recomp line it cites. Only what the engine
// actually uses: string.format, 1-based string.sub, Lua truthiness, and
// math.random with Lua's argument rules (see rng.ts for the generator).

/** Lua truthiness: only nil and false are false (0 and "" are TRUE). */
export function truthy(v: unknown): boolean {
  return v !== undefined && v !== null && v !== false;
}

/** string.sub(s, i, j) with Lua's 1-based, inclusive, negative-from-end rules. */
export function sub(s: string, i: number, j = -1): string {
  const n = s.length;
  let a = i < 0 ? Math.max(n + i + 1, 1) : i === 0 ? 1 : i;
  let b = j < 0 ? n + j + 1 : Math.min(j, n);
  if (a > b) return "";
  return s.slice(a - 1, b);
}

/** Lua's `//` and math.floor(a / b). */
export function idiv(a: number, b: number): number {
  return Math.floor(a / b);
}

/** Lua's `%` (the result takes the divisor's sign). */
export function mod(a: number, b: number): number {
  return a - Math.floor(a / b) * b;
}

/** tostring for the values the engine prints. */
export function tostring(v: unknown): string {
  if (v === undefined || v === null) return "nil";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(v);
  return String(v);
}

/** tonumber(s[, base]); undefined where Lua gives nil. */
export function tonumber(v: unknown, base?: number): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (t === "") return undefined;
  if (base !== undefined) {
    const n = parseInt(t, base);
    return Number.isNaN(n) ? undefined : n;
  }
  if (/^0x[0-9a-f]+$/i.test(t)) return parseInt(t, 16);
  const n = Number(t);
  return Number.isNaN(n) ? undefined : n;
}

/**
 * string.format for the conversions the engine uses: %d %i %u %x %X %o %c
 * %s %q %f %g %e %%, with flags (-, 0, +, space), width and precision.
 */
export function format(fmt: string, ...args: unknown[]): string {
  let ai = 0;
  return String(fmt).replace(/%([-+ 0#]*)(\d*)(?:\.(\d+))?([diuxXocsqfgeE%])/g, (_m, flags: string, width: string, prec: string | undefined, conv: string) => {
    if (conv === "%") return "%";
    const arg = args[ai++];
    let out: string;
    switch (conv) {
      case "d":
      case "i":
      case "u": {
        const n = Math.trunc(Number(arg));
        out = String(Math.abs(n));
        if (prec !== undefined) out = out.padStart(Number(prec), "0");
        if (n < 0) out = `-${out}`;
        else if (flags.includes("+")) out = `+${out}`;
        else if (flags.includes(" ")) out = ` ${out}`;
        break;
      }
      case "x":
      case "X":
      case "o": {
        const n = Math.trunc(Number(arg));
        out = (n >>> 0).toString(conv === "o" ? 8 : 16);
        if (conv === "X") out = out.toUpperCase();
        if (prec !== undefined) out = out.padStart(Number(prec), "0");
        break;
      }
      case "c":
        out = String.fromCharCode(Number(arg));
        break;
      case "s":
        out = tostring(arg);
        if (prec !== undefined) out = out.slice(0, Number(prec));
        break;
      case "q":
        out = JSON.stringify(tostring(arg));
        break;
      case "f":
        out = Number(arg).toFixed(prec === undefined ? 6 : Number(prec));
        if (Number(arg) >= 0 && flags.includes("+")) out = `+${out}`;
        break;
      case "e":
      case "E":
        out = Number(arg).toExponential(prec === undefined ? 6 : Number(prec));
        if (conv === "E") out = out.toUpperCase();
        break;
      default: {
        // %g
        const p = prec === undefined ? 6 : Math.max(1, Number(prec));
        out = String(Number(Number(arg).toPrecision(p)));
      }
    }
    const w = Number(width || 0);
    if (out.length < w) {
      if (flags.includes("-")) out = out.padEnd(w, " ");
      else if (flags.includes("0") && /[diuxXofeEg]/.test(conv)) {
        const sign = /^[-+ ]/.test(out) ? out[0]! : "";
        out = sign + out.slice(sign.length).padStart(w - sign.length, "0");
      } else out = out.padStart(w, " ");
    }
    return out;
  });
}

/** table.insert(t, pos, v) with Lua's 1-based pos. */
export function insertAt<T>(t: T[], pos: number, v: T): void {
  t.splice(pos - 1, 0, v);
}

/** table.remove(t[, pos]) with Lua's 1-based pos (default: the last). */
export function removeAt<T>(t: T[], pos?: number): T | undefined {
  if (t.length === 0) return undefined;
  if (pos === undefined) return t.pop();
  return t.splice(pos - 1, 1)[0];
}

/** Keys of a Lua table in a stable order (pairs() has none; sort for determinism). */
export function sortedKeys(o: Record<string, unknown>): string[] {
  return Object.keys(o).sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
