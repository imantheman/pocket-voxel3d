// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). Late-bound aliases for the import cycle.
//
// Brian's modules build aliases and small tables from other modules when they
// load (`local Bag = require(...)`, `local COLOR = { fg = Font.STDPAL[1] }`).
// Inside the gen3 import cycle an imported binding may not be initialised
// yet at that point, so a port must not read it at load
// (docs/firered-runtime-brief.md). `late(() => X)` is an object that stands
// for X and reads it on first use; `lateOnce(build)` builds a table on first
// use and keeps it. Call sites stay as Brian wrote them.

/* eslint-disable @typescript-eslint/no-explicit-any */

function proxyOf<T extends object>(resolve: () => T): T {
  return new Proxy({} as T, {
    get: (_t, k) => (resolve() as any)[k],
    set: (_t, k, v) => { (resolve() as any)[k] = v; return true; },
    has: (_t, k) => k in (resolve() as any),
    ownKeys: () => Reflect.ownKeys(resolve() as any),
    getOwnPropertyDescriptor: (_t, k) => {
      const d = Reflect.getOwnPropertyDescriptor(resolve() as any, k);
      if (d) d.configurable = true;
      return d;
    },
  });
}

/** An alias read on every use (the target may be replaced, as a module table can be). */
export function late<T extends object>(get: () => T): T {
  return proxyOf(get);
}

/** A table built on first use and kept. */
export function lateOnce<T extends object>(build: () => T): T {
  let v: T | undefined;
  return proxyOf(() => (v ??= build()));
}

export default late;
