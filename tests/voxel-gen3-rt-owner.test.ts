// The FireRed runtime's owner cluster: Game3, runtime, audio policy, and the
// shared core (GameVersion, Strings, Json, SaveSerializer, SaveData, Input,
// FixedStep, GameSpeed, CacheFs ...).
import { describe, expect, test, beforeEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopHost } from "../voxelmon/game/gen3/platform/desktop.ts";
import { setHost } from "../voxelmon/game/gen3/platform/host.ts";
import { memorySaveStore, setSaveStore, saveStore } from "../voxelmon/game/gen3/platform/savefs.ts";
import { silentAudio, setAudio } from "../voxelmon/game/gen3/platform/audio.ts";
import { GameVersion } from "../voxelmon/game/gen3/shared/core/GameVersion.ts";
import { GameVersion as ImportGameVersion } from "../voxelmon/import/gen3/game_version.ts";
import { Strings } from "../voxelmon/game/gen3/shared/core/Strings.ts";
import { Json } from "../voxelmon/game/gen3/shared/link/Json.ts";
import { SaveSerializer, setStrKey, setNumKey, getStrKey, getNumKey } from "../voxelmon/game/gen3/shared/core/SaveSerializer.ts";
import { SaveData } from "../voxelmon/game/gen3/shared/core/SaveData.ts";
import { Input, HOST_BTN } from "../voxelmon/game/gen3/shared/core/Input.ts";
import { FixedStep } from "../voxelmon/game/gen3/shared/core/FixedStep.ts";
import { GameSpeed } from "../voxelmon/game/gen3/shared/core/GameSpeed.ts";
import { LogicClock } from "../voxelmon/game/gen3/shared/core/LogicClock.ts";
import { Bag as HostBag } from "../voxelmon/game/gen3/shared/inventory/Bag.ts";
import { CacheFs } from "../voxelmon/game/gen3/shared/import/CacheFs.ts";
import { Tilt } from "../voxelmon/game/gen3/shared/render/Tilt.ts";
import { Runtime as ModRuntime } from "../voxelmon/game/gen3/shared/mods/Runtime.ts";
import { Gen3Compat } from "../voxelmon/game/gen3/shared/mods/Gen3Compat.ts";
import { Audio } from "../voxelmon/game/gen3/core/audio.ts";
import { Song } from "../voxelmon/game/gen3/core/song_ids.ts";
import { SE } from "../voxelmon/game/gen3/core/se_ids.ts";
import { song_fields } from "../voxelmon/game/gen3/core/song_fields.ts";
import { Task } from "../voxelmon/game/gen3/core/task.ts";
import { Trig } from "../voxelmon/game/gen3/core/trig.ts";
import { Capabilities } from "../voxelmon/game/gen3/core/capabilities.ts";
import { Runtime } from "../voxelmon/game/gen3/core/runtime.ts";
import { Game3 } from "../voxelmon/game/gen3/core/Game3.ts";

const ROOT = join(homedir(), "gen3ref/frfull");
const SAVE_FIXTURE = join(import.meta.dir, "data-gen3-owner-save.lua");

setHost(new DesktopHost(existsSync(ROOT) ? ROOT : mkdtempSync(join(tmpdir(), "g3own-"))));

