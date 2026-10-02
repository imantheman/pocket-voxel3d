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
import {
  findFollower,
  happiness,
  isStarterPikachu,
  modifyHappiness,
  pikachuStep,
  selectEmotion,
  talkRows,
} from "../voxelmon/game/world/pikachu.ts";
import { AudioDirector } from "../voxelmon/game/audio/music.ts";
import { WildBattle, type BattleButton, type BattleInput } from "../voxelmon/game/battle/battle.ts";
import { seqRng } from "../voxelmon/game/rng.ts";
import {
  BG_MAPS,
  FRAMES,
  YELLOW_INTRO_PICTURES,
  YellowIntroScenes,
  bgpShades,
  frameBox,
  yellowIntroPalette,
} from "../voxelmon/game/ui/yellowintro.ts";
import { IntroState } from "../voxelmon/game/ui/intro.ts";
import { surfingPikachuInParty } from "../voxelmon/game/ui/surfingstate.ts";
import { cableClubScript, EVENT_SURF_PIKACHU_FLAG } from "../voxelmon/game/world/cableclub.ts";
import * as Pika from "../voxelmon/game/world/pikachu.ts";
import { chanseyScript, nurseGreetScript } from "../voxelmon/game/world/nurses.ts";
import { PIKA_MAP_PAUSE_IGT, PIKA_MAP_SURF_SELECT } from "../voxelmon/game/world/script.ts";

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

