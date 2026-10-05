// The FireRed runtime port, cluster "data and save": pokemon, party, storage,
// bag, dex, items, evolution, breeding, day care, move learning, mail, the
// save schema, sections and mon fix-ups, summary/pokedex data, rom text, easy
// chat, fame checker, heal locations, help, quest log, options, rng, map ids,
// battle bridge/downgrade, trainer pics. Real data from ~/gen3ref/frfull.
// Modules that reach an unported neighbour are tested up to the NotPortedError.
import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Bag } from "../voxelmon/game/gen3/core/bag.ts";
import { BattleBridge } from "../voxelmon/game/gen3/core/battle_bridge.ts";
import { Downgrade } from "../voxelmon/game/gen3/core/battle_downgrade.ts";
import { Constants } from "../voxelmon/game/gen3/core/constants.ts";
import { Dex } from "../voxelmon/game/gen3/core/dex.ts";
import { EasyChatText } from "../voxelmon/game/gen3/core/easy_chat_text.ts";
import { Evolution } from "../voxelmon/game/gen3/core/evolution.ts";
import FameChecker from "../voxelmon/game/gen3/core/fame_checker.ts";
import { Items } from "../voxelmon/game/gen3/core/items.ts";
import { ItemsData } from "../voxelmon/game/gen3/core/items_data.ts";
import Mail from "../voxelmon/game/gen3/core/mail.ts";
import { MapIds } from "../voxelmon/game/gen3/core/map_ids.ts";
import { MoveLearn } from "../voxelmon/game/gen3/core/move_learn.ts";
import Options from "../voxelmon/game/gen3/core/options.ts";
import { Party } from "../voxelmon/game/gen3/core/party.ts";
import { PokedexData } from "../voxelmon/game/gen3/core/pokedex_data.ts";
import { Pokemon } from "../voxelmon/game/gen3/core/pokemon.ts";
import { FireredRules } from "../voxelmon/game/gen3/core/profiles/firered_rules.ts";
import Q from "../voxelmon/game/gen3/core/quest_log.ts";
import { Rng } from "../voxelmon/game/gen3/core/rng.ts";
import { RomText } from "../voxelmon/game/gen3/core/rom_text.ts";
import { save_mon as SaveMon } from "../voxelmon/game/gen3/core/save_mon.ts";
import { Schema } from "../voxelmon/game/gen3/core/save_schema_firered.ts";
import { SaveSections } from "../voxelmon/game/gen3/core/save_sections.ts";
import { TextIR } from "../voxelmon/game/gen3/core/scripting/text_ir.ts";
import { Storage } from "../voxelmon/game/gen3/core/storage.ts";
import { SummaryData } from "../voxelmon/game/gen3/core/summary_data.ts";
import { TrainerPic } from "../voxelmon/game/gen3/core/trainer_pic.ts";
import { NotPortedError } from "../voxelmon/game/gen3/notported.ts";
import BreedingMod from "../voxelmon/game/gen3/core/breeding.ts";
import DaycareMod from "../voxelmon/game/gen3/core/daycare.ts";
import HealLocationsMod from "../voxelmon/game/gen3/core/heal_locations.ts";
import HelpRulesMod from "../voxelmon/game/gen3/core/help_rules.ts";
import QuestLogRecorderMod from "../voxelmon/game/gen3/core/quest_log_recorder.ts";
import { DesktopHost } from "../voxelmon/game/gen3/platform/desktop.ts";
import { getHost, setHost } from "../voxelmon/game/gen3/platform/host.ts";
import { len, seq, toArray } from "../voxelmon/game/gen3/platform/lt.ts";
import { luaLoad } from "../voxelmon/game/gen3/platform/luadata.ts";
import { CacheFs as ImportCacheFs } from "../voxelmon/import/gen3/cache.ts";
import { makeCache } from "../voxelmon/import/gen3/fsio.ts";

// ---------------------------------------------------------------- rng, save sections, save_mon, save schema
{

const ROOT = join(homedir(), "gen3ref/frfull");

/** The GBA LCG straight from pret's formula, in BigInt. */
function lcg(state: bigint, add: bigint): bigint {
  return (state * 0x41C64E6Dn + add) & 0xFFFFFFFFn;
}

describe("gen3 rt data: rng", () => {
  test("Random() follows gRngValue = gRngValue * 0x41C64E6D + 0x6073", () => {
    Rng.SeedRng(0x1234);
    let s = 0x1234n;
    for (let i = 0; i < 1000; i++) {
      s = lcg(s, 0x6073n);
      expect(Rng.Random()).toBe(Number(s >> 16n));
      expect(Rng._value).toBe(Number(s));
    }
  });
  test("WildEncounterRandom uses ISO_RANDOMIZE2 (0x3039), Random2 its own state", () => {
    Rng.SeedWildEncounterRng(0xBEEF);
    Rng.SeedRng2(7);
    let w = 0xBEEFn, r2 = 7n;
    for (let i = 0; i < 200; i++) {
      w = lcg(w, 0x3039n);
      r2 = lcg(r2, 0x6073n);
      expect(Rng.WildEncounterRandom()).toBe(Number(w >> 16n));
      expect(Rng.Random2()).toBe(Number(r2 >> 16n));
    }
  });
  test("mulU32 is exact; seeds are u16; state round-trips", () => {
    expect(Rng.mulU32(0xFFFFFFFF, 0xFFFFFFFF)).toBe(1);
    expect(Rng.mulU32(0xDEADBEEF, 1103515245)).toBe(Number((0xDEADBEEFn * 1103515245n) & 0xFFFFFFFFn));
    Rng.SeedRng(0x12345);
    expect(Rng._value).toBe(0x2345);
    const st = Rng.getState();
    const a = [Rng.Random(), Rng.Random32(), Rng.mod(100), Rng.compat(1, 6)];
    expect(Rng.setState(st)).toBe(true);
    expect([Rng.Random(), Rng.Random32(), Rng.mod(100), Rng.compat(1, 6)]).toEqual(a);
    expect(Rng.setState({ value: 1 })).toBe(false);
    const session: Record<string, any> = {};
    Rng.captureToSession(session);
    expect(Rng.restoreFromSession(session)).toBe(true);
  });
  test("seedNewGame: trainer id = the seed, wild stream seeded from Random()", () => {
    expect(Rng.seedNewGame({ seed: 0x7A2B })).toBe(0x7A2B);
    const first = Number(lcg(0x7A2Bn, 0x6073n) >> 16n);
    expect(Rng._wild).toBe(first);
  });
});

describe("gen3 rt data: save sections", () => {
  test("FireRed's profile lists no sections; a registered section copies deeply", () => {
    expect(SaveSections.of("firered")).toEqual([null]);
    const def = SaveSections.fields([null, "a", "b"], (s) => { s.a = [null, 1]; });
    const session: Record<string, any> = { a: [null, 1, { x: 2 }], b: { k: "v" }, c: 3 };
    const out: Record<string, any> = {};
    def.export!(session, out);
    expect(out).toEqual({ a: [null, 1, { x: 2 }], b: { k: "v" } });
    expect(out.a).not.toBe(session.a);
    const back: Record<string, any> = {};
    def.restore!(out, back);
    expect(back).toEqual({ a: [null, 1, { x: 2 }], b: { k: "v" } });
    expect(() => SaveSections.register("", {})).toThrow();
  });
});

describe.skipIf(!existsSync(ROOT))("gen3 rt data: save schema", () => {
  setHost(new DesktopHost(ROOT));
  test("rules: FireRed's", () => {
    expect(Schema.rulesFor("firered")).toBe(FireredRules);
    expect(Schema.rulesFor("leafgreen")).toBe(FireredRules);
    expect(FireredRules.newGameMoney()).toBe(3000);
    const [f, w] = FireredRules.saveWarpFields({ map: "FR_TRADE_CENTER", specialSaveWarpFlags: 0,
      dynamicWarp: { map: "FR_PALLET_TOWN", warpId: 1, x: "5", y: 7 } });
    expect(f).toBe(1);
    expect(w).toEqual({ map: "FR_PALLET_TOWN", warpId: 1, x: 5, y: 7 });
    const s: Record<string, any> = { specialSaveWarpFlags: 3, continueGameWarp: { map: "FR_ROUTE1", x: 4, y: "9" } };
    FireredRules.useContinueGameWarp(s, true);
    expect(s).toMatchObject({ specialSaveWarpFlags: 2, map: "FR_ROUTE1", x: 4, y: 9, facing: "down" });
    const u: Record<string, any> = { map: "FR_UNION_ROOM", healMap: "FR_CERULEAN_CITY_POKEMON_CENTER_1F" };
    FireredRules.useContinueGameWarp(u, true);
    expect(u).toMatchObject({ map: "FR_CERULEAN_CITY_POKEMON_CENTER_2F", x: 5, y: 1 });
  });
  test("hasNoneItemSlot and purge", () => {
    expect(Schema.hasNoneItemSlot({ pockets: { items: [null, { id: 13, qty: 1 }] } })).toBe(false);
    expect(Schema.hasNoneItemSlot({ stacks: { 0: 2 } })).toBe(true);
    const save = { flags: { 1039: true, "1050": true, 1051: true } as Record<string, boolean> };
    FireredRules.purgeNoneItemFlags(save);
    expect(save.flags).toEqual({ 1039: true, 1050: true });
  });
});

describe.skipIf(!existsSync(ROOT))("gen3 rt data: save_mon", () => {
  setHost(new DesktopHost(ROOT));
  Pokemon.install({ read: (rel: string) => getHost().read(rel) });
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

  test("normalize: stats and PP filled; a saved copy normalizes to the same mon", () => {
    const mon: Record<string, any> = {
      species: 25, level: 10, personality: 0, hp: 99,
      ivs: { hp: 31, atk: 31, def: 31, spe: 31, spa: 31, spd: 31 },
      moves: [null, { id: 84, pp: 7 }, { moveId: 45 }],
    };
    SaveMon.normalize(mon);
    expect(mon.speciesNumbering).toBe("internal");
    expect(mon.species).toBe(25);
    // pokefirered CalculateMonStats, Hardy nature, L10, 31 IVs: HP 35 -> 34, Spe 90 -> 26
    expect(mon.maxHp).toBe(Math.floor((2 * 35 + 31) * 10 / 100) + 10 + 10);
    expect(mon.speed).toBe(Math.floor((2 * 90 + 31) * 10 / 100) + 5);
    expect(mon.hp).toBe(mon.maxHp); // clamped
    expect(mon.stats).toMatchObject({ hp: mon.maxHp, speed: mon.speed, specialAttack: mon.spAtk });
    expect(mon.pp).toEqual([null, 7, 40]);
    expect(mon.maxPp).toEqual([null, 30, 40]);
    const again = SaveMon.normalize(clone(mon));
    expect(again).toEqual(mon);
  });

  test("normalize: national numbering and a 32-bit OT id", () => {
    const mon = SaveMon.normalize({ species: 252, speciesNumbering: "national", level: 5, otId: 0x12345678 });
    expect(mon.species).toBe(277); // TREECKO
    expect(mon.otId).toBe(0x5678);
    expect(mon.otSecretId).toBe(0x1234);
  });

  test("normalize: a cart-import mon gets level from exp, ability, PP-up max PP", () => {
    const mon = SaveMon.normalize({
      species: 25, cartImport: true, exp: 1000, abilityNum: 0, nickname: "PIKACHU",
      personality: 0x10, moves: [null, 84, 45], ppBonusesPacked: 0x07,
    });
    expect(mon.cartImport).toBeUndefined();
    expect(mon.level).toBe(10); // medium fast: 10^3 = 1000
    expect(mon.name).toBe("PIKACHU");
    expect(mon.nickname).toBe("");
    expect(mon.ability).toBe(9); // STATIC
    // src/pokemon.c:3898: slot 1 has 3 PP Ups (30 -> 48), slot 2 has 1 (40 -> 48)
    expect(mon.maxPp).toEqual([null, 48, 48]);
  });

  test("each: party and boxes, cart-import dex folded in", () => {
    const save: Record<string, any> = {
      party: [null, { species: 1 }, { species: 4 }],
      storage: { boxes: [null, { mons: [null, { species: 7 }] }] },
      modData: { cartImport: { dexSeen: [null, 252], dexOwned: [null, 25] } },
    };
    const seen: number[] = [];
    SaveMon.each(save, (m) => seen.push(m.species));
    expect(seen).toEqual([1, 4, 7]);
    expect(save.dex.seen[277]).toBe(true);
    expect(save.dex.owned[25]).toBe(true);
    expect(save.modData.cartImport).toBeUndefined();
  });
});

describe.skipIf(!existsSync(ROOT))("gen3 rt data: save schema round trip", () => {
  setHost(new DesktopHost(ROOT));
  Pokemon.install({ read: (rel: string) => getHost().read(rel) });
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

  test("toSaveTable of a small session, then fromSaveTable", () => {
    const mon = SaveMon.normalize({ species: 4, level: 7, otName: "RED", otId: 4321, moves: [null, { id: 10 }] });
    const session: Record<string, any> = {
      version: "firered", name: "RED", rivalName: "BLUE", gender: 0, money: 3000, coins: 0,
      party: [null, mon], bag: Bag.new(), storage: Storage.new(),
      dex: { seen: { 4: true }, owned: { 4: true }, caught: { 4: true }, national: false },
      map: "FR_PALLET_TOWN", x: 5, y: 6, facing: "up",
      stringVars: [null, "", "", ""], specialVars: { 32768: 0 }, flags: { 2048: true }, vars: { 16384: 3 },
      playtime: { hours: 1, minutes: 2, seconds: 3 }, trainerId: 4321, secretId: 999,
      vsSeeker: FireredRules.newVsSeeker(), modData: {},
    };
    const out = Schema.toSaveTable(session)!;
    expect(out).toMatchObject({
      schemaVersion: 1, engine: "game3", version: "firered", generation: 3, name: "RED",
      money: 3000, map: "FR_PALLET_TOWN", x: 5, y: 6, facing: "up", biking: false,
      playTime: { hours: 1, minutes: 2, seconds: 3 }, trainerId: 4321, secretId: 999,
      specialSaveWarpFlags: 0, gcnLinkFlags: 0, game_cleared: false,
    });
    expect(out.inventory).toBe(out.bag);
    expect(out.rng).toEqual(Rng.getState());
    expect(out.options).toBeDefined();
    expect(out.party[1].species).toBe(4);
    const save = clone(out);
    let back: Record<string, any> | undefined;
    try {
      back = Schema.fromSaveTable(save);
    } catch (e) {
      // scripting/flags (Overworld_ResetStateOnContinue) is not ported yet
      expect(e).toBeInstanceOf(NotPortedError);
      expect((e as NotPortedError).what).toMatch(/^Flags\./);
    }
    if (back) {
      expect(back).toMatchObject({ name: "RED", money: 3000, map: "FR_PALLET_TOWN", x: 5, y: 6, trainerId: 4321 });
      expect(back.party[1]).toMatchObject({ species: 4, level: 7, pokeball: 4, otSecretId: 999, metLocation: 88 });
      expect(Schema.toSaveTable(back)!.party).toEqual(out.party);
    }
  });
});
}

