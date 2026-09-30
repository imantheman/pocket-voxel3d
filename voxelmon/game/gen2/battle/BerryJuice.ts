// ConvertBerriesToBerryJuice (engine/events/pokerus/pokerus.asm:124): a port
// of gen1recomp src/battle/gen2/BerryJuice.lua (bdfac727, MIT).
//
// The first thing GivePokerusAndConvertBerries does on a battle WIN: gated on
// ENGINE_REACHED_GOLDENROD like the Pokerus roll beside it, one byte under
// `1 out_of 16` (16/256), then a walk down the party for a SHUCKLE holding
// a BERRY.  Only the FIRST match converts -- the routine returns the moment
// it rewrites one item byte -- and nothing tells the player; the changed
// held item is the whole event.
//
// Shuckie (the Cianwood loaner) arrives holding a BERRY, which is the
// intended payoff.  The Pokerus half lives in core/Pokerus.ts; both are called
// from the same battle-exit arm in ui/BattleState.ts, conversion first, the
// way the asm orders them.

import { truthy } from "../platform/lua.ts";
import { random as luaRandom } from "../platform/rng.ts";

export interface BerryJuiceOpts {
  /** a function of no arguments returning 0..255 (the Pokerus convention) */
  random?: () => number;
  /** the ENGINE_REACHED_GOLDENROD engine flag */
  reachedGoldenrod?: boolean;
}

export const BerryJuice = {
  // constants/engine_flags.asm index 21, same gate Pokerus.give reads.
  ENGINE_REACHED_GOLDENROD: 21,

  // `cp 1 out_of 16` with out_of = `* $100 /`: a byte under 16 converts.
  ROLL_LIMIT: 16,

  // Lua: BerryJuice.lua:23
  random(): number {
    return luaRandom(0, 255);
  },

  // Lua: BerryJuice.lua:33 -- the walk itself.  Returns the party slot that
  // converted (the Lua's 1-based index), or nil.
  convert(party: any[] | undefined | null, opts?: BerryJuiceOpts): number | undefined {
    const o = opts ?? {};
    if (!truthy(o.reachedGoldenrod)) return undefined;
    const roll = (o.random ?? BerryJuice.random)();
    if (roll >= BerryJuice.ROLL_LIMIT) return undefined;
    const list = party ?? [];
    for (let i = 0; i < list.length; i++) {
      const mon = list[i];
      if (mon == null) break;
      if (mon.species === "SHUCKLE" && mon.item === "BERRY") {
        mon.item = "BERRY_JUICE";
        return i + 1;
      }
    }
    return undefined;
  },

  // Lua: BerryJuice.lua:49 -- the save-facing wrapper, mirroring
  // Pokerus.giveAfterBattle's shape so the battle exit calls the two the same way.
  convertAfterBattle(save: any, party?: any[] | null, opts?: BerryJuiceOpts): number | undefined {
    if (typeof save !== "object" || save === null) return undefined;
    const o = opts ?? {};
    const flags = save.engineFlags ?? {};
    return BerryJuice.convert(party ?? save.party ?? [], {
      random: o.random,
      reachedGoldenrod: flags[BerryJuice.ENGINE_REACHED_GOLDENROD] === true,
    });
  },
};

export default BerryJuice;
