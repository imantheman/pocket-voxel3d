// Pokémon Yellow: what plays differently from Red and Blue. Runs on the
// Yellow import (dist/voxelmon/yellow/gen, from the player's own ROM) and is
// skipped where there is none -- nothing ROM-derived is committed.
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { loadRuntimeData, REQUIRED_MODULES, type VoxelmonData } from "../voxelmon/game/data.ts";
import { VoxelmonGame } from "../voxelmon/game/game.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";
import { mapScript, useScriptsFor } from "../voxelmon/game/world/mapscripts.ts";
import { prizeWindows, YELLOW_PRIZE_WINDOWS } from "../voxelmon/game/world/gamecorner.ts";
import { newMon } from "../voxelmon/game/battle/mon.ts";
import * as Items from "../voxelmon/game/rules/items.ts";

const genDir = join(import.meta.dir, "../dist/voxelmon/yellow/gen");
const hasYellow = REQUIRED_MODULES.every((m) => existsSync(join(genDir, `${m}.json`)));
const yellow: VoxelmonData | null = hasYellow
  ? { ...(await loadRuntimeData(genDir)), version: "yellow" } as VoxelmonData
  : null;

class Host extends RecorderHost {
  saved: string | undefined;
  pic(): void {}
  picHide(): void {}
  saveWrite(t: string): void { this.saved = t; }
  saveData(): string | undefined { return this.saved; }
}

function newYellowGame(): VoxelmonGame {
  const game = new VoxelmonGame(yellow!, new Host(), 1);
  game.newGame();
  game.closeToOverworld();
  return game;
}

/** Tap A through whatever is running until the world is idle again. */
function playOut(game: VoxelmonGame, max = 20000): number {
  let t = 0;
  for (; t < max; t++) {
    const ow = game.overworld as any;
    const idle = game.stackKinds().at(-1) === "overworld" && !ow.runner.isRunning() &&
      !ow.player.moving && ow.scriptMoves.length === 0 && !ow.transitioning && !ow.emote;
    if (idle && t > 2) return t;
    // a nickname prompt: END it (the gift keeps its species name)
    const naming = game.stackKinds().at(-1) === "naming";
    game.tick(t % 2 === 0 ? (naming ? VOX_BTN.start : VOX_BTN.a) : 0);
  }
  return t;
}

describe("Yellow: the map scripts it lays over Red's", () => {
  test.skipIf(!hasYellow)("the lab has one ball, the Eevee, and Red's three are not Yellow's", () => {
    useScriptsFor("yellow");
    const lab = mapScript("OAKS_LAB")!;
    expect(typeof lab.talk!.TEXT_OAKSLAB_EEVEE_POKE_BALL).toBe("function");
    // Red's Oak rows are kept, with Yellow's own lines swapped in
    const oak = lab.talk!.TEXT_OAKSLAB_OAK1 as unknown[][];
    const said = oak.filter((r) => r[0] === "show_text").map((r) => r[1]);
    expect(said).toContain("_OaksLabOak1YouShouldTalkToIt");
    expect(said).not.toContain("_OaksLabOak1RaiseYourYoungPokemonText");
    useScriptsFor("red");
    const red = mapScript("OAKS_LAB")!.talk!.TEXT_OAKSLAB_OAK1 as unknown[][];
    expect(red.filter((r) => r[0] === "show_text").map((r) => r[1])).toContain("_OaksLabOak1RaiseYourYoungPokemonText");
  });
});

