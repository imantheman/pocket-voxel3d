// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). Lua 5.1 string patterns: string.find / match / gmatch /
// gsub, a port of the matcher in Lua's lstrlib.c (as LuaJIT implements it).
// Ported code calls these instead of hand-translating patterns to regexes:
//   s:find(p, init, plain)  -> find(s, p, init, plain)   -> [start, end, ...caps] | undefined
//   s:match(p, init)        -> match(s, p, init)         -> first capture (or whole match) | undefined;
//                              matchAll(s, p, init) for every capture as a tuple
//   s:gmatch(p)             -> gmatch(s, p)              -> iterator of capture tuples
//   s:gsub(p, repl, n)      -> gsub(s, p, repl, n)       -> [result, count]
// Strings are byte strings; positions are 1-based like Lua's. A position
// capture `()` yields a number.

type Cap = string | number;
const L_ESC = "%";
const SPECIALS = "^$*+?.([%-";
const MAXCCALLS = 200;
const CAP_UNFINISHED = -1;
const CAP_POSITION = -2;

class MatchState {
  level = 0;
  capStart: number[] = [];
  capLen: number[] = [];
  depth = 0;
  constructor(readonly src: string, readonly pat: string) {}
  /** Ready for the next start position (lstrlib.c resets ms.level per try). */
  reset(): MatchState { this.level = 0; this.depth = 0; return this; }
}

/**
 * The literal text every match of `pat` (from p0) must start with: its
 * leading ordinary characters, less the last one if a '*', '?' or '-' makes
 * that one optional. A match can only start where this text occurs, so the
 * searches below jump there instead of trying each position (the result is
 * the same: a try elsewhere fails on its first characters). Port speed-up;
 * not in lstrlib.c.
 */
function literalPrefix(pat: string, p0: number): string {
  let k = p0;
  while (k < pat.length && !SPECIALS.includes(pat[k]!) && pat[k] !== ")" && pat[k] !== "]") k++;
  if (k < pat.length && k > p0 && (pat[k] === "*" || pat[k] === "?" || pat[k] === "-")) k--;
  return pat.slice(p0, k);
}

function classEnd(ms: MatchState, p: number): number {
  const pat = ms.pat;
  if (p >= pat.length) throw new Error("malformed pattern (ends with '%')");
  const c = pat[p++]!;
  if (c === L_ESC) {
    if (p >= pat.length) throw new Error("malformed pattern (ends with '%')");
    return p + 1;
  }
  if (c === "[") {
    if (pat[p] === "^") p++;
    do {
      if (p >= pat.length) throw new Error("malformed pattern (missing ']')");
      const cc = pat[p++]!;
      if (cc === L_ESC && p < pat.length) p++;
    } while (pat[p] !== "]");
    return p + 1;
  }
  return p;
}

function isClass(c: number, cl: string): boolean {
  let res: boolean;
  switch (cl.toLowerCase()) {
    case "a": res = (c >= 65 && c <= 90) || (c >= 97 && c <= 122); break;
    case "c": res = c < 32 || c === 127; break;
    case "d": res = c >= 48 && c <= 57; break;
    case "l": res = c >= 97 && c <= 122; break;
    case "p": res = (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126); break;
    case "s": res = c === 32 || (c >= 9 && c <= 13); break;
    case "u": res = c >= 65 && c <= 90; break;
    case "w": res = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122); break;
    case "x": res = (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102); break;
    case "z": res = c === 0; break;
    default: return cl.charCodeAt(0) === c;
  }
  return cl >= "A" && cl <= "Z" ? !res : res;
}

