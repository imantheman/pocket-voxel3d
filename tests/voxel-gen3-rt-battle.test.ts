// The FireRed runtime port, cluster "battle engine": state, adapter, engine,
// moves/effects, damage, types, abilities, items, residuals, AI, experience,
// catching. Real data from ~/gen3ref/frfull, driven headless the way
// gen1recomp's own tests do it (tests/game3_battle_*_test.lua): State.new +
// Adapter.new + Engine.resolveMove / planTurn, no Battle scene, no UI.
//
// Hand-computed values use pret's Gen 3 formulas (battle_script_commands.c
// CalculateBaseDamage / Cmd_typecalc / Cmd_handleballthrow, battle_util.c,
// pokemon.c GetMonData stats) on FireRed base stats.
import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DesktopHost } from "../voxelmon/game/gen3/platform/desktop.ts";
import { getHost, setHost } from "../voxelmon/game/gen3/platform/host.ts";
import { concat, len, seq } from "../voxelmon/game/gen3/platform/lt.ts";
import { Pokemon } from "../voxelmon/game/gen3/core/pokemon.ts";
import { Rng } from "../voxelmon/game/gen3/core/rng.ts";
import { State } from "../voxelmon/game/gen3/core/battle/state.ts";
import { Adapter } from "../voxelmon/game/gen3/core/battle/adapter.ts";
import { Engine } from "../voxelmon/game/gen3/core/battle/engine.ts";
import { Moves } from "../voxelmon/game/gen3/core/battle/moves.ts";
import { Damage } from "../voxelmon/game/gen3/core/battle/damage.ts";
import { Types } from "../voxelmon/game/gen3/core/battle/types.ts";
import { Rules } from "../voxelmon/game/gen3/core/battle/rules.ts";
import { Commands } from "../voxelmon/game/gen3/core/battle/commands.ts";
import { Experience } from "../voxelmon/game/gen3/core/battle/experience.ts";
import { Catching } from "../voxelmon/game/gen3/core/battle/catching.ts";
import { Kinds } from "../voxelmon/game/gen3/core/battle/kinds.ts";
import { BattleProfile } from "../voxelmon/game/gen3/core/battle/profile.ts";
import { BuiltinMoves } from "../voxelmon/game/gen3/core/battle/builtin_moves.ts";
import { Battle } from "../voxelmon/game/gen3/core/battle.ts";
import { Battle as BattleInit } from "../voxelmon/game/gen3/core/battle/init.ts";
import { effects as EffectsPkg } from "../voxelmon/game/gen3/core/battle/effects.ts";
import { Effects } from "../voxelmon/game/gen3/core/battle/effects/init.ts";

const ROOT = join(homedir(), "gen3ref/frfull");

// FireRed species / moves / items (pokefirered include/constants).
const BULBASAUR = 1, RATTATA = 19, GEODUDE = 74;
const TACKLE = 33, GROWL = 45, TAIL_WHIP = 39, VINE_WHIP = 22, POISON_POWDER = 77;
const POKE_BALL = 4;

const ZERO = () => ({ hp: 0, atk: 0, def: 0, spe: 0, spa: 0, spd: 0 });

/** A real FireRed mon: stats from the ROM's base stats (IVs/EVs 0, Hardy). */
function mkMon(species: number, level: number, moves: number[], extra: Record<string, any> = {}): any {
  const mon: any = {
    species, level, ivs: ZERO(), evs: ZERO(), personality: 0,
    moves: seq(...moves), pp: seq(...moves.map(() => 20)),
    ...extra,
  };
  Pokemon.applyStats(mon);
  if (extra.hp != null) mon.hp = extra.hp;
  mon.exp = mon.exp ?? Experience.expForLevel(mon, level);
  return mon;
}

/** Brian's scripted rng (tests/game3_battle_move_effects_test.lua mkRng). */
function mkRng(map: Record<string, number | number[]> = {}): (lo: number, hi: number) => number {
  const cursor: Record<string, number> = {};
  return (lo: number, hi: number): number => {
    const key = `${lo},${hi}`;
    let v: any = map[key];
    if (Array.isArray(v)) {
      const i = (cursor[key] ?? 0) + 1;
      cursor[key] = i;
      v = v[Math.min(i, v.length) - 1];
    }
    if (v != null) return v;
    if (lo === 1 && hi === 100) return 1;
    return hi;
  };
}

function wild(p: any, e: any, rng?: (lo: number, hi: number) => number): [any, any] {
  const st = State.new({ wild: true, playerParty: seq(p), foeParty: seq(e) });
  if (rng) st.rng = rng;
  st.terrain = 0;
  const ad = Adapter.new(st);
  return [st, ad];
}

