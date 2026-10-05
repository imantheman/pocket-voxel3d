// The field-misc cluster on real FireRed cache data through the DesktopHost
// rasteriser: camera_object, field_weather, pokecenter_heal and the elevator
// natives over a real field; the in-game trade (natives_trade + the trade
// scene core and UI), the move tutor and daycare natives; the slot machine,
// prize corner and Teachy TV; the small natives. Screenshots go to
// /tmp/g3shots/fms_*.png.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DesktopHost } from "../voxelmon/game/gen3/platform/desktop.ts";
import { setHost, getHost } from "../voxelmon/game/gen3/platform/host.ts";
import { G } from "../voxelmon/game/gen3/platform/graphics.ts";
import { seq } from "../voxelmon/game/gen3/platform/lt.ts";
import { encodePng } from "../voxelmon/import/gen3/png.ts";
import { Pokemon } from "../voxelmon/game/gen3/core/pokemon.ts";
import { Party } from "../voxelmon/game/gen3/core/party.ts";
import { Runtime } from "../voxelmon/game/gen3/core/runtime.ts";
import { Ctx } from "../voxelmon/game/gen3/core/scripting/ctx.ts";
import { Flags } from "../voxelmon/game/gen3/core/scripting/flags.ts";
import { Trade } from "../voxelmon/game/gen3/core/scripting/natives_trade.ts";
import { MoveTeach } from "../voxelmon/game/gen3/core/scripting/natives_moveteach.ts";
import { Daycare } from "../voxelmon/game/gen3/core/scripting/natives_daycare.ts";
import { TradeScene } from "../voxelmon/game/gen3/core/trade_scene.ts";
import { TradeSceneUi } from "../voxelmon/game/gen3/ui/trade_scene.ts";
import { SlotMachine } from "../voxelmon/game/gen3/core/slot_machine.ts";
import { SlotMachineUi } from "../voxelmon/game/gen3/ui/slot_machine.ts";
import { PrizeCorner } from "../voxelmon/game/gen3/ui/prize_corner.ts";
import { Ui as TeachyTvUi } from "../voxelmon/game/gen3/ui/teachy_tv.ts";
import { Fade } from "../voxelmon/game/gen3/ui/fade.ts";
import { Audio } from "../voxelmon/game/gen3/core/audio.ts";
import { G3Lazy } from "../voxelmon/game/gen3/core/lazy_registry.ts";
import { len } from "../voxelmon/game/gen3/platform/lt.ts";
import { CacheFs as ImportCacheFs } from "../voxelmon/import/gen3/cache.ts";
import { makeCache } from "../voxelmon/import/gen3/fsio.ts";
import { Profile } from "../voxelmon/game/gen3/core/profile.ts";
import { FieldModules } from "../voxelmon/game/gen3/core/field_modules.ts";
import { Dataset } from "../voxelmon/game/gen3/core/dataset.ts";
import { Game3 } from "../voxelmon/game/gen3/core/Game3.ts";
import { FieldView } from "../voxelmon/game/gen3/core/field_view.ts";
import { Objects } from "../voxelmon/game/gen3/core/objects.ts";
import { Weather } from "../voxelmon/game/gen3/core/weather.ts";
import { Space } from "../voxelmon/game/gen3/core/scripting/space.ts";
import { Natives } from "../voxelmon/game/gen3/core/scripting/natives.ts";
import { CameraObject } from "../voxelmon/game/gen3/core/camera_object.ts";
import { FieldWeather } from "../voxelmon/game/gen3/core/field_weather.ts";
import { PokecenterHeal } from "../voxelmon/game/gen3/core/pokecenter_heal.ts";
import { PokedexRating } from "../voxelmon/game/gen3/core/pokedex_rating.ts";
import { Elevator } from "../voxelmon/game/gen3/core/scripting/natives_elevator.ts";
import { ListMenu } from "../voxelmon/game/gen3/core/scripting/natives_listmenu.ts";
import { ElevatorWindow } from "../voxelmon/game/gen3/ui/elevator_window.ts";
import { Seagallop as SeagallopNatives } from "../voxelmon/game/gen3/core/scripting/natives_seagallop.ts";
import { Fame } from "../voxelmon/game/gen3/core/scripting/natives_fame.ts";
import { FanClub } from "../voxelmon/game/gen3/core/scripting/natives_fan_club.ts";
import { SizeRecordNatives } from "../voxelmon/game/gen3/core/scripting/natives_size_record.ts";
import { TowerNatives } from "../voxelmon/game/gen3/core/scripting/natives_tower.ts";
import { Cutscene } from "../voxelmon/game/gen3/core/scripting/natives_cutscene.ts";