describe("shared core", () => {
  test("GameVersion: Brian's rows, one current shared with the importer", () => {
    GameVersion.set("leafgreen");
    expect(ImportGameVersion.get()).toBe("leafgreen");
    GameVersion.set("firered");
    expect(GameVersion.get()).toBe("firered");
    expect(GameVersion.cachePrefix()).toBe("firered/");
    expect(GameVersion.saveSuffix()).toBe("_firered");
    expect(GameVersion.generation()).toBe(3);
    expect(GameVersion.generation("gold")).toBe(2);
    expect(GameVersion.forSha1("dd5945db9b930750cb39d00c84da8571feebf417")).toBe("firered");
    expect(GameVersion.revisionLabel("firered", "dd5945db9b930750cb39d00c84da8571feebf417")).toBe("1.1");
  });

  test("Strings: identity without a catalog, positional translations with one", () => {
    expect(Strings("But, it failed!")).toBe("But, it failed!");
    expect(Strings("Wild %s\nappeared!", "PIDGEY")).toBe("Wild PIDGEY\nappeared!");
    expect(Strings("OFF", "options.musicFilter")).toBe("OFF");
    Strings.load({ strings: { "%s's %s\nrose!": "%2$s de\n%1$s monte!", "OFF": "AUS", "bad %s": "%d %d" } });
    expect(Strings.active()).toBe(true);
    expect(Strings("%s's %s\nrose!", "PIKACHU", "ATTACK")).toBe("ATTACK de\nPIKACHU monte!");
    expect(Strings("OFF")).toBe("AUS");
    expect(Strings("bad %s", "x")).toBe("bad x"); // wrong arity -> the source
    Strings.load(undefined);
    expect(Strings.active()).toBe(false);
  });

  test("Json round trip (lt shapes, escapes, \\u)", () => {
    const v = { a: [null, 1, 2.5, "x\"y\n"], b: true, c: {} };
    const s = Json.encode(v);
    const [back] = Json.decode(s) as [any];
    expect(back.a[1]).toBe(1);
    expect(back.a[2]).toBe(2.5);
    expect(back.a[3]).toBe("x\"y\n");
    expect(back.b).toBe(true);
    expect(Json.decode('"\\u00e9"')[0]).toBe("\xC3\xA9");
    expect(Json.decode("[1,")[0]).toBeUndefined();
    expect(Json.encode([null])).toBe("[]");
  });

  test("FixedStep / GameSpeed / LogicClock", () => {
    let steps = 0;
    FixedStep.init(() => { steps++; });
    FixedStep.update(1 / 60, 1);
    FixedStep.update(1 / 60, 3);
    expect(steps).toBe(4);
    expect(GameSpeed.clamp(5)).toBe(4);
    expect(GameSpeed.cycle(200, 1)).toBe(1);
    expect(GameSpeed.optionKey("overworld")).toBe("speedOverworld");
    expect(LogicClock.cycle("60", 1)).toBe("gb");
    LogicClock.apply("gb");
    expect(FixedStep.STEP).toBeCloseTo(70224 / 4194304, 10);
    LogicClock.apply("60");
  });

  test("Tilt, Bag, mods Runtime null bus, Gen3Compat no-mod path", () => {
    Tilt.applyOptions({ tilt: 2 });
    expect(Tilt.levelLabel()).toBe("35");
    expect(Tilt.cycle()).toBe(3);
    Tilt.reset();
    const save: any = { inventory: {} };
    expect(HostBag.add(save, "POTION", 3)).toBe(true);
    expect(save.bagOrder[1]).toBe("POTION");
    HostBag.remove(save, "POTION", 3);
    expect(save.inventory.POTION).toBeUndefined();
    expect(ModRuntime.call("x", (a: number) => a + 1, 1)).toBe(2);
    expect(ModRuntime.wants("game.ready")).toBe(false);
    expect(Gen3Compat.gen1MapId("FR_PALLET_TOWN")).toBe("PALLET_TOWN");
    expect(Gen3Compat.gen3MapId("PALLET_TOWN")).toBe("FR_PALLET_TOWN");
    expect(Gen3Compat.interactWrapper()).toBeUndefined();
    expect(Gen3Compat.worldBusy()[0]).toBe(true);
  });
});

describe("SaveSerializer", () => {
  test.skipIf(!existsSync(SAVE_FIXTURE))("a gen1recomp FireRed save decodes and re-encodes byte for byte", () => {
    const src = readFileSync(SAVE_FIXTURE).toString("latin1");
    const [save, err] = SaveSerializer.decode(src);
    expect(err).toBeUndefined();
    expect(save.engine).toBe("game3");
    expect(save.flags[2092]).toBe(true);
    expect(getStrKey(save.flags, 2092)).toBe(true);
    expect(getNumKey(save.flags, 107)).toBeUndefined(); // a hide flag: the string key only
    expect(getStrKey(save.flags, 107)).toBe(true);
    expect(save.misc[2048]).toBe(false);
    expect(getStrKey(save.misc, 2048)).toBe(true);
    expect(SaveSerializer.encode(save)).toBe(src);
  });

  test("key-type helpers behave like Lua tables", () => {
    const t: any = {};
    setStrKey(t, 7, true);   // t["7"] = true
    expect(SaveSerializer.encode(t)).toBe('return {\n  ["7"] = true,\n}\n');
    setNumKey(t, 7, false);  // t[7] = false
    expect(SaveSerializer.encode(t)).toBe('return {\n  [7] = false,\n  ["7"] = true,\n}\n');
    setStrKey(t, 7, undefined);
    expect(SaveSerializer.encode(t)).toBe("return {\n  [7] = false,\n}\n");
    delete t[7];
    expect(SaveSerializer.encode(t)).toBe("return {}\n");
    // sequences (slot 0 unused) and plain objects take Lua's typed, sorted keys
    expect(SaveSerializer.encode({ list: [null, "a", "b"], x: 1.5, ["end"]: -0.25 }))
      .toBe('return {\n  ["end"] = -0.25,\n  list = {\n    [1] = "a",\n    [2] = "b",\n  },\n  x = 1.5,\n}\n'.replace('["end"]', "end"));
    expect(SaveSerializer.decode("return {1}")[1]).toContain("expected key");
    expect(SaveSerializer.decode("return 5")[1]).toBe("save root must be a table");
  });
});