function use(st: any, ad: any, user: any, move: number, slot = 1): [string, any] {
  const target = user === st.player ? st.enemy : st.player;
  const out: any = [null];
  Engine.resolveMove(user, target, move, slot, ad, st, out);
  return [concat(out, " || "), out];
}

describe.skipIf(!existsSync(ROOT))("gen3 runtime: battle engine on FireRed data", () => {
  beforeAll(() => {
    setHost(new DesktopHost(ROOT));
    Pokemon.install({ read: (rel: string) => getHost().read(rel) });
    Moves.loadRomPack();
  });

  test("package entries re-export init / effects", () => {
    expect(Battle).toBe(BattleInit);
    expect(typeof Battle.start).toBe("function");
    expect(typeof Battle.isActive).toBe("function");
    expect(EffectsPkg).toBe(Effects);
    expect(BuiltinMoves[TACKLE]!.name).toBe("TACKLE");
    expect(BuiltinMoves[354]!.name).toBe("PSYCHO BOOST");
  });

  test("real mons: stats from FireRed base stats", () => {
    const b = mkMon(BULBASAUR, 5, [TACKLE, GROWL]);
    // pokemon.c CalculateMonStats: hp = (2*45)*5/100 + 5 + 10; stat = (2*B)*5/100 + 5
    expect([b.maxHp, b.attack, b.defense, b.spAtk, b.spDef, b.speed]).toEqual([19, 9, 9, 11, 11, 9]);
    const r = mkMon(RATTATA, 3, [TACKLE, TAIL_WHIP]);
    expect([r.maxHp, r.attack, r.defense, r.spAtk, r.spDef, r.speed]).toEqual([14, 8, 7, 6, 7, 9]);
    const [st] = wild(b, r);
    expect(st.player.species).toBe(BULBASAUR);
    expect(st.player.type1).toBe(Types.ID.GRASS);
    expect(st.player.type2).toBe(Types.ID.POISON);
    expect(st.enemy.type1).toBe(Types.ID.NORMAL);
    expect(st.enemy.type2).toBeNull();
    expect(Kinds.controllerOf(st, 0)).toBe("player");
    expect(Kinds.controllerOf(st, 1)).toBe("ai");
    expect(Kinds.noExp(st)).toBe(false);
    expect(BattleProfile.of(st).family).toBe("frlg");
  });

  test("moves pack: TACKLE / VINE WHIP from the ROM", () => {
    const t = Moves.get(TACKLE);
    expect(Number(t.power)).toBe(35);
    expect(Number(t.accuracy)).toBe(95);
    expect(Number(t.type)).toBe(Types.ID.NORMAL);
    const v = Moves.get(VINE_WHIP);
    expect(Number(v.power)).toBe(35);
    expect(Number(v.type)).toBe(Types.ID.GRASS);
  });

  test("type effectiveness (gTypeEffectiveness)", () => {
    const T = Types.ID;
    expect(Types.effectiveness(T.WATER, T.FIRE)).toBe(2);
    expect(Types.effectiveness(T.GRASS, T.FIRE)).toBe(0.5);
    expect(Types.effectiveness(T.NORMAL, T.GHOST)).toBe(0);
    expect(Types.effectiveness(T.WATER, T.ROCK, T.GROUND)).toBe(4);
    // Faithful quirk: Brian's tenths chart (types.lua C, used by the helper)
    // has no GRASS->ROCK row, so it says 1x; the damage path (typeCalc on
    // pret's gTypeEffectiveness, below) has it. luajit gives the same.
    expect(Types.effectiveness(T.GRASS, T.ROCK)).toBe(1);
    expect(Types.effectiveness(T.ELECTRIC, T.GROUND)).toBe(0);
    expect(Types.effectiveness(T.FIGHTING, T.NORMAL, T.FLYING)).toBe(1);
    // Cmd_typecalc: dmg * 20 / 10 per super-effective type, floored each step
    const [dmg, flags] = Types.typeCalc(T.GRASS, T.ROCK, T.GROUND, 7);
    expect(dmg).toBe(28);
    expect(flags.super).toBe(true);
  });

  test("damage: Gen 3 formula on known stats (min and max rolls)", () => {
    const b = mkMon(BULBASAUR, 5, [TACKLE]);
    const r = mkMon(RATTATA, 3, [TACKLE]);
    const [st] = wild(b, r);
    // CalculateBaseDamage: 9 * 35 * (2*5/5 + 2) / 7 / 50 + 2 = 1260/7=180, /50=3, +2 = 5
    // no STAB (grass/poison using normal), neutral vs normal.
    const hi = Damage.calc(st.player, st.enemy, TACKLE, { forceCrit: false, forceRoll: 100, st });
    expect(hi[0]).toBe(5);
    const lo = Damage.calc(st.player, st.enemy, TACKLE, { forceCrit: false, forceRoll: 85, st });
    expect(lo[0]).toBe(4); // 5 * 85 / 100
    // crit doubles before the random roll: (5 * 2) = 10
    const cr = Damage.calc(st.player, st.enemy, TACKLE, { forceCrit: true, forceRoll: 100, st });
    expect(cr[0]).toBe(10);
    expect(cr[1].critical).toBe(true);
    // RATTATA TACKLE: 8 * 35 * (2*3/5 + 2 = 3) / 9 / 50 + 2 = 840/9=93, /50=1, +2 = 3; STAB 3*15/10 = 4
    const re = Damage.calc(st.enemy, st.player, TACKLE, { forceCrit: false, forceRoll: 100, st });
    expect(re[0]).toBe(4);
    expect(re[1].stab).toBe(1.5);
    // special + STAB + 4x: BULBASAUR VINE WHIP vs GEODUDE (rock/ground), spDef 8
    // 11 * 35 * 4 / 8 / 50 + 2 = 1540/8=192, /50=3, +2 = 5; STAB 7; x2 = 14; x2 = 28
    const g = mkMon(GEODUDE, 5, [TACKLE]);
    expect(g.spDef).toBe(8);
    const [st2] = wild(mkMon(BULBASAUR, 5, [VINE_WHIP]), g);
    const v = Damage.calc(st2.player, st2.enemy, VINE_WHIP, { forceCrit: false, forceRoll: 100, st: st2 });
    expect(v[0]).toBe(28);
    expect(v[1].effectiveness).toBe(4);
    expect(Damage.calc(st2.player, st2.enemy, VINE_WHIP, { forceCrit: false, forceRoll: 85, st: st2 })[0]).toBe(23);
  });

  test("a turn through the engine: TACKLE hits for the rolled damage", () => {
    const b = mkMon(BULBASAUR, 5, [TACKLE]);
    const r = mkMon(RATTATA, 3, [TACKLE]);
    // accuracy roll 1 (hits), crit roll 15 (no crit), damage roll 100 (max)
    const [st, ad] = wild(b, r, mkRng({ "85,100": 100 }));
    const [txt] = use(st, ad, st.player, TACKLE);
    expect(st.enemy.mon.hp).toBe(14 - 5);
    expect(txt).toContain("TACKLE");
    const [st2, ad2] = wild(mkMon(BULBASAUR, 5, [TACKLE]), mkMon(RATTATA, 3, [TACKLE]), mkRng({ "85,100": 85 }));
    use(st2, ad2, st2.player, TACKLE);
    expect(st2.enemy.mon.hp).toBe(14 - 4);
  });

  test("status moves: GROWL lowers attack, POISONPOWDER poisons", () => {
    const [st, ad] = wild(mkMon(BULBASAUR, 5, [GROWL, POISON_POWDER]), mkMon(RATTATA, 3, [TACKLE]), mkRng());
    const [txt] = use(st, ad, st.player, GROWL, 1);
    expect(st.enemy.stages.attack).toBe(-1);
    expect(st.enemy.mon.hp).toBe(14);
    expect(txt.length).toBeGreaterThan(0);
    // -1 attack stage: 8 * 2/3 = 5 attack: 5*35*3/9/50+2 = 525/9=58,/50=1,+2 = 3; STAB 4
    const re = Damage.calc(st.enemy, st.player, TACKLE, { forceCrit: false, forceRoll: 100, st });
    expect(re[0]).toBe(4);
    use(st, ad, st.player, POISON_POWDER, 2);
    expect(String(ad.status(st.enemy))).toBe("PSN");
  });

  test("fainting, battle end and experience", () => {
    const b = mkMon(BULBASAUR, 5, [TACKLE]);
    const r = mkMon(RATTATA, 3, [TACKLE], { hp: 3 });
    const [st, ad] = wild(b, r, mkRng());
    use(st, ad, st.player, TACKLE);
    expect(st.enemy.mon.hp).toBe(0);
    expect(State.isFainted(st.enemy)).toBe(true);
    expect(Engine.checkEnd(st, ad)).toBe("win");
    // pokefirered battle_script_commands.c Cmd_getexp: expYield * level / 7
    expect(Pokemon.expYield(RATTATA)).toBe(57);
    expect(Experience.gainFor(RATTATA, 3, { participants: 1 })).toBe(24); // 57*3/7 = 24
    expect(Experience.gainFor(RATTATA, 3, { participants: 1, trainer: true })).toBe(36);
    const before = b.exp;
    expect(before).toBe(135); // medium slow, level 5
    const res = Experience.apply(st.player.mon, 24);
    expect(res.gained).toBe(24);
    expect(st.player.mon.exp).toBe(159);
    expect(st.player.mon.level).toBe(5); // level 6 needs 179
  });

  test("the AI picks a move (wild, seeded RNG)", () => {
    Rng.SeedRng(0x1234);
    const [st] = wild(mkMon(BULBASAUR, 5, [TACKLE, GROWL]), mkMon(RATTATA, 3, [TACKLE, TAIL_WHIP]));
    const act = Commands.enemyAction(st);
    expect(act.kind).toBe("move");
    expect([TACKLE, TAIL_WHIP]).toContain(Number(act.move));
    // same seed, same choice
    Rng.SeedRng(0x1234);
    const [st2] = wild(mkMon(BULBASAUR, 5, [TACKLE, GROWL]), mkMon(RATTATA, 3, [TACKLE, TAIL_WHIP]));
    expect(Number(Commands.enemyAction(st2).move)).toBe(Number(act.move));
  });

  test("a whole seeded turn: planTurn + resolve, deterministic", () => {
    const run = (): string => {
      Rng.SeedRng(42);
      const [st, ad] = wild(mkMon(BULBASAUR, 5, [TACKLE, GROWL]), mkMon(RATTATA, 3, [TACKLE, TAIL_WHIP]));
      const [actions] = Engine.planTurnFromActions(st, ad, Commands.playerAction(st, 1, 1), null);
      const log: string[] = [];
      for (let i = 1; i <= len(actions); i++) {
        const a = actions[i];
        if (a.kind === "move") {
          const target = a.user === st.player ? st.enemy : st.player;
          const out: any = [null];
          Engine.resolveMove(a.user, target, a.move, a.slot, ad, st, out);
          log.push(concat(out, "|"));
        }
      }
      log.push(`${st.player.mon.hp}/${st.enemy.mon.hp}`);
      return log.join(" // ");
    };
    const a = run();
    expect(run()).toBe(a);
    expect(a).toContain("TACKLE");
  });

  test("catching: Gen 3 catch odds and shake checks", () => {
    const [st] = wild(mkMon(BULBASAUR, 5, [TACKLE]), mkMon(RATTATA, 3, [TACKLE]));
    // Cmd_handleballthrow: catchRate 255, POKE BALL x10/10, full hp 14:
    // (3*14 - 2*14) * 255 / (3*14) = 85
    expect(Pokemon.speciesMeta(RATTATA).catchRate).toBe(255);
    expect(Catching.catchOdds(POKE_BALL, st.enemy, st, null)).toBe(85);
    st.enemy.mon.hp = 1; // (42 - 2) * 255 / 42 = 242
    expect(Catching.catchOdds(POKE_BALL, st.enemy, st, null)).toBe(242);
    st.enemy.status = "PAR"; // * 15 / 10 = 363 -> capped 255
    expect(Catching.catchOdds(POKE_BALL, st.enemy, st, null)).toBe(255);
    st.enemy.status = null;
    st.enemy.mon.hp = 14;
    // shake threshold b = 1048560 / sqrt(sqrt(16711680 / 85)); every roll below b shakes
    const b = Math.floor(1048560 / Math.sqrt(Math.sqrt(16711680 / 85)));
    const [caught, shakes] = Catching.tryCatch(POKE_BALL, st.enemy, st, null, () => b - 1);
    expect([caught, shakes]).toEqual([true, 4]);
    const [c2, s2] = Catching.tryCatch(POKE_BALL, st.enemy, st, null, mkRng({ "0,65535": [0, 0, b] }));
    expect([c2, s2]).toEqual([false, 2]);
    expect(Catching.tryCatch(1, st.enemy, st, null, () => 65535)).toEqual([true, 4]); // MASTER BALL
  });

  test("rules: crit stages, partial trap turns, safari factors", () => {
    expect(Rules.crit.stage({}, { effect: 43 })).toBe(1);
    expect(Rules.crit.stage({ focusEnergy: true, item: 198 }, { effect: 0 })).toBe(3);
    expect(Rules.crit.CHANCE[Rules.crit.stage({}, null)]).toBe(16);
    expect(Rules.partialTrap.rollTurns(() => 3)).toBe(6);
    expect(Rules.safari.catchFactor(255)).toBe(20);
    expect(Rules.safari.escapeFactor(0)).toBe(2);
  });
});