// ---------------------------------------------------------------- pokemon, rom_text, map_ids, trainer_pic
{
// trainer_pic on the real cache in ~/gen3ref/frfull.

const root = join(homedir(), "gen3ref/frfull");

describe.skipIf(!existsSync(root))("gen3 rt data A: pokemon", () => {
  beforeAll(() => {
    setHost(new DesktopHost(root));
    Pokemon.install({ read: (rel: string) => getHost().read(rel) });
  });

  test("species names and keys", () => {
    expect(Pokemon.name(1)).toBe("BULBASAUR");
    expect(Pokemon.name(6)).toBe("CHARIZARD");
    expect(Pokemon.name(25)).toBe("PIKACHU");
    expect(Pokemon.name(29)).toBe("NIDORAN\xE2\x99\x80");
    expect(Pokemon.name(0)).toBe("?????");
    expect(Pokemon.keyName(29)).toBe("NIDORAN_F");
    expect(Pokemon.keyName(122)).toBe("MR_MIME");
    expect(Pokemon.keyName(250)).toBe("HO_OH");
    expect(Pokemon.speciesFromName("NIDORAN_M")).toBe(32);
    expect(Pokemon.speciesFromName("FARFETCH'D")).toBe(83);
    expect(Pokemon.speciesFromName("ho-oh")).toBe(250);
    expect(Pokemon.speciesFromName("Mr. Mime")).toBe(122);
    expect(Pokemon.speciesFromName("TREECKO")).toBe(277);
    expect(Pokemon.ready()).toBe(true);
  });

  test("national dex mapping", () => {
    expect(Pokemon.national(25)).toBe(25);
    expect(Pokemon.national(277)).toBe(252); // TREECKO
    expect(Pokemon.speciesFromNational(252)).toBe(277);
    expect(Pokemon.isInternalSpecies(252)).toBe(false); // ?????????? slot
    expect(Pokemon.speciesOf({ species: 252 })).toBe(277);
    expect(Pokemon.speciesOf({ species: 252, speciesNumbering: "internal" })).toBe(252);
    expect(Pokemon.speciesOf({ species: "PIKACHU" })).toBe(25);
    expect(Pokemon.dexEntry(6).category).toBe("FLAME");
  });

  test("base stats, types, abilities, meta", () => {
    expect(Pokemon.stats(1)).toEqual({ hp: 45, atk: 49, def: 49, spe: 45, spa: 65, spd: 65 });
    expect(Pokemon.stats(6)).toEqual({ hp: 78, atk: 84, def: 78, spe: 100, spa: 109, spd: 85 });
    expect(Pokemon.stats(25)).toEqual({ hp: 35, atk: 55, def: 30, spe: 90, spa: 50, spd: 40 });
    expect(Pokemon.types(1)).toEqual([null, 12, 3]); // GRASS / POISON
    expect(Pokemon.types(6)).toEqual([null, 10, 2]); // FIRE / FLYING
    expect(Pokemon.types(25)).toEqual([null, 13, 13]); // ELECTRIC
    expect(Pokemon.abilities(25)).toEqual([null, 9, 0]);
    expect(Pokemon.abilityName(9)).toBe("STATIC");
    expect(Pokemon.abilityId(25, 1)).toBe(9);
    expect(Pokemon.expYield(1)).toBe(64);
    expect(Pokemon.growthRate(1)).toBe(3); // GROWTH_MEDIUM_SLOW
    expect(Pokemon.gender(1, 0)).toBe("F"); // ratio 31 > 0
    expect(Pokemon.gender(1, 200)).toBe("M");
    expect(Pokemon.gender(81, 0)).toBe("U"); // MAGNEMITE genderless
    expect(Pokemon.baseFriendship(25)).toBe(70);
    expect(Pokemon.evYield(25)).toEqual({ hp: 0, atk: 0, def: 0, spe: 2, spa: 0, spd: 0 });
  });

  test("calcStats (pret CalculateMonStats)", () => {
    // Pikachu L50, 0 IVs/EVs, Hardy (neutral)
    const st = Pokemon.calcStats(25, 50, {}, {}, 0);
    expect(st).toEqual({ maxHp: 95, attack: 60, defense: 35, speed: 95, spAtk: 55, spDef: 45 });
    // Adamant (+atk -spa): personality 3
    const ad = Pokemon.calcStats(25, 50, {}, {}, 3);
    expect(ad.attack).toBe(66);
    expect(ad.spAtk).toBe(49);
    expect(Pokemon.calcStats(303, 50).maxHp).toBe(1); // SHEDINJA
    const mon = Pokemon.applyStats({ species: 6, level: 36 });
    expect(mon.maxHp).toBe(Pokemon.calcStats(6, 36).maxHp);
    expect(mon.hp).toBe(mon.maxHp);
  });

  test("learnsets, moves, TMs, evolutions", () => {
    const ls = Pokemon.learnset(1);
    expect(ls[1]).toEqual([null, 1, 33]); // TACKLE at 1
    expect(Pokemon.moveName(33)).toBe("TACKLE");
    expect(Pokemon.moveName(0)).toBe("-------");
    expect(Pokemon.movePp(33)).toBe(35);
    expect(Pokemon.moveMaxPp(85)).toBe(15); // THUNDERBOLT
    const [moves, pp, maxPp] = Pokemon.movesAtLevel(1, 10);
    expect(moves).toEqual([null, 33, 45, 73, 22]); // TACKLE GROWL LEECH SEED VINE WHIP
    expect(pp).toEqual([null, 35, 40, 10, 10]);
    expect(maxPp).toEqual(pp);
    expect(Pokemon.movesLearnedAt(1, 7)).toEqual([null, 73]);
    expect(Pokemon.evolutions(1)[1]).toEqual({ method: 4, param: 16, target: 2 });
    expect(len(Pokemon.eggMoves(1))).toBe(8);
    expect(Pokemon.eggMoves(2)).toBe(null);
    expect(Pokemon.battleMove(85).power).toBe(95);
    expect(Pokemon.moveFromTmItem(289)).toBe(264); // TM01 FOCUS PUNCH
    expect(Pokemon.canLearnTmIndex(25, 23)).toBe(true); // TM24 THUNDERBOLT
    expect(Pokemon.canLearnTmIndex(1, 23)).toBe(false);
    expect(Pokemon.canLearnTmItem(6, 289 + 34)).toBe(true); // TM35 FLAMETHROWER
    expect(Pokemon.romMoveName(85)).toBe("THUNDERBOLT");
    expect(Pokemon.romAbilityName(9)).toBe("STATIC");
    expect(Pokemon.isHmMove(57)).toBe(true);
  });

  test("move slots, friendship, EVs, pokerus helpers", () => {
    const mon: any = { species: 25, moves: [null, 84, 45, null, null], pp: [null, 30, 40] };
    expect(Pokemon.knowsMove(mon, 45)).toBe(true);
    expect(Pokemon.moveSlotCount(mon)).toBe(2);
    expect(Pokemon.swapMoves(mon, 1, 2)).toBe(true);
    expect(mon.moves[1]).toBe(45);
    expect(mon.pp[1]).toBe(40);
    expect(Pokemon.teachMove(mon, 85)).toEqual([true, 3]); // ModRuntime null bus: no emit
    expect(mon.moves[3]).toBe(85);
    expect(Pokemon.teachMove(mon, 45)).toEqual([false]);
    expect(Pokemon.replaceMove({ moves: [null, 57] }, 1, 33)).toEqual([undefined, "hm"]);
    expect(Pokemon.setFriendship(mon, 300)).toBe(255);
    expect(Pokemon.friendshipOf({ species: 25 })).toBe(70);
    // a negative delta skips the (stubbed) held-item lookup
    const f: any = { species: 25, friendship: 150 };
    expect(Pokemon.adjustFriendship(f, Pokemon.FRIENDSHIP_EVENT_FAINT_SMALL)).toBe(true);
    expect(f.friendship).toBe(149);
    expect(Pokemon.adjustFriendship({ species: 412 }, 0)).toBe(false);
    const e: any = { species: 25, evs: { atk: 99 } };
    expect(Pokemon.evCount(e)).toBe(99);
    expect(Pokemon.raiseEvFromItem(e, "atk", 10)).toBe(1);
    expect(e.evs.atk).toBe(100);
    expect(Pokemon.hasPokerus({ pokerus: 0x13 })).toBe(true);
    expect(Pokemon.checkPartyHasHadPokerus([null, { pokerus: 0x10 }, { pokerus: 0 }, { pokerus: 1 }], 7)).toBe(5);
    expect(Pokemon.isLeagueTrainerClass(87)).toBe(true);
    expect(Pokemon.currentMapSec({ mapSec: 88 })).toBe(88);
    expect(Pokemon.isOtherTrainer(5, "RED", { trainerId: 5, name: "RED" })).toBe(false);
    expect(Pokemon.isOtherTrainer(5, "BLUE", { trainerId: 5, name: "RED" })).toBe(true);
  });

  test("pics, shininess, unown, spinda", () => {
    expect(Pokemon.isShiny({ personality: 0, otId: 0, otSecretId: 0 })).toBe(true);
    expect(Pokemon.isShiny({ personality: 0x12345678, otId: 1, otSecretId: 2 })).toBe(false);
    expect(Pokemon.unownLetter(0)).toBe(0);
    expect(Pokemon.picSpecies(201, 1)).toBe(413);
    expect(Pokemon.picSpecies(25, 1)).toBe(25);
    expect(Pokemon.isEgg({ species: 412 })).toBe(true);
    expect(Pokemon.speciesOrEgg({ isEgg: true, species: 25 })).toBe(412);
    const ic = Pokemon.icon(25)!;
    expect(ic.w).toBe(32);
    expect(ic.frames).toBe(2);
    expect(ic.image.getHeight()).toBe(64);
    const fp = Pokemon.frontPic(6)!;
    expect(fp.w).toBe(64);
    expect(Pokemon.frontPic(6)).toBe(fp);
    expect(Pokemon.backPic(25, 0, true)!.image.getWidth()).toBe(64);
    const sp = Pokemon.spindaRgba(0x12345678, false)!;
    expect(sp.length).toBe(64 * 64 * 4);
    expect(Pokemon.spindaRgba(0x12345678, false)).not.toBe(Pokemon.spindaRgba(0, false));
    expect(Pokemon.frontPic(308, 0, false, 7)!.h).toBe(64);
  });

  test("display names (egg path needs the script bundle)", () => {
    expect(Pokemon.displayName({ species: 6 })).toBe("CHARIZARD");
    expect(Pokemon.displayName({ species: 6, nickname: "ZARD" })).toBe("ZARD");
    expect(Pokemon.displayMonName({ species: 25 })).toBe("PIKACHU");
    expect(Pokemon.savedName({ species: 25, name: "X" })).toBe("X");
    expect(() => Pokemon.displayName({ species: 412 })).toThrow(NotPortedError); // Space.ensureBundle
  });

  test("onReload hooks run on install", () => {
    let n = 0;
    const off = Pokemon.onReload(() => { n++; }, "k");
    Pokemon.install({ read: (rel: string) => getHost().read(rel) });
    expect(n).toBe(1);
    off();
    Pokemon.install({ read: (rel: string) => getHost().read(rel) });
    expect(n).toBe(1);
  });
});

describe.skipIf(!existsSync(root))("gen3 rt data A: rom_text / map_ids / trainer_pic", () => {
  beforeAll(() => setHost(new DesktopHost(root)));

  test("rom_text keys and overrides", () => {
    expect(RomText.key("gSpeciesNames", 3)).toBe("gSpeciesNames[3]");
    expect(RomText.key("gText", 1, 2)).toBe("gText[1][2]");
    const ir = TextIR.fromAscii("HELLO");
    RomText.overrides["T_TEST"] = ir;
    expect(RomText.ir("T_TEST")).toBe(ir);
    expect(RomText.has("T_TEST")).toBe(true);
    expect(RomText.plain("T_TEST")).toBe("HELLO");
    expect(RomText.plain("T_TEST")).toBe("HELLO"); // cached
    expect(RomText.ascii("T_TEST")).toBe("HELLO");
    expect(RomText.sources(ir)[1].source).toBe("HELLO");
    expect(RomText.lazy({ hi: "T_TEST" }).hi).toBe("HELLO");
    delete RomText.overrides["T_TEST"];
    expect(() => RomText.ir("gText_EggNickname")).toThrow(NotPortedError); // Space.ensureBundle
  });

  test("map_ids", () => {
    expect(MapIds.isGame3Map("FR_PALLET_TOWN")).toBe(true);
    expect(MapIds.isGame3Map("SEVII_ONE_ISLAND")).toBe(true);
    expect(MapIds.isGame3Map(42)).toBe(false);
    expect(MapIds.newGameStart("firered").map).toBe("FR_PLAYERS_HOUSE_2F");
    expect(MapIds.forConst("MAP_PALLET_TOWN", "firered")).toBe("FR_PALLET_TOWN");
    expect(MapIds.forConst("MAP_NOT_A_MAP", "firered")).toBe(null);
  });

  test("trainer_pic", () => {
    TrainerPic.install({ read: (rel: string) => getHost().read(rel) });
    const f = TrainerPic.front(0);
    expect(f?.w).toBe(64);
    const b = TrainerPic.back(0)!;
    expect(b.frames).toBeGreaterThanOrEqual(4);
    expect(b.h).toBe(64 * b.frames);
    expect(TrainerPic.back(0)).toBe(b);
  });
});
}

