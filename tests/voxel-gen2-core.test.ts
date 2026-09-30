// Gen 2 core systems (voxelmon/game/gen2/core + the shared save/bag
// modules): a port of gen1recomp src/core/gen2/*.lua at bdfac727. Checks run
// against the Gold import (dist/voxelmon/gold/gen) and skip without it.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { haveGoldGen, useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { loadGenerated } from "../voxelmon/game/gen2/platform/data.ts";
import { fixedClock, osDate, osTime, setClockSource } from "../voxelmon/game/gen2/platform/clock.ts";
import { memorySaveIo, setSaveIo } from "../voxelmon/game/gen2/platform/saveio.ts";
import { seed } from "../voxelmon/game/gen2/platform/rng.ts";
import { NotPortedError } from "../voxelmon/game/gen2/notported.ts";
import { Clock } from "../voxelmon/game/gen2/core/Clock.ts";
import { Save } from "../voxelmon/game/gen2/core/Save.ts";
import { SaveSerializer } from "../voxelmon/game/gen2/shared/core/SaveSerializer.ts";
import { Bag } from "../voxelmon/game/gen2/shared/inventory/Bag.ts";
import { Breeding } from "../voxelmon/game/gen2/core/Breeding.ts";
import { Pokerus } from "../voxelmon/game/gen2/core/Pokerus.ts";
import { Evolution } from "../voxelmon/game/gen2/core/Evolution.ts";
import { Happiness } from "../voxelmon/game/gen2/core/Happiness.ts";
import { Phone } from "../voxelmon/game/gen2/core/Phone.ts";

const GEN = haveGoldGen();
const gtest = GEN ? test : test.skip;

/** Run `fn`; if it reaches a module another area has not ported yet, skip quietly. */
function unlessStub(fn: () => void): void {
  try {
    fn();
  } catch (e) {
    if (e instanceof NotPortedError) {
      console.log(`  (skipped: ${e.what} not ported yet)`);
      return;
    }
    throw e;
  }
}

beforeAll(() => {
  if (GEN) useGoldGen();
});

afterEach(() => {
  setClockSource(undefined);
  setSaveIo(undefined);
});

describe("platform/clock", () => {
  test("a fixed clock drives os.date/os.time the Lua way", () => {
    // 2026-09-29 was a Tuesday
    setClockSource(fixedClock({ year: 2026, month: 9, day: 29, hour: 18, min: 5, sec: 7 }));
    expect(osDate("%H")).toBe("18");
    expect(osDate("%M")).toBe("05");
    expect(osDate("%w")).toBe("2");
    expect(osDate("%j")).toBe("272");
    const t = osDate("*t");
    expect(t.wday).toBe(3); // Lua's *t: SUNDAY = 1
    expect(t.yday).toBe(272);
    const midnight = osTime() - (18 * 3600 + 5 * 60 + 7);
    expect(osTime({ year: t.year, month: t.month, day: t.day })).toBe(midnight + 12 * 3600); // hour defaults to 12
  });
});