describe("Yellow: its attract movie", () => {
  /** Run the scenes, recording each frame's picture set. */
  function run(): { frames: ReturnType<YellowIntroScenes["frame"]>[]; s: YellowIntroScenes } {
    const s = new YellowIntroScenes();
    const frames = [];
    for (let t = 0; t < 2000 && !s.done; t++) {
      s.update();
      frames.push(s.frame());
    }
    return { frames, s };
  }

  test("it runs the ROM's length, scene by scene", () => {
    const { frames, s } = run();
    expect(s.done).toBe(true);
    // 2 head frames, then 130/128/128/88/128/128/128-frame scenes with a
    // 3-frame blanked setup between each, the 51-step strobe, the flash, the
    // fade and the 64-frame hold (gen1recomp YellowIntro.lua)
    expect(frames.length).toBe(1054);
    const bgAt = (t: number) => frames[t - 1]!.bg?.name ?? null;
    expect(bgAt(40)).toBe("bg_letter");
    expect(bgAt(200)).toBe("bg_kick");
    expect(bgAt(470)).toBe("bg_sea");
    expect(bgAt(640)).toMatch(/^bg_sky[01]$/);
    expect(bgAt(850)).toBe("bg_close");
    expect(bgAt(1000)).toBeNull(); // faded to white
    // the setup between scenes is white (rBGP $00)
    expect(frames.some((f, i) => i > 130 && i < 140 && f.bg === null)).toBe(true);
  });

  test("the kick scrolls in to SCX $68 with eight speed bars", () => {
    const { frames } = run();
    const kick = frames.filter((f) => f.bg?.name === "bg_kick");
    expect(kick.at(-1)!.bg!.scx).toBe(0x68);
    expect(Math.max(...kick.map((f) => f.objects.filter((o) => o.name === "obj_0e").length))).toBeGreaterThanOrEqual(4);
  });

  test("the strobe flashes to black only, the flash blacks the screen, the fade steps down", () => {
    const { frames } = run();
    expect(frames.some((f) => f.bg?.name === "bg_close_k" && f.objects.every((o) => o.name.endsWith("_k")))).toBe(true);
    expect(frames.some((f) => f.black && f.objects.some((o) => o.name === "obj_0d"))).toBe(true);
    const fade = frames.map((f) => f.bg?.name).filter((n) => n?.startsWith("bg_letter_s"));
    expect(fade).toEqual(["bg_letter_s1", "bg_letter_s1", "bg_letter_s2", "bg_letter_s2"]);
  });

  test("every picture it names is one the importer lays out", () => {
    const names = new Set(YELLOW_INTRO_PICTURES.map((p) => p.name));
    for (const f of run().frames) {
      if (f.bg) expect(names.has(f.bg.name)).toBe(true);
      for (const o of f.objects) expect(names.has(o.name)).toBe(true);
    }
    for (const p of YELLOW_INTRO_PICTURES) {
      if (p.bg) expect(BG_MAPS[p.bg]).toBeDefined();
      else expect(FRAMES[p.frame!]).toBeDefined();
    }
  });

  test("its tables: OAM boxes, BGP shade maps and the palettes", () => {
    expect(frameBox(0x01)).toEqual({ dx: -8, dy: -8, w: 16, h: 16 });
    expect(frameBox(0x0b)).toEqual({ dx: -24, dy: -24, w: 48, h: 48 });
    expect(frameBox(0x13)).toEqual({ dx: -40, dy: -8, w: 80, h: 16 });
    expect(bgpShades(0xe4)).toEqual([0, 1, 2, 3]);
    expect(bgpShades(0xc0)).toEqual([0, 0, 0, 3]);
    expect(bgpShades(0x90)).toEqual([0, 0, 1, 2]);
    expect(yellowIntroPalette("bg_sea")).toBe("PIKACHUS_BEACH");
    expect(yellowIntroPalette("obj_0d")).toBe("MEWMON");
    // the kick's block sits at column 20, where SCX $68 brings it on screen
    expect(BG_MAPS.kick!()[6]![20]).toBe(0x90);
  });

  test("the boot movie plays it where Red's fight would be", () => {
    const atlas = { picIntro: Object.fromEntries(YELLOW_INTRO_PICTURES.map((p, i) => [`yi_${p.name}`, 100 + i])) };
    const songs: string[] = [];
    const input = { pressed: {} as Record<string, boolean> };
    let done = 0;
    const intro = new IntroState(
      {
        input,
        data: { version: "yellow", atlas },
        pop() {},
        audio: { playSfx() {}, playOnce: (s: string) => (songs.push(s), true), stop() {} },
      } as never,
      () => { done++; },
    );
    let t = 0;
    while (intro.view().phase !== "fight" && t < 2000) { intro.update(); t++; }
    expect(songs).toEqual(["Music_YellowIntro"]);
    for (let i = 0; i < 400; i++) intro.update();
    const pages = new Set(intro.view().pics.map((q) => q.page));
    expect([...pages].some((pg) => pg >= 100)).toBe(true);
    for (let i = 0; i < 1100 && !done; i++) intro.update();
    expect(done).toBe(1);
  });
});

describe("Yellow: the lines it moved into Print routines", () => {
  const rows = (map: string, text: string, ow: any, save: any): unknown[][] => {
    useScriptsFor("yellow");
    const t = mapScript(map)!.talk![text]!;
    return (typeof t === "function" ? (t as any)(ow, save) : t) as unknown[][];
  };
  const shown = (r: unknown[][]) => r.filter((x) => x[0] === "show_text" || x[0] === "ask").map((x) => x[1]);

  test("the Celadon granny reads your Pikachu, and a devoted one answers", () => {
    const pika = { species: "PIKACHU", hp: 10 };
    expect(shown(rows("CELADON_MANSION_1F", "TEXT_CELADONMANSION1F_GRANNY", {}, { party: [] })))
      .toEqual(["_CeladonMansion1Text2"]);
    expect(shown(rows("CELADON_MANSION_1F", "TEXT_CELADONMANSION1F_GRANNY", {}, { party: [pika], pikachuHappiness: 120 })))
      .toEqual(["_CeladonMansion1Text2", "_CeladonMansion1Text6", "_CeladonMansion1Text9"]);
    const devoted = rows("CELADON_MANSION_1F", "TEXT_CELADONMANSION1F_GRANNY", {}, { party: [pika], pikachuHappiness: 255 });
    expect(shown(devoted).at(-1)).toBe("_CeladonMansion1Text12");
    expect(devoted.at(-1)).toEqual(["pika_clip", 23]);
  });

  test("the TV, the girl, the guide and the Route 18 cook", () => {
    expect(shown(rows("REDS_HOUSE_1F", "TEXT_REDSHOUSE1F_TV", { player: { facing: "left" } }, {})))
      .toEqual(["_RedsHouse1FTVWrongSideText"]);
    expect(shown(rows("VIRIDIAN_CITY", "TEXT_VIRIDIANCITY_GIRL", {}, { flags: { EVENT_GOT_POKEDEX: true } })))
      .toEqual(["_ViridianCityGirlWhenIGoShopText"]);
    expect(shown(rows("CINNABAR_GYM", "TEXT_CINNABARGYM_GYM_GUIDE", {}, { flags: {} })))
      .toEqual(["_CinnabarGymGymGuideChampInMakingText"]);
    expect(rows("ROUTE_18_GATE_2F", "TEXT_ROUTE18GATE2F_COOK", {}, {})).toContainEqual(["trade", 6, "EVENT_TRADED_SLOWBRO_FOR_LICKITUNG"]);
    expect(chanseyScript("TEXT_INDIGOPLATEAULOBBY_CHANSEY")).not.toBeNull();
  });
});

