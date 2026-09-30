// The Gen 2 battle engine (voxelmon/game/gen2/battle, ported from
// gen1recomp src/battle/gen2 at bdfac727), run headlessly against the
// importer's real Gold tables (dist/voxelmon/gold/gen). Skips without the
// import. Every expected number below is worked by hand from pokegold's
// formulas; the working is in the comment beside it.

import { beforeAll, describe, expect, test } from "bun:test";
import { haveGoldGen, useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { loadGenerated } from "../voxelmon/game/gen2/platform/data.ts";
import { seed, random } from "../voxelmon/game/gen2/platform/rng.ts";
import { NotPortedError } from "../voxelmon/game/gen2/notported.ts";
import { Battle } from "../voxelmon/game/gen2/battle/Battle.ts";
import { Damage } from "../voxelmon/game/gen2/battle/Damage.ts";
import { Mon } from "../voxelmon/game/gen2/battle/Mon.ts";
import { Catching } from "../voxelmon/game/gen2/battle/Catching.ts";
import { Prize } from "../voxelmon/game/gen2/battle/Prize.ts";
import { AnimRunner } from "../voxelmon/game/gen2/battle/AnimRunner.ts";
import { TypeChart } from "../voxelmon/game/gen2/shared/battle/TypeChart.ts";
import { Happiness } from "../voxelmon/game/gen2/core/Happiness.ts";
import { Pokerus } from "../voxelmon/game/gen2/core/Pokerus.ts";
import { Roamers } from "../voxelmon/game/gen2/core/Roamers.ts";
import { Unown } from "../voxelmon/game/gen2/core/Unown.ts";
import { SpriteAnims } from "../voxelmon/game/gen2/ui/SpriteAnims.ts";

const HAVE = haveGoldGen();
const d = HAVE ? describe : describe.skip;

// ------------------------------------------------------------ test doubles
//
// core/ and ui/ are being ported by other agents. Until they land, the few
// members the battle reaches are stood in for here -- ONLY while the module
// is still a stub, so the real port takes over the moment it exists. Each
// double is the Lua function cut to what a battle test needs.

function isStub(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch (e) {
    return e instanceof NotPortedError;
  }
}

function installDoubles(): void {
  const H = Happiness as any;
  if (isStub(() => H.change({ happiness: 0, hp: 1 }, "GYMBATTLE"))) {
    // core/gen2/Happiness.lua:168/211 -- the happiness value itself is not
    // under test here, so the double leaves it alone.
    H.change = () => undefined;
    H.changeParty = () => 0;
  }
  const P = Pokerus as any;
  if (isStub(() => P.doublesStatExp({}))) {
    // core/gen2/Pokerus.lua:87-118: any nonzero MON_PKRS byte doubles.
    P.doublesStatExp = (mon: any) => (Math.floor(Number(mon?.pokerus) || 0) % 256) !== 0;
  }
  const R = Roamers as any;
  if (R.OFTEN_FLEE === undefined) {
    // core/gen2/Roamers.lua:454-467.
    R.ALWAYS_FLEE = {};
    R.OFTEN_FLEE = {
      CUBONE: true, ARTICUNO: true, ZAPDOS: true, MOLTRES: true,
      QUAGSIRE: true, DELIBIRD: true, PHANPY: true, TEDDIURSA: true,
    };
    R.SOMETIMES_FLEE = {
      MAGNEMITE: true, GRIMER: true, TANGELA: true, MR__MIME: true,
      EEVEE: true, PORYGON: true, DRATINI: true, DRAGONAIR: true,
      TOGETIC: true, UMBREON: true, UNOWN: true, SNUBBULL: true, HERACROSS: true,
    };
  }
  const U = Unown as any;
  if (U.SPECIES === undefined) U.SPECIES = "UNOWN"; // core/gen2/Unown.lua:29
  const S = SpriteAnims as any;
  if (isStub(() => S.sine(0, 1))) {
    // ui/gen2/SpriteAnims.lua:44-67 (engine/math/sine.asm `sine_table 32`).
    const SINE: number[] = [];
    for (let i = 0; i < 32; i++) SINE[i] = Math.floor(Math.sin((i * Math.PI) / 32) * 256 + 0.5);
    S.sine = (angle: number, amplitude: number): number => {
      angle = ((angle % 64) + 64) % 64;
      const negative = angle >= 32;
      if (negative) angle -= 32;
      const product = ((((amplitude % 256) + 256) % 256) * SINE[angle]!) % 0x10000;
      let result = Math.floor(product / 256);
      if (negative) result = -result;
      return ((result % 256) + 256) % 256;
    };
    S.cosine = (angle: number, amplitude: number): number => S.sine(angle + 0x10, amplitude);
  }
}

// ------------------------------------------------------------------ data

let DATA: any;

beforeAll(() => {
  if (!HAVE) return;
  useGoldGen();
  installDoubles();
  // Game2.lua:1031-1036: the rows past type_matchups.asm's `db -2` Foresight
  // marker apply by default, so Game2:load appends them to `matchups`. A copy,
  // so the cached table the other tests read is left as the importer wrote it.
  const chart: any = loadGenerated("type_chart");
  DATA = {
    pokemon: loadGenerated("pokemon"),
    moves: loadGenerated("moves"),
    items: loadGenerated("items"),
    type_chart: { ...chart, matchups: [...chart.matchups, ...chart.foresightMatchups] },
    trainers: loadGenerated("trainers"),
    encounters: loadGenerated("encounters"),
    constants: loadGenerated("constants"),
    battle_anims: loadGenerated("battle_anims"),
  };
});

// World/Trainers.lua:73-95 (Trainers.party): explicit move rows get their
// PP, and every trainer mon has the fixed 9/8/8/8 DVs.
function trainerParty(rows: any[]): any[] {
  const party: any[] = [];
  for (const row of rows) {
    let moves: any[] | undefined;
    if (row.moves && row.moves.length > 0) {
      moves = row.moves.map((id: string) => {
        const def = DATA.moves[id];
        return { id, pp: def ? def.pp : 0, maxPp: def ? def.pp : 0 };
      });
    }
    const mon = Mon.new(DATA, row.species, row.level, {
      moves,
      item: row.item,
      dvs: { attack: 9, defense: 8, speed: 8, special: 8 },
    });
    if (mon) party.push(mon);
  }
  return party;
}

const perfect = () => ({ attack: 15, defense: 15, speed: 15, special: 15 });

/** The first move of the active mon that still has PP. */
function pickMove(battle: any): string {
  for (const m of battle.player.moves) if ((m.pp ?? 0) > 0) return m.id;
  return "STRUGGLE";
}

// ------------------------------------------------------------------ tests

d("gen2 battle: damage formula", () => {
  test("a level-50 physical hit, worked by hand", () => {
    // pokegold BattleCommand_DamageCalc, every step floored:
    //   floor(2*50/5)+2 = 22; 22*80 = 1760; *100 = 176000; /80 = 2200;
    //   /50 = 44; +2 (MIN_DAMAGE tail) = 46
    // BattleCommand_Stab: NORMAL user, NORMAL move -> floor(46*15/10) = 69
    // Water defender: no matchup row -> 69; DamageVariation 100% -> 69,
    //   85% -> floor(69*85/100) = 58.
    const opts: any = {
      level: 50, power: 80, moveType: "NORMAL",
      attacker: { attack: 100, specialAttack: 50, types: ["NORMAL"], stages: {} },
      defender: { defense: 80, specialDefense: 80, types: ["WATER"], stages: {} },
      types: DATA.type_chart.types, matchups: DATA.type_chart.matchups,
      variation: 100,
    };
    expect(Damage.calc(opts)[0]).toBe(69);
    expect(Damage.calc({ ...opts, variation: 85 })[0]).toBe(58);
    // A critical doubles the damage before the +2 tail: 44*2+2 = 90, STAB 135.
    expect(Damage.calc({ ...opts, critical: true })[0]).toBe(135);
  });

  test("a special hit into a double weakness (Steel)", () => {
    // FIRE is special in Gen 2. 22*90 = 1980; *120 = 237600; /100 = 2376;
    //   /50 = 47; +2 = 49; STAB floor(49*1.5) = 73;
    //   FIRE->GRASS x2 = 146; FIRE->STEEL x2 = 292.
    const [dmg, info] = Damage.calc({
      level: 50, power: 90, moveType: "FIRE",
      attacker: { attack: 10, specialAttack: 120, types: ["FIRE"], stages: {} },
      defender: { defense: 10, specialDefense: 100, types: ["GRASS", "STEEL"], stages: {} },
      types: DATA.type_chart.types, matchups: DATA.type_chart.matchups,
      variation: 100,
    } as any);
    expect(info.physical).toBe(false);
    expect(info.effectiveness).toBe(40);
    expect(dmg).toBe(292);
  });
});

d("gen2 battle: type chart", () => {
  const eff = (move: string, types: string[]) =>
    Damage.typeMultiplier(move, types, DATA.type_chart.matchups);
  test("Gen 2 types from the ROM's TypeMatchups", () => {
    expect(eff("FIRE", ["STEEL"])).toBe(20);
    expect(eff("STEEL", ["STEEL"])).toBe(5);
    expect(eff("DARK", ["PSYCHIC_TYPE"])).toBe(20);
    expect(eff("PSYCHIC_TYPE", ["DARK"])).toBe(0);
    expect(eff("FIGHTING", ["DARK"])).toBe(20);
    expect(eff("GHOST", ["STEEL"])).toBe(5);
    expect(eff("POISON", ["STEEL"])).toBe(0);
    expect(eff("WATER", ["GRASS", "DRAGON"])).toBe(2); // floor(10*5/10)=5, floor(5*5/10)=2
    expect(eff("ELECTRIC", ["WATER", "FLYING"])).toBe(40);
  });
  test("NORMAL/FIGHTING vs GHOST sit past the Foresight marker", () => {
    // data/types/type_matchups.asm: the two Ghost immunities come after
    // `db -2`; the importer keeps them apart as foresightMatchups and
    // Game2:load appends them (above). Without them Normal hits Ghost.
    expect(eff("NORMAL", ["GHOST"])).toBe(0);
    expect(eff("FIGHTING", ["GHOST"])).toBe(0);
    expect(Damage.typeMultiplier("NORMAL", ["GHOST"], loadGenerated<any>("type_chart")!.matchups)).toBe(10);
  });
  test("TypeChart over the loaded chart", () => {
    TypeChart.load(DATA);
    expect(TypeChart.category("STEEL")).toBe("physical");
    expect(TypeChart.category("DARK")).toBe("special");
    expect(TypeChart.effectiveness("FIRE", ["STEEL"])).toBe(20);
    expect(TypeChart.effectiveness("DARK", ["PSYCHIC_TYPE"])).toBe(20);
    expect(TypeChart.effectiveness("NORMAL", ["GHOST"])).toBe(0);
  });
});

d("gen2 battle: catch rate", () => {
  test("Catching.rate, worked by hand", () => {
    // rate = floor((3*maxHp - 2*hp) * catchRate / (3*maxHp)), min 1, + status
    // maxHp 20, hp 20, rate 255: floor(20*255/60) = 85
    expect(Catching.rate({ maxHp: 20, hp: 20, catchRate: 255, ball: "POKE_BALL" })[0]).toBe(85);
    // hp 1: floor(58*255/60) = 246
    expect(Catching.rate({ maxHp: 20, hp: 1, catchRate: 255, ball: "POKE_BALL" })[0]).toBe(246);
    // GREAT BALL x1.5 on 45: 67; floor(20*67/60) = 22; asleep +10 = 32
    expect(Catching.rate({ maxHp: 20, hp: 20, catchRate: 45, ball: "GREAT_BALL" })[0]).toBe(22);
    expect(Catching.rate({ maxHp: 20, hp: 20, catchRate: 45, ball: "GREAT_BALL", status: "sleep" })[0]).toBe(32);
    // Gold's bugs: burn/poison/paralysis add nothing (the `and` misses them)
    expect(Catching.rate({ maxHp: 20, hp: 20, catchRate: 45, ball: "GREAT_BALL", status: "paralyze" })[0]).toBe(22);
    // MASTER BALL always catches
    expect(Catching.rate({ maxHp: 20, hp: 20, catchRate: 3, ball: "MASTER_BALL" })[1]).toBe(true);
  });
  test("the cart's high-HP precision bug", () => {
    // maxHp 400: 3*400 = 1200 >= 256, so both terms >> 2: 300 and 200; the
    // cart then compares only the low byte of 300 = 44, so 44 - 200 < 0 and
    // the rate floors to 1. With fixBugs: floor(100*45/300) = 15.
    expect(Catching.rate({ maxHp: 400, hp: 400, catchRate: 45, ball: "POKE_BALL" })[0]).toBe(1);
    expect(Catching.rate({ maxHp: 400, hp: 400, catchRate: 45, ball: "POKE_BALL", fixBugs: true })[0]).toBe(15);
  });
});

d("gen2 battle: stats, stat exp and level-up", () => {
  test("PIDGEY L7 with trainer DVs 9/8/8/8 (FALKNER's first)", () => {
    // HP DV = 1*8 (attack odd) = 8. Base 40/45/40/56/35/35.
    // HP  = floor((40*2+8*2)*7/100) + 7 + 10 = 6 + 17 = 23
    // Atk = floor((45*2+9*2)*7/100) + 5 = 7 + 5 = 12
    // Def = floor((40*2+8*2)*7/100) + 5 = 11; Spe = floor(128*7/100)+5 = 13
    // SpA = SpD = floor((35*2+8*2)*7/100) + 5 = 11
    const mon: any = Mon.new(DATA, "PIDGEY", 7, { dvs: { attack: 9, defense: 8, speed: 8, special: 8 } });
    expect(mon.stats).toEqual({ hp: 23, attack: 12, defense: 11, speed: 13, specialAttack: 11, specialDefense: 11 });
    expect(mon.moves.map((m: any) => m.id)).toEqual(["TACKLE", "SAND_ATTACK"]);
  });
  test("MEDIUM_SLOW growth and the experience award", () => {
    // 6/5 n^3 - 15 n^2 + 100 n - 140: L5 = 150-375+500-140 = 135;
    // L7 = floor(2058/5)=411 -735+700-140 = 236; L10 = 1200-1500+1000-140 = 560
    const growth = DATA.pokemon.growthRates.GROWTH_MEDIUM_SLOW;
    expect(Mon.experienceForLevel(growth, 5)).toBe(135);
    expect(Mon.experienceForLevel(growth, 7)).toBe(236);
    expect(Mon.experienceForLevel(growth, 10)).toBe(560);
    // PIDGEY base exp 55 at L7, one participant: floor(55*7/7) = 55, a
    // trainer's mon x1.5 -> 82.
    expect(Mon.experienceGain(DATA.pokemon.PIDGEY, 7, 1, true)).toBe(82);
    expect(Mon.experienceGain(DATA.pokemon.PIDGEY, 7, 1, false)).toBe(55);
  });
  test("stat exp: base stats added, Special takes Sp. Atk", () => {
    const mon: any = Mon.new(DATA, "CYNDAQUIL", 5, { dvs: perfect() });
    Mon.gainStatExp(mon, DATA.pokemon.PIDGEY, 1, false, false);
    expect(mon.statExp).toEqual({ hp: 40, attack: 45, defense: 40, speed: 56, special: 35 });
    // Pokerus doubles, two participants halve first: floor(45/2)*2 = 44
    Mon.gainStatExp(mon, DATA.pokemon.PIDGEY, 2, true, false);
    expect(mon.statExp.attack).toBe(45 + 44);
  });
  test("gainExperience levels up and carries the HP delta", () => {
    const mon: any = Mon.new(DATA, "CYNDAQUIL", 5, { dvs: perfect() });
    const growth = DATA.pokemon.growthRates[DATA.pokemon.CYNDAQUIL.growthRate];
    const need = Mon.experienceForLevel(growth, 6) - mon.experience;
    mon.hp -= 3;
    const before = { maxHp: mon.maxHp, hp: mon.hp };
    const result: any = Mon.gainExperience(mon, need, DATA);
    expect(mon.level).toBe(6);
    expect(result.levels).toBeGreaterThanOrEqual(1);
    expect(mon.hp - before.hp).toBe(mon.maxHp - before.maxHp);
    // CYNDAQUIL learns SMOKESCREEN at 6 (data/pokemon/evos_attacks.asm)
    const learnedIds = (result.learned ?? []).map((m: any) => (typeof m === "string" ? m : m.id ?? m.move));
    expect(learnedIds).toContain("SMOKESCREEN");
  });
});

d("gen2 battle: headless battles", () => {
  test("a scripted wild battle on ROUTE_29 runs to a win", () => {
    seed(0x29);
    const slot = DATA.encounters.grass.ROUTE_29.slots.DAY[0]; // PIDGEY L2
    const player: any = Mon.new(DATA, "CYNDAQUIL", 10, { dvs: perfect() });
    const wild: any = Mon.new(DATA, slot.species, slot.level, { dvs: perfect() });
    const expBefore = player.experience;
    const battle: any = Battle.new({ data: DATA, party: [player], wild });
    expect(battle.wild).toBe(true);
    const kinds = new Set<string>();
    let turns = 0;
    while (!battle.over && turns < 50) {
      const events: any[] = battle.takeTurn({ kind: "move", move: pickMove(battle) }) ?? [];
      for (const e of events) kinds.add(e.kind);
      turns++;
    }
    expect(battle.over).toBe(true);
    expect(battle.outcome).toBe("win");
    expect(wild.hp).toBe(0);
    // GiveExperiencePoints: PIDGEY base exp 55 at L2, wild, one
    // participant: floor(55*2/7) = 15.
    expect(player.experience).toBe(expBefore + 15);
    for (const k of ["move", "damage", "faint", "experience"]) expect(kinds.has(k)).toBe(true);
  });

  test("the same seed replays the same battle", () => {
    const run = (): string => {
      seed(1234);
      const player: any = Mon.new(DATA, "TOTODILE", 6, { dvs: perfect() });
      const wild: any = Mon.new(DATA, "SENTRET", 4, { dvs: perfect() });
      const battle: any = Battle.new({ data: DATA, party: [player], wild });
      const log: string[] = [];
      for (let t = 0; t < 40 && !battle.over; t++) {
        for (const e of battle.takeTurn({ kind: "move", move: pickMove(battle) }) ?? []) {
          if (e.text) log.push(e.text);
        }
      }
      return log.join("|") + `#${battle.outcome}`;
    };
    expect(run()).toBe(run());
  });

  test("FALKNER: a trainer battle with a second send-out and the prize", () => {
    seed(0xfa1c);
    const cls = DATA.trainers.classes.FALKNER;
    const row = cls.trainers[0];
    const party = trainerParty(row.party);
    expect(party.map((m: any) => `${m.species}${m.level}`)).toEqual(["PIDGEY7", "PIDGEOTTO9"]);
    const player: any = Mon.new(DATA, "CYNDAQUIL", 16, { dvs: perfect() });
    const save: any = { player: { money: 3000, name: "GOLD" }, mom: {} };
    const battle: any = Battle.new({
      data: DATA,
      party: [player],
      trainer: { class: "FALKNER", classId: "FALKNER", name: row.name, party, baseMoney: cls.baseMoney },
      save,
    });
    expect(battle.wild).toBe(false);
    expect(battle.tryRun()).toBe(false); // no running from a trainer
    const sends: any[] = [];
    let turns = 0;
    while (!battle.over && turns < 120) {
      const events: any[] = battle.takeTurn({ kind: "move", move: pickMove(battle) }) ?? [];
      for (const e of events) if (e.kind === "send" && e.side === "enemy") sends.push(e);
      turns++;
    }
    expect(battle.over).toBe(true);
    expect(battle.outcome).toBe("win");
    expect(sends.length).toBeGreaterThanOrEqual(1);
    expect(sends[sends.length - 1].mon.species).toBe("PIDGEOTTO");
    // ComputeTrainerReward: 25 * wCurPartyLevel (the LAST row, 9) = 225,
    // doubled twice for the text = 900, all four quarters to the wallet.
    expect(Prize.reward(25, 9)).toBe(225);
    expect(save.player.money).toBe(3000 + 900);
    expect(battle.prize.total).toBe(900);
  });
});

d("gen2 battle: animation engine", () => {
  test("EMBER's script from battle_anims.json steps to completion", () => {
    const anims = DATA.battle_anims;
    const key = AnimRunner.scriptForMove(anims, "EMBER");
    expect(typeof key).toBe("string");
    const sounds: unknown[] = [];
    const runner: any = AnimRunner.new({
      data: anims, constants: DATA.constants, sfxOrder: DATA.constants.sfxOrder,
      battleTurn: 0, animId: "EMBER",
      hooks: { sound: (...a: unknown[]) => sounds.push(a), cry: () => {} },
    });
    runner.start(key);
    let frames = 0;
    let objs = 0;
    let bgCalls = 0;
    const painter = {
      obj: (_x: number, _y: number, gfxKey: string) => {
        expect(typeof gfxKey).toBe("string");
        objs++;
      },
      battlerObj: () => {},
      bgEffect: () => {
        bgCalls++;
      },
    };
    while (!runner.done() && frames < 2000) {
      runner.step();
      runner.draw(painter);
      frames++;
    }
    expect(runner.done()).toBe(true);
    // 61 frames: the same count Brian's Lua runner gives on this JSON.
    expect(frames).toBe(61);
    expect(bgCalls).toBe(frames);
    expect(objs).toBeGreaterThan(0);
    expect(sounds.length).toBeGreaterThan(0);
  });

  test("every move's script terminates", () => {
    const anims = DATA.battle_anims;
    const stuck: string[] = [];
    for (const [move, key] of Object.entries(anims.moves as Record<string, string>)) {
      seed(7);
      const runner: any = AnimRunner.new({
        data: anims, constants: DATA.constants, sfxOrder: DATA.constants.sfxOrder,
        battleTurn: 1, animId: move,
        hooks: { sound: () => {}, cry: () => {} },
      });
      runner.start(key);
      let frames = 0;
      while (!runner.done() && frames < 5000) {
        runner.step();
        frames++;
      }
      if (!runner.done()) stuck.push(move);
    }
    expect(stuck).toEqual([]);
  });
});

void random;
