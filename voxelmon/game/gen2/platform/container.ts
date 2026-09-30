// Gold's gamedata file: one text file holding many JSON documents, so the
// engine can parse each table the first time it is asked for rather than
// all of them at boot (platform/data.ts).
//
//   PVG2 1\n
//   {"walker":[0,1234],"pokemon":[1234,5678],...}\n     <- name: [start, length]
//   <the documents, back to back>
//
// Offsets count JavaScript string units of the text after the index line,
// which is what the host hands the guest (the file decoded as UTF-8), so
// the reader slices without decoding bytes. Bundle-safe: no Node imports.

export const GEN2_CONTAINER_MAGIC = "PVG2 1";

export function writeGen2Container(sections: Record<string, string>): string {
  const index: Record<string, [number, number]> = {};
  let at = 0;
  const names = Object.keys(sections);
  for (const name of names) {
    const len = sections[name]!.length;
    index[name] = [at, len];
    at += len;
  }
  return `${GEN2_CONTAINER_MAGIC}\n${JSON.stringify(index)}\n${names.map((n) => sections[n]).join("")}`;
}

export function isGen2Container(text: string): boolean {
  return text.startsWith(`${GEN2_CONTAINER_MAGIC}\n`);
}

/**
 * The documents of a container as lazy strings: each property slices its
 * document out of `text` the first time it is read.
 */
export function readGen2Container(text: string): Record<string, string> {
  if (!isGen2Container(text)) throw new Error("gen2: gamedata is not a PVG2 container");
  const i1 = text.indexOf("\n");
  const i2 = text.indexOf("\n", i1 + 1);
  const index = JSON.parse(text.slice(i1 + 1, i2)) as Record<string, [number, number]>;
  const base = i2 + 1;
  const out: Record<string, string> = {};
  for (const [name, [start, len]] of Object.entries(index)) {
    let cached: string | undefined;
    Object.defineProperty(out, name, {
      enumerable: true,
      get: () => (cached ??= text.slice(base + start, base + start + len)),
    });
  }
  return out;
}
