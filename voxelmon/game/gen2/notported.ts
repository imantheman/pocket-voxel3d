// What a not-yet-ported Gen 2 module does when it is reached: say which
// Lua function it stands for and stop (tools/gen2_stubs.py writes the stubs;
// docs/gold-engine.md tracks the port).

export class NotPortedError extends Error {
  constructor(readonly what: string) {
    super(`gen2: ${what} is not ported yet`);
  }
}

export function notPorted(what: string): never {
  throw new NotPortedError(what);
}
