// The gen3 runtime's overworld features (Permissions, weather, coord_weather,
// rtc, time_events, roamer, rotating_gate, ... and the field overlay screens)
// on real FireRed cache data
// through the DesktopHost.
import { describe, expect, test, beforeAll } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DesktopHost } from "../voxelmon/game/gen3/platform/desktop.ts";
import { setHost } from "../voxelmon/game/gen3/platform/host.ts";
import { len, pairs, ipairs } from "../voxelmon/game/gen3/platform/lt.ts";
import { G } from "../voxelmon/game/gen3/platform/graphics.ts";
import { Dataset } from "../voxelmon/game/gen3/core/dataset.ts";
import { Permissions } from "../voxelmon/game/gen3/shared/world/gen2/Permissions.ts";
import { Weather } from "../voxelmon/game/gen3/core/weather.ts";
import { CoordWeather } from "../voxelmon/game/gen3/core/coord_weather.ts";
import { Rtc } from "../voxelmon/game/gen3/core/rtc.ts";
import { TimeEvents } from "../voxelmon/game/gen3/core/time_events.ts";
import { Roamer } from "../voxelmon/game/gen3/core/roamer.ts";
import { RotatingGate } from "../voxelmon/game/gen3/core/rotating_gate.ts";
import { Bike } from "../voxelmon/game/gen3/core/bike.ts";
import { Rng } from "../voxelmon/game/gen3/core/rng.ts";
import { Flags } from "../voxelmon/game/gen3/core/scripting/flags.ts";
import { NotPortedError } from "../voxelmon/game/gen3/notported.ts";
import { Collision } from "../voxelmon/game/gen3/core/collision.ts";
import { Data as VsData } from "../voxelmon/game/gen3/core/vs_seeker_data.ts";
import { VsSeeker } from "../voxelmon/game/gen3/core/vs_seeker.ts";
import { TrainerSight } from "../voxelmon/game/gen3/core/trainer_sight.ts";
import { ItemUse } from "../voxelmon/game/gen3/core/item_use.ts";
import { Bag } from "../voxelmon/game/gen3/core/bag.ts";
import { Safari } from "../voxelmon/game/gen3/core/safari.ts";
import { SizeRecord } from "../voxelmon/game/gen3/core/pokemon_size_record.ts";
import { TrainerFanClub } from "../voxelmon/game/gen3/core/trainer_fan_club.ts";
import { Deoxys } from "../voxelmon/game/gen3/core/deoxys.ts";
import { TeachyTv } from "../voxelmon/game/gen3/core/teachy_tv.ts";
import { FieldMoves } from "../voxelmon/game/gen3/core/field_moves.ts";
import { M as ForcedMovement } from "../voxelmon/game/gen3/core/forced_movement.ts";
import { StepEvents } from "../voxelmon/game/gen3/core/step_events.ts";
import { RenewableHiddenItems } from "../voxelmon/game/gen3/core/renewable_hidden_items.ts";
import { Itemfinder } from "../voxelmon/game/gen3/core/itemfinder.ts";
import { Tower } from "../voxelmon/game/gen3/core/trainer_tower.ts";
import { FieldEffects } from "../voxelmon/game/gen3/core/field_effects.ts";
import { Bridge } from "../voxelmon/game/gen3/core/bridge.ts";
import { Dive } from "../voxelmon/game/gen3/core/dive.ts";
import { Ghosts } from "../voxelmon/game/gen3/core/ghosts.ts";
import { ShowMon } from "../voxelmon/game/gen3/core/field_move_show_mon.ts";
import { BrailleField } from "../voxelmon/game/gen3/core/braille_field.ts";
import { Space } from "../voxelmon/game/gen3/core/scripting/space.ts";
import { TextIR } from "../voxelmon/game/gen3/core/scripting/text_ir.ts";
import { Fade } from "../voxelmon/game/gen3/ui/fade.ts";
import { Stack } from "../voxelmon/game/gen3/ui/stack.ts";
import { FrlgFont } from "../voxelmon/game/gen3/ui/frlg_font.ts";
import { Seagallop } from "../voxelmon/game/gen3/ui/seagallop.ts";
import { MapNamePopup } from "../voxelmon/game/gen3/ui/map_name_popup.ts";
import { Braille } from "../voxelmon/game/gen3/ui/braille.ts";
import { Rush } from "../voxelmon/game/gen3/ui/whiteout_rush.ts";
import { CacheFs as ImportCacheFs } from "../voxelmon/import/gen3/cache.ts";
import { makeCache } from "../voxelmon/import/gen3/fsio.ts";

const ROOT = join(homedir(), "gen3ref/frfull");

describe("gen3 runtime: Permissions (gen2 collision bytes)", () => {
  test("matches Brian's tables for a few cells", () => {
    expect(Permissions.surfable(0x29)).toBe("water");
    expect(Permissions.surfable(0x00)).toBe("land");
    expect(Permissions.surfable(0x07)).toBeNull();
    expect(Permissions.isGrass(0x18)).toBe(true);
    expect(Permissions.isGrass(0x118)).toBe(true); // % 256
    expect(Permissions.isEncounterCollision(0x29)).toBe(true);
    expect(Permissions.isEncounterCollision(0x10)).toBe(false);
    expect(Permissions.currentDirection(0x33)).toBe("down");
    expect(Permissions.currentDirection(0x3b)).toBe("down");
    expect(Permissions.currentDirection(0x30)).toBe("right");
    expect(Permissions.currentDirection(0x24)).toBeNull();
    expect(Permissions.ledgeFacings(0xa3)).toEqual({ down: true });
    expect(Permissions.ledgeFacings(0x00)).toBeUndefined();
    expect(Permissions.sideBlocks(0xb2)).toEqual({ up: true });
    expect(Permissions.entryBlocks(0xb2)).toEqual({ down: true });
    expect(Permissions.isWarpCollision(0x71)).toBe(true);
    expect(Permissions.isWarpCollision(0x68)).toBe(true);
    expect(Permissions.isImmediateWarp(0x70)).toBe(false); // carpet
    expect(Permissions.carpetDirection(0x76)).toBe("left");
    expect(Permissions.warpFacesDown(0x7c)).toBe(true);
    expect(Permissions.doorForcedDirection(0x7a)).toBe("down");
    expect(Permissions.isCounter(0x98)).toBe(true);
    // An UP_WALL below the player blocks a step down (the cart's "down" arm).
    const grid: Record<string, number> = { "1,2": 0xb2 };
    const collOf = (x: number, y: number) => grid[x + "," + y] ?? 0;
    expect(Permissions.stepPermitted(collOf, 1, 1, "down")).toBe(false);
    expect(Permissions.stepPermitted(collOf, 1, 1, "left")).toBe(true);
    expect(Permissions.objectStepPermitted(0, 0xb2, "up")).toBe(true);
    expect(Permissions.objectStepPermitted(0, 0xb2, "down")).toBe(false);
  });
});

