// The POKeGEAR, the wall radio and the caller-ID box (voxelmon/game/gen2/ui/
// Pokegear, MapRadio, CallerBox) on a real Game2 and the Gold screen.

import { describe, expect, test } from "bun:test";
import { haveGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { Clock } from "../voxelmon/game/gen2/core/Clock.ts";
import { Font } from "../voxelmon/game/gen2/shared/render/Font.ts";
import { Screens } from "../voxelmon/game/gen2/shared/ui/Screens.ts";
import { CallerBox } from "../voxelmon/game/gen2/ui/CallerBox.ts";
import { MapRadio } from "../voxelmon/game/gen2/ui/MapRadio.ts";
import { Pokegear } from "../voxelmon/game/gen2/ui/Pokegear.ts";
import { draw, idle, press, rig, shot, tiles, topName } from "./gen2-ui-start-fixture.ts";

const gold = haveGoldGen();

/** The text on screen row `ty`, read back through the font's glyph tiles. */
function rowText(lcd: any, ty: number, x0 = 0, x1 = 20): string {
  const byTile = new Map<number, string>();
  for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789:?!.,'é-") {
    const code = Font.encode(ch)[0];
    const tile = code === undefined ? undefined : Font.tileOf(code);
    if (tile !== undefined) byTile.set(tile, ch);
  }
  let s = "";
  for (let x = x0; x < x1; x++) s += byTile.get(lcd.s.cells[ty * 32 + x]) ?? " ";
  return s;
}

/** A rig standing in New Bark Town with the MAP, PHONE and RADIO cards. */
function gearRig(): any {
  const r = rig();
  const game = r.game;
  // No world in the rig: Game2.currentLandmark reads world.map, so stand the
  // player in New Bark Town by hand.
  game.currentLandmark = () => "LANDMARK_NEW_BARK_TOWN";
  // EngineFlags rows 0-2: POKEGEAR_RADIO_CARD_F, _MAP_CARD_F, _PHONE_CARD_F.
  game.save.engineFlags = { ...(game.save.engineFlags ?? {}), 0: true, 1: true, 2: true };
  game.save.flags = { ...(game.save.flags ?? {}), pokegear: true };
  return r;
}