describe("Clock (Clock.lua)", () => {
  // pokegold constants/misc_constants.asm: MORN_HOUR 4, DAY_HOUR 10, NITE_HOUR 18
  const boundaries: Array<[number, number, string]> = [
    [3, 59, "NITE"], [4, 0, "MORN"], [9, 59, "MORN"], [10, 0, "DAY"],
    [17, 59, "DAY"], [18, 0, "NITE"], [23, 59, "NITE"], [0, 0, "NITE"],
  ];

  test("the hour the game reads follows the host clock through the stored offset", () => {
    const clock = fixedClock({ year: 2026, month: 9, day: 30, hour: 7, min: 30 });
    setClockSource(clock);
    const save = Save.newGame({ trainerId: 1 });
    expect(Clock.isSet(save)).toBe(false);
    expect(Clock.hour(save)).toBe(7); // no base: the host clock straight through
    // Oak's question: it is 17:59 now (_InitTime)
    Clock.setTime(save, 17, 59);
    expect(Clock.isSet(save)).toBe(true);
    expect(Clock.hour(save)).toBe(17);
    expect(Clock.minute(save)).toBe(59);
    clock.advance(60); // the clock keeps running across the boundary
    expect(Clock.hour(save)).toBe(18);
    expect(Clock.minute(save)).toBe(0);
    // midnight wraps the day of minutes
    clock.advance(6 * 3600);
    expect(Clock.hour(save)).toBe(0);
  });

  test("MORN / DAY / NITE boundaries (pokegold MORN_HOUR 4, DAY_HOUR 10, NITE_HOUR 18)", () => {
    const clock = fixedClock({ year: 2026, month: 9, day: 30, hour: 12 });
    setClockSource(clock);
    const save = Save.newGame({ trainerId: 1 });
    // one minute either side of each boundary, read through a running clock
    for (const [h, m] of boundaries) {
      Clock.setTime(save, h, m);
      expect([Clock.hour(save), Clock.minute(save)]).toEqual([h, m]);
      clock.advance(60);
      expect(Clock.minutes(save)).toBe((h * 60 + m + 1) % Clock.MINUTES_PER_DAY);
      clock.advance(-60);
    }
    // the word comes from Palettes.clockDaytime (world/, ported elsewhere)
    unlessStub(() => {
      for (const [h, m, want] of boundaries) {
        Clock.setTime(save, h, m);
        expect(Clock.daytimeLabel(Clock.hour(save))).toBe(want);
      }
    });
  });

  test("the weekday is anchored the way InitDayOfWeek anchors wCurDay", () => {
    const clock = fixedClock({ year: 2026, month: 9, day: 29, hour: 23, min: 59 }); // a Tuesday
    setClockSource(clock);
    const save = Save.newGame({ trainerId: 1 });
    expect(Clock.weekday(save)).toBe(2);
    Clock.setWeekday(save, 5); // the player says FRIDAY
    expect(Clock.weekday(save)).toBe(5);
    expect(Clock.weekdayName(Clock.weekday(save) + 1)).toBe("FRIDAY");
    clock.advance(60); // midnight: SATURDAY
    expect(Clock.weekday(save)).toBe(6);
  });
});

