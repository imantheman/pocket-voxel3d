// The CABLE CLUB desk: the receptionist on the right of every POKeMON
// CENTER (scripts/*Pokecenter.asm, the CableClubNPC text block).
//
// Matched on the text constant rather than the map, the way the nurse and
// the mart clerk are: every Center has one and they all say the same
// things, so one script covers thirteen maps and any the cook adds later.
//
// Her lines are the ROM's own -- the welcome, the apply-here-we-have-to-save
// ask, the please wait, the "reserved for 2 friends" when nobody is on the
// other end, and the come-again on the way out. What sits between them is
// this port's own wire (world/link.ts).

import type { ScriptRow } from "./script.ts";
import { EVENT_OT, eventPokemonOn } from "../eventmons.ts";

/** The save flag set once the event MEW is handed over. */
export const EVENT_MEW_FLAG = "PV_EVENT_MEW";

/**
 * EVENT POKéMON (../eventmons.ts): before her usual welcome, the desk hands
 * over the event MEW the 1999-2000 events sent by link -- level 5, OT GF --
 * once per save. A full party sends it to the PC (give_pokemon). Her lines
 * here are this port's; the carts' events had no desk to say them.
 */
function eventRows(save: any): ScriptRow[] {
  if (!eventPokemonOn(save?.options) || save?.flags?.[EVENT_MEW_FLAG]) return [];
  const player = save?.player?.name ?? "RED";
  return [
    ["face_player"],
    ["show_text", `Hello! You're\n${player}, right?`],
    ["show_text", "An event POKéMON\ncame over the link\nfor you!"],
    ["show_text", `${player} received\nMEW!`],
    ["give_pokemon", "MEW", 5, false, { otName: EVENT_OT }],
    ["set_flag", EVENT_MEW_FLAG],
  ] as ScriptRow[];
}

/** Her object is <MAP>_LINK_RECEPTIONIST on every Center. */
export function isLinkReceptionist(textConst: string): boolean {
  return /_LINK_RECEPTIONIST$/.test(textConst);
}

/**
 * The desk, end to end.
 *
 * The save is not decoration: the ROM saves before opening the link so a
 * trade cannot be undone by resetting, and a trade that cannot be undone is
 * the whole reason the other player agrees to it.
 */
export function cableClubScript(textConst: string, save?: any): ScriptRow[] | null {
  if (!isLinkReceptionist(textConst)) return null;
  return [
    ...eventRows(save),
    ["face_player"],
    ["show_text", "_CableClubNPCWelcomeText"],
    ["ask", "_CableClubNPCPleaseApplyHereHaveToSaveText"],
    ["jump_if_false", "bye"],
    ["save_game"],
    // Opens the session and waits for somebody, with her "Please wait." up
    // for the duration (the verb shows it). lastCheck = a peer arrived.
    ["link_open"],
    ["jump_if_false", "alone"],
    // TRADE CENTER / COLOSSEUM / CANCEL, and the peer has to want the same.
    ["link_room"],
    ["jump_if_false", "bye"],
    ["link_enter"],
    ["jump", "end"],
    ["label", "alone"],
    ["show_text", "_CableClubNPCAreaReservedFor2FriendsLinkedByCableText"],
    ["jump", "end"],
    ["label", "bye"],
    ["show_text", "_CableClubNPCPleaseComeAgainText"],
  ] as ScriptRow[];
}
