// Port of gen1recomp src/mods/Runtime.lua (GPLv3 + additional terms; see LICENSE.md).
// Process-wide access to the mod event/hook buses. Until a loader installs
// live buses (never, on the 3DS: no mods load) the null objects make every
// emit/call site a pass-through: call(name, vanilla, ...) runs vanilla,
// emit does nothing, wants/wantsHook answer false.

export interface ModEvents {
  listeners?: Record<string, unknown>;
  emit(name: string, payload?: unknown): void;
  removeOwner(owner?: unknown): void;
}
export interface ModHooks {
  chains?: Record<string, unknown>;
  call(name: string, vanilla: (...a: any[]) => any, ...args: any[]): any;
  removeOwner(owner?: unknown): void;
}

// Lua: Runtime.lua:9
const NullEvents: ModEvents = {
  emit() {},
  removeOwner() {},
};

// Lua: Runtime.lua:13
const NullHooks: ModHooks = {
  call(_name, vanilla, ...args) { return vanilla(...args); },
  removeOwner() {},
};

export const Runtime = {
  events: NullEvents as ModEvents,
  hooks: NullHooks as ModHooks,
  errors: undefined as (string | null)[] | undefined,
  currentMod: undefined as string | undefined,
  modRequire: undefined as string | undefined,
  safeMode: false,

  // Lua: Runtime.lua:38
  install(events: ModEvents, hooks: ModHooks, errors?: (string | null)[]): void {
    Runtime.events = events;
    Runtime.hooks = hooks;
    Runtime.errors = errors;
  },

  // Lua: Runtime.lua:43
  reset(): void {
    Runtime.events = NullEvents;
    Runtime.hooks = NullHooks;
    Runtime.errors = undefined;
    Runtime.currentMod = undefined;
    Runtime.modRequire = undefined;
  },

  // Lua: Runtime.lua:54
  reportError(modId: unknown, message: unknown): void {
    const errors = Runtime.errors;
    if (!errors || !modId || modId === "base") return;
    let n = errors.length - 1;
    while (n > 0 && errors[n] == null) n--;
    errors[n + 1] = String(modId) + ": " + String(message);
  },

  // Lua: Runtime.lua:60
  emit(name: string, payload?: unknown): void {
    Runtime.events.emit(name, payload);
  },

  // Lua: Runtime.lua:64
  call(name: string, vanilla: (...a: any[]) => any, ...args: any[]): any {
    return Runtime.hooks.call(name, vanilla, ...args);
  },

  // Lua: Runtime.lua:70
  wants(name: string): boolean {
    const listeners = Runtime.events.listeners;
    return listeners != null && listeners[name] != null;
  },

  // Lua: Runtime.lua:75
  wantsHook(name: string): boolean {
    const chains = Runtime.hooks.chains;
    return chains != null && chains[name] != null;
  },
};

export default Runtime;