describe("Yellow: the Summer Beach House", () => {
  const talk = (text: string, ow: any, save: any): unknown[][] => {
    useScriptsFor("yellow");
    const t = mapScript("SUMMER_BEACH_HOUSE")!.talk![text]!;
    return (typeof t === "function" ? (t as any)(ow, save) : t) as unknown[][];
  };
  const surfer = { species: "PIKACHU", moves: [{ id: "THUNDERSHOCK" }, { id: "SURF" }] };
  const texts = (rows: unknown[][]) => rows.filter((r) => r[0] === "show_text" || r[0] === "ask").map((r) => r[1]);

  test("only a Pikachu that knows SURF counts", () => {
    expect(surfingPikachuInParty({ party: [surfer] } as never)).toBe(true);
    expect(surfingPikachuInParty({ party: [{ species: "PIKACHU", moves: [{ id: "SURF" }].slice(1) }] } as never)).toBe(false);
    expect(surfingPikachuInParty({ party: [{ species: "RAICHU", moves: [{ id: "SURF" }] }] } as never)).toBe(false);
  });

  test("the SURFIN' DUDE pitches once a visit, then asks short, and runs the game on YES", () => {
    const ow: any = { pikachuMapFlags: 0 };
    expect(texts(talk("TEXT_SUMMERBEACHHOUSE_SURFINDUDE", ow, { party: [] }))).toEqual(["_SummerBeachHouseSurfinDudeText4"]);
    const first = talk("TEXT_SUMMERBEACHHOUSE_SURFINDUDE", ow, { party: [surfer] });
    expect(texts(first)).toEqual(["_SummerBeachHouseSurfinDudeText1", "_SummerBeachHouseSurfinDudeText2"]);
    expect(first.some((r) => r[0] === "surfing_minigame")).toBe(true);
    expect(ow.pikachuMapFlags & PIKA_MAP_PAUSE_IGT).toBeTruthy();
    expect(texts(talk("TEXT_SUMMERBEACHHOUSE_SURFINDUDE", ow, { party: [surfer] }))[0]).toBe("_SummerBeachHouseSurfinDudeText3");
  });

  test("the posters and the printer read the party, the printer the visit too", () => {
    expect(texts(talk("TEXT_SUMMERBEACHHOUSE_POSTER2", {}, { party: [surfer] }))).toEqual(["_SummerBeachHousePoster2Text1"]);
    expect(texts(talk("TEXT_SUMMERBEACHHOUSE_POSTER2", {}, { party: [] }))).toEqual(["_SummerBeachHousePoster2Text2"]);
    expect(texts(talk("TEXT_SUMMERBEACHHOUSE_PRINTER", {}, { party: [] }))).toEqual(["_SummerBeachHousePrinterText1"]);
    const notYet = talk("TEXT_SUMMERBEACHHOUSE_PRINTER", { pikachuMapFlags: 0 }, { party: [surfer] });
    expect(texts(notYet)).toEqual(["_SummerBeachHousePrinterText2"]);
    const surfed = talk("TEXT_SUMMERBEACHHOUSE_PRINTER", { pikachuMapFlags: PIKA_MAP_SURF_SELECT },
      { party: [surfer], surfingHiScore: 0x1234, player: { name: "YELLOW" } });
    const all = texts(surfed) as string[];
    expect(all.slice(0, 3)).toEqual(["_SummerBeachHousePrinterText2", "_SummerBeachHousePrinterText3", "_SummerBeachHousePrinterText6"]);
    expect(all.at(-1)).toContain("YELLOW's Hi-Score");
    expect(all.at(-1)).toContain("1234 Points");
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

  test("it answers in its own voice, and only where the ROM gives it one", () => {
    const save: any = { version: "yellow", party: [{ species: "PIKACHU", hp: 10 }], pikachuHappiness: 90, pikachuMood: 128 };
    const w: any = { save, map: { id: "ROUTE_1" }, player: { facing: "left" } };
    // emotion 5 -> pikaemotion_pcm PikachuCry31
    expect(talkRows(w, -1)).toContainEqual(["pika_clip", 31]);
    expect(talkRows(w, -1).some((r) => r[0] === "play_cry")).toBe(false);
    // emotion 6 (the skull) says nothing at all
    save.pikachuHappiness = 40;
    save.pikachuMood = 128;
    expect(selectEmotion(save, "ROUTE_1")).toBe(6);
    expect(talkRows(w, -1).some((r) => r[0] === "pika_clip" || r[0] === "play_cry")).toBe(false);
  });

  test("the director plays a clip when the cook carried them, else the chip cry", () => {
    const calls: string[] = [];
    const host: any = {
      pikaPcm: (n: number) => calls.push(`pcm ${n}`),
      cry: () => calls.push("cry"),
    };
    const banks = (clips: number): any => ({
      playable: true,
      pikaClips: clips,
      pins: () => [],
      cry: () => ({ bank: 0, address: 0x4000, engine: 1, pitch: 0, length: 0 }),
    });
    const voiced = new AudioDirector(banks(42), host);
    voiced.playPikaClip(11);
    voiced.playPikaClip(99);
    voiced.playPikaClip(0);
    expect(calls).toEqual(["pcm 11", "pcm 42", "pcm 1"]);
    calls.length = 0;
    new AudioDirector(banks(0), host).playPikaClip(11);
    expect(calls).toEqual(["cry"]);
  });

  test("only your own Pikachu is the starter, and only in Yellow", () => {
    const save = { version: "yellow", player: { name: "YELLOW", id: 7 } };
    expect(isStarterPikachu(save, { species: "PIKACHU", otName: "YELLOW", otId: 7 })).toBe(true);
    expect(isStarterPikachu(save, { species: "PIKACHU" })).toBe(true);
    expect(isStarterPikachu(save, { species: "PIKACHU", otName: "BILL", otId: 3 })).toBe(false);
    expect(isStarterPikachu(save, { species: "RAICHU", otName: "YELLOW", otId: 7 })).toBe(false);
    expect(isStarterPikachu({ ...save, version: "red" }, { species: "PIKACHU" })).toBe(false);
  });

  test.skipIf(!hasYellow)("sent out, it says its name (sleepy when asleep)", () => {
    class Input implements BattleInput {
      a = false;
      isDown(b: BattleButton): boolean { return b === "a" && this.a; }
      wasPressed(b: BattleButton): boolean { return b === "a" && this.a; }
    }
    for (const [status, clip] of [[undefined, "pika:11"], ["SLP", "pika:37"]] as const) {
      const pika = newMon(yellow!, "PIKACHU", 5);
      if (status) (pika as any).status = status;
      const save: any = { version: "yellow", party: [pika], inventory: {}, player: { name: "YELLOW", rival: "BLUE" } };
      const b = new WildBattle(yellow!, save, seqRng(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), "PIDGEY", 3);
      b.enter();
      const input = new Input();
      for (let i = 0; i < 4000 && b.phase === "messages"; i++) {
        input.a = i % 2 === 0;
        b.update(input);
      }
      expect(b.audioCues).toContain(clip);
    }
  });

  /** A bare world with the follower spawned under a player at (5,5). */
  function pikaWorld(facing = "up"): any {
    const emotes: number[] = [];
    const w: any = {
      save: { version: "yellow", flags: { EVENT_GOT_STARTER: true }, party: [{ species: "PIKACHU", hp: 10 }] },
      data: yellow,
      map: { id: "TEST", inBounds: () => false, cellTile: () => 0, def: { tileset: "OVERWORLD" } },
      player: { cellX: 5, cellY: 5, px: 80, py: 80, facing },
      npcs: [],
      entities: [],
      setEmote: (_e: unknown, kind: number) => emotes.push(kind),
      emotes,
    };
    Pika.onMapEntered(w);
    return w;
  }
  function tick(w: any, n: number): void {
    for (let i = 0; i < n; i++) {
      Pika.findFollower(w)?.update();
      Pika.updateFollower(w, () => 0);
    }
  }

  test.skipIf(!hasYellow)("it hops onto the Pokemon Center counter as the party goes in", () => {
    const w = pikaWorld("up");
    const npc = Pika.findFollower(w)!;
    npc.cellY = 6; npc.py = 96; // one below the player
    let done = false;
    Pika.hopToCounter(w, () => { done = true; });
    tick(w, 16);
    expect(npc.lift).toBeGreaterThan(5); // mid-arc
    tick(w, 20);
    expect(done).toBe(true);
    expect([npc.cellX, npc.cellY, npc.lift]).toEqual([5, 4, 0]);
    // standing above the player it has no hop
    const w2 = pikaWorld("up");
    Pika.findFollower(w2)!.cellY = 4;
    let done2 = false;
    Pika.hopToCounter(w2, () => { done2 = true; });
    expect(done2).toBe(true);
    // and the nurse's rows carry the hop between her two lines
    const rows = nurseGreetScript("TEXT_VIRIDIANPOKECENTER_NURSE")!.map((r) => r[0]);
    expect(rows.indexOf("pikachu_counter_hop")).toBeGreaterThan(rows.indexOf("show_text"));
    expect(rows.indexOf("pikachu_counter_hop")).toBeLessThan(rows.indexOf("heal_party"));
  });

  test.skipIf(!hasYellow)("in Bill's house it wanders off confused, watches the machine, and is startled by Bill", () => {
    const w = pikaWorld("up");
    Pika.enterBillsHouse(w);
    tick(w, 5 * 17);
    const npc = Pika.findFollower(w)!;
    expect([npc.cellX, npc.cellY]).toEqual([8, 4]);
    expect(npc.parked).toBe(true);
    expect(w.emotes).toEqual([2]); // ?
    Pika.billsBeat(w, "enter");
    tick(w, 3 * 17);
    expect([npc.cellX, npc.cellY, npc.facing]).toEqual([8, 1, "up"]);
    Pika.billsBeat(w, "exit");
    expect(npc.facing).toBe("left");
    expect(w.emotes).toEqual([2, 2, 1]);
    // the player's next step sends it after them again
    w.player.targetX = 5; w.player.targetY = 6;
    tick(w, 1);
    expect(npc.parked).toBe(false);
    // not once Bill has been met
    const met = pikaWorld("up");
    met.save.flags.EVENT_GOT_SS_TICKET = true;
    Pika.enterBillsHouse(met);
    expect(met.pikaBillsPending).toBeFalsy();
  });

  test.skipIf(!hasYellow)("Jigglypuff's song puts it to sleep; the nurses' Chansey answers", () => {
    useScriptsFor("yellow");
    const pewter = mapScript("PEWTER_POKECENTER")!.talk!;
    expect((pewter.TEXT_PEWTERPOKECENTER_JIGGLYPUFF as unknown[][]).at(-1)).toEqual(["pikachu_bills", "park"]);
    expect(pewter.TEXT_PEWTERPOKECENTER_COOLTRAINER_F).toContainEqual(["show_text", "_PewterPokecenterText3"]);
    const w = pikaWorld("up");
    Pika.billsBeat(w, "park");
    expect(Pika.findFollower(w)!.parked).toBe(true);
    w.player.targetX = 5; w.player.targetY = 6;
    tick(w, 2);
    expect(Pika.findFollower(w)!.parked).toBe(true); // asleep for the visit
    expect(chanseyScript("TEXT_CERULEANPOKECENTER_CHANSEY")).toEqual([
      ["show_text", "_NurseChanseyText"], ["play_cry", "CHANSEY"],
    ]);
    expect(chanseyScript("TEXT_CERULEANPOKECENTER_NURSE")).toBeNull();
  });

  test.skipIf(!hasYellow)("the Game Corner grunt walks round you, and Pikachu steps out of his way", () => {
    const game = withPikachu("GAME_CORNER", 10, 5, "left");
    const ow = game.overworld as any;
    const pika = findFollower(ow)!;
    pika.cellX = 10; pika.cellY = 6; pika.px = 160; pika.py = 96;
    const rows = (mapScript("GAME_CORNER")!.talk!.TEXT_GAMECORNER_ROCKET as any)(ow) as unknown[][];
    const walk = rows.find((r) => r[0] === "walk_npc")!;
    expect(walk[2]).toEqual(["down", "right", "right", "right", "up", "right", "right", "right"]);
    // the aftermath alone: no battle to fight here
    const after = rows.filter((r) => r[0] === "pikachu_step_aside" || r[0] === "walk_npc");
    ow.runner.run(after, {});
    for (let t = 0; t < 600 && ow.runner.isRunning(); t++) game.tick(0);
    expect(ow.runner.isRunning()).toBe(false);
    const grunt = ow.findNpc("GAMECORNER_ROCKET");
    expect([grunt.cellX, grunt.cellY]).toEqual([15, 5]);
    expect([pika.cellX, pika.cellY]).toEqual([11, 5]);
    // and it looks down as the step ends (its idle glances resume after)
    const w = pikaWorld("left");
    const f = Pika.findFollower(w)!;
    f.cellY = 6; f.py = 96;
    let faced = "";
    Pika.stepAsideIf(w, "down", ["right", "up"], "down", () => { faced = f.facing; });
    tick(w, 40);
    expect([f.cellX, f.cellY, faced]).toEqual([6, 5, "down"]);
    // from below him or on his left, straight along his row, and no Pikachu step
    const below = (mapScript("GAME_CORNER")!.talk!.TEXT_GAMECORNER_ROCKET as any)({ player: { cellX: 9, cellY: 6 } });
    expect(below.find((r: unknown[]) => r[0] === "walk_npc")[2]).toEqual(["right", "right", "right", "right", "right"]);
    expect(below.some((r: unknown[]) => r[0] === "pikachu_step_aside")).toBe(false);
    expect(below).toContainEqual(["show_text", "_GameCornerRocketAfterBattleText"]);
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

describe("Yellow: rules it changed", () => {
  test.skipIf(!hasYellow)("the Safari Zone takes what you have: a ball per 23 plus one", () => {
    const game = newYellowGame();
    const ow = game.overworld as any;
    game.save.money = 230;
    ow.setMap("SAFARI_ZONE_GATE", 3, 3, "up");
    ow.showMapText("TEXT_SAFARIZONEGATE_SAFARI_ZONE_WORKER1");
    playOut(game);
    expect(game.save.money).toBe(0);
    expect((game.save as any).safari?.balls).toBe(11);
  });

  test.skipIf(!hasYellow)("broke, you are turned away three times, then let in with one ball", () => {
    const game = newYellowGame();
    const ow = game.overworld as any;
    game.save.money = 0;
    for (let i = 0; i < 3; i++) {
      ow.setMap("SAFARI_ZONE_GATE", 3, 3, "up");
      ow.showMapText("TEXT_SAFARIZONEGATE_SAFARI_ZONE_WORKER1");
      playOut(game);
      expect((game.save as any).safari ?? null).toBeNull();
    }
    ow.setMap("SAFARI_ZONE_GATE", 3, 3, "up");
    ow.showMapText("TEXT_SAFARIZONEGATE_SAFARI_ZONE_WORKER1");
    playOut(game);
    expect((game.save as any).safari?.balls).toBe(1);
  });

  test.skipIf(!hasYellow)("a Cinnabar gate trainer lectures until his quiz is tried", () => {
    const game = newYellowGame();
    const ow = game.overworld as any;
    game.save.party.push(newMon(yellow!, "PIKACHU", 80, game.battleRng));
    ow.setMap("CINNABAR_GYM", 18, 3, "down");
    ow.showMapText("TEXT_CINNABARGYM_SUPER_NERD2", ow.findNpc("CINNABARGYM_SUPER_NERD2"));
    playOut(game);
    expect(game.stackKinds()).not.toContain("battle");
    expect(ow.findNpc("CINNABARGYM_SUPER_NERD2") && ow.trainerDefeated(ow.findNpc("CINNABARGYM_SUPER_NERD2"))).toBe(false);
    game.save.flags.EVENT_CINNABAR_GYM_GATE0_UNLOCKED = true;
    ow.showMapText("TEXT_CINNABARGYM_SUPER_NERD2", ow.findNpc("CINNABARGYM_SUPER_NERD2"));
    let fought = false;
    for (let t = 0; t < 30000; t++) {
      if (game.battleView()) fought = true;
      if (fought && game.stackKinds().at(-1) === "overworld" && !ow.runner.isRunning()) break;
      game.tick(t % 2 === 0 ? VOX_BTN.a : 0);
    }
    expect(fought).toBe(true);
  });
});


describe("EVENT POKéMON in Yellow: the SURFING PIKACHU", () => {
  test.skipIf(!hasYellow)("the desk hands over MEW and a PIKACHU that knows SURF, so the beach opens", () => {
    const game = newYellowGame();
    const ow = game.overworld as any;
    game.save.options = { ...(game.save.options ?? {}), eventPokemon: true };
    const rows = cableClubScript("VIRIDIAN_POKECENTER_LINK_RECEPTIONIST", game.save, yellow)!;
    const gifts = rows.filter((r) => r[0] === "give_pokemon").map((r) => r[1]);
    expect(gifts).toEqual(["MEW", "PIKACHU"]);
    expect(surfingPikachuInParty(game.save as never)).toBe(false);
    ow.runner.run(rows.slice(0, rows.findIndex((r, i) => i > 0 && r[0] === "face_player")));
    playOut(game);
    const surfer = [...game.save.party, ...((game.save as any).boxes ?? []).flat()]
      .find((m: any) => m.species === "PIKACHU" && m.moves.some((mv: any) => mv.id === "SURF"));
    expect(surfer).toBeDefined();
    expect(surfer.otName).toBe("GF");
    expect(game.save.flags[EVENT_SURF_PIKACHU_FLAG]).toBe(true);
    if (game.save.party.includes(surfer)) expect(surfingPikachuInParty(game.save as never)).toBe(true);
    // once per save
    expect(cableClubScript("VIRIDIAN_POKECENTER_LINK_RECEPTIONIST", game.save, yellow)!
      .some((r) => r[0] === "give_pokemon")).toBe(false);
  });
});