describe("gen3 runtime: rtc and time_events with a fixed clock", () => {
  test("rtc day counts and local time offsets", () => {
    Rtc.reset();
    Rtc.setFixed("2026-10-04T12:34:56");
    const info = Rtc.hostInfo(null);
    expect(info).toEqual({ year: 26, month: 10, day: 4, hour: 12, minute: 34, second: 56 });
    expect(Rtc.isLeapYear(2024)).toBe(true);
    expect(Rtc.isLeapYear(1900)).toBe(false);
    // pokeemerald RtcGetDayCount: days since 2000-01-01, counting the day itself
    expect(Rtc.getDayCount(info)).toBe(Rtc.dayCount(26, 10, 4));
    expect(Rtc.dayCount(0, 1, 1)).toBe(1);
    expect(Rtc.dayCount(1, 1, 1)).toBe(367);
    const sess: any = {};
    const off = Rtc.initLocalTimeOffset(sess, 6, 0);
    expect(sess.localTimeOffset).toEqual(off);
    const lt = Rtc.calcLocalTime(sess);
    expect(lt).toEqual({ days: 0, hours: 6, minutes: 0, seconds: 0 });
    Rtc.advance(90);
    expect(Rtc.calcLocalTime(sess)).toEqual({ days: 0, hours: 7, minutes: 30, seconds: 0 });
    // 30 hours later: the day rolls over
    Rtc.advance(30 * 60);
    expect(Rtc.calcLocalTime(sess)).toEqual({ days: 1, hours: 13, minutes: 30, seconds: 0 });
    expect(Rtc.calcTimeDifference({ days: 0, hours: 23, minutes: 59, seconds: 0 }, { days: 1, hours: 0, minutes: 1, seconds: 0 }))
      .toEqual({ days: 0, hours: 0, minutes: 2, seconds: 0 });
    expect(Rtc.s8(200)).toBe(-56);
    expect(Rtc._fieldsOf(Rtc._linearOf({ year: 2031, month: 3, day: 1, hour: 1, minute: 2, second: 3 })))
      .toEqual({ year: 2031, month: 3, day: 1, hour: 1, minute: 2, second: 3 });
    Rtc.reset();
  });

  test("time_events tick edge and FireRed's disabled rtc", () => {
    TimeEvents.reset();
    const [perDay, perMinute] = TimeEvents.handlers();
    expect(typeof perDay.ClearDailyFlags).toBe("function");
    expect(typeof perMinute.BerryTreeTimeUpdate).toBe("function");
    const sess: any = { version: "firered" };
    // FireRed's profile has no RTC: run is a no-op
    expect(Rtc.enabled(sess)).toBe(false);
    expect(TimeEvents.run(sess, { store: Flags.newStore() })[0]).toBe(false);
    // the field-task edge: runs once per rising edge of bit 12
    expect(TimeEvents.tick(sess, 0)[0]).toBe(false);
    expect(TimeEvents._tickState).toBe(0);
    TimeEvents.tick(sess, 4096);
    expect(TimeEvents._tickState).toBe(1);
    TimeEvents.tick(sess, 8192);
    expect(TimeEvents._tickState).toBe(0);
  });
});

describe("gen3 runtime: weather, coord_weather, bike", () => {
  test("script setweather / doweather / resetweather on FRLG", () => {
    Weather.reset();
    expect(Weather.get()).toBe(Weather.NONE);
    Weather.set(Weather.RAIN);
    expect(Weather.get()).toBe(Weather.NONE);
    Weather.doWeather();
    expect(Weather.get()).toBe(Weather.RAIN);
    expect(Weather.isActive()).toBe(true);
    Weather.apply(Weather.SUNNY);
    expect(Weather.isActive()).toBe(false);
    Weather.suspend();
    expect(Weather.isSuspended()).toBe(true);
    Weather.resume();
    Weather.reset();
    expect(Weather.current).toBe(Weather.NONE);
  });

  test("saved weather and the rain game stat", () => {
    const sess: any = {};
    Weather.setSaved(Weather.RAIN, sess);
    expect(sess.savedWeather).toBe(Weather.RAIN);
    expect(sess.gameStats[40]).toBe(1);
    Weather.setSaved(Weather.RAIN, sess); // no change -> no count
    expect(sess.gameStats[40]).toBe(1);
    Weather.updatePerDay(5, sess);
    expect(sess.weatherCycleStage).toBe(1);
    expect(CoordWeather.isWeatherEvent({ scriptPtr: 0 })).toBe(true);
    expect(CoordWeather.isWeatherEvent({ scriptKey: "x" })).toBe(false);
    expect(CoordWeather.run(99)).toBe(false);
  });

  test("Bike.rse is nil on FireRed", () => {
    expect(Bike.rse({ version: "firered" })).toBeNull();
  });
});

