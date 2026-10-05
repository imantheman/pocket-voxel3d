// Port of gen1recomp src/core/game3/battle/damage.lua (GPLv3 + additional terms; see LICENSE.md).
// Gen3-shaped damage formula (owned game3 battle).
//
// Port notes:
// - Exact integer math: every math.floor sits where Brian puts it, and the
//   multiplications / divisions keep his order.
// - The lazy requires (pokemon, link_guard, profile, held_items, Gen3Compat)
//   and `pcall(require, "src.core.game3.battle.adapter")` are static imports;
//   every module is in the bundle, so the pcall always succeeds.
//   `package.loaded["src.core.game3.battle.engine"]` reads the imported Engine.
// - `math.random` (the link_guard.source fallback) is platform random().
// - print -> console.log.
// - Multiple returns are 0-based tuples: hiddenPower -> [power, type];
//   calc -> [damage, info] on every path. HeldItems.of returns
//   [holdEffect, param, item].

/* eslint-disable @typescript-eslint/no-explicit-any */
import { mod, tonumber, tostring, truthy } from "../../../../import/gen3/lua.ts";
import { ipairs, pairs, seq } from "../../platform/lt.ts";
import { gsub } from "../../platform/lpattern.ts";
import { random } from "../../platform/rng.ts";
import Rules from "./rules.ts";
import Types, { type TypeFlags } from "./types.ts";
import Moves from "./moves.ts";
import EffectIds from "./effect_ids.ts";
import ModRuntime from "../../shared/mods/Runtime.ts";
import G3 from "../../shared/mods/Gen3Compat.ts";
import { Pokemon } from "../pokemon.ts";
import Guard from "./link_guard.ts";
import Adapter from "./adapter.ts";
import Engine from "./engine.ts";
import BattleProfile from "./profile.ts";
import HeldItems from "./held_items.ts";

let rngWarned = false;

export type DamageInfo = Record<string, any>;

export interface DamageModule {
  stageMul(stage: any): number;
  applyStage(stat: any, stage: any): number;
  monStat(mon: any, key: string, fallback: any): any;
  ensureStats(mon: any, level?: any): any;
  hiddenPower(mon: any): [number, number];
  flailPower(hp: any, maxHp: any): number;
  lowKickPower(dMon: any, defender: any): number;
  base(attacker: any, defender: any, move: any, opts?: any): number;
  calc(attacker: any, defender: any, moveId: any, opts?: any): [number, DamageInfo];
}

export const Damage = {} as DamageModule;

/** Lua `a or b` (b already evaluated). */
function lor(a: any, b: any): any {
  return truthy(a) ? a : b;
}

// pokefirered/src/pokemon.c:1442
const STAGE_RATIO: Record<number, (number | null)[]> = {
  [-6]: seq(10, 40), [-5]: seq(10, 35), [-4]: seq(10, 30), [-3]: seq(10, 25),
  [-2]: seq(10, 20), [-1]: seq(10, 15), 0: seq(10, 10), 1: seq(15, 10),
  2: seq(20, 10), 3: seq(25, 10), 4: seq(30, 10), 5: seq(35, 10), 6: seq(40, 10),
};

// Lua: damage.lua:19
function clamp_stage(sIn: any): number {
  const s = Math.floor(tonumber(sIn) ?? 0);
  if (s < -6) return -6;
  if (s > 6) return 6;
  return s;
}

// Lua: damage.lua:26
Damage.stageMul = function (stage: any): number {
  const r = STAGE_RATIO[clamp_stage(stage)]!;
  return r[1]! / r[2]!;
};

// Lua: damage.lua:32 -- pokefirered/src/pokemon.c:2374
Damage.applyStage = function (stat: any, stage: any): number {
  const r = STAGE_RATIO[clamp_stage(stage)]!;
  return Math.floor((tonumber(stat) ?? 0) * r[1]! / r[2]!);
};

// Lua: damage.lua:37
function mon_stat(mon: any, key: string, fallback: any): any {
  if (!truthy(mon)) return fallback;
  let v = mon[key];
  if (v == null && key === "spAtk") v = lor(mon.spa, mon.specialAttack);
  if (v == null && key === "spDef") v = lor(mon.spd, mon.specialDefense);
  if (v == null && key === "attack") v = mon.atk;
  if (v == null && key === "defense") v = mon.def;
  if (v == null && key === "speed") v = mon.spe;
  return lor(tonumber(v), fallback);
}
Damage.monStat = mon_stat;