describe("SaveData", () => {
  beforeEach(() => {
    setSaveStore(memorySaveStore());
    SaveData.resetSlotState();
    GameVersion.set("firered");
  });

  test("default options, and an options write/read round trip", () => {
    const d = SaveData.defaultOptions();
    expect(d.textSpeed).toBe(3);
    expect(d.musicVol).toBe(7);
    const opts = SaveData.loadOptions();
    expect(opts.textSpeed).toBe(3);
    opts.musicVol = 4;
    expect(SaveData.saveOptions(opts)).toBeDefined();
    expect(saveStore().read("options.lua")).toContain("musicVol = 4");
    expect(SaveData.loadOptions().musicVol).toBe(4);
    // a partial write folds the file underneath
    SaveData.saveOptions({ sfxVol: 2 });
    const o2 = SaveData.loadOptions();
    expect(o2.sfxVol).toBe(2);
    expect(o2.musicVol).toBe(4);
  });

  test("save -> load through the save store, flat file then a slot", () => {
    expect(SaveData.saveFilename()).toBe("save_firered.lua");
    const flags: any = {};
    setNumKey(flags, 32, true);
    setStrKey(flags, 32, true);
    const data: any = { engine: "game3", version: "firered", map: "FR_PALLET_TOWN", money: 3000, flags, party: [null, { species: 4 }] };
    expect(SaveData.save(data)).toBe(true);
    const text = saveStore().read("save_firered.lua")!;
    expect(text).toContain('[32] = true,\n    ["32"] = true,');
    const [back, recovered] = SaveData.load();
    expect(recovered).toBeUndefined();
    expect(back.map).toBe("FR_PALLET_TOWN");
    expect(back.party[1].species).toBe(4);
    expect(back.meta.format).toBe(5);
    expect(typeof back.options).toBe("object");

    expect(SaveData.setActiveSlot("firered", "slot2")).toBe("slot2");
    expect(SaveData.saveFilename()).toBe("saves/firered/slot2.lua");
    expect(SaveData.activeSlot()).toBe("slot2");
    expect(SaveData.save({ ...data, money: 1 })).toBe(true);
    expect(SaveData.load()[0].money).toBe(1);
    // a corrupt main file recovers from the .bak/.tmp witness
    saveStore().write("saves/firered/slot2.lua.bak", saveStore().read("saves/firered/slot2.lua")!);
    saveStore().write("saves/firered/slot2.lua", "return {");
    const [rec, from] = SaveData.load();
    expect(from).toBe("bak");
    expect(rec.money).toBe(1);
    expect(SaveData.deleteSlot("firered", "slot2")).toEqual([true]);
    expect(saveStore().read("saves/firered/slot2.lua")).toBeUndefined();
  });

  test("a legacy flat save migrates into slot1 on first resolution", () => {
    saveStore().write("save_firered.lua", SaveData.encode({ engine: "game3", map: "FR_VIRIDIAN_CITY" }));
    SaveData.resetSlotState();
    expect(SaveData.saveFilename()).toBe("saves/firered/slot1.lua");
    expect(SaveData.load()[0].map).toBe("FR_VIRIDIAN_CITY");
  });

  test("meta and mod diff notices", () => {
    const meta = SaveData.buildMeta([null, { id: "b", version: "1" }, { id: "a", version: "2" }], undefined, 5);
    expect(meta.mods[1].id).toBe("a");
    expect(meta.modCount).toBe(2);
    const diff = SaveData.modsDiff({ meta }, [null, { id: "a", version: "3" }]);
    expect(diff.removed[1]).toBe("b");
    expect(diff.changed[1]).toEqual({ id: "a", from: "2", to: "3" });
    expect(SaveData.modsDiffNotice(diff, meta)).toBe("This save was made with 2 mods; 1 is no longer active, 1 changed version");
    expect(SaveData.modsDiffNotice(SaveData.modsDiff({ meta: {} }, undefined), {})).toBeUndefined();
  });
});

