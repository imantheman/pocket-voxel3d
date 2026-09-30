// Gen 2 move effects: a port of gen1recomp src/battle/gen2/Effects.lua
// (bdfac727, MIT).
//
// Gen 2 move effects, as data plus the small amount of arithmetic each one
// needs.  Ported from engine/battle/effect_commands.asm; the battle engine
// (src/battle/gen2/Battle.lua) owns the turn loop and calls in here for what a
// move does beyond "roll damage, maybe inflict a status".
//
// Everything is keyed by the move's *effect*, the same byte data/moves/moves.asm
// stores, so a modded move that copies an effect inherits its behaviour -- and
// an effect this table does not name still lands as an ordinary hit rather than
// silently doing the wrong thing.
//
// No love calls and no engine state: every function takes what it needs and
// returns a value or a small table, which is what lets the tests drive them
// directly.
//
// Port notes: the Lua's { stat, stages, target } and { chance, power, number }
// rows are 0-based JS tuples here (row[0], row[1], row[2]).  Functions that
// return two Lua values return a tuple.  `random(n)` arguments are BattleRandom
// style (0..n-1), exactly as in the Lua.

import { Strings } from "../shared/core/Strings.ts";
import { mod } from "../platform/lua.ts";
import { random as luaRandom } from "../platform/rng.ts";

/** `random(n)` returning 0..n-1. */
export type ZeroRandom = (n: number) => number;

/** { stat, stages, target } where target is "self" or "foe". */
export type StatChange = [string, number, "self" | "foe"];

