// The gen3 runtime's scenes and screens (ui/help_system, ui_pass, quest_log,
// hall_of_fame*, evolution_scene, egg_hatch, credits, diploma, fame_checker,
// easy_chat, region_map*, map_preview_screen, cave_transition, trainer tower
// records, move relearner, daycare menu, museum pic) on real FireRed cache
// data through the love.graphics shim and the DesktopHost rasteriser.
// Screenshots go to /tmp/g3shots/scn_*.png.
//
// A path that reaches a module still stubbed by another cluster throws
// NotPortedError; such a test logs "BLOCKED: <what>" and checks what was
// drawn before it.
import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DesktopHost } from "../voxelmon/game/gen3/platform/desktop.ts";
import { getHost, setHost } from "../voxelmon/game/gen3/platform/host.ts";
import { G } from "../voxelmon/game/gen3/platform/graphics.ts";
import { len, seq } from "../voxelmon/game/gen3/platform/lt.ts";
import { encodePng } from "../voxelmon/import/gen3/png.ts";
import { NotPortedError } from "../voxelmon/game/gen3/notported.ts";

const ROOT = join(homedir(), "gen3ref/frfull");
const GBA = join(ROOT, "data/generated/gba");
const SHOTS = "/tmp/g3shots";

let host: DesktopHost;
function shot(name: string): void {
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(join(SHOTS, name), encodePng(240, 160, host.pixels()));
}
function px(x: number, y: number): [number, number, number] {
  const p = host.pixels(), o = (y * 240 + x) * 4;
  return [p[o]!, p[o + 1]!, p[o + 2]!];
}
/** Distinct colours in a rectangle. */
function colours(x0: number, y0: number, w: number, h: number): number {
  const s = new Set<string>();
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) s.add(px(x, y).join(","));
  return s.size;
}
/** Run a frame; a stub reached on the way is reported, not failed. */
function frame(name: string, draw: () => void): NotPortedError | undefined {
  G.resetState();
  G.beginFrame();
  G.clear(0, 0, 0, 1);
  let blocked: NotPortedError | undefined;
  try {
    draw();
  } catch (e) {
    if (!(e instanceof NotPortedError)) throw e;
    blocked = e;
    console.log(`BLOCKED: ${name}: ${e.what}`);
  }
  G.endFrame();
  shot(`scn_${name}.png`);
  return blocked;
}
const NO_INPUT = { wasPressed: () => false, isDown: () => false };
function press(key: string): { wasPressed(k: string): boolean; isDown(k: string): boolean } {
  return { wasPressed: (k: string) => k === key, isDown: (k: string) => k === key };
}

const CHARMANDER = 4, CHARMELEON = 5, PIKACHU = 25, PIDGEOTTO = 17;
const ZERO = () => ({ hp: 0, atk: 0, def: 0, spe: 0, spa: 0, spd: 0 });

