// Port tooling: the guest's heap by where it hangs, measured from JS (so it
// runs under the desktop QuickJS as under Bun). Every object reachable from
// the given roots (the gen3 modules' namespaces) is charged, once, to the
// first few property names on the first path the walk finds to it, with an
// estimate of its size (strings by length, typed arrays by bytes, objects
// and arrays by their slots). What only a closure holds is not seen.
// Never shipped.

/* eslint-disable @typescript-eslint/no-explicit-any */
export function sizeByPath(roots: Record<string, any>, depth = 3): Map<string, number> {
  const seen = new Set<any>();
  const agg = new Map<string, number>();
  const add = (k: string, n: number): void => { agg.set(k, (agg.get(k) ?? 0) + n); };
  // breadth first, so a thing is charged to its shortest path
  let q: [any, string, number][] = [];
  // a module namespace (as a bundle makes one) gives its exports by getters: read them
  for (const k of Object.keys(roots)) {
    const ns = roots[k];
    if (ns == null || typeof ns !== "object") continue;
    for (const e of Object.keys(ns)) {
      let v: any;
      try { v = ns[e]; } catch { continue; }
      q.push([v, k + ":" + e, 1]);
    }
  }
  while (q.length) {
    const next: [any, string, number][] = [];
    for (const [v, path, d] of q) {
      if (v == null) continue;
      const t = typeof v;
      if (t === "string") { if (v.length > 64 && !seen.has(v)) { seen.add(v); add(path, v.length + 16); } continue; }
      if (t !== "object" && t !== "function") continue;
      if (seen.has(v)) continue;
      seen.add(v);
      if (ArrayBuffer.isView(v)) { add(path, (v as ArrayBufferView).byteLength + 64); continue; }
      if (v instanceof ArrayBuffer) { add(path, v.byteLength + 64); continue; }
      const sub = (name: string): string => (d < depth ? path + "." + name : path);
      if (v instanceof Map) {
        add(path, 32 + v.size * 24);
        for (const [mk, mv] of v) { next.push([mv, sub("<map>"), d + 1]); if (typeof mk === "object") next.push([mk, sub("<mapkey>"), d + 1]); }
        continue;
      }
      if (v instanceof Set) {
        add(path, 32 + v.size * 16);
        for (const sv of v) next.push([sv, sub("<set>"), d + 1]);
        continue;
      }
      let keys: string[];
      try { keys = Object.keys(v); } catch { continue; }
      add(path, 24 + keys.length * 12);
      const isArr = Array.isArray(v);
      for (const k of keys) {
        let cv: any;
        try {
          const desc = Object.getOwnPropertyDescriptor(v, k);
          if (!desc || !("value" in desc)) continue; // a getter is not run
          cv = desc.value;
        } catch { continue; }
        if (cv == null || (typeof cv !== "object" && typeof cv !== "function" && typeof cv !== "string")) continue;
        next.push([cv, sub(isArr ? "[]" : k), d + 1]);
      }
      // a class's prototype chain is code, not data: not followed
    }
    q = next;
  }
  return agg;
}

/** The paths whose size grew most from `a` to `b`. */
export function sizeDiff(a: Map<string, number>, b: Map<string, number>, top = 30): string[] {
  const keys = new Set([...a.keys(), ...b.keys()]);
  const d: [string, number, number][] = [];
  let ta = 0, tb = 0;
  for (const k of keys) {
    const x = a.get(k) ?? 0, y = b.get(k) ?? 0;
    ta += x; tb += y;
    d.push([k, y - x, y]);
  }
  d.sort((p, q) => q[1] - p[1]);
  const out = [`[size] reachable from the modules: ${(ta / 1048576).toFixed(1)} MB -> ${(tb / 1048576).toFixed(1)} MB; grew most under:`];
  for (const [k, g, y] of d.slice(0, top)) out.push(`[size]   ${(g / 1024).toFixed(0).padStart(7)} KB (now ${(y / 1024).toFixed(0)} KB)  ${k}`);
  return out;
}