export const Effects = {
  // --------------------------------------------------------------- stat stages
  //
  // Stat changes come in four shapes and the effect name says which:
  //   *_UP / *_UP_2      raise the user, by one stage or two
  //   *_DOWN / *_DOWN_2  lower the target
  //   *_UP_HIT           raise the user after a damaging hit
  //   *_DOWN_HIT         lower the target after a damaging hit
  // StatUpMessage / StatDownMessage are the same either way, so the direction
  // and the target are the only things worth tabulating.

  // { stat, stages, target } where target is "self" or "foe".
  // Lua: Effects.lua:30
  STAT_CHANGES: {
    EFFECT_ATTACK_UP: ["attack", 1, "self"],
    EFFECT_DEFENSE_UP: ["defense", 1, "self"],
    EFFECT_SP_ATK_UP: ["specialAttack", 1, "self"],
    EFFECT_EVASION_UP: ["evasion", 1, "self"],
    EFFECT_ATTACK_UP_2: ["attack", 2, "self"],
    EFFECT_DEFENSE_UP_2: ["defense", 2, "self"],
    EFFECT_SPEED_UP_2: ["speed", 2, "self"],
    EFFECT_SP_DEF_UP_2: ["specialDefense", 2, "self"],
    // Defense Curl also arms Rollout, which Battle tracks separately.
    EFFECT_DEFENSE_CURL: ["defense", 1, "self"],

    EFFECT_ATTACK_DOWN: ["attack", -1, "foe"],
    EFFECT_DEFENSE_DOWN: ["defense", -1, "foe"],
    EFFECT_SPEED_DOWN: ["speed", -1, "foe"],
    EFFECT_ACCURACY_DOWN: ["accuracy", -1, "foe"],
    EFFECT_EVASION_DOWN: ["evasion", -1, "foe"],
    EFFECT_ATTACK_DOWN_2: ["attack", -2, "foe"],
    EFFECT_DEFENSE_DOWN_2: ["defense", -2, "foe"],
    EFFECT_SPEED_DOWN_2: ["speed", -2, "foe"],
  } as Record<string, StatChange>,

  // pokegold data/moves/effects.asm:187-352, :1488, :2068
  // ../pokecrystal/data/moves/effects_pointers.asm, effects.asm
  // ../pokecrystal/engine/battle/effect_commands.asm:5448
  // Lua: Effects.lua:55
  NO_CHECKHIT: {
    EFFECT_MIRROR_MOVE: true,
    EFFECT_ATTACK_UP: true,
    EFFECT_DEFENSE_UP: true,
    EFFECT_SPEED_UP: true,
    EFFECT_SP_ATK_UP: true,
    EFFECT_SP_DEF_UP: true,
    EFFECT_ACCURACY_UP: true,
    EFFECT_EVASION_UP: true,
    EFFECT_RESET_STATS: true,
    EFFECT_CONVERSION: true,
    EFFECT_HEAL: true,
    EFFECT_LIGHT_SCREEN: true,
    EFFECT_MIST: true,
    EFFECT_FOCUS_ENERGY: true,
    EFFECT_ATTACK_UP_2: true,
    EFFECT_DEFENSE_UP_2: true,
    EFFECT_SPEED_UP_2: true,
    EFFECT_SP_ATK_UP_2: true,
    EFFECT_SP_DEF_UP_2: true,
    EFFECT_ACCURACY_UP_2: true,
    EFFECT_EVASION_UP_2: true,
    EFFECT_TRANSFORM: true,
    EFFECT_REFLECT: true,
    EFFECT_SUBSTITUTE: true,
    EFFECT_METRONOME: true,
    EFFECT_SPLASH: true,
    EFFECT_COUNTER: true,
    EFFECT_SKETCH: true,
    EFFECT_DEFROST_OPPONENT: true,
    EFFECT_SLEEP_TALK: true,
    EFFECT_DESTINY_BOND: true,
    EFFECT_HEAL_BELL: true,
    EFFECT_MEAN_LOOK: true,
    EFFECT_NIGHTMARE: true,
    EFFECT_CURSE: true,
    EFFECT_PROTECT: true,
    EFFECT_SPIKES: true,
    EFFECT_PERISH_SONG: true,
    EFFECT_SANDSTORM: true,
    EFFECT_ENDURE: true,
    EFFECT_SAFEGUARD: true,
    EFFECT_BATON_PASS: true,
    EFFECT_MORNING_SUN: true,
    EFFECT_SYNTHESIS: true,
    EFFECT_MOONLIGHT: true,
    EFFECT_RAIN_DANCE: true,
    EFFECT_SUNNY_DAY: true,
    EFFECT_BELLY_DRUM: true,
    EFFECT_PSYCH_UP: true,
    EFFECT_MIRROR_COAT: true,
    EFFECT_TELEPORT: true,
    EFFECT_DEFENSE_CURL: true,
  } as Record<string, boolean>,

  // ../pokecrystal/engine/battle/effect_commands.asm:1947
  // ../pokecrystal/data/moves/effects.asm
  // Lua: Effects.lua:112
  AFTER_ANIM: {
    EFFECT_NORMAL_HIT: "damage",
    EFFECT_POISON_HIT: "damage",
    EFFECT_LEECH_HIT: "damage",
    EFFECT_BURN_HIT: "damage",
    EFFECT_FREEZE_HIT: "damage",
    EFFECT_PARALYZE_HIT: "damage",
    EFFECT_SELFDESTRUCT: "damage",
    EFFECT_DREAM_EATER: "damage",
    EFFECT_ALWAYS_HIT: "damage",
    EFFECT_BIDE: "damage",
    EFFECT_RAMPAGE: "damage",
    EFFECT_MULTI_HIT: "damage",
    EFFECT_FLINCH_HIT: "damage",
    EFFECT_PAY_DAY: "damage",
    EFFECT_TRI_ATTACK: "damage",
    EFFECT_UNUSED_25: "damage",
    EFFECT_OHKO: "damage",
    EFFECT_RAZOR_WIND: "damage",
    EFFECT_SUPER_FANG: "damage",
    EFFECT_STATIC_DAMAGE: "damage",
    EFFECT_TRAP_TARGET: "damage",
    EFFECT_UNUSED_2B: "damage",
    EFFECT_DOUBLE_HIT: "damage",
    EFFECT_JUMP_KICK: "damage",
    EFFECT_RECOIL_HIT: "damage",
    EFFECT_ATTACK_DOWN_HIT: "damage",
    EFFECT_DEFENSE_DOWN_HIT: "damage",
    EFFECT_SPEED_DOWN_HIT: "damage",
    EFFECT_SP_ATK_DOWN_HIT: "damage",
    EFFECT_SP_DEF_DOWN_HIT: "damage",
    EFFECT_ACCURACY_DOWN_HIT: "damage",
    EFFECT_EVASION_DOWN_HIT: "damage",
    EFFECT_SKY_ATTACK: "damage",
    EFFECT_CONFUSE_HIT: "damage",
    EFFECT_POISON_MULTI_HIT: "damage",
    EFFECT_UNUSED_4E: "damage",
    EFFECT_HYPER_BEAM: "damage",
    EFFECT_RAGE: "damage",
    EFFECT_LEVEL_DAMAGE: "damage",
    EFFECT_PSYWAVE: "damage",
    EFFECT_COUNTER: "damage",
    EFFECT_SNORE: "damage",
    EFFECT_REVERSAL: "damage",
    EFFECT_FALSE_SWIPE: "damage",
    EFFECT_PRIORITY_HIT: "damage",
    EFFECT_TRIPLE_KICK: "damage",
    EFFECT_THIEF: "damage",
    EFFECT_FLAME_WHEEL: "damage",
    EFFECT_UNUSED_6E: "damage",
    EFFECT_ROLLOUT: "damage",
    EFFECT_FURY_CUTTER: "damage",
    EFFECT_RETURN: "damage",
    EFFECT_FRUSTRATION: "damage",
    EFFECT_SACRED_FIRE: "damage",
    EFFECT_MAGNITUDE: "damage",
    EFFECT_PURSUIT: "damage",
    EFFECT_RAPID_SPIN: "damage",
    EFFECT_UNUSED_82: "damage",
    EFFECT_UNUSED_83: "damage",
    EFFECT_HIDDEN_POWER: "damage",
    EFFECT_DEFENSE_UP_HIT: "damage",
    EFFECT_ATTACK_UP_HIT: "damage",
    EFFECT_ALL_UP_HIT: "damage",
    EFFECT_FAKE_OUT: "damage",
    EFFECT_MIRROR_COAT: "damage",
    EFFECT_SKULL_BASH: "damage",
    EFFECT_TWISTER: "damage",
    EFFECT_EARTHQUAKE: "damage",
    EFFECT_FUTURE_SIGHT: "damage",
    EFFECT_GUST: "damage",
    EFFECT_STOMP: "damage",
    EFFECT_SOLARBEAM: "damage",
    EFFECT_THUNDER: "damage",
    EFFECT_BEAT_UP: "damage",
    EFFECT_FLY: "damage",
    EFFECT_ATTACK_DOWN: "statdown",
    EFFECT_DEFENSE_DOWN: "statdown",
    EFFECT_SPEED_DOWN: "statdown",
    EFFECT_SP_ATK_DOWN: "statdown",
    EFFECT_SP_DEF_DOWN: "statdown",
    EFFECT_ACCURACY_DOWN: "statdown",
    EFFECT_EVASION_DOWN: "statdown",
    EFFECT_ATTACK_DOWN_2: "statdown",
    EFFECT_DEFENSE_DOWN_2: "statdown",
    EFFECT_SPEED_DOWN_2: "statdown",
    EFFECT_SP_ATK_DOWN_2: "statdown",
    EFFECT_SP_DEF_DOWN_2: "statdown",
    EFFECT_ACCURACY_DOWN_2: "statdown",
    EFFECT_EVASION_DOWN_2: "statdown",
  } as Record<string, string>,

  // The secondary versions, rolled against the move's effect chance after a hit.
  // Lua: Effects.lua:205
  STAT_CHANGES_ON_HIT: {
    EFFECT_ATTACK_UP_HIT: ["attack", 1, "self"],
    EFFECT_DEFENSE_UP_HIT: ["defense", 1, "self"],
    EFFECT_ATTACK_DOWN_HIT: ["attack", -1, "foe"],
    EFFECT_DEFENSE_DOWN_HIT: ["defense", -1, "foe"],
    EFFECT_SPEED_DOWN_HIT: ["speed", -1, "foe"],
    EFFECT_ACCURACY_DOWN_HIT: ["accuracy", -1, "foe"],
    EFFECT_SP_DEF_DOWN_HIT: ["specialDefense", -1, "foe"],
  } as Record<string, StatChange>,

  // Ancient Power raises every one of the user's stats at once.
  // Lua: Effects.lua:216
  ALL_UP_STATS: ["attack", "defense", "speed", "specialAttack", "specialDefense"] as string[],

  // Lua: Effects.lua:220
  STAT_NAMES: {
    attack: Strings.source("ATTACK"),
    defense: Strings.source("DEFENSE"),
    speed: Strings.source("SPEED"),
    specialAttack: Strings.source("SPCL.ATK"),
    specialDefense: Strings.source("SPCL.DEF"),
    accuracy: Strings.source("ACCURACY"),
    evasion: Strings.source("EVASION"),
  } as Record<string, string>,

  // Stages clamp at ±6 (BattleCommand_StatUp's .CantRaise / .CantLower).
  MAX_STAGE: 6,

  // Applies a change and says what happened, so the caller can emit the cart's
  // own message: nil when the stage was already at the cap.
  // Lua: Effects.lua:233
  applyStage(stages: Record<string, any> | undefined, stat: string | undefined, delta: number): number | undefined {
    if (!(stages != null && stat != null)) return undefined;
    const current: number = stages[stat] ?? 0;
    let wanted = current + delta;
    if (wanted > Effects.MAX_STAGE) wanted = Effects.MAX_STAGE;
    if (wanted < -Effects.MAX_STAGE) wanted = -Effects.MAX_STAGE;
    if (wanted === current) return undefined;
    stages[stat] = wanted;
    return wanted - current;
  },

  // BattleCommand_StatUpMessage / StatDownMessage: one stage is "rose"/"fell",
  // two are "sharply rose" / "sharply fell".
  // Lua: Effects.lua:246
  stageMessage(name: string, stat: string, applied: number): string {
    const label = Strings.get(Effects.STAT_NAMES[stat] ?? stat);
    if (applied > 0) {
      if (Math.abs(applied) >= 2) {
        return Strings.get("%s's %s sharply rose!", name, label);
      }
      return Strings.get("%s's %s rose!", name, label);
    }
    if (Math.abs(applied) >= 2) {
      return Strings.get("%s's %s sharply fell!", name, label);
    }
    return Strings.get("%s's %s fell!", name, label);
  },

  // ------------------------------------------------------------------ hit count
  //
  // BattleCommand_CheckHit's multi-hit roll: 2 and 3 hits are 3/8 each, 4 and 5
  // are 1/8 each, which is what the `and 3` on a 0-3 roll plus the two-step
  // fallthrough in .DetermineNumberOfHits produces.
  // Lua: Effects.lua:265
  multiHitCount(random?: ZeroRandom): number {
    const roll = (n: number): number => {
      if (random) return random(n);
      return luaRandom(n) - 1;
    };
    // engine/battle/effect_commands.asm:5228
    const first = roll(4);
    if (first < 2) return first + 2;
    return roll(4) + 2;
  },

  // Lua: Effects.lua:279
  HIT_COUNTS: {
    EFFECT_DOUBLE_HIT: 2,
    EFFECT_POISON_MULTI_HIT: 2,
    // Triple Kick stops early if a hit misses; Battle rolls that per hit.
    EFFECT_TRIPLE_KICK: 3,
  } as Record<string, number>,

  // Lua: Effects.lua:286
  hitCount(effect: string | undefined, random?: ZeroRandom): number {
    if (effect === "EFFECT_MULTI_HIT") {
      return Effects.multiHitCount(random);
    }
    return (effect != null ? Effects.HIT_COUNTS[effect] : undefined) ?? 1;
  },

  // Triple Kick's power climbs 10/20/30 across its three kicks
  // (BattleCommand_TripleKick).
  // Lua: Effects.lua:295
  tripleKickPower(base: number | undefined, hit: number): number {
    return (base ?? 10) * hit;
  },

  // ----------------------------------------------------------- recoil and drain

  // BattleCommand_Recoil: a quarter of the damage dealt, minimum 1.
  // Lua: Effects.lua:302
  recoilDamage(damageDealt?: number): number {
    return Math.max(1, Math.floor((damageDealt ?? 0) / 4));
  },

  // BattleCommand_DrainTarget: half the damage dealt, minimum 1.
  // Lua: Effects.lua:307
  drainAmount(damageDealt?: number): number {
    return Math.max(1, Math.floor((damageDealt ?? 0) / 2));
  },

  // Lua: Effects.lua:311
  DRAIN: {
    EFFECT_LEECH_HIT: true,
    EFFECT_DREAM_EATER: true,
  } as Record<string, boolean>,

  // --------------------------------------------------------------- two-turn
  //
  // The charge moves all share BattleCommand_Charge: turn one prints a line and
  // stores the move, turn two attacks.  Fly and Dig also make the user
  // untargetable in between, which is the `semi-invulnerable` flag here.
  // Lua: Effects.lua:321
  CHARGE: {
    EFFECT_RAZOR_WIND: { text: Strings.source("%s made a whirlwind!") },
    EFFECT_SOLARBEAM: { text: Strings.source("%s took in sunlight!") },
    EFFECT_SKULL_BASH: { text: Strings.source("%s lowered its head!") },
    EFFECT_SKY_ATTACK: { text: Strings.source("%s is glowing!") },
    EFFECT_FLY: { text: Strings.source("%s flew up high!"), vanish: true },
  } as Record<string, { text: string; vanish?: boolean }>,

  // CheckHit's .FlyDigMoves (effect_commands.asm:1713-1746): a vanished target
  // is not a flat miss, four moves reach it in the air and three underground.
  // Lua: Effects.lua:331
  FLY_DIG_EXCEPTIONS: {
    FLY: { GUST: true, WHIRLWIND: true, THUNDER: true, TWISTER: true },
    DIG: { EARTHQUAKE: true, FISSURE: true, MAGNITUDE: true },
  } as Record<string, Record<string, boolean>>,

  // Keyed by the charge move the target is partway through, which is what the
  // port carries in place of SUBSTATUS_FLYING / SUBSTATUS_UNDERGROUND.
  // Lua: Effects.lua:338
  hitsVanished(chargeMove: string | undefined, moveId: string | undefined): boolean {
    const reaches = chargeMove != null ? Effects.FLY_DIG_EXCEPTIONS[chargeMove] : undefined;
    return reaches != null && moveId != null && reaches[moveId] === true;
  },

  // --------------------------------------------------------------- fixed damage

  // BattleCommand_ConstantDamage (engine/battle/effect_commands.asm:3131-3205),
  // one command for the whole SuperFang / Psywave / StaticDamage list.
  // Lua: Effects.lua:347
  fixedDamage(effect: string | undefined, attacker: any, defender: any, random?: ZeroRandom, power?: number): number | undefined {
    if (effect === "EFFECT_LEVEL_DAMAGE") {
      return Math.max(1, attacker.level ?? 1);
    }
    if (effect === "EFFECT_SUPER_FANG") {
      return Math.max(1, Math.floor((defender.hp ?? 1) / 2));
    }
    if (effect === "EFFECT_PSYWAVE") {
      // .psywave rerolls until the byte is nonzero AND below level * 1.5, so the
      // top of the range is that ceiling minus one (effect_commands.asm:3163).
      const ceiling = Math.max(2, Math.floor(((attacker.level ?? 1) * 3) / 2));
      return Math.max(1, (random ? random(ceiling - 1) : 0) + 1);
    }
    // SONIC BOOM and DRAGON RAGE share EFFECT_STATIC_DAMAGE, whose arm reads
    // BATTLE_VARS_MOVE_POWER straight into the damage word: their stored power
    // (20 and 40) IS the damage, never a formula input
    // (effect_commands.asm:3157-3161).
    if (effect === "EFFECT_STATIC_DAMAGE") {
      return Math.max(1, Math.floor(power ?? 0));
    }
    return undefined;
  },

  // --------------------------------------------------------------- Substitute

  // BattleCommand_Substitute: a quarter of max HP, which is also what the user
  // pays.  Refuses when the user has that much HP or less.
  // Lua: Effects.lua:374
  substituteCost(maxHp?: number): number {
    return Math.max(1, Math.floor((maxHp ?? 1) / 4));
  },

  // ------------------------------------------------------------ counter moves

  // Counter answers physical damage, Mirror Coat special, both at double and
  // both only when the foe hit the user this turn (BattleCommand_Counter).
  // Lua: Effects.lua:382
  COUNTER: {
    EFFECT_COUNTER: "physical",
    EFFECT_MIRROR_COAT: "special",
  } as Record<string, string>,

  // Lua: Effects.lua:387
  counterDamage(taken?: number): number {
    return Math.max(1, (taken ?? 0) * 2);
  },

  // ------------------------------------------------------ rollout / fury cutter

  // Both double their power per consecutive use, Rollout for five turns and Fury
  // Cutter until it misses; the cart caps the doubling at 5 steps either way.
  // Lua: Effects.lua:395
  RAMPING: {
    EFFECT_ROLLOUT: 5,
    EFFECT_FURY_CUTTER: 5,
  } as Record<string, number>,

  // Lua: Effects.lua:400
  rampedPower(base: number | undefined, count: number | undefined, curled?: any): number {
    const steps = Math.min(Math.max(count ?? 0, 0), 4);
    let power = (base ?? 1) * 2 ** steps;
    // Defense Curl doubles Rollout again (BattleCommand_RolloutPower).
    if (curled != null && curled !== false) power = power * 2;
    return Math.floor(power);
  },

  // ----------------------------------------------------------------- magnitude
  //
  // data/moves/magnitude_power.asm, one row per magnitude: { chance, power,
  // magnitude number }.  The chance column is assembled through `percent`
  // (`* $ff / 100`, macros/data.asm:23), so `5 percent + 1` is 13 and
  // `100 percent` is 255 -- the thresholds below are those bytes, not the
  // percentages they were written as.
  // Lua: Effects.lua:415
  MAGNITUDE_POWER: [
    [13, 10, 4],
    [38, 30, 5],
    [89, 50, 6],
    [166, 70, 7],
    [217, 90, 8],
    [242, 110, 9],
    [255, 150, 10],
  ] as [number, number, number][],

  // BattleCommand_GetMagnitude (engine/battle/move_effects/magnitude.asm): ONE
  // random byte walks the table and the first row whose threshold is not below
  // it wins (`ld a, [hli] / cp b / jr nc`).  The row's power goes into d, which
  // is what damagecalc reads as the move's power -- data/moves/moves.asm stores
  // MAGNITUDE at power 1 precisely because this overwrites it.  Returns the
  // power and the magnitude number the text prints.
  //
  // `random` is BattleRandom (0..n-1).  If none is supplied, roll via love.math
  // / math.random -- never hard-code 0 (that always yields Magnitude 4).
  // Lua: Effects.lua:434
  magnitudePower(random?: ZeroRandom): [number, number] {
    let roll: number;
    if (typeof random === "function") {
      roll = random(256) ?? 0;
    } else {
      roll = luaRandom(256) - 1;
    }
    for (const row of Effects.MAGNITUDE_POWER) {
      if (row[0] >= roll) return [row[1], row[2]];
    }
    const last = Effects.MAGNITUDE_POWER[Effects.MAGNITUDE_POWER.length - 1]!;
    return [last[1], last[2]];
  },

  // engine/battle/move_effects/return.asm:1-24, frustration.asm:1-25
  // Lua: Effects.lua:451
  happinessPower(happiness?: number, frustration?: any): number {
    let h = happiness ?? 0;
    if (h < 0) h = 0;
    else if (h > 255) h = 255;
    if (frustration != null && frustration !== false) h = 255 - h;
    return Math.floor((h * 10) / 25);
  },

  // ------------------------------------------------------------------- weather
  //
  // BattleCommand_StartRain / StartSun / StartSandstorm all set wWeatherCount to
  // 5, which HandleWeather decrements at the end of every turn; the turn it
  // reaches zero the weather ends.  data/battle/weather_modifiers.asm is the
  // whole of what weather does to damage.

  // Lua: Effects.lua:465
  WEATHER: {
    EFFECT_RAIN_DANCE: "rain",
    EFFECT_SUNNY_DAY: "sun",
    EFFECT_SANDSTORM: "sandstorm",
  } as Record<string, string>,

  WEATHER_TURNS: 5,

  // Lua: Effects.lua:473
  WEATHER_START_TEXT: {
    rain: Strings.source("It started to rain!"),
    sun: Strings.source("The sunlight got bright!"),
    sandstorm: Strings.source("A sandstorm brewed!"),
  } as Record<string, string>,

  // Lua: Effects.lua:479
  WEATHER_TURN_TEXT: {
    rain: Strings.source("Rain continues to fall."),
    sun: Strings.source("The sunlight is strong."),
    sandstorm: Strings.source("The sandstorm rages."),
  } as Record<string, string>,

  // Lua: Effects.lua:485
  WEATHER_END_TEXT: {
    rain: Strings.source("The rain stopped."),
    sun: Strings.source("The sunlight faded."),
    sandstorm: Strings.source("The sandstorm subsided."),
  } as Record<string, string>,

  // data/battle/weather_modifiers.asm pairs each weather with MORE_EFFECTIVE or
  // NOT_VERY_EFFECTIVE, and those are 15 and 05 in tenths
  // (constants/battle_constants.asm:22, :24) -- MORE_EFFECTIVE is x1.5, NOT the
  // type chart's x2, which is SUPER_EFFECTIVE (20).  Gen 2's weather boost is a
  // half again, and only the type chart doubles.
  // Lua: Effects.lua:496
  WEATHER_TYPE_MODIFIERS: {
    rain: { WATER: 1.5, FIRE: 0.5 },
    sun: { FIRE: 1.5, WATER: 0.5 },
  } as Record<string, Record<string, number>>,

  // The one move whose EFFECT rather than type is modified: Solarbeam in rain.
  // Lua: Effects.lua:502
  WEATHER_MOVE_MODIFIERS: {
    rain: { EFFECT_SOLARBEAM: 0.5 },
  } as Record<string, Record<string, number>>,

  // Lua: Effects.lua:506
  weatherModifier(weather: string | null | undefined | false, moveType?: string, effect?: string): number {
    if (weather == null || weather === false) return 1;
    const byType = Effects.WEATHER_TYPE_MODIFIERS[weather];
    if (byType && moveType != null && byType[moveType] != null) return byType[moveType]!;
    const byMove = Effects.WEATHER_MOVE_MODIFIERS[weather];
    if (byMove && effect != null && byMove[effect] != null) return byMove[effect]!;
    return 1;
  },

  // HandleWeather's .SandstormDamage: an eighth of max HP, and Rock, Ground and
  // Steel are immune.  A mon underground (Dig) is skipped too.
  // Lua: Effects.lua:517
  SANDSTORM_IMMUNE: { ROCK: true, GROUND: true, STEEL: true } as Record<string, boolean>,

  // Lua: Effects.lua:519
  sandstormDamage(maxHp?: number): number {
    return Math.max(1, Math.floor((maxHp ?? 8) / 8));
  },

  // Lua: Effects.lua:523
  sandstormHits(types?: string[]): boolean {
    for (const type_ of types ?? []) {
      if (Effects.SANDSTORM_IMMUNE[type_]) return false;
    }
    return true;
  },

  // BattleCommand_TimeBasedHealContinue's .Multipliers
  // (engine/battle/effect_commands.asm:6450-6454).  Lua's 1-based index 1..4
  // is [index - 1] here.
  // Lua: Effects.lua:532
  HEAL_MULTIPLIERS: [1 / 8, 1 / 4, 1 / 2, 1] as number[],

  // wTimeOfDay (constants/ram_constants.asm:134-139): MORN_F 0, DAY_F 1,
  // NITE_F 2, DARKNESS_F 3.
  // Lua: Effects.lua:536
  TIME_OF_DAY_ID: { MORN: 0, DAY: 1, NITE: 2, DARK: 3 } as Record<string, number>,

  // Morning Sun / Synthesis / Moonlight and the wTimeOfDay each one wants
  // (engine/battle/effect_commands.asm:6362-6371).
  // Lua: Effects.lua:540
  SUN_HEAL: {
    EFFECT_MORNING_SUN: 0,
    EFFECT_SYNTHESIS: 1,
    EFFECT_MOONLIGHT: 2,
  } as Record<string, number>,

  // Lua: Effects.lua:546
  timeOfDayIndex(timeOfDay: number | string | undefined | null): number | undefined {
    if (typeof timeOfDay === "number") return Math.floor(timeOfDay);
    return timeOfDay != null ? Effects.TIME_OF_DAY_ID[timeOfDay] : undefined;
  },

  // engine/battle/effect_commands.asm:6388-6417: the index opens at a half, the
  // wrong time of day steps it down, sun steps it up, rain and sandstorm down.
  // Lua: Effects.lua:553
  timeBasedHealFraction(weather: string | null | undefined | false, wants?: number | null, timeOfDay?: number | string | null): number {
    let index = 3;
    const now = Effects.timeOfDayIndex(timeOfDay);
    if (wants != null && now != null && now !== wants) index = index - 1;
    if (weather != null && weather !== false) {
      index = index + 1;
      if (weather !== "sun") index = index - 2;
    }
    return Effects.HEAL_MULTIPLIERS[Math.max(1, Math.min(4, index)) - 1]!;
  },

  // ---------------------------------------------------------------- Perish Song
  //
  // BattleCommand_PerishSong sets the counter to 4 on BOTH sides; it ticks down
  // at the end of every turn and the mon faints when it reaches 0.
  PERISH_TURNS: 4,

  // -------------------------------------------------------------------- Encore
  //
  // 3-6 turns (`and $3` plus three increments), and the target is locked into
  // the move it last used.  Encore, Mirror Move and Struggle cannot be encored,
  // and neither can a move with no PP left.
  // Lua: Effects.lua:575
  ENCORE_BLOCKED: {
    ENCORE: true,
    MIRROR_MOVE: true,
    STRUGGLE: true,
  } as Record<string, boolean>,

  // Lua: Effects.lua:579
  encoreTurns(random?: ZeroRandom): number {
    return (random ? random(4) : 0) + 3;
  },

  // ------------------------------------------------------------------- Disable
  //
  // The count is a packed byte: the low nybble is the number of turns (1-8, the
  // `and 7` retried until nonzero, then incremented) and the high nybble is the
  // move slot plus one.  Only the turn count matters to the port, but the shape
  // is what says a slot of 0 means "nothing disabled".
  // Lua: Effects.lua:589
  disableTurns(random?: ZeroRandom): number {
    let roll = 0;
    for (let i = 1; i <= 8; i++) {
      roll = mod(random ? random(8) : 1, 8);
      if (roll !== 0) break;
    }
    if (roll === 0) roll = 1;
    return roll + 1;
  },

  // --------------------------------------------------------- Protect and Endure
  //
  // ProtectChance halves the success chance for every CONSECUTIVE use: the
  // threshold starts at $ff and is shifted right once per use, so use n
  // succeeds with probability (256 >> n) / 256.  Once the shift reaches zero the
  // move always fails, which is five uses.
  // Lua: Effects.lua:605
  protectChance(consecutive?: number): number {
    let threshold = 0xff;
    const n = consecutive ?? 0;
    for (let i = 1; i <= n; i++) {
      threshold = Math.floor(threshold / 2);
      if (threshold === 0) return 0;
    }
    return threshold;
  },

  // The roll is a non-zero byte, decremented, and the move succeeds when it is
  // BELOW the threshold.
  // Lua: Effects.lua:616
  protectSucceeds(consecutive?: number, random?: ZeroRandom): boolean {
    const threshold = Effects.protectChance(consecutive);
    if (threshold === 0) return false;
    const roll = (random ? random(255) : 0) + 1;
    return roll - 1 < threshold;
  },

  // ---------------------------------------------------------------------- Bide
  //
  // BattleCommand_UnleashEnergy stores for 2 or 3 turns (`and 1` plus two
  // increments) and BattleCommand_StoreEnergy pays back DOUBLE everything the
  // user took while storing, capped at the 16-bit maximum.
  // Lua: Effects.lua:628
  bideTurns(random?: ZeroRandom): number {
    return (random ? random(2) : 0) + 2;
  },

  // Lua: Effects.lua:632
  bideDamage(stored?: number): number {
    return Math.min(0xffff, (stored ?? 0) * 2);
  },

  // ---------------------------------------------------------------------- Rage
  //
  // SUBSTATUS_RAGE: while it is set, every hit the user takes raises its Attack
  // one stage.  It is cleared by using any other move.

  // ---------------------------------------------------------------- Future Sight
  //
  // Four turns: the damage is rolled NOW, stored, and lands when the counter
  // reaches one.  The move itself does nothing on the turn it is used.
  FUTURE_SIGHT_TURNS: 4,

  // ---------------------------------------------------------------------- OHKO
  //
  // BattleCommand_OHKO fails outright when the target is the higher level; when
  // it is not, the move's accuracy becomes acc + 2 * (level difference), capped
  // at 255, and a hit sets damage to $ffff.
  // Lua: Effects.lua:652
  ohkoAccuracy(baseAccuracy?: number, userLevel?: number, targetLevel?: number): number | undefined {
    if ((targetLevel ?? 1) > (userLevel ?? 1)) return undefined;
    const bonus = ((userLevel ?? 1) - (targetLevel ?? 1)) * 2;
    return Math.min(255, (baseAccuracy ?? 0) + bonus);
  },

  // ------------------------------------------------------------------- Beat Up
  //
  // One hit per party member that is alive and free of any major status, each
  // swinging with that member's own base Attack and level against the target's
  // base Defense.  The move fails outright when nobody qualifies.
  // `index` and `activeIndex` keep the Lua's 1-based party slot numbers.
  // Lua: Effects.lua:663
  beatUpParty(party: any[] | undefined, activeIndex?: number): { index: number; mon: any }[] {
    const hits: { index: number; mon: any }[] = [];
    (party ?? []).forEach((mon, i) => {
      const index = i + 1;
      const healthy = (mon.hp ?? 0) > 0;
      // The ACTIVE mon is checked against its battle status rather than its
      // party record, which is the same thing here.
      const noStatus = mon.status == null || mon.status === false;
      const clean = noStatus || (index === activeIndex && noStatus);
      if (healthy && clean) {
        hits.push({ index, mon });
      }
    });
    return hits;
  },

  // --------------------------------------------------------------- Baton Pass
  //
  // ResetBatonPassStatus: what does NOT survive the switch.  Everything else --
  // the stat stages, Substitute, Leech Seed, Perish Song, the confusion counter
  // -- goes with the incoming mon, which is the whole point of the move.
  //
  // `preTransform` is deliberately NOT on this list even though `transformed` is:
  // it is the passer's own identity waiting to be put back, and the drops run
  // BEFORE Battle:clearVolatile, which is what puts it back and clears both keys
  // (Battle:untransform).  Dropping it here would strand a passing DITTO as a
  // permanent copy instead.
  // Lua: Effects.lua:688
  BATON_PASS_DROPS: [
    "nightmare", "disable", "disableTurns", "attract", "transformed",
    "encore", "encoreTurns", "lastMove",
  ] as string[],

  // ------------------------------------------------------------------ Metronome
  //
  // data/moves/metronome_exception_moves.asm: Metronome cannot pick these, and
  // it also never picks a move the user already knows.
  // Lua: Effects.lua:697
  METRONOME_EXCEPTIONS: {
    METRONOME: true, STRUGGLE: true, SKETCH: true, MIMIC: true,
    COUNTER: true, MIRROR_COAT: true, PROTECT: true, DETECT: true,
    ENDURE: true, DESTINY_BOND: true, SLEEP_TALK: true, THIEF: true,
  } as Record<string, boolean>,

  // Picks a move id uniformly out of `moveOrder`, rerolling on an excepted move
  // or one the user already has -- the same reject loop .GetMove runs.
  // Lua: Effects.lua:705
  metronomePick(moveOrder: string[] | undefined, known?: any[], random?: ZeroRandom): string | undefined {
    const count = (moveOrder ?? []).length;
    if (count === 0) return undefined;
    const owned: Record<string, boolean> = {};
    for (const move of known ?? []) owned[move.id ?? move] = true;
    for (let i = 1; i <= 64; i++) {
      const pick = moveOrder![random ? random(count) : 0];
      if (pick != null && !Effects.METRONOME_EXCEPTIONS[pick] && !owned[pick]) {
        return pick;
      }
    }
    return undefined;
  },

  // ---------------------------------------------------------------- Mirror Move
  //
  // Copies the OPPONENT's last move, and fails when there is none or when the
  // user already knows it -- CheckUserMove returns "found", and Mirror Move
  // takes the .failed branch on a hit.
};

export default Effects;
