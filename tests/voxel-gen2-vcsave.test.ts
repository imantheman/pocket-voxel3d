// VC saves for Gold, Silver and Crystal: the Gen 2 save table <-> cartridge
// save converter (voxelmon/game/gen2/vc/), the session's choice at the main
// menu and its SAVE, and -- when the ROMs are on the machine -- the real
// cartridges themselves in the headless emulator (tools/vc2/gbc.ts):
// continuing a save this game wrote, walking out of the building and back
// in, saving there.
//
// Data-gated parts need the Gen 2 imports (dist/voxelmon/{gold,silver,
// crystal}/gen). Environment, all optional, nothing from them is committed:
//   VC2_ROMS=dir         gold.gbc / silver.gbc / crystal.gbc (read only)
//   VC2_CART_SAVES=dir   saves the real cartridges wrote (*gold*, *silver*,
//                        *crystal* in the name), 32 KB each

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import * as L from "../voxelmon/game/gen2/vc/layout.ts";
import { LAYOUTS, sramOfWram } from "../voxelmon/game/gen2/vc/layout.ts";
import { SPRITE_MOVE_DATA } from "../voxelmon/game/gen2/vc/mapctx.ts";
import { cartSummary, cartToSave, checksum, isCartSave, LOSSY, saveToCart, type G2Data } from "../voxelmon/game/gen2/vc/cartsave.ts";
import { Vc } from "../voxelmon/game/gen2/vc/session.ts";
import { romFacts } from "../tools/vc2/romfacts.ts";

const root = join(import.meta.dir, "..");
type G = "gold" | "silver" | "crystal";
const GAMES: G[] = ["gold", "silver", "crystal"];
const engineOf = (g: G): L.Engine => (g === "crystal" ? "crystal" : "gs");

function dataFor(g: G): G2Data | undefined {
  const d = join(root, "dist", "voxelmon", g, "gen");
  if (!existsSync(join(d, "maps.json"))) return undefined;
  const j = (f: string): any => JSON.parse(readFileSync(join(d, `${f}.json`), "utf8"));
  return { pokemon: j("pokemon"), items: j("items"), moves: j("moves"), maps: j("maps"), constants: j("constants"), landmarks: j("landmarks"), sprites: j("sprites"), events: j("events") };
}
const data: Partial<Record<G, G2Data>> = {};
for (const g of GAMES) data[g] = dataFor(g);
const ROMS = process.env.VC2_ROMS;
const romOf = (g: G): Uint8Array | undefined => {
  const p = ROMS ? join(ROMS, `${g}.gbc`) : "";
  return p && existsSync(p) ? new Uint8Array(readFileSync(p)) : undefined;
};
const CART = process.env.VC2_CART_SAVES;
const cartSaves = (g: G): string[] =>
  CART && existsSync(CART) ? readdirSync(CART).filter((f) => f.endsWith(".sav") && f.includes(g) && !f.slice(0, -4).includes(".")) : [];

