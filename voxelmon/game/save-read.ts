// Reader for the save writer's grammar: `return <value>`, where a value is a
// number, boolean, %q string, or a keyed table. Deliberately restricted —
// anything outside that shape fails instead of being interpreted.

type Val = number | boolean | string | Record<string, unknown>;

class P {
  pos = 0;
  constructor(readonly src: string) {}
  skip(): void {
    while (this.pos < this.src.length && " \t\r\n".includes(this.src[this.pos]!)) this.pos++;
  }
  eat(ch: string): boolean {
    this.skip();
    if (this.src[this.pos] === ch) { this.pos++; return true; }
    return false;
  }
  expect(ch: string): void {
    if (!this.eat(ch)) throw new Error(`expected ${ch} at ${this.pos}`);
  }
}

function parseString(p: P): string {
  p.expect('"');
  let out = "";
  while (p.pos < p.src.length) {
    const c = p.src[p.pos++]!;
    if (c === '"') return out;
    if (c !== "\\") { out += c; continue; }
    const e = p.src[p.pos++]!;
    if (e === "n") out += "\n";
    else if (e === "r") out += "\r";
    else if (e === "t") out += "\t";
    else if (e === "\n") out += "\n";
    else if (e >= "0" && e <= "9") {
      let digits = e;
      while (digits.length < 3 && /[0-9]/.test(p.src[p.pos] ?? "")) digits += p.src[p.pos++];
      out += String.fromCharCode(Number(digits));
    } else out += e;
  }
  throw new Error("unterminated string");
}

function parseValue(p: P, depth = 0): Val {
  if (depth > 128) throw new Error("too deep");
  p.skip();
  const c = p.src[p.pos];
  if (c === '"') return parseString(p);
  if (c === "{") return parseTable(p, depth);
  const m = /^(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?|true|false|nil)/i.exec(p.src.slice(p.pos));
  if (!m) throw new Error(`bad value at ${p.pos}`);
  p.pos += m[0].length;
  if (m[0] === "true") return true;
  if (m[0] === "false") return false;
  if (m[0] === "nil") return undefined as unknown as Val;
  return Number(m[0]);
}

function parseTable(p: P, depth: number): Record<string, unknown> {
  p.expect("{");
  const out: Record<string, unknown> = {};
  const arr: unknown[] = [];
  let isArray = true;
  for (;;) {
    p.skip();
    if (p.eat("}")) break;
    let key: string | number;
    if (p.eat("[")) {
      const k = parseValue(p, depth + 1);
      p.expect("]");
      key = k as string | number;
    } else {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(p.src.slice(p.pos));
      if (!m) throw new Error(`bad key at ${p.pos}`);
      p.pos += m[0].length;
      key = m[0];
    }
    p.expect("=");
    const v = parseValue(p, depth + 1);
    if (typeof key === "number") arr[key - 1] = v;
    else { isArray = false; out[key] = v; }
    p.eat(",");
  }
  // integer-keyed tables come back as arrays (the party, move lists)
  if (isArray && arr.length > 0) return arr as unknown as Record<string, unknown>;
  return out;
}

/**
 * The fields the game keeps as ARRAYS, `*` standing for every entry of the
 * container at that point.
 *
 * An empty Lua table is written `{}` -- the same text an empty record is
 * written as -- so the type cannot be recovered from the save. A party
 * saved before the starter was handed over, a bag order saved while the
 * bag was empty, an untouched storage box: each comes back as an object,
 * and the first `push` or `.length` on it throws or silently misreads.
 *
 * On the console a thrown guest frame is answered by the host dropping
 * into its map viewer, which is how one of these turned up: "hitting
 * DEPOSIT opens the map viewer".
 */
const ARRAY_FIELDS: string[][] = [
  ["party"],
  ["party", "*", "moves"],
  ["bagOrder"],
  ["pc", "bagOrder"],
  ["pcItems", "bagOrder"],
  ["pcOrder"],
  ["orphaned", "mons"],
  ["orphaned", "items"],
  ["box"],
  ["boxes"],
  ["boxes", "*"],
  ["boxes", "*", "*", "moves"],
];

/** Every value `path` names, walking `*` across a container's entries. */
function atPath(root: unknown, path: string[]): { owner: Record<string, unknown>; key: string }[] {
  let level: { owner: Record<string, unknown>; key: string }[] = [];
  let containers: unknown[] = [root];
  for (let i = 0; i < path.length; i++) {
    const key = path[i]!;
    const next: unknown[] = [];
    level = [];
    for (const c of containers) {
      if (!c || typeof c !== "object") continue;
      const obj = c as Record<string, unknown>;
      if (key === "*") {
        for (const k of Object.keys(obj)) {
          level.push({ owner: obj, key: k });
          next.push(obj[k]);
        }
      } else {
        level.push({ owner: obj, key });
        next.push(obj[key]);
      }
    }
    containers = next;
  }
  return level;
}

function fixArrays(save: Record<string, unknown>): void {
  for (const path of ARRAY_FIELDS) {
    for (const { owner, key } of atPath(save, path)) {
      const v = owner[key];
      // Only an EMPTY table is ambiguous: a populated one already came
      // back as an array, and reshaping anything else would be guessing.
      if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) {
        owner[key] = [];
      }
    }
  }
}

export function decodeSave(text: string): Record<string, unknown> {
  const p = new P(text);
  p.skip();
  if (!p.src.startsWith("return", p.pos)) throw new Error("not a save file");
  p.pos += 6;
  const save = parseValue(p) as Record<string, unknown>;
  if (save && typeof save === "object") fixArrays(save);
  return save;
}