describe("Save (Save.lua) through platform/saveio", () => {
  test("new game -> serialize -> parse is the same table", () => {
    setClockSource(fixedClock({ year: 2026, month: 9, day: 30, hour: 10 }));
    seed(1234);
    const save = Save.newGame({ playerName: "ISAAC", rivalName: "SILVER" });
    expect(save.format).toBe(Save.FORMAT);
    expect(save.player.money).toBe(3000);
    expect(save.spawn).toBe("SPAWN_HOME");
    expect(save.rtc.day).toBe(273);
    const text = SaveSerializer.encode(save);
    expect(text.startsWith("return {\n")).toBe(true);
    const back = SaveSerializer.decode(text);
    const reparsed = JSON.parse(JSON.stringify(save));
    // A Lua `{}` has no JS kind: the serializer reads it back as [] and
    // Save.load gives the name-keyed fields their object back.
    expect(SaveSerializer.encode(back)).toBe(text);
    expect(Object.keys(back).sort()).toEqual(Object.keys(reparsed).sort());
  });

  test("Save.save / Save.load round-trip a played file exactly", () => {
    const io = memorySaveIo();
    setSaveIo(io);
    setClockSource(fixedClock({ year: 2026, month: 9, day: 30, hour: 10 }));
    seed(99);
    const save = Save.newGame({ playerName: "ISAAC" });
    expect(Save.exists()).toBe(false);
    // what play writes: event bytes, a WRAM byte, a scene, dex, bag, a box name
    save.events[0] = 0x81;
    save.events[37] = 4;
    save.scriptMem[0xd9e4] = 3;
    save.mapScenes.NEW_BARK_TOWN = 1;
    save.pokedex.seen.CHIKORITA = true;
    save.pokedex.caught.CHIKORITA = true;
    save.player.badges.ZEPHYRBADGE = true;
    save.inventory.POTION = 3;
    save.bagOrder = ["POTION"];
    save.boxNames[2] = "BOX3";
    save.unownDex.push(1, 5);
    save.phoneContacts.PHONE_MOM = true;
    save.playTime = { hours: 1, minutes: 2, seconds: 3, frames: 4 };
    const [ok] = Save.save(save);
    expect(ok).toBe(true);
    expect(Save.exists()).toBe(true);
    expect(io.text!.startsWith("return {")).toBe(true);
    const [loaded, recovered, err, report] = Save.load();
    expect(err).toBeUndefined();
    expect(recovered).toBeUndefined();
    expect(Save.emptyReport(report)).toBe(true);
    expect(loaded).toEqual(structuredClone(save));
    expect(loaded!.events["37"]).toBe(4);
    expect(loaded!.scriptMem[0xd9e4]).toBe(3);
    expect(loaded!.boxNames[2]).toBe("BOX3");
    expect(Save.summary(loaded)).toMatchObject({ name: "ISAAC", badges: 1, caught: 1, hours: 1, minutes: 2 });
  });

  test("validate quarantines what no cartridge could write", () => {
    const save = Save.newGame({ trainerId: 7 });
    save.events = { 3: 7, 999: 1, 4: 300 };
    save.scriptMem = { 70000: 1, 10: 2 };
    save.playerState = "skate";
    const report = Save.validate(save);
    expect(save.events).toEqual({ 3: 7 });
    expect(save.scriptMem).toEqual({ 10: 2 });
    expect(save.playerState).toBe(Save.PLAYER_NORMAL);
    expect(report.lostEvents.length).toBe(2);
    expect(report.lostScriptMem.length).toBe(1);
    expect(report.lostPlayerState).toEqual([{ state: "skate" }]);
  });

  test("a corrupt file loads as nothing, a missing one says so", () => {
    setSaveIo(memorySaveIo("return { player = "));
    const [data, , err] = Save.load();
    expect(data).toBeUndefined();
    expect(err).toContain("corrupt");
    setSaveIo(memorySaveIo());
    expect(Save.load()[2]).toBe("missing");
  });

  test("the serializer's grammar refuses code", () => {
    expect(SaveSerializer.decode("return os.exit()")).toBeUndefined();
    expect(SaveSerializer.decodeWithError('return { a = "x" }')[0]).toEqual({ a: "x" });
    expect(SaveSerializer.decodeWithError("return { [1] = 1, [1] = 2 }")[1]).toContain("duplicate table key");
    // Brian's writer: sorted keys, numbers before strings, %q strings
    expect(SaveSerializer.encode({ b: 1, a: [true, "x\ny"] })).toBe('return {\n  a = {\n    [1] = true,\n    [2] = "x\\\ny",\n  },\n  b = 1,\n}\n');
  });

  test("play time ticks at 60 frames a second and stops at 999 hours", () => {
    const save = Save.newGame({ trainerId: 1 });
    for (let i = 0; i < 60 * 61; i++) Save.tickPlayTime(save);
    expect(save.playTime).toEqual({ hours: 0, minutes: 1, seconds: 1, frames: 0 });
    save.playTime = { hours: 999, minutes: 59, seconds: 59, frames: 59 };
    Save.tickPlayTime(save);
    expect(save.playTime.hours).toBe(999);
  });
});

