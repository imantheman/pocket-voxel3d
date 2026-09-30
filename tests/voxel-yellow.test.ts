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
import { findFollower, happiness, modifyHappiness, pikachuStep, selectEmotion } from "../voxelmon/game/world/pikachu.ts";

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

describe("Yellow: Pikachu follows you", () => {
  /** A Yellow game past the lab, Pikachu in the party, standing on a map. */
  function withPikachu(map: string, x: number, y: number, facing = "right"): VoxelmonGame {
    const game = newYellowGame();
    game.save.flags.EVENT_GOT_STARTER = true;
    game.save.party.push(newMon(yellow!, "PIKACHU", 5, game.battleRng));
    (game.overworld as any).setMap(map, x, y, facing);
    return game;
  }
  function walk(game: VoxelmonGame, btn: number, cells: number): void {
    const ow = game.overworld as any;
    for (let c = 0; c < cells; c++) {
      const [sx, sy] = [ow.player.cellX, ow.player.cellY];
      for (let t = 0; t < 40 && ow.player.cellX === sx && ow.player.cellY === sy; t++) game.tick(btn);
    }
    for (let t = 0; t < 24; t++) game.tick(0);
  }
  /** An open east-west run on a map. */
  function openRow(game: VoxelmonGame, map: string, len: number): [number, number] {
    const ow = game.overworld as any;
    ow.setMap(map, 1, 1, "down");
    const m = ow.map;
    for (let y = 2; y < m.heightCells - 2; y++) {
      for (let x = 2; x < m.widthCells - len - 2; x++) {
        let ok = true;
        for (let i = 0; i <= len && ok; i++) {
          if (!m.isWalkableCell(x + i, y) || m.warpAtCell(x + i, y) || m.isGrassCell(x + i, y) ||
              ow.npcs.some((n: any) => n.cellX === x + i && n.cellY === y)) ok = false;
        }
        if (ok) return [x, y];
      }
    }
    throw new Error("no open row");
  }

  test.skipIf(!hasYellow)("it arrives under you, then trails one cell behind as you walk", () => {
    const game = withPikachu("PALLET_TOWN", 5, 6);
    const ow = game.overworld as any;
    const [x, y] = openRow(game, "PALLET_TOWN", 5);
    ow.setMap("PALLET_TOWN", x, y, "right");
    const pika = findFollower(ow)!;
    expect(pika).toBeTruthy();
    expect([pika.cellX, pika.cellY]).toEqual([x, y]);
    walk(game, VOX_BTN.right, 3);
    const p2 = findFollower(ow)!;
    expect([ow.player.cellX, ow.player.cellY]).toEqual([x + 3, y]);
    expect([p2.cellX, p2.cellY]).toEqual([x + 2, y]);
    expect(p2.facing).toBe("right");
    expect((p2 as any).hidden).toBe(false);
  });

  test.skipIf(!hasYellow)("it never blocks: walk back through it and it goes round", () => {
    const game = withPikachu("PALLET_TOWN", 5, 6);
    const ow = game.overworld as any;
    const [x, y] = openRow(game, "PALLET_TOWN", 5);
    ow.setMap("PALLET_TOWN", x, y, "right");
    walk(game, VOX_BTN.right, 3);
    walk(game, VOX_BTN.left, 2); // turn, then onto Pikachu's cell
    expect(ow.player.cellX).toBeLessThanOrEqual(x + 2);
  });

  test.skipIf(!hasYellow)("through a door it comes along to the next map", () => {
    const game = withPikachu("PALLET_TOWN", 5, 6);
    const ow = game.overworld as any;
    // Red's house door is at (5,5); step up into it from (5,6)
    ow.setMap("PALLET_TOWN", 5, 6, "up");
    for (let t = 0; t < 200 && ow.map.id === "PALLET_TOWN"; t++) game.tick(t < 30 ? VOX_BTN.up : 0);
    for (let t = 0; t < 120; t++) game.tick(0);
    expect(ow.map.id).not.toBe("PALLET_TOWN");
    expect(findFollower(ow)).toBeTruthy();
  });

  test.skipIf(!hasYellow)("on the bike it waits in its ball", () => {
    const game = withPikachu("PALLET_TOWN", 5, 6);
    const ow = game.overworld as any;
    expect(findFollower(ow)).toBeTruthy();
    (game.save as any).onBike = true;
    game.tick(0);
    expect(findFollower(ow)).toBeUndefined();
    (game.save as any).onBike = false;
    game.tick(0);
    expect(findFollower(ow)).toBeTruthy();
  });

  test.skipIf(!hasYellow)("talking to it plays its beat and returns you to the map", () => {
    const game = withPikachu("PALLET_TOWN", 5, 6);
    const ow = game.overworld as any;
    const [x, y] = openRow(game, "PALLET_TOWN", 5);
    ow.setMap("PALLET_TOWN", x, y, "right");
    walk(game, VOX_BTN.right, 2);
    // turn round to face it (one cell behind) and press A
    game.tick(VOX_BTN.left); game.tick(0);
    for (let t = 0; t < 6; t++) game.tick(0);
    expect(ow.player.facing).toBe("left");
    game.tick(VOX_BTN.a);
    expect(ow.runner.isRunning()).toBe(true);
    playOut(game);
    expect(game.stackKinds().at(-1)).toBe("overworld");
  });

  test.skipIf(!hasYellow)("happiness moves by the ROM's bands, and only for a Pikachu", () => {
    const save: any = { version: "yellow", party: [{ species: "PIKACHU", hp: 10 }] };
    expect(happiness(save)).toBe(90);
    modifyHappiness(save, "LEVELUP", { species: "PIKACHU" });
    expect(save.pikachuHappiness).toBe(95); // +5 under 100
    modifyHappiness(save, "LEVELUP", { species: "PIKACHU" });
    expect(save.pikachuHappiness).toBe(100);
    modifyHappiness(save, "LEVELUP", { species: "PIKACHU" });
    expect(save.pikachuHappiness).toBe(103); // +3 from 100
    modifyHappiness(save, "LEVELUP", { species: "RATTATA" });
    expect(save.pikachuHappiness).toBe(103);
    modifyHappiness(save, "TRADE", { species: "PIKACHU" });
    expect(save.pikachuHappiness).toBe(93);
    expect(save.pikachuMood).toBe(0);
    // the mood drifts back one a step
    pikachuStep(save, () => false);
    expect(save.pikachuMood).toBe(1);
    // and a Red save never counts any of it
    const red: any = { version: "red", party: [{ species: "PIKACHU", hp: 10 }] };
    modifyHappiness(red, "LEVELUP", { species: "PIKACHU" });
    expect(red.pikachuHappiness).toBeUndefined();
  });

  test("its answer: asleep, hurt, the Tower, then mood and happiness", () => {
    expect(selectEmotion({ party: [{ species: "PIKACHU", hp: 1, status: "SLP" }] } as never, "ROUTE_1")).toBe(11);
    expect(selectEmotion({ party: [{ species: "PIKACHU", hp: 1, status: "PSN" }] } as never, "ROUTE_1")).toBe(28);
    expect(selectEmotion({ party: [{ species: "PIKACHU", hp: 1 }] } as never, "POKEMON_TOWER_3F")).toBe(22);
    expect(selectEmotion({ party: [{ species: "PIKACHU", hp: 1 }], pikachuHappiness: 90, pikachuMood: 128 } as never, "ROUTE_1")).toBe(5);
    expect(selectEmotion({ party: [{ species: "PIKACHU", hp: 1 }], pikachuHappiness: 255, pikachuMood: 255 } as never, "ROUTE_1")).toBe(20);
  });

  test.skipIf(!hasYellow)("Red has no follower", () => {
    const game = new VoxelmonGame({ ...yellow!, version: "red" } as VoxelmonData, new Host(), 1);
    game.newGame();
    game.closeToOverworld();
    game.save.flags.EVENT_GOT_STARTER = true;
    game.save.party.push(newMon(yellow!, "PIKACHU", 5, game.battleRng));
    (game.overworld as any).setMap("PALLET_TOWN", 5, 6, "down");
    game.tick(0);
    expect(findFollower(game.overworld as any)).toBeUndefined();
  });
});