describe.skipIf(!existsSync(ROOT))("gen3 runtime: weather, roamer, rotating gates on FireRed data", () => {
  let maps: Record<string, any>;

  beforeAll(() => {
    setHost(new DesktopHost(ROOT));
    Dataset.mountExtractRoots();
    maps = Dataset.buildMaps();
  });

  test("map header weather for known maps", () => {
    // pokefirered: Route 1 is WEATHER_SUNNY, Viridian Forest WEATHER_SHADE? no: FRLG uses
    // WEATHER_NONE indoors and WEATHER_SUNNY on outdoor routes.
    const r1 = maps.FR_ROUTE_1 ?? maps.ROUTE_1;
    expect(r1).toBeDefined();
    expect(r1.weather).toBe(Weather.SUNNY);
    Weather.apply(r1.weather);
    expect(Weather.get()).toBe(Weather.SUNNY);
    Weather.reset();
  });

  test("roamer: init, move between adjacent routes, encounter", () => {
    Rng._value = 0x1234;
    const sess: any = { party: [null, { level: 30 }], store: Flags.newStore() };
    expect(Roamer.init(sess, 1)).toBe(true);
    expect(sess.roamer.species).toBe(Roamer.SPECIES_RAIKOU);
    expect(sess.roamer.level).toBe(50);
    expect(Roamer.LOCATIONS.includes(sess.roamer.map)).toBe(true);
    expect(len(sess.roamer.moves)).toBeGreaterThan(0);
    for (let n = 0; n < 50; n++) {
      const from = sess.roamer.map;
      Roamer.move(sess, "map_transition");
      const to = sess.roamer.map;
      expect(to === from || Roamer.ADJACENCY[from].includes(to)).toBe(true);
    }
    sess.roamer.map = "FR_ROUTE_1";
    expect(Roamer.normalizeMapId("ROUTE1")).toBe("FR_ROUTE_1");
    expect(Roamer.normalizeMapId("FR_ROUTE_21_SOUTH")).toBe("FR_ROUTE_21_SOUTH");
    const enc = Roamer.tryEncounter(sess, "FR_ROUTE_1", "grass");
    expect(enc?.species).toBe(243);
    expect(enc?.foe.roamer).toBe(true);
    expect(Roamer.tryEncounter(sess, "FR_ROUTE_2", "grass")).toBeNull();
    // fled: stays alive, jumps elsewhere
    Roamer.onBattleEnd(sess, { hp: 100 }, "fled");
    expect(sess.roamer.active).toBe(true);
    expect(sess.roamer.map).not.toBe("FR_ROUTE_1");
    Roamer.onBattleEnd(sess, { hp: 0 }, "win");
    expect(sess.roamer.active).toBe(false);
  });

  test("rotating gate orientation states", () => {
    RotatingGate.reset();
    const vars: Record<number, number> = {};
    RotatingGate.setStore((id) => vars[id] ?? 0, (id, v) => { vars[id] = v; });
    expect(RotatingGate.puzzleType("FR_PALLET_TOWN")).toBeUndefined();
    expect(RotatingGate.puzzleType("EM_FORTREE_CITY_GYM")).toBe("fortree");
    RotatingGate.setOrientation(0, 1);
    RotatingGate.setOrientation(1, 3);
    expect(RotatingGate.getOrientation(0)).toBe(1);
    expect(RotatingGate.getOrientation(1)).toBe(3);
    expect(vars[0x4000]).toBe(3 * 256 + 1);
    RotatingGate.rotate(0, RotatingGate.ROTATE_CLOCKWISE);
    expect(RotatingGate.getOrientation(0)).toBe(2);
    RotatingGate.rotate(0, RotatingGate.ROTATE_ANTICLOCKWISE);
    RotatingGate.rotate(0, RotatingGate.ROTATE_ANTICLOCKWISE);
    RotatingGate.rotate(0, RotatingGate.ROTATE_ANTICLOCKWISE);
    expect(RotatingGate.getOrientation(0)).toBe(3);
    // a synthetic puzzle: gate 0 shape 0 (short north and east arms) at (5,5)
    RotatingGate._p = { kind: "t", map: undefined, gates: [null, { x: 5, y: 5, shape: 0, orientation: 0 }], anims: {} };
    RotatingGate.setOrientation(0, 0);
    expect(RotatingGate.hasArm(0, 0, 0)).toBe(true);
    expect(RotatingGate.hasArm(0, 1, 0)).toBe(true);
    expect(RotatingGate.hasArm(0, 2, 0)).toBe(false);
    expect(RotatingGate.hasArm(0, 0, 1)).toBe(false);
    expect(RotatingGate.canRotate(0, RotatingGate.ROTATE_CLOCKWISE, () => false)).toBe(true);
    expect(RotatingGate.canRotate(0, RotatingGate.ROTATE_CLOCKWISE, () => true)).toBe(false);
    expect(RotatingGate.angle(0)).toBe(0);
    RotatingGate.setStore(undefined, undefined);
    RotatingGate.reset();
  });
});

