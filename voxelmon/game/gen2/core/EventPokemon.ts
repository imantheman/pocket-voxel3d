// Gold and Silver's event distributions, behind the EVENT POKéMON option
// (voxelmon/game/eventmons.ts).
//
// The delivery is the Pokecenter 2F's Mystery Gift delivery man: his scene
// script brings him out when CheckMysteryGift answers nonzero, and his talk
// script runs GetMysteryGiftItem -- so a waiting event mon is one more thing
// those two specials answer for (script/Specials.ts). A Mystery Gift item
// still goes first; he comes back for the mon on the next visit.
//
// Not the cart's: the carts got these from event sessions. What is given is
// a record of species and level; nothing here is ROM-derived.

import { eventPokemonOn } from "../../eventmons.ts";

export interface EventMon {
  /** The save's key under `eventPokemon`, set once it is handed over. */
  id: string;
  species: string;
  level: number;
}

export const GS_EVENTS: readonly EventMon[] = [{ id: "celebi", species: "CELEBI", level: 30 }];

export const EventPokemon = {
  /** The next event mon waiting for this save, or null (option off / all given). */
  next(save: any, options: any): EventMon | null {
    if (!save || !eventPokemonOn(options)) return null;
    const got = save.eventPokemon ?? {};
    return GS_EVENTS.find((e) => got[e.id] !== true) ?? null;
  },

  mark(save: any, id: string): void {
    save.eventPokemon = save.eventPokemon ?? {};
    save.eventPokemon[id] = true;
  },
};
