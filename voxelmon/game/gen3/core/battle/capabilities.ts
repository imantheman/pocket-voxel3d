// Port of gen1recomp src/core/game3/battle/capabilities.lua (GPLv3 + additional terms; see LICENSE.md).
// Game3 battle capabilities (FRLG-shaped; no Gen4+ defaults).

export interface BattleCapabilities {
  gen3Crit: boolean;
  gen3PartialTrap: boolean;
  weatherChipDenom: number;
  partialTrapChipDenom: number;
  partialTrapMinTurns: number;
  partialTrapMaxTurns: number;
  screenDefaultTurns: number;
  safeguardDefaultTurns: number;
  weatherDefaultTurns: number;
  critMultiplier: number;
  get(): BattleCapabilities;
}

export const Capabilities: BattleCapabilities = {
  gen3Crit: true,
  gen3PartialTrap: true,
  weatherChipDenom: 16,
  partialTrapChipDenom: 16,
  partialTrapMinTurns: 3,
  partialTrapMaxTurns: 6,
  screenDefaultTurns: 5,
  safeguardDefaultTurns: 5,
  weatherDefaultTurns: 5,
  critMultiplier: 2,

  // Lua: capabilities.lua:16
  get(): BattleCapabilities {
    return Capabilities;
  },
};

export default Capabilities;
