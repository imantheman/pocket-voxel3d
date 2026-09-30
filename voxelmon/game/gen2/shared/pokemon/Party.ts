// gen1recomp src/pokemon/Party.lua at bdfac727 (MIT): party helpers (max 6,
// like the original). `firstHealthy` returns [mon, i] with the Lua's 1-based
// i, or undefined.

export const Party = {
  // Lua: Party.lua:5
  MAX: 6,

  // Lua: Party.lua:7-13
  add(party: any[], mon: unknown): boolean {
    if (party.length >= Party.MAX) {
      return false; // box system comes later
    }
    party.push(mon);
    return true;
  },

  // Lua: Party.lua:15-20
  firstHealthy(party: any[]): [any, number] | undefined {
    for (let i = 0; i < party.length; i++) {
      const mon = party[i];
      if (mon == null) break; // ipairs stops at the first hole
      if (mon.hp > 0) return [mon, i + 1];
    }
    return undefined;
  },
};

export default Party;
