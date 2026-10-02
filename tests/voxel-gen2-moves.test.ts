// The Gen 2 move effects gen1recomp's Gold engine left without a handler at
// bdfac727 -- HAZE, MIST, FOCUS ENERGY, CONVERSION, CONVERSION2, SKETCH,
// MIMIC, NIGHTMARE, DESTINY BOND, HEAL BELL, PSYCH UP, SWAGGER, PRESENT and
// PAIN SPLIT -- written from pokegold's own commands (move_effects/*.asm,
// data/moves/effects.asm) and checked here against the real Gold tables.
// Skips without the import.

import { beforeAll, describe, expect, test } from "bun:test";
import { haveGoldGen, useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { loadGenerated } from "../voxelmon/game/gen2/platform/data.ts";
import { seed } from "../voxelmon/game/gen2/platform/rng.ts";
import { Battle } from "../voxelmon/game/gen2/battle/Battle.ts";
import { Effects } from "../voxelmon/game/gen2/battle/Effects.ts";
import { Mon } from "../voxelmon/game/gen2/battle/Mon.ts";

const HAVE = haveGoldGen();
const d = HAVE ? describe : describe.skip;

let DATA: any;
beforeAll(() => {
  if (!HAVE) return;
  useGoldGen();
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

const perfect = () => ({ attack: 15, defense: 15, speed: 15, special: 15 });

function moves(...ids: string[]): any[] {
  return ids.map((id) => ({ id, pp: DATA.moves[id].pp, maxPp: DATA.moves[id].pp }));
}

/** A wild battle with every accuracy roll a hit, and the texts it printed. */
function fight(mine: [string, number, string[]], theirs: [string, number, string[]]) {
  seed(77);
  const player: any = Mon.new(DATA, mine[0], mine[1], { dvs: perfect(), moves: moves(...mine[2]) });
  const wild: any = Mon.new(DATA, theirs[0], theirs[1], { dvs: perfect(), moves: moves(...theirs[2]) });
  const battle: any = Battle.new({ data: DATA, party: [player], wild });
  battle.accuracyRoll = () => true;
  battle.takeEvents();
  const texts = (): string[] => battle.takeEvents().filter((e: any) => e.text).map((e: any) => e.text);
  return { battle, player, wild, texts };
}

d("gen2 move effects missing upstream", () => {
  test("HAZE: every stat level on both sides back to neutral", () => {
    const { battle, player, wild, texts } = fight(["WOOPER", 20, ["HAZE"]], ["PIDGEY", 20, ["TACKLE"]]);
    battle.stages.player.attack = 2;
    battle.stages.enemy.evasion = -3;
    battle.useMove(player, wild, "HAZE");
    expect(Object.values(battle.stages.player).every((v) => v === 0)).toBe(true);
    expect(Object.values(battle.stages.enemy).every((v) => v === 0)).toBe(true);
    expect(texts()).toContain("All stat changes\nwere eliminated!");
  });

  test("MIST and FOCUS ENERGY set their flag once; a second use fails", () => {
    const { battle, player, wild, texts } = fight(["SEEL", 20, ["MIST", "FOCUS_ENERGY"]], ["PIDGEY", 20, ["TACKLE"]]);
    battle.useMove(player, wild, "MIST");
    expect(battle.volatile(player).mist).toBe(true);
    battle.useMove(player, wild, "FOCUS_ENERGY");
    expect(battle.volatile(player).focusEnergy).toBe(true);
    texts();
    battle.useMove(player, wild, "MIST");
    battle.useMove(player, wild, "FOCUS_ENERGY");
    expect(texts().filter((t) => t === "But it failed!").length).toBe(2);
  });

  test("DESTINY BOND takes the attacker down with a KO, and only a move's", () => {
    const { battle, player, wild, texts } = fight(["GASTLY", 20, ["DESTINY_BOND"]], ["RATTATA", 20, ["TACKLE"]]);
    battle.useMove(player, wild, "DESTINY_BOND");
    expect(battle.volatile(player).destinyBond).toBe(true);
    player.hp = 1;
    // a NORMAL move cannot touch a GHOST: the bond holds through it
    battle.useMove(wild, player, "TACKLE");
    expect(player.hp).toBe(1);
    // residual damage (no move) does not trigger it
    battle.dealDamage(wild, player, 5, {});
    expect(player.hp).toBe(0);
    expect(wild.hp).toBeGreaterThan(0);
    player.hp = 1;
    battle.volatile(player).destinyBond = true;
    texts();
    battle.dealDamage(wild, player, 5, { move: DATA.moves.TACKLE, moveId: "TACKLE" });
    expect(player.hp).toBe(0);
    expect(wild.hp).toBe(0);
    expect(texts().some((t) => /took down with it/.test(t))).toBe(true);
  });

  test("HEAL BELL clears the whole party's status", () => {
    const { battle, player, wild, texts } = fight(["MILTANK", 30, ["HEAL_BELL"]], ["PIDGEY", 20, ["TACKLE"]]);
    const bench: any = Mon.new(DATA, "SENTRET", 10, { dvs: perfect() });
    battle.party.push(bench);
    player.status = "paralyze";
    bench.status = "poison";
    battle.useMove(player, wild, "HEAL_BELL");
    expect(player.status).toBeUndefined();
    expect(bench.status).toBeUndefined();
    expect(texts()).toContain("A bell chimed!");
  });

  test("PSYCH UP copies the target's stat levels; none moved, it fails", () => {
    const { battle, player, wild, texts } = fight(["ESPEON", 40, ["PSYCH_UP"]], ["PIDGEY", 20, ["TACKLE"]]);
    battle.useMove(player, wild, "PSYCH_UP");
    expect(texts()).toContain("But it failed!");
    battle.stages.enemy.attack = 2;
    battle.stages.enemy.speed = -1;
    battle.useMove(player, wild, "PSYCH_UP");
    expect(battle.stages.player.attack).toBe(2);
    expect(battle.stages.player.speed).toBe(-1);
  });

  test("NIGHTMARE needs a sleeping target, then takes a quarter a turn until it wakes", () => {
    const { battle, player, wild, texts } = fight(["HAUNTER", 30, ["NIGHTMARE"]], ["RATTATA", 20, ["TACKLE"]]);
    battle.useMove(player, wild, "NIGHTMARE");
    expect(texts()).toContain("But it failed!");
    wild.status = "sleep";
    wild.statusTurns = 3;
    battle.useMove(player, wild, "NIGHTMARE");
    expect(battle.volatile(wild).nightmare).toBe(true);
    const maxHp = wild.maxHp ?? wild.stats.hp;
    const before = wild.hp;
    battle.tickSeedAndCurse(wild);
    expect(wild.hp).toBe(before - Math.max(1, Math.floor(maxHp / 4)));
    delete wild.status;
    battle.tickSeedAndCurse(wild);
    expect(battle.volatile(wild).nightmare).toBeUndefined();
  });

  test("SKETCH keeps the target's last move for good, at its own PP", () => {
    const { battle, player, wild, texts } = fight(["SMEARGLE", 20, ["SKETCH"]], ["RATTATA", 20, ["HYPER_FANG"]]);
    battle.useMove(player, wild, "SKETCH");
    expect(texts()[1] ?? "").toMatch(/didn't affect/);
    battle.volatile(wild).lastMove = "HYPER_FANG";
    player.moves[0].pp = 1; // SKETCH's one PP went on the refused try
    battle.useMove(player, wild, "SKETCH");
    expect(player.moves[0].id).toBe("HYPER_FANG");
    expect(player.moves[0].pp).toBe(DATA.moves.HYPER_FANG.pp);
    battle.clearVolatile(player);
    expect(player.moves[0].id).toBe("HYPER_FANG");
  });

  test("MIMIC copies the last move at 5 PP until the battle struct is reloaded", () => {
    const { battle, player, wild } = fight(["MR__MIME", 30, ["MIMIC", "PSYCHIC_M"]], ["RATTATA", 20, ["HYPER_FANG"]]);
    const psychic = player.moves[1];
    battle.volatile(wild).lastMove = "HYPER_FANG";
    battle.useMove(player, wild, "MIMIC");
    expect(player.moves[0]).toEqual({ id: "HYPER_FANG", pp: 5, maxPp: 5 });
    // the other slot is still the mon's own entry
    expect(player.moves[1]).toBe(psychic);
    battle.clearVolatile(player);
    expect(player.moves[0].id).toBe("MIMIC");
  });

  test("CONVERSION takes a move's type that is not the user's own", () => {
    const { battle, player, wild } = fight(["PORYGON", 30, ["CONVERSION", "TACKLE", "PSYBEAM"]], ["PIDGEY", 20, ["TACKLE"]]);
    battle.useMove(player, wild, "CONVERSION");
    // PORYGON is NORMAL: TACKLE's type is its own, so PSYBEAM's it is
    expect(battle.battleTypes(player)).toEqual(["PSYCHIC_TYPE", "PSYCHIC_TYPE"]);
    battle.clearVolatile(player);
    expect(battle.battleTypes(player)).toEqual(DATA.pokemon.PORYGON.types);
  });

  test("CONVERSION2 takes a type that resists the target's last move", () => {
    const { battle, player, wild } = fight(["PORYGON2", 40, ["CONVERSION2"]], ["CHARMANDER", 20, ["EMBER"]]);
    battle.useMove(player, wild, "CONVERSION2");
    expect(battle.volatile(player).typeOverride).toBeUndefined();
    battle.volatile(wild).lastMove = "EMBER";
    battle.useMove(player, wild, "CONVERSION2");
    const [t] = battle.battleTypes(player);
    const row = DATA.type_chart.matchups.find((m: any) => m.attacker === "FIRE" && m.defender === t);
    expect(row && row.multiplier < 10).toBe(true);
  });

  test("SWAGGER: the target's Attack up two, then confused", () => {
    const { battle, player, wild, texts } = fight(["JIGGLYPUFF", 30, ["SWAGGER"]], ["RATTATA", 20, ["TACKLE"]]);
    battle.useMove(player, wild, "SWAGGER");
    expect(battle.stages.enemy.attack).toBe(2);
    expect(battle.volatile(wild).confuseCount).toBeGreaterThan(0);
    expect(texts().some((t) => /became confused/.test(t))).toBe(true);
  });

  test("PAIN SPLIT averages the two HP totals, neither past its max", () => {
    const { battle, player, wild, texts } = fight(["MISDREAVUS", 30, ["PAIN_SPLIT"]], ["SNORLAX", 40, ["TACKLE"]]);
    player.hp = 10;
    wild.hp = 100;
    battle.useMove(player, wild, "PAIN_SPLIT");
    const avg = Math.floor(110 / 2);
    expect(player.hp).toBe(Math.min(avg, player.maxHp ?? player.stats.hp));
    expect(wild.hp).toBe(avg);
    expect(texts()).toContain("The battlers\nshared pain!");
  });

  test("PRESENT: PresentPower's thresholds, and a GHOST is not affected", () => {
    expect(Effects.presentPower(0)).toBe(40);
    expect(Effects.presentPower(101)).toBe(40);
    expect(Effects.presentPower(102)).toBe(80);
    expect(Effects.presentPower(178)).toBe(80);
    expect(Effects.presentPower(179)).toBe(120);
    expect(Effects.presentPower(204)).toBe(120);
    expect(Effects.presentPower(205)).toBe(0);
    expect(Effects.presentPower(255)).toBe(0);
    const { battle, player, wild, texts } = fight(["DELIBIRD", 30, ["PRESENT"]], ["GASTLY", 20, ["LICK"]]);
    const hp = wild.hp;
    battle.useMove(player, wild, "PRESENT");
    expect(wild.hp).toBe(hp);
    expect(texts().some((t) => /doesn't affect/.test(t))).toBe(true);
  });
});