/** Fill missing battle stats from extracted species base stats + IVs. */
// Lua: damage.lua:50
Damage.ensureStats = function (monIn: any, levelIn?: any): any {
  const level: number = tonumber(lor(levelIn, truthy(monIn) ? monIn.level : monIn)) ?? 5;
  const mon: any = truthy(monIn) ? monIn : {};
  mon.level = level;

  const species = tonumber(lor(mon.species, mon.speciesId));
  if (species != null && truthy(Pokemon.stats) && truthy(Pokemon.stats(species))) {
    if (!truthy(mon.ivs)) {
      mon.ivs = { hp: 0, atk: 0, def: 0, spe: 0, spa: 0, spd: 0 };
    }
    if (!truthy(mon.evs)) {
      mon.evs = { hp: 0, atk: 0, def: 0, spe: 0, spa: 0, spd: 0 };
    }
    if (mon.personality == null) mon.personality = 0;
    const need = (!truthy(mon.maxHp) || mon.maxHp <= 0)
      || (mon_stat(mon, "attack", 0) <= 0)
      || (mon_stat(mon, "defense", 0) <= 0)
      || (mon_stat(mon, "spAtk", 0) <= 0)
      || (mon_stat(mon, "spDef", 0) <= 0)
      || (mon_stat(mon, "speed", 0) <= 0);
    if (need) {
      const keepHp = mon.hp;
      Pokemon.applyStats(mon);
      if (keepHp != null && keepHp >= 0) {
        mon.hp = Math.min(keepHp, mon.maxHp);
      }
    }
    if (!truthy(mon.ability) && !truthy(mon.abilityId) && truthy(Pokemon.abilityId)) {
      mon.ability = Pokemon.abilityId(species, mon.personality);
      mon.abilityId = mon.ability;
    }
    return mon;
  }

  const base = 50;
  if (!truthy(mon.maxHp) || mon.maxHp <= 0) {
    mon.maxHp = Math.floor(((2 * base) * level) / 100) + level + 10;
  }
  if (!truthy(mon.hp) || mon.hp < 0) mon.hp = mon.maxHp;
  if (mon.hp > mon.maxHp) mon.hp = mon.maxHp;
  // Lua: damage.lua:91
  function fill(key: string, b: number): void {
    if (mon_stat(mon, key, 0) <= 0) {
      mon[key] = Math.floor(((2 * b) * level) / 100) + 5;
    }
  }
  fill("attack", 55);
  fill("defense", 50);
  fill("spAtk", 50);
  fill("spDef", 50);
  fill("speed", 50);
  return mon;
};

// Lua: damage.lua:104
function roll_from(rng: any, lo: number, hi: number): number {
  if (typeof rng === "function") {
    let ok: boolean, v: any;
    try {
      v = rng(lo, hi);
      ok = true;
    } catch (e) {
      ok = false;
      v = e instanceof Error ? e.message : e;
    }
    if (ok && typeof v === "number") return v;
    if (!rngWarned) {
      rngWarned = true;
      console.log("[game3/damage] rng call failed: " + tostring(v));
    }
  }
  return Guard.fallback("damage.roll", lo, hi);
}

// Lua: damage.lua:116
function ability_of(battler: any, adapter: any): any {
  if (truthy(adapter) && truthy(adapter.abilityOf)) return adapter.abilityOf(battler);
  if (!truthy(battler)) return null;
  if (truthy(battler.expTracedAbility)) return battler.expTracedAbility;
  let id = battler.ability;
  if (!truthy(id)) {
    const m = battler.mon;
    id = truthy(m) ? lor(m.ability, m.abilityId) : m;
  }
  if (typeof id === "string") return gsub(id.toUpperCase(), "%s+", "_")[0];
  // pcall(require, "src.core.game3.battle.adapter") -- always loads here
  if (truthy(Adapter) && truthy(Adapter.ABILITY_BY_ID) && tonumber(id) != null) {
    return Adapter.ABILITY_BY_ID[tonumber(id) as number];
  }
  return null;
}