describe("gen3 runtime: pure overworld rules (no cache)", () => {
  test("vs_seeker rematch ladders and tiers", () => {
    expect(len(VsData.REMATCHES)).toBe(221);
    expect(VsData.byBase[89]).toBe(1);
    expect(VsData.byAny[498]).toBe(1);
    expect(VsData.byAny[VsData.SKIP]).toBeUndefined();
    const st = Flags.newStore();
    expect(VsSeeker.nextAvailable(89, st)).toEqual([1, 1]);
    // not yet fought the base trainer either: the first rematch is still id 101,
    // but tier 1 (FLAG 0x292) is not set, so the tier steps down to the base party
    expect(VsSeeker.rematchTrainerId(89, st)).toBe(89);
    Flags.setFlag(st, null, 0x292, true);
    expect(VsSeeker.rematchTrainerId(89, st)).toBe(101);
    Flags.setFlag(st, null, Flags.trainerFlagId(101), true);
    // 101 fought: the SKIP slot is passed over, 498 is next (j = 3)
    expect(VsSeeker.nextAvailable(89, st)).toEqual([3, 1]);
    const s = { steps: 40, charging: 0, rematches: {} };
    expect(VsSeeker.canUse([null], 0, 0, s, st)).toEqual([VsSeeker.NOT_CHARGED, 60]);
    s.steps = 100;
    expect(VsSeeker.canUse([null, { sane: true, x: 3, y: 2, trainerIdx: 89, localId: 1, graphicsId: 0 }], 0, 0, s, st))
      .toEqual([VsSeeker.CAN_USE]);
    expect(VsSeeker.runningBehavior(17)).toBe(VsSeeker.MOVEMENT_TYPE_RAISE_HAND_AND_JUMP);
    expect(VsSeeker.isVisible({ sane: true, x: 8, y: 0, trainerIdx: 0, localId: 0, graphicsId: 0 }, 0, 0)).toBe(false);
  });

  test("Permissions-free field move rules", () => {
    expect(FieldMoves.normalizeMoveId("rock smash")).toBe(249);
    expect(FieldMoves.normalizeMoveId("Soft-Boiled")).toBe(135);
    const party = [null, { moves: [null, 33, 45] }, { moves: [null, 57, 15] }];
    const [mon, slot] = FieldMoves.partyMoveUser(party, "SURF");
    expect(mon).toBe(party[2]);
    expect(slot).toBe(1);
    expect(FieldMoves.partyMoveUser(party, "FLY")).toEqual([null, 6]);
    expect(FieldMoves.isWaterfallBehavior(0x13)).toBe(true);
    expect(FieldMoves.isOutdoors(3)).toBe(true);
    expect(FieldMoves.isOutdoors(8)).toBe(false);
    const st = Flags.newStore();
    expect(FieldMoves.hasBadge(st, "SURF")).toBe(false);
    Flags.setFlag(st, null, 0x824, true);
    expect(FieldMoves.hasBadge(st, "SURF")).toBe(true);
    expect(FieldMoves.mowGrass3x3(5, 5, () => 0x00D, (_x: number, _y: number, m: number) => expect(m).toBe(0x001))).toBe(9);
    const hp = FieldMoves.softboiledTransfer({ hp: 50, maxHp: 50 }, { hp: 5, maxHp: 30 });
    expect(hp).toEqual([true, 40, 15]);
    expect(FieldMoves.canPushBoulder({ cellX: 2, cellY: 2 }, "left", () => true)).toEqual([true, 1, 2]);
  });

  test("forced movement tiles and step-event queue", () => {
    expect(ForcedMovement.isForcedMovementTile(0x23)).toBe(true);  // MB_ICE
    expect(ForcedMovement.isForcedMovementTile(0x54)).toBe(true);  // spin
    expect(ForcedMovement.isForcedMovementTile(0x01)).toBe(false);
    StepEvents.flush();
    let ran = 0;
    StepEvents.queueEvent(() => { ran++; });
    expect(StepEvents.busy()).toBe(true);
    StepEvents.update(1 / 60, null);
    expect(ran).toBe(1);
    StepEvents.update(1 / 60, null);
    expect(StepEvents.busy()).toBe(false);
  });

  test("pokemon size record math", () => {
    const mon = { personality: 0x12345678, ivs: { hp: 15, atk: 10, def: 3, spd: 7, spAtk: 1, spDef: 2 } };
    // hibyte = ((10^3)*15 ^ 0x78) & 0xFF, lobyte = ((1^2)*7 ^ 0x56) & 0xFF
    expect(SizeRecord.getMonSizeHash(mon)).toBe((((9 * 15) ^ 0x78) & 0xFF) << 8 | (((3 * 7) ^ 0x56) & 0xFF));
    expect(SizeRecord.translateIndex(0)).toBe(1);
    expect(SizeRecord.translateIndex(65535)).toBe(16);
    // Magikarp is 9 dm; index 1 (290 + b) * 9 / 10
    expect(SizeRecord.getMonSize(129, 5)).toBe(Math.floor(9 * 295 / 10));
    expect(SizeRecord.formatMonSizeRecord(100)).toBe("3.9");
  });

  test("trainer fan club packing and fans", () => {
    expect(TrainerFanClub.pack(5, true, 0x07)).toBe(5 | 0x80 | 0x0700);
    expect(TrainerFanClub.unpack(5 | 0x80 | 0x0700)).toEqual([5, true, 7]);
    expect(TrainerFanClub.countFans(0xB5)).toBe(5);
    const store = Flags.newStore();
    const sess: any = { store };
    TrainerFanClub.updateTrainerFanClubGameClear(sess, null);
    expect(TrainerFanClub.getNumFansOfPlayerInTrainerFanClub(sess, null)).toBe(3);
    expect(TrainerFanClub.isFanClubMemberFanOfPlayer(sess, null, 0)).toBe(true);
    expect(TrainerFanClub.getVar(sess, null, TrainerFanClub.VAR_MAP_SCENE_SAFFRON_CITY_POKEMON_TRAINER_FAN_CLUB)).toBe(1);
  });

  test("deoxys triangle steps (no rock on the map)", () => {
    const sess: any = { map: "FR_BIRTH_ISLAND_EXTERIOR" };
    expect(Deoxys.coords(0)).toEqual([15, 12]);
    expect(Deoxys.paletteKey(99)).toBe("deoxys_rock_10");
    expect(Deoxys.interact(sess)).toBe(1);
    expect(Deoxys.getVar(sess, Deoxys.VAR_DEOXYS_INTERACTION_NUM)).toBe(1);
    for (let i = 0; i < 5; i++) Deoxys.incrementStepCount(sess);
    // num 1 caps at 4 steps: 5 walked resets the puzzle
    expect(Deoxys.interact(sess)).toBe(0);
    expect(Deoxys.getVar(sess, Deoxys.VAR_DEOXYS_INTERACTION_NUM)).toBe(0);
  });

  test("renewable hidden items, itemfinder scan, trainer tower records", () => {
    expect(RenewableHiddenItems.isRenewableMap(3, 46)[0]).toBe(true);
    expect(RenewableHiddenItems.isRenewableMap(null, null, "FR_MT_MOON_B1F")[1]?.name).toBe("MT_MOON_B1F");
    const ctx: any = { flags: {}, vars: {} };
    expect(RenewableHiddenItems.onStep(ctx, 3, 19, "FR_ROUTE_1")).toBe(true);

    const events = [null, { type: "hidden_item", x: 13, y: 10 }, { type: "hidden_item", x: 9, y: 4 }];
    const r = Itemfinder.scan({ events, px: 10, py: 10, flagSet: () => false });
    expect(r).toEqual({ underfoot: false, itemX: 3, itemY: 0, dings: 4 });
    const under = Itemfinder.scan({ events: [null, { type: "hidden_item", x: 10, y: 10, underfoot: true }], px: 10, py: 10, flagSet: () => false });
    expect(under?.dings).toBe(3);

    // 3661 frames = 1 min, 1 s, 1 frame (1 * 168 / 100 = 1 centisecond)
    expect(Tower.formatTime(3661)).toEqual([" 1", " 1", "01"]);
    const sess: any = {};
    const rec = Tower.startChallenge(sess, 2);
    expect(rec.validated).toBe(true);
    expect(Tower.getChallengeId(sess)).toBe(2);
    expect(Tower.isTimerRunning(sess)).toBe(true);
    Tower.setTimerRunning(sess, false);
    expect(Tower.floorLayoutFor(1, Tower.CHALLENGE_TYPE.DOUBLE)).toBe(367);
    expect(Tower.floorIndexForMap("FR_TRAINER_TOWER_3F")).toBe(2);
    sess.party = [null, { species: 1, level: 30, hp: 10 }, { species: 4, level: 40, hp: 0 }, { species: 7, level: 20, hp: 5 }];
    expect(Tower.setSelectedOrder(sess, [null, 3, 2, 1])).toEqual([null, 3, 1, 0]);
    expect(Tower.partyMaxLevel(sess)).toBe(40);
  });

  test("field move show-mon and dive gating", () => {
    expect(ShowMon.isActive()).toBe(false);
    expect(Dive.isUnderwaterMap({ mapType: 5 })).toBe(true);
    expect(Dive.enabled({ version: "firered" })).toBe(false);
    expect(Ghosts.forDraw("FR_NOWHERE")).toBeNull();
    expect(Bridge.getSidecar({})).toEqual({});
    expect(BrailleField.checkRelicanthWailord({ version: "firered", party: [null] })).toBe(false);
  });
});