const ROOT = join(homedir(), "gen3ref/frfull");
const GBA = join(ROOT, "data/generated/gba");
const SHOTS = "/tmp/g3shots";

function shot(host: DesktopHost, name: string): void {
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(join(SHOTS, name), encodePng(240, 160, host.pixels()));
}
function sum(host: DesktopHost): number {
  return host.pixels().reduce((a, v) => a + v, 0);
}

const VAR_RESULT = 0x800D;
const VAR_0x8004 = 0x8004;
const VAR_0x8005 = 0x8005;
const VAR_0x8006 = 0x8006;
const VAR_0x8007 = 0x8007;

// One host for the file: describe bodies all run before any test does.
const host = existsSync(GBA) ? new DesktopHost(ROOT) : (undefined as unknown as DesktopHost);
if (host) setHost(host);

describe.skipIf(!existsSync(GBA))("gen3 field misc: in-game trade, move tutors, daycare", () => {
  Pokemon.install({ read: (rel: string) => getHost().read(rel) });

  test("in-game trade 0 (ABRA for MR. MIME 'MIMIEN'): natives, scene frames, party swap", () => {
    const session: any = { name: "RED", trainerId: 12345, party: seq(), store: { flags: {}, vars: {} } };
    Party.giveMon(session, 63, 12); // ABRA, the species trade 0 asks for
    Runtime.session = session;
    const ctx: any = Ctx.new({ playerName: "RED" });
    Flags.setVar(undefined, ctx, VAR_0x8004, 0); // trade index
    Flags.setVar(undefined, ctx, VAR_0x8005, 0); // party slot

    // the trade table and the script's info special
    expect(Trade.entry(0).species).toBe(122);
    expect(Trade.TRADES[0].nickname).toBe("MIMIEN");
    expect(Trade.BY_NAME.GetInGameTradeSpeciesInfo!(ctx, undefined)).toEqual([false, 63]);
    expect(ctx.stringVars[1]).toBe("ABRA");
    expect(ctx.stringVars[2]).toBe("MR. MIME");
    expect(Trade.BY_NAME.GetTradeSpecies!(ctx, undefined)).toEqual([false, 63]);
    expect(Trade.canTradeSelectedMon(session.party, 0, { nationalDex: false })).toBe(Trade.CANT_TRADE_LAST_MON);

    // CreateInGameTradePokemon builds the partner's mon at the sent mon's level
    expect(Trade.BY_NAME.CreateInGameTradePokemon!(ctx, undefined)).toEqual([false]);
    const offered = Trade._offered;
    expect(offered.species).toBe(122);
    expect(offered.level).toBe(12);
    expect(offered.otName).toBe("REYLEY");
    expect(offered.otId).toBe(1985);
    expect(offered.personality).toBe(40110);
    expect(offered.ivs).toEqual({ hp: 20, atk: 15, def: 17, spe: 24, spa: 23, spd: 22 });
    expect(offered.metLocation).toBe(0xFE);

    // DoInGameTradeScene parks the scene task on the ctx; drive it frame by frame
    expect(Trade.BY_NAME.DoInGameTradeScene!(ctx, undefined)).toEqual([false]);
    expect(typeof ctx.stateWait).toBe("function");
    const shotsAt = new Set([40, 120, 300, 700, 1000, 1300]);
    const phases: string[] = [];
    let frame = 0, done = false, sums: number[] = [];
    while (!done && frame < 6000) {
      frame++;
      Audio.tickCry(1 / 60); // the runtime's per-frame cry clock (runtime.ts:399)
      Fade.tick(1 / 60);
      done = ctx.stateWait();
      const ph = TradeScene.phase();
      if (ph && phases[phases.length - 1] !== ph) phases.push(ph);
      if (ph === "end_link_trade") TradeScene.pressA();
      if (TradeScene.isOpen() && shotsAt.has(frame)) {
        G.beginFrame();
        TradeSceneUi.draw();
        G.endFrame();
        sums.push(sum(host));
        shot(host, `fms_trade_${frame}.png`);
      }
    }
    expect(done).toBe(true);
    expect(TradeScene.isOpen()).toBe(false);
    expect(phases).toContain("gba_zoom_out"); // the cache has the trade art
    expect(phases).toContain("end_link_trade");
    expect(phases[phases.length - 1]).toBe("wait_fade_out_end");
    expect(sums.some((v) => v > 240 * 160 * 255)).toBe(true); // not all black

    // the party slot now holds the traded-in mon
    expect(session.party[1].species).toBe(122);
    expect(session.party[1].nickname).toBe("MIMIEN");
    expect(session.party[1].friendship).toBe(70);
    expect(ctx.stringVars[1]).toBe("MIMIEN");
    expect(ctx.stringVars[2]).toBe("MR. MIME");
    expect(session.dex.seen[122]).toBe(true);
    Runtime.session = undefined;
  }, 60000);

  test("move tutor natives on a real party mon: Cape Brink, deleter, move count", () => {
    const session: any = { name: "RED", trainerId: 12345, party: seq(), store: { flags: {}, vars: {} } };
    const [, , zard] = Party.giveMon(session, 6, 50); // CHARIZARD
    zard.friendship = 255;
    zard.happiness = 255;
    Runtime.session = session;
    const ctx: any = Ctx.new({ playerName: "RED" });

    // CapeBrinkGetMoveToTeachLeadPokemon: lead CHARIZARD at max friendship -> BLAST BURN
    expect(MoveTeach.BY_NAME.CapeBrinkGetMoveToTeachLeadPokemon!(ctx, undefined)).toEqual([false]);
    expect(Flags.getVar(undefined, ctx, VAR_RESULT)).toBe(1);
    expect(Flags.getVar(undefined, ctx, VAR_0x8007)).toBe(0);
    expect(ctx.stringVars[2]).toBe("BLAST BURN");
    const tutor = Flags.getVar(undefined, ctx, VAR_0x8005);
    expect(tutor).toBe(MoveTeachTutorBlastBurn());
    const slots = Pokemon.moveSlotCount(zard);
    expect(Flags.getVar(undefined, ctx, VAR_0x8006)).toBe(slots);

    // HasLearnedAllMovesFromCapeBrinkTutor sets the BLAST BURN flag; not all three yet
    expect(MoveTeach.BY_NAME.HasLearnedAllMovesFromCapeBrinkTutor!(ctx, undefined)).toEqual([false]);
    expect(Flags.getVar(undefined, ctx, VAR_RESULT)).toBe(0);
    expect(Flags.getFlag(session.store, ctx, 0x2DF)).toBe(true);
    // ... so the tutor now declines
    MoveTeach.BY_NAME.CapeBrinkGetMoveToTeachLeadPokemon!(ctx, undefined);
    expect(Flags.getVar(undefined, ctx, VAR_RESULT)).toBe(0);
    // a friendship short of 255: no row
    zard.friendship = 254; zard.happiness = 254;
    MoveTeach.BY_NAME.CapeBrinkGetMoveToTeachLeadPokemon!(ctx, undefined);
    expect(Flags.getVar(undefined, ctx, VAR_RESULT)).toBe(0);

    // Move Deleter: count, buffer the first move, forget it
    Flags.setVar(undefined, ctx, VAR_0x8004, 0);
    Flags.setVar(undefined, ctx, VAR_0x8005, 0);
    MoveTeach.BY_NAME.GetNumMovesSelectedMonHas!(ctx, undefined);
    expect(Flags.getVar(undefined, ctx, VAR_RESULT)).toBe(slots);
    const first = Pokemon.moveName(Pokemon.moveIdAt(zard, 1));
    MoveTeach.BY_NAME.BufferMoveDeleterNicknameAndMove!(ctx, undefined);
    expect(ctx.stringVars[1]).toBe("CHARIZARD");
    expect(ctx.stringVars[2]).toBe(first);
    MoveTeach.BY_NAME.MoveDeleterForgetMove!(ctx, undefined);
    expect(Pokemon.moveSlotCount(zard)).toBe(slots - 1);
    // the special-id table is bound
    expect(MoveTeach.HANDLERS![0x1A3]).toBe(MoveTeach.BY_NAME.CapeBrinkGetMoveToTeachLeadPokemon);
    Runtime.session = undefined;
  });

  test("daycare natives: empty Day Care state, compatibility text", () => {
    const session: any = { name: "RED", party: seq(), store: { flags: {}, vars: {} } };
    Runtime.session = session;
    const ctx: any = Ctx.new({ playerName: "RED" });
    expect(Daycare.BY_NAME.GetDaycareState!(ctx, undefined)).toEqual([false, 0]);
    expect(Daycare.BY_NAME.GetDaycarePokemonCount!(ctx, undefined)).toEqual([false, 0]);
    expect(Daycare.compatibilityText(0).length).toBeGreaterThan(0);
    Runtime.session = undefined;
  });
});