/** A save table with something in every field the converter maps. */
function richSave(g: G, d: G2Data): any {
  const species = (d.constants!.speciesOrder as string[]).slice(150, 160);
  const mon = (sp: string, level: number, extra: any = {}) => ({
    species: sp, level, experience: level * level * level, otId: 0x1234, ot: "PLAYR", otName: "PLAYR",
    dvs: { attack: 13, defense: 10, speed: 7, special: 3 }, statExp: { hp: 100, attack: 200, defense: 300, speed: 400, special: 500 },
    moves: [{ id: "TACKLE", pp: 30, maxPp: 35, ppUps: 0 }, { id: "SURF", pp: 15, maxPp: 18, ppUps: 1 }],
    happiness: 99, pokerus: 0x21, item: "BERRY", caughtTime: 1, caughtLevel: 5, caughtLocation: 3, caughtByGender: "boy", ...extra,
  });
  return {
    version: g, generation: 2, format: 8,
    player: { name: "PLAYR", id: 0x1234, gender: g === "crystal" ? "female" : "male", money: 123456, coins: 789,
      badges: { ZEPHYR: true, HIVE: true, FOG: true }, kantoBadges: { BOULDER: true } },
    rival: { name: "RIVAL" }, mom: { name: "MOM", savingMoney: true, active: true, savedMoney: 4321, whichItem: 2, triggerBalance: 5000 },
    position: { map: "VIOLET_CITY", x: 18, y: 18, facing: "down" },
    playerState: "normal",
    party: [mon(species[0]!, 30), mon(species[1]!, 12, { nickname: "BUDDY", status: "poison", hp: 20 }), { ...mon(species[2]!, 5), isEgg: true, eggSteps: 7 }],
    boxes: [[mon(species[3]!, 8), mon(species[4]!, 9)], [], [mon(species[5]!, 40)], ...Array.from({ length: 11 }, (_, i) => (i === 10 ? [mon(species[6]!, 50)] : []))],
    currentBox: 3, boxNames: ["BOX1", "MINE", "BOX3"],
    inventory: { POTION: 5, POKE_BALL: 12, BICYCLE: 1, TM_MUD_SLAP: 2, HM_CUT: 1, SQUIRTBOTTLE: 1 },
    bagOrder: ["POTION", "POKE_BALL", "BICYCLE", "TM_MUD_SLAP", "HM_CUT", "SQUIRTBOTTLE"],
    pcItems: { POTION: 3, ANTIDOTE: 2 }, pcOrder: ["POTION", "ANTIDOTE"],
    registeredItem: { id: "BICYCLE" },
    pokedex: { seen: { [species[0]!]: true, [species[7]!]: true }, caught: { [species[0]!]: true, [species[1]!]: true } },
    unownDex: [1, 5, 26], firstUnownSeen: 5, lastDexMode: "A-Z",
    events: { 3: 0x81, 100: 0x42, 220: 0xff }, engineFlags: { 0: true, 2: true, 11: true, 64: true, 66: true },
    mapScenes: { NEW_BARK_TOWN: 1, ELMS_LAB: 2, PLAYERS_HOUSE_1F: 1 },
    scriptMem: {}, variableSprites: { 4: 0x52 },
    playTime: { hours: 300, minutes: 59, seconds: 1, frames: 30 },
    rtc: { dst: true },
    dayCare: { man: { mon: mon(species[8]!, 20), introSeen: true }, lady: { mon: mon(species[9]!, 21) }, hasEgg: false, compatible: true, stepsToEgg: 9 },
    roamers: [{ species: "RAIKOU", level: 40, map: "ROUTE_36", hp: 99 }, {}, { species: "SUICUNE", level: 40, map: "ROUTE_42", hp: 0 }],
    hallOfFame: { count: 2, teams: [{ winCount: 2, mons: [{ species: species[0], otId: 0x1234, dvs: { attack: 1, defense: 2, speed: 3, special: 4 }, level: 50, nickname: "HERO" }] }] },
    phone: { list: [1, 4, 0, 0, 0, 0, 0, 0, 0, 0] }, phoneContacts: { 1: true, 4: true },
    tradeFlags: { 2: true }, decorations: { bed: 2, poster: 16 },
    backupWarp: { map: "VIOLET_CITY", warp: 1 }, blackoutMap: "VIOLET_POKECENTER_1F",
    options: { textSpeed: "FAST", battleScene: false, battleStyle: "SET", sound: "STEREO", frame: 3, print: "DARKER", menuAccount: false },
  };
}