describe("Bag (Bag.lua)", () => {
  gtest("pockets fill independently, stacks stop at 99, remove clears the row", () => {
    const data = { items: loadGenerated("items") };
    const save: Record<string, any> = { inventory: {} };
    expect(Bag.pocketOf("POTION", data)).toBe("ITEM");
    expect(Bag.pocketOf("POKE_BALL", data)).toBe("BALL");
    expect(Bag.pocketOf("HM_SURF", data)).toBe("TM_HM");
    expect(Bag.capacity(data, "ITEM")).toBe(20);
    expect(Bag.capacity(data, "BALL")).toBe(12);
    expect(Bag.capacity(data, "KEY_ITEM")).toBe(25);
    expect(Bag.capacity(data, "TM_HM")).toBe(57);

    expect(Bag.add(save, "POTION", 3, data)).toBe(true);
    expect(Bag.add(save, "POTION", 96, data)).toBe(true);
    expect(Bag.add(save, "POTION", 1, data)).toBe(false); // AddItemToInventory's 99 cap
    expect(save.inventory.POTION).toBe(99);

    // fill the ITEM pocket with 20 distinct ids
    const itemIds = Object.keys(data.items).filter((id) => data.items[id]?.pocket === "ITEM" && id !== "POTION");
    for (const id of itemIds.slice(0, 19)) expect(Bag.add(save, id, 1, data)).toBe(true);
    expect(Bag.slots(save, data, "ITEM")).toBe(20);
    expect(Bag.add(save, itemIds[19]!, 1, data)).toBe(false); // pocket full
    expect(Bag.add(save, "POKE_BALL", 5, data)).toBe(true); // a different pocket still has room
    expect(Bag.add(save, "ZEPHYRBADGE", 1, data)).toBe(true); // badges are not bag items
    expect(Bag.slots(save, data)).toBe(21);
    expect(Bag.order(save, data)[0]).toBe("POTION");
    expect(Bag.order(save, data)).not.toContain("ZEPHYRBADGE");

    Bag.remove(save, "POTION", 98);
    expect(save.inventory.POTION).toBe(1);
    Bag.remove(save, "POTION");
    expect(save.inventory.POTION).toBeUndefined();
    expect(save.bagOrder).not.toContain("POTION");
    expect(Bag.add(save, itemIds[19]!, 1, data)).toBe(true); // the freed slot takes it
  });

  gtest("SELECT reorders rows within one pocket", () => {
    const data = { items: loadGenerated("items") };
    const save: Record<string, any> = { inventory: {} };
    Bag.add(save, "POTION", 1, data);
    Bag.add(save, "POKE_BALL", 1, data);
    Bag.add(save, "ANTIDOTE", 1, data);
    expect(Bag.move(save, "ANTIDOTE", "ITEM", 1, data)).toBe(true);
    expect(save.bagOrder).toEqual(["ANTIDOTE", "POKE_BALL", "POTION"]);
  });
});

describe("Breeding (Breeding.lua)", () => {
  gtest("egg-group compatibility on real species (CheckBreedmonCompatibility)", () => {
    const data = { pokemon: loadGenerated("pokemon"), moves: loadGenerated("moves") };
    expect(Breeding.groupsCompatible(data, "PIKACHU", "RATTATA")).toBe(true); // GROUND
    expect(Breeding.groupsCompatible(data, "CHIKORITA", "BULBASAUR")).toBe(true); // MONSTER / PLANT
    expect(Breeding.groupsCompatible(data, "PIKACHU", "CHIKORITA")).toBe(false);
    // NO_EGGS (EGG_NONE) breeds with nothing, DITTO aside
    expect(Breeding.groupsCompatible(data, "TOGEPI", "PIKACHU")).toBe(false);
    expect(Breeding.baseForm(data, "RAICHU")).toBe("PICHU");
    expect(Breeding.baseForm(data, "MEGANIUM")).toBe("CHIKORITA");
  });

  gtest("egg moves: GetEggMove's three sources and InitEggMoves' father walk", () => {
    const data = { pokemon: loadGenerated("pokemon"), moves: loadGenerated("moves") };
    // 1. CHIKORITA's own egg move list (data/pokemon/egg_moves.asm)
    expect(Breeding.canInheritMove(data, "CHIKORITA", "LEECH_SEED", [])).toBe(true);
    // 2. a level-up move of the egg species, only when the other parent knows it
    expect(Breeding.canInheritMove(data, "CHIKORITA", "RAZOR_LEAF", [])).toBe(false);
    expect(Breeding.canInheritMove(data, "CHIKORITA", "RAZOR_LEAF", [{ id: "RAZOR_LEAF" }])).toBe(true);
    // 3. a TM/HM it can learn
    expect(Breeding.canInheritMove(data, "CHIKORITA", "SOLARBEAM", [])).toBe(true);
    expect(Breeding.canInheritMove(data, "CHIKORITA", "EMBER", [])).toBe(false);

    const egg = [{ id: "TACKLE", pp: 35, maxPp: 35 }, { id: "GROWL", pp: 40, maxPp: 40 }];
    const father = ["LEECH_SEED", "EMBER", "SOLARBEAM", "COUNTER"];
    Breeding.initEggMoves(data, "CHIKORITA", egg, father, []);
    expect(egg.map((m) => m.id)).toEqual(["GROWL", "LEECH_SEED", "SOLARBEAM", "COUNTER"]);
    expect(egg[1]!.pp).toBe(data.moves.LEECH_SEED.pp);
  });
});