// Lua: damage.lua:127
function status_of(battler: any): any {
  let s: any = battler;
  if (truthy(battler)) {
    s = battler.status;
    if (!truthy(s)) s = truthy(battler.mon) ? battler.mon.status : battler.mon;
  }
  if (s === 0) return null;
  return s;
}

// Lua: damage.lua:134 -- pokefirered/src/battle_script_commands.c:8503
Damage.hiddenPower = function (mon: any): [number, number] {
  let iv: any = truthy(mon) ? lor(mon.ivs, mon.dvs) : mon;
  if (!truthy(iv)) iv = {};
  // Lua: damage.lua:136
  const g = (k1: string, k2: string): number => Math.floor(tonumber(lor(iv[k1], iv[k2])) ?? 0);
  const hp = g("hp", "HP"), atk = g("atk", "attack"), def = g("def", "defense");
  const spe = g("spe", "speed"), spa = g("spa", "spAtk"), spd = g("spd", "spDef");
  // Lua: damage.lua:139
  const b = (v: number, bit: number): number => mod(Math.floor(v / bit), 2);
  const powerBits = b(hp, 2) + 2 * b(atk, 2) + 4 * b(def, 2) + 8 * b(spe, 2) + 16 * b(spa, 2) + 32 * b(spd, 2);
  const typeBits = b(hp, 1) + 2 * b(atk, 1) + 4 * b(def, 1) + 8 * b(spe, 1) + 16 * b(spa, 1) + 32 * b(spd, 1);
  const power = Math.floor(40 * powerBits / 63) + 30;
  let t = Math.floor(15 * typeBits / 63) + 1;
  if (t >= 9) t = t + 1;
  return [power, t];
};

// Lua: damage.lua:149 -- pokefirered/src/battle_script_commands.c:7928
Damage.flailPower = function (hpIn: any, maxHpIn: any): number {
  const hp = tonumber(hpIn) ?? 1;
  const maxHp = Math.max(1, tonumber(maxHpIn) ?? 1);
  let n = Math.floor(hp * 48 / maxHp);
  if (n === 0 && hp > 0) n = 1;
  if (n <= 1) return 200;
  if (n <= 4) return 150;
  if (n <= 9) return 100;
  if (n <= 16) return 80;
  if (n <= 32) return 40;
  return 20;
};

// Lua: damage.lua:163 -- pokefirered/src/battle_script_commands.c:9074
Damage.lowKickPower = function (dMon: any, defender: any): number {
  let wt: number;
  if (truthy(dMon) && truthy(dMon.weight)) {
    wt = tonumber(dMon.weight) ?? 0;
  } else {
    const sp = lor(truthy(defender) ? defender.species : defender, Pokemon.speciesOf(dMon));
    const dex = truthy(sp) ? Pokemon.dexEntry(sp) : sp;
    wt = (truthy(dex) ? tonumber(dex.weight) : undefined) ?? 0;
  }
  const tbl = seq(seq(100, 20), seq(250, 40), seq(500, 60), seq(1000, 80), seq(2000, 100));
  for (const [, row] of ipairs<(number | null)[]>(tbl)) {
    if (row[1]! > wt) return row[2]!;
  }
  return 120;
};

