// The port's ENHANCEMENTS and CHEATS on the Gold engine (voxelmon/game/gen2/
// core/Cheats.ts and the places it reaches): each setting at the engine
// level against the real Gold data, the OPTION rows, the bottom screen's
// CHEATS tab, and the save formats that must not carry or trip on the keys.
// Skips without the import.

import { afterAll, describe, expect, test } from "bun:test";
import { haveGoldGen, useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { seed, random } from "../voxelmon/game/gen2/platform/rng.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";
import { Cheats, SHINY_ODDS } from "../voxelmon/game/gen2/core/Cheats.ts";
import { Mon } from "../voxelmon/game/gen2/battle/Mon.ts";
import { Battle } from "../voxelmon/game/gen2/battle/Battle.ts";
import { Catching } from "../voxelmon/game/gen2/battle/Catching.ts";
import { Evolution } from "../voxelmon/game/gen2/core/Evolution.ts";
import { Breeding } from "../voxelmon/game/gen2/core/Breeding.ts";
import { FieldMoves } from "../voxelmon/game/gen2/world/FieldMoves.ts";
import { Permissions } from "../voxelmon/game/gen2/world/Permissions.ts";
import { PartyMenu } from "../voxelmon/game/gen2/ui/PartyMenu.ts";
import { OptionsMenu } from "../voxelmon/game/gen2/ui/OptionsMenu.ts";
import { Companion } from "../voxelmon/game/gen2/ui/Companion.ts";
import { Chrome } from "../voxelmon/game/gen2/ui/Chrome.ts";
import { Save } from "../voxelmon/game/gen2/core/Save.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";

const gold = haveGoldGen();
const t = test.skipIf(!gold);

/** The options the engine reads, swapped per test. */
let opts: Record<string, any> = {};
function use(o: Record<string, any>): void {
  opts = o;
  Cheats.bind(() => opts);
}
afterAll(() => Cheats.bind(() => undefined));

let shared: any;
/** One loaded game (data only) shared by the engine tests. */
function data(): any {
  if (!shared) {
    useGoldGen();
    seed(0x51);
    const g: any = Game2.new();
    g.load({ startWorld: false });
    g.stack.clear();
    shared = g;
  }
  // Game2 binds its own options; the engine tests drive `opts`
  Cheats.bind(() => opts);
  return shared.data;
}

const perfect = () => ({ attack: 15, defense: 15, speed: 15, special: 15 });
const save = (extra?: Record<string, any>): any => ({ player: { id: 4242, name: "GOLD", money: 3000, badges: {} }, inventory: {}, pokedex: { seen: {}, caught: {} }, ...extra });

describe("gen2 cheats: the readers", () => {
  test("unset is the cart: everything OFF, NORMAL encounters, 1/8192", () => {
    use({});
    for (const f of [Cheats.expForCatching, Cheats.partyExpShare, Cheats.tradeEvoLv40, Cheats.hmsWithoutMove,
      Cheats.tabShown, Cheats.alwaysCatch, Cheats.instantVictory, Cheats.fastEggs, Cheats.infiniteMoney]) {
      expect(f()).toBe(false);
    }
    expect(Cheats.wildRate()).toBe("normal");
    expect(Cheats.shinyOdds()).toBe(8192);
    // junk reads as the default rather than as a setting
    use({ wildEncounters: "lots", shinyOdds: 3, alwaysCatch: "yes" });
    expect(Cheats.wildRate()).toBe("normal");
    expect(Cheats.shinyOdds()).toBe(8192);
    expect(Cheats.alwaysCatch()).toBe(false);
    expect(Cheats.step(SHINY_ODDS, 1, 1)).toBe(8192);
  });
});

describe("gen2 cheats: EXP", () => {
  t("PARTY EXP SHARE: fighters full, the rest half; eggs and fainted mons nothing; the EXP SHARE item adds nothing", () => {
    const D = data();
    const build = (): any => {
      const fighter = Mon.new(D, "CYNDAQUIL", 20, { dvs: perfect() })!;
      const bench = Mon.new(D, "PIDGEY", 10, { dvs: perfect() })!;
      const egg = Mon.new(D, "TOGEPI", 5, {})!;
      egg.isEgg = true;
      const down = Mon.new(D, "RATTATA", 10, {})!;
      down.hp = 0;
      const wild = Mon.new(D, "GEODUDE", 15, { dvs: perfect() })!;
      const s = save();
      const party = [fighter, bench, egg, down];
      s.party = party;
      const battle: any = Battle.new({ data: D, party, wild, save: s });
      return { battle, fighter, bench, egg, down, wild };
    };
    const def = D.pokemon.GEODUDE;
    const full = Mon.experienceGain(def, 15, 1, false, {});
    const half = Mon.experienceGain(def, 15, 1, false, { halved: true });
    expect(half).toBe(Math.floor(full / 2));

    // off: the cart -- the fighter alone
    use({});
    let b = build();
    let before = [b.fighter.experience, b.bench.experience, b.egg.experience, b.down.experience];
    b.battle.awardExperience(b.wild);
    expect(b.fighter.experience - before[0]).toBe(full);
    expect(b.bench.experience - before[1]).toBe(0);

    use({ partyExpShare: true });
    b = build();
    before = [b.fighter.experience, b.bench.experience, b.egg.experience, b.down.experience];
    b.battle.awardExperience(b.wild);
    expect(b.fighter.experience - before[0]).toBe(full);
    expect(b.bench.experience - before[1]).toBe(half);
    expect(b.egg.experience - before[2]).toBe(0);
    expect(b.down.experience - before[3]).toBe(0);
    // the bench mon's stat exp is halved like its EXP
    expect(b.bench.statExp.defense).toBe(Math.floor(def.baseStats.defense / 2));

    // a held EXP SHARE: no tax on the fighter, no second pass for the holder
    b = build();
    b.bench.item = "EXP_SHARE";
    before = [b.fighter.experience, b.bench.experience];
    b.battle.awardExperience(b.wild);
    expect(b.fighter.experience - before[0]).toBe(full);
    expect(b.bench.experience - before[1]).toBe(half);
  });

  t("PARTY EXP SHARE levels a mon that never fought, and it learns its moves", () => {
    const D = data();
    use({ partyExpShare: true });
    const fighter = Mon.new(D, "CYNDAQUIL", 30, { dvs: perfect() })!;
    // CHIKORITA learns RAZOR LEAF at 8: one EXP short of level 8
    const bench = Mon.new(D, "CHIKORITA", 7, { dvs: perfect() })!;
    const growth = Mon.growthFor(D, D.pokemon.CHIKORITA.growthRate);
    bench.experience = Mon.experienceForLevel(growth, 8) - 1;
    const wild = Mon.new(D, "GEODUDE", 20, {})!;
    const s = save({ party: [fighter, bench] });
    const battle: any = Battle.new({ data: D, party: s.party, wild, save: s });
    battle.awardExperience(wild);
    expect(bench.level).toBeGreaterThanOrEqual(8);
    const events = battle.takeEvents();
    expect(events.some((e: any) => e.kind === "level" && e.index === 2)).toBe(true);
    expect(bench.moves.map((m: any) => m.id)).toContain("RAZOR_LEAF");
  });

  t("EXP FOR CATCHING: a catch pays the faint's award (a wild battle only)", () => {
    const D = data();
    const run = (o: Record<string, any>): { gained: number; events: any[] } => {
      use(o);
      const fighter = Mon.new(D, "CYNDAQUIL", 20, { dvs: perfect() })!;
      const wild = Mon.new(D, "SENTRET", 6, {})!;
      const s = save({ party: [fighter] });
      const battle: any = Battle.new({ data: D, party: s.party, wild, save: s });
      const before = fighter.experience;
      const [caught] = Catching.attempt({ battle, mon: wild, ball: "MASTER_BALL", random: () => 0 } as any);
      expect(caught).toBe(true);
      return { gained: fighter.experience - before, events: battle.takeEvents() };
    };
    expect(run({}).gained).toBe(0);
    const on = run({ expForCatching: true });
    expect(on.gained).toBe(Mon.experienceGain(D.pokemon.SENTRET, 6, 1, false, {}));
    expect(on.events.some((e: any) => e.kind === "experience")).toBe(true);
  });
});

describe("gen2 cheats: TRADE EVO LV.40", () => {
  t("plain trade rows at 40, item rows with the item held (and eaten); never a stone, never under an EVERSTONE", () => {
    const D = data();
    const mon = (species: string, level: number, item?: string): any => Mon.new(D, species, level, { item })!;
    const into = (m: any, ctx: any = {}): any => Evolution.checkMon(D, m, ctx)[0]?.into;
    use({});
    expect(into(mon("GRAVELER", 45))).toBeUndefined();
    use({ tradeEvoLv40: true });
    expect(into(mon("GRAVELER", 39))).toBeUndefined();
    expect(into(mon("GRAVELER", 40))).toBe("GOLEM");
    expect(into(mon("GRAVELER", 40, "EVERSTONE"))).toBeUndefined();
    expect(into(mon("GRAVELER", 40), { force: true, item: "MOON_STONE" })).toBeUndefined();
    // a real link still works as the cart's
    expect(into(mon("GRAVELER", 12), { link: true })).toBe("GOLEM");
    expect(into(mon("ONIX", 40))).toBeUndefined();
    const onix = mon("ONIX", 40, "METAL_COAT");
    const [entry, eats] = Evolution.checkMon(D, onix, {});
    expect(entry?.into).toBe("STEELIX");
    expect(eats).toBe(true);
    expect(Evolution.apply(D, onix, entry!)!.item).toBeUndefined();
    // SLOWPOKE: its level row wins without the KING'S ROCK, the trade row with it
    expect(into(mon("SLOWPOKE", 40))).toBe("SLOWBRO");
    expect(into(mon("SLOWPOKE", 40, "KINGS_ROCK"))).toBe("SLOWKING");
    expect(into(mon("SLOWPOKE", 38, "KINGS_ROCK"))).toBe("SLOWBRO");
    // POLIWHIRL needs the KING'S ROCK for POLITOED; no stone is used up
    expect(into(mon("POLIWHIRL", 45))).toBeUndefined();
    expect(into(mon("POLIWHIRL", 45, "KINGS_ROCK"))).toBe("POLITOED");
    // the after-battle sweep reaches it the same way
    const party = [mon("GRAVELER", 40)];
    expect(Evolution.plan(D, party, { 1: true }, {})[0]?.into).toBe("GOLEM");
  });
});

describe("gen2 cheats: HMS WITHOUT MOVE", () => {
  t("the HM in the bag stands in for the move; the badge is still the cart's gate", () => {
    const D = data();
    const party = [Mon.new(D, "PIDGEY", 20, {})!];
    const s = save({ party, inventory: { HM_CUT: 1, HM_SURF: 1, TM_HEADBUTT: 1 } });
    use({});
    expect(FieldMoves.partyMoveUser(party, "CUT", { save: s })).toBeUndefined();
    use({ hmsWithoutMove: true });
    expect(FieldMoves.partyMoveUser(party, "CUT", { save: s })).toBe(party[0]);
    expect(FieldMoves.partyMoveUser(party, "HEADBUTT", { save: s })).toBe(party[0]);
    // no HM, no stand-in; an egg never stands in
    expect(FieldMoves.partyMoveUser(party, "STRENGTH", { save: s })).toBeUndefined();
    const egg = Mon.new(D, "TOGEPI", 5, {})!;
    egg.isEgg = true;
    expect(FieldMoves.partyMoveUser([egg], "CUT", { save: s })).toBeUndefined();
    // CUT on a tree: no HIVEBADGE is the cart's "can be CUT" line
    const cut = (badges: any) => FieldMoves.tryCutOW({ save: { ...s, player: { badges } }, party, facingBlock: 0x5b, tileset: "TILESET_JOHTO" } as any);
    expect(cut({}).ok).toBe(false);
    expect(cut({ HIVE: true }).ok).toBe(true);
    // SURF: the shore asks once the FOG badge is in
    let water = -1;
    for (let c = 0; c < 256 && water < 0; c++) if (Permissions.isWater(c)) water = c;
    const surf = (badges: any) => FieldMoves.trySurfOW({ save: { ...s, player: { badges } }, party, facingColl: water, playerColl: 0, facing: "up" } as any);
    expect(surf({}).ok).toBe(false);
    expect(surf({ FOG: true }).ok).toBe(true);
    expect(surf({ FOG: true }).mon).toBe(party[0]);
  });

  t("FLY and FLASH in a mon's party menu with the HM in the bag", () => {
    const D = data();
    const mon = Mon.new(D, "RATTATA", 10, {})!;
    const menu: any = Object.create(PartyMenu.prototype);
    menu.moves = D.moves;
    menu.game = { save: save({ inventory: { HM_FLY: 1 } }) };
    use({});
    expect(menu.buildSubmenuItems(mon).map((i: any) => i.id)).not.toContain("FLY");
    use({ hmsWithoutMove: true });
    const ids = menu.buildSubmenuItems(mon).map((i: any) => i.id);
    expect(ids).toContain("FLY");
    expect(ids).not.toContain("FLASH");
    expect(ids.slice(-5)).toEqual(["STATS", "SWITCH", "MOVE", "ITEM", "CANCEL"].slice(-5));
    // the menu path still asks for the badge
    const ctx = { save: { player: { badges: {} } }, environment: "ROUTE" } as any;
    expect(FieldMoves.flyFromMenu(ctx).ok).toBe(false);
  });
});

describe("gen2 cheats: WILD ENCOUNTERS", () => {
  test("the rate halves, doubles (capped), or is nothing", () => {
    expect(Cheats.scaleEncounterRate(25, "normal")).toBe(25);
    expect(Cheats.scaleEncounterRate(25, "less")).toBe(12);
    expect(Cheats.scaleEncounterRate(1, "less")).toBe(1);
    expect(Cheats.scaleEncounterRate(25, "more")).toBe(50);
    expect(Cheats.scaleEncounterRate(200, "more")).toBe(255);
    expect(Cheats.scaleEncounterRate(25, "none")).toBe(0);
    expect(Cheats.scaleEncounterRate(0, "more")).toBe(0);
  });

  t("on ROUTE_29's grass: NONE meets no ordinary mon but still a roamer; MORE meets more than NORMAL", () => {
    useGoldGen();
    seed(0x2929);
    const game: any = Game2.new();
    game.load({ startWorld: true });
    for (let i = 0; i < 10; i++) game.frame(0);
    game.world.setMap("ROUTE_29", 10, 10, "down");
    for (let i = 0; i < 30; i++) game.frame(0);
    game.save.party = [Mon.new(game.data, "CYNDAQUIL", 30, {})];
    const world = game.world;
    let grass = -1;
    for (let c = 0; c < 256 && grass < 0; c++) {
      if (Permissions.isEncounterCollision(c) && !Permissions.isWater(c) && !Permissions.isIce(c)) grass = c;
    }
    world.map.cellCollision = () => grass;
    const met: any[] = [];
    world.startBattle = (o: any) => met.push(o);
    const steps = (n: number): number => {
      met.length = 0;
      for (let i = 0; i < n; i++) {
        world.wildCooldown = 0;
        world.tryWildEncounter();
      }
      return met.length;
    };
    game.options.wildEncounters = "normal";
    const normal = steps(3000);
    game.options.wildEncounters = "more";
    const more = steps(3000);
    game.options.wildEncounters = "less";
    const less = steps(3000);
    game.options.wildEncounters = "none";
    const none = steps(3000);
    expect(normal).toBeGreaterThan(0);
    expect(more).toBeGreaterThan(normal * 1.5);
    expect(less).toBeLessThan(normal * 0.75);
    expect(none).toBe(0);
    // a roaming beast on this map is still met at NONE, and nothing else is
    game.save.roamers = [
      { species: "RAIKOU", level: 40, map: "ROUTE_29", hp: 0 },
      { species: "ENTEI", level: 40, map: "ROUTE_29", hp: 0 },
      { species: "SUICUNE", level: 40, map: "ROUTE_29", hp: 0 },
    ];
    expect(steps(3000)).toBeGreaterThan(0);
    expect(met.every((o) => o.roaming != null)).toBe(true);
    delete game.options.wildEncounters;
    Cheats.bind(() => opts);
  });
});

describe("gen2 cheats: SHINY ODDS", () => {
  t("the cart's odds draw the cart's DVs; 1/N is 1/N; a non-shiny roll is never shiny; 1/1 always", () => {
    const D = data();
    // 1/8192 takes no extra random number: the same sequence as the cart's roll
    use({});
    seed(77);
    const a = Array.from({ length: 50 }, () => Mon.randomDVs());
    seed(77);
    const b = Array.from({ length: 50 }, () => Mon.cartDVs());
    expect(a).toEqual(b);
    // 1/64 over 64000 rolls: 1000 expected, sd ~31
    use({ shinyOdds: 64 });
    seed(1234);
    let shiny = 0;
    for (let i = 0; i < 64000; i++) {
      const d = Mon.randomDVs();
      for (const k of ["attack", "defense", "speed", "special"] as const) {
        expect(d[k]! >= 0 && d[k]! <= 15).toBe(true);
      }
      if (Mon.vanillaShiny(d)) shiny++;
    }
    expect(shiny).toBeGreaterThan(850);
    expect(shiny).toBeLessThan(1150);
    // 1/1: every wild and gift mon
    use({ shinyOdds: 1 });
    for (let i = 0; i < 20; i++) expect(Mon.new(D, "SENTRET", 5, {})!.shiny).toBe(true);
    // a day-care egg too (its own two random bytes, then the odds)
    const dad = Mon.new(D, "PIKACHU", 20, { dvs: perfect() })!;
    const mom = Mon.new(D, "DITTO", 20, { dvs: perfect() })!;
    const egg = Breeding.makeEgg(D, dad, mom, { rng: () => random(0, 255) } as any)!;
    expect(Mon.vanillaShiny(egg.dvs)).toBe(true);
    // a trainer's fixed DVs are left alone
    expect(Mon.new(D, "SENTRET", 5, { dvs: { attack: 9, defense: 8, speed: 8, special: 8 } })!.shiny).toBe(false);
  });
});

describe("gen2 cheats: ALWAYS CATCH", () => {
  t("every ball at a wild mon catches; a trainer's mon is never caught", () => {
    const D = data();
    const wild = Mon.new(D, "SENTRET", 30, {})!;
    const battle: any = Battle.new({ data: D, party: [Mon.new(D, "CYNDAQUIL", 5, {})], wild, save: save() });
    const throwAt = (b: any) => Catching.attempt({ battle: b, mon: wild, ball: "POKE_BALL", catchRate: 3, maxHp: 100, hp: 100, random: () => 255 } as any);
    use({});
    expect(throwAt(battle)[0]).toBe(false);
    use({ alwaysCatch: true });
    expect(throwAt(battle)).toEqual([true, 255]);
    expect(Catching.chance({ battle, ball: "POKE_BALL", catchRate: 3, maxHp: 100, hp: 100 } as any)).toBe(100);
    const trainer: any = Battle.new({ data: D, party: [Mon.new(D, "CYNDAQUIL", 5, {})], trainer: { party: [Mon.new(D, "SENTRET", 3, {})] }, save: save() });
    expect(throwAt(trainer)[0]).toBe(false);
  });
});

describe("gen2 cheats: INSTANT VICTORY", () => {
  t("FIGHT knocks out each foe in turn; the win pays EXP and the prize and says the win text", () => {
    const D = data();
    use({ instantVictory: true });
    const fighter = Mon.new(D, "CYNDAQUIL", 10, { dvs: perfect() })!;
    const s = save({ party: [fighter] });
    const foes = [Mon.new(D, "PIDGEY", 7, {})!, Mon.new(D, "PIDGEOTTO", 9, {})!];
    const battle: any = Battle.new({
      data: D, party: s.party, save: s,
      trainer: { class: "FALKNER", classId: "FALKNER", name: "FALKNER", party: foes, baseMoney: 25, winText: "I won't forget!" },
    });
    const exp0 = fighter.experience;
    const all: any[] = [];
    let events = battle.takeTurn({ kind: "move", move: "TACKLE" });
    all.push(...events);
    expect(foes[0]!.hp).toBe(0);
    expect(events.some((e: any) => e.kind === "faint" && e.side === "enemy")).toBe(true);
    expect(events.some((e: any) => e.kind === "send" && e.side === "enemy")).toBe(true);
    expect(battle.over).toBe(false);
    events = battle.takeTurn({ kind: "move", move: "TACKLE" });
    all.push(...events);
    expect(battle.over).toBe(true);
    expect(battle.outcome).toBe("win");
    expect(events.some((e: any) => e.kind === "win-text")).toBe(true);
    expect(events.some((e: any) => e.kind === "money")).toBe(true);
    expect(s.player.money).toBeGreaterThan(3000);
    expect(fighter.experience).toBeGreaterThan(exp0);
    // the foe never moved: no damage on the player's side
    expect(all.some((e: any) => e.kind === "damage" && e.side === "player")).toBe(false);
    // a link battle is exempt
    const link: any = Battle.new({ data: D, party: [Mon.new(D, "CYNDAQUIL", 10, {})], save: save(), trainer: { party: [Mon.new(D, "PIDGEY", 7, {})] } });
    link.linkBattle = true;
    link.takeTurn({ kind: "move", move: "TACKLE" });
    expect(link.over).not.toBe(true);
    use({});
  });

  t("a scripted battle's win branch runs on: the battle screen ends in a win", async () => {
    useGoldGen();
    const { useGoldTiles } = await import("../voxelmon/game/gen2/platform/shot-node.ts");
    useGoldTiles();
    const { Screens } = await import("../voxelmon/game/gen2/shared/ui/Screens.ts");
    const { Input } = await import("../voxelmon/game/gen2/shared/core/Input.ts");
    const { Lcd } = await import("../voxelmon/game/gen2/platform/lcd.ts");
    const { setLcd } = await import("../voxelmon/game/gen2/platform/screen.ts");
    const { RecorderHost } = await import("../voxelmon/game/host.ts");
    seed(0xfa1c);
    const game: any = Game2.new();
    game.load({ startWorld: false });
    game.stack.clear();
    setLcd(new Lcd(new RecorderHost()));
    game.options.instantVictory = true;
    const D = game.data;
    const cls = D.trainers.classes.FALKNER;
    const row = cls.trainers[0];
    const party = row.party.map((r: any) => Mon.new(D, r.species, r.level, { dvs: { attack: 9, defense: 8, speed: 8, special: 8 } }));
    game.save.party = [Mon.new(D, "CYNDAQUIL", 8, { dvs: perfect() })];
    const money = game.save.player.money;
    const battle: any = Battle.new({ data: D, party: game.save.party, save: game.save, trainer: { class: "FALKNER", classId: "FALKNER", name: row.name, party, baseMoney: cls.baseMoney } });
    let outcome: string | undefined;
    Screens.push(game, "Gen2BattleState", { battle, save: game.save, onDone: (o: string) => { outcome = o; game.stack.pop(); } });
    const st = game.stack.top();
    Input.reset();
    for (let i = 0; i < 6000 && !outcome; i++) {
      let b = 0;
      if (i % 6 === 0) b = VOX_BTN.a;
      Input.setButtons(st.phase === "menu" && st.menuIndex !== 1 ? (i % 6 === 0 ? VOX_BTN.up : 0) : b);
      Input.step();
      game.stack.update(1 / 60);
    }
    expect(outcome).toBe("win");
    expect(game.save.player.money).toBeGreaterThan(money);
    Cheats.bind(() => opts);
  });
});

describe("gen2 cheats: FAST EGGS", () => {
  t("a compatible pair has its egg on the next step; a party egg hatches within five steps", () => {
    const D = data();
    const s = save({ party: [Mon.new(D, "CYNDAQUIL", 20, {})] });
    const dc = Breeding.dayCare(s)!;
    dc.man.mon = Mon.new(D, "PIKACHU", 20, {})!;
    dc.lady.mon = Mon.new(D, "DITTO", 20, {})!;
    use({});
    expect(Breeding.initBreeding(D, s, { rng: () => 200 } as any)).toBe(true);
    Breeding.step(D, s, () => 200);
    expect(dc.hasEgg).toBe(false);
    use({ fastEggs: true });
    Breeding.step(D, s, () => 200);
    expect(dc.hasEgg).toBe(true);
    const [ok, egg] = Breeding.collectEgg(D, s, { rng: () => 200 } as any);
    expect(ok).toBe(true);
    expect((egg as any).eggSteps).toBeGreaterThan(5);
    let hatched = -1;
    for (let i = 1; i <= 10 && hatched < 0; i++) if (Breeding.step(D, s, () => 200) === "hatch") hatched = i;
    expect(hatched).toBeGreaterThan(0);
    expect(hatched).toBeLessThanOrEqual(5);
    use({});
  });
});

describe("gen2 cheats: INFINITE MONEY", () => {
  test("held at 999999 each frame while on; MOM's savings untouched; off leaves it be", () => {
    const g: any = { save: save({ mom: { savedMoney: 1234 } }), options: { infiniteMoney: true } };
    g.save.player.money = 50;
    Cheats.frame(g);
    expect(g.save.player.money).toBe(999999);
    g.save.player.money -= 300;
    Cheats.frame(g);
    expect(g.save.player.money).toBe(999999);
    expect(g.save.mom.savedMoney).toBe(1234);
    expect(g.save.player.money).toBeLessThanOrEqual(Save.MAX_MONEY);
    g.options.infiniteMoney = false;
    g.save.player.money = 10;
    Cheats.frame(g);
    expect(g.save.player.money).toBe(10);
  });
});

describe("gen2 cheats: DEX", () => {
  t("ALL SEEN marks 251 seen; FULL marks them owned and fills the UNOWN dex, keeping its order", () => {
    const D = data();
    const s = save({ unownDex: [5], firstUnownSeen: 5 });
    expect(Cheats.fillDex(s, D, false)).toBe(251);
    expect(Object.keys(s.pokedex.seen).length).toBe(251);
    expect(Object.keys(s.pokedex.caught).length).toBe(0);
    expect(Cheats.fillDex(s, D, true)).toBe(251);
    expect(Object.keys(s.pokedex.caught).length).toBe(251);
    expect(s.pokedex.caught.CELEBI).toBe(true);
    expect(s.unownDex.length).toBe(26);
    expect(s.unownDex[0]).toBe(5);
    expect(new Set(s.unownDex).size).toBe(26);
    expect(s.firstUnownSeen).toBe(5);
    expect(Save.summary(s)!.caught).toBe(251);
  });
});

describe("gen2 cheats: GIVE ITEMS", () => {
  t("its own pocket, the rest to the PC; KEY ITEMS and HMs one each; no glitch items", () => {
    const D = data();
    const s = save();
    // every listed item is a real one, and the glitch ids are not listed
    const all = ["ITEM", "BALL", "KEY_ITEM", "TM_HM"].flatMap((p) => Cheats.itemsIn(D, p));
    expect(all).not.toContain("ITEM_19");
    expect(all.some((id) => /^ITEM_/.test(id))).toBe(false);
    expect(all).toContain("MASTER_BALL");
    expect(all).toContain("HM_WATERFALL");
    expect(Cheats.giveItem(s, D, "ITEM_19", 5).short).toBe("invalid");
    // into the bag, then past 99 into the PC
    expect(Cheats.giveItem(s, D, "POTION", 90)).toEqual({ bag: 90, pc: 0 });
    expect(Cheats.giveItem(s, D, "POTION", 20)).toEqual({ bag: 9, pc: 11 });
    expect(s.inventory.POTION).toBe(99);
    expect(s.pcItems.POTION).toBe(11);
    // a key item and an HM: one, and only once
    expect(Cheats.maxGive(s, D, "BICYCLE")).toBe(1);
    expect(Cheats.giveItem(s, D, "BICYCLE", 5)).toEqual({ bag: 1, pc: 0 });
    expect(Cheats.giveItem(s, D, "BICYCLE", 1).short).toBe("have");
    expect(Cheats.maxGive(s, D, "BICYCLE")).toBe(0);
    expect(Cheats.giveItem(s, D, "HM_SURF", 3)).toEqual({ bag: 1, pc: 0 });
    expect(s.inventory.HM_SURF).toBe(1);
    // a full ITEM pocket sends a new item to the PC
    for (const id of Cheats.itemsIn(D, "ITEM").slice(0, 25)) s.inventory[id] = s.inventory[id] ?? 1;
    const fresh = Cheats.itemsIn(D, "ITEM").find((id) => !s.inventory[id])!;
    expect(Cheats.giveItem(s, D, fresh, 3)).toEqual({ bag: 0, pc: 3 });
    // a ball lands in the BALL pocket
    Cheats.giveItem(s, D, "ULTRA_BALL", 4);
    expect(s.inventory.ULTRA_BALL).toBe(4);
  });
});

describe("gen2 cheats: OPTION and the save", () => {
  t("ENHANCEMENTS is a page of OPTION, SPEED at its top; CHEATS a row of its own; all OFF unless set", () => {
    useGoldGen();
    const game: any = Game2.new();
    game.load({ startWorld: false });
    game.stack.clear();
    game.showOptions();
    const menu = game.stack.top() as OptionsMenu;
    const labels = menu.visible().map((r) => r.label);
    expect(labels).toContain("ENHANCEMENTS");
    expect(labels.slice(-3)).toEqual(["MENU ACCOUNT", "CHEATS", "BACK"]);
    const page = menu.focusRow("expForCatching")!;
    expect(page.view.map((r) => r.label)).toEqual(["SPEED", "EXP FOR CATCHING", "PARTY EXP SHARE", "TRADE EVO LV.40", "HMS WITHOUT MOVE", "VISIBLE WILD", "BACK"]);
    // SPEED (voxelmon/game/gamespeed.ts) reads 1X unless set
    for (const r of page.rows) expect(r.text!(page.options)).toBe(r.key === "gameSpeed" ? "1X" : "OFF");
    // every label fits the 17 columns from column 2
    for (const r of [...page.rows, ...menu.visible()]) expect(String(r.label).length).toBeLessThanOrEqual(17);
    game.input.setButtons?.(0);
    page.cycle(page.row()!, 1);
    expect(game.options.expForCatching).toBe(true);
    expect(Cheats.expForCatching()).toBe(true);
    page.cycle(page.row()!, 1);
    expect(game.options.expForCatching).toBe(false);
    // the keys are options: they round-trip through the options file
    game.options.cheats = true;
    game.options.shinyOdds = 64;
    Save.saveOptions(game.options);
    const back = Save.loadOptions();
    expect(back.cheats).toBe(true);
    expect(back.shinyOdds).toBe(64);
    delete game.options.cheats;
    delete game.options.shinyOdds;
    Save.saveOptions(game.options);
    Cheats.bind(() => opts);
  });
});

describe("gen2 cheats: the Lua save (gen1recomp's format)", () => {
  test("a save carrying the keys on save.options writes and loads clean, keys and all", async () => {
    const { setSaveIo, memorySaveIo } = await import("../voxelmon/game/gen2/platform/saveio.ts");
    const { SaveSerializer } = await import("../voxelmon/game/gen2/shared/core/SaveSerializer.ts");
    const io = memorySaveIo();
    setSaveIo(io);
    const s = Save.newGame({ playerName: "GOLD", trainerId: 1 });
    s.options = { textSpeed: "FAST", cheats: true, wildEncounters: "less", shinyOdds: 512, instantVictory: true, partyExpShare: true };
    expect(Save.save(s)[0]).toBe(true);
    // the file is plain serializer text, as gen1recomp reads it
    const raw = SaveSerializer.decode(io.text!);
    expect(raw.generation).toBe(2);
    expect(raw.options.shinyOdds).toBe(512);
    const [back, , err, report] = Save.load();
    expect(err).toBeUndefined();
    expect(Save.emptyReport(report)).toBe(true);
    expect(back!.options).toEqual(s.options);
    expect(back!.player).toEqual(s.player);
    setSaveIo(memorySaveIo());
  });
});

/** The display width of a string on the tile font ("<PK>" is one tile). */
function width(text: string): number {
  return text.replace(/<[A-Z_]+>/g, "#").length;
}

describe("gen2 cheats: the bottom screen's CHEATS tab", () => {
  t("the tab only with CHEATS on; every view's text inside the twenty columns, nothing overlapping", async () => {
    useGoldGen();
    const { useGoldTiles } = await import("../voxelmon/game/gen2/platform/shot-node.ts");
    useGoldTiles();
    const game: any = Game2.new();
    game.load({ startWorld: true });
    for (let i = 0; i < 30; i++) game.frame(0);
    game.save.party = [Mon.new(game.data, "CYNDAQUIL", 12, {})];
    const host: any = { lcdTarget: () => {}, lcdCells: () => {}, lcdShow: () => {}, lcdBank: () => {}, lcdReset: () => {}, lcdRegs: () => {}, lcdObjs: () => {}, lcdPals: () => {}, lcdLines: () => {} };
    const c = new Companion(host, []);
    const tap = (cx: number, cy: number): void => {
      c.touch(game, cx * 16 + 8, cy * 16 + 8, true);
      c.touch(game, 0, 0, false);
    };
    const page = () => (c as any).page as string;
    const panel = () => (c as any).cheats;
    // what one redraw prints, row by row
    const printed = (): Array<{ text: string; x: number; y: number }> => {
      const out: Array<{ text: string; x: number; y: number }> = [];
      const p = Chrome.print;
      const r = Chrome.printRight;
      (Chrome as any).print = (text: string, x: number, y: number) => {
        out.push({ text, x, y });
        return p.call(Chrome, text, x, y);
      };
      (Chrome as any).printRight = (text: string, end: number, y: number) => {
        out.push({ text, x: end - width(text), y });
        return r.call(Chrome, text, end, y);
      };
      try {
        (c as any).sig = "";
        c.frame(game);
      } finally {
        (Chrome as any).print = p;
        (Chrome as any).printRight = r;
      }
      return out;
    };
    // (the CHEATS views keep their text off column 19 -- the mon pages' right
    // edge -- except the time and money row the panel shares)
    const tidy = (what: string, edge = 20): void => {
      const rows: Record<number, Array<[number, number]>> = {};
      for (const { text, x, y } of printed()) {
        const w = width(text);
        // and the row above the tabs stays clear, as on the other pages
        if (edge < 20 && y === 13) throw new Error(`${what}: "${text}" on the row above the tabs`);
        if (x < 0 || x + w > (y === 1 || y === 14 ? 20 : edge)) throw new Error(`${what}: "${text}" at ${x},${y} runs off the row`);
        for (const [a, b] of rows[y] ?? []) {
          if (x < b && a < x + w) throw new Error(`${what}: "${text}" at ${x},${y} overlaps`);
        }
        (rows[y] ??= []).push([x, x + w]);
      }
    };

    // CHEATS off: the cart's four tabs exactly as before, and no fifth
    delete game.options.cheats;
    const off = printed().filter((p) => p.y === 14).map((p) => [p.text, p.x]);
    expect(off).toEqual([["<PK><MN>", 2], ["BADGE", 5], ["CARD", 11], ["MAP", 16]]);
    tap(19, 14);
    expect(page()).toBe("party");

    // CHEATS on: the fifth tab, the row across all twenty columns
    game.options.cheats = true;
    const on = printed().filter((p) => p.y === 14).map((p) => [p.text, p.x]);
    expect(on).toEqual([["<PK><MN>", 1], ["BADGE", 4], ["CARD", 10], ["MAP", 15], ["!", 19]]);
    tidy("party with five tabs");
    tap(18, 14);
    expect(page()).toBe("cheats");
    tidy("cheats page 1", 19);
    // WILD ENCOUNTERS' two rows step NORMAL -> MORE -> NONE
    tap(5, 4);
    expect(game.options.wildEncounters).toBe("more");
    tap(5, 3);
    expect(game.options.wildEncounters).toBe("none");
    tap(5, 5);
    expect(game.options.shinyOdds).toBe(4096);
    for (const [row, key] of [[6, "alwaysCatch"], [7, "instantVictory"], [8, "fastEggs"], [9, "infiniteMoney"]] as const) {
      tap(3, row);
      expect(game.options[key]).toBe(true);
    }
    tidy("cheats, all on", 19);
    // DEX FULL: SET asks first; NO leaves the dex alone
    tap(3, 11);
    expect(panel().view).toBe("dex");
    tidy("dex confirm", 19);
    tap(15, 11);
    expect(panel().view).toBe("list");
    expect(Object.keys(game.save.pokedex.caught).length).toBeLessThan(251);
    tap(3, 11);
    tap(4, 11);
    expect(panel().view).toBe("message");
    expect(Object.keys(game.save.pokedex.caught).length).toBe(251);
    tidy("dex message", 19);
    tap(4, 6);
    expect(panel().view).toBe("list");
    // GIVE ITEMS: the list, a page on, a pocket, an item, ten and one more,
    // GIVE, YES
    tap(3, 12);
    expect(panel().view).toBe("items");
    tidy("items", 19);
    tap(18, 12);
    expect(panel().scroll).toBe(1);
    tap(1, 12);
    expect(panel().scroll).toBe(0);
    tap(8, 3);
    expect(panel().pocket).toBe("BALL");
    tidy("balls", 19);
    tap(3, 4);
    expect(panel().view).toBe("qty");
    const ball = panel().item;
    tap(7, 8);
    expect(panel().qty).toBe(10);
    tap(18, 8);
    expect(panel().qty).toBe(11);
    tidy("quantity", 19);
    const had = game.save.inventory[ball] ?? 0;
    tap(15, 11);
    expect(panel().view).toBe("give");
    tidy("give confirm", 19);
    // NO goes back to the item's page with nothing given
    tap(15, 11);
    expect(panel().view).toBe("qty");
    expect(game.save.inventory[ball] ?? 0).toBe(had);
    tap(15, 11);
    tap(4, 11);
    expect(game.save.inventory[ball]).toBe(had + 11);
    tidy("give message", 19);
    tap(4, 6);
    expect(panel().view).toBe("items");
    // BACK (on the title row), and the "!" tab always opens on the list
    tap(17, 0);
    expect(panel().view).toBe("list");
    panel().view = "items";
    tap(19, 14);
    expect(panel().view).toBe("list");
    // CHEATS off: the page goes back to the party, the cheats stay set
    delete game.options.cheats;
    printed();
    expect(page()).toBe("party");
    expect(game.options.alwaysCatch).toBe(true);
    for (const k of ["wildEncounters", "shinyOdds", "alwaysCatch", "instantVictory", "fastEggs", "infiniteMoney"]) delete game.options[k];
    Cheats.bind(() => opts);
  });
});
