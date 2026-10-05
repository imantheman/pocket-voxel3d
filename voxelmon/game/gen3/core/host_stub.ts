// Port of gen1recomp src/core/game3/host_stub.lua (GPLv3 + additional terms; see LICENSE.md).
// Minimal stand-in for mods.Kanto-Reforged.core.host (standalone Game3).

export const Host = {
  // Lua: host_stub.lua:5
  isGen1(): boolean { return false; },
  // Lua: host_stub.lua:9
  isGen2(): boolean { return false; },
  // Lua: host_stub.lua:13
  isGen3(): boolean { return true; },
  // Lua: host_stub.lua:17
  game(): undefined { return undefined; },
};

export default Host;
