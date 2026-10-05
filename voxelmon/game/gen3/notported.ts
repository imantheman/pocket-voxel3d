// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). What a not-yet-ported module does when it is reached: say
// which Lua function it stands for and stop (tools/gen3/stubs.py writes the
// stubs; docs/firered-engine.md tracks the port).

export class NotPortedError extends Error {
  constructor(readonly what: string) {
    super(`gen3: ${what} is not ported yet`);
  }
}

export function notPorted(what: string): never {
  throw new NotPortedError(what);
}