describe("Yellow: the opening", () => {
  test.skipIf(!hasYellow)("Oak stops you on row 0, catches a Pikachu himself, and walks you to the lab", () => {
    const game = newYellowGame();
    const ow = game.overworld as any;
    ow.setMap("PALLET_TOWN", 10, 1, "up");
    // one step north onto row 0
    for (let t = 0; t < 40 && ow.player.cellY !== 0; t++) game.tick(VOX_BTN.up);
    let sawOakBattle = false;
    for (let t = 0; t < 30000; t++) {
      const kinds = game.stackKinds();
      if (kinds.includes("battle")) {
        const b = (game.battleView() as any)?.battle;
        if (b?.demoName === "PROF.OAK" && b?.enemy?.mon?.species === "PIKACHU") sawOakBattle = true;
      }
      if (game.save.flags.EVENT_OAK_ASKED_TO_CHOOSE_MON && kinds.at(-1) === "overworld" && !ow.runner.isRunning()) break;
      game.tick(t % 2 === 0 ? VOX_BTN.a : 0);
    }
    expect(sawOakBattle).toBe(true);
    expect(ow.map.id).toBe("OAKS_LAB");
    expect(game.save.flags.EVENT_FOLLOWED_OAK_INTO_LAB).toBe(true);
    expect(game.save.flags.EVENT_FOLLOWED_OAK_INTO_LAB_2).toBe(true);
    // the demo keeps nothing: no party yet
    expect(game.save.party.length).toBe(0);
  });

  test.skipIf(!hasYellow)("the rival takes the Eevee, and Oak gives you Pikachu with no nickname", () => {
    const game = newYellowGame();
    const ow = game.overworld as any;
    game.save.flags.EVENT_FOLLOWED_OAK_INTO_LAB = true;
    game.save.flags.EVENT_FOLLOWED_OAK_INTO_LAB_2 = true;
    game.save.flags.EVENT_OAK_ASKED_TO_CHOOSE_MON = true;
    ow.setMap("OAKS_LAB", 7, 4, "up");
    ow.showMapText("TEXT_OAKSLAB_EEVEE_POKE_BALL");
    playOut(game);
    expect(game.save.flags.EVENT_GOT_STARTER).toBe(true);
    expect(game.save.flags.EVENT_CHOSE_PIKACHU).toBe(true);
    expect(game.save.party.map((m) => m.species)).toEqual(["PIKACHU"]);
    expect(game.save.party[0]!.nickname).toBeUndefined();
    expect(game.stackKinds()).not.toContain("naming");
    expect((game.save as any).rivalStarter).toBe(1);
    // walked round the table to stand under Oak
    expect([ow.player.cellX, ow.player.cellY]).toEqual([5, 3]);
  });

  test.skipIf(!hasYellow)("before Oak's speech the ball is only a ball", () => {
    const game = newYellowGame();
    const ow = game.overworld as any;
    ow.setMap("OAKS_LAB", 7, 4, "up");
    ow.showMapText("TEXT_OAKSLAB_EEVEE_POKE_BALL");
    playOut(game);
    expect(game.save.flags.EVENT_GOT_STARTER).toBeUndefined();
    expect(game.save.party.length).toBe(0);
  });

  test.skipIf(!hasYellow)("leaving with Pikachu, the rival battles you with his Eevee and decides its future", () => {
    const game = newYellowGame();
    const ow = game.overworld as any;
    for (const f of ["EVENT_FOLLOWED_OAK_INTO_LAB", "EVENT_OAK_ASKED_TO_CHOOSE_MON", "EVENT_GOT_STARTER"]) {
      game.save.flags[f] = true;
    }
    (game.save as any).rivalStarter = 1;
    const { newMon } = require("../voxelmon/game/battle/mon.ts");
    game.save.party.push(newMon(yellow!, "PIKACHU", 5, game.battleRng));
    ow.setMap("OAKS_LAB", 5, 5, "down");
    let rivalMon: string | undefined;
    for (let t = 0; t < 40 && ow.player.cellY < 6; t++) game.tick(VOX_BTN.down);
    for (let t = 0; t < 40000; t++) {
      const b = (game.battleView() as any)?.battle;
      if (b?.enemy?.mon?.species) rivalMon ??= b.enemy.mon.species;
      if (game.save.flags.EVENT_BATTLED_RIVAL_IN_OAKS_LAB && game.stackKinds().at(-1) === "overworld" && !ow.runner.isRunning()) break;
      game.tick(t % 2 === 0 ? VOX_BTN.a : 0);
    }
    expect(rivalMon).toBe("EEVEE");
    expect(game.save.flags.EVENT_BATTLED_RIVAL_IN_OAKS_LAB).toBe(true);
    // FLAREON on a win, VAPOREON on a loss
    expect([2, 3]).toContain((game.save as any).rivalStarter);
  });
});