describe("the Gen 2 cartridge layout", () => {
  test("the blocks and the documented anchors", () => {
    const gs = LAYOUTS.gs, c = LAYOUTS.crystal;
    expect(gs.blocks.map((b) => b.sram + b.len)).toEqual([0x2856, 0x288a, 0x2d69]);
    expect(c.blocks.map((b) => b.sram + b.len)).toEqual([0x2833, 0x2865, 0x2b83]);
    expect([gs.money, gs.badges, gs.partyCount, gs.dexCaught, gs.dexSeen, gs.curBox, gs.boxNames]).toEqual([0x23db, 0x23e4, 0x288a, 0x2a4c, 0x2a6c, 0x2724, 0x2727]);
    expect([c.money, c.badges, c.partyCount, c.dexCaught, c.dexSeen, c.curBox, c.boxNames]).toEqual([0x23dc, 0x23e5, 0x2865, 0x2a27, 0x2a47, 0x2700, 0x2703]);
    expect([gs.mapGroup, gs.screenSave, gs.box, gs.checksum]).toEqual([0x2868, 0x286c, 0x2d6c, 0x2d69]);
    expect([c.mapGroup, c.screenSave, c.box, c.checksum]).toEqual([0x2843, 0x2847, 0x2d10, 0x2d0d]);
    // the walk by field size lands on the next anchors
    expect(gs.roamers + 2).toBe(0x2b84);
    expect(c.roamers + 2).toBe(0x2b5f);
    expect(gs.magikarpHolder + L.NAME_LEN).toBeLessThanOrEqual(gs.mainEnd);
    expect(c.magikarpHolder + L.NAME_LEN).toBe(c.mainEnd);
    // the backup copy covers exactly the main data
    for (const Lo of [gs, c]) expect(Lo.backup.reduce((n, [, , len]) => n + len, 0)).toBe(Lo.mainEnd - Lo.main);
    // the engine flags: 93 rows for Gold and Silver, 162 for Crystal; the
    // badges at 26 / 27, the female flag outside the saved blocks (its own byte)
    expect(gs.engineFlags.length).toBe(93);
    expect(c.engineFlags.length).toBe(162);
    expect(gs.engineFlags[26]).toEqual([0x23e4, 1]);
    expect(c.engineFlags[27]).toEqual([0x23e5, 1]);
    expect(sramOfWram(gs, 0xd1a1)).toBe(0x2009);
    expect(L.LAYOUTS.gs.scenes.ELMS_LAB).toBe(0x2534);
    expect(L.LAYOUTS.crystal.scenes.ELMS_LAB).toBe(0x2515);
  });

  for (const g of GAMES) {
    test.skipIf(!romOf(g))(`${g}: every table matches the ROM`, () => {
      const f = romFacts(romOf(g)!);
      const Lo = LAYOUTS[engineOf(g)];
      expect(f.blocks).toEqual(Lo.blocks);
      // the scene table: map by (group, map) -> the main offset
      const maps = data[g]!.maps;
      for (const s of f.scenes) {
        const id = Object.keys(maps).find((k) => maps[k]!.group === s.group && maps[k]!.map === s.map)!;
        expect(Lo.scenes[id]).toBe(sramOfWram(Lo, s.wram)!);
      }
      expect(f.scenes.length).toBe(Object.keys(Lo.scenes).length);
      // the engine flag table, from its badge rows back to its first row
      const rom = romOf(g)!;
      const badge = Lo.engine === "crystal" ? 0xd857 : 0xd57c;
      let at = -1;
      for (let i = 0; i < rom.length - 9 && at < 0; i++) {
        if (rom[i] === (badge & 0xff) && rom[i + 1] === badge >> 8 && rom[i + 2] === 1 && rom[i + 3] === (badge & 0xff) && rom[i + 5] === 2) at = i;
      }
      const first = at - (Lo.engine === "crystal" ? 27 : 26) * 3;
      Lo.engineFlags.forEach((row, id) => {
        const w = rom[first + id * 3]! | (rom[first + id * 3 + 1]! << 8);
        const m = rom[first + id * 3 + 2]!;
        if (row) expect([row[0], row[1]]).toEqual([sramOfWram(Lo, w)!, m]);
        else expect(sramOfWram(Lo, w)).toBeNull();
      });
      // SpriteMovementData
      let smd = -1;
      for (let i = 0; i < rom.length - 6 * 40 && smd < 0; i++) {
        if (SPRITE_MOVE_DATA.slice(0, 0x26).every((r, k) => r.every((v, j) => rom[i + k * 6 + j] === v))) smd = i;
      }
      expect(smd).toBeGreaterThan(0);
    });
  }

  test("checksums: the 16-bit sum, and a blank or Gen 1 save is no Gen 2 save", () => {
    expect(checksum(new Uint8Array([200, 100, 3]), 0, 3)).toBe(303);
    for (const e of ["gs", "crystal"] as const) {
      expect(isCartSave(new Uint8Array(L.SAVE_SIZE).fill(0xff), e)).toBe(false);
      expect(isCartSave(new Uint8Array(L.SAVE_SIZE), e)).toBe(false);
      expect(cartSummary(new Uint8Array(100), e)).toBeNull();
    }
  });
});