/** An Input stand-in: `key` was pressed this frame (nothing held). */
function press(key?: string): any {
  return { wasPressed: (k: string) => k === key, isDown: () => false };
}

describe.skipIf(!existsSync(GBA))("gen3 field misc: slot machine, prize corner, Teachy TV", () => {

  test("slot machine: bet max, reels spin (frames differ), stop all three, coins settle", () => {
    expect(G3Lazy["src.core.game3.slot_machine"]).toBe(SlotMachine);
    expect(G3Lazy["src.ui.game3.slot_machine"]).toBe(SlotMachineUi);
    // pure rules on Brian's tables
    expect(SlotMachine.iconAt(0, 0)).toBe(SlotMachine.ICON.SEVEN);
    expect(SlotMachine.iconAt(2, 20)).toBe(SlotMachine.ICON.ROCKET);
    expect(SlotMachine.linesForBet(3)).toEqual([null, 0, 1, 2, 3, 4]);
    expect(SlotMachine.linesForBet(1)).toEqual([null, 2]);
    expect(SlotMachine.MACHINE_CLASS_BY_ID[21]).toBe(5);

    const session: any = { coins: 50 };
    const st = SlotMachineUi.show({ session, machineIdx: 0 });
    expect(SlotMachineUi.task).toBe("bet");
    SlotMachineUi.handleInput(press("r")); // BET MAX
    expect(st.bet).toBe(3);
    expect(session.coins).toBe(47);
    expect(SlotMachineUi.task).toBe("spin");
    const positions: string[] = [];
    const draw = (name?: string) => {
      G.beginFrame();
      SlotMachineUi.draw();
      G.endFrame();
      if (name) shot(host, name);
    };
    for (let f = 1; f <= 30; f++) {
      SlotMachineUi.handleInput(press());
      SlotMachineUi.update(1 / 60);
      positions.push(st.reelPositions.join(",") + "/" + st.reelSubpixel.join(","));
      if (f === 6 || f === 7 || f === 20) draw(`fms_slots_spin_${f}.png`);
    }
    expect(SlotMachineUi.task).toBe("stopping");
    expect(new Set(positions).size).toBeGreaterThan(20); // the reels move every frame
    expect(st.reelIsSpinning).toEqual([true, true, true]);
    // stop reel 1, 2, 3 (A each time the current reel is still spinning)
    let frames = 0;
    while (SlotMachineUi.task === "stopping" && frames < 2000) {
      frames++;
      SlotMachineUi.handleInput(press(frames % 20 === 0 ? "a" : undefined));
      SlotMachineUi.update(1 / 60);
    }
    draw("fms_slots_stopped.png");
    expect(["lose", "win"]).toContain(SlotMachineUi.task);
    expect(st.reelIsSpinning).toEqual([false, false, false]);
    const won = st.payout; // calcPayout's total, paid out coin by coin while "win"
    expect(won === 0).toBe(SlotMachineUi.task === "lose");
    // let the round settle back to "bet"
    frames = 0;
    while (SlotMachineUi.task !== "bet" && frames < 3000) {
      frames++;
      SlotMachineUi.handleInput(press());
      SlotMachineUi.update(1 / 60);
    }
    expect(SlotMachineUi.task).toBe("bet");
    expect(session.coins).toBe(47 + won);
    // quit: B, then YES
    SlotMachineUi.handleInput(press("b"));
    expect(SlotMachineUi.task).toBe("quit");
    draw("fms_slots_quit.png");
    SlotMachineUi.handleInput(press("a"));
    for (let f = 0; f < 20 && SlotMachineUi.isOpen(); f++) SlotMachineUi.update(1 / 60);
    expect(SlotMachineUi.isOpen()).toBe(false);
  });

  test("prize corner: the Pokémon prize list drawn once", () => {
    expect(G3Lazy["src.ui.game3.prize_corner"]).toBe(PrizeCorner);
    expect(PrizeCorner.splitLabel("ABRA 180 COINS")).toEqual(["ABRA", "180 COINS"]);
    let chosen: number | undefined;
    const ok = PrizeCorner.show({
      listId: PrizeCorner.LIST_POKEMON_PRIZES,
      labels: seq("ABRA 180 COINS", "CLEFAIRY 500 COINS", "DRATINI 2800 COINS", "SCYTHER 5500 COINS", "PORYGON 9999 COINS", "NO THANKS"),
      left: 0, top: 0,
      onChoose: (r: number) => { chosen = r; },
    });
    expect(ok).toBe(true);
    expect(PrizeCorner.geom!.height).toBe(PrizeCorner.WINDOW_HEIGHT[6]);
    expect(PrizeCorner.wrapAround).toBe(true);
    G.beginFrame();
    G.clear(0, 0, 0, 1);
    PrizeCorner.draw();
    G.endFrame();
    shot(host, "fms_prize_corner.png");
    expect(sum(host)).toBeGreaterThan(0);
    PrizeCorner.handleInput(press("up")); // wraps to NO THANKS
    expect(PrizeCorner.cursor).toBe(6);
    PrizeCorner.handleInput(press("a"));
    expect(chosen).toBe(5);
    expect(PrizeCorner.isOpen()).toBe(false);
  });

  test("Teachy TV: the list's first frames, then the first lesson's opening", () => {
    expect(G3Lazy["src.ui.game3.teachy_tv"]).toBe(TeachyTvUi);
    const session: any = { name: "RED", bag: undefined, party: seq() };
    TeachyTvUi.show(session, undefined, {});
    expect(TeachyTvUi.isOpen()).toBe(true);
    expect(TeachyTvUi.state).toBe("list");
    const draw = (name: string) => {
      G.beginFrame();
      TeachyTvUi.draw();
      G.endFrame();
      shot(host, name);
    };
    for (let f = 1; f <= 3; f++) {
      TeachyTvUi.update(1 / 60);
      Fade.tick(1 / 60);
      draw(`fms_teachy_list_${f}.png`);
    }
    expect(TeachyTvUi.rows()[1].label.length).toBeGreaterThan(0);
    Fade.clear();
    TeachyTvUi.handleInput(press("a")); // the first lesson
    expect(TeachyTvUi.state).toBe("lesson");
    const names: string[] = [];
    for (let f = 1; f <= 400; f++) {
      TeachyTvUi.tick();
      const n = TeachyTvUi.stepName();
      if (n && names[names.length - 1] !== n) names.push(n);
      if (f === 10 || f === 120 || f === 350 || f === 400) draw(`fms_teachy_lesson_${f}.png`);
      if (f === 350) expect(TeachyTvUi.phase).toBe("hello"); // the Pokédude's first page is up
      if (f > 360 && TeachyTvUi.waitingForKey()) TeachyTvUi.handleInput(press("a"));
    }
    expect(names[0]).toBe("transition_render_bg2");
    expect(names.length).toBeGreaterThan(2);
    TeachyTvUi.handleInput(press("b")); // abort to the end card
    TeachyTvUi.finishClose();
    expect(TeachyTvUi.isOpen()).toBe(false);
  });
});

