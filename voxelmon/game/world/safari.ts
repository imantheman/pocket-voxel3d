// The SAFARI ZONE game. Ports gen1recomp data/scripts/safari.lua (the gate,
// scripts/SafariZoneGate.asm) and the step/ball bookkeeping its
// OverworldController carries (engine/events/hidden_events/safari_game.asm).
// The in-battle BALL/BAIT/ROCK/RUN game is battle/safari.ts.
//
// The whole game is one save field: `save.safari = { balls, steps }`, non-null
// only while a game is running. Every gate is that field's presence.

import type { ScriptRow } from "./script.ts";

/** SafariZoneGateWouldYouLikeToJoinScript's three numbers. */
export const SAFARI_FEE = 500;
export const SAFARI_BALLS = 30;
/**
 * wSafariSteps is written as 502, not 500. The two extra are spent by the
 * scripted walk INTO the zone: EVENT_IN_SAFARI_ZONE is already set when it
 * runs, so home/overworld.asm charges those steps — which is why the counter
 * reads 500 on arrival. This port only counts steps on the nine interior maps
 * (SAFARI_STEP_MAPS), so the walk-in charges them explicitly.
 */
export const SAFARI_STEPS = 502;
export const SAFARI_WALK_IN_STEPS = 2;

/** The maps the step counter runs on (FieldDefaults SAFARI.stepMaps). */
export const SAFARI_STEP_MAPS = new Set([
  "SAFARI_ZONE_CENTER",
  "SAFARI_ZONE_EAST",
  "SAFARI_ZONE_NORTH",
  "SAFARI_ZONE_WEST",
  "SAFARI_ZONE_CENTER_REST_HOUSE",
  "SAFARI_ZONE_EAST_REST_HOUSE",
  "SAFARI_ZONE_NORTH_REST_HOUSE",
  "SAFARI_ZONE_WEST_REST_HOUSE",
  "SAFARI_ZONE_SECRET_HOUSE",
]);

/** Where a finished game drops the player (FieldDefaults SAFARI.exitWarp). */
export const SAFARI_EXIT = { map: "SAFARI_ZONE_GATE", x: 4, y: 3, facing: "down" } as const;

/** The gate cells in front of the worker that fire the join prompt. */
export const SAFARI_JOIN_CELLS: readonly [number, number][] = [[3, 2], [4, 2]];

/**
 * Where "no, I'll keep hunting" puts the player back: SAFARI_ZONE_CENTER's
 * two gate-side warps, picked by which of the gate's north warps they came
 * through (its left column is 3).
 */
export const SAFARI_RETURN_LEFT: readonly [number, number] = [14, 25];
export const SAFARI_RETURN_RIGHT: readonly [number, number] = [15, 25];

export interface SafariState {
  balls: number;
  steps: number;
}

/** True on the maps whose steps count against the timer. */
export function inSafariStepZone(mapId: string): boolean {
  return SAFARI_STEP_MAPS.has(mapId);
}

/**
 * The join prompt (SafariZoneGateSafariZoneWorker1WouldYouLikeToJoinText).
 * Reached both by talking to the worker and by stepping onto the cells in
 * front of him, which is how the original arms it.
 *
 * Declining — or being unable to pay — walks the player a step back down, so
 * they cannot slip past the counter without answering. That step runs through
 * scriptMove, which skips onStepComplete, so walking back cannot immediately
 * re-fire the trigger.
 *
 * The port takes Red/Blue's branch on an empty wallet: refused. Yellow's
 * low-cost admission (SafariZoneGate_2.asm) is a different ROM's script.
 */
export function safariJoinRows(yellow = false): ScriptRow[] {
  return [
    ["ask", "_SafariZoneGateSafariZoneWorker1WouldYouLikeToJoinText"],
    ["jump_if_false", "decline"],
    ["check_money", SAFARI_FEE],
    ["jump_if_false", yellow ? "discount" : "broke"],
    ["take_money", SAFARI_FEE],
    ["safari_start"],
    ["show_text", "_SafariZoneGateSafariZoneWorker1ThatllBe500PleaseText"],
    ["show_text", "_SafariZoneGateSafariZoneWorker1CallYouOnThePAText"],
    ["show_text", "_SafariZoneGateSafariZoneWorker1GoodLuckText"],
    // .success ends with `ld a, PAD_UP / ld c, 3`: paying walks the player up
    // and through the north warp; it is never left to them.
    ["safari_walk_in"],
    ["jump", "end"],
    ["label", "broke"],
    ["show_text", "_SafariZoneGateSafariZoneWorker1NotEnoughMoneyText"],
    ["move_player", "down", 1],
    ["jump", "end"],
    // Yellow: SafariZoneEntranceCalculateLowCostAdmission and the nags
    ["label", "discount"],
    ["safari_low_cost"],
    ["jump_if_false", "turned"],
    ["safari_walk_in"],
    ["jump", "end"],
    ["label", "turned"],
    ["move_player", "down", 1],
    ["jump", "end"],
    ["label", "decline"],
    ["show_text", "_SafariZoneGateSafariZoneWorker1PleaseComeAgainText"],
    ["move_player", "down", 1],
  ];
}

/**
 * Coming back to the gate mid-game (SafariZoneGateLeavingSafariScript
 * .leaving_early): YES ends the game, takes the leftover balls back and walks
 * the player down to the counter; NO walks them back up into the zone.
 */
export function safariLeavingRows(fromRightWarp: boolean): ScriptRow[] {
  // NO puts the player straight back in the zone. It has to be an explicit
  // warp, not a step back onto the warp tile: scripted steps skip
  // onStepComplete, so a step would leave them standing on it doing nothing.
  const back = fromRightWarp ? SAFARI_RETURN_RIGHT : SAFARI_RETURN_LEFT;
  return [
    ["ask", "_SafariZoneGateSafariZoneWorker1LeavingEarlyText"],
    ["jump_if_false", "stay"],
    ["show_text", "_SafariZoneGateSafariZoneWorker1ReturnSafariBallsText"],
    ["show_text", "_SafariZoneGateSafariZoneWorker1GoodHaulComeAgainText"],
    ["safari_end"],
    // move_player runs through scriptMove, which skips onStepComplete, so
    // walking back down past the trigger cells cannot re-fire the join prompt.
    ["move_player", "down", 3],
    ["jump", "end"],
    ["label", "stay"],
    ["show_text", "_SafariZoneGateSafariZoneWorker1GoodLuckText"],
    ["warp", "SAFARI_ZONE_CENTER", back[0], back[1], "up"],
  ];
}