describe("the converter", () => {
  for (const g of GAMES) {
    test.skipIf(!data[g])(`${g}: every mapped field there and back`, () => {
      const d = data[g]!;
      const s = richSave(g, d);
      const w = saveToCart(s, d, g, null);
      expect(isCartSave(w.bytes, engineOf(g))).toBe(true);
      const Lo = LAYOUTS[engineOf(g)];
      // checks the converter's sums against an independent sum of each copy
      let main = 0;
      for (let i = Lo.main; i < Lo.mainEnd; i++) main += w.bytes[i]!;
      expect(w.bytes[Lo.checksum]! | (w.bytes[Lo.checksum + 1]! << 8)).toBe(main & 0xffff);
      let bk = 0;
      for (const [o, , n] of Lo.backup) for (let i = o; i < o + n; i++) bk += w.bytes[i]!;
      expect(w.bytes[Lo.backupChecksum]! | (w.bytes[Lo.backupChecksum + 1]! << 8)).toBe(bk & 0xffff);
      const back = cartToSave(w.bytes, d, g).save;
      expect(back.player.name).toBe("PLAYR");
      expect(back.player.id).toBe(0x1234);
      expect(back.player.money).toBe(123456);
      expect(back.player.coins).toBe(789);
      expect(back.player.gender).toBe(g === "crystal" ? "female" : "male");
      expect(back.player.badges).toEqual({ ZEPHYR: true, HIVE: true, FOG: true });
      expect(back.player.kantoBadges).toEqual({ BOULDER: true });
      expect(back.rival.name).toBe("RIVAL");
      expect(back.party.map((m: any) => [m.species, m.level, m.item, m.isEgg ?? false])).toEqual(s.party.map((m: any) => [m.species, m.level, m.isEgg ? "BERRY" : "BERRY", m.isEgg ?? false]));
      expect(back.party[1].nickname).toBe("BUDDY");
      expect(back.party[1].status).toBe("poison");
      expect(back.party[1].hp).toBe(20);
      expect(back.party[2].eggSteps).toBe(7);
      expect(back.party[0].moves.map((m: any) => [m.id, m.pp, m.ppUps])).toEqual([["TACKLE", 30, 0], ["SURF", 15, 1]]);
      expect(back.party[0].dvs).toMatchObject({ attack: 13, defense: 10, speed: 7, special: 3 });
      expect(back.party[0].statExp).toEqual({ hp: 100, attack: 200, defense: 300, speed: 400, special: 500 });
      expect(back.party[0].pokerus).toBe(0x21);
      if (g === "crystal") expect([back.party[0].caughtTime, back.party[0].caughtLevel, back.party[0].caughtLocation]).toEqual([1, 5, 3]);
      expect(back.boxes.map((b: any[]) => b.map((m) => `${m.species}/${m.level}`))).toEqual(s.boxes.map((b: any[]) => b.map((m) => `${m.species}/${m.level}`)));
      expect(back.currentBox).toBe(3);
      expect(back.boxNames[1]).toBe("MINE");
      expect(back.inventory).toEqual(s.inventory);
      expect(back.pcItems).toEqual(s.pcItems);
      expect(back.registeredItem).toEqual({ id: "BICYCLE" });
      expect(back.pokedex).toEqual({ seen: { ...s.pokedex.seen, ...s.pokedex.caught }, caught: s.pokedex.caught });
      expect([back.unownDex, back.firstUnownSeen, back.lastDexMode]).toEqual([[1, 5, 26], 5, "A-Z"]);
      expect(back.events).toEqual(s.events);
      for (const id of [0, 2, 11, 64, 66]) expect(back.engineFlags[id]).toBe(true);
      expect(Object.fromEntries(Object.entries(back.mapScenes).filter(([, v]) => v))).toEqual(s.mapScenes);
      expect(back.variableSprites[4]).toBe(0x52);
      expect(back.playTime).toEqual(s.playTime);
      expect(back.rtc.dst).toBe(true);
      expect(back.mom).toMatchObject({ savingMoney: true, active: true, savedMoney: 4321, whichItem: 2, triggerBalance: 5000 });
      expect(back.dayCare.man.mon.species).toBe(s.dayCare.man.mon.species);
      expect(back.dayCare.lady.mon.species).toBe(s.dayCare.lady.mon.species);
      expect([back.dayCare.man.introSeen, back.dayCare.compatible, back.dayCare.stepsToEgg]).toEqual([true, true, 9]);
      expect(back.roamers[0]).toMatchObject({ species: "RAIKOU", level: 40, map: "ROUTE_36", hp: 99 });
      expect(back.roamers[1].species).toBeUndefined();
      expect(back.hallOfFame.count).toBe(2);
      expect(back.hallOfFame.teams[0].mons[0]).toMatchObject({ species: s.hallOfFame.teams[0].mons[0].species, level: 50, nickname: "HERO" });
      expect(back.phone.list.slice(0, 3)).toEqual([1, 4, 0]);
      expect(back.tradeFlags).toEqual({ 2: true });
      expect(back.decorations).toEqual({ bed: 2, poster: 16 });
      expect(back.position).toMatchObject({ map: "VIOLET_CITY", x: 18, y: 18 });
      expect(back.backupWarp).toEqual({ map: "VIOLET_CITY", warp: 1 });
      expect(back.blackoutMap).toBe("VIOLET_POKECENTER_1F");
      expect(back.options).toMatchObject({ textSpeed: "FAST", battleScene: false, battleStyle: "SET", sound: "STEREO", frame: 3, print: "DARKER", menuAccount: false });
      // and written again over itself: not one byte moves
      const again = saveToCart(back, d, g, w.bytes);
      expect(Buffer.compare(Buffer.from(again.bytes), Buffer.from(w.bytes))).toBe(0);
      const sum = cartSummary(w.bytes, engineOf(g))!;
      expect(sum).toMatchObject({ name: "PLAYR", badges: 4, caught: 2, hours: 300, minutes: 59 });
    });

    test.skipIf(!data[g])(`${g}: key items one each; unknown things left out with a note`, () => {
      const d = data[g]!;
      const s = richSave(g, d);
      s.inventory.BICYCLE = 3;
      s.party.push({ species: "NOT_A_SPECIES", level: 5 });
      s.inventory.NOT_AN_ITEM = 4;
      const w = saveToCart(s, d, g, null);
      expect(w.notes.some((n) => n.includes("NOT_A_SPECIES"))).toBe(true);
      expect(w.notes.some((n) => n.includes("NOT_AN_ITEM"))).toBe(true);
      const back = cartToSave(w.bytes, d, g).save;
      expect(back.inventory.BICYCLE).toBe(1);
      expect(back.party.length).toBe(3);
      // a key item doubled on the cartridge (a glitch count) reads back as one
      const Lo = LAYOUTS[engineOf(g)];
      const b = w.bytes.slice();
      const n = b[Lo.numKeyItems]!;
      b[Lo.numKeyItems + 1 + n] = d.items.BICYCLE.index;
      b[Lo.numKeyItems + 2 + n] = 0xff;
      b[Lo.numKeyItems] = n + 1;
      // a glitch species in a box: left out, with a note
      b[Lo.boxBanks[0]! + 1 + 22] = 0; // (box 1 holds 2: their species list is not read for mons)
      b[Lo.boxBanks[0]! + 22] = 0xfe;
      let sum = 0;
      for (let i = Lo.main; i < Lo.mainEnd; i++) sum += b[i]!;
      b[Lo.checksum] = sum & 0xff;
      b[Lo.checksum + 1] = (sum >> 8) & 0xff;
      const r = cartToSave(b, d, g);
      expect(r.save.inventory.BICYCLE).toBe(1);
      expect(r.notes.some((x) => x.includes("species index 254"))).toBe(true);
    });

    test.skipIf(!data[g])(`${g}: random saves never throw`, () => {
      const d = data[g]!;
      const Lo = LAYOUTS[engineOf(g)];
      let seed = 7;
      const rnd = (): number => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24;
      for (let k = 0; k < 10; k++) {
        const b = new Uint8Array(L.SAVE_SIZE).map(() => rnd());
        b[Lo.check1] = 0x63;
        b[Lo.check2] = 0x7f;
        const s = checksum(b, Lo.main, Lo.mainEnd);
        b[Lo.checksum] = s & 0xff;
        b[Lo.checksum + 1] = s >> 8;
        expect(isCartSave(b, engineOf(g))).toBe(true);
        let out: any;
        try { out = cartToSave(b, d, g); } catch (e) { out = { err: String(e) }; }
        // an unknown map is the one thing it cannot continue from: said so
        if (out.err) expect(out.err).toContain("not a cartridge save");
        else expect(out.save.party.length).toBeLessThanOrEqual(6);
      }
    });
  }

  test("LOSSY names what does not cross", () => {
    expect(LOSSY.length).toBeGreaterThan(5);
    expect(LOSSY.some((l) => l.includes("clock"))).toBe(true);
    expect(LOSSY.some((l) => l.includes("key items"))).toBe(true);
  });

  for (const g of GAMES) {
    test.skipIf(!data[g] || cartSaves(g).length === 0)(`${g}: the real cartridge saves read and write back byte for byte`, () => {
      for (const f of cartSaves(g)) {
        const raw = new Uint8Array(readFileSync(join(CART!, f)));
        const { save } = cartToSave(raw, data[g]!, g);
        const w = saveToCart(save, data[g]!, g, raw);
        expect(`${f}: ${Buffer.compare(Buffer.from(w.bytes), Buffer.from(raw.subarray(0, L.SAVE_SIZE)))}`).toBe(`${f}: 0`);
      }
    });
  }
});

