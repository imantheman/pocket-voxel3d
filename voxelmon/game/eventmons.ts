// EVENT POKéMON: every game's option row for the distributions the carts
// only ever got from an event -- a Nintendo-run link session, never an
// in-game encounter. Turned on, each game's own delivery hands them over,
// once per save:
//
//   Red / Blue / Yellow  MEW at level 5, from the CABLE CLUB receptionist
//                        (world/cableclub.ts) -- the 1999-2000 Mew events
//                        were link trades from an event cart.
//   Gold / Silver        CELEBI at level 30, from the Pokecenter 2F delivery
//                        man who brings Mystery Gift items
//                        (gen2/core/EventPokemon.ts). Level 30 is the GS BALL
//                        Celebi's.
//
// OFF unless set: a save that never opened the row stays the cart.

export const EVENT_POKEMON = [
  { key: false, label: "OFF" },
  { key: true, label: "ON" },
] as const;

export function eventPokemonOn(options: { eventPokemon?: boolean } | null | undefined): boolean {
  return options?.eventPokemon === true;
}

/** The OT an event mon carries (GAME FREAK's, as on the distribution carts). */
export const EVENT_OT = "GF";
