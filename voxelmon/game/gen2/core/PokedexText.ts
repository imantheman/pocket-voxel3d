// gen1recomp src/core/gen2/PokedexText.lua at bdfac727 (MIT): projects a mod's
// `pokemon` registry dexEntry onto the #DEX screen's own table
// (data.gen2Pokedex.entries[species]: kind, text, text2), once after the
// merge (Game2). height/weight/dex stay untouched.

import { sortedKeys, truthy } from "../platform/lua.ts";

export const PokedexText = {
  /** Lua: PokedexText.lua:21 -- how many entries took an override. */
  apply(data: any): number {
    const dex = data && data.gen2Pokedex;
    const pokemon = data && data.pokemon;
    if (!(dex && dex.entries && pokemon)) return 0;
    let count = 0;
    for (const species of sortedKeys(dex.entries)) {
      const entry = dex.entries[species];
      const def = pokemon[species];
      const override = def && def.dexEntry;
      if (truthy(override) && (truthy(override.kind) || truthy(override.text) || truthy(override.text2))) {
        if (truthy(override.kind)) entry.kind = override.kind;
        if (truthy(override.text)) entry.text = override.text;
        if (truthy(override.text2)) entry.text2 = override.text2;
        count = count + 1;
      }
    }
    return count;
  },
};

export default PokedexText;