function matchBracketClass(ms: MatchState, c: number, p: number, ec: number): boolean {
  const pat = ms.pat;
  let sig = true;
  if (pat[p + 1] === "^") { sig = false; p++; }
  while (++p < ec) {
    if (pat[p] === L_ESC) {
      p++;
      if (isClass(c, pat[p]!)) return sig;
    } else if (pat[p + 1] === "-" && p + 2 < ec) {
      p += 2;
      if (pat.charCodeAt(p - 2) <= c && c <= pat.charCodeAt(p)) return sig;
    } else if (pat.charCodeAt(p) === c) return sig;
  }
  return !sig;
}

function singleMatch(ms: MatchState, s: number, p: number, ep: number): boolean {
  if (s >= ms.src.length) return false;
  const c = ms.src.charCodeAt(s);
  switch (ms.pat[p]) {
    case ".": return true;
    case L_ESC: return isClass(c, ms.pat[p + 1]!);
    case "[": return matchBracketClass(ms, c, p, ep - 1);
    default: return ms.pat.charCodeAt(p) === c;
  }
}

function matchBalance(ms: MatchState, s: number, p: number): number {
  if (p + 1 >= ms.pat.length) throw new Error("missing arguments to '%b'");
  if (s >= ms.src.length || ms.src[s] !== ms.pat[p]) return -1;
  const b = ms.pat[p]!, e = ms.pat[p + 1]!;
  let cont = 1;
  while (++s < ms.src.length) {
    const ch = ms.src[s];
    if (ch === e) { if (--cont === 0) return s + 1; }
    else if (ch === b) cont++;
  }
  return -1;
}

function maxExpand(ms: MatchState, s: number, p: number, ep: number): number {
  let i = 0;
  while (singleMatch(ms, s + i, p, ep)) i++;
  while (i >= 0) {
    const res = doMatch(ms, s + i, ep + 1);
    if (res !== -1) return res;
    i--;
  }
  return -1;
}

function minExpand(ms: MatchState, s: number, p: number, ep: number): number {
  for (;;) {
    const res = doMatch(ms, s, ep + 1);
    if (res !== -1) return res;
    if (singleMatch(ms, s, p, ep)) s++;
    else return -1;
  }
}

function startCapture(ms: MatchState, s: number, p: number, what: number): number {
  ms.capStart[ms.level] = s;
  ms.capLen[ms.level] = what;
  ms.level++;
  const res = doMatch(ms, s, p);
  if (res === -1) ms.level--;
  return res;
}

function captureToClose(ms: MatchState): number {
  let level = ms.level;
  for (level--; level >= 0; level--) if (ms.capLen[level] === CAP_UNFINISHED) return level;
  throw new Error("invalid pattern capture");
}

function endCapture(ms: MatchState, s: number, p: number): number {
  const l = captureToClose(ms);
  ms.capLen[l] = s - ms.capStart[l]!;
  const res = doMatch(ms, s, p);
  if (res === -1) ms.capLen[l] = CAP_UNFINISHED;
  return res;
}

function checkCapture(ms: MatchState, l: number): number {
  l -= 49; // '1'
  if (l < 0 || l >= ms.level || ms.capLen[l] === CAP_UNFINISHED) throw new Error(`invalid capture index %${l + 1}`);
  return l;
}

function matchCapture(ms: MatchState, s: number, l: number): number {
  l = checkCapture(ms, l);
  const len = ms.capLen[l]!;
  const cap = ms.src.substr(ms.capStart[l]!, len);
  if (ms.src.length - s >= len && ms.src.substr(s, len) === cap) return s + len;
  return -1;
}