describe("Input host seam", () => {
  test("host buttons raise Brian's pad events; step promotes edges", () => {
    Input.init();
    Input.setHostSink(undefined);
    Input.hostButtons(HOST_BTN.a | HOST_BTN.up);
    Input.step();
    expect(Input.wasPressed("a")).toBe(true);
    expect(Input.isDown("up")).toBe(true);
    Input.step();
    expect(Input.wasPressed("a")).toBe(false);
    expect(Input.isDown("a")).toBe(true);
    Input.hostButtons(HOST_BTN.l | HOST_BTN.select);
    Input.step();
    expect(Input.isDown("a")).toBe(false);
    expect(Input.wasPressed("l")).toBe(true);
    expect(Input.isDown("select")).toBe(true);
    // FRLG's L=A button mode
    Input.setButtonAlias("l", "a");
    Input.hostButtons(0);
    Input.step();
    Input.hostButtons(HOST_BTN.l);
    Input.step();
    expect(Input.wasPressed("a")).toBe(true);
    expect(Input.isDown("a")).toBe(true);
    Input.setButtonAlias("l", undefined);
    // reset drops holds; reconcile rebuilds them from the host pad
    Input.reset();
    expect(Input.isDown("l")).toBe(false);
    Input.reconcile();
    Input.step();
    expect(Input.isDown("l")).toBe(true);
    // soft reset: A+B+START+SELECT for 16 steps
    Input.hostButtons(HOST_BTN.a | HOST_BTN.b | HOST_BTN.start | HOST_BTN.select);
    let fired = 0;
    for (let i = 0; i < 16; i++) { Input.step(); if (Input.softResetStep()) fired = i + 1; }
    expect(fired).toBe(16);
    Input.hostButtons(0);
    Input.step();
  });
});

describe("audio policy (silent engine)", () => {
  const index = `return {
    fanfares = { [257] = { frames = 80, name = "MUS_LEVEL_UP" } },
    roles = { cycling = 282 },
    songs = {
      [5] = { id = 5, kind = "se", player = 1, loop = false, hasGoto = false },
      [257] = { id = 257, kind = "fanfare", player = 2, loop = false, hasGoto = false },
      [300] = { id = 300, kind = "bgm", player = 0, loop = true, hasGoto = true },
      [301] = { id = 301, kind = "bgm", player = 0, loop = true, hasGoto = true },
    },
    samples = { [0] = { size = 1 } },
  }`;
  const cache = { read: (rel: string) => (rel === "data/generated/gba/audio/index.lua" ? index : undefined) };

  test("map music, a fanfare pausing and resuming the song, SEs and cries", () => {
    const eng = silentAudio();
    setAudio(eng);
    Audio.endSession();
    expect(Audio.install(cache)).toEqual([true]);
    expect(Audio._pack.index.samples).toBeUndefined();
    Audio.applyEngineOptions({ musicVol: 7, sfxVol: 7 });
    Audio.playMapSong(300);
    expect(eng.song()).toBe(300);
    expect(Audio.currentMapMusic()).toBe(300);
    Audio.playFanfare(257);
    expect(eng.log).toContain("fanfare 257");
    expect(eng.songPaused()).toBe(true);
    expect(Audio.isFanfareFinished()).toBe(false);
    // a map change during the fanfare is deferred
    Audio.playMapSong(301);
    expect(eng.song()).toBe(300);
    for (let i = 0; i < 79; i++) Audio.update(1 / 60);
    expect(Audio.isFanfareFinished()).toBe(false);
    Audio.update(1 / 60);
    expect(Audio.isFanfareFinished()).toBe(true);
    expect(eng.song()).toBe(301);
    expect(eng.songPaused()).toBe(false);
    // a plain fanfare with no deferred song resumes the paused song
    Audio.playFanfare(257);
    for (let i = 0; i < 80; i++) Audio.update(1 / 60);
    expect(eng.song()).toBe(301);
    expect(eng.songPaused()).toBe(false);
    // SE and cry
    expect(Audio.playSe("SE_SELECT")).toBe(true);
    expect(eng.log).toContain("se 5");
    expect(Audio.playCry(25, { mode: 0 })).toBe(true);
    expect(eng.log).toContain("cry 25");
    // fade out then play the next song
    Audio.changeMusicTo(300);
    expect(Audio.currentMapMusic()).toBe(300);
    // speed 8: 16 * 8 / 60 s = 128 frames of fade, then the next song
    for (let i = 0; i < 127; i++) Audio.update(1 / 60);
    expect(eng.song()).toBe(301);
    for (let i = 0; i < 2; i++) Audio.update(1 / 60);
    expect(eng.song()).toBe(300);
    Audio.stopAll();
    expect(eng.song()).toBe(-1);
  });

  test.skipIf(!existsSync(ROOT))("the real FireRed pack installs through the cache", () => {
    setAudio(silentAudio());
    Audio.endSession();
    expect(Audio.install()[0]).toBe(true);
    expect(Audio.songInfo(Song.MUS_PALLET).kind).toBe("bgm");
    expect(Audio.role("cycling")).toBe(Song.MUS_CYCLING);
    expect(Audio.MUS_CYCLING).toBe(Song.MUS_CYCLING);
  });
});