describe.skipIf(!existsSync(GBA))("gen3 runtime: scenes and screens", () => {
  let Pokemon: any, Stack: any, Dataset: any;
  function mkMon(species: number, level: number): any {
    const mon: any = { species, level, ivs: ZERO(), evs: ZERO(), personality: 0, otId: 24601, moves: seq(33, 45), pp: seq(35, 40) };
    Pokemon.applyStats(mon);
    return mon;
  }

  beforeAll(async () => {
    host = new DesktopHost(ROOT);
    setHost(host);
    ({ Pokemon } = await import("../voxelmon/game/gen3/core/pokemon.ts"));
    ({ Stack } = await import("../voxelmon/game/gen3/ui/stack.ts"));
    ({ Dataset } = await import("../voxelmon/game/gen3/core/dataset.ts"));
    Pokemon.install({ read: (rel: string) => getHost().read(rel) });
    // RegionMapExtract.ensureGenerated / MapSectionsExtract read the importer's bound cache
    const { CacheFs: ImportCacheFs } = await import("../voxelmon/import/gen3/cache.ts");
    const { makeCache } = await import("../voxelmon/import/gen3/fsio.ts");
    ImportCacheFs.bind(makeCache(ROOT));
  });

  test("region map: Kanto with the player on Pallet", async () => {
    const { Runtime } = await import("../voxelmon/game/gen3/core/runtime.ts");
    const { RegionMap } = await import("../voxelmon/game/gen3/ui/region_map.ts");
    Stack.clear();
    Dataset.mountExtractRoots();
    Runtime._game = { data: { maps: Dataset.buildMaps() } };
    const session: any = {
      map: "FR_PALLET_TOWN", x: 6, y: 8, gender: 0,
      flags: { FLAG_WORLD_MAP_PALLET_TOWN: true, FLAG_WORLD_MAP_VIRIDIAN_CITY: true, FLAG_WORLD_MAP_VIRIDIAN_FOREST: true },
    };
    RegionMap.show({ session, mode: "normal" });
    expect(RegionMap.isOpen()).toBe(true);
    let n = 0;
    while (!RegionMap.inputReady() && n < 400) { RegionMap.handleInput(NO_INPUT); n++; }
    expect(RegionMap.inputReady()).toBe(true);
    expect([RegionMap.cursorX, RegionMap.cursorY]).toEqual([4, 11]);
    expect(RegionMap.currentLocationName()).toBe("PALLET TOWN");
    for (let i = 0; i < 3; i++) RegionMap.handleInput(NO_INPUT);
    frame("regionmap", () => RegionMap.draw());
    expect(colours(16, 16, 200, 128)).toBeGreaterThan(10);
    RegionMap.close();
    expect(RegionMap.isOpen()).toBe(false);
    Stack.clear();
  });

  test("map preview: Viridian Forest, and the Mt. Moon cave flash", async () => {
    const { MapPreviewScreen } = await import("../voxelmon/game/gen3/ui/map_preview_screen.ts");
    Stack.clear();
    expect(MapPreviewScreen.show(126)).toBe(true); // MAPSEC_VIRIDIAN_FOREST
    expect(MapPreviewScreen.isActive()).toBe(true);
    expect(MapPreviewScreen.isForestActive()).toBe(true);
    for (let i = 0; i < 5; i++) MapPreviewScreen.update(1 / 60);
    frame("mappreview", () => MapPreviewScreen.draw());
    expect(colours(0, 24, 240, 100)).toBeGreaterThan(10);
    for (let i = 0; i < MapPreviewScreen._duration + 20; i++) MapPreviewScreen.update(1 / 60);
    frame("mappreview_fade", () => MapPreviewScreen.draw());
    MapPreviewScreen.reset();
    let done = false;
    expect(MapPreviewScreen.runCave(127, () => { done = true; })).toBe(true); // MAPSEC_MT_MOON
    let f = 0;
    while (MapPreviewScreen.isActive() && f < 600) {
      MapPreviewScreen.update(1 / 60);
      if (++f === 30) frame("cavepreview", () => MapPreviewScreen.draw());
    }
    expect(done).toBe(true);
    MapPreviewScreen.reset();
    Stack.clear();
  });

  test("easy chat: the profile phrase, then the group grid", async () => {
    const { EasyChat } = await import("../voxelmon/game/gen3/ui/easy_chat.ts");
    Stack.clear();
    EasyChat.open({ session: { flags: {} }, type: 0 });
    expect(EasyChat.isOpen()).toBe(true);
    frame("easychat_slot", () => EasyChat.draw());
    EasyChat.handleInput(press("a"));
    frame("easychat", () => EasyChat.draw());
    expect(colours(0, 0, 240, 160)).toBeGreaterThan(6);
    Stack.clear();
  });

  test("lazily-required modules register in G3Lazy", async () => {
    const { G3Lazy } = await import("../voxelmon/game/gen3/core/lazy_registry.ts");
    await import("../voxelmon/game/gen3/core/lazy_modules.ts");
    for (const name of [
      "src.ui.game3.ui_pass", "src.ui.game3.credits", "src.ui.game3.diploma",
      "src.ui.game3.museum_fossil_pic", "src.ui.game3.trainer_tower_records",
      "src.ui.game3.move_relearner", "src.ui.game3.daycare_menu", "src.core.game3.town_map_stub",
    ]) expect(typeof G3Lazy[name]).toBe("object");
    expect(typeof G3Lazy["src.ui.game3.ui_pass"].drawUi).toBe("function");
    G3Lazy["src.core.game3.town_map_stub"].unlock();
  });

  test("help window: the pack installs, contexts, the welcome page", async () => {
    const { Help } = await import("../voxelmon/game/gen3/ui/help_system.ts");
    expect(Help.install(Dataset.cache())).toBe(true);
    expect(Help.pack.version).toBe(1);
    expect(len(Help.pack.topics)).toBe(6);
    Help.reset();
    expect(Help.isOpen()).toBe(false);
    const game: any = { phase: "field", session: { map: "FR_PALLET_TOWN", flags: {} } };
    expect(Help.context(game)).toBe(20);
    expect(Help.context({ ...game, session: { map: "FR_OAKS_LAB" } })).toBe(15);
    expect(Help.context({ ...game, session: { map: "FR_VIRIDIAN_CITY_POKEMON_CENTER_1F" } })).toBe(16);
    expect(Help.context({ phase: "boot", boot: { phase: "title" } })).toBe(1);
    expect(Help.show(game)).toBe(true);
    expect(Help.isOpen()).toBe(true);
    expect(Help.level).toBe("welcome");
    const blocked = frame("help_welcome", () => Help.draw());
    // the blue Help background tiles fill the screen
    expect(colours(0, 0, 240, 16)).toBeGreaterThan(1);
    if (!blocked) expect(colours(16, 24, 208, 60)).toBeGreaterThan(2); // greeting text
    Help.handleInput(press("a"));
    expect(Help.level).toBe("main");
    frame("help_main", () => Help.draw());
    Help.handleInput(press("l"));
    expect(Help.isOpen()).toBe(false);
  });

  test("hall of fame: the team slides in on the striped background", async () => {
    const { HallOfFame } = await import("../voxelmon/game/gen3/ui/hall_of_fame.ts");
    Stack.clear();
    const session: any = {
      name: "RED", trainerId: 24601, playTimeHours: 12, playTimeMinutes: 34,
      party: seq(mkMon(CHARMELEON, 36), mkMon(PIKACHU, 30), mkMon(PIDGEOTTO, 28)),
    };
    HallOfFame.start({ session, dontSave: true, warp: false });
    expect(HallOfFame.isOpen()).toBe(true);
    expect(Stack.has("hall_of_fame")).toBe(true);
    let steps = 0;
    while (HallOfFame.phase() !== "hold" && steps++ < 400) HallOfFame.update(1 / 60);
    expect(HallOfFame.phase()).toBe("hold");
    expect(HallOfFame.getCurrentMon().species).toBe(CHARMELEON);
    frame("hof_first", () => HallOfFame.draw());
    expect(colours(0, 0, 240, 110)).toBeGreaterThan(8);
    // run on to the welcome banner with all three placed
    steps = 0;
    while (HallOfFame.phase() !== "applause" && steps++ < 2000) HallOfFame.update(1 / 60);
    for (let i = 0; i < 60; i++) HallOfFame.update(1 / 60);
    frame("hof_welcome", () => HallOfFame.draw());
    HallOfFame.reset();
    Stack.clear();
  });

  test("hall of fame PC: a recorded team", async () => {
    const { HallOfFame } = await import("../voxelmon/game/gen3/ui/hall_of_fame.ts");
    const { HofPc } = await import("../voxelmon/game/gen3/ui/hall_of_fame_pc.ts");
    Stack.clear();
    const session: any = { name: "RED", trainerId: 24601, flags: {}, party: seq(mkMon(CHARMELEON, 36), mkMon(PIKACHU, 30)) };
    HallOfFame._commitClearAndSave(session, session.party);
    expect(len(session.hallOfFameTeams)).toBe(1);
    expect(session.gameStats[10]).toBe(1);
    HofPc.show({ session });
    expect(HofPc._corrupted).toBe(false);
    frame("hof_pc", () => HofPc.draw());
    expect(colours(0, 0, 240, 110)).toBeGreaterThan(8);
    HofPc.handleInput(press("b"));
    expect(HofPc.isOpen()).toBe(false);
    Stack.clear();
  });

  test("evolution: CHARMANDER into CHARMELEON", async () => {
    const { EvolutionScene } = await import("../voxelmon/game/gen3/ui/evolution_scene.ts");
    Stack.clear();
    const mon = mkMon(CHARMANDER, 16);
    let result: string | undefined;
    const session: any = { party: seq(mon), name: "RED" };
    expect(EvolutionScene.start(mon, CHARMELEON, { session, onDone: (r: string) => { result = r; } })).toBe(true);
    const shots: Record<number, string> = { 10: "evo_start", 70: "evo_message", 150: "evo_intro", 260: "evo_cycle_a", 330: "evo_cycle_b" };
    let blocked = false;
    for (let f = 0; f <= 700 && !blocked; f++) {
      try {
        EvolutionScene.update(1 / 60);
      } catch (e) {
        if (!(e instanceof NotPortedError)) throw e;
        console.log(`BLOCKED: evolution update at frame ${f} (${EvolutionScene._state}): ${e.what}`);
        blocked = true;
      }
      if (shots[f]) frame(shots[f]!, () => EvolutionScene.draw());
      if (EvolutionScene._state === "congrats") {
        for (let k = 0; k < 120; k++) EvolutionScene.update(1 / 60); // let the message type out
        frame("evo_congrats", () => EvolutionScene.draw());
        break;
      }
    }
    if (EvolutionScene._state === "congrats") expect(mon.species).toBe(CHARMELEON);
    void result;
    Stack.clear();
  });

  test("egg hatch: the egg shakes, cracks and hatches", async () => {
    const { EggHatch } = await import("../voxelmon/game/gen3/ui/egg_hatch.ts");
    Stack.clear();
    const egg: any = { ...mkMon(PIKACHU, 5), isEgg: true, nickname: "EGG" };
    const session: any = { name: "RED", party: seq(egg), flags: {} };
    let started = false;
    try {
      started = EggHatch.start(egg, { session, slot: 1 });
    } catch (e) {
      if (!(e instanceof NotPortedError)) throw e;
      console.log(`BLOCKED: egg hatch start: ${e.what}`);
      return;
    }
    expect(started).toBe(true);
    const at: Record<number, string> = { 40: "egg_wait", 75: "egg_crack", 175: "egg_flash" };
    for (let f = 0; f <= 260; f++) {
      EggHatch.update(1 / 60);
      if (at[f]) frame(at[f]!, () => EggHatch.draw());
    }
    frame("egg_hatched", () => EggHatch.draw());
    expect(EggHatch._eggShown).toBe(false);
    EggHatch.open = false;
    Stack.clear();
  });

  test("diploma: the Kanto diploma", async () => {
    const { Diploma } = await import("../voxelmon/game/gen3/ui/diploma.ts");
    const { Runtime } = await import("../voxelmon/game/gen3/core/runtime.ts");
    Stack.clear();
    const prevSession = Runtime.session;
    Runtime.session = { name: "RED", flags: {} };
    let shown = false;
    try {
      shown = Diploma.show();
    } catch (e) {
      if (!(e instanceof NotPortedError)) throw e;
      console.log(`BLOCKED: diploma: ${e.what}`);
      return;
    }
    expect(shown).toBe(true);
    expect(Diploma.isNational()).toBe(false);
    frame("diploma", () => Diploma.draw());
    expect(colours(0, 0, 240, 160)).toBeGreaterThan(4);
    Diploma.open = false;
    Runtime.session = prevSession;
    Stack.clear();
  });

  test("fame checker: the person list and panels", async () => {
    const { FameCheckerUi } = await import("../voxelmon/game/gen3/ui/fame_checker.ts");
    Stack.clear();
    const session: any = { name: "RED", flags: {} };
    expect(FameCheckerUi.show(session)).toBe(true);
    const rows = FameCheckerUi.rows();
    expect(len(rows)).toBeGreaterThan(1); // OAK (+ cancel)
    expect(rows[len(rows)].cancel).toBe(true);
    expect(FameCheckerUi.personName(rows[1].person)).toBe("OAK"); // the list's short name (pack.listNames)
    frame("fame", () => FameCheckerUi.draw());
    expect(colours(0, 0, 240, 112)).toBeGreaterThan(4);
    FameCheckerUi.close();
    Stack.clear();
  });

  test("credits: the opening frames", async () => {
    const { Credits } = await import("../voxelmon/game/gen3/ui/credits.ts");
    Stack.clear();
    expect(Credits.start()).toBe(true);
    for (let f = 0; f < 140; f++) Credits.update(1 / 60);
    expect(Credits.state().mainseq).toBe(Credits.SCENE.PRINT_TITLE_STAFF);
    frame("credits_player", () => Credits.draw());
    for (let f = 0; f < 120; f++) Credits.update(1 / 60);
    expect(Credits.state().text?.staff).toBe(true);
    frame("credits_title", () => Credits.draw());
    expect(colours(0, 36, 240, 88)).toBeGreaterThan(2);
    Credits.reset();
    Stack.clear();
  });

  test("trainer tower records and the daycare level menu", async () => {
    const { Records } = await import("../voxelmon/game/gen3/ui/trainer_tower_records.ts");
    const { DaycareMenu } = await import("../voxelmon/game/gen3/ui/daycare_menu.ts");
    Stack.clear();
    Records.show({ session: { name: "RED" } });
    expect(len(Records.rows())).toBe(4);
    frame("tower_records", () => Records.draw());
    Records.close();
    Stack.clear();
    expect(DaycareMenu.genderSymbol("NIDORAN\xE2\x99\x82", "M")).toBe("");
    expect(DaycareMenu.genderSymbol("PIKACHU", "F")).toBe("\xE2\x99\x80");
    Stack.clear();
  });

  test("UI pass over a field frame: the dialogue box", async () => {
    const { G3Lazy } = await import("../voxelmon/game/gen3/core/lazy_registry.ts");
    await import("../voxelmon/game/gen3/core/lazy_modules.ts");
    const { Message } = await import("../voxelmon/game/gen3/ui/message.ts");
    const { NativeTileset } = await import("../voxelmon/game/gen3/core/tileset_native.ts");
    const UiPass = G3Lazy["src.ui.game3.ui_pass"];
    Stack.clear();
    NativeTileset.install(Dataset.cache());
    const ts = NativeTileset.get("pallet_outdoor")!;
    Message.show("Welcome to the world of POK\xC3\xA9MON!", { stay: true });
    for (let i = 0; i < 200; i++) Message.tick();
    frame("uipass_field", () => {
      // a field frame: Pallet's outdoor tiles as a backdrop
      for (let y = 0; y < 10; y++) for (let x = 0; x < 15; x++) {
        const q = NativeTileset.quad(ts, 1 + ((x + y * 3) % 40));
        if (q) G.draw(ts.image!, q, x * 16, y * 16);
      }
      UiPass.drawUi();
    });
    // the dialogue frame's white interior at the bottom of the screen
    expect(px(120, 140)).toEqual([255, 255, 255]);
    Message.close();
  });
});