function doMatch(ms: MatchState, s: number, p: number): number {
  if (ms.depth++ > MAXCCALLS * 50) throw new Error("pattern too complex");
  try {
    const pat = ms.pat;
    for (;;) {
      if (p >= pat.length) return s;
      const pc = pat[p]!;
      if (pc === "(") {
        if (pat[p + 1] === ")") return startCapture(ms, s, p + 2, CAP_POSITION);
        return startCapture(ms, s, p + 1, CAP_UNFINISHED);
      }
      if (pc === ")") return endCapture(ms, s, p + 1);
      if (pc === L_ESC) {
        const nx = pat[p + 1];
        if (nx === "b") {
          s = matchBalance(ms, s, p + 2);
          if (s !== -1) { p += 4; continue; }
          return -1;
        }
        if (nx === "f") {
          p += 2;
          if (pat[p] !== "[") throw new Error("missing '[' after '%f' in pattern");
          const ep = classEnd(ms, p);
          const prev = s === 0 ? 0 : ms.src.charCodeAt(s - 1);
          const cur = s < ms.src.length ? ms.src.charCodeAt(s) : 0;
          if (!matchBracketClass(ms, prev, p, ep - 1) && matchBracketClass(ms, cur, p, ep - 1)) { p = ep; continue; }
          return -1;
        }
        if (nx !== undefined && nx >= "0" && nx <= "9") {
          s = matchCapture(ms, s, pat.charCodeAt(p + 1));
          if (s !== -1) { p += 2; continue; }
          return -1;
        }
      }
      if (pc === "$" && p + 1 === pat.length) return s === ms.src.length ? s : -1;
      const ep = classEnd(ms, p);
      const m = s < ms.src.length && singleMatch(ms, s, p, ep);
      const q = pat[ep];
      if (q === "?") {
        if (m) { const res = doMatch(ms, s + 1, ep + 1); if (res !== -1) return res; }
        p = ep + 1;
        continue;
      }
      if (q === "*") return maxExpand(ms, s, p, ep);
      if (q === "+") return m ? maxExpand(ms, s + 1, p, ep) : -1;
      if (q === "-") return minExpand(ms, s, p, ep);
      if (!m) return -1;
      s++;
      p = ep;
    }
  } finally {
    ms.depth--;
  }
}

function getCapture(ms: MatchState, i: number, s: number, e: number): Cap {
  if (i >= ms.level) {
    if (i === 0) return ms.src.slice(s, e);
    throw new Error("invalid capture index");
  }
  const l = ms.capLen[i]!;
  if (l === CAP_UNFINISHED) throw new Error("unfinished capture");
  if (l === CAP_POSITION) return ms.capStart[i]! + 1;
  return ms.src.substr(ms.capStart[i]!, l);
}

function captures(ms: MatchState, s: number, e: number, wholeIfNone: boolean): Cap[] {
  const n = ms.level === 0 && wholeIfNone ? 1 : ms.level;
  const out: Cap[] = [];
  for (let i = 0; i < n; i++) out.push(getCapture(ms, i, s, e));
  return out;
}

// Lua 5.1 str_find_aux: posrelat, then clamp to [0, len]
function startIndex(len: number, init: number | undefined): number {
  let i = init ?? 1;
  if (i < 0) i = len + i + 1;
  i -= 1;
  return i < 0 ? 0 : i > len ? len : i;
}

function hasSpecials(p: string): boolean {
  for (const c of p) if (SPECIALS.includes(c)) return true;
  return false;
}

/** string.find -> [start, end, ...captures] (1-based) or undefined. */
export function find(s: string, pat: string, init?: number, plain?: boolean): [number, number, ...Cap[]] | undefined {
  const st = startIndex(s.length, init);
  if (plain || !hasSpecials(pat)) {
    const at = s.indexOf(pat, st);
    return at < 0 ? undefined : [at + 1, at + pat.length];
  }
  const anchor = pat[0] === "^";
  const p0 = anchor ? 1 : 0;
  const pre = anchor ? "" : literalPrefix(pat, p0);
  const ms = new MatchState(s, pat);
  let s1 = st;
  do {
    if (pre) { s1 = s.indexOf(pre, s1); if (s1 < 0) return undefined; }
    const e = doMatch(ms.reset(), s1, p0);
    if (e !== -1) return [s1 + 1, e, ...captures(ms, s1, e, false)];
    s1++;
  } while (s1 <= s.length && !anchor);
  return undefined;
}