describe("game3 core bits", () => {
  test("song / SE ids, song_fields, Trig, Task, Capabilities", () => {
    expect(Song.resolve("MUS_LEVEL_UP")).toBe(257);
    expect(Song.resolve(" 12 ")).toBe(12);
    expect(SE.resolve("SE_SELECT")).toBe(5);
    expect(SE.resolve("se_select, x")).toBe(5);
    const UiMod: any = song_fields({ own: 1 });
    expect(UiMod.MUS_LEVEL_UP).toBe(257);
    expect(UiMod.own).toBe(1);
    expect(Trig.sin(64)).toBe(256);
    expect(Trig.sin(320 + 128)).toBe(0);
    expect(Trig.arcTan2(0, 1)).toBe(16384);
    Task.clear();
    let done = false;
    Task.waitFrames(2, () => { done = true; });
    Task.update(1 / 60);
    expect(done).toBe(false);
    Task.update(1 / 60);
    expect(done).toBe(true);
    expect(Task.busy()).toBe(false);
    expect(Capabilities.has({ version: "firered" }, "helpSystem")).toBe(true);
    expect(Capabilities.has({ version: "firered" }, "contests")).toBe(false);
    expect(Capabilities.nativeAllowed({ version: "firered" }, "natives_contest")).toBe(false);
    expect(Capabilities.audit({ helpSystem: true, nope: true })[1][1]).toBe("unknown capability 'nope'");
  });

  test("runtime playtime pump and deferred calls", () => {
    const game: any = { session: { playtime: { hours: 0, minutes: 59, seconds: 59 } }, save: {} };
    Runtime.session = undefined;
    Runtime._playTimeAcc = 0;
    Runtime.pumpRtc(game, 1);
    expect(game.session.playTime.hours).toBe(1);
    expect(game.session.minutes).toBe(0);
    expect(game.save.playTimeHours).toBe(1);
    Runtime.active = true;
    let ran = 0;
    expect(Runtime.defer(() => { ran++; })).toBe(true);
    expect(Runtime.drainDeferred()).toBe(1);
    expect(ran).toBe(1);
    Runtime.active = false;
  });

  test("Game3.new constructs; the pad reaches Input through Game3", () => {
    const g = Game3.new();
    expect(g.phase).toBe("boot");
    expect(g.generation).toBe(3);
    expect(g.input).toBe(Input);
    Input.init();
    Input.setHostSink(g as any);
    Input.hostButtons(HOST_BTN.b);
    Input.step();
    expect(Input.wasPressed("b")).toBe(true);
    Input.hostButtons(0);
    Input.setHostSink(undefined);
    // speedLocked reaches core/battle (not ported yet in this tree)
    expect(g.isFixedSpeed()).toBe(false);
  });
});