describe("Pokerus (Pokerus.lua)", () => {
  const rolls = (bytes: number[]) => () => {
    const b = bytes.shift();
    if (b === undefined) throw new Error("out of scripted rolls");
    return b;
  };

  test("an infected party member spreads it to a neighbour on a win", () => {
    const party = [{ pokerus: 0 }, { pokerus: 0x34 }, { pokerus: 0 }];
    const slot = Pokerus.give(party, { random: rolls([0, 200]) });
    expect(slot).toBe(3);
    expect(party[2]!.pokerus >> 4).toBe(3); // the carrier's strain
    expect(party[2]!.pokerus & 15).toBeGreaterThan(0);
    expect(party[0]!.pokerus).toBe(0);
  });

  test("the 3-in-65536 de novo roll only once Goldenrod is reached", () => {
    const clean = () => [{ pokerus: 0 }, { pokerus: 0 }];
    expect(Pokerus.give(clean(), { random: rolls([0, 0, 1, 0x35]) })).toBeUndefined();
    const party = clean();
    expect(Pokerus.give(party, { random: rolls([0, 0, 1, 0x35]), reachedGoldenrod: true })).toBe(2);
    expect(party[1]!.pokerus).not.toBe(0);
    expect(Pokerus.give(clean(), { random: rolls([1]), reachedGoldenrod: true })).toBeUndefined();
  });

  test("the days run out and the mon is cured (immune, strain kept)", () => {
    const party = [{ pokerus: 0x32 }];
    expect(Pokerus.applyTick(party, 1)).toEqual([]);
    expect(party[0]!.pokerus).toBe(0x31);
    expect(Pokerus.applyTick(party, 5)).toEqual([1]);
    expect(party[0]!.pokerus).toBe(0x30);
  });
});

describe("Evolution (Evolution.lua)", () => {
  gtest("level, item, happiness+time and trade conditions on real evos", () => {
    const data = { pokemon: loadGenerated("pokemon"), moves: loadGenerated("moves") };
    const to = (mon: Record<string, any>, ctx?: Record<string, any>) => Evolution.checkMon(data, mon as any, ctx)[0]?.into;
    // EVOLVE_LEVEL
    expect(to({ species: "CHIKORITA", level: 15 })).toBeUndefined();
    expect(to({ species: "CHIKORITA", level: 16 })).toBe("BAYLEEF");
    // EVOLVE_ITEM: only when a stone is being used (wForceEvolution)
    expect(to({ species: "EEVEE", level: 5 }, { force: true, item: "FIRE_STONE" })).toBe("FLAREON");
    expect(to({ species: "EEVEE", level: 5 }, { item: "FIRE_STONE" })).toBeUndefined();
    // EVOLVE_HAPPINESS TR_MORNDAY / TR_NITE, at 220+
    expect(to({ species: "EEVEE", level: 5, happiness: 219 }, { timeOfDay: "DAY" })).toBeUndefined();
    expect(to({ species: "EEVEE", level: 5, happiness: 220 }, { timeOfDay: "DAY" })).toBe("ESPEON");
    expect(to({ species: "EEVEE", level: 5, happiness: 220 }, { timeOfDay: "NITE" })).toBe("UMBREON");
    expect(to({ species: "PICHU", level: 5, happiness: 220 }, { timeOfDay: "NITE" })).toBe("PIKACHU");
    // EVOLVE_TRADE, with and without the held item
    expect(to({ species: "MACHOKE", level: 30 })).toBeUndefined();
    expect(to({ species: "MACHOKE", level: 30 }, { link: true })).toBe("MACHAMP");
    const [row, consumes] = Evolution.checkMon(data, { species: "POLIWHIRL", level: 30, item: "KINGS_ROCK" }, { link: true });
    expect(row?.into).toBe("POLITOED");
    expect(consumes).toBe(true);
    // EVERSTONE stops a level-up evolution
    expect(to({ species: "CHIKORITA", level: 16, item: "EVERSTONE" })).toBeUndefined();
  });
});

