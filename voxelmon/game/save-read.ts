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

export function decodeSave(text: string): Record<string, unknown> {
  const p = new P(text);
  p.skip();
  if (!p.src.startsWith("return", p.pos)) throw new Error("not a save file");
  p.pos += 6;
  return parseValue(p) as Record<string, unknown>;
}