// ---------------------------------------------------------------- party, storage, bag, items, items_data
{
// Scratch test (data-and-save cluster, worker B): core/items_data, items, bag,
// storage, party on FireRed's real item pack (~/gen3ref/frfull).
// Load order: profiles/firered_rules -> field -> save_schema_firered -> firered_rules is a
// cycle with a top-level use; entering through save_schema_firered avoids the TDZ.

const root = join(homedir(), "gen3ref/frfull");

describe.skipIf(!existsSync(root))("gen3 data+save B: items, bag, storage, party", () => {
  beforeAll(() => {
    setHost(new DesktopHost(root));
    // Dataset is still a stub, so load_pack's cache read would throw; feed
    // the same cache chunk through Brian's own installPack instead.
    const src = getHost().read("data/generated/gba/items/pack.lua");
    const [chunk, err] = luaLoad(src, "@items/pack.lua");
    if (!chunk) throw new Error(err);
    ItemsData.installPack(chunk());
  });

  test("profile bag model", () => {
    expect(ItemsData.CAPACITY.ITEMS).toBe(42);
    expect(ItemsData.CAPACITY.TM_CASE).toBe(58);
    expect(ItemsData.POCKET_RESULT.KEY_ITEMS).toBe(2);
    expect(ItemsData.CONTAINERS.TM_CASE.item).toBe(364);
    expect(ItemsData.CONTAINERS.BERRY_POUCH).toEqual({ item: 365, flag: "FLAG_SYS_GOT_BERRY_POUCH" });
    expect(ItemsData.slotMax("ITEMS")).toBe(999);
    expect(ItemsData.BAG_MODEL.pcItems).toBe(30);
  });

  test("item data: POTION, POKE BALL, TM01, HM01, BICYCLE", () => {
    const potion = ItemsData.info(13)!;
    expect(potion.name).toBe("POTION");
    expect(potion.price).toBe(300);
    expect(potion.pocket).toBe("ITEMS");
    expect(ItemsData.info("POTION")!.id).toBe(13);
    expect(ItemsData.description(13)).toBe("A spray-type wound medicine.\nIt restores the HP of one POK\xc3\xa9MON\nby 20 points.");
    const ball = ItemsData.info(4)!;
    expect(ball.name).toBe("POK\xc3\xa9 BALL");
    expect(ball.pocket).toBe("POKE_BALLS");
    expect(ItemsData.toNumericId("POKE_BALL")).toBe(4);
    const tm = ItemsData.info("TM01")!;
    expect(tm.id).toBe(289);
    expect(tm.price).toBe(3000);
    expect(tm.pocket).toBe("TM_CASE");
    expect(ItemsData.isTm(289)).toBe(true);
    expect(ItemsData.isHm(289)).toBe(false);
    expect(ItemsData.isHm("HM01")).toBe(true);
    expect(ItemsData.tmNumber(289)).toBe(1);
    expect(ItemsData.tmNumber(340)).toBe(2);
    expect(ItemsData.pocketOf(360)).toBe("KEY_ITEMS");
    expect(ItemsData.fieldUseKind(360)).toBe("bike");
    expect(ItemsData.fieldUseKind(13)).toBe("heal");
    expect(ItemsData.fieldUseKind(14)).toBe("status");
    expect(ItemsData.fieldUseKind(19)).toBe("heal");
    expect(ItemsData.medicineKind(24)).toBe("revive");
    expect(ItemsData.isBerry("ORAN_BERRY")).toBe(true);
    expect(ItemsData.berryNumber(139)).toBe(7);
    expect(ItemsData.bagKey("POTION")).toBe("13");
    expect(ItemsData.bagKey("FRLG_22")).toBe("22");
    expect(ItemsData.toNumericId("BERRY")).toBe(139); // Gen 2 alias
    expect(ItemsData.BY_ID[13]).toEqual({ name: "POTION", pocket: "ITEMS", fieldUse: "heal" });
    expect(ItemsData.pocketResult(289)).toBe(4);
    // unknown string ids
    expect(ItemsData.info("FOO_BAR")).toEqual({ id: "FOO_BAR", name: "FOO BAR", pocket: "ITEMS", fieldUse: "none" });
    expect(ItemsData.info(9999)).toBeUndefined();
  });

  test("items host mapping", () => {
    expect(Items.resolveHostId(13)).toBe("POTION");
    expect(Items.resolveHostId("METEORITE")).toBe("METEORITE");
    expect(Items.isHostSafe(280)).toBe(false);
    expect(Items.isHostSafe("POTION")).toBe(true);
    expect(Items.resolveHostId("12x")).toBe("12x");
    expect(Items.clampGame3(1200)).toBe(999);
    expect(Items.displayName(22)).toBe("SUPER POTION");
    expect(Items.pocket(4)).toBe("POKE_BALLS");
  });

  test("bag add / remove / count on a fresh bag", () => {
    const bag = Bag.new();
    expect(Bag.add(bag, "POTION", 5)).toEqual([true, 5]);
    expect(Bag.get(bag, 13)).toBe(5);
    expect(Bag.has(bag, "POTION", 5)).toBe(true);
    expect(bag.pockets.ITEMS[1]).toEqual({ id: 13, qty: 5 });
    expect(bag.stacks["13"]).toBe(5);
    expect(bag.stacks.POTION).toBe(5);
    expect(Bag.add(bag, 13, 999)).toEqual([false, 0]);
    expect(Bag.remove(bag, 13, 2)).toBe(true);
    expect(Bag.get(bag, 13)).toBe(3);
    expect(Bag.remove(bag, 13, 4)).toBe(false);
    expect(Bag.set(bag, 13, 0)).toBe(0);
    expect(len(bag.pockets.ITEMS)).toBe(0);
    expect(Bag.add(bag, 0, 1)).toEqual([false, 0]);

    // TM Case auto-grant + HMs sorted first
    expect(Bag.add(bag, "TM05", 1)[0]).toBe(true);
    expect(Bag.add(bag, "HM02", 1)[0]).toBe(true);
    expect(Bag.add(bag, 289, 2)[0]).toBe(true);
    expect(bag.pockets.TM_CASE.slice(1).map((s) => s!.id)).toEqual([340, 289, 293]);
    expect(Bag.has(bag, 364)).toBe(true); // TM CASE in KEY_ITEMS
    // Berry Pouch auto-grant (Space.store is nil: no flag write)
    expect(Bag.add(bag, "ORAN_BERRY", 3)).toEqual([true, 3]);
    expect(Bag.get(bag, 139)).toBe(3);
    expect(Bag.has(bag, 365)).toBe(true);

    // capacity: KEY_ITEMS holds 30 distinct items
    expect(Bag.canAdd(bag, 360, 1)).toBe(true);

    const rows = Bag.listPocket(bag, "TM_CASE");
    expect(len(rows)).toBe(3);
    expect(rows[1]!.name).toBe("HM02");
    expect(Bag.listPocket(bag, "TM_CASE")).toBe(rows); // row cache

    const [writes, quarantine, overflow] = Bag.splitForHost(bag);
    expect(writes).toEqual({});
    expect(quarantine.FRLG_289).toBe(2);
    expect(overflow).toEqual({});
  });

  test("bag migrate (legacy stacks / schema lists) and sidecar", () => {
    const legacy: any = { stacks: { POTION: 120, "FRLG_4": 3 } };
    Bag.migrate(legacy);
    expect(Bag.get(legacy, 13)).toBe(120);
    expect(Bag.get(legacy, 4)).toBe(3);
    const [writes, , overflow] = Bag.splitForHost(legacy);
    expect(writes.POTION).toBe(99);
    expect(overflow.POTION).toBe(21);
    expect(writes.POKE_BALL).toBe(3);

    const schema: any = { items: seq({ id: 22, qty: 2 }), keyItems: seq(360) };
    Bag.migrate(schema);
    expect(Bag.get(schema, 22)).toBe(2);
    expect(Bag.get(schema, 360)).toBe(1);

    const b2 = Bag.new();
    Bag.restoreSidecar(b2, { quarantine: { FRLG_289: 1 }, overflow: { POTION: 4 } });
    expect(Bag.get(b2, 289)).toBe(1);
    expect(Bag.get(b2, 13)).toBe(4);
    Bag.mergeFromHost(b2, { POTION: 1, BOULDERBADGE: 1 });
    expect(Bag.get(b2, 13)).toBe(5);
  });

  test("coins", () => {
    const s: any = { coins: 9990 };
    expect(Bag.Coins.add(s, 20)).toBe(true);
    expect(Bag.Coins.get(s)).toBe(9999);
    expect(Bag.Coins.add(s, 1)).toBe(false);
    expect(Bag.Coins.remove(s, 10000)).toBe(false);
    expect(Bag.Coins.remove(s, 99)).toBe(true);
    expect(s.coins).toBe(9900);
  });

  test("storage boxes and PC items", () => {
    const st = Storage.new();
    expect(len(st.boxes)).toBe(14);
    expect(st.boxes[3]!.name).toBe("BOX 3");
    expect(st.boxes[6]!.wallpaper).toBe(2);
    expect(st.items[1]).toEqual({ id: 13, qty: 1 });
    expect(Storage.findOpenSlot(st)).toEqual([1, 1]);
    st.currentBox = 14;
    for (let s = 1; s <= 30; s++) st.boxes[14]!.mons[s] = { species: 1 };
    expect(Storage.findOpenSlot(st)).toEqual([1, 1]); // wraps around
    expect(Storage.countBoxMons(st, 14)).toBe(30);
    expect(Storage.countTotalMons(st)).toBe(30);

    const session: any = { storage: st, party: seq({ species: 4, hp: 1, maxHp: 20 }, { species: 7, hp: 0, maxHp: 22, status: 1 }) };
    // deposit: mutates, then the quest log (stub) throws
    expect(() => Storage.deposit(session, 2, 1)).toThrow(NotPortedError);
    expect(len(session.party)).toBe(1);
    const dep = Storage.getBoxMon(st, 1, 1);
    expect(dep.species).toBe(7);
    expect(dep.hp).toBe(22); // PC heal
    expect(dep.status).toBeUndefined();
    expect(Storage.deposit(session, 1, 1)).toEqual([false, "last_pokemon"]);
    expect(Storage.releaseMon(session, 1, 1)[0].species).toBe(7);
    expect(Storage.releaseMon(session, 1, 1)).toEqual([null, "empty_slot"]);

    expect(Storage.addPcItem(session, 13, 5)).toEqual([true]);
    expect(st.items[1]!.qty).toBe(6);
    expect(Storage.addPcItem(session, 13, 999)).toEqual([false, "pc_item_stack_full"]);
    expect(Storage.addPcItem(session, 4, 2)).toEqual([true]);
    expect(Storage.tossItem(session, 2, 2)).toEqual([true]);
    expect(len(st.items)).toBe(1);

    const data = Storage.serialize(st);
    expect(data.boxes[14].mons[30]).toEqual({ species: 1 });
    expect(data.boxes[2]).toBeUndefined();
    const back = Storage.deserialize(data);
    expect(back.currentBox).toBe(14);
    expect(Storage.countTotalMons(back)).toBe(30);
    expect(back.items[1]).toEqual({ id: 13, qty: 6 });

    const restored = Storage.restore(null, null, { POTION: 3, 4: 2 });
    expect(len(restored.items)).toBe(2);
    const party: any = [null, { a: 1 }, null, { b: 2 }];
    Storage.compactParty(party);
    expect(party).toEqual([null, { a: 1 }, { b: 2 }]);
  });

  test("storage withdrawItem moves to the bag", () => {
    const session: any = { bag: Bag.new() };
    Storage.ensure(session);
    expect(() => Storage.withdrawItem(session, 1, 1)).toThrow(NotPortedError); // quest log stub, after the bag add
    expect(Bag.get(session.bag, 13)).toBe(1);
  });

  test("party ops", () => {
    const host: any = seq({ species: 25, moves: seq(84, 45), pp: seq(30, 40) });
    const snap = Party.takeOpaque(host);
    expect(snap[1]).toEqual(host[1]);
    expect(snap[1].moves).not.toBe(host[1].moves);
    Party.applyBattleFields(snap[1], { hp: 3, friendship: 90, pp: seq(1) });
    expect(snap[1].happiness).toBe(90);
    expect(snap[1].pp[1]).toBe(1);
    Party.writeBack(host, snap);
    expect(host[1].hp).toBe(3);
    expect(Party.size(host)).toBe(1);

    const side: any = {};
    Party.setOverlayMove(side, 1, 2, 300, "10");
    expect(Party.getOverlayMove(side, 1, 2)).toEqual({ frlgMoveId: 300, pp: 10 });

    const p: any = seq({ species: 1, hp: 0, maxHp: 12, status: 2, moves: seq(33), pp: seq(0), maxPp: seq(35) },
      { species: 4, hp: 5, maxHp: 10 });
    Party.healAll(p);
    expect(p[1].hp).toBe(12);
    expect(p[1].pp[1]).toBe(35);
    expect(Party.monsStateToDoubles(p)).toBe(Party.PLAYER_HAS_TWO_USABLE_MONS);
    expect(Party.otGender({ gender: "girl" })).toBe(1);
    expect(Party.dvsIdentical(seq({ dvs: { a: 1 } }), seq({ dvs: { a: 1 } }))).toBe(true);
    expect(Party.dvsIdentical(seq({ dvs: { a: 1 } }), seq({ dvs: { a: 2 } }))).toBe(false);
    // giveMon: [ok, code, mon, box, slot]; the species pack is installed above
    const giveSession: any = { party: seq(), name: "RED", trainerId: 12345 };
    const given = Party.giveMon(giveSession, 1, 5);
    expect(given[0]).toBeTruthy();
    expect(given[2]).toMatchObject({ species: 1, level: 5 });
    expect(len(giveSession.party)).toBe(1);
  });
});
}