/** Every capture of string.match as a tuple (the whole match when there are none), or undefined. */
export function matchAll(s: string, pat: string, init?: number): Cap[] | undefined {
  const st = startIndex(s.length, init);
  const anchor = pat[0] === "^";
  const p0 = anchor ? 1 : 0;
  const pre = anchor ? "" : literalPrefix(pat, p0);
  const ms = new MatchState(s, pat);
  let s1 = st;
  do {
    if (pre) { s1 = s.indexOf(pre, s1); if (s1 < 0) return undefined; }
    const e = doMatch(ms.reset(), s1, p0);
    if (e !== -1) return captures(ms, s1, e, true);
    s1++;
  } while (s1 <= s.length && !anchor);
  return undefined;
}

/** string.match's first result (the first capture, or the whole match), or undefined. */
export function match(s: string, pat: string, init?: number): Cap | undefined {
  return matchAll(s, pat, init)?.[0];
}

/** string.gmatch: each match's captures as a tuple (Lua 5.1 gmatch_aux; '^' is literal). */
export function* gmatch(s: string, pat: string): Generator<Cap[]> {
  let pos = 0;
  const pre = literalPrefix(pat, 0);
  const ms = new MatchState(s, pat);
  while (pos <= s.length) {
    let found = false;
    for (let src = pos; src <= s.length; src++) {
      if (pre) { src = s.indexOf(pre, src); if (src < 0) return; }
      const e = doMatch(ms.reset(), src, 0);
      if (e !== -1) {
        pos = e === src ? src + 1 : e;
        found = true;
        yield captures(ms, src, e, true);
        break;
      }
    }
    if (!found) return;
  }
}

export type GsubRepl = string | Record<string, unknown> | ((...caps: Cap[]) => unknown);

/** string.gsub -> [result, count]. */
export function gsub(s: string, pat: string, repl: GsubRepl, maxN?: number): [string, number] {
  const anchor = pat[0] === "^";
  const p0 = anchor ? 1 : 0;
  const limit = maxN ?? s.length + 1;
  let src = 0, n = 0;
  let out = "";
  const pre = anchor ? "" : literalPrefix(pat, p0);
  const ms = new MatchState(s, pat);
  while (n < limit) {
    if (pre) {
      // no match can start before the next occurrence of the prefix
      const next = s.indexOf(pre, src);
      if (next < 0) break;
      out += s.slice(src, next);
      src = next;
    }
    const e = doMatch(ms.reset(), src, p0);
    if (e !== -1) {
      n++;
      const whole = s.slice(src, e);
      const caps = captures(ms, src, e, true);
      let rep: unknown;
      if (typeof repl === "string") {
        let r = "";
        for (let i = 0; i < repl.length; i++) {
          const c = repl[i]!;
          if (c !== L_ESC) { r += c; continue; }
          i++;
          const d = repl[i];
          if (d === undefined) throw new Error("invalid use of '%' in replacement string");
          if (d >= "0" && d <= "9") {
            const v = d === "0" ? whole : getCapture(ms, d.charCodeAt(0) - 49, src, e);
            r += typeof v === "number" ? String(v) : v;
          } else r += d; // Lua 5.1: '%x' is 'x'

        }
        rep = r;
      } else if (typeof repl === "function") rep = repl(...caps);
      else rep = (repl as Record<string, unknown>)[String(caps[0])];
      if (rep == null || rep === false) out += whole;
      else if (typeof rep === "string") out += rep;
      else if (typeof rep === "number") out += String(rep);
      else throw new Error("invalid replacement value (a " + typeof rep + ")");
    }
    if (e !== -1 && e > src) src = e;
    else if (src < s.length) out += s[src++];
    else break;
    if (anchor) break;
  }
  if (src < s.length) out += s.slice(src);
  return [out, n];
}

export const LPattern = { find, match, matchAll, gmatch, gsub };
export default LPattern;