// Lua: damage.lua:181 -- pokefirered/src/pokemon.c:2385
Damage.base = function (attacker: any, defender: any, move: any, optsIn?: any): number {
  const opts: any = optsIn ?? {};
  const aMon = lor(attacker.mon, attacker);
  const dMon = lor(defender.mon, defender);
  let power: number = tonumber(opts.power) ?? tonumber(move.power) ?? 0;
  const moveType: number = tonumber(opts.moveType) ?? tonumber(move.type) ?? 0;
  const crit = truthy(opts.crit);
  const adapter = opts.adapter;

  let attack: number = mon_stat(aMon, "attack", 50);
  let defense: number = mon_stat(dMon, "defense", 50);
  let spAttack: number = mon_stat(aMon, "spAtk", 50);
  let spDefense: number = mon_stat(dMon, "spDef", 50);
  if (truthy(attacker.expTransform)) {
    const t = attacker.expTransform;
    const a2 = lor(t.attack, attack), s2 = lor(t.spAtk, spAttack);
    attack = a2; spAttack = s2;
  }
  if (truthy(defender.expTransform)) {
    const t = defender.expTransform;
    const d2 = lor(t.defense, defense), s2 = lor(t.spDef, spDefense);
    defense = d2; spDefense = s2;
  }

  const aAb = ability_of(attacker, adapter);
  const dAb = ability_of(defender, adapter);
  if (aAb === "HUGE_POWER" || aAb === "PURE_POWER") attack = attack * 2;
  const st = truthy(adapter) ? adapter._st : adapter;
  // package.loaded["src.core.game3.battle.engine"]
  const k = lor(truthy(st) ? st.kinds : st, {});
  // pokeemerald/src/pokemon.c:3407
  let noBoost: any = st;
  if (truthy(noBoost)) noBoost = BattleProfile.isRse(st);
  if (truthy(noBoost)) noBoost = lor(lor(lor(st.eReader, st.secretBase), k.frontier), k.recordedLink);
  if (truthy(st) && truthy(Engine) && truthy(Engine.hasBadge) && !truthy(noBoost)) {
    if (attacker.side === "player" && truthy(Engine.hasBadge(st, 1))) attack = Math.floor(110 * attack / 100);
    if (defender.side === "player" && truthy(Engine.hasBadge(st, 5))) defense = Math.floor(110 * defense / 100);
    if (attacker.side === "player" && truthy(Engine.hasBadge(st, 7))) spAttack = Math.floor(110 * spAttack / 100);
    if (defender.side === "player" && truthy(Engine.hasBadge(st, 7))) spDefense = Math.floor(110 * spDefense / 100);
  }
  const HOLD = HeldItems.HOLD;
  const [aHe, aParam] = HeldItems.of(attacker);
  const dHe = HeldItems.of(defender)[0];
  if (HeldItems.TYPE_BOOST[aHe] === moveType) {
    if (Types.isPhysical(moveType)) {
      attack = Math.floor(attack * (aParam + 100) / 100);
    } else {
      spAttack = Math.floor(spAttack * (aParam + 100) / 100);
    }
  }
  const aSp = tonumber(lor(attacker.species, aMon.species)) ?? 0;
  const dSp = tonumber(lor(defender.species, dMon.species)) ?? 0;
  if (aHe === HOLD.CHOICE_BAND) attack = Math.floor(150 * attack / 100);
  if (aHe === HOLD.SOUL_DEW && (aSp === 407 || aSp === 408)) spAttack = Math.floor(150 * spAttack / 100);
  if (dHe === HOLD.SOUL_DEW && (dSp === 407 || dSp === 408)) spDefense = Math.floor(150 * spDefense / 100);
  if (aHe === HOLD.DEEP_SEA_TOOTH && aSp === 373) spAttack = spAttack * 2;
  if (dHe === HOLD.DEEP_SEA_SCALE && dSp === 373) spDefense = spDefense * 2;
  if (aHe === HOLD.LIGHT_BALL && aSp === 25) spAttack = spAttack * 2;
  if (dHe === HOLD.METAL_POWDER && dSp === 132) defense = defense * 2;
  if (aHe === HOLD.THICK_CLUB && (aSp === 104 || aSp === 105)) attack = attack * 2;
  if (dAb === "THICK_FAT" && (moveType === Types.ID.FIRE || moveType === Types.ID.ICE)) {
    spAttack = Math.floor(spAttack / 2);
  }
  if (aAb === "HUSTLE") attack = Math.floor(150 * attack / 100);
  if ((aAb === "PLUS" || aAb === "MINUS") && truthy(adapter) && truthy(adapter.activeBattlers)) {
    const want = (aAb === "PLUS") ? "MINUS" : "PLUS";
    for (const [, b] of ipairs(adapter.activeBattlers())) {
      if (ability_of(b, adapter) === want) { spAttack = Math.floor(150 * spAttack / 100); break; }
    }
  }
  if (aAb === "GUTS" && truthy(status_of(attacker))) attack = Math.floor(150 * attack / 100);
  if (dAb === "MARVEL_SCALE" && truthy(status_of(defender))) defense = Math.floor(150 * defense / 100);
  if (moveType === Types.ID.ELECTRIC && truthy(opts.mudSport)) power = Math.floor(power / 2);
  if (moveType === Types.ID.FIRE && truthy(opts.waterSport)) power = Math.floor(power / 2);
  const aHp = tonumber(aMon.hp) ?? 0;
  const aMax = Math.max(1, tonumber(aMon.maxHp) ?? 1);
  const pinch = aHp <= Math.floor(aMax / 3);
  if (pinch && ((moveType === Types.ID.GRASS && aAb === "OVERGROW")
      || (moveType === Types.ID.FIRE && aAb === "BLAZE")
      || (moveType === Types.ID.WATER && aAb === "TORRENT")
      || (moveType === Types.ID.BUG && aAb === "SWARM"))) {
    power = Math.floor(150 * power / 100);
  }

  if (tonumber(move.effect) === EffectIds.EXPLOSION) {
    defense = Math.floor(defense / 2);
  }

  const aStages = lor(attacker.stages, {});
  const dStages = lor(defender.stages, {});
  const level = tonumber(lor(aMon.level, attacker.level)) ?? 5;
  const levelFactor = Math.floor(2 * level / 5) + 2;
  let damage = 0;

  if (Types.isPhysical(moveType)) {
    let atkStage = aStages.attack ?? 0;
    if (crit && atkStage <= 0) atkStage = 0;
    damage = Damage.applyStage(attack, atkStage);
    damage = damage * power;
    damage = damage * levelFactor;
    let defStage = dStages.defense ?? 0;
    if (crit && defStage >= 0) defStage = 0;
    const helper = Math.max(1, Damage.applyStage(defense, defStage));
    damage = Math.floor(damage / helper);
    damage = Math.floor(damage / 50);
    if (status_of(attacker) === "BRN" && aAb !== "GUTS") damage = Math.floor(damage / 2);
    if (truthy(opts.reflect) && !crit) {
      if (truthy(opts.doubleScreens)) {
        damage = 2 * Math.floor(damage / 3);
      } else {
        damage = Math.floor(damage / 2);
      }
    }
    // pokefirered/src/pokemon.c:2552
    if (truthy(opts.spread)) damage = Math.floor(damage / 2);
    if (damage === 0) damage = 1;
  }

  if (moveType === Types.ID.MYSTERY) damage = 0;

  if (!Types.isPhysical(moveType) && moveType !== Types.ID.MYSTERY) {
    let atkStage = aStages.spAtk ?? 0;
    if (crit && atkStage <= 0) atkStage = 0;
    damage = Damage.applyStage(spAttack, atkStage);
    damage = damage * power;
    damage = damage * levelFactor;
    let defStage = dStages.spDef ?? 0;
    if (crit && defStage >= 0) defStage = 0;
    const helper = Math.max(1, Damage.applyStage(spDefense, defStage));
    damage = Math.floor(damage / helper);
    damage = Math.floor(damage / 50);
    if (truthy(opts.lightScreen) && !crit) {
      if (truthy(opts.doubleScreens)) {
        damage = 2 * Math.floor(damage / 3);
      } else {
        damage = Math.floor(damage / 2);
      }
    }
    // pokefirered/src/pokemon.c:2604
    if (truthy(opts.spread)) damage = Math.floor(damage / 2);
    const weather = opts.weatherKind;
    if (weather === "RAIN") {
      if (moveType === Types.ID.FIRE) damage = Math.floor(damage / 2);
      else if (moveType === Types.ID.WATER) damage = Math.floor(15 * damage / 10);
    }
    if ((weather === "RAIN" || weather === "SAND" || weather === "HAIL") && truthy(opts.isSolarBeam)) {
      damage = Math.floor(damage / 2);
    }
    if (weather === "SUN") {
      if (moveType === Types.ID.FIRE) damage = Math.floor(15 * damage / 10);
      else if (moveType === Types.ID.WATER) damage = Math.floor(damage / 2);
    }
    if (truthy(attacker.expFlashFire) && moveType === Types.ID.FIRE) {
      damage = Math.floor(15 * damage / 10);
    }
  }

  return damage + 2;
};