// ---------------------------------------------------------------- dex, pokedex_data, evolution, move_learn, summary_data, easy_chat_text
{
// Scratch test (data and save cluster, sub-worker C): dex, pokedex_data,
// evolution, move_learn, summary_data, easy_chat_text on FireRed's real cache.

const root = join(homedir(), "gen3ref/frfull");
const C = Constants.of("firered");
const SP = (n: string): number => C.require("species", "SPECIES_" + n);
const IT = (n: string): number => C.require("items", "ITEM_" + n);
const MV = (n: string): number => C.require("moves", "MOVE_" + n);

/** A cache file through the host, evaluated as Brian's load(src)() does. */
function cacheTable(rel: string): any {
  const src = getHost().read("data/generated/gba/" + rel);
  const [chunk, err] = luaLoad(src, "@" + rel);
  if (!chunk) throw new Error(err);
  return chunk();
}

describe.skipIf(!existsSync(root))("gen3 rt data C (FireRed cache)", () => {
  beforeAll(() => {
    setHost(new DesktopHost(root));
    Pokemon.install({ read: (rel: string) => getHost().read(rel) });
    // map_sections_extract (an importer module) reads the importer's bound cache
    ImportCacheFs.bind(makeCache(root));
  });

  // ---------------------------------------------------------------- dex
  test("dex: Kanto prefix numbering, national <-> internal ids", () => {
    expect(Dex.regionalNumber(25, "firered")).toBe(25);
    expect(Dex.regionalNumber(151, "firered")).toBe(151);
    expect(Dex.regionalNumber(152, "firered")).toBeUndefined();
    expect(Dex.inRegional(SP("TREECKO"), "firered")).toBe(false);
    expect(Dex.nationalInRegional(150, "firered")).toBe(true);
    expect(Dex.nationalInRegional(252, "firered")).toBe(false);
    expect(Dex.regionalMax("firered")).toBe(151);
    // TREECKO: internal 277 = national 252
    expect(SP("TREECKO")).toBe(277);
    expect(Pokemon.national(277)).toBe(252);
    expect(Pokemon.speciesFromNational(252)).toBe(277);
  });

  test("dex: seen / caught / counts / split", () => {
    const d = Dex.new();
    Dex.setSeen(d, 1);
    Dex.setCaught(d, 4);
    Dex.setCaught(d, "PIKACHU"); // a name resolves through Pokemon.speciesFromName
    Dex.setSeen(d, 300);
    expect(Dex.isSeen(d, 1)).toBe(true);
    expect(Dex.isCaught(d, 1)).toBe(false);
    expect(Dex.isOwned(d, 25)).toBe(true);
    expect(Dex.countSeen(d)).toBe(3);
    expect(Dex.countSeen(d, "NATIONAL")).toBe(4);
    expect(Dex.countCaught(d, "kanto")).toBe(2);
    const [host, nat] = Dex.splitForHost(d);
    expect(Object.keys(host.seen).map(Number)).toEqual([1, 4, 25]);
    expect(Object.keys(nat.seen).map(Number)).toEqual([300]);
    const save: any = {};
    Dex.applyHostUpdates(save, host);
    expect(save.pokedex.caught[25]).toBe(true);

    const d2 = Dex.new();
    Dex.mergeFromHost(d2, { pokedex: { seen: { 10: true, 260: true }, caught: { 10: 1 } } });
    expect(Dex.isSeen(d2, 10) && Dex.isCaught(d2, 10)).toBe(true);
    expect(Dex.isSeen(d2, 260)).toBe(false); // host bits stop at 251
    Dex.restoreNational(d2, { national_dex: { seen: { 260: true, 20: true }, caught: { "300": true } } });
    expect(Dex.isSeen(d2, 260)).toBe(true);
    expect(Dex.isSeen(d2, 20)).toBe(false);
    expect(Dex.isCaught(d2, 300)).toBe(true);
  });

  test("dex: personality records, register gate, national flags", () => {
    const d = Dex.new();
    Dex.handleSetPokedexFlag(d, 201, true, -1);
    expect(d.unownPersonality).toBe(4294967295);
    expect(Dex.defaultPersonality(d, 201)).toBe(4294967295);
    expect(Dex.defaultPersonality(d, 1)).toBe(0);

    const s = { version: "firered" };
    // non-Kanto before the National Dex: reported as already seen, not registered
    expect(Dex.registerEncounter(d, 277, s)).toBe(true);
    expect(Dex.isSeen(d, 277)).toBe(false);
    expect(Dex.registerEncounter(d, 16, s)).toBe(false);
    expect(Dex.registerEncounter(d, 16, s)).toBe(true);
    const sn = { version: "firered", national_dex_unlocked: true };
    expect(Dex.registerCapture(d, 308, sn, 0x12345678)).toBe(false);
    expect(d.spindaPersonality).toBe(0x12345678);

    expect(Dex.nationalEnabled({ version: "firered" })).toBe(false);
    expect(Dex.nationalEnabled({ version: "firered", flags: { FLAG_SYS_NATIONAL_DEX: true } })).toBe(true);
    const flagId = C.require("flags", "FLAG_SYS_NATIONAL_DEX");
    expect(flagId).toBe(0x840);
    expect(Dex.nationalEnabled({ version: "firered", flags: { [flagId]: true } })).toBe(true);
    const varId = C.require("vars", "VAR_NATIONAL_DEX");
    expect(Dex.nationalEnabled({ version: "firered", vars: { [varId]: 0x6258 } })).toBe(true);

    // summaryCount: Kanto only until the National Dex
    const save = { version: "firered", dex: { caught: { 1: true, 25: true, 277: true }, owned: { 25: true } } };
    expect(Dex.summaryCount(save)).toBe(2);
    expect(Dex.summaryCount({ ...save, national_dex_unlocked: true })).toBe(3);
  });

  // ---------------------------------------------------------------- pokedex_data
  test("pokedex_data: init, wild areas", () => {
    PokedexData._entries = undefined;
    expect(PokedexData.init()).toBe(true);
    expect(PokedexData._entries[1].category).toBe("SEED");
    // CATERPIE (10) is wild in VIRIDIAN FOREST
    expect(toArray(PokedexData.getWildAreasForSpecies(10))).toContain("DEX_AREA_VIRIDIAN_FOREST");
  });

  test("pokedex_data: categories, orders, markers", () => {
    expect(PokedexData.init()).toBe(true);

    expect(toArray(PokedexData.getCategoryPages("grassland")[1])).toEqual([19, 20, 161, 162]);
    const d = Dex.new();
    expect(PokedexData.isCategoryUnlocked(d, "grassland")).toBe(false);
    Dex.setSeen(d, 20);
    Dex.setCaught(d, 19);
    Dex.setSeen(d, 33);
    expect(PokedexData.isCategoryUnlocked(d, "grassland")).toBe(true);
    const unl = PokedexData.getUnlockedCategoryPages("grassland", d);
    expect(unl[1].rawPage).toBe(1);
    expect(toArray(unl[1].mons)).toEqual([19, 20]);
    const [seen, caught, total] = PokedexData.countCategory(d, "grassland");
    expect([seen, caught]).toEqual([3, 1]);
    expect(total).toBeGreaterThan(20);

    // a dex without the National Dex flag falls through to Runtime.getSession()
    expect(() => PokedexData.getOrderList("numerical_kanto", d)).toThrow(NotPortedError);
    d.nationalUnlocked = true; // every species seen here is Kanto: same lists
    expect(toArray(PokedexData.getOrderList("numerical_kanto", d))).toEqual(Array.from({ length: 33 }, (_, i) => i + 1));
    // atoz: alphabetical, only seen (national numbers -> internal ids)
    const az = toArray(PokedexData.getOrderList("atoz", d));
    expect(az).toEqual([33, 20, 19]); // NIDORINO, RATICATE, RATTATA
    expect(toArray(PokedexData.getOrderList("lightest", d))).toEqual([19]);
    const dn: any = Dex.new();
    dn.nationalUnlocked = true;
    Dex.setSeen(dn, 277);
    const nl = PokedexData.getOrderList("numerical_national", dn);
    expect(len(nl)).toBe(252);
    expect(nl[252]).toBe(277);
    expect(PokedexData.countOrder(d, "numerical_kanto")).toEqual([3, 1, 151]);

    expect(PokedexData.getAreaMarker("DEX_AREA_CELADON_CITY")).toEqual({ x: 76, y: 24, shape: "MARKER_CIRCULAR" });
    expect(PokedexData.getAreaMapKey("DEX_AREA_CAPE_BRINK")).toBe("two_island");
    expect(PokedexData.getAreaMapKey(undefined)).toBe("kanto");
    expect(PokedexData.isNationalUnlocked({ version: "firered" }, Dex.new())).toBe(false);
    expect(PokedexData.isNationalUnlocked({ save: { national_dex_unlocked: true } })).toBe(true);
  });

  test("pokedex_data: getEntry reaches RomText (scripting.space still a stub)", () => {
    // gText_Lbs comes through rom_text -> Space.ensureBundle (not ported)
    expect(() => PokedexData.getEntry(1)).toThrow(NotPortedError);
  });

  // ---------------------------------------------------------------- evolution
  test("evolution: level, item, trade, gates", () => {
    const bulba = { species: 1, level: 16 };
    expect(Evolution.levelTarget(bulba)).toEqual([2, 16]);
    expect(Evolution.levelTarget({ species: 1, level: 15 })).toEqual([undefined, undefined]);
    const pika = { species: 25, level: 5 };
    expect(Evolution.itemTarget(pika, IT("THUNDER_STONE"))).toBe(26);
    expect(Evolution.itemTarget(pika, IT("FIRE_STONE"))).toBeUndefined();
    expect(Evolution.itemCheck(pika, IT("THUNDER_STONE"))).toBe(26);
    expect(Evolution.tradeTarget({ species: SP("KADABRA") })).toBe(SP("ALAKAZAM"));
    // ONIX + METAL_COAT -> STEELIX (non-Kanto: gated on the National Dex)
    const onix: any = { species: SP("ONIX"), item: IT("METAL_COAT") };
    expect(Evolution.tradeTarget(onix, { version: "firered" })).toBeUndefined();
    expect(onix.item).toBe(IT("METAL_COAT"));
    expect(Evolution.tradeTarget(onix, { version: "firered", national_dex_unlocked: true })).toBe(SP("STEELIX"));
    expect(onix.item).toBe(0);
    // Everstone blocks everything but the item check
    expect(Evolution.levelTarget({ species: 1, level: 30, item: IT("EVERSTONE") })).toEqual([undefined, undefined]);
    expect(Evolution.itemCheck({ species: 25, item: IT("EVERSTONE") }, IT("THUNDER_STONE"))).toBe(26);
    // Wurmple: personality upper half % 10 picks Silcoon (<= 4) or Cascoon
    const wurm = SP("WURMPLE");
    const s = { version: "firered", national_dex_unlocked: true };
    expect(Evolution.levelTarget({ species: wurm, level: 7, personality: 3 * 65536 }, s)[0]).toBe(SP("SILCOON"));
    expect(Evolution.levelTarget({ species: wurm, level: 7, personality: 7 * 65536 }, s)[0]).toBe(SP("CASCOON"));
    expect(Evolution.levelTarget({ species: wurm, level: 7 }, { version: "firered" })[0]).toBeUndefined();
    // friendship evolution: GOLBAT at 220
    expect(Evolution.levelTarget({ species: SP("GOLBAT"), level: 30, friendship: 220 }, s)[0]).toBe(SP("CROBAT"));
    expect(Evolution.levelTarget({ species: SP("GOLBAT"), level: 30, friendship: 219 }, s)[0]).toBeUndefined();

    const party = seq<any>({ species: 1, level: 16 }, { species: 4, level: 10 }, { species: 7, level: 16 });
    const pend = Evolution.pending(party, { 1: true, 2: true });
    expect(len(pend)).toBe(1);
    expect(pend[1].partyIndex).toBe(1);
    expect(pend[1].toSpecies).toBe(2);
  });

  test("evolution: rename and apply (Shedinja)", () => {
    const m1: any = { nickname: "BULBASAUR" };
    Evolution.renameMon(m1, 1, 2);
    expect(m1.nickname).toBe("IVYSAUR");
    const m2: any = { nickname: "BOB\0\0" };
    Evolution.renameMon(m2, 1, 2);
    expect([m2.nickname, m2.name]).toEqual(["BOB\0\0", "BOB"]);

    const nin: any = {
      species: SP("NINCADA"), level: 20, nickname: "NINCADA", personality: 0x1234, otId: 1,
      ivs: { hp: 31, atk: 31, def: 31, spAtk: 31, spDef: 31, spd: 31 },
      evs: { hp: 0, atk: 0, def: 0, spAtk: 0, spDef: 0, spd: 0 },
      moves: seq(10, 28), item: 0, hp: 40, maxHp: 50,
    };
    Pokemon.applyStats(nin);
    nin.hp = Math.min(nin.maxHp, 40);
    const session: any = { version: "firered", party: seq(nin), dex: Dex.new() };
    expect(Evolution.apply(nin, SP("NINJASK"), session)).toBe(true);
    expect(nin.species).toBe(SP("NINJASK"));
    expect(nin.nickname).toBe("NINJASK");
    expect(len(session.party)).toBe(2);
    const shed = session.party[2];
    expect(shed.species).toBe(SP("SHEDINJA"));
    expect(shed.hp).toBe(1);
    expect(shed.moves).not.toBe(nin.moves); // copied, one level deep
    expect(toArray(shed.moves)).toEqual([10, 28]);
    expect(Dex.isCaught(session.dex, SP("SHEDINJA"))).toBe(true);
    expect(Dex.isCaught(session.dex, SP("NINJASK"))).toBe(true);
  });

  // ---------------------------------------------------------------- move_learn
  test("move_learn: relearner, forget, tutors, Cape Brink", () => {
    const mon: any = { species: 1, level: 10, moves: seq(MV("TACKLE"), MV("GROWL")) };
    expect(toArray(MoveLearn.relearnableMoves(mon))).toEqual([MV("LEECH_SEED"), MV("VINE_WHIP")]);
    expect(MoveLearn.countRelearnableMoves(mon)).toBe(2);
    expect(MoveLearn.countRelearnableMoves({ species: 412, isEgg: true })).toBe(0);

    const f: any = { moves: seq(33, 45, 73, 22), pp: seq(35, 40, 10, 25), ppBonusesPacked: 0b11100100 };
    expect(MoveLearn.forgetMove(f, 1)).toBe(true);
    expect(toArray(f.moves)).toEqual([33, 73, 22]);
    expect(toArray(f.pp)).toEqual([35, 10, 25]);
    expect(f.ppBonusesPacked).toBe(0b00111000);
    expect(MoveLearn.forgetMove(f, 3)).toBe(false);

    MoveLearn.resetTutorPack();
    expect(MoveLearn.tutorLearnsets()[1]).toBe(16538);
    expect(MoveLearn.tutorMoveCount()).toBe(15);
    expect(MoveLearn.tutorMove(0)).toBe(MV("MEGA_PUNCH"));
    expect(MoveLearn.tutorMove(1)).toBe(MV("SWORDS_DANCE"));
    expect(MoveLearn.tutorMove(15)).toBe(MV("FRENZY_PLANT"));
    expect(MoveLearn.tutorMove(18)).toBeUndefined();
    expect(MoveLearn.canLearnTutorMove(1, 1)).toBe(true);  // BULBASAUR: SWORDS_DANCE
    expect(MoveLearn.canLearnTutorMove(1, 0)).toBe(false); // ... not MEGA_PUNCH
    expect(MoveLearn.canLearnTutorMove(3, 15)).toBe(true);
    expect(MoveLearn.canLearnTutorMove(6, 15)).toBe(false);
    expect(MoveLearn.canMonLearnTutorMove({ species: 1, moves: seq(MV("SWORDS_DANCE")) }, 1)).toBe(MoveLearn.ALREADY_KNOWS_MOVE);
    expect(MoveLearn.canMonLearnTutorMove({ species: 1, moves: seq(33) }, 1)).toBe(MoveLearn.CAN_LEARN_MOVE);
    expect(MoveLearn.canMonLearnTutorMove({ species: 412, isEgg: true }, 1)).toBe(MoveLearn.CANNOT_LEARN_MOVE_IS_EGG);

    expect(MoveLearn.leadMonIndex(seq({ species: 412, isEgg: true }, { species: 4 }))).toBe(1);
    expect(MoveLearn.capeBrinkRow({ species: 6, friendship: 255 })?.move).toBe(MV("BLAST_BURN"));
    expect(MoveLearn.capeBrinkRow({ species: 6, friendship: 254 })).toBeUndefined();
  });

  // ---------------------------------------------------------------- summary_data
  test("summary_data: natures, exp, shiny, gender, status", () => {
    expect(SummaryData.natureStatModifier(1, "atk")).toBe(1.1); // LONELY
    expect(SummaryData.natureStatModifier(1, "def")).toBe(0.9);
    expect(SummaryData.natureStatModifier(0, "atk")).toBe(1.0);
    expect(SummaryData.expForLevel(0, 16)).toBe(4096);
    expect(SummaryData.expForLevel(3, 16)).toBe(2535); // Medium Slow
    expect(SummaryData.expForLevel(3, 1)).toBe(1);
    expect(SummaryData.expForLevel(1, 100)).toBe(600000); // Erratic
    expect(SummaryData.expForLevel(2, 100)).toBe(1640000); // Fluctuating
    const p = SummaryData.expProgress({ level: 5, exp: 140 }, 0);
    expect([p.curLevelExp, p.nextLevelExp, p.expNeeded, p.expProgress]).toEqual([125, 216, 76, 15]);
    expect(SummaryData.isShiny({ personality: 0, otId: 0, otSecretId: 7 })).toBe(true);
    expect(SummaryData.isShiny({ personality: 0x00080000, otId: 0, otSecretId: 0 })).toBe(false);
    expect(SummaryData.gender({ genderRatio: 127, personality: 200 })).toBe("M");
    expect(SummaryData.gender({ genderRatio: 127, personality: 100 })).toBe("F");
    expect(SummaryData.gender({ species: SP("NIDORAN_F"), personality: 255 })).toBe("F");
    expect(SummaryData.statusAilment({ hp: 0 })).toBe(7);
    expect(SummaryData.statusAilment({ hp: 5, status: 0x40 })).toBe(2);
    expect(SummaryData.statusAilment({ hp: 5, status: "burned" })).toBe(5);
    expect(SummaryData.statusAilment({ hp: 5, status: 0, pokerus: 0x13 })).toBe(6);
    expect(SummaryData.eggCycles({ friendship: 5 })).toBe(5);
    expect(SummaryData.eggCycles(undefined)).toBe(40);
  });

  test("summary_data: descriptions; ROM text sits behind scripting.space", () => {
    expect(() => SummaryData.nature({ personality: 26 })).toThrow(NotPortedError); // rom_text -> space
    expect(SummaryData.moveDescription(1, "POUND")).toBe("A physical attack\ndelivered with a\nlong tail or a\nforeleg, etc.");
    // the ROM's own name for the id wins over the shown one (translation mods)
    expect(SummaryData.moveDescription(1, "NO SUCH MOVE")).toBe(SummaryData.moveDescription(1, "POUND"));
    expect(SummaryData.moveDescription(9999, "NO SUCH MOVE")).toBe("---");
    expect(SummaryData.abilityDescription(C.require("abilities", "ABILITY_BLAZE"), "x")).toBe("Ups FIRE moves in a pinch.");
    expect(SummaryData.abilityDescription(9999, "NOPE")).toBe("No special ability.");
  });

  // ---------------------------------------------------------------- easy_chat_text
  test("easy_chat_text: words, ids, names, phrases", () => {
    EasyChatText.install(cacheTable("easy_chat/words.lua")); // Brian's install, on the cache file
    expect(EasyChatText.group(4)!.name).toBe("GREETINGS");
    expect(EasyChatText.rawWord(2048)).toBe("THANKS");
    expect(EasyChatText.rawWord(0xFFFF)).toBe("");
    expect(EasyChatText.rawWord(1)).toBe("???");
    expect(EasyChatText.decodeWord(9287)).toEqual([18, 71]);
    expect(EasyChatText.encodeWord(18, 71)).toBe(9287);
    expect(EasyChatText.context(4)).toBe("easyChat.GREETINGS");
    expect(EasyChatText.groupName(4)).toBe("GREETINGS");
    expect(EasyChatText.wordLabel(5)).toBe("easyChat.word[5]");
    expect(EasyChatText.word(2048)).toBe("THANKS");
    expect(EasyChatText.word(9287)).toBe(Pokemon.moveName(71)); // the dataset's move name
    expect(EasyChatText.word(63)).toBe("ABRA");
    expect(EasyChatText.phrase(seq(2048, 2049, 0xFFFF, 63))).toBe("THANKS YES\nABRA");
    expect(EasyChatText.phrase(EasyChatText.DEFAULT_PROFILE).split("\n").length).toBe(2);
    expect(len(EasyChatText.PASSPHRASE_MYSTERY_EVENT)).toBe(4);
  });
});
}

