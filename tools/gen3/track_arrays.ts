// Port tooling: every typed array the guest makes, with where it was made,
// while it lives (QuickJS's memory count gives their bytes no kind of its
// own). Imported FIRST by tools/gen3/qjs_leak.ts when QJS_TRACK_ARRAYS is
// set: the global typed array constructors become subclasses that record a
// WeakRef and the first callers' names, and `instanceof` still answers for
// arrays made natively. Never shipped.
/* eslint-disable @typescript-eslint/no-explicit-any */
declare const QJS_TRACK_ARRAYS: number;

export const trackedArrays: { r: WeakRef<ArrayBufferView>; site: string; n: number }[] = [];
export let arrayTracking = false;

function site(): string {
  const st = (new Error().stack ?? "").split("\n").map((l) => l.trim().replace(/^at /, "").replace(/ \(.*$/, ""));
  return st.filter((f) => f && !/^(Error|Tracked|<anonymous>|\[native code\]|site)$/.test(f)).slice(0, 3).join(" < ");
}

if (typeof QJS_TRACK_ARRAYS === "number" && QJS_TRACK_ARRAYS) {
  arrayTracking = true;
  const g = globalThis as any;
  for (const name of ["Uint8Array", "Float32Array", "Int32Array", "Uint16Array", "Int16Array", "Uint32Array", "Float64Array", "Uint8ClampedArray", "Int8Array"]) {
    const Base = g[name];
    const Tracked = class extends Base {
      constructor(...a: any[]) {
        super(...a);
        // a view on another's buffer adds no memory
        const owns = !(a[0] instanceof ArrayBuffer);
        if (owns && (this as any).byteLength >= 1024) trackedArrays.push({ r: new WeakRef(this as any), site: name + " " + site(), n: (this as any).byteLength });
      }
      static [Symbol.hasInstance](x: any): boolean { return x instanceof Base; }
    };
    g[name] = Tracked;
  }
}

/** Live tracked arrays' bytes, by where made. */
export function liveArrays(): [number, Map<string, [number, number]>] {
  let total = 0, j = 0;
  const by = new Map<string, [number, number]>();
  for (let i = 0; i < trackedArrays.length; i++) {
    const t = trackedArrays[i]!;
    if (!t.r.deref()) continue;
    trackedArrays[j++] = t;
    total += t.n;
    const e = by.get(t.site) ?? [0, 0];
    e[0]++; e[1] += t.n;
    by.set(t.site, e);
  }
  trackedArrays.length = j;
  return [total, by];
}