describe("Yellow: the people it renamed", () => {
  test.skipIf(!hasYellow)("the Game Corner's middle-aged man gives his 20 coins under Yellow's lines", () => {
    const game = newYellowGame();
    const ow = game.overworld as any;
    game.save.inventory.COIN_CASE = 1;
    ow.setMap("GAME_CORNER", 14, 12, "up");
    const shown: string[] = [];
    const orig = ow.shell.showText.bind(ow.shell);
    ow.shell.showText = (t: string, cb: () => void, o?: unknown) => { shown.push(t); return orig(t, cb, o); };
    ow.showMapText("TEXT_GAMECORNER_MIDDLE_AGED_MAN2");
    playOut(game);
    expect((game.save as any).coins).toBe(20);
    expect(game.save.flags.EVENT_GOT_20_COINS_2).toBe(true);
    // every line was real text, not a label printed raw
    expect(shown.some((t) => t.startsWith("_"))).toBe(false);
  });

  test.skipIf(!hasYellow)("the Viridian old man misses his throw, says so, and walks off", () => {
    const game = newYellowGame();
    const ow = game.overworld as any;
    game.save.flags.EVENT_GOT_POKEDEX = true;
    ow.setMap("VIRIDIAN_CITY", 19, 10, "up");
    // one step north into the gap beside him
    for (let t = 0; t < 40 && ow.player.cellY !== 9; t++) game.tick(VOX_BTN.up);
    let demo: any = null;
    for (let t = 0; t < 30000; t++) {
      const b = (game.battleView() as any)?.battle;
      if (b?.demo) demo ??= b;
      if (game.save.flags.EVENT_COMPLETED_CATCH_TRAINING && game.stackKinds().at(-1) === "overworld" && !ow.runner.isRunning() && ow.scriptMoves.length === 0) break;
      game.tick(t % 2 === 0 ? VOX_BTN.a : 0);
    }
    expect(demo).not.toBeNull();
    expect(demo.demoFails).toBe(true);
    expect(demo.enemy.mon.species).toBe("RATTATA");
    expect(game.save.flags.EVENT_COMPLETED_CATCH_TRAINING).toBe(true);
    const man = ow.findNpc("VIRIDIANCITY_OLD_MAN2");
    expect(!man || man.hidden).toBe(true);
    expect((game.save as any).objectToggles.VIRIDIAN_CITY.VIRIDIANCITY_OLD_MAN2).toBe(false);
  });
});

describe("Yellow: its own tables", () => {
  test.skipIf(!hasYellow)("the Game Corner stocks Yellow's prizes, and the TMs stay the same", () => {
    expect(prizeWindows(yellow)).toBe(YELLOW_PRIZE_WINDOWS);
    expect(YELLOW_PRIZE_WINDOWS[0]!.map((p) => p.species)).toEqual(["ABRA", "VULPIX", "WIGGLYTUFF"]);
    expect(YELLOW_PRIZE_WINDOWS[1]!.map((p) => [p.species, p.level, p.cost])).toEqual(
      [["SCYTHER", 30, 6500], ["PINSIR", 30, 6500], ["PORYGON", 26, 9999]]);
  });

  test.skipIf(!hasYellow)("the in-game trades are Yellow's", () => {
    const trades = (yellow!.field as any).trades;
    expect(trades[0]).toMatchObject({ give: "LICKITUNG", get: "DUGTRIO" });
    expect((yellow!.field as any).oldManBattle.species).toBe("RATTATA");
  });

  test.skipIf(!hasYellow)("your own Pikachu refuses a THUNDER STONE and keeps it; a traded one evolves", () => {
    const game = newYellowGame();
    const mine = newMon(yellow!, "PIKACHU", 10, game.battleRng);
    const r = Items.useItem(yellow, game.save, "THUNDER_STONE", mine, null);
    expect(r.kind).toBe("failed");
    expect(r.refused).toBe(true);
    expect(r.msgs[0]).toContain("is refusing!");
    const traded = { ...newMon(yellow!, "PIKACHU", 10, game.battleRng), otName: "ASH", otId: 1 };
    expect(Items.useItem(yellow, game.save, "THUNDER_STONE", traded as never, null).evolveTo).toBe("RAICHU");
    // and Red's Pikachu never refused
    expect(Items.useItem({ ...yellow!, version: "red" }, game.save, "THUNDER_STONE", mine, null).evolveTo).toBe("RAICHU");
  });
});