// ---------------------------------------------------------------- breeding, daycare, mail, fame_checker, heal_locations, help_rules, options, quest_log, quest_log_recorder
{
/* eslint-disable @typescript-eslint/no-explicit-any */
const HealLocations: any = HealLocationsMod;
const Rules: any = HelpRulesMod;
const R: any = QuestLogRecorderMod;
const Daycare: any = DaycareMod;
const Breeding: any = BreedingMod;

const root = join(homedir(), "gen3ref/frfull");
const cache = { read: (rel: string) => getHost().read(rel) };

/** Run fn; a not-yet-ported neighbour reads as "not ported" (tested around, not mocked). */
function orNotPorted<T>(fn: () => T): T | "not ported" {
  try {
    return fn();
  } catch (e) {
    if (e instanceof NotPortedError) return "not ported";
    throw e;
  }
}

describe.skipIf(!existsSync(root))("gen3 data/save modules D (FireRed)", () => {
  beforeAll(() => {
    setHost(new DesktopHost(root));
    if (Pokemon) Pokemon.install(cache);
  });

  test.skipIf(!HealLocations)("heal locations: baked whiteout points from the cache", () => {
    HealLocations.invalidate();
    expect(HealLocations.load(cache)).toBe(20);
    expect(HealLocations.get(1)).toEqual({ map: "FR_PLAYERS_HOUSE_1F", x: 8, y: 5, healerLocalId: 1 });
    expect(HealLocations.get(2)!.map).toBe("FR_VIRIDIAN_CITY_POKEMON_CENTER_1F");
    expect(HealLocations.get(3)!.healerLocalId).toBe(3);
    expect(HealLocations.get(10)).toEqual({ map: "FR_INDIGO_PLATEAU_POKEMON_CENTER_1F", x: 13, y: 12, healerLocalId: 2 });
    for (let id = 1; id <= 20; id++) expect(HealLocations.get(id)).toEqual(HealLocations.BY_ID[id] as any);
    const s: any = { version: "firered" };
    expect(HealLocations.applyToSession(s, 2)).toBe(true);
    expect([s.healMap, s.healX, s.healY, s.healHealerLocalId]).toEqual(["FR_VIRIDIAN_CITY_POKEMON_CENTER_1F", 7, 4, 1]);
    expect(HealLocations.get(99)).toBeUndefined();
    // bedroom 2F default -> Mom's house 1F
    const s2: any = { version: "firered", healMap: "FR_PLAYERS_HOUSE_2F" };
    const r = orNotPorted(() => HealLocations.normalizeSession(s2));
    if (r !== "not ported") expect(s2.healMap).toBe("FR_PLAYERS_HOUSE_1F");
  });

  test("options: defaults, engine block, aliases", () => {
    const s: any = { version: "firered" };
    expect(Options.textSpeed(s)).toBe(1);
    expect(Options.battleStyle(s)).toBe("shift");
    expect(Options.battleScene(s)).toBe(true);
    expect(Options.mono(s)).toBe(true);
    expect(Options.voidFill(s)).toBe("map");
    Options.set(s, "l_equals_a", true);
    expect(s.options.buttonMode).toBe(2);
    expect(Options.lEqualsA(s)).toBe(true);
    Options.set(s, "text_speed", 5);
    expect(Options.textSpeed(s)).toBe(2);
    // a legacy engine table: root cart keys migrate into the firered block
    const engine: any = { battleStyle: 1, textSpeed: 2, text_speed: 2, l_equals_a: false };
    const s2: any = { version: "firered" };
    const o = Options.bind(s2, engine)!;
    expect(engine.firered).toBe(o);
    expect(engine.battleStyle).toBeUndefined();
    expect(o.battleStyle).toBe(1);
    expect(o.textSpeed).toBe(2);
    expect(o.text_speed).toBe(2);
    expect(Options.battleStyle(s2)).toBe("set");
    expect(Options.engine(s2)).toBe(engine);
    expect(Options.blockId(s2)).toBe("firered");
  });

  test("mail: pool, give/take, daycare round trip, unown, export", () => {
    const s: any = { name: "RED", trainerId: 12345 };
    const mon: any = { species: 25, personality: 7 };
    expect(Mail.giveMailToMon(s, mon, 121)).toBe(0);
    expect(len(s.mail)).toBe(16);
    expect(Mail.monHasMail(mon)).toBe(true);
    expect(mon.item).toBe(121);
    const rec = Mail.get(s, 0)!;
    expect([rec.playerName, rec.trainerId, rec.species, rec.itemId, rec.design]).toEqual(["RED", 12345, 25, 121, 0]);
    expect(len(rec.words)).toBe(9);
    rec.words[1] = 42;
    const dm = Mail.takeMonMailForDaycare(s, mon, "RED", "PIKACHU")!;
    expect(dm.message.words[1]).toBe(42);
    expect(Mail.monHasMail(mon)).toBe(false);
    expect(mon.item).toBe(0);
    expect(Mail.get(s, 0)).toBeUndefined();
    expect(Mail.export(s)).toBeUndefined();
    expect(Mail.giveDaycareMailToMon(s, mon, dm)).toBe(true);
    expect(Mail.get(s, 0)!.words[1]).toBe(42);
    expect(dm.otName).toBe("");
    expect(Mail.isEmpty(dm.message)).toBe(true);
    const exp = Mail.export(s);
    expect(len(exp)).toBe(16);
    const back = Mail.restore(exp);
    expect(back[1].words[1]).toBe(42);
    expect(Mail.isMailItem(133)).toBe(false);
    expect(Mail.designOf(132)).toBe(11);
    // Unown: letter from personality, mail species offset 30000
    const ms = Mail.speciesToMailSpecies(201, 0x01020304);
    expect(ms).toBeGreaterThanOrEqual(30000);
    expect(Mail.mailSpeciesToSpecies(ms)).toEqual([201, ms - 30000]);
    expect(Mail.mailSpeciesToSpecies(25)).toEqual([25, 0]);
  });

  test("fame checker: records, flavor text, giovanni index", () => {
    const s: any = { version: "firered" };
    const recs = FameChecker.records(s);
    expect(len(recs)).toBe(16);
    expect(FameChecker.pickState(s, FameChecker.PERSON.OAK)).toBe(2);
    expect(FameChecker.unlockedPersons(s)).toEqual(seq(0));
    expect(FameChecker.setFlavorText(FameChecker.PERSON.BROCK, 3, s)).toBe(true);
    expect(FameChecker.pickState(s, 2)).toBe(1);
    expect(FameChecker.hasFlavorText(s, 2, 3)).toBe(true);
    expect(FameChecker.hasFlavorText(s, 2, 2)).toBe(false);
    expect(FameChecker.updatePickState(2, 2, s)).toBe(true);
    expect(FameChecker.updatePickState(2, 1, s)).toBe(false); // COLORED stays
    expect(FameChecker.unlockedPersons(s)).toEqual(seq(0, 2));
    expect(s.modData.fameChecker).toBe(recs);
    FameChecker.fullyUnlock(s);
    expect(FameChecker.flavorTextFlags(s, 15)).toBe(63);
    expect(FameChecker.hasUnlockedAllFlavorTexts(s, 15)).toBe(true);
    expect(FameChecker.adjustGiovanniIndex(9, true)).toBe(15);
    expect(FameChecker.adjustGiovanniIndex(12, true)).toBe(11);
    expect(FameChecker.adjustGiovanniIndex(12, false)).toBe(12);
    expect(FameChecker.TRAINER_IDS[0]).toBe(0xFE00);
    expect(FameChecker.TRAINER_IDS[15]).toBe(348);
    expect(FameChecker.reset(s)).toBe(true);
    expect(FameChecker.pickState(s, 2)).toBe(0);
  });

  test.skipIf(!Rules)("help rules: ungated and always-on topics", () => {
    expect(Rules.enabled(1, 1, {})).toBe(true);
    expect(Rules.enabled(3, 14, {})).toBe(true);
    expect(Rules.enabled(3, 99, {})).toBe(true); // unknown id, topic >= 3
    expect(Rules.enabled(1, 99, {})).toBe(false);
    const map = orNotPorted(() => Rules.enabled(2, 14, { bag: undefined }));
    expect(map).toBe(false);
  });

  test("quest log: record, sample, restore, playback", () => {
    const s: any = { map: "FR_PALLET_TOWN" };
    const frame = (x: number) => ({ x, y: 32, actors: seq({ id: 255, x, y: 32 }, { id: 3, x: x + 400, y: 32 }) });
    Q.record(s, "ArrivedInLocation", seq("PALLET TOWN"), frame(0));
    for (let i = 0; i < 12; i++) Q.sample(s, frame(16 + i), 1);
    expect(len(s.questLog.scenes)).toBe(1);
    expect(len(s.questLog.scenes[1].frames)).toBe(3);
    Q.addTiles(s, { "0,0": seq(1, 2) });
    expect(s.questLog.scenes[1].tiles["0,0"]).toEqual(seq(1, 2));
    // healing twice at the same frame keeps one event
    Q.record(s, "MonsWereFullyRestoredAtCenter", {}, frame(0));
    Q.record(s, "MonsWereFullyRestoredAtCenter", {}, frame(0));
    expect(len(s.questLog.scenes[1].events)).toBe(2);
    for (const m of ["A", "B", "C", "D"]) { s.map = m; Q.record(s, "x", {}, frame(0)); }
    expect(len(s.questLog.scenes)).toBe(4);
    expect(s.questLog.scenes[1].map).toBe("A");
    const log = Q.export(s);
    expect(len(log.scenes)).toBe(4);
    // restore trims far actors out of view
    expect(len(log.scenes[1].frames[1].actors)).toBe(1);
    const pb = Q.playback(log)!;
    expect(pb.number()).toBe(4);
    expect(pb.current()!.map).toBe("A");
    pb.update({ a: true });
    expect(pb.current()!.map).toBe("B");
    expect(pb.event()!.key).toBe("x");
    expect(pb.frame()!.x).toBe(0);
    pb.update({ b: true });
    expect(pb.done).toBe(true);
    expect(Q.playback({ version: 1, scenes: seq() })).toBeUndefined();
  });

  test.skipIf(!R)("quest log recorder: location name", () => {
    const loc = R.location(null, { map: "FR_PALLET_TOWN" });
    expect(loc[0]).toContain("PALLET TOWN");
    const odd = R.location(null, { map: "FR_NOT_A_MAP_XYZ" });
    expect(typeof odd[0]).toBe("string");
  });

  test.skipIf(!Daycare)("daycare: slots, steps, egg cycles", () => {
    const s: any = { version: "firered", name: "RED", party: seq({ species: 25, nickname: "PIKA", level: 10 }, { species: 1, level: 5 }) };
    const dc = Daycare.stateOf(s);
    expect(s.modData.firered_daycare.daycare).toBe(dc);
    expect(dc.steps).toEqual(seq(0, 0));
    expect(Daycare.count(dc)).toBe(0);
    expect(Daycare.deposit(s, 1)).toBe(1);
    expect(Daycare.count(dc)).toBe(1);
    expect(s.party[1].species).toBe(1);
    expect(len(s.party)).toBe(1);
    expect(Daycare.findEmptySpot(dc)).toBe(2);
    expect(Daycare.nickname(Daycare.mon(dc, 1))).toBe("PIKA");
    const [valid] = Daycare.step(s);
    expect(valid).toBe(1);
    expect(dc.steps[1]).toBe(1);
    expect(dc.stepCounter).toBe(1);
    // slot shifting
    Daycare.setMon(dc, 2, Daycare.mon(dc, 1));
    Daycare.setMon(dc, 1, undefined);
    dc.steps[2] = 7;
    Daycare.shiftSlots(dc);
    expect(Daycare.mon(dc, 1).species).toBe(25);
    expect(Daycare.mon(dc, 2)).toBeUndefined();
    expect(dc.steps[1]).toBe(7);
    // egg cycles tick down; a 0-cycle egg reports its slot
    const s2: any = { version: "firered", party: seq({ species: 172, isEgg: true, friendship: 3 }, { species: 25, isEgg: true, friendship: 0 }) };
    expect(Daycare.tickEggCycles(s2)).toBe(2);
    expect(s2.party[1].friendship).toBe(2);
    expect(Daycare.isEggPending({ offspringPersonality: 5 })).toBe(true);
    // route 5
    const r5 = Daycare.route5Of(s);
    expect(r5.steps).toBe(0);
    expect(Daycare.depositRoute5(s, 1)).toBe(true);
    expect(r5.mon.species).toBe(1);
    Daycare.step(s);
    expect(r5.steps).toBe(1);
  });

  test.skipIf(!Breeding || !Pokemon)("breeding: egg species, compatibility, parents, IVs", () => {
    expect(Breeding.eggSpecies(26)).toBe(172); // Raichu -> Pichu
    expect(Breeding.eggSpecies(3)).toBe(1);
    expect(Breeding.eggSpecies(132)).toBe(132);
    expect(Breeding.eggGroups(132)).toEqual(seq(13, 13));
    expect(Breeding.eggGroupsOverlap(seq(1, 5), seq(5, 7))).toBe(true);
    expect(Breeding.eggGroupsOverlap(seq(1, 5), seq(2, 7))).toBe(false);
    const nidoF = { species: 29, personality: 0, otId: 1 };
    const nidoM = { species: 32, personality: 0, otId: 2 };
    const ditto = { species: 132, personality: 0, otId: 1 };
    expect(Breeding.compatibility({ 1: nidoF, 2: nidoM })).toBe(50);
    expect(Breeding.compatibility({ 1: nidoF, 2: { ...nidoM, otId: 1 } })).toBe(20);
    expect(Breeding.compatibility({ 1: ditto, 2: nidoM })).toBe(50);
    expect(Breeding.compatibility({ 1: ditto, 2: { ...ditto } })).toBe(0);
    expect(Breeding.compatibility({ 1: { species: 30 }, 2: nidoM })).toBe(0); // undiscovered
    // ditto + female nidoran, male offspring personality -> Nidoran M, mother slot 2
    expect(Breeding.parentSlots({ 1: ditto, 2: nidoF, offspringPersonality: 0x8001 })).toEqual([32, 2, 1]);
    expect(Breeding.parentSlots({ 1: ditto, 2: nidoM, offspringPersonality: 1 })).toEqual([32, 1, 2]);
    expect(Breeding.alterEggSpeciesWithIncenseItem(360, { 1: nidoF, 2: nidoM })).toBe(202);
    expect(Breeding.alterEggSpeciesWithIncenseItem(360, { 1: { item: 221 }, 2: nidoM })).toBe(360);
    expect(Breeding.alterEggSpeciesWithIncenseItem(350, { 1: nidoF, 2: nidoM })).toBe(183);
    // IV inheritance: three distinct stats, each from a parent
    Rng.SeedRng(0x1234);
    const egg: any = { species: 29 };
    const pa = { ivs: { hp: 1, atk: 2, def: 3, spe: 4, spa: 5, spd: 6 } };
    const pb = { ivs: { hp: 11, atk: 12, def: 13, spe: 14, spa: 15, spd: 16 } };
    const [selected, which] = Breeding.inheritIVs(egg, { 1: pa, 2: pb }, { version: "firered" }) as [any, any];
    const stats = [selected[1], selected[2], selected[3]];
    expect(new Set(stats).size).toBe(3);
    for (let i = 1; i <= 3; i++) {
      const key = Breeding.IV_KEYS[selected[i]] as string;
      expect(egg.ivs[key]).toBe((which[i] === 1 ? pa : pb).ivs[key as "hp"]);
    }
    // a pending egg: offspring personality in 1..0xFFFE, flag store absent
    const dc: any = { steps: seq(0, 255), 1: nidoF, 2: nidoM };
    const p = Breeding.triggerPendingEgg({ version: "firered" }, dc);
    expect(p).toBeGreaterThanOrEqual(1);
    expect(p).toBeLessThanOrEqual(0xFFFE);
    expect(dc.eggPending).toBe(true);
    expect(Breeding.tryProduceEgg({ version: "firered" }, dc, 2)).toBe(false); // already pending
    Breeding.removeEgg(dc);
    expect(Daycare.isEggPending(dc)).toBe(false);
    expect(Breeding.pendingEggFlag({ version: "firered" })).toBe(0x266);
  });

  test.skipIf(!Breeding || !Pokemon)("breeding: egg moveset and egg data", () => {
    const egg: any = { species: 172, moves: seq() };
    const r = orNotPorted(() => Breeding.buildEggMoveset(egg, { moves: seq(3, 0, 0, 0) }, { moves: seq(0, 0, 0, 0) }));
    if (r !== "not ported") expect(egg.moves).toContain(3); // Pichu egg move 3
    const e2: any = Breeding.applyEggData({ species: 183 }, true);
    expect([e2.eggCycles, e2.level, e2.isEgg, e2.metLocation, e2.pokeball]).toEqual([10, 5, true, 253, 4]);
    const made = orNotPorted(() => Breeding.createEgg({ version: "firered", party: seq() }, 172));
    if (made !== "not ported" && made) {
      expect(made.isEgg).toBe(true);
      expect(made.species).toBe(172);
    }
  });
});
}