describe("Happiness (Happiness.lua)", () => {
  test("ChangeHappiness steps by tier and clamps at 0 and 255", () => {
    const mon = { happiness: 70, hp: 10 };
    expect(Happiness.change(mon, "GAINLEVEL")).toBe(75); // tier 1: +5
    mon.happiness = 150;
    expect(Happiness.change(mon, "GAINLEVEL")).toBe(153); // tier 2: +3
    mon.happiness = 254;
    expect(Happiness.change(mon, "GAINLEVEL")).toBe(255); // tier 3: +2, capped
    mon.happiness = 3;
    expect(Happiness.change(mon, "HAPPINESS_POISONFAINT")).toBe(0); // -5, floored
    expect(Happiness.change({ happiness: 70, isEgg: true }, "GAINLEVEL")).toBeUndefined();
  });

  test("the Gym Leader award skips fainted mons; walking pays one point every 512 steps", () => {
    const party = [{ happiness: 70, hp: 10 }, { happiness: 70, hp: 0 }];
    expect(Happiness.changeParty(party, "GYMBATTLE")).toBe(1);
    expect(party.map((m) => m.happiness)).toEqual([73, 70]);
    const save = { party: [{ happiness: 100 }], stepCount: 0, happinessStepCount: 0 };
    expect(Happiness.step(save)).toBe(false); // the toggle goes to 1
    expect(Happiness.step(save)).toBe(true); // back to 0: +1
    expect(save.party[0]!.happiness).toBe(101);
    save.stepCount = 5;
    expect(Happiness.step(save)).toBe(false);
  });
});

describe("Phone (Phone.lua / PhoneRing.lua)", () => {
  gtest("a registered number rings in and the call is recorded in the save", () => {
    const clock = fixedClock({ year: 2026, month: 9, day: 30, hour: 14 });
    setClockSource(clock);
    const io = memorySaveIo();
    setSaveIo(io);
    expect(Phone.useExtracted(loadGenerated("events"))).toBe(true);
    const save = Save.newGame({ trainerId: 5 });

    // MOM's number from the intro, then YOUNGSTER JOEY on Route 30
    expect(Phone.addContact(save, Phone.PHONECONTACT_MOM)).toBe(true);
    expect(Phone.askForNumber(save, 15, true)).toBe(0); // got it
    expect(Phone.hasContact(save, 15)).toBe(true);
    expect(save.phone.list.filter((id: number) => id !== 0).sort()).toEqual([1, 15]);
    expect(save.phoneContacts).toEqual({ 1: true, 15: true });
    const [name] = Phone.contactName(15, loadGenerated("trainers"));
    expect(name).toBe("JOEY");

    // calling him from the Pokegear
    const ctx = { map: { id: "NEW_BARK_TOWN", phoneService: true }, rng: () => 0 };
    const out = Phone.call(save, 15, ctx);
    expect(out).toMatchObject({ kind: "call", contact: 15, direction: "outgoing" });
    expect(out.scriptKey).toBeDefined();

    // no service, no call
    expect(Phone.call(save, 15, { map: { id: "X", phoneService: false } }).kind).toBe("outofarea");

    // an incoming call: the 20-minute receive delay from the map load, then
    // CheckPhoneCall's coin and caller rolls
    Phone.onMapLoad(save, ctx);
    clock.advance(19 * 60);
    expect(Phone.tryRandomCall(save, ctx)).toBeUndefined();
    clock.advance(60);
    const incoming = Phone.tryRandomCall(save, ctx);
    expect(incoming).toMatchObject({ kind: "call", direction: "incoming" });
    expect([1, 15]).toContain(incoming!.contact!);
    expect(save.phone.timeCycles).toBe(1);
    Phone.endCall(save, incoming, ctx);

    // the phone book and the receive timer ride the save
    expect(Save.save(save)[0]).toBe(true);
    const [loaded] = Save.load();
    expect(loaded!.phone.list).toEqual(save.phone.list);
    expect(loaded!.phone.delayStart).toEqual(save.phone.delayStart);
    expect(Phone.contacts(loaded).filter((id) => id !== 0).sort()).toEqual([1, 15]); // ten slots, 0 = empty
  });
});