describe.skipIf(!gold)("gen2 ui: POKeGEAR", () => {
  test("clock, map, phone, radio, a call, and back out", async () => {
    await tiles();
    const r = gearRig();
    const game = r.game;
    game.pushStartMenuItem("pokegear");
    expect(topName(game)).toBe("Pokegear");
    const gear = game.stack.top() as Pokegear;
    expect(gear.cards.map((c) => c.id)).toEqual(["clock", "map", "phone", "radio"]);
    expect(gear.region()).toBe("johto");

    // CLOCK: the GAME clock (the save's RTC base over the rig's fixed host
    // clock, 2026-09-30, a Wednesday).
    await shot(r, "gear_clock");
    const hour = Clock.hour(game.save);
    const minute = Clock.minute(game.save);
    const hh = String(hour % 12 === 0 ? 12 : hour % 12).padStart(2, " ");
    expect(rowText(r.lcd, 6)).toContain(Clock.weekdayName(Clock.weekday(game.save) + 1)!);
    expect(rowText(r.lcd, 8)).toContain(`${hh}:${String(minute).padStart(2, "0")}`);
    expect(rowText(r.lcd, 8)).toContain(hour < 12 ? "AM" : "PM");
    expect(rowText(r.lcd, 1)).toContain("SWITCH");
    expect(rowText(r.lcd, 14)).toContain("Press any");

    // into the card, then right: MAP, with the cursor on New Bark Town
    press(game, "a");
    expect(gear.mode).toBe("card");
    press(game, "right");
    expect(gear.card()!.id).toBe("map");
    await shot(r, "gear_map");
    expect(rowText(r.lcd, 0)).toContain("NEW BARK");
    expect(rowText(r.lcd, 1)).toContain("TOWN");
    // up walks to the next landmark id (ROUTE_29), down back, down again wraps
    press(game, "up");
    expect(gear.mapLandmark().id).toBe("LANDMARK_ROUTE_29");
    press(game, "down");
    press(game, "down");
    expect(gear.mapLandmark().id).toBe("LANDMARK_SILVER_CAVE");
    press(game, "up");
    expect(gear.mapLandmark().id).toBe("LANDMARK_NEW_BARK_TOWN");

    // PHONE: MOM and ELM, then CALL / CANCEL for MOM (not deletable)
    press(game, "right");
    expect(gear.card()!.id).toBe("phone");
    await shot(r, "gear_phone");
    expect(rowText(r.lcd, 4)).toContain("MOM:");
    expect(rowText(r.lcd, 6)).toContain("ELM:");
    expect(rowText(r.lcd, 8)).toContain("----------:");
    expect(rowText(r.lcd, 14)).toContain("Whom do you");
    press(game, "a");
    expect(gear.phoneSubmenu).toBe("callCancel");
    press(game, "down");
    press(game, "down"); // clamps on CANCEL
    expect(gear.phoneSubmenuCursor).toBe(1);
    press(game, "b");
    expect(gear.phoneSubmenu).toBeUndefined();
    expect(gear.card()!.id).toBe("phone");

    // ELM: CALL places the call; Game2.runPokegearCall has no world to run it
    press(game, "down");
    expect(gear.phoneSelection()).toBe(4);
    press(game, "a");
    press(game, "a");
    expect(gear.call).toBeDefined();
    expect(gear.call.kind).toBe("call");
    expect(gear.call.text).toContain("PROF.ELM:");
    // The card's own call state: Phone_TextboxWithName's "NAME:" and the
    // ellipsis in the bottom box (the caller-ID box is the INCOMING call's,
    // pushed by script/CallAsm.ts; see the last test).
    await shot(r, "gear_call");
    expect(rowText(r.lcd, 14)).toContain("PROF.ELM:");
    // A hangs up; B on the bare list closes the gear from the phone card
    press(game, "a");
    expect(gear.call).toBeUndefined();

    // RADIO: 04.5 in Johto at 10 AM is Oak's Pokemon Talk
    press(game, "right");
    expect(gear.card()!.id).toBe("radio");
    expect(gear.radioShow).toBe("OAKS_POKEMON_TALK");
    idle(game, 110);
    expect(gear.radio!.log[0]).toBe("MARY: PROF.OAK'S");
    expect(gear.radio!.log[1]).toBe("POKéMON TALK!");
    await shot(r, "gear_radio");
    expect(rowText(r.lcd, 9)).toContain("OAK");
    expect(rowText(r.lcd, 14)).toContain("MARY: PROF.OAK'S");
    expect(rowText(r.lcd, 16)).toContain("TALK!");
    // up: 07.5 POKEMON MUSIC; the knob stops dead at the top
    press(game, "up");
    expect(gear.radioShow).toBe("POKEMON_MUSIC");
    for (let i = 0; i < 10; i++) press(game, "up", 1);
    expect(gear.station).toBe(Pokegear.RADIO_CHANNELS.length);
    expect(gear.radioShow).toBeUndefined(); // 20.5 needs the Rocket signal

    // B: back to the strip (radio off), B again: onClose pops the gear
    press(game, "b");
    expect(gear.mode).toBe("strip");
    expect(gear.radio).toBeUndefined();
    press(game, "b");
    expect(game.stack.states.includes(gear)).toBe(false);
  });

  test("cards follow the engine flags; Kanto map limits", () => {
    const r = rig();
    const game = r.game;
    const bare = Pokegear.new(game, { currentLandmark: "LANDMARK_NEW_BARK_TOWN" });
    expect(bare.cards.map((c) => c.id)).toEqual(["clock"]);
    game.save.engineFlags = { 1: true };
    const kanto = Pokegear.new(game, { currentLandmark: "LANDMARK_VERMILION_CITY" });
    expect(kanto.region()).toBe("kanto");
    expect(kanto.cards.map((c) => c.id)).toEqual(["clock", "map"]);
    const [last, first] = kanto.cursorLimits();
    expect(first).toBe(kanto.landmarkIndex("VICTORY_ROAD", 0));
    expect(last).toBe(kanto.landmarkIndex("ROUTE_28", 0));
    // Kanto radio: 16.5 Places & People, 18.5 Let's All Sing!
    const names = kanto.stations().map((s) => s.station);
    expect(names).toContain("PLACES_AND_PEOPLE");
    expect(names).toContain("LETS_ALL_SING");
    expect(names).not.toContain("OAKS_POKEMON_TALK");
  });

  test("the show machine: Lucky Channel and Rocket takeover", () => {
    let n = 0;
    const radio = Pokegear.Radio.new({ data: { luckyNumber: 42 }, rng: () => (n++ % 255) + 1 });
    radio.tune("LUCKY_CHANNEL");
    for (let i = 0; i < 101 * 9; i++) radio.step();
    expect(radio.log.slice(0, 8)).toEqual([
      "REED: Yeehaw! How", "y'all doin' now?", "Whether you're up", "or way down low,",
      "don't you miss the", "LUCKY NUMBER SHOW!", "This week's Lucky", "Number is 00042!",
    ]);
    const rocket = Pokegear.Radio.new({ data: { rocketsInRadioTower: true, inJohto: true } });
    rocket.tune("POKEMON_MUSIC");
    rocket.step();
    expect(rocket.log[0]).toBe("… …Ahem, we are");
    expect(rocket.music).toBe("Music_RocketTheme");
  });

  test("the wall radio: name, hold, show, exit", async () => {
    await tiles();
    const r = gearRig();
    const game = r.game;
    let done = 0;
    Screens.push(game, "Gen2MapRadio", { channel: 4, onDone: () => done++, currentLandmark: "LANDMARK_NEW_BARK_TOWN" });
    expect(topName(game)).toBe("MapRadio");
    const mr = game.stack.top() as MapRadio;
    expect(mr.station).toBe("LUCKY_CHANNEL");
    draw(r);
    expect(rowText(r.lcd, 14)).toContain("Lucky Channel");
    // the 100-frame hold ignores buttons
    press(game, "a", 0);
    expect(done).toBe(0);
    idle(game, 100);
    expect(mr.radio.log[0]).toBe("REED: Yeehaw! How");
    await shot(r, "gear_mapradio");
    press(game, "b");
    expect(done).toBe(1);
    expect(game.stack.states.includes(mr)).toBe(false);
    // channel 0 resolves by region and hour: Johto, 10 AM -> Oak's talk
    const zero = MapRadio.new(game, { channel: 0, currentLandmark: "LANDMARK_NEW_BARK_TOWN" });
    expect(zero.station).toBe("OAKS_POKEMON_TALK");
    const kanto = MapRadio.new(game, { channel: 0, currentLandmark: "LANDMARK_VERMILION_CITY" });
    expect(kanto.station).toBe("PLACES_AND_PEOPLE");
  });

  test("the caller-ID box: name, colon and class", async () => {
    await tiles();
    const r = rig();
    const game = r.game;
    game.stack.push(CallerBox.new("JOEY", "YOUNGSTER"));
    await shot(r, "gear_callerbox");
    expect(rowText(r.lcd, 1)).toContain("JOEY:");
    expect(rowText(r.lcd, 2)).toContain("YOUNGSTER");
    expect(rowText(r.lcd, 2, 0, 6).trim()).toBe("");
  });
});
