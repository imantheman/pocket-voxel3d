// Port of gen1recomp src/core/SessionLifecycle.lua (GPLv3 + additional terms; see LICENSE.md).
// Central session lifecycle orchestrator: subsystems register teardown
// hooks at module load; the host only calls phase entry points.
//
// Ported: the surface the FireRed runtime uses (registerProcessShutdown,
// from core/audio and core/asset_stream) and endProcess, which runs those
// hooks. Left out (Gen 1/2, launcher and save-editor only; none is called
// from gen3): endMountedSession (CacheFs unmount, Data:unloadGenerated,
// package.loaded eviction of the game3 modules), endEditorSession and
// endGameSession (Gen 1 Music/Sound/ChipAudio, Gen 2 Clock, SecondScreen).

import { ipairs } from "../../platform/lt.ts";

// Lua: SessionLifecycle.lua:14
const processShutdowns: ((() => void) | null)[] = [null];

export const SessionLifecycle = {
  // Lua: SessionLifecycle.lua:16
  registerProcessShutdown(fn: () => void): void {
    processShutdowns[processShutdowns.length] = fn;
  },

  // Lua: SessionLifecycle.lua:133
  endProcess(): void {
    for (const [, fn] of ipairs<() => void>(processShutdowns)) {
      try { fn(); } catch { /* pcall */ }
    }
    // NOT FAITHFUL: Gen 1's ChipAudio worker shutdown dropped (no ChipAudio in the FireRed runtime).
  },
};

export default SessionLifecycle;