describe.skipIf(!existsSync(ROOT))("gen3 runtime: field moves, items and sight on FireRed data", () => {
  let maps: Record<string, any>;
  let game: any;

  beforeAll(() => {
    setHost(new DesktopHost(ROOT));
    Dataset.mountExtractRoots();
    maps = Dataset.buildMaps();
    Dataset.attachMidLayouts(maps);
    game = { data: { maps } };
  });

  test("trainer line of sight over Route 1's real collision", () => {
    expect(Collision.bindMap(game, "FR_ROUTE_1", maps.FR_ROUTE_1)).toBe(true);
    // find a row with five walkable cells
    let hit: [number, number] | null = null;
    for (let y = 2; y < 38 && !hit; y++) {
      for (let x = 0; x + 4 < 24 && !hit; x++) {
        let ok = true;
        for (let k = 0; k <= 4; k++) if (!Collision.isWalkable(x + k, y) || (Collision as any).isLedge?.(x + k, y)) ok = false;
        if (ok) hit = [x, y];
      }
    }
    expect(hit).not.toBeNull();
    const [x, y] = hit!;
    const eo: any = { cellX: x, cellY: y, facing: "right", sight: 5, localId: 99, currentElevation: 0 };
    const P: any = { cellX: x + 4, cellY: y, currentElevation: 0 };
    expect(TrainerSight.checkLineOfSight(eo, P, game)).toEqual([true, 4, "right"]);
    eo.sight = 3;
    expect(TrainerSight.checkLineOfSight(eo, P, game)[0]).toBe(false);
    eo.sight = 5; eo.facing = "left";
    expect(TrainerSight.checkLineOfSight(eo, P, game)[0]).toBe(false);
    // a solid cell between them blocks the ray
    let wall: [number, number] | null = null;
    for (let yy = 2; yy < 38 && !wall; yy++) {
      for (let xx = 0; xx + 2 < 24 && !wall; xx++) {
        if (Collision.isWalkable(xx, yy) && !Collision.isWalkable(xx + 1, yy) && Collision.isWalkable(xx + 2, yy)) wall = [xx, yy];
      }
    }
    if (wall) {
      const e2: any = { cellX: wall[0], cellY: wall[1], facing: "right", sight: 4, localId: 98, currentElevation: 0 };
      expect(TrainerSight.checkLineOfSight(e2, { cellX: wall[0] + 2, cellY: wall[1] }, game)[0]).toBe(false);
    }
    expect(TrainerSight.isTrainerType({ trainerType: 1 })).toBe(true);
    const st = Flags.newStore();
    Flags.setFlag(st, null, Flags.trainerFlagId(102), true);
    expect(TrainerSight.isDefeated({ trainerId: 102 }, st, null)).toBe(true);
    expect(TrainerSight.isDefeated({ trainerId: 103 }, st, null)).toBe(false);
  });

  test("a POTION on a hurt party mon", () => {
    const bag = Bag.new();
    Bag.add(bag, 13, 2);
    const mon: any = { species: 1, level: 5, hp: 4, maxHp: 30, nickname: "BULBA" };
    const sess: any = { party: [null, mon], vars: {}, name: "RED", version: "firered" };
    const [ok, kind, text] = ItemUse.useField(sess, bag, 13, 1);
    expect(ok).toBe(true);
    expect(kind).toBe("heal");
    expect(mon.hp).toBe(24);
    expect(typeof text).toBe("string");
    expect(Bag.has(bag, 13, 2)).toBe(false);
    expect(Bag.has(bag, 13, 1)).toBe(true);
    // full HP: no effect, the potion stays
    mon.hp = 30;
    expect(ItemUse.useField(sess, bag, 13, 1)[1]).toBe("noeffect");
    expect(Bag.has(bag, 13, 1)).toBe(true);
    expect(ItemUse.needsPartyTarget(13)).toBe(true);
    expect(ItemUse.revive({ hp: 0, maxHp: 21 })).toEqual([true, 10]);
  });

  test("safari zone step counting", () => {
    const sess: any = { flags: {}, vars: {} };
    expect(Safari.isActive(sess)).toBe(false);
    Safari.enter(sess);
    expect(Safari.isActive(sess)).toBe(true);
    expect(Safari.steps(sess)).toBe(600);
    expect(Safari.balls(sess)).toBe(30);
    for (let i = 0; i < 10; i++) expect(Safari.takeStep(sess, null)).toBe(false);
    expect(Safari.steps(sess)).toBe(590);
    Safari.reset(sess);
    expect(Safari.isActive(sess)).toBe(false);
  });

  test("teachy tv lessons and field effect sheets from the cache", () => {
    const rows = TeachyTv.menuItems({ bag: Bag.new() });
    expect(len(rows)).toBe(5); // four lessons + CANCEL without a TM case
    expect(rows[len(rows)].index).toBe(TeachyTv.CANCEL);
    expect(typeof rows[1].label).toBe("string");
    expect(len(TeachyTv.introPages(TeachyTv.SCRIPT.BATTLE))).toBeGreaterThan(0);

    FieldEffects.install(Dataset.cache());
    // FireRed's cache has no field_effects/objects.lua manifest (Emerald's
    // has): sheets load by the sizes Brian passes.
    expect(FieldEffects.manifest()).toBeNull();
    const sheet = FieldEffects.loadSheet("tall_grass", 16, 16, 5);
    expect(sheet).toBeTruthy();
    expect(sheet.quads[0]).toBeTruthy();
    expect(FieldEffects.setFieldEffectArgument(3, 15)).toBe(true);
    expect(FieldEffects.fieldEffectArgument(3, 0)).toBe(15);
    expect(FieldEffects.fldeffName(67)).toBe("FLDEFF_MOVE_DEOXYS_ROCK");
    const target = { px: 32, py: 48 };
    FieldEffects.startEmote(target, 1);
    for (let i = 0; i < 6; i++) FieldEffects.step();
    expect(FieldEffects._anims[1].frame).toBe(7);
    FieldEffects.invalidate();
  });
});