// ---------------------------------------------------------------- battle_bridge, battle_downgrade
{
// Scratch tests for the gen3 battle_downgrade / battle_bridge ports (worker E).

describe("battle_downgrade", () => {
  test("moveToHost: nil/0, Gen 2 range, Gen 3 fallbacks, strings", () => {
    expect(Downgrade.moveToHost(undefined)).toBeUndefined();
    expect(Downgrade.moveToHost(0)).toBeUndefined();
    expect(Downgrade.moveToHost(33)).toBe(33); // TACKLE
    expect(Downgrade.moveToHost(251)).toBe(251);
    expect(Downgrade.moveToHost(348)).toBe("LEAF_BLADE");
    expect(Downgrade.moveToHost(291)).toBe("DIVE");
    expect(Downgrade.moveToHost(252)).toBe("STRUGGLE"); // FAKE_OUT: no fallback row
    expect(Downgrade.moveToHost(343)).toBe("STRUGGLE"); // COVET
    expect(Downgrade.moveToHost(true)).toBe("STRUGGLE"); // tonumber(true) == nil
    expect(Downgrade.moveToHost("TACKLE")).toBe("TACKLE");
    expect(Downgrade.moveToHost("SURF", { SURF: true })).toBe("SURF");
    // Lua keeps "348" and 348 apart: a string id never hits the number-keyed table
    expect(Downgrade.moveToHost("348")).toBe("348");
  });

  test("stripAbility / speciesToHost", () => {
    expect(Downgrade.stripAbility(65)).toBeUndefined();
    expect(Downgrade.speciesToHost(25)).toBe(25);
    expect(Downgrade.speciesToHost("25")).toBe(25); // tonumber("25")
    expect(Downgrade.speciesToHost(251)).toBe(251);
    expect(Downgrade.speciesToHost(386)).toBeUndefined(); // DEOXYS: caller skips
    expect(Downgrade.speciesToHost("SPECIES_DEOXYS")).toBe("SPECIES_DEOXYS");
    expect(Downgrade.speciesToHost(undefined)).toBeUndefined();
  });

  test("foePayload", () => {
    expect(Downgrade.foePayload(undefined)).toBeUndefined();
    expect(Downgrade.foePayload({ species: 386, level: 30 })).toBeUndefined();
    const p = Downgrade.foePayload({ id: 16, level: 3, moves: seq(33, 28, 348), item: 0, ability: 51, gender: 1 })!;
    expect(p.species).toBe(16);
    expect(p.level).toBe(3);
    expect(p.moves[1]).toBe(33);
    expect(p.moves[2]).toBe(28);
    expect(p.moves[3]).toBe("LEAF_BLADE");
    expect(p.moves[4]).toBeUndefined();
    expect(p.item).toBe(0);
    expect(p.ability).toBeUndefined();
    expect(Downgrade.foePayload({ species: 1 })!.level).toBe(5);
  });

  test("playerBattleView + writebackPlayerPp round trip", () => {
    const party = seq<any>(
      { species: 4, level: 12, hp: 30, moves: seq(10, 45, 52), pp: seq(35, 40, 25) },
      { species: 25, level: 9, moves: seq<any>(84, "VOLT_TACKLE"), pp: seq(30, 15) },
    );
    const overlay: any = { 1: { 3: { frlgMoveId: 341, pp: 12 } } };
    const [bp, remap] = Downgrade.playerBattleView(party, overlay);
    expect(len(bp)).toBe(2);
    expect(bp[1].species).toBe(4);
    expect(bp[1].hp).toBe(30);
    expect(bp[1].moves[1]).toBe(10);
    expect(bp[1].moves[3]).toBe("MUD_SHOT");
    expect(bp[1].pp[3]).toBe(12);
    expect(bp[2].moves[2]).toBe("VOLT_TACKLE"); // named moves pass through
    expect(bp[1].moves).not.toBe(party[1].moves);
    expect(len(remap)).toBe(1);
    expect(remap[1]).toEqual({ partySlot: 1, moveSlot: 3, frlgMoveId: 341, hostFallbackId: "MUD_SHOT" });

    bp[1].pp[3] = 7;
    const out = Downgrade.writebackPlayerPp(party, overlay, remap, bp)!;
    expect(out).toBe(overlay);
    expect(out[1][3]).toEqual({ frlgMoveId: 341, pp: 7 });
    expect(party[1].pp[3]).toBe(7);
    expect(party[1].moves[3]).toBe(52); // never the fallback id
    expect(Downgrade.writebackPlayerPp(party, overlay, undefined, bp)).toBeUndefined();
  });

  test("playerBattleView on a non-table party", () => {
    const [bp, remap] = Downgrade.playerBattleView(undefined);
    expect(len(bp)).toBe(0);
    expect(len(remap)).toBe(0);
  });
});

describe("battle_bridge (pure parts)", () => {
  test("mapBattleScene reads the map def's battleType", () => {
    const game = { data: { maps: { MAP_ROUTE1: { battleType: "3" }, MAP_X: {} } } };
    expect(BattleBridge.mapBattleScene("MAP_ROUTE1", game)).toBe(3);
    expect(BattleBridge.mapBattleScene("MAP_X", game)).toBeUndefined();
    expect(BattleBridge.mapBattleScene("MAP_NONE", game)).toBeUndefined();
    expect(BattleBridge.mapBattleScene(12, game)).toBeUndefined();
  });

  test("EXTRA_KINDS is the 28-name sequence", () => {
    expect(len(BattleBridge.EXTRA_KINDS)).toBe(28);
    expect(BattleBridge.EXTRA_KINDS[1]).toBe("twoOpponents");
    expect(BattleBridge.EXTRA_KINDS[28]).toBe("victoryTextB");
  });

  test("applyLeagueFriendship early-outs", () => {
    expect(BattleBridge.applyLeagueFriendship({}, seq(), {}, { wild: true })).toBe(false);
    expect(BattleBridge.applyLeagueFriendship(undefined, seq(), {}, {})).toBe(false);
  });

  test("money loss reaches unported neighbours", () => {
    expect(() => BattleBridge.calcMoneyLossFrlg({ party: seq() }, undefined)).toThrow(NotPortedError);
    expect(() => BattleBridge.applyWhiteoutMoneyLoss({ money: 1000 })).toThrow(NotPortedError);
  });

  test("reset / finishPending run a pending finish once", () => {
    const got: any[] = [];
    BattleBridge._finish = (r) => { got.push(r); };
    BattleBridge.finishPending();
    expect(got).toEqual(["win"]);
    expect(BattleBridge._finish).toBeUndefined();
    BattleBridge._remap = seq();
    BattleBridge.reset();
    expect(BattleBridge._remap).toBeUndefined();
  });

  test("start needs the runtime session (unported)", () => {
    expect(() => BattleBridge.start(undefined, {}, {}, {})).toThrow(NotPortedError);
  });
});
}
