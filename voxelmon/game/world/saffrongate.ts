// The four Saffron gate guards (scripts/Route5Gate.asm and its siblings),
// ported from gen1recomp data/scripts/story2.lua.
//
// Saffron sits in the middle of Kanto and all four of its gates are held by a
// thirsty guard. Crossing without having given one a drink turns you back;
// one drink from the bag — FRESH_WATER, SODA_POP or LEMONADE, bought from the
// Celadon roof vending machines or any mart that stocks them — opens ALL four
// at once, because the guard shares it with the others.
//
// The drink is taken by the COORD TRIGGER, not by talking to him.
// Route5GateDefaultScript runs `farcall RemoveGuardDrink` before it decides
// anything, so walking up with a drink in the bag hands it over on the spot;
// only a player carrying nothing gets the thirsty line and the walk-back.
// Vanilla never requires you to talk to him at all.

import type { ScriptRow } from "./script.ts";

/** RemoveGuardDrink walks these three in order and removes ONE. */
export const GUARD_DRINKS = ["FRESH_WATER", "SODA_POP", "LEMONADE"] as const;

/** BIT_GAVE_SAFFRON_GUARDS_DRINK. */
export const GAVE_DRINK_FLAG = "EVENT_GAVE_GUARDS_DRINK";

/** The two lines a guard says once he has his drink. */
const ACCEPTED: ScriptRow[] = [
  ["show_text", "_SaffronGateGuardImParchedText"],
  ["show_text", "_SaffronGateGuardYouCanGoOnThroughText"],
];

/** Talking to him: thanks if he has one, take one if you have one, else no. */
export function saffronGuardTalkRows(): ScriptRow[] {
  return [
    ["face_player"],
    ["check_flag", GAVE_DRINK_FLAG],
    ["jump_if_true", "thanks"],
    ["take_guard_drink"],
    ["jump_if_false", "thirsty"],
    ...ACCEPTED,
    ["jump", "end"],
    ["label", "thanks"],
    ["show_text", "_SaffronGateGuardThanksForTheDrinkText"],
    ["jump", "end"],
    ["label", "thirsty"],
    ["show_text", "_SaffronGateGuardGeeImThirstyText"],
  ];
}

/**
 * Stepping onto the gate's checkpoint. `back` is the direction the walk-back
 * pushes — the reverse of the way the player is heading.
 */
export function saffronGateStepRows(back: string): ScriptRow[] {
  return [
    ["take_guard_drink"],
    ["jump_if_false", "block"],
    ...ACCEPTED,
    ["jump", "end"],
    ["label", "block"],
    ["show_text", "_SaffronGateGuardGeeImThirstyText"],
    ["move_player", back, 1],
  ];
}

export interface SaffronGate {
  /** The guard's TEXT_* constant. */
  guardText: string;
  /** PlayerInCoordsArray: the checkpoint cells. */
  triggers: [number, number][];
  /** True when the gate is crossed east/west rather than north/south. */
  horizontal?: boolean;
}

/** Each gate's own checkpoint (its PlayerInCoordsArray). */
export const SAFFRON_GATES: Record<string, SaffronGate> = {
  ROUTE_5_GATE: { guardText: "TEXT_ROUTE5GATE_GUARD", triggers: [[3, 3], [4, 3]] },
  ROUTE_6_GATE: { guardText: "TEXT_ROUTE6GATE_GUARD", triggers: [[3, 2], [4, 2]] },
  ROUTE_7_GATE: {
    guardText: "TEXT_ROUTE7GATE_GUARD", triggers: [[3, 3], [3, 4]], horizontal: true,
  },
  ROUTE_8_GATE: {
    guardText: "TEXT_ROUTE8GATE_GUARD", triggers: [[2, 3], [2, 4]], horizontal: true,
  },
};

/** The map script entry for one gate. */
export function saffronGateScript(gate: SaffronGate): {
  talk: Record<string, ScriptRow[]>;
  onStep: (ow: any, save: any) => ScriptRow[] | null;
} {
  return {
    talk: { [gate.guardText]: saffronGuardTalkRows() },
    onStep: (ow: any, save: any) => {
      const p = ow?.player;
      const x = p?.cellX;
      const y = p?.cellY;
      if (!gate.triggers.some(([cx, cy]) => cx === x && cy === y)) return null;
      if (save?.flags?.[GAVE_DRINK_FLAG]) return null;
      const back = gate.horizontal
        ? (p.facing === "left" ? "right" : "left")
        : (p.facing === "up" ? "down" : "up");
      return saffronGateStepRows(back);
    },
  };
}