describe.skipIf(!existsSync(ROOT))("gen3 runtime: field overlays (whiteout rush, seagallop, map name popup, braille)", () => {
  let host: DesktopHost;
  let maps: Record<string, any>;

  beforeAll(() => {
    host = new DesktopHost(ROOT);
    setHost(host);
    // map_sections_extract's names come through the importer's bound cache
    // (its NOT FAITHFUL seam for Dataset.cache()); nothing in the runtime binds it yet.
    ImportCacheFs.bind(makeCache(ROOT));
    Dataset.mountExtractRoots();
    maps = Dataset.buildMaps();
  });

  function px(x: number, y: number): [number, number, number] {
    const p = host.pixels(), o = (y * 240 + x) * 4;
    return [p[o]!, p[o + 1]!, p[o + 2]!];
  }
  function frame(fn: () => void): void {
    G.beginFrame();
    G.clear(1, 0, 1, 1);
    fn();
    G.endFrame();
  }

  // ---------------------------------------------------------------- seagallop
  test("seagallop: travel directions follow pokefirered/src/seagallop.c:88", () => {
    const W = 0, E = 1;
    expect(Seagallop.directionOfTravel(0, 1)).toBe(E); // Vermilion -> One Island
    expect(Seagallop.directionOfTravel(0, 0)).toBe(W);
    expect(Seagallop.directionOfTravel(1, 0)).toBe(W); // One Island -> Vermilion
    expect(Seagallop.directionOfTravel(1, 2)).toBe(E); // One -> Two Island
    expect(Seagallop.directionOfTravel(5, 6)).toBe(E); // 0x4c0 bit 6
    expect(Seagallop.directionOfTravel(5, 1)).toBe(W);
    expect(Seagallop.directionOfTravel(7, 6)).toBe(E); // 0x440
    expect(Seagallop.directionOfTravel(8, 3)).toBe(E); // Cinnabar: all east
    expect(Seagallop.directionOfTravel(10, 0)).toBe(W); // Birth Island: all west
    expect(Seagallop.directionOfTravel(99, 0)).toBe(E); // no row: eastbound
    expect(Seagallop.directionOfTravel("4", "9")).toBe(E); // Four Island -> Navel Rock: 0x6e0 bit 9
    expect(Seagallop.directionOfTravel("4", "4")).toBe(W); // 0x6e0 bit 4 clear
  });

  test("seagallop: a full crossing loads the cache art, draws the letterbox and warps", () => {
    let warped = 0, done = 0;
    expect(Seagallop.start(0, 1, () => { warped++; }, () => { done++; })).toBe(true);
    expect(Seagallop.isActive()).toBe(true);
    const a = Seagallop._assets!;
    expect(a.wb && a.eb && a.ferry && a.wake && a.wakeQuads).toBeTruthy();
    expect(a.ferry!.getWidth()).toBe(64);
    expect(len(a.wakeQuads)).toBe(3);
    const run = Seagallop._run!;
    expect(run.direction).toBe(1);
    expect(run.ferryX).toBe(0);
    // 60 ticks: the water scrolls 6 px a tick, the ferry 3, a wake every 5
    for (let i = 0; i < 60; i++) { Seagallop.update(1 / 60); Fade.tick(1 / 60); }
    expect(run.tick).toBe(60);
    expect(run.ferryX).toBe(180);
    expect(run.bgX).toBe((60 * 6) % 256);
    expect(len(run.wakes)).toBeGreaterThan(0);
    for (const [, w] of ipairs(run.wakes)) expect([1, 2, 3]).toContain((w as any).frame);
    Fade.clear();
    frame(() => Seagallop.draw());
    // letterbox: rows 0..23 and 136..159 black; the sea in between is not
    expect(px(120, 10)).toEqual([0, 0, 0]);
    expect(px(120, 150)).toEqual([0, 0, 0]);
    let lit = 0;
    for (let x = 0; x < 240; x += 4) { const c = px(x, 40); if (c[0] + c[1] + c[2] > 0) lit++; }
    expect(lit).toBeGreaterThan(30);
    // run to the end: crossing at 140 ticks, then the fade to black
    let guard = 0;
    while (Seagallop.isActive() && guard++ < 600) { Seagallop.update(1 / 60); Fade.tick(1 / 60); }
    expect(Seagallop.isActive()).toBe(false);
    expect(run.state).toBe("done");
    expect(run.tick).toBeGreaterThanOrEqual(140);
    expect(warped).toBe(1);
    expect(done).toBe(1);
    Fade.clear();
  });

  test("seagallop: westbound starts the ferry at the right edge and mirrors nothing", () => {
    Seagallop.start(1, 0);
    expect(Seagallop._run!.direction).toBe(0);
    expect(Seagallop._run!.ferryX).toBe(240);
    Seagallop.update(1 / 60);
    expect(Seagallop._run!.ferryX).toBe(237);
    expect(Seagallop._run!.bgX).toBe(250); // (0 - 6) % 256, Lua modulo
    Seagallop.stop();
    expect(Seagallop.isActive()).toBe(false);
    Fade.clear();
  });

  // ----------------------------------------------------------- map name popup
  function findMap(pred: (id: string, def: any) => boolean): [string, any] {
    for (const [id, def] of pairs(maps)) if (pred(String(id), def)) return [String(id), def];
    throw new Error("no such map");
  }

  test("map name popup: Pallet Town slides in, holds 120 frames and slides out", () => {
    MapNamePopup.dismiss();
    const def = maps.FR_PALLET_TOWN ?? findMap((id) => /PALLET_TOWN$/.test(id))[1];
    expect(MapNamePopup.show(def)).toBe(true);
    expect(MapNamePopup._name).toBe("PALLET TOWN");
    expect(MapNamePopup._widthTiles).toBe(14);
    expect(MapNamePopup._state).toBe(MapNamePopup.STATE.SLIDE_IN);
    for (let i = 0; i < 12; i++) MapNamePopup.update(1 / 60);
    expect(MapNamePopup._tPos).toBe(24);
    expect(MapNamePopup._state).toBe(MapNamePopup.STATE.HOLD);

    frame(() => MapNamePopup.draw());
    // white interior (content starts at x=8, y=4) and dark text ink somewhere in it
    expect(px(10, 6)).toEqual([255, 255, 255]);
    let ink = 0;
    for (let y = 4; y < 20; y++) for (let x = 8; x < 8 + 112; x++) {
      const c = px(x, y);
      if (c[0] < 128 && c[1] < 128 && c[2] < 128) ink++;
    }
    expect(ink).toBeGreaterThan(40);
    // the text is centred: ink starts near (112 - measure) / 2
    const tw = FrlgFont.measure("PALLET TOWN");
    let first = -1;
    for (let x = 8; x < 120 && first < 0; x++) for (let y = 4; y < 20; y++) {
      const c = px(x, y);
      if (c[0] < 128 && c[1] < 128 && c[2] < 128) { first = x; break; }
    }
    expect(first).toBeGreaterThanOrEqual(8 + Math.floor((112 - tw) / 2));
    expect(first).toBeLessThanOrEqual(8 + Math.floor((112 - tw) / 2) + 2);
    // outside the banner: untouched clear colour
    expect(px(200, 100)).toEqual([255, 0, 255]);

    for (let i = 0; i < 121; i++) MapNamePopup.update(1 / 60);
    expect(MapNamePopup._state).toBe(MapNamePopup.STATE.SLIDE_OUT);
    for (let i = 0; i < 12; i++) MapNamePopup.update(1 / 60);
    expect(MapNamePopup._state).toBe(MapNamePopup.STATE.IDLE);
    expect(MapNamePopup.isActive()).toBe(false);
  });

  test("map name popup: a floored map gets its floor label and the 19-tile window", () => {
    MapNamePopup.dismiss();
    const [, def] = findMap((_id, d) => d && (Number(d.floorNum) ?? 0) < 0 && d.showMapName !== false && d.showMapName !== 0);
    expect(MapNamePopup.show(def, { force: true })).toBe(true);
    expect(MapNamePopup._widthTiles).toBe(19);
    expect(MapNamePopup._contentWidth).toBe(152);
    expect(MapNamePopup._name).toMatch(/ B\dF$/);
    MapNamePopup.dismiss();
  });

  test("map name popup: showMapName == 0 suppresses unless forced; a reshow swaps the name", () => {
    MapNamePopup.dismiss();
    const hidden = { id: "FR_PALLET_TOWN_PLAYERS_HOUSE_1F", regionMapSectionId: 88, showMapName: 0, floorNum: 0 };
    expect(MapNamePopup.show(hidden)).toBe(false);
    expect(MapNamePopup.isActive()).toBe(false);
    // Lua `showMapName or show_map_name`: false falls through to nil, so it shows
    expect(MapNamePopup.show({ ...hidden, showMapName: false })).toBe(true);
    MapNamePopup.dismiss();

    const viridian = findMap((id) => /VIRIDIAN_CITY$/.test(id))[1];
    const pewter = findMap((id) => /PEWTER_CITY$/.test(id))[1];
    MapNamePopup.show(viridian);
    for (let i = 0; i < 5; i++) MapNamePopup.update(1 / 60);
    MapNamePopup.show(pewter);
    expect(MapNamePopup._state).toBe(MapNamePopup.STATE.SLIDE_OUT);
    expect(MapNamePopup._name).toBe("VIRIDIAN CITY");
    for (let i = 0; i < 5; i++) MapNamePopup.update(1 / 60);
    expect(MapNamePopup._state).toBe(MapNamePopup.STATE.SLIDE_IN);
    expect(MapNamePopup._name).toBe("PEWTER CITY");
    // an unknown map falls back to the cleaned id
    MapNamePopup.dismiss();
    MapNamePopup.show({ id: "FR_SomeMap2Test_X" }, { force: true });
    expect(MapNamePopup._name).toBe("SOME MAP 2 TEST X");
    MapNamePopup.dismiss();
  });

  // ------------------------------------------------------------------ braille
  test("braille: encodes the cart's braillemessage texts cell for cell", () => {
    const bundle = Space.ensureBundle();
    const scripts = bundle.scripts, texts = bundle.text;
    const ptrs: string[] = [];
    for (const [, rows] of pairs(scripts)) {
      for (const [, row] of ipairs(rows as any)) {
        const r = row as any;
        if (r && r.op === "braillemessage") ptrs.push(r.ptr ?? r[1]);
      }
    }
    expect(ptrs.length).toBeGreaterThan(5);
    let checked = 0;
    for (const p of ptrs) {
      const ir = texts[p];
      if (!ir) continue;
      const body = TextIR.toPlain(ir) ?? "";
      const lines = Braille.encode(body);
      for (const [, line] of ipairs(lines)) for (const [, c] of ipairs(line as any)) expect(c).not.toBe(false);
      checked++;
    }
    expect(checked).toBeGreaterThan(5);
    // the first Tanoby chamber spells ABC: dots 1 / 1-2 / 1-4
    const abc = Braille.encode(TextIR.toPlain(texts["g3:081a929f"]));
    expect(abc[1]).toEqual([null, 0x01, 0x05, 0x03]);
  });

  test("braille: number sign, lower case, newlines, Unicode cells, widths", () => {
    expect(Braille.encode("ab 12a")[1]).toEqual([null, 0x01, 0x05, 0x00, 0x3A, 0x01, 0x05, 0x01]);
    expect(Braille.encode("1 2")[1]).toEqual([null, 0x3A, 0x01, 0x00, 0x3A, 0x05]);
    const two = Braille.encode("AB\nC");
    expect(len(two)).toBe(2);
    expect(two[2]).toEqual([null, 0x03]);
    // U+283F (all six dots) and U+2801 (dot 1)
    expect(Braille.unicodeCell("\xe2\xa0\xbf")).toBe(0x3F);
    expect(Braille.unicodeCell("\xe2\xa0\x81")).toBe(0x01);
    expect(Braille.unicodeCell("A")).toBeUndefined();
    expect(Braille.width("AB\nCDE")).toBe(3 * 16);
    expect(Braille.countGlyphs("AB\nCDE")).toBe(5);
    expect(Braille.glyphCell(17, 16)).toEqual([16, 16]);
    expect(Braille.sheetCols({ cols: 16 }, 999)).toBe(16);
    expect(Braille.sheetCols(null, 128)).toBe(8);
  });

  test("braille: the cache glyph sheet draws ink for each cell", () => {
    Braille.invalidate();
    expect(Braille.hasSheet()).toBe(true);
    frame(() => {
      G.clear(1, 1, 1, 1);
      expect(Braille.drawText("ABC", 16, 16)).toBe(true);
    });
    for (let g = 0; g < 3; g++) {
      let ink = 0;
      for (let y = 16; y < 32; y++) for (let x = 16 + g * 16; x < 32 + g * 16; x++) {
        const c = px(x, y);
        if (c[0] < 200) ink++;
      }
      expect(ink).toBeGreaterThan(4);
    }
    // limitChars stops after the first cell
    frame(() => {
      G.clear(1, 1, 1, 1);
      Braille.drawText("ABC", 16, 16, { limitChars: 1 });
    });
    let ink2 = 0;
    for (let y = 16; y < 32; y++) for (let x = 32; x < 64; x++) if (px(x, y)[0] < 200) ink2++;
    expect(ink2).toBe(0);
    Braille.setCursor(10, 20);
    expect(Braille.cursor()).toEqual({ x: 10, y: 20 });
    Braille.clearCursor();
    expect(Braille.cursor()).toBeUndefined();
  });

  // ------------------------------------------------------------ whiteout rush
  test("whiteout rush: the cart's text, hold 120 frames, print, wait for A", () => {
    let started = false;
    try {
      Rush.start(null, { name: "RED" }, {});
      started = true;
    } catch (e) {
      // an unported neighbour (audio / field) on the way: say which
      if (!(e instanceof NotPortedError)) throw e;
    }
    if (!started) return;
    expect(Rush.isActive()).toBe(true);
    expect(Rush.phase()).toBe("hold");
    expect(Rush.text()).toContain("RED");
    expect(Rush.text()!.toUpperCase()).toContain("CENTER");
    expect(Stack.has(Rush.ID)).toBe(true);
    const tryUpdate = (): void => { try { Rush.update(); } catch (e) { if (!(e instanceof NotPortedError)) throw e; } };
    for (let i = 0; i < 119; i++) tryUpdate();
    expect(Rush.phase()).toBe("hold");
    tryUpdate();
    expect(Rush.phase()).toBe("print");
    frame(() => Rush.draw());
    expect(px(200, 150)).toEqual([0, 0, 0]);
    const total = Rush._state!.total;
    for (let i = 0; i < total; i++) tryUpdate();
    expect(Rush.phase()).toBe("wait");
    frame(() => Rush.draw());
    let white = 0;
    for (let y = 48; y < 64; y++) for (let x = 2; x < 120; x++) if (px(x, y)[0] > 200) white++;
    expect(white).toBeGreaterThan(30);
    Rush.handleInput({ wasPressed: (k: string) => k === "b" });
    expect(Rush.isActive()).toBe(false);
    expect(Stack.has(Rush.ID)).toBe(false);
    expect(Fade.isActive()).toBe(true);
    Fade.clear();
  });
});