describe("Yellow: the gifts and the duo", () => {
  function withParty(game: VoxelmonGame, level = 70): void {
    game.save.party.push(newMon(yellow!, "PIKACHU", level, game.battleRng));
  }

  test.skipIf(!hasYellow)("Officer Jenny keeps her Squirtle until the THUNDERBADGE", () => {
    const game = newYellowGame();
    const ow = game.overworld as any;
    withParty(game);
    ow.setMap("VERMILION_CITY", 19, 16, "up");
    ow.showMapText("TEXT_VERMILIONCITY_OFFICER_JENNY");
    playOut(game);
    expect(game.save.party.length).toBe(1);
    game.save.inventory.THUNDERBADGE = 1;
    ow.showMapText("TEXT_VERMILIONCITY_OFFICER_JENNY");
    playOut(game);
    // YES is the default answer, so A through it takes the gift; the
    // nickname prompt is answered by END
    expect(game.save.party.map((m) => m.species)).toContain("SQUIRTLE");
    expect(game.save.flags.EVENT_GOT_SQUIRTLE_FROM_OFFICER_JENNY).toBe(true);
  });

  test.skipIf(!hasYellow)("Damian on Route 24 gives his Charmander once", () => {
    const game = newYellowGame();
    const ow = game.overworld as any;
    withParty(game);
    ow.setMap("ROUTE_24", 6, 6, "up");
    ow.showMapText("TEXT_ROUTE24_COOLTRAINER_M4");
    playOut(game);
    ow.showMapText("TEXT_ROUTE24_COOLTRAINER_M4");
    playOut(game);
    expect(game.save.party.filter((m) => m.species === "CHARMANDER").length).toBe(1);
    expect(game.save.flags.EVENT_54F).toBe(true);
  });

  test.skipIf(!hasYellow)("Melanie holds on to her Bulbasaur until Pikachu trusts you", () => {
    const game = newYellowGame();
    const ow = game.overworld as any;
    withParty(game);
    ow.setMap("CERULEAN_MELANIES_HOUSE", 3, 2, "up");
    ow.showMapText("TEXT_CERULEANMELANIESHOUSE_MELANIE");
    playOut(game);
    expect(game.save.party.length).toBe(1);
    (game.save as any).pikachuHappiness = 200;
    ow.showMapText("TEXT_CERULEANMELANIESHOUSE_MELANIE");
    playOut(game);
    expect(game.save.party.map((m) => m.species)).toContain("BULBASAUR");
  });

  test.skipIf(!hasYellow)("Jessie & James ambush Mt Moon once you have a fossil, and vanish when beaten", () => {
    const game = newYellowGame();
    const ow = game.overworld as any;
    withParty(game, 90);
    game.save.flags.EVENT_GOT_HELIX_FOSSIL = true;
    game.save.flags.EVENT_BEAT_MT_MOON_EXIT_SUPER_NERD = true;
    ow.setMap("MT_MOON_B2F", 3, 6, "up");
    for (let t = 0; t < 40 && ow.player.cellY !== 5; t++) game.tick(VOX_BTN.up);
    let rocketMons: string[] = [];
    for (let t = 0; t < 60000; t++) {
      const b = (game.battleView() as any)?.battle;
      if (b?.enemy?.mon?.species && !rocketMons.includes(b.enemy.mon.species)) rocketMons.push(b.enemy.mon.species);
      if (game.save.flags.EVENT_BEAT_MT_MOON_3_JESSIE_JAMES && game.stackKinds().at(-1) === "overworld" && !ow.runner.isRunning()) break;
      game.tick(t % 2 === 0 ? VOX_BTN.a : 0);
    }
    expect(rocketMons).toContain("EKANS");
    expect(game.save.flags.EVENT_BEAT_MT_MOON_3_JESSIE_JAMES).toBe(true);
    const jessie = ow.findNpc("MTMOONB2F_JESSIE");
    expect(!jessie || jessie.hidden).toBe(true);
  });
});