// Lua: damage.lua:339
function fixed_info(move: any, eff: number, flags: TypeFlags, physical: boolean, extra?: any): DamageInfo {
  const info: DamageInfo = {
    move: move,
    effectiveness: eff,
    critical: false,
    physical: physical,
    fixed: true,
    typeFlags: flags,
  };
  for (const [k, v] of pairs(extra ?? {})) info[k] = v;
  return info;
}

// Lua: damage.lua:352
Damage.calc = function (attacker: any, defender: any, moveId: any, optsIn?: any): [number, DamageInfo] {
  const opts: any = optsIn ?? {};
  const move: any = (moveId !== null && typeof moveId === "object" && moveId.effect != null)
    ? moveId : Moves.get(moveId);
  const aMon = lor(attacker.mon, attacker);
  const dMon = lor(defender.mon, defender);
  Damage.ensureStats(aMon, aMon.level);
  Damage.ensureStats(dMon, dMon.level);

  const effectByte = tonumber(move.effect);
  let power: number = tonumber(opts.power) ?? tonumber(move.power) ?? 0;
  let moveType: number = tonumber(opts.moveType) ?? tonumber(move.type) ?? 0;
  let dmgMultiplier: number = tonumber(opts.dmgMultiplier) ?? 1;
  let magnitudeVal: number | null = null;
  const weatherKind = lor(opts.weatherKind, Rules.weather.kind(opts.weather));
  const rng = truthy(opts.rng) ? opts.rng : Guard.source("damage.calc", random);
  const level: number = tonumber(lor(aMon.level, attacker.level)) ?? 5;

  if (power <= 0 && !truthy(opts.power)) {
    return [0, { move: move, effectiveness: 1, critical: false, status: true }];
  }

  if (effectByte === EffectIds.MAGNITUDE && !truthy(opts.power)) {
    const r: number = truthy(opts.magnitudeRoll) ? opts.magnitudeRoll : roll_from(rng, 0, 99);
    // pokefirered/src/battle_script_commands.c:8284
    if (r < 5) { magnitudeVal = 4; power = 10; }
    else if (r < 15) { magnitudeVal = 5; power = 30; }
    else if (r < 35) { magnitudeVal = 6; power = 50; }
    else if (r < 65) { magnitudeVal = 7; power = 70; }
    else if (r < 85) { magnitudeVal = 8; power = 90; }
    else if (r < 95) { magnitudeVal = 9; power = 110; }
    else { magnitudeVal = 10; power = 150; }
  } else if (effectByte === EffectIds.RETURN && !truthy(opts.power)) {
    const friendship = tonumber(lor(aMon.friendship, aMon.happiness)) ?? 70;
    power = Math.floor(10 * friendship / 25);
  } else if (effectByte === EffectIds.FRUSTRATION && !truthy(opts.power)) {
    const friendship = tonumber(lor(aMon.friendship, aMon.happiness)) ?? 70;
    power = Math.floor(10 * (255 - friendship) / 25);
  } else if (effectByte === EffectIds.ERUPTION && !truthy(opts.power)) {
    const curHp = tonumber(aMon.hp) ?? 1;
    const maxHp = Math.max(1, tonumber(aMon.maxHp) ?? 1);
    power = Math.floor(curHp * power / maxHp);
    if (power === 0) power = 1;
  } else if (effectByte === EffectIds.FLAIL && !truthy(opts.power)) {
    power = Damage.flailPower(aMon.hp, aMon.maxHp);
  } else if (effectByte === EffectIds.LOW_KICK && !truthy(opts.power)) {
    power = Damage.lowKickPower(dMon, defender);
  } else if (effectByte === EffectIds.HIDDEN_POWER && !truthy(opts.power)) {
    const [p, t] = Damage.hiddenPower(aMon);
    power = p;
    if (!truthy(opts.moveType)) moveType = t;
  } else if (effectByte === EffectIds.WEATHER_BALL && !truthy(opts.moveType)) {
    // pokefirered/src/battle_script_commands.c:9345
    if (truthy(weatherKind)) {
      dmgMultiplier = dmgMultiplier * 2;
      if (weatherKind === "RAIN") moveType = Types.ID.WATER!;
      else if (weatherKind === "SAND") moveType = Types.ID.ROCK!;
      else if (weatherKind === "SUN") moveType = Types.ID.FIRE!;
      else if (weatherKind === "HAIL") moveType = Types.ID.ICE!;
    }
  }

  if (effectByte === EffectIds.PURSUIT && truthy(opts.pursuitSwitch)) {
    dmgMultiplier = dmgMultiplier * 2;
  } else if (effectByte === EffectIds.FACADE && !truthy(opts.dmgMultiplier)) {
    const st = status_of(attacker);
    if (st === "BRN" || st === "PAR" || st === "PSN" || st === "TOX") {
      dmgMultiplier = dmgMultiplier * 2;
    }
  } else if (effectByte === EffectIds.REVENGE && !truthy(opts.dmgMultiplier)) {
    // pokefirered/src/battle_script_commands.c:8946
    let hurtOk: boolean;
    if (truthy(opts.adapter) && truthy(opts.adapter._st) && truthy(opts.adapter._st.double)) {
      hurtOk = attacker.expHurtById == null || attacker.expHurtById === defender.id;
    } else {
      hurtOk = attacker.expHurtBy == null || attacker.expHurtBy === defender.side;
    }
    if ((attacker.damageTakenThisTurn ?? 0) > 0 && hurtOk) {
      dmgMultiplier = dmgMultiplier * 2;
    }
  } else if (effectByte === EffectIds.SMELLINGSALT && !truthy(opts.dmgMultiplier)) {
    if (status_of(defender) === "PAR" && (defender.substituteHP ?? 0) <= 0) {
      dmgMultiplier = dmgMultiplier * 2;
    }
  }

  const physical = Types.isPhysical(moveType);
  let foresight = opts.foresight;
  if (foresight == null) foresight = truthy(defender.expIdentified);
  let dType1 = defender.type1;
  let dType2 = defender.type2;
  if (truthy(defender.expTransform)) {
    dType1 = lor(defender.expTransform.type1, dType1);
    dType2 = lor(defender.expTransform.type2, dType2);
  }
  let [, flags, eff] = Types.typeCalc(moveType, dType1, dType2, null, foresight);

  let fixedAmount: any = null;
  if (effectByte === EffectIds.COUNTER) {
    const taken = attacker.lastPhysicalDamageTaken ?? 0;
    if (taken <= 0) {
      return [0, { move: move, effectiveness: eff, critical: false, physical: physical, failed: true }];
    }
    return [(flags.immune ? 0 : taken * 2), {
      move: move, effectiveness: eff, critical: false, physical: physical,
      typeFlags: flags, setDamage: true,
    }];
  } else if (effectByte === EffectIds.MIRROR_COAT) {
    const taken = attacker.lastSpecialDamageTaken ?? 0;
    if (taken <= 0) {
      return [0, { move: move, effectiveness: eff, critical: false, physical: physical, failed: true }];
    }
    return [(flags.immune ? 0 : taken * 2), {
      move: move, effectiveness: eff, critical: false, physical: physical,
      typeFlags: flags, setDamage: true,
    }];
  } else if (effectByte === EffectIds.DRAGON_RAGE) {
    fixedAmount = 40;
  } else if (effectByte === EffectIds.SONICBOOM) {
    fixedAmount = 20;
  } else if (effectByte === EffectIds.LEVEL_DAMAGE) {
    fixedAmount = level;
  } else if (effectByte === EffectIds.SUPER_FANG) {
    fixedAmount = Math.max(1, Math.floor((tonumber(dMon.hp) ?? 1) / 2));
  } else if (effectByte === EffectIds.ENDEAVOR) {
    const uHp = tonumber(aMon.hp) ?? 0;
    const dHp = tonumber(dMon.hp) ?? 0;
    if (dHp <= uHp) {
      return [0, { move: move, effectiveness: eff, critical: false, physical: physical, failed: true }];
    }
    fixedAmount = dHp - uHp;
  } else if (effectByte === EffectIds.PSYWAVE) {
    // pokefirered/src/battle_script_commands.c:7557
    let r: number = truthy(opts.psywaveRoll) ? opts.psywaveRoll : roll_from(rng, 0, 10);
    r = Math.max(0, Math.min(10, Math.floor(r)));
    fixedAmount = Math.floor(level * (r * 10 + 50) / 100);
  } else if (truthy(opts.fixedDamage)) {
    fixedAmount = opts.fixedDamage;
  }
  if (truthy(fixedAmount)) {
    if (flags.immune) {
      return [0, fixed_info(move, 0, flags, physical)];
    }
    return [fixedAmount, fixed_info(move, eff, flags, physical)];
  }

  let crit = false;
  const defAb = ability_of(defender, opts.adapter);
  if (opts.forceCrit != null) {
    crit = truthy(opts.forceCrit);
  } else if (defAb !== "BATTLE_ARMOR" && defAb !== "SHELL_ARMOR" && !truthy(opts.noCrit)) {
    // pokefirered/src/battle_script_commands.c:1170
    const critSt = lor(opts.st, truthy(opts.adapter) ? opts.adapter._st : opts.adapter);
    if (truthy(opts.adapter) && ModRuntime.wantsHook("battle.crit")) {
      const num = lor(tonumber(move.numId), G3.moveId(move.id));
      crit = truthy(ModRuntime.call("battle.crit", function (c: any): boolean {
        return Rules.crit.roll(c.attacker, move, c.highCrit, c.rng, critSt);
      }, { battle: opts.adapter._st, attacker: attacker, target: defender,
           moveId: lor(G3.moveName(num), move.id), moveNum: num, rng: rng,
           highCrit: opts.highCrit,
           stage: Rules.crit.stage(attacker, move, opts.highCrit) }));
    } else {
      crit = Rules.crit.roll(attacker, move, opts.highCrit, rng, critSt);
    }
  }
  const critMul = crit ? Rules.crit.multiplier() : 1;

  let dmg: number = Damage.base(attacker, defender, move, {
    power: power,
    moveType: moveType,
    crit: crit,
    adapter: opts.adapter,
    reflect: opts.reflect,
    lightScreen: opts.lightScreen,
    doubleScreens: opts.doubleScreens,
    spread: opts.spread,
    weatherKind: weatherKind,
    isSolarBeam: effectByte === EffectIds.SOLAR_BEAM,
    mudSport: opts.mudSport,
    waterSport: opts.waterSport,
  });
  // pokefirered/src/battle_script_commands.c:1209
  dmg = dmg * critMul * dmgMultiplier;
  if (truthy(attacker.expCharged) && tonumber(move.type) === Types.ID.ELECTRIC) {
    dmg = dmg * 2;
  }
  // pokefirered/src/battle_script_commands.c:1219
  if (truthy(attacker.expHelpingHand)) dmg = Math.floor(dmg * 15 / 10);

  let stab = 1;
  let aT1 = attacker.type1, aT2 = attacker.type2;
  if (truthy(attacker.expTransform)) {
    aT1 = lor(attacker.expTransform.type1, aT1);
    aT2 = lor(attacker.expTransform.type2, aT2);
  }
  if (move.id !== "STRUGGLE" && tonumber(move.numId) !== 165) {
    if (aT1 === moveType || aT2 === moveType) {
      stab = 1.5;
      dmg = Math.floor(dmg * 15 / 10);
    }
    let d2: number | null | undefined;
    [d2, flags, eff] = Types.typeCalc(moveType, dType1, dType2, dmg, foresight);
    dmg = d2 as number;
  } else {
    flags = { super: false, notVery: false, immune: false };
    eff = 1;
  }
  if (flags.immune) {
    return [0, {
      move: move, effectiveness: 0, critical: false, physical: physical,
      stab: stab, magnitude: magnitudeVal, moveType: moveType, typeFlags: flags,
    }];
  }

  // pokefirered/src/battle_script_commands.c:1558
  if (dmg !== 0 && !truthy(opts.noRandom)) {
    const roll = tonumber(opts.forceRoll) ?? roll_from(rng, 85, 100);
    dmg = Math.floor(dmg * roll / 100);
    if (dmg === 0) dmg = 1;
  }

  if (effectByte === EffectIds.FALSE_SWIPE && (defender.substituteHP ?? 0) <= 0) {
    const curHp = tonumber(dMon.hp) ?? 1;
    if (dmg >= curHp) dmg = Math.max(0, curHp - 1);
  }

  return [dmg, {
    move: move,
    effectiveness: eff,
    critical: crit,
    physical: physical,
    stab: stab,
    magnitude: magnitudeVal,
    moveType: moveType,
    typeFlags: flags,
    power: power,
  }];
};

export default Damage;