describe("the main menu and SAVE with a VC title", () => {
  const goldData = data.gold;
  test.skipIf(!goldData)("CONTINUE asks LUA SAVE / VC SAVE; the VC session saves there, tagged; NEW GAME asks and confirms", async () => {
    const { rig } = await import("./gen2-ui-d-harness.ts");
    const { MainMenu } = await import("../voxelmon/game/gen2/ui/MainMenu.ts");
    const { SaveMenu } = await import("../voxelmon/game/gen2/ui/SaveMenu.ts");
    const { Save } = await import("../voxelmon/game/gen2/core/Save.ts");
    const { setSaveIo, memorySaveIo } = await import("../voxelmon/game/gen2/platform/saveio.ts");
    const r = await rig();
    const game = r.game;
    // a VC title holding a game, and a Lua save beside it
    const vcSave = saveToCart(richSave("gold", goldData!), goldData!, "gold", null).bytes;
    const writes: Uint8Array[] = [];
    Vc.reset();
    Vc.setHost({ data: () => vcSave, write: (b) => { writes.push(b.slice()); return true; }, err: () => "", info: () => "test" });
    setSaveIo(memorySaveIo());
    const lua = Save.newGame({ playerName: "LUAGUY" });
    lua.rtc = { startMinute: 30, startDay: 2 };
    let chosen = "";
    const mk = (): any => MainMenu.new(game, {
      save: lua, hasSave: true,
      onContinue: () => (chosen = "lua"),
      onContinueVc: () => (chosen = "vc"),
      onNewGame: () => (chosen = "new-lua"),
      onNewGameVc: () => (chosen = "new-vc"),
    });
    let menu = mk();
    game.stack.clear();
    game.stack.push(menu);
    r.press("a"); // CONTINUE
    expect(menu.phase).toBe("pick");
    expect(menu.pick.map((p: any) => p.label)).toEqual(["LUA SAVE", "VC SAVE"]);
    r.draw();
    r.press("b");
    expect(menu.phase).toBe("menu");
    r.press("a");
    r.press("down");
    r.press("a");
    expect(chosen).toBe("vc");
    // NEW GAME: the choice, then VC over a game -> the question, NO first
    menu = mk();
    game.stack.clear();
    game.stack.push(menu);
    r.press("down");
    r.press("a");
    expect([menu.phase, menu.pickFor]).toEqual(["pick", "new"]);
    r.press("down");
    r.press("a");
    expect(menu.phase).toBe("replace");
    expect(menu.replaceChoice).toBe(2);
    r.press("a"); // NO: back to the choice
    expect(menu.phase).toBe("pick");
    r.press("a"); // VC SAVE again
    r.press("up"); // YES
    r.press("a");
    expect(chosen).toBe("new-vc");
    // no VC title: the menu as it always was
    Vc.reset();
    menu = mk();
    game.stack.clear();
    game.stack.push(menu);
    r.press("a");
    expect(menu.phase).toBe("confirm");

    // the VC session: CONTINUE converts, SAVE writes the VC title (tagged)
    Vc.setHost({ data: () => vcSave, write: (b) => { writes.push(b.slice()); return true; }, err: () => "", info: () => "test" });
    game.continueVc(lua);
    for (let i = 0; i < 3; i++) r.frame();
    expect(Vc.target()).toBe("vc");
    expect(game.save.player.name).toBe("PLAYR");
    expect(game.save.rtc.startMinute).toBe(30); // this game's clock from the Lua save
    const sm: any = SaveMenu.new(game, { save: game.snapshotSave(), writer: () => game.writeSave(), existed: false });
    sm.phase = "saving";
    for (let i = 0; i < 200 && sm.phase !== "done"; i++) sm.update();
    expect(writes.length).toBe(1);
    expect(isCartSave(writes[0]!, "gs")).toBe(true);
    expect(sm.promptText()).toContain("(VC)");
    // the Lua file was never touched
    expect(Save.exists()).toBe(true); // (the VC title's)
    Vc.useLua();
    expect(Save.exists()).toBe(false);
    Vc.reset();
  });

  test.skipIf(!goldData)("COPY SAVE: both ways, the destination kept first, NO first, nothing written on a failure", async () => {
    const { rig } = await import("./gen2-ui-d-harness.ts");
    const { MainMenu } = await import("../voxelmon/game/gen2/ui/MainMenu.ts");
    const { Save } = await import("../voxelmon/game/gen2/core/Save.ts");
    const { setSaveIo, memorySaveIo } = await import("../voxelmon/game/gen2/platform/saveio.ts");
    const r = await rig();
    const game = r.game;
    const vcSave = saveToCart(richSave("gold", goldData!), goldData!, "gold", null).bytes;
    const cartOpts = cartToSave(vcSave, goldData!, "gold").save.options;
    let vcNow: Uint8Array = vcSave;
    const writes: Uint8Array[] = [];
    let refuse = false;
    const host = { data: () => vcNow, write: (b: Uint8Array) => { if (refuse) return false; writes.push(b.slice()); vcNow = b.slice(); return true; }, err: () => (refuse ? "commit failed" : ""), info: () => "test" };
    Vc.reset();
    Vc.setHost(host);
    const io = memorySaveIo();
    setSaveIo(io);
    const lua = Save.newGame({ playerName: "LUAGUY" });
    lua.rtc = { startMinute: 30, startDay: 2 };
    lua.options = { ...game.options, screenPos: "left", textSpeed: "SLOW" };
    expect(Save.save(lua)[0]).toBe(true);
    const luaText = io.text;
    const menu = (): any => {
      game.showMainMenu();
      return game.stack.top();
    };
    const top = (): any => game.stack.top();
    // YES: "Copying..." for 60 frames, then the copy
    const yes = (): void => {
      r.press("a");
      expect(top().phase).toBe("copying");
      for (let i = 0; i < 70; i++) r.frame();
    };

    // the row and its directions
    let m = menu();
    const labels = m.list.items.map((i: any) => i.label);
    expect(labels.indexOf("COPY SAVE")).toBe(labels.indexOf("NEW GAME") + 1); // as the Gen 1 games
    m.list.index = labels.indexOf("COPY SAVE") + 1;
    r.press("a");
    expect(m.phase).toBe("copy");
    expect(m.copyRows.map((c: any) => c.label)).toEqual(["LUA TO VC", "VC TO LUA", "CANCEL"]);
    r.draw();
    r.press("down"); // VC TO LUA
    r.press("a");
    expect([m.phase, m.copyDir, m.copyChoice]).toEqual(["copyConfirm", "toLua", 2]);
    r.draw();
    r.press("a"); // NO: back to the directions, nothing written
    expect(m.phase).toBe("copy");
    expect(io.text).toBe(luaText);
    r.press("a");
    r.press("up"); // YES
    r.draw();
    yes();
    // VC TO LUA: the Lua save kept, then the VC game in the Lua file
    expect(top().screenId ?? "").not.toBe("Gen2MainMenu"); // the text box on top
    expect(io.kept).toEqual([luaText!]);
    let [now] = Save.load();
    expect(now!.player.name).toBe("PLAYR");
    expect(now!.rtc.startMinute).toBe(30); // this game's clock base kept
    expect(now!.options.screenPos).toBe("left"); // the port's options kept
    expect(now!.options.textSpeed).toBe(cartOpts.textSpeed); // the cartridge's come over
    expect(writes.length).toBe(0);
    // the title read afresh: CONTINUE's Lua summary is the copied game
    game.stack.pop();
    m = top();
    expect(Save.summary(m.save)!.name).toBe("PLAYR");
    expect(m.list.items[m.list.index - 1].value).toBe("copy"); // the cursor back on COPY SAVE

    // LUA TO VC over another trainer's VC game: built afresh, VC written
    expect(Save.save(lua)[0]).toBe(true);
    m = menu();
    m.copyDir = "toVc";
    m.phase = "copyConfirm";
    m.copyChoice = 2;
    r.draw();
    r.press("up");
    yes();
    expect(writes.length).toBe(1);
    expect(cartSummary(writes[0]!, "gs")!.name).toBe("LUAGUY");
    expect(Vc.summary()!.name).toBe("LUAGUY");
    expect(io.text).toBe(luaText); // the Lua file untouched

    // a VC write that fails: nothing changes, a text box says why
    refuse = true;
    m = menu();
    m.copyDir = "toVc";
    m.phase = "copyConfirm";
    m.copyChoice = 1;
    yes();
    expect(writes.length).toBe(1);
    expect(Vc.summary()!.name).toBe("LUAGUY");
    refuse = false;
    // a Lua backup that fails: the Lua file is not written
    game.stack.clear();
    const io2 = { ...memorySaveIo(luaText), keepCopy: () => false, writeErr: () => "card full" };
    let wrote = false;
    io2.write = (t: string) => { wrote = true; io2.text = t; return true; };
    setSaveIo(io2);
    m = menu();
    m.copyDir = "toLua";
    m.phase = "copyConfirm";
    m.copyChoice = 1;
    yes();
    expect(wrote).toBe(false);

    // the failure texts (the Gen 1 games' words)
    const G2 = game.constructor as any;
    expect(G2.copyFailText("toVc", { ok: false, stage: "write", why: "commit failed" })).toBe("The VC save did\nnot take it.\fcommit failed\fThe VC save is\nleft as it was.");
    expect(G2.copyFailText("toLua", { ok: false, stage: "backup", why: "card full" })).toBe("The LUA save could\nnot be backed up.\fcard full\fNothing was\ncopied.");
    expect(G2.copyFailText("toLua", { ok: false, stage: "write", why: "x", kept: true })).toContain("A copy of the old\nLUA save is kept.");

    // only the directions whose source holds a game
    setSaveIo(memorySaveIo());
    m = menu();
    expect(m.copyDirections().map((d: any) => d.id)).toEqual(["toLua"]);
    Vc.reset();
    Vc.setHost({ ...host, data: () => new Uint8Array(0x8000) });
    setSaveIo(memorySaveIo(luaText));
    m = menu();
    expect(m.copyDirections().map((d: any) => d.id)).toEqual(["toVc"]);
    Vc.reset();
    m = menu();
    expect(m.list.items.map((i: any) => i.label)).not.toContain("COPY SAVE");
    setSaveIo(memorySaveIo());
  });
});