/** pokefirered/include/constants/party_menu.h TUTOR_MOVE_BLAST_BURN (16) */
function MoveTeachTutorBlastBurn(): number {
  return 16;
}

// ------------------------------------------------------------------------
// The lead's share: camera_object, field_weather, pokecenter_heal and the
// elevator natives, drawn over a real field (Dataset.hydrate + Runtime.start
// + FieldView.draw on the DesktopHost).

/** Brian's profile row has a fieldModules block; the union plaza is link
 *  (deferred: its stub throws), so the field is hydrated without it. */
function hydrateWithoutUnionPlaza(game: any): void {
  const row: any = Profile.forSession();
  row.map = row.map || {};
  const fm: any = row.map.fieldModules
    || Object.fromEntries(Object.keys(FieldModules.NAMES).map((n) => [n, FieldModules.enabled(n)]));
  fm.unionPlaza = false;
  row.map.fieldModules = fm;
  Dataset.hydrate(game);
}

describe.skipIf(!existsSync(GBA))("gen3 field misc: camera object, weather, Pokémon Center heal, elevator", () => {
  let game: any;
  let session: any;

  function startOn(map: string, x: number, y: number, facing = "down"): void {
    session = { map, x, y, facing, name: "RED", trainerId: 12345, party: seq(), store: { flags: {}, vars: {} } };
    Runtime.start(undefined, game, session);
  }
  function field(extra?: () => void): void {
    G.beginFrame();
    G.clear(0, 0, 0, 1);
    FieldView.draw(game, 240, 160, {});
    if (extra) extra();
    G.endFrame();
  }
  function pixels(): Uint8Array { return Uint8Array.from(host.pixels()); }
  function diffCount(a: Uint8Array, b: Uint8Array): number {
    let n = 0;
    for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++;
    return n;
  }

  test("setup: hydrate the field and register the lazy modules", () => {
    ImportCacheFs.bind(makeCache(ROOT));
    game = Game3.new();
    hydrateWithoutUnionPlaza(game);
    expect(game.data.maps.FR_ROUTE_1).toBeDefined();
    for (const name of ["camera_object", "field_weather", "pokecenter_heal", "ss_anne_cutscene",
      "league_lighting", "truck_sequence", "fldeff_misc"]) {
      expect(G3Lazy["src.core.game3." + name]).toBeDefined();
    }
    expect(G3Lazy["src.core.game3.scripting.natives_listmenu"]).toBe(ListMenu);
    expect(G3Lazy["src.ui.game3.elevator_window"]).toBe(ElevatorWindow);
  });

  test("camera_object: Runtime.start resets it; spawn, follow (the view pans), remove", () => {
    startOn("FR_ROUTE_1", 10, 10);
    field();
    shot(host, "fms_camera_0.png");
    const base = pixels();
    expect(sum(host)).toBeGreaterThan(0);

    const eo = CameraObject.spawn(game);
    expect(eo).toBeDefined();
    expect((Objects as any)._byId[CameraObject.LOCALID]).toBe(eo);
    expect(eo.hidden).toBe(true);
    expect(CameraObject.isActive()).toBe(true);
    expect(CameraObject.offset()).toEqual([0, 0]);
    // FieldView.draw now goes through the camera-object seam
    expect((FieldView as any)._game3CameraObjectSeam).toBe(true);
    field();
    expect(diffCount(base, pixels())).toBe(0);

    // the camera object walks 3 cells right and 1 up: the view follows it
    eo.px = eo.px + 48;
    eo.py = eo.py - 16;
    expect(CameraObject.offset()).toEqual([48, -16]);
    field();
    shot(host, "fms_camera_follow.png");
    const panned = pixels();
    expect(FieldView.cameraPanX).toBe(0); // restored after the draw
    expect(FieldView.cameraPanY).toBe(0);
    expect(diffCount(base, panned)).toBeGreaterThan(5000);
    // the same frame as an explicit pan by the offset, drawn without the seam
    CameraObject.reset();
    FieldView.cameraPanX = 48;
    FieldView.cameraPanY = -16;
    field();
    FieldView.cameraPanX = 0;
    FieldView.cameraPanY = 0;
    expect(diffCount(panned, pixels())).toBe(0);
    expect(CameraObject.isActive()).toBe(false);
    expect((Objects as any)._byId[CameraObject.LOCALID]).toBeUndefined();

    // RemoveCameraObject through the cutscene native; and Runtime.start's reset
    CameraObject.spawn(game);
    expect(CameraObject.isActive()).toBe(true);
    Natives.handlerFor("RemoveCameraObject")(Ctx.new({}), undefined);
    expect(CameraObject.isActive()).toBe(false);
    CameraObject.spawn(game);
    startOn("FR_ROUTE_1", 10, 10);
    expect(CameraObject.isActive()).toBe(false);
  });

  test("field_weather: rain over Route 1 (no FireRed map header has rain; set like setweather)", () => {
    // header weathers in the cache: 0, SUNNY, FOG_HORIZONTAL, SHADE -- no RAIN
    const ws = new Set(Object.values(game.data.maps).map((d: any) => Number(d.weather)));
    expect(ws.has(Weather.RAIN)).toBe(false);
    startOn("FR_ROUTE_1", 10, 10);
    FieldWeather.setWeather(Weather.NONE);
    field();
    const dry = pixels();
    FieldWeather.setWeather(Weather.RAIN);
    expect(FieldWeather.getWeather()).toBe(Weather.RAIN);
    let peak = 0;
    for (let f = 1; f <= 120; f++) {
      FieldWeather.update(1 / 60);
      peak = Math.max(peak, len(FieldWeather._rainSprites));
      if (f === 30 || f === 120) {
        field();
        shot(host, `fms_rain_${f}.png`);
      }
    }
    expect(peak).toBeGreaterThan(5);
    expect(peak).toBeLessThanOrEqual(24);
    const wet = pixels();
    // Brian's rain is sparse (under 24 drops, most above the screen): each
    // drop on screen is a 2x7 streak, each splash a small ring
    let onscreen = 0;
    for (let i = 1; i <= len(FieldWeather._rainSprites); i++) {
      const d = FieldWeather._rainSprites[i];
      const y = d.state === "falling" ? d.y : d.groundY;
      if (d.x >= 0 && d.x < 240 && y >= 0 && y < 160) onscreen++;
    }
    expect(onscreen).toBeGreaterThan(0);
    expect(diffCount(dry, wet)).toBeGreaterThanOrEqual(6 * onscreen);
    // drops drift left and fall; splashes expire after 6 frames
    const r = FieldWeather._rainSprites[1];
    const [x0, y0] = [r.x, r.y];
    FieldWeather.update(1 / 60);
    if (r.state === "falling") expect([r.x, r.y > y0]).toEqual([x0 - 2, true]);
    // fog: a FOG_HORIZONTAL map scrolls its 64x64 sprite one pixel per 4 frames
    FieldWeather.setWeather(Weather.FOG_HORIZONTAL);
    for (let f = 0; f < 8; f++) FieldWeather.update(1 / 60);
    expect(FieldWeather._fogScrollOffset).toBe(2);
    field();
    shot(host, "fms_fog.png");
    expect(diffCount(dry, pixels())).toBeGreaterThan(10000);
    // a suspended weather (battle) draws nothing
    Weather.suspend();
    field();
    expect(diffCount(dry, pixels())).toBe(0);
    Weather.resume();
    FieldWeather.setWeather(Weather.NONE);
  });

  test("pokecenter_heal: three balls, the monitor, the glow, then done", () => {
    startOn("FR_VIRIDIAN_CITY_POKEMON_CENTER_1F", 7, 4, "up");
    Party.giveMon(session, 25, 10);
    Party.giveMon(session, 1, 10);
    Party.giveMon(session, 4, 10);
    expect(PokecenterHeal._ballScreenTl(0)).toEqual([89, 32]);
    expect(PokecenterHeal._ballScreenTl(5)).toEqual([95, 40]);
    expect(PokecenterHeal._monitorScreenTl()).toEqual([112, 16]);
    expect(PokecenterHeal.start()).toBe(true);
    const fx = PokecenterHeal._fx!;
    expect(fx.remaining).toBe(3);
    const states: number[] = [];
    let frame = 0, sawMonitor = false, sawGlow = false;
    const shots = new Set([1, 30, 60, 120, 150, 200]);
    while (PokecenterHeal.isActive() && frame < 2000) {
      frame++;
      Audio.update(1 / 60);
      PokecenterHeal.step();
      const cur = PokecenterHeal._fx;
      if (!cur) break;
      if (states[states.length - 1] !== cur.state) states.push(cur.state);
      if (cur.monitorVisible) sawMonitor = true;
      if (cur.state === 2 && cur.counter !== 0) sawGlow = true;
      if (frame === 1) expect(len(cur.balls)).toBe(1);
      if (frame === 27) expect(len(cur.balls)).toBe(2);
      if (frame === 52) expect(len(cur.balls)).toBe(3);
      if (shots.has(frame)) {
        field(() => PokecenterHeal.draw(0, 0));
        shot(host, `fms_heal_${frame}.png`);
      }
    }
    // PLACE, WAIT_SE, FLASH_A, FLASH_B, WAIT_AFTER, DUMMY, WAIT_SOUND
    expect(states).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(sawMonitor).toBe(true);
    expect(sawGlow).toBe(true);
    expect(PokecenterHeal.isActive()).toBe(false);
    let waited = false;
    PokecenterHeal.wait(() => { waited = true; });
    expect(waited).toBe(true);
  });

  test("elevator natives in the Celadon department store: floor, window, list menu, ride", () => {
    startOn("FR_CELADON_CITY_DEPARTMENT_STORE_ELEVATOR", 2, 3, "up");
    session.dynamicWarp = { map: "FR_CELADON_CITY_DEPARTMENT_STORE_3F" };
    const ctx: any = Ctx.new({ playerName: "RED" });
    const store = () => (Space as any).store || session.store;
    const v = (id: number) => Flags.getVar(store(), ctx, id);
    const set = (id: number, val: number) => Flags.setVar(store(), ctx, id, val);
    const adapters = {
      elevatorWindow: (label: string) => ElevatorWindow.show(label),
      elevatorWindowClose: () => ElevatorWindow.hide(),
    };
    // the specials the elevator script calls are bound by id (natives.ts NATIVE_FILES)
    Natives.ensureBound();
    expect(Natives.specialName(216)).toBe("GetElevatorFloor");
    expect(Natives.specialName(306)).toBe("DrawElevatorCurrentFloorWindow");
    expect(Natives.specialName(352)).toBe("CloseElevatorCurrentFloorWindow");
    expect(Natives.handlerFor("GetElevatorFloor")).toBe(Elevator.BY_NAME.GetElevatorFloor);

    // special GetElevatorFloor: VAR_ELEVATOR_FLOOR = 6 (3F)
    expect(Natives.special(ctx, 216, adapters)).toEqual([false, undefined, true]);
    expect(v(0x403A)).toBe(6);
    // InitElevatorFloorSelectMenuPos: the cursor on 3F
    const [, cursor] = Natives.handlerFor("InitElevatorFloorSelectMenuPos")(ctx, adapters);
    expect(cursor).toBe(2);
    expect(ListMenu.elevatorScroll).toBe(0);
    // copyvar 0x8005, VAR_ELEVATOR_FLOOR; special DrawElevatorCurrentFloorWindow
    set(0x8005, v(0x403A));
    Natives.special(ctx, 306, adapters);
    expect(ElevatorWindow.visible).toBe(true);
    expect(ElevatorWindow.label()).toBe("3F");

    // the ListMenu special on the department store's floor list
    set(0x8004, 3); // LISTMENU_DEPT_STORE_FLOORS
    expect(Natives.handlerFor("ListMenu")(ctx, adapters)).toEqual([false]);
    expect(ListMenu.Menu.isOpen()).toBe(true);
    expect(len(ListMenu.Menu.labels)).toBe(6);
    expect(ctx.stateWait()).toBe(false);
    field(() => { ListMenu.Menu.draw(); ElevatorWindow.draw(); });
    shot(host, "fms_elevator_menu.png");
    ListMenu.Menu.move(1);
    ListMenu.Menu.move(1);
    ListMenu.Menu.move(1); // scrolls: 4 rows shown of 6
    expect(ListMenu.Menu.scroll).toBe(0);
    ListMenu.Menu.move(1);
    expect(ListMenu.Menu.scroll).toBe(1);
    field(() => { ListMenu.Menu.draw(); ElevatorWindow.draw(); });
    shot(host, "fms_elevator_menu_scrolled.png");
    ListMenu.Menu.confirm();
    expect(ctx.stateWait()).toBe(true);
    expect(v(0x800D)).toBe(4);
    expect(ListMenu.Menu.isOpen()).toBe(false);

    // pick 5F: setvar 0x8006, 8; the ride shakes the camera, then dings
    set(0x8006, 8);
    expect(Natives.handlerFor("AnimateElevator")(ctx, adapters)).toEqual([false]);
    const pans = new Set<number>();
    let frames = 0, done = false;
    while (!done && frames < 1000) {
      frames++;
      done = ctx.stateWait();
      pans.add(FieldView.cameraPanY);
      if (frames === 20) {
        field(() => ElevatorWindow.draw());
        shot(host, "fms_elevator_ride.png");
      }
    }
    // sElevatorAnimationDuration[2] = 24 shakes, one every 3 frames
    expect(done).toBe(true);
    expect(frames).toBe(72);
    expect(pans.has(1) && pans.has(-1)).toBe(true);
    expect(FieldView.cameraPanY).toBe(0);
    // special CloseElevatorCurrentFloorWindow
    Natives.special(ctx, 352, adapters);
    expect(ElevatorWindow.visible).toBe(false);
    Runtime.stop();
  });

  test("small natives: seagallop routes, fame checker, size records, Oak's rating", () => {
    expect(SeagallopNatives.seagallopNumber(0, 1)).toBe(7);
    expect(SeagallopNatives.seagallopNumber(1, 3)).toBe(2);
    expect(SeagallopNatives.selectedDestination(1, 0, 3)).toBe(4);
    const [labels, top] = SeagallopNatives.destinationMenu(1, 0);
    expect(top).toBe(0);
    expect(len(labels)).toBe(6);
    expect(PokedexRating.getRatingMessage(150, undefined)).toEqual(["PokedexRating_Text_Complete", true]);
    expect(PokedexRating.getRatingMessage(42, undefined)[0]).toBe("PokedexRating_Text_LessThan50");
    for (const m of [Fame, FanClub, SizeRecordNatives, TowerNatives, Cutscene, Elevator, ListMenu, SeagallopNatives]) {
      expect(Object.keys(m.HANDLERS ?? {}).length).toBeGreaterThan(0);
    }
    expect(Natives.MODULES!.natives_tower).toBe(TowerNatives);
    expect(typeof TowerNatives.FUNCS[0]).toBe("function");
  });
});
