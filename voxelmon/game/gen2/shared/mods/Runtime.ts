// gen1recomp src/mods/Runtime.lua (bdfac727): the mod event/hook buses.
// No mods load on the 3DS, so these are the Lua's null objects for good:
// `emit` goes nowhere, `call` runs the vanilla function, nothing is wanted.

export const Runtime = {
  errors: null as string[] | null,
  currentMod: null as string | null,
  safeMode: false,

  install(): void {},
  reset(): void {},
  reportError(_modId: unknown, _message: unknown): void {},
  emit(_name: string, _payload?: unknown): void {},
  /** Runtime.lua:67 -- `vanilla(...args)` with no hook in the chain. */
  call<R>(_name: string, vanilla: (...args: any[]) => R, ...args: any[]): R {
    return vanilla(...args);
  },
  wants(_name: string): boolean {
    return false;
  },
  wantsHook(_name: string): boolean {
    return false;
  },
};

export default Runtime;
