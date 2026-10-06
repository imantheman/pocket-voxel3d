// Port tooling: where the heap grew between two of Bun's heap snapshots
// (JSC's Inspector format; node ids are not kept from one snapshot to the
// next, so objects are compared by where they hang). In each snapshot every
// object is charged to the first few names on its shortest path from the
// roots that goes along named references where it can (variables,
// properties); the report lists the names whose objects grew the most.
// Used by tools/gen3/tex_leak.ts --snap. Never shipped.

interface Snap { nodes: number[]; nodeClassNames: string[]; edges: number[]; edgeTypes: string[]; edgeNames: string[] }

function byPath(s: Snap, depth: number): Map<string, number> {
  const NF = 4, EF = 4;
  const size = new Map<number, number>();
  for (let i = 0; i < s.nodes.length; i += NF) size.set(s.nodes[i]!, s.nodes[i + 1]!);
  const internal = s.edgeTypes.indexOf("Internal"), index = s.edgeTypes.indexOf("Index");
  const out = new Map<number, number[]>();
  for (let i = 0; i < s.edges.length; i += EF) {
    const f = s.edges[i]!;
    let l = out.get(f);
    if (!l) { l = []; out.set(f, l); }
    l.push(i);
  }
  // 0-1 BFS: a named reference costs nothing, an internal one 1, so a named
  // path wins over a shorter internal one
  const key = new Map<number, string>(), dist = new Map<number, number>();
  const dq: number[] = [0];
  let head = 0;
  const front: number[] = [];
  key.set(0, ""); dist.set(0, 0);
  while (front.length || head < dq.length) {
    const n = front.length ? front.pop()! : dq[head++]!;
    const dn = dist.get(n)!, kn = key.get(n)!;
    for (const ei of out.get(n) ?? []) {
      const t = s.edges[ei + 1]!;
      const ty = s.edges[ei + 2]!;
      const w = ty === internal ? 1 : 0;
      if (dist.has(t) && dist.get(t)! <= dn + w) continue;
      dist.set(t, dn + w);
      const parts = kn ? kn.split(".") : [];
      if (parts.length < depth && ty !== internal) parts.push(ty === index ? "[]" : (s.edgeNames[s.edges[ei + 3]!] ?? "?"));
      key.set(t, parts.join("."));
      if (w === 0) front.push(t); else dq.push(t);
    }
  }
  const agg = new Map<string, number>();
  for (const [id, sz] of size) {
    const k = key.get(id) ?? "(unreached)";
    agg.set(k, (agg.get(k) ?? 0) + sz);
  }
  return agg;
}

export function heapDiff(a: Snap, b: Snap, top = 25, depth = 3): string[] {
  const pa = byPath(a, depth), pb = byPath(b, depth);
  const keys = new Set([...pa.keys(), ...pb.keys()]);
  const d: [string, number, number][] = [];
  let ta = 0, tb = 0;
  for (const k of keys) {
    const x = pa.get(k) ?? 0, y = pb.get(k) ?? 0;
    ta += x; tb += y;
    d.push([k, y - x, y]);
  }
  d.sort((p, q) => q[1] - p[1]);
  const lines = [`[heap] ${(ta / 1048576).toFixed(1)} MB -> ${(tb / 1048576).toFixed(1)} MB; grew most under:`];
  for (const [k, g, y] of d.slice(0, top)) lines.push(`[heap]   ${(g / 1024).toFixed(0).padStart(7)} KB (now ${(y / 1024).toFixed(0)} KB)  ${k || "(root)"}`);
  return lines;
}
