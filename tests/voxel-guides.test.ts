// The people whose lines were routines, not text: the gym guides and the
// badge guards on Routes 22 and 23. Runs on the Red import (dist/voxelmon/
// gen); skipped where there is none.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mapScript, useScriptsFor } from "../voxelmon/game/world/mapscripts.ts";
import { gateText, guardTalkRows, onGateCell } from "../voxelmon/game/world/badgegate.ts";

const genDir = join(import.meta.dir, "../dist/voxelmon/gen");
const hasRed = existsSync(join(genDir, "field.json"));
const field = hasRed ? JSON.parse(readFileSync(join(genDir, "field.json"), "utf8")) : null;
const text = hasRed ? JSON.parse(readFileSync(join(genDir, "text.json"), "utf8")) : {};

const talk = (version: string, map: string, key: string, save: any): unknown[][] => {
  useScriptsFor(version);
  const t = mapScript(map)!.talk![key]!;
  return (typeof t === "function" ? (t as any)({}, save) : t) as unknown[][];
};
const shown = (rows: unknown[][]) => rows.filter((r) => r[0] === "show_text" || r[0] === "ask").map((r) => r[1]);

describe("gym guides", () => {
  test("Pewter's asks, and his two answers are the branch, not the labels", () => {
    const rows = talk("red", "PEWTER_GYM", "TEXT_PEWTERGYM_GYM_GUIDE", { flags: {}, party: [] });
    expect(shown(rows)).toEqual([
      "_PewterGymGuidePreAdviceText", "_PewterGymGuideBeginAdviceText",
      "_PewterGymGuideFreeServiceText", "_PewterGymGuideAdviceText",
    ]);
    expect(shown(talk("red", "PEWTER_GYM", "TEXT_PEWTERGYM_GYM_GUIDE", { flags: { EVENT_BEAT_BROCK: true } })))
      .toEqual(["_PewterGymGuidePostBattleText"]);
    // Yellow's Pikachu along: his aside instead of the pitch
    const yellow = talk("yellow", "PEWTER_GYM", "TEXT_PEWTERGYM_GYM_GUIDE", { flags: {}, party: [{ species: "PIKACHU", hp: 5 }] });
    expect(shown(yellow)).toContain("_PewterGymGuyText");
    useScriptsFor("red");
  });

  test("Viridian's and the Game Corner's turn on the leader beaten", () => {
    expect(shown(talk("red", "VIRIDIAN_GYM", "TEXT_VIRIDIANGYM_GYM_GUIDE", { flags: {} })))
      .toEqual(["_ViridianGymGuidePreBattleText"]);
    expect(shown(talk("red", "GAME_CORNER", "TEXT_GAMECORNER_GYM_GUIDE", { flags: { EVENT_BEAT_ERIKA: true } })))
      .toEqual(["_GameCornerGymGuideTheyOfferRarePokemonText"]);
  });
});

describe("badge guards, face to face", () => {
  test.skipIf(!hasRed)("Route 23: the badge passes it for good; without, a step back", () => {
    const pass = guardTalkRows(field, { inventory: { CASCADEBADGE: 1 }, flags: {} }, "ROUTE_23", "Route23Guard5Text")!;
    expect(pass[0]).toEqual(["set_flag", "EVENT_PASSED_CASCADEBADGE_CHECK"]);
    expect(pass).toContainEqual(["show_text", "_Route23GoRightAheadText"]);
    const fail = guardTalkRows(field, { inventory: {}, flags: {} }, "ROUTE_23", "Route23Guard5Text")!;
    expect(fail).toContainEqual(["move_player", "down", 1]);
    expect(guardTalkRows(field, {}, "ROUTE_23", "Nobody")).toBeNull();
  });

  test.skipIf(!hasRed)("Route 22's gate: its own cells, and the ROM's lines rather than the fallbacks", () => {
    expect(onGateCell(field, "ROUTE_22_GATE", 4, 2)).toBe(true);
    expect(onGateCell(field, "ROUTE_22_GATE", 4, 3)).toBe(false);
    const fail = guardTalkRows(field, { inventory: {} }, "ROUTE_22_GATE", "Route22GateGuardText")!;
    expect(fail.map((r) => r[1])).toContain("_Route22GateGuardICantLetYouPassText");
    for (const r of fail) if (r[0] === "show_text") expect(text[r[1] as string]).toBeTruthy();
    expect(gateText(text, "Route23YouDontHaveTheBadgeYetText", "fallback")).not.toBe("fallback");
  });
});