// ---------------------------------------------------------------- the real cartridges

describe("the real cartridges (headless)", () => {
  for (const g of GAMES) {
    test.skipIf(!data[g] || !romOf(g))(`${g}: a new game's save from here continues, walks and saves on the cartridge`, async () => {
      const { Cart, BTN } = await import("../tools/vc2/cart.ts");
      const d = data[g]!;
      const s = richSave(g, d);
      s.position = { map: "NEW_BARK_TOWN", x: 13, y: 6, facing: "down" };
      const w = saveToCart(s, d, g, null);
      const c = new Cart(g, join(ROMS!, `${g}.gbc`), w.bytes);
      const Lo = LAYOUTS[engineOf(g)];
      c.run(700);
      expect(c.mashUntil(BTN.START, () => c.shows("CONTINUE"), 600, 30)).toBe(true);
      c.pick("CONTINUE");
      c.run(60);
      c.press(BTN.A, 4, 30);
      c.run(240);
      expect([c.ram(Lo.mapGroup), c.ram(Lo.mapNumber), c.ram(Lo.x), c.ram(Lo.y)]).toEqual([24, 4, 13, 6]);
      // into the house and out again
      for (let i = 0; i < 3; i++) { c.run(16, BTN.UP); c.run(4); }
      c.run(120);
      expect(c.ram(Lo.mapNumber)).toBe(6);
      for (let i = 0; i < 3; i++) { c.run(16, BTN.DOWN); c.run(4); }
      c.run(120);
      expect(c.ram(Lo.mapNumber)).toBe(4);
      expect(c.saveGame()).toBe(true);
      const back = c.sram();
      expect(isCartSave(back, engineOf(g))).toBe(true);
      const b2 = cartToSave(back, d, g).save;
      expect(b2.party.length).toBe(3);
      expect(b2.boxes.flat().length).toBe(4);
      expect(b2.player.money).toBe(123456);
    }, 120000);
  }
});
