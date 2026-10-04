// Deterministic Lua-source save writer. Mirrors gen1recomp's
// src/core/SaveSerializer.lua so a save written here is byte-identical to
// one the desktop recomp writes: %q strings, key-sorted tables, two-space
// indent, trailing comma, "return <table>\n".

/** Lua's string.format("%q", s). */
function quote(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\\n";
    else if (ch === "\r") out += "\\r";
    else if (c < 32 || c === 127) out += "\\" + String(c);
    else out += ch;
  }
  return out + '"';
}

const BARE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Lua sorts by type name first ("number" < "string"), then by value. */
function sortKeys(keys: (string | number)[]): (string | number)[] {
  return keys.slice().sort((a, b) => {
    const ta = typeof a === "number" ? "number" : "string";
    const tb = typeof b === "number" ? "number" : "string";
    if (ta !== tb) return ta < tb ? -1 : 1;
    if (ta === "number") return (a as number) - (b as number);
    return (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0;
  });
}

function serialize(v: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "string") return quote(v);
  if (v === null || v === undefined) return "nil";

  // Arrays become 1-based integer-keyed Lua tables. A null or undefined
  // value is a key Lua does not have, so it is left out: gen1recomp's
  // reader refuses a bare `nil` value (and so the whole save) -- a
  // freshly made mon's `status: null` used to put one in every party.
  let entries: [string | number, unknown][];
  if (Array.isArray(v)) {
    entries = v
      .map((x, i) => [i + 1, x] as [number, unknown])
      .filter(([, x]) => x !== undefined && x !== null);
  } else if (typeof v === "object") {
    entries = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined && x !== null)
      .map(([k, x]) => [/^\d+$/.test(k) ? Number(k) : k, x]);
  } else {
    throw new Error("cannot serialize " + typeof v);
  }

  if (entries.length === 0) return "{}";
  const byKey = new Map(entries);
  const parts: string[] = [];
  for (const k of sortKeys(entries.map((e) => e[0]))) {
    const key = typeof k === "string" && BARE.test(k) ? k : "[" + serialize(k) + "]";
    parts.push(pad + "  " + key + " = " + serialize(byKey.get(k), indent + 1));
  }
  return "{\n" + parts.join(",\n") + ",\n" + pad + "}";
}

export function encodeSave(data: unknown): string {
  return "return " + serialize(data) + "\n";
}
